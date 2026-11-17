#!/usr/bin/env python3
"""Local-only Bull Market Brokers HomeBroker JSON bridge for GGAL L2/options.

Credentials arrive exclusively through BMB_* environment variables (including
the optional `BMB_SESSION_COOKIE` trusted-device cookie, applied across both
Bull Market domain families: bullmarketbrokers.com and bullmarket.com.ar).
The process never prints or logs them.  HTTP is bound to loopback and returns normalized UTC
seconds, five order-book levels, GFGC/GFGV BBO sizes and classified real trades.
The online stream is attempted first reusing the session cookie; only when the
server requires login does the bridge fall back to `hb.auth.login(...)` with
the trusted-device cookies kept loaded.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import signal
import threading
import time
from typing import Any
from urllib.parse import parse_qs, urlparse

from bmb_homebroker_bridge import (  # type: ignore[import-not-found]
    BMB_STANDBY_2FA_STATUS,
    BmbBridgeState as BaseBmbBridgeState,
    HomeBroker,
    PYHOMEBROKER_AVAILABLE,
    PYHOMEBROKER_IMPORT_ERROR,
    extract_records,
    finite_num,
    read_bmb_env as read_base_bmb_env,
    redact_secrets,
)

ART = timezone(timedelta(hours=-3))
MAX_TRADES_PER_SYMBOL = 2_000


def read_bmb_config(environ: dict[str, str] | os._Environ[str] = os.environ) -> dict[str, Any]:
    # Aliases are normalized in memory only; no environment value is ever emitted.
    normalized = dict(environ)
    aliases = {
        "BMB_USERNAME": ("BMB_USER",),
        "BMB_PASSWORD": ("BMB_PASS",),
        "BMB_ACCOUNT": ("BMB_COMITENTE",),
    }
    for canonical, candidates in aliases.items():
        if str(normalized.get(canonical) or "").strip():
            continue
        for candidate in candidates:
            value = str(normalized.get(candidate) or "").strip()
            if value:
                normalized[canonical] = value
                break
    cfg = read_base_bmb_env(normalized)
    raw_broker = str(environ.get("BMB_BROKER_ID") or "").strip()
    try:
        parsed_broker = int(raw_broker)
        cfg["broker_id"] = parsed_broker if parsed_broker > 0 else 0
    except ValueError:
        cfg["broker_id"] = 0
    cfg["secrets"] = tuple(
        dict.fromkeys(
            value
            for value in (
                cfg["password"],
                cfg["dni"],
                cfg["username"],
                cfg["account"],
                cfg["session_cookie"],
                cfg["hub_token"],
                str(normalized.get("BMB_DNI") or ""),
                str(normalized.get("BMB_USER") or ""),
                str(normalized.get("BMB_PASS") or ""),
                str(normalized.get("BMB_SESSION_COOKIE") or ""),
                str(normalized.get("BMB_HUB_TOKEN") or ""),
            )
            if value
        )
    )
    return cfg


def normalize_settlement(raw: Any) -> str:
    value = str(raw or "24hs").strip().upper().replace(" ", "")
    if value in {"24HS", "T+1", "T1"}:
        return "24hs"
    if value in {"CI", "SPOT", "T+0", "T0", "CONTADO"}:
        return "CI"
    return str(raw or "24hs").strip()


def utc_sec(value: Any) -> int | None:
    numeric = finite_num(value)
    if numeric is not None and numeric > 0:
        return int(numeric / 1000) if numeric > 10_000_000_000 else int(numeric)
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str) and value.strip():
        text = value.strip().replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
    else:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=ART)
    return int(parsed.timestamp())


def positive(value: Any) -> float | None:
    number = finite_num(value)
    return number if number is not None and number > 0 else None


def non_negative(value: Any) -> float | None:
    number = finite_num(value)
    return number if number is not None and number >= 0 else None


def first(row: dict[str, Any], names: tuple[str, ...]) -> Any:
    for name in names:
        if name in row and row[name] is not None:
            return row[name]
    return None


class BmbBridgeState(BaseBmbBridgeState):
    def __init__(self, cfg: dict[str, Any]) -> None:
        super().__init__(cfg)
        self._trades_by_symbol: dict[str, list[dict[str, Any]]] = {}
        self._trade_sequence = 0
        self._options_by_symbol: dict[str, dict[str, Any]] = {}
        self._security_state: dict[str, dict[str, Any]] = {}
        self._stop_event = threading.Event()
        self._total_messages_received = 0
        self._last_message_at_ms: int | None = None
        self._reconnect_requested = False

    def _record_bridge_message(self) -> None:
        now_ms = int(time.time() * 1000)
        with self._lock:
            self._total_messages_received += 1
            self._last_message_at_ms = now_ms

    def request_reconnect(self) -> None:
        """Force the reconnect loop to close and re-authenticate the HomeBroker session."""
        with self._lock:
            self._reconnect_requested = True
            self._connected = False
            self._status = "DISCONNECTED"
            hb = self._hb
            self._hb = None
        if hb is not None:
            online = getattr(hb, "online", None)
            try:
                if online is not None and hasattr(online, "disconnect"):
                    online.disconnect()
            except Exception as exc:
                with self._lock:
                    self._error = redact_secrets(f"BMB reconnect close error: {exc}", self._cfg["secrets"])

    def _set_callback_status(self) -> None:
        book = self._order_books.get("GGAL")
        if book and book["bids"] and book["asks"]:
            self._status = "CONNECTED_L2"
        elif self._connected:
            self._status = "READY"

    def _on_open(self, online: Any) -> None:
        super()._on_open(online)
        with self._lock:
            self._set_callback_status()

    def _on_close(self, online: Any) -> None:
        super()._on_close(online)
        with self._lock:
            self._connected = False
            if self._status in {"READY", "CONNECTED_L2"}:
                self._status = "DISCONNECTED"

    def _on_order_book(self, _online: Any, quotes: Any) -> None:
        rows = extract_records(quotes)
        now_sec = int(datetime.now(tz=timezone.utc).timestamp())
        grouped: dict[str, dict[str, Any]] = {}
        for row in rows:
            symbol = str(first(row, ("symbol", "ticker")) or "").strip().upper()
            if not symbol:
                continue
            settlement = normalize_settlement(first(row, ("settlement", "plazo")))
            # The productive ladder is deliberately GGAL T+1; never mix CI into it.
            if settlement != "24hs":
                continue
            entry = grouped.setdefault(
                symbol,
                {
                    "symbol": symbol,
                    "settlement": "24hs",
                    "bidMap": {},
                    "askMap": {},
                    "asOfUtcSec": now_sec,
                    "source": "BMB_HOMEBROKER",
                },
            )
            sides = (
                (
                    "bidMap",
                    positive(first(row, ("bid", "bid_price", "bidPrice"))),
                    non_negative(first(row, ("bid_size", "bidsize", "bidSize", "q_bid"))),
                    non_negative(first(row, ("bid_offers_count", "bid_orders", "bid_order_count", "bidOrderCount"))),
                ),
                (
                    "askMap",
                    positive(first(row, ("ask", "ask_price", "askPrice", "offer"))),
                    non_negative(first(row, ("ask_size", "asksize", "askSize", "q_ask", "offer_size"))),
                    non_negative(first(row, ("ask_offers_count", "ask_orders", "ask_order_count", "askOrderCount", "offer_orders"))),
                ),
            )
            for side_key, price, size, order_count in sides:
                if price is None or size is None:
                    continue
                levels = entry[side_key]
                current = levels.setdefault(price, {"size": 0.0, "orderCount": None})
                current["size"] += size
                if order_count is not None:
                    current["orderCount"] = (current["orderCount"] or 0.0) + order_count

        with self._lock:
            for symbol, entry in grouped.items():
                bid_map = entry.pop("bidMap")
                ask_map = entry.pop("askMap")
                bids = [
                    {
                        "price": price,
                        "size": values["size"],
                        "orderCount": values["orderCount"],
                    }
                    for price, values in bid_map.items()
                ]
                asks = [
                    {
                        "price": price,
                        "size": values["size"],
                        "orderCount": values["orderCount"],
                    }
                    for price, values in ask_map.items()
                ]
                bids.sort(key=lambda level: level["price"], reverse=True)
                asks.sort(key=lambda level: level["price"])
                entry["bids"] = bids[:5]
                entry["asks"] = asks[:5]
                self._order_books[symbol] = entry
            if grouped:
                self._connected = True
                self._last_update_sec = now_sec
                self._error = None
                self._set_callback_status()
        if rows:
            self._record_bridge_message()

    def _on_options(self, _online: Any, quotes: Any) -> None:
        rows = extract_records(quotes)
        now_sec = int(datetime.now(tz=timezone.utc).timestamp())
        parsed: list[dict[str, Any]] = []
        for row in rows:
            symbol = str(first(row, ("symbol", "ticker")) or "").strip().upper()
            if not symbol.startswith(("GFGC", "GFGV")):
                continue
            parsed.append(
                {
                    "symbol": symbol,
                    "underlying": "GGAL",
                    "bid": positive(first(row, ("bid", "bid_price", "bidPrice"))),
                    "bidSize": non_negative(first(row, ("bid_size", "bidsize", "bidSize", "q_bid"))),
                    "ask": positive(first(row, ("ask", "ask_price", "askPrice", "offer"))),
                    "askSize": non_negative(first(row, ("ask_size", "asksize", "askSize", "q_ask", "offer_size"))),
                    "last": positive(first(row, ("last", "close", "price", "c"))),
                    "volume": non_negative(first(row, ("volume", "nominal_volume", "q_op", "v"))),
                    "turnover": non_negative(first(row, ("turnover", "volume_amount", "v_ars"))),
                    "varPct": finite_num(first(row, ("varPct", "changePct", "pct_change", "variation", "change"))),
                    "source": "BMB_HOMEBROKER",
                    "asOfUtcSec": now_sec,
                }
            )
        with self._lock:
            for quote in parsed:
                self._options_by_symbol[quote["symbol"]] = quote
            if parsed:
                self._options = [self._options_by_symbol[key] for key in sorted(self._options_by_symbol)]
                self._connected = True
                self._last_update_sec = now_sec
                self._error = None
                self._set_callback_status()
        if parsed:
            self._record_bridge_message()

    def _on_securities(self, _online: Any, quotes: Any) -> None:
        """Convert real GGAL cumulative-volume deltas to ordered aggregate trades.

        pyhomebroker has no tick-trade subscription.  The first board snapshot only
        initializes the baseline; subsequent positive volume deltas are classified
        against the same update's BBO, with tick-rule fallback.  No opening volume
        is fabricated into a new trade.
        """
        rows = extract_records(quotes)
        received_sec = int(datetime.now(tz=timezone.utc).timestamp())
        with self._lock:
            for row in rows:
                symbol = str(first(row, ("symbol", "ticker")) or "").strip().upper()
                if symbol != "GGAL" or normalize_settlement(first(row, ("settlement", "plazo"))) != "24hs":
                    continue
                cumulative_volume = non_negative(first(row, ("volume", "nominal_volume", "v")))
                operations = non_negative(first(row, ("operations", "trades", "operation_count")))
                price = positive(first(row, ("last", "price", "trade_price")))
                trade_time = utc_sec(first(row, ("datetime", "timeSec", "timestamp", "time", "date")))
                if cumulative_volume is None or price is None or trade_time is None:
                    continue
                previous = self._security_state.get(symbol)
                self._security_state[symbol] = {
                    "volume": cumulative_volume,
                    "operations": operations,
                    "price": price,
                    "timeSec": trade_time,
                }
                if previous is None or trade_time < previous["timeSec"]:
                    continue
                delta_volume = cumulative_volume - previous["volume"]
                if delta_volume <= 0:
                    continue
                bid = positive(first(row, ("bid", "bid_price", "bidPrice")))
                ask = positive(first(row, ("ask", "ask_price", "askPrice")))
                side = "UNKNOWN"
                if ask is not None and price >= ask:
                    side = "BUY"
                elif bid is not None and price <= bid:
                    side = "SELL"
                elif price > previous["price"]:
                    side = "BUY"
                elif price < previous["price"]:
                    side = "SELL"
                attributable = bool(
                    operations is not None
                    and previous["operations"] is not None
                    and operations - previous["operations"] == 1
                )
                self._trade_sequence += 1
                trade = {
                    "sequence": self._trade_sequence,
                    "symbol": symbol,
                    "timeSec": trade_time,
                    "price": price,
                    "size": delta_volume,
                    "side": side,
                    "buyVolume": delta_volume if side == "BUY" else 0.0 if side == "SELL" else None,
                    "sellVolume": delta_volume if side == "SELL" else 0.0 if side == "BUY" else None,
                    "attributableToLast": attributable,
                    "aggregation": "CUMULATIVE_VOLUME_DELTA",
                }
                series = self._trades_by_symbol.setdefault(symbol, [])
                series.append(trade)
                if len(series) > MAX_TRADES_PER_SYMBOL:
                    del series[: len(series) - MAX_TRADES_PER_SYMBOL]
                self._last_update_sec = received_sec
        if rows:
            self._record_bridge_message()

    def _on_error(self, _online: Any, error: Any, connection_lost: bool = False) -> None:
        message = redact_secrets(str(error), self._cfg["secrets"])
        with self._lock:
            self._error = message
            if connection_lost:
                self._connected = False
                self._status = "DISCONNECTED"
            elif not self._connected and self._status != BMB_STANDBY_2FA_STATUS:
                self._status = "ERROR"

    def stop(self) -> None:
        self._stop_event.set()
        super().stop()

    def _connect_once(self) -> None:
        with self._lock:
            self._status = "CONNECTING"
            self._reconnect_requested = False
        try:
            hb = HomeBroker(
                int(self._cfg["broker_id"]),
                on_open=self._on_open,
                on_securities=self._on_securities,
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

        # Contexto de dispositivo de confianza: UA moderno + cookie de sesión
        # cargada en las sesiones expuestas y en `auth.cookies`, antes de autenticar.
        self._apply_bmb_session_context(hb)

        # 1) Reutilización de sesión: abrir primero el stream online con la
        # cookie ya autenticada. 2) Solo si el servidor exige login, caer a
        # `hb.auth.login(...)` con las cookies de dispositivo cargadas.
        cookie_stream_ready = self._connect_online_with_session_cookie(hb)
        if not cookie_stream_ready:
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
            with self._lock:
                self._hb = hb
            if not cookie_stream_ready:
                hb.online.connect()
            hb.online.subscribe_securities("bluechips", "24hs")
            hb.online.subscribe_repos()
            hb.online.subscribe_options()
            for symbol in self._cfg["leaders"]:
                hb.online.subscribe_order_book(symbol, "24hs")
                self._subscribed_books.add((symbol, "24hs"))
            with self._lock:
                self._connected = True
                self._error = None
                self._set_callback_status()
        except Exception as exc:
            with self._lock:
                self._connected = False
                self._status = "ERROR"
                self._error = redact_secrets(f"BMB connect error: {exc}", self._cfg["secrets"])

    def start(self) -> None:
        if not self._cfg["password"] or not PYHOMEBROKER_AVAILABLE or HomeBroker is None:
            return
        if not self._cfg["dni"] or not self._cfg["username"] or int(self._cfg["broker_id"]) <= 0:
            with self._lock:
                self._status = "ERROR"
                self._error = "INVALID_BMB_CONFIGURATION"
            return
        failed_attempts = 0
        while not self._stop_event.is_set():
            self._connect_once()
            with self._lock:
                connected = self._connected
                status = self._status
            if status == BMB_STANDBY_2FA_STATUS:
                # 2FA interactivo requerido (SMS/App): se detienen los reintentos
                # automáticos para no bloquear la cuenta con intentos fallidos.
                # IOL_REST_V2 + Primary DLR quedan como fuentes activas.
                break
            failed_attempts = 0 if connected else failed_attempts + 1
            while connected and not self._stop_event.is_set():
                if self._stop_event.wait(1.0):
                    break
                with self._lock:
                    connected = self._connected
            if self._stop_event.is_set():
                break
            delay = min(60, 5 * (2 ** min(max(0, failed_attempts - 1), 4)))
            waited_ms = 0
            while waited_ms < delay * 1000 and not self._stop_event.is_set():
                if self._stop_event.wait(0.25):
                    break
                waited_ms += 250
                with self._lock:
                    reconnect_requested = self._reconnect_requested
                    if reconnect_requested:
                        self._reconnect_requested = False
                if reconnect_requested:
                    break

    def get_health(self) -> dict[str, Any]:
        health = super().get_health()
        with self._lock:
            book = self._order_books.get("GGAL")
            connected_l2 = bool(
                self._connected
                and self._status not in {"ERROR", "DISCONNECTED", BMB_STANDBY_2FA_STATUS}
                and book
                and book["bids"]
                and book["asks"]
            )
            if connected_l2:
                health["status"] = "CONNECTED_L2"
            health["ok"] = health["status"] in {"READY", "CONNECTED_L2"}
            health["connected"] = bool(self._connected)
            health["accountLabel"] = None
            health["counts"]["trades"] = sum(len(rows) for rows in self._trades_by_symbol.values())
            health["telemetry"] = {
                "totalMessagesReceived": self._total_messages_received,
                "lastMessageAtMs": self._last_message_at_ms,
            }
            return health

    def get_snapshot(self, symbol: str | None = None) -> dict[str, Any]:
        if symbol:
            self.ensure_symbol_subscribed(symbol, "24hs")
        health = self.get_health()
        clean_symbol = symbol.upper().strip() if symbol else None
        with self._lock:
            books = (
                {clean_symbol: self._order_books[clean_symbol]}
                if clean_symbol and clean_symbol in self._order_books
                else {} if clean_symbol else dict(self._order_books)
            )
            trades = (
                {clean_symbol: list(self._trades_by_symbol.get(clean_symbol, []))}
                if clean_symbol
                else {key: list(rows) for key, rows in self._trades_by_symbol.items()}
            )
            return {
                "status": health["status"],
                "brokerId": health["brokerId"],
                "accountLabel": None,
                "pyhomebrokerInstalled": health["pyhomebrokerInstalled"],
                "passwordConfigured": health["passwordConfigured"],
                "asOfUtcSec": self._last_update_sec,
                "error": health["error"],
                "cauciones": list(self._cauciones),
                "orderBooksBySymbol": books,
                "options": list(self._options),
                "tradesBySymbol": trades,
                "telemetry": health["telemetry"],
            }


def create_handler(state: BmbBridgeState) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def send_json(self, status_code: int, payload: dict[str, Any]) -> None:
            raw = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
            self.send_response(status_code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            query = parse_qs(parsed.query)
            symbol = query.get("symbol", [None])[0]
            if parsed.path == "/health":
                self.send_json(200, state.get_health())
                return
            if parsed.path in {"/", "/snapshot"}:
                self.send_json(200, state.get_snapshot(symbol))
                return
            if parsed.path == "/orderbook":
                snapshot = state.get_snapshot(symbol)
                self.send_json(200, {"status": snapshot["status"], "asOfUtcSec": snapshot["asOfUtcSec"], "orderBooksBySymbol": snapshot["orderBooksBySymbol"], "error": snapshot["error"]})
                return
            if parsed.path == "/options":
                snapshot = state.get_snapshot()
                self.send_json(200, {"status": snapshot["status"], "asOfUtcSec": snapshot["asOfUtcSec"], "options": snapshot["options"], "error": snapshot["error"]})
                return
            self.send_json(404, {"status": "NOT_FOUND", "error": "Unknown route"})

        def do_POST(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            if parsed.path == "/reconnect":
                state.request_reconnect()
                self.send_json(202, {"status": "RECONNECT_REQUESTED"})
                return
            self.send_json(404, {"status": "NOT_FOUND", "error": "Unknown route"})

        def log_message(self, _format: str, *_args: Any) -> None:
            return

    return Handler


def main() -> int:
    parser = argparse.ArgumentParser(description="BMB GGAL L2/options local bridge")
    parser.add_argument("--check-status", action="store_true")
    parser.add_argument("--host")
    parser.add_argument("--port", type=int)
    args = parser.parse_args()
    cfg = read_bmb_config(os.environ)
    host = (args.host or cfg["host"]).strip()
    port = int(args.port or cfg["port"])
    if host not in {"127.0.0.1", "localhost", "::1"}:
        raise SystemExit("BMB bridge must bind to loopback")
    state = BmbBridgeState(cfg)
    if args.check_status:
        health = state.get_health()
        health["accountLabel"] = None
        print(json.dumps(health, ensure_ascii=False, allow_nan=False))
        return 0

    server = ThreadingHTTPServer((host, port), create_handler(state))

    def shutdown(_signum: int, _frame: Any) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, shutdown)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, shutdown)

    # Machine-readable safe readiness event; contains no account or credential data.
    print(json.dumps({"event": "LISTENING", "host": host, "port": port}), flush=True)
    threading.Thread(target=state.start, daemon=True).start()
    try:
        server.serve_forever()
    finally:
        state.stop()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
