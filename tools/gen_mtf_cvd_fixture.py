"""Independent Python reference generator for Pieza 10 (`mtfStructure.ts` & `cvdAbsorption.ts`).

Usage:
    python tools/gen_mtf_cvd_fixture.py

Writes:
    fixtures/mtf_cvd_reference.json

Implemented independently in pure stdlib Python (`math`, `datetime`, `zoneinfo`, `json`)
with no shared code or logic copy from TypeScript. Non-finite scalars (`NaN`) are
serialized as `"NaN"` following the project fixture convention.
"""

from __future__ import annotations

import json
import math
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

ET_TZ = ZoneInfo("America/New_York")
UTC_TZ = ZoneInfo("UTC")

PRE_MARKET_START_MIN = 4 * 60
RTH_START_MIN = 9 * 60 + 30
RTH_END_MIN = 16 * 60
AFTER_HOURS_END_MIN = 20 * 60


def enc(val: float) -> float | str:
    if not math.isfinite(val):
        return "NaN"
    return val


def to_utc_sec(year: int, month: int, day: int, hour: int, minute: int, tz: ZoneInfo = ET_TZ) -> int:
    dt = datetime(year, month, day, hour, minute, 0, tzinfo=tz)
    return int(dt.astimezone(UTC_TZ).timestamp())


def et_parts(utc_sec: int) -> tuple[str, int]:
    dt = datetime.fromtimestamp(utc_sec, tz=ET_TZ)
    date_key = dt.strftime("%Y-%m-%d")
    minutes_of_day = dt.hour * 60 + dt.minute
    return date_key, minutes_of_day


# ---------------------------------------------------------------------------
# Independent numeric primitives
# ---------------------------------------------------------------------------

def py_sma(values: list[float], period: int) -> list[float]:
    n = len(values)
    out = [math.nan] * n
    for i in range(period - 1, n):
        win = values[i - period + 1 : i + 1]
        if all(math.isfinite(x) for x in win):
            out[i] = sum(win) / float(period)
    return out


def py_wma(values: list[float], period: int) -> list[float]:
    n = len(values)
    out = [math.nan] * n
    denom = period * (period + 1) / 2.0
    for i in range(period - 1, n):
        win = values[i - period + 1 : i + 1]
        if all(math.isfinite(x) for x in win):
            out[i] = sum((idx + 1) * x for idx, x in enumerate(win)) / denom
    return out


def py_ema(values: list[float], period: int) -> list[float]:
    n = len(values)
    out = [math.nan] * n
    if n < period:
        return out
    seed = values[:period]
    if not all(math.isfinite(x) for x in seed):
        return out
    alpha = 2.0 / (period + 1.0)
    prev = sum(seed) / float(period)
    out[period - 1] = prev
    for i in range(period, n):
        val = values[i]
        if not math.isfinite(val):
            break
        prev = alpha * val + (1.0 - alpha) * prev
        out[i] = prev
    return out


def py_hma(closes: list[float], period: int) -> list[float]:
    half_p = period // 2
    sqrt_p = math.isqrt(period)
    w_half = py_wma(closes, half_p)
    w_full = py_wma(closes, period)
    diff = [
        (2.0 * f - s) if (math.isfinite(f) and math.isfinite(s)) else math.nan
        for f, s in zip(w_half, w_full)
    ]
    return py_wma(diff, sqrt_p)


def py_wilder_atr(bars: list[dict[str, float]], period: int) -> list[float]:
    n = len(bars)
    out = [math.nan] * n
    if n < period + 1:
        return out
    if not all(math.isfinite(bars[0][k]) for k in ("high", "low", "close")):
        return out
    trs = [math.nan] * n
    for i in range(1, n):
        c_bar = bars[i]
        p_bar = bars[i - 1]
        if not (
            math.isfinite(c_bar["high"])
            and math.isfinite(c_bar["low"])
            and math.isfinite(c_bar["close"])
            and math.isfinite(p_bar["close"])
        ):
            break
        trs[i] = max(
            c_bar["high"] - c_bar["low"],
            abs(c_bar["high"] - p_bar["close"]),
            abs(c_bar["low"] - p_bar["close"]),
        )
    first_trs = trs[1 : period + 1]
    if len(first_trs) < period or not all(math.isfinite(x) for x in first_trs):
        return out
    atr = sum(first_trs) / float(period)
    out[period] = atr
    for i in range(period + 1, n):
        if not math.isfinite(trs[i]):
            break
        atr = ((period - 1) * atr + trs[i]) / float(period)
        out[i] = atr
    return out


def py_mid_rank_percentile(window: list[float], target: float) -> float:
    if not window or not math.isfinite(target):
        return math.nan
    if any(not math.isfinite(x) for x in window):
        return math.nan
    less = sum(1 for x in window if x < target)
    equal = sum(1 for x in window if x == target)
    return 100.0 * (less + 0.5 * equal) / float(len(window))


def py_last_or_nan(seq: list[float], offset_from_end: int = 0) -> float:
    idx = len(seq) - 1 - offset_from_end
    if idx < 0 or idx >= len(seq):
        return math.nan
    return seq[idx] if math.isfinite(seq[idx]) else math.nan


# ---------------------------------------------------------------------------
# Reference evaluators
# ---------------------------------------------------------------------------

def eval_mtf_reference(inputs: dict[str, list[dict[str, float]]], options: dict[str, Any]) -> dict[str, Any]:
    as_of = int(options["asOfUtcSec"])
    bs_1d = int(options.get("barSeconds1d", 86400))
    bs_4h = int(options.get("barSeconds4h", 14400))
    bs_15m = int(options.get("barSeconds15m", 900))
    bs_5m = int(options.get("barSeconds5m", 300))

    p_1d = int(options.get("sma1dPeriod", 200))
    p_4h = int(options.get("sma4hPeriod", 50))
    p_15m = int(options.get("ema15mPeriod", 21))
    p_5m = int(options.get("hma5mPeriod", 55))
    p_atr = int(options.get("atrPeriod", 14))

    pullback_atr_thr = float(options.get("pullbackAtrThreshold", 0.5))
    min_wick_ratio = float(options.get("minWickToBodyRatio", 1.5))
    min_vol_pct = float(options.get("minVolumePercentile15m", 75.0))
    lookback_15m = int(options.get("lookbackBars15m", 20))
    min_body_eps = float(options.get("minBodyEpsilon", 0.01))

    c1d = [b for b in inputs["bars1d"] if b["time"] + bs_1d <= as_of]
    c4h = [b for b in inputs["bars4h"] if b["time"] + bs_4h <= as_of]
    c15m = [b for b in inputs["bars15m"] if b["time"] + bs_15m <= as_of]
    c5m = [b for b in inputs["bars5m"] if b["time"] + bs_5m <= as_of]

    ex1d = len(inputs["bars1d"]) - len(c1d)
    ex4h = len(inputs["bars4h"]) - len(c4h)
    ex15m = len(inputs["bars15m"]) - len(c15m)
    ex5m = len(inputs["bars5m"]) - len(c5m)

    close_1d = c1d[-1]["close"] if c1d and math.isfinite(c1d[-1]["close"]) else math.nan
    sma200_1d = py_last_or_nan(py_sma([b["close"] for b in c1d], p_1d))

    if "atr14_1d" in options:
        raw_atr1d = float("nan") if options["atr14_1d"] == "NaN" else float(options["atr14_1d"])
        atr14_1d = raw_atr1d if (math.isfinite(raw_atr1d) and raw_atr1d > 0.0) else math.nan
    else:
        atr14_1d = py_last_or_nan(py_wilder_atr(c1d, p_atr))

    dist_pct = (
        (close_1d - sma200_1d) / sma200_1d
        if math.isfinite(close_1d) and math.isfinite(sma200_1d) and sma200_1d != 0.0
        else math.nan
    )
    dist_atr = (
        (close_1d - sma200_1d) / atr14_1d
        if math.isfinite(close_1d) and math.isfinite(sma200_1d) and math.isfinite(atr14_1d) and atr14_1d > 0.0
        else math.nan
    )

    if not math.isfinite(close_1d) or not math.isfinite(sma200_1d):
        regime_1d = "INSUFFICIENT_DATA"
    elif close_1d > sma200_1d:
        regime_1d = "BULLISH_REGIME"
    elif close_1d < sma200_1d:
        regime_1d = "BEARISH_REGIME"
    else:
        regime_1d = "CONFLICTED_NO_SETUP"

    close_4h = c4h[-1]["close"] if c4h and math.isfinite(c4h[-1]["close"]) else math.nan
    sma50_4h = py_last_or_nan(py_sma([b["close"] for b in c4h], p_4h))

    aligned_4h = False
    if regime_1d == "INSUFFICIENT_DATA" or not math.isfinite(close_4h) or not math.isfinite(sma50_4h):
        eff_regime = "INSUFFICIENT_DATA"
    elif regime_1d == "CONFLICTED_NO_SETUP":
        eff_regime = "CONFLICTED_NO_SETUP"
    elif regime_1d == "BULLISH_REGIME" and close_4h > sma50_4h:
        aligned_4h = True
        eff_regime = "BULLISH_REGIME"
    elif regime_1d == "BEARISH_REGIME" and close_4h < sma50_4h:
        aligned_4h = True
        eff_regime = "BEARISH_REGIME"
    else:
        aligned_4h = False
        eff_regime = "CONFLICTED_NO_SETUP"

    close_15m = c15m[-1]["close"] if c15m and math.isfinite(c15m[-1]["close"]) else math.nan
    ema21_15m = py_last_or_nan(py_ema([b["close"] for b in c15m], p_15m))

    if "atr14_15m" in options:
        raw_atr15m = float("nan") if options["atr14_15m"] == "NaN" else float(options["atr14_15m"])
        atr14_15m = raw_atr15m if (math.isfinite(raw_atr15m) and raw_atr15m > 0.0) else math.nan
    else:
        atr14_15m = py_last_or_nan(py_wilder_atr(c15m, p_atr))

    pb_dist = abs(close_15m - ema21_15m) if math.isfinite(close_15m) and math.isfinite(ema21_15m) else math.nan
    pb_in_zone = (
        math.isfinite(pb_dist)
        and math.isfinite(atr14_15m)
        and atr14_15m > 0.0
        and pb_dist <= pullback_atr_thr * atr14_15m
    )

    wick_ratio = math.nan
    if c15m and eff_regime in ("BULLISH_REGIME", "BEARISH_REGIME"):
        b15 = c15m[-1]
        if all(math.isfinite(b15[k]) for k in ("open", "high", "low", "close")):
            denom = max(abs(b15["close"] - b15["open"]), min_body_eps)
            if eff_regime == "BULLISH_REGIME":
                wick_ratio = (min(b15["open"], b15["close"]) - b15["low"]) / denom
            else:
                wick_ratio = (b15["high"] - max(b15["open"], b15["close"])) / denom

    vol_pct_15m = math.nan
    if c15m and len(c15m) >= lookback_15m:
        win_vols = [b["volume"] for b in c15m[-lookback_15m:]]
        vol_pct_15m = py_mid_rank_percentile(win_vols, c15m[-1]["volume"])

    absorption_15m = (
        math.isfinite(wick_ratio)
        and wick_ratio >= min_wick_ratio
        and math.isfinite(vol_pct_15m)
        and vol_pct_15m >= min_vol_pct
    )

    close_5m = c5m[-1]["close"] if c5m and math.isfinite(c5m[-1]["close"]) else math.nan
    hma_series = py_hma([b["close"] for b in c5m], p_5m)
    hma55 = py_last_or_nan(hma_series, 0)
    hma55_prev = py_last_or_nan(hma_series, 1)
    hma55_prev2 = py_last_or_nan(hma_series, 2)
    hma_slope = hma55 - hma55_prev if math.isfinite(hma55) and math.isfinite(hma55_prev) else math.nan
    hma_slope_prev = hma55_prev - hma55_prev2 if math.isfinite(hma55_prev) and math.isfinite(hma55_prev2) else math.nan

    slope_favorable = (
        math.isfinite(hma_slope)
        and math.isfinite(hma_slope_prev)
        and (
            (eff_regime == "BULLISH_REGIME" and hma_slope > 0.0 and hma_slope > hma_slope_prev)
            or (eff_regime == "BEARISH_REGIME" and hma_slope < 0.0 and hma_slope < hma_slope_prev)
        )
    )
    trigger_active = aligned_4h and pb_in_zone and slope_favorable

    l1_warm = eff_regime != "INSUFFICIENT_DATA"
    l2_warm = math.isfinite(ema21_15m) and math.isfinite(atr14_15m) and len(c15m) >= lookback_15m
    l3_warm = math.isfinite(hma_slope) and math.isfinite(hma_slope_prev)

    if not l1_warm or not l2_warm or not l3_warm:
        setup_status = "CONFLICTED_NO_SETUP" if eff_regime == "CONFLICTED_NO_SETUP" else "INSUFFICIENT_DATA"
    elif not aligned_4h or eff_regime == "CONFLICTED_NO_SETUP":
        setup_status = "CONFLICTED_NO_SETUP"
    elif trigger_active:
        setup_status = "ACTIVE_BULLISH" if eff_regime == "BULLISH_REGIME" else "ACTIVE_BEARISH"
    else:
        setup_status = "STANDBY"

    return {
        "asOfUtcSec": as_of,
        "closed1dCount": len(c1d),
        "closed4hCount": len(c4h),
        "closed15mCount": len(c15m),
        "closed5mCount": len(c5m),
        "excludedFuture1dCount": ex1d,
        "excludedFuture4hCount": ex4h,
        "excludedFuture15mCount": ex15m,
        "excludedFuture5mCount": ex5m,
        "close1d": enc(close_1d),
        "sma200_1d": enc(sma200_1d),
        "atr14_1d": enc(atr14_1d),
        "distSma200Pct": enc(dist_pct),
        "distSma200Atr": enc(dist_atr),
        "regime1d": regime_1d,
        "close4h": enc(close_4h),
        "sma50_4h": enc(sma50_4h),
        "aligned4h": aligned_4h,
        "effectiveMacroRegime": eff_regime,
        "close15m": enc(close_15m),
        "ema21_15m": enc(ema21_15m),
        "atr14_15m": enc(atr14_15m),
        "pullback15mDistance": enc(pb_dist),
        "pullback15mInZone": pb_in_zone,
        "wickToBodyRatio15m": enc(wick_ratio),
        "volume15mPercentile": enc(vol_pct_15m),
        "absorption15m": absorption_15m,
        "close5m": enc(close_5m),
        "hma55": enc(hma55),
        "hma55Prev": enc(hma55_prev),
        "hma55Prev2": enc(hma55_prev2),
        "hma55Slope": enc(hma_slope),
        "hma55SlopePrev": enc(hma_slope_prev),
        "executionTriggerActive": trigger_active,
        "setupStatus": setup_status,
    }


def eval_cvd_reference(bars: list[dict[str, Any]], options: dict[str, Any]) -> dict[str, Any]:
    as_of = int(options["asOfUtcSec"])
    bs = int(options["barSeconds"])
    scope = options.get("sessionScope", "FULL_ET")
    win_bars = int(options.get("windowBars", 20))
    min_win_bars = int(options.get("minWindowBars", min(20, win_bars)))
    min_vol_p = float(options.get("minVolumePercentile", 90.0))
    min_del_p = float(options.get("minDeltaPercentile", 90.0))
    max_body_p = float(options.get("maxBodyDisplacementPercentile", 25.0))
    reset_win = bool(options.get("resetPercentileWindowOnSession", False))

    if "atr" in options:
        mult = float(options.get("levelProximityAtr", 0.15))
        raw_atr = float("nan") if options["atr"] == "NaN" else float(options["atr"])
        if math.isfinite(raw_atr) and raw_atr > 0.0:
            tol_mode = "ATR"
            tol_valid = True
            atr_tol = mult * raw_atr
            pct_tol = math.nan
        else:
            tol_mode = "ATR"
            tol_valid = False
            atr_tol = math.nan
            pct_tol = math.nan
    else:
        tol_mode = "PCT"
        tol_valid = True
        atr_tol = math.nan
        pct_tol = float(options["levelProximityPct"])

    valid_levels = [
        {"name": lvl["name"], "price": float(lvl["price"])}
        for lvl in options["levels"]
        if lvl["name"].strip() and lvl["price"] != "NaN" and math.isfinite(float(lvl["price"]))
    ]
    skipped_levels = len(options["levels"]) - len(valid_levels)

    closed = [b for b in bars if b["time"] + bs <= as_of]
    excluded_future = len(bars) - len(closed)

    scoped: list[tuple[dict[str, Any], str]] = []
    excluded_out = 0
    for b in closed:
        dkey, mins = et_parts(int(b["time"]))
        in_sess = (
            (PRE_MARKET_START_MIN <= mins < AFTER_HOURS_END_MIN)
            if scope == "FULL_ET"
            else (RTH_START_MIN <= mins < RTH_END_MIN)
        )
        if not in_sess:
            excluded_out += 1
        else:
            scoped.append((b, dkey))

    if not scoped:
        return {
            "asOfUtcSec": as_of,
            "barSeconds": bs,
            "sessionScope": scope,
            "closedInSessionCount": 0,
            "excludedFutureCount": excluded_future,
            "excludedOutOfSessionCount": excluded_out,
            "skippedInvalidLevelCount": skipped_levels,
            "toleranceValid": tol_valid,
            "atrProximityTolerance": enc(atr_tol),
            "deltaMode": "INSUFFICIENT_DATA",
            "sessionDeltaModes": [],
            "currentSessionDate": None,
            "currentSessionCvd": "NaN",
            "bars": [],
            "absorptionEvents": [],
        }

    missing_tick_by_sess: dict[str, bool] = {}
    for b, dkey in scoped:
        has_both = ("buyVolume" in b) and ("sellVolume" in b)
        missing_tick_by_sess[dkey] = missing_tick_by_sess.get(dkey, False) or (not has_both)

    evals: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    sess_infos: list[dict[str, Any]] = []

    vols: list[float] = []
    abs_deltas: list[float] = []
    bodies: list[float] = []

    active_date: str | None = None
    sess_count = 0
    sess_cvd = 0.0
    sess_poisoned = False
    active_mode = "OHLCV_INTRABAR_APPROX"
    win_start = 0

    for i, (b, dkey) in enumerate(scoped):
        if active_date != dkey:
            if active_date is not None:
                sess_infos.append({
                    "sessionDate": active_date,
                    "deltaMode": active_mode,
                    "barCount": sess_count,
                    "finalSessionCvd": enc(math.nan if sess_poisoned else sess_cvd),
                })
            active_date = dkey
            sess_count = 0
            sess_cvd = 0.0
            sess_poisoned = False
            active_mode = "OHLCV_INTRABAR_APPROX" if missing_tick_by_sess[dkey] else "TICK_EXACT"
            if reset_win:
                win_start = i

        sess_count += 1
        if active_mode == "TICK_EXACT":
            bv = math.nan if b.get("buyVolume") == "NaN" else float(b["buyVolume"])
            sv = math.nan if b.get("sellVolume") == "NaN" else float(b["sellVolume"])
            bar_delta = (bv - sv) if (math.isfinite(bv) and math.isfinite(sv)) else math.nan
        else:
            o, h, l, c, v = float(b["open"]), float(b["high"]), float(b["low"]), float(b["close"]), float(b["volume"])
            if h == l or v == 0.0:
                bar_delta = 0.0
            else:
                bar_delta = v * (((c - l) - (h - c)) / (h - l))

        if not math.isfinite(bar_delta):
            sess_poisoned = True
        elif not sess_poisoned:
            sess_cvd += bar_delta
        cur_cvd = math.nan if sess_poisoned else sess_cvd

        abs_d = abs(bar_delta) if math.isfinite(bar_delta) else math.nan
        body = abs(float(b["close"]) - float(b["open"]))
        vols.append(float(b["volume"]))
        abs_deltas.append(abs_d)
        bodies.append(body)

        start = max(win_start, i - win_bars + 1)
        wlen = i - start + 1
        if wlen >= min_win_bars:
            v_pct = py_mid_rank_percentile(vols[start : i + 1], float(b["volume"]))
            d_pct = py_mid_rank_percentile(abs_deltas[start : i + 1], abs_d)
            b_pct = py_mid_rank_percentile(bodies[start : i + 1], body)
        else:
            v_pct = d_pct = b_pct = math.nan

        matches = []
        if tol_valid:
            for lvl in valid_levels:
                tol = atr_tol if tol_mode == "ATR" else pct_tol * abs(lvl["price"])
                if float(b["low"]) <= lvl["price"] + tol and float(b["high"]) >= lvl["price"] - tol:
                    matches.append({
                        "name": lvl["name"],
                        "price": lvl["price"],
                        "tolerance": tol,
                        "distance": abs(float(b["close"]) - lvl["price"]),
                    })
            matches.sort(key=lambda m: (m["distance"], m["name"]))

        pct_ok = (
            math.isfinite(v_pct) and v_pct >= min_vol_p
            and math.isfinite(d_pct) and d_pct >= min_del_p
            and math.isfinite(b_pct) and b_pct <= max_body_p
        )
        side = "NONE"
        trig = False
        if pct_ok and matches and math.isfinite(bar_delta) and bar_delta != 0.0:
            side = "BUY_ABSORPTION" if bar_delta < 0.0 else "SELL_ABSORPTION"
            trig = True
            events.append({
                "time": b["time"],
                "sessionDate": dkey,
                "deltaMode": active_mode,
                "close": float(b["close"]),
                "high": float(b["high"]),
                "low": float(b["low"]),
                "volume": float(b["volume"]),
                "barDelta": bar_delta,
                "sessionCvd": enc(cur_cvd),
                "absorbingSide": side,
                "volumePercentile": v_pct,
                "deltaPercentile": d_pct,
                "bodyDisplacementPercentile": b_pct,
                "primaryLevel": matches[0],
                "matchedLevels": matches,
            })

        evals.append({
            "time": b["time"],
            "sessionDate": dkey,
            "deltaMode": active_mode,
            "open": float(b["open"]),
            "high": float(b["high"]),
            "low": float(b["low"]),
            "close": float(b["close"]),
            "volume": float(b["volume"]),
            "barDelta": enc(bar_delta),
            "sessionCvd": enc(cur_cvd),
            "volumePercentile": enc(v_pct),
            "deltaPercentile": enc(d_pct),
            "bodyDisplacementPercentile": enc(b_pct),
            "absorptionTriggered": trig,
            "absorbingSide": side,
            "matchedLevels": matches,
        })

    if active_date is not None:
        sess_infos.append({
            "sessionDate": active_date,
            "deltaMode": active_mode,
            "barCount": sess_count,
            "finalSessionCvd": enc(math.nan if sess_poisoned else sess_cvd),
        })

    return {
        "asOfUtcSec": as_of,
        "barSeconds": bs,
        "sessionScope": scope,
        "closedInSessionCount": len(evals),
        "excludedFutureCount": excluded_future,
        "excludedOutOfSessionCount": excluded_out,
        "skippedInvalidLevelCount": skipped_levels,
        "toleranceValid": tol_valid,
        "atrProximityTolerance": enc(atr_tol),
        "deltaMode": evals[-1]["deltaMode"],
        "sessionDeltaModes": sess_infos,
        "currentSessionDate": active_date,
        "currentSessionCvd": evals[-1]["sessionCvd"],
        "bars": evals,
        "absorptionEvents": events,
    }


# ---------------------------------------------------------------------------
# Deterministic scenario builders
# ---------------------------------------------------------------------------

def make_trend_bars(start_t: int, step_sec: int, count: int, start_px: float, drift: float, vol_base: float) -> list[dict[str, float]]:
    bars = []
    for i in range(count):
        mid = start_px + drift * i + 0.15 * math.sin(i * 0.4)
        o = mid - drift * 0.4
        c = mid + drift * 0.4
        h = max(o, c) + 0.65
        l = min(o, c) - 0.55
        bars.append({
            "time": start_t + i * step_sec,
            "open": round(o, 6),
            "high": round(h, 6),
            "low": round(l, 6),
            "close": round(c, 6),
            "volume": round(vol_base + (i % 7) * 50.0, 4),
        })
    return bars


def build_mtf_scenarios() -> list[dict[str, Any]]:
    scenarios: list[dict[str, Any]] = []

    # 1. Bullish ACTIVE setup in EST (2026-01-15 10:35 ET), internal Wilder ATR, poisoned future bars excluded
    as_of_bull = to_utc_sec(2026, 1, 15, 10, 35)
    bars_1d_bull = make_trend_bars(as_of_bull - 211 * 86400, 86400, 211, 480.0, 0.5, 5_000_000.0)
    # Append future unclosed 1D bar right at as_of_bull - 3600 (close > as_of)
    bars_1d_bull.append({
        "time": as_of_bull - 3600,
        "open": 900.0, "high": 950.0, "low": 880.0, "close": 940.0, "volume": 9_000_000.0,
    })
    bars_4h_bull = make_trend_bars(as_of_bull - 61 * 14400, 14400, 60, 560.0, 0.35, 900_000.0)
    bars_4h_bull.append({
        "time": as_of_bull - 3600,
        "open": 300.0, "high": 310.0, "low": 290.0, "close": 295.0, "volume": 2_000_000.0,
    })

    # 15m: 34 steady bars around 585..592 ending with EMA21 pullback + deep lower wick absorption bar at P97.5 vol
    bars_15m_bull = make_trend_bars(as_of_bull - 35 * 900, 900, 34, 588.0, 0.12, 120_000.0)
    ema_prev = py_ema([b["close"] for b in bars_15m_bull], 21)[-1]
    # Closed at 10:30 ET (starts 10:15 ET) -> close near ema21_15m with big lower wick
    target_c15 = round(ema_prev + 0.08, 4)
    bars_15m_bull.append({
        "time": as_of_bull - 1200,  # 10:15 ET, closes 10:30 ET <= 10:35 ET
        "open": target_c15 - 0.10,
        "high": target_c15 + 0.12,
        "low": target_c15 - 1.45,
        "close": target_c15,
        "volume": 480_000.0,
    })
    bars_15m_bull.append({
        "time": as_of_bull - 600,  # unclosed at 10:25 -> closes 10:40 > 10:35
        "open": 500.0, "high": 505.0, "low": 495.0, "close": 496.0, "volume": 9_999_999.0,
    })

    # 5m: 68 closed bars curving down softly then flipping strongly up in last 2 bars so HMA55 turns upward
    t5_start = as_of_bull - 70 * 300
    bars_5m_bull: list[dict[str, float]] = []
    for i in range(70):
        t = t5_start + i * 300
        if i < 50:
            px = 592.0 - 0.05 * i
        elif i < 66:
            px = 589.5 - 0.08 * (i - 50)
        elif i == 66:
            px = 589.4
        elif i == 67:
            px = 590.6
        elif i == 68:
            px = 592.5  # bar closing at as_of_bull - 300? Wait: t + 300 <= as_of
        else:
            px = 400.0  # bar i=69 starts at as_of_bull - 300... wait: i=69 starts as_of_bull - 300 -> closes AT as_of_bull! Let's add 1 more future bar
        bars_5m_bull.append({
            "time": t,
            "open": round(px - 0.05, 4),
            "high": round(px + 0.25, 4),
            "low": round(px - 0.25, 4),
            "close": round(px, 4),
            "volume": 40_000.0 + i * 200.0,
        })
    # Replace last closed (i=69, closes exactly at as_of_bull) with bullish acceleration and i=70 future crash
    bars_5m_bull[-1]["close"] = 595.2
    bars_5m_bull[-1]["open"] = 593.0
    bars_5m_bull[-1]["high"] = 595.5
    bars_5m_bull[-1]["low"] = 592.8
    bars_5m_bull[-2]["close"] = 592.8
    bars_5m_bull[-2]["open"] = 591.2
    bars_5m_bull.append({
        "time": as_of_bull,  # closes at as_of_bull + 300 > as_of_bull
        "open": 595.0, "high": 595.2, "low": 410.0, "close": 420.0, "volume": 8_000_000.0,
    })

    inp1 = {
        "bars1d": bars_1d_bull,
        "bars4h": bars_4h_bull,
        "bars15m": bars_15m_bull,
        "bars5m": bars_5m_bull,
    }
    opt1 = {"asOfUtcSec": as_of_bull}
    scenarios.append({"id": "mtf_bullish_active_trigger_est", "inputs": inp1, "options": opt1, "expected": eval_mtf_reference(inp1, opt1)})

    # 2. Bearish ACTIVE setup in EDT (2026-05-12 10:15 EDT)
    as_of_bear = to_utc_sec(2026, 5, 12, 10, 15)
    bars_1d_bear = make_trend_bars(as_of_bear - 205 * 86400, 86400, 205, 620.0, -0.4, 4_500_000.0)
    bars_4h_bear = make_trend_bars(as_of_bear - 56 * 14400, 14400, 56, 540.0, -0.3, 800_000.0)
    bars_15m_bear = make_trend_bars(as_of_bear - 30 * 900, 900, 29, 520.0, -0.1, 100_000.0)
    ema_b15 = py_ema([b["close"] for b in bars_15m_bear], 21)[-1]
    c15_b = round(ema_b15 - 0.05, 4)
    bars_15m_bear.append({
        "time": as_of_bear - 900,
        "open": c15_b + 0.08,
        "high": c15_b + 1.35,  # upper rejection wick
        "low": c15_b - 0.10,
        "close": c15_b,
        "volume": 390_000.0,
    })
    t5b_start = as_of_bear - 68 * 300
    bars_5m_bear: list[dict[str, float]] = []
    for i in range(68):
        if i < 55:
            px = 516.0 + 0.06 * i
        elif i < 65:
            px = 519.3 + 0.05 * (i - 55)
        elif i == 65:
            px = 519.0
        elif i == 66:
            px = 517.8
        else:
            px = 515.4
        bars_5m_bear.append({
            "time": t5b_start + i * 300,
            "open": round(px + 0.06, 4),
            "high": round(px + 0.25, 4),
            "low": round(px - 0.25, 4),
            "close": round(px, 4),
            "volume": 35_000.0 + i * 150.0,
        })
    inp2 = {"bars1d": bars_1d_bear, "bars4h": bars_4h_bear, "bars15m": bars_15m_bear, "bars5m": bars_5m_bear}
    opt2 = {"asOfUtcSec": as_of_bear}
    scenarios.append({"id": "mtf_bearish_active_trigger_edt", "inputs": inp2, "options": opt2, "expected": eval_mtf_reference(inp2, opt2)})

    # 3. Conflicted 4H (1D bullish, 4H below SMA50)
    bars_4h_conf = make_trend_bars(as_of_bull - 60 * 14400, 14400, 60, 610.0, -0.5, 850_000.0)
    inp3 = {"bars1d": bars_1d_bull, "bars4h": bars_4h_conf, "bars15m": bars_15m_bull, "bars5m": bars_5m_bull}
    scenarios.append({"id": "mtf_conflicted_4h_misaligned", "inputs": inp3, "options": opt1, "expected": eval_mtf_reference(inp3, opt1)})

    # 4. Standby (macro bullish aligned, 15m in zone, yet 5m HMA55 still declining -> false trigger)
    bars_5m_down = make_trend_bars(as_of_bull - 68 * 300, 300, 68, 595.0, -0.1, 40_000.0)
    inp4 = {"bars1d": bars_1d_bull, "bars4h": bars_4h_bull, "bars15m": bars_15m_bull, "bars5m": bars_5m_down}
    scenarios.append({"id": "mtf_standby_no_hma_turn", "inputs": inp4, "options": opt1, "expected": eval_mtf_reference(inp4, opt1)})

    # 5. Exact warmup shortages (199 daily bars, 49 4h, 20 15m, 60 5m -> all NaN)
    inp5 = {
        "bars1d": make_trend_bars(as_of_bull - 200 * 86400, 86400, 199, 500.0, 0.2, 1000.0),
        "bars4h": make_trend_bars(as_of_bull - 50 * 14400, 14400, 49, 500.0, 0.2, 500.0),
        "bars15m": make_trend_bars(as_of_bull - 21 * 900, 900, 20, 500.0, 0.1, 200.0),
        "bars5m": make_trend_bars(as_of_bull - 61 * 300, 300, 60, 500.0, 0.05, 100.0),
    }
    scenarios.append({"id": "mtf_warmup_shortage_exact", "inputs": inp5, "options": opt1, "expected": eval_mtf_reference(inp5, opt1)})

    # 6. Explicit NaN ATR override + 61 5m bars (hma55 finite, slopes NaN)
    inp6 = {
        "bars1d": bars_1d_bull,
        "bars4h": bars_4h_bull,
        "bars15m": bars_15m_bull,
        "bars5m": bars_5m_bull[:61],
    }
    opt6 = {"asOfUtcSec": as_of_bull, "atr14_1d": "NaN", "atr14_15m": -1.0}
    scenarios.append({"id": "mtf_explicit_nan_atr_61_5m", "inputs": inp6, "options": opt6, "expected": eval_mtf_reference(inp6, opt6)})

    return scenarios


def build_cvd_scenarios() -> list[dict[str, Any]]:
    scenarios: list[dict[str, Any]] = []

    # 1. TICK_EXACT spanning EST (2026-03-06) -> EDT (2026-03-09) with FULL_ET reset, out-of-session excluded,
    #    future excluded, PUT_WALL BUY_ABSORPTION and CALL_WALL/PMH SELL_ABSORPTION
    t_day1_0400 = to_utc_sec(2026, 3, 6, 4, 0)
    t_day2_0930 = to_utc_sec(2026, 3, 9, 9, 30)
    t_asof_1 = to_utc_sec(2026, 3, 9, 10, 45)

    bars1: list[dict[str, Any]] = []
    # Day 1: 18 bars starting 04:00 ET (baseline building normal volume/delta/body distribution)
    for i in range(18):
        bv = 1200.0 + (i % 5) * 200.0
        sv = 900.0 + (i % 4) * 150.0
        px = 582.0 + i * 0.25
        bars1.append({
            "time": t_day1_0400 + i * 300,
            "open": round(px - 0.18, 4),
            "high": round(px + 0.35, 4),
            "low": round(px - 0.35, 4),
            "close": round(px + 0.18, 4),  # body = 0.36
            "volume": bv + sv,
            "buyVolume": bv,
            "sellVolume": sv,
        })
    # Out-of-session bar at 20:30 ET on Day 1 (excludedOutOfSessionCount = 1)
    bars1.append({
        "time": to_utc_sec(2026, 3, 6, 20, 30),
        "open": 586.0, "high": 586.5, "low": 585.5, "close": 586.1,
        "volume": 5000.0, "buyVolume": 3000.0, "sellVolume": 2000.0,
    })

    # Day 2 (2026-03-09 EDT): starts 09:30 ET, reset sessionCvd!
    for i in range(15):
        t = t_day2_0930 + i * 300
        if i == 3:
            # BUY_ABSORPTION at PUT_WALL=580.0 (tol=0.30): huge vol, heavily negative delta, tiny body (0.04)
            bars1.append({
                "time": t,
                "open": 580.12, "high": 580.40, "low": 579.85, "close": 580.16,
                "volume": 25_000.0, "buyVolume": 3_500.0, "sellVolume": 21_500.0,
            })
        elif i == 10:
            # SELL_ABSORPTION at CALL_WALL=590.0 (closest) and PMH=590.20: huge vol, huge positive delta, tiny body (0.05)
            bars1.append({
                "time": t,
                "open": 589.98, "high": 590.28, "low": 589.70, "close": 590.03,
                "volume": 30_000.0, "buyVolume": 26_000.0, "sellVolume": 4_000.0,
            })
        else:
            bv = 1400.0 + (i % 4) * 180.0
            sv = 1100.0 + (i % 3) * 170.0
            px = 584.0 + i * 0.4
            bars1.append({
                "time": t,
                "open": round(px - 0.16, 4),
                "high": round(px + 0.30, 4),
                "low": round(px - 0.30, 4),
                "close": round(px + 0.16, 4),  # body = 0.32
                "volume": bv + sv,
                "buyVolume": bv,
                "sellVolume": sv,
            })
    # Future bars >= as_of - 299 -> 2 excluded future bars
    bars1.append({
        "time": t_asof_1, "open": 591.0, "high": 592.0, "low": 590.0, "close": 591.5,
        "volume": 90_000.0, "buyVolume": 80_000.0, "sellVolume": 10_000.0,
    })
    bars1.append({
        "time": t_asof_1 + 300, "open": 591.5, "high": 593.0, "low": 591.0, "close": 592.5,
        "volume": 95_000.0, "buyVolume": 85_000.0, "sellVolume": 10_000.0,
    })

    opt_cvd1 = {
        "asOfUtcSec": t_asof_1,
        "barSeconds": 300,
        "sessionScope": "FULL_ET",
        "atr": 2.0,
        "levelProximityAtr": 0.15,
        "levels": [
            {"name": "PUT_WALL", "price": 580.0},
            {"name": "CALL_WALL", "price": 590.0},
            {"name": "PMH", "price": 590.2},
            {"name": "UNAVAILABLE_WALL", "price": "NaN"},
        ],
    }
    scenarios.append({"id": "cvd_tick_exact_dst_reset_and_walls", "bars": bars1, "options": opt_cvd1, "expected": eval_cvd_reference(bars1, opt_cvd1)})

    # 2. OHLCV_INTRABAR_APPROX in RTH with mixed session uniform downgrade + zero-range bar
    d1_0900 = to_utc_sec(2026, 4, 13, 9, 0)  # Pre-market -> excluded in RTH
    d1_0930 = to_utc_sec(2026, 4, 13, 9, 30)
    d2_0930 = to_utc_sec(2026, 4, 14, 9, 30)
    t_asof_2 = d2_0930 + 12 * 300

    bars2: list[dict[str, Any]] = [
        {"time": d1_0900, "open": 500.0, "high": 501.0, "low": 499.0, "close": 500.5, "volume": 10_000.0},
    ]
    for i in range(16):
        c = 500.5 + (0.2 if i % 2 == 0 else -0.15)
        o = 500.2
        if i == 5:
            # Zero-range bar -> barDelta = 0
            bars2.append({"time": d1_0930 + i * 300, "open": 500.2, "high": 500.2, "low": 500.2, "close": 500.2, "volume": 1500.0})
        else:
            bars2.append({"time": d1_0930 + i * 300, "open": o, "high": 500.9, "low": 499.8, "close": c, "volume": 2000.0 + i * 100.0})

    # Session 2: bar 0 provides buy/sell, bar 1.. omit -> uniform OHLCV_INTRABAR_APPROX across Session 2
    for i in range(12):
        t = d2_0930 + i * 300
        if i == 0:
            bars2.append({
                "time": t, "open": 501.0, "high": 501.6, "low": 500.6, "close": 501.4,
                "volume": 2500.0, "buyVolume": 2000.0, "sellVolume": 500.0,
            })
        elif i == 8:
            # Pinbar absorption BUY_ABSORPTION around EMA21_15M=502.0 (pct=0.001 -> tol=0.502):
            # close near low -> CLV deeply negative -> big negative barDelta, tiny body 0.02
            bars2.append({
                "time": t, "open": 502.02, "high": 502.60, "low": 501.98, "close": 502.00,
                "volume": 35_000.0,
            })
        else:
            bars2.append({
                "time": t, "open": 501.2, "high": 501.8, "low": 500.8, "close": 501.55,
                "volume": 2100.0 + i * 80.0,
            })

    opt_cvd2 = {
        "asOfUtcSec": t_asof_2,
        "barSeconds": 300,
        "sessionScope": "RTH",
        "levelProximityPct": 0.001,
        "levels": [{"name": "EMA21_15M", "price": 502.0}, {"name": "PDH", "price": 506.0}],
    }
    scenarios.append({"id": "cvd_ohlcv_rth_mixed_uniform_degrade", "bars": bars2, "options": opt_cvd2, "expected": eval_cvd_reference(bars2, opt_cvd2)})

    # 3. Constant flat bars + NaN ATR (mid-rank percentile 50 prevents false triggers)
    t_flat = to_utc_sec(2026, 4, 15, 9, 30)
    bars3 = [
        {"time": t_flat + i * 300, "open": 400.0, "high": 400.2, "low": 399.8, "close": 400.0, "volume": 1000.0, "buyVolume": 1000.0, "sellVolume": 0.0}
        for i in range(25)
    ]
    opt_cvd3 = {
        "asOfUtcSec": t_flat + 25 * 300,
        "barSeconds": 300,
        "sessionScope": "RTH",
        "atr": "NaN",
        "levels": [{"name": "PUT_WALL", "price": 400.0}],
    }
    scenarios.append({"id": "cvd_constant_window_and_nan_atr", "bars": bars3, "options": opt_cvd3, "expected": eval_cvd_reference(bars3, opt_cvd3)})

    return scenarios


def build_primitive_checks() -> dict[str, Any]:
    closes = [100.0 + 0.3 * i + 1.5 * math.sin(i * 0.25) for i in range(70)]
    bars = [
        {
            "time": 1768482000 + i * 300,
            "open": closes[i] - 0.2,
            "high": closes[i] + 0.8 + (i % 3) * 0.2,
            "low": closes[i] - 0.7 - (i % 4) * 0.15,
            "close": closes[i],
            "volume": 1000.0 + i * 25.0,
        }
        for i in range(70)
    ]
    return {
        "bars": bars,
        "sma10": [enc(x) for x in py_sma(closes, 10)],
        "wma10": [enc(x) for x in py_wma(closes, 10)],
        "hma55": [enc(x) for x in py_hma(closes, 55)],
        "wilderAtr14": [enc(x) for x in py_wilder_atr(bars, 14)],
    }


def main() -> None:
    payload = {
        "meta": {
            "generator": "tools/gen_mtf_cvd_fixture.py",
            "command": "python tools/gen_mtf_cvd_fixture.py",
            "precisionTolerance": 1e-11,
        },
        "primitives": build_primitive_checks(),
        "mtfScenarios": build_mtf_scenarios(),
        "cvdScenarios": build_cvd_scenarios(),
    }
    out_path = Path("fixtures/mtf_cvd_reference.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Generated {out_path} ({len(payload['mtfScenarios'])} MTF + {len(payload['cvdScenarios'])} CVD scenarios)")


if __name__ == "__main__":
    main()
