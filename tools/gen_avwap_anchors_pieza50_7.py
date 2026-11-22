#!/usr/bin/env python3
"""Referencia independiente Pieza 50.7 Bloque B — anclas temporales AVWAP.

Implementacion explicita con zoneinfo (America/New_York y
America/Argentina/Buenos_Aires), sin copiar la logica TypeScript:

  - YEAR/MONTH: primera barra cuya fecha civil del mercado pertenece al periodo
    de la ultima barra; `complete` solo si existe una barra anterior al inicio
    del periodo en el buffer (borde acreditado), si no `partial`.
  - SESSION US: primera barra RTH (>= 09:30 local) de la fecha civil de la
    ultima barra; `complete` solo si es exactamente 09:30; sin RTH -> indisponible.
  - SESSION AR: primera barra de la fecha civil local de la ultima barra.
  - RANGE_LOW/HIGH: extremo sobre las ultimas 60 barras (criterio estricto).
  - CLICKED: valido solo dentro de [primera, ultima + paso]; snap a la barra mas
    cercana (empate -> la primera); fuera de rango -> indisponible.
  - Proyeccion 1W de YTD/MTD: ancla sobre el diario; cada vela semanal toma el
    ULTIMO valor diario acumulado disponible de sus ruedas incluidas (indice >=
    ancla), sin volumen anterior al ancla.

Genera fixtures/avwap_anchors_pieza50_7_reference.json.
"""
from __future__ import annotations

import json
import math
import os
from datetime import datetime
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
AR = ZoneInfo("America/Argentina/Buenos_Aires")
OUT = os.path.join(
    os.path.dirname(__file__), "..", "fixtures", "avwap_anchors_pieza50_7_reference.json"
)


def et(y, m, d, h=9, minute=30):
    return int(datetime(y, m, d, h, minute, tzinfo=NY).timestamp())


def ar(y, m, d, h=11, minute=0):
    return int(datetime(y, m, d, h, minute, tzinfo=AR).timestamp())


def parts(t, tz):
    dt = datetime.fromtimestamp(t, tz)
    return {
        "year": dt.year,
        "month": dt.month,
        "day": dt.day,
        "minutes": dt.hour * 60 + dt.minute,
        "key": dt.strftime("%Y-%m-%d"),
    }


def norm(bars):
    """Normaliza barras a `[time, low, high]` (los casos temporales usan dummy)."""
    return [bar if isinstance(bar, (list, tuple)) else [bar, 100.0, 101.0] for bar in bars]


def resolve(bars, mode, market, clicked=None):
    unavailable = {"anchorTimeSec": None, "anchorIndex": -1, "coverage": "unavailable"}
    bars = norm(bars)
    if not bars:
        return unavailable
    times = [bar[0] for bar in bars]
    tz = NY if market == "US" else AR
    last = parts(times[-1], tz)

    if mode == "RANGE_LOW" or mode == "RANGE_HIGH":
        start = max(0, len(times) - 60)
        best_idx, best = -1, math.inf if mode == "RANGE_LOW" else -math.inf
        for i in range(start, len(times)):
            value = bars[i][1] if mode == "RANGE_LOW" else bars[i][2]
            better = value < best if mode == "RANGE_LOW" else value > best
            if better:
                best, best_idx = value, i
        if best_idx < 0:
            return unavailable
        return {"anchorTimeSec": times[best_idx], "anchorIndex": best_idx, "coverage": "complete"}

    if mode == "CLICKED_CANDLE":
        if clicked is None or not math.isfinite(clicked):
            return unavailable
        step = abs(times[-1] - times[-2]) if len(times) >= 2 else 0
        if clicked < times[0] or clicked > times[-1] + step:
            return unavailable
        best_idx, best_dist = -1, math.inf
        for i, t in enumerate(times):
            dist = abs(t - clicked)
            if dist < best_dist:
                best_idx, best_dist = i, dist
        return {"anchorTimeSec": times[best_idx], "anchorIndex": best_idx, "coverage": "complete"}

    if mode == "SESSION_START":
        for i, t in enumerate(times):
            p = parts(t, tz)
            if p["key"] != last["key"]:
                continue
            if market == "US":
                if p["minutes"] < 570:
                    continue
                coverage = "complete" if p["minutes"] == 570 else "partial"
                return {"anchorTimeSec": t, "anchorIndex": i, "coverage": coverage}
            return {"anchorTimeSec": t, "anchorIndex": i, "coverage": "complete"}
        return unavailable

    start_key = f"{last['year']:04d}-{last['month']:02d}-01" if mode == "MONTH_START" else f"{last['year']:04d}-01-01"
    for i, t in enumerate(times):
        p = parts(t, tz)
        in_period = (
            p["year"] == last["year"] and p["month"] == last["month"]
            if mode == "MONTH_START"
            else p["year"] == last["year"]
        )
        if not in_period:
            continue
        covered = any(parts(prev[0], tz)["key"] < start_key for prev in bars[:i])
        return {"anchorTimeSec": t, "anchorIndex": i, "coverage": "complete" if covered else "partial"}
    return unavailable


def project(weekly_bars, daily_bars, mode, market):
    daily_bars = norm(daily_bars)
    resolution = resolve(daily_bars, mode, market)
    value_indices = []
    if resolution["anchorIndex"] >= 0:
        tz = NY if market == "US" else AR

        def week_monday(t):
            dt = datetime.fromtimestamp(t, tz)
            monday = dt.date().fromordinal(dt.date().toordinal() - dt.weekday())
            return monday.isoformat()

        daily_weeks = [week_monday(bar[0]) for bar in daily_bars]
        for w, wt in enumerate(weekly_bars):
            key = week_monday(wt)
            for d in range(len(daily_bars) - 1, -1, -1):
                if daily_weeks[d] != key:
                    continue
                if d < resolution["anchorIndex"]:
                    break
                value_indices.append(w)
                break
    anchor_weekly = weekly_bars[value_indices[0]] if value_indices else None
    return {
        "anchorWeeklyTimeSec": anchor_weekly,
        "anchorDailyTimeSec": daily_bars[resolution["anchorIndex"]][0] if resolution["anchorIndex"] >= 0 else None,
        "coverage": resolution["coverage"],
        "weeklyValueIndices": value_indices,
        "dailyAnchorIndex": resolution["anchorIndex"],
    }


def build_fixture():
    cases = []

    def add(name, mode, market, bars, expected, clicked=None):
        cases.append(
            {
                "name": name,
                "mode": mode,
                "market": market,
                "clickedTimeSec": clicked,
                "bars": norm(bars),
                "expected": expected,
            }
        )

    # 1. Cambio de año cerca de medianoche UTC (barra 31-dic 20:00 ET = 01:00Z).
    bars = [et(2024, 12, 31, 20, 0), et(2025, 1, 2), et(2025, 1, 3)]
    add("us_year_change_medianoche_utc", "YEAR_START", "US", bars, resolve(bars, "YEAR_START", "US"))
    # 2. Cambio de mes cerca de medianoche UTC.
    bars = [et(2025, 1, 31, 20, 0), et(2025, 2, 3), et(2025, 2, 4)]
    add("us_month_change_medianoche_utc", "MONTH_START", "US", bars, resolve(bars, "MONTH_START", "US"))
    # 3. DST: cierre EDT y aperturas EST.
    bars = [et(2024, 10, 31, 9, 30), et(2024, 11, 3, 9, 30), et(2024, 11, 4, 9, 30)]
    add("us_dst_noviembre", "MONTH_START", "US", bars, resolve(bars, "MONTH_START", "US"))
    # 4. SESSION: premarket (indisponible), comienzo RTH parcial y completo.
    premarket = [et(2025, 3, 10, 8, 0)]
    add("us_session_premarket", "SESSION_START", "US", premarket, resolve(premarket, "SESSION_START", "US"))
    partial = [et(2025, 3, 10, 8, 0), et(2025, 3, 10, 9, 35), et(2025, 3, 10, 10, 0)]
    add("us_session_rth_parcial", "SESSION_START", "US", partial, resolve(partial, "SESSION_START", "US"))
    complete = [et(2025, 3, 10, 8, 0), et(2025, 3, 10, 9, 30), et(2025, 3, 10, 10, 0)]
    add("us_session_rth_completa", "SESSION_START", "US", complete, resolve(complete, "SESSION_START", "US"))
    # 5. Fechas argentinas (31-dic 23:00 AR = 01-ene 02:00Z).
    bars = [ar(2024, 12, 31, 23, 0), ar(2025, 1, 2), ar(2025, 1, 3)]
    add("ar_year_change", "YEAR_START", "AR", bars, resolve(bars, "YEAR_START", "AR"))
    bars = [ar(2025, 2, 28, 12, 0), ar(2025, 3, 3), ar(2025, 3, 4)]
    add("ar_month_change", "MONTH_START", "AR", bars, resolve(bars, "MONTH_START", "AR"))
    bars = [ar(2025, 3, 10, 10, 0), ar(2025, 3, 10, 11, 0)]
    add("ar_session_local", "SESSION_START", "AR", bars, resolve(bars, "SESSION_START", "AR"))
    # 6. Feriados: 1-ene-2025 sin barra; primera rueda = 2-ene.
    bars = [et(2024, 12, 31), et(2025, 1, 2), et(2025, 1, 3)]
    add("us_feriado_primera_rueda", "YEAR_START", "US", bars, resolve(bars, "YEAR_START", "US"))
    # 7. Historico parcial (buffer empieza dentro del periodo) e insuficiente.
    bars = [et(2025, 2, 10), et(2025, 2, 11)]
    add("us_historico_parcial", "MONTH_START", "US", bars, resolve(bars, "MONTH_START", "US"))
    add("vacio", "YEAR_START", "US", [], resolve([], "YEAR_START", "US"))
    # 8. CLICKED: dentro, antes, despues y empate.
    bars = [1000, 1100, 1200]
    for name, clicked in [
        ("clicked_dentro", 1150),
        ("clicked_exacto", 1100),
        ("clicked_antes", 950),
        ("clicked_despues", 1400),
        ("clicked_empate", 1050),
    ]:
        add(name, "CLICKED_CANDLE", "US", bars, resolve(bars, "CLICKED_CANDLE", "US", clicked), clicked=clicked)
    # 13. RANGE: extremo dentro de las ultimas 60 barras (valores reales en la tupla).
    range_bars = [[et(2025, 1, 1) + i * 86400, 100.0, 101.0] for i in range(70)]
    range_bars[5][1] = 90.0  # minimo fuera de la ventana (ultimas 60)
    range_bars[65][1] = 91.0  # minimo dentro de la ventana
    range_bars[5][2] = 200.0  # maximo fuera de la ventana
    range_bars[62][2] = 199.0  # maximo dentro de la ventana
    add("range_low_60", "RANGE_LOW", "US", range_bars, resolve(range_bars, "RANGE_LOW", "US"))
    add("range_high_60", "RANGE_HIGH", "US", range_bars, resolve(range_bars, "RANGE_HIGH", "US"))

    projections = []
    # 10. Semana que cruza enero (ruedas 30-31 dic + 2-3 ene).
    weekly = [et(2024, 12, 30), et(2025, 1, 6), et(2025, 1, 13)]
    daily = [
        et(2024, 12, 30), et(2024, 12, 31), et(2025, 1, 2), et(2025, 1, 3),
        et(2025, 1, 6), et(2025, 1, 7), et(2025, 1, 8), et(2025, 1, 9), et(2025, 1, 10),
        et(2025, 1, 13), et(2025, 1, 14), et(2025, 1, 15), et(2025, 1, 16), et(2025, 1, 17),
    ]
    projections.append(
        {
            "name": "semana_cruza_enero_completa",
            "mode": "YEAR_START",
            "market": "US",
            "weeklyBars": weekly,
            "dailyBars": norm(daily),
            "expected": project(weekly, daily, "YEAR_START", "US"),
        }
    )
    # 11. Semana que cruza mes en AR.
    weekly = [ar(2025, 3, 24), ar(2025, 3, 31), ar(2025, 4, 7)]
    daily = [
        ar(2025, 3, 24), ar(2025, 3, 25), ar(2025, 3, 26), ar(2025, 3, 27), ar(2025, 3, 28),
        ar(2025, 3, 31), ar(2025, 4, 1), ar(2025, 4, 2), ar(2025, 4, 3), ar(2025, 4, 4),
        ar(2025, 4, 7), ar(2025, 4, 8),
    ]
    projections.append(
        {
            "name": "semana_cruza_mes_ar",
            "mode": "MONTH_START",
            "market": "AR",
            "weeklyBars": weekly,
            "dailyBars": norm(daily),
            "expected": project(weekly, daily, "MONTH_START", "AR"),
        }
    )
    # 12. Cobertura parcial: el diario empieza dentro de enero.
    weekly = [et(2025, 1, 6), et(2025, 1, 13)]
    daily = [et(2025, 1, 2), et(2025, 1, 3), et(2025, 1, 6), et(2025, 1, 7), et(2025, 1, 8)]
    projections.append(
        {
            "name": "semana_cruza_enero_parcial",
            "mode": "YEAR_START",
            "market": "US",
            "weeklyBars": weekly,
            "dailyBars": norm(daily),
            "expected": project(weekly, daily, "YEAR_START", "US"),
        }
    )

    return {
        "meta": {
            "generator": "tools/gen_avwap_anchors_pieza50_7.py",
            "timezones": {"US": "America/New_York", "AR": "America/Argentina/Buenos_Aires"},
        },
        "anchorCases": cases,
        "projectionCases": projections,
    }


def main():
    fixture = build_fixture()
    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump(fixture, handle, indent=1)
        handle.write("\n")
    print(
        f"OK -> {os.path.relpath(OUT)} ({len(fixture['anchorCases'])} anclas, "
        f"{len(fixture['projectionCases'])} proyecciones)"
    )


if __name__ == "__main__":
    main()
