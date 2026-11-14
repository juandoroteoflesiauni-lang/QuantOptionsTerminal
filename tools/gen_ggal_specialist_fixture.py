#!/usr/bin/env python3
"""
Generador independiente (Python stdlib puro) de fixtures de referencia para Pieza 20 — GGAL Specialist.

Calcula desde primeros principios matemáticos (sin copiar lógica de TypeScript):
  1. Fricciones BYMA + IVA 21 %, escala block, préstamo corto, SEC Section 31 y FINRA TAF Q4-2026,
     calendarios hábiles/feriados AR/US, EST/EDT vs. ART y liquidación delta_1 / delta_ex.
  2. Motor 1 (Parity Gap): paridad 24hs/CI->24hs, benchmark AL30/GD30, calibración OU AR(1) causal,
     predictor pre-apertura pre-11:00 ART con repricing Taylor de opciones y STALE_DATA_LOCK/EOD_CIERRE.
  3. Motor 2 (Triángulo de Volatilidad): BS02 americano T+0/24hs con dividendos discretos post-JUL-26,
     ejercicios anticipados pre-ex-dividendo, Modos A y B (incluyendo DUAL_ROOT_NEG_CORR y
     VIOLATION_BYMA_COMPRESSED), EWMA, HAR-RV, varianza total OPRA y anomalías por moneyness z.
  4. Motor 3 (Densidad Dual P vs. Q): cópula t-Student bivariada cuasi-MLE + simulación Halton (2,3,5)
     con deflación CER, ajuste SVI Zeliade sin arbitraje de mariposa + Breeden-Litzenberger Q,
     KDE Silverman, divergencia KL(P||Q) y dislocación de colas al 10 %.
  5. Motor 4 (Estructura & Pinning): Anexo B IAMC ponderado en nominales, Signed GEX/Vanna/Charm,
     Zero-Gamma por Brent, flujo Lee-Ready ADR + proxy discreto BYMA 20s y PinScore 15:30 ART.
  6. Motor 5 (Selector de Estrategias): puntas ejecutables Bid/Ask reales, Bull Call, Bear Put,
     Ratios 1x2 y 1x3, Buy-Write T+0/24hs (Ec. 78 vs. Lecap) y Calendar Roll 2M vs. OPRA USD.
"""

from __future__ import annotations

import datetime as dt
import json
import math
from pathlib import Path
from statistics import NormalDist
from typing import Any
from zoneinfo import ZoneInfo

STD_NORM = NormalDist(0.0, 1.0)
AR_TZ = ZoneInfo("America/Argentina/Buenos_Aires")
NY_TZ = ZoneInfo("America/New_York")

DAYS_PER_YEAR = 365.0
SECONDS_PER_DAY = 86_400
SECONDS_PER_YEAR_365 = DAYS_PER_YEAR * SECONDS_PER_DAY
TRADING_DAYS_PER_YEAR = 252.0
LOT_SIZE = 100
ADR_RATIO = 10

NAN_TOKEN = "__NaN__"
POS_INF_TOKEN = "__PosInf__"
NEG_INF_TOKEN = "__NegInf__"


def encode_num(val: float) -> Any:
    if isinstance(val, bool):
        return val
    if isinstance(val, int):
        return val
    if math.isnan(val):
        return NAN_TOKEN
    if math.isinf(val):
        return POS_INF_TOKEN if val > 0 else NEG_INF_TOKEN
    return val


def sanitize_json(obj: Any) -> Any:
    if isinstance(obj, float):
        return encode_num(obj)
    if isinstance(obj, dict):
        return {k: sanitize_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [sanitize_json(v) for v in obj]
    return obj


# ==============================================================================
# UTILIDADES BÁSICAS: FECHAS, HUSOS HORARIOS, COSTOS Y BRENT
# ==============================================================================

def utc_sec_from_iso(iso_z: str) -> int:
    parsed = dt.datetime.fromisoformat(iso_z.replace("Z", "+00:00"))
    return int(parsed.timestamp())


def iso_from_utc_sec(sec: int) -> str:
    return dt.datetime.fromtimestamp(sec, tz=dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def get_tz_parts(utc_sec: int, tz: ZoneInfo) -> dict[str, Any]:
    d = dt.datetime.fromtimestamp(utc_sec, tz=dt.timezone.utc).astimezone(tz)
    offset = d.utcoffset()
    offset_min = int(round(offset.total_seconds() / 60.0)) if offset is not None else 0
    return {
        "year": d.year,
        "month": d.month,
        "day": d.day,
        "hour": d.hour,
        "minute": d.minute,
        "second": d.second,
        "weekday": d.isoweekday(),
        "dateKey": d.strftime("%Y-%m-%d"),
        "minutesOfDay": d.hour * 60 + d.minute,
        "utcOffsetMinutes": offset_min,
        "dstMode": "EDT" if offset_min == -240 else "EST",
    }


def is_trading_day_str(date_key: str, holidays: set[str]) -> bool:
    d = dt.date.fromisoformat(date_key)
    return d.isoweekday() <= 5 and date_key not in holidays


def settlement_calendar_days(trade_date_key: str, settle_bdays: int, holidays: set[str]) -> int:
    if settle_bdays <= 0:
        return 0
    d = dt.date.fromisoformat(trade_date_key)
    cal = 0
    rem = settle_bdays
    while rem > 0:
        d = d + dt.timedelta(days=1)
        cal += 1
        if d.isoweekday() <= 5 and d.isoformat() not in holidays:
            rem -= 1
    return cal


def trading_days_between(from_key: str, to_key: str, holidays: set[str]) -> int:
    d0 = dt.date.fromisoformat(from_key)
    d1 = dt.date.fromisoformat(to_key)
    if d0 == d1:
        return 0
    step = 1 if d1 > d0 else -1
    count = 0
    cur = d0
    while cur != d1:
        cur = cur + dt.timedelta(days=step)
        if cur.isoweekday() <= 5 and cur.isoformat() not in holidays:
            count += step
    return count


def exp_1530_art_utc(expiry_date_key: str) -> int:
    d = dt.date.fromisoformat(expiry_date_key)
    art_dt = dt.datetime(d.year, d.month, d.day, 15, 30, 0, tzinfo=AR_TZ)
    return int(art_dt.astimezone(dt.timezone.utc).timestamp())


DEFAULT_BYMA_FEES = {
    "equityAlycRate": 0.001,
    "equityDmRate": 0.0005,
    "useEquityBlockTier": False,
    "equityBlockThresholdArs": 15_000_000.0,
    "equityBlockFixedArs": 10_500.0,
    "equityBlockExcessRate": 0.000484,
    "optionAlycRate": 0.0025,
    "optionDmRate": 0.002,
    "exerciseAlycRate": 0.001,
    "exerciseDmRate": 0.0005,
    "bondAlycRate": 0.001,
    "bondDmRate": 0.0001,
    "bondVatApplies": False,
    "vatRate": 0.21,
    "shortLoanRate": 0.0002,
}

DEFAULT_US_FEES = {
    "secSection31Rate": 20.6 / 1_000_000.0,
    "finraTafEquityPerShareUsd": 0.000166,
    "finraTafOptionPerContractUsd": 0.00279,
    "occFeePerContractUsd": 0.02,
    "orfFeePerContractUsd": 0.02,
    "exchangeFeePerContractUsd": 0.0,
    "brokerEquityPerShareUsd": 0.0,
    "brokerOptionPerContractUsd": 0.0,
}

FINRA_TAF_HOLIDAY_START = utc_sec_from_iso("2026-10-01T00:00:00Z")
FINRA_TAF_HOLIDAY_END = utc_sec_from_iso("2027-01-01T00:00:00Z")


def byma_fee_rate(notional_ars: float, leg_kind: str, sched: dict[str, Any] = DEFAULT_BYMA_FEES) -> float:
    vat_mult = 1.0 + sched["vatRate"]
    if leg_kind == "EQUITY":
        alyc = sched["equityAlycRate"]
        thr = sched.get("equityBlockThresholdArs", 15_000_000.0)
        fixed = sched.get("equityBlockFixedArs", 10_500.0)
        exc = sched.get("equityBlockExcessRate", 0.000484)
        if sched.get("useEquityBlockTier") and notional_ars > thr and thr > 0:
            dm = (fixed + (notional_ars - thr) * exc) / notional_ars
        else:
            dm = sched["equityDmRate"]
    elif leg_kind == "OPTION_PREMIUM":
        alyc = sched["optionAlycRate"]
        dm = sched["optionDmRate"]
    elif leg_kind == "EXERCISE":
        alyc = sched["exerciseAlycRate"]
        dm = sched["exerciseDmRate"]
    elif leg_kind == "SOVEREIGN_BOND":
        alyc = sched["bondAlycRate"]
        dm = sched["bondDmRate"]
        vat_mult = (1.0 + sched["vatRate"]) if sched.get("bondVatApplies", False) else 1.0
    else:
        return math.nan
    return (alyc + dm) * vat_mult


def byma_short_loan_rate(holding_days: float, sched: dict[str, Any] = DEFAULT_BYMA_FEES) -> float:
    capped = min(holding_days, 90.0)
    return sched.get("shortLoanRate", 0.0002) * (capped / 360.0) * (1.0 + sched["vatRate"])


def is_finra_taf_suspended(utc_sec: int) -> bool:
    return FINRA_TAF_HOLIDAY_START <= utc_sec < FINRA_TAF_HOLIDAY_END


def us_equity_fee_rate(utc_sec: int, adr_price: float, side: str, sched: dict[str, Any] = DEFAULT_US_FEES) -> float:
    broker_rate = sched["brokerEquityPerShareUsd"] / adr_price
    if side == "BUY":
        return broker_rate
    taf = 0.0 if is_finra_taf_suspended(utc_sec) else sched["finraTafEquityPerShareUsd"]
    return sched["secSection31Rate"] + taf / adr_price + broker_rate


def us_option_fee_rate(utc_sec: int, opt_price: float, side: str, sched: dict[str, Any] = DEFAULT_US_FEES) -> float:
    notional = LOT_SIZE * opt_price
    fixed = (
        sched["occFeePerContractUsd"]
        + sched["orfFeePerContractUsd"]
        + sched["exchangeFeePerContractUsd"]
        + sched["brokerOptionPerContractUsd"]
    )
    if side == "BUY":
        return fixed / notional
    taf = 0.0 if is_finra_taf_suspended(utc_sec) else sched["finraTafOptionPerContractUsd"]
    return sched["secSection31Rate"] + (taf + fixed) / notional


def interp_rate_curve(curve: list[dict[str, float]], horizon_days: float) -> float:
    pts = sorted(curve, key=lambda p: p["days"])
    if horizon_days <= pts[0]["days"]:
        return pts[0]["continuousRateAnnual"]
    if horizon_days >= pts[-1]["days"]:
        return pts[-1]["continuousRateAnnual"]
    for i in range(1, len(pts)):
        if horizon_days <= pts[i]["days"]:
            span = pts[i]["days"] - pts[i - 1]["days"]
            if span <= 0:
                return pts[i - 1]["continuousRateAnnual"]
            alpha = (horizon_days - pts[i - 1]["days"]) / span
            return pts[i - 1]["continuousRateAnnual"] * (1.0 - alpha) + pts[i]["continuousRateAnnual"] * alpha
    return math.nan


def brent_root(fn: Any, lower: float, upper: float, tol: float = 1e-9, max_iter: int = 120) -> float:
    a, b, c = lower, upper, upper
    fa, fb = fn(a), fn(b)
    if math.isnan(fa) or math.isnan(fb):
        return math.nan
    if abs(fa) <= tol:
        return a
    if abs(fb) <= tol:
        return b
    if (fa > 0 and fb > 0) or (fa < 0 and fb < 0):
        return math.nan
    fc = fb
    d = b - a
    e = d
    eps = 2.220446049250313e-16
    for _ in range(max_iter):
        if (fb > 0 and fc > 0) or (fb < 0 and fc < 0):
            c = a
            fc = fa
            d = b - a
            e = d
        if abs(fc) < abs(fb):
            a, b, c = b, c, b
            fa, fb, fc = fb, fc, fb
        tol1 = 2.0 * eps * abs(b) + 0.5 * tol
        xm = 0.5 * (c - b)
        if abs(xm) <= tol1 or abs(fb) <= tol:
            return b
        if abs(e) >= tol1 and abs(fa) > abs(fb):
            s = fb / fa
            if a == c:
                p = 2.0 * xm * s
                q = 1.0 - s
            else:
                q1 = fa / fc
                r = fb / fc
                p = s * (2.0 * xm * q1 * (q1 - r) - (b - a) * (r - 1.0))
                q = (q1 - 1.0) * (r - 1.0) * (s - 1.0)
            if p > 0:
                q = -q
            p = abs(p)
            min1 = 3.0 * xm * q - abs(tol1 * q)
            min2 = abs(e * q)
            if 2.0 * p < (min1 if min1 < min2 else min2):
                e = d
                d = p / q
            else:
                d = xm
                e = d
        else:
            d = xm
            e = d
        a = b
        fa = fb
        b += d if abs(d) > tol1 else (tol1 if xm >= 0 else -tol1)
        fb = fn(b)
        if math.isnan(fb):
            return math.nan
    return b


# ==============================================================================
# BLACK-SCHOLES & BJERKSUND-STENSLAND 2002 (INDEPENDIENTE EN PYTHON)
# ==============================================================================

# Cuadratura Gauss-Legendre 5 puntos en [0, 1] para normal bivariada de Genz (2004)
GL5_X = [0.046910077030668, 0.230765344947158, 0.5, 0.769234655052842, 0.953089922969332]
GL5_W = [0.118463442528095, 0.239314335249683, 0.284444444444444, 0.239314335249683, 0.118463442528095]
GL10_X = [
    0.01304673574141413996, 0.06746831665550774463, 0.16029521585048779688,
    0.28330230293537640460, 0.42556283050918439456, 0.57443716949081560544,
    0.71669769706462359540, 0.83970478414951220312, 0.93253168334449225537,
    0.98695326425858586004,
]
GL10_W = [
    0.03333567215434406880, 0.07472567457529029657, 0.10954318125799102199,
    0.13463335965499817755, 0.14776211235737643508, 0.14776211235737643508,
    0.13463335965499817755, 0.10954318125799102199, 0.07472567457529029657,
    0.03333567215434406880,
]


def norm_cdf(x: float) -> float:
    return STD_NORM.cdf(x)


def norm_pdf(x: float) -> float:
    return STD_NORM.pdf(x)


def bvn_cdf(a: float, b: float, rho: float) -> float:
    """Normal bivariada estandar P(Z1 <= a, Z2 <= b) via identidad de Drezner-Wesolowsky."""
    rho = max(-0.999999999999, min(0.999999999999, rho))
    if a == -math.inf or b == -math.inf:
        return 0.0
    if a == math.inf:
        return norm_cdf(b)
    if b == math.inf:
        return norm_cdf(a)
    if abs(rho) < 1e-12:
        return norm_cdf(a) * norm_cdf(b)

    # Identidad exacta via integral en [0, asin(rho)] (Genz 2004)
    h = -a
    k = -b
    hk = h * k
    bv = 0.0
    n_sub = 4
    if abs(rho) < 0.925:
        hs = 0.5 * (h * h + k * k)
        asr = math.asin(rho)
        for sub in range(n_sub):
            for xi, wi in zip(GL10_X, GL10_W):
                u = (sub + xi) / n_sub
                w = wi / n_sub
                sn = math.sin(asr * u)
                bv += w * math.exp((sn * hk - hs) / (1.0 - sn * sn))
        return max(0.0, min(1.0, bv * asr / (2.0 * math.pi) + norm_cdf(-h) * norm_cdf(-k)))

    if rho < 0:
        k = -k
        hk = -hk
    ass = (1.0 - rho) * (1.0 + rho)
    a2 = math.sqrt(ass)
    bs = (h - k) ** 2
    c = (4.0 - hk) / 8.0
    d = (12.0 - hk) / 16.0
    asr = -(bs / ass + hk) / 2.0
    if asr > -100.0:
        bv = a2 * math.exp(asr) * (1.0 - c * (bs - ass) * (1.0 - d * bs / 5.0) / 3.0 + c * d * ass * ass / 5.0)
    if -hk < 100.0:
        b2 = math.sqrt(bs)
        bv -= math.exp(-hk / 2.0) * math.sqrt(2.0 * math.pi) * norm_cdf(-b2 / a2) * b2 * (
            1.0 - c * bs * (1.0 - d * bs / 5.0) / 3.0
        )
    a2 *= 0.5
    for sub in range(n_sub):
        for xi, wi in zip(GL10_X, GL10_W):
            u = (sub + xi) / n_sub
            w = wi / n_sub
            for sgn in (-1.0, 1.0):
                xs = (a2 * (1.0 + sgn * u)) ** 2
                rs = math.sqrt(1.0 - xs)
                asr = -(bs / xs + hk) / 2.0
                if asr > -100.0:
                    bv += 0.5 * a2 * w * math.exp(asr) * (
                        math.exp(-hk * (1.0 - rs) / (2.0 * (1.0 + rs))) / rs - (1.0 + c * xs * (1.0 + d * xs))
                    )
    bv = -bv / (2.0 * math.pi) + (norm_cdf(-max(h, k)) if rho > 0 else 0.0)
    if rho > 0:
        return max(0.0, min(1.0, bv))
    return max(0.0, min(1.0, norm_cdf(-h) - bv))


def price_bsm_eur(spot: float, strike: float, T: float, r: float, q: float, sigma: float, opt_type: str) -> float:
    if T <= 0 or sigma <= 0:
        return max(0.0, spot - strike) if opt_type == "call" else max(0.0, strike - spot)
    srt = sigma * math.sqrt(T)
    d1 = (math.log(spot / strike) + (r - q + 0.5 * sigma * sigma) * T) / srt
    d2 = d1 - srt
    if opt_type == "call":
        return spot * math.exp(-q * T) * norm_cdf(d1) - strike * math.exp(-r * T) * norm_cdf(d2)
    return strike * math.exp(-r * T) * norm_cdf(-d2) - spot * math.exp(-q * T) * norm_cdf(-d1)


def _phi_bs02(S: float, T: float, gamma: float, H: float, I: float, r: float, b: float, v: float) -> float:
    v2 = v * v
    srt = v * math.sqrt(T)
    lam = (-r + gamma * b + 0.5 * gamma * (gamma - 1.0) * v2) * T
    kappa = (2.0 * b) / v2 + (2.0 * gamma - 1.0)
    d1 = -(math.log(S / H) + (b + (gamma - 0.5) * v2) * T) / srt
    d2 = -(math.log((I * I) / (S * H)) + (b + (gamma - 0.5) * v2) * T) / srt
    return math.exp(lam) * (S ** gamma) * (norm_cdf(d1) - ((I / S) ** kappa) * norm_cdf(d2))


def _psi_bs02(S: float, T: float, gamma: float, H: float, I2: float, I1: float, t1: float, r: float, b: float, v: float) -> float:
    v2 = v * v
    srt1 = v * math.sqrt(t1)
    srt = v * math.sqrt(T)
    e1 = -(math.log(S / I1) + (b + (gamma - 0.5) * v2) * t1) / srt1
    e2 = -(math.log((I2 * I2) / (S * I1)) + (b + (gamma - 0.5) * v2) * t1) / srt1
    e3 = -(math.log(S / I1) - (b + (gamma - 0.5) * v2) * t1) / srt1
    e4 = -(math.log((I2 * I2) / (S * I1)) - (b + (gamma - 0.5) * v2) * t1) / srt1
    f1 = -(math.log(S / H) + (b + (gamma - 0.5) * v2) * T) / srt
    f2 = -(math.log((I2 * I2) / (S * H)) + (b + (gamma - 0.5) * v2) * T) / srt
    f3 = -(math.log((I1 * I1) / (S * H)) + (b + (gamma - 0.5) * v2) * T) / srt
    f4 = -(math.log((S * I1 * I1) / (H * I2 * I2)) + (b + (gamma - 0.5) * v2) * T) / srt
    rho = math.sqrt(t1 / T)
    lam = -r + gamma * b + 0.5 * gamma * (gamma - 1.0) * v2
    kappa = (2.0 * b) / v2 + (2.0 * gamma - 1.0)
    term = (
        bvn_cdf(e1, f1, rho)
        - ((I2 / S) ** kappa) * bvn_cdf(e2, f2, rho)
        - ((I1 / S) ** kappa) * bvn_cdf(e3, f3, -rho)
        + ((I1 / I2) ** kappa) * bvn_cdf(e4, f4, -rho)
    )
    return math.exp(lam * T) * (S ** gamma) * term


def _bs02_call(S: float, K: float, T: float, r: float, b: float, v: float) -> float:
    q = r - b
    eur = price_bsm_eur(S, K, T, r, q, v, "call")
    if b >= r:
        return eur
    v2 = v * v
    t1 = 0.5 * (math.sqrt(5.0) - 1.0) * T
    disc_arg = ((b / v2 - 0.5) ** 2) + (2.0 * r) / v2
    beta = (0.5 - b / v2) + math.sqrt(max(0.0, disc_arg))
    if abs(beta - 1.0) < 1e-12:
        return eur
    b_inf = (beta / (beta - 1.0)) * K
    b_zero = max(K, (r / max(1e-12, r - b)) * K) if r - b > 1e-12 else K

    def flat_trigger(tau: float) -> float:
        h = -(b * tau + 2.0 * v * math.sqrt(tau)) * ((K * K) / max(1e-12, (b_inf - b_zero) * b_zero))
        return b_zero + (b_inf - b_zero) * (1.0 - math.exp(h))

    I2 = flat_trigger(T)
    I1 = flat_trigger(T - t1)
    if S >= I2:
        return S - K
    alpha2 = (I2 - K) * (I2 ** (-beta))
    alpha1 = (I1 - K) * (I1 ** (-beta))
    val = (
        alpha2 * (S ** beta)
        - alpha2 * _phi_bs02(S, t1, beta, I2, I2, r, b, v)
        + _phi_bs02(S, t1, 1.0, I2, I2, r, b, v)
        - _phi_bs02(S, t1, 1.0, I1, I2, r, b, v)
        - K * _phi_bs02(S, t1, 0.0, I2, I2, r, b, v)
        + K * _phi_bs02(S, t1, 0.0, I1, I2, r, b, v)
        + alpha1 * _phi_bs02(S, t1, beta, I1, I2, r, b, v)
        - alpha1 * _psi_bs02(S, T, beta, I1, I2, I1, t1, r, b, v)
        + _psi_bs02(S, T, 1.0, I1, I2, I1, t1, r, b, v)
        - _psi_bs02(S, T, 1.0, K, I2, I1, t1, r, b, v)
        - K * _psi_bs02(S, T, 0.0, I1, I2, I1, t1, r, b, v)
        + K * _psi_bs02(S, T, 0.0, K, I2, I1, t1, r, b, v)
    )
    return max(eur, S - K, val)


def price_american_bs02(spot: float, strike: float, T: float, r: float, q: float, sigma: float, opt_type: str) -> float:
    if opt_type == "call":
        return _bs02_call(spot, strike, T, r, r - q, sigma)
    return _bs02_call(strike, spot, T, q, q - r, sigma)


def byma_eval_params(
    as_of_sec: int,
    spot_24h: float,
    expiry_key: str,
    delta1_days: int,
    delta_ex_days: int,
    rate_curve: list[dict[str, float]],
    dividends: list[dict[str, float]] | None = None,
    caucion_cont: float | None = None,
) -> dict[str, Any]:
    exp_sec = exp_1530_art_utc(expiry_key)
    t1 = delta1_days / DAYS_PER_YEAR
    t_exp = (exp_sec - as_of_sec) / SECONDS_PER_YEAR_365
    t_settle = t_exp + delta_ex_days / DAYS_PER_YEAR
    r1 = caucion_cont if caucion_cont is not None else interp_rate_curve(rate_curve, max(1, delta1_days))
    r_settle = interp_rate_curve(rate_curve, t_settle * DAYS_PER_YEAR)
    r_eff = r_settle * (t_settle / t_exp)
    pv_div = 0.0
    for div in (dividends or []):
        if as_of_sec < div["exDivUtcSec"] <= exp_sec:
            tau_pay = max(0.0, (div["payDateUtcSec"] - as_of_sec) / SECONDS_PER_YEAR_365)
            r_pay = interp_rate_curve(rate_curve, max(1.0, tau_pay * DAYS_PER_YEAR)) if tau_pay > 0 else 0.0
            pv_div += div["amountArs"] * math.exp(-r_pay * tau_pay)
    s_adj = spot_24h * math.exp(-r1 * t1) - pv_div
    fwd = s_adj * math.exp(r_eff * t_exp)
    return {
        "asOfUtcSec": as_of_sec,
        "expiry1530UtcSec": exp_sec,
        "spot24hArs": spot_24h,
        "adjustedSpotArs": s_adj,
        "forwardArs": fwd,
        "t1Years": t1,
        "r1Continuous": r1,
        "tExpYears": t_exp,
        "tSettleYears": t_settle,
        "rContAtSettle": r_settle,
        "rEff": r_eff,
        "pvDividendsArs": pv_div,
        "maturityDays": t_exp * DAYS_PER_YEAR,
    }


def price_byma_bs02(ep: dict[str, Any], strike: float, sigma: float, opt_type: str) -> float:
    return price_american_bs02(ep["adjustedSpotArs"], strike, ep["tExpYears"], ep["rEff"], 0.0, sigma, opt_type)


def greeks_byma_bs02(ep: dict[str, Any], strike: float, sigma: float, opt_type: str) -> dict[str, float]:
    S = ep["adjustedSpotArs"]
    T = ep["tExpYears"]
    r = ep["rEff"]
    d_adj = math.exp(-ep["r1Continuous"] * ep["t1Years"])

    if opt_type == "call" and r >= 0.0:
        srt = sigma * math.sqrt(T)
        d1 = (math.log(S / strike) + (r + 0.5 * sigma * sigma) * T) / srt
        d2 = d1 - srt
        n1 = norm_pdf(d1)
        disc_k = strike * math.exp(-r * T)
        price = S * norm_cdf(d1) - disc_k * norm_cdf(d2)
        delta_adj = norm_cdf(d1)
        gamma_adj = n1 / (S * srt)
        vega = S * n1 * math.sqrt(T)
        theta = -(S * n1 * sigma) / (2.0 * math.sqrt(T)) - r * disc_k * norm_cdf(d2)
        vanna_adj = -(n1 * d2) / sigma
        charm_adj = -n1 * (2.0 * r * T - d2 * srt) / (2.0 * T * srt)
        return {
            "price": price,
            "delta": delta_adj * d_adj,
            "gamma": gamma_adj * d_adj * d_adj,
            "vega": vega,
            "theta": theta,
            "vanna": vanna_adj * d_adj,
            "charm": charm_adj * d_adj,
        }

    ds = 1e-4 * S
    dv = 1e-4 * sigma
    dt = min(1e-4, 0.25 * T)

    p0 = price_american_bs02(S, strike, T, r, 0.0, sigma, opt_type)
    p_up = price_american_bs02(S + ds, strike, T, r, 0.0, sigma, opt_type)
    p_dn = price_american_bs02(S - ds, strike, T, r, 0.0, sigma, opt_type)
    delta_adj = (p_up - p_dn) / (2.0 * ds)
    gamma_adj = (p_up - 2.0 * p0 + p_dn) / (ds * ds)

    p_vup = price_american_bs02(S, strike, T, r, 0.0, sigma + dv, opt_type)
    p_vdn = price_american_bs02(S, strike, T, r, 0.0, sigma - dv, opt_type)
    vega = (p_vup - p_vdn) / (2.0 * dv)

    p_tup = price_american_bs02(S, strike, T + dt, r, 0.0, sigma, opt_type)
    p_tdn = price_american_bs02(S, strike, T - dt, r, 0.0, sigma, opt_type)
    theta = (p_tdn - p_tup) / (2.0 * dt)

    p_uv = price_american_bs02(S + ds, strike, T, r, 0.0, sigma + dv, opt_type)
    p_dv = price_american_bs02(S - ds, strike, T, r, 0.0, sigma - dv, opt_type)
    p_u_dv = price_american_bs02(S + ds, strike, T, r, 0.0, sigma - dv, opt_type)
    p_d_uv = price_american_bs02(S - ds, strike, T, r, 0.0, sigma + dv, opt_type)
    vanna_adj = (p_uv - p_u_dv - p_d_uv + p_dv) / (4.0 * ds * dv)

    delta_tup = (price_american_bs02(S + ds, strike, T + dt, r, 0.0, sigma, opt_type) - price_american_bs02(S - ds, strike, T + dt, r, 0.0, sigma, opt_type)) / (2.0 * ds)
    delta_tdn = (price_american_bs02(S + ds, strike, T - dt, r, 0.0, sigma, opt_type) - price_american_bs02(S - ds, strike, T - dt, r, 0.0, sigma, opt_type)) / (2.0 * ds)
    charm_adj = (delta_tdn - delta_tup) / (2.0 * dt)

    return {
        "price": p0,
        "delta": delta_adj * d_adj,
        "gamma": gamma_adj * d_adj * d_adj,
        "vega": vega,
        "theta": theta,
        "vanna": vanna_adj * d_adj,
        "charm": charm_adj * d_adj,
    }


def solve_byma_iv(ep: dict[str, Any], strike: float, opt_type: str, bid: float, ask: float, tol: float = 1e-7) -> dict[str, Any]:
    mid = 0.5 * (bid + ask)
    disc_k = strike * math.exp(-ep["rEff"] * ep["tExpYears"])
    if opt_type == "call":
        lb = max(0.0, ep["adjustedSpotArs"] - strike, ep["adjustedSpotArs"] - disc_k)
    else:
        lb = max(0.0, strike - ep["adjustedSpotArs"], disc_k - ep["adjustedSpotArs"])
    if ask < lb - 1e-9 or mid < lb - 1e-9:
        return {"iv": math.nan, "arbFlag": "ARB_INTRINSIC_VIOLATION", "lowerBoundArs": lb}
    iv = brent_root(lambda sig: price_byma_bs02(ep, strike, sig, opt_type) - mid, 0.01, 4.00, 1e-9, 100)
    if math.isnan(iv):
        return {"iv": math.nan, "arbFlag": "OUT_OF_BRACKET", "lowerBoundArs": lb}
    # Afinar precio con Brent sobre error en precio
    iv = brent_root(lambda sig: price_byma_bs02(ep, strike, sig, opt_type) - mid, max(0.01, iv - 0.05), min(4.0, iv + 0.05), 1e-11, 100)
    return {"iv": iv, "arbFlag": "OK", "lowerBoundArs": lb, "modelPriceAtIvArs": price_byma_bs02(ep, strike, iv, opt_type)}


# ==============================================================================
# MOTOR 1 — PARIDAD DUAL-LISTING & GAP PREDICTOR
# ==============================================================================

def run_motor1_scenarios() -> dict[str, Any]:
    ar_holidays = {"2026-11-23"}
    us_holidays: set[str] = set()

    # Escenario 1: Overlap simultáneo con divergencia rentable LONG_BYMA_SHORT_ADR y filas futuras causales
    t_overlap = utc_sec_from_iso("2026-11-18T15:30:00Z") # 12:30 ART / 10:30 EST
    t_overlap_art = get_tz_parts(t_overlap, AR_TZ)
    t_overlap_ny = get_tz_parts(t_overlap, NY_TZ)
    delta_ar_1 = settlement_calendar_days(t_overlap_art["dateKey"], 1, ar_holidays) # jue 19 -> 1
    delta_us_1 = settlement_calendar_days(t_overlap_ny["dateKey"], 1, us_holidays)

    byma24h = {"bid": 5100.0, "ask": 5110.0}
    byma_ci = {"bid": 5094.0, "ask": 5102.0}
    adr = {"bid": 44.80, "ask": 44.90}
    sofr = 0.043
    caucion_tna = 0.34
    bonds = [
        {"ticker": "AL30", "ars24h": {"bid": 73_200.0, "ask": 73_400.0}, "usdC24h": {"bid": 62.10, "ask": 62.30}, "arsNominalBase": 100, "usdCNominalBase": 100},
        {"ticker": "GD30", "ars24h": {"bid": 76_450.0, "ask": 76_700.0}, "usdC24h": {"bid": 64.90, "ask": 65.15}, "arsNominalBase": 100, "usdCNominalBase": 100},
    ]

    # Historial OU determinista con reversión a mu = -0.005 y 2 filas futuras que DEBEN ignorarse
    hist_ou = []
    x_val = -0.020
    phi_true = 0.65
    mu_true = -0.004
    for idx in range(25):
        ts = t_overlap - (25 - idx) * SECONDS_PER_DAY
        ccl_sov = 1175.0 + 0.5 * idx
        ccl_ggal = ccl_sov * math.exp(x_val)
        hist_ou.append({"time": ts, "cclGgal24h": ccl_ggal, "cclSovereign": ccl_sov})
        shock = 0.0015 if (idx % 2 == 0) else -0.0012
        x_val = mu_true + phi_true * (x_val - mu_true) + shock
    # Filas futuras contaminadas (no deben entrar al cálculo causal)
    hist_ou.append({"time": t_overlap + 3600, "cclGgal24h": 2500.0, "cclSovereign": 1000.0})
    hist_ou.append({"time": t_overlap + 7200, "cclGgal24h": 3500.0, "cclSovereign": 1000.0})

    def eval_parity(
        as_of: int,
        d912_ts: int,
        mass_ts: int,
        mode: str,
        b24: dict[str, float],
        bci: dict[str, float] | None,
        adr_q: dict[str, float],
        bnds: list[dict[str, Any]],
        hist: list[dict[str, Any]],
        prev_close: float | None = None,
        pre_open: dict[str, Any] | None = None,
        pre_opts: list[dict[str, Any]] | None = None,
        z_thr: float = 2.0,
        min_edge: float = 30.0,
    ) -> dict[str, Any]:
        art = get_tz_parts(as_of, AR_TZ)
        ny = get_tz_parts(as_of, NY_TZ)
        ar_td = is_trading_day_str(art["dateKey"], ar_holidays)
        us_td = is_trading_day_str(ny["dateKey"], us_holidays)
        ar_open = ar_td and (660 <= art["minutesOfDay"] < 1020)
        ny_open = us_td and (570 <= ny["minutesOfDay"] < 960)
        in_pm = ar_td and (360 <= art["minutesOfDay"] < 660)
        if ar_open and ny_open:
            regime = "OVERLAP"
        elif ar_open and not ny_open:
            regime = "BYMA_ONLY"
        elif in_pm:
            regime = "PREMARKET_REPRICE"
        elif not ar_open and ny_open:
            regime = "NASDAQ_SOLO_17_18"
        else:
            regime = "CLOSED"

        d_ar = settlement_calendar_days(art["dateKey"], 1, ar_holidays)
        d_us = settlement_calendar_days(ny["dateKey"], 1, us_holidays)
        stale_m = as_of - mass_ts
        stale_d = as_of - d912_ts
        stale_lock = (mode == "LIVE") and (stale_m > 20 or stale_d > 20 or abs(mass_ts - d912_ts) > 15)

        if stale_lock:
            return {
                "asOfUtcSec": as_of,
                "sessionRegime": regime,
                "dstMode": ny["dstMode"],
                "deltaAr1Days": d_ar,
                "deltaUs1Days": d_us,
                "signal": "STALE_DATA_LOCK",
                "cclGgal24h": math.nan,
                "cclSovereignBenchmark": math.nan,
            }

        mid_24 = 0.5 * (b24["bid"] + b24["ask"])
        mid_ci = 0.5 * (bci["bid"] + bci["ask"]) if bci is not None else math.nan
        mid_adr = 0.5 * (adr_q["bid"] + adr_q["ask"])
        sofr_fac = math.exp(sofr * ((d_ar - d_us) / DAYS_PER_YEAR))
        ccl_24 = (ADR_RATIO * mid_24) / (mid_adr * sofr_fac)
        ccl_ci = (ADR_RATIO * mid_ci * (1.0 + caucion_tna * (d_ar / DAYS_PER_YEAR))) / (mid_adr * sofr_fac) if bci is not None else math.nan

        ccl_al30 = math.nan
        ccl_gd30 = math.nan
        w_sum = 0.0
        w_ccl = 0.0
        w_ars_sp = 0.0
        w_us_sp = 0.0
        for bnd in bnds:
            am = 0.5 * (bnd["ars24h"]["bid"] + bnd["ars24h"]["ask"])
            um = 0.5 * (bnd["usdC24h"]["bid"] + bnd["usdC24h"]["ask"])
            asp = (bnd["ars24h"]["ask"] - bnd["ars24h"]["bid"]) / am
            usp = (bnd["usdC24h"]["ask"] - bnd["usdC24h"]["bid"]) / um
            cb = (am / bnd["arsNominalBase"]) / (um / bnd["usdCNominalBase"])
            if bnd["ticker"] == "AL30":
                ccl_al30 = cb
            elif bnd["ticker"] == "GD30":
                ccl_gd30 = cb
            s_tot = asp + usp
            w = 1.0 / (s_tot * s_tot)
            w_sum += w
            w_ccl += w * cb
            w_ars_sp += w * asp
            w_us_sp += w * usp
        ccl_sov = w_ccl / w_sum
        avg_ars_sp = w_ars_sp / w_sum
        avg_us_sp = w_us_sp / w_sum

        causal = sorted([r for r in hist if r["time"] <= as_of], key=lambda r: r["time"])
        xs = [math.log(r["cclGgal24h"]) - math.log(r["cclSovereign"]) for r in causal]
        n_pairs = len(xs) - 1
        mx = sum(xs[:-1]) / n_pairs
        my = sum(xs[1:]) / n_pairs
        cov = sum((xs[i] - mx) * (xs[i + 1] - my) for i in range(n_pairs))
        vx = sum((xs[i] - mx) ** 2 for i in range(n_pairs))
        phi = cov / vx
        inter = my - phi * mx
        kappa = -math.log(phi)
        mu_log = inter / (1.0 - phi)
        half_life = math.log(2.0) / kappa
        sse = sum((xs[i + 1] - (phi * xs[i] + inter)) ** 2 for i in range(n_pairs))
        res_sig = math.sqrt(sse / (n_pairs - 2))
        eq_sig = math.sqrt((res_sig * res_sig) / (1.0 - phi * phi))

        sp_log = math.log(ccl_24) - math.log(ccl_sov)
        sp_bps = sp_log * 10_000.0
        z_score = (sp_log - mu_log) / eq_sig

        byma_sp = (b24["ask"] - b24["bid"]) / mid_24
        adr_sp = (adr_q["ask"] - adr_q["bid"]) / mid_adr
        c_eq = byma_fee_rate(1_000_000.0, "EQUITY")
        c_bd = byma_fee_rate(1_000_000.0, "SOVEREIGN_BOND")
        c_us = us_equity_fee_rate(as_of, mid_adr, "SELL")
        tot_fric = 0.5 * byma_sp + 0.5 * adr_sp + 0.5 * avg_ars_sp + 0.5 * avg_us_sp + c_eq + 2.0 * c_bd + c_us
        net_edge = (abs(sp_log - mu_log) - tot_fric) * 10_000.0

        m5 = mu_log + (sp_log - mu_log) * math.exp(-kappa * 5.0)
        v5 = eq_sig * math.sqrt(1.0 - math.exp(-2.0 * kappa * 5.0))
        theta_ex = 0.5 * eq_sig
        p_close = norm_cdf((mu_log + theta_ex - m5) / v5) - norm_cdf((mu_log - theta_ex - m5) / v5)

        fair_adr = (ADR_RATIO * mid_24) / (ccl_sov * sofr_fac)
        repricing_out: list[dict[str, Any]] = []
        if pre_open is not None:
            r_adr_adj = math.log((mid_adr + pre_open.get("adrExDividendUsd", 0.0)) / pre_open["adrPrev1700ArtUsd"])
            logit = 40.0 * adr_sp - 0.35 * math.log(1.0 + pre_open.get("adrPreMarketVolume", 0.0))
            w_pm = 1.0 / (1.0 + math.exp(logit))
            r_spy = pre_open.get("spyOvernightLogReturn", 0.0)
            r_qqq = pre_open.get("qqqOvernightLogReturn", 0.0)
            r_adr_eff = w_pm * r_adr_adj + (1.0 - w_pm) * (1.25 * r_spy + 0.25 * r_qqq)
            ovn_d = pre_open.get("overnightDays", 1.0)
            ou_drift = -(1.0 - math.exp(-kappa * ovn_d)) * (pre_open["prevDaySpreadLog1700"] - mu_log)
            fair_open = pre_open["bymaPrevClose24hArs"] * math.exp(r_adr_eff + ou_drift) - pre_open.get("bymaExDividendArs", 0.0)
            dS = fair_open - pre_open["bymaPrevClose24hArs"]
            dt_yr = ovn_d / DAYS_PER_YEAR
            for opt in (pre_opts or []):
                dv = opt.get("deltaImpliedVol", 0.0)
                dV = opt["delta"] * dS + 0.5 * opt["gamma"] * dS * dS + opt["vega"] * dv + opt["theta"] * dt_yr
                fo = opt["prevCloseArs"] + dV
                repricing_out.append({
                    "tickerByma": opt["tickerByma"],
                    "prevCloseArs": opt["prevCloseArs"],
                    "fairOpenArs": fo,
                    "deltaRepricePct": ((fo - opt["prevCloseArs"]) / opt["prevCloseArs"]) * 100.0,
                })
        else:
            fair_open = (mid_adr * sofr_fac * ccl_sov) / ADR_RATIO

        sig = "NEUTRAL"
        if abs(z_score) >= z_thr and net_edge > min_edge and half_life <= 5.0:
            sig = "SHORT_BYMA_LONG_ADR" if z_score > 0 else "LONG_BYMA_SHORT_ADR"

        return {
            "asOfUtcSec": as_of,
            "sessionRegime": regime,
            "dstMode": ny["dstMode"],
            "deltaAr1Days": d_ar,
            "deltaUs1Days": d_us,
            "spot": {
                "byma24hArs": mid_24,
                "bymaCiArs": mid_ci,
                "adrMidUsd": mid_adr,
                "fairBymaOpenArs": fair_open,
                "fairAdrUsd": fair_adr,
            },
            "ccl": {
                "cclGgal24h": ccl_24,
                "cclGgalCiTo24h": ccl_ci,
                "cclAl30_24h": ccl_al30,
                "cclGd30_24h": ccl_gd30,
                "cclSovereignBenchmark": ccl_sov,
                "spreadLogBps": sp_bps,
                "ouMeanBps": mu_log * 10_000.0,
                "ouHalfLifeDays": half_life,
                "ouEqSigmaBps": eq_sig * 10_000.0,
                "zScore": z_score,
                "netEdgeAfterCostsBps": net_edge,
                "closeProbability5d": p_close,
            },
            "ouCalibration": {
                "excludedFutureCount": len(hist) - len(causal),
                "observationsUsed": len(causal),
                "phi": phi,
                "kappaPerDay": kappa,
                "muLog": mu_log,
                "eqSigma": eq_sig,
            },
            "signal": sig,
            "preOpenOptionRepricing": repricing_out,
        }

    sc_overlap = eval_parity(t_overlap, t_overlap - 3, t_overlap - 2, "LIVE", byma24h, byma_ci, adr, bonds, hist_ou, prev_close=5220.0)

    t_nasdaq_est = utc_sec_from_iso("2026-11-18T20:30:00Z") # 17:30 ART, 15:30 EST -> NASDAQ_SOLO_17_18
    t_july_edt = utc_sec_from_iso("2026-07-15T20:30:00Z") # 17:30 ART, 16:30 EDT -> CLOSED
    t_preopen_edt = utc_sec_from_iso("2026-07-15T12:30:00Z") # 09:30 ART pre-market EDT

    # Historial estacionario AR(1) (0 < phi < 1) para pre-open julio EDT
    hist_jul = [
        {
            "time": t_preopen_edt - (20 - i) * SECONDS_PER_DAY,
            "cclGgal24h": 1152.0 * math.exp(-0.002 + 0.006 * math.sin(i * 0.45) + 0.001 * ((i % 3) - 1)),
            "cclSovereign": 1152.0,
        }
        for i in range(20)
    ]
    pre_open_cfg = {
        "bymaPrevClose24hArs": 5000.0,
        "adrPrev1700ArtUsd": 43.20,
        "adrPreMarketVolume": 120_000.0,
        "prevDaySpreadLog1700": -0.008,
        "overnightDays": 1.0,
        "spyOvernightLogReturn": 0.006,
        "qqqOvernightLogReturn": 0.008,
        "bymaExDividendArs": 0.0,
        "adrExDividendUsd": 0.0,
    }
    pre_opts_cfg = [
        {"tickerByma": "GFGC5200DI", "prevCloseArs": 210.0, "delta": 0.52, "gamma": 0.00045, "vega": 820.0, "theta": -950.0, "deltaImpliedVol": 0.015},
    ]
    sc_preopen = eval_parity(
        t_preopen_edt, t_preopen_edt - 4, t_preopen_edt - 2, "LIVE",
        {"bid": 5000.0, "ask": 5010.0}, None, {"bid": 44.10, "ask": 44.20}, bonds, hist_jul,
        pre_open=pre_open_cfg, pre_opts=pre_opts_cfg,
    )
    sc_stale = eval_parity(t_overlap, t_overlap - 45, t_overlap - 2, "LIVE", byma24h, None, adr, bonds, hist_ou)
    sc_eod = eval_parity(t_overlap, t_overlap - 7200, t_overlap - 7200, "EOD_CIERRE", byma24h, byma_ci, adr, bonds, hist_ou)

    return {
        "input_overlap": {
            "asOfUtcSec": t_overlap,
            "data912TimestampSec": t_overlap - 3,
            "massiveTimestampSec": t_overlap - 2,
            "marketMode": "LIVE",
            "arHolidays": sorted(ar_holidays),
            "usHolidays": [],
            "byma24h": byma24h,
            "bymaCi": byma_ci,
            "adr": adr,
            "sofrRateAnnual": sofr,
            "caucionArsRateTna": caucion_tna,
            "sovereignBonds": bonds,
            "spreadHistory": hist_ou,
            "bymaPrevClose24hArs": 5220.0,
        },
        "overlap": sc_overlap,
        "nasdaqSoloEst": {"asOfUtcSec": t_nasdaq_est, "dstMode": get_tz_parts(t_nasdaq_est, NY_TZ)["dstMode"], "sessionRegime": "NASDAQ_SOLO_17_18"},
        "julyCloseEdt": {"asOfUtcSec": t_july_edt, "dstMode": get_tz_parts(t_july_edt, NY_TZ)["dstMode"], "sessionRegime": "CLOSED"},
        "input_preopen": {
            "asOfUtcSec": t_preopen_edt,
            "data912TimestampSec": t_preopen_edt - 4,
            "massiveTimestampSec": t_preopen_edt - 2,
            "marketMode": "LIVE",
            "arHolidays": [],
            "usHolidays": [],
            "byma24h": {"bid": 5000.0, "ask": 5010.0},
            "adr": {"bid": 44.10, "ask": 44.20},
            "sofrRateAnnual": sofr,
            "caucionArsRateTna": caucion_tna,
            "sovereignBonds": bonds,
            "spreadHistory": hist_jul,
            "preOpen": pre_open_cfg,
            "preOpenOptions": pre_opts_cfg,
        },
        "preopenEdt": sc_preopen,
        "staleLock": sc_stale,
        "eodCierre": sc_eod,
    }


# ==============================================================================
# MOTOR 2 — TRIÁNGULO DE VOLATILIDAD CROSS-CURRENCY & BS02
# ==============================================================================

def ewma_correlation(pairs: list[dict[str, float]], as_of: int, lam: float = 0.94, min_obs: int = 15) -> float:
    causal = sorted([p for p in pairs if p["time"] <= as_of], key=lambda p: p["time"])
    if len(causal) < min_obs:
        return math.nan
    n = len(causal)
    ws = [lam ** (n - 1 - i) for i in range(n)]
    w_sum = sum(ws)
    mean_a = sum(w * item["adrLogReturn"] for w, item in zip(ws, causal)) / w_sum
    mean_c = sum(w * item["cclLogReturn"] for w, item in zip(ws, causal)) / w_sum
    s_xx = sum(w * (item["adrLogReturn"] - mean_a) ** 2 for w, item in zip(ws, causal))
    s_yy = sum(w * (item["cclLogReturn"] - mean_c) ** 2 for w, item in zip(ws, causal))
    s_xy = sum(w * (item["adrLogReturn"] - mean_a) * (item["cclLogReturn"] - mean_c) for w, item in zip(ws, causal))
    return s_xy / math.sqrt(s_xx * s_yy)


def solve_4x4(a: list[list[float]], b: list[float]) -> list[float]:
    m = [row[:] for row in a]
    rhs = b[:]
    for col in range(4):
        piv = max(range(col, 4), key=lambda r: abs(m[r][col]))
        m[col], m[piv] = m[piv], m[col]
        rhs[col], rhs[piv] = rhs[piv], rhs[col]
        for r in range(col + 1, 4):
            fac = m[r][col] / m[col][col]
            for c in range(col, 4):
                m[r][c] -= fac * m[col][c]
            rhs[r] -= fac * rhs[col]
    x = [0.0] * 4
    for i in range(3, -1, -1):
        rhs_i = rhs[i] - sum(m[i][c] * x[c] for c in range(i + 1, 4))
        x[i] = rhs_i / m[i][i]
    return x


def har_rv_forecast(daily_obs: list[dict[str, float]], as_of: int, min_obs: int = 40) -> float:
    causal = sorted([o for o in daily_obs if o["time"] <= as_of], key=lambda o: o["time"])
    if len(causal) < max(25, min_obs):
        return math.nan
    rvs = [o["logReturn"] ** 2 for o in causal]
    rows_x = []
    targets_y = []
    for t in range(21, len(rvs) - 1):
        rm5 = sum(rvs[t - 4: t + 1]) / 5.0
        rm22 = sum(rvs[t - 21: t + 1]) / 22.0
        rows_x.append([1.0, rvs[t], rm5, rm22])
        targets_y.append(rvs[t + 1])
    xtx = [[sum(r[i] * r[j] for r in rows_x) for j in range(4)] for i in range(4)]
    xty = [sum(rows_x[k][i] * targets_y[k] for k in range(len(rows_x))) for i in range(4)]
    beta = solve_4x4(xtx, xty)
    rm5_last = sum(rvs[-5:]) / 5.0
    rm22_last = sum(rvs[-22:]) / 22.0
    last_x = [1.0, rvs[-1], rm5_last, rm22_last]
    pred_rv = max(1e-10, sum(beta[i] * last_x[i] for i in range(4)))
    return math.sqrt(pred_rv * TRADING_DAYS_PER_YEAR)


def interp_opra_total_var_iv(slices: list[dict[str, Any]], target_T: float, target_z: float) -> float:
    def slice_iv_at_z(sl: dict[str, Any], z: float) -> float:
        pts = sorted(
            [(math.log(q["strike"] / sl["forwardUsd"]) / (sl["atmIvDecimal"] * math.sqrt(sl["timeToExpiryYears"])), q["ivDecimal"])
             for q in sl["quotes"]],
            key=lambda p: p[0],
        )
        if z <= pts[0][0]:
            return pts[0][1]
        if z >= pts[-1][0]:
            return pts[-1][1]
        for i in range(1, len(pts)):
            if z <= pts[i][0]:
                al = (z - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0])
                return pts[i - 1][1] * (1.0 - al) + pts[i][1] * al
        return math.nan

    sls = sorted(slices, key=lambda s: s["timeToExpiryYears"])
    for i in range(1, len(sls)):
        if sls[i - 1]["timeToExpiryYears"] <= target_T <= sls[i]["timeToExpiryYears"]:
            iv_l = slice_iv_at_z(sls[i - 1], target_z)
            iv_r = slice_iv_at_z(sls[i], target_z)
            tv_l = iv_l * iv_l * sls[i - 1]["timeToExpiryYears"]
            tv_r = iv_r * iv_r * sls[i]["timeToExpiryYears"]
            al = (target_T - sls[i - 1]["timeToExpiryYears"]) / (sls[i]["timeToExpiryYears"] - sls[i - 1]["timeToExpiryYears"])
            return math.sqrt((tv_l * (1.0 - al) + tv_r * al) / target_T)
    return math.nan


def run_motor2_scenarios() -> dict[str, Any]:
    as_of = utc_sec_from_iso("2026-11-10T16:00:00Z") # 13:00 ART
    expiry_key = "2026-12-18"
    ar_hols = {"2026-11-23"}
    delta1 = settlement_calendar_days("2026-11-10", 1, ar_hols) # 1
    delta_ex = settlement_calendar_days("2026-12-18", 1, ar_hols) # 3 (vie->lun)
    rate_curve = [
        {"days": 1.0, "continuousRateAnnual": 0.30},
        {"days": 30.0, "continuousRateAnnual": 0.31},
        {"days": 60.0, "continuousRateAnnual": 0.32},
    ]
    dividends = [
        {"exDivUtcSec": utc_sec_from_iso("2026-11-25T14:00:00Z"), "payDateUtcSec": utc_sec_from_iso("2026-11-27T14:00:00Z"), "amountArs": 90.0},
    ]
    spot_24h = 5200.0
    ep = byma_eval_params(as_of, spot_24h, expiry_key, delta1, delta_ex, rate_curve, dividends)

    # Chequeo unitario BS02 y griegas
    strike_test = 5200.0
    sigma_test = 0.56
    call_price_unit = price_byma_bs02(ep, strike_test, sigma_test, "call")
    put_price_unit = price_byma_bs02(ep, strike_test, sigma_test, "put")
    call_greeks_unit = greeks_byma_bs02(ep, strike_test, sigma_test, "call")

    # Ejercicio anticipado pre-ex-dividendo H_6 (Post-JUL-26 sin ajuste de strike)
    spot_pre_ex = 5400.0
    div_ex = 260.0
    spot_post_ex = spot_pre_ex - div_ex
    rem_t = 22.0 / DAYS_PER_YEAR
    r_eff_ex = 0.31
    r1_ex = 0.30
    k_ex = 4800.0
    exer_cost = k_ex * byma_fee_rate(k_ex * LOT_SIZE, "EXERCISE")
    s_adj_post = spot_post_ex * math.exp(-r1_ex * (1.0 / DAYS_PER_YEAR))
    cont_val = price_american_bs02(s_adj_post, k_ex, rem_t, r_eff_ex, 0.0, 0.45, "call")
    early_net = (spot_pre_ex - k_ex) * math.exp(-r1_ex * (1.0 / DAYS_PER_YEAR)) - exer_cost
    pre_ex_div_ref = {
        "input": {
            "spotPreExArs": spot_pre_ex,
            "spotPostEx24hArs": spot_post_ex,
            "strike": k_ex,
            "remainingTExpYears": rem_t,
            "rEff": r_eff_ex,
            "t1Years": 1.0 / DAYS_PER_YEAR,
            "r1Continuous": r1_ex,
            "volatility": 0.45,
            "exerciseAllInCostArs": exer_cost,
        },
        "continuationValueArs": cont_val,
        "earlyExerciseNetValueArs": early_net,
        "edgeArs": early_net - cont_val,
        "shouldExerciseEarly": early_net > cont_val,
    }

    # Historiales causales para EWMA corr & HAR-RV (con filas futuras para testear look-ahead)
    ret_pairs = []
    ccl_hist = []
    for i in range(60):
        ts = as_of - (60 - i) * SECONDS_PER_DAY
        r_adr = 0.015 * math.sin(i * 0.4) + 0.008 * math.cos(i * 0.9)
        r_ccl = 0.006 * math.sin(i * 0.4 + 0.5) + 0.011 * math.cos(i * 1.1)
        ret_pairs.append({"time": ts, "adrLogReturn": r_adr, "cclLogReturn": r_ccl})
        ccl_hist.append({"time": ts, "logReturn": r_ccl})
    # Filas futuras que no deben entrar
    ret_pairs.append({"time": as_of + 86_400, "adrLogReturn": 0.5, "cclLogReturn": -0.5})
    ccl_hist.append({"time": as_of + 86_400, "logReturn": 0.8})

    ewma_r = ewma_correlation(ret_pairs, as_of)
    har_ccl = har_rv_forecast(ccl_hist, as_of)

    # OPRA 2 slices alrededor de T_exp
    opra_slices = [
        {
            "timeToExpiryYears": 0.07,
            "forwardUsd": 45.2,
            "atmIvDecimal": 0.44,
            "quotes": [
                {"strike": 38.0, "contractType": "put", "ivDecimal": 0.52},
                {"strike": 42.0, "contractType": "put", "ivDecimal": 0.47},
                {"strike": 45.2, "contractType": "call", "ivDecimal": 0.44},
                {"strike": 49.0, "contractType": "call", "ivDecimal": 0.41},
                {"strike": 54.0, "contractType": "call", "ivDecimal": 0.39},
            ],
        },
        {
            "timeToExpiryYears": 0.16,
            "forwardUsd": 45.4,
            "atmIvDecimal": 0.46,
            "quotes": [
                {"strike": 36.0, "contractType": "put", "ivDecimal": 0.54},
                {"strike": 41.0, "contractType": "put", "ivDecimal": 0.49},
                {"strike": 45.4, "contractType": "call", "ivDecimal": 0.46},
                {"strike": 50.0, "contractType": "call", "ivDecimal": 0.43},
                {"strike": 56.0, "contractType": "call", "ivDecimal": 0.41},
            ],
        },
    ]
    opra_atm_iv = interp_opra_total_var_iv(opra_slices, ep["tExpYears"], 0.0)

    # Generar cadena BYMA desde IVs limpias (con call overwriting comprimiendo ala derecha)
    strikes_byma = [4400.0, 4800.0, 5200.0, 5600.0, 6000.0]
    ivs_normal = [0.64, 0.59, 0.56, 0.47, 0.42]
    byma_opts_normal = []
    for k, iv_val in zip(strikes_byma, ivs_normal):
        ct = "call" if k >= ep["forwardArs"] else "put"
        p_fair = price_byma_bs02(ep, k, iv_val, ct)
        byma_opts_normal.append({"strike": k, "contractType": ct, "quote": {"bid": p_fair - 1.5, "ask": p_fair + 1.5}})
    # Agregar 1 cotización violando intrínseco para probar arbViolationsCount
    lb_4400 = max(0.0, ep["adjustedSpotArs"] - 4400.0)
    byma_opts_normal.append({"strike": 4400.0, "contractType": "call", "quote": {"bid": lb_4400 - 20.0, "ask": lb_4400 - 15.0}})

    # Evaluar Normal Unique Root
    solved_mids = []
    for k, iv_val in zip(strikes_byma, ivs_normal):
        solved_mids.append((k, iv_val))
    # Interpolar ATM en F_BYMA
    byma_atm_norm = math.nan
    for i in range(1, len(solved_mids)):
        if ep["forwardArs"] <= solved_mids[i][0]:
            al = (ep["forwardArs"] - solved_mids[i - 1][0]) / (solved_mids[i][0] - solved_mids[i - 1][0])
            byma_atm_norm = solved_mids[i - 1][1] * (1.0 - al) + solved_mids[i][1] * al
            break
    disc_norm = byma_atm_norm ** 2 - (1.0 - ewma_r ** 2) * opra_atm_iv ** 2
    sigma_ccl_norm = (-ewma_r * opra_atm_iv + math.sqrt(disc_norm)) * 100.0
    rho_impl_norm = (byma_atm_norm ** 2 - opra_atm_iv ** 2 - har_ccl ** 2) / (2.0 * opra_atm_iv * har_ccl)

    z_scale_norm = byma_atm_norm * math.sqrt(ep["tExpYears"])
    right_comp = []
    for k, iv_val in zip(strikes_byma, ivs_normal):
        z = math.log(k / ep["forwardArs"]) / z_scale_norm
        op_z = interp_opra_total_var_iv(opra_slices, ep["tExpYears"], z)
        teor = math.sqrt(op_z ** 2 + har_ccl ** 2 + 2.0 * ewma_r * op_z * har_ccl) * 100.0
        rel_val = iv_val * 100.0 - teor
        if z > 0.5:
            right_comp.append(max(0.0, -rel_val))
    overwriting_score_norm = sum(right_comp) / len(right_comp)

    # Escenario Dual Root Negative Corr: BYMA ATM = 0.42 < OPRA ATM ~ 0.449, rho = -0.45, HAR = 0.35
    rho_neg = -0.45
    har_override_dual = 0.32
    byma_atm_dual = 0.415
    byma_opts_dual = [
        {"strike": k, "contractType": "call" if k >= ep["forwardArs"] else "put",
         "quote": {"bid": price_byma_bs02(ep, k, byma_atm_dual, "call" if k >= ep["forwardArs"] else "put") - 1.0,
                   "ask": price_byma_bs02(ep, k, byma_atm_dual, "call" if k >= ep["forwardArs"] else "put") + 1.0}}
        for k in strikes_byma
    ]
    disc_dual = byma_atm_dual ** 2 - (1.0 - rho_neg ** 2) * opra_atm_iv ** 2
    sig_plus_d = -rho_neg * opra_atm_iv + math.sqrt(disc_dual)
    sig_minus_d = -rho_neg * opra_atm_iv - math.sqrt(disc_dual)
    sig_dual_chosen = (sig_minus_d if abs(sig_minus_d - har_override_dual) < abs(sig_plus_d - har_override_dual) else sig_plus_d) * 100.0
    rho_impl_dual = (byma_atm_dual ** 2 - opra_atm_iv ** 2 - har_override_dual ** 2) / (2.0 * opra_atm_iv * har_override_dual)

    # Escenario Violation BYMA Compressed: BYMA ATM = 0.34 < sqrt(1 - rho^2)*OPRA
    byma_atm_viol = 0.34
    byma_opts_viol = [
        {"strike": k, "contractType": "call" if k >= ep["forwardArs"] else "put",
         "quote": {"bid": price_byma_bs02(ep, k, byma_atm_viol, "call" if k >= ep["forwardArs"] else "put") - 1.0,
                   "ask": price_byma_bs02(ep, k, byma_atm_viol, "call" if k >= ep["forwardArs"] else "put") + 1.0}}
        for k in strikes_byma
    ]
    rho_impl_viol = (byma_atm_viol ** 2 - opra_atm_iv ** 2 - har_override_dual ** 2) / (2.0 * opra_atm_iv * har_override_dual)

    return {
        "bymaEvalInput": {
            "asOfUtcSec": as_of,
            "spot24hArs": spot_24h,
            "expiryDateKey": expiry_key,
            "deltaAr1Days": delta1,
            "deltaExDays": delta_ex,
            "arHolidays": sorted(ar_hols),
            "rateCurve": rate_curve,
            "dividends": dividends,
        },
        "unitBs02": {
            "evalParams": ep,
            "strike": strike_test,
            "sigma": sigma_test,
            "callPrice": call_price_unit,
            "putPrice": put_price_unit,
            "callGreeks": call_greeks_unit,
            "ivCheckFromCallQuote": solve_byma_iv(ep, strike_test, "call", call_price_unit - 2.0, call_price_unit + 2.0),
        },
        "preExDivEarlyExercise": pre_ex_div_ref,
        "returnHistory": ret_pairs,
        "cclReturnHistory": ccl_hist,
        "opraSlices": opra_slices,
        "normalScenario": {
            "bymaOptions": byma_opts_normal,
            "bymaAtmIvPct": byma_atm_norm * 100.0,
            "opraAdrAtmIvPct": opra_atm_iv * 100.0,
            "realizedCorrEwma": ewma_r,
            "harRvCclPct": har_ccl * 100.0,
            "impliedCclVolPct": sigma_ccl_norm,
            "impliedCorrelation": rho_impl_norm,
            "overwritingCompressionScore": overwriting_score_norm,
            "arbViolationsCount": 1,
            "boundaryRegime": "NORMAL_UNIQUE_ROOT",
        },
        "dualRootScenario": {
            "bymaOptions": byma_opts_dual,
            "realizedCorrEwmaOverride": rho_neg,
            "harRvCclAnnualOverride": har_override_dual,
            "impliedCclVolPct": sig_dual_chosen,
            "impliedCorrelation": rho_impl_dual,
            "boundaryRegime": "DUAL_ROOT_NEG_CORR",
        },
        "violationScenario": {
            "bymaOptions": byma_opts_viol,
            "realizedCorrEwmaOverride": 0.25,
            "harRvCclAnnualOverride": har_override_dual,
            "impliedCclVolPct": None,
            "impliedCorrelation": rho_impl_viol,
            "boundaryRegime": "VIOLATION_BYMA_COMPRESSED",
        },
    }


# ==============================================================================
# MOTOR 3 — DENSIDAD DUAL P (USD/CER + CÓPULA T) VS. Q (SVI + BL)
# ==============================================================================

def reg_inc_beta(x: float, a: float, b: float) -> float:
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    ln_beta = math.lgamma(a) + math.lgamma(b) - math.lgamma(a + b)
    front = math.exp(math.log(x) * a + math.log(1.0 - x) * b - ln_beta)
    if x > (a + 1.0) / (a + b + 2.0):
        return 1.0 - reg_inc_beta(1.0 - x, b, a)
    # Lentz continued fraction
    f = 1.0
    c = 1.0
    d = 1.0 - (a + b) * x / (a + 1.0)
    if abs(d) < 1e-30:
        d = 1e-30
    d = 1.0 / d
    f = d
    for m in range(1, 200):
        m2 = 2 * m
        aa = (m * (b - m) * x) / ((a + m2 - 1.0) * (a + m2))
        d = 1.0 + aa * d
        c = 1.0 + aa / c
        if abs(d) < 1e-30:
            d = 1e-30
        if abs(c) < 1e-30:
            c = 1e-30
        d = 1.0 / d
        f *= c * d
        aa = -((a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1.0))
        d = 1.0 + aa * d
        c = 1.0 + aa / c
        if abs(d) < 1e-30:
            d = 1e-30
        if abs(c) < 1e-30:
            c = 1e-30
        d = 1.0 / d
        delta = c * d
        f *= delta
        if abs(delta - 1.0) < 1e-14:
            break
    return (front * f) / a


def student_t_cdf(t: float, nu: float) -> float:
    if t == 0.0:
        return 0.5
    x = nu / (nu + t * t)
    ib = reg_inc_beta(x, 0.5 * nu, 0.5)
    return 1.0 - 0.5 * ib if t > 0 else 0.5 * ib


def student_t_inv_cdf(p: float, nu: float) -> float:
    p = max(1e-10, min(1.0 - 1e-10, p))
    if abs(p - 0.5) < 1e-12:
        return 0.0
    lo, hi = -250.0, 250.0
    return brent_root(lambda z: student_t_cdf(z, nu) - p, lo, hi, 1e-11, 100)


def reg_gamma_p(a: float, x: float) -> float:
    if x <= 0.0:
        return 0.0
    if x < a + 1.0:
        ap = a
        tot = 1.0 / a
        delta = tot
        for _ in range(250):
            ap += 1.0
            delta *= x / ap
            tot += delta
            if abs(delta) < abs(tot) * 1e-14:
                return tot * math.exp(-x + a * math.log(x) - math.lgamma(a))
        return tot * math.exp(-x + a * math.log(x) - math.lgamma(a))
    b = x + 1.0 - a
    c = 1e30
    d = 1.0 / b
    h = d
    for i in range(1, 250):
        an = -i * (i - a)
        b += 2.0
        d = an * d + b
        if abs(d) < 1e-30:
            d = 1e-30
        c = b + an / c
        if abs(c) < 1e-30:
            c = 1e-30
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < 1e-14:
            break
    return 1.0 - math.exp(-x + a * math.log(x) - math.lgamma(a)) * h


def chi2_inv_cdf(p: float, nu: float) -> float:
    p = max(1e-10, min(1.0 - 1e-10, p))
    lo = 1e-8
    hi = max(50.0, nu * 15.0)
    while reg_gamma_p(0.5 * nu, 0.5 * hi) < p and hi < 1e7:
        hi *= 2.0
    return brent_root(lambda x: reg_gamma_p(0.5 * nu, 0.5 * x) - p, lo, hi, 1e-11, 100)


def halton_val(idx: int, base: int) -> float:
    f = 1.0
    r = 0.0
    i = idx
    while i > 0:
        f /= base
        r += f * (i % base)
        i //= base
    return r


def empirical_quantile_lin(sorted_asc: list[float], u: float) -> float:
    n = len(sorted_asc)
    pos = max(0.0, min(1.0, u)) * (n - 1)
    lo = math.floor(pos)
    hi = min(n - 1, lo + 1)
    al = pos - lo
    return sorted_asc[lo] * (1.0 - al) + sorted_asc[hi] * al


def svi_w(k: float, svi: dict[str, float]) -> float:
    dy = k - svi["m"]
    return svi["a"] + svi["b"] * (svi["rho"] * dy + math.sqrt(dy * dy + svi["sigma"] ** 2))


def svi_butterfly_g(k: float, svi: dict[str, float]) -> float:
    dy = k - svi["m"]
    r = math.sqrt(dy * dy + svi["sigma"] ** 2)
    w = svi["a"] + svi["b"] * (svi["rho"] * dy + r)
    if w <= 0 or r <= 0:
        return -math.inf
    wp = svi["b"] * (svi["rho"] + dy / r)
    wpp = (svi["b"] * svi["sigma"] ** 2) / (r * r * r)
    term1 = (1.0 - (k * wp) / (2.0 * w)) ** 2
    term2 = ((wp * wp) / 4.0) * (1.0 / w + 0.25)
    return term1 - term2 + 0.5 * wpp


def solve_3x3(a: list[list[float]], b: list[float]) -> list[float] | None:
    m = [r[:] for r in a]
    rhs = b[:]
    for col in range(3):
        piv = max(range(col, 3), key=lambda r: abs(m[r][col]))
        if abs(m[piv][col]) <= 1e-18:
            return None
        m[col], m[piv] = m[piv], m[col]
        rhs[col], rhs[piv] = rhs[piv], rhs[col]
        for r in range(col + 1, 3):
            fac = m[r][col] / m[col][col]
            for c in range(col, 3):
                m[r][c] -= fac * m[col][c]
            rhs[r] -= fac * rhs[col]
    x = [0.0, 0.0, 0.0]
    for i in range(2, -1, -1):
        val = rhs[i] - sum(m[i][c] * x[c] for c in range(i + 1, 3))
        if abs(m[i][i]) <= 1e-18:
            return None
        x[i] = val / m[i][i]
    return x


def calibrate_svi(fwd: float, T: float, nodes: list[dict[str, float]]) -> tuple[dict[str, float], float, float]:
    clean = sorted(
        [(math.log(n["strike"] / fwd), n["ivDecimal"] ** 2 * T) for n in nodes],
        key=lambda p: p[0],
    )
    k_chk_min = min(-0.8, clean[0][0] - 0.3)
    k_chk_max = max(0.8, clean[-1][0] + 0.3)

    def try_fit(m: float, s: float) -> tuple[dict[str, float], float, float] | None:
        mat = [[0.0] * 3 for _ in range(3)]
        rhs = [0.0] * 3
        for k, w in clean:
            dy = k - m
            x = [1.0, dy, math.sqrt(dy * dy + s * s)]
            for i in range(3):
                rhs[i] += x[i] * w
                for j in range(3):
                    mat[i][j] += x[i] * x[j]
        sol = solve_3x3(mat, rhs)
        if sol is None:
            return None
        a, d, b = sol
        if b <= 0 or abs(d) >= b * 0.995:
            return None
        rho = d / b
        if b * (1.0 + abs(rho)) >= 2.0:
            return None
        if a + b * s * math.sqrt(max(0.0, 1.0 - rho * rho)) <= 1e-6:
            return None
        cand = {"a": a, "b": b, "rho": rho, "m": m, "sigma": s}
        min_g = min(svi_butterfly_g(k_chk_min + (i / 64.0) * (k_chk_max - k_chk_min), cand) for i in range(65))
        if min_g < -1e-7:
            return None
        rmse = math.sqrt(sum((svi_w(k, cand) - w) ** 2 for k, w in clean) / len(clean))
        return cand, rmse, min_g

    best = None
    m_min = clean[0][0] - 0.1
    m_max = clean[-1][0] + 0.1
    for mi in range(13):
        m = m_min + (mi / 12.0) * (m_max - m_min)
        for s in (0.04, 0.08, 0.12, 0.18, 0.28, 0.42, 0.65):
            res = try_fit(m, s)
            if res is not None and (best is None or res[1] < best[1]):
                best = res
    assert best is not None
    step_m, step_s = 0.04, 0.04
    for _ in range(3):
        cm, cs = best[0]["m"], best[0]["sigma"]
        for dm in range(-2, 3):
            for ds in range(-2, 3):
                res = try_fit(cm + dm * step_m, max(0.01, cs + ds * step_s))
                if res is not None and res[1] < best[1]:
                    best = res
        step_m *= 0.35
        step_s *= 0.35
    return best


def run_motor3_scenarios() -> dict[str, Any]:
    # Pruebas puntuales especiales Gamma/Beta/t/invNorm
    special_vals = {
        "logGamma_5_5": math.lgamma(5.5),
        "regIncBeta_035_25_40": reg_inc_beta(0.35, 2.5, 4.0),
        "studentTCdf_175_4": student_t_cdf(1.75, 4.0),
        "studentTInvCdf_092_4": student_t_inv_cdf(0.92, 4.0),
        "invNormCdf_0975": STD_NORM.inv_cdf(0.975),
        "chi2InvCdf_080_5": chi2_inv_cdf(0.80, 5.0),
    }

    as_of = utc_sec_from_iso("2026-11-12T16:00:00Z")
    spot_ars = 5200.0
    spot_usd = 44.50
    cer_g = 0.032
    dte = 36

    # Serie histórica determinista (52 puntos + 2 futuras contaminadas que se excluyen)
    hist_series = []
    adr_p = 40.0
    ccl_p = 1100.0
    cer_p = 100.0
    for i in range(52):
        ts = as_of - (52 - i) * SECONDS_PER_DAY
        hist_series.append({"time": ts, "adrCloseUsd": adr_p, "cclGgal": ccl_p, "cerIndex": cer_p})
        r_a = 0.018 * math.sin(i * 0.55) + 0.0012
        r_c = -0.008 * math.sin(i * 0.55) + 0.010 * math.cos(i * 0.85) + 0.0014
        adr_p *= math.exp(r_a)
        cer_p *= math.exp(0.0009)
        ccl_p *= math.exp(r_c)
    hist_series.append({"time": as_of + 86_400, "adrCloseUsd": 90.0, "cclGgal": 2500.0, "cerIndex": 150.0})

    def eval_dual(byma_nodes: list[dict[str, float]], opra_nodes: list[dict[str, float]]) -> dict[str, Any]:
        causal = sorted([r for r in hist_series if r["time"] <= as_of], key=lambda r: r["time"])
        r_adr = [math.log(causal[i]["adrCloseUsd"] / causal[i - 1]["adrCloseUsd"]) for i in range(1, len(causal))]
        r_ccl = [math.log(causal[i]["cclGgal"] / causal[i - 1]["cclGgal"]) - math.log(causal[i]["cerIndex"] / causal[i - 1]["cerIndex"]) for i in range(1, len(causal))]

        def pseudo_obs(xs: list[float]) -> list[float]:
            n = len(xs)
            idx_sorted = sorted(range(n), key=lambda k: xs[k])
            ranks = [0.0] * n
            i = 0
            while i < n:
                j = i
                while j + 1 < n and xs[idx_sorted[j + 1]] == xs[idx_sorted[i]]:
                    j += 1
                avg_r = 0.5 * (i + j) + 1.0
                for k in range(i, j + 1):
                    ranks[idx_sorted[k]] = avg_r / (n + 1.0)
                i = j + 1
            return ranks

        u_a = pseudo_obs(r_adr)
        u_c = pseudo_obs(r_ccl)

        def copula_ll(z1: list[float], z2: list[float], rho: float, dof: float) -> float:
            omr = 1.0 - rho * rho
            c_norm = math.lgamma(0.5 * (dof + 2.0)) + math.lgamma(0.5 * dof) - 2.0 * math.lgamma(0.5 * (dof + 1.0)) - 0.5 * math.log(omr)
            s = len(z1) * c_norm
            for a, b in zip(z1, z2):
                q = (a * a + b * b - 2.0 * rho * a * b) / (dof * omr)
                s += -0.5 * (dof + 2.0) * math.log(1.0 + q) + 0.5 * (dof + 1.0) * (math.log(1.0 + a * a / dof) + math.log(1.0 + b * b / dof))
            return s

        gr = (math.sqrt(5.0) - 1.0) / 2.0
        dofs = [2.5, 3, 4, 5, 6, 8, 10, 14, 20, 30]

        def eval_dof(dof: float) -> tuple[float, float, float]:
            z1 = [student_t_inv_cdf(u, dof) for u in u_a]
            z2 = [student_t_inv_cdf(u, dof) for u in u_c]
            lo, hi = -0.98, 0.98
            x1 = hi - gr * (hi - lo)
            x2 = lo + gr * (hi - lo)
            f1, f2 = copula_ll(z1, z2, x1, dof), copula_ll(z1, z2, x2, dof)
            for _ in range(28):
                if f1 < f2:
                    lo = x1
                    x1 = x2
                    f1 = f2
                    x2 = lo + gr * (hi - lo)
                    f2 = copula_ll(z1, z2, x2, dof)
                else:
                    hi = x2
                    x2 = x1
                    f2 = f1
                    x1 = hi - gr * (hi - lo)
                    f1 = copula_ll(z1, z2, x1, dof)
            rb = 0.5 * (lo + hi)
            return rb, copula_ll(z1, z2, rb, dof), dof

        evals = [eval_dof(d) for d in dofs]
        b_idx = max(range(len(evals)), key=lambda i: evals[i][1])
        lo_d = dofs[max(0, b_idx - 1)]
        hi_d = dofs[min(len(dofs) - 1, b_idx + 1)]
        d1 = hi_d - gr * (hi_d - lo_d)
        d2 = lo_d + gr * (hi_d - lo_d)
        r1, r2 = eval_dof(d1), eval_dof(d2)
        for _ in range(14):
            if r1[1] < r2[1]:
                lo_d = d1
                d1, r1 = d2, r2
                d2 = lo_d + gr * (hi_d - lo_d)
                r2 = eval_dof(d2)
            else:
                hi_d = d2
                d2, r2 = d1, r1
                d1 = hi_d - gr * (hi_d - lo_d)
                r1 = eval_dof(d1)
        final_cop = r1 if r1[1] >= r2[1] else r2
        rho_hat, dof_hat = final_cop[0], final_cop[2]

        s_adr = sorted(r_adr)
        s_ccl = sorted(r_ccl)
        m_a = sum(r_adr) / len(r_adr)
        m_c = sum(r_ccl) / len(r_ccl)
        h_td = max(1, round(dte * TRADING_DAYS_PER_YEAR / DAYS_PER_YEAR))
        sqrt_h = math.sqrt(h_td)
        cer_log = math.log(1.0 + cer_g)
        n_sim = 128

        nodes_out = []
        spots_u, spots_a, logs_u, srets_u = [], [], [], []
        for idx in range(1, n_sim + 1):
            z1 = STD_NORM.inv_cdf(halton_val(idx, 2))
            z2 = STD_NORM.inv_cdf(halton_val(idx, 3))
            w_c = chi2_inv_cdf(halton_val(idx, 5), dof_hat)
            sc_t = math.sqrt(dof_hat / w_c)
            y1 = z1 * sc_t
            y2 = (rho_hat * z1 + math.sqrt(max(0.0, 1.0 - rho_hat ** 2)) * z2) * sc_t
            u1 = max(1e-6, min(1.0 - 1e-6, student_t_cdf(y1, dof_hat)))
            u2 = max(1e-6, min(1.0 - 1e-6, student_t_cdf(y2, dof_hat)))
            da = empirical_quantile_lin(s_adr, u1)
            dc = empirical_quantile_lin(s_ccl, u2)
            ha = h_td * m_a + sqrt_h * (da - m_a)
            hc = h_td * m_c + sqrt_h * (dc - m_c)
            su = spot_usd * math.exp(ha)
            sa = spot_ars * math.exp(ha + hc + cer_log)
            spots_u.append(su)
            spots_a.append(sa)
            logs_u.append(ha)
            srets_u.append(su / spot_usd - 1.0)
            nodes_out.append({"spotUsd": su, "spotArs": sa, "probability": 1.0 / n_sim})

        exp_ret_pct = (sum(srets_u) / n_sim) * 100.0
        mh_u = sum(logs_u) / n_sim
        vh_u = sum((x - mh_u) ** 2 for x in logs_u) / (n_sim - 1)
        vol_u_pct = math.sqrt(vh_u / (dte / DAYS_PER_YEAR)) * 100.0
        tc = max(1, math.floor(0.05 * n_sim))
        cvar95_pct = (sum(sorted(srets_u)[:tc]) / tc) * 100.0

        def build_q(fwd: float, T: float, r_c: float, T_s: float, sl_nodes: list[dict[str, float]], sim_spots: list[float], ref_spot: float) -> dict[str, Any]:
            svi, _, min_g = calibrate_svi(fwd, T, sl_nodes)
            w_atm = svi_w(0.0, svi)
            asrt = math.sqrt(w_atm)
            k_lo = max(0.1 * fwd, fwd * math.exp(-3.5 * asrt))
            k_hi = fwd * math.exp(3.5 * asrt)
            ng = 45
            dK = (k_hi - k_lo) / (ng - 1)
            r_eff = r_c * (T_s / T)
            sp_eur = fwd * math.exp(-r_eff * T)
            strikes = [k_lo + i * dK for i in range(ng)]
            c_px = [price_bsm_eur(sp_eur, K, T, r_eff, 0.0, math.sqrt(svi_w(math.log(K / fwd), svi) / T), "call") for K in strikes]
            growth = math.exp(r_c * T_s)
            int_k = strikes[1:-1]
            raw_q = [max(0.0, growth * ((c_px[j + 1] - 2.0 * c_px[j] + c_px[j - 1]) / (dK * dK))) * dK for j in range(1, ng - 1)]
            q_sum = sum(raw_q)
            q_p = [v / q_sum for v in raw_q]
            imp_mean = sum(k * p for k, p in zip(int_k, q_p))
            lret_q = [math.log(k / ref_spot) for k in int_k]
            mlq = sum(x * p for x, p in zip(lret_q, q_p))
            m2 = sum(p * (x - mlq) ** 2 for x, p in zip(lret_q, q_p))
            m3 = sum(p * (x - mlq) ** 3 for x, p in zip(lret_q, q_p))
            m4 = sum(p * (x - mlq) ** 4 for x, p in zip(lret_q, q_p))
            sdq = math.sqrt(m2)
            imp_vol = (sdq / math.sqrt(T)) * 100.0
            skew = m3 / (sdq ** 3)
            ekurt = m4 / (m2 * m2) - 3.0

            sp_sort = sorted(sim_spots)
            k10 = empirical_quantile_lin(sp_sort, 0.10)
            k90 = empirical_quantile_lin(sp_sort, 0.90)
            cdf_q = []
            acc = 0.0
            for p in q_p:
                acc += p
                cdf_q.append(acc)

            def eval_cdf(kv: float) -> float:
                if kv <= int_k[0]:
                    return 0.0
                if kv >= int_k[-1]:
                    return 1.0
                for i in range(1, len(int_k)):
                    if kv <= int_k[i]:
                        al = (kv - int_k[i - 1]) / (int_k[i] - int_k[i - 1])
                        return cdf_q[i - 1] * (1.0 - al) + cdf_q[i] * al
                return 1.0

            lt_diff = 0.10 - eval_cdf(k10)
            rt_diff = 0.10 - (1.0 - eval_cdf(k90))

            nP = len(sp_sort)
            mp = sum(sp_sort) / nP
            sdp = math.sqrt(sum((s - mp) ** 2 for s in sp_sort) / (nP - 1))
            iqrp = empirical_quantile_lin(sp_sort, 0.75) - empirical_quantile_lin(sp_sort, 0.25)
            bw = max(dK, 0.9 * min(sdp, iqrp / 1.34) * (nP ** (-0.2)))
            raw_p = [(sum(norm_pdf((kn - s) / bw) for s in sp_sort) / (nP * bw)) * dK for kn in int_k]
            ps = sum(raw_p)
            p_p = [v / ps for v in raw_p]
            kl = sum(p * math.log(p / q) for p, q in zip(p_p, q_p) if p > 1e-12 and q > 1e-12)
            return {
                "svi": svi,
                "minButterflyG": min_g,
                "impliedMean": imp_mean,
                "impliedVolPct": imp_vol,
                "impliedSkewness": skew,
                "impliedExcessKurtosis": ekurt,
                "leftTail10PctProbDiff": lt_diff,
                "rightTail10PctProbDiff": rt_diff,
                "klDivergencePvsQ": kl,
            }

        t_exp = dte / DAYS_PER_YEAR
        t_settle = (dte + 3) / DAYS_PER_YEAR
        fwd_byma = spot_ars * math.exp(0.31 * t_settle)
        fwd_opra = spot_usd * math.exp(0.043 * t_exp)
        expected_p_ars = sum(spots_a) / len(spots_a)
        expected_p_usd = sum(spots_u) / len(spots_u)
        rn_byma = build_q(fwd_byma, t_exp, 0.31, t_settle, byma_nodes, spots_a, expected_p_ars)
        rn_opra = build_q(fwd_opra, t_exp, 0.043, t_exp, opra_nodes, spots_u, expected_p_usd)

        thr = 0.06
        if rn_byma["leftTail10PctProbDiff"] < -thr:
            sig = "SELL_LEFT_TAIL_BYMA"
        elif rn_byma["rightTail10PctProbDiff"] > thr:
            sig = "BUY_RIGHT_TAIL_BYMA"
        elif abs(rn_opra["leftTail10PctProbDiff"]) > thr or abs(rn_opra["rightTail10PctProbDiff"]) > thr:
            sig = "OPRA_TAIL_RICH"
        else:
            sig = "ALIGNED"

        return {
            "physicalMetricsUsd": {
                "expectedReturnPct": exp_ret_pct,
                "volatilityPct": vol_u_pct,
                "cvar95UsdPct": cvar95_pct,
                "studentTCopulaDof": dof_hat,
                "studentTCopulaRho": rho_hat,
            },
            "riskNeutralBymaArs": rn_byma,
            "riskNeutralOpraUsd": rn_opra,
            "tailDislocationSignal": sig,
            "simulatedNodes": nodes_out,
        }

    # Smile realista BYMA (incluyendo skew normal) y smile OPRA
    byma_nodes_aligned = [
        {"strike": 4200.0, "ivDecimal": 0.61},
        {"strike": 4600.0, "ivDecimal": 0.58},
        {"strike": 5000.0, "ivDecimal": 0.555},
        {"strike": 5370.0, "ivDecimal": 0.54},
        {"strike": 5800.0, "ivDecimal": 0.53},
        {"strike": 6200.0, "ivDecimal": 0.525},
        {"strike": 6700.0, "ivDecimal": 0.525},
    ]
    opra_nodes_std = [
        {"strike": 36.0, "ivDecimal": 0.50},
        {"strike": 40.0, "ivDecimal": 0.46},
        {"strike": 44.5, "ivDecimal": 0.43},
        {"strike": 48.0, "ivDecimal": 0.415},
        {"strike": 52.0, "ivDecimal": 0.405},
    ]
    # Smile BYMA con ala izquierda extremadamente inflada -> SELL_LEFT_TAIL_BYMA
    byma_nodes_left_panic = [
        {"strike": 3800.0, "ivDecimal": 0.96},
        {"strike": 4400.0, "ivDecimal": 0.78},
        {"strike": 5000.0, "ivDecimal": 0.62},
        {"strike": 5400.0, "ivDecimal": 0.56},
        {"strike": 6000.0, "ivDecimal": 0.53},
        {"strike": 6500.0, "ivDecimal": 0.52},
    ]

    res_aligned = eval_dual(byma_nodes_aligned, opra_nodes_std)
    res_left_panic = eval_dual(byma_nodes_left_panic, opra_nodes_std)

    return {
        "specialFunctions": special_vals,
        "baseConfig": {
            "asOfUtcSec": as_of,
            "expiryDate": "2026-12-18",
            "dteCalendar": dte,
            "spotByma24hArs": spot_ars,
            "spotAdrUsd": spot_usd,
            "expectedCerGrowthOverHorizon": cer_g,
            "historicalSeries": hist_series,
            "copulaSampleCount": 128,
            "gridSize": 45,
            "bymaForward": spot_ars * math.exp(0.31 * ((dte + 3) / DAYS_PER_YEAR)),
            "opraForward": spot_usd * math.exp(0.043 * (dte / DAYS_PER_YEAR)),
            "timeToExpiryYears": dte / DAYS_PER_YEAR,
            "timeToSettleYearsByma": (dte + 3) / DAYS_PER_YEAR,
            "bymaRiskFree": 0.31,
            "opraRiskFree": 0.043,
        },
        "bymaNodesAligned": byma_nodes_aligned,
        "opraNodesStd": opra_nodes_std,
        "alignedResult": res_aligned,
        "bymaNodesLeftPanic": byma_nodes_left_panic,
        "leftPanicResult": res_left_panic,
    }


# ==============================================================================
# MOTOR 4 — ESTRUCTURA ANEXO B, SIGNED GEX/VANNA/CHARM & PINNING 15:30 ART
# ==============================================================================

def run_motor4_scenarios() -> dict[str, Any]:
    ar_hols = {"2026-12-08"}
    expiry_key = "2026-12-18"
    # Dia de vencimiento a las 13:30 ART = 16:30 UTC (120 min antes de 15:30 ART)
    as_of_exp = utc_sec_from_iso("2026-12-18T16:30:00Z")
    anexo_b_date = "2026-12-17" # 1 día hábil de lag

    rate_curve = [{"days": 1.0, "continuousRateAnnual": 0.31}, {"days": 30.0, "continuousRateAnnual": 0.32}]
    spot_ars = 5980.0
    delta1 = settlement_calendar_days("2026-12-18", 1, ar_hols) # 3
    delta_ex = delta1
    ep = byma_eval_params(as_of_exp, spot_ars, expiry_key, delta1, delta_ex, rate_curve)

    strikes_data = [
        {
            "strikeArs": 5600.0,
            "callOi": {"coveredNom": 100_000, "uncoveredNom": 20_000, "oppositeNom": 30_000, "crossedNom": 10_000},
            "putOi": {"coveredNom": 50_000, "uncoveredNom": 220_000, "oppositeNom": 40_000, "crossedNom": 50_000},
            "callIvDecimal": 0.62,
            "putIvDecimal": 0.64,
        },
        {
            "strikeArs": 6000.0,
            "callOi": {"coveredNom": 900_000, "uncoveredNom": 1_200_000, "oppositeNom": 150_000, "crossedNom": 500_000},
            "putOi": {"coveredNom": 50_000, "uncoveredNom": 80_000, "oppositeNom": 20_000, "crossedNom": 10_000},
            "callIvDecimal": 0.54,
            "putIvDecimal": 0.56,
        },
        {
            "strikeArs": 6400.0,
            "callOi": {"coveredNom": 1_500_000, "uncoveredNom": 180_000, "oppositeNom": 40_000, "crossedNom": 20_000},
            "putOi": {"coveredNom": 10_000, "uncoveredNom": 20_000, "oppositeNom": 10_000, "crossedNom": 5_000},
            "callIvDecimal": 0.52,
            "putIvDecimal": 0.54,
        },
    ]

    # Flujo BYMA snapshots 20s + cinta ADR Lee-Ready
    byma_snaps = [
        {"time": as_of_exp - 60, "bid": 5975.0, "ask": 5985.0, "last": 5980.0, "cumVolumeShares": 10_000},
        {"time": as_of_exp - 40, "bid": 5978.0, "ask": 5988.0, "last": 5988.0, "cumVolumeShares": 14_500}, # 4500 > prevMid(5980) -> BUY +
        {"time": as_of_exp - 20, "bid": 5982.0, "ask": 5990.0, "last": 5979.0, "cumVolumeShares": 16_000}, # 1500 < prevMid(5983) -> SELL -
    ]
    byma_net_ars = 4_500 * 5988.0 - 1_500 * 5979.0

    adr_quotes = [
        {"timestamp": as_of_exp - 50, "bid": 49.90, "ask": 49.98, "bidSize": 500, "askSize": 400},
        {"timestamp": as_of_exp - 25, "bid": 49.95, "ask": 50.03, "bidSize": 300, "askSize": 600},
    ]
    adr_trades = [
        {"timestamp": as_of_exp - 40, "price": 49.99, "size": 1000, "exchange": 11}, # > mid(49.94) -> +
        {"timestamp": as_of_exp - 15, "price": 49.92, "size": 400, "exchange": 4, "trfTimestamp": as_of_exp - 15}, # < mid(49.99) -> -
    ]
    adr_net_usd = 1000 * 49.99 - 400 * 49.92

    weights = {"wUncovered": 1.0, "wCrossed": 0.75, "wOpposite": 0.35, "wCovered": 0.025}
    atm_iv = 0.54
    eta_charm = 0.25

    def eval_pinning(as_of: int, eval_p: dict[str, Any], rows: list[dict[str, Any]]) -> dict[str, Any]:
        art = get_tz_parts(as_of, AR_TZ)
        is_exp = art["dateKey"] == expiry_key
        min_to_cutoff = (eval_p["expiry1530UtcSec"] - as_of) / 60.0 if is_exp else None
        tau_pin = max(1.0 / (365.0 * 1440.0), (min_to_cutoff / (365.0 * 1440.0)) if min_to_cutoff is not None else eval_p["tExpYears"])
        s0 = eval_p["spot24hArs"]
        s2 = s0 * s0

        prof = []
        tot_gex = 0.0
        tot_vanna = 0.0
        tot_charm = 0.0
        call_wall = math.nan
        best_cw = -1.0
        put_wall = math.nan
        best_pw = -1.0
        tot_uc = 0.0
        max_uc = 0.0
        for row in rows:
            c_eff = (weights["wUncovered"] * row["callOi"]["uncoveredNom"]
                     + weights["wCrossed"] * row["callOi"]["crossedNom"]
                     + weights["wOpposite"] * row["callOi"]["oppositeNom"]
                     + weights["wCovered"] * row["callOi"]["coveredNom"])
            p_eff = (weights["wUncovered"] * row["putOi"]["uncoveredNom"]
                     + weights["wCrossed"] * row["putOi"]["crossedNom"]
                     + weights["wOpposite"] * row["putOi"]["oppositeNom"]
                     + weights["wCovered"] * row["putOi"]["coveredNom"])
            gc = greeks_byma_bs02(eval_p, row["strikeArs"], row["callIvDecimal"], "call")
            gp = greeks_byma_bs02(eval_p, row["strikeArs"], row["putIvDecimal"], "put")
            cw_m = c_eff * gc["gamma"] * s2 * 0.01
            pw_m = p_eff * gp["gamma"] * s2 * 0.01
            if cw_m > best_cw:
                best_cw = cw_m
                call_wall = row["strikeArs"]
            if pw_m > best_pw:
                best_pw = pw_m
                put_wall = row["strikeArs"]
            cs_gex = 1.0 * cw_m
            ps_gex = -1.0 * pw_m
            eff_gex = cs_gex + ps_gex
            vanna = 1.0 * c_eff * gc["vanna"] * s0 * 0.01 - 1.0 * p_eff * gp["vanna"] * s0 * 0.01
            charm = (1.0 * c_eff * gc["charm"] - 1.0 * p_eff * gp["charm"]) * (s0 / 365.0)
            tot_gex += eff_gex
            tot_vanna += vanna
            tot_charm += charm
            uc = row["callOi"]["uncoveredNom"] + row["callOi"]["crossedNom"] + row["putOi"]["uncoveredNom"] + row["putOi"]["crossedNom"]
            tot_uc += uc
            max_uc = max(max_uc, uc)
            dist = s0 - row["strikeArs"]
            gauss = math.exp(-(dist * dist) / (2.0 * atm_iv * atm_iv * tau_pin * s2))
            attr = abs(eff_gex) * gauss + eta_charm * abs(charm)
            prof.append({"strikeArs": row["strikeArs"], "cEff": c_eff, "pEff": p_eff, "effGex": eff_gex, "attr": attr, "cIv": row["callIvDecimal"], "pIv": row["putIvDecimal"]})

        tot_attr = sum(p["attr"] for p in prof)
        for p in prof:
            p["pinScore"] = p["attr"] / tot_attr
        peak_row = max(prof, key=lambda p: p["pinScore"])

        def net_gex_at(s_cand: float) -> float:
            s_adj = s_cand * math.exp(-eval_p["r1Continuous"] * eval_p["t1Years"]) - eval_p["pvDividendsArs"]
            sh_ep = {**eval_p, "spot24hArs": s_cand, "adjustedSpotArs": s_adj, "forwardArs": s_adj * math.exp(eval_p["rEff"] * eval_p["tExpYears"])}
            res = 0.0
            for r in prof:
                if r["cEff"] > 0:
                    res += r["cEff"] * greeks_byma_bs02(sh_ep, r["strikeArs"], r["cIv"], "call")["gamma"] * s_cand * s_cand * 0.01
                if r["pEff"] > 0:
                    res -= r["pEff"] * greeks_byma_bs02(sh_ep, r["strikeArs"], r["pIv"], "put")["gamma"] * s_cand * s_cand * 0.01
            return res

        min_k = min(r["strikeArs"] for r in prof)
        max_k = max(r["strikeArs"] for r in prof)
        glo = max((eval_p["pvDividendsArs"] + 1e-3) * math.exp(eval_p["r1Continuous"] * eval_p["t1Years"]), min(s0, min_k) * 0.55)
        ghi = max(s0, max_k) * 1.45
        pts_set = {s0}
        for i in range(37):
            pts_set.add(glo + (i / 36.0) * (ghi - glo))
        for r in prof:
            if glo < r["strikeArs"] < ghi:
                pts_set.add(r["strikeArs"])
        probes = sorted(pts_set)
        zg = math.nan
        best_dist = math.inf
        pv = net_gex_at(probes[0])
        for i in range(1, len(probes)):
            cv = net_gex_at(probes[i])
            if (pv <= 0 <= cv) or (pv >= 0 >= cv):
                rt = brent_root(net_gex_at, probes[i - 1], probes[i], 1e-6, 80)
                if not math.isnan(rt) and abs(rt - s0) < best_dist:
                    best_dist = abs(rt - s0)
                    zg = rt
            pv = cv

        if is_exp and min_to_cutoff is not None and 0.0 <= min_to_cutoff <= 240.0 and peak_row["pinScore"] >= 0.35 and tot_gex > 0:
            reg = "PIN_LOCKED"
        elif tot_gex >= 0:
            reg = "POSITIVE_GAMMA_MEAN_REVERTING"
        else:
            reg = "NEGATIVE_GAMMA_TRENDING"

        return {
            "anexoBLagTradingDays": trading_days_between(anexo_b_date, art["dateKey"], ar_hols),
            "isExpiryDay": is_exp,
            "minutesTo1530Cutoff": min_to_cutoff,
            "regime": reg,
            "zeroGammaLevelArs": zg,
            "callWallArs": call_wall,
            "putWallArs": put_wall,
            "peakPinStrikeArs": peak_row["strikeArs"],
            "maxPinScore": peak_row["pinScore"],
            "maxUncoveredCrossedConcentrationPct": (max_uc / tot_uc) * 100.0,
            "netEffectiveGexArsPer1Pct": tot_gex,
            "netVannaArsPerVolPt": tot_vanna,
            "netCharmArsPerDay": tot_charm,
            "bymaNetSignedArs": byma_net_ars,
            "adrNetSignedUsd": adr_net_usd,
            "strikeProfile": prof,
        }

    pin_locked = eval_pinning(as_of_exp, ep, strikes_data)

    # Escenario fuera de vencimiento dominado por Puts descubiertos (NEGATIVE_GAMMA_TRENDING)
    as_of_nonexp = utc_sec_from_iso("2026-12-04T16:30:00Z")
    d1_nonexp = settlement_calendar_days("2026-12-04", 1, ar_hols) # vie -> lun = 3
    ep_nonexp = byma_eval_params(as_of_nonexp, 5620.0, expiry_key, d1_nonexp, delta_ex, rate_curve)
    strikes_neg = [
        {
            "strikeArs": 5600.0,
            "callOi": {"coveredNom": 100_000, "uncoveredNom": 20_000, "oppositeNom": 10_000, "crossedNom": 5_000},
            "putOi": {"coveredNom": 10_000, "uncoveredNom": 2_500_000, "oppositeNom": 100_000, "crossedNom": 400_000},
            "callIvDecimal": 0.56,
            "putIvDecimal": 0.62,
        },
        {
            "strikeArs": 6000.0,
            "callOi": {"coveredNom": 400_000, "uncoveredNom": 40_000, "oppositeNom": 20_000, "crossedNom": 10_000},
            "putOi": {"coveredNom": 20_000, "uncoveredNom": 120_000, "oppositeNom": 10_000, "crossedNom": 10_000},
            "callIvDecimal": 0.54,
            "putIvDecimal": 0.58,
        },
    ]
    neg_gamma = eval_pinning(as_of_nonexp, ep_nonexp, strikes_neg)

    return {
        "inputPinLocked": {
            "asOfUtcSec": as_of_exp,
            "anexoBAsOfDate": anexo_b_date,
            "bymaEval": {
                "asOfUtcSec": as_of_exp,
                "spot24hArs": spot_ars,
                "expiryDateKey": expiry_key,
                "deltaAr1Days": delta1,
                "deltaExDays": delta_ex,
                "arHolidays": sorted(ar_hols),
                "rateCurve": rate_curve,
            },
            "atmIvDecimal": atm_iv,
            "strikes": strikes_data,
            "arHolidays": sorted(ar_hols),
            "adrTrades": adr_trades,
            "adrQuotes": adr_quotes,
            "bymaSnapshots": byma_snaps,
        },
        "pinLocked": pin_locked,
        "inputNegGamma": {
            "asOfUtcSec": as_of_nonexp,
            "anexoBAsOfDate": "2026-12-03",
            "bymaEval": {
                "asOfUtcSec": as_of_nonexp,
                "spot24hArs": 5620.0,
                "expiryDateKey": expiry_key,
                "deltaAr1Days": d1_nonexp,
                "deltaExDays": delta_ex,
                "arHolidays": sorted(ar_hols),
                "rateCurve": rate_curve,
            },
            "atmIvDecimal": 0.58,
            "strikes": strikes_neg,
            "arHolidays": sorted(ar_hols),
        },
        "negGamma": neg_gamma,
    }


# ==============================================================================
# MOTOR 5 — SELECTOR ESPECIALIZADO DE ESTRATEGIAS GGAL (ARS & USD)
# ==============================================================================

def run_motor5_scenarios() -> dict[str, Any]:
    as_of = utc_sec_from_iso("2026-11-12T16:00:00Z") # Jue 12 nov 2026 13:00 ART (Q4-2026 FINRA TAF=0)
    front_key = "2026-12-18"
    back_key = "2027-02-19"
    front_exp_sec = exp_1530_art_utc(front_key)
    back_exp_sec = exp_1530_art_utc(back_key)
    ar_hols = {"2026-11-23"}
    delta1 = settlement_calendar_days("2026-11-12", 1, ar_hols) # 1
    delta_ex = settlement_calendar_days(front_key, 1, ar_hols) # 3
    delta_ex_back = settlement_calendar_days(back_key, 1, ar_hols) # 3

    spot_ars = 5200.0
    spot_24h_q = {"bid": 5196.0, "ask": 5204.0}
    spot_usd = 44.50
    spot_adr_q = {"bid": 44.46, "ask": 44.54}
    caucion_tna_pct = 32.0
    lecap_tna_pct = 34.5
    sofr_pct = 4.30
    rate_curve = [
        {"days": 1.0, "continuousRateAnnual": 0.30},
        {"days": 40.0, "continuousRateAnnual": 0.31},
        {"days": 100.0, "continuousRateAnnual": 0.325},
    ]
    dividends = [
        {"exDivUtcSec": utc_sec_from_iso("2026-11-26T14:00:00Z"), "payDateUtcSec": utc_sec_from_iso("2026-11-30T14:00:00Z"), "amountArs": 65.0},
    ]

    # Distribución física P bimodal/sesgada al alza pero cubriendo colas para evaluar todas las familias
    # Generamos 36 nodos equiprobables deterministas (con retorno físico moderadamente positivo + skew)
    phys_nodes = []
    for i in range(36):
        z = -1.6 + (3.2 * i) / 35.0
        # ADR esperado ligeramente al alza (+4.5 % medio) y CCL +3.5 %
        s_u = spot_usd * math.exp(0.045 + 0.14 * z)
        s_a = spot_ars * math.exp(0.080 + 0.17 * z)
        phys_nodes.append({"spotUsd": s_u, "spotArs": s_a, "probability": 1.0 / 36.0})

    # Cadena BYMA frontal (calls y puts líquidos + 1 strike ilíquido < 100k nominales) + trasera 2027-02-19
    byma_chain = [
        {"ticker": "GFGC5000DI", "contractType": "call", "strikeArs": 5000.0, "expiryDateKey": front_key, "bidArs": 620.0, "askArs": 640.0, "openInterestNom": 350_000, "ivDecimal": 0.54},
        {"ticker": "GFGC5400DI", "contractType": "call", "strikeArs": 5400.0, "expiryDateKey": front_key, "bidArs": 395.0, "askArs": 410.0, "openInterestNom": 600_000, "ivDecimal": 0.51},
        {"ticker": "GFGC5800DI", "contractType": "call", "strikeArs": 5800.0, "expiryDateKey": front_key, "bidArs": 215.0, "askArs": 225.0, "openInterestNom": 800_000, "ivDecimal": 0.48},
        {"ticker": "GFGC6200DI", "contractType": "call", "strikeArs": 6200.0, "expiryDateKey": front_key, "bidArs": 88.0, "askArs": 96.0, "openInterestNom": 420_000, "ivDecimal": 0.45},
        # Strike ilíquido (solo 500 lotes = 50,000 nominals < 100,000) -> debe ser filtrado siempre
        {"ticker": "GFGC6600DI", "contractType": "call", "strikeArs": 6600.0, "expiryDateKey": front_key, "bidArs": 40.0, "askArs": 48.0, "openInterestNom": 50_000, "ivDecimal": 0.44},
        {"ticker": "GFGV5000DI", "contractType": "put", "strikeArs": 5000.0, "expiryDateKey": front_key, "bidArs": 108.0, "askArs": 116.0, "openInterestNom": 280_000, "ivDecimal": 0.59},
        {"ticker": "GFGV5400DI", "contractType": "put", "strikeArs": 5400.0, "expiryDateKey": front_key, "bidArs": 255.0, "askArs": 270.0, "openInterestNom": 220_000, "ivDecimal": 0.57},
        {"ticker": "GFGV5800DI", "contractType": "put", "strikeArs": 5800.0, "expiryDateKey": front_key, "bidArs": 525.0, "askArs": 550.0, "openInterestNom": 180_000, "ivDecimal": 0.55},
        # Pata trasera Calendar (2027-02-19) con IV > frontal para varianza forward positiva
        {"ticker": "GFGC5800FE", "contractType": "call", "strikeArs": 5800.0, "expiryDateKey": back_key, "bidArs": 495.0, "askArs": 520.0, "openInterestNom": 300_000, "ivDecimal": 0.52},
    ]

    opra_chain = [
        {"ticker": "GGAL261218C42.5", "contractType": "call", "strikeUsd": 42.5, "expiryDateKey": front_key, "expiryUtcSec": front_exp_sec, "bidUsd": 4.20, "askUsd": 4.40, "openInterestContracts": 400, "ivDecimal": 0.47},
        {"ticker": "GGAL261218C45", "contractType": "call", "strikeUsd": 45.0, "expiryDateKey": front_key, "expiryUtcSec": front_exp_sec, "bidUsd": 2.65, "askUsd": 2.85, "openInterestContracts": 900, "ivDecimal": 0.45},
        {"ticker": "GGAL261218C47.5", "contractType": "call", "strikeUsd": 47.5, "expiryDateKey": front_key, "expiryUtcSec": front_exp_sec, "bidUsd": 1.45, "askUsd": 1.60, "openInterestContracts": 700, "ivDecimal": 0.43},
        {"ticker": "GGAL261218C50", "contractType": "call", "strikeUsd": 50.0, "expiryDateKey": front_key, "expiryUtcSec": front_exp_sec, "bidUsd": 0.72, "askUsd": 0.85, "openInterestContracts": 500, "ivDecimal": 0.41},
        {"ticker": "GGAL261218P42.5", "contractType": "put", "strikeUsd": 42.5, "expiryDateKey": front_key, "expiryUtcSec": front_exp_sec, "bidUsd": 1.40, "askUsd": 1.55, "openInterestContracts": 350, "ivDecimal": 0.48},
        {"ticker": "GGAL261218P45", "contractType": "put", "strikeUsd": 45.0, "expiryDateKey": front_key, "expiryUtcSec": front_exp_sec, "bidUsd": 2.40, "askUsd": 2.60, "openInterestContracts": 450, "ivDecimal": 0.46},
        {"ticker": "GGAL261218P47.5", "contractType": "put", "strikeUsd": 47.5, "expiryDateKey": front_key, "expiryUtcSec": front_exp_sec, "bidUsd": 4.00, "askUsd": 4.25, "openInterestContracts": 250, "ivDecimal": 0.44},
        {"ticker": "GGAL270219C47.5", "contractType": "call", "strikeUsd": 47.5, "expiryDateKey": back_key, "expiryUtcSec": back_exp_sec, "bidUsd": 3.40, "askUsd": 3.65, "openInterestContracts": 200, "ivDecimal": 0.47},
    ]

    dte_front_exp = (front_exp_sec - as_of) / SECONDS_PER_DAY
    dte_front_settle = dte_front_exp + delta_ex
    t1_exp = (front_exp_sec - as_of) / SECONDS_PER_YEAR_365
    ep_front = byma_eval_params(as_of, spot_ars, front_key, delta1, delta_ex, rate_curve, dividends)

    # Estimación ATM IV BYMA para z matching
    atm_byma = 0.51 # GFGC5400DI es el strike más cercano a fwd_BYMA ~ 5318
    atm_z_scale_byma = atm_byma * math.sqrt(t1_exp)

    r_sofr = sofr_pct / 100.0
    fwd_opra = spot_usd * math.exp(r_sofr * t1_exp)
    atm_opra = 0.45
    atm_z_scale_opra = atm_opra * math.sqrt(t1_exp)

    def margin_uncov(s_spot: float, k_strk: float, ct: str, q_uncov: int) -> float:
        if q_uncov <= 0:
            return 0.0
        otm = max(0.0, k_strk - s_spot) if ct == "call" else max(0.0, s_spot - k_strk)
        return max(0.20 * s_spot - otm, 0.10 * k_strk) * LOT_SIZE * q_uncov

    def term_byma_leg(s_node: float, k_strk: float, ct: str, side: str, qty: int) -> tuple[float, float]:
        intr = max(0.0, s_node - k_strk) if ct == "call" else max(0.0, k_strk - s_node)
        if intr <= 0.0:
            return 0.0, 0.0
        ex_rate = byma_fee_rate(qty * k_strk * LOT_SIZE, "EXERCISE")
        fee_ps = ex_rate * k_strk
        if side == "BUY":
            net_ps = intr - fee_ps
            return (0.0, 0.0) if net_ps <= 0 else (qty * LOT_SIZE * net_ps, qty * LOT_SIZE * fee_ps)
        return -qty * LOT_SIZE * (intr + fee_ps), qty * LOT_SIZE * fee_ps

    def eval_opra_match(family: str, byma_legs: list[tuple[dict[str, Any], str, int]], byma_ev: float, byma_cap: float) -> tuple[float | None, float | None]:
        opra_front = [o for o in opra_chain if o["expiryUtcSec"] == front_exp_sec]
        matched_legs = []
        for q, side, qty in byma_legs:
            zb = math.log(q["strikeArs"] / ep_front["forwardArs"]) / atm_z_scale_byma
            pool = [o for o in opra_chain if o["expiryUtcSec"] > front_exp_sec] if (family == "CALENDAR_ROLL_2M" and side == "BUY") else opra_front
            cands = [o for o in pool if o["contractType"] == q["contractType"]]
            best_o = min(cands, key=lambda o: abs(math.log(o["strikeUsd"] / fwd_opra) / atm_z_scale_opra - zb))
            matched_legs.append((best_o, side, qty))

        if family in ("BULL_CALL_SPREAD", "BEAR_PUT_SPREAD", "RATIO_1X2", "RATIO_1X3") and matched_legs[0][0]["strikeUsd"] == matched_legs[1][0]["strikeUsd"]:
            return None, None

        cf0_usd = 0.0
        for mo, side, qty in matched_legs:
            px = mo["askUsd"] if side == "BUY" else mo["bidUsd"]
            fr = us_option_fee_rate(as_of, px, side)
            not_u = qty * LOT_SIZE * px
            cf0_usd += -(not_u * (1.0 + fr)) if side == "BUY" else (not_u * (1.0 - fr))

        carry_u = 1.0 + r_sofr * (dte_front_exp / DAYS_PER_YEAR)
        pnls_u = []
        extra_m_u = 0.0
        bw_desemb_u = 0.0
        if family == "BUY_WRITE_T0":
            c_leg = matched_legs[0][0]
            eq_buy_r = us_equity_fee_rate(as_of, spot_adr_q["ask"], "BUY")
            opt_sell_r = us_option_fee_rate(as_of, c_leg["bidUsd"], "SELL")
            bw_desemb_u = LOT_SIZE * (spot_adr_q["ask"] * (1.0 + eq_buy_r) - c_leg["bidUsd"] * (1.0 - opt_sell_r))
            for n in phys_nodes:
                if n["spotUsd"] > c_leg["strikeUsd"]:
                    eq_sr = us_equity_fee_rate(as_of, c_leg["strikeUsd"], "SELL")
                    t_sh = c_leg["strikeUsd"] * (1.0 - eq_sr)
                else:
                    t_sh = n["spotUsd"]
                pnls_u.append(LOT_SIZE * t_sh - bw_desemb_u * carry_u)
            cap_u = bw_desemb_u
        else:
            sq = sum(qty for _, sd, qty in matched_legs if sd == "SELL")
            lq = sum(qty for _, sd, qty in matched_legs if sd == "BUY")
            unc = max(0, sq - lq)
            if unc > 0:
                sh_l = next(mo for mo, sd, _ in matched_legs if sd == "SELL")
                extra_m_u = margin_uncov(spot_usd, sh_l["strikeUsd"], sh_l["contractType"], unc)
            for n in phys_nodes:
                tp = 0.0
                for mo, side, qty in matched_legs:
                    intr = max(0.0, n["spotUsd"] - mo["strikeUsd"]) if mo["contractType"] == "call" else max(0.0, mo["strikeUsd"] - n["spotUsd"])
                    if intr > 0.0:
                        is_deliv = (mo["contractType"] == "call" and side == "SELL") or (mo["contractType"] == "put" and side == "BUY")
                        sr = us_equity_fee_rate(as_of, mo["strikeUsd"], "SELL") if is_deliv else 0.0
                        fp = sr * mo["strikeUsd"]
                        if side == "BUY":
                            tp += max(0.0, intr - fp) * qty * LOT_SIZE
                        else:
                            tp -= (intr + fp) * qty * LOT_SIZE
                pnls_u.append(tp + cf0_usd * carry_u - r_sofr * extra_m_u * (dte_front_exp / DAYS_PER_YEAR))
            cap_u = max(extra_m_u + max(0.0, -cf0_usd), float(LOT_SIZE))

        ev_u = sum(n["probability"] * p for n, p in zip(phys_nodes, pnls_u))
        var_u = sum(n["probability"] * (p - ev_u) ** 2 for n, p in zip(phys_nodes, pnls_u))
        sh_u = ev_u / math.sqrt(var_u)

        ccl0 = spot_ars / (spot_usd * ADR_RATIO)
        exp_ccl_t1 = sum(n["probability"] * (n["spotArs"] / (n["spotUsd"] * ADR_RATIO)) for n in phys_nodes)
        ccl_mult = exp_ccl_t1 / ccl0
        byma_ret = byma_ev / byma_cap
        opra_ccl_adj = (1.0 + ev_u / cap_u) * ccl_mult - 1.0
        adv_bps = (byma_ret - opra_ccl_adj) * (DAYS_PER_YEAR / dte_front_exp) * 10_000.0
        return sh_u, adv_bps

    # Evaluamos 1 representante puntual por cada una de las 6 familias para contraste exacto
    r_opp = lecap_tna_pct / 100.0
    cauc_dec = caucion_tna_pct / 100.0
    carry_b = 1.0 + r_opp * (dte_front_exp / DAYS_PER_YEAR)

    # 1. Bull Call Spread: BUY GFGC5000DI (ask 640), SELL GFGC5800DI (bid 215)
    c_5000 = byma_chain[0]
    c_5800 = byma_chain[2]
    bcs_not_l, bcs_not_s = LOT_SIZE * c_5000["askArs"], LOT_SIZE * c_5800["bidArs"]
    bcs_fee_e = bcs_not_l * byma_fee_rate(bcs_not_l, "OPTION_PREMIUM") + bcs_not_s * byma_fee_rate(bcs_not_s, "OPTION_PREMIUM")
    bcs_cf0 = bcs_not_s - bcs_not_l - bcs_fee_e
    bcs_pnls = [term_byma_leg(n["spotArs"], 5000.0, "call", "BUY", 1)[0] + term_byma_leg(n["spotArs"], 5800.0, "call", "SELL", 1)[0] + bcs_cf0 * carry_b for n in phys_nodes]
    bcs_ev = sum(n["probability"] * p for n, p in zip(phys_nodes, bcs_pnls))
    bcs_var = sum(n["probability"] * (p - bcs_ev) ** 2 for n, p in zip(phys_nodes, bcs_pnls))
    bcs_sh = bcs_ev / math.sqrt(bcs_var)
    bcs_cap = max(-bcs_cf0, max(0.0, -bcs_cf0 * carry_b), float(LOT_SIZE))
    bcs_opra_sh, bcs_adv = eval_opra_match("BULL_CALL_SPREAD", [(c_5000, "BUY", 1), (c_5800, "SELL", 1)], bcs_ev, bcs_cap)

    # 2. Bear Put Spread: BUY GFGV5800DI (ask 550), SELL GFGV5000DI (bid 108)
    p_5000 = byma_chain[5]
    p_5800 = byma_chain[7]
    bps_not_l, bps_not_s = LOT_SIZE * p_5800["askArs"], LOT_SIZE * p_5000["bidArs"]
    bps_fee_e = bps_not_l * byma_fee_rate(bps_not_l, "OPTION_PREMIUM") + bps_not_s * byma_fee_rate(bps_not_s, "OPTION_PREMIUM")
    bps_cf0 = bps_not_s - bps_not_l - bps_fee_e
    bps_pnls = [term_byma_leg(n["spotArs"], 5800.0, "put", "BUY", 1)[0] + term_byma_leg(n["spotArs"], 5000.0, "put", "SELL", 1)[0] + bps_cf0 * carry_b for n in phys_nodes]
    bps_ev = sum(n["probability"] * p for n, p in zip(phys_nodes, bps_pnls))
    bps_var = sum(n["probability"] * (p - bps_ev) ** 2 for n, p in zip(phys_nodes, bps_pnls))

    # 3. Buy-Write T+0/24hs con Dividendos: BUY GGAL (ask 5204), SELL GFGC5800DI (bid 215)
    c_eq_bw = byma_fee_rate(LOT_SIZE * spot_24h_q["ask"], "EQUITY")
    c_opt_bw = byma_fee_rate(LOT_SIZE * c_5800["bidArs"], "OPTION_PREMIUM")
    c_ex_bw = byma_fee_rate(LOT_SIZE * 5800.0, "EXERCISE")
    desemb_ps = spot_24h_q["ask"] * (1.0 + c_eq_bw) - c_5800["bidArs"] * (1.0 - c_opt_bw) * (1.0 + cauc_dec * (delta1 / DAYS_PER_YEAR))
    settle_end_sec = front_exp_sec + round((dte_front_settle - dte_front_exp) * SECONDS_PER_DAY)
    reinv_divs = sum(
        d["amountArs"] * (1.0 + cauc_dec * (max(0.0, (settle_end_sec - d["payDateUtcSec"]) / SECONDS_PER_DAY) / DAYS_PER_YEAR))
        for d in dividends if as_of < d["exDivUtcSec"] <= front_exp_sec
    )
    hold_days_bw = dte_front_settle - delta1
    tna_bw_pct = ((5800.0 * (1.0 - c_ex_bw) + reinv_divs) / desemb_ps - 1.0) * (DAYS_PER_YEAR / hold_days_bw) * 100.0
    spread_lecap_bps = (tna_bw_pct - lecap_tna_pct) * 100.0
    desemb_carry_lot = LOT_SIZE * desemb_ps * (1.0 + r_opp * (hold_days_bw / DAYS_PER_YEAR))
    bw_pnls = [
        LOT_SIZE * ((5800.0 * (1.0 - c_ex_bw) if n["spotArs"] > 5800.0 else n["spotArs"]) + reinv_divs) - desemb_carry_lot
        for n in phys_nodes
    ]
    bw_ev = sum(n["probability"] * p for n, p in zip(phys_nodes, bw_pnls))
    bw_var = sum(n["probability"] * (p - bw_ev) ** 2 for n, p in zip(phys_nodes, bw_pnls))
    bw_sh = bw_ev / math.sqrt(bw_var)
    bw_opra_sh, bw_adv = eval_opra_match("BUY_WRITE_T0", [(c_5800, "SELL", 1)], bw_ev, LOT_SIZE * desemb_ps)

    # 4. Calendar Roll 2M: SELL GFGC5800DI (bid 215, T1, iv=0.48), BUY GFGC5800FE (ask 520, T2, iv=0.52)
    c_5800_fe = byma_chain[8]
    t2_exp = (back_exp_sec - as_of) / SECONDS_PER_YEAR_365
    fwd_var = (0.52 ** 2 * t2_exp - 0.48 ** 2 * t1_exp) / (t2_exp - t1_exp)
    sigma_fwd = math.sqrt(fwd_var)
    dte_back_exp = (back_exp_sec - as_of) / SECONDS_PER_DAY
    dte_back_settle = dte_back_exp + delta_ex_back
    rem_settle = dte_back_settle - dte_front_exp
    r_c_back = interp_rate_curve(rate_curve, dte_back_settle)
    r_c_front = interp_rate_curve(rate_curve, dte_front_exp)
    r_c_short = interp_rate_curve(rate_curve, delta1)
    r_fwd_long = (r_c_back * dte_back_settle - r_c_front * dte_front_exp) / rem_settle
    fwd_curve = [{"days": max(1.0, float(delta1)), "continuousRateAnnual": r_c_short}, {"days": max(1.0, rem_settle), "continuousRateAnnual": r_fwd_long}]

    cal_entry_f = LOT_SIZE * 215.0 * byma_fee_rate(LOT_SIZE * 215.0, "OPTION_PREMIUM") + LOT_SIZE * 520.0 * byma_fee_rate(LOT_SIZE * 520.0, "OPTION_PREMIUM")
    cal_cf0 = LOT_SIZE * (215.0 - 520.0) - cal_entry_f
    cal_pnls = []
    for n in phys_nodes:
        rem_ep = byma_eval_params(front_exp_sec, n["spotArs"], back_key, delta1, delta_ex_back, fwd_curve, dividends, caucion_cont=r_c_short)
        b_val = price_byma_bs02(rem_ep, 5800.0, sigma_fwd, "call")
        b_cl_fee = LOT_SIZE * b_val * byma_fee_rate(LOT_SIZE * max(b_val, 1e-6), "OPTION_PREMIUM")
        f_settle = term_byma_leg(n["spotArs"], 5800.0, "call", "SELL", 1)[0]
        cal_pnls.append(LOT_SIZE * b_val - b_cl_fee + f_settle + cal_cf0 * carry_b)
    cal_ev = sum(n["probability"] * p for n, p in zip(phys_nodes, cal_pnls))
    cal_var = sum(n["probability"] * (p - cal_ev) ** 2 for n, p in zip(phys_nodes, cal_pnls))
    cal_sh = cal_ev / math.sqrt(cal_var)

    # 5 & 6. Ratio 1x2 & Ratio 1x3 Call: +1 GFGC5400DI (ask 410), -m GFGC6200DI (bid 88)
    c_5400 = byma_chain[1]
    c_6200 = byma_chain[3]
    ratio_res = {}
    for m_cnt in (2, 3):
        rn_l = LOT_SIZE * c_5400["askArs"]
        rn_s = m_cnt * LOT_SIZE * c_6200["bidArs"]
        rf_e = rn_l * byma_fee_rate(rn_l, "OPTION_PREMIUM") + rn_s * byma_fee_rate(rn_s, "OPTION_PREMIUM")
        r_cf0 = rn_s - rn_l - rf_e
        r_marg = margin_uncov(spot_ars, 6200.0, "call", m_cnt - 1)
        r_pnls = [
            term_byma_leg(n["spotArs"], 5400.0, "call", "BUY", 1)[0]
            + term_byma_leg(n["spotArs"], 6200.0, "call", "SELL", m_cnt)[0]
            + r_cf0 * carry_b
            - r_opp * r_marg * (dte_front_exp / DAYS_PER_YEAR)
            for n in phys_nodes
        ]
        r_ev = sum(n["probability"] * p for n, p in zip(phys_nodes, r_pnls))
        r_var = sum(n["probability"] * (p - r_ev) ** 2 for n, p in zip(phys_nodes, r_pnls))
        ratio_res[f"ratio_1x{m_cnt}"] = {
            "id": f"RATIO_1X{m_cnt}_CALL_GFGC5400DI_GFGC6200DI",
            "marginRequired": r_marg,
            "expectedValueUnderP": r_ev,
            "netSharpeProxy": r_ev / math.sqrt(r_var),
        }

    return {
        "input": {
            "asOfUtcSec": as_of,
            "spotByma24hArs": spot_ars,
            "spotByma24hQuote": spot_24h_q,
            "spotAdrUsd": spot_usd,
            "spotAdrQuote": spot_adr_q,
            "frontExpiryDateKey": front_key,
            "backExpiryDateKey": back_key,
            "deltaAr1Days": delta1,
            "deltaExDays": delta_ex,
            "arHolidays": sorted(ar_hols),
            "caucion1dTnaPct": caucion_tna_pct,
            "lecapMatchedTnaPct": lecap_tna_pct,
            "sofrPct": sofr_pct,
            "rateCurveArs": rate_curve,
            "dividendsArs": dividends,
            "bymaChain": byma_chain,
            "opraChain": opra_chain,
            "physicalNodes": phys_nodes,
        },
        "spotChecks": {
            "bullCall_5000_5800": {
                "id": "BULL_CALL_GFGC5000DI_GFGC5800DI",
                "expectedValueUnderP": bcs_ev,
                "netSharpeProxy": bcs_sh,
                "opraEquivalentSharpe": bcs_opra_sh,
                "bymaAdvantageBps": bcs_adv,
            },
            "bearPut_5800_5000": {
                "id": "BEAR_PUT_GFGV5800DI_GFGV5000DI",
                "expectedValueUnderP": bps_ev,
                "netSharpeProxy": bps_ev / math.sqrt(bps_var),
            },
            "buyWrite_5800": {
                "id": "BUY_WRITE_GGAL_GFGC5800DI",
                "marginRequired": LOT_SIZE * desemb_ps,
                "tnaYieldPct": tna_bw_pct,
                "spreadOverLecapBps": spread_lecap_bps,
                "expectedValueUnderP": bw_ev,
                "netSharpeProxy": bw_sh,
                "opraEquivalentSharpe": bw_opra_sh,
                "bymaAdvantageBps": bw_adv,
            },
            "calendar_5800_di_fe": {
                "id": "CALENDAR_GFGC5800DI_GFGC5800FE",
                "sigmaFwd": sigma_fwd,
                "expectedValueUnderP": cal_ev,
                "netSharpeProxy": cal_sh,
            },
            **ratio_res,
        },
    }


def main() -> None:
    ar_hols = {"2026-11-23"}
    t_q4 = utc_sec_from_iso("2026-11-18T16:00:00Z")
    t_2027 = utc_sec_from_iso("2027-02-10T16:00:00Z")

    fixture = {
        "meta": {
            "description": "Independent Python 3.12 stdlib reference fixture for Pieza 20 (GGAL Specialist)",
            "precisionTarget": "1e-11",
        },
        "feesAndCalendar": {
            "bymaEquityStdRate_1M": byma_fee_rate(1_000_000.0, "EQUITY"),
            "bymaEquityBlockRate_25M": byma_fee_rate(25_000_000.0, "EQUITY", {**DEFAULT_BYMA_FEES, "useEquityBlockTier": True}),
            "bymaOptionPremiumRate": byma_fee_rate(100_000.0, "OPTION_PREMIUM"),
            "bymaExerciseRate": byma_fee_rate(500_000.0, "EXERCISE"),
            "bymaSovereignBondRate_exVat": byma_fee_rate(1_000_000.0, "SOVEREIGN_BOND"),
            "bymaShortLoan30d": byma_short_loan_rate(30.0),
            "bymaShortLoan120d_capped90d": byma_short_loan_rate(120.0),
            "finraTafSuspended_q4_2026": is_finra_taf_suspended(t_q4),
            "finraTafSuspended_2027": is_finra_taf_suspended(t_2027),
            "usEquitySellQ4_2026": us_equity_fee_rate(t_q4, 45.0, "SELL"),
            "usEquitySell2027": us_equity_fee_rate(t_2027, 45.0, "SELL"),
            "usOptionSellQ4_2026": us_option_fee_rate(t_q4, 2.50, "SELL"),
            "usOptionSell2027": us_option_fee_rate(t_2027, 2.50, "SELL"),
            "settleCalDaysFriNov20_withNov23Hol": settlement_calendar_days("2026-11-20", 1, ar_hols), # sab,dom,lun feriado -> mar 24 = 4
            "exp1530ArtDec18": exp_1530_art_utc("2026-12-18"),
        },
        "motor1": run_motor1_scenarios(),
        "motor2": run_motor2_scenarios(),
        "motor3": run_motor3_scenarios(),
        "motor4": run_motor4_scenarios(),
        "motor5": run_motor5_scenarios(),
    }

    out_path = Path(__file__).resolve().parent.parent / "fixtures" / "ggal_specialist_reference.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8", newline="\n") as f:
        json.dump(sanitize_json(fixture), f, indent=2)
        f.write("\n")
    print(f"Generated {out_path} ({out_path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
