#!/usr/bin/env python3
"""
Referencia INDEPENDIENTE (Python) para el conector institucional Primary
Eco Valores XOMS (`api.eco.xoms.com.ar`): L2 BYMA 5 puntas (MERV) + curva
DLR/* (ROFX). Implementación explícita, sin copiar la lógica del código
TypeScript:

  1. Config de entorno: `PRIMARY_BASE_URL` (+ `PRIMARY_API_URL` legacy),
     derivación automática de `PRIMARY_WS_URL` (`wss://...`), y fallback de
     credenciales `ECO_MATRIZ_USERNAME` / `ECO_MATRIZ_PASSWORD`.
  2. Parser de símbolos MERV (`MERV - XMEV - <ticker> - <plazo>`), con alias
     `T1` -> plazo normal `24hs`.
  3. Selección del universo L2 BYMA: líderes Merval + CEDEARs (24hs, CI
     adicional para GGAL), opciones GFGC*/GFGV* y tolerancia al marketId
     descubierto (MERV o ROFX).
  4. Decisión de emisión del tick ARS de GGAL ante frames `Md`
     (`LA` trade o actualización BI/OF, sin doble conteo de volumen).
  5. Microestructura L2: ordenamiento de puntas y spread/imbalance de 5 puntas.

No incluye valores de credenciales en el fixture: solo flags booleanos.

Genera: fixtures/primary_eco_l2_reference.json
"""

from __future__ import annotations

import json
import math
import pathlib
import re

# ---------------------------------------------------------------------------
# 1. Config de entorno
# ---------------------------------------------------------------------------

DEFAULT_API_URL = "https://api.remarkets.primary.com.ar"
DEFAULT_WS_URL = "wss://api.remarkets.primary.com.ar/"


def pick_env(env: dict, *keys: str) -> str:
    for key in keys:
        value = (env.get(key) or "").strip()
        if value != "":
            return value
    return ""


def derive_ws_url(api_url: str) -> str | None:
    clean = api_url.strip().rstrip("/")
    if clean == "":
        return None
    if clean.lower().startswith("https://"):
        return "wss://" + clean[len("https://"):] + "/"
    if clean.lower().startswith("http://"):
        return "ws://" + clean[len("http://"):] + "/"
    return None


def load_config(env: dict) -> dict:
    api_raw = pick_env(env, "PRIMARY_BASE_URL", "PRIMARY_API_URL")
    api_url = (api_raw if api_raw != "" else DEFAULT_API_URL).rstrip("/")
    ws_explicit = pick_env(env, "PRIMARY_WS_URL")
    ws_derived = derive_ws_url(api_url)
    ws_url = ws_explicit if ws_explicit != "" else (ws_derived if ws_derived is not None else DEFAULT_WS_URL)
    username = pick_env(env, "PRIMARY_USERNAME", "ECO_MATRIZ_USERNAME")
    password = pick_env(env, "PRIMARY_PASSWORD", "ECO_MATRIZ_PASSWORD")
    return {
        "apiUrl": api_url,
        "wsUrl": ws_url,
        "usernameConfigured": username != "",
        "passwordConfigured": password != "",
        "configured": username != "" and password != "",
    }


CONFIG_CASES: list[dict] = [
    {
        "id": "eco_xoms_base_url_with_matriz_credentials",
        "env": {
            "PRIMARY_BASE_URL": "https://api.eco.xoms.com.ar",
            "ECO_MATRIZ_USERNAME": "matriz_user",
            "ECO_MATRIZ_PASSWORD": "matriz_pass",
        },
    },
    {
        "id": "legacy_primary_api_url_and_credentials",
        "env": {
            "PRIMARY_API_URL": "https://api.remarkets.primary.com.ar",
            "PRIMARY_USERNAME": "primary_user",
            "PRIMARY_PASSWORD": "primary_pass",
        },
    },
    {
        "id": "explicit_ws_url_wins_and_trailing_slash_trimmed",
        "env": {
            "PRIMARY_BASE_URL": "https://api.eco.xoms.com.ar/",
            "PRIMARY_WS_URL": "wss://ws.eco.xoms.com.ar/",
            "PRIMARY_USERNAME": "primary_user",
            "PRIMARY_PASSWORD": "primary_pass",
            "ECO_MATRIZ_USERNAME": "matriz_user",
            "ECO_MATRIZ_PASSWORD": "matriz_pass",
        },
    },
    {
        "id": "defaults_without_env",
        "env": {},
    },
    {
        "id": "primary_credentials_win_over_matriz",
        "env": {
            "PRIMARY_USERNAME": "primary_user",
            "ECO_MATRIZ_USERNAME": "matriz_user",
            "PRIMARY_PASSWORD": "primary_pass",
            "ECO_MATRIZ_PASSWORD": "matriz_pass",
        },
    },
    {
        "id": "ws_derived_from_http_base_url",
        "env": {
            "PRIMARY_BASE_URL": "http://api.eco.xoms.com.ar",
            "PRIMARY_USERNAME": "primary_user",
            "PRIMARY_PASSWORD": "primary_pass",
        },
    },
]

# ---------------------------------------------------------------------------
# 2. Parser de símbolos MERV
# ---------------------------------------------------------------------------

MERV_RE = re.compile(r"^MERV\s*-\s*XMEV\s*-\s*([A-Z0-9.]+)\s*-\s*(24HS|CI|48HS|SPOT|T1)$", re.IGNORECASE)


def parse_merv_symbol(raw_symbol: str) -> dict | None:
    m = MERV_RE.match(raw_symbol.strip())
    if m is None:
        return None
    ticker = m.group(1).upper()
    settlement_raw = m.group(2)
    settlement = "24hs" if settlement_raw.upper() in ("24HS", "T1") else settlement_raw
    if ticker == "" or settlement == "":
        return None
    return {"ticker": ticker, "settlement": settlement, "rawSymbol": raw_symbol}


MERV_SYMBOL_CASES: list[str] = [
    "MERV - XMEV - GGAL - 24hs",
    "MERV - XMEV - GGAL - T1",
    "MERV - XMEV - GGAL - CI",
    "MERV - XMEV - GGAL - 48HS",
    "MERV - XMEV - SUPV- 24hs",
    "MERV - XMEV - TGNO4 - 24hs",
    "MERV - XMEV - SPY - 24hs",
    "MERV - XMEV - GFGC61120C - 24hs",
    "MERV - XMEV - GFGV61050P - CI",
    "MERV - XMEV - GGAL",
    "MERV - XMEV -  - 24hs",
    "DLR/NOV26",
    "MERV-XMEV-GGAL-24hs",
]

# ---------------------------------------------------------------------------
# 3. Selección del universo L2 BYMA
# ---------------------------------------------------------------------------

MERVAL_TICKERS = [
    "GGAL", "YPFD", "BMA", "PAMP", "BBAR", "SUPV", "TGSU2", "TXAR", "ALUA",
    "BYMA", "CEPU", "CRES", "EDN", "LOMA", "METR", "MIRG", "TGNO4", "TRAN", "VALO",
]
CEDEAR_TICKERS = [
    "SPY", "QQQ", "NVDA", "AAPL", "MSFT", "AMZN", "META", "TSLA", "MELI", "KO", "EWZ", "IBIT",
]
UNIVERSE = MERVAL_TICKERS + CEDEAR_TICKERS
OPTION_PREFIXES = ["GFGC", "GFGV"]
GGAL_TICKER = "GGAL"


def select_byma_products(
    instruments: list[dict],
    universe: list[str],
    prefixes: list[str],
    ggal_ticker: str = GGAL_TICKER,
) -> list[dict]:
    by_ticker: dict[str, dict[str, str]] = {}
    market_by_symbol: dict[str, str] = {}
    for inst in instruments:
        parsed = parse_merv_symbol(inst["symbol"])
        if parsed is None:
            continue
        if parsed["settlement"] not in ("24hs", "CI"):
            continue
        bucket = by_ticker.setdefault(parsed["ticker"], {})
        if parsed["rawSymbol"] not in bucket:
            bucket[parsed["rawSymbol"]] = parsed["settlement"]
            market_by_symbol[parsed["rawSymbol"]] = inst["marketId"]

    out: list[dict] = []
    for ticker in sorted(by_ticker):
        settlements = by_ticker[ticker]
        in_universe = ticker in universe
        is_option = any(ticker.startswith(p) for p in prefixes if p != "")
        if not in_universe and not is_option:
            continue
        has24 = any(s == "24hs" for s in settlements.values())
        for raw in sorted(settlements):
            settlement = settlements[raw]
            if is_option:
                include = settlement == "24hs" or (settlement == "CI" and not has24)
            else:
                include = settlement == "24hs" or (settlement == "CI" and (ticker == ggal_ticker or not has24))
            if include:
                out.append({"marketId": market_by_symbol[raw], "symbol": raw})
    return out


SELECTION_INSTRUMENTS: list[dict] = [
    # Líderes Merval con plazo normal 24hs (marketId MERV como en Eco producción)
    *[{"marketId": "MERV", "symbol": f"MERV - XMEV - {t} - 24hs"} for t in MERVAL_TICKERS if t not in ("MIRG", "PAMP")],
    # GGAL con CI adicional (requisito explícito)
    {"marketId": "MERV", "symbol": "MERV - XMEV - GGAL - CI"},
    # CEDEARs
    *[{"marketId": "MERV", "symbol": f"MERV - XMEV - {t} - 24hs"} for t in CEDEAR_TICKERS],
    # Ticker del universo sin 24hs: fallback explícito a CI
    {"marketId": "MERV", "symbol": "MERV - XMEV - MIRG - CI"},
    # 48HS y SPOT: nunca suscriptos
    {"marketId": "MERV", "symbol": "MERV - XMEV - GGAL - 48HS"},
    {"marketId": "MERV", "symbol": "MERV - XMEV - SPY - SPOT"},
    # Opciones activas de Galicia: calls GFGC* y puts GFGV*
    {"marketId": "MERV", "symbol": "MERV - XMEV - GFGC61120C - 24hs"},
    {"marketId": "MERV", "symbol": "MERV - XMEV - GFGC61500C - 24hs"},
    {"marketId": "MERV", "symbol": "MERV - XMEV - GFGV61050P - 24hs"},
    {"marketId": "MERV", "symbol": "MERV - XMEV - GFGV62000P - CI"},
    # Raíz de opción fuera del universo: excluida
    {"marketId": "MERV", "symbol": "MERV - XMEV - YPFD61120C - 24hs"},
    {"marketId": "MERV", "symbol": "MERV - XMEV - GGAL61120C - 24hs"},
    # Futuros DLR/*: fuera de la selección BYMA (van por el filtro ROFX)
    {"marketId": "ROFX", "symbol": "DLR/NOV26"},
    {"marketId": "ROFX", "symbol": "DLR/DIC26"},
    {"marketId": "ROFX", "symbol": "DLR/ABR27"},
    {"marketId": "ROFX", "symbol": "DLR/NOV26M"},
    {"marketId": "ROFX", "symbol": "DLR/SPOT"},
    # Tolerancia de marketId: instrumento MERV anunciado como ROFX (reMarkets)
    {"marketId": "ROFX", "symbol": "MERV - XMEV - PAMP - 24hs"},
]

# ---------------------------------------------------------------------------
# 4. Decisión de emisión del tick ARS de GGAL
# ---------------------------------------------------------------------------


def _valid_positive(value) -> bool:
    return value is not None and not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value) and value > 0


def _valid_time(value) -> bool:
    return value is not None and not isinstance(value, bool) and isinstance(value, int) and value > 0


def decide_ggal_tick(frame: dict, cache: dict | None) -> dict:
    la_price = frame.get("laPrice")
    la_size = frame.get("laSize")
    la_time = frame.get("laTimeSec")
    frame_time = frame.get("frameTimeSec")
    has_book = bool(frame.get("hasBookUpdate"))

    trade_time = None
    if _valid_time(la_time):
        trade_time = la_time
    elif _valid_time(frame_time):
        trade_time = frame_time

    if _valid_positive(la_price) and trade_time is not None:
        size = la_size if (la_size is not None and math.isfinite(la_size) and la_size >= 0) else 0
        tick = {"price": la_price, "size": size, "timeSec": trade_time}
        if cache is not None and cache.get("price") == la_price and cache.get("timeSec") == trade_time:
            return {"emit": False, "tick": None, "cache": cache}
        return {"emit": True, "tick": tick, "cache": {"price": la_price, "size": size, "timeSec": trade_time}}

    if has_book and cache is not None and _valid_positive(cache.get("price")) and _valid_time(cache.get("timeSec")):
        time_sec = frame_time if _valid_time(frame_time) else cache["timeSec"]
        return {"emit": True, "tick": {"price": cache["price"], "size": 0, "timeSec": time_sec}, "cache": cache}

    return {"emit": False, "tick": None, "cache": cache}


GGAL_TICK_CASES: list[dict] = [
    {
        "id": "la_trade_updates_cache_and_emits",
        "frame": {"laPrice": 7195.0, "laSize": 100.0, "laTimeSec": 1795202400, "hasBookUpdate": True, "frameTimeSec": 1795202401},
        "cache": None,
    },
    {
        "id": "book_only_reemits_cached_price_without_volume",
        "frame": {"laPrice": None, "laSize": None, "laTimeSec": None, "hasBookUpdate": True, "frameTimeSec": 1795202405},
        "cache": {"price": 7195.0, "size": 100.0, "timeSec": 1795202400},
    },
    {
        "id": "book_only_without_cache_never_emits",
        "frame": {"laPrice": None, "laSize": None, "laTimeSec": None, "hasBookUpdate": True, "frameTimeSec": 1795202406},
        "cache": None,
    },
    {
        "id": "duplicate_la_frame_is_suppressed",
        "frame": {"laPrice": 7195.0, "laSize": 100.0, "laTimeSec": 1795202400, "hasBookUpdate": False, "frameTimeSec": 1795202407},
        "cache": {"price": 7195.0, "size": 100.0, "timeSec": 1795202400},
    },
    {
        "id": "invalid_la_price_without_book_does_not_emit",
        "frame": {"laPrice": 0.0, "laSize": None, "laTimeSec": 1795202408, "hasBookUpdate": False, "frameTimeSec": 1795202408},
        "cache": None,
    },
    {
        "id": "la_without_date_uses_frame_timestamp",
        "frame": {"laPrice": 7198.5, "laSize": None, "laTimeSec": None, "hasBookUpdate": False, "frameTimeSec": 1795202410},
        "cache": {"price": 7195.0, "size": 100.0, "timeSec": 1795202400},
    },
    {
        "id": "la_without_any_timestamp_falls_back_to_book_path",
        "frame": {"laPrice": 7199.0, "laSize": 5.0, "laTimeSec": None, "hasBookUpdate": True, "frameTimeSec": None},
        "cache": {"price": 7195.0, "size": 100.0, "timeSec": 1795202400},
    },
    {
        "id": "book_only_without_frame_time_reuses_cached_time",
        "frame": {"laPrice": None, "laSize": None, "laTimeSec": None, "hasBookUpdate": True, "frameTimeSec": None},
        "cache": {"price": 7200.0, "size": 42.0, "timeSec": 1795202390},
    },
    {
        "id": "negative_la_size_clamps_to_zero",
        "frame": {"laPrice": 7210.0, "laSize": -3.0, "laTimeSec": 1795202420, "hasBookUpdate": False, "frameTimeSec": 1795202420},
        "cache": {"price": 7200.0, "size": 42.0, "timeSec": 1795202390},
    },
]

# ---------------------------------------------------------------------------
# 5. Microestructura L2 5 puntas (ordenamiento + spread/imbalance)
# ---------------------------------------------------------------------------


def l2_metrics(bids: list[dict], asks: list[dict]) -> dict:
    valid_bids = sorted(
        [level for level in bids if math.isfinite(level["price"]) and level["price"] > 0 and math.isfinite(level["size"]) and level["size"] >= 0],
        key=lambda level: -level["price"],
    )[:5]
    valid_asks = sorted(
        [level for level in asks if math.isfinite(level["price"]) and level["price"] > 0 and math.isfinite(level["size"]) and level["size"] >= 0],
        key=lambda level: level["price"],
    )[:5]

    def num(value: float) -> float | None:
        return None if (value is None or not math.isfinite(value)) else value

    best_bid = valid_bids[0]["price"] if valid_bids else math.nan
    best_ask = valid_asks[0]["price"] if valid_asks else math.nan
    has_top = math.isfinite(best_bid) and math.isfinite(best_ask)
    mid = 0.5 * (best_bid + best_ask) if has_top else math.nan
    spread = best_ask - best_bid if has_top else math.nan
    spread_pct = (spread / mid) * 100 if has_top and mid > 0 else math.nan

    bid_depth_size = sum(l["size"] for l in valid_bids) if valid_bids else math.nan
    ask_depth_size = sum(l["size"] for l in valid_asks) if valid_asks else math.nan
    bid_depth_notional = sum(l["price"] * l["size"] for l in valid_bids) if valid_bids else math.nan
    ask_depth_notional = sum(l["price"] * l["size"] for l in valid_asks) if valid_asks else math.nan

    vwap_bid5 = bid_depth_notional / bid_depth_size if (math.isfinite(bid_depth_size) and bid_depth_size > 0) else math.nan
    vwap_ask5 = ask_depth_notional / ask_depth_size if (math.isfinite(ask_depth_size) and ask_depth_size > 0) else math.nan

    safe_bid_size = bid_depth_size if math.isfinite(bid_depth_size) else 0.0
    safe_ask_size = ask_depth_size if math.isfinite(ask_depth_size) else 0.0
    safe_bid_notional = bid_depth_notional if math.isfinite(bid_depth_notional) else 0.0
    safe_ask_notional = ask_depth_notional if math.isfinite(ask_depth_notional) else 0.0
    total_size = safe_bid_size + safe_ask_size

    vwap_book5 = (safe_bid_notional + safe_ask_notional) / total_size if total_size > 0 else math.nan
    obi5 = (safe_bid_size - safe_ask_size) / total_size if total_size > 0 else math.nan

    return {
        "bestBid": num(best_bid),
        "bestAsk": num(best_ask),
        "mid": num(mid),
        "spread": num(spread),
        "spreadPct": num(spread_pct),
        "bidDepthSize": num(bid_depth_size),
        "askDepthSize": num(ask_depth_size),
        "bidDepthNotional": num(bid_depth_notional),
        "askDepthNotional": num(ask_depth_notional),
        "vwapBid5": num(vwap_bid5),
        "vwapAsk5": num(vwap_ask5),
        "vwapBook5": num(vwap_book5),
        "obi5": num(obi5),
        "orderedBids": [{"price": l["price"], "size": l["size"]} for l in valid_bids],
        "orderedAsks": [{"price": l["price"], "size": l["size"]} for l in valid_asks],
    }


def md_frame(symbol: str, market_id: str, timestamp_ms: int, bids: list[dict], asks: list[dict], la: dict | None) -> dict:
    market_data: dict = {"BI": bids, "OF": asks}
    if la is not None:
        market_data["LA"] = la
    return {
        "type": "Md",
        "timestamp": timestamp_ms,
        "instrumentId": {"marketId": market_id, "symbol": symbol},
        "marketData": market_data,
    }


GGAL_BIDS = [
    {"price": 7190.0, "size": 1200.0},
    {"price": 7175.0, "size": 850.0},
    {"price": 7160.0, "size": 400.0},
    {"price": 7150.0, "size": 500.0},
    {"price": 7120.0, "size": 2500.0},
]
GGAL_ASKS = [
    {"price": 7205.0, "size": 600.0},
    {"price": 7210.0, "size": 700.0},
    {"price": 7220.0, "size": 900.0},
    {"price": 7240.0, "size": 1500.0},
    {"price": 7260.0, "size": 300.0},
]
GFGC_BIDS = [
    {"price": 310.0, "size": 50.0},
    {"price": 305.0, "size": 25.0},
    {"price": 300.0, "size": 80.0},
    {"price": 295.0, "size": 10.0},
    {"price": 290.0, "size": 5.0},
]
GFGC_ASKS = [
    {"price": 315.0, "size": 30.0},
    {"price": 320.0, "size": 15.0},
    {"price": 325.0, "size": 60.0},
    {"price": 330.0, "size": 20.0},
    {"price": 340.0, "size": 8.0},
]

BOOK_CASES: list[dict] = [
    {
        "id": "ggal_24hs_five_levels",
        "symbol": "MERV - XMEV - GGAL - 24hs",
        "marketId": "MERV",
        "frame": md_frame(
            "MERV - XMEV - GGAL - 24hs",
            "MERV",
            1795202400000,
            GGAL_BIDS,
            GGAL_ASKS,
            {"price": 7195.0, "size": 100.0, "date": 1795202399000},
        ),
        "metricsInput": {"bids": GGAL_BIDS, "asks": GGAL_ASKS},
    },
    {
        "id": "gfgc_option_five_levels_unsorted_input",
        "symbol": "MERV - XMEV - GFGC61120C - 24hs",
        "marketId": "MERV",
        "frame": md_frame(
            "MERV - XMEV - GFGC61120C - 24hs",
            "MERV",
            1795202400000,
            list(reversed(GFGC_BIDS)),
            list(reversed(GFGC_ASKS)),
            {"price": 312.0, "size": 10.0, "date": 1795202399000},
        ),
        "metricsInput": {"bids": GFGC_BIDS, "asks": GFGC_ASKS},
    },
]


def main() -> None:
    root = pathlib.Path(__file__).resolve().parents[1]
    config_cases = []
    for case in CONFIG_CASES:
        config = load_config(case["env"])
        config_cases.append({
            "id": case["id"],
            "env": case["env"],
            "expected": config,
        })

    selection_expected = select_byma_products(SELECTION_INSTRUMENTS, UNIVERSE, OPTION_PREFIXES)

    tick_cases = []
    for case in GGAL_TICK_CASES:
        decision = decide_ggal_tick(case["frame"], case["cache"])
        tick_cases.append({
            "id": case["id"],
            "frame": case["frame"],
            "cache": case["cache"],
            "expected": decision,
        })

    book_cases = []
    for case in BOOK_CASES:
        metrics = l2_metrics(case["metricsInput"]["bids"], case["metricsInput"]["asks"])
        book_cases.append({
            "id": case["id"],
            "symbol": case["symbol"],
            "marketId": case["marketId"],
            "frame": case["frame"],
            "expected": metrics,
        })

    fixture = {
        "schemaVersion": 1,
        "description": (
            "Referencia independiente del conector Primary Eco Valores XOMS: config de entorno "
            "(PRIMARY_BASE_URL/PRIMARY_WS_URL/ECO_MATRIZ_*), parser MERV con alias T1, selección "
            "del universo BYMA L2 (Merval + CEDEARs + GFGC*/GFGV*), decisión del tick ARS de GGAL "
            "y microestructura 5 puntas (orden + spread/imbalance). Sin valores de credenciales."
        ),
        "configCases": config_cases,
        "mervSymbolCases": [
            {"symbol": symbol, "parsed": parse_merv_symbol(symbol)}
            for symbol in MERV_SYMBOL_CASES
        ],
        "selection": {
            "universeTickers": UNIVERSE,
            "optionPrefixes": OPTION_PREFIXES,
            "instruments": SELECTION_INSTRUMENTS,
            "expectedProducts": selection_expected,
        },
        "tickCases": tick_cases,
        "bookCases": book_cases,
    }
    out = root / "fixtures" / "primary_eco_l2_reference.json"
    out.write_text(json.dumps(fixture, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
    print(f"written {out} ({len(config_cases)} config, {len(MERV_SYMBOL_CASES)} symbols, "
          f"{len(selection_expected)} products, {len(tick_cases)} ticks, {len(book_cases)} books)")


if __name__ == "__main__":
    main()
