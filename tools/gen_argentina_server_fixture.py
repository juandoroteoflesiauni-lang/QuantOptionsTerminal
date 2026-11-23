#!/usr/bin/env python3
"""Independent Python reference generator for Pieza 17 Argentina server math.

Generates fixtures/argentina_server_reference.json for:
1. Sovereign bond XIRR, Macaulay/Modified duration, accrued interest, and parity.
2. BYMA option symbol parser (standard, adjusted-decimal, and single/double-letter months).
3. BYMA option 21% IVA fee arithmetic per 100-share lot.
"""

from __future__ import annotations

import calendar
import datetime as dt
import json
import math
import re
from pathlib import Path
from typing import Any

AS_OF_UTC_SEC = 1741620000  # 2025-03-10T15:20:00Z


def iso_noon_utc_sec(date_str: str) -> int:
    year, month, day = (int(p) for p in date_str.split("-"))
    return int(dt.datetime(year, month, day, 12, 0, 0, tzinfo=dt.timezone.utc).timestamp())


def build_al29_flows() -> list[dict[str, float | int]]:
    flows: list[dict[str, float | int]] = []
    residual = 100.0
    y, m, d = 2025, 1, 9
    end_ts = dt.datetime(2029, 7, 9, 12, 0, 0, tzinfo=dt.timezone.utc).timestamp()
    while dt.datetime(y, m, d, 12, 0, 0, tzinfo=dt.timezone.utc).timestamp() <= end_ts + 1.0:
        coupon = residual * (0.01 / 2.0)
        amort = min(residual, 10.0)
        flows.append(
            {
                "dateUtcSec": iso_noon_utc_sec(f"{y:04d}-{m:02d}-{d:02d}"),
                "coupon": coupon,
                "amortization": amort,
            }
        )
        residual = max(0.0, residual - amort)
        m += 6
        if m > 12:
            m -= 12
            y += 1
    return flows


def evaluate_bond_reference(
    flows: list[dict[str, float | int]],
    market_price_usd: float,
    as_of_utc_sec: int,
) -> dict[str, float | None]:
    if not math.isfinite(market_price_usd) or market_price_usd <= 0.0:
        return {
            "tirPct": None,
            "parityPct": None,
            "duration": None,
            "accruedInterest": None,
        }

    future_flows = [f for f in flows if int(f["dateUtcSec"]) > as_of_utc_sec]
    past_flows = [f for f in flows if int(f["dateUtcSec"]) <= as_of_utc_sec]
    if not future_flows:
        return {
            "tirPct": None,
            "parityPct": None,
            "duration": None,
            "accruedInterest": None,
        }

    residual_principal = sum(float(f["amortization"]) for f in future_flows)
    if residual_principal <= 0.0:
        return {
            "tirPct": None,
            "parityPct": None,
            "duration": None,
            "accruedInterest": None,
        }

    next_flow = future_flows[0]
    prev_sec = (
        float(past_flows[-1]["dateUtcSec"])
        if past_flows
        else float(next_flow["dateUtcSec"]) - 182.5 * 86400.0
    )
    period_sec = max(86400.0, float(next_flow["dateUtcSec"]) - prev_sec)
    elapsed_sec = max(0.0, float(as_of_utc_sec) - prev_sec)
    accrued_interest = float(next_flow["coupon"]) * min(1.0, elapsed_sec / period_sec)

    technical_value = residual_principal + accrued_interest
    parity_pct = (market_price_usd / technical_value) * 100.0 if technical_value > 0.0 else None

    def year_frac(t_sec: int) -> float:
        return max(1.0 / 365.0, float(t_sec - as_of_utc_sec) / (365.0 * 86400.0))

    def npv_diff(y_rate: float) -> float:
        pv = 0.0
        for f in future_flows:
            t = year_frac(int(f["dateUtcSec"]))
            cf = float(f["coupon"]) + float(f["amortization"])
            pv += cf / math.pow(1.0 + y_rate, t)
        return pv - market_price_usd

    lo, hi = -0.5, 2.5
    f_lo = npv_diff(lo)
    f_hi = npv_diff(hi)
    if not math.isfinite(f_lo) or not math.isfinite(f_hi) or f_lo * f_hi > 0.0:
        return {
            "tirPct": None,
            "parityPct": parity_pct,
            "duration": None,
            "accruedInterest": accrued_interest,
        }

    for _ in range(80):
        mid = 0.5 * (lo + hi)
        f_mid = npv_diff(mid)
        if not math.isfinite(f_mid):
            break
        if abs(f_mid) < 1e-8 or (hi - lo) < 1e-8:
            lo = mid
            hi = mid
            break
        if f_lo * f_mid <= 0.0:
            hi = mid
            f_hi = f_mid
        else:
            lo = mid
            f_lo = f_mid

    yield_irr = 0.5 * (lo + hi)
    mac_weighted = 0.0
    total_pv = 0.0
    for f in future_flows:
        t = year_frac(int(f["dateUtcSec"]))
        pv = (float(f["coupon"]) + float(f["amortization"])) / math.pow(1.0 + yield_irr, t)
        mac_weighted += t * pv
        total_pv += pv

    mac_duration = mac_weighted / total_pv
    mod_duration = mac_duration / (1.0 + yield_irr)

    return {
        "tirPct": yield_irr * 100.0,
        "parityPct": parity_pct,
        "duration": mod_duration,
        "accruedInterest": accrued_interest,
    }


PREFIX_TO_UNDERLYING = {
    "GFG": "GGAL",
    "GGAL": "GGAL",
    "YPF": "YPFD",
    "YPFD": "YPFD",
    "PAM": "PAMP",
    "PAMP": "PAMP",
}

MONTH_CODES = {
    "EN": (1, "Ene", "EN"),
    "E": (1, "Ene", "EN"),
    "FE": (2, "Feb", "FE"),
    "F": (2, "Feb", "FE"),
    "MA": (3, "Mar", "MA"),
    "MR": (3, "Mar", "MA"),
    "M": (3, "Mar", "MA"),
    "AB": (4, "Abr", "AB"),
    "A": (4, "Abr", "AB"),
    "MY": (5, "May", "MY"),
    "Y": (5, "May", "MY"),
    "JU": (6, "Jun", "JU"),
    "JN": (6, "Jun", "JU"),
    "J": (6, "Jun", "JU"),
    "JL": (7, "Jul", "JL"),
    "L": (7, "Jul", "JL"),
    "AG": (8, "Ago", "AG"),
    "G": (8, "Ago", "AG"),
    "SE": (9, "Sep", "SE"),
    "S": (9, "Sep", "SE"),
    "OC": (10, "Oct", "OC"),
    "O": (10, "Oct", "OC"),
    "NO": (11, "Nov", "NO"),
    "N": (11, "Nov", "NO"),
    "DI": (12, "Dic", "DI"),
    "D": (12, "Dic", "DI"),
}

MONTHS_ES_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]


def third_friday_utc_sec(year: int, month: int) -> int:
    first_dow = dt.datetime(year, month, 1, 18, 30, 0, tzinfo=dt.timezone.utc).weekday()
    # Python weekday(): Monday=0 .. Friday=4
    days_to_first_friday = (4 - first_dow + 7) % 7
    third_friday_day = 1 + days_to_first_friday + 14
    return int(dt.datetime(year, month, third_friday_day, 18, 30, 0, tzinfo=dt.timezone.utc).timestamp())


def parse_byma_option_reference(
    raw_symbol: str,
    spot_hint: float | None,
    as_of_utc_sec: int,
) -> dict[str, Any] | None:
    _ = spot_hint  # A5: resolución determinista de strike sin heurística por precio spot
    cleaned = re.sub(r"[^A-Z0-9.]", "", raw_symbol.strip().upper())
    if len(cleaned) < 6:
        return None
    m = re.match(r"^([A-Z]{3,5})([CV])(\d+(?:\.\d+)?)([A-Z]{1,3})$", cleaned)
    if m is None:
        return None

    prefix, opt_char, strike_str, suffix = m.groups()
    underlying = PREFIX_TO_UNDERLYING.get(prefix)
    if underlying is None:
        return None

    contract_type = "call" if opt_char == "C" else "put"
    has_explicit_decimal = "." in strike_str
    if has_explicit_decimal:
        strike = float(strike_str)
        if not math.isfinite(strike) or strike <= 0.0:
            return None
    else:
        if strike_str.startswith("0"):
            return None
        raw_int = int(strike_str)
        if raw_int <= 0:
            return None
        token_len = len(strike_str)
        is_canonical_grid = (
            token_len <= 2
            or ((token_len in (3, 4)) and (raw_int % 10 == 0))
            or (token_len == 5 and (raw_int % 100 == 0))
            or (token_len >= 6 and (raw_int % 1000 == 0))
        )
        if not is_canonical_grid:
            return None
        strike = float(raw_int)

    month_info = MONTH_CODES.get(suffix[:2]) or MONTH_CODES.get(suffix[:1])
    if month_info is None or suffix not in MONTH_CODES:
        return None
    month_num, label, code = month_info

    as_of_dt = dt.datetime.fromtimestamp(as_of_utc_sec, tz=dt.timezone.utc)
    exp_sec = third_friday_utc_sec(as_of_dt.year, month_num)
    if exp_sec <= as_of_utc_sec - 86400:
        exp_sec = third_friday_utc_sec(as_of_dt.year + 1, month_num)
    if exp_sec <= as_of_utc_sec + 60:
        return None

    exp_dt = dt.datetime.fromtimestamp(exp_sec, tz=dt.timezone.utc)
    mon_short = MONTHS_ES_SHORT[exp_dt.month - 1]
    return {
        "symbol": cleaned,
        "underlying": underlying,
        "contractType": contract_type,
        "strike": round(strike * 100.0) / 100.0,
        "expiryCode": code,
        "expiryLabel": f"{exp_dt.day} {mon_short}",
        "expirationDate": exp_dt.strftime("%Y-%m-%d"),
        "expiryUtcSec": exp_sec,
        "daysToExpiry": max(1, round((exp_sec - as_of_utc_sec) / 86400.0)),
    }


def main() -> None:
    al29_flows = build_al29_flows()
    custom_flows = [
        {"dateUtcSec": iso_noon_utc_sec("2025-07-09"), "coupon": 2.5, "amortization": 20.0},
        {"dateUtcSec": iso_noon_utc_sec("2026-01-09"), "coupon": 2.0, "amortization": 80.0},
    ]

    bond_cases = [
        {
            "name": "AL29_step_down",
            "spec": {
                "baseTicker": "AL29",
                "name": "Bonar 2029 USD Ley Argentina",
                "legislation": "ARG",
                "maturity": "2029-07-09",
                "flows": al29_flows,
            },
            "marketPriceUsd": 68.5,
            "asOfUtcSec": AS_OF_UTC_SEC,
            "expected": evaluate_bond_reference(al29_flows, 68.5, AS_OF_UTC_SEC),
        },
        {
            "name": "CUSTOM_2FLOW",
            "spec": {
                "baseTicker": "TEST30",
                "name": "Test Sovereign 2-Flow",
                "legislation": "NY",
                "maturity": "2026-01-09",
                "flows": custom_flows,
            },
            "marketPriceUsd": 82.25,
            "asOfUtcSec": AS_OF_UTC_SEC,
            "expected": evaluate_bond_reference(custom_flows, 82.25, AS_OF_UTC_SEC),
        },
        {
            "name": "INVALID_ZERO_PRICE",
            "spec": {
                "baseTicker": "AL29",
                "name": "Bonar 2029 USD Ley Argentina",
                "legislation": "ARG",
                "maturity": "2029-07-09",
                "flows": al29_flows,
            },
            "marketPriceUsd": 0.0,
            "asOfUtcSec": AS_OF_UTC_SEC,
            "expected": evaluate_bond_reference(al29_flows, 0.0, AS_OF_UTC_SEC),
        },
    ]

    option_symbol_cases = [
        {
            "rawSymbol": "GFGC6000DI",
            "spotHint": 6400.0,
            "asOfUtcSec": AS_OF_UTC_SEC,
            "expected": parse_byma_option_reference("GFGC6000DI", 6400.0, AS_OF_UTC_SEC),
        },
        {
            "rawSymbol": "GFGV62974AB",
            "spotHint": 6400.0,
            "asOfUtcSec": AS_OF_UTC_SEC,
            "expected": parse_byma_option_reference("GFGV62974AB", 6400.0, AS_OF_UTC_SEC),
        },
        {
            "rawSymbol": "YPFC42000OC",
            "spotHint": 41500.0,
            "asOfUtcSec": AS_OF_UTC_SEC,
            "expected": parse_byma_option_reference("YPFC42000OC", 41500.0, AS_OF_UTC_SEC),
        },
        {
            "rawSymbol": "INVALID",
            "spotHint": 6400.0,
            "asOfUtcSec": AS_OF_UTC_SEC,
            "expected": parse_byma_option_reference("INVALID", 6400.0, AS_OF_UTC_SEC),
        },
    ]

    fee_cases = [
        {
            "fairPrice": price,
            "lotSize": 100,
            "optionsFeeRate": 0.0020,
            "vatRate": 0.21,
            "expectedCommissionWithVatArsPerLot": price * 100.0 * 0.0020 * 1.21,
        }
        for price in (142.5, 385.125, 12.75)
    ]

    payload = {
        "asOfUtcSec": AS_OF_UTC_SEC,
        "bondCases": bond_cases,
        "optionSymbolCases": option_symbol_cases,
        "feeCases": fee_cases,
    }

    out_path = Path(__file__).resolve().parent.parent / "fixtures" / "argentina_server_reference.json"
    out_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
