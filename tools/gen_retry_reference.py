#!/usr/bin/env python3
"""
tools/gen_retry_reference.py

Referencia INDEPENDIENTE para el ritmo y reintento de peticiones del
cargador (pieza del 2026-11-13). Genera fixtures/retry_reference.json.

Reglas explicitas, escritas desde los requisitos (sin leer el TypeScript):

  parse_retry_after(value, now_ms) -> segundos | None
    - value None o no str: None
    - vacio tras recortar espacios: None
    - numero decimal con signo opcional (regex ^-?\\d+(\\.\\d+)?$):
      segundos si > 0, si no None
    - fecha HTTP interpretable (RFC 7231): ceil((t_ms - now_ms) / 1000)
      si la espera es positiva, si no None
    - cualquier otra cosa: None

  retry_delay_ms(attempt, retry_after_seconds, base_delay_ms, max_delay_ms)
    - retry_after_seconds valido (no None, finito, > 0) manda:
      raw = retry_after_seconds * 1000
    - si no: backoff exponencial raw = base_delay_ms * 2**attempt
    - resultado = min(raw, max_delay_ms)

La espera real la ejecuta el sleep del cargador; aqui solo hay la
matematica que decide cuanta. Uso:
  python tools/gen_retry_reference.py
"""
from __future__ import annotations

import json
import math
import re
from email.utils import parsedate_to_datetime
from pathlib import Path

FIXTURE = Path("fixtures") / "retry_reference.json"
NUMBER_RE = re.compile(r"^-?\d+(\.\d+)?$")


def parse_retry_after(value: object, now_ms: int) -> float | None:
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    if trimmed == "":
        return None
    if NUMBER_RE.match(trimmed):
        seconds = float(trimmed)
        return seconds if (math.isfinite(seconds) and seconds > 0) else None
    try:
        when = parsedate_to_datetime(trimmed)
    except (TypeError, ValueError):
        return None
    if when.tzinfo is None:
        return None
    when_ms = when.timestamp() * 1000.0
    seconds = (when_ms - float(now_ms)) / 1000.0
    return math.ceil(seconds) if seconds > 0 else None


def retry_delay_ms(
    attempt: int,
    retry_after_seconds: float | None,
    base_delay_ms: int,
    max_delay_ms: int,
) -> float:
    valid = (
        retry_after_seconds is not None
        and math.isfinite(retry_after_seconds)
        and retry_after_seconds > 0
    )
    raw = retry_after_seconds * 1000.0 if valid else float(base_delay_ms) * (2**attempt)
    return min(raw, float(max_delay_ms))


def parse_cases() -> list[dict[str, object]]:
    # now_ms fijo: 2015-10-19T07:28:00Z, el MISMO instante de la fecha pasada.
    # La fecha futura es 2015-10-21T07:28:00Z (+2 dias exactos).
    now_ms = 1_445_243_280_000
    future = "Wed, 21 Oct 2015 07:28:00 GMT"
    past = "Mon, 19 Oct 2015 07:28:00 GMT"
    raw: list[tuple[str, object]] = [
        ("p01_segundos_enteros", "120"),
        ("p02_espacios", " 45 "),
        ("p03_cero", "0"),
        ("p04_negativo", "-3"),
        ("p05_decimal", "1.5"),
        ("p06_basura", "abc"),
        ("p07_vacio", ""),
        ("p08_ausente", None),
        ("p09_fecha_futura", future),
        ("p10_fecha_pasada", past),
        ("p11_fecha_igual_al_reloj", past),
        ("p12_segundos_fraccionarios", "0.25"),
    ]
    cases: list[dict[str, object]] = []
    for case_id, value in raw:
        expected = parse_retry_after(value, now_ms)
        cases.append(
            {"id": case_id, "value": value, "now_ms": now_ms, "expected": expected}
        )
    # Comprobacion interna: la referencia no debe producir sorpresas.
    assert cases[0]["expected"] == 120.0, cases[0]
    assert cases[2]["expected"] is None, cases[2]
    assert cases[3]["expected"] is None, cases[3]
    assert cases[7]["expected"] is None, cases[7]
    assert cases[8]["expected"] == 169_200.0, cases[8]
    assert cases[9]["expected"] is None, cases[9]
    assert cases[10]["expected"] is None, cases[10]
    return cases


def delay_cases() -> list[dict[str, object]]:
    raw: list[tuple[str, int, float | None, int, int]] = [
        ("d01_intento0_sin_ra", 0, None, 1_000, 30_000),
        ("d02_intento1", 1, None, 1_000, 30_000),
        ("d03_intento2", 2, None, 1_000, 30_000),
        ("d04_intento3", 3, None, 1_000, 30_000),
        ("d05_intento4", 4, None, 1_000, 30_000),
        ("d06_intento5_cap", 5, None, 1_000, 30_000),
        ("d07_intento6_cap", 6, None, 1_000, 30_000),
        ("d08_ra7", 0, 7.0, 1_000, 30_000),
        ("d09_ra120_cap", 0, 120.0, 1_000, 30_000),
        ("d10_ra_medio", 3, 0.5, 1_000, 30_000),
        ("d11_ra_cero", 0, 0.0, 1_000, 30_000),
        ("d12_ra_negativo", 0, -2.0, 1_000, 30_000),
        ("d13_base500_cap1000", 3, None, 500, 1_000),
        ("d14_base_cero", 2, None, 0, 30_000),
        ("d15_max_cero", 2, None, 1_000, 0),
        ("d16_ra_gana_al_backoff", 4, 2.0, 1_000, 30_000),
    ]
    cases: list[dict[str, object]] = []
    for case_id, attempt, retry_after, base, max_delay in raw:
        expected = retry_delay_ms(attempt, retry_after, base, max_delay)
        cases.append(
            {
                "id": case_id,
                "attempt": attempt,
                "retry_after_seconds": retry_after,
                "base_delay_ms": base,
                "max_delay_ms": max_delay,
                "expected": expected,
            }
        )
    assert cases[5]["expected"] == 30_000.0, cases[5]  # 32000 -> cap 30000
    assert cases[8]["expected"] == 30_000.0, cases[8]  # 120000 -> cap 30000
    assert cases[10]["expected"] == 1_000.0, cases[10]  # RA 0 -> backoff
    assert cases[14]["expected"] == 0.0, cases[14]  # max 0 -> 0
    assert cases[15]["expected"] == 2_000.0, cases[15]  # RA manda al backoff
    return cases


def main() -> int:
    fixture = {
        "description": (
            "Referencia independiente del ritmo y reintento del cargador: "
            "parseRetryAfterSeconds y retryDelayMs (pieza del 2026-11-13). "
            "Generado por tools/gen_retry_reference.py."
        ),
        "parse_cases": parse_cases(),
        "delay_cases": delay_cases(),
    }
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(
        json.dumps(fixture, indent=2, ensure_ascii=True) + "\n", encoding="utf-8"
    )
    print(
        "escrito", FIXTURE.as_posix(),
        "parse_cases", len(fixture["parse_cases"]),  # type: ignore[arg-type]
        "delay_cases", len(fixture["delay_cases"]),  # type: ignore[arg-type]
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
