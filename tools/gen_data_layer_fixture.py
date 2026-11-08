#!/usr/bin/env python3
"""
tools/gen_data_layer_fixture.py

Generador de referencia INDEPENDIENTE para la capa de datos (SPEC punto 6).

Método:
  - Implementación explícita en Python, escrita a partir de los requisitos.
  - No importa ni traduce el código TypeScript.
  - Convierte milisegundos a segundos SOLO en esta capa.
  - Valida cada fila con un orden de causas documentado:
        malformedRow -> invalidTime -> nonFinite -> invalidPrice
        -> highBelowLow -> invalidVolume -> duplicate
  - No rellena huecos: solo los detecta y reporta.
  - BingX: calcula quoteVolume/volume como candidato a VWAP, pero NUNCA lo
    expone en las barras. La muestra real falló la verificación del SPEC:
    185 de 3.445 barras de 1m quedaron fuera de [low, high].

Los valores no finitos se representan en el JSON de entrada como cadenas
("NaN", "Infinity") o null, porque JSON estricto no admite NaN/Infinity.

Para regenerar el fixture:
  python tools/gen_data_layer_fixture.py
"""

from __future__ import annotations

import json
import math
import sys
from datetime import datetime, timezone
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
    Path(__file__).resolve().parent.parent
    / "fixtures"
    / "data_layer_reference.json"
)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

DISCARD_CAUSES = (
    "malformedRow",
    "invalidTime",
    "nonFinite",
    "invalidPrice",
    "highBelowLow",
    "invalidVolume",
    "duplicate",
)


def is_finite_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def is_record(value: Any) -> bool:
    return isinstance(value, dict)


def empty_discard_counts() -> dict[str, int]:
    return {cause: 0 for cause in DISCARD_CAUSES}


def parse_milliseconds(value: Any) -> int | None:
    """Devuelve segundos UTC enteros o None si el valor no es ms válidos."""
    if not is_finite_number(value):
        return None
    if not float(value).is_integer():
        return None
    milliseconds = int(value)
    if milliseconds <= 0 or milliseconds % 1000 != 0:
        return None
    seconds = milliseconds // 1000
    if seconds <= 0 or seconds > 2**53 - 1:
        return None
    return seconds


def et_date_key(seconds: int) -> str:
    return datetime.fromtimestamp(seconds, tz=NEW_YORK).date().isoformat()


def utc_date_key(seconds: int) -> str:
    return datetime.fromtimestamp(seconds, tz=UTC).date().isoformat()


def detect_gaps(
    bars: list[dict[str, Any]], bar_seconds: int, provider: str
) -> tuple[list[dict[str, Any]], str]:
    if bar_seconds >= 86_400:
        return [], "skippedDaily"

    gaps: list[dict[str, Any]] = []
    for previous, current in zip(bars, bars[1:]):
        diff = current["time"] - previous["time"]
        if diff <= bar_seconds:
            continue
        if provider == "massive":
            if et_date_key(previous["time"]) != et_date_key(current["time"]):
                continue
        missing = (diff - 1) // bar_seconds
        if missing <= 0:
            continue
        session = (
            et_date_key(previous["time"])
            if provider == "massive"
            else utc_date_key(previous["time"])
        )
        gaps.append(
            {
                "previousTime": previous["time"],
                "nextTime": current["time"],
                "diffSeconds": diff,
                "missingBars": missing,
                "sessionKey": session,
            }
        )
    return gaps, "performed"


def provider_error_from_massive(raw: dict[str, Any]) -> dict[str, Any] | None:
    status = raw.get("status")
    if isinstance(status, str) and status.upper() != "OK":
        message = raw.get("error")
        if not isinstance(message, str):
            message = raw.get("message")
        if not isinstance(message, str):
            message = status
        return {"code": 0, "message": message}
    return None


def provider_error_from_bingx(raw: dict[str, Any]) -> dict[str, Any] | None:
    code = raw.get("code")
    if is_finite_number(code) and code != 0:
        message = raw.get("msg")
        if not isinstance(message, str):
            message = raw.get("message")
        if not isinstance(message, str):
            message = ""
        return {"code": int(code), "message": message}
    return None


def forming_massive(
    bars: list[dict[str, Any]], bar_seconds: int, now: int | None
) -> dict[str, Any] | None:
    if now is None:
        return None
    if bar_seconds >= 86_400:
        now_key = et_date_key(now)
        for bar in bars:
            if et_date_key(bar["time"]) == now_key:
                return {"time": bar["time"], "reason": "intervalContainsNow"}
        return None
    for bar in bars:
        if bar["time"] <= now < bar["time"] + bar_seconds:
            return {"time": bar["time"], "reason": "intervalContainsNow"}
    return None


def forming_bingx(
    bars: list[dict[str, Any]],
    close_times: dict[int, int],
    bar_seconds: int,
    now: int | None,
) -> dict[str, Any] | None:
    if now is None:
        return None
    now_ms = now * 1000
    for bar in bars:
        close_time = close_times.get(bar["time"])
        if close_time is not None:
            if bar["time"] * 1000 <= now_ms <= close_time:
                return {
                    "time": bar["time"],
                    "reason": "closeTimeContainsServerTime",
                }
            continue
        if bar["time"] <= now < bar["time"] + bar_seconds:
            return {"time": bar["time"], "reason": "intervalContainsNow"}
    return None


def normalize_massive(
    raw: Any, bar_seconds: int, now: int | None
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    counts = empty_discard_counts()
    discards: list[dict[str, Any]] = []
    bars: list[dict[str, Any]] = []
    seen: set[int] = set()
    input_times: list[int] = []
    vw_missing = 0
    vw_zero = 0
    vw_non_finite = 0
    vw_outside = 0
    malformed = False
    provider_error: dict[str, Any] | None = None

    def discard(cause: str, time: int | None) -> None:
        counts[cause] += 1
        discards.append({"cause": cause, "time": time})

    rows: list[Any] = []
    if not is_record(raw):
        malformed = True
    else:
        provider_error = provider_error_from_massive(raw)
        results = raw.get("results")
        if results is None:
            rows = []
        elif isinstance(results, list):
            rows = results
        else:
            malformed = True
            rows = []

    received = len(rows)

    for row in rows:
        if not is_record(row):
            discard("malformedRow", None)
            continue

        time = parse_milliseconds(row.get("t"))
        if time is None:
            discard("invalidTime", None)
            continue

        open_price = row.get("o")
        high = row.get("h")
        low = row.get("l")
        close = row.get("c")
        volume = row.get("v")

        if not all(
            is_finite_number(value)
            for value in (open_price, high, low, close, volume)
        ):
            discard("nonFinite", time)
            continue

        if (
            open_price <= 0
            or high <= 0
            or low <= 0
            or close <= 0
        ):
            discard("invalidPrice", time)
            continue

        if high < low:
            discard("highBelowLow", time)
            continue

        if volume < 0:
            discard("invalidVolume", time)
            continue

        if time in seen:
            discard("duplicate", time)
            continue

        seen.add(time)
        input_times.append(time)

        bar: dict[str, Any] = {
            "time": time,
            "open": open_price,
            "high": high,
            "low": low,
            "close": close,
            "volume": volume,
        }
        vw = row.get("vw")
        if vw is None:
            vw_missing += 1
        elif not is_finite_number(vw):
            vw_non_finite += 1
        else:
            bar["vw"] = vw
            if vw == 0:
                vw_zero += 1
            if vw < low or vw > high:
                vw_outside += 1

        bars.append(bar)

    bars.sort(key=lambda item: item["time"])
    reordered = [bar["time"] for bar in bars] != input_times
    gaps, gap_detection = detect_gaps(bars, bar_seconds, "massive")
    forming = forming_massive(bars, bar_seconds, now)

    report = {
        "provider": "massive",
        "received": received,
        "accepted": len(bars),
        "discarded": received - len(bars),
        "discardCounts": counts,
        "discards": discards,
        "reordered": reordered,
        "gaps": gaps,
        "gapDetection": gap_detection,
        "vwMissing": vw_missing,
        "vwZero": vw_zero,
        "vwNonFinite": vw_non_finite,
        "vwOutsideRange": vw_outside,
        "formingBar": forming,
        "malformedResponse": malformed,
        "providerError": provider_error,
    }
    return bars, report


def normalize_bingx(
    raw: Any, bar_seconds: int, now: int | None
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    counts = empty_discard_counts()
    discards: list[dict[str, Any]] = []
    bars: list[dict[str, Any]] = []
    seen: set[int] = set()
    input_times: list[int] = []
    close_times: dict[int, int] = {}
    candidate_bars = 0
    candidate_missing = 0
    candidate_zero_volume = 0
    candidate_outside = 0
    malformed = False
    provider_error: dict[str, Any] | None = None

    def discard(cause: str, time: int | None) -> None:
        counts[cause] += 1
        discards.append({"cause": cause, "time": time})

    rows: list[Any] = []
    if not is_record(raw):
        malformed = True
    else:
        provider_error = provider_error_from_bingx(raw)
        data = raw.get("data")
        if data is None:
            rows = []
        elif isinstance(data, list):
            rows = data
        else:
            malformed = True
            rows = []

    received = len(rows)

    for row in rows:
        if not isinstance(row, list) or len(row) < 6:
            discard("malformedRow", None)
            continue

        time = parse_milliseconds(row[0])
        if time is None:
            discard("invalidTime", None)
            continue

        open_price = row[1]
        high = row[2]
        low = row[3]
        close = row[4]
        volume = row[5]

        if not all(
            is_finite_number(value)
            for value in (open_price, high, low, close, volume)
        ):
            discard("nonFinite", time)
            continue

        if (
            open_price <= 0
            or high <= 0
            or low <= 0
            or close <= 0
        ):
            discard("invalidPrice", time)
            continue

        if high < low:
            discard("highBelowLow", time)
            continue

        if volume < 0:
            discard("invalidVolume", time)
            continue

        if time in seen:
            discard("duplicate", time)
            continue

        seen.add(time)
        input_times.append(time)

        close_time = row[6] if len(row) >= 7 else None
        if is_finite_number(close_time) and close_time > 0:
            close_times[time] = int(close_time)

        quote_volume = row[7] if len(row) >= 8 else None
        if volume == 0:
            candidate_zero_volume += 1
        elif not is_finite_number(quote_volume):
            candidate_missing += 1
        else:
            candidate = quote_volume / volume
            if not math.isfinite(candidate):
                candidate_missing += 1
            else:
                candidate_bars += 1
                if candidate < low or candidate > high:
                    candidate_outside += 1

        # Nunca se añade vw.
        bars.append(
            {
                "time": time,
                "open": open_price,
                "high": high,
                "low": low,
                "close": close,
                "volume": volume,
            }
        )

    bars.sort(key=lambda item: item["time"])
    reordered = [bar["time"] for bar in bars] != input_times
    gaps, gap_detection = detect_gaps(bars, bar_seconds, "bingx")
    forming = forming_bingx(bars, close_times, bar_seconds, now)

    report = {
        "provider": "bingx",
        "received": received,
        "accepted": len(bars),
        "discarded": received - len(bars),
        "discardCounts": counts,
        "discards": discards,
        "reordered": reordered,
        "gaps": gaps,
        "gapDetection": gap_detection,
        "vwCandidateBars": candidate_bars,
        "vwCandidateMissing": candidate_missing,
        "vwCandidateZeroVolume": candidate_zero_volume,
        "vwCandidateOutsideRange": candidate_outside,
        "vwExposed": False,
        "formingBar": forming,
        "malformedResponse": malformed,
        "providerError": provider_error,
    }
    return bars, report


# ---------------------------------------------------------------------------
# Utilidades para construir casos
# ---------------------------------------------------------------------------


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


def massive_row(
    time: int,
    open_price: float,
    high: float,
    low: float,
    close: float,
    volume: float,
    vw: Any = "OMIT",
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "t": time * 1000,
        "o": open_price,
        "h": high,
        "l": low,
        "c": close,
        "v": volume,
    }
    if vw != "OMIT":
        row["vw"] = vw
    return row


def bingx_row(
    time: int,
    open_price: float,
    high: float,
    low: float,
    close: float,
    volume: float,
    close_time: int | None = None,
    quote_volume: Any = "OMIT",
) -> list[Any]:
    row: list[Any] = [
        time * 1000,
        open_price,
        high,
        low,
        close,
        volume,
    ]
    if close_time is not None or quote_volume != "OMIT":
        row.append(close_time if close_time is not None else time * 1000 + 59_999)
    if quote_volume != "OMIT":
        row.append(quote_volume)
    return row


def massive_case(
    description: str,
    raw: Any,
    bar_seconds: int,
    now: int | None = None,
) -> dict[str, Any]:
    bars, report = normalize_massive(raw, bar_seconds, now)
    options: dict[str, Any] = {"barSeconds": bar_seconds}
    if now is not None:
        options["now"] = now
    return {
        "description": description,
        "options": options,
        "raw": raw,
        "bars": bars,
        "report": report,
    }


def bingx_case(
    description: str,
    raw: Any,
    bar_seconds: int,
    now: int | None = None,
) -> dict[str, Any]:
    bars, report = normalize_bingx(raw, bar_seconds, now)
    options: dict[str, Any] = {"barSeconds": bar_seconds}
    if now is not None:
        options["now"] = now
    return {
        "description": description,
        "options": options,
        "raw": raw,
        "bars": bars,
        "report": report,
    }


def build_massive_cases() -> dict[str, dict[str, Any]]:
    cases: dict[str, dict[str, Any]] = {}
    base = et_seconds(2026, 11, 6, 4, 0)
    after = et_seconds(2026, 11, 7, 20, 0)

    cases["m1_valid_sorted"] = massive_case(
        "tres barras válidas en orden descendente; se ordenan y reordered=true",
        {
            "status": "OK",
            "results": [
                massive_row(base + 120, 100.0, 101.0, 99.5, 100.5, 10.0, 100.2),
                massive_row(base, 99.0, 100.0, 98.5, 99.5, 5.0, 99.1),
                massive_row(base + 60, 99.5, 100.5, 99.0, 100.0, 7.0, 99.8),
            ],
        },
        60,
        after,
    )

    valid = massive_row(base + 600, 100.0, 101.0, 99.0, 100.0, 1.0, 100.0)
    cases["m2_discards"] = massive_case(
        "una fila por cada causa de descarte, más duplicado y vw no finito",
        {
            "status": "OK",
            "results": [
                "not-a-row",
                massive_row(base, 100.0, 101.0, 99.0, 100.0, 1.0),
                {"t": str((base + 60) * 1000), "o": 1, "h": 1, "l": 1, "c": 1, "v": 1},
                massive_row(base + 120, 0.0, 1.0, 0.5, 1.0, 1.0),
                massive_row(base + 180, 1.0, 0.5, 1.0, 1.0, 1.0),
                massive_row(base + 240, 1.0, 1.0, 1.0, 1.0, -1.0),
                massive_row(base + 300, 1.0, 1.0, 1.0, 1.0, 1.0),
                massive_row(base + 300, 2.0, 2.0, 2.0, 2.0, 2.0),
                massive_row(base + 360, 1.0, 1.0, 1.0, 1.0, 1.0, "NaN"),
                massive_row(base + 420, "NaN", 1.0, 1.0, 1.0, 1.0, 1.0),
                valid,
            ],
        },
        60,
        after,
    )

    cases["m3_gap_within_session"] = massive_case(
        "hueco de un minuto dentro de la misma sesión ET; no se rellena",
        {
            "status": "OK",
            "results": [
                massive_row(base, 100.0, 101.0, 99.0, 100.0, 1.0, 100.0),
                massive_row(base + 60, 101.0, 102.0, 100.0, 101.0, 1.0, 101.0),
                massive_row(base + 180, 102.0, 103.0, 101.0, 102.0, 1.0, 102.0),
                massive_row(base + 240, 103.0, 104.0, 102.0, 103.0, 1.0, 103.0),
            ],
        },
        60,
        after,
    )

    cases["m4_gap_cross_session"] = massive_case(
        "salto de 19:59 a 04:00 del día siguiente; NO es un hueco de datos",
        {
            "status": "OK",
            "results": [
                massive_row(et_seconds(2026, 11, 6, 19, 58), 100.0, 101.0, 99.0, 100.0, 1.0, 100.0),
                massive_row(et_seconds(2026, 11, 6, 19, 59), 101.0, 102.0, 100.0, 101.0, 1.0, 101.0),
                massive_row(et_seconds(2026, 11, 7, 4, 0), 102.0, 103.0, 101.0, 102.0, 1.0, 102.0),
                massive_row(et_seconds(2026, 11, 7, 4, 1), 103.0, 104.0, 102.0, 103.0, 1.0, 103.0),
            ],
        },
        60,
        after,
    )

    cases["m5_daily_gap_skipped"] = massive_case(
        "barras diarias con fin de semana: gapDetection=skippedDaily y sin huecos",
        {
            "status": "OK",
            "results": [
                massive_row(et_seconds(2026, 11, 5, 0, 0), 100.0, 101.0, 99.0, 100.0, 1.0, 100.0),
                massive_row(et_seconds(2026, 11, 6, 0, 0), 101.0, 102.0, 100.0, 101.0, 1.0, 101.0),
                massive_row(et_seconds(2026, 11, 9, 0, 0), 102.0, 103.0, 101.0, 102.0, 1.0, 102.0),
            ],
        },
        86_400,
        et_seconds(2026, 11, 10, 12, 0),
    )

    cases["m6_provider_error"] = massive_case(
        "respuesta de error del proveedor; no hay barras",
        {"status": "ERROR", "error": "boom"},
        60,
        after,
    )

    cases["m7_malformed_response"] = massive_case(
        "results no es un array; malformedResponse=true",
        {"status": "OK", "results": "nope"},
        60,
        after,
    )

    cases["m8_not_object"] = massive_case(
        "la respuesta cruda no es un objeto; malformedResponse=true",
        ["not", "an", "object"],
        60,
        after,
    )

    cases["m9_forming_intraday"] = massive_case(
        "now cae dentro de la barra de 04:02; se reporta pero no se elimina",
        {
            "status": "OK",
            "results": [
                massive_row(base + 60, 100.0, 101.0, 99.0, 100.0, 1.0, 100.0),
                massive_row(base + 120, 101.0, 102.0, 100.0, 101.0, 1.0, 101.0),
                massive_row(base + 180, 102.0, 103.0, 101.0, 102.0, 1.0, 102.0),
            ],
        },
        60,
        base + 150,
    )

    cases["m10_forming_daily"] = massive_case(
        "now cae en la fecha ET de la barra diaria en formación",
        {
            "status": "OK",
            "results": [
                massive_row(et_seconds(2026, 11, 5, 0, 0), 100.0, 101.0, 99.0, 100.0, 1.0, 100.0),
                massive_row(et_seconds(2026, 11, 6, 0, 0), 101.0, 102.0, 100.0, 101.0, 1.0, 101.0),
            ],
        },
        86_400,
        et_seconds(2026, 11, 6, 12, 0),
    )

    cases["m11_vw_stats"] = massive_case(
        "estadísticas de vw: ausente, null, cero, no finito, dentro y fuera de rango",
        {
            "status": "OK",
            "results": [
                massive_row(base, 100.0, 110.0, 90.0, 100.0, 1.0, 100.0),
                massive_row(base + 60, 100.0, 110.0, 90.0, 100.0, 1.0, 90.0),
                massive_row(base + 120, 100.0, 110.0, 90.0, 100.0, 1.0, 110.0),
                massive_row(base + 180, 100.0, 110.0, 90.0, 100.0, 1.0, 89.0),
                massive_row(base + 240, 100.0, 110.0, 90.0, 100.0, 1.0, 111.0),
                massive_row(base + 300, 100.0, 110.0, 90.0, 100.0, 1.0, 0.0),
                massive_row(base + 360, 100.0, 110.0, 90.0, 100.0, 1.0),
                massive_row(base + 420, 100.0, 110.0, 90.0, 100.0, 1.0, None),
                massive_row(base + 480, 100.0, 110.0, 90.0, 100.0, 1.0, "Infinity"),
            ],
        },
        60,
        after,
    )

    return cases


def build_bingx_cases() -> dict[str, dict[str, Any]]:
    cases: dict[str, dict[str, Any]] = {}
    base = utc_seconds(2026, 11, 7, 12, 0)
    after = utc_seconds(2026, 11, 7, 20, 0)

    cases["b1_valid_sorted"] = bingx_case(
        "tres barras válidas descendentes; se ordenan y reordered=true",
        {
            "code": 0,
            "timestamp": after * 1000,
            "data": [
                bingx_row(base + 120, 100.0, 101.0, 99.5, 100.5, 10.0, (base + 179) * 1000, 1002.0),
                bingx_row(base, 99.0, 100.0, 98.5, 99.5, 5.0, (base + 59) * 1000, 495.0),
                bingx_row(base + 60, 99.5, 100.5, 99.0, 100.0, 7.0, (base + 119) * 1000, 700.0),
            ],
        },
        60,
        after,
    )

    valid = bingx_row(base + 600, 100.0, 101.0, 99.0, 100.0, 1.0, (base + 659) * 1000, 100.0)
    cases["b2_discards"] = bingx_case(
        "una fila por cada causa de descarte, más duplicado",
        {
            "code": 0,
            "timestamp": after * 1000,
            "data": [
                "not-a-row",
                [base * 1000, 1.0, 1.0, 1.0, 1.0],
                [str((base + 60) * 1000), 1.0, 1.0, 1.0, 1.0, 1.0],
                [(base + 120) * 1000, 1.0, 1.0, 1.0, 1.0, 1.0],
                [0, 1.0, 1.0, 1.0, 1.0, 1.0],
                [((base + 180) * 1000) + 1, 1.0, 1.0, 1.0, 1.0, 1.0],
                [(base + 240) * 1000, None, 1.0, 1.0, 1.0, 1.0],
                [(base + 300) * 1000, 0.0, 1.0, 0.5, 1.0, 1.0],
                [(base + 360) * 1000, 1.0, 0.5, 1.0, 1.0, 1.0],
                [(base + 420) * 1000, 1.0, 1.0, 1.0, 1.0, -1.0],
                [(base + 480) * 1000, 1.0, 1.0, 1.0, 1.0, 1.0],
                [(base + 480) * 1000, 2.0, 2.0, 2.0, 2.0, 2.0],
                valid,
            ],
        },
        60,
        after,
    )

    cases["b3_gap_cross_midnight"] = bingx_case(
        "hueco de un minuto que cruza medianoche UTC; SÍ se reporta",
        {
            "code": 0,
            "timestamp": utc_seconds(2026, 11, 8, 0, 10) * 1000,
            "data": [
                bingx_row(utc_seconds(2026, 11, 7, 23, 58), 100.0, 101.0, 99.0, 100.0, 1.0, utc_seconds(2026, 11, 7, 23, 58) * 1000 + 59_999, 100.0),
                bingx_row(utc_seconds(2026, 11, 7, 23, 59), 101.0, 102.0, 100.0, 101.0, 1.0, utc_seconds(2026, 11, 7, 23, 59) * 1000 + 59_999, 101.0),
                bingx_row(utc_seconds(2026, 11, 8, 0, 1), 102.0, 103.0, 101.0, 102.0, 1.0, utc_seconds(2026, 11, 8, 0, 1) * 1000 + 59_999, 102.0),
                bingx_row(utc_seconds(2026, 11, 8, 0, 2), 103.0, 104.0, 102.0, 103.0, 1.0, utc_seconds(2026, 11, 8, 0, 2) * 1000 + 59_999, 103.0),
            ],
        },
        60,
        utc_seconds(2026, 11, 8, 0, 10),
    )

    cases["b4_daily_gap_skipped"] = bingx_case(
        "barras diarias con fin de semana: gapDetection=skippedDaily",
        {
            "code": 0,
            "timestamp": utc_seconds(2026, 11, 10, 12, 0) * 1000,
            "data": [
                bingx_row(utc_seconds(2026, 11, 5, 16, 0), 100.0, 101.0, 99.0, 100.0, 1.0, utc_seconds(2026, 11, 6, 15, 59, 59) * 1000 + 999, 100.0),
                bingx_row(utc_seconds(2026, 11, 6, 16, 0), 101.0, 102.0, 100.0, 101.0, 1.0, utc_seconds(2026, 11, 7, 15, 59, 59) * 1000 + 999, 101.0),
                bingx_row(utc_seconds(2026, 11, 9, 16, 0), 102.0, 103.0, 101.0, 102.0, 1.0, utc_seconds(2026, 11, 10, 15, 59, 59) * 1000 + 999, 102.0),
            ],
        },
        86_400,
        utc_seconds(2026, 11, 10, 20, 0),
    )

    cases["b5_provider_error"] = bingx_case(
        "respuesta de error de BingX; no hay barras",
        {
            "code": 100204,
            "msg": "maximum query range is 380 days",
            "data": None,
        },
        86_400,
        after,
    )

    cases["b6_malformed_response"] = bingx_case(
        "data no es un array; malformedResponse=true",
        {"code": 0, "data": {}},
        60,
        after,
    )

    cases["b7_not_object"] = bingx_case(
        "la respuesta cruda no es un objeto; malformedResponse=true",
        ["not", "an", "object"],
        60,
        after,
    )

    cases["b8_forming_close_time"] = bingx_case(
        "now cae dentro del closeTime de la última barra; se reporta la formación",
        {
            "code": 0,
            "timestamp": (base + 150) * 1000,
            "data": [
                bingx_row(base + 60, 100.0, 101.0, 99.0, 100.0, 1.0, (base + 119) * 1000 + 999, 100.0),
                bingx_row(base + 120, 101.0, 102.0, 100.0, 101.0, 1.0, (base + 179) * 1000 + 999, 101.0),
                bingx_row(base + 180, 102.0, 103.0, 101.0, 102.0, 1.0, (base + 239) * 1000 + 999, 102.0),
            ],
        },
        60,
        base + 150,
    )

    cases["b9_forming_interval"] = bingx_case(
        "sin closeTime, now cae dentro del intervalo de la barra; formación por intervalo",
        {
            "code": 0,
            "timestamp": (base + 150) * 1000,
            "data": [
                [((base + 60) * 1000), 100.0, 101.0, 99.0, 100.0, 1.0],
                [((base + 120) * 1000), 101.0, 102.0, 100.0, 101.0, 1.0],
                [((base + 180) * 1000), 102.0, 103.0, 101.0, 102.0, 1.0],
            ],
        },
        60,
        base + 150,
    )

    cases["b10_vw_candidate_stats"] = bingx_case(
        "candidato quoteVolume/volume: dentro, fuera, ausente y volumen cero; vwExposed=false",
        {
            "code": 0,
            "timestamp": after * 1000,
            "data": [
                bingx_row(base, 100.0, 110.0, 90.0, 100.0, 2.0, (base + 59) * 1000, 200.0),
                bingx_row(base + 60, 100.0, 110.0, 90.0, 100.0, 2.0, (base + 119) * 1000, 178.0),
                bingx_row(base + 120, 100.0, 110.0, 90.0, 100.0, 2.0, (base + 179) * 1000, 222.0),
                bingx_row(base + 180, 100.0, 110.0, 90.0, 100.0, 2.0, (base + 239) * 1000),
                bingx_row(base + 240, 100.0, 110.0, 90.0, 100.0, 0.0, (base + 299) * 1000, 0.0),
                bingx_row(base + 300, 100.0, 110.0, 90.0, 100.0, 2.0, (base + 359) * 1000, "NaN"),
            ],
        },
        60,
        after,
    )

    return cases


def build_fixture() -> dict[str, Any]:
    return {
        "metadata": {
            "generator": "tools/gen_data_layer_fixture.py",
            "command": "python tools/gen_data_layer_fixture.py",
            "method": (
                "Referencia independiente en Python, explícita, sin importar "
                "el código TypeScript. Valida, convierte ms->s, ordena, detecta "
                "huecos sin rellenar y reporta descartes. BingX nunca expone vw."
            ),
            "tolerance": (
                "Exacta para tiempos, precios, volúmenes, contadores y banderas; "
                "los valores se copian del JSON crudo sin aritmética."
            ),
            "discardOrder": list(DISCARD_CAUSES),
            "nonFiniteEncoding": (
                "Las entradas usan null o cadenas como \"NaN\"/\"Infinity\" "
                "para representar valores no finitos."
            ),
            "bingxVwDecision": (
                "vwExposed=false: la muestra real de 1m tuvo 185/3445 barras "
                "fuera de [low, high], así que quoteVolume/volume no se usa."
            ),
        },
        "normalizers": {
            "massive": {"cases": build_massive_cases()},
            "bingx": {"cases": build_bingx_cases()},
        },
    }


def main() -> None:
    print("Generando fixture independiente de la capa de datos...")
    fixture = build_fixture()

    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(FIXTURE_PATH, "w", encoding="utf-8") as file:
        json.dump(
            fixture,
            file,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        file.write("\n")

    print(f"Fixture generado exitosamente en: {FIXTURE_PATH}")
    for provider, section in fixture["normalizers"].items():
        print(f"  - {provider}: {len(section['cases'])} casos")
    print(f"Tamaño: {FIXTURE_PATH.stat().st_size} bytes")


if __name__ == "__main__":
    main()
