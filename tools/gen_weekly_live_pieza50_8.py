#!/usr/bin/env python3
"""Referencia independiente Pieza 50.8 Bloque B2 — semana activa y EMA live.

Implementacion explicita con zoneinfo (America/New_York), sin copiar la logica
TypeScript:

  - Semana activa: ruedas diarias cuyo lunes civil (mercado) coincide con el de
    la ultima diaria; timestamp = primera diaria real (martes si el lunes fue
    feriado); OHLC agregado; volumen = suma de las diarias incluidas.
  - EMA: paridad de la proyeccion live contra el recalculo puro
        ema_live = alpha*x + (1-alpha)*ema_ultima_cerrada
    con alpha = 2/(p+1) y semilla SMA sobre los primeros p cierres; NaN antes.

Genera fixtures/weekly_live_pieza50_8_reference.json.
"""
from __future__ import annotations

import json
import os
from datetime import datetime
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
OUT = os.path.join(
    os.path.dirname(__file__), "..", "fixtures", "weekly_live_pieza50_8_reference.json"
)


def et(y, m, d, h=0, minute=0):
    return int(datetime(y, m, d, h, minute, tzinfo=NY).timestamp())


def week_monday(time_sec):
    dt = datetime.fromtimestamp(time_sec, NY)
    return (dt.date().fromordinal(dt.date().toordinal() - dt.weekday())).isoformat()


def daily(ts, o, h, l, c, v):
    return {"timeSec": ts, "open": o, "high": h, "low": l, "close": c, "volume": v}


def weekly_of_last_week(dailies):
    if not dailies:
        return None
    last = dailies[-1]
    key = week_monday(last["timeSec"])
    week = [d for d in dailies if week_monday(d["timeSec"]) == key]
    first = week[0]
    return {
        "timeSec": first["timeSec"],
        "open": first["open"],
        "high": max(d["high"] for d in week),
        "low": min(d["low"] for d in week),
        "close": week[-1]["close"],
        "volume": sum(d["volume"] for d in week),
        "weekKey": key,
    }


def ema_series(closes, period):
    n = len(closes)
    if n < period:
        return None
    alpha = 2 / (period + 1)
    prev = sum(closes[:period]) / period
    for x in closes[period:]:
        prev = alpha * x + (1 - alpha) * prev
    return prev


def build():
    weekly_cases = []

    def add_week(name, dailies):
        weekly_cases.append(
            {
                "name": name,
                "dailies": dailies,
                "expected": weekly_of_last_week(dailies),
            }
        )

    week = [
        daily(et(2025, 1, 6), 100, 105, 99, 104, 1000),
        daily(et(2025, 1, 7), 104, 108, 103, 107, 1100),
        daily(et(2025, 1, 8), 107, 109, 105, 106, 1200),
        daily(et(2025, 1, 9), 106, 110, 104, 109, 1300),
        daily(et(2025, 1, 10), 109, 112, 108, 111, 1400),
    ]
    add_week("semana_lunes_viernes", week)
    add_week("semana_lunes_feriado", week[1:])
    add_week(
        "semana_incompleta",
        [daily(et(2025, 1, 8), 107, 109, 105, 106, 1200), daily(et(2025, 1, 9), 106, 110, 104, 109, 1300)],
    )
    add_week(
        "semana_est",
        [daily(et(2025, 1, 13), 200, 205, 199, 204, 500), daily(et(2025, 1, 14), 204, 206, 203, 205, 600)],
    )
    add_week(
        "semana_edt",
        [daily(et(2025, 6, 9), 300, 305, 299, 304, 700), daily(et(2025, 6, 10), 304, 306, 303, 305, 800)],
    )
    add_week(
        "cierre_anio",
        [
            daily(et(2024, 12, 30), 400, 405, 399, 404, 900),
            daily(et(2024, 12, 31), 404, 406, 403, 405, 1000),
            daily(et(2025, 1, 2), 405, 408, 404, 407, 1100),
            daily(et(2025, 1, 3), 407, 409, 406, 408, 1200),
        ],
    )
    add_week(
        "rollover_viernes_lunes",
        week
        + [daily(et(2025, 1, 13), 500, 505, 499, 504, 1500), daily(et(2025, 1, 14), 504, 508, 503, 507, 1600)],
    )

    ema_cases = []
    closed = [100 + 0.5 * i + (i % 5) * 0.3 for i in range(260)]
    for period in (9, 21, 50, 200):
        for provisional in (101.5, 99.25, 103.75):
            base = ema_series(closed, period)
            ema_cases.append(
                {
                    "name": f"ema{period}_provisional_{provisional}",
                    "period": period,
                    "closed": closed,
                    "provisionalClose": provisional,
                    "expectedBase": base,
                    "expectedLive": ema_series(closed + [provisional], period),
                }
            )
    ema_cases.append(
        {
            "name": "ema200_warmup_insuficiente",
            "period": 200,
            "closed": closed[:150],
            "provisionalClose": 101.5,
            "expectedBase": None,
            "expectedLive": None,
        }
    )

    return {"meta": {"generator": "tools/gen_weekly_live_pieza50_8.py"}, "weeklyCases": weekly_cases, "emaCases": ema_cases}


def main():
    fixture = build()
    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump(fixture, handle, indent=1)
        handle.write("\n")
    print(
        f"OK -> {os.path.relpath(OUT)} ({len(fixture['weeklyCases'])} semanas, "
        f"{len(fixture['emaCases'])} EMAs)"
    )


if __name__ == "__main__":
    main()
