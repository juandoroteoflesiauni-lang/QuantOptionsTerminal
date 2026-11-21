#!/usr/bin/env python3
"""Referencia independiente Pieza 50.3 (integridad de cadenas, escala ORATS,
deep ITM americano / dS adaptativo, gate DTE<3 y ratios 1x2 sigma-escalados).

Implementacion explicita en Python puro (math, sin numpy/scipy y sin copiar la logica TS):
  - BS2002 (Bjerksund-Stensland 2002) con BVN por integracion compuesta de Simpson.
  - Diferencias finitas centrales en spot con dS adaptativo explicito.
  - Mediana/ratio de integridad de cadena, normalizacion ORATS y gate DTE<3.
  - Motor 1x2 de ratios reimplementado desde la especificacion (strike objetivo,
    filtro estricto de prima > 0.01, lotes OTM, caja neta y breakeven extremo).
Genera fixtures/options_pieza50_3_reference.json (tolerancia 1e-9).
"""
from __future__ import annotations

import json
import math
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "fixtures", "options_pieza50_3_reference.json")

SQRT_2 = math.sqrt(2.0)
SQRT_2PI = math.sqrt(2.0 * math.pi)
GOLDEN_PHI_INV = 0.5 * (math.sqrt(5.0) - 1.0)
DAYS_PER_YEAR = 365.0
EXTRINSIC_EPS = 0.01
IV_CAP_DECIMAL = 9.99
MIN_RATIO_SHORT_LEG_PREMIUM = 0.01
RATIO_SIGMA_MULTIPLIERS = (0.5, 1.0, 1.5)


def norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / SQRT_2PI


def norm_cdf(x: float) -> float:
    return 0.5 * math.erfc(-x / SQRT_2)


def bvn_independent_integral(a: float, b: float, rho: float) -> float:
    """P(X <= a, Y <= b) por Simpson compuesto 1D sobre x en (-inf, a] (Genz-equivalente)."""
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
    n = 8000
    h = (hi - lo) / n
    sqrt_1_m_r2 = math.sqrt(1.0 - rho * rho)

    def f(x: float) -> float:
        return norm_pdf(x) * norm_cdf((b - rho * x) / sqrt_1_m_r2)

    total = f(lo) + f(hi)
    for idx in range(1, n):
        x = lo + idx * h
        total += (4.0 if idx % 2 == 1 else 2.0) * f(x)
    return max(0.0, min(1.0, total * (h / 3.0)))


def bsm_price(S: float, K: float, T: float, r: float, q: float, sigma: float, contract: str) -> float:
    srt = sigma * math.sqrt(T)
    d1 = (math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / srt
    d2 = d1 - srt
    if contract == "call":
        return S * math.exp(-q * T) * norm_cdf(d1) - K * math.exp(-r * T) * norm_cdf(d2)
    return K * math.exp(-r * T) * norm_cdf(-d2) - S * math.exp(-q * T) * norm_cdf(-d1)


def bs02_call(S: float, K: float, T: float, r: float, q: float, sigma: float) -> float:
    if S <= 0.0 or K <= 0.0 or T <= 0.0 or sigma <= 0.0:
        return float("nan")
    eur = bsm_price(S, K, T, r, q, sigma, "call")
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

    def log_norm_cdf(z: float) -> float:
        if z > -30.0:
            return math.log(norm_cdf(z))
        iz2 = 1.0 / (z * z)
        return -0.5 * z * z - 0.5 * math.log(2.0 * math.pi) - math.log(-z) + math.log(
            1.0 - iz2 * (1.0 - iz2 * (3.0 - iz2 * (15.0 - iz2 * (105.0 - 945.0 * iz2))))
        )

    def mul_exp_ncdf(log_c: float, z: float) -> float:
        if z > -30.0 and log_c < 700.0:
            return math.exp(log_c) * norm_cdf(z)
        tot = log_c + log_norm_cdf(z)
        return 0.0 if tot <= -745.0 else math.exp(tot)

    def mul_exp_bvn(log_c: float, a_v: float, b_v: float, rho_v: float) -> float:
        v = bvn_independent_integral(a_v, b_v, rho_v)
        if log_c <= 700.0:
            return 0.0 if v == 0.0 else math.exp(log_c) * v
        if v > 0.0:
            tot = log_c + math.log(v)
            return 0.0 if tot <= -745.0 else math.exp(tot)
        ub = log_c + min(log_norm_cdf(a_v), log_norm_cdf(b_v))
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


def bs02_american(S: float, K: float, T: float, r: float, q: float, sigma: float, contract: str) -> float:
    if contract == "call":
        return bs02_call(S, K, T, r, q, sigma)
    eur = bsm_price(S, K, T, r, q, sigma, "put")
    if r <= 0.0 and q >= 0.0:
        return eur
    return bs02_call(K, S, T, q, r, sigma)


def adaptive_ds(S: float, T: float, sigma: float) -> float:
    return min(S * 0.005, max(S * 0.0005, 0.1 * S * sigma * math.sqrt(max(T, 1e-6))))


def adaptive_short_dte_greeks(S: float, K: float, T: float, r: float, q: float, sigma: float, contract: str) -> dict:
    price = bs02_american(S, K, T, r, q, sigma, contract)
    hS = adaptive_ds(S, T, sigma)
    hV = min(sigma * 1e-4, 0.25 * sigma)
    hT = min(1e-4, 0.25 * T)
    hR = 1e-4
    v_up_s = bs02_american(S + hS, K, T, r, q, sigma, contract)
    v_dn_s = bs02_american(S - hS, K, T, r, q, sigma, contract)
    delta = (v_up_s - v_dn_s) / (2.0 * hS)
    gamma = (v_up_s - 2.0 * price + v_dn_s) / (hS * hS)
    v_up_t = bs02_american(S, K, T + hT, r, q, sigma, contract)
    v_dn_t = bs02_american(S, K, T - hT, r, q, sigma, contract)
    theta = (v_dn_t - v_up_t) / (2.0 * hT)
    v_up_v = bs02_american(S, K, T, r, q, sigma + hV, contract)
    v_dn_v = bs02_american(S, K, T, r, q, sigma - hV, contract)
    vega = (v_up_v - v_dn_v) / (2.0 * hV)
    if contract == "call" and r - hR < 0.0:
        v_up_r = bs02_american(S, K, T, r + hR, q, sigma, contract)
        v_up_2r = bs02_american(S, K, T, r + 2.0 * hR, q, sigma, contract)
        rho = (-3.0 * price + 4.0 * v_up_r - v_up_2r) / (2.0 * hR)
    else:
        v_up_r = bs02_american(S, K, T, r + hR, q, sigma, contract)
        v_dn_r = bs02_american(S, K, T, r - hR, q, sigma, contract)
        rho = (v_up_r - v_dn_r) / (2.0 * hR)
    v_uu = bs02_american(S + hS, K, T, r, q, sigma + hV, contract)
    v_ud = bs02_american(S + hS, K, T, r, q, sigma - hV, contract)
    v_du = bs02_american(S - hS, K, T, r, q, sigma + hV, contract)
    v_dd = bs02_american(S - hS, K, T, r, q, sigma - hV, contract)
    vanna = (v_uu - v_ud - v_du + v_dd) / (4.0 * hS * hV)
    delta_up_t = (
        bs02_american(S + hS, K, T + hT, r, q, sigma, contract)
        - bs02_american(S - hS, K, T + hT, r, q, sigma, contract)
    ) / (2.0 * hS)
    delta_dn_t = (
        bs02_american(S + hS, K, T - hT, r, q, sigma, contract)
        - bs02_american(S - hS, K, T - hT, r, q, sigma, contract)
    ) / (2.0 * hS)
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


# ---------------------------------------------------------------------------
# 1) Integridad de cadena
# ---------------------------------------------------------------------------

def chain_integrity(rows: list[float], spot: float, min_ratio: float = 0.25, max_ratio: float = 3.0) -> dict:
    if len(rows) == 0:
        return {"valid": False, "reason": "EMPTY_CHAIN", "medianStrike": None, "ratio": None, "validStrikeCount": 0}
    sorted_ks = sorted(k for k in rows if math.isfinite(k) and k > 0)
    if len(sorted_ks) == 0:
        return {"valid": False, "reason": "INVALID_STRIKES", "medianStrike": None, "ratio": None, "validStrikeCount": 0}
    n = len(sorted_ks)
    mid = n // 2
    median = sorted_ks[mid] if n % 2 == 1 else 0.5 * (sorted_ks[mid - 1] + sorted_ks[mid])
    if not math.isfinite(spot) or spot <= 0:
        return {"valid": False, "reason": "INVALID_SPOT", "medianStrike": median, "ratio": None, "validStrikeCount": n}
    if not math.isfinite(min_ratio) or not math.isfinite(max_ratio) or min_ratio >= max_ratio:
        return {"valid": False, "reason": "INVALID_SPOT", "medianStrike": median, "ratio": None, "validStrikeCount": n}
    ratio = median / spot
    if ratio > max_ratio or ratio < min_ratio:
        return {"valid": False, "reason": "SCALE_MISMATCH", "medianStrike": median, "ratio": ratio, "validStrikeCount": n}
    return {"valid": True, "reason": "OK", "medianStrike": median, "ratio": ratio, "validStrikeCount": n}


# ---------------------------------------------------------------------------
# 2) Escala ORATS
# ---------------------------------------------------------------------------

def orats_vol_norm(v):
    if v is None or math.isnan(v) or v < 0:
        return None
    return v / 100.0 if v >= 5.0 else v


def orats_signed_norm(v):
    if v is None or math.isnan(v):
        return None
    return v / 100.0 if abs(v) >= 5.0 else v


# ---------------------------------------------------------------------------
# 3) Griegas americanas deep / dS adaptativo + cap IV
# ---------------------------------------------------------------------------

def iv_unreliable(iv, ext) -> bool:
    if iv is None or math.isnan(iv) or iv >= IV_CAP_DECIMAL:
        return True
    return math.isfinite(ext) and ext <= EXTRINSIC_EPS


def sanitize_iv(iv, ext):
    return None if iv_unreliable(iv, ext) else iv


# ---------------------------------------------------------------------------
# 4) Buy-Write y Conversion/Reversal con gate DTE < 3
# ---------------------------------------------------------------------------

def buy_write(case: dict) -> dict:
    spot_ask = case["spotAsk"]
    strike = case["strike"]
    call_bid = case["callBid"]
    t = case["timeToExpiry"]
    div = case.get("dividendCash", 0.0)
    stock_fee = case.get("stockFeeRate", 0.0005)
    option_fee = case.get("optionFeeRate", 0.0020)
    vat = case.get("vatRate", 0.21)
    dte = case.get("dte")
    f_stock = stock_fee * (1.0 + vat)
    f_opt = option_fee * (1.0 + vat)
    total_fees = spot_ask * f_stock + call_bid * f_opt
    net_basis = spot_ask * (1.0 + f_stock) - call_bid * (1.0 - f_opt)
    static_profit = min(spot_ask, strike) + div - net_basis
    static_ret_pct = static_profit / net_basis * 100.0
    max_profit = strike + div - net_basis
    max_ret_pct = max_profit / net_basis * 100.0
    raw_dte = t * 365.0
    if dte is not None:
        eff_dte = float(dte)
    else:
        eff_dte = 3.0 if abs(raw_dte - 3.0) <= 1e-12 * 365.0 else raw_dte
    blocked = (dte is not None and dte < 3) or (t < 3.0 / 365.0 - 1e-12)
    if blocked:
        annualized = None
        status = "BLOCKED_SHORT_DTE"
        static_annualized = None
        assigned_annualized = None
    else:
        annualized = (1.0 + static_ret_pct / 100.0) ** (365.0 / eff_dte) - 1.0
        status = "OK"
        static_annualized = static_ret_pct / t
        assigned_annualized = max_ret_pct / t
    return {
        "status": "OK",
        "totalFeesPerShare": total_fees,
        "netCostBasis": net_basis,
        "breakevenPrice": net_basis - div,
        "downsideProtectionPct": ((spot_ask - (net_basis - div)) / spot_ask) * 100.0,
        "staticProfitPerShare": static_profit,
        "staticReturnPct": static_ret_pct,
        "staticAnnualizedTna": static_annualized,
        "maxAssignedProfitPerShare": max_profit,
        "maxAssignedReturnPct": max_ret_pct,
        "assignedAnnualizedTna": assigned_annualized,
        "annualizedRate": annualized,
        "rateStatus": status,
    }


def conversion_reversal(case: dict) -> dict:
    strike = case["strike"]
    t = case["timeToExpiry"]
    dte = case.get("dte")
    risk_free = case["riskFreeTna"]
    stock_fee = case.get("stockFeeRate", 0.0005)
    option_fee = case.get("optionFeeRate", 0.0020)
    vat = case.get("vatRate", 0.21)
    short_borrow = case.get("shortBorrowRateTna", 0.02)
    f_stock = stock_fee * (1.0 + vat)
    f_opt = option_fee * (1.0 + vat)
    conv_net = (
        case["spotAsk"] * (1.0 + f_stock)
        + case["putAsk"] * (1.0 + f_opt)
        - case["callBid"] * (1.0 - f_opt)
    )
    rev_proceeds = (
        case["spotBid"] * (1.0 - f_stock)
        + case["putBid"] * (1.0 - f_opt)
        - case["callAsk"] * (1.0 + f_opt)
    )
    blocked = (dte is not None and dte < 3) or (t < 3.0 / 365.0 - 1e-12)
    short_borrow_cost = case["spotBid"] * short_borrow * t
    if blocked:
        return {
            "status": "OK",
            "rateStatus": "BLOCKED_SHORT_DTE",
            "conversionNetCost": conv_net,
            "conversionAnnualizedTna": None,
            "conversionEdgeVsRiskFreeBps": None,
            "reversalNetProceeds": rev_proceeds,
            "shortBorrowCost": short_borrow_cost,
            "reversalTerminalObligation": strike + short_borrow_cost,
            "reversalAnnualizedTna": None,
            "reversalEdgeVsRiskFreeBps": None,
            "netEdgeVsRiskFreeBps": None,
            "arbitrageSignal": "NO_DATA",
        }
    conv_tna = ((strike - conv_net) / conv_net) / t
    conv_bps = (conv_tna - risk_free) * 10_000.0
    rev_tna = ((strike + short_borrow_cost - rev_proceeds) / rev_proceeds) / t
    rev_bps = (risk_free - rev_tna) * 10_000.0
    net_bps = max(conv_bps, rev_bps)
    if conv_bps > 0 and conv_bps >= rev_bps:
        signal = "EXECUTABLE_CONVERSION"
    elif rev_bps > 0:
        signal = "EXECUTABLE_REVERSAL"
    else:
        signal = "NO_ARBITRAGE_WITHIN_BOUNDS"
    return {
        "status": "OK",
        "rateStatus": "OK",
        "conversionNetCost": conv_net,
        "conversionAnnualizedTna": conv_tna,
        "conversionEdgeVsRiskFreeBps": conv_bps,
        "reversalNetProceeds": rev_proceeds,
        "shortBorrowCost": short_borrow_cost,
        "reversalTerminalObligation": strike + short_borrow_cost,
        "reversalAnnualizedTna": rev_tna,
        "reversalEdgeVsRiskFreeBps": rev_bps,
        "netEdgeVsRiskFreeBps": net_bps,
        "arbitrageSignal": signal,
    }


# ---------------------------------------------------------------------------
# 5) DTE labels y ratios 1x2 sigma-escalados
# ---------------------------------------------------------------------------

def format_dte_label(dte: float) -> str:
    if dte is None or not math.isfinite(dte):
        return "—"
    if dte == 0:
        return "0DTE"
    return f"{int(dte)}d" if float(dte).is_integer() else f"{dte}d"


def resolve_side_price(bid, ask, mid, last, side: str) -> float:
    def pos(v):
        return v is not None and math.isfinite(v) and v > 0

    resolved_mid = mid if pos(mid) else (0.5 * (bid + ask) if pos(bid) and pos(ask) and ask >= bid else (last if pos(last) else None))
    if side == "buy":
        if pos(ask):
            return ask
        return resolved_mid if pos(resolved_mid) else float("nan")
    if side == "sell":
        if pos(bid):
            return bid
        return resolved_mid if pos(resolved_mid) else float("nan")
    return resolved_mid if pos(resolved_mid) else float("nan")


def compute_ratios(case: dict) -> dict:
    spot = case["spot"]
    days = case["daysToExpiry"]
    iv_atm = case.get("ivAtmDec")
    ratio_expected_move = (
        spot * iv_atm * math.sqrt(max(days, 0.5) / DAYS_PER_YEAR)
        if iv_atm is not None and math.isfinite(iv_atm) and iv_atm > 0
        else float("nan")
    )
    use_sigma = math.isfinite(ratio_expected_move) and ratio_expected_move > 0
    sorted_strikes = sorted(case["strikes"], key=lambda s: s["strike"])
    out_calls: list[dict] = []
    out_puts: list[dict] = []

    def leg(row, ct, side):
        return resolve_side_price(row.get(f"{ct}Bid"), row.get(f"{ct}Ask"), row.get(f"{ct}Mid"), None, side)

    def build_rows(ct: str, direction: str) -> list[dict]:
        targets = (
            (RATIO_SIGMA_MULTIPLIERS if ct == "call" else tuple(-m for m in RATIO_SIGMA_MULTIPLIERS))
            if use_sigma
            else ((5.0, 10.0, 15.0) if ct == "call" else (-5.0, -10.0, -15.0))
        )
        long_candidates = [
            s for s in sorted_strikes if math.isfinite(leg(s, ct, "buy")) and leg(s, ct, "buy") > MIN_RATIO_SHORT_LEG_PREMIUM
        ]
        long_candidates.sort(key=lambda s: abs(s["strike"] - spot))
        if not long_candidates:
            return []
        anchor = long_candidates[0]
        long_price = leg(anchor, ct, "buy")
        seen: set[float] = set()
        rows: list[dict] = []
        for target_pct in targets:
            target_k = spot + target_pct * ratio_expected_move if use_sigma else spot * (1.0 + target_pct / 100.0)
            candidates = []
            for s in sorted_strikes:
                k = s["strike"]
                if ct == "call" and k <= anchor["strike"]:
                    continue
                if ct == "put" and k >= anchor["strike"]:
                    continue
                if k in seen:
                    continue
                price = leg(s, ct, "sell")
                if not math.isfinite(price) or price <= MIN_RATIO_SHORT_LEG_PREMIUM:
                    continue
                candidates.append((abs(k - target_k), k, price, s))
            if not candidates:
                continue
            candidates.sort(key=lambda c: c[0])
            _, short_k, short_price, _srow = candidates[0]
            seen.add(short_k)
            net_cash = 2.0 * short_price - long_price
            rows.append(
                {
                    "side": "CALL" if ct == "call" else "PUT",
                    "targetOffsetPct": (target_k / spot - 1.0) * 100.0,
                    "longStrike": anchor["strike"],
                    "longPrice": long_price,
                    "shortStrike": short_k,
                    "shortPrice": short_price,
                    "otmLotsPerBought": long_price / short_price,
                    "netCash1x2": net_cash,
                    "outerBreakeven1x2": (
                        2.0 * short_k - anchor["strike"] + net_cash
                        if ct == "call"
                        else 2.0 * short_k - anchor["strike"] - net_cash
                    ),
                }
            )
        return rows

    out_calls = build_rows("call", "up")
    out_puts = build_rows("put", "down")
    return {"useSigma": use_sigma, "ratioExpectedMove": None if not use_sigma else ratio_expected_move,
            "callRatios": out_calls, "putRatios": out_puts}


def main() -> None:
    fx: dict = {
        "meta": {
            "generator": "tools/gen_options_pieza50_3_reference.py",
            "tolerance": 1e-9,
        }
    }

    # ---- 1) chainIntegrityCases ----
    nan = float("nan")
    chain_cases = [
        {"name": "spy_odd_ok", "rows": [580.0, 590.0, 600.0, 610.0, 620.0], "spot": 600.0},
        {"name": "spy_even_ok", "rows": [580.0, 590.0, 600.0, 610.0, 620.0, 630.0], "spot": 600.0},
        {"name": "ggal_under_spy_scale_mismatch", "rows": [6400.0, 6800.0, 7200.0, 7600.0], "spot": 600.0},
        {"name": "spy_under_ggal_scale_mismatch", "rows": [590.0, 600.0, 610.0], "spot": 7200.0},
        {"name": "lower_bound_ok", "rows": [25.0], "spot": 100.0},
        {"name": "upper_bound_ok", "rows": [300.0], "spot": 100.0},
        {"name": "below_lower_bound", "rows": [24.9999], "spot": 100.0},
        {"name": "above_upper_bound", "rows": [300.0001], "spot": 100.0},
        {"name": "empty_chain", "rows": [], "spot": 600.0},
        {"name": "invalid_spot_nan", "rows": [600.0], "spot": nan},
        {"name": "invalid_spot_zero", "rows": [600.0], "spot": 0.0},
        {"name": "invalid_strikes", "rows": [-5.0, nan, 0.0], "spot": 600.0},
        {"name": "valid_strike_survives_invalid_mix", "rows": [600.0, -1.0, nan], "spot": 600.0},
    ]

    def json_num(v: float):
        return None if isinstance(v, float) and math.isnan(v) else v

    fx["chainIntegrityCases"] = [
        {
            "name": c["name"],
            "rows": [json_num(r) for r in c["rows"]],
            "spot": json_num(c["spot"]),
            "expected": chain_integrity(list(c["rows"]), c["spot"]),
        }
        for c in chain_cases
    ]

    # ---- 2) oratsScaleCases ----
    vol_raws = [35.82, 0.3582, 4.99, 5.0, 0.0, -1.0, float("nan")]
    fx["oratsScaleCases"] = {
        "vol": [
            {"raw": None if math.isnan(v) else v, "expected": orats_vol_norm(v)}
            for v in vol_raws
        ],
        "signed": [
            {"raw": r, "expected": orats_signed_norm(r)}
            for r in [-8.5, 0.005, 5.0, -4.99]
        ],
        "pctIdempotence": [
            {"raw": v, "expectedPct": orats_vol_norm(v) * 100.0}
            for v in [35.82, 0.3582, 4.99, 5.0, 0.0]
        ],
    }

    # ---- 3) americanDeepAndAdaptiveCases ----
    deep_cases = [
        {"name": "deep_itm_put_5d", "contractType": "put", "spot": 600, "strike": 680,
         "t": 5.0 / 365.0, "rate": 0.043, "q": 0.012, "sigma": 0.22},
        {"name": "deep_itm_call_div_5d", "contractType": "call", "spot": 700, "strike": 600,
         "t": 5.0 / 365.0, "rate": 0.043, "q": 0.03, "sigma": 0.22},
        {"name": "deep_otm_put_5d", "contractType": "put", "spot": 600, "strike": 530,
         "t": 5.0 / 365.0, "rate": 0.043, "q": 0.012, "sigma": 0.22},
        {"name": "deep_otm_call_5d", "contractType": "call", "spot": 600, "strike": 670,
         "t": 5.0 / 365.0, "rate": 0.043, "q": 0.012, "sigma": 0.22},
        {"name": "zero_dte_itm_call", "contractType": "call", "spot": 600, "strike": 580,
         "t": 0.0005, "rate": 0.043, "q": 0.012, "sigma": 0.22},
        {"name": "zero_dte_otm_call", "contractType": "call", "spot": 600, "strike": 680,
         "t": 0.0005, "rate": 0.043, "q": 0.012, "sigma": 0.22},
        {"name": "zero_dte_otm_put", "contractType": "put", "spot": 600, "strike": 520,
         "t": 0.0005, "rate": 0.043, "q": 0.012, "sigma": 0.22},
    ]
    deep_out = []
    for c in deep_cases:
        intrinsic = max(0.0, c["spot"] - c["strike"]) if c["contractType"] == "call" else max(0.0, c["strike"] - c["spot"])
        is_itm = (c["spot"] > c["strike"]) if c["contractType"] == "call" else (c["strike"] > c["spot"])
        price = bs02_american(c["spot"], c["strike"], c["t"], c["rate"], c["q"], c["sigma"], c["contractType"])
        deep_out.append(
            {
                "name": c["name"],
                "input": c,
                "expected": {
                    "price": price,
                    "delta": (1.0 if c["contractType"] == "call" else -1.0) if is_itm else 0.0,
                    "gamma": 0.0,
                    "theta": 0.0,
                    "thetaDaily": 0.0,
                    "vega": 0.0,
                    "vegaPer1Pct": 0.0,
                    "rho": 0.0,
                    "vanna": 0.0,
                    "charm": 0.0,
                },
            }
        )
    adaptive_case = {"spot": 600, "strike": 600, "t": 3.0 / 365.0, "rate": 0.043, "q": 0.012, "sigma": 0.22,
                     "contractType": "put", "dS": adaptive_ds(600, 3.0 / 365.0, 0.22)}
    fx["americanDeepAndAdaptiveCases"] = {
        "deepGreeks": deep_out,
        "adaptiveShortDte": {
            "input": adaptive_case,
            "expected": adaptive_short_dte_greeks(600, 600, 3.0 / 365.0, 0.043, 0.012, 0.22, "put"),
        },
        "ivCapCases": [
            {"name": "capped_999", "iv": 9.99, "extrinsic": 5.0, "expected": sanitize_iv(9.99, 5.0)},
            {"name": "below_cap", "iv": 9.98, "extrinsic": 5.0, "expected": sanitize_iv(9.98, 5.0)},
            {"name": "exhausted_extrinsic", "iv": 0.5, "extrinsic": 0.0, "expected": sanitize_iv(0.5, 0.0)},
            {"name": "extrinsic_eps_bound", "iv": 0.5, "extrinsic": 0.01, "expected": sanitize_iv(0.5, 0.01)},
            {"name": "extrinsic_above_eps", "iv": 0.5, "extrinsic": 0.0100001, "expected": sanitize_iv(0.5, 0.0100001)},
        ],
    }

    # ---- 4) buyWriteAndSynthShortDteCases ----
    bw_inputs = []
    for dte in (0, 1, 2):
        bw_inputs.append(
            {
                "name": f"blocked_dte_{dte}",
                "input": {
                    "spotAsk": 100.0,
                    "strike": 105.0,
                    "callBid": 2.2,
                    "timeToExpiry": max(1.0 / 365.0, dte / 365.0),
                    "dte": dte,
                    "vatRate": 0.0,
                },
            }
        )
    bw_inputs.append(
        {
            "name": "boundary_3_365_no_dte",
            "input": {
                "spotAsk": 100.0,
                "strike": 105.0,
                "callBid": 2.2,
                "timeToExpiry": 3.0 / 365.0,
                "vatRate": 0.0,
            },
        }
    )
    bw_inputs.append(
        {
            "name": "boundary_3_365_dte_3",
            "input": {
                "spotAsk": 100.0,
                "strike": 105.0,
                "callBid": 2.2,
                "timeToExpiry": 3.0 / 365.0,
                "dte": 3,
                "vatRate": 0.0,
            },
        }
    )
    bw_inputs.append(
        {
            "name": "spy_30dte",
            "input": {
                "spotAsk": 600.0,
                "strike": 610.0,
                "callBid": 8.5,
                "timeToExpiry": 30.0 / 365.0,
                "stockFeeRate": 0.0005,
                "optionFeeRate": 0.002,
                "vatRate": 0.21,
            },
        }
    )
    bw_inputs.append(
        {
            "name": "ggal_30dte",
            "input": {
                "spotAsk": 7200.0,
                "strike": 7500.0,
                "callBid": 260.0,
                "timeToExpiry": 30.0 / 365.0,
                "stockFeeRate": 0.0005,
                "optionFeeRate": 0.002,
                "vatRate": 0.21,
            },
        }
    )
    fx["buyWriteCases"] = [
        {"name": c["name"], "input": c["input"], "expected": buy_write(c["input"])} for c in bw_inputs
    ]

    cr_base = {
        "strike": 100.0,
        "riskFreeTna": 0.3,
        "spotBid": 99.0,
        "spotAsk": 100.0,
        "callBid": 5.0,
        "callAsk": 5.2,
        "putBid": 4.0,
        "putAsk": 4.2,
        "vatRate": 0.21,
    }
    cr_inputs = []
    for dte in (0, 1, 2):
        cr_inputs.append(
            {
                "name": f"blocked_dte_{dte}",
                "input": {**cr_base, "timeToExpiry": max(1.0 / 365.0, dte / 365.0), "dte": dte},
            }
        )
    cr_inputs.append(
        {
            "name": "ok_dte_3",
            "input": {**cr_base, "timeToExpiry": 3.0 / 365.0, "dte": 3},
        }
    )
    cr_inputs.append(
        {
            "name": "ok_dte_30",
            "input": {**cr_base, "timeToExpiry": 30.0 / 365.0, "dte": 30},
        }
    )
    fx["conversionReversalCases"] = [
        {"name": c["name"], "input": c["input"], "expected": conversion_reversal(c["input"])} for c in cr_inputs
    ]

    # ---- 5) zeroDteAndRatiosSigmaCases ----
    fx["zeroDteAndRatiosSigmaCases"] = {
        "dteLabels": [
            {"dte": 0, "expected": format_dte_label(0.0)},
            {"dte": 1, "expected": format_dte_label(1.0)},
            {"dte": 30, "expected": format_dte_label(30.0)},
            {"dte": None, "expected": format_dte_label(float("nan"))},
        ],
        "ratiosCases": [],
    }

    def strike_row(k, c_bid, c_ask, c_mid, p_bid, p_ask, p_mid):
        return {
            "strike": k,
            "callBid": c_bid, "callAsk": c_ask, "callMid": c_mid,
            "putBid": p_bid, "putAsk": p_ask, "putMid": p_mid,
        }

    zero_dte_chain = [
        strike_row(560, 0.02, 0.04, 0.03, 42.0, 42.4, 42.2),
        strike_row(575, 0.05, 0.09, 0.07, 27.5, 27.9, 27.7),
        strike_row(585, 0.20, 0.30, 0.25, 17.6, 18.0, 17.8),
        strike_row(590, 0.40, 0.50, 0.45, 12.9, 13.3, 13.1),
        strike_row(595, 0.80, 0.92, 0.86, 8.3, 8.7, 8.5),
        strike_row(598, 1.15, 1.30, 1.22, 5.7, 6.1, 5.9),
        strike_row(600, 1.60, 1.80, 1.70, 4.3, 4.7, 4.5),
        strike_row(602, 2.20, 2.45, 2.32, 3.0, 3.4, 3.2),
        strike_row(604, 2.90, 3.20, 3.05, 2.0, 2.3, 2.15),
        strike_row(606, 3.60, 3.95, 3.77, 1.25, 1.5, 1.37),
        strike_row(608, 4.40, 4.80, 4.60, 0.75, 0.95, 0.85),
        strike_row(610, 5.30, 5.75, 5.52, 0.40, 0.55, 0.475),
        strike_row(615, 7.80, 8.40, 8.10, 0.12, 0.20, 0.16),
        strike_row(620, 10.50, 11.20, 10.85, 0.02, 0.05, 0.035),
        strike_row(630, 16.20, 17.10, 16.65, 0.01, 0.02, 0.015),
        strike_row(640, 22.50, 23.50, 23.00, 0.005, 0.01, 0.0075),
        strike_row(660, 35.00, 36.50, 35.75, 0.0, 0.0, 0.0),
    ]
    thirty_dte_chain = [
        strike_row(540, 0.10, 0.15, 0.12, 0.02, 0.05, 0.035),
        strike_row(543, 0.15, 0.22, 0.18, 0.01, 0.025, 0.0175),
        strike_row(550, 0.30, 0.40, 0.35, 0.02, 0.05, 0.035),
        strike_row(560, 0.70, 0.90, 0.80, 0.15, 0.25, 0.20),
        strike_row(562, 0.85, 1.05, 0.95, 0.20, 0.32, 0.26),
        strike_row(581, 3.20, 3.60, 3.40, 3.10, 3.60, 3.35),
        strike_row(600, 11.50, 12.20, 11.85, 11.00, 11.70, 11.35),
        strike_row(610, 6.40, 6.90, 6.65, 17.40, 18.20, 17.80),
        strike_row(619, 0.01, 4.55, 2.28, 22.60, 23.50, 23.05),
        strike_row(620, 0.02, 3.85, 1.93, 23.40, 24.30, 23.85),
        strike_row(638, 0.80, 1.00, 0.90, 34.60, 35.60, 35.10),
        strike_row(640, 0.60, 0.80, 0.70, 35.40, 36.50, 35.95),
        strike_row(657, 0.02, 0.06, 0.04, 45.60, 47.00, 46.30),
        strike_row(660, 0.01, 0.03, 0.02, 47.00, 48.40, 47.70),
    ]
    illiquid_chain = [
        strike_row(590, 0.50, 0.70, 0.60, 0.01, 0.02, 0.015),
        strike_row(600, 0.80, 1.00, 0.90, 0.80, 1.00, 0.90),
        strike_row(610, 0.01, 0.05, 0.03, 0.90, 1.10, 1.00),
    ]

    ratios_cases = [
        {
            "name": "zero_dte_sigma_0_20",
            "input": {"spot": 600.0, "daysToExpiry": 0, "rate": 0.04, "dividendYield": 0.0,
                      "ivAtmDec": 0.20, "strikes": zero_dte_chain},
        },
        {
            "name": "thirty_dte_sigma_0_22",
            "input": {"spot": 600.0, "daysToExpiry": 30, "rate": 0.04, "dividendYield": 0.0,
                      "ivAtmDec": 0.22, "strikes": thirty_dte_chain},
        },
        {
            "name": "illiquid_short_legs",
            "input": {"spot": 600.0, "daysToExpiry": 15, "rate": 0.04, "dividendYield": 0.0,
                      "ivAtmDec": 0.25, "strikes": illiquid_chain},
        },
    ]
    fx["zeroDteAndRatiosSigmaCases"]["ratiosCases"] = [
        {"name": c["name"], "input": c["input"], "expected": compute_ratios(c["input"])} for c in ratios_cases
    ]

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(fx, fh, indent=1, allow_nan=False)
    print("written", OUT)


if __name__ == "__main__":
    main()
