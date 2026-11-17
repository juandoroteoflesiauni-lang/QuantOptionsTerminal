#!/usr/bin/env python3
"""Referencia INDEPENDIENTE para Pieza 36 (escala USD, verticales, flujo y vencimientos).

Genera fixtures/options_usd_scale_flow_reference.json.
- Las primas son por acción. El multiplicador OCC (100) nunca altera strike/prima.
- La normal CDF usa math.erf, sin copiar la implementación TypeScript.
- La selección de vencimientos es una referencia explícita del ranking 14–45 DTE.
"""

import json
import math
from pathlib import Path

FIXTURE_PATH = Path(__file__).resolve().parents[1] / "fixtures" / "options_usd_scale_flow_reference.json"


def norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def vertical_reference(case: dict) -> dict:
    """Réplica aritmética directa: no reutiliza código del producto."""
    side = case["side"]
    long_leg = case["long_leg"]
    short_leg = case["short_leg"]
    spot = case["spot"]
    days = case["days_to_expiry"]
    rate = case["rate_dec"]
    sigma = case["atm_iv_dec"]

    # Compra: ask > last > bid. Venta: bid > last > ask. Sin fallback silencioso.
    long_price_candidates = [long_leg["ask"], long_leg["last"], long_leg["bid"]]
    short_price_candidates = [short_leg["bid"], short_leg["last"], short_leg["ask"]]
    long_price = next((p for p in long_price_candidates if p is not None and p > 0), float("nan"))
    short_price = next((p for p in short_price_candidates if p is not None and p > 0), float("nan"))
    long_eod = long_price != long_leg["ask"]
    short_eod = short_price != short_leg["bid"]

    width = abs(short_leg["strike"] - long_leg["strike"])
    valid = (
        width > 0
        and math.isfinite(long_price)
        and math.isfinite(short_price)
        and (short_leg["strike"] > long_leg["strike"] if side == "CALL" else short_leg["strike"] < long_leg["strike"])
    )
    debit = long_price - short_price
    valid = valid and debit > 0 and debit < width
    if not valid:
        return {
            "valid": False,
            "width": width,
            "long_price": long_price,
            "short_price": short_price,
            "long_uses_eod_ref": long_eod,
            "short_uses_eod_ref": short_eod,
            "debit": debit,
            "max_profit": float("nan"),
            "reward_risk_ratio": float("nan"),
            "breakeven": float("nan"),
            "breakeven_dist_pct": float("nan"),
            "prob_at_breakeven_pct": float("nan"),
            "edge_pct": float("nan"),
        }

    max_profit = width - debit
    breakeven = long_leg["strike"] + debit if side == "CALL" else long_leg["strike"] - debit
    be_dist_pct = ((breakeven - spot) / spot) * 100.0
    t = days / 365.0
    d2 = (math.log(spot / breakeven) + (rate - 0.5 * sigma * sigma) * t) / (sigma * math.sqrt(t))
    prob = norm_cdf(d2) if side == "CALL" else norm_cdf(-d2)
    return {
        "valid": True,
        "width": width,
        "long_price": long_price,
        "short_price": short_price,
        "long_uses_eod_ref": long_eod,
        "short_uses_eod_ref": short_eod,
        "debit": debit,
        "max_profit": max_profit,
        "reward_risk_ratio": max_profit / debit,
        "breakeven": breakeven,
        "breakeven_dist_pct": be_dist_pct,
        "prob_at_breakeven_pct": prob * 100.0,
        "edge_pct": (prob - debit / width) * 100.0,
    }


def selection_reference(case: dict) -> dict:
    """Ranking determinista: 14–45 DTE completo, menor DTE, mayor liquidez ATM."""
    spot = case["spot"]
    candidates = []
    for raw in case["expirations"]:
        valid_calls = raw["valid_call_count"]
        valid_puts = raw["valid_put_count"]
        days = raw["days_to_expiry"]
        near_liquidity = raw["near_atm_liquidity"]
        complete = valid_calls >= 2 and valid_puts >= 2
        candidates.append(
            {
                "expiration_date": raw["expiration_date"],
                "days_to_expiry": days,
                "near_atm_liquidity": near_liquidity,
                "in_default_window": 14 <= days <= 45,
                "has_complete_atm_chain": complete,
            }
        )
    complete = [c for c in candidates if c["has_complete_atm_chain"]]
    windowed = sorted(
        [c for c in complete if c["in_default_window"]],
        key=lambda c: (c["days_to_expiry"], -c["near_atm_liquidity"]),
    )
    outside = sorted(
        [c for c in complete if not c["in_default_window"]],
        key=lambda c: (c["days_to_expiry"], -c["near_atm_liquidity"]),
    )
    ranked = windowed + outside
    requested = case.get("requested_expiration")
    if requested is not None and not any(c["expiration_date"] == requested for c in candidates):
        return {
            "default_expiration_date": ranked[0]["expiration_date"] if ranked else None,
            "prefetch_expiration_dates": [c["expiration_date"] for c in ranked[:2]],
            "reason": f"REQUESTED_EXPIRATION_NOT_AVAILABLE:{requested}",
        }
    default = next((c for c in ranked if requested is None or c["expiration_date"] == requested), None)
    if default is None:
        return {
            "default_expiration_date": None,
            "prefetch_expiration_dates": [],
            "reason": "NO_COMPLETE_ATM_OPTION_EXPIRY",
        }
    alternatives = sorted(
        [c for c in complete if c["expiration_date"] != default["expiration_date"]],
        key=lambda c: (-c["near_atm_liquidity"], c["days_to_expiry"]),
    )
    prefetch = [default["expiration_date"]]
    if alternatives:
        prefetch.append(alternatives[0]["expiration_date"])
    return {
        "default_expiration_date": default["expiration_date"],
        "prefetch_expiration_dates": prefetch,
        "reason": (
            "REQUESTED_EXPIRATION_SELECTED"
            if requested is not None
            else ("DEFAULT_LIQUID_14_45_DTE" if windowed else "FIRST_COMPLETE_ATM_EXPIRY")
        ),
    }


fixture = {
    "qqq": {
        "symbol": "QQQ",
        "spot": 663.16,
        "occ_contract_multiplier": 100,
        "expected_strikes_usd_1x": [660.0, 665.0, 670.0],
        "atm_iv_dec": 0.22,
        "days_to_expiry": 21,
        "rate_dec": 0.043,
        "bull_call_spread": vertical_reference(
            {
                "side": "CALL",
                "spot": 663.16,
                "days_to_expiry": 21,
                "rate_dec": 0.043,
                "atm_iv_dec": 0.22,
                "long_leg": {"strike": 660.0, "bid": 8.0, "ask": 8.2, "last": 8.1},
                "short_leg": {"strike": 665.0, "bid": 4.1, "ask": 4.3, "last": 4.2},
            }
        ),
        "bear_put_spread": vertical_reference(
            {
                "side": "PUT",
                "spot": 663.16,
                "days_to_expiry": 21,
                "rate_dec": 0.043,
                "atm_iv_dec": 0.22,
                "long_leg": {"strike": 665.0, "bid": 1.9, "ask": 2.1, "last": 2.0},
                "short_leg": {"strike": 660.0, "bid": 0.35, "ask": 0.55, "last": 0.45},
            }
        ),
    },
    "flow_fusion": {
        "massive_volume": 1250,
        "massive_open_interest": 8000,
        "tradier_volume": 0,
        "tradier_open_interest": 0,
        "expected_volume": 1250,
        "expected_open_interest": 8000,
        "larger_tradier_volume": 1875,
        "expected_volume_after_larger_tradier": 1875,
    },
    "occ_strike_validation": [
        {"occ_symbol": "O:QQQ260331C00660000", "raw_strike": 660.0, "accepted": True},
        {"occ_symbol": "O:QQQ260331C00660000", "raw_strike": 6600.0, "accepted": False},
        {"occ_symbol": "BADSYMBOL", "raw_strike": 660.0, "accepted": False},
    ],
    "expiry_selection": {
        "qqq": selection_reference(
            {
                "spot": 663.16,
                "expirations": [
                    {"expiration_date": "2025-03-12", "days_to_expiry": 2, "valid_call_count": 1, "valid_put_count": 0, "near_atm_liquidity": 300},
                    {"expiration_date": "2025-03-31", "days_to_expiry": 21, "valid_call_count": 6, "valid_put_count": 6, "near_atm_liquidity": 42000},
                ],
            }
        ),
        "prefetch": selection_reference(
            {
                "spot": 100.0,
                "expirations": [
                    {"expiration_date": "2026-01-05", "days_to_expiry": 3, "valid_call_count": 4, "valid_put_count": 4, "near_atm_liquidity": 100},
                    {"expiration_date": "2026-01-23", "days_to_expiry": 21, "valid_call_count": 8, "valid_put_count": 8, "near_atm_liquidity": 5000},
                    {"expiration_date": "2026-02-20", "days_to_expiry": 49, "valid_call_count": 8, "valid_put_count": 8, "near_atm_liquidity": 9000},
                ],
            }
        ),
        "requested_missing": selection_reference(
            {
                "spot": 100.0,
                "requested_expiration": "2099-01-01",
                "expirations": [
                    {"expiration_date": "2026-01-23", "days_to_expiry": 21, "valid_call_count": 8, "valid_put_count": 8, "near_atm_liquidity": 5000},
                ],
            }
        ),
    },
    "orats_ivrank": {
        "row": {
            "ticker": "QQQ",
            "tradeDate": "2025-03-10",
            "iv": 18.311,
            "ivRank1m": 7.25,
            "ivPct1m": 9.0,
            "ivRank1y": 17.49,
            "ivPct1y": 12.75,
            "updatedAt": "2025-03-10T20:55:02Z",
        }
    },
}


def write() -> None:
    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE_PATH.write_text(json.dumps(fixture, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {FIXTURE_PATH}")


if __name__ == "__main__":
    write()
