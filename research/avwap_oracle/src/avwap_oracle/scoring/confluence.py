"""Eje 4.4 Spatial/Microstructure Confluence Engine, Sealed Context Policy & BSM Second-Order Greeks.

Completely pure offline mathematical module (zero network, zero UI, zero argument mutation).
Implements the empirical Prompt #6 -> Phase 2 Context & Confluence specification:
  - Spatial ATR Gaussian kernel: K(delta) = exp(-delta^2 / (2 * 0.35^2))
  - Net GEX normalization: g = tanh(NetGEX / G_0), G_0 = 0.01 * DollarVol_20d
  - BounceConfluence & BreakoutConfluence scores [0, 100] with regime modulation
  - Analytical Black-Scholes-Merton Vanna (dDelta/dSigma) and Charm (-dDelta/dT = +dDelta/dt_cal)
  - Pydantic v2 AvwapContextPolicy validator/factory
"""

from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Mapping, Sequence

from pydantic import BaseModel, ConfigDict, Field


# ---------------------------------------------------------------------------
# 1. Sealed Phase 2 Context Policy Schema & Factory
# ---------------------------------------------------------------------------


class FamilyRule(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    family: str
    tier: Literal["CORE_CONTEXT", "EVENT_AND_STRUCTURAL_CONTEXT", "DEMOTED_OR_DISABLED_BY_DEFAULT"]
    empirical_gate_status: str
    enabled_by_default: bool
    min_iass_conservative: float | None = None
    pinch_eligible: bool = True
    notes: str = ""
    wham_supported_etfs: tuple[str, ...] | None = None
    wham_unsupported_etfs: tuple[str, ...] | None = None
    enabled_as_sr_default: bool | None = None
    show_opex_reset_marker_default: bool | None = None
    blocked_negative_control: bool = False


class VisualBudgetPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    weekly_daily_base: int = 3
    weekly_daily_pinch_bonus: int = 1
    intraday_mid_base: int = 4
    intraday_fast_base: int = 3
    intraday_fast_macro_ref_bonus: int = 1
    intraday_macro_ref_max_dist_atr: float = 1.0
    top_down_bound_daily_atr: float = 3.0
    top_down_bound_intraday_atr: float = 2.5


class RegimeModifiersPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    kernel_sigma_atr: float = 0.35
    gex_scale_dollar_vol_frac: float = 0.01
    short_gamma_hazard_g_threshold: float = -0.30
    short_gamma_hazard_flag: str = "SHORT_GAMMA_BOUNCE_HAZARD"
    positive_gamma_wall_or_vp_max_dist_atr: float = 0.25
    spy_iv_low_chop_max: float = 0.15
    spy_iv_mid_max: float = 0.25
    negative_gamma_evidence: str = "Prompt #6 (56 tickers): Win 2:1 drops from 35.1% (POSITIVE_GAMMA) to 26.7% (NEGATIVE_GAMMA), net_20bps=-65.4 bps"
    high_vol_evidence: str = "Prompt #6 (56 tickers): SPY iv30d > 0.25 reaches Mean AER=+0.7922, Win 2:1=36.5%, net_20bps=+59.5 bps"


class AvwapContextPolicy(BaseModel):
    """Pydantic v2 sealed Phase 2 Institutional Context & Confluence Policy."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    policy_version: str = "avwap_context_policy_v1_2026_11_25"
    source_oracle_config_version: str = "oracle_axis5_v2_sealed_2026_11_25"
    source_study: str = "Prompt #6 56-Symbol Statistical Falsification Oracle (B=2000, seed=42)"
    mode: Literal["INSTITUTIONAL_CONTEXT_AND_CONFLUENCE_ONLY"] = "INSTITUTIONAL_CONTEXT_AND_CONFLUENCE_ONLY"
    autonomous_tier1_entry_signals_enabled: bool = False
    earnings_implied_move_contract: str = (
        "orats_summaries.impliedEarningsMove primary (cores_implied_earnings_move_dec identical-field fallback); NEVER fuse impErnMv."
    )
    core_context: tuple[FamilyRule, ...]
    event_and_structural_context: tuple[FamilyRule, ...]
    demoted_or_disabled_by_default: tuple[FamilyRule, ...]
    visual_budget: VisualBudgetPolicy
    regime_modifiers: RegimeModifiersPolicy
    mandatory_degradation_flags: tuple[str, ...]


def build_default_avwap_context_policy() -> AvwapContextPolicy:
    """Build the empirically sealed Prompt #7 Phase 2 context policy."""
    return AvwapContextPolicy(
        core_context=(
            FamilyRule(
                family="SESSION_VWAP",
                tier="CORE_CONTEXT",
                empirical_gate_status="CORE_INTRADAY_BENCHMARK",
                enabled_by_default=True,
                notes="Intraday RTH 09:30 ET institutional anchor with hybrid/Welford bands (+-1sigma, +-2sigma, +-2.5sigma).",
            ),
            FamilyRule(
                family="CALENDAR_YTD",
                tier="CORE_CONTEXT",
                empirical_gate_status="TIER_2_CONTEXT_ONLY",
                enabled_by_default=True,
                notes="Only family with 8/8 positive Walk-Forward OOS folds and H=3 z=+2.518 (p_raw=0.0085), H=5 p_raw=0.0380.",
            ),
            FamilyRule(
                family="EARNINGS_BLOWOUT",
                tier="CORE_CONTEXT",
                empirical_gate_status="REJECT_NO_EDGE_AUTONOMOUS_CONTEXT_CORE",
                enabled_by_default=True,
                notes="|r_ern| / impliedEarningsMove >= 1.25 via orats_summaries.impliedEarningsMove (never impErnMv); +0.255 ATR / +39 bps spread vs EARNINGS_INLINE.",
            ),
            FamilyRule(
                family="IPO_DIRECT",
                tier="CORE_CONTEXT",
                empirical_gate_status="ACCOUNTING_IDENTITY_AGE_LT_2Y",
                enabled_by_default=True,
                notes="Structural cost-basis identity anchor active when instrument listing age < 2 years.",
            ),
        ),
        event_and_structural_context=(
            FamilyRule(
                family="CALENDAR_QTD",
                tier="EVENT_AND_STRUCTURAL_CONTEXT",
                empirical_gate_status="REJECT_NO_EDGE",
                enabled_by_default=True,
                min_iass_conservative=55.0,
                notes="Quarter-to-date institutional cost basis; visible when IASS_conservative >= 55 or in PINCH_PAIR.",
            ),
            FamilyRule(
                family="VOLUME_CLIMAX",
                tier="EVENT_AND_STRUCTURAL_CONTEXT",
                empirical_gate_status="REJECT_NO_EDGE",
                enabled_by_default=True,
                min_iass_conservative=55.0,
                notes="Causal climax capitulation anchor; visible when IASS_conservative >= 55 or in PINCH_PAIR.",
            ),
            FamilyRule(
                family="BREAKAWAY_GAP",
                tier="EVENT_AND_STRUCTURAL_CONTEXT",
                empirical_gate_status="REJECT_NO_EDGE",
                enabled_by_default=True,
                min_iass_conservative=55.0,
                notes="Causal breakaway gap anchor; visible when IASS_conservative >= 55 or in PINCH_PAIR.",
            ),
            FamilyRule(
                family="MACRO_SHOCK",
                tier="EVENT_AND_STRUCTURAL_CONTEXT",
                empirical_gate_status="REJECT_NO_EDGE",
                enabled_by_default=True,
                min_iass_conservative=55.0,
                wham_supported_etfs=("SPY", "QQQ", "IWM"),
                wham_unsupported_etfs=("DIA", "XLK", "XLF"),
                notes="Restricted to US_ETFs with live ORATS WHAM coverage (SPY/QQQ/IWM); emit MISSING_WHAM_COVERAGE on DIA/XLK/XLF.",
            ),
            FamilyRule(
                family="SECONDARY_OFFERING",
                tier="EVENT_AND_STRUCTURAL_CONTEXT",
                empirical_gate_status="INSUFFICIENT_SAMPLE",
                enabled_by_default=True,
                min_iass_conservative=55.0,
                notes="Confirmed executed offering anchored strictly on SEC acceptedDate ET (never bare S-3/S-3ASR shelf).",
            ),
            FamilyRule(
                family="INDEX_REBAL",
                tier="EVENT_AND_STRUCTURAL_CONTEXT",
                empirical_gate_status="INSUFFICIENT_SAMPLE",
                enabled_by_default=True,
                min_iass_conservative=55.0,
                notes="Verified S&P500 / Nasdaq constituent inclusion/exclusion anchor.",
            ),
            FamilyRule(
                family="OPTIONS_FLOW_SHOCK",
                tier="EVENT_AND_STRUCTURAL_CONTEXT",
                empirical_gate_status="REJECT_NO_EDGE",
                enabled_by_default=True,
                min_iass_conservative=55.0,
                notes="Tagged NO_NBBO_AGGRESSOR_SIDE (net_directional_premium=null in OPRA feed); context/confluence only.",
            ),
            FamilyRule(
                family="SWING_CAUSAL",
                tier="EVENT_AND_STRUCTURAL_CONTEXT",
                empirical_gate_status="REJECT_NO_EDGE",
                enabled_by_default=True,
                min_iass_conservative=55.0,
                notes="Strict rvol_z >= 1.5 causal pivot used primarily to form PINCH_PAIR corridors and IASS >= 55 structure.",
            ),
        ),
        demoted_or_disabled_by_default=(
            FamilyRule(
                family="POST_OPEX",
                tier="DEMOTED_OR_DISABLED_BY_DEFAULT",
                empirical_gate_status="REJECT_NO_EDGE_REFUTED",
                enabled_by_default=False,
                pinch_eligible=False,
                enabled_as_sr_default=False,
                show_opex_reset_marker_default=False,
                notes="Refuted as standalone S/R level in Prompt #6 (z_lift=-3.271, p_raw=0.9995, n=3485); optional OpEx cycle reset marker only.",
            ),
            FamilyRule(
                family="EARNINGS_INLINE",
                tier="DEMOTED_OR_DISABLED_BY_DEFAULT",
                empirical_gate_status="NEGATIVE_CONTROL_PASS_PRUNED",
                enabled_by_default=False,
                pinch_eligible=False,
                blocked_negative_control=True,
                notes="Confirmed negative control (obs_aer=-0.1151, q_BH=0.9995); blocked/pruned in production UI.",
            ),
            FamilyRule(
                family="SWING_NO_RVOL",
                tier="DEMOTED_OR_DISABLED_BY_DEFAULT",
                empirical_gate_status="NEGATIVE_CONTROL_PASS_PRUNED",
                enabled_by_default=False,
                pinch_eligible=False,
                blocked_negative_control=True,
                notes="Confirmed negative control (obs_aer=-0.0461, q_BH=0.9995); blocked/pruned in production UI.",
            ),
            FamilyRule(
                family="EX_DIVIDEND_REGULAR",
                tier="DEMOTED_OR_DISABLED_BY_DEFAULT",
                empirical_gate_status="NEGATIVE_CONTROL_PASS_PRUNED",
                enabled_by_default=False,
                pinch_eligible=False,
                blocked_negative_control=True,
                notes="Confirmed negative control (obs_aer=-0.2275, q_BH=0.9995); blocked/pruned in production UI.",
            ),
        ),
        visual_budget=VisualBudgetPolicy(),
        regime_modifiers=RegimeModifiersPolicy(),
        mandatory_degradation_flags=(
            "FLOAT_NON_PIT_SNAPSHOT",
            "NO_ORATS_COVERAGE",
            "ORATS_OI_FALLBACK_MASSIVE",
            "MISSING_WHAM_COVERAGE",
            "NO_NBBO_AGGRESSOR_SIDE",
            "NO_NOI_IMBALANCE_FEED",
            "CORP_ACTION_CONFLICT_QUARANTINED",
        ),
    )


def save_avwap_context_policy(path: Path, policy: AvwapContextPolicy | None = None) -> dict[str, Any]:
    """Serialize `AvwapContextPolicy` atomically as strict UTF-8 JSON (no NaN/Inf)."""
    pol = policy if policy is not None else build_default_avwap_context_policy()
    payload = pol.model_dump()
    text = json.dumps(payload, indent=2, sort_keys=True, allow_nan=False)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp.{os.getpid()}")
    try:
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
    return payload


# ---------------------------------------------------------------------------
# 2. Spatial Kernel, Net GEX Normalization & Bounce/Breakout Confluence
# ---------------------------------------------------------------------------

VolRegimeLabel = Literal["LOW_VOL_CHOP", "MID_VOL", "HIGH_VOL_TREND", "UNKNOWN"]
GammaRegimeLabel = Literal["POSITIVE_GAMMA", "NEGATIVE_GAMMA", "NEUTRAL", "UNKNOWN"]


def _clamp(val: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, val))


def atr_gaussian_kernel(
    avwap_price: float,
    level_price: float | None,
    atr14: float,
    sigma_atr: float = 0.35,
) -> float:
    """Compute Eje 4.4 spatial kernel K(delta) = exp(-delta^2 / (2 * 0.35^2)).

    Returns ``NaN`` when ``avwap_price`` or ``atr14`` is non-calculable, and ``0.0``
    when the target structural ``level_price`` is unavailable.
    """
    if not (math.isfinite(avwap_price) and avwap_price > 0.0 and math.isfinite(atr14) and atr14 > 0.0):
        return math.nan
    if not (math.isfinite(sigma_atr) and sigma_atr > 0.0):
        raise ValueError(f"sigma_atr must be > 0, got {sigma_atr!r}")
    if level_price is None or not (math.isfinite(float(level_price)) and float(level_price) > 0.0):
        return 0.0
    delta = abs(avwap_price - float(level_price)) / atr14
    return math.exp(-(delta * delta) / (2.0 * sigma_atr * sigma_atr))


def normalize_net_gex(
    net_gex: float | None,
    dollar_vol_20d: float,
) -> tuple[float, float]:
    """Compute ``g = tanh(NetGEX / G_0)`` with ``G_0 = 0.01 * DollarVol_20d``."""
    if not (math.isfinite(dollar_vol_20d) and dollar_vol_20d > 0.0):
        return math.nan, math.nan
    g0 = 0.01 * dollar_vol_20d
    if net_gex is None or not math.isfinite(float(net_gex)):
        return math.nan, g0
    g = math.tanh(float(net_gex) / g0)
    return g, g0


def classify_volatility_regime(spy_iv30d_dec: float | None) -> VolRegimeLabel:
    if spy_iv30d_dec is None or not (math.isfinite(float(spy_iv30d_dec)) and float(spy_iv30d_dec) > 0.0):
        return "UNKNOWN"
    iv = float(spy_iv30d_dec)
    if iv < 0.15:
        return "LOW_VOL_CHOP"
    if iv <= 0.25:
        return "MID_VOL"
    return "HIGH_VOL_TREND"


def classify_gamma_regime(g: float) -> GammaRegimeLabel:
    if not math.isfinite(g):
        return "UNKNOWN"
    if g > 1e-9:
        return "POSITIVE_GAMMA"
    if g < -1e-9:
        return "NEGATIVE_GAMMA"
    return "NEUTRAL"


@dataclass(frozen=True)
class ConfluenceContextResult:
    bounce_confluence: float
    breakout_confluence: float
    net_gex_normalized_g: float
    g0_dollar_vol_scale: float
    gamma_regime: GammaRegimeLabel
    vol_regime: VolRegimeLabel
    mean_reversion_context_active: bool
    hazard_flags: tuple[str, ...]
    degradation_flags: tuple[str, ...]
    spatial_kernels: dict[str, float]
    bounce_multiplier: float
    breakout_multiplier: float


def compute_confluence_context(
    *,
    avwap_price: float,
    spot_price: float,
    atr14: float,
    polarity: Literal["LONG", "SHORT", "NEUTRAL"] = "LONG",
    net_gex: float | None = None,
    dollar_vol_20d: float = math.nan,
    call_wall: float | None = None,
    put_wall: float | None = None,
    zero_gamma: float | None = None,
    vp_poc: float | None = None,
    vp_vah: float | None = None,
    vp_val: float | None = None,
    vp_hvns: Sequence[float] = (),
    vp_lvns: Sequence[float] = (),
    cvd_absorption_score: float | None = None,
    cvd_directional_alignment: float | None = None,
    bucket_rvol_z: float | None = None,
    contango: float | None = None,
    spy_iv30d_dec: float | None = None,
    sigma_hybrid: float | None = None,
    extra_degradation_flags: Sequence[str] = (),
) -> ConfluenceContextResult:
    """Evaluate BounceConfluence & BreakoutConfluence [0..100] with Prompt #6 regime modifiers."""
    if not (math.isfinite(avwap_price) and avwap_price > 0.0 and math.isfinite(atr14) and atr14 > 0.0):
        return ConfluenceContextResult(
            bounce_confluence=math.nan,
            breakout_confluence=math.nan,
            net_gex_normalized_g=math.nan,
            g0_dollar_vol_scale=math.nan,
            gamma_regime="UNKNOWN",
            vol_regime=classify_volatility_regime(spy_iv30d_dec),
            mean_reversion_context_active=False,
            hazard_flags=(),
            degradation_flags=tuple(sorted(set(extra_degradation_flags))),
            spatial_kernels={},
            bounce_multiplier=math.nan,
            breakout_multiplier=math.nan,
        )

    k_cw = atr_gaussian_kernel(avwap_price, call_wall, atr14)
    k_pw = atr_gaussian_kernel(avwap_price, put_wall, atr14)
    if polarity == "LONG" and k_pw > 0.0:
        k_wall = max(k_pw, 0.85 * k_cw)
    elif polarity == "SHORT" and k_cw > 0.0:
        k_wall = max(k_cw, 0.85 * k_pw)
    else:
        k_wall = max(k_cw, k_pw)

    k_poc = atr_gaussian_kernel(avwap_price, vp_poc, atr14)
    k_vah = atr_gaussian_kernel(avwap_price, vp_vah, atr14)
    k_val = atr_gaussian_kernel(avwap_price, vp_val, atr14)
    k_hvn = max((atr_gaussian_kernel(avwap_price, lv, atr14) for lv in vp_hvns), default=0.0)
    k_vp_bounce = max(k_poc, k_vah, k_val, k_hvn)

    cvd_abs = (
        _clamp(float(cvd_absorption_score), 0.0, 1.0)
        if cvd_absorption_score is not None and math.isfinite(float(cvd_absorption_score))
        else math.nan
    )
    bounce_parts: list[tuple[float, float]] = [(0.40, k_wall), (0.35, k_vp_bounce)]
    if math.isfinite(cvd_abs):
        bounce_parts.append((0.25, cvd_abs))
    w_sum_b = math.fsum(w for w, _ in bounce_parts)
    base_bounce = 100.0 * (math.fsum(w * v for w, v in bounce_parts) / w_sum_b) if w_sum_b > 0.0 else 0.0

    k_zg = atr_gaussian_kernel(avwap_price, zero_gamma, atr14)
    k_lvn = max((atr_gaussian_kernel(avwap_price, lv, atr14) for lv in vp_lvns), default=0.0)
    rvol_norm = (
        _clamp(max(0.0, float(bucket_rvol_z)) / 3.0, 0.0, 1.0)
        if bucket_rvol_z is not None and math.isfinite(float(bucket_rvol_z))
        else math.nan
    )
    cvd_dir = (
        _clamp(float(cvd_directional_alignment), 0.0, 1.0)
        if cvd_directional_alignment is not None and math.isfinite(float(cvd_directional_alignment))
        else math.nan
    )
    bo_parts: list[tuple[float, float]] = [(0.35, k_zg), (0.25, k_lvn)]
    if math.isfinite(rvol_norm):
        bo_parts.append((0.25, rvol_norm))
    if math.isfinite(cvd_dir):
        bo_parts.append((0.15, cvd_dir))
    w_sum_bo = math.fsum(w for w, _ in bo_parts)
    base_breakout = 100.0 * (math.fsum(w * v for w, v in bo_parts) / w_sum_bo) if w_sum_bo > 0.0 else 0.0

    g, g0 = normalize_net_gex(net_gex, dollar_vol_20d)
    gamma_regime = classify_gamma_regime(g)
    vol_regime = classify_volatility_regime(spy_iv30d_dec)
    contango_pos = contango is not None and math.isfinite(float(contango)) and float(contango) > 0.0

    hazards: list[str] = []
    if math.isfinite(g):
        if g >= 0.0:
            bounce_mult = 1.0 + 0.25 * g + (0.05 if (g > 0.0 and contango_pos) else 0.0)
            breakout_mult = max(0.50, 1.0 - 0.25 * g)
        else:
            bounce_mult = max(0.35, 1.0 - 0.45 * (-g))
            breakout_mult = 1.0 + 0.30 * (-g)
            if g < -0.30:
                hazards.append("SHORT_GAMMA_BOUNCE_HAZARD")
    else:
        bounce_mult = 1.0
        breakout_mult = 1.0

    bounce_score = _clamp(base_bounce * bounce_mult, 0.0, 100.0)
    breakout_score = _clamp(base_breakout * breakout_mult, 0.0, 100.0)

    # Check POSITIVE_GAMMA + contango > 0 + <= 0.25 ATR confluence of Call/Put Wall or VAH/VAL (at AVWAP or +-2/2.5 sigma)
    ref_prices = [avwap_price]
    if sigma_hybrid is not None and math.isfinite(float(sigma_hybrid)) and float(sigma_hybrid) >= 0.0:
        sh = float(sigma_hybrid)
        ref_prices.extend([avwap_price + 2.0 * sh, avwap_price - 2.0 * sh, avwap_price + 2.5 * sh, avwap_price - 2.5 * sh])
    target_levels = [p for p in (call_wall, put_wall, vp_vah, vp_val) if p is not None and math.isfinite(float(p))]
    min_dist_atr = math.inf
    for rp in ref_prices:
        for lv in target_levels:
            d_atr = abs(rp - float(lv)) / atr14
            if d_atr < min_dist_atr:
                min_dist_atr = d_atr
    mean_rev_active = bool(gamma_regime == "POSITIVE_GAMMA" and contango_pos and min_dist_atr <= 0.25)

    all_flags = tuple(sorted(set(extra_degradation_flags) | set(hazards)))
    return ConfluenceContextResult(
        bounce_confluence=bounce_score,
        breakout_confluence=breakout_score,
        net_gex_normalized_g=g,
        g0_dollar_vol_scale=g0,
        gamma_regime=gamma_regime,
        vol_regime=vol_regime,
        mean_reversion_context_active=mean_rev_active,
        hazard_flags=tuple(hazards),
        degradation_flags=all_flags,
        spatial_kernels={
            "call_wall": k_cw,
            "put_wall": k_pw,
            "vp_poc": k_poc,
            "vp_vah": k_vah,
            "vp_val": k_val,
            "vp_hvn_max": k_hvn,
            "zero_gamma": k_zg,
            "vp_lvn_max": k_lvn,
        },
        bounce_multiplier=bounce_mult,
        breakout_multiplier=breakout_mult,
    )


# ---------------------------------------------------------------------------
# 3. Analytical BSM Second-Order Greeks (Vanna & Charm) matching blackScholes.ts
# ---------------------------------------------------------------------------


def _norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


@dataclass(frozen=True)
class BsmSecondOrderGreeksResult:
    contract_type: Literal["call", "put"]
    spot: float
    strike: float
    dte_days: float
    time_to_expiry_years: float
    smv_vol: float
    risk_free: float
    residual_rate: float
    dividend_yield_q: float
    d1: float
    d2: float
    price: float
    delta: float
    gamma: float
    vega: float
    vanna: float
    charm: float
    charm_daily: float


def compute_bsm_second_order_greeks(
    *,
    spot: float,
    strike: float,
    dte_days: float,
    smv_vol: float,
    risk_free: float,
    residual_rate: float = 0.0,
    contract_type: Literal["call", "put"] = "call",
) -> BsmSecondOrderGreeksResult:
    """Analytical European BSM price, first-order Greeks, Vanna (dDelta/dSigma), and Charm (-dDelta/dT).

    Conventions follow ``src/core/options/blackScholes.ts``:
      - ``t = dte_days / 365.0``
      - ``q = risk_free - residual_rate`` (when ``residual_rate`` represents ORATS continuous carry ``b = r - q``)
      - ``vanna = -exp(-q * t) * phi(d1) * (d2 / smv_vol)``
      - ``charm = ±q * exp(-q * t) * Phi(±d1) - exp(-q * t) * phi(d1) * ((2 * (r - q) * t - d2 * vol * sqrt(t)) / (2 * t * vol * sqrt(t)))``
    """
    invalid = not (
        math.isfinite(spot) and spot > 0.0
        and math.isfinite(strike) and strike > 0.0
        and math.isfinite(dte_days) and dte_days > 0.0
        and math.isfinite(smv_vol) and smv_vol > 0.0
        and math.isfinite(risk_free)
        and math.isfinite(residual_rate)
    )
    if invalid:
        return BsmSecondOrderGreeksResult(
            contract_type=contract_type,
            spot=spot,
            strike=strike,
            dte_days=dte_days,
            time_to_expiry_years=math.nan,
            smv_vol=smv_vol,
            risk_free=risk_free,
            residual_rate=residual_rate,
            dividend_yield_q=math.nan,
            d1=math.nan,
            d2=math.nan,
            price=math.nan,
            delta=math.nan,
            gamma=math.nan,
            vega=math.nan,
            vanna=math.nan,
            charm=math.nan,
            charm_daily=math.nan,
        )

    t = dte_days / 365.0
    carry_rate = residual_rate
    q = risk_free - carry_rate
    sqrt_t = math.sqrt(t)
    vol_sqrt_t = smv_vol * sqrt_t
    d1 = (math.log(spot / strike) + (carry_rate + 0.5 * smv_vol * smv_vol) * t) / vol_sqrt_t
    d2 = d1 - vol_sqrt_t

    disc_u = math.exp(-q * t)
    disc_k = math.exp(-risk_free * t)
    cdf_pos = _norm_cdf(d1)
    cdf_neg = _norm_cdf(-d1)
    cdf_d2_pos = _norm_cdf(d2)
    cdf_d2_neg = _norm_cdf(-d2)
    pdf_d1 = _norm_pdf(d1)

    if contract_type == "call":
        price = spot * disc_u * cdf_pos - strike * disc_k * cdf_d2_pos
        delta = disc_u * cdf_pos
    else:
        price = strike * disc_k * cdf_d2_neg - spot * disc_u * cdf_neg
        delta = -disc_u * cdf_neg

    gamma = (disc_u * pdf_d1) / (spot * vol_sqrt_t)
    vega = spot * disc_u * sqrt_t * pdf_d1
    vanna = -disc_u * pdf_d1 * (d2 / smv_vol)

    charm_denom = 2.0 * t * vol_sqrt_t
    charm_drift_ratio = (2.0 * carry_rate * t - d2 * vol_sqrt_t) / charm_denom
    charm_common = disc_u * pdf_d1 * charm_drift_ratio
    if contract_type == "call":
        charm = q * disc_u * cdf_pos - charm_common
    else:
        charm = -q * disc_u * cdf_neg - charm_common

    return BsmSecondOrderGreeksResult(
        contract_type=contract_type,
        spot=spot,
        strike=strike,
        dte_days=dte_days,
        time_to_expiry_years=t,
        smv_vol=smv_vol,
        risk_free=risk_free,
        residual_rate=residual_rate,
        dividend_yield_q=q,
        d1=d1,
        d2=d2,
        price=price,
        delta=delta,
        gamma=gamma,
        vega=vega,
        vanna=vanna,
        charm=charm,
        charm_daily=charm / 365.0,
    )
