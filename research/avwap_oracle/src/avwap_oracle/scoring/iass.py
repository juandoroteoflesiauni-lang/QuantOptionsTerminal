"""Deterministic Institutional Anchor Significance Score (IASS) engine.

Pure mathematical scoring with explicit feature provenance, causal availability checks,
non-PIT exclusion flags, conservative prior shrinkage (toward 35.0), and versioned
configuration frozen before dry-run evaluation.
"""

from __future__ import annotations

import math
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from scipy.special import ndtr

FAMILY_PRIOR_REGISTRY: dict[str, tuple[float, str, str]] = {
    # (prior, spec_status, note)
    "IPO_DIRECT": (0.90, "APPROVED_SPEC", "Direct listing / IPO primary day"),
    "INDEX_REBAL": (0.80, "APPROVED_SPEC", "Verified index constituent addition/removal"),
    "SECONDARY_OFFERING": (0.75, "APPROVED_SPEC", "Confirmed executed offering (never bare S-3 shelf)"),
    "EARNINGS_BLOWOUT": (0.70, "APPROVED_SPEC", "Confirmed earnings move >= 1.25x ex-ante implied"),
    "EARNINGS_INLINE": (0.70, "APPROVED_SPEC", "Negative control: earnings move < 0.75x ex-ante implied"),
    "POST_OPEX": (0.65, "APPROVED_SPEC", "First session post OpEx with expiring_gex_share >= 0.25"),
    "CALENDAR_YTD": (0.65, "APPROVED_SPEC", "First RTH session of calendar year"),
    "CALENDAR_QTD": (0.65, "APPROVED_SPEC", "First RTH session of calendar quarter"),
    "MACRO_EVENT": (0.60, "APPROVED_SPEC", "US Tier-1 macro release"),
    "MACRO_SHOCK": (0.60, "APPROVED_MAPPED_FROM_MACRO_EVENT", "US_ETF >= 2023 macro surprise/WHAM shock"),
    "CALENDAR_MTD": (0.40, "APPROVED_SPEC", "First RTH session of calendar month"),
    "CALENDAR_WTD": (0.40, "APPROVED_SPEC", "First RTH session of calendar week"),
    "STRUCTURAL": (0.25, "APPROVED_SPEC", "Generic technical structural anchor"),
    "VOLUME_CLIMAX": (0.25, "APPROVED_MAPPED_FROM_STRUCTURAL", "Causal OHLCV range >= 1.8*ATR + extreme close"),
    "BREAKAWAY_GAP": (0.25, "APPROVED_MAPPED_FROM_STRUCTURAL", "Causal session gap >= 1.8*ATR + extreme close"),
    "SWING_CAUSAL": (0.25, "APPROVED_MAPPED_FROM_STRUCTURAL", "Causal swing ATR 2.0, k_min=2, anchor_rvol_z >= 1.5"),
    "SWING_NO_RVOL": (0.25, "APPROVED_MAPPED_FROM_STRUCTURAL", "Negative control: swing without RVOL confirmation"),
    "OPTIONS_FLOW_SHOCK": (0.35, "APPROVED_SPEC", "Unusual OPRA OI/Vol shock; sealed neutral prior"),
    "EX_DIVIDEND_REGULAR": (0.15, "APPROVED_SPEC", "Negative control: recurring dividend < 1.5% prev close"),
}


class IassConfig(BaseModel):
    """Frozen, validated IASS weights, thresholds, and priors."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    config_version: str = "iass_v2_sealed_2026_11_25"
    weight_M: float = Field(default=0.30, ge=0.0, le=1.0)
    weight_D: float = Field(default=0.30, ge=0.0, le=1.0)
    weight_F: float = Field(default=0.20, ge=0.0, le=1.0)
    weight_S: float = Field(default=0.20, ge=0.0, le=1.0)

    degradation_prior: float = Field(default=35.0, ge=0.0, le=100.0)
    tier_1_min: float = Field(default=70.0, ge=0.0, le=100.0)
    tier_2_min: float = Field(default=45.0, ge=0.0, le=100.0)

    # Subcomponent scales specified in Prompt #4
    float_turnover_scale: float = Field(default=0.03, gt=0.0)
    d_move_logistic_k: float = Field(default=2.5, gt=0.0)
    d_shock_scale: float = Field(default=2.0, gt=0.0)
    s_gap_scale: float = Field(default=1.5, gt=0.0)
    s_disp_scale: float = Field(default=2.0, gt=0.0)

    # Sealed sub-weights (summing strictly to 1.00 within each pillar)
    m_subweights: dict[str, float] = Field(
        default_factory=lambda: {"M_rvol": 0.50, "M_float": 0.30, "M_auction": 0.20}
    )
    d_subweights: dict[str, float] = Field(
        default_factory=lambda: {"D_move": 0.45, "D_shock": 0.25, "D_iv": 0.20, "D_term": 0.10}
    )
    s_subweights: dict[str, float] = Field(
        default_factory=lambda: {"S_gap": 0.50, "S_disp": 0.50}
    )

    surprise_floor: float = Field(default=0.05, gt=0.0)
    surprise_tanh_scale: float = Field(default=0.50, gt=0.0)
    surprise_blend_weight: float = Field(default=0.20, ge=0.0, le=1.0)

    @model_validator(mode="after")
    def _validate_weights(self) -> IassConfig:
        total = self.weight_M + self.weight_D + self.weight_F + self.weight_S
        if abs(total - 1.0) > 1e-9:
            raise ValueError(
                f"Base pillar weights must sum to 1.0 within 1e-9, got {total:.12f}"
            )
        if self.tier_2_min >= self.tier_1_min:
            raise ValueError("tier_2_min must be strictly less than tier_1_min")
        for group_name, weights in (
            ("m_subweights", self.m_subweights),
            ("d_subweights", self.d_subweights),
            ("s_subweights", self.s_subweights),
        ):
            for k, v in weights.items():
                if not (math.isfinite(v) and v >= 0.0):
                    raise ValueError(f"{group_name}[{k!r}] must be finite >= 0, got {v!r}")
        if abs(sum(self.m_subweights.values()) - 1.0) > 1e-9:
            raise ValueError("m_subweights must sum to 1.0")
        if abs(sum(self.d_subweights.values()) - 1.0) > 1e-9:
            raise ValueError("d_subweights must sum to 1.0")
        if abs(sum(self.s_subweights.values()) - 1.0) > 1e-9:
            raise ValueError("s_subweights must sum to 1.0")
        return self


class IassFeatures(BaseModel):
    """Input feature vector with explicit point-in-time availability timestamps."""

    model_config = ConfigDict(extra="forbid")

    family: str
    polarity: Literal["LONG", "SHORT", "NEUTRAL"] = "LONG"
    feature_asof: int

    # Derivatives coverage & provenance
    orats_opra_covered: bool = True
    oi_source: str | None = None

    # Pillar M — Participation & Liquidity
    rvol_z: float | None = None
    float_turnover_pct: float | None = None
    float_is_pit: bool = False
    float_asof_utc_s: int | None = None
    allow_non_pit_float_sensitivity: bool = False
    auction_ratio_z: float | None = None

    # Pillar D — Derivatives Repricing
    realized_return: float | None = None
    realized_return_start_ts_utc_s: int | None = None
    implied_move_dec: float | None = None
    implied_move_available_at_utc_s: int | None = None
    oi_gex_shock: float | None = None
    iv_change_z: float | None = None
    term_transition_score: float | None = None

    # Pillar F — Catalyst & Mandate
    catalyst_data_available: bool = True
    actual_value: float | None = None
    estimated_value: float | None = None
    surprise_is_pit_verified: bool = False
    surprise_available_at_utc_s: int | None = None

    # Pillar S — Structural Displacement
    gap_atr: float | None = None
    close_disp_atr: float | None = None
    atr_valid: bool = True
    atr_available_at_utc_s: int | None = None


class IassBreakdown(BaseModel):
    """Auditable IASS output with full coverage, components, shrinkage, and degradation log."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    family: str
    polarity: Literal["LONG", "SHORT", "NEUTRAL"]
    pillar_scores: dict[str, float | None]
    component_scores: dict[str, float | None]
    data_coverage: float
    component_coverage: dict[str, float]
    score_renormalized: float | None
    score_conservative: float
    tier: Literal["TIER_1", "TIER_2", "NOISE", "INSUFFICIENT_DATA"]
    status: Literal["OK", "PARTIAL_COVERAGE", "INSUFFICIENT_DATA"]
    degradation_reasons: tuple[str, ...]
    feature_asof: int
    config_version: str


def _norm_cdf(x: float) -> float:
    return float(ndtr(x))


def _is_valid_num(x: float | None) -> bool:
    return x is not None and not isinstance(x, bool) and math.isfinite(float(x))


def _renormalized_pillar(
    sub_values: dict[str, float | None],
    sub_weights: dict[str, float],
) -> tuple[float | None, float]:
    num = 0.0
    den = 0.0
    for name, val in sub_values.items():
        w = float(sub_weights.get(name, 0.0))
        if val is not None and math.isfinite(val) and w > 0.0:
            num += w * float(val)
            den += w
    if den <= 0.0:
        return None, 0.0
    total_possible = sum(sub_weights.get(name, 0.0) for name in sub_values.keys())
    cov = min(1.0, den / total_possible) if total_possible > 0.0 else 1.0
    return max(0.0, min(1.0, num / den)), cov


def classify_iass_tier(
    score_conservative: float,
    data_coverage: float,
    config: IassConfig,
) -> Literal["TIER_1", "TIER_2", "NOISE", "INSUFFICIENT_DATA"]:
    """Classify strictly on unrounded ``score_conservative`` and coverage."""
    if data_coverage <= 0.0 or not math.isfinite(score_conservative):
        return "INSUFFICIENT_DATA"
    if score_conservative >= config.tier_1_min:
        return "TIER_1"
    if score_conservative >= config.tier_2_min:
        return "TIER_2"
    return "NOISE"


def compute_iass(
    features: IassFeatures,
    config: IassConfig | None = None,
) -> IassBreakdown:
    """Compute pure deterministic IASS breakdown from verified point-in-time features."""
    cfg = config if config is not None else IassConfig()
    reasons: list[str] = []
    comp_scores: dict[str, float | None] = {}
    comp_cov: dict[str, float] = {}

    # ------------------------------------------------------------------
    # Pillar M: Participation & Liquidity
    # ------------------------------------------------------------------
    m_rvol: float | None = None
    if _is_valid_num(features.rvol_z):
        m_rvol = _norm_cdf(float(features.rvol_z))  # type: ignore[arg-type]

    m_float: float | None = None
    if _is_valid_num(features.float_turnover_pct) and float(features.float_turnover_pct) >= 0.0:  # type: ignore[arg-type]
        float_pit_ok = features.float_is_pit and (
            features.float_asof_utc_s is None or features.float_asof_utc_s <= features.feature_asof
        )
        if float_pit_ok:
            m_float = 1.0 - math.exp(-float(features.float_turnover_pct) / cfg.float_turnover_scale)  # type: ignore[arg-type]
        elif features.allow_non_pit_float_sensitivity:
            reasons.append("FLOAT_NON_PIT_SNAPSHOT")
            reasons.append("FLOAT_NON_PIT_SENSITIVITY_ENABLED")
            m_float = 1.0 - math.exp(-float(features.float_turnover_pct) / cfg.float_turnover_scale)  # type: ignore[arg-type]
        else:
            reasons.append("FLOAT_NON_PIT_SNAPSHOT")

    m_auction: float | None = None
    if _is_valid_num(features.auction_ratio_z):
        m_auction = _norm_cdf(float(features.auction_ratio_z))  # type: ignore[arg-type]

    m_vals = {"M_rvol": m_rvol, "M_float": m_float, "M_auction": m_auction}
    p_M, cov_M = _renormalized_pillar(m_vals, cfg.m_subweights)
    comp_scores.update(m_vals)
    comp_cov["M"] = cov_M

    # ------------------------------------------------------------------
    # Pillar D: Derivatives Repricing
    # ------------------------------------------------------------------
    d_move: float | None = None
    d_shock: float | None = None
    d_iv: float | None = None
    d_term: float | None = None

    if not features.orats_opra_covered:
        p_D = None
        cov_D = 0.0
        reasons.append("MISSING_ORATS_OPRA_COVERAGE")
    else:
        if features.oi_source == "MASSIVE_FALLBACK":
            reasons.append("ORATS_OI_FALLBACK_MASSIVE")

        if (
            _is_valid_num(features.realized_return)
            and _is_valid_num(features.implied_move_dec)
            and float(features.implied_move_dec) > 0.0  # type: ignore[arg-type]
        ):
            # Enforce ex-ante implied move before the realized return started
            imp_avail = features.implied_move_available_at_utc_s
            ret_start = features.realized_return_start_ts_utc_s
            if imp_avail is not None and ret_start is not None and imp_avail > ret_start:
                reasons.append("IMPLIED_MOVE_NOT_EX_ANTE_EXCLUDED")
            elif imp_avail is not None and imp_avail > features.feature_asof:
                reasons.append("IMPLIED_MOVE_FUTURE_EXCLUDED")
            else:
                ratio = abs(float(features.realized_return)) / float(features.implied_move_dec)  # type: ignore[arg-type]
                exponent = max(-60.0, min(60.0, -cfg.d_move_logistic_k * (ratio - 1.0)))
                d_move = 1.0 / (1.0 + math.exp(exponent))

        if _is_valid_num(features.oi_gex_shock):
            d_shock = 1.0 - math.exp(-max(0.0, float(features.oi_gex_shock)) / cfg.d_shock_scale)  # type: ignore[arg-type]

        if _is_valid_num(features.iv_change_z):
            d_iv = _norm_cdf(float(features.iv_change_z))  # type: ignore[arg-type]

        if _is_valid_num(features.term_transition_score):
            val_t = float(features.term_transition_score)  # type: ignore[arg-type]
            if 0.0 <= val_t <= 1.0:
                d_term = val_t
            else:
                reasons.append("INVALID_D_TERM_OUT_OF_UNIT_RANGE")

        d_vals: dict[str, float | None] = {"D_move": d_move, "D_shock": d_shock, "D_iv": d_iv}
        d_weights = {
            k: cfg.d_subweights[k]
            for k in ("D_move", "D_shock", "D_iv")
            if k in cfg.d_subweights
        }
        if d_term is not None:
            d_vals["D_term"] = d_term
            d_weights["D_term"] = cfg.d_subweights.get("D_term", 0.10)
        p_D, cov_D = _renormalized_pillar(d_vals, d_weights)
        if p_D is None:
            reasons.append("PILLAR_D_NO_VALID_SUBCOMPONENTS")

    comp_scores.update({"D_move": d_move, "D_shock": d_shock, "D_iv": d_iv, "D_term": d_term})
    comp_cov["D"] = cov_D

    # ------------------------------------------------------------------
    # Pillar F: Catalyst & Mandate
    # ------------------------------------------------------------------
    f_prior: float | None = None
    f_surprise: float | None = None
    p_F: float | None = None

    if not features.catalyst_data_available:
        reasons.append("CATALYST_DATA_UNAVAILABLE")
        cov_F = 0.0
    else:
        fam_key = features.family.strip().upper()
        if fam_key in FAMILY_PRIOR_REGISTRY:
            prior_val, spec_status, _ = FAMILY_PRIOR_REGISTRY[fam_key]
            f_prior = prior_val
            if "PENDING_DOC" in spec_status:
                reasons.append(f"PRIOR_PENDING_DOC_SPEC:{fam_key}")
        else:
            reasons.append(f"UNREGISTERED_FAMILY_PRIOR:{fam_key}")
            f_prior = None

        if f_prior is not None:
            p_F = f_prior
            cov_F = 1.0
            if _is_valid_num(features.actual_value) and _is_valid_num(features.estimated_value):
                pit_ok = features.surprise_is_pit_verified and (
                    features.surprise_available_at_utc_s is None
                    or features.surprise_available_at_utc_s <= features.feature_asof
                )
                if pit_ok:
                    denom = max(abs(float(features.estimated_value)), cfg.surprise_floor)  # type: ignore[arg-type]
                    raw_surp = abs(float(features.actual_value) - float(features.estimated_value)) / denom  # type: ignore[arg-type]
                    f_surprise = math.tanh(raw_surp / cfg.surprise_tanh_scale)
                    w_s = cfg.surprise_blend_weight
                    p_F = (1.0 - w_s) * f_prior + w_s * f_surprise
                else:
                    reasons.append("SURPRISE_EXCLUDED_NON_PIT")
        else:
            cov_F = 0.0

    comp_scores.update({"F_prior": f_prior, "F_surprise": f_surprise})
    comp_cov["F"] = cov_F

    # ------------------------------------------------------------------
    # Pillar S: Structural Displacement
    # ------------------------------------------------------------------
    s_gap: float | None = None
    s_disp: float | None = None
    atr_causal_ok = features.atr_valid and (
        features.atr_available_at_utc_s is None or features.atr_available_at_utc_s <= features.feature_asof
    )
    if not atr_causal_ok:
        p_S = None
        cov_S = 0.0
        reasons.append("ATR_UNAVAILABLE_OR_NON_CAUSAL")
    else:
        if _is_valid_num(features.gap_atr):
            s_gap = math.tanh(abs(float(features.gap_atr)) / cfg.s_gap_scale)  # type: ignore[arg-type]
        if _is_valid_num(features.close_disp_atr):
            s_disp = math.tanh(abs(float(features.close_disp_atr)) / cfg.s_disp_scale)  # type: ignore[arg-type]
        p_S, cov_S = _renormalized_pillar({"S_gap": s_gap, "S_disp": s_disp}, cfg.s_subweights)

    comp_scores.update({"S_gap": s_gap, "S_disp": s_disp})
    comp_cov["S"] = cov_S

    # ------------------------------------------------------------------
    # Aggregate & Conservative Prior Shrinkage
    # ------------------------------------------------------------------
    pillar_scores: dict[str, float | None] = {"M": p_M, "D": p_D, "F": p_F, "S": p_S}
    pillar_weights = {"M": cfg.weight_M, "D": cfg.weight_D, "F": cfg.weight_F, "S": cfg.weight_S}

    data_coverage = sum(
        pillar_weights[k] for k, val in pillar_scores.items() if val is not None and math.isfinite(val)
    )
    data_coverage = max(0.0, min(1.0, data_coverage))

    if data_coverage <= 0.0:
        return IassBreakdown(
            family=features.family,
            polarity=features.polarity,
            pillar_scores=pillar_scores,
            component_scores=comp_scores,
            data_coverage=0.0,
            component_coverage=comp_cov,
            score_renormalized=None,
            score_conservative=cfg.degradation_prior,
            tier="INSUFFICIENT_DATA",
            status="INSUFFICIENT_DATA",
            degradation_reasons=tuple(dict.fromkeys(reasons + ["ZERO_DATA_COVERAGE"])),
            feature_asof=features.feature_asof,
            config_version=cfg.config_version,
        )

    weighted_sum = sum(
        pillar_weights[k] * float(val)
        for k, val in pillar_scores.items()
        if val is not None and math.isfinite(val)
    )
    score_renormalized = max(0.0, min(100.0, 100.0 * weighted_sum / data_coverage))
    score_conservative = max(
        0.0,
        min(100.0, data_coverage * score_renormalized + (1.0 - data_coverage) * cfg.degradation_prior),
    )
    tier = classify_iass_tier(score_conservative, data_coverage, cfg)
    status: Literal["OK", "PARTIAL_COVERAGE", "INSUFFICIENT_DATA"] = (
        "OK" if data_coverage >= 1.0 - 1e-12 else "PARTIAL_COVERAGE"
    )

    return IassBreakdown(
        family=features.family,
        polarity=features.polarity,
        pillar_scores=pillar_scores,
        component_scores=comp_scores,
        data_coverage=data_coverage,
        component_coverage=comp_cov,
        score_renormalized=score_renormalized,
        score_conservative=score_conservative,
        tier=tier,
        status=status,
        degradation_reasons=tuple(dict.fromkeys(reasons)),
        feature_asof=features.feature_asof,
        config_version=cfg.config_version,
    )
