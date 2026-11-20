#!/usr/bin/env python3
"""
Generador de referencia independiente en Python para la Pieza 45:
  1. VRP alineado al vencimiento activo (`vrpActiveExpiry = ivAtmActiveExpiry - rvReference`)
     y clasificador de régimen operativo con DTE y RV comparada.
  2. Gate `DTE < 3` (`timeToExpiry < 3 / 365`) en Paridad Call-Put y Tasas Sintéticas / HTB
     (`impliedRateStatus: 'BLOCKED_SHORT_DTE'`, `impliedBorrowRate: null`, `htbAlert: false`).
  3. Suavizado de Densidad Implícita Breeden-Litzenberger (Q) en varianza total
     `w(k) = sigma(k)^2 * T` mediante filtro binomial + spline cúbico monótono PCHIP
     (Fritsch-Carlson) en log-moneyness `k = ln(K / F)` sobre strikes con `bid > 0`,
     re-evaluación BSM sobre grilla uniforme de strikes, truncado `max(0, d2C/dK2)`
     y re-normalización trapezoidal `integral f(K) dK = 1.0`.
  4. Filtros de liquidez en Spreads (`debit >= 0.10`, `bid > 0`, `bidAskPctOfMid <= 35%`),
     semáforo `Bid-Ask % del Mid = ((ask - bid) / mid) * 100` (GREEN < 5%, YELLOW 5-15%,
     RED > 15%), dimensionamiento monetario USD vs ARS (`costoPorContrato = prima * 100`),
     y validación estricta de Mariposas (`K1 < K2 < K3`) y Calendarios (`nearExpiry != farExpiry`).
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any


DAYS_PER_YEAR = 365.0
MIN_DTE = 3
MIN_T = MIN_DTE / DAYS_PER_YEAR


def norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def bsm_call_price(
    spot: float,
    strike: float,
    time_to_expiry: float,
    rate: float,
    dividend_yield: float,
    volatility: float,
) -> float:
    sqrt_t = math.sqrt(time_to_expiry)
    sig_sqrt_t = volatility * sqrt_t
    d1 = (
        math.log(spot / strike)
        + (rate - dividend_yield + 0.5 * volatility * volatility) * time_to_expiry
    ) / sig_sqrt_t
    d2 = d1 - sig_sqrt_t
    disc_s = spot * math.exp(-dividend_yield * time_to_expiry)
    disc_k = strike * math.exp(-rate * time_to_expiry)
    return disc_s * norm_cdf(d1) - disc_k * norm_cdf(d2)


def clamp_pct(x: float) -> float:
    if x <= 0.0:
        return 0.0
    if x >= 100.0:
        return 100.0
    return x


def clamp_unit(x: float) -> float:
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    return x


def linear_percentile(sorted_vals: list[float], q: float) -> float | None:
    n = len(sorted_vals)
    if n == 0:
        return None
    if n == 1:
        return sorted_vals[0]
    pos = q * (n - 1)
    lo = int(math.floor(pos))
    hi = min(n - 1, lo + 1)
    w = pos - lo
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * w


def median_values(vals: list[float]) -> float | None:
    valid = sorted(v for v in vals if v is not None and math.isfinite(v))
    return linear_percentile(valid, 0.5)


def compute_active_expiry_vrp_ref(inp: dict[str, Any]) -> dict[str, Any]:
    rv_label = inp.get("rvReferenceLabel", "RV23d")
    dte = inp.get("daysToExpiry")
    dte_out = float(dte) if (dte is not None and dte > 0) else None

    iv_atm = inp.get("ivAtmActiveExpiryPct")
    same_fb = inp.get("sameExpiryFallbackIvAtmPct")
    if iv_atm is not None and iv_atm > 0:
        iv_resolved = float(iv_atm)
        iv_source = "INTERPOLATED_ATM"
    elif same_fb is not None and same_fb > 0:
        iv_resolved = float(same_fb)
        iv_source = "SAME_EXPIRY_FALLBACK"
    else:
        iv_resolved = None
        iv_source = "NO_DATA"

    rv_ref = inp.get("rvReferencePct")
    rv_resolved = float(rv_ref) if (rv_ref is not None and rv_ref > 0) else None

    if iv_resolved is None or rv_resolved is None:
        return {
            "status": "NO_DATA",
            "expiryCode": inp.get("expiryCode"),
            "daysToExpiry": dte_out,
            "ivAtmActiveExpiryPct": iv_resolved,
            "ivSource": iv_source,
            "rvReferencePct": rv_resolved,
            "rvReferenceLabel": rv_label,
            "vrpActiveExpiryPts": None,
            "ivRankActiveExpiry": None,
            "ivPercentileActiveExpiry": None,
            "operativeRegime": {
                "code": "NO_DATA",
                "label": "—",
            },
        }

    vrp_pts = iv_resolved - rv_resolved
    hist_series = [float(x) for x in inp.get("historicalRvSeriesPct", []) if x is not None and x > 0]
    iv_rank: float | None = None
    iv_pct: float | None = None
    if len(hist_series) >= 2:
        s_hist = sorted(hist_series)
        min_v = s_hist[0]
        max_v = s_hist[-1]
        if max_v > min_v:
            iv_rank = clamp_pct(((iv_resolved - min_v) / (max_v - min_v)) * 100.0)
        le_cnt = sum(1 for v in s_hist if v <= iv_resolved)
        iv_pct = clamp_pct((le_cnt / len(s_hist)) * 100.0)

    if iv_rank is None:
        code = "NO_DATA"
        label = "—"
    elif iv_rank > 70.0 and vrp_pts > 5.0:
        code = "VENTA_PRIMA_CUBIERTA"
        label = "VENTA DE PRIMA CUBIERTA"
    elif iv_rank < 25.0:
        code = "COMPRA_CONVEXIDAD_CALENDAR"
        label = "COMPRA DE CONVEXIDAD / CALENDAR"
    else:
        code = "NEUTRAL_SELECTIVO"
        label = "NEUTRAL / SELECTIVO"

    return {
        "status": "OK",
        "expiryCode": inp.get("expiryCode"),
        "daysToExpiry": dte_out,
        "ivAtmActiveExpiryPct": iv_resolved,
        "ivSource": iv_source,
        "rvReferencePct": rv_resolved,
        "rvReferenceLabel": rv_label,
        "vrpActiveExpiryPts": vrp_pts,
        "ivRankActiveExpiry": iv_rank,
        "ivPercentileActiveExpiry": iv_pct,
        "operativeRegime": {
            "code": code,
            "label": label,
        },
    }


def compute_synthetic_rates_ref(inp: dict[str, Any]) -> dict[str, Any]:
    spot = float(inp["spot"])
    r = float(inp["riskFreeRate"])
    q = float(inp["dividendYield"])
    t = float(inp["timeToExpiry"])
    dte = inp.get("dte")
    near_atm_count = int(inp.get("nearAtmCount", 5))
    mod_th = float(inp.get("moderateBorrowThreshold", 0.02))
    htb_th = float(inp.get("hardToBorrowThreshold", 0.05))

    is_blocked = (dte is not None and float(dte) < MIN_DTE) or (t < MIN_T - 1e-12)
    disc_spot = spot * math.exp(-q * t)

    strikes_out: list[dict[str, Any]] = []
    for pair in sorted(inp["pairs"], key=lambda p: float(p["strike"])):
        k = float(pair["strike"])
        c_mid = float(pair["callMid"])
        p_mid = float(pair["putMid"])
        disc_k = disc_spot - (c_mid - p_mid)
        if disc_k <= 0.0:
            continue
        abs_log_m = abs(math.log(k / spot))
        if is_blocked:
            fwd = (k * k) / disc_k
            strikes_out.append(
                {
                    "strike": k,
                    "callMid": c_mid,
                    "putMid": p_mid,
                    "syntheticForward": fwd,
                    "impliedRateContinuous": None,
                    "impliedTna": None,
                    "absLogMoneyness": abs_log_m,
                }
            )
        else:
            r_impl = -math.log(disc_k / k) / t
            fwd = k * math.exp(r_impl * t)
            tna = math.expm1(r_impl * t) / t
            strikes_out.append(
                {
                    "strike": k,
                    "callMid": c_mid,
                    "putMid": p_mid,
                    "syntheticForward": fwd,
                    "impliedRateContinuous": r_impl,
                    "impliedTna": tna,
                    "absLogMoneyness": abs_log_m,
                }
            )

    if is_blocked:
        return {
            "status": "OK",
            "impliedRateStatus": "BLOCKED_SHORT_DTE",
            "medianImpliedRate": None,
            "medianImpliedTna": None,
            "impliedBorrowRate": None,
            "htbAlert": False,
            "borrowRegime": "NO_DATA",
            "strikes": strikes_out,
        }

    near_atm = sorted(strikes_out, key=lambda n: (n["absLogMoneyness"], n["strike"]))[:near_atm_count]
    sorted_rates = sorted(float(n["impliedRateContinuous"]) for n in near_atm)
    n_r = len(sorted_rates)
    mid_idx = n_r // 2
    if n_r % 2 == 1:
        med_r = sorted_rates[mid_idx]
    else:
        med_r = 0.5 * (sorted_rates[mid_idx - 1] + sorted_rates[mid_idx])
    med_tna = math.expm1(med_r * t) / t
    borrow_r = r - med_r
    if borrow_r >= htb_th:
        regime = "HARD_TO_BORROW_SQUEEZE_ALERT"
    elif borrow_r >= mod_th:
        regime = "MODERATE_SHORT_DEMAND"
    else:
        regime = "EASY_TO_BORROW"

    return {
        "status": "OK",
        "impliedRateStatus": "OK",
        "medianImpliedRate": med_r,
        "medianImpliedTna": med_tna,
        "impliedBorrowRate": borrow_r,
        "htbAlert": regime == "HARD_TO_BORROW_SQUEEZE_ALERT",
        "borrowRegime": regime,
        "strikes": strikes_out,
    }


def compute_parity_suite_ref(inp: dict[str, Any]) -> dict[str, Any]:
    spot_mid = float(inp["spotMid"])
    spot_bid = float(inp.get("spotBid") or spot_mid)
    spot_ask = float(inp.get("spotAsk") or spot_mid)
    dte = float(inp["daysToExpiry"])
    q = float(inp["dividendYield"])
    bench_tea = inp.get("benchmarkTeaPct")
    is_blocked = dte < MIN_DTE
    t = dte / DAYS_PER_YEAR
    div_factor = math.exp(-q * t)
    disc_mid = spot_mid * div_factor
    disc_bid = spot_bid * div_factor
    disc_ask = spot_ask * div_factor

    rows: list[dict[str, Any]] = []
    for p in sorted(inp["pairs"], key=lambda x: float(x["strike"])):
        k = float(p["strike"])
        c_bid = p.get("callBid")
        c_ask = p.get("callAsk")
        p_bid = p.get("putBid")
        p_ask = p.get("putAsk")
        c_mid = p.get("callMid") or (0.5 * (c_bid + c_ask) if (c_bid and c_ask) else None)
        p_mid = p.get("putMid") or (0.5 * (p_bid + p_ask) if (p_bid and p_ask) else None)

        cap_mid = disc_mid - (c_mid - p_mid)
        growth = k / cap_mid
        fwd_mid = k + (c_mid - p_mid) * growth
        mid_tea = None if is_blocked else (math.pow(growth, 1.0 / t) - 1.0) * 100.0
        tea_tom = (
            None
            if is_blocked
            else (math.pow(k / (disc_bid - (c_ask - p_bid)), 1.0 / t) - 1.0) * 100.0
        )
        tea_col = (
            None
            if is_blocked
            else (math.pow(k / (disc_ask - (c_bid - p_ask)), 1.0 / t) - 1.0) * 100.0
        )
        rows.append(
            {
                "strike": k,
                "syntheticForwardMid": fwd_mid,
                "midImpliedTeaPct": mid_tea,
                "teaTomadoraPct": tea_tom,
                "teaColocadoraPct": tea_col,
            }
        )

    if is_blocked:
        return {
            "status": "OK",
            "impliedRateStatus": "BLOCKED_SHORT_DTE",
            "daysToExpiry": dte,
            "medianMidTeaPct": None,
            "medianTeaTomadoraPct": None,
            "medianTeaColocadoraPct": None,
            "bestColocadoraStrike": None,
            "bestColocadoraTeaPct": None,
            "bestTomadoraStrike": None,
            "bestTomadoraTeaPct": None,
            "strikes": rows,
        }

    near_atm = sorted(rows, key=lambda r: abs(r["strike"] - spot_mid))[:5]
    med_mid = median_values([r["midImpliedTeaPct"] for r in near_atm])
    med_tom = median_values([r["teaTomadoraPct"] for r in near_atm])
    med_col = median_values([r["teaColocadoraPct"] for r in near_atm])
    best_col_row = max(rows, key=lambda r: r["teaColocadoraPct"])
    best_tom_row = min(rows, key=lambda r: r["teaTomadoraPct"])
    return {
        "status": "OK",
        "impliedRateStatus": "OK",
        "daysToExpiry": dte,
        "medianMidTeaPct": med_mid,
        "medianTeaTomadoraPct": med_tom,
        "medianTeaColocadoraPct": med_col,
        "bestColocadoraStrike": best_col_row["strike"],
        "bestColocadoraTeaPct": best_col_row["teaColocadoraPct"],
        "bestTomadoraStrike": best_tom_row["strike"],
        "bestTomadoraTeaPct": best_tom_row["teaTomadoraPct"],
        "strikes": rows,
    }


def pchip_slopes(xs: list[float], ys: list[float]) -> list[float]:
    m = len(xs)
    h = [xs[i + 1] - xs[i] for i in range(m - 1)]
    delta = [(ys[i + 1] - ys[i]) / h[i] for i in range(m - 1)]
    if m == 2:
        return [delta[0], delta[0]]

    d = [0.0] * m
    d0 = ((2.0 * h[0] + h[1]) * delta[0] - h[0] * delta[1]) / (h[0] + h[1])
    if d0 * delta[0] <= 0.0:
        d0 = 0.0
    elif delta[0] * delta[1] < 0.0 and abs(d0) > 3.0 * abs(delta[0]):
        d0 = 3.0 * delta[0]
    d[0] = d0

    for i in range(1, m - 1):
        if delta[i - 1] * delta[i] <= 0.0:
            d[i] = 0.0
        else:
            w1 = 2.0 * h[i] + h[i - 1]
            w2 = h[i] + 2.0 * h[i - 1]
            d[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i])

    dm1 = ((2.0 * h[-1] + h[-2]) * delta[-1] - h[-1] * delta[-2]) / (h[-1] + h[-2])
    if dm1 * delta[-1] <= 0.0:
        dm1 = 0.0
    elif delta[-1] * delta[-2] < 0.0 and abs(dm1) > 3.0 * abs(delta[-1]):
        dm1 = 3.0 * delta[-1]
    d[-1] = dm1
    return d


def pchip_eval(xs: list[float], ys: list[float], slopes: list[float], x_target: float) -> float:
    if x_target <= xs[0]:
        return ys[0]
    if x_target >= xs[-1]:
        return ys[-1]
    idx = 0
    for i in range(len(xs) - 1):
        if xs[i] <= x_target <= xs[i + 1]:
            idx = i
            break
    h = xs[idx + 1] - xs[idx]
    t = (x_target - xs[idx]) / h
    t2 = t * t
    t3 = t2 * t
    h00 = 2.0 * t3 - 3.0 * t2 + 1.0
    h10 = t3 - 2.0 * t2 + t
    h01 = -2.0 * t3 + 3.0 * t2
    h11 = t3 - t2
    return h00 * ys[idx] + h10 * h * slopes[idx] + h01 * ys[idx + 1] + h11 * h * slopes[idx + 1]


def trapz(xs: list[float], ys: list[float]) -> float:
    area = 0.0
    for i in range(len(xs) - 1):
        area += 0.5 * (ys[i] + ys[i + 1]) * (xs[i + 1] - xs[i])
    return area


def second_divided_diff(nodes: list[dict[str, float]], i0: int, i1: int, i2: int) -> float:
    k0, c0 = nodes[i0]["strike"], nodes[i0]["callPrice"]
    k1, c1 = nodes[i1]["strike"], nodes[i1]["callPrice"]
    k2, c2 = nodes[i2]["strike"], nodes[i2]["callPrice"]
    term0 = c0 / ((k0 - k1) * (k0 - k2))
    term1 = c1 / ((k1 - k0) * (k1 - k2))
    term2 = c2 / ((k2 - k0) * (k2 - k1))
    return 2.0 * (term0 + term1 + term2)


def compute_smoothed_bl_density_ref(inp: dict[str, Any]) -> dict[str, Any]:
    spot = float(inp["spot"])
    rate = float(inp["rate"])
    q = float(inp["dividendYield"])
    t = float(inp["timeToExpiry"])
    grid_steps = int(inp.get("uniformGridSteps", 41))

    liquid_nodes = sorted(
        [
            {"strike": float(n["strike"]), "iv": float(n["iv"])}
            for n in inp["nodes"]
            if n.get("bid") is not None and float(n["bid"]) > 0.0 and float(n["iv"]) > 0.0
        ],
        key=lambda x: x["strike"],
    )

    forward = spot * math.exp((rate - q) * t)
    ks_log = [math.log(n["strike"] / forward) for n in liquid_nodes]
    raw_w = [n["iv"] * n["iv"] * t for n in liquid_nodes]
    m = len(raw_w)
    smooth_w = [
        raw_w[i]
        if (i == 0 or i == m - 1)
        else 0.25 * raw_w[i - 1] + 0.5 * raw_w[i] + 0.25 * raw_w[i + 1]
        for i in range(m)
    ]
    slopes = pchip_slopes(ks_log, smooth_w)

    k_min = liquid_nodes[0]["strike"]
    k_max = liquid_nodes[-1]["strike"]
    step_k = (k_max - k_min) / (grid_steps - 1)

    priced: list[dict[str, float]] = []
    for j in range(grid_steps):
        k_val = k_max if j == grid_steps - 1 else k_min + j * step_k
        w_val = max(1e-8, pchip_eval(ks_log, smooth_w, slopes, math.log(k_val / forward)))
        iv_val = math.sqrt(w_val / t)
        c_val = bsm_call_price(spot, k_val, t, rate, q, iv_val)
        priced.append({"strike": k_val, "iv": iv_val, "callPrice": c_val})

    growth = math.exp(rate * t)
    strikes: list[float] = []
    raw_densities: list[float] = []
    inter: list[dict[str, float]] = []

    for j in range(grid_steps):
        curr = priced[j]
        if j == 0:
            nxt = priced[1]
            dcdk = (nxt["callPrice"] - curr["callPrice"]) / (nxt["strike"] - curr["strike"])
            d2cdk2 = second_divided_diff(priced, 0, 1, 2)
        elif j == grid_steps - 1:
            prv = priced[grid_steps - 2]
            dcdk = (curr["callPrice"] - prv["callPrice"]) / (curr["strike"] - prv["strike"])
            d2cdk2 = second_divided_diff(priced, grid_steps - 3, grid_steps - 2, grid_steps - 1)
        else:
            prv = priced[j - 1]
            nxt = priced[j + 1]
            dcdk = (nxt["callPrice"] - prv["callPrice"]) / (nxt["strike"] - prv["strike"])
            d2cdk2 = second_divided_diff(priced, j - 1, j, j + 1)

        prob_above = clamp_unit(-growth * dcdk)
        raw_q = max(0.0, growth * d2cdk2)
        strikes.append(curr["strike"])
        raw_densities.append(raw_q)
        inter.append(
            {
                "strike": curr["strike"],
                "iv": curr["iv"],
                "callPrice": curr["callPrice"],
                "dCdK": dcdk,
                "d2CdK2": d2cdk2,
                "probAboveQ": prob_above,
                "rawDensityQ": raw_q,
            }
        )

    raw_area = trapz(strikes, raw_densities)
    norm_densities = [d / raw_area for d in raw_densities]
    nodes_out = [
        {**inter[idx], "densityQ": norm_densities[idx]} for idx in range(grid_steps)
    ]

    mean_q = trapz(strikes, [strikes[i] * norm_densities[i] for i in range(grid_steps)])
    var_q = trapz(
        strikes,
        [((strikes[i] - mean_q) ** 2) * norm_densities[i] for i in range(grid_steps)],
    )
    std_q = math.sqrt(var_q)
    mu3 = trapz(
        strikes,
        [((strikes[i] - mean_q) ** 3) * norm_densities[i] for i in range(grid_steps)],
    )
    mu4 = trapz(
        strikes,
        [((strikes[i] - mean_q) ** 4) * norm_densities[i] for i in range(grid_steps)],
    )
    skew_q = mu3 / (std_q**3)
    kurt_q = mu4 / (std_q**4) - 3.0

    return {
        "status": "OK",
        "rawArea": raw_area,
        "normalizedArea": 1.0,
        "meanQ": mean_q,
        "varianceQ": var_q,
        "stdDevQ": std_q,
        "skewnessQ": skew_q,
        "excessKurtosisQ": kurt_q,
        "nodes": nodes_out,
    }


def leg_bid_ask_pct_of_mid(bid: float, ask: float) -> float | None:
    if bid <= 0.0 or ask <= 0.0 or ask < bid:
        return None
    mid = 0.5 * (bid + ask)
    return ((ask - bid) / mid) * 100.0


def classify_semaphore(pct_of_mid: float | None) -> str:
    if pct_of_mid is None or not math.isfinite(pct_of_mid) or pct_of_mid < 0.0:
        return "NO_DATA"
    if pct_of_mid < 5.0:
        return "GREEN"
    if pct_of_mid <= 15.0:
        return "YELLOW"
    return "RED"


def compute_vertical_spread_ref(inp: dict[str, Any]) -> dict[str, Any]:
    side = inp["side"]
    long_leg = inp["longLeg"]
    short_leg = inp["shortLeg"]
    spot = float(inp["spot"])
    dte = float(inp["daysToExpiry"])
    rate_dec = float(inp["rateDec"])
    atm_iv_dec = float(inp["atmIvDec"])
    min_debit = float(inp.get("minDebit", 0.10))
    max_ba_pct = float(inp.get("maxBidAskPctOfMid", 35.0))

    width = abs(float(short_leg["strike"]) - float(long_leg["strike"]))
    long_ba = leg_bid_ask_pct_of_mid(float(long_leg["bid"]), float(long_leg["ask"]))
    short_ba = leg_bid_ask_pct_of_mid(float(short_leg["bid"]), float(short_leg["ask"]))
    ba_pct = (
        0.5 * (long_ba + short_ba)
        if (long_ba is not None and short_ba is not None)
        else None
    )
    sem = classify_semaphore(ba_pct)

    if long_ba is None:
        return {
            "valid": False,
            "eligibleForAutoRanking": False,
            "reason": "LONG_LEG_NO_POSITIVE_BID",
            "width": width,
            "debit": None,
            "maxProfit": None,
            "rewardRiskRatio": None,
            "breakeven": None,
            "breakevenDistPct": None,
            "probAtBreakevenPct": None,
            "edgePct": None,
            "longBidAskPctOfMid": long_ba,
            "shortBidAskPctOfMid": short_ba,
            "bidAskPctOfMid": ba_pct,
            "liquiditySemaphore": sem,
        }
    if short_ba is None:
        return {
            "valid": False,
            "eligibleForAutoRanking": False,
            "reason": "SHORT_LEG_NO_POSITIVE_BID",
            "width": width,
            "debit": None,
            "maxProfit": None,
            "rewardRiskRatio": None,
            "breakeven": None,
            "breakevenDistPct": None,
            "probAtBreakevenPct": None,
            "edgePct": None,
            "longBidAskPctOfMid": long_ba,
            "shortBidAskPctOfMid": short_ba,
            "bidAskPctOfMid": ba_pct,
            "liquiditySemaphore": sem,
        }

    long_px = float(long_leg["ask"])
    short_px = float(short_leg["bid"])
    debit = long_px - short_px
    if debit <= 0.0:
        reason = "DEBIT_NOT_POSITIVE"
    elif debit < min_debit - 1e-12:
        reason = "DEBIT_BELOW_MIN_FLOOR"
    elif debit >= width:
        reason = "DEBIT_NOT_LESS_THAN_WIDTH"
    elif ba_pct is None or ba_pct > max_ba_pct + 1e-9:
        reason = "EXCESSIVE_BID_ASK_SPREAD"
    else:
        reason = None

    if reason is not None:
        return {
            "valid": False,
            "eligibleForAutoRanking": False,
            "reason": reason,
            "width": width,
            "debit": None,
            "maxProfit": None,
            "rewardRiskRatio": None,
            "breakeven": None,
            "breakevenDistPct": None,
            "probAtBreakevenPct": None,
            "edgePct": None,
            "longBidAskPctOfMid": long_ba,
            "shortBidAskPctOfMid": short_ba,
            "bidAskPctOfMid": ba_pct,
            "liquiditySemaphore": sem,
        }

    max_profit = width - debit
    rr = max_profit / debit
    be = float(long_leg["strike"]) + debit if side == "CALL" else float(long_leg["strike"]) - debit
    be_dist = ((be - spot) / spot) * 100.0
    t_exp = dte / DAYS_PER_YEAR
    d2 = (
        math.log(spot / be) + (rate_dec - 0.5 * atm_iv_dec * atm_iv_dec) * t_exp
    ) / (atm_iv_dec * math.sqrt(t_exp))
    prob = norm_cdf(d2) if side == "CALL" else norm_cdf(-d2)
    prob_pct = prob * 100.0
    edge_pct = (prob - debit / width) * 100.0

    return {
        "valid": True,
        "eligibleForAutoRanking": True,
        "reason": None,
        "width": width,
        "debit": debit,
        "maxProfit": max_profit,
        "rewardRiskRatio": rr,
        "breakeven": be,
        "breakevenDistPct": be_dist,
        "probAtBreakevenPct": prob_pct,
        "edgePct": edge_pct,
        "longBidAskPctOfMid": long_ba,
        "shortBidAskPctOfMid": short_ba,
        "bidAskPctOfMid": ba_pct,
        "liquiditySemaphore": sem,
    }


def main() -> None:
    hist_rv_series = [
        13.5, 14.2, 15.0, 15.8, 16.4, 17.1, 18.0, 18.9, 19.5, 20.2,
        21.0, 21.8, 22.5, 23.4, 24.1, 25.0, 26.2, 27.5, 29.0, 32.0,
    ]

    vrp_cases = [
        {
            "name": "qqq_4d_neutral_vrp",
            "input": {
                "expiryCode": "2026-11-23",
                "daysToExpiry": 4,
                "ivAtmActiveExpiryPct": 21.6,
                "sameExpiryFallbackIvAtmPct": 21.8,
                "rvReferencePct": 21.3,
                "rvReferenceLabel": "RV23d",
                "historicalRvSeriesPct": hist_rv_series,
            },
        },
        {
            "name": "spy_30d_high_vrp_sell_premium",
            "input": {
                "expiryCode": "2026-12-19",
                "daysToExpiry": 30,
                "ivAtmActiveExpiryPct": 28.4,
                "sameExpiryFallbackIvAtmPct": 28.0,
                "rvReferencePct": 18.1,
                "rvReferenceLabel": "RV23d",
                "historicalRvSeriesPct": hist_rv_series,
            },
        },
        {
            "name": "nvda_45d_low_rank_buy_convexity",
            "input": {
                "expiryCode": "2027-01-03",
                "daysToExpiry": 45,
                "ivAtmActiveExpiryPct": 15.2,
                "sameExpiryFallbackIvAtmPct": 15.5,
                "rvReferencePct": 20.5,
                "rvReferenceLabel": "RV23d",
                "historicalRvSeriesPct": hist_rv_series,
            },
        },
        {
            "name": "iren_same_expiry_fallback",
            "input": {
                "expiryCode": "2026-11-27",
                "daysToExpiry": 8,
                "ivAtmActiveExpiryPct": None,
                "sameExpiryFallbackIvAtmPct": 24.5,
                "rvReferencePct": 21.0,
                "rvReferenceLabel": "RV23d",
                "historicalRvSeriesPct": hist_rv_series,
            },
        },
        {
            "name": "missing_atm_no_data",
            "input": {
                "expiryCode": "2026-11-27",
                "daysToExpiry": 8,
                "ivAtmActiveExpiryPct": None,
                "sameExpiryFallbackIvAtmPct": None,
                "rvReferencePct": 21.0,
                "rvReferenceLabel": "RV23d",
                "historicalRvSeriesPct": hist_rv_series,
            },
        },
    ]
    for c in vrp_cases:
        c["expected"] = compute_active_expiry_vrp_ref(c["input"])

    dte_gate_synth_cases = [
        {
            "name": "spy_1dte_blocked",
            "input": {
                "spot": 585.0,
                "riskFreeRate": 0.045,
                "dividendYield": 0.0,
                "timeToExpiry": 1.0 / 365.0,
                "dte": 1,
                "pairs": [
                    {"strike": 580.0, "callMid": 5.10, "putMid": 0.37},
                    {"strike": 585.0, "callMid": 1.42, "putMid": 1.69},
                    {"strike": 590.0, "callMid": 0.21, "putMid": 5.48},
                ],
            },
        },
        {
            "name": "qqq_2dte_blocked",
            "input": {
                "spot": 502.0,
                "riskFreeRate": 0.045,
                "dividendYield": 0.0,
                "timeToExpiry": 2.0 / 365.0,
                "dte": 2,
                "pairs": [
                    {"strike": 500.0, "callMid": 3.15, "putMid": 1.54},
                    {"strike": 502.0, "callMid": 1.92, "putMid": 2.31},
                    {"strike": 505.0, "callMid": 0.74, "putMid": 4.13},
                ],
            },
        },
        {
            "name": "spy_5dte_allowed",
            "input": {
                "spot": 585.0,
                "riskFreeRate": 0.045,
                "dividendYield": 0.012,
                "timeToExpiry": 5.0 / 365.0,
                "dte": 5,
                "pairs": [
                    {"strike": 580.0, "callMid": 6.45, "putMid": 1.21},
                    {"strike": 585.0, "callMid": 3.22, "putMid": 2.98},
                    {"strike": 590.0, "callMid": 1.18, "putMid": 5.93},
                ],
            },
        },
    ]
    for c in dte_gate_synth_cases:
        c["expected"] = compute_synthetic_rates_ref(c["input"])

    dte_gate_parity_cases = [
        {
            "name": "qqq_1dte_parity_blocked",
            "input": {
                "spotMid": 502.0,
                "spotBid": 501.95,
                "spotAsk": 502.05,
                "daysToExpiry": 1,
                "dividendYield": 0.0,
                "benchmarkTeaPct": 4.65,
                "pairs": [
                    {
                        "strike": 500.0,
                        "callBid": 3.05,
                        "callAsk": 3.25,
                        "callMid": 3.15,
                        "callIvPct": 22.1,
                        "putBid": 1.45,
                        "putAsk": 1.63,
                        "putMid": 1.54,
                        "putIvPct": 23.0,
                    },
                    {
                        "strike": 502.0,
                        "callBid": 1.85,
                        "callAsk": 1.99,
                        "callMid": 1.92,
                        "callIvPct": 21.5,
                        "putBid": 2.22,
                        "putAsk": 2.40,
                        "putMid": 2.31,
                        "putIvPct": 22.2,
                    },
                ],
            },
        },
        {
            "name": "qqq_5dte_parity_allowed",
            "input": {
                "spotMid": 502.0,
                "spotBid": 501.95,
                "spotAsk": 502.05,
                "daysToExpiry": 5,
                "dividendYield": 0.006,
                "benchmarkTeaPct": 4.65,
                "pairs": [
                    {
                        "strike": 500.0,
                        "callBid": 5.30,
                        "callAsk": 5.42,
                        "callMid": 5.36,
                        "callIvPct": 21.8,
                        "putBid": 3.08,
                        "putAsk": 3.18,
                        "putMid": 3.13,
                        "putIvPct": 22.1,
                    },
                    {
                        "strike": 502.0,
                        "callBid": 4.10,
                        "callAsk": 4.20,
                        "callMid": 4.15,
                        "callIvPct": 21.4,
                        "putBid": 3.88,
                        "putAsk": 3.98,
                        "putMid": 3.93,
                        "putIvPct": 21.6,
                    },
                ],
            },
        },
    ]
    for c in dte_gate_parity_cases:
        c["expected"] = compute_parity_suite_ref(c["input"])

    bl_input = {
        "spot": 580.0,
        "rate": 0.045,
        "dividendYield": 0.012,
        "timeToExpiry": 21.0 / 365.0,
        "uniformGridSteps": 41,
        "nodes": [
            {"strike": 530.0, "iv": 0.285, "bid": 0.0},
            {"strike": 540.0, "iv": 0.248, "bid": 0.85},
            {"strike": 550.0, "iv": 0.231, "bid": 1.45},
            {"strike": 560.0, "iv": 0.219, "bid": 2.60},
            {"strike": 570.0, "iv": 0.204, "bid": 4.70},
            {"strike": 575.0, "iv": 0.209, "bid": 6.10},
            {"strike": 580.0, "iv": 0.196, "bid": 8.20},
            {"strike": 585.0, "iv": 0.193, "bid": 5.80},
            {"strike": 590.0, "iv": 0.189, "bid": 3.75},
            {"strike": 600.0, "iv": 0.186, "bid": 1.55},
            {"strike": 610.0, "iv": 0.188, "bid": 0.62},
            {"strike": 620.0, "iv": 0.240, "bid": None},
        ],
    }
    bl_case = {
        "name": "spy_noisy_smile_pchip_41",
        "input": bl_input,
        "expected": compute_smoothed_bl_density_ref(bl_input),
    }

    vertical_spread_cases = [
        {
            "name": "nvda_liquid_green_spread",
            "input": {
                "side": "CALL",
                "longLeg": {"strike": 140.0, "bid": 4.80, "ask": 4.95, "last": 4.90},
                "shortLeg": {"strike": 145.0, "bid": 2.75, "ask": 2.85, "last": 2.80},
                "spot": 142.0,
                "daysToExpiry": 14,
                "rateDec": 0.045,
                "atmIvDec": 0.42,
            },
        },
        {
            "name": "nvda_yellow_spread",
            "input": {
                "side": "PUT",
                "longLeg": {"strike": 140.0, "bid": 3.20, "ask": 3.50, "last": 3.35},
                "shortLeg": {"strike": 135.0, "bid": 1.60, "ask": 1.80, "last": 1.70},
                "spot": 142.0,
                "daysToExpiry": 14,
                "rateDec": 0.045,
                "atmIvDec": 0.42,
            },
        },
        {
            "name": "nvda_red_spread",
            "input": {
                "side": "CALL",
                "longLeg": {"strike": 150.0, "bid": 1.60, "ask": 2.00, "last": 1.80},
                "shortLeg": {"strike": 155.0, "bid": 0.80, "ask": 1.00, "last": 0.90},
                "spot": 142.0,
                "daysToExpiry": 14,
                "rateDec": 0.045,
                "atmIvDec": 0.42,
            },
        },
        {
            "name": "nvda_deep_otm_penny_rejected",
            "input": {
                "side": "CALL",
                "longLeg": {"strike": 180.0, "bid": 0.01, "ask": 0.02, "last": 0.01},
                "shortLeg": {"strike": 185.0, "bid": 0.01, "ask": 0.01, "last": 0.01},
                "spot": 142.0,
                "daysToExpiry": 14,
                "rateDec": 0.045,
                "atmIvDec": 0.42,
            },
        },
        {
            "name": "nvda_zero_bid_leg_rejected",
            "input": {
                "side": "CALL",
                "longLeg": {"strike": 165.0, "bid": 0.25, "ask": 0.30, "last": 0.28},
                "shortLeg": {"strike": 170.0, "bid": 0.0, "ask": 0.05, "last": 0.03},
                "spot": 142.0,
                "daysToExpiry": 14,
                "rateDec": 0.045,
                "atmIvDec": 0.42,
            },
        },
        {
            "name": "nvda_excessive_bid_ask_rejected",
            "input": {
                "side": "CALL",
                "longLeg": {"strike": 155.0, "bid": 0.60, "ask": 1.10, "last": 0.85},
                "shortLeg": {"strike": 160.0, "bid": 0.30, "ask": 0.50, "last": 0.40},
                "spot": 142.0,
                "daysToExpiry": 14,
                "rateDec": 0.045,
                "atmIvDec": 0.42,
            },
        },
    ]
    for c in vertical_spread_cases:
        c["expected"] = compute_vertical_spread_ref(c["input"])

    currency_sizing_cases = [
        {
            "name": "us_nvda_2500_usd",
            "input": {"market": "US", "premiumPerShare": 2.50, "budget": 2500},
            "expected": {
                "market": "US",
                "currencyCode": "USD",
                "currencyPrefix": "US$",
                "contractMultiplier": 100,
                "budgetPresets": [500, 1000, 2500, 5000, 10000],
                "defaultBudget": 2500,
                "costPerContract": 250.0,
                "maxContractsForBudget": 10,
            },
        },
        {
            "name": "ar_ggal_250000_ars",
            "input": {"market": "AR", "premiumPerShare": 250.0, "budget": 250000},
            "expected": {
                "market": "AR",
                "currencyCode": "ARS",
                "currencyPrefix": "$",
                "contractMultiplier": 100,
                "budgetPresets": [50000, 100000, 250000, 500000],
                "defaultBudget": 250000,
                "costPerContract": 25000.0,
                "maxContractsForBudget": 10,
            },
        },
    ]

    butterfly_cases = [
        {"k1": 140.0, "k2": 145.0, "k3": 150.0, "requireSymmetry": True, "expected": True},
        {"k1": 142.0, "k2": 148.0, "k3": 148.0, "requireSymmetry": False, "expected": False},
        {"k1": 142.0, "k2": 142.0, "k3": 148.0, "requireSymmetry": False, "expected": False},
        {"k1": 150.0, "k2": 145.0, "k3": 140.0, "requireSymmetry": False, "expected": False},
        {"k1": 140.0, "k2": 142.0, "k3": 148.0, "requireSymmetry": True, "expected": False},
    ]

    fixture = {
        "vrpCases": vrp_cases,
        "dteGateSynthCases": dte_gate_synth_cases,
        "dteGateParityCases": dte_gate_parity_cases,
        "smoothedBlDensityCase": bl_case,
        "verticalSpreadCases": vertical_spread_cases,
        "currencySizingCases": currency_sizing_cases,
        "butterflyCases": butterfly_cases,
    }

    out_path = Path(__file__).resolve().parent.parent / "fixtures" / "options_pieza45_reference.json"
    out_path.write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
