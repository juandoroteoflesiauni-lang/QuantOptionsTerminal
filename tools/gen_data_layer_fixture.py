#!/usr/bin/env python3
"""
tools/gen_data_layer_fixture.py

Generador de referencia INDEPENDIENTE para la capa de datos (SPEC punto 6).

Método:
  - Implementación explícita en Python, escrita a partir de los requisitos.
  - No importa ni traduce el código TypeScript.
  - Convierte milisegundos a segundos SOLO en esta capa.
  - Valida cada fila con un orden de causas documentado:
        malformedRow -> invalidTime -> nonFinite -> invalidPrice
        -> highBelowLow -> invalidVolume -> duplicate
  - No rellena huecos: solo los detecta y reporta.
  - BingX: calcula quoteVolume/volume como candidato a VWAP, pero NUNCA lo
    expone en las barras. La muestra real falló la verificación del SPEC:
    185 de 3.445 barras de 1m quedaron fuera de [low, high].
  - BingX: el campo `code` numérico (o string numérico decimal) distinto de
    0 es un error del proveedor; un `code` presente que no es numérico hace
    la respuesta malformada. Un `code` ausente o null se tolera.
  - Los timestamps cuyo resultado en segundos excede MAX_TIME_SECONDS
    (1e11, el umbral que sessionKey admite) se descartan como invalidTime:
    la fila imposible no llega a sessionKey y el cálculo no se lanza.
  - Unidades validadas en BingX: solo un openTime en ms válidos participa
    en la paginación; solo un closeTime entero en ms dentro de la duración
    de la barra participa en la formación (si no, fallback por intervalo);
    solo un timestamp del servidor en ms plausible fija `now`.
  - Massive rthOnly: el buffer solo contiene barras con apertura dentro de
    RTH (09:30-16:00 ET, lunes a viernes); el objetivo y el recorte se
    aplican sobre barras RTH, el lookback se escala a barras RTH por día
    y los huecos se calculan sobre el buffer cerrado completo, antes del
    filtro. rthOnly con BingX o con 1D es un error de opciones.
  - El reporte incluye warmupSatisfied: true solo si el buffer alcanzó
    requestedBars barras. BingX 1D está limitado a ~380 días por carga
    (code 100204) y no puede alcanzar el warmup por defecto de 1000.
  - `now` del cargador debe ser un entero positivo dentro de
    MAX_TIME_SECONDS; fuera de rango es un error de opciones.

Los valores no finitos se representan en el JSON de entrada como cadenas
("NaN", "Infinity") o null, porque JSON estricto no admite NaN/Infinity.

Para regenerar el fixture:
  python tools/gen_data_layer_fixture.py
"""

from __future__ import annotations

import json
import math
import re
import sys
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

try:
    NEW_YORK = ZoneInfo("America/New_York")
except ZoneInfoNotFoundError as exc:  # pragma: no cover - depende del entorno
    raise SystemExit(
        "zoneinfo no encontró America/New_York. Instala la base IANA con:\n"
        "  python -m pip install tzdata"
    ) from exc

UTC = timezone.utc

FIXTURE_PATH = (
    Path(__file__).resolve().parent.parent
    / "fixtures"
    / "data_layer_reference.json"
)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

DISCARD_CAUSES = (
    "malformedRow",
    "invalidTime",
    "nonFinite",
    "invalidPrice",
    "highBelowLow",
    "invalidVolume",
    "duplicate",
)


def is_finite_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def is_record(value: Any) -> bool:
    return isinstance(value, dict)


def empty_discard_counts() -> dict[str, int]:
    return {cause: 0 for cause in DISCARD_CAUSES}


# Umbral máximo de timestamp en segundos: el mismo contrato que admite
# sessionKey en las sesiones. Un resultado mayor se rechaza como invalidTime.
MAX_TIME_SECONDS = 10**11


def parse_milliseconds(value: Any) -> int | None:
    """Devuelve segundos UTC enteros o None si el valor no es ms válidos.

    Un resultado en segundos por encima de MAX_TIME_SECONDS se rechaza:
    sessionKey no admite timestamps tan lejanos y la fila se reporta como
    invalidTime en lugar de lanzar. (MAX_TIME_SECONDS subsume el límite de
    entero seguro de 2**53 - 1.)
    """
    if not is_finite_number(value):
        return None
    if not float(value).is_integer():
        return None
    milliseconds = int(value)
    if milliseconds <= 0 or milliseconds % 1000 != 0:
        return None
    seconds = milliseconds // 1000
    if seconds <= 0 or seconds > MAX_TIME_SECONDS:
        return None
    return seconds


def et_date_key(seconds: int) -> str:
    return datetime.fromtimestamp(seconds, tz=NEW_YORK).date().isoformat()


def utc_date_key(seconds: int) -> str:
    return datetime.fromtimestamp(seconds, tz=UTC).date().isoformat()


def detect_gaps(
    bars: list[dict[str, Any]], bar_seconds: int, provider: str
) -> tuple[list[dict[str, Any]], str]:
    if bar_seconds >= 86_400:
        return [], "skippedDaily"

    gaps: list[dict[str, Any]] = []
    for previous, current in zip(bars, bars[1:]):
        diff = current["time"] - previous["time"]
        if diff <= bar_seconds:
            continue
        if provider == "massive":
            if et_date_key(previous["time"]) != et_date_key(current["time"]):
                continue
        missing = (diff - 1) // bar_seconds
        if missing <= 0:
            continue
        session = (
            et_date_key(previous["time"])
            if provider == "massive"
            else utc_date_key(previous["time"])
        )
        gaps.append(
            {
                "previousTime": previous["time"],
                "nextTime": current["time"],
                "diffSeconds": diff,
                "missingBars": missing,
                "sessionKey": session,
            }
        )
    return gaps, "performed"


def provider_error_from_massive(raw: dict[str, Any]) -> dict[str, Any] | None:
    status = raw.get("status")
    if isinstance(status, str) and status.upper() != "OK":
        message = raw.get("error")
        if not isinstance(message, str):
            message = raw.get("message")
        if not isinstance(message, str):
            message = status
        return {"code": 0, "message": message}
    return None


DECIMAL_NUMBER_RE = re.compile(
    r"[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?"
)


def parse_bingx_code(value: Any) -> tuple[str, float | None]:
    """Interpreta el campo `code` de BingX, de forma independiente.

    Devuelve ("absent", None) si el campo no viene; ("number", code) si es
    un número decimal finito, o un string que casa con la gramática
    decimal finita; ("malformed", None) en cualquier otro caso.
    "0x10", "inf", "NaN" o "" NO son números aquí.
    """
    if value is None:
        return ("absent", None)
    if isinstance(value, bool):
        return ("malformed", None)
    if isinstance(value, (int, float)):
        number = float(value)
        if not math.isfinite(number):
            return ("malformed", None)
        return ("number", number)
    if isinstance(value, str):
        trimmed = value.strip()
        if not DECIMAL_NUMBER_RE.fullmatch(trimmed):
            return ("malformed", None)
        number = float(trimmed)
        if not math.isfinite(number):
            return ("malformed", None)
        return ("number", number)
    return ("malformed", None)


def bingx_code_error(raw: dict[str, Any]) -> dict[str, Any] | None:
    """Error del proveedor si `code` es numérico distinto de cero."""
    kind, number = parse_bingx_code(raw.get("code"))
    if kind != "number" or number == 0:
        return None
    message = raw.get("msg")
    if not isinstance(message, str):
        message = raw.get("message")
    if not isinstance(message, str):
        message = ""
    code = int(number) if float(number).is_integer() else number
    return {"code": code, "message": message}


def forming_massive(
    bars: list[dict[str, Any]], bar_seconds: int, now: int | None
) -> dict[str, Any] | None:
    if now is None:
        return None
    if bar_seconds >= 86_400:
        now_key = et_date_key(now)
        for bar in bars:
            if et_date_key(bar["time"]) == now_key:
                return {"time": bar["time"], "reason": "intervalContainsNow"}
        return None
    for bar in bars:
        if bar["time"] <= now < bar["time"] + bar_seconds:
            return {"time": bar["time"], "reason": "intervalContainsNow"}
    return None


def is_valid_close_time(
    value: Any, open_seconds: int, bar_seconds: int
) -> bool:
    """closeTime válido: entero ms dentro de (apertura, apertura + duración).

    Un closeTime en segundos (~1.8e9), no entero, o que se sale de la
    duración de la barra no participa en la detección de formación.
    """
    if not is_finite_number(value) or not float(value).is_integer():
        return False
    close_ms = int(value)
    open_ms = open_seconds * 1000
    return open_ms < close_ms < (open_seconds + bar_seconds) * 1000


def is_plausible_server_timestamp_ms(value: Any) -> bool:
    """timestamp del servidor de BingX en ms plausibles.

    Debe ser un entero equivalente a una fecha posterior a septiembre de
    2001 (1e12 ms) y dentro del umbral de sesiones (MAX_TIME_SECONDS ms
    * 1000). Un valor en segundos (~1.8e9) no pasa el mínimo.
    """
    if not is_finite_number(value) or not float(value).is_integer():
        return False
    milliseconds = int(value)
    return 1e12 <= milliseconds <= MAX_TIME_SECONDS * 1000


def resolve_bingx_now(
    explicit_now: int | None,
    server_timestamp_ms: int | None,
    request_now: int,
) -> int:
    """Orden de resolución de `now` para BingX, igual que el requisito."""
    if explicit_now is not None:
        return explicit_now
    if server_timestamp_ms is not None:
        return server_timestamp_ms // 1000
    return request_now


def forming_bingx(
    bars: list[dict[str, Any]],
    close_times: dict[int, int],
    bar_seconds: int,
    now: int | None,
) -> dict[str, Any] | None:
    if now is None:
        return None
    now_ms = now * 1000
    for bar in bars:
        close_time = close_times.get(bar["time"])
        if close_time is not None:
            if bar["time"] * 1000 <= now_ms <= close_time:
                return {
                    "time": bar["time"],
                    "reason": "closeTimeContainsServerTime",
                }
            continue
        if bar["time"] <= now < bar["time"] + bar_seconds:
            return {"time": bar["time"], "reason": "intervalContainsNow"}
    return None


def normalize_massive(
    raw: Any, bar_seconds: int, now: int | None
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    counts = empty_discard_counts()
    discards: list[dict[str, Any]] = []
    bars: list[dict[str, Any]] = []
    seen: set[int] = set()
    input_times: list[int] = []
    vw_missing = 0
    vw_zero = 0
    vw_non_finite = 0
    vw_outside = 0
    malformed = False
    provider_error: dict[str, Any] | None = None

    def discard(cause: str, time: int | None) -> None:
        counts[cause] += 1
        discards.append({"cause": cause, "time": time})

    rows: list[Any] = []
    if not is_record(raw):
        malformed = True
    else:
        provider_error = provider_error_from_massive(raw)
        results = raw.get("results")
        if results is None:
            rows = []
        elif isinstance(results, list):
            rows = results
        else:
            malformed = True
            rows = []

    received = len(rows)

    for row in rows:
        if not is_record(row):
            discard("malformedRow", None)
            continue

        time = parse_milliseconds(row.get("t"))
        if time is None:
            discard("invalidTime", None)
            continue

        open_price = row.get("o")
        high = row.get("h")
        low = row.get("l")
        close = row.get("c")
        volume = row.get("v")

        if not all(
            is_finite_number(value)
            for value in (open_price, high, low, close, volume)
        ):
            discard("nonFinite", time)
            continue

        if (
            open_price <= 0
            or high <= 0
            or low <= 0
            or close <= 0
        ):
            discard("invalidPrice", time)
            continue

        if high < low:
            discard("highBelowLow", time)
            continue

        if volume < 0:
            discard("invalidVolume", time)
            continue

        if time in seen:
            discard("duplicate", time)
            continue

        seen.add(time)
        input_times.append(time)

        bar: dict[str, Any] = {
            "time": time,
            "open": open_price,
            "high": high,
            "low": low,
            "close": close,
            "volume": volume,
        }
        vw = row.get("vw")
        if vw is None:
            vw_missing += 1
        elif not is_finite_number(vw):
            vw_non_finite += 1
        else:
            bar["vw"] = vw
            if vw == 0:
                vw_zero += 1
            if vw < low or vw > high:
                vw_outside += 1

        bars.append(bar)

    bars.sort(key=lambda item: item["time"])
    reordered = [bar["time"] for bar in bars] != input_times
    gaps, gap_detection = detect_gaps(bars, bar_seconds, "massive")
    forming = forming_massive(bars, bar_seconds, now)

    report = {
        "provider": "massive",
        "received": received,
        "accepted": len(bars),
        "discarded": received - len(bars),
        "discardCounts": counts,
        "discards": discards,
        "reordered": reordered,
        "gaps": gaps,
        "gapDetection": gap_detection,
        "vwMissing": vw_missing,
        "vwZero": vw_zero,
        "vwNonFinite": vw_non_finite,
        "vwOutsideRange": vw_outside,
        "formingBar": forming,
        "malformedResponse": malformed,
        "providerError": provider_error,
    }
    return bars, report


def normalize_bingx(
    raw: Any, bar_seconds: int, now: int | None
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    counts = empty_discard_counts()
    discards: list[dict[str, Any]] = []
    bars: list[dict[str, Any]] = []
    seen: set[int] = set()
    input_times: list[int] = []
    close_times: dict[int, int] = {}
    candidate_bars = 0
    candidate_missing = 0
    candidate_zero_volume = 0
    candidate_outside = 0
    malformed = False
    provider_error: dict[str, Any] | None = None

    def discard(cause: str, time: int | None) -> None:
        counts[cause] += 1
        discards.append({"cause": cause, "time": time})

    rows: list[Any] = []
    if not is_record(raw):
        malformed = True
    else:
        code_kind, _ = parse_bingx_code(raw.get("code"))
        if code_kind == "malformed":
            # Un `code` presente no numérico no cumple el contrato del
            # proveedor: respuesta malformada, sin filas.
            malformed = True
        else:
            provider_error = bingx_code_error(raw)
            data = raw.get("data")
            if data is None:
                rows = []
            elif isinstance(data, list):
                rows = data
            else:
                malformed = True
                rows = []

    received = len(rows)

    for row in rows:
        if not isinstance(row, list) or len(row) < 6:
            discard("malformedRow", None)
            continue

        time = parse_milliseconds(row[0])
        if time is None:
            discard("invalidTime", None)
            continue

        open_price = row[1]
        high = row[2]
        low = row[3]
        close = row[4]
        volume = row[5]

        if not all(
            is_finite_number(value)
            for value in (open_price, high, low, close, volume)
        ):
            discard("nonFinite", time)
            continue

        if (
            open_price <= 0
            or high <= 0
            or low <= 0
            or close <= 0
        ):
            discard("invalidPrice", time)
            continue

        if high < low:
            discard("highBelowLow", time)
            continue

        if volume < 0:
            discard("invalidVolume", time)
            continue

        if time in seen:
            discard("duplicate", time)
            continue

        seen.add(time)
        input_times.append(time)

        close_time = row[6] if len(row) >= 7 else None
        if is_valid_close_time(close_time, time, bar_seconds):
            close_times[time] = int(close_time)

        quote_volume = row[7] if len(row) >= 8 else None
        if volume == 0:
            candidate_zero_volume += 1
        elif not is_finite_number(quote_volume):
            candidate_missing += 1
        else:
            candidate = quote_volume / volume
            if not math.isfinite(candidate):
                candidate_missing += 1
            else:
                candidate_bars += 1
                if candidate < low or candidate > high:
                    candidate_outside += 1

        # Nunca se añade vw.
        bars.append(
            {
                "time": time,
                "open": open_price,
                "high": high,
                "low": low,
                "close": close,
                "volume": volume,
            }
        )

    bars.sort(key=lambda item: item["time"])
    reordered = [bar["time"] for bar in bars] != input_times
    gaps, gap_detection = detect_gaps(bars, bar_seconds, "bingx")
    forming = forming_bingx(bars, close_times, bar_seconds, now)

    report = {
        "provider": "bingx",
        "received": received,
        "accepted": len(bars),
        "discarded": received - len(bars),
        "discardCounts": counts,
        "discards": discards,
        "reordered": reordered,
        "gaps": gaps,
        "gapDetection": gap_detection,
        "vwCandidateBars": candidate_bars,
        "vwCandidateMissing": candidate_missing,
        "vwCandidateZeroVolume": candidate_zero_volume,
        "vwCandidateOutsideRange": candidate_outside,
        "vwExposed": False,
        "formingBar": forming,
        "malformedResponse": malformed,
        "providerError": provider_error,
    }
    return bars, report


# ---------------------------------------------------------------------------
# Utilidades para construir casos
# ---------------------------------------------------------------------------


def et_seconds(
    year: int,
    month: int,
    day: int,
    hour: int,
    minute: int,
    second: int = 0,
) -> int:
    return int(
        datetime(
            year, month, day, hour, minute, second, tzinfo=NEW_YORK
        ).timestamp()
    )


def utc_seconds(
    year: int,
    month: int,
    day: int,
    hour: int = 0,
    minute: int = 0,
    second: int = 0,
) -> int:
    return int(
        datetime(year, month, day, hour, minute, second, tzinfo=UTC).timestamp()
    )


def massive_row(
    time: int,
    open_price: float,
    high: float,
    low: float,
    close: float,
    volume: float,
    vw: Any = "OMIT",
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "t": time * 1000,
        "o": open_price,
        "h": high,
        "l": low,
        "c": close,
        "v": volume,
    }
    if vw != "OMIT":
        row["vw"] = vw
    return row


def bingx_row(
    time: int,
    open_price: float,
    high: float,
    low: float,
    close: float,
    volume: float,
    close_time: int | None = None,
    quote_volume: Any = "OMIT",
) -> list[Any]:
    row: list[Any] = [
        time * 1000,
        open_price,
        high,
        low,
        close,
        volume,
    ]
    if close_time is not None or quote_volume != "OMIT":
        row.append(close_time if close_time is not None else time * 1000 + 59_999)
    if quote_volume != "OMIT":
        row.append(quote_volume)
    return row


def massive_case(
    description: str,
    raw: Any,
    bar_seconds: int,
    now: int | None = None,
) -> dict[str, Any]:
    bars, report = normalize_massive(raw, bar_seconds, now)
    options: dict[str, Any] = {"barSeconds": bar_seconds}
    if now is not None:
        options["now"] = now
    return {
        "description": description,
        "options": options,
        "raw": raw,
        "bars": bars,
        "report": report,
    }


def bingx_case(
    description: str,
    raw: Any,
    bar_seconds: int,
    now: int | None = None,
) -> dict[str, Any]:
    bars, report = normalize_bingx(raw, bar_seconds, now)
    options: dict[str, Any] = {"barSeconds": bar_seconds}
    if now is not None:
        options["now"] = now
    return {
        "description": description,
        "options": options,
        "raw": raw,
        "bars": bars,
        "report": report,
    }


def build_massive_cases() -> dict[str, dict[str, Any]]:
    cases: dict[str, dict[str, Any]] = {}
    base = et_seconds(2026, 11, 6, 4, 0)
    after = et_seconds(2026, 11, 7, 20, 0)

    cases["m1_valid_sorted"] = massive_case(
        "tres barras válidas en orden descendente; se ordenan y reordered=true",
        {
            "status": "OK",
            "results": [
                massive_row(base + 120, 100.0, 101.0, 99.5, 100.5, 10.0, 100.2),
                massive_row(base, 99.0, 100.0, 98.5, 99.5, 5.0, 99.1),
                massive_row(base + 60, 99.5, 100.5, 99.0, 100.0, 7.0, 99.8),
            ],
        },
        60,
        after,
    )

    valid = massive_row(base + 600, 100.0, 101.0, 99.0, 100.0, 1.0, 100.0)
    cases["m2_discards"] = massive_case(
        "una fila por cada causa de descarte, más duplicado y vw no finito",
        {
            "status": "OK",
            "results": [
                "not-a-row",
                massive_row(base, 100.0, 101.0, 99.0, 100.0, 1.0),
                {"t": str((base + 60) * 1000), "o": 1, "h": 1, "l": 1, "c": 1, "v": 1},
                massive_row(base + 120, 0.0, 1.0, 0.5, 1.0, 1.0),
                massive_row(base + 180, 1.0, 0.5, 1.0, 1.0, 1.0),
                massive_row(base + 240, 1.0, 1.0, 1.0, 1.0, -1.0),
                massive_row(base + 300, 1.0, 1.0, 1.0, 1.0, 1.0),
                massive_row(base + 300, 2.0, 2.0, 2.0, 2.0, 2.0),
                massive_row(base + 360, 1.0, 1.0, 1.0, 1.0, 1.0, "NaN"),
                massive_row(base + 420, "NaN", 1.0, 1.0, 1.0, 1.0, 1.0),
                valid,
            ],
        },
        60,
        after,
    )

    cases["m3_gap_within_session"] = massive_case(
        "hueco de un minuto dentro de la misma sesión ET; no se rellena",
        {
            "status": "OK",
            "results": [
                massive_row(base, 100.0, 101.0, 99.0, 100.0, 1.0, 100.0),
                massive_row(base + 60, 101.0, 102.0, 100.0, 101.0, 1.0, 101.0),
                massive_row(base + 180, 102.0, 103.0, 101.0, 102.0, 1.0, 102.0),
                massive_row(base + 240, 103.0, 104.0, 102.0, 103.0, 1.0, 103.0),
            ],
        },
        60,
        after,
    )

    cases["m4_gap_cross_session"] = massive_case(
        "salto de 19:59 a 04:00 del día siguiente; NO es un hueco de datos",
        {
            "status": "OK",
            "results": [
                massive_row(et_seconds(2026, 11, 6, 19, 58), 100.0, 101.0, 99.0, 100.0, 1.0, 100.0),
                massive_row(et_seconds(2026, 11, 6, 19, 59), 101.0, 102.0, 100.0, 101.0, 1.0, 101.0),
                massive_row(et_seconds(2026, 11, 7, 4, 0), 102.0, 103.0, 101.0, 102.0, 1.0, 102.0),
                massive_row(et_seconds(2026, 11, 7, 4, 1), 103.0, 104.0, 102.0, 103.0, 1.0, 103.0),
            ],
        },
        60,
        after,
    )

    cases["m5_daily_gap_skipped"] = massive_case(
        "barras diarias con fin de semana: gapDetection=skippedDaily y sin huecos",
        {
            "status": "OK",
            "results": [
                massive_row(et_seconds(2026, 11, 5, 0, 0), 100.0, 101.0, 99.0, 100.0, 1.0, 100.0),
                massive_row(et_seconds(2026, 11, 6, 0, 0), 101.0, 102.0, 100.0, 101.0, 1.0, 101.0),
                massive_row(et_seconds(2026, 11, 9, 0, 0), 102.0, 103.0, 101.0, 102.0, 1.0, 102.0),
            ],
        },
        86_400,
        et_seconds(2026, 11, 10, 12, 0),
    )

    cases["m6_provider_error"] = massive_case(
        "respuesta de error del proveedor; no hay barras",
        {"status": "ERROR", "error": "boom"},
        60,
        after,
    )

    cases["m7_malformed_response"] = massive_case(
        "results no es un array; malformedResponse=true",
        {"status": "OK", "results": "nope"},
        60,
        after,
    )

    cases["m8_not_object"] = massive_case(
        "la respuesta cruda no es un objeto; malformedResponse=true",
        ["not", "an", "object"],
        60,
        after,
    )

    cases["m9_forming_intraday"] = massive_case(
        "now cae dentro de la barra de 04:02; se reporta pero no se elimina",
        {
            "status": "OK",
            "results": [
                massive_row(base + 60, 100.0, 101.0, 99.0, 100.0, 1.0, 100.0),
                massive_row(base + 120, 101.0, 102.0, 100.0, 101.0, 1.0, 101.0),
                massive_row(base + 180, 102.0, 103.0, 101.0, 102.0, 1.0, 102.0),
            ],
        },
        60,
        base + 150,
    )

    cases["m10_forming_daily"] = massive_case(
        "now cae en la fecha ET de la barra diaria en formación",
        {
            "status": "OK",
            "results": [
                massive_row(et_seconds(2026, 11, 5, 0, 0), 100.0, 101.0, 99.0, 100.0, 1.0, 100.0),
                massive_row(et_seconds(2026, 11, 6, 0, 0), 101.0, 102.0, 100.0, 101.0, 1.0, 101.0),
            ],
        },
        86_400,
        et_seconds(2026, 11, 6, 12, 0),
    )

    cases["m11_vw_stats"] = massive_case(
        "estadísticas de vw: ausente, null, cero, no finito, dentro y fuera de rango",
        {
            "status": "OK",
            "results": [
                massive_row(base, 100.0, 110.0, 90.0, 100.0, 1.0, 100.0),
                massive_row(base + 60, 100.0, 110.0, 90.0, 100.0, 1.0, 90.0),
                massive_row(base + 120, 100.0, 110.0, 90.0, 100.0, 1.0, 110.0),
                massive_row(base + 180, 100.0, 110.0, 90.0, 100.0, 1.0, 89.0),
                massive_row(base + 240, 100.0, 110.0, 90.0, 100.0, 1.0, 111.0),
                massive_row(base + 300, 100.0, 110.0, 90.0, 100.0, 1.0, 0.0),
                massive_row(base + 360, 100.0, 110.0, 90.0, 100.0, 1.0),
                massive_row(base + 420, 100.0, 110.0, 90.0, 100.0, 1.0, None),
                massive_row(base + 480, 100.0, 110.0, 90.0, 100.0, 1.0, "Infinity"),
            ],
        },
        60,
        after,
    )

    cases["m12_out_of_range_time_gap"] = massive_case(
        "t fuera de rango (1e15 ms) se descarta como invalidTime; el hueco se calcula con las barras válidas sin lanzar",
        {
            "status": "OK",
            "results": [
                massive_row(base, 100.0, 101.0, 99.0, 100.0, 1.0, 100.0),
                massive_row(10**12, 101.0, 102.0, 100.0, 101.0, 1.0, 101.0),
                massive_row(base + 120, 102.0, 103.0, 101.0, 102.0, 1.0, 102.0),
            ],
        },
        60,
        after,
    )

    cases["m13_time_upper_bound"] = massive_case(
        "t en el límite exacto (1e14 ms = 1e11 s) se acepta",
        {
            "status": "OK",
            "results": [
                massive_row(10**11, 100.0, 101.0, 99.0, 100.0, 1.0, 100.0),
                massive_row(10**11 + 60, 101.0, 102.0, 100.0, 101.0, 1.0, 101.0),
            ],
        },
        60,
    )

    return cases


def build_bingx_cases() -> dict[str, dict[str, Any]]:
    cases: dict[str, dict[str, Any]] = {}
    base = utc_seconds(2026, 11, 7, 12, 0)
    after = utc_seconds(2026, 11, 7, 20, 0)

    cases["b1_valid_sorted"] = bingx_case(
        "tres barras válidas descendentes; se ordenan y reordered=true",
        {
            "code": 0,
            "timestamp": after * 1000,
            "data": [
                bingx_row(base + 120, 100.0, 101.0, 99.5, 100.5, 10.0, (base + 179) * 1000, 1002.0),
                bingx_row(base, 99.0, 100.0, 98.5, 99.5, 5.0, (base + 59) * 1000, 495.0),
                bingx_row(base + 60, 99.5, 100.5, 99.0, 100.0, 7.0, (base + 119) * 1000, 700.0),
            ],
        },
        60,
        after,
    )

    valid = bingx_row(base + 600, 100.0, 101.0, 99.0, 100.0, 1.0, (base + 659) * 1000, 100.0)
    cases["b2_discards"] = bingx_case(
        "una fila por cada causa de descarte, más duplicado",
        {
            "code": 0,
            "timestamp": after * 1000,
            "data": [
                "not-a-row",
                [base * 1000, 1.0, 1.0, 1.0, 1.0],
                [str((base + 60) * 1000), 1.0, 1.0, 1.0, 1.0, 1.0],
                [(base + 120) * 1000, 1.0, 1.0, 1.0, 1.0, 1.0],
                [0, 1.0, 1.0, 1.0, 1.0, 1.0],
                [((base + 180) * 1000) + 1, 1.0, 1.0, 1.0, 1.0, 1.0],
                [(base + 240) * 1000, None, 1.0, 1.0, 1.0, 1.0],
                [(base + 300) * 1000, 0.0, 1.0, 0.5, 1.0, 1.0],
                [(base + 360) * 1000, 1.0, 0.5, 1.0, 1.0, 1.0],
                [(base + 420) * 1000, 1.0, 1.0, 1.0, 1.0, -1.0],
                [(base + 480) * 1000, 1.0, 1.0, 1.0, 1.0, 1.0],
                [(base + 480) * 1000, 2.0, 2.0, 2.0, 2.0, 2.0],
                valid,
            ],
        },
        60,
        after,
    )

    cases["b3_gap_cross_midnight"] = bingx_case(
        "hueco de un minuto que cruza medianoche UTC; SÍ se reporta",
        {
            "code": 0,
            "timestamp": utc_seconds(2026, 11, 8, 0, 10) * 1000,
            "data": [
                bingx_row(utc_seconds(2026, 11, 7, 23, 58), 100.0, 101.0, 99.0, 100.0, 1.0, utc_seconds(2026, 11, 7, 23, 58) * 1000 + 59_999, 100.0),
                bingx_row(utc_seconds(2026, 11, 7, 23, 59), 101.0, 102.0, 100.0, 101.0, 1.0, utc_seconds(2026, 11, 7, 23, 59) * 1000 + 59_999, 101.0),
                bingx_row(utc_seconds(2026, 11, 8, 0, 1), 102.0, 103.0, 101.0, 102.0, 1.0, utc_seconds(2026, 11, 8, 0, 1) * 1000 + 59_999, 102.0),
                bingx_row(utc_seconds(2026, 11, 8, 0, 2), 103.0, 104.0, 102.0, 103.0, 1.0, utc_seconds(2026, 11, 8, 0, 2) * 1000 + 59_999, 103.0),
            ],
        },
        60,
        utc_seconds(2026, 11, 8, 0, 10),
    )

    cases["b4_daily_gap_skipped"] = bingx_case(
        "barras diarias con fin de semana: gapDetection=skippedDaily",
        {
            "code": 0,
            "timestamp": utc_seconds(2026, 11, 10, 12, 0) * 1000,
            "data": [
                bingx_row(utc_seconds(2026, 11, 5, 16, 0), 100.0, 101.0, 99.0, 100.0, 1.0, utc_seconds(2026, 11, 6, 15, 59, 59) * 1000 + 999, 100.0),
                bingx_row(utc_seconds(2026, 11, 6, 16, 0), 101.0, 102.0, 100.0, 101.0, 1.0, utc_seconds(2026, 11, 7, 15, 59, 59) * 1000 + 999, 101.0),
                bingx_row(utc_seconds(2026, 11, 9, 16, 0), 102.0, 103.0, 101.0, 102.0, 1.0, utc_seconds(2026, 11, 10, 15, 59, 59) * 1000 + 999, 102.0),
            ],
        },
        86_400,
        utc_seconds(2026, 11, 10, 20, 0),
    )

    cases["b5_provider_error"] = bingx_case(
        "respuesta de error de BingX; no hay barras",
        {
            "code": 100204,
            "msg": "maximum query range is 380 days",
            "data": None,
        },
        86_400,
        after,
    )

    cases["b6_malformed_response"] = bingx_case(
        "data no es un array; malformedResponse=true",
        {"code": 0, "data": {}},
        60,
        after,
    )

    cases["b7_not_object"] = bingx_case(
        "la respuesta cruda no es un objeto; malformedResponse=true",
        ["not", "an", "object"],
        60,
        after,
    )

    cases["b8_forming_close_time"] = bingx_case(
        "now cae dentro del closeTime de la última barra; se reporta la formación",
        {
            "code": 0,
            "timestamp": (base + 150) * 1000,
            "data": [
                bingx_row(base + 60, 100.0, 101.0, 99.0, 100.0, 1.0, (base + 119) * 1000 + 999, 100.0),
                bingx_row(base + 120, 101.0, 102.0, 100.0, 101.0, 1.0, (base + 179) * 1000 + 999, 101.0),
                bingx_row(base + 180, 102.0, 103.0, 101.0, 102.0, 1.0, (base + 239) * 1000 + 999, 102.0),
            ],
        },
        60,
        base + 150,
    )

    cases["b9_forming_interval"] = bingx_case(
        "sin closeTime, now cae dentro del intervalo de la barra; formación por intervalo",
        {
            "code": 0,
            "timestamp": (base + 150) * 1000,
            "data": [
                [((base + 60) * 1000), 100.0, 101.0, 99.0, 100.0, 1.0],
                [((base + 120) * 1000), 101.0, 102.0, 100.0, 101.0, 1.0],
                [((base + 180) * 1000), 102.0, 103.0, 101.0, 102.0, 1.0],
            ],
        },
        60,
        base + 150,
    )

    cases["b10_vw_candidate_stats"] = bingx_case(
        "candidato quoteVolume/volume: dentro, fuera, ausente y volumen cero; vwExposed=false",
        {
            "code": 0,
            "timestamp": after * 1000,
            "data": [
                bingx_row(base, 100.0, 110.0, 90.0, 100.0, 2.0, (base + 59) * 1000, 200.0),
                bingx_row(base + 60, 100.0, 110.0, 90.0, 100.0, 2.0, (base + 119) * 1000, 178.0),
                bingx_row(base + 120, 100.0, 110.0, 90.0, 100.0, 2.0, (base + 179) * 1000, 222.0),
                bingx_row(base + 180, 100.0, 110.0, 90.0, 100.0, 2.0, (base + 239) * 1000),
                bingx_row(base + 240, 100.0, 110.0, 90.0, 100.0, 0.0, (base + 299) * 1000, 0.0),
                bingx_row(base + 300, 100.0, 110.0, 90.0, 100.0, 2.0, (base + 359) * 1000, "NaN"),
            ],
        },
        60,
        after,
    )

    cases["b11_code_numeric_string_error"] = bingx_case(
        "code como string numérico distinto de cero: error del proveedor",
        {"code": "100204", "msg": "range too large"},
        60,
        after,
    )

    cases["b12_code_string_zero"] = bingx_case(
        'code "0" como string: respuesta válida y barras aceptadas',
        {
            "code": "0",
            "timestamp": after * 1000,
            "data": [
                bingx_row(base + 60, 100.0, 101.0, 99.0, 100.0, 1.0),
                bingx_row(base, 99.0, 100.0, 98.0, 99.0, 1.0),
            ],
        },
        60,
        after,
    )

    cases["b13_code_malformed"] = bingx_case(
        "code presente no numérico: malformedResponse=true y sin filas",
        {
            "code": "oops",
            "data": [
                bingx_row(base, 99.0, 100.0, 98.0, 99.0, 1.0),
            ],
        },
        60,
        after,
    )

    cases["b14_out_of_range_time_gap"] = bingx_case(
        "openTime fuera de rango (1e15 ms) se descarta como invalidTime; el hueco se calcula sin lanzar",
        {
            "code": 0,
            "timestamp": after * 1000,
            "data": [
                bingx_row(base, 100.0, 101.0, 99.0, 100.0, 1.0),
                bingx_row(10**12, 101.0, 102.0, 100.0, 101.0, 1.0),
                bingx_row(base + 120, 102.0, 103.0, 101.0, 102.0, 1.0),
            ],
        },
        60,
        after,
    )

    cases["b15_time_upper_bound"] = bingx_case(
        "openTime en el límite exacto (1e14 ms = 1e11 s) se acepta",
        {
            "code": 0,
            "data": [
                bingx_row(10**11, 100.0, 101.0, 99.0, 100.0, 1.0),
                bingx_row(10**11 + 60, 101.0, 102.0, 100.0, 101.0, 1.0),
            ],
        },
        60,
    )

    cases["b16_close_time_seconds_unit_fallback"] = bingx_case(
        "closeTime en segundos se ignora: la barra cae al fallback por intervalo",
        {
            "code": 0,
            "timestamp": (base + 90) * 1000,
            "data": [
                bingx_row(base + 120, 101.0, 102.0, 100.0, 101.0, 1.0),
                bingx_row(
                    base + 60, 100.0, 101.0, 99.0, 100.0, 1.0,
                    close_time=base + 119,
                ),
            ],
        },
        60,
        base + 90,
    )

    cases["b17_close_time_out_of_duration"] = bingx_case(
        "closeTime más allá de la duración se ignora: la barra cerrada no se marca en formación",
        {
            "code": 0,
            "timestamp": (base + 200) * 1000,
            "data": [
                bingx_row(
                    base + 120, 101.0, 102.0, 100.0, 101.0, 1.0,
                    close_time=(base + 120 + 7200) * 1000,
                ),
                bingx_row(
                    base + 60, 100.0, 101.0, 99.0, 100.0, 1.0,
                    close_time=(base + 119) * 1000 + 999,
                ),
            ],
        },
        60,
        base + 200,
    )

    return cases


# ---------------------------------------------------------------------------
# Referencia del cargador (Paso D)
# ---------------------------------------------------------------------------

MASSIVE_LOAD_BASE = "https://api.polygon.io"
BINGX_LOAD_BASE = "https://open-api.bingx.com"
MASSIVE_LOAD_LIMIT = 50_000
BINGX_LOAD_LIMIT = 1_000
DEFAULT_LOAD_MAX_PAGES = 10
FIXTURE_API_KEY = "fixture-api-key"
AUTH_PARAM_NAMES = {"apikey", "api_key", "api-key"}
AUTH_PARAM_PATTERN = re.compile(
    r"([?&](?:" + "|".join(sorted(AUTH_PARAM_NAMES)) + r")=)[^&\s]+",
    re.IGNORECASE,
)
SECONDS_PER_DAY = 86_400

TIMEFRAME_SECONDS = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "1h": 3_600,
    "4h": 14_400,
    "1D": 86_400,
}

MASSIVE_LOAD_TIMEFRAMES = {
    "1m": (1, "minute"),
    "5m": (5, "minute"),
    "15m": (15, "minute"),
    "1h": (1, "hour"),
    "4h": (4, "hour"),
    "1D": (1, "day"),
}

MASSIVE_BARS_PER_DAY = {
    "1m": 960,
    "5m": 192,
    "15m": 64,
    "1h": 16,
    "4h": 4,
    "1D": 1,
}

# Barras RTH por día (apertura dentro de 09:30-16:00 ET). Con rthOnly el
# lookback se escala con esta tabla. Sin entrada para 1D: rthOnly con 1D
# se rechaza en la validación porque ninguna barra diaria abre dentro de RTH.
MASSIVE_RTH_BARS_PER_DAY = {
    "1m": 390,
    "5m": 78,
    "15m": 26,
    "1h": 6,
    "4h": 1,
}

BINGX_LOAD_INTERVALS = {
    "1m": "1m",
    "5m": "5m",
    "15m": "15m",
    "1h": "1h",
    "4h": "4h",
    "1D": "1d",
}

BINGX_MAX_RANGE_DAYS = {
    "1m": 2,
    "5m": 8,
    "15m": 22,
    "1h": 90,
    "4h": 350,
    "1D": 380,
}


def massive_align_down(time: int, timeframe: str) -> int:
    if timeframe == "1D":
        parts = datetime.fromtimestamp(time, tz=NEW_YORK)
        return et_seconds(parts.year, parts.month, parts.day, 0, 0)
    if timeframe == "4h":
        parts = datetime.fromtimestamp(time, tz=NEW_YORK)
        aligned_minutes = (parts.hour * 60 + parts.minute) // 240 * 240
        return et_seconds(
            parts.year,
            parts.month,
            parts.day,
            aligned_minutes // 60,
            aligned_minutes % 60,
        )
    return time - (time % TIMEFRAME_SECONDS[timeframe])


def is_rth(seconds: int) -> bool:
    """RTH del SPEC: 09:30 <= t < 16:00 ET, lunes a viernes."""
    parts = datetime.fromtimestamp(seconds, tz=NEW_YORK)
    minutes = parts.hour * 60 + parts.minute
    weekday = parts.isoweekday()  # lunes = 1 ... domingo = 7
    return 1 <= weekday <= 5 and 9 * 60 + 30 <= minutes < 16 * 60


def massive_lookback_days(
    requested_bars: int,
    timeframe: str,
    rth_only: bool = False,
) -> int:
    bars_per_day = (
        MASSIVE_RTH_BARS_PER_DAY[timeframe]
        if rth_only
        else MASSIVE_BARS_PER_DAY[timeframe]
    )
    return (
        math.ceil((requested_bars / bars_per_day) * (7 / 5)) + 10
    )


def shift_date_key(date_key: str, delta_days: int) -> str:
    day = datetime.fromisoformat(date_key).date() + timedelta(days=delta_days)
    return day.isoformat()


def massive_load_window(
    now: int,
    timeframe: str,
    requested_bars: int,
    rth_only: bool = False,
) -> dict[str, Any]:
    lookback_days = massive_lookback_days(
        requested_bars, timeframe, rth_only
    )
    if timeframe == "1D":
        to_date = et_date_key(now)
        return {
            "from": shift_date_key(to_date, -lookback_days),
            "to": to_date,
        }
    from_time = massive_align_down(
        now - lookback_days * SECONDS_PER_DAY, timeframe
    )
    return {"from": from_time * 1000, "to": now * 1000}


def massive_load_url(
    base_url: str,
    symbol: str,
    timeframe: str,
    window: dict[str, Any],
) -> str:
    multiplier, timespan = MASSIVE_LOAD_TIMEFRAMES[timeframe]
    path = (
        f"/v2/aggs/ticker/{urllib.parse.quote(symbol, safe='')}/range/"
        f"{multiplier}/{timespan}/{window['from']}/{window['to']}"
    )
    query = urllib.parse.urlencode(
        [
            ("adjusted", "true"),
            ("sort", "desc"),
            ("limit", str(MASSIVE_LOAD_LIMIT)),
        ]
    )
    return f"{base_url}{path}?{query}"


def bingx_load_window(now: int, timeframe: str) -> tuple[int, int]:
    end_time = now * 1000
    start_time = (
        end_time - BINGX_MAX_RANGE_DAYS[timeframe] * SECONDS_PER_DAY * 1000
    )
    return start_time, end_time


def bingx_load_url(
    base_url: str,
    symbol: str,
    timeframe: str,
    start_time: int,
    end_time: int,
) -> str:
    query = urllib.parse.urlencode(
        [
            ("symbol", symbol),
            ("interval", BINGX_LOAD_INTERVALS[timeframe]),
            ("limit", str(BINGX_LOAD_LIMIT)),
            ("startTime", str(start_time)),
            ("endTime", str(end_time)),
        ]
    )
    return f"{base_url}/openApi/spot/v2/market/kline?{query}"


def sanitize_load_url(url: str) -> str:
    parts = urllib.parse.urlsplit(url)
    pairs = [
        (key, value)
        for key, value in urllib.parse.parse_qsl(
            parts.query, keep_blank_values=True
        )
        if key.lower() not in AUTH_PARAM_NAMES
    ]
    return urllib.parse.urlunsplit(
        (
            parts.scheme,
            parts.netloc,
            parts.path,
            urllib.parse.urlencode(pairs),
            parts.fragment,
        )
    )


def auth_param_for_url(url: str) -> str:
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    return "apikey" if host == "api.massive.com" else "apiKey"


def with_api_key(url: str, api_key: str, base_url: str) -> str:
    absolute = urllib.parse.urljoin(base_url, url)
    parts = urllib.parse.urlsplit(absolute)
    pairs = [
        (key, value)
        for key, value in urllib.parse.parse_qsl(
            parts.query, keep_blank_values=True
        )
        if key.lower() not in AUTH_PARAM_NAMES
    ]
    pairs.append((auth_param_for_url(absolute), api_key))
    return urllib.parse.urlunsplit(
        (
            parts.scheme,
            parts.netloc,
            parts.path,
            urllib.parse.urlencode(pairs),
            parts.fragment,
        )
    )


def default_port(scheme: str) -> int | None:
    if scheme == "https":
        return 443
    if scheme == "http":
        return 80
    return None


def allowed_next_url(url: str, base_url: str) -> str:
    """Devuelve la URL absoluta de next_url o lanza ValueError.

    Regla escrita a partir del requisito, de forma independiente: un
    next_url solo se sigue si pertenece al MISMO origen que base_url
    (esquema, host y puerto), con esquema http/https y sin credenciales
    en la propia URL. La clave nunca viaja a un host distinto del
    configurado.
    """
    absolute = urllib.parse.urljoin(base_url, url)
    parts = urllib.parse.urlsplit(absolute)
    scheme = parts.scheme.lower()
    if scheme not in ("http", "https"):
        raise ValueError(f"Unsupported next_url protocol: {scheme}")
    if parts.username or parts.password:
        raise ValueError("next_url must not include credentials")
    base = urllib.parse.urlsplit(base_url)
    base_scheme = base.scheme.lower()
    if scheme != base_scheme:
        raise ValueError("next_url scheme mismatch")
    host = (parts.hostname or "").lower()
    base_host = (base.hostname or "").lower()
    if host != base_host:
        raise ValueError("next_url host mismatch")
    port = parts.port if parts.port is not None else default_port(scheme)
    base_port = (
        base.port if base.port is not None else default_port(base_scheme)
    )
    if port != base_port:
        raise ValueError("next_url port mismatch")
    return urllib.parse.urlunsplit(
        (
            parts.scheme,
            parts.netloc,
            parts.path,
            parts.query,
            parts.fragment,
        )
    )


def expected_load_request(
    url: str, provider: str, api_key: str
) -> dict[str, Any]:
    if provider == "massive":
        return {
            "url": sanitize_load_url(url),
            "authParam": auth_param_for_url(url),
            "authValue": api_key,
        }
    return {
        "url": sanitize_load_url(url),
        "authParam": None,
        "authValue": None,
    }


def redact_load_secret(text: str, secret: str) -> str:
    out = text
    if secret:
        out = out.replace(secret, "<redacted>")
        encoded = urllib.parse.quote(secret, safe="")
        if encoded and encoded != secret:
            out = out.replace(encoded, "<redacted>")
    return AUTH_PARAM_PATTERN.sub(r"\1<redacted>", out)


def parse_json_text(text: str) -> tuple[Any, bool]:
    try:
        return json.loads(text), True
    except json.JSONDecodeError:
        return None, False


def http_error_message(
    text: str, status: int, secret: str
) -> dict[str, Any]:
    message = f"HTTP {status}"
    body, parsed = parse_json_text(text)
    if parsed and isinstance(body, dict):
        candidate = (
            body.get("error") or body.get("message") or body.get("msg")
        )
        if isinstance(candidate, str) and candidate:
            message = candidate
    return {
        "code": status,
        "message": redact_load_secret(message, secret),
    }


def oldest_open_time_seconds(rows: list[Any]) -> int | None:
    """openTime más antiguo EN SEGUNDOS, solo con ms válidos.

    Una fila con openTime en segundos o fuera de rango no participa: no
    debe mover la ventana de paginación hacia atrás de forma errónea.
    """
    values: list[int] = []
    for row in rows:
        if not isinstance(row, list) or not row:
            continue
        seconds = parse_milliseconds(row[0])
        if seconds is not None:
            values.append(seconds)
    return min(values) if values else None


def closed_bars(
    bars: list[dict[str, Any]], forming: dict[str, Any] | None
) -> list[dict[str, Any]]:
    if forming is None:
        return list(bars)
    return [bar for bar in bars if bar["time"] != forming["time"]]


def simulate_loader(case: dict[str, Any]) -> dict[str, Any]:
    options = case["options"]
    provider = options["provider"]
    symbol = options["symbol"]
    timeframe = options["timeframe"]
    visible_bars = options["visibleBars"]
    warmup_bars = options.get("warmupBars", 1000)
    requested_bars = visible_bars + warmup_bars
    # Orden de resolución de `now`: explícito -> timestamp del servidor
    # (solo BingX, en ms plausibles) -> reloj de la petición. Ningún caso
    # del fixture omite `now`: el reloj del sistema no es reproducible en
    # el generador, así que la rama del timestamp queda especificada pero
    # no ejercida por los casos.
    explicit_now: int | None = options.get("now")
    request_now: int | None = explicit_now
    if request_now is None:
        raise RuntimeError(
            "los casos del cargador fijan now de forma explícita"
        )
    now: int = request_now
    max_pages = options.get("maxPages", DEFAULT_LOAD_MAX_PAGES)
    api_key = options.get("apiKey", "")
    base_url = options.get("baseUrl")
    if base_url is None:
        base_url = (
            MASSIVE_LOAD_BASE
            if provider == "massive"
            else BINGX_LOAD_BASE
        )
    base_url = base_url.rstrip("/")
    rth_only = options.get("rthOnly", False)
    bar_seconds = TIMEFRAME_SECONDS[timeframe]

    responses = case["responses"]
    requests: list[dict[str, Any]] = []
    rows: list[Any] = []
    pages = 0
    page_error: dict[str, Any] | None = None
    malformed = False
    stopped: str | None = None
    probe: tuple[list[dict[str, Any]], dict[str, Any]] | None = None
    start_time: int | None = None
    end_time: int | None = None
    server_ts_max: int | None = None

    if provider == "massive":
        window = massive_load_window(
            now, timeframe, requested_bars, rth_only
        )
        url = massive_load_url(base_url, symbol, timeframe, window)
        url = with_api_key(url, api_key, base_url)
    else:
        start_time, end_time = bingx_load_window(now, timeframe)
        url = bingx_load_url(
            base_url, symbol, timeframe, start_time, end_time
        )

    while pages < max_pages:
        if pages >= len(responses):
            raise RuntimeError(
                "fixture has fewer responses than requests"
            )
        response = responses[pages]
        pages += 1
        requests.append(expected_load_request(url, provider, api_key))

        if "throws" in response:
            thrown = response["throws"]
            if not isinstance(thrown, str):
                thrown = ""
            page_error = {
                "code": 0,
                "message": redact_load_secret(thrown, api_key),
            }
            stopped = "providerError"
            break

        status = int(response.get("status", 0))
        ok = bool(response.get("ok", True))
        text = response.get("text", "")
        if not isinstance(text, str):
            text = ""

        if not ok or status < 200 or status >= 300:
            page_error = http_error_message(text, status, api_key)
            stopped = "providerError"
            break

        body, parsed = parse_json_text(text)
        if not parsed:
            malformed = True
            stopped = "malformedResponse"
            break

        if provider == "massive":
            if not isinstance(body, dict):
                malformed = True
                stopped = "malformedResponse"
                break
            response_status = body.get("status")
            if (
                isinstance(response_status, str)
                and response_status.upper() != "OK"
            ):
                message = (
                    body.get("error")
                    or body.get("message")
                    or response_status
                )
                if not isinstance(message, str):
                    message = response_status
                page_error = {
                    "code": 0,
                    "message": redact_load_secret(message, api_key),
                }
                stopped = "providerError"
                break

            results = body.get("results")
            if results is None:
                page_rows: list[Any] = []
            elif isinstance(results, list):
                page_rows = results
            else:
                malformed = True
                stopped = "malformedResponse"
                break

            rows.extend(page_rows)
            bars, report = normalize_massive(
                {"status": "OK", "results": rows}, bar_seconds, now
            )
            probe = (bars, report)
            closed = closed_bars(bars, report["formingBar"])
            candidates = (
                [bar for bar in closed if is_rth(bar["time"])]
                if rth_only
                else closed
            )
            if len(candidates) >= requested_bars:
                stopped = "targetReached"
                break
            if not page_rows:
                stopped = "noMorePages"
                break

            next_url = body.get("next_url")
            if not isinstance(next_url, str) or not next_url:
                stopped = "noMorePages"
                break
            if pages >= max_pages:
                stopped = "maxPages"
                break
            try:
                url = with_api_key(
                    allowed_next_url(next_url, base_url),
                    api_key,
                    base_url,
                )
            except ValueError:
                malformed = True
                stopped = "malformedResponse"
                break
        else:
            if not isinstance(body, dict):
                malformed = True
                stopped = "malformedResponse"
                break
            code_kind, _ = parse_bingx_code(body.get("code"))
            if code_kind == "malformed":
                malformed = True
                stopped = "malformedResponse"
                break
            code_error = bingx_code_error(body)
            if code_error is not None:
                page_error = {
                    "code": code_error["code"],
                    "message": redact_load_secret(
                        code_error["message"], api_key
                    ),
                }
                stopped = "providerError"
                break

            data = body.get("data")
            if data is None:
                page_rows = []
            elif isinstance(data, list):
                page_rows = data
            else:
                malformed = True
                stopped = "malformedResponse"
                break

            rows.extend(page_rows)
            server_ts = body.get("timestamp")
            if not is_plausible_server_timestamp_ms(server_ts):
                server_ts = None
            if server_ts is not None:
                server_ts = int(server_ts)
                server_ts_max = (
                    server_ts
                    if server_ts_max is None
                    else max(server_ts_max, server_ts)
                )
            now = resolve_bingx_now(
                explicit_now, server_ts_max, request_now
            )
            bars, report = normalize_bingx(
                {"code": 0, "data": rows}, bar_seconds, now
            )
            probe = (bars, report)
            closed = closed_bars(bars, report["formingBar"])
            if len(closed) >= requested_bars:
                stopped = "targetReached"
                break
            if not page_rows:
                stopped = "noMorePages"
                break

            oldest = oldest_open_time_seconds(page_rows)
            if (
                oldest is None
                or start_time is None
                or oldest * 1000 <= start_time
            ):
                stopped = "noMorePages"
                break
            if pages >= max_pages:
                stopped = "maxPages"
                break
            end_time = oldest * 1000 - 1
            url = bingx_load_url(
                base_url, symbol, timeframe, start_time, end_time
            )

    if stopped is None:
        stopped = "maxPages" if pages >= max_pages else "noMorePages"

    if probe is None:
        if provider == "massive":
            probe = normalize_massive(
                {"status": "OK", "results": rows}, bar_seconds, now
            )
        else:
            probe = normalize_bingx(
                {"code": 0, "data": rows}, bar_seconds, now
            )

    bars, report = probe
    forming = report["formingBar"]
    closed = closed_bars(bars, forming)
    # Con rthOnly el objetivo y el recorte se aplican sobre barras RTH;
    # los huecos se calculan sobre el buffer cerrado completo, antes del
    # filtro.
    candidates = (
        [bar for bar in closed if is_rth(bar["time"])]
        if (rth_only and provider == "massive")
        else closed
    )
    normalized_bars = len(candidates)
    trimmed = candidates[-requested_bars:] if requested_bars > 0 else []
    trimmed_bars = normalized_bars - len(trimmed)
    visible_start = max(0, len(trimmed) - visible_bars)
    gaps, gap_detection = detect_gaps(closed, bar_seconds, provider)

    report = dict(report)
    report["gaps"] = gaps
    report["gapDetection"] = gap_detection
    report["malformedResponse"] = bool(
        malformed or report["malformedResponse"]
    )
    if page_error is not None:
        report["providerError"] = page_error
    report.update(
        {
            "requestedBars": requested_bars,
            "visibleBars": visible_bars,
            "warmupBars": warmup_bars,
            "normalizedBars": normalized_bars,
            "trimmedBars": trimmed_bars,
            "formingExcluded": (
                forming is not None and len(closed) < len(bars)
            ),
            "warmupSatisfied": normalized_bars >= requested_bars,
            "pages": pages,
            "firstTime": trimmed[0]["time"] if trimmed else None,
            "lastTime": trimmed[-1]["time"] if trimmed else None,
            "stoppedReason": stopped,
        }
    )

    return {
        "bars": trimmed,
        "visibleStart": visible_start,
        "report": report,
        "requests": requests,
    }


def json_response(
    body: Any, status: int = 200, ok: bool = True
) -> dict[str, Any]:
    return {
        "status": status,
        "ok": ok,
        "text": json.dumps(
            body, ensure_ascii=False, separators=(",", ":")
        ),
    }


def text_response(
    text: str, status: int = 200, ok: bool = True
) -> dict[str, Any]:
    return {"status": status, "ok": ok, "text": text}


def loader_case(
    description: str,
    options: dict[str, Any],
    responses: list[dict[str, Any]],
) -> dict[str, Any]:
    case = {
        "description": description,
        "options": options,
        "responses": responses,
    }
    case["expected"] = simulate_loader(case)
    return case


def validate_load_options(options: dict[str, Any]) -> str | None:
    provider = options.get("provider")
    if provider not in ("massive", "bingx"):
        return f"Unsupported provider: {provider}"
    timeframe = options.get("timeframe")
    if timeframe not in TIMEFRAME_SECONDS:
        return f"Unsupported timeframe: {timeframe}"
    symbol = options.get("symbol")
    if not isinstance(symbol, str) or symbol.strip() == "":
        return "symbol must be a non-empty string"
    visible_bars = options.get("visibleBars")
    if (
        not isinstance(visible_bars, int)
        or isinstance(visible_bars, bool)
        or visible_bars < 0
    ):
        return (
            "visibleBars must be a non-negative integer "
            f"(got {visible_bars})"
        )
    warmup_bars = options.get("warmupBars", 1000)
    if (
        not isinstance(warmup_bars, int)
        or isinstance(warmup_bars, bool)
        or warmup_bars < 0
    ):
        return (
            "warmupBars must be a non-negative integer "
            f"(got {warmup_bars})"
        )
    requested_bars = visible_bars + warmup_bars
    if requested_bars <= 0:
        return "visibleBars + warmupBars must be greater than 0"
    now = options.get("now")
    if now is not None and (
        not isinstance(now, (int, float))
        or isinstance(now, bool)
        or not math.isfinite(now)
        or not float(now).is_integer()
    ):
        return f"now must be finite integer seconds (got {now})"
    if now is not None and (now <= 0 or now > MAX_TIME_SECONDS):
        return f"now must be within the supported seconds range (got {now})"
    max_pages = options.get("maxPages", DEFAULT_LOAD_MAX_PAGES)
    if (
        not isinstance(max_pages, int)
        or isinstance(max_pages, bool)
        or max_pages < 1
    ):
        return f"maxPages must be a positive integer (got {max_pages})"
    rth_only = options.get("rthOnly", False)
    if not isinstance(rth_only, bool):
        return f"rthOnly must be a boolean (got {rth_only})"
    if rth_only and provider != "massive":
        return "rthOnly is only supported for massive"
    if rth_only and timeframe == "1D":
        return "rthOnly does not support the 1D timeframe"
    api_key = options.get("apiKey")
    if provider == "massive" and (
        not isinstance(api_key, str) or api_key == ""
    ):
        return "apiKey is required for Massive"
    base_url = options.get("baseUrl")
    default_base = (
        MASSIVE_LOAD_BASE
        if provider == "massive"
        else BINGX_LOAD_BASE
    )
    resolved_base = (
        base_url if base_url is not None else default_base
    ).rstrip("/")
    if resolved_base == "":
        return "baseUrl must be a non-empty URL"
    return None


def build_massive_loader_cases() -> dict[str, dict[str, Any]]:
    cases: dict[str, dict[str, Any]] = {}
    base = et_seconds(2026, 11, 6, 4, 0)
    after = et_seconds(2026, 11, 7, 20, 0)

    def options(**overrides: Any) -> dict[str, Any]:
        values: dict[str, Any] = {
            "provider": "massive",
            "symbol": "SPY",
            "timeframe": "1m",
            "visibleBars": 2,
            "warmupBars": 2,
            "now": after,
            "maxPages": 5,
            "apiKey": FIXTURE_API_KEY,
        }
        values.update(overrides)
        return values

    next_url = (
        "https://api.polygon.io/v2/aggs/ticker/SPY/range/1/minute/"
        "1793955600000/1794048000000"
        "?adjusted=true&sort=desc&limit=50000&cursor=abc123"
        "&api_key=old-key"
    )
    cases["lm1_pagination_target"] = loader_case(
        "Massive pagina con next_url, elimina el parámetro de "
        "autenticación antiguo y alcanza el objetivo",
        options(),
        [
            json_response(
                {
                    "status": "OK",
                    "results": [
                        massive_row(
                            base + 180, 102.0, 103.0, 101.0, 102.0, 1.0,
                            102.0,
                        ),
                        massive_row(
                            base + 120, 101.0, 102.0, 100.0, 101.0, 1.0,
                            101.0,
                        ),
                    ],
                    "next_url": next_url,
                }
            ),
            json_response(
                {
                    "status": "OK",
                    "results": [
                        massive_row(
                            base + 60, 100.0, 101.0, 99.0, 100.0, 1.0,
                            100.0,
                        ),
                        massive_row(
                            base, 99.0, 100.0, 98.0, 99.0, 1.0, 99.0,
                        ),
                    ],
                }
            ),
        ],
    )

    cases["lm2_forming_trim_discards"] = loader_case(
        "Massive excluye la barra en formación, recorta el buffer y "
        "reporta descartes",
        options(now=base + 330),
        [
            json_response(
                {
                    "status": "OK",
                    "results": [
                        massive_row(
                            base, 99.0, 100.0, 98.0, 99.0, 1.0, 99.0,
                        ),
                        massive_row(
                            base + 60, 100.0, 101.0, 99.0, 100.0, 1.0,
                            100.0,
                        ),
                        massive_row(
                            base + 120, 101.0, 102.0, 100.0, 101.0, 1.0,
                            101.0,
                        ),
                        massive_row(
                            base + 180, 102.0, 103.0, 101.0, 102.0, 1.0,
                            102.0,
                        ),
                        massive_row(
                            base + 240, 103.0, 104.0, 102.0, 103.0, 1.0,
                            103.0,
                        ),
                        massive_row(
                            base + 300, 104.0, 105.0, 103.0, 104.0, 1.0,
                            104.0,
                        ),
                        massive_row(
                            base + 60, 100.0, 101.0, 99.0, 100.0, 1.0,
                            100.0,
                        ),
                        "not-a-row",
                    ],
                }
            ),
        ],
    )

    cases["lm3_daily_forming"] = loader_case(
        "Massive 1D usa fechas ET y excluye la barra diaria en formación",
        options(
            timeframe="1D",
            visibleBars=1,
            warmupBars=1,
            now=et_seconds(2026, 11, 6, 12, 0),
        ),
        [
            json_response(
                {
                    "status": "OK",
                    "results": [
                        massive_row(
                            et_seconds(2026, 11, 4, 0, 0),
                            99.0, 100.0, 98.0, 99.0, 1.0, 99.0,
                        ),
                        massive_row(
                            et_seconds(2026, 11, 5, 0, 0),
                            100.0, 101.0, 99.0, 100.0, 1.0, 100.0,
                        ),
                        massive_row(
                            et_seconds(2026, 11, 6, 0, 0),
                            101.0, 102.0, 100.0, 101.0, 1.0, 101.0,
                        ),
                    ],
                }
            ),
        ],
    )

    cases["lm4_4h_alignment"] = loader_case(
        "Massive 4h alinea el from a la rejilla ET de 4 horas",
        options(
            timeframe="4h",
            visibleBars=1,
            warmupBars=2,
            now=et_seconds(2026, 11, 7, 19, 30),
        ),
        [
            json_response(
                {
                    "status": "OK",
                    "results": [
                        massive_row(
                            et_seconds(2026, 11, 6, 4, 0),
                            99.0, 100.0, 98.0, 99.0, 1.0, 99.0,
                        ),
                        massive_row(
                            et_seconds(2026, 11, 6, 8, 0),
                            100.0, 101.0, 99.0, 100.0, 1.0, 100.0,
                        ),
                        massive_row(
                            et_seconds(2026, 11, 6, 12, 0),
                            101.0, 102.0, 100.0, 101.0, 1.0, 101.0,
                        ),
                        massive_row(
                            et_seconds(2026, 11, 6, 16, 0),
                            102.0, 103.0, 101.0, 102.0, 1.0, 102.0,
                        ),
                    ],
                }
            ),
        ],
    )

    cases["lm5_provider_error_http"] = loader_case(
        "Massive HTTP 403: el mensaje del proveedor se redacta",
        options(visibleBars=1, warmupBars=1),
        [
            json_response(
                {"error": "bad key fixture-api-key"},
                status=403,
                ok=False,
            ),
        ],
    )

    cases["lm6_provider_error_throws"] = loader_case(
        "Massive error de red lanzado: se captura y se redacta",
        options(visibleBars=1, warmupBars=1),
        [{"throws": "network failed for fixture-api-key"}],
    )

    cases["lm7_malformed_json"] = loader_case(
        "Massive cuerpo que no es JSON: malformedResponse=true",
        options(visibleBars=1, warmupBars=1),
        [text_response("not json")],
    )

    cases["lm8_results_not_array"] = loader_case(
        "Massive results no es un array: malformedResponse=true",
        options(visibleBars=1, warmupBars=1),
        [json_response({"status": "OK", "results": "nope"})],
    )

    cases["lm9_empty"] = loader_case(
        "Massive sin resultados: noMorePages y cero barras",
        options(visibleBars=1, warmupBars=1),
        [json_response({"status": "OK", "results": []})],
    )

    cases["lm10_max_pages"] = loader_case(
        "Massive agota maxPages antes de alcanzar el objetivo",
        options(visibleBars=5, warmupBars=5, maxPages=2),
        [
            json_response(
                {
                    "status": "OK",
                    "results": [
                        massive_row(
                            base, 99.0, 100.0, 98.0, 99.0, 1.0, 99.0,
                        ),
                        massive_row(
                            base + 60, 100.0, 101.0, 99.0, 100.0, 1.0,
                            100.0,
                        ),
                    ],
                    "next_url": next_url,
                }
            ),
            json_response(
                {
                    "status": "OK",
                    "results": [
                        massive_row(
                            base + 120, 101.0, 102.0, 100.0, 101.0, 1.0,
                            101.0,
                        ),
                        massive_row(
                            base + 180, 102.0, 103.0, 101.0, 102.0, 1.0,
                            102.0,
                        ),
                    ],
                    "next_url": next_url,
                }
            ),
        ],
    )

    cases["lm11_massive_host_auth"] = loader_case(
        "Massive con host api.massive.com usa el parámetro apikey",
        options(
            baseUrl="https://api.massive.com",
            visibleBars=1,
            warmupBars=1,
        ),
        [
            json_response(
                {
                    "status": "OK",
                    "results": [
                        massive_row(
                            base, 99.0, 100.0, 98.0, 99.0, 1.0, 99.0,
                        ),
                        massive_row(
                            base + 60, 100.0, 101.0, 99.0, 100.0, 1.0,
                            100.0,
                        ),
                    ],
                }
            ),
        ],
    )

    cases["lm12_no_more_pages"] = loader_case(
        "Massive con datos pero sin next_url: noMorePages",
        options(visibleBars=3, warmupBars=2),
        [
            json_response(
                {
                    "status": "OK",
                    "results": [
                        massive_row(
                            base, 99.0, 100.0, 98.0, 99.0, 1.0, 99.0,
                        ),
                        massive_row(
                            base + 60, 100.0, 101.0, 99.0, 100.0, 1.0,
                            100.0,
                        ),
                    ],
                }
            ),
        ],
    )

    default_warmup = options(visibleBars=1)
    default_warmup.pop("warmupBars")
    cases["lm13_default_warmup"] = loader_case(
        "Massive usa warmupBars=1000 por defecto",
        default_warmup,
        [
            json_response(
                {
                    "status": "OK",
                    "results": [
                        massive_row(
                            base, 99.0, 100.0, 98.0, 99.0, 1.0, 99.0,
                        ),
                        massive_row(
                            base + 60, 100.0, 101.0, 99.0, 100.0, 1.0,
                            100.0,
                        ),
                    ],
                }
            ),
        ],
    )

    def two_rows_page() -> dict[str, Any]:
        return {
            "status": "OK",
            "results": [
                massive_row(
                    base + 60, 100.0, 101.0, 99.0, 100.0, 1.0, 100.0,
                ),
                massive_row(
                    base, 99.0, 100.0, 98.0, 99.0, 1.0, 99.0,
                ),
            ],
        }

    cases["lm14_next_url_external_host"] = loader_case(
        "Massive rechaza un next_url de otro host y no le envía la clave",
        options(visibleBars=2, warmupBars=2),
        [
            json_response(
                {
                    **two_rows_page(),
                    "next_url": (
                        "https://evil.example/v2/steal"
                        "?cursor=abc123&api_key=old-key"
                    ),
                }
            ),
        ],
    )

    cases["lm15_next_url_relative_same_origin"] = loader_case(
        "Massive acepta un next_url relativo del mismo origen",
        options(),
        [
            json_response(
                {
                    **two_rows_page(),
                    "next_url": (
                        "/v2/aggs/ticker/SPY/range/1/minute/"
                        "1793955600000/1794048000000"
                        "?adjusted=true&sort=desc&limit=50000"
                        "&cursor=abc123&api_key=old-key"
                    ),
                }
            ),
            json_response(
                {
                    "status": "OK",
                    "results": [
                        massive_row(
                            base + 120, 101.0, 102.0, 100.0, 101.0, 1.0,
                            101.0,
                        ),
                        massive_row(
                            base + 180, 102.0, 103.0, 101.0, 102.0, 1.0,
                            102.0,
                        ),
                    ],
                }
            ),
        ],
    )

    cases["lm16_next_url_scheme_downgrade"] = loader_case(
        "Massive rechaza un next_url http cuando la base es https",
        options(visibleBars=2, warmupBars=2),
        [
            json_response(
                {
                    **two_rows_page(),
                    "next_url": (
                        "http://api.polygon.io/v2/steal?cursor=abc123"
                    ),
                }
            ),
        ],
    )

    cases["lm17_next_url_with_credentials"] = loader_case(
        "Massive rechaza un next_url con credenciales en la URL",
        options(visibleBars=2, warmupBars=2),
        [
            json_response(
                {
                    **two_rows_page(),
                    "next_url": (
                        "https://user:pass@api.polygon.io/v2/steal"
                        "?cursor=abc123"
                    ),
                }
            ),
        ],
    )

    cases["lm18_out_of_range_time"] = loader_case(
        "Massive descarta t fuera de rango y calcula el hueco sin lanzar",
        options(visibleBars=1, warmupBars=1),
        [
            json_response(
                {
                    "status": "OK",
                    "results": [
                        massive_row(base + 120, 102.0, 103.0, 101.0, 102.0, 1.0, 102.0),
                        massive_row(10**12, 101.0, 102.0, 100.0, 101.0, 1.0, 101.0),
                        massive_row(base, 100.0, 101.0, 99.0, 100.0, 1.0, 100.0),
                    ],
                }
            ),
        ],
    )

    cases["lm19_4h_dst_window"] = loader_case(
        "Massive 4h: el ancla del from usa el desfase ET del inicio de la ventana (cruza el cambio de noviembre)",
        options(
            timeframe="4h",
            visibleBars=1,
            warmupBars=2,
            now=et_seconds(2026, 11, 7, 19, 30),
        ),
        [
            json_response(
                {
                    "status": "OK",
                    "results": [
                        massive_row(
                            utc_seconds(2026, 11, 6, 8, 0),
                            99.0, 100.0, 98.0, 99.0, 1.0, 99.0,
                        ),
                        massive_row(
                            utc_seconds(2026, 11, 6, 12, 0),
                            100.0, 101.0, 99.0, 100.0, 1.0, 100.0,
                        ),
                        massive_row(
                            utc_seconds(2026, 11, 6, 16, 0),
                            101.0, 102.0, 100.0, 101.0, 1.0, 101.0,
                        ),
                        massive_row(
                            utc_seconds(2026, 11, 6, 20, 0),
                            102.0, 103.0, 101.0, 102.0, 1.0, 102.0,
                        ),
                    ],
                }
            ),
        ],
    )

    saturday = et_seconds(2026, 11, 7, 20, 0)

    def rth_case_options(**overrides: Any) -> dict[str, Any]:
        values = options(now=saturday, **overrides)
        values["rthOnly"] = True
        return values

    cases["lm20_rth_only_filter"] = loader_case(
        "Massive rthOnly: el buffer solo contiene barras con apertura dentro de RTH y el lookback se escala",
        rth_case_options(visibleBars=2, warmupBars=3),
        [
            json_response(
                {
                    "status": "OK",
                    "results": [
                        massive_row(et_seconds(2026, 11, 6, 15, 59), 105.0, 106.0, 104.0, 105.0, 1.0, 105.0),
                        massive_row(et_seconds(2026, 11, 6, 15, 58), 104.9, 105.9, 103.9, 104.9, 1.0, 104.9),
                        massive_row(et_seconds(2026, 11, 6, 15, 57), 104.8, 105.8, 103.8, 104.8, 1.0, 104.8),
                        massive_row(et_seconds(2026, 11, 6, 15, 56), 104.7, 105.7, 103.7, 104.7, 1.0, 104.7),
                        massive_row(et_seconds(2026, 11, 6, 15, 55), 104.6, 105.6, 103.6, 104.6, 1.0, 104.6),
                        massive_row(et_seconds(2026, 11, 6, 16, 1), 105.1, 106.1, 104.1, 105.1, 1.0, 105.1),
                        massive_row(et_seconds(2026, 11, 6, 16, 0), 105.0, 106.0, 104.0, 105.0, 1.0, 105.0),
                        massive_row(et_seconds(2026, 11, 6, 9, 29), 99.9, 100.9, 98.9, 99.9, 1.0, 99.9),
                        massive_row(et_seconds(2026, 11, 6, 9, 28), 99.8, 100.8, 98.8, 99.8, 1.0, 99.8),
                        massive_row(et_seconds(2026, 11, 6, 4, 0), 99.0, 100.0, 98.0, 99.0, 1.0, 99.0),
                    ],
                }
            ),
        ],
    )

    cases["lm21_rth_only_halt_gap"] = loader_case(
        "Massive rthOnly: el hueco de una parada dentro de RTH se reporta sobre el buffer cerrado completo",
        rth_case_options(visibleBars=2, warmupBars=4),
        [
            json_response(
                {
                    "status": "OK",
                    "results": [
                        massive_row(et_seconds(2026, 11, 6, 15, 59), 105.0, 106.0, 104.0, 105.0, 1.0, 105.0),
                        massive_row(et_seconds(2026, 11, 6, 15, 58), 104.9, 105.9, 103.9, 104.9, 1.0, 104.9),
                        massive_row(et_seconds(2026, 11, 6, 15, 57), 104.8, 105.8, 103.8, 104.8, 1.0, 104.8),
                        massive_row(et_seconds(2026, 11, 6, 15, 56), 104.7, 105.7, 103.7, 104.7, 1.0, 104.7),
                        massive_row(et_seconds(2026, 11, 6, 15, 55), 104.6, 105.6, 103.6, 104.6, 1.0, 104.6),
                        massive_row(et_seconds(2026, 11, 6, 15, 54), 104.5, 105.5, 103.5, 104.5, 1.0, 104.5),
                        massive_row(et_seconds(2026, 11, 6, 15, 53), 104.4, 105.4, 103.4, 104.4, 1.0, 104.4),
                        massive_row(et_seconds(2026, 11, 6, 15, 46), 103.9, 104.9, 102.9, 103.9, 1.0, 103.9),
                        massive_row(et_seconds(2026, 11, 6, 15, 45), 103.8, 104.8, 102.8, 103.8, 1.0, 103.8),
                        massive_row(et_seconds(2026, 11, 6, 15, 44), 103.7, 104.7, 102.7, 103.7, 1.0, 103.7),
                        massive_row(et_seconds(2026, 11, 6, 15, 43), 103.6, 104.6, 102.6, 103.6, 1.0, 103.6),
                        massive_row(et_seconds(2026, 11, 6, 15, 42), 103.5, 104.5, 102.5, 103.5, 1.0, 103.5),
                        massive_row(et_seconds(2026, 11, 6, 15, 41), 103.4, 104.4, 102.4, 103.4, 1.0, 103.4),
                        massive_row(et_seconds(2026, 11, 6, 15, 40), 103.3, 104.3, 102.3, 103.3, 1.0, 103.3),
                        massive_row(et_seconds(2026, 11, 6, 15, 39), 103.2, 104.2, 102.2, 103.2, 1.0, 103.2),
                        massive_row(et_seconds(2026, 11, 6, 15, 38), 103.1, 104.1, 102.1, 103.1, 1.0, 103.1),
                        massive_row(et_seconds(2026, 11, 6, 15, 37), 103.0, 104.0, 102.0, 103.0, 1.0, 103.0),
                        massive_row(et_seconds(2026, 11, 6, 15, 36), 102.9, 103.9, 101.9, 102.9, 1.0, 102.9),
                        massive_row(et_seconds(2026, 11, 6, 15, 35), 102.8, 103.8, 101.8, 102.8, 1.0, 102.8),
                        massive_row(et_seconds(2026, 11, 6, 15, 34), 102.7, 103.7, 101.7, 102.7, 1.0, 102.7),
                        massive_row(et_seconds(2026, 11, 6, 15, 33), 102.6, 103.6, 101.6, 102.6, 1.0, 102.6),
                        massive_row(et_seconds(2026, 11, 6, 15, 32), 102.5, 103.5, 101.5, 102.5, 1.0, 102.5),
                        massive_row(et_seconds(2026, 11, 6, 15, 31), 102.4, 103.4, 101.4, 102.4, 1.0, 102.4),
                        massive_row(et_seconds(2026, 11, 6, 15, 30), 102.3, 103.3, 101.3, 102.3, 1.0, 102.3),
                    ],
                }
            ),
        ],
    )

    cases["lm22_rth_only_insufficient"] = loader_case(
        "Massive rthOnly: sin barras RTH suficientes el reporte lo muestra (noMorePages con normalizedBars menor)",
        rth_case_options(visibleBars=2, warmupBars=4),
        [
            json_response(
                {
                    "status": "OK",
                    "results": [
                        massive_row(et_seconds(2026, 11, 6, 15, 59), 105.0, 106.0, 104.0, 105.0, 1.0, 105.0),
                        massive_row(et_seconds(2026, 11, 6, 15, 58), 104.9, 105.9, 103.9, 104.9, 1.0, 104.9),
                        massive_row(et_seconds(2026, 11, 6, 15, 57), 104.8, 105.8, 103.8, 104.8, 1.0, 104.8),
                        massive_row(et_seconds(2026, 11, 6, 16, 1), 105.1, 106.1, 104.1, 105.1, 1.0, 105.1),
                        massive_row(et_seconds(2026, 11, 6, 16, 0), 105.0, 106.0, 104.0, 105.0, 1.0, 105.0),
                        massive_row(et_seconds(2026, 11, 6, 9, 29), 99.9, 100.9, 98.9, 99.9, 1.0, 99.9),
                        massive_row(et_seconds(2026, 11, 6, 9, 28), 99.8, 100.8, 98.8, 99.8, 1.0, 99.8),
                    ],
                }
            ),
        ],
    )

    cases["lm23_rth_only_lookback"] = loader_case(
        "Massive rthOnly: el lookback se escala a barras RTH por día (12 días RTH vs 11 con la tabla normal)",
        rth_case_options(visibleBars=10, warmupBars=500),
        [
            json_response(
                {
                    "status": "OK",
                    "results": [
                        massive_row(et_seconds(2026, 11, 6, 15, 59), 105.0, 106.0, 104.0, 105.0, 1.0, 105.0),
                        massive_row(et_seconds(2026, 11, 6, 15, 58), 104.9, 105.9, 103.9, 104.9, 1.0, 104.9),
                        massive_row(et_seconds(2026, 11, 6, 15, 57), 104.8, 105.8, 103.8, 104.8, 1.0, 104.8),
                        massive_row(et_seconds(2026, 11, 6, 15, 56), 104.7, 105.7, 103.7, 104.7, 1.0, 104.7),
                        massive_row(et_seconds(2026, 11, 6, 15, 55), 104.6, 105.6, 103.6, 104.6, 1.0, 104.6),
                        massive_row(et_seconds(2026, 11, 6, 16, 1), 105.1, 106.1, 104.1, 105.1, 1.0, 105.1),
                        massive_row(et_seconds(2026, 11, 6, 16, 0), 105.0, 106.0, 104.0, 105.0, 1.0, 105.0),
                        massive_row(et_seconds(2026, 11, 6, 9, 29), 99.9, 100.9, 98.9, 99.9, 1.0, 99.9),
                        massive_row(et_seconds(2026, 11, 6, 9, 28), 99.8, 100.8, 98.8, 99.8, 1.0, 99.8),
                        massive_row(et_seconds(2026, 11, 6, 4, 0), 99.0, 100.0, 98.0, 99.0, 1.0, 99.0),
                    ],
                }
            ),
        ],
    )

    return cases


def build_bingx_loader_cases() -> dict[str, dict[str, Any]]:
    cases: dict[str, dict[str, Any]] = {}
    base = utc_seconds(2026, 11, 7, 12, 0)
    later = utc_seconds(2026, 11, 7, 20, 0)

    def options(**overrides: Any) -> dict[str, Any]:
        values: dict[str, Any] = {
            "provider": "bingx",
            "symbol": "BTC-USDT",
            "timeframe": "1m",
            "visibleBars": 2,
            "warmupBars": 2,
            "now": later,
            "maxPages": 5,
        }
        values.update(overrides)
        return values

    cases["lb1_pagination_target"] = loader_case(
        "BingX pagina con endTime decreciente y alcanza el objetivo",
        options(),
        [
            json_response(
                {
                    "code": 0,
                    "timestamp": later * 1000,
                    "data": [
                        bingx_row(
                            base + 180, 102.0, 103.0, 101.0, 102.0, 1.0,
                        ),
                        bingx_row(
                            base + 120, 101.0, 102.0, 100.0, 101.0, 1.0,
                        ),
                    ],
                }
            ),
            json_response(
                {
                    "code": 0,
                    "timestamp": later * 1000,
                    "data": [
                        bingx_row(
                            base + 60, 100.0, 101.0, 99.0, 100.0, 1.0,
                        ),
                        bingx_row(
                            base, 99.0, 100.0, 98.0, 99.0, 1.0,
                        ),
                    ],
                }
            ),
        ],
    )

    cases["lb2_forming_close_time"] = loader_case(
        "BingX excluye la barra en formación por closeTime",
        options(visibleBars=1, warmupBars=1, now=base + 130),
        [
            json_response(
                {
                    "code": 0,
                    "timestamp": (base + 130) * 1000,
                    "data": [
                        bingx_row(
                            base, 99.0, 100.0, 98.0, 99.0, 1.0,
                        ),
                        bingx_row(
                            base + 60, 100.0, 101.0, 99.0, 100.0, 1.0,
                        ),
                        bingx_row(
                            base + 120, 101.0, 102.0, 100.0, 101.0, 1.0,
                            close_time=(base + 179) * 1000,
                        ),
                    ],
                }
            ),
        ],
    )

    cases["lb3_discards_trim"] = loader_case(
        "BingX descarta filas inválidas y recorta el buffer",
        options(visibleBars=1, warmupBars=2, now=base + 400),
        [
            json_response(
                {
                    "code": 0,
                    "timestamp": (base + 400) * 1000,
                    "data": [
                        bingx_row(
                            base, 99.0, 100.0, 98.0, 99.0, 1.0,
                        ),
                        bingx_row(
                            base + 60, 100.0, 101.0, 99.0, 100.0, 1.0,
                        ),
                        bingx_row(
                            base + 120, 101.0, 102.0, 100.0, 101.0, 1.0,
                        ),
                        bingx_row(
                            base + 180, 102.0, 103.0, 101.0, 102.0, 1.0,
                        ),
                        bingx_row(
                            base + 240, 103.0, 104.0, 102.0, 103.0, 1.0,
                        ),
                        bingx_row(
                            base + 60, 100.0, 101.0, 99.0, 100.0, 1.0,
                        ),
                        "not-a-row",
                        bingx_row(
                            base + 300, 104.0, 105.0, 103.0, 104.0, -1.0,
                        ),
                    ],
                }
            ),
        ],
    )

    cases["lb4_empty"] = loader_case(
        "BingX sin datos: noMorePages y cero barras",
        options(visibleBars=1, warmupBars=1),
        [json_response({"code": 0, "data": []})],
    )

    cases["lb5_provider_error"] = loader_case(
        "BingX code distinto de cero: error del proveedor",
        options(visibleBars=1, warmupBars=1),
        [
            json_response(
                {
                    "code": 100204,
                    "msg": "range too large",
                }
            ),
        ],
    )

    cases["lb6_malformed_json"] = loader_case(
        "BingX cuerpo que no es JSON: malformedResponse=true",
        options(visibleBars=1, warmupBars=1),
        [text_response("not json")],
    )

    cases["lb7_malformed_data"] = loader_case(
        "BingX data no es un array: malformedResponse=true",
        options(visibleBars=1, warmupBars=1),
        [json_response({"code": 0, "data": "nope"})],
    )

    cases["lb8_max_pages"] = loader_case(
        "BingX agota maxPages antes de alcanzar el objetivo",
        options(
            visibleBars=5,
            warmupBars=5,
            maxPages=2,
            now=base + 3600,
        ),
        [
            json_response(
                {
                    "code": 0,
                    "data": [
                        bingx_row(
                            base + 60, 100.0, 101.0, 99.0, 100.0, 1.0,
                        ),
                        bingx_row(
                            base, 99.0, 100.0, 98.0, 99.0, 1.0,
                        ),
                    ],
                }
            ),
            json_response(
                {
                    "code": 0,
                    "data": [
                        bingx_row(
                            base - 60, 98.0, 99.0, 97.0, 98.0, 1.0,
                        ),
                        bingx_row(
                            base - 120, 97.0, 98.0, 96.0, 97.0, 1.0,
                        ),
                    ],
                }
            ),
        ],
    )

    cases["lb9_daily_forming"] = loader_case(
        "BingX 1D excluye la barra diaria en formación por closeTime",
        options(
            timeframe="1D",
            visibleBars=1,
            warmupBars=0,
            now=utc_seconds(2026, 11, 7, 12, 0),
        ),
        [
            json_response(
                {
                    "code": 0,
                    "timestamp": utc_seconds(2026, 11, 7, 12, 0) * 1000,
                    "data": [
                        bingx_row(
                            utc_seconds(2026, 11, 5, 16, 0),
                            99.0, 100.0, 98.0, 99.0, 1.0,
                            close_time=utc_seconds(
                                2026, 11, 6, 15, 59, 59
                            )
                            * 1000,
                        ),
                        bingx_row(
                            utc_seconds(2026, 11, 6, 16, 0),
                            100.0, 101.0, 99.0, 100.0, 1.0,
                            close_time=utc_seconds(
                                2026, 11, 7, 15, 59, 59
                            )
                            * 1000,
                        ),
                    ],
                }
            ),
        ],
    )

    cases["lb10_code_numeric_string_error"] = loader_case(
        "BingX code como string numérico distinto de cero: error del proveedor",
        options(visibleBars=1, warmupBars=1),
        [
            json_response(
                {
                    "code": "100204",
                    "msg": "range too large",
                }
            ),
        ],
    )

    cases["lb11_code_string_zero"] = loader_case(
        'BingX code "0" como string: respuesta válida y barras cargadas',
        options(visibleBars=1, warmupBars=1, now=base + 600),
        [
            json_response(
                {
                    "code": "0",
                    "timestamp": (base + 600) * 1000,
                    "data": [
                        bingx_row(
                            base, 99.0, 100.0, 98.0, 99.0, 1.0,
                        ),
                        bingx_row(
                            base + 60, 100.0, 101.0, 99.0, 100.0, 1.0,
                        ),
                    ],
                }
            ),
        ],
    )

    cases["lb12_code_malformed"] = loader_case(
        "BingX code presente no numérico: malformedResponse=true",
        options(visibleBars=1, warmupBars=1),
        [json_response({"code": "oops", "data": []})],
    )

    cases["lb13_out_of_range_time"] = loader_case(
        "BingX descarta openTime fuera de rango y calcula el hueco sin lanzar",
        options(visibleBars=1, warmupBars=1, now=base + 600),
        [
            json_response(
                {
                    "code": 0,
                    "timestamp": (base + 600) * 1000,
                    "data": [
                        bingx_row(base + 120, 102.0, 103.0, 101.0, 102.0, 1.0),
                        bingx_row(10**12, 101.0, 102.0, 100.0, 101.0, 1.0),
                        bingx_row(base, 100.0, 101.0, 99.0, 100.0, 1.0),
                    ],
                }
            ),
        ],
    )

    cases["lb14_seconds_open_time_pagination"] = loader_case(
        "BingX ignora un openTime en segundos al paginar y alcanza el objetivo",
        options(visibleBars=1, warmupBars=2, now=base + 600),
        [
            json_response(
                {
                    "code": 0,
                    "timestamp": (base + 600) * 1000,
                    "data": [
                        bingx_row(base + 120, 101.0, 102.0, 100.0, 101.0, 1.0),
                        bingx_row(base + 60, 100.0, 101.0, 99.0, 100.0, 1.0),
                        [base, 100.0, 101.0, 99.0, 100.0, 1.0],
                    ],
                }
            ),
            json_response(
                {
                    "code": 0,
                    "timestamp": (base + 600) * 1000,
                    "data": [
                        bingx_row(base, 99.0, 100.0, 98.0, 99.0, 1.0),
                    ],
                }
            ),
        ],
    )

    warmup_default = options(
        timeframe="1D",
        visibleBars=1,
        now=utc_seconds(2026, 11, 8, 12, 0),
    )
    warmup_default.pop("warmupBars")
    cases["lb15_warmup_insufficient_1d"] = loader_case(
        "BingX 1D con warmup por defecto: el techo de ~380 días deja warmupSatisfied=false",
        warmup_default,
        [
            json_response(
                {
                    "code": 0,
                    "timestamp": utc_seconds(2026, 11, 8, 12, 0) * 1000,
                    "data": [
                        bingx_row(
                            utc_seconds(2026, 11, 5, 16, 0),
                            99.0, 100.0, 98.0, 99.0, 1.0,
                        ),
                        bingx_row(
                            utc_seconds(2026, 11, 6, 16, 0),
                            100.0, 101.0, 99.0, 100.0, 1.0,
                        ),
                    ],
                }
            ),
            json_response({"code": 0, "data": []}),
        ],
    )

    return cases


def build_loader_validation_cases() -> dict[str, dict[str, Any]]:
    base: dict[str, Any] = {
        "provider": "massive",
        "symbol": "SPY",
        "timeframe": "1m",
        "visibleBars": 10,
        "warmupBars": 10,
        "now": utc_seconds(2026, 11, 7, 20, 0),
        "maxPages": 3,
        "apiKey": FIXTURE_API_KEY,
    }

    def case(description: str, **overrides: Any) -> dict[str, Any]:
        options = dict(base)
        for key, value in overrides.items():
            if key == "apiKey" and value is None:
                options.pop(key, None)
            else:
                options[key] = value
        error = validate_load_options(options)
        if error is None:
            raise RuntimeError(
                f"validation case did not fail: {description}"
            )
        return {
            "description": description,
            "options": options,
            "expectedError": error,
        }

    return {
        "v1_provider": case(
            "proveedor no soportado", provider="other"
        ),
        "v2_timeframe": case(
            "temporalidad no soportada", timeframe="2m"
        ),
        "v3_symbol": case("símbolo vacío", symbol="   "),
        "v4_visible": case(
            "visibleBars negativo", visibleBars=-1
        ),
        "v5_visible_fraction": case(
            "visibleBars no entero", visibleBars=1.5
        ),
        "v6_warmup": case(
            "warmupBars negativo", warmupBars=-1
        ),
        "v7_zero": case(
            "buffer total cero", visibleBars=0, warmupBars=0
        ),
        "v8_now": case("now no entero", now=1.5),
        "v9_max_pages": case("maxPages cero", maxPages=0),
        "v10_api_key": case(
            "Massive sin clave", **{"apiKey": None}
        ),
        "v11_base_url": case(
            "baseUrl vacío", baseUrl="///"
        ),
        "v12_now_range": case(
            "now fuera del rango admitido", now=10**15
        ),
        "v13_rth_only_bingx": case(
            "rthOnly con BingX", provider="bingx", rthOnly=True
        ),
        "v14_rth_only_1d": case(
            "rthOnly con 1D", timeframe="1D", rthOnly=True
        ),
        "v15_rth_only_type": case(
            "rthOnly no booleano", rthOnly="yes"
        ),
    }


# ---------------------------------------------------------------------------
# Referencia de alineación (auditoría A9)
# ---------------------------------------------------------------------------


def align_down(time: int, timeframe: str, provider: str) -> int:
    """Baja `time` al inicio de la barra que lo contiene; nunca sube.

    Massive: 1m/5m/15m/1h son múltiplos desde la época UTC (el desfase ET
    es un número entero de horas); 4h fija el ancla en un límite de pared
    ET del instante dado (00:00/04:00/.../20:00 ET); 1D abre a 00:00 ET.
    BingX: múltiplos de la temporalidad desde la época UTC; 1D abre a las
    16:00 UTC (00:00 UTC+8).

    El ancla 4h es correcta en hora ET EN EL INSTANTE dado; la rejilla que
    el proveedor avanza en UTC desplaza las horas ET ±1h en una ventana
    que cruza un cambio de horario.
    """
    bar_seconds = TIMEFRAME_SECONDS[timeframe]
    if provider == "bingx":
        if timeframe == "1D":
            return (
                (time - 16 * 3600) // 86400
            ) * 86400 + 16 * 3600
        return time - (time % bar_seconds)
    return massive_align_down(time, timeframe)


def build_alignment_cases() -> dict[str, dict[str, Any]]:
    """Casos de alignDown con implementación independiente.

    Incluye el ancla de 4h alrededor de los cambios de horario de 2026
    (08-mar spring forward, 01-nov fall back) y las ramas de época de
    Massive y BingX que el cargador no ejercita.
    """
    cases: dict[str, dict[str, Any]] = {}

    def case(
        name: str,
        description: str,
        provider: str,
        timeframe: str,
        time: int,
    ) -> None:
        cases[name] = {
            "description": description,
            "provider": provider,
            "timeframe": timeframe,
            "time": time,
            "expected": align_down(time, timeframe, provider),
        }

    case(
        "a1_4h_fall_back_anchor",
        "20:30 EDT: el límite de pared es 16:00 EDT = 20:00Z",
        "massive",
        "4h",
        et_seconds(2026, 10, 26, 20, 30),
    )
    case(
        "a2_4h_after_fall_back",
        "03:00 EST tras el cambio: el límite es 00:00 EST = 05:00Z, no 04:00Z",
        "massive",
        "4h",
        et_seconds(2026, 11, 2, 3, 0),
    )
    case(
        "a3_4h_spring_forward",
        "07:30Z del cambio de marzo (=03:30 EDT): baja a 00:00 ET = 05:00Z",
        "massive",
        "4h",
        utc_seconds(2026, 3, 8, 7, 30),
    )
    case(
        "a4_4h_edt_bucket",
        "02:00 EDT de julio: baja a 00:00 EDT = 04:00Z",
        "massive",
        "4h",
        et_seconds(2026, 7, 1, 2, 0),
    )
    case(
        "a5_1d_est_midnight",
        "12:00 EST de noviembre: 1D baja a 00:00 EST = 05:00Z",
        "massive",
        "1D",
        et_seconds(2026, 11, 6, 12, 0),
    )
    case(
        "a6_1d_edt_midnight",
        "12:00 EDT de julio: 1D baja a 00:00 EDT = 04:00Z",
        "massive",
        "1D",
        et_seconds(2026, 7, 1, 12, 0),
    )
    case(
        "a7_1h_epoch",
        "1h: múltiplo de hora desde la época UTC",
        "massive",
        "1h",
        1794097800,
    )
    case(
        "a8_15m_epoch",
        "15m: múltiplo de 900 s desde la época UTC",
        "massive",
        "15m",
        et_seconds(2026, 11, 6, 4, 0) + 150,
    )
    case(
        "a9_1m_epoch",
        "1m: múltiplo de 60 s desde la época UTC",
        "massive",
        "1m",
        et_seconds(2026, 11, 6, 4, 0) + 30,
    )
    case(
        "a10_bingx_4h_epoch",
        "BingX 4h: múltiplo de 14400 s desde la época UTC",
        "bingx",
        "4h",
        et_seconds(2026, 11, 6, 4, 0) + 100,
    )
    case(
        "a11_bingx_1d_16_utc",
        "BingX 1D: baja a las 16:00 UTC que contiene el instante",
        "bingx",
        "1D",
        utc_seconds(2026, 11, 7, 12, 0),
    )
    case(
        "a12_bingx_1d_boundary",
        "BingX 1D: 16:00 UTC exacto no se mueve",
        "bingx",
        "1D",
        utc_seconds(2026, 11, 7, 16, 0),
    )

    return cases


def build_fixture() -> dict[str, Any]:
    return {
        "alignment": {"cases": build_alignment_cases()},
        "metadata": {
            "generator": "tools/gen_data_layer_fixture.py",
            "command": "python tools/gen_data_layer_fixture.py",
            "method": (
                "Referencia independiente en Python, explícita, sin importar "
                "el código TypeScript. Valida, convierte ms->s, ordena, detecta "
                "huecos sin rellenar y reporta descartes. BingX nunca expone vw. "
                "El cargador se simula con respuestas HTTP grabadas y un reloj "
                "determinista en segundos UTC."
            ),
            "tolerance": (
                "Exacta para tiempos, precios, volúmenes, contadores y banderas; "
                "los valores se copian del JSON crudo sin aritmética."
            ),
            "discardOrder": list(DISCARD_CAUSES),
            "nonFiniteEncoding": (
                "Las entradas usan null o cadenas como \"NaN\"/\"Infinity\" "
                "para representar valores no finitos."
            ),
            "bingxVwDecision": (
                "vwExposed=false: la muestra real de 1m tuvo 185/3445 barras "
                "fuera de [low, high], así que quoteVolume/volume no se usa."
            ),
        },
        "normalizers": {
            "massive": {"cases": build_massive_cases()},
            "bingx": {"cases": build_bingx_cases()},
        },
        "loaders": {
            "massive": {"cases": build_massive_loader_cases()},
            "bingx": {"cases": build_bingx_loader_cases()},
            "validation": {"cases": build_loader_validation_cases()},
        },
    }


def main() -> None:
    print("Generando fixture independiente de la capa de datos...")
    fixture = build_fixture()

    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(FIXTURE_PATH, "w", encoding="utf-8") as file:
        json.dump(
            fixture,
            file,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        file.write("\n")

    print(f"Fixture generado exitosamente en: {FIXTURE_PATH}")
    print(
        f"  - alignment: {len(fixture['alignment']['cases'])} casos"
    )
    for provider, section in fixture["normalizers"].items():
        print(f"  - {provider}: {len(section['cases'])} casos")
    for provider, section in fixture["loaders"].items():
        print(f"  - loaders/{provider}: {len(section['cases'])} casos")
    print(f"Tamaño: {FIXTURE_PATH.stat().st_size} bytes")


if __name__ == "__main__":
    main()
