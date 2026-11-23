"""Generate offline IAMC/OI expectations with independent Python arithmetic."""
from calendar import FRIDAY, Calendar
from datetime import date, datetime, timezone
from decimal import Decimal, getcontext
import json
import math
from pathlib import Path

from gen_options_american_fixture import bs02_american_py


getcontext().prec = 50
REPORT = date(2026, 11, 16)
DECEMBER = [d for d in Calendar().itermonthdates(2026, 12) if d.month == 12 and d.weekday() == FRIDAY][2]
FEBRUARY = [d for d in Calendar().itermonthdates(2027, 2) if d.month == 2 and d.weekday() == FRIDAY][2]
DI = "GFGC6000DI 100 200 0 0"
FE = "GFGC6000FE 400 800 0 0"


def exposure(count: int, multiplier: int, side: str) -> dict:
    spot, strike, volatility, years = 6000, 6000, 0.44, 0.25
    # European closed-form gamma, also the non-dividend American call gamma.
    d1 = (math.log(spot / strike) + years * volatility ** 2 / 2) / (volatility * math.sqrt(years))
    gamma = math.exp(-d1 * d1 / 2) / (spot * volatility * math.sqrt(2 * math.pi * years))
    nominal = count * multiplier
    gex = Decimal(gamma) * Decimal(nominal) * Decimal(spot) ** 2 / 100
    return {
        "count": count, "multiplier": multiplier, "nominalShares": nominal, "side": side,
        "spot": spot, "strike": strike, "volatility": volatility, "years": years, "gamma": gamma,
        "gex": float(gex if side == "call" else -gex),
        "americanCallPrice": bs02_american_py(spot, strike, years, 0.0, 0.0, volatility, "call"),
    }


def build_reference() -> dict:
    by_expiry = {str(DECEMBER): 200, str(FEBRUARY): 800}
    date_keys = [REPORT, date(2026, 11, 17)]
    return {
        "asOfUtcSec": int(datetime(2026, 11, 16, 16, tzinfo=timezone.utc).timestamp()),
        "a1ExpiryIsolation": {
            "rawText": f"{DI}\n{FE}", "reportDate": str(REPORT), "byExpiry": by_expiry,
            "totalNominalByExpiry": {
                expiry: sum(map(int, line.split()[1:]))
                for expiry, line in zip(by_expiry, (DI, FE))
            },
        },
        "a1CallPutSameStrikeAndExpiry": {
            "rawText": f"{DI}\n{FE}\nGFGV6000DI 0 300 0 0\nGFGV6000FE 0 900 0 0",
            "uncoveredByExpiry": {str(DECEMBER): [200, 300], str(FEBRUARY): [800, 900]},
        },
        "a1MultiDateAndSeries": {
            "reportDates": list(map(str, date_keys)),
            "canonicalKeys": [
                f"BYMA_AR|GGAL|{DECEMBER}|call|{Decimal('6000') * 10000:.0f}|{d}" for d in date_keys
            ],
            "foreignLine": "YPFC40000DI 0 50 0 0",
            "errors": ["WRONG_REPORT_DATE", "WRONG_UNDERLYING"],
        },
        "a1MissingOrAmbiguousExpiry": {
            "rawText": f"{DI}\nGFGC6000 0 9 0 0\nGFGC6000ZZ 0 9 0 0\n"
                       "GFGC6000DICA 0 9 0 0\nCALL 6000 0 9 0 0",
            "errors": [
                "MISSING_EXPIRY_SUFFIX", "AMBIGUOUS_EXPIRY_SUFFIX",
                "AMBIGUOUS_EXPIRY_SUFFIX", "MISSING_EXPIRY_CONTEXT",
            ],
            "unknownTarget": "AB",
        },
        "a1Duplicates": {
            "identical": f"{DI}\n{DI}",
            "conflicting": f"{DI}\nGFGC6000DI 100 350 0 0",
            "nominal": 200, "duplicateCount": 1, "conflictCode": "DUPLICATE_CONFLICTING_SERIES",
        },
        "a1IamcSharesUnitNoDoubleMult": exposure(200, 1, "call"),
        "a2DirectContractOiMultiplier": [exposure(250, 100, "call"), exposure(250, 10, "put")],
        "a2ObservedZeroOiVsMissing": [
            {"value": 0, "status": "DIRECT_CONTRACT_OI", "netGex": 0, "gexStatus": "VALID_CONTRACT_OI",
             "direct": 1, "zero": 1, "missing": 0},
            {"value": None, "status": "MISSING_OI", "netGex": None, "gexStatus": "UNAVAILABLE_MISSING_OI",
             "direct": 0, "zero": 0, "missing": 1},
        ],
        "a2BmbL1MergeNoContamination": {
            "feedVolume": 250, "overlayVolume": 5, "openInterest": None, "netGex": None,
            "gexStatus": "UNAVAILABLE_MISSING_OI", "direct": 0, "proxy": 0, "oiProxy": None,
        },
        "a2ExplicitProxyOptIn": {
            "gexStatus": "ESTIMATED_PROXY_OPT_IN", "direct": 0, "proxy": 1, "oiProxy": True,
            "nominalShares": 5 * 100,
        },
        "a2SourceConflictPrecedence": {"iamc": 20000, "data912Contracts": 250, "data912Shares": 250 * 100},
        "gexPartialAndInvalid": {
            "partial": {"gexStatus": "PARTIAL_COVERAGE", "coverage": float(Decimal(2) / 4), "direct": 2, "missing": 2},
            "invalid": {"value": -10, "reason": "NEGATIVE_OI", "gexStatus": "INVALID_DATA_OR_MODEL"},
        },
    }


if __name__ == "__main__":
    fixture = Path(__file__).resolve().parents[1] / "fixtures" / "ggal_pieza_a1_a2_reference.json"
    fixture.write_text(json.dumps(build_reference(), indent=2) + "\n", encoding="utf-8")
