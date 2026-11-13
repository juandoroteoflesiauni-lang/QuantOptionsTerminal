"""Independent Python reference generator for Pieza 11 (`divergences.ts` & `breadthMacro.ts`).

Usage:
    python tools/gen_divergences_breadth_fixture.py

Writes:
    fixtures/divergences_breadth_reference.json

Implemented independently in pure Python stdlib (`math`, `json`) without sharing
code with TypeScript. Non-finite scalars (`NaN`) serialize as `"NaN"`.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any


def enc(val: float) -> float | str:
    return "NaN" if not math.isfinite(val) else val


def dec(val: float | str) -> float:
    return math.nan if val == "NaN" else float(val)


# ---------------------------------------------------------------------------
# Independent math implementations
# ---------------------------------------------------------------------------

def py_wilder_rsi(closes: list[float], period: int = 14) -> list[float]:
    n = len(closes)
    out = [math.nan] * n
    if n < period + 1 or not all(math.isfinite(x) for x in closes[: period + 1]):
        return out

    gains = 0.0
    losses = 0.0
    for i in range(1, period + 1):
        diff = closes[i] - closes[i - 1]
        if diff > 0.0:
            gains += diff
        elif diff < 0.0:
            losses += -diff

    avg_gain = gains / float(period)
    avg_loss = losses / float(period)

    def _rsi(ag: float, al: float) -> float:
        if al == 0.0:
            return 50.0 if ag == 0.0 else 100.0
        return 100.0 - 100.0 / (1.0 + ag / al)

    out[period] = _rsi(avg_gain, avg_loss)
    for i in range(period + 1, n):
        if not math.isfinite(closes[i]) or not math.isfinite(closes[i - 1]):
            break
        diff = closes[i] - closes[i - 1]
        g = diff if diff > 0.0 else 0.0
        l = -diff if diff < 0.0 else 0.0
        avg_gain = (avg_gain * (period - 1) + g) / float(period)
        avg_loss = (avg_loss * (period - 1) + l) / float(period)
        out[i] = _rsi(avg_gain, avg_loss)
    return out


def py_pivots(
    times: list[int],
    highs: list[float],
    lows: list[float],
    bar_seconds: int,
    left_bars: int,
    right_bars: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    n = len(times)
    if n < left_bars + right_bars + 1:
        return [], [], []
    pivots: list[dict[str, Any]] = []
    shs: list[dict[str, Any]] = []
    sls: list[dict[str, Any]] = []

    for p in range(left_bars, n - right_bars):
        c_idx = p + right_bars
        c_time = times[c_idx]
        c_close = c_time + bar_seconds

        ph = highs[p]
        if math.isfinite(ph):
            left_ok = all(math.isfinite(highs[j]) and ph > highs[j] for j in range(p - left_bars, p))
            right_ok = all(math.isfinite(highs[j]) and ph >= highs[j] for j in range(p + 1, p + right_bars + 1))
            if left_ok and right_ok:
                piv = {
                    "kind": "SWING_HIGH",
                    "pivotIndex": p,
                    "time": times[p],
                    "price": ph,
                    "confirmedAtIndex": c_idx,
                    "confirmedAtTime": c_time,
                    "confirmedAtCloseUtcSec": c_close,
                }
                shs.append(piv)
                pivots.append(piv)

        pl = lows[p]
        if math.isfinite(pl):
            left_ok = all(math.isfinite(lows[j]) and pl < lows[j] for j in range(p - left_bars, p))
            right_ok = all(math.isfinite(lows[j]) and pl <= lows[j] for j in range(p + 1, p + right_bars + 1))
            if left_ok and right_ok:
                piv = {
                    "kind": "SWING_LOW",
                    "pivotIndex": p,
                    "time": times[p],
                    "price": pl,
                    "confirmedAtIndex": c_idx,
                    "confirmedAtTime": c_time,
                    "confirmedAtCloseUtcSec": c_close,
                }
                sls.append(piv)
                pivots.append(piv)

    return pivots, shs, sls


def py_eval_rsi_divergences(bars: list[dict[str, float]], options: dict[str, Any]) -> dict[str, Any]:
    as_of = int(options["asOfUtcSec"])
    bs = int(options["barSeconds"])
    period = int(options.get("rsiPeriod", 14))
    lb = int(options.get("leftBars", 3))
    rb = int(options.get("rightBars", 3))
    min_sep = int(options.get("minPivotSeparationBars", 1))
    max_sep = options.get("maxPivotSeparationBars")

    closed = [b for b in bars if b["time"] + bs <= as_of]
    rsi_seq = py_wilder_rsi([b["close"] for b in closed], period)
    latest_rsi = rsi_seq[-1] if rsi_seq and math.isfinite(rsi_seq[-1]) else math.nan
    _, shs, sls = py_pivots(
        [int(b["time"]) for b in closed],
        [b["high"] for b in closed],
        [b["low"] for b in closed],
        bs,
        lb,
        rb,
    )

    divs: list[dict[str, Any]] = []
    for p1, p2 in zip(sls, sls[1:]):
        sep = p2["pivotIndex"] - p1["pivotIndex"]
        if sep < min_sep or (max_sep is not None and sep > max_sep):
            continue
        r1, r2 = rsi_seq[p1["pivotIndex"]], rsi_seq[p2["pivotIndex"]]
        if not (math.isfinite(r1) and math.isfinite(r2)):
            continue
        dt = None
        if p2["price"] < p1["price"] and r2 > r1:
            dt = "RSI_REGULAR_BULLISH"
        elif p2["price"] > p1["price"] and r2 < r1:
            dt = "RSI_HIDDEN_BULLISH"
        if dt is not None:
            divs.append({
                "type": dt,
                "pivot1Index": p1["pivotIndex"],
                "pivot2Index": p2["pivotIndex"],
                "pivot1Time": p1["time"],
                "pivot2Time": p2["time"],
                "price1": p1["price"],
                "price2": p2["price"],
                "rsi1": r1,
                "rsi2": r2,
                "confirmedAtIndex": p2["confirmedAtIndex"],
                "confirmedAtTime": p2["confirmedAtTime"],
                "confirmedAtCloseUtcSec": p2["confirmedAtCloseUtcSec"],
            })

    for p1, p2 in zip(shs, shs[1:]):
        sep = p2["pivotIndex"] - p1["pivotIndex"]
        if sep < min_sep or (max_sep is not None and sep > max_sep):
            continue
        r1, r2 = rsi_seq[p1["pivotIndex"]], rsi_seq[p2["pivotIndex"]]
        if not (math.isfinite(r1) and math.isfinite(r2)):
            continue
        dt = None
        if p2["price"] > p1["price"] and r2 < r1:
            dt = "RSI_REGULAR_BEARISH"
        elif p2["price"] < p1["price"] and r2 > r1:
            dt = "RSI_HIDDEN_BEARISH"
        if dt is not None:
            divs.append({
                "type": dt,
                "pivot1Index": p1["pivotIndex"],
                "pivot2Index": p2["pivotIndex"],
                "pivot1Time": p1["time"],
                "pivot2Time": p2["time"],
                "price1": p1["price"],
                "price2": p2["price"],
                "rsi1": r1,
                "rsi2": r2,
                "confirmedAtIndex": p2["confirmedAtIndex"],
                "confirmedAtTime": p2["confirmedAtTime"],
                "confirmedAtCloseUtcSec": p2["confirmedAtCloseUtcSec"],
            })

    divs.sort(key=lambda d: (d["confirmedAtIndex"], d["pivot2Index"], d["type"]))
    status = "INSUFFICIENT_DATA" if (len(closed) < max(period + 1, lb + rb + 1) or not math.isfinite(latest_rsi)) else "OK"

    return {
        "asOfUtcSec": as_of,
        "barSeconds": bs,
        "closedBarCount": len(closed),
        "excludedFutureCount": len(bars) - len(closed),
        "status": status,
        "rsiPeriod": period,
        "rsiSeries": [enc(x) for x in rsi_seq],
        "latestRsi": enc(latest_rsi),
        "swingHighs": shs,
        "swingLows": sls,
        "divergences": divs,
        "latestDivergence": divs[-1] if divs else None,
    }


def py_pair_pivots(piv_a: list[dict[str, Any]], piv_b: list[dict[str, Any]], max_skew: int) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    paired: list[tuple[dict[str, Any], dict[str, Any]]] = []
    next_b = 0
    for pa in piv_a:
        while next_b < len(piv_b) and piv_b[next_b]["pivotIndex"] < pa["pivotIndex"] - max_skew:
            next_b += 1
        best_pos = -1
        best_dist = 10**9
        for k in range(next_b, len(piv_b)):
            if piv_b[k]["pivotIndex"] > pa["pivotIndex"] + max_skew:
                break
            d = abs(piv_b[k]["pivotIndex"] - pa["pivotIndex"])
            if d < best_dist:
                best_dist = d
                best_pos = k
        if best_pos >= 0:
            paired.append((pa, piv_b[best_pos]))
            next_b = best_pos + 1
    return paired


def py_eval_smt_divergences(primary: list[dict[str, float]], correlated: list[dict[str, float]], options: dict[str, Any]) -> dict[str, Any]:
    as_of = int(options["asOfUtcSec"])
    bs = int(options["barSeconds"])
    lb = int(options.get("leftBars", 3))
    rb = int(options.get("rightBars", 3))
    min_sep = int(options.get("minPivotSeparationBars", 1))
    max_sep = options.get("maxPivotSeparationBars")
    max_skew = int(options.get("maxPivotSkewBars", 0))

    c_a = [b for b in primary if b["time"] + bs <= as_of]
    c_b = [b for b in correlated if b["time"] + bs <= as_of]

    b_by_t = {int(b["time"]): b for b in c_b}
    sync_a = [b for b in c_a if int(b["time"]) in b_by_t]
    sync_b = [b_by_t[int(b["time"])] for b in sync_a]

    _, sh_a, sl_a = py_pivots([int(b["time"]) for b in sync_a], [b["high"] for b in sync_a], [b["low"] for b in sync_a], bs, lb, rb)
    _, sh_b, sl_b = py_pivots([int(b["time"]) for b in sync_b], [b["high"] for b in sync_b], [b["low"] for b in sync_b], bs, lb, rb)

    paired_lows = py_pair_pivots(sl_a, sl_b, max_skew)
    paired_highs = py_pair_pivots(sh_a, sh_b, max_skew)

    divs: list[dict[str, Any]] = []
    for (a1, b1), (a2, b2) in zip(paired_lows, paired_lows[1:]):
        sep_a = a2["pivotIndex"] - a1["pivotIndex"]
        sep_b = b2["pivotIndex"] - b1["pivotIndex"]
        if sep_a < min_sep or sep_b < min_sep or (max_sep is not None and (sep_a > max_sep or sep_b > max_sep)):
            continue
        sweep = None
        if a2["price"] < a1["price"] and b2["price"] > b1["price"]:
            sweep = "PRIMARY"
        elif a2["price"] > a1["price"] and b2["price"] < b1["price"]:
            sweep = "CORRELATED"
        if sweep is not None:
            conf_close = max(a2["confirmedAtCloseUtcSec"], b2["confirmedAtCloseUtcSec"])
            divs.append({
                "type": "SMT_BULLISH",
                "sweepingAsset": sweep,
                "primaryPivot1Index": a1["pivotIndex"],
                "primaryPivot2Index": a2["pivotIndex"],
                "correlatedPivot1Index": b1["pivotIndex"],
                "correlatedPivot2Index": b2["pivotIndex"],
                "primaryPivot1Time": a1["time"],
                "primaryPivot2Time": a2["time"],
                "correlatedPivot1Time": b1["time"],
                "correlatedPivot2Time": b2["time"],
                "primaryPrice1": a1["price"],
                "primaryPrice2": a2["price"],
                "correlatedPrice1": b1["price"],
                "correlatedPrice2": b2["price"],
                "confirmedAtTime": conf_close - bs,
                "confirmedAtCloseUtcSec": conf_close,
            })

    for (a1, b1), (a2, b2) in zip(paired_highs, paired_highs[1:]):
        sep_a = a2["pivotIndex"] - a1["pivotIndex"]
        sep_b = b2["pivotIndex"] - b1["pivotIndex"]
        if sep_a < min_sep or sep_b < min_sep or (max_sep is not None and (sep_a > max_sep or sep_b > max_sep)):
            continue
        sweep = None
        if a2["price"] > a1["price"] and b2["price"] < b1["price"]:
            sweep = "PRIMARY"
        elif a2["price"] < a1["price"] and b2["price"] > b1["price"]:
            sweep = "CORRELATED"
        if sweep is not None:
            conf_close = max(a2["confirmedAtCloseUtcSec"], b2["confirmedAtCloseUtcSec"])
            divs.append({
                "type": "SMT_BEARISH",
                "sweepingAsset": sweep,
                "primaryPivot1Index": a1["pivotIndex"],
                "primaryPivot2Index": a2["pivotIndex"],
                "correlatedPivot1Index": b1["pivotIndex"],
                "correlatedPivot2Index": b2["pivotIndex"],
                "primaryPivot1Time": a1["time"],
                "primaryPivot2Time": a2["time"],
                "correlatedPivot1Time": b1["time"],
                "correlatedPivot2Time": b2["time"],
                "primaryPrice1": a1["price"],
                "primaryPrice2": a2["price"],
                "correlatedPrice1": b1["price"],
                "correlatedPrice2": b2["price"],
                "confirmedAtTime": conf_close - bs,
                "confirmedAtCloseUtcSec": conf_close,
            })

    divs.sort(key=lambda d: (d["confirmedAtCloseUtcSec"], d["primaryPivot2Index"], d["type"]))
    status = "INSUFFICIENT_DATA" if len(sync_a) < lb + rb + 1 else "OK"
    return {
        "asOfUtcSec": as_of,
        "barSeconds": bs,
        "synchronizedBarCount": len(sync_a),
        "excludedFuturePrimaryCount": len(primary) - len(c_a),
        "excludedFutureCorrelatedCount": len(correlated) - len(c_b),
        "status": status,
        "primarySwingHighs": sh_a,
        "primarySwingLows": sl_a,
        "correlatedSwingHighs": sh_b,
        "correlatedSwingLows": sl_b,
        "divergences": divs,
        "latestDivergence": divs[-1] if divs else None,
    }


def py_eval_breadth(series: list[dict[str, Any]], options: dict[str, Any]) -> dict[str, Any]:
    as_of = int(options["asOfUtcSec"])
    bs = int(options["barSeconds"])
    init_ad = float(options.get("initialAdLine", 0.0))
    lb = int(options.get("leftBars", 3))
    rb = int(options.get("rightBars", 3))
    max_sep = options.get("maxPivotSeparationBars")

    closed = [s for s in series if s["time"] + bs <= as_of]
    points: list[dict[str, Any]] = []
    ad_lines: list[float] = []
    running = init_ad
    poisoned = not math.isfinite(running)

    for s in closed:
        adv = float(s["advances"])
        dec_v = float(s["declines"])
        valid = math.isfinite(adv) and math.isfinite(dec_v)
        ad_net = (adv - dec_v) if valid else math.nan
        if not math.isfinite(ad_net):
            poisoned = True
        elif not poisoned:
            running += ad_net
        ad_line = math.nan if poisoned else running
        tot = (adv + dec_v) if valid else math.nan
        ratio = (adv / tot) if (math.isfinite(tot) and tot > 0.0) else math.nan
        ad_lines.append(ad_line)
        points.append({
            "time": s["time"],
            "indexClose": s["indexClose"],
            "advances": adv,
            "declines": dec_v,
            "adNet": enc(ad_net),
            "adLine": enc(ad_line),
            "adRatio": enc(ratio),
        })

    times = [int(s["time"]) for s in closed]
    highs = [float(s.get("indexHigh", s["indexClose"])) for s in closed]
    lows = [float(s.get("indexLow", s["indexClose"])) for s in closed]
    _, shs, sls = py_pivots(times, highs, lows, bs, lb, rb)

    divs: list[dict[str, Any]] = []
    last_h_div = None
    last_l_div = None

    for idx, (p1, p2) in enumerate(zip(shs, shs[1:])):
        if max_sep is not None and p2["pivotIndex"] - p1["pivotIndex"] > max_sep:
            continue
        a1, a2 = ad_lines[p1["pivotIndex"]], ad_lines[p2["pivotIndex"]]
        if math.isfinite(a1) and math.isfinite(a2) and p2["price"] > p1["price"] and a2 < a1:
            evt = {
                "type": "BEARISH_BREADTH_DIVERGENCE",
                "pivot1Index": p1["pivotIndex"],
                "pivot2Index": p2["pivotIndex"],
                "pivot1Time": p1["time"],
                "pivot2Time": p2["time"],
                "indexPrice1": p1["price"],
                "indexPrice2": p2["price"],
                "adLine1": a1,
                "adLine2": a2,
                "confirmedAtIndex": p2["confirmedAtIndex"],
                "confirmedAtTime": p2["confirmedAtTime"],
                "confirmedAtCloseUtcSec": p2["confirmedAtCloseUtcSec"],
            }
            divs.append(evt)
            if idx == len(shs) - 2:
                last_h_div = evt

    for idx, (p1, p2) in enumerate(zip(sls, sls[1:])):
        if max_sep is not None and p2["pivotIndex"] - p1["pivotIndex"] > max_sep:
            continue
        a1, a2 = ad_lines[p1["pivotIndex"]], ad_lines[p2["pivotIndex"]]
        if math.isfinite(a1) and math.isfinite(a2) and p2["price"] < p1["price"] and a2 > a1:
            evt = {
                "type": "BULLISH_BREADTH_DIVERGENCE",
                "pivot1Index": p1["pivotIndex"],
                "pivot2Index": p2["pivotIndex"],
                "pivot1Time": p1["time"],
                "pivot2Time": p2["time"],
                "indexPrice1": p1["price"],
                "indexPrice2": p2["price"],
                "adLine1": a1,
                "adLine2": a2,
                "confirmedAtIndex": p2["confirmedAtIndex"],
                "confirmedAtTime": p2["confirmedAtTime"],
                "confirmedAtCloseUtcSec": p2["confirmedAtCloseUtcSec"],
            }
            divs.append(evt)
            if idx == len(sls) - 2:
                last_l_div = evt

    divs.sort(key=lambda d: (d["confirmedAtIndex"], d["pivot2Index"], d["type"]))
    if len(shs) < 2 and len(sls) < 2:
        status = "INSUFFICIENT_DATA"
    elif last_h_div is not None and last_l_div is not None:
        status = last_h_div["type"] if last_h_div["confirmedAtCloseUtcSec"] >= last_l_div["confirmedAtCloseUtcSec"] else last_l_div["type"]
    elif last_h_div is not None:
        status = last_h_div["type"]
    elif last_l_div is not None:
        status = last_l_div["type"]
    else:
        status = "NONE"

    last_pt = points[-1] if points else None
    return {
        "asOfUtcSec": as_of,
        "barSeconds": bs,
        "closedBarCount": len(points),
        "excludedFutureCount": len(series) - len(closed),
        "series": points,
        "latestAdNet": last_pt["adNet"] if last_pt else "NaN",
        "latestAdLine": last_pt["adLine"] if last_pt else "NaN",
        "latestAdRatio": last_pt["adRatio"] if last_pt else "NaN",
        "indexSwingHighs": shs,
        "indexSwingLows": sls,
        "divergences": divs,
        "latestDivergence": divs[-1] if divs else None,
        "divergenceStatus": status,
    }


def py_eval_macro_vol(inputs: dict[str, Any], options: dict[str, Any]) -> dict[str, Any]:
    as_of = int(options["asOfUtcSec"])
    vix_bs = int(options.get("vixBarSeconds", 86400))
    skew_bs = int(options.get("skewBarSeconds", vix_bs))
    win = int(options.get("vixSlopeWindow", 5))
    skew_thr = float(options.get("skewAlertThreshold", 145.0))

    def _val(pt: dict[str, Any]) -> float:
        raw = pt["value"] if "value" in pt else pt["close"]
        return dec(raw)

    c_vix = [pt for pt in inputs["vix"] if pt["time"] + vix_bs <= as_of]
    vix_vals = [_val(pt) for pt in c_vix]
    vix_lvl = vix_vals[-1] if (vix_vals and math.isfinite(vix_vals[-1]) and vix_vals[-1] > 0.0) else math.nan

    if len(vix_vals) >= win:
        tail = vix_vals[-win:]
        if all(math.isfinite(y) and y > 0.0 for y in tail):
            mx = (win - 1) / 2.0
            my = sum(tail) / float(win)
            sxx = sum((i - mx) ** 2 for i in range(win))
            sxy = sum((i - mx) * (tail[i] - my) for i in range(win))
            vix_slope = sxy / sxx if sxx > 0.0 else math.nan
        else:
            vix_slope = math.nan
    else:
        vix_slope = math.nan

    skew_in = inputs["cboeSkew"]
    if isinstance(skew_in, list):
        c_skew = [pt for pt in skew_in if pt["time"] + skew_bs <= as_of]
        closed_skew_n = len(c_skew)
        ex_skew_n = len(skew_in) - closed_skew_n
        raw_s = _val(c_skew[-1]) if c_skew else math.nan
        skew_lvl = raw_s if (math.isfinite(raw_s) and raw_s > 0.0) else math.nan
    else:
        raw_s = dec(skew_in)
        skew_lvl = raw_s if (math.isfinite(raw_s) and raw_s > 0.0) else math.nan
        closed_skew_n = 1 if math.isfinite(skew_lvl) else 0
        ex_skew_n = 0

    if not (math.isfinite(vix_lvl) and math.isfinite(skew_lvl)):
        return {
            "asOfUtcSec": as_of,
            "closedVixCount": len(c_vix),
            "excludedFutureVixCount": len(inputs["vix"]) - len(c_vix),
            "closedSkewCount": closed_skew_n,
            "excludedFutureSkewCount": ex_skew_n,
            "vixLevel": enc(vix_lvl),
            "vixSlope": enc(vix_slope),
            "cboeSkewLevel": enc(skew_lvl),
            "vixRegime": "INSUFFICIENT_DATA",
            "tailRiskAlert": False,
            "baseVixFactor": "NaN",
            "vixSlopePenaltyFactor": "NaN",
            "skewPenaltyFactor": "NaN",
            "positionSizeMultiplier": "NaN",
        }

    if vix_lvl < 15.0:
        reg, bf = "LOW_VOL_COMPLACENCY", 1.0
    elif vix_lvl < 22.0:
        reg, bf = "NORMAL_VOL_REGIME", 0.9
    elif vix_lvl < 30.0:
        reg, bf = "ELEVATED_VOL_EXPANSION", 0.65
    else:
        reg, bf = "CRISIS_HIGH_VOL", 0.35

    sf = 0.85 if (math.isfinite(vix_slope) and vix_slope > 0.0) else 1.0
    if skew_lvl >= skew_thr:
        kf = 0.8
    elif skew_lvl >= 135.0:
        kf = 0.9
    else:
        kf = 1.0

    alert = (skew_lvl >= skew_thr) or (vix_lvl >= 22.0 and math.isfinite(vix_slope) and vix_slope > 0.0)
    return {
        "asOfUtcSec": as_of,
        "closedVixCount": len(c_vix),
        "excludedFutureVixCount": len(inputs["vix"]) - len(c_vix),
        "closedSkewCount": closed_skew_n,
        "excludedFutureSkewCount": ex_skew_n,
        "vixLevel": vix_lvl,
        "vixSlope": enc(vix_slope),
        "cboeSkewLevel": skew_lvl,
        "vixRegime": reg,
        "tailRiskAlert": alert,
        "baseVixFactor": bf,
        "vixSlopePenaltyFactor": sf,
        "skewPenaltyFactor": kf,
        "positionSizeMultiplier": bf * sf * kf,
    }


# ---------------------------------------------------------------------------
# Deterministic scenario builders
# ---------------------------------------------------------------------------

def make_bar(t: int, o: float, h: float, l: float, c: float, v: float = 10_000.0) -> dict[str, float]:
    return {"time": t, "open": o, "high": h, "low": l, "close": c, "volume": v}


def make_close_path_bars(t0: int, step: int, closes: list[float], pad_hl: float = 0.25) -> list[dict[str, float]]:
    out = []
    for i, c in enumerate(closes):
        out.append(make_bar(t0 + i * step, c - 0.1, c + pad_hl, c - pad_hl, c, 10_000.0 + i * 50.0))
    return out


def build_rsi_primitives() -> dict[str, Any]:
    fluct = [100.0 + 0.4 * i + 3.2 * math.sin(i * 0.55) for i in range(35)]
    pure_up = [100.0 + 1.5 * i for i in range(20)]
    flat = [100.0 for _ in range(20)]
    short = [100.0 + i for i in range(14)]
    return {
        "fluctuating": {"closes": fluct, "rsi14": [enc(x) for x in py_wilder_rsi(fluct, 14)]},
        "pureUp": {"closes": pure_up, "rsi14": [enc(x) for x in py_wilder_rsi(pure_up, 14)]},
        "flat": {"closes": flat, "rsi14": [enc(x) for x in py_wilder_rsi(flat, 14)]},
        "short14": {"closes": short, "rsi14": [enc(x) for x in py_wilder_rsi(short, 14)]},
    }


def build_rsi_scenarios() -> list[dict[str, Any]]:
    t0 = 1768487400
    step = 300

    # Scenario 1: Uptrend setup with RSI_REGULAR_BULLISH (L1 -> L2) and RSI_HIDDEN_BULLISH (L3 -> L4)
    # Use small steady downtrend warmup first, then steep dump to L1, bounce, shallower grind to lower L2
    bull_closes: list[float] = [120.0 - 0.1 * i for i in range(15)]  # 0..14 (120 -> 118.6)
    # Steep crash into L1 at idx 18 (deep low RSI ~ 8)
    bull_closes += [115.0, 111.0, 106.0, 101.0]  # 15..18 -> L1=101.0
    # Rally to idx 22 (116.0)
    bull_closes += [105.0, 109.5, 113.5, 116.0]  # 19..22
    # Choppy slow grind down to lower low L2=100.2 at idx 29 (higher RSI > L1 => RSI_REGULAR_BULLISH)
    bull_closes += [114.0, 115.5, 111.0, 112.5, 106.5, 103.5, 100.2]  # 23..29 -> L2=100.2
    # Strong steady rally up to idx 42 so pullback base L3 has high RSI (~55), then fast dump to higher low L4 (~35 => RSI_HIDDEN_BULLISH)
    bull_closes += [104.0, 108.0, 112.0, 116.0, 120.0, 124.0, 128.0, 132.0]  # 30..37
    # Pullback L3=126.0 at idx 41 (higher low, high RSI!)
    bull_closes += [130.0, 128.0, 126.8, 126.0]  # 38..41 -> L3=126.0 (moderate RSI ~ 62)
    # Modest continuation rally then sharp fast waterfall to higher low L4=127.0 at idx 50 (RSI plunges < 62 => RSI_HIDDEN_BULLISH)
    bull_closes += [129.0, 132.5, 136.0, 137.0]  # 42..45
    bull_closes += [134.0, 131.0, 129.0, 127.8, 127.0]  # 46..50 -> L4=127.0 (> 126.0, sharp RSI drop!)
    # 4 trailing recovery bars to confirm L4 at rightBars=3 (+ 2 unclosed future bars)
    bull_closes += [129.5, 132.0, 134.0, 135.5, 136.0, 137.0]  # 51..56

    bars_bull = make_close_path_bars(t0, step, bull_closes, pad_hl=0.2)
    as_of_bull = bars_bull[54]["time"] + step  # closed 0..54, future 55..56
    opts_bull = {"asOfUtcSec": as_of_bull, "barSeconds": step, "rsiPeriod": 14, "leftBars": 3, "rightBars": 3}

    # Scenario 2: Downtrend/peak setup with RSI_REGULAR_BEARISH (H1 -> H2) and RSI_HIDDEN_BEARISH (H3 -> H4)
    bear_closes: list[float] = [100.0 + 0.1 * i for i in range(15)]  # 0..14 (100 -> 101.4)
    # Explosive vertical rally to H1=122.0 at idx 19 (extreme overbought RSI!)
    bear_closes += [105.0, 110.0, 115.0, 119.0, 122.0]  # 15..19 -> H1=122.0
    # Drop to 108.0 at idx 23
    bear_closes += [118.0, 114.0, 110.5, 108.0]  # 20..23
    # Choppy weak grind up to higher high H2=123.5 at idx 31 (lower RSI < H1 => RSI_REGULAR_BEARISH)
    bear_closes += [111.0, 109.5, 114.0, 112.5, 117.5, 120.5, 122.5, 123.5]  # 24..31 -> H2=123.5
    # Deep sustained selloff down to 92.0 so lower-high bounce H3 occurs at low RSI (~35), then sudden spike to lower-high H4 at high RSI (~55 => RSI_HIDDEN_BEARISH)
    bear_closes += [119.0, 114.0, 109.0, 104.0, 99.0, 95.0, 92.0]  # 32..38
    # Small weak bounce H3=99.0 at idx 42 (still oversold RSI ~ 40)
    bear_closes += [94.0, 96.5, 98.2, 99.0]  # 39..42 -> H3=99.0
    # Dip to 90.0 then explosive bounce to lower high H4=97.5 (< 99.0) at idx 51 with sharp gain spike => higher RSI > RSI(H3)!
    bear_closes += [96.0, 93.0, 91.0, 90.0]  # 43..46
    bear_closes += [91.2, 93.0, 94.8, 96.4, 97.5]  # 47..51 -> H4=97.5
    # Trailing decline to confirm H4 at idx 54 (+ 1 future bar)
    bear_closes += [95.5, 94.0, 92.5, 91.0, 90.0]  # 52..56

    bars_bear = make_close_path_bars(t0, step, bear_closes, pad_hl=0.2)
    as_of_bear = bars_bear[55]["time"] + step  # closed 0..55, future 56
    opts_bear = {"asOfUtcSec": as_of_bear, "barSeconds": step, "rsiPeriod": 14, "leftBars": 3, "rightBars": 3}

    short_bars = bars_bull[:12]
    opts_short = {"asOfUtcSec": short_bars[-1]["time"] + step, "barSeconds": step}

    return [
        {"id": "rsi_bullish_regular_and_hidden", "bars": bars_bull, "options": opts_bull, "expected": py_eval_rsi_divergences(bars_bull, opts_bull)},
        {"id": "rsi_bearish_regular_and_hidden", "bars": bars_bear, "options": opts_bear, "expected": py_eval_rsi_divergences(bars_bear, opts_bear)},
        {"id": "rsi_warmup_shortage", "bars": short_bars, "options": opts_short, "expected": py_eval_rsi_divergences(short_bars, opts_short)},
    ]


def build_smt_scenarios() -> list[dict[str, Any]]:
    t0 = 1768487400
    step = 300
    # 30 bars total; synced Lows at idx 6 and idx 14; synced Highs at idx 10 and idx 21
    spy_closes = [
        104, 103, 102, 101.5, 101, 100.5, 99.5,  # idx 6 L1=99.3
        101, 102, 103, 104.5,                    # idx 10 H1=104.75
        102.5, 101, 99.8, 98.8,                  # idx 14 L2=98.6 (LOWER LOW in SPY!)
        100.5, 102, 103, 103.5, 103.8, 104.0, 104.1,  # idx 21 H2=104.35 (LOWER HIGH in SPY!)
        103.0, 102.0, 101.0, 100.5, 100.0, 99.5,
    ]
    qqq_closes = [
        204, 203, 202, 201.5, 201, 200.5, 199.0,  # idx 6 L1=198.8
        201, 202, 203, 204.2,                     # idx 10 H1=204.45
        202.5, 201.2, 200.2, 199.7,               # idx 14 L2=199.5 (HIGHER LOW in QQQ => SMT_BULLISH, sweepingAsset=PRIMARY)
        201.5, 203.0, 203.8, 204.4, 204.8, 205.2, 205.8,  # idx 21 H2=206.05 (HIGHER HIGH in QQQ => SMT_BEARISH, sweepingAsset=CORRELATED)
        204.5, 203.0, 202.0, 201.0, 200.5, 200.0,
    ]
    spy_bars = make_close_path_bars(t0, step, spy_closes)
    qqq_bars = make_close_path_bars(t0, step, qqq_closes)
    # Inject 1 unsynchronized timestamp in SPY before t0 (must be dropped by sync without breaking indices!)
    spy_with_extra = [make_bar(t0 - step, 105.0, 105.5, 104.5, 105.0)] + spy_bars
    as_of = spy_bars[24]["time"] + step  # excludes idx 25..27 as future bars
    opts0 = {"asOfUtcSec": as_of, "barSeconds": step, "leftBars": 3, "rightBars": 3, "maxPivotSkewBars": 0}

    # Skew scenario: shift QQQ low L2 by 1 bar right (idx 15 instead of idx 14)
    qqq_skew_closes = list(qqq_closes)
    qqq_skew_closes[14] = 200.1
    qqq_skew_closes[15] = 199.6
    qqq_skew_bars = make_close_path_bars(t0, step, qqq_skew_closes)
    opts_skew1 = {"asOfUtcSec": as_of, "barSeconds": step, "leftBars": 3, "rightBars": 3, "maxPivotSkewBars": 1}

    return [
        {
            "id": "smt_coincident_bullish_and_bearish",
            "primaryBars": spy_with_extra,
            "correlatedBars": qqq_bars,
            "options": opts0,
            "expected": py_eval_smt_divergences(spy_with_extra, qqq_bars, opts0),
        },
        {
            "id": "smt_skew_1bar_match",
            "primaryBars": spy_bars,
            "correlatedBars": qqq_skew_bars,
            "options": opts_skew1,
            "expected": py_eval_smt_divergences(spy_bars, qqq_skew_bars, opts_skew1),
        },
    ]


def build_breadth_scenarios() -> list[dict[str, Any]]:
    t0 = 1768435200
    step = 86400
    # Build breadth series where:
    # - idx 4: index L1=580, adLine increasing then idx 11 L2=575 (lower low) while adLine(11) > adLine(4) => BULLISH_BREADTH_DIVERGENCE
    # - idx 8: index H1=592 -> idx 15 H2=600 (higher high) while adLine(15) < adLine(8) => BEARISH_BREADTH_DIVERGENCE (latest!)
    idx_highs = [586, 584, 583, 582, 581, 585, 588, 591, 594, 590, 584, 577, 583, 590, 596, 602, 597, 594, 592]
    idx_lows =  [584, 582, 581, 580, 578, 582, 585, 588, 590, 586, 580, 573, 579, 586, 592, 598, 593, 590, 588]
    idx_close = [(h + l) / 2.0 for h, l in zip(idx_highs, idx_lows)]
    # Make net breadth rise between idx 4 and idx 11, then deteriorate sharply between idx 8 and idx 15
    advances = [1500, 1400, 1450, 1600, 1700, 1800, 1750, 1700, 1900, 1400, 1300, 1600, 1400, 1200, 1100, 1000, 950, 900, 0]
    declines = [1500, 1400, 1400, 1400, 1400, 1200, 1200, 1100, 1100, 1300, 1200, 1000, 1600, 1800, 1900, 2100, 2000, 1900, 0]

    series = [
        {
            "time": t0 + i * step,
            "indexClose": idx_close[i],
            "indexHigh": idx_highs[i],
            "indexLow": idx_lows[i],
            "advances": advances[i],
            "declines": declines[i],
        }
        for i in range(len(idx_close))
    ]
    # Include idx 18 (advances=0, declines=0 -> adRatio=NaN) as closed bar, and add idx 19 as future bar
    as_of = series[18]["time"] + step
    series.append({"time": t0 + 19 * step, "indexClose": 620.0, "indexHigh": 622.0, "indexLow": 618.0, "advances": 2500, "declines": 500})
    opts = {"asOfUtcSec": as_of, "barSeconds": step, "leftBars": 3, "rightBars": 3}

    short_series = series[:6]
    opts_short = {"asOfUtcSec": short_series[-1]["time"] + step, "barSeconds": step}

    return [
        {"id": "breadth_bullish_then_bearish_divergence", "series": series, "options": opts, "expected": py_eval_breadth(series, opts)},
        {"id": "breadth_insufficient_pivots", "series": short_series, "options": opts_short, "expected": py_eval_breadth(short_series, opts_short)},
    ]


def build_macro_vol_scenarios() -> list[dict[str, Any]]:
    t0 = 1768435200
    step = 86400
    as_of = t0 + 5 * step  # includes indices 0..4

    s1_in = {
        "vix": [{"time": t0 + i * step, "value": 15.5 - 0.5 * i} for i in range(6)],  # idx 4 = 13.5, idx 5 excluded
        "cboeSkew": 128.0,
    }
    s1_opt = {"asOfUtcSec": as_of}

    s2_in = {
        "vix": [make_bar(t0 + i * step, 20.0, 25.0, 19.5, v) for i, v in enumerate([20.0, 21.0, 22.0, 23.0, 25.0, 11.0])],
        "cboeSkew": [
            {"time": t0 + 2 * step, "value": 139.0},
            {"time": t0 + 4 * step, "value": 148.5},
            {"time": t0 + 5 * step, "value": 115.0},  # future excluded
        ],
    }
    s2_opt = {"asOfUtcSec": as_of}

    s3_in = {
        "vix": [{"time": t0 + i * step, "value": v} for i, v in enumerate([36.0, 35.0, 34.5, 34.2, 34.0])],
        "cboeSkew": 138.0,  # 135 <= SKEW < 145 -> 0.90 factor
    }
    s3_opt = {"asOfUtcSec": as_of}

    s4_in = {
        "vix": [{"time": t0 + i * step, "value": v} for i, v in enumerate([17.0, 17.5, 18.0])],  # < 5 -> vixSlope NaN
        "cboeSkew": 146.0,
    }
    s4_opt = {"asOfUtcSec": as_of}

    s5_in = {
        "vix": [{"time": t0 + i * step, "value": v} for i, v in enumerate([18.0, 19.0, 0.0, 18.0, 18.0])],
        "cboeSkew": "NaN",
    }
    s5_opt = {"asOfUtcSec": as_of}

    cases = [
        ("macro_low_vol_normal_skew", s1_in, s1_opt),
        ("macro_elevated_rising_vix_high_skew", s2_in, s2_opt),
        ("macro_crisis_falling_vix_moderate_skew", s3_in, s3_opt),
        ("macro_short_vix_window_nan_slope", s4_in, s4_opt),
        ("macro_invalid_nan_skew", s5_in, s5_opt),
    ]
    return [{"id": cid, "inputs": inp, "options": opt, "expected": py_eval_macro_vol(inp, opt)} for cid, inp, opt in cases]


def main() -> None:
    payload = {
        "meta": {
            "generator": "tools/gen_divergences_breadth_fixture.py",
            "command": "python tools/gen_divergences_breadth_fixture.py",
            "precisionTolerance": 1e-11,
        },
        "rsiPrimitives": build_rsi_primitives(),
        "rsiScenarios": build_rsi_scenarios(),
        "smtScenarios": build_smt_scenarios(),
        "breadthScenarios": build_breadth_scenarios(),
        "macroVolScenarios": build_macro_vol_scenarios(),
    }
    out_path = Path("fixtures/divergences_breadth_reference.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(
        f"Generated {out_path} ("
        f"{len(payload['rsiScenarios'])} RSI, "
        f"{len(payload['smtScenarios'])} SMT, "
        f"{len(payload['breadthScenarios'])} breadth, "
        f"{len(payload['macroVolScenarios'])} macroVol scenarios)"
    )


if __name__ == "__main__":
    main()
