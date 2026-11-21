#!/usr/bin/env python3
"""Referencia independiente Pieza 50.5 Bloque 1 — ventana histórica REST FMP/Tradier.

Implementacion explicita en Python puro (datetime, zoneinfo.ZoneInfo, math) sin
copiar la logica TypeScript:

  - Calendario de prueba explicito construido con reglas declaradas en este
    script (feriados observados, Good Friday via algoritmo de Pascua, y
    sesiones reducidas de vispera de festivo). No se usa ninguna libreria de
    calendario de mercado.
  - Conteo de buckets por ENUMERACION: cada sesion del calendario se abre en su
    horario ET (04:00 o 09:30) y se recorren las aperturas reales de barra del
    adaptador (rejilla nativa para 1m/5m/15m; agregacion por muro ET para
    1h/4h, como hace `aggregateTradierBars`). Las aperturas ET se convierten a
    UTC por sesion con ZoneInfo (DST resuelto fecha a fecha).
  - Densidad por sesion completa y ventana `fromUtcSec` con el criterio de
    `massiveLookbackDays`: `ceil(objetivo * 1.03 / barrasPorSesion * 365.25/250) + 10`.
  - Cobertura de cada caso: se cuentan las sesiones y buckets cuya apertura UTC
    cae dentro de `[fromUtcSec, toUtcSec)`; el generador falla si la ventana no
    cubre el objetivo.

Genera fixtures/rest_historical_window_reference.json.
"""
from __future__ import annotations

import json
import math
import os
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

OUT = os.path.join(
    os.path.dirname(__file__), "..", "fixtures", "rest_historical_window_reference.json"
)

TZ = ZoneInfo("America/New_York")

PROVIDERS = ("FMP_ENTERPRISE_REST", "TRADIER_REST")
TIMEFRAMES = ("1m", "5m", "15m", "1h", "4h", "1D")

# Bucket final (minutos) que expone cada marco.
BUCKET_MINUTES = {"1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240}
# Intervalo crudo pedido por el adaptador: Tradier pide 15m para 1h/4h y agrega.
RAW_INTERVAL_MINUTES = {"1m": 1, "5m": 5, "15m": 15, "1h": 15, "4h": 15}

# Convencion del calendario de prueba para sesiones reducidas (documentada):
# RTH 09:30-13:00 ET y extendida 04:00-17:00 ET.
SESSION_WINDOWS = {
    "extended": {"open": 4 * 60, "close": 20 * 60},
    "rth": {"open": 9 * 60 + 30, "close": 16 * 60},
}
HALF_DAY_WINDOWS = {
    "extended": {"open": 4 * 60, "close": 17 * 60},
    "rth": {"open": 9 * 60 + 30, "close": 13 * 60},
}

CALENDAR_YEARS = range(2020, 2028)

TARGET_MARGIN = 1.03
SESSIONS_PER_CALENDAR_YEAR = 365.25 / 250
MAX_TIME_SECONDS = 1e11
# Pieza 50.5 (Bloque 2): velas previas al tramo visible para calentar la EMA 200 (SPEC.md:4).
WARMUP_BARS = 1_000


# ---------------------------------------------------------------------------
# Calendario de prueba explicito
# ---------------------------------------------------------------------------


def observed(d: date) -> date:
    """Feriado de fecha fija observado: sabado -> viernes, domingo -> lunes."""
    if d.weekday() == 5:
        return d - timedelta(days=1)
    if d.weekday() == 6:
        return d + timedelta(days=1)
    return d


def nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    first = date(year, month, 1)
    offset = (weekday - first.weekday()) % 7
    return first + timedelta(days=offset + 7 * (n - 1))


def last_weekday(year: int, month: int, weekday: int) -> date:
    if month == 12:
        nxt = date(year + 1, 1, 1)
    else:
        nxt = date(year, month + 1, 1)
    last = nxt - timedelta(days=1)
    offset = (last.weekday() - weekday) % 7
    return last - timedelta(days=offset)


def easter_sunday(year: int) -> date:
    """Algoritmo gregoriano anonimo (Computus)."""
    a = year % 19
    b = year // 100
    c = year % 100
    d = b // 4
    e = b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i = c // 4
    k = c % 4
    ell = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * ell) // 451
    month = (h + ell - 7 * m + 114) // 31
    day = ((h + ell - 7 * m + 114) % 31) + 1
    return date(year, month, day)


def build_test_calendar() -> tuple[list[str], list[str]]:
    holidays: set[date] = set()
    half_days: set[date] = set()
    for year in CALENDAR_YEARS:
        holidays.add(observed(date(year, 1, 1)))
        holidays.add(nth_weekday(year, 1, 0, 3))  # MLK
        holidays.add(nth_weekday(year, 2, 0, 3))  # Presidents
        holidays.add(easter_sunday(year) - timedelta(days=2))  # Good Friday
        holidays.add(last_weekday(year, 5, 0))  # Memorial
        holidays.add(observed(date(year, 6, 19)))  # Juneteenth
        holidays.add(observed(date(year, 7, 4)))
        holidays.add(nth_weekday(year, 9, 0, 1))  # Labor
        thanksgiving = nth_weekday(year, 11, 3, 4)
        holidays.add(thanksgiving)
        holidays.add(observed(date(year, 12, 25)))

        july3 = date(year, 7, 3)
        if july3.weekday() < 5 and july3 not in holidays:
            half_days.add(july3)
        half_days.add(thanksgiving + timedelta(days=1))  # Black Friday
        dec24 = date(year, 12, 24)
        if dec24.weekday() < 5 and dec24 not in holidays:
            half_days.add(dec24)
    # Una vispera no puede ser feriado completa.
    half_days -= holidays
    return [d.isoformat() for d in sorted(holidays)], [d.isoformat() for d in sorted(half_days)]


HOLIDAYS, HALF_DAYS = build_test_calendar()
HOLIDAY_SET = {date.fromisoformat(d) for d in HOLIDAYS}
HALF_DAY_SET = {date.fromisoformat(d) for d in HALF_DAYS}


# ---------------------------------------------------------------------------
# Buckets reales por sesion
# ---------------------------------------------------------------------------


def bucket_open_minutes(timeframe: str, include_extended: bool, half_day: bool) -> list[int]:
    """Aperturas ET (minutos) de las barras finales de una sesion."""
    if timeframe == "1D":
        # Barra diaria: 00:00 ET en FMP EOD y Tradier daily.
        return [0]
    windows = HALF_DAY_WINDOWS if half_day else SESSION_WINDOWS
    window = windows["extended" if include_extended else "rth"]
    start = window["open"]
    close = window["close"]
    bucket = BUCKET_MINUTES[timeframe]
    raw = RAW_INTERVAL_MINUTES[timeframe]
    if raw >= bucket:
        return list(range(start, close, bucket))
    # Agregacion por muro ET (Tradier `aggregateTradierBars`); FMP nativa
    # coincide en numero de buckets finales.
    keys: list[int] = []
    for open_min in range(start, close, raw):
        key = (open_min // bucket) * bucket
        if key not in keys:
            keys.append(key)
    return keys


def full_session_density(provider: str, timeframe: str, include_extended: bool) -> int:
    # Ambos adaptadores enumeran el mismo horario/bucket final; `provider` se
    # conserva para documentar la dimension y detectar divergencias futuras.
    return len(bucket_open_minutes(timeframe, include_extended, half_day=False))


# ---------------------------------------------------------------------------
# Ventana y cobertura
# ---------------------------------------------------------------------------


def lookback_days(target_bars: int, bars_per_session: int) -> int:
    sessions_needed = (target_bars * TARGET_MARGIN) / bars_per_session
    return math.ceil(sessions_needed * SESSIONS_PER_CALENDAR_YEAR) + 10


def et_date_of(utc_sec: int) -> date:
    return datetime.fromtimestamp(utc_sec, tz=TZ).date()


def et_wall_to_utc_sec(day: date, minutes_of_day: int) -> int:
    dt = datetime(day.year, day.month, day.day, tzinfo=TZ) + timedelta(minutes=minutes_of_day)
    return int(dt.timestamp())


def enumerate_window(
    from_utc: int,
    to_utc: int,
    timeframe: str,
    include_extended: bool,
) -> tuple[int, int]:
    """Sesiones y buckets con apertura UTC dentro de `[from_utc, to_utc)`."""
    total = 0
    sessions: set[date] = set()
    day = et_date_of(from_utc) - timedelta(days=1)
    last = et_date_of(to_utc) + timedelta(days=1)
    while day <= last:
        if day.weekday() < 5 and day not in HOLIDAY_SET:
            half = day in HALF_DAY_SET
            for open_min in bucket_open_minutes(timeframe, include_extended, half):
                utc_sec = et_wall_to_utc_sec(day, open_min)
                if from_utc <= utc_sec < to_utc:
                    total += 1
                    sessions.add(day)
        day += timedelta(days=1)
    return len(sessions), total


# ---------------------------------------------------------------------------
# Casos
# ---------------------------------------------------------------------------

TO_REGULAR = datetime(2026, 11, 20, 21, 0, tzinfo=timezone.utc)  # viernes, cierre regular
TO_DST = datetime(2026, 4, 10, 20, 0, tzinfo=timezone.utc)  # ventana cruza el DST de marzo
TO_HALF = datetime(2026, 12, 24, 18, 0, tzinfo=timezone.utc)  # sesion reducida dentro


def build_cases() -> list[dict]:
    cases: list[dict] = []

    def add(
        provider: str,
        timeframe: str,
        include_extended: bool,
        target: int,
        to_dt: datetime,
        tag: str,
    ) -> None:
        session_tag = "ext" if include_extended else "rth"
        name = f"{provider.lower().replace('_enterprise_rest', '').replace('_rest', '')}-{timeframe}-{session_tag}-{target}-{tag}"
        bars_per_session = full_session_density(provider, timeframe, include_extended)
        days = lookback_days(target, bars_per_session)
        to_utc = int(to_dt.timestamp())
        from_utc = to_utc - days * 86_400
        sessions_in_window, buckets_in_window = enumerate_window(
            from_utc, to_utc, timeframe, include_extended
        )
        if buckets_in_window < target:
            raise SystemExit(
                f"Ventana insuficiente en {name}: {buckets_in_window} buckets < {target}"
            )
        cases.append(
            {
                "name": name,
                "provider": provider,
                "timeframe": timeframe,
                "includeExtended": include_extended,
                "targetBars": target,
                "toUtcSec": to_utc,
                "barsPerSession": bars_per_session,
                "sessionsNeeded": (target * TARGET_MARGIN) / bars_per_session,
                "calendarDays": days,
                "fromUtcSec": from_utc,
                "coverage": {
                    "sessionsInWindow": sessions_in_window,
                    "bucketsInWindow": buckets_in_window,
                },
            }
        )

    for provider in PROVIDERS:
        # 1D
        add(provider, "1D", False, 20, TO_DST, "dst")
        for target in (20, 400, 1250):
            add(provider, "1D", False, target, TO_REGULAR, "regular")
        # Intradia, sesion extendida
        add(provider, "1m", True, 1000, TO_REGULAR, "regular")
        add(provider, "1m", True, 1000, TO_HALF, "halfday")
        add(provider, "5m", True, 400, TO_REGULAR, "regular")
        add(provider, "5m", True, 1000, TO_REGULAR, "regular")
        add(provider, "15m", True, 1000, TO_DST, "dst")
        add(provider, "15m", True, 1000, TO_REGULAR, "regular")
        add(provider, "1h", True, 400, TO_REGULAR, "regular")
        add(provider, "1h", True, 1000, TO_REGULAR, "regular")
        add(provider, "4h", True, 1000, TO_REGULAR, "regular")
        # Intradia, RTH (4h queda como borde defensivo: inalcanzable hoy)
        add(provider, "1m", False, 1000, TO_REGULAR, "regular")
        add(provider, "5m", False, 1000, TO_REGULAR, "regular")
        add(provider, "15m", False, 1000, TO_REGULAR, "regular")
        add(provider, "1h", False, 1000, TO_REGULAR, "regular")
        add(provider, "4h", False, 1000, TO_REGULAR, "rth-unreachable")
        # Bloque 2: objetivo interno = visibleBars + 1.000 en la ruta ordinaria.
        add(provider, "1D", False, 1_250 + WARMUP_BARS, TO_REGULAR, "warmup")
        add(provider, "1m", True, 1_000 + WARMUP_BARS, TO_REGULAR, "warmup")
        add(provider, "5m", True, 1_000 + WARMUP_BARS, TO_REGULAR, "warmup")
        add(provider, "15m", False, 1_000 + WARMUP_BARS, TO_REGULAR, "warmup")
        add(provider, "1h", False, 1_000 + WARMUP_BARS, TO_REGULAR, "warmup")
        add(provider, "4h", True, 1_000 + WARMUP_BARS, TO_REGULAR, "warmup")
    return cases


def build_density_rows() -> list[dict]:
    rows: list[dict] = []
    for provider in PROVIDERS:
        for timeframe in TIMEFRAMES:
            for include_extended in (True, False):
                rows.append(
                    {
                        "provider": provider,
                        "timeframe": timeframe,
                        "includeExtended": include_extended,
                        "barsPerSession": full_session_density(provider, timeframe, include_extended),
                        "rawIntervalMinutes": RAW_INTERVAL_MINUTES.get(timeframe),
                        "bucketMinutes": BUCKET_MINUTES.get(timeframe),
                    }
                )
    return rows


def is_closed_daily_bar_py(bar: dict, as_of: int) -> bool:
    """Implementacion explicita e independiente de la regla de elegibilidad."""
    if not isinstance(as_of, int) or as_of <= 0:
        return False
    time_sec = bar.get("time")
    if (
        not isinstance(time_sec, (int, float))
        or not math.isfinite(time_sec)
        or time_sec <= 0
        or abs(time_sec) > MAX_TIME_SECONDS
    ):
        return False
    for key in ("open", "high", "low", "close", "volume"):
        value = bar.get(key)
        if not isinstance(value, (int, float)) or not math.isfinite(value):
            return False
    if bar["close"] <= 0 or bar["high"] < bar["low"] or bar["volume"] < 0:
        return False
    raw_time = int(time_sec)
    if raw_time > as_of:
        return False
    day_open = (raw_time // 86_400) * 86_400
    return day_open + 86_400 <= as_of


def build_closed_daily_cases() -> list[dict]:
    """Pieza 50.5 Bloque 3: elegibilidad de rueda diaria cerrada US.

    Regla explicita e independiente (`is_closed_daily_bar_py`): la barra es
    valida (OHLCV finito, cierre positivo, high >= low, volumen >= 0), no es
    futura respecto de `asOfUtcSec` y el dia civil UTC de su apertura ya
    termino (`dayOpen + 86400 <= asOf`). Cubre barras FMP/Massive (apertura
    00:00 ET = 04:00/05:00Z), bordes DST, media rueda, feriado, futuro e
    invalidas.
    """

    def utc_wall(year: int, month: int, day: int, minutes: int = 0) -> int:
        return et_wall_to_utc_sec(date(year, month, day), minutes)

    def valid_bar(time_sec: int) -> dict:
        return {
            "time": time_sec,
            "open": 100.0,
            "high": 101.0,
            "low": 99.0,
            "close": 100.5,
            "volume": 1_000.0,
        }

    def case(name: str, bar: dict, as_of: int) -> dict:
        return {
            "name": name,
            "bar": bar,
            "asOfUtcSec": as_of,
            "expected": is_closed_daily_bar_py(bar, as_of),
        }

    to_regular = int(TO_REGULAR.timestamp())
    yesterday = utc_wall(2026, 11, 19, 0)  # 00:00 ET => 05:00Z EST
    today = utc_wall(2026, 11, 20, 0)
    summer = utc_wall(2026, 7, 15, 0)  # 00:00 ET => 04:00Z EDT
    summer_next_utc_day = ((summer // 86_400) + 1) * 86_400
    friday_half = utc_wall(2026, 11, 27, 0)
    thanksgiving = utc_wall(2026, 11, 26, 0)
    today_next_utc_day = ((today // 86_400) + 1) * 86_400

    return [
        case("rueda_previa_cerrada", valid_bar(yesterday), to_regular),
        case("rueda_en_curso_rth", valid_bar(today), to_regular),
        case("rueda_en_curso_pre_utc", valid_bar(today), today_next_utc_day - 1),
        case("borde_utc_cerrado", valid_bar(today), today_next_utc_day + 60),
        case("dst_verano_en_curso", valid_bar(summer), utc_wall(2026, 7, 15, 16 * 60)),
        case("dst_verano_dia_utc_cerrado", valid_bar(summer), summer_next_utc_day + 60),
        case("media_rueda_viernes_cerrada", valid_bar(friday_half), utc_wall(2026, 11, 28, 360)),
        case("feriado_gracias_cerrado", valid_bar(thanksgiving), utc_wall(2026, 11, 27, 16 * 60)),
        case("timestamp_futuro", valid_bar(to_regular + 3_600), to_regular),
        case("timestamp_no_positivo", valid_bar(-3_600), to_regular),
        case("invalida_high_menor_low", {**valid_bar(yesterday), "high": 98.0}, to_regular),
        case("invalida_volumen_negativo", {**valid_bar(yesterday), "volume": -5.0}, to_regular),
        case("invalida_cierre_no_positivo", {**valid_bar(yesterday), "close": 0.0}, to_regular),
    ]


def main() -> None:
    fixture = {
        "version": 1,
        "generator": "tools/gen_rest_historical_window_fixture.py",
        "timezone": "America/New_York",
        "targetMargin": TARGET_MARGIN,
        "sessionsPerCalendarYear": SESSIONS_PER_CALENDAR_YEAR,
        "calendar": {
            "years": [CALENDAR_YEARS[0], CALENDAR_YEARS[-1]],
            "holidays": HOLIDAYS,
            "halfDays": HALF_DAYS,
            "sessionWindows": SESSION_WINDOWS,
            "halfDayWindows": HALF_DAY_WINDOWS,
        },
        "density": build_density_rows(),
        "windowCases": build_cases(),
        "closedDailyEligibility": {
            "rule": "UTC day of bar.time ended (dayOpen + 86400 <= asOf) and bar.time <= asOf, valid OHLCV",
            "cases": build_closed_daily_cases(),
        },
    }
    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump(fixture, handle, indent=1)
        handle.write("\n")
    print(f"OK -> {os.path.relpath(OUT)} ({len(fixture['windowCases'])} casos)")


if __name__ == "__main__":
    main()
