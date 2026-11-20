#!/usr/bin/env python3
"""Independent Python reference generator for Pieza 48 (Phase 1 Optimization).

Generates fixtures/perf_phase1_reference.json without copying TypeScript logic.
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path

HIGH_WATER_MARK = 256 * 1024
LOW_WATER_MARK = 64 * 1024
KILL_WATER_MARK = 4 * 1024 * 1024
MAX_MISSED_HEARTBEATS = 2
BACKPRESSURE_CLOSE_CODE = 1013

OCC_PATTERN = re.compile(r"^(?:O:)?([A-Z][A-Z0-9.-]{0,6}?)(\d{6})([CP])(\d{8})$")


def extract_option_underlying(contract_symbol: str) -> str | None:
    cleaned = contract_symbol.strip().upper()
    m = OCC_PATTERN.match(cleaned)
    if not m:
        return None
    return m.group(1)


def should_emit_option_quote(
    view: str | None,
    focus_symbol: str | None,
    underlying: str | None,
) -> bool:
    if view != "options" or not focus_symbol or not underlying:
        return False
    return focus_symbol.strip().upper() == underlying.strip().upper()


def resolve_scoped_l2_symbol(view: str | None, focus_symbol: str | None) -> str | None:
    if view == "ggal_specialist":
        return "GGAL"
    if view == "stock_detail" and focus_symbol:
        return focus_symbol.strip().upper()
    return None


def evaluate_backpressure(buffered_amount: int, currently_conflating: bool) -> dict[str, object]:
    buf = max(0, buffered_amount)
    if buf > KILL_WATER_MARK:
        return {"action": "KILL", "nextConflating": True}
    if buf > HIGH_WATER_MARK:
        return {"action": "COALESCE", "nextConflating": True}
    if currently_conflating and buf > LOW_WATER_MARK:
        return {"action": "COALESCE", "nextConflating": True}
    return {"action": "SEND", "nextConflating": False}


def evaluate_heartbeat_sweep(pong_received: bool, consecutive_missed: int) -> dict[str, object]:
    if pong_received:
        return {"action": "PING", "nextMissed": 0}
    next_missed = max(0, consecutive_missed) + 1
    if next_missed >= MAX_MISSED_HEARTBEATS:
        return {"action": "TERMINATE", "nextMissed": next_missed}
    return {"action": "PING", "nextMissed": next_missed}


def _num_eq(a: float | int | None, b: float | int | None) -> bool:
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    if isinstance(a, float) and math.isnan(a) and isinstance(b, float) and math.isnan(b):
        return True
    return a == b


def has_market_quote_changed(prev: dict | None, nxt: dict) -> bool:
    if prev is None:
        return True
    num_fields = (
        "price",
        "previousClose",
        "changePct",
        "dayLow",
        "dayHigh",
        "volume",
        "turnover",
        "asOfUtcSec",
        "extendedPrice",
        "extendedChangePct",
        "regularClose",
    )
    str_fields = ("source", "settlement", "sessionPhase")
    for field in num_fields:
        if not _num_eq(prev.get(field), nxt.get(field)):
            return True
    for field in str_fields:
        if prev.get(field) != nxt.get(field):
            return True
    return False


def has_option_quote_changed(prev: dict | None, nxt: dict) -> bool:
    if prev is None:
        return True
    for field in ("bid", "ask", "mid", "last", "size"):
        if not _num_eq(prev.get(field), nxt.get(field)):
            return True
    return False


def main() -> None:
    underlying_inputs = [
        "O:SPY261218C00600000",
        "o:nvda261120p00140000",
        "GGAL261218C00055000",
        "BRK.B261218C00450000",
        "O:AAPL270115P00220000",
        "SPY",
        "O:123456C00100000",
        "",
    ]

    option_emit_cases = [
        {"view": "stock_detail", "focusSymbol": "NVDA", "underlying": "NVDA"},
        {"view": "ggal_specialist", "focusSymbol": "GGAL", "underlying": "GGAL"},
        {"view": "monitoring", "focusSymbol": None, "underlying": "SPY"},
        {"view": "options", "focusSymbol": "NVDA", "underlying": "NVDA"},
        {"view": "options", "focusSymbol": "NVDA", "underlying": "SPY"},
        {"view": "options", "focusSymbol": None, "underlying": "NVDA"},
        {"view": None, "focusSymbol": "NVDA", "underlying": "NVDA"},
    ]

    l2_scope_cases = [
        {"view": "ggal_specialist", "focusSymbol": "NVDA"},
        {"view": "stock_detail", "focusSymbol": "YPFD"},
        {"view": "stock_detail", "focusSymbol": None},
        {"view": "options", "focusSymbol": "GGAL"},
        {"view": "monitoring", "focusSymbol": "GGAL"},
        {"view": None, "focusSymbol": "GGAL"},
    ]

    backpressure_cases = [
        {"bufferedAmount": 0, "currentlyConflating": False},
        {"bufferedAmount": LOW_WATER_MARK, "currentlyConflating": True},
        {"bufferedAmount": LOW_WATER_MARK + 1, "currentlyConflating": True},
        {"bufferedAmount": HIGH_WATER_MARK, "currentlyConflating": False},
        {"bufferedAmount": HIGH_WATER_MARK + 1, "currentlyConflating": False},
        {"bufferedAmount": KILL_WATER_MARK, "currentlyConflating": True},
        {"bufferedAmount": KILL_WATER_MARK + 1, "currentlyConflating": False},
        {"bufferedAmount": KILL_WATER_MARK + 1, "currentlyConflating": True},
    ]

    heartbeat_sequences = [
        [
            {"pongReceived": True, "consecutiveMissed": 0},
            {"pongReceived": False, "consecutiveMissed": 0},
            {"pongReceived": True, "consecutiveMissed": 1},
            {"pongReceived": False, "consecutiveMissed": 0},
            {"pongReceived": False, "consecutiveMissed": 1},
        ]
    ]

    base_market_quote = {
        "market": "US",
        "symbol": "NVDA",
        "price": 142.5,
        "previousClose": 140.0,
        "changePct": 1.7857,
        "dayLow": 139.5,
        "dayHigh": 143.1,
        "volume": 1200000,
        "turnover": 171000000,
        "asOfUtcSec": 1794580680,
        "source": "TRADIER_WS",
        "settlement": None,
        "sessionPhase": "RTH",
        "extendedPrice": None,
        "extendedChangePct": None,
        "regularClose": 140.0,
    }
    market_diff_cases = [
        {"name": "initial_none", "prev": None, "next": base_market_quote},
        {"name": "identical", "prev": base_market_quote, "next": dict(base_market_quote)},
        {
            "name": "price_changed",
            "prev": base_market_quote,
            "next": {**base_market_quote, "price": 142.55},
        },
        {
            "name": "timestamp_only_changed",
            "prev": base_market_quote,
            "next": {**base_market_quote, "asOfUtcSec": 1794580681},
        },
        {
            "name": "phase_changed",
            "prev": base_market_quote,
            "next": {**base_market_quote, "sessionPhase": "AFTER_HOURS"},
        },
    ]

    base_option_quote = {
        "symbol": "O:NVDA261120C00140000",
        "underlying": "NVDA",
        "time": 1794580680,
        "bid": 5.2,
        "ask": 5.4,
        "mid": 5.3,
        "last": 5.35,
        "size": 10,
    }
    option_diff_cases = [
        {"name": "initial_none", "prev": None, "next": base_option_quote},
        {"name": "identical", "prev": base_option_quote, "next": dict(base_option_quote)},
        {
            "name": "time_only_unchanged_quote",
            "prev": base_option_quote,
            "next": {**base_option_quote, "time": 1794580690},
        },
        {
            "name": "bid_changed",
            "prev": base_option_quote,
            "next": {**base_option_quote, "bid": 5.25, "mid": 5.325},
        },
        {
            "name": "last_trade_changed",
            "prev": base_option_quote,
            "next": {**base_option_quote, "last": 5.4, "size": 25},
        },
    ]

    payload = {
        "meta": {
            "highWaterMark": HIGH_WATER_MARK,
            "lowWaterMark": LOW_WATER_MARK,
            "killWaterMark": KILL_WATER_MARK,
            "maxMissedHeartbeats": MAX_MISSED_HEARTBEATS,
            "backpressureCloseCode": BACKPRESSURE_CLOSE_CODE,
        },
        "extractUnderlying": [
            {"input": raw, "expected": extract_option_underlying(raw)}
            for raw in underlying_inputs
        ],
        "optionEmitCases": [
            {
                **case,
                "expected": should_emit_option_quote(
                    case["view"], case["focusSymbol"], case["underlying"]
                ),
            }
            for case in option_emit_cases
        ],
        "l2ScopeCases": [
            {
                **case,
                "expected": resolve_scoped_l2_symbol(case["view"], case["focusSymbol"]),
            }
            for case in l2_scope_cases
        ],
        "backpressureCases": [
            {
                **case,
                "expected": evaluate_backpressure(
                    case["bufferedAmount"], case["currentlyConflating"]
                ),
            }
            for case in backpressure_cases
        ],
        "heartbeatSequence": [
            {
                **step,
                "expected": evaluate_heartbeat_sweep(
                    step["pongReceived"], step["consecutiveMissed"]
                ),
            }
            for step in heartbeat_sequences[0]
        ],
        "marketQuoteDiffCases": [
            {
                **case,
                "expected": has_market_quote_changed(case["prev"], case["next"]),
            }
            for case in market_diff_cases
        ],
        "optionQuoteDiffCases": [
            {
                **case,
                "expected": has_option_quote_changed(case["prev"], case["next"]),
            }
            for case in option_diff_cases
        ],
    }

    out_path = Path(__file__).resolve().parents[1] / "fixtures" / "perf_phase1_reference.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
