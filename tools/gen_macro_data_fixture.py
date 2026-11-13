#!/usr/bin/env python3
"""
tools/gen_macro_data_fixture.py

Referencia INDEPENDIENTE en Python para la Pieza 4 (Macro, Fondeo SOFR,
Dividendos, Open Interest histórico y Unified Snapshot de Massive).
Genera `fixtures/macro_data_reference.json`.

Implementación escrita directamente desde las fórmulas de dominio y la
especificación REST (sin copiar la lógica TypeScript):
  - Curva US Treasury (`/fed/v1/treasury-yields`): conversión explícita `% -> decimal`,
    interpolación lineal en tasa y log-lineal sobre factores de descuento
    `P(T) = exp(-r(T) * T)` vía `exp`/`log` de punto flotante, anclaje overnight
    SOFR en `1/365` año, y rechazo explícito a `"NaN"` ante tenores faltantes,
    curvas vacías o extrapolación `'nan'`.
  - Fechas calendario `YYYY-MM-DD` (1900..2200) usando diferencia contra época UTC
    para soportar fechas históricas pre-1970 en Windows sin depender de `mktime`,
    más apertura regular `09:30 America/New_York` para `ex_dividend_date` y
    cierre `16:00 America/New_York` para expiraciones de opciones.
  - Serialización JSON estricta (`allow_nan=False`) codificando `NaN` como `"NaN"`.

Uso:
  python tools/gen_macro_data_fixture.py
"""
from __future__ import annotations

import json
import math
import re
from datetime import date, datetime, time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
from zoneinfo import ZoneInfo

FIXTURE_PATH = Path("fixtures") / "macro_data_reference.json"
ET_TZ = ZoneInfo("America/New_York")
UTC_TZ = ZoneInfo("UTC")
EPOCH_UTC = datetime(1970, 1, 1, tzinfo=UTC_TZ)
MAX_TIME_SECONDS = 100_000_000_000  # 1e11
DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
AUTH_PARAM_RE = re.compile(r"([?&](?:apikey|api_key|api-key)=)[^&\s]+", re.IGNORECASE)
ALLOWED_MIRROR_ORIGINS = {"https://api.polygon.io", "https://api.massive.com"}

TREASURY_TENORS: list[tuple[str, str, str, float]] = [
    ("yield_1_month", "yield1Month", "1M", 1.0 / 12.0),
    ("yield_3_month", "yield3Month", "3M", 3.0 / 12.0),
    ("yield_6_month", "yield6Month", "6M", 6.0 / 12.0),
    ("yield_1_year", "yield1Year", "1Y", 1.0),
    ("yield_2_year", "yield2Year", "2Y", 2.0),
    ("yield_3_year", "yield3Year", "3Y", 3.0),
    ("yield_5_year", "yield5Year", "5Y", 5.0),
    ("yield_7_year", "yield7Year", "7Y", 7.0),
    ("yield_10_year", "yield10Year", "10Y", 10.0),
    ("yield_20_year", "yield20Year", "20Y", 20.0),
    ("yield_30_year", "yield30Year", "30Y", 30.0),
]


def json_num(value: float) -> float | str:
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    return float(value)


def is_finite_num(val: Any) -> bool:
    return isinstance(val, (int, float)) and not isinstance(val, bool) and math.isfinite(val)


def to_finite_or_nan(val: Any) -> float | str:
    return float(val) if is_finite_num(val) else "NaN"


def to_non_neg_or_nan(val: Any) -> float | str:
    return float(val) if (is_finite_num(val) and val >= 0) else "NaN"


def to_pos_or_nan(val: Any) -> float | str:
    return float(val) if (is_finite_num(val) and val > 0) else "NaN"


def pct_to_decimal(val: Any) -> float:
    return float(val) / 100.0 if is_finite_num(val) else float("nan")


def redact_text(text: str, secrets: list[str] | None = None) -> str:
    out = text
    for secret in secrets or []:
        if secret:
            out = out.replace(secret, "<redacted>")
    return AUTH_PARAM_RE.sub(r"\1<redacted>", out)


def parse_calendar_date(val: Any) -> tuple[str, int, date] | None:
    if not isinstance(val, str):
        return None
    m = DATE_RE.match(val.strip())
    if m is None:
        return None
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if y < 1900 or y > 2200:
        return None
    try:
        cal = date(y, mo, d)
    except ValueError:
        return None
    dt_utc = datetime(y, mo, d, 0, 0, 0, tzinfo=UTC_TZ)
    sec = int((dt_utc - EPOCH_UTC).total_seconds())
    if abs(sec) > MAX_TIME_SECONDS:
        return None
    return cal.isoformat(), sec, cal


def parse_et_wall_time_sec(cal: date, hour: int, minute: int) -> int:
    local_dt = datetime.combine(cal, time(hour, minute), tzinfo=ET_TZ)
    utc_dt = local_dt.astimezone(UTC_TZ)
    return int((utc_dt - EPOCH_UTC).total_seconds())


def parse_expiration_date(val: Any) -> tuple[str, int] | None:
    parsed = parse_calendar_date(val)
    if parsed is None:
        return None
    iso, _, cal = parsed
    if cal.year < 1970:
        return None
    exp_sec = parse_et_wall_time_sec(cal, 16, 0)
    if exp_sec <= 0 or exp_sec > MAX_TIME_SECONDS:
        return None
    return iso, exp_sec


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


# ---------------------------------------------------------------------------
# 1) US Treasury & Interpolación independiente vía factores de descuento
# ---------------------------------------------------------------------------


def normalize_treasury_py(raw: Any) -> dict[str, Any]:
    counts = {"malformedRow": 0, "invalidDate": 0, "missingRates": 0, "duplicate": 0}
    discards: list[dict[str, Any]] = []
    if not isinstance(raw, dict):
        return {
            "observations": [],
            "report": {
                "provider": "massive",
                "received": 0,
                "accepted": 0,
                "discarded": 0,
                "discardCounts": counts,
                "discards": discards,
                "reordered": False,
                "malformedResponse": True,
                "providerError": None,
            },
        }
    rows = raw.get("results") or []
    seen_dates: set[str] = set()
    accepted: list[dict[str, Any]] = []

    for row in rows:
        if not isinstance(row, dict):
            counts["malformedRow"] += 1
            discards.append({"cause": "malformedRow", "date": None})
            continue
        parsed_date = parse_calendar_date(row.get("date"))
        if parsed_date is None:
            raw_d = row.get("date")
            counts["invalidDate"] += 1
            discards.append(
                {
                    "cause": "invalidDate",
                    "date": raw_d.strip() if isinstance(raw_d, str) and raw_d.strip() else None,
                }
            )
            continue
        iso, date_sec, _ = parsed_date
        obs: dict[str, Any] = {"date": iso, "dateTime": date_sec}
        finite_cnt = 0
        for field, key, _, _ in TREASURY_TENORS:
            r = pct_to_decimal(row.get(field))
            if math.isfinite(r):
                finite_cnt += 1
            obs[key] = json_num(r)
        if finite_cnt == 0:
            counts["missingRates"] += 1
            discards.append({"cause": "missingRates", "date": iso})
            continue
        if iso in seen_dates:
            counts["duplicate"] += 1
            discards.append({"cause": "duplicate", "date": iso})
            continue
        seen_dates.add(iso)
        obs["finiteTenors"] = finite_cnt
        accepted.append(obs)

    reordered = any(
        accepted[i]["date"] < accepted[i - 1]["date"] for i in range(1, len(accepted))
    )
    if reordered:
        accepted.sort(key=lambda x: x["date"])

    return {
        "observations": accepted,
        "report": {
            "provider": "massive",
            "received": len(rows),
            "accepted": len(accepted),
            "discarded": len(discards),
            "discardCounts": counts,
            "discards": discards,
            "reordered": reordered,
            "malformedResponse": False,
            "providerError": None,
        },
    }


def extract_curve_points_py(
    obs: dict[str, Any],
    *,
    allow_missing: bool = False,
    overnight_rate: float | None = None,
) -> list[dict[str, Any]]:
    pts: list[dict[str, Any]] = []
    if overnight_rate is not None:
        pts.append(
            {
                "tenorYears": 1.0 / 365.0,
                "tenorLabel": "ON",
                "rate": overnight_rate,
                "sourceField": "overnightRate",
            }
        )
    for field, key, label, years in TREASURY_TENORS:
        raw_r = obs[key]
        r = float("nan") if raw_r == "NaN" else float(raw_r)
        if allow_missing and not math.isfinite(r):
            continue
        pts.append(
            {
                "tenorYears": years,
                "tenorLabel": label,
                "rate": r,
                "sourceField": field,
            }
        )
    return pts


def interpolate_treasury_py(
    points: list[dict[str, Any]],
    tenor_years: float,
    *,
    method: str = "linear",
    extrapolation: str = "clamp",
) -> float:
    """
    Cálculo independiente de `r(T)`:
      - 'linear': interpolación lineal directa sobre tasas `r(T)`.
      - 'logLinear': calcula factores de descuento `P_i = exp(-r_i * T_i)`,
        interpola linealmente `log(P(T))` y recupera `r(T) = -log(P(T)) / T`.
    """
    if not math.isfinite(tenor_years) or tenor_years < 0:
        return float("nan")
    if method not in ("linear", "logLinear") or extrapolation not in ("clamp", "nan"):
        return float("nan")
    if not points:
        return float("nan")

    clean: list[tuple[float, float]] = []
    for p in points:
        t = p["tenorYears"]
        r = float("nan") if p["rate"] == "NaN" else float(p["rate"])
        if not is_finite_num(t) or t <= 0 or not math.isfinite(r):
            return float("nan")
        clean.append((float(t), float(r)))

    clean.sort(key=lambda pair: pair[0])
    for i in range(1, len(clean)):
        if clean[i][0] == clean[i - 1][0]:
            return float("nan")

    t_min, r_min = clean[0]
    t_max, r_max = clean[-1]

    if tenor_years < t_min:
        return float("nan") if extrapolation == "nan" else r_min
    if tenor_years == t_min:
        return r_min
    if tenor_years > t_max:
        return float("nan") if extrapolation == "nan" else r_max
    if tenor_years == t_max:
        return r_max

    for i in range(len(clean) - 1):
        t0, r0 = clean[i]
        t1, r1 = clean[i + 1]
        if tenor_years == t0:
            return r0
        if tenor_years == t1:
            return r1
        if t0 < tenor_years < t1:
            w = (tenor_years - t0) / (t1 - t0)
            if method == "linear":
                return r0 + w * (r1 - r0)
            p0 = math.exp(-r0 * t0)
            p1 = math.exp(-r1 * t1)
            log_p_t = math.log(p0) + w * (math.log(p1) - math.log(p0))
            p_t = math.exp(log_p_t)
            return -math.log(p_t) / tenor_years

    return float("nan")


# ---------------------------------------------------------------------------
# 2) Condiciones de fondeo / SOFR
# ---------------------------------------------------------------------------


def normalize_funding_py(raw: Any) -> dict[str, Any]:
    counts = {"malformedRow": 0, "invalidDate": 0, "missingRates": 0, "duplicate": 0}
    discards: list[dict[str, Any]] = []
    rows = raw.get("results") or []
    seen_dates: set[str] = set()
    accepted: list[dict[str, Any]] = []

    rate_mappings = [
        ("effective_fed_funds_rate", "effectiveFedFundsRate"),
        ("interest_on_reserve_balances", "interestOnReserveBalances"),
        ("target_range_lower", "targetRangeLower"),
        ("target_range_upper", "targetRangeUpper"),
        ("secured_overnight_financing_rate", "sofr"),
        ("sofr_percentile_1", "sofrPercentile1"),
        ("sofr_percentile_25", "sofrPercentile25"),
        ("sofr_percentile_75", "sofrPercentile75"),
        ("sofr_percentile_99", "sofrPercentile99"),
        ("overnight_bank_funding_rate", "overnightBankFundingRate"),
    ]
    volume_mappings = [
        ("effective_fed_funds_volume", "effectiveFedFundsVolume"),
        ("sofr_volume", "sofrVolume"),
        ("obfr_volume", "obfrVolume"),
        ("overnight_repo_operation_amount", "overnightRepoOperationAmount"),
        ("overnight_reverse_repo_operation_amount", "overnightReverseRepoOperationAmount"),
    ]

    for row in rows:
        if not isinstance(row, dict):
            counts["malformedRow"] += 1
            discards.append({"cause": "malformedRow", "date": None})
            continue
        parsed_date = parse_calendar_date(row.get("date"))
        if parsed_date is None:
            raw_d = row.get("date")
            counts["invalidDate"] += 1
            discards.append(
                {
                    "cause": "invalidDate",
                    "date": raw_d.strip() if isinstance(raw_d, str) and raw_d.strip() else None,
                }
            )
            continue
        iso, date_sec, _ = parsed_date

        rates_num = {ts_k: pct_to_decimal(row.get(api_k)) for api_k, ts_k in rate_mappings}
        if sum(1 for v in rates_num.values() if math.isfinite(v)) == 0:
            counts["missingRates"] += 1
            discards.append({"cause": "missingRates", "date": iso})
            continue
        if iso in seen_dates:
            counts["duplicate"] += 1
            discards.append({"cause": "duplicate", "date": iso})
            continue
        seen_dates.add(iso)

        obs: dict[str, Any] = {"date": iso, "dateTime": date_sec}
        for k, v in rates_num.items():
            obs[k] = json_num(v)
        for api_k, ts_k in volume_mappings:
            obs[ts_k] = to_non_neg_or_nan(row.get(api_k))
        accepted.append(obs)

    reordered = any(
        accepted[i]["date"] < accepted[i - 1]["date"] for i in range(1, len(accepted))
    )
    if reordered:
        accepted.sort(key=lambda x: x["date"])

    return {
        "observations": accepted,
        "report": {
            "provider": "massive",
            "received": len(rows),
            "accepted": len(accepted),
            "discarded": len(discards),
            "discardCounts": counts,
            "discards": discards,
            "reordered": reordered,
            "malformedResponse": False,
            "providerError": None,
        },
    }


# ---------------------------------------------------------------------------
# 3) Dividendos corporativos
# ---------------------------------------------------------------------------


def normalize_dividends_py(raw: Any) -> dict[str, Any]:
    counts = {
        "malformedRow": 0,
        "invalidTicker": 0,
        "invalidExDividendDate": 0,
        "invalidCashAmount": 0,
        "duplicate": 0,
    }
    discards: list[dict[str, Any]] = []
    rows = raw.get("results") or []
    seen_keys: set[str] = set()
    accepted: list[dict[str, Any]] = []

    for row in rows:
        if not isinstance(row, dict):
            counts["malformedRow"] += 1
            discards.append({"cause": "malformedRow", "ticker": None, "exDividendDate": None})
            continue
        t_raw = row.get("ticker")
        ticker = t_raw.strip().upper() if isinstance(t_raw, str) and t_raw.strip() else None
        raw_ex = row.get("ex_dividend_date")
        ex_str = raw_ex.strip() if isinstance(raw_ex, str) and raw_ex.strip() else None

        if ticker is None:
            counts["invalidTicker"] += 1
            discards.append({"cause": "invalidTicker", "ticker": None, "exDividendDate": ex_str})
            continue

        parsed_ex = parse_calendar_date(raw_ex)
        if parsed_ex is None:
            counts["invalidExDividendDate"] += 1
            discards.append(
                {"cause": "invalidExDividendDate", "ticker": ticker, "exDividendDate": ex_str}
            )
            continue
        ex_iso, _, ex_cal = parsed_ex
        ex_time = parse_et_wall_time_sec(ex_cal, 9, 30)

        cash_raw = row.get("cash_amount")
        if not is_finite_num(cash_raw) or cash_raw < 0:
            counts["invalidCashAmount"] += 1
            discards.append(
                {"cause": "invalidCashAmount", "ticker": ticker, "exDividendDate": ex_iso}
            )
            continue
        cash = float(cash_raw)

        div_id_raw = row.get("id")
        div_id = div_id_raw.strip() if isinstance(div_id_raw, str) and div_id_raw.strip() else None
        dist_raw = row.get("distribution_type")
        dist_type = dist_raw.strip() if isinstance(dist_raw, str) and dist_raw.strip() else None
        key = (
            f"id:{div_id}"
            if div_id is not None
            else f"k:{ticker}|{ex_iso}|{dist_type or ''}|{cash}"
        )
        if key in seen_keys:
            counts["duplicate"] += 1
            discards.append({"cause": "duplicate", "ticker": ticker, "exDividendDate": ex_iso})
            continue
        seen_keys.add(key)

        freq_raw = row.get("frequency")
        freq: Any = (
            int(freq_raw)
            if is_finite_num(freq_raw) and int(freq_raw) == freq_raw and freq_raw >= 0
            else "NaN"
        )

        def opt_date(field: str) -> str | None:
            p = parse_calendar_date(row.get(field))
            return p[0] if p is not None else None

        curr_raw = row.get("currency")
        accepted.append(
            {
                "id": div_id,
                "ticker": ticker,
                "declarationDate": opt_date("declaration_date"),
                "exDividendDate": ex_iso,
                "exDividendTime": ex_time,
                "recordDate": opt_date("record_date"),
                "payDate": opt_date("pay_date"),
                "cashAmount": cash,
                "splitAdjustedCashAmount": to_non_neg_or_nan(row.get("split_adjusted_cash_amount")),
                "historicalAdjustmentFactor": to_pos_or_nan(
                    row.get("historical_adjustment_factor")
                    if row.get("historical_adjustment_factor") is not None
                    else row.get("adjustment_factor")
                ),
                "frequency": freq,
                "currency": (
                    curr_raw.strip() if isinstance(curr_raw, str) and curr_raw.strip() else None
                ),
                "distributionType": dist_type,
            }
        )

    def sort_key(item: dict[str, Any]) -> tuple[str, str, float, str]:
        return (
            item["exDividendDate"],
            item["ticker"],
            item["cashAmount"],
            item["id"] or "",
        )

    reordered = any(sort_key(accepted[i]) < sort_key(accepted[i - 1]) for i in range(1, len(accepted)))
    if reordered:
        accepted.sort(key=sort_key)

    return {
        "dividends": accepted,
        "report": {
            "provider": "massive",
            "received": len(rows),
            "accepted": len(accepted),
            "discarded": len(discards),
            "discardCounts": counts,
            "discards": discards,
            "reordered": reordered,
            "malformedResponse": False,
            "providerError": None,
        },
    }


# ---------------------------------------------------------------------------
# 4) Open Interest histórico (`/options/v1/open-interest`)
# ---------------------------------------------------------------------------


def normalize_open_interest_py(raw: Any) -> dict[str, Any]:
    counts = {
        "malformedRow": 0,
        "invalidTicker": 0,
        "invalidDate": 0,
        "invalidExpiration": 0,
        "invalidStrike": 0,
        "invalidContractType": 0,
        "invalidOpenInterest": 0,
        "duplicate": 0,
    }
    discards: list[dict[str, Any]] = []
    rows = raw.get("results") or []
    seen_keys: set[str] = set()
    accepted: list[dict[str, Any]] = []

    for row in rows:
        if not isinstance(row, dict):
            counts["malformedRow"] += 1
            discards.append({"cause": "malformedRow", "ticker": None, "date": None})
            continue
        t_raw = row.get("ticker")
        ticker = t_raw.strip() if isinstance(t_raw, str) and t_raw.strip() else None
        raw_d = row.get("date")
        raw_d_str = raw_d.strip() if isinstance(raw_d, str) and raw_d.strip() else None

        if ticker is None:
            counts["invalidTicker"] += 1
            discards.append({"cause": "invalidTicker", "ticker": None, "date": raw_d_str})
            continue
        parsed_d = parse_calendar_date(raw_d)
        if parsed_d is None:
            counts["invalidDate"] += 1
            discards.append({"cause": "invalidDate", "ticker": ticker, "date": raw_d_str})
            continue
        d_iso, d_sec, _ = parsed_d

        parsed_exp = parse_expiration_date(row.get("expiration_date"))
        if parsed_exp is None:
            counts["invalidExpiration"] += 1
            discards.append({"cause": "invalidExpiration", "ticker": ticker, "date": d_iso})
            continue
        exp_iso, exp_sec = parsed_exp

        strike = to_pos_or_nan(row.get("strike_price"))
        if strike == "NaN":
            counts["invalidStrike"] += 1
            discards.append({"cause": "invalidStrike", "ticker": ticker, "date": d_iso})
            continue

        ct_raw = row.get("contract_type")
        ct = (
            ct_raw.strip().lower()
            if isinstance(ct_raw, str) and ct_raw.strip().lower() in ("call", "put", "other")
            else None
        )
        if ct is None:
            counts["invalidContractType"] += 1
            discards.append({"cause": "invalidContractType", "ticker": ticker, "date": d_iso})
            continue

        oi_raw = row.get("open_interest")
        if not is_finite_num(oi_raw) or int(oi_raw) != oi_raw or oi_raw < 0:
            counts["invalidOpenInterest"] += 1
            discards.append({"cause": "invalidOpenInterest", "ticker": ticker, "date": d_iso})
            continue
        oi = int(oi_raw)

        key = f"{d_iso}|{ticker}"
        if key in seen_keys:
            counts["duplicate"] += 1
            discards.append({"cause": "duplicate", "ticker": ticker, "date": d_iso})
            continue
        seen_keys.add(key)

        root_raw = row.get("root")
        und_raw = row.get("underlying_ticker") if row.get("underlying_ticker") is not None else row.get("underlying")
        accepted.append(
            {
                "ticker": ticker,
                "root": root_raw.strip().upper() if isinstance(root_raw, str) and root_raw.strip() else None,
                "underlyingTicker": (
                    und_raw.strip().upper() if isinstance(und_raw, str) and und_raw.strip() else None
                ),
                "date": d_iso,
                "dateTime": d_sec,
                "expirationDate": exp_iso,
                "expirationTime": exp_sec,
                "strikePrice": strike,
                "contractType": ct,
                "openInterest": oi,
            }
        )

    reordered = any(
        (accepted[i]["date"], accepted[i]["ticker"]) < (accepted[i - 1]["date"], accepted[i - 1]["ticker"])
        for i in range(1, len(accepted))
    )
    if reordered:
        accepted.sort(key=lambda x: (x["date"], x["ticker"]))

    return {
        "records": accepted,
        "report": {
            "provider": "massive",
            "received": len(rows),
            "accepted": len(accepted),
            "discarded": len(discards),
            "discardCounts": counts,
            "discards": discards,
            "reordered": reordered,
            "malformedResponse": False,
            "providerError": None,
        },
    }


# ---------------------------------------------------------------------------
# 5) Unified Multi-Asset Snapshot (`/v3/snapshot`)
# ---------------------------------------------------------------------------


def classify_unified_type(raw_type: str | None) -> str | None:
    if raw_type is None:
        return None
    low = raw_type.lower()
    if low in ("stocks", "stock"):
        return "stocks"
    if low in ("indices", "index"):
        return "indices"
    if low in ("options", "option"):
        return "options"
    if low in ("fx", "forex"):
        return "fx"
    if low == "crypto":
        return "crypto"
    return None


def normalize_unified_py(raw: Any, secrets: list[str] | None = None) -> dict[str, Any]:
    counts = {"malformedRow": 0, "missingTicker": 0, "unknownAssetType": 0, "duplicate": 0}
    discards: list[dict[str, Any]] = []
    invalid_ts = 0

    def parse_ts(val: Any) -> int | str:
        nonlocal invalid_ts
        res, bad = parse_provider_ts(val)
        if bad:
            invalid_ts += 1
        return res

    def parse_session(s: Any) -> dict[str, Any]:
        if not isinstance(s, dict):
            return {
                "open": "NaN",
                "high": "NaN",
                "low": "NaN",
                "close": "NaN",
                "volume": "NaN",
                "vwap": "NaN",
                "price": "NaN",
                "previousClose": "NaN",
                "change": "NaN",
                "changePercent": "NaN",
                "earlyTradingChange": "NaN",
                "earlyTradingChangePercent": "NaN",
                "lateTradingChange": "NaN",
                "lateTradingChangePercent": "NaN",
                "lastUpdated": "NaN",
                "hasOhlc": False,
            }
        o = to_finite_or_nan(s.get("open"))
        h = to_finite_or_nan(s.get("high"))
        lo = to_finite_or_nan(s.get("low"))
        c = to_finite_or_nan(s.get("close"))
        chg = s.get("change") if s.get("change") is not None else s.get("todays_change")
        chgp = (
            s.get("change_percent")
            if s.get("change_percent") is not None
            else s.get("todays_change_percent")
        )
        return {
            "open": o,
            "high": h,
            "low": lo,
            "close": c,
            "volume": to_non_neg_or_nan(s.get("volume")),
            "vwap": to_finite_or_nan(s.get("vwap")),
            "price": to_finite_or_nan(s.get("price")),
            "previousClose": to_finite_or_nan(s.get("previous_close")),
            "change": to_finite_or_nan(chg),
            "changePercent": to_finite_or_nan(chgp),
            "earlyTradingChange": to_finite_or_nan(s.get("early_trading_change")),
            "earlyTradingChangePercent": to_finite_or_nan(s.get("early_trading_change_percent")),
            "lateTradingChange": to_finite_or_nan(s.get("late_trading_change")),
            "lateTradingChangePercent": to_finite_or_nan(s.get("late_trading_change_percent")),
            "lastUpdated": parse_ts(s.get("last_updated")),
            "hasOhlc": all(v != "NaN" for v in (o, h, lo, c)),
        }

    def opt_str(v: Any) -> str | None:
        return v.strip() if isinstance(v, str) and v.strip() else None

    def pick_first(d: dict[str, Any], *keys: str) -> Any:
        for k in keys:
            if k in d and d[k] is not None:
                return d[k]
        return None

    def parse_last_quote(q: Any) -> dict[str, Any] | None:
        if not isinstance(q, dict):
            return None
        return {
            "bid": to_non_neg_or_nan(pick_first(q, "bid", "p", "b")),
            "ask": to_non_neg_or_nan(pick_first(q, "ask", "P", "a")),
            "midpoint": to_non_neg_or_nan(q.get("midpoint")),
            "bidSize": to_non_neg_or_nan(pick_first(q, "bid_size", "s")),
            "askSize": to_non_neg_or_nan(pick_first(q, "ask_size", "S")),
            "updatedAt": parse_ts(pick_first(q, "last_updated", "sip_timestamp", "t")),
            "timeframe": opt_str(q.get("timeframe")),
        }

    def parse_last_trade(tr: Any) -> dict[str, Any] | None:
        if not isinstance(tr, dict):
            return None
        raw_ex = pick_first(tr, "exchange", "x")
        ex = int(raw_ex) if is_finite_num(raw_ex) and int(raw_ex) == raw_ex else None
        raw_conds = pick_first(tr, "conditions", "c")
        conds = (
            [int(c) for c in raw_conds if is_finite_num(c) and int(c) == c]
            if isinstance(raw_conds, list)
            else []
        )
        return {
            "price": to_pos_or_nan(pick_first(tr, "price", "p")),
            "size": to_non_neg_or_nan(pick_first(tr, "size", "s")),
            "exchange": ex,
            "conditions": conds,
            "timestamp": parse_ts(pick_first(tr, "sip_timestamp", "last_updated", "t")),
            "timeframe": opt_str(tr.get("timeframe")),
        }

    def parse_last_minute(m: Any) -> dict[str, Any] | None:
        if not isinstance(m, dict):
            return None
        return {
            "open": to_finite_or_nan(pick_first(m, "open", "o")),
            "high": to_finite_or_nan(pick_first(m, "high", "h")),
            "low": to_finite_or_nan(pick_first(m, "low", "l")),
            "close": to_finite_or_nan(pick_first(m, "close", "c")),
            "volume": to_non_neg_or_nan(pick_first(m, "volume", "v")),
            "vwap": to_finite_or_nan(pick_first(m, "vwap", "vw")),
            "transactions": to_non_neg_or_nan(pick_first(m, "transactions", "n")),
            "lastUpdated": parse_ts(pick_first(m, "last_updated", "t")),
        }

    def parse_underlying(u: Any) -> dict[str, Any] | None:
        if not isinstance(u, dict):
            return None
        u_ticker = opt_str(u.get("ticker"))
        if u_ticker is None:
            return None
        p_dir = to_finite_or_nan(u.get("price"))
        v_dir = to_finite_or_nan(u.get("value"))
        if p_dir != "NaN":
            price_val, src_field = p_dir, "price"
        elif v_dir != "NaN":
            price_val, src_field = v_dir, "value"
        else:
            price_val, src_field = "NaN", None
        return {
            "ticker": u_ticker,
            "price": price_val,
            "sourceField": src_field,
            "changeToBreakEven": to_finite_or_nan(u.get("change_to_break_even")),
            "updatedAt": parse_ts(u.get("last_updated")),
            "timeframe": opt_str(u.get("timeframe")),
        }

    rows = raw.get("results") or []
    stocks: list[dict[str, Any]] = []
    indices: list[dict[str, Any]] = []
    options: list[dict[str, Any]] = []
    other: list[dict[str, Any]] = []
    ticker_errors: list[dict[str, Any]] = []
    seen_tickers: set[str] = set()
    accepted_order: list[str] = []
    early_no_ohlc = 0
    overnight_cnt = 0

    for row in rows:
        if not isinstance(row, dict):
            counts["malformedRow"] += 1
            discards.append({"cause": "malformedRow", "ticker": None})
            continue
        raw_err = opt_str(row.get("error"))
        raw_ticker = opt_str(row.get("ticker"))
        raw_type = opt_str(row.get("type"))
        if raw_err is not None:
            raw_msg = row.get("message") if isinstance(row.get("message"), str) else raw_err
            ticker_errors.append(
                {
                    "ticker": raw_ticker or "",
                    "type": raw_type,
                    "error": raw_err,
                    "message": redact_text(raw_msg, secrets),
                }
            )
            continue
        if raw_ticker is None:
            counts["missingTicker"] += 1
            discards.append({"cause": "missingTicker", "ticker": None})
            continue
        ac = classify_unified_type(raw_type)
        if ac is None:
            counts["unknownAssetType"] += 1
            discards.append({"cause": "unknownAssetType", "ticker": raw_ticker})
            continue
        if raw_ticker in seen_tickers:
            counts["duplicate"] += 1
            discards.append({"cause": "duplicate", "ticker": raw_ticker})
            continue
        seen_tickers.add(raw_ticker)
        accepted_order.append(raw_ticker)

        ms = opt_str(row.get("market_status"))
        session = parse_session(row.get("session"))
        if ms == "early_trading" and not session["hasOhlc"]:
            early_no_ohlc += 1
        if ms == "overnight_trading":
            overnight_cnt += 1

        if ac == "indices":
            indices.append(
                {
                    "assetClass": "indices",
                    "ticker": raw_ticker,
                    "name": opt_str(row.get("name")),
                    "marketStatus": ms,
                    "timeframe": opt_str(row.get("timeframe")),
                    "value": to_finite_or_nan(row.get("value")),
                    "session": session,
                    "lastUpdated": parse_ts(row.get("last_updated")),
                }
            )
            continue

        last_quote = parse_last_quote(row.get("last_quote"))
        last_trade = parse_last_trade(row.get("last_trade"))
        last_minute = parse_last_minute(row.get("last_minute"))

        if ac == "stocks":
            stocks.append(
                {
                    "assetClass": "stocks",
                    "ticker": raw_ticker,
                    "name": opt_str(row.get("name")),
                    "marketStatus": ms,
                    "timeframe": opt_str(row.get("timeframe")),
                    "session": session,
                    "lastQuote": last_quote,
                    "lastTrade": last_trade,
                    "lastMinute": last_minute,
                }
            )
            continue

        if ac == "options":
            det = row.get("details") if isinstance(row.get("details"), dict) else None
            exp = parse_expiration_date(det.get("expiration_date")) if det else None
            g = row.get("greeks") if isinstance(row.get("greeks"), dict) else {}
            gd = to_finite_or_nan(g.get("delta"))
            gg = to_finite_or_nan(g.get("gamma"))
            gt = to_finite_or_nan(g.get("theta"))
            gv = to_finite_or_nan(g.get("vega"))
            options.append(
                {
                    "assetClass": "options",
                    "ticker": raw_ticker,
                    "name": opt_str(row.get("name")),
                    "marketStatus": ms,
                    "timeframe": opt_str(row.get("timeframe")),
                    "breakEvenPrice": to_finite_or_nan(row.get("break_even_price")),
                    "impliedVolatility": to_pos_or_nan(row.get("implied_volatility")),
                    "openInterest": to_non_neg_or_nan(row.get("open_interest")),
                    "greeks": {"delta": gd, "gamma": gg, "theta": gt, "vega": gv},
                    "greeksMissing": all(v == "NaN" for v in (gd, gg, gt, gv)),
                    "details": {
                        "contractType": (
                            det.get("contract_type")
                            if det and det.get("contract_type") in ("call", "put", "other")
                            else "other"
                        ),
                        "exerciseStyle": (
                            det.get("exercise_style")
                            if det and det.get("exercise_style") in ("american", "european", "bermudan")
                            else None
                        ),
                        "expirationDate": exp[0] if exp else None,
                        "expirationTime": exp[1] if exp else "NaN",
                        "sharesPerContract": (
                            100
                            if det is not None and det.get("shares_per_contract") is None
                            else to_pos_or_nan(det.get("shares_per_contract"))
                            if det is not None
                            else "NaN"
                        ),
                        "strikePrice": to_pos_or_nan(det.get("strike_price")) if det else "NaN",
                    },
                    "session": session,
                    "lastQuote": last_quote,
                    "lastTrade": last_trade,
                    "lastMinute": last_minute,
                    "underlyingAsset": parse_underlying(row.get("underlying_asset")),
                }
            )
            continue

        other.append(
            {
                "assetClass": ac,
                "rawType": raw_type,
                "ticker": raw_ticker,
                "name": opt_str(row.get("name")),
                "marketStatus": ms,
                "timeframe": opt_str(row.get("timeframe")),
                "session": session,
                "lastQuote": last_quote,
                "lastTrade": last_trade,
                "lastMinute": last_minute,
            }
        )

    reordered = any(
        accepted_order[i] < accepted_order[i - 1] for i in range(1, len(accepted_order))
    )
    if reordered:
        stocks.sort(key=lambda x: x["ticker"])
        indices.sort(key=lambda x: x["ticker"])
        options.sort(key=lambda x: x["ticker"])
        other.sort(key=lambda x: x["ticker"])

    return {
        "stocks": stocks,
        "indices": indices,
        "options": options,
        "other": other,
        "tickerErrors": ticker_errors,
        "report": {
            "provider": "massive",
            "received": len(rows),
            "accepted": len(stocks) + len(indices) + len(options) + len(other),
            "errorCount": len(ticker_errors),
            "discarded": len(discards),
            "discardCounts": counts,
            "discards": discards,
            "stocksCount": len(stocks),
            "indicesCount": len(indices),
            "optionsCount": len(options),
            "otherCount": len(other),
            "earlyTradingWithoutOhlc": early_no_ohlc,
            "overnightTradingCount": overnight_cnt,
            "invalidTimestamps": invalid_ts,
            "reordered": reordered,
            "malformedResponse": False,
            "providerError": None,
        },
    }


def rewrite_mirror_next_url(next_url: str, base_url: str, api_key: str) -> str:
    parsed = urlparse(next_url)
    base = urlparse(base_url)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    if origin in ALLOWED_MIRROR_ORIGINS:
        parsed = parsed._replace(scheme=base.scheme, netloc=base.netloc)
    q = [(k, v) for k, v in parse_qsl(parsed.query) if k.lower() not in ("apikey", "api_key", "api-key")]
    key_name = "apikey" if "massive.com" in base.netloc else "apiKey"
    q.append((key_name, api_key))
    return urlunparse(parsed._replace(query=urlencode(q)))


def build_cases() -> dict[str, Any]:
    # --- 1. Treasury Yields & interpolación ---
    treasury_raw = {
        "status": "OK",
        "results": [
            # Desordenado cronológicamente + 10Y en 4.31% -> 0.0431
            {
                "date": "2026-04-02",
                "yield_1_month": 4.35,
                "yield_3_month": 4.32,
                "yield_6_month": 4.24,
                "yield_1_year": 4.08,
                "yield_2_year": 3.92,
                "yield_3_year": 3.88,
                "yield_5_year": 3.94,
                "yield_7_year": 4.08,
                "yield_10_year": 4.31,
                "yield_20_year": 4.72,
                "yield_30_year": 4.81,
            },
            # Dato histórico pre-1970 (1962-01-02) con tenores ausentes (NaN parciales)
            {
                "date": "1962-01-02",
                "yield_1_month": None,
                "yield_3_month": 2.72,
                "yield_6_month": 2.91,
                "yield_1_year": 3.06,
                "yield_2_year": None,
                "yield_3_year": 3.70,
                "yield_5_year": 3.88,
                "yield_7_year": None,
                "yield_10_year": 4.06,
                "yield_20_year": 4.07,
                "yield_30_year": None,
            },
            # Descarte: todas las tasas nulas
            {"date": "2026-04-03", "yield_1_month": None, "yield_10_year": None},
            # Descarte: duplicado
            {"date": "2026-04-02", "yield_1_month": 4.99},
            # Descarte: fecha inválida
            {"date": "2026-02-30", "yield_10_year": 4.3},
            # Descarte: fila malformada
            "not-an-object",
        ],
    }
    treasury_norm = normalize_treasury_py(treasury_raw)
    obs_full = treasury_norm["observations"][1]  # 2026-04-02 (curva completa)
    obs_hist = treasury_norm["observations"][0]  # 1962-01-02 (tenores históricos faltantes)

    pts_full = extract_curve_points_py(obs_full, allow_missing=False)
    pts_full_with_sofr = extract_curve_points_py(
        obs_full, allow_missing=False, overnight_rate=0.0433
    )
    pts_hist_strict = extract_curve_points_py(obs_hist, allow_missing=False)
    pts_hist_sparse = extract_curve_points_py(obs_hist, allow_missing=True)

    # Curva sintética con tasas negativas/cero y altas para stress-test logLinear vs linear
    stress_curve = [
        {"tenorYears": 0.25, "tenorLabel": "3M", "rate": -0.005},
        {"tenorYears": 1.0, "tenorLabel": "1Y", "rate": 0.0},
        {"tenorYears": 4.0, "tenorLabel": "4Y", "rate": 0.048},
    ]

    interp_queries = [
        ("full_exact_1y_linear", obs_full, pts_full, 1.0, "linear", "clamp", False, None),
        ("full_mid_45d_linear", obs_full, pts_full, 45.0 / 365.0, "linear", "clamp", False, None),
        ("full_mid_45d_logLinear", obs_full, pts_full, 45.0 / 365.0, "logLinear", "clamp", False, None),
        ("full_mid_18m_linear", obs_full, pts_full, 1.5, "linear", "clamp", False, None),
        ("full_mid_18m_logLinear", obs_full, pts_full, 1.5, "logLinear", "clamp", False, None),
        ("full_with_sofr_7d_logLinear", obs_full, pts_full_with_sofr, 7.0 / 365.0, "logLinear", "clamp", False, 0.0433),
        ("full_with_sofr_nan_rejects", obs_full, extract_curve_points_py(obs_full, overnight_rate=float("nan")), 0.25, "linear", "clamp", False, "NaN"),
        ("full_short_clamp", obs_full, pts_full, 7.0 / 365.0, "linear", "clamp", False, None),
        ("full_short_nan_extrap", obs_full, pts_full, 7.0 / 365.0, "linear", "nan", False, None),
        ("full_long_clamp", obs_full, pts_full, 40.0, "logLinear", "clamp", False, None),
        ("full_long_nan_extrap", obs_full, pts_full, 40.0, "logLinear", "nan", False, None),
        ("hist_strict_missing_tenor_nan", obs_hist, pts_hist_strict, 5.0, "linear", "clamp", False, None),
        ("hist_sparse_allowed_4y_logLinear", obs_hist, pts_hist_sparse, 4.0, "logLinear", "clamp", True, None),
        ("empty_curve_nan", [], [], 1.0, "linear", "clamp", False, None),
        ("negative_tenor_nan", obs_full, pts_full, -0.1, "linear", "clamp", False, None),
        ("stress_neg_rate_logLinear", stress_curve, stress_curve, 0.625, "logLinear", "clamp", False, None),
        ("stress_zero_to_pos_logLinear", stress_curve, stress_curve, 2.5, "logLinear", "clamp", False, None),
    ]

    interp_cases = []
    for name, src, pts, tenor, method, extrap, allow_missing, on_rate in interp_queries:
        res = interpolate_treasury_py(pts, tenor, method=method, extrapolation=extrap)
        interp_cases.append(
            {
                "name": name,
                "sourceKind": "customPoints" if isinstance(src, list) else "observation",
                "observationDate": None if isinstance(src, list) else src["date"],
                "customPoints": src if isinstance(src, list) else None,
                "tenorYears": tenor,
                "method": method,
                "extrapolation": extrap,
                "allowMissingTenors": allow_missing,
                "overnightRate": on_rate,
                "expectedRate": json_num(res),
            }
        )

    # --- 2. Funding Conditions / SOFR ---
    funding_raw = {
        "status": "OK",
        "results": [
            {
                "date": "2026-04-02",
                "effective_fed_funds_rate": 4.33,
                "effective_fed_funds_volume": 98,
                "interest_on_reserve_balances": 4.40,
                "target_range_lower": 4.25,
                "target_range_upper": 4.50,
                "secured_overnight_financing_rate": 4.31,
                "sofr_volume": 2410,
                "sofr_percentile_1": 4.26,
                "sofr_percentile_25": 4.30,
                "sofr_percentile_75": 4.34,
                "sofr_percentile_99": 4.41,
                "overnight_bank_funding_rate": 4.32,
                "obfr_volume": 162,
                "overnight_repo_operation_amount": 0.0,
                "overnight_reverse_repo_operation_amount": 185.4,
            },
            # Registro histórico pre-SOFR (1954-07-01, solo EFFR presente)
            {
                "date": "1954-07-01",
                "effective_fed_funds_rate": 0.80,
                "secured_overnight_financing_rate": None,
            },
            {"date": "2026-04-02", "secured_overnight_financing_rate": 4.35},  # duplicado
            {"date": "2026-04-03"},  # missingRates
            {"date": "bad-date", "secured_overnight_financing_rate": 4.30},  # invalidDate
            42,  # malformedRow
        ],
    }
    funding_norm = normalize_funding_py(funding_raw)

    # --- 3. Dividendos corporativos ---
    dividends_raw = {
        "status": "OK",
        "results": [
            {
                "id": "E_div_special_nov",
                "ticker": "spy",
                "declaration_date": "2025-11-01",
                "ex_dividend_date": "2025-11-03",  # EST invierno (UTC-5 -> 14:30 UTC)
                "record_date": "2025-11-03",
                "pay_date": "2025-11-28",
                "cash_amount": 0.25,
                "currency": "USD",
                "distribution_type": "special",
                # sin frequency ni split_adjusted_cash_amount -> NaN
            },
            {
                "id": "E_div_reg_jul",
                "ticker": "SPY",
                "declaration_date": "2025-07-10",
                "ex_dividend_date": "2025-07-15",  # EDT verano (UTC-4 -> 13:30 UTC)
                "record_date": "2025-07-15",
                "pay_date": "2025-07-31",
                "cash_amount": 1.7611,
                "split_adjusted_cash_amount": 1.7611,
                "historical_adjustment_factor": 0.99724,
                "frequency": 4,
                "currency": "USD",
                "distribution_type": "recurring",
            },
            # Duplicado por id
            {
                "id": "E_div_reg_jul",
                "ticker": "SPY",
                "ex_dividend_date": "2025-07-15",
                "cash_amount": 1.7611,
            },
            # Descarga inválida: cash negativo
            {
                "id": "E_div_bad_cash",
                "ticker": "AAPL",
                "ex_dividend_date": "2025-08-10",
                "cash_amount": -0.25,
            },
            # Descarga inválida: fecha mala
            {"ticker": "MSFT", "ex_dividend_date": "2025-99-01", "cash_amount": 0.83},
            # Descarga inválida: sin ticker
            {"ticker": "  ", "ex_dividend_date": "2025-08-12", "cash_amount": 0.5},
        ],
    }
    dividends_norm = normalize_dividends_py(dividends_raw)

    # --- 4. Open Interest histórico ---
    oi_raw = {
        "status": "OK",
        "results": [
            {
                "ticker": "O:SPXW260515P05500000",
                "root": "spxw",
                "underlying_ticker": "spx",
                "contract_type": "put",
                "expiration_date": "2026-05-15",
                "strike_price": 5500,
                "date": "2026-04-02",
                "open_interest": 14250,
            },
            # Contrato antiguo con open_interest = 0 válido (prohibido descartar ceros)
            {
                "ticker": "O:SPY221021C00380000",
                "root": "SPY",
                "underlying": "SPY",
                "contract_type": "call",
                "expiration_date": "2022-10-21",
                "strike_price": 380,
                "date": "2022-09-01",
                "open_interest": 0,
            },
            # Duplicado (date, ticker)
            {
                "ticker": "O:SPXW260515P05500000",
                "contract_type": "put",
                "expiration_date": "2026-05-15",
                "strike_price": 5500,
                "date": "2026-04-02",
                "open_interest": 999,
            },
            # OI fraccionario inválido
            {
                "ticker": "O:QQQ260515C00500000",
                "contract_type": "call",
                "expiration_date": "2026-05-15",
                "strike_price": 500,
                "date": "2026-04-02",
                "open_interest": 12.5,
            },
            # Strike <= 0 inválido
            {
                "ticker": "O:IWM260515P00200000",
                "contract_type": "put",
                "expiration_date": "2026-05-15",
                "strike_price": 0,
                "date": "2026-04-02",
                "open_interest": 100,
            },
        ],
    }
    oi_norm = normalize_open_interest_py(oi_raw)

    # --- 5. Unified Multi-Asset Snapshot ---
    test_secret = "massive_live_secret_macro_987"
    unified_raw = {
        "status": "OK",
        "results": [
            # Stock en sesión overnight_trading (efectivo 2026-12-07)
            {
                "ticker": "TSLA",
                "name": "Tesla Inc.",
                "type": "stocks",
                "market_status": "overnight_trading",
                "timeframe": "REAL-TIME",
                "session": {
                    "open": 258.0,
                    "high": 261.5,
                    "low": 256.8,
                    "close": 260.2,
                    "volume": 412000,
                    "vwap": 259.4,
                    "price": 260.2,
                    "previous_close": 255.0,
                    "change": 5.2,
                    "change_percent": 2.0392,
                    "last_updated": 1796605200_000_000_000,
                },
                "last_quote": {
                    "bid": 260.1,
                    "ask": 260.3,
                    "midpoint": 260.2,
                    "bid_size": 4,
                    "ask_size": 6,
                    "last_updated": 1796605200_500_000_000,
                    "timeframe": "REAL-TIME",
                },
                "last_minute": {
                    "open": 259.9,
                    "high": 260.4,
                    "low": 259.8,
                    "close": 260.2,
                    "volume": 12450,
                    "vwap": 260.12,
                    "transactions": 182,
                    "last_updated": 1796605140_000_000_000,
                },
            },
            # Stock en early_trading: omisión NORMAL de open/high/low/close/vwap
            {
                "ticker": "AAPL",
                "name": "Apple Inc.",
                "type": "stocks",
                "market_status": "early_trading",
                "timeframe": "REAL-TIME",
                "session": {
                    "previous_close": 212.40,
                    "price": 214.10,
                    "early_trading_change": 1.70,
                    "early_trading_change_percent": 0.800376647834275,
                    "last_updated": 1775127600_000_000_000,
                },
                "last_trade": {
                    "price": 214.10,
                    "size": 100,
                    "exchange": 12,
                    "conditions": [37],
                    "sip_timestamp": 1775127600_123_000_000,
                },
            },
            # Índices: I:VIX, I:SPX, I:SKEW, I:NDX (I:NDX con timestamp ambiguo en segundos para probar invalidTimestamps)
            {
                "ticker": "I:VIX",
                "name": "CBOE Volatility Index",
                "type": "indices",
                "market_status": "open",
                "timeframe": "REAL-TIME",
                "value": 18.42,
                "last_updated": 1775145600_000_000_000,
                "session": {
                    "open": 18.10,
                    "high": 19.05,
                    "low": 17.90,
                    "close": 18.42,
                    "previous_close": 18.01,
                    "change": 0.41,
                    "change_percent": 2.276513,
                    "last_updated": 1775145600_000_000_000,
                },
            },
            {
                "ticker": "I:SPX",
                "name": "Standard & Poor's 500",
                "type": "indices",
                "market_status": "open",
                "value": 5650.25,
                "last_updated": 1775145600_000,  # milisegundos válidos
                "session": {
                    "open": 5630.0,
                    "high": 5662.5,
                    "low": 5624.1,
                    "close": 5650.25,
                    "previous_close": 5618.0,
                    "change": 32.25,
                    "change_percent": 0.574048,
                },
            },
            {
                "ticker": "I:SKEW",
                "name": "CBOE Skew Index",
                "type": "indices",
                "market_status": "closed",
                "value": 148.9,
                "last_updated": 1775145600,  # segundos crudos (< 1e12) -> inválido ("NaN")
                "session": {"previous_close": 146.2},
            },
            {
                "ticker": "I:NDX",
                "name": "Nasdaq-100 Index",
                "type": "indices",
                "market_status": "open",
                "value": 20125.4,
                "last_updated": 1775145605_000_000_000,
                "session": {
                    "open": 20010.0,
                    "high": 20190.0,
                    "low": 19980.0,
                    "close": 20125.4,
                    "previous_close": 19995.0,
                },
            },
            # Opción con greeks: {} e IV ausente -> NaN + greeksMissing = true + underlying_asset de índice
            {
                "ticker": "O:SPXW260515C05700000",
                "type": "options",
                "market_status": "open",
                "details": {
                    "contract_type": "call",
                    "exercise_style": "european",
                    "expiration_date": "2026-05-15",
                    "strike_price": 5700,
                },
                "greeks": {},
                "open_interest": 3200,
                "session": {
                    "open": 42.5,
                    "high": 45.0,
                    "low": 41.2,
                    "close": 44.1,
                    "volume": 850,
                },
                "underlying_asset": {
                    "ticker": "I:SPX",
                    "value": 5650.25,
                    "change_to_break_even": 93.85,
                    "last_updated": 1775145600_000_000_000,
                },
            },
            # Error parcial con fuga de apiKey en el mensaje (no debe abortar lote y debe redactarse)
            {
                "ticker": "O:NDX260515P19000000",
                "type": "options",
                "error": "NOT_ENTITLED",
                "message": f"Plan not entitled for OPRA via https://api.massive.com/v3/snapshot?apikey={test_secret}",
            },
            # Otro error parcial sin campo type
            {
                "ticker": "UNKNOWNXYZ",
                "error": "NOT_FOUND",
                "message": "Ticker not found",
            },
            # FX -> other
            {
                "ticker": "C:EURUSD",
                "type": "fx",
                "market_status": "open",
                "session": {"open": 1.084, "high": 1.088, "low": 1.082, "close": 1.0865},
            },
            # Descargas: tipo desconocido y ticker duplicado
            {"ticker": "FOOBAR", "type": "commodities", "session": {}},
            {"ticker": "AAPL", "type": "stocks", "session": {}},
        ],
    }
    unified_norm = normalize_unified_py(unified_raw, [test_secret])

    # --- 6. Mirror rewrite + pagination loader fixture ---
    next_mirror = "https://api.polygon.io/fed/v1/treasury-yields?cursor=page2abc&limit=1"
    rewritten_next = rewrite_mirror_next_url(
        next_mirror, "https://api.massive.com", test_secret
    )

    payload = {
        "schemaVersion": 1,
        "description": "Independent Python reference fixture for Pieza 4 (Macro, SOFR, Dividends, OI, Unified Snapshot)",
        "testSecret": test_secret,
        "treasury": {
            "raw": treasury_raw,
            "expectedNormalized": treasury_norm,
            "interpolationCases": interp_cases,
        },
        "funding": {
            "raw": funding_raw,
            "expectedNormalized": funding_norm,
        },
        "dividends": {
            "raw": dividends_raw,
            "expectedNormalized": dividends_norm,
        },
        "openInterest": {
            "raw": oi_raw,
            "expectedNormalized": oi_norm,
        },
        "unifiedSnapshot": {
            "raw": unified_raw,
            "expectedNormalized": unified_norm,
        },
        "loaderHelpers": {
            "mirrorNextUrlInput": next_mirror,
            "mirrorNextUrlExpected": rewritten_next,
        },
    }
    return payload


def main() -> None:
    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = build_cases()
    with FIXTURE_PATH.open("w", encoding="utf-8", newline="\n") as fh:
        json.dump(payload, fh, indent=2, allow_nan=False)
        fh.write("\n")
    print(f"Wrote {FIXTURE_PATH} cleanly.")


if __name__ == "__main__":
    main()
