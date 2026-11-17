#!/usr/bin/env python3
"""Independent reference fixture for the Pieza 39 GGAL tick stream + deep history.

This script deliberately re-implements the pure contract from first principles
(bucket rounding, tick bar mutation, CCL derivation, AVWAP Welford accumulation
idéntica a `computeAnchoredVwapSeries`, deep-history merge/window). It does not
import or inspect the TypeScript implementation. All values are SYNTHETIC; the
electoral gap dates are illustrative (Octubre 2025).

Consumers:
- tests/ggalSpecialistLiveStream.test.ts (TS engine + loader tests)
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

GGAL_ADR_RATIO = 10.0

TIMEFRAME_SECONDS = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "1h": 3600,
    "4h": 14400,
    "1D": 86400,
}


def ref_bucket_start(time_sec: int, timeframe: str) -> int:
    seconds = TIMEFRAME_SECONDS[timeframe]
    return math.floor(time_sec / seconds) * seconds


def ref_apply_tick(bar: dict[str, Any] | None, bucket: int, price: float, size: float) -> dict[str, Any]:
    if not (isinstance(bucket, int) and bucket > 0 and math.isfinite(price) and price > 0):
        # Contrato: bucket o precio inválidos no mutan el estado.
        if bar is not None:
            return bar
        return {"timeSec": float("nan"), "open": float("nan"), "high": float("nan"), "low": float("nan"), "close": float("nan"), "volume": 0}
    volume = size if isinstance(size, (int, float)) and size > 0 else 0
    if bar is None or bucket > bar["timeSec"]:
        return {"timeSec": bucket, "open": price, "high": price, "low": price, "close": price, "volume": volume}
    return {
        "timeSec": bar["timeSec"],
        "open": bar["open"],
        "high": max(bar["high"], price),
        "low": min(bar["low"], price),
        "close": price,
        "volume": bar["volume"] + volume,
    }


def ref_ccl(ars_price: float, adr_price: float, ratio: float = GGAL_ADR_RATIO) -> float:
    if not (math.isfinite(ars_price) and ars_price > 0):
        return float("nan")
    if not (math.isfinite(adr_price) and adr_price > 0):
        return float("nan")
    if not (math.isfinite(ratio) and ratio > 0):
        return float("nan")
    return (ars_price * ratio) / adr_price


def ref_avwap_apply(
    state: dict[str, Any] | None, typical_price: float, volume: float
) -> dict[str, Any] | None:
    if not math.isfinite(typical_price) or not math.isfinite(volume) or volume <= 0:
        return state
    if state is None or state["cumVol"] <= 0:
        return {
            "anchorSec": state["anchorSec"] if state is not None else 0,
            "cumPv": typical_price * volume,
            "cumVol": volume,
            "mean": typical_price,
            "m2": 0.0,
        }
    next_cum_vol = state["cumVol"] + volume
    delta = typical_price - state["mean"]
    next_mean = state["mean"] + (volume / next_cum_vol) * delta
    delta2 = typical_price - next_mean
    return {
        "anchorSec": state["anchorSec"],
        "cumPv": state["cumPv"] + typical_price * volume,
        "cumVol": next_cum_vol,
        "mean": next_mean,
        "m2": state["m2"] + volume * delta * delta2,
    }


def ref_avwap_point(state: dict[str, Any] | None, time_sec: int) -> dict[str, Any]:
    if state is None or state["cumVol"] <= 0:
        return {"timeSec": time_sec, "avwap": None, "plus1Sigma": None, "minus1Sigma": None}
    avwap = state["cumPv"] / state["cumVol"]
    sigma = math.sqrt(max(0.0, state["m2"] / state["cumVol"]))
    if not math.isfinite(avwap) or not math.isfinite(sigma):
        return {"timeSec": time_sec, "avwap": None, "plus1Sigma": None, "minus1Sigma": None}
    return {
        "timeSec": time_sec,
        "avwap": avwap,
        "plus1Sigma": avwap + sigma,
        "minus1Sigma": avwap - sigma,
    }


def ref_merge_pages(pages: list[list[dict[str, Any]]], max_bars: int) -> list[dict[str, Any]]:
    by_time: dict[int, dict[str, Any]] = {}
    for page in pages:
        for bar in page:
            if (
                not isinstance(bar["time"], int)
                or bar["time"] <= 0
                or not all(math.isfinite(float(bar[key])) for key in ("open", "high", "low", "close", "volume"))
            ):
                continue
            by_time[bar["time"]] = bar
    ordered = [by_time[key] for key in sorted(by_time)]
    return ordered[-max_bars:] if len(ordered) > max_bars else ordered


def ref_deep_window(now_sec: int, months: int) -> int:
    dt = datetime.fromtimestamp(now_sec, tz=timezone.utc)
    total_months = dt.year * 12 + (dt.month - 1) - months
    year = total_months // 12
    month_zero = total_months % 12
    days_in_month = (datetime(year + (month_zero + 1) // 12, (month_zero + 1) % 12 + 1, 1) - datetime(year, month_zero + 1, 1)).days
    day = min(dt.day, days_in_month)
    clamped = datetime(year, month_zero + 1, day, dt.hour, dt.minute, dt.second, tzinfo=timezone.utc)
    return int(clamped.timestamp())


def main() -> None:
    fixture: dict[str, Any] = {}

    # -- bucket rounding ----------------------------------------------------
    base_sec = 1763304605  # 2026-11-16T14:10:05Z (sintético)
    bucket_cases = [
        {"name": "1m", "timeSec": base_sec, "timeframe": "1m", "expected": ref_bucket_start(base_sec, "1m")},
        {"name": "5m", "timeSec": base_sec, "timeframe": "5m", "expected": ref_bucket_start(base_sec, "5m")},
        {"name": "15m", "timeSec": base_sec, "timeframe": "15m", "expected": ref_bucket_start(base_sec, "15m")},
        {"name": "1h", "timeSec": base_sec, "timeframe": "1h", "expected": ref_bucket_start(base_sec, "1h")},
        {"name": "4h", "timeSec": base_sec, "timeframe": "4h", "expected": ref_bucket_start(base_sec, "4h")},
        {"name": "1d_utc_midnight", "timeSec": base_sec, "timeframe": "1D", "expected": ref_bucket_start(base_sec, "1D")},
        {"name": "invalid_zero", "timeSec": 0, "timeframe": "1m", "expected": None},
    ]
    fixture["bucketCases"] = bucket_cases

    # -- tick bar mutation --------------------------------------------------
    first_bucket = ref_bucket_start(base_sec, "5m")
    tick_cases: list[dict[str, Any]] = []
    bar = ref_apply_tick(None, first_bucket, 64.52, 300.0)
    tick_cases.append({"name": "new_bucket", "priorBar": None, "bucketSec": first_bucket, "price": 64.52, "size": 300.0, "expected": bar})
    bar = ref_apply_tick(bar, first_bucket, 64.78, 150.0)
    tick_cases.append({"name": "high_and_volume", "priorBar": tick_cases[0]["expected"], "bucketSec": first_bucket, "price": 64.78, "size": 150.0, "expected": bar})
    bar = ref_apply_tick(bar, first_bucket, 64.10, 200.0)
    tick_cases.append({"name": "low_updates", "priorBar": tick_cases[1]["expected"], "bucketSec": first_bucket, "price": 64.10, "size": 200.0, "expected": bar})
    rolled = ref_apply_tick(bar, first_bucket + 300, 64.30, 100.0)
    tick_cases.append({"name": "bucket_roll_creates_new", "priorBar": tick_cases[2]["expected"], "bucketSec": first_bucket + 300, "price": 64.30, "size": 100.0, "expected": rolled})
    tick_cases.append({"name": "zero_size_keeps_volume", "priorBar": rolled, "bucketSec": first_bucket + 300, "price": 64.35, "size": 0.0, "expected": ref_apply_tick(rolled, first_bucket + 300, 64.35, 0.0)})
    tick_cases.append({"name": "invalid_price_ignored", "priorBar": rolled, "bucketSec": first_bucket + 300, "price": 0.0, "size": 100.0, "expected": ref_apply_tick(rolled, first_bucket + 300, 0.0, 100.0)})
    fixture["tickBarCases"] = tick_cases

    # -- CCL derivado -------------------------------------------------------
    ccl_cases = [
        {"name": "nominal", "arsPrice": 6450.5, "adrPrice": 64.52, "expected": ref_ccl(6450.5, 64.52)},
        {"name": "ratio_10", "arsPrice": 645.05, "adrPrice": 64.505, "expected": ref_ccl(645.05, 64.505)},
        {"name": "invalid_adr_zero", "arsPrice": 6450.5, "adrPrice": 0.0, "expected": None},
        {"name": "invalid_ars_negative", "arsPrice": -1.0, "adrPrice": 64.52, "expected": None},
    ]
    fixture["cclCases"] = ccl_cases

    # -- AVWAP acumulación (idéntica a computeAnchoredVwapSeries) -----------
    anchor_sec = ref_bucket_start(base_sec, "1D")
    bars_for_avwap = [
        {"timeSec": anchor_sec, "high": 64.9, "low": 64.1, "close": 64.5, "volume": 1200.0},
        {"timeSec": anchor_sec + 300, "high": 65.4, "low": 64.4, "close": 65.2, "volume": 800.0},
        {"timeSec": anchor_sec + 600, "high": 65.0, "low": 64.6, "close": 64.8, "volume": 0.0},
        {"timeSec": anchor_sec + 900, "high": 65.2, "low": 64.9, "close": 65.05, "volume": 600.0},
    ]
    state = {"anchorSec": anchor_sec, "cumPv": 0.0, "cumVol": 0.0, "mean": 0.0, "m2": 0.0}
    avwap_points = []
    for bar in bars_for_avwap:
        tp = (bar["high"] + bar["low"] + bar["close"]) / 3
        state = ref_avwap_apply(state, tp, bar["volume"])
        avwap_points.append(ref_avwap_point(state, bar["timeSec"]))
    fixture["avwapCase"] = {
        "anchorSec": anchor_sec,
        "bars": bars_for_avwap,
        "expectedPoints": avwap_points,
    }

    # -- fusión de páginas de historial profundo ----------------------------
    electoral_gap_sec = 1760391600  # ~13 Oct 2025 (gap electoral, sintético)
    old_page = [
        {"time": electoral_gap_sec, "open": 42.1, "high": 42.6, "low": 41.9, "close": 42.4, "volume": 5000.0},
        {"time": electoral_gap_sec + 900, "open": 42.4, "high": 43.0, "low": 42.3, "close": 42.9, "volume": 4200.0},
    ]
    recent_page = [
        {"time": base_sec - 900, "open": 64.4, "high": 64.7, "low": 64.2, "close": 64.5, "volume": 3100.0},
        {"time": base_sec, "open": 64.5, "high": 64.9, "low": 64.3, "close": 64.78, "volume": 2800.0},
    ]
    duplicate_page = [
        {"time": base_sec, "open": 64.5, "high": 65.0, "low": 64.3, "close": 64.9, "volume": 2950.0},
    ]
    merged = ref_merge_pages([old_page, recent_page, duplicate_page], 15_000)
    fixture["deepHistoryCase"] = {
        "pages": [old_page, recent_page, duplicate_page],
        "maxBars": 15_000,
        "expectedBars": merged,
        "coversElectoralGap": any(bar["time"] <= electoral_gap_sec for bar in merged),
        "duplicateLastWins": merged[-1]["time"] == base_sec and merged[-1]["close"] == 64.9,
        "expectedCount": len(merged),
    }
    capped = ref_merge_pages([old_page, recent_page, duplicate_page], 3)
    fixture["deepHistoryCapCase"] = {
        "maxBars": 3,
        "expectedCount": len(capped),
        "expectedFirstTime": capped[0]["time"] if capped else None,
    }

    # -- ventana de 14 meses ------------------------------------------------
    now_sec = 1794925805  # 2026-11-17T14:30:05Z (sintético)
    fixture["deepWindowCase"] = {
        "nowSec": now_sec,
        "months": 14,
        "expectedFromUtcSec": ref_deep_window(now_sec, 14),
    }

    output_path = Path(__file__).resolve().parent.parent / "fixtures" / "ggal_tick_stream.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(fixture, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {output_path}")


if __name__ == "__main__":
    main()
