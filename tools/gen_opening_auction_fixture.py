"""Independent Python reference generator for Pieza 9 (Opening Auction & Overnight Liquidity).

Generates `fixtures/opening_auction_reference.json` using Python's `zoneinfo`,
`datetime`, `statistics.median`, and pure math without copying TypeScript logic.
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path
from statistics import median
from typing import Any
from zoneinfo import ZoneInfo

ET_TZ = ZoneInfo("America/New_York")
TOLERANCE = 1e-9

PRE_START_MIN = 4 * 60
MACRO_START_MIN = 8 * 60 + 30
MACRO_END_MIN = 8 * 60 + 35
RTH_START_MIN = 9 * 60 + 30
IB_END_MIN = 10 * 60 + 30
RTH_END_MIN = 16 * 60


def utc_from_et(year: int, month: int, day: int, hour: int, minute: int, second: int = 0) -> int:
    """Convert wall-clock America/New_York datetime cleanly to integer UTC seconds."""
    dt_et = datetime(year, month, day, hour, minute, second, tzinfo=ET_TZ)
    return int(dt_et.timestamp())


def et_parts(utc_sec: int) -> tuple[str, int]:
    """Return (YYYY-MM-DD, minutes_of_day) in America/New_York."""
    dt_et = datetime.fromtimestamp(utc_sec, tz=timezone.utc).astimezone(ET_TZ)
    return dt_et.strftime("%Y-%m-%d"), dt_et.hour * 60 + dt_et.minute


def to_json_scalar(val: float) -> float | str:
    if not math.isfinite(val):
        return "NaN"
    return float(val)


def py_bin_index(price: float, tick_size: float) -> int:
    return int(math.floor(price / tick_size + 0.5 + 1e-12))


def py_overnight_profile(
    pre_bars: list[dict[str, Any]],
    tick_size: float = 0.05,
    value_area_pct: float = 0.70,
) -> dict[str, Any]:
    usable = [
        b
        for b in pre_bars
        if all(math.isfinite(float(b[k])) for k in ("open", "high", "low", "close", "volume"))
        and float(b["volume"]) >= 0.0
        and float(b["high"]) >= float(b["low"])
    ]
    if not usable:
        return {
            "pmh": "NaN",
            "pml": "NaN",
            "onPoc": "NaN",
            "onVah": "NaN",
            "onVal": "NaN",
            "preMarketVwap": "NaN",
            "totalVolume": 0.0,
            "valueAreaVolume": 0.0,
            "valueAreaCoverage": "NaN",
            "bins": [],
        }

    pmh = max(float(b["high"]) for b in usable)
    pml = min(float(b["low"]) for b in usable)
    pos_bars = [b for b in usable if float(b["volume"]) > 0.0]
    if not pos_bars:
        return {
            "pmh": pmh,
            "pml": pml,
            "onPoc": "NaN",
            "onVah": "NaN",
            "onVal": "NaN",
            "preMarketVwap": "NaN",
            "totalVolume": 0.0,
            "valueAreaVolume": 0.0,
            "valueAreaCoverage": "NaN",
            "bins": [],
        }

    # Pre-market VWAP (vw if positive finite, else HLC3)
    pv_sum = 0.0
    v_sum = 0.0
    bin_dict: dict[int, float] = {}
    for b in pos_bars:
        vol = float(b["volume"])
        hi = float(b["high"])
        lo = float(b["low"])
        cl = float(b["close"])
        vw = b.get("vw")
        px = float(vw) if (vw is not None and math.isfinite(float(vw)) and float(vw) > 0.0) else (hi + lo + cl) / 3.0
        pv_sum += px * vol
        v_sum += vol

        if hi == lo:
            idx = py_bin_index(cl, tick_size)
            bin_dict[idx] = bin_dict.get(idx, 0.0) + vol
        else:
            k0 = py_bin_index(lo, tick_size)
            k1 = py_bin_index(hi, tick_size)
            share = vol / (k1 - k0 + 1)
            for k in range(k0, k1 + 1):
                bin_dict[k] = bin_dict.get(k, 0.0) + share

    pm_vwap = pv_sum / v_sum
    min_k = min(bin_dict.keys())
    max_k = max(bin_dict.keys())
    vols = [bin_dict.get(k, 0.0) for k in range(min_k, max_k + 1)]
    max_v = max(vols)
    tie_eps = 1e-12 * max(1.0, max_v)

    poc_offset = 0
    best_dist = math.inf
    best_px = math.inf
    for i, v in enumerate(vols):
        if v < max_v - tie_eps:
            continue
        px = (min_k + i) * tick_size
        dist = abs(px - pm_vwap)
        if best_px == math.inf:
            poc_offset, best_dist, best_px = i, dist, px
        elif dist < best_dist - tie_eps or (abs(dist - best_dist) <= tie_eps and px < best_px):
            poc_offset, best_dist, best_px = i, dist, px

    low_i = poc_offset
    high_i = poc_offset
    covered = vols[poc_offset]
    target = value_area_pct * v_sum
    eps = 1e-12 * max(1.0, v_sum)
    while covered < target - eps and (low_i > 0 or high_i < len(vols) - 1):
        lv = vols[low_i - 1] if low_i > 0 else -1.0
        rv = vols[high_i + 1] if high_i < len(vols) - 1 else -1.0
        if lv < 0.0:
            high_i += 1
            covered += rv
        elif rv < 0.0:
            low_i -= 1
            covered += lv
        elif lv > rv + eps:
            low_i -= 1
            covered += lv
        elif rv > lv + eps:
            high_i += 1
            covered += rv
        else:
            low_i -= 1
            high_i += 1
            covered += lv + rv

    return {
        "pmh": pmh,
        "pml": pml,
        "onPoc": (min_k + poc_offset) * tick_size,
        "onVah": (min_k + high_i) * tick_size,
        "onVal": (min_k + low_i) * tick_size,
        "preMarketVwap": pm_vwap,
        "totalVolume": v_sum,
        "valueAreaVolume": covered,
        "valueAreaCoverage": covered / v_sum,
        "bins": [{"price": (min_k + i) * tick_size, "volume": v} for i, v in enumerate(vols) if v > 0.0],
    }


def py_macro_0830(
    pre_bars: list[dict[str, Any]],
    range_mult: float = 3.0,
    vol_mult: float = 5.0,
) -> dict[str, Any]:
    base_ranges: list[float] = []
    base_vols: list[float] = []
    win_bars: list[dict[str, Any]] = []
    for b in pre_bars:
        _, mins = et_parts(int(b["time"]))
        if PRE_START_MIN <= mins < MACRO_START_MIN:
            base_ranges.append(float(b["high"]) - float(b["low"]))
            base_vols.append(float(b["volume"]))
        elif MACRO_START_MIN <= mins < MACRO_END_MIN:
            win_bars.append(b)

    med_r = float(median(base_ranges)) if base_ranges else math.nan
    med_v = float(median(base_vols)) if base_vols else math.nan
    if not (math.isfinite(med_r) and med_r > 0.0 and math.isfinite(med_v) and med_v > 0.0 and win_bars):
        return {
            "macro0830Detected": False,
            "macro0830High": "NaN",
            "macro0830Low": "NaN",
            "medianPreMarketRange": to_json_scalar(med_r),
            "medianPreMarketVolume": to_json_scalar(med_v),
        }

    detected = False
    hi = -math.inf
    lo = math.inf
    for b in win_bars:
        rng = float(b["high"]) - float(b["low"])
        vol = float(b["volume"])
        if rng >= range_mult * med_r and vol >= vol_mult * med_v:
            detected = True
            hi = max(hi, float(b["high"]))
            lo = min(lo, float(b["low"]))

    return {
        "macro0830Detected": detected,
        "macro0830High": hi if detected else "NaN",
        "macro0830Low": lo if detected else "NaN",
        "medianPreMarketRange": med_r,
        "medianPreMarketVolume": med_v,
    }


def py_bar_delta(b: dict[str, Any]) -> float:
    if "delta" in b and b["delta"] is not None:
        d = float(b["delta"])
        return d if math.isfinite(d) else math.nan
    vol = float(b["volume"])
    hi = float(b["high"])
    lo = float(b["low"])
    cl = float(b["close"])
    rng = hi - lo
    if vol <= 0.0 or rng == 0.0:
        return 0.0
    return vol * (2.0 * cl - hi - lo) / rng


def py_count_crosses(closes: list[float], levels: list[float]) -> int:
    crosses = 0
    prev_side = 0
    for c, lvl in zip(closes, levels):
        if not math.isfinite(lvl):
            continue
        diff = c - lvl
        side = 1 if diff > 0.0 else (-1 if diff < 0.0 else 0)
        if side == 0:
            continue
        if prev_side != 0 and side != prev_side:
            crosses += 1
        prev_side = side
    return crosses


def py_evaluate_opening_auction(bars: list[dict[str, Any]], opts: dict[str, Any]) -> dict[str, Any]:
    as_of = int(opts["asOfUtcSec"])
    bar_sec = int(opts["barSeconds"])
    as_of_date, as_of_mins = et_parts(as_of)
    session_date = opts.get("sessionDate", as_of_date)

    tick_size = float(opts.get("tickSize", 0.05))
    va_pct = float(opts.get("valueAreaPct", 0.70))
    range_mult = float(opts.get("macroRangeMultiplier", 3.0))
    vol_mult = float(opts.get("macroVolumeMultiplier", 5.0))
    imb_thresh = float(opts.get("inventoryImbalanceThreshold", 0.85))
    cross_tol_atr = float(opts.get("openCrossToleranceAtr", 0.05))
    drive_min_rvol = float(opts.get("openDriveMinRvol", 2.5))
    prox_atr = float(opts.get("boundaryProximityAtr", 0.25))
    sweep_win_min = float(opts.get("testDriveSweepWindowMinutes", 15.0))
    rej_touch_atr = float(opts.get("rejectionTouchAtr", 0.08))

    closed: list[tuple[dict[str, Any], int]] = []
    excluded_future = 0
    for b in bars:
        t = int(b["time"])
        if t + bar_sec > as_of:
            excluded_future += 1
            continue
        dkey, mins = et_parts(t)
        if dkey == session_date and PRE_START_MIN <= mins < RTH_END_MIN:
            closed.append((b, mins))
    closed.sort(key=lambda pair: int(pair[0]["time"]))

    pm_bars = [b for b, m in closed if m < RTH_START_MIN]
    rth_entries = [(b, m) for b, m in closed if m >= RTH_START_MIN]
    rth_bars = [b for b, _ in rth_entries]

    profile = py_overnight_profile(pm_bars, tick_size=tick_size, value_area_pct=va_pct)
    macro = py_macro_0830(pm_bars, range_mult=range_mult, vol_mult=vol_mult)

    prev_close = float(opts["prevRthClose"]) if opts.get("prevRthClose") not in (None, "NaN") else math.nan
    prev_high = float(opts["prevRthHigh"]) if opts.get("prevRthHigh") not in (None, "NaN") else math.nan
    prev_low = float(opts["prevRthLow"]) if opts.get("prevRthLow") not in (None, "NaN") else math.nan
    raw_atr = float(opts["atr14d"]) if opts.get("atr14d") not in (None, "NaN") else math.nan
    atr = raw_atr if (math.isfinite(raw_atr) and raw_atr > 0.0) else math.nan
    raw_exp_vol = float(opts["expectedWindowVolume"]) if opts.get("expectedWindowVolume") not in (None, "NaN") else math.nan
    exp_vol = raw_exp_vol if (math.isfinite(raw_exp_vol) and raw_exp_vol > 0.0) else math.nan

    pmh = float(profile["pmh"]) if profile["pmh"] != "NaN" else math.nan
    pml = float(profile["pml"]) if profile["pml"] != "NaN" else math.nan
    on_poc = float(profile["onPoc"]) if profile["onPoc"] != "NaN" else math.nan

    open0930 = float(rth_bars[0]["open"]) if rth_bars else math.nan
    curr_close = float(rth_bars[-1]["close"]) if rth_bars else math.nan
    ref_price = open0930 if rth_bars else (float(pm_bars[-1]["close"]) if pm_bars else math.nan)

    true_gap = (ref_price - prev_close) if (math.isfinite(ref_price) and math.isfinite(prev_close)) else math.nan
    true_gap_atr = (true_gap / atr) if (math.isfinite(true_gap) and math.isfinite(atr)) else math.nan

    if (
        not math.isfinite(ref_price)
        or not math.isfinite(pml)
        or not math.isfinite(pmh)
        or not math.isfinite(prev_low)
        or not math.isfinite(prev_high)
        or prev_high < prev_low
        or pmh < pml
    ):
        balance_type = "INSUFFICIENT_DATA"
    elif pml <= ref_price <= pmh and prev_low <= ref_price <= prev_high:
        balance_type = "IN_BALANCE"
    else:
        balance_type = "OUT_OF_BALANCE"

    rth_vol = sum(float(b["volume"]) for b in rth_bars) if rth_bars else math.nan
    rvol = (rth_vol / exp_vol) if (rth_bars and math.isfinite(exp_vol)) else math.nan
    low_rev_prob = math.isfinite(rvol) and rvol > 2.0

    # Inventory above/below prev_close
    if not math.isfinite(prev_close) or prev_close <= 0.0 or not pm_bars:
        pct_above = math.nan
        pct_below = math.nan
    else:
        va = 0.0
        vb = 0.0
        vt = 0.0
        for b in pm_bars:
            v = float(b["volume"])
            if v <= 0.0:
                continue
            vt += v
            hi, lo, cl = float(b["high"]), float(b["low"]), float(b["close"])
            rng = hi - lo
            if rng == 0.0:
                if cl > prev_close:
                    va += v
                elif cl < prev_close:
                    vb += v
            elif lo >= prev_close:
                va += v
            elif hi <= prev_close:
                vb += v
            else:
                va += v * (hi - prev_close) / rng
                vb += v * (prev_close - lo) / rng
        pct_above = (va / vt) if vt > 0.0 else math.nan
        pct_below = (vb / vt) if vt > 0.0 else math.nan

    cum_rth_delta = sum(py_bar_delta(b) for b in rth_bars) if rth_bars else math.nan

    def sorted_targets() -> list[float]:
        cands: list[float] = []
        if math.isfinite(prev_close):
            cands.append(prev_close)
        if math.isfinite(on_poc) and not any(abs(c - on_poc) <= 1e-12 * max(1.0, abs(c)) for c in cands):
            cands.append(on_poc)
        return sorted(cands, key=lambda x: (abs(x - curr_close), x))

    inv_risk = "NEUTRAL"
    stat_targets: list[float] = []
    if rth_bars:
        if math.isfinite(pct_above) and pct_above >= imb_thresh and (
            (math.isfinite(cum_rth_delta) and cum_rth_delta < 0.0) or curr_close < open0930
        ):
            inv_risk = "LONG_LIQUIDATION_RISK"
            stat_targets = sorted_targets()
        elif math.isfinite(pct_below) and pct_below >= imb_thresh and (
            (math.isfinite(cum_rth_delta) and cum_rth_delta > 0.0) or curr_close > open0930
        ):
            inv_risk = "SHORT_COVERING_RISK"
            stat_targets = sorted_targets()

    # RTH Session VWAP (using TRADE_VWAP fallback HLC3 on RTH window)
    vwaps_rth: list[float] = []
    cum_pv = 0.0
    cum_v = 0.0
    for b in rth_bars:
        v = float(b["volume"])
        vw = b.get("vw")
        px = float(vw) if (vw is not None and math.isfinite(float(vw)) and float(vw) > 0.0) else (float(b["high"]) + float(b["low"]) + float(b["close"])) / 3.0
        if v > 0.0:
            cum_pv += px * v
            cum_v += v
        vwaps_rth.append((cum_pv / cum_v) if cum_v > 0.0 else math.nan)
    session_vwap = vwaps_rth[-1] if vwaps_rth else math.nan

    # Opening taxonomy on [09:30, 10:30)
    open_entries = [(b, m, vw) for (b, m), vw in zip(rth_entries, vwaps_rth) if m < IB_END_MIN]
    open_bars = [b for b, _, _ in open_entries]
    open_vwaps = [vw for _, _, vw in open_entries]
    open_deltas = [py_bar_delta(b) for b in open_bars]

    if not open_bars:
        opening_type = "PENDING_OPEN"
        opening_dir = "NEUTRAL"
        open_crosses = 0
        vwap_crosses = 0
    else:
        open_closes = [float(b["close"]) for b in open_bars]
        open_crosses = py_count_crosses(open_closes, [open0930] * len(open_closes))
        vwap_crosses = py_count_crosses(open_closes, open_vwaps)
        last_close = open_closes[-1]
        last_vwap = open_vwaps[-1]

        if not math.isfinite(atr):
            opening_type = "OPEN_AUCTION"
            opening_dir = "NEUTRAL"
        else:
            tol = cross_tol_atr * atr
            prox = prox_atr * atr
            rej_tol = rej_touch_atr * atr
            sweep_end = RTH_START_MIN + sweep_win_min

            def check_td(bounds: list[float], is_bull: bool) -> bool:
                if not math.isfinite(last_vwap):
                    return False
                for lvl in bounds:
                    if not math.isfinite(lvl) or abs(open0930 - lvl) > prox:
                        continue
                    swept = False
                    for b, m, _ in open_entries:
                        if m >= sweep_end:
                            break
                        if (float(b["low"]) < lvl) if is_bull else (float(b["high"]) > lvl):
                            swept = True
                            break
                    if not swept:
                        continue
                    rec = (
                        (last_close > lvl and last_close > open0930 and last_close > last_vwap)
                        if is_bull
                        else (last_close < lvl and last_close < open0930 and last_close < last_vwap)
                    )
                    if rec:
                        return True
                return False

            low_bounds = [x for x in (pml, prev_low) if math.isfinite(x)]
            high_bounds = [x for x in (pmh, prev_high) if math.isfinite(x)]
            bull_td = check_td(low_bounds, True)
            bear_td = check_td(high_bounds, False)

            def check_rr(extreme: float, is_bear: bool) -> bool:
                if not math.isfinite(extreme):
                    return False
                targets = [c for c in (on_poc, prev_close) if math.isfinite(c) and ((c < extreme) if is_bear else (c > extreme))]
                if not targets:
                    return False
                peak = math.nan
                for b, d in zip(open_bars, open_deltas):
                    if not math.isfinite(d):
                        continue
                    if is_bear and float(b["high"]) >= extreme - rej_tol and d < 0.0:
                        peak = float(b["high"])
                        break
                    if not is_bear and float(b["low"]) <= extreme + rej_tol and d > 0.0:
                        peak = float(b["low"])
                        break
                if not math.isfinite(peak):
                    return False
                rev = (
                    (last_close < extreme and last_close < open0930 and (not math.isfinite(last_vwap) or last_close < last_vwap))
                    if is_bear
                    else (last_close > extreme and last_close > open0930 and (not math.isfinite(last_vwap) or last_close > last_vwap))
                )
                if not rev:
                    return False
                for t in targets:
                    if is_bear:
                        if last_close <= t or ((peak - t) > 0.0 and (peak - last_close) >= 0.5 * (peak - t)):
                            return True
                    else:
                        if last_close >= t or ((t - peak) > 0.0 and (last_close - peak) >= 0.5 * (t - peak)):
                            return True
                return False

            ceil_rr = check_rr(pmh, True)
            floor_rr = check_rr(pml, False)

            rvol_drive = math.isfinite(rvol) and rvol > drive_min_rvol
            bull_drive = (
                rvol_drive
                and not bull_td
                and last_close > open0930 + tol
                and (not math.isfinite(last_vwap) or last_close > last_vwap)
                and all(float(b["low"]) >= open0930 - tol and float(b["close"]) >= open0930 - tol for b in open_bars)
            )
            bear_drive = (
                rvol_drive
                and not bear_td
                and last_close < open0930 - tol
                and (not math.isfinite(last_vwap) or last_close < last_vwap)
                and all(float(b["high"]) <= open0930 + tol and float(b["close"]) <= open0930 + tol for b in open_bars)
            )

            if bull_drive:
                opening_type, opening_dir = "OPEN_DRIVE", "BULLISH"
            elif bear_drive:
                opening_type, opening_dir = "OPEN_DRIVE", "BEARISH"
            elif ceil_rr and (not bear_td or inv_risk == "LONG_LIQUIDATION_RISK"):
                opening_type, opening_dir = "OPEN_REJECTION_REVERSE", "BEARISH"
            elif floor_rr and (not bull_td or inv_risk == "SHORT_COVERING_RISK"):
                opening_type, opening_dir = "OPEN_REJECTION_REVERSE", "BULLISH"
            elif bull_td:
                opening_type, opening_dir = "OPEN_TEST_DRIVE", "BULLISH"
            elif bear_td:
                opening_type, opening_dir = "OPEN_TEST_DRIVE", "BEARISH"
            elif ceil_rr:
                opening_type, opening_dir = "OPEN_REJECTION_REVERSE", "BEARISH"
            elif floor_rr:
                opening_type, opening_dir = "OPEN_REJECTION_REVERSE", "BULLISH"
            else:
                opening_type, opening_dir = "OPEN_AUCTION", "NEUTRAL"

    # Initial Balance [09:30, 10:30)
    ib_ready = (as_of_date > session_date) or (as_of_date == session_date and as_of_mins >= IB_END_MIN)
    if not ib_ready:
        ibh = math.nan
        ibl = math.nan
        ib_width = math.nan
        ib_width_atr = math.nan
        ib_class = "PENDING_IB"
    elif not open_bars:
        ibh = math.nan
        ibl = math.nan
        ib_width = math.nan
        ib_width_atr = math.nan
        ib_class = "INSUFFICIENT_DATA"
    else:
        ibh = max(float(b["high"]) for b in open_bars)
        ibl = min(float(b["low"]) for b in open_bars)
        ib_width = ibh - ibl
        if not math.isfinite(atr):
            ib_width_atr = math.nan
            ib_class = "INSUFFICIENT_DATA"
        else:
            ib_width_atr = ib_width / atr
            if ib_width_atr < 0.35:
                ib_class = "NARROW_IB_EXPANSION_ALERT"
            elif ib_width_atr > 0.80:
                ib_class = "WIDE_IB_CONSOLIDATION_BIAS"
            else:
                ib_class = "NORMAL_IB"

    return {
        "sessionDate": session_date,
        "asOfUtcSec": as_of,
        "preMarketBarCount": len(pm_bars),
        "rthBarCount": len(rth_bars),
        "excludedFutureBarCount": excluded_future,
        "pmh": to_json_scalar(pmh),
        "pml": to_json_scalar(pml),
        "onPoc": to_json_scalar(on_poc),
        "onVah": profile["onVah"],
        "onVal": profile["onVal"],
        "preMarketVwap": profile["preMarketVwap"],
        "referencePrice": to_json_scalar(ref_price),
        "open0930": to_json_scalar(open0930),
        "currentClose": to_json_scalar(curr_close),
        "sessionVwap": to_json_scalar(session_vwap),
        "trueGap": to_json_scalar(true_gap),
        "trueGapAtr": to_json_scalar(true_gap_atr),
        "macro0830Detected": macro["macro0830Detected"],
        "macro0830High": macro["macro0830High"],
        "macro0830Low": macro["macro0830Low"],
        "medianPreMarketRange": macro["medianPreMarketRange"],
        "medianPreMarketVolume": macro["medianPreMarketVolume"],
        "balanceType": balance_type,
        "rthCumVolume": to_json_scalar(rth_vol),
        "openingRvol": to_json_scalar(rvol),
        "lowImmediateReversalProb": low_rev_prob,
        "pctVolumeAbovePrevClose": to_json_scalar(pct_above),
        "pctVolumeBelowPrevClose": to_json_scalar(pct_below),
        "cumulativeRthDelta": to_json_scalar(cum_rth_delta),
        "inventoryRisk": inv_risk,
        "statisticalTargets": [float(x) for x in stat_targets],
        "openingType": opening_type,
        "openingDirection": opening_dir,
        "openCrossCount": open_crosses,
        "vwapCrossCount": vwap_crosses,
        "ibh": to_json_scalar(ibh),
        "ibl": to_json_scalar(ibl),
        "ibWidth": to_json_scalar(ib_width),
        "ibWidthAtr": to_json_scalar(ib_width_atr),
        "ibClassification": ib_class,
    }


def make_bar(
    year: int,
    month: int,
    day: int,
    hour: int,
    minute: int,
    o: float,
    h: float,
    l: float,
    c: float,
    vol: float,
    vw: float | None = None,
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "time": utc_from_et(year, month, day, hour, minute),
        "open": o,
        "high": h,
        "low": l,
        "close": c,
        "volume": vol,
    }
    if vw is not None:
        out["vw"] = vw
    return out


def build_quiet_premarket(
    year: int,
    month: int,
    day: int,
    base_mid: float,
    half_range: float,
    vol_base: float,
) -> list[dict[str, Any]]:
    """Build steady 5m pre-market bars from 07:00 to 09:25 ET."""
    bars: list[dict[str, Any]] = []
    # 07:00..09:25 in 5m increments
    t_cur = 7 * 60
    idx = 0
    while t_cur < RTH_START_MIN:
        h, m = divmod(t_cur, 60)
        offset = ((idx % 5) - 2) * (half_range * 0.20)
        mid = base_mid + offset
        lo = round(mid - half_range * 0.25, 2)
        hi = round(mid + half_range * 0.25, 2)
        op = round(mid - 0.05, 2)
        cl = round(mid + 0.05, 2)
        bars.append(make_bar(year, month, day, h, m, op, hi, lo, cl, vol_base + (idx % 3) * 100.0))
        t_cur += 5
        idx += 1
    return bars


def main() -> None:
    scenarios: list[dict[str, Any]] = []

    # (a) Bullish OPEN_DRIVE, OUT_OF_BALANCE, RVOL > 2.5, NARROW_IB_EXPANSION_ALERT (EST 2026-01-15)
    pm_a = [
        make_bar(2026, 1, 15, 7, 30, 590.20, 590.60, 589.80, 590.40, 1200.0),
        make_bar(2026, 1, 15, 8, 0, 590.40, 591.00, 589.50, 590.80, 1500.0),
        make_bar(2026, 1, 15, 8, 30, 590.80, 591.15, 590.55, 591.00, 1600.0),
        make_bar(2026, 1, 15, 9, 0, 591.00, 592.00, 590.60, 591.70, 2200.0),
        make_bar(2026, 1, 15, 9, 25, 591.65, 591.95, 591.30, 591.90, 2500.0),
    ]
    rth_a = [
        make_bar(2026, 1, 15, 9, 30, 592.40, 592.80, 592.25, 592.75, 250_000.0, 592.58),
        make_bar(2026, 1, 15, 9, 35, 592.75, 593.05, 592.65, 593.00, 180_000.0, 592.86),
        make_bar(2026, 1, 15, 9, 40, 593.00, 593.25, 592.90, 593.20, 150_000.0, 593.08),
        make_bar(2026, 1, 15, 9, 45, 593.20, 593.45, 593.10, 593.40, 140_000.0, 593.28),
        make_bar(2026, 1, 15, 9, 55, 593.40, 593.65, 593.30, 593.55, 280_000.0, 593.48),
        make_bar(2026, 1, 15, 10, 10, 593.55, 593.80, 593.45, 593.75, 250_000.0, 593.65),
        make_bar(2026, 1, 15, 10, 25, 593.75, 593.90, 593.60, 593.85, 250_000.0, 593.78),
    ]
    opts_a = {
        "asOfUtcSec": utc_from_et(2026, 1, 15, 10, 30),
        "barSeconds": 300,
        "prevRthClose": 590.00,
        "prevRthHigh": 591.20,
        "prevRthLow": 587.00,
        "atr14d": 5.00,
        "expectedWindowVolume": 500_000.0,
        "tickSize": 0.05,
    }
    scenarios.append(
        {
            "id": "scenario_a_open_drive_narrow_ib",
            "bars": pm_a + rth_a,
            "options": opts_a,
            "expected": py_evaluate_opening_auction(pm_a + rth_a, opts_a),
        }
    )

    # (b) Bullish OPEN_TEST_DRIVE with PML sweep & recovery above Open + VWAP (EDT 2026-06-15)
    pm_b = [
        make_bar(2026, 6, 15, 7, 0, 610.00, 611.20, 608.80, 610.50, 3000.0),
        make_bar(2026, 6, 15, 8, 0, 610.50, 611.50, 609.20, 610.10, 3200.0),
        make_bar(2026, 6, 15, 9, 0, 610.10, 610.60, 608.50, 608.85, 3100.0),
    ]
    rth_b = [
        # Opens near PML=608.50 at 608.80, sweeps down to 607.80 (<608.50), closes hammer at 609.10
        make_bar(2026, 6, 15, 9, 30, 608.80, 609.20, 607.80, 609.10, 180_000.0, 608.60),
        make_bar(2026, 6, 15, 9, 35, 609.10, 609.90, 609.00, 609.85, 160_000.0, 609.55),
        make_bar(2026, 6, 15, 9, 45, 609.85, 610.40, 609.70, 610.30, 140_000.0, 610.10),
        make_bar(2026, 6, 15, 10, 25, 610.30, 610.60, 610.05, 610.50, 120_000.0, 610.35),
    ]
    opts_b = {
        "asOfUtcSec": utc_from_et(2026, 6, 15, 10, 30),
        "barSeconds": 300,
        "prevRthClose": 610.00,
        "prevRthHigh": 612.00,
        "prevRthLow": 608.00,
        "atr14d": 4.00,
        "expectedWindowVolume": 360_000.0,
        "tickSize": 0.05,
    }
    scenarios.append(
        {
            "id": "scenario_b_open_test_drive_pml_sweep",
            "bars": pm_b + rth_b,
            "options": opts_b,
            "expected": py_evaluate_opening_auction(pm_b + rth_b, opts_b),
        }
    )

    # (c) OPEN_REJECTION_REVERSE + LONG_LIQUIDATION_RISK + macro 08:30 ET spike (EST 2026-02-10)
    pm_c = [
        make_bar(2026, 2, 10, 7, 15, 502.70, 502.95, 502.70, 502.90, 1000.0),
        make_bar(2026, 2, 10, 7, 45, 502.90, 503.10, 502.85, 503.00, 1100.0),
        make_bar(2026, 2, 10, 8, 15, 503.00, 503.20, 502.90, 503.05, 1200.0),
        # 08:30 macro release spike (range=3.10 >= 3*0.25, vol=18000 >= 5*1100)
        make_bar(2026, 2, 10, 8, 30, 503.05, 505.50, 502.40, 504.10, 18_000.0),
        make_bar(2026, 2, 10, 9, 0, 504.10, 504.40, 503.00, 503.10, 6000.0),
        make_bar(2026, 2, 10, 9, 25, 503.10, 503.40, 502.90, 503.25, 5000.0),
    ]
    rth_c = [
        make_bar(2026, 2, 10, 9, 30, 504.20, 504.90, 504.10, 504.70, 150_000.0, 504.55),
        # Pushes to test pmh=505.50, absorbs & closes weak at lower half -> CLV delta < 0
        make_bar(2026, 2, 10, 9, 35, 504.70, 505.40, 503.70, 503.90, 220_000.0, 504.40),
        make_bar(2026, 2, 10, 9, 45, 503.90, 504.00, 502.30, 502.45, 240_000.0, 503.05),
        make_bar(2026, 2, 10, 10, 25, 502.45, 502.60, 501.30, 501.40, 200_000.0, 501.85),
    ]
    opts_c = {
        "asOfUtcSec": utc_from_et(2026, 2, 10, 10, 30),
        "barSeconds": 300,
        "prevRthClose": 500.00,
        "prevRthHigh": 501.00,
        "prevRthLow": 497.00,
        "atr14d": 4.00,
        "expectedWindowVolume": 500_000.0,
        "tickSize": 0.05,
    }
    scenarios.append(
        {
            "id": "scenario_c_rejection_reverse_long_liquidation_macro",
            "bars": pm_c + rth_c,
            "options": opts_c,
            "expected": py_evaluate_opening_auction(pm_c + rth_c, opts_c),
        }
    )

    # (d) Balanced OPEN_AUCTION + WIDE_IB_CONSOLIDATION_BIAS (> 0.80 ATR)
    pm_d = [
        make_bar(2026, 4, 14, 7, 30, 449.50, 451.80, 448.20, 450.10, 2500.0),
        make_bar(2026, 4, 14, 8, 30, 450.10, 451.20, 448.80, 449.90, 2600.0),
        make_bar(2026, 4, 14, 9, 15, 449.90, 450.80, 449.20, 450.00, 2400.0),
    ]
    rth_d = [
        make_bar(2026, 4, 14, 9, 30, 450.00, 451.40, 449.80, 451.10, 110_000.0, 450.70),
        make_bar(2026, 4, 14, 9, 35, 451.10, 451.15, 448.50, 448.70, 115_000.0, 449.60),
        make_bar(2026, 4, 14, 9, 45, 448.70, 451.00, 448.60, 450.80, 105_000.0, 450.25),
        make_bar(2026, 4, 14, 10, 0, 450.80, 450.85, 449.10, 449.20, 95_000.0, 449.70),
        make_bar(2026, 4, 14, 10, 25, 449.20, 450.55, 449.15, 450.45, 95_000.0, 449.95),
    ]
    opts_d = {
        "asOfUtcSec": utc_from_et(2026, 4, 14, 10, 30),
        "barSeconds": 300,
        "prevRthClose": 450.00,
        "prevRthHigh": 452.50,
        "prevRthLow": 447.50,
        "atr14d": 3.00,
        "expectedWindowVolume": 420_000.0,
        "tickSize": 0.05,
    }
    scenarios.append(
        {
            "id": "scenario_d_open_auction_in_balance_wide_ib",
            "bars": pm_d + rth_d,
            "options": opts_d,
            "expected": py_evaluate_opening_auction(pm_d + rth_d, opts_d),
        }
    )

    # (d2) SHORT_COVERING_RISK symmetric check (>= 85% PM below prevRthClose + floor rejection)
    pm_sc = [
        make_bar(2026, 5, 12, 7, 30, 396.20, 397.10, 395.00, 396.40, 4000.0),
        make_bar(2026, 5, 12, 8, 45, 396.40, 397.40, 395.50, 396.80, 4500.0),
    ]
    rth_sc = [
        make_bar(2026, 5, 12, 9, 30, 396.10, 396.30, 395.05, 396.15, 140_000.0, 395.80),
        make_bar(2026, 5, 12, 9, 35, 396.15, 398.10, 396.10, 397.95, 180_000.0, 397.30),
        make_bar(2026, 5, 12, 10, 25, 397.95, 398.80, 397.80, 398.60, 150_000.0, 398.30),
    ]
    opts_sc = {
        "asOfUtcSec": utc_from_et(2026, 5, 12, 10, 30),
        "barSeconds": 300,
        "prevRthClose": 400.00,
        "prevRthHigh": 401.50,
        "prevRthLow": 398.50,
        "atr14d": 4.00,
        "expectedWindowVolume": 350_000.0,
        "tickSize": 0.05,
    }
    scenarios.append(
        {
            "id": "scenario_d2_short_covering_reverse",
            "bars": pm_sc + rth_sc,
            "options": opts_sc,
            "expected": py_evaluate_opening_auction(pm_sc + rth_sc, opts_sc),
        }
    )

    # (e) Intraday 09:45 ET look-ahead audit (input includes 09:45, 10:15, 14:00 poisoned future bars!)
    poisoned_future = [
        make_bar(2026, 1, 15, 9, 45, 593.20, 650.00, 500.00, 640.00, 9_999_999.0),
        make_bar(2026, 1, 15, 10, 15, 640.00, 700.00, 480.00, 490.00, 9_999_999.0),
    ]
    bars_e = pm_a + rth_a[:3] + poisoned_future  # 09:30, 09:35, 09:40 close <= 09:45 ET!
    opts_e = {
        "asOfUtcSec": utc_from_et(2026, 1, 15, 9, 45),
        "barSeconds": 300,
        "prevRthClose": 590.00,
        "prevRthHigh": 591.20,
        "prevRthLow": 587.00,
        "atr14d": 5.00,
        "expectedWindowVolume": 200_000.0,
        "tickSize": 0.05,
    }
    scenarios.append(
        {
            "id": "scenario_e_no_lookahead_0945_pending_ib",
            "bars": bars_e,
            "options": opts_e,
            "expected": py_evaluate_opening_auction(bars_e, opts_e),
        }
    )

    # (f) Degenerate cases: NaN atr14d, empty pre-market, expectedWindowVolume = 0
    opts_f_nan_atr = {
        "asOfUtcSec": utc_from_et(2026, 1, 15, 10, 30),
        "barSeconds": 300,
        "prevRthClose": 590.00,
        "prevRthHigh": 591.20,
        "prevRthLow": 587.00,
        "atr14d": "NaN",
        "expectedWindowVolume": 500_000.0,
        "tickSize": 0.05,
    }
    opts_f_empty_pm_zero_rvol = {
        "asOfUtcSec": utc_from_et(2026, 1, 15, 10, 30),
        "barSeconds": 300,
        "prevRthClose": 590.00,
        "prevRthHigh": 591.20,
        "prevRthLow": 587.00,
        "atr14d": 5.00,
        "expectedWindowVolume": 0.0,
        "tickSize": 0.05,
    }
    scenarios.append(
        {
            "id": "scenario_f1_nan_atr14d",
            "bars": pm_a + rth_a,
            "options": opts_f_nan_atr,
            "expected": py_evaluate_opening_auction(pm_a + rth_a, opts_f_nan_atr),
        }
    )
    scenarios.append(
        {
            "id": "scenario_f2_empty_premarket_zero_expected_volume",
            "bars": rth_a,
            "options": opts_f_empty_pm_zero_rvol,
            "expected": py_evaluate_opening_auction(rth_a, opts_f_empty_pm_zero_rvol),
        }
    )

    # Standalone Overnight Volume Profile symmetric tie-break & zero-range close bin check
    standalone_profile_bars = [
        make_bar(2026, 1, 15, 8, 0, 100.00, 100.20, 100.00, 100.10, 500.0, 100.10),
        make_bar(2026, 1, 15, 8, 5, 100.10, 100.10, 100.10, 100.10, 200.0, 100.10),
        make_bar(2026, 1, 15, 8, 10, 100.05, 100.15, 100.05, 100.10, 300.0, 100.10),
    ]
    standalone_profile = py_overnight_profile(standalone_profile_bars, tick_size=0.05, value_area_pct=0.70)

    out = {
        "meta": {
            "generator": "tools/gen_opening_auction_fixture.py",
            "command": "python tools/gen_opening_auction_fixture.py",
            "precisionTolerance": TOLERANCE,
        },
        "standaloneProfile": {
            "bars": standalone_profile_bars,
            "tickSize": 0.05,
            "valueAreaPct": 0.70,
            "expected": standalone_profile,
        },
        "scenarios": scenarios,
    }

    dest = Path("fixtures/opening_auction_reference.json")
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"Wrote {dest} with {len(scenarios)} opening auction scenarios + standalone volume profile.")


if __name__ == "__main__":
    main()
