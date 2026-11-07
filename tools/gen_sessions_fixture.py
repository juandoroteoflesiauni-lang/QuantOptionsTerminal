#!/usr/bin/env python3
"""
tools/gen_sessions_fixture.py

Generador de fixtures de referencia para el gestor de sesiones (SPEC punto 3).

REFERENCIA INDEPENDIENTE:
  - Usa zoneinfo (America/New_York), datetime y timezone.UTC.
  - No replica la lógica de TypeScript ni usa Intl.
  - Cada caso parte del instante UTC exacto (segundos enteros).

Casos explícitos:
  - Cambio a horario de verano: segundo domingo de marzo de 2025 y 2026.
  - Vuelta al horario estándar: primer domingo de noviembre de 2025 y 2026.
  - 09:29:59, 09:30:00, 15:59:59 y 16:00:00 ET en invierno y en verano.
  - 20:00 ET del último día de un mes y del 31 de diciembre (el instante UTC
    cae en el día siguiente; las claves locales de acciones no deben cambiar).
  - Lunes feriado (MLK 2025): la semana se identifica igual.
  - Sábado y domingo.
  - Medianoche UTC en cripto y cambio de año UTC.
  - Instante en milisegundos: debe lanzar error.

BARRIDO:
  - Del 2025-01-01T00:00:00Z al 2026-12-31T23:55:00Z, cada 5 minutos.
  - Rejilla completa: 210.240 instantes.
  - Muestra determinista de 5.000 puntos equiespaciados (incluye primero y último).
  - Se comparan dateKey, weekKey, monthKey, yearKey e isRth para EQUITY.

Semillas/fechas fijas: no hay aleatoriedad; todos los instantes son explícitos.

Para regenerar el fixture:
  python tools/gen_sessions_fixture.py

Si zoneinfo no encuentra la base IANA en Windows, instala tzdata con:
  python -m pip install tzdata
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
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
FIXTURE_PATH = (
    Path(__file__).resolve().parent.parent / "fixtures" / "sessions_reference.json"
)

# En Windows la consola puede usar una code page distinta de UTF-8; forzamos
# UTF-8 en stdout para que los mensajes con acentos se impriman correctamente.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

SWEEP_START = datetime(2025, 1, 1, 0, 0, 0, tzinfo=UTC)
SWEEP_END_EXCLUSIVE = datetime(2027, 1, 1, 0, 0, 0, tzinfo=UTC)
SWEEP_STEP_SECONDS = 300
SWEEP_SAMPLE_COUNT = 5000


def utc_seconds(
    year: int,
    month: int,
    day: int,
    hour: int = 0,
    minute: int = 0,
    second: int = 0,
) -> int:
    """Instante UTC exacto expresado en segundos enteros."""
    return int(
        datetime(
            year, month, day, hour, minute, second, tzinfo=UTC
        ).timestamp()
    )


def et_seconds(
    year: int,
    month: int,
    day: int,
    hour: int,
    minute: int,
    second: int,
) -> int:
    """Hora civil de America/New_York convertida al instante UTC exacto."""
    return int(
        datetime(
            year, month, day, hour, minute, second, tzinfo=NEW_YORK
        ).timestamp()
    )


def date_key(value: datetime) -> str:
    return f"{value.year:04d}-{value.month:02d}-{value.day:02d}"


def market_values(time: int, market: str) -> dict[str, Any]:
    """
    Calcula las partes y claves esperadas para un instante UTC.

    Independiente de TypeScript: datetime + zoneinfo hacen la conversión.
    """
    if market == "EQUITY":
        local = datetime.fromtimestamp(time, tz=NEW_YORK)
        is_rth: bool | None = (
            local.isoweekday() <= 5
            and 9 * 60 + 30 <= local.hour * 60 + local.minute < 16 * 60
        )
    elif market == "CRYPTO":
        local = datetime.fromtimestamp(time, tz=UTC)
        is_rth = None
    else:
        raise ValueError(f"Mercado no soportado: {market}")

    minutes_of_day = local.hour * 60 + local.minute
    monday = local.date() - timedelta(days=local.isoweekday() - 1)

    parts = {
        "year": local.year,
        "month": local.month,
        "day": local.day,
        "hour": local.hour,
        "minute": local.minute,
        "weekday": local.isoweekday(),
        "dateKey": date_key(local),
        "minutesOfDay": minutes_of_day,
    }

    return {
        "parts": parts,
        "sessionKey": parts["dateKey"],
        "weekKey": date_key(
            datetime(monday.year, monday.month, monday.day)
        ),
        "monthKey": local.year * 12 + local.month,
        "yearKey": local.year,
        "isRth": is_rth,
    }


def add_case(
    cases: dict[str, dict[str, Any]],
    name: str,
    description: str,
    time: int,
    market: str,
    expect_error: bool = False,
) -> None:
    case: dict[str, Any] = {
        "description": description,
        "time": time,
        "market": market,
    }
    if expect_error:
        case["expectError"] = True
    else:
        case["expected"] = market_values(time, market)
    cases[name] = case


def build_cases() -> dict[str, dict[str, Any]]:
    cases: dict[str, dict[str, Any]] = {}

    # Cambio a horario de verano (segundo domingo de marzo).
    add_case(
        cases,
        "dst_spring_forward_2025_before",
        "2025-03-09 01:59:59 EST, justo antes del salto a EDT",
        utc_seconds(2025, 3, 9, 6, 59, 59),
        "EQUITY",
    )
    add_case(
        cases,
        "dst_spring_forward_2025_after",
        "2025-03-09 03:00:00 EDT, justo después del salto de DST",
        utc_seconds(2025, 3, 9, 7, 0, 0),
        "EQUITY",
    )
    add_case(
        cases,
        "dst_spring_forward_2025_monday_open",
        "2025-03-10 09:30:00 EDT, apertura del lunes posterior al DST",
        et_seconds(2025, 3, 10, 9, 30, 0),
        "EQUITY",
    )
    add_case(
        cases,
        "dst_spring_forward_2026_before",
        "2026-03-08 01:59:59 EST, justo antes del salto a EDT",
        utc_seconds(2026, 3, 8, 6, 59, 59),
        "EQUITY",
    )
    add_case(
        cases,
        "dst_spring_forward_2026_after",
        "2026-03-08 03:00:00 EDT, justo después del salto de DST",
        utc_seconds(2026, 3, 8, 7, 0, 0),
        "EQUITY",
    )

    # Vuelta al horario estándar (primer domingo de noviembre).
    add_case(
        cases,
        "dst_fall_back_2025_before",
        "2025-11-02 01:59:59 EDT, justo antes de volver a EST",
        utc_seconds(2025, 11, 2, 5, 59, 59),
        "EQUITY",
    )
    add_case(
        cases,
        "dst_fall_back_2025_after",
        "2025-11-02 01:00:00 EST, hora repetida tras volver a EST",
        utc_seconds(2025, 11, 2, 6, 0, 0),
        "EQUITY",
    )
    add_case(
        cases,
        "dst_fall_back_2025_repeated_hour",
        "2025-11-02 01:30:00 EST, segunda pasada de la hora repetida",
        utc_seconds(2025, 11, 2, 6, 30, 0),
        "EQUITY",
    )
    add_case(
        cases,
        "dst_fall_back_2026_before",
        "2026-11-01 01:59:59 EDT, justo antes de volver a EST",
        utc_seconds(2026, 11, 1, 5, 59, 59),
        "EQUITY",
    )
    add_case(
        cases,
        "dst_fall_back_2026_after",
        "2026-11-01 01:00:00 EST, hora repetida tras volver a EST",
        utc_seconds(2026, 11, 1, 6, 0, 0),
        "EQUITY",
    )

    # Fronteras RTH en invierno (2025-01-15, miércoles, EST).
    add_case(
        cases,
        "rth_winter_092959",
        "2025-01-15 09:29:59 ET, invierno: fuera de RTH",
        et_seconds(2025, 1, 15, 9, 29, 59),
        "EQUITY",
    )
    add_case(
        cases,
        "rth_winter_093000",
        "2025-01-15 09:30:00 ET, invierno: primer segundo de RTH",
        et_seconds(2025, 1, 15, 9, 30, 0),
        "EQUITY",
    )
    add_case(
        cases,
        "rth_winter_155959",
        "2025-01-15 15:59:59 ET, invierno: último segundo de RTH",
        et_seconds(2025, 1, 15, 15, 59, 59),
        "EQUITY",
    )
    add_case(
        cases,
        "rth_winter_160000",
        "2025-01-15 16:00:00 ET, invierno: fuera de RTH",
        et_seconds(2025, 1, 15, 16, 0, 0),
        "EQUITY",
    )

    # Fronteras RTH en verano (2025-07-15, martes, EDT).
    add_case(
        cases,
        "rth_summer_092959",
        "2025-07-15 09:29:59 ET, verano: fuera de RTH",
        et_seconds(2025, 7, 15, 9, 29, 59),
        "EQUITY",
    )
    add_case(
        cases,
        "rth_summer_093000",
        "2025-07-15 09:30:00 ET, verano: primer segundo de RTH",
        et_seconds(2025, 7, 15, 9, 30, 0),
        "EQUITY",
    )
    add_case(
        cases,
        "rth_summer_155959",
        "2025-07-15 15:59:59 ET, verano: último segundo de RTH",
        et_seconds(2025, 7, 15, 15, 59, 59),
        "EQUITY",
    )
    add_case(
        cases,
        "rth_summer_160000",
        "2025-07-15 16:00:00 ET, verano: fuera de RTH",
        et_seconds(2025, 7, 15, 16, 0, 0),
        "EQUITY",
    )

    # 20:00 ET en cierres de mes y año: el instante UTC cae al día siguiente.
    add_case(
        cases,
        "month_end_2000_et_january",
        "2025-01-31 20:00 ET: en UTC ya es 2025-02-01; mes local no cambia",
        et_seconds(2025, 1, 31, 20, 0, 0),
        "EQUITY",
    )
    add_case(
        cases,
        "year_end_2000_et_december",
        "2025-12-31 20:00 ET: en UTC ya es 2026-01-01; año local no cambia",
        et_seconds(2025, 12, 31, 20, 0, 0),
        "EQUITY",
    )

    # Lunes feriado: la semana se identifica igual y isRth no modela feriados.
    add_case(
        cases,
        "monday_holiday_mlk_2025",
        "2025-01-20 12:00 ET, lunes feriado MLK: semana = 2025-01-20",
        et_seconds(2025, 1, 20, 12, 0, 0),
        "EQUITY",
    )

    # Fin de semana.
    add_case(
        cases,
        "saturday_2025_01_18",
        "2025-01-18 12:00 ET, sábado: fuera de RTH",
        et_seconds(2025, 1, 18, 12, 0, 0),
        "EQUITY",
    )
    add_case(
        cases,
        "sunday_2025_01_19",
        "2025-01-19 12:00 ET, domingo: fuera de RTH",
        et_seconds(2025, 1, 19, 12, 0, 0),
        "EQUITY",
    )

    # Cripto: medianoche UTC y cambio de año UTC.
    add_case(
        cases,
        "crypto_midnight_utc_2025",
        "2025-01-01 00:00:00 UTC, medianoche exacta en cripto",
        utc_seconds(2025, 1, 1, 0, 0, 0),
        "CRYPTO",
    )
    add_case(
        cases,
        "crypto_year_boundary_2024_12_31",
        "2024-12-31 23:59:59 UTC, último segundo del año en cripto",
        utc_seconds(2024, 12, 31, 23, 59, 59),
        "CRYPTO",
    )

    # Entrada en milisegundos: debe lanzar error, no normalizarse.
    add_case(
        cases,
        "milliseconds_must_throw",
        "Instante en milisegundos (2025-03-09 07:00:00 UTC * 1000): debe fallar",
        utc_seconds(2025, 3, 9, 7, 0, 0) * 1000,
        "EQUITY",
        expect_error=True,
    )

    return cases


def build_sweep() -> dict[str, Any]:
    """Muestra determinista del barrido de 5 minutos entre 2025 y 2026."""
    total_seconds = int((SWEEP_END_EXCLUSIVE - SWEEP_START).total_seconds())
    total_grid_points = total_seconds // SWEEP_STEP_SECONDS

    indices = [
        (index * (total_grid_points - 1)) // (SWEEP_SAMPLE_COUNT - 1)
        for index in range(SWEEP_SAMPLE_COUNT)
    ]
    if len(set(indices)) != SWEEP_SAMPLE_COUNT:
        raise RuntimeError("La muestra del barrido contiene índices duplicados")

    start_seconds = int(SWEEP_START.timestamp())
    points: list[dict[str, Any]] = []
    for grid_index in indices:
        time = start_seconds + grid_index * SWEEP_STEP_SECONDS
        values = market_values(time, "EQUITY")
        points.append(
            {
                "time": time,
                "dateKey": values["sessionKey"],
                "weekKey": values["weekKey"],
                "monthKey": values["monthKey"],
                "yearKey": values["yearKey"],
                "isRth": values["isRth"],
            }
        )

    end_last = start_seconds + (total_grid_points - 1) * SWEEP_STEP_SECONDS

    return {
        "startUtc": "2025-01-01T00:00:00Z",
        "endUtc": datetime.fromtimestamp(end_last, tz=UTC)
        .isoformat()
        .replace("+00:00", "Z"),
        "stepSeconds": SWEEP_STEP_SECONDS,
        "totalGridPoints": total_grid_points,
        "sampledPoints": SWEEP_SAMPLE_COUNT,
        "sampling": (
            "Índices equiespaciados sobre la rejilla completa, incluyendo el "
            "primero y el último"
        ),
        "points": points,
    }


def build_fixture() -> dict[str, Any]:
    return {
        "metadata": {
            "generator": "tools/gen_sessions_fixture.py",
            "command": "python tools/gen_sessions_fixture.py",
            "method": (
                "Independent zoneinfo America/New_York + datetime UTC reference "
                "(no TypeScript logic, no Intl)"
            ),
            "tolerance": "exact",
            "timeZoneEquity": "America/New_York",
            "timeZoneCrypto": "UTC",
        },
        "cases": build_cases(),
        "sweep": build_sweep(),
    }


def main() -> None:
    print("Generando fixture de sesiones con zoneinfo (America/New_York)...")
    fixture = build_fixture()

    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(FIXTURE_PATH, "w", encoding="utf-8") as file:
        json.dump(fixture, file, indent=2)
        file.write("\n")

    print(f"Fixture generado exitosamente en: {FIXTURE_PATH}")
    print(f"Total casos explícitos: {len(fixture['cases'])}")
    for name, case in fixture["cases"].items():
        if case.get("expectError"):
            print(f"  - {name}: debe lanzar error ({case['description']})")
        else:
            expected = case["expected"]
            print(
                f"  - {name}: {expected['sessionKey']} / "
                f"week={expected['weekKey']} / month={expected['monthKey']} / "
                f"isRth={expected['isRth']}"
            )

    sweep = fixture["sweep"]
    print(
        f"Barrido: {sweep['sampledPoints']} puntos de "
        f"{sweep['totalGridPoints']} ({sweep['startUtc']} a {sweep['endUtc']}, "
        f"paso {sweep['stepSeconds']} s)"
    )


if __name__ == "__main__":
    main()
