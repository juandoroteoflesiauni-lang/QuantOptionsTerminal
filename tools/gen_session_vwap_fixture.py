#!/usr/bin/env python3
"""
tools/gen_session_vwap_fixture.py

Generador de referencia INDEPENDIENTE para el VWAP de sesión (SPEC punto 4).

Método:
  - Decimal con precisión 60 para todos los cálculos.
  - zoneinfo (America/New_York) para las barras de acciones y UTC para cripto.
  - En cada barra se recalcula por definición
        sum(precio * volumen) / sum(volumen)
    sobre TODAS las barras de la sesión hasta ese momento. No se usa Welford,
    ni ninguna recurrencia, ni se copia la lógica de TypeScript.
  - El precio de cada barra se decide con las reglas del SPEC:
        TRADE_VWAP: usa vw si es finito y > 0; si no, (H+L+C)/3 en esa barra.
        HLC3: siempre (H+L+C)/3.
  - Una barra solo contribuye si el precio es finito, el volumen es finito
    y el volumen es > 0.

Casos (semillas fijas):
  a1) 5m, 2025-01-13 a 2025-01-24, días hábiles, 04:00-19:55 ET.
      El lunes 2025-01-20 (MLK) no tiene barras.
  a2) 5m, 2025-03-05 a 2025-03-14 (cambio a horario de verano).
  a3) 5m, 2025-10-30 a 2025-11-07 (vuelta a horario estándar).
      En a1-a3 se corrompen aleatoriamente ~3% vw nulo, ~2% vw=0,
      ~1% vw=NaN, ~3% volumen=0 y ~1% volumen=NaN.
  b)  1m, 2025-07-15, 04:00-19:59 ET.
  c)  15m, 2025-07-15 y 2025-07-16, 04:00-19:45 ET.
  d1) 5m, buffer que empieza en premarket (04:00 ET), mismo día.
  d2) 5m, buffer que empieza a las 11:30 ET (sesión parcial).
  e1) cripto 15m, 3 días cruzando medianoche UTC, con vw en las barras.
  e2) el mismo caso sin vw; con la fuente por defecto (HLC3) debe coincidir.
  f1) acciones 15m con priceSource='HLC3' explícito.
  f2) las mismas barras sin ningún vw y con la fuente por defecto:
      debe coincidir con f1 (cada barra cae a HLC3).
  g)  errores esperados: barSeconds=3600 en EQUITY, tiempos no crecientes
      y tiempo en milisegundos.

Los NaN se serializan como la cadena "NaN" para mantener JSON estricto.
Los vw nulos se serializan como null (equivalente a vw ausente).

Para regenerar el fixture:
  python tools/gen_session_vwap_fixture.py

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
    / "session_vwap_reference.json"
)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# Ventana de barras de acciones usada por los casos largos.
PREMARKET_START_MINUTES = 4 * 60
AFTERHOURS_END_MINUTES = 19 * 60 + 55


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
    """Camino OHLCV determinista con semilla fija y corrupciones opcionales."""

    def __init__(
        self,
        start_price: float,
        seed: int,
        volatility: float = 0.0008,
    ) -> None:
        self.rng = random.Random(seed)
        self.price = start_price
        self.volatility = volatility

    def next_bar(self, time: int, corrupt: bool) -> dict[str, Any]:
        rng = self.rng
        open_price = self.price

        drift = rng.gauss(0.0, self.volatility)
        close_price = max(0.01, open_price * (1.0 + drift))
        spread = abs(rng.gauss(0.0, self.volatility)) * open_price + 0.01
        high_price = max(open_price, close_price) + spread * rng.random()
        low_price = max(
            0.001, min(open_price, close_price) - spread * rng.random()
        )
        vw = low_price + (high_price - low_price) * (
            0.25 + 0.5 * rng.random()
        )
        volume = rng.randint(1_000, 100_000)

        bar: dict[str, Any] = {
            "time": time,
            "open": round(open_price, 4),
            "high": round(high_price, 4),
            "low": round(low_price, 4),
            "close": round(close_price, 4),
            "volume": volume,
            "vw": round(vw, 4),
        }
        self.price = close_price

        if corrupt:
            vw_draw = rng.random()
            if vw_draw < 0.03:
                bar["vw"] = None
            elif vw_draw < 0.05:
                bar["vw"] = 0.0
            elif vw_draw < 0.06:
                bar["vw"] = float("nan")

            volume_draw = rng.random()
            if volume_draw < 0.03:
                bar["volume"] = 0.0
            elif volume_draw < 0.04:
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
    corrupt: bool = False,
) -> list[dict[str, Any]]:
    path = PricePath(start_price, seed)
    bars: list[dict[str, Any]] = []
    for day in days:
        for time in equity_bar_times(
            day, start_minutes, end_minutes_inclusive, step_minutes
        ):
            bars.append(path.next_bar(time, corrupt))
    return bars


def generate_crypto_bars(
    start_utc: datetime,
    days: int,
    step_minutes: int,
    seed: int,
    start_price: float = 60_000.0,
) -> list[dict[str, Any]]:
    path = PricePath(start_price, seed, volatility=0.0006)
    bars: list[dict[str, Any]] = []
    for day_offset in range(days):
        day_start = start_utc + timedelta(days=day_offset)
        for minutes in range(0, 24 * 60, step_minutes):
            time = int((day_start + timedelta(minutes=minutes)).timestamp())
            bars.append(path.next_bar(time, corrupt=False))
    return bars


def strip_vw(bars: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {key: value for key, value in bar.items() if key != "vw"}
        for bar in bars
    ]


def resolve_price_source(options: dict[str, Any]) -> str:
    explicit = options.get("priceSource")
    if explicit is not None:
        return str(explicit)
    return "TRADE_VWAP" if options["market"] == "EQUITY" else "HLC3"


def bar_price(
    bar: dict[str, Any], price_source: str
) -> tuple[Decimal, str]:
    if price_source == "TRADE_VWAP":
        vw = bar.get("vw")
        if (
            vw is not None
            and is_finite_number(vw)
            and float(vw) > 0.0
        ):
            return to_decimal(float(vw)), "VW"

    price = (
        to_decimal(float(bar["high"]))
        + to_decimal(float(bar["low"]))
        + to_decimal(float(bar["close"]))
    ) / Decimal(3)
    return price, "HLC3"


def reference_points(
    bars: list[dict[str, Any]], options: dict[str, Any]
) -> list[dict[str, Any]]:
    """
    Referencia por definición: recalcula la media ponderada completa de la
    sesión en cada barra. No hay recurrencia ni Welford.
    """
    market = str(options["market"])
    price_source = resolve_price_source(options)

    points: list[dict[str, Any]] = []
    session_key: str | None = None
    session_entries: list[tuple[Decimal, Decimal]] = []
    last: tuple[Decimal, Decimal] | None = None

    for bar in bars:
        time = int(bar["time"])
        local = datetime.fromtimestamp(
            time, tz=NEW_YORK if market == "EQUITY" else UTC
        )

        in_session = True
        if market == "EQUITY":
            minutes_of_day = local.hour * 60 + local.minute
            in_session = (
                local.isoweekday() <= 5
                and 9 * 60 + 30 <= minutes_of_day < 16 * 60
            )

        if not in_session:
            if last is None:
                points.append(
                    {
                        "time": time,
                        "vwap": "NaN",
                        "cumVolume": 0.0,
                        "frozen": True,
                        "source": "NONE",
                    }
                )
            else:
                points.append(
                    {
                        "time": time,
                        "vwap": float(last[0]),
                        "cumVolume": float(last[1]),
                        "frozen": True,
                        "source": "NONE",
                    }
                )
            continue

        date_key = local.date().isoformat()
        if date_key != session_key:
            session_key = date_key
            session_entries = []
            last = None

        price, used_source = bar_price(bar, price_source)
        volume = bar["volume"]
        if (
            price.is_finite()
            and is_finite_number(volume)
            and float(volume) > 0.0
        ):
            session_entries.append(
                (price, to_decimal(float(volume)))
            )

        cumulative_volume = Decimal(0)
        weighted_sum = Decimal(0)
        for entry_price, entry_volume in session_entries:
            cumulative_volume += entry_volume
            weighted_sum += entry_price * entry_volume

        if cumulative_volume > 0:
            vwap = weighted_sum / cumulative_volume
            last = (vwap, cumulative_volume)
            point_vwap: Any = float(vwap)
            point_cumulative: Any = float(cumulative_volume)
        else:
            point_vwap = "NaN"
            point_cumulative = 0.0

        points.append(
            {
                "time": time,
                "vwap": point_vwap,
                "cumVolume": point_cumulative,
                "frozen": False,
                "source": used_source,
            }
        )

    return points


def make_case(
    description: str,
    options: dict[str, Any],
    bars: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "description": description,
        "options": options,
        "bars": bars,
        "points": reference_points(bars, options),
    }


def build_cases() -> dict[str, dict[str, Any]]:
    cases: dict[str, dict[str, Any]] = {}

    a1_days = business_days(
        date(2025, 1, 13),
        date(2025, 1, 24),
        {date(2025, 1, 20)},
    )
    a1_bars = generate_equity_bars(
        a1_days,
        PREMARKET_START_MINUTES,
        AFTERHOURS_END_MINUTES,
        5,
        seed=1301,
        corrupt=True,
    )
    cases["a1_equity_5m_2025_01_13_24"] = make_case(
        "5m, 2025-01-13 a 2025-01-24, dias habiles, 04:00-19:55 ET; "
        "2025-01-20 (MLK) sin barras; vw/volumen corruptos con semilla 1301",
        {"market": "EQUITY", "barSeconds": 300},
        a1_bars,
    )

    a2_days = business_days(date(2025, 3, 5), date(2025, 3, 14))
    a2_bars = generate_equity_bars(
        a2_days,
        PREMARKET_START_MINUTES,
        AFTERHOURS_END_MINUTES,
        5,
        seed=305,
        corrupt=True,
    )
    cases["a2_equity_5m_dst_2025_03_05_14"] = make_case(
        "5m, 2025-03-05 a 2025-03-14, cruza el cambio a horario de verano; "
        "vw/volumen corruptos con semilla 305",
        {"market": "EQUITY", "barSeconds": 300},
        a2_bars,
    )

    a3_days = business_days(date(2025, 10, 30), date(2025, 11, 7))
    a3_bars = generate_equity_bars(
        a3_days,
        PREMARKET_START_MINUTES,
        AFTERHOURS_END_MINUTES,
        5,
        seed=1030,
        corrupt=True,
    )
    cases["a3_equity_5m_dst_back_2025_10_30_11_07"] = make_case(
        "5m, 2025-10-30 a 2025-11-07, cruza la vuelta a horario estandar; "
        "vw/volumen corruptos con semilla 1030",
        {"market": "EQUITY", "barSeconds": 300},
        a3_bars,
    )

    b_bars = generate_equity_bars(
        [date(2025, 7, 15)],
        PREMARKET_START_MINUTES,
        19 * 60 + 59,
        1,
        seed=404,
    )
    cases["b_equity_1m_2025_07_15"] = make_case(
        "1m, 2025-07-15, 04:00-19:59 ET, semilla 404",
        {"market": "EQUITY", "barSeconds": 60},
        b_bars,
    )

    c_bars = generate_equity_bars(
        [date(2025, 7, 15), date(2025, 7, 16)],
        PREMARKET_START_MINUTES,
        19 * 60 + 45,
        15,
        seed=505,
    )
    cases["c_equity_15m_2025_07_15_16"] = make_case(
        "15m, 2025-07-15 y 2025-07-16, 04:00-19:45 ET, semilla 505",
        {"market": "EQUITY", "barSeconds": 900},
        c_bars,
    )

    d1_bars = generate_equity_bars(
        [date(2025, 7, 16)],
        PREMARKET_START_MINUTES,
        AFTERHOURS_END_MINUTES,
        5,
        seed=606,
    )
    cases["d1_equity_5m_premarket_start"] = make_case(
        "5m desde 04:00 ET: las primeras barras son premarket y deben salir "
        "congeladas con vwap=NaN y cumVolume=0; semilla 606",
        {"market": "EQUITY", "barSeconds": 300},
        d1_bars,
    )

    d2_bars = generate_equity_bars(
        [date(2025, 7, 16)],
        11 * 60 + 30,
        AFTERHOURS_END_MINUTES,
        5,
        seed=607,
    )
    cases["d2_equity_5m_partial_from_1130"] = make_case(
        "5m desde 11:30 ET: sesion parcial, el primer punto ya acumula solo "
        "desde 11:30; semilla 607",
        {"market": "EQUITY", "barSeconds": 300},
        d2_bars,
    )

    crypto_start = datetime(2025, 1, 1, 0, 0, 0, tzinfo=UTC)
    e_bars = generate_crypto_bars(
        crypto_start, days=3, step_minutes=15, seed=707
    )
    cases["e1_crypto_15m_with_vw"] = make_case(
        "cripto 15m, 2025-01-01 a 2025-01-03 UTC, con vw en las barras; "
        "la fuente por defecto HLC3 ignora vw",
        {"market": "CRYPTO", "barSeconds": 900},
        e_bars,
    )
    cases["e2_crypto_15m_without_vw"] = make_case(
        "cripto 15m, mismas barras sin vw; debe coincidir con e1",
        {"market": "CRYPTO", "barSeconds": 900},
        strip_vw(e_bars),
    )

    f_bars = generate_equity_bars(
        [date(2025, 7, 17)],
        PREMARKET_START_MINUTES,
        19 * 60 + 45,
        15,
        seed=808,
    )
    cases["f1_equity_15m_hlc3_explicit"] = make_case(
        "acciones 15m con priceSource='HLC3' explicito; semilla 808",
        {"market": "EQUITY", "barSeconds": 900, "priceSource": "HLC3"},
        f_bars,
    )
    cases["f2_equity_15m_no_vw_default"] = make_case(
        "las mismas barras sin ningun vw y con la fuente por defecto: cada "
        "barra cae a HLC3 y debe coincidir con f1",
        {"market": "EQUITY", "barSeconds": 900},
        strip_vw(f_bars),
    )

    return cases


def build_error_cases() -> dict[str, dict[str, Any]]:
    def sample_bar(time: int) -> dict[str, Any]:
        return {
            "time": time,
            "open": 100.0,
            "high": 101.0,
            "low": 99.0,
            "close": 100.0,
            "volume": 1_000,
            "vw": 100.0,
        }

    first = et_seconds(2025, 7, 15, 9, 30)
    second = et_seconds(2025, 7, 15, 9, 35)

    return {
        "g1_equity_bar_seconds_3600": {
            "description": (
                "EQUITY con barSeconds=3600 (1h): no divide 1800, debe lanzar"
            ),
            "options": {"market": "EQUITY", "barSeconds": 3600},
            "bars": [sample_bar(first)],
        },
        "g2_non_increasing_times": {
            "description": (
                "Dos barras con el mismo tiempo (o anterior): el orden debe "
                "ser estrictamente creciente, debe lanzar"
            ),
            "options": {"market": "EQUITY", "barSeconds": 300},
            "bars": [sample_bar(second), sample_bar(first)],
        },
        "g3_milliseconds": {
            "description": (
                "bar.time en milisegundos: no es un entero de segundos y "
                "debe lanzar, sin normalizarse"
            ),
            "options": {"market": "EQUITY", "barSeconds": 300},
            "bars": [sample_bar(first * 1000)],
        },
    }


def build_fixture() -> dict[str, Any]:
    return {
        "metadata": {
            "generator": "tools/gen_session_vwap_fixture.py",
            "command": "python tools/gen_session_vwap_fixture.py",
            "method": (
                "Independent Decimal(precision=60) + zoneinfo reference; "
                "each point recomputes sum(price*volume)/sum(volume) over "
                "all session bars up to that bar; no Welford, no TypeScript "
                "logic"
            ),
            "tolerance": "1e-9 relative for vwap and cumVolume; exact for "
            "frozen and source",
            "nanEncoding": 'NaN se serializa como la cadena "NaN"',
            "nullVwMeaning": "vw null equivale a vw ausente",
            "seeds": {
                "a1": 1301,
                "a2": 305,
                "a3": 1030,
                "b": 404,
                "c": 505,
                "d1": 606,
                "d2": 607,
                "e": 707,
                "f": 808,
            },
        },
        "cases": build_cases(),
        "errorCases": build_error_cases(),
    }


def main() -> None:
    print(
        "Generando fixture de VWAP de sesion con Decimal(precision=60) y "
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
    for name, case in fixture["cases"].items():
        bars_count = len(case["bars"])
        total_bars += bars_count
        print(f"  - {name}: {bars_count} barras")
    print(f"Total barras: {total_bars}")
    print(f"Casos de error: {len(fixture['errorCases'])}")
    for name, case in fixture["errorCases"].items():
        print(f"  - {name}: {case['description']}")
    print(f"Tamaño: {FIXTURE_PATH.stat().st_size} bytes")


if __name__ == "__main__":
    main()
