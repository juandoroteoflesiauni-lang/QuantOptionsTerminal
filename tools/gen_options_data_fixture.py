#!/usr/bin/env python3
"""
tools/gen_options_data_fixture.py

Referencia INDEPENDIENTE en Python para la Pieza 1 (Contratos de Referencia y
Snapshot de Cadena de Opciones de Massive). Genera `fixtures/options_data_reference.json`.

Implementación escrita directamente desde la especificación y reglas de dominio
(sin importar ni copiar la lógica TypeScript):
  - Fechas civiles `YYYY-MM-DD` validadas con calendario real y cierre nominal
    `16:00 America/New_York` convertido a segundos UTC enteros vía `zoneinfo`.
  - DTE calendario calculado en zona `America/New_York` (inmune al cambio de
    día UTC tras las 19:00 EST / 20:00 EDT).
  - Conversión de timestamps numéricos desde nanosegundos (`>= 1e15`) o
    milisegundos (`1e12 <= ts < 1e15`) a segundos UTC enteros; rechazo a `"NaN"`
    si la unidad es ambigua (p. ej. segundos crudos `< 1e12`), negativa o no finita.
  - Clasificación explícita de binarias (`type == 'binary'` o
    `underlying_type == 'kpi'`) y ajustadas (`additional_underlyings` no vacío
    o multiplicador distinto de `standard_shares_per_contract`).
  - Serialización JSON de `NaN` como `"NaN"` para verificación exacta en Vitest.

Uso:
  python tools/gen_options_data_fixture.py
"""
from __future__ import annotations

import json
import math
import re
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
from zoneinfo import ZoneInfo

FIXTURE_PATH = Path("fixtures") / "options_data_reference.json"
ET_TZ = ZoneInfo("America/New_York")
UTC_TZ = ZoneInfo("UTC")
MAX_TIME_SECONDS = 100_000_000_000  # 1e11
EXP_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
AUTH_PARAM_RE = re.compile(r"([?&](?:apikey|api_key|api-key)=)[^&\s]+", re.IGNORECASE)
ALLOWED_MIRROR_ORIGINS = {"https://api.polygon.io", "https://api.massive.com"}


def json_num(value: float) -> float | str:
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    return float(value)


def redact_text(text: str, secrets: list[str]) -> str:
    out = text
    for secret in secrets:
        if secret:
            out = out.replace(secret, "<redacted>")
    return AUTH_PARAM_RE.sub(r"\1<redacted>", out)


def is_finite_num(val: Any) -> bool:
    return isinstance(val, (int, float)) and not isinstance(val, bool) and math.isfinite(val)


def to_finite_or_nan(val: Any) -> float | str:
    return float(val) if is_finite_num(val) else "NaN"


def to_non_neg_or_nan(val: Any) -> float | str:
    return float(val) if (is_finite_num(val) and val >= 0) else "NaN"


def to_pos_or_nan(val: Any) -> float | str:
    return float(val) if (is_finite_num(val) and val > 0) else "NaN"


def parse_exp_date(val: Any) -> tuple[str, int, date] | None:
    if not isinstance(val, str):
        return None
    m = EXP_RE.match(val.strip())
    if m is None:
        return None
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if y < 1970 or y > 2200:
        return None
    try:
        cal = date(y, mo, d)
    except ValueError:
        return None
    close_dt = datetime.combine(cal, time(16, 0), tzinfo=ET_TZ)
    exp_sec = int(close_dt.timestamp())
    if exp_sec <= 0 or exp_sec > MAX_TIME_SECONDS:
        return None
    return cal.isoformat(), exp_sec, cal


def parse_provider_ts(val: Any) -> tuple[int | str, bool]:
    if val is None:
        return "NaN", False
    if not is_finite_num(val) or val <= 0 or int(val) != val:
        return "NaN", True
    if 1e15 <= val <= MAX_TIME_SECONDS * 1e9:
        sec = int(val // 1_000_000_000)
        return (sec, False) if 0 < sec <= MAX_TIME_SECONDS else ("NaN", True)
    if 1e12 <= val < 1e15:
        sec = int(val // 1_000)
        return (sec, False) if 0 < sec <= MAX_TIME_SECONDS else ("NaN", True)
    return "NaN", True


def empty_discard_counts() -> dict[str, int]:
    return {
        "malformedRow": 0,
        "invalidTicker": 0,
        "invalidExpiration": 0,
        "invalidStrike": 0,
        "invalidContractType": 0,
        "invalidSharesPerContract": 0,
        "duplicate": 0,
        "binaryExcluded": 0,
        "adjustedExcluded": 0,
        "outOfDteRange": 0,
        "outOfStrikeRange": 0,
        "filteredContractType": 0,
    }


def evaluate_filters(
    *,
    is_binary: bool,
    is_adjusted: bool,
    contract_type: str,
    strike: float,
    exp_cal: date,
    opts: dict[str, Any],
) -> str | None:
    if is_binary and opts.get("excludeBinary", True):
        return "binaryExcluded"
    if is_adjusted and opts.get("excludeAdjusted", True):
        return "adjustedExcluded"
    ct_filter = opts.get("contractType")
    if ct_filter is not None and contract_type != ct_filter:
        return "filteredContractType"
    min_k = opts.get("minStrike")
    max_k = opts.get("maxStrike")
    if (min_k is not None and strike < min_k) or (max_k is not None and strike > max_k):
        return "outOfStrikeRange"
    min_dte = opts.get("minDte")
    max_dte = opts.get("maxDte")
    now_sec = opts.get("now")
    if (min_dte is not None or max_dte is not None) and now_sec is not None:
        now_et_date = datetime.fromtimestamp(now_sec, tz=UTC_TZ).astimezone(ET_TZ).date()
        dte = (exp_cal - now_et_date).days
        if (min_dte is not None and dte < min_dte) or (max_dte is not None and dte > max_dte):
            return "outOfDteRange"
    return None


def normalize_contracts_py(raw: Any, opts: dict[str, Any]) -> dict[str, Any]:
    counts = empty_discard_counts()
    discards: list[dict[str, Any]] = []
    malformed_response = not isinstance(raw, dict)
    provider_error = None
    rows: list[Any] = []

    if isinstance(raw, dict):
        st = raw.get("status")
        if isinstance(st, str) and st.upper() != "OK":
            msg = raw.get("error", raw.get("message", st))
            if not isinstance(msg, (str, int, float, bool)):
                msg = st
            provider_error = {"code": 0, "message": redact_text(str(msg), [])}
        res = raw.get("results")
        if res is None:
            rows = []
        elif isinstance(res, list):
            rows = res
        else:
            malformed_response = True

    seen: set[str] = set()
    accepted: list[dict[str, Any]] = []
    binary_detected = 0
    adjusted_detected = 0
    std_spc = float(opts.get("standardSharesPerContract", 100))

    def rec(cause: str, ticker: str | None) -> None:
        counts[cause] += 1
        discards.append({"cause": cause, "ticker": ticker})

    for row in rows:
        if not isinstance(row, dict):
            rec("malformedRow", None)
            continue
        t_raw = row.get("ticker")
        ticker = t_raw.strip() if isinstance(t_raw, str) and t_raw.strip() else None
        if ticker is None:
            rec("invalidTicker", None)
            continue
        u_raw = row.get("underlying_ticker")
        underlying = u_raw.strip() if isinstance(u_raw, str) and u_raw.strip() else None
        if underlying is None:
            rec("malformedRow", ticker)
            continue
        ct = row.get("contract_type")
        if ct not in ("call", "put", "other"):
            rec("invalidContractType", ticker)
            continue
        exp = parse_exp_date(row.get("expiration_date"))
        if exp is None:
            rec("invalidExpiration", ticker)
            continue
        exp_str, exp_time, exp_cal = exp

        kind = row.get("type") if row.get("type") in ("standard", "binary") else None
        utype = row.get("underlying_type") if row.get("underlying_type") in ("equity", "kpi") else None
        is_binary = kind == "binary" or utype == "kpi"

        k_raw = row.get("strike_price")
        if not is_finite_num(k_raw) or (not is_binary and k_raw <= 0):
            rec("invalidStrike", ticker)
            continue
        spc_raw = row.get("shares_per_contract")
        if not is_finite_num(spc_raw) or spc_raw <= 0:
            rec("invalidSharesPerContract", ticker)
            continue

        add_raw = row.get("additional_underlyings")
        if add_raw is not None and not isinstance(add_raw, list):
            rec("malformedRow", ticker)
            continue
        add_items: list[dict[str, Any]] = []
        if isinstance(add_raw, list):
            for entry in add_raw:
                if isinstance(entry, dict):
                    add_items.append({
                        "type": entry.get("type") if isinstance(entry.get("type"), str) else "",
                        "underlying": entry.get("underlying") if isinstance(entry.get("underlying"), str) else "",
                        "amount": to_finite_or_nan(entry.get("amount")),
                    })
                else:
                    add_items.append({"type": "", "underlying": "", "amount": "NaN"})

        if ticker in seen:
            rec("duplicate", ticker)
            continue
        seen.add(ticker)

        is_adjusted = (not is_binary) and (len(add_items) > 0 or float(spc_raw) != std_spc)
        if is_binary:
            binary_detected += 1
        if is_adjusted:
            adjusted_detected += 1

        f_cause = evaluate_filters(
            is_binary=is_binary,
            is_adjusted=is_adjusted,
            contract_type=ct,
            strike=float(k_raw),
            exp_cal=exp_cal,
            opts=opts,
        )
        if f_cause is not None:
            rec(f_cause, ticker)
            continue

        corr = row.get("correction")
        corr_val = int(corr) if is_finite_num(corr) and int(corr) == corr else None
        accepted.append({
            "ticker": ticker,
            "underlyingTicker": underlying,
            "contractType": ct,
            "exerciseStyle": row.get("exercise_style") if row.get("exercise_style") in ("american", "european", "bermudan") else None,
            "expirationDate": exp_str,
            "expirationTime": exp_time,
            "strikePrice": float(k_raw),
            "sharesPerContract": float(spc_raw),
            "primaryExchange": row.get("primary_exchange").strip() if isinstance(row.get("primary_exchange"), str) and row.get("primary_exchange").strip() else None,
            "cfi": row.get("cfi").strip() if isinstance(row.get("cfi"), str) and row.get("cfi").strip() else None,
            "correction": corr_val,
            "kind": kind,
            "underlyingType": utype,
            "additionalUnderlyings": add_items,
            "isBinary": is_binary,
            "isAdjusted": is_adjusted,
            "isNonStandard": is_binary or is_adjusted,
        })

    in_tickers = [c["ticker"] for c in accepted]
    sorted_acc = sorted(accepted, key=lambda c: (c["expirationDate"], c["strikePrice"], c["contractType"], c["ticker"]))
    reordered = [c["ticker"] for c in sorted_acc] != in_tickers
    malformed_disc = sum(counts[k] for k in ("malformedRow", "invalidTicker", "invalidExpiration", "invalidStrike", "invalidContractType", "invalidSharesPerContract"))
    filter_excl = sum(counts[k] for k in ("outOfDteRange", "outOfStrikeRange", "filteredContractType"))
    return {
        "contracts": sorted_acc,
        "report": {
            "provider": "massive",
            "received": len(rows),
            "accepted": len(sorted_acc),
            "discarded": len(discards),
            "discardCounts": counts,
            "discards": discards,
            "binaryDetected": binary_detected,
            "adjustedDetected": adjusted_detected,
            "binaryExcluded": counts["binaryExcluded"],
            "adjustedExcluded": counts["adjustedExcluded"],
            "malformedDiscarded": malformed_disc,
            "duplicateDiscarded": counts["duplicate"],
            "filterExcluded": filter_excl,
            "reordered": reordered,
            "malformedResponse": malformed_response,
            "providerError": provider_error,
        },
    }


def normalize_snapshot_py(
    raw: Any,
    opts: dict[str, Any],
    ref_contracts: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    ref_map = {c["ticker"]: c for c in (ref_contracts or [])}
    counts = empty_discard_counts()
    discards: list[dict[str, Any]] = []
    malformed_response = not isinstance(raw, dict)
    provider_error = None
    rows: list[Any] = []

    if isinstance(raw, dict):
        st = raw.get("status")
        if isinstance(st, str) and st.upper() != "OK":
            msg = raw.get("error", raw.get("message", st))
            if not isinstance(msg, (str, int, float, bool)):
                msg = st
            provider_error = {"code": 0, "message": redact_text(str(msg), [])}
        res = raw.get("results")
        if res is None:
            rows = []
        elif isinstance(res, list):
            rows = res
        else:
            malformed_response = True

    seen: set[str] = set()
    accepted: list[dict[str, Any]] = []
    binary_detected = 0
    adjusted_detected = 0
    empty_greeks = 0
    iv_missing = 0
    empty_day = 0
    empty_quote = 0
    empty_trade = 0
    invalid_ts = 0
    seen_price = False
    seen_value = False
    std_spc = float(opts.get("standardSharesPerContract", 100))

    def rec(cause: str, ticker: str | None) -> None:
        counts[cause] += 1
        discards.append({"cause": cause, "ticker": ticker})

    for row in rows:
        if not isinstance(row, dict):
            rec("malformedRow", None)
            continue
        det = row.get("details")
        if not isinstance(det, dict):
            rec("malformedRow", None)
            continue
        t_raw = det.get("ticker")
        ticker = t_raw.strip() if isinstance(t_raw, str) and t_raw.strip() else None
        if ticker is None:
            rec("invalidTicker", None)
            continue
        ct = det.get("contract_type")
        if ct not in ("call", "put"):
            rec("invalidContractType", ticker)
            continue
        exp = parse_exp_date(det.get("expiration_date"))
        if exp is None:
            rec("invalidExpiration", ticker)
            continue
        exp_str, exp_time, exp_cal = exp

        ref = ref_map.get(ticker)
        det_kind = det.get("type") if det.get("type") in ("standard", "binary") else None
        det_utype = det.get("underlying_type") if det.get("underlying_type") in ("equity", "kpi") else None
        is_binary = (det_kind == "binary") or (det_utype == "kpi") or bool(ref and ref["isBinary"])

        k_raw = det.get("strike_price")
        if not is_finite_num(k_raw) or (not is_binary and k_raw <= 0):
            rec("invalidStrike", ticker)
            continue
        spc_raw = det.get("shares_per_contract")
        if not is_finite_num(spc_raw) or spc_raw <= 0:
            rec("invalidSharesPerContract", ticker)
            continue

        add_raw = det.get("additional_underlyings")
        if add_raw is not None and not isinstance(add_raw, list):
            rec("malformedRow", ticker)
            continue
        add_items: list[dict[str, Any]] = []
        if isinstance(add_raw, list):
            for entry in add_raw:
                if isinstance(entry, dict):
                    add_items.append({
                        "type": entry.get("type") if isinstance(entry.get("type"), str) else "",
                        "underlying": entry.get("underlying") if isinstance(entry.get("underlying"), str) else "",
                        "amount": to_finite_or_nan(entry.get("amount")),
                    })
                else:
                    add_items.append({"type": "", "underlying": "", "amount": "NaN"})
        elif ref is not None:
            add_items = list(ref["additionalUnderlyings"])

        if ticker in seen:
            rec("duplicate", ticker)
            continue
        seen.add(ticker)

        is_adjusted = (not is_binary) and (
            len(add_items) > 0
            or float(spc_raw) != std_spc
            or bool(ref and ref["isAdjusted"])
        )
        if is_binary:
            binary_detected += 1
        if is_adjusted:
            adjusted_detected += 1

        f_cause = evaluate_filters(
            is_binary=is_binary,
            is_adjusted=is_adjusted,
            contract_type=ct,
            strike=float(k_raw),
            exp_cal=exp_cal,
            opts=opts,
        )
        if f_cause is not None:
            rec(f_cause, ticker)
            continue

        g_raw = row.get("greeks")
        if not isinstance(g_raw, dict) or len(g_raw) == 0:
            greeks = {"delta": "NaN", "gamma": "NaN", "theta": "NaN", "vega": "NaN"}
            greeks_missing = True
        else:
            greeks = {
                "delta": to_finite_or_nan(g_raw.get("delta")),
                "gamma": to_finite_or_nan(g_raw.get("gamma")),
                "theta": to_finite_or_nan(g_raw.get("theta")),
                "vega": to_finite_or_nan(g_raw.get("vega")),
            }
            greeks_missing = all(v == "NaN" for v in greeks.values())

        d_raw = row.get("day")
        if not isinstance(d_raw, dict) or len(d_raw) == 0:
            day = {k: "NaN" for k in ("open", "high", "low", "close", "volume", "vwap", "previousClose", "change", "changePercent", "updatedAt")}
            day_empty = True
        else:
            d_ts, d_bad = parse_provider_ts(d_raw.get("last_updated"))
            invalid_ts += int(d_bad)
            day = {
                "open": to_non_neg_or_nan(d_raw.get("open")),
                "high": to_non_neg_or_nan(d_raw.get("high")),
                "low": to_non_neg_or_nan(d_raw.get("low")),
                "close": to_non_neg_or_nan(d_raw.get("close")),
                "volume": to_non_neg_or_nan(d_raw.get("volume")),
                "vwap": to_non_neg_or_nan(d_raw.get("vwap")),
                "previousClose": to_non_neg_or_nan(d_raw.get("previous_close")),
                "change": to_finite_or_nan(d_raw.get("change")),
                "changePercent": to_finite_or_nan(d_raw.get("change_percent")),
                "updatedAt": d_ts,
            }
            day_empty = all(day[k] == "NaN" for k in ("open", "high", "low", "close", "volume", "vwap", "previousClose", "updatedAt"))

        q_raw = row.get("last_quote")
        if not isinstance(q_raw, dict) or len(q_raw) == 0:
            quote = {"bid": "NaN", "ask": "NaN", "midpoint": "NaN", "bidSize": "NaN", "askSize": "NaN", "bidExchange": None, "askExchange": None, "updatedAt": "NaN", "timeframe": None}
            quote_empty = True
        else:
            q_ts, q_bad = parse_provider_ts(q_raw.get("last_updated"))
            invalid_ts += int(q_bad)
            bex = q_raw.get("bid_exchange")
            aex = q_raw.get("ask_exchange")
            quote = {
                "bid": to_non_neg_or_nan(q_raw.get("bid")),
                "ask": to_non_neg_or_nan(q_raw.get("ask")),
                "midpoint": to_non_neg_or_nan(q_raw.get("midpoint")),
                "bidSize": to_non_neg_or_nan(q_raw.get("bid_size")),
                "askSize": to_non_neg_or_nan(q_raw.get("ask_size")),
                "bidExchange": int(bex) if is_finite_num(bex) and int(bex) == bex else None,
                "askExchange": int(aex) if is_finite_num(aex) and int(aex) == aex else None,
                "updatedAt": q_ts,
                "timeframe": q_raw.get("timeframe").strip() if isinstance(q_raw.get("timeframe"), str) and q_raw.get("timeframe").strip() else None,
            }
            quote_empty = all(quote[k] == "NaN" for k in ("bid", "ask", "midpoint", "updatedAt"))

        tr_raw = row.get("last_trade")
        if not isinstance(tr_raw, dict) or len(tr_raw) == 0:
            trade = {"price": "NaN", "size": "NaN", "exchange": None, "conditions": [], "sipTimestamp": "NaN", "timeframe": None}
            trade_empty = True
        else:
            tr_ts, tr_bad = parse_provider_ts(tr_raw.get("sip_timestamp"))
            invalid_ts += int(tr_bad)
            ex = tr_raw.get("exchange")
            conds = [int(c) for c in (tr_raw.get("conditions") or []) if is_finite_num(c) and int(c) == c] if isinstance(tr_raw.get("conditions"), list) else []
            trade = {
                "price": to_pos_or_nan(tr_raw.get("price")),
                "size": to_non_neg_or_nan(tr_raw.get("size")),
                "exchange": int(ex) if is_finite_num(ex) and int(ex) == ex else None,
                "conditions": conds,
                "sipTimestamp": tr_ts,
                "timeframe": tr_raw.get("timeframe").strip() if isinstance(tr_raw.get("timeframe"), str) and tr_raw.get("timeframe").strip() else None,
            }
            trade_empty = all(trade[k] == "NaN" for k in ("price", "size", "sipTimestamp"))

        ua_raw = row.get("underlying_asset")
        ua_norm = None
        if isinstance(ua_raw, dict) and len(ua_raw) > 0:
            ua_ticker = ua_raw.get("ticker").strip() if isinstance(ua_raw.get("ticker"), str) else ""
            if "price" in ua_raw and ua_raw.get("price") is not None:
                ua_price = to_pos_or_nan(ua_raw.get("price"))
                ua_src = "price"
            elif "price" in ua_raw:
                ua_price = "NaN"
                ua_src = "price"
            elif "value" in ua_raw and ua_raw.get("value") is not None:
                ua_price = to_pos_or_nan(ua_raw.get("value"))
                ua_src = "value"
            elif "value" in ua_raw:
                ua_price = "NaN"
                ua_src = "value"
            else:
                ua_price = "NaN"
                ua_src = None
            if ua_ticker != "" or ua_price != "NaN":
                ua_ts, ua_bad = parse_provider_ts(ua_raw.get("last_updated"))
                invalid_ts += int(ua_bad)
                ua_norm = {
                    "ticker": ua_ticker,
                    "price": ua_price,
                    "sourceField": ua_src,
                    "changeToBreakEven": to_finite_or_nan(ua_raw.get("change_to_break_even")),
                    "updatedAt": ua_ts,
                    "timeframe": ua_raw.get("timeframe").strip() if isinstance(ua_raw.get("timeframe"), str) and ua_raw.get("timeframe").strip() else None,
                }
                if ua_price != "NaN":
                    if ua_src == "price":
                        seen_price = True
                    elif ua_src == "value":
                        seen_value = True

        iv_val = to_non_neg_or_nan(row.get("implied_volatility"))
        oi_val = to_non_neg_or_nan(row.get("open_interest"))
        be_val = to_finite_or_nan(row.get("break_even_price"))

        if greeks_missing:
            empty_greeks += 1
        if iv_val == "NaN":
            iv_missing += 1
        if day_empty:
            empty_day += 1
        if quote_empty:
            empty_quote += 1
        if trade_empty:
            empty_trade += 1

        accepted.append({
            "ticker": ticker,
            "contractType": ct,
            "exerciseStyle": det.get("exercise_style") if det.get("exercise_style") in ("american", "european", "bermudan") else (ref["exerciseStyle"] if ref else None),
            "expirationDate": exp_str,
            "expirationTime": exp_time,
            "strikePrice": float(k_raw),
            "sharesPerContract": float(spc_raw),
            "breakEvenPrice": be_val,
            "impliedVolatility": iv_val,
            "openInterest": oi_val,
            "greeks": greeks,
            "greeksMissing": greeks_missing,
            "day": day,
            "lastQuote": quote,
            "lastTrade": trade,
            "underlyingAsset": ua_norm,
            "additionalUnderlyings": add_items,
            "isBinary": is_binary,
            "isAdjusted": is_adjusted,
            "isNonStandard": is_binary or is_adjusted,
        })

    in_tickers = [c["ticker"] for c in accepted]
    sorted_acc = sorted(accepted, key=lambda c: (c["expirationDate"], c["strikePrice"], c["contractType"], c["ticker"]))
    reordered = [c["ticker"] for c in sorted_acc] != in_tickers

    best_ua = None
    for c in sorted_acc:
        cand = c["underlyingAsset"]
        if cand is None:
            continue
        if best_ua is None:
            best_ua = cand
            continue
        bts, cts = best_ua["updatedAt"], cand["updatedAt"]
        if bts == "NaN" and cts != "NaN":
            best_ua = cand
        elif bts != "NaN" and cts != "NaN" and cts > bts:
            best_ua = cand
        elif best_ua["price"] == "NaN" and cand["price"] != "NaN":
            best_ua = cand

    ua_summary = "mixed" if (seen_price and seen_value) else ("price" if seen_price else ("value" if seen_value else "missing"))
    malformed_disc = sum(counts[k] for k in ("malformedRow", "invalidTicker", "invalidExpiration", "invalidStrike", "invalidContractType", "invalidSharesPerContract"))
    filter_excl = sum(counts[k] for k in ("outOfDteRange", "outOfStrikeRange", "filteredContractType"))

    return {
        "contracts": sorted_acc,
        "underlying": best_ua,
        "report": {
            "provider": "massive",
            "received": len(rows),
            "accepted": len(sorted_acc),
            "discarded": len(discards),
            "discardCounts": counts,
            "discards": discards,
            "binaryDetected": binary_detected,
            "adjustedDetected": adjusted_detected,
            "binaryExcluded": counts["binaryExcluded"],
            "adjustedExcluded": counts["adjustedExcluded"],
            "malformedDiscarded": malformed_disc,
            "duplicateDiscarded": counts["duplicate"],
            "filterExcluded": filter_excl,
            "reordered": reordered,
            "malformedResponse": malformed_response,
            "providerError": provider_error,
            "emptyGreeks": empty_greeks,
            "ivMissing": iv_missing,
            "emptyDay": empty_day,
            "emptyLastQuote": empty_quote,
            "emptyLastTrade": empty_trade,
            "invalidTimestamps": invalid_ts,
            "underlyingSource": ua_summary,
        },
    }


def rewrite_next_url(next_url: str, base_url: str) -> str | None:
    b = urlparse(base_url)
    n = urlparse(next_url)
    if not n.scheme:
        n = urlparse(f"{b.scheme}://{b.netloc}{next_url}")
    if n.scheme != "https" or n.username or n.password:
        return None
    n_origin = f"{n.scheme}://{n.netloc}"
    b_origin = f"{b.scheme}://{b.netloc}"
    if n_origin != b_origin and n_origin not in ALLOWED_MIRROR_ORIGINS:
        return None
    return urlunparse((b.scheme, b.netloc, n.path, n.params, n.query, ""))


def with_api_key_py(url: str, api_key: str) -> str:
    p = urlparse(url)
    qs = [(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True) if k.lower() not in {"apikey", "api_key", "api-key"}]
    param_name = "apikey" if (p.hostname or "").lower() == "api.massive.com" else "apiKey"
    qs.append((param_name, api_key))
    return urlunparse((p.scheme, p.netloc, p.path, p.params, urlencode(qs), ""))


def build_fixture() -> dict[str, Any]:
    now_evening_et = int(datetime(2026, 11, 13, 20, 0, tzinfo=ET_TZ).timestamp())  # 2026-11-14T01:00Z!

    c1_raw = {
        "status": "OK",
        "results": [
            {
                "cfi": "OCESCS",
                "contract_type": "call",
                "exercise_style": "european",
                "expiration_date": "2026-11-13",
                "primary_exchange": "XASE",
                "shares_per_contract": 100,
                "strike_price": 710,
                "ticker": "O:B1SPY261113C00710000",
                "underlying_ticker": "SPY",
                "additional_underlyings": [{"type": "currency", "underlying": "USD", "amount": 100}],
                "type": "binary",
                "underlying_type": "equity",
            },
            {
                "cfi": "OCASPS",
                "contract_type": "call",
                "exercise_style": "american",
                "expiration_date": "2026-11-20",
                "primary_exchange": "BATO",
                "shares_per_contract": 100,
                "strike_price": 25,
                "ticker": "O:GME1261120C00025000",
                "underlying_ticker": "GME",
                "additional_underlyings": [
                    {"type": "equity", "underlying": "GME", "amount": 100},
                    {"type": "currency", "underlying": "USD", "amount": 5.5},
                ],
            },
            {
                "cfi": "OCASPS",
                "contract_type": "put",
                "exercise_style": "american",
                "expiration_date": "2026-11-20",
                "primary_exchange": "BATO",
                "shares_per_contract": 100,
                "strike_price": 200,
                "ticker": "O:AAPL261120P00200000",
                "underlying_ticker": "AAPL",
            },
            {
                "cfi": "OCASPS",
                "contract_type": "call",
                "exercise_style": "american",
                "expiration_date": "2026-11-20",
                "primary_exchange": "BATO",
                "shares_per_contract": 100,
                "strike_price": 195,
                "ticker": "O:AAPL261120C00195000",
                "underlying_ticker": "AAPL",
            },
            {
                "contract_type": "call",
                "exercise_style": "american",
                "expiration_date": "2026-11-20",
                "shares_per_contract": 10,
                "strike_price": 50,
                "ticker": "O:MINI261120C00050000",
                "underlying_ticker": "MINI",
            },
        ],
    }

    c3_raw = {
        "status": "ERROR",
        "error": "rate error on https://api.massive.com/v3/reference?apikey=SECRET_KEY_1",
        "results": [
            "not-an-object",
            {"ticker": "   ", "underlying_ticker": "SPY", "contract_type": "call", "expiration_date": "2026-11-20", "strike_price": 100, "shares_per_contract": 100},
            {"ticker": "O:BAD_EXP", "underlying_ticker": "SPY", "contract_type": "call", "expiration_date": "2026-02-30", "strike_price": 100, "shares_per_contract": 100},
            {"ticker": "O:BAD_STRIKE", "underlying_ticker": "SPY", "contract_type": "call", "expiration_date": "2026-11-20", "strike_price": -5, "shares_per_contract": 100},
            {"ticker": "O:BAD_CT", "underlying_ticker": "SPY", "contract_type": "swap", "expiration_date": "2026-11-20", "strike_price": 100, "shares_per_contract": 100},
            {"ticker": "O:DAY0", "underlying_ticker": "SPY", "contract_type": "call", "expiration_date": "2026-11-13", "strike_price": 100, "shares_per_contract": 100},
            {"ticker": "O:DAY35", "underlying_ticker": "SPY", "contract_type": "call", "expiration_date": "2026-12-18", "strike_price": 100, "shares_per_contract": 100},
            {"ticker": "O:LOW_K", "underlying_ticker": "SPY", "contract_type": "call", "expiration_date": "2026-11-20", "strike_price": 50, "shares_per_contract": 100},
            {"ticker": "O:OK1", "underlying_ticker": "SPY", "contract_type": "call", "expiration_date": "2026-11-20", "strike_price": 100, "shares_per_contract": 100},
            {"ticker": "O:OK1", "underlying_ticker": "SPY", "contract_type": "call", "expiration_date": "2026-11-20", "strike_price": 100, "shares_per_contract": 100},
        ],
    }
    c3_opts = {"minDte": 1, "maxDte": 14, "minStrike": 90, "maxStrike": 120, "now": now_evening_et}

    # Referencia para snapshot s1
    s1_ref_contracts = normalize_contracts_py(c1_raw, {"excludeBinary": False, "excludeAdjusted": False})["contracts"]
    s1_raw = {
        "status": "OK",
        "results": [
            {
                "break_even_price": 760.905,
                "day": {
                    "change": -0.82,
                    "change_percent": -47.4,
                    "close": 0.91,
                    "high": 2.03,
                    "last_updated": 1794580622047000000,
                    "low": 0.91,
                    "open": 1.87,
                    "previous_close": 1.73,
                    "volume": 16228,
                    "vwap": 1.6091,
                },
                "details": {
                    "contract_type": "call",
                    "exercise_style": "american",
                    "expiration_date": "2026-11-13",
                    "shares_per_contract": 100,
                    "strike_price": 760,
                    "ticker": "O:SPY261113C00760000",
                },
                "greeks": {
                    "delta": 0.27457593553768195,
                    "gamma": 0.0633171656071293,
                    "theta": -2.0812456642282964,
                    "vega": 0.090618033036695,
                },
                "implied_volatility": 0.20388271212136563,
                "last_quote": {
                    "ask": 0.91,
                    "ask_size": 100,
                    "ask_exchange": 301,
                    "bid": 0.9,
                    "bid_size": 118,
                    "bid_exchange": 320,
                    "last_updated": 1794580645839102810,
                    "midpoint": 0.905,
                    "timeframe": "REAL-TIME",
                },
                "last_trade": {
                    "sip_timestamp": 1794580645919057658,
                    "conditions": [219],
                    "price": 0.91,
                    "size": 10,
                    "exchange": 318,
                    "timeframe": "REAL-TIME",
                },
                "open_interest": 12256,
                "underlying_asset": {
                    "change_to_break_even": 4.135,
                    "last_updated": 1794580646527788926,
                    "price": 756.77,
                    "ticker": "SPY",
                    "timeframe": "REAL-TIME",
                },
            },
            {
                "day": {},
                "details": {
                    "contract_type": "put",
                    "exercise_style": "american",
                    "expiration_date": "2026-11-13",
                    "shares_per_contract": 100,
                    "strike_price": 750,
                    "ticker": "O:SPY261113P00750000",
                },
                "greeks": {},
                "last_quote": {
                    "ask": 0.15,
                    "bid": 0.0,
                    "midpoint": 0.075,
                    "last_updated": 1794580645123,
                    "timeframe": "REAL-TIME",
                },
                "last_trade": {},
                "open_interest": 420,
                "underlying_asset": {
                    "last_updated": 1794580646,  # segundos crudos -> inválido -> NaN
                    "price": 756.77,
                    "ticker": "SPY",
                    "timeframe": "REAL-TIME",
                },
            },
            {
                "day": {},
                "details": {
                    "contract_type": "call",
                    "exercise_style": "european",
                    "expiration_date": "2026-11-13",
                    "shares_per_contract": 100,
                    "strike_price": 710,
                    "ticker": "O:B1SPY261113C00710000",
                },
                "last_quote": {"ask": 1.02, "bid": 0.98, "midpoint": 1.0, "last_updated": 1794580454739282795, "timeframe": "REAL-TIME"},
                "last_trade": {},
                "open_interest": 0,
                "underlying_asset": {"last_updated": 1794580646527788926, "price": 756.77, "ticker": "SPY", "timeframe": "REAL-TIME"},
            },
            {
                "day": {},
                "details": {
                    "contract_type": "call",
                    "exercise_style": "american",
                    "expiration_date": "2026-11-20",
                    "shares_per_contract": 100,
                    "strike_price": 25,
                    "ticker": "O:GME1261120C00025000",
                },
                "greeks": {"delta": 0.5},
                "last_quote": {},
                "last_trade": {},
                "open_interest": 10,
            },
            {
                "details": {
                    "contract_type": "call",
                    "exercise_style": "american",
                    "expiration_date": "2026-11-13",
                    "shares_per_contract": 100,
                    "strike_price": 760,
                    "ticker": "O:SPY261113C00760000",
                },
            },
        ],
    }

    s2_raw = {
        "status": "OK",
        "results": [
            {
                "day": {},
                "details": {
                    "contract_type": "call",
                    "exercise_style": "european",
                    "expiration_date": "2026-11-13",
                    "shares_per_contract": 100,
                    "strike_price": 7580,
                    "ticker": "O:SPXW261113C07580000",
                },
                "greeks": {"delta": 0.52, "gamma": 0.011, "theta": -4.2, "vega": 1.8},
                "implied_volatility": 0.165,
                "last_quote": {"ask": 18.2, "bid": 17.8, "midpoint": 18.0, "last_updated": 1794581119251379225, "timeframe": "REAL-TIME"},
                "last_trade": {},
                "open_interest": 1200,
                "underlying_asset": {"last_updated": 1794581115037000000, "value": 7584.43, "ticker": "I:SPX", "timeframe": "REAL-TIME"},
            },
            {
                "day": {},
                "details": {
                    "contract_type": "call",
                    "exercise_style": "european",
                    "expiration_date": "2026-11-13",
                    "shares_per_contract": 100,
                    "strike_price": 3000,
                    "ticker": "O:SPXW261113C03000000",
                },
                "greeks": {},
                "last_quote": {"ask": 4590.6, "bid": 4575.6, "midpoint": 4583.1, "last_updated": 1794581119251379225, "timeframe": "REAL-TIME"},
                "last_trade": {},
                "open_interest": 0,
                "underlying_asset": {"last_updated": 1794581115037000000, "value": 7584.43, "ticker": "I:SPX", "timeframe": "REAL-TIME"},
            },
        ],
    }

    s3_raw = {
        "status": "ERROR",
        "error": "invalid apiKey on ?apiKey=TOP_SECRET_VAL",
        "results": "should-be-array",
    }

    # Loader case 1: multipage I:SPX con mirror rewrite (api.polygon.io -> api.massive.com), binaria excluida via contracts, empty greeks -> NaN
    l1_key = "fixture-opt-secret-key"
    l1_base = "https://api.massive.com"
    l1_c_page1 = {
        "status": "OK",
        "results": [
            {
                "cfi": "OCESCS",
                "contract_type": "call",
                "exercise_style": "european",
                "expiration_date": "2026-11-13",
                "shares_per_contract": 100,
                "strike_price": 7500,
                "ticker": "O:B1SPX261113C07500000",
                "underlying_ticker": "SPX",
                "additional_underlyings": [{"type": "currency", "underlying": "USD", "amount": 100}],
                "type": "binary",
                "underlying_type": "equity",
            }
        ],
        "next_url": "https://api.polygon.io/v3/reference/options/contracts?cursor=c2",
    }
    l1_c_page2 = {
        "status": "OK",
        "results": [
            {
                "cfi": "OCEICS",
                "contract_type": "call",
                "exercise_style": "european",
                "expiration_date": "2026-11-13",
                "shares_per_contract": 100,
                "strike_price": 7580,
                "ticker": "O:SPXW261113C07580000",
                "underlying_ticker": "SPX",
            }
        ],
    }
    l1_s_page1 = {
        "status": "OK",
        "results": [
            {
                "day": {},
                "details": {
                    "contract_type": "call",
                    "exercise_style": "european",
                    "expiration_date": "2026-11-13",
                    "shares_per_contract": 100,
                    "strike_price": 7500,
                    "ticker": "O:B1SPX261113C07500000",
                },
                "last_quote": {"ask": 1.0, "bid": 0.9, "midpoint": 0.95, "last_updated": 1794581119000000000},
                "last_trade": {},
                "open_interest": 0,
                "underlying_asset": {"last_updated": 1794581115037000000, "value": 7584.43, "ticker": "I:SPX"},
            }
        ],
        "next_url": "https://api.massive.com/v3/snapshot/options/I:SPX?cursor=s2",
    }
    l1_s_page2 = {
        "status": "OK",
        "results": [
            s2_raw["results"][0],
            s2_raw["results"][1],
        ],
    }
    l1_c_all = normalize_contracts_py({"status": "OK", "results": l1_c_page1["results"] + l1_c_page2["results"]}, {"excludeBinary": False, "excludeAdjusted": False})
    l1_snap_expected = normalize_snapshot_py({"status": "OK", "results": l1_s_page1["results"] + l1_s_page2["results"]}, {}, l1_c_all["contracts"])
    l1_requests = [
        f"{l1_base}/v3/reference/options/contracts?underlying_ticker=SPX&limit=1000&apikey={l1_key}",
        with_api_key_py(rewrite_next_url(l1_c_page1["next_url"], l1_base) or "", l1_key),
        f"{l1_base}/v3/snapshot/options/I:SPX?limit=250&apikey={l1_key}",
        with_api_key_py(rewrite_next_url(l1_s_page1["next_url"], l1_base) or "", l1_key),
    ]

    # Loader case 2: next_url externo rechazado sin realizar petición al host atacante
    l2_raw_page1 = {
        "status": "OK",
        "results": [s2_raw["results"][0]],
        "next_url": "https://evil.example.com/v3/snapshot/options/I:SPX?cursor=steal&apiKey=attacker",
    }
    l2_expected_norm = normalize_snapshot_py({"status": "OK", "results": l2_raw_page1["results"]}, {})

    # Loader case 3: error HTTP con apiKey embebido en cuerpo -> redactado
    l3_key = "secret-value-xyz-987"
    l3_http_text = json.dumps({
        "status": "ERROR",
        "error": f"Forbidden for token {l3_key} at https://api.massive.com/v3/snapshot/options/SPY?apikey={l3_key}",
    })
    l3_expected_err = redact_text(json.loads(l3_http_text)["error"], [l3_key])

    return {
        "metadata": {
            "generator": "tools/gen_options_data_fixture.py",
            "command": "python tools/gen_options_data_fixture.py",
            "method": "Referencia independiente en Python (zoneinfo America/New_York, urllib.parse). Sin compartir código con TypeScript.",
            "nonFiniteEncoding": "La cadena \"NaN\" representa Number.NaN.",
        },
        "contracts_cases": {
            "c1_binary_and_adjusted_excluded": {
                "description": "Excluye binaria O:B1SPY, ajustada con additional_underlyings (shares=100) y mini (shares=10); ordena estándar",
                "raw": c1_raw,
                "options": {},
                "expected": normalize_contracts_py(c1_raw, {}),
            },
            "c2_include_binary_and_adjusted": {
                "description": "Conserva binaria y ajustadas cuando excludeBinary=false y excludeAdjusted=false",
                "raw": c1_raw,
                "options": {"excludeBinary": False, "excludeAdjusted": False},
                "expected": normalize_contracts_py(c1_raw, {"excludeBinary": False, "excludeAdjusted": False}),
            },
            "c3_discards_and_et_dte_rollover": {
                "description": "Descartes malformados, duplicados, DTE en zona ET (20:00 ET ya día siguiente en UTC) y redacción de error",
                "raw": c3_raw,
                "options": c3_opts,
                "expected": normalize_contracts_py(c3_raw, c3_opts),
            },
        },
        "snapshot_cases": {
            "s1_spy_binary_adjusted_empty_greeks_and_units": {
                "description": "Snapshot SPY: nanosegundos/ms a s UTC, segundos crudos rechazados, greeks:{} -> NaN, binaria y ajustada excluidas por referencia",
                "raw": s1_raw,
                "referenceRaw": c1_raw,
                "options": {},
                "expected": normalize_snapshot_py(s1_raw, {}, s1_ref_contracts),
            },
            "s2_index_ispx_underlying_value": {
                "description": "Snapshot I:SPX con underlying_asset.value (sin price), greeks vacíos -> NaN y estilo europeo",
                "raw": s2_raw,
                "referenceRaw": None,
                "options": {},
                "expected": normalize_snapshot_py(s2_raw, {}, None),
            },
            "s3_provider_error_and_malformed": {
                "description": "Error de proveedor con ?apiKey redactado y results malformado",
                "raw": s3_raw,
                "referenceRaw": None,
                "options": {},
                "expected": normalize_snapshot_py(s3_raw, {}, None),
            },
        },
        "loader_cases": {
            "l1_ispx_multipage_mirror_rewrite_and_binary_filter": {
                "description": "loadOptionChain('I:SPX') usa SPX sin I: en contracts y I:SPX en snapshot, reescribe mirror polygon->massive y excluye O:B1SPX",
                "options": {
                    "underlying": "I:SPX",
                    "apiKey": l1_key,
                    "baseUrl": l1_base,
                },
                "responses": [
                    {"status": 200, "ok": True, "text": json.dumps(l1_c_page1)},
                    {"status": 200, "ok": True, "text": json.dumps(l1_c_page2)},
                    {"status": 200, "ok": True, "text": json.dumps(l1_s_page1)},
                    {"status": 200, "ok": True, "text": json.dumps(l1_s_page2)},
                ],
                "expected": {
                    "requests": l1_requests,
                    "contracts": l1_snap_expected["contracts"],
                    "underlying": l1_snap_expected["underlying"],
                    "report": {
                        **l1_snap_expected["report"],
                        "pages": 4,
                        "referencePages": 2,
                        "snapshotPages": 2,
                        "stoppedReason": "noMorePages",
                        "snapshotUnderlyingAsset": "I:SPX",
                        "referenceUnderlyingTicker": "SPX",
                        "contractsReport": {
                            **l1_c_all["report"],
                            "pages": 2,
                            "stoppedReason": "noMorePages",
                            "referenceUnderlyingTicker": "SPX",
                        },
                    },
                },
            },
            "l2_rejects_external_next_url": {
                "description": "Rechaza next_url hacia host externo antes de enviar la clave",
                "options": {
                    "underlying": "I:SPX",
                    "apiKey": l1_key,
                    "baseUrl": l1_base,
                    "includeReferenceMetadata": False,
                },
                "responses": [
                    {"status": 200, "ok": True, "text": json.dumps(l2_raw_page1)},
                ],
                "expected": {
                    "requests": [
                        f"{l1_base}/v3/snapshot/options/I:SPX?limit=250&apikey={l1_key}",
                    ],
                    "contracts": l2_expected_norm["contracts"],
                    "underlying": l2_expected_norm["underlying"],
                    "report": {
                        **l2_expected_norm["report"],
                        "malformedResponse": True,
                        "pages": 1,
                        "referencePages": 0,
                        "snapshotPages": 1,
                        "stoppedReason": "malformedResponse",
                        "snapshotUnderlyingAsset": "I:SPX",
                        "referenceUnderlyingTicker": "SPX",
                        "contractsReport": None,
                    },
                },
            },
            "l3_http_error_secret_redaction": {
                "description": "Redacta secreto crudo y parámetro de query ante HTTP 403",
                "options": {
                    "underlying": "SPY",
                    "apiKey": l3_key,
                    "baseUrl": l1_base,
                    "includeReferenceMetadata": False,
                },
                "responses": [
                    {"status": 403, "ok": False, "text": l3_http_text},
                ],
                "expected": {
                    "requests": [
                        f"{l1_base}/v3/snapshot/options/SPY?limit=250&apikey={l3_key}",
                    ],
                    "stoppedReason": "providerError",
                    "providerError": {"code": 403, "message": l3_expected_err},
                },
            },
        },
    }


def main() -> None:
    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    data = build_fixture()
    FIXTURE_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {FIXTURE_PATH} cleanly.")


if __name__ == "__main__":
    main()
