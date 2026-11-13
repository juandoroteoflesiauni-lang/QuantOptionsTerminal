"""Independent Python reference fixture generator for Pieza 3 (options/forward.ts & options/american.ts).

Uses completely independent mathematical implementations from the TypeScript code:
- Standard bivariate normal CDF via 1D composite Simpson integration of N((b - rho*x)/sqrt(1-rho^2)) * phi(x)
- Textbook Bjerksund-Stensland (2002) closed-form formulas + independent European BSM check
- High-resolution continuous CRR binomial tree benchmark with Richardson extrapolation (N=1000, 2000)
- Central finite-difference American Greeks + exact analytical BSM Greeks on Merton zero-early-exercise domain
- Independent escrowed-dividend CRR tree with discrete cash dividends
- Pure 150-iteration bisection for American implied volatility (independent from TS Brent solver)
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

SQRT_2 = math.sqrt(2.0)
SQRT_2PI = math.sqrt(2.0 * math.pi)
GOLDEN_PHI_INV = 0.5 * (math.sqrt(5.0) - 1.0)


def norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / SQRT_2PI


def norm_cdf(x: float) -> float:
    return 0.5 * math.erfc(-x / SQRT_2)


def bvn_independent_integral(a: float, b: float, rho: float) -> float:
    """Computes P(X <= a, Y <= b) by 1D composite Simpson integration over x in (-inf, a]."""
    if rho < -1.0 or rho > 1.0 or math.isnan(a) or math.isnan(b) or math.isnan(rho):
        return float("nan")
    if abs(rho) < 1e-15:
        return norm_cdf(a) * norm_cdf(b)
    if rho >= 1.0 - 1e-15:
        return norm_cdf(min(a, b))
    if rho <= -1.0 + 1e-15:
        return max(0.0, norm_cdf(a) - norm_cdf(-b))

    # Symmetry for negative correlation reduces variance and avoids extreme integrand slopes:
    if rho < 0.0:
        return max(0.0, min(1.0, norm_cdf(a) - bvn_independent_integral(a, -b, -rho)))

    if a <= -9.0 or b <= -9.0:
        return 0.0
    if a >= 9.0 and b >= 9.0:
        return 1.0

    # Integrate int_{lo}^{a} phi(x) * N((b - rho*x)/sqrt(1-rho^2)) dx using composite Simpson.
    lo = -9.0
    hi = min(a, 9.0)
    if hi <= lo:
        return 0.0
    n = 8000  # must be even
    h = (hi - lo) / n
    sqrt_1_m_r2 = math.sqrt(1.0 - rho * rho)

    def f(x: float) -> float:
        return norm_pdf(x) * norm_cdf((b - rho * x) / sqrt_1_m_r2)

    total = f(lo) + f(hi)
    for idx in range(1, n):
        x = lo + idx * h
        total += (4.0 if idx % 2 == 1 else 2.0) * f(x)
    val = total * (h / 3.0)
    return max(0.0, min(1.0, val))


def bsm_price_py(S: float, K: float, T: float, r: float, q: float, sigma: float, contract: str) -> float:
    srt = sigma * math.sqrt(T)
    d1 = (math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / srt
    d2 = d1 - srt
    if contract == "call":
        return S * math.exp(-q * T) * norm_cdf(d1) - K * math.exp(-r * T) * norm_cdf(d2)
    return K * math.exp(-r * T) * norm_cdf(-d2) - S * math.exp(-q * T) * norm_cdf(-d1)


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


def crr_discrete_py(
    S: float,
    K: float,
    T: float,
    r: float,
    q: float,
    sigma: float,
    contract: str,
    steps: int,
    dividends: list[dict[str, float]] | None = None,
) -> float:
    divs = dividends or []
    pv0 = sum(d["amount"] * math.exp(-r * d["time"]) for d in divs)
    s_star = S - pv0
    if s_star <= 0.0:
        return float("nan")
    dt = T / steps
    log_u = sigma * math.sqrt(dt)
    u = math.exp(log_u)
    d = 1.0 / u
    disc = math.exp(-r * dt)
    p = (math.exp((r - q) * dt) - d) / (u - d)
    if not (0.0 < p < 1.0):
        return float("nan")

    # Build explicit spot lattice backwards
    is_call = contract == "call"
    vals = [
        max(0.0, (s_star * math.exp((steps - 2 * j) * log_u) - K) if is_call else (K - s_star * math.exp((steps - 2 * j) * log_u)))
        for j in range(steps + 1)
    ]
    for i in range(steps - 1, -1, -1):
        t = i * dt
        pv_rem = sum(dv["amount"] * math.exp(-r * (dv["time"] - t)) for dv in divs if dv["time"] > t)
        new_vals = [0.0] * (i + 1)
        for j in range(i + 1):
            hold = disc * (p * vals[j] + (1.0 - p) * vals[j + 1])
            cum_s = s_star * math.exp((i - 2 * j) * log_u) + pv_rem
            ex = (cum_s - K) if is_call else (K - cum_s)
            new_vals[j] = ex if ex > hold else hold
        vals = new_vals
    return vals[0]


def crr_richardson_benchmark(S: float, K: float, T: float, r: float, q: float, sigma: float, contract: str) -> float:
    v2000 = crr_discrete_py(S, K, T, r, q, sigma, contract, 2000)
    v1000 = crr_discrete_py(S, K, T, r, q, sigma, contract, 1000)
    return 2.0 * v2000 - v1000


def bsm_greeks_py(S: float, K: float, T: float, r: float, q: float, sigma: float, contract: str) -> dict[str, float]:
    srt = sigma * math.sqrt(T)
    d1 = (math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / srt
    d2 = d1 - srt
    df_q = math.exp(-q * T)
    df_r = math.exp(-r * T)
    pdf1 = norm_pdf(d1)
    price = bsm_price_py(S, K, T, r, q, sigma, contract)
    gamma = (df_q * pdf1) / (S * srt)
    vega = S * df_q * pdf1 * math.sqrt(T)
    vanna = -df_q * pdf1 * (d2 / sigma)
    cd_ratio = (2.0 * (r - q) * T - d2 * srt) / (2.0 * T * srt)
    c_common = df_q * pdf1 * cd_ratio
    if contract == "call":
        delta = df_q * norm_cdf(d1)
        theta = -(S * df_q * pdf1 * sigma) / (2.0 * math.sqrt(T)) + q * S * df_q * norm_cdf(d1) - r * K * df_r * norm_cdf(d2)
        rho = K * T * df_r * norm_cdf(d2)
        charm = q * df_q * norm_cdf(d1) - c_common
    else:
        delta = df_q * (norm_cdf(d1) - 1.0)
        theta = -(S * df_q * pdf1 * sigma) / (2.0 * math.sqrt(T)) - q * S * df_q * norm_cdf(-d1) + r * K * df_r * norm_cdf(-d2)
        rho = -K * T * df_r * norm_cdf(-d2)
        charm = -q * df_q * norm_cdf(-d1) - c_common
    return {
        "price": price,
        "delta": delta,
        "gamma": gamma,
        "theta": theta,
        "thetaDaily": theta / 365.0,
        "vega": vega,
        "vegaPer1Pct": vega / 100.0,
        "rho": rho,
        "vanna": vanna,
        "charm": charm,
    }


def american_greeks_py(S: float, K: float, T: float, r: float, q: float, sigma: float, contract: str) -> dict[str, float]:
    if (contract == "call" and r >= 0.0 and q <= 0.0) or (contract == "put" and r <= 0.0 and q >= 0.0):
        return bsm_greeks_py(S, K, T, r, q, sigma, contract)
    price = bs02_american_py(S, K, T, r, q, sigma, contract)
    hS = S * 1e-4
    hV = min(sigma * 1e-4, 0.25 * sigma)
    hT = min(1e-4, 0.25 * T)
    hR = 1e-4

    v_up_s = bs02_american_py(S + hS, K, T, r, q, sigma, contract)
    v_dn_s = bs02_american_py(S - hS, K, T, r, q, sigma, contract)
    delta = (v_up_s - v_dn_s) / (2.0 * hS)
    gamma = (v_up_s - 2.0 * price + v_dn_s) / (hS * hS)

    v_up_t = bs02_american_py(S, K, T + hT, r, q, sigma, contract)
    v_dn_t = bs02_american_py(S, K, T - hT, r, q, sigma, contract)
    theta = (v_dn_t - v_up_t) / (2.0 * hT)

    v_up_v = bs02_american_py(S, K, T, r, q, sigma + hV, contract)
    v_dn_v = bs02_american_py(S, K, T, r, q, sigma - hV, contract)
    vega = (v_up_v - v_dn_v) / (2.0 * hV)

    if contract == "call" and r - hR < 0.0:
        v_up_r = bs02_american_py(S, K, T, r + hR, q, sigma, contract)
        v_up_2r = bs02_american_py(S, K, T, r + 2.0 * hR, q, sigma, contract)
        rho = (-3.0 * price + 4.0 * v_up_r - v_up_2r) / (2.0 * hR)
    else:
        v_up_r = bs02_american_py(S, K, T, r + hR, q, sigma, contract)
        v_dn_r = bs02_american_py(S, K, T, r - hR, q, sigma, contract)
        rho = (v_up_r - v_dn_r) / (2.0 * hR)

    v_uu = bs02_american_py(S + hS, K, T, r, q, sigma + hV, contract)
    v_ud = bs02_american_py(S + hS, K, T, r, q, sigma - hV, contract)
    v_du = bs02_american_py(S - hS, K, T, r, q, sigma + hV, contract)
    v_dd = bs02_american_py(S - hS, K, T, r, q, sigma - hV, contract)
    vanna = (v_uu - v_ud - v_du + v_dd) / (4.0 * hS * hV)

    delta_up_t = (bs02_american_py(S + hS, K, T + hT, r, q, sigma, contract) - bs02_american_py(S - hS, K, T + hT, r, q, sigma, contract)) / (2.0 * hS)
    delta_dn_t = (bs02_american_py(S + hS, K, T - hT, r, q, sigma, contract) - bs02_american_py(S - hS, K, T - hT, r, q, sigma, contract)) / (2.0 * hS)
    charm = (delta_dn_t - delta_up_t) / (2.0 * hT)

    return {
        "price": price,
        "delta": delta,
        "gamma": gamma,
        "theta": theta,
        "thetaDaily": theta / 365.0,
        "vega": vega,
        "vegaPer1Pct": vega / 100.0,
        "rho": rho,
        "vanna": vanna,
        "charm": charm,
    }


def solve_iv_bisection_py(
    S: float,
    K: float,
    T: float,
    r: float,
    q: float,
    contract: str,
    target_price: float,
    dividends: list[dict[str, float]] | None = None,
    steps: int | None = None,
) -> float:
    lo = 1e-8
    hi = 15.0 if steps is None else min(15.0, 650.0 / math.sqrt(steps * T))
    for _ in range(150):
        mid = 0.5 * (lo + hi)
        val = (
            bs02_american_py(S, K, T, r, q, mid, contract)
            if steps is None and not dividends
            else crr_discrete_py(S, K, T, r, q, mid, contract, steps or 200, dividends)
        )
        if val < target_price:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def serialize_val(v: Any) -> Any:
    if isinstance(v, float) and math.isnan(v):
        return "NaN"
    if isinstance(v, dict):
        return {k: serialize_val(val) for k, val in v.items()}
    if isinstance(v, list):
        return [serialize_val(x) for x in v]
    return v


def build_fixtures() -> dict[str, Any]:
    # 1. Bivariate normal quadrature checks
    bvn_cases = []
    for a, b, rho in [
        (0.0, 0.0, 0.5),
        (0.0, 0.0, -0.5),
        (0.3, -0.4, -0.7861513777574233),
        (1.2, 0.7, 0.45),
        (-1.5, -0.8, 0.90),
        (0.5, 0.3, 0.98),
        (0.5, 0.3, -0.98),
        (-0.3, -0.5, -0.99),
        (0.8, 0.8, 1.0),
        (0.8, -0.8, -1.0),
        (0.4, -0.2, 0.0),
    ]:
        bvn_cases.append({"a": a, "b": b, "rho": rho, "expected": bvn_independent_integral(a, b, rho)})

    # 2. Forward & implied dividend yield from put-call parity
    # Construct synthetic parity pairs matching exact F(T) plus realistic spread/filtering perturbations
    forward_cases: list[dict[str, Any]] = []

    def median_py(xs: list[float]) -> float:
        s = sorted(xs)
        n = len(s)
        return s[n // 2] if n % 2 == 1 else 0.5 * (s[n // 2 - 1] + s[n // 2])

    # Case A: Clean SPY-like 30DTE parity chain (exact F = 552.10, df = exp(-0.045 * 30/365))
    T_spy = 30.0 / 365.0
    r_spy = 0.045
    q_spy = 0.013
    S_spy = 550.64
    F_true_spy = S_spy * math.exp((r_spy - q_spy) * T_spy)
    df_spy = math.exp(-r_spy * T_spy)
    spy_pairs = []
    for k in [535.0, 540.0, 545.0, 550.0, 555.0, 560.0, 565.0]:
        c_mid = bsm_price_py(S_spy, k, T_spy, r_spy, q_spy, 0.16, "call")
        p_mid = bsm_price_py(S_spy, k, T_spy, r_spy, q_spy, 0.16, "put")
        # Add minor realistic half-spread quotes
        spread_c = 0.06 if abs(k - S_spy) <= 10 else 0.25
        spread_p = 0.06 if abs(k - S_spy) <= 10 else 0.25
        spy_pairs.append({
            "strike": k,
            "callMid": round(c_mid, 6),
            "putMid": round(p_mid, 6),
            "callBid": round(c_mid - 0.5 * spread_c, 6),
            "callAsk": round(c_mid + 0.5 * spread_c, 6),
            "putBid": round(p_mid - 0.5 * spread_p, 6),
            "putAsk": round(p_mid + 0.5 * spread_p, 6),
        })
    spy_near = sorted(spy_pairs, key=lambda x: abs(x["strike"] - median_py([y["strike"] + (y["callMid"] - y["putMid"]) / df_spy for y in spy_pairs])))[:5]
    spy_fwds = [y["strike"] + (y["callMid"] - y["putMid"]) / df_spy for y in spy_near]
    spy_w = [1.0 / (1e-4 + (y["callAsk"] - y["callBid"]) / y["callMid"] + (y["putAsk"] - y["putBid"]) / y["putMid"]) for y in spy_near]
    spy_wmean = sum(f * w for f, w in zip(spy_fwds, spy_w)) / sum(spy_w)
    forward_cases.append({
        "name": "spy_clean_chain",
        "spot": S_spy,
        "timeToExpiry": T_spy,
        "rate": r_spy,
        "discountFactor": df_spy,
        "pairs": spy_pairs,
        "options": {"nearAtmCount": 5, "maxRelativeSpread": 0.25},
        "expectedMedianForward": median_py(spy_fwds),
        "expectedWeightedForward": spy_wmean,
        "expectedImpliedYieldFromMedian": r_spy - math.log(median_py(spy_fwds) / S_spy) / T_spy,
        "expectedImpliedYieldFromWeighted": r_spy - math.log(spy_wmean / S_spy) / T_spy,
    })

    # Case B: Outliers / wide spreads / crossed quotes / NaN quote should be filtered, leaving clean core strikes
    df_mixed = math.exp(-0.04 * 0.25)
    mixed_pairs = [
        {"strike": 95.0, "callMid": 8.10, "putMid": 2.40, "callBid": 7.90, "callAsk": 8.30, "putBid": 2.30, "putAsk": 2.50},
        {"strike": 100.0, "callMid": 4.95, "putMid": 4.20, "callBid": 4.90, "callAsk": 5.00, "putBid": 4.15, "putAsk": 4.25},
        {"strike": 105.0, "callMid": 2.65, "putMid": 6.85, "callBid": 2.55, "callAsk": 2.75, "putBid": 6.75, "putAsk": 6.95},
        # Invalid/noisy pairs below:
        {"strike": 80.0, "callMid": 21.0, "putMid": 0.05, "callBid": 20.5, "callAsk": 21.5, "putBid": 0.0, "putAsk": 0.10},  # zero bid
        {"strike": 110.0, "callMid": 1.20, "putMid": 10.50, "callBid": 1.30, "callAsk": 1.10, "putBid": 10.0, "putAsk": 11.0},  # crossed
        {"strike": 115.0, "callMid": 0.50, "putMid": 15.00, "callBid": 0.20, "callAsk": 0.80, "putBid": 14.5, "putAsk": 15.5},  # 120% rel spread
        {"strike": 120.0, "callMid": float("nan"), "putMid": 19.5},  # NaN
    ]
    valid_mixed = [
        mixed_pairs[0], mixed_pairs[1], mixed_pairs[2],
    ]
    mixed_fwds = [y["strike"] + (y["callMid"] - y["putMid"]) / df_mixed for y in valid_mixed]
    mixed_w = [
        1.0 / (1e-4 + (y["callAsk"] - y["callBid"]) / y["callMid"] + (y["putAsk"] - y["putBid"]) / y["putMid"])
        for y in valid_mixed
    ]
    mixed_wmean = sum(f * w for f, w in zip(mixed_fwds, mixed_w)) / sum(mixed_w)
    forward_cases.append({
        "name": "mixed_with_outliers_filtered",
        "spot": 99.75,
        "timeToExpiry": 0.25,
        "rate": 0.04,
        "discountFactor": df_mixed,
        "pairs": mixed_pairs,
        "options": {"nearAtmCount": 5, "maxRelativeSpread": 0.30, "requirePositiveBid": True},
        "expectedValidCount": 3,
        "expectedUsedCount": 3,
        "expectedDiscardedCount": 4,
        "expectedMedianForward": median_py(mixed_fwds),
        "expectedWeightedForward": mixed_wmean,
        "expectedImpliedYieldFromWeighted": 0.04 - math.log(mixed_wmean / 99.75) / 0.25,
    })

    # 3. Bjerksund-Stensland (2002) pricing + CRR Richardson + Greeks benchmark
    bs02_cases_specs = [
        ("call_no_div_exact_eu_atm", 100.0, 100.0, 1.0, 0.05, 0.0, 0.25, "call"),
        ("call_no_div_exact_eu_itm", 120.0, 100.0, 0.5, 0.06, 0.0, 0.20, "call"),
        ("put_no_div_itm_short", 40.0, 40.0, 0.5, 0.0488, 0.0, 0.30, "put"),
        ("put_no_div_deep_itm", 80.0, 100.0, 0.5, 0.06, 0.0, 0.25, "put"),
        ("put_no_div_immediate_exercise", 60.0, 100.0, 0.25, 0.08, 0.0, 0.20, "put"),
        ("put_no_div_otm", 115.0, 100.0, 0.75, 0.045, 0.0, 0.22, "put"),
        ("call_div_itm_haug", 42.0, 40.0, 0.75, 0.04, 0.08, 0.35, "call"),
        ("call_div_atm", 100.0, 100.0, 0.5, 0.03, 0.05, 0.25, "call"),
        ("call_div_otm_long", 90.0, 100.0, 1.0, 0.03, 0.07, 0.30, "call"),
        ("put_div_itm", 450.0, 500.0, 1.0, 0.05, 0.02, 0.22, "put"),
        ("put_neg_rate_merton_eu", 95.0, 100.0, 0.5, -0.02, 0.01, 0.25, "put"),
        ("call_extreme_high_div_monotone", 100.0, 100.0, 5.0, 0.01, 0.20, 0.20, "call"),
    ]
    bs02_cases = []
    for name, S, K, T, r, q, sig, contract in bs02_cases_specs:
        price_bs02 = bs02_american_py(S, K, T, r, q, sig, contract)
        price_eur = bsm_price_py(S, K, T, r, q, sig, contract)
        price_crr_ref = crr_richardson_benchmark(S, K, T, r, q, sig, contract)
        intrinsic = max(0.0, (S - K) if contract == "call" else (K - S))
        greeks = american_greeks_py(S, K, T, r, q, sig, contract)
        bs02_cases.append({
            "name": name,
            "input": {
                "spot": S,
                "strike": K,
                "timeToExpiry": T,
                "rate": r,
                "dividendYield": q,
                "volatility": sig,
                "contractType": contract,
            },
            "expectedBs2002": price_bs02,
            "expectedEuropean": price_eur,
            "expectedIntrinsic": intrinsic,
            "crrRichardsonRef": price_crr_ref,
            "expectedGreeks": greeks,
        })

    # Invalid domain cases for BS2002
    bs02_invalid = [
        {"name": "call_negative_rate_with_div", "spot": 100.0, "strike": 100.0, "timeToExpiry": 0.5, "rate": -0.02, "dividendYield": 0.03, "volatility": 0.25, "contractType": "call"},
        {"name": "put_negative_div_with_pos_rate", "spot": 100.0, "strike": 100.0, "timeToExpiry": 0.5, "rate": 0.04, "dividendYield": -0.02, "volatility": 0.25, "contractType": "put"},
        {"name": "zero_sigma", "spot": 100.0, "strike": 100.0, "timeToExpiry": 0.5, "rate": 0.04, "dividendYield": 0.01, "volatility": 0.0, "contractType": "put"},
        {"name": "negative_time", "spot": 100.0, "strike": 100.0, "timeToExpiry": -0.1, "rate": 0.04, "dividendYield": 0.01, "volatility": 0.25, "contractType": "call"},
    ]

    # 4. CRR binomial tree with discrete cash dividends
    crr_specs = [
        ("call_single_large_div_pre_expiry", 100.0, 100.0, 0.25, 0.04, 0.0, 0.25, "call", 200, [{"time": 0.24, "amount": 3.0}]),
        ("put_single_div_mid_life", 100.0, 100.0, 0.50, 0.05, 0.0, 0.30, "put", 250, [{"time": 0.25, "amount": 2.0}]),
        ("call_quarterly_divs_1y", 185.0, 180.0, 1.0, 0.045, 0.0, 0.28, "call", 300, [
            {"time": 0.15, "amount": 0.85},
            {"time": 0.40, "amount": 0.85},
            {"time": 0.65, "amount": 0.85},
            {"time": 0.90, "amount": 0.85},
        ]),
        ("put_quarterly_divs_1y_itm", 160.0, 180.0, 1.0, 0.045, 0.0, 0.28, "put", 300, [
            {"time": 0.15, "amount": 0.85},
            {"time": 0.40, "amount": 0.85},
            {"time": 0.65, "amount": 0.85},
            {"time": 0.90, "amount": 0.85},
        ]),
        ("call_continuous_plus_discrete", 500.0, 500.0, 0.5, 0.05, 0.012, 0.18, "call", 150, [{"time": 0.30, "amount": 1.5}]),
        ("put_negative_rate_crr_supported", 100.0, 100.0, 0.5, -0.01, 0.0, 0.25, "put", 200, [{"time": 0.25, "amount": 1.0}]),
    ]
    crr_cases = []
    for name, S, K, T, r, q, sig, contract, steps, divs in crr_specs:
        crr_cases.append({
            "name": name,
            "input": {
                "spot": S,
                "strike": K,
                "timeToExpiry": T,
                "rate": r,
                "dividendYield": q,
                "volatility": sig,
                "contractType": contract,
                "steps": steps,
                "discreteDividends": divs,
            },
            "expectedPrice": crr_discrete_py(S, K, T, r, q, sig, contract, steps, divs),
        })

    # 5. American Implied Volatility inversion round-trips
    iv_specs = [
        ("bs02_put_atm", 100.0, 100.0, 0.5, 0.05, 0.0, "put", 0.24, None, None),
        ("bs02_put_itm_high_vol", 88.0, 100.0, 0.75, 0.045, 0.01, "put", 0.58, None, None),
        ("bs02_call_div_yield_low_vol", 104.0, 100.0, 0.5, 0.03, 0.06, "call", 0.09, None, None),
        ("bs02_call_european_eq", 102.0, 100.0, 0.25, 0.04, 0.0, "call", 0.32, None, None),
        ("crr_call_discrete_div", 100.0, 100.0, 0.25, 0.04, 0.0, "call", 0.28, [{"time": 0.20, "amount": 2.5}], 150),
        ("crr_put_discrete_div", 96.0, 100.0, 0.5, 0.05, 0.0, "put", 0.35, [{"time": 0.25, "amount": 1.8}], 150),
    ]
    iv_cases = []
    for name, S, K, T, r, q, contract, true_sig, divs, steps in iv_specs:
        mkt_price = (
            bs02_american_py(S, K, T, r, q, true_sig, contract)
            if divs is None and steps is None
            else crr_discrete_py(S, K, T, r, q, true_sig, contract, steps or 200, divs)
        )
        solved_py = solve_iv_bisection_py(S, K, T, r, q, contract, mkt_price, divs, steps)
        req: dict[str, Any] = {
            "spot": S,
            "strike": K,
            "timeToExpiry": T,
            "rate": r,
            "dividendYield": q,
            "contractType": contract,
            "marketPrice": mkt_price,
        }
        if divs is not None:
            req["discreteDividends"] = divs
        if steps is not None:
            req["steps"] = steps
        iv_cases.append({
            "name": name,
            "input": req,
            "trueVolatility": true_sig,
            "expectedPythonBisectionVol": solved_py,
        })

    return serialize_val({
        "meta": {
            "generator": "tools/gen_options_american_fixture.py",
            "notes": "Independent Python composite Simpson BVN, textbook Bjerksund-Stensland 2002, CRR discrete tree, Richardson N=2000 CRR benchmark, and bisection IV.",
        },
        "bvnCases": bvn_cases,
        "forwardCases": forward_cases,
        "bjerksund2002Cases": bs02_cases,
        "bjerksund2002InvalidCases": bs02_invalid,
        "crrDiscreteCases": crr_cases,
        "impliedVolCases": iv_cases,
    })


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    out_path = root / "fixtures" / "options_american_reference.json"
    fixture = build_fixtures()
    out_path.write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf-8")
    print(f"Generated {out_path} successfully.")


if __name__ == "__main__":
    main()
