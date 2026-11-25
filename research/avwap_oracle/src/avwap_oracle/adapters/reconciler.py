"""Causal point-in-time reconcilers for earnings timing and corporate actions.

Strict causality invariant:
    Retrospective knowledge of whether an earnings print happened BMO or AMC does
    NOT make that timing known prior to the evidence used to infer it. Whenever
    ETH bars or post-close quotes are used to infer BMO/AMC, ``available_at_utc_s``
    MUST be at or after the end of the evidence window used.
"""

from __future__ import annotations

import datetime as dt
import math
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

import polars as pl

from avwap_oracle.adapters.orats_rest import classify_orats_annc_tod
from avwap_oracle.math_core.nyse_calendar import ET_TZ, get_session_bounds

OPRA_OI_FLOOR_DATE = "2022-09-01"

RECONCILED_DAILY_OI_SCHEMA: dict[str, pl.DataType] = {
    "ticker": pl.String,
    "trade_date": pl.String,
    "orats_total_oi_raw": pl.Int64,
    "massive_total_oi_raw": pl.Int64,
    "effective_total_oi": pl.Int64,
    "oi_source": pl.String,
    "oi_asof_date": pl.String,
    "oi_reconciliation_reason": pl.String,
}

RECONCILED_EARNINGS_SCHEMA: dict[str, pl.DataType] = {
    "ticker": pl.String,
    "earn_date_fmp": pl.String,
    "earn_date_orats": pl.String,
    "earn_date_canonical": pl.String,
    "date_aligned_delta": pl.Int64,
    "annc_tod_raw": pl.String,
    "earnings_timing": pl.String,
    "timing_source": pl.String,
    "timing_confidence": pl.Float64,
    "available_at_utc_s": pl.Int64,
    "availability_quality": pl.String,
    "anchor_ts_rth_utc_s": pl.Int64,
    "eth_shadow_ts_utc_s": pl.Int64,
    "inference_detail": pl.String,
}

RECONCILED_SPLITS_SCHEMA: dict[str, pl.DataType] = {
    "ticker": pl.String,
    "effective_date": pl.String,
    "status": pl.String,
    "safe_to_apply": pl.Boolean,
    "split_from_massive": pl.Float64,
    "split_to_massive": pl.Float64,
    "k_massive": pl.Float64,
    "split_from_fmp": pl.Float64,
    "split_to_fmp": pl.Float64,
    "k_fmp": pl.Float64,
    "k_canonical": pl.Float64,
    "split_from_canonical": pl.Float64,
    "split_to_canonical": pl.Float64,
    "historical_adjustment_factor": pl.Float64,
    "conflict_reason": pl.String,
}

RECONCILED_DIVIDENDS_SCHEMA: dict[str, pl.DataType] = {
    "ticker": pl.String,
    "ex_dividend_date": pl.String,
    "status": pl.String,
    "safe_to_apply": pl.Boolean,
    "cash_amount_massive": pl.Float64,
    "cash_amount_fmp": pl.Float64,
    "cash_amount_canonical": pl.Float64,
    "currency": pl.String,
    "distribution_type_massive": pl.String,
    "frequency_fmp": pl.String,
    "is_special_provider": pl.Boolean,
    "historical_adjustment_factor": pl.Float64,
    "conflict_reason": pl.String,
}

ETH_JUMP_THRESHOLD = 0.02  # >= 2.0% move vs reference RTH close
ETH_MIN_VOLUME = 10_000.0
ETH_MIN_RTH_VOL_RATIO = 0.005
ETH_DOMINANCE_RATIO = 2.0


@dataclass(frozen=True)
class CorporateActionsReconciliation:
    splits: pl.DataFrame
    dividends: pl.DataFrame
    split_conflict_count: int
    dividend_conflict_count: int


def _next_or_same_trading_day(d: dt.date) -> dt.date:
    cur = d
    while get_session_bounds(cur) is None:
        cur += dt.timedelta(days=1)
    return cur


def _next_strict_trading_day(d: dt.date) -> dt.date:
    cur = d + dt.timedelta(days=1)
    while get_session_bounds(cur) is None:
        cur += dt.timedelta(days=1)
    return cur


def _prev_strict_trading_day(d: dt.date) -> dt.date:
    cur = d - dt.timedelta(days=1)
    while get_session_bounds(cur) is None:
        cur -= dt.timedelta(days=1)
    return cur


def _hhmm_to_utc_s(date_str: str, hhmm: str) -> int | None:
    if not hhmm or len(hhmm) != 4 or not hhmm.isdigit():
        return None
    try:
        d = dt.date.fromisoformat(date_str)
        hh, mm = int(hhmm[:2]), int(hhmm[2:])
        local_dt = dt.datetime(d.year, d.month, d.day, hh, mm, tzinfo=ET_TZ)
        return int(local_dt.timestamp())
    except Exception:
        return None


def _match_earnings_dates_1to1(
    fmp_rows: list[dict[str, Any]],
    orats_rows: list[dict[str, Any]],
) -> list[tuple[dict[str, Any] | None, dict[str, Any] | None, int]]:
    """Strict 1-to-1 exact then unambiguous ±1 calendar-day matching per ticker."""
    fmp_by_ticker: dict[str, dict[str, dict[str, Any]]] = {}
    orats_by_ticker: dict[str, dict[str, dict[str, Any]]] = {}
    for r in fmp_rows:
        t = str(r.get("ticker") or "").upper()
        d = str(r.get("earn_date") or "")[:10]
        if t and d:
            fmp_by_ticker.setdefault(t, {})[d] = r
    for r in orats_rows:
        t = str(r.get("ticker") or "").upper()
        d = str(r.get("earn_date") or "")[:10]
        if t and d:
            orats_by_ticker.setdefault(t, {})[d] = r

    matched_pairs: list[tuple[dict[str, Any] | None, dict[str, Any] | None, int]] = []
    all_tickers = sorted(set(fmp_by_ticker.keys()) | set(orats_by_ticker.keys()))

    for sym in all_tickers:
        fmap = dict(fmp_by_ticker.get(sym, {}))
        omap = dict(orats_by_ticker.get(sym, {}))

        # 1. Exact matches
        exact_dates = sorted(set(fmap.keys()) & set(omap.keys()))
        for d in exact_dates:
            matched_pairs.append((fmap.pop(d), omap.pop(d), 0))

        # 2. Unambiguous ±1 day matches (mutual unique neighbor)
        unmatched_f = sorted(fmap.keys())
        unmatched_o = sorted(omap.keys())
        f_cands: dict[str, list[str]] = {}
        o_cands: dict[str, list[str]] = {}
        for fd in unmatched_f:
            fd_dt = dt.date.fromisoformat(fd)
            cands = []
            for od in unmatched_o:
                delta = abs((dt.date.fromisoformat(od) - fd_dt).days)
                if delta == 1:
                    cands.append(od)
                    o_cands.setdefault(od, []).append(fd)
            f_cands[fd] = cands

        for fd in unmatched_f:
            cands = f_cands.get(fd, [])
            if len(cands) == 1:
                od = cands[0]
                if len(o_cands.get(od, [])) == 1 and fd in fmap and od in omap:
                    delta_days = (dt.date.fromisoformat(od) - dt.date.fromisoformat(fd)).days
                    matched_pairs.append((fmap.pop(fd), omap.pop(od), delta_days))

        for fd in sorted(fmap.keys()):
            matched_pairs.append((fmap[fd], None, 0))
        for od in sorted(omap.keys()):
            matched_pairs.append((None, omap[od], 0))

    return matched_pairs


def _pre_index_bars_by_ticker(bars_1m_raw: pl.DataFrame) -> dict[str, dict[str, Any]]:
    if bars_1m_raw.height == 0:
        return {}
    out: dict[str, dict[str, Any]] = {}
    for sym, sub in bars_1m_raw.sort(["ticker", "ts_utc_s"]).group_by("ticker", maintain_order=True):
        t_str = str(sym[0] if isinstance(sym, tuple) else sym).upper()
        ts_arr = sub["ts_utc_s"].to_list()
        c_arr = sub["c"].to_list()
        v_col = "v" if "v" in sub.columns else "volume"
        v_arr = sub[v_col].to_list()
        out[t_str] = {"ts": ts_arr, "c": c_arr, "v": v_arr}
    return out


def _evaluate_eth_inference(
    sym: str,
    earn_date_str: str,
    bars_idx: dict[str, Any] | None,
    open_close_data: dict[str, Any] | None,
) -> tuple[str, str, float, int | None, int | None, int | None, str]:
    """Infer BMO/AMC strictly causally from ETH 1m bars or open-close summary."""
    try:
        earn_dt = dt.date.fromisoformat(earn_date_str)
        sb = get_session_bounds(earn_dt)
        if sb is None:
            return "UNKNOWN", "UNKNOWN", 0.0, None, None, None, "NON_TRADING_DATE"
        prev_dt = _prev_strict_trading_day(earn_dt)
        sb_prev = get_session_bounds(prev_dt)
        next_dt = _next_strict_trading_day(earn_dt)
        sb_next = get_session_bounds(next_dt)
    except Exception as exc:
        return "UNKNOWN", "UNKNOWN", 0.0, None, None, None, f"CALENDAR_ERR:{type(exc).__name__}"

    pm_jump = 0.0
    pm_vol = 0.0
    pm_first_cross_ts: int | None = None
    ah_jump = 0.0
    ah_vol = 0.0
    ah_first_cross_ts: int | None = None
    prev_rth_close = math.nan
    prev_rth_vol = 0.0
    curr_rth_close = math.nan
    curr_rth_vol = 0.0
    used_open_close_only = False

    if bars_idx is not None and sb_prev is not None:
        ts_list: list[int] = bars_idx["ts"]
        c_list: list[float] = bars_idx["c"]
        v_list: list[float] = bars_idx["v"]
        for ts, px, vol in zip(ts_list, c_list, v_list, strict=True):
            if not (math.isfinite(px) and px > 0.0 and math.isfinite(vol) and vol >= 0.0):
                continue
            if sb_prev.rth_open_utc_s <= ts < sb_prev.rth_close_utc_s:
                prev_rth_close = px
                prev_rth_vol += vol
            elif sb.rth_open_utc_s <= ts < sb.rth_close_utc_s:
                curr_rth_close = px
                curr_rth_vol += vol

        for ts, px, vol in zip(ts_list, c_list, v_list, strict=True):
            if not (math.isfinite(px) and px > 0.0 and math.isfinite(vol) and vol >= 0.0):
                continue
            if sb.ext_open_utc_s <= ts < sb.rth_open_utc_s and math.isfinite(prev_rth_close) and prev_rth_close > 0.0:
                pm_vol += vol
                mv = abs(px - prev_rth_close) / prev_rth_close
                if mv > pm_jump:
                    pm_jump = mv
                if mv >= ETH_JUMP_THRESHOLD and pm_first_cross_ts is None:
                    pm_first_cross_ts = int(ts)
            elif sb.rth_close_utc_s <= ts < sb.ext_close_utc_s and math.isfinite(curr_rth_close) and curr_rth_close > 0.0:
                ah_vol += vol
                mv = abs(px - curr_rth_close) / curr_rth_close
                if mv > ah_jump:
                    ah_jump = mv
                if mv >= ETH_JUMP_THRESHOLD and ah_first_cross_ts is None:
                    ah_first_cross_ts = int(ts)

    if (
        (pm_first_cross_ts is None and ah_first_cross_ts is None)
        and open_close_data is not None
        and math.isfinite(prev_rth_close if math.isfinite(prev_rth_close) else float(open_close_data.get("close", math.nan)))
    ):
        used_open_close_only = True
        oc_pre = float(open_close_data.get("pre_market", math.nan))
        oc_ah = float(open_close_data.get("after_hours", math.nan))
        oc_close = float(open_close_data.get("close", math.nan))
        ref_prev = prev_rth_close if math.isfinite(prev_rth_close) else oc_close
        ref_curr = curr_rth_close if math.isfinite(curr_rth_close) else oc_close
        if math.isfinite(oc_pre) and math.isfinite(ref_prev) and ref_prev > 0.0:
            pm_jump = max(pm_jump, abs(oc_pre - ref_prev) / ref_prev)
        if math.isfinite(oc_ah) and math.isfinite(ref_curr) and ref_curr > 0.0:
            ah_jump = max(ah_jump, abs(oc_ah - ref_curr) / ref_curr)

    pm_vol_ok = used_open_close_only or pm_vol >= max(ETH_MIN_VOLUME, ETH_MIN_RTH_VOL_RATIO * prev_rth_vol)
    ah_vol_ok = used_open_close_only or ah_vol >= max(ETH_MIN_VOLUME, ETH_MIN_RTH_VOL_RATIO * curr_rth_vol)

    bmo_cand = pm_jump >= ETH_JUMP_THRESHOLD and pm_vol_ok and (ah_jump < ETH_JUMP_THRESHOLD or pm_jump >= ETH_DOMINANCE_RATIO * ah_jump)
    amc_cand = ah_jump >= ETH_JUMP_THRESHOLD and ah_vol_ok and (pm_jump < ETH_JUMP_THRESHOLD or ah_jump >= ETH_DOMINANCE_RATIO * pm_jump)

    if bmo_cand and not amc_cand:
        conf = min(0.95, 0.55 + pm_jump * 4.0)
        # Strict causality: available only AFTER evaluating [04:00, 09:30) ET -> rth_open_utc_s
        avail = sb.rth_open_utc_s
        anchor = sb.rth_open_utc_s
        detail = f"PM_JUMP={pm_jump:.4f},PM_VOL={pm_vol:.0f},AH_JUMP={ah_jump:.4f},OC_FB={used_open_close_only}"
        return "BMO", "MASSIVE_ETH_INFERRED", conf, avail, anchor, pm_first_cross_ts, detail

    if amc_cand and not bmo_cand and sb_next is not None:
        conf = min(0.95, 0.55 + ah_jump * 4.0)
        # Strict causality: available AFTER [16:00, 20:00 / 17:00) window evaluated -> ext_close_utc_s
        avail = sb.ext_close_utc_s
        anchor = sb_next.rth_open_utc_s
        detail = f"AH_JUMP={ah_jump:.4f},AH_VOL={ah_vol:.0f},PM_JUMP={pm_jump:.4f},OC_FB={used_open_close_only}"
        return "AMC", "MASSIVE_ETH_INFERRED", conf, avail, anchor, ah_first_cross_ts, detail

    return (
        "UNKNOWN",
        "UNKNOWN",
        0.0,
        None,
        None,
        None,
        f"AMBIGUOUS_OR_WEAK:PM={pm_jump:.4f}(vol={pm_vol:.0f}),AH={ah_jump:.4f}(vol={ah_vol:.0f})",
    )


def _resolve_orats_anchor(
    timing: str,
    earn_date_str: str,
    annc_hhmm: str,
    bars_idx: dict[str, Any] | None,
) -> tuple[int | None, int | None, int | None, str]:
    earn_dt = dt.date.fromisoformat(earn_date_str)
    sb = get_session_bounds(earn_dt)
    annc_ts = _hhmm_to_utc_s(earn_date_str, annc_hhmm)

    if timing == "BMO":
        tr_dt = _next_or_same_trading_day(earn_dt)
        sb_anchor = get_session_bounds(tr_dt)
        anchor = sb_anchor.rth_open_utc_s if sb_anchor else None
        shadow = annc_ts if (sb is not None and annc_ts is not None and sb.ext_open_utc_s <= annc_ts < sb.rth_open_utc_s) else None
        avail = annc_ts if annc_ts is not None else (sb_anchor.rth_open_utc_s if sb_anchor else None)
        return avail, anchor, shadow, "OBSERVED_ORATS_TOD_RETROSPECTIVE"

    if timing == "AMC":
        tr_dt = _next_strict_trading_day(earn_dt)
        sb_anchor = get_session_bounds(tr_dt)
        anchor = sb_anchor.rth_open_utc_s if sb_anchor else None
        shadow = annc_ts if (sb is not None and annc_ts is not None and sb.rth_close_utc_s <= annc_ts < sb.ext_close_utc_s) else None
        avail = annc_ts if annc_ts is not None else (sb.rth_close_utc_s if sb else None)
        return avail, anchor, shadow, "OBSERVED_ORATS_TOD_RETROSPECTIVE"

    if timing == "DURING":
        if sb is None or annc_ts is None:
            return None, None, None, "OBSERVED_ORATS_TOD_RETROSPECTIVE"
        # Next intraday 1m RTH bar opening at or after rounded-up announcement minute
        ceil_ts = ((annc_ts + 59) // 60) * 60
        anchor_ts: int | None = None
        if bars_idx is not None:
            for ts in bars_idx["ts"]:
                if ts >= ceil_ts and sb.rth_open_utc_s <= ts < sb.rth_close_utc_s:
                    anchor_ts = int(ts)
                    break
        if anchor_ts is None:
            if ceil_ts < sb.rth_close_utc_s:
                anchor_ts = max(sb.rth_open_utc_s, ceil_ts)
            else:
                sb_next = get_session_bounds(_next_strict_trading_day(earn_dt))
                anchor_ts = sb_next.rth_open_utc_s if sb_next else None
        return anchor_ts, anchor_ts, None, "OBSERVED_ORATS_TOD_RETROSPECTIVE"

    return None, None, None, "UNKNOWN"


def reconcile_earnings_calendar(
    fmp_earnings: pl.DataFrame,
    orats_earnings: pl.DataFrame,
    bars_1m_raw: pl.DataFrame,
    open_close_fetcher: Callable[[str, str], dict[str, Any] | None] | None = None,
) -> pl.DataFrame:
    """Reconcile FMP & ORATS earnings timestamps with strict ETH/anchor causality."""
    fmp_rows = fmp_earnings.to_dicts() if fmp_earnings.height > 0 else []
    orats_rows = orats_earnings.to_dicts() if orats_earnings.height > 0 else []
    bars_by_ticker = _pre_index_bars_by_ticker(bars_1m_raw)
    pairs = _match_earnings_dates_1to1(fmp_rows, orats_rows)

    out_rows: list[dict[str, Any]] = []
    for f_row, o_row, delta_days in pairs:
        sym = str((o_row or f_row or {}).get("ticker") or "").upper()
        f_date = str(f_row.get("earn_date") or "")[:10] if f_row else ""
        o_date = str(o_row.get("earn_date") or "")[:10] if o_row else ""
        canon_date = o_date if o_date else f_date
        if not canon_date:
            continue

        raw_tod = str(o_row.get("annc_tod_raw") or "") if o_row else ""
        hhmm = str(o_row.get("annc_hhmm") or "") if o_row else ""
        o_timing = str(o_row.get("earnings_timing") or "UNKNOWN") if o_row else "UNKNOWN"
        if raw_tod and o_timing == "UNKNOWN":
            raw_tod, hhmm, o_timing = classify_orats_annc_tod(raw_tod, canon_date)

        bars_idx = bars_by_ticker.get(sym)
        if o_row is not None and o_timing in ("BMO", "AMC", "DURING"):
            avail, anchor, shadow, qual = _resolve_orats_anchor(o_timing, canon_date, hhmm, bars_idx)
            timing_source = "ORATS_HIST_EARNINGS"
            conf = 0.99
            detail = f"anncTod={raw_tod},hhmm={hhmm}"
            final_timing = o_timing
        else:
            oc_data = open_close_fetcher(sym, canon_date) if open_close_fetcher is not None else None
            (
                final_timing,
                timing_source,
                conf,
                avail,
                anchor,
                shadow,
                detail,
            ) = _evaluate_eth_inference(sym, canon_date, bars_idx, oc_data)
            qual = "INFERRED_ETH_CAUSAL" if timing_source == "MASSIVE_ETH_INFERRED" else "UNKNOWN"

        out_rows.append(
            {
                "ticker": sym,
                "earn_date_fmp": f_date,
                "earn_date_orats": o_date,
                "earn_date_canonical": canon_date,
                "date_aligned_delta": int(delta_days),
                "annc_tod_raw": raw_tod,
                "earnings_timing": final_timing,
                "timing_source": timing_source,
                "timing_confidence": float(conf),
                "available_at_utc_s": avail,
                "availability_quality": qual,
                "anchor_ts_rth_utc_s": anchor,
                "eth_shadow_ts_utc_s": shadow,
                "inference_detail": detail,
            }
        )

    if not out_rows:
        return pl.DataFrame(schema=RECONCILED_EARNINGS_SCHEMA)
    return pl.DataFrame(out_rows, schema=RECONCILED_EARNINGS_SCHEMA).sort(["ticker", "earn_date_canonical"])


async def reconcile_earnings_calendar_async(
    fmp_earnings: pl.DataFrame,
    orats_earnings: pl.DataFrame,
    bars_1m_raw: pl.DataFrame,
    open_close_fetcher: Callable[[str, str], Awaitable[dict[str, Any] | None]] | None = None,
) -> pl.DataFrame:
    """Async helper pre-fetching open-close summaries only for non-ORATS-timed dates."""
    fmp_rows = fmp_earnings.to_dicts() if fmp_earnings.height > 0 else []
    orats_rows = orats_earnings.to_dicts() if orats_earnings.height > 0 else []
    pairs = _match_earnings_dates_1to1(fmp_rows, orats_rows)
    oc_cache: dict[tuple[str, str], dict[str, Any] | None] = {}

    if open_close_fetcher is not None:
        bars_idx = _pre_index_bars_by_ticker(bars_1m_raw)
        for f_row, o_row, _ in pairs:
            sym = str((o_row or f_row or {}).get("ticker") or "").upper()
            canon_date = str((o_row or {}).get("earn_date") or (f_row or {}).get("earn_date") or "")[:10]
            o_timing = str(o_row.get("earnings_timing") or "UNKNOWN") if o_row else "UNKNOWN"
            if sym and canon_date and o_timing == "UNKNOWN" and sym not in bars_idx:
                oc_cache[(sym, canon_date)] = await open_close_fetcher(sym, canon_date)

    return reconcile_earnings_calendar(
        fmp_earnings,
        orats_earnings,
        bars_1m_raw,
        open_close_fetcher=(lambda s, d: oc_cache.get((s, d))) if oc_cache else None,
    )


def reconcile_corporate_actions(
    massive_splits: pl.DataFrame,
    fmp_splits: pl.DataFrame,
    massive_divs: pl.DataFrame,
    fmp_divs: pl.DataFrame,
) -> CorporateActionsReconciliation:
    """Cross-validate splits and dividends between Massive and FMP without averaging conflicts."""
    # --- Splits ---
    m_sp_map: dict[tuple[str, str], dict[str, Any]] = {}
    for r in (massive_splits.to_dicts() if massive_splits.height > 0 else []):
        key = (str(r["ticker"]).upper(), str(r["execution_date"])[:10])
        m_sp_map[key] = r
    f_sp_map: dict[tuple[str, str], dict[str, Any]] = {}
    for r in (fmp_splits.to_dicts() if fmp_splits.height > 0 else []):
        key = (str(r["ticker"]).upper(), str(r["execution_date"])[:10])
        f_sp_map[key] = r

    split_rows: list[dict[str, Any]] = []
    split_conflicts = 0
    for key in sorted(set(m_sp_map.keys()) | set(f_sp_map.keys())):
        sym, ex_dt = key
        mr = m_sp_map.get(key)
        fr = f_sp_map.get(key)

        sf_m = float(mr["split_from"]) if mr else math.nan
        st_m = float(mr["split_to"]) if mr else math.nan
        k_m = (sf_m / st_m) if (math.isfinite(sf_m) and sf_m > 0.0 and math.isfinite(st_m) and st_m > 0.0) else math.nan
        haf_m = float(mr["historical_adjustment_factor"]) if mr and mr.get("historical_adjustment_factor") is not None else math.nan

        sf_f = float(fr["split_from"]) if fr else math.nan
        st_f = float(fr["split_to"]) if fr else math.nan
        k_f = (sf_f / st_f) if (math.isfinite(sf_f) and sf_f > 0.0 and math.isfinite(st_f) and st_f > 0.0) else math.nan

        conflict_reason = "OK"
        if mr is not None and fr is not None:
            if not (math.isfinite(k_m) and math.isfinite(k_f)):
                status = "UNVERIFIED"
                safe = False
                k_canon, sf_canon, st_canon = math.nan, math.nan, math.nan
                conflict_reason = "INVALID_SPLIT_RATIO"
            elif math.isclose(k_m, k_f, rel_tol=1e-4, abs_tol=1e-8):
                status = "MATCHED"
                safe = True
                k_canon, sf_canon, st_canon = k_m, sf_m, st_m
            else:
                status = "CONFLICT"
                safe = False
                split_conflicts += 1
                k_canon, sf_canon, st_canon = math.nan, math.nan, math.nan
                conflict_reason = f"RATIO_MISMATCH:massive={k_m:.8f}_vs_fmp={k_f:.8f}"
        elif mr is not None:
            status = "MASSIVE_ONLY" if math.isfinite(k_m) else "UNVERIFIED"
            safe = status == "MASSIVE_ONLY"
            k_canon, sf_canon, st_canon = (k_m, sf_m, st_m) if safe else (math.nan, math.nan, math.nan)
            if not safe:
                conflict_reason = "INVALID_MASSIVE_SPLIT_RATIO"
        else:
            status = "FMP_ONLY" if math.isfinite(k_f) else "UNVERIFIED"
            safe = status == "FMP_ONLY"
            k_canon, sf_canon, st_canon = (k_f, sf_f, st_f) if safe else (math.nan, math.nan, math.nan)
            if not safe:
                conflict_reason = "INVALID_FMP_SPLIT_RATIO"

        split_rows.append(
            {
                "ticker": sym,
                "effective_date": ex_dt,
                "status": status,
                "safe_to_apply": safe,
                "split_from_massive": sf_m,
                "split_to_massive": st_m,
                "k_massive": k_m,
                "split_from_fmp": sf_f,
                "split_to_fmp": st_f,
                "k_fmp": k_f,
                "k_canonical": k_canon,
                "split_from_canonical": sf_canon,
                "split_to_canonical": st_canon,
                "historical_adjustment_factor": haf_m,
                "conflict_reason": conflict_reason,
            }
        )

    # --- Dividends ---
    m_dv_map: dict[tuple[str, str], dict[str, Any]] = {}
    for r in (massive_divs.to_dicts() if massive_divs.height > 0 else []):
        key = (str(r["ticker"]).upper(), str(r["ex_dividend_date"])[:10])
        m_dv_map[key] = r
    f_dv_map: dict[tuple[str, str], dict[str, Any]] = {}
    for r in (fmp_divs.to_dicts() if fmp_divs.height > 0 else []):
        key = (str(r["ticker"]).upper(), str(r["ex_dividend_date"])[:10])
        f_dv_map[key] = r

    div_rows: list[dict[str, Any]] = []
    div_conflicts = 0
    for key in sorted(set(m_dv_map.keys()) | set(f_dv_map.keys())):
        sym, ex_dt = key
        mr = m_dv_map.get(key)
        fr = f_dv_map.get(key)

        amt_m = float(mr["cash_amount"]) if mr else math.nan
        amt_f = float(fr["cash_amount"]) if fr else math.nan
        dist_m = str(mr.get("distribution_type") or "") if mr else ""
        freq_f = str(fr.get("frequency") or "") if fr else ""
        ccy = str(mr.get("currency") or "USD") if mr else "USD"
        haf_m = float(mr["historical_adjustment_factor"]) if mr and mr.get("historical_adjustment_factor") is not None else math.nan

        is_spec_m = dist_m.lower() == "special"
        is_spec_f = bool(fr.get("is_special_dividend")) if fr else False

        conflict_reason = "OK"
        if mr is not None and fr is not None:
            if not (math.isfinite(amt_m) and math.isfinite(amt_f) and amt_m >= 0.0 and amt_f >= 0.0):
                status = "UNVERIFIED"
                safe = False
                amt_canon = math.nan
                is_spec = False
                conflict_reason = "INVALID_CASH_AMOUNT"
            elif ccy != "USD":
                status = "UNVERIFIED"
                safe = False
                amt_canon = math.nan
                is_spec = is_spec_m or is_spec_f
                conflict_reason = f"NON_USD_CURRENCY:{ccy}"
            elif not math.isclose(amt_m, amt_f, rel_tol=1e-3, abs_tol=1e-4):
                status = "CONFLICT"
                safe = False
                div_conflicts += 1
                amt_canon = math.nan
                is_spec = False
                conflict_reason = f"AMOUNT_MISMATCH:massive={amt_m:.6f}_vs_fmp={amt_f:.6f}"
            elif dist_m.lower() in ("recurring", "special") and (is_spec_m != is_spec_f):
                status = "CONFLICT"
                safe = False
                div_conflicts += 1
                amt_canon = math.nan
                is_spec = False
                conflict_reason = f"CLASS_MISMATCH:massive={dist_m}_vs_fmp={freq_f}"
            else:
                status = "MATCHED"
                safe = True
                amt_canon = amt_m
                is_spec = is_spec_m or is_spec_f
        elif mr is not None:
            valid = math.isfinite(amt_m) and amt_m >= 0.0 and ccy == "USD"
            status = "MASSIVE_ONLY" if valid else "UNVERIFIED"
            safe = valid
            amt_canon = amt_m if valid else math.nan
            is_spec = is_spec_m
            if not valid:
                conflict_reason = "INVALID_MASSIVE_DIVIDEND"
        else:
            valid = math.isfinite(amt_f) and amt_f >= 0.0
            status = "FMP_ONLY" if valid else "UNVERIFIED"
            safe = valid
            amt_canon = amt_f if valid else math.nan
            is_spec = is_spec_f
            if not valid:
                conflict_reason = "INVALID_FMP_DIVIDEND"

        div_rows.append(
            {
                "ticker": sym,
                "ex_dividend_date": ex_dt,
                "status": status,
                "safe_to_apply": safe,
                "cash_amount_massive": amt_m,
                "cash_amount_fmp": amt_f,
                "cash_amount_canonical": amt_canon,
                "currency": ccy,
                "distribution_type_massive": dist_m,
                "frequency_fmp": freq_f,
                "is_special_provider": bool(is_spec),
                "historical_adjustment_factor": haf_m,
                "conflict_reason": conflict_reason,
            }
        )

    sp_df = pl.DataFrame(split_rows, schema=RECONCILED_SPLITS_SCHEMA).sort(["ticker", "effective_date"]) if split_rows else pl.DataFrame(schema=RECONCILED_SPLITS_SCHEMA)
    dv_df = pl.DataFrame(div_rows, schema=RECONCILED_DIVIDENDS_SCHEMA).sort(["ticker", "ex_dividend_date"]) if div_rows else pl.DataFrame(schema=RECONCILED_DIVIDENDS_SCHEMA)
    return CorporateActionsReconciliation(
        splits=sp_df,
        dividends=dv_df,
        split_conflict_count=split_conflicts,
        dividend_conflict_count=div_conflicts,
    )


def reconcile_daily_oi(
    orats_cores_df: pl.DataFrame,
    massive_oi_df: pl.DataFrame,
) -> pl.DataFrame:
    """Reconcile daily aggregate option OI between ORATS cores and Massive underlying OI.

    Contracts:
    - Never overwrites raw ORATS fields; exposes ``orats_total_oi_raw`` and
      ``massive_total_oi_raw`` alongside ``effective_total_oi``.
    - Uses ``oi_source = "MASSIVE_FALLBACK"`` ONLY when ``orats_total_oi == 0``,
      ``massive_total_oi > 0``, ``trade_date >= 2022-09-01``, and the date is a valid
      NYSE trading session (compatible reference coverage).
    - Preserves ``orats_total_oi_raw`` when both providers report positive OI, while
      recording small universe differences (<= 1%) vs material divergence (> 1%).
    - Does NOT fabricate strike-level GEX or allocate OI across strikes.
    """
    orats_map: dict[tuple[str, str], int] = {}
    if orats_cores_df.height > 0:
        for r in orats_cores_df.select(["ticker", "trade_date", "total_oi"]).to_dicts():
            sym = str(r.get("ticker") or "").strip().upper()
            td = str(r.get("trade_date") or "").strip()[:10]
            raw_oi = r.get("total_oi")
            if sym and td and raw_oi is not None and not isinstance(raw_oi, bool):
                orats_map[(sym, td)] = int(raw_oi)

    massive_map: dict[tuple[str, str], int] = {}
    if massive_oi_df.height > 0:
        for r in massive_oi_df.select(["ticker", "trade_date", "total_oi"]).to_dicts():
            sym = str(r.get("ticker") or "").strip().upper()
            td = str(r.get("trade_date") or "").strip()[:10]
            raw_oi = r.get("total_oi")
            if sym and td and raw_oi is not None and not isinstance(raw_oi, bool):
                massive_map[(sym, td)] = int(raw_oi)

    all_keys = sorted(set(orats_map.keys()) | set(massive_map.keys()))
    if not all_keys:
        return pl.DataFrame(schema=RECONCILED_DAILY_OI_SCHEMA)

    rows: list[dict[str, Any]] = []
    for sym, td in all_keys:
        o_val = orats_map.get((sym, td), -1)
        m_val = massive_map.get((sym, td), -1)
        valid_session = False
        try:
            valid_session = get_session_bounds(td) is not None
        except Exception:
            valid_session = False

        if o_val > 0 and m_val > 0:
            eff = o_val
            src = "ORATS_PRIMARY"
            rel_diff = abs(m_val - o_val) / float(o_val)
            if m_val == o_val:
                reason = "EXACT_MATCH"
            elif rel_diff <= 0.01:
                reason = f"MINOR_UNIVERSE_DIFF_PCT={rel_diff * 100.0:.4f}"
            else:
                reason = f"PROVIDER_DIVERGENCE_ORATS_RETAINED_PCT={rel_diff * 100.0:.4f}"
        elif o_val == 0 and m_val > 0:
            if valid_session and td >= OPRA_OI_FLOOR_DATE:
                eff = m_val
                src = "MASSIVE_FALLBACK"
                reason = "ORATS_ZERO_ANOMALY_MASSIVE_POSITIVE_VERIFIED"
            else:
                eff = 0
                src = "ORATS_PRIMARY"
                reason = "FALLBACK_REJECTED_INCOMPATIBLE_SESSION_OR_PRE_OPRA"
        elif o_val > 0:
            eff = o_val
            src = "ORATS_ONLY"
            reason = "PRE_OPRA_FLOOR" if td < OPRA_OI_FLOOR_DATE else "MASSIVE_OI_MISSING"
        elif m_val > 0:
            eff = m_val
            src = "MASSIVE_ONLY"
            reason = "ORATS_CORES_MISSING_POST_CUTOFF_OR_GAP"
        elif o_val == 0 and m_val == 0:
            eff = 0
            src = "BOTH_ZERO"
            reason = "LEGITIMATE_ZERO_BOTH_PROVIDERS"
        elif o_val == 0:
            eff = 0
            src = "ORATS_ZERO_UNCONFIRMED"
            reason = "ORATS_ZERO_NO_POSITIVE_MASSIVE"
        elif m_val == 0:
            eff = 0
            src = "MASSIVE_ZERO_ONLY"
            reason = "MASSIVE_ZERO_ORATS_MISSING"
        else:
            eff = -1
            src = "UNAVAILABLE"
            reason = "MISSING_VALID_OI"

        rows.append(
            {
                "ticker": sym,
                "trade_date": td,
                "orats_total_oi_raw": o_val,
                "massive_total_oi_raw": m_val,
                "effective_total_oi": eff,
                "oi_source": src,
                "oi_asof_date": td,
                "oi_reconciliation_reason": reason,
            }
        )

    return pl.DataFrame(rows, schema=RECONCILED_DAILY_OI_SCHEMA).sort(["ticker", "trade_date"])
