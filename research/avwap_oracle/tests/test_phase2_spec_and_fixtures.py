"""100% offline verification for Prompt #7 Phase 2 Context Policy, Confluence & Golden Fixtures."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Literal

import pytest

from avwap_oracle.export_phase2_spec import export_phase2_artifacts
from avwap_oracle.scoring.confluence import (
    AvwapContextPolicy,
    atr_gaussian_kernel,
    compute_bsm_second_order_greeks,
    compute_confluence_context,
    normalize_net_gex,
    save_avwap_context_policy,
)

ORACLE_ROOT = Path(__file__).resolve().parents[1]


def test_phase2_context_policy_schema_and_empirical_rules() -> None:
    policy_path = ORACLE_ROOT / "spec" / "avwap_context_policy.json"
    assert policy_path.is_file(), "Run avwap_oracle.export_phase2_spec first"
    raw = json.loads(policy_path.read_text(encoding="utf-8"))
    pol = AvwapContextPolicy.model_validate(raw)

    assert pol.mode == "INSTITUTIONAL_CONTEXT_AND_CONFLUENCE_ONLY"
    assert pol.autonomous_tier1_entry_signals_enabled is False

    core_map = {r.family: r for r in pol.core_context}
    assert set(core_map) == {"SESSION_VWAP", "CALENDAR_YTD", "EARNINGS_BLOWOUT", "IPO_DIRECT"}
    assert core_map["CALENDAR_YTD"].empirical_gate_status == "TIER_2_CONTEXT_ONLY"

    ev_map = {r.family: r for r in pol.event_and_structural_context}
    assert ev_map["MACRO_SHOCK"].wham_supported_etfs == ("SPY", "QQQ", "IWM")
    assert ev_map["MACRO_SHOCK"].wham_unsupported_etfs == ("DIA", "XLK", "XLF")
    assert ev_map["SWING_CAUSAL"].min_iass_conservative == 55.0

    dem_map = {r.family: r for r in pol.demoted_or_disabled_by_default}
    assert dem_map["POST_OPEX"].enabled_by_default is False
    assert dem_map["POST_OPEX"].enabled_as_sr_default is False
    assert dem_map["POST_OPEX"].show_opex_reset_marker_default is False
    for ctrl in ("EARNINGS_INLINE", "SWING_NO_RVOL", "EX_DIVIDEND_REGULAR"):
        assert dem_map[ctrl].blocked_negative_control is True
        assert dem_map[ctrl].enabled_by_default is False

    assert pol.visual_budget.weekly_daily_base == 3
    assert pol.visual_budget.intraday_mid_base == 4
    assert pol.visual_budget.intraday_fast_base == 3
    assert pol.visual_budget.top_down_bound_daily_atr == 3.0
    assert pol.visual_budget.top_down_bound_intraday_atr == 2.5

    expected_flags = {
        "FLOAT_NON_PIT_SNAPSHOT",
        "NO_ORATS_COVERAGE",
        "ORATS_OI_FALLBACK_MASSIVE",
        "MISSING_WHAM_COVERAGE",
        "NO_NBBO_AGGRESSOR_SIDE",
        "NO_NOI_IMBALANCE_FEED",
        "CORP_ACTION_CONFLICT_QUARANTINED",
    }
    assert expected_flags.issubset(set(pol.mandatory_degradation_flags))


def test_confluence_regime_modulation_hazards_and_bsm_finite_diff() -> None:
    # Gaussian spatial kernel exactness & zero/NaN edge rules
    assert math.isclose(atr_gaussian_kernel(100.0, 100.0, 2.0), 1.0, abs_tol=1e-12)
    assert math.isclose(
        atr_gaussian_kernel(100.7, 100.0, 2.0),
        math.exp(-((0.35) ** 2) / (2.0 * (0.35 ** 2))),
        abs_tol=1e-12,
    )
    assert atr_gaussian_kernel(100.0, None, 2.0) == 0.0
    assert math.isnan(atr_gaussian_kernel(100.0, 100.0, 0.0))

    # GEX normalization
    g, g0 = normalize_net_gex(1_000_000.0, 100_000_000.0)
    assert math.isclose(g0, 1_000_000.0, abs_tol=1e-9)
    assert math.isclose(g, math.tanh(1.0), abs_tol=1e-12)

    # Identical levels under POSITIVE_GAMMA vs NEGATIVE_GAMMA
    common = dict(
        avwap_price=500.2,
        spot_price=500.0,
        atr14=4.0,
        polarity="LONG",
        dollar_vol_20d=200_000_000.0,
        call_wall=505.0,
        put_wall=500.0,
        zero_gamma=500.5,
        vp_poc=500.1,
        vp_vah=504.0,
        vp_val=496.0,
        vp_hvns=[500.2],
        vp_lvns=[500.5],
        cvd_absorption_score=0.80,
        cvd_directional_alignment=0.75,
        bucket_rvol_z=2.0,
        contango=0.35,
        spy_iv30d_dec=0.18,
    )
    pos = compute_confluence_context(net_gex=1_200_000.0, **common)  # type: ignore[arg-type]
    neg = compute_confluence_context(net_gex=-1_200_000.0, **common)  # type: ignore[arg-type]

    assert pos.gamma_regime == "POSITIVE_GAMMA"
    assert neg.gamma_regime == "NEGATIVE_GAMMA"
    assert pos.bounce_confluence > neg.bounce_confluence
    assert neg.breakout_confluence > pos.breakout_confluence
    assert pos.mean_reversion_context_active is True
    assert "SHORT_GAMMA_BOUNCE_HAZARD" in neg.hazard_flags
    assert "SHORT_GAMMA_BOUNCE_HAZARD" not in pos.hazard_flags

    # Verify threshold g < -0.30 boundary cleanly
    mild_neg = compute_confluence_context(net_gex=-200_000.0, **common)  # type: ignore[arg-type]
    assert -0.30 < mild_neg.net_gex_normalized_g < 0.0
    assert "SHORT_GAMMA_BOUNCE_HAZARD" not in mild_neg.hazard_flags

    # Finite-difference verification of analytical BSM Vanna (dDelta/dSigma) and Charm (-dDelta/dT)
    max_vanna_rel_err = 0.0
    max_charm_rel_err = 0.0
    d_sig = 1e-5
    d_t_years = 1e-5
    for ctype in ("call", "put"):
        ct: Literal["call", "put"] = ctype  # type: ignore[assignment]
        for strike in (680.0, 715.81, 745.0):
            base = compute_bsm_second_order_greeks(
                spot=715.81,
                strike=strike,
                dte_days=30.0,
                smv_vol=0.218547,
                risk_free=0.0425495,
                residual_rate=0.0295495,
                contract_type=ct,
            )
            up_v = compute_bsm_second_order_greeks(
                spot=715.81,
                strike=strike,
                dte_days=30.0,
                smv_vol=0.218547 + d_sig,
                risk_free=0.0425495,
                residual_rate=0.0295495,
                contract_type=ct,
            )
            dn_v = compute_bsm_second_order_greeks(
                spot=715.81,
                strike=strike,
                dte_days=30.0,
                smv_vol=0.218547 - d_sig,
                risk_free=0.0425495,
                residual_rate=0.0295495,
                contract_type=ct,
            )
            vanna_fd = (up_v.delta - dn_v.delta) / (2.0 * d_sig)
            rel_err_v = abs(base.vanna - vanna_fd) / max(1.0, abs(vanna_fd))
            max_vanna_rel_err = max(max_vanna_rel_err, rel_err_v)
            assert rel_err_v < 1e-5

            d_days = d_t_years * 365.0
            up_t = compute_bsm_second_order_greeks(
                spot=715.81,
                strike=strike,
                dte_days=30.0 + d_days,
                smv_vol=0.218547,
                risk_free=0.0425495,
                residual_rate=0.0295495,
                contract_type=ct,
            )
            dn_t = compute_bsm_second_order_greeks(
                spot=715.81,
                strike=strike,
                dte_days=30.0 - d_days,
                smv_vol=0.218547,
                risk_free=0.0425495,
                residual_rate=0.0295495,
                contract_type=ct,
            )
            charm_fd = -(up_t.delta - dn_t.delta) / (2.0 * d_t_years)
            rel_err_c = abs(base.charm - charm_fd) / max(1.0, abs(charm_fd))
            max_charm_rel_err = max(max_charm_rel_err, rel_err_c)
            assert rel_err_c < 1e-5

    assert max_vanna_rel_err < 1e-5 and max_charm_rel_err < 1e-5


def test_golden_fixtures_strict_json_size_secrets_and_cases() -> None:
    gf_path = ORACLE_ROOT / "spec" / "golden_fixtures" / "avwap_phase2_golden_fixtures.json"
    assert gf_path.is_file(), "Run avwap_oracle.export_phase2_spec first"
    raw_bytes = gf_path.stat().st_size
    assert raw_bytes < 250 * 1024, f"Golden fixture too large: {raw_bytes} bytes"

    text = gf_path.read_text(encoding="utf-8")
    # Strict JSON reject NaN/Infinity
    gf = json.loads(text)
    json.dumps(gf, allow_nan=False)

    # Zero secret tokens in fixture
    for forbidden in ("MASSIVE_KEY", "ORATS_API", "FMP_API", "Bearer "):
        assert forbidden not in text

    # Case 1: NVDA 10:1 split parity + EARNINGS_BLOWOUT vs EARNINGS_INLINE
    c1 = gf["case1_nvda_split_and_earnings"]
    sw = c1["split_window_2024_06_05_to_12"]
    assert sw["o1_split_step_proof_1d"]["audit_matches_o1"] is True
    pre = sw["o1_split_step_proof_1d"]["pre_split_cum_2024_06_07"]
    post = sw["o1_split_step_proof_1d"]["post_split_o1_2024_06_10_open"]
    assert math.isclose(post["W"], pre["W"] / 0.1, rel_tol=1e-12)
    assert math.isclose(post["mu"], pre["mu"] * 0.1, rel_tol=1e-12)
    assert math.isclose(post["M2"], pre["M2"] * 0.1, rel_tol=1e-12)
    assert sw["cross_tf_parity_max_mu_bps"] < 1e-9
    assert sw["cross_tf_parity_max_sd_bps"] < 1e-9

    ec = c1["earnings_comparison"]
    assert ec["blowout_2024_02_21_amc"]["family"] == "EARNINGS_BLOWOUT"
    assert ec["inline_2024_11_20_amc"]["family"] == "EARNINGS_INLINE"
    assert ec["inline_2024_11_20_amc"]["is_negative_control"] is True

    # Case 2: SPY CALENDAR_YTD + OI fallback + GEX confluence + BSM Vanna/Charm
    c2 = gf["case2_spy_ytd_wham_oi_gex_bsm"]
    offsets = [row["elapsed_trading_days"] for row in c2["calendar_ytd_2024_hybrid_bands"]]
    assert offsets == [0, 1, 2, 5, 20]
    assert c2["reconciled_oi_fallback_2025_10_06"]["orats_total_oi_raw"] == 0
    assert c2["reconciled_oi_fallback_2025_10_06"]["massive_total_oi_raw"] == 16786351
    assert c2["reconciled_oi_fallback_2025_10_06"]["oi_source"] == "MASSIVE_FALLBACK"
    assert (
        c2["confluence_scenarios"]["controlled_parity_pair_pos"]["bounce_confluence"]
        > c2["confluence_scenarios"]["controlled_parity_pair_neg"]["bounce_confluence"]
    )
    assert (
        c2["confluence_scenarios"]["controlled_parity_pair_neg"]["breakout_confluence"]
        > c2["confluence_scenarios"]["controlled_parity_pair_pos"]["breakout_confluence"]
    )
    assert "SHORT_GAMMA_BOUNCE_HAZARD" in c2["confluence_scenarios"]["real_negative_gamma_2026_11_19"]["hazard_flags"]
    assert math.isfinite(c2["bsm_second_order_greeks"]["call_720"]["vanna"])
    assert math.isfinite(c2["bsm_second_order_greeks"]["put_720"]["charm"])

    # Case 3: MELI US_ADR Bayesian shrinkage (dataCoverage=0.70, prior=35.0)
    c3 = gf["case3_meli_adr_bayesian_degradation"]
    assert c3["with_orats"]["data_coverage"] == 1.0
    wo = c3["without_orats_simulated_degradation"]
    assert math.isclose(wo["data_coverage"], 0.70, abs_tol=1e-9)
    assert math.isclose(wo["score_conservative"], 0.70 * wo["score_renormalized"] + 0.30 * 35.0, abs_tol=1e-9)

    # Case 4: COST special dividend $15 vs regular $1.47
    c4 = gf["case4_cost_special_vs_regular_dividend"]
    sp = c4["special_dividend_2023_12_27"]
    assert sp["applied"] is True
    assert math.isclose(sp["post_state"]["mu"], sp["d_factor"] * sp["pre_state"]["mu"], rel_tol=1e-12)
    assert math.isclose(sp["post_state"]["M2"], (sp["d_factor"] ** 2) * sp["pre_state"]["M2"], rel_tol=1e-12)
    rg = c4["regular_dividend_2026_05_01"]
    assert rg["applied"] is False
    assert math.isclose(rg["post_state"]["mu"], rg["pre_state"]["mu"], rel_tol=1e-12)

    # Case 5: FSM PINCH_PAIR, PINCH_BREAKOUT, COHORT_DECAY, CHOP_SATURATION, BREAKOUT_RESURRECTION, ARCHIVED
    c5 = gf["case5_fsm_pinch_breakout_resurrection"]
    trs_a = c5["pinch_breakout_cohort_decay_15bars"]["transitions"]
    states_a = {t["next_state"] for t in trs_a}
    reasons_a = {t["transition_reason"] for t in trs_a}
    assert "PINCH_PAIR" in states_a
    assert "ARCHIVED" in states_a
    assert "PINCH_BREAKOUT" in reasons_a
    assert "COHORT_DECAY" in reasons_a
    assert "ARCHIVED_FAR_DIST_LOW_COHORT" in reasons_a
    reasons_b = {t["transition_reason"] for t in c5["chop_saturation_archival_15bars"]["transitions"]}
    assert "CHOP_SATURATION" in reasons_b
    assert "ARCHIVED_DECAY_TIMEOUT" in reasons_b
    reasons_c = {t["transition_reason"] for t in c5["flat_decay_breakout_resurrection_25bars"]["transitions"]}
    assert "FLAT_SLOPE" in reasons_c
    assert "BREAKOUT_RESURRECTION" in reasons_c


def test_spec_directory_not_ignored_and_save_policy_atomic(tmp_path: Path) -> None:
    gi_text = (ORACLE_ROOT / ".gitignore").read_text(encoding="utf-8")
    assert "spec/" not in gi_text
    assert "*.json" not in gi_text
    out = save_avwap_context_policy(tmp_path / "spec" / "avwap_context_policy.json")
    assert out["mode"] == "INSTITUTIONAL_CONTEXT_AND_CONFLUENCE_ONLY"

    res_exp = export_phase2_artifacts(root=ORACLE_ROOT)
    assert res_exp["golden_fixtures_bytes"] < 250 * 1024
