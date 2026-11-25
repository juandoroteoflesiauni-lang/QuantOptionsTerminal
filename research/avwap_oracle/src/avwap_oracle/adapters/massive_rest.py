"""Asynchronous Massive REST adapters for raw 1m stocks, corporate actions, float, and options.

Empirical contract anchors (Prompt #1 & repo ``docs/massive_plan_reference.md``):
- ``/v2/aggs/ticker/{ticker}/range/1/minute/{from}/{to}?adjusted=false&sort=asc&limit=50000``
  returns unadjusted bars with ``t`` in Unix milliseconds (converted via ``t // 1000`` to Int64 UTC s)
  and finite ``vw`` even when ``vw`` lies outside ``[low, high]``.
- ``/stocks/v1/splits`` and ``/stocks/v1/dividends`` paginate via ``next_url``.
- ``/stocks/vX/float`` is literally Massive's live reference float endpoint (verified HTTP 200
  for AAPL & MELI in ``probe_phase1_results.json``) returning a current/latest snapshot (NOT PIT).
- ``/options/v1/unusual-trades`` & ``/options/v1/open-interest`` use EXCLUSIVELY ``OPTIONS_REST``
  (``MASSIVE_API_KEY``), bounded strictly to ``>= 2022-09-01``.
"""

from __future__ import annotations

import datetime as dt
import math
import re
import time
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

import numpy as np
import polars as pl

from avwap_oracle.adapters.credentials import (
    AsyncProviderTransport,
    ConflictingDuplicateBarError,
    ProviderAuthorizationError,
)
from avwap_oracle.math_core.nyse_calendar import ET_TZ, MAX_UTC_SECONDS, get_session_bounds

MASSIVE_FLOAT_ENDPOINT = "/stocks/vX/float"
OPRA_HISTORY_FLOOR = dt.date(2022, 9, 1)
_OCC_OPTION_RE = re.compile(r"^O:([A-Z0-9.]+?)(\d{6})([CP])(\d{8})$")
NO_AGGRESSOR_SIDE_REASON = "NO_NBBO_AGGRESSOR_SIDE_IN_UNUSUAL_TRADES"

RAW_1M_SCHEMA: dict[str, pl.DataType] = {
    "ticker": pl.String,
    "ts_utc_s": pl.Int64,
    "o": pl.Float64,
    "h": pl.Float64,
    "l": pl.Float64,
    "c": pl.Float64,
    "v": pl.Float64,
    "vw": pl.Float64,
    "n": pl.Int64,
}

QUARANTINE_1M_SCHEMA: dict[str, pl.DataType] = {
    **RAW_1M_SCHEMA,
    "reject_reason": pl.String,
}

SPLITS_SCHEMA: dict[str, pl.DataType] = {
    "ticker": pl.String,
    "execution_date": pl.String,
    "split_from": pl.Float64,
    "split_to": pl.Float64,
    "historical_adjustment_factor": pl.Float64,
    "adjustment_type": pl.String,
    "event_id": pl.String,
}

DIVIDENDS_SCHEMA: dict[str, pl.DataType] = {
    "ticker": pl.String,
    "ex_dividend_date": pl.String,
    "cash_amount": pl.Float64,
    "currency": pl.String,
    "distribution_type": pl.String,
    "frequency": pl.Int64,
    "historical_adjustment_factor": pl.Float64,
    "split_adjusted_cash_amount": pl.Float64,
    "declaration_date": pl.String,
    "record_date": pl.String,
    "pay_date": pl.String,
    "event_id": pl.String,
}

UNUSUAL_TRADES_SCHEMA: dict[str, pl.DataType] = {
    "underlying_ticker": pl.String,
    "option_ticker": pl.String,
    "root": pl.String,
    "ts_utc_s": pl.Int64,
    "sip_timestamp_ns": pl.String,
    "price": pl.Float64,
    "size": pl.Float64,
    "shares_per_contract": pl.Float64,
    "notional": pl.Float64,
    "exchange": pl.Int64,
    "flags": pl.String,
    "sequence_number": pl.Int64,
}

OI_DAILY_SCHEMA: dict[str, pl.DataType] = {
    "ticker": pl.String,
    "trade_date": pl.String,
    "total_call_oi": pl.Int64,
    "total_put_oi": pl.Int64,
    "total_oi": pl.Int64,
}

UNUSUAL_DAILY_SUMMARY_SCHEMA: dict[str, pl.DataType] = {
    "ticker": pl.String,
    "trade_date": pl.String,
    "trigger_reason": pl.String,
    "opt_vol_ratio_20d": pl.Float64,
    "delta_oi_z": pl.Float64,
    "eligible_print_count": pl.Int64,
    "block_count": pl.Int64,
    "iso_count": pl.Int64,
    "call_premium": pl.Float64,
    "put_premium": pl.Float64,
    "net_directional_premium": pl.Float64,
    "net_directional_reason": pl.String,
    "max_single_premium": pl.Float64,
    "first_shock_ts_utc_s": pl.Int64,
    "unverified_adj_root_count": pl.Int64,
    "pages_fetched": pl.Int64,
    "raw_rows_scanned": pl.Int64,
    "is_complete_day": pl.Boolean,
    "available_at_utc_s": pl.Int64,
}

EVENT_GATED_CANDIDATES_SCHEMA: dict[str, pl.DataType] = {
    "ticker": pl.String,
    "trade_date": pl.String,
    "opt_vol": pl.Float64,
    "opt_vol_ratio_20d": pl.Float64,
    "effective_total_oi": pl.Float64,
    "oi_source": pl.String,
    "delta_oi_z": pl.Float64,
    "trigger_vol": pl.Boolean,
    "trigger_oi": pl.Boolean,
    "trigger_reason": pl.String,
}


@dataclass(frozen=True)
class MassiveAggs1mResult:
    bars: pl.DataFrame
    quarantine: pl.DataFrame
    rows_received: int
    rows_accepted: int
    rows_quarantined: int
    duplicates_exact: int
    vw_outside_ohlc_count: int
    pages: int


@dataclass(frozen=True)
class MassiveOptionsResult:
    data: pl.DataFrame
    status: str  # COMPLETE | PARTIAL | EMPTY_VERIFIED | UNSUPPORTED_COVERAGE
    pages: int
    rows_received: int
    truncated: bool
    note: str | None = None


@dataclass(frozen=True)
class MassiveEventGatedUnusualResult:
    data: pl.DataFrame
    coverage_manifest: dict[str, Any]
    status: str  # COMPLETE | PARTIAL | EMPTY_VERIFIED | UNSUPPORTED_COVERAGE
    coverage_scope: str  # EVENT_GATED_COMPLETE | EVENT_GATED_PARTIAL | EMPTY_EVENT_GATED
    requests_made: int
    raw_rows_scanned: int
    note: str | None = None


def parse_occ_option_right(option_ticker: str) -> str | None:
    """Return ``'C'`` or ``'P'`` from an OCC symbol like ``O:SPY240621C00500000``."""
    m = _OCC_OPTION_RE.match((option_ticker or "").strip().upper())
    return m.group(3) if m else None


def _next_trading_day(d: dt.date) -> dt.date:
    cur = d + dt.timedelta(days=1)
    while get_session_bounds(cur) is None:
        cur += dt.timedelta(days=1)
    return cur


def _available_at_for_unusual_summary(td_str: str, trigger_reason: str) -> int:
    d = dt.date.fromisoformat(td_str)
    sb = get_session_bounds(d)
    if "OI" in trigger_reason:
        sb_next = get_session_bounds(_next_trading_day(d))
        if sb_next is not None:
            return sb_next.rth_open_utc_s
    if sb is not None:
        return sb.ext_close_utc_s
    sb_next = get_session_bounds(_next_trading_day(d))
    assert sb_next is not None
    return sb_next.rth_open_utc_s


def select_unusual_event_gated_dates(
    orats_cores_df: pl.DataFrame,
    reconciled_oi_df: pl.DataFrame,
    start_date: dt.date | str,
    end_date: dt.date | str,
    *,
    vol_ratio_threshold: float = 2.5,
    delta_oi_z_threshold: float = 3.0,
    vol_window: int = 20,
    oi_window: int = 60,
    oi_min_periods: int = 20,
) -> pl.DataFrame:
    """Select strictly event-gated candidate dates ``>= 2022-09-01`` using strictly past references.

    Methodological contract:
    - ``opt_vol_ratio_20d`` divides session option volume (``c_volu + p_volu``, never OI)
      by the arithmetic mean of the strictly preceding ``vol_window`` (20) valid positive-volume
      sessions (warm-up = 20).
    - ``delta_oi_z`` computes comparable log OI changes ``ln(OI_t / OI_{t-1})`` across valid
      consecutive sessions with compatible sources, standardized against up to ``oi_window`` (60)
      strictly prior changes (warm-up = 20) via ``scale = max(1.4826 * MAD, std_ddof1)``. When
      both MAD and std collapse (``scale <= 1e-12``) or history is missing, ``delta_oi_z = NaN``.
    """
    s_date = max(OPRA_HISTORY_FLOOR, dt.date.fromisoformat(start_date) if isinstance(start_date, str) else start_date)
    e_date = dt.date.fromisoformat(end_date) if isinstance(end_date, str) else end_date
    if s_date > e_date or (orats_cores_df.height == 0 and reconciled_oi_df.height == 0):
        return pl.DataFrame(schema=EVENT_GATED_CANDIDATES_SCHEMA)

    vol_map: dict[tuple[str, str], float] = {}
    if orats_cores_df.height > 0:
        for r in orats_cores_df.select(["ticker", "trade_date", "c_volu", "p_volu"]).to_dicts():
            sym = str(r.get("ticker") or "").strip().upper()
            td = str(r.get("trade_date") or "").strip()[:10]
            cv, pv = r.get("c_volu"), r.get("p_volu")
            if sym and td and cv is not None and pv is not None and int(cv) >= 0 and int(pv) >= 0:
                vol_map[(sym, td)] = float(int(cv) + int(pv))

    oi_map: dict[tuple[str, str], tuple[float, str]] = {}
    if reconciled_oi_df.height > 0:
        for r in reconciled_oi_df.select(["ticker", "trade_date", "effective_total_oi", "oi_source"]).to_dicts():
            sym = str(r.get("ticker") or "").strip().upper()
            td = str(r.get("trade_date") or "").strip()[:10]
            oi_val = r.get("effective_total_oi")
            src = str(r.get("oi_source") or "UNKNOWN")
            if sym and td and oi_val is not None and int(oi_val) > 0:
                oi_map[(sym, td)] = (float(int(oi_val)), src)

    all_tickers = sorted({k[0] for k in vol_map.keys()} | {k[0] for k in oi_map.keys()})
    s_iso, e_iso = s_date.isoformat(), e_date.isoformat()
    out_rows: list[dict[str, Any]] = []

    def _compatible_oi_sources(s0: str, s1: str) -> bool:
        orats_group = {"ORATS_PRIMARY", "ORATS_ONLY", "MASSIVE_FALLBACK"}
        if s0 in orats_group and s1 in orats_group:
            return True
        return s0 == s1

    for sym in all_tickers:
        dates = sorted({td for t, td in vol_map.keys() if t == sym} | {td for t, td in oi_map.keys() if t == sym})
        valid_vols: list[float] = []
        oi_deltas: list[float] = []
        prev_oi: tuple[float, str] | None = None

        for td in dates:
            vol_here = vol_map.get((sym, td), math.nan)
            vol_ratio = math.nan
            if math.isfinite(vol_here) and vol_here > 0.0 and len(valid_vols) >= vol_window:
                ref_mean = math.fsum(valid_vols[-vol_window:]) / float(vol_window)
                if ref_mean > 0.0:
                    vol_ratio = vol_here / ref_mean

            oi_pair = oi_map.get((sym, td))
            delta_here = math.nan
            oi_z = math.nan
            if oi_pair is not None and prev_oi is not None and prev_oi[0] > 0.0 and oi_pair[0] > 0.0:
                if _compatible_oi_sources(prev_oi[1], oi_pair[1]):
                    delta_here = math.log(oi_pair[0] / prev_oi[0])
                    if len(oi_deltas) >= oi_min_periods:
                        win_arr = np.asarray(oi_deltas[-oi_window:], dtype=np.float64)
                        med = float(np.median(win_arr))
                        mad = float(np.median(np.abs(win_arr - med)))
                        sd = float(np.std(win_arr, ddof=1)) if len(win_arr) >= 2 else 0.0
                        scale = max(1.4826 * mad, sd)
                        if math.isfinite(scale) and scale > 1e-12:
                            loc = med if (1.4826 * mad >= sd and mad > 0.0) else float(np.mean(win_arr))
                            oi_z = (delta_here - loc) / scale

            if td >= s_iso and td <= e_iso:
                trig_v = math.isfinite(vol_ratio) and vol_ratio >= vol_ratio_threshold
                trig_o = math.isfinite(oi_z) and abs(oi_z) >= delta_oi_z_threshold
                if trig_v or trig_o:
                    reason = "VOL+OI_SHOCK" if (trig_v and trig_o) else ("VOL_SHOCK" if trig_v else "OI_SHOCK")
                    out_rows.append(
                        {
                            "ticker": sym,
                            "trade_date": td,
                            "opt_vol": vol_here,
                            "opt_vol_ratio_20d": vol_ratio,
                            "effective_total_oi": oi_pair[0] if oi_pair is not None else math.nan,
                            "oi_source": oi_pair[1] if oi_pair is not None else "UNAVAILABLE",
                            "delta_oi_z": oi_z,
                            "trigger_vol": trig_v,
                            "trigger_oi": trig_o,
                            "trigger_reason": reason,
                        }
                    )

            # Strictly causal trailing state update AFTER evaluating td
            if math.isfinite(vol_here) and vol_here > 0.0:
                valid_vols.append(vol_here)
            if math.isfinite(delta_here):
                oi_deltas.append(delta_here)
            if oi_pair is not None:
                prev_oi = oi_pair

    if not out_rows:
        return pl.DataFrame(schema=EVENT_GATED_CANDIDATES_SCHEMA)
    return pl.DataFrame(out_rows, schema=EVENT_GATED_CANDIDATES_SCHEMA).sort(["ticker", "trade_date"])


def _make_empty_day_summary(
    sym: str,
    td: str,
    cand_row: Mapping[str, Any],
    *,
    pages_fetched: int,
    raw_rows_scanned: int,
    is_complete_day: bool,
) -> dict[str, Any]:
    trig_reason = str(cand_row.get("trigger_reason") or "EVENT_GATED")
    return {
        "ticker": sym,
        "trade_date": td,
        "trigger_reason": trig_reason,
        "opt_vol_ratio_20d": float(cand_row.get("opt_vol_ratio_20d", math.nan)),
        "delta_oi_z": float(cand_row.get("delta_oi_z", math.nan)),
        "eligible_print_count": 0,
        "block_count": 0,
        "iso_count": 0,
        "call_premium": 0.0,
        "put_premium": 0.0,
        "net_directional_premium": math.nan,
        "net_directional_reason": NO_AGGRESSOR_SIDE_REASON,
        "max_single_premium": math.nan,
        "first_shock_ts_utc_s": None,
        "unverified_adj_root_count": 0,
        "pages_fetched": int(pages_fetched),
        "raw_rows_scanned": int(raw_rows_scanned),
        "is_complete_day": bool(is_complete_day),
        "available_at_utc_s": _available_at_for_unusual_summary(td, trig_reason),
    }


def _aggregate_day_trades_streaming(
    sym: str,
    td: str,
    cand_row: Mapping[str, Any],
    trade_iter: Any,
    *,
    pages_fetched: int,
    raw_rows_scanned: int,
    is_complete_day: bool,
) -> dict[str, Any]:
    block_count = 0
    iso_count = 0
    eligible_count = 0
    call_prem = 0.0
    put_prem = 0.0
    max_prem = math.nan
    first_ts: int | None = None
    unverified_adj = 0

    for item in trade_iter:
        # tuple: (option_ticker, ts_s, px, sz, notional, is_iso, is_unverified_adj)
        opt_tkr, ts_s, _px, sz, notional, is_iso, is_unv = item
        if is_unv and (not math.isfinite(sz) or sz < 1_000.0):
            unverified_adj += 1
            continue
        is_block = (math.isfinite(notional) and notional >= 100_000.0) or (math.isfinite(sz) and sz >= 1_000.0)
        eligible = is_block or (is_iso and math.isfinite(notional) and notional >= 25_000.0)
        if not eligible:
            continue

        eligible_count += 1
        if is_block:
            block_count += 1
        if is_iso:
            iso_count += 1
        if first_ts is None or ts_s < first_ts:
            first_ts = ts_s

        if math.isfinite(notional):
            if not math.isfinite(max_prem) or notional > max_prem:
                max_prem = notional
            right = parse_occ_option_right(opt_tkr)
            if right == "C":
                call_prem += notional
            elif right == "P":
                put_prem += notional
        elif is_unv:
            unverified_adj += 1

    trig_reason = str(cand_row.get("trigger_reason") or "EVENT_GATED")
    return {
        "ticker": sym,
        "trade_date": td,
        "trigger_reason": trig_reason,
        "opt_vol_ratio_20d": float(cand_row.get("opt_vol_ratio_20d", math.nan)),
        "delta_oi_z": float(cand_row.get("delta_oi_z", math.nan)),
        "eligible_print_count": eligible_count,
        "block_count": block_count,
        "iso_count": iso_count,
        "call_premium": call_prem,
        "put_premium": put_prem,
        "net_directional_premium": math.nan,
        "net_directional_reason": NO_AGGRESSOR_SIDE_REASON,
        "max_single_premium": max_prem,
        "first_shock_ts_utc_s": first_ts,
        "unverified_adj_root_count": unverified_adj,
        "pages_fetched": int(pages_fetched),
        "raw_rows_scanned": int(raw_rows_scanned),
        "is_complete_day": bool(is_complete_day),
        "available_at_utc_s": _available_at_for_unusual_summary(td, trig_reason),
    }


def reduce_raw_unusual_trades_to_summary(
    ticker: str,
    raw_trades_df: pl.DataFrame,
    candidate_df: pl.DataFrame,
) -> pl.DataFrame:
    """Offline reducer converting a verified COMPLETE Prompt #3 raw trades frame to ``UNUSUAL_DAILY_SUMMARY_SCHEMA``."""
    sym = ticker.strip().upper()
    if candidate_df.height == 0:
        return pl.DataFrame(schema=UNUSUAL_DAILY_SUMMARY_SCHEMA)
    cands = candidate_df.filter(pl.col("ticker") == sym).sort("trade_date")
    if cands.height == 0:
        return pl.DataFrame(schema=UNUSUAL_DAILY_SUMMARY_SCHEMA)

    grouped_by_date: dict[str, list[tuple[str, int, float, float, float, bool, bool]]] = {}
    if raw_trades_df.height > 0:
        deduped = raw_trades_df.unique(subset=["option_ticker", "sip_timestamp_ns", "sequence_number"]).with_columns(
            pl.from_epoch(pl.col("ts_utc_s"), time_unit="s")
            .dt.replace_time_zone("UTC")
            .dt.convert_time_zone("America/New_York")
            .dt.strftime("%Y-%m-%d")
            .alias("_et_td")
        )
        for r in deduped.iter_rows(named=True):
            td = str(r["_et_td"])
            root = str(r.get("root") or sym).upper()
            flags_str = str(r.get("flags") or "").lower()
            is_iso = "iso" in [x.strip() for x in flags_str.split(",") if x.strip()]
            notional = _safe_float(r.get("notional"))
            is_unv = _classify_option_root(root, sym) and not math.isfinite(notional)
            grouped_by_date.setdefault(td, []).append(
                (
                    str(r.get("option_ticker") or ""),
                    int(r["ts_utc_s"]),
                    _safe_float(r.get("price")),
                    _safe_float(r.get("size")),
                    notional,
                    is_iso,
                    is_unv,
                )
            )

    out_rows: list[dict[str, Any]] = []
    for cand in cands.iter_rows(named=True):
        td = str(cand["trade_date"])
        items = grouped_by_date.get(td, [])
        if not items:
            out_rows.append(
                _make_empty_day_summary(sym, td, cand, pages_fetched=0, raw_rows_scanned=0, is_complete_day=True)
            )
        else:
            out_rows.append(
                _aggregate_day_trades_streaming(
                    sym,
                    td,
                    cand,
                    items,
                    pages_fetched=0,
                    raw_rows_scanned=len(items),
                    is_complete_day=True,
                )
            )
    return pl.DataFrame(out_rows, schema=UNUSUAL_DAILY_SUMMARY_SCHEMA).sort("trade_date")


def _date_chunks(start_date: dt.date, end_date: dt.date, chunk_days: int) -> list[tuple[dt.date, dt.date]]:
    if start_date > end_date:
        return []
    chunks: list[tuple[dt.date, dt.date]] = []
    cur = start_date
    step = dt.timedelta(days=max(1, chunk_days) - 1)
    while cur <= end_date:
        c_end = min(end_date, cur + step)
        chunks.append((cur, c_end))
        cur = c_end + dt.timedelta(days=1)
    return chunks


def _is_finite_pos(val: Any) -> tuple[bool, float]:
    if isinstance(val, bool) or val is None:
        return False, math.nan
    try:
        f = float(val)
    except (TypeError, ValueError):
        return False, math.nan
    if not math.isfinite(f) or f <= 0.0:
        return False, f
    return True, f


def _safe_float(val: Any) -> float:
    if isinstance(val, bool) or val is None:
        return math.nan
    try:
        f = float(val)
    except (TypeError, ValueError):
        return math.nan
    return f if math.isfinite(f) else math.nan


def _rows_equal(a: dict[str, Any], b: dict[str, Any]) -> bool:
    for col in ("o", "h", "l", "c", "v", "vw"):
        va, vb = float(a[col]), float(b[col])
        if math.isnan(va) and math.isnan(vb):
            continue
        if not math.isclose(va, vb, rel_tol=1e-12, abs_tol=1e-12):
            return False
    return int(a["n"]) == int(b["n"])


def _build_occ_prefix_bounds(symbol: str) -> tuple[str, str]:
    clean = symbol.strip().upper().replace(".", "")
    return f"O:{clean}0", f"O:{clean}:"


def _classify_option_root(root: str, underlying: str) -> bool:
    """Return True if root has an adjusted/numeric suffix relative to underlying."""
    if not root:
        return False
    return root != underlying and any(ch.isdigit() for ch in root)


class MassiveRestClient:
    """Async Massive adapter enforcing domain segregation and raw-unit contracts."""

    def __init__(self, transport: AsyncProviderTransport) -> None:
        self._t = transport

    async def fetch_aggs_1m_raw(
        self,
        ticker: str,
        start_date: dt.date | str,
        end_date: dt.date | str,
        *,
        chunk_days: int = 45,
        max_pages_per_chunk: int = 20,
    ) -> MassiveAggs1mResult:
        s_date = dt.date.fromisoformat(start_date) if isinstance(start_date, str) else start_date
        e_date = dt.date.fromisoformat(end_date) if isinstance(end_date, str) else end_date
        sym = ticker.strip().upper()
        if s_date > e_date:
            return MassiveAggs1mResult(
                bars=pl.DataFrame(schema=RAW_1M_SCHEMA),
                quarantine=pl.DataFrame(schema=QUARANTINE_1M_SCHEMA),
                rows_received=0,
                rows_accepted=0,
                rows_quarantined=0,
                duplicates_exact=0,
                vw_outside_ohlc_count=0,
                pages=0,
            )

        accepted_by_ts: dict[int, dict[str, Any]] = {}
        quarantine_rows: list[dict[str, Any]] = []
        rows_received = 0
        duplicates_exact = 0
        vw_outside_ohlc = 0
        total_pages = 0

        for c_start, c_end in _date_chunks(s_date, e_date, chunk_days):
            url: str | None = f"/v2/aggs/ticker/{sym}/range/1/minute/{c_start.isoformat()}/{c_end.isoformat()}"
            params: dict[str, Any] | None = {"adjusted": "false", "sort": "asc", "limit": 50000}
            seen_urls: set[str] = set()
            chunk_pages = 0

            while url is not None and chunk_pages < max_pages_per_chunk:
                resp = await self._t.request_json("MASSIVE_STOCKS_REST", url, params=params, allow_404=True)
                total_pages += 1
                chunk_pages += 1
                if resp.status_code == 404 or not isinstance(resp.payload, dict):
                    break

                raw_list = resp.payload.get("results") or []
                for row in raw_list:
                    rows_received += 1
                    t_ms = row.get("t")
                    if isinstance(t_ms, bool) or not isinstance(t_ms, (int, float)):
                        quarantine_rows.append(
                            {
                                "ticker": sym, "ts_utc_s": -1, "o": math.nan, "h": math.nan,
                                "l": math.nan, "c": math.nan, "v": math.nan, "vw": math.nan,
                                "n": 0, "reject_reason": "INVALID_TIMESTAMP",
                            }
                        )
                        continue
                    t_int_ms = int(t_ms)
                    if t_int_ms < 10**11:  # Not Unix ms
                        quarantine_rows.append(
                            {
                                "ticker": sym, "ts_utc_s": t_int_ms, "o": _safe_float(row.get("o")),
                                "h": _safe_float(row.get("h")), "l": _safe_float(row.get("l")),
                                "c": _safe_float(row.get("c")), "v": _safe_float(row.get("v")),
                                "vw": _safe_float(row.get("vw")), "n": int(row.get("n") or 0),
                                "reject_reason": "NON_MS_TIMESTAMP",
                            }
                        )
                        continue
                    ts_s = t_int_ms // 1000
                    if ts_s <= 0 or ts_s > MAX_UTC_SECONDS:
                        quarantine_rows.append(
                            {
                                "ticker": sym, "ts_utc_s": ts_s, "o": _safe_float(row.get("o")),
                                "h": _safe_float(row.get("h")), "l": _safe_float(row.get("l")),
                                "c": _safe_float(row.get("c")), "v": _safe_float(row.get("v")),
                                "vw": _safe_float(row.get("vw")), "n": int(row.get("n") or 0),
                                "reject_reason": "TS_OUT_OF_RANGE",
                            }
                        )
                        continue

                    ok_v, v_f = _is_finite_pos(row.get("v"))
                    ok_vw, vw_f = _is_finite_pos(row.get("vw"))
                    ok_o, o_f = _is_finite_pos(row.get("o"))
                    ok_h, h_f = _is_finite_pos(row.get("h"))
                    ok_l, l_f = _is_finite_pos(row.get("l"))
                    ok_c, c_f = _is_finite_pos(row.get("c"))
                    n_raw = row.get("n")
                    n_i = int(n_raw) if isinstance(n_raw, (int, float)) and not isinstance(n_raw, bool) else 0

                    reason: str | None = None
                    if not ok_v:
                        reason = "NON_POSITIVE_OR_INVALID_VOLUME"
                    elif not ok_vw:
                        # Strictly prohibit silent HLC3 replacement
                        reason = "INVALID_VW"
                    elif not (ok_o and ok_h and ok_l and ok_c) or h_f < l_f or not (l_f <= o_f <= h_f and l_f <= c_f <= h_f):
                        reason = "INVALID_OHLC"

                    if reason is not None:
                        quarantine_rows.append(
                            {
                                "ticker": sym, "ts_utc_s": ts_s, "o": o_f, "h": h_f,
                                "l": l_f, "c": c_f, "v": v_f, "vw": vw_f,
                                "n": n_i, "reject_reason": reason,
                            }
                        )
                        continue

                    record = {
                        "ticker": sym, "ts_utc_s": ts_s, "o": o_f, "h": h_f,
                        "l": l_f, "c": c_f, "v": v_f, "vw": vw_f, "n": n_i,
                    }
                    existing = accepted_by_ts.get(ts_s)
                    if existing is not None:
                        if not _rows_equal(existing, record):
                            raise ConflictingDuplicateBarError(
                                f"Contradictory duplicate 1m bar for {sym} at ts_utc_s={ts_s}: {existing} vs {record}",
                                sanitizer=self._t.sanitizer,
                            )
                        duplicates_exact += 1
                        continue

                    if vw_f < l_f or vw_f > h_f:
                        vw_outside_ohlc += 1
                    accepted_by_ts[ts_s] = record

                next_raw = resp.payload.get("next_url")
                if isinstance(next_raw, str) and next_raw.strip():
                    url = self._t.validate_next_url(next_raw, "MASSIVE_STOCKS_REST", seen_urls)
                    params = None
                else:
                    url = None

        sorted_records = [accepted_by_ts[k] for k in sorted(accepted_by_ts.keys())]
        bars_df = pl.DataFrame(sorted_records, schema=RAW_1M_SCHEMA) if sorted_records else pl.DataFrame(schema=RAW_1M_SCHEMA)
        quar_df = pl.DataFrame(quarantine_rows, schema=QUARANTINE_1M_SCHEMA) if quarantine_rows else pl.DataFrame(schema=QUARANTINE_1M_SCHEMA)
        return MassiveAggs1mResult(
            bars=bars_df,
            quarantine=quar_df,
            rows_received=rows_received,
            rows_accepted=bars_df.height,
            rows_quarantined=quar_df.height,
            duplicates_exact=duplicates_exact,
            vw_outside_ohlc_count=vw_outside_ohlc,
            pages=total_pages,
        )

    async def fetch_splits(self, ticker: str, *, max_pages: int = 20) -> pl.DataFrame:
        sym = ticker.strip().upper()
        url: str | None = "/stocks/v1/splits"
        params: dict[str, Any] | None = {"ticker": sym, "limit": 1000}
        seen_urls: set[str] = set()
        rows: list[dict[str, Any]] = []
        pages = 0

        while url is not None and pages < max_pages:
            resp = await self._t.request_json("MASSIVE_STOCKS_REST", url, params=params, allow_404=True)
            pages += 1
            if resp.status_code == 404 or not isinstance(resp.payload, dict):
                break
            for r in resp.payload.get("results") or []:
                ex_dt = str(r.get("execution_date") or "").strip()
                if not ex_dt:
                    continue
                rows.append(
                    {
                        "ticker": str(r.get("ticker") or sym).upper(),
                        "execution_date": ex_dt,
                        "split_from": _safe_float(r.get("split_from")),
                        "split_to": _safe_float(r.get("split_to")),
                        "historical_adjustment_factor": _safe_float(r.get("historical_adjustment_factor")),
                        "adjustment_type": str(r.get("adjustment_type") or ""),
                        "event_id": str(r.get("id") or f"massive:{sym}:{ex_dt}"),
                    }
                )
            next_raw = resp.payload.get("next_url")
            if isinstance(next_raw, str) and next_raw.strip():
                url = self._t.validate_next_url(next_raw, "MASSIVE_STOCKS_REST", seen_urls)
                params = None
            else:
                url = None

        if not rows:
            return pl.DataFrame(schema=SPLITS_SCHEMA)
        return pl.DataFrame(rows, schema=SPLITS_SCHEMA).unique(subset=["ticker", "execution_date", "event_id"]).sort("execution_date")

    async def fetch_dividends(self, ticker: str, *, max_pages: int = 50) -> pl.DataFrame:
        """Paginate ALL ``/stocks/v1/dividends`` pages to avoid ascending truncation (COST)."""
        sym = ticker.strip().upper()
        url: str | None = "/stocks/v1/dividends"
        params: dict[str, Any] | None = {"ticker": sym, "limit": 1000}
        seen_urls: set[str] = set()
        rows: list[dict[str, Any]] = []
        pages = 0

        while url is not None and pages < max_pages:
            resp = await self._t.request_json("MASSIVE_STOCKS_REST", url, params=params, allow_404=True)
            pages += 1
            if resp.status_code == 404 or not isinstance(resp.payload, dict):
                break
            for r in resp.payload.get("results") or []:
                ex_dt = str(r.get("ex_dividend_date") or "").strip()
                if not ex_dt:
                    continue
                freq_raw = r.get("frequency")
                freq_i = int(freq_raw) if isinstance(freq_raw, (int, float)) and not isinstance(freq_raw, bool) else -1
                rows.append(
                    {
                        "ticker": str(r.get("ticker") or sym).upper(),
                        "ex_dividend_date": ex_dt,
                        "cash_amount": _safe_float(r.get("cash_amount")),
                        "currency": str(r.get("currency") or "USD").upper(),
                        "distribution_type": str(r.get("distribution_type") or "unknown").lower(),
                        "frequency": freq_i,
                        "historical_adjustment_factor": _safe_float(r.get("historical_adjustment_factor")),
                        "split_adjusted_cash_amount": _safe_float(r.get("split_adjusted_cash_amount")),
                        "declaration_date": str(r.get("declaration_date") or ""),
                        "record_date": str(r.get("record_date") or ""),
                        "pay_date": str(r.get("pay_date") or ""),
                        "event_id": str(r.get("id") or f"massive:{sym}:{ex_dt}"),
                    }
                )
            next_raw = resp.payload.get("next_url")
            if isinstance(next_raw, str) and next_raw.strip():
                url = self._t.validate_next_url(next_raw, "MASSIVE_STOCKS_REST", seen_urls)
                params = None
            else:
                url = None

        if not rows:
            return pl.DataFrame(schema=DIVIDENDS_SCHEMA)
        return pl.DataFrame(rows, schema=DIVIDENDS_SCHEMA).unique(subset=["ticker", "ex_dividend_date", "event_id"]).sort("ex_dividend_date")

    async def fetch_float_snapshot(self, ticker: str) -> dict[str, Any] | None:
        """Fetch current snapshot from verified ``/stocks/vX/float`` (NOT historical PIT)."""
        sym = ticker.strip().upper()
        resp = await self._t.request_json(
            "MASSIVE_STOCKS_REST",
            MASSIVE_FLOAT_ENDPOINT,
            params={"ticker": sym},
            allow_404=True,
        )
        if resp.status_code == 404 or not isinstance(resp.payload, dict):
            return None
        results = resp.payload.get("results") or []
        if not results:
            return None
        row = dict(results[0])
        return {
            "ticker": str(row.get("ticker") or sym).upper(),
            "provider": "massive",
            "endpoint": MASSIVE_FLOAT_ENDPOINT,
            "free_float": _safe_float(row.get("free_float")),
            "free_float_percent": _safe_float(row.get("free_float_percent")),
            "outstanding_shares": math.nan,
            "effective_date": str(row.get("effective_date") or ""),
            "ingested_at_utc_s": int(time.time()),
            "is_point_in_time": False,
            "availability_quality": "CURRENT_SNAPSHOT_ONLY",
        }

    async def fetch_open_close(self, ticker: str, trade_date: str) -> dict[str, Any] | None:
        sym = ticker.strip().upper()
        resp = await self._t.request_json(
            "MASSIVE_STOCKS_REST",
            f"/v1/open-close/{sym}/{trade_date}",
            params={"adjusted": "false"},
            allow_404=True,
        )
        if resp.status_code == 404 or not isinstance(resp.payload, dict):
            return None
        payload = resp.payload
        return {
            "ticker": sym,
            "trade_date": trade_date,
            "open": _safe_float(payload.get("open")),
            "high": _safe_float(payload.get("high")),
            "low": _safe_float(payload.get("low")),
            "close": _safe_float(payload.get("close")),
            "pre_market": _safe_float(payload.get("preMarket")),
            "after_hours": _safe_float(payload.get("afterHours")),
            "volume": _safe_float(payload.get("volume")),
        }

    async def fetch_options_unusual_trades(
        self,
        ticker: str,
        start_date: dt.date | str,
        end_date: dt.date | str,
        *,
        chunk_days: int = 180,
        max_total_pages: int = 10,
    ) -> MassiveOptionsResult:
        """Fetch historical unusual options activity from ``OPTIONS_REST`` (>= 2022-09-01)."""
        s_date = dt.date.fromisoformat(start_date) if isinstance(start_date, str) else start_date
        e_date = dt.date.fromisoformat(end_date) if isinstance(end_date, str) else end_date
        sym = ticker.strip().upper()
        eff_start = max(s_date, OPRA_HISTORY_FLOOR)
        if eff_start > e_date:
            return MassiveOptionsResult(
                data=pl.DataFrame(schema=UNUSUAL_TRADES_SCHEMA),
                status="EMPTY_VERIFIED",
                pages=0,
                rows_received=0,
                truncated=False,
                note=f"Window [{s_date}, {e_date}] strictly precedes OPRA history floor {OPRA_HISTORY_FLOOR}",
            )

        gte_occ, lt_occ = _build_occ_prefix_bounds(sym)
        rows: list[dict[str, Any]] = []
        pages = 0
        rows_received = 0
        truncated = False
        trunc_note: str | None = None

        for c_start, c_end in _date_chunks(eff_start, e_date, chunk_days):
            if pages >= max_total_pages:
                truncated = True
                trunc_note = f"Server ignores flags/min_premium (returns 1-lot ISOs); capped at {max_total_pages} pages in canary"
                break
            start_ns = int(dt.datetime(c_start.year, c_start.month, c_start.day, tzinfo=dt.timezone.utc).timestamp()) * 1_000_000_000
            end_next = c_end + dt.timedelta(days=1)
            end_ns = int(dt.datetime(end_next.year, end_next.month, end_next.day, tzinfo=dt.timezone.utc).timestamp()) * 1_000_000_000

            url: str | None = "/options/v1/unusual-trades"
            params: dict[str, Any] | None = {
                "ticker.gte": gte_occ,
                "ticker.lt": lt_occ,
                "sip_timestamp.gte": str(start_ns),
                "sip_timestamp.lt": str(end_ns),
                "sort": "sip_timestamp",
                "order": "asc",
                "limit": 50000,
            }
            seen_urls: set[str] = set()

            while url is not None:
                if pages >= max_total_pages:
                    truncated = True
                    trunc_note = f"Server ignores flags/min_premium (returns 1-lot ISOs); capped at {max_total_pages} pages in canary"
                    break
                try:
                    resp = await self._t.request_json("MASSIVE_OPTIONS_REST", url, params=params, allow_404=True)
                except ProviderAuthorizationError:
                    return MassiveOptionsResult(
                        data=pl.DataFrame(rows, schema=UNUSUAL_TRADES_SCHEMA) if rows else pl.DataFrame(schema=UNUSUAL_TRADES_SCHEMA),
                        status="UNSUPPORTED_COVERAGE",
                        pages=pages,
                        rows_received=rows_received,
                        truncated=True,
                        note="Endpoint returned 401/403 authorization/entitlement limit",
                    )
                pages += 1
                if resp.status_code == 404:
                    return MassiveOptionsResult(
                        data=pl.DataFrame(schema=UNUSUAL_TRADES_SCHEMA),
                        status="UNSUPPORTED_COVERAGE",
                        pages=pages,
                        rows_received=rows_received,
                        truncated=False,
                        note="HTTP 404 unsupported coverage",
                    )
                if not isinstance(resp.payload, dict):
                    break

                for r in resp.payload.get("results") or []:
                    rows_received += 1
                    und = str(r.get("underlying_ticker") or sym).upper()
                    root = str(r.get("root") or und).upper()
                    if und != sym and root != sym:
                        continue
                    sip_raw = r.get("sip_timestamp")
                    try:
                        sip_ns = int(sip_raw)
                    except (TypeError, ValueError):
                        continue
                    if sip_ns < 10**15:
                        continue
                    ts_s = sip_ns // 1_000_000_000
                    px = _safe_float(r.get("price"))
                    sz = _safe_float(r.get("size"))
                    spc_raw = r.get("shares_per_contract")
                    is_adj = _classify_option_root(root, sym)
                    if spc_raw is not None:
                        spc = _safe_float(spc_raw)
                    elif not is_adj:
                        spc = 100.0
                    else:
                        spc = math.nan
                    notional = (
                        px * sz * spc
                        if math.isfinite(px) and math.isfinite(sz) and math.isfinite(spc)
                        else math.nan
                    )
                    flags_list = r.get("flags") or []
                    flags_str = ",".join(str(x) for x in flags_list) if isinstance(flags_list, list) else str(flags_list)
                    ex_raw = r.get("exchange")
                    seq_raw = r.get("sequence_number")
                    rows.append(
                        {
                            "underlying_ticker": und,
                            "option_ticker": str(r.get("ticker") or ""),
                            "root": root,
                            "ts_utc_s": ts_s,
                            "sip_timestamp_ns": str(sip_ns),
                            "price": px,
                            "size": sz,
                            "shares_per_contract": spc,
                            "notional": notional,
                            "exchange": int(ex_raw) if isinstance(ex_raw, (int, float)) else -1,
                            "flags": flags_str,
                            "sequence_number": int(seq_raw) if isinstance(seq_raw, (int, float)) else -1,
                        }
                    )
                next_raw = resp.payload.get("next_url")
                if isinstance(next_raw, str) and next_raw.strip():
                    url = self._t.validate_next_url(next_raw, "MASSIVE_OPTIONS_REST", seen_urls)
                    params = None
                else:
                    url = None

        df = (
            pl.DataFrame(rows, schema=UNUSUAL_TRADES_SCHEMA)
            .unique(subset=["option_ticker", "sip_timestamp_ns", "sequence_number"])
            .sort(["ts_utc_s", "sequence_number"])
            if rows
            else pl.DataFrame(schema=UNUSUAL_TRADES_SCHEMA)
        )
        status = "PARTIAL" if truncated else ("COMPLETE" if df.height > 0 else "EMPTY_VERIFIED")
        return MassiveOptionsResult(
            data=df,
            status=status,
            pages=pages,
            rows_received=rows_received,
            truncated=truncated,
            note=trunc_note,
        )

    async def fetch_options_oi_underlying(
        self,
        ticker: str,
        start_date: dt.date | str,
        end_date: dt.date | str,
        *,
        max_pages: int = 20,
    ) -> MassiveOptionsResult:
        """Fetch daily aggregate OI from verified ``/options/v1/open-interest/underlying`` (>= 2022-09-01)."""
        s_date = dt.date.fromisoformat(start_date) if isinstance(start_date, str) else start_date
        e_date = dt.date.fromisoformat(end_date) if isinstance(end_date, str) else end_date
        sym = ticker.strip().upper()
        eff_start = max(s_date, OPRA_HISTORY_FLOOR)
        if eff_start > e_date:
            return MassiveOptionsResult(
                data=pl.DataFrame(schema=OI_DAILY_SCHEMA),
                status="EMPTY_VERIFIED",
                pages=0,
                rows_received=0,
                truncated=False,
                note=f"Window [{s_date}, {e_date}] strictly precedes OPRA OI floor {OPRA_HISTORY_FLOOR}",
            )

        by_date: dict[str, dict[str, Any]] = {}
        pages = 0
        rows_received = 0
        truncated = False
        url: str | None = "/options/v1/open-interest/underlying"
        params: dict[str, Any] | None = {
            "underlying_ticker": sym,
            "date.gte": eff_start.isoformat(),
            "date.lte": e_date.isoformat(),
            "limit": 50000,
        }
        seen_urls: set[str] = set()

        while url is not None:
            if pages >= max_pages:
                truncated = True
                break
            try:
                resp = await self._t.request_json("MASSIVE_OPTIONS_REST", url, params=params, allow_404=True)
            except ProviderAuthorizationError:
                return MassiveOptionsResult(
                    data=pl.DataFrame(schema=OI_DAILY_SCHEMA),
                    status="UNSUPPORTED_COVERAGE",
                    pages=pages,
                    rows_received=rows_received,
                    truncated=True,
                    note="Endpoint returned 401/403 authorization/entitlement limit",
                )
            pages += 1
            if resp.status_code == 404:
                return MassiveOptionsResult(
                    data=pl.DataFrame(schema=OI_DAILY_SCHEMA),
                    status="UNSUPPORTED_COVERAGE",
                    pages=pages,
                    rows_received=rows_received,
                    truncated=False,
                    note="HTTP 404 unsupported OI coverage",
                )
            if not isinstance(resp.payload, dict):
                break

            for r in resp.payload.get("results") or []:
                rows_received += 1
                row_sym = str(r.get("underlying_ticker") or sym).upper()
                if row_sym != sym:
                    continue
                tr_date = str(r.get("date") or "").strip()
                if not tr_date:
                    continue
                tot_oi = r.get("open_interest")
                c_oi = r.get("open_interest_calls")
                p_oi = r.get("open_interest_puts")
                if any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in (tot_oi, c_oi, p_oi)):
                    continue
                by_date[tr_date] = {
                    "ticker": sym,
                    "trade_date": tr_date,
                    "total_call_oi": int(c_oi),
                    "total_put_oi": int(p_oi),
                    "total_oi": int(tot_oi),
                }

            next_raw = resp.payload.get("next_url")
            if isinstance(next_raw, str) and next_raw.strip():
                url = self._t.validate_next_url(next_raw, "MASSIVE_OPTIONS_REST", seen_urls)
                params = None
            else:
                url = None

        rows_out = [by_date[d] for d in sorted(by_date.keys())]
        df = pl.DataFrame(rows_out, schema=OI_DAILY_SCHEMA) if rows_out else pl.DataFrame(schema=OI_DAILY_SCHEMA)
        status = "PARTIAL" if truncated else ("COMPLETE" if df.height > 0 else "EMPTY_VERIFIED")
        return MassiveOptionsResult(
            data=df,
            status=status,
            pages=pages,
            rows_received=rows_received,
            truncated=truncated,
        )

    async def fetch_options_unusual_event_gated(
        self,
        ticker: str,
        candidate_df: pl.DataFrame,
        *,
        event_gated: bool = True,
        max_pages_per_day: int = 15,
        max_total_pages: int = 600,
        existing_summary_df: pl.DataFrame | None = None,
    ) -> MassiveEventGatedUnusualResult:
        """Fetch event-gated 1-day OPRA unusual trade windows streaming incrementally with strict caps."""
        if not event_gated:
            raise ValueError("event_gated=False raw multi-year scan is disabled in Prompt #4; use fetch_options_unusual_trades explicitly.")

        sym = ticker.strip().upper()
        cands = (
            candidate_df.filter((pl.col("ticker") == sym) & (pl.col("trade_date") >= OPRA_HISTORY_FLOOR.isoformat()))
            .unique(subset=["ticker", "trade_date"])
            .sort("trade_date")
        )
        target_dates = cands["trade_date"].to_list() if cands.height > 0 else []

        existing_complete: dict[str, dict[str, Any]] = {}
        if existing_summary_df is not None and existing_summary_df.height > 0:
            for r in existing_summary_df.iter_rows(named=True):
                td = str(r.get("trade_date") or "").strip()[:10]
                if td and bool(r.get("is_complete_day")):
                    existing_complete[td] = dict(r)

        if not target_dates:
            empty_df = (
                existing_summary_df.sort("trade_date")
                if existing_summary_df is not None and existing_summary_df.height > 0
                else pl.DataFrame(schema=UNUSUAL_DAILY_SUMMARY_SCHEMA)
            )
            return MassiveEventGatedUnusualResult(
                data=empty_df,
                coverage_manifest={
                    "ticker": sym,
                    "candidate_dates": [],
                    "completed_dates": sorted(existing_complete.keys()),
                    "remaining_dates": [],
                    "partial_dates": [],
                    "errors": [],
                    "requests_made": 0,
                    "raw_rows_scanned": 0,
                },
                status="EMPTY_VERIFIED",
                coverage_scope="EVENT_GATED_COMPLETE",
                requests_made=0,
                raw_rows_scanned=0,
                note="No event-gated candidate dates >= 2022-09-01",
            )

        gte_occ, lt_occ = _build_occ_prefix_bounds(sym)
        rows_by_date: dict[str, dict[str, Any]] = dict(existing_complete)
        requests_made = 0
        raw_rows_scanned_total = 0
        partial_dates: list[str] = []
        errors: list[str] = []
        unsupported_note: str | None = None

        for cand in cands.iter_rows(named=True):
            td = str(cand["trade_date"])
            if td in existing_complete:
                continue
            if requests_made >= max_total_pages:
                partial_dates.append(td)
                continue

            d_obj = dt.date.fromisoformat(td)
            start_et = dt.datetime(d_obj.year, d_obj.month, d_obj.day, 0, 0, tzinfo=ET_TZ)
            next_d = d_obj + dt.timedelta(days=1)
            end_et = dt.datetime(next_d.year, next_d.month, next_d.day, 0, 0, tzinfo=ET_TZ)
            start_ns = int(start_et.timestamp()) * 1_000_000_000
            end_ns = int(end_et.timestamp()) * 1_000_000_000

            url: str | None = "/options/v1/unusual-trades"
            params: dict[str, Any] | None = {
                "ticker.gte": gte_occ,
                "ticker.lt": lt_occ,
                "sip_timestamp.gte": str(start_ns),
                "sip_timestamp.lt": str(end_ns),
                "sort": "sip_timestamp",
                "order": "asc",
                "limit": 50000,
            }
            seen_urls: set[str] = set()
            seen_trade_keys: set[tuple[str, int, int]] = set()
            filtered_items: list[tuple[str, int, float, float, float, bool, bool]] = []
            day_pages = 0
            day_scanned = 0
            day_complete = True
            auth_abort = False

            while url is not None:
                if day_pages >= max_pages_per_day or requests_made >= max_total_pages:
                    day_complete = False
                    break
                try:
                    resp = await self._t.request_json("MASSIVE_OPTIONS_REST", url, params=params, allow_404=True)
                except ProviderAuthorizationError:
                    day_complete = False
                    auth_abort = True
                    unsupported_note = "HTTP 401/403 authorization limit"
                    errors.append(f"{td}:AUTH_401_403")
                    break
                except Exception as exc:
                    day_complete = False
                    errors.append(f"{td}:{type(exc).__name__}")
                    break

                requests_made += 1
                day_pages += 1
                if resp.status_code == 404 or not isinstance(resp.payload, dict):
                    if resp.status_code == 404:
                        day_complete = False
                        unsupported_note = "HTTP 404 unsupported coverage"
                        errors.append(f"{td}:HTTP_404")
                    break

                for r in resp.payload.get("results") or []:
                    day_scanned += 1
                    raw_rows_scanned_total += 1
                    und = str(r.get("underlying_ticker") or sym).upper()
                    root = str(r.get("root") or und).upper()
                    if und != sym and root != sym:
                        continue
                    sip_raw = r.get("sip_timestamp")
                    try:
                        sip_ns = int(sip_raw)
                    except (TypeError, ValueError):
                        continue
                    if sip_ns < 10**15:
                        continue
                    opt_tkr = str(r.get("ticker") or "")
                    seq_raw = r.get("sequence_number")
                    seq_i = int(seq_raw) if isinstance(seq_raw, (int, float)) and not isinstance(seq_raw, bool) else -1
                    tkey = (opt_tkr, sip_ns, seq_i)
                    if tkey in seen_trade_keys:
                        continue
                    seen_trade_keys.add(tkey)

                    px = _safe_float(r.get("price"))
                    sz = _safe_float(r.get("size"))
                    spc_raw = r.get("shares_per_contract")
                    is_adj = _classify_option_root(root, sym)
                    if spc_raw is not None:
                        spc = _safe_float(spc_raw)
                    elif not is_adj:
                        spc = 100.0
                    else:
                        spc = math.nan
                    notional = (
                        px * sz * spc
                        if math.isfinite(px) and math.isfinite(sz) and math.isfinite(spc)
                        else math.nan
                    )
                    flags_raw = r.get("flags") or []
                    flags_set = (
                        {str(x).strip().lower() for x in flags_raw}
                        if isinstance(flags_raw, list)
                        else {x.strip().lower() for x in str(flags_raw).split(",") if x.strip()}
                    )
                    is_iso = "iso" in flags_set
                    is_unv_adj = is_adj and not math.isfinite(notional)
                    # Retain only institutional-sized prints or unverified adjusted roots to bound memory.
                    if is_unv_adj or (
                        (math.isfinite(notional) and notional >= 100_000.0)
                        or (math.isfinite(sz) and sz >= 1_000.0)
                        or (is_iso and math.isfinite(notional) and notional >= 25_000.0)
                    ):
                        filtered_items.append((opt_tkr, sip_ns // 1_000_000_000, px, sz, notional, is_iso, is_unv_adj))

                next_raw = resp.payload.get("next_url")
                if isinstance(next_raw, str) and next_raw.strip():
                    url = self._t.validate_next_url(next_raw, "MASSIVE_OPTIONS_REST", seen_urls)
                    params = None
                else:
                    url = None

            if filtered_items:
                summary_row = _aggregate_day_trades_streaming(
                    sym,
                    td,
                    cand,
                    filtered_items,
                    pages_fetched=day_pages,
                    raw_rows_scanned=day_scanned,
                    is_complete_day=day_complete,
                )
            else:
                summary_row = _make_empty_day_summary(
                    sym,
                    td,
                    cand,
                    pages_fetched=day_pages,
                    raw_rows_scanned=day_scanned,
                    is_complete_day=day_complete,
                )
            rows_by_date[td] = summary_row
            if not day_complete:
                partial_dates.append(td)
            if auth_abort:
                break

        all_dates = sorted(rows_by_date.keys())
        out_df = (
            pl.DataFrame([rows_by_date[d] for d in all_dates], schema=UNUSUAL_DAILY_SUMMARY_SCHEMA).sort("trade_date")
            if all_dates
            else pl.DataFrame(schema=UNUSUAL_DAILY_SUMMARY_SCHEMA)
        )
        completed_dates = sorted(
            td for td in target_dates if td in rows_by_date and bool(rows_by_date[td].get("is_complete_day"))
        )
        remaining_dates = sorted(set(target_dates) - set(completed_dates))
        if unsupported_note and len(completed_dates) == 0:
            st = "UNSUPPORTED_COVERAGE"
            scope = "EVENT_GATED_PARTIAL"
        elif remaining_dates:
            st = "PARTIAL"
            scope = "EVENT_GATED_PARTIAL"
        else:
            st = "COMPLETE"
            scope = "EVENT_GATED_COMPLETE"

        return MassiveEventGatedUnusualResult(
            data=out_df,
            coverage_manifest={
                "ticker": sym,
                "candidate_dates": target_dates,
                "completed_dates": completed_dates,
                "remaining_dates": remaining_dates,
                "partial_dates": sorted(set(partial_dates)),
                "errors": errors,
                "requests_made": requests_made,
                "raw_rows_scanned": raw_rows_scanned_total,
                "coverage_scope": scope,
            },
            status=st,
            coverage_scope=scope,
            requests_made=requests_made,
            raw_rows_scanned=raw_rows_scanned_total,
            note=unsupported_note or (f"PARTIAL:{len(remaining_dates)}_dates_remaining" if remaining_dates else None),
        )
