"""Independent Python reference generator for Pieza 8 (Unusual Options Trades)."""

from __future__ import annotations

import json
import math
from decimal import Decimal
from pathlib import Path
from typing import Any


def parse_sip_ns(raw_ns: int | str) -> tuple[int, int, str]:
    ns = int(raw_ns)
    assert ns >= 10**15, f"Expected nanoseconds >= 1e15, got {ns}"
    sec = ns // 1_000_000_000
    rem = ns % 1_000_000_000
    return sec, rem, str(ns)


def normalize_trade_ref(
    row: dict[str, Any],
    *,
    shares_by_ticker: dict[str, float] | None = None,
    default_shares: float | None = None,
) -> dict[str, Any]:
    sec, rem_ns, ns_str = parse_sip_ns(row["sip_timestamp"])
    ticker = str(row["ticker"]).strip()
    root = str(row["root"]).strip()
    underlying = str(row["underlying_ticker"]).strip() if row.get("underlying_ticker") else None
    price = float(row["price"])
    size = float(row["size"])

    is_binary = row.get("type") == "binary" or root.startswith("B1")
    is_adjusted = (not is_binary) and root[-1].isdigit()
    if is_binary:
        root_kind = "binary"
    elif is_adjusted:
        root_kind = "adjusted"
    elif underlying is not None and root != underlying:
        root_kind = "weekly_or_different"
    else:
        root_kind = "standard"

    spc: float | None = None
    if row.get("shares_per_contract") is not None:
        spc = float(row["shares_per_contract"])
    elif shares_by_ticker and ticker in shares_by_ticker:
        spc = float(shares_by_ticker[ticker])
    elif default_shares is not None and not is_adjusted and not is_binary:
        spc = float(default_shares)

    notional: float | None = None
    if spc is not None:
        notional = float(Decimal(str(price)) * Decimal(str(size)) * Decimal(str(spc)))

    flags = [str(f).strip().lower() for f in row.get("flags", [])]
    return {
        "time": sec,
        "subsecond": {
            "nanoseconds": rem_ns,
            "timestampNs": ns_str,
        },
        "ticker": ticker,
        "underlyingTicker": underlying,
        "root": root,
        "rootKind": root_kind,
        "price": price,
        "size": size,
        "sharesPerContract": spc,
        "notional": notional,
        "exchange": row.get("exchange"),
        "conditions": row.get("conditions", []),
        "flags": {
            "blockPremium": "block_premium" in flags,
            "blockSize": "block_size" in flags,
            "iso": "iso" in flags,
            "raw": flags,
        },
        "sequenceNumber": row.get("sequence_number"),
    }


def main() -> None:
    # Out-of-order raw pages covering SPX vs SPXW, GME vs GME1, binary B1SPY, string ns & numeric ns
    page1_rows: list[Any] = [
        {
            "ticker": "O:SPXW261218C05950000",
            "underlying_ticker": "SPX",
            "root": "SPXW",
            "price": 14.25,
            "size": 250,
            "shares_per_contract": 100,
            "exchange": 302,
            "conditions": [209, 219],
            "flags": ["block_premium", "iso"],
            "sip_timestamp": "1794580680500000123",
            "sequence_number": 9002,
        },
        {
            "ticker": "O:SPX261218P05900000",
            "underlying_ticker": "SPX",
            "root": "SPX",
            "price": 0.85,
            "size": 1200,
            "shares_per_contract": 100,
            "exchange": 300,
            "conditions": [209],
            "flags": ["block_size"],
            "sip_timestamp": 1794580680100000000,
            "sequence_number": 9001,
        },
        # Invalid row: timestamp in milliseconds (< 1e15 ns)
        {
            "ticker": "O:SPY261218C00600000",
            "underlying_ticker": "SPY",
            "root": "SPY",
            "price": 5.0,
            "size": 100,
            "sip_timestamp": 1794580680100,
            "flags": ["block_premium"],
        },
        # Invalid row: negative price
        {
            "ticker": "O:SPY261218C00600000",
            "underlying_ticker": "SPY",
            "root": "SPY",
            "price": -2.5,
            "size": 100,
            "sip_timestamp": 1794580680200000000,
            "flags": ["block_premium"],
        },
        # Invalid row: empty root
        {
            "ticker": "O:SPY261218C00600000",
            "underlying_ticker": "SPY",
            "root": "",
            "price": 5.0,
            "size": 100,
            "sip_timestamp": 1794580680300000000,
            "flags": ["block_premium"],
        },
    ]

    page2_rows: list[Any] = [
        # Duplicate of O:SPXW261218C05950000 (exact same ns + seq) -> must be discarded
        {
            "ticker": "O:SPXW261218C05950000",
            "underlying_ticker": "SPX",
            "root": "SPXW",
            "price": 14.25,
            "size": 250,
            "shares_per_contract": 100,
            "exchange": 302,
            "conditions": [209, 219],
            "flags": ["block_premium", "iso"],
            "sip_timestamp": "1794580680500000123",
            "sequence_number": 9002,
        },
        # Adjusted contract WITHOUT explicit shares_per_contract -> spc & notional remain null/NaN even with default_shares=100
        {
            "ticker": "O:GME1261218C00025000",
            "underlying_ticker": "GME",
            "root": "GME1",
            "price": 3.40,
            "size": 400,
            "exchange": 304,
            "conditions": [219],
            "flags": ["block_premium", "iso"],
            "sip_timestamp": "1794580679999999999",
            "sequence_number": 8999,
        },
        # Standard SPY trade without shares_per_contract (resolved when defaultSharesPerContract=100 is passed)
        {
            "ticker": "O:SPY261218C00600000",
            "underlying_ticker": "SPY",
            "root": "SPY",
            "price": 2.15,
            "size": 1500,
            "exchange": 309,
            "conditions": [209],
            "flags": ["block_premium", "block_size"],
            "sip_timestamp": "1794580681000000500",
            "sequence_number": 9010,
        },
        # Binary option trade
        {
            "ticker": "O:B1SPY261113C00710000",
            "underlying_ticker": "SPY",
            "root": "B1SPY",
            "type": "binary",
            "price": 0.45,
            "size": 2000,
            "shares_per_contract": 100,
            "exchange": 301,
            "conditions": [],
            "flags": ["block_size"],
            "sip_timestamp": "1794580682000000000",
            "sequence_number": 9020,
        },
        # Invalid size <= 0
        {
            "ticker": "O:QQQ261218C00500000",
            "underlying_ticker": "QQQ",
            "root": "QQQ",
            "price": 4.2,
            "size": 0,
            "sip_timestamp": 1794580683000000000,
            "flags": ["block_premium"],
        },
        # Invalid malformed row
        "corrupt-row",
    ]

    valid_raw_unfiltered = [
        page2_rows[1],  # 1794580679.999999999 GME1
        page1_rows[1],  # 1794580680.100000000 SPX
        page1_rows[0],  # 1794580680.500000123 SPXW
        page2_rows[2],  # 1794580681.000000500 SPY
        page2_rows[3],  # 1794580682.000000000 B1SPY
    ]

    # Case A: normalized with default_shares=100 (GME1 still has None/NaN because adjusted!)
    expected_default_100 = [normalize_trade_ref(r, default_shares=100) for r in valid_raw_unfiltered]
    known_notional_case_a = sum(t["notional"] for t in expected_default_100 if t["notional"] is not None)

    # Case B: enriched with explicit lookup shares_by_ticker for GME1 -> every trade has finite notional!
    lookup = {"O:GME1261218C00025000": 100.0}
    expected_with_lookup = [
        normalize_trade_ref(r, shares_by_ticker=lookup, default_shares=100)
        for r in valid_raw_unfiltered
    ]
    total_notional_case_b = sum(float(t["notional"]) for t in expected_with_lookup)

    # Case C: filtered strictly by root='SPXW', requiredFlags=['block_premium','iso'], mode='all'
    expected_spxw_iso_block = [
        t for t in expected_with_lookup
        if t["root"] == "SPXW" and t["flags"]["blockPremium"] and t["flags"]["iso"]
    ]

    # Split math reference cases for verify consistency
    split_cases = [
        {
            "description": "NVDA pre-2021-07-20 (both 4:1 and 10:1 splits apply -> historical_adjustment_factor=0.025)",
            "barDateEt": "2020-05-15",
            "raw": {"open": 340.0, "high": 350.0, "low": 330.0, "close": 344.0, "volume": 100000.0},
            "expectedFactor": 0.025,
            "expectedAdjusted": {
                "open": 340.0 * 0.025,
                "high": 350.0 * 0.025,
                "low": 330.0 * 0.025,
                "close": 344.0 * 0.025,
                "volume": 100000.0 / 0.025,
            },
        },
        {
            "description": "NVDA between 2021-07-20 and 2024-06-10 (only 10:1 split applies -> historical_adjustment_factor=0.1)",
            "barDateEt": "2023-11-10",
            "raw": {"open": 480.0, "high": 490.0, "low": 475.0, "close": 485.0, "volume": 500000.0},
            "expectedFactor": 0.1,
            "expectedAdjusted": {
                "open": 480.0 * 0.1,
                "high": 490.0 * 0.1,
                "low": 475.0 * 0.1,
                "close": 485.0 * 0.1,
                "volume": 500000.0 / 0.1,
            },
        },
        {
            "description": "NVDA on execution_date 2024-06-10 -> factor=1.0 (unscaled)",
            "barDateEt": "2024-06-10",
            "raw": {"open": 120.5, "high": 122.0, "low": 119.0, "close": 121.8, "volume": 8000000.0},
            "expectedFactor": 1.0,
            "expectedAdjusted": {
                "open": 120.5,
                "high": 122.0,
                "low": 119.0,
                "close": 121.8,
                "volume": 8000000.0,
            },
        },
    ]

    fixture = {
        "meta": {
            "generator": "tools/gen_unusual_trades_fixture.py",
            "precisionTolerance": 1e-9,
        },
        "unusualTrades": {
            "page1Rows": page1_rows,
            "page2Rows": page2_rows,
            "caseA_default100_unadjustedUnknown": {
                "trades": expected_default_100,
                "knownNotionalSum": known_notional_case_a,
                "validNotionalCount": 4,
                "nanNotionalCount": 1,
                "reordered": True,
                "discardCounts": {
                    "malformedRow": 1,
                    "invalidTicker": 0,
                    "invalidRoot": 1,
                    "invalidTimestamp": 1,
                    "nonFinite": 0,
                    "invalidPrice": 1,
                    "invalidSize": 1,
                    "invalidSharesPerContract": 0,
                    "invalidFlags": 0,
                    "duplicate": 1,
                    "filteredOut": 0,
                },
            },
            "caseB_withVerifiedGme1Lookup": {
                "sharesPerContractByTicker": lookup,
                "trades": expected_with_lookup,
                "totalNotional": total_notional_case_b,
                "validNotionalCount": 5,
                "nanNotionalCount": 0,
                "distinctRoots": ["B1SPY", "GME1", "SPX", "SPXW", "SPY"],
                "distinctUnderlyingTickers": ["GME", "SPX", "SPY"],
            },
            "caseC_spxwBlockPremiumIsoOnly": {
                "trades": expected_spxw_iso_block,
                "totalNotional": expected_spxw_iso_block[0]["notional"],
            },
        },
        "flatFilesSplitReference": {
            "splitsPayload": {
                "status": "OK",
                "results": [
                    {
                        "ticker": "NVDA",
                        "execution_date": "2024-06-10",
                        "split_from": 1,
                        "split_to": 10,
                        "historical_adjustment_factor": 0.1,
                    },
                    {
                        "ticker": "NVDA",
                        "execution_date": "2021-07-20",
                        "split_from": 1,
                        "split_to": 4,
                        "historical_adjustment_factor": 0.025,
                    },
                ],
            },
            "cases": split_cases,
        },
    }

    out_path = Path(__file__).resolve().parents[1] / "fixtures" / "unusual_trades_reference.json"
    out_path.write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {out_path} successfully.")


if __name__ == "__main__":
    main()
