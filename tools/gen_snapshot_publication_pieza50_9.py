#!/usr/bin/env python3
"""Referencia independiente Pieza 50.9 Bloque B — publicacion coherente de snapshots US.

Implementacion explicita (sin copiar la logica TypeScript):

  - Decision de publicacion por alcance: la revision entrante debe ser entera
    positiva y su evaluacion finita; sin sello previo se acepta; revision y
    evaluacion no retroceden dentro del alcance (una revision mayor con
    evaluacion anterior queda obsoleta); un sello previo con evaluacion no
    finita no bloquea.

  - Decision por vencimiento: un hecho puntual sin datos cargados o con
    evaluacion invalida nunca publica; sin datos vigentes para esa fecha (la
    base la omite o trae stub) el hecho se publica/anexa; con datos vigentes
    solo gana el hecho estrictamente mas nuevo.

  - Fusion base + vencimientos puntuales: TODO el agregado (asOf, spot,
    contexto, calidad) proviene de la base; de la respuesta puntual solo cuentan
    las fechas con loaded=true (con only_date, SOLO esa fecha). Cada fecha
    cargada reemplaza la entrada homonima de la base (la version puntual vigente
    gana), se anade ordenada si falta, y actualiza expiriesByCode unicamente
    para esas fechas. Sin fechas cargadas la base queda intacta.

Genera fixtures/snapshot_publication_pieza50_9_reference.json.
"""
from __future__ import annotations

import json
import math
import os

OUT = os.path.join(
    os.path.dirname(__file__), "..", "fixtures", "snapshot_publication_pieza50_9_reference.json"
)


def is_finite_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def decide(current, incoming):
    revision = incoming.get("revision")
    if not (isinstance(revision, int) and not isinstance(revision, bool) and revision > 0):
        return "stale"
    evaluation = incoming.get("evaluationSec")
    if not is_finite_number(evaluation):
        return "stale"
    if current is None:
        return "accept"
    current_evaluation = current.get("evaluationSec")
    if not is_finite_number(current_evaluation):
        return "accept"
    # revision es secuencia local de solicitudes (beginPublication), mientras
    # evaluationSec es asOfUtcSec del servidor y gobierna la frescura de datos.
    if evaluation < current_evaluation:
        return "stale"
    current_revision = current.get("revision")
    if isinstance(current_revision, int) and not isinstance(current_revision, bool) and current_revision > 0:
        return "accept" if revision >= current_revision else "stale"
    return "accept"


def point_fact_decision(fact, current):
    if fact.get("loaded") is not True:
        return "keep"
    fact_evaluation = fact.get("evaluationSec")
    if not is_finite_number(fact_evaluation):
        return "keep"
    if current is None:
        return "publish"
    if current.get("loaded") is not True:
        return "publish"
    current_evaluation = current.get("evaluationSec")
    if not is_finite_number(current_evaluation):
        return "publish"
    return "publish" if fact_evaluation > current_evaluation else "keep"


def chain_entries(snap):
    chain = snap.get("optionsChain")
    if not isinstance(chain, dict):
        return None
    entries = chain.get("availableExpirations")
    return entries if isinstance(entries, list) else []


def loaded_dates(scope):
    dates = set()
    for entry in chain_entries(scope) or []:
        date = entry.get("expirationDate")
        if entry.get("loaded") is True and isinstance(date, str):
            dates.add(date)
    return dates


def vol_suite(snap):
    engines = snap.get("terminalEngines")
    suite = engines.get("volAnalyticsSuite") if isinstance(engines, dict) else None
    return suite if isinstance(suite, dict) else None


def merge(base, scope, only_date=None):
    if scope is None:
        return base
    loaded = loaded_dates(scope)
    if only_date is not None:
        loaded = {date for date in loaded if date == only_date}
    if not loaded:
        return base
    scope_entries = {}
    for entry in chain_entries(scope) or []:
        scope_entries[entry.get("expirationDate")] = entry

    result = dict(base)
    base_entries = chain_entries(base)
    if base_entries is not None:
        merged_entries = [
            scope_entries.get(entry.get("expirationDate"), entry)
            if entry.get("expirationDate") in loaded
            else entry
            for entry in base_entries
        ]
        present = {entry.get("expirationDate") for entry in merged_entries}
        for date in sorted(date for date in loaded if date not in present):
            merged_entries.append(scope_entries[date])
        result["optionsChain"] = {
            **base.get("optionsChain"),
            "availableExpirations": merged_entries,
        }

    suite = vol_suite(base)
    scope_suite = vol_suite(scope)
    scope_codes = scope_suite.get("expiriesByCode") if scope_suite is not None else None
    if suite is not None and isinstance(scope_codes, dict):
        base_codes = suite.get("expiriesByCode")
        merged_codes = dict(base_codes) if isinstance(base_codes, dict) else {}
        for date in loaded:
            if date in scope_codes:
                merged_codes[date] = scope_codes[date]
        result["terminalEngines"] = {
            **base.get("terminalEngines"),
            "volAnalyticsSuite": {**suite, "expiriesByCode": merged_codes},
        }
    return result


def expiry_entry(date, loaded=False, calls=0, puts=0, days=21, window=True, liquidity=0.5):
    return {
        "expirationDate": date,
        "daysToExpiry": days,
        "loaded": loaded,
        "validCallCount": calls,
        "validPutCount": puts,
        "nearAtmLiquidity": liquidity,
        "inDefaultWindow": window,
        "hasCompleteAtmChain": loaded,
    }


def analytics(code, iv_atm, days=21):
    return {"expiryCode": code, "daysToExpiry": days, "ivAtm": iv_atm}


def snapshot(as_of, spot, entries, codes, with_chain=True, with_suite=True):
    snap = {
        "asOfUtcSec": as_of,
        "marketContext": {"spot": spot, "quoteMode": "LIVE_NBBO"},
    }
    if with_chain:
        snap["optionsChain"] = {
            "selectedExpirationDate": entries[0]["expirationDate"] if entries else None,
            "availableExpirations": entries,
        }
    if with_suite:
        snap["terminalEngines"] = {"volAnalyticsSuite": {"expiriesByCode": codes}}
    return snap


def build():
    decision_cases = [
        {
            "name": "primer_resultado",
            "current": None,
            "incoming": {"revision": 1, "evaluationSec": 1000},
            "expected": "accept",
        },
        {
            "name": "revision_mayor_manda_aunque_evaluacion_anterior",
            "current": {"revision": 2, "evaluationSec": 1000},
            "incoming": {"revision": 3, "evaluationSec": 900},
            "expected": "stale",
        },
        {
            "name": "revision_mayor_con_evaluacion_igual",
            "current": {"revision": 2, "evaluationSec": 1000},
            "incoming": {"revision": 3, "evaluationSec": 1000},
            "expected": "accept",
        },
        {
            "name": "misma_revision_misma_hora",
            "current": {"revision": 2, "evaluationSec": 1000},
            "incoming": {"revision": 2, "evaluationSec": 1000},
            "expected": "accept",
        },
        {
            "name": "misma_revision_hora_mayor",
            "current": {"revision": 2, "evaluationSec": 1000},
            "incoming": {"revision": 2, "evaluationSec": 1001},
            "expected": "accept",
        },
        {
            "name": "misma_revision_hora_menor",
            "current": {"revision": 2, "evaluationSec": 1000},
            "incoming": {"revision": 2, "evaluationSec": 999},
            "expected": "stale",
        },
        {
            "name": "revision_menor",
            "current": {"revision": 3, "evaluationSec": 1000},
            "incoming": {"revision": 2, "evaluationSec": 9999},
            "expected": "stale",
        },
        {
            "name": "revision_cero",
            "current": None,
            "incoming": {"revision": 0, "evaluationSec": 1000},
            "expected": "stale",
        },
        {
            "name": "revision_no_entera",
            "current": None,
            "incoming": {"revision": 1.5, "evaluationSec": 1000},
            "expected": "stale",
        },
        {
            "name": "evaluacion_ausente",
            "current": None,
            "incoming": {"revision": 1, "evaluationSec": None},
            "expected": "stale",
        },
        {
            "name": "evaluacion_booleana",
            "current": None,
            "incoming": {"revision": 1, "evaluationSec": True},
            "expected": "stale",
        },
        {
            "name": "sello_previo_con_evaluacion_rota_no_bloquea",
            "current": {"revision": 1, "evaluationSec": None},
            "incoming": {"revision": 1, "evaluationSec": 1000},
            "expected": "accept",
        },
    ]

    base_full = snapshot(
        1000,
        62.5,
        [
            expiry_entry("2026-08-21", loaded=False, days=21, window=True),
            expiry_entry("2026-09-18", loaded=False, days=49, window=False),
        ],
        {"2026-08-21": analytics("2026-08-21", 0.4), "2026-09-18": analytics("2026-09-18", 0.42, 49)},
    )
    scope_upgrade = snapshot(
        2000,
        99.9,
        [
            expiry_entry("2026-08-21", loaded=True, calls=120, puts=140, days=21, liquidity=88000),
            expiry_entry("2026-09-18", loaded=False, days=49, window=False),
        ],
        {"2026-08-21": analytics("2026-08-21", 0.55), "2026-09-18": analytics("2026-09-18", 0.99, 49)},
    )

    base_single = snapshot(
        1000,
        62.5,
        [expiry_entry("2026-08-21", loaded=False, days=21)],
        {"2026-08-21": analytics("2026-08-21", 0.4)},
    )
    base_with_anchors = snapshot(
        1000,
        62.5,
        [
            expiry_entry("2026-08-21", loaded=False, days=21),
            expiry_entry("2026-10-16", loaded=False, days=77, window=False),
        ],
        {
            "2026-08-21": analytics("2026-08-21", 0.4),
            "2026-10-16": analytics("2026-10-16", 0.41, 77),
        },
    )
    scope_union = snapshot(
        2100,
        99.9,
        [
            expiry_entry("2026-12-18", loaded=True, calls=30, puts=35, days=140, window=False),
            expiry_entry("2026-08-21", loaded=True, calls=120, puts=140, days=21, liquidity=88000),
            expiry_entry("2026-10-16", loaded=True, calls=60, puts=70, days=77, window=False),
        ],
        {
            "2026-08-21": analytics("2026-08-21", 0.55),
            "2026-10-16": analytics("2026-10-16", 0.6, 77),
            "2026-12-18": analytics("2026-12-18", 0.7, 140),
        },
    )

    scope_not_loaded = snapshot(
        2000,
        99.9,
        [expiry_entry("2026-08-21", loaded=False, days=21)],
        {"2026-08-21": analytics("2026-08-21", 0.55)},
    )

    base_loaded = snapshot(
        1000,
        62.5,
        [expiry_entry("2026-08-21", loaded=True, calls=10, puts=12, days=21)],
        {"2026-08-21": analytics("2026-08-21", 0.3)},
    )

    scope_without_suite = snapshot(
        2000,
        99.9,
        [expiry_entry("2026-08-21", loaded=True, calls=120, puts=140, days=21, liquidity=88000)],
        {},
        with_suite=False,
    )
    base_without_suite = snapshot(
        1000,
        62.5,
        [expiry_entry("2026-08-21", loaded=False, days=21)],
        {},
        with_suite=False,
    )
    base_without_chain = snapshot(
        1000,
        62.5,
        [],
        {"2026-08-21": analytics("2026-08-21", 0.4)},
        with_chain=False,
    )

    point_fact_cases = [
        {
            "name": "sin_datos_vigentes_publica",
            "fact": {"loaded": True, "evaluationSec": 1000},
            "current": None,
            "expected": "publish",
        },
        {
            "name": "base_omite_la_fecha_publica",
            "fact": {"loaded": True, "evaluationSec": 1000},
            "current": {"loaded": False, "evaluationSec": 2000},
            "expected": "publish",
        },
        {
            "name": "hecho_estrictamente_mas_nuevo_publica",
            "fact": {"loaded": True, "evaluationSec": 2000},
            "current": {"loaded": True, "evaluationSec": 1000},
            "expected": "publish",
        },
        {
            "name": "hecho_mas_viejo_conserva",
            "fact": {"loaded": True, "evaluationSec": 1000},
            "current": {"loaded": True, "evaluationSec": 2000},
            "expected": "keep",
        },
        {
            "name": "misma_evaluacion_conserva",
            "fact": {"loaded": True, "evaluationSec": 1000},
            "current": {"loaded": True, "evaluationSec": 1000},
            "expected": "keep",
        },
        {
            "name": "evaluacion_actual_desconocida_publica",
            "fact": {"loaded": True, "evaluationSec": 1000},
            "current": {"loaded": True, "evaluationSec": None},
            "expected": "publish",
        },
        {
            "name": "hecho_sin_cargar_no_publica",
            "fact": {"loaded": False, "evaluationSec": 1000},
            "current": None,
            "expected": "keep",
        },
        {
            "name": "hecho_con_evaluacion_invalida_no_publica",
            "fact": {"loaded": True, "evaluationSec": None},
            "current": {"loaded": True, "evaluationSec": 1000},
            "expected": "keep",
        },
    ]

    merge_cases = [
        {
            "name": "mejora_fecha_cargada_y_conserva_agregado",
            "base": base_full,
            "scope": scope_upgrade,
            "expected": merge(base_full, scope_upgrade),
        },
        {
            "name": "une_fechas_ausentes_ordenadas",
            "base": base_single,
            "scope": scope_union,
            "expected": merge(base_single, scope_union),
        },
        {
            "name": "restringe_publicacion_puntual_a_su_fecha",
            "base": base_with_anchors,
            "scope": scope_union,
            "onlyDate": "2026-08-21",
            "expected": merge(base_with_anchors, scope_union, "2026-08-21"),
        },
        {
            "name": "restringe_y_anexa_solo_la_fecha_solicitada",
            "base": base_single,
            "scope": scope_union,
            "onlyDate": "2026-12-18",
            "expected": merge(base_single, scope_union, "2026-12-18"),
        },
        {
            "name": "restringe_a_fecha_no_cargada_no_cambia",
            "base": base_with_anchors,
            "scope": scope_union,
            "onlyDate": "2026-09-18",
            "expected": merge(base_with_anchors, scope_union, "2026-09-18"),
        },
        {
            "name": "scope_sin_fechas_cargadas_no_cambia",
            "base": base_full,
            "scope": scope_not_loaded,
            "expected": merge(base_full, scope_not_loaded),
        },
        {
            "name": "scope_nulo_no_cambia",
            "base": base_full,
            "scope": None,
            "expected": merge(base_full, None),
        },
        {
            "name": "conflicto_por_fecha_gana_el_scope_vigente",
            "base": base_loaded,
            "scope": scope_upgrade,
            "expected": merge(base_loaded, scope_upgrade),
        },
        {
            "name": "scope_sin_suite_conserva_la_suite_de_la_base",
            "base": base_full,
            "scope": scope_without_suite,
            "expected": merge(base_full, scope_without_suite),
        },
        {
            "name": "base_sin_suite_no_crea_suite",
            "base": base_without_suite,
            "scope": scope_upgrade,
            "expected": merge(base_without_suite, scope_upgrade),
        },
        {
            "name": "base_sin_options_chain_conserva_estructura",
            "base": base_without_chain,
            "scope": scope_upgrade,
            "expected": merge(base_without_chain, scope_upgrade),
        },
    ]

    return {
        "meta": {"generator": "tools/gen_snapshot_publication_pieza50_9.py"},
        "decisionCases": decision_cases,
        "pointFactCases": point_fact_cases,
        "mergeCases": merge_cases,
    }


def main():
    fixture = build()
    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump(fixture, handle, indent=1)
        handle.write("\n")
    print(
        f"OK -> {os.path.relpath(OUT)} "
        f"({len(fixture['decisionCases'])} decisiones, "
        f"{len(fixture['pointFactCases'])} hechos por vencimiento, "
        f"{len(fixture['mergeCases'])} fusiones)"
    )


if __name__ == "__main__":
    main()
