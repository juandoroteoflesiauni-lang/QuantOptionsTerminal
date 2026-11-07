#!/usr/bin/env python3
"""
tools/gen_welford_fixture.py

Generador de fixtures de referencia para el cálculo de Welford ponderado (AVWAP y bandas).
Implementación INDEPENDIENTE basada estrictamente en la definición matemática en dos pasadas
con aritmética decimal de alta precisión (módulo decimal, precisión 60).

NO implementa ni utiliza la recurrencia incremental de Welford.
Calcula en cada prefijo de barras válidas:
  1) Media ponderada (VWAP):
       mu = sum(P_i * V_i) / sum(V_i)
  2) Varianza poblacional ponderada:
       sigma^2 = sum(V_i * (P_i - mu)^2) / sum(V_i)
  3) Desviación estándar poblacional ponderada:
       sigma = sqrt(sigma^2)

Reglas de filtrado (SPEC punto 1):
  - Si V <= 0, V no es finito o P no es finito: la barra se descarta y el estado no cambia.
  - La primera barra con V > 0 inicializa la estadística.
  - Mientras el volumen acumulado sea 0: la salida indica sin dato (vwap = NaN, variance = NaN, stdDev = NaN, cumVolume = 0).

Para regenerar el fixture:
  python tools/gen_welford_fixture.py
"""

from __future__ import annotations

import json
import math
import random
from decimal import Decimal, getcontext
from pathlib import Path
from typing import Any

# Fijamos alta precisión para garantizar referencia exacta frente a float64
getcontext().prec = 60


def is_valid_bar(price: float, volume: float) -> bool:
    """Verifica las reglas del SPEC para aceptar una barra."""
    if not math.isfinite(price):
        return False
    if not math.isfinite(volume) or volume <= 0:
        return False
    return True


def serialize_value(val: Any) -> Any:
    """Serializa números especiales a formato compatible con JSON."""
    if val is None:
        return None
    if isinstance(val, (float, int)):
        if math.isnan(val):
            return "NaN"
        if math.isinf(val):
            return "Infinity" if val > 0 else "-Infinity"
        return float(val)
    if isinstance(val, Decimal):
        f = float(val)
        if math.isnan(f):
            return "NaN"
        if math.isinf(f):
            return "Infinity" if f > 0 else "-Infinity"
        return f
    return val


def compute_two_pass_reference(
    prices: list[float], volumes: list[float]
) -> list[dict[str, Any]]:
    """Calcula la serie esperada prefijo a prefijo usando la definición en 2 pasadas."""
    expected_series: list[dict[str, Any]] = []
    valid_p: list[Decimal] = []
    valid_v: list[Decimal] = []

    sum_pv = Decimal(0)
    sum_v = Decimal(0)

    last_output: dict[str, Any] = {
        "vwap": None,
        "variance": None,
        "stdDev": None,
        "cumVolume": 0.0,
    }

    for p, v in zip(prices, volumes):
        if not is_valid_bar(p, v):
            # Estado no cambia: emite el último estado
            expected_series.append(dict(last_output))
            continue

        p_dec = Decimal(str(p))
        v_dec = Decimal(str(v))
        valid_p.append(p_dec)
        valid_v.append(v_dec)

        # Pasada 1: media ponderada
        sum_pv += p_dec * v_dec
        sum_v += v_dec
        mean = sum_pv / sum_v

        # Pasada 2: varianza poblacional ponderada por definición
        sum_sq_diff = Decimal(0)
        for pi, vi in zip(valid_p, valid_v):
            diff = pi - mean
            sum_sq_diff += vi * (diff * diff)

        variance = sum_sq_diff / sum_v
        std_dev = variance.sqrt()

        last_output = {
            "vwap": serialize_value(mean),
            "variance": serialize_value(variance),
            "stdDev": serialize_value(std_dev),
            "cumVolume": serialize_value(sum_v),
        }
        expected_series.append(dict(last_output))

    return expected_series


def generate_case_a() -> dict[str, Any]:
    """(a) 5.000 barras con precios ~60.000 y volúmenes grandes (semilla fija)."""
    random.seed(1337)
    n = 5000
    base_price = 60000.0
    prices: list[float] = []
    volumes: list[float] = []

    current_price = base_price
    for _ in range(n):
        step = random.uniform(-40.0, 40.0)
        current_price += step
        current_price = round(max(10000.0, current_price), 2)
        vol = round(random.uniform(500.0, 5000.0), 2)
        prices.append(current_price)
        volumes.append(vol)

    expected = compute_two_pass_reference(prices, volumes)
    return {
        "description": "5.000 barras con precios ~60.000 y volúmenes grandes (semilla fija)",
        "prices": [serialize_value(p) for p in prices],
        "volumes": [serialize_value(v) for v in volumes],
        "expected": expected,
    }


def generate_case_b() -> dict[str, Any]:
    """(b) precios ~100 con volúmenes pequeños."""
    random.seed(4242)
    n = 200
    base_price = 100.0
    prices: list[float] = []
    volumes: list[float] = []

    current_price = base_price
    for _ in range(n):
        step = random.uniform(-1.0, 1.0)
        current_price += step
        current_price = round(max(1.0, current_price), 4)
        vol = round(random.uniform(0.01, 5.0), 4)
        prices.append(current_price)
        volumes.append(vol)

    expected = compute_two_pass_reference(prices, volumes)
    return {
        "description": "precios ~100 con volúmenes pequeños",
        "prices": [serialize_value(p) for p in prices],
        "volumes": [serialize_value(v) for v in volumes],
        "expected": expected,
    }


def generate_case_c() -> dict[str, Any]:
    """(c) la primera barra con volumen 0."""
    prices = [150.0, 152.0, 148.0, 155.0, 151.0]
    volumes = [0.0, 10.0, 15.0, 25.0, 30.0]

    expected = compute_two_pass_reference(prices, volumes)
    return {
        "description": "la primera barra con volumen 0",
        "prices": [serialize_value(p) for p in prices],
        "volumes": [serialize_value(v) for v in volumes],
        "expected": expected,
    }


def generate_case_d() -> dict[str, Any]:
    """(d) barras intercaladas con volumen 0, negativo, NaN e Infinity (que deben ignorarse)."""
    prices = [200.0, 202.0, 205.0, 210.0, 208.0, 207.0, 215.0, 203.0, 204.0, 206.0]
    volumes = [
        10.0,
        0.0,                    # volumen 0
        20.0,
        -5.0,                   # volumen negativo
        float("nan"),           # volumen NaN
        15.0,
        float("inf"),           # volumen +Infinity
        30.0,
        float("-inf"),          # volumen -Infinity
        25.0,
    ]

    expected = compute_two_pass_reference(prices, volumes)
    return {
        "description": "barras intercaladas con volumen 0, negativo, NaN e Infinity (que deben ignorarse)",
        "prices": [serialize_value(p) for p in prices],
        "volumes": [serialize_value(v) for v in volumes],
        "expected": expected,
    }


def generate_case_e() -> dict[str, Any]:
    """(e) precio NaN en medio."""
    prices = [
        300.0,
        305.0,
        float("nan"),           # precio NaN
        310.0,
        float("inf"),           # precio +Infinity
        312.0,
    ]
    volumes = [10.0, 15.0, 20.0, 25.0, 10.0, 12.0]

    expected = compute_two_pass_reference(prices, volumes)
    return {
        "description": "precio NaN en medio",
        "prices": [serialize_value(p) for p in prices],
        "volumes": [serialize_value(v) for v in volumes],
        "expected": expected,
    }


def main() -> None:
    print("Generando casos de referencia independientes...")
    fixture_data = {
        "metadata": {
            "generator": "tools/gen_welford_fixture.py",
            "command": "python tools/gen_welford_fixture.py",
            "method": "Independent two-pass decimal precision calculation (not Welford recurrence)",
            "tolerance": 1e-9,
        },
        "cases": {
            "case_a_large_prices_large_volumes": generate_case_a(),
            "case_b_small_prices_small_volumes": generate_case_b(),
            "case_c_first_bar_zero_volume": generate_case_c(),
            "case_d_interleaved_invalid_volumes": generate_case_d(),
            "case_e_nan_price_in_middle": generate_case_e(),
        },
    }

    output_path = Path(__file__).resolve().parent.parent / "fixtures" / "welford_reference.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(fixture_data, f, indent=2)

    print(f"Fixture generado exitosamente en: {output_path}")
    print(f"Total casos: {len(fixture_data['cases'])}")
    for name, c in fixture_data["cases"].items():
        print(f"  - {name}: {len(c['prices'])} barras ({c['description']})")


if __name__ == "__main__":
    main()
