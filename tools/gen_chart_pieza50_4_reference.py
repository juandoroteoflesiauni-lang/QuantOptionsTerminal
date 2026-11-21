#!/usr/bin/env python3
"""Referencia independiente Pieza 50.4 (Volume Profile 252D, 1W nativo y AVWAP snap).

Implementacion explicita en Python puro (datetime, zoneinfo.ZoneInfo, math) sin copiar
la logica TypeScript:
  - Resampleo semanal OHLCV por semana calendario en la zona horaria del mercado
    (lunes feriado => la primera rueda habil aporta `time`/`open` reales).
  - Volume Profile AMT con ventana `lookbackBars` y seleccion POC/VAH/VAL documentada.
  - Snap a la vela mas cercana, ancla AVWAP efectiva y serie anclada.
Genera fixtures/chart_pieza50_4_reference.json (tolerancia 1e-9).
"""
from __future__ import annotations

import json
import math
import os
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

OUT = os.path.join(os.path.dirname(__file__), "..", "fixtures", "chart_pieza50_4_reference.json")

SECONDS_PER_DAY = 86_400
MAX_TIME_SECONDS = 1e11
BIN_EPS = 1e-12
DEFAULT_VALUE_AREA_PCT = 0.70
DEFAULT_HVN_PERCENTILE = 85
DEFAULT_LVN_PERCENTILE = 15
DEFAULT_VOLUME_PROFILE_LOOKBACK_BARS = 252


def iso_utc_sec(date_str: str, hour_utc: int = 21) -> int:
    dt = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    return int(dt.timestamp()) + hour_utc * 3600


# ---------------------------------------------------------------------------
# 1) Resampleo semanal
# ---------------------------------------------------------------------------

def isValidDailyBar(bar: dict) -> bool:
    t = bar.get("time")
    return (
        t is not None
        and isinstance(t, int)
        and abs(t) <= MAX_TIME_SECONDS
        and all(isinstance(bar.get(k), (int, float)) and math.isfinite(bar[k]) for k in ("open", "high", "low", "close", "volume"))
        and bar["high"] >= bar["low"]
        and bar["volume"] >= 0
    )


def calendar_week_monday_key(time_sec: int, tz_name: str) -> str:
    dt = datetime.fromtimestamp(time_sec, tz=ZoneInfo(tz_name))
    monday = dt.date() - timedelta(days=dt.weekday())
    return monday.isoformat()


def resample_daily_to_weekly(daily_bars: list[dict], tz_name: str) -> list[dict]:
    by_time: dict[int, dict] = {}
    for bar in daily_bars:
        if not isValidDailyBar(bar):
            continue
        by_time[bar["time"]] = dict(bar)
    ordered = [by_time[t] for t in sorted(by_time)]

    buckets: dict[str, list[dict]] = {}
    for bar in ordered:
        key = calendar_week_monday_key(bar["time"], tz_name)
        buckets.setdefault(key, []).append(bar)

    out: list[dict] = []
    for bucket in buckets.values():
        first, last = bucket[0], bucket[-1]
        high = max(b["high"] for b in bucket)
        low = min(b["low"] for b in bucket)
        volume = sum(b["volume"] for b in bucket)
        vw_pv = 0.0
        vw_vol = 0.0
        all_valid = True
        for b in bucket:
            if b["volume"] > 0:
                vw = b.get("vw")
                if vw is not None and isinstance(vw, (int, float)) and math.isfinite(vw) and vw > 0:
                    vw_pv += vw * b["volume"]
                    vw_vol += b["volume"]
                else:
                    all_valid = False
        weekly = {
            "time": first["time"],
            "open": first["open"],
            "high": high,
            "low": low,
            "close": last["close"],
            "volume": volume,
        }
        if all_valid and vw_vol > 0:
            weekly["vw"] = vw_pv / vw_vol
        out.append(weekly)
    return out


# ---------------------------------------------------------------------------
# 2) Volume Profile AMT con ventana
# ---------------------------------------------------------------------------

def price_to_bin_index(price: float, tick_size: float) -> int:
    return math.floor(price / tick_size + 0.5 + BIN_EPS)


def is_usable_bar(bar: dict) -> bool:
    return (
        all(isinstance(bar.get(k), (int, float)) and math.isfinite(bar[k]) for k in ("open", "high", "low", "close", "volume"))
        and bar["high"] >= bar["low"]
        and bar["volume"] > 0
    )


def compute_profile_vwap(bars: list[dict]) -> float:
    pv = 0.0
    vol = 0.0
    for bar in bars:
        if not is_usable_bar(bar):
            continue
        vw = bar.get("vw")
        typical = vw if (vw is not None and math.isfinite(vw) and vw > 0) else (bar["high"] + bar["low"] + bar["close"]) / 3.0
        pv += typical * bar["volume"]
        vol += bar["volume"]
    return pv / vol if vol > 0 else math.nan


def build_raw_histogram(bars: list[dict], tick_size: float, value_area_pct: float) -> dict | None:
    usable = [b for b in bars if is_usable_bar(b)]
    if not usable:
        return None
    min_price = min(b["low"] for b in usable)
    max_price = max(b["high"] for b in usable)
    min_bin = math.inf
    max_bin = -math.inf
    for b in usable:
        if b["high"] == b["low"]:
            low_idx = price_to_bin_index(b["close"], tick_size)
            high_idx = low_idx
        else:
            low_idx = price_to_bin_index(b["low"], tick_size)
            high_idx = price_to_bin_index(b["high"], tick_size)
        min_bin = min(min_bin, low_idx)
        max_bin = max(max_bin, high_idx)
    min_bin = int(min_bin)
    max_bin = int(max_bin)
    bin_volumes = [0.0] * (max_bin - min_bin + 1)
    total = 0.0
    for b in usable:
        if b["high"] == b["low"]:
            low_idx = price_to_bin_index(b["close"], tick_size)
            high_idx = low_idx
        else:
            low_idx = price_to_bin_index(b["low"], tick_size)
            high_idx = price_to_bin_index(b["high"], tick_size)
        covered = high_idx - low_idx + 1
        per_bin = b["volume"] / covered
        for idx in range(low_idx, high_idx + 1):
            bin_volumes[idx - min_bin] += per_bin
        total += b["volume"]
    if total <= 0:
        return None
    active = [v for v in bin_volumes if v > 0]
    if not active:
        return None

    profile_vwap = compute_profile_vwap(usable)
    max_vol = max(bin_volumes)
    tie_eps = BIN_EPS * max(1.0, max_vol)
    best_i = 0
    best_dist = math.inf
    best_price = math.inf
    for i, vol in enumerate(bin_volumes):
        if vol < max_vol - tie_eps:
            continue
        price = (min_bin + i) * tick_size
        dist = abs(price - profile_vwap) if math.isfinite(profile_vwap) else math.inf
        if best_price == math.inf:
            best_i, best_dist, best_price = i, dist, price
            continue
        if math.isfinite(profile_vwap):
            if dist < best_dist - tie_eps:
                best_i, best_dist, best_price = i, dist, price
            elif abs(dist - best_dist) <= tie_eps and price < best_price:
                best_i, best_dist, best_price = i, dist, price
        elif price < best_price:
            best_i, best_price = i, price
    poc_idx = best_i

    low_idx = poc_idx
    high_idx = poc_idx
    covered_vol = bin_volumes[poc_idx]
    target = value_area_pct * total
    eps = BIN_EPS * max(1.0, total)
    while covered_vol < target - eps and (low_idx > 0 or high_idx < len(bin_volumes) - 1):
        left = bin_volumes[low_idx - 1] if low_idx > 0 else -1.0
        right = bin_volumes[high_idx + 1] if high_idx < len(bin_volumes) - 1 else -1.0
        if left < 0:
            high_idx += 1
            covered_vol += right
        elif right < 0:
            low_idx -= 1
            covered_vol += left
        elif left > right + eps:
            low_idx -= 1
            covered_vol += left
        elif right > left + eps:
            high_idx += 1
            covered_vol += right
        else:
            low_idx -= 1
            high_idx += 1
            covered_vol += left + right

    return {
        "minBinIndex": min_bin,
        "binVolumes": bin_volumes,
        "activeBinVolumes": active,
        "minPrice": min_price,
        "maxPrice": max_price,
        "poc": (min_bin + poc_idx) * tick_size,
        "val": (min_bin + low_idx) * tick_size,
        "vah": (min_bin + high_idx) * tick_size,
        "profileVwap": profile_vwap,
        "totalVolume": total,
        "valueAreaVolume": covered_vol,
        "valueAreaCoverage": covered_vol / total,
    }


def empirical_percentile(window: list[float], target: float) -> float:
    if not window or not math.isfinite(target):
        return math.nan
    less = sum(1 for v in window if v < target)
    equal = sum(1 for v in window if v == target)
    return 100.0 * (less + 0.5 * equal) / len(window)


def compute_volume_profile_amt(bars: list[dict], options: dict) -> dict:
    as_of = options["asOfUtcSec"]
    bar_seconds = options["barSeconds"]
    tick_size = options["tickSize"]
    lookback = options.get("lookbackBars")
    closed = [b for b in bars if isinstance(b.get("time"), (int, float)) and b["time"] + bar_seconds <= as_of]
    excluded = len(bars) - len(closed)

    nan_out = {
        "status": "NO_DATA",
        "asOfUtcSec": as_of,
        "barSeconds": bar_seconds,
        "tickSize": tick_size if math.isfinite(tick_size) and tick_size > 0 else None,
        "closedBarCount": 0,
        "excludedFutureCount": excluded,
        "windowBars": 0,
        "minPrice": None,
        "maxPrice": None,
        "poc": None,
        "vah": None,
        "val": None,
        "profileVwap": None,
        "totalVolume": 0.0,
        "valueAreaVolume": 0.0,
        "valueAreaCoverage": None,
        "bins": [],
    }
    if lookback is not None and (not isinstance(lookback, int) or lookback <= 0):
        return nan_out
    windowed = closed[-lookback:] if (lookback is not None and len(closed) > lookback) else closed
    if not math.isfinite(tick_size) or tick_size <= 0:
        nan_out["closedBarCount"] = len(windowed)
        nan_out["windowBars"] = len(windowed)
        return nan_out
    hist = build_raw_histogram(windowed, tick_size, DEFAULT_VALUE_AREA_PCT)
    if hist is None:
        nan_out["tickSize"] = tick_size
        nan_out["closedBarCount"] = len(windowed)
        nan_out["windowBars"] = len(windowed)
        return nan_out

    bins = []
    for i, vol in enumerate(hist["binVolumes"]):
        price = (hist["minBinIndex"] + i) * tick_size
        pct = empirical_percentile(hist["activeBinVolumes"], vol)
        if vol > 0 and pct >= DEFAULT_HVN_PERCENTILE:
            classification = "HVN"
        elif pct <= DEFAULT_LVN_PERCENTILE:
            classification = "LVN"
        else:
            classification = "NORMAL"
        bins.append(
            {
                "price": price,
                "volume": vol,
                "volumeShare": vol / hist["totalVolume"],
                "volumePercentile": pct,
                "classification": classification,
            }
        )

    return {
        "status": "OK",
        "asOfUtcSec": as_of,
        "barSeconds": bar_seconds,
        "tickSize": tick_size,
        "closedBarCount": len(windowed),
        "excludedFutureCount": excluded,
        "windowBars": len(windowed),
        "minPrice": hist["minPrice"],
        "maxPrice": hist["maxPrice"],
        "poc": hist["poc"],
        "vah": hist["vah"],
        "val": hist["val"],
        "profileVwap": hist["profileVwap"],
        "totalVolume": hist["totalVolume"],
        "valueAreaVolume": hist["valueAreaVolume"],
        "valueAreaCoverage": hist["valueAreaCoverage"],
        "bins": bins,
    }


# ---------------------------------------------------------------------------
# 3) AVWAP: snap, ancla efectiva y serie anclada
# ---------------------------------------------------------------------------

def find_nearest_bar_index(bars: list[dict], target) -> int:
    if target is None or not math.isfinite(target):
        return -1
    best_i = -1
    best_d = math.inf
    for i, b in enumerate(bars):
        t = b.get("time")
        if t is None or not math.isfinite(t):
            continue
        d = abs(t - target)
        if d < best_d:
            best_i, best_d = i, d
    return best_i


def resolve_effective_avwap_anchor_index(bars: list[dict], requested: int) -> int:
    if not isinstance(requested, int) or requested < 0 or requested >= len(bars):
        return -1
    for i in range(requested, len(bars)):
        b = bars[i]
        vw = b.get("vw")
        has_vw = vw is not None and isinstance(vw, (int, float)) and math.isfinite(vw) and vw > 0
        has_hlc = all(isinstance(b.get(k), (int, float)) and math.isfinite(b[k]) for k in ("high", "low", "close"))
        volume = b.get("volume")
        if volume is not None and math.isfinite(volume) and volume > 0 and (has_vw or has_hlc):
            return i
    return -1


def typical_price(bar: dict) -> float:
    vw = bar.get("vw")
    if vw is not None and isinstance(vw, (int, float)) and math.isfinite(vw) and vw > 0:
        return vw
    if all(isinstance(bar.get(k), (int, float)) and math.isfinite(bar[k]) for k in ("high", "low", "close")):
        return (bar["high"] + bar["low"] + bar["close"]) / 3.0
    return math.nan


def compute_anchored_vwap_pure(bars: list[dict], anchor_index: int) -> list:
    out: list = [None] * len(bars)
    if anchor_index < 0 or anchor_index >= len(bars):
        return out
    cum_pv = 0.0
    cum_vol = 0.0
    for i in range(anchor_index, len(bars)):
        b = bars[i]
        volume = b.get("volume")
        if volume is None or not isinstance(volume, (int, float)) or not math.isfinite(volume):
            continue
        tp = typical_price(b)
        if math.isfinite(tp) and volume > 0:
            cum_pv += tp * volume
            cum_vol += volume
        out[i] = cum_pv / cum_vol if cum_vol > 0 else None
    return out


def compute_anchored_vwap_with_anchor(bars: list[dict], requested: int) -> dict:
    effective = resolve_effective_avwap_anchor_index(bars, requested)
    effective_time = bars[effective]["time"] if effective >= 0 else None
    series = compute_anchored_vwap_pure(bars, effective)
    return {
        "series": series,
        "requestedAnchorIndex": requested,
        "effectiveAnchorIndex": effective,
        "effectiveAnchorTime": effective_time,
    }


# ---------------------------------------------------------------------------
# Casos
# ---------------------------------------------------------------------------

def daily_bar(time_sec: int, open_px: float, high: float, low: float, close: float, volume: float, vw=None) -> dict:
    bar = {"time": time_sec, "open": open_px, "high": high, "low": low, "close": close, "volume": volume}
    if vw is not None:
        bar["vw"] = vw
    return bar


def make_case(name: str, tz_name: str, bars: list[dict]) -> dict:
    return {
        "name": name,
        "timeZone": tz_name,
        "bars": bars,
        "expected": resample_daily_to_weekly(bars, tz_name),
    }


def main() -> None:
    fx: dict = {"meta": {"generator": "tools/gen_chart_pieza50_4_reference.py", "tolerance": 1e-9}}
    us = "America/New_York"
    ar = "America/Argentina/Buenos_Aires"

    # ---- Bloque 2: resampleo semanal ----
    week_a = [iso_utc_sec(f"2025-01-{d:02d}") for d in range(6, 11)]
    bars_a = [
        daily_bar(week_a[i], 100 + i, 103 + i, 98 + i, 101 + i, 100 + i * 10, 101.5 + i)
        for i in range(5)
    ]
    week_b = [iso_utc_sec(f"2025-01-{d:02d}") for d in range(13, 18)]
    bars_b = [
        daily_bar(week_b[i], 200 + i, 204 + i, 197 + i, 202 + i, 150 + i * 20, 202.25 + i)
        for i in range(5)
    ]
    mlk_bars = [
        daily_bar(iso_utc_sec("2025-01-17"), 90, 92, 89, 91, 120, 91.5),
        daily_bar(iso_utc_sec("2025-01-21"), 95, 97, 94, 96, 130, 96.25),
        daily_bar(iso_utc_sec("2025-01-22"), 96, 98, 95, 97, 140, 97.25),
        daily_bar(iso_utc_sec("2025-01-23"), 97, 99, 96, 98, 150, 98.25),
        daily_bar(iso_utc_sec("2025-01-24"), 98, 100, 97, 99, 160, 99.25),
    ]
    year_change_bars = [
        daily_bar(iso_utc_sec("2024-12-30"), 50, 52, 49, 51, 200, 51.4),
        daily_bar(iso_utc_sec("2024-12-31"), 51, 53, 50, 52, 210, 52.4),
        daily_bar(iso_utc_sec("2025-01-02"), 53, 55, 52, 54, 220, 54.4),
        daily_bar(iso_utc_sec("2025-01-03"), 54, 56, 53, 55, 230, 55.4),
    ]
    carnaval_bars = [
        daily_bar(iso_utc_sec("2025-03-05"), 300, 305, 298, 304, 400),
        daily_bar(iso_utc_sec("2025-03-06"), 304, 309, 302, 308, 410),
        daily_bar(iso_utc_sec("2025-03-07"), 308, 312, 306, 310, 420),
    ]
    partial_vw_bars = [
        daily_bar(iso_utc_sec("2025-02-10"), 70, 72, 69, 71, 100, 71.1),
        daily_bar(iso_utc_sec("2025-02-11"), 71, 73, 70, 72, 110),
        daily_bar(iso_utc_sec("2025-02-12"), 72, 74, 71, 73, 120, 73.1),
    ]
    mon_dup = iso_utc_sec("2025-02-03")
    dedupe_bars = [
        daily_bar(mon_dup, 10, 12, 9, 11, 100, 11.0),
        daily_bar(mon_dup, 20, 25, 18, 24, 200, 24.0),
        daily_bar(iso_utc_sec("2025-02-04") * 1000, 25, 27, 24, 26, 50, 26.0),
        daily_bar(iso_utc_sec("2025-02-04") + 0.5, 26, 28, 25, 27, 60, 27.0),
        daily_bar(iso_utc_sec("2025-02-05"), 27, 26, 28, 27, 70, 27.0),
        daily_bar(iso_utc_sec("2025-02-06"), 28, 30, 27, 29, -5, 29.0),
        daily_bar(iso_utc_sec("2025-02-07"), 30, 33, 28, 32, 300, 32.0),
    ]
    fx["weeklyResampleCases"] = [
        make_case("us_normal_two_weeks", us, bars_a + bars_b),
        make_case("us_mlk_holiday_monday", us, mlk_bars),
        make_case("us_year_change_dst_week", us, year_change_bars),
        make_case("byma_carnaval_no_vw", ar, carnaval_bars),
        make_case("us_partial_vw_omitted", us, partial_vw_bars),
        make_case("us_dedupe_and_invalid_inputs", us, dedupe_bars),
    ]

    # ---- Bloque 1: Volume Profile 252 ----
    t0 = iso_utc_sec("2024-01-01", 0)
    long_bars: list[dict] = []
    for i in range(320):
        price = 100.0 if i < 68 else 200.0
        volume = 1000.0 if i < 68 else 10.0
        long_bars.append(daily_bar(t0 + i * SECONDS_PER_DAY, price, price, price, price, volume))
    # Barra futura con volumen altisimo y otro precio: jamas debe entrar a la ventana.
    long_bars.append(daily_bar(t0 + 320 * SECONDS_PER_DAY, 100.0, 100.0, 100.0, 100.0, 999_999.0))
    as_of_long = t0 + 320 * SECONDS_PER_DAY

    short_bars = [
        daily_bar(t0 + i * SECONDS_PER_DAY, 300.0, 300.0, 300.0, 300.0, 5.0) for i in range(40)
    ]
    as_of_short = t0 + 40 * SECONDS_PER_DAY

    multi_bars = [
        daily_bar(t0, 99.0, 99.0, 99.0, 99.0, 100.0),
        daily_bar(t0 + SECONDS_PER_DAY, 99.5, 99.5, 99.5, 99.5, 300.0),
        daily_bar(t0 + 2 * SECONDS_PER_DAY, 100.0, 100.0, 100.0, 100.0, 600.0),
        daily_bar(t0 + 3 * SECONDS_PER_DAY, 100.5, 100.5, 100.5, 100.5, 300.0),
        daily_bar(t0 + 4 * SECONDS_PER_DAY, 101.0, 101.0, 101.0, 101.0, 100.0),
    ]
    as_of_multi = t0 + 5 * SECONDS_PER_DAY

    fx["volumeProfile252Cases"] = [
        {
            "name": "windowed_252_over_320_with_future_bar",
            "bars": long_bars,
            "options": {
                "asOfUtcSec": as_of_long,
                "barSeconds": SECONDS_PER_DAY,
                "tickSize": 0.5,
                "lookbackBars": DEFAULT_VOLUME_PROFILE_LOOKBACK_BARS,
            },
            "expected": compute_volume_profile_amt(
                long_bars,
                {
                    "asOfUtcSec": as_of_long,
                    "barSeconds": SECONDS_PER_DAY,
                    "tickSize": 0.5,
                    "lookbackBars": DEFAULT_VOLUME_PROFILE_LOOKBACK_BARS,
                },
            ),
        },
        {
            "name": "full_history_without_lookback",
            "bars": long_bars,
            "options": {"asOfUtcSec": as_of_long, "barSeconds": SECONDS_PER_DAY, "tickSize": 0.5},
            "expected": compute_volume_profile_amt(
                long_bars, {"asOfUtcSec": as_of_long, "barSeconds": SECONDS_PER_DAY, "tickSize": 0.5}
            ),
        },
        {
            "name": "short_series_window_40",
            "bars": short_bars,
            "options": {
                "asOfUtcSec": as_of_short,
                "barSeconds": SECONDS_PER_DAY,
                "tickSize": 0.5,
                "lookbackBars": DEFAULT_VOLUME_PROFILE_LOOKBACK_BARS,
            },
            "expected": compute_volume_profile_amt(
                short_bars,
                {
                    "asOfUtcSec": as_of_short,
                    "barSeconds": SECONDS_PER_DAY,
                    "tickSize": 0.5,
                    "lookbackBars": DEFAULT_VOLUME_PROFILE_LOOKBACK_BARS,
                },
            ),
        },
        {
            "name": "multi_price_value_area",
            "bars": multi_bars,
            "options": {
                "asOfUtcSec": as_of_multi,
                "barSeconds": SECONDS_PER_DAY,
                "tickSize": 0.5,
                "lookbackBars": DEFAULT_VOLUME_PROFILE_LOOKBACK_BARS,
            },
            "expected": compute_volume_profile_amt(
                multi_bars,
                {
                    "asOfUtcSec": as_of_multi,
                    "barSeconds": SECONDS_PER_DAY,
                    "tickSize": 0.5,
                    "lookbackBars": DEFAULT_VOLUME_PROFILE_LOOKBACK_BARS,
                },
            ),
        },
        {
            "name": "invalid_lookback_zero_no_data",
            "bars": multi_bars,
            "options": {
                "asOfUtcSec": as_of_multi,
                "barSeconds": SECONDS_PER_DAY,
                "tickSize": 0.5,
                "lookbackBars": 0,
            },
            "expected": compute_volume_profile_amt(
                multi_bars,
                {
                    "asOfUtcSec": as_of_multi,
                    "barSeconds": SECONDS_PER_DAY,
                    "tickSize": 0.5,
                    "lookbackBars": 0,
                },
            ),
        },
    ]

    # ---- Bloque 3: AVWAP ----
    base = iso_utc_sec("2025-01-06", 21)
    step = SECONDS_PER_DAY
    series_a = [
        daily_bar(base + 0 * step, 9, 10, 8, 9, 5, 9.5),
        daily_bar(base + 1 * step, 19, 20, 18, 19, 0),
        daily_bar(base + 2 * step, 29, 30, 28, 29, 3),
        daily_bar(base + 3 * step, 39, 40, 38, 39, 2, 39.25),
        daily_bar(base + 4 * step, 49, 50, 48, 49, 6),
        daily_bar(base + 5 * step, 59, 60, 58, 59, 7, 59.75),
        daily_bar(base + 6 * step, 69, 70, 68, 69, 0),
        daily_bar(base + 7 * step, 79, 80, 78, 79, 1, 79.5),
    ]
    nearest_cases = [
        {"name": "exact_bar_2", "bars": series_a, "target": base + 2 * step, "expected": find_nearest_bar_index(series_a, base + 2 * step)},
        {"name": "after_bar_2_30pct", "bars": series_a, "target": base + 2 * step + 0.3 * step, "expected": find_nearest_bar_index(series_a, base + 2 * step + 0.3 * step)},
        {"name": "before_bar_3_70pct", "bars": series_a, "target": base + 2 * step + 0.7 * step, "expected": find_nearest_bar_index(series_a, base + 2 * step + 0.7 * step)},
        {"name": "midpoint_tie_earlier", "bars": series_a, "target": base + 2 * step + 0.5 * step, "expected": find_nearest_bar_index(series_a, base + 2 * step + 0.5 * step)},
        {"name": "before_first_bar", "bars": series_a, "target": base - 5 * step, "expected": find_nearest_bar_index(series_a, base - 5 * step)},
        {"name": "beyond_last_bar", "bars": series_a, "target": base + 100 * step, "expected": find_nearest_bar_index(series_a, base + 100 * step)},
        {"name": "empty_bars", "bars": [], "target": base, "expected": -1},
        {"name": "non_finite_target", "bars": series_a, "target": None, "expected": -1},
    ]

    zero_volume_bars = [
        daily_bar(base + i * step, 100 + i, 101 + i, 99 + i, 100 + i, 0) for i in range(6)
    ]
    nan_typical_bars = [
        {"time": base, "open": 10, "high": None, "low": None, "close": None, "volume": 5},
        daily_bar(base + step, 11, 12, 10, 11.5, 0),
        daily_bar(base + 2 * step, 4, 5, 3, 4, 2),
    ]

    effective_cases = [
        {"name": "anchor_0_valid", "bars": series_a, "requestedAnchorIndex": 0, "expected": compute_anchored_vwap_with_anchor(series_a, 0)},
        {"name": "advance_from_zero_volume_1_to_2", "bars": series_a, "requestedAnchorIndex": 1, "expected": compute_anchored_vwap_with_anchor(series_a, 1)},
        {"name": "anchor_3_with_vw", "bars": series_a, "requestedAnchorIndex": 3, "expected": compute_anchored_vwap_with_anchor(series_a, 3)},
        {"name": "advance_6_zero_to_7", "bars": series_a, "requestedAnchorIndex": 6, "expected": compute_anchored_vwap_with_anchor(series_a, 6)},
        {"name": "all_zero_volume", "bars": zero_volume_bars, "requestedAnchorIndex": 0, "expected": compute_anchored_vwap_with_anchor(zero_volume_bars, 0)},
        {"name": "invalid_negative", "bars": series_a, "requestedAnchorIndex": -1, "expected": compute_anchored_vwap_with_anchor(series_a, -1)},
        {"name": "invalid_out_of_range", "bars": series_a, "requestedAnchorIndex": 99, "expected": compute_anchored_vwap_with_anchor(series_a, 99)},
        {"name": "invalid_non_integer", "bars": series_a, "requestedAnchorIndex": 1.5, "expected": compute_anchored_vwap_with_anchor(series_a, 1.5)},
        {"name": "advance_over_nan_typical", "bars": nan_typical_bars, "requestedAnchorIndex": 0, "expected": compute_anchored_vwap_with_anchor(nan_typical_bars, 0)},
    ]
    fx["avwapAnchorCases"] = {"nearestCases": nearest_cases, "effectiveAnchorCases": effective_cases}

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(fx, fh, indent=1, allow_nan=False)
    print("written", OUT)


if __name__ == "__main__":
    main()
