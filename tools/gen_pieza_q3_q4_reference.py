#!/usr/bin/env python3
"""
Independent Python reference oracle for Pieza P1 Q3 + Q4:
- Q3: OPRA contractual exercise-style integrity, BSM European vs CRR-1200 vs BS2002 American models
- Q4: RTH vs EOD session quote admission, zero synthetic BBOs, fail-closed tri-valued arbitrage checks

No production TypeScript code is ported here; every formula (BSM via math.erfc,
CRR-1200 backward lattice, BS2002 via Simpson-8000 bivariate normal CDF, Durrleman
density & Fritsch-Carlson PCHIP monotonicity) is implemented independently from
first principles with Decimal input handling.
"""

from __future__ import annotations

import json
import math
from decimal import Decimal, getcontext
from pathlib import Path
from typing import Any

getcontext().prec = 50

SECONDS_PER_DAY = 86_400
DAYS_PER_YEAR = Decimal('365')
INV_SQRT_2 = 1.0 / math.sqrt(2.0)
INV_SQRT_2PI = 1.0 / math.sqrt(2.0 * math.pi)
ARBITRAGE_TOL = 1e-9
IV_CAP = 9.99


def d_float(val: str | int | float | Decimal) -> float:
    return float(Decimal(str(val)))


def norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) * INV_SQRT_2PI


def norm_cdf(x: float) -> float:
    return 0.5 * math.erfc(-x * INV_SQRT_2)


def bvn_cdf_simpson(a: float, b: float, rho: float, n_panels: int = 8000) -> float:
    """Independent bivariate standard normal CDF P(X <= a, Y <= b) with corr(X,Y)=rho."""
    if rho >= 1.0 - 1e-14:
        return norm_cdf(min(a, b))
    if rho <= -1.0 + 1e-14:
        if a + b <= 0.0:
            return 0.0
        return norm_cdf(a) - norm_cdf(-b)
    if abs(rho) <= 1e-14:
        return norm_cdf(a) * norm_cdf(b)

    # Genz / Vasicek representation:
    # P(X <= a, Y <= b) = Phi(a)*Phi(b) + int_0^rho f(r) dr
    # where f(r) = exp(-(a^2 - 2 r a b + b^2)/(2(1-r^2))) / (2*pi*sqrt(1-r^2))
    # Integrate r over [0, rho] with composite Simpson rule.
    if n_panels % 2 != 0:
        n_panels += 1
    h = rho / n_panels
    two_pi = 2.0 * math.pi

    def integrand(r: float) -> float:
        one_m_r2 = 1.0 - r * r
        if one_m_r2 <= 1e-15:
            return 0.0
        exponent = -(a * a - 2.0 * r * a * b + b * b) / (2.0 * one_m_r2)
        if exponent < -740.0:
            return 0.0
        return math.exp(exponent) / (two_pi * math.sqrt(one_m_r2))

    total = integrand(0.0) + integrand(rho)
    for k in range(1, n_panels):
        rk = k * h
        total += (4.0 if k % 2 == 1 else 2.0) * integrand(rk)
    integral = (h / 3.0) * total
    val = norm_cdf(a) * norm_cdf(b) + integral
    return min(1.0, max(0.0, val))


def bsm_price(s: float, k: float, t: float, r: float, q: float, vol: float, opt_type: str) -> float:
    if t <= 0.0:
        return max(0.0, s - k) if opt_type == 'call' else max(0.0, k - s)
    if vol <= 0.0:
        fwd_disc = s * math.exp(-q * t)
        k_disc = k * math.exp(-r * t)
        return max(0.0, fwd_disc - k_disc) if opt_type == 'call' else max(0.0, k_disc - fwd_disc)
    sqrt_t = math.sqrt(t)
    vs = vol * sqrt_t
    d1 = (math.log(s / k) + (r - q + 0.5 * vol * vol) * t) / vs
    d2 = d1 - vs
    disc_q = math.exp(-q * t)
    disc_r = math.exp(-r * t)
    if opt_type == 'call':
        return s * disc_q * norm_cdf(d1) - k * disc_r * norm_cdf(d2)
    return k * disc_r * norm_cdf(-d2) - s * disc_q * norm_cdf(-d1)


def bsm_bounds(s: float, k: float, t: float, r: float, q: float, opt_type: str) -> tuple[float, float]:
    disc_q = math.exp(-q * t)
    disc_r = math.exp(-r * t)
    if opt_type == 'call':
        return max(0.0, s * disc_q - k * disc_r), s * disc_q
    return max(0.0, k * disc_r - s * disc_q), k * disc_r


def american_bounds(s: float, k: float, t: float, r: float, q: float, opt_type: str) -> tuple[float, float, float]:
    disc_q = math.exp(-q * t)
    disc_r = math.exp(-r * t)
    if opt_type == 'call':
        intrinsic = max(0.0, s - k)
        euro_floor = max(0.0, s * disc_q - k * disc_r)
        return intrinsic, max(intrinsic, euro_floor), s
    intrinsic = max(0.0, k - s)
    euro_floor = max(0.0, k * disc_r - s * disc_q)
    return intrinsic, max(intrinsic, euro_floor), k


def bsm_greeks(s: float, k: float, t: float, r: float, q: float, vol: float, opt_type: str) -> dict[str, float]:
    px = bsm_price(s, k, t, r, q, vol, opt_type)
    sqrt_t = math.sqrt(t)
    vs = vol * sqrt_t
    d1 = (math.log(s / k) + (r - q + 0.5 * vol * vol) * t) / vs
    d2 = d1 - vs
    disc_q = math.exp(-q * t)
    disc_r = math.exp(-r * t)
    pdf_d1 = norm_pdf(d1)
    gamma = (disc_q * pdf_d1) / (s * vs)
    vega = s * disc_q * pdf_d1 * sqrt_t
    vanna = -disc_q * pdf_d1 * (d2 / vol)
    charm = -disc_q * pdf_d1 * (
        (2.0 * (r - q) * t - d2 * vs) / (2.0 * t * vs)
    )
    if opt_type == 'call':
        delta = disc_q * norm_cdf(d1)
        theta = (
            -(s * disc_q * pdf_d1 * vol) / (2.0 * sqrt_t)
            - r * k * disc_r * norm_cdf(d2)
            + q * s * disc_q * norm_cdf(d1)
        )
        rho = k * t * disc_r * norm_cdf(d2)
        charm_signed = -q * disc_q * norm_cdf(d1) + (-charm)
    else:
        delta = -disc_q * norm_cdf(-d1)
        theta = (
            -(s * disc_q * pdf_d1 * vol) / (2.0 * sqrt_t)
            + r * k * disc_r * norm_cdf(-d2)
            - q * s * disc_q * norm_cdf(-d1)
        )
        rho = -k * t * disc_r * norm_cdf(-d2)
        charm_signed = q * disc_q * norm_cdf(-d1) + (-charm)

    # Check exact analytical charm expression: -d(delta)/dt
    # d(disc_q * N(d1))/dT = disc_q * ( -q * N(d1) + n(d1) * ((r-q)/(vol*sqrtT) - d2/(2*T)) )
    # Recall blackScholes.ts uses dDelta/dTimeToExpiry? Let's verify via tiny central FD on BSM delta!
    h_t = min(1e-6, 0.05 * t)
    d_minus = bsm_price(s + 1e-5 * s, k, t - h_t, r, q, vol, opt_type)
    _ = d_minus
    def _bsm_delta(tt: float) -> float:
        st = math.sqrt(tt)
        vv = vol * st
        dd1 = (math.log(s / k) + (r - q + 0.5 * vol * vol) * tt) / vv
        dq = math.exp(-q * tt)
        return dq * norm_cdf(dd1) if opt_type == 'call' else -dq * norm_cdf(-dd1)

    charm_fd = (_bsm_delta(t - h_t) - _bsm_delta(t + h_t)) / (2.0 * h_t)

    return {
        'price': px,
        'delta': delta,
        'gamma': gamma,
        'theta': theta,
        'thetaDaily': theta / 365.0,
        'vega': vega,
        'vegaPer1Pct': vega / 100.0,
        'rho': rho,
        'vanna': vanna,
        'charm': charm_fd,
    }


def solve_bsm_iv(s: float, k: float, t: float, r: float, q: float, opt_type: str, target_price: float) -> float:
    lo = 1e-6
    hi = IV_CAP
    f_lo = bsm_price(s, k, t, r, q, lo, opt_type) - target_price
    f_hi = bsm_price(s, k, t, r, q, hi, opt_type) - target_price
    if f_lo * f_hi > 0.0:
        raise ValueError(f'BSM IV bracket failed: {f_lo=}, {f_hi=}')
    for _ in range(150):
        mid = 0.5 * (lo + hi)
        f_mid = bsm_price(s, k, t, r, q, mid, opt_type) - target_price
        if abs(f_mid) < 1e-14 or (hi - lo) < 1e-14:
            return mid
        if f_lo * f_mid <= 0.0:
            hi = mid
        else:
            lo = mid
            f_lo = f_mid
    return 0.5 * (lo + hi)


def _phi_bs02(s: float, t: float, gamma_p: float, h: float, i_bound: float, r: float, b: float, v: float) -> float:
    v2 = v * v
    lam = (-r + gamma_p * b + 0.5 * gamma_p * (gamma_p - 1.0) * v2) * t
    kappa = (2.0 * b) / v2 + (2.0 * gamma_p - 1.0)
    d = -(math.log(s / h) + (b + (gamma_p - 0.5) * v2) * t) / (v * math.sqrt(t))
    d2 = d - (2.0 * math.log(i_bound / s)) / (v * math.sqrt(t))
    ratio_pow = math.pow(i_bound / s, kappa)
    return math.exp(lam) * math.pow(s, gamma_p) * (norm_cdf(d) - ratio_pow * norm_cdf(d2))


def _psi_bs02(
    s: float,
    t2: float,
    gamma_p: float,
    h: float,
    i2: float,
    i1: float,
    t1: float,
    r: float,
    b: float,
    v: float,
) -> float:
    v2 = v * v
    lam = -r + gamma_p * b + 0.5 * gamma_p * (gamma_p - 1.0) * v2
    kappa = (2.0 * b) / v2 + (2.0 * gamma_p - 1.0)
    vt1 = v * math.sqrt(t1)
    vt2 = v * math.sqrt(t2)
    rho = math.sqrt(t1 / t2)
    drift = b + (gamma_p - 0.5) * v2

    e1 = (math.log(s / i1) + drift * t1) / vt1
    e2 = (math.log((i2 * i2) / (s * i1)) + drift * t1) / vt1
    e3 = (math.log(s / i1) - drift * t1) / vt1
    e4 = (math.log((i2 * i2) / (s * i1)) - drift * t1) / vt1

    f1 = (math.log(s / h) + drift * t2) / vt2
    f2 = (math.log((i2 * i2) / (s * h)) + drift * t2) / vt2
    f3 = (math.log((i1 * i1) / (s * h)) + drift * t2) / vt2
    f4 = (math.log((s * i1 * i1) / (h * i2 * i2)) + drift * t2) / vt2

    term1 = bvn_cdf_simpson(-e1, -f1, rho)
    term2 = math.pow(i2 / s, kappa) * bvn_cdf_simpson(-e2, -f2, rho)
    term3 = math.pow(i1 / s, kappa) * bvn_cdf_simpson(-e3, -f3, -rho)
    term4 = math.pow(i1 / i2, kappa) * bvn_cdf_simpson(-e4, -f4, -rho)
    return math.exp(lam * t2) * math.pow(s, gamma_p) * (term1 - term2 - term3 + term4)


def _bs02_call(s: float, k: float, t: float, r: float, q: float, v: float) -> float:
    b = r - q
    if b >= r - 1e-14:
        return bsm_price(s, k, t, r, q, v, 'call')
    v2 = v * v
    if v <= 1e-4:
        # At near-zero volatility, American Call value converges to discounted parity / intrinsic
        return max(s - k, s * math.exp(-q * t) - k * math.exp(-r * t), 0.0)
    term = 0.5 - b / v2
    beta = term + math.sqrt(term * term + (2.0 * r) / v2)
    if beta <= 1.0 + 1e-12:
        return max(s - k, s * math.exp(-q * t) - k * math.exp(-r * t), 0.0)
    b_inf = (beta / (beta - 1.0)) * k
    b_0 = k if r <= 0.0 else max(k, (r / (r - b)) * k)

    t1 = 0.5 * (math.sqrt(5.0) - 1.0) * t

    def g_eff(tau: float) -> float:
        raw = b * tau + 2.0 * v * math.sqrt(tau)
        if b < 0.0 and tau > v2 / (b * b):
            return -v2 / b
        return raw

    ht2 = -g_eff(t) * ((k * k) / ((b_inf - b_0) * b_0))
    ht1 = -g_eff(t - t1) * ((k * k) / ((b_inf - b_0) * b_0))
    i1 = b_0 + (b_inf - b_0) * (-math.expm1(ht1))
    i2 = b_0 + (b_inf - b_0) * (-math.expm1(ht2))

    if s >= i2:
        return max(s - k, bsm_price(s, k, t, r, q, v, 'call'))

    alpha2 = (i2 - k) * math.pow(i2, -beta)
    alpha1 = (i1 - k) * math.pow(i1, -beta)

    c = (
        alpha2 * math.pow(s, beta)
        - alpha2 * _phi_bs02(s, t1, beta, i2, i2, r, b, v)
        + _phi_bs02(s, t1, 1.0, i2, i2, r, b, v)
        - _phi_bs02(s, t1, 1.0, i1, i2, r, b, v)
        - k * _phi_bs02(s, t1, 0.0, i2, i2, r, b, v)
        + k * _phi_bs02(s, t1, 0.0, i1, i2, r, b, v)
        + alpha1 * _phi_bs02(s, t1, beta, i1, i2, r, b, v)
        - alpha1 * _psi_bs02(s, t, beta, i1, i2, i1, t1, r, b, v)
        + _psi_bs02(s, t, 1.0, i1, i2, i1, t1, r, b, v)
        - _psi_bs02(s, t, 1.0, k, i2, i1, t1, r, b, v)
        - k * _psi_bs02(s, t, 0.0, i1, i2, i1, t1, r, b, v)
        + k * _psi_bs02(s, t, 0.0, k, i2, i1, t1, r, b, v)
    )
    euro = bsm_price(s, k, t, r, q, v, 'call')
    return max(c, euro, s - k, 0.0)


def bs02_price(s: float, k: float, t: float, r: float, q: float, vol: float, opt_type: str) -> float:
    if t <= 0.0:
        return max(0.0, s - k) if opt_type == 'call' else max(0.0, k - s)
    if opt_type == 'call':
        return _bs02_call(s, k, t, r, q, vol)
    return _bs02_call(k, s, t, q, r, vol)


def solve_bs02_iv(s: float, k: float, t: float, r: float, q: float, opt_type: str, target_price: float) -> float:
    lo = 1e-6
    hi = IV_CAP
    f_lo = bs02_price(s, k, t, r, q, lo, opt_type) - target_price
    f_hi = bs02_price(s, k, t, r, q, hi, opt_type) - target_price
    if f_lo * f_hi > 0.0:
        raise ValueError(f'BS02 IV bracket failed: {f_lo=}, {f_hi=}')
    for _ in range(150):
        mid = 0.5 * (lo + hi)
        f_mid = bs02_price(s, k, t, r, q, mid, opt_type) - target_price
        if abs(f_mid) < 1e-14 or (hi - lo) < 1e-14:
            return mid
        if f_lo * f_mid <= 0.0:
            hi = mid
        else:
            lo = mid
            f_lo = f_mid
    return 0.5 * (lo + hi)


def bs02_greeks_fd(s: float, k: float, t: float, r: float, q: float, vol: float, opt_type: str) -> dict[str, float]:
    px = bs02_price(s, k, t, r, q, vol, opt_type)
    hs = max(1e-5, 1e-4 * s)
    hv = max(1e-4, 5e-4 * vol)
    ht = max(1e-6, min(1e-4, 0.01 * t))
    hr = 1e-4

    p_up = bs02_price(s + hs, k, t, r, q, vol, opt_type)
    p_dn = bs02_price(s - hs, k, t, r, q, vol, opt_type)
    delta = (p_up - p_dn) / (2.0 * hs)
    gamma = (p_up - 2.0 * px + p_dn) / (hs * hs)

    p_tp = bs02_price(s, k, t + ht, r, q, vol, opt_type)
    p_tm = bs02_price(s, k, t - ht, r, q, vol, opt_type)
    theta = -(p_tp - p_tm) / (2.0 * ht)

    p_vp = bs02_price(s, k, t, r, q, vol + hv, opt_type)
    p_vm = bs02_price(s, k, t, r, q, vol - hv, opt_type)
    vega = (p_vp - p_vm) / (2.0 * hv)

    p_rp = bs02_price(s, k, t, r + hr, q, vol, opt_type)
    p_rm = bs02_price(s, k, t, r - hr, q, vol, opt_type)
    rho = (p_rp - p_rm) / (2.0 * hr)

    p_uv = bs02_price(s + hs, k, t, r, q, vol + hv, opt_type)
    p_umv = bs02_price(s + hs, k, t, r, q, vol - hv, opt_type)
    p_dv = bs02_price(s - hs, k, t, r, q, vol + hv, opt_type)
    p_dmv = bs02_price(s - hs, k, t, r, q, vol - hv, opt_type)
    vanna = (p_uv - p_umv - p_dv + p_dmv) / (4.0 * hs * hv)

    delta_t_minus = (bs02_price(s + hs, k, t - ht, r, q, vol, opt_type) - bs02_price(s - hs, k, t - ht, r, q, vol, opt_type)) / (2.0 * hs)
    delta_t_plus = (bs02_price(s + hs, k, t + ht, r, q, vol, opt_type) - bs02_price(s - hs, k, t + ht, r, q, vol, opt_type)) / (2.0 * hs)
    charm = (delta_t_minus - delta_t_plus) / (2.0 * ht)

    return {
        'price': px,
        'delta': delta,
        'gamma': gamma,
        'theta': theta,
        'thetaDaily': theta / 365.0,
        'vega': vega,
        'vegaPer1Pct': vega / 100.0,
        'rho': rho,
        'vanna': vanna,
        'charm': charm,
    }


def crr_american_price(s: float, k: float, t: float, r: float, q: float, vol: float, opt_type: str, steps: int = 1200) -> float:
    dt = t / steps
    u = math.exp(vol * math.sqrt(dt))
    d = 1.0 / u
    disc = math.exp(-r * dt)
    p = (math.exp((r - q) * dt) - d) / (u - d)
    if p < 0.0 or p > 1.0:
        raise ValueError(f'CRR risk-neutral prob out of bounds: {p}')
    one_m_p = 1.0 - p

    is_call = opt_type == 'call'
    values = [0.0] * (steps + 1)
    for j in range(steps + 1):
        st = s * (u ** (2 * j - steps))
        values[j] = max(0.0, st - k) if is_call else max(0.0, k - st)

    for i in range(steps - 1, -1, -1):
        for j in range(i + 1):
            cont = disc * (p * values[j + 1] + one_m_p * values[j])
            st = s * (u ** (2 * j - i))
            ex = max(0.0, st - k) if is_call else max(0.0, k - st)
            values[j] = cont if cont > ex else ex
    return values[0]


def solve_crr_iv(s: float, k: float, t: float, r: float, q: float, opt_type: str, target_price: float, steps: int = 1200) -> float:
    dt = t / steps
    min_crr_vol = max(0.02, abs(r - q) * math.sqrt(dt) * 1.1)
    lo = min_crr_vol
    hi = 3.0
    f_lo = crr_american_price(s, k, t, r, q, lo, opt_type, steps) - target_price
    f_hi = crr_american_price(s, k, t, r, q, hi, opt_type, steps) - target_price
    while f_lo * f_hi > 0.0 and hi < IV_CAP:
        hi = min(IV_CAP, hi * 1.5)
        f_hi = crr_american_price(s, k, t, r, q, hi, opt_type, steps) - target_price
    for _ in range(100):
        mid = 0.5 * (lo + hi)
        f_mid = crr_american_price(s, k, t, r, q, mid, opt_type, steps) - target_price
        if abs(f_mid) < 1e-13 or (hi - lo) < 1e-13:
            return mid
        if f_lo * f_mid <= 0.0:
            hi = mid
        else:
            lo = mid
            f_lo = f_mid
    return 0.5 * (lo + hi)


def crr_greeks_fd(s: float, k: float, t: float, r: float, q: float, vol: float, opt_type: str, steps: int = 1200) -> dict[str, float]:
    px = crr_american_price(s, k, t, r, q, vol, opt_type, steps)
    hs = max(1e-3, 5e-4 * s)
    hv = 1e-3
    ht = min(1e-4, 0.01 * t)
    p_up = crr_american_price(s + hs, k, t, r, q, vol, opt_type, steps)
    p_dn = crr_american_price(s - hs, k, t, r, q, vol, opt_type, steps)
    delta = (p_up - p_dn) / (2.0 * hs)
    gamma = (p_up - 2.0 * px + p_dn) / (hs * hs)
    p_vp = crr_american_price(s, k, t, r, q, vol + hv, opt_type, steps)
    p_vm = crr_american_price(s, k, t, r, q, vol - hv, opt_type, steps)
    vega = (p_vp - p_vm) / (2.0 * hv)
    p_tp = crr_american_price(s, k, t + ht, r, q, vol, opt_type, steps)
    p_tm = crr_american_price(s, k, t - ht, r, q, vol, opt_type, steps)
    theta = -(p_tp - p_tm) / (2.0 * ht)
    p_uv = crr_american_price(s + hs, k, t, r, q, vol + hv, opt_type, steps)
    p_umv = crr_american_price(s + hs, k, t, r, q, vol - hv, opt_type, steps)
    p_dv = crr_american_price(s - hs, k, t, r, q, vol + hv, opt_type, steps)
    p_dmv = crr_american_price(s - hs, k, t, r, q, vol - hv, opt_type, steps)
    vanna = (p_uv - p_umv - p_dv + p_dmv) / (4.0 * hs * hv)
    delta_t_minus = (crr_american_price(s + hs, k, t - ht, r, q, vol, opt_type, steps) - crr_american_price(s - hs, k, t - ht, r, q, vol, opt_type, steps)) / (2.0 * hs)
    delta_t_plus = (crr_american_price(s + hs, k, t + ht, r, q, vol, opt_type, steps) - crr_american_price(s - hs, k, t + ht, r, q, vol, opt_type, steps)) / (2.0 * hs)
    charm = (delta_t_minus - delta_t_plus) / (2.0 * ht)
    return {
        'price': px,
        'delta': delta,
        'gamma': gamma,
        'theta': theta,
        'thetaDaily': theta / 365.0,
        'vega': vega,
        'vegaPer1Pct': vega / 100.0,
        'vanna': vanna,
        'charm': charm,
    }


def pchip_slopes(xs: list[float], ys: list[float]) -> list[float]:
    """Independent Fritsch-Carlson PCHIP derivative calculation."""
    n = len(xs)
    if n < 2:
        return [0.0] * n
    if n == 2:
        s = (ys[1] - ys[0]) / (xs[1] - xs[0])
        return [s, s]
    h = [xs[i + 1] - xs[i] for i in range(n - 1)]
    sec = [(ys[i + 1] - ys[i]) / h[i] for i in range(n - 1)]
    d = [0.0] * n
    for i in range(1, n - 1):
        if sec[i - 1] == 0.0 or sec[i] == 0.0 or (sec[i - 1] > 0.0) != (sec[i] > 0.0):
            d[i] = 0.0
        else:
            w1 = 2.0 * h[i] + h[i - 1]
            w2 = h[i] + 2.0 * h[i - 1]
            d[i] = (w1 + w2) / (w1 / sec[i - 1] + w2 / sec[i])

    def _edge(h0: float, h1: float, m0: float, m1: float) -> float:
        if m0 == 0.0:
            return 0.0
        slope = ((2.0 * h0 + h1) * m0 - h0 * m1) / (h0 + h1)
        if (slope > 0.0) != (m0 > 0.0):
            return 0.0
        if (m0 > 0.0) != (m1 > 0.0) and abs(slope) > abs(3.0 * m0):
            return 3.0 * m0
        return slope

    d[0] = _edge(h[0], h[1], sec[0], sec[1])
    d[n - 1] = _edge(h[n - 2], h[n - 3], sec[n - 2], sec[n - 3])
    return d


def pchip_segment_derivs(
    k0: float,
    k1: float,
    w0: float,
    w1: float,
    d0: float,
    d1: float,
    u: float,
) -> tuple[float, float, float]:
    h = k1 - k0
    u2 = u * u
    u3 = u2 * u
    h00 = 2.0 * u3 - 3.0 * u2 + 1.0
    h10 = u3 - 2.0 * u2 + u
    h01 = -2.0 * u3 + 3.0 * u2
    h11 = u3 - u2
    w = h00 * w0 + h10 * h * d0 + h01 * w1 + h11 * h * d1

    dh00 = (6.0 * u2 - 6.0 * u) / h
    dh10 = 3.0 * u2 - 4.0 * u + 1.0
    dh01 = (-6.0 * u2 + 6.0 * u) / h
    dh11 = 3.0 * u2 - 2.0 * u
    wp = dh00 * w0 + dh10 * d0 + dh01 * w1 + dh11 * d1

    ddh00 = (12.0 * u - 6.0) / (h * h)
    ddh10 = (6.0 * u - 4.0) / h
    ddh01 = (-12.0 * u + 6.0) / (h * h)
    ddh11 = (6.0 * u - 2.0) / h
    wpp = ddh00 * w0 + ddh10 * d0 + ddh01 * w1 + ddh11 * d1
    return w, wp, wpp


def durrleman_g(k: float, w: float, wp: float, wpp: float) -> float:
    term1 = 1.0 - (k * wp) / (2.0 * w)
    term2 = -0.25 * (0.25 + 1.0 / w) * (wp * wp)
    term3 = 0.5 * wpp
    return term1 * term1 + term2 + term3


def min_durrleman_for_nodes(strikes: list[float], ivs: list[float], forward: float, t: float, samples_per_seg: int = 16) -> float:
    ks = [math.log(k / forward) for k in strikes]
    ws = [iv * iv * t for iv in ivs]
    ds = pchip_slopes(ks, ws)
    min_g = math.inf
    for i in range(len(ks) - 1):
        for step in range(samples_per_seg + 1):
            u = step / samples_per_seg
            kq = ks[i] + u * (ks[i + 1] - ks[i])
            w, wp, wpp = pchip_segment_derivs(ks[i], ks[i + 1], ws[i], ws[i + 1], ds[i], ds[i + 1], u)
            g = durrleman_g(kq, w, wp, wpp)
            if g < min_g:
                min_g = g
    return min_g


def build_reference_fixture() -> dict[str, Any]:
    # Canonical Q3 OEX Put parameters (S=80, K=100, T=0.5, r=0.10, q=0, mid=21.0)
    s_can = d_float('80')
    k_can = d_float('100')
    t_can = d_float('0.5')
    r_can = d_float('0.10')
    q_can = d_float('0.0')
    mid_can = d_float('21.0')
    mid_below_intrinsic = d_float('19.50')

    iv_bsm_can = solve_bsm_iv(s_can, k_can, t_can, r_can, q_can, 'put', mid_can)
    iv_crr1200_can = solve_crr_iv(s_can, k_can, t_can, r_can, q_can, 'put', mid_can, 1200)
    iv_bs02_can = solve_bs02_iv(s_can, k_can, t_can, r_can, q_can, 'put', mid_can)
    px_crr_at_bsm_iv = crr_american_price(s_can, k_can, t_can, r_can, q_can, iv_bsm_can, 'put', 1200)
    px_crr_at_bs02_iv = crr_american_price(s_can, k_can, t_can, r_can, q_can, iv_bs02_can, 'put', 1200)
    px_bs02_at_bs02_iv = bs02_price(s_can, k_can, t_can, r_can, q_can, iv_bs02_can, 'put')
    px_bs02_at_bsm_iv = bs02_price(s_can, k_can, t_can, r_can, q_can, iv_bsm_can, 'put')

    greeks_bsm_can = bsm_greeks(s_can, k_can, t_can, r_can, q_can, iv_bsm_can, 'put')
    greeks_bs02_can = bs02_greeks_fd(s_can, k_can, t_can, r_can, q_can, iv_bs02_can, 'put')
    greeks_crr_can = crr_greeks_fd(s_can, k_can, t_can, r_can, q_can, iv_crr1200_can, 'put', 1200)

    lb_eur_can, ub_eur_can = bsm_bounds(s_can, k_can, t_can, r_can, q_can, 'put')
    intrinsic_amr_can, lb_amr_can, ub_amr_can = american_bounds(s_can, k_can, t_can, r_can, q_can, 'put')
    iv_bsm_at_19_50 = solve_bsm_iv(s_can, k_can, t_can, r_can, q_can, 'put', mid_below_intrinsic)

    # Case Q3-8 ATM Fallback at atm_iv = 0.35 on OEX vs XEO
    atm_iv_q3_8 = d_float('0.35')
    greeks_bs02_atm_fallback = bs02_greeks_fd(s_can, k_can, t_can, r_can, q_can, atm_iv_q3_8, 'put')
    greeks_bsm_atm_fallback = bsm_greeks(s_can, k_can, t_can, r_can, q_can, atm_iv_q3_8, 'put')

    # Case Q3-9 Merton zero-dividend Call & High-dividend ITM Call
    s_call = d_float('120')
    k_call = d_float('100')
    t_call = d_float('0.5')
    r_merton = d_float('0.05')
    q_merton = d_float('0.0')
    sigma_merton = d_float('0.30')
    merton_px_bsm = bsm_price(s_call, k_call, t_call, r_merton, q_merton, sigma_merton, 'call')
    merton_px_bs02 = bs02_price(s_call, k_call, t_call, r_merton, q_merton, sigma_merton, 'call')
    merton_px_crr = crr_american_price(s_call, k_call, t_call, r_merton, q_merton, sigma_merton, 'call', 1200)

    r_highq = d_float('0.04')
    q_highq = d_float('0.08')
    mid_highq = d_float('21.20')
    iv_highq_bsm = solve_bsm_iv(s_call, k_call, t_call, r_highq, q_highq, 'call', mid_highq)
    iv_highq_bs02 = solve_bs02_iv(s_call, k_call, t_call, r_highq, q_highq, 'call', mid_highq)
    iv_highq_crr = solve_crr_iv(s_call, k_call, t_call, r_highq, q_highq, 'call', mid_highq, 1200)
    px_highq_amr_at_030 = bs02_price(s_call, k_call, t_call, r_highq, q_highq, 0.30, 'call')
    px_highq_eur_at_030 = bsm_price(s_call, k_call, t_call, r_highq, q_highq, 0.30, 'call')
    greeks_highq_bs02 = bs02_greeks_fd(s_call, k_call, t_call, r_highq, q_highq, iv_highq_bs02, 'call')

    # Q4 Surface fixtures (exact flat/mild skew fair options)
    # Use constant rate r=0.04, q=0.01, spot=100, T1=30/365, T2=60/365
    spot_q4 = 100.0
    r_q4 = 0.04
    q_q4 = 0.01
    t1_q4 = 30.0 / 365.0
    t2_q4 = 60.0 / 365.0
    strikes_q4 = [85.0, 90.0, 95.0, 100.0, 105.0, 110.0, 115.0]
    iv_flat_q4 = 0.25

    def build_fair_chain(t_val: float, iv_fn: Any) -> list[dict[str, Any]]:
        rows = []
        fwd = spot_q4 * math.exp((r_q4 - q_q4) * t_val)
        for strike in strikes_q4:
            # Build both call & put cleanly for put-call parity inference
            c_iv = iv_fn(strike, fwd)
            p_iv = c_iv
            c_fair = bsm_price(spot_q4, strike, t_val, r_q4, q_q4, c_iv, 'call')
            p_fair = bsm_price(spot_q4, strike, t_val, r_q4, q_q4, p_iv, 'put')
            # For American equity/ETF, also compute exact BS02 fair prices so OWN IV works cleanly!
            c_amr = bs02_price(spot_q4, strike, t_val, r_q4, q_q4, c_iv, 'call')
            p_amr = bs02_price(spot_q4, strike, t_val, r_q4, q_q4, p_iv, 'put')
            rows.append({
                'strike': strike,
                'iv': c_iv,
                'callFairEur': c_fair,
                'putFairEur': p_fair,
                'callFairAmr': c_amr,
                'putFairAmr': p_amr,
                'callBidEur': round(c_fair * 0.99, 6),
                'callAskEur': round(c_fair * 1.01, 6),
                'putBidEur': round(p_fair * 0.99, 6),
                'putAskEur': round(p_fair * 1.01, 6),
                'callBidAmr': round(c_amr * 0.99, 6),
                'callAskAmr': round(c_amr * 1.01, 6),
                'putBidAmr': round(p_amr * 0.99, 6),
                'putAskAmr': round(p_amr * 1.01, 6),
            })
        return rows

    flat_t1 = build_fair_chain(t1_q4, lambda k, fwd: iv_flat_q4)
    flat_t2 = build_fair_chain(t2_q4, lambda k, fwd: iv_flat_q4)

    fwd_t1 = spot_q4 * math.exp((r_q4 - q_q4) * t1_q4)
    fwd_t2 = spot_q4 * math.exp((r_q4 - q_q4) * t2_q4)
    min_g_flat_t1 = min_durrleman_for_nodes(strikes_q4, [iv_flat_q4] * len(strikes_q4), fwd_t1, t1_q4)
    min_g_flat_t2 = min_durrleman_for_nodes(strikes_q4, [iv_flat_q4] * len(strikes_q4), fwd_t2, t2_q4)

    # Mild skew Q4-6
    ivs_skew_t1 = [0.27, 0.26, 0.253, 0.25, 0.248, 0.247, 0.247]
    ivs_skew_t2 = [0.275, 0.265, 0.258, 0.255, 0.253, 0.252, 0.252]
    min_g_skew_t1 = min_durrleman_for_nodes(strikes_q4, ivs_skew_t1, fwd_t1, t1_q4)
    min_g_skew_t2 = min_durrleman_for_nodes(strikes_q4, ivs_skew_t2, fwd_t2, t2_q4)

    # Butterfly violation Q4-7a: huge spike at ATM creating negative g(k) at wings
    bf_strikes = [80.0, 90.0, 100.0, 110.0, 120.0]
    bf_ivs = [0.40, 0.20, 0.45, 0.20, 0.40]
    min_g_bf_viol = min_durrleman_for_nodes(bf_strikes, bf_ivs, fwd_t1, t1_q4)

    # Calendar violation Q4-7b: w(0, T2) < w(0, T1)
    cal_t1_ivs = [0.40, 0.40, 0.40, 0.40, 0.40]
    cal_t2_ivs = [0.22, 0.22, 0.22, 0.22, 0.22]
    cal_min_var_diff = min(
        (iv2 * iv2 * t2_q4) - (iv1 * iv1 * t1_q4)
        for iv1, iv2 in zip(cal_t1_ivs, cal_t2_ivs)
    )

    return {
        'meta': {
            'generator': 'tools/gen_pieza_q3_q4_reference.py',
            'piece': 'P1 Q3 + Q4',
            'precisionDecimals': 50,
            'simpsonPanelsBvn': 8000,
            'crrSteps': 1200,
        },
        'q3': {
            'canonical_oex_put': {
                'spot': s_can,
                'strike': k_can,
                'timeToExpiry': t_can,
                'rate': r_can,
                'dividendYield': q_can,
                'bid': 20.90,
                'ask': 21.10,
                'mid': mid_can,
                'belowIntrinsicMid': mid_below_intrinsic,
                'europeanLowerBound': lb_eur_can,
                'europeanUpperBound': ub_eur_can,
                'americanImmediateIntrinsic': intrinsic_amr_can,
                'americanLowerBound': lb_amr_can,
                'americanUpperBound': ub_amr_can,
                'ivBsm': iv_bsm_can,
                'ivCrr1200': iv_crr1200_can,
                'ivBs02': iv_bs02_can,
                'crr1200PriceAtBsmIv': px_crr_at_bsm_iv,
                'overpricingCrrAtBsmIv': px_crr_at_bsm_iv - mid_can,
                'crr1200PriceAtBs02Iv': px_crr_at_bs02_iv,
                'bs02PriceAtBs02Iv': px_bs02_at_bs02_iv,
                'bs02RepricingErrorRelAtBsmIv': abs(px_bs02_at_bsm_iv - mid_can) / mid_can,
                'ivBsmAtBelowAmericanIntrinsicMid': iv_bsm_at_19_50,
                'bs02Greeks': greeks_bs02_can,
                'crr1200Greeks': greeks_crr_can,
                'bsmGreeks': greeks_bsm_can,
            },
            'atm_fallback_oex_vs_xeo': {
                'atmIv': atm_iv_q3_8,
                'oexBs02Greeks': greeks_bs02_atm_fallback,
                'xeoBsmGreeks': greeks_bsm_atm_fallback,
            },
            'merton_and_dividend_call': {
                'mertonZeroDiv': {
                    'spot': s_call,
                    'strike': k_call,
                    'timeToExpiry': t_call,
                    'rate': r_merton,
                    'dividendYield': q_merton,
                    'sigma': sigma_merton,
                    'priceBsm': merton_px_bsm,
                    'priceBs02': merton_px_bs02,
                    'priceCrr1200': merton_px_crr,
                },
                'highDivEarlyExerciseCall': {
                    'spot': s_call,
                    'strike': k_call,
                    'timeToExpiry': t_call,
                    'rate': r_highq,
                    'dividendYield': q_highq,
                    'mid': mid_highq,
                    'priceAmrAt030': px_highq_amr_at_030,
                    'priceEurAt030': px_highq_eur_at_030,
                    'ivBsm': iv_highq_bsm,
                    'ivBs02': iv_highq_bs02,
                    'ivCrr1200': iv_highq_crr,
                    'bs02Greeks': greeks_highq_bs02,
                },
            },
        },
        'q4': {
            'spot': spot_q4,
            'rate': r_q4,
            'dividendYield': q_q4,
            't1': t1_q4,
            't2': t2_q4,
            'strikes': strikes_q4,
            'rthValidTwoSliceFlat': {
                'ivFlat': iv_flat_q4,
                'forwardT1': fwd_t1,
                'forwardT2': fwd_t2,
                'totalVarianceT1': iv_flat_q4 * iv_flat_q4 * t1_q4,
                'totalVarianceT2': iv_flat_q4 * iv_flat_q4 * t2_q4,
                'minDurrlemanT1': min_g_flat_t1,
                'minDurrlemanT2': min_g_flat_t2,
                'sliceT1': flat_t1,
                'sliceT2': flat_t2,
            },
            'mildSkewArbitrageFree': {
                'strikes': strikes_q4,
                'ivsT1': ivs_skew_t1,
                'ivsT2': ivs_skew_t2,
                'minDurrlemanT1': min_g_skew_t1,
                'minDurrlemanT2': min_g_skew_t2,
            },
            'butterflyViolation': {
                'strikes': bf_strikes,
                'ivs': bf_ivs,
                'forward': fwd_t1,
                't': t1_q4,
                'minDurrleman': min_g_bf_viol,
                'expectedStatus': 'FAIL',
            },
            'calendarViolation': {
                'strikes': bf_strikes,
                'ivsT1': cal_t1_ivs,
                'ivsT2': cal_t2_ivs,
                't1': t1_q4,
                't2': t2_q4,
                'minVarianceDiff': cal_min_var_diff,
                'expectedStatus': 'FAIL',
            },
        },
    }


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    out_path = root / 'fixtures' / 'pieza_q3_q4_reference.json'
    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = build_reference_fixture()
    out_path.write_text(json.dumps(payload, indent=2) + '\n', encoding='utf-8')
    print(f'Wrote {out_path} ({out_path.stat().st_size} bytes)')


if __name__ == '__main__':
    main()
