#!/usr/bin/env python3
"""
Generador de referencia independiente en Python para la Pieza 50.2 (catálogo
100% de vencimientos US/OPRA, anclas de precarga, fusión de vencimientos y
evaluación estricta de TIR / régimen sobre el vencimiento activo):

  1. `extractUsExpiryCatalog`: deduplica todas las fechas `YYYY-MM-DD` válidas
     (0DTE, diarios, semanales, mensuales, trimestrales y LEAPS a 400–730 DTE),
     calcula el DTE calendario ET exacto y contabiliza contratos cerca de ATM
     (±15%), sin truncar por cantidad ni horizonte.
  2. `selectAnchorUsExpirations`: elige ≤6 vencimientos ancla (front, ~7d,
     ~28d, ~60d, ~90d, ~180d) preservando `requestedExpiration` cuando queda
     fuera de los buckets (p. ej. LEAPS).
  3. `mergeUsOptionExpiryCatalog`: fusión del catálogo completo con las fechas
     ya cargadas preservando `loaded: true/false` y las métricas reales.
  4. `evaluateActiveExpiryHeaderTir` y `evaluateActiveExpiryRegimeAndBreaker`:
     matriz `(frontDte, activeDte, netGex, spot < putWall)` que verifica que la
     TIR y el banner `0DTE / Short Gamma` se evalúan EXCLUSIVAMENTE sobre el DTE
     del vencimiento activo (nunca heredados del front).

Implementación pura con `datetime`/`zoneinfo` (sin copiar la lógica TypeScript).
Salida: fixtures/options_pieza50_2_reference.json.
"""

from __future__ import annotations

import json
import math
import re
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

SECONDS_PER_DAY = 86_400
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ET = ZoneInfo("America/New_York")
UTC = ZoneInfo("UTC")


# ---------------------------------------------------------------------------
# Utilidades de fecha ET
# ---------------------------------------------------------------------------


def et_today(now_sec: int) -> str:
    return datetime.fromtimestamp(now_sec, tz=ET).strftime("%Y-%m-%d")


def iso_day_number(iso: str) -> float:
    try:
        d = datetime.strptime(iso, "%Y-%m-%d")
    except ValueError:
        return math.nan
    return datetime(d.year, d.month, d.day, tzinfo=UTC).timestamp() / SECONDS_PER_DAY


def calendar_dte_et(expiry_date: str, now_sec: int) -> float:
    today = et_today(now_sec)
    diff = iso_day_number(expiry_date) - iso_day_number(today)
    return diff if math.isfinite(diff) and diff >= 0 else math.nan


def add_days_et(date: str, days: int) -> str:
    from datetime import timedelta

    d = datetime.strptime(date, "%Y-%m-%d")
    return (d + timedelta(days=days)).strftime("%Y-%m-%d")


NOW_SEC = int(datetime(2026, 1, 5, 20, 30, tzinfo=UTC).timestamp())  # 15:30 ET
TODAY_ET = et_today(NOW_SEC)


def expiry_utc_sec(date: str, hour_utc: int = 21) -> int:
    """16:00 ET del vencimiento (21:00 UTC en EST)."""
    d = datetime.strptime(date, "%Y-%m-%d")
    return int(datetime(d.year, d.month, d.day, hour_utc, 0, tzinfo=UTC).timestamp())


# ---------------------------------------------------------------------------
# 1) Catálogo completo de vencimientos
# ---------------------------------------------------------------------------


def extract_us_expiry_catalog(
    contracts: list[dict[str, Any]],
    spot: float,
    now_sec: int,
) -> list[dict[str, Any]]:
    by_date: dict[str, dict[str, Any]] = {}
    for c in contracts:
        date = c["expirationDate"]
        if not DATE_RE.match(date):
            continue
        expiry_sec = c["expiryUtcSec"]
        dte_et = calendar_dte_et(date, now_sec)
        if not (expiry_sec > now_sec + 60 or (math.isfinite(dte_et) and dte_et >= 0)):
            continue
        approx_days = max(0, math.floor((expiry_sec - now_sec) / SECONDS_PER_DAY))
        days = dte_et if math.isfinite(dte_et) else approx_days
        near = math.isfinite(spot) and spot > 0 and abs(c["strikePrice"] - spot) <= spot * 0.15
        existing = by_date.get(date)
        if existing is not None:
            if near:
                existing["nearAtmContracts"] += 1
            continue
        by_date[date] = {
            "expirationDate": date,
            "daysToExpiry": days,
            "nearAtmContracts": 1 if near else 0,
        }
    return sorted(by_date.values(), key=lambda e: e["expirationDate"])


# ---------------------------------------------------------------------------
# 2) Selección de anclas
# ---------------------------------------------------------------------------

ANCHOR_BUCKETS: tuple[tuple[float, int, int], ...] = (
    (7.0, 3, 12),
    (28.0, 16, 40),
    (60.0, 45, 78),
    (90.0, 79, 125),
    (180.0, 135, 240),
)
MAX_ANCHOR_EXPIRATIONS = 6


def select_anchor_us_expirations(
    catalog: list[dict[str, Any]],
    requested: str | None,
) -> list[str]:
    entries = sorted(catalog, key=lambda e: e["expirationDate"])
    by_date = {e["expirationDate"]: e for e in entries}
    selected: list[str] = []

    def add(date: str | None) -> None:
        if date is not None and date not in selected:
            selected.append(date)

    req = (requested or "").strip()
    req_entry = by_date.get(req)
    if req != "" and req_entry is not None:
        add(req)

    front = entries[0] if entries else None
    if front is not None:
        add(front["expirationDate"])

    for target, lo, hi in ANCHOR_BUCKETS:
        candidates = [e for e in entries if lo <= e["daysToExpiry"] <= hi]
        if not candidates:
            continue
        pick = min(
            candidates,
            key=lambda e: (
                abs(e["daysToExpiry"] - target),
                -e["nearAtmContracts"],
                e["expirationDate"],
            ),
        )
        add(pick["expirationDate"])

    if len(selected) > MAX_ANCHOR_EXPIRATIONS:
        protected = {front["expirationDate"]} if front is not None else set()
        if req_entry is not None:
            protected.add(req_entry["expirationDate"])
        dte_of = {e["expirationDate"]: e["daysToExpiry"] for e in entries}
        droppable = sorted(
            (d for d in selected if d not in protected),
            key=lambda d: (-dte_of.get(d, math.nan), d),
        )
        while len(selected) > MAX_ANCHOR_EXPIRATIONS and droppable:
            selected.remove(droppable.pop(0))

    return sorted(selected)


# ---------------------------------------------------------------------------
# 3) Fusión catálogo + cargados
# ---------------------------------------------------------------------------


def merge_us_option_expiry_catalog(
    catalog: list[dict[str, Any]],
    loaded: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    loaded_by_date = {e["expirationDate"]: e for e in loaded}
    merged: dict[str, dict[str, Any]] = {}

    for entry in catalog:
        date = entry["expirationDate"]
        loaded_entry = loaded_by_date.pop(date, None)
        if loaded_entry is not None:
            days = loaded_entry["daysToExpiry"]
            if not math.isfinite(days):
                days = entry["daysToExpiry"]
            merged[date] = {
                "expirationDate": date,
                "daysToExpiry": days,
                "loaded": True,
                "validCallCount": loaded_entry["validCallCount"],
                "validPutCount": loaded_entry["validPutCount"],
                "nearAtmLiquidity": loaded_entry["nearAtmLiquidity"],
                "inDefaultWindow": loaded_entry["inDefaultWindow"],
                "hasCompleteAtmChain": loaded_entry["hasCompleteAtmChain"],
            }
        else:
            days = entry["daysToExpiry"]
            merged[date] = {
                "expirationDate": date,
                "daysToExpiry": days,
                "loaded": False,
                "validCallCount": 0,
                "validPutCount": 0,
                "nearAtmLiquidity": 0,
                "inDefaultWindow": 14 <= days <= 45,
                "hasCompleteAtmChain": False,
            }

    for date, loaded_entry in loaded_by_date.items():
        merged[date] = {
            "expirationDate": date,
            "daysToExpiry": loaded_entry["daysToExpiry"],
            "loaded": True,
            "validCallCount": loaded_entry["validCallCount"],
            "validPutCount": loaded_entry["validPutCount"],
            "nearAtmLiquidity": loaded_entry["nearAtmLiquidity"],
            "inDefaultWindow": loaded_entry["inDefaultWindow"],
            "hasCompleteAtmChain": loaded_entry["hasCompleteAtmChain"],
        }

    return sorted(merged.values(), key=lambda r: r["expirationDate"])


# ---------------------------------------------------------------------------
# 4) TIR del encabezado y régimen / breaker sobre el vencimiento activo
# ---------------------------------------------------------------------------


def evaluate_active_expiry_header_tir(inp: dict[str, Any]) -> dict[str, Any]:
    active_dte = inp["activeDte"]
    blocked_short_dte = math.isfinite(active_dte) and active_dte < 3
    if blocked_short_dte:
        return {"blockedShortDte": True, "tirPct": math.nan}

    parity = inp.get("activeParity")
    active_id = inp.get("activeExpiryId")
    if (
        parity is not None
        and active_id is not None
        and parity.get("expiryCode") == active_id
        and isinstance(parity.get("medianMidTeaPct"), (int, float))
        and math.isfinite(parity["medianMidTeaPct"])
    ):
        return {"blockedShortDte": False, "tirPct": float(parity["medianMidTeaPct"])}

    synthetic = inp.get("activeExpirySyntheticRates")
    if (
        synthetic is not None
        and isinstance(synthetic.get("medianImpliedTna"), (int, float))
        and math.isfinite(synthetic["medianImpliedTna"])
    ):
        return {"blockedShortDte": False, "tirPct": float(synthetic["medianImpliedTna"]) * 100.0}

    return {"blockedShortDte": False, "tirPct": math.nan}


def short_premium_breaker(
    dte: float,
    spot: float,
    put_wall: float | None,
    net_gex: float,
) -> bool:
    short_dte = math.isfinite(dte) and dte <= 1
    short_gamma = (
        put_wall is not None
        and math.isfinite(put_wall)
        and math.isfinite(spot)
        and math.isfinite(net_gex)
        and spot < put_wall
        and net_gex < 0
    )
    return short_dte or short_gamma


def recompute_regime_code(
    iv_pct: float | None,
    rv_pct: float | None,
    dte: float,
    spot: float,
    put_wall: float | None,
    net_gex: float | None,
) -> str:
    """Reproduce el tramo VRP de `computeActiveExpiryVrpAndRegime` con serie
    histórica vacía y sin IV rank (los únicos insumos usados por estos casos)."""
    if not (isinstance(iv_pct, (int, float)) and math.isfinite(iv_pct) and iv_pct > 0):
        return "NO_DATA"
    if not (isinstance(rv_pct, (int, float)) and math.isfinite(rv_pct) and rv_pct > 0):
        return "NO_DATA"
    vrp = iv_pct - rv_pct
    if vrp > 5:
        raw = "VENTA_PRIMA_CUBIERTA"
    elif vrp < -3:
        raw = "COMPRA_CONVEXIDAD_CALENDAR"
    else:
        raw = "NEUTRAL_SELECTIVO"
    blocked = short_premium_breaker(
        dte,
        spot,
        put_wall,
        net_gex if isinstance(net_gex, (int, float)) else math.nan,
    )
    if raw == "VENTA_PRIMA_CUBIERTA" and blocked:
        return "NO_SHORT_PREMIUM_RISK"
    return raw


def evaluate_active_expiry_regime_and_breaker(inp: dict[str, Any]) -> dict[str, Any]:
    exposure = inp.get("activeExposureSummary")
    put_wall = exposure.get("putWallStrike") if exposure is not None else None
    net_gex = exposure.get("netGex") if exposure is not None else None
    blocked = short_premium_breaker(
        inp["activeDte"],
        inp["spot"],
        put_wall,
        net_gex if isinstance(net_gex, (int, float)) else math.nan,
    )

    precomputed = inp.get("precomputedRegimeForActiveExpiry")
    coherent = precomputed is not None and not (
        precomputed == "NO_SHORT_PREMIUM_RISK" and not blocked
    )
    if coherent:
        base = precomputed
    else:
        fallback = inp["fallbackRegimeInput"]
        base = recompute_regime_code(
            fallback.get("ivAtmActiveExpiryPct"),
            fallback.get("rvReferencePct"),
            inp["activeDte"],
            inp["spot"],
            put_wall,
            net_gex,
        )
    if blocked and base == "VENTA_PRIMA_CUBIERTA":
        active = "NO_SHORT_PREMIUM_RISK"
    else:
        active = base
    return {
        "blocked": blocked,
        "autoSelectCreditMode": not blocked,
        "baseRegimeCode": base,
        "activeRegimeCode": active,
    }


# ---------------------------------------------------------------------------
# Construcción de casos
# ---------------------------------------------------------------------------


def build_contracts(
    dates: list[tuple[str, int, int]],
    spot: float,
    now_sec: int,
    strike_base: float = 600.0,
) -> list[dict[str, Any]]:
    """`dates`: (fecha, dte, cantidad de strikes cerca de ATM)."""
    contracts: list[dict[str, Any]] = []
    for date, _dte, near_count in dates:
        expiry = expiry_utc_sec(date)
        for i in range(near_count):
            strike = round(strike_base + (i - near_count // 2) * 1.0, 2)
            contracts.append(
                {
                    "ticker": f"O:SPY{date.replace('-', '')[2:]}C{int(round(strike * 1000)):08d}",
                    "contractType": "call",
                    "expirationDate": date,
                    "expiryUtcSec": expiry,
                    "strikePrice": strike,
                }
            )
        # Contrato lejano (±35 % del spot) que NO cuenta para nearAtmContracts.
        far_strike = round(strike_base * 1.35, 2)
        contracts.append(
            {
                "ticker": f"O:SPY{date.replace('-', '')[2:]}C{int(round(far_strike * 1000)):08d}",
                "contractType": "call",
                "expirationDate": date,
                "expiryUtcSec": expiry,
                "strikePrice": far_strike,
            }
        )
    return contracts


CATALOG_SPEC: tuple[tuple[str, int, int], ...] = (
    ("2026-01-05", 0, 8),
    ("2026-01-06", 1, 6),
    ("2026-01-07", 2, 6),
    ("2026-01-08", 3, 7),
    ("2026-01-09", 4, 7),
    ("2026-01-12", 7, 9),
    ("2026-01-13", 8, 8),
    ("2026-01-14", 9, 8),
    ("2026-01-15", 10, 6),
    ("2026-01-16", 11, 10),
    ("2026-01-20", 15, 7),
    ("2026-01-23", 18, 8),
    ("2026-01-30", 25, 11),
    ("2026-01-31", 26, 9),
    ("2026-02-04", 30, 12),
    ("2026-02-06", 32, 8),
    ("2026-02-13", 39, 6),
    ("2026-02-20", 46, 9),
    ("2026-02-27", 53, 7),
    ("2026-03-06", 60, 13),
    ("2026-03-13", 67, 8),
    ("2026-03-20", 74, 9),
    ("2026-03-27", 81, 7),
    ("2026-04-06", 91, 12),
    ("2026-04-17", 102, 8),
    ("2026-05-15", 130, 9),
    ("2026-06-18", 164, 7),
    ("2026-06-19", 165, 10),
    ("2026-07-17", 193, 8),
    ("2026-08-21", 228, 7),
    ("2026-09-18", 256, 8),
    ("2026-12-18", 347, 9),
    ("2027-01-15", 375, 7),
    ("2027-06-17", 528, 8),
    ("2027-12-17", 711, 6),
    ("2028-01-21", 746, 9),
)

SPOT = 600.0


def build_expiry_catalog_cases() -> list[dict[str, Any]]:
    dates = [(d, dte, near) for d, dte, near in CATALOG_SPEC]
    contracts = build_contracts(dates, SPOT, NOW_SEC)
    # Duplicados de la misma fecha (mismos strikes repetidos) para deduplicación.
    contracts.extend(
        [
            {
                "ticker": "O:SPY260112C00600000",
                "contractType": "call",
                "expirationDate": "2026-01-12",
                "expiryUtcSec": expiry_utc_sec("2026-01-12"),
                "strikePrice": 600.0,
            },
            {
                "ticker": "O:SPY260112C00601000",
                "contractType": "call",
                "expirationDate": "2026-01-12",
                "expiryUtcSec": expiry_utc_sec("2026-01-12"),
                "strikePrice": 601.0,
            },
        ]
    )
    # Fecha vencida (debe quedar fuera) y fecha inválida (debe quedar fuera).
    contracts.append(
        {
            "ticker": "O:SPY251219C00600000",
            "contractType": "call",
            "expirationDate": "2025-12-19",
            "expiryUtcSec": expiry_utc_sec("2025-12-19"),
            "strikePrice": 600.0,
        }
    )
    contracts.append(
        {
            "ticker": "O:SPY-BAD",
            "contractType": "call",
            "expirationDate": "2026-1-9",
            "expiryUtcSec": expiry_utc_sec("2026-01-09"),
            "strikePrice": 600.0,
        }
    )

    expected = extract_us_expiry_catalog(contracts, SPOT, NOW_SEC)
    return [
        {
            "name": "catalogo_completo_0dte_a_leaps_746d",
            "spot": SPOT,
            "nowSec": NOW_SEC,
            "contracts": contracts,
            "expected": expected,
        },
        {
            "name": "spot_no_finito_sin_conteo_atm",
            "spot": "NaN",
            "nowSec": NOW_SEC,
            "contracts": build_contracts(CATALOG_SPEC[:6], math.nan, NOW_SEC),
            "expected": extract_us_expiry_catalog(
                build_contracts(CATALOG_SPEC[:6], math.nan, NOW_SEC), math.nan, NOW_SEC
            ),
        },
    ]


def build_anchor_selection_cases() -> list[dict[str, Any]]:
    main_catalog = [
        {"expirationDate": d, "daysToExpiry": dte, "nearAtmContracts": near}
        for d, dte, near in CATALOG_SPEC
    ]
    # Catálogo con empate exacto en |dte - 28| y |dte - 7| para desempates.
    tie_catalog = [
        {"expirationDate": "2026-01-05", "daysToExpiry": 0, "nearAtmContracts": 8},
        {"expirationDate": "2026-01-10", "daysToExpiry": 5, "nearAtmContracts": 6},
        {"expirationDate": "2026-01-14", "daysToExpiry": 9, "nearAtmContracts": 6},
        {"expirationDate": "2026-01-31", "daysToExpiry": 26, "nearAtmContracts": 9},
        {"expirationDate": "2026-02-04", "daysToExpiry": 30, "nearAtmContracts": 12},
        {"expirationDate": "2026-02-25", "daysToExpiry": 51, "nearAtmContracts": 7},
        {"expirationDate": "2026-03-25", "daysToExpiry": 79, "nearAtmContracts": 7},
        {"expirationDate": "2026-04-06", "daysToExpiry": 91, "nearAtmContracts": 8},
        {"expirationDate": "2026-06-19", "daysToExpiry": 165, "nearAtmContracts": 10},
        {"expirationDate": "2026-07-17", "daysToExpiry": 193, "nearAtmContracts": 10},
    ]
    return [
        {
            "name": "anclas_completas_6_sin_requested",
            "catalog": main_catalog,
            "requested": None,
            "expected": select_anchor_us_expirations(main_catalog, None),
        },
        {
            "name": "requested_leaps_2028_fuera_de_buckets_desplaza_al_ancla_180d",
            "catalog": main_catalog,
            "requested": "2028-01-21",
            "expected": select_anchor_us_expirations(main_catalog, "2028-01-21"),
        },
        {
            "name": "requested_dentro_de_bucket_no_duplica",
            "catalog": main_catalog,
            "requested": "2026-03-06",
            "expected": select_anchor_us_expirations(main_catalog, "2026-03-06"),
        },
        {
            "name": "desempates_por_nearAtm_y_fecha",
            "catalog": tie_catalog,
            "requested": None,
            "expected": select_anchor_us_expirations(tie_catalog, None),
        },
        {
            "name": "catalogo_vacio",
            "catalog": [],
            "requested": None,
            "expected": [],
        },
        {
            "name": "catalogo_solo_front",
            "catalog": [{"expirationDate": "2026-01-05", "daysToExpiry": 0, "nearAtmContracts": 1}],
            "requested": None,
            "expected": ["2026-01-05"],
        },
    ]


def build_merge_cases() -> list[dict[str, Any]]:
    catalog = [
        {"expirationDate": d, "daysToExpiry": dte, "nearAtmContracts": near}
        for d, dte, near in CATALOG_SPEC[:12]
    ] + [
        {"expirationDate": "2028-01-21", "daysToExpiry": 746, "nearAtmContracts": 9},
    ]
    loaded = [
        {
            "expirationDate": "2026-01-05",
            "daysToExpiry": 0,
            "validCallCount": 40,
            "validPutCount": 38,
            "nearAtmLiquidity": 120000,
            "inDefaultWindow": False,
            "hasCompleteAtmChain": True,
        },
        {
            "expirationDate": "2026-01-12",
            "daysToExpiry": 7,
            "validCallCount": 62,
            "validPutCount": 60,
            "nearAtmLiquidity": 210000,
            "inDefaultWindow": False,
            "hasCompleteAtmChain": True,
        },
        {
            "expirationDate": "2026-02-04",
            "daysToExpiry": 30,
            "validCallCount": 88,
            "validPutCount": 86,
            "nearAtmLiquidity": 350000,
            "inDefaultWindow": True,
            "hasCompleteAtmChain": True,
        },
        {
            # Fecha pedida on-demand que no estaba en el catálogo cacheado.
            "expirationDate": "2029-06-15",
            "daysToExpiry": 1257,
            "validCallCount": 12,
            "validPutCount": 10,
            "nearAtmLiquidity": 4000,
            "inDefaultWindow": False,
            "hasCompleteAtmChain": False,
        },
    ]
    return [
        {
            "name": "fusion_catalogo_completo_con_4_cargadas",
            "catalog": catalog,
            "loaded": loaded,
            "expected": merge_us_option_expiry_catalog(catalog, loaded),
        },
        {
            "name": "fusion_sin_cargadas",
            "catalog": catalog,
            "loaded": [],
            "expected": merge_us_option_expiry_catalog(catalog, []),
        },
        {
            "name": "fusion_sin_catalogo_solo_cargadas",
            "catalog": [],
            "loaded": loaded[:2],
            "expected": merge_us_option_expiry_catalog([], loaded[:2]),
        },
    ]


def build_active_expiry_tir_cases() -> list[dict[str, Any]]:
    def case(
        name: str,
        active_dte: float,
        active_id: str | None,
        parity: dict[str, Any] | None,
        synthetic: dict[str, Any] | None,
    ) -> dict[str, Any]:
        inp = {
            "activeDte": active_dte,
            "activeExpiryId": active_id,
            "activeParity": parity,
            "activeExpirySyntheticRates": synthetic,
        }
        return {"name": name, "input": inp, "expected": evaluate_active_expiry_header_tir(inp)}

    return [
        case(
            "front_0dte_activo_30dte_paridad_propia_visible",
            30,
            "2026-02-04",
            {"expiryCode": "2026-02-04", "medianMidTeaPct": 4.35, "impliedRateStatus": "OK"},
            {"medianImpliedTna": 0.0425, "impliedRateStatus": "OK"},
        ),
        case(
            "activo_2dte_bloqueada_por_dte",
            2,
            "2026-01-07",
            {"expiryCode": "2026-01-07", "medianMidTeaPct": 4.4, "impliedRateStatus": "OK"},
            {"medianImpliedTna": 0.044, "impliedRateStatus": "OK"},
        ),
        case(
            "activo_1dte_bloqueada_por_dte",
            1,
            "2026-01-06",
            {"expiryCode": "2026-01-06", "medianMidTeaPct": 4.4, "impliedRateStatus": "OK"},
            None,
        ),
        case(
            "activo_0dte_bloqueada_por_dte",
            0,
            "2026-01-05",
            {"expiryCode": "2026-01-05", "medianMidTeaPct": 4.4, "impliedRateStatus": "BLOCKED_SHORT_DTE"},
            {"medianImpliedTna": 0.044, "impliedRateStatus": "BLOCKED_SHORT_DTE"},
        ),
        case(
            "paridad_de_otro_vencimiento_ignorada_y_sin_synthetic",
            30,
            "2026-02-04",
            {"expiryCode": "2026-01-05", "medianMidTeaPct": 3.9, "impliedRateStatus": "BLOCKED_SHORT_DTE"},
            None,
        ),
        case(
            "paridad_ausente_usa_synthetic_del_activo",
            30,
            "2026-02-04",
            None,
            {"medianImpliedTna": 0.041, "impliedRateStatus": "OK"},
        ),
        case(
            "dte_no_finito_no_bloquea",
            math.nan,
            "2026-02-04",
            {"expiryCode": "2026-02-04", "medianMidTeaPct": 4.5, "impliedRateStatus": "OK"},
            None,
        ),
    ]


def build_active_expiry_regime_cases() -> list[dict[str, Any]]:
    def case(
        name: str,
        active_dte: float,
        active_id: str | None,
        spot: float,
        put_wall: float | None,
        net_gex: float | None,
        precomputed: str | None,
        iv_pct: float | None,
        rv_pct: float | None,
    ) -> dict[str, Any]:
        inp = {
            "activeDte": active_dte,
            "activeExpiryId": active_id,
            "spot": spot,
            "activeExposureSummary": {"putWallStrike": put_wall, "netGex": net_gex},
            "precomputedRegimeForActiveExpiry": precomputed,
            "fallbackRegimeInput": {
                "ivAtmActiveExpiryPct": iv_pct,
                "rvReferencePct": rv_pct,
                "rvReferenceLabel": "RV23d",
            },
        }
        return {
            "name": name,
            "input": inp,
            "expected": evaluate_active_expiry_regime_and_breaker(inp),
        }

    return [
        case(
            "front_0dte_activo_30dte_sobre_put_wall_precomputed_coherente",
            30,
            "2026-02-04",
            600.0,
            570.0,
            1200.0,
            "VENTA_PRIMA_CUBIERTA",
            25.0,
            18.0,
        ),
        case(
            "activo_2dte_sin_bloqueo_de_venta_de_prima",
            2,
            "2026-01-07",
            600.0,
            570.0,
            900.0,
            None,
            22.0,
            20.0,
        ),
        case(
            "activo_0dte_bloqueado_por_dte",
            0,
            "2026-01-05",
            600.0,
            570.0,
            900.0,
            None,
            30.0,
            18.0,
        ),
        case(
            "activo_1dte_bloqueado_por_dte",
            1,
            "2026-01-06",
            600.0,
            570.0,
            900.0,
            None,
            30.0,
            18.0,
        ),
        case(
            "activo_30dte_short_gamma_bajo_put_wall_bloquea_sin_ser_0dte",
            30,
            "2026-02-04",
            555.0,
            570.0,
            -900.0,
            None,
            25.0,
            18.0,
        ),
        case(
            "precomputed_no_short_incoherente_se_recalcula_sobre_el_activo",
            30,
            "2026-02-04",
            600.0,
            570.0,
            500.0,
            "NO_SHORT_PREMIUM_RISK",
            25.0,
            18.0,
        ),
        case(
            "precomputed_compra_convexidad_coherente_se_conserva",
            30,
            "2026-02-04",
            600.0,
            570.0,
            500.0,
            "COMPRA_CONVEXIDAD_CALENDAR",
            15.0,
            22.0,
        ),
        case(
            "sin_iv_ni_rv_regime_no_data",
            30,
            "2026-02-04",
            600.0,
            570.0,
            500.0,
            None,
            None,
            None,
        ),
    ]


def json_sanitize(value: Any) -> Any:
    if isinstance(value, float):
        if math.isnan(value):
            return "NaN"
        if math.isinf(value):
            return "Infinity" if value > 0 else "-Infinity"
        return value
    if isinstance(value, dict):
        return {k: json_sanitize(v) for k, v in value.items()}
    if isinstance(value, list):
        return [json_sanitize(v) for v in value]
    return value


def main() -> None:
    fixture = {
        "meta": {
            "generator": "tools/generate_pieza50_2_reference.py",
            "tolerance": 1e-9,
            "nowSec": NOW_SEC,
            "todayEt": TODAY_ET,
        },
        "expiryCatalogCases": build_expiry_catalog_cases(),
        "anchorSelectionCases": build_anchor_selection_cases(),
        "expiryCatalogMergeCases": build_merge_cases(),
        "activeExpiryTirCases": build_active_expiry_tir_cases(),
        "activeExpiryRegimeCases": build_active_expiry_regime_cases(),
    }
    out_path = Path(__file__).resolve().parent.parent / "fixtures" / "options_pieza50_2_reference.json"
    out_path.write_text(json.dumps(json_sanitize(fixture), indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"fixture escrita: {out_path}")
    print(f"  expiryCatalogCases: {len(fixture['expiryCatalogCases'])}")
    print(f"  anchorSelectionCases: {len(fixture['anchorSelectionCases'])}")
    print(f"  expiryCatalogMergeCases: {len(fixture['expiryCatalogMergeCases'])}")
    print(f"  activeExpiryTirCases: {len(fixture['activeExpiryTirCases'])}")
    print(f"  activeExpiryRegimeCases: {len(fixture['activeExpiryRegimeCases'])}")
    print(f"  fechas catalogadas: {len(fixture['expiryCatalogCases'][0]['expected'])}")


if __name__ == "__main__":
    main()
