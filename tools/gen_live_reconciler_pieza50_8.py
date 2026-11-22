#!/usr/bin/env python3
"""Referencia independiente Pieza 50.8 Bloque B1 — reductor de eventos live.

Implementacion explicita con zoneinfo (sin copiar la logica TypeScript):

  - Minutos RTH US: dia habil 09:30 <= minuto < 16:00 en America/New_York.
  - La historia diaria US se conserva (`baseVolume`); el primer minuto
    observado tras (re)conexion es linea base y NO suma; los minutos
    posteriores suman una sola vez; el minuto vigente suma su volumen actual.
  - Revision de la misma vela/minuto solo con progreso demostrable (volumen
    mayor); duplicado exacto y eventos atrasados se descartan; el cierre
    vigente nunca retrocede por un evento de periodo anterior.
  - 1D/1W nuevas: US deriva 00:00 ET; AR/1W requieren etiqueta de la fuente.
  - AR nunca consume el canal US; los ticks AR actualizan precio sin sumar
    volumen y no abren rueda nueva.

Genera fixtures/live_reconciler_pieza50_8_reference.json.
"""
from __future__ import annotations

import json
import os
from datetime import datetime
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
AR = ZoneInfo("America/Argentina/Buenos_Aires")
OUT = os.path.join(
    os.path.dirname(__file__), "..", "fixtures", "live_reconciler_pieza50_8_reference.json"
)


def utc(y, m, d, h=0, minute=0):
    return int(datetime(y, m, d, h, minute, tzinfo=ZoneInfo("UTC")).timestamp())


def et(y, m, d, h=0, minute=0):
    return int(datetime(y, m, d, h, minute, tzinfo=NY).timestamp())


def ar(y, m, d, h=0, minute=0):
    return int(datetime(y, m, d, h, minute, tzinfo=AR).timestamp())


def civil(time_sec, tz):
    return datetime.fromtimestamp(time_sec, tz)


def week_key(time_sec, tz):
    dt = civil(time_sec, tz)
    return dt.date().fromordinal(dt.date().toordinal() - dt.weekday()).isoformat()


def identity(time_sec, market, timeframe):
    tz = NY if market == "US" else AR
    if timeframe == "1W":
        return {"key": week_key(time_sec, tz), "opening": None}
    dt = civil(time_sec, tz)
    if market == "US":
        label = int(datetime(dt.year, dt.month, dt.day, 0, 0, tzinfo=NY).timestamp())
        return {"key": dt.strftime("%Y-%m-%d"), "opening": label}
    return {"key": dt.strftime("%Y-%m-%d"), "opening": None}


def is_rth(time_sec):
    dt = civil(time_sec, NY)
    minutes = dt.hour * 60 + dt.minute
    return 1 <= dt.isoweekday() <= 5 and 570 <= minutes < 960


def reduce_state(bar, calendar, events):
    state = {
        "bar": dict(bar),
        "baseVolume": bar["volume"],
        "lastMinuteTimeSec": None,
        "lastMinuteVolume": 0,
        "baselineMinuteTimeSec": None,
        "closedMinutesVolume": 0,
        "currentMinuteVolume": 0,
        "lastSnapshot": None,
    }
    outcomes = []
    for event in events:
        outcomes.append(reduce_event(state, calendar, event))
    return outcomes, state["bar"]


def reduce_event(state, calendar, event):
    if event["kind"] == "quote":
        return reduce_quote(state, calendar, event)
    if calendar["market"] != "US":
        return "deferred"
    snapshot = event["snapshot"]
    if not is_rth(snapshot["timeSec"]):
        return "out-of-session"
    event_identity = identity(snapshot["timeSec"], calendar["market"], calendar["timeframe"])
    bar_identity = identity(state["bar"]["timeSec"], calendar["market"], calendar["timeframe"])
    if event_identity["key"] < bar_identity["key"]:
        return "stale"
    last = state["lastMinuteTimeSec"]
    if last is not None and snapshot["timeSec"] < last:
        return "stale"
    if last is not None and snapshot["timeSec"] == last:
        if snapshot["volume"] < state["lastMinuteVolume"]:
            return "stale"
        if snapshot["volume"] == state["lastMinuteVolume"]:
            return "duplicate"
        state["bar"] = same_period_bar(state["bar"], snapshot)
        current = 0 if snapshot["timeSec"] == state["baselineMinuteTimeSec"] else snapshot["volume"]
        state["currentMinuteVolume"] = current
        state["lastMinuteVolume"] = snapshot["volume"]
        state["lastSnapshot"] = snapshot
        state["bar"]["volume"] = state["baseVolume"] + state["closedMinutesVolume"] + current
        return "revision"
    first = last is None
    closed = state["closedMinutesVolume"] + (0 if first or last == state["baselineMinuteTimeSec"] else state["lastMinuteVolume"])
    baseline = snapshot["timeSec"] if first else state["baselineMinuteTimeSec"]
    current = 0 if first or snapshot["timeSec"] == baseline else snapshot["volume"]
    if event_identity["key"] > bar_identity["key"]:
        opening = calendar.get("nextPeriodOpeningTimeSec")
        if opening is not None:
            provided = identity(opening, calendar["market"], calendar["timeframe"])
            if provided["key"] != event_identity["key"]:
                opening = None
        elif calendar["market"] == "US" and calendar["timeframe"] == "1D":
            opening = event_identity["opening"]
        if opening is None:
            return "deferred"
        state["bar"] = {
            "timeSec": opening,
            "open": snapshot["open"],
            "high": snapshot["high"],
            "low": snapshot["low"],
            "close": snapshot["close"],
            "volume": current,
        }
        state.update(
            baseVolume=0,
            closedMinutesVolume=0,
            currentMinuteVolume=0,
            baselineMinuteTimeSec=snapshot["timeSec"],
        )
    else:
        state["bar"] = same_period_bar(state["bar"], snapshot)
        state["bar"]["volume"] = state["baseVolume"] + closed + current
        state.update(closedMinutesVolume=closed, currentMinuteVolume=current, baselineMinuteTimeSec=baseline)
    state.update(lastMinuteTimeSec=snapshot["timeSec"], lastMinuteVolume=snapshot["volume"], lastSnapshot=snapshot)
    return "accepted"


def same_period_bar(bar, snapshot):
    out = dict(bar)
    out["high"] = max(bar["high"], snapshot["high"])
    out["low"] = min(bar["low"], snapshot["low"])
    out["close"] = snapshot["close"]
    return out


def reduce_quote(state, calendar, event):
    price = event["price"]
    if not isinstance(price, (int, float)) or price <= 0:
        return "stale"
    if calendar["market"] == "US":
        return "deferred"
    tick_identity = identity(event["timeSec"], calendar["market"], calendar["timeframe"])
    bar_identity = identity(state["bar"]["timeSec"], calendar["market"], calendar["timeframe"])
    if tick_identity["key"] < bar_identity["key"]:
        return "stale"
    if tick_identity["key"] > bar_identity["key"]:
        return "deferred"
    state["bar"] = same_period_bar(state["bar"], {"high": price, "low": price, "close": price})
    state["bar"]["volume"] = state["baseVolume"] + state["closedMinutesVolume"] + state["currentMinuteVolume"]
    return "accepted"


def merge(snapshot, patch):
    out = dict(snapshot)
    out.update(patch)
    return out


def build():
    cases = []

    def add(name, bar, calendar, events):
        outcomes, expected_bar = reduce_state(bar, calendar, events)
        cases.append(
            {
                "name": name,
                "bar": bar,
                "calendar": calendar,
                "events": events,
                "expectedOutcomes": outcomes,
                "expectedBar": expected_bar,
            }
        )

    def bar(ts, o, h, l, c, v):
        return {"timeSec": ts, "open": o, "high": h, "low": l, "close": c, "volume": v}

    def minute(ts, o, h, l, c, v):
        return {"kind": "minute", "snapshot": {"timeSec": ts, "open": o, "high": h, "low": l, "close": c, "volume": v}}

    def quote(ts, price):
        return {"kind": "quote", "price": price, "timeSec": ts}

    us_1d = {"market": "US", "timeframe": "1D"}
    bar_day = bar(et(2025, 1, 15), 100.0, 105.0, 99.0, 101.0, 1000.0)

    add("dos_maximos", bar_day, us_1d, [
        minute(utc(2025, 1, 15, 14, 30), 101, 106, 100, 105, 10),
        minute(utc(2025, 1, 15, 14, 31), 105, 108, 104, 107, 20),
    ])
    add("dos_minimos", bar_day, us_1d, [
        minute(utc(2025, 1, 15, 15, 0), 105, 106, 95, 96, 5),
        minute(utc(2025, 1, 15, 15, 1), 96, 97, 93, 94, 8),
    ])
    add("duplicado", bar_day, us_1d, [
        minute(utc(2025, 1, 15, 14, 30), 101, 106, 100, 105, 10),
        minute(utc(2025, 1, 15, 14, 30), 101, 106, 100, 105, 10),
    ])
    add("atrasado", bar_day, us_1d, [
        minute(utc(2025, 1, 15, 14, 31), 105, 108, 104, 107, 20),
        minute(utc(2025, 1, 15, 14, 30), 101, 130, 90, 129, 10),
    ])
    add("revision", bar_day, us_1d, [
        minute(utc(2025, 1, 15, 14, 30), 101, 106, 100, 105, 10),
        minute(utc(2025, 1, 15, 14, 30), 101, 107, 100, 106, 25),
    ])
    add("contador_quote_us", bar_day, us_1d, [quote(utc(2025, 1, 15, 14, 35), 103.0)])
    add("solapamiento", bar_day, us_1d, [
        minute(utc(2025, 1, 15, 14, 30), 101, 106, 100, 105, 10),
        minute(utc(2025, 1, 15, 14, 31), 105, 108, 104, 107, 20),
    ])
    add("reconexion", bar_day, us_1d, [minute(utc(2025, 1, 15, 15, 10), 103, 109, 102, 108, 12)])
    add("cambio_sesion", bar_day, us_1d, [
        minute(utc(2025, 1, 15, 13, 0), 103, 104, 102, 103.5, 5),
        minute(utc(2025, 1, 16, 14, 30), 110, 112, 109, 111, 30),
    ])
    add("sin_retroceso", bar_day, us_1d, [
        minute(utc(2025, 1, 15, 14, 30), 101, 106, 100, 105, 10),
        minute(utc(2025, 1, 15, 14, 30), 101, 107, 100, 106, 25),
        minute(utc(2025, 1, 15, 14, 30), 101, 90, 80, 81, 5),
    ])

    bar_ar = bar(utc(2025, 3, 10, 20, 0), 300.0, 305.0, 299.0, 301.0, 800.0)
    ar_1d = {"market": "AR", "timeframe": "1D"}
    ar_1w = {"market": "AR", "timeframe": "1W"}
    add("ar_minuto_deferred", bar_ar, ar_1d, [minute(utc(2025, 3, 10, 21, 0), 302, 303, 301, 302, 10)])
    add("ar_quote_misma_rueda", bar_ar, ar_1d, [quote(utc(2025, 3, 10, 21, 0), 302.0)])
    add("ar_quote_rueda_nueva", bar_ar, ar_1d, [quote(utc(2025, 3, 11, 12, 0), 305.0)])
    add("ar_quote_anterior", bar_ar, ar_1d, [quote(utc(2025, 3, 9, 21, 0), 297.0)])
    add(
        "ar_rueda_nueva_etiqueta_deferred",
        bar_ar,
        {"market": "AR", "timeframe": "1D", "nextPeriodOpeningTimeSec": utc(2025, 3, 11, 20, 0)},
        [minute(utc(2025, 3, 11, 12, 0), 305, 306, 304, 305.5, 12)],
    )
    add("ar_semana_minuto_deferred", bar(ar(2025, 3, 10), 300.0, 305.0, 299.0, 301.0, 800.0), ar_1w, [
        minute(utc(2025, 3, 11, 14, 0), 302, 303, 301, 302, 10),
    ])

    # 1W US: lunes feriado (barra del martes) y semana nueva con primera diaria.
    bar_week = bar(et(2025, 1, 21), 410.0, 415.0, 409.0, 411.0, 2100.0)
    us_1w = {"market": "US", "timeframe": "1W"}
    add("us_1w_lunes_feriado", bar_week, us_1w, [
        minute(utc(2025, 1, 22, 15, 0), 412, 416, 411, 415, 25),
        minute(utc(2025, 1, 20, 15, 0), 410, 500, 400, 499, 5),
    ])
    add(
        "us_1w_semana_nueva_fuente",
        bar(et(2025, 1, 13), 420.0, 425.0, 419.0, 421.0, 2200.0),
        {"market": "US", "timeframe": "1W", "nextPeriodOpeningTimeSec": et(2025, 1, 20)},
        [minute(utc(2025, 1, 21, 15, 0), 422, 426, 421, 425, 15)],
    )

    return {
        "meta": {"generator": "tools/gen_live_reconciler_pieza50_8.py", "timezones": {"US": NY.key, "AR": AR.key}},
        "cases": cases,
    }


def main():
    fixture = build()
    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump(fixture, handle, indent=1)
        handle.write("\n")
    print(f"OK -> {os.path.relpath(OUT)} ({len(fixture['cases'])} casos)")


if __name__ == "__main__":
    main()
