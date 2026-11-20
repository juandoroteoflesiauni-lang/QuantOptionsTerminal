#!/usr/bin/env python3
"""Referencia independiente para estabilidad de navegación del gráfico de Stock Detail.

Genera `fixtures/stock_detail_chart_navigation_reference.json` sin copiar la
implementación TypeScript, validando de forma explícita:
- generación de claves de dataset (`ticker|timeframe|firstBarTime`),
- transición de viewport (cuándo ejecutar `fitContent` vs preservar zoom/pan
  y cuándo actualizar solo la última vela),
- supresión de bucles en sincronización bidireccional de rango lógico,
- resolución de ancla AVWAP únicamente por clic en modo `CLICKED_CANDLE`.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence


def py_is_finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def py_valid_range(rng: Optional[Dict[str, Any]]) -> bool:
    if rng is None:
        return False
    f = rng.get("from")
    t = rng.get("to")
    return py_is_finite(f) and py_is_finite(t) and float(f) <= float(t)


def py_fit_key(ticker: str, timeframe: str, bars_available: bool, first_bar_time: Any) -> Optional[str]:
    if not bars_available or not py_is_finite(first_bar_time):
        return None
    sym = ticker.strip().upper()
    tf = timeframe.strip()
    if sym == "" or tf == "":
        return None
    t_num = int(first_bar_time) if float(first_bar_time).is_integer() else float(first_bar_time)
    return f"{sym}|{tf}|{t_num}"


def py_viewport_transition(case: Dict[str, Any]) -> Dict[str, Any]:
    prev_key = case["previousKey"]
    next_key = case["nextKey"]
    prev_count = case["previousBarCount"]
    next_count = case["nextBarCount"]
    prev_first = case["previousFirstBarTime"]
    next_first = case["nextFirstBarTime"]
    prev_last = case["previousLastBarTime"]
    next_last = case["nextLastBarTime"]

    if next_key is None or not isinstance(next_count, int) or isinstance(next_count, bool) or next_count <= 0:
        return {"shouldFitContent": False, "updateMode": "CLEAR"}

    if prev_key is None or not isinstance(prev_count, int) or isinstance(prev_count, bool) or prev_count <= 0:
        return {"shouldFitContent": True, "updateMode": "SET_DATA"}

    same_dataset = (
        prev_key == next_key
        and prev_first == next_first
        and py_is_finite(prev_first)
        and py_is_finite(next_first)
    )
    should_fit = (not same_dataset) or abs(next_count - prev_count) > 2

    if same_dataset and py_is_finite(prev_last) and py_is_finite(next_last):
        if next_count == prev_count and float(next_last) == float(prev_last):
            update_mode = "UPDATE_LAST"
        elif next_count == prev_count + 1 and float(next_last) > float(prev_last):
            update_mode = "UPDATE_LAST"
        else:
            update_mode = "SET_DATA"
    else:
        update_mode = "SET_DATA"

    return {"shouldFitContent": should_fit, "updateMode": update_mode}


def py_ranges_close(a: Optional[Dict[str, Any]], b: Optional[Dict[str, Any]], tol: float) -> bool:
    if not py_is_finite(tol) or float(tol) < 0.0:
        return False
    if not py_valid_range(a) or not py_valid_range(b):
        return False
    assert a is not None and b is not None
    return abs(float(a["from"]) - float(b["from"])) <= float(tol) and abs(float(a["to"]) - float(b["to"])) <= float(tol)


def py_should_apply_external(current: Optional[Dict[str, Any]], incoming: Optional[Dict[str, Any]], tol: float = 1e-4) -> bool:
    if not py_valid_range(incoming):
        return False
    if current is not None and py_ranges_close(current, incoming, tol):
        return False
    return True


def py_should_emit_sync(
    emitted: Optional[Dict[str, Any]],
    suppressed: bool,
    pending_external: Optional[Dict[str, Any]],
    tol: float = 1e-3,
) -> bool:
    if suppressed or not py_valid_range(emitted):
        return False
    if pending_external is not None and py_ranges_close(emitted, pending_external, tol):
        return False
    return True


def py_avwap_click_anchor(mode: str, clicked: Optional[float], current: Optional[float]) -> Optional[float]:
    if mode != "CLICKED_CANDLE":
        return None
    if clicked is not None and py_is_finite(clicked):
        return float(clicked)
    if current is not None and py_is_finite(current):
        return float(current)
    return None


def main() -> None:
    fit_key_cases = [
        {"name": "qqq_daily_valid", "ticker": " qqq ", "timeframe": "1D", "barsAvailable": True, "firstBarTime": 1637366400},
        {"name": "ggal_ar_intraday", "ticker": "AR:GGAL", "timeframe": "15m", "barsAvailable": True, "firstBarTime": 1760000400},
        {"name": "unavailable_bars", "ticker": "QQQ", "timeframe": "1m", "barsAvailable": False, "firstBarTime": 1760000400},
        {"name": "missing_first_bar", "ticker": "QQQ", "timeframe": "1D", "barsAvailable": True, "firstBarTime": None},
        {"name": "empty_ticker", "ticker": "   ", "timeframe": "1D", "barsAvailable": True, "firstBarTime": 1760000400},
    ]

    viewport_cases = [
        {
            "name": "initial_load_fits_once",
            "input": {
                "previousKey": None,
                "nextKey": "QQQ|1D|1637366400",
                "previousBarCount": 0,
                "nextBarCount": 1250,
                "previousFirstBarTime": None,
                "nextFirstBarTime": 1637366400,
                "previousLastBarTime": None,
                "nextLastBarTime": 1795046400,
            },
        },
        {
            "name": "live_tick_forming_bar_preserves_zoom",
            "input": {
                "previousKey": "QQQ|1D|1637366400",
                "nextKey": "QQQ|1D|1637366400",
                "previousBarCount": 1250,
                "nextBarCount": 1250,
                "previousFirstBarTime": 1637366400,
                "nextFirstBarTime": 1637366400,
                "previousLastBarTime": 1795046400,
                "nextLastBarTime": 1795046400,
            },
        },
        {
            "name": "single_new_bar_rollover_preserves_zoom",
            "input": {
                "previousKey": "QQQ|1m|1794900000",
                "nextKey": "QQQ|1m|1794900000",
                "previousBarCount": 1000,
                "nextBarCount": 1001,
                "previousFirstBarTime": 1794900000,
                "nextFirstBarTime": 1794900000,
                "previousLastBarTime": 1794959940,
                "nextLastBarTime": 1794960000,
            },
        },
        {
            "name": "two_bar_catchup_set_data_without_refit",
            "input": {
                "previousKey": "QQQ|1m|1794900000",
                "nextKey": "QQQ|1m|1794900000",
                "previousBarCount": 1000,
                "nextBarCount": 1002,
                "previousFirstBarTime": 1794900000,
                "nextFirstBarTime": 1794900000,
                "previousLastBarTime": 1794959940,
                "nextLastBarTime": 1794960060,
            },
        },
        {
            "name": "deeper_history_backfill_refits",
            "input": {
                "previousKey": "AR:GGAL|1D|1760000000",
                "nextKey": "AR:GGAL|1D|1700000000",
                "previousBarCount": 250,
                "nextBarCount": 1250,
                "previousFirstBarTime": 1760000000,
                "nextFirstBarTime": 1700000000,
                "previousLastBarTime": 1795046400,
                "nextLastBarTime": 1795046400,
            },
        },
        {
            "name": "timeframe_switch_refits",
            "input": {
                "previousKey": "QQQ|1D|1637366400",
                "nextKey": "QQQ|15m|1790000000",
                "previousBarCount": 1250,
                "nextBarCount": 1000,
                "previousFirstBarTime": 1637366400,
                "nextFirstBarTime": 1790000000,
                "previousLastBarTime": 1795046400,
                "nextLastBarTime": 1795046400,
            },
        },
        {
            "name": "ticker_switch_refits",
            "input": {
                "previousKey": "QQQ|1D|1637366400",
                "nextKey": "SPY|1D|1637366400",
                "previousBarCount": 1250,
                "nextBarCount": 1250,
                "previousFirstBarTime": 1637366400,
                "nextFirstBarTime": 1637366400,
                "previousLastBarTime": 1795046400,
                "nextLastBarTime": 1795046400,
            },
        },
        {
            "name": "same_start_large_expansion_refits",
            "input": {
                "previousKey": "AR:YPFD|1D|1700000000",
                "nextKey": "AR:YPFD|1D|1700000000",
                "previousBarCount": 120,
                "nextBarCount": 620,
                "previousFirstBarTime": 1700000000,
                "nextFirstBarTime": 1700000000,
                "previousLastBarTime": 1740000000,
                "nextLastBarTime": 1795046400,
            },
        },
        {
            "name": "bars_become_unavailable_clears",
            "input": {
                "previousKey": "QQQ|1D|1637366400",
                "nextKey": None,
                "previousBarCount": 1250,
                "nextBarCount": 0,
                "previousFirstBarTime": 1637366400,
                "nextFirstBarTime": None,
                "previousLastBarTime": 1795046400,
                "nextLastBarTime": None,
            },
        },
    ]

    range_apply_cases = [
        {
            "name": "apply_when_current_missing",
            "current": None,
            "incoming": {"from": 900.25, "to": 1249.5},
            "tolerance": 1e-4,
        },
        {
            "name": "skip_when_within_jitter_tolerance",
            "current": {"from": 900.25, "to": 1249.5},
            "incoming": {"from": 900.25005, "to": 1249.49996},
            "tolerance": 1e-4,
        },
        {
            "name": "apply_when_user_scrolled_beyond_tolerance",
            "current": {"from": 900.25, "to": 1249.5},
            "incoming": {"from": 899.75, "to": 1249.0},
            "tolerance": 1e-4,
        },
        {
            "name": "reject_inverted_incoming_range",
            "current": {"from": 100.0, "to": 200.0},
            "incoming": {"from": 250.0, "to": 200.0},
            "tolerance": 1e-4,
        },
    ]

    range_emit_cases = [
        {
            "name": "emit_normal_user_pan",
            "emitted": {"from": 820.5, "to": 1180.5},
            "isSuppressed": False,
            "pendingExternal": None,
            "tolerance": 1e-3,
        },
        {
            "name": "suppress_when_flag_active",
            "emitted": {"from": 820.5, "to": 1180.5},
            "isSuppressed": True,
            "pendingExternal": None,
            "tolerance": 1e-3,
        },
        {
            "name": "suppress_echo_matching_pending_external_range",
            "emitted": {"from": 820.5004, "to": 1180.4997},
            "isSuppressed": False,
            "pendingExternal": {"from": 820.5, "to": 1180.5},
            "tolerance": 1e-3,
        },
        {
            "name": "emit_when_user_moved_away_from_pending_range",
            "emitted": {"from": 815.0, "to": 1175.0},
            "isSuppressed": False,
            "pendingExternal": {"from": 820.5, "to": 1180.5},
            "tolerance": 1e-3,
        },
        {
            "name": "suppress_null_range",
            "emitted": None,
            "isSuppressed": False,
            "pendingExternal": None,
            "tolerance": 1e-3,
        },
    ]

    avwap_click_cases = [
        {"name": "month_start_ignores_click", "mode": "MONTH_START", "clicked": 1794000000, "current": 1793000000},
        {"name": "session_start_clears_anchor", "mode": "SESSION_START", "clicked": 1794000000, "current": 1793000000},
        {"name": "clicked_candle_updates_on_click", "mode": "CLICKED_CANDLE", "clicked": 1794000000, "current": 1793000000},
        {"name": "clicked_candle_keeps_existing_when_click_null", "mode": "CLICKED_CANDLE", "clicked": None, "current": 1793000000},
        {"name": "clicked_candle_returns_none_when_both_null", "mode": "CLICKED_CANDLE", "clicked": None, "current": None},
    ]

    payload = {
        "meta": {"precisionTolerance": 1e-9},
        "fitKeyCases": [
            {**c, "expected": py_fit_key(c["ticker"], c["timeframe"], c["barsAvailable"], c["firstBarTime"])}
            for c in fit_key_cases
        ],
        "viewportCases": [
            {**c, "expected": py_viewport_transition(c["input"])}
            for c in viewport_cases
        ],
        "rangeApplyCases": [
            {
                **c,
                "expected": py_should_apply_external(c["current"], c["incoming"], c["tolerance"]),
            }
            for c in range_apply_cases
        ],
        "rangeEmitCases": [
            {
                **c,
                "expected": py_should_emit_sync(c["emitted"], c["isSuppressed"], c["pendingExternal"], c["tolerance"]),
            }
            for c in range_emit_cases
        ],
        "avwapClickCases": [
            {
                **c,
                "expected": py_avwap_click_anchor(c["mode"], c["clicked"], c["current"]),
            }
            for c in avwap_click_cases
        ],
    }

    out_path = Path(__file__).resolve().parent.parent / "fixtures" / "stock_detail_chart_navigation_reference.json"
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
