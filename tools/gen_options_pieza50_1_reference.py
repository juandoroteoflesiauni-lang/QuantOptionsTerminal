#!/usr/bin/env python3
"""
Generador de referencia independiente en Python para la Pieza 50.1 (fixes de
producción US/OPRA en modo EOD_CIERRE):

  1. Selección curada de ≤6 vencimientos US (`selectCuratedUsExpirations`):
     front, 2 semanales (2–13 DTE), mensual líquido (14–45 DTE), siguiente
     (> mensual, ≤60 DTE) y `requestedExpiration` explícito, deduplicado y
     en orden ascendente.
  2. Alineación del spot de valuación OPRA (`resolveOpraAlignedSpot`): cierre RTH
     vs spot implícito por paridad Put-Call cuando el mercado está cerrado o el
     feed divergente supera el umbral (25 bps por defecto).
  3. Variación % diaria de contratos (`resolveContractChangePct`).
  4. Escalera de spreads verticales en modo `EOD_MID` (mids de cierre sin cruce
     agresivo) y `LIVE_CROSS` (comportamiento previo preservado).
  5. Rescate de IV ITM vía contraparte OTM (paridad Put-Call) o IV ATM
     (`resolveParityItmRescueIv`).

Implementación pura con math.erfc/math.exp/math.log/math.sqrt sin copiar la
lógica TypeScript. Salida: fixtures/options_pieza50_1_reference.json.
"""

from __future__ import annotations

import json
import math
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

SECONDS_PER_DAY = 86_400
DEFAULT_DIVERGENCE_THRESHOLD = 0.0025
DEFAULT_MIN_SPREAD_DEBIT = 0.10
DEFAULT_MAX_BID_ASK_PCT_OF_MID = 35.0
ET = ZoneInfo("America/New_York")


def norm_cdf(x: float) -> float:
    return 0.5 * math.erfc(-x / math.sqrt(2.0))


def et_today(now_sec: int) -> str:
    return datetime.fromtimestamp(now_sec, tz=ET).strftime("%Y-%m-%d")


def iso_day_number(iso: str) -> float:
    try:
        d = datetime.strptime(iso, "%Y-%m-%d")
    except ValueError:
        return math.nan
    return datetime(d.year, d.month, d.day, tzinfo=ZoneInfo("UTC")).timestamp() / SECONDS_PER_DAY


def calendar_dte_et(expiry_date: str, now_sec: int) -> float:
    today = et_today(now_sec)
    diff = iso_day_number(expiry_date) - iso_day_number(today)
    return diff if math.isfinite(diff) and diff >= 0 else math.nan


def add_days_et(date: str, days: int) -> str:
    d = datetime.strptime(date, "%Y-%m-%d")
    from datetime import timedelta

    return (d + timedelta(days=days)).strftime("%Y-%m-%d")


# ---------------------------------------------------------------------------
# 1) Selección curada de vencimientos
# ---------------------------------------------------------------------------


def select_curated_us_expirations(
    contracts: list[dict[str, Any]],
    spot: float,
    now_sec: int,
    requested: str | None,
) -> dict[str, Any]:
    by_date: dict[str, dict[str, Any]] = {}
    for c in contracts:
        date = c["expirationDate"]
        expiry_sec = c["expiryUtcSec"]
        if not expiry_sec > now_sec + 60:
            continue
        if len(date) != 10 or date[4] != "-" or date[7] != "-":
            continue
        near = math.isfinite(spot) and spot > 0 and abs(c["strikePrice"] - spot) <= spot * 0.15
        existing = by_date.get(date)
        if existing is not None:
            if near:
                existing["nearAtmLiquidity"] += 1
            continue
        dte_et = calendar_dte_et(date, now_sec)
        approx_days = max(0, math.floor((expiry_sec - now_sec) / SECONDS_PER_DAY))
        days = dte_et if math.isfinite(dte_et) and abs(dte_et - approx_days) <= 2 else approx_days
        by_date[date] = {
            "expirationDate": date,
            "daysToExpiry": days,
            "nearAtmLiquidity": 1 if near else 0,
            "expiryUtcSec": expiry_sec,
        }

    all_dates = sorted(
        by_date.values(), key=lambda d: (d["expiryUtcSec"], d["expirationDate"])
    )
    requested = (requested or "").strip()
    if not all_dates and requested == "":
        return {"curatedExpirationDates": [], "reason": "NO_REFERENCE_EXPIRATIONS"}

    selected: set[str] = set()
    reason: str | None = None
    if requested != "":
        if requested in by_date:
            selected.add(requested)
        else:
            dte_requested = calendar_dte_et(requested, now_sec)
            if math.isfinite(dte_requested) and dte_requested >= 0:
                selected.add(requested)
            else:
                reason = f"REQUESTED_EXPIRATION_INVALID:{requested}"

    if all_dates:
        selected.add(all_dates[0]["expirationDate"])

    weeklies = [d for d in all_dates if 2 <= d["daysToExpiry"] <= 13]
    taken = 0
    last_dte: float | None = None
    for w in weeklies:
        if taken >= 2:
            break
        if last_dte is not None and w["daysToExpiry"] - last_dte < 2:
            continue
        selected.add(w["expirationDate"])
        last_dte = w["daysToExpiry"]
        taken += 1

    def by_liquidity(d: dict[str, Any]) -> tuple[float, float, str]:
        return (-d["nearAtmLiquidity"], d["daysToExpiry"], d["expirationDate"])

    monthly_candidates = sorted(
        [d for d in all_dates if 14 <= d["daysToExpiry"] <= 45], key=by_liquidity
    )
    monthly = monthly_candidates[0] if monthly_candidates else None
    if monthly is not None:
        selected.add(monthly["expirationDate"])

    next_floor = monthly["daysToExpiry"] if monthly is not None else 30
    next_candidates = sorted(
        [d for d in all_dates if next_floor < d["daysToExpiry"] <= 60], key=by_liquidity
    )
    if next_candidates:
        selected.add(next_candidates[0]["expirationDate"])

    curated = sorted(selected)[:6]
    if not curated:
        reason_out = "NO_CURATED_EXPIRATIONS"
    elif requested != "" and requested not in by_date and requested in selected:
        reason_out = f"REQUESTED_EXPIRATION_OUTSIDE_REFERENCE:{requested}"
    else:
        reason_out = reason
    return {"curatedExpirationDates": curated, "reason": reason_out}


def build_curated_cases() -> list[dict[str, Any]]:
    now_sec = 1_770_000_000
    spot = 100.0

    # Patrón diario/semanal/mensual: días 0..59 con liquidez decreciente.
    day_specs: list[tuple[int, int]] = [
        (0, 40), (1, 35), (2, 30), (3, 25), (6, 22), (7, 20), (10, 18), (13, 16),
        (17, 30), (20, 28), (24, 26), (27, 25), (31, 22), (34, 45), (38, 20),
        (42, 18), (45, 16), (49, 24), (52, 22), (56, 20), (59, 18),
    ]
    contracts: list[dict[str, Any]] = []
    for days, atm_count in day_specs:
        date = add_days_et(et_today(now_sec), days)
        expiry_sec = now_sec + days * SECONDS_PER_DAY
        for i in range(atm_count + 4):
            strike = spot if i < atm_count else spot + (i - atm_count + 1) * 5.0
            for contract_type in ("call", "put"):
                contracts.append(
                    {
                        "ticker": f"O:SPY{date}{contract_type[0].upper()}{i}",
                        "expirationDate": date,
                        "expiryUtcSec": expiry_sec,
                        "strikePrice": strike,
                        "contractType": contract_type,
                    }
                )

    requested_inside = add_days_et(et_today(now_sec), 34)
    requested_outside = add_days_et(et_today(now_sec), 62)

    cases_input: list[dict[str, Any]] = [
        {"name": "spy_like_21_dates_no_request", "spot": spot, "nowSec": now_sec, "requested": None, "contracts": contracts},
        {"name": "requested_inside_includes_34d", "spot": spot, "nowSec": now_sec, "requested": requested_inside, "contracts": contracts},
        {"name": "requested_outside_reference_included", "spot": spot, "nowSec": now_sec, "requested": requested_outside, "contracts": contracts},
        {"name": "empty_index_with_valid_request", "spot": spot, "nowSec": now_sec, "requested": requested_inside, "contracts": []},
        {"name": "empty_index_no_request", "spot": spot, "nowSec": now_sec, "requested": None, "contracts": []},
        {"name": "invalid_request_falls_back", "spot": spot, "nowSec": now_sec, "requested": "not-a-date", "contracts": contracts},
    ]
    return [
        {
            "name": case["name"],
            "spot": case["spot"],
            "nowSec": case["nowSec"],
            "requested": case["requested"],
            "contracts": case["contracts"],
            "expected": select_curated_us_expirations(
                case["contracts"], case["spot"], case["nowSec"], case["requested"]
            ),
        }
        for case in cases_input
    ]


# ---------------------------------------------------------------------------
# 2) Alineación del spot de valuación OPRA
# ---------------------------------------------------------------------------


def resolve_opra_aligned_spot(
    feed_spot: float,
    rth_close: float,
    parity_implied: float,
    market_closed: bool,
    threshold: float = DEFAULT_DIVERGENCE_THRESHOLD,
) -> dict[str, Any]:
    feed = feed_spot if math.isfinite(feed_spot) and feed_spot > 0 else math.nan
    rth = rth_close if math.isfinite(rth_close) and rth_close > 0 else math.nan
    parity = parity_implied if math.isfinite(parity_implied) and parity_implied > 0 else math.nan

    def bps(chosen: float) -> float:
        return abs(feed - chosen) / chosen * 10_000

    if not math.isfinite(feed):
        if math.isfinite(parity):
            return {"valuationSpot": parity, "headerSpot": "NaN", "source": "PARITY_IMPLIED", "divergenceBps": "NaN"}
        if math.isfinite(rth):
            return {"valuationSpot": rth, "headerSpot": "NaN", "source": "RTH_CLOSE", "divergenceBps": "NaN"}
        return {"valuationSpot": "NaN", "headerSpot": "NaN", "source": "FEED", "divergenceBps": "NaN"}

    parity_div = abs(feed - parity) / parity if math.isfinite(parity) else math.nan
    triggers = market_closed or (math.isfinite(parity_div) and parity_div > threshold)
    if not triggers:
        return {
            "valuationSpot": feed,
            "headerSpot": feed,
            "source": "FEED",
            "divergenceBps": parity_div * 10_000 if math.isfinite(parity_div) else "NaN",
        }
    if math.isfinite(rth) and math.isfinite(parity):
        choose_parity = abs(rth - parity) <= abs(rth - feed)
        chosen = parity if choose_parity else rth
        return {
            "valuationSpot": chosen,
            "headerSpot": feed,
            "source": "PARITY_IMPLIED" if choose_parity else "RTH_CLOSE",
            "divergenceBps": bps(chosen),
        }
    if math.isfinite(parity):
        return {"valuationSpot": parity, "headerSpot": feed, "source": "PARITY_IMPLIED", "divergenceBps": bps(parity)}
    if math.isfinite(rth):
        return {"valuationSpot": rth, "headerSpot": feed, "source": "RTH_CLOSE", "divergenceBps": bps(rth)}
    return {
        "valuationSpot": feed,
        "headerSpot": feed,
        "source": "FEED_CLOSED_NO_REF",
        "divergenceBps": parity_div * 10_000 if math.isfinite(parity_div) else "NaN",
    }


def build_opra_aligned_spot_cases() -> list[dict[str, Any]]:
    inputs: list[dict[str, Any]] = [
        {"name": "blueprint_after_hours_vs_rth_and_parity", "feedSpot": 689.81, "rthCloseSpot": 693.15, "parityImpliedSpot": 693.20, "marketClosed": True},
        {"name": "closed_consistent_prefers_parity", "feedSpot": 100.5, "rthCloseSpot": 100.0, "parityImpliedSpot": 100.02, "marketClosed": True},
        {"name": "closed_no_references_keeps_feed", "feedSpot": 100.0, "rthCloseSpot": "NaN", "parityImpliedSpot": "NaN", "marketClosed": True},
        {"name": "open_small_divergence_keeps_feed", "feedSpot": 100.0, "rthCloseSpot": 99.9, "parityImpliedSpot": 100.1, "marketClosed": False},
        {"name": "open_large_divergence_triggers_parity", "feedSpot": 100.0, "rthCloseSpot": 100.8, "parityImpliedSpot": 101.0, "marketClosed": False},
        {"name": "missing_feed_uses_parity", "feedSpot": "NaN", "rthCloseSpot": 100.0, "parityImpliedSpot": 100.05, "marketClosed": True},
        {"name": "custom_threshold_triggers", "feedSpot": 100.0, "rthCloseSpot": 100.6, "parityImpliedSpot": 100.2, "marketClosed": False, "divergenceThresholdRel": 0.001},
    ]
    out = []
    for c in inputs:
        feed = math.nan if c["feedSpot"] == "NaN" else c["feedSpot"]
        rth = math.nan if c["rthCloseSpot"] == "NaN" else c["rthCloseSpot"]
        parity = math.nan if c["parityImpliedSpot"] == "NaN" else c["parityImpliedSpot"]
        expected = resolve_opra_aligned_spot(
            feed, rth, parity, c["marketClosed"], c.get("divergenceThresholdRel", DEFAULT_DIVERGENCE_THRESHOLD)
        )
        out.append({"name": c["name"], "input": c, "expected": expected})
    return out


# ---------------------------------------------------------------------------
# 3) Variación % diaria de contratos
# ---------------------------------------------------------------------------


def resolve_contract_change_pct(change_pct: float, previous_close: float, reference_price: float) -> float | None:
    if math.isfinite(change_pct):
        return change_pct
    if math.isfinite(previous_close) and previous_close > 0 and math.isfinite(reference_price) and reference_price > 0:
        return (reference_price - previous_close) / previous_close * 100.0
    return None


def build_change_pct_cases() -> list[dict[str, Any]]:
    inputs = [
        {"name": "direct_change_percent", "changePercent": 12.4, "previousClose": 10.0, "referencePrice": 11.24},
        {"name": "derived_from_previous_close_close", "changePercent": "NaN", "previousClose": 10.0, "referencePrice": 11.5},
        {"name": "derived_from_previous_close_last", "changePercent": "NaN", "previousClose": 8.0, "referencePrice": 7.6},
        {"name": "missing_previous_close_null", "changePercent": "NaN", "previousClose": 0.0, "referencePrice": 11.5},
        {"name": "missing_reference_null", "changePercent": "NaN", "previousClose": 10.0, "referencePrice": "NaN"},
    ]
    out = []
    for c in inputs:
        change = math.nan if c["changePercent"] == "NaN" else c["changePercent"]
        prev = c["previousClose"]
        ref = math.nan if c["referencePrice"] == "NaN" else c["referencePrice"]
        expected = resolve_contract_change_pct(change, prev, ref)
        out.append({"name": c["name"], "input": c, "expected": expected})
    return out


# ---------------------------------------------------------------------------
# 4) Spreads verticales EOD_MID / LIVE_CROSS
# ---------------------------------------------------------------------------


def leg_bid_ask_pct(bid: float, ask: float) -> float:
    if not (math.isfinite(bid) and bid > 0) or not (math.isfinite(ask) and ask > 0) or ask < bid:
        return math.nan
    mid = 0.5 * (bid + ask)
    return (ask - bid) / mid * 100.0 if mid > 0 else math.nan


def classify_semaphore(pct: float) -> str:
    if not math.isfinite(pct) or pct < 0:
        return "NO_DATA"
    if pct < 5:
        return "GREEN"
    if pct <= 15:
        return "YELLOW"
    return "RED"


def resolve_eod_mid_price(leg: dict[str, float]) -> tuple[float, bool]:
    bid, ask, last = leg["bid"], leg["ask"], leg["last"]
    if math.isfinite(bid) and bid > 0 and math.isfinite(ask) and ask > 0 and ask >= bid:
        mid = 0.5 * (bid + ask)
        if mid > 0:
            return mid, False
    if math.isfinite(last) and last > 0:
        return last, True
    if math.isfinite(bid) and bid > 0:
        return bid, True
    if math.isfinite(ask) and ask > 0:
        return ask, True
    return math.nan, False


def compute_vertical_spread_ref(inp: dict[str, Any]) -> dict[str, Any]:
    side = inp["side"]
    long_leg = inp["longLeg"]
    short_leg = inp["shortLeg"]
    spot = inp["spot"]
    days = inp["daysToExpiry"]
    rate = inp["rateDec"]
    atm_iv = inp["atmIvDec"]
    pricing_mode = inp.get("pricingMode", "LIVE_CROSS")
    min_debit = inp.get("minDebit", DEFAULT_MIN_SPREAD_DEBIT)
    max_ba = inp.get("maxBidAskPctOfMid", DEFAULT_MAX_BID_ASK_PCT_OF_MID)

    width = abs(short_leg["strike"] - long_leg["strike"])
    long_ba = leg_bid_ask_pct(long_leg["bid"], long_leg["ask"])
    short_ba = leg_bid_ask_pct(short_leg["bid"], short_leg["ask"])
    ba_mid = 0.5 * (long_ba + short_ba) if math.isfinite(long_ba) and math.isfinite(short_ba) else math.nan
    semaphore = classify_semaphore(ba_mid)

    def invalid(reason: str, long_price: float, short_price: float, long_ref: bool, short_ref: bool) -> dict[str, Any]:
        return {
            "valid": False,
            "reason": reason,
            "width": width,
            "longPrice": long_price,
            "shortPrice": short_price,
            "longUsesEodRef": long_ref,
            "shortUsesEodRef": short_ref,
            "debit": None,
            "maxProfit": None,
            "rewardRiskRatio": None,
            "breakeven": None,
            "breakevenDistPct": None,
            "probAtBreakevenPct": None,
            "edgePct": None,
            "bidAskPctOfMid": ba_mid if math.isfinite(ba_mid) else None,
            "liquiditySemaphore": semaphore,
            "eligibleForAutoRanking": False,
        }

    if pricing_mode == "EOD_MID":
        long_price, long_ref = resolve_eod_mid_price(long_leg)
        short_price, short_ref = resolve_eod_mid_price(short_leg)
    else:
        long_price = long_leg["ask"] if (long_leg["bid"] > 0 and long_leg["ask"] > 0 and long_leg["ask"] >= long_leg["bid"]) else math.nan
        short_price = short_leg["bid"] if (short_leg["bid"] > 0 and short_leg["ask"] > 0 and short_leg["ask"] >= short_leg["bid"]) else math.nan
        long_ref = False
        short_ref = False

    if not (math.isfinite(width) and width > 0):
        return invalid("WIDTH_NOT_POSITIVE", long_price, short_price, long_ref, short_ref)
    if pricing_mode == "LIVE_CROSS":
        long_valid = long_leg["bid"] > 0 and long_leg["ask"] > 0 and long_leg["ask"] >= long_leg["bid"]
        short_valid = short_leg["bid"] > 0 and short_leg["ask"] > 0 and short_leg["ask"] >= short_leg["bid"]
        if not long_valid:
            return invalid("LONG_LEG_NO_POSITIVE_BID", long_price, short_price, False, False)
        if not short_valid:
            return invalid("SHORT_LEG_NO_POSITIVE_BID", long_price, short_price, False, False)
    if not math.isfinite(long_price):
        return invalid("LONG_PRICE_NOT_CALCULABLE", long_price, short_price, long_ref, short_ref)
    if not math.isfinite(short_price):
        return invalid("SHORT_PRICE_NOT_CALCULABLE", long_price, short_price, long_ref, short_ref)
    if side == "CALL" and short_leg["strike"] <= long_leg["strike"]:
        return invalid("CALL_STRIKES_NOT_ASCENDING", long_price, short_price, long_ref, short_ref)
    if side == "PUT" and short_leg["strike"] >= long_leg["strike"]:
        return invalid("PUT_STRIKES_NOT_DESCENDING", long_price, short_price, long_ref, short_ref)

    debit = long_price - short_price
    if not debit > 0:
        return invalid("DEBIT_NOT_POSITIVE", long_price, short_price, long_ref, short_ref)
    if debit < min_debit - 1e-12:
        return invalid("DEBIT_BELOW_MIN_FLOOR", long_price, short_price, long_ref, short_ref)
    if debit >= width:
        return invalid("DEBIT_NOT_LESS_THAN_WIDTH", long_price, short_price, long_ref, short_ref)
    if pricing_mode == "LIVE_CROSS" and (not math.isfinite(ba_mid) or ba_mid > max_ba + 1e-9):
        return invalid("EXCESSIVE_BID_ASK_SPREAD", long_price, short_price, long_ref, short_ref)

    max_profit = width - debit
    ratio = max_profit / debit
    breakeven = long_leg["strike"] + debit if side == "CALL" else long_leg["strike"] - debit
    be_dist = (breakeven - spot) / spot * 100.0 if math.isfinite(spot) and spot > 0 else math.nan
    prob_pct = math.nan
    edge_pct = math.nan
    if math.isfinite(spot) and spot > 0 and breakeven > 0 and math.isfinite(atm_iv) and atm_iv > 0 and days > 0:
        t_exp = days / 365.0
        denom = atm_iv * math.sqrt(t_exp)
        d2 = (math.log(spot / breakeven) + (rate - 0.5 * atm_iv * atm_iv) * t_exp) / denom
        prob = norm_cdf(d2) if side == "CALL" else norm_cdf(-d2)
        if math.isfinite(prob):
            prob_pct = prob * 100.0
            edge_pct = (prob - debit / width) * 100.0

    eligible = (
        debit >= min_debit - 1e-12
        if pricing_mode == "EOD_MID"
        else debit >= min_debit - 1e-12
        and math.isfinite(ba_mid)
        and ba_mid <= max_ba + 1e-9
        and max(long_ba, short_ba) <= max_ba + 1e-9
    )
    return {
        "valid": True,
        "reason": None,
        "width": width,
        "longPrice": long_price,
        "shortPrice": short_price,
        "longUsesEodRef": long_ref,
        "shortUsesEodRef": short_ref,
        "debit": debit,
        "maxProfit": max_profit,
        "rewardRiskRatio": ratio,
        "breakeven": breakeven,
        "breakevenDistPct": be_dist if math.isfinite(be_dist) else None,
        "probAtBreakevenPct": prob_pct if math.isfinite(prob_pct) else None,
        "edgePct": edge_pct if math.isfinite(edge_pct) else None,
        "bidAskPctOfMid": ba_mid if math.isfinite(ba_mid) else None,
        "liquiditySemaphore": semaphore,
        "eligibleForAutoRanking": eligible,
    }


def build_spread_cases() -> list[dict[str, Any]]:
    spot = 693.20
    rate = 0.043
    atm_iv = 0.22
    days = 17
    width_step = 1.0

    # Puntas de cierre: bid=0 en patas profundas y spreads anchos de fin de semana.
    def leg(strike: float, bid: float, ask: float, last: float) -> dict[str, float]:
        return {"strike": strike, "bid": bid, "ask": ask, "last": last}

    ladders = [
        {"name": "eod_call_1_base", "side": "CALL", "long": leg(691, 7.1, 8.3, 7.6), "short": leg(692, 6.3, 7.5, 6.8)},
        {"name": "eod_call_2_bases", "side": "CALL", "long": leg(691, 7.1, 8.3, 7.6), "short": leg(693, 5.2, 6.4, 5.7)},
        {"name": "eod_call_3_bases", "side": "CALL", "long": leg(691, 7.1, 8.3, 7.6), "short": leg(694, 4.1, 5.3, 4.6)},
        {"name": "eod_call_4_bases_stale_short", "side": "CALL", "long": leg(691, 7.1, 8.3, 7.6), "short": leg(695, 0.0, 0.4, 3.8)},
        {"name": "eod_put_1_base", "side": "PUT", "long": leg(695, 7.0, 8.2, 7.5), "short": leg(694, 6.2, 7.4, 6.7)},
        {"name": "eod_put_2_bases", "side": "PUT", "long": leg(695, 7.0, 8.2, 7.5), "short": leg(693, 5.1, 6.3, 5.6)},
        {"name": "eod_put_3_bases", "side": "PUT", "long": leg(695, 7.0, 8.2, 7.5), "short": leg(692, 4.3, 5.5, 4.9)},
        {"name": "eod_put_4_bases_stale_long", "side": "PUT", "long": leg(695, 0.0, 0.3, 7.4), "short": leg(691, 3.0, 4.2, 3.5)},
        {"name": "eod_missing_price_both", "side": "CALL", "long": leg(691, 0.0, 0.0, 0.0), "short": leg(694, 0.0, 0.0, 0.0)},
        {"name": "eod_debit_over_width", "side": "CALL", "long": leg(691, 1.4, 1.6, 1.5), "short": leg(692, 0.4, 0.5, 0.45)},
    ]

    cases: list[dict[str, Any]] = []
    for ladder in ladders:
        base_input = {
            "side": ladder["side"],
            "longLeg": ladder["long"],
            "shortLeg": ladder["short"],
            "spot": spot,
            "daysToExpiry": days,
            "rateDec": rate,
            "atmIvDec": atm_iv,
        }
        cases.append(
            {
                "name": f"{ladder['name']}_eod_mid",
                "input": {**base_input, "pricingMode": "EOD_MID"},
                "expected": compute_vertical_spread_ref({**base_input, "pricingMode": "EOD_MID"}),
            }
        )
        cases.append(
            {
                "name": f"{ladder['name']}_live_cross",
                "input": {**base_input, "pricingMode": "LIVE_CROSS"},
                "expected": compute_vertical_spread_ref({**base_input, "pricingMode": "LIVE_CROSS"}),
            }
        )

    # LIVE_CROSS con puntas válidas pero ensanchadas de cierre → EXCESSIVE_BID_ASK_SPREAD.
    wide_input = {
        "side": "CALL",
        "longLeg": leg(691, 5.0, 7.0, 6.0),
        "shortLeg": leg(695, 3.4, 5.4, 4.4),
        "spot": spot,
        "daysToExpiry": days,
        "rateDec": rate,
        "atmIvDec": atm_iv,
        "pricingMode": "LIVE_CROSS",
    }
    cases.append(
        {
            "name": "live_cross_wide_spread_excessive",
            "input": wide_input,
            "expected": compute_vertical_spread_ref(wide_input),
        }
    )
    return cases


# ---------------------------------------------------------------------------
# 5) Rescate de IV ITM
# ---------------------------------------------------------------------------


def resolve_parity_itm_rescue_iv(
    counterpart_otm_iv: float,
    atm_iv: float,
    moneyness_abs: float,
    max_moneyness_abs: float = 0.15,
) -> dict[str, Any]:
    if math.isfinite(counterpart_otm_iv) and counterpart_otm_iv > 0 and counterpart_otm_iv < 9.99:
        return {"iv": counterpart_otm_iv, "source": "PARITY_OTM"}
    if (
        math.isfinite(moneyness_abs)
        and moneyness_abs <= max_moneyness_abs
        and math.isfinite(atm_iv)
        and atm_iv > 0
        and atm_iv < 9.99
    ):
        return {"iv": atm_iv, "source": "ATM_RESCUE"}
    return {"iv": None, "source": None}


def build_parity_rescue_cases() -> list[dict[str, Any]]:
    inputs = [
        {"name": "counterpart_otm_wins", "counterpartOtmIv": 0.422, "atmIv": 0.30, "moneynessAbs": 0.036},
        {"name": "atm_rescue_within_15pct", "counterpartOtmIv": "NaN", "atmIv": 0.42, "moneynessAbs": 0.10},
        {"name": "capped_counterpart_uses_atm", "counterpartOtmIv": 9.99, "atmIv": 0.38, "moneynessAbs": 0.12},
        {"name": "deep_itm_no_counterpart_null", "counterpartOtmIv": "NaN", "atmIv": 0.40, "moneynessAbs": 0.20},
        {"name": "no_data_null", "counterpartOtmIv": "NaN", "atmIv": "NaN", "moneynessAbs": 0.05},
        {"name": "custom_window_rejects", "counterpartOtmIv": "NaN", "atmIv": 0.35, "moneynessAbs": 0.12, "maxMoneynessAbs": 0.10},
    ]
    out = []
    for c in inputs:
        counterpart = math.nan if c["counterpartOtmIv"] == "NaN" else c["counterpartOtmIv"]
        atm = math.nan if c["atmIv"] == "NaN" else c["atmIv"]
        expected = resolve_parity_itm_rescue_iv(
            counterpart, atm, c["moneynessAbs"], c.get("maxMoneynessAbs", 0.15)
        )
        out.append({"name": c["name"], "input": c, "expected": expected})
    return out


def json_sanitize(value: Any) -> Any:
    """Convierte floats no finitos a la cadena `"NaN"` (convención del repositorio)."""
    if isinstance(value, float):
        return value if math.isfinite(value) else "NaN"
    if isinstance(value, dict):
        return {k: json_sanitize(v) for k, v in value.items()}
    if isinstance(value, list):
        return [json_sanitize(v) for v in value]
    return value


def main() -> None:
    fixture = {
        "meta": {
            "generator": "tools/gen_options_pieza50_1_reference.py",
            "tolerance": 1e-9,
        },
        "curatedExpirationCases": build_curated_cases(),
        "opraAlignedSpotCases": build_opra_aligned_spot_cases(),
        "changePctCases": build_change_pct_cases(),
        "spreadCases": build_spread_cases(),
        "parityRescueCases": build_parity_rescue_cases(),
    }
    out_path = Path(__file__).resolve().parent.parent / "fixtures" / "options_pieza50_1_reference.json"
    out_path.write_text(json.dumps(json_sanitize(fixture), indent=2), encoding="utf-8")
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
