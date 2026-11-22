#!/usr/bin/env python3
"""Referencia independiente Pieza 50.8 Bloque A — identidad calendario live 1D/1W.

Implementacion explicita con zoneinfo, sin copiar la logica TypeScript:

  - 1D US: clave = fecha civil America/New_York (EST/EDT); etiqueta EOD =
    00:00 local de esa fecha en UTC (05:00Z EST / 04:00Z EDT).
  - 1D AR: clave = fecha civil America/Argentina/Buenos_Aires; etiqueta solo
    si la fuente la acredita (Data912 fecha sin hora -> 20:00Z).
  - 1W: clave = lunes civil de la semana del mercado; timestamp = primera
    diaria disponible (se aporta como etiqueta, nunca se inventa).
  - Proyeccion: misma clave -> actualiza preservando `timeSec` y `open`;
    clave anterior -> descarta; clave posterior -> abre solo con etiqueta
    acreditable (US 1D la deriva; AR/1W requieren etiqueta de la fuente).

Genera fixtures/live_calendar_pieza50_8_reference.json.
"""
from __future__ import annotations

import json
import os
from datetime import datetime
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
AR = ZoneInfo("America/Argentina/Buenos_Aires")
OUT = os.path.join(
    os.path.dirname(__file__), "..", "fixtures", "live_calendar_pieza50_8_reference.json"
)


def utc(y, m, d, h=0, minute=0):
    return int(datetime(y, m, d, h, minute, tzinfo=ZoneInfo("UTC")).timestamp())


def et(y, m, d, h=0, minute=0):
    return int(datetime(y, m, d, h, minute, tzinfo=NY).timestamp())


def ar_dt(y, m, d, h=0, minute=0):
    return int(datetime(y, m, d, h, minute, tzinfo=AR).timestamp())


def civil_key(time_sec, tz):
    dt = datetime.fromtimestamp(time_sec, tz)
    return dt.strftime("%Y-%m-%d")


def week_key(time_sec, tz):
    dt = datetime.fromtimestamp(time_sec, tz)
    return (dt.date().fromordinal(dt.date().toordinal() - dt.weekday())).isoformat()


def identity(time_sec, market, timeframe):
    tz = NY if market == "US" else AR
    if timeframe == "1W":
        return {"key": week_key(time_sec, tz), "openingTimeSec": None}
    if market == "US":
        dt = datetime.fromtimestamp(time_sec, tz)
        label = int(datetime(dt.year, dt.month, dt.day, 0, 0, tzinfo=NY).timestamp())
        return {"key": dt.strftime("%Y-%m-%d"), "openingTimeSec": label}
    return {"key": civil_date(time_sec), "openingTimeSec": None}


def civil_date(time_sec):
    return datetime.fromtimestamp(time_sec, AR).strftime("%Y-%m-%d")


def normalize(bar):
    return {
        "timeSec": bar["timeSec"],
        "open": bar["open"],
        "high": bar["high"],
        "low": bar["low"],
        "close": bar["close"],
        "volume": bar["volume"],
    }


def project(bar, tick, calendar):
    event = identity(tick["timeSec"], calendar["market"], calendar["timeframe"])
    current = identity(bar["timeSec"], calendar["market"], calendar["timeframe"])
    if event is None or current is None:
        return None
    delta = tick.get("volumeDelta", 0)
    if event["key"] == current["key"]:
        out = normalize(bar)
        out["high"] = max(bar["high"], tick["price"])
        out["low"] = min(bar["low"], tick["price"])
        out["close"] = tick["price"]
        out["volume"] = bar["volume"] + (delta if isinstance(delta, (int, float)) and delta >= 0 else 0)
        return out
    if event["key"] < current["key"]:
        return None
    provided = calendar.get("nextPeriodOpeningTimeSec")
    opening = None
    if provided is not None:
        provided_identity = identity(provided, calendar["market"], calendar["timeframe"])
        if provided_identity is not None and provided_identity["key"] == event["key"]:
            opening = provided
    elif calendar["market"] == "US" and calendar["timeframe"] == "1D":
        opening = event["openingTimeSec"]
    if opening is None:
        return None
    return {
        "timeSec": opening,
        "open": tick["price"],
        "high": tick["price"],
        "low": tick["price"],
        "close": tick["price"],
        "volume": delta if isinstance(delta, (int, float)) and delta >= 0 else 0,
    }


def build():
    identity_cases = []

    def add_identity(name, time_sec, market, timeframe):
        identity_cases.append(
            {
                "name": name,
                "timeSec": time_sec,
                "market": market,
                "timeframe": timeframe,
                "expected": identity(time_sec, market, timeframe),
            }
        )

    add_identity("us_1d_est", et(2025, 1, 15, 9, 30), "US", "1D")
    add_identity("us_1d_edt", et(2025, 6, 10, 9, 30), "US", "1D")
    add_identity("us_1d_tras_medianoche_utc", utc(2025, 1, 16, 1, 0), "US", "1D")
    add_identity("us_1d_pre_medianoche_utc", utc(2025, 1, 16, 4, 30), "US", "1D")
    add_identity("ar_1d_data912", utc(2025, 3, 10, 20, 0), "AR", "1D")
    add_identity("us_1w", utc(2025, 1, 8, 15, 0), "US", "1W")
    add_identity("us_1w_lunes_feriado", utc(2025, 1, 21, 15, 0), "US", "1W")
    add_identity("ar_1w", utc(2025, 3, 10, 20, 0), "AR", "1W")

    def bar(ts, o, h, l, c, v):
        return {"timeSec": ts, "open": o, "high": h, "low": l, "close": c, "volume": v}

    def tick(ts, price, delta=None):
        out = {"price": price, "timeSec": ts}
        if delta is not None:
            out["volumeDelta"] = delta
        return out

    cases = []
    bar_est = bar(et(2025, 1, 15), 100.0, 105.0, 99.0, 101.0, 1000.0)
    bar_edt = bar(et(2025, 6, 10), 200.0, 205.0, 199.0, 201.0, 500.0)
    bar_ar = bar(utc(2025, 3, 10, 20, 0), 300.0, 305.0, 299.0, 301.0, 800.0)
    bar_week = bar(et(2025, 1, 6), 400.0, 405.0, 399.0, 401.0, 2000.0)
    bar_week_holiday = bar(et(2025, 1, 21), 410.0, 415.0, 409.0, 411.0, 2100.0)
    bar_week_year = bar(et(2024, 12, 30), 420.0, 425.0, 419.0, 421.0, 2200.0)

    def add(name, b, t, calendar, expected=None):
        cases.append(
            {
                "name": name,
                "bar": b,
                "tick": t,
                "calendar": calendar,
                "expected": expected if expected is not None else project(b, t, calendar),
            }
        )

    us_1d = {"market": "US", "timeframe": "1D"}
    ar_1d = {"market": "AR", "timeframe": "1D"}
    us_1w = {"market": "US", "timeframe": "1W"}
    ar_1w = {"market": "AR", "timeframe": "1W"}

    add("us_1d_misma_rueda_est", bar_est, tick(utc(2025, 1, 15, 14, 30), 102.0, 50.0), us_1d)
    add("us_1d_misma_rueda_edt", bar_edt, tick(utc(2025, 6, 10, 20, 0), 250.0, 10.0), us_1d)
    add("us_1d_evento_tras_medianoche_utc", bar_est, tick(utc(2025, 1, 16, 1, 0), 103.0, 20.0), us_1d)
    add("us_1d_periodo_anterior", bar_est, tick(utc(2025, 1, 14, 14, 0), 98.0, 5.0), us_1d)
    add("us_1d_rueda_nueva_fuente", bar_est, tick(utc(2025, 1, 16, 14, 30), 104.0, 30.0), us_1d)
    add("ar_1d_misma_rueda", bar_ar, tick(utc(2025, 3, 10, 21, 0), 302.0, 15.0), ar_1d)
    add("ar_1d_periodo_anterior", bar_ar, tick(utc(2025, 3, 9, 21, 0), 297.0, 4.0), ar_1d)
    add("ar_1d_nueva_sin_etiqueta", bar_ar, tick(utc(2025, 3, 11, 12, 0), 305.0, 12.0), ar_1d)
    add(
        "ar_1d_nueva_data912",
        bar_ar,
        tick(utc(2025, 3, 11, 12, 0), 305.0, 12.0),
        {"market": "AR", "timeframe": "1D", "nextPeriodOpeningTimeSec": utc(2025, 3, 11, 20, 0)},
    )
    add(
        "ar_1d_nueva_etiqueta_incompatible",
        bar_ar,
        tick(utc(2025, 3, 11, 12, 0), 305.0, 12.0),
        {"market": "AR", "timeframe": "1D", "nextPeriodOpeningTimeSec": utc(2025, 3, 12, 20, 0)},
    )
    add("us_1w_misma_semana", bar_week, tick(utc(2025, 1, 8, 15, 0), 402.0, 25.0), us_1w)
    add("us_1w_lunes_feriado", bar_week_holiday, tick(utc(2025, 1, 22, 15, 0), 412.0, 26.0), us_1w)
    add("us_1w_semana_incompleta", bar(et(2025, 1, 10), 430.0, 435.0, 429.0, 431.0, 900.0), tick(utc(2025, 1, 8, 15, 0), 432.0, 15.0), us_1w)
    add(
        "us_1w_semana_nueva_fuente",
        bar_week,
        tick(utc(2025, 1, 13, 15, 0), 404.0, 40.0),
        {"market": "US", "timeframe": "1W", "nextPeriodOpeningTimeSec": et(2025, 1, 13)},
    )
    add("us_1w_semana_nueva_sin_fuente", bar_week, tick(utc(2025, 1, 13, 15, 0), 404.0, 40.0), us_1w)
    add(
        "us_1w_semana_nueva_anio",
        bar_week_year,
        tick(utc(2025, 1, 7, 15, 0), 423.0, 35.0),
        {"market": "US", "timeframe": "1W", "nextPeriodOpeningTimeSec": et(2025, 1, 6)},
    )
    add(
        "us_1w_etiqueta_semana_previa",
        bar_week,
        tick(utc(2025, 1, 13, 15, 0), 404.0, 40.0),
        {"market": "US", "timeframe": "1W", "nextPeriodOpeningTimeSec": et(2025, 1, 6)},
    )
    add("ar_1w_misma_semana", bar(ar_dt(2025, 3, 10), 300.0, 305.0, 299.0, 301.0, 800.0), tick(utc(2025, 3, 11, 14, 0), 303.0, 10.0), ar_1w)

    return {
        "meta": {
            "generator": "tools/gen_live_calendar_pieza50_8.py",
            "timezones": {"US": "America/New_York", "AR": "America/Argentina/Buenos_Aires"},
        },
        "identityCases": identity_cases,
        "projectionCases": cases,
    }


def main():
    fixture = build()
    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump(fixture, handle, indent=1)
        handle.write("\n")
    print(
        f"OK -> {os.path.relpath(OUT)} ({len(fixture['identityCases'])} identidades, "
        f"{len(fixture['projectionCases'])} proyecciones)"
    )


if __name__ == "__main__":
    main()
