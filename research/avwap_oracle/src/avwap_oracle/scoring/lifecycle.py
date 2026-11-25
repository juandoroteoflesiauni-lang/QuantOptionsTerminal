"""Causal anchor lifecycle engine: Grinblatt-Han cohort decay, Chop saturation,
Flat slope, PINCH_PAIR protection, deterministic spatial deduplication, and FSM.

All decisions operate strictly bar-by-bar using only information available at or
before bar ``t`` (guaranteeing exact prefix invariance). Visual display budgets
are enforced strictly downstream of FSM states without removing hidden anchors from
the Axis 5 statistical study universe.
"""

from __future__ import annotations

import datetime as dt
import math
from dataclasses import dataclass
from typing import Any, Literal, Mapping, Sequence

import numpy as np
from pydantic import BaseModel, ConfigDict, Field

from avwap_oracle.math_core.nyse_calendar import ET_TZ

FsmState = Literal[
    "CANDIDATE",
    "ACTIVE_PRIMARY",
    "ACTIVE_SECONDARY",
    "PINCH_PAIR",
    "DECAYING",
    "ARCHIVED",
]

VISUAL_BUDGET_BY_TIMEFRAME: dict[str, int] = {
    "1D": 3,
    "1H": 4,
    "65m": 4,
    "15m": 3,
    "5m": 3,
}

FLAT_SLOPE_H_BY_TIMEFRAME: dict[str, tuple[int, str]] = {
    # Sealed Eje 4.2 slope horizons across canonical timeframes.
    "1D": (5, "APPROVED_SPEC"),
    "1H": (10, "APPROVED_SPEC"),
    "65m": (9, "APPROVED_SPEC"),
    "15m": (10, "APPROVED_SPEC"),
    "5m": (10, "APPROVED_SPEC"),
}


class LifecycleConfig(BaseModel):
    """Sealed lifecycle, decay, deduplication, and FSM hysteresis configuration."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    config_version: str = "lifecycle_v2_sealed_2026_11_25"

    # Cohort survival (Prompt #4 §4.1)
    cohort_survival_min: float = Field(default=0.20, gt=0.0, lt=1.0)
    cohort_step_cap: float = Field(default=0.99, gt=0.0, le=0.9999)
    cohort_exempt_families_1w: tuple[str, ...] = ("CALENDAR_YTD", "CALENDAR_QTD", "IPO_DIRECT")

    # Chop saturation (Prompt #4 §4.2)
    chop_neutral_band_atr: float = Field(default=0.20, gt=0.0)
    chop_rolling_window: int = Field(default=12, ge=3)
    chop_required_crosses: int = Field(default=3, ge=1)
    chop_excursion_atr: float = Field(default=1.0, gt=0.0)
    chop_confirmation_window: int = Field(default=3, ge=1)

    # Flat slope (Prompt #4 §4.3)
    flat_slope_abs_max: float = Field(default=0.05, gt=0.0)
    flat_slope_consecutive_bars: int = Field(default=10, ge=1)
    flat_slope_mean_dist_atr_max: float = Field(default=0.50, gt=0.0)

    # Spatial deduplication & PINCH_PAIR (Prompt #4 §4.4 + Prompt #6 §1.3)
    dedup_mean_dist_atr_max: float = Field(default=0.25, gt=0.0)
    dedup_pearson_min: float = Field(default=0.98, gt=0.0, lt=1.0)
    dedup_min_overlap_bars: int = Field(default=20, ge=2)
    confluence_bonus_per_merge: float = Field(default=4.0, ge=0.0)
    confluence_bonus_max: float = Field(default=8.0, ge=0.0)

    pinch_max_dist_atr: float = Field(default=1.25, gt=0.0)
    pinch_confirm_bars: int = Field(default=3, ge=2)
    pinch_breakout_atr: float = Field(default=0.35, gt=0.0)
    pinch_dissolve_dist_atr: float = Field(default=1.75, gt=0.0)
    pinch_outside_dissolve_bars: int = Field(default=2, ge=1)
    pinch_consumes_two_visual_slots: bool = True

    # Sealed FSM hysteresis, resurrection & archival (Eje 4.2)
    tier_1_promote_score: float = 72.0
    tier_1_demote_score: float = 68.0
    tier_2_min_score: float = 45.0
    hysteresis_dwell_bars: int = 2
    resurrection_excursion_atr: float = 1.0
    resurrection_chop_max: int = 2
    resurrection_abs_slope_min: float = 0.08
    archival_dwell_sessions_1d: int = 5
    archival_dwell_sessions_intraday: int = 2
    archival_far_dist_atr: float = 6.0
    archival_far_cohort_max: float = 0.30


@dataclass(frozen=True)
class CohortSurvivalResult:
    s_cohort: tuple[float, ...]
    cumulative_turnover: tuple[float, ...]
    triggered: bool
    trigger_bar_idx: int | None
    exempt_applied: bool
    disabled_reason: str | None


@dataclass(frozen=True)
class ChopCrossEvent:
    cross_detected_at: int
    cross_confirmed_at: int | None
    origin_side: Literal[-1, 1]
    target_side: Literal[-1, 1]
    status: Literal["PENDING", "DISCARDED_EXCURSION", "CONFIRMED"]
    discarded_at: int | None = None


@dataclass(frozen=True)
class ChopEvaluationResult:
    chop_counts: tuple[int, ...]
    events: tuple[ChopCrossEvent, ...]
    triggered: bool
    trigger_bar_idx: int | None


@dataclass(frozen=True)
class FlatSlopeResult:
    s_norm: tuple[float, ...]
    dist_atr: tuple[float, ...]
    triggered: bool
    trigger_bar_idx: int | None
    horizon_h: int
    horizon_status: str
    non_evaluable_bars: int
    flat_active_by_bar: tuple[bool, ...] = ()


@dataclass(frozen=True)
class SpatialMergeRecord:
    keeper_anchor_id: str
    absorbed_anchor_id: str
    merged_at_utc_s: int
    merged_bar_idx: int
    overlap_bars: int
    mean_dist_atr: float
    pearson_r: float
    confluence_bonus_applied: float
    merge_reason: str


@dataclass(frozen=True)
class FsmTransitionRecord:
    anchor_id: str
    previous_state: FsmState
    next_state: FsmState
    transition_reason: str
    effective_ts: int
    available_at_utc_s: int
    score_at_transition: float


@dataclass(frozen=True)
class AnchorSeriesInput:
    """Single anchor trajectory aligned with the asset's canonical RTH bars."""

    anchor_id: str
    family: str
    polarity: Literal["LONG", "SHORT", "NEUTRAL"]
    anchor_idx: int
    activated_idx: int
    anchor_ts: int
    available_at_utc_s: int
    score_original: float
    avwap_series: tuple[float, ...]  # Length == number of asset bars; NaN before anchor_idx
    free_float_at_anchor: float | None = None
    float_is_pit: bool = False
    allow_non_pit_float_sensitivity: bool = False


@dataclass(frozen=True)
class AnchorLifecycleSnapshot:
    anchor_id: str
    state: FsmState
    visible: bool
    hidden_reason: str | None
    score_original: float
    confluence_bonus: float
    score_with_confluence: float
    merged_anchor_ids: tuple[str, ...]
    pinch_partner_id: str | None
    decay_reasons: tuple[str, ...]
    cohort_survival: float
    chop_count: int
    s_norm: float


@dataclass(frozen=True)
class LifecycleSimulationResult:
    timeframe: str
    visual_budget: int
    transitions: tuple[FsmTransitionRecord, ...]
    merges: tuple[SpatialMergeRecord, ...]
    final_snapshots: dict[str, AnchorLifecycleSnapshot]
    snapshots_by_bar: list[dict[str, AnchorLifecycleSnapshot]]


def compute_cohort_survival_series(
    *,
    volumes: Sequence[float],
    anchor_idx: int,
    free_float: float | None,
    family: str,
    timeframe: str,
    float_is_pit: bool,
    allow_non_pit_sensitivity: bool = False,
    split_factor_k_series: Sequence[float] | None = None,
    config: LifecycleConfig | None = None,
) -> CohortSurvivalResult:
    """Compute Grinblatt-Han discrete cohort survival strictly on bars AFTER ``anchor_idx``."""
    cfg = config if config is not None else LifecycleConfig()
    n = len(volumes)
    is_exempt = family.strip().upper() in cfg.cohort_exempt_families_1w and timeframe == "1W"

    if (
        free_float is None
        or isinstance(free_float, bool)
        or not math.isfinite(float(free_float))
        or float(free_float) <= 0.0
    ):
        return CohortSurvivalResult(
            s_cohort=tuple([math.nan] * n),
            cumulative_turnover=tuple([math.nan] * n),
            triggered=False,
            trigger_bar_idx=None,
            exempt_applied=is_exempt,
            disabled_reason="FREE_FLOAT_MISSING_OR_INVALID",
        )

    if not float_is_pit and not allow_non_pit_sensitivity:
        return CohortSurvivalResult(
            s_cohort=tuple([math.nan] * n),
            cumulative_turnover=tuple([math.nan] * n),
            triggered=False,
            trigger_bar_idx=None,
            exempt_applied=is_exempt,
            disabled_reason="FLOAT_NON_PIT_EXCLUDED_CAUSAL_PATH",
        )

    eff_float = float(free_float)
    log_surv = 0.0
    cum_turn = 0.0
    s_out: list[float] = []
    turn_out: list[float] = []
    trig_idx: int | None = None

    for idx in range(n):
        if split_factor_k_series is not None and idx > anchor_idx:
            k_val = float(split_factor_k_series[idx])
            if math.isfinite(k_val) and k_val > 0.0 and k_val != 1.0:
                eff_float /= k_val

        if idx < anchor_idx:
            s_out.append(math.nan)
            turn_out.append(math.nan)
            continue
        if idx == anchor_idx:
            s_out.append(1.0)
            turn_out.append(0.0)
            continue

        vol = float(volumes[idx]) if math.isfinite(float(volumes[idx])) and float(volumes[idx]) >= 0.0 else 0.0
        ratio = vol / eff_float
        cum_turn += ratio
        capped = min(cfg.cohort_step_cap, ratio)
        log_surv += math.log1p(-capped)
        surv = math.exp(log_surv)
        s_out.append(surv)
        turn_out.append(cum_turn)
        if not is_exempt and trig_idx is None and surv < cfg.cohort_survival_min:
            trig_idx = idx

    disabled_note = "FLOAT_NON_PIT_SENSITIVITY_ACTIVE" if (not float_is_pit and allow_non_pit_sensitivity) else None
    return CohortSurvivalResult(
        s_cohort=tuple(s_out),
        cumulative_turnover=tuple(turn_out),
        triggered=trig_idx is not None,
        trigger_bar_idx=trig_idx,
        exempt_applied=is_exempt,
        disabled_reason=disabled_note,
    )


def evaluate_chop_saturation(
    *,
    highs: Sequence[float],
    lows: Sequence[float],
    closes: Sequence[float],
    avwap: Sequence[float],
    atr14: Sequence[float],
    start_idx: int = 0,
    config: LifecycleConfig | None = None,
) -> ChopEvaluationResult:
    """Strictly causal Chop Saturation detector (crosses confirmed only after 3 bars without 1.0 ATR excursion).

    Rolling window convention: counts crosses whose ``cross_confirmed_at`` bar index
    falls in ``[t - (rolling_window - 1), t]``, ensuring invariance under prefix extension
    and consistent semantics across timeframes.
    """
    cfg = config if config is not None else LifecycleConfig()
    n = len(closes)
    last_outside_side: int | None = None  # +1 above band, -1 below band
    pending: list[dict[str, Any]] = []
    confirmed_events: list[ChopCrossEvent] = []
    chop_counts: list[int] = [0] * n
    trig_idx: int | None = None

    for t in range(n):
        if t < start_idx:
            continue
        c = float(closes[t])
        h = float(highs[t])
        l = float(lows[t])
        av = float(avwap[t])
        atr = float(atr14[t])
        if not (math.isfinite(c) and math.isfinite(h) and math.isfinite(l) and math.isfinite(av) and math.isfinite(atr) and atr > 0.0):
            continue

        upper = av + cfg.chop_neutral_band_atr * atr
        lower = av - cfg.chop_neutral_band_atr * atr

        # 1. Update pending crosses using bar t strictly causally
        still_pending: list[dict[str, Any]] = []
        max_exc = max(abs(h - av), abs(l - av)) / atr
        for p in pending:
            if max_exc >= cfg.chop_excursion_atr:
                confirmed_events.append(
                    ChopCrossEvent(
                        cross_detected_at=p["detected_at"],
                        cross_confirmed_at=None,
                        origin_side=p["origin_side"],
                        target_side=p["target_side"],
                        status="DISCARDED_EXCURSION",
                        discarded_at=t,
                    )
                )
                continue
            if t - p["detected_at"] >= cfg.chop_confirmation_window:
                confirmed_events.append(
                    ChopCrossEvent(
                        cross_detected_at=p["detected_at"],
                        cross_confirmed_at=t,
                        origin_side=p["origin_side"],
                        target_side=p["target_side"],
                        status="CONFIRMED",
                    )
                )
                continue
            still_pending.append(p)
        pending = still_pending

        # 2. Check for new full band-to-band cross on close[t]
        cur_side: int | None = 1 if c > upper else (-1 if c < lower else None)
        if cur_side is not None:
            if last_outside_side is not None and cur_side != last_outside_side:
                pending.append(
                    {
                        "detected_at": t,
                        "origin_side": last_outside_side,
                        "target_side": cur_side,
                    }
                )
            last_outside_side = cur_side

        win_lo = t - (cfg.chop_rolling_window - 1)
        cnt = sum(
            1
            for ev in confirmed_events
            if ev.status == "CONFIRMED" and ev.cross_confirmed_at is not None and win_lo <= ev.cross_confirmed_at <= t
        )
        chop_counts[t] = cnt
        if trig_idx is None and cnt >= cfg.chop_required_crosses:
            trig_idx = t

    # Append remaining unresolved pending crosses for complete observability
    for p in pending:
        confirmed_events.append(
            ChopCrossEvent(
                cross_detected_at=p["detected_at"],
                cross_confirmed_at=None,
                origin_side=p["origin_side"],
                target_side=p["target_side"],
                status="PENDING",
            )
        )

    confirmed_events.sort(key=lambda e: (e.cross_detected_at, e.target_side))
    return ChopEvaluationResult(
        chop_counts=tuple(chop_counts),
        events=tuple(confirmed_events),
        triggered=trig_idx is not None,
        trigger_bar_idx=trig_idx,
    )


def evaluate_flat_slope(
    *,
    closes: Sequence[float],
    avwap: Sequence[float],
    atr14: Sequence[float],
    timeframe: str,
    start_idx: int = 0,
    slope_horizon_h: int | None = None,
    config: LifecycleConfig | None = None,
) -> FlatSlopeResult:
    """Evaluate normalized AVWAP slope and proximity over 10 consecutive valid bars."""
    cfg = config if config is not None else LifecycleConfig()
    if slope_horizon_h is not None:
        h = int(slope_horizon_h)
        h_status = "EXPLICIT_OVERRIDE"
    elif timeframe in FLAT_SLOPE_H_BY_TIMEFRAME:
        h, h_status = FLAT_SLOPE_H_BY_TIMEFRAME[timeframe]
    else:
        h, h_status = (10, "APPROVED_SPEC")
    if h < 1:
        raise ValueError(f"slope_horizon_h must be >= 1, got {h}")

    n = len(closes)
    s_norm_out: list[float] = [math.nan] * n
    dist_out: list[float] = [math.nan] * n
    flat_active_out: list[bool] = [False] * n
    trig_idx: int | None = None
    non_eval = 0

    for t in range(n):
        if t < start_idx:
            continue
        c = float(closes[t])
        av_t = float(avwap[t])
        atr_t = float(atr14[t])
        if not (math.isfinite(c) and math.isfinite(av_t) and math.isfinite(atr_t) and atr_t > 0.0):
            non_eval += 1
            continue

        dist_out[t] = abs(c - av_t) / atr_t
        if t - h < start_idx:
            continue
        av_prev = float(avwap[t - h])
        if not math.isfinite(av_prev):
            non_eval += 1
            continue

        sn = (av_t - av_prev) / (float(h) * atr_t)
        s_norm_out[t] = sn

        # Trigger: 10 consecutive bars with valid ATR, |s_norm| < 0.05, and mean dist_atr over those 10 bars < 0.50
        consec = cfg.flat_slope_consecutive_bars
        if t - (consec - 1) >= start_idx:
            win_sn = s_norm_out[t - consec + 1 : t + 1]
            win_d = dist_out[t - consec + 1 : t + 1]
            if (
                all(math.isfinite(x) and abs(x) < cfg.flat_slope_abs_max for x in win_sn)
                and all(math.isfinite(d) for d in win_d)
            ):
                mean_d = math.fsum(win_d) / float(consec)
                if mean_d < cfg.flat_slope_mean_dist_atr_max:
                    flat_active_out[t] = True
                    if trig_idx is None:
                        trig_idx = t

    return FlatSlopeResult(
        s_norm=tuple(s_norm_out),
        dist_atr=tuple(dist_out),
        triggered=trig_idx is not None,
        trigger_bar_idx=trig_idx,
        horizon_h=h,
        horizon_status=h_status,
        non_evaluable_bars=non_eval,
        flat_active_by_bar=tuple(flat_active_out),
    )


def _overlap_stats_causal(
    av_a: Sequence[float],
    av_b: Sequence[float],
    atr: Sequence[float],
    up_to_idx: int,
    start_floor: int,
) -> tuple[int, float, float]:
    """Compute causal overlap count, mean |A - B| / ATR, and Pearson r on bars <= up_to_idx."""
    xs: list[float] = []
    ys: list[float] = []
    dists: list[float] = []
    for u in range(start_floor, up_to_idx + 1):
        va = float(av_a[u])
        vb = float(av_b[u])
        at = float(atr[u])
        if math.isfinite(va) and math.isfinite(vb) and math.isfinite(at) and at > 0.0:
            xs.append(va)
            ys.append(vb)
            dists.append(abs(va - vb) / at)

    m = len(xs)
    if m < 2:
        return m, math.nan, math.nan
    mean_d = math.fsum(dists) / float(m)
    ax = np.asarray(xs, dtype=np.float64)
    ay = np.asarray(ys, dtype=np.float64)
    dx = ax - float(np.mean(ax))
    dy = ay - float(np.mean(ay))
    denom = math.sqrt(float(np.dot(dx, dx)) * float(np.dot(dy, dy)))
    if denom <= 0.0 or not math.isfinite(denom):
        return m, mean_d, math.nan
    r = float(np.dot(dx, dy) / denom)
    return m, mean_d, r


def _visual_budget_for_tf(timeframe: str) -> int:
    if timeframe in VISUAL_BUDGET_BY_TIMEFRAME:
        return VISUAL_BUDGET_BY_TIMEFRAME[timeframe]
    raise ValueError(f"Unsupported timeframe for visual budget: {timeframe!r}")


def run_lifecycle_fsm(
    *,
    timeframe: str,
    bar_ts_utc_s: Sequence[int],
    highs: Sequence[float],
    lows: Sequence[float],
    closes: Sequence[float],
    volumes: Sequence[float],
    atr14: Sequence[float],
    anchors: Sequence[AnchorSeriesInput],
    rvol_z: Sequence[float] | None = None,
    split_factor_k_series: Sequence[float] | None = None,
    slope_horizon_h: int | None = None,
    config: LifecycleConfig | None = None,
) -> LifecycleSimulationResult:
    """Simulate the complete causal multi-anchor lifecycle FSM over canonical bars."""
    cfg = config if config is not None else LifecycleConfig()
    budget = _visual_budget_for_tf(timeframe)
    n_bars = len(bar_ts_utc_s)
    if not (len(highs) == len(lows) == len(closes) == len(volumes) == len(atr14) == n_bars):
        raise ValueError("All bar arrays must have identical length")
    for a in anchors:
        if len(a.avwap_series) != n_bars:
            raise ValueError(f"Anchor {a.anchor_id} avwap_series length != {n_bars}")

    if timeframe in FLAT_SLOPE_H_BY_TIMEFRAME:
        h_slope = slope_horizon_h if slope_horizon_h is not None else FLAT_SLOPE_H_BY_TIMEFRAME[timeframe][0]
    else:
        h_slope = slope_horizon_h if slope_horizon_h is not None else 10

    # Precompute causal decay detectors per anchor (each detector strictly causal at bar t)
    cohort_by_id: dict[str, CohortSurvivalResult] = {}
    chop_by_id: dict[str, ChopEvaluationResult] = {}
    flat_by_id: dict[str, FlatSlopeResult] = {}

    for a in anchors:
        cohort_by_id[a.anchor_id] = compute_cohort_survival_series(
            volumes=volumes,
            anchor_idx=a.anchor_idx,
            free_float=a.free_float_at_anchor,
            family=a.family,
            timeframe=timeframe,
            float_is_pit=a.float_is_pit,
            allow_non_pit_sensitivity=a.allow_non_pit_float_sensitivity,
            split_factor_k_series=split_factor_k_series,
            config=cfg,
        )
        chop_by_id[a.anchor_id] = evaluate_chop_saturation(
            highs=highs,
            lows=lows,
            closes=closes,
            avwap=a.avwap_series,
            atr14=atr14,
            start_idx=a.anchor_idx,
            config=cfg,
        )
        flat_by_id[a.anchor_id] = evaluate_flat_slope(
            closes=closes,
            avwap=a.avwap_series,
            atr14=atr14,
            timeframe=timeframe,
            start_idx=a.anchor_idx,
            slope_horizon_h=h_slope,
            config=cfg,
        )

    # Precompute NumPy views for fast incremental causal spatial deduplication
    atr_np = np.asarray(atr14, dtype=np.float64)
    av_np_by_id: dict[str, np.ndarray] = {
        a.anchor_id: np.asarray(a.avwap_series, dtype=np.float64) for a in anchors
    }
    pair_dist_acc: dict[tuple[str, str], list[Any]] = {}
    sess_limit = (
        cfg.archival_dwell_sessions_1d if timeframe == "1D" else cfg.archival_dwell_sessions_intraday
    )

    # Mutable simulation state per anchor
    sim_state: dict[str, dict[str, Any]] = {}
    for a in sorted(anchors, key=lambda x: (x.anchor_ts, x.anchor_id)):
        sim_state[a.anchor_id] = {
            "spec": a,
            "activated": False,
            "state": "CANDIDATE",
            "merged_ids": [],
            "merged_id_set": set(),
            "bonus": 0.0,
            "pinch_partner": None,
            "pinch_outside_streak": 0,
            "decay_reasons": [],
            "decay_primary_reason": None,
            "decaying_bars": 0,
            "decaying_session_dates": set(),
            "promote_streak": 0,
            "demote_streak": 0,
            "resurrect_streak": 0,
            "chop_last_count": 0,
        }

    transitions: list[FsmTransitionRecord] = []
    merges: list[SpatialMergeRecord] = []
    snapshots_by_bar: list[dict[str, AnchorLifecycleSnapshot]] = []

    def _effective_score(st: dict[str, Any]) -> float:
        return min(100.0, float(st["spec"].score_original) + float(st["bonus"]))

    def _transition(
        st: dict[str, Any],
        next_state: FsmState,
        reason: str,
        ts_bar: int,
    ) -> None:
        prev: FsmState = st["state"]
        if prev == next_state:
            return
        aid = st["spec"].anchor_id
        transitions.append(
            FsmTransitionRecord(
                anchor_id=aid,
                previous_state=prev,
                next_state=next_state,
                transition_reason=reason,
                effective_ts=ts_bar,
                available_at_utc_s=max(ts_bar, int(st["spec"].available_at_utc_s)),
                score_at_transition=_effective_score(st),
            )
        )
        st["state"] = next_state
        st["promote_streak"] = 0
        st["demote_streak"] = 0
        st["resurrect_streak"] = 0
        if next_state == "DECAYING":
            st["decaying_bars"] = 0
            st["decaying_session_dates"] = set()
        elif next_state in ("ACTIVE_PRIMARY", "ACTIVE_SECONDARY"):
            st["decay_primary_reason"] = None
            st["decay_reasons"] = []

    sorted_ids = [a.anchor_id for a in sorted(anchors, key=lambda x: (x.anchor_ts, x.anchor_id))]

    for t in range(n_bars):
        ts_bar = int(bar_ts_utc_s[t])
        bar_et_date = dt.datetime.fromtimestamp(ts_bar, ET_TZ).date().isoformat()
        c_t = float(closes[t])
        atr_t = float(atr14[t])
        _ = rvol_z  # Preserved in signature for interface compatibility

        # 1. Activation of anchors whose causal activated_idx == t
        for aid in sorted_ids:
            st = sim_state[aid]
            spec: AnchorSeriesInput = st["spec"]
            if not st["activated"] and t >= spec.activated_idx:
                st["activated"] = True
                eff_sc = _effective_score(st)
                if eff_sc >= 70.0:
                    _transition(st, "ACTIVE_PRIMARY", "ACTIVATION_TIER_1", ts_bar)
                elif eff_sc >= cfg.tier_2_min_score:
                    _transition(st, "ACTIVE_SECONDARY", "ACTIVATION_TIER_2", ts_bar)

        # 2. Check decay triggers & resurrections for already activated non-ARCHIVED anchors
        for aid in sorted_ids:
            st = sim_state[aid]
            if not st["activated"] or st["state"] == "ARCHIVED":
                continue

            cohort_r = cohort_by_id[aid]
            chop_r = chop_by_id[aid]
            flat_r = flat_by_id[aid]

            coh_hit = cohort_r.triggered and cohort_r.trigger_bar_idx is not None and t >= cohort_r.trigger_bar_idx
            chop_hit = chop_r.chop_counts[t] >= cfg.chop_required_crosses and chop_r.chop_counts[t] > st["chop_last_count"]
            st["chop_last_count"] = chop_r.chop_counts[t]
            if chop_r.chop_counts[t] >= cfg.chop_required_crosses and st["state"] in ("ACTIVE_PRIMARY", "ACTIVE_SECONDARY", "PINCH_PAIR"):
                chop_hit = True
            flat_hit = bool(flat_r.flat_active_by_bar[t]) if t < len(flat_r.flat_active_by_bar) else False

            sim_reasons: list[str] = []
            if coh_hit:
                sim_reasons.append("COHORT_DECAY")
            if chop_hit:
                sim_reasons.append("CHOP_SATURATION")
            if flat_hit:
                sim_reasons.append("FLAT_SLOPE")

            if st["state"] in ("ACTIVE_PRIMARY", "ACTIVE_SECONDARY", "PINCH_PAIR"):
                if sim_reasons:
                    # Dissolve pinch partner cleanly if entering DECAYING
                    partner_id = st["pinch_partner"]
                    if partner_id is not None and partner_id in sim_state:
                        pst = sim_state[partner_id]
                        pst["pinch_partner"] = None
                        if pst["state"] == "PINCH_PAIR":
                            p_next: FsmState = "ACTIVE_PRIMARY" if _effective_score(pst) >= 70.0 else "ACTIVE_SECONDARY"
                            _transition(pst, p_next, "PINCH_PARTNER_DECAYED", ts_bar)
                        st["pinch_partner"] = None

                    primary_r = sim_reasons[0]  # Priority: COHORT_DECAY > CHOP_SATURATION > FLAT_SLOPE
                    st["decay_primary_reason"] = primary_r
                    st["decay_reasons"] = list(sim_reasons)
                    _transition(st, "DECAYING", primary_r, ts_bar)
                    st["decaying_session_dates"].add(bar_et_date)
                elif st["state"] in ("ACTIVE_PRIMARY", "ACTIVE_SECONDARY"):
                    eff_sc = _effective_score(st)
                    if st["state"] == "ACTIVE_SECONDARY":
                        if eff_sc >= cfg.tier_1_promote_score:
                            st["promote_streak"] += 1
                            if st["promote_streak"] >= cfg.hysteresis_dwell_bars:
                                _transition(st, "ACTIVE_PRIMARY", "SCORE_HYSTERESIS_PROMOTION", ts_bar)
                        else:
                            st["promote_streak"] = 0
                    else:
                        if eff_sc < cfg.tier_1_demote_score:
                            st["demote_streak"] += 1
                            if st["demote_streak"] >= cfg.hysteresis_dwell_bars:
                                _transition(st, "ACTIVE_SECONDARY", "SCORE_HYSTERESIS_DEMOTION", ts_bar)
                        else:
                            st["demote_streak"] = 0

            elif st["state"] == "DECAYING":
                st["decaying_bars"] += 1
                st["decaying_session_dates"].add(bar_et_date)
                is_cohort = st["decay_primary_reason"] == "COHORT_DECAY"
                av_t = float(st["spec"].avwap_series[t])
                coh_s_t = float(cohort_r.s_cohort[t])
                sn_t = flat_r.s_norm[t]

                # Immediate far-distance + exhausted-cohort archival on 1D
                if (
                    timeframe == "1D"
                    and math.isfinite(av_t)
                    and math.isfinite(c_t)
                    and math.isfinite(atr_t)
                    and atr_t > 0.0
                    and (abs(c_t - av_t) / atr_t) > cfg.archival_far_dist_atr
                    and math.isfinite(coh_s_t)
                    and coh_s_t < cfg.archival_far_cohort_max
                ):
                    _transition(st, "ARCHIVED", "ARCHIVED_FAR_DIST_LOW_COHORT", ts_bar)
                    continue

                # Check resurrection ONLY when not structural cohort exhaustion
                can_resurrect = (
                    not is_cohort
                    and not sim_reasons
                    and chop_r.chop_counts[t] < cfg.resurrection_chop_max
                    and math.isfinite(av_t)
                    and math.isfinite(c_t)
                    and math.isfinite(atr_t)
                    and atr_t > 0.0
                    and (abs(c_t - av_t) / atr_t) >= cfg.resurrection_excursion_atr
                    and (math.isfinite(sn_t) and abs(sn_t) >= cfg.resurrection_abs_slope_min)
                )
                if can_resurrect:
                    st["resurrect_streak"] += 1
                    if st["resurrect_streak"] >= cfg.hysteresis_dwell_bars:
                        _transition(st, "ACTIVE_SECONDARY", "BREAKOUT_RESURRECTION", ts_bar)
                        continue
                else:
                    st["resurrect_streak"] = 0

                if len(st["decaying_session_dates"]) >= sess_limit:
                    arch_reason = "ARCHIVED_COHORT_DECAY" if is_cohort else "ARCHIVED_DECAY_TIMEOUT"
                    _transition(st, "ARCHIVED", arch_reason, ts_bar)

        # 3. PINCH_PAIR maintenance, breakout & passive dissolution (MUST run BEFORE spatial deduplication)
        active_for_pinch = [
            aid for aid in sorted_ids if sim_state[aid]["state"] in ("PINCH_PAIR", "ACTIVE_PRIMARY", "ACTIVE_SECONDARY")
        ]
        checked_pairs: set[tuple[str, str]] = set()
        for aid in active_for_pinch:
            st = sim_state[aid]
            pid = st["pinch_partner"]
            if pid is None or st["state"] != "PINCH_PAIR":
                continue
            pair_key = (min(aid, pid), max(aid, pid))
            if pair_key in checked_pairs:
                continue
            checked_pairs.add(pair_key)
            pst = sim_state[pid]
            va = float(st["spec"].avwap_series[t])
            vb = float(pst["spec"].avwap_series[t])
            if not (math.isfinite(va) and math.isfinite(vb) and math.isfinite(atr_t) and atr_t > 0.0 and math.isfinite(c_t)):
                continue
            dist_atr = abs(va - vb) / atr_t
            lo_c, hi_c = min(va, vb), max(va, vb)

            bull_bo = c_t > hi_c + cfg.pinch_breakout_atr * atr_t
            bear_bo = c_t < lo_c - cfg.pinch_breakout_atr * atr_t
            if bull_bo or bear_bo:
                st["pinch_partner"] = None
                pst["pinch_partner"] = None
                win_pol: Literal["LONG", "SHORT"] = "LONG" if bull_bo else "SHORT"
                winner = st if st["spec"].polarity == win_pol else pst
                loser = pst if winner is st else st
                _transition(winner, "ACTIVE_PRIMARY", "PINCH_BREAKOUT", ts_bar)
                if _effective_score(loser) >= 70.0:
                    _transition(loser, "ACTIVE_SECONDARY", "PINCH_BREAKOUT_OPPOSITE", ts_bar)
                else:
                    loser["decay_primary_reason"] = "PINCH_BREAKOUT_OPPOSITE"
                    loser["decay_reasons"] = ["PINCH_BREAKOUT_OPPOSITE"]
                    _transition(loser, "DECAYING", "PINCH_BREAKOUT_OPPOSITE", ts_bar)
                    loser["decaying_session_dates"].add(bar_et_date)
                continue

            inside = lo_c <= c_t <= hi_c
            if inside:
                st["pinch_outside_streak"] = 0
                pst["pinch_outside_streak"] = 0
            else:
                st["pinch_outside_streak"] += 1
                pst["pinch_outside_streak"] += 1
            if dist_atr > cfg.pinch_dissolve_dist_atr or st["pinch_outside_streak"] >= cfg.pinch_outside_dissolve_bars:
                st["pinch_partner"] = None
                pst["pinch_partner"] = None
                for leg in (st, pst):
                    nxt: FsmState = "ACTIVE_PRIMARY" if _effective_score(leg) >= 70.0 else "ACTIVE_SECONDARY"
                    _transition(leg, nxt, "PINCH_CORRIDOR_DISSOLVED", ts_bar)

        # Detect new PINCH_PAIR formation among unpaired active anchors of opposite polarity
        unpaired = [
            aid
            for aid in sorted_ids
            if sim_state[aid]["state"] in ("ACTIVE_PRIMARY", "ACTIVE_SECONDARY")
            and sim_state[aid]["pinch_partner"] is None
            and sim_state[aid]["spec"].polarity in ("LONG", "SHORT")
        ]
        # Prioritize highest-score pair
        cand_pairs: list[tuple[float, str, str]] = []
        k_req = cfg.pinch_confirm_bars
        for i in range(len(unpaired)):
            a1 = sim_state[unpaired[i]]
            for j in range(i + 1, len(unpaired)):
                a2 = sim_state[unpaired[j]]
                if a1["spec"].polarity == a2["spec"].polarity:
                    continue
                if t < max(a1["spec"].activated_idx, a2["spec"].activated_idx) + (k_req - 1):
                    continue
                dists_w: list[float] = []
                valid_w = True
                for u in range(t - k_req + 1, t + 1):
                    va = float(a1["spec"].avwap_series[u])
                    vb = float(a2["spec"].avwap_series[u])
                    at_u = float(atr14[u])
                    c_u = float(closes[u])
                    if not (math.isfinite(va) and math.isfinite(vb) and math.isfinite(at_u) and at_u > 0.0 and math.isfinite(c_u)):
                        valid_w = False
                        break
                    if not (min(va, vb) <= c_u <= max(va, vb)):
                        valid_w = False
                        break
                    dists_w.append(abs(va - vb) / at_u)
                if not valid_w:
                    continue
                if dists_w[-1] <= cfg.pinch_max_dist_atr and all(
                    dists_w[idx + 1] < dists_w[idx] for idx in range(len(dists_w) - 1)
                ):
                    pair_score = _effective_score(a1) + _effective_score(a2)
                    cand_pairs.append((-pair_score, a1["spec"].anchor_id, a2["spec"].anchor_id))

        cand_pairs.sort()
        paired_now: set[str] = set()
        for _, id1, id2 in cand_pairs:
            if id1 in paired_now or id2 in paired_now:
                continue
            s1, s2 = sim_state[id1], sim_state[id2]
            if s1["pinch_partner"] is not None or s2["pinch_partner"] is not None:
                continue
            s1["pinch_partner"] = id2
            s2["pinch_partner"] = id1
            s1["pinch_outside_streak"] = 0
            s2["pinch_outside_streak"] = 0
            paired_now.update((id1, id2))
            _transition(s1, "PINCH_PAIR", f"PINCH_FORMED_WITH:{id2}", ts_bar)
            _transition(s2, "PINCH_PAIR", f"PINCH_FORMED_WITH:{id1}", ts_bar)

        # 4. Spatial Deduplication (same polarity, never touches PINCH_PAIRs)
        dedup_cands = [
            aid
            for aid in sorted_ids
            if sim_state[aid]["state"] in ("ACTIVE_PRIMARY", "ACTIVE_SECONDARY")
            and sim_state[aid]["pinch_partner"] is None
            and sim_state[aid]["spec"].polarity in ("LONG", "SHORT")
        ]
        # Process highest-priority keepers first deterministically
        dedup_cands.sort(
            key=lambda x: (
                -float(sim_state[x]["spec"].score_original),
                int(sim_state[x]["spec"].anchor_ts),
                str(x),
            )
        )
        absorbed_now: set[str] = set()
        for i, keep_id in enumerate(dedup_cands):
            if keep_id in absorbed_now or sim_state[keep_id]["state"] == "ARCHIVED":
                continue
            keep_st = sim_state[keep_id]
            for other_id in dedup_cands[i + 1 :]:
                if other_id in absorbed_now or sim_state[other_id]["state"] == "ARCHIVED":
                    continue
                other_st = sim_state[other_id]
                if keep_st["spec"].polarity != other_st["spec"].polarity:
                    continue
                start_ov = max(keep_st["spec"].anchor_idx, other_st["spec"].anchor_idx)
                pk = (keep_id, other_id)
                acc = pair_dist_acc.get(pk)
                ka = av_np_by_id[keep_id]
                oa = av_np_by_id[other_id]
                if acc is None:
                    sl_k = ka[start_ov : t + 1]
                    sl_o = oa[start_ov : t + 1]
                    sl_a = atr_np[start_ov : t + 1]
                    mask = np.isfinite(sl_k) & np.isfinite(sl_o) & np.isfinite(sl_a) & (sl_a > 0.0)
                    m_ov = int(np.count_nonzero(mask))
                    dist_sum = float(np.sum(np.abs(sl_k[mask] - sl_o[mask]) / sl_a[mask])) if m_ov > 0 else 0.0
                    acc = [t, m_ov, dist_sum]
                    pair_dist_acc[pk] = acc
                else:
                    last_t = int(acc[0])
                    for uu in range(last_t + 1, t + 1):
                        va = float(ka[uu])
                        vb = float(oa[uu])
                        at = float(atr_np[uu])
                        if math.isfinite(va) and math.isfinite(vb) and math.isfinite(at) and at > 0.0:
                            acc[1] += 1
                            acc[2] += abs(va - vb) / at
                    acc[0] = t
                    m_ov = int(acc[1])
                    dist_sum = float(acc[2])

                mean_d = (dist_sum / float(m_ov)) if m_ov >= 2 else math.nan
                pearson_r = math.nan
                if m_ov >= cfg.dedup_min_overlap_bars and math.isfinite(mean_d) and mean_d < cfg.dedup_mean_dist_atr_max:
                    sl_k = ka[start_ov : t + 1]
                    sl_o = oa[start_ov : t + 1]
                    sl_a = atr_np[start_ov : t + 1]
                    mask = np.isfinite(sl_k) & np.isfinite(sl_o) & np.isfinite(sl_a) & (sl_a > 0.0)
                    xs = sl_k[mask]
                    ys = sl_o[mask]
                    dx = xs - float(np.mean(xs))
                    dy = ys - float(np.mean(ys))
                    denom = math.sqrt(float(np.dot(dx, dx)) * float(np.dot(dy, dy)))
                    if denom > 0.0 and math.isfinite(denom):
                        pearson_r = float(np.dot(dx, dy) / denom)

                if (
                    m_ov >= cfg.dedup_min_overlap_bars
                    and math.isfinite(mean_d)
                    and mean_d < cfg.dedup_mean_dist_atr_max
                    and math.isfinite(pearson_r)
                    and pearson_r > cfg.dedup_pearson_min
                ):
                    absorbed_now.add(other_id)
                    bonus_delta = 0.0
                    # Idempotent confluence bonus by unique absorbed anchor ID
                    if other_id not in keep_st["merged_id_set"]:
                        keep_st["merged_id_set"].add(other_id)
                        keep_st["merged_ids"].append(other_id)
                        new_bonus = min(
                            cfg.confluence_bonus_max,
                            float(len(keep_st["merged_id_set"])) * cfg.confluence_bonus_per_merge,
                        )
                        bonus_delta = max(0.0, new_bonus - keep_st["bonus"])
                        keep_st["bonus"] = new_bonus
                    merges.append(
                        SpatialMergeRecord(
                            keeper_anchor_id=keep_id,
                            absorbed_anchor_id=other_id,
                            merged_at_utc_s=ts_bar,
                            merged_bar_idx=t,
                            overlap_bars=m_ov,
                            mean_dist_atr=mean_d,
                            pearson_r=pearson_r,
                            confluence_bonus_applied=bonus_delta,
                            merge_reason="SPATIAL_CONFLUENCE_ABSORBED",
                        )
                    )
                    _transition(other_st, "ARCHIVED", f"SPATIAL_CONFLUENCE_ABSORBED_BY:{keep_id}", ts_bar)
                    # Check if bonus pushed keeper above TIER_1 threshold
                    if keep_st["state"] == "ACTIVE_SECONDARY" and _effective_score(keep_st) >= 70.0:
                        _transition(keep_st, "ACTIVE_PRIMARY", "CONFLUENCE_BONUS_PROMOTION", ts_bar)

        # 5. Enforce Hard Visual Budget at bar t WITHOUT mutating FSM state
        visible_ids: set[str] = set()
        hidden_reason_by_id: dict[str, str] = {}
        slots_used = 0

        # Allocate PINCH_PAIRs first as atomic 2-slot units (when pinch_consumes_two_visual_slots=True)
        seen_p: set[str] = set()
        pinch_units: list[tuple[float, str, str]] = []
        for aid in sorted_ids:
            st = sim_state[aid]
            if st["state"] == "PINCH_PAIR" and st["pinch_partner"] and aid not in seen_p:
                pid = st["pinch_partner"]
                seen_p.update((aid, pid))
                top_sc = max(_effective_score(st), _effective_score(sim_state[pid]))
                pinch_units.append((-top_sc, min(aid, pid), max(aid, pid)))
        pinch_units.sort()
        unit_cost = 2 if cfg.pinch_consumes_two_visual_slots else 1
        for _, u1, u2 in pinch_units:
            if slots_used + unit_cost <= budget:
                visible_ids.update((u1, u2))
                slots_used += unit_cost
            else:
                hidden_reason_by_id[u1] = "VISUAL_BUDGET_EXCEEDED_PINCH_SLOTS"
                hidden_reason_by_id[u2] = "VISUAL_BUDGET_EXCEEDED_PINCH_SLOTS"

        singles = [
            aid for aid in sorted_ids if sim_state[aid]["state"] in ("ACTIVE_PRIMARY", "ACTIVE_SECONDARY")
        ]
        singles.sort(
            key=lambda x: (
                0 if sim_state[x]["state"] == "ACTIVE_PRIMARY" else 1,
                -_effective_score(sim_state[x]),
                int(sim_state[x]["spec"].anchor_ts),
                str(x),
            )
        )
        for aid in singles:
            if slots_used < budget:
                visible_ids.add(aid)
                slots_used += 1
            else:
                hidden_reason_by_id[aid] = "VISUAL_BUDGET_EXCEEDED"

        bar_snap: dict[str, AnchorLifecycleSnapshot] = {}
        for aid in sorted_ids:
            st = sim_state[aid]
            coh_s = cohort_by_id[aid].s_cohort[t]
            chop_c = chop_by_id[aid].chop_counts[t]
            sn_t = flat_by_id[aid].s_norm[t]
            eff_sc = _effective_score(st)
            vis = aid in visible_ids
            h_reason = hidden_reason_by_id.get(aid) if not vis else None
            bar_snap[aid] = AnchorLifecycleSnapshot(
                anchor_id=aid,
                state=st["state"],
                visible=vis,
                hidden_reason=h_reason,
                score_original=float(st["spec"].score_original),
                confluence_bonus=float(st["bonus"]),
                score_with_confluence=eff_sc,
                merged_anchor_ids=tuple(st["merged_ids"]),
                pinch_partner_id=st["pinch_partner"],
                decay_reasons=tuple(st["decay_reasons"]),
                cohort_survival=coh_s,
                chop_count=chop_c,
                s_norm=sn_t,
            )
        snapshots_by_bar.append(bar_snap)

    final_snaps = snapshots_by_bar[-1] if snapshots_by_bar else {}
    return LifecycleSimulationResult(
        timeframe=timeframe,
        visual_budget=budget,
        transitions=tuple(transitions),
        merges=tuple(merges),
        final_snapshots=final_snaps,
        snapshots_by_bar=snapshots_by_bar,
    )
