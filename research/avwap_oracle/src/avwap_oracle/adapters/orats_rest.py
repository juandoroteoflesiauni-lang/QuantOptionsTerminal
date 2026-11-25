"""Asynchronous ORATS Data v2 REST adapter, explicit field registry, and GEX/OpEx aggregator.

Verified contracts (Prompt #1 ``probe_phase1_results.json``):
- ``/datav2/hist/cores`` reports percentage IV & implied-move fields in ``%`` points
  (e.g., ``impErnMv=10.04``, ``orIvXern20d=44.75``, ``iv30d=45.22``, ``exErnIv30d=45.22``,
  ``impliedEarningsMove=7.89``) whereas ``contango=-1.49`` and ``slope=-0.18347`` remain in
  their signed native ratio/slope units.
- ``/datav2/hist/summaries`` reports IV & ``impliedEarningsMove`` ALREADY in decimal units
  (e.g., ``impliedEarningsMove=0.0788804``, ``iv30d=0.452229``, ``exErnIv30d=0.452229``).
- ``impliedEarningsMove`` MUST NEVER be merged with ``impErnMv`` (ratio observed 127.28x:
  different economic definitions).
- ``stockPrice``, ``pxAtmIv``, ``pxCls``, ``priorCls`` are blocked as canonical spot and
  exposed only under ``_orats_ref_px_blocked*`` for audit.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import math
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Sequence

import numpy as np
import polars as pl
from scipy import optimize, stats

from avwap_oracle.adapters.credentials import AsyncProviderTransport
from avwap_oracle.math_core.nyse_calendar import (
    CLOSED,
    ET_TZ,
    UTC_TZ,
    get_session_bounds,
)

WHAM_FLOOR_DATE = dt.date(2023, 1, 1)
MACRO_EVENT_TYPES: frozenset[str] = frozenset({"FOMC", "CPI", "NFP", "PCE"})

# Formalized GEX conventions
GEX_CONTRACT_MULTIPLIER = 100.0
GEX_DEALER_ASSUMPTION = "DEALER_LONG_CALL_SHORT_PUT"  # +1 call, -1 put


@dataclass(frozen=True)
class OratsFieldSpec:
    endpoint: str
    raw_field: str
    canonical_field: str
    source_scale: str
    transform: str
    target_unit: str
    blocked_spot: bool = False
    note: str = ""


ORATS_FIELD_REGISTRY: tuple[OratsFieldSpec, ...] = (
    OratsFieldSpec("hist/cores", "impErnMv", "imp_ern_mv_dec", "PERCENT_POINTS", "x / 100.0", "DECIMAL_MOVE", note="Observed 10.04 -> 0.1004; distinct from impliedEarningsMove"),
    OratsFieldSpec("hist/cores", "impliedEarningsMove", "cores_implied_earnings_move_dec", "PERCENT_POINTS", "x / 100.0", "DECIMAL_MOVE", note="Observed 7.89 -> 0.0789; never fused with impErnMv"),
    OratsFieldSpec("hist/cores", "orIvXern20d", "or_iv_xern_20d_dec", "PERCENT_POINTS", "x / 100.0", "DECIMAL_VOL", note="Observed 44.75 -> 0.4475"),
    OratsFieldSpec("hist/cores", "iv30d", "iv_30d_dec", "PERCENT_POINTS", "x / 100.0", "DECIMAL_VOL", note="Observed 45.22 vs summary 0.452229 (100x)"),
    OratsFieldSpec("hist/cores", "exErnIv30d", "ex_ern_iv_30d_dec", "PERCENT_POINTS", "x / 100.0", "DECIMAL_VOL", note="Observed 45.22 -> 0.4522"),
    OratsFieldSpec("hist/cores", "orHv5d", "or_hv_5d_dec", "PERCENT_POINTS_OR_DEC_VERIFIED", "scale_pct_to_dec", "DECIMAL_VOL", note="Preserves or_hv_5d_raw; ORATS cores HV fields report % points"),
    OratsFieldSpec("hist/cores", "absAvgErnMv", "abs_avg_ern_mv_dec", "PERCENT_POINTS_OR_DEC_VERIFIED", "scale_pct_to_dec", "DECIMAL_MOVE", note="Preserves abs_avg_ern_mv_raw"),
    OratsFieldSpec("hist/cores", "ivPctile1m", "iv_pctile_1m_pct", "PERCENTILE_0_100", "identity", "PERCENTILE_0_100", note="Semantic percentile [0, 100], never /100 as IV"),
    OratsFieldSpec("hist/cores", "ivPctile1y", "iv_pctile_1y_pct", "PERCENTILE_0_100", "identity", "PERCENTILE_0_100", note="Semantic percentile [0, 100], never /100 as IV"),
    OratsFieldSpec("hist/cores", "contango", "contango", "NATIVE_SIGNED_RATIO", "identity", "NATIVE_RATIO", note="Observed -1.49 matches summaries -1.488388"),
    OratsFieldSpec("hist/cores", "slope", "slope", "NATIVE_SLOPE", "identity", "NATIVE_SLOPE", note="Observed -0.18347"),
    OratsFieldSpec("hist/cores", "pxAtmIv", "_orats_ref_px_blocked_px_atm_iv", "DOLLARS", "identity_blocked", "USD_BLOCKED", blocked_spot=True),
    OratsFieldSpec("hist/cores", "pxCls", "_orats_ref_px_blocked_px_cls", "DOLLARS", "identity_blocked", "USD_BLOCKED", blocked_spot=True),
    OratsFieldSpec("hist/summaries", "impliedEarningsMove", "implied_earnings_move_dec", "DECIMAL", "identity", "DECIMAL_MOVE", note="Observed 0.0788804; already decimal"),
    OratsFieldSpec("hist/summaries", "iv30d", "iv_30d_summary_dec", "DECIMAL", "identity", "DECIMAL_VOL", note="Observed 0.452229; already decimal"),
    OratsFieldSpec("hist/summaries", "exErnIv30d", "ex_ern_iv_30d_summary_dec", "DECIMAL", "identity", "DECIMAL_VOL", note="Observed 0.452229; already decimal"),
    OratsFieldSpec("hist/summaries", "contango", "contango", "NATIVE_SIGNED_RATIO", "identity", "NATIVE_RATIO"),
    OratsFieldSpec("hist/summaries", "stockPrice", "_orats_ref_px_blocked_stock_price", "DOLLARS", "identity_blocked", "USD_BLOCKED", blocked_spot=True),
)

ORATS_CORES_SCHEMA: dict[str, pl.DataType] = {
    "ticker": pl.String,
    "trade_date": pl.String,
    "imp_ern_mv_dec": pl.Float64,
    "cores_implied_earnings_move_dec": pl.Float64,
    "or_iv_xern_20d_dec": pl.Float64,
    "iv_30d_dec": pl.Float64,
    "ex_ern_iv_30d_dec": pl.Float64,
    "or_hv_5d_dec": pl.Float64,
    "or_hv_5d_raw": pl.Float64,
    "abs_avg_ern_mv_dec": pl.Float64,
    "abs_avg_ern_mv_raw": pl.Float64,
    "iv_pctile_1m_pct": pl.Float64,
    "iv_pctile_1y_pct": pl.Float64,
    "contango": pl.Float64,
    "slope": pl.Float64,
    "c_oi": pl.Int64,
    "p_oi": pl.Int64,
    "total_oi": pl.Int64,
    "c_volu": pl.Int64,
    "p_volu": pl.Int64,
    "days_to_next_ern": pl.Int64,
    "next_ern": pl.String,
    "last_ern": pl.String,
    "updated_at_raw": pl.String,
    "_orats_ref_px_blocked_px_atm_iv": pl.Float64,
    "_orats_ref_px_blocked_px_cls": pl.Float64,
}

ORATS_SUMMARIES_SCHEMA: dict[str, pl.DataType] = {
    "ticker": pl.String,
    "trade_date": pl.String,
    "implied_earnings_move_dec": pl.Float64,
    "implied_move_dec": pl.Float64,
    "iv_30d_summary_dec": pl.Float64,
    "ex_ern_iv_30d_summary_dec": pl.Float64,
    "contango": pl.Float64,
    "skewing": pl.Float64,
    "r_slp_30": pl.Float64,
    "r_vol_30": pl.Float64,
    "risk_free_30": pl.Float64,
    "updated_at_raw": pl.String,
    "_orats_ref_px_blocked_stock_price": pl.Float64,
}

ORATS_EARNINGS_SCHEMA: dict[str, pl.DataType] = {
    "ticker": pl.String,
    "earn_date": pl.String,
    "annc_tod_raw": pl.String,
    "annc_hhmm": pl.String,
    "earnings_timing": pl.String,
    "updated_at_raw": pl.String,
}

ORATS_GEX_OPEX_SCHEMA: dict[str, pl.DataType] = {
    "ticker": pl.String,
    "trade_date": pl.String,
    "sampling_mode": pl.String,
    "is_quad_witching": pl.Boolean,
    "massive_spot": pl.Float64,
    "abs_gex_total": pl.Float64,
    "abs_gex_raw_total": pl.Float64,
    "net_gex_raw_gamma_oi": pl.Float64,
    "expiring_gex_share": pl.Float64,
    "nearest_expir_date": pl.String,
    "monthly_opex_expir_date": pl.String,
    "monthly_opex_gex_share": pl.Float64,
    "call_wall_strike": pl.Float64,
    "put_wall_strike": pl.Float64,
    "zero_gamma_est": pl.Float64,
    "zero_gamma_reason": pl.String,
    "total_call_oi": pl.Int64,
    "total_put_oi": pl.Int64,
    "total_call_vol": pl.Int64,
    "total_put_vol": pl.Int64,
    "strike_rows_processed": pl.Int64,
    "contract_multiplier": pl.Float64,
    "dealer_assumption": pl.String,
    "gex_unit_status": pl.String,
    "coverage_status": pl.String,
    "quality_reason": pl.String,
}

ORATS_WHAM_SCHEMA: dict[str, pl.DataType] = {
    "ticker": pl.String,
    "trade_date": pl.String,
    "wham_status": pl.String,
    "payload_json": pl.String,
}


@dataclass(frozen=True)
class OpexSampleDate:
    trade_date: str
    opex_date: str
    sampling_mode: str  # PRE_OPEX | OPEX | POST_OPEX
    is_quad_witching: bool


@dataclass(frozen=True)
class OratsWhamResult:
    data: pl.DataFrame
    status: str  # COMPLETE | PARTIAL | EMPTY_VERIFIED | UNSUPPORTED_COVERAGE | NOT_APPLICABLE
    note: str | None = None
    requests_made: int = 0


@dataclass(frozen=True)
class MacroEventTarget:
    macro_event_type: str
    event_name: str
    event_date: str
    scheduled_ts_utc_s: int
    assigned_session_t: str
    assigned_session_t_minus_1: str


@dataclass(frozen=True)
class MacroWhamSchedule:
    events: tuple[MacroEventTarget, ...]
    target_dates: tuple[str, ...]


@dataclass(frozen=True)
class OratsWhamMacroBatchResult:
    by_ticker_data: dict[str, pl.DataFrame]
    by_ticker_manifest: dict[str, dict[str, Any]]
    requests_made: int
    retries: int
    errors: tuple[str, ...]


@dataclass(frozen=True)
class OratsBatchedOpexResult:
    by_ticker_data: dict[str, pl.DataFrame]
    requests_made: int
    batches_sent: int
    fallbacks_triggered: int
    truncated_batches_detected: int
    duplicates_removed: int


def _num_or_nan(val: Any) -> float:
    if isinstance(val, bool) or val is None:
        return math.nan
    try:
        f = float(val)
    except (TypeError, ValueError):
        return math.nan
    return f if math.isfinite(f) else math.nan


def _int_or_neg1(val: Any) -> int:
    if isinstance(val, bool) or val is None:
        return -1
    try:
        f = float(val)
    except (TypeError, ValueError):
        return -1
    return int(round(f)) if math.isfinite(f) else -1


def _pct_field_to_dec(val: Any) -> tuple[float, float]:
    raw = _num_or_nan(val)
    if not math.isfinite(raw):
        return math.nan, math.nan
    return raw / 100.0, raw


def _first_present(row: Mapping[str, Any], *keys: str) -> Any:
    for k in keys:
        if k in row and row[k] is not None:
            return row[k]
    return None


def classify_orats_annc_tod(annc_tod: Any, earn_date: str) -> tuple[str, str, str]:
    """Normalize ORATS ``anncTod`` (e.g. '0900', 900, '1630', 1630) respecting NYSE early close."""
    if annc_tod is None:
        return "", "", "UNKNOWN"
    raw_str = str(annc_tod).strip()
    if not raw_str:
        return "", "", "UNKNOWN"
    digits = "".join(ch for ch in raw_str if ch.isdigit())
    if not digits:
        low = raw_str.lower()
        if "bmo" in low or "before" in low:
            return raw_str, "", "BMO"
        if "amc" in low or "after" in low:
            return raw_str, "", "AMC"
        return raw_str, "", "UNKNOWN"

    hhmm_int = int(digits)
    if hhmm_int < 0 or hhmm_int > 2359:
        return raw_str, "", "UNKNOWN"
    hh, mm = divmod(hhmm_int, 100)
    if hh > 23 or mm > 59:
        return raw_str, "", "UNKNOWN"
    hhmm = f"{hh:02d}{mm:02d}"
    minutes_of_day = hh * 60 + mm

    close_min = 960
    try:
        sb = get_session_bounds(earn_date)
        if sb is not None and sb.is_early_close:
            close_min = 780
    except Exception:
        close_min = 960

    if minutes_of_day < 570:
        return raw_str, hhmm, "BMO"
    if minutes_of_day >= close_min:
        return raw_str, hhmm, "AMC"
    return raw_str, hhmm, "DURING"


def _third_friday_adjusted(year: int, month: int) -> dt.date:
    first_day = dt.date(year, month, 1)
    offset = (4 - first_day.weekday()) % 7  # Friday == 4
    third_fri = first_day + dt.timedelta(days=offset + 14)
    cur = third_fri
    while cur.weekday() >= 5 or cur.isoformat() in CLOSED:
        cur -= dt.timedelta(days=1)
    return cur


def _prev_trading_day(d: dt.date) -> dt.date:
    cur = d - dt.timedelta(days=1)
    while get_session_bounds(cur) is None:
        cur -= dt.timedelta(days=1)
    return cur


def _next_trading_day(d: dt.date) -> dt.date:
    cur = d + dt.timedelta(days=1)
    while get_session_bounds(cur) is None:
        cur += dt.timedelta(days=1)
    return cur


def resolve_macro_wham_schedule(
    econ_df: pl.DataFrame,
    start_date: dt.date | str,
    end_date: dt.date | str,
    *,
    allowed_types: frozenset[str] = MACRO_EVENT_TYPES,
) -> MacroWhamSchedule:
    """Resolve US macro events (FOMC|CPI|NFP|PCE) into NYSE RTH target dates ``{T, T-1}``."""
    s_date = max(
        WHAM_FLOOR_DATE,
        dt.date.fromisoformat(start_date) if isinstance(start_date, str) else start_date,
    )
    e_date = dt.date.fromisoformat(end_date) if isinstance(end_date, str) else end_date
    if s_date > e_date or econ_df.height == 0:
        return MacroWhamSchedule(events=(), target_dates=())

    s_iso, e_iso = s_date.isoformat(), e_date.isoformat()
    lookback_iso = (s_date - dt.timedelta(days=10)).isoformat()
    lookahead_iso = (e_date + dt.timedelta(days=10)).isoformat()

    filtered = econ_df.filter(
        pl.col("macro_event_type").is_in(sorted(allowed_types))
        & (pl.col("event_date") >= lookback_iso)
        & (pl.col("event_date") <= lookahead_iso)
    )
    if filtered.height == 0:
        return MacroWhamSchedule(events=(), target_dates=())

    events_out: list[MacroEventTarget] = []
    dates_set: set[str] = set()
    for row in filtered.iter_rows(named=True):
        mtype = str(row.get("macro_event_type") or "").strip().upper()
        ev_name = str(row.get("event") or "").strip()
        ev_date_str = str(row.get("event_date") or "").strip()[:10]
        ts_raw = row.get("scheduled_ts_utc_s")
        ts_val = int(ts_raw) if isinstance(ts_raw, (int, float)) and not isinstance(ts_raw, bool) and int(ts_raw) > 0 else -1

        try:
            if ts_val > 0:
                et_dt = dt.datetime.fromtimestamp(ts_val, UTC_TZ).astimezone(ET_TZ)
                d_et = et_dt.date()
                sb = get_session_bounds(d_et)
                if sb is None or ts_val >= sb.rth_close_utc_s:
                    t_sess = _next_trading_day(d_et)
                else:
                    t_sess = d_et
            elif ev_date_str:
                d_et = dt.date.fromisoformat(ev_date_str)
                t_sess = d_et if get_session_bounds(d_et) is not None else _next_trading_day(d_et)
            else:
                continue
            t_minus_1 = _prev_trading_day(t_sess)
        except Exception:
            continue

        t_iso = t_sess.isoformat()
        tm1_iso = t_minus_1.isoformat()
        in_window = (s_iso <= t_iso <= e_iso) or (s_iso <= tm1_iso <= e_iso)
        if not in_window:
            continue

        events_out.append(
            MacroEventTarget(
                macro_event_type=mtype,
                event_name=ev_name,
                event_date=ev_date_str,
                scheduled_ts_utc_s=ts_val,
                assigned_session_t=t_iso,
                assigned_session_t_minus_1=tm1_iso,
            )
        )
        if s_iso <= t_iso <= e_iso:
            dates_set.add(t_iso)
        if s_iso <= tm1_iso <= e_iso:
            dates_set.add(tm1_iso)

    events_out.sort(key=lambda e: (e.assigned_session_t, e.scheduled_ts_utc_s, e.macro_event_type, e.event_name))
    return MacroWhamSchedule(events=tuple(events_out), target_dates=tuple(sorted(dates_set)))


def generate_opex_sampling_dates(
    start_date: dt.date | str,
    end_date: dt.date | str,
    *,
    include_post_opex: bool = False,
) -> list[OpexSampleDate]:
    """Generate NYSE-adjusted Monthly OpEx & Quad Witching sampling schedule."""
    s_date = dt.date.fromisoformat(start_date) if isinstance(start_date, str) else start_date
    e_date = dt.date.fromisoformat(end_date) if isinstance(end_date, str) else end_date
    if s_date > e_date:
        return []

    samples: list[OpexSampleDate] = []
    seen_pairs: set[tuple[str, str]] = set()
    y, m = s_date.year, s_date.month
    while (y, m) <= (e_date.year, e_date.month):
        opex_d = _third_friday_adjusted(y, m)
        is_quad = m in (3, 6, 9, 12)
        pre_d = _prev_trading_day(opex_d)
        if s_date <= pre_d <= e_date:
            key = (pre_d.isoformat(), "PRE_OPEX")
            if key not in seen_pairs:
                seen_pairs.add(key)
                samples.append(OpexSampleDate(pre_d.isoformat(), opex_d.isoformat(), "PRE_OPEX", is_quad))
        if include_post_opex:
            post_d = _next_trading_day(opex_d)
            if s_date <= post_d <= e_date:
                key = (post_d.isoformat(), "POST_OPEX")
                if key not in seen_pairs:
                    seen_pairs.add(key)
                    samples.append(OpexSampleDate(post_d.isoformat(), opex_d.isoformat(), "POST_OPEX", is_quad))
        m += 1
        if m == 13:
            m = 1
            y += 1
    return sorted(samples, key=lambda x: (x.trade_date, x.sampling_mode))


def _bs_gamma_at_spot(spot: float, strike: float, t_years: float, iv: float) -> float:
    if spot <= 0.0 or strike <= 0.0 or t_years <= 0.0 or iv <= 0.0:
        return 0.0
    sqrt_t = math.sqrt(t_years)
    vol_sqrt_t = iv * sqrt_t
    if vol_sqrt_t <= 1e-8:
        return 0.0
    r = 0.04
    d1 = (math.log(spot / strike) + (r + 0.5 * iv * iv) * t_years) / vol_sqrt_t
    pdf = float(stats.norm.pdf(d1))
    return pdf / (spot * vol_sqrt_t)


def compute_gex_opex_summary_from_strikes(
    ticker: str,
    trade_date: str,
    strike_rows: Iterable[Mapping[str, Any]],
    *,
    massive_spot: float | None = None,
    sampling_mode: str = "PRE_OPEX",
    is_quad_witching: bool = False,
    monthly_opex_date: str | None = None,
) -> dict[str, Any]:
    """Reduce a single ORATS ``/hist/strikes`` response into compact institutional GEX summary.

    Formal definitions:
    - ``abs_gex_raw_total`` = sum(|gamma_i * call_oi_i * 100| + |gamma_i * put_oi_i * 100|).
      Strictly distinct from ``|sum(GEX_i)|``.
    - ``net_gex_raw_gamma_oi`` = sum(gamma_i * (call_oi_i - put_oi_i) * 100) assuming
      dealer long calls / short puts.
    - Dollar ``abs_gex_total = abs_gex_raw_total * (massive_spot^2) * 0.01`` ONLY when a real
      Massive spot is supplied (ORATS ``stockPrice`` is NEVER used as canonical spot).
    """
    sym = ticker.strip().upper()
    rows_processed = 0
    abs_gex_raw_total = 0.0
    net_gex_raw = 0.0
    total_call_oi = 0
    total_put_oi = 0
    total_call_vol = 0
    total_put_vol = 0
    abs_gex_by_expir: dict[str, float] = {}
    call_wall_by_strike: dict[float, float] = {}
    put_wall_by_strike: dict[float, float] = {}
    reprice_inputs: list[tuple[float, float, float, int, int]] = []

    for r in strike_rows:
        rows_processed += 1
        strike = _num_or_nan(r.get("strike"))
        gamma = _num_or_nan(r.get("gamma"))
        expir = str(r.get("expirDate") or "").strip()
        if not (math.isfinite(strike) and strike > 0.0 and math.isfinite(gamma) and expir):
            continue

        c_oi = max(0, _int_or_neg1(r.get("callOpenInterest"))) if r.get("callOpenInterest") is not None else 0
        p_oi = max(0, _int_or_neg1(r.get("putOpenInterest"))) if r.get("putOpenInterest") is not None else 0
        c_vol = max(0, _int_or_neg1(r.get("callVolume"))) if r.get("callVolume") is not None else 0
        p_vol = max(0, _int_or_neg1(r.get("putVolume"))) if r.get("putVolume") is not None else 0

        total_call_oi += c_oi
        total_put_oi += p_oi
        total_call_vol += c_vol
        total_put_vol += p_vol

        g_call = abs(gamma) * float(c_oi) * GEX_CONTRACT_MULTIPLIER
        g_put = abs(gamma) * float(p_oi) * GEX_CONTRACT_MULTIPLIER
        abs_here = g_call + g_put
        abs_gex_raw_total += abs_here
        net_gex_raw += gamma * float(c_oi - p_oi) * GEX_CONTRACT_MULTIPLIER
        abs_gex_by_expir[expir] = abs_gex_by_expir.get(expir, 0.0) + abs_here

        if c_oi > 0:
            call_wall_by_strike[strike] = call_wall_by_strike.get(strike, 0.0) + g_call
        if p_oi > 0:
            put_wall_by_strike[strike] = put_wall_by_strike.get(strike, 0.0) + g_put

        dte_raw = _num_or_nan(r.get("dte"))
        iv_raw = _num_or_nan(_first_present(r, "smvVol", "callMidIv", "putMidIv"))
        # Strikes endpoint reports smvVol in decimal (~0.2-1.5), or % (>3); normalize safely.
        iv_dec = iv_raw / 100.0 if (math.isfinite(iv_raw) and iv_raw > 3.0) else iv_raw
        if math.isfinite(dte_raw) and dte_raw > 0.0 and math.isfinite(iv_dec) and iv_dec > 0.0 and (c_oi + p_oi) > 0:
            reprice_inputs.append((strike, dte_raw / 365.0, iv_dec, c_oi, p_oi))

    if rows_processed == 0 or not abs_gex_by_expir:
        return {
            "ticker": sym,
            "trade_date": trade_date,
            "sampling_mode": sampling_mode,
            "is_quad_witching": is_quad_witching,
            "massive_spot": math.nan if massive_spot is None else float(massive_spot),
            "abs_gex_total": math.nan,
            "abs_gex_raw_total": math.nan,
            "net_gex_raw_gamma_oi": math.nan,
            "expiring_gex_share": math.nan,
            "nearest_expir_date": "",
            "monthly_opex_expir_date": monthly_opex_date or "",
            "monthly_opex_gex_share": math.nan,
            "call_wall_strike": math.nan,
            "put_wall_strike": math.nan,
            "zero_gamma_est": math.nan,
            "zero_gamma_reason": "EMPTY_STRIKES",
            "total_call_oi": 0,
            "total_put_oi": 0,
            "total_call_vol": 0,
            "total_put_vol": 0,
            "strike_rows_processed": rows_processed,
            "contract_multiplier": GEX_CONTRACT_MULTIPLIER,
            "dealer_assumption": GEX_DEALER_ASSUMPTION,
            "gex_unit_status": "UNAVAILABLE",
            "coverage_status": "EMPTY_VERIFIED",
            "quality_reason": "NO_VALID_STRIKE_ROWS",
        }

    # Nearest expiration >= trade_date (fallback earliest sorted expiration)
    future_exps = sorted(e for e in abs_gex_by_expir.keys() if e >= trade_date)
    nearest_exp = future_exps[0] if future_exps else sorted(abs_gex_by_expir.keys())[0]

    quality_reasons: list[str] = []
    if abs_gex_raw_total > 0.0:
        expiring_share = abs_gex_by_expir.get(nearest_exp, 0.0) / abs_gex_raw_total
        monthly_share = (
            abs_gex_by_expir.get(monthly_opex_date, 0.0) / abs_gex_raw_total
            if monthly_opex_date and monthly_opex_date in abs_gex_by_expir
            else math.nan
        )
    else:
        expiring_share = math.nan
        monthly_share = math.nan
        quality_reasons.append("ZERO_TOTAL_ABS_GEX")

    call_wall = max(call_wall_by_strike.items(), key=lambda kv: (kv[1], -kv[0]))[0] if call_wall_by_strike else math.nan
    put_wall = max(put_wall_by_strike.items(), key=lambda kv: (kv[1], kv[0]))[0] if put_wall_by_strike else math.nan

    valid_spot = massive_spot is not None and math.isfinite(massive_spot) and massive_spot > 0.0
    if valid_spot:
        spot_f = float(massive_spot)
        abs_gex_dollar = abs_gex_raw_total * (spot_f * spot_f) * 0.01
        gex_unit_status = "DOLLAR_GAMMA_PER_1PCT_MOVE"
    else:
        spot_f = math.nan
        abs_gex_dollar = math.nan
        gex_unit_status = "RAW_GAMMA_OI_ONLY_NO_MASSIVE_SPOT"
        quality_reasons.append("MISSING_MASSIVE_SPOT")

    # Zero-gamma repricing curve (requires real Massive spot + valid BSM inputs)
    zero_gamma_est = math.nan
    zero_gamma_reason = "OK"
    if not valid_spot:
        zero_gamma_reason = "MISSING_MASSIVE_SPOT"
    elif not reprice_inputs:
        zero_gamma_reason = "INSUFFICIENT_IV_DATA"
    else:
        filtered = [
            row
            for row in reprice_inputs
            if row[3] != row[4] and row[1] > 0.0 and (row[2] * math.sqrt(row[1]) > 1e-8)
        ]
        if not filtered:
            zero_gamma_reason = "INSUFFICIENT_IV_DATA"
            sign_changes = []
        else:
            k_arr = np.fromiter((r[0] for r in filtered), dtype=np.float64, count=len(filtered))
            t_arr = np.fromiter((r[1] for r in filtered), dtype=np.float64, count=len(filtered))
            iv_arr = np.fromiter((r[2] for r in filtered), dtype=np.float64, count=len(filtered))
            oi_diff = np.fromiter(
                (float(r[3] - r[4]) * GEX_CONTRACT_MULTIPLIER for r in filtered),
                dtype=np.float64,
                count=len(filtered),
            )
            vol_sqrt_t = iv_arr * np.sqrt(t_arr)
            drift = (0.04 + 0.5 * iv_arr * iv_arr) * t_arr
            inv_sqrt_2pi = 1.0 / math.sqrt(2.0 * math.pi)

            def _net_gex_at(s: float) -> float:
                d1 = (np.log(s / k_arr) + drift) / vol_sqrt_t
                gammas = (inv_sqrt_2pi * np.exp(-0.5 * d1 * d1)) / (s * vol_sqrt_t)
                return float(np.dot(gammas, oi_diff))

            grid = np.linspace(0.7 * spot_f, 1.3 * spot_f, 61)
            vals = [_net_gex_at(float(g_s)) for g_s in grid]
            sign_changes = []
            for idx in range(len(grid) - 1):
                v0, v1 = vals[idx], vals[idx + 1]
                if v0 == 0.0:
                    sign_changes.append((float(grid[idx]), float(grid[idx])))
                elif (v0 < 0.0 < v1) or (v0 > 0.0 > v1):
                    sign_changes.append((float(grid[idx]), float(grid[idx + 1])))

            if len(sign_changes) == 0:
                zero_gamma_reason = "NO_SIGN_CHANGE"
            elif len(sign_changes) > 1:
                zero_gamma_reason = "MULTIPLE_ROOTS"
            else:
                lo_s, hi_s = sign_changes[0]
                if lo_s == hi_s:
                    zero_gamma_est = lo_s
                else:
                    zero_gamma_est = float(optimize.brentq(_net_gex_at, lo_s, hi_s, xtol=1e-4, maxiter=60))

    return {
        "ticker": sym,
        "trade_date": trade_date,
        "sampling_mode": sampling_mode,
        "is_quad_witching": is_quad_witching,
        "massive_spot": spot_f,
        "abs_gex_total": abs_gex_dollar,
        "abs_gex_raw_total": abs_gex_raw_total,
        "net_gex_raw_gamma_oi": net_gex_raw,
        "expiring_gex_share": expiring_share,
        "nearest_expir_date": nearest_exp,
        "monthly_opex_expir_date": monthly_opex_date or "",
        "monthly_opex_gex_share": monthly_share,
        "call_wall_strike": call_wall,
        "put_wall_strike": put_wall,
        "zero_gamma_est": zero_gamma_est,
        "zero_gamma_reason": zero_gamma_reason,
        "total_call_oi": total_call_oi,
        "total_put_oi": total_put_oi,
        "total_call_vol": total_call_vol,
        "total_put_vol": total_put_vol,
        "strike_rows_processed": rows_processed,
        "contract_multiplier": GEX_CONTRACT_MULTIPLIER,
        "dealer_assumption": GEX_DEALER_ASSUMPTION,
        "gex_unit_status": gex_unit_status,
        "coverage_status": "COMPLETE",
        "quality_reason": "|".join(quality_reasons) if quality_reasons else "OK",
    }


class OratsRestClient:
    """Async ORATS REST client enforcing unit registry, blocked spots, and ETF WHAM scoping."""

    def __init__(self, transport: AsyncProviderTransport) -> None:
        self._t = transport

    async def fetch_hist_cores(
        self,
        ticker: str,
        start_date: dt.date | str,
        end_date: dt.date | str,
    ) -> pl.DataFrame:
        s_str = start_date.isoformat() if isinstance(start_date, dt.date) else start_date
        e_str = end_date.isoformat() if isinstance(end_date, dt.date) else end_date
        sym = ticker.strip().upper()
        resp = await self._t.request_json(
            "ORATS_HISTORICAL",
            "/datav2/hist/cores",
            params={"ticker": sym},
            allow_404=True,
        )
        if resp.status_code == 404 or not isinstance(resp.payload, dict):
            return pl.DataFrame(schema=ORATS_CORES_SCHEMA)
        rows: list[dict[str, Any]] = []
        for r in resp.payload.get("data") or []:
            td = str(r.get("tradeDate") or "").strip()
            if not td or td < s_str or td > e_str:
                continue
            imp_dec, _ = _pct_field_to_dec(r.get("impErnMv"))
            cores_iem_dec, _ = _pct_field_to_dec(r.get("impliedEarningsMove"))
            xern20_dec, _ = _pct_field_to_dec(r.get("orIvXern20d"))
            iv30_dec, _ = _pct_field_to_dec(r.get("iv30d"))
            exern30_dec, _ = _pct_field_to_dec(r.get("exErnIv30d"))
            hv5_dec, hv5_raw = _pct_field_to_dec(r.get("orHv5d"))
            abs_mv_dec, abs_mv_raw = _pct_field_to_dec(r.get("absAvgErnMv"))

            c_oi = max(0, _int_or_neg1(r.get("cOi"))) if r.get("cOi") is not None else -1
            p_oi = max(0, _int_or_neg1(r.get("pOi"))) if r.get("pOi") is not None else -1
            tot_oi = (c_oi + p_oi) if (c_oi >= 0 and p_oi >= 0) else _int_or_neg1(r.get("oi"))

            rows.append(
                {
                    "ticker": str(r.get("ticker") or sym).upper(),
                    "trade_date": td,
                    "imp_ern_mv_dec": imp_dec,
                    "cores_implied_earnings_move_dec": cores_iem_dec,
                    "or_iv_xern_20d_dec": xern20_dec,
                    "iv_30d_dec": iv30_dec,
                    "ex_ern_iv_30d_dec": exern30_dec,
                    "or_hv_5d_dec": hv5_dec,
                    "or_hv_5d_raw": hv5_raw,
                    "abs_avg_ern_mv_dec": abs_mv_dec,
                    "abs_avg_ern_mv_raw": abs_mv_raw,
                    "iv_pctile_1m_pct": _num_or_nan(_first_present(r, "ivPctile1m", "ivPct1m")),
                    "iv_pctile_1y_pct": _num_or_nan(_first_present(r, "ivPctile1y", "ivPct1y")),
                    "contango": _num_or_nan(r.get("contango")),
                    "slope": _num_or_nan(r.get("slope")),
                    "c_oi": c_oi,
                    "p_oi": p_oi,
                    "total_oi": tot_oi,
                    "c_volu": _int_or_neg1(r.get("cVolu")),
                    "p_volu": _int_or_neg1(r.get("pVolu")),
                    "days_to_next_ern": _int_or_neg1(r.get("daysToNextErn")),
                    "next_ern": str(r.get("nextErn") or ""),
                    "last_ern": str(r.get("lastErn") or ""),
                    "updated_at_raw": str(r.get("updatedAt") or ""),
                    "_orats_ref_px_blocked_px_atm_iv": _num_or_nan(r.get("pxAtmIv")),
                    "_orats_ref_px_blocked_px_cls": _num_or_nan(r.get("pxCls")),
                }
            )
        if not rows:
            return pl.DataFrame(schema=ORATS_CORES_SCHEMA)
        return pl.DataFrame(rows, schema=ORATS_CORES_SCHEMA).unique(subset=["ticker", "trade_date"]).sort("trade_date")

    async def fetch_hist_summaries(
        self,
        ticker: str,
        start_date: dt.date | str,
        end_date: dt.date | str,
    ) -> pl.DataFrame:
        s_str = start_date.isoformat() if isinstance(start_date, dt.date) else start_date
        e_str = end_date.isoformat() if isinstance(end_date, dt.date) else end_date
        sym = ticker.strip().upper()
        resp = await self._t.request_json(
            "ORATS_HISTORICAL",
            "/datav2/hist/summaries",
            params={"ticker": sym},
            allow_404=True,
        )
        if resp.status_code == 404 or not isinstance(resp.payload, dict):
            return pl.DataFrame(schema=ORATS_SUMMARIES_SCHEMA)
        rows: list[dict[str, Any]] = []
        for r in resp.payload.get("data") or []:
            td = str(r.get("tradeDate") or "").strip()
            if not td or td < s_str or td > e_str:
                continue
            rows.append(
                {
                    "ticker": str(r.get("ticker") or sym).upper(),
                    "trade_date": td,
                    "implied_earnings_move_dec": _num_or_nan(r.get("impliedEarningsMove")),
                    "implied_move_dec": _num_or_nan(r.get("impliedMove")),
                    "iv_30d_summary_dec": _num_or_nan(r.get("iv30d")),
                    "ex_ern_iv_30d_summary_dec": _num_or_nan(r.get("exErnIv30d")),
                    "contango": _num_or_nan(r.get("contango")),
                    "skewing": _num_or_nan(r.get("skewing")),
                    "r_slp_30": _num_or_nan(r.get("rSlp30")),
                    "r_vol_30": _num_or_nan(r.get("rVol30")),
                    "risk_free_30": _num_or_nan(r.get("riskFree30")),
                    "updated_at_raw": str(r.get("updatedAt") or ""),
                    "_orats_ref_px_blocked_stock_price": _num_or_nan(r.get("stockPrice")),
                }
            )
        if not rows:
            return pl.DataFrame(schema=ORATS_SUMMARIES_SCHEMA)
        return pl.DataFrame(rows, schema=ORATS_SUMMARIES_SCHEMA).unique(subset=["ticker", "trade_date"]).sort("trade_date")

    async def fetch_hist_earnings(self, ticker: str) -> pl.DataFrame:
        sym = ticker.strip().upper()
        resp = await self._t.request_json(
            "ORATS_HISTORICAL",
            "/datav2/hist/earnings",
            params={"ticker": sym},
            allow_404=True,
        )
        if resp.status_code == 404 or not isinstance(resp.payload, dict):
            return pl.DataFrame(schema=ORATS_EARNINGS_SCHEMA)
        rows: list[dict[str, Any]] = []
        for r in resp.payload.get("data") or []:
            ed = str(r.get("earnDate") or "").strip()
            if not ed:
                continue
            raw_tod, hhmm, timing = classify_orats_annc_tod(r.get("anncTod"), ed)
            rows.append(
                {
                    "ticker": str(r.get("ticker") or sym).upper(),
                    "earn_date": ed,
                    "annc_tod_raw": raw_tod,
                    "annc_hhmm": hhmm,
                    "earnings_timing": timing,
                    "updated_at_raw": str(r.get("updatedAt") or ""),
                }
            )
        if not rows:
            return pl.DataFrame(schema=ORATS_EARNINGS_SCHEMA)
        return pl.DataFrame(rows, schema=ORATS_EARNINGS_SCHEMA).unique(subset=["ticker", "earn_date"]).sort("earn_date")

    async def fetch_hist_wham(
        self,
        ticker: str,
        start_date: dt.date | str,
        end_date: dt.date | str,
        *,
        asset_class: str = "US_ETF",
        sample_dates: Sequence[OpexSampleDate | str] | None = None,
    ) -> OratsWhamResult:
        """Query ``/datav2/hist/wham`` exclusively for ``US_ETF`` >= 2023-01-01 (single tradeDate per call)."""
        sym = ticker.strip().upper()
        if asset_class != "US_ETF":
            return OratsWhamResult(
                data=pl.DataFrame(schema=ORATS_WHAM_SCHEMA),
                status="NOT_APPLICABLE",
                note="WHAM restricted strictly to US_ETF instruments",
                requests_made=0,
            )
        s_date = dt.date.fromisoformat(start_date) if isinstance(start_date, str) else start_date
        e_date = dt.date.fromisoformat(end_date) if isinstance(end_date, str) else end_date
        eff_start = max(s_date, WHAM_FLOOR_DATE)
        if eff_start > e_date:
            return OratsWhamResult(
                data=pl.DataFrame(schema=ORATS_WHAM_SCHEMA),
                status="EMPTY_VERIFIED",
                note="Effective WHAM window is empty",
                requests_made=0,
            )

        if sample_dates is None:
            sched = generate_opex_sampling_dates(eff_start, e_date, include_post_opex=True)
            dates_to_fetch = [item.trade_date for item in sched]
            is_sampled = True
        else:
            dates_to_fetch = [
                (item.trade_date if isinstance(item, OpexSampleDate) else str(item))
                for item in sample_dates
            ]
            dates_to_fetch = [d for d in dates_to_fetch if eff_start.isoformat() <= d <= e_date.isoformat()]
            is_sampled = True

        if not dates_to_fetch:
            return OratsWhamResult(
                data=pl.DataFrame(schema=ORATS_WHAM_SCHEMA),
                status="EMPTY_VERIFIED",
                note="No WHAM sampling dates in effective window",
                requests_made=0,
            )

        import json
        rows: list[dict[str, Any]] = []
        reqs = 0
        count_404 = 0
        for td_req in dates_to_fetch:
            reqs += 1
            resp = await self._t.request_json(
                "ORATS_HISTORICAL",
                "/datav2/hist/wham",
                params={"ticker": sym, "tradeDate": td_req},
                allow_404=True,
            )
            if resp.status_code == 404:
                count_404 += 1
                continue
            if not isinstance(resp.payload, dict):
                continue
            for r in resp.payload.get("data") or []:
                td = str(r.get("tradeDate") or r.get("date") or td_req).strip()
                if not td or td < eff_start.isoformat() or td > e_date.isoformat():
                    continue
                rows.append(
                    {
                        "ticker": str(r.get("ticker") or sym).upper(),
                        "trade_date": td,
                        "wham_status": "OK_DATA",
                        "payload_json": json.dumps(r, sort_keys=True),
                    }
                )

        if not rows:
            if count_404 == reqs and reqs > 0:
                return OratsWhamResult(
                    data=pl.DataFrame(schema=ORATS_WHAM_SCHEMA),
                    status="UNSUPPORTED_COVERAGE",
                    note="ORATS /datav2/hist/wham returned HTTP 404 across sampled dates",
                    requests_made=reqs,
                )
            return OratsWhamResult(
                data=pl.DataFrame(schema=ORATS_WHAM_SCHEMA),
                status="EMPTY_VERIFIED",
                note="Zero WHAM records returned in effective window",
                requests_made=reqs,
            )

        df = pl.DataFrame(rows, schema=ORATS_WHAM_SCHEMA).unique(subset=["ticker", "trade_date"]).sort("trade_date")
        return OratsWhamResult(
            data=df,
            status="PARTIAL" if is_sampled else "COMPLETE",
            note="SAMPLED_OPEX_DATES_NOT_DAILY_FULL" if is_sampled else None,
            requests_made=reqs,
        )

    async def fetch_opex_and_gex_summary(
        self,
        ticker: str,
        sample_dates: Sequence[OpexSampleDate | str],
        *,
        spot_by_date: Mapping[str, float] | None = None,
    ) -> pl.DataFrame:
        """Stream ``/datav2/hist/strikes`` per sampled date concurrently and discard raw chains immediately."""
        sym = ticker.strip().upper()
        spot_map = spot_by_date or {}

        async def _fetch_one(item: OpexSampleDate | str) -> dict[str, Any]:
            if isinstance(item, OpexSampleDate):
                td = item.trade_date
                mode = item.sampling_mode
                is_quad = item.is_quad_witching
                opex_dt = item.opex_date
            else:
                td = str(item)
                mode = "PRE_OPEX"
                is_quad = False
                opex_dt = None

            resp = await self._t.request_json(
                "ORATS_HISTORICAL",
                "/datav2/hist/strikes",
                params={"ticker": sym, "tradeDate": td},
                allow_404=True,
            )
            massive_spot = spot_map.get(td)
            if resp.status_code == 404 or not isinstance(resp.payload, dict):
                summary = compute_gex_opex_summary_from_strikes(
                    sym,
                    td,
                    (),
                    massive_spot=massive_spot,
                    sampling_mode=mode,
                    is_quad_witching=is_quad,
                    monthly_opex_date=opex_dt,
                )
                summary["coverage_status"] = "UNSUPPORTED_COVERAGE" if resp.status_code == 404 else "EMPTY_VERIFIED"
                summary["quality_reason"] = "HTTP_404_NO_STRIKES" if resp.status_code == 404 else "EMPTY_STRIKES_PAYLOAD"
                return summary

            chain_rows = resp.payload.get("data") or []
            return compute_gex_opex_summary_from_strikes(
                sym,
                td,
                chain_rows,
                massive_spot=massive_spot,
                sampling_mode=mode,
                is_quad_witching=is_quad,
                monthly_opex_date=opex_dt,
            )

        if not sample_dates:
            return pl.DataFrame(schema=ORATS_GEX_OPEX_SCHEMA)
        summaries = list(await asyncio.gather(*(_fetch_one(item) for item in sample_dates)))
        return pl.DataFrame(summaries, schema=ORATS_GEX_OPEX_SCHEMA).sort(["trade_date", "sampling_mode"])

    async def fetch_hist_wham_macro_batch(
        self,
        tickers: Sequence[str],
        target_dates: Sequence[str],
        *,
        asset_classes: Mapping[str, str] | None = None,
        existing_df_by_ticker: Mapping[str, pl.DataFrame] | None = None,
        existing_absent_by_ticker: Mapping[str, Iterable[str]] | None = None,
        batch_size: int = 10,
    ) -> OratsWhamMacroBatchResult:
        """Fetch WHAM strictly on resolved macro dates with multi-ETF batching and per-(ticker, date) validation."""
        ac_map = {k.upper(): v for k, v in (asset_classes or {}).items()}
        clean_dates = sorted(
            {
                d[:10]
                for d in target_dates
                if isinstance(d, str) and len(d) >= 10 and d[:10] >= WHAM_FLOOR_DATE.isoformat()
            }
        )
        etf_tickers: list[str] = []
        by_ticker_data: dict[str, pl.DataFrame] = {}
        by_ticker_manifest: dict[str, dict[str, Any]] = {}

        for raw_sym in tickers:
            sym = raw_sym.strip().upper()
            ac = ac_map.get(sym, "US_ETF")
            if ac != "US_ETF":
                by_ticker_data[sym] = pl.DataFrame(schema=ORATS_WHAM_SCHEMA)
                by_ticker_manifest[sym] = {
                    "ticker": sym,
                    "asset_class": ac,
                    "target_dates": [],
                    "requested_dates": [],
                    "recovered_dates": [],
                    "verified_absent_dates": [],
                    "pending_dates": [],
                    "errors": [],
                    "retries": 0,
                    "requests_made": 0,
                    "status": "EMPTY_VERIFIED",
                    "coverage_scope": "NOT_APPLICABLE_NON_ETF",
                }
            else:
                etf_tickers.append(sym)

        if not etf_tickers or not clean_dates:
            for sym in etf_tickers:
                by_ticker_data[sym] = pl.DataFrame(schema=ORATS_WHAM_SCHEMA)
                by_ticker_manifest[sym] = {
                    "ticker": sym,
                    "asset_class": "US_ETF",
                    "target_dates": clean_dates,
                    "requested_dates": [],
                    "recovered_dates": [],
                    "verified_absent_dates": [],
                    "pending_dates": list(clean_dates),
                    "errors": [],
                    "retries": 0,
                    "requests_made": 0,
                    "status": "EMPTY_VERIFIED" if not clean_dates else "PARTIAL",
                    "coverage_scope": "EMPTY_MACRO_WINDOW" if not clean_dates else "MACRO_EVENT_DATES_PARTIAL",
                }
            return OratsWhamMacroBatchResult(
                by_ticker_data=by_ticker_data,
                by_ticker_manifest=by_ticker_manifest,
                requests_made=0,
                retries=0,
                errors=(),
            )

        existing_rows_map: dict[str, dict[str, dict[str, Any]]] = {sym: {} for sym in etf_tickers}
        best_qd_by_key: dict[tuple[str, str], str] = {}
        absent_map: dict[str, set[str]] = {
            sym: set((existing_absent_by_ticker or {}).get(sym, ())) for sym in etf_tickers
        }
        for sym in etf_tickers:
            ex_df = (existing_df_by_ticker or {}).get(sym)
            if ex_df is not None and ex_df.height > 0:
                for r in ex_df.iter_rows(named=True):
                    td = str(r.get("trade_date") or "").strip()[:10]
                    if td:
                        p_str = str(r.get("payload_json") or "{}")
                        existing_rows_map[sym][td] = {
                            "ticker": sym,
                            "trade_date": td,
                            "wham_status": str(r.get("wham_status") or "OK_DATA"),
                            "payload_json": p_str,
                        }
                        try:
                            qd_old = str(json.loads(p_str).get("quoteDate") or "")
                        except Exception:
                            qd_old = ""
                        best_qd_by_key[(sym, td)] = qd_old

        requested_by_ticker: dict[str, set[str]] = {sym: set() for sym in etf_tickers}
        recovered_by_ticker: dict[str, set[str]] = {
            sym: (set(existing_rows_map[sym].keys()) & set(clean_dates)) for sym in etf_tickers
        }
        verified_absent_by_ticker: dict[str, set[str]] = {
            sym: (absent_map[sym] & set(clean_dates)) - recovered_by_ticker[sym] for sym in etf_tickers
        }
        errors_by_ticker: dict[str, list[str]] = {sym: [] for sym in etf_tickers}
        all_errors: list[str] = []
        total_reqs = 0
        fallback_retries = 0
        step = max(1, min(10, int(batch_size)))
        wham_sem = asyncio.Semaphore(4)

        def _upsert_wham_row(r_sym: str, td: str, r: dict[str, Any]) -> None:
            qd = str(r.get("quoteDate") or "").strip()
            prev_qd = best_qd_by_key.get((r_sym, td), "")
            if (r_sym, td) not in best_qd_by_key or qd >= prev_qd:
                best_qd_by_key[(r_sym, td)] = qd
                existing_rows_map[r_sym][td] = {
                    "ticker": r_sym,
                    "trade_date": td,
                    "wham_status": "OK_DATA",
                    "payload_json": json.dumps(r, sort_keys=True),
                }
            recovered_by_ticker[r_sym].add(td)
            verified_absent_by_ticker[r_sym].discard(td)

        async def _query_single(sym: str, td: str) -> None:
            nonlocal total_reqs
            requested_by_ticker[sym].add(td)
            total_reqs += 1
            try:
                async with wham_sem:
                    resp = await self._t.request_json(
                        "ORATS_HISTORICAL",
                        "/datav2/hist/wham",
                        params={"ticker": sym, "tradeDate": td},
                        allow_404=True,
                    )
            except Exception as exc:
                msg = f"{sym}@{td}:{type(exc).__name__}"
                errors_by_ticker[sym].append(msg)
                all_errors.append(msg)
                return

            if resp.status_code == 404:
                verified_absent_by_ticker[sym].add(td)
                return
            if not isinstance(resp.payload, dict) or not isinstance(resp.payload.get("data"), list):
                msg = f"{sym}@{td}:MALFORMED_WHAM_PAYLOAD"
                errors_by_ticker[sym].append(msg)
                all_errors.append(msg)
                return

            matched = 0
            for r in resp.payload.get("data") or []:
                if not isinstance(r, dict):
                    continue
                r_sym = str(r.get("ticker") or sym).strip().upper()
                r_td = str(r.get("tradeDate") or r.get("date") or td).strip()[:10]
                if r_sym == sym and r_td == td:
                    _upsert_wham_row(sym, td, r)
                    matched += 1
            if matched == 0:
                verified_absent_by_ticker[sym].add(td)

        async def _process_wham_chunk(td: str, chunk: list[str]) -> None:
            nonlocal total_reqs, fallback_retries
            if len(chunk) == 1:
                await _query_single(chunk[0], td)
                return

            for s in chunk:
                requested_by_ticker[s].add(td)
            total_reqs += 1
            try:
                async with wham_sem:
                    resp = await self._t.request_json(
                        "ORATS_HISTORICAL",
                        "/datav2/hist/wham",
                        params={"ticker": ",".join(chunk), "tradeDate": td},
                        allow_404=True,
                    )
            except Exception as exc:
                all_errors.append(f"BATCH({','.join(chunk)})@{td}:{type(exc).__name__}")
                for s in chunk:
                    fallback_retries += 1
                    await _query_single(s, td)
                return

            if resp.status_code == 404 or not isinstance(resp.payload, dict) or not isinstance(resp.payload.get("data"), list):
                for s in chunk:
                    fallback_retries += 1
                    await _query_single(s, td)
                return

            chunk_set = set(chunk)
            resolved_in_batch: set[str] = set()
            for r in resp.payload.get("data") or []:
                if not isinstance(r, dict):
                    continue
                r_sym = str(r.get("ticker") or "").strip().upper()
                r_td = str(r.get("tradeDate") or r.get("date") or td).strip()[:10]
                if r_sym in chunk_set and r_td == td:
                    _upsert_wham_row(r_sym, td, r)
                    resolved_in_batch.add(r_sym)

            missing_in_batch = [s for s in chunk if s not in resolved_in_batch]
            for s in missing_in_batch:
                fallback_retries += 1
                await _query_single(s, td)

        wham_jobs: list[tuple[str, list[str]]] = []
        for td in clean_dates:
            pending_syms = [
                sym
                for sym in etf_tickers
                if td not in recovered_by_ticker[sym] and td not in verified_absent_by_ticker[sym]
            ]
            if not pending_syms:
                continue
            for idx in range(0, len(pending_syms), step):
                wham_jobs.append((td, pending_syms[idx : idx + step]))

        if wham_jobs:
            await asyncio.gather(*(_process_wham_chunk(td, ch) for td, ch in wham_jobs))

        for sym in etf_tickers:
            rows_list = [existing_rows_map[sym][k] for k in sorted(existing_rows_map[sym].keys())]
            df_sym = (
                pl.DataFrame(rows_list, schema=ORATS_WHAM_SCHEMA).sort("trade_date")
                if rows_list
                else pl.DataFrame(schema=ORATS_WHAM_SCHEMA)
            )
            by_ticker_data[sym] = df_sym
            rec = sorted(recovered_by_ticker[sym])
            v_abs = sorted(verified_absent_by_ticker[sym] - recovered_by_ticker[sym])
            pend = sorted(set(clean_dates) - set(rec) - set(v_abs))
            is_complete = len(pend) == 0 and (len(rec) > 0 or len(v_abs) > 0)
            by_ticker_manifest[sym] = {
                "ticker": sym,
                "asset_class": "US_ETF",
                "target_dates": list(clean_dates),
                "requested_dates": sorted(requested_by_ticker[sym]),
                "recovered_dates": rec,
                "verified_absent_dates": v_abs,
                "pending_dates": pend,
                "errors": list(errors_by_ticker[sym]),
                "retries": fallback_retries,
                "requests_made": total_reqs,
                "status": "COMPLETE" if is_complete else "PARTIAL",
                "coverage_scope": (
                    "MACRO_EVENT_DATES_COMPLETE" if is_complete else "MACRO_EVENT_DATES_PARTIAL"
                ),
            }

        return OratsWhamMacroBatchResult(
            by_ticker_data=by_ticker_data,
            by_ticker_manifest=by_ticker_manifest,
            requests_made=total_reqs,
            retries=fallback_retries,
            errors=tuple(all_errors),
        )

    async def fetch_opex_and_gex_summary_batched(
        self,
        schedules_by_ticker: Mapping[str, Sequence[OpexSampleDate | str]],
        *,
        spot_by_ticker_date: Mapping[tuple[str, str], float] | None = None,
        batch_size: int = 10,
        max_rows_truncation_guard: int = 250_000,
    ) -> OratsBatchedOpexResult:
        """Batch up to 10 tickers per shared ``tradeDate`` on ``/datav2/hist/strikes`` (for Prompt #5)."""
        spot_map = spot_by_ticker_date or {}
        step = max(1, min(10, int(batch_size)))
        meta_by_key: dict[tuple[str, str], tuple[str, bool, str | None]] = {}
        tickers_by_date: dict[str, list[str]] = {}

        for raw_sym, sched in schedules_by_ticker.items():
            sym = raw_sym.strip().upper()
            for item in sched:
                if isinstance(item, OpexSampleDate):
                    td = item.trade_date
                    meta_by_key[(sym, td)] = (item.sampling_mode, item.is_quad_witching, item.opex_date)
                else:
                    td = str(item)[:10]
                    meta_by_key[(sym, td)] = ("PRE_OPEX", False, None)
                tickers_by_date.setdefault(td, [])
                if sym not in tickers_by_date[td]:
                    tickers_by_date[td].append(sym)

        summaries_by_ticker: dict[str, list[dict[str, Any]]] = {
            raw_sym.strip().upper(): [] for raw_sym in schedules_by_ticker.keys()
        }
        reqs = 0
        batches_sent = 0
        fallbacks = 0
        truncated_batches = 0
        dups_removed = 0

        def _dedup_and_summarize(sym: str, td: str, raw_rows: list[dict[str, Any]], *, missing_404: bool = False) -> dict[str, Any]:
            nonlocal dups_removed
            mode, is_quad, opex_dt = meta_by_key[(sym, td)]
            spot = spot_map.get((sym, td))
            if missing_404 or not raw_rows:
                out = compute_gex_opex_summary_from_strikes(
                    sym,
                    td,
                    (),
                    massive_spot=spot,
                    sampling_mode=mode,
                    is_quad_witching=is_quad,
                    monthly_opex_date=opex_dt,
                )
                out["coverage_status"] = "UNSUPPORTED_COVERAGE" if missing_404 else "EMPTY_VERIFIED"
                out["quality_reason"] = "HTTP_404_NO_STRIKES" if missing_404 else "EMPTY_STRIKES_PAYLOAD"
                return out

            deduped: list[dict[str, Any]] = []
            seen_keys: set[tuple[str, str, str, str]] = set()
            for r in raw_rows:
                exp = str(r.get("expirDate") or "").strip()
                k_val = str(r.get("strike") or "")
                ukey = (sym, td, exp, k_val)
                if ukey in seen_keys:
                    dups_removed += 1
                    continue
                seen_keys.add(ukey)
                deduped.append(r)

            out = compute_gex_opex_summary_from_strikes(
                sym,
                td,
                deduped,
                massive_spot=spot,
                sampling_mode=mode,
                is_quad_witching=is_quad,
                monthly_opex_date=opex_dt,
            )
            if not out["nearest_expir_date"] or out["nearest_expir_date"] < td:
                out["quality_reason"] = f"{out['quality_reason']}|EXPIRATION_COVERAGE_WARN".lstrip("|")
            return out

        opex_sem = asyncio.Semaphore(4)

        async def _single_fallback(sym: str, td: str) -> None:
            nonlocal reqs, fallbacks
            fallbacks += 1
            reqs += 1
            async with opex_sem:
                resp = await self._t.request_json(
                    "ORATS_HISTORICAL",
                    "/datav2/hist/strikes",
                    params={"ticker": sym, "tradeDate": td},
                    allow_404=True,
                )
            if resp.status_code == 404 or not isinstance(resp.payload, dict):
                summaries_by_ticker[sym].append(_dedup_and_summarize(sym, td, [], missing_404=(resp.status_code == 404)))
                return
            valid_rows = [
                r
                for r in (resp.payload.get("data") or [])
                if isinstance(r, dict)
                and str(r.get("ticker") or sym).strip().upper() == sym
                and (not r.get("tradeDate") or str(r.get("tradeDate")).strip()[:10] == td)
            ]
            summaries_by_ticker[sym].append(_dedup_and_summarize(sym, td, valid_rows))

        async def _process_opex_chunk(td: str, chunk: list[str]) -> None:
            nonlocal reqs, batches_sent, truncated_batches
            if len(chunk) == 1:
                reqs += 1
                sym = chunk[0]
                async with opex_sem:
                    resp = await self._t.request_json(
                        "ORATS_HISTORICAL",
                        "/datav2/hist/strikes",
                        params={"ticker": sym, "tradeDate": td},
                        allow_404=True,
                    )
                if resp.status_code == 404 or not isinstance(resp.payload, dict):
                    summaries_by_ticker[sym].append(_dedup_and_summarize(sym, td, [], missing_404=(resp.status_code == 404)))
                else:
                    valid_rows = [
                        r
                        for r in (resp.payload.get("data") or [])
                        if isinstance(r, dict)
                        and str(r.get("ticker") or sym).strip().upper() == sym
                        and (not r.get("tradeDate") or str(r.get("tradeDate")).strip()[:10] == td)
                    ]
                    summaries_by_ticker[sym].append(_dedup_and_summarize(sym, td, valid_rows))
                return

            batches_sent += 1
            reqs += 1
            try:
                async with opex_sem:
                    resp = await self._t.request_json(
                        "ORATS_HISTORICAL",
                        "/datav2/hist/strikes",
                        params={"ticker": ",".join(chunk), "tradeDate": td},
                        allow_404=True,
                    )
            except Exception:
                for sym in chunk:
                    await _single_fallback(sym, td)
                return

            if resp.status_code == 404 or not isinstance(resp.payload, dict):
                for sym in chunk:
                    await _single_fallback(sym, td)
                return

            data_rows = resp.payload.get("data") or []
            is_truncated = bool(resp.payload.get("truncated")) or len(data_rows) >= max_rows_truncation_guard
            if is_truncated:
                truncated_batches += 1
                for sym in chunk:
                    await _single_fallback(sym, td)
                return

            chunk_set = set(chunk)
            rows_by_sym: dict[str, list[dict[str, Any]]] = {sym: [] for sym in chunk}
            mismatched_syms: set[str] = set()
            for r in data_rows:
                if not isinstance(r, dict):
                    continue
                r_sym = str(r.get("ticker") or "").strip().upper()
                r_td = str(r.get("tradeDate") or td).strip()[:10]
                if r_sym not in chunk_set:
                    continue
                if r_td != td:
                    mismatched_syms.add(r_sym)
                    continue
                rows_by_sym[r_sym].append(r)

            for sym in chunk:
                if sym in mismatched_syms or len(rows_by_sym[sym]) == 0:
                    await _single_fallback(sym, td)
                else:
                    summaries_by_ticker[sym].append(_dedup_and_summarize(sym, td, rows_by_sym[sym]))

        opex_jobs: list[tuple[str, list[str]]] = []
        for td in sorted(tickers_by_date.keys()):
            t_list = sorted(tickers_by_date[td])
            for idx in range(0, len(t_list), step):
                opex_jobs.append((td, t_list[idx : idx + step]))

        if opex_jobs:
            await asyncio.gather(*(_process_opex_chunk(td, ch) for td, ch in opex_jobs))

        by_ticker_df = {
            sym: (
                pl.DataFrame(rows, schema=ORATS_GEX_OPEX_SCHEMA).sort(["trade_date", "sampling_mode"])
                if rows
                else pl.DataFrame(schema=ORATS_GEX_OPEX_SCHEMA)
            )
            for sym, rows in summaries_by_ticker.items()
        }
        return OratsBatchedOpexResult(
            by_ticker_data=by_ticker_df,
            requests_made=reqs,
            batches_sent=batches_sent,
            fallbacks_triggered=fallbacks,
            truncated_batches_detected=truncated_batches,
            duplicates_removed=dups_removed,
        )
