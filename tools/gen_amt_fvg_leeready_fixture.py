"""Independent pure-Python reference generator for Pieza 15:
  1. Auction Market Theory (AMT): Composite Volume Profile, HVN/LVN & Naked POCs
  2. Quantitative FVG & Fresh Order Blocks (FOB) with FINRA TRF Dark Pool footprint
  3. Causal Lee-Ready Classifier (Quote + Tick/Zero-Tick) & L1 Book Imbalance

Generates `fixtures/amt_fvg_leeready_reference.json` using explicit math
and `zoneinfo.ZoneInfo("America/New_York")` without copying TypeScript code.
"""

from __future__ import annotations

import json
import math
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

ET_TZ = ZoneInfo("America/New_York")
BIN_EPS = 1e-12
PRICE_EPS = 1e-12
FINRA_TRF_EXCHANGE = 4


def utc_from_et(year: int, month: int, day: int, hour: int, minute: int, second: int = 0) -> int:
    return int(datetime(year, month, day, hour, minute, second, tzinfo=ET_TZ).timestamp())


def et_date_key(utc_sec: int) -> str:
    return datetime.fromtimestamp(utc_sec, tz=ET_TZ).strftime("%Y-%m-%d")


def serialize_num(value: float) -> float | str:
    return "NaN" if math.isnan(value) else float(value)


def price_to_bin_index(price: float, tick_size: float) -> int:
    return math.floor(price / tick_size + 0.5 + BIN_EPS)


def empirical_percentile(values: list[float], target: float) -> float:
    if len(values) == 0 or not math.isfinite(target):
        return float("nan")
    less = sum(1 for v in values if v < target)
    equal = sum(1 for v in values if v == target)
    return 100.0 * (less + 0.5 * equal) / len(values)


def is_usable_bar(bar: dict[str, Any]) -> bool:
    return (
        math.isfinite(bar["open"])
        and math.isfinite(bar["high"])
        and math.isfinite(bar["low"])
        and math.isfinite(bar["close"])
        and math.isfinite(bar["volume"])
        and bar["high"] >= bar["low"]
        and bar["volume"] > 0
    )


def build_raw_histogram(
    bars: list[dict[str, Any]],
    tick_size: float,
    value_area_pct: float = 0.70,
) -> dict[str, Any] | None:
    usable = [b for b in bars if is_usable_bar(b)]
    if not usable:
        return None

    min_price = min(float(b["low"]) for b in usable)
    max_price = max(float(b["high"]) for b in usable)
    bar_ranges: list[tuple[int, int, float]] = []
    min_idx = 10**12
    max_idx = -(10**12)
    pv_sum = 0.0
    total_vol = 0.0

    for b in usable:
        if b["high"] == b["low"]:
            lo_idx = price_to_bin_index(float(b["close"]), tick_size)
            hi_idx = lo_idx
        else:
            lo_idx = price_to_bin_index(float(b["low"]), tick_size)
            hi_idx = price_to_bin_index(float(b["high"]), tick_size)
        min_idx = min(min_idx, lo_idx)
        max_idx = max(max_idx, hi_idx)
        vol = float(b["volume"])
        bar_ranges.append((lo_idx, hi_idx, vol))
        vw_val = b.get("vw")
        typical = (
            float(vw_val)
            if isinstance(vw_val, (int, float)) and math.isfinite(vw_val) and vw_val > 0
            else (float(b["high"]) + float(b["low"]) + float(b["close"])) / 3.0
        )
        pv_sum += typical * vol
        total_vol += vol

    if total_vol <= 0:
        return None

    bin_count = max_idx - min_idx + 1
    bin_volumes = [0.0] * bin_count
    for lo_idx, hi_idx, vol in bar_ranges:
        per_bin = vol / (hi_idx - lo_idx + 1)
        for idx in range(lo_idx, hi_idx + 1):
            bin_volumes[idx - min_idx] += per_bin

    active_volumes = [v for v in bin_volumes if v > 0.0]
    profile_vwap = pv_sum / total_vol
    max_vol = max(bin_volumes)
    tie_eps = BIN_EPS * max(1.0, max_vol)

    best_idx = 0
    best_dist = float("inf")
    best_price = float("inf")
    for i, v in enumerate(bin_volumes):
        if v < max_vol - tie_eps:
            continue
        p = (min_idx + i) * tick_size
        d = abs(p - profile_vwap)
        if best_price == float("inf") or d < best_dist - tie_eps or (
            abs(d - best_dist) <= tie_eps and p < best_price
        ):
            best_idx = i
            best_dist = d
            best_price = p

    lo_va = best_idx
    hi_va = best_idx
    covered = bin_volumes[best_idx]
    target_va = value_area_pct * total_vol
    eps = BIN_EPS * max(1.0, total_vol)

    while covered < target_va - eps and (lo_va > 0 or hi_va < bin_count - 1):
        left_vol = bin_volumes[lo_va - 1] if lo_va > 0 else -1.0
        right_vol = bin_volumes[hi_va + 1] if hi_va < bin_count - 1 else -1.0
        if left_vol < 0.0:
            hi_va += 1
            covered += right_vol
        elif right_vol < 0.0:
            lo_va -= 1
            covered += left_vol
        elif left_vol > right_vol + eps:
            lo_va -= 1
            covered += left_vol
        elif right_vol > left_vol + eps:
            hi_va += 1
            covered += right_vol
        else:
            lo_va -= 1
            hi_va += 1
            covered += left_vol + right_vol

    return {
        "min_idx": min_idx,
        "max_idx": max_idx,
        "bin_volumes": bin_volumes,
        "active_volumes": active_volumes,
        "min_price": min_price,
        "max_price": max_price,
        "poc": (min_idx + best_idx) * tick_size,
        "val": (min_idx + lo_va) * tick_size,
        "vah": (min_idx + hi_va) * tick_size,
        "profile_vwap": profile_vwap,
        "total_volume": total_vol,
        "va_volume": covered,
        "va_coverage": covered / total_vol,
    }


def py_compute_volume_profile_amt(
    bars: list[dict[str, Any]],
    as_of_utc_sec: int,
    bar_seconds: int,
    tick_size: float,
    value_area_pct: float = 0.70,
    hvn_pct: float = 85.0,
    lvn_pct: float = 15.0,
) -> dict[str, Any]:
    closed = [b for b in bars if b["time"] + bar_seconds <= as_of_utc_sec]
    excluded = len(bars) - len(closed)
    hist = build_raw_histogram(closed, tick_size, value_area_pct)
    assert hist is not None

    bins_out: list[dict[str, Any]] = []
    hvn_out: list[dict[str, Any]] = []
    lvn_out: list[dict[str, Any]] = []

    for i, vol in enumerate(hist["bin_volumes"]):
        price = (hist["min_idx"] + i) * tick_size
        share = vol / hist["total_volume"]
        pct = empirical_percentile(hist["active_volumes"], vol)
        if vol > 0.0 and pct >= hvn_pct:
            cls = "HVN"
        elif pct <= lvn_pct:
            cls = "LVN"
        else:
            cls = "NORMAL"
        rec = {
            "price": price,
            "volume": vol,
            "volumeShare": share,
            "volumePercentile": pct,
            "classification": cls,
        }
        bins_out.append(rec)
        if cls == "HVN":
            hvn_out.append(rec)
        elif cls == "LVN":
            lvn_out.append(rec)

    return {
        "status": "OK",
        "asOfUtcSec": as_of_utc_sec,
        "barSeconds": bar_seconds,
        "tickSize": tick_size,
        "closedBarCount": len(closed),
        "excludedFutureCount": excluded,
        "minPrice": hist["min_price"],
        "maxPrice": hist["max_price"],
        "poc": hist["poc"],
        "vah": hist["vah"],
        "val": hist["val"],
        "profileVwap": hist["profile_vwap"],
        "totalVolume": hist["total_volume"],
        "valueAreaVolume": hist["va_volume"],
        "valueAreaCoverage": hist["va_coverage"],
        "bins": bins_out,
        "hvnBins": hvn_out,
        "lvnBins": lvn_out,
    }


def py_track_naked_pocs(
    bars: list[dict[str, Any]],
    as_of_utc_sec: int,
    bar_seconds: int,
    tick_size: float,
    touch_tolerance: float,
    value_area_pct: float = 0.70,
) -> dict[str, Any]:
    closed = [b for b in bars if b["time"] + bar_seconds <= as_of_utc_sec]
    excluded = len(bars) - len(closed)
    as_of_date = et_date_key(as_of_utc_sec)

    by_session: dict[str, list[dict[str, Any]]] = {}
    tagged: list[tuple[dict[str, Any], str]] = []
    for b in closed:
        sd = et_date_key(int(b["time"]))
        tagged.append((b, sd))
        by_session.setdefault(sd, []).append(b)

    prior_dates = [d for d in by_session.keys() if d < as_of_date]
    sessions_out: list[dict[str, Any]] = []
    active_out: list[dict[str, Any]] = []

    for sd in prior_dates:
        hist = build_raw_histogram(by_session[sd], tick_size, value_area_pct)
        if hist is None:
            continue
        poc_price = hist["poc"]
        tested_time: int | None = None
        tested_sd: str | None = None
        for b, b_sd in tagged:
            if b_sd <= sd:
                continue
            if float(b["low"]) <= poc_price + touch_tolerance and float(b["high"]) >= poc_price - touch_tolerance:
                tested_time = int(b["time"])
                tested_sd = b_sd
                break
        is_naked = tested_time is None
        rec = {
            "sessionDate": sd,
            "sessionPoc": poc_price,
            "sessionVah": hist["vah"],
            "sessionVal": hist["val"],
            "sessionVolume": hist["total_volume"],
            "isNaked": is_naked,
            "isMitigated": not is_naked,
            "testedAtTime": tested_time,
            "mitigatedAtTime": tested_time,
            "testedSessionDate": tested_sd,
        }
        sessions_out.append(rec)
        if is_naked:
            active_out.append(rec)

    return {
        "status": "OK",
        "asOfUtcSec": as_of_utc_sec,
        "barSeconds": bar_seconds,
        "tickSize": tick_size,
        "touchTolerance": touch_tolerance,
        "closedBarCount": len(closed),
        "excludedFutureCount": excluded,
        "sessions": sessions_out,
        "activeNakedPocs": active_out,
    }


def resolve_bar_delta(bar: dict[str, Any]) -> float:
    if "delta" in bar and isinstance(bar["delta"], (int, float)) and math.isfinite(bar["delta"]):
        return float(bar["delta"])
    if (
        "buyVolume" in bar
        and "sellVolume" in bar
        and isinstance(bar["buyVolume"], (int, float))
        and isinstance(bar["sellVolume"], (int, float))
    ):
        return float(bar["buyVolume"]) - float(bar["sellVolume"])
    rng = float(bar["high"]) - float(bar["low"])
    if rng <= 0.0:
        return 0.0
    clv = ((float(bar["close"]) - float(bar["low"])) - (float(bar["high"]) - float(bar["close"]))) / rng
    return float(bar["volume"]) * clv


def resolve_dp_volume(bar: dict[str, Any]) -> float:
    if "darkPoolVolume" in bar and isinstance(bar["darkPoolVolume"], (int, float)):
        return float(bar["darkPoolVolume"])
    if bar.get("exchange") == FINRA_TRF_EXCHANGE:
        return float(bar["volume"])
    return 0.0


def causal_range_zscore(bars: list[dict[str, Any]], idx: int, window: int) -> float:
    if idx < window or window < 2:
        return float("nan")
    ranges = [float(bars[k]["high"]) - float(bars[k]["low"]) for k in range(idx - window, idx)]
    mean = sum(ranges) / window
    var = sum((r - mean) ** 2 for r in ranges) / window
    std = math.sqrt(var)
    if std <= 0.0:
        return float("nan")
    target = float(bars[idx]["high"]) - float(bars[idx]["low"])
    return (target - mean) / std


def py_detect_fvgs(
    bars: list[dict[str, Any]],
    as_of_utc_sec: int,
    bar_seconds: int,
    tick_size: float,
    z_window: int = 20,
    min_z: float = 1.5,
    max_lvn_pct: float = 15.0,
    min_delta_ratio: float = 0.35,
    mitigation_mode: str = "FULL_FILL",
) -> dict[str, Any]:
    closed = [b for b in bars if b["time"] + bar_seconds <= as_of_utc_sec]
    excluded = len(bars) - len(closed)
    fvgs: list[dict[str, Any]] = []

    for i in range(max(2, z_window + 1), len(closed)):
        b_left = closed[i - 2]
        b_mid = closed[i - 1]
        b_right = closed[i]

        if float(b_right["low"]) > float(b_left["high"]):
            fvg_type = "BULLISH_FVG"
            gap_low = float(b_left["high"])
            gap_high = float(b_right["low"])
        elif float(b_right["high"]) < float(b_left["low"]):
            fvg_type = "BEARISH_FVG"
            gap_low = float(b_right["high"])
            gap_high = float(b_left["low"])
        else:
            continue

        z_val = causal_range_zscore(closed, i - 1, z_window)
        if not math.isfinite(z_val) or z_val <= min_z:
            continue

        hist = build_raw_histogram(closed[: i + 1], tick_size)
        assert hist is not None
        lo_bin = price_to_bin_index(gap_low, tick_size)
        hi_bin = price_to_bin_index(gap_high, tick_size)
        sum_vol = 0.0
        for b_idx in range(lo_bin, hi_bin + 1):
            if hist["min_idx"] <= b_idx <= hist["max_idx"]:
                sum_vol += hist["bin_volumes"][b_idx - hist["min_idx"]]
        avg_gap_vol = sum_vol / (hi_bin - lo_bin + 1)
        lvn_pct = empirical_percentile(hist["active_volumes"], avg_gap_vol)
        if not math.isfinite(lvn_pct) or lvn_pct > max_lvn_pct:
            continue

        delta_val = resolve_bar_delta(b_mid)
        delta_ratio = abs(delta_val) / float(b_mid["volume"])
        aligned = (delta_val > 0.0) if fvg_type == "BULLISH_FVG" else (delta_val < 0.0)
        if not aligned or delta_ratio < min_delta_ratio:
            continue

        gap_width = gap_high - gap_low
        ce_price = 0.5 * (gap_low + gap_high)
        fill_pct = 0.0
        ce_time: int | None = None
        full_time: int | None = None

        for j in range(i + 1, len(closed)):
            bj = closed[j]
            if fvg_type == "BULLISH_FVG":
                if float(bj["low"]) < gap_high:
                    depth = min(gap_width, gap_high - max(gap_low, float(bj["low"])))
                    fill_pct = max(fill_pct, min(1.0, max(0.0, depth / gap_width)))
                    if ce_time is None and float(bj["low"]) <= ce_price:
                        ce_time = int(bj["time"])
                    if full_time is None and float(bj["low"]) <= gap_low:
                        full_time = int(bj["time"])
                        fill_pct = 1.0
                        break
            else:
                if float(bj["high"]) > gap_low:
                    depth = min(gap_width, min(gap_high, float(bj["high"])) - gap_low)
                    fill_pct = max(fill_pct, min(1.0, max(0.0, depth / gap_width)))
                    if ce_time is None and float(bj["high"]) >= ce_price:
                        ce_time = int(bj["time"])
                    if full_time is None and float(bj["high"]) >= gap_high:
                        full_time = int(bj["time"])
                        fill_pct = 1.0
                        break

        mitigated_at = ce_time if mitigation_mode == "CONSEQUENT_ENCROACHMENT" else full_time
        fvgs.append(
            {
                "id": f"{fvg_type}:{int(b_right['time'])}",
                "type": fvg_type,
                "formedAtTime": int(b_right["time"]),
                "displacementTime": int(b_mid["time"]),
                "gapLow": gap_low,
                "gapHigh": gap_high,
                "gapWidth": gap_width,
                "consequentEncroachment": ce_price,
                "rangeZScore": z_val,
                "lvnPercentile": lvn_pct,
                "averageGapBinVolume": avg_gap_vol,
                "barDelta": delta_val,
                "deltaImbalanceRatio": delta_ratio,
                "fillPct": fill_pct,
                "ceTouched": ce_time is not None,
                "ceTouchTime": ce_time,
                "fullFillTime": full_time,
                "isMitigated": mitigated_at is not None,
                "mitigatedAtTime": mitigated_at,
            }
        )

    return {
        "status": "OK",
        "asOfUtcSec": as_of_utc_sec,
        "barSeconds": bar_seconds,
        "tickSize": tick_size,
        "closedBarCount": len(closed),
        "excludedFutureCount": excluded,
        "fvgs": fvgs,
        "activeFvgs": [g for g in fvgs if not g["isMitigated"]],
    }


def py_detect_fobs(
    bars: list[dict[str, Any]],
    as_of_utc_sec: int,
    bar_seconds: int,
    z_window: int = 20,
    min_z: float = 1.5,
    swing_lookback: int = 5,
    max_base_bars: int = 5,
    min_abs_vol_pct: float = 85.0,
    min_dp_share: float = 0.35,
    anchor_mode: str = "INTERNAL_POC_OR_VWAP",
) -> dict[str, Any]:
    closed = [b for b in bars if b["time"] + bar_seconds <= as_of_utc_sec]
    excluded = len(bars) - len(closed)
    obs: list[dict[str, Any]] = []

    for d in range(z_window, len(closed)):
        bd = closed[d]
        z_val = causal_range_zscore(closed, d, z_window)
        if not math.isfinite(z_val) or z_val <= min_z:
            continue

        sw_start = max(0, d - swing_lookback)
        prior_high = max(float(closed[k]["high"]) for k in range(sw_start, d))
        prior_low = min(float(closed[k]["low"]) for k in range(sw_start, d))

        if float(bd["close"]) > prior_high and float(bd["close"]) > float(bd["open"]):
            fob_type = "BULLISH_FOB"
            broken_level = prior_high
        elif float(bd["close"]) < prior_low and float(bd["close"]) < float(bd["open"]):
            fob_type = "BEARISH_FOB"
            broken_level = prior_low
        else:
            continue

        base_start = max(0, d - max_base_bars)
        chosen: dict[str, Any] | None = None
        for b in range(d - 1, base_start - 1, -1):
            cand = closed[b]
            if float(cand["volume"]) <= 0.0:
                continue
            b_delta = resolve_bar_delta(cand)
            body = float(cand["close"]) - float(cand["open"])
            abs_div = (body < 0.0 and b_delta > 0.0) or (body > 0.0 and b_delta < 0.0)
            vol_win = [float(closed[w]["volume"]) for w in range(max(0, b - z_window + 1), b + 1)]
            vol_pct = empirical_percentile(vol_win, float(cand["volume"]))
            hi_vol = vol_pct >= min_abs_vol_pct
            dp_vol = resolve_dp_volume(cand)
            dp_share = dp_vol / float(cand["volume"])
            dp_fp = dp_share >= min_dp_share
            if abs_div or hi_vol or dp_fp:
                chosen = {
                    "bar": cand,
                    "delta": b_delta,
                    "vol_pct": vol_pct,
                    "dp_vol": dp_vol,
                    "dp_share": dp_share,
                    "abs_div": abs_div,
                    "hi_vol": hi_vol,
                    "dp_fp": dp_fp,
                }
                break

        if chosen is None:
            continue

        base_bar = chosen["bar"]
        zone_low = float(base_bar["low"])
        zone_high = float(base_bar["high"])

        ipoc = base_bar.get("internalPoc")
        vw = base_bar.get("vw")
        if isinstance(ipoc, (int, float)) and math.isfinite(ipoc) and ipoc > 0:
            anchor_price = float(ipoc)
            anchor_src = "INTERNAL_POC"
        elif isinstance(vw, (int, float)) and math.isfinite(vw) and vw > 0:
            anchor_price = float(vw)
            anchor_src = "VWAP"
        elif anchor_mode == "HLC3":
            anchor_price = (float(base_bar["high"]) + float(base_bar["low"]) + float(base_bar["close"])) / 3.0
            anchor_src = "HLC3"
        else:
            anchor_price = float("nan")
            anchor_src = "NONE"

        touches = 0
        is_fresh = True
        is_mitigated = False
        perforated = False
        first_touch: int | None = None
        mitigated_at: int | None = None

        for j in range(d + 1, len(closed)):
            if is_mitigated:
                break
            bj = closed[j]
            if float(bj["low"]) <= zone_high and float(bj["high"]) >= zone_low:
                touches += 1
                if touches == 1:
                    first_touch = int(bj["time"])
                is_perf = (float(bj["low"]) < zone_low) if fob_type == "BULLISH_FOB" else (float(bj["high"]) > zone_high)
                is_fresh = False
                if is_perf or touches >= 2:
                    perforated = is_perf
                    is_mitigated = True
                    mitigated_at = int(bj["time"])

        obs.append(
            {
                "id": f"{fob_type}:{int(base_bar['time'])}->{int(bd['time'])}",
                "type": fob_type,
                "baseTime": int(base_bar["time"]),
                "formedAtTime": int(bd["time"]),
                "zoneLow": zone_low,
                "zoneHigh": zone_high,
                "anchorPrice": serialize_num(anchor_price),
                "anchorSource": anchor_src,
                "displacementZScore": z_val,
                "brokenSwingLevel": broken_level,
                "baseDelta": chosen["delta"],
                "baseVolumePercentile": chosen["vol_pct"],
                "darkPoolVolume": chosen["dp_vol"],
                "darkPoolShare": chosen["dp_share"],
                "absorptionDivergence": chosen["abs_div"],
                "highVolumeAbsorption": chosen["hi_vol"],
                "darkPoolFootprint": chosen["dp_fp"],
                "isFresh": is_fresh,
                "touchCount": touches,
                "firstTouchTime": first_touch,
                "perforated": perforated,
                "isMitigated": is_mitigated,
                "mitigatedAtTime": mitigated_at,
            }
        )

    return {
        "status": "OK",
        "asOfUtcSec": as_of_utc_sec,
        "barSeconds": bar_seconds,
        "closedBarCount": len(closed),
        "excludedFutureCount": excluded,
        "orderBlocks": obs,
        "freshOrderBlocks": [o for o in obs if o["isFresh"] and not o["isMitigated"]],
    }


def py_classify_lee_ready(
    trades: list[dict[str, Any]],
    quotes: list[dict[str, Any]],
    allow_tick_fallback_without_quote: bool = False,
) -> dict[str, Any]:
    valid_quotes = [
        q
        for q in quotes
        if math.isfinite(q["timestamp"])
        and math.isfinite(q["bid"])
        and math.isfinite(q["ask"])
        and q["bid"] > 0.0
        and q["ask"] >= q["bid"]
    ]
    valid_quotes.sort(key=lambda q: q["timestamp"])

    q_idx = -1
    last_price = float("nan")
    prev_distinct = float("nan")

    lit_buy = lit_sell = lit_undet = 0.0
    dp_buy = dp_sell = dp_undet = 0.0
    classified: list[dict[str, Any]] = []

    for t in trades:
        ts = float(t["timestamp"])
        price = float(t["price"])
        size = float(t["size"])

        while q_idx + 1 < len(valid_quotes) and valid_quotes[q_idx + 1]["timestamp"] <= ts:
            q_idx += 1

        matched = valid_quotes[q_idx] if q_idx >= 0 else None

        if math.isfinite(last_price):
            ref_price = last_price if abs(price - last_price) > PRICE_EPS else prev_distinct
        else:
            ref_price = float("nan")

        side = "UNDETERMINED"
        rule = "UNDETERMINED"
        if matched is not None:
            mid = 0.5 * (float(matched["bid"]) + float(matched["ask"]))
            if price > mid + PRICE_EPS:
                side = "BUY_AGGRESSOR"
                rule = "QUOTE_RULE"
            elif price < mid - PRICE_EPS:
                side = "SELL_AGGRESSOR"
                rule = "QUOTE_RULE"
            else:
                if math.isfinite(ref_price):
                    if price > ref_price + PRICE_EPS:
                        side = "BUY_AGGRESSOR"
                        rule = "TICK_RULE"
                    elif price < ref_price - PRICE_EPS:
                        side = "SELL_AGGRESSOR"
                        rule = "TICK_RULE"
        elif allow_tick_fallback_without_quote and math.isfinite(ref_price):
            if price > ref_price + PRICE_EPS:
                side = "BUY_AGGRESSOR"
                rule = "TICK_RULE"
            elif price < ref_price - PRICE_EPS:
                side = "SELL_AGGRESSOR"
                rule = "TICK_RULE"

        if not math.isfinite(last_price):
            last_price = price
        elif abs(price - last_price) > PRICE_EPS:
            prev_distinct = last_price
            last_price = price

        sign = 1 if side == "BUY_AGGRESSOR" else (-1 if side == "SELL_AGGRESSOR" else 0)
        trf_ts = t.get("trfTimestamp")
        has_trf = isinstance(trf_ts, (int, float)) and math.isfinite(trf_ts) and trf_ts > 0
        is_dp = t.get("exchange") == FINRA_TRF_EXCHANGE or has_trf
        venue = "DARK_POOL_TRF" if is_dp else "LIT"

        if is_dp:
            if sign == 1:
                dp_buy += size
            elif sign == -1:
                dp_sell += size
            else:
                dp_undet += size
        else:
            if sign == 1:
                lit_buy += size
            elif sign == -1:
                lit_sell += size
            else:
                lit_undet += size

        classified.append(
            {
                "timestamp": int(t["timestamp"]),
                "price": price,
                "size": size,
                "side": side,
                "sign": sign,
                "rule": rule,
                "venue": venue,
                "matchedBid": serialize_num(float(matched["bid"]) if matched is not None else float("nan")),
                "matchedAsk": serialize_num(float(matched["ask"]) if matched is not None else float("nan")),
                "matchedMidpoint": serialize_num(
                    0.5 * (float(matched["bid"]) + float(matched["ask"])) if matched is not None else float("nan")
                ),
            }
        )

    total_buy = lit_buy + dp_buy
    total_sell = lit_sell + dp_sell
    undet = lit_undet + dp_undet
    total_dp = dp_buy + dp_sell + dp_undet
    total_lit = lit_buy + lit_sell + lit_undet
    total_vol = total_dp + total_lit

    return {
        "status": "OK",
        "tradeCount": len(classified),
        "validQuoteCount": len(valid_quotes),
        "litBuyVolume": lit_buy,
        "litSellVolume": lit_sell,
        "litUndeterminedVolume": lit_undet,
        "darkPoolBuyVolume": dp_buy,
        "darkPoolSellVolume": dp_sell,
        "darkPoolUndeterminedVolume": dp_undet,
        "totalBuyVolume": total_buy,
        "totalSellVolume": total_sell,
        "undeterminedVolume": undet,
        "totalDarkPoolVolume": total_dp,
        "totalLitVolume": total_lit,
        "totalVolume": total_vol,
        "darkPoolShare": total_dp / total_vol,
        "netCvd": total_buy - total_sell,
        "classifiedTrades": classified,
    }


def py_l1_book_imbalance(bid_p: float, ask_p: float, bid_s: float, ask_s: float) -> dict[str, Any]:
    total = bid_s + ask_s
    mid = 0.5 * (bid_p + ask_p)
    spread = ask_p - bid_p
    return {
        "status": "OK",
        "midpoint": mid,
        "spread": spread,
        "spreadBps": (spread / mid) * 10000.0,
        "imbalance": (bid_s - ask_s) / total,
        "microprice": (bid_p * ask_s + ask_p * bid_s) / total,
    }


def build_fixture() -> dict[str, Any]:
    # 1. AMT Composite Volume Profile Scenario
    t0 = utc_from_et(2026, 3, 2, 9, 30)
    amt_bars = [
        {"time": t0 + 0 * 300, "open": 581.50, "high": 582.00, "low": 581.25, "close": 581.75, "volume": 12000.0, "vw": 581.65},
        {"time": t0 + 1 * 300, "open": 581.75, "high": 582.00, "low": 581.50, "close": 581.75, "volume": 15000.0, "vw": 581.75},
        {"time": t0 + 2 * 300, "open": 581.75, "high": 582.25, "low": 581.50, "close": 582.00, "volume": 13500.0},
        {"time": t0 + 3 * 300, "open": 582.00, "high": 582.75, "low": 581.75, "close": 582.50, "volume": 8000.0, "vw": 582.30},
        {"time": t0 + 4 * 300, "open": 582.50, "high": 583.50, "low": 582.25, "close": 583.25, "volume": 3200.0},
        {"time": t0 + 5 * 300, "open": 583.25, "high": 585.00, "low": 583.25, "close": 584.75, "volume": 1600.0},
        {"time": t0 + 6 * 300, "open": 584.75, "high": 585.25, "low": 584.50, "close": 584.75, "volume": 1400.0, "vw": 584.80},
        {"time": t0 + 7 * 300, "open": 584.75, "high": 584.75, "low": 584.75, "close": 584.75, "volume": 500.0},
        # Future unclosed bar as of t0 + 8 * 300
        {"time": t0 + 8 * 300, "open": 584.75, "high": 586.00, "low": 584.50, "close": 585.75, "volume": 25000.0},
    ]
    amt_as_of = t0 + 8 * 300
    amt_expected = py_compute_volume_profile_amt(amt_bars, amt_as_of, 300, 0.25)

    # 2. Multi-Session ET Naked POCs Scenario (4 consecutive ET trading days)
    d1 = utc_from_et(2026, 3, 2, 10, 0)
    d2 = utc_from_et(2026, 3, 3, 10, 0)
    d3 = utc_from_et(2026, 3, 4, 10, 0)
    d4 = utc_from_et(2026, 3, 5, 10, 0)
    naked_bars = [
        # Session 1 (POC ~ 580.00 -> NEVER tested in sessions 2..4)
        {"time": d1, "open": 580.00, "high": 580.25, "low": 579.75, "close": 580.00, "volume": 18000.0, "vw": 580.00},
        {"time": d1 + 300, "open": 580.00, "high": 581.00, "low": 580.00, "close": 580.75, "volume": 4000.0},
        # Session 2 (POC ~ 586.00 -> NOT tested in session 3; tested in session 4 bar #2!)
        {"time": d2, "open": 586.00, "high": 586.25, "low": 585.75, "close": 586.00, "volume": 22000.0, "vw": 586.00},
        {"time": d2 + 300, "open": 586.00, "high": 587.25, "low": 586.00, "close": 587.00, "volume": 5000.0},
        # Session 3 (POC ~ 590.00 -> tested immediately in session 4 bar #1)
        {"time": d3, "open": 590.00, "high": 590.25, "low": 589.75, "close": 590.00, "volume": 20000.0, "vw": 590.00},
        {"time": d3 + 300, "open": 590.00, "high": 591.00, "low": 589.50, "close": 590.50, "volume": 4500.0},
        # Session 4 bar #0 touches Session 3 POC (590.00), stays above 586.00
        {"time": d4, "open": 590.25, "high": 590.50, "low": 589.75, "close": 589.80, "volume": 9000.0},
        # Session 4 bar #1 drops to 586.10 (within 0.125 tolerance of 586.00!)
        {"time": d4 + 300, "open": 589.80, "high": 589.90, "low": 586.10, "close": 586.20, "volume": 11000.0},
        # Future unclosed bar touching 580.00 after late_as_of
        {"time": d4 + 600, "open": 586.20, "high": 586.25, "low": 579.90, "close": 580.00, "volume": 14000.0},
    ]
    naked_early_as_of = d4 + 300  # closes bar #0 only -> Session 3 mitigated, Session 1 & 2 still naked
    naked_late_as_of = d4 + 600   # closes bar #1 -> Session 2 mitigated, Session 1 still naked (bar #2 future excluded)

    # 3. Quantitative FVGs Scenario
    fvg_t0 = utc_from_et(2026, 3, 6, 9, 30)
    fvg_bars: list[dict[str, Any]] = []
    # 21 baseline bars sweeping across [491.00 .. 500.75] (~40 active bins) with narrow 0.50-0.75 ranges
    for k in range(21):
        step_base = 491.00 + ((k * 7) % 10) * 1.00
        bar_rng = 0.50 if (k % 2 == 0) else 0.75
        fvg_bars.append(
            {
                "time": fvg_t0 + k * 300,
                "open": step_base + 0.10,
                "high": step_base + bar_rng,
                "low": step_base,
                "close": step_base + bar_rng - 0.10,
                "volume": 16000.0,
                "delta": 200.0,
            }
        )
    # Index 21 = left bar (high = 500.75)
    fvg_bars.append({"time": fvg_t0 + 21 * 300, "open": 500.20, "high": 500.75, "low": 500.00, "close": 500.65, "volume": 12000.0, "delta": 1500.0})
    # Index 22 = central displacement bar (Bullish FVG impulse: R=2.50, Z>>1.5, strong +delta/vol=0.80)
    fvg_bars.append({"time": fvg_t0 + 22 * 300, "open": 500.70, "high": 503.20, "low": 500.70, "close": 503.10, "volume": 1000.0, "delta": 800.0})
    # Index 23 = right bar closing above 502.50 -> Bullish FVG [500.75, 502.50] formed at time = fvg_t0 + 23 * 300
    fvg_bars.append({"time": fvg_t0 + 23 * 300, "open": 503.05, "high": 503.50, "low": 502.50, "close": 503.25, "volume": 11000.0, "delta": 3500.0})
    # Index 24 = trades above gap (no mitigation yet)
    fvg_bars.append({"time": fvg_t0 + 24 * 300, "open": 503.25, "high": 503.75, "low": 502.75, "close": 503.00, "volume": 10000.0, "delta": -400.0})
    # Index 25 = touches 50% CE (501.625) down to 501.50 (partial fill = (502.50-501.50)/1.75)
    fvg_bars.append({"time": fvg_t0 + 25 * 300, "open": 503.00, "high": 503.10, "low": 501.50, "close": 502.00, "volume": 6500.0, "delta": -1800.0})
    # Index 26 = fills Bullish FVG down to 500.50 (100% full fill!)
    fvg_bars.append({"time": fvg_t0 + 26 * 300, "open": 502.00, "high": 502.10, "low": 500.50, "close": 500.60, "volume": 8000.0, "delta": -200.0})
    # Index 27..30 = re-accumulate above 491.00 before Bearish FVG drop into thin sub-491 zone
    for k in range(27, 31):
        fvg_bars.append({"time": fvg_t0 + k * 300, "open": 491.50, "high": 492.00, "low": 491.25, "close": 491.75, "volume": 12000.0, "delta": 100.0})
    # Index 31 = Bearish FVG left bar (low = 490.75, tight low-volume breakdown start)
    fvg_bars.append({"time": fvg_t0 + 31 * 300, "open": 491.25, "high": 491.50, "low": 490.75, "close": 490.80, "volume": 1200.0, "delta": -600.0})
    # Index 32 = Bearish displacement bar (R=3.50, Z>>1.5, strong negative delta ratio = -0.85)
    fvg_bars.append({"time": fvg_t0 + 32 * 300, "open": 490.80, "high": 490.80, "low": 487.30, "close": 487.50, "volume": 1000.0, "delta": -850.0})
    # Index 33 = Bearish FVG right bar (high = 489.00) -> Bearish FVG [489.00, 490.75]
    fvg_bars.append({"time": fvg_t0 + 33 * 300, "open": 487.50, "high": 489.00, "low": 487.25, "close": 487.60, "volume": 1600.0, "delta": -1000.0})
    # Index 34 = partial bounce into Bearish FVG to 489.35 (fill = 0.35 / 1.75 = 20%, < 50% CE = 489.875)
    fvg_bars.append({"time": fvg_t0 + 34 * 300, "open": 487.60, "high": 489.35, "low": 487.50, "close": 488.10, "volume": 1400.0, "delta": 300.0})
    # Index 35..37 = candidate gap WITH WRONG DELTA SIGN (+delta on drop) -> MUST BE REJECTED
    fvg_bars.append({"time": fvg_t0 + 35 * 300, "open": 488.10, "high": 488.30, "low": 487.90, "close": 488.00, "volume": 4000.0, "delta": 100.0})
    fvg_bars.append({"time": fvg_t0 + 36 * 300, "open": 488.00, "high": 488.00, "low": 484.50, "close": 484.60, "volume": 900.0, "delta": 700.0})
    fvg_bars.append({"time": fvg_t0 + 37 * 300, "open": 484.60, "high": 485.80, "low": 484.40, "close": 484.80, "volume": 3500.0, "delta": -500.0})

    fvg_full_as_of = fvg_t0 + 38 * 300
    fvg_partial_as_of = fvg_t0 + 26 * 300           # after bar 25 closes (50% CE touched, not full fill yet!)
    fvg_before_formation_as_of = fvg_t0 + 23 * 300  # bar 23 (t0+23*300) NOT CLOSED yet!

    # 4. Fresh Order Blocks (FOB) Scenario
    fob_t0 = utc_from_et(2026, 3, 9, 9, 30)
    fob_bars: list[dict[str, Any]] = []
    for k in range(20):
        low_p = 400.00 + (0.02 if k % 2 == 0 else 0.0)
        high_p = 400.40 + (0.04 if k % 3 == 0 else 0.0)
        fob_bars.append(
            {
                "time": fob_t0 + k * 300,
                "open": 400.10,
                "high": high_p,
                "low": low_p,
                "close": 400.30,
                "volume": 2000.0,
                "delta": 100.0,
            }
        )
    # Index 20 = Bearish-bodied Base candle with Positive absorption delta + High volume (>=85th pct) + explicit internalPoc
    fob_bars.append(
        {
            "time": fob_t0 + 20 * 300,
            "open": 400.28,
            "high": 400.35,
            "low": 399.90,
            "close": 400.00,
            "volume": 9500.0,
            "delta": 3200.0,
            "internalPoc": 400.08,
            "vw": 400.12,
        }
    )
    # Index 21 = Bullish displacement candle breaking Swing High (400.44) with huge Z-Score
    fob_bars.append(
        {
            "time": fob_t0 + 21 * 300,
            "open": 400.00,
            "high": 402.20,
            "low": 399.98,
            "close": 402.10,
            "volume": 8000.0,
            "delta": 5500.0,
        }
    )
    # Index 22 = Narrow quiet pause above zone [399.90, 400.35] -> Z < 1.5, BULLISH_FOB remains unique & FRESH
    fob_bars.append({"time": fob_t0 + 22 * 300, "open": 402.10, "high": 402.25, "low": 401.90, "close": 402.15, "volume": 2500.0, "delta": 400.0})
    # Index 23 = 1st retest cleanly inside [399.90, 400.35] without distal perforation (low = 400.05 >= 399.90)
    # Notice open > close (402.15 -> 401.80) so it does not trigger a spurious Bullish FOB!
    fob_bars.append({"time": fob_t0 + 23 * 300, "open": 402.15, "high": 402.20, "low": 400.05, "close": 401.80, "volume": 3200.0, "delta": -900.0})
    # Index 24 = Steady bars before Bearish Dark Pool FOB
    for k in range(24, 28):
        fob_bars.append({"time": fob_t0 + k * 300, "open": 401.80, "high": 402.20, "low": 401.70, "close": 401.95, "volume": 2100.0, "delta": 50.0})
    # Index 28 = Bullish base candle with FINRA TRF Dark Pool footprint (exchange = 4, darkPoolVolume = 4200 / 5000 = 84%)
    fob_bars.append(
        {
            "time": fob_t0 + 28 * 300,
            "open": 401.90,
            "high": 402.40,
            "low": 401.85,
            "close": 402.30,
            "volume": 5000.0,
            "delta": 400.0,
            "exchange": FINRA_TRF_EXCHANGE,
            "vw": 402.18,
        }
    )
    # Index 29 = Bearish displacement breaking Swing Low (400.05? no wait swingLookback=5 looks back at indices 24..28 where min low=401.70 -> closes 398.90 < 401.70!)
    # Notice index 29 ALSO hits index 20's zone [399.90, 400.35] AND breaks 399.90 -> 2nd touch + perforated -> Bullish FOB mitigated!
    fob_bars.append(
        {
            "time": fob_t0 + 29 * 300,
            "open": 402.30,
            "high": 402.32,
            "low": 398.80,
            "close": 398.90,
            "volume": 8800.0,
            "delta": -6200.0,
        }
    )
    # Index 30 = Stays below Bearish FOB [401.85, 402.40] -> Bearish FOB stays FRESH
    fob_bars.append({"time": fob_t0 + 30 * 300, "open": 398.90, "high": 399.50, "low": 398.40, "close": 398.60, "volume": 2400.0, "delta": -400.0})

    fob_fresh_as_of = fob_t0 + 23 * 300      # closes bar 22 only (Bullish FOB isFresh=True, touchCount=0)
    fob_first_touch_as_of = fob_t0 + 24 * 300 # closes bar 23 (Bullish FOB touchCount=1, isFresh=False, isMitigated=False)
    fob_final_as_of = fob_t0 + 31 * 300       # closes bar 30 (Bullish FOB mitigated=True; Bearish DP FOB isFresh=True)

    # 5. Lee-Ready + FINRA TRF + L1 Book Imbalance Scenario (nanosecond-scale monotonic timestamps!)
    base_ns = 1_772_800_200_000_000_000
    lr_quotes = [
        {"timestamp": base_ns + 1_000_000, "bid": 580.00, "ask": 580.10, "bidSize": 800, "askSize": 400},
        # Invalid crossed quote -> must be ignored cleanly
        {"timestamp": base_ns + 2_000_000, "bid": 580.20, "ask": 580.10, "bidSize": 100, "askSize": 100},
        # Invalid zero bid -> must be ignored cleanly
        {"timestamp": base_ns + 2_500_000, "bid": 0.00, "ask": 580.10, "bidSize": 100, "askSize": 100},
        {"timestamp": base_ns + 5_000_000, "bid": 580.04, "ask": 580.10, "bidSize": 500, "askSize": 1000},
        {"timestamp": base_ns + 9_000_000, "bid": 580.00, "ask": 580.10, "bidSize": 600, "askSize": 600},
    ]
    lr_trades = [
        # Before first quote -> UNDETERMINED under strict NBBO mode
        {"timestamp": base_ns + 500_000, "price": 580.03, "size": 50.0, "exchange": 11},
        # Matches quote@1ms (mid=580.05): price 580.08 > mid -> BUY_AGGRESSOR (QUOTE_RULE, LIT)
        {"timestamp": base_ns + 1_500_000, "price": 580.08, "size": 200.0, "exchange": 11},
        # Matches quote@1ms (mid=580.05): price 580.05 == mid, prev=580.08 -> SELL_AGGRESSOR (TICK_RULE, LIT)
        {"timestamp": base_ns + 3_000_000, "price": 580.05, "size": 150.0, "exchange": 12},
        # Matches quote@1ms (mid=580.05): zero-tick at 580.05, prevDistinct=580.08 -> SELL_AGGRESSOR (TICK_RULE, DARK_POOL_TRF via exchange=4)
        {"timestamp": base_ns + 3_500_000, "price": 580.05, "size": 300.0, "exchange": 4},
        # Matches quote@5ms (mid=580.07): price 580.09 > mid -> BUY_AGGRESSOR (QUOTE_RULE, DARK_POOL_TRF via trfTimestamp)
        {"timestamp": base_ns + 6_000_000, "price": 580.09, "size": 500.0, "exchange": 10, "trfTimestamp": base_ns + 6_000_500},
        # Matches quote@5ms (mid=580.07): price 580.02 < mid -> SELL_AGGRESSOR (QUOTE_RULE, LIT)
        {"timestamp": base_ns + 7_000_000, "price": 580.02, "size": 100.0, "exchange": 11},
        # Matches quote@9ms (mid=580.05): price 580.05 == mid, prev=580.02 -> BUY_AGGRESSOR (TICK_RULE, LIT)
        {"timestamp": base_ns + 9_500_000, "price": 580.05, "size": 250.0, "exchange": 11},
    ]

    l1_cases = [
        {"bidPrice": 580.00, "askPrice": 580.10, "bidSize": 800, "askSize": 200},
        {"bidPrice": 580.00, "askPrice": 580.10, "bidSize": 250, "askSize": 750},
        {"bidPrice": 580.00, "askPrice": 580.10, "bidSize": 500, "askSize": 500},
        {"bidPrice": 100.00, "askPrice": 100.00, "bidSize": 300, "askSize": 100},
    ]

    return {
        "metadata": {
            "piece": 15,
            "generator": "tools/gen_amt_fvg_leeready_fixture.py",
            "timezone": "America/New_York",
        },
        "volumeProfileAmtScenario": {
            "bars": amt_bars,
            "options": {"asOfUtcSec": amt_as_of, "barSeconds": 300, "tickSize": 0.25},
            "expected": amt_expected,
        },
        "nakedPocsScenario": {
            "bars": naked_bars,
            "earlyOptions": {"asOfUtcSec": naked_early_as_of, "barSeconds": 300, "tickSize": 0.25, "touchTolerance": 0.125},
            "lateOptions": {"asOfUtcSec": naked_late_as_of, "barSeconds": 300, "tickSize": 0.25, "touchTolerance": 0.125},
            "earlyExpected": py_track_naked_pocs(naked_bars, naked_early_as_of, 300, 0.25, 0.125),
            "lateExpected": py_track_naked_pocs(naked_bars, naked_late_as_of, 300, 0.25, 0.125),
        },
        "quantitativeFvgsScenario": {
            "bars": fvg_bars,
            "tickSize": 0.25,
            "barSeconds": 300,
            "beforeFormationAsOf": fvg_before_formation_as_of,
            "partialAsOf": fvg_partial_as_of,
            "fullAsOf": fvg_full_as_of,
            "beforeFormationFullFillExpected": py_detect_fvgs(fvg_bars, fvg_before_formation_as_of, 300, 0.25, mitigation_mode="FULL_FILL"),
            "partialFullFillExpected": py_detect_fvgs(fvg_bars, fvg_partial_as_of, 300, 0.25, mitigation_mode="FULL_FILL"),
            "partialCeModeExpected": py_detect_fvgs(fvg_bars, fvg_partial_as_of, 300, 0.25, mitigation_mode="CONSEQUENT_ENCROACHMENT"),
            "fullFillExpected": py_detect_fvgs(fvg_bars, fvg_full_as_of, 300, 0.25, mitigation_mode="FULL_FILL"),
            "ceModeExpected": py_detect_fvgs(fvg_bars, fvg_full_as_of, 300, 0.25, mitigation_mode="CONSEQUENT_ENCROACHMENT"),
        },
        "freshOrderBlocksScenario": {
            "bars": fob_bars,
            "barSeconds": 300,
            "freshAsOf": fob_fresh_as_of,
            "firstTouchAsOf": fob_first_touch_as_of,
            "finalAsOf": fob_final_as_of,
            "freshExpected": py_detect_fobs(fob_bars, fob_fresh_as_of, 300),
            "firstTouchExpected": py_detect_fobs(fob_bars, fob_first_touch_as_of, 300),
            "finalExpected": py_detect_fobs(fob_bars, fob_final_as_of, 300),
        },
        "leeReadyAndBookScenario": {
            "trades": lr_trades,
            "quotes": lr_quotes,
            "strictExpected": py_classify_lee_ready(lr_trades, lr_quotes, allow_tick_fallback_without_quote=False),
            "tickFallbackExpected": py_classify_lee_ready(lr_trades, lr_quotes, allow_tick_fallback_without_quote=True),
            "l1BookCases": [
                {"input": c, "expected": py_l1_book_imbalance(c["bidPrice"], c["askPrice"], c["bidSize"], c["askSize"])}
                for c in l1_cases
            ],
        },
    }


def main() -> None:
    repo_root = Path(__file__).resolve().parent.parent
    out_path = repo_root / "fixtures" / "amt_fvg_leeready_reference.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = build_fixture()
    out_path.write_text(json.dumps(payload, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
