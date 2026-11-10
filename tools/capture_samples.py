#!/usr/bin/env python3
"""
tools/capture_samples.py

Captura muestras REST CRUDAS de Massive (acciones) y BingX (cripto) para la
capa de datos. No normaliza precios ni tiempos: guarda el cuerpo JSON tal como
lo devuelve el proveedor, dentro de un sobre con metadatos de la peticion.

Seguridad:
  - La clave Massive se lee de MASSIVE_API_KEY (.env o entorno). Nunca se
    imprime ni se escribe en fixtures/samples.
  - Cada URL guardada se sanitiza (se elimina apiKey/apikey).
  - Antes de escribir un archivo se comprueba que la clave no aparezca en el
    texto. Si aparece, el archivo se descarta.
  - BingX usa el endpoint publico de klines: no requiere clave. La cabecera
    X-SOURCE-KEY es un identificador publico, no un secreto.

Uso:
  python tools/capture_samples.py all
  python tools/capture_samples.py massive
  python tools/capture_samples.py bingx
  python tools/capture_samples.py live
  python tools/capture_samples.py all --print-plan

El modo "live" se ejecuta DURANTE la sesion (RTH 09:30-16:00 ET): pide las
ultimas 5 barras de SPY 1m y 5m (sort=desc, ventana de 3 dias) dos veces con
90 s de diferencia y guarda la hora UTC exacta de cada peticion, para
determinar si Massive incluye la barra en formacion, si cambia entre
peticiones y como se distingue de una cerrada.

Salida:
  fixtures/samples/SPY_<temporalidad>_<fecha>.json
  fixtures/samples/BTC-USDT_<temporalidad>_<fecha>.json

Cada archivo contiene:
  provider, symbol, timeframe, capture_date_utc, timezone, notes, scenarios.
  Cada escenario contiene una lista de paginas con:
    url (sin clave), params, request_headers, http_status,
    response_headers, captured_at_utc, body (JSON crudo del proveedor).

Si el plan no permite un rango o una temporalidad, la respuesta de error se
guarda igualmente en el escenario para que quede como evidencia.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime, time as dtime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

try:
    NEW_YORK = ZoneInfo("America/New_York")
except ZoneInfoNotFoundError as exc:  # pragma: no cover - depende del entorno
    raise SystemExit(
        "zoneinfo no encontro America/New_York. Instala la base IANA con:\n"
        "  python -m pip install tzdata"
    ) from exc

UTC = timezone.utc
ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "fixtures" / "samples"
ENV_FILE = ROOT / ".env"

MASSIVE_HOSTS = (
    ("https://api.polygon.io", "apiKey"),
    ("https://api.massive.com", "apikey"),
)

# (timespan, multiplier, segundos de la barra)
MASSIVE_TIMEFRAMES: dict[str, tuple[str, int, int]] = {
    "1m": ("minute", 1, 60),
    "5m": ("minute", 5, 300),
    "15m": ("minute", 15, 900),
    "1h": ("hour", 1, 3_600),
    "4h": ("hour", 4, 14_400),
    "1D": ("day", 1, 86_400),
}

# Limite del escenario "latest". El motor de Massive acota las barras BASE
# escaneadas por peticion (1-minute en todo intradia, 1-day en 1D), no las
# barras de salida: con limit=5 y sort=desc escanea solo los 5 minutos mas
# recientes, asi que 1m devuelve 5 barras pero 5m devuelve una cubeta parcial
# descentrada y 15m/1h/4h devuelven 0 (evidencia 2026-11-07: queryCount=5 en
# las cuatro, resultsCount=5/1/0/0; sondas con limit=25/75/1200 devuelven
# 5/7/6 cubetas). Para "las ultimas 5 barras de salida" se escanean
# 5 x multiplicador en minutos base. En 1D las barras base son diarias y el
# motor devuelve la ventana completa (devolvio 7 con limit=5).
MASSIVE_LATEST_LIMIT: dict[str, int] = {
    "1m": 5,
    "5m": 25,
    "15m": 75,
    "1h": 300,
    "4h": 1_200,
    "1D": 5,
}

# Dias de calendario para pedir al menos 2 paginas de 1000 barras en el
# escenario "range". En acciones se usa una estimacion conservadora de barras
# por dia (incluye premercado y postmercado cuando el proveedor los devuelve).
MASSIVE_RANGE_DAYS: dict[str, int] = {
    "1m": 4,
    "5m": 14,
    "15m": 40,
    "1h": 250,
    "4h": 800,
    "1D": 3_000,
}

# Dias de calendario para la sonda de limite maximo. El objetivo es que, si el
# plan tiene suficiente historia, la primera pagina alcance el maximo real por
# peticion. Si no la alcanza, el reporte dira "limite no alcanzado".
MASSIVE_MAX_DAYS: dict[str, int] = {
    "1m": 260,
    "5m": 1_100,
    "15m": 3_000,
    "1h": 9_200,
    "4h": 9_200,
    "1D": 9_200,
}

BINGX_TIMEFRAMES: dict[str, tuple[str, int]] = {
    "1m": ("1m", 60_000),
    "5m": ("5m", 300_000),
    "15m": ("15m", 900_000),
    "1h": ("1h", 3_600_000),
    "4h": ("4h", 14_400_000),
    "1D": ("1d", 86_400_000),
}

BINGX_RANGE_DAYS: dict[str, int] = {
    "1m": 2,
    "5m": 8,
    "15m": 22,
    "1h": 90,
    "4h": 350,
    "1D": 3_000,
}

BINGX_REST_BASE = "https://open-api.bingx.com"
BINGX_KLINE_PATH = "/openApi/spot/v2/market/kline"
BINGX_DEFAULT_SOURCE_KEY = "BX-AI-SKILL"

# Modo live (tarea de captura en sesion): rondas separadas 90 s, ventana de 3
# dias y objetivo de 5 barras de salida por peticion.
LIVE_ROUNDS = 2
LIVE_ROUND_SLEEP_SECONDS = 90.0
LIVE_LOOKBACK_DAYS = 3

SAFE_HEADERS = (
    "content-type",
    "content-length",
    "date",
    "server",
    "x-request-id",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "retry-after",
    "cf-ray",
    "x-amzn-requestid",
    "x-envoy-upstream-service-time",
)

SECRET_PARAM_NAMES = {"apikey", "api_key", "api-key"}
SECRET_JSON_KEYS = {"apikey", "api_key", "api-key", "authorization", "x-api-key"}


# ---------------------------------------------------------------------------
# Utilidades de seguridad y ficheros
# ---------------------------------------------------------------------------


class SecretScrubber:
    """Elimina una clave de cualquier texto antes de imprimirlo o guardarlo."""

    def __init__(self, secret: str | None) -> None:
        self._secret = (secret or "").strip()
        encoded = urllib.parse.quote(self._secret, safe="") if self._secret else ""
        self._needles = [n for n in (self._secret, encoded) if n]

    def scrub(self, text: str) -> str:
        out = text
        for needle in self._needles:
            out = out.replace(needle, "<redacted>")
        return out

    def contains_secret(self, text: str) -> bool:
        return any(needle in text for needle in self._needles)


SCRUBBER = SecretScrubber(None)


def say(message: str) -> None:
    print(SCRUBBER.scrub(message), flush=True)


def load_env_file(path: Path) -> dict[str, str]:
    """Lector minimo de .env; no imprime valores ni usa dependencias externas."""
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw_line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        if key:
            values[key] = value
    return values


def sanitize_url(url: str) -> str:
    """Devuelve la URL sin parametros de credenciales."""
    parts = urllib.parse.urlsplit(url)
    pairs = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
    kept = [(k, v) for k, v in pairs if k.lower() not in SECRET_PARAM_NAMES]
    return urllib.parse.urlunsplit(
        (parts.scheme, parts.netloc, parts.path, urllib.parse.urlencode(kept), parts.fragment)
    )


def params_from_url(url: str) -> dict[str, str]:
    parts = urllib.parse.urlsplit(url)
    return {
        k: v
        for k, v in urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
        if k.lower() not in SECRET_PARAM_NAMES
    }


def sanitize_json(value: Any) -> Any:
    """Quita credenciales de cualquier URL o clave dentro de un JSON."""
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, item in value.items():
            if str(key).lower() in SECRET_JSON_KEYS:
                out[key] = "<redacted>"
            else:
                out[key] = sanitize_json(item)
        return out
    if isinstance(value, list):
        return [sanitize_json(item) for item in value]
    if isinstance(value, str) and value.startswith(("http://", "https://")):
        return sanitize_url(value)
    return value


def safe_response_headers(headers: dict[str, str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for name in SAFE_HEADERS:
        if name in headers:
            out[name] = headers[name]
    return out


def write_sample_file(path: Path, payload: dict[str, Any]) -> None:
    # JSON compacto: las respuestas max pueden ocupar varios MB. Para leerlas:
    #   python -m json.tool fixtures/samples/SPY_1m_<fecha>.json
    text = json.dumps(payload, ensure_ascii=True, separators=(",", ":"))
    if SCRUBBER.contains_secret(text):
        raise RuntimeError(
            f"refusing to write {path.name}: the API key was found in the output"
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class HttpResponse:
    status: int
    headers: dict[str, str]
    body: Any
    attempts: int


def http_get_json(
    url: str,
    *,
    headers: dict[str, str],
    timeout: float,
    retries: int = 4,
    retry_base: float = 2.0,
) -> HttpResponse:
    last: HttpResponse | None = None
    for attempt in range(1, retries + 1):
        request = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read()
                status = int(response.status)
                response_headers = {
                    str(k).lower(): str(v) for k, v in response.headers.items()
                }
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            status = int(exc.code)
            response_headers = {
                str(k).lower(): str(v) for k, v in (exc.headers.items() if exc.headers else [])
            }
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            if attempt < retries:
                time.sleep(retry_base * (2 ** (attempt - 1)))
                continue
            raise RuntimeError(
                f"network error after {attempt} attempts: {type(exc).__name__}"
            ) from None

        if "gzip" in response_headers.get("content-encoding", "").lower():
            try:
                raw = gzip.decompress(raw)
            except OSError:
                pass

        text = raw.decode("utf-8", errors="replace") if raw else ""
        try:
            body: Any = json.loads(text) if text else None
        except json.JSONDecodeError:
            body = {"_non_json_body": text}

        result = HttpResponse(
            status=status, headers=response_headers, body=body, attempts=attempt
        )
        last = result

        if status == 429 or 500 <= status < 600:
            if attempt < retries:
                retry_after = response_headers.get("retry-after")
                try:
                    delay = float(retry_after) if retry_after is not None else 0.0
                except ValueError:
                    delay = 0.0
                time.sleep(max(delay, retry_base * (2 ** (attempt - 1)), 1.0))
                continue

        return result

    if last is None:  # pragma: no cover - defensivo
        raise RuntimeError("HTTP request failed without a response")
    return last


def request_entry(
    *,
    url: str,
    params: dict[str, Any],
    request_headers: dict[str, str],
    response: HttpResponse,
    page_index: int,
    captured_at: datetime,
) -> dict[str, Any]:
    return {
        "page_index": page_index,
        "url": sanitize_url(url),
        "params": {str(k): str(v) for k, v in params.items()},
        "request_headers": dict(request_headers),
        "http_status": response.status,
        "response_headers": safe_response_headers(response.headers),
        "captured_at_utc": iso_utc(captured_at),
        "attempts": response.attempts,
        "body": sanitize_json(response.body),
    }


# ---------------------------------------------------------------------------
# Fechas
# ---------------------------------------------------------------------------


def iso_utc(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def ms_to_iso(value: Any) -> str | None:
    if not isinstance(value, (int, float)):
        return None
    try:
        return iso_utc(datetime.fromtimestamp(value / 1000.0, tz=UTC))
    except (OverflowError, OSError, ValueError):
        return None


def recent_closed_business_day(now_et: datetime) -> date:
    """Ultimo dia de semana cuyo cierre de 16:00 ET ya ocurrio.

    No conoce feriados: si el dia elegido es feriado, la captura devolvera
    cero barras y quedara registrado como evidencia.
    """
    candidate = now_et.date()
    if candidate.weekday() >= 5 or now_et.time() < dtime(16, 0):
        candidate -= timedelta(days=1)
    while candidate.weekday() >= 5:
        candidate -= timedelta(days=1)
    return candidate


def et_day_bounds_ms(day: date) -> tuple[int, int]:
    start = datetime.combine(day, dtime.min, tzinfo=NEW_YORK)
    end = start + timedelta(days=1)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000) - 1


def utc_day_bounds_ms(day: date) -> tuple[int, int]:
    start = datetime.combine(day, dtime.min, tzinfo=UTC)
    end = start + timedelta(days=1)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000) - 1


def first_sunday(year: int, month: int) -> date:
    candidate = date(year, month, 1)
    while candidate.weekday() != 6:
        candidate += timedelta(days=1)
    return candidate


# ---------------------------------------------------------------------------
# Massive
# ---------------------------------------------------------------------------


class MassiveClient:
    """Cliente REST minimo para /v2/aggs, con autenticacion por query."""

    def __init__(
        self,
        *,
        api_key: str,
        base_mode: str,
        timeout: float,
        delay: float,
        retries: int,
    ) -> None:
        self._api_key = api_key
        self._timeout = timeout
        self._delay = max(0.0, delay)
        self._retries = retries
        self._base: str | None = None
        self._auth_param: str | None = None

        if base_mode == "polygon":
            self._initial_attempts = [MASSIVE_HOSTS[0]]
        elif base_mode == "massive":
            self._initial_attempts = [MASSIVE_HOSTS[1]]
        else:
            self._initial_attempts = list(MASSIVE_HOSTS)

    def _auth_param_for_url(self, url: str) -> str:
        host = urllib.parse.urlsplit(url).netloc.lower()
        if host == "api.massive.com":
            return "apikey"
        return "apiKey"

    def _authorized_url(self, url: str) -> str:
        clean = sanitize_url(url)
        parts = urllib.parse.urlsplit(clean)
        pairs = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
        pairs.append((self._auth_param_for_url(clean), self._api_key))
        return urllib.parse.urlunsplit(
            (parts.scheme, parts.netloc, parts.path, urllib.parse.urlencode(pairs), parts.fragment)
        )

    def _headers(self) -> dict[str, str]:
        return {
            "Accept": "application/json",
            "Accept-Encoding": "identity",
            "User-Agent": "QuantOptionsTerminal-capture/0.1",
        }

    def request_path(
        self,
        path: str,
        params: dict[str, Any],
        *,
        page_index: int,
    ) -> tuple[dict[str, Any], HttpResponse]:
        actual_path = path
        query_params = dict(params)
        if "from" in query_params and "to" in query_params:
            from_val = query_params.pop("from")
            to_val = query_params.pop("to")
            actual_path = f"{path.rstrip('/')}/{from_val}/{to_val}"

        attempts = (
            list(self._initial_attempts)
            if self._base is None
            else [(self._base, self._auth_param or "apiKey")]
        )
        last_response: HttpResponse | None = None
        last_entry: dict[str, Any] | None = None

        for base, auth_param in attempts:
            clean_url = f"{base}{actual_path}"
            if query_params:
                clean_url += "?" + urllib.parse.urlencode(query_params)
            self._auth_param = auth_param
            authorized = self._authorized_url(clean_url)
            say(f"GET {sanitize_url(clean_url)}")
            started = datetime.now(UTC)
            response = http_get_json(
                authorized,
                headers=self._headers(),
                timeout=self._timeout,
                retries=self._retries,
            )
            entry = request_entry(
                url=clean_url,
                params=params,
                request_headers=self._headers(),
                response=response,
                page_index=page_index,
                captured_at=started,
            )
            last_response, last_entry = response, entry

            if (
                self._base is None
                and response.status in (401, 403, 404)
                and len(attempts) > 1
                and (base, auth_param) != attempts[-1]
            ):
                say(f"  host {base} respondio {response.status}; probando el siguiente host")
                if self._delay:
                    time.sleep(self._delay)
                continue

            if response.status in (200, 429, 400, 401, 403, 404):
                self._base = base
                self._auth_param = auth_param
            if self._delay:
                time.sleep(self._delay)
            return entry, response

        if last_entry is None or last_response is None:  # pragma: no cover - defensivo
            raise RuntimeError("Massive request failed without a response")
        return last_entry, last_response

    def request_url(
        self,
        url: str,
        *,
        page_index: int,
    ) -> tuple[dict[str, Any], HttpResponse]:
        self._auth_param = self._auth_param_for_url(url)
        authorized = self._authorized_url(url)
        say(f"GET {sanitize_url(url)}")
        started = datetime.now(UTC)
        response = http_get_json(
            authorized,
            headers=self._headers(),
            timeout=self._timeout,
            retries=self._retries,
        )
        entry = request_entry(
            url=url,
            params=params_from_url(url),
            request_headers=self._headers(),
            response=response,
            page_index=page_index,
            captured_at=started,
        )
        if self._delay:
            time.sleep(self._delay)
        return entry, response


def massive_results(body: Any) -> list[Any]:
    if isinstance(body, dict) and isinstance(body.get("results"), list):
        return body["results"]
    return []


def massive_next_url(body: Any) -> str | None:
    if isinstance(body, dict) and isinstance(body.get("next_url"), str):
        return body["next_url"]
    return None


def massive_rows_summary(pages: list[dict[str, Any]]) -> dict[str, Any]:
    times: list[int] = []
    rows = 0
    for page in pages:
        body = page.get("body")
        for row in massive_results(body):
            rows += 1
            if isinstance(row, dict) and isinstance(row.get("t"), (int, float)):
                times.append(int(row["t"]))
    return {
        "rows": rows,
        "first_open_utc": ms_to_iso(min(times)) if times else None,
        "last_open_utc": ms_to_iso(max(times)) if times else None,
    }


def massive_fetch_pages(
    client: MassiveClient,
    *,
    path: str,
    params: dict[str, Any],
    max_pages: int,
    target_rows: int,
) -> tuple[list[dict[str, Any]], bool]:
    pages: list[dict[str, Any]] = []
    next_url: str | None = None
    total = 0
    for page_index in range(max_pages):
        if next_url:
            entry, response = client.request_url(next_url, page_index=page_index)
        else:
            entry, response = client.request_path(path, params, page_index=page_index)
        pages.append(entry)
        body = response.body
        rows = massive_results(body)
        total += len(rows)
        next_url = massive_next_url(body)
        if response.status != 200 or not rows or not next_url or total >= target_rows:
            break
    return pages, next_url is not None


def massive_scenario(
    client: MassiveClient,
    *,
    timeframe: str,
    kind: str,
    day: date,
    max_pages: int,
    target_rows: int,
) -> dict[str, Any]:
    timespan, multiplier, seconds = MASSIVE_TIMEFRAMES[timeframe]
    path_base = f"/v2/aggs/ticker/SPY/range/{multiplier}/{timespan}"
    scenario: dict[str, Any] = {
        "kind": kind,
        "timeframe_seconds": seconds,
        "requested_limit": None,
        "max_pages": max_pages,
        "target_rows": target_rows,
    }

    if kind == "day":
        if timeframe == "1D":
            start_day = day - timedelta(days=40)
            params = {
                "adjusted": "true",
                "sort": "asc",
                "limit": 50_000,
                "from": start_day.isoformat(),
                "to": day.isoformat(),
            }
            path = path_base
            scenario["requested_from_utc"] = start_day.isoformat()
            scenario["requested_to_utc"] = day.isoformat()
        else:
            start_ms, end_ms = et_day_bounds_ms(day)
            params = {
                "adjusted": "true",
                "sort": "asc",
                "limit": 50_000,
                "from": start_ms,
                "to": end_ms,
            }
            path = path_base
            scenario["requested_from_utc"] = ms_to_iso(start_ms)
            scenario["requested_to_utc"] = ms_to_iso(end_ms)
        scenario["requested_limit"] = 50_000
        pages, has_next = massive_fetch_pages(
            client, path=path, params=params, max_pages=max_pages, target_rows=target_rows
        )

    elif kind == "range":
        days = MASSIVE_RANGE_DAYS[timeframe]
        start_day = day - timedelta(days=days)
        if timeframe == "1D":
            params = {
                "adjusted": "true",
                "sort": "asc",
                "limit": 1_000,
                "from": start_day.isoformat(),
                "to": day.isoformat(),
            }
            scenario["requested_from_utc"] = start_day.isoformat()
            scenario["requested_to_utc"] = day.isoformat()
        else:
            start_ms, _ = et_day_bounds_ms(start_day)
            _, end_ms = et_day_bounds_ms(day)
            params = {
                "adjusted": "true",
                "sort": "asc",
                "limit": 1_000,
                "from": start_ms,
                "to": end_ms,
            }
            scenario["requested_from_utc"] = ms_to_iso(start_ms)
            scenario["requested_to_utc"] = ms_to_iso(end_ms)
        scenario["requested_limit"] = 1_000
        pages, has_next = massive_fetch_pages(
            client, path=path_base, params=params, max_pages=max_pages, target_rows=target_rows
        )

    elif kind == "max":
        days = MASSIVE_MAX_DAYS[timeframe]
        start_day = max(day - timedelta(days=days), date(2003, 1, 1))
        if timeframe == "1D":
            params = {
                "adjusted": "true",
                "sort": "asc",
                "limit": 50_000,
                "from": start_day.isoformat(),
                "to": day.isoformat(),
            }
            scenario["requested_from_utc"] = start_day.isoformat()
            scenario["requested_to_utc"] = day.isoformat()
        else:
            start_ms, _ = et_day_bounds_ms(start_day)
            _, end_ms = et_day_bounds_ms(day)
            params = {
                "adjusted": "true",
                "sort": "asc",
                "limit": 50_000,
                "from": start_ms,
                "to": end_ms,
            }
            scenario["requested_from_utc"] = ms_to_iso(start_ms)
            scenario["requested_to_utc"] = ms_to_iso(end_ms)
        scenario["requested_limit"] = 50_000
        pages, has_next = massive_fetch_pages(
            client, path=path_base, params=params, max_pages=1, target_rows=1
        )
        # Si el rango historico no esta disponible en el plan, probar 2 anos.
        if (not massive_results(pages[0].get("body"))) and days > 730:
            fallback_start = day - timedelta(days=730)
            scenario["fallback_from_utc"] = fallback_start.isoformat()
            if timeframe == "1D":
                params = {
                    "adjusted": "true",
                    "sort": "asc",
                    "limit": 50_000,
                    "from": fallback_start.isoformat(),
                    "to": day.isoformat(),
                }
            else:
                start_ms, _ = et_day_bounds_ms(fallback_start)
                _, end_ms = et_day_bounds_ms(day)
                params = {
                    "adjusted": "true",
                    "sort": "asc",
                    "limit": 50_000,
                    "from": start_ms,
                    "to": end_ms,
                }
            fallback_pages, fallback_next = massive_fetch_pages(
                client, path=path_base, params=params, max_pages=1, target_rows=1
            )
            fallback_summary = massive_rows_summary(fallback_pages)
            scenario["fallback_pages"] = fallback_pages
            scenario["fallback_rows_total"] = fallback_summary["rows"]
            scenario["fallback_first_open_utc"] = fallback_summary["first_open_utc"]
            scenario["fallback_last_open_utc"] = fallback_summary["last_open_utc"]
            scenario["fallback_has_next_url_after_last_page"] = fallback_next
            fallback_body = fallback_pages[-1].get("body") if fallback_pages else None
            scenario["fallback_last_page_results_count"] = (
                fallback_body.get("resultsCount") if isinstance(fallback_body, dict) else None
            )
            has_next = has_next or fallback_next

    elif kind == "latest":
        now = datetime.now(UTC)
        latest_limit = MASSIVE_LATEST_LIMIT[timeframe]
        if timeframe == "1D":
            params = {
                "adjusted": "true",
                "sort": "desc",
                "limit": latest_limit,
                "from": (now.date() - timedelta(days=10)).isoformat(),
                "to": now.date().isoformat(),
            }
            scenario["requested_from_utc"] = (now.date() - timedelta(days=10)).isoformat()
            scenario["requested_to_utc"] = now.date().isoformat()
        else:
            start_ms = int((now - timedelta(days=7)).timestamp() * 1000)
            end_ms = int(now.timestamp() * 1000)
            params = {
                "adjusted": "true",
                "sort": "desc",
                "limit": latest_limit,
                "from": start_ms,
                "to": end_ms,
            }
            scenario["requested_from_utc"] = ms_to_iso(start_ms)
            scenario["requested_to_utc"] = ms_to_iso(end_ms)
        scenario["requested_limit"] = latest_limit
        pages, has_next = massive_fetch_pages(
            client, path=path_base, params=params, max_pages=1, target_rows=1
        )

    else:  # pragma: no cover - solo lo usa "dst"
        raise ValueError(f"unknown scenario kind: {kind}")

    summary = massive_rows_summary(pages)
    scenario["pages"] = pages
    scenario["rows_total"] = summary["rows"]
    scenario["first_open_utc"] = summary["first_open_utc"]
    scenario["last_open_utc"] = summary["last_open_utc"]
    scenario["has_next_url_after_last_page"] = has_next
    last_body = pages[-1].get("body") if pages else None
    scenario["last_page_results_count"] = (
        last_body.get("resultsCount") if isinstance(last_body, dict) else None
    )
    scenario["last_page_query_count"] = (
        last_body.get("queryCount") if isinstance(last_body, dict) else None
    )
    scenario["last_page_status"] = (
        last_body.get("status") if isinstance(last_body, dict) else None
    )
    return scenario


def massive_dst_scenario(
    client: MassiveClient,
    *,
    day: date,
    max_pages: int,
    target_rows: int,
) -> dict[str, Any]:
    dst_end = first_sunday(day.year, 11)
    previous_day = dst_end - timedelta(days=2)
    next_day = dst_end + timedelta(days=1)
    scenario: dict[str, Any] = {
        "kind": "dst",
        "description": (
            "Viernes previo y lunes posterior al fin del horario de verano "
            "de America/New_York; incluye barras diarias alrededor del cambio."
        ),
        "dst_end_date": dst_end.isoformat(),
        "timeframe_seconds": 300,
        "requested_limit": 50_000,
        "max_pages": 1,
        "target_rows": 1,
    }
    pages: list[dict[str, Any]] = []

    for label, target_day in (("friday_before", previous_day), ("monday_after", next_day)):
        start_ms, end_ms = et_day_bounds_ms(target_day)
        params = {
            "adjusted": "true",
            "sort": "asc",
            "limit": 50_000,
            "from": start_ms,
            "to": end_ms,
        }
        entry, _ = client.request_path(
            "/v2/aggs/ticker/SPY/range/5/minute", params, page_index=len(pages)
        )
        entry["label"] = label
        entry["requested_from_utc"] = ms_to_iso(start_ms)
        entry["requested_to_utc"] = ms_to_iso(end_ms)
        pages.append(entry)

    daily_start = dst_end - timedelta(days=10)
    daily_end = dst_end + timedelta(days=5)
    daily_params = {
        "adjusted": "true",
        "sort": "asc",
        "limit": 50_000,
        "from": daily_start.isoformat(),
        "to": daily_end.isoformat(),
    }
    entry, _ = client.request_path(
        "/v2/aggs/ticker/SPY/range/1/day", daily_params, page_index=len(pages)
    )
    entry["label"] = "daily_around_dst"
    entry["requested_from_utc"] = daily_start.isoformat()
    entry["requested_to_utc"] = daily_end.isoformat()
    pages.append(entry)

    summary = massive_rows_summary(pages)
    scenario["pages"] = pages
    scenario["rows_total"] = summary["rows"]
    scenario["first_open_utc"] = summary["first_open_utc"]
    scenario["last_open_utc"] = summary["last_open_utc"]
    scenario["has_next_url_after_last_page"] = False
    return scenario


def capture_massive(
    *,
    day: date,
    api_key: str,
    args: argparse.Namespace,
) -> list[str]:
    failures: list[str] = []
    out_dir = Path(args.out)
    client = MassiveClient(
        api_key=api_key,
        base_mode=args.massive_base_url,
        timeout=args.timeout,
        delay=args.massive_delay,
        retries=args.http_retries,
    )

    for timeframe in MASSIVE_TIMEFRAMES:
        payload: dict[str, Any] = {
            "provider": "massive",
            "symbol": "SPY",
            "timeframe": timeframe,
            "capture_date_utc": iso_utc(datetime.now(UTC)),
            "reference_closed_day_et": day.isoformat(),
            "timezone": "America/New_York",
            "notes": [
                "Cuerpos JSON crudos del proveedor, sin normalizar.",
                "La URL guardada no contiene apiKey/apikey.",
                "Las barras diarias se piden con from/to en fecha ET.",
                "Los escenarios range/max permiten medir paginacion y limite por peticion.",
            ],
            "scenarios": {},
        }
        scenario_kinds = ["day", "range", "max", "latest"]
        for kind in scenario_kinds:
            say(f"massive SPY {timeframe} {kind}: preparando")
            try:
                scenario = massive_scenario(
                    client,
                    timeframe=timeframe,
                    kind=kind,
                    day=day,
                    max_pages=args.max_pages,
                    target_rows=args.target_bars,
                )
                payload["scenarios"][kind] = scenario
                say(
                    f"massive SPY {timeframe} {kind}: "
                    f"{scenario['rows_total']} filas, "
                    f"ultima pagina {scenario['last_page_results_count']} resultados, "
                    f"next_url={scenario['has_next_url_after_last_page']}"
                )
            except Exception as exc:  # noqa: BLE001 - se guarda como evidencia
                message = SCRUBBER.scrub(f"{type(exc).__name__}: {exc}")
                payload["scenarios"][kind] = {"kind": kind, "error": message}
                failures.append(f"massive SPY {timeframe} {kind}: {message}")
                say(f"massive SPY {timeframe} {kind}: ERROR {message}")

        if timeframe == "5m":
            say("massive SPY 5m dst: preparando")
            try:
                payload["scenarios"]["dst"] = massive_dst_scenario(
                    client,
                    day=day,
                    max_pages=args.max_pages,
                    target_rows=args.target_bars,
                )
                say(
                    "massive SPY 5m dst: "
                    f"{payload['scenarios']['dst']['rows_total']} filas"
                )
            except Exception as exc:  # noqa: BLE001
                message = SCRUBBER.scrub(f"{type(exc).__name__}: {exc}")
                payload["scenarios"]["dst"] = {"kind": "dst", "error": message}
                failures.append(f"massive SPY 5m dst: {message}")
                say(f"massive SPY 5m dst: ERROR {message}")

        path = out_dir / f"SPY_{timeframe}_{day.isoformat()}.json"
        try:
            write_sample_file(path, payload)
            say(f"escrito {path} ({path.stat().st_size} bytes)")
        except Exception as exc:  # noqa: BLE001
            message = SCRUBBER.scrub(f"{type(exc).__name__}: {exc}")
            failures.append(f"massive SPY {timeframe}: {message}")
            say(f"massive SPY {timeframe}: ERROR al escribir: {message}")

    return failures


# ---------------------------------------------------------------------------
# BingX
# ---------------------------------------------------------------------------


def bingx_rows(body: Any) -> list[Any]:
    if isinstance(body, dict) and isinstance(body.get("data"), list):
        return body["data"]
    return []


def bingx_open_time(row: Any) -> int | None:
    if isinstance(row, list) and row:
        value = row[0]
    elif isinstance(row, dict):
        value = row.get("openTime") or row.get("time") or row.get("t")
    else:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


def bingx_rows_summary(pages: list[dict[str, Any]]) -> dict[str, Any]:
    times: list[int] = []
    rows = 0
    for page in pages:
        for row in bingx_rows(page.get("body")):
            rows += 1
            value = bingx_open_time(row)
            if value is not None:
                times.append(value)
    return {
        "rows": rows,
        "first_open_utc": ms_to_iso(min(times)) if times else None,
        "last_open_utc": ms_to_iso(max(times)) if times else None,
    }


def bingx_headers() -> dict[str, str]:
    source_key = os.environ.get("BINGX_SOURCE_KEY", "").strip() or BINGX_DEFAULT_SOURCE_KEY
    return {
        "Accept": "application/json",
        "Accept-Encoding": "identity",
        "User-Agent": "QuantOptionsTerminal-capture/0.1",
        "X-SOURCE-KEY": source_key,
    }


def bingx_request(
    *,
    params: dict[str, Any],
    page_index: int,
    timeout: float,
    retries: int,
) -> tuple[dict[str, Any], HttpResponse]:
    clean_url = BINGX_REST_BASE + BINGX_KLINE_PATH + "?" + urllib.parse.urlencode(params)
    say(f"GET {sanitize_url(clean_url)}")
    started = datetime.now(UTC)
    headers = bingx_headers()
    response = http_get_json(
        clean_url,
        headers=headers,
        timeout=timeout,
        retries=retries,
    )
    entry = request_entry(
        url=clean_url,
        params=params,
        request_headers=headers,
        response=response,
        page_index=page_index,
        captured_at=started,
    )
    return entry, response


def bingx_fetch_pages(
    *,
    base_params: dict[str, Any],
    start_time_ms: int | None,
    first_end_time_ms: int,
    max_pages: int,
    target_rows: int,
    timeout: float,
    retries: int,
    delay: float,
) -> tuple[list[dict[str, Any]], bool]:
    pages: list[dict[str, Any]] = []
    end_time = first_end_time_ms
    total = 0
    for page_index in range(max_pages):
        params = dict(base_params)
        if start_time_ms is not None:
            params["startTime"] = start_time_ms
        params["endTime"] = end_time
        entry, response = bingx_request(
            params=params,
            page_index=page_index,
            timeout=timeout,
            retries=retries,
        )
        pages.append(entry)
        rows = bingx_rows(response.body)
        total += len(rows)
        if response.status != 200 or not rows:
            break
        oldest = min(
            (value for value in (bingx_open_time(row) for row in rows) if value is not None),
            default=None,
        )
        if oldest is None:
            break
        if start_time_ms is not None and oldest <= start_time_ms:
            break
        if total >= target_rows:
            break
        end_time = oldest - 1
        if delay:
            time.sleep(delay)
    return pages, True


def bingx_scenario(
    *,
    timeframe: str,
    kind: str,
    day: date,
    max_pages: int,
    target_rows: int,
    timeout: float,
    retries: int,
    delay: float,
) -> dict[str, Any]:
    interval, seconds_ms = BINGX_TIMEFRAMES[timeframe]
    base_params: dict[str, Any] = {
        "symbol": "BTC-USDT",
        "interval": interval,
        "limit": 1_000,
    }
    scenario: dict[str, Any] = {
        "kind": kind,
        "interval": interval,
        "timeframe_seconds": seconds_ms // 1000,
        "requested_limit": 1_000,
        "max_pages": max_pages,
        "target_rows": target_rows,
    }

    if kind == "day":
        start_ms, end_ms = utc_day_bounds_ms(day)
        scenario["requested_from_utc"] = ms_to_iso(start_ms)
        scenario["requested_to_utc"] = ms_to_iso(end_ms)
        pages, _ = bingx_fetch_pages(
            base_params=base_params,
            start_time_ms=start_ms,
            first_end_time_ms=end_ms,
            max_pages=max_pages,
            target_rows=10_000,
            timeout=timeout,
            retries=retries,
            delay=delay,
        )
    elif kind == "range":
        days = BINGX_RANGE_DAYS[timeframe]
        now_ms = int(datetime.now(UTC).timestamp() * 1000)
        end_ms = now_ms - seconds_ms
        start_ms = end_ms - days * 86_400_000
        scenario["requested_from_utc"] = ms_to_iso(start_ms)
        scenario["requested_to_utc"] = ms_to_iso(end_ms)
        pages, _ = bingx_fetch_pages(
            base_params=base_params,
            start_time_ms=start_ms,
            first_end_time_ms=end_ms,
            max_pages=max_pages,
            target_rows=target_rows,
            timeout=timeout,
            retries=retries,
            delay=delay,
        )
    elif kind == "latest":
        latest_params = {
            "symbol": "BTC-USDT",
            "interval": interval,
            "limit": 5,
        }
        entry, response = bingx_request(
            params=latest_params,
            page_index=0,
            timeout=timeout,
            retries=retries,
        )
        pages = [entry]
        scenario["requested_limit"] = 5
        scenario["requested_from_utc"] = None
        scenario["requested_to_utc"] = None
        if isinstance(response.body, dict):
            scenario["server_timestamp_utc"] = ms_to_iso(response.body.get("timestamp"))
    else:  # pragma: no cover - defensivo
        raise ValueError(f"unknown BingX scenario: {kind}")

    summary = bingx_rows_summary(pages)
    scenario["pages"] = pages
    scenario["rows_total"] = summary["rows"]
    scenario["first_open_utc"] = summary["first_open_utc"]
    scenario["last_open_utc"] = summary["last_open_utc"]
    scenario["has_next_url_after_last_page"] = False
    return scenario


def capture_live(*, args: argparse.Namespace, api_key: str) -> list[str]:
    """Modo live: 2 rondas (90 s de diferencia) de 1m y 5m durante RTH.

    Cada peticion pide las ultimas 5 barras (sort=desc, ventana de 3 dias)
    con limit escalado al multiplicador (tarea del hallazgo del limite base).
    El sobre guarda captured_at_utc por peticion para comparar rondas.
    """
    failures: list[str] = []
    out_dir = Path(args.out)
    client = MassiveClient(
        api_key=api_key,
        base_mode=args.massive_base_url,
        timeout=args.timeout,
        delay=2.0,
        retries=args.http_retries,
    )
    scenarios: dict[str, dict[str, Any]] = {}
    for timeframe in ("1m", "5m"):
        timespan, multiplier, seconds = MASSIVE_TIMEFRAMES[timeframe]
        scenarios[timeframe] = {
            "kind": "live",
            "timeframe_seconds": seconds,
            "requested_limit": MASSIVE_LATEST_LIMIT[timeframe],
            "target_output_bars": 5,
            "lookback_days": LIVE_LOOKBACK_DAYS,
            "rounds": [],
        }
    for round_index in range(1, LIVE_ROUNDS + 1):
        if round_index > 1:
            say(f"live: esperando {LIVE_ROUND_SLEEP_SECONDS:.0f} s hasta la ronda {round_index}")
            time.sleep(LIVE_ROUND_SLEEP_SECONDS)
        for timeframe in ("1m", "5m"):
            timespan, multiplier, _ = MASSIVE_TIMEFRAMES[timeframe]
            now = datetime.now(UTC)
            start_ms = int((now - timedelta(days=LIVE_LOOKBACK_DAYS)).timestamp() * 1000)
            end_ms = int(now.timestamp() * 1000)
            params = {
                "adjusted": "true",
                "sort": "desc",
                "limit": MASSIVE_LATEST_LIMIT[timeframe],
                "from": start_ms,
                "to": end_ms,
            }
            path = f"/v2/aggs/ticker/SPY/range/{multiplier}/{timespan}"
            say(f"live SPY {timeframe} ronda {round_index}: preparando")
            try:
                entry, response = client.request_path(path, params, page_index=0)
            except Exception as exc:  # noqa: BLE001 - se guarda como evidencia
                message = SCRUBBER.scrub(f"{type(exc).__name__}: {exc}")
                scenarios[timeframe]["rounds"].append(
                    {"round": round_index, "error": message}
                )
                failures.append(f"live SPY {timeframe} ronda {round_index}: {message}")
                say(f"live SPY {timeframe} ronda {round_index}: ERROR {message}")
                continue
            body = response.body if isinstance(response.body, dict) else {}
            scenarios[timeframe]["rounds"].append(
                {
                    "round": round_index,
                    "url": entry["url"],
                    "params": entry["params"],
                    "http_status": response.status,
                    "captured_at_utc": entry["captured_at_utc"],
                    "queryCount": body.get("queryCount"),
                    "resultsCount": body.get("resultsCount"),
                    "body": entry["body"],
                }
            )
            say(
                f"live SPY {timeframe} ronda {round_index}: "
                f"{body.get('resultsCount')} resultados a {entry['captured_at_utc']}"
            )

    payload: dict[str, Any] = {
        "provider": "massive",
        "symbol": "SPY",
        "timeframe": "live",
        "capture_date_utc": iso_utc(datetime.now(UTC)),
        "timezone": "America/New_York",
        "notes": [
            "Ejecutar durante RTH (09:30-16:00 ET): el objetivo es observar la barra en formacion.",
            "Dos rondas separadas por 90 s; cada ronda pide las ultimas 5 barras de 1m y 5m.",
            "sort=desc con ventana de 3 dias; limit escalado al multiplicador porque el motor",
            "acota barras base de 1 minuto por peticion (limit=5x1 en 1m, 5x5 en 5m).",
            "captured_at_utc de cada ronda es la hora UTC exacta de la peticion.",
            "Preguntas a responder: incluye Massive la barra en formacion? cambia entre rondas?",
            "como se distingue una barra cerrada de una en formacion?",
        ],
        "scenarios": scenarios,
    }
    path = out_dir / f"SPY_live_{datetime.now(UTC).date().isoformat()}.json"
    try:
        write_sample_file(path, payload)
        say(f"escrito {path} ({path.stat().st_size} bytes)")
    except Exception as exc:  # noqa: BLE001
        message = SCRUBBER.scrub(f"{type(exc).__name__}: {exc}")
        failures.append(f"live: {message}")
        say(f"live: ERROR al escribir: {message}")
    return failures


def capture_bingx(*, day: date, args: argparse.Namespace) -> list[str]:
    failures: list[str] = []
    out_dir = Path(args.out)
    for timeframe in BINGX_TIMEFRAMES:
        payload: dict[str, Any] = {
            "provider": "bingx",
            "symbol": "BTC-USDT",
            "timeframe": timeframe,
            "capture_date_utc": iso_utc(datetime.now(UTC)),
            "reference_closed_day_utc": day.isoformat(),
            "timezone": "UTC",
            "notes": [
                "Cuerpos JSON crudos del proveedor, sin normalizar.",
                "BingX klines publicas: no requieren clave.",
                "La paginacion se hace con endTime = openTime mas antiguo - 1 ms.",
                "El escenario latest no envia endTime y puede incluir la barra en formacion.",
                "Las velas diarias de BingX abren a las 16:00 UTC (00:00 UTC+8), no a medianoche UTC.",
                "Por eso el escenario day de 1D puede incluir la vela diaria en formacion.",
            ],
            "scenarios": {},
        }
        for kind in ("day", "range", "latest"):
            say(f"bingx BTC-USDT {timeframe} {kind}: preparando")
            try:
                scenario = bingx_scenario(
                    timeframe=timeframe,
                    kind=kind,
                    day=day,
                    max_pages=args.max_pages,
                    target_rows=args.target_bars,
                    timeout=args.timeout,
                    retries=args.http_retries,
                    delay=args.bingx_delay,
                )
                payload["scenarios"][kind] = scenario
                say(
                    f"bingx BTC-USDT {timeframe} {kind}: "
                    f"{scenario['rows_total']} filas, "
                    f"primera={scenario['first_open_utc']} "
                    f"ultima={scenario['last_open_utc']}"
                )
            except Exception as exc:  # noqa: BLE001 - se guarda como evidencia
                message = SCRUBBER.scrub(f"{type(exc).__name__}: {exc}")
                payload["scenarios"][kind] = {"kind": kind, "error": message}
                failures.append(f"bingx BTC-USDT {timeframe} {kind}: {message}")
                say(f"bingx BTC-USDT {timeframe} {kind}: ERROR {message}")

        path = out_dir / f"BTC-USDT_{timeframe}_{day.isoformat()}.json"
        try:
            write_sample_file(path, payload)
            say(f"escrito {path} ({path.stat().st_size} bytes)")
        except Exception as exc:  # noqa: BLE001
            message = SCRUBBER.scrub(f"{type(exc).__name__}: {exc}")
            failures.append(f"bingx BTC-USDT {timeframe}: {message}")
            say(f"bingx BTC-USDT {timeframe}: ERROR al escribir: {message}")

    return failures


# ---------------------------------------------------------------------------
# Plan / CLI
# ---------------------------------------------------------------------------


def print_plan(massive_day: date, bingx_day: date) -> None:
    say(f"Plan de captura (dia de referencia Massive: {massive_day.isoformat()} ET)")
    say(f"Plan de captura (dia de referencia BingX: {bingx_day.isoformat()} UTC)")
    say("")
    for timeframe, (timespan, multiplier, _seconds) in MASSIVE_TIMEFRAMES.items():
        say(
            f"Massive SPY {timeframe}: day + range({MASSIVE_RANGE_DAYS[timeframe]}d, "
            f"limit=1000) + max({MASSIVE_MAX_DAYS[timeframe]}d, limit=50000) + latest"
        )
        say(f"  endpoint: /v2/aggs/ticker/SPY/range/{multiplier}/{timespan}")
    say("")
    say(
        "Massive SPY 5m dst: viernes y lunes alrededor del "
        f"{first_sunday(massive_day.year, 11).isoformat()}"
    )
    say("")
    say(
        "Massive SPY live: 2 rondas separadas por 90 s (ejecutar en RTH); "
        "1m y 5m, ultimas 5 barras (sort=desc, ventana de 3 dias, "
        "limit escalado al multiplicador)"
    )
    say("")
    for timeframe, (interval, seconds_ms) in BINGX_TIMEFRAMES.items():
        say(
            f"BingX BTC-USDT {timeframe}: day + range({BINGX_RANGE_DAYS[timeframe]}d, "
            f"limit=1000) + latest"
        )
        say(
            f"  endpoint: {BINGX_KLINE_PATH}?symbol=BTC-USDT&interval={interval}"
            f"&limit=1000 (paginacion con endTime)"
        )
    say("")
    say("Las respuestas se guardan como JSON crudo dentro de fixtures/samples/.")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Captura muestras REST crudas de Massive y BingX."
    )
    parser.add_argument(
        "provider",
        nargs="?",
        default="all",
        choices=("all", "massive", "bingx", "live"),
        help="Proveedor a capturar (por defecto: all). 'live' ejecuta el modo en sesion.",
    )
    parser.add_argument(
        "--day",
        help="Dia habil cerrado reciente en ET (YYYY-MM-DD). Por defecto: ultimo dia de semana anterior.",
    )
    parser.add_argument(
        "--out",
        default=str(DEFAULT_OUT),
        help="Directorio de salida (por defecto: fixtures/samples).",
    )
    parser.add_argument(
        "--massive-base-url",
        choices=("auto", "polygon", "massive"),
        default="auto",
        help="Host Massive: auto prueba api.polygon.io y api.massive.com.",
    )
    parser.add_argument(
        "--massive-delay",
        type=float,
        default=12.0,
        help="Segundos entre peticiones Massive (plan gratuito: 5/min).",
    )
    parser.add_argument(
        "--bingx-delay",
        type=float,
        default=0.5,
        help="Segundos entre paginas BingX.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=120.0,
        help="Timeout por peticion en segundos.",
    )
    parser.add_argument(
        "--http-retries",
        type=int,
        default=4,
        help="Reintentos ante 429/5xx/errores de red.",
    )
    parser.add_argument(
        "--max-pages",
        type=int,
        default=3,
        help="Maximo de paginas por escenario range.",
    )
    parser.add_argument(
        "--target-bars",
        type=int,
        default=2_000,
        help="Barras objetivo para detener la paginacion del escenario range.",
    )
    parser.add_argument(
        "--print-plan",
        action="store_true",
        help="Muestra el plan de peticiones y termina (sin red).",
    )
    return parser.parse_args()


def main() -> int:
    global SCRUBBER
    args = parse_args()

    if args.max_pages < 1 or args.target_bars < 1 or args.http_retries < 1:
        say("ERROR: --max-pages, --target-bars y --http-retries deben ser >= 1")
        return 2

    env = load_env_file(ENV_FILE)
    massive_key = (
        os.environ.get("MASSIVE_API_KEY", "").strip()
        or env.get("MASSIVE_API_KEY", "").strip()
        or os.environ.get("MASSIVE_KEY_OPTIONS", "").strip()
        or env.get("MASSIVE_KEY_OPTIONS", "").strip()
        or os.environ.get("MASSIVE_OPTIONS", "").strip()
        or env.get("MASSIVE_OPTIONS", "").strip()
        or os.environ.get("MASSIVE_KEY", "").strip()
        or env.get("MASSIVE_KEY", "").strip()
    )
    SCRUBBER = SecretScrubber(massive_key)

    if args.day:
        try:
            massive_day = date.fromisoformat(args.day)
        except ValueError:
            say(f"ERROR: --day no es una fecha valida: {args.day}")
            return 2
        # Si el usuario fija una fecha, se usa en ambos mercados.
        bingx_day = massive_day
    else:
        massive_day = recent_closed_business_day(datetime.now(NEW_YORK))
        # BingX opera 24/7: el ultimo dia UTC completo es ayer, sin depender
        # del cierre de acciones en ET.
        bingx_day = datetime.now(UTC).date() - timedelta(days=1)

    if args.print_plan:
        print_plan(massive_day, bingx_day)
        return 0

    failures: list[str] = []

    if args.provider == "live":
        if not massive_key:
            message = (
                "live: MASSIVE_API_KEY no esta definida en .env ni en el entorno. "
                "No se ejecuta el modo live."
            )
            say("ERROR: " + message)
            failures.append(message)
        else:
            try:
                failures.extend(capture_live(args=args, api_key=massive_key))
            except Exception as exc:  # noqa: BLE001
                message = SCRUBBER.scrub(f"{type(exc).__name__}: {exc}")
                failures.append(f"live: {message}")
                say(f"live: ERROR fatal {message}")
    else:
        if args.provider in ("all", "massive"):
            if not massive_key:
                message = (
                    "massive: MASSIVE_API_KEY no esta definida en .env ni en el entorno. "
                    "No se capturan muestras Massive."
                )
                say("ERROR: " + message)
                failures.append(message)
            else:
                try:
                    failures.extend(capture_massive(day=massive_day, api_key=massive_key, args=args))
                except Exception as exc:  # noqa: BLE001
                    message = SCRUBBER.scrub(f"{type(exc).__name__}: {exc}")
                    failures.append(f"massive: {message}")
                    say(f"massive: ERROR fatal {message}")

        if args.provider in ("all", "bingx"):
            try:
                failures.extend(capture_bingx(day=bingx_day, args=args))
            except Exception as exc:  # noqa: BLE001
                message = SCRUBBER.scrub(f"{type(exc).__name__}: {exc}")
                failures.append(f"bingx: {message}")
                say(f"bingx: ERROR fatal {message}")

    say("")
    if failures:
        say(f"Captura terminada con {len(failures)} problema(s):")
        for failure in failures:
            say(f"  - {failure}")
        return 1

    say("Captura completada sin errores.")
    say(f"Directorio: {Path(args.out)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
