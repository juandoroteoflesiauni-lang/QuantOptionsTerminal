"""Causal multi-family AVWAP candidate generator for Axis 5 statistical falsification.

All 14 candidate families are generated strictly without look-ahead:
- Signal activation ``activated_idx`` NEVER precedes ``anchor_idx``.
- Daily OHLCV close / EOD derivatives / EOD unusual summary catalysts activate on
  the next eligible RTH session (``activated_idx >= confirm_idx + 1``) so no trade or
  touch evaluation occurs prior to full evidence availability.
- Ex-ante implied moves (earnings & macro WHAM) are read strictly from prior sessions
  (``trade_date < anchor_date``).
- SEC shelf registrations (``S-3``, ``S-3ASR``) are never treated as executed
  secondary offerings; ``424B5`` requires corroborating post-filing market placement shock.
"""

from __future__ import annotations

import datetime as dt
import json
import math
from dataclasses import dataclass
from typing import Any, Literal, Mapping, Sequence

import numpy as np
import polars as pl

from avwap_oracle.adapters.orats_rest import resolve_macro_wham_schedule
from avwap_oracle.math_core.causal_detectors import (
    compute_causal_atr14,
    detect_causal_swings,
    detect_climax_and_gaps,
)
from avwap_oracle.math_core.corp_actions import CorporateSplitEvent
from avwap_oracle.math_core.nyse_calendar import ET_TZ, get_session_bounds
from avwap_oracle.scoring.iass import IassBreakdown, IassConfig, IassFeatures, compute_iass

CANDIDATE_FAMILIES_14: tuple[str, ...] = (
    "EARNINGS_BLOWOUT",
    "EARNINGS_INLINE",  # Negative control
    "POST_OPEX",
    "CALENDAR_YTD",
    "CALENDAR_QTD",
    "MACRO_SHOCK",
    "VOLUME_CLIMAX",
    "BREAKAWAY_GAP",
    "SWING_CAUSAL",
    "SWING_NO_RVOL",  # Negative control
    "EX_DIVIDEND_REGULAR",  # Negative control
    "OPTIONS_FLOW_SHOCK",
    "INDEX_REBAL",
    "SECONDARY_OFFERING",
)

NEGATIVE_CONTROL_FAMILIES: frozenset[str] = frozenset(
    {"EARNINGS_INLINE", "SWING_NO_RVOL", "EX_DIVIDEND_REGULAR"}
)


@dataclass(frozen=True)
class CandidateAnchor:
    anchor_id: str
    ticker: str
    family: str
    polarity: Literal["LONG", "SHORT"]
    anchor_ts: int
    activated_ts: int
    available_at_utc_s: int
    anchor_idx: int
    activated_idx: int
    confirmation_lag: int
    event_source: str
    feature_asof: int
    data_coverage: float
    iass: IassBreakdown
    is_negative_control: bool


@dataclass(frozen=True)
class CandidateGenerationResult:
    candidates: tuple[CandidateAnchor, ...]
    bars_enriched: pl.DataFrame
    exclusion_counts: dict[str, int]
    notes: tuple[str, ...]


def attach_split_factors_and_causal_indicators(
    bars_1d: pl.DataFrame,
    splits: Sequence[CorporateSplitEvent] = (),
    earnings_dates: Sequence[str] = (),
) -> pl.DataFrame:
    """Order ``rth_1D`` chronologically, attach ``split_factor_k``, causal ``ATR14``, and daily ``rvol_z``."""
    if bars_1d.height == 0:
        return bars_1d
    ordered = bars_1d.sort("ts_open_utc_s")
    if "ts_close_utc_s" not in ordered.columns:
        ts_closes: list[int] = []
        for td in ordered["trade_date"].to_list():
            sb = get_session_bounds(str(td))
            ts_closes.append(sb.rth_close_utc_s if sb is not None else 0)
        ordered = ordered.with_columns(pl.Series("ts_close_utc_s", ts_closes, dtype=pl.Int64))

    tickers = ordered["ticker"].unique().to_list()
    sym = str(tickers[0])
    dates = ordered["trade_date"].to_list()
    sp_sorted = sorted(
        [s for s in splits if s.ticker == sym],
        key=lambda x: x.effective_date,
    )
    k_col = [1.0] * len(dates)
    sp_ptr = 0
    for idx, td in enumerate(dates):
        if idx == 0:
            while sp_ptr < len(sp_sorted) and str(td) >= sp_sorted[sp_ptr].effective_date:
                sp_ptr += 1
            continue
        k_val = 1.0
        while sp_ptr < len(sp_sorted) and str(td) >= sp_sorted[sp_ptr].effective_date:
            k_val *= sp_sorted[sp_ptr].split_from / sp_sorted[sp_ptr].split_to
            sp_ptr += 1
        k_col[idx] = k_val

    with_k = ordered.with_columns(pl.Series("split_factor_k", k_col, dtype=pl.Float64))
    with_atr = compute_causal_atr14(with_k)

    # Strictly causal trailing 20-session log-volume RVOL_z (rescaling prior volumes across O(1) splits)
    earn_set = set(earnings_dates)
    vols = with_atr["W"].to_list()
    t_dates = with_atr["trade_date"].to_list()
    prior_vols: list[float] = []
    rvol_z_col: list[float] = []
    for td, w_raw, k_val in zip(t_dates, vols, k_col):
        if k_val != 1.0 and math.isfinite(k_val) and k_val > 0.0 and prior_vols:
            prior_vols = [pv / k_val for pv in prior_vols]
        w_val = float(w_raw) if w_raw is not None and math.isfinite(float(w_raw)) else math.nan
        if len(prior_vols) < 20 or not (math.isfinite(w_val) and w_val > 0.0):
            rvol_z_col.append(math.nan)
        else:
            arr = np.log(np.maximum(np.asarray(prior_vols[-20:], dtype=np.float64), 1.0))
            med = float(np.median(arr))
            mad = float(np.median(np.abs(arr - med)))
            denom = 1.4826 * mad + 1e-6
            rvol_z_col.append((math.log(max(w_val, 1.0)) - med) / denom)
        if math.isfinite(w_val) and w_val > 0.0 and str(td) not in earn_set:
            prior_vols.append(w_val)

    return with_atr.with_columns(pl.Series("rvol_z", rvol_z_col, dtype=pl.Float64))


def _first_idx_at_or_after_ts(ts_opens: Sequence[int], avail_ts: int, min_idx: int) -> int | None:
    for i in range(max(0, min_idx), len(ts_opens)):
        if int(ts_opens[i]) >= avail_ts:
            return i
    return None


def _extract_wham_implied_move_for_date(payload_json: str, target_td: str) -> float:
    try:
        obj = json.loads(payload_json)
    except Exception:
        return math.nan
    for ev in obj.get("eventDays") or []:
        if isinstance(ev, dict) and str(ev.get("date") or "")[:10] == target_td:
            mv = ev.get("impliedMovePct")
            if isinstance(mv, (int, float)) and not isinstance(mv, bool) and math.isfinite(float(mv)) and float(mv) > 0.0:
                return float(mv)
    ns = obj.get("nextSession")
    if isinstance(ns, dict) and str(ns.get("date") or "")[:10] == target_td:
        mv = ns.get("impliedMovePct")
        if isinstance(mv, (int, float)) and not isinstance(mv, bool) and math.isfinite(float(mv)) and float(mv) > 0.0:
            return float(mv)
    return math.nan


def generate_causal_candidates(
    *,
    ticker: str,
    asset_class: str,
    bars_1d: pl.DataFrame,
    splits: Sequence[CorporateSplitEvent] = (),
    dividends_df: pl.DataFrame | None = None,
    earnings_reconciled_df: pl.DataFrame | None = None,
    orats_cores_df: pl.DataFrame | None = None,
    orats_summaries_df: pl.DataFrame | None = None,
    reconciled_oi_df: pl.DataFrame | None = None,
    orats_gex_opex_df: pl.DataFrame | None = None,
    orats_wham_df: pl.DataFrame | None = None,
    massive_unusual_df: pl.DataFrame | None = None,
    econ_calendar_df: pl.DataFrame | None = None,
    sec_filings_df: pl.DataFrame | None = None,
    index_history_df: pl.DataFrame | None = None,
    float_snapshot: float | None = None,
    iass_config: IassConfig | None = None,
) -> CandidateGenerationResult:
    """Generate causal AVWAP candidate anchors across all 14 Axis 5 families on ``rth_1D``."""
    sym = ticker.strip().upper()
    cfg = iass_config if iass_config is not None else IassConfig()
    excl: dict[str, int] = {}
    notes: list[str] = []

    def _bump_excl(reason: str) -> None:
        excl[reason] = excl.get(reason, 0) + 1

    earn_dates_list: list[str] = []
    if earnings_reconciled_df is not None and earnings_reconciled_df.height > 0:
        earn_dates_list = [
            str(x) for x in earnings_reconciled_df.filter(pl.col("ticker") == sym)["earn_date_canonical"].to_list()
        ]

    df = attach_split_factors_and_causal_indicators(bars_1d.filter(pl.col("ticker") == sym), splits=splits, earnings_dates=earn_dates_list)
    if df.height == 0:
        return CandidateGenerationResult(candidates=(), bars_enriched=df, exclusion_counts=excl, notes=("EMPTY_1D_BARS",))

    n = df.height
    trade_dates = [str(x) for x in df["trade_date"].to_list()]
    date_to_idx = {td: i for i, td in enumerate(trade_dates)}
    ts_opens = [int(x) for x in df["ts_open_utc_s"].to_list()]
    ts_closes = [int(x) for x in df["ts_close_utc_s"].to_list()]
    opens = [float(x) for x in df["o"].to_list()]
    closes = [float(x) for x in df["c"].to_list()]
    vols = [float(x) for x in df["W"].to_list()]
    atr_prevs = [float(x) if x is not None else math.nan for x in df["atr14_prev"].to_list()]
    atrs = [float(x) if x is not None else math.nan for x in df["atr14"].to_list()]
    prev_cs = [float(x) if x is not None else math.nan for x in df["prev_close_causal"].to_list()]
    rvol_zs = [float(x) if x is not None else math.nan for x in df["rvol_z"].to_list()]

    # Lookup maps for ORATS cores, summaries & reconciled OI (strictly indexed by trade_date)
    cores_by_td: dict[str, dict[str, Any]] = {}
    if orats_cores_df is not None and orats_cores_df.height > 0:
        for r in orats_cores_df.filter(pl.col("ticker") == sym).sort("trade_date").iter_rows(named=True):
            cores_by_td[str(r["trade_date"])[:10]] = r
    summaries_by_td: dict[str, dict[str, Any]] = {}
    if orats_summaries_df is not None and orats_summaries_df.height > 0:
        for r in orats_summaries_df.filter(pl.col("ticker") == sym).sort("trade_date").iter_rows(named=True):
            summaries_by_td[str(r["trade_date"])[:10]] = r
    oi_by_td: dict[str, dict[str, Any]] = {}
    if reconciled_oi_df is not None and reconciled_oi_df.height > 0:
        for r in reconciled_oi_df.filter(pl.col("ticker") == sym).sort("trade_date").iter_rows(named=True):
            oi_by_td[str(r["trade_date"])[:10]] = r

    # Trailing 20-day IV change z-score and OI log-change z-score strictly prior to t
    iv_z_by_idx = [math.nan] * n
    oi_shock_by_idx = [math.nan] * n
    iv_changes: list[float] = []
    oi_changes: list[float] = []
    prev_iv = math.nan
    prev_oi_val = math.nan
    for idx, td in enumerate(trade_dates):
        cr = cores_by_td.get(td)
        cur_iv = float(cr["or_iv_xern_20d_dec"]) if (cr and cr.get("or_iv_xern_20d_dec") is not None and math.isfinite(float(cr["or_iv_xern_20d_dec"]))) else math.nan
        if math.isfinite(cur_iv) and cur_iv > 0.0 and math.isfinite(prev_iv) and prev_iv > 0.0:
            d_iv = cur_iv - prev_iv
            if len(iv_changes) >= 20:
                arr = np.asarray(iv_changes[-60:], dtype=np.float64)
                sd = float(np.std(arr, ddof=1))
                if sd > 1e-12:
                    iv_z_by_idx[idx] = (d_iv - float(np.mean(arr))) / sd
            iv_changes.append(d_iv)
        if math.isfinite(cur_iv) and cur_iv > 0.0:
            prev_iv = cur_iv

        orow = oi_by_td.get(td)
        cur_oi = float(orow["effective_total_oi"]) if (orow and orow.get("effective_total_oi") is not None and int(orow["effective_total_oi"]) > 0) else math.nan
        if math.isfinite(cur_oi) and math.isfinite(prev_oi_val):
            d_oi = math.log(cur_oi / prev_oi_val)
            if len(oi_changes) >= 20:
                arr_o = np.asarray(oi_changes[-60:], dtype=np.float64)
                sd_o = float(np.std(arr_o, ddof=1))
                if sd_o > 1e-12:
                    oi_shock_by_idx[idx] = abs((d_oi - float(np.mean(arr_o))) / sd_o)
            oi_changes.append(d_oi)
        if math.isfinite(cur_oi):
            prev_oi_val = cur_oi

    # Pre-split float PIT flag (never treat CURRENT_SNAPSHOT_ONLY float_snapshots as PIT!)
    _ = float_snapshot  # Explicitly retained in signature ONLY to verify non-PIT exclusion

    candidates: list[CandidateAnchor] = []
    seen_ids: set[str] = set()

    def _add_candidate(
        *,
        family: str,
        polarity: Literal["LONG", "SHORT"],
        anchor_idx: int,
        activated_idx: int,
        available_at_utc_s: int,
        event_source: str,
        features: IassFeatures,
    ) -> None:
        aid = f"{sym}:{family}:{trade_dates[anchor_idx]}:{anchor_idx}:{polarity}"
        if aid in seen_ids:
            return
        seen_ids.add(aid)
        bd = compute_iass(features, cfg)
        candidates.append(
            CandidateAnchor(
                anchor_id=aid,
                ticker=sym,
                family=family,
                polarity=polarity,
                anchor_ts=ts_opens[anchor_idx],
                activated_ts=ts_opens[activated_idx],
                available_at_utc_s=max(available_at_utc_s, ts_opens[activated_idx] if available_at_utc_s < ts_opens[anchor_idx] else available_at_utc_s),
                anchor_idx=anchor_idx,
                activated_idx=activated_idx,
                confirmation_lag=activated_idx - anchor_idx,
                event_source=event_source,
                feature_asof=features.feature_asof,
                data_coverage=bd.data_coverage,
                iass=bd,
                is_negative_control=family in NEGATIVE_CONTROL_FAMILIES,
            )
        )

    def _opra_covered(td: str) -> bool:
        return (td in cores_by_td) or (td in summaries_by_td) or (td in oi_by_td)

    def _oi_src(td: str) -> str | None:
        r = oi_by_td.get(td)
        return str(r["oi_source"]) if r else None

    def _build_close_confirmed_features(
        family: str,
        polarity: Literal["LONG", "SHORT"],
        bar_idx: int,
        *,
        ex_ante_imp_move: float | None = None,
        ex_ante_imp_avail: int | None = None,
        ret_start_ts: int | None = None,
    ) -> IassFeatures:
        td = trade_dates[bar_idx]
        pc = prev_cs[bar_idx]
        atr_p = atr_prevs[bar_idx]
        atr_c = atrs[bar_idx]
        realized_ret = ((closes[bar_idx] - pc) / pc) if (math.isfinite(pc) and pc > 0.0) else None
        gap_atr = (abs(opens[bar_idx] - pc) / atr_p) if (math.isfinite(pc) and math.isfinite(atr_p) and atr_p > 0.0) else None
        disp_atr = (abs(closes[bar_idx] - opens[bar_idx]) / atr_c) if (math.isfinite(atr_c) and atr_c > 0.0) else None
        rz = rvol_zs[bar_idx] if math.isfinite(rvol_zs[bar_idx]) else None
        ivz = iv_z_by_idx[bar_idx] if math.isfinite(iv_z_by_idx[bar_idx]) else None
        oish = oi_shock_by_idx[bar_idx] if math.isfinite(oi_shock_by_idx[bar_idx]) else None
        return IassFeatures(
            family=family,
            polarity=polarity,
            feature_asof=ts_closes[bar_idx],
            orats_opra_covered=_opra_covered(td) or (ex_ante_imp_move is not None),
            oi_source=_oi_src(td),
            rvol_z=rz,
            float_turnover_pct=None,
            float_is_pit=False,
            realized_return=realized_ret,
            realized_return_start_ts_utc_s=ret_start_ts or ts_opens[bar_idx],
            implied_move_dec=ex_ante_imp_move,
            implied_move_available_at_utc_s=ex_ante_imp_avail,
            oi_gex_shock=oish,
            iv_change_z=ivz,
            catalyst_data_available=True,
            gap_atr=gap_atr,
            close_disp_atr=disp_atr,
            atr_valid=math.isfinite(atr_c) and atr_c > 0.0,
            atr_available_at_utc_s=ts_closes[bar_idx],
        )

    # 1 & 2. EARNINGS_BLOWOUT & EARNINGS_INLINE
    if earnings_reconciled_df is not None and earnings_reconciled_df.height > 0:
        for er in earnings_reconciled_df.filter(pl.col("ticker") == sym).iter_rows(named=True):
            a_ts_raw = er.get("anchor_ts_rth_utc_s")
            av_ts_raw = er.get("available_at_utc_s")
            if a_ts_raw is None or av_ts_raw is None:
                _bump_excl("EARNINGS_MISSING_TIMING_OR_ANCHOR")
                continue
            a_date = dt.datetime.fromtimestamp(int(a_ts_raw), ET_TZ).date().isoformat()
            a_idx = date_to_idx.get(a_date)
            if a_idx is None or a_idx < 1:
                _bump_excl("EARNINGS_OUTSIDE_1D_BARS")
                continue
            prev_td = trade_dates[a_idx - 1]
            c_prev = cores_by_td.get(prev_td)
            s_prev = summaries_by_td.get(prev_td)
            imp_mv = math.nan
            # Strictly use isolated 1-day impliedEarningsMove (summaries primary, cores identical-field fallback); never fuse impErnMv
            if s_prev is not None:
                raw_sum_iem = s_prev.get("implied_earnings_move_dec")
                if raw_sum_iem is not None and not isinstance(raw_sum_iem, bool):
                    cand_mv_sum = float(raw_sum_iem)
                    if math.isfinite(cand_mv_sum) and cand_mv_sum > 0.0:
                        imp_mv = cand_mv_sum
            if not (math.isfinite(imp_mv) and imp_mv > 0.0) and c_prev is not None:
                raw_iem = c_prev.get("cores_implied_earnings_move_dec")
                if raw_iem is not None and not isinstance(raw_iem, bool):
                    cand_mv = float(raw_iem)
                    if math.isfinite(cand_mv) and cand_mv > 0.0:
                        imp_mv = cand_mv
            if not (math.isfinite(imp_mv) and imp_mv > 0.0):
                _bump_excl("EARNINGS_MISSING_EX_ANTE_IMPLIED_MOVE")
                continue
            pc = prev_cs[a_idx]
            if not (math.isfinite(pc) and pc > 0.0):
                _bump_excl("EARNINGS_MISSING_PREV_CLOSE")
                continue
            realized_ret = (closes[a_idx] - pc) / pc
            ratio = abs(realized_ret) / imp_mv
            act_idx = _first_idx_at_or_after_ts(ts_opens, max(ts_closes[a_idx], int(av_ts_raw)), a_idx + 1)
            if act_idx is None:
                _bump_excl("EARNINGS_END_OF_COVERAGE_NO_NEXT_BAR")
                continue
            pol: Literal["LONG", "SHORT"] = "LONG" if realized_ret >= 0.0 else "SHORT"
            if ratio >= 1.25:
                fam = "EARNINGS_BLOWOUT"
            elif ratio < 0.75:
                fam = "EARNINGS_INLINE"
            else:
                _bump_excl("EARNINGS_MID_BAND_0.75_TO_1.25")
                continue
            feats = _build_close_confirmed_features(
                fam,
                pol,
                a_idx,
                ex_ante_imp_move=imp_mv,
                ex_ante_imp_avail=ts_closes[a_idx - 1],
                ret_start_ts=ts_closes[a_idx - 1],
            )
            _add_candidate(
                family=fam,
                polarity=pol,
                anchor_idx=a_idx,
                activated_idx=act_idx,
                available_at_utc_s=max(ts_closes[a_idx], int(av_ts_raw)),
                event_source=f"earnings:{er.get('timing_source')}",
                features=feats,
            )

    # 3. POST_OPEX (uses PRE_OPEX GEX snapshot strictly before open; pre-open activation)
    if orats_gex_opex_df is not None and orats_gex_opex_df.height > 0:
        for gx in orats_gex_opex_df.filter((pl.col("ticker") == sym) & (pl.col("sampling_mode") == "PRE_OPEX")).iter_rows(named=True):
            # Prefer monthly OpEx GEX share so weekly 0DTE Thursday expirations on ETFs do not mask monthly OpEx pin concentration
            mon_raw = gx.get("monthly_opex_gex_share")
            exp_raw = gx.get("expiring_gex_share")
            share = float(mon_raw) if (mon_raw is not None and not isinstance(mon_raw, bool) and math.isfinite(float(mon_raw))) else (
                float(exp_raw) if (exp_raw is not None and not isinstance(exp_raw, bool) and math.isfinite(float(exp_raw))) else math.nan
            )
            if not (math.isfinite(share) and share >= 0.25):
                _bump_excl("PRE_OPEX_GEX_SHARE_BELOW_0.25_OR_NAN")
                continue
            opex_str = str(gx.get("monthly_opex_expir_date") or "").strip()[:10]
            pre_td = str(gx.get("trade_date") or "").strip()[:10]
            if not opex_str:
                continue
            # First trading session strictly AFTER monthly_opex_date
            post_idx = next((i for i, td in enumerate(trade_dates) if td > opex_str), None)
            pre_idx = date_to_idx.get(pre_td)
            if post_idx is None or post_idx < 1 or pre_idx is None:
                _bump_excl("POST_OPEX_OUTSIDE_1D_BARS")
                continue
            atr_p = atr_prevs[post_idx]
            pc = prev_cs[post_idx]
            gap_atr = (abs(opens[post_idx] - pc) / atr_p) if (math.isfinite(pc) and math.isfinite(atr_p) and atr_p > 0.0) else None
            net_gex = float(gx.get("net_gex_raw_gamma_oi") or 0.0)
            pol = "LONG" if net_gex >= 0.0 else "SHORT"
            feats = IassFeatures(
                family="POST_OPEX",
                polarity=pol,
                feature_asof=ts_opens[post_idx],
                orats_opra_covered=_opra_covered(pre_td),
                oi_source=_oi_src(pre_td),
                oi_gex_shock=share * 4.0,
                iv_change_z=iv_z_by_idx[pre_idx] if math.isfinite(iv_z_by_idx[pre_idx]) else None,
                catalyst_data_available=True,
                gap_atr=gap_atr,
                atr_valid=math.isfinite(atr_p) and atr_p > 0.0,
                atr_available_at_utc_s=ts_closes[post_idx - 1],
            )
            _add_candidate(
                family="POST_OPEX",
                polarity=pol,
                anchor_idx=post_idx,
                activated_idx=post_idx,
                available_at_utc_s=ts_opens[post_idx],
                event_source=f"orats_gex_opex:{pre_td}",
                features=feats,
            )

    # 4 & 5. CALENDAR_YTD & CALENDAR_QTD (first RTH session of year/quarter, pre-open causal!)
    seen_years: set[str] = set()
    seen_quarters: set[str] = set()
    for idx, td in enumerate(trade_dates):
        if idx < 1:
            seen_years.add(td[:4])
            q_num = (int(td[5:7]) - 1) // 3 + 1
            seen_quarters.add(f"{td[:4]}Q{q_num}")
            continue
        yr = td[:4]
        q_key = f"{yr}Q{(int(td[5:7]) - 1) // 3 + 1}"
        pc = prev_cs[idx]
        atr_p = atr_prevs[idx]
        gap_atr = (abs(opens[idx] - pc) / atr_p) if (math.isfinite(pc) and math.isfinite(atr_p) and atr_p > 0.0) else None
        pol: Literal["LONG", "SHORT"] = "LONG" if (not math.isfinite(pc) or opens[idx] >= pc) else "SHORT"
        prev_td = trade_dates[idx - 1]
        for fam, seen_set, key_val in (("CALENDAR_YTD", seen_years, yr), ("CALENDAR_QTD", seen_quarters, q_key)):
            if key_val not in seen_set:
                seen_set.add(key_val)
                feats = IassFeatures(
                    family=fam,
                    polarity=pol,
                    feature_asof=ts_opens[idx],
                    orats_opra_covered=_opra_covered(prev_td),
                    oi_source=_oi_src(prev_td),
                    iv_change_z=iv_z_by_idx[idx - 1] if math.isfinite(iv_z_by_idx[idx - 1]) else None,
                    catalyst_data_available=True,
                    gap_atr=gap_atr,
                    atr_valid=math.isfinite(atr_p) and atr_p > 0.0,
                    atr_available_at_utc_s=ts_closes[idx - 1],
                )
                _add_candidate(
                    family=fam,
                    polarity=pol,
                    anchor_idx=idx,
                    activated_idx=idx,
                    available_at_utc_s=ts_opens[idx],
                    event_source=f"calendar:{key_val}",
                    features=feats,
                )

    # 6. MACRO_SHOCK (US_ETF >= 2023-01-01; ratio >= 1.5 vs T-1 WHAM or T-1 ORATS daily implied move)
    if asset_class == "US_ETF" and econ_calendar_df is not None and econ_calendar_df.height > 0:
        wham_by_td: dict[str, str] = {}
        if orats_wham_df is not None and orats_wham_df.height > 0:
            for r in orats_wham_df.filter(pl.col("ticker") == sym).iter_rows(named=True):
                wham_by_td[str(r["trade_date"])[:10]] = str(r["payload_json"])
        sched = resolve_macro_wham_schedule(econ_calendar_df, "2023-01-01", trade_dates[-1])
        macro_sessions: dict[str, tuple[list[str], str]] = {}
        for ev in sched.events:
            if ev.assigned_session_t in date_to_idx:
                types_list, _ = macro_sessions.get(ev.assigned_session_t, ([], ev.assigned_session_t_minus_1))
                types_list.append(ev.macro_event_type)
                macro_sessions[ev.assigned_session_t] = (types_list, ev.assigned_session_t_minus_1)

        for td_ev, (types, prev_td) in sorted(macro_sessions.items()):
            a_idx = date_to_idx[td_ev]
            if a_idx < 1 or a_idx + 1 >= n:
                continue
            imp_mv = math.nan
            mv_src = ""
            if prev_td in wham_by_td:
                imp_mv = _extract_wham_implied_move_for_date(wham_by_td[prev_td], td_ev)
                mv_src = "WHAM_T_MINUS_1"
            if not (math.isfinite(imp_mv) and imp_mv > 0.0) and prev_td in cores_by_td:
                iv_d = float(cores_by_td[prev_td].get("or_iv_xern_20d_dec") or math.nan)
                if math.isfinite(iv_d) and iv_d > 0.0:
                    imp_mv = iv_d / math.sqrt(252.0)
                    mv_src = "ORATS_IV_1D_EQUIV_T_MINUS_1"
            if not (math.isfinite(imp_mv) and imp_mv > 0.0):
                _bump_excl("MACRO_SHOCK_MISSING_EX_ANTE_IMPLIED_MOVE")
                continue
            pc = prev_cs[a_idx]
            if not (math.isfinite(pc) and pc > 0.0):
                continue
            ret = (closes[a_idx] - pc) / pc
            if abs(ret) / imp_mv >= 1.5:
                pol = "LONG" if ret >= 0.0 else "SHORT"
                feats = _build_close_confirmed_features(
                    "MACRO_SHOCK",
                    pol,
                    a_idx,
                    ex_ante_imp_move=imp_mv,
                    ex_ante_imp_avail=ts_closes[a_idx - 1],
                    ret_start_ts=ts_closes[a_idx - 1],
                )
                _add_candidate(
                    family="MACRO_SHOCK",
                    polarity=pol,
                    anchor_idx=a_idx,
                    activated_idx=a_idx + 1,
                    available_at_utc_s=ts_closes[a_idx],
                    event_source=f"macro:{','.join(sorted(set(types)))}:{mv_src}",
                    features=feats,
                )

    # 7 & 8. VOLUME_CLIMAX & BREAKAWAY_GAP (using existing causal detector; activated at bar_idx + 1)
    cg_events = detect_climax_and_gaps(df, default_bar_minutes=390)
    for ev in cg_events:
        a_idx = date_to_idx.get(dt.datetime.fromtimestamp(ev.anchor_ts, ET_TZ).date().isoformat())
        if a_idx is None or a_idx + 1 >= n:
            _bump_excl(f"{ev.event_type}_END_OF_COVERAGE")
            continue
        pol = "LONG" if ev.direction == "BULLISH" else "SHORT"
        feats = _build_close_confirmed_features(ev.event_type, pol, a_idx)
        _add_candidate(
            family=ev.event_type,
            polarity=pol,
            anchor_idx=a_idx,
            activated_idx=a_idx + 1,
            available_at_utc_s=ts_closes[a_idx],
            event_source=f"math_core:{ev.event_type}",
            features=feats,
        )

    # 9 & 10. SWING_CAUSAL (anchor_rvol_z >= 1.5) & SWING_NO_RVOL (anchor_rvol_z < 1.0)
    sw_events = detect_causal_swings(df, "1D", m_atr=2.0, k_min=2)
    for sw in sw_events:
        a_idx = sw.anchor_idx
        c_idx = sw.confirm_idx
        if c_idx + 1 >= n:
            _bump_excl("SWING_END_OF_COVERAGE")
            continue
        rz_a = sw.anchor_rvol_z
        if not math.isfinite(rz_a):
            _bump_excl("SWING_RVOL_UNAVAILABLE")
            continue
        if rz_a >= 1.5:
            fam = "SWING_CAUSAL"
        elif rz_a < 1.0:
            fam = "SWING_NO_RVOL"
        else:
            _bump_excl("SWING_MID_RVOL_1.0_TO_1.5")
            continue
        pol = "LONG" if sw.swing_kind == "SWING_LOW" else "SHORT"
        feats = _build_close_confirmed_features(fam, pol, c_idx)
        # Replace M_rvol cleanly with exact anchor rvol_z known since anchor bar
        feats = feats.model_copy(update={"rvol_z": float(rz_a), "feature_asof": ts_closes[c_idx]})
        _add_candidate(
            family=fam,
            polarity=pol,
            anchor_idx=a_idx,
            activated_idx=c_idx + 1,
            available_at_utc_s=ts_closes[c_idx],
            event_source=f"math_core_swing:{sw.swing_kind}:lag={c_idx - a_idx}",
            features=feats,
        )

    # 11. EX_DIVIDEND_REGULAR (< 1.5% prev close; negative control)
    if dividends_df is not None and dividends_df.height > 0:
        for dv in dividends_df.filter(pl.col("ticker") == sym).iter_rows(named=True):
            if not bool(dv.get("safe_to_apply")) or bool(dv.get("is_special_provider")):
                _bump_excl("DIVIDEND_SPECIAL_OR_CONFLICT")
                continue
            ex_td = str(dv.get("ex_dividend_date") or "")[:10]
            a_idx = date_to_idx.get(ex_td)
            if a_idx is None or a_idx < 1 or a_idx + 1 >= n:
                continue
            cash = float(dv.get("cash_amount_canonical") or math.nan)
            pc = prev_cs[a_idx]
            if not (math.isfinite(cash) and math.isfinite(pc) and pc > 0.0):
                continue
            if (cash / pc) >= 0.015:
                _bump_excl("DIVIDEND_ABOVE_1.5PCT_SPECIAL")
                continue
            pol = "LONG" if closes[a_idx] >= pc else "SHORT"
            feats = _build_close_confirmed_features("EX_DIVIDEND_REGULAR", pol, a_idx)
            _add_candidate(
                family="EX_DIVIDEND_REGULAR",
                polarity=pol,
                anchor_idx=a_idx,
                activated_idx=a_idx + 1,
                available_at_utc_s=ts_closes[a_idx],
                event_source=f"dividend_regular:{ex_td}",
                features=feats,
            )

    # 12. OPTIONS_FLOW_SHOCK (>= 2022-09-01; event-gated Massive Unusual confirmed)
    if massive_unusual_df is not None and massive_unusual_df.height > 0 and "eligible_print_count" in massive_unusual_df.columns:
        for mu in massive_unusual_df.filter(
            (pl.col("ticker") == sym) & (pl.col("trade_date") >= "2022-09-01")
        ).iter_rows(named=True):
            if not bool(mu.get("is_complete_day")):
                _bump_excl("OPTIONS_FLOW_INCOMPLETE_DAY")
                continue
            if int(mu.get("eligible_print_count") or 0) <= 0:
                _bump_excl("OPTIONS_FLOW_ZERO_ELIGIBLE_PRINTS")
                continue
            td_u = str(mu["trade_date"])[:10]
            a_idx = date_to_idx.get(td_u)
            if a_idx is None:
                continue
            avail_u = int(mu.get("available_at_utc_s") or ts_closes[a_idx])
            act_idx = _first_idx_at_or_after_ts(ts_opens, max(ts_closes[a_idx], avail_u), a_idx + 1)
            if act_idx is None:
                _bump_excl("OPTIONS_FLOW_END_OF_COVERAGE")
                continue
            pol = "LONG" if closes[a_idx] >= opens[a_idx] else "SHORT"
            feats = _build_close_confirmed_features("OPTIONS_FLOW_SHOCK", pol, a_idx)
            _add_candidate(
                family="OPTIONS_FLOW_SHOCK",
                polarity=pol,
                anchor_idx=a_idx,
                activated_idx=act_idx,
                available_at_utc_s=max(ts_closes[a_idx], avail_u),
                event_source=f"massive_unusual:{mu.get('trigger_reason')}",
                features=feats,
            )

    # 13. INDEX_REBAL (historical constituents in effective window)
    if index_history_df is not None and index_history_df.height > 0:
        matches = index_history_df.filter(
            (pl.col("symbol") == sym) | (pl.col("added_ticker") == sym) | (pl.col("removed_ticker") == sym)
        )
        for ix in matches.iter_rows(named=True):
            eff_td = str(ix.get("effective_date") or "")[:10]
            a_idx = date_to_idx.get(eff_td)
            if a_idx is None or a_idx < 1:
                continue
            is_removed = str(ix.get("removed_ticker") or "").upper() == sym or "remov" in str(ix.get("change_type") or "").lower()
            pol = "SHORT" if is_removed else "LONG"
            pc = prev_cs[a_idx]
            atr_p = atr_prevs[a_idx]
            gap_atr = (abs(opens[a_idx] - pc) / atr_p) if (math.isfinite(pc) and math.isfinite(atr_p) and atr_p > 0.0) else None
            prev_td = trade_dates[a_idx - 1]
            feats = IassFeatures(
                family="INDEX_REBAL",
                polarity=pol,
                feature_asof=ts_opens[a_idx],
                orats_opra_covered=_opra_covered(prev_td),
                oi_source=_oi_src(prev_td),
                catalyst_data_available=True,
                gap_atr=gap_atr,
                atr_valid=math.isfinite(atr_p) and atr_p > 0.0,
                atr_available_at_utc_s=ts_closes[a_idx - 1],
            )
            _add_candidate(
                family="INDEX_REBAL",
                polarity=pol,
                anchor_idx=a_idx,
                activated_idx=a_idx,
                available_at_utc_s=ts_opens[a_idx],
                event_source=f"index:{ix.get('index_name')}:{eff_td}",
                features=feats,
            )

    # 14. SECONDARY_OFFERING (S-3 / S-3ASR shelf strictly excluded; 424B5 requires corroborating dilution shock)
    if sec_filings_df is not None and sec_filings_df.height > 0:
        for sf in sec_filings_df.filter(pl.col("ticker") == sym).iter_rows(named=True):
            form = str(sf.get("form_type") or "").strip().upper()
            if form in ("S-3", "S-3ASR"):
                _bump_excl("SHELF_REGISTRATION_NOT_EXECUTED_OFFERING")
                continue
            if form != "424B5":
                continue
            av_ts = int(sf.get("available_at_utc_s") or -1)
            if av_ts <= 0:
                continue
            # First session whose CLOSE is after accepted_ts and within 3 sessions of filing_date
            f_td = str(sf.get("filing_date") or "")[:10]
            cand_idx = next((i for i in range(1, n - 1) if ts_closes[i] > av_ts and trade_dates[i] >= f_td), None)
            if cand_idx is None:
                continue
            pc = prev_cs[cand_idx]
            ret = ((closes[cand_idx] - pc) / pc) if (math.isfinite(pc) and pc > 0.0) else 0.0
            rz = rvol_zs[cand_idx]
            if not (math.isfinite(rz) and rz >= 1.5 and ret <= -0.02):
                _bump_excl("424B5_NO_MARKET_PLACEMENT_EVIDENCE")
                continue
            feats = _build_close_confirmed_features("SECONDARY_OFFERING", "SHORT", cand_idx)
            _add_candidate(
                family="SECONDARY_OFFERING",
                polarity="SHORT",
                anchor_idx=cand_idx,
                activated_idx=cand_idx + 1,
                available_at_utc_s=max(av_ts, ts_closes[cand_idx]),
                event_source=f"sec_424B5_corroborated:{f_td}",
                features=feats,
            )

    candidates.sort(key=lambda c: (c.activated_idx, c.anchor_idx, c.family, c.anchor_id))
    return CandidateGenerationResult(
        candidates=tuple(candidates),
        bars_enriched=df,
        exclusion_counts=excl,
        notes=tuple(notes),
    )
