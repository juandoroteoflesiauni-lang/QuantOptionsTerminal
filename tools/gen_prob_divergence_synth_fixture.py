#!/usr/bin/env python3
"""Independent Python reference generator for Pieza 17
(Probabilistic Divergence P vs. Q, Fat-Tail Overnight/RTH, Vol Cone,
Synthetic Implied Rates, Borrow Regime, Conversion/Reversal, Buy-Write & Calendar Rolls).

Writes: fixtures/prob_divergence_synth_reference.json
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

DAYS_PER_YEAR = 365.0
AS_OF_UTC_SEC = 1_746_000_000


def norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def bsm_call(spot: float, strike: float, tau: float, rate: float, div_y: float, vol: float) -> float:
    sqrt_t = math.sqrt(tau)
    vol_sqrt_t = vol * sqrt_t
    d1 = (math.log(spot / strike) + (rate - div_y + 0.5 * vol * vol) * tau) / vol_sqrt_t
    d2 = d1 - vol_sqrt_t
    return spot * math.exp(-div_y * tau) * norm_cdf(d1) - strike * math.exp(-rate * tau) * norm_cdf(d2)


def trapz(xs: list[float], ys: list[float]) -> float:
    total = 0.0
    for i in range(len(xs) - 1):
        total += 0.5 * (ys[i] + ys[i + 1]) * (xs[i + 1] - xs[i])
    return total


def extract_q_reference(
    spot: float,
    rate: float,
    div_y: float,
    tau: float,
    input_nodes: list[dict[str, float]],
) -> dict[str, Any]:
    ordered = sorted(input_nodes, key=lambda n: n["strike"])
    m = len(ordered)
    priced = [
        {
            "strike": n["strike"],
            "iv": n["iv"],
            "callPrice": bsm_call(spot, n["strike"], tau, rate, div_y, n["iv"]),
        }
        for n in ordered
    ]

    growth = math.exp(rate * tau)
    ks: list[float] = []
    raw_densities: list[float] = []
    out_nodes: list[dict[str, float]] = []

    def d2(a: int, b: int, c: int) -> float:
        ka, kb, kc = priced[a]["strike"], priced[b]["strike"], priced[c]["strike"]
        ca, cb, cc = priced[a]["callPrice"], priced[b]["callPrice"], priced[c]["callPrice"]
        return 2.0 * (((cc - cb) / (kc - kb)) - ((cb - ca) / (kb - ka))) / (kc - ka)

    for j in range(m):
        kj = priced[j]["strike"]
        cj = priced[j]["callPrice"]
        if j == 0:
            d1 = (priced[1]["callPrice"] - cj) / (priced[1]["strike"] - kj)
            sec = d2(0, 1, 2)
        elif j == m - 1:
            d1 = (cj - priced[m - 2]["callPrice"]) / (kj - priced[m - 2]["strike"])
            sec = d2(m - 3, m - 2, m - 1)
        else:
            d1 = (priced[j + 1]["callPrice"] - priced[j - 1]["callPrice"]) / (
                priced[j + 1]["strike"] - priced[j - 1]["strike"]
            )
            sec = d2(j - 1, j, j + 1)

        prob_above_q = min(1.0, max(0.0, -growth * d1))
        raw_dens = max(0.0, growth * sec)
        ks.append(kj)
        raw_densities.append(raw_dens)
        out_nodes.append(
            {
                "strike": kj,
                "iv": priced[j]["iv"],
                "callPrice": cj,
                "dCdK": d1,
                "d2CdK2": sec,
                "probAboveQ": prob_above_q,
                "rawDensityQ": raw_dens,
            }
        )

    raw_area = trapz(ks, raw_densities)
    densities = [d / raw_area for d in raw_densities]
    for idx, dens in enumerate(densities):
        out_nodes[idx]["densityQ"] = dens

    mean_q = trapz(ks, [k * f for k, f in zip(ks, densities)])
    var_q = trapz(ks, [((k - mean_q) ** 2) * f for k, f in zip(ks, densities)])
    std_q = math.sqrt(max(0.0, var_q))
    mu3 = trapz(ks, [((k - mean_q) ** 3) * f for k, f in zip(ks, densities)])
    mu4 = trapz(ks, [((k - mean_q) ** 4) * f for k, f in zip(ks, densities)])
    skew_q = mu3 / (std_q ** 3)
    ex_kurt_q = mu4 / (std_q ** 4) - 3.0

    return {
        "status": "OK",
        "rawArea": raw_area,
        "normalizedArea": 1.0,
        "meanQ": mean_q,
        "varianceQ": var_q,
        "stdDevQ": std_q,
        "skewnessQ": skew_q,
        "excessKurtosisQ": ex_kurt_q,
        "nodes": out_nodes,
    }


def sample_stats(vals: list[float]) -> tuple[float, float, float, float, float]:
    n = len(vals)
    mean = sum(vals) / n
    sq = sum((v - mean) ** 2 for v in vals)
    cb = sum((v - mean) ** 3 for v in vals)
    qd = sum((v - mean) ** 4 for v in vals)
    return mean, sq / (n - 1), sq / n, cb / n, qd / n


def analyze_p_reference(
    bars: list[dict[str, float]],
    as_of_utc_sec: int,
    spot: float,
    horizon_days: int,
    daily_rf: float = 0.0,
    min_history_bars: int = 30,
    tail_sigma: float = 3.0,
) -> dict[str, Any]:
    filtered = sorted(
        [b for b in bars if b["time"] <= as_of_utc_sec and b["open"] > 0 and b["close"] > 0],
        key=lambda b: b["time"],
    )
    n = len(filtered)
    h_returns: list[float] = []
    terminal_prices: list[float] = []
    for i in range(n - horizon_days):
        rh = math.log(filtered[i + horizon_days]["close"] / filtered[i]["close"]) - horizon_days * daily_rf
        h_returns.append(rh)
        terminal_prices.append(spot * math.exp(rh))

    mean_h, svar_h, m2, m3, m4 = sample_stats(h_returns)
    std_h = math.sqrt(svar_h)
    skew = m3 / (m2 ** 1.5)
    kurt = m4 / (m2 ** 2) - 3.0

    on_rets: list[float] = []
    rth_rets: list[float] = []
    tot_rets: list[float] = []
    times: list[int] = []
    for t in range(1, n):
        r_on = math.log(filtered[t]["open"] / filtered[t - 1]["close"]) - daily_rf
        r_rth = math.log(filtered[t]["close"] / filtered[t]["open"])
        on_rets.append(r_on)
        rth_rets.append(r_rth)
        tot_rets.append(r_on + r_rth)
        times.append(int(filtered[t]["time"]))

    _, on_var, _, _, _ = sample_stats(on_rets)
    _, rth_var, _, _, _ = sample_stats(rth_rets)
    tot_mean, tot_var, _, _, _ = sample_stats(tot_rets)
    tot_std = math.sqrt(tot_var)
    v_sum = on_var + rth_var

    tail_events: list[dict[str, Any]] = []
    for idx in range(len(tot_rets)):
        z = (tot_rets[idx] - tot_mean) / tot_std
        if abs(z) > tail_sigma:
            denom = abs(on_rets[idx]) + abs(rth_rets[idx])
            share = abs(on_rets[idx]) / denom if denom > 0 else 0.0
            tail_events.append(
                {
                    "time": times[idx],
                    "totalReturn": tot_rets[idx],
                    "zScore": z,
                    "overnightReturn": on_rets[idx],
                    "rthReturn": rth_rets[idx],
                    "overnightShare": share,
                }
            )

    tail_count = len(tail_events)
    on_tail_share = (
        sum(ev["overnightShare"] for ev in tail_events) / tail_count if tail_count > 0 else None
    )

    return {
        "status": "OK",
        "usedBarsCount": n,
        "horizonSamplesCount": len(h_returns),
        "meanLogReturn": mean_h,
        "stdDevLogReturn": std_h,
        "skewness": skew,
        "excessKurtosis": kurt,
        "overnightVariance": on_var,
        "rthVariance": rth_var,
        "overnightVarianceShare": on_var / v_sum,
        "rthVarianceShare": rth_var / v_sum,
        "tailEventsCount": tail_count,
        "tailFrequencyPct": (tail_count / len(tot_rets)) * 100.0,
        "overnightTailContributionShare": on_tail_share,
        "horizonLogReturns": h_returns,
        "projectedTerminalPrices": terminal_prices,
        "tailEvents": tail_events,
    }


def eval_pq_divergence_reference(
    spot: float,
    q_res: dict[str, Any],
    p_res: dict[str, Any],
    targets: list[dict[str, Any]],
    min_edge: float = 0.05,
) -> dict[str, Any]:
    q_nodes = q_res["nodes"]
    term_prices = p_res["projectedTerminalPrices"]
    m_samples = len(term_prices)

    def interp_prob_above(p: float) -> float | None:
        if p < q_nodes[0]["strike"] or p > q_nodes[-1]["strike"]:
            return None
        for i in range(len(q_nodes) - 1):
            k0, k1 = q_nodes[i]["strike"], q_nodes[i + 1]["strike"]
            if k0 <= p <= k1:
                w = (p - k0) / (k1 - k0)
                return (1.0 - w) * q_nodes[i]["probAboveQ"] + w * q_nodes[i + 1]["probAboveQ"]
        return None

    levels: list[dict[str, Any]] = []
    for tgt in targets:
        price = float(tgt["price"])
        direction = tgt.get("direction") or ("ABOVE" if price >= spot else "BELOW")
        pq_above = interp_prob_above(price)
        if pq_above is None:
            levels.append(
                {
                    "label": tgt["label"],
                    "price": price,
                    "direction": direction,
                    "probP": None,
                    "probQ": None,
                    "pqSpread": None,
                    "pqRatio": None,
                    "classification": "NO_DATA",
                }
            )
            continue
        prob_q = pq_above if direction == "ABOVE" else max(0.0, min(1.0, 1.0 - pq_above))
        hits = sum(1 for st in term_prices if (st >= price if direction == "ABOVE" else st <= price))
        prob_p = hits / m_samples
        spread = prob_p - prob_q
        ratio = prob_p / prob_q if prob_q > 1e-9 else None
        if spread >= min_edge:
            cls = "POSITIVE_EV_LONG_CONVEXITY"
        elif spread <= -min_edge:
            cls = "OVERPRICED_PREMIUM_SHORT_EDGE"
        else:
            cls = "FAIRLY_PRICED"
        levels.append(
            {
                "label": tgt["label"],
                "price": price,
                "direction": direction,
                "probP": prob_p,
                "probQ": prob_q,
                "pqSpread": spread,
                "pqRatio": ratio,
                "classification": cls,
            }
        )

    return {"status": "OK", "levels": levels}


def cone_and_rank_reference(
    spot: float,
    iv_atm: float,
    horizons: list[int],
    iv_history: list[float],
) -> dict[str, Any]:
    cones = []
    for d in horizons:
        sig_tau = iv_atm * math.sqrt(d / DAYS_PER_YEAR)
        cones.append(
            {
                "horizonDays": d,
                "sigmaMovePct": sig_tau * 100.0,
                "upper1Sigma": spot * math.exp(sig_tau),
                "lower1Sigma": spot * math.exp(-sig_tau),
                "upper2Sigma": spot * math.exp(2.0 * sig_tau),
                "lower2Sigma": spot * math.exp(-2.0 * sig_tau),
            }
        )
    iv_min = min(iv_history)
    iv_max = max(iv_history)
    iv_rank = ((iv_atm - iv_min) / (iv_max - iv_min)) * 100.0
    iv_pct = (sum(1 for v in iv_history if v <= iv_atm) / len(iv_history)) * 100.0
    return {
        "status": "OK",
        "ivAtm": iv_atm,
        "ivMin": iv_min,
        "ivMax": iv_max,
        "ivRank": iv_rank,
        "ivPercentile": iv_pct,
        "cones": cones,
    }


def synth_rates_reference(
    spot: float,
    rf: float,
    div_y: float,
    tau: float,
    pairs: list[dict[str, float]],
    near_atm: int = 5,
    mod_th: float = 0.02,
    htb_th: float = 0.05,
) -> dict[str, Any]:
    disc_spot = spot * math.exp(-div_y * tau)
    nodes = []
    for p in pairs:
        disc_k = disc_spot - (p["callMid"] - p["putMid"])
        r_impl = -math.log(disc_k / p["strike"]) / tau
        nodes.append(
            {
                "strike": p["strike"],
                "callMid": p["callMid"],
                "putMid": p["putMid"],
                "syntheticForward": p["strike"] * math.exp(r_impl * tau),
                "impliedRateContinuous": r_impl,
                "impliedTna": math.expm1(r_impl * tau) / tau,
                "absLogMoneyness": abs(math.log(p["strike"] / spot)),
            }
        )
    by_strike = sorted(nodes, key=lambda x: x["strike"])
    near = sorted(by_strike, key=lambda x: (x["absLogMoneyness"], x["strike"]))[:near_atm]
    near_rates = sorted(x["impliedRateContinuous"] for x in near)
    mid = len(near_rates) // 2
    med_rate = near_rates[mid] if len(near_rates) % 2 == 1 else 0.5 * (near_rates[mid - 1] + near_rates[mid])
    med_tna = math.expm1(med_rate * tau) / tau
    borrow = rf - med_rate
    if borrow >= htb_th:
        regime = "HARD_TO_BORROW_SQUEEZE_ALERT"
    elif borrow >= mod_th:
        regime = "MODERATE_SHORT_DEMAND"
    else:
        regime = "EASY_TO_BORROW"
    return {
        "status": "OK",
        "medianImpliedRate": med_rate,
        "medianImpliedTna": med_tna,
        "impliedBorrowRate": borrow,
        "borrowRegime": regime,
        "strikes": by_strike,
    }


def conv_rev_reference(inp: dict[str, float]) -> dict[str, Any]:
    f_stock = inp["stockFeeRate"] * (1.0 + inp["vatRate"])
    f_opt = inp["optionFeeRate"] * (1.0 + inp["vatRate"])
    tau = inp["timeToExpiry"]
    k = inp["strike"]
    conv_cost = (
        inp["spotAsk"] * (1.0 + f_stock)
        + inp["putAsk"] * (1.0 + f_opt)
        - inp["callBid"] * (1.0 - f_opt)
        - inp["dividendPresentValue"]
    )
    conv_tna = ((k - conv_cost) / conv_cost) / tau
    conv_bps = (conv_tna - inp["riskFreeTna"]) * 10_000.0

    rev_proc = (
        inp["spotBid"] * (1.0 - f_stock)
        + inp["putBid"] * (1.0 - f_opt)
        - inp["callAsk"] * (1.0 + f_opt)
        - inp["dividendPresentValue"]
    )
    borrow_cost = inp["spotBid"] * inp["shortBorrowRateTna"] * tau
    rev_oblig = k + borrow_cost
    rev_tna = ((rev_oblig - rev_proc) / rev_proc) / tau
    rev_bps = (inp["riskFreeTna"] - rev_tna) * 10_000.0
    net_bps = max(conv_bps, rev_bps)

    if conv_bps > 0.0 and conv_bps >= rev_bps:
        sig = "EXECUTABLE_CONVERSION"
    elif rev_bps > 0.0:
        sig = "EXECUTABLE_REVERSAL"
    else:
        sig = "NO_ARBITRAGE_WITHIN_BOUNDS"

    return {
        "status": "OK",
        "conversionNetCost": conv_cost,
        "conversionAnnualizedTna": conv_tna,
        "conversionEdgeVsRiskFreeBps": conv_bps,
        "reversalNetProceeds": rev_proc,
        "shortBorrowCost": borrow_cost,
        "reversalTerminalObligation": rev_oblig,
        "reversalAnnualizedTna": rev_tna,
        "reversalEdgeVsRiskFreeBps": rev_bps,
        "netEdgeVsRiskFreeBps": net_bps,
        "arbitrageSignal": sig,
    }


def buy_write_reference(inp: dict[str, float]) -> dict[str, Any]:
    f_stock = inp["stockFeeRate"] * (1.0 + inp["vatRate"])
    f_opt = inp["optionFeeRate"] * (1.0 + inp["vatRate"])
    fees = inp["spotAsk"] * f_stock + inp["callBid"] * f_opt
    basis = inp["spotAsk"] * (1.0 + f_stock) - inp["callBid"] * (1.0 - f_opt)
    be = basis - inp["dividendCash"]
    prot = ((inp["spotAsk"] - be) / inp["spotAsk"]) * 100.0
    stat_p = min(inp["spotAsk"], inp["strike"]) + inp["dividendCash"] - basis
    stat_pct = (stat_p / basis) * 100.0
    stat_tna = stat_pct / inp["timeToExpiry"]
    max_p = inp["strike"] + inp["dividendCash"] - basis
    max_pct = (max_p / basis) * 100.0
    max_tna = max_pct / inp["timeToExpiry"]
    return {
        "status": "OK",
        "totalFeesPerShare": fees,
        "netCostBasis": basis,
        "breakevenPrice": be,
        "downsideProtectionPct": prot,
        "staticProfitPerShare": stat_p,
        "staticReturnPct": stat_pct,
        "staticAnnualizedTna": stat_tna,
        "maxAssignedProfitPerShare": max_p,
        "maxAssignedReturnPct": max_pct,
        "assignedAnnualizedTna": max_tna,
    }


def calendar_roll_reference(inp: dict[str, float]) -> dict[str, Any]:
    f_opt = inp["optionFeeRate"] * (1.0 + inp["vatRate"])
    dur = inp["farTimeToExpiry"] - inp["nearTimeToExpiry"]
    gross = inp["farBid"] - inp["nearAsk"]
    fees = (inp["farBid"] + inp["nearAsk"]) * f_opt
    net = inp["farBid"] * (1.0 - f_opt) - inp["nearAsk"] * (1.0 + f_opt)
    return {
        "status": "OK",
        "rollDurationYears": dur,
        "grossRollCredit": gross,
        "rollFeesPerShare": fees,
        "netRollCredit": net,
        "annualizedRollYield": (net / (inp["strike"] * dur)) * 100.0,
        "annualizedRollYieldOnSpot": (net / (inp["spot"] * dur)) * 100.0,
        "netThetaDiff": inp["farThetaDaily"] - inp["nearThetaDaily"],
        "netVegaDiff": inp["farVegaPer1Pct"] - inp["nearVegaPer1Pct"],
    }


def main() -> None:
    # 1. Breeden-Litzenberger Q Scenarios
    q_input_1 = {
        "spot": 6400.0,
        "rate": 0.28,
        "dividendYield": 0.012,
        "timeToExpiry": 45.0 / DAYS_PER_YEAR,
        "nodes": [
            {
                "strike": float(k),
                "iv": 0.52 + 0.14 * ((6400.0 - k) / 6400.0) + 0.22 * (((k - 6400.0) / 6400.0) ** 2),
            }
            for k in range(5400, 7600, 200)
        ],
    }
    q_res_1 = extract_q_reference(
        q_input_1["spot"],
        q_input_1["rate"],
        q_input_1["dividendYield"],
        q_input_1["timeToExpiry"],
        q_input_1["nodes"],
    )

    q_input_2 = {
        "spot": 595.0,
        "rate": 0.043,
        "dividendYield": 0.013,
        "timeToExpiry": 32.0 / DAYS_PER_YEAR,
        "nodes": [
            {"strike": float(k), "iv": 0.19 + 0.18 * max(0.0, (595.0 - k) / 595.0)}
            for k in [545, 560, 575, 585, 595, 605, 620, 640, 665]
        ],
    }
    q_res_2 = extract_q_reference(
        q_input_2["spot"],
        q_input_2["rate"],
        q_input_2["dividendYield"],
        q_input_2["timeToExpiry"],
        q_input_2["nodes"],
    )

    # 2. Empirical P bars (70 deterministic daily sessions + 2 overnight >3sigma gap shocks)
    bars: list[dict[str, float]] = []
    close_px = 5000.0
    start_ts = AS_OF_UTC_SEC - 70 * 86_400
    for i in range(70):
        t = start_ts + i * 86_400
        if i == 0:
            open_px = close_px * 0.999
            close_px = 5012.0
        else:
            gap = 0.002 + 0.0025 * math.sin(i * 0.7)
            rth = 0.0018 + 0.003 * math.cos(i * 0.5)
            if i == 25:
                gap = 0.095  # Large overnight gap shock (>3 sigma)
                rth = 0.010
            elif i == 52:
                gap = -0.088  # Negative overnight gap shock (>3 sigma)
                rth = -0.006
            open_px = close_px * math.exp(gap)
            close_px = open_px * math.exp(rth)
        bars.append(
            {
                "time": t,
                "open": round(open_px, 6),
                "high": round(max(open_px, close_px) * 1.005, 6),
                "low": round(min(open_px, close_px) * 0.995, 6),
                "close": round(close_px, 6),
                "volume": 100_000 + i * 1_500,
            }
        )

    p_h1_res = analyze_p_reference(bars, AS_OF_UTC_SEC, 6400.0, horizon_days=1, daily_rf=0.0)
    p_h5_res = analyze_p_reference(bars, AS_OF_UTC_SEC, 6400.0, horizon_days=5, daily_rf=0.0008)

    # Build a crisp multi-regime P comparison series matched to Q1 strikes for divergence evaluation
    bars_div: list[dict[str, float]] = []
    px_div = 6000.0
    for i in range(60):
        t = start_ts + i * 86_400
        r_on = 0.0005 + 0.018 * math.sin(i * 0.52)
        r_rth = 0.0002 + 0.014 * math.cos(i * 0.37)
        op = px_div * math.exp(r_on)
        cl = op * math.exp(r_rth)
        px_div = cl
        bars_div.append({"time": t, "open": op, "close": cl})

    p_div_res = analyze_p_reference(bars_div, AS_OF_UTC_SEC, 6400.0, horizon_days=10, daily_rf=0.0)
    pq_targets = [
        {"label": "CAP_BELOW_EDGE", "price": 6600.0, "direction": "BELOW"},
        {"label": "ATM_FAIRLY_PRICED", "price": 6400.0, "direction": "ABOVE"},
        {"label": "NAKED_POC_HIGH", "price": 7100.0, "direction": "ABOVE"},
        {"label": "OUT_OF_RANGE", "price": 9000.0, "direction": "ABOVE"},
    ]
    pq_res = eval_pq_divergence_reference(6400.0, q_res_1, p_div_res, pq_targets, min_edge=0.05)

    # 4. Vol Cone & IV Rank/Percentile
    cone_input = {
        "spot": 6400.0,
        "ivAtm": 0.56,
        "horizonsDays": [7, 14, 30, 45, 90],
        "ivHistory": [round(0.40 + i * 0.01, 4) for i in range(25)],
    }
    cone_res = cone_and_rank_reference(
        cone_input["spot"], cone_input["ivAtm"], cone_input["horizonsDays"], cone_input["ivHistory"]
    )

    # 5. Synthetic Implied Rates (3 borrow regimes)
    tau_synth = 45.0 / DAYS_PER_YEAR
    spot_synth = 6400.0
    q_synth = 0.012
    rf_synth = 0.30

    def make_pairs(target_r: float) -> list[dict[str, float]]:
        disc_s = spot_synth * math.exp(-q_synth * tau_synth)
        strikes = [5800.0, 6000.0, 6200.0, 6400.0, 6600.0, 6800.0, 7000.0]
        out = []
        for idx, k in enumerate(strikes):
            # slight strike micro-jitter +/-0.2 ARS that cancels near median
            jitter = (idx - 3) * 0.15
            put_mid = max(25.0, (k - spot_synth) * 0.4 + 280.0)
            # C - P = S*exp(-qT) - K*exp(-rT) => C = P + disc_s - K*exp(-rT)
            call_mid = put_mid + disc_s - k * math.exp(-target_r * tau_synth) + jitter
            out.append({"strike": k, "callMid": round(call_mid, 6), "putMid": round(put_mid, 6)})
        return out

    synth_cases = []
    for name, target_r in [
        ("easy_borrow", 0.295),
        ("moderate_short_demand", 0.265),
        ("hard_to_borrow_squeeze", 0.21),
    ]:
        pairs = make_pairs(target_r)
        inp = {
            "spot": spot_synth,
            "riskFreeRate": rf_synth,
            "dividendYield": q_synth,
            "timeToExpiry": tau_synth,
            "pairs": pairs,
            "nearAtmCount": 5,
            "moderateBorrowThreshold": 0.02,
            "hardToBorrowThreshold": 0.05,
        }
        synth_cases.append(
            {
                "name": name,
                "input": inp,
                "expected": synth_rates_reference(spot_synth, rf_synth, q_synth, tau_synth, pairs),
            }
        )

    # 6. Conversion/Reversal cases
    conv_inputs = [
        (
            "executable_conversion",
            {
                "strike": 6800.0,
                "timeToExpiry": 45.0 / DAYS_PER_YEAR,
                "riskFreeTna": 0.32,
                "spotBid": 6398.0,
                "spotAsk": 6400.0,
                "callBid": 395.0,
                "callAsk": 405.0,
                "putBid": 455.0,
                "putAsk": 465.0,
                "dividendPresentValue": 10.0,
                "stockFeeRate": 0.0005,
                "optionFeeRate": 0.0020,
                "vatRate": 0.21,
                "shortBorrowRateTna": 0.02,
            },
        ),
        (
            "executable_reversal",
            {
                "strike": 6800.0,
                "timeToExpiry": 45.0 / DAYS_PER_YEAR,
                "riskFreeTna": 0.35,
                "spotBid": 6400.0,
                "spotAsk": 6405.0,
                "callBid": 680.0,
                "callAsk": 685.0,
                "putBid": 900.0,
                "putAsk": 910.0,
                "dividendPresentValue": 0.0,
                "stockFeeRate": 0.0005,
                "optionFeeRate": 0.0020,
                "vatRate": 0.21,
                "shortBorrowRateTna": 0.02,
            },
        ),
        (
            "within_no_arbitrage_bounds",
            {
                "strike": 6400.0,
                "timeToExpiry": 45.0 / DAYS_PER_YEAR,
                "riskFreeTna": 0.32,
                "spotBid": 6395.0,
                "spotAsk": 6405.0,
                "callBid": 420.0,
                "callAsk": 440.0,
                "putBid": 175.0,
                "putAsk": 195.0,
                "dividendPresentValue": 0.0,
                "stockFeeRate": 0.0005,
                "optionFeeRate": 0.0020,
                "vatRate": 0.21,
                "shortBorrowRateTna": 0.05,
            },
        ),
    ]
    conv_cases = [
        {"name": name, "input": inp, "expected": conv_rev_reference(inp)} for name, inp in conv_inputs
    ]

    # 7. Buy-Write & Calendar Roll cases
    bw_inputs = [
        (
            "ggal_buy_write_with_div",
            {
                "spotAsk": 6400.0,
                "strike": 6800.0,
                "callBid": 385.0,
                "timeToExpiry": 45.0 / DAYS_PER_YEAR,
                "dividendCash": 42.0,
                "stockFeeRate": 0.0005,
                "optionFeeRate": 0.0020,
                "vatRate": 0.21,
            },
        ),
        (
            "ypfd_buy_write_atm_cap",
            {
                "spotAsk": 41250.0,
                "strike": 40000.0,
                "callBid": 3100.0,
                "timeToExpiry": 38.0 / DAYS_PER_YEAR,
                "dividendCash": 0.0,
                "stockFeeRate": 0.0005,
                "optionFeeRate": 0.0020,
                "vatRate": 0.21,
            },
        ),
    ]
    bw_cases = [{"name": n, "input": inp, "expected": buy_write_reference(inp)} for n, inp in bw_inputs]

    roll_inputs = [
        (
            "ggal_bimestre_roll",
            {
                "spot": 6400.0,
                "strike": 6400.0,
                "nearAsk": 310.0,
                "farBid": 780.0,
                "nearTimeToExpiry": 25.0 / DAYS_PER_YEAR,
                "farTimeToExpiry": 88.0 / DAYS_PER_YEAR,
                "nearThetaDaily": -6.2,
                "farThetaDaily": -3.9,
                "nearVegaPer1Pct": 6.4,
                "farVegaPer1Pct": 11.8,
                "optionFeeRate": 0.0020,
                "vatRate": 0.21,
            },
        ),
        (
            "spy_zero_vat_roll",
            {
                "spot": 595.0,
                "strike": 600.0,
                "nearAsk": 4.85,
                "farBid": 11.40,
                "nearTimeToExpiry": 14.0 / DAYS_PER_YEAR,
                "farTimeToExpiry": 49.0 / DAYS_PER_YEAR,
                "nearThetaDaily": -0.24,
                "farThetaDaily": -0.13,
                "nearVegaPer1Pct": 0.41,
                "farVegaPer1Pct": 0.78,
                "optionFeeRate": 0.0010,
                "vatRate": 0.0,
            },
        ),
    ]
    roll_cases = [{"name": n, "input": inp, "expected": calendar_roll_reference(inp)} for n, inp in roll_inputs]

    payload = {
        "asOfUtcSec": AS_OF_UTC_SEC,
        "qCases": [
            {"name": "ggal_uniform_11_strikes", "input": q_input_1, "expected": q_res_1},
            {"name": "spy_nonuniform_9_strikes", "input": q_input_2, "expected": q_res_2},
        ],
        "pBars": bars,
        "pCases": [
            {
                "name": "horizon_1d_fat_tails",
                "options": {
                    "asOfUtcSec": AS_OF_UTC_SEC,
                    "spot": 6400.0,
                    "horizonDays": 1,
                    "dailyRiskFreeRate": 0.0,
                    "minHistoryBars": 30,
                    "tailSigmaThreshold": 3.0,
                },
                "expected": p_h1_res,
            },
            {
                "name": "horizon_5d_excess_return",
                "options": {
                    "asOfUtcSec": AS_OF_UTC_SEC,
                    "spot": 6400.0,
                    "horizonDays": 5,
                    "dailyRiskFreeRate": 0.0008,
                    "minHistoryBars": 30,
                    "tailSigmaThreshold": 3.0,
                },
                "expected": p_h5_res,
            },
        ],
        "pqDivergenceCase": {
            "spot": 6400.0,
            "qInput": q_input_1,
            "pBars": bars_div,
            "pOptions": {
                "asOfUtcSec": AS_OF_UTC_SEC,
                "spot": 6400.0,
                "horizonDays": 10,
                "dailyRiskFreeRate": 0.0,
                "minHistoryBars": 30,
                "tailSigmaThreshold": 3.0,
            },
            "targets": pq_targets,
            "minEdgeSpread": 0.05,
            "expected": pq_res,
        },
        "coneAndRankCase": {
            "input": cone_input,
            "expected": cone_res,
        },
        "syntheticRatesCases": synth_cases,
        "conversionReversalCases": conv_cases,
        "buyWriteCases": bw_cases,
        "calendarRollCases": roll_cases,
    }

    out_path = Path(__file__).resolve().parent.parent / "fixtures" / "prob_divergence_synth_reference.json"
    out_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {out_path}")
    print("Q1 status:", q_res_1["status"], "meanQ:", round(q_res_1["meanQ"], 4), "rawArea:", round(q_res_1["rawArea"], 6))
    print("P H=1 tailEvents:", p_h1_res["tailEventsCount"], "onShare:", round(p_h1_res["overnightVarianceShare"], 4))
    print("PQ classes:", [lv["classification"] for lv in pq_res["levels"]])
    print("Conv/Rev signals:", [c["expected"]["arbitrageSignal"] for c in conv_cases])


if __name__ == "__main__":
    main()
