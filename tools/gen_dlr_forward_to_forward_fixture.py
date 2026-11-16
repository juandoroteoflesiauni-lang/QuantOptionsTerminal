#!/usr/bin/env python3
"""Independent Python reference generator for DLR forward-to-forward rates.

Generates fixtures/dlr_forward_to_forward_reference.json.

Formula (explicit, not imported from TypeScript):
    f_{i,i+1} = ln(P_far / P_near) / ((days_far - days_near) / 365) * 100

Returns null when any input is missing/non-finite, when a price is not strictly
positive, or when the far leg does not advance in time. The TypeScript contract
maps these nulls to NaN.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any


def evaluate(case: dict[str, Any]) -> float | None:
    near_days = case.get("nearDays")
    near_price = case.get("nearPrice")
    far_days = case.get("farDays")
    far_price = case.get("farPrice")

    def is_finite_number(value: Any) -> bool:
        return (
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(float(value))
        )

    if not (
        is_finite_number(near_days)
        and is_finite_number(far_days)
        and is_finite_number(near_price)
        and is_finite_number(far_price)
    ):
        return None
    if float(near_price) <= 0.0 or float(far_price) <= 0.0:
        return None
    delta_days = float(far_days) - float(near_days)
    if delta_days <= 0.0:
        return None

    log_ratio = math.log(float(far_price) / float(near_price))
    return (log_ratio / (delta_days / 365.0)) * 100.0


def main() -> None:
    cases = [
        {
            "id": "nov26_to_dic26_contango",
            "input": {
                "nearDays": 16,
                "nearPrice": 1562.5,
                "farDays": 46,
                "farPrice": 1595.5,
            },
        },
        {
            "id": "dic26_to_ene27_contango",
            "input": {
                "nearDays": 46,
                "nearPrice": 1595.5,
                "farDays": 76,
                "farPrice": 1624.0,
            },
        },
        {
            "id": "ene27_to_feb27_flat_curve",
            "input": {
                "nearDays": 76,
                "nearPrice": 1624.0,
                "farDays": 106,
                "farPrice": 1624.0,
            },
        },
        {
            "id": "inverted_curve_backwardation",
            "input": {
                "nearDays": 16,
                "nearPrice": 1600.0,
                "farDays": 46,
                "farPrice": 1560.0,
            },
        },
        {
            "id": "non_integer_days",
            "input": {
                "nearDays": 15.5,
                "nearPrice": 1558.25,
                "farDays": 45.75,
                "farPrice": 1601.75,
            },
        },
        {
            "id": "near_price_zero_returns_null",
            "input": {
                "nearDays": 16,
                "nearPrice": 0.0,
                "farDays": 46,
                "farPrice": 1595.5,
            },
        },
        {
            "id": "far_price_negative_returns_null",
            "input": {
                "nearDays": 16,
                "nearPrice": 1562.5,
                "farDays": 46,
                "farPrice": -1595.5,
            },
        },
        {
            "id": "same_maturity_returns_null",
            "input": {
                "nearDays": 46,
                "nearPrice": 1595.5,
                "farDays": 46,
                "farPrice": 1624.0,
            },
        },
        {
            "id": "far_before_near_returns_null",
            "input": {
                "nearDays": 46,
                "nearPrice": 1595.5,
                "farDays": 16,
                "farPrice": 1562.5,
            },
        },
        {
            "id": "missing_far_price_returns_null",
            "input": {
                "nearDays": 16,
                "nearPrice": 1562.5,
                "farDays": 46,
                "farPrice": None,
            },
        },
    ]

    for case in cases:
        case["expected"] = evaluate(case["input"])

    payload = {"schemaVersion": 1, "forwardToForwardCases": cases}
    out_path = Path("fixtures/dlr_forward_to_forward_reference.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {out_path} successfully.")


if __name__ == "__main__":
    main()
