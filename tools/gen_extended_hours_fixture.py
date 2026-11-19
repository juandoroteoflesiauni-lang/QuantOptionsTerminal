#!/usr/bin/env python3
"""
Referencia INDEPENDIENTE para Pieza 42 — Horario Extendido US/ADR (Pre-Market & After-Hours).

No copia la lógica TypeScript:
- Clasifica fases de sesión US usando ZoneInfo("America/New_York") sobre UTC enteros.
- Normaliza trades + quotes extendidos de forma independiente.
- Calcula fusión RTH + Extended y porcentajes de variación extendida.
"""

import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")


def ny_utc(year: int, month: int, day: int, hour: int, minute: int, second: int = 0) -> int:
    return int(datetime(year, month, day, hour, minute, second, tzinfo=NY).timestamp())


def session_phase(utc_sec: int) -> str:
    dt = datetime.fromtimestamp(utc_sec, tz=NY)
    weekday = dt.isoweekday()
    if weekday < 1 or weekday > 5:
        return "CLOSED"
    mins = dt.hour * 60 + dt.minute
    if 240 <= mins < 570:
        return "PRE_MARKET"
    if 570 <= mins < 960:
        return "RTH"
    if 960 <= mins < 1200:
        return "AFTER_HOURS"
    return "CLOSED"


def main() -> None:
    session_cases = [
        {"name": "EST 03:59 antes de pre-market", "utcSec": ny_utc(2026, 1, 15, 3, 59), "expected": session_phase(ny_utc(2026, 1, 15, 3, 59))},
        {"name": "EST 04:00 apertura pre-market", "utcSec": ny_utc(2026, 1, 15, 4, 0), "expected": session_phase(ny_utc(2026, 1, 15, 4, 0))},
        {"name": "EST 09:29 cierre pre-market", "utcSec": ny_utc(2026, 1, 15, 9, 29), "expected": session_phase(ny_utc(2026, 1, 15, 9, 29))},
        {"name": "EST 09:30 apertura RTH", "utcSec": ny_utc(2026, 1, 15, 9, 30), "expected": session_phase(ny_utc(2026, 1, 15, 9, 30))},
        {"name": "EST 15:59 ultimo minuto RTH", "utcSec": ny_utc(2026, 1, 15, 15, 59), "expected": session_phase(ny_utc(2026, 1, 15, 15, 59))},
        {"name": "EST 16:00 inicio after-hours", "utcSec": ny_utc(2026, 1, 15, 16, 0), "expected": session_phase(ny_utc(2026, 1, 15, 16, 0))},
        {"name": "EST 19:59 ultimo minuto after-hours", "utcSec": ny_utc(2026, 1, 15, 19, 59), "expected": session_phase(ny_utc(2026, 1, 15, 19, 59))},
        {"name": "EST 20:00 cerrado", "utcSec": ny_utc(2026, 1, 15, 20, 0), "expected": session_phase(ny_utc(2026, 1, 15, 20, 0))},
        {"name": "EDT 08:15 pre-market verano", "utcSec": ny_utc(2026, 7, 15, 8, 15), "expected": session_phase(ny_utc(2026, 7, 15, 8, 15))},
        {"name": "EDT 18:30 after-hours verano", "utcSec": ny_utc(2026, 7, 15, 18, 30), "expected": session_phase(ny_utc(2026, 7, 15, 18, 30))},
        {"name": "Sabado 12:00 cerrado", "utcSec": ny_utc(2026, 11, 14, 12, 0), "expected": session_phase(ny_utc(2026, 11, 14, 12, 0))},
    ]

    ext_ts_ms = ny_utc(2026, 11, 19, 17, 30) * 1_000 + 250
    aftermarket_batch = {
        "trades": [
            {"symbol": "AAPL", "price": 351.25, "tradeSize": 400, "timestamp": ext_ts_ms},
            {"symbol": "AAPL", "price": 348.0, "tradeSize": 100, "timestamp": ext_ts_ms - 60_000},
            {"symbol": "GGAL", "price": 62.40, "size": 150, "timestamp": ext_ts_ms // 1_000},
            {"symbol": "BAD", "price": 0, "tradeSize": 10, "timestamp": ext_ts_ms},
        ],
        "quotes": [
            {"symbol": "AAPL", "bidPrice": 351.20, "bidSize": 200, "askPrice": 351.30, "askSize": 300, "timestamp": ext_ts_ms + 1_000},
            {"symbol": "NVDA", "bidPrice": 145.10, "bidSize": 100, "askPrice": 145.30, "askSize": 100, "timestamp": ext_ts_ms},
        ],
        "expected": [
            {
                "symbol": "AAPL",
                "price": 351.25,
                "tradeSize": 400,
                "bid": 351.20,
                "bidSize": 200,
                "ask": 351.30,
                "askSize": 300,
                "asOfUtcSec": (ext_ts_ms + 1_000) // 1_000,
            },
            {
                "symbol": "GGAL",
                "price": 62.40,
                "tradeSize": 150,
                "bid": None,
                "bidSize": None,
                "ask": None,
                "askSize": None,
                "asOfUtcSec": ext_ts_ms // 1_000,
            },
            {
                "symbol": "NVDA",
                "price": 0.5 * (145.10 + 145.30),
                "tradeSize": None,
                "bid": 145.10,
                "bidSize": 100,
                "ask": 145.30,
                "askSize": 100,
                "asOfUtcSec": ext_ts_ms // 1_000,
            },
        ],
    }

    merge_cases = [
        {
            "name": "AFTER_HOURS: regular RTH 349.21 (-0.91928% vs prevClose 352.45), ext 351.25",
            "sessionPhase": "AFTER_HOURS",
            "regularPrice": 349.21,
            "previousClose": 352.45,
            "regularChangePct": (349.21 - 352.45) / 352.45 * 100.0,
            "extendedPrice": 351.25,
            "expectedPrice": 351.25,
            "expectedRegularClose": 349.21,
            "expectedChangePct": (349.21 - 352.45) / 352.45 * 100.0,
            "expectedExtendedChangePct": (351.25 - 349.21) / 349.21 * 100.0,
        },
        {
            "name": "PRE_MARKET: regular close 60.50, ext 62.315",
            "sessionPhase": "PRE_MARKET",
            "regularPrice": 60.50,
            "previousClose": 60.50,
            "regularChangePct": 0.0,
            "extendedPrice": 62.315,
            "expectedPrice": 62.315,
            "expectedRegularClose": 60.50,
            "expectedChangePct": (62.315 - 60.50) / 60.50 * 100.0,
            "expectedExtendedChangePct": (62.315 - 60.50) / 60.50 * 100.0,
        },
    ]

    intraday_bars = {
        "rows": [
            {"date": "2026-07-15 08:15:00", "open": 61.0, "high": 61.5, "low": 60.8, "close": 61.4, "volume": 1200},
            {"date": "2026-07-15 10:00:00", "open": 61.5, "high": 62.0, "low": 61.4, "close": 61.8, "volume": 5000},
            {"date": "2026-07-15 17:45:00", "open": 61.8, "high": 62.2, "low": 61.7, "close": 62.1, "volume": 900},
        ],
        "expectedExtendedTimes": [
            ny_utc(2026, 7, 15, 8, 15),
            ny_utc(2026, 7, 15, 10, 0),
            ny_utc(2026, 7, 15, 17, 45),
        ],
        "expectedRthOnlyTimes": [
            ny_utc(2026, 7, 15, 10, 0),
        ],
    }

    payload = {
        "version": 1,
        "sessionCases": session_cases,
        "aftermarketBatch": aftermarket_batch,
        "mergeCases": merge_cases,
        "intradayBars": intraday_bars,
    }
    target = Path(__file__).resolve().parent.parent / "fixtures" / "extended_hours_reference.json"
    target.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {target}")


if __name__ == "__main__":
    main()
