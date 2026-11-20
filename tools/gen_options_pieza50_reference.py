#!/usr/bin/env python3
"""
Generador de referencia independiente en Python para la Pieza 50 (Opciones Quant):
  1. Vanna (VEX) y Charm (CEX) de dealers sobre cadenas multi-strike con q > 0 y q = 0,
     régimen de Vanna ante compresión de IV y Charm Pin con desempate determinístico.
  2. Régimen de skew del vencimiento activo: IV_25C / IV_25P / IV_ATM interpoladas con
     bracketing estricto, RR_25 = IV_25P - IV_25C, BF_25 = 0.5*(IV25P + IV25C) - IV_ATM
     e IVR / IVP 1Y sobre serie histórica (desigualdad estricta `<`).
  3. Heatmap 2D 7x7 Spot x dIV y atribución de griegas de Taylor de 2.º orden para un
     Iron Condor de 4 patas, reutilizando BSM multipata con piso físico de IV.

Implementación pura con math.erf / math.erfc / math.exp / math.log / math.sqrt,
sin copiar la lógica TypeScript de producción. Salida: fixtures/options_pieza50_reference.json
con `"NaN"` como cadena para valores no calculables (convención del repositorio).
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

SECONDS_PER_DAY = 86_400.0
SECONDS_PER_YEAR = 365.0 * SECONDS_PER_DAY
MIN_WHAT_IF_VOL = 0.005
DEFAULT_US_OPTION_MULTIPLIER = 100.0
DAYS_PER_YEAR = 365.0

WHAT_IF_SIGMA_STEPS = [-2.0, -1.33, -0.67, 0.0, 0.67, 1.33, 2.0]
WHAT_IF_IV_SHIFT_STEPS = [-15.0, -10.0, -5.0, 0.0, 5.0, 10.0, 15.0]


def norm_cdf(x: float) -> float:
    if math.isnan(x):
        return math.nan
    if x == math.inf:
        return 1.0
    if x == -math.inf:
        return 0.0
    return 0.5 * math.erfc(-x / math.sqrt(2.0))


def norm_pdf(x: float) -> float:
    if math.isnan(x):
        return math.nan
    if math.isinf(x):
        return 0.0
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def bsm_greeks(
    spot: float,
    strike: float,
    time_to_expiry: float,
    rate: float,
    dividend_yield: float,
    volatility: float,
    contract_type: str,
) -> dict[str, float]:
    """BSM completo (precio, delta, gamma, theta diaria, vega 1%, vanna y charm).

    Espeja el desdoblamiento de precio profundo-ITM (paridad descontada + valor
    extrínseco) del motor de producción para precisión numérica equivalente.
    """
    sqrt_t = math.sqrt(time_to_expiry)
    vol_sqrt_t = volatility * sqrt_t
    disc_underlier_factor = math.exp(-dividend_yield * time_to_expiry)
    disc_strike_factor = math.exp(-rate * time_to_expiry)
    log_moneyness = math.log(spot) - math.log(strike)
    drift_term = (rate - dividend_yield + 0.5 * volatility * volatility) * time_to_expiry
    d1 = (log_moneyness + drift_term) / vol_sqrt_t
    d2 = d1 - vol_sqrt_t

    cdf_pos = norm_cdf(d1)
    cdf_neg = norm_cdf(-d1)
    cdf_d2_pos = norm_cdf(d2)
    cdf_d2_neg = norm_cdf(-d2)
    disc_underlier = spot * disc_underlier_factor
    disc_strike = strike * disc_strike_factor
    disc_parity = disc_underlier - disc_strike

    if contract_type == "call":
        price = (
            disc_parity + max(0.0, disc_strike * cdf_d2_neg - disc_underlier * cdf_neg)
            if d2 > 0.0
            else max(0.0, disc_underlier * cdf_pos - disc_strike * cdf_d2_pos)
        )
    else:
        price = (
            -disc_parity + max(0.0, disc_underlier * cdf_pos - disc_strike * cdf_d2_pos)
            if d1 < 0.0
            else max(0.0, disc_strike * cdf_d2_neg - disc_underlier * cdf_neg)
        )

    pdf_d1 = norm_pdf(d1)
    gamma_denom = spot * vol_sqrt_t
    delta = (
        disc_underlier_factor * cdf_pos
        if contract_type == "call"
        else -disc_underlier_factor * cdf_neg
    )
    gamma = 0.0 if pdf_d1 == 0.0 else (disc_underlier_factor * pdf_d1) / gamma_denom
    vega = 0.0 if pdf_d1 == 0.0 else spot * disc_underlier_factor * sqrt_t * pdf_d1
    vega_per_1pct = vega / 100.0
    time_decay_core = (
        0.0
        if pdf_d1 == 0.0
        else -(spot * disc_underlier_factor * pdf_d1 * volatility) / (2.0 * sqrt_t)
    )
    if contract_type == "call":
        theta = (
            time_decay_core
            + dividend_yield * spot * disc_underlier_factor * cdf_pos
            - rate * strike * disc_strike_factor * cdf_d2_pos
        )
    else:
        theta = (
            time_decay_core
            - dividend_yield * spot * disc_underlier_factor * cdf_neg
            + rate * strike * disc_strike_factor * cdf_d2_neg
        )
    theta_daily = theta / 365.0

    vanna = 0.0 if pdf_d1 == 0.0 else -disc_underlier_factor * pdf_d1 * (d2 / volatility)
    if pdf_d1 == 0.0:
        charm_drift_ratio = 0.0
    else:
        charm_denom = 2.0 * time_to_expiry * vol_sqrt_t
        charm_drift_ratio = (
            2.0 * (rate - dividend_yield) * time_to_expiry - d2 * vol_sqrt_t
        ) / charm_denom
    charm_common = (
        0.0 if pdf_d1 == 0.0 else disc_underlier_factor * pdf_d1 * charm_drift_ratio
    )
    charm = (
        dividend_yield * disc_underlier_factor * cdf_pos - charm_common
        if contract_type == "call"
        else -dividend_yield * disc_underlier_factor * cdf_neg - charm_common
    )

    return {
        "price": price,
        "delta": delta,
        "gamma": gamma,
        "thetaDaily": theta_daily,
        "vegaPer1Pct": vega_per_1pct,
        "vanna": vanna,
        "charm": charm,
    }


def classify_vanna_regime(net_vex: float, neutral_epsilon: float = 1e-6) -> str:
    if not math.isfinite(net_vex) or abs(net_vex) <= neutral_epsilon:
        return "NEUTRAL"
    return "SUPPORTIVE_ON_IV_DROP" if net_vex > 0.0 else "PRESSURE_ON_IV_DROP"


def compute_charm_pin_strike(rows: list[dict[str, float]], spot: float) -> float:
    best_strike = math.nan
    best_abs = 0.0
    for row in rows:
        abs_charm = abs(row["netCharmExposure"])
        if not math.isfinite(abs_charm) or abs_charm <= 0.0:
            continue
        is_better = abs_charm > best_abs or (
            abs_charm == best_abs
            and (
                math.isnan(best_strike)
                or abs(row["strike"] - spot) < abs(best_strike - spot)
                or (
                    abs(row["strike"] - spot) == abs(best_strike - spot)
                    and row["strike"] < best_strike
                )
            )
        )
        if is_better:
            best_abs = abs_charm
            best_strike = row["strike"]
    return best_strike


# ---------------------------------------------------------------------------
# 1) VEX / CEX de dealers
# ---------------------------------------------------------------------------


def build_dealer_exposure_case(
    name: str,
    market: dict[str, float],
    contracts: list[dict[str, Any]],
) -> dict[str, Any]:
    spot = market["spot"]
    now_sec = market["nowUtcSec"]
    rate = market["rate"]
    dividend_yield = market.get("dividendYield", 0.0)

    rows: dict[float, dict[str, float]] = {}
    usable_contracts = 0
    active_contracts = 0
    skipped_contracts = 0
    zero_oi_contracts = 0
    counts: dict[str, int] = {"invalidIv": 0, "expired": 0}
    call_vanna_total = 0.0
    put_vanna_total = 0.0
    call_charm_total = 0.0
    put_charm_total = 0.0

    for c in contracts:
        oi = c["openInterest"]
        if oi == 0:
            zero_oi_contracts += 1
            continue
        active_contracts += 1
        t = (c["expiryUtcSec"] - now_sec) / SECONDS_PER_YEAR
        if t <= 0.0:
            skipped_contracts += 1
            counts["expired"] += 1
            continue
        iv = c.get("iv")
        if iv is None or not math.isfinite(iv) or iv <= 0.0:
            skipped_contracts += 1
            counts["invalidIv"] += 1
            continue

        k = c["strike"]
        g = bsm_greeks(spot, k, t, rate, dividend_yield, iv, c["contractType"])
        sgn = 1.0 if c["contractType"] == "call" else -1.0
        notional = sgn * oi * c["sharesPerContract"]
        vanna_exp = notional * g["vanna"] * spot * 0.01
        charm_exp = notional * (g["charm"] / DAYS_PER_YEAR) * spot
        usable_contracts += 1

        row = rows.setdefault(
            k,
            {
                "callVannaExposure": 0.0,
                "putVannaExposure": 0.0,
                "netVannaExposure": 0.0,
                "callCharmExposure": 0.0,
                "putCharmExposure": 0.0,
                "netCharmExposure": 0.0,
            },
        )
        if c["contractType"] == "call":
            call_vanna_total += vanna_exp
            call_charm_total += charm_exp
            row["callVannaExposure"] += vanna_exp
            row["callCharmExposure"] += charm_exp
        else:
            put_vanna_total += vanna_exp
            put_charm_total += charm_exp
            row["putVannaExposure"] += vanna_exp
            row["putCharmExposure"] += charm_exp

    for row in rows.values():
        row["netVannaExposure"] = row["callVannaExposure"] + row["putVannaExposure"]
        row["netCharmExposure"] = row["callCharmExposure"] + row["putCharmExposure"]

    by_strike = [
        {"strike": k, **rows[k]} for k in sorted(rows.keys())
    ]
    net_vanna = call_vanna_total + put_vanna_total
    net_charm = call_charm_total + put_charm_total

    invalid_summary = (active_contracts == 0 and zero_oi_contracts == 0) or (
        active_contracts > 0 and usable_contracts == 0
    )
    if invalid_summary:
        nan = "NaN"
        return {
            "name": name,
            "market": market,
            "contracts": contracts,
            "expected": {
                "callVannaExposure": nan,
                "putVannaExposure": nan,
                "netVannaExposure": nan,
                "callCharmExposure": nan,
                "putCharmExposure": nan,
                "netCharmExposure": nan,
                "vannaRegime": "NEUTRAL",
                "charmPinStrike": nan,
                "byStrike": [],
                "quality": {
                    "usableContracts": usable_contracts,
                    "skippedContracts": skipped_contracts,
                    "zeroOiContracts": zero_oi_contracts,
                    "countsByReason": counts,
                },
            },
        }

    return {
        "name": name,
        "market": market,
        "contracts": contracts,
        "expected": {
            "callVannaExposure": call_vanna_total,
            "putVannaExposure": put_vanna_total,
            "netVannaExposure": net_vanna,
            "callCharmExposure": call_charm_total,
            "putCharmExposure": put_charm_total,
            "netCharmExposure": net_charm,
            "vannaRegime": classify_vanna_regime(net_vanna),
            "charmPinStrike": compute_charm_pin_strike(
                [{"strike": row["strike"], "netCharmExposure": row["netCharmExposure"]} for row in by_strike],
                spot,
            ),
            "byStrike": by_strike,
            "quality": {
                "usableContracts": usable_contracts,
                "skippedContracts": skipped_contracts,
                "zeroOiContracts": zero_oi_contracts,
                "countsByReason": counts,
            },
        },
    }


def build_dealer_exposure_cases() -> list[dict[str, Any]]:
    now_sec = 1_770_000_000
    exp_sec = int(now_sec + 30 * SECONDS_PER_DAY)

    valid_contracts_q_positive = [
        {"contractType": "call", "strike": 105.0, "expiryUtcSec": exp_sec, "openInterest": 1200.0, "sharesPerContract": 100, "iv": 0.22},
        {"contractType": "call", "strike": 110.0, "expiryUtcSec": exp_sec, "openInterest": 800.0, "sharesPerContract": 100, "iv": 0.24},
        {"contractType": "put", "strike": 95.0, "expiryUtcSec": exp_sec, "openInterest": 1500.0, "sharesPerContract": 100, "iv": 0.24},
        {"contractType": "put", "strike": 90.0, "expiryUtcSec": exp_sec, "openInterest": 900.0, "sharesPerContract": 100, "iv": 0.26},
    ]

    mixed_contracts = valid_contracts_q_positive + [
        {"contractType": "call", "strike": 100.0, "expiryUtcSec": exp_sec, "openInterest": 500.0, "sharesPerContract": 100, "iv": None},
        {"contractType": "put", "strike": 100.0, "expiryUtcSec": int(now_sec - SECONDS_PER_DAY), "openInterest": 400.0, "sharesPerContract": 100, "iv": 0.20},
        {"contractType": "call", "strike": 115.0, "expiryUtcSec": exp_sec, "openInterest": 0.0, "sharesPerContract": 100, "iv": 0.25},
    ]

    return [
        build_dealer_exposure_case(
            name="multi_strike_q_positive",
            market={"spot": 100.0, "nowUtcSec": now_sec, "rate": 0.045, "dividendYield": 0.015},
            contracts=valid_contracts_q_positive,
        ),
        build_dealer_exposure_case(
            name="multi_strike_q_zero",
            market={"spot": 100.0, "nowUtcSec": now_sec, "rate": 0.045, "dividendYield": 0.0},
            contracts=valid_contracts_q_positive,
        ),
        build_dealer_exposure_case(
            name="invalid_gate_mixed_adds_zero",
            market={"spot": 100.0, "nowUtcSec": now_sec, "rate": 0.045, "dividendYield": 0.015},
            contracts=mixed_contracts,
        ),
        build_dealer_exposure_case(
            name="only_invalid_degrades_to_nan",
            market={"spot": 100.0, "nowUtcSec": now_sec, "rate": 0.045, "dividendYield": 0.015},
            contracts=[
                {"contractType": "call", "strike": 100.0, "expiryUtcSec": exp_sec, "openInterest": 500.0, "sharesPerContract": 100, "iv": None},
            ],
        ),
    ]


# ---------------------------------------------------------------------------
# 2) Skew 25Δ + IVR / IVP
# ---------------------------------------------------------------------------


def interpolate_bracketed(nodes: list[tuple[float, float]], target: float) -> float | None:
    if not nodes or not math.isfinite(target):
        return None
    for x, y in nodes:
        if abs(x - target) <= 1e-12:
            return y
    if target < nodes[0][0] or target > nodes[-1][0]:
        return None
    for i in range(len(nodes) - 1):
        x0, y0 = nodes[i]
        x1, y1 = nodes[i + 1]
        if x0 < target < x1:
            return y0 + ((y1 - y0) * (target - x0)) / (x1 - x0)
    return None


def dedupe_average_duplicates(nodes: list[tuple[float, float]]) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    i = 0
    while i < len(nodes):
        x = nodes[i][0]
        total = 0.0
        count = 0
        while i < len(nodes) and nodes[i][0] == x:
            total += nodes[i][1]
            count += 1
            i += 1
        out.append((x, total / count))
    return out


def compute_skew_regime(inp: dict[str, Any]) -> dict[str, Any]:
    spot = inp["spot"]
    t = inp["timeToExpiryYears"]
    rate = inp["rate"]
    dividend_yield = inp["dividendYield"]

    history_raw = inp.get("historicalIv1y") or []
    valid_history = [
        v for v in history_raw if v is not None and math.isfinite(v) and v > 0.0
    ]
    valid_history_sessions = len(valid_history)

    def null_result() -> dict[str, Any]:
        return {
            "iv25CallPct": None,
            "iv25PutPct": None,
            "ivAtmPct": None,
            "rr25Pts": None,
            "bf25Pts": None,
            "ivr": None,
            "ivp": None,
            "validHistorySessions": valid_history_sessions,
        }

    if not (math.isfinite(spot) and spot > 0.0) or not (math.isfinite(t) and t > 0.0):
        return null_result()

    call_nodes: list[tuple[float, float]] = []
    put_nodes: list[tuple[float, float]] = []
    per_strike: dict[float, dict[str, float]] = {}

    for contract in inp["contracts"]:
        contract_type = contract["contractType"]
        if contract_type not in ("call", "put"):
            continue
        iv = contract.get("iv")
        if iv is None or not math.isfinite(iv) or iv <= 0.0:
            continue
        strike = contract["strike"]
        if not math.isfinite(strike) or strike <= 0.0:
            continue

        delta = contract.get("delta")
        valid_delta = False
        if delta is not None and math.isfinite(delta):
            if contract_type == "call" and 0.0 < delta < 1.0:
                valid_delta = True
            if contract_type == "put" and -1.0 < delta < 0.0:
                valid_delta = True
        if not valid_delta:
            delta = bsm_greeks(spot, strike, t, rate, dividend_yield, iv, contract_type)["delta"]
        if not math.isfinite(delta):
            continue

        iv_pct = iv * 100.0
        if contract_type == "call":
            call_nodes.append((delta, iv_pct))
        else:
            put_nodes.append((delta, iv_pct))
        slot = per_strike.setdefault(strike, {})
        if contract_type == "call" and "call" not in slot:
            slot["call"] = iv_pct
        if contract_type == "put" and "put" not in slot:
            slot["put"] = iv_pct

    call_nodes.sort(key=lambda node: node[0])
    put_nodes.sort(key=lambda node: node[0])
    call_by_delta = dedupe_average_duplicates(call_nodes)
    put_by_delta = dedupe_average_duplicates(put_nodes)

    otm_by_strike: list[tuple[float, float]] = []
    atm_tolerance = 1e-9 * spot
    for strike in sorted(per_strike.keys()):
        slot = per_strike[strike]
        chosen: float | None = None
        if abs(strike - spot) <= atm_tolerance:
            if "call" in slot and "put" in slot:
                chosen = 0.5 * (slot["call"] + slot["put"])
            else:
                chosen = slot.get("call", slot.get("put"))
        elif strike < spot:
            chosen = slot.get("put")
        else:
            chosen = slot.get("call")
        if chosen is not None:
            otm_by_strike.append((strike, chosen))

    iv25_call = interpolate_bracketed(call_by_delta, 0.25)
    iv25_put = interpolate_bracketed(put_by_delta, -0.25)
    iv_atm = interpolate_bracketed(otm_by_strike, spot)

    rr25 = iv25_put - iv25_call if (iv25_put is not None and iv25_call is not None) else None
    bf25 = (
        0.5 * (iv25_put + iv25_call) - iv_atm
        if (iv25_put is not None and iv25_call is not None and iv_atm is not None)
        else None
    )

    override = inp.get("currentIvOverride")
    if override is not None and math.isfinite(override) and override > 0.0:
        current_iv = override
    elif iv_atm is not None:
        current_iv = iv_atm / 100.0
    else:
        current_iv = None

    min_sessions = inp.get("minHistorySessions")
    if min_sessions is None:
        min_sessions = 20

    ivr: float | None = None
    ivp: float | None = None
    if (
        current_iv is not None
        and valid_history_sessions > 0
        and valid_history_sessions >= min_sessions
    ):
        iv_min = min(valid_history)
        iv_max = max(valid_history)
        below = sum(1 for v in valid_history if v < current_iv)
        ivr = ((current_iv - iv_min) / (iv_max - iv_min)) * 100.0 if iv_max > iv_min else None
        ivp = (below / valid_history_sessions) * 100.0

    return {
        "iv25CallPct": iv25_call,
        "iv25PutPct": iv25_put,
        "ivAtmPct": iv_atm,
        "rr25Pts": rr25,
        "bf25Pts": bf25,
        "ivr": ivr,
        "ivp": ivp,
        "validHistorySessions": valid_history_sessions,
    }


def build_skew_smile_contracts() -> list[dict[str, Any]]:
    strikes = [80.0, 85.0, 90.0, 95.0, 100.0, 105.0, 110.0, 115.0, 120.0]
    call_deltas = [0.90, 0.82, 0.72, 0.60, 0.50, 0.40, 0.28, 0.18, 0.10]
    put_deltas = [-0.10, -0.15, -0.25, -0.40, -0.50, -0.60, -0.70, -0.80, -0.88]
    call_ivs = [0.24, 0.235, 0.23, 0.228, 0.225, 0.227, 0.232, 0.24, 0.25]
    put_ivs = [0.36, 0.345, 0.33, 0.31, 0.23, 0.23, 0.225, 0.218, 0.212]
    contracts: list[dict[str, Any]] = []
    for i, strike in enumerate(strikes):
        contracts.append(
            {
                "strike": strike,
                "contractType": "call",
                "iv": call_ivs[i],
                "delta": call_deltas[i],
            }
        )
    for i, strike in enumerate(strikes):
        contracts.append(
            {
                "strike": strike,
                "contractType": "put",
                "iv": put_ivs[i],
                "delta": put_deltas[i],
            }
        )
    return contracts


def build_skew_regime_cases() -> list[dict[str, Any]]:
    base_contracts = build_skew_smile_contracts()

    nulls_contracts = [
        {**c, "iv": None} if c["strike"] in (80.0, 90.0, 120.0) else c
        for c in base_contracts
    ]
    # La anulación de K=80 afecta a ambas patas ese strike; K=90 anula el nodo exacto -0.25 del put
    # y K=120 el extremo del ala call; el resto interpola con bracketing estricto.

    calls_only_tail = [
        {"strike": 105.0, "contractType": "call", "iv": 0.23, "delta": 0.55},
        {"strike": 110.0, "contractType": "call", "iv": 0.24, "delta": 0.60},
        {"strike": 115.0, "contractType": "call", "iv": 0.25, "delta": 0.65},
        {"strike": 120.0, "contractType": "call", "iv": 0.26, "delta": 0.75},
    ]

    history_30 = [0.10 + 0.5 * (i / 29.0) for i in range(30)]
    history_19 = [0.10 + 0.5 * (i / 18.0) for i in range(19)]
    history_constant = [0.25] * 30
    history_with_nulls: list[Any] = [0.10 + 0.5 * (i / 29.0) for i in range(30)]
    history_with_nulls = history_with_nulls[:5] + [None, 0.0, -0.1] + history_with_nulls[5:]

    bsm_delta_contracts = [
        {"strike": strike, "contractType": "call", "iv": 0.24 + 0.001 * i}
        for i, strike in enumerate([80.0, 85.0, 90.0, 95.0, 100.0, 105.0, 110.0, 115.0, 120.0])
    ] + [
        {"strike": strike, "contractType": "put", "iv": 0.36 - 0.012 * i}
        for i, strike in enumerate([80.0, 85.0, 90.0, 95.0, 100.0, 105.0, 110.0, 115.0, 120.0])
    ]

    cases_input: list[dict[str, Any]] = [
        {
            "name": "smile_9_strikes_exact_deltas",
            "input": {
                "spot": 100.0,
                "timeToExpiryYears": 30.0 / 365.0,
                "rate": 0.045,
                "dividendYield": 0.015,
                "contracts": base_contracts,
            },
        },
        {
            "name": "smile_with_null_ivs_interleaved",
            "input": {
                "spot": 100.0,
                "timeToExpiryYears": 30.0 / 365.0,
                "rate": 0.045,
                "dividendYield": 0.015,
                "contracts": nulls_contracts,
            },
        },
        {
            "name": "no_call_25d_bracket_returns_null",
            "input": {
                "spot": 100.0,
                "timeToExpiryYears": 30.0 / 365.0,
                "rate": 0.045,
                "dividendYield": 0.015,
                "contracts": calls_only_tail,
            },
        },
        {
            "name": "deltas_computed_bsm_when_missing",
            "input": {
                "spot": 100.0,
                "timeToExpiryYears": 30.0 / 365.0,
                "rate": 0.045,
                "dividendYield": 0.015,
                "contracts": bsm_delta_contracts,
            },
        },
        {
            "name": "ivr_ivp_strict_30_sessions_override",
            "input": {
                "spot": 100.0,
                "timeToExpiryYears": 30.0 / 365.0,
                "rate": 0.045,
                "dividendYield": 0.015,
                "contracts": base_contracts,
                "historicalIv1y": history_30,
                "currentIvOverride": 0.28,
            },
        },
        {
            "name": "ivr_from_interpolated_ivatm_30_sessions",
            "input": {
                "spot": 100.0,
                "timeToExpiryYears": 30.0 / 365.0,
                "rate": 0.045,
                "dividendYield": 0.015,
                "contracts": base_contracts,
                "historicalIv1y": history_30,
            },
        },
        {
            "name": "history_len_19_below_min_degrades_null",
            "input": {
                "spot": 100.0,
                "timeToExpiryYears": 30.0 / 365.0,
                "rate": 0.045,
                "dividendYield": 0.015,
                "contracts": base_contracts,
                "historicalIv1y": history_19,
                "currentIvOverride": 0.28,
            },
        },
        {
            "name": "constant_series_ivr_null_ivp_full",
            "input": {
                "spot": 100.0,
                "timeToExpiryYears": 30.0 / 365.0,
                "rate": 0.045,
                "dividendYield": 0.015,
                "contracts": base_contracts,
                "historicalIv1y": history_constant,
                "currentIvOverride": 0.28,
            },
        },
        {
            "name": "history_filters_null_zero_negative_keeps_30",
            "input": {
                "spot": 100.0,
                "timeToExpiryYears": 30.0 / 365.0,
                "rate": 0.045,
                "dividendYield": 0.015,
                "contracts": base_contracts,
                "historicalIv1y": history_with_nulls,
                "currentIvOverride": 0.28,
            },
        },
        {
            "name": "min_history_override_10_with_12_sessions",
            "input": {
                "spot": 100.0,
                "timeToExpiryYears": 30.0 / 365.0,
                "rate": 0.045,
                "dividendYield": 0.015,
                "contracts": base_contracts,
                "historicalIv1y": [0.10 + 0.5 * (i / 11.0) for i in range(12)],
                "currentIvOverride": 0.30,
                "minHistorySessions": 10,
            },
        },
        {
            "name": "expired_expiry_degrades_all_null",
            "input": {
                "spot": 100.0,
                "timeToExpiryYears": 0.0,
                "rate": 0.045,
                "dividendYield": 0.015,
                "contracts": base_contracts,
                "historicalIv1y": history_30,
                "currentIvOverride": 0.28,
            },
        },
        {
            "name": "non_positive_spot_degrades_all_null",
            "input": {
                "spot": 0.0,
                "timeToExpiryYears": 30.0 / 365.0,
                "rate": 0.045,
                "dividendYield": 0.015,
                "contracts": base_contracts,
                "historicalIv1y": history_30,
                "currentIvOverride": 0.28,
            },
        },
    ]

    return [
        {"name": case["name"], "input": case["input"], "expected": compute_skew_regime(case["input"])}
        for case in cases_input
    ]


# ---------------------------------------------------------------------------
# 3) Heatmap 2D + Atribución de Griegas
# ---------------------------------------------------------------------------


def evaluate_single_leg(
    spot: float,
    leg: dict[str, Any],
    rate: float,
    dividend_yield: float,
    remaining_time_years: float,
    iv_shift_decimal: float,
    min_volatility: float,
) -> dict[str, float] | None:
    if (
        not (math.isfinite(spot) and spot > 0.0)
        or not (math.isfinite(leg["strike"]) and leg["strike"] > 0.0)
        or not math.isfinite(leg["quantity"])
        or leg["quantity"] == 0.0
        or not (math.isfinite(leg["iv"]) and leg["iv"] > 0.0)
        or not math.isfinite(leg["timeToExpiry"])
        or leg["timeToExpiry"] < 0.0
        or not math.isfinite(leg["entryPrice"])
        or not math.isfinite(rate)
        or not math.isfinite(dividend_yield)
        or not math.isfinite(remaining_time_years)
    ):
        return None

    if remaining_time_years <= 1e-12:
        if leg["contractType"] == "call":
            intrinsic = max(0.0, spot - leg["strike"])
            terminal_delta = 1.0 if spot > leg["strike"] else (0.0 if spot < leg["strike"] else 0.5)
        else:
            intrinsic = max(0.0, leg["strike"] - spot)
            terminal_delta = -1.0 if spot < leg["strike"] else (0.0 if spot > leg["strike"] else -0.5)
        return {
            "price": intrinsic,
            "delta": terminal_delta,
            "gamma": 0.0,
            "thetaDaily": 0.0,
            "vegaPer1Pct": 0.0,
            "ivClamped": False,
        }

    shifted = leg["iv"] + iv_shift_decimal
    iv_clamped = shifted < min_volatility
    effective_iv = min_volatility if iv_clamped else shifted
    g = bsm_greeks(
        spot,
        leg["strike"],
        remaining_time_years,
        rate,
        dividend_yield,
        effective_iv,
        leg["contractType"],
    )
    return {
        "price": g["price"],
        "delta": g["delta"],
        "gamma": g["gamma"],
        "thetaDaily": g["thetaDaily"],
        "vegaPer1Pct": g["vegaPer1Pct"],
        "ivClamped": iv_clamped,
    }


def evaluate_portfolio_at_state(
    spot: float,
    legs: list[dict[str, Any]],
    rate: float,
    dividend_yield: float,
    elapsed_years: float,
    iv_shift_decimal: float,
    net_entry_debit_per_unit: float,
    position_scale: float,
    min_volatility: float,
) -> dict[str, float] | None:
    if not legs or not math.isfinite(net_entry_debit_per_unit):
        return None

    value_per_unit = 0.0
    delta_per_unit = 0.0
    gamma_per_unit = 0.0
    theta_daily_per_unit = 0.0
    vega_per_1pct_per_unit = 0.0
    iv_clamped_legs = 0

    for leg in legs:
        remaining = max(0.0, leg["timeToExpiry"] - elapsed_years)
        out = evaluate_single_leg(
            spot, leg, rate, dividend_yield, remaining, iv_shift_decimal, min_volatility
        )
        if out is None:
            return None
        value_per_unit += leg["quantity"] * out["price"]
        delta_per_unit += leg["quantity"] * out["delta"]
        gamma_per_unit += leg["quantity"] * out["gamma"]
        theta_daily_per_unit += leg["quantity"] * out["thetaDaily"]
        vega_per_1pct_per_unit += leg["quantity"] * out["vegaPer1Pct"]
        if out["ivClamped"]:
            iv_clamped_legs += 1

    return {
        "valuePerUnit": value_per_unit,
        "pnlUsd": (value_per_unit - net_entry_debit_per_unit) * position_scale,
        "deltaPerUnit": delta_per_unit,
        "gammaPerUnit": gamma_per_unit,
        "thetaDailyPerUnit": theta_daily_per_unit,
        "vegaPer1PctPerUnit": vega_per_1pct_per_unit,
        "ivClampedLegs": float(iv_clamped_legs),
    }


def build_heatmap_case(name: str, inp: dict[str, Any]) -> dict[str, Any]:
    legs = inp["legs"]
    reference_spot = inp["referenceSpot"]
    rate = inp["rate"]
    dividend_yield = inp["dividendYield"]
    elapsed_days = inp["elapsedDays"]
    horizon_dte = inp["horizonDte"]
    contracts = inp.get("contracts", 1)
    multiplier = inp.get("contractMultiplier", DEFAULT_US_OPTION_MULTIPLIER)
    position_scale = contracts * multiplier
    min_volatility = inp.get("minVolatility", MIN_WHAT_IF_VOL)
    seconds_per_year = inp.get("secondsPerYear", SECONDS_PER_YEAR)

    net_entry = sum(leg["quantity"] * leg["entryPrice"] for leg in legs) if legs else math.nan

    def invalid_result() -> dict[str, Any]:
        nan = "NaN"
        return {
            "isValid": False,
            "oneSigmaMoveAbs": nan,
            "sigmaMultipliers": [],
            "spotGrid": [],
            "ivShiftGridPts": [],
            "cells": [],
            "minPnlUsd": nan,
            "maxPnlUsd": nan,
            "attribution": {
                "referenceSpot": nan,
                "targetSpot": nan,
                "deltaSpot": nan,
                "deltaIvPts": nan,
                "elapsedDays": nan,
                "totalBsmPnl": nan,
                "totalPositionPnl": nan,
                "deltaPnl": nan,
                "gammaPnl": nan,
                "thetaPnl": nan,
                "vegaPnl": nan,
                "residualPnl": nan,
            },
        }

    selected_cell = inp.get("selectedCell")
    invalid_selected = False
    if selected_cell is not None:
        row = selected_cell["row"]
        col = selected_cell["col"]
        if not (
            isinstance(row, int)
            and isinstance(col, int)
            and 0 <= row < len(WHAT_IF_IV_SHIFT_STEPS)
            and 0 <= col < len(WHAT_IF_SIGMA_STEPS)
        ):
            invalid_selected = True

    if (
        not (math.isfinite(reference_spot) and reference_spot > 0.0)
        or not (math.isfinite(contracts) and contracts > 0.0)
        or not (math.isfinite(multiplier) and multiplier > 0.0)
        or not (math.isfinite(min_volatility) and min_volatility > 0.0)
        or not (math.isfinite(seconds_per_year) and seconds_per_year > 0.0)
        or not math.isfinite(rate)
        or not math.isfinite(dividend_yield)
        or not math.isfinite(elapsed_days)
        or not math.isfinite(horizon_dte)
        or not legs
        or not math.isfinite(net_entry)
        or invalid_selected
    ):
        return {"name": name, "input": inp, "expected": invalid_result()}

    horizon_years = ((horizon_dte if horizon_dte > 0.0 else 1.0) * SECONDS_PER_DAY) / seconds_per_year
    valid_ivs = [leg["iv"] for leg in legs if math.isfinite(leg["iv"]) and leg["iv"] > 0.0]
    mean_leg_iv = (sum(valid_ivs) / len(valid_ivs)) if valid_ivs else math.nan
    override = inp.get("oneSigmaMoveAbs")
    if override is not None and math.isfinite(override) and override > 0.0:
        one_sigma = override
    else:
        one_sigma = reference_spot * mean_leg_iv * math.sqrt(horizon_years)

    if not (math.isfinite(one_sigma) and one_sigma > 0.0):
        return {"name": name, "input": inp, "expected": invalid_result()}

    spot_grid = [max(0.01, reference_spot + step * one_sigma) for step in WHAT_IF_SIGMA_STEPS]
    clamped_elapsed_days = min(max(elapsed_days, 0.0), horizon_dte)
    elapsed_years_tn = (clamped_elapsed_days * SECONDS_PER_DAY) / seconds_per_year

    if selected_cell is not None:
        target_spot = spot_grid[selected_cell["col"]]
        target_iv_shift = WHAT_IF_IV_SHIFT_STEPS[selected_cell["row"]]
    else:
        target_spot = inp.get("targetSpot", reference_spot)
        target_iv_shift = inp.get("targetIvShiftPts", 0.0)

    base_t0 = evaluate_portfolio_at_state(
        reference_spot, legs, rate, dividend_yield, 0.0, 0.0, net_entry, position_scale, min_volatility
    )
    target_snap = evaluate_portfolio_at_state(
        target_spot,
        legs,
        rate,
        dividend_yield,
        elapsed_years_tn,
        target_iv_shift / 100.0,
        net_entry,
        position_scale,
        min_volatility,
    )
    if base_t0 is None or target_snap is None:
        return {"name": name, "input": inp, "expected": invalid_result()}

    cells: list[list[dict[str, Any]]] = []
    min_pnl = math.inf
    max_pnl = -math.inf
    for row_index, iv_shift in enumerate(WHAT_IF_IV_SHIFT_STEPS):
        row_cells: list[dict[str, Any]] = []
        for col_index, cell_spot in enumerate(spot_grid):
            snapshot = evaluate_portfolio_at_state(
                cell_spot,
                legs,
                rate,
                dividend_yield,
                elapsed_years_tn,
                iv_shift / 100.0,
                net_entry,
                position_scale,
                min_volatility,
            )
            pnl = snapshot["pnlUsd"] if snapshot is not None else math.nan
            clamped = snapshot["ivClampedLegs"] if snapshot is not None else math.nan
            if math.isfinite(pnl):
                min_pnl = min(min_pnl, pnl)
                max_pnl = max(max_pnl, pnl)
            row_cells.append(
                {
                    "rowIndex": row_index,
                    "colIndex": col_index,
                    "ivShiftPts": iv_shift,
                    "sigmaMultiplier": WHAT_IF_SIGMA_STEPS[col_index],
                    "spot": cell_spot,
                    "pnlUsd": pnl,
                    "ivClampedLegs": clamped,
                }
            )
        cells.append(row_cells)

    delta_spot = target_spot - reference_spot
    delta_iv_pts = target_iv_shift
    delta_pnl = base_t0["deltaPerUnit"] * position_scale * delta_spot
    gamma_pnl = 0.5 * base_t0["gammaPerUnit"] * position_scale * delta_spot * delta_spot
    theta_pnl = base_t0["thetaDailyPerUnit"] * position_scale * clamped_elapsed_days
    vega_pnl = base_t0["vegaPer1PctPerUnit"] * position_scale * delta_iv_pts
    total_bsm = target_snap["pnlUsd"] - base_t0["pnlUsd"]
    total_position = target_snap["pnlUsd"]
    residual = total_bsm - (delta_pnl + gamma_pnl + theta_pnl + vega_pnl)

    return {
        "name": name,
        "input": inp,
        "expected": {
            "isValid": True,
            "oneSigmaMoveAbs": one_sigma,
            "sigmaMultipliers": list(WHAT_IF_SIGMA_STEPS),
            "ivShiftGridPts": list(WHAT_IF_IV_SHIFT_STEPS),
            "spotGrid": spot_grid,
            "cells": cells,
            "minPnlUsd": min_pnl if math.isfinite(min_pnl) else "NaN",
            "maxPnlUsd": max_pnl if math.isfinite(max_pnl) else "NaN",
            "attribution": {
                "referenceSpot": reference_spot,
                "targetSpot": target_spot,
                "deltaSpot": delta_spot,
                "deltaIvPts": delta_iv_pts,
                "elapsedDays": clamped_elapsed_days,
                "totalBsmPnl": total_bsm,
                "totalPositionPnl": total_position,
                "deltaPnl": delta_pnl,
                "gammaPnl": gamma_pnl,
                "thetaPnl": theta_pnl,
                "vegaPnl": vega_pnl,
                "residualPnl": residual,
            },
        },
    }


def build_iron_condor_legs(spot: float, rate: float, dividend_yield: float, dte_days: float) -> list[dict[str, Any]]:
    t = dte_days / 365.0
    spec = [
        ("put", 90.0, 1, 0.26),
        ("put", 95.0, -1, 0.25),
        ("call", 105.0, -1, 0.24),
        ("call", 110.0, 1, 0.25),
    ]
    legs: list[dict[str, Any]] = []
    for contract_type, strike, quantity, iv in spec:
        entry = bsm_greeks(spot, strike, t, rate, dividend_yield, iv, contract_type)["price"]
        legs.append(
            {
                "contractType": contract_type,
                "strike": strike,
                "quantity": quantity,
                "iv": iv,
                "timeToExpiry": t,
                "entryPrice": entry,
            }
        )
    return legs


def build_heatmap_cases() -> list[dict[str, Any]]:
    spot = 100.0
    rate = 0.045
    dividend_yield = 0.015
    legs = build_iron_condor_legs(spot, rate, dividend_yield, 30.0)

    return [
        build_heatmap_case(
            name="iron_condor_30d_grid_and_taylor",
            inp={
                "referenceSpot": spot,
                "legs": legs,
                "rate": rate,
                "dividendYield": dividend_yield,
                "elapsedDays": 10.0,
                "horizonDte": 30.0,
                "targetSpot": 105.0,
                "targetIvShiftPts": -10.0,
            },
        ),
        build_heatmap_case(
            name="zero_shock_identity",
            inp={
                "referenceSpot": spot,
                "legs": legs,
                "rate": rate,
                "dividendYield": dividend_yield,
                "elapsedDays": 0.0,
                "horizonDte": 30.0,
                "targetSpot": spot,
                "targetIvShiftPts": 0.0,
            },
        ),
        build_heatmap_case(
            name="selected_cell_row1_col5_target",
            inp={
                "referenceSpot": spot,
                "legs": legs,
                "rate": rate,
                "dividendYield": dividend_yield,
                "elapsedDays": 10.0,
                "horizonDte": 30.0,
                "selectedCell": {"row": 1, "col": 5},
            },
        ),
        build_heatmap_case(
            name="one_sigma_override_and_positive_shift",
            inp={
                "referenceSpot": spot,
                "legs": legs,
                "rate": rate,
                "dividendYield": dividend_yield,
                "elapsedDays": 5.0,
                "horizonDte": 30.0,
                "targetSpot": 95.0,
                "targetIvShiftPts": 15.0,
                "oneSigmaMoveAbs": 6.5,
            },
        ),
        build_heatmap_case(
            name="invalid_no_legs",
            inp={
                "referenceSpot": spot,
                "legs": [],
                "rate": rate,
                "dividendYield": dividend_yield,
                "elapsedDays": 10.0,
                "horizonDte": 30.0,
            },
        ),
        build_heatmap_case(
            name="invalid_selected_cell_out_of_range",
            inp={
                "referenceSpot": spot,
                "legs": legs,
                "rate": rate,
                "dividendYield": dividend_yield,
                "elapsedDays": 10.0,
                "horizonDte": 30.0,
                "selectedCell": {"row": 7, "col": 0},
            },
        ),
    ]


def build_vanna_regime_cases() -> list[dict[str, Any]]:
    inputs = [
        {"name": "supportive", "netVex": 0.005},
        {"name": "pressure", "netVex": -0.005},
        {"name": "zero_neutral", "netVex": 0.0},
        {"name": "tiny_positive_neutral", "netVex": 1e-7},
        {"name": "epsilon_boundary_neutral", "netVex": 1e-6},
        {"name": "epsilon_boundary_negative_neutral", "netVex": -1e-6},
        {"name": "nan_neutral", "netVex": "NaN"},
        {"name": "custom_epsilon_neutral", "netVex": 1e-3, "neutralEpsilon": 1e-2},
        {"name": "custom_epsilon_pressure", "netVex": -2e-2, "neutralEpsilon": 1e-2},
    ]
    cases = []
    for item in inputs:
        net_vex = math.nan if item["netVex"] == "NaN" else float(item["netVex"])
        epsilon = float(item.get("neutralEpsilon", 1e-6))
        cases.append(
            {
                "name": item["name"],
                "netVex": item["netVex"],
                "neutralEpsilon": item.get("neutralEpsilon"),
                "expected": classify_vanna_regime(net_vex, epsilon),
            }
        )
    return cases


def build_charm_pin_cases() -> list[dict[str, Any]]:
    inputs = [
        {"name": "unique_max", "spot": 100.0, "rows": [{"strike": 90.0, "netCharmExposure": -5000.0}, {"strike": 100.0, "netCharmExposure": 8000.0}, {"strike": 110.0, "netCharmExposure": -6000.0}]},
        {"name": "tie_same_distance_lower_strike", "spot": 100.0, "rows": [{"strike": 90.0, "netCharmExposure": -7000.0}, {"strike": 110.0, "netCharmExposure": 7000.0}]},
        {"name": "tie_nearest_spot_wins", "spot": 100.0, "rows": [{"strike": 95.0, "netCharmExposure": 5000.0}, {"strike": 115.0, "netCharmExposure": -5000.0}, {"strike": 120.0, "netCharmExposure": 3000.0}]},
        {"name": "empty_rows_nan", "spot": 100.0, "rows": []},
        {"name": "all_zero_nan", "spot": 100.0, "rows": [{"strike": 100.0, "netCharmExposure": 0.0}, {"strike": 105.0, "netCharmExposure": 0.0}]},
        {"name": "nan_row_skipped", "spot": 100.0, "rows": [{"strike": 100.0, "netCharmExposure": "NaN"}, {"strike": 105.0, "netCharmExposure": 2000.0}]},
        {"name": "negative_max_abs", "spot": 100.0, "rows": [{"strike": 95.0, "netCharmExposure": -9000.0}, {"strike": 105.0, "netCharmExposure": 1000.0}]},
    ]
    cases = []
    for item in inputs:
        rows = [
            {
                "strike": row["strike"],
                "netCharmExposure": math.nan if row["netCharmExposure"] == "NaN" else row["netCharmExposure"],
            }
            for row in item["rows"]
        ]
        pin = compute_charm_pin_strike(rows, item["spot"])
        cases.append(
            {
                "name": item["name"],
                "spot": item["spot"],
                "rows": item["rows"],
                "expected": pin if math.isfinite(pin) else "NaN",
            }
        )
    return cases


def main() -> None:
    fixture = {
        "meta": {
            "generator": "tools/gen_options_pieza50_reference.py",
            "tolerance": 1e-9,
        },
        "vannaRegimeCases": build_vanna_regime_cases(),
        "charmPinCases": build_charm_pin_cases(),
        "dealerExposureCases": build_dealer_exposure_cases(),
        "skewRegimeCases": build_skew_regime_cases(),
        "heatmapCases": build_heatmap_cases(),
    }

    out_path = Path(__file__).resolve().parent.parent / "fixtures" / "options_pieza50_reference.json"
    out_path.write_text(json.dumps(fixture, indent=2), encoding="utf-8")
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
