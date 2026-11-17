#!/usr/bin/env python3
"""Independent deterministic reference for the real-time propagation engine.

It is written from the institutional definitions of the terminal, not from the
TypeScript implementation, and emits `fixtures/realtime_propagation_reference.json`.
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo


MEP_BOND_PAIRS = [
    ("AL30", "AL30D"),
    ("GD30", "GD30D"),
    ("AE38", "AE38D"),
    ("AL35", "AL35D"),
    ("GD35", "GD35D"),
]

CCL_BOND_PAIRS = [
    ("AL30", "AL30C"),
    ("GD30", "GD30C"),
    ("AE38", "AE38C"),
    ("AL35", "AL35C"),
    ("GD35", "GD35C"),
]

ADR_RATIO_BY_AR_SYMBOL = {
    "GGAL": 10,
    "YPFD": 1,
    "PAMP": 25,
    "BMA": 10,
    "BBAR": 3,
    "SUPV": 5,
}

LIVE_TAPE_LIMIT = 200


def quote(market: str, symbol: str, price: float, as_of_utc_sec: int, volume: float | None = None) -> dict:
    row = {
        "market": market,
        "symbol": symbol,
        "price": price,
        "asOfUtcSec": as_of_utc_sec,
        "volume": volume,
    }
    return row


def median(values: list[float]) -> float | None:
    finite = sorted(v for v in values if math.isfinite(v) and v > 0)
    if not finite:
        return None
    middle = len(finite) // 2
    if len(finite) % 2 == 1:
        return finite[middle]
    return (finite[middle - 1] + finite[middle]) / 2


def compute_live_fx(quotes: list[dict]) -> dict:
    index = {
        (row["market"], row["symbol"].upper()): row
        for row in quotes
        if isinstance(row.get("price"), (int, float))
        and math.isfinite(row["price"])
        and row["price"] > 0
    }

    def bond_rate(local: str, foreign: str) -> float | None:
        a = index.get(("AR", local))
        b = index.get(("AR", foreign))
        if a is None or b is None:
            return None
        rate = a["price"] / b["price"]
        return rate if math.isfinite(rate) and rate > 0 else None

    mep_values = [rate for local, foreign in MEP_BOND_PAIRS if (rate := bond_rate(local, foreign)) is not None]
    ccl_bond_values = [rate for local, foreign in CCL_BOND_PAIRS if (rate := bond_rate(local, foreign)) is not None]
    ccl_adr_values: list[float] = []
    for ar_symbol, ratio in ADR_RATIO_BY_AR_SYMBOL.items():
        local = index.get(("AR", ar_symbol))
        foreign = index.get(("US", ar_symbol))
        if local is None or foreign is None:
            continue
        rate = local["price"] * ratio / foreign["price"]
        if math.isfinite(rate) and rate > 0:
            ccl_adr_values.append(rate)

    mep_median = median(mep_values)
    ccl_median = median(ccl_bond_values + ccl_adr_values)

    local = index.get(("AR", "GGAL"))
    foreign = index.get(("US", "GGAL"))
    ccl_implicit_ggal = None
    if local is not None and foreign is not None:
        value = local["price"] * 10 / foreign["price"]
        if math.isfinite(value) and value > 0:
            ccl_implicit_ggal = value

    canje_pct = None
    if mep_median is not None and ccl_median is not None:
        value = (ccl_median / mep_median - 1) * 100
        if math.isfinite(value):
            canje_pct = value

    return {
        "mepMedian": mep_median,
        "cclMedian": ccl_median,
        "cclImplicitGgal": ccl_implicit_ggal,
        "canjePct": canje_pct,
    }


def project_live_candle(bar: dict, tick: dict, bar_seconds: int) -> dict | None:
    if bar_seconds <= 0:
        return None
    price = tick["price"]
    time_sec = tick["timeSec"]
    if not math.isfinite(price) or price <= 0 or time_sec < 0:
        return None
    bucket_start = time_sec // bar_seconds * bar_seconds
    volume_delta = tick.get("volumeDelta")
    volume_delta = volume_delta if isinstance(volume_delta, (int, float)) and math.isfinite(volume_delta) and volume_delta >= 0 else 0
    if bucket_start == bar["timeSec"]:
        return {
            "timeSec": bar["timeSec"],
            "open": bar["open"],
            "high": max(bar["high"], price),
            "low": min(bar["low"], price),
            "close": price,
            "volume": bar["volume"] + volume_delta,
        }
    if bucket_start < bar["timeSec"]:
        return None
    return {
        "timeSec": bucket_start,
        "open": price,
        "high": price,
        "low": price,
        "close": price,
        "volume": volume_delta,
    }


def session_date_key(time_sec: int, market_tz: str) -> str:
    return datetime.fromtimestamp(time_sec, tz=timezone.utc).astimezone(ZoneInfo(market_tz)).strftime("%Y-%m-%d")


def project_live_session_vwap(closed_bars: list[dict], forming_bar: dict, market_tz: str) -> dict | None:
    if forming_bar["timeSec"] < 0 or forming_bar["close"] <= 0:
        return None
    session_key = session_date_key(forming_bar["timeSec"], market_tz)
    cumulative_pv = 0.0
    cumulative_volume = 0.0
    for bar in closed_bars:
        if bar["timeSec"] >= forming_bar["timeSec"]:
            continue
        if session_date_key(bar["timeSec"], market_tz) != session_key:
            continue
        typical_price = (bar["high"] + bar["low"] + bar["close"]) / 3
        volume = bar["volume"]
        if not math.isfinite(typical_price) or not math.isfinite(volume) or volume <= 0:
            continue
        cumulative_pv += typical_price * volume
        cumulative_volume += volume
    forming_typical_price = (forming_bar["high"] + forming_bar["low"] + forming_bar["close"]) / 3
    volume = forming_bar["volume"]
    if not math.isfinite(forming_typical_price) or not math.isfinite(volume) or volume <= 0:
        return None
    total_volume = cumulative_volume + volume
    if total_volume <= 0:
        return None
    value = (cumulative_pv + forming_typical_price * volume) / total_volume
    return {"timeSec": forming_bar["timeSec"], "value": value}


def project_live_cvd(last_cvd: float, ticks: list[dict]) -> float:
    cvd = last_cvd
    for tick in ticks:
        size = tick.get("size")
        side = tick.get("side")
        if size is None or not math.isfinite(size) or size <= 0:
            continue
        if side == "BUY":
            cvd += size
        elif side == "SELL":
            cvd -= size
    return cvd


def append_live_tape(tape: list[dict], tick: dict) -> list[dict]:
    same_symbol = [row for row in tape if row["market"] == tick["market"] and row["symbol"] == tick["symbol"]]
    next_same_symbol = (same_symbol + [tick])[-LIVE_TAPE_LIMIT:]
    other_symbols = [row for row in tape if not (row["market"] == tick["market"] and row["symbol"] == tick["symbol"])]
    return other_symbols + next_same_symbol


def main() -> None:
    as_of = 1_794_580_680
    fx_quotes = [
        quote("AR", "AL30", 1000.0, as_of),
        quote("AR", "AL30D", 50.0, as_of),
        quote("AR", "AL30C", 45.0, as_of),
        quote("AR", "GD30", 900.0, as_of),
        quote("AR", "GD30D", 45.0, as_of),
        quote("AR", "GD30C", 40.0, as_of),
        quote("AR", "GGAL", 1000.0, as_of),
        quote("US", "GGAL", 20.0, as_of),
    ]
    fx = compute_live_fx(fx_quotes)

    candle = {
        "timeSec": 1_794_580_680,
        "open": 100.0,
        "high": 101.0,
        "low": 99.0,
        "close": 100.5,
        "volume": 500.0,
    }
    candle_same_bucket = project_live_candle(
        candle,
        {"price": 101.7, "timeSec": 1_794_580_700, "volumeDelta": 30.0},
        60,
    )
    candle_new_bucket = project_live_candle(
        candle,
        {"price": 102.0, "timeSec": 1_794_580_740, "volumeDelta": 20.0},
        60,
    )

    closed_bars = [
        {
            "timeSec": 1_794_580_320,
            "open": 99.5,
            "high": 100.5,
            "low": 99.0,
            "close": 100.0,
            "volume": 400.0,
        },
        {
            "timeSec": 1_794_580_380,
            "open": 100.0,
            "high": 100.8,
            "low": 99.4,
            "close": 100.4,
            "volume": 350.0,
        },
    ]
    forming_bar = {
        "timeSec": 1_794_580_680,
        "open": 100.4,
        "high": 101.0,
        "low": 99.8,
        "close": 100.7,
        "volume": 120.0,
    }
    vwap = project_live_session_vwap(closed_bars, forming_bar, "America/New_York")

    cvd_ticks = [
        {"market": "AR", "symbol": "GGAL", "price": 1000.1, "size": 30.0, "side": "BUY", "timeSec": as_of},
        {"market": "AR", "symbol": "GGAL", "price": 999.8, "size": 12.0, "side": "SELL", "timeSec": as_of + 1},
        {"market": "US", "symbol": "GGAL", "price": 20.1, "size": 8.0, "side": None, "timeSec": as_of + 2},
    ]
    cvd = project_live_cvd(250.0, cvd_ticks)

    tape_before = [
        {"market": "AR", "symbol": "GGAL", "price": 1000.0, "size": 5.0, "side": "BUY", "timeSec": as_of - 1}
    ] * 200
    tape_tick = {
        "market": "AR",
        "symbol": "GGAL",
        "price": 1000.2,
        "size": 7.0,
        "side": "BUY",
        "timeSec": as_of,
    }
    tape_after = append_live_tape(tape_before, tape_tick)

    fixture = {
        "meta": {
            "precisionTolerance": 1e-12,
        },
        "fx": {
            "quotes": fx_quotes,
            "expected": fx,
        },
        "candle": {
            "bar": candle,
            "sameBucketTick": {
                "price": 101.7,
                "timeSec": 1_794_580_700,
                "volumeDelta": 30.0,
            },
            "sameBucketBarSeconds": 60,
            "expectedSameBucket": candle_same_bucket,
            "newBucketTick": {
                "price": 102.0,
                "timeSec": 1_794_580_740,
                "volumeDelta": 20.0,
            },
            "newBucketBarSeconds": 60,
            "expectedNewBucket": candle_new_bucket,
        },
        "sessionVwap": {
            "closedBars": closed_bars,
            "formingBar": forming_bar,
            "marketTz": "America/New_York",
            "expected": vwap,
        },
        "cvd": {
            "lastCvd": 250.0,
            "ticks": cvd_ticks,
            "expected": cvd,
        },
        "tapeAppend": {
            "before": tape_before,
            "tick": tape_tick,
            "expected": tape_after,
        },
    }

    out_path = Path(__file__).resolve().parents[1] / "fixtures" / "realtime_propagation_reference.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(fixture, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(out_path)


if __name__ == "__main__":
    main()
