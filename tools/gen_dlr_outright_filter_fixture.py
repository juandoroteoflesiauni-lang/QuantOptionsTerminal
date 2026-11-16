#!/usr/bin/env python3
"""
Referencia INDEPENDIENTE (Python) para el filtro de futuros outright de dólar
`DLR/MMMYY` de Primary (reMarkets). Implementación explícita, sin copiar la
lógica del código TypeScript: clasifica cada símbolo y decide si debe quedar
incluido en la suscripción WebSocket `smd`.

Genera: fixtures/dlr_outright_filter_reference.json
"""

from __future__ import annotations

import calendar
import datetime
import json
import pathlib
import re

MONTHS = {
    "ENE": 1, "JAN": 1,
    "FEB": 2,
    "MAR": 3,
    "ABR": 4, "APR": 4,
    "MAY": 5,
    "JUN": 6,
    "JUL": 7,
    "AGO": 8, "AUG": 8,
    "SEP": 9, "SET": 9,
    "OCT": 10,
    "NOV": 11,
    "DIC": 12, "DEC": 12,
}

OUTRIGHT_RE = re.compile(r"^DLR/([A-Z]{3})(\d{2})$")


def infer_maturity(symbol: str) -> str | None:
    """Último día hábil del mes `MMMYY` (YYYYMMDD); None si el símbolo no parsea."""
    m = OUTRIGHT_RE.match(symbol.strip().upper())
    if m is None:
        return None
    month = MONTHS.get(m.group(1))
    if month is None:
        return None
    year = 2000 + int(m.group(2))
    last_day = calendar.monthrange(year, month)[1]
    cursor = datetime.date(year, month, last_day)
    while cursor.weekday() >= 5:  # 5=sábado, 6=domingo
        cursor -= datetime.timedelta(days=1)
    return cursor.strftime("%Y%m%d")


def is_included(
    symbol: str,
    today_utc: str,
    detail_maturity: str | None,
) -> bool:
    """
    True si el símbolo debe suscribirse como futuro outright `DLR/MMMYY`.
    Excluye explícitamente: DLR/SPOT, minis (sufijo M), opciones (espacio + C/P),
    spreads/pases (segundo `/`), símbolos fuera del formato y vencidos.
    """
    clean = symbol.strip().upper()
    if clean == "DLR/SPOT":
        return False
    if " " in clean:
        return False
    if clean.count("/") != 1:
        return False
    if clean.endswith("M") and OUTRIGHT_RE.match(clean[:-1]) is not None:
        return False  # mini contrato DLR/MMMYYM
    if OUTRIGHT_RE.match(clean) is None:
        return False
    maturity = detail_maturity if detail_maturity else infer_maturity(clean)
    if maturity is not None and maturity < today_utc:
        return False
    return True


CASES: list[dict] = [
    # Outrights vigentes (incluir)
    {"symbol": "DLR/NOV26", "detailMaturity": None},
    {"symbol": "DLR/DIC26", "detailMaturity": None},
    {"symbol": "DLR/ENE27", "detailMaturity": None},
    {"symbol": "DLR/FEB27", "detailMaturity": None},
    {"symbol": "DLR/MAR27", "detailMaturity": None},
    {"symbol": "DLR/ABR27", "detailMaturity": None},
    {"symbol": "DLR/MAY27", "detailMaturity": None},
    {"symbol": "DLR/JUN27", "detailMaturity": None},
    {"symbol": "DLR/JUL27", "detailMaturity": None},
    {"symbol": "DLR/AGO27", "detailMaturity": None},
    {"symbol": "DLR/SEP27", "detailMaturity": None},
    {"symbol": "DLR/OCT27", "detailMaturity": None},
    # Minis (excluir)
    {"symbol": "DLR/DIC26M", "detailMaturity": None},
    {"symbol": "DLR/NOV26M", "detailMaturity": None},
    # Spot (excluir)
    {"symbol": "DLR/SPOT", "detailMaturity": None},
    # Opciones (excluir)
    {"symbol": "DLR/NOV26 1570 C", "detailMaturity": None},
    {"symbol": "DLR/ABR27 1800 P", "detailMaturity": None},
    # Spreads / pases (excluir)
    {"symbol": "DLR/NOV26/MAR27 M", "detailMaturity": None},
    {"symbol": "DLR/NOV26/MAR27", "detailMaturity": None},
    {"symbol": "DLR/DIC26 1500/T2", "detailMaturity": None},
    # Otros no-DLR o malformados (excluir)
    {"symbol": "GGAL/NOV26", "detailMaturity": None},
    {"symbol": "DLR", "detailMaturity": None},
    {"symbol": "DLR/", "detailMaturity": None},
    {"symbol": "DLR/XYZ26", "detailMaturity": None},
    {"symbol": "DLR/NOV2", "detailMaturity": None},
    {"symbol": "DLR/NOV266", "detailMaturity": None},
    # Vencidos (excluir vía detalle e inferencia)
    {"symbol": "DLR/OCT26", "detailMaturity": None},
    {"symbol": "DLR/ENE26", "detailMaturity": "20260130"},
    # Vencido con detalle desconocido y mes imposible
    {"symbol": "DLR/MAR26", "detailMaturity": None},
    # Detalle del exchange prevalece sobre inferencia: futuro vigente
    {"symbol": "DLR/JUN27", "detailMaturity": "20270630"},
    # Detalle del exchange prevalece: marcado vencido aunque la inferencia diga lo contrario
    {"symbol": "DLR/NOV26", "detailMaturity": "20260101"},
]

TODAY_UTC = "20261114"


def main() -> None:
    root = pathlib.Path(__file__).resolve().parents[1]
    fixture = {
        "schemaVersion": 1,
        "todayUtc": TODAY_UTC,
        "description": (
            "Referencia independiente del filtro outright DLR/MMMYY: "
            "isIncluded=false excluye SPOT/minis/opciones/spreads/pases/malformados/vencidos."
        ),
        "cases": [
            {
                "symbol": case["symbol"],
                "detailMaturity": case["detailMaturity"],
                "inferredMaturity": infer_maturity(case["symbol"]),
                "isIncluded": is_included(case["symbol"], TODAY_UTC, case["detailMaturity"]),
            }
            for case in CASES
        ],
    }
    out = root / "fixtures" / "dlr_outright_filter_reference.json"
    out.write_text(json.dumps(fixture, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"written {out} ({len(fixture['cases'])} cases)")


if __name__ == "__main__":
    main()
