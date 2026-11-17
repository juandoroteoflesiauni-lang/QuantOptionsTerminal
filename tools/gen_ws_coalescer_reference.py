#!/usr/bin/env python3
"""Referencia independiente Pieza 40 (sin depender de la lógica TypeScript).

Genera fixtures/ws_coalescer_reference.json con:
- coalescing latest-write-wins por clave,
- canales explícitos del núcleo Massive,
- leases dinámicos con conteo de referencias,
- fallback honesto 1m -> 1D en activos AR sin velas 1m,
- normalización OHLC de la serie histórica IOL,
- cadencias 100 ms general / 50 ms foco y cierre acotado 4000 ms.
"""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from typing import Any, Dict, List, Mapping, Sequence

UTC = dt.timezone(offset=dt.timedelta(hours=0))


def coalesce_latest_by_key(items: Sequence[Mapping[str, Any]]) -> Dict[str, Any]:
    """Latest-write-wins preservando la primera aparición de cada clave."""
    out: Dict[str, Any] = {}
    for item in items:
        out[str(item["key"])] = dict(item)
    return out


def massive_channels(symbol: str) -> List[str]:
    """Canales T/Q/A/AM para un símbolo de acción/ETF; índices no aplican."""
    clean = symbol.strip().upper()
    if not clean or clean.startswith("I:"):
        return []
    return [f"{prefix}.{clean}" for prefix in ("T", "Q", "A", "AM")]


def dynamic_leases(
    operations: Sequence[Mapping[str, Any]], core_symbols: Sequence[str]
) -> Dict[str, List[str]]:
    """Resuelve leases dinámicos; el núcleo nunca entra al mapa dinámico."""
    core = {symbol.strip().upper() for symbol in core_symbols}
    leases: Dict[str, List[str]] = {}
    for operation in operations:
        symbol = str(operation["symbol"]).strip().upper()
        owner = str(operation["owner"]).strip()
        if not symbol or not owner or symbol in core:
            continue
        owners = leases.setdefault(symbol, [])
        if operation["action"] == "acquire" and owner not in owners:
            owners.append(owner)
        if operation["action"] == "release" and owner in owners:
            owners.remove(owner)
        if not owners:
            leases.pop(symbol, None)
    return leases


def ar_intraday_fallback(timeframe: str) -> Dict[str, Any]:
    """1m AR no existe: fallback explícito a 1D; otros intradiarios no cambian."""
    clean = timeframe.strip()
    if clean == "1m":
        return {
            "requestedTimeframe": "1m",
            "effectiveTimeframe": "1D",
            "fallbackReason": "NO_1M_BARS_AR",
        }
    if clean in {"5m", "15m", "1h", "4h", "1D"}:
        return {
            "requestedTimeframe": clean,
            "effectiveTimeframe": clean,
            "fallbackReason": None,
        }
    raise ValueError(f"Unsupported AR timeframe {timeframe!r}")


def parse_iol_utc_sec(value: Any) -> int:
    """IOL devuelve hora local Argentina sin zona; la referencia usa -03:00."""
    if isinstance(value, (int, float)) and value > 0:
        return int(value // 1000) if value > 10_000_000_000 else int(value)
    if not isinstance(value, str) or not value.strip():
        raise ValueError("missing IOL timestamp")
    raw = value.strip()
    if not (raw.endswith("Z") or raw[-6] in "+-" and raw[-3] == ":"):
        raw = f"{raw}-03:00"
    parsed = dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return int(parsed.timestamp())


def normalize_iol_history(rows: Sequence[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    """OHLC real IOL; volumen faltante es 0 (índice) y no se inventa precio."""
    bars: List[Dict[str, Any]] = []
    seen: set[int] = set()
    for row in rows:
        time = parse_iol_utc_sec(row.get("fechaHora", row.get("fecha")))
        open_ = float(row["apertura"])
        high = float(row["maximo"])
        low = float(row["minimo"])
        close = float(row["ultimoPrecio"])
        if time in seen:
            continue
        volume = row.get("volumenNominal")
        vw = row.get("precioPromedio")
        seen.add(time)
        bar: Dict[str, Any] = {
            "time": time,
            "open": open_,
            "high": high,
            "low": low,
            "close": close,
            "volume": float(volume) if volume is not None else 0.0,
        }
        if vw is not None:
            bar["vw"] = float(vw)
        bars.append(bar)
    return sorted(bars, key=lambda bar: bar["time"])


def build_fixture() -> Dict[str, Any]:
    coalesce_input = [
        {"key": "trade:stocks:SPY", "value": 1.0},
        {"key": "trade:stocks:NVDA", "value": 2.0},
        {"key": "trade:stocks:SPY", "value": 3.0},
        {"key": "bar_update:stocks:SPY", "value": 4.0},
    ]
    coalesce_expected = coalesce_latest_by_key(coalesce_input)

    core_symbols = ["SPY", "QQQ", "IWM", "DIA", "VIXY", "GGAL", "YPF", "BMA", "PAM", "BBAR", "SUPV", "TGS", "CEPU", "CRESY", "EDN", "LOMA", "MELI", "NVDA", "AAPL", "MSFT", "AMZN", "META", "TSLA", "GOOGL", "KO", "EWZ", "IBIT"]
    channels_by_symbol = {symbol: massive_channels(symbol) for symbol in core_symbols}

    lease_operations = [
        {"action": "acquire", "symbol": "TSLA", "owner": "ws-1"},
        {"action": "acquire", "symbol": "TSLA", "owner": "ws-2"},
        {"action": "acquire", "symbol": "AAPL", "owner": "ws-1"},
        {"action": "release", "symbol": "TSLA", "owner": "ws-1"},
        {"action": "release", "symbol": "AAPL", "owner": "ws-1"},
    ]
    leases_expected = dynamic_leases(lease_operations, core_symbols)

    from_iso = "2026-01-05T10:00:00"
    from_sec = parse_iol_utc_sec(from_iso)
    iol_rows = [
        {
            "fechaHora": from_iso,
            "apertura": 2_835_603.73,
            "maximo": 2_880_639.69,
            "minimo": 2_812_730.50,
            "ultimoPrecio": 2_848_945.27,
            "volumenNominal": None,
            "precioPromedio": 2_845_000.00,
        },
        {
            "fechaHora": "2026-01-06T10:00:00",
            "apertura": 2_848_945.27,
            "maximo": 2_864_156.50,
            "minimo": 2_798_086.00,
            "ultimoPrecio": 2_835_843.00,
            "volumenNominal": 0,
        },
        {
            "fechaHora": "2026-01-06T10:00:00",
            "apertura": 999.0,
            "maximo": 1_000.0,
            "minimo": 998.0,
            "ultimoPrecio": 999.5,
            "volumenNominal": 1,
        },
    ]
    iol_expected = normalize_iol_history(iol_rows)

    return {
        "meta": {
            "name": "Pieza 40 coalescing, dynamic Massive WS and stability reference",
            "precisionTolerance": 1e-9,
            "generalIntervalMs": 100,
            "focusIntervalMs": 50,
            "closeTimeoutMs": 4000,
            "maxGgalChartRetries": 2,
            "retryBackoffBaseMs": 400,
        },
        "coalesce_latest": {
            "input": coalesce_input,
            "expected": coalesce_expected,
        },
        "massive_core": {
            "symbols": core_symbols,
            "forbiddenWildcards": ["Q.*", "AM.*", "T.*"],
            "channelsBySymbol": channels_by_symbol,
        },
        "massive_dynamic_leases": {
            "operations": lease_operations,
            "coreSymbols": core_symbols,
            "expected": leases_expected,
        },
        "ar_intraday_fallback": {
            "1m": ar_intraday_fallback("1m"),
            "5m": ar_intraday_fallback("5m"),
            "1D": ar_intraday_fallback("1D"),
        },
        "iol_history": {
            "input": iol_rows,
            "expected": iol_expected,
            "firstTimeSec": from_sec,
        },
    }


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    out = root / "fixtures" / "ws_coalescer_reference.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = build_fixture()
    out.write_text(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"written {out}")


if __name__ == "__main__":
    main()
