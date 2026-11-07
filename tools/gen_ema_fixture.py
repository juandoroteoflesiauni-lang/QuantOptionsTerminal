#!/usr/bin/env python3
"""
tools/gen_ema_fixture.py

Generador de fixtures de referencia para la EMA (SPEC punto 2).

REFERENCIA PRINCIPAL (independiente):
  - Implementación explícita de la EMA con semilla SMA escrita a mano.
  - Aritmética Decimal con precisión 60.
  - NO se usa pandas.ewm ni ninguna librería de EMA para la referencia principal.

Reglas implementadas:
  - alpha = 2 / (period + 1)
  - Índices 0..period-2: NaN.
  - Índice period-1: SMA de los primeros `period` cierres.
  - Índices siguientes: ema = alpha * close + (1 - alpha) * ema_previo.
  - Un cierre no finito invalida ese índice y todos los siguientes (NaN).

Casos:
  (a) 1.500 cierres con semilla fija y periodos 9, 21, 50 y 200.
  (b) menos cierres que el periodo (todo NaN).
  (c) exactamente `period` cierres, para 9, 21, 50 y 200.
  (d) un cierre NaN en medio.
  (e) precios constantes (la EMA debe ser exactamente ese precio).

SEGUNDO FIXTURE (solo comprobación cruzada):
  A partir de la barra 1000 del caso (a), se compara la EMA con semilla SMA
  contra pandas.ewm(span=N, adjust=False). La diferencia relativa debe ser
  menor que 1e-6 para N = 9, 21, 50 y 200. pandas NO participa en la
  referencia principal; solo valida que la recurrencia sea la esperada.

Semillas fijas:
  - Caso (a): 20260308
  - Caso (c): 9001
  - Caso (d): 4242

Para regenerar el fixture:
  python tools/gen_ema_fixture.py

Si pandas no está instalado, instálalo con:
  python -m pip install pandas
"""

from __future__ import annotations

import json
import math
import random
import sys
from decimal import Decimal, getcontext
from pathlib import Path
from typing import Any, Sequence

try:
    import pandas as pd
except ImportError as exc:  # pragma: no cover - depende del entorno
    raise SystemExit(
        "pandas no está instalado. Instálalo con:\n"
        "  python -m pip install pandas"
    ) from exc

# Precisión alta para que la referencia Decimal sea independiente de float64.
getcontext().prec = 60

# En Windows la consola puede usar una code page distinta de UTF-8; forzamos
# UTF-8 en stdout para que los mensajes con acentos se impriman correctamente.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

PERIODS: tuple[int, ...] = (9, 21, 50, 200)
CROSS_CHECK_START_INDEX = 1000
CROSS_CHECK_TOLERANCE = 1e-6
CONSTANT_PRICE = 42.5
FIXTURE_PATH = (
    Path(__file__).resolve().parent.parent / "fixtures" / "ema_reference.json"
)

DecimalOrNone = Decimal | None


def to_decimal(value: float) -> DecimalOrNone:
    """Convierte un cierre a Decimal, o None si no es finito."""
    if not math.isfinite(value):
        return None
    return Decimal(str(value))


def serialize_decimal(value: DecimalOrNone) -> float | str:
    """Serializa Decimal/None a un valor JSON compatible."""
    if value is None:
        return "NaN"
    as_float = float(value)
    if math.isnan(as_float):
        return "NaN"
    if math.isinf(as_float):
        return "Infinity" if as_float > 0 else "-Infinity"
    return as_float


def serialize_series(series: Sequence[DecimalOrNone]) -> list[float | str]:
    return [serialize_decimal(value) for value in series]


def serialize_closes(values: Sequence[float]) -> list[float | str]:
    return [serialize_decimal(to_decimal(value)) for value in values]


def calculate_ema_reference(
    values: Sequence[float],
    period: int,
) -> list[DecimalOrNone]:
    """
    Implementación explícita e independiente de la EMA con semilla SMA.

    No usa pandas.ewm, ni recursión de librerías, ni la lógica de TypeScript:
    es la definición matemática escrita directamente con Decimal.
    """
    closes = [to_decimal(value) for value in values]
    count = len(closes)
    result: list[DecimalOrNone] = [None] * count

    if count < period:
        return result

    # Semilla SMA escrita a mano.
    seed_sum = Decimal(0)
    for index in range(period):
        close = closes[index]
        if close is None:
            # Semilla no construible: toda la serie queda en NaN.
            return result
        seed_sum += close
    seed = seed_sum / Decimal(period)

    alpha = Decimal(2) / Decimal(period + 1)
    one_minus_alpha = Decimal(1) - alpha

    result[period - 1] = seed
    ema = seed

    for index in range(period, count):
        close = closes[index]
        if close is None:
            # Este índice y todos los siguientes quedan en None (NaN).
            break
        ema = alpha * close + one_minus_alpha * ema
        result[index] = ema

    return result


def expected_for_periods(
    values: Sequence[float],
    periods: Sequence[int],
) -> dict[str, list[float | str]]:
    return {
        str(period): serialize_series(calculate_ema_reference(values, period))
        for period in periods
    }


def generate_case_a_closes() -> list[float]:
    """(a) 1.500 cierres con semilla fija 20260308, alrededor de 100."""
    rng = random.Random(20260308)
    center = Decimal("100.00")
    current = Decimal("100.00")
    closes: list[float] = []

    for _ in range(1500):
        # Paso pseudoaleatorio fijo en centavos y reversión suave a la media.
        shock = Decimal(rng.randint(-8, 8)) / Decimal(100)
        pull = (center - current) * Decimal("0.05")
        current = (current + shock + pull).quantize(Decimal("0.01"))
        closes.append(float(current))

    return closes


def generate_case_b_closes() -> list[float]:
    """(b) 8 cierres: menos que cualquiera de los cuatro periodos."""
    return [101.25, 100.75, 102.0, 101.5, 103.25, 102.75, 104.0, 103.5]


def generate_case_c_base_closes() -> list[float]:
    """Serie fija para los casos (c); cada caso usa exactamente `period` cierres."""
    rng = random.Random(9001)
    current = Decimal("50.00")
    closes: list[float] = []

    for _ in range(max(PERIODS)):
        shock = Decimal(rng.randint(-15, 15)) / Decimal(100)
        current = (current + shock).quantize(Decimal("0.01"))
        closes.append(float(current))

    return closes


def generate_case_d_closes() -> list[float]:
    """(d) 300 cierres con un NaN en el índice 130."""
    rng = random.Random(4242)
    current = Decimal("200.00")
    closes: list[float] = []

    for _ in range(300):
        shock = Decimal(rng.randint(-25, 25)) / Decimal(100)
        current = (current + shock).quantize(Decimal("0.01"))
        closes.append(float(current))

    closes[130] = float("nan")
    return closes


def generate_case_e_closes() -> list[float]:
    """(e) 300 cierres constantes y binariamente exactos en float64."""
    return [CONSTANT_PRICE] * 300


def build_case_c_cases() -> dict[str, dict[str, Any]]:
    """Casos (c): exactamente `period` cierres para cada periodo."""
    base = generate_case_c_base_closes()
    cases: dict[str, dict[str, Any]] = {}

    for period in PERIODS:
        closes = base[:period]
        cases[f"case_c_exactly_{period}_closes"] = {
            "description": (
                f"exactamente {period} cierres: la semilla SMA cae en el índice "
                f"{period - 1}"
            ),
            "closes": serialize_closes(closes),
            "expected": expected_for_periods(closes, (period,)),
        }

    return cases


def build_pandas_crosscheck(
    closes: Sequence[float],
    expected_by_period: dict[int, Sequence[DecimalOrNone]],
) -> dict[str, Any]:
    """
    Segundo fixture: comparación cruzada contra pandas.ewm(span=N, adjust=False).

    pandas solo se usa aquí, nunca en la referencia principal.
    """
    pandas_series = pd.Series(closes, dtype="float64")
    series_payload: dict[str, dict[str, Any]] = {}

    for period in PERIODS:
        ewm = pandas_series.ewm(span=period, adjust=False).mean()
        reference = expected_by_period[period]
        pandas_values: list[float] = []
        max_relative_diff = 0.0
        max_absolute_diff = 0.0

        for index in range(CROSS_CHECK_START_INDEX, len(closes)):
            pandas_value = float(ewm.iloc[index])
            reference_value = reference[index]
            if reference_value is None:
                raise RuntimeError(
                    f"Referencia NaN inesperada en el índice {index} para N={period}"
                )

            reference_float = float(reference_value)
            absolute_diff = abs(reference_float - pandas_value)
            denominator = abs(pandas_value)
            relative_diff = (
                absolute_diff / denominator if denominator != 0 else absolute_diff
            )

            max_relative_diff = max(max_relative_diff, relative_diff)
            max_absolute_diff = max(max_absolute_diff, absolute_diff)
            pandas_values.append(pandas_value)

        if max_relative_diff >= CROSS_CHECK_TOLERANCE:
            raise RuntimeError(
                f"La comprobación cruzada con pandas falló para N={period}: "
                f"diferencia relativa máxima {max_relative_diff:.3e} >= "
                f"{CROSS_CHECK_TOLERANCE:.0e}"
            )

        series_payload[str(period)] = {
            "pandasEwmAdjustFalseFromIndex1000": pandas_values,
            "maxRelativeDiff": max_relative_diff,
            "maxAbsoluteDiff": max_absolute_diff,
        }

    return {
        "description": (
            "Segundo fixture: EMA con semilla SMA vs pandas.ewm(span=N, "
            "adjust=False) desde el índice 1000 del caso (a)"
        ),
        "sourceCase": "case_a_fixed_seed_1500",
        "startIndex": CROSS_CHECK_START_INDEX,
        "tolerance": CROSS_CHECK_TOLERANCE,
        "pandasVersion": pd.__version__,
        "series": series_payload,
    }


def build_fixture() -> dict[str, Any]:
    case_a_closes = generate_case_a_closes()
    case_a_expected_decimal = {
        period: calculate_ema_reference(case_a_closes, period)
        for period in PERIODS
    }
    case_b_closes = generate_case_b_closes()
    case_d_closes = generate_case_d_closes()
    case_e_closes = generate_case_e_closes()

    cases: dict[str, dict[str, Any]] = {
        "case_a_fixed_seed_1500": {
            "description": (
                "1.500 cierres con semilla fija 20260308, periodos 9, 21, 50 y 200"
            ),
            "closes": serialize_closes(case_a_closes),
            "expected": {
                str(period): serialize_series(series)
                for period, series in case_a_expected_decimal.items()
            },
        },
        "case_b_fewer_closes_than_period": {
            "description": (
                "8 cierres: menos que el periodo; toda la serie debe ser NaN"
            ),
            "closes": serialize_closes(case_b_closes),
            "expected": expected_for_periods(case_b_closes, PERIODS),
        },
        "case_d_nan_close_in_middle": {
            "description": (
                "300 cierres con un NaN en el índice 130; el índice 130 y todos "
                "los siguientes deben ser NaN"
            ),
            "closes": serialize_closes(case_d_closes),
            "expected": expected_for_periods(case_d_closes, PERIODS),
        },
        "case_e_constant_price": {
            "description": (
                "300 cierres constantes de 42.5; la EMA debe ser exactamente 42.5"
            ),
            "closes": serialize_closes(case_e_closes),
            "expected": expected_for_periods(case_e_closes, PERIODS),
        },
    }

    cases.update(build_case_c_cases())

    return {
        "metadata": {
            "generator": "tools/gen_ema_fixture.py",
            "command": "python tools/gen_ema_fixture.py",
            "method": (
                "Independent explicit EMA with hand-written SMA seed using "
                "Decimal precision 60 (pandas not used for the primary reference)"
            ),
            "tolerance": 1e-9,
            "seeds": {
                "case_a": 20260308,
                "case_c": 9001,
                "case_d": 4242,
            },
        },
        "cases": cases,
        "pandasCrossCheck": build_pandas_crosscheck(
            case_a_closes, case_a_expected_decimal
        ),
    }


def main() -> None:
    print("Generando fixture EMA con referencia Decimal (precisión 60)...")
    fixture = build_fixture()

    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(FIXTURE_PATH, "w", encoding="utf-8") as file:
        json.dump(fixture, file, indent=2)
        file.write("\n")

    print(f"Fixture generado exitosamente en: {FIXTURE_PATH}")
    print(f"Total casos: {len(fixture['cases'])}")
    for name, case in fixture["cases"].items():
        periods = ", ".join(case["expected"].keys())
        print(
            f"  - {name}: {len(case['closes'])} cierres, periodos [{periods}] "
            f"({case['description']})"
        )

    crosscheck = fixture["pandasCrossCheck"]
    print(
        "Comprobación cruzada pandas.ewm(span=N, adjust=False) desde el índice "
        f"{crosscheck['startIndex']} (límite relativo {crosscheck['tolerance']:.0e}):"
    )
    for period, payload in crosscheck["series"].items():
        print(
            f"  - N={period}: max rel diff = "
            f"{payload['maxRelativeDiff']:.3e}, max abs diff = "
            f"{payload['maxAbsoluteDiff']:.3e}"
        )


if __name__ == "__main__":
    main()
