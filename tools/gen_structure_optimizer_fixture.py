#!/usr/bin/env python3
"""Independent Python reference generator for Pieza 18 (Motores 4 y 10):
- Spatial Confluence Cluster Detector (< 0.15 ATR across AMT, Microstructure, Options)
- Relative Strength vs Benchmark & Causal 48h Pre-Earnings Embargo
- Option Structure Optimizer ("Las 3 Maneras de Jugarla": PoP, +EV, Convexity)
  with real Bid/Ask quotes, fees, VAT, and Historical Cost Percentile

Zero TS code copying: all algorithms are implemented independently in Python stdlib.
Writes: fixtures/structure_optimizer_reference.json
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

CLUSTER_EPS = 1e-12
BUTTERFLY_EPS = 1e-9
ROOT_EPS = 1e-12
ROOT_DEDUP_EPS = 1e-9
SECONDS_PER_HOUR = 3600.0
CANONICAL_CATEGORIES = (
    "AMT_VOLUME_PROFILE",
    "MICROSTRUCTURE_FVG_FOB",
    "OPTIONS_DEALER",
)


def encode_num(val: float) -> float | str | None:
    if math.isnan(val):
        return None
    if math.isinf(val):
        return "INF" if val > 0 else "-INF"
    return val


def fmt_strike(val: float) -> str:
    f = float(val)
    if f.is_integer():
        return str(int(f))
    return str(f)


def sanitize_json(obj: Any) -> Any:
    if isinstance(obj, bool):
        return obj
    if isinstance(obj, int):
        return obj
    if isinstance(obj, float):
        return encode_num(obj)
    if isinstance(obj, dict):
        return {k: sanitize_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [sanitize_json(x) for x in obj]
    return obj


def sign_val(x: float | None) -> float:
    if x is None or not math.isfinite(x):
        return math.nan
    if x > 0.0:
        return 1.0
    if x < 0.0:
        return -1.0
    return 0.0


def py_detect_spatial_confluence_clusters(inputs: dict[str, Any]) -> dict[str, Any]:
    spot = float(inputs["spot"])
    atr = float(inputs["atr"])
    levels = inputs["levels"]
    cluster_radius_atr = float(inputs.get("clusterRadiusAtr", 0.15))
    min_distinct_categories = int(inputs.get("minDistinctCategories", 2))
    trigger = inputs.get("trigger")

    if not math.isfinite(spot) or spot <= 0.0 or not math.isfinite(atr) or atr <= 0.0:
        return {
            "status": "NO_DATA",
            "spot": spot,
            "atr": atr,
            "clusterRadiusAtr": cluster_radius_atr,
            "tolerancePrice": math.nan,
            "validLevelsCount": 0,
            "skippedLevelsCount": len(levels),
            "clusters": [],
            "tripleConfluenceCount": 0,
            "strongestClusterCentroid": math.nan,
            "strongestClusterStrength": math.nan,
        }

    valid = []
    for lv in levels:
        price = lv["price"]
        weight = lv.get("weight", 1.0)
        if (
            price is not None
            and math.isfinite(price)
            and price > 0.0
            and weight is not None
            and math.isfinite(weight)
            and weight > 0.0
        ):
            valid.append(lv)

    skipped = len(levels) - len(valid)
    tolerance = cluster_radius_atr * atr

    if not valid:
        return {
            "status": "NO_DATA",
            "spot": spot,
            "atr": atr,
            "clusterRadiusAtr": cluster_radius_atr,
            "tolerancePrice": tolerance,
            "validLevelsCount": 0,
            "skippedLevelsCount": skipped,
            "clusters": [],
            "tripleConfluenceCount": 0,
            "strongestClusterCentroid": math.nan,
            "strongestClusterStrength": math.nan,
        }

    sorted_levels = sorted(valid, key=lambda x: (x["price"], x["category"], x["name"]))

    def w_centroid(items: list[dict[str, Any]]) -> float:
        num = sum(float(it.get("weight", 1.0)) * float(it["price"]) for it in items)
        den = sum(float(it.get("weight", 1.0)) for it in items)
        return num / den

    groups: list[list[dict[str, Any]]] = []
    curr: list[dict[str, Any]] = []
    for lv in sorted_levels:
        if not curr:
            curr = [lv]
            continue
        trial = curr + [lv]
        c_price = w_centroid(trial)
        if all(abs(float(m["price"]) - c_price) <= tolerance + CLUSTER_EPS for m in trial):
            curr.append(lv)
        else:
            groups.append(curr)
            curr = [lv]
    if curr:
        groups.append(curr)

    clusters: list[dict[str, Any]] = []
    for grp in groups:
        cats_present = {m["category"] for m in grp}
        distinct_cats = [c for c in CANONICAL_CATEGORIES if c in cats_present]
        distinct_count = len(distinct_cats)
        if distinct_count < min_distinct_categories:
            continue

        centroid = w_centroid(grp)
        band_low = min(float(m["price"]) for m in grp)
        band_high = max(float(m["price"]) for m in grp)
        band_width_atr = (band_high - band_low) / atr
        max_dev = max(abs(float(m["price"]) - centroid) for m in grp)
        max_member_dist_atr = max_dev / atr
        dist_to_spot_atr = (centroid - spot) / atr

        if centroid < spot:
            reaction = "SUPPORT_BULLISH"
        elif centroid > spot:
            reaction = "RESISTANCE_BEARISH"
        else:
            reaction = "MAGNET_NEUTRAL"

        trig_aligned = False
        if trigger is not None:
            cvd_s = sign_val(trigger.get("cvdSlopeSign"))
            opt_s = sign_val(trigger.get("optionsDeltaFlowSign"))
            if math.isfinite(cvd_s) and math.isfinite(opt_s):
                if reaction == "SUPPORT_BULLISH":
                    trig_aligned = cvd_s > 0.0 and opt_s > 0.0
                elif reaction == "RESISTANCE_BEARISH":
                    trig_aligned = cvd_s < 0.0 and opt_s < 0.0
                else:
                    trig_aligned = cvd_s != 0.0 and cvd_s == opt_s

        cat_score = 60.0 * (distinct_count / 3.0)
        tight_score = 20.0 * max(0.0, 1.0 - max_member_dist_atr / cluster_radius_atr)
        dens_score = 10.0 * min(1.0, (len(grp) - 1) / 3.0)
        trig_bonus = 10.0 if trig_aligned else 0.0
        strength = min(100.0, max(0.0, cat_score + tight_score + dens_score + trig_bonus))

        clusters.append(
            {
                "centroidPrice": centroid,
                "bandLow": band_low,
                "bandHigh": band_high,
                "bandWidthAtr": band_width_atr,
                "maxMemberDistanceAtr": max_member_dist_atr,
                "distanceToSpotAtr": dist_to_spot_atr,
                "levels": grp,
                "distinctCategories": distinct_cats,
                "distinctCategoriesCount": distinct_count,
                "isTripleConfluence": distinct_count == 3,
                "expectedReaction": reaction,
                "triggerAligned": trig_aligned,
                "clusterStrength": strength,
            }
        )

    clusters.sort(
        key=lambda c: (-c["clusterStrength"], abs(c["distanceToSpotAtr"]), c["centroidPrice"])
    )
    triple_count = sum(1 for c in clusters if c["isTripleConfluence"])

    if not clusters:
        return {
            "status": "NO_DATA",
            "spot": spot,
            "atr": atr,
            "clusterRadiusAtr": cluster_radius_atr,
            "tolerancePrice": tolerance,
            "validLevelsCount": len(valid),
            "skippedLevelsCount": skipped,
            "clusters": [],
            "tripleConfluenceCount": 0,
            "strongestClusterCentroid": math.nan,
            "strongestClusterStrength": math.nan,
        }

    return {
        "status": "OK",
        "spot": spot,
        "atr": atr,
        "clusterRadiusAtr": cluster_radius_atr,
        "tolerancePrice": tolerance,
        "validLevelsCount": len(valid),
        "skippedLevelsCount": skipped,
        "clusters": clusters,
        "tripleConfluenceCount": triple_count,
        "strongestClusterCentroid": clusters[0]["centroidPrice"],
        "strongestClusterStrength": clusters[0]["clusterStrength"],
    }


def py_evaluate_relative_strength_and_catalysts(inputs: dict[str, Any]) -> dict[str, Any]:
    as_of = int(inputs["asOfUtcSec"])
    lookback = int(inputs.get("lookbackBars", 20))
    neutral_band = float(inputs.get("rsNeutralBand", 0.0025))
    embargo_hours = float(inputs.get("embargoHours", 48.0))

    def filter_bars(bars: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
        causal = []
        future = 0
        for b in bars:
            t = int(b["time"])
            c = float(b["close"])
            if t > as_of:
                future += 1
                continue
            if math.isfinite(c) and c > 0.0:
                causal.append({"time": t, "close": c})
        causal.sort(key=lambda x: x["time"])
        return causal, future

    asset_causal, excluded_asset = filter_bars(inputs["assetBars"])
    bench_causal, excluded_bench = filter_bars(inputs["benchmarkBars"])

    known_earnings: list[int] = []
    next_e = inputs.get("nextEarningsUtcSec")
    known_at = inputs.get("earningsKnownAtUtcSec")
    if next_e is not None:
        if known_at is None or int(known_at) <= as_of:
            known_earnings.append(int(next_e))

    for ev in inputs.get("earningsCalendar", []):
        ann = ev.get("announcedAtUtcSec")
        if ann is None or int(ann) <= as_of:
            known_earnings.append(int(ev["earningsUtcSec"]))

    upcoming = [e for e in known_earnings if e >= as_of]
    past = [e for e in known_earnings if e < as_of]
    resolved_earnings: int | None = None
    if upcoming:
        resolved_earnings = min(upcoming)
    elif past:
        resolved_earnings = max(past)

    if resolved_earnings is None:
        hours_to_earnings = math.nan
        entry_blocked = False
        block_reason = "NONE"
    else:
        hours_to_earnings = (resolved_earnings - as_of) / SECONDS_PER_HOUR
        entry_blocked = 0.0 <= hours_to_earnings <= embargo_hours
        block_reason = "EARNINGS_JUMP_RISK_48H" if entry_blocked else "NONE"

    if len(asset_causal) < lookback + 1 or len(bench_causal) < lookback + 1:
        return {
            "status": "NO_DATA",
            "asOfUtcSec": as_of,
            "lookbackBars": lookback,
            "embargoHours": embargo_hours,
            "causalAssetBarCount": len(asset_causal),
            "causalBenchmarkBarCount": len(bench_causal),
            "excludedFutureAssetBars": excluded_asset,
            "excludedFutureBenchmarkBars": excluded_bench,
            "assetReturn": math.nan,
            "benchmarkReturn": math.nan,
            "rsSpread": math.nan,
            "rsRatioBase": math.nan,
            "rsRatioCurrent": math.nan,
            "rsRatioChange": math.nan,
            "rsClassification": "NO_DATA",
            "hoursToEarnings": hours_to_earnings,
            "entryBlocked": entry_blocked,
            "blockReason": block_reason,
        }

    c_a_now = asset_causal[-1]["close"]
    c_a_base = asset_causal[-1 - lookback]["close"]
    c_b_now = bench_causal[-1]["close"]
    c_b_base = bench_causal[-1 - lookback]["close"]

    r_asset = c_a_now / c_a_base - 1.0
    r_bench = c_b_now / c_b_base - 1.0
    rs_spread = r_asset - r_bench
    rs_ratio_base = c_a_base / c_b_base
    rs_ratio_curr = c_a_now / c_b_now
    rs_ratio_change = rs_ratio_curr / rs_ratio_base - 1.0

    if rs_spread > neutral_band:
        rs_class = "OUTPERFORMING"
    elif rs_spread < -neutral_band:
        rs_class = "UNDERPERFORMING"
    else:
        rs_class = "INLINE"

    return {
        "status": "OK",
        "asOfUtcSec": as_of,
        "lookbackBars": lookback,
        "embargoHours": embargo_hours,
        "causalAssetBarCount": len(asset_causal),
        "causalBenchmarkBarCount": len(bench_causal),
        "excludedFutureAssetBars": excluded_asset,
        "excludedFutureBenchmarkBars": excluded_bench,
        "assetReturn": r_asset,
        "benchmarkReturn": r_bench,
        "rsSpread": rs_spread,
        "rsRatioBase": rs_ratio_base,
        "rsRatioCurrent": rs_ratio_curr,
        "rsRatioChange": rs_ratio_change,
        "rsClassification": rs_class,
        "hoursToEarnings": hours_to_earnings,
        "entryBlocked": entry_blocked,
        "blockReason": block_reason,
    }


def _intrinsic_per_share(spot: float, legs: list[dict[str, Any]]) -> float:
    total = 0.0
    for leg in legs:
        sign = 1.0 if leg["side"] == "BUY" else -1.0
        k = float(leg["strike"])
        if leg["contractType"] == "call":
            pay = max(spot - k, 0.0)
        else:
            pay = max(k - spot, 0.0)
        total += sign * float(leg["quantity"]) * pay
    return total


def _add_unique_root(roots: list[float], cand: float) -> None:
    if not math.isfinite(cand) or cand <= ROOT_EPS:
        return
    for r in roots:
        if abs(r - cand) <= ROOT_DEDUP_EPS:
            return
    roots.append(cand)


def _evaluate_blueprint(
    bp: dict[str, Any],
    direction: str,
    lot_size: float,
    fee_rate: float,
    vat_rate: float,
    terminal_prices: list[float],
    norm_probs: list[float],
) -> dict[str, Any] | None:
    eval_legs: list[dict[str, Any]] = []
    signed_gross_cash = 0.0
    total_fees = 0.0
    total_vat = 0.0
    signed_net_cash = 0.0
    net_call_lots = 0.0
    net_put_lots = 0.0

    for leg_spec in bp["legs"]:
        c = leg_spec["contract"]
        side = leg_spec["side"]
        qty = int(leg_spec["quantity"])
        exec_px = float(c["ask"]) if side == "BUY" else float(c["bid"])
        if not math.isfinite(exec_px) or exec_px <= 0.0:
            return None
        gross_prem = qty * lot_size * exec_px
        fee_amt = gross_prem * fee_rate
        vat_amt = fee_amt * vat_rate
        cash_dir = -1.0 if side == "BUY" else 1.0
        pos_sign = 1.0 if side == "BUY" else -1.0

        signed_gross_cash += cash_dir * gross_prem
        total_fees += fee_amt
        total_vat += vat_amt
        signed_net_cash += cash_dir * gross_prem - fee_amt - vat_amt

        if c["contractType"] == "call":
            net_call_lots += pos_sign * qty
        else:
            net_put_lots += pos_sign * qty

        eval_legs.append(
            {
                "strike": float(c["strike"]),
                "contractType": c["contractType"],
                "side": side,
                "quantity": qty,
                "bid": float(c["bid"]),
                "ask": float(c["ask"]),
                "executionPrice": exec_px,
                "grossPremium": gross_prem,
                "feeAmount": fee_amt,
                "vatAmount": vat_amt,
            }
        )

    gross_debit_or_credit = -signed_gross_cash
    total_friction = total_fees + total_vat
    net_debit_or_credit = -signed_net_cash

    if bp["requireNetDebit"] and net_debit_or_credit <= 0.0:
        return None

    spread_width = float(bp["spreadWidth"])
    cost_pct_of_width = (
        net_debit_or_credit / spread_width
        if math.isfinite(spread_width) and spread_width > 0.0 and net_debit_or_credit > 0.0
        else math.nan
    )

    is_defined_risk = net_call_lots >= 0.0 and net_put_lots >= 0.0

    sorted_strikes = sorted({float(leg["strike"]) for leg in eval_legs})
    vertices = [0.0] + sorted_strikes

    def net_payoff(s: float) -> float:
        return lot_size * _intrinsic_per_share(s, eval_legs) - net_debit_or_credit

    vertex_vals = [net_payoff(v) for v in vertices]
    max_loss = max(0.0, -min(vertex_vals)) if is_defined_risk else math.inf
    inf_slope = lot_size * net_call_lots
    max_profit = math.inf if inf_slope > 0.0 else max(vertex_vals)

    breakevens: list[float] = []
    for idx in range(len(vertices) - 1):
        a = vertices[idx]
        b = vertices[idx + 1]
        if b <= a:
            continue
        va = net_payoff(a)
        vb = net_payoff(b)
        if va == vb:
            continue
        if (va <= 0.0 <= vb) or (va >= 0.0 >= vb):
            raw_root = a + ((-va) * (b - a)) / (vb - va)
            clamped = max(a, min(b, raw_root))
            _add_unique_root(breakevens, clamped)

    if sorted_strikes and abs(inf_slope) > ROOT_EPS:
        last_k = sorted_strikes[-1]
        v_last = net_payoff(last_k)
        ray_root = last_k - v_last / inf_slope
        if ray_root >= last_k - ROOT_EPS:
            _add_unique_root(breakevens, max(last_k, ray_root))

    breakevens.sort()

    pop = 0.0
    ev = 0.0
    pos_ev = 0.0
    max_grid_loss = 0.0
    for s_t, p in zip(terminal_prices, norm_probs):
        pnl = net_payoff(s_t)
        ev += p * pnl
        if pnl > 0.0:
            pop += p
            pos_ev += p * pnl
        if -pnl > max_grid_loss:
            max_grid_loss = -pnl

    capital_at_risk = max(max(0.0, net_debit_or_credit), max_grid_loss)
    exp_ror = ev / max_loss if math.isfinite(max_loss) and max_loss > 0.0 else math.nan
    eff_denom = max(max_loss, capital_at_risk) if math.isfinite(max_loss) else capital_at_risk
    convexity = pos_ev / eff_denom if eff_denom > 0.0 else math.nan

    return {
        "id": bp["id"],
        "kind": bp["kind"],
        "label": bp["label"],
        "direction": direction,
        "legs": eval_legs,
        "isDefinedRisk": is_defined_risk,
        "grossDebitOrCredit": gross_debit_or_credit,
        "totalFees": total_fees,
        "totalVat": total_vat,
        "totalFriction": total_friction,
        "netDebitOrCredit": net_debit_or_credit,
        "spreadWidth": spread_width,
        "costPctOfWidth": cost_pct_of_width,
        "maxLoss": max_loss,
        "capitalAtRisk": capital_at_risk,
        "maxProfit": max_profit,
        "breakevenPrices": breakevens,
        "pop": pop,
        "expectedValue": ev,
        "positiveExpectedPayoff": pos_ev,
        "expectedReturnOnRisk": exp_ror,
        "convexityScore": convexity,
    }


def py_optimize_option_structures(inputs: dict[str, Any]) -> dict[str, Any]:
    spot = float(inputs["spot"])
    target_price = float(inputs["targetPrice"])
    direction = inputs["direction"]
    dte = float(inputs["dte"])
    lot_size = float(inputs["lotSize"])
    fee_rate = float(inputs["feeRate"])
    vat_rate = float(inputs["vatRate"])
    max_spread_ratio = float(inputs.get("maxSpreadRatio", 0.35))
    contracts = inputs["contracts"]
    terminal_prices = [float(x) for x in inputs["terminalPrices"]]
    empirical_probs = [float(x) for x in inputs["empiricalProbs"]]

    prob_sum = sum(empirical_probs)
    norm_probs = [p / prob_sum for p in empirical_probs]

    target_type = "call" if direction == "BULLISH" else "put"
    by_strike: dict[float, tuple[dict[str, Any], float]] = {}
    for c in contracts:
        if c["contractType"] != target_type:
            continue
        k = float(c["strike"])
        bid = float(c["bid"])
        ask = float(c["ask"])
        delta = float(c["delta"])
        iv = float(c["iv"])
        if (
            not math.isfinite(k)
            or k <= 0.0
            or not math.isfinite(bid)
            or bid <= 0.0
            or not math.isfinite(ask)
            or ask < bid
            or not math.isfinite(delta)
            or not math.isfinite(iv)
            or iv <= 0.0
        ):
            continue
        mid = 0.5 * (bid + ask)
        sr = (ask - bid) / mid
        if sr > max_spread_ratio + CLUSTER_EPS:
            continue
        if k not in by_strike or sr < by_strike[k][1]:
            by_strike[k] = (c, sr)

    liquid = [entry[0] for _, entry in sorted(by_strike.items(), key=lambda kv: kv[0])]
    skipped_count = len(contracts) - len(liquid)

    atm = min(liquid, key=lambda c: (abs(float(c["strike"]) - spot), float(c["strike"])))
    blueprints: list[dict[str, Any]] = []

    if direction == "BULLISH":
        k_min = min(spot, float(atm["strike"]))
        above_target = [float(c["strike"]) for c in liquid if float(c["strike"]) >= target_price]
        k_target_upper = above_target[0] if above_target else float(liquid[-1]["strike"])

        for c1 in liquid:
            k1 = float(c1["strike"])
            if k_min <= k1 <= k_target_upper:
                s1 = fmt_strike(k1)
                blueprints.append(
                    {
                        "id": f"LONG_CALL_{s1}",
                        "kind": "LONG_CALL",
                        "label": f"Long Call {s1}",
                        "spreadWidth": math.nan,
                        "legs": [{"contract": c1, "side": "BUY", "quantity": 1}],
                        "requireNetDebit": True,
                    }
                )

        for i in range(len(liquid)):
            c1 = liquid[i]
            k1 = float(c1["strike"])
            if not (k_min <= k1 <= k_target_upper):
                continue
            for j in range(i + 1, len(liquid)):
                c2 = liquid[j]
                k2 = float(c2["strike"])
                if k2 > k_target_upper:
                    continue
                w = (k2 - k1) * lot_size
                s1 = fmt_strike(k1)
                s2 = fmt_strike(k2)
                blueprints.append(
                    {
                        "id": f"BULL_CALL_SPREAD_{s1}_{s2}",
                        "kind": "BULL_CALL_SPREAD",
                        "label": f"Bull Call Spread {s1}/{s2}",
                        "spreadWidth": w,
                        "legs": [
                            {"contract": c1, "side": "BUY", "quantity": 1},
                            {"contract": c2, "side": "SELL", "quantity": 1},
                        ],
                        "requireNetDebit": True,
                    }
                )
                blueprints.append(
                    {
                        "id": f"CALL_RATIO_1X2_{s1}_{s2}",
                        "kind": "CALL_RATIO_1X2",
                        "label": f"Call Ratio 1x2 {s1}/{s2}",
                        "spreadWidth": w,
                        "legs": [
                            {"contract": c1, "side": "BUY", "quantity": 1},
                            {"contract": c2, "side": "SELL", "quantity": 2},
                        ],
                        "requireNetDebit": False,
                    }
                )

        for i in range(len(liquid)):
            c1 = liquid[i]
            k1 = float(c1["strike"])
            for j in range(i + 1, len(liquid)):
                c2 = liquid[j]
                k2 = float(c2["strike"])
                if not (k_min <= k2 <= k_target_upper):
                    continue
                left_wing = k2 - k1
                for m in range(j + 1, len(liquid)):
                    c3 = liquid[m]
                    k3 = float(c3["strike"])
                    right_wing = k3 - k2
                    if abs(left_wing - right_wing) <= BUTTERFLY_EPS:
                        s1 = fmt_strike(k1)
                        s2 = fmt_strike(k2)
                        s3 = fmt_strike(k3)
                        blueprints.append(
                            {
                                "id": f"CALL_BUTTERFLY_{s1}_{s2}_{s3}",
                                "kind": "CALL_BUTTERFLY",
                                "label": f"Call Butterfly {s1}/{s2}/{s3}",
                                "spreadWidth": left_wing * lot_size,
                                "legs": [
                                    {"contract": c1, "side": "BUY", "quantity": 1},
                                    {"contract": c2, "side": "SELL", "quantity": 2},
                                    {"contract": c3, "side": "BUY", "quantity": 1},
                                ],
                                "requireNetDebit": True,
                            }
                        )
    else:
        k_max = max(spot, float(atm["strike"]))
        below_target = [float(c["strike"]) for c in liquid if float(c["strike"]) <= target_price]
        k_target_lower = below_target[-1] if below_target else float(liquid[0]["strike"])

        for c1 in liquid:
            k1 = float(c1["strike"])
            if k_target_lower <= k1 <= k_max:
                s1 = fmt_strike(k1)
                blueprints.append(
                    {
                        "id": f"LONG_PUT_{s1}",
                        "kind": "LONG_PUT",
                        "label": f"Long Put {s1}",
                        "spreadWidth": math.nan,
                        "legs": [{"contract": c1, "side": "BUY", "quantity": 1}],
                        "requireNetDebit": True,
                    }
                )

        for i in range(len(liquid)):
            c2 = liquid[i]
            k2 = float(c2["strike"])
            if k2 < k_target_lower:
                continue
            for j in range(i + 1, len(liquid)):
                c1 = liquid[j]
                k1 = float(c1["strike"])
                if k1 > k_max:
                    continue
                w = (k1 - k2) * lot_size
                s1 = fmt_strike(k1)
                s2 = fmt_strike(k2)
                blueprints.append(
                    {
                        "id": f"BEAR_PUT_SPREAD_{s1}_{s2}",
                        "kind": "BEAR_PUT_SPREAD",
                        "label": f"Bear Put Spread {s1}/{s2}",
                        "spreadWidth": w,
                        "legs": [
                            {"contract": c1, "side": "BUY", "quantity": 1},
                            {"contract": c2, "side": "SELL", "quantity": 1},
                        ],
                        "requireNetDebit": True,
                    }
                )
                blueprints.append(
                    {
                        "id": f"PUT_RATIO_1X2_{s1}_{s2}",
                        "kind": "PUT_RATIO_1X2",
                        "label": f"Put Ratio 1x2 {s1}/{s2}",
                        "spreadWidth": w,
                        "legs": [
                            {"contract": c1, "side": "BUY", "quantity": 1},
                            {"contract": c2, "side": "SELL", "quantity": 2},
                        ],
                        "requireNetDebit": False,
                    }
                )

        for i in range(len(liquid)):
            c1 = liquid[i]
            k1 = float(c1["strike"])
            for j in range(i + 1, len(liquid)):
                c2 = liquid[j]
                k2 = float(c2["strike"])
                if not (k_target_lower <= k2 <= k_max):
                    continue
                left_wing = k2 - k1
                for m in range(j + 1, len(liquid)):
                    c3 = liquid[m]
                    k3 = float(c3["strike"])
                    right_wing = k3 - k2
                    if abs(left_wing - right_wing) <= BUTTERFLY_EPS:
                        s1 = fmt_strike(k1)
                        s2 = fmt_strike(k2)
                        s3 = fmt_strike(k3)
                        blueprints.append(
                            {
                                "id": f"PUT_BUTTERFLY_{s1}_{s2}_{s3}",
                                "kind": "PUT_BUTTERFLY",
                                "label": f"Put Butterfly {s1}/{s2}/{s3}",
                                "spreadWidth": left_wing * lot_size,
                                "legs": [
                                    {"contract": c1, "side": "BUY", "quantity": 1},
                                    {"contract": c2, "side": "SELL", "quantity": 2},
                                    {"contract": c3, "side": "BUY", "quantity": 1},
                                ],
                                "requireNetDebit": True,
                            }
                        )

    candidates: list[dict[str, Any]] = []
    for bp in blueprints:
        ev = _evaluate_blueprint(
            bp, direction, lot_size, fee_rate, vat_rate, terminal_prices, norm_probs
        )
        if ev is not None:
            candidates.append(ev)

    candidates.sort(key=lambda c: (-c["expectedValue"], -c["pop"], c["id"]))

    def score_val(v: float) -> float:
        return v if math.isfinite(v) else -math.inf

    def pick_best(pool: list[dict[str, Any]], k1: str, k2: str, k3: str) -> dict[str, Any] | None:
        if not pool:
            return None
        return sorted(
            pool,
            key=lambda c: (-score_val(c[k1]), -score_val(c[k2]), -score_val(c[k3]), c["id"]),
        )[0]

    best_pop = pick_best(candidates, "pop", "expectedValue", "convexityScore")
    ev_pool = [c for c in candidates if best_pop is None or c["id"] != best_pop["id"]]
    best_ev = pick_best(ev_pool if ev_pool else candidates, "expectedValue", "pop", "convexityScore")

    defined_pool = [
        c
        for c in candidates
        if math.isfinite(c["maxLoss"]) and math.isfinite(c["convexityScore"])
    ]
    conv_filtered = [
        c
        for c in defined_pool
        if (best_pop is None or c["id"] != best_pop["id"])
        and (best_ev is None or c["id"] != best_ev["id"])
    ]
    best_conv = pick_best(
        conv_filtered if conv_filtered else defined_pool,
        "convexityScore",
        "expectedValue",
        "pop",
    )

    return {
        "status": "OK",
        "direction": direction,
        "spot": spot,
        "targetPrice": target_price,
        "dte": dte,
        "lotSize": lot_size,
        "liquidContractsCount": len(liquid),
        "skippedContractsCount": skipped_count,
        "candidates": candidates,
        "bestByPop": best_pop,
        "bestByExpectedValue": best_ev,
        "bestByConvexity": best_conv,
    }


def py_compute_structure_cost_percentile(inputs: dict[str, Any]) -> dict[str, Any]:
    lookback = int(inputs.get("lookbackWindow", 300))
    min_obs = int(inputs.get("minObservations", 1))

    if "currentCostPctOfWidth" in inputs and inputs["currentCostPctOfWidth"] is not None:
        curr = float(inputs["currentCostPctOfWidth"])
    elif (
        "netDebit" in inputs
        and "spreadWidth" in inputs
        and inputs["netDebit"] is not None
        and inputs["spreadWidth"] is not None
    ):
        nd = float(inputs["netDebit"])
        sw = float(inputs["spreadWidth"])
        curr = nd / sw if nd > 0.0 and sw > 0.0 else math.nan
    else:
        curr = math.nan

    valid_hist = [
        float(v)
        for v in inputs["historicalCostPctSeries"]
        if v is not None and math.isfinite(v) and float(v) > 0.0
    ]
    window = valid_hist[-lookback:]
    obs_used = len(window)

    if not math.isfinite(curr) or curr <= 0.0 or obs_used < min_obs:
        return {
            "status": "NO_DATA",
            "currentCostPctOfWidth": curr if math.isfinite(curr) and curr > 0.0 else math.nan,
            "percentile": math.nan,
            "regime": "NO_DATA",
            "observationsUsed": obs_used,
            "minCostPct": math.nan,
            "maxCostPct": math.nan,
            "meanCostPct": math.nan,
        }

    le_count = sum(1 for h in window if h <= curr)
    pct = (le_count / obs_used) * 100.0
    if pct <= 25.0:
        regime = "CHEAP_HISTORICAL_DEBIT"
    elif pct >= 75.0:
        regime = "RICH_HISTORICAL_DEBIT"
    else:
        regime = "FAIR"

    return {
        "status": "OK",
        "currentCostPctOfWidth": curr,
        "percentile": pct,
        "regime": regime,
        "observationsUsed": obs_used,
        "minCostPct": min(window),
        "maxCostPct": max(window),
        "meanCostPct": sum(window) / obs_used,
    }


def make_bars(
    start_ts: int, step_sec: int, closes: list[float], future_closes: list[float] | None = None
) -> list[dict[str, Any]]:
    bars = [{"time": start_ts + i * step_sec, "close": c} for i, c in enumerate(closes)]
    if future_closes:
        offset = len(closes)
        for j, fc in enumerate(future_closes):
            bars.append({"time": start_ts + (offset + j) * step_sec, "close": fc})
    return bars


def gaussian_probs(grid: list[float], mu: float, sigma: float, tail_bump: float = 0.0) -> list[float]:
    raw = []
    for s in grid:
        z = (s - mu) / sigma
        w = math.exp(-0.5 * z * z)
        if tail_bump > 0.0 and s >= mu + 1.5 * sigma:
            w += tail_bump
        raw.append(w)
    return raw


def main() -> None:
    # ------------------------------------------------------------------
    # 1. Spatial Confluence Clusters (< 0.15 ATR)
    # ------------------------------------------------------------------
    spatial_levels = [
        {"id": "lvl_put_wall", "name": "Put Wall 98", "category": "OPTIONS_DEALER", "price": 98.00, "weight": 1.5},
        {"id": "lvl_fob_dem", "name": "FOB Demand", "category": "MICROSTRUCTURE_FVG_FOB", "price": 98.08, "weight": 1.2},
        {"id": "lvl_npoc", "name": "Naked POC", "category": "AMT_VOLUME_PROFILE", "price": 98.12, "weight": 1.0},
        {"id": "lvl_avwap", "name": "Anchored VWAP", "category": "AMT_VOLUME_PROFILE", "price": 98.20, "weight": 1.0},
        {"id": "lvl_val", "name": "Session VAL", "category": "AMT_VOLUME_PROFILE", "price": 99.10, "weight": 1.0},
        {"id": "lvl_gflip", "name": "Gamma Flip", "category": "OPTIONS_DEALER", "price": 99.16, "weight": 1.0},
        {"id": "lvl_poc_same1", "name": "Session POC", "category": "AMT_VOLUME_PROFILE", "price": 101.00},
        {"id": "lvl_vah_same1", "name": "Weekly VAH", "category": "AMT_VOLUME_PROFILE", "price": 101.05},
        {"id": "lvl_call_wall", "name": "Call Wall 102.5", "category": "OPTIONS_DEALER", "price": 102.40, "weight": 1.4},
        {"id": "lvl_fvg_sup", "name": "Bearish FVG", "category": "MICROSTRUCTURE_FVG_FOB", "price": 102.52, "weight": 1.1},
        {"id": "lvl_pin", "name": "GEX/Charm Pin", "category": "OPTIONS_DEALER", "price": 104.00},
        {"id": "lvl_invalid", "name": "Bad Quote", "category": "AMT_VOLUME_PROFILE", "price": -10.0},
    ]

    spatial_bull_trigger = {
        "spot": 100.0,
        "atr": 2.0,
        "levels": spatial_levels,
        "clusterRadiusAtr": 0.15,
        "minDistinctCategories": 2,
        "trigger": {"cvdSlopeSign": 3.4, "optionsDeltaFlowSign": 1500.0},
    }

    spatial_bear_trigger = {
        "spot": 100.0,
        "atr": 2.0,
        "levels": spatial_levels,
        "clusterRadiusAtr": 0.15,
        "minDistinctCategories": 2,
        "trigger": {"cvdSlopeSign": -2.1, "optionsDeltaFlowSign": -950.0},
    }

    spatial_magnet_levels = [
        {"name": "POC Magnet", "category": "AMT_VOLUME_PROFILE", "price": 100.0},
        {"name": "Charm Pin", "category": "OPTIONS_DEALER", "price": 100.0},
    ]
    spatial_magnet = {
        "spot": 100.0,
        "atr": 2.0,
        "levels": spatial_magnet_levels,
        "trigger": {"cvdSlopeSign": 1.0, "optionsDeltaFlowSign": 1.0},
    }

    # ------------------------------------------------------------------
    # 2. Relative Strength vs Benchmark & 48h Earnings Embargo
    # ------------------------------------------------------------------
    as_of_sec = 1794672000  # 2026-11-14T16:00:00Z
    day_sec = 86400
    t_start = as_of_sec - 20 * day_sec

    # 21 closed bars (t_0 .. t_20 = as_of_sec), plus 2 future bars
    asset_outperf = [100.0 + 0.4 * i for i in range(21)]  # 100 -> 108 (+8%)
    bench_base = [500.0 + 0.75 * i for i in range(21)]    # 500 -> 515 (+3%)
    rs_outperf_input = {
        "asOfUtcSec": as_of_sec,
        "assetBars": make_bars(t_start, day_sec, asset_outperf, [120.0, 125.0]),
        "benchmarkBars": make_bars(t_start, day_sec, bench_base, [530.0]),
        "lookbackBars": 20,
        "rsNeutralBand": 0.0025,
        "embargoHours": 48,
        "nextEarningsUtcSec": as_of_sec + 120 * 3600,
        "earningsKnownAtUtcSec": as_of_sec - 7 * day_sec,
    }

    asset_underperf = [100.0 - 0.2 * i for i in range(21)]  # 100 -> 96 (-4%)
    rs_underperf_blocked_input = {
        "asOfUtcSec": as_of_sec,
        "assetBars": make_bars(t_start, day_sec, asset_underperf),
        "benchmarkBars": make_bars(t_start, day_sec, bench_base),
        "lookbackBars": 20,
        "rsNeutralBand": 0.0025,
        "embargoHours": 48,
        "nextEarningsUtcSec": as_of_sec + 36 * 3600,
        "earningsKnownAtUtcSec": as_of_sec - 10 * day_sec,
    }

    asset_inline = [100.0 + 0.155 * i for i in range(21)]  # 100 -> 103.1 (+3.1%, spread +0.1% <= 0.25%)
    rs_inline_calendar_input = {
        "asOfUtcSec": as_of_sec,
        "assetBars": make_bars(t_start, day_sec, asset_inline),
        "benchmarkBars": make_bars(t_start, day_sec, bench_base),
        "lookbackBars": 20,
        "rsNeutralBand": 0.0025,
        "embargoHours": 48,
        "earningsCalendar": [
            {"earningsUtcSec": as_of_sec - 90 * day_sec, "announcedAtUtcSec": as_of_sec - 120 * day_sec},
            # Future leak: announced AFTER asOfUtcSec -> MUST be ignored causally
            {"earningsUtcSec": as_of_sec + 24 * 3600, "announcedAtUtcSec": as_of_sec + 3600},
            {"earningsUtcSec": as_of_sec + 72 * 3600, "announcedAtUtcSec": as_of_sec - 5 * day_sec},
        ],
    }

    # ------------------------------------------------------------------
    # 3. Option Structure Optimizer ("Las 3 Maneras de Jugarla")
    # ------------------------------------------------------------------
    # Case A: Bullish BYMA (GGAL) - fees 0.6%, IVA 21%
    bull_grid = [4200.0 + 100.0 * i for i in range(25)]  # 4200 .. 6600
    # Empirical distribution centered around 5550 with right tail out to 6500
    bull_probs = []
    for s in bull_grid:
        core = 0.65 * math.exp(-0.5 * ((s - 5550.0) / 260.0) ** 2)
        tail = 0.35 * math.exp(-0.5 * ((s - 6250.0) / 280.0) ** 2)
        bull_probs.append(core + tail)

    bull_contracts = [
        {"strike": 4800, "contractType": "call", "bid": 430.0, "ask": 450.0, "delta": 0.72, "iv": 0.52},
        {"strike": 5000, "contractType": "call", "bid": 300.0, "ask": 315.0, "delta": 0.58, "iv": 0.49},
        {"strike": 5200, "contractType": "call", "bid": 205.0, "ask": 215.0, "delta": 0.45, "iv": 0.48},
        {"strike": 5300, "contractType": "call", "bid": 100.0, "ask": 180.0, "delta": 0.39, "iv": 0.47},  # illiquid spread 80/140 = 0.571 > 0.35
        {"strike": 5400, "contractType": "call", "bid": 135.0, "ask": 145.0, "delta": 0.33, "iv": 0.46},
        {"strike": 5600, "contractType": "call", "bid": 115.0, "ask": 120.0, "delta": 0.24, "iv": 0.46},
        {"strike": 5800, "contractType": "call", "bid": 62.0, "ask": 68.0, "delta": 0.16, "iv": 0.47},
        {"strike": 6000, "contractType": "call", "bid": 0.0, "ask": 40.0, "delta": 0.10, "iv": 0.48},   # bid=0 skipped
        {"strike": 5000, "contractType": "put", "bid": 210.0, "ask": 225.0, "delta": -0.42, "iv": 0.50},   # put skipped on BULLISH
    ]

    bull_opt_input = {
        "spot": 5000.0,
        "targetPrice": 5600.0,
        "direction": "BULLISH",
        "dte": 30,
        "lotSize": 100,
        "contracts": bull_contracts,
        "terminalPrices": bull_grid,
        "empiricalProbs": bull_probs,
        "feeRate": 0.006,
        "vatRate": 0.21,
        "maxSpreadRatio": 0.35,
    }
    bull_opt_res = py_optimize_option_structures(bull_opt_input)

    # Case B: Bearish US (SPY) - fees 0.1%, IVA 0%
    bear_grid = [490.0 + 5.0 * i for i in range(25)]  # 490 .. 610
    bear_probs = []
    for s in bear_grid:
        core = 0.65 * math.exp(-0.5 * ((s - 552.0) / 13.0) ** 2)
        tail = 0.35 * math.exp(-0.5 * ((s - 515.0) / 14.0) ** 2)
        bear_probs.append(core + tail)

    bear_contracts = [
        {"strike": 530, "contractType": "put", "bid": 3.2, "ask": 3.6, "delta": -0.14, "iv": 0.24},
        {"strike": 540, "contractType": "put", "bid": 5.1, "ask": 5.5, "delta": -0.21, "iv": 0.23},
        {"strike": 550, "contractType": "put", "bid": 9.8, "ask": 10.2, "delta": -0.30, "iv": 0.22},
        {"strike": 560, "contractType": "put", "bid": 12.6, "ask": 13.2, "delta": -0.39, "iv": 0.21},
        {"strike": 570, "contractType": "put", "bid": 17.5, "ask": 18.2, "delta": -0.47, "iv": 0.20},
        {"strike": 580, "contractType": "put", "bid": 23.0, "ask": 24.0, "delta": -0.56, "iv": 0.19},
        {"strike": 590, "contractType": "put", "bid": 31.0, "ask": 32.5, "delta": -0.66, "iv": 0.19},
        {"strike": 580, "contractType": "call", "bid": 12.0, "ask": 12.5, "delta": 0.52, "iv": 0.18},  # call skipped on BEARISH
    ]

    bear_opt_input = {
        "spot": 580.0,
        "targetPrice": 550.0,
        "direction": "BEARISH",
        "dte": 21,
        "lotSize": 100,
        "contracts": bear_contracts,
        "terminalPrices": bear_grid,
        "empiricalProbs": bear_probs,
        "feeRate": 0.001,
        "vatRate": 0.0,
        "maxSpreadRatio": 0.35,
    }
    bear_opt_res = py_optimize_option_structures(bear_opt_input)

    # Case C: Bullish net-credit 1x2 Ratio wins PoP; defined-risk Butterfly wins Convexity
    ratio_grid = [90.0 + 2.0 * i for i in range(21)]  # 90 .. 130
    ratio_probs = [math.exp(-0.5 * ((s - 108.0) / 5.5) ** 2) for s in ratio_grid]
    ratio_contracts = [
        {"strike": 100.0, "contractType": "call", "bid": 4.8, "ask": 5.0, "delta": 0.56, "iv": 0.25},
        {"strike": 105.0, "contractType": "call", "bid": 3.0, "ask": 3.2, "delta": 0.40, "iv": 0.27},
        {"strike": 110.0, "contractType": "call", "bid": 2.9, "ask": 3.0, "delta": 0.26, "iv": 0.30},
        {"strike": 115.0, "contractType": "call", "bid": 0.85, "ask": 0.95, "delta": 0.14, "iv": 0.28},
    ]
    ratio_opt_input = {
        "spot": 100.0,
        "targetPrice": 110.0,
        "direction": "BULLISH",
        "dte": 14,
        "lotSize": 100,
        "contracts": ratio_contracts,
        "terminalPrices": ratio_grid,
        "empiricalProbs": ratio_probs,
        "feeRate": 0.002,
        "vatRate": 0.21,
        "maxSpreadRatio": 0.35,
    }
    ratio_opt_res = py_optimize_option_structures(ratio_opt_input)

    # ------------------------------------------------------------------
    # 4. Historical Structure Cost Percentile (300-day window)
    # ------------------------------------------------------------------
    # 320 elements: first 20 are 0.90 (outside 300-bar window), last 300 are 0.201 .. 0.500
    hist_series = [0.90 for _ in range(20)] + [round(0.20 + 0.001 * i, 6) for i in range(1, 301)]

    cost_cheap_input = {
        "currentCostPctOfWidth": 0.245,
        "historicalCostPctSeries": hist_series,
        "lookbackWindow": 300,
    }
    cost_fair_input = {
        "currentCostPctOfWidth": 0.350,
        "historicalCostPctSeries": hist_series,
        "lookbackWindow": 300,
    }
    cost_rich_input = {
        "netDebit": 184.0,
        "spreadWidth": 400.0,  # 0.46 -> 260/300 = 86.6667th percentile
        "historicalCostPctSeries": hist_series,
        "lookbackWindow": 300,
    }

    print(
        f"[BULL] candidates={len(bull_opt_res['candidates'])} "
        f"PoP={bull_opt_res['bestByPop']['id']} ({bull_opt_res['bestByPop']['pop']:.4f}), "
        f"EV={bull_opt_res['bestByExpectedValue']['id']} ({bull_opt_res['bestByExpectedValue']['expectedValue']:.2f}), "
        f"Conv={bull_opt_res['bestByConvexity']['id']} ({bull_opt_res['bestByConvexity']['convexityScore']:.4f})"
    )
    print(
        f"[BEAR] candidates={len(bear_opt_res['candidates'])} "
        f"PoP={bear_opt_res['bestByPop']['id']} ({bear_opt_res['bestByPop']['pop']:.4f}), "
        f"EV={bear_opt_res['bestByExpectedValue']['id']} ({bear_opt_res['bestByExpectedValue']['expectedValue']:.2f}), "
        f"Conv={bear_opt_res['bestByConvexity']['id']} ({bear_opt_res['bestByConvexity']['convexityScore']:.4f})"
    )
    print(
        f"[RATIO] candidates={len(ratio_opt_res['candidates'])} "
        f"PoP={ratio_opt_res['bestByPop']['id']} ({ratio_opt_res['bestByPop']['pop']:.4f}, netDebit={ratio_opt_res['bestByPop']['netDebitOrCredit']:.2f}), "
        f"EV={ratio_opt_res['bestByExpectedValue']['id']} ({ratio_opt_res['bestByExpectedValue']['expectedValue']:.2f}), "
        f"Conv={ratio_opt_res['bestByConvexity']['id']} ({ratio_opt_res['bestByConvexity']['convexityScore']:.4f})"
    )

    fixture = {
        "inputs": {
            "spatialBullTrigger": spatial_bull_trigger,
            "spatialBearTrigger": spatial_bear_trigger,
            "spatialMagnet": spatial_magnet,
            "rsOutperforming": rs_outperf_input,
            "rsUnderperformingBlocked": rs_underperf_blocked_input,
            "rsInlineCausalCalendar": rs_inline_calendar_input,
            "optimizerBullishByma": bull_opt_input,
            "optimizerBearishUs": bear_opt_input,
            "optimizerRatioCreditPop": ratio_opt_input,
            "costPercentileCheap": cost_cheap_input,
            "costPercentileFair": cost_fair_input,
            "costPercentileRich": cost_rich_input,
        },
        "expected": {
            "spatialBullTrigger": py_detect_spatial_confluence_clusters(spatial_bull_trigger),
            "spatialBearTrigger": py_detect_spatial_confluence_clusters(spatial_bear_trigger),
            "spatialMagnet": py_detect_spatial_confluence_clusters(spatial_magnet),
            "rsOutperforming": py_evaluate_relative_strength_and_catalysts(rs_outperf_input),
            "rsUnderperformingBlocked": py_evaluate_relative_strength_and_catalysts(rs_underperf_blocked_input),
            "rsInlineCausalCalendar": py_evaluate_relative_strength_and_catalysts(rs_inline_calendar_input),
            "optimizerBullishByma": bull_opt_res,
            "optimizerBearishUs": bear_opt_res,
            "optimizerRatioCreditPop": ratio_opt_res,
            "costPercentileCheap": py_compute_structure_cost_percentile(cost_cheap_input),
            "costPercentileFair": py_compute_structure_cost_percentile(cost_fair_input),
            "costPercentileRich": py_compute_structure_cost_percentile(cost_rich_input),
        },
    }

    out_path = Path(__file__).resolve().parent.parent / "fixtures" / "structure_optimizer_reference.json"
    out_path.write_text(json.dumps(sanitize_json(fixture), indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
