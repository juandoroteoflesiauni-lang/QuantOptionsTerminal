#!/usr/bin/env python3
"""Referencia independiente Pieza 50.9 Bloque A — trazabilidad de exposición.

Implementacion explicita (sin copiar la logica TypeScript):

  - Tiempo de cotizacion verificable: entero > 0 y <= evaluacion; faltante,
    invalido o futuro es desconocido; una punta sustituida por referencia EOD
    no aporta tiempo y queda fuera del rango aunque su precio coincida.
  - Rango = min/max sobre tiempos verificables; edades = evaluacion - extremo.
  - Cobertura: desconocida sin evidencia o sin inputs; parcial con contratos
    descartados o cadena recortada comprobable; completa en el resto.
  - Metadatos: rangos y recuentos de strikes del motor y de byStrike; nulos para
    valores no finitos.

Genera fixtures/exposure_trace_pieza50_9_reference.json.
"""
from __future__ import annotations

import json
import math
import os

OUT = os.path.join(
    os.path.dirname(__file__), "..", "fixtures", "exposure_trace_pieza50_9_reference.json"
)


def summarize(entries, as_of):
    eval_sec = math.floor(as_of) if isinstance(as_of, (int, float)) and math.isfinite(as_of) else None
    known = unknown = overlay = eod = 0
    min_ts = max_ts = None
    for entry in entries:
        if entry.get("fromOverlay") is True:
            overlay += 1
        if entry.get("eodReference") is True:
            eod += 1
            unknown += 1
            continue
        ts = entry.get("updatedAtSec")
        verifiable = (
            isinstance(ts, int)
            and not isinstance(ts, bool)
            and ts > 0
            and eval_sec is not None
            and ts <= eval_sec
        )
        if not verifiable:
            unknown += 1
            continue
        known += 1
        min_ts = ts if min_ts is None or ts < min_ts else min_ts
        max_ts = ts if max_ts is None or ts > max_ts else max_ts
    return {
        "knownCount": known,
        "unknownCount": unknown,
        "minUpdatedAtSec": min_ts,
        "maxUpdatedAtSec": max_ts,
        "newestAgeSec": None if max_ts is None or eval_sec is None else eval_sec - max_ts,
        "oldestAgeSec": None if min_ts is None or eval_sec is None else eval_sec - min_ts,
        "overlayQuoteCount": overlay,
        "eodReferenceCount": eod,
    }


def coverage(evidence):
    if not evidence.get("evidenced"):
        return "unknown"
    inputs = evidence.get("engineInputs")
    skipped = evidence.get("skippedContracts")
    if not isinstance(inputs, (int, float)) or not math.isfinite(inputs) or inputs <= 0:
        return "unknown"
    if not isinstance(skipped, (int, float)) or not math.isfinite(skipped):
        return "unknown"
    if evidence.get("loadEvidenced") is not True:
        return "unknown"
    if (
        skipped > 0
        or evidence.get("chainTruncated") is True
        or evidence.get("chainErrors") is True
        or evidence.get("malformedResponse") is True
        or (evidence.get("missingDatesCount") or 0) > 0
    ):
        return "partial"
    return "complete"


def chain_coverage(reports, requested_dates):
    requested = []
    for date in requested_dates:
        if date != "" and date not in requested:
            requested.append(date)
    delivered = []
    truncated = errors = malformed = False
    range_loads = 0
    for report in reports:
        if report.get("stoppedReason") == "maxPages":
            truncated = True
        if report.get("stoppedReason") == "malformedResponse":
            malformed = True
        if report.get("providerError") is True:
            errors = True
        if report.get("kind") == "DTE_RANGE":
            range_loads += 1
            continue
        date_key = report.get("dateKey")
        if (
            date_key is not None
            and report.get("contractCount", 0) > 0
            and date_key in requested
            and date_key not in delivered
        ):
            delivered.append(date_key)
    missing = [date for date in requested if date not in delivered]
    return {
        "requestedDates": requested,
        "deliveredDates": sorted(delivered),
        "missingDates": missing,
        "chainTruncated": truncated,
        "chainErrors": errors,
        "malformedResponse": malformed,
        "rangeLoadCount": range_loads,
    }


def ar_oi(inputs):
    direct = sum(1 for item in inputs if item.get("oiFromReported") is True)
    proxy = len(inputs) - direct
    return {
        "directOiInputs": direct,
        "proxyOiInputs": proxy,
        "oiProxy": None if len(inputs) == 0 else proxy > 0,
    }


def finite_or_null(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def strike_range(values):
    finite = [v for v in values if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)]
    return {"min": min(finite) if finite else None, "max": max(finite) if finite else None}


def metadata(inp):
    return {
        "evaluationSec": math.floor(inp["evaluationSec"]) if math.isfinite(inp["evaluationSec"]) else None,
        "valuationSpot": finite_or_null(inp.get("valuationSpot")),
        "valuationSpotSource": inp.get("valuationSpotSource"),
        "headerSpot": finite_or_null(inp.get("headerSpot")),
        "spotDivergenceBps": finite_or_null(inp.get("spotDivergenceBps")),
        "quoteMode": inp.get("quoteMode"),
        "coverage": inp.get("coverage"),
        "engineExpirationsCount": len(inp["engineExpirationDates"]),
        "engineExpirationDates": list(inp["engineExpirationDates"]),
        "engineStrikeRange": strike_range(inp["engineStrikes"]),
        "engineStrikeCount": len(inp["engineStrikes"]),
        "byStrikeRange": strike_range(inp["byStrike"]),
        "byStrikeCount": len(inp["byStrike"]),
        "catalogExpirationsCount": inp.get("catalogExpirationsCount"),
        "catalogExpirationDates": list(inp["catalogExpirationDates"]),
        "payloadContractCount": inp.get("payloadContractCount", 0),
        "payloadExpirationDates": list(inp["payloadExpirationDates"]),
        "quoteTimes": inp.get("quoteTimes"),
        "chainCoverage": inp.get("chainCoverage"),
    }


def build():
    as_of = 1_700_000_000
    quote_cases = []

    def add_quotes(name, entries, expected=None):
        quote_cases.append(
            {
                "name": name,
                "entries": entries,
                "asOfUtcSec": as_of,
                "expected": expected if expected is not None else summarize(entries, as_of),
            }
        )

    add_quotes(
        "mixtos",
        [
            {"updatedAtSec": as_of - 15},
            {"updatedAtSec": as_of - 300, "fromOverlay": True},
            {"updatedAtSec": None},
            {"updatedAtSec": as_of - 45},
        ],
    )
    add_quotes("faltante", [{"updatedAtSec": None}])
    add_quotes("invalido", [{"updatedAtSec": 0}, {"updatedAtSec": -5}, {"updatedAtSec": 12.5}])
    add_quotes("futuro", [{"updatedAtSec": as_of + 60}])
    add_quotes("borde_evaluacion", [{"updatedAtSec": as_of}])
    add_quotes(
        "eod_referencia",
        [{"updatedAtSec": as_of - 20}, {"updatedAtSec": as_of - 10, "eodReference": True}],
    )
    add_quotes("overlay_parcial", [{"updatedAtSec": as_of - 5, "fromOverlay": True}, {"updatedAtSec": as_of - 9}])
    add_quotes("todo_desconocido", [{"updatedAtSec": None}, {"updatedAtSec": as_of + 1}])

    coverage_cases = [
        {"name": "completa", "evidence": {"evidenced": True, "engineInputs": 40, "skippedContracts": 0, "chainTruncated": False, "loadEvidenced": True}, "expected": coverage({"evidenced": True, "engineInputs": 40, "skippedContracts": 0, "chainTruncated": False, "loadEvidenced": True})},
        {"name": "parcial_descartes", "evidence": {"evidenced": True, "engineInputs": 40, "skippedContracts": 5, "chainTruncated": False, "loadEvidenced": True}, "expected": "partial"},
        {"name": "parcial_recorte", "evidence": {"evidenced": True, "engineInputs": 40, "skippedContracts": 0, "chainTruncated": True, "loadEvidenced": True}, "expected": "partial"},
        {"name": "parcial_malformed_sin_provider_error", "evidence": {"evidenced": True, "engineInputs": 40, "skippedContracts": 0, "chainTruncated": False, "chainErrors": False, "malformedResponse": True, "loadEvidenced": True}, "expected": "partial"},
        {"name": "sin_evidencia_carga", "evidence": {"evidenced": True, "engineInputs": 40, "skippedContracts": 0, "chainTruncated": False, "loadEvidenced": False}, "expected": "unknown"},
        {"name": "sin_evidencia", "evidence": {"evidenced": False, "engineInputs": 0, "skippedContracts": 0, "chainTruncated": False}, "expected": "unknown"},
        {"name": "sin_inputs", "evidence": {"evidenced": True, "engineInputs": 0, "skippedContracts": 0, "chainTruncated": False, "loadEvidenced": True}, "expected": "unknown"},
    ]

    metadata_input = {
        "evaluationSec": as_of,
        "valuationSpot": 123.456,
        "valuationSpotSource": "PARITY_IMPLIED",
        "headerSpot": 123.9,
        "spotDivergenceBps": 36.1,
        "quoteMode": "EOD_CLOSE_REF",
        "coverage": "partial",
        "engineStrikes": [90, 100, 110, None],
        "engineExpirationDates": ["2025-01-17", "2025-02-21", "2025-02-21"],
        "byStrike": [95, 105],
        "catalogExpirationsCount": 32,
        "catalogExpirationDates": ["2025-01-17", "2025-02-21"],
        "payloadContractCount": 120,
        "payloadExpirationDates": ["2025-01-17"],
        "quoteTimes": summarize(quote_cases[0]["entries"], as_of),
        "chainCoverage": chain_coverage(
            [
                {"dateKey": "2025-01-17", "kind": "DATE", "stoppedReason": "maxPages", "providerError": False, "contractCount": 5},
                {"dateKey": "2025-02-21", "kind": "DATE", "stoppedReason": "noMorePages", "providerError": False, "contractCount": 3},
                {"dateKey": None, "kind": "DTE_RANGE", "stoppedReason": "noMorePages", "providerError": False, "contractCount": 4},
            ],
            ["2025-01-17", "2025-02-21", "2025-06-20"],
        ),
    }
    metadata_case = {"name": "metadatos_mixtos", "input": metadata_input, "expected": metadata(metadata_input)}

    chain_cases = []
    for name, reports, requested in [
        (
            "maxpages",
            [{"dateKey": "2025-01-17", "kind": "DATE", "stoppedReason": "maxPages", "providerError": False, "contractCount": 5}],
            ["2025-01-17"],
        ),
        (
            "fecha_ausente",
            [{"dateKey": "2025-01-17", "kind": "DATE", "stoppedReason": "noMorePages", "providerError": False, "contractCount": 5}],
            ["2025-01-17", "2025-02-21"],
        ),
        (
            "error_proveedor",
            [{"dateKey": "2025-01-17", "kind": "DATE", "stoppedReason": "providerError", "providerError": True, "contractCount": 0}],
            ["2025-01-17"],
        ),
        (
            "malformed_sin_provider_error",
            [{"dateKey": "2025-01-17", "kind": "DATE", "stoppedReason": "malformedResponse", "providerError": False, "contractCount": 0}],
            ["2025-01-17"],
        ),
        (
            "rango_dte_sin_fechas",
            [{"dateKey": None, "kind": "DTE_RANGE", "stoppedReason": "maxPages", "providerError": False, "contractCount": 4}],
            [],
        ),
        (
            "completa_acotada",
            [{"dateKey": "2025-01-17", "kind": "DATE", "stoppedReason": "noMorePages", "providerError": False, "contractCount": 5}],
            ["2025-01-17"],
        ),
        (
            "sin_informes",
            [],
            ["2025-01-17"],
        ),
    ]:
        chain_cases.append({"name": name, "reports": reports, "requestedDates": requested, "expected": chain_coverage(reports, requested)})

    ar_oi_cases = [
        {"name": "directo", "inputs": [{"oiFromReported": True}, {"oiFromReported": True}], "expected": ar_oi([{"oiFromReported": True}, {"oiFromReported": True}])},
        {"name": "proxy", "inputs": [{"oiFromReported": True}, {"oiFromReported": False}], "expected": ar_oi([{"oiFromReported": True}, {"oiFromReported": False}])},
        {"name": "desconocido", "inputs": [], "expected": ar_oi([])},
    ]

    return {
        "meta": {"generator": "tools/gen_exposure_trace_pieza50_9.py"},
        "quoteCases": quote_cases,
        "coverageCases": coverage_cases,
        "metadataCases": [metadata_case],
        "chainCoverageCases": chain_cases,
        "arOiCases": ar_oi_cases,
    }


def main():
    fixture = build()
    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump(fixture, handle, indent=1)
        handle.write("\n")
    print(
        f"OK -> {os.path.relpath(OUT)} ({len(fixture['quoteCases'])} tiempos, "
        f"{len(fixture['coverageCases'])} coberturas, {len(fixture['metadataCases'])} metadatos)"
    )


if __name__ == "__main__":
    main()
