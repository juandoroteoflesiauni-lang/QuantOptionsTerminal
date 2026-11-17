#!/usr/bin/env python3
"""ASP.NET Core SignalR connector for `hub.bullmarketbrokers.com/stock-prices-hub`.

Live 5-level BYMA order books (`SendPrices`) for the Quant Options Terminal,
served through the same local bridge contract as the pyhomebroker flow
(`/health`, `/snapshot`, `127.0.0.1` only) plus JSONL events on stdout
(`{"event":"L2_UPDATE","record":{...}}`) for live consumption by
`bmbFeedAdapter.ts`.

Connection flow (single attempt, no automatic retry loops):
1. `hub_token` resolution:
   - `BMB_HUB_TOKEN` from `os.environ` when defined;
   - otherwise, with `BMB_SESSION_COOKIE`, GET
     `https://inversiones.bullmarket.com.ar/Cotizaciones` with the cookie and a
     modern Chrome User-Agent, extracting the UUID from
     `stock-prices-hub?token=([0-9a-fA-F-]+)` in the returned HTML/scripts.
   - Login redirect, HTTP 401/403, or missing token -> explicit `STANDBY_2FA`.
2. Negotiate: POST `https://hub.bullmarketbrokers.com/stock-prices-hub/negotiate?token=<hub_token>&negotiateVersion=1`
   with `Origin: https://inversiones.bullmarket.com.ar` and a Chrome User-Agent,
   reading `connectionToken` (or `connectionId`). HTTP 401/403 -> `STANDBY_2FA`.
3. WebSocket `wss://hub.bullmarketbrokers.com/stock-prices-hub?token=<hub_token>&id=<connection_token>`
   sending `Origin: https://inversiones.bullmarket.com.ar`; ASP.NET Core
   handshake `{"protocol":"json","version":1}\x1e` validated against `{}\x1e`;
   every server ping `{"type":6}\x1e` is answered with `{"type":6}\x1e`.
4. Frames: `\x1e`-delimited JSON. `SendPrices` arguments are mapped to the
   terminal L2 records (ticker, term `1`->CI / `2`->24hs, currency, date,
   `stockState` fields, `stockOffer` bidTop/askTop ordered by `position` 1..5);
   `SendIndexes` and `SendMarketTotals` are counted without error.

Security / Zero Silent Fallbacks:
- `BMB_HUB_TOKEN`, `BMB_SESSION_COOKIE`, `connectionToken`/`id` are credentials:
  they are never logged, printed, or echoed; every error message passes through
  `redact_hub_query_credentials` (strips `?token=`/`?id=` values) and
  `redact_secrets` (env secrets) before being stored.
- No simulated data: only genuinely received frames produce records.
"""

from __future__ import annotations

from datetime import datetime, timezone
from http.server import ThreadingHTTPServer
import argparse
import json
import math
import os
import re
import signal
import threading
from typing import Any
from urllib.parse import quote

from bmb_homebroker_bridge import (
    BMB_BROWSER_USER_AGENT,
    BMB_STANDBY_2FA_MESSAGE,
    BMB_STANDBY_2FA_STATUS,
    BmbBridgeState,
    finite_num,
    redact_secrets,
)

try:
    import requests as rq

    REQUESTS_AVAILABLE = True
except ImportError:  # pragma: no cover - requests ships with pyhomebroker
    rq = None  # type: ignore[assignment]
    REQUESTS_AVAILABLE = False

try:
    import websocket
    from websocket import WebSocketTimeoutException

    WEBSOCKET_CLIENT_AVAILABLE = True
except ImportError:  # pragma: no cover - opcional
    websocket = None  # type: ignore[assignment]
    WebSocketTimeoutException = Exception  # type: ignore[assignment,misc]
    WEBSOCKET_CLIENT_AVAILABLE = False

try:
    # Fallback: cliente síncrono de `websockets` (v11+), ya instalado en producción.
    from websockets.sync.client import connect as websockets_sync_connect
    from websockets.exceptions import ConnectionClosed as WebsocketsConnectionClosed

    WEBSOCKETS_SYNC_AVAILABLE = True
except ImportError:  # pragma: no cover - opcional
    websockets_sync_connect = None  # type: ignore[assignment]
    WebsocketsConnectionClosed = Exception  # type: ignore[assignment,misc]
    WEBSOCKETS_SYNC_AVAILABLE = False

HUB_BASE = "https://hub.bullmarketbrokers.com"
HUB_NAME = "stock-prices-hub"
PORTAL_ORIGIN = "https://inversiones.bullmarket.com.ar"
PORTAL_COTIZACIONES_URL = f"{PORTAL_ORIGIN}/Cotizaciones"
RECORD_SEPARATOR = "\x1e"
HUB_TOKEN_PATTERN = re.compile(r"stock-prices-hub\?token=([0-9a-fA-F-]+)")
HUB_TOKEN_GENERIC_QUERY_RE = re.compile(
    r"[?&]token=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"
)
HUB_TOKEN_INLINE_JS_RE = re.compile(
    r"[\"']?token[\"']?\s*[:=]\s*[\"']([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})[\"']",
    re.IGNORECASE,
)
UUID_TOKEN_RE = re.compile(
    r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"
)
HUB_QUERY_SECRET_RE = re.compile(r"([?&])(token|id)=[^&\s\"']+")
WS_STATUS_RE = re.compile(r"status[:\s]*(\d{3})", re.IGNORECASE)
LOGIN_REDIRECT_MARKERS = ("login", "ingresar", "acceso", "twofactor", "verifycode")
PORTAL_TIMEOUT_SEC = 10.0
NEGOTIATE_TIMEOUT_SEC = 10.0
STREAM_RECV_TIMEOUT_SEC = 10.0
NO_CREDENTIALS_ERROR = (
    "BMB_HUB_TOKEN o BMB_SESSION_COOKIE ausentes: el conector SignalR Core no puede autenticar"
)


# ---------------------------------------------------------------------------
# Pure helpers (verified against fixtures/bmb_inversiones_sendprices.json)
# ---------------------------------------------------------------------------

def extract_hub_token_from_html(html: str) -> str:
    """Extrae el UUID del hub_token desde el HTML/scripts de `/Cotizaciones`.

    Cascada explícita:
    1. `stock-prices-hub?token=<uuid>` (patrón canónico del hub);
    2. cualquier query string `?token=<uuid>`/`&token=<uuid>` (UUID canónico);
    3. token SignalR inline en HTML/JS (`"token": "<uuid>"` / `token=<uuid>`).
    """
    haystack = html or ""
    for pattern in (HUB_TOKEN_PATTERN, HUB_TOKEN_GENERIC_QUERY_RE, HUB_TOKEN_INLINE_JS_RE):
        match = pattern.search(haystack)
        if match:
            return match.group(1)
    return ""


def classify_portal_response(status_code: int | None, final_url: str) -> str:
    """`OK` tras cargar `/Cotizaciones`; `STANDBY_2FA` ante 401/403 o redirección
    a login; `PORTAL_ERROR` ante cualquier otro fallo HTTP."""
    if status_code is not None and status_code in (401, 403):
        return BMB_STANDBY_2FA_STATUS
    compact = re.sub(r"[\s_\-/]", "", (final_url or "")).lower()
    if any(marker in compact for marker in LOGIN_REDIRECT_MARKERS):
        return BMB_STANDBY_2FA_STATUS
    if status_code is not None and status_code >= 400:
        return "PORTAL_ERROR"
    return "OK"


def redact_hub_query_credentials(text: str) -> str:
    """Elimina los valores de `?token=`/`?id=` de cualquier texto diagnóstico."""
    return HUB_QUERY_SECRET_RE.sub(
        lambda match: f"{match.group(1)}{match.group(2)}=[REDACTED]", text or ""
    )


def build_negotiate_url(hub_token: str) -> str:
    return (
        f"{HUB_BASE}/{HUB_NAME}/negotiate"
        f"?token={quote(hub_token, safe='')}&negotiateVersion=1"
    )


def build_ws_url(hub_token: str, connection_token: str) -> str:
    return (
        f"wss://hub.bullmarketbrokers.com/{HUB_NAME}"
        f"?token={quote(hub_token, safe='')}&id={quote(connection_token, safe='')}"
    )


def build_negotiate_headers() -> dict[str, str]:
    return {
        "Origin": PORTAL_ORIGIN,
        "User-Agent": BMB_BROWSER_USER_AGENT,
        "Content-Type": "application/json",
        "Content-Length": "0",
        "Accept": "application/json",
    }


def build_ws_headers() -> dict[str, str]:
    return {
        "Origin": PORTAL_ORIGIN,
        "User-Agent": BMB_BROWSER_USER_AGENT,
    }


def parse_negotiate_response(body: str) -> str:
    """Extrae `connectionToken` (o `connectionId` en versiones viejas)."""
    try:
        parsed = json.loads(body or "{}")
    except ValueError:
        return ""
    if not isinstance(parsed, dict):
        return ""
    for key in ("connectionToken", "connectionId"):
        value = parsed.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def build_handshake_frame() -> str:
    return '{"protocol":"json","version":1}' + RECORD_SEPARATOR


def handshake_payload_ok(payload: str) -> bool:
    """Valida la respuesta del handshake ASP.NET Core: `{}\x1e` -> ok; un objeto
    con `error` o basura no-JSON -> inválido."""
    text = (payload or "").strip()
    if not text:
        return False
    try:
        parsed = json.loads(text)
    except ValueError:
        return False
    if not isinstance(parsed, dict):
        return False
    return "error" not in parsed


def is_ping_message(payload: dict[str, Any]) -> bool:
    return payload.get("type") == 6


def ping_reply_frame() -> str:
    return '{"type":6}' + RECORD_SEPARATOR


def extract_signalr_frames(buffer: str, chunk: str) -> tuple[list[str], str]:
    """Separa frames `\x1e`-delimited soportando múltiples frames por chunk y
    frames fragmentados: el remanente sin delimitador vuelve como nuevo buffer."""
    data = (buffer or "") + (chunk or "")
    parts = data.split(RECORD_SEPARATOR)
    remainder = parts.pop()
    return [part for part in parts if part != ""], remainder


def parse_signalr_message(frame: str) -> dict[str, Any] | None:
    try:
        parsed = json.loads(frame)
    except (TypeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


def classify_ws_handshake_error(message: str) -> str:
    """`STANDBY_2FA` si el handshake WS falló con 401/403; `ERROR` en otro caso."""
    match = WS_STATUS_RE.search(message or "")
    status = int(match.group(1)) if match else None
    return BMB_STANDBY_2FA_STATUS if status in (401, 403) else "ERROR"


def map_signalr_term(term: Any) -> str:
    """`"1"` -> CI, `"2"` -> 24hs; cualquier otro plazo no es mapeable."""
    text = str(term or "").strip()
    if text == "1":
        return "CI"
    if text == "2":
        return "24hs"
    return ""


def map_hub_currency(value: Any) -> str:
    text = str(value or "").strip().upper()
    return text if text in {"ARS", "USD"} else ""


def parse_hub_datetime(value: Any) -> int | None:
    """Epoch segundos/milisegundos o ISO-8601 (`Z` u offset explícito); una fecha
    sin zona horaria se interpreta como UTC explícitamente."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        if not math.isfinite(number) or number <= 0:
            return None
        return int(number / 1000) if number > 10_000_000_000 else int(number)
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp())


def _first(row: dict[str, Any], names: tuple[str, ...]) -> Any:
    for name in names:
        if name in row and row[name] is not None:
            return row[name]
    return None


def map_offer_side(rows: Any) -> list[dict[str, Any]]:
    """Ordena una punta (`bidTop`/`askTop`) por `position` 1..5 y produce los
    niveles del DTO L2 (`price`, `size`, `orderCount: None`)."""
    if not isinstance(rows, list):
        return []
    entries: list[tuple[int, dict[str, Any]]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        position = row.get("position")
        price = finite_num(row.get("price"))
        quantity = finite_num(row.get("quantity"))
        if isinstance(position, bool) or not isinstance(position, (int, float)):
            continue
        pos = int(position)
        if pos < 1 or pos > 5:
            continue
        if price is None or price <= 0 or quantity is None or quantity < 0:
            continue
        entries.append((pos, {"price": price, "size": quantity, "orderCount": None}))
    entries.sort(key=lambda item: item[0])
    return [level for _position, level in entries]


def map_sendprices_row(row: Any) -> dict[str, Any] | None:
    """Mapea una fila `SendPrices` al registro L2 del bridge (ticker, plazo,
    moneda, fecha, `stockState` y `stockOffer`). Devuelve None si la fila no es
    mapeable (sin ticker, plazo desconocido o sin ningún dato)."""
    if not isinstance(row, dict):
        return None
    ticker = str(_first(row, ("ticker", "symbol", "Ticker")) or "").strip().upper()
    if not ticker:
        return None
    settlement = map_signalr_term(_first(row, ("term", "settlement")))
    if not settlement:
        return None
    currency = map_hub_currency(_first(row, ("currency", "moneda")))
    state = row.get("stockState") if isinstance(row.get("stockState"), dict) else row
    offer = row.get("stockOffer") if isinstance(row.get("stockOffer"), dict) else row
    bids = map_offer_side(offer.get("bidTop"))
    asks = map_offer_side(offer.get("askTop"))
    last = finite_num(_first(state, ("price", "last")))
    if last is None and not bids and not asks:
        return None
    return {
        "symbol": ticker,
        "settlement": settlement,
        "currency": currency,
        "asOfUtcSec": parse_hub_datetime(_first(row, ("date", "datetime", "timestamp"))),
        "last": last,
        "open": finite_num(state.get("open")),
        "min": finite_num(state.get("min")),
        "max": finite_num(state.get("max")),
        "close": finite_num(state.get("close")),
        "variation": finite_num(state.get("variation")),
        "totalNominalValue": finite_num(state.get("totalNominalValue")),
        "totalAmount": finite_num(state.get("totalAmount")),
        "operations": finite_num(state.get("operations")),
        "bids": bids,
        "asks": asks,
        "source": "BMB_HOMEBROKER",
    }


def map_sendprices_rows(rows: Any) -> list[dict[str, Any]]:
    if not isinstance(rows, list):
        return []
    mapped: list[dict[str, Any]] = []
    for row in rows:
        record = map_sendprices_row(row)
        if record is not None:
            mapped.append(record)
    return mapped


# ---------------------------------------------------------------------------
# Default transports (injectable for offline tests)
# ---------------------------------------------------------------------------

def default_fetch_html(url: str, cookie_header: str) -> tuple[int | None, str, str]:
    """GET del portal con la cookie de dispositivo de confianza y UA Chrome."""
    response = rq.get(  # type: ignore[union-attr]
        url,
        headers={
            "Cookie": cookie_header,
            "User-Agent": BMB_BROWSER_USER_AGENT,
            "Accept": "text/html,application/xhtml+xml",
        },
        timeout=PORTAL_TIMEOUT_SEC,
        allow_redirects=True,
    )
    return response.status_code, response.url, response.text


def default_post_negotiate(url: str, headers: dict[str, str]) -> tuple[int | None, str]:
    response = rq.post(  # type: ignore[union-attr]
        url, headers={**headers, "Content-Length": "0"}, timeout=NEGOTIATE_TIMEOUT_SEC
    )
    return response.status_code, response.text


class _WebsocketsSyncAdapter:
    """Adaptador síncrono mínimo sobre `websockets.sync.client` con la misma
    superficie que `websocket-client` (`send`, `recv`, `close`)."""

    def __init__(self, url: str, headers: dict[str, str]) -> None:
        self._connection = websockets_sync_connect(  # type: ignore[union-attr]
            url,
            additional_headers=headers,
            open_timeout=STREAM_RECV_TIMEOUT_SEC,
        )

    def send(self, message: str) -> None:
        self._connection.send(message)

    def recv(self) -> str:
        return str(self._connection.recv(timeout=STREAM_RECV_TIMEOUT_SEC))

    def close(self) -> None:
        self._connection.close()


def default_ws_factory(url: str, headers: dict[str, str]) -> Any:
    """websocket-client es el transporte primario (instalado junto a
    pyhomebroker); `websockets.sync` es el fallback explícito."""
    if WEBSOCKET_CLIENT_AVAILABLE:
        header_list = [f"{key}: {value}" for key, value in headers.items()]
        return websocket.create_connection(  # type: ignore[union-attr]
            url, header=header_list, timeout=STREAM_RECV_TIMEOUT_SEC
        )
    if WEBSOCKETS_SYNC_AVAILABLE:
        return _WebsocketsSyncAdapter(url, headers)
    raise RuntimeError("Sin transporte WebSocket disponible (websocket-client/websockets)")


# ---------------------------------------------------------------------------
# Connector + bridge state
# ---------------------------------------------------------------------------

class InversionesSignalRState(BmbBridgeState):
    """Estado del bridge alimentado por el stream SignalR Core (5 puntas L2)."""

    def __init__(self, cfg: dict[str, Any], connector_deps: dict[str, Any] | None = None) -> None:
        super().__init__(cfg)
        self._stop_event = threading.Event()
        self._send_prices_updates = 0
        self._send_indexes_count = 0
        self._send_market_totals_count = 0
        self._pings_replied = 0
        self._negotiate_count = 0
        self._reconnect_lock = threading.Lock()
        self._connector_thread: threading.Thread | None = None
        self._connector_deps = dict(connector_deps or {})
        # El emitter inyectado aplica desde el estado (incluye rutas tempranas
        # como `set_connector_error` sin conector construido).
        if "emitter" in self._connector_deps:
            self._emitter = self._connector_deps["emitter"]
        self._last_emitted_status: str | None = None

    def _initial_status(self) -> str:
        if not REQUESTS_AVAILABLE or not (WEBSOCKET_CLIENT_AVAILABLE or WEBSOCKETS_SYNC_AVAILABLE):
            return "MISSING_DEPENDENCY"
        if not self._cfg["hub_token"] and not self._cfg["session_cookie"]:
            return "ERROR"
        return "DISCONNECTED"

    def _emit_status_change(self) -> None:
        """Publica por stdout JSONL cada cambio de estado, al instante. Nunca
        deja al bridge colgado en CONNECTING sin reporte."""
        with self._lock:
            status = self._status
            if status == self._last_emitted_status:
                return
            self._last_emitted_status = status
        self._emit_jsonl({"event": "STATUS", "status": status})

    def mark_connecting(self) -> None:
        with self._lock:
            self._connected = False
            self._status = "CONNECTING"
        self._emit_status_change()

    def mark_stream_open(self) -> None:
        """Handshake WS completo: el stream está abierto aunque aún no lleguen
        frames. Nunca permanecer en CONNECTING esperando datos."""
        with self._lock:
            self._connected = True
            self._status = "READY"
            self._error = None
        self._emit_status_change()

    def set_connector_standby_2fa(self) -> None:
        with self._lock:
            self._connected = False
            self._status = BMB_STANDBY_2FA_STATUS
            self._error = BMB_STANDBY_2FA_MESSAGE
        self._emit_status_change()

    def set_connector_error(self, message: str) -> None:
        safe = redact_secrets(redact_hub_query_credentials(str(message)), self._cfg["secrets"])
        with self._lock:
            self._connected = False
            self._status = "ERROR"
            self._error = safe
        self._emit_status_change()

    def count_target(self, target: str) -> None:
        with self._lock:
            if target == "SendIndexes":
                self._send_indexes_count += 1
            elif target == "SendMarketTotals":
                self._send_market_totals_count += 1

    def count_ping(self) -> None:
        with self._lock:
            self._pings_replied += 1

    def count_negotiate(self) -> None:
        with self._lock:
            self._negotiate_count += 1

    def _emit_jsonl(self, payload: dict[str, Any]) -> None:
        emitter = getattr(self, "_emitter", None)
        if emitter is None:
            emitter = self._print_jsonl
        try:
            emitter(payload)
        except Exception:
            # La salida JSONL es best-effort: nunca rompe el stream por I/O.
            pass

    def _print_jsonl(self, payload: dict[str, Any]) -> None:
        print(json.dumps(payload, ensure_ascii=False, allow_nan=False), flush=True)

    def ingest_connector_records(self, records: list[dict[str, Any]]) -> None:
        stored = self.ingest_l2_records(records)
        if stored <= 0:
            return
        with self._lock:
            self._send_prices_updates += stored
        for record in records:
            if record.get("settlement") == "24hs":
                self._emit_jsonl({"event": "L2_UPDATE", "record": record})
        self._emit_status_change()

    def stop(self) -> None:
        self._stop_event.set()
        super().stop()

    def start(self) -> None:
        if self._status == "MISSING_DEPENDENCY":
            return
        if not self._cfg["hub_token"] and not self._cfg["session_cookie"]:
            self.set_connector_error(NO_CREDENTIALS_ERROR)
            return
        self._connector_thread = threading.current_thread()
        # El conector se construye ANTES de marcar CONNECTING para que la
        # emisión JSONL del cambio de estado use el emitter inyectado.
        connector = InversionesSignalRConnector(self, self._cfg, **self._connector_deps)
        self.mark_connecting()
        try:
            connector.run()
        except Exception as exc:
            self.set_connector_error(
                f"SignalR connector error: {redact_hub_query_credentials(str(exc))}"
            )
        finally:
            with self._lock:
                if self._status in {"CONNECTING", "READY", "CONNECTED_L2"}:
                    self._status = "DISCONNECTED"
                    self._connected = False
            self._emit_status_change()

    def request_reconnect(self) -> None:
        """Reinicio único iniciado por el usuario (POST /reconnect); sin bucles."""
        with self._reconnect_lock:
            previous = self._connector_thread
            if (
                previous is not None
                and previous.is_alive()
                and previous is not threading.current_thread()
            ):
                self._stop_event.set()
                previous.join(timeout=5.0)
            self._stop_event.clear()
            with self._lock:
                self._status = "CONNECTING"
            thread = threading.Thread(target=self.start, daemon=True)
            self._connector_thread = thread
            thread.start()

    def get_health(self) -> dict[str, Any]:
        health = super().get_health()
        with self._lock:
            health["ok"] = health["status"] in {"READY", "CONNECTED_L2"}
            health["connector"] = "SIGNALR_CORE"
            health["telemetry"] = {
                "sendPricesUpdates": self._send_prices_updates,
                "sendIndexes": self._send_indexes_count,
                "sendMarketTotals": self._send_market_totals_count,
                "pingsReplied": self._pings_replied,
                "negotiateCount": self._negotiate_count,
            }
            return health


class InversionesSignalRConnector:
    """Conector SignalR Core de un solo intento (sin bucles de reintento)."""

    def __init__(
        self,
        state: InversionesSignalRState,
        cfg: dict[str, Any],
        fetch_html: Any = None,
        post_negotiate: Any = None,
        ws_factory: Any = None,
        emitter: Any = None,
    ) -> None:
        self._state = state
        self._cfg = cfg
        self._fetch_html = fetch_html or default_fetch_html
        self._post_negotiate = post_negotiate or default_post_negotiate
        self._ws_factory = ws_factory or default_ws_factory
        if emitter is not None:
            self._state._emitter = emitter

    # -- hub_token ----------------------------------------------------------

    def resolve_hub_token(self) -> tuple[str, str]:
        """Prioridad: `BMB_HUB_TOKEN` directo; si no, scrape de `/Cotizaciones`
        con la cookie. Fallo de autenticación/scraper -> `STANDBY_2FA`."""
        direct = str(self._cfg.get("hub_token") or "").strip()
        if direct:
            return direct, "OK"
        cookie = str(self._cfg.get("session_cookie") or "").strip()
        if not cookie:
            return "", BMB_STANDBY_2FA_STATUS
        try:
            status_code, final_url, html = self._fetch_html(PORTAL_COTIZACIONES_URL, cookie)
        except Exception as exc:
            self._state.set_connector_error(f"SignalR portal error: {redact_hub_query_credentials(str(exc))}")
            return "", "PORTAL_ERROR"
        classification = classify_portal_response(status_code, final_url)
        if classification != "OK":
            return "", classification
        token = extract_hub_token_from_html(html)
        if not token:
            return "", BMB_STANDBY_2FA_STATUS
        return token, "OK"

    # -- negotiate ----------------------------------------------------------

    def negotiate(self, hub_token: str) -> str | None:
        url = build_negotiate_url(hub_token)
        try:
            status_code, body = self._post_negotiate(url, build_negotiate_headers())
        except Exception as exc:
            self._state.set_connector_error(
                f"SignalR negotiate error: {redact_hub_query_credentials(str(exc))}"
            )
            return None
        if status_code in (401, 403):
            self._state.set_connector_standby_2fa()
            return None
        if status_code != 200:
            self._state.set_connector_error(
                f"SignalR negotiate HTTP {status_code}: {redact_hub_query_credentials(url)}"
            )
            return None
        connection_token = parse_negotiate_response(body)
        if not connection_token:
            self._state.set_connector_error("SignalR negotiate sin connectionToken/connectionId")
            return None
        self._state.count_negotiate()
        return connection_token

    # -- websocket ----------------------------------------------------------

    def open_stream(self, hub_token: str, connection_token: str) -> Any | None:
        url = build_ws_url(hub_token, connection_token)
        try:
            ws = self._ws_factory(url, build_ws_headers())
        except Exception as exc:
            self._classify_ws_error(exc)
            return None
        try:
            ws.send(build_handshake_frame())
            reply = ws.recv()
        except Exception as exc:
            self._classify_ws_error(exc)
            self._close_quietly(ws)
            return None
        frames, _remainder = extract_signalr_frames("", str(reply or ""))
        if not any(handshake_payload_ok(frame) for frame in frames):
            self._state.set_connector_error("SignalR handshake inválido")
            self._close_quietly(ws)
            return None
        # Handshake completo: el stream está abierto. Transición inmediata a
        # READY (aún sin datos) para no quedar colgado en CONNECTING.
        self._state.mark_stream_open()
        return ws

    def _classify_ws_error(self, exc: Exception) -> None:
        if classify_ws_handshake_error(str(exc)) == BMB_STANDBY_2FA_STATUS:
            self._state.set_connector_standby_2fa()
        else:
            self._state.set_connector_error(
                f"SignalR ws error: {redact_hub_query_credentials(str(exc))}"
            )

    @staticmethod
    def _close_quietly(ws: Any) -> None:
        try:
            ws.close()
        except Exception:
            pass

    # -- frames -------------------------------------------------------------

    def dispatch(self, frame: str, ws: Any) -> None:
        payload = parse_signalr_message(frame)
        if payload is None:
            return
        if is_ping_message(payload):
            try:
                ws.send(ping_reply_frame())
            except Exception:
                return
            self._state.count_ping()
            return
        target = payload.get("target")
        if payload.get("type") == 1 and target == "SendPrices":
            arguments = payload.get("arguments")
            rows = (
                arguments[0]
                if isinstance(arguments, list) and arguments and isinstance(arguments[0], list)
                else []
            )
            self._state.ingest_connector_records(map_sendprices_rows(rows))
        elif payload.get("type") == 1 and target == "SendIndexes":
            self._state.count_target("SendIndexes")
        elif payload.get("type") == 1 and target == "SendMarketTotals":
            self._state.count_target("SendMarketTotals")

    def read_loop(self, ws: Any) -> None:
        buffer = ""
        stop_event = self._state._stop_event
        while not stop_event.is_set():
            try:
                raw = ws.recv()
            except Exception as exc:
                if stop_event.is_set():
                    return
                if WEBSOCKET_CLIENT_AVAILABLE and isinstance(exc, WebSocketTimeoutException):
                    continue
                if WEBSOCKETS_SYNC_AVAILABLE and isinstance(exc, TimeoutError):
                    # `websockets.sync` señala recv-timeout con TimeoutError.
                    continue
                self._classify_ws_error(exc)
                return
            if raw is None or raw == "":
                continue
            frames, buffer = extract_signalr_frames(buffer, str(raw))
            for frame in frames:
                self.dispatch(frame, ws)

    # -- orchestration ------------------------------------------------------

    def run(self) -> None:
        hub_token, resolution_status = self.resolve_hub_token()
        if not hub_token:
            if resolution_status == BMB_STANDBY_2FA_STATUS:
                self._state.set_connector_standby_2fa()
            elif resolution_status == "OK":
                self._state.set_connector_error("SignalR hub_token no resoluble")
            # Otros estados (p. ej. PORTAL_ERROR) ya registraron su error específico.
            return
        connection_token = self.negotiate(hub_token)
        if connection_token is None:
            return
        ws = self.open_stream(hub_token, connection_token)
        if ws is None:
            return
        try:
            self.read_loop(ws)
        finally:
            self._close_quietly(ws)


# ---------------------------------------------------------------------------
# CLI / HTTP bridge (mismo contrato local que el bridge pyhomebroker)
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description="BMB stock-prices-hub SignalR Core bridge")
    parser.add_argument("--check-status", action="store_true")
    parser.add_argument("--host")
    parser.add_argument("--port", type=int)
    args = parser.parse_args()

    from bmb_bridge import read_bmb_config

    cfg = read_bmb_config(os.environ)
    host = (args.host or cfg["host"]).strip()
    port = int(args.port or cfg["port"])
    if host not in {"127.0.0.1", "localhost", "::1"}:
        raise SystemExit("BMB bridge must bind to loopback")
    state = InversionesSignalRState(cfg)
    if args.check_status:
        print(json.dumps(state.get_health(), ensure_ascii=False, allow_nan=False))
        return 0

    from bmb_homebroker_bridge import create_handler as base_create_handler

    server = ThreadingHTTPServer((host, port), base_create_handler(state))

    def shutdown(_signum: int, _frame: Any) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, shutdown)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, shutdown)

    # Evento de readiness machine-readable, sin datos de cuenta ni credenciales.
    print(
        json.dumps({"event": "LISTENING", "host": host, "port": port, "connector": "SIGNALR_CORE"}),
        flush=True,
    )
    threading.Thread(target=state.start, daemon=True).start()
    try:
        server.serve_forever()
    finally:
        state.stop()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
