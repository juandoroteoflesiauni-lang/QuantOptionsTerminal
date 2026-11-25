"""Causal O(1) corporate action transformations for WeightedMomentState and canonical bars.

Conventions:
    - Split factor ``k = split_from / split_to`` (e.g. 10:1 -> ``k = 0.1``;
      1:5 reverse -> ``k = 5.0``):
      ``W' = W / k``, ``mu' = k * mu``, ``M2' = k * M2`` (so ``sd' = k * sd``).
      ``M2`` scales linearly in ``k`` because volume also scales reciprocally
      by ``1/k``.
    - Special dividend threshold policy (``cash_amount / prev_close >= min_pct``):
      experimental oracle convention ``d = (prev_close - cash_amount) / prev_close``
      with ``W' = W``, ``mu' = d * mu``, ``M2' = d^2 * M2``.
    - Double adjustment is strictly forbidden: adjusted series must never be
      transformed again.
"""

from __future__ import annotations

import datetime as dt
import math
from dataclasses import dataclass
from typing import Iterable

import polars as pl

from avwap_oracle.math_core.canonical_rth import WeightedMomentState, merge_moments


def apply_split_o1(
    state: WeightedMomentState,
    split_from: float,
    split_to: float,
) -> WeightedMomentState:
    """Apply an exact O(1) split / reverse-split transformation to ``state``."""
    if not (math.isfinite(split_from) and split_from > 0.0):
        raise ValueError(f"split_from must be finite > 0, got {split_from!r}")
    if not (math.isfinite(split_to) and split_to > 0.0):
        raise ValueError(f"split_to must be finite > 0, got {split_to!r}")

    if state.total_volume == 0.0:
        return state

    k = split_from / split_to
    return WeightedMomentState(
        total_volume=state.total_volume / k,
        vwap=k * state.vwap,
        m2=k * state.m2,
        variance_source=state.variance_source,
    )


def apply_special_dividend_o1(
    state: WeightedMomentState,
    cash_amount: float,
    prev_close: float,
    min_pct: float = 0.015,
) -> tuple[WeightedMomentState, bool]:
    """Apply an O(1) proportional special-dividend price adjustment when >= ``min_pct``."""
    if not (math.isfinite(cash_amount) and cash_amount >= 0.0):
        raise ValueError(f"cash_amount must be finite >= 0, got {cash_amount!r}")
    if not (math.isfinite(prev_close) and prev_close > 0.0):
        raise ValueError(f"prev_close must be finite > 0, got {prev_close!r}")
    if not (math.isfinite(min_pct) and min_pct >= 0.0):
        raise ValueError(f"min_pct must be finite >= 0, got {min_pct!r}")
    if cash_amount >= prev_close:
        raise ValueError(
            f"Impossible dividend factor: cash_amount ({cash_amount}) >= prev_close ({prev_close})"
        )

    if state.total_volume == 0.0:
        return state, False

    if (cash_amount / prev_close) < min_pct or cash_amount == 0.0:
        return state, False

    d = (prev_close - cash_amount) / prev_close
    if not (0.0 < d < 1.0):
        raise ValueError(f"Dividend factor d={d} out of (0, 1)")

    adjusted = WeightedMomentState(
        total_volume=state.total_volume,
        vwap=d * state.vwap,
        m2=(d * d) * state.m2,
        variance_source=state.variance_source,
    )
    return adjusted, True


@dataclass(frozen=True)
class CorporateSplitEvent:
    event_id: str
    ticker: str
    effective_date: str
    split_from: float
    split_to: float

    def __post_init__(self) -> None:
        dt.date.fromisoformat(self.effective_date)
        if not self.event_id or not self.ticker:
            raise ValueError("event_id and ticker must be non-empty")
        if not (math.isfinite(self.split_from) and self.split_from > 0.0):
            raise ValueError(f"Invalid split_from={self.split_from!r}")
        if not (math.isfinite(self.split_to) and self.split_to > 0.0):
            raise ValueError(f"Invalid split_to={self.split_to!r}")


@dataclass(frozen=True)
class AppliedSplitAudit:
    event_id: str
    ticker: str
    effective_date: str
    applied_at_bar_idx: int
    k_factor: float
    pre_state: WeightedMomentState
    post_state: WeightedMomentState


@dataclass(frozen=True)
class CausalSplitScheduleResult:
    bars: pl.DataFrame
    applied_audits: tuple[AppliedSplitAudit, ...]


def _deduplicate_splits(
    events: Iterable[CorporateSplitEvent],
    ticker: str,
) -> list[CorporateSplitEvent]:
    by_key: dict[tuple[str, str], CorporateSplitEvent] = {}
    for ev in events:
        if ev.ticker != ticker:
            continue
        key = (ev.ticker, ev.effective_date)
        existing = by_key.get(key)
        if existing is not None:
            if not (
                math.isclose(existing.split_from, ev.split_from, rel_tol=0.0, abs_tol=1e-12)
                and math.isclose(existing.split_to, ev.split_to, rel_tol=0.0, abs_tol=1e-12)
            ):
                raise ValueError(
                    f"Conflicting split events for {ticker} on {ev.effective_date}: "
                    f"{existing} vs {ev}"
                )
            continue
        by_key[key] = ev
    return sorted(by_key.values(), key=lambda e: e.effective_date)


def apply_split_schedule_to_canonical_bars(
    bars_df: pl.DataFrame,
    split_events: Iterable[CorporateSplitEvent],
    *,
    anchor_idx: int = 0,
    bars_are_adjusted: bool = False,
) -> CausalSplitScheduleResult:
    """Causally transform accumulated pre-split AVWAP state at each effective split date.

    Pre-split published rows keep their original unadjusted units; post-split rows
    reflect the O(1)-transformed accumulated anchor plus post-split raw bars.
    """
    if bars_are_adjusted:
        raise ValueError(
            "bars_are_adjusted=True is prohibited with apply_split_schedule_to_canonical_bars "
            "to prevent double adjustment."
        )
    required = {"ticker", "trade_date", "ts_open_utc_s", "W", "mu", "M2_within"}
    missing = sorted(required - set(bars_df.columns))
    if missing:
        raise ValueError(f"Missing required canonical bar columns: {missing}")
    if bars_df.height == 0:
        return CausalSplitScheduleResult(bars=bars_df, applied_audits=())

    tickers = bars_df["ticker"].unique().to_list()
    if len(tickers) != 1:
        raise ValueError(f"Expected single ticker in bars_df, got {tickers}")
    ticker = str(tickers[0])

    n = bars_df.height
    if anchor_idx < 0 or anchor_idx >= n:
        raise ValueError(f"Invalid anchor_idx={anchor_idx} for {n} bars")

    ordered = bars_df.sort(["ts_open_utc_s"])
    events = _deduplicate_splits(split_events, ticker)
    applied_event_keys: set[tuple[str, str]] = set()
    audits: list[AppliedSplitAudit] = []

    state = WeightedMomentState.neutral()
    anchor_date = str(ordered["trade_date"][anchor_idx])
    pending_events = [ev for ev in events if ev.effective_date > anchor_date]
    ev_ptr = 0

    avwap_mu_col: list[float] = []
    avwap_sd_col: list[float] = []
    cum_w_col: list[float] = []
    cum_m2_col: list[float] = []
    split_applied_col: list[bool] = []

    rows = ordered.to_dicts()
    for idx, row in enumerate(rows):
        if idx < anchor_idx:
            avwap_mu_col.append(math.nan)
            avwap_sd_col.append(math.nan)
            cum_w_col.append(math.nan)
            cum_m2_col.append(math.nan)
            split_applied_col.append(False)
            continue

        cur_date = str(row["trade_date"])
        applied_here = False
        while ev_ptr < len(pending_events) and cur_date >= pending_events[ev_ptr].effective_date:
            ev = pending_events[ev_ptr]
            ev_ptr += 1
            ev_key = (ev.ticker, ev.effective_date)
            if ev_key in applied_event_keys:
                continue
            applied_event_keys.add(ev_key)
            if state.total_volume > 0.0:
                pre = state
                state = apply_split_o1(state, ev.split_from, ev.split_to)
                audits.append(
                    AppliedSplitAudit(
                        event_id=ev.event_id,
                        ticker=ev.ticker,
                        effective_date=ev.effective_date,
                        applied_at_bar_idx=idx,
                        k_factor=ev.split_from / ev.split_to,
                        pre_state=pre,
                        post_state=state,
                    )
                )
                applied_here = True

        bar_state = WeightedMomentState(
            total_volume=float(row["W"]),
            vwap=float(row["mu"]),
            m2=float(row["M2_within"]),
        )
        state = merge_moments(state, bar_state)
        avwap_mu_col.append(state.vwap)
        avwap_sd_col.append(state.std_dev)
        cum_w_col.append(state.total_volume)
        cum_m2_col.append(state.m2)
        split_applied_col.append(applied_here)

    out_df = ordered.with_columns(
        pl.Series("avwap_mu", avwap_mu_col, dtype=pl.Float64),
        pl.Series("avwap_sd", avwap_sd_col, dtype=pl.Float64),
        pl.Series("cum_W", cum_w_col, dtype=pl.Float64),
        pl.Series("cum_M2", cum_m2_col, dtype=pl.Float64),
        pl.Series("split_applied", split_applied_col, dtype=pl.Boolean),
    )
    return CausalSplitScheduleResult(bars=out_df, applied_audits=tuple(audits))
