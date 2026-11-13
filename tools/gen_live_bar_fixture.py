"""Independent Python reference generator for Pieza 7 (Live WebSocket bar consolidator & projections)."""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

ET_TZ = ZoneInfo("America/New_York")


def utc_ms(year: int, month: int, day: int, hour: int, minute: int, second: int = 0, ms: int = 0) -> int:
    dt = datetime(year, month, day, hour, minute, second, ms * 1000, tzinfo=timezone.utc)
    return int(round(dt.timestamp() * 1000))


def is_equity_rth(time_sec: int) -> bool:
    dt_et = datetime.fromtimestamp(time_sec, tz=timezone.utc).astimezone(ET_TZ)
    if dt_et.weekday() >= 5:
        return False
    mins = dt_et.hour * 60 + dt_et.minute
    return 9 * 60 + 30 <= mins < 16 * 60


def aggregate_ohlcv(bucket_time: int, bars: list[dict[str, Any]]) -> dict[str, Any]:
    assert bars, "cannot aggregate empty bar list"
    o = float(bars[0]["open"])
    c = float(bars[-1]["close"])
    h = max(float(b["high"]) for b in bars)
    l = min(float(b["low"]) for b in bars)
    vol = sum(float(b["volume"]) for b in bars)

    notional = 0.0
    all_have_vw = True
    for b in bars:
        v = float(b["volume"])
        if v > 0:
            vw = b.get("vw")
            if vw is None or not math.isfinite(float(vw)) or float(vw) <= 0:
                all_have_vw = False
            else:
                notional += float(vw) * v

    out: dict[str, Any] = {
        "time": bucket_time,
        "open": o,
        "high": h,
        "low": l,
        "close": c,
        "volume": vol,
    }
    if vol > 0 and all_have_vw:
        out["vw"] = notional / vol
    return out


def compute_exact_ema_projection(closed_bars: list[dict[str, Any]], forming_close: float, period: int) -> tuple[float, float]:
    """Compute exact closed EMA seeded with first `period` SMA, then project one live step."""
    alpha = 2.0 / (period + 1.0)
    seed_closes = [float(b["close"]) for b in closed_bars[:period]]
    ema = sum(seed_closes) / period
    for b in closed_bars[period:]:
        ema = alpha * float(b["close"]) + (1.0 - alpha) * ema
    live = alpha * forming_close + (1.0 - alpha) * ema
    return ema, live


def compute_exact_session_vwap(bars_with_forming: list[dict[str, Any]]) -> dict[str, Any]:
    """Independent weighted mean without Welford."""
    cum_vol = 0.0
    cum_notional = 0.0
    last_time = 0
    last_src = "NONE"

    for b in bars_with_forming:
        t = int(b["time"])
        last_time = t
        if not is_equity_rth(t):
            continue
        vol = float(b["volume"])
        if b.get("vw") is not None and float(b["vw"]) > 0:
            price = float(b["vw"])
            last_src = "VW"
        else:
            price = (float(b["high"]) + float(b["low"]) + float(b["close"])) / 3.0
            last_src = "HLC3"
        if vol > 0:
            cum_vol += vol
            cum_notional += price * vol

    vwap = cum_notional / cum_vol
    return {
        "time": last_time,
        "vwap": vwap,
        "cumVolume": cum_vol,
        "frozen": not is_equity_rth(last_time),
        "source": last_src,
    }


def compute_exact_avwap_point(bars_with_forming: list[dict[str, Any]]) -> dict[str, Any]:
    """Independent two-pass weighted mean and weighted variance for AVWAP HLC3."""
    pairs: list[tuple[float, float]] = []
    last_time = int(bars_with_forming[-1]["time"])
    for b in bars_with_forming:
        vol = float(b["volume"])
        if vol > 0:
            hlc3 = (float(b["high"]) + float(b["low"]) + float(b["close"])) / 3.0
            pairs.append((hlc3, vol))

    cum_vol = sum(v for _, v in pairs)
    mean = sum(p * v for p, v in pairs) / cum_vol
    variance = max(0.0, sum(v * (p - mean) ** 2 for p, v in pairs) / cum_vol)
    std_dev = math.sqrt(variance)

    return {
        "time": last_time,
        "vwap": mean,
        "stdDev": std_dev,
        "cumVolume": cum_vol,
        "upper1": mean + std_dev,
        "lower1": mean - std_dev,
        "upper2": mean + 2.0 * std_dev,
        "lower2": mean - 2.0 * std_dev,
        "upper2_5": mean + 2.5 * std_dev,
        "lower2_5": mean - 2.5 * std_dev,
    }


def main() -> None:
    # 2026-11-13 is a Friday; 14:30 UTC == 09:30 ET (EST, UTC-5)
    t_1430 = utc_ms(2026, 11, 13, 14, 30, 0)
    t_1431 = utc_ms(2026, 11, 13, 14, 31, 0)
    t_1432 = utc_ms(2026, 11, 13, 14, 32, 0)
    t_1433 = utc_ms(2026, 11, 13, 14, 33, 0)
    t_1434 = utc_ms(2026, 11, 13, 14, 34, 0)
    t_1435 = utc_ms(2026, 11, 13, 14, 35, 0)

    initial_closed = [
        {
            "time": t_1430 // 1000,
            "open": 594.00,
            "high": 594.80,
            "low": 593.90,
            "close": 594.60,
            "volume": 3200.0,
            "vw": 594.35,
        },
        {
            "time": t_1431 // 1000,
            "open": 594.60,
            "high": 595.15,
            "low": 594.50,
            "close": 595.10,
            "volume": 2800.0,
            "vw": 594.88,
        },
    ]

    # Scenario 1: T -> A overwrite -> A rebroadcast overwrite -> stale T -> next min T rollover -> AM seal
    s1_step_trades = [
        {"ev": "T", "sym": "SPY", "p": 595.10, "s": 40, "t": t_1432 + 250},
        {"ev": "T", "sym": "SPY", "p": 595.20, "s": 60, "t": t_1432 + 800},
    ]
    expected_after_trades = {
        "time": t_1432 // 1000,
        "open": 595.10,
        "high": 595.20,
        "low": 595.10,
        "close": 595.20,
        "volume": 100.0,
        "vw": (595.10 * 40.0 + 595.20 * 60.0) / 100.0,
    }

    s1_step_a_bars = [
        {
            "ev": "A",
            "sym": "SPY",
            "o": 595.10,
            "h": 595.25,
            "l": 595.05,
            "c": 595.20,
            "v": 150,
            "vw": 595.18,
            "s": t_1432,
            "e": t_1432 + 1000,
        },
        {
            "ev": "A",
            "sym": "SPY",
            "o": 595.20,
            "h": 595.40,
            "l": 595.15,
            "c": 595.35,
            "v": 200,
            "vw": 595.28,
            "s": t_1432 + 5000,
            "e": t_1432 + 6000,
        },
    ]
    # Authoritative A at 14:32:00 overwrites T slots (40+60 dropped, replaced by 150) + adds 14:32:05 (200)
    expected_after_a_bars = {
        "time": t_1432 // 1000,
        "open": 595.10,
        "high": 595.40,
        "low": 595.05,
        "close": 595.35,
        "volume": 350.0,
        "vw": (595.18 * 150.0 + 595.28 * 200.0) / 350.0,
    }

    s1_step_a_rebroadcast_and_stale_t = [
        {
            "ev": "A",
            "sym": "SPY",
            "o": 595.20,
            "h": 595.45,
            "l": 595.15,
            "c": 595.40,
            "v": 250,
            "vw": 595.31,
            "s": t_1432 + 5000,
            "e": t_1432 + 6000,
        },
        # Stale tick arriving inside already A-closed second 14:32:05 -> must be ignored
        {"ev": "T", "sym": "SPY", "p": 594.00, "s": 500, "t": t_1432 + 5900},
    ]
    expected_after_a_rebroadcast = {
        "time": t_1432 // 1000,
        "open": 595.10,
        "high": 595.45,
        "low": 595.05,
        "close": 595.40,
        "volume": 400.0,
        "vw": (595.18 * 150.0 + 595.31 * 250.0) / 400.0,
    }

    s1_step_next_min_tick_then_am = [
        {"ev": "T", "sym": "SPY", "p": 595.50, "s": 100, "t": t_1433 + 1100},
        {
            "ev": "AM",
            "sym": "SPY",
            "o": 595.10,
            "h": 595.48,
            "l": 595.05,
            "c": 595.42,
            "v": 1950,
            "vw": 595.29,
            "s": t_1432,
            "e": t_1433,
        },
    ]
    closed_1432 = {
        "time": t_1432 // 1000,
        "open": 595.10,
        "high": 595.48,
        "low": 595.05,
        "close": 595.42,
        "volume": 1950.0,
        "vw": 595.29,
    }
    forming_1433 = {
        "time": t_1433 // 1000,
        "open": 595.50,
        "high": 595.50,
        "low": 595.50,
        "close": 595.50,
        "volume": 100.0,
        "vw": 595.50,
    }

    # Scenario 2: AM 15-min FINRA TRF rebroadcast overwrite (must overwrite closed_bars[0], never add)
    am_rebroadcast_1430 = {
        "ev": "AM",
        "sym": "SPY",
        "o": 594.00,
        "h": 596.00,
        "l": 593.90,
        "c": 594.60,
        "v": 5400,
        "vw": 594.85,
        "s": t_1430,
        "e": t_1431,
    }
    overwritten_1430 = {
        "time": t_1430 // 1000,
        "open": 594.00,
        "high": 596.00,
        "low": 593.90,
        "close": 594.60,
        "volume": 5400.0,
        "vw": 594.85,
    }

    # Scenario 3: Multi-minute 5m (300s) consolidation from 5 AM bars + late AM rebroadcast
    am_5m_stream = [
        {"ev": "AM", "sym": "SPY", "o": 100.0, "h": 101.0, "l": 99.5, "c": 100.5, "v": 1000, "vw": 100.2, "s": t_1430, "e": t_1431},
        {"ev": "AM", "sym": "SPY", "o": 100.5, "h": 101.5, "l": 100.0, "c": 101.0, "v": 1200, "vw": 100.8, "s": t_1431, "e": t_1432},
        {"ev": "AM", "sym": "SPY", "o": 101.0, "h": 102.0, "l": 100.8, "c": 101.4, "v": 800, "vw": 101.3, "s": t_1432, "e": t_1433},
        {"ev": "AM", "sym": "SPY", "o": 101.4, "h": 101.8, "l": 100.9, "c": 101.2, "v": 900, "vw": 101.1, "s": t_1433, "e": t_1434},
        {"ev": "AM", "sym": "SPY", "o": 101.2, "h": 102.5, "l": 101.0, "c": 102.2, "v": 1100, "vw": 101.9, "s": t_1434, "e": t_1435},
    ]
    five_min_bars_initial = [
        {"time": b["s"] // 1000, "open": b["o"], "high": b["h"], "low": b["l"], "close": b["c"], "volume": float(b["v"]), "vw": b["vw"]}
        for b in am_5m_stream
    ]
    expected_5m_initial = aggregate_ohlcv(t_1430 // 1000, five_min_bars_initial)

    am_5m_rebroadcast_1432 = {
        "ev": "AM",
        "sym": "SPY",
        "o": 101.0,
        "h": 103.0,
        "l": 100.8,
        "c": 101.4,
        "v": 1800,
        "vw": 102.1,
        "s": t_1432,
        "e": t_1433,
    }
    five_min_bars_updated = list(five_min_bars_initial)
    five_min_bars_updated[2] = {
        "time": t_1432 // 1000,
        "open": 101.0,
        "high": 103.0,
        "low": 100.8,
        "close": 101.4,
        "volume": 1800.0,
        "vw": 102.1,
    }
    expected_5m_after_rebroadcast = aggregate_ohlcv(t_1430 // 1000, five_min_bars_updated)

    # Scenario 4: Sub-minute 1s barSeconds=1 rebroadcast overwrite
    a_1s_stream = [
        {"ev": "A", "sym": "SPY", "o": 500.0, "h": 500.5, "l": 499.9, "c": 500.3, "v": 200, "vw": 500.2, "s": t_1430, "e": t_1430 + 1000},
        {"ev": "A", "sym": "SPY", "o": 500.0, "h": 501.0, "l": 499.9, "c": 500.8, "v": 350, "vw": 500.5, "s": t_1430, "e": t_1430 + 1000},
    ]
    expected_1s_overwritten = {
        "time": t_1430 // 1000,
        "open": 500.0,
        "high": 501.0,
        "low": 499.9,
        "close": 500.8,
        "volume": 350.0,
        "vw": 500.5,
    }

    # Scenario 5: Live indicator projections (EMA period 3, EQUITY Session VWAP, EQUITY SESSION AVWAP)
    proj_closed_bars = initial_closed + [closed_1432]
    proj_forming_1433_a = [
        {
            "ev": "A",
            "sym": "SPY",
            "o": 595.45,
            "h": 596.10,
            "l": 595.40,
            "c": 595.95,
            "v": 450,
            "vw": 595.78,
            "s": t_1433,
            "e": t_1433 + 1000,
        },
        {
            "ev": "T",
            "sym": "SPY",
            "p": 596.05,
            "s": 150,
            "t": t_1433 + 1500,
        },
    ]
    proj_forming_bar = {
        "time": t_1433 // 1000,
        "open": 595.45,
        "high": 596.10,
        "low": 595.40,
        "close": 596.05,
        "volume": 600.0,
        "vw": (595.78 * 450.0 + 596.05 * 150.0) / 600.0,
    }
    ema_closed, ema_live = compute_exact_ema_projection(proj_closed_bars, proj_forming_bar["close"], period=3)
    session_vwap_live = compute_exact_session_vwap(proj_closed_bars + [proj_forming_bar])
    avwap_live = compute_exact_avwap_point(proj_closed_bars + [proj_forming_bar])

    # Scenario 6: Validation & discards
    invalid_batch = [
        # Valid status + valid trade
        {"ev": "status", "status": "success", "message": "subscribed"},
        # Invalid: timestamp in seconds (< 1e11)
        {"ev": "AM", "sym": "SPY", "o": 100, "h": 101, "l": 99, "c": 100.5, "v": 10, "s": t_1430 // 1000, "e": t_1431 // 1000},
        # Invalid: high < low
        {"ev": "A", "sym": "SPY", "o": 100, "h": 98, "l": 99, "c": 99.5, "v": 10, "s": t_1430, "e": t_1430 + 1000},
        # Invalid: negative price
        {"ev": "T", "sym": "SPY", "p": -10, "s": 5, "t": t_1430 + 200},
        # Invalid: negative volume
        {"ev": "T", "sym": "SPY", "p": 100, "s": -5, "t": t_1430 + 300},
        # Invalid: non-object row
        "bad-row",
    ]

    fixture = {
        "meta": {
            "generator": "tools/gen_live_bar_fixture.py",
            "precisionTolerance": 1e-9,
        },
        "scenario1_ticks_a_am": {
            "initialClosedBars": initial_closed,
            "step1Trades": s1_step_trades,
            "expectedAfterStep1": expected_after_trades,
            "step2ABars": s1_step_a_bars,
            "expectedAfterStep2": expected_after_a_bars,
            "step3ARebroadcastAndStaleT": s1_step_a_rebroadcast_and_stale_t,
            "expectedAfterStep3": expected_after_a_rebroadcast,
            "expectedSecondRebroadcastOverwritesAfterStep3": 1,
            "expectedStaleEventsIgnoredAfterStep3": 1,
            "step4NextMinTickAndAm": s1_step_next_min_tick_then_am,
            "expectedClosedBarsAfterStep4": initial_closed + [closed_1432],
            "expectedFormingBarAfterStep4": forming_1433,
        },
        "scenario2_am_rebroadcast": {
            "closedBarsBefore": initial_closed + [closed_1432],
            "rebroadcastEvent": am_rebroadcast_1430,
            "expectedClosedBarsAfter": [overwritten_1430, initial_closed[1], closed_1432],
            "expectedRebroadcastOverwrites": 1,
        },
        "scenario3_5m_consolidation": {
            "barSeconds": 300,
            "initialAmEvents": am_5m_stream,
            "expectedClosed5mInitial": [expected_5m_initial],
            "rebroadcastAmEvent": am_5m_rebroadcast_1432,
            "expectedClosed5mAfterRebroadcast": [expected_5m_after_rebroadcast],
        },
        "scenario4_1s_rebroadcast": {
            "barSeconds": 1,
            "events": a_1s_stream,
            "expectedClosedBars": [expected_1s_overwritten],
            "expectedRebroadcastOverwrites": 1,
        },
        "scenario5_live_projections": {
            "closedBars": proj_closed_bars,
            "formingEvents": proj_forming_1433_a,
            "expectedFormingBar": proj_forming_bar,
            "emaPeriod": 3,
            "expectedClosedEma": ema_closed,
            "expectedLiveEma": ema_live,
            "expectedLiveSessionVwap": session_vwap_live,
            "expectedLiveAvwap": avwap_live,
        },
        "scenario6_invalid_discards": {
            "payload": invalid_batch,
            "expectedAcceptedCount": 1,
            "expectedDiscardedCount": 5,
            "expectedDiscardCounts": {
                "malformedRow": 1,
                "invalidTime": 1,
                "nonFinite": 0,
                "invalidPrice": 1,
                "highBelowLow": 1,
                "invalidOhlc": 0,
                "invalidVolume": 1,
                "duplicate": 0,
            },
        },
    }

    out_path = Path(__file__).resolve().parents[1] / "fixtures" / "live_bar_reference.json"
    out_path.write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {out_path} successfully.")


if __name__ == "__main__":
    main()
