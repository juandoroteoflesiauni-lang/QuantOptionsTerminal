#!/usr/bin/env python3
"""Referencia independiente Pieza 43 (sin copiar la implementación TypeScript).

Genera fixtures/stock_detail_stability_reference.json con:
- estabilidad de pestaña del navegador de acciones en transiciones closed -> open vs open -> open,
- matriz completa de fallback intradiario AR (1m/5m/15m/1h/4h -> 1D),
- normalización de libro L2 (5 niveles), prevención de cantidades huérfanas BID/ASK y cálculo de Spread,
- resolución del estado global sin falsos degradados por STANDBY_TRADIER_FMP_PRIMARY o AUTH_INVALID.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence


def picker_transition(
    was_open: bool,
    is_open: bool,
    current_category: str,
    selected_category: str,
    current_query: str,
    current_active_index: int,
    filtered_length: int,
    selected_item_index: int,
) -> Dict[str, Any]:
    if not was_open and is_open:
        return {
            "activeCategory": selected_category,
            "query": "",
            "activeIndex": selected_item_index if selected_item_index >= 0 else 0,
            "shouldFocusInput": True,
        }
    if was_open and is_open:
        if filtered_length > 0:
            idx = max(0, min(int(current_active_index), filtered_length - 1))
        else:
            idx = 0
        return {
            "activeCategory": current_category,
            "query": current_query,
            "activeIndex": idx,
            "shouldFocusInput": False,
        }
    return {
        "activeCategory": current_category,
        "query": "",
        "activeIndex": 0,
        "shouldFocusInput": False,
    }


def ar_intraday_fallback_case(tf: str) -> Dict[str, Any]:
    clean = tf.strip()
    if clean in {"1m", "5m", "15m", "1h", "4h"}:
        return {
            "requestedTimeframe": clean,
            "effectiveTimeframe": "1D",
            "fallbackReason": f"NO_{clean.upper()}_BARS_AR",
        }
    if clean == "1D":
        return {
            "requestedTimeframe": "1D",
            "effectiveTimeframe": "1D",
            "fallbackReason": None,
        }
    raise ValueError(f"Unsupported timeframe: {tf}")


def is_pos_finite(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(float(v)) and float(v) > 0.0


def normalize_l2_book(
    bids_raw: Sequence[Mapping[str, Any]],
    asks_raw: Sequence[Mapping[str, Any]],
    max_levels: int = 5,
) -> Dict[str, Any]:
    bids: List[Dict[str, Any]] = []
    for row in bids_raw:
        p = row.get("price")
        if not is_pos_finite(p):
            continue
        s = row.get("size")
        size = float(s) if isinstance(s, (int, float)) and not isinstance(s, bool) and math.isfinite(float(s)) and float(s) >= 0.0 else 0.0
        item: Dict[str, Any] = {"price": float(p), "size": size}
        oc = row.get("orderCount")
        if isinstance(oc, int) and not isinstance(oc, bool) and oc >= 0:
            item["orderCount"] = oc
        bids.append(item)
    bids.sort(key=lambda x: x["price"], reverse=True)
    bids = bids[:max_levels]

    asks: List[Dict[str, Any]] = []
    for row in asks_raw:
        p = row.get("price")
        if not is_pos_finite(p):
            continue
        s = row.get("size")
        size = float(s) if isinstance(s, (int, float)) and not isinstance(s, bool) and math.isfinite(float(s)) and float(s) >= 0.0 else 0.0
        item = {"price": float(p), "size": size}
        oc = row.get("orderCount")
        if isinstance(oc, int) and not isinstance(oc, bool) and oc >= 0:
            item["orderCount"] = oc
        asks.append(item)
    asks.sort(key=lambda x: x["price"])
    asks = asks[:max_levels]

    best_bid = bids[0]["price"] if bids else None
    best_bid_size = bids[0]["size"] if bids and bids[0]["size"] > 0.0 else None
    best_ask = asks[0]["price"] if asks else None
    best_ask_size = asks[0]["size"] if asks and asks[0]["size"] > 0.0 else None

    if best_bid is not None and best_ask is not None and best_ask >= best_bid and best_ask > 0.0:
        spread_abs: Optional[float] = best_ask - best_bid
        spread_pct: Optional[float] = ((best_ask - best_bid) / best_ask) * 100.0
        mid: Optional[float] = 0.5 * (best_bid + best_ask)
    else:
        spread_abs = None
        spread_pct = None
        mid = None

    b_depth = sum(x["size"] for x in bids)
    a_depth = sum(x["size"] for x in asks)
    tot = b_depth + a_depth
    obi5: Optional[float] = (b_depth - a_depth) / tot if tot > 0.0 else None

    return {
        "bids": bids,
        "asks": asks,
        "bestBid": best_bid,
        "bestBidSize": best_bid_size,
        "bestAsk": best_ask,
        "bestAskSize": best_ask_size,
        "spreadAbs": spread_abs,
        "spreadPct": spread_pct,
        "mid": mid,
        "obi5": obi5,
    }


def normalize_header_quotes(
    quote_bid: Any,
    quote_bid_size: Any,
    quote_ask: Any,
    quote_ask_size: Any,
    book: Mapping[str, Any],
) -> Dict[str, Any]:
    bid: Optional[float] = None
    bid_size: Optional[float] = None
    if is_pos_finite(quote_bid):
        bid = float(quote_bid)
        if is_pos_finite(quote_bid_size):
            bid_size = float(quote_bid_size)
        elif book["bestBid"] is not None and abs(book["bestBid"] - bid) <= 1e-9:
            bid_size = book["bestBidSize"]
    elif book["bestBid"] is not None:
        bid = float(book["bestBid"])
        bid_size = book["bestBidSize"]

    ask: Optional[float] = None
    ask_size: Optional[float] = None
    if is_pos_finite(quote_ask):
        ask = float(quote_ask)
        if is_pos_finite(quote_ask_size):
            ask_size = float(quote_ask_size)
        elif book["bestAsk"] is not None and abs(book["bestAsk"] - ask) <= 1e-9:
            ask_size = book["bestAskSize"]
    elif book["bestAsk"] is not None:
        ask = float(book["bestAsk"])
        ask_size = book["bestAskSize"]

    if bid is not None and ask is not None and ask >= bid and ask > 0.0:
        spread_abs: Optional[float] = ask - bid
        spread_pct: Optional[float] = ((ask - bid) / ask) * 100.0
    else:
        spread_abs = None
        spread_pct = None

    return {
        "bid": bid,
        "bidSize": None if bid is None else bid_size,
        "ask": ask,
        "askSize": None if ask is None else ask_size,
        "spreadAbs": spread_abs,
        "spreadPct": spread_pct,
    }


def resolve_global_status(
    is_backend_connected: bool,
    feed_status: str,
    stream_fresh: bool,
    providers: Sequence[Mapping[str, Any]],
) -> Dict[str, Any]:
    active = sum(1 for p in providers if p["state"] == "CONNECTED")
    degraded = sum(1 for p in providers if p["state"] == "DEGRADED")
    has_core = any(
        p["state"] == "CONNECTED"
        and p["id"] in {"FMP_ENTERPRISE_REST", "MASSIVE_REST_POOL", "PRIMARY_REMARKETS_DLR"}
        for p in providers
    ) or active > 0

    if not is_backend_connected:
        return {"tone": "OFFLINE", "label": "DESCONECTADO", "operationalActiveCount": active, "degradedOperationalCount": degraded}
    if feed_status == "LIVE":
        return {"tone": "LIVE", "label": "LIVE", "operationalActiveCount": active, "degradedOperationalCount": degraded}
    if feed_status == "EOD_CIERRE":
        return {"tone": "EOD", "label": "EOD · ÚLTIMO CIERRE", "operationalActiveCount": active, "degradedOperationalCount": degraded}
    if stream_fresh:
        return {"tone": "LIVE", "label": "LIVE", "operationalActiveCount": active, "degradedOperationalCount": degraded}
    if has_core and degraded == 0:
        if feed_status == "DIFERIDO_20M":
            return {"tone": "PARTIAL", "label": "DIFERIDO_20M", "operationalActiveCount": active, "degradedOperationalCount": degraded}
        return {"tone": "LIVE", "label": "LIVE", "operationalActiveCount": active, "degradedOperationalCount": degraded}
    if feed_status in {"DIFERIDO_20M", "PARTIAL"}:
        return {"tone": "PARTIAL", "label": feed_status, "operationalActiveCount": active, "degradedOperationalCount": degraded}
    if has_core:
        return {"tone": "LIVE", "label": "LIVE", "operationalActiveCount": active, "degradedOperationalCount": degraded}
    return {"tone": "OFFLINE", "label": "NO_DATA", "operationalActiveCount": active, "degradedOperationalCount": degraded}


def build_fixture() -> Dict[str, Any]:
    picker_cases = [
        {
            "name": "closed -> open initializes category to selected symbol category",
            "input": {
                "wasOpen": False,
                "isOpen": True,
                "currentCategory": "US_STOCKS",
                "selectedCategory": "PANEL_LIDER",
                "currentQuery": "NV",
                "currentActiveIndex": 4,
                "filteredLength": 20,
                "selectedItemIndex": 2,
            },
            "expected": picker_transition(False, True, "US_STOCKS", "PANEL_LIDER", "NV", 4, 20, 2),
        },
        {
            "name": "open -> open preserves user US_STOCKS tab and query on live tick updates",
            "input": {
                "wasOpen": True,
                "isOpen": True,
                "currentCategory": "US_STOCKS",
                "selectedCategory": "PANEL_LIDER",
                "currentQuery": "NVDA",
                "currentActiveIndex": 0,
                "filteredLength": 1,
                "selectedItemIndex": 0,
            },
            "expected": picker_transition(True, True, "US_STOCKS", "PANEL_LIDER", "NVDA", 0, 1, 0),
        },
        {
            "name": "open -> open preserves PANEL_GENERAL and clamps activeIndex when filtered list shrinks",
            "input": {
                "wasOpen": True,
                "isOpen": True,
                "currentCategory": "PANEL_GENERAL",
                "selectedCategory": "PANEL_LIDER",
                "currentQuery": "HARG",
                "currentActiveIndex": 8,
                "filteredLength": 3,
                "selectedItemIndex": 0,
            },
            "expected": picker_transition(True, True, "PANEL_GENERAL", "PANEL_LIDER", "HARG", 8, 3, 0),
        },
        {
            "name": "open -> open preserves CEDEARS tab cleanly",
            "input": {
                "wasOpen": True,
                "isOpen": True,
                "currentCategory": "CEDEARS",
                "selectedCategory": "PANEL_LIDER",
                "currentQuery": "AAPL",
                "currentActiveIndex": 1,
                "filteredLength": 5,
                "selectedItemIndex": 0,
            },
            "expected": picker_transition(True, True, "CEDEARS", "PANEL_LIDER", "AAPL", 1, 5, 0),
        },
        {
            "name": "open -> closed clears query while preserving category",
            "input": {
                "wasOpen": True,
                "isOpen": False,
                "currentCategory": "CEDEARS",
                "selectedCategory": "PANEL_LIDER",
                "currentQuery": "MSFT",
                "currentActiveIndex": 2,
                "filteredLength": 4,
                "selectedItemIndex": 0,
            },
            "expected": picker_transition(True, False, "CEDEARS", "PANEL_LIDER", "MSFT", 2, 4, 0),
        },
    ]

    l2_raw_cases = [
        {
            "name": "filters invalid <=0 levels, orders L2, computes spread & prevents orphan BID size",
            "bids": [
                {"price": 0, "size": 50},
                {"price": -10, "size": 25},
                {"price": 11420.0, "size": 120},
                {"price": 11435.5, "size": 50, "orderCount": 3},
                {"price": 11410.0, "size": 200},
            ],
            "asks": [
                {"price": 0, "size": 30},
                {"price": 11475.0, "size": 90},
                {"price": 11450.0, "size": 30, "orderCount": 2},
            ],
            "headerInput": {
                "quoteBid": None,
                "quoteBidSize": 50,
                "quoteAsk": None,
                "quoteAskSize": 30,
            },
        },
        {
            "name": "orphan quoteBidSize 50 with empty L2 book yields bid=null bidSize=null",
            "bids": [{"price": 0, "size": 50}],
            "asks": [{"price": 9500.0, "size": 40}],
            "headerInput": {
                "quoteBid": 0,
                "quoteBidSize": 50,
                "quoteAsk": 9500.0,
                "quoteAskSize": 40,
            },
        },
        {
            "name": "one-sided quote with valid bid and ask backfilled from L2 asks",
            "bids": [{"price": 8100.0, "size": 500}],
            "asks": [{"price": 8140.0, "size": 300}],
            "headerInput": {
                "quoteBid": 8100.0,
                "quoteBidSize": None,
                "quoteAsk": None,
                "quoteAskSize": None,
            },
        },
    ]

    l2_cases = []
    for c in l2_raw_cases:
        book = normalize_l2_book(c["bids"], c["asks"], 5)
        hdr = normalize_header_quotes(
            c["headerInput"]["quoteBid"],
            c["headerInput"]["quoteBidSize"],
            c["headerInput"]["quoteAsk"],
            c["headerInput"]["quoteAskSize"],
            book,
        )
        l2_cases.append({
            "name": c["name"],
            "bids": c["bids"],
            "asks": c["asks"],
            "headerInput": c["headerInput"],
            "expectedBook": book,
            "expectedHeader": hdr,
        })

    connectivity_cases = [
        {
            "name": "LIVE when FMP + Massive REST + Primary connected, Massive WS in standby and Tradier AUTH_INVALID",
            "input": {
                "isBackendConnected": True,
                "feedStatus": "PARTIAL",
                "streamFresh": False,
                "providers": [
                    {"id": "MASSIVE_WS_STOCKS", "state": "STANDBY_TRADIER_FMP_PRIMARY", "configured": True},
                    {"id": "MASSIVE_REST_POOL", "state": "CONNECTED", "configured": True},
                    {"id": "TRADIER_LIVE_WS", "state": "AUTH_INVALID", "configured": True},
                    {"id": "FMP_ENTERPRISE_REST", "state": "CONNECTED", "configured": True},
                    {"id": "ORATS_API", "state": "CONNECTED", "configured": True},
                    {"id": "PRIMARY_REMARKETS_DLR", "state": "CONNECTED", "configured": True},
                ],
            },
        },
        {
            "name": "EOD_CIERRE preserved cleanly over weekend",
            "input": {
                "isBackendConnected": True,
                "feedStatus": "EOD_CIERRE",
                "streamFresh": False,
                "providers": [
                    {"id": "MASSIVE_WS_STOCKS", "state": "STANDBY_TRADIER_FMP_PRIMARY", "configured": True},
                    {"id": "FMP_ENTERPRISE_REST", "state": "CONNECTED", "configured": True},
                    {"id": "PRIMARY_REMARKETS_DLR", "state": "ARMED_OUT_OF_SESSION", "configured": True},
                ],
            },
        },
        {
            "name": "DESCONECTADO when backend is offline",
            "input": {
                "isBackendConnected": False,
                "feedStatus": "NO_DATA",
                "streamFresh": False,
                "providers": [],
            },
        },
    ]
    for cc in connectivity_cases:
        cc["expected"] = resolve_global_status(
            cc["input"]["isBackendConnected"],
            cc["input"]["feedStatus"],
            cc["input"]["streamFresh"],
            cc["input"]["providers"],
        )

    return {
        "meta": {
            "name": "Pieza 43 Stock Detail Stability, L2 Normalization, AR Fallback and Connectivity Reference",
            "precisionTolerance": 1e-9,
        },
        "pickerTransitions": picker_cases,
        "arIntradayFallback": {tf: ar_intraday_fallback_case(tf) for tf in ("1m", "5m", "15m", "1h", "4h", "1D")},
        "l2Cases": l2_cases,
        "connectivityCases": connectivity_cases,
    }


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    out = root / "fixtures" / "stock_detail_stability_reference.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(build_fixture(), indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"written {out}")


if __name__ == "__main__":
    main()
