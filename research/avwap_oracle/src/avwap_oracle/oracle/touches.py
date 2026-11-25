"""Symmetric LONG/SHORT AVWAP touch evaluator, executable next-open simulation,
triple-barrier outcomes, cost scenarios, pinning, false-break/reclaim, and O(1) splits.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal, Mapping, Sequence

import polars as pl

from avwap_oracle.math_core.corp_actions import (
    CorporateSplitEvent,
    apply_split_schedule_to_canonical_bars,
)
from avwap_oracle.oracle.candidates import CandidateAnchor

COST_SCENARIOS_BPS: tuple[int, ...] = (0, 20, 35, 50)
HORIZONS_DAYS: tuple[int, ...] = (3, 5)

BarrierOutcome = Literal["WIN", "LOSS", "TIMEOUT", "AMBIGUOUS", "RIGHT_CENSORED"]


@dataclass(frozen=True)
class TouchHorizonOutcome:
    horizon: int
    status: BarrierOutcome
    mfe_atr: float
    mae_atr: float
    aer_atr: float
    gross_return: float
    net_returns_by_cost_bps: dict[int, float]
    exit_idx: int | None
    exit_reason: str
    intrabar_resolved_by: str


@dataclass(frozen=True)
class TouchObservation:
    anchor_id: str
    ticker: str
    family: str
    polarity: Literal["LONG", "SHORT"]
    anchor_idx: int
    activated_idx: int
    touch_idx: int
    touch_ts: int
    signal_confirmed_ts: int
    entry_idx: int | None
    entry_ts: int | None
    entry_price: float
    atr_entry: float
    prior_min_separation_atr: float
    touch_close_penetration_atr: float
    outcomes: dict[int, TouchHorizonOutcome]


@dataclass(frozen=True)
class FalseBreakObservation:
    anchor_id: str
    ticker: str
    family: str
    polarity: Literal["LONG", "SHORT"]
    bar_idx: int
    entry_idx: int | None
    pierce_atr: float
    aer_h3: float
    aer_h5: float
    censored_h3: bool
    censored_h5: bool


@dataclass(frozen=True)
class AnchorTouchSummary:
    anchor_id: str
    ticker: str
    family: str
    polarity: Literal["LONG", "SHORT"]
    eligible_bars: int
    pinning_bars: int
    pinning_rate: float
    touches: tuple[TouchObservation, ...]
    false_breaks: tuple[FalseBreakObservation, ...]


def _resolve_5m_intrabar_barrier(
    bars_5m_day: pl.DataFrame | None,
    *,
    polarity: Literal["LONG", "SHORT"],
    tp_price_raw: float,
    sl_price_raw: float,
) -> BarrierOutcome:
    """Resolve same-day TP vs SL ordering using lower-timeframe ``rth_5m`` bars if deterministic."""
    if bars_5m_day is None or bars_5m_day.height == 0:
        return "AMBIGUOUS"
    ordered = bars_5m_day.sort("ts_open_utc_s")
    for h_5m, l_5m in zip(ordered["h"].to_list(), ordered["l"].to_list()):
        h_f, l_f = float(h_5m), float(l_5m)
        if polarity == "LONG":
            hit_tp = h_f >= tp_price_raw
            hit_sl = l_f <= sl_price_raw
        else:
            hit_tp = l_f <= tp_price_raw
            hit_sl = h_f >= sl_price_raw
        if hit_tp and hit_sl:
            return "AMBIGUOUS"
        if hit_tp:
            return "WIN"
        if hit_sl:
            return "LOSS"
    return "AMBIGUOUS"


def evaluate_anchor_touches(
    candidate: CandidateAnchor,
    bars_1d_enriched: pl.DataFrame,
    *,
    splits: Sequence[CorporateSplitEvent] = (),
    bars_5m: pl.DataFrame | None = None,
    bars_5m_by_date: Mapping[str, pl.DataFrame] | None = None,
    precomputed_avwap: pl.DataFrame | None = None,
    horizons: Sequence[int] = HORIZONS_DAYS,
    cost_scenarios_bps: Sequence[int] = COST_SCENARIOS_BPS,
) -> AnchorTouchSummary:
    """Evaluate causal touches, next-open executable returns, pinning, and false-break/reclaim."""
    df_av = precomputed_avwap
    if df_av is None:
        res_sp = apply_split_schedule_to_canonical_bars(
            bars_1d_enriched, splits, anchor_idx=candidate.anchor_idx
        )
        df_av = res_sp.bars

    n = df_av.height
    dates = [str(x) for x in df_av["trade_date"].to_list()]
    ts_opens = [int(x) for x in df_av["ts_open_utc_s"].to_list()]
    ts_closes = [int(x) for x in df_av["ts_close_utc_s"].to_list()]
    opens = [float(x) for x in df_av["o"].to_list()]
    highs = [float(x) for x in df_av["h"].to_list()]
    lows = [float(x) for x in df_av["l"].to_list()]
    closes = [float(x) for x in df_av["c"].to_list()]
    atrs = [float(x) if x is not None else math.nan for x in df_av["atr14"].to_list()]
    atr_prevs = [float(x) if x is not None else math.nan for x in df_av["atr14_prev"].to_list()]
    k_series = [float(x) if x is not None else 1.0 for x in df_av["split_factor_k"].to_list()]
    av_mu = [float(x) if x is not None else math.nan for x in df_av["avwap_mu"].to_list()]

    bars_5m_map: dict[str, pl.DataFrame]
    if bars_5m_by_date is not None:
        bars_5m_map = dict(bars_5m_by_date)
    else:
        bars_5m_map = {}
        if bars_5m is not None and bars_5m.height > 0:
            for td_key, sub in bars_5m.filter(pl.col("ticker") == candidate.ticker).group_by("trade_date"):
                td_str = str(td_key[0] if isinstance(td_key, tuple) else td_key)
                bars_5m_map[td_str] = sub

    def _simulate_horizon(entry_idx: int, entry_px: float, atr_entry: float, h_days: int) -> TouchHorizonOutcome:
        end_idx = entry_idx + h_days - 1
        if end_idx >= n or not (math.isfinite(atr_entry) and atr_entry > 0.0 and math.isfinite(entry_px) and entry_px > 0.0):
            return TouchHorizonOutcome(
                horizon=h_days,
                status="RIGHT_CENSORED",
                mfe_atr=math.nan,
                mae_atr=math.nan,
                aer_atr=math.nan,
                gross_return=math.nan,
                net_returns_by_cost_bps={bps: math.nan for bps in cost_scenarios_bps},
                exit_idx=None,
                exit_reason="CENSORED_END_OF_COVERAGE_OR_DELISTED",
                intrabar_resolved_by="NONE",
            )

        cum_k = 1.0
        mfe_atr = 0.0
        mae_atr = 0.0
        barrier_status: BarrierOutcome = "TIMEOUT"
        exit_idx = end_idx
        exit_px_in_entry_units = math.nan
        intrabar_src = "DAILY_OHLC"
        exit_reason = "TIME_LIMIT_H"

        tp_dist = 1.0 * atr_entry
        sl_dist = 0.5 * atr_entry

        for j in range(entry_idx, end_idx + 1):
            if j > entry_idx:
                cum_k *= k_series[j]
            h_adj = highs[j] / cum_k
            l_adj = lows[j] / cum_k
            c_adj = closes[j] / cum_k

            if candidate.polarity == "LONG":
                fav = max(0.0, (h_adj - entry_px) / atr_entry)
                adv = max(0.0, (entry_px - l_adj) / atr_entry)
                hit_tp = (h_adj - entry_px) >= tp_dist
                hit_sl = (entry_px - l_adj) >= sl_dist
                tp_raw = (entry_px + tp_dist) * cum_k
                sl_raw = (entry_px - sl_dist) * cum_k
            else:
                fav = max(0.0, (entry_px - l_adj) / atr_entry)
                adv = max(0.0, (h_adj - entry_px) / atr_entry)
                hit_tp = (entry_px - l_adj) >= tp_dist
                hit_sl = (h_adj - entry_px) >= sl_dist
                tp_raw = (entry_px - tp_dist) * cum_k
                sl_raw = (entry_px + sl_dist) * cum_k

            if fav > mfe_atr:
                mfe_atr = fav
            if adv > mae_atr:
                mae_atr = adv

            if barrier_status == "TIMEOUT":
                if hit_tp and hit_sl:
                    resolved = _resolve_5m_intrabar_barrier(
                        bars_5m_map.get(dates[j]),
                        polarity=candidate.polarity,
                        tp_price_raw=tp_raw,
                        sl_price_raw=sl_raw,
                    )
                    barrier_status = resolved
                    exit_idx = j
                    if resolved == "WIN":
                        intrabar_src = "RTH_5M_RESOLVED"
                        exit_reason = "TP_INTRABAR_5M"
                        exit_px_in_entry_units = entry_px + tp_dist if candidate.polarity == "LONG" else entry_px - tp_dist
                    elif resolved == "LOSS":
                        intrabar_src = "RTH_5M_RESOLVED"
                        exit_reason = "SL_INTRABAR_5M"
                        exit_px_in_entry_units = entry_px - sl_dist if candidate.polarity == "LONG" else entry_px + sl_dist
                    else:
                        intrabar_src = "AMBIGUOUS_DAILY_BOTH_BARRIERS"
                        exit_reason = "DOUBLE_BARRIER_AMBIGUOUS"
                        exit_px_in_entry_units = math.nan
                elif hit_tp:
                    barrier_status = "WIN"
                    exit_idx = j
                    exit_reason = "TAKE_PROFIT_1_0_ATR"
                    exit_px_in_entry_units = entry_px + tp_dist if candidate.polarity == "LONG" else entry_px - tp_dist
                elif hit_sl:
                    barrier_status = "LOSS"
                    exit_idx = j
                    exit_reason = "STOP_LOSS_0_5_ATR"
                    exit_px_in_entry_units = entry_px - sl_dist if candidate.polarity == "LONG" else entry_px + sl_dist
                elif j == end_idx:
                    exit_px_in_entry_units = c_adj

        if barrier_status == "AMBIGUOUS":
            # Conservative policy: AMBIGUOUS barrier order gives non-computable return (NaN), NEVER guessed as win
            gross_ret = math.nan
        elif candidate.polarity == "LONG":
            gross_ret = (exit_px_in_entry_units - entry_px) / entry_px
        else:
            gross_ret = (entry_px - exit_px_in_entry_units) / entry_px

        net_map = {
            bps: (gross_ret - (float(bps) / 10_000.0) if math.isfinite(gross_ret) else math.nan)
            for bps in cost_scenarios_bps
        }
        return TouchHorizonOutcome(
            horizon=h_days,
            status=barrier_status,
            mfe_atr=mfe_atr,
            mae_atr=mae_atr,
            aer_atr=mfe_atr - mae_atr,
            gross_return=gross_ret,
            net_returns_by_cost_bps=net_map,
            exit_idx=exit_idx,
            exit_reason=exit_reason,
            intrabar_resolved_by=intrabar_src,
        )

    touches: list[TouchObservation] = []
    false_breaks: list[FalseBreakObservation] = []
    eligible_bars = 0
    pinning_bars = 0
    last_touch_idx: int | None = None

    start_eval = max(candidate.activated_idx, candidate.anchor_idx + 1)
    for k in range(start_eval, n):
        atr_k = atrs[k]
        av_k = av_mu[k]
        if not (math.isfinite(atr_k) and atr_k > 0.0 and math.isfinite(av_k) and av_k > 0.0):
            continue

        eligible_bars += 1
        if abs(closes[k] - av_k) <= 0.20 * atr_k:
            pinning_bars += 1

        # False Break / Reclaim detection
        if candidate.polarity == "LONG":
            pierce = (av_k - lows[k]) / atr_k
            reclaimed = pierce > 0.20 and closes[k] > av_k
        else:
            pierce = (highs[k] - av_k) / atr_k
            reclaimed = pierce > 0.20 and closes[k] < av_k

        if reclaimed:
            fb_e_idx = k + 1 if k + 1 < n else None
            if fb_e_idx is not None:
                e_px = opens[fb_e_idx]
                a_ent = atr_prevs[fb_e_idx]
                o3 = _simulate_horizon(fb_e_idx, e_px, a_ent, 3)
                o5 = _simulate_horizon(fb_e_idx, e_px, a_ent, 5)
                false_breaks.append(
                    FalseBreakObservation(
                        anchor_id=candidate.anchor_id,
                        ticker=candidate.ticker,
                        family=candidate.family,
                        polarity=candidate.polarity,
                        bar_idx=k,
                        entry_idx=fb_e_idx,
                        pierce_atr=pierce,
                        aer_h3=o3.aer_atr,
                        aer_h5=o5.aer_atr,
                        censored_h3=o3.status == "RIGHT_CENSORED",
                        censored_h5=o5.status == "RIGHT_CENSORED",
                    )
                )
            else:
                false_breaks.append(
                    FalseBreakObservation(
                        anchor_id=candidate.anchor_id,
                        ticker=candidate.ticker,
                        family=candidate.family,
                        polarity=candidate.polarity,
                        bar_idx=k,
                        entry_idx=None,
                        pierce_atr=pierce,
                        aer_h3=math.nan,
                        aer_h5=math.nan,
                        censored_h3=True,
                        censored_h5=True,
                    )
                )

        # Touch eligibility: requires >= 5 prior bars since anchor + 3-bar cooldown
        if k < candidate.anchor_idx + 5:
            continue
        if last_touch_idx is not None and (k - last_touch_idx) < 3:
            continue

        # 5-bar strictly prior favorable separation >= 0.75 * ATR using each bar's contemporaneous causal AVWAP
        min_sep = float("inf")
        sep_ok = True
        for u in range(k - 5, k):
            av_u = av_mu[u]
            atr_u = atrs[u]
            if not (math.isfinite(av_u) and math.isfinite(atr_u) and atr_u > 0.0):
                sep_ok = False
                break
            sep_u = ((lows[u] - av_u) / atr_u) if candidate.polarity == "LONG" else ((av_u - highs[u]) / atr_u)
            if sep_u < min_sep:
                min_sep = sep_u
            if sep_u < 0.75:
                sep_ok = False
                break
        if not sep_ok:
            continue

        # Contact within AVWAP ± 0.25 * ATR and close not penetrating > 0.50 * ATR adverse
        if candidate.polarity == "LONG":
            touched = lows[k] <= av_k + 0.25 * atr_k and highs[k] >= av_k - 0.25 * atr_k
            pen = (av_k - closes[k]) / atr_k
        else:
            touched = highs[k] >= av_k - 0.25 * atr_k and lows[k] <= av_k + 0.25 * atr_k
            pen = (closes[k] - av_k) / atr_k

        if not (touched and pen <= 0.50):
            continue

        last_touch_idx = k
        entry_idx = (k + 1) if (k + 1 < n) else None
        if entry_idx is None:
            outcomes_censored = {
                h: TouchHorizonOutcome(
                    horizon=h,
                    status="RIGHT_CENSORED",
                    mfe_atr=math.nan,
                    mae_atr=math.nan,
                    aer_atr=math.nan,
                    gross_return=math.nan,
                    net_returns_by_cost_bps={bps: math.nan for bps in cost_scenarios_bps},
                    exit_idx=None,
                    exit_reason="CENSORED_NO_ENTRY_BAR",
                    intrabar_resolved_by="NONE",
                )
                for h in horizons
            }
            touches.append(
                TouchObservation(
                    anchor_id=candidate.anchor_id,
                    ticker=candidate.ticker,
                    family=candidate.family,
                    polarity=candidate.polarity,
                    anchor_idx=candidate.anchor_idx,
                    activated_idx=candidate.activated_idx,
                    touch_idx=k,
                    touch_ts=ts_opens[k],
                    signal_confirmed_ts=ts_closes[k],
                    entry_idx=None,
                    entry_ts=None,
                    entry_price=math.nan,
                    atr_entry=math.nan,
                    prior_min_separation_atr=min_sep,
                    touch_close_penetration_atr=pen,
                    outcomes=outcomes_censored,
                )
            )
            continue

        entry_px = opens[entry_idx]
        atr_ent = atr_prevs[entry_idx]
        outcomes_map = {h: _simulate_horizon(entry_idx, entry_px, atr_ent, h) for h in horizons}
        touches.append(
            TouchObservation(
                anchor_id=candidate.anchor_id,
                ticker=candidate.ticker,
                family=candidate.family,
                polarity=candidate.polarity,
                anchor_idx=candidate.anchor_idx,
                activated_idx=candidate.activated_idx,
                touch_idx=k,
                touch_ts=ts_opens[k],
                signal_confirmed_ts=ts_closes[k],
                entry_idx=entry_idx,
                entry_ts=ts_opens[entry_idx],
                entry_price=entry_px,
                atr_entry=atr_ent,
                prior_min_separation_atr=min_sep,
                touch_close_penetration_atr=pen,
                outcomes=outcomes_map,
            )
        )

    pin_rate = (pinning_bars / float(eligible_bars)) if eligible_bars > 0 else math.nan
    return AnchorTouchSummary(
        anchor_id=candidate.anchor_id,
        ticker=candidate.ticker,
        family=candidate.family,
        polarity=candidate.polarity,
        eligible_bars=eligible_bars,
        pinning_bars=pinning_bars,
        pinning_rate=pin_rate,
        touches=tuple(touches),
        false_breaks=tuple(false_breaks),
    )
