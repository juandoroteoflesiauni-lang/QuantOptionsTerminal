"""Independent Decimal (prec=50) oracle for Pieza P1 A5 + A6.

Generates `fixtures/ggal_pieza_a5_a6_reference.json` with zero JS/TS imports:
  - A5: deterministic BYMA option strike & expiry resolution independent of spot.
  - A6: GGAL ADR L1 book vs trade vs EOD reference separation and parity edge/signal gating.
"""

from __future__ import annotations

import datetime as dt
import json
import math
import re
from decimal import Decimal, getcontext
from pathlib import Path
from typing import Any

getcontext().prec = 50
D = Decimal

ROOT = Path(__file__).resolve().parent.parent
OUT_PATH = ROOT / "fixtures" / "ggal_pieza_a5_a6_reference.json"

DAYS_PER_YEAR = D("365")
GGAL_ADR_RATIO = D("10")

OPTION_PREFIX_TO_UNDERLYING: dict[str, str] = {
    "GFG": "GGAL",
    "GGAL": "GGAL",
    "YPF": "YPFD",
    "YPFD": "YPFD",
    "PAM": "PAMP",
    "PAMP": "PAMP",
    "BMA": "BMA",
    "TXA": "TXAR",
    "TXAR": "TXAR",
    "ALU": "ALUA",
    "ALUA": "ALUA",
    "CEP": "CEPU",
    "CEPU": "CEPU",
    "VIS": "VIST",
    "VIST": "VIST",
    "COM": "COME",
    "COME": "COME",
    "SUP": "SUPV",
    "SUPV": "SUPV",
    "BBV": "BBAR",
    "BBA": "BBAR",
    "BBAR": "BBAR",
}

MONTH_CODES: dict[str, tuple[int, str]] = {
    "EN": (1, "EN"),
    "E": (1, "EN"),
    "FE": (2, "FE"),
    "F": (2, "FE"),
    "MA": (3, "MA"),
    "MR": (3, "MA"),
    "M": (3, "MA"),
    "AB": (4, "AB"),
    "A": (4, "AB"),
    "MY": (5, "MY"),
    "Y": (5, "MY"),
    "JU": (6, "JU"),
    "JN": (6, "JU"),
    "J": (6, "JU"),
    "JL": (7, "JL"),
    "L": (7, "JL"),
    "AG": (8, "AG"),
    "G": (8, "AG"),
    "SE": (9, "SE"),
    "S": (9, "SE"),
    "OC": (10, "OC"),
    "O": (10, "OC"),
    "NO": (11, "NO"),
    "N": (11, "NO"),
    "DI": (12, "DI"),
    "D": (12, "DI"),
}

ALLOWED_L1_SOURCES = {"TRADIER_LIVE_NBBO", "MASSIVE_NBBO", "FMP_EXTENDED_NBBO"}

BYMA_FEE = {
    "equity_alyc": D("0.001"),
    "equity_dm": D("0.0005"),
    "bond_alyc": D("0.001"),
    "bond_dm": D("0.0001"),
    "vat": D("0.21"),
}

US_FEE = {
    "sec31": D("20.6") / D("1000000"),
    "taf_equity": D("0.000166"),
    "broker_equity": D("0"),
}

FINRA_TAF_START = 1_790_812_800
FINRA_TAF_END = 1_798_761_600


def third_friday_date(year: int, month: int) -> dt.date:
    first = dt.date(year, month, 1)
    # Python weekday(): Mon=0..Fri=4
    offset = (4 - first.weekday() + 7) % 7
    day = 1 + offset + 14
    return dt.date(year, month, day)


def prev_business_day(d: dt.date, holidays: set[str]) -> dt.date:
    cur = d
    while cur.weekday() >= 5 or cur.isoformat() in holidays:
        cur -= dt.timedelta(days=1)
    return cur


def resolve_byma_expiry_py(
    report_date: str,
    expiry_code: str,
    contractual_expiry: str | None = None,
    known_expiries: list[str] | None = None,
    holidays: list[str] | None = None,
) -> dict[str, Any]:
    holiday_set = set(holidays or [])
    m_info = MONTH_CODES.get(expiry_code.strip().upper())
    if m_info is None:
        return {"error": "AMBIGUOUS_EXPIRY_SUFFIX"}
    target_month, canonical_code = m_info
    r_year, _, _ = (int(p) for p in report_date.split("-"))

    if contractual_expiry is not None:
        return {"contractualExpiry": contractual_expiry, "expiryCode": canonical_code}

    if known_expiries is not None:
        matches = [
            e for e in sorted(set(known_expiries)) if int(e.split("-")[1]) == target_month and e >= report_date
        ]
        if len(matches) == 1:
            return {"contractualExpiry": matches[0], "expiryCode": canonical_code}
        if len(matches) > 1:
            return {"error": "AMBIGUOUS_EXPIRY_YEAR"}

    cands = [
        prev_business_day(third_friday_date(r_year, target_month), holiday_set),
        prev_business_day(third_friday_date(r_year + 1, target_month), holiday_set),
    ]
    for c in cands:
        if c.isoformat() >= report_date:
            return {"contractualExpiry": c.isoformat(), "expiryCode": canonical_code}
    return {"error": "AMBIGUOUS_EXPIRY_YEAR"}


def resolve_byma_contract_py(
    raw_symbol: str,
    report_date: str,
    metadata_records: list[dict[str, Any]] | None = None,
    known_expiries: list[str] | None = None,
    holidays: list[str] | None = None,
) -> dict[str, Any]:
    cleaned = re.sub(r"[^A-Z0-9.,]", "", raw_symbol.strip().upper())
    native = cleaned.replace(",", ".")
    m = re.match(r"^([A-Z]{3,5})([CV])(\d+(?:[.,]\d+)?)([A-Z]*)$", cleaned)
    if len(cleaned) < 6 or m is None:
        return {
            "nativeSymbol": native,
            "canonicalContractId": None,
            "strike": None,
            "strikeTicks1e4": None,
            "strikeResolutionStatus": "INVALID_SYMBOL",
            "strikeSource": "NONE",
            "scaleFactorApplied": None,
            "expiryResolutionError": "NONE",
            "exclusionReason": "INVALID_OPTION_SYMBOL_SYNTAX",
            "conflictsCount": 0,
        }

    prefix, side_ch, strike_tok, suffix = m.groups()
    underlying = OPTION_PREFIX_TO_UNDERLYING.get(prefix)
    if underlying is None:
        return {
            "nativeSymbol": native,
            "canonicalContractId": None,
            "strike": None,
            "strikeTicks1e4": None,
            "strikeResolutionStatus": "INVALID_SYMBOL",
            "strikeSource": "NONE",
            "scaleFactorApplied": None,
            "expiryResolutionError": "NONE",
            "exclusionReason": "UNKNOWN_UNDERLYING_PREFIX",
            "conflictsCount": 0,
        }
    if suffix == "":
        return {
            "nativeSymbol": native,
            "canonicalContractId": None,
            "strike": None,
            "strikeTicks1e4": None,
            "strikeResolutionStatus": "INVALID_SYMBOL",
            "strikeSource": "NONE",
            "scaleFactorApplied": None,
            "expiryResolutionError": "MISSING_EXPIRY_SUFFIX",
            "exclusionReason": "MISSING_EXPIRY_SUFFIX",
            "conflictsCount": 0,
        }
    if suffix not in MONTH_CODES:
        return {
            "nativeSymbol": native,
            "canonicalContractId": None,
            "strike": None,
            "strikeTicks1e4": None,
            "strikeResolutionStatus": "INVALID_SYMBOL",
            "strikeSource": "NONE",
            "scaleFactorApplied": None,
            "expiryResolutionError": "AMBIGUOUS_EXPIRY_SUFFIX",
            "exclusionReason": "AMBIGUOUS_EXPIRY_SUFFIX",
            "conflictsCount": 0,
        }

    has_dec = "." in strike_tok or "," in strike_tok
    side = "call" if side_ch == "C" else "put"

    exp_res = resolve_byma_expiry_py(report_date, suffix, known_expiries=known_expiries, holidays=holidays)
    if "error" in exp_res:
        return {
            "nativeSymbol": native,
            "canonicalContractId": None,
            "strike": None,
            "strikeTicks1e4": None,
            "strikeResolutionStatus": "INVALID_SYMBOL",
            "strikeSource": "NONE",
            "scaleFactorApplied": None,
            "expiryResolutionError": exp_res["error"],
            "exclusionReason": exp_res["error"],
            "conflictsCount": 0,
        }

    precedence = {"IAMC_ANEXO_B": 0, "PRIMARY_INSTRUMENT_DETAIL": 1, "BMB_OPTION_METADATA": 2, "DATA912_METADATA": 3, "OPEN_BYMA_METADATA": 4}
    applicable = [r for r in (metadata_records or []) if r.get("nativeSymbol", native).upper() == native and r.get("strike", 0) > 0]
    conflicts: list[dict[str, Any]] = []
    valids: list[dict[str, Any]] = []
    for rec in applicable:
        meta_ticks = int((D(str(rec["strike"])) * 10_000).to_integral_value())
        scale_factor = None
        if has_dec:
            sym_ticks = int((D(strike_tok.replace(",", ".")) * 10_000).to_integral_value())
            if meta_ticks == sym_ticks:
                scale_factor = 1
        else:
            raw_int = int(strike_tok)
            target_ticks = raw_int * 10_000
            for k in (1, 10, 100):
                if meta_ticks * k == target_ticks:
                    scale_factor = k
                    break
        if scale_factor is None:
            conflicts.append({"source": rec["source"], "reason": "STRIKE_MISMATCH"})
        else:
            valids.append({"rec": rec, "ticks": meta_ticks, "scaleFactor": scale_factor})

    distinct_ticks = {v["ticks"] for v in valids}
    if len(distinct_ticks) > 1:
        for v in valids:
            conflicts.append({"source": v["rec"]["source"], "reason": "STRIKE_DISAGREEMENT"})

    if conflicts:
        return {
            "nativeSymbol": native,
            "canonicalContractId": None,
            "strike": None,
            "strikeTicks1e4": None,
            "strikeResolutionStatus": "CONFLICTING_METADATA",
            "strikeSource": "NONE",
            "scaleFactorApplied": None,
            "expiryResolutionError": "NONE",
            "exclusionReason": "CONFLICTING_AUTHORITATIVE_STRIKE_METADATA",
            "conflictsCount": len(conflicts),
        }

    contractual_expiry = exp_res["contractualExpiry"]
    expiry_code = exp_res["expiryCode"]

    if valids:
        chosen = sorted(valids, key=lambda v: precedence[v["rec"]["source"]])[0]
        ticks = chosen["ticks"]
        strike_val = float(D(ticks) / D(10_000))
        canon_id = f"BYMA_AR|{underlying}|{contractual_expiry}|{side}|{ticks}|{report_date}"
        return {
            "nativeSymbol": native,
            "canonicalContractId": canon_id,
            "strike": strike_val,
            "strikeTicks1e4": ticks,
            "strikeResolutionStatus": "EXPLICIT_METADATA",
            "strikeSource": chosen["rec"]["source"],
            "scaleFactorApplied": chosen["scaleFactor"],
            "contractualExpiry": contractual_expiry,
            "expiryCode": expiry_code,
            "expiryResolutionError": "NONE",
            "exclusionReason": None,
            "conflictsCount": 0,
        }

    if has_dec:
        ticks = int((D(strike_tok.replace(",", ".")) * 10_000).to_integral_value())
        strike_val = float(D(ticks) / D(10_000))
        canon_id = f"BYMA_AR|{underlying}|{contractual_expiry}|{side}|{ticks}|{report_date}"
        return {
            "nativeSymbol": native,
            "canonicalContractId": canon_id,
            "strike": strike_val,
            "strikeTicks1e4": ticks,
            "strikeResolutionStatus": "CANONICAL_SYMBOL",
            "strikeSource": "SYMBOL_EXPLICIT_DECIMAL",
            "scaleFactorApplied": 1,
            "contractualExpiry": contractual_expiry,
            "expiryCode": expiry_code,
            "expiryResolutionError": "NONE",
            "exclusionReason": None,
            "conflictsCount": 0,
        }

    leading_zero = strike_tok.startswith("0")
    raw_int = int(strike_tok)
    tok_len = len(strike_tok)
    canonical_int = (not leading_zero) and (
        tok_len <= 2
        or ((tok_len in (3, 4)) and raw_int % 10 == 0)
        or (tok_len == 5 and raw_int % 100 == 0)
        or (tok_len >= 6 and raw_int % 1000 == 0)
    )
    if canonical_int:
        ticks = raw_int * 10_000
        canon_id = f"BYMA_AR|{underlying}|{contractual_expiry}|{side}|{ticks}|{report_date}"
        return {
            "nativeSymbol": native,
            "canonicalContractId": canon_id,
            "strike": float(raw_int),
            "strikeTicks1e4": ticks,
            "strikeResolutionStatus": "CANONICAL_SYMBOL",
            "strikeSource": "SYMBOL_CANONICAL_INTEGER",
            "scaleFactorApplied": 1,
            "contractualExpiry": contractual_expiry,
            "expiryCode": expiry_code,
            "expiryResolutionError": "NONE",
            "exclusionReason": None,
            "conflictsCount": 0,
        }

    return {
        "nativeSymbol": native,
        "canonicalContractId": None,
        "strike": None,
        "strikeTicks1e4": None,
        "strikeResolutionStatus": "AMBIGUOUS_SCALE_UNRESOLVED",
        "strikeSource": "NONE",
        "scaleFactorApplied": None,
        "contractualExpiry": contractual_expiry,
        "expiryCode": expiry_code,
        "expiryResolutionError": "NONE",
        "exclusionReason": "AMBIGUOUS_STRIKE_SCALE_REQUIRES_METADATA",
        "conflictsCount": 0,
    }


def dec_or_none(v: float | int | str | None) -> Decimal | None:
    if v is None:
        return None
    d = D(str(v))
    return d if d > 0 else None


def normalize_adr_py(
    symbol: str,
    as_of_utc_sec: int,
    is_eod_mode: bool,
    max_quote_age_sec: int = 20,
    l1_candidate: dict[str, Any] | None = None,
    trade_candidate: dict[str, Any] | None = None,
    reference_candidate: dict[str, Any] | None = None,
) -> dict[str, Any]:
    last_price = dec_or_none((trade_candidate or {}).get("lastPrice"))
    last_size = dec_or_none((trade_candidate or {}).get("lastSize"))
    trade_ts = (trade_candidate or {}).get("tradeTimestamp")
    ref_close = dec_or_none((reference_candidate or {}).get("close"))
    ref_ts = (reference_candidate or {}).get("referenceTimestamp")

    if is_eod_mode:
        if ref_close is not None and isinstance(ref_ts, int):
            return {
                "symbol": symbol,
                "quoteMode": "EOD_CLOSE_REF",
                "tradeLastPrice": float(last_price) if last_price is not None else None,
                "tradeLastSize": float(last_size) if last_size is not None else None,
                "bid": None,
                "ask": None,
                "bidSize": None,
                "askSize": None,
                "mid": None,
                "spreadUsd": None,
                "spreadRel": None,
                "isBilateralExecutable": False,
                "invalidReason": "OUT_OF_SESSION_QUOTE",
                "indicativePriceUsd": float(ref_close),
                "indicativePriceBasis": "EOD_CLOSE",
            }
        return {
            "symbol": symbol,
            "quoteMode": "UNAVAILABLE",
            "tradeLastPrice": float(last_price) if last_price is not None else None,
            "tradeLastSize": float(last_size) if last_size is not None else None,
            "bid": None,
            "ask": None,
            "bidSize": None,
            "askSize": None,
            "mid": None,
            "spreadUsd": None,
            "spreadRel": None,
            "isBilateralExecutable": False,
            "invalidReason": "MISSING_ALL_DATA",
            "indicativePriceUsd": None,
            "indicativePriceBasis": "NONE",
        }

    cand = l1_candidate or {}
    q_source = cand.get("quoteSource")
    allowed = q_source in ALLOWED_L1_SOURCES
    cand_bid = dec_or_none(cand.get("bid"))
    cand_ask = dec_or_none(cand.get("ask"))
    cand_bsize = dec_or_none(cand.get("bidSize"))
    cand_asize = dec_or_none(cand.get("askSize"))
    cand_ts = cand.get("quoteTimestamp")

    invalid_reason: str | None = None
    if l1_candidate is None or not allowed:
        invalid_reason = "NO_L1_PROVIDER_BBO" if last_price is not None else "MISSING_ALL_DATA"
    elif cand_bid is None and cand_ask is None:
        invalid_reason = "NO_L1_PROVIDER_BBO" if last_price is not None else "MISSING_ALL_DATA"
    elif cand.get("isOutOfSession") is True:
        invalid_reason = "OUT_OF_SESSION_QUOTE"
    elif cand_bid is not None and cand_ask is not None and cand_bid > cand_ask:
        invalid_reason = "CROSSED_BOOK"
    elif not isinstance(cand_ts, int):
        invalid_reason = "MISSING_L1_TIMESTAMP"
    else:
        age = as_of_utc_sec - cand_ts
        if age < 0 or age > max_quote_age_sec:
            invalid_reason = "STALE_L1_QUOTE"

    if invalid_reason is None:
        if cand_bid is not None and cand_ask is not None:
            mid = (cand_bid + cand_ask) / D(2)
            spread_usd = cand_ask - cand_bid
            spread_rel = spread_usd / mid
            return {
                "symbol": symbol,
                "quoteMode": "LIVE_BID_ASK",
                "tradeLastPrice": float(last_price) if last_price is not None else None,
                "tradeLastSize": float(last_size) if last_size is not None else None,
                "bid": float(cand_bid),
                "ask": float(cand_ask),
                "bidSize": float(cand_bsize) if cand_bsize is not None else None,
                "askSize": float(cand_asize) if cand_asize is not None else None,
                "mid": float(mid),
                "spreadUsd": float(spread_usd),
                "spreadRel": float(spread_rel),
                "isBilateralExecutable": True,
                "invalidReason": "NONE",
                "indicativePriceUsd": float(mid),
                "indicativePriceBasis": "L1_MID",
            }
        reason_1s = "ONE_SIDED_BID_ONLY" if cand_bid is not None else "ONE_SIDED_ASK_ONLY"
        return {
            "symbol": symbol,
            "quoteMode": "ONE_SIDED_QUOTE",
            "tradeLastPrice": float(last_price) if last_price is not None else None,
            "tradeLastSize": float(last_size) if last_size is not None else None,
            "bid": float(cand_bid) if cand_bid is not None else None,
            "ask": float(cand_ask) if cand_ask is not None else None,
            "bidSize": float(cand_bsize) if (cand_bid is not None and cand_bsize is not None) else None,
            "askSize": float(cand_asize) if (cand_ask is not None and cand_asize is not None) else None,
            "mid": None,
            "spreadUsd": None,
            "spreadRel": None,
            "isBilateralExecutable": False,
            "invalidReason": reason_1s,
            "indicativePriceUsd": float(last_price) if last_price is not None else None,
            "indicativePriceBasis": "LAST_TRADE" if last_price is not None else "NONE",
        }

    if last_price is not None:
        return {
            "symbol": symbol,
            "quoteMode": "LAST_ONLY",
            "tradeLastPrice": float(last_price),
            "tradeLastSize": float(last_size) if last_size is not None else None,
            "bid": None,
            "ask": None,
            "bidSize": None,
            "askSize": None,
            "mid": None,
            "spreadUsd": None,
            "spreadRel": None,
            "isBilateralExecutable": False,
            "invalidReason": invalid_reason,
            "indicativePriceUsd": float(last_price),
            "indicativePriceBasis": "LAST_TRADE",
        }

    return {
        "symbol": symbol,
        "quoteMode": "UNAVAILABLE",
        "tradeLastPrice": None,
        "tradeLastSize": float(last_size) if last_size is not None else None,
        "bid": None,
        "ask": None,
        "bidSize": None,
        "askSize": None,
        "mid": None,
        "spreadUsd": None,
        "spreadRel": None,
        "isBilateralExecutable": False,
        "invalidReason": invalid_reason,
        "indicativePriceUsd": None,
        "indicativePriceBasis": "NONE",
    }


def eval_parity_py(
    as_of_utc_sec: int,
    is_eod_mode: bool,
    byma_bid: str,
    byma_ask: str,
    adr_norm: dict[str, Any],
    sofr_annual: str,
    bonds: list[dict[str, str]],
    spread_history: list[dict[str, Any]],
) -> dict[str, Any]:
    d_byma_bid = D(byma_bid)
    d_byma_ask = D(byma_ask)
    byma_mid = (d_byma_bid + d_byma_ask) / D(2)
    byma_spread_rel = (d_byma_ask - d_byma_bid) / byma_mid

    adr_ind = D(str(adr_norm["indicativePriceUsd"]))
    adr_mid = D(str(adr_norm["mid"])) if adr_norm["mid"] is not None else None
    adr_spread_rel = D(str(adr_norm["spreadRel"])) if adr_norm["spreadRel"] is not None else None

    # Settlement T+1 on Thursday 2026-10-15 -> Friday 2026-10-16: deltaAr1Days = 1, deltaUs1Days = 1
    delta_ar = D(1)
    delta_us = D(1)
    d_sofr = D(sofr_annual)
    sofr_adj = (d_sofr * ((delta_ar - delta_us) / DAYS_PER_YEAR)).exp()

    ccl_ggal = (GGAL_ADR_RATIO * byma_mid) / (adr_ind * sofr_adj)

    weight_sum = D(0)
    weighted_ccl = D(0)
    weighted_ars_spr = D(0)
    weighted_usdc_spr = D(0)
    for b in bonds:
        ab, aa = D(b["arsBid"]), D(b["arsAsk"])
        ub, ua = D(b["usdBid"]), D(b["usdAsk"])
        am = (ab + aa) / D(2)
        um = (ub + ua) / D(2)
        aspr = (aa - ab) / am
        uspr = (ua - ub) / um
        ccl_b = am / um
        s = aspr + uspr
        w = D(1) / (s * s) if s > 0 else D(1)
        weight_sum += w
        weighted_ccl += w * ccl_b
        weighted_ars_spr += w * aspr
        weighted_usdc_spr += w * uspr

    ccl_sov = weighted_ccl / weight_sum
    avg_ars_spr = weighted_ars_spr / weight_sum
    avg_usdc_spr = weighted_usdc_spr / weight_sum

    # Causal OU AR(1)
    xs = [(D(str(o["cclGgal24h"])).ln() - D(str(o["cclSovereign"])).ln()) for o in spread_history]
    n_pairs = len(xs) - 1
    mean_x = sum(xs[:-1]) / D(n_pairs)
    mean_y = sum(xs[1:]) / D(n_pairs)
    cov = sum((xs[i] - mean_x) * (xs[i + 1] - mean_y) for i in range(n_pairs))
    var_x = sum((xs[i] - mean_x) ** 2 for i in range(n_pairs))
    phi = cov / var_x
    intercept = mean_y - phi * mean_x
    rss = sum((xs[i + 1] - (phi * xs[i] + intercept)) ** 2 for i in range(n_pairs))
    res_sigma = (rss / D(n_pairs - 2)).sqrt()
    mu_log = intercept / (D(1) - phi)
    eq_sigma = res_sigma / (D(1) - phi * phi).sqrt()
    kappa = -(phi.ln())
    half_life = D(2).ln() / kappa

    spread_log = ccl_ggal.ln() - ccl_sov.ln()
    spread_log_bps = spread_log * D("10000")
    ou_mean_bps = mu_log * D("10000")
    ou_eq_sigma_bps = eq_sigma * D("10000")
    z_score = (spread_log - mu_log) / eq_sigma
    fair_adr_usd = (GGAL_ADR_RATIO * byma_mid) / (ccl_sov * sofr_adj)

    net_edge_bps = None
    if not is_eod_mode and adr_mid is not None and adr_spread_rel is not None:
        c_byma_eq = (BYMA_FEE["equity_alyc"] + BYMA_FEE["equity_dm"]) * (D(1) + BYMA_FEE["vat"])
        c_byma_bond = BYMA_FEE["bond_alyc"] + BYMA_FEE["bond_dm"]
        taf = D(0) if FINRA_TAF_START <= as_of_utc_sec < FINRA_TAF_END else US_FEE["taf_equity"]
        c_us_sell = US_FEE["sec31"] + taf / adr_mid + US_FEE["broker_equity"] / adr_mid
        friction = (
            D("0.5") * (byma_spread_rel + adr_spread_rel + avg_ars_spr + avg_usdc_spr)
            + c_byma_eq
            + D(2) * c_byma_bond
            + c_us_sell
        )
        net_edge_bps = float(((spread_log - mu_log).copy_abs() - friction) * D("10000"))

    if is_eod_mode:
        exec_status = "EOD_REFERENCE_ONLY"
        blocked_reason = "MARKET_EOD_REFERENCE_ONLY"
        actionable = False
        signal = "NEUTRAL"
    elif not adr_norm["isBilateralExecutable"]:
        exec_status = "INDICATIVE_ONLY_NO_ADR_BBO"
        blocked_reason = "ADR_NO_BILATERAL_L1_BBO"
        actionable = False
        signal = "NEUTRAL"
    else:
        exec_status = "EXECUTABLE_BILATERAL_L1"
        blocked_reason = None
        actionable = True
        signal = (
            ("SHORT_BYMA_LONG_ADR" if z_score > 0 else "LONG_BYMA_SHORT_ADR")
            if (z_score.copy_abs() >= D(2) and net_edge_bps is not None and net_edge_bps > 30 and half_life <= D(5))
            else "NEUTRAL"
        )

    return {
        "adrMidUsd": float(adr_mid) if adr_mid is not None else None,
        "adrBidUsd": adr_norm["bid"],
        "adrAskUsd": adr_norm["ask"],
        "adrLastUsd": adr_norm["tradeLastPrice"],
        "adrSpreadUsd": adr_norm["spreadUsd"],
        "adrIndicativeUsd": float(adr_ind),
        "adrQuoteMode": adr_norm["quoteMode"],
        "cclGgal24h": float(ccl_ggal),
        "cclSovereignBenchmark": float(ccl_sov),
        "spreadLogBps": float(spread_log_bps),
        "ouMeanBps": float(ou_mean_bps),
        "ouEqSigmaBps": float(ou_eq_sigma_bps),
        "zScore": float(z_score),
        "fairAdrUsd": float(fair_adr_usd),
        "netEdgeAfterCostsBps": net_edge_bps,
        "signal": signal,
        "parityEvaluation": {
            "indicativeBasis": adr_norm["indicativePriceBasis"],
            "executableStatus": exec_status,
            "actionableSignalAllowed": actionable,
            "blockedReason": blocked_reason,
        },
    }


def main() -> None:
    report_date = "2026-11-16"
    as_of_utc_sec = int(dt.datetime(2026, 10, 15, 15, 30, 0, tzinfo=dt.timezone.utc).timestamp())

    a5_spot_invariance = {
        "rawSymbol": "GFGC62974D",
        "reportDate": report_date,
        "spotValues": [6000.0, 18000.0, 100.0, None],
        "expected": resolve_byma_contract_py("GFGC62974D", report_date),
    }

    a5_series_cases = [
        {
            "rawSymbol": sym,
            "expected": resolve_byma_contract_py(sym, report_date),
        }
        for sym in [
            "GFGC6000DI",
            "YPFC42000OC",
            "GFGC10800NO",
            "GFGC6297.4DI",
            "GFGC6400.0DI",
            "GFGC62974D",
            "GFGV62974AB",
            "GFGC629745D",
            "GFGC6297D",
            "GFGC625DI",
            "GFGC06297D",
        ]
    ]

    a5_explicit_metadata = [
        {
            "name": "IAMC_6297_4",
            "rawSymbol": "GFGC62974D",
            "spots": [6000.0, 18000.0, 100.0, None],
            "metadata": [{"source": "IAMC_ANEXO_B", "nativeSymbol": "GFGC62974D", "strike": 6297.4}],
            "expected": resolve_byma_contract_py(
                "GFGC62974D", report_date, [{"source": "IAMC_ANEXO_B", "nativeSymbol": "GFGC62974D", "strike": 6297.4}]
            ),
        },
        {
            "name": "PRIMARY_6297_4",
            "rawSymbol": "GFGC62974D",
            "spots": [6000.0, 18000.0],
            "metadata": [{"source": "PRIMARY_INSTRUMENT_DETAIL", "nativeSymbol": "GFGC62974D", "strike": 6297.4}],
            "expected": resolve_byma_contract_py(
                "GFGC62974D", report_date, [{"source": "PRIMARY_INSTRUMENT_DETAIL", "nativeSymbol": "GFGC62974D", "strike": 6297.4}]
            ),
        },
        {
            "name": "BMB_6297_4",
            "rawSymbol": "GFGC62974D",
            "spots": [6000.0, 18000.0],
            "metadata": [{"source": "BMB_OPTION_METADATA", "nativeSymbol": "GFGC62974D", "strike": 6297.4}],
            "expected": resolve_byma_contract_py(
                "GFGC62974D", report_date, [{"source": "BMB_OPTION_METADATA", "nativeSymbol": "GFGC62974D", "strike": 6297.4}]
            ),
        },
        {
            "name": "PRIMARY_62974_EXACT",
            "rawSymbol": "GFGC62974D",
            "spots": [6000.0, 18000.0],
            "metadata": [{"source": "PRIMARY_INSTRUMENT_DETAIL", "nativeSymbol": "GFGC62974D", "strike": 62974.0}],
            "expected": resolve_byma_contract_py(
                "GFGC62974D", report_date, [{"source": "PRIMARY_INSTRUMENT_DETAIL", "nativeSymbol": "GFGC62974D", "strike": 62974.0}]
            ),
        },
    ]

    a5_conflicts = [
        {
            "name": "IAMC_6297_4_VS_PRIMARY_62974",
            "rawSymbol": "GFGC62974D",
            "spot": 6000.0,
            "metadata": [
                {"source": "IAMC_ANEXO_B", "nativeSymbol": "GFGC62974D", "strike": 6297.4},
                {"source": "PRIMARY_INSTRUMENT_DETAIL", "nativeSymbol": "GFGC62974D", "strike": 62974.0},
            ],
            "expected": resolve_byma_contract_py(
                "GFGC62974D",
                report_date,
                [
                    {"source": "IAMC_ANEXO_B", "nativeSymbol": "GFGC62974D", "strike": 6297.4},
                    {"source": "PRIMARY_INSTRUMENT_DETAIL", "nativeSymbol": "GFGC62974D", "strike": 62974.0},
                ],
            ),
        },
        {
            "name": "IAMC_7500_MISMATCH_GFGC62974D",
            "rawSymbol": "GFGC62974D",
            "spot": 6000.0,
            "metadata": [{"source": "IAMC_ANEXO_B", "nativeSymbol": "GFGC62974D", "strike": 7500.0}],
            "expected": resolve_byma_contract_py(
                "GFGC62974D",
                report_date,
                [{"source": "IAMC_ANEXO_B", "nativeSymbol": "GFGC62974D", "strike": 7500.0}],
            ),
        },
    ]

    a5_expiry_cases = {
        "ambiguousSuffixSymbols": [
            {"rawSymbol": s, "expected": resolve_byma_contract_py(s, report_date)}
            for s in ("GFGC6000DIC", "GFGC6000DX", "GFGC61120C")
        ],
        "ambiguousTwoYears": resolve_byma_contract_py(
            "GFGC6000DI", report_date, known_expiries=["2026-12-18", "2027-12-17"]
        ),
        "holidayShift": resolve_byma_contract_py(
            "GFGC6000DI", report_date, holidays=["2026-12-18"]
        ),
    }

    quote_inputs = {
        "A6_1_FMP_LAST_ONLY": {
            "symbol": "GGAL",
            "asOfUtcSec": as_of_utc_sec,
            "isEodMode": False,
            "maxQuoteAgeSec": 20,
            "l1Candidate": None,
            "tradeCandidate": {"lastPrice": 50.0, "tradeTimestamp": as_of_utc_sec, "tradeSource": "FMP_ENTERPRISE"},
            "referenceCandidate": None,
        },
        "A6_3_LIVE_BID_ASK": {
            "symbol": "GGAL",
            "asOfUtcSec": as_of_utc_sec,
            "isEodMode": False,
            "maxQuoteAgeSec": 20,
            "l1Candidate": {
                "quoteSource": "TRADIER_LIVE_NBBO",
                "bid": 49.90,
                "ask": 50.10,
                "bidSize": 8,
                "askSize": 10,
                "quoteTimestamp": as_of_utc_sec,
            },
            "tradeCandidate": {"lastPrice": 50.0, "tradeTimestamp": as_of_utc_sec, "tradeSource": "TRADIER_LIVE_NBBO"},
            "referenceCandidate": None,
        },
        "A6_4_CROSSED_BOOK": {
            "symbol": "GGAL",
            "asOfUtcSec": as_of_utc_sec,
            "isEodMode": False,
            "maxQuoteAgeSec": 20,
            "l1Candidate": {
                "quoteSource": "TRADIER_LIVE_NBBO",
                "bid": 50.20,
                "ask": 49.90,
                "bidSize": 5,
                "askSize": 5,
                "quoteTimestamp": as_of_utc_sec,
            },
            "tradeCandidate": {"lastPrice": 50.0, "tradeTimestamp": as_of_utc_sec, "tradeSource": "MASSIVE"},
            "referenceCandidate": None,
        },
        "A6_4_ONE_SIDED_BID_ONLY": {
            "symbol": "GGAL",
            "asOfUtcSec": as_of_utc_sec,
            "isEodMode": False,
            "maxQuoteAgeSec": 20,
            "l1Candidate": {
                "quoteSource": "TRADIER_LIVE_NBBO",
                "bid": 49.90,
                "ask": None,
                "bidSize": 6,
                "askSize": None,
                "quoteTimestamp": as_of_utc_sec,
            },
            "tradeCandidate": {"lastPrice": 50.0, "tradeTimestamp": as_of_utc_sec, "tradeSource": "MASSIVE"},
            "referenceCandidate": None,
        },
        "A6_4_ONE_SIDED_ASK_ONLY": {
            "symbol": "GGAL",
            "asOfUtcSec": as_of_utc_sec,
            "isEodMode": False,
            "maxQuoteAgeSec": 20,
            "l1Candidate": {
                "quoteSource": "MASSIVE_NBBO",
                "bid": None,
                "ask": 50.10,
                "bidSize": None,
                "askSize": 4,
                "quoteTimestamp": as_of_utc_sec,
            },
            "tradeCandidate": {"lastPrice": 50.0, "tradeTimestamp": as_of_utc_sec, "tradeSource": "MASSIVE"},
            "referenceCandidate": None,
        },
        "A6_4_STALE_L1_FRESH_TRADE": {
            "symbol": "GGAL",
            "asOfUtcSec": as_of_utc_sec,
            "isEodMode": False,
            "maxQuoteAgeSec": 20,
            "l1Candidate": {
                "quoteSource": "TRADIER_LIVE_NBBO",
                "bid": 49.90,
                "ask": 50.10,
                "bidSize": 5,
                "askSize": 5,
                "quoteTimestamp": as_of_utc_sec - 25,
            },
            "tradeCandidate": {"lastPrice": 50.0, "tradeTimestamp": as_of_utc_sec, "tradeSource": "FMP_ENTERPRISE"},
            "referenceCandidate": None,
        },
        "A6_4_MISSING_L1_TIMESTAMP_FRESH_TRADE": {
            "symbol": "GGAL",
            "asOfUtcSec": as_of_utc_sec,
            "isEodMode": False,
            "maxQuoteAgeSec": 20,
            "l1Candidate": {
                "quoteSource": "MASSIVE_NBBO",
                "bid": 49.90,
                "ask": 50.10,
                "bidSize": 5,
                "askSize": 5,
                "quoteTimestamp": None,
            },
            "tradeCandidate": {"lastPrice": 50.0, "tradeTimestamp": as_of_utc_sec, "tradeSource": "MASSIVE"},
            "referenceCandidate": None,
        },
        "A6_5_EOD_CLOSE_REF": {
            "symbol": "GGAL",
            "asOfUtcSec": as_of_utc_sec,
            "isEodMode": True,
            "maxQuoteAgeSec": 20,
            "l1Candidate": None,
            "tradeCandidate": None,
            "referenceCandidate": {
                "close": 50.0,
                "referenceTimestamp": as_of_utc_sec - 3_600,
                "referenceSource": "MASSIVE_BARS",
            },
        },
    }

    a6_quote_cases = {
        name: {
            "input": inp,
            "expected": normalize_adr_py(
                symbol=inp["symbol"],
                as_of_utc_sec=inp["asOfUtcSec"],
                is_eod_mode=inp["isEodMode"],
                max_quote_age_sec=inp["maxQuoteAgeSec"],
                l1_candidate=inp["l1Candidate"],
                trade_candidate=inp["tradeCandidate"],
                reference_candidate=inp["referenceCandidate"],
            ),
        }
        for name, inp in quote_inputs.items()
    }

    # Parity scenarios (BYMA 6800 vs ADR 50 => CCL = 1360 vs Sovereign CCL ~1300 -> zScore > 3)
    spread_history = []
    for idx in range(30):
        t = as_of_utc_sec - (30 - idx) * 86_400
        # Mean-reverting stationary cycle in AR(1): x_t in { -0.004, +0.002 } range around mu ~ 0
        ccl_sov = 1300.0
        osc = 0.003 * math.sin(idx * 1.1) + 0.002 * math.cos(idx * 0.7)
        ccl_ggal_h = ccl_sov * math.exp(osc)
        spread_history.append({"time": t, "cclGgal24h": round(ccl_ggal_h, 8), "cclSovereign": ccl_sov})

    bonds_py = [
        {"ticker": "AL30", "arsBid": "130000", "arsAsk": "130100", "usdBid": "100.00", "usdAsk": "100.08"},
        {"ticker": "GD30", "arsBid": "130050", "arsAsk": "130150", "usdBid": "100.04", "usdAsk": "100.12"},
    ]

    a6_parity_cases = {
        "A6_2_LAST_ONLY_INDICATIVE": eval_parity_py(
            as_of_utc_sec=as_of_utc_sec,
            is_eod_mode=False,
            byma_bid="6798",
            byma_ask="6802",
            adr_norm=a6_quote_cases["A6_1_FMP_LAST_ONLY"]["expected"],
            sofr_annual="0.043",
            bonds=bonds_py,
            spread_history=spread_history,
        ),
        "A6_3_LIVE_BID_ASK_EXECUTABLE": eval_parity_py(
            as_of_utc_sec=as_of_utc_sec,
            is_eod_mode=False,
            byma_bid="6798",
            byma_ask="6802",
            adr_norm=a6_quote_cases["A6_3_LIVE_BID_ASK"]["expected"],
            sofr_annual="0.043",
            bonds=bonds_py,
            spread_history=spread_history,
        ),
        "A6_5_EOD_CLOSE_REF": eval_parity_py(
            as_of_utc_sec=as_of_utc_sec,
            is_eod_mode=True,
            byma_bid="6800",
            byma_ask="6800",
            adr_norm=a6_quote_cases["A6_5_EOD_CLOSE_REF"]["expected"],
            sofr_annual="0.043",
            bonds=bonds_py,
            spread_history=spread_history,
        ),
        "sharedInputs": {
            "asOfUtcSec": as_of_utc_sec,
            "bymaBid": 6798.0,
            "bymaAsk": 6802.0,
            "bymaLast": 6800.0,
            "sofrRateAnnual": 0.043,
            "bonds": bonds_py,
            "spreadHistory": spread_history,
        },
    }

    payload = {
        "meta": {
            "piece": "P1_A5_A6",
            "tolerance": 1e-9,
            "asOfUtcSec": as_of_utc_sec,
            "reportDate": report_date,
        },
        "a5SpotInvariance": a5_spot_invariance,
        "a5SeriesCases": a5_series_cases,
        "a5ExplicitMetadata": a5_explicit_metadata,
        "a5Conflicts": a5_conflicts,
        "a5ExpiryCases": a5_expiry_cases,
        "a6QuoteCases": a6_quote_cases,
        "a6ParityCases": a6_parity_cases,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {OUT_PATH}")


if __name__ == "__main__":
    main()
