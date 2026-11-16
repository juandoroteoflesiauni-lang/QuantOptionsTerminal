#!/usr/bin/env python3
"""
Generador de fixture de referencia INDEPENDIENTE en Python para Motor 6 GGAL Specialist
(Márgenes BYMA Clearing 2026, Microestructura Asíncrona L1–L2 y Riesgo de Cola
Merton Jump-Diffusion / Kelly-CVaR — Pieza 25).

Cumple AGENTS.md:
 - Implementación explícita e independiente usando stdlib (`math`, `statistics`, `datetime`).
 - Nunca importa ni copia código TypeScript.
 - Usa token `"__NaN__"` para NaN en JSON y tolerancia estricta < 1e-11 en Vitest.
"""

from __future__ import annotations

import datetime as dt
import json
import math
from pathlib import Path
from statistics import NormalDist
from typing import Any
from zoneinfo import ZoneInfo

NAN_TOKEN = "__NaN__"
INF_POS_TOKEN = "__Inf__"
INF_NEG_TOKEN = "__-Inf__"

STD_NORM = NormalDist(0.0, 1.0)
AR_TZ = ZoneInfo("America/Argentina/Buenos_Aires")

DAYS_PER_YEAR = 365.0
SECONDS_PER_DAY = 86_400.0
SECONDS_PER_YEAR_365 = DAYS_PER_YEAR * SECONDS_PER_DAY
GGAL_BYMA_LOT_SIZE = 100
GGAL_ADR_RATIO = 10
OPRA_CONTRACT_SHARES = 100

BYMA_OPTION_PREMIUM_DM_RATE_WITH_IVA = 0.00242
BYMA_EXERCISE_DM_RATE_WITH_IVA = 0.000605
BYMA_EQUITY_PPT_DM_RATE_WITH_IVA = 0.000605

DEFAULT_CCP_SPOT_SHOCKS = [-0.25, -0.15, 0.0, 0.15, 0.25]
DEFAULT_CCP_VOL_SHOCKS = [-0.10, 0.0, 0.10]
MIN_CCP_STRESS_VOL = 0.05
DEFAULT_LIQUID_BUFFER_RATE = 0.10
DEFAULT_WWR_SURCHARGE_RATE = 0.15
DEFAULT_CROSS_COLLATERAL_OFFSET_RATIO = 0.10
CIRCULAR_3588_WINDOW_MINUTES = 60.0
CIRCULAR_3588_ATM_BAND_PCT = 0.005

OVERNIGHT_HORIZON_HOURS = 18.0
OVERNIGHT_HORIZON_YEARS = OVERNIGHT_HORIZON_HOURS / (24.0 * DAYS_PER_YEAR)
DEFAULT_HAYASHI_LAG_GRID_SEC = [-15, -10, -5, -2, -1, 0, 1, 2, 5, 10, 15]

# Nodos Gauss-Legendre 10 pts en [0, 1] para integral exacta Drezner-Wesolowski / Genz BVN
GL10_ABSCISSAE_01 = [
    0.01304673574141414,
    0.06746831665550774,
    0.1602952158504878,
    0.2833023029353764,
    0.4255628305091844,
    0.5744371694908156,
    0.7166976970646236,
    0.8397047841495122,
    0.9325316833444923,
    0.9869532642585859,
]
GL10_WEIGHTS_01 = [
    0.03333567215434407,
    0.0747256745752903,
    0.10954318125799103,
    0.13463335965499817,
    0.14776211235737644,
    0.14776211235737644,
    0.13463335965499817,
    0.10954318125799103,
    0.0747256745752903,
    0.03333567215434407,
]


def encode_num(val: float) -> Any:
    if math.isnan(val):
        return NAN_TOKEN
    if math.isinf(val):
        return INF_POS_TOKEN if val > 0 else INF_NEG_TOKEN
    return val


def sanitize_json(obj: Any) -> Any:
    if isinstance(obj, float):
        return encode_num(obj)
    if isinstance(obj, dict):
        return {k: sanitize_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [sanitize_json(v) for v in obj]
    return obj


def utc_sec_from_iso(iso_z: str) -> int:
    return int(dt.datetime.fromisoformat(iso_z.replace("Z", "+00:00")).timestamp())


def get_ba_date_key(utc_sec: int) -> str:
    return dt.datetime.fromtimestamp(utc_sec, tz=dt.timezone.utc).astimezone(AR_TZ).strftime("%Y-%m-%d")


def exp_1530_art_utc(expiry_date_key: str) -> int:
    d = dt.date.fromisoformat(expiry_date_key)
    return int(dt.datetime(d.year, d.month, d.day, 15, 30, 0, tzinfo=AR_TZ).astimezone(dt.timezone.utc).timestamp())


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


def norm_cdf(x: float) -> float:
    return STD_NORM.cdf(x)


def inv_norm_cdf(p: float) -> float:
    return STD_NORM.inv_cdf(p)


def bvn_cdf(a: float, b: float, rho: float) -> float:
    rho = max(-0.999999999999, min(0.999999999999, rho))
    if abs(rho) < 1e-12:
        return norm_cdf(a) * norm_cdf(b)
    h, k = -a, -b
    hk = h * k
    bv = 0.0
    n_sub = 4
    if abs(rho) < 0.925:
        hs = 0.5 * (h * h + k * k)
        asr = math.asin(rho)
        for sub in range(n_sub):
            for xi, wi in zip(GL10_ABSCISSAE_01, GL10_WEIGHTS_01):
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
        for xi, wi in zip(GL10_ABSCISSAE_01, GL10_WEIGHTS_01):
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


def price_bsm_eur(S: float, K: float, T: float, r: float, q: float, v: float, opt_type: str) -> float:
    if T <= 0 or v <= 0:
        return max(0.0, S - K) if opt_type == "call" else max(0.0, K - S)
    srt = v * math.sqrt(T)
    d1 = (math.log(S / K) + (r - q + 0.5 * v * v) * T) / srt
    d2 = d1 - srt
    if opt_type == "call":
        return S * math.exp(-q * T) * norm_cdf(d1) - K * math.exp(-r * T) * norm_cdf(d2)
    return K * math.exp(-r * T) * norm_cdf(-d2) - S * math.exp(-q * T) * norm_cdf(-d1)


def _phi(S: float, T: float, gamma: float, H: float, I: float, r: float, b: float, v: float) -> float:
    v2 = v * v
    srt = v * math.sqrt(T)
    lam = (-r + gamma * b + 0.5 * gamma * (gamma - 1.0) * v2) * T
    kappa = (2.0 * b) / v2 + (2.0 * gamma - 1.0)
    d1 = -(math.log(S / H) + (b + (gamma - 0.5) * v2) * T) / srt
    d2 = -(math.log((I * I) / (S * H)) + (b + (gamma - 0.5) * v2) * T) / srt
    return math.exp(lam) * (S ** gamma) * (norm_cdf(d1) - ((I / S) ** kappa) * norm_cdf(d2))


def _psi(S: float, T: float, gamma: float, H: float, I2: float, I1: float, t1: float, r: float, b: float, v: float) -> float:
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

    def flat_trig(tau: float) -> float:
        h = -(b * tau + 2.0 * v * math.sqrt(tau)) * ((K * K) / max(1e-12, (b_inf - b_zero) * b_zero))
        return b_zero + (b_inf - b_zero) * (1.0 - math.exp(h))

    I2 = flat_trig(T)
    I1 = flat_trig(T - t1)
    if S >= I2:
        return S - K
    alpha2 = (I2 - K) * (I2 ** (-beta))
    alpha1 = (I1 - K) * (I1 ** (-beta))
    val = (
        alpha2 * (S ** beta)
        - alpha2 * _phi(S, t1, beta, I2, I2, r, b, v)
        + _phi(S, t1, 1.0, I2, I2, r, b, v)
        - _phi(S, t1, 1.0, I1, I2, r, b, v)
        - K * _phi(S, t1, 0.0, I2, I2, r, b, v)
        + K * _phi(S, t1, 0.0, I1, I2, r, b, v)
        + alpha1 * _phi(S, t1, beta, I1, I2, r, b, v)
        - alpha1 * _psi(S, T, beta, I1, I2, I1, t1, r, b, v)
        + _psi(S, T, 1.0, I1, I2, I1, t1, r, b, v)
        - _psi(S, T, 1.0, K, I2, I1, t1, r, b, v)
        - K * _psi(S, T, 0.0, I1, I2, I1, t1, r, b, v)
        + K * _psi(S, T, 0.0, K, I2, I1, t1, r, b, v)
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
    rate_curve: list[dict[str, float]],
    dividends: list[dict[str, float]] | None = None,
    caucion_cont: float | None = None,
    holidays: set[str] | None = None,
) -> dict[str, float]:
    hols = holidays or set()
    ba_date_key = get_ba_date_key(as_of_sec)
    delta1_days = settlement_calendar_days(ba_date_key, 1, hols)
    delta_ex_days = settlement_calendar_days(expiry_key, 1, hols)
    exp_sec = exp_1530_art_utc(expiry_key)
    t1 = delta1_days / DAYS_PER_YEAR
    t_exp = (exp_sec - as_of_sec) / SECONDS_PER_YEAR_365
    t_settle = t_exp + delta_ex_days / DAYS_PER_YEAR
    r1 = caucion_cont if caucion_cont is not None else interp_rate_curve(rate_curve, max(1.0, float(delta1_days)))
    r_settle = interp_rate_curve(rate_curve, t_settle * DAYS_PER_YEAR)
    r_eff = r_settle * (t_settle / t_exp)
    pv_div = 0.0
    for div in (dividends or []):
        if as_of_sec < div["exDivUtcSec"] <= exp_sec:
            tau_pay = max(0.0, (div["payDateUtcSec"] - as_of_sec) / SECONDS_PER_YEAR_365)
            r_pay = interp_rate_curve(rate_curve, max(1.0, tau_pay * DAYS_PER_YEAR)) if tau_pay > 0 else 0.0
            pv_div += div["amountArs"] * math.exp(-r_pay * tau_pay)
    s_adj = spot_24h * math.exp(-r1 * t1) - pv_div
    return {
        "asOfUtcSec": float(as_of_sec),
        "expiry1530UtcSec": float(exp_sec),
        "adjustedSpotArs": s_adj,
        "tExpYears": t_exp,
        "rEff": r_eff,
        "r1Continuous": r1,
    }


def price_byma_bs02(ep: dict[str, float], strike: float, sigma: float, opt_type: str) -> float:
    return price_american_bs02(ep["adjustedSpotArs"], strike, ep["tExpYears"], ep["rEff"], 0.0, sigma, opt_type)


def stepped_floor_rate(spot: float, strike: float, opt_type: str) -> float:
    otm = max(0.0, (strike - spot) / spot) if opt_type == "call" else max(0.0, (spot - strike) / spot)
    if otm > 0.05:
        return 0.01
    if otm >= 0.025:
        return 0.025
    return 0.05


def compute_stepped_uncovered_floor(spot: float, legs: list[dict[str, Any]], covered_shares: float = 0.0) -> float:
    rem_cov_lots = max(0.0, covered_shares) / GGAL_BYMA_LOT_SIZE
    total = 0.0
    for ctype in ("call", "put"):
        tlegs = [l for l in legs if l["contractType"] == ctype]
        long_credit = sum(l["lots"] for l in tlegs if l["side"] == "BUY") + (rem_cov_lots if ctype == "call" else 0.0)
        if ctype == "call":
            rem_cov_lots = 0.0
        shorts = sorted(
            [{"lots": l["lots"], "rate": stepped_floor_rate(spot, l["strikeArs"], ctype)} for l in tlegs if l["side"] == "SELL"],
            key=lambda x: x["rate"],
        )
        for item in shorts:
            cov = min(long_credit, item["lots"])
            long_credit -= cov
            uncov = max(0.0, item["lots"] - cov)
            total += uncov * GGAL_BYMA_LOT_SIZE * spot * item["rate"]
    return total


def eval_ccp_grid(
    as_of: int,
    expiry_key: str,
    spot: float,
    rate_curve: list[dict[str, float]],
    dividends: list[dict[str, float]],
    legs: list[dict[str, Any]],
) -> tuple[float, dict[str, Any]]:
    base_ep = byma_eval_params(as_of, spot, expiry_key, rate_curve, dividends)
    base_val = sum(
        (1.0 if l["side"] == "BUY" else -1.0)
        * l["lots"]
        * GGAL_BYMA_LOT_SIZE
        * price_byma_bs02(base_ep, l["strikeArs"], max(MIN_CCP_STRESS_VOL, l["ivDecimal"]), l["contractType"])
        for l in legs
    )
    worst_loss = -math.inf
    worst_node: dict[str, Any] = {}
    for ds in DEFAULT_CCP_SPOT_SHOCKS:
        sh_spot = spot * (1.0 + ds)
        sh_ep = byma_eval_params(as_of, sh_spot, expiry_key, rate_curve, dividends)
        for dv in DEFAULT_CCP_VOL_SHOCKS:
            node_val = sum(
                (1.0 if l["side"] == "BUY" else -1.0)
                * l["lots"]
                * GGAL_BYMA_LOT_SIZE
                * price_byma_bs02(sh_ep, l["strikeArs"], max(MIN_CCP_STRESS_VOL, l["ivDecimal"] + dv), l["contractType"])
                for l in legs
            )
            loss = max(0.0, base_val - node_val)
            if loss > worst_loss:
                worst_loss = loss
                worst_node = {
                    "spotShockPct": ds,
                    "volShockDecimal": dv,
                    "shockedSpotArs": sh_spot,
                    "portfolioMtmLossArs": loss,
                }
    return worst_loss, worst_node


def ref_evaluate_margin(inp: dict[str, Any]) -> dict[str, Any]:
    as_of = inp["asOfUtcSec"]
    spot = inp["spot24hArs"]
    exp_key = inp["expiryDateKey"]
    rc = inp["rateCurveArs"]
    divs = inp.get("dividendsArs", [])
    legs = inp["legs"]
    strat = inp["strategyKind"]
    shares_held = inp.get("underlyingSharesHeld", 0.0)

    def eval_strat(sk: str, cov_shares: float) -> tuple[float, dict[str, Any], float, float]:
        ccp, wnode = eval_ccp_grid(as_of, exp_key, spot, rc, divs, legs)
        fl = compute_stepped_uncovered_floor(spot, legs, cov_shares if sk == "COVERED_CALL" else 0.0)
        if sk == "UNCOVERED_SHORT" or sk in ("RATIO_SPREAD_1X2", "RATIO_SPREAD_1X3"):
            return ccp, wnode, fl, max(ccp, fl)
        if sk == "VERTICAL_DEBIT_SPREAD":
            return ccp, wnode, 0.0, 0.0
        if sk == "VERTICAL_CREDIT_SPREAD":
            shorts = [l for l in legs if l["side"] == "SELL"]
            longs = [l for l in legs if l["side"] == "BUY"]
            cap = abs(shorts[0]["strikeArs"] - longs[0]["strikeArs"]) * GGAL_BYMA_LOT_SIZE * min(shorts[0]["lots"], longs[0]["lots"])
            ccp_c = min(ccp, cap)
            fl_c = min(compute_stepped_uncovered_floor(spot, shorts, 0.0), cap)
            return ccp_c, {**wnode, "portfolioMtmLossArs": ccp_c}, fl_c, max(ccp_c, fl_c)
        if sk == "SHORT_STRADDLE_STRANGLE":
            clegs = [l for l in legs if l["contractType"] == "call"]
            plegs = [l for l in legs if l["contractType"] == "put"]
            cc, _ = eval_ccp_grid(as_of, exp_key, spot, rc, divs, clegs) if clegs else (0.0, {})
            pc, _ = eval_ccp_grid(as_of, exp_key, spot, rc, divs, plegs) if plegs else (0.0, {})
            cf = compute_stepped_uncovered_floor(spot, clegs, 0.0)
            pf = compute_stepped_uncovered_floor(spot, plegs, 0.0)
            mc, mp = max(cc, cf), max(pc, pf)
            c_prem = sum(l["optionPriceArs"] * GGAL_BYMA_LOT_SIZE * l["lots"] for l in clegs if l["side"] == "SELL")
            p_prem = sum(l["optionPriceArs"] * GGAL_BYMA_LOT_SIZE * l["lots"] for l in plegs if l["side"] == "SELL")
            req = mc + p_prem if mc >= mp else mp + c_prem
            return ccp, wnode, fl, req
        if sk == "COVERED_CALL":
            sc_shares = sum(l["lots"] * GGAL_BYMA_LOT_SIZE for l in legs if l["contractType"] == "call" and l["side"] == "SELL")
            if cov_shares >= sc_shares and sc_shares > 0:
                return 0.0, {**wnode, "portfolioMtmLossArs": 0.0}, 0.0, 0.0
            ratio = max(0.0, min(1.0, (sc_shares - max(0.0, cov_shares)) / sc_shares)) if sc_shares > 0 else 1.0
            adj_ccp = ccp * ratio
            return adj_ccp, {**wnode, "portfolioMtmLossArs": adj_ccp}, fl, max(adj_ccp, fl)
        if sk == "CROSS_COLLATERAL_STRATEGY":
            red = ccp * (1.0 - DEFAULT_CROSS_COLLATERAL_OFFSET_RATIO)
            return red, {**wnode, "portfolioMtmLossArs": red}, fl, max(red, fl)
        raise ValueError(sk)

    ccp_loss, wnode, floor_ars, base_req = eval_strat(strat, shares_held)

    def_aforos = {
        "US_TREASURY_BILL": 0.98,
        "US_TREASURY_NOTE": 0.96,
        "US_TREASURY_BOND": 0.94,
        "CASH_ARS": 1.0,
        "CASH_USD": 1.0,
    }
    local_kinds = {"LECAP", "SOVEREIGN_BOND_AR", "EQUITY_LOCAL"}
    tot_mkt = 0.0
    tot_eff = 0.0
    loc_eff = 0.0
    non_eff = 0.0
    missing_aforo = False
    for asset in inp["collateralAssets"]:
        is_loc = asset["kind"] in local_kinds
        if is_loc:
            af = asset.get("explicitAforo")
            if af is None or not (0.0 < af <= 1.0):
                missing_aforo = True
                tot_mkt += asset["marketValueArs"]
                continue
        else:
            af = asset.get("explicitAforo", def_aforos[asset["kind"]])
        eff = asset["marketValueArs"] * af
        tot_mkt += asset["marketValueArs"]
        tot_eff += eff
        if is_loc:
            loc_eff += eff
        else:
            non_eff += eff

    liq_buf = base_req * DEFAULT_LIQUID_BUFFER_RATE
    if missing_aforo:
        wwr = math.nan
        tot_req = math.nan
        excess = math.nan
        tot_eff_out = math.nan
        loc_eff_out = math.nan
        coll_status = "MISSING_EXPLICIT_AFORO"
        status = "NO_DATA"
    else:
        uncov_non = max(0.0, base_req - non_eff)
        loc_backed = min(uncov_non, loc_eff)
        wwr = loc_backed * DEFAULT_WWR_SURCHARGE_RATE
        tot_req = base_req + liq_buf + wwr
        excess = tot_eff - tot_req
        tot_eff_out = tot_eff
        loc_eff_out = loc_eff
        coll_status = "OK"
        status = "OK"

    t0_gross = sum((1.0 if l["side"] == "SELL" else -1.0) * l["optionPriceArs"] * GGAL_BYMA_LOT_SIZE * l["lots"] for l in legs)
    gross_prem_notional = sum(l["optionPriceArs"] * GGAL_BYMA_LOT_SIZE * l["lots"] for l in legs)
    gross_ex_notional = sum(l["strikeArs"] * GGAL_BYMA_LOT_SIZE * l["lots"] for l in legs)
    t0_fees = gross_prem_notional * BYMA_OPTION_PREMIUM_DM_RATE_WITH_IVA
    t0_net = t0_gross - t0_fees
    t1_ex_fee = gross_ex_notional * BYMA_EXERCISE_DM_RATE_WITH_IVA
    ppt_fee = shares_held * spot * BYMA_EQUITY_PPT_DM_RATE_WITH_IVA if shares_held > 0 else 0.0

    ep = byma_eval_params(as_of, spot, exp_key, rc, divs)
    carry = tot_req * (math.exp(ep["r1Continuous"] / DAYS_PER_YEAR) - 1.0) if not math.isnan(tot_req) else math.nan

    ba_date = get_ba_date_key(as_of)
    exp_sec = exp_1530_art_utc(exp_key)
    mins_cut = (exp_sec - as_of) / 60.0
    same_day = ba_date == exp_key
    atm_strikes = []
    atm_dist_min = math.inf
    for l in legs:
        d = abs(spot - l["strikeArs"]) / l["strikeArs"]
        atm_dist_min = min(atm_dist_min, d)
        if d <= CIRCULAR_3588_ATM_BAND_PCT and l["strikeArs"] not in atm_strikes:
            atm_strikes.append(l["strikeArs"])
    c3588_active = same_day and (0.0 <= mins_cut <= CIRCULAR_3588_WINDOW_MINUTES) and len(atm_strikes) > 0

    return {
        "status": status,
        "strategyKind": strat,
        "ccpRiskArrayLossArs": ccp_loss,
        "worstCcpNode": wnode,
        "steppedFloorArs": floor_ars,
        "baseRequiredMarginArs": base_req,
        "liquidBufferArs": liq_buf,
        "wrongWayRiskSurchargeArs": wwr,
        "totalRequiredWithBuffersArs": tot_req,
        "collateralStatus": coll_status,
        "totalCollateralMarketArs": tot_mkt,
        "totalEffectiveCollateralArs": tot_eff_out,
        "localCorrelatedEffectiveArs": loc_eff_out,
        "nonCorrelatedEffectiveArs": non_eff,
        "excessOrDeficitArs": excess,
        "t0GrossPremiumCashflowArs": t0_gross,
        "t0OptionFeesDmIvaArs": t0_fees,
        "t0NetCashflowArs": t0_net,
        "projectedT1ExerciseFeeDmIvaArs": t1_ex_fee,
        "projectedSpotEquityFeeDmIvaArs": ppt_fee,
        "dailyMarginCarryCostArs": carry,
        "circular3588Alert": {
            "active": c3588_active,
            "isExpiryDay": same_day,
            "minutesToCutoff": mins_cut,
            "atmDistancePctMin": atm_dist_min,
            "blockingAtmStrikes": atm_strikes,
        },
    }


def ref_hayashi_yoshida(byma_ticks: list[dict[str, Any]], adr_ticks: list[dict[str, Any]], lags: list[int]) -> dict[str, Any]:
    def build_intervals(ticks: list[dict[str, Any]]) -> list[tuple[int, int, float]]:
        kept = []
        for t in ticks:
            if not kept or (t["midPrice"] != kept[-1]["midPrice"] and t["utcSec"] > kept[-1]["utcSec"]):
                kept.append(t)
        return [(kept[i - 1]["utcSec"], kept[i]["utcSec"], math.log(kept[i]["midPrice"] / kept[i - 1]["midPrice"])) for i in range(1, len(kept))]

    bi = build_intervals(byma_ticks)
    ai = build_intervals(adr_ticks)
    if len(bi) < 2 or len(ai) < 2:
        return {
            "status": "NO_DATA",
            "genuineBymaReturns": len(bi),
            "genuineAdrReturns": len(ai),
            "contemporaneousCorrelation": math.nan,
            "optimalLagSec": math.nan,
            "optimalCorrelation": math.nan,
            "leadLagSignal": "NO_DATA",
            "lagProfile": [],
        }
    denom = math.sqrt(sum(x[2] ** 2 for x in bi) * sum(y[2] ** 2 for y in ai))
    prof = []
    for lag in lags:
        cov = 0.0
        cnt = 0
        for bs, be, br in bi:
            for a_s, a_e, ar in ai:
                if max(bs, a_s + lag) < min(be, a_e + lag):
                    cov += br * ar
                    cnt += 1
        rho = max(-1.0, min(1.0, cov / denom)) if cnt > 0 else 0.0
        prof.append({"lagSec": lag, "correlation": rho, "overlappingPairs": cnt})
    zero = next(p for p in prof if p["lagSec"] == 0)
    best = zero
    for pt in prof:
        diff = abs(pt["correlation"]) - abs(best["correlation"])
        if diff > 1e-12 or (abs(diff) <= 1e-12 and abs(pt["lagSec"]) < abs(best["lagSec"])):
            best = pt
    sig = "ADR_LEADS_BYMA" if best["lagSec"] > 0 else ("BYMA_LEADS_ADR" if best["lagSec"] < 0 else "SYNCHRONOUS")
    return {
        "status": "OK",
        "genuineBymaReturns": len(bi),
        "genuineAdrReturns": len(ai),
        "contemporaneousCorrelation": zero["correlation"],
        "optimalLagSec": best["lagSec"],
        "optimalCorrelation": best["correlation"],
        "leadLagSignal": sig,
        "lagProfile": prof,
    }


def ref_evaluate_microstructure(inp: dict[str, Any]) -> dict[str, Any]:
    hy = ref_hayashi_yoshida(inp["bymaTicks"], inp["adrTicks"], inp.get("leadLagOffsetsSec", DEFAULT_HAYASHI_LAG_GRID_SEC))
    as_of = inp["asOfUtcSec"]
    q_sec = inp["quoteAsOfUtcSec"]
    mode = inp["telemetryMode"]
    max_age = inp.get("maxAgeSec", 30)
    max_spread = inp.get("maxSpreadPct", 0.04)
    min_depth = inp.get("minL1DepthLots", 5)
    horizon = inp.get("orderHorizonSec", 60.0)
    age = as_of - q_sec

    if mode == "EOD_CIERRE":
        g1, g1s = True, "BYPASSED_EOD"
    elif age <= max_age:
        g1, g1s = True, "PASS"
    else:
        g1, g1s = False, "FAIL_STALE"

    bid, ask, last, tick = inp["bidArs"], inp["askArs"], inp["lastTradeArs"], inp["tickSizeArs"]
    mid = 0.5 * (bid + ask)
    spr = ask - bid
    spr_pct = spr / mid
    g2 = (bid > 0 and ask > bid and spr_pct <= max_spread)

    has_l2 = inp["depthSource"] == "PRIMARY_L2" and len(inp["bidsL1L2"]) > 0 and len(inp["asksL1L2"]) > 0
    l1_bid = inp["bidsL1L2"][0]["sizeLots"] if has_l2 else math.nan
    l1_ask = inp["asksL1L2"][0]["sizeLots"] if has_l2 else math.nan
    l1_join = l1_bid if inp["side"] == "BUY" else l1_ask
    l1_cross = l1_ask if inp["side"] == "BUY" else l1_bid
    g3 = has_l2 and l1_join >= min_depth and l1_cross >= min_depth
    g4 = (last > 0 and (bid - spr) <= last <= (ask + spr))
    all_ok = g1 and g2 and g3 and g4

    spr_ticks = round(spr / tick)
    half_spr = 0.5 * spr
    boost = 1.0 + max(0.0, min(1.0, abs(hy["optimalCorrelation"]))) if hy["status"] == "OK" else 1.0
    lam_eff = inp["lambdaBasePerSec"] * boost
    desired = inp["desiredLots"]
    p_l1 = 1.0 - math.exp(-(lam_eff * horizon) / (l1_join + desired)) if has_l2 else math.nan
    p_imp = 1.0 - math.exp(-(lam_eff * horizon) / desired) if spr_ticks >= 2 else math.nan

    adv_sel = 0.4 * mid * inp["optionIvDecimal"] * math.sqrt(horizon / SECONDS_PER_YEAR_365) * boost
    es_l1 = p_l1 * (-half_spr) + (1.0 - p_l1) * (adv_sel + half_spr) if not math.isnan(p_l1) else math.nan
    es_imp = p_imp * (-(half_spr - tick)) + (1.0 - p_imp) * (adv_sel + half_spr) if not math.isnan(p_imp) else math.nan

    tgt_levels = inp["asksL1L2"] if inp["side"] == "BUY" else inp["bidsL1L2"]
    best_opp = ask if inp["side"] == "BUY" else bid
    if has_l2:
        rem = desired
        wsum, filled = 0.0, 0.0
        for lv in tgt_levels:
            tk = min(rem, lv["sizeLots"])
            wsum += tk * lv["priceArs"]
            filled += tk
            rem -= tk
            if rem <= 1e-12:
                break
        if rem > 1e-9:
            wsum += rem * tgt_levels[-1]["priceArs"]
            filled += rem
        cross_slip = abs(wsum / filled - best_opp)
        es_cross = half_spr + cross_slip
    else:
        cross_slip, es_cross = math.nan, math.nan

    if not all_ok:
        dec = "ABORT_STALE"
    elif p_l1 < 0.25 or (inp["expectedEdgeArsPerShare"] > es_cross and es_cross <= min(es_l1, es_imp if not math.isnan(es_imp) else math.inf)):
        dec = "CROSS_BOOK"
    elif spr_ticks >= 2 and not math.isnan(es_imp) and es_imp <= es_l1:
        dec = "PRICE_IMPROVE_1_TICK"
    else:
        dec = "POST_PASSIVE_L1"

    vis_depth = sum(lv["sizeLots"] for lv in tgt_levels) if has_l2 else math.nan
    daily_sig = inp.get("dailyVolPct") or (inp["optionIvDecimal"] / math.sqrt(252.0))
    sqrt_cap = inp["adv20Lots"] * ((0.015 / (0.50 * daily_sig)) ** (1.0 / 0.60))
    max_ord = float(math.floor(min(0.50 * vis_depth, 0.05 * inp["adv20Lots"], 0.10 * inp["uncoveredOiLots"], sqrt_cap))) if has_l2 else math.nan

    return {
        "status": "OK" if has_l2 else "DEGRADED_L1_ONLY",
        "decision": dec,
        "hayashiYoshida": hy,
        "gates": {
            "gate1FreshnessPassed": g1,
            "gate1Status": g1s,
            "quoteAgeSec": age,
            "gate2SpreadPassed": g2,
            "spreadPct": spr_pct,
            "gate3DepthPassed": g3,
            "l1JoinLots": l1_join,
            "l1CrossLots": l1_cross,
            "gate4TickConfirmPassed": g4,
            "allGatesPassed": all_ok,
        },
        "spreadTicks": spr_ticks,
        "halfSpreadArs": half_spr,
        "lambdaEffectivePerSec": lam_eff,
        "fillProbPassiveL1": p_l1,
        "fillProbImprove1Tick": p_imp,
        "adverseSelectionCostArs": adv_sel,
        "esPassiveL1Ars": es_l1,
        "esImprove1TickArs": es_imp,
        "esCrossBookArs": es_cross,
        "crossBookVwapSlippageArs": cross_slip,
        "visibleTargetDepthLots": vis_depth,
        "sqrtImpactCapLots": sqrt_cap,
        "maxSingleOrderLots": max_ord,
    }


def price_unit_portfolio_ars(
    ep: dict[str, float],
    byma_legs: list[dict[str, Any]],
    opra_legs: list[dict[str, Any]],
    adr_spot: float,
    ccl: float,
    iv_shift: float,
) -> float:
    tot = 0.0
    as_of = ep["asOfUtcSec"]
    for l in byma_legs:
        sig = max(MIN_CCP_STRESS_VOL, l["ivDecimal"] + iv_shift)
        px = price_byma_bs02(ep, l["strikeArs"], sig, l["contractType"])
        tot += (1.0 if l["side"] == "BUY" else -1.0) * l["lots"] * GGAL_BYMA_LOT_SIZE * px
    for o in opra_legs:
        t_exp = max(1.0 / (24.0 * DAYS_PER_YEAR), (o["expiryUtcSec"] - as_of) / SECONDS_PER_YEAR_365)
        sig = max(MIN_CCP_STRESS_VOL, o["ivDecimal"] + iv_shift)
        px_usd = price_american_bs02(adr_spot, o["strikeUsd"], t_exp, o["rateUsdContinuous"], o.get("dividendYieldUsd", 0.0), sig, o["contractType"])
        tot += ((1.0 if o["side"] == "BUY" else -1.0) * o["contracts"] * OPRA_CONTRACT_SHARES * px_usd * ccl) / 10.0
    return tot


STRESS_SCENARIOS = [
    {"id": "CCL_UP_15_ADR_DOWN_10", "label": "CCL +15 % / ADR −10 %", "adrShockPct": -0.10, "cclShockPct": 0.15, "ivShiftDecimal": 0.12, "lecapBpsShift": 200},
    {"id": "GAP_COMPRESS_10_ADR_UP_12", "label": "Compresión Gap −10 % / ADR +12 %", "adrShockPct": 0.12, "cclShockPct": -0.10, "ivShiftDecimal": -0.06, "lecapBpsShift": -150},
    {"id": "LECAP_RATE_SPIKE_1500BPS", "label": "Suba Tasas LECAP +1500 bps", "adrShockPct": -0.04, "cclShockPct": 0.04, "ivShiftDecimal": 0.05, "lecapBpsShift": 1500},
    {"id": "OVERNIGHT_ELECTION_TAIL", "label": "Cola Electoral / Fin de Semana", "adrShockPct": -0.22, "cclShockPct": 0.25, "ivShiftDecimal": 0.30, "lecapBpsShift": 1200},
    {"id": "BAND_INTERVENTION_DOUBLE_DROP", "label": "Doble Caída Intervención Bandas", "adrShockPct": -0.12, "cclShockPct": -0.15, "ivShiftDecimal": 0.15, "lecapBpsShift": 600},
]


def ref_evaluate_tail_stress(inp: dict[str, Any]) -> dict[str, Any]:
    as_of = inp["asOfUtcSec"]
    exp_key = inp["expiryDateKey"]
    exp_sec = exp_1530_art_utc(exp_key)
    spot = inp["spot24hArs"]
    adr = inp["spotAdrUsd"]
    ccl = inp["cclArs"]
    rc = inp["rateCurveArs"]
    divs = inp.get("dividendsArs", [])
    blegs = inp["bymaLegsPerUnit"]
    olegs = inp.get("opraLegsPerTenBymaLots", [])

    base_ep = byma_eval_params(as_of, spot, exp_key, rc, divs)
    base_val = price_unit_portfolio_ars(base_ep, blegs, olegs, adr, ccl, 0.0)
    rt_fee = 2.0 * sum(l["optionPriceArs"] * GGAL_BYMA_LOT_SIZE * l["lots"] * BYMA_OPTION_PREMIUM_DM_RATE_WITH_IVA for l in blegs)

    def_af = {"CASH_ARS": 1.0, "CASH_USD": 1.0, "US_TREASURY_BILL": 0.98, "US_TREASURY_NOTE": 0.96, "US_TREASURY_BOND": 0.94}
    sc_out = []
    worst_id = STRESS_SCENARIOS[0]["id"]
    worst_loss = 0.0
    for sc in STRESS_SCENARIOS:
        sh_adr = adr * (1.0 + sc["adrShockPct"])
        sh_ccl = ccl * (1.0 + sc["cclShockPct"])
        ars_chg = (1.0 + sc["adrShockPct"]) * (1.0 + sc["cclShockPct"]) - 1.0
        sh_spot = spot * (1.0 + ars_chg)
        lec_sh = sc["lecapBpsShift"] / 10_000.0
        sh_rc = [{"days": pt["days"], "continuousRateAnnual": pt["continuousRateAnnual"] + lec_sh} for pt in rc]
        sc_ep = byma_eval_params(as_of, sh_spot, exp_key, sh_rc, divs)
        sc_val = price_unit_portfolio_ars(sc_ep, blegs, olegs, sh_adr, sh_ccl, sc["ivShiftDecimal"])
        pnl = sc_val - base_val - rt_fee
        coll_imp = 0.0
        for c in inp["collateralAssets"]:
            af = c.get("explicitAforo", def_af.get(c["kind"]))
            if c["kind"] in ("LECAP", "SOVEREIGN_BOND_AR"):
                coll_imp += c["marketValueArs"] * af * (-c.get("modifiedDurationYears", 0.0) * lec_sh)
        str_coll = max(0.0, inp["totalEffectiveCollateralArs"] + coll_imp)
        if -pnl > worst_loss:
            worst_loss = -pnl
            worst_id = sc["id"]
        sc_out.append({
            "id": sc["id"],
            "shockedAdrUsd": sh_adr,
            "shockedCclArs": sh_ccl,
            "shockedSpotArs": sh_spot,
            "spotArsChangePct": ars_chg,
            "portfolioPnlPerUnitArs": pnl,
            "collateralRateImpactArs": coll_imp,
            "stressedEffectiveCollateralArs": str_coll,
        })

    op = inp["overnightParams"]
    n_z1 = op.get("nAdrQuantiles", 9)
    n_z2 = op.get("nCclQuantiles", 5)
    dt_y = OVERNIGHT_HORIZON_YEARS
    sqrt_dt = math.sqrt(dt_y)
    lam_dt = op["lambdaJumpAdrAnnual"] * dt_y
    p0 = math.exp(-lam_dt)
    p1 = p0 * lam_dt
    p2 = max(0.0, 1.0 - p0 - p1)

    kap_adr = math.exp(op["jumpMeanAdr"] + 0.5 * op["jumpVolAdr"] ** 2) - 1.0
    co_m = op["cclCoJumpBeta"] * op["jumpMeanAdr"]
    co_v = (op["cclCoJumpBeta"] * op["jumpVolAdr"]) ** 2 + op["sigmaCoJumpCcl"] ** 2
    kap_ccl = math.exp(co_m + 0.5 * co_v) - 1.0

    adr_dr = (op["muAdrAnnual"] - 0.5 * op["sigmaAdrDiffAnnual"] ** 2 - op["lambdaJumpAdrAnnual"] * kap_adr) * dt_y
    ccl_dr = (op["muCclAnnual"] - 0.5 * op["sigmaCclDiffAnnual"] ** 2 - op["lambdaJumpAdrAnnual"] * kap_ccl) * dt_y
    orth = math.sqrt(max(0.0, 1.0 - op["rhoDiffAdrCcl"] ** 2))
    next_sec = min(exp_sec - 60, as_of + int(OVERNIGHT_HORIZON_HOURS * 3600))

    nodes: list[tuple[float, float]] = []
    for k, pk in ((0, p0), (1, p1), (2, p2)):
        if pk <= 0:
            continue
        cp = pk / (n_z1 * n_z2)
        tot_std = math.sqrt(op["sigmaAdrDiffAnnual"] ** 2 * dt_y + k * op["jumpVolAdr"] ** 2)
        jm_mean = k * op["jumpMeanAdr"]
        j_share = (math.sqrt(k) * op["jumpVolAdr"] / tot_std) if (tot_std > 0 and k > 0) else 0.0
        for i in range(n_z1):
            z1 = inv_norm_cdf((i + 0.5) / n_z1)
            n_adr = adr * math.exp(adr_dr + jm_mean + tot_std * z1)
            j_dev = j_share * tot_std * z1
            for j in range(n_z2):
                z2 = inv_norm_cdf((j + 0.5) / n_z2)
                c_diff = op["sigmaCclDiffAnnual"] * sqrt_dt * (op["rhoDiffAdrCcl"] * z1 + orth * z2)
                c_co = k * co_m + op["cclCoJumpBeta"] * j_dev + math.sqrt(k) * op["sigmaCoJumpCcl"] * z2
                n_ccl = ccl * math.exp(ccl_dr + c_diff + c_co)
                n_spot = spot * (n_adr / adr) * (n_ccl / ccl)
                n_ep = byma_eval_params(next_sec, n_spot, exp_key, rc, divs)
                n_val = price_unit_portfolio_ars(n_ep, blegs, olegs, n_adr, n_ccl, 0.0)
                nodes.append((cp, n_val - base_val - rt_fee))

    tot_p = sum(p for p, _ in nodes)
    exp_pnl = sum(p * x for p, x in nodes) / tot_p
    var_pnl = sum((p / tot_p) * ((x - exp_pnl) ** 2) for p, x in nodes)
    std_pnl = math.sqrt(var_pnl)
    max_loss = max(0.0, max(-x for _, x in nodes))

    sorted_loss = sorted(nodes, key=lambda t: t[1])
    cum_p, tail_sum, var99 = 0.0, 0.0, 0.0
    alpha = 0.01
    for p, x in sorted_loss:
        pn = p / tot_p
        loss = max(0.0, -x)
        if cum_p >= alpha:
            break
        take = min(pn, alpha - cum_p)
        tail_sum += take * loss
        cum_p += take
        var99 = loss
    cvar99 = tail_sum / cum_p

    cap = inp["capitalArs"]
    e_ret = exp_pnl / cap
    v_ret = var_pnl / (cap * cap)
    full_k = e_ret / v_ret if (e_ret > 0 and v_ret > 0) else 0.0
    q_kelly = 0.25 * full_k
    no_ruin = (0.95 * cap) / max_loss if max_loss > 0 else math.inf
    cvar_cap = (0.15 * cap) / cvar99 if cvar99 > 0 else math.inf
    dd_cap = (0.20 * cap) / worst_loss if worst_loss > 0 else math.inf
    m_cap = inp["totalEffectiveCollateralArs"] / inp["marginRequiredPerUnitArs"] if inp["marginRequiredPerUnitArs"] > 0 else math.inf

    caps = [
        ("Quarter-Kelly 0.25x", q_kelly),
        ("No-Ruin Overnight (95%)", no_ruin),
        ("CVaR 99% Budget", cvar_cap),
        ("Max Stress Drawdown", dd_cap),
        ("BYMA Clearing Collateral", m_cap),
    ]
    binder, best_val = min(caps, key=lambda t: t[1])
    rec_byma = max(0, math.floor(best_val)) if math.isfinite(best_val) else 0
    rec_opra_exact = rec_byma * (GGAL_BYMA_LOT_SIZE / GGAL_ADR_RATIO) / OPRA_CONTRACT_SHARES

    return {
        "status": "OK",
        "scenarioResults": sc_out,
        "worstScenarioId": worst_id,
        "worstUnitLossArs": worst_loss,
        "overnightNodesCount": len(nodes),
        "overnightExpectedPnlPerUnitArs": exp_pnl,
        "overnightStdDevPerUnitArs": std_pnl,
        "overnightMaxLossPerUnitArs": max_loss,
        "overnightVar99PerUnitArs": var99,
        "overnightCvar99PerUnitArs": cvar99,
        "sizingBreakdown": {
            "fullKellyLots": full_k,
            "quarterKellyLots": q_kelly,
            "noRuinCapLots": no_ruin,
            "cvar99CapLots": cvar_cap,
            "drawdownCapLots": dd_cap,
            "collateralMarginCapLots": m_cap,
            "bindingConstraint": binder,
        },
        "recommendedBymaLots": rec_byma,
        "recommendedOpraContractsExact": rec_opra_exact,
        "recommendedOpraContractsFloored": math.floor(rec_opra_exact),
    }


def build_fixture() -> dict[str, Any]:
    as_of = utc_sec_from_iso("2026-04-10T15:00:00Z")
    expiry_key = "2026-06-19"
    spot = 7420.0
    rate_curve = [
        {"days": 1.0, "continuousRateAnnual": 0.34},
        {"days": 30.0, "continuousRateAnnual": 0.36},
        {"days": 90.0, "continuousRateAnnual": 0.38},
    ]
    dividends = [
        {
            "exDivUtcSec": utc_sec_from_iso("2026-05-14T14:00:00Z"),
            "payDateUtcSec": utc_sec_from_iso("2026-05-18T14:00:00Z"),
            "amountArs": 85.0,
        }
    ]
    mixed_collateral = [
        {"id": "TBILL_USD", "kind": "US_TREASURY_BILL", "marketValueArs": 500_000.0},
        {"id": "LECAP_S31G6", "kind": "LECAP", "marketValueArs": 1_200_000.0, "explicitAforo": 0.88, "modifiedDurationYears": 0.42},
        {"id": "CASH", "kind": "CASH_ARS", "marketValueArs": 300_000.0},
    ]

    # 8 estrategias de margen BYMA Clearing
    margin_cases: dict[str, Any] = {}
    strat_inputs = [
        ("uncovered_short_otm_gt5", {
            "asOfUtcSec": as_of, "expiryDateKey": expiry_key, "spot24hArs": spot, "rateCurveArs": rate_curve,
            "dividendsArs": dividends, "strategyKind": "UNCOVERED_SHORT",
            "legs": [{"ticker": "GFGC8000JU", "contractType": "call", "side": "SELL", "lots": 20, "strikeArs": 8000.0, "optionPriceArs": 420.0, "ivDecimal": 0.48}],
            "collateralAssets": mixed_collateral,
        }),
        ("vertical_debit_spread", {
            "asOfUtcSec": as_of, "expiryDateKey": expiry_key, "spot24hArs": spot, "rateCurveArs": rate_curve,
            "dividendsArs": dividends, "strategyKind": "VERTICAL_DEBIT_SPREAD",
            "legs": [
                {"ticker": "GFGC7400JU", "contractType": "call", "side": "BUY", "lots": 10, "strikeArs": 7400.0, "optionPriceArs": 740.0, "ivDecimal": 0.49},
                {"ticker": "GFGC7800JU", "contractType": "call", "side": "SELL", "lots": 10, "strikeArs": 7800.0, "optionPriceArs": 510.0, "ivDecimal": 0.48},
            ],
            "collateralAssets": [{"id": "CASH", "kind": "CASH_ARS", "marketValueArs": 1_000_000.0}],
        }),
        ("vertical_credit_spread", {
            "asOfUtcSec": as_of, "expiryDateKey": expiry_key, "spot24hArs": spot, "rateCurveArs": rate_curve,
            "dividendsArs": dividends, "strategyKind": "VERTICAL_CREDIT_SPREAD",
            "legs": [
                {"ticker": "GFGV7200JU", "contractType": "put", "side": "SELL", "lots": 15, "strikeArs": 7200.0, "optionPriceArs": 385.0, "ivDecimal": 0.51},
                {"ticker": "GFGV6800JU", "contractType": "put", "side": "BUY", "lots": 15, "strikeArs": 6800.0, "optionPriceArs": 215.0, "ivDecimal": 0.53},
            ],
            "collateralAssets": mixed_collateral,
        }),
        ("ratio_spread_1x2", {
            "asOfUtcSec": as_of, "expiryDateKey": expiry_key, "spot24hArs": spot, "rateCurveArs": rate_curve,
            "dividendsArs": dividends, "strategyKind": "RATIO_SPREAD_1X2",
            "legs": [
                {"ticker": "GFGC7400JU", "contractType": "call", "side": "BUY", "lots": 10, "strikeArs": 7400.0, "optionPriceArs": 740.0, "ivDecimal": 0.49},
                {"ticker": "GFGC7700JU", "contractType": "call", "side": "SELL", "lots": 20, "strikeArs": 7700.0, "optionPriceArs": 555.0, "ivDecimal": 0.48},
            ],
            "collateralAssets": mixed_collateral,
        }),
        ("ratio_spread_1x3", {
            "asOfUtcSec": as_of, "expiryDateKey": expiry_key, "spot24hArs": spot, "rateCurveArs": rate_curve,
            "dividendsArs": dividends, "strategyKind": "RATIO_SPREAD_1X3",
            "legs": [
                {"ticker": "GFGC7400JU", "contractType": "call", "side": "BUY", "lots": 10, "strikeArs": 7400.0, "optionPriceArs": 740.0, "ivDecimal": 0.49},
                {"ticker": "GFGC8000JU", "contractType": "call", "side": "SELL", "lots": 30, "strikeArs": 8000.0, "optionPriceArs": 420.0, "ivDecimal": 0.48},
            ],
            "collateralAssets": mixed_collateral,
        }),
        ("short_strangle", {
            "asOfUtcSec": as_of, "expiryDateKey": expiry_key, "spot24hArs": spot, "rateCurveArs": rate_curve,
            "dividendsArs": dividends, "strategyKind": "SHORT_STRADDLE_STRANGLE",
            "legs": [
                {"ticker": "GFGC7800JU", "contractType": "call", "side": "SELL", "lots": 10, "strikeArs": 7800.0, "optionPriceArs": 510.0, "ivDecimal": 0.48},
                {"ticker": "GFGV7000JU", "contractType": "put", "side": "SELL", "lots": 10, "strikeArs": 7000.0, "optionPriceArs": 310.0, "ivDecimal": 0.52},
            ],
            "collateralAssets": mixed_collateral,
        }),
        ("covered_call_full", {
            "asOfUtcSec": as_of, "expiryDateKey": expiry_key, "spot24hArs": spot, "rateCurveArs": rate_curve,
            "dividendsArs": dividends, "strategyKind": "COVERED_CALL", "underlyingSharesHeld": 2000,
            "legs": [{"ticker": "GFGC7800JU", "contractType": "call", "side": "SELL", "lots": 20, "strikeArs": 7800.0, "optionPriceArs": 510.0, "ivDecimal": 0.48}],
            "collateralAssets": [{"id": "CASH", "kind": "CASH_ARS", "marketValueArs": 500_000.0}],
        }),
        ("cross_collateral_strategy", {
            "asOfUtcSec": as_of, "expiryDateKey": expiry_key, "spot24hArs": spot, "rateCurveArs": rate_curve,
            "dividendsArs": dividends, "strategyKind": "CROSS_COLLATERAL_STRATEGY",
            "legs": [
                {"ticker": "GFGV7100JU", "contractType": "put", "side": "SELL", "lots": 12, "strikeArs": 7100.0, "optionPriceArs": 345.0, "ivDecimal": 0.52},
                {"ticker": "GFGC7900JU", "contractType": "call", "side": "BUY", "lots": 6, "strikeArs": 7900.0, "optionPriceArs": 460.0, "ivDecimal": 0.48},
            ],
            "collateralAssets": mixed_collateral,
        }),
        ("missing_lecap_aforo_nan", {
            "asOfUtcSec": as_of, "expiryDateKey": expiry_key, "spot24hArs": spot, "rateCurveArs": rate_curve,
            "dividendsArs": dividends, "strategyKind": "UNCOVERED_SHORT",
            "legs": [{"ticker": "GFGC7600JU", "contractType": "call", "side": "SELL", "lots": 10, "strikeArs": 7600.0, "optionPriceArs": 610.0, "ivDecimal": 0.48}],
            "collateralAssets": [{"id": "LECAP_NO_AFORO", "kind": "LECAP", "marketValueArs": 1_000_000.0}],
        }),
        ("circular_3588_atm_active", {
            "asOfUtcSec": utc_sec_from_iso("2026-06-19T17:55:00Z"), # 14:55 ART = 35m al corte 15:30 ART
            "expiryDateKey": "2026-06-22",
            "spot24hArs": 7408.0, "rateCurveArs": rate_curve,
            "dividendsArs": [], "strategyKind": "UNCOVERED_SHORT",
            "legs": [{"ticker": "GFGC7400JU", "contractType": "call", "side": "SELL", "lots": 10, "strikeArs": 7400.0, "optionPriceArs": 180.0, "ivDecimal": 0.50}],
            "collateralAssets": [{"id": "CASH", "kind": "CASH_ARS", "marketValueArs": 1_000_000.0}],
        }),
    ]
    for name, inp in strat_inputs:
        # Ajuste: para circular_3588_atm_active usar expiryDateKey == "2026-06-19" con 17:55 UTC (14:55 ART) -> T>0!
        if name == "circular_3588_atm_active":
            inp["expiryDateKey"] = "2026-06-19"
        margin_cases[name] = {"input": inp, "output": ref_evaluate_margin(inp)}

    # Microestructura: streams async BYMA vs ADR con cambios alternantes donde ADR lidera +5s exactamente
    t0 = 1775833000
    adr_series = [61.20, 61.90, 61.90, 61.10, 62.05, 61.35, 62.20, 61.50, 62.45]
    byma_series = [7340.0, 7422.0, 7328.0, 7440.0, 7358.0, 7458.0, 7376.0, 7488.0]
    adr_times = [t0, t0 + 10, t0 + 13, t0 + 22, t0 + 35, t0 + 48, t0 + 60, t0 + 74, t0 + 86]
    adr_ticks = [{"utcSec": ts, "midPrice": px} for ts, px in zip(adr_times, adr_series)]
    byma_unique_times = [t0 + 5, t0 + 15, t0 + 27, t0 + 40, t0 + 53, t0 + 65, t0 + 79, t0 + 91]
    byma_ticks = [
        {"utcSec": ts, "midPrice": px} for ts, px in zip(byma_unique_times, byma_series)
    ]

    exec_cases: dict[str, Any] = {}
    exec_inputs = [
        ("post_passive_l1", {
            "asOfUtcSec": t0 + 120, "telemetryMode": "LIVE", "side": "BUY", "desiredLots": 20, "orderHorizonSec": 60.0,
            "quoteAsOfUtcSec": t0 + 112, "bidArs": 500.0, "askArs": 505.0, "lastTradeArs": 502.0, "tickSizeArs": 5.0,
            "depthSource": "PRIMARY_L2",
            "bidsL1L2": [{"priceArs": 500.0, "sizeLots": 30}, {"priceArs": 495.0, "sizeLots": 60}],
            "asksL1L2": [{"priceArs": 505.0, "sizeLots": 25}, {"priceArs": 510.0, "sizeLots": 80}],
            "adv20Lots": 2400.0, "uncoveredOiLots": 1200.0, "lambdaBasePerSec": 1.2, "expectedEdgeArsPerShare": 1.8,
            "optionIvDecimal": 0.48, "bymaTicks": byma_ticks, "adrTicks": adr_ticks,
        }),
        ("price_improve_1_tick", {
            "asOfUtcSec": t0 + 120, "telemetryMode": "LIVE", "side": "BUY", "desiredLots": 25, "orderHorizonSec": 45.0,
            "quoteAsOfUtcSec": t0 + 115, "bidArs": 500.0, "askArs": 515.0, "lastTradeArs": 508.0, "tickSizeArs": 5.0,
            "depthSource": "PRIMARY_L2",
            "bidsL1L2": [{"priceArs": 500.0, "sizeLots": 90}, {"priceArs": 495.0, "sizeLots": 100}],
            "asksL1L2": [{"priceArs": 515.0, "sizeLots": 40}, {"priceArs": 520.0, "sizeLots": 60}],
            "adv20Lots": 2400.0, "uncoveredOiLots": 1200.0, "lambdaBasePerSec": 1.0, "expectedEdgeArsPerShare": 2.0,
            "optionIvDecimal": 0.48, "bymaTicks": byma_ticks, "adrTicks": adr_ticks,
        }),
        ("cross_book_low_fill", {
            "asOfUtcSec": t0 + 120, "telemetryMode": "LIVE", "side": "BUY", "desiredLots": 60, "orderHorizonSec": 20.0,
            "quoteAsOfUtcSec": t0 + 117, "bidArs": 500.0, "askArs": 505.0, "lastTradeArs": 504.0, "tickSizeArs": 5.0,
            "depthSource": "PRIMARY_L2",
            "bidsL1L2": [{"priceArs": 500.0, "sizeLots": 150}, {"priceArs": 495.0, "sizeLots": 120}],
            "asksL1L2": [{"priceArs": 505.0, "sizeLots": 35}, {"priceArs": 510.0, "sizeLots": 80}],
            "adv20Lots": 2400.0, "uncoveredOiLots": 1200.0, "lambdaBasePerSec": 0.4, "expectedEdgeArsPerShare": 6.0,
            "optionIvDecimal": 0.48, "bymaTicks": byma_ticks, "adrTicks": adr_ticks,
        }),
        ("abort_stale_quote", {
            "asOfUtcSec": t0 + 200, "telemetryMode": "LIVE", "side": "BUY", "desiredLots": 10, "orderHorizonSec": 60.0,
            "quoteAsOfUtcSec": t0 + 140, "bidArs": 500.0, "askArs": 505.0, "lastTradeArs": 502.0, "tickSizeArs": 5.0,
            "depthSource": "PRIMARY_L2",
            "bidsL1L2": [{"priceArs": 500.0, "sizeLots": 30}],
            "asksL1L2": [{"priceArs": 505.0, "sizeLots": 30}],
            "adv20Lots": 2000.0, "uncoveredOiLots": 1000.0, "lambdaBasePerSec": 1.0, "expectedEdgeArsPerShare": 1.0,
            "optionIvDecimal": 0.48, "bymaTicks": byma_ticks, "adrTicks": adr_ticks,
        }),
    ]
    for name, inp in exec_inputs:
        exec_cases[name] = {"input": inp, "output": ref_evaluate_microstructure(inp)}

    # Stress Test & Kelly-CVaR Sizing (Covered / Vertical Bull Call con EV > 0 overnight bajo drift alcista)
    stress_inp = {
        "asOfUtcSec": as_of,
        "expiryDateKey": expiry_key,
        "spot24hArs": spot,
        "spotAdrUsd": 61.50,
        "cclArs": 1206.50,
        "rateCurveArs": rate_curve,
        "dividendsArs": dividends,
        "bymaLegsPerUnit": [
            {"ticker": "GFGC7400JU", "contractType": "call", "side": "BUY", "lots": 1, "strikeArs": 7400.0, "optionPriceArs": 740.0, "ivDecimal": 0.46},
            {"ticker": "GFGC7800JU", "contractType": "call", "side": "SELL", "lots": 1, "strikeArs": 7800.0, "optionPriceArs": 510.0, "ivDecimal": 0.54},
        ],
        "opraLegsPerTenBymaLots": [
            {"ticker": "GGAL260619P00060000", "contractType": "put", "side": "BUY", "contracts": 1, "strikeUsd": 60.0, "expiryUtcSec": exp_1530_art_utc(expiry_key), "ivDecimal": 0.48, "rateUsdContinuous": 0.043, "dividendYieldUsd": 0.015},
        ],
        "capitalArs": 25_000_000.0,
        "totalEffectiveCollateralArs": 1_856_000.0,
        "marginRequiredPerUnitArs": 18_500.0,
        "collateralAssets": mixed_collateral,
        "overnightParams": {
            "muAdrAnnual": 0.65,
            "sigmaAdrDiffAnnual": 0.42,
            "lambdaJumpAdrAnnual": 12.0,
            "jumpMeanAdr": 0.02,
            "jumpVolAdr": 0.05,
            "muCclAnnual": 0.28,
            "sigmaCclDiffAnnual": 0.22,
            "rhoDiffAdrCcl": -0.30,
            "cclCoJumpBeta": -0.35,
            "sigmaCoJumpCcl": 0.03,
            "nAdrQuantiles": 9,
            "nCclQuantiles": 5,
        },
    }

    return {
        "meta": {
            "generator": "tools/gen_ggal_motor6_fixture.py",
            "pieza": 25,
            "tolerance": 1e-11,
        },
        "marginCases": margin_cases,
        "executionCases": exec_cases,
        "tailStressCase": {
            "input": stress_inp,
            "output": ref_evaluate_tail_stress(stress_inp),
        },
    }


def main() -> None:
    out_path = Path(__file__).resolve().parent.parent / "fixtures" / "ggal_motor6_reference.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = sanitize_json(build_fixture())
    out_path.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n", encoding="utf-8")
    print(f"Wrote independent Motor 6 reference fixture to {out_path}")


if __name__ == "__main__":
    main()
