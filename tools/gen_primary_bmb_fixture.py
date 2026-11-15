#!/usr/bin/env python3
"""Independent Python reference generator for Primary API / BMB pure quantitative math.

Generates fixtures/primary_bmb_reference.json for:
1. DLR/* futures contract valuation:
   - Price selection priority: LA -> mid(BI, OF) -> SE -> CL
   - Spot selection priority: A3500 BCRA -> DLR/SPOT -> NaN
   - Calendar maturity parsing (YYYYMMDD at 18:00:00Z) & day count
   - Direct devaluation %, implied TNA % (base 365), implied TEA % (base 365), implied TEM % (30d)
2. Order Book Level 2 (5 levels) microstructure metrics:
   - Best Bid / Ask, Mid, Spread, Spread %
   - Cumulative 5-level Bid/Ask depth (nominal & notional ARS)
   - Depth-weighted VWAP (Bid 5, Ask 5, Combined Book 5)
   - Order Book Imbalance OBI5 = (V_bid - V_ask) / (V_bid + V_ask)
3. Cauciones effective annual rate TEA % (base 365) and spread vs BADLAR (bps).
"""

from __future__ import annotations

import datetime as dt
import json
import math
from pathlib import Path
from typing import Any


def parse_maturity_utc_sec(maturity_yyyymmdd: str | None) -> int | None:
    if maturity_yyyymmdd is None:
        return None
    clean = maturity_yyyymmdd.strip()
    if len(clean) != 8 or not clean.isdigit():
        return None
    year = int(clean[0:4])
    month = int(clean[4:6])
    day = int(clean[6:8])
    try:
        parsed = dt.datetime(year, month, day, 18, 0, 0, tzinfo=dt.timezone.utc)
    except ValueError:
        return None
    return int(parsed.timestamp())


def eval_dlr_contract(case: dict[str, Any]) -> dict[str, Any]:
    la = case.get("last")
    bi = case.get("bestBid")
    of = case.get("bestAsk")
    se = case.get("settlement")
    cl = case.get("close")

    def pos_fin(val: Any) -> float | None:
        if isinstance(val, (int, float)) and not isinstance(val, bool) and math.isfinite(val) and val > 0.0:
            return float(val)
        return None

    ref_price: float | None = None
    price_basis = "NONE"

    if pos_fin(la) is not None:
        ref_price = float(la)
        price_basis = "LAST"
    elif pos_fin(bi) is not None and pos_fin(of) is not None:
        ref_price = 0.5 * (float(bi) + float(of))
        price_basis = "MID"
    elif pos_fin(se) is not None:
        ref_price = float(se)
        price_basis = "SETTLEMENT_EOD"
    elif pos_fin(cl) is not None:
        ref_price = float(cl)
        price_basis = "SETTLEMENT_EOD"

    a3500 = pos_fin(case.get("a3500"))
    dlr_spot = pos_fin(case.get("dlrSpot"))
    if a3500 is not None:
        spot_used: float | None = a3500
        spot_source = "A3500_BCRA"
    elif dlr_spot is not None:
        spot_used = dlr_spot
        spot_source = "DLR_SPOT"
    else:
        spot_used = None
        spot_source = "NONE"

    as_of_sec = int(case["asOfUtcSec"])
    maturity_sec = parse_maturity_utc_sec(case.get("maturityDate"))
    if maturity_sec is None or maturity_sec <= as_of_sec:
        days: int | None = None
    else:
        days = max(1, round((maturity_sec - as_of_sec) / 86400.0))

    if ref_price is not None and spot_used is not None and days is not None and days > 0:
        ratio = ref_price / spot_used
        deval_pct = (ratio - 1.0) * 100.0
        tna_pct = (ratio - 1.0) * (365.0 / float(days)) * 100.0
        tea_pct = (math.pow(ratio, 365.0 / float(days)) - 1.0) * 100.0
        tem_pct = (math.pow(ratio, 30.0 / float(days)) - 1.0) * 100.0
    else:
        deval_pct = None
        tna_pct = None
        tea_pct = None
        tem_pct = None

    return {
        "priceBasis": price_basis,
        "referencePrice": ref_price,
        "spotUsed": spot_used,
        "spotSource": spot_source,
        "maturityUtcSec": maturity_sec,
        "days": days,
        "devalDirectaPct": deval_pct,
        "tnaImplicitaPct": tna_pct,
        "teaImplicitaPct": tea_pct,
        "temImplicitaPct": tem_pct,
    }


def eval_order_book_l2(bids_raw: list[dict[str, float]], asks_raw: list[dict[str, float]]) -> dict[str, Any]:
    bids = [
        {"price": float(lvl["price"]), "size": float(lvl["size"])}
        for lvl in bids_raw
        if math.isfinite(lvl["price"]) and lvl["price"] > 0.0 and math.isfinite(lvl["size"]) and lvl["size"] >= 0.0
    ]
    asks = [
        {"price": float(lvl["price"]), "size": float(lvl["size"])}
        for lvl in asks_raw
        if math.isfinite(lvl["price"]) and lvl["price"] > 0.0 and math.isfinite(lvl["size"]) and lvl["size"] >= 0.0
    ]
    bids.sort(key=lambda x: x["price"], reverse=True)
    asks.sort(key=lambda x: x["price"])
    bids = bids[:5]
    asks = asks[:5]

    best_bid = bids[0]["price"] if bids else None
    best_ask = asks[0]["price"] if asks else None

    if best_bid is not None and best_ask is not None:
        mid: float | None = 0.5 * (best_bid + best_ask)
        spread: float | None = best_ask - best_bid
        spread_pct: float | None = (spread / mid) * 100.0 if mid > 0.0 else None
    else:
        mid = None
        spread = None
        spread_pct = None

    bid_depth_size = sum(b["size"] for b in bids) if bids else 0.0
    ask_depth_size = sum(a["size"] for a in asks) if asks else 0.0
    bid_notional = sum(b["price"] * b["size"] for b in bids)
    ask_notional = sum(a["price"] * a["size"] for a in asks)

    vwap_bid = (bid_notional / bid_depth_size) if bid_depth_size > 0.0 else None
    vwap_ask = (ask_notional / ask_depth_size) if ask_depth_size > 0.0 else None
    total_size = bid_depth_size + ask_depth_size
    vwap_book = ((bid_notional + ask_notional) / total_size) if total_size > 0.0 else None
    obi = ((bid_depth_size - ask_depth_size) / total_size) if total_size > 0.0 else None

    return {
        "bestBid": best_bid,
        "bestAsk": best_ask,
        "mid": mid,
        "spread": spread,
        "spreadPct": spread_pct,
        "bidDepthSize": bid_depth_size if bids else None,
        "askDepthSize": ask_depth_size if asks else None,
        "bidDepthNotional": bid_notional if bids else None,
        "askDepthNotional": ask_notional if asks else None,
        "vwapBid5": vwap_bid,
        "vwapAsk5": vwap_ask,
        "vwapBook5": vwap_book,
        "obi5": obi,
    }


def eval_caucion(case: dict[str, Any]) -> dict[str, Any]:
    tna = case.get("tnaPct")
    days = case.get("termDays")
    badlar = case.get("badlarTnaPct")

    tea: float | None = None
    if (
        isinstance(tna, (int, float))
        and not isinstance(tna, bool)
        and math.isfinite(tna)
        and isinstance(days, (int, float))
        and not isinstance(days, bool)
        and math.isfinite(days)
        and days > 0.0
    ):
        gross = 1.0 + (float(tna) / 100.0) * (float(days) / 365.0)
        if gross > 0.0:
            tea = (math.pow(gross, 365.0 / float(days)) - 1.0) * 100.0

    spread_bps: float | None = None
    if (
        isinstance(tna, (int, float))
        and not isinstance(tna, bool)
        and math.isfinite(tna)
        and isinstance(badlar, (int, float))
        and not isinstance(badlar, bool)
        and math.isfinite(badlar)
    ):
        spread_bps = (float(tna) - float(badlar)) * 100.0

    return {
        "teaEffectivePct": tea,
        "spreadVsBadlarBps": spread_bps,
    }


def main() -> None:
    as_of_sec = int(dt.datetime(2026, 11, 14, 21, 0, 0, tzinfo=dt.timezone.utc).timestamp())

    dlr_cases = [
        {
            "id": "dlr_nov26_weekend_settlement_a3500",
            "input": {
                "asOfUtcSec": as_of_sec,
                "maturityDate": "20261130",
                "last": None,
                "bestBid": None,
                "bestAsk": None,
                "settlement": 1562.5,
                "close": 1560.0,
                "a3500": 1445.0,
                "dlrSpot": 1448.0,
            },
        },
        {
            "id": "dlr_dic26_live_last_priority",
            "input": {
                "asOfUtcSec": as_of_sec,
                "maturityDate": "20261230",
                "last": 1595.5,
                "bestBid": 1593.0,
                "bestAsk": 1594.0,
                "settlement": 1590.0,
                "close": 1588.0,
                "a3500": 1445.0,
                "dlrSpot": None,
            },
        },
        {
            "id": "dlr_ene27_live_mid_priority",
            "input": {
                "asOfUtcSec": as_of_sec,
                "maturityDate": "20270129",
                "last": None,
                "bestBid": 1622.0,
                "bestAsk": 1626.0,
                "settlement": 1620.0,
                "close": None,
                "a3500": None,
                "dlrSpot": 1450.25,
            },
        },
        {
            "id": "dlr_missing_spot_returns_null_nan",
            "input": {
                "asOfUtcSec": as_of_sec,
                "maturityDate": "20270429",
                "last": None,
                "bestBid": None,
                "bestAsk": None,
                "settlement": 1720.0,
                "close": None,
                "a3500": None,
                "dlrSpot": None,
            },
        },
        {
            "id": "dlr_expired_returns_null_nan_rates",
            "input": {
                "asOfUtcSec": as_of_sec,
                "maturityDate": "20261030",
                "last": 1420.0,
                "bestBid": None,
                "bestAsk": None,
                "settlement": 1420.0,
                "close": None,
                "a3500": 1445.0,
                "dlrSpot": None,
            },
        },
    ]
    for c in dlr_cases:
        c["expected"] = eval_dlr_contract(c["input"])

    l2_cases = [
        {
            "id": "ggal_5_levels_unsorted_input",
            "input": {
                "bids": [
                    {"price": 7150.0, "size": 500},
                    {"price": 7190.0, "size": 1200},
                    {"price": 7175.0, "size": 850},
                    {"price": 7120.0, "size": 2500},
                    {"price": 7160.0, "size": 400},
                    {"price": 7000.0, "size": 9999},  # level 6 must be ignored after sorting desc
                ],
                "asks": [
                    {"price": 7220.0, "size": 900},
                    {"price": 7205.0, "size": 600},
                    {"price": 7240.0, "size": 1500},
                    {"price": 7210.0, "size": 700},
                    {"price": 7260.0, "size": 300},
                    {"price": 7300.0, "size": 4000},  # level 6 must be ignored after sorting asc
                ],
            },
        },
        {
            "id": "empty_book_weekend",
            "input": {"bids": [], "asks": []},
        },
    ]
    for c in l2_cases:
        c["expected"] = eval_order_book_l2(c["input"]["bids"], c["input"]["asks"])

    caucion_cases = [
        {"id": "caucion_1d", "input": {"tnaPct": 32.5, "termDays": 1, "badlarTnaPct": 34.75}},
        {"id": "caucion_7d", "input": {"tnaPct": 33.1, "termDays": 7, "badlarTnaPct": 34.75}},
        {"id": "caucion_30d", "input": {"tnaPct": 35.0, "termDays": 30, "badlarTnaPct": 34.75}},
        {"id": "caucion_invalid_zero_days", "input": {"tnaPct": 35.0, "termDays": 0, "badlarTnaPct": 34.75}},
    ]
    for c in caucion_cases:
        c["expected"] = eval_caucion(c["input"])

    payload = {
        "schemaVersion": 1,
        "dlrCases": dlr_cases,
        "l2Cases": l2_cases,
        "caucionCases": caucion_cases,
    }

    out_path = Path("fixtures/primary_bmb_reference.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {out_path} successfully.")


if __name__ == "__main__":
    main()
