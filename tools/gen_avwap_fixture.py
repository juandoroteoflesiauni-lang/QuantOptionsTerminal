#!/usr/bin/env python3
"""
tools/gen_avwap_fixture.py

Generador de referencia INDEPENDIENTE para el AVWAP anclado (SPEC puntos 5 y 9).

Método:
  - Decimal con precisión 60 para todos los cálculos.
  - zoneinfo (America/New_York para acciones, UTC para cripto).
  - En cada prefijo se recalcula por definición, sin recurrencia ni Welford:
        mu    = sum(P_i * V_i) / sum(V_i)
        sigma = sqrt( sum(V_i * (P_i - mu)^2) / sum(V_i) )
    sobre todas las barras válidas desde el ancla hasta ese prefijo.
  - El precio de cada barra es HLC3 = (high + low + close) / 3.
  - Una barra solo contribuye si HLC3 es finito, el volumen es finito y > 0.
  - Las bandas se calculan con el mismo sigma: mu ± k*sigma, k = 1, 2, 2.5.
  - El índice de ancla se calcula por su cuenta con datetime/zoneinfo, sin
    copiar la lógica de TypeScript:
        SESSION: primera barra RTH de la última fecha (EQUITY) o primera barra
                 de la última fecha UTC (CRYPTO). EQUITY sin barra RTH -> -1.
        WEEK/MONTH/YTD: primera barra del periodo de la última barra.
        HIGH_VOLUME_BAR: primera barra de mayor volumen finito > 0 en
                         bars[visibleStart..]; empate -> la primera.
        FULL_HISTORY: bars[visibleStart].
    Si el buffer empieza a mitad de periodo, el ancla es la primera barra del
    buffer (AVWAP parcial, límite documentado).

Casos (semillas fijas):
  a) 5m acciones, 2025-03-05 a 2025-03-14 (cambio de horario), barras
     04:00-19:55 ET; SESSION, WEEK, MONTH, HIGH_VOLUME_BAR y FULL_HISTORY con
     visibleStart=0 y visibleStart>0. ~3% volumen 0 y ~1% volumen NaN.
  b) 1h acciones, 2024-11-01 a 2025-01-31 (tres meses que cruzan fin de mes y
     de año), barras 04:00-20:00 ET; WEEK, MONTH y YTD. Incluye la barra de
     2024-12-31 20:00 ET, que en UTC ya es 2025-01-01 y no debe cambiar mes ni
     año.
  c) 1D acciones, 2024-12-02 a 2025-02-28, timestamps a las 00:00 ET; YTD y
     MONTH.
  d) cripto 15m, 2025-01-31 00:00 UTC a 2025-02-03 23:45 UTC (4 días, cruza
     medianoche UTC y un fin de semana); SESSION, WEEK y MONTH.
  e) 5.000 barras con precios ~60.000 y volúmenes grandes, ancla en la barra 0.
  f) casos del ancla: buffer que empieza a mitad de semana, SESSION con última
     barra premarket (esperado -1), HIGH_VOLUME_BAR con empate, sin volumen
     finito y array vacío.
  g) errores: tiempos no crecientes y milisegundos.
  h) primera barra con volumen 0 y precios NaN intercalados.

Codificación compacta:
  - bars: [time, open, high, low, close, volume]
  - points: [time, vwap, stdDev, cumVolume, upper1, lower1, upper2, lower2,
             upper2_5, lower2_5]
  - NaN se serializa como la cadena "NaN" para mantener JSON estricto.

Para regenerar el fixture:
  python tools/gen_avwap_fixture.py

Si zoneinfo no encuentra la base IANA en Windows, instala tzdata con:
  python -m pip install tzdata
"""

from __future__ import annotations

import json
import math
import random
import sys
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, getcontext
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

try:
    NEW_YORK = ZoneInfo("America/New_York")
except ZoneInfoNotFoundError as exc:  # pragma: no cover - depende del entorno
    raise SystemExit(
        "zoneinfo no encontró America/New_York. Instala la base IANA con:\n"
        "  python -m pip install tzdata"
    ) from exc

UTC = timezone.utc
getcontext().prec = 60

FIXTURE_PATH = (
    Path(__file__).resolve().parent.parent
    / "fixtures"
    / "avwap_reference.json"
)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

PREMARKET_START_MINUTES = 4 * 60
AFTERHOURS_END_MINUTES = 19 * 60 + 55

BAR_ORDER = ["time", "open", "high", "low", "close", "volume"]
POINT_ORDER = [
    "time",
    "vwap",
    "stdDev",
    "cumVolume",
    "upper1",
    "lower1",
    "upper2",
    "lower2",
    "upper2_5",
    "lower2_5",
]


def to_decimal(value: int | float) -> Decimal:
    """Convierte el valor tal como aparece en el JSON a Decimal exacto."""
    if isinstance(value, int):
        return Decimal(value)
    return Decimal(str(value))


def is_finite_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def json_safe(value: Any) -> Any:
    """Convierte NaN/Infinity en cadenas y recorre diccionarios y listas."""
    if isinstance(value, float):
        if math.isnan(value):
            return "NaN"
        if math.isinf(value):
            return "Infinity" if value > 0 else "-Infinity"
        return value
    if isinstance(value, Decimal):
        return json_safe(float(value))
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [json_safe(item) for item in value]
    if isinstance(value, tuple):
        return [json_safe(item) for item in value]
    return value


def utc_seconds(
    year: int,
    month: int,
    day: int,
    hour: int = 0,
    minute: int = 0,
    second: int = 0,
) -> int:
    return int(
        datetime(year, month, day, hour, minute, second, tzinfo=UTC).timestamp()
    )


def et_seconds(
    year: int,
    month: int,
    day: int,
    hour: int,
    minute: int,
    second: int = 0,
) -> int:
    return int(
        datetime(
            year, month, day, hour, minute, second, tzinfo=NEW_YORK
        ).timestamp()
    )


def business_days(
    start: date, end: date, holidays: set[date] | None = None
) -> list[date]:
    excluded = holidays if holidays is not None else set()
    days: list[date] = []
    current = start
    while current <= end:
        if current.weekday() < 5 and current not in excluded:
            days.append(current)
        current += timedelta(days=1)
    return days


class PricePath:
    """Camino OHLCV determinista con semilla fija."""

    def __init__(
        self,
        start_price: float,
        seed: int,
        volatility: float = 0.0008,
        min_volume: int = 1_000,
        max_volume: int = 100_000,
    ) -> None:
        self.rng = random.Random(seed)
        self.price = start_price
        self.volatility = volatility
        self.min_volume = min_volume
        self.max_volume = max_volume

    def next_bar(self, time: int, corrupt_volume: bool = False) -> dict[str, Any]:
        rng = self.rng
        open_price = self.price

        drift = rng.gauss(0.0, self.volatility)
        close_price = max(0.01, open_price * (1.0 + drift))
        spread = abs(rng.gauss(0.0, self.volatility)) * open_price + 0.01
        high_price = max(open_price, close_price) + spread * rng.random()
        low_price = max(
            0.001, min(open_price, close_price) - spread * rng.random()
        )
        volume = rng.randint(self.min_volume, self.max_volume)

        bar: dict[str, Any] = {
            "time": time,
            "open": round(open_price, 4),
            "high": round(high_price, 4),
            "low": round(low_price, 4),
            "close": round(close_price, 4),
            "volume": volume,
        }
        self.price = close_price

        if corrupt_volume:
            draw = rng.random()
            if draw < 0.03:
                bar["volume"] = 0.0
            elif draw < 0.04:
                bar["volume"] = float("nan")

        return bar


def equity_bar_times(
    day: date,
    start_minutes: int,
    end_minutes_inclusive: int,
    step_minutes: int,
) -> list[int]:
    times: list[int] = []
    for minutes in range(
        start_minutes, end_minutes_inclusive + 1, step_minutes
    ):
        local = datetime(
            day.year,
            day.month,
            day.day,
            minutes // 60,
            minutes % 60,
            tzinfo=NEW_YORK,
        )
        times.append(int(local.timestamp()))
    return times


def generate_equity_bars(
    days: list[date],
    start_minutes: int,
    end_minutes_inclusive: int,
    step_minutes: int,
    seed: int,
    start_price: float = 100.0,
    corrupt_volume: bool = False,
) -> list[dict[str, Any]]:
    path = PricePath(start_price, seed)
    bars: list[dict[str, Any]] = []
    for day in days:
        for time in equity_bar_times(
            day, start_minutes, end_minutes_inclusive, step_minutes
        ):
            bars.append(path.next_bar(time, corrupt_volume))
    return bars


def generate_1d_equity_bars(
    days: list[date],
    seed: int,
    start_price: float = 150.0,
) -> list[dict[str, Any]]:
    path = PricePath(start_price, seed, volatility=0.004)
    bars: list[dict[str, Any]] = []
    for day in days:
        time = et_seconds(day.year, day.month, day.day, 0, 0)
        bars.append(path.next_bar(time))
    return bars


def generate_crypto_bars(
    start_utc: datetime,
    days: int,
    step_minutes: int,
    seed: int,
    start_price: float = 60_000.0,
    min_volume: int = 1_000,
    max_volume: int = 100_000,
) -> list[dict[str, Any]]:
    path = PricePath(
        start_price,
        seed,
        volatility=0.0006,
        min_volume=min_volume,
        max_volume=max_volume,
    )
    bars: list[dict[str, Any]] = []
    for day_offset in range(days):
        day_start = start_utc + timedelta(days=day_offset)
        for minutes in range(0, 24 * 60, step_minutes):
            time = int((day_start + timedelta(minutes=minutes)).timestamp())
            bars.append(path.next_bar(time))
    return bars


def generate_large_crypto_bars(
    count: int, seed: int
) -> list[dict[str, Any]]:
    """5.000 barras de 15m con precios ~60.000 y volúmenes grandes."""
    path = PricePath(
        60_000.0,
        seed,
        volatility=0.0005,
        min_volume=1_000_000,
        max_volume=5_000_000,
    )
    start = utc_seconds(2025, 1, 1, 0, 0)
    bars: list[dict[str, Any]] = []
    for index in range(count):
        bars.append(path.next_bar(start + index * 900))
    return bars


def encode_bars(bars: list[dict[str, Any]]) -> list[list[Any]]:
    return [[bar[key] for key in BAR_ORDER] for bar in bars]


def validate_bars(bars: list[dict[str, Any]]) -> None:
    """Valida segundos enteros y orden estrictamente creciente."""
    previous: int | None = None
    for bar in bars:
        time = bar["time"]
        if not isinstance(time, int) or abs(time) > 100_000_000_000:
            raise ValueError(f"time no es un entero de segundos: {time!r}")
        if previous is not None and time <= previous:
            raise ValueError(
                f"time no crece estrictamente: {previous} -> {time}"
            )
        previous = time


def market_datetime(time: int, market: str) -> datetime:
    return datetime.fromtimestamp(
        int(time), tz=NEW_YORK if market == "EQUITY" else UTC
    )


def is_equity_rth(local: datetime) -> bool:
    minutes = local.hour * 60 + local.minute
    return (
        local.isoweekday() <= 5
        and 9 * 60 + 30 <= minutes < 16 * 60
    )


def period_key(local: datetime, anchor: str) -> Any:
    if anchor == "SESSION":
        return local.date()
    if anchor == "WEEK":
        return local.date() - timedelta(days=local.isoweekday() - 1)
    if anchor == "MONTH":
        return (local.year, local.month)
    if anchor == "YTD":
        return local.year
    raise ValueError(f"Ancla de periodo desconocida: {anchor}")


def compute_anchor_index(
    bars: list[dict[str, Any]],
    market: str,
    anchor: str,
    visible_start: int = 0,
) -> int:
    """
    Resolución independiente del ancla. No usa Welford ni ninguna función de
    TypeScript. Devuelve -1 si no hay ancla válida.
    """
    if not bars:
        return -1
    if (
        not isinstance(visible_start, int)
        or isinstance(visible_start, bool)
        or visible_start < 0
        or visible_start >= len(bars)
    ):
        return -1

    validate_bars(bars)

    if anchor == "SESSION":
        last_local = market_datetime(bars[-1]["time"], market)
        last_key = period_key(last_local, "SESSION")
        start = len(bars) - 1
        while start > 0 and period_key(
            market_datetime(bars[start - 1]["time"], market), "SESSION"
        ) == last_key:
            start -= 1

        if market == "CRYPTO":
            return start

        for index in range(start, len(bars)):
            local = market_datetime(bars[index]["time"], market)
            if is_equity_rth(local):
                return index
        return -1

    if anchor in ("WEEK", "MONTH", "YTD"):
        last_local = market_datetime(bars[-1]["time"], market)
        last_key = period_key(last_local, anchor)
        start = len(bars) - 1
        while start > 0 and period_key(
            market_datetime(bars[start - 1]["time"], market), anchor
        ) == last_key:
            start -= 1
        return start

    if anchor == "HIGH_VOLUME_BAR":
        best_index = -1
        best_volume: float | None = None
        for index in range(visible_start, len(bars)):
            volume = bars[index]["volume"]
            if is_finite_number(volume) and float(volume) > 0.0:
                if best_volume is None or float(volume) > best_volume:
                    best_index = index
                    best_volume = float(volume)
        return best_index

    if anchor == "FULL_HISTORY":
        return visible_start

    raise ValueError(f"Ancla desconocida: {anchor}")


def hlc3_decimal(bar: dict[str, Any]) -> Decimal | None:
    values = (bar["high"], bar["low"], bar["close"])
    if not all(is_finite_number(value) for value in values):
        return None
    return (
        to_decimal(values[0])
        + to_decimal(values[1])
        + to_decimal(values[2])
    ) / Decimal(3)


def reference_points(
    bars: list[dict[str, Any]],
    market: str,
    anchor: str,
    visible_start: int = 0,
) -> tuple[int, list[list[Any]]]:
    """Calcula el ancla y todos los puntos de referencia."""
    anchor_index = compute_anchor_index(
        bars, market, anchor, visible_start
    )
    if anchor_index < 0:
        return anchor_index, []

    valid_prices: list[Decimal] = []
    valid_volumes: list[Decimal] = []
    points: list[list[Any]] = []
    two_point_five = Decimal("2.5")

    for bar in bars[anchor_index:]:
        price = hlc3_decimal(bar)
        volume = bar["volume"]
        if (
            price is not None
            and is_finite_number(volume)
            and float(volume) > 0.0
        ):
            valid_prices.append(price)
            valid_volumes.append(to_decimal(volume))

        if not valid_volumes:
            continue

        # Recalculo por definición en cada prefijo: sin recurrencia ni Welford.
        total_volume = Decimal(0)
        weighted_sum = Decimal(0)
        for item_price, item_volume in zip(valid_prices, valid_volumes):
            total_volume += item_volume
            weighted_sum += item_price * item_volume

        mean = weighted_sum / total_volume

        sum_squared_deviations = Decimal(0)
        for item_price, item_volume in zip(valid_prices, valid_volumes):
            difference = item_price - mean
            sum_squared_deviations += (
                item_volume * difference * difference
            )

        variance = sum_squared_deviations / total_volume
        sigma = variance.sqrt()

        points.append(
            [
                int(bar["time"]),
                float(mean),
                float(sigma),
                float(total_volume),
                float(mean + sigma),
                float(mean - sigma),
                float(mean + 2 * sigma),
                float(mean - 2 * sigma),
                float(mean + two_point_five * sigma),
                float(mean - two_point_five * sigma),
            ]
        )

    return anchor_index, points


def make_case(
    description: str,
    market: str,
    bars: list[dict[str, Any]],
    anchors: list[tuple[str, int]],
) -> dict[str, Any]:
    anchor_results: list[dict[str, Any]] = []
    for anchor, visible_start in anchors:
        anchor_index, points = reference_points(
            bars, market, anchor, visible_start
        )
        anchor_results.append(
            {
                "anchor": anchor,
                "visibleStart": visible_start,
                "anchorIndex": anchor_index,
                "points": points,
            }
        )

    return {
        "description": description,
        "market": market,
        "bars": encode_bars(bars),
        "anchors": anchor_results,
    }


def build_cases() -> dict[str, dict[str, Any]]:
    cases: dict[str, dict[str, Any]] = {}

    # a) 5m acciones con cambio de horario y corrupciones de volumen.
    a_days = business_days(date(2025, 3, 5), date(2025, 3, 14))
    a_bars = generate_equity_bars(
        a_days,
        PREMARKET_START_MINUTES,
        AFTERHOURS_END_MINUTES,
        5,
        seed=90305,
        corrupt_volume=True,
    )
    a_visible_start = len(a_bars) // 3
    cases["a_equity_5m_dst"] = make_case(
        "5m, 2025-03-05 a 2025-03-14, 04:00-19:55 ET, cruza el cambio de "
        "horario; ~3% volumen 0 y ~1% volumen NaN; semilla 90305",
        "EQUITY",
        a_bars,
        [
            ("SESSION", 0),
            ("WEEK", 0),
            ("MONTH", 0),
            ("HIGH_VOLUME_BAR", 0),
            ("FULL_HISTORY", 0),
            ("FULL_HISTORY", a_visible_start),
        ],
    )

    # b) 1h acciones cruzando fin de mes y de año: noviembre y diciembre de
    #    2024 y enero de 2025. Incluye 2024-12-31 20:00 ET (2025-01-01 01:00
    #    UTC), que no debe cambiar mes ni año.
    b_days = business_days(date(2024, 11, 1), date(2025, 1, 31))
    b_bars = generate_equity_bars(
        b_days,
        PREMARKET_START_MINUTES,
        20 * 60,
        60,
        seed=91231,
    )
    cases["b_equity_1h_month_year_boundary"] = make_case(
        "1h, 2024-11-01 a 2025-01-31, 04:00-20:00 ET; incluye "
        "2024-12-31 20:00 ET; semilla 91231",
        "EQUITY",
        b_bars,
        [("WEEK", 0), ("MONTH", 0), ("YTD", 0)],
    )

    # c) 1D acciones con timestamps a las 00:00 ET.
    c_days = business_days(date(2024, 12, 2), date(2025, 2, 28))
    c_bars = generate_1d_equity_bars(c_days, seed=92401)
    cases["c_equity_1d_month_year"] = make_case(
        "1D, 2024-12-02 a 2025-02-28, timestamps a las 00:00 ET; semilla 92401",
        "EQUITY",
        c_bars,
        [("YTD", 0), ("MONTH", 0)],
    )

    # d) Cripto 15m, 4 días: viernes 2025-01-31 a lunes 2025-02-03.
    crypto_start = datetime(2025, 1, 31, 0, 0, 0, tzinfo=UTC)
    d_bars = generate_crypto_bars(
        crypto_start, days=4, step_minutes=15, seed=92501
    )
    cases["d_crypto_15m_utc_weekend"] = make_case(
        "cripto 15m, 2025-01-31 00:00 UTC a 2025-02-03 23:45 UTC, cruza "
        "medianoche UTC, fin de mes y fin de semana; semilla 92501",
        "CRYPTO",
        d_bars,
        [("SESSION", 0), ("WEEK", 0), ("MONTH", 0)],
    )

    # e) 5.000 barras con precios ~60.000, ancla en la barra 0.
    e_bars = generate_large_crypto_bars(5_000, seed=92601)
    cases["e_large_5000_bars"] = make_case(
        "5.000 barras 15m con precios ~60.000 y volúmenes grandes, ancla en "
        "la barra 0; semilla 92601",
        "CRYPTO",
        e_bars,
        [("FULL_HISTORY", 0)],
    )

    # h) primera barra con volumen 0 y precios NaN intercalados.
    h_times = [
        et_seconds(2025, 3, 12, 9, 30),
        et_seconds(2025, 3, 12, 9, 35),
        et_seconds(2025, 3, 12, 9, 40),
        et_seconds(2025, 3, 12, 9, 45),
        et_seconds(2025, 3, 12, 9, 50),
        et_seconds(2025, 3, 12, 9, 55),
        et_seconds(2025, 3, 12, 10, 0),
        et_seconds(2025, 3, 12, 10, 5),
    ]
    h_bars: list[dict[str, Any]] = [
        {
            "time": h_times[0],
            "open": 100.0,
            "high": 101.0,
            "low": 99.0,
            "close": 100.0,
            "volume": 0.0,
        },
        {
            "time": h_times[1],
            "open": 100.5,
            "high": float("nan"),
            "low": 99.5,
            "close": 100.5,
            "volume": 1_000,
        },
        {
            "time": h_times[2],
            "open": 101.0,
            "high": 102.0,
            "low": 100.0,
            "close": 101.5,
            "volume": 2_000,
        },
        {
            "time": h_times[3],
            "open": 101.5,
            "high": 102.5,
            "low": float("nan"),
            "close": 102.0,
            "volume": 1_500,
        },
        {
            "time": h_times[4],
            "open": 102.0,
            "high": 103.0,
            "low": 101.0,
            "close": 102.5,
            "volume": 3_000,
        },
        {
            "time": h_times[5],
            "open": 102.5,
            "high": 103.5,
            "low": 101.5,
            "close": 103.0,
            "volume": float("nan"),
        },
        {
            "time": h_times[6],
            "open": 103.0,
            "high": 104.0,
            "low": 102.0,
            "close": float("nan"),
            "volume": 2_500,
        },
        {
            "time": h_times[7],
            "open": 103.5,
            "high": 105.0,
            "low": 103.0,
            "close": 104.5,
            "volume": 1_800,
        },
    ]
    cases["h_zero_volume_nan_prices"] = make_case(
        "primera barra con volumen 0 y precios NaN intercalados; no se emite "
        "punto hasta que cumVolume > 0 y las barras ignoradas repiten el "
        "último valor",
        "EQUITY",
        h_bars,
        [("FULL_HISTORY", 0)],
    )

    return cases


def build_anchor_cases() -> dict[str, dict[str, Any]]:
    def sample_bar(
        time: int, volume: float, price: float = 100.0
    ) -> dict[str, Any]:
        return {
            "time": time,
            "open": price,
            "high": price + 1.0,
            "low": price - 1.0,
            "close": price,
            "volume": volume,
        }

    midweek_times = [
        et_seconds(2025, 3, 12, 4, 0) + index * 300
        for index in range(10)
    ]
    midweek_bars = [
        sample_bar(time, 1_000 + index, 100.0 + index * 0.1)
        for index, time in enumerate(midweek_times)
    ]

    premarket_bars = [
        sample_bar(et_seconds(2025, 3, 11, 9, 30), 1_000),
        sample_bar(et_seconds(2025, 3, 11, 9, 35), 1_100),
        sample_bar(et_seconds(2025, 3, 12, 7, 0), 1_200),
        sample_bar(et_seconds(2025, 3, 12, 7, 5), 1_300),
    ]

    tie_bars = [
        sample_bar(et_seconds(2025, 3, 12, 9, 30) + index * 300, volume)
        for index, volume in enumerate([10.0, 50.0, 50.0, 20.0])
    ]

    no_volume_bars = [
        sample_bar(et_seconds(2025, 3, 12, 9, 30) + index * 300, volume)
        for index, volume in enumerate(
            [0.0, float("nan"), float("inf"), -5.0]
        )
    ]

    return {
        "f1_midweek_buffer": {
            "description": (
                "buffer que empieza el miércoles 2025-03-12: WEEK debe anclar "
                "en la primera barra del buffer"
            ),
            "market": "EQUITY",
            "anchor": "WEEK",
            "visibleStart": 0,
            "bars": encode_bars(midweek_bars),
            "expectedAnchorIndex": 0,
        },
        "f2_session_premarket_last": {
            "description": (
                "SESSION en EQUITY con última barra premarket (2025-03-12 "
                "07:05 ET): no hay barra RTH en esa fecha y el ancla es -1, "
                "sin caer en la sesión anterior"
            ),
            "market": "EQUITY",
            "anchor": "SESSION",
            "visibleStart": 0,
            "bars": encode_bars(premarket_bars),
            "expectedAnchorIndex": -1,
        },
        "f3_high_volume_tie": {
            "description": (
                "HIGH_VOLUME_BAR con empate en el volumen máximo: gana la "
                "primera barra (índice 1)"
            ),
            "market": "EQUITY",
            "anchor": "HIGH_VOLUME_BAR",
            "visibleStart": 0,
            "bars": encode_bars(tie_bars),
            "expectedAnchorIndex": 1,
        },
        "f4_no_finite_volume": {
            "description": (
                "sin volumen finito > 0 (0, NaN, Infinity, negativo): el "
                "ancla HIGH_VOLUME_BAR es -1"
            ),
            "market": "EQUITY",
            "anchor": "HIGH_VOLUME_BAR",
            "visibleStart": 0,
            "bars": encode_bars(no_volume_bars),
            "expectedAnchorIndex": -1,
        },
        "f5_empty_array": {
            "description": "array vacío: el ancla FULL_HISTORY es -1",
            "market": "EQUITY",
            "anchor": "FULL_HISTORY",
            "visibleStart": 0,
            "bars": [],
            "expectedAnchorIndex": -1,
        },
    }


def build_error_cases() -> dict[str, dict[str, Any]]:
    def sample_bar(time: int) -> dict[str, Any]:
        return {
            "time": time,
            "open": 100.0,
            "high": 101.0,
            "low": 99.0,
            "close": 100.0,
            "volume": 1_000,
        }

    first = et_seconds(2025, 3, 12, 9, 30)
    second = et_seconds(2025, 3, 12, 9, 35)

    return {
        "g1_non_increasing_times": {
            "description": (
                "dos barras con tiempo repetido o anterior: el orden debe ser "
                "estrictamente creciente y computeAnchoredVwap debe lanzar"
            ),
            "market": "EQUITY",
            "anchor": "FULL_HISTORY",
            "visibleStart": 0,
            "bars": encode_bars(
                [sample_bar(second), sample_bar(first)]
            ),
        },
        "g2_milliseconds": {
            "description": (
                "bar.time en milisegundos: no es un entero de segundos y debe "
                "lanzar, sin normalizarse"
            ),
            "market": "EQUITY",
            "anchor": "FULL_HISTORY",
            "visibleStart": 0,
            "bars": encode_bars([sample_bar(first * 1000)]),
        },
    }


def build_fixture() -> dict[str, Any]:
    return {
        "metadata": {
            "generator": "tools/gen_avwap_fixture.py",
            "command": "python tools/gen_avwap_fixture.py",
            "method": (
                "Independent Decimal(precision=60) + zoneinfo reference. "
                "For every prefix it recomputes mu = sum(P*V)/sum(V) and "
                "sigma = sqrt(sum(V*(P-mu)^2)/sum(V)) over all valid bars "
                "from the anchor. No Welford, no recurrence, no TypeScript "
                "logic. Anchor indices are resolved independently with "
                "datetime/zoneinfo."
            ),
            "tolerance": (
                "1e-9 relative for vwap, stdDev, cumVolume and all bands; "
                "exact for anchorIndex and time"
            ),
            "barOrder": BAR_ORDER,
            "pointOrder": POINT_ORDER,
            "nanEncoding": 'NaN se serializa como la cadena "NaN"',
            "seeds": {
                "a": 90305,
                "b": 91231,
                "c": 92401,
                "d": 92501,
                "e": 92601,
            },
        },
        "cases": build_cases(),
        "anchorCases": build_anchor_cases(),
        "errorCases": build_error_cases(),
    }


def main() -> None:
    print(
        "Generando fixture de AVWAP anclado con Decimal(precision=60) y "
        "zoneinfo..."
    )
    fixture = build_fixture()

    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(FIXTURE_PATH, "w", encoding="utf-8") as file:
        json.dump(
            json_safe(fixture),
            file,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        file.write("\n")

    print(f"Fixture generado exitosamente en: {FIXTURE_PATH}")
    print(f"Casos con puntos: {len(fixture['cases'])}")
    total_bars = 0
    total_points = 0
    for name, case in fixture["cases"].items():
        bars_count = len(case["bars"])
        total_bars += bars_count
        print(f"  - {name}: {bars_count} barras")
        for anchor in case["anchors"]:
            points_count = len(anchor["points"])
            total_points += points_count
            print(
                "      "
                f"{anchor['anchor']} visibleStart={anchor['visibleStart']}: "
                f"anchorIndex={anchor['anchorIndex']}, "
                f"{points_count} puntos"
            )
    print(f"Total barras: {total_bars}")
    print(f"Total puntos: {total_points}")
    print(f"Casos de ancla: {len(fixture['anchorCases'])}")
    for name, case in fixture["anchorCases"].items():
        print(
            f"  - {name}: {case['description']} -> "
            f"{case['expectedAnchorIndex']}"
        )
    print(f"Casos de error: {len(fixture['errorCases'])}")
    for name, case in fixture["errorCases"].items():
        print(f"  - {name}: {case['description']}")
    print(f"Tamaño: {FIXTURE_PATH.stat().st_size} bytes")


if __name__ == "__main__":
    main()
