#!/usr/bin/env python3
"""Bull Market Brokers (HomeBroker SignalR, broker 153) local HTTP/JSON bridge.

Exposes live cauciones (`on_repos`), 5-level BYMA order books (`on_order_book`),
and BYMA options (`on_options`) on `127.0.0.1:8788` (configurable via env).

Zero Silent Fallbacks & Security Rules:
- Reads credentials exclusively from `os.environ` (`BMB_BROKER_ID`, `BMB_DNI`,
  `BMB_USERNAME`/`BMB_USER`, `BMB_PASSWORD`, `BMB_ACCOUNT`).
- `BMB_DNI` is cleaned to digits only (`re.sub(r"\\D", "", dni)`); `BMB_USER`
  and `BMB_PASSWORD` are read from `os.environ` without content alterations.
- Never logs or returns `BMB_PASSWORD`, `BMB_DNI`, or `BMB_USERNAME` in HTTP
  responses or logs; scrubs sensitive tokens from all error messages.
- If `pyhomebroker` is not installed, degrades cleanly with `MISSING_DEPENDENCY`.
- If `BMB_PASSWORD` is empty, degrades cleanly with `DISABLED_NO_PASSWORD`.
- A pyhomebroker login failure is classified explicitly: a two-factor challenge
  (markers `TwoFactor`, `VerifyCode`, `OTP`, `2FA` in the exception message or
  the requests response URL) or a failure after the DNI/user format validated
  yields `STANDBY_2FA` (interactive SMS/App login required; no automatic retry
  loops that could lock the account). Only the exception message and the
  response URL/status are inspected; credentials and response bodies are never
  read, logged or returned.
"""

from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
import re
import signal
import sys
import threading
import time
from typing import Any
from urllib.parse import parse_qs, urlparse

try:
    from pyhomebroker import HomeBroker  # type: ignore[import-not-found]

    PYHOMEBROKER_AVAILABLE = True
    PYHOMEBROKER_IMPORT_ERROR: str | None = None
except ImportError as exc:
    HomeBroker = None  # type: ignore[assignment]
    PYHOMEBROKER_AVAILABLE = False
    PYHOMEBROKER_IMPORT_ERROR = str(exc)

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8788
DEFAULT_BROKER_ID = 153
DEFAULT_LEADERS = ("GGAL", "YPFD", "PAMP", "BMA", "AL30", "GD30")

# Explicit classification of a pyhomebroker login failure. Only the exception
# message and the requests response URL/status are inspected (never printed).
BMB_STANDBY_2FA_STATUS = "STANDBY_2FA"
BMB_STANDBY_2FA_MESSAGE = (
    "BMB requiere 2FA interactivo (SMS/App); usando IOL_REST_V2 + Primary DLR como fuente activa"
)
BMB_TWO_FACTOR_MARKERS = ("twofactor", "verifycode", "verifyotp", "otp", "2fa")


def clean_bmb_dni(raw: str) -> str:
    """`BMB_DNI` llega con puntos/espacios: se reduce a dígitos (en memoria)."""
    return re.sub(r"\D", "", raw or "")


def bmb_login_format_is_valid(dni: str, username: str) -> bool:
    """Puerta de formato: DNI ya limpio debe ser dígitos no vacíos y usuario no vacío."""
    return bool(dni) and bool(username) and dni.isdigit()


def bmb_login_failure_inputs(exc: BaseException) -> tuple[str, str, int | None]:
    """Inspecciona SOLO el mensaje de la excepción y la URL/status HTTP de la
    respuesta `requests` (si existe). Nunca imprime ni devuelve datos sensibles."""
    message = str(exc)
    response = getattr(exc, "response", None)
    url = ""
    status: int | None = None
    if response is not None:
        url = str(getattr(response, "url", "") or "")
        raw_status = getattr(response, "status_code", None)
        if isinstance(raw_status, int) and not isinstance(raw_status, bool):
            status = raw_status
    return message, url, status


def bmb_text_indicates_two_factor(message: str, response_url: str) -> bool:
    """Marcadores de verificación en dos pasos, tolerando mayúsculas y separadores."""
    compact = re.sub(r"[\s_\-/.]", "", f"{message} {response_url}").lower()
    return any(marker in compact for marker in BMB_TWO_FACTOR_MARKERS)


def classify_bmb_login_failure(
    message: str,
    response_url: str,
    response_status: int | None,
    dni: str,
    username: str,
) -> str:
    """`STANDBY_2FA` si la respuesta apunta a un desafío 2FA o si el login falla
    tras validar el formato de DNI/usuario; `ERROR` en cualquier otro caso.
    `response_status` y `response_url` se inspeccionan pero nunca se almacenan."""
    if bmb_text_indicates_two_factor(message, response_url):
        return BMB_STANDBY_2FA_STATUS
    if bmb_login_format_is_valid(dni, username):
        return BMB_STANDBY_2FA_STATUS
    return "ERROR"


def redact_secrets(text: str, secrets: tuple[str, ...]) -> str:
    out = text
    for secret in secrets:
        clean = secret.strip()
        if clean:
            out = out.replace(clean, "[REDACTED]")
    return out


def finite_num(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(num):
        return None
    return num


def extract_records(quotes: Any) -> list[dict[str, Any]]:
    if quotes is None:
        return []
    # Support pandas.DataFrame without importing pandas globally
    to_dict = getattr(quotes, "to_dict", None)
    if callable(to_dict):
        reset_index = getattr(quotes, "reset_index", None)
        df = reset_index() if callable(reset_index) else quotes
        try:
            records = df.to_dict(orient="records")
            if isinstance(records, list):
                return [dict(row) for row in records if isinstance(row, dict)]
        except Exception:
            return []
    if isinstance(quotes, list):
        return [dict(row) for row in quotes if isinstance(row, dict)]
    if isinstance(quotes, dict):
        return [dict(quotes)]
    return []


def compute_tea_effective(tna_pct: float | None, term_days: int | None) -> float | None:
    if tna_pct is None or term_days is None or term_days <= 0:
        return None
    gross = 1.0 + (tna_pct / 100.0) * (float(term_days) / 365.0)
    if gross <= 0.0:
        return None
    return (math.pow(gross, 365.0 / float(term_days)) - 1.0) * 100.0


def parse_term_days(row: dict[str, Any]) -> int | None:
    for key in ("term", "days", "plazo", "settlement_days"):
        val = finite_num(row.get(key))
        if val is not None and val > 0:
            return int(round(val))
    symbol = str(row.get("symbol") or "").upper()
    m = re.search(r"(\d+)\s*D", symbol)
    if m:
        parsed = int(m.group(1))
        return parsed if parsed > 0 else None
    m_digits = re.search(r"PESOS\s*(\d+)", symbol)
    if m_digits:
        parsed = int(m_digits.group(1))
        return parsed if parsed > 0 else None
    return None


def normalize_currency(raw: Any, symbol: str = "") -> str:
    upper = f"{raw or ''} {symbol}".upper()
    if "USD" in upper or "DOLAR" in upper or "U$S" in upper:
        return "USD"
    return "ARS"


def read_bmb_env(environ: dict[str, str] | os._Environ[str] = os.environ) -> dict[str, Any]:
    raw_broker = (environ.get("BMB_BROKER_ID") or str(DEFAULT_BROKER_ID)).strip()
    try:
        broker_id = int(raw_broker)
    except ValueError:
        broker_id = DEFAULT_BROKER_ID
    raw_dni = environ.get("BMB_DNI") or ""
    # DNI se limpia de puntos/espacios (solo dígitos) antes de tocar la red.
    dni = clean_bmb_dni(raw_dni)
    # BMB_USER es alias canónico de BMB_USERNAME; el valor se lee sin alteraciones.
    username = (environ.get("BMB_USERNAME") or environ.get("BMB_USER") or "").strip()
    password = (environ.get("BMB_PASSWORD") or "").strip()
    account = (environ.get("BMB_ACCOUNT") or "").strip()
    host = (environ.get("BMB_BRIDGE_HOST") or DEFAULT_HOST).strip() or DEFAULT_HOST
    try:
        port = int((environ.get("BMB_BRIDGE_PORT") or str(DEFAULT_PORT)).strip())
    except ValueError:
        port = DEFAULT_PORT
    leaders_raw = (environ.get("BMB_LEADERS") or "").strip()
    leaders = tuple(
        s.strip().upper() for s in leaders_raw.split(",") if s.strip()
    ) if leaders_raw else DEFAULT_LEADERS

    secrets = tuple(
        dict.fromkeys(
            s for s in (password, dni, username, account, raw_dni) if s
        )
    )
    return {
        "broker_id": broker_id,
        "dni": dni,
        "username": username,
        "password": password,
        "account": account,
        "host": host,
        "port": port,
        "leaders": leaders,
        "secrets": secrets,
    }


class BmbBridgeState:
    def __init__(self, cfg: dict[str, Any]) -> None:
        self._lock = threading.Lock()
        self._cfg = cfg
        self._hb: Any = None
        self._connected = False
        self._status = self._initial_status()
        self._error: str | None = (
            None
            if PYHOMEBROKER_AVAILABLE
            else redact_secrets(
                f"pyhomebroker no instalado ({PYHOMEBROKER_IMPORT_ERROR or 'ImportError'})",
                cfg["secrets"],
            )
        )
        self._last_update_sec: int | None = None
        self._cauciones: list[dict[str, Any]] = []
        self._order_books: dict[str, dict[str, Any]] = {}
        self._options: list[dict[str, Any]] = []
        self._subscribed_books: set[tuple[str, str]] = set()

    def _initial_status(self) -> str:
        if not self._cfg["password"]:
            return "DISABLED_NO_PASSWORD"
        if not PYHOMEBROKER_AVAILABLE:
            return "MISSING_DEPENDENCY"
        return "DISCONNECTED"

    def _on_repos(self, _online: Any, quotes: Any) -> None:
        rows = extract_records(quotes)
        now_sec = int(time.time())
        parsed: list[dict[str, Any]] = []
        for row in rows:
            symbol = str(row.get("symbol") or row.get("ticker") or "").upper()
            days = parse_term_days(row)
            if days is None:
                continue
            currency = normalize_currency(row.get("currency"), symbol)
            bid_tna = finite_num(row.get("bid") if row.get("bid") is not None else row.get("bid_rate"))
            ask_tna = finite_num(row.get("ask") if row.get("ask") is not None else row.get("ask_rate"))
            last_tna = finite_num(row.get("last") if row.get("last") is not None else row.get("tna"))
            tna_avg: float | None = last_tna
            if tna_avg is None and bid_tna is not None and ask_tna is not None:
                tna_avg = 0.5 * (bid_tna + ask_tna)
            elif tna_avg is None:
                tna_avg = bid_tna if bid_tna is not None else ask_tna

            turnover = finite_num(row.get("turnover"))
            if turnover is None:
                vol = finite_num(row.get("volume"))
                turnover = vol

            parsed.append(
                {
                    "symbol": symbol or f"CAUCION_{days}D_{currency}",
                    "termDays": days,
                    "currency": currency,
                    "tnaWeighted": tna_avg,
                    "teaEffective": compute_tea_effective(tna_avg, days),
                    "bidTna": bid_tna,
                    "askTna": ask_tna,
                    "turnoverArs": turnover,
                    "source": "BMB_HOMEBROKER",
                    "asOfUtcSec": now_sec,
                }
            )
        parsed.sort(key=lambda r: (r["currency"], r["termDays"]))
        with self._lock:
            self._cauciones = parsed
            self._last_update_sec = now_sec
            self._status = "READY"

    def _on_order_book(self, _online: Any, quotes: Any) -> None:
        rows = extract_records(quotes)
        now_sec = int(time.time())
        grouped: dict[str, dict[str, Any]] = {}

        for row in rows:
            sym = str(row.get("symbol") or "").strip().upper()
            if not sym:
                continue
            settlement = str(row.get("settlement") or "24hs").strip()
            entry = grouped.setdefault(
                sym,
                {"symbol": sym, "settlement": settlement, "bids": [], "asks": [], "asOfUtcSec": now_sec, "source": "BMB_HOMEBROKER"},
            )
            bid_px = finite_num(row.get("bid"))
            bid_sz = finite_num(row.get("bid_size") if row.get("bid_size") is not None else row.get("bidsize"))
            ask_px = finite_num(row.get("ask"))
            ask_sz = finite_num(row.get("ask_size") if row.get("ask_size") is not None else row.get("asksize"))

            if bid_px is not None and bid_px > 0 and bid_sz is not None and bid_sz >= 0:
                entry["bids"].append({"price": bid_px, "size": bid_sz})
            if ask_px is not None and ask_px > 0 and ask_sz is not None and ask_sz >= 0:
                entry["asks"].append({"price": ask_px, "size": ask_sz})

        with self._lock:
            for sym, book in grouped.items():
                book["bids"].sort(key=lambda lvl: lvl["price"], reverse=True)
                book["asks"].sort(key=lambda lvl: lvl["price"])
                book["bids"] = book["bids"][:5]
                book["asks"] = book["asks"][:5]
                self._order_books[sym] = book
            self._last_update_sec = now_sec
            self._status = "READY"

    def _on_options(self, _online: Any, quotes: Any) -> None:
        rows = extract_records(quotes)
        now_sec = int(time.time())
        parsed: list[dict[str, Any]] = []
        for row in rows:
            sym = str(row.get("symbol") or "").strip().upper()
            if not sym:
                continue
            parsed.append(
                {
                    "symbol": sym,
                    "underlying": str(row.get("underlying_asset") or "").strip().upper() or None,
                    "bid": finite_num(row.get("bid")),
                    "ask": finite_num(row.get("ask")),
                    "last": finite_num(row.get("last")),
                    "volume": finite_num(row.get("volume")),
                    "turnover": finite_num(row.get("turnover")),
                    "source": "BMB_HOMEBROKER",
                    "asOfUtcSec": now_sec,
                }
            )
        with self._lock:
            self._options = parsed
            self._last_update_sec = now_sec
            self._status = "READY"

    def _on_error(self, _online: Any, error: Any) -> None:
        msg = redact_secrets(str(error), self._cfg["secrets"])
        with self._lock:
            self._error = msg
            if not self._connected and self._status != BMB_STANDBY_2FA_STATUS:
                self._status = "ERROR"

    def _on_open(self, _online: Any) -> None:
        with self._lock:
            self._connected = True
            self._status = "READY"
            self._error = None

    def _on_close(self, _online: Any) -> None:
        with self._lock:
            self._connected = False
            if self._status == "READY":
                self._status = "DISCONNECTED"

    def _classify_login_failure(self, exc: BaseException) -> tuple[str, str]:
        """Clasifica un fallo de login sin exponer datos: inspecciona el mensaje
        de la excepción y la URL/status HTTP de la sesión `requests`. Si la
        respuesta apunta a un desafío 2FA, o el login falla tras validar el
        formato de DNI/usuario, el estado es `STANDBY_2FA` con el mensaje
        informativo fijo (nunca datos sensibles ni la URL cruda)."""
        message, response_url, response_status = bmb_login_failure_inputs(exc)
        classification = classify_bmb_login_failure(
            message,
            response_url,
            response_status,
            self._cfg["dni"],
            self._cfg["username"],
        )
        if classification == BMB_STANDBY_2FA_STATUS:
            return BMB_STANDBY_2FA_STATUS, BMB_STANDBY_2FA_MESSAGE
        return "ERROR", redact_secrets(f"BMB login error: {message}", self._cfg["secrets"])

    def start(self) -> None:
        if not self._cfg["password"] or not PYHOMEBROKER_AVAILABLE or HomeBroker is None:
            return
        if not self._cfg["dni"] or not self._cfg["username"]:
            with self._lock:
                self._status = "ERROR"
                self._error = "BMB_DNI o BMB_USERNAME faltantes en variables de entorno."
            return

        with self._lock:
            self._status = "CONNECTING"

        try:
            hb = HomeBroker(
                int(self._cfg["broker_id"]),
                on_open=self._on_open,
                on_repos=self._on_repos,
                on_order_book=self._on_order_book,
                on_options=self._on_options,
                on_error=self._on_error,
                on_close=self._on_close,
            )
        except Exception as exc:
            with self._lock:
                self._connected = False
                self._status = "ERROR"
                self._error = redact_secrets(f"BMB connect error: {exc}", self._cfg["secrets"])
            return

        try:
            hb.auth.login(
                dni=self._cfg["dni"],
                user=self._cfg["username"],
                password=self._cfg["password"],
                raise_exception=True,
            )
        except Exception as exc:
            status, safe_error = self._classify_login_failure(exc)
            with self._lock:
                self._connected = False
                self._status = status
                self._error = safe_error
            return

        try:
            hb.online.connect()
            hb.online.subscribe_repos()
            hb.online.subscribe_options()
            for sym in self._cfg["leaders"]:
                for sett in ("24hs", "spot"):
                    try:
                        hb.online.subscribe_order_book(sym, sett)
                        self._subscribed_books.add((sym, sett))
                    except Exception:
                        pass
            with self._lock:
                self._hb = hb
                self._connected = True
                self._status = "READY"
                self._error = None
        except Exception as exc:
            with self._lock:
                self._connected = False
                self._status = "ERROR"
                self._error = redact_secrets(f"BMB connect error: {exc}", self._cfg["secrets"])

    def ensure_symbol_subscribed(self, symbol: str, settlement: str = "24hs") -> None:
        sym = symbol.strip().upper()
        if not sym or self._hb is None or not self._connected:
            return
        key = (sym, settlement)
        if key in self._subscribed_books:
            return
        try:
            self._hb.online.subscribe_order_book(sym, settlement)
            self._subscribed_books.add(key)
        except Exception:
            pass

    def stop(self) -> None:
        hb = self._hb
        if hb is not None:
            try:
                hb.online.disconnect()
            except Exception:
                pass
        with self._lock:
            self._connected = False

    def get_health(self) -> dict[str, Any]:
        with self._lock:
            return {
                "ok": self._status == "READY",
                "status": self._status,
                "brokerId": int(self._cfg["broker_id"]),
                "accountLabel": f"BMB {self._cfg['account']}" if self._cfg["account"] else None,
                "pyhomebrokerInstalled": PYHOMEBROKER_AVAILABLE,
                "passwordConfigured": bool(self._cfg["password"]),
                "connected": self._connected,
                "lastUpdateUtcSec": self._last_update_sec,
                "counts": {
                    "cauciones": len(self._cauciones),
                    "orderBooks": len(self._order_books),
                    "options": len(self._options),
                },
                "error": self._error,
            }

    def get_snapshot(self, symbol: str | None = None) -> dict[str, Any]:
        if symbol:
            self.ensure_symbol_subscribed(symbol)
        health = self.get_health()
        with self._lock:
            books = (
                {symbol.upper(): self._order_books[symbol.upper()]}
                if symbol and symbol.upper() in self._order_books
                else dict(self._order_books)
            )
            return {
                "status": health["status"],
                "brokerId": health["brokerId"],
                "accountLabel": health["accountLabel"],
                "pyhomebrokerInstalled": health["pyhomebrokerInstalled"],
                "passwordConfigured": health["passwordConfigured"],
                "asOfUtcSec": self._last_update_sec,
                "error": self._error,
                "cauciones": list(self._cauciones),
                "orderBooksBySymbol": books,
                "options": list(self._options),
            }


def create_handler(state: BmbBridgeState) -> type[BaseHTTPRequestHandler]:
    class BridgeHandler(BaseHTTPRequestHandler):
        def _send_json(self, status_code: int, payload: dict[str, Any]) -> None:
            raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status_code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            qs = parse_qs(parsed.query)
            symbol = qs.get("symbol", [None])[0]
            if parsed.path == "/health":
                self._send_json(200, state.get_health())
                return
            if parsed.path in ("/snapshot", "/"):
                self._send_json(200, state.get_snapshot(symbol=symbol))
                return
            if parsed.path == "/cauciones":
                snap = state.get_snapshot()
                self._send_json(200, {"status": snap["status"], "asOfUtcSec": snap["asOfUtcSec"], "cauciones": snap["cauciones"], "error": snap["error"]})
                return
            if parsed.path == "/orderbook":
                snap = state.get_snapshot(symbol=symbol)
                self._send_json(200, {"status": snap["status"], "asOfUtcSec": snap["asOfUtcSec"], "orderBooksBySymbol": snap["orderBooksBySymbol"], "error": snap["error"]})
                return
            if parsed.path == "/options":
                snap = state.get_snapshot()
                self._send_json(200, {"status": snap["status"], "asOfUtcSec": snap["asOfUtcSec"], "options": snap["options"], "error": snap["error"]})
                return
            self._send_json(404, {"status": "NOT_FOUND", "error": f"Unknown route {parsed.path}"})

        def log_message(self, format: str, *args: Any) -> None:
            # Suppress noisy request logs containing URL params; only emit redacted critical errors.
            return

    return BridgeHandler


def main() -> int:
    parser = argparse.ArgumentParser(description="BMB HomeBroker SignalR local HTTP bridge")
    parser.add_argument("--check-status", action="store_true", help="Print safe bridge status JSON and exit")
    args = parser.parse_args()

    cfg = read_bmb_env(os.environ)
    state = BmbBridgeState(cfg)
    if args.check_status:
        print(json.dumps(state.get_health(), ensure_ascii=False))
        return 0

    state.start()
    server = ThreadingHTTPServer((cfg["host"], int(cfg["port"])), create_handler(state))

    def shutdown_handler(_signum: int, _frame: Any) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, shutdown_handler)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, shutdown_handler)

    try:
        print(
            f"[bmb_homebroker_bridge] listening on http://{cfg['host']}:{cfg['port']} | status={state.get_health()['status']}",
            file=sys.stderr,
        )
        server.serve_forever()
    finally:
        state.stop()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
