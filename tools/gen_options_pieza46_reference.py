"""Independent pure-Python mathematical reference generator for Pieza 46.

Generates `fixtures/options_pieza46_reference.json` using closed-form Python
implementations (BSM, Forward IV, Credit Spreads / Iron Condors over BL density
and analytical lognormal, Catalyst window crossing, What-If T+0/T+n/dIV BSM
valuation, and Dealer GEX + Zero Gamma root finding) completely independent of
the TypeScript production modules.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any


SECONDS_PER_DAY = 86_400
SECONDS_PER_YEAR = 365 * SECONDS_PER_DAY
MIN_WHAT_IF_VOL = 0.005
DEFAULT_MIN_CREDIT = 0.10
DEFAULT_MAX_BA_PCT = 35.0


def norm_cdf(x: float) -> float:
    return 0.5 * math.erfc(-x / math.sqrt(2.0))


def norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def bsm_greeks(
    spot: float,
    strike: float,
    t: float,
    r: float,
    q: float,
    sigma: float,
    contract_type: str,
) -> dict[str, float]:
    if t <= 1e-12:
        intrinsic = max(0.0, spot - strike) if contract_type == "call" else max(0.0, strike - spot)
        if contract_type == "call":
            delta = 1.0 if spot > strike else (0.0 if spot < strike else 0.5)
        else:
            delta = -1.0 if spot < strike else (0.0 if spot > strike else -0.5)
        return {
            "price": intrinsic,
            "delta": delta,
            "gamma": 0.0,
            "thetaDaily": 0.0,
            "vegaPer1Pct": 0.0,
        }

    sqrt_t = math.sqrt(t)
    vol_sqrt_t = sigma * sqrt_t
    d1 = (math.log(spot / strike) + (r - q + 0.5 * sigma * sigma) * t) / vol_sqrt_t
    d2 = d1 - vol_sqrt_t
    df_q = math.exp(-q * t)
    df_r = math.exp(-r * t)
    pdf_d1 = norm_pdf(d1)

    if contract_type == "call":
        price = spot * df_q * norm_cdf(d1) - strike * df_r * norm_cdf(d2)
        delta = df_q * norm_cdf(d1)
        theta_annual = (
            -(spot * df_q * pdf_d1 * sigma) / (2.0 * sqrt_t)
            - r * strike * df_r * norm_cdf(d2)
            + q * spot * df_q * norm_cdf(d1)
        )
    else:
        price = strike * df_r * norm_cdf(-d2) - spot * df_q * norm_cdf(-d1)
        delta = -df_q * norm_cdf(-d1)
        theta_annual = (
            -(spot * df_q * pdf_d1 * sigma) / (2.0 * sqrt_t)
            + r * strike * df_r * norm_cdf(-d2)
            - q * spot * df_q * norm_cdf(-d1)
        )

    gamma = (df_q * pdf_d1) / (spot * vol_sqrt_t)
    vega = spot * df_q * pdf_d1 * sqrt_t
    return {
        "price": price,
        "delta": delta,
        "gamma": gamma,
        "thetaDaily": theta_annual / 365.0,
        "vegaPer1Pct": vega / 100.0,
    }


def compute_forward_iv_case(
    name: str,
    near_t: float,
    near_iv: float,
    far_t: float,
    far_iv: float,
) -> dict[str, Any]:
    if near_t <= 0.0 or far_t <= near_t or near_iv <= 0.0 or far_iv <= 0.0:
        return {
            "name": name,
            "nearTimeToExpiry": near_t,
            "nearIv": near_iv,
            "farTimeToExpiry": far_t,
            "farIv": far_iv,
            "forwardVariance": None,
            "forwardIv": None,
            "calendarArbFlag": False,
            "status": "INVALID",
        }
    f_var = (far_iv * far_iv * far_t - near_iv * near_iv * near_t) / (far_t - near_t)
    if f_var <= 0.0:
        return {
            "name": name,
            "nearTimeToExpiry": near_t,
            "nearIv": near_iv,
            "farTimeToExpiry": far_t,
            "farIv": far_iv,
            "forwardVariance": f_var,
            "forwardIv": None,
            "calendarArbFlag": True,
            "status": "CALENDAR_ARB",
        }
    return {
        "name": name,
        "nearTimeToExpiry": near_t,
        "nearIv": near_iv,
        "farTimeToExpiry": far_t,
        "farIv": far_iv,
        "forwardVariance": f_var,
        "forwardIv": math.sqrt(f_var),
        "calendarArbFlag": False,
        "status": "OK",
    }


def normalize_density(nodes: list[dict[str, float]]) -> list[tuple[float, float]]:
    pts = sorted([(float(n["strike"]), float(n["densityQ"])) for n in nodes], key=lambda p: p[0])
    area = 0.0
    for i in range(len(pts) - 1):
        x0, f0 = pts[i]
        x1, f1 = pts[i + 1]
        area += 0.5 * (f0 + f1) * (x1 - x0)
    return [(x, f / area) for x, f in pts]


def interp_density(norm_pts: list[tuple[float, float]], x: float) -> float:
    if x <= norm_pts[0][0]:
        return norm_pts[0][1] if x == norm_pts[0][0] else 0.0
    if x >= norm_pts[-1][0]:
        return norm_pts[-1][1] if x == norm_pts[-1][0] else 0.0
    for i in range(len(norm_pts) - 1):
        x0, f0 = norm_pts[i]
        x1, f1 = norm_pts[i + 1]
        if x0 <= x <= x1:
            t = (x - x0) / (x1 - x0)
            return f0 + t * (f1 - f0)
    return 0.0


def integrate_bl_pop_ev(
    norm_pts: list[tuple[float, float]],
    legs: list[dict[str, Any]],
    net_credit: float,
    breakevens: list[float],
) -> tuple[float, float]:
    k_lo, k_hi = norm_pts[0][0], norm_pts[-1][0]
    bps = [x for x, _ in norm_pts]
    for lg in legs:
        if k_lo <= lg["strike"] <= k_hi:
            bps.append(lg["strike"])
    for be in breakevens:
        if k_lo + 1e-9 < be < k_hi - 1e-9:
            bps.append(be)
    bps.sort()
    grid: list[float] = []
    for p in bps:
        if not grid or p - grid[-1] > 1e-9:
            grid.append(p)

    def payoff(s_t: float) -> float:
        tot = net_credit
        for lg in legs:
            sgn = 1.0 if lg["side"] == "BUY" else -1.0
            intr = max(0.0, s_t - lg["strike"]) if lg["contractType"] == "call" else max(0.0, lg["strike"] - s_t)
            tot += sgn * lg["quantity"] * intr
        return tot

    pop = 0.0
    ev = 0.0
    for i in range(len(grid) - 1):
        x0, x1 = grid[i], grid[i + 1]
        dx = x1 - x0
        f0 = interp_density(norm_pts, x0)
        f1 = interp_density(norm_pts, x1)
        p0 = payoff(x0)
        p1 = payoff(x1)
        ev += (dx / 6.0) * (2.0 * p0 * f0 + p0 * f1 + p1 * f0 + 2.0 * p1 * f1)
        if 0.5 * (p0 + p1) > 0.0:
            pop += 0.5 * (f0 + f1) * dx
    return max(0.0, min(1.0, pop)), ev


def lognormal_credit_pop_ev(
    spot: float,
    days: float,
    r: float,
    q: float,
    atm_iv: float,
    kind: str,
    legs: list[dict[str, Any]],
    net_credit: float,
    breakevens: list[float],
) -> tuple[float, float]:
    t = days / 365.0
    sig_sqrt_t = atm_iv * math.sqrt(t)
    drift = r - q
    fwd = spot * math.exp(drift * t)

    def d2_at(k: float) -> float:
        return (math.log(spot / k) + (drift - 0.5 * atm_iv * atm_iv) * t) / sig_sqrt_t

    if kind == "BULL_PUT_SPREAD":
        be = breakevens[0]
        pop = norm_cdf(d2_at(be)) if be > 0 else 1.0
    elif kind == "BEAR_CALL_SPREAD":
        pop = norm_cdf(-d2_at(breakevens[0]))
    else:
        be_lo, be_hi = breakevens[0], breakevens[1]
        p_above_lo = norm_cdf(d2_at(be_lo)) if be_lo > 0 else 1.0
        p_above_hi = norm_cdf(d2_at(be_hi))
        pop = max(0.0, min(1.0, p_above_lo - p_above_hi))

    exp_intr = 0.0
    for lg in legs:
        d2 = d2_at(lg["strike"])
        d1 = d2 + sig_sqrt_t
        e_leg = (
            fwd * norm_cdf(d1) - lg["strike"] * norm_cdf(d2)
            if lg["contractType"] == "call"
            else lg["strike"] * norm_cdf(-d2) - fwd * norm_cdf(-d1)
        )
        sgn = 1.0 if lg["side"] == "BUY" else -1.0
        exp_intr += sgn * lg["quantity"] * e_leg
    return max(0.0, min(1.0, pop)), net_credit + exp_intr


def build_credit_reference() -> dict[str, Any]:
    spot = 100.0
    days = 30.0
    t = days / 365.0
    r = 0.05
    q = 0.015
    atm_iv = 0.25
    lot_size = 100.0

    # Synthetic option quotes around spot=100, with two deliberate illiquid traps:
    # - Put K=80 has bid=0.0 (excluded by bid > 0)
    # - Call K=120 has bid/ask width > 35% of mid (excluded by Bid-Ask % del Mid <= 35%)
    # - Call K=115 / K=125 not present, Put K=85/86 tiny credit pair (< $0.10) tested below
    raw_specs = [
        ("put", 80.0, 0.00, 0.12, 0.31),
        ("put", 85.0, 0.26, 0.30, 0.29),
        ("put", 90.0, 0.68, 0.74, 0.275),
        ("put", 95.0, 1.56, 1.64, 0.26),
        ("put", 100.0, 3.30, 3.42, 0.25),
        ("call", 100.0, 3.55, 3.67, 0.25),
        ("call", 105.0, 1.62, 1.70, 0.238),
        ("call", 110.0, 0.60, 0.66, 0.228),
        ("call", 115.0, 0.20, 0.24, 0.22),
        ("call", 120.0, 0.12, 0.26, 0.22),
        # Close cheap pair to verify minCredit >= $0.10 exclusion: Put 86 bid=0.31 ask=0.35 vs Put 85
        ("put", 86.0, 0.31, 0.35, 0.285),
    ]

    contracts = []
    for ctype, k, bid, ask, iv in raw_specs:
        contracts.append(
            {
                "strike": k,
                "contractType": ctype,
                "bid": bid,
                "ask": ask,
                "iv": iv,
            }
        )

    # Smooth lognormal BL-like density grid over [65, 135]
    drift = r - q
    mean_ln = math.log(spot) + (drift - 0.5 * atm_iv * atm_iv) * t
    sig_t = atm_iv * math.sqrt(t)
    density_nodes = []
    for step in range(29):
        k_val = 65.0 + step * 2.5
        z = (math.log(k_val) - mean_ln) / sig_t
        pdf_q = norm_pdf(z) / (k_val * sig_t)
        density_nodes.append({"strike": k_val, "densityQ": pdf_q})
    norm_pts = normalize_density(density_nodes)

    by_key = {(c["contractType"], c["strike"]): c for c in contracts}

    def eval_credit_candidate(
        cid: str,
        kind: str,
        width: float,
        leg_specs: list[tuple[str, float, str]],
        use_bl: bool,
    ) -> dict[str, Any]:
        net_credit = 0.0
        net_theta = 0.0
        net_vega = 0.0
        legs_data = []
        for ctype, strike, side in leg_specs:
            q_row = by_key[(ctype, strike)]
            exec_px = q_row["bid"] if side == "SELL" else q_row["ask"]
            mid = 0.5 * (q_row["bid"] + q_row["ask"])
            ba_pct = ((q_row["ask"] - q_row["bid"]) / mid) * 100.0
            sgn = 1.0 if side == "BUY" else -1.0
            net_credit += -sgn * exec_px
            g = bsm_greeks(spot, strike, t, r, q, q_row["iv"], ctype)
            net_theta += sgn * g["thetaDaily"]
            net_vega += sgn * g["vegaPer1Pct"]
            legs_data.append(
                {
                    "strike": strike,
                    "contractType": ctype,
                    "side": side,
                    "quantity": 1,
                    "bid": q_row["bid"],
                    "ask": q_row["ask"],
                    "executionPrice": exec_px,
                    "bidAskPctOfMid": ba_pct,
                }
            )
        if kind == "BULL_PUT_SPREAD":
            short_k = [l["strike"] for l in legs_data if l["side"] == "SELL"][0]
            breakevens = [short_k - net_credit]
        elif kind == "BEAR_CALL_SPREAD":
            short_k = [l["strike"] for l in legs_data if l["side"] == "SELL"][0]
            breakevens = [short_k + net_credit]
        else:
            short_put_k = [l["strike"] for l in legs_data if l["side"] == "SELL" and l["contractType"] == "put"][0]
            short_call_k = [l["strike"] for l in legs_data if l["side"] == "SELL" and l["contractType"] == "call"][0]
            breakevens = [short_put_k - net_credit, short_call_k + net_credit]

        max_loss = width - net_credit
        credit_pct = (net_credit / width) * 100.0
        abs_tv = abs(net_theta / net_vega) if abs(net_vega) > 1e-12 else None

        if use_bl:
            pop, ev = integrate_bl_pop_ev(norm_pts, legs_data, net_credit, breakevens)
        else:
            pop, ev = lognormal_credit_pop_ev(spot, days, r, q, atm_iv, kind, legs_data, net_credit, breakevens)

        tv_term = min(abs_tv, 2.0) / 2.0 if abs_tv is not None else 0.0
        comp_score = (
            0.35 * (net_credit / width)
            + 0.30 * pop
            + 0.25 * max(-1.0, min(1.0, ev / max_loss))
            + 0.10 * tv_term
        )
        avg_ba = sum(l["bidAskPctOfMid"] for l in legs_data) / len(legs_data)
        return {
            "id": cid,
            "kind": kind,
            "widthPerShare": width,
            "netCreditPerShare": net_credit,
            "creditPctOfWidth": credit_pct,
            "maxProfitContract": net_credit * lot_size,
            "maxLossPerShare": max_loss,
            "maxLossContract": max_loss * lot_size,
            "breakevens": breakevens,
            "pop": pop,
            "expectedValuePerShare": ev,
            "expectedValueContract": ev * lot_size,
            "netThetaDaily": net_theta,
            "netVegaPer1Pct": net_vega,
            "absThetaToVegaRatio": abs_tv,
            "bidAskPctOfMid": avg_ba,
            "compositeScore": comp_score,
        }

    targets = [
        ("BULL_PUT_90_95", "BULL_PUT_SPREAD", 5.0, [("put", 90.0, "BUY"), ("put", 95.0, "SELL")]),
        ("BEAR_CALL_105_110", "BEAR_CALL_SPREAD", 5.0, [("call", 105.0, "SELL"), ("call", 110.0, "BUY")]),
        (
            "IRON_CONDOR_90_95_105_110",
            "IRON_CONDOR",
            5.0,
            [("put", 90.0, "BUY"), ("put", 95.0, "SELL"), ("call", 105.0, "SELL"), ("call", 110.0, "BUY")],
        ),
    ]

    return {
        "inputs": {
            "spot": spot,
            "daysToExpiry": days,
            "rate": r,
            "dividendYield": q,
            "atmIv": atm_iv,
            "lotSize": lot_size,
            "contracts": contracts,
            "densityNodes": density_nodes,
        },
        "blExpected": [eval_credit_candidate(cid, knd, w, lg, True) for cid, knd, w, lg in targets],
        "lognormalExpected": [eval_credit_candidate(cid, knd, w, lg, False) for cid, knd, w, lg in targets],
        "excludedIds": [
            "BULL_PUT_80_85",   # Put 80 bid=0 -> excluded
            "BEAR_CALL_115_120", # Call 120 bid-ask% = 73.68% > 35% -> excluded
            "BULL_PUT_85_86",   # net credit = 0.31 - 0.30 = 0.01 < 0.10 -> excluded
        ],
    }


def evaluate_what_if_case(
    name: str,
    spot: float,
    eval_spot: float,
    r: float,
    q: float,
    legs: list[dict[str, Any]],
    iv_shift_pts: float,
    elapsed_days: float,
    horizon_dte: float,
    contracts: float = 1.0,
    multiplier: float = 100.0,
) -> dict[str, Any]:
    scale = contracts * multiplier
    net_entry = sum(lg["quantity"] * lg["entryPrice"] for lg in legs)
    elapsed_tn = min(max(elapsed_days, 0.0), horizon_dte) / 365.0
    elapsed_exp = horizon_dte / 365.0
    shift_dec = iv_shift_pts / 100.0

    def eval_portfolio(s: float, el_t: float, dv: float) -> dict[str, float]:
        val = 0.0
        d_u = 0.0
        g_u = 0.0
        th_u = 0.0
        vg_u = 0.0
        for lg in legs:
            rem_t = max(0.0, lg["timeToExpiry"] - el_t)
            eff_iv = max(MIN_WHAT_IF_VOL, lg["iv"] + dv)
            res = bsm_greeks(s, lg["strike"], rem_t, r, q, eff_iv, lg["contractType"])
            qty = lg["quantity"]
            val += qty * res["price"]
            d_u += qty * res["delta"]
            g_u += qty * res["gamma"]
            th_u += qty * res["thetaDaily"]
            vg_u += qty * res["vegaPer1Pct"]
        return {
            "valuePerUnit": val,
            "pnlUsd": (val - net_entry) * scale,
            "deltaPerUnit": d_u,
            "gammaPerUnit": g_u,
            "thetaDailyPerUnit": th_u,
            "vegaPer1PctPerUnit": vg_u,
            "deltaShares": d_u * scale,
            "gammaShares": g_u * scale,
            "thetaDailyUsd": th_u * scale,
            "vegaPer1PctUsd": vg_u * scale,
        }

    s_t0 = eval_portfolio(eval_spot, 0.0, 0.0)
    s_tn_zero = eval_portfolio(eval_spot, elapsed_tn, 0.0)
    s_tn_shift = eval_portfolio(eval_spot, elapsed_tn, shift_dec)
    s_exp = eval_portfolio(eval_spot, elapsed_exp, shift_dec)

    return {
        "name": name,
        "input": {
            "spot": spot,
            "evalSpot": eval_spot,
            "rate": r,
            "dividendYield": q,
            "legs": legs,
            "ivShiftPts": iv_shift_pts,
            "elapsedDays": elapsed_days,
            "horizonDte": horizon_dte,
            "contracts": contracts,
            "contractMultiplier": multiplier,
        },
        "expected": {
            "pnlT0": s_t0["pnlUsd"],
            "pnlTn": s_tn_shift["pnlUsd"],
            "pnlExpiry": s_exp["pnlUsd"],
            "pnlTnZeroIvShift": s_tn_zero["pnlUsd"],
            "ivShockPnlAttribution": s_tn_shift["pnlUsd"] - s_tn_zero["pnlUsd"],
            "timeDecayPnlAttribution": s_tn_zero["pnlUsd"] - s_t0["pnlUsd"],
            "valuePerUnitT0": s_t0["valuePerUnit"],
            "valuePerUnitTn": s_tn_shift["valuePerUnit"],
            "valuePerUnitExpiry": s_exp["valuePerUnit"],
            "greeksTn": {
                "deltaPerUnit": s_tn_shift["deltaPerUnit"],
                "gammaPerUnit": s_tn_shift["gammaPerUnit"],
                "thetaDailyPerUnit": s_tn_shift["thetaDailyPerUnit"],
                "vegaPer1PctPerUnit": s_tn_shift["vegaPer1PctPerUnit"],
                "deltaShares": s_tn_shift["deltaShares"],
                "gammaShares": s_tn_shift["gammaShares"],
                "thetaDailyUsd": s_tn_shift["thetaDailyUsd"],
                "vegaPer1PctUsd": s_tn_shift["vegaPer1PctUsd"],
            },
        },
    }


def build_what_if_cases() -> list[dict[str, Any]]:
    spot = 100.0
    r = 0.05
    q = 0.01

    def bsm_px(k: float, days: float, iv: float, ctype: str) -> float:
        return bsm_greeks(spot, k, days / 365.0, r, q, iv, ctype)["price"]

    cases = [
        evaluate_what_if_case(
            name="bull_call_iv_crush_spot_103",
            spot=spot,
            eval_spot=103.0,
            r=r,
            q=q,
            legs=[
                {"contractType": "call", "strike": 95.0, "quantity": 1, "iv": 0.28, "timeToExpiry": 30 / 365.0, "entryPrice": bsm_px(95.0, 30.0, 0.28, "call")},
                {"contractType": "call", "strike": 105.0, "quantity": -1, "iv": 0.25, "timeToExpiry": 30 / 365.0, "entryPrice": bsm_px(105.0, 30.0, 0.25, "call")},
            ],
            iv_shift_pts=-15.0,
            elapsed_days=10.0,
            horizon_dte=30.0,
        ),
        evaluate_what_if_case(
            name="bull_put_iv_crush_spot_100",
            spot=spot,
            eval_spot=100.0,
            r=r,
            q=q,
            legs=[
                {"contractType": "put", "strike": 90.0, "quantity": 1, "iv": 0.30, "timeToExpiry": 30 / 365.0, "entryPrice": bsm_px(90.0, 30.0, 0.30, "put")},
                {"contractType": "put", "strike": 95.0, "quantity": -1, "iv": 0.27, "timeToExpiry": 30 / 365.0, "entryPrice": bsm_px(95.0, 30.0, 0.27, "put")},
            ],
            iv_shift_pts=-15.0,
            elapsed_days=12.0,
            horizon_dte=30.0,
        ),
        evaluate_what_if_case(
            name="iron_condor_iv_crush_spot_100",
            spot=spot,
            eval_spot=100.0,
            r=r,
            q=q,
            legs=[
                {"contractType": "put", "strike": 85.0, "quantity": 1, "iv": 0.32, "timeToExpiry": 30 / 365.0, "entryPrice": bsm_px(85.0, 30.0, 0.32, "put")},
                {"contractType": "put", "strike": 90.0, "quantity": -1, "iv": 0.29, "timeToExpiry": 30 / 365.0, "entryPrice": bsm_px(90.0, 30.0, 0.29, "put")},
                {"contractType": "call", "strike": 110.0, "quantity": -1, "iv": 0.24, "timeToExpiry": 30 / 365.0, "entryPrice": bsm_px(110.0, 30.0, 0.24, "call")},
                {"contractType": "call", "strike": 115.0, "quantity": 1, "iv": 0.23, "timeToExpiry": 30 / 365.0, "entryPrice": bsm_px(115.0, 30.0, 0.23, "call")},
            ],
            iv_shift_pts=-15.0,
            elapsed_days=10.0,
            horizon_dte=30.0,
        ),
        evaluate_what_if_case(
            name="butterfly_iv_crush_spot_100",
            spot=spot,
            eval_spot=100.0,
            r=r,
            q=q,
            legs=[
                {"contractType": "call", "strike": 95.0, "quantity": 1, "iv": 0.26, "timeToExpiry": 30 / 365.0, "entryPrice": bsm_px(95.0, 30.0, 0.26, "call")},
                {"contractType": "call", "strike": 100.0, "quantity": -2, "iv": 0.25, "timeToExpiry": 30 / 365.0, "entryPrice": bsm_px(100.0, 30.0, 0.25, "call")},
                {"contractType": "call", "strike": 105.0, "quantity": 1, "iv": 0.24, "timeToExpiry": 30 / 365.0, "entryPrice": bsm_px(105.0, 30.0, 0.24, "call")},
            ],
            iv_shift_pts=-15.0,
            elapsed_days=15.0,
            horizon_dte=30.0,
        ),
        evaluate_what_if_case(
            name="calendar_spread_20d_50d_iv_crush",
            spot=spot,
            eval_spot=100.0,
            r=r,
            q=q,
            legs=[
                {"contractType": "call", "strike": 100.0, "quantity": -1, "iv": 0.30, "timeToExpiry": 20 / 365.0, "entryPrice": bsm_px(100.0, 20.0, 0.30, "call")},
                {"contractType": "call", "strike": 100.0, "quantity": 1, "iv": 0.27, "timeToExpiry": 50 / 365.0, "entryPrice": bsm_px(100.0, 50.0, 0.27, "call")},
            ],
            iv_shift_pts=-15.0,
            elapsed_days=10.0,
            horizon_dte=20.0,
        ),
    ]
    return cases


def build_gex_case(
    name: str,
    spot: float,
    now_sec: int,
    rate: float,
    q: float,
    contracts: list[dict[str, Any]],
) -> dict[str, Any]:
    by_strike: dict[float, dict[str, float]] = {}
    usable = []
    usable_oi = 0.0
    call_gex_total = 0.0
    put_gex_total = 0.0

    for c in contracts:
        k = float(c["strike"])
        oi = float(c["openInterest"])
        if oi <= 0:
            continue
        usable_oi += oi
        t = (c["expiryUtcSec"] - now_sec) / SECONDS_PER_YEAR
        g = bsm_greeks(spot, k, t, rate, q, c["iv"], c["contractType"])
        sgn = 1.0 if c["contractType"] == "call" else -1.0
        dgex = sgn * oi * c["sharesPerContract"] * g["gamma"] * spot * spot * 0.01
        if c["contractType"] == "call":
            call_gex_total += dgex
        else:
            put_gex_total += dgex
        usable.append((c, t, sgn))
        row = by_strike.setdefault(k, {"callGex": 0.0, "putGex": 0.0, "callOi": 0.0, "putOi": 0.0})
        if c["contractType"] == "call":
            row["callGex"] += dgex
            row["callOi"] += oi
        else:
            row["putGex"] += dgex
            row["putOi"] += oi

    net_gex = call_gex_total + put_gex_total

    # Call/Put wall by |GEX|
    call_wall = None
    best_cw = 0.0
    put_wall = None
    best_pw = 0.0
    for k, row in sorted(by_strike.items()):
        if row["callOi"] > 0 and abs(row["callGex"]) > best_cw:
            best_cw = abs(row["callGex"])
            call_wall = k
        if row["putOi"] > 0 and abs(row["putGex"]) > best_pw:
            best_pw = abs(row["putGex"])
            put_wall = k

    def net_gex_at(s_cand: float) -> float:
        tot = 0.0
        for c, t, sgn in usable:
            g = bsm_greeks(s_cand, c["strike"], t, rate, q, c["iv"], c["contractType"])
            tot += sgn * c["openInterest"] * c["sharesPerContract"] * g["gamma"] * s_cand * s_cand * 0.01
        return tot

    # Zero Gamma crossing over [0.75 * spot, 1.25 * spot]
    s_lo = spot * 0.75
    s_hi = spot * 1.25
    steps = 200
    roots: list[float] = []
    prev_s = s_lo
    prev_v = net_gex_at(prev_s)
    for i in range(1, steps + 1):
        cur_s = s_lo + ((s_hi - s_lo) * i) / steps
        cur_v = net_gex_at(cur_s)
        if prev_v == 0.0:
            roots.append(prev_s)
        elif (prev_v < 0.0 < cur_v) or (prev_v > 0.0 > cur_v):
            a, b, fa = prev_s, cur_s, prev_v
            for _ in range(100):
                m = 0.5 * (a + b)
                fm = net_gex_at(m)
                if abs(b - a) <= 1e-12 * spot or abs(fm) <= 1e-12:
                    a = b = m
                    break
                if (fa < 0.0 < fm) or (fa > 0.0 > fm):
                    b = m
                else:
                    a, fa = m, fm
            roots.append(0.5 * (a + b))
        prev_s, prev_v = cur_s, cur_v

    has_sufficient_oi = len(usable) >= 2 and usable_oi >= 10.0
    zero_gamma = roots[0] if (has_sufficient_oi and len(roots) == 1) else None
    regime = (
        "NO_DATA"
        if not has_sufficient_oi
        else ("LONG_GAMMA" if net_gex > 1e-9 else ("SHORT_GAMMA" if net_gex < -1e-9 else "NEUTRAL"))
    )

    return {
        "name": name,
        "spot": spot,
        "nowUtcSec": now_sec,
        "rate": rate,
        "dividendYield": q,
        "contracts": contracts,
        "expected": {
            "regime": regime,
            "hasSufficientOi": has_sufficient_oi,
            "callGex": call_gex_total,
            "putGex": put_gex_total,
            "netGex": net_gex,
            "callWallStrike": call_wall if has_sufficient_oi else None,
            "putWallStrike": put_wall if has_sufficient_oi else None,
            "zeroGammaSpot": zero_gamma,
        },
    }


def main() -> None:
    now_sec = 1_770_000_000  # fixed deterministic UTC timestamp
    exp_sec = now_sec + 30 * SECONDS_PER_DAY

    fixture = {
        "meta": {
            "generator": "tools/gen_options_pieza46_reference.py",
            "tolerance": 1e-9,
        },
        "creditSpreadsAndIronCondors": build_credit_reference(),
        "forwardVolatility": [
            compute_forward_iv_case("contango_normal", 30.0 / 365.0, 0.22, 60.0 / 365.0, 0.25),
            compute_forward_iv_case("backwardation_no_arb", 30.0 / 365.0, 0.28, 90.0 / 365.0, 0.24),
            compute_forward_iv_case("calendar_arb_negative", 30.0 / 365.0, 0.35, 60.0 / 365.0, 0.22),
            compute_forward_iv_case("calendar_arb_zero_boundary", 25.0 / 365.0, 0.30, 100.0 / 365.0, 0.15),
        ],
        "catalysts": {
            "asOfUtcSec": now_sec,
            "expiryInside7dUtcSec": now_sec + 7 * SECONDS_PER_DAY,
            "earningsInside3dUtcSec": now_sec + 3 * SECONDS_PER_DAY,
            "fomcInside2dUtcSec": now_sec + 2 * SECONDS_PER_DAY,
            "lastEarnings3dAgoUtcSec": now_sec - 3 * SECONDS_PER_DAY,
            "earningsOutside45dUtcSec": now_sec + 45 * SECONDS_PER_DAY,
        },
        "whatIfPayoff": build_what_if_cases(),
        "dealerExposure": [
            build_gex_case(
                name="long_gamma_with_zero_gamma_flip",
                spot=100.0,
                now_sec=now_sec,
                rate=0.05,
                q=0.01,
                contracts=[
                    {"contractType": "call", "strike": 105.0, "expiryUtcSec": exp_sec, "openInterest": 7000, "sharesPerContract": 100, "iv": 0.22},
                    {"contractType": "call", "strike": 110.0, "expiryUtcSec": exp_sec, "openInterest": 9000, "sharesPerContract": 100, "iv": 0.21},
                    {"contractType": "put", "strike": 90.0, "expiryUtcSec": exp_sec, "openInterest": 4500, "sharesPerContract": 100, "iv": 0.27},
                    {"contractType": "put", "strike": 85.0, "expiryUtcSec": exp_sec, "openInterest": 2500, "sharesPerContract": 100, "iv": 0.29},
                ],
            ),
            build_gex_case(
                name="short_gamma_with_zero_gamma_flip",
                spot=100.0,
                now_sec=now_sec,
                rate=0.05,
                q=0.01,
                contracts=[
                    {"contractType": "call", "strike": 112.0, "expiryUtcSec": exp_sec, "openInterest": 4000, "sharesPerContract": 100, "iv": 0.22},
                    {"contractType": "put", "strike": 98.0, "expiryUtcSec": exp_sec, "openInterest": 9500, "sharesPerContract": 100, "iv": 0.25},
                    {"contractType": "put", "strike": 92.0, "expiryUtcSec": exp_sec, "openInterest": 3000, "sharesPerContract": 100, "iv": 0.27},
                ],
            ),
            build_gex_case(
                name="insufficient_oi_honest_no_data",
                spot=100.0,
                now_sec=now_sec,
                rate=0.05,
                q=0.01,
                contracts=[
                    {"contractType": "call", "strike": 105.0, "expiryUtcSec": exp_sec, "openInterest": 3, "sharesPerContract": 100, "iv": 0.24},
                    {"contractType": "put", "strike": 95.0, "expiryUtcSec": exp_sec, "openInterest": 2, "sharesPerContract": 100, "iv": 0.25},
                ],
            ),
        ],
    }

    out_path = Path(__file__).resolve().parent.parent / "fixtures" / "options_pieza46_reference.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
