#!/usr/bin/env python3
"""Referencia independiente Pieza 50.7 Bloque A — AVWAP de ancla única.

Implementacion explicita en Python puro (Decimal prec 60, math, json) sin
copiar la logica TypeScript:

  - Precio = HLC3 = (high + low + close) / 3 (SPEC punto 5). `vw` NUNCA
    participa; se incluye en las barras solo para probar que se ignora.
  - Peso = volumen. Una barra contribuye solo si HLC3 es finito y el volumen es
    finito y > 0; el resto no cambia el estado.
  - Cada punto se recalcula por definicion con sumas explicitas en dos pasadas
    sobre las barras contribuyentes desde el ancla hasta el prefijo:
        mu    = sum(P_i * V_i) / sum(V_i)
        sigma = sqrt( sum(V_i * (P_i - mu)^2) / sum(V_i) )
    y bandas mu ± k*sigma con el mismo sigma (k = 1, 2).
  - Antes de que el volumen acumulado sea > 0 no se emite punto (hueco).
    Despues, toda barra emite un punto; una barra ignorada repite el ultimo
    estado.
  - Se incluye `legacyVwCenter` (precio `vw` con fallback HLC3, como el camino
    anterior de la vista) solo en el escenario `vw_distinto_hlc3` para
    documentar el cambio numerico intencional.

Genera fixtures/avwap_pieza50_7_reference.json (tolerancia 1e-9).
NaN/±Infinity se serializan como cadenas.
"""
from __future__ import annotations

import json
import math
import os
from decimal import Decimal, getcontext

getcontext().prec = 60

OUT = os.path.join(
    os.path.dirname(__file__), "..", "fixtures", "avwap_pieza50_7_reference.json"
)


def parse(value):
    """Convierte el escalar del fixture a Decimal o None (no finito/ausente)."""
    if value is None:
        return None
    if isinstance(value, str):
        return None  # "NaN" / "Infinity" / "-Infinity"
    if isinstance(value, bool):
        return None
    return Decimal(str(value))


def encode(value):
    if value is None:
        return "NaN"
    as_float = float(value)
    if math.isnan(as_float):
        return "NaN"
    if math.isinf(as_float):
        return "Infinity" if as_float > 0 else "-Infinity"
    return as_float


def prefix_points(bars, anchor_index, price_of):
    """Puntos por prefijo desde `anchor_index` con sumas explicitas en dos pasadas."""
    points = [None] * len(bars)
    contributors = []
    sum_v = Decimal(0)
    sum_pv = Decimal(0)
    for index in range(anchor_index, len(bars)):
        bar = bars[index]
        price = price_of(bar)
        volume = parse(bar[5])
        if price is not None and volume is not None and volume > 0:
            contributors.append((price, volume))
            sum_v += volume
            sum_pv += price * volume
        if sum_v > 0:
            mu = sum_pv / sum_v
            m2 = sum(volume * (price - mu) ** 2 for price, volume in contributors)
            if m2 < 0:
                m2 = Decimal(0)
            sigma = (m2 / sum_v).sqrt()
            points[index] = (mu, sigma)
    return points


def hlc3_of(bar):
    high = parse(bar[2])
    low = parse(bar[3])
    close = parse(bar[4])
    if high is None or low is None or close is None:
        return None
    return (high + low + close) / 3


def legacy_price_of(bar):
    vw = parse(bar[6]) if len(bar) > 6 else None
    if vw is not None and vw > 0:
        return vw
    return hlc3_of(bar)


def build_case(name, notes, bars, anchor_index, include_legacy_vw=False):
    n = len(bars)
    expected = {
        "vwap": ["NaN"] * n,
        "upper1": ["NaN"] * n,
        "lower1": ["NaN"] * n,
        "upper2": ["NaN"] * n,
        "lower2": ["NaN"] * n,
    }
    anchor_time = None
    anchor_found = -1
    if 0 <= anchor_index < n:
        points = prefix_points(bars, anchor_index, hlc3_of)
        for index, point in enumerate(points):
            if point is None:
                continue
            mu, sigma = point
            if anchor_found < 0:
                anchor_found = index
                anchor_time = bars[index][0]
            expected["vwap"][index] = encode(mu)
            expected["upper1"][index] = encode(mu + sigma)
            expected["lower1"][index] = encode(mu - sigma)
            expected["upper2"][index] = encode(mu + 2 * sigma)
            expected["lower2"][index] = encode(mu - 2 * sigma)

    case = {
        "name": name,
        "notes": notes,
        "anchorIndex": anchor_index,
        "bars": bars,
        "expected": {
            **expected,
            "anchorTimeSec": anchor_time,
            "anchorIndex": anchor_found,
        },
    }
    if include_legacy_vw:
        legacy = prefix_points(bars, anchor_index, legacy_price_of)
        case["expected"]["legacyVwCenter"] = [
            "NaN" if point is None else encode(point[0]) for point in legacy
        ]
    return case


def build_cases():
    return [
        build_case(
            "vw_distinto_hlc3",
            "Todos los volumenes validos; vw = HLC3 + 30 en todas las barras.",
            [
                [1000, 100, 102, 98, 100, 1000, 130],
                [1600, 101, 103, 99, 101, 2000, 131],
                [2200, 102, 104, 100, 102, 1500, 132],
                [2800, 103, 105, 101, 103, 3000, 133],
            ],
            0,
            include_legacy_vw=True,
        ),
        build_case(
            "pesos_desiguales",
            "Volumenes muy desiguales (1, 50, 3, 0.5, 900).",
            [
                [1000, 95, 101, 94, 100, 1, None],
                [1600, 101, 112, 100, 110, 50, None],
                [2200, 110, 113, 102, 103, 3, None],
                [2800, 102, 104, 99, 100, 0.5, None],
                [3400, 100, 130, 99, 128, 900, None],
            ],
            0,
        ),
        build_case(
            "volumen_cero_inicio",
            "Dos barras iniciales con volumen 0 y otra despues del primer punto.",
            [
                [1000, 100, 102, 98, 100, 0, None],
                [1600, 100, 103, 98, 101, 0, None],
                [2200, 101, 104, 99, 102, 10, None],
                [2800, 102, 105, 100, 103, 20, None],
                [3400, 103, 106, 101, 104, 0, None],
                [4000, 104, 107, 102, 105, 5, None],
            ],
            0,
        ),
        build_case(
            "volumen_no_finito_inicio_y_medio",
            "Volumen NaN al inicio y en medio; Infinity despues del primer punto.",
            [
                [1000, 100, 102, 98, 100, "NaN", None],
                [1600, 101, 103, 99, 101, 10, None],
                [2200, 102, 104, 100, 102, "NaN", None],
                [2800, 103, 105, 101, 103, 20, None],
                [3400, 104, 106, 102, 104, "Infinity", None],
                [4000, 105, 107, 103, 105, 30, None],
            ],
            0,
        ),
        build_case(
            "hlc_invalido_vw_valido",
            "HLC invalido en las barras 0 y 2 con vw valido: HLC3 manda y se ignoran.",
            [
                [1000, 100, "NaN", 98, 100, 50, 999],
                [1600, 101, 103, 99, 101, 10, "NaN"],
                [2200, 102, 104, "NaN", 102, 60, 888],
                [2800, 103, 105, 101, 103, 20, None],
            ],
            0,
        ),
        build_case(
            "indice_ancla_invalido",
            "Indice negativo: sin puntos, mascara completa NaN.",
            [
                [1000, 100, 102, 98, 100, 10, None],
                [1600, 101, 103, 99, 101, 20, None],
                [2200, 102, 104, 100, 102, 30, None],
            ],
            -1,
        ),
        build_case(
            "indice_ancla_fuera_rango",
            "Indice igual al largo: sin puntos, mascara completa NaN.",
            [
                [1000, 100, 102, 98, 100, 10, None],
                [1600, 101, 103, 99, 101, 20, None],
                [2200, 102, 104, 100, 102, 30, None],
            ],
            3,
        ),
    ]


def main():
    fixture = {
        "meta": {
            "generator": "tools/gen_avwap_pieza50_7_reference.py",
            "tolerance": 1e-9,
            "price": "HLC3 = (high + low + close) / 3",
            "weights": "volume; contribuye solo si HLC3 finito y volumen finito > 0",
        },
        "scenarios": build_cases(),
    }
    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump(fixture, handle, indent=1)
        handle.write("\n")
    print(f"OK -> {os.path.relpath(OUT)} ({len(fixture['scenarios'])} escenarios)")


if __name__ == "__main__":
    main()
