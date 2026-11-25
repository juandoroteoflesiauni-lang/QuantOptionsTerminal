#!/usr/bin/env python3
"""
Oráculo independiente Python Decimal (prec=50) para US Options Intelligence Export Engine
(Pieza EXPORT-1).

Calcula de forma explícita e independiente (sin copiar la implementación TypeScript)
todas las métricas aritméticas, spreads multi-pierna, totales universo completo y reglas
de filtrado Intraday/Swing, generando `fixtures/us_options_export_reference.json`.
"""

from __future__ import annotations

import json
import math
from decimal import Decimal, getcontext
from pathlib import Path

getcontext().prec = 50

ROOT = Path(__file__).resolve().parent.parent
FIXTURE_PATH = ROOT / "fixtures" / "us_options_export_reference.json"


def d(val: object) -> Decimal:
    return Decimal(str(val))


def f_or_none(val: Decimal | None) -> float | None:
    return float(val) if val is not None else None


def compute_contract_oracle(row: dict, spot: Decimal) -> dict:
    q = row.get("quoteQuality")
    bid_raw = row.get("bid")
    ask_raw = row.get("ask")
    blocked_q = q in ("INVALID_BBO", "MISSING_BBO", "STALE_QUOTE", "NOT_EVALUATED", "EOD_CLOSE_REF")
    valid_book = (
        not blocked_q
        and bid_raw is not None
        and ask_raw is not None
        and d(bid_raw) > 0
        and d(ask_raw) >= d(bid_raw)
    )

    strike = d(row["strike"])
    ctype = row["contractType"]

    if valid_book:
        bid = d(bid_raw)
        ask = d(ask_raw)
        mid = (bid + ask) / Decimal("2")
        spread_usd = ask - bid
        spread_pct = (spread_usd / mid) * Decimal("100") if mid > 0 else None
    else:
        bid = ask = mid = spread_usd = spread_pct = None

    intrinsic = max(Decimal("0"), spot - strike) if ctype == "call" else max(Decimal("0"), strike - spot)
    time_value = (mid - intrinsic) if (valid_book and mid is not None) else None
    dist_pct = ((strike - spot) / spot) * Decimal("100")

    rel = abs(strike - spot) / spot
    if rel <= Decimal("0.0025"):
        moneyness = "ATM"
    elif ctype == "call":
        moneyness = "ITM" if strike < spot else "OTM"
    else:
        moneyness = "ITM" if strike > spot else "OTM"

    return {
        "ticker": row["ticker"],
        "contractType": ctype,
        "strike": float(strike),
        "validBook": valid_book,
        "bid": f_or_none(bid),
        "ask": f_or_none(ask),
        "mid": f_or_none(mid),
        "spreadUsd": f_or_none(spread_usd),
        "spreadPct": f_or_none(spread_pct),
        "intrinsic": float(intrinsic),
        "timeValue": f_or_none(time_value),
        "distanceSpotPct": float(dist_pct),
        "moneynessClass": moneyness,
        "openInterestKnown": row.get("openInterest") is not None and row["openInterest"] >= 0,
    }


def compute_multileg_credit_oracle(legs: list[dict], multiplier: int) -> dict:
    mult = Decimal(str(multiplier))
    for leg in legs:
        q = leg.get("quoteQuality")
        bid = leg.get("bid")
        ask = leg.get("ask")
        if (
            q in ("INVALID_BBO", "MISSING_BBO", "STALE_QUOTE", "NOT_EVALUATED", "EOD_CLOSE_REF")
            or bid is None
            or ask is None
            or d(bid) <= 0
            or d(ask) < d(bid)
        ):
            return {
                "validBboAllLegs": False,
                "midCreditPerShare": None,
                "conservativeCreditPerShare": None,
                "midCreditContractUsd": None,
                "conservativeCreditContractUsd": None,
                "widthPerShare": None,
                "widthContractUsd": None,
                "maxProfitContractUsd": None,
                "maxLossContractUsd": None,
                "riskRewardRatio": None,
                "breakevens": [],
            }

    mid_credit = Decimal("0")
    cons_credit = Decimal("0")
    puts = []
    calls = []
    for leg in legs:
        bid = d(leg["bid"])
        ask = d(leg["ask"])
        qty = d(leg["quantity"])
        mid = (bid + ask) / Decimal("2")
        if leg["side"] == "SELL":
            mid_credit += qty * mid
            cons_credit += qty * bid
        else:
            mid_credit -= qty * mid
            cons_credit -= qty * ask
        if leg["contractType"] == "put":
            puts.append(leg)
        else:
            calls.append(leg)

    put_width = Decimal("0")
    if len(puts) == 2:
        sp = next(l for l in puts if l["side"] == "SELL")
        bp = next(l for l in puts if l["side"] == "BUY")
        put_width = d(sp["strike"]) - d(bp["strike"])

    call_width = Decimal("0")
    if len(calls) == 2:
        sc = next(l for l in calls if l["side"] == "SELL")
        bc = next(l for l in calls if l["side"] == "BUY")
        call_width = d(bc["strike"]) - d(sc["strike"])

    width = max(put_width, call_width)
    max_profit_ps = cons_credit
    max_loss_ps = width - cons_credit
    rr = (max_loss_ps / max_profit_ps) if max_profit_ps > 0 else None

    bes = []
    if len(puts) == 2:
        sp = next(l for l in puts if l["side"] == "SELL")
        bes.append(float(d(sp["strike"]) - cons_credit))
    if len(calls) == 2:
        sc = next(l for l in calls if l["side"] == "SELL")
        bes.append(float(d(sc["strike"]) + cons_credit))
    bes.sort()

    return {
        "validBboAllLegs": True,
        "midCreditPerShare": float(mid_credit),
        "conservativeCreditPerShare": float(cons_credit),
        "midCreditContractUsd": float(mid_credit * mult),
        "conservativeCreditContractUsd": float(cons_credit * mult),
        "widthPerShare": float(width),
        "widthContractUsd": float(width * mult),
        "maxProfitContractUsd": float(max_profit_ps * mult),
        "maxLossContractUsd": float(max_loss_ps * mult),
        "riskRewardRatio": f_or_none(rr),
        "breakevens": bes,
    }


def compute_max_pain_oracle(by_strike: list[dict]) -> float:
    strikes = sorted(row["strike"] for row in by_strike)
    best_k = math.nan
    min_payout = None
    for cand in strikes:
        c_dec = d(cand)
        payout = Decimal("0")
        for row in by_strike:
            k_dec = d(row["strike"])
            coi = d(row.get("callOi") or 0)
            poi = d(row.get("putOi") or 0)
            if c_dec > k_dec and coi > 0:
                payout += (c_dec - k_dec) * coi
            if c_dec < k_dec and poi > 0:
                payout += (k_dec - c_dec) * poi
        if min_payout is None or payout < min_payout - Decimal("1e-9"):
            min_payout = payout
            best_k = float(cand)
    return best_k


def main() -> None:
    spot = d("585.40")
    atr14 = d("7.25")
    day_high = d("588.10")
    day_low = d("582.30")
    iv_atm_pct = d("21.60")
    rv20_pct = d("18.00")
    rv23_pct = d("17.40")
    iv25_put_pct = d("24.85")
    iv25_call_pct = d("19.15")

    contracts_input = [
        {"ticker": "O:SPY261204C00580000", "contractType": "call", "strike": 580.0, "bid": 7.10, "ask": 7.40, "lastPrice": 7.25, "volume": 1200, "openInterest": 4500, "delta": 0.68, "quoteQuality": "LIVE_VALID"},
        {"ticker": "O:SPY261204C00585000", "contractType": "call", "strike": 585.0, "bid": 3.55, "ask": 3.65, "lastPrice": 3.60, "volume": 3400, "openInterest": 0, "delta": 0.52, "quoteQuality": "LIVE_VALID"},
        {"ticker": "O:SPY261204C00595000", "contractType": "call", "strike": 595.0, "bid": 0.42, "ask": 0.48, "lastPrice": 0.45, "volume": 890, "openInterest": None, "delta": 0.19, "quoteQuality": "LIVE_VALID"},
        {"ticker": "O:SPY261204P00585000", "contractType": "put", "strike": 585.0, "bid": 3.10, "ask": 3.30, "lastPrice": 3.20, "volume": 2100, "openInterest": 5200, "delta": -0.48, "quoteQuality": "LIVE_VALID"},
        {"ticker": "O:SPY261204P00575000", "contractType": "put", "strike": 575.0, "bid": 0.85, "ask": 0.91, "lastPrice": 0.88, "volume": 1500, "openInterest": 8000, "delta": -0.22, "quoteQuality": "LIVE_VALID"},
        {"ticker": "O:SPY261204P00570000", "contractType": "put", "strike": 570.0, "bid": 1.20, "ask": 1.10, "lastPrice": 1.15, "volume": 100, "openInterest": 900, "delta": -0.15, "quoteQuality": "LIVE_VALID"},
        {"ticker": "O:SPY261204C00600000", "contractType": "call", "strike": 600.0, "bid": None, "ask": 0.25, "lastPrice": 0.20, "volume": 50, "openInterest": 300, "delta": 0.08, "quoteQuality": "MISSING_BBO"},
    ]

    credit_cases_input = [
        {
            "name": "bull_put_100x",
            "multiplier": 100,
            "legs": [
                {"contractType": "put", "side": "SELL", "strike": 580.0, "quantity": 1, "bid": 2.40, "ask": 2.50, "quoteQuality": "LIVE_VALID"},
                {"contractType": "put", "side": "BUY", "strike": 575.0, "quantity": 1, "bid": 1.40, "ask": 1.50, "quoteQuality": "LIVE_VALID"},
            ],
        },
        {
            "name": "iron_condor_50x_adjusted",
            "multiplier": 50,
            "legs": [
                {"contractType": "put", "side": "SELL", "strike": 580.0, "quantity": 1, "bid": 2.10, "ask": 2.20, "quoteQuality": "LIVE_VALID"},
                {"contractType": "put", "side": "BUY", "strike": 576.0, "quantity": 1, "bid": 1.25, "ask": 1.35, "quoteQuality": "LIVE_VALID"},
                {"contractType": "call", "side": "SELL", "strike": 592.0, "quantity": 1, "bid": 1.80, "ask": 1.90, "quoteQuality": "LIVE_VALID"},
                {"contractType": "call", "side": "BUY", "strike": 596.0, "quantity": 1, "bid": 1.00, "ask": 1.10, "quoteQuality": "LIVE_VALID"},
            ],
        },
        {
            "name": "missing_leg_bbo_invalid",
            "multiplier": 100,
            "legs": [
                {"contractType": "put", "side": "SELL", "strike": 580.0, "quantity": 1, "bid": 2.40, "ask": 2.50, "quoteQuality": "LIVE_VALID"},
                {"contractType": "put", "side": "BUY", "strike": 575.0, "quantity": 1, "bid": None, "ask": 1.50, "quoteQuality": "MISSING_BBO"},
            ],
        },
    ]

    by_strike_universe = [
        {"strike": 565.0, "callOi": 200, "putOi": 4000, "callVolume": 50, "putVolume": 900, "netGex": -2_000_000},
        {"strike": 575.0, "callOi": 800, "putOi": 8500, "callVolume": 300, "putVolume": 2200, "netGex": -6_500_000},
        {"strike": 585.0, "callOi": 5000, "putOi": 5200, "callVolume": 3400, "putVolume": 2100, "netGex": 4_200_000},
        {"strike": 595.0, "callOi": 9500, "putOi": 600, "callVolume": 4100, "putVolume": 200, "netGex": 12_800_000},
        {"strike": 605.0, "callOi": 3000, "putOi": 100, "callVolume": 500, "putVolume": 40, "netGex": 3_100_000},
    ]

    tot_call_vol = sum(d(r["callVolume"]) for r in by_strike_universe)
    tot_put_vol = sum(d(r["putVolume"]) for r in by_strike_universe)
    tot_call_oi = sum(d(r["callOi"]) for r in by_strike_universe)
    tot_put_oi = sum(d(r["putOi"]) for r in by_strike_universe)

    fixture = {
        "schema": "us_options_export_reference_v1",
        "scalarsInput": {
            "spot": float(spot),
            "atr14": float(atr14),
            "dayHigh": float(day_high),
            "dayLow": float(day_low),
            "ivAtmPct": float(iv_atm_pct),
            "rv20Pct": float(rv20_pct),
            "rv23Pct": float(rv23_pct),
            "iv25PutPct": float(iv25_put_pct),
            "iv25CallPct": float(iv25_call_pct),
        },
        "scalarsExpected": {
            "atrTravelledPct": float(((day_high - day_low) / atr14) * Decimal("100")),
            "ivRv20Ratio": float(iv_atm_pct / rv20_pct),
            "vrpVolDiffPts": float(iv_atm_pct - rv23_pct),
            "skew25PutMinusCallPts": float(iv25_put_pct - iv25_call_pct),
        },
        "contractsInput": contracts_input,
        "contractsExpected": [compute_contract_oracle(c, spot) for c in contracts_input],
        "creditCasesInput": credit_cases_input,
        "creditCasesExpected": [
            {"name": c["name"], **compute_multileg_credit_oracle(c["legs"], c["multiplier"])}
            for c in credit_cases_input
        ],
        "byStrikeUniverse": by_strike_universe,
        "flowTotalsExpected": {
            "totalCallVolume": float(tot_call_vol),
            "totalPutVolume": float(tot_put_vol),
            "totalLots": float(tot_call_vol + tot_put_vol),
            "totalCallOi": float(tot_call_oi),
            "totalPutOi": float(tot_put_oi),
            "putCallRatioVol": float(tot_put_vol / tot_call_vol),
            "putCallRatioOi": float(tot_put_oi / tot_call_oi),
            "maxPainStrike": compute_max_pain_oracle(by_strike_universe),
            "totalNetGex": sum(r["netGex"] for r in by_strike_universe),
        },
    }

    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE_PATH.write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {FIXTURE_PATH} ({FIXTURE_PATH.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
