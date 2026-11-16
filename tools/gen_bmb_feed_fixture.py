#!/usr/bin/env python3
"""Independent explicit reference for the BMB adapter/session/overlay tests."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ART = timezone(timedelta(hours=-3))


def utc(*args: int) -> int:
    return int(datetime(*args, tzinfo=timezone.utc).timestamp())


def art_session(epoch: int | float) -> bool:
    if isinstance(epoch, float) or not isinstance(epoch, int) or epoch < 0:
        return False
    local = datetime.fromtimestamp(epoch, tz=timezone.utc).astimezone(ART)
    return local.weekday() < 5 and (local.hour * 60 + local.minute) >= 660 and (local.hour * 60 + local.minute) < 1020


def data_row(symbol: str, bid: float, ask: float, last: float, oi: int) -> dict:
    return {
        "symbol": symbol,
        "last": last,
        "bid": bid,
        "bidSize": 5,
        "ask": ask,
        "askSize": 7,
        "prevClose": last - 1,
        "deltaPct": 0.5,
        "low": bid,
        "high": ask,
        "vwap": last,
        "volumeArs": 1000000,
        "nominalVol": 180000,
        "mark": last,
        "impliedUsdArs": None,
        "arsBid": None,
        "arsAsk": None,
        "usdBid": None,
        "usdAsk": None,
        "openInterest": oi,
        "quoteSource": "DATA912",
        "quoteAsOfUtcSec": None,
    }


def bmb_quote(symbol: str, epoch: int, bid: float, ask: float, last: float, bid_size: float, ask_size: float, volume: float, turnover: float, var_pct: float) -> dict:
    return {
        "symbol": symbol,
        "underlying": "GGAL",
        "bid": bid,
        "bidSize": bid_size,
        "ask": ask,
        "askSize": ask_size,
        "last": last,
        "volume": volume,
        "turnover": turnover,
        "varPct": var_pct,
        "asOfUtcSec": epoch,
    }


def live_overlay(original: dict, quote: dict) -> dict:
    # Reference semantics: BMB replaces transaction/quote fields, while Data912
    # retains only independent contract metadata and previously observed OI.
    result = dict(original)
    for key in ("bid", "bidSize", "ask", "askSize", "last"):
        result[key] = quote[key]
    result["deltaPct"] = quote["varPct"]
    result["nominalVol"] = quote["volume"]
    result["volumeArs"] = quote["turnover"]
    result["mark"] = (quote["bid"] + quote["ask"]) / 2
    result["quoteSource"] = "BMB_HOMEBROKER_BRIDGE"
    result["quoteAsOfUtcSec"] = quote["asOfUtcSec"]
    return result


def main() -> None:
    now = utc(2026, 11, 16, 15, 0, 0)
    session_inputs = [
        utc(2026, 11, 16, 13, 59, 59),
        utc(2026, 11, 16, 14, 0, 0),
        utc(2026, 11, 16, 19, 59, 59),
        utc(2026, 11, 16, 20, 0, 0),
        utc(2026, 11, 15, 15, 0, 0),
        utc(2026, 11, 14, 15, 0, 0),
        utc(2026, 11, 20, 14, 0, 0),
        -1,
        1.5,
    ]

    original_call = data_row("GFGC6400DI", 120, 126, 123, 987654)
    original_put = data_row("GFGV6400DI", 80, 84, 82, 456789)
    fresh_call = bmb_quote("GFGC6400DI", now - 2, 123.4, 125.6, 124.5, 42, 31, 500, 62000, 1.25)
    stale_put = bmb_quote("GFGV6400DI", now - 31, 81, 83, 82, 11, 12, 100, 8000, 0.8)
    new_put = bmb_quote("GFGV6600DI", now - 1, 50, 52, 51, 12, 9, 75, 4000, -2.5)
    added_put = live_overlay(data_row("GFGV6600DI", 0, 0, 0, 0), new_put)
    added_put.update({
        "prevClose": None,
        "low": None,
        "high": None,
        "vwap": None,
        "impliedUsdArs": None,
        "arsBid": None,
        "arsAsk": None,
        "usdBid": None,
        "usdAsk": None,
        "openInterest": None,
    })

    previous = {"bidPrice": 99.9, "bidSize": 100, "askPrice": 100.1, "askSize": 80, "lastTradeSequence": 10}
    current = {"bidPrice": 99.9, "bidSize": 90, "askPrice": 100.1, "askSize": 75}
    trades = [
        {"sequence": 11, "symbol": "GGAL", "timeSec": now - 2, "price": 99.9, "size": 25, "side": "SELL", "buyVolume": 0, "sellVolume": 25, "attributableToLast": True},
        {"sequence": 12, "symbol": "GGAL", "timeSec": now - 1, "price": 100.1, "size": 8, "side": "BUY", "buyVolume": 8, "sellVolume": 0, "attributableToLast": True},
        {"sequence": 13, "symbol": "GGAL", "timeSec": now, "price": 100, "size": 999, "side": "UNKNOWN", "buyVolume": None, "sellVolume": None, "attributableToLast": False},
        {"sequence": 9, "symbol": "GGAL", "timeSec": now - 3, "price": 99.9, "size": 700, "side": "SELL", "buyVolume": 0, "sellVolume": 700, "attributableToLast": True},
    ]
    visible_bid_drop = max(0, previous["bidSize"] - current["bidSize"])
    visible_ask_drop = max(0, previous["askSize"] - current["askSize"])
    executed_bid = 25
    executed_ask = 8
    iceberg = {
        "detected": True,
        "side": "BID",
        "priceLevel": current["bidPrice"],
        "executedVolumeAtBest": executed_bid,
        "visibleDropAtBest": visible_bid_drop,
        "reloadedVolumeEstimate": executed_bid - visible_bid_drop,
        "reloadRatio": executed_bid / visible_bid_drop,
    }
    assert executed_ask - visible_ask_drop < iceberg["reloadedVolumeEstimate"]

    bids = [
        {"price": 6399, "size": 1000, "orderCount": 8},
        {"price": 6398, "size": 800, "orderCount": 7},
        {"price": 6397, "size": 600, "orderCount": 6},
        {"price": 6396, "size": 400, "orderCount": 5},
        {"price": 6395, "size": 200, "orderCount": 4},
    ]
    asks = [
        {"price": 6401, "size": 700, "orderCount": 3},
        {"price": 6402, "size": 900, "orderCount": 4},
        {"price": 6403, "size": 1100, "orderCount": 5},
        {"price": 6404, "size": 1300, "orderCount": 6},
        {"price": 6405, "size": 1500, "orderCount": 7},
    ]
    alpha = 0.55
    wb = sum(math.exp(-alpha * i) * level["size"] for i, level in enumerate(bids))
    wa = sum(math.exp(-alpha * i) * level["size"] for i, level in enumerate(asks))
    wbp = sum(math.exp(-alpha * i) * level["size"] * level["price"] for i, level in enumerate(bids)) / wb
    wap = sum(math.exp(-alpha * i) * level["size"] * level["price"] for i, level in enumerate(asks)) / wa
    l1_bid = bids[0]
    l1_ask = asks[0]
    book_expected = {
        "obiL1": (l1_bid["size"] - l1_ask["size"]) / (l1_bid["size"] + l1_ask["size"]),
        "obiMultiLevel": (wb - wa) / (wb + wa),
        "micropriceL1": (l1_bid["price"] * l1_ask["size"] + l1_ask["price"] * l1_bid["size"]) / (l1_bid["size"] + l1_ask["size"]),
        "micropriceMultiLevel": (wap * wb + wbp * wa) / (wb + wa),
        "totalBidDepth5": sum(level["size"] for level in bids),
        "totalAskDepth5": sum(level["size"] for level in asks),
    }

    fixture = {
        "schemaVersion": 1,
        "sessionCases": [{"utcSec": value, "expected": art_session(value)} for value in session_inputs],
        "optionMergeCase": {
            "nowUtcSec": now,
            "spotHint": 6400,
            "underlying": "GGAL",
            "rows": [original_call, original_put],
            "quotes": [fresh_call, stale_put, new_put],
            "expected": [live_overlay(original_call, fresh_call), original_put, added_put],
        },
        "tradeCases": trades,
        "expectedVpinTrades": [
            {"timeSec": now - 3, "price": 99.9, "buyVolume": 0, "sellVolume": 700},
            {"timeSec": now - 2, "price": 99.9, "buyVolume": 0, "sellVolume": 25},
            {"timeSec": now - 1, "price": 100.1, "buyVolume": 8, "sellVolume": 0},
        ],
        "icebergCase": {
            "previous": previous,
            "current": current,
            "expectedTracking": {"executedVolumeAtBid": executed_bid, "executedVolumeAtAsk": executed_ask, "lastTradeSequence": 13},
            "expectedSignal": iceberg,
        },
        "bookCase": {"bids": bids, "asks": asks, "decayAlpha": alpha, "expected": book_expected},
    }
    target = ROOT / "fixtures" / "bmb_feed_reference.json"
    target.write_text(json.dumps(fixture, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
