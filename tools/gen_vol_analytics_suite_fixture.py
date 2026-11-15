"""Independent Python reference fixture generator for Pieza 27 (options/volAnalyticsSuite.ts).

Uses completely independent mathematical implementations in standard library Python:
- Bivariate normal CDF via 1D composite Simpson integration (independent Bjerksund-Stensland 2002)
- Separated OTM Calls/Puts smile, BSM analytical deltas, and 25-delta Risk Reversal
- Normalized moneyness matrix (-20%..+20%) via independent piecewise linear interpolation
- Rolling 23-day realized vol quintile buckets, forward 21d outcomes, monthly seasonality & >3σ tails
- Expected move cone + analytical Lognormal density vs Breeden-Litzenberger Q
- Strike-by-strike Put-Call parity and Bid/Ask TEA Tomadora & Colocadora vs benchmark TEA
- 1:N option ratios and Bull Call / Bear Put / Symmetric Butterfly relative costs + BS2002 historical percentile
- Dual BYMA (ARS) vs OPRA ADR (USD) implied surface & CCL variance decomposition
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SQRT_2 = math.sqrt(2.0)
SQRT_2PI = math.sqrt(2.0 * math.pi)
GOLDEN_PHI_INV = 0.5 * (math.sqrt(5.0) - 1.0)
TRADING_DAYS_PER_YEAR = 252
CALENDAR_DAYS_PER_YEAR = 365
DEFAULT_OFFSETS_PCT = [-20, -15, -10, -5, 0, 5, 10, 15, 20]
MONTH_LABELS_ES = [
    "Ene", "Feb", "Mar", "Abr", "May", "Jun",
    "Jul", "Ago", "Sep", "Oct", "Nov", "Dic",
]


def is_pos_finite(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) and x > 0.0


def clean_json(val: Any) -> Any:
    if isinstance(val, float):
        return None if not math.isfinite(val) else val
    if isinstance(val, list):
        return [clean_json(v) for v in val]
    if isinstance(val, dict):
        return {k: clean_json(v) for k, v in val.items()}
    return val


def norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / SQRT_2PI


def norm_cdf(x: float) -> float:
    return 0.5 * math.erfc(-x / SQRT_2)


def bsm_delta_py(S: float, K: float, T: float, r: float, q: float, sigma: float, contract_type: str) -> float:
    if not (is_pos_finite(S) and is_pos_finite(K) and is_pos_finite(T) and is_pos_finite(sigma)):
        return float("nan")
    srt = sigma * math.sqrt(T)
    d1 = (math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / srt
    disc_q = math.exp(-q * T)
    if contract_type == "call":
        return disc_q * norm_cdf(d1)
    return disc_q * (norm_cdf(d1) - 1.0)


def bsm_price_py(S: float, K: float, T: float, r: float, q: float, sigma: float, contract: str) -> float:
    srt = sigma * math.sqrt(T)
    d1 = (math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / srt
    d2 = d1 - srt
    if contract == "call":
        return S * math.exp(-q * T) * norm_cdf(d1) - K * math.exp(-r * T) * norm_cdf(d2)
    return K * math.exp(-r * T) * norm_cdf(-d2) - S * math.exp(-q * T) * norm_cdf(-d1)


def _gauss_legendre_nodes(n: int) -> tuple[list[float], list[float]]:
    nodes = [0.0] * n
    weights = [0.0] * n
    m = (n + 1) // 2
    for i in range(m):
        x = math.cos(math.pi * (i + 0.75) / (n + 0.5))
        for _ in range(12):
            p1, p2 = 1.0, 0.0
            for j in range(1, n + 1):
                p3 = p2
                p2 = p1
                p1 = ((2.0 * j - 1.0) * x * p2 - (j - 1.0) * p3) / j
            pp = n * (x * p1 - p2) / (x * x - 1.0)
            dx = p1 / pp
            x -= dx
            if abs(dx) < 1e-16:
                break
        nodes[i] = -x
        nodes[n - 1 - i] = x
        w = 2.0 / ((1.0 - x * x) * pp * pp)
        weights[i] = w
        weights[n - 1 - i] = w
    return nodes, weights


_GL_NODES_64, _GL_WEIGHTS_64 = _gauss_legendre_nodes(64)


def bvn_independent_integral(a: float, b: float, rho: float) -> float:
    if rho < -1.0 or rho > 1.0 or math.isnan(a) or math.isnan(b) or math.isnan(rho):
        return float("nan")
    if abs(rho) < 1e-15:
        return norm_cdf(a) * norm_cdf(b)
    if rho >= 1.0 - 1e-15:
        return norm_cdf(min(a, b))
    if rho <= -1.0 + 1e-15:
        return max(0.0, norm_cdf(a) - norm_cdf(-b))
    if rho < 0.0:
        return max(0.0, min(1.0, norm_cdf(a) - bvn_independent_integral(a, -b, -rho)))
    if a <= -9.0 or b <= -9.0:
        return 0.0
    if a >= 9.0 and b >= 9.0:
        return 1.0
    lo = -9.0
    hi = min(a, 9.0)
    if hi <= lo:
        return 0.0
    sqrt_1_m_r2 = math.sqrt(1.0 - rho * rho)
    half = 0.5 * (hi - lo)
    mid = 0.5 * (hi + lo)
    total = 0.0
    for nd, wt in zip(_GL_NODES_64, _GL_WEIGHTS_64):
        x = mid + half * nd
        total += wt * norm_pdf(x) * norm_cdf((b - rho * x) / sqrt_1_m_r2)
    return max(0.0, min(1.0, half * total))


def bs02_call_independent(S: float, K: float, T: float, r: float, q: float, sigma: float) -> float:
    if S <= 0.0 or K <= 0.0 or T <= 0.0 or sigma <= 0.0:
        return float("nan")
    eur = bsm_price_py(S, K, T, r, q, sigma, "call")
    if r >= 0.0 and q <= 0.0:
        return eur
    if r < 0.0:
        return float("nan")

    b = r - q
    s2 = sigma * sigma
    x_term = b / s2 - 0.5
    disc = x_term * x_term + 2.0 * r / s2
    beta = (-x_term + math.sqrt(disc)) if x_term <= 0.0 else (2.0 * r / s2) / (x_term + math.sqrt(disc))
    if beta <= 1.0 or not math.isfinite(beta):
        return max(eur, S - K, 0.0)

    b0 = max(K, (r / q) * K)
    span = K / (beta - 1.0) if r <= q else (beta / (beta - 1.0) - r / q) * K
    if not math.isfinite(span) or span <= 1e-12 * K:
        return max(eur, S - K, 0.0)

    t1 = GOLDEN_PHI_INV * T

    def g_eff(tau: float) -> float:
        raw = b * tau + 2.0 * sigma * math.sqrt(tau)
        if b < 0.0 and tau > s2 / (b * b):
            return -s2 / b
        return raw

    h2 = -g_eff(T) * K * K / (span * b0)
    h1 = -g_eff(T - t1) * K * K / (span * b0)
    x2 = b0 + span * (-math.expm1(h2))
    x1 = b0 + span * (-math.expm1(h1))
    if S >= x2:
        return max(eur, S - K)

    def log_norm_cdf_py(z: float) -> float:
        if z > -30.0:
            return math.log(norm_cdf(z))
        iz2 = 1.0 / (z * z)
        return -0.5 * z * z - 0.5 * math.log(2.0 * math.pi) - math.log(-z) + math.log(
            1.0 - iz2 * (1.0 - iz2 * (3.0 - iz2 * (15.0 - iz2 * (105.0 - 945.0 * iz2))))
        )

    def mul_exp_ncdf(log_c: float, z: float) -> float:
        if z > -30.0 and log_c < 700.0:
            return math.exp(log_c) * norm_cdf(z)
        tot = log_c + log_norm_cdf_py(z)
        return 0.0 if tot <= -745.0 else math.exp(tot)

    def mul_exp_bvn(log_c: float, a_v: float, b_v: float, rho_v: float) -> float:
        v = bvn_independent_integral(a_v, b_v, rho_v)
        if log_c <= 700.0:
            return 0.0 if v == 0.0 else math.exp(log_c) * v
        if v > 0.0:
            tot = log_c + math.log(v)
            return 0.0 if tot <= -745.0 else math.exp(tot)
        ub = log_c + min(log_norm_cdf_py(a_v), log_norm_cdf_py(b_v))
        return 0.0 if ub < -50.0 else math.exp(ub)

    def phi_term(scale: float, log_base: float, gamma: float, H: float, I_bar: float) -> float:
        lam = 0.0 if gamma == beta else (-r + gamma * b + 0.5 * gamma * (gamma - 1.0) * s2)
        kap = 2.0 * b / s2 + (2.0 * gamma - 1.0)
        srt1 = sigma * math.sqrt(t1)
        d = -(math.log(S / H) + (b + (gamma - 0.5) * s2) * t1) / srt1
        d2 = d - 2.0 * math.log(I_bar / S) / srt1
        lp = lam * t1 + log_base
        return scale * (mul_exp_ncdf(lp, d) - mul_exp_ncdf(lp + kap * math.log(I_bar / S), d2))

    def psi_term(scale: float, log_base: float, gamma: float, H: float) -> float:
        lam = 0.0 if gamma == beta else (-r + gamma * b + 0.5 * gamma * (gamma - 1.0) * s2)
        kap = 2.0 * b / s2 + (2.0 * gamma - 1.0)
        srt1 = sigma * math.sqrt(t1)
        srT = sigma * math.sqrt(T)
        rho = math.sqrt(t1 / T)
        drift = b + (gamma - 0.5) * s2
        e1 = (math.log(S / x1) + drift * t1) / srt1
        e2 = (math.log((x2 * x2) / (S * x1)) + drift * t1) / srt1
        e3 = (math.log(S / x1) - drift * t1) / srt1
        e4 = (math.log((x2 * x2) / (S * x1)) - drift * t1) / srt1
        f1 = (math.log(S / H) + drift * T) / srT
        f2 = (math.log((x2 * x2) / (S * H)) + drift * T) / srT
        f3 = (math.log((x1 * x1) / (S * H)) + drift * T) / srT
        f4 = (math.log((S * x1 * x1) / (H * x2 * x2)) + drift * T) / srT
        lp = lam * T + log_base
        return scale * (
            mul_exp_bvn(lp, -e1, -f1, rho)
            - mul_exp_bvn(lp + kap * math.log(x2 / S), -e2, -f2, rho)
            - mul_exp_bvn(lp + kap * math.log(x1 / S), -e3, -f3, -rho)
            + mul_exp_bvn(lp + kap * math.log(x1 / x2), -e4, -f4, -rho)
        )

    l_x2 = beta * math.log(S / x2)
    l_x1 = beta * math.log(S / x1)
    l_s = math.log(S)
    val = (
        (x2 - K) * math.exp(l_x2)
        - phi_term(x2 - K, l_x2, beta, x2, x2)
        + phi_term(1.0, l_s, 1.0, x2, x2)
        - phi_term(1.0, l_s, 1.0, x1, x2)
        - phi_term(K, 0.0, 0.0, x2, x2)
        + phi_term(K, 0.0, 0.0, x1, x2)
        + phi_term(x1 - K, l_x1, beta, x1, x2)
        - psi_term(x1 - K, l_x1, beta, x1)
        + psi_term(1.0, l_s, 1.0, x1)
        - psi_term(1.0, l_s, 1.0, K)
        - psi_term(K, 0.0, 0.0, x1)
        + psi_term(K, 0.0, 0.0, K)
    )
    return max(val, eur, S - K)


def bs02_american_py(S: float, K: float, T: float, r: float, q: float, sigma: float, contract: str) -> float:
    if contract == "call":
        return bs02_call_independent(S, K, T, r, q, sigma)
    eur = bsm_price_py(S, K, T, r, q, sigma, "put")
    if r <= 0.0 and q >= 0.0:
        return eur
    return bs02_call_independent(K, S, T, q, r, sigma)


def linear_percentile(sorted_vals: list[float], q: float) -> float:
    n = len(sorted_vals)
    if n == 0 or q < 0.0 or q > 1.0:
        return float("nan")
    if n == 1:
        return sorted_vals[0]
    pos = q * (n - 1)
    lo = int(math.floor(pos))
    hi = min(n - 1, lo + 1)
    w = pos - lo
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * w


def interpolate_linear(sorted_pts: list[tuple[float, float]], x_target: float) -> float:
    if not sorted_pts or not math.isfinite(x_target):
        return float("nan")
    if abs(x_target - sorted_pts[0][0]) <= 1e-9:
        return sorted_pts[0][1]
    if abs(x_target - sorted_pts[-1][0]) <= 1e-9:
        return sorted_pts[-1][1]
    if x_target < sorted_pts[0][0] or x_target > sorted_pts[-1][0]:
        return float("nan")
    for i in range(len(sorted_pts) - 1):
        ax, ay = sorted_pts[i]
        bx, by = sorted_pts[i + 1]
        if abs(x_target - ax) <= 1e-9:
            return ay
        if abs(x_target - bx) <= 1e-9:
            return by
        if ax < x_target < bx and bx > ax:
            t = (x_target - ax) / (bx - ax)
            return ay + (by - ay) * t
    return float("nan")


def resolve_side_price(leg: dict[str, Any], side: str) -> tuple[float, str]:
    bid = leg.get("bid")
    ask = leg.get("ask")
    mid_raw = leg.get("mid")
    last = leg.get("last")
    if is_pos_finite(mid_raw):
        mid = float(mid_raw)
    elif is_pos_finite(bid) and is_pos_finite(ask) and ask >= bid:
        mid = 0.5 * (float(bid) + float(ask))
    elif is_pos_finite(last):
        mid = float(last)
    else:
        mid = None

    if side == "buy":
        if is_pos_finite(ask):
            return float(ask), "BBO"
        if mid is not None:
            return mid, "MID"
        return float("nan"), "NONE"
    if side == "sell":
        if is_pos_finite(bid):
            return float(bid), "BBO"
        if mid is not None:
            return mid, "MID"
        return float("nan"), "NONE"
    if mid is not None:
        return mid, "MID"
    return float("nan"), "NONE"


def py_build_separated_otm_smile(inp: dict[str, Any], only_otm: bool = True, short_dte_thresh: float = 7.0, wing_limit: float = 0.25) -> dict[str, Any]:
    S = inp["spot"]
    T = inp["timeToExpiryYears"]
    days = inp["daysToExpiry"]
    r = inp["rate"]
    q = inp["dividendYield"]
    is_short = days < short_dte_thresh

    call_pts: list[dict[str, Any]] = []
    put_pts: list[dict[str, Any]] = []
    otm_put_map: dict[float, float] = {}
    otm_call_map: dict[float, float] = {}
    excluded_itm = 0

    for c in inp["contracts"]:
        K = c["strike"]
        iv = c["iv"]
        if not (is_pos_finite(K) and is_pos_finite(iv)):
            continue
        is_call = c["contractType"] == "call"
        is_otm = K >= S - 1e-9 if is_call else K <= S + 1e-9
        is_strictly_itm = not is_otm
        is_short_itm = is_short and is_strictly_itm

        if K <= S + 1e-9 and not is_call:
            otm_put_map[K] = iv * 100.0
        if K >= S - 1e-9 and is_call:
            otm_call_map[K] = iv * 100.0

        if only_otm and is_strictly_itm:
            excluded_itm += 1
            continue

        d_raw = c.get("delta")
        if isinstance(d_raw, (int, float)) and math.isfinite(d_raw) and (0 < d_raw <= 1 if is_call else -1 <= d_raw < 0):
            delta = float(d_raw)
        else:
            delta = bsm_delta_py(S, K, T, r, q, iv, c["contractType"])
        if not math.isfinite(delta):
            continue

        m_pct = (K / S - 1.0) * 100.0
        mid_val = resolve_side_price(c, "mid")[0]
        pt = {
            "strike": K,
            "moneynessPct": m_pct,
            "delta": delta,
            "ivPct": iv * 100.0,
            "isOtm": is_otm,
            "isShortDteItm": is_short_itm,
            "mid": None if not math.isfinite(mid_val) or mid_val == 0 else mid_val,
        }
        if is_call:
            call_pts.append(pt)
        else:
            put_pts.append(pt)

    call_pts.sort(key=lambda x: x["strike"])
    put_pts.sort(key=lambda x: x["strike"])

    all_k = sorted(set(otm_put_map.keys()) | set(otm_call_map.keys()))
    comp_pts = []
    for K in all_k:
        p_iv = otm_put_map.get(K)
        c_iv = otm_call_map.get(K)
        m_pct = (K / S - 1.0) * 100.0
        if K < S - 1e-9 and p_iv is not None:
            comp_pts.append({"strike": K, "moneynessPct": m_pct, "ivPct": p_iv, "sourceSide": "PUT"})
        elif K > S + 1e-9 and c_iv is not None:
            comp_pts.append({"strike": K, "moneynessPct": m_pct, "ivPct": c_iv, "sourceSide": "CALL"})
        elif p_iv is not None and c_iv is not None:
            comp_pts.append({"strike": K, "moneynessPct": m_pct, "ivPct": 0.5 * (p_iv + c_iv), "sourceSide": "ATM_AVG"})
        elif p_iv is not None:
            comp_pts.append({"strike": K, "moneynessPct": m_pct, "ivPct": p_iv, "sourceSide": "PUT"})
        elif c_iv is not None:
            comp_pts.append({"strike": K, "moneynessPct": m_pct, "ivPct": c_iv, "sourceSide": "CALL"})

    atm_iv = interpolate_linear([(p["moneynessPct"], p["ivPct"]) for p in comp_pts], 0.0)
    wing_lim_pct = wing_limit * 100.0
    c_wings = [p["ivPct"] for p in call_pts if 1e-6 < p["moneynessPct"] <= wing_lim_pct]
    p_wings = [p["ivPct"] for p in put_pts if -wing_lim_pct <= p["moneynessPct"] < -1e-6]
    c_wing_avg = sum(c_wings) / len(c_wings) if c_wings else float("nan")
    p_wing_avg = sum(p_wings) / len(p_wings) if p_wings else float("nan")
    skew_pp = c_wing_avg - p_wing_avg if math.isfinite(c_wing_avg) and math.isfinite(p_wing_avg) else float("nan")

    call_by_d = sorted([(p["delta"], p["ivPct"]) for p in call_pts if 0.0 < p["delta"] < 1.0], key=lambda x: x[0])
    put_by_d = sorted([(p["delta"], p["ivPct"]) for p in put_pts if -1.0 < p["delta"] < 0.0], key=lambda x: x[0])
    iv25_c = interpolate_linear(call_by_d, 0.25)
    iv25_p = interpolate_linear(put_by_d, -0.25)
    rr25 = iv25_c - iv25_p if math.isfinite(iv25_c) and math.isfinite(iv25_p) else float("nan")

    return {
        "status": "OK" if (call_pts or put_pts) else "NO_DATA",
        "onlyOtm": only_otm,
        "isShortDteSlice": is_short,
        "excludedItmCount": excluded_itm,
        "callPoints": call_pts,
        "putPoints": put_pts,
        "compositeOtmPoints": comp_pts,
        "atmIvPct": atm_iv,
        "callWingAvgIvPct": c_wing_avg,
        "putWingAvgIvPct": p_wing_avg,
        "callVsPutSkewPp": skew_pp,
        "iv25DeltaCallPct": iv25_c,
        "iv25DeltaPutPct": iv25_p,
        "riskReversal25DeltaPp": rr25,
    }


def py_build_moneyness_matrix(slices: list[dict[str, Any]], offsets: list[float] | None = None) -> dict[str, Any]:
    offsets = offsets or list(DEFAULT_OFFSETS_PCT)
    sorted_slices = sorted([s for s in slices if is_pos_finite(s["daysToExpiry"])], key=lambda s: s["daysToExpiry"])
    rows = []
    for s in sorted_slices:
        pts = sorted(
            [(p["moneynessPct"], p["ivPct"]) for p in s["compositeOtmPoints"] if math.isfinite(p["moneynessPct"]) and is_pos_finite(p["ivPct"])],
            key=lambda x: x[0],
        )
        cells = [{"offsetPct": off, "ivPct": interpolate_linear(pts, off)} for off in offsets]
        interp_atm = interpolate_linear(pts, 0.0)
        atm = interp_atm if math.isfinite(interp_atm) else (float(s["fallbackAtmIvPct"]) if is_pos_finite(s.get("fallbackAtmIvPct")) else float("nan"))
        rows.append({
            "expiryCode": s["expiryCode"],
            "expiryLabel": s["expiryLabel"],
            "daysToExpiry": s["daysToExpiry"],
            "atmIvPct": atm,
            "cells": cells,
        })
    valid_atm = [r for r in rows if is_pos_finite(r["atmIvPct"])]
    term_regime = "NO_DATA"
    term_spread = float("nan")
    if len(valid_atm) >= 2:
        term_spread = valid_atm[-1]["atmIvPct"] - valid_atm[0]["atmIvPct"]
        if term_spread > 0.25:
            term_regime = "CONTANGO"
        elif term_spread < -0.25:
            term_regime = "BACKWARDATION"
        else:
            term_regime = "FLAT"
    return {
        "status": "OK" if rows else "NO_DATA",
        "offsetsPct": offsets,
        "rows": rows,
        "termRegime": term_regime,
        "termSpreadPp": term_spread,
    }


def py_rolling_rv_distribution(bars: list[dict[str, Any]], window_days: int, max_points: int = 750) -> dict[str, Any]:
    clean = sorted([b for b in bars if math.isfinite(b["time"]) and is_pos_finite(b["close"])], key=lambda b: b["time"])
    log_rets = [math.log(clean[i]["close"] / clean[i - 1]["close"]) for i in range(1, len(clean))]
    rvs = []
    for end in range(window_days, len(log_rets) + 1):
        sl = log_rets[end - window_days:end]
        mean_r = sum(sl) / window_days
        sq = sum((x - mean_r) ** 2 for x in sl)
        ann = 100.0 * math.sqrt((TRADING_DAYS_PER_YEAR * sq) / (window_days - 1))
        if math.isfinite(ann) and ann >= 0.0:
            rvs.append(ann)
    bounded = rvs[-max_points:]
    s = sorted(bounded)
    return {
        "minPct": s[0],
        "p25Pct": linear_percentile(s, 0.25),
        "medianPct": linear_percentile(s, 0.50),
        "p75Pct": linear_percentile(s, 0.75),
        "maxPct": s[-1],
        "currentPct": bounded[-1],
        "observations": len(bounded),
    }


def py_historical_vol_conditional(bars: list[dict[str, Any]], current_iv_atm: float | None, rv_win: int = 23, fwd_days: int = 21, max_hist: int = 750, tail_sigma: float = 3.0) -> dict[str, Any]:
    clean = sorted([b for b in bars if math.isfinite(b["time"]) and is_pos_finite(b["close"])], key=lambda b: b["time"])
    daily = []
    for i in range(1, len(clean)):
        lr = math.log(clean[i]["close"] / clean[i - 1]["close"])
        dt_str = datetime.fromtimestamp(clean[i]["time"], tz=timezone.utc).strftime("%Y-%m-%d")
        daily.append({"time": clean[i]["time"], "date": dt_str, "close": clean[i]["close"], "prevClose": clean[i - 1]["close"], "logRet": lr})

    def trailing_rv(idx: int, win: int) -> float:
        if idx + 1 < win:
            return float("nan")
        sl = [daily[j]["logRet"] for j in range(idx - win + 1, idx + 1)]
        m = sum(sl) / win
        sq = sum((x - m) ** 2 for x in sl)
        return 100.0 * math.sqrt((TRADING_DAYS_PER_YEAR * sq) / (win - 1))

    full_hist = []
    for i in range(rv_win - 1, len(daily)):
        rv = trailing_rv(i, rv_win)
        full_hist.append({"time": daily[i]["time"], "date": daily[i]["date"], "close": daily[i]["close"], "rvPct": rv})
    hist_series = full_hist[-max_hist:]

    last_idx = len(daily) - 1
    rv20 = trailing_rv(last_idx, 20)
    rv23 = trailing_rv(last_idx, 23)
    rv60 = trailing_rv(last_idx, 60)

    cur_iv_ok = is_pos_finite(current_iv_atm)
    cur_eval = float(current_iv_atm) if cur_iv_ok else rv23
    vrp = (float(current_iv_atm) - rv23) if cur_iv_ok and math.isfinite(rv23) else float("nan")

    sorted_vols = sorted(p["rvPct"] for p in hist_series)
    min_v = sorted_vols[0]
    max_v = sorted_vols[-1]
    p20 = linear_percentile(sorted_vols, 0.2)
    p40 = linear_percentile(sorted_vols, 0.4)
    p60 = linear_percentile(sorted_vols, 0.6)
    p80 = linear_percentile(sorted_vols, 0.8)
    med = linear_percentile(sorted_vols, 0.5)

    iv_rank = max(0.0, min(100.0, ((cur_eval - min_v) / (max_v - min_v)) * 100.0)) if max_v > min_v else float("nan")
    iv_pct = max(0.0, min(100.0, (sum(1 for v in sorted_vols if v <= cur_eval) / len(sorted_vols)) * 100.0))

    if math.isnan(iv_rank):
        op_code = "NO_DATA"
    elif iv_rank > 70.0 and math.isfinite(vrp) and vrp > 5.0:
        op_code = "VENTA_PRIMA_CUBIERTA"
    elif iv_rank < 25.0:
        op_code = "COMPRA_CONVEXIDAD_CALENDAR"
    else:
        op_code = "NEUTRAL_SELECTIVO"

    def classify(v: float) -> str:
        if v < p20:
            return "VERY_LOW"
        if v < p40:
            return "LOW"
        if v < p60:
            return "NORMAL"
        if v < p80:
            return "HIGH"
        return "EXTREME"

    cur_bkt = classify(cur_eval)
    bkt_ids = ["VERY_LOW", "LOW", "NORMAL", "HIGH", "EXTREME"]
    acc = {bid: {"dv": [], "dr": [], "dec": 0} for bid in bkt_ids}
    paired = 0
    for i in range(0, len(hist_series) - fwd_days):
        cur_p = hist_series[i]
        fut_p = hist_series[i + fwd_days]
        bid = classify(cur_p["rvPct"])
        dv = fut_p["rvPct"] - cur_p["rvPct"]
        dr = (fut_p["close"] / cur_p["close"] - 1.0) * 100.0
        acc[bid]["dv"].append(dv)
        acc[bid]["dr"].append(dr)
        if dv < 0.0:
            acc[bid]["dec"] += 1
        paired += 1

    bounds = {"VERY_LOW": (min_v, p20), "LOW": (p20, p40), "NORMAL": (p40, p60), "HIGH": (p60, p80), "EXTREME": (p80, max_v)}
    buckets = []
    for bid in bkt_ids:
        a = acc[bid]
        occ = len(a["dv"])
        buckets.append({
            "id": bid,
            "minBoundPct": bounds[bid][0],
            "maxBoundPct": bounds[bid][1],
            "occurrences": occ,
            "avgVolChange30dPts": sum(a["dv"]) / occ if occ else float("nan"),
            "avgUnderlyingReturn30dPct": sum(a["dr"]) / occ if occ else float("nan"),
            "pctVolDecreased": (a["dec"] / occ) * 100.0 if occ else float("nan"),
            "isCurrent": cur_bkt == bid,
        })

    bounded_rets = daily[-max_hist:]
    lr_arr = [r["logRet"] for r in bounded_rets]
    m_lr = sum(lr_arr) / len(lr_arr)
    std_lr = math.sqrt(sum((x - m_lr) ** 2 for x in lr_arr) / (len(lr_arr) - 1))
    extremes = []
    for r in bounded_rets:
        z = (r["logRet"] - m_lr) / std_lr
        if abs(z) > tail_sigma:
            extremes.append({
                "time": r["time"],
                "date": r["date"],
                "logReturnPct": r["logRet"] * 100.0,
                "simpleReturnPct": (r["close"] / r["prevClose"] - 1.0) * 100.0,
                "zScore": z,
                "direction": "UP" if r["logRet"] >= 0 else "DOWN",
            })
    extremes.sort(key=lambda x: abs(x["zScore"]), reverse=True)

    month_rets: list[list[float]] = [[] for _ in range(12)]
    month_ym: list[dict[str, float]] = [{} for _ in range(12)]
    for r in bounded_rets:
        dt = datetime.fromtimestamp(r["time"], tz=timezone.utc)
        mi = dt.month - 1
        ym = r["date"][:7]
        month_rets[mi].append(r["logRet"])
        month_ym[mi][ym] = month_ym[mi].get(ym, 0.0) + r["logRet"]

    seasonality = []
    for mi, m_lbl in enumerate(MONTH_LABELS_ES):
        rs = month_rets[mi]
        m_simple = [(math.exp(v) - 1.0) * 100.0 for v in month_ym[mi].values()]
        ml = sum(rs) / len(rs) if rs else float("nan")
        sqm = sum((v - ml) ** 2 for v in rs) if rs else 0.0
        ann = 100.0 * math.sqrt((TRADING_DAYS_PER_YEAR * sqm) / (len(rs) - 1)) if len(rs) > 1 else float("nan")
        pos = sum(1 for v in m_simple if v > 0)
        seasonality.append({
            "monthIndex": mi,
            "monthLabel": m_lbl,
            "tradingDays": len(rs),
            "monthsSampled": len(m_simple),
            "meanDailyReturnPct": ml * 100.0 if rs else float("nan"),
            "avgMonthlyReturnPct": sum(m_simple) / len(m_simple) if m_simple else float("nan"),
            "annualizedVolPct": ann,
            "positiveMonthRatePct": (pos / len(m_simple)) * 100.0 if m_simple else float("nan"),
        })

    return {
        "status": "OK",
        "barsUsed": len(clean),
        "historyObservations": len(hist_series),
        "pairedObservations": paired,
        "currentEvalVolPct": cur_eval,
        "latestRv20Pct": rv20,
        "latestRv23Pct": rv23,
        "latestRv60Pct": rv60,
        "vrpVsRv23Pts": vrp,
        "ivRank": iv_rank,
        "ivPercentile": iv_pct,
        "quantiles": {"minPct": min_v, "p20Pct": p20, "p40Pct": p40, "p60Pct": p60, "p80Pct": p80, "maxPct": max_v, "medianPct": med},
        "operativeRegime": {"code": op_code},
        "buckets": buckets,
        "seasonalityMonths": seasonality,
        "extremeSessions": extremes,
    }


def py_expected_cone(inp: dict[str, Any]) -> dict[str, Any]:
    S = inp["spot"]
    sigma = inp["atmIvPct"] / 100.0
    days = inp["daysToExpiry"]
    r = inp["rate"]
    q = inp["dividendYield"]
    t = days / CALENDAR_DAYS_PER_YEAR
    sqrt_t = math.sqrt(t)
    daily_pct = (sigma / math.sqrt(TRADING_DAYS_PER_YEAR)) * 100.0
    daily_abs = (S * sigma) / math.sqrt(TRADING_DAYS_PER_YEAR)
    s_tau = sigma * sqrt_t
    mu_log = math.log(S) + (r - q - 0.5 * sigma * sigma) * t
    q_nodes = sorted(inp["qNodes"], key=lambda n: n["strike"])
    comp = []
    for n in q_nodes:
        z = (math.log(n["strike"]) - mu_log) / s_tau
        ln_pdf = norm_pdf(z) / (n["strike"] * s_tau)
        comp.append({"strike": n["strike"], "densityQ": n["densityQ"], "lognormalDensity": ln_pdf, "probAboveQ": n["probAboveQ"]})
    p_above_spot = interpolate_linear([(c["strike"], c["probAboveQ"]) for c in comp], S) * 100.0
    p_below_m10 = (1.0 - interpolate_linear([(c["strike"], c["probAboveQ"]) for c in comp], S * 0.9)) * 100.0
    return {
        "status": "OK",
        "dailyMoveAbs": daily_abs,
        "dailyMovePct": daily_pct,
        "horizonMove1SigmaPct": s_tau * 100.0,
        "upper1Sigma": S * math.exp(s_tau),
        "lower1Sigma": S * math.exp(-s_tau),
        "upper2Sigma": S * math.exp(2.0 * s_tau),
        "lower2Sigma": S * math.exp(-2.0 * s_tau),
        "probQAboveSpotPct": p_above_spot,
        "probQBelowMinus10Pct": max(0.0, min(100.0, p_below_m10)),
        "comparisonNodes": comp,
    }


def py_parity_rates(inp: dict[str, Any]) -> dict[str, Any]:
    spot_mid = inp["spotMid"]
    spot_bid = inp["spotBid"]
    spot_ask = inp["spotAsk"]
    days = inp["daysToExpiry"]
    q = inp["dividendYield"]
    bench = inp["benchmarkTeaPct"]
    t = days / CALENDAR_DAYS_PER_YEAR
    df = math.exp(-q * t)
    rows = []
    for p in sorted(inp["pairs"], key=lambda x: x["strike"]):
        K = p["strike"]
        c_mid = resolve_side_price({"bid": p["callBid"], "ask": p["callAsk"], "mid": p["callMid"]}, "mid")[0]
        p_mid = resolve_side_price({"bid": p["putBid"], "ask": p["putAsk"], "mid": p["putMid"]}, "mid")[0]
        cap_mid = spot_mid * df - (c_mid - p_mid)
        growth = K / cap_mid
        mid_tea = (math.pow(growth, 1.0 / t) - 1.0) * 100.0
        syn_fwd = K + (c_mid - p_mid) * growth

        tea_tom = float("nan")
        if is_pos_finite(p["callAsk"]) and is_pos_finite(p["putBid"]):
            cap_tom = spot_bid * df - (p["callAsk"] - p["putBid"])
            if cap_tom > 0:
                tea_tom = (math.pow(K / cap_tom, 1.0 / t) - 1.0) * 100.0

        tea_col = float("nan")
        if is_pos_finite(p["callBid"]) and is_pos_finite(p["putAsk"]):
            cap_col = spot_ask * df - (p["callBid"] - p["putAsk"])
            if cap_col > 0:
                tea_col = (math.pow(K / cap_col, 1.0 / t) - 1.0) * 100.0

        c_iv = p["callIvPct"] if is_pos_finite(p["callIvPct"]) else float("nan")
        p_iv = p["putIvPct"] if is_pos_finite(p["putIvPct"]) else float("nan")
        rows.append({
            "strike": K,
            "callIvPct": c_iv,
            "putIvPct": p_iv,
            "ivSpreadPp": c_iv - p_iv,
            "callMid": c_mid,
            "putMid": p_mid,
            "syntheticForwardMid": syn_fwd,
            "midImpliedTeaPct": mid_tea,
            "teaTomadoraPct": tea_tom,
            "teaColocadoraPct": tea_col,
            "canLendAboveBenchmark": math.isfinite(tea_col) and tea_col > bench,
            "canBorrowBelowBenchmark": math.isfinite(tea_tom) and tea_tom < bench,
            "edgeColocadoraBps": (tea_col - bench) * 100.0 if math.isfinite(tea_col) else float("nan"),
            "edgeTomadoraBps": (bench - tea_tom) * 100.0 if math.isfinite(tea_tom) else float("nan"),
        })

    near_atm = sorted(rows, key=lambda r: abs(r["strike"] - spot_mid))[:5]
    med_mid = linear_percentile(sorted(r["midImpliedTeaPct"] for r in near_atm if math.isfinite(r["midImpliedTeaPct"])), 0.5)
    med_tom = linear_percentile(sorted(r["teaTomadoraPct"] for r in near_atm if math.isfinite(r["teaTomadoraPct"])), 0.5)
    med_col = linear_percentile(sorted(r["teaColocadoraPct"] for r in near_atm if math.isfinite(r["teaColocadoraPct"])), 0.5)
    best_col = max([r for r in rows if math.isfinite(r["teaColocadoraPct"])], key=lambda r: r["teaColocadoraPct"])
    best_tom = min([r for r in rows if math.isfinite(r["teaTomadoraPct"])], key=lambda r: r["teaTomadoraPct"])

    return {
        "status": "OK",
        "medianMidTeaPct": med_mid,
        "medianTeaTomadoraPct": med_tom,
        "medianTeaColocadoraPct": med_col,
        "bestColocadoraStrike": best_col["strike"],
        "bestColocadoraTeaPct": best_col["teaColocadoraPct"],
        "bestTomadoraStrike": best_tom["strike"],
        "bestTomadoraTeaPct": best_tom["teaTomadoraPct"],
        "strikes": rows,
    }


def py_ratios_and_structures(inp: dict[str, Any]) -> dict[str, Any]:
    S = inp["spot"]
    days = inp["daysToExpiry"]
    r = inp["rate"]
    q = inp["dividendYield"]
    T = days / CALENDAR_DAYS_PER_YEAR
    strikes = sorted(inp["strikes"], key=lambda s: s["strike"])
    hist_vols = inp["historicalVolPctSeries"][-252:]

    def get_leg(row: dict[str, Any], ct: str, side: str) -> tuple[float, str]:
        if ct == "call":
            return resolve_side_price({"bid": row.get("callBid"), "ask": row.get("callAsk"), "mid": row.get("callMid")}, side)
        return resolve_side_price({"bid": row.get("putBid"), "ask": row.get("putAsk"), "mid": row.get("putMid")}, side)

    call_ratios = []
    anchor_c = sorted([s for s in strikes if is_pos_finite(get_leg(s, "call", "buy")[0])], key=lambda s: abs(s["strike"] - S))[0]
    lc_price, lc_src = get_leg(anchor_c, "call", "buy")
    seen_cs: set[float] = set()
    for off in [5, 10, 15]:
        tk = S * (1.0 + off / 100.0)
        cand = sorted([s for s in strikes if s["strike"] > anchor_c["strike"] and s["strike"] not in seen_cs and is_pos_finite(get_leg(s, "call", "sell")[0])], key=lambda s: abs(s["strike"] - tk))[0]
        seen_cs.add(cand["strike"])
        sc_price, sc_src = get_leg(cand, "call", "sell")
        net_cash = 2.0 * sc_price - lc_price
        call_ratios.append({
            "side": "CALL",
            "targetOffsetPct": off,
            "longStrike": anchor_c["strike"],
            "longPrice": lc_price,
            "shortStrike": cand["strike"],
            "shortPrice": sc_price,
            "otmLotsPerBought": lc_price / sc_price,
            "netCash1x2": net_cash,
            "outerBreakeven1x2": 2.0 * cand["strike"] - anchor_c["strike"] + net_cash,
        })

    put_ratios = []
    anchor_p = sorted([s for s in strikes if is_pos_finite(get_leg(s, "put", "buy")[0])], key=lambda s: abs(s["strike"] - S))[0]
    lp_price, _ = get_leg(anchor_p, "put", "buy")
    seen_ps: set[float] = set()
    for off in [-5, -10, -15]:
        tk = S * (1.0 + off / 100.0)
        cand = sorted([s for s in strikes if s["strike"] < anchor_p["strike"] and s["strike"] not in seen_ps and is_pos_finite(get_leg(s, "put", "sell")[0])], key=lambda s: abs(s["strike"] - tk))[0]
        seen_ps.add(cand["strike"])
        sp_price, _ = get_leg(cand, "put", "sell")
        net_cash = 2.0 * sp_price - lp_price
        put_ratios.append({
            "side": "PUT",
            "targetOffsetPct": off,
            "longStrike": anchor_p["strike"],
            "longPrice": lp_price,
            "shortStrike": cand["strike"],
            "shortPrice": sp_price,
            "otmLotsPerBought": lp_price / sp_price,
            "netCash1x2": net_cash,
            "outerBreakeven1x2": 2.0 * cand["strike"] - anchor_p["strike"] - net_cash,
        })

    def bs2002_pct(cur_cost_pct: float, gross_width: float, price_fn: Any) -> tuple[float, float, float, float, int]:
        ratios = []
        for vp in hist_vols:
            td = price_fn(vp / 100.0)
            if 0.0 < td < gross_width:
                cp = (td / (gross_width - td)) * 100.0
                if math.isfinite(cp) and cp > 0.0:
                    ratios.append(cp)
        ratios.sort()
        le = sum(1 for x in ratios if x <= cur_cost_pct)
        return (le / len(ratios)) * 100.0, ratios[0], linear_percentile(ratios, 0.5), ratios[-1], len(ratios)

    structures = []
    # Bull Call
    bull_s = sorted([s for s in strikes if s["strike"] > anchor_c["strike"] and is_pos_finite(get_leg(s, "call", "sell")[0])], key=lambda s: abs(s["strike"] - anchor_c["strike"] * 1.05))[0]
    w_bc = bull_s["strike"] - anchor_c["strike"]
    deb_bc = lc_price - get_leg(bull_s, "call", "sell")[0]
    mp_bc = w_bc - deb_bc
    cost_mp_bc = (deb_bc / mp_bc) * 100.0
    p_bc, mn_bc, md_bc, mx_bc, obs_bc = bs2002_pct(
        cost_mp_bc, w_bc,
        lambda v: bs02_american_py(S, anchor_c["strike"], T, r, q, v, "call") - bs02_american_py(S, bull_s["strike"], T, r, q, v, "call"),
    )
    structures.append({
        "id": "BULL_CALL_5",
        "strikes": [anchor_c["strike"], bull_s["strike"]],
        "width": w_bc,
        "netDebit": deb_bc,
        "maxProfit": mp_bc,
        "costPctOfMaxProfit": cost_mp_bc,
        "costPctOfWidth": (deb_bc / w_bc) * 100.0,
        "rewardRiskRatio": mp_bc / deb_bc,
        "bs2002HistoricalPercentile": p_bc,
        "bs2002HistoricalMinPct": mn_bc,
        "bs2002HistoricalMedianPct": md_bc,
        "bs2002HistoricalMaxPct": mx_bc,
        "bs2002HistoricalObs": obs_bc,
    })

    # Bear Put
    bear_s = sorted([s for s in strikes if s["strike"] < anchor_p["strike"] and is_pos_finite(get_leg(s, "put", "sell")[0])], key=lambda s: abs(s["strike"] - anchor_p["strike"] * 0.95))[0]
    w_bp = anchor_p["strike"] - bear_s["strike"]
    deb_bp = lp_price - get_leg(bear_s, "put", "sell")[0]
    mp_bp = w_bp - deb_bp
    cost_mp_bp = (deb_bp / mp_bp) * 100.0
    p_bp, mn_bp, md_bp, mx_bp, obs_bp = bs2002_pct(
        cost_mp_bp, w_bp,
        lambda v: bs02_american_py(S, anchor_p["strike"], T, r, q, v, "put") - bs02_american_py(S, bear_s["strike"], T, r, q, v, "put"),
    )
    structures.append({
        "id": "BEAR_PUT_5",
        "strikes": [bear_s["strike"], anchor_p["strike"]],
        "width": w_bp,
        "netDebit": deb_bp,
        "maxProfit": mp_bp,
        "costPctOfMaxProfit": cost_mp_bp,
        "costPctOfWidth": (deb_bp / w_bp) * 100.0,
        "rewardRiskRatio": mp_bp / deb_bp,
        "bs2002HistoricalPercentile": p_bp,
        "bs2002HistoricalMinPct": mn_bp,
        "bs2002HistoricalMedianPct": md_bp,
        "bs2002HistoricalMaxPct": mx_bp,
        "bs2002HistoricalObs": obs_bp,
    })

    # Butterfly
    c_all = [s for s in strikes if is_pos_finite(get_leg(s, "call", "buy")[0]) and is_pos_finite(get_leg(s, "call", "sell")[0])]
    center = sorted(c_all[1:-1], key=lambda s: abs(s["strike"] - S))[0]
    lowers = [s for s in c_all if s["strike"] < center["strike"]]
    uppers = [s for s in c_all if s["strike"] > center["strike"]]
    target_hw = S * 0.05
    best = None
    for lo_r in lowers:
        wl = center["strike"] - lo_r["strike"]
        for up_r in uppers:
            wr = up_r["strike"] - center["strike"]
            asym = abs(wl - wr)
            td = abs(0.5 * (wl + wr) - target_hw)
            if best is None or asym < best[2] - 1e-6 or (abs(asym - best[2]) <= 1e-6 and td < best[3]):
                best = (lo_r, up_r, asym, td)
    assert best is not None
    k1_r, k3_r, _, _ = best
    deb_bf = get_leg(k1_r, "call", "buy")[0] - 2.0 * get_leg(center, "call", "sell")[0] + get_leg(k3_r, "call", "buy")[0]
    lw = center["strike"] - k1_r["strike"]
    rw = k3_r["strike"] - center["strike"]
    max_risk_bf = deb_bf + max(0.0, rw - lw)
    mp_bf = lw - deb_bf
    cost_mp_bf = (deb_bf / mp_bf) * 100.0
    p_bf, mn_bf, md_bf, mx_bf, obs_bf = bs2002_pct(
        cost_mp_bf, lw,
        lambda v: (
            bs02_american_py(S, k1_r["strike"], T, r, q, v, "call")
            - 2.0 * bs02_american_py(S, center["strike"], T, r, q, v, "call")
            + bs02_american_py(S, k3_r["strike"], T, r, q, v, "call")
        ),
    )
    structures.append({
        "id": "BUTTERFLY_SYM",
        "strikes": [k1_r["strike"], center["strike"], k3_r["strike"]],
        "width": lw,
        "netDebit": deb_bf,
        "maxProfit": mp_bf,
        "costPctOfMaxProfit": cost_mp_bf,
        "costPctOfWidth": (deb_bf / lw) * 100.0,
        "rewardRiskRatio": mp_bf / max_risk_bf,
        "bs2002HistoricalPercentile": p_bf,
        "bs2002HistoricalMinPct": mn_bf,
        "bs2002HistoricalMedianPct": md_bf,
        "bs2002HistoricalMaxPct": mx_bf,
        "bs2002HistoricalObs": obs_bf,
    })

    return {"status": "OK", "callRatios": call_ratios, "putRatios": put_ratios, "structures": structures}


def py_dual_surface(inp: dict[str, Any]) -> dict[str, Any]:
    offsets = list(DEFAULT_OFFSETS_PCT)
    byma_pts = sorted([(p["moneynessPct"], p["ivPct"]) for p in inp["bymaCompositeOtmPoints"]], key=lambda x: x[0])
    opra_pts = sorted([(p["moneynessPct"], p["ivPct"]) for p in inp["opraCompositeOtmPoints"]], key=lambda x: x[0])
    s_ccl = inp["cclAnnualVolPct"] / 100.0
    rho = inp["corrAdrCcl"]

    def theo(opra_iv_pct: float) -> float:
        if not is_pos_finite(opra_iv_pct):
            return float("nan")
        s_adr = opra_iv_pct / 100.0
        return math.sqrt(max(0.0, s_adr * s_adr + s_ccl * s_ccl + 2.0 * rho * s_adr * s_ccl)) * 100.0

    nodes = []
    for off in offsets:
        b_iv = interpolate_linear(byma_pts, off)
        o_iv = interpolate_linear(opra_pts, off)
        t_iv = theo(o_iv)
        nodes.append({
            "offsetPct": off,
            "bymaIvPct": b_iv,
            "opraAdrIvPct": o_iv,
            "theoreticalBymaIvPct": t_iv,
            "spreadBymaMinusOpraPp": b_iv - o_iv if math.isfinite(b_iv) and math.isfinite(o_iv) else float("nan"),
            "spreadBymaMinusTheoreticalPp": b_iv - t_iv if math.isfinite(b_iv) and math.isfinite(t_iv) else float("nan"),
        })
    b_atm = interpolate_linear(byma_pts, 0.0)
    o_atm = interpolate_linear(opra_pts, 0.0)
    t_atm = theo(o_atm)
    return {
        "status": "OK",
        "bymaAtmIvPct": b_atm,
        "opraAtmIvPct": o_atm,
        "theoreticalAtmIvPct": t_atm,
        "atmSpreadBymaVsOpraPp": b_atm - o_atm,
        "atmSpreadBymaVsTheoreticalPp": b_atm - t_atm,
        "nodes": nodes,
    }


def main() -> None:
    spot = 7000.0
    rate = 0.35
    div_q = 0.01

    # 1) Short DTE slice con bases ITM contaminadas (>150%) + sonrisa limpia OTM
    short_contracts = [
        {"strike": 5600.0, "contractType": "call", "iv": 1.85, "bid": 1410.0, "ask": 1450.0, "mid": 1430.0},
        {"strike": 6300.0, "contractType": "put", "iv": 0.62, "bid": 4.2, "ask": 5.0, "mid": 4.6},
        {"strike": 6650.0, "contractType": "put", "iv": 0.56, "bid": 24.0, "ask": 27.0, "mid": 25.5},
        {"strike": 7000.0, "contractType": "put", "iv": 0.51, "bid": 115.0, "ask": 122.0, "mid": 118.5},
        {"strike": 7000.0, "contractType": "call", "iv": 0.52, "bid": 152.0, "ask": 160.0, "mid": 156.0},
        {"strike": 7350.0, "contractType": "call", "iv": 0.49, "bid": 31.0, "ask": 35.0, "mid": 33.0},
        {"strike": 7700.0, "contractType": "call", "iv": 0.47, "bid": 6.5, "ask": 8.0, "mid": 7.25},
        {"strike": 8400.0, "contractType": "put", "iv": 1.92, "bid": 1360.0, "ask": 1405.0, "mid": 1382.5},
    ]
    short_smile_input = {
        "spot": spot,
        "timeToExpiryYears": 4.0 / 365.0,
        "daysToExpiry": 4,
        "rate": rate,
        "dividendYield": div_q,
        "contracts": short_contracts,
    }
    short_otm_only = py_build_separated_otm_smile(short_smile_input, only_otm=True)
    short_all = py_build_separated_otm_smile(short_smile_input, only_otm=False)

    # 2) Mid (35d) y Far (65d) expiries para sonrisa, 25Δ RR y Matriz por Moneyness
    mid_contracts = [
        {"strike": 5600.0, "contractType": "put", "iv": 0.61, "bid": 28.0, "ask": 32.0, "mid": 30.0},
        {"strike": 6300.0, "contractType": "put", "iv": 0.55, "bid": 96.0, "ask": 104.0, "mid": 100.0},
        {"strike": 6650.0, "contractType": "put", "iv": 0.51, "bid": 195.0, "ask": 207.0, "mid": 201.0},
        {"strike": 7000.0, "contractType": "put", "iv": 0.48, "bid": 348.0, "ask": 364.0, "mid": 356.0},
        {"strike": 7000.0, "contractType": "call", "iv": 0.49, "bid": 560.0, "ask": 580.0, "mid": 570.0},
        {"strike": 7350.0, "contractType": "call", "iv": 0.46, "bid": 385.0, "ask": 401.0, "mid": 393.0},
        {"strike": 7700.0, "contractType": "call", "iv": 0.45, "bid": 252.0, "ask": 266.0, "mid": 259.0},
        {"strike": 8400.0, "contractType": "call", "iv": 0.44, "bid": 98.0, "ask": 106.0, "mid": 102.0},
        {"strike": 8750.0, "contractType": "call", "iv": 0.455, "bid": 58.0, "ask": 64.0, "mid": 61.0},
    ]
    mid_smile_input = {
        "spot": spot,
        "timeToExpiryYears": 35.0 / 365.0,
        "daysToExpiry": 35,
        "rate": rate,
        "dividendYield": div_q,
        "contracts": mid_contracts,
    }
    mid_smile = py_build_separated_otm_smile(mid_smile_input, only_otm=True)

    far_contracts = [
        {"strike": 5600.0, "contractType": "put", "iv": 0.63},
        {"strike": 6300.0, "contractType": "put", "iv": 0.58},
        {"strike": 7000.0, "contractType": "put", "iv": 0.53},
        {"strike": 7000.0, "contractType": "call", "iv": 0.54},
        {"strike": 7700.0, "contractType": "call", "iv": 0.50},
        {"strike": 8400.0, "contractType": "call", "iv": 0.49},
    ]
    far_smile = py_build_separated_otm_smile(
        {"spot": spot, "timeToExpiryYears": 65.0 / 365.0, "daysToExpiry": 65, "rate": rate, "dividendYield": div_q, "contracts": far_contracts},
        only_otm=True,
    )

    matrix_slices = [
        {"expiryCode": "SHORT4D", "expiryLabel": "VTO 4D", "daysToExpiry": 4, "compositeOtmPoints": short_otm_only["compositeOtmPoints"], "fallbackAtmIvPct": short_otm_only["atmIvPct"]},
        {"expiryCode": "MID35D", "expiryLabel": "VTO 35D", "daysToExpiry": 35, "compositeOtmPoints": mid_smile["compositeOtmPoints"], "fallbackAtmIvPct": mid_smile["atmIvPct"]},
        {"expiryCode": "FAR65D", "expiryLabel": "VTO 65D", "daysToExpiry": 65, "compositeOtmPoints": far_smile["compositeOtmPoints"], "fallbackAtmIvPct": far_smile["atmIvPct"]},
    ]
    moneyness_matrix = py_build_moneyness_matrix(matrix_slices)

    # 3) Serie histórica determinista de 320 ruedas UTC diarias con regímenes variables y 2 ruedas extremas (>3σ)
    base_ts = int(datetime(2025, 1, 2, 18, 0, tzinfo=timezone.utc).timestamp())
    bars: list[dict[str, Any]] = []
    px = 5200.0
    for idx in range(320):
        ts = base_ts + idx * 86400
        # Regímenes alternantes de amplitud determinista
        amp = 0.008 + 0.018 * abs(math.sin(idx / 28.0))
        lr = amp * math.sin(idx * 1.13 + 0.4) + 0.0006
        if idx == 110:
            lr = 0.145
        elif idx == 235:
            lr = -0.132
        px = px * math.exp(lr)
        bars.append({"time": ts, "close": round(px, 6)})

    hist_cond = py_historical_vol_conditional(bars, current_iv_atm=52.5)
    rv_dist_20 = py_rolling_rv_distribution(bars, 20)
    rv_dist_60 = py_rolling_rv_distribution(bars, 60)
    rv_dist_120 = py_rolling_rv_distribution(bars, 120)

    # 4) Cono esperado & densidad Breeden-Litzenberger Q vs Lognormal
    cone_q_nodes = []
    q_strikes = [5900.0, 6200.0, 6500.0, 6750.0, 7000.0, 7250.0, 7500.0, 7800.0, 8100.0]
    for k_v in q_strikes:
        z_v = math.log(k_v / spot) / (0.48 * math.sqrt(35.0 / 365.0))
        d_q = norm_pdf(z_v * 0.96) / (k_v * 0.48 * math.sqrt(35.0 / 365.0))
        p_abv = norm_cdf(-z_v * 0.96)
        cone_q_nodes.append({"strike": k_v, "densityQ": d_q, "probAboveQ": p_abv})
    cone_input = {"spot": spot, "atmIvPct": 48.5, "daysToExpiry": 35, "rate": rate, "dividendYield": div_q, "qNodes": cone_q_nodes}
    expected_cone = py_expected_cone(cone_input)

    # 5) Paridad Call-Put y TEA Tomadora/Colocadora
    parity_pairs = [
        {"strike": 6650.0, "callBid": 640.0, "callAsk": 656.0, "callMid": 648.0, "callIvPct": 51.8, "putBid": 146.0, "putAsk": 154.0, "putMid": 150.0, "putIvPct": 50.9},
        {"strike": 7000.0, "callBid": 438.0, "callAsk": 452.0, "callMid": 445.0, "callIvPct": 49.2, "putBid": 270.0, "putAsk": 280.0, "putMid": 275.0, "putIvPct": 48.4},
        {"strike": 7350.0, "callBid": 285.0, "callAsk": 297.0, "callMid": 291.0, "callIvPct": 47.0, "putBid": 452.0, "putAsk": 466.0, "putMid": 459.0, "putIvPct": 46.5},
        {"strike": 7700.0, "callBid": 195.0, "callAsk": 203.0, "callMid": 199.0, "callIvPct": 46.1, "putBid": 672.0, "putAsk": 684.0, "putMid": 678.0, "putIvPct": 46.0},
    ]
    parity_input = {
        "spotMid": 7000.0,
        "spotBid": 6995.0,
        "spotAsk": 7005.0,
        "daysToExpiry": 30,
        "dividendYield": div_q,
        "benchmarkTeaPct": 38.0,
        "benchmarkLabel": "Caución 30d",
        "pairs": parity_pairs,
    }
    parity_result = py_parity_rates(parity_input)

    # 6) Ratios 1:N & Costo Relativo Estructuras + Percentil BS2002
    struct_strikes = [
        {"strike": 6000.0, "putBid": 56.0, "putAsk": 62.0, "putMid": 59.0, "callBid": 1190.0, "callAsk": 1220.0, "callMid": 1205.0},
        {"strike": 6300.0, "putBid": 106.0, "putAsk": 114.0, "putMid": 110.0, "callBid": 950.0, "callAsk": 975.0, "callMid": 962.5},
        {"strike": 6650.0, "putBid": 202.0, "putAsk": 212.0, "putMid": 207.0, "callBid": 715.0, "callAsk": 735.0, "callMid": 725.0},
        {"strike": 7000.0, "putBid": 348.0, "putAsk": 362.0, "putMid": 355.0, "callBid": 558.0, "callAsk": 576.0, "callMid": 567.0},
        {"strike": 7350.0, "putBid": 556.0, "putAsk": 574.0, "putMid": 565.0, "callBid": 385.0, "callAsk": 401.0, "callMid": 393.0},
        {"strike": 7700.0, "putBid": 810.0, "putAsk": 835.0, "putMid": 822.5, "callBid": 250.0, "callAsk": 264.0, "callMid": 257.0},
        {"strike": 8050.0, "putBid": 1110.0, "putAsk": 1140.0, "putMid": 1125.0, "callBid": 152.0, "callAsk": 164.0, "callMid": 158.0},
    ]
    hist_vol_series = [32.0 + 0.36 * i for i in range(120)]
    ratios_input = {
        "spot": spot,
        "daysToExpiry": 35,
        "rate": rate,
        "dividendYield": div_q,
        "strikes": struct_strikes,
        "historicalVolPctSeries": hist_vol_series,
    }
    ratios_result = py_ratios_and_structures(ratios_input)

    # 7) Dual BYMA (ARS) vs OPRA ADR (USD)
    opra_comp = [
        {"moneynessPct": -15.0, "ivPct": 52.0},
        {"moneynessPct": -10.0, "ivPct": 49.0},
        {"moneynessPct": -5.0, "ivPct": 46.5},
        {"moneynessPct": 0.0, "ivPct": 44.0},
        {"moneynessPct": 5.0, "ivPct": 42.5},
        {"moneynessPct": 10.0, "ivPct": 42.0},
        {"moneynessPct": 15.0, "ivPct": 43.0},
    ]
    dual_input = {
        "arUnderlying": "GGAL",
        "adrTicker": "GGAL",
        "adrRatio": 10,
        "bymaSpotArs": 7140.0,
        "adrSpotUsd": 59.5,
        "cclImplicit": 1200.0,
        "bymaExpiryCode": "MID35D",
        "bymaDays": 35,
        "opraExpiryDate": "2026-06-19",
        "opraDays": 35,
        "bymaCompositeOtmPoints": mid_smile["compositeOtmPoints"],
        "opraCompositeOtmPoints": opra_comp,
        "cclAnnualVolPct": 24.0,
        "corrAdrCcl": 0.35,
    }
    dual_result = py_dual_surface(dual_input)

    payload = {
        "inputs": {
            "shortSmile": short_smile_input,
            "midSmile": mid_smile_input,
            "matrixSlices": matrix_slices,
            "bars": bars,
            "expectedCone": cone_input,
            "parity": parity_input,
            "ratiosAndStructures": ratios_input,
            "dualSurface": dual_input,
        },
        "expected": {
            "shortSmileOtmOnly": short_otm_only,
            "shortSmileAll": short_all,
            "midSmileOtmOnly": mid_smile,
            "moneynessMatrix": moneyness_matrix,
            "historicalVolConditional": hist_cond,
            "rvDistributions": {"rv20": rv_dist_20, "rv60": rv_dist_60, "rv120": rv_dist_120},
            "expectedCone": expected_cone,
            "parity": parity_result,
            "ratiosAndStructures": ratios_result,
            "dualSurface": dual_result,
        },
    }

    out_path = Path("fixtures/vol_analytics_suite_reference.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(clean_json(payload), indent=2), encoding="utf-8")
    print(f"Generated {out_path} ({out_path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
