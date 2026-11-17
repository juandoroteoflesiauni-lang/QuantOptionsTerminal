#!/usr/bin/env python3
"""
Referencia INDEPENDIENTE para Pieza 41.

No copia la lógica TypeScript:
- Las fechas FMP se convierten con datetime + ZoneInfo("America/New_York").
- El ruteo es una tabla explícita de identidad (AR:/US:) -> mercado/símbolo/exchange.
- Los frames Eco Primary se fusionan campo a campo desde un modelo aparte.
- Los secretos de esta suite son sentinelas sintéticos, nunca valores reales.
"""

import json
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")


def et_to_utc(date_time: str) -> int:
    fmt = "%Y-%m-%d %H:%M:%S"
    dt = datetime.strptime(date_time, fmt).replace(tzinfo=NY)
    return int(dt.timestamp())


def bar(date_time, o, h, l, c, v, vw=None):
    value = {
        "time": et_to_utc(date_time),
        "open": o,
        "high": h,
        "low": l,
        "close": c,
        "volume": v,
    }
    if vw is not None:
        value["vw"] = vw
    return value


def route(key, market, provider, exchange, badge, currency, is_adr):
    return {
        "key": key,
        "providerSymbol": provider,
        "market": market,
        "mode": "ADR_USD" if market == "US" else "BYMA_ARS",
        "isAdr": is_adr,
        "exchange": exchange,
        "badge": badge,
        "currencySymbol": currency,
    }


def merge(previous, frame, present):
    """
    Modelo independiente: entries presentes reemplazan, ausentes conservan.
    previous puede ser None. Puntas se reemplazan solo si el frame las trae.
    """
    if previous is None:
        return {**frame}
    out = {**previous}
    if "BI" in present:
        out["bids"] = frame["bids"]
    if "OF" in present:
        out["asks"] = frame["asks"]
    for md_field, out_field in [
        ("LA", "last"),
        ("SE", "settlement"),
        ("CL", "close"),
        ("OP", "open"),
        ("HI", "high"),
        ("LO", "low"),
        ("OI", "openInterest"),
        ("NV", "nominalVolume"),
        ("TV", "turnover"),
    ]:
        if md_field in present:
            out[out_field] = frame.get(out_field)
    if "LA" in present:
        out["lastTradeAtUtcSec"] = frame.get("lastTradeAtUtcSec")
    out["frameAtUtcSec"] = frame["frameAtUtcSec"]
    out["updatedAtUtcSec"] = max(
        out.get("updatedAtUtcSec") or 0,
        frame.get("updatedAtUtcSec") or 0,
    ) or None
    return out


def main() -> None:
    fixture = {
        "version": 1,
        "electoralGapStartUtcSec": et_to_utc("2025-10-01 00:00:00"),
        "fmpHistorical": {
            "rows": [
                {"date": "2026-07-30 13:16:00", "open": 10.0, "high": 10.5, "low": 9.9, "close": 10.4, "volume": 100},
                {"date": "2026-07-30 13:20:00", "open": 10.4, "high": 10.6, "low": 10.2, "close": 10.2, "volume": 40},
                {"date": "2026-07-30 13:20:00", "open": 10.4, "high": 10.7, "low": 10.0, "close": 10.6, "volume": 60},
                {"date": "malformed", "open": 10.0, "high": 10.0, "low": 10.0, "close": 10.0, "volume": 0},
                {"date": "2026-07-30 13:25:00", "open": 0, "high": 10.0, "low": 9.0, "close": 10.0, "volume": 0},
                {"date": "2026-01-30 13:20:00", "open": 20.0, "high": 20.1, "low": 19.8, "close": 20.0, "volume": 5},
                {"date": "2026-07-30 14:20:00", "open": 10.6, "high": 10.8, "low": 10.5, "close": 10.7, "volume": 7, "vw": 10.68},
                {"date": "2026-07-30 14:20:00", "open": 10.6, "high": 10.9, "low": 10.4, "close": 10.8, "volume": 8, "vw": None},
            ],
            "expectedBars": [
                bar("2026-01-30 13:20:00", 20.0, 20.1, 19.8, 20.0, 5),
                bar("2026-07-30 13:16:00", 10.0, 10.5, 9.9, 10.4, 100),
                bar("2026-07-30 13:20:00", 10.4, 10.7, 10.0, 10.6, 60),
                bar("2026-07-30 14:20:00", 10.6, 10.8, 10.5, 10.7, 7),
            ],
            "expectedDiscarded": 3,
        },
        "fmpBatch": {
            "rows": [
                {"symbol": "AAPL", "name": "Apple Inc.", "price": 331.85501, "changePercentage": -1.8732, "volume": 28718014, "dayLow": 329.59, "dayHigh": 334.48, "exchange": "NASDAQ", "open": 333.13, "previousClose": 338.18999, "timestamp": 1785430812},
                {"symbol": "SPY", "price": 600.0, "volume": 0, "exchange": "NYSE ARCA", "previousClose": 602.0, "timestamp": 1785430812},
                {"symbol": "NO_PRICE", "price": 0, "volume": 1, "timestamp": 1785430812},
                {"symbol": "SPY", "price": 600.0, "volume": 1, "timestamp": 1785430812},
            ],
            "expectedQuotes": [
                {"symbol": "AAPL", "exchange": "NASDAQ", "price": 331.85501, "changePct": -1.8732, "previousClose": 338.18999, "volume": 28718014, "asOfUtcSec": 1785430812},
                {"symbol": "SPY", "exchange": "NYSE ARCA", "price": 600.0, "changePct": (600.0 - 602.0) / 602.0 * 100.0, "previousClose": 602.0, "volume": 0, "asOfUtcSec": 1785430812},
            ],
            "expectedDiscarded": 2,
        },
        "routing": {
            "cases": [
                route("AR:GGAL", "AR", "GGAL", "BYMA", "BYMA", "ARS", False),
                route("US:GGAL", "US", "GGAL", "NASDAQ", "NASDAQ", "USD", True),
                route("AR:YPFD", "AR", "YPFD", "BYMA", "BYMA", "ARS", False),
                route("US:YPF", "US", "YPF", "NYSE", "NYSE", "USD", True),
                route("AR:PAMP", "AR", "PAMP", "BYMA", "BYMA", "ARS", False),
                route("US:PAM", "US", "PAM", "NYSE", "NYSE", "USD", True),
                route("AR:TGSU2", "AR", "TGSU2", "BYMA", "BYMA", "ARS", False),
                route("US:TGS", "US", "TGS", "NYSE", "NYSE", "USD", True),
                route("AR:CRES", "AR", "CRES", "BYMA", "BYMA", "ARS", False),
                route("US:CRESY", "US", "CRESY", "NYSE", "NYSE", "USD", True),
                route("AR:TECO2", "AR", "TECO2", "BYMA", "BYMA", "ARS", False),
                route("US:TEO", "US", "TEO", "NYSE", "NYSE", "USD", True),
                route("US:SPY", "US", "SPY", "NYSE", "NYSE", "USD", False),
                route("NVDA", "US", "NVDA", "NASDAQ", "NASDAQ", "USD", False),
                route("AR:NVDA", "AR", "NVDA", "BYMA", "BYMA", "ARS", False),
            ]
        },
        "massiveStocksMode": {
            "cases": [
                {"env": {"MASSIVE_API_KEY": "mk"}, "expected": "MASSIVE_STOCKS_ENABLED"},
                {"env": {"FMP_API_KEY": "fk"}, "expected": "STANDBY_TRADIER_FMP_PRIMARY"},
                {"env": {"FMP_KEY_QUOTES": "fq"}, "expected": "STANDBY_TRADIER_FMP_PRIMARY"},
                {"env": {"FMP_KEY_MARKET": "fm"}, "expected": "STANDBY_TRADIER_FMP_PRIMARY"},
                {"env": {"TRADIER_API_TOKEN": "t"}, "expected": "STANDBY_TRADIER_FMP_PRIMARY"},
                {"env": {"TRADIER_LIVE_TOKEN": "t"}, "expected": "STANDBY_TRADIER_FMP_PRIMARY"},
                {"env": {"TRADIER_ACCESS_TOKEN": "t"}, "expected": "STANDBY_TRADIER_FMP_PRIMARY"},
                {"env": {"TRADIER_TOKEN": "t"}, "expected": "STANDBY_TRADIER_FMP_PRIMARY"},
                {"env": {"TRADIER_SANDBOX_TOKEN": "t"}, "expected": "STANDBY_TRADIER_FMP_PRIMARY"},
                {"env": {"TRADIER_SANDBOX_API_TOKEN": "t"}, "expected": "STANDBY_TRADIER_FMP_PRIMARY"},
                {"env": {"FMP_API_KEY": "fk", "MASSIVE_STOCKS_WS_ENABLED": "true"}, "expected": "MASSIVE_STOCKS_ENABLED"},
                {"env": {"MASSIVE_STOCKS_WS_ENABLED": "TRUE"}, "expected": "MASSIVE_STOCKS_ENABLED"},
            ]
        },
        "fmpKeyResolution": {
            "empty": {"configured": False, "apiKey": None, "quotesApiKey": None, "marketApiKey": None},
            "primaryOnly": {"env": {"FMP_API_KEY": "fmp-primary"}, "configured": True, "apiKey": "fmp-primary", "quotesApiKey": None, "marketApiKey": None},
            "dedicated": {"env": {"FMP_API_KEY": "fmp-primary", "FMP_KEY_QUOTES": "fmp-quotes", "FMP_KEY_MARKET": "fmp-market"}, "configured": True, "apiKey": "fmp-primary", "quotesApiKey": "fmp-quotes", "marketApiKey": "fmp-market"},
            "quotesOnly": {"env": {"FMP_KEY_QUOTES": "fmp-quotes"}, "configured": True, "quotesEndpoint": "QUOTES", "marketEndpoint": None},
            "marketOnly": {"env": {"FMP_KEY_MARKET": "fmp-market"}, "configured": True, "quotesEndpoint": None, "marketEndpoint": "MARKET"},
        },
        "tradierTokenResolution": [
            {"env": {"TRADIER_API_TOKEN": "live-token"}, "configured": True, "apiEnv": "prod", "environment": "LIVE", "restBaseUrl": "https://api.tradier.com/v1", "wsBaseUrl": "wss://ws.tradier.com/v1/markets/events"},
            {"env": {"TRADIER_LIVE_TOKEN": "live-token"}, "configured": True, "apiEnv": "prod", "environment": "LIVE", "restBaseUrl": "https://api.tradier.com/v1", "wsBaseUrl": "wss://ws.tradier.com/v1/markets/events"},
            {"env": {"TRADIER_ACCESS_TOKEN": "legacy-live"}, "configured": True, "apiEnv": "prod", "environment": "LIVE", "restBaseUrl": "https://api.tradier.com/v1", "wsBaseUrl": "wss://ws.tradier.com/v1/markets/events"},
            {"env": {"TRADIER_TOKEN": "legacy-live"}, "configured": True, "apiEnv": "prod", "environment": "LIVE", "restBaseUrl": "https://api.tradier.com/v1", "wsBaseUrl": "wss://ws.tradier.com/v1/markets/events"},
            {"env": {"TRADIER_SANDBOX_TOKEN": "sandbox-token"}, "configured": True, "apiEnv": "sandbox", "environment": "SANDBOX", "restBaseUrl": "https://sandbox.tradier.com/v1", "wsBaseUrl": "wss://sandbox.tradier.com/v1/markets/events"},
            {"env": {"TRADIER_SANDBOX_API_TOKEN": "sandbox-token"}, "configured": True, "apiEnv": "sandbox", "environment": "SANDBOX", "restBaseUrl": "https://sandbox.tradier.com/v1", "wsBaseUrl": "wss://sandbox.tradier.com/v1/markets/events"},
            {"env": {"TRADIER_API_TOKEN": "live-token", "TRADIER_ENV": "sandbox"}, "configured": True, "apiEnv": "sandbox", "environment": "SANDBOX", "restBaseUrl": "https://sandbox.tradier.com/v1", "wsBaseUrl": "wss://sandbox.tradier.com/v1/markets/events"},
            {"env": {"TRADIER_SANDBOX_TOKEN": "sandbox-token", "TRADIER_ENV": "prod"}, "configured": True, "apiEnv": "sandbox", "environment": "SANDBOX", "restBaseUrl": "https://sandbox.tradier.com/v1", "wsBaseUrl": "wss://sandbox.tradier.com/v1/markets/events"},
        ],
        "primarySelection": {
            "instruments": [
                {"marketId": "MERV", "symbol": "MERV - XMEV - GGAL - 24HS"},
                {"marketId": "MERV", "symbol": "MERV - XMEV - GGAL - T1"},
                {"marketId": "MERV", "symbol": "MERV - XMEV - GGAL - CI"},
                {"marketId": "MERV", "symbol": "MERV - XMEV - AL30 - 24HS"},
                {"marketId": "MERV", "symbol": "MERV - XMEV - AL30 - T1"},
                {"marketId": "MERV", "symbol": "MERV - XMEV - AL30 - CI"},
                {"marketId": "MERV", "symbol": "MERV - XMEV - AL30D - 24HS"},
                {"marketId": "MERV", "symbol": "MERV - XMEV - GD30 - CI"},
                {"marketId": "MERV", "symbol": "MERV - XMEV - GD30D - 24HS"},
                {"marketId": "MERV", "symbol": "MERV - XMEV - TX26 - CI"},
                {"marketId": "MERV", "symbol": "MERV - XMEV - PESOS - 1D - 24HS"},
                {"marketId": "MERV", "symbol": "MERV - XMEV - PESOS - 3D - 24HS"},
                {"marketId": "MERV", "symbol": "MERV - XMEV - PESOS - 7D - CI"},
                {"marketId": "MERV", "symbol": "MERV - XMEV - NOPE - 24HS"},
                {"marketId": "MERV", "symbol": "MERV - XMEV - AL30 - 48HS"},
            ],
            "expectedSymbols": [
                "MERV - XMEV - AL30 - 24HS",
                "MERV - XMEV - AL30 - CI",
                "MERV - XMEV - AL30D - 24HS",
                "MERV - XMEV - GD30 - CI",
                "MERV - XMEV - GD30D - 24HS",
                "MERV - XMEV - GGAL - 24HS",
                "MERV - XMEV - GGAL - CI",
                "MERV - XMEV - PESOS - 1D - 24HS",
                "MERV - XMEV - PESOS - 3D - 24HS",
                "MERV - XMEV - PESOS - 7D - CI",
                "MERV - XMEV - TX26 - CI",
            ],
        },
        "primaryMdMerge": {
            "base": {
                "symbol": "MERV - XMEV - AL30 - 24HS",
                "marketId": "MERV",
                "bids": [{"price": 77.0, "size": 10, "orderCount": 1}],
                "asks": [{"price": 77.1, "size": 10, "orderCount": 1}],
                "last": 77.05,
                "settlement": 77.0,
                "close": 76.5,
                "open": 76.8,
                "high": 77.2,
                "low": 76.4,
                "openInterest": None,
                "nominalVolume": 1000,
                "impliedVol": None,
                "updatedAtUtcSec": 100,
                "lastTradeAtUtcSec": 100,
                "turnover": None,
                "frameAtUtcSec": 100,
            },
            "bookOnlyFrame": {
                "bids": [{"price": 77.02, "size": 11, "orderCount": 2}],
                "asks": [{"price": 77.12, "size": 12, "orderCount": 3}],
                "last": None,
                "settlement": None,
                "close": None,
                "open": None,
                "high": None,
                "low": None,
                "openInterest": None,
                "nominalVolume": None,
                "impliedVol": None,
                "updatedAtUtcSec": None,
                "lastTradeAtUtcSec": None,
                "turnover": None,
                "frameAtUtcSec": 104,
            },
            "bookOnlyPresent": ["BI", "OF"],
            "expected": {
                "bids": [{"price": 77.02, "size": 11, "orderCount": 2}],
                "asks": [{"price": 77.12, "size": 12, "orderCount": 3}],
                "last": 77.05,
                "close": 76.5,
                "open": 76.8,
                "high": 77.2,
                "low": 76.4,
                "nominalVolume": 1000,
                "lastTradeAtUtcSec": 100,
                "frameAtUtcSec": 104,
            },
            "futureFrameReceivedSec": 110,
            "futureFrameTimeSec": 190,
            "expectedFutureRejected": True,
        },
        "primaryQuotes": {
            "frames": [
                {"ticker": "AL30", "settlement": "24hs", "price": 77.05, "close": 76.5, "low": 76.4, "high": 77.2, "volume": 1000, "turnover": None, "timeSec": 100},
                {"ticker": "AL30D", "settlement": "24hs", "price": 60.25, "close": 60.1, "low": 60.0, "high": 60.4, "volume": 900, "turnover": None, "timeSec": 101},
                {"ticker": "AL30", "settlement": "CI", "price": 77.06, "close": 76.51, "low": 76.41, "high": 77.21, "volume": 10, "turnover": None, "timeSec": 102},
                {"ticker": "PESOS - 3D", "settlement": "24hs", "rate": 0.0401, "bid": 0.0400, "ask": 0.0402, "turnover": 10000000.0, "timeSec": 103},
            ],
            "expectedQuoteKeys": ["AR:AL30:24hs", "AR:AL30D:24hs", "AR:AL30:CI"],
            "expectedCaucion": {
                "termDays": 3,
                "currency": "ARS",
                "tnaWeighted": 0.0401,
                "bidTna": 0.0400,
                "askTna": 0.0402,
                "turnoverArs": 10000000.0,
                "source": "PRIMARY_ECO_WS",
            },
        },
        "redaction": {
            "secrets": ["fmp-test-secret", "tradier-test-token"],
            "cases": [
                {"input": "https://x/stable/chart?symbol=GGAL&apikey=fmp-test-secret", "expected": "https://x/stable/chart?symbol=GGAL&apikey=[REDACTED]"},
                {"input": "https://x/api?apikey=fmp%2Dtest%2Dsecret", "expected": "https://x/api?apikey=[REDACTED]"},
                {"input": "error token tradier-test-token", "expected": "error token <redacted>"},
            ],
        },
        "health": {
            "defaultProviderIds": [
                "MASSIVE_WS_STOCKS",
                "MASSIVE_REST_POOL",
                "TRADIER_LIVE_WS",
                "FMP_ENTERPRISE_REST",
                "ORATS_API",
                "PRIMARY_REMARKETS_DLR",
                "BMB_HOMEBROKER_L2",
                "IOL_REST_V2",
            ],
            "standby": {
                "id": "MASSIVE_WS_STOCKS",
                "state": "STANDBY_TRADIER_FMP_PRIMARY",
                "connected": None,
                "reconnectable": False,
            },
        },
    }

    path = Path(__file__).resolve().parents[1] / "fixtures" / "fmp_enterprise_and_argy_stream_reference.json"
    path.write_text(json.dumps(fixture, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"fixture: {path}")


if __name__ == "__main__":
    main()
