#!/usr/bin/env python3
"""Independent reference fixture for the BMB stock-prices-hub SignalR connector.

This script deliberately re-implements the `SendPrices` contract from first
principles (frame splitting, SendPrices -> L2 record mapping, hub-token
resolution rules, negotiate/WS URL building, ASP.NET Core handshake, ping
reply and query-credential redaction).  It does not import or inspect the
connector implementation (tools/bmb_inversiones_signalr.py) nor any TypeScript
code.  All tokens, cookies and UUIDs in this fixture are SYNTHETIC.

Generated fixture (fixtures/bmb_inversiones_sendprices.json) is consumed by:
- tools/test_bmb_bridge_reconnect.py (Python connector tests)
- tests/bmbInversionesSignalR.test.ts (TS adapter redaction/ingestion tests)
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

RECORD_SEPARATOR = "\x1e"

# Synthetic credentials (never real secrets).
HUB_TOKEN = "11111111-2222-3333-4444-555555555555"
OTHER_HUB_TOKEN = "99999999-8888-7777-6666-555555555555"
CONNECTION_TOKEN = "22222222-3333-4444-5555-666666666666"
SESSION_COOKIE = "fake_session_cookie=44444444-5555-6666-7777-888888888888"

HUB_BASE = "https://hub.bullmarketbrokers.com"
HUB_NAME = "stock-prices-hub"
PORTAL_ORIGIN = "https://inversiones.bullmarket.com.ar"
PORTAL_COTIZACIONES_URL = f"{PORTAL_ORIGIN}/Cotizaciones"
BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

HUB_TOKEN_RE = re.compile(r"stock-prices-hub\?token=([0-9a-fA-F-]+)")
REDACT_RE = re.compile(r"([?&])(token|id)=[^&\s\"']+")
WS_STATUS_RE = re.compile(r"status[:\s]*(\d{3})", re.IGNORECASE)
LOGIN_MARKERS = ("login", "ingresar", "acceso", "twofactor", "verifycode")


# ---------------------------------------------------------------------------
# Reference implementations (explicit, independent of the connector module)
# ---------------------------------------------------------------------------

def ref_extract_hub_token(html: str) -> str:
    match = HUB_TOKEN_RE.search(html or "")
    return match.group(1) if match else ""


def ref_classify_portal(status: int | None, final_url: str) -> str:
    if status is not None and status in (401, 403):
        return "STANDBY_2FA"
    compact = re.sub(r"[\s_\-/]", "", (final_url or "")).lower()
    if any(marker in compact for marker in LOGIN_MARKERS):
        return "STANDBY_2FA"
    if status is not None and status >= 400:
        return "PORTAL_ERROR"
    return "OK"


def ref_redact(text: str) -> str:
    return REDACT_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}=[REDACTED]", text or "")


def ref_negotiate_url(hub_token: str) -> str:
    return f"{HUB_BASE}/{HUB_NAME}/negotiate?token={hub_token}&negotiateVersion=1"


def ref_ws_url(hub_token: str, connection_token: str) -> str:
    return f"wss://hub.bullmarketbrokers.com/{HUB_NAME}?token={hub_token}&id={connection_token}"


def ref_negotiate_headers() -> dict[str, str]:
    return {
        "Origin": PORTAL_ORIGIN,
        "User-Agent": BROWSER_USER_AGENT,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def ref_ws_headers() -> dict[str, str]:
    return {"Origin": PORTAL_ORIGIN, "User-Agent": BROWSER_USER_AGENT}


def ref_handshake_frame() -> str:
    return '{"protocol":"json","version":1}' + RECORD_SEPARATOR


def ref_handshake_ok(payload: str) -> bool:
    text = (payload or "").strip()
    if not text:
        return False
    try:
        parsed = json.loads(text)
    except ValueError:
        return False
    return isinstance(parsed, dict) and "error" not in parsed


def ref_ping_reply() -> str:
    return '{"type":6}' + RECORD_SEPARATOR


def ref_split_frames(buffer: str, chunk: str) -> tuple[list[str], str]:
    parts = ((buffer or "") + (chunk or "")).split(RECORD_SEPARATOR)
    remainder = parts.pop()
    return [part for part in parts if part != ""], remainder


def ref_ws_error_class(message: str) -> str:
    match = WS_STATUS_RE.search(message or "")
    status = int(match.group(1)) if match else None
    return "STANDBY_2FA" if status in (401, 403) else "ERROR"


def ref_term(term: Any) -> str:
    text = str(term or "").strip()
    return {"1": "CI", "2": "24hs"}.get(text, "")


def ref_currency(value: Any) -> str:
    text = str(value or "").strip().upper()
    return text if text in {"ARS", "USD"} else ""


def ref_datetime(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        if number <= 0:
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


def ref_offer_side(rows: Any) -> list[dict[str, Any]]:
    if not isinstance(rows, list):
        return []
    entries: list[tuple[int, dict[str, Any]]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        position = row.get("position")
        price = row.get("price")
        quantity = row.get("quantity")
        if isinstance(position, bool) or not isinstance(position, (int, float)):
            continue
        pos = int(position)
        if pos < 1 or pos > 5:
            continue
        if not isinstance(price, (int, float)) or price <= 0:
            continue
        if not isinstance(quantity, (int, float)) or quantity < 0:
            continue
        entries.append((pos, {"price": float(price), "size": float(quantity), "orderCount": None}))
    entries.sort(key=lambda item: item[0])
    return [level for _position, level in entries]


def ref_map_row(row: Any) -> dict[str, Any] | None:
    if not isinstance(row, dict):
        return None
    ticker = str(row.get("ticker") or "").strip().upper()
    if not ticker:
        return None
    settlement = ref_term(row.get("term"))
    if not settlement:
        return None
    currency = ref_currency(row.get("currency"))
    state = row.get("stockState") if isinstance(row.get("stockState"), dict) else {}
    offer = row.get("stockOffer") if isinstance(row.get("stockOffer"), dict) else {}
    bids = ref_offer_side(offer.get("bidTop"))
    asks = ref_offer_side(offer.get("askTop"))
    last = state.get("price")
    last_value = float(last) if isinstance(last, (int, float)) and not isinstance(last, bool) else None
    if last_value is None and not bids and not asks:
        return None

    def num(value: Any) -> float | None:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        return float(value)

    return {
        "symbol": ticker,
        "settlement": settlement,
        "currency": currency,
        "asOfUtcSec": ref_datetime(row.get("date")),
        "last": last_value,
        "open": num(state.get("open")),
        "min": num(state.get("min")),
        "max": num(state.get("max")),
        "close": num(state.get("close")),
        "variation": num(state.get("variation")),
        "totalNominalValue": num(state.get("totalNominalValue")),
        "totalAmount": num(state.get("totalAmount")),
        "operations": num(state.get("operations")),
        "bids": bids,
        "asks": asks,
        "source": "BMB_HOMEBROKER",
    }


def ref_send_prices_frame(rows: list[dict[str, Any]]) -> str:
    message = {"type": 1, "target": "SendPrices", "arguments": [rows]}
    return json.dumps(message, separators=(",", ":"), ensure_ascii=False) + RECORD_SEPARATOR


def ref_frame(target: str, arguments: Any) -> str:
    message = {"type": 1, "target": target, "arguments": arguments}
    return json.dumps(message, separators=(",", ":"), ensure_ascii=False) + RECORD_SEPARATOR


# ---------------------------------------------------------------------------
# Synthetic market data (estructuras basadas en SendPrices real)
# ---------------------------------------------------------------------------

GGAL_DATE = "2026-11-17T14:30:05Z"
YPFD_DATE = "2026-11-17T14:30:06Z"
BMA_DATE = "2026-11-17T14:30:07Z"
PAMP_DATE = "2026-11-17T14:30:08Z"
SUPV_DATE = "2026-11-17T14:30:09Z"

GGAL_ROW = {
    "ticker": "GGAL",
    "term": "2",
    "currency": "ARS",
    "date": GGAL_DATE,
    "stockState": {
        "price": 6450.5,
        "open": 6430.0,
        "min": 6415.25,
        "max": 6468.0,
        "close": 6420.75,
        "variation": 0.46,
        "totalNominalValue": 12345678.5,
        "totalAmount": 1234567890.25,
        "operations": 4211,
    },
    "stockOffer": {
        "bidTop": [
            {"position": 3, "price": 6449.5, "quantity": 800.0},
            {"position": 1, "price": 6450.5, "quantity": 1200.0},
            {"position": 5, "price": 6448.5, "quantity": 150.0},
            {"position": 2, "price": 6450.0, "quantity": 3500.0},
            {"position": 4, "price": 6449.0, "quantity": 2500.0},
            {"position": 6, "price": 6448.0, "quantity": 10.0},
        ],
        "askTop": [
            {"position": 4, "price": 6452.5, "quantity": 600.0},
            {"position": 1, "price": 6451.0, "quantity": 900.0},
            {"position": 3, "price": 6452.0, "quantity": 1400.0},
            {"position": 2, "price": 6451.5, "quantity": 2200.0},
            {"position": 5, "price": 6453.0, "quantity": 3100.0},
        ],
    },
}

YPFD_ROW = {
    "ticker": "YPFD",
    "term": "2",
    "currency": "ARS",
    "date": YPFD_DATE,
    "stockState": {
        "price": 45120.0,
        "open": 44980.0,
        "min": 44895.0,
        "max": 45210.0,
        "close": 44950.0,
        "variation": 0.38,
        "totalNominalValue": 88231.0,
        "totalAmount": 3980123456.0,
        "operations": 987,
    },
    "stockOffer": {
        "bidTop": [
            {"position": 1, "price": 45120.0, "quantity": 55.0},
            {"position": 2, "price": 45119.0, "quantity": 120.0},
        ],
        "askTop": [
            {"position": 1, "price": 45122.0, "quantity": 40.0},
            {"position": 2, "price": 45123.5, "quantity": 85.0},
            {"position": 3, "price": 45125.0, "quantity": 200.0},
        ],
    },
}

BMA_ROW = {
    "ticker": "BMA",
    "term": "1",
    "currency": "ARS",
    "date": BMA_DATE,
    "stockState": {
        "price": 682.4,
        "open": 681.0,
        "min": 679.8,
        "max": 684.2,
        "close": 680.9,
        "variation": 0.22,
        "totalNominalValue": 45210.0,
        "totalAmount": 30874321.0,
        "operations": 152,
    },
    "stockOffer": {
        "bidTop": [{"position": 1, "price": 682.4, "quantity": 300.0}],
        "askTop": [{"position": 1, "price": 682.6, "quantity": 250.0}],
    },
}

PAMP_ROW = {
    "ticker": "PAMP",
    "term": "2",
    "currency": "ARS",
    "date": PAMP_DATE,
    "stockState": {
        "price": 1899.75,
        "open": 1892.0,
        "min": 1885.5,
        "max": 1905.0,
        "close": 1890.25,
        "variation": 0.5,
        "totalNominalValue": 1203400.0,
        "totalAmount": 2285123456.0,
        "operations": 2450,
    },
    "stockOffer": {
        "bidTop": [
            {"position": 1, "price": 1899.75, "quantity": 4300.0},
            {"position": 2, "price": 1899.5, "quantity": 2100.0},
            {"position": 3, "price": 1899.0, "quantity": 980.0},
        ],
        "askTop": [
            {"position": 1, "price": 1900.0, "quantity": 3900.0},
            {"position": 2, "price": 1900.5, "quantity": 1250.0},
        ],
    },
}

SUPV_ROW = {
    "ticker": "SUPV",
    "term": "2",
    "currency": "USD",
    "date": SUPV_DATE,
    "stockState": {
        "price": 24.85,
        "open": 24.7,
        "min": 24.55,
        "max": 24.95,
        "close": 24.68,
        "variation": 0.69,
        "totalNominalValue": 98765.0,
        "totalAmount": 2454321.0,
        "operations": 640,
    },
    "stockOffer": {
        "bidTop": [{"position": 1, "price": 24.85, "quantity": 1500.0}],
        "askTop": [{"position": 1, "price": 24.87, "quantity": 1100.0}],
    },
}

UNKNOWN_TERM_ROW = {
    "ticker": "TS",
    "term": "3",
    "currency": "ARS",
    "date": GGAL_DATE,
    "stockState": {"price": 100.0},
    "stockOffer": {"bidTop": [{"position": 1, "price": 99.9, "quantity": 10.0}]},
}


def main() -> None:
    fixture: dict[str, Any] = {}

    # -- hub_token ----------------------------------------------------------
    html_with_token = (
        '<html><script>var hubConnection = hubConnect("stock-prices-hub?token='
        f"{HUB_TOKEN}"
        '&negotiateVersion=1");</script></html>'
    )
    html_other_token = (
        f'<div data-hub="stock-prices-hub?token={OTHER_HUB_TOKEN}&negotiateVersion=1"></div>'
    )
    hub_token_cases = [
        {"name": "html_with_token", "html": html_with_token, "expectedToken": HUB_TOKEN},
        {"name": "html_other_page_without_token", "html": "<html><body>Sin hub</body></html>", "expectedToken": ""},
        {"name": "empty_html", "html": "", "expectedToken": ""},
    ]
    for case in hub_token_cases:
        reference = ref_extract_hub_token(case["html"])
        if reference != case["expectedToken"]:
            raise SystemExit(f"fixture authoring error (hubToken html): {case['name']}")
    fixture["hubToken"] = {"htmlCases": hub_token_cases}

    resolve_cases = [
        {
            "name": "env_token_priority",
            "hubToken": HUB_TOKEN,
            "sessionCookie": SESSION_COOKIE,
            "portalStatus": 200,
            "portalFinalUrl": PORTAL_COTIZACIONES_URL,
            "portalHtml": html_other_token,
            "expectedToken": HUB_TOKEN,
            "expectedStatus": "OK",
        },
        {
            "name": "cookie_scrape_success",
            "hubToken": "",
            "sessionCookie": SESSION_COOKIE,
            "portalStatus": 200,
            "portalFinalUrl": PORTAL_COTIZACIONES_URL,
            "portalHtml": html_with_token,
            "expectedToken": HUB_TOKEN,
            "expectedStatus": "OK",
        },
        {
            "name": "login_redirect_is_standby",
            "hubToken": "",
            "sessionCookie": SESSION_COOKIE,
            "portalStatus": 200,
            "portalFinalUrl": f"{PORTAL_ORIGIN}/Login/Ingresar?ReturnUrl=%2FCotizaciones",
            "portalHtml": html_with_token,
            "expectedToken": "",
            "expectedStatus": "STANDBY_2FA",
        },
        {
            "name": "portal_401_is_standby",
            "hubToken": "",
            "sessionCookie": SESSION_COOKIE,
            "portalStatus": 401,
            "portalFinalUrl": PORTAL_COTIZACIONES_URL,
            "portalHtml": "",
            "expectedToken": "",
            "expectedStatus": "STANDBY_2FA",
        },
        {
            "name": "portal_500_is_error",
            "hubToken": "",
            "sessionCookie": SESSION_COOKIE,
            "portalStatus": 500,
            "portalFinalUrl": PORTAL_COTIZACIONES_URL,
            "portalHtml": "",
            "expectedToken": "",
            "expectedStatus": "PORTAL_ERROR",
        },
        {
            "name": "no_token_no_cookie_is_standby",
            "hubToken": "",
            "sessionCookie": "",
            "portalStatus": None,
            "portalFinalUrl": "",
            "portalHtml": "",
            "expectedToken": "",
            "expectedStatus": "STANDBY_2FA",
        },
    ]
    for case in resolve_cases:
        if case["hubToken"]:
            expected_token, expected_status = case["hubToken"], "OK"
        elif not case["sessionCookie"]:
            expected_token, expected_status = "", "STANDBY_2FA"
        else:
            classification = ref_classify_portal(case["portalStatus"], case["portalFinalUrl"])
            if classification != "OK":
                expected_token, expected_status = "", classification
            else:
                token = ref_extract_hub_token(case["portalHtml"])
                expected_token = token
                expected_status = "OK" if token else "STANDBY_2FA"
        if expected_token != case["expectedToken"] or expected_status != case["expectedStatus"]:
            raise SystemExit(f"fixture authoring error (resolve): {case['name']}")
    fixture["hubToken"]["resolveCases"] = resolve_cases

    url_cases = [
        {
            "name": "default",
            "hubToken": HUB_TOKEN,
            "connectionToken": CONNECTION_TOKEN,
            "expectedNegotiateUrl": ref_negotiate_url(HUB_TOKEN),
            "expectedWsUrl": ref_ws_url(HUB_TOKEN, CONNECTION_TOKEN),
            "expectedNegotiateHeaders": ref_negotiate_headers(),
            "expectedWsHeaders": ref_ws_headers(),
        }
    ]
    fixture["hubToken"]["urlCases"] = url_cases

    fixture["hubToken"]["negotiateResponses"] = [
        {"name": "connectionToken", "body": json.dumps({"connectionToken": CONNECTION_TOKEN, "negotiateVersion": 1}), "expectedConnectionToken": CONNECTION_TOKEN},
        {"name": "connectionId_fallback", "body": json.dumps({"connectionId": CONNECTION_TOKEN}), "expectedConnectionToken": CONNECTION_TOKEN},
        {"name": "missing", "body": json.dumps({"negotiateVersion": 1}), "expectedConnectionToken": ""},
        {"name": "malformed", "body": "not-json", "expectedConnectionToken": ""},
    ]

    fixture["hubToken"]["handshake"] = {
        "frame": ref_handshake_frame(),
        "okPayloads": ["{}", '  {}  '],
        "invalidPayloads": ['{"error":"Unsupported protocol version"}', "garbage", ""],
        "pingFrame": '{"type":6}',
        "pingReply": ref_ping_reply(),
    }

    fixture["hubToken"]["wsHandshakeErrorCases"] = [
        {"name": "unauthorized_401", "message": "Handshake status 401 Unauthorized", "expected": "STANDBY_2FA"},
        {"name": "forbidden_403", "message": "Handshake status 403", "expected": "STANDBY_2FA"},
        {"name": "server_500", "message": "Handshake status 500", "expected": "ERROR"},
        {"name": "network", "message": "connection refused", "expected": "ERROR"},
    ]

    # -- frames -------------------------------------------------------------
    mapped_cases: list[dict[str, Any]] = []
    for name, row in (
        ("ggal_five_levels", GGAL_ROW),
        ("ypfd_partial_depth", YPFD_ROW),
        ("bma_ci_settlement", BMA_ROW),
        ("pamp_ars", PAMP_ROW),
        ("supv_usd", SUPV_ROW),
    ):
        expected = ref_map_row(row)
        if expected is None:
            raise SystemExit(f"fixture authoring error (map): {name}")
        mapped_cases.append({"name": name, "row": row, "expectedRecord": expected})
    mapped_cases.append({"name": "unknown_term_dropped", "row": UNKNOWN_TERM_ROW, "expectedRecord": None})
    mapped_cases.append({"name": "non_dict_dropped", "row": "garbage", "expectedRecord": None})
    fixture["frames"] = {"mappedCases": mapped_cases}

    # Concatenated chunk: SendPrices(GGAL,BMA,PAMP,SUPV) + ping + SendIndexes +
    # SendMarketTotals + fragmento del frame YPFD.
    send_prices_frame = ref_send_prices_frame([GGAL_ROW, BMA_ROW, PAMP_ROW, SUPV_ROW])
    ypfd_frame = ref_send_prices_frame([YPFD_ROW])
    ping_frame = '{"type":6}' + RECORD_SEPARATOR
    indexes_frame = ref_frame("SendIndexes", [[{"index": "IM", "price": 812345.67}]])
    totals_frame = ref_frame("SendMarketTotals", [{"tradedAmount": 123456.78, "tradedVolume": 4321.0}])
    fragment = ypfd_frame[:60]

    concatenated_chunk = (
        send_prices_frame + ping_frame + indexes_frame + totals_frame + fragment
    )
    expected_frames, expected_remainder = ref_split_frames("", concatenated_chunk)
    if len(expected_frames) != 4 or expected_remainder != fragment:
        raise SystemExit("fixture authoring error (concatenated)")
    fixture["frames"]["concatenatedCase"] = {
        "name": "mixed_frames_and_fragment",
        "chunk": concatenated_chunk,
        "expectedFrames": expected_frames,
        "expectedRemainder": expected_remainder,
        "expectedPingReply": ref_ping_reply(),
        "expectedCounts": {"sendIndexes": 1, "sendMarketTotals": 1},
    }

    completed_frames, remainder_part = ref_split_frames(fragment, ypfd_frame[len(fragment):])
    if completed_frames != [ypfd_frame[:-1]] or remainder_part != "":
        raise SystemExit("fixture authoring error (fragmented)")
    fixture["frames"]["fragmentedCase"] = {
        "name": "ypfd_frame_split_across_chunks",
        "bufferBefore": "",
        "firstChunk": fragment,
        "expectedFramesAfterFirst": [],
        "expectedRemainderAfterFirst": fragment,
        "secondChunk": ypfd_frame[len(fragment):],
        "expectedFramesAfterSecond": completed_frames,
    }

    # -- redaction ----------------------------------------------------------
    redaction_cases = [
        {
            "name": "negotiate_url_token",
            "input": f"SignalR negotiate HTTP 500: {ref_negotiate_url(HUB_TOKEN)}",
            "expected": f"SignalR negotiate HTTP 500: {HUB_BASE}/{HUB_NAME}/negotiate?token=[REDACTED]&negotiateVersion=1",
        },
        {
            "name": "ws_url_token_and_id",
            "input": f"SignalR ws error: {ref_ws_url(HUB_TOKEN, CONNECTION_TOKEN)}",
            "expected": f"SignalR ws error: wss://hub.bullmarketbrokers.com/{HUB_NAME}?token=[REDACTED]&id=[REDACTED]",
        },
        {
            "name": "id_query_only",
            "input": f"handshake rejected at wss://fallback.local/?id={CONNECTION_TOKEN}",
            "expected": "handshake rejected at wss://fallback.local/?id=[REDACTED]",
        },
        {
            "name": "no_credentials_untouched",
            "input": "SignalR negotiate sin connectionToken/connectionId",
            "expected": "SignalR negotiate sin connectionToken/connectionId",
        },
    ]
    for case in redaction_cases:
        reference = ref_redact(case["input"])
        if reference != case["expected"]:
            raise SystemExit(f"fixture authoring error (redaction): {case['name']}")
    fixture["redactionCases"] = redaction_cases

    # -- JSONL L2_UPDATE lines (TS ingestion) -------------------------------
    l2_lines: list[dict[str, Any]] = []
    for name, row in (
        ("ggal", GGAL_ROW),
        ("bma_ci_skipped", BMA_ROW),
        ("supv", SUPV_ROW),
    ):
        record = ref_map_row(row)
        assert record is not None
        line = json.dumps({"event": "L2_UPDATE", "record": record}, ensure_ascii=False)
        if record["settlement"] == "24hs":
            expected_book = {
                "symbol": record["symbol"],
                "settlement": "24hs",
                "bids": sorted(
                    (dict(level) for level in record["bids"]),
                    key=lambda level: level["price"],
                    reverse=True,
                )[:5],
                "asks": sorted(
                    (dict(level) for level in record["asks"]),
                    key=lambda level: level["price"],
                )[:5],
                "asOfUtcSec": record["asOfUtcSec"],
                "source": "BMB_HOMEBROKER",
            }
        else:
            expected_book = None
        l2_lines.append({"name": name, "line": line, "expectedBook": expected_book})

    # Más de 5 niveles: se ordenan por precio y se truncan a 5 puntas.
    six_bid_record = {
        "symbol": "GGAL",
        "settlement": "24hs",
        "currency": "ARS",
        "asOfUtcSec": ref_datetime(GGAL_DATE),
        "last": 6450.5,
        "bids": [
            {"price": 6450.5, "size": 100.0, "orderCount": None},
            {"price": 6450.0, "size": 200.0, "orderCount": None},
            {"price": 6449.5, "size": 300.0, "orderCount": None},
            {"price": 6449.0, "size": 400.0, "orderCount": None},
            {"price": 6448.5, "size": 500.0, "orderCount": None},
            {"price": 6448.0, "size": 600.0, "orderCount": None},
        ],
        "asks": [{"price": 6451.0, "size": 700.0, "orderCount": None}],
        "source": "BMB_HOMEBROKER",
    }
    six_bid_line = json.dumps({"event": "L2_UPDATE", "record": six_bid_record}, ensure_ascii=False)
    l2_lines.append(
        {
            "name": "six_bids_truncated",
            "line": six_bid_line,
            "expectedBook": {
                "symbol": "GGAL",
                "settlement": "24hs",
                "bids": six_bid_record["bids"][:5],
                "asks": six_bid_record["asks"],
                "asOfUtcSec": six_bid_record["asOfUtcSec"],
                "source": "BMB_HOMEBROKER",
            },
        }
    )

    # Niveles inválidos se descartan a nivel de nivel, no de libro.
    bad_level_record = {
        "symbol": "PAMP",
        "settlement": "24hs",
        "currency": "ARS",
        "asOfUtcSec": ref_datetime(PAMP_DATE),
        "last": 1899.75,
        "bids": [
            {"price": "not-a-number", "size": 10.0, "orderCount": None},
            {"price": 1899.0, "size": 980.0, "orderCount": None},
        ],
        "asks": [{"price": 0, "size": 5.0, "orderCount": None}],
        "source": "BMB_HOMEBROKER",
    }
    bad_level_line = json.dumps({"event": "L2_UPDATE", "record": bad_level_record}, ensure_ascii=False)
    l2_lines.append(
        {
            "name": "invalid_levels_dropped",
            "line": bad_level_line,
            "expectedBook": {
                "symbol": "PAMP",
                "settlement": "24hs",
                "bids": [{"price": 1899.0, "size": 980.0, "orderCount": None}],
                "asks": [],
                "asOfUtcSec": bad_level_record["asOfUtcSec"],
                "source": "BMB_HOMEBROKER",
            },
        }
    )

    l2_lines.extend(
        [
            {"name": "invalid_json", "line": "oops-not-json", "expectedBook": None},
            {"name": "wrong_event", "line": json.dumps({"event": "OTHER", "record": {}}), "expectedBook": None},
            {
                "name": "ci_settlement_skipped",
                "line": json.dumps(
                    {
                        "event": "L2_UPDATE",
                        "record": {
                            "symbol": "BMA",
                            "settlement": "CI",
                            "bids": [{"price": 682.4, "size": 300.0, "orderCount": None}],
                            "asks": [],
                            "asOfUtcSec": ref_datetime(BMA_DATE),
                            "source": "BMB_HOMEBROKER",
                        },
                    }
                ),
                "expectedBook": None,
            },
            {
                "name": "empty_book_rejected",
                "line": json.dumps(
                    {
                        "event": "L2_UPDATE",
                        "record": {"symbol": "GGAL", "settlement": "24hs", "bids": [], "asks": []},
                    }
                ),
                "expectedBook": None,
            },
        ]
    )
    fixture["l2UpdateLines"] = l2_lines

    output_path = Path(__file__).resolve().parent.parent / "fixtures" / "bmb_inversiones_sendprices.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(fixture, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {output_path}")


if __name__ == "__main__":
    main()
