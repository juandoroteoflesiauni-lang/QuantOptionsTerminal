"""100% offline Phase 2 Policy & Golden Fixture exporter (Prompt #7).

Reads only sealed local Parquet artifacts under ``research/avwap_oracle/data/``
and emits:
  - ``research/avwap_oracle/spec/avwap_context_policy.json``
  - ``research/avwap_oracle/spec/golden_fixtures/avwap_phase2_golden_fixtures.json``

CLI usage (always with ``UV_OFFLINE=1``):
    UV_OFFLINE=1 uv run --locked python -m avwap_oracle.export_phase2_spec
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import numpy as np
import polars as pl

from avwap_oracle.math_core.canonical_rth import (
    WeightedMomentState,
    build_canonical_rth_bars_with_audit,
    compute_hybrid_bands,
    merge_moments,
)
from avwap_oracle.math_core.corp_actions import (
    CorporateSplitEvent,
    apply_special_dividend_o1,
    apply_split_o1,
    apply_split_schedule_to_canonical_bars,
)
from avwap_oracle.math_core.nyse_calendar import get_session_bounds
from avwap_oracle.oracle.candidates import generate_causal_candidates
from avwap_oracle.run_oracle import default_oracle_root, write_strict_json
from avwap_oracle.scoring.confluence import (
    compute_bsm_second_order_greeks,
    compute_confluence_context,
    save_avwap_context_policy,
)
from avwap_oracle.scoring.iass import IassConfig, compute_iass
from avwap_oracle.scoring.lifecycle import AnchorSeriesInput, LifecycleConfig, run_lifecycle_fsm

GOLDEN_FIXTURE_SCHEMA_VERSION = "avwap_phase2_golden_fixtures_v1_2026_11_25"


def _trading_dates(start_date: str, count: int) -> list[str]:
    import datetime as dt

    out: list[str] = []
    cur = dt.date.fromisoformat(start_date)
    while len(out) < count:
        if get_session_bounds(cur) is not None:
            out.append(cur.isoformat())
        cur += dt.timedelta(days=1)
    return out


def _accumulate_state(df_rows: pl.DataFrame) -> WeightedMomentState:
    st = WeightedMomentState.neutral()
    for r in df_rows.iter_rows(named=True):
        st = merge_moments(
            st,
            WeightedMomentState(
                total_volume=float(r["W"]),
                vwap=float(r["mu"]),
                m2=float(r["M2_within"]),
            ),
        )
    return st


def _build_case1_nvda(data_dir: Path) -> dict[str, Any]:
    raw_p = data_dir / "raw" / "massive_1m" / "NVDA" / "2024.parquet"
    sb_start = get_session_bounds("2024-06-05")
    sb_end = get_session_bounds("2024-06-12")
    assert sb_start is not None and sb_end is not None

    df_1m_raw = (
        pl.read_parquet(raw_p)
        .filter(
            (pl.col("ts_utc_s") >= sb_start.rth_open_utc_s)
            & (pl.col("ts_utc_s") < sb_end.rth_close_utc_s)
        )
        .rename({"v": "volume"})
        .sort("ts_utc_s")
    )

    rollup_tfs = ("1m", "5m", "65m", "1D")
    split_ev = CorporateSplitEvent(
        event_id="NVDA:2024-06-10",
        ticker="NVDA",
        effective_date="2024-06-10",
        split_from=1.0,
        split_to=10.0,
    )

    daily_by_tf: dict[str, dict[str, dict[str, float]]] = {}
    cum_final_by_tf: dict[str, dict[str, float]] = {}
    pre_split_state_1d: WeightedMomentState | None = None
    post_split_state_1d: WeightedMomentState | None = None

    for tf in rollup_tfs:
        bars_tf, rep = build_canonical_rth_bars_with_audit(df_1m_raw, tf)
        per_day: dict[str, dict[str, float]] = {}
        for td_key, sub in bars_tf.group_by("trade_date", maintain_order=True):
            td = str(td_key[0] if isinstance(td_key, tuple) else td_key)
            st_day = _accumulate_state(sub.sort("ts_open_utc_s"))
            per_day[td] = {
                "W": st_day.total_volume,
                "mu": st_day.vwap,
                "M2": st_day.m2,
                "std_dev": st_day.std_dev,
                "buckets": float(sub.height),
            }
        daily_by_tf[tf] = per_day

        sched_res = apply_split_schedule_to_canonical_bars(bars_tf, [split_ev], anchor_idx=0)
        last_row = sched_res.bars.tail(1).to_dicts()[0]
        cum_final_by_tf[tf] = {
            "accepted_1m_rows": float(rep.accepted_rth_1m_rows),
            "buckets_count": float(bars_tf.height),
            "final_cum_W": float(last_row["cum_W"]),
            "final_avwap_mu": float(last_row["avwap_mu"]),
            "final_cum_M2": float(last_row["cum_M2"]),
            "final_avwap_sd": float(last_row["avwap_sd"]),
        }
        if tf == "1D" and sched_res.applied_audits:
            pre_split_state_1d = sched_res.applied_audits[0].pre_state
            post_split_state_1d = sched_res.applied_audits[0].post_state

    assert pre_split_state_1d is not None and post_split_state_1d is not None
    manual_post = apply_split_o1(pre_split_state_1d, 1.0, 10.0)
    ref_mu = cum_final_by_tf["1m"]["final_avwap_mu"]
    ref_sd = cum_final_by_tf["1m"]["final_avwap_sd"]
    max_mu_bps = max(
        abs(v["final_avwap_mu"] - ref_mu) / ref_mu * 1e4 for v in cum_final_by_tf.values()
    )
    max_sd_bps = max(
        abs(v["final_avwap_sd"] - ref_sd) / ref_sd * 1e4 for v in cum_final_by_tf.values()
    )

    # Real NVDA EARNINGS_BLOWOUT (2024-02-21 AMC) vs EARNINGS_INLINE (2024-11-20 AMC)
    nv_1d = pl.read_parquet(data_dir / "canonical" / "rth_1D" / "NVDA.parquet")
    nv_sp_df = pl.read_parquet(data_dir / "events" / "corporate_actions" / "NVDA_splits.parquet")
    nv_dv_df = pl.read_parquet(data_dir / "events" / "corporate_actions" / "NVDA_dividends.parquet")
    nv_er_df = pl.read_parquet(data_dir / "events" / "earnings_reconciled" / "NVDA.parquet")
    nv_oc_df = pl.read_parquet(data_dir / "derivatives" / "orats_cores" / "NVDA.parquet")
    nv_os_df = pl.read_parquet(data_dir / "derivatives" / "orats_summaries" / "NVDA.parquet")
    nv_roi_df = pl.read_parquet(data_dir / "derivatives" / "reconciled_oi" / "NVDA.parquet")

    nv_splits = [
        CorporateSplitEvent(
            event_id=f"NVDA:{r['effective_date']}",
            ticker="NVDA",
            effective_date=str(r["effective_date"])[:10],
            split_from=float(r["split_from_canonical"]),
            split_to=float(r["split_to_canonical"]),
        )
        for r in nv_sp_df.iter_rows(named=True)
        if bool(r.get("safe_to_apply"))
    ]
    cands_res = generate_causal_candidates(
        ticker="NVDA",
        asset_class="US_EQUITY",
        bars_1d=nv_1d,
        splits=nv_splits,
        dividends_df=nv_dv_df,
        earnings_reconciled_df=nv_er_df,
        orats_cores_df=nv_oc_df,
        orats_summaries_df=nv_os_df,
        reconciled_oi_df=nv_roi_df,
        iass_config=IassConfig(),
    )

    def _extract_earn(react_date: str) -> dict[str, Any]:
        matches = [
            c
            for c in cands_res.candidates
            if c.family in ("EARNINGS_BLOWOUT", "EARNINGS_INLINE")
            and f":{react_date}:" in c.anchor_id
        ]
        assert len(matches) == 1, f"Expected 1 NVDA earnings candidate on {react_date}, got {len(matches)}"
        c = matches[0]
        return {
            "anchor_id": c.anchor_id,
            "family": c.family,
            "polarity": c.polarity,
            "react_date": react_date,
            "anchor_idx": c.anchor_idx,
            "activated_idx": c.activated_idx,
            "data_coverage": c.data_coverage,
            "is_negative_control": c.is_negative_control,
            "score_renormalized": c.iass.score_renormalized,
            "score_conservative": c.iass.score_conservative,
            "tier": c.iass.tier,
            "component_scores": dict(c.iass.component_scores),
            "pillar_scores": dict(c.iass.pillar_scores),
            "degradation_reasons": list(c.iass.degradation_reasons),
        }

    return {
        "ticker": "NVDA",
        "split_window_2024_06_05_to_12": {
            "split_event": {"effective_date": "2024-06-10", "split_from": 1.0, "split_to": 10.0, "k_factor": 0.1},
            "o1_split_step_proof_1d": {
                "pre_split_cum_2024_06_07": {
                    "W": pre_split_state_1d.total_volume,
                    "mu": pre_split_state_1d.vwap,
                    "M2": pre_split_state_1d.m2,
                    "std_dev": pre_split_state_1d.std_dev,
                },
                "post_split_o1_2024_06_10_open": {
                    "W": manual_post.total_volume,
                    "mu": manual_post.vwap,
                    "M2": manual_post.m2,
                    "std_dev": manual_post.std_dev,
                },
                "audit_matches_o1": math.isclose(post_split_state_1d.vwap, manual_post.vwap, rel_tol=1e-12)
                and math.isclose(post_split_state_1d.m2, manual_post.m2, rel_tol=1e-12),
            },
            "daily_moments_by_tf": daily_by_tf,
            "cumulative_split_adjusted_by_tf": cum_final_by_tf,
            "cross_tf_parity_max_mu_bps": max_mu_bps,
            "cross_tf_parity_max_sd_bps": max_sd_bps,
        },
        "earnings_comparison": {
            "blowout_2024_02_21_amc": _extract_earn("2024-02-22"),
            "inline_2024_11_20_amc": _extract_earn("2024-11-21"),
        },
    }


def _build_case2_spy(data_dir: Path) -> dict[str, Any]:
    spy_1d = pl.read_parquet(data_dir / "canonical" / "rth_1D" / "SPY.parquet").sort("trade_date")
    spy_co = pl.read_parquet(data_dir / "derivatives" / "orats_cores" / "SPY.parquet")
    spy_sum = pl.read_parquet(data_dir / "derivatives" / "orats_summaries" / "SPY.parquet")
    spy_oi = pl.read_parquet(data_dir / "derivatives" / "reconciled_oi" / "SPY.parquet")
    spy_gx = pl.read_parquet(data_dir / "derivatives" / "orats_gex_opex" / "SPY.parquet")
    spy_wh = pl.read_parquet(data_dir / "derivatives" / "orats_wham" / "SPY.parquet")

    iv_by_td = {
        str(r["trade_date"])[:10]: float(r["or_iv_xern_20d_dec"])
        for r in spy_co.iter_rows(named=True)
        if r.get("or_iv_xern_20d_dec") is not None and math.isfinite(float(r["or_iv_xern_20d_dec"]))
    }
    ytd_rows = spy_1d.filter((pl.col("trade_date") >= "2024-01-02") & (pl.col("trade_date") <= "2024-02-05")).to_dicts()
    target_offsets = (0, 1, 2, 5, 20)
    st = WeightedMomentState.neutral()
    ytd_trajectory: list[dict[str, Any]] = []
    for day_idx, r in enumerate(ytd_rows):
        st = merge_moments(
            st,
            WeightedMomentState(total_volume=float(r["W"]), vwap=float(r["mu"]), m2=float(r["M2_within"])),
        )
        if day_idx in target_offsets:
            td = str(r["trade_date"])[:10]
            or_iv = iv_by_td.get(td)
            hb = compute_hybrid_bands(st.vwap, st.std_dev, or_iv, float(day_idx), tau0=2.0)
            ytd_trajectory.append(
                {
                    "elapsed_trading_days": day_idx,
                    "trade_date": td,
                    "W": st.total_volume,
                    "avwap_mu": hb.avwap_mu,
                    "welford_sd": hb.welford_sd,
                    "or_iv_xern_20d_dec": or_iv,
                    "alpha": hb.alpha,
                    "sigma_orats_path": hb.sigma_orats_path if math.isfinite(hb.sigma_orats_path) else None,
                    "sigma_hybrid": hb.sigma_hybrid,
                    "upper_1": hb.upper_1,
                    "lower_1": hb.lower_1,
                    "upper_2": hb.upper_2,
                    "lower_2": hb.lower_2,
                    "upper_2_5": hb.upper_2_5,
                    "lower_2_5": hb.lower_2_5,
                    "band_source": hb.band_source,
                }
            )

    # Compact WHAM snapshot
    wh_row = spy_wh.filter(pl.col("trade_date") == "2023-01-12").to_dicts()[0]
    wh_payload = json.loads(str(wh_row["payload_json"]))
    cpi_events = [
        ev for ev in (wh_payload.get("calendar") or []) if isinstance(ev, dict) and ev.get("eventType") in ("CPI", "FOMC", "PCE", "Jobs (NFP)")
    ][:3]

    # OI Fallback 2025-10-06
    oi_fb = spy_oi.filter(pl.col("trade_date") == "2025-10-06").to_dicts()[0]

    # DollarVol_20d reference near GEX snapshots
    dv_series = (spy_1d["c"] * spy_1d["W"]).tail(20).to_list()
    dvol_20d = float(sum(dv_series) / len(dv_series))
    atr_ref = 7.50

    gx_pos = spy_gx.filter(pl.col("trade_date") == "2026-10-15").to_dicts()[0]
    sum_pos = spy_sum.filter(pl.col("trade_date") == "2026-10-15").to_dicts()[0]
    spot_pos = float(gx_pos["massive_spot"])
    conf_pos = compute_confluence_context(
        avwap_price=float(gx_pos["call_wall_strike"]) - 0.15,
        spot_price=spot_pos,
        atr14=atr_ref,
        polarity="LONG",
        net_gex=float(gx_pos["net_gex_raw_gamma_oi"]),
        dollar_vol_20d=dvol_20d * 1e-4,  # scaled to showcase g > 0.3 with real OPEX raw units
        call_wall=float(gx_pos["call_wall_strike"]),
        put_wall=float(gx_pos["put_wall_strike"]),
        zero_gamma=float(gx_pos["zero_gamma_est"]),
        vp_poc=spot_pos - 1.0,
        vp_vah=float(gx_pos["call_wall_strike"]),
        vp_val=spot_pos - 5.0,
        vp_hvns=[float(gx_pos["call_wall_strike"])],
        vp_lvns=[spot_pos + 4.0],
        cvd_absorption_score=0.82,
        cvd_directional_alignment=0.25,
        bucket_rvol_z=0.9,
        contango=float(sum_pos["contango"]),
        spy_iv30d_dec=float(sum_pos["iv_30d_summary_dec"]),
        sigma_hybrid=2.0,
    )

    gx_neg = spy_gx.filter(pl.col("trade_date") == "2026-11-19").to_dicts()[0]
    sum_neg = spy_sum.filter(pl.col("trade_date") == "2026-11-19").to_dicts()[0]
    spot_neg = float(gx_neg["massive_spot"])
    conf_neg = compute_confluence_context(
        avwap_price=float(gx_neg["zero_gamma_est"]) - 0.50,
        spot_price=spot_neg,
        atr14=atr_ref,
        polarity="LONG",
        net_gex=float(gx_neg["net_gex_raw_gamma_oi"]),
        dollar_vol_20d=dvol_20d * 1e-4,
        call_wall=float(gx_neg["call_wall_strike"]),
        put_wall=float(gx_neg["put_wall_strike"]),
        zero_gamma=float(gx_neg["zero_gamma_est"]),
        vp_poc=spot_neg + 5.0,
        vp_vah=float(gx_neg["call_wall_strike"]),
        vp_val=float(gx_neg["put_wall_strike"]),
        vp_hvns=[float(gx_neg["put_wall_strike"])],
        vp_lvns=[float(gx_neg["zero_gamma_est"])],
        cvd_absorption_score=0.45,
        cvd_directional_alignment=0.88,
        bucket_rvol_z=2.4,
        contango=float(sum_neg["contango"]),
        spy_iv30d_dec=float(sum_neg["iv_30d_summary_dec"]),
        sigma_hybrid=3.5,
    )

    # Identical-level controlled pair for parity testing regime effect
    conf_ctrl_pos = compute_confluence_context(
        avwap_price=718.0,
        spot_price=spot_neg,
        atr14=atr_ref,
        polarity="LONG",
        net_gex=3_500_000.0,
        dollar_vol_20d=700_000_000.0,
        call_wall=720.0,
        put_wall=710.0,
        zero_gamma=717.5,
        vp_poc=717.8,
        vp_vah=719.5,
        vp_val=714.0,
        vp_hvns=[718.0],
        vp_lvns=[717.5],
        cvd_absorption_score=0.75,
        cvd_directional_alignment=0.70,
        bucket_rvol_z=1.8,
        contango=0.45,
        spy_iv30d_dec=0.22,
    )
    conf_ctrl_neg = compute_confluence_context(
        avwap_price=718.0,
        spot_price=spot_neg,
        atr14=atr_ref,
        polarity="LONG",
        net_gex=-3_500_000.0,
        dollar_vol_20d=700_000_000.0,
        call_wall=720.0,
        put_wall=710.0,
        zero_gamma=717.5,
        vp_poc=717.8,
        vp_vah=719.5,
        vp_val=714.0,
        vp_hvns=[718.0],
        vp_lvns=[717.5],
        cvd_absorption_score=0.75,
        cvd_directional_alignment=0.70,
        bucket_rvol_z=1.8,
        contango=0.45,
        spy_iv30d_dec=0.22,
    )

    sum_1123 = spy_sum.filter(pl.col("trade_date") == "2026-11-23").to_dicts()[0]
    bsm_call = compute_bsm_second_order_greeks(
        spot=spot_neg,
        strike=720.0,
        dte_days=30.0,
        smv_vol=float(sum_1123["iv_30d_summary_dec"]),
        risk_free=float(sum_1123["risk_free_30"]),
        residual_rate=float(sum_1123["risk_free_30"]) - 0.013,
        contract_type="call",
    )
    bsm_put = compute_bsm_second_order_greeks(
        spot=spot_neg,
        strike=720.0,
        dte_days=30.0,
        smv_vol=float(sum_1123["iv_30d_summary_dec"]),
        risk_free=float(sum_1123["risk_free_30"]),
        residual_rate=float(sum_1123["risk_free_30"]) - 0.013,
        contract_type="put",
    )

    def _conf_dict(res: Any) -> dict[str, Any]:
        return {
            "bounce_confluence": res.bounce_confluence,
            "breakout_confluence": res.breakout_confluence,
            "net_gex_normalized_g": res.net_gex_normalized_g,
            "g0_dollar_vol_scale": res.g0_dollar_vol_scale,
            "gamma_regime": res.gamma_regime,
            "vol_regime": res.vol_regime,
            "mean_reversion_context_active": res.mean_reversion_context_active,
            "hazard_flags": list(res.hazard_flags),
            "degradation_flags": list(res.degradation_flags),
            "spatial_kernels": dict(res.spatial_kernels),
        }

    return {
        "ticker": "SPY",
        "calendar_ytd_2024_hybrid_bands": ytd_trajectory,
        "wham_macro_sample_2023_01_12": {
            "trade_date": wh_row["trade_date"],
            "wham_status": wh_row["wham_status"],
            "tier1_events": cpi_events,
        },
        "reconciled_oi_fallback_2025_10_06": oi_fb,
        "confluence_scenarios": {
            "real_positive_gamma_2026_10_15": _conf_dict(conf_pos),
            "real_negative_gamma_2026_11_19": _conf_dict(conf_neg),
            "controlled_parity_pair_pos": _conf_dict(conf_ctrl_pos),
            "controlled_parity_pair_neg": _conf_dict(conf_ctrl_neg),
        },
        "bsm_second_order_greeks": {
            "call_720": bsm_call.__dict__,
            "put_720": bsm_put.__dict__,
        },
    }


def _build_case3_meli(data_dir: Path) -> dict[str, Any]:
    meli_1d = pl.read_parquet(data_dir / "canonical" / "rth_1D" / "MELI.parquet")
    meli_er = pl.read_parquet(data_dir / "events" / "earnings_reconciled" / "MELI.parquet")
    meli_co = pl.read_parquet(data_dir / "derivatives" / "orats_cores" / "MELI.parquet")
    meli_os = pl.read_parquet(data_dir / "derivatives" / "orats_summaries" / "MELI.parquet")
    meli_roi = pl.read_parquet(data_dir / "derivatives" / "reconciled_oi" / "MELI.parquet")

    cands_with = generate_causal_candidates(
        ticker="MELI",
        asset_class="US_ADR",
        bars_1d=meli_1d,
        earnings_reconciled_df=meli_er,
        orats_cores_df=meli_co,
        orats_summaries_df=meli_os,
        reconciled_oi_df=meli_roi,
        iass_config=IassConfig(),
    )
    target = [
        c for c in cands_with.candidates
        if c.family in ("EARNINGS_BLOWOUT", "EARNINGS_INLINE") and ":2024-08-02:" in c.anchor_id
    ][0]

    # Same real underlying features from bars_enriched & orats_summaries, simulated without ORATS coverage
    from avwap_oracle.scoring.iass import IassFeatures

    b_enr = cands_with.bars_enriched
    b_row = b_enr.filter(pl.col("trade_date") == "2024-08-02").to_dicts()[0]
    os_prev = meli_os.filter(pl.col("trade_date") == "2024-08-01").to_dicts()[0]
    pc = float(b_row["prev_close_causal"])
    atr_p = float(b_row["atr14_prev"])
    atr_c = float(b_row["atr14"])
    f_real = IassFeatures(
        family=target.family,
        polarity=target.polarity,
        feature_asof=target.feature_asof,
        orats_opra_covered=False,
        oi_source=None,
        rvol_z=float(b_row["rvol_z"]) if b_row.get("rvol_z") is not None else None,
        realized_return=(float(b_row["c"]) - pc) / pc,
        realized_return_start_ts_utc_s=int(b_enr.filter(pl.col("trade_date") == "2024-08-01")["ts_close_utc_s"][0]),
        implied_move_dec=float(os_prev["implied_earnings_move_dec"]),
        implied_move_available_at_utc_s=int(b_enr.filter(pl.col("trade_date") == "2024-08-01")["ts_close_utc_s"][0]),
        oi_gex_shock=None,
        iv_change_z=None,
        catalyst_data_available=True,
        gap_atr=abs(float(b_row["o"]) - pc) / atr_p,
        close_disp_atr=abs(float(b_row["c"]) - float(b_row["o"])) / atr_c,
        atr_valid=True,
        atr_available_at_utc_s=target.feature_asof,
    )
    bd_no_orats = compute_iass(f_real, IassConfig())
    assert bd_no_orats.score_renormalized is not None
    expected_cons = bd_no_orats.data_coverage * bd_no_orats.score_renormalized + (1.0 - bd_no_orats.data_coverage) * 35.0

    return {
        "ticker": "MELI",
        "asset_class": "US_ADR",
        "anchor_id": target.anchor_id,
        "with_orats": {
            "family": target.family,
            "data_coverage": target.data_coverage,
            "score_renormalized": target.iass.score_renormalized,
            "score_conservative": target.iass.score_conservative,
            "tier": target.iass.tier,
            "pillar_scores": dict(target.iass.pillar_scores),
        },
        "without_orats_simulated_degradation": {
            "data_coverage": bd_no_orats.data_coverage,
            "score_renormalized": bd_no_orats.score_renormalized,
            "score_conservative": bd_no_orats.score_conservative,
            "expected_bayesian_shrinkage": expected_cons,
            "prior": 35.0,
            "degradation_flag": "NO_ORATS_COVERAGE",
            "degradation_reasons": list(bd_no_orats.degradation_reasons),
        },
    }


def _build_case4_cost(data_dir: Path) -> dict[str, Any]:
    cost_1d = pl.read_parquet(data_dir / "canonical" / "rth_1D" / "COST.parquet").sort("trade_date")
    cost_dv = pl.read_parquet(data_dir / "events" / "corporate_actions" / "COST_dividends.parquet")

    dv_special = cost_dv.filter(pl.col("ex_dividend_date") == "2023-12-27").to_dicts()[0]
    dv_regular = cost_dv.filter(pl.col("ex_dividend_date") == "2026-05-01").to_dicts()[0]

    pre_spec_bars = cost_1d.filter((pl.col("trade_date") >= "2023-12-19") & (pl.col("trade_date") <= "2023-12-26"))
    pre_spec_state = _accumulate_state(pre_spec_bars)
    prev_close_spec = float(pre_spec_bars.tail(1)["c"][0])
    post_spec_state, spec_applied = apply_special_dividend_o1(
        pre_spec_state, float(dv_special["cash_amount_canonical"]), prev_close_spec, min_pct=0.015
    )

    pre_reg_bars = cost_1d.filter((pl.col("trade_date") >= "2026-04-24") & (pl.col("trade_date") <= "2026-04-30"))
    pre_reg_state = _accumulate_state(pre_reg_bars)
    prev_close_reg = float(pre_reg_bars.tail(1)["c"][0])
    post_reg_state, reg_applied = apply_special_dividend_o1(
        pre_reg_state, float(dv_regular["cash_amount_canonical"]), prev_close_reg, min_pct=0.015
    )

    def _st_dict(s: WeightedMomentState) -> dict[str, float]:
        return {"W": s.total_volume, "mu": s.vwap, "M2": s.m2, "std_dev": s.std_dev}

    return {
        "ticker": "COST",
        "special_dividend_2023_12_27": {
            "cash_amount": float(dv_special["cash_amount_canonical"]),
            "prev_close": prev_close_spec,
            "yield_ratio": float(dv_special["cash_amount_canonical"]) / prev_close_spec,
            "d_factor": (prev_close_spec - float(dv_special["cash_amount_canonical"])) / prev_close_spec,
            "applied": spec_applied,
            "pre_state": _st_dict(pre_spec_state),
            "post_state": _st_dict(post_spec_state),
        },
        "regular_dividend_2026_05_01": {
            "cash_amount": float(dv_regular["cash_amount_canonical"]),
            "prev_close": prev_close_reg,
            "yield_ratio": float(dv_regular["cash_amount_canonical"]) / prev_close_reg,
            "applied": reg_applied,
            "pre_state": _st_dict(pre_reg_state),
            "post_state": _st_dict(post_reg_state),
        },
    }


def _build_case5_fsm() -> dict[str, Any]:
    cfg = LifecycleConfig()
    dates = _trading_dates("2024-01-02", 25)
    ts = [int(get_session_bounds(d).rth_open_utc_s) for d in dates]  # type: ignore[union-attr]

    # Sequence A (15 bars): CANDIDATE -> ACTIVE_PRIMARY/SECONDARY, PINCH_PAIR, PINCH_BREAKOUT (>0.35 ATR),
    # COHORT_DECAY (S_cohort < 0.20) & ARCHIVED (far-dist + 5-session decay timeout)
    n15 = 15
    closes_a = [100.2, 100.2, 100.2, 100.2, 100.85, 100.85, 100.85, 100.85, 100.85, 100.85, 100.85, 100.85, 100.85, 100.85, 100.85]
    highs_a = [c + 0.3 for c in closes_a]
    lows_a = [c - 0.3 for c in closes_a]
    av_long = [100.0] * n15
    av_short = [101.0, 100.8, 100.6, 100.4, 100.4] + [100.4] * (n15 - 5)
    av_cohort = [93.0] * n15
    res_a = run_lifecycle_fsm(
        timeframe="1D",
        bar_ts_utc_s=ts[:n15],
        highs=highs_a,
        lows=lows_a,
        closes=closes_a,
        volumes=[850.0] * n15,
        atr14=[1.0] * n15,
        anchors=[
            AnchorSeriesInput(
                anchor_id="fsm_long",
                family="EARNINGS_BLOWOUT",
                polarity="LONG",
                anchor_idx=0,
                activated_idx=0,
                anchor_ts=ts[0],
                available_at_utc_s=ts[0],
                score_original=78.0,
                avwap_series=tuple(av_long),
            ),
            AnchorSeriesInput(
                anchor_id="fsm_short",
                family="BREAKAWAY_GAP",
                polarity="SHORT",
                anchor_idx=0,
                activated_idx=0,
                anchor_ts=ts[0],
                available_at_utc_s=ts[0],
                score_original=62.0,
                avwap_series=tuple(av_short),
            ),
            AnchorSeriesInput(
                anchor_id="fsm_cohort",
                family="VOLUME_CLIMAX",
                polarity="LONG",
                anchor_idx=0,
                activated_idx=0,
                anchor_ts=ts[0],
                available_at_utc_s=ts[0],
                score_original=74.0,
                avwap_series=tuple(av_cohort),
                free_float_at_anchor=1000.0,
                float_is_pit=True,
            ),
        ],
        config=cfg,
    )

    # Sequence B (15 bars): CHOP_SATURATION -> ARCHIVED_DECAY_TIMEOUT
    closes_b = [100.5, 99.5, 100.5, 99.5, 100.3, 100.3, 100.3, 100.3, 100.3, 100.3, 100.3, 100.3, 100.3, 100.3, 100.3]
    highs_b = [c + 0.1 for c in closes_b]
    lows_b = [c - 0.1 for c in closes_b]
    res_b = run_lifecycle_fsm(
        timeframe="1D",
        bar_ts_utc_s=ts[:n15],
        highs=highs_b,
        lows=lows_b,
        closes=closes_b,
        volumes=[1_000_000.0] * n15,
        atr14=[1.0] * n15,
        anchors=[
            AnchorSeriesInput(
                anchor_id="fsm_chop",
                family="BREAKAWAY_GAP",
                polarity="LONG",
                anchor_idx=0,
                activated_idx=0,
                anchor_ts=ts[0],
                available_at_utc_s=ts[0],
                score_original=72.0,
                avwap_series=tuple([100.0] * n15),
            )
        ],
        config=cfg,
    )

    # Sequence C (25 bars): FLAT_SLOPE -> BREAKOUT_RESURRECTION (excursion >= 1.0 ATR, chop < 2, |s_norm| >= 0.08, dwell=2)
    n25 = 25
    closes_c = [100.1] * 15 + [101.5, 102.0, 102.5] + [102.5] * (n25 - 18)
    highs_c = [c + 0.1 for c in closes_c]
    lows_c = [c - 0.1 for c in closes_c]
    av_res = [100.0] * 15 + [100.25, 100.6, 101.0, 101.2] + [101.2] * (n25 - 19)
    res_c = run_lifecycle_fsm(
        timeframe="1D",
        bar_ts_utc_s=ts[:n25],
        highs=highs_c,
        lows=lows_c,
        closes=closes_c,
        volumes=[1_000_000.0] * n25,
        atr14=[1.0] * n25,
        anchors=[
            AnchorSeriesInput(
                anchor_id="fsm_res",
                family="BREAKAWAY_GAP",
                polarity="LONG",
                anchor_idx=0,
                activated_idx=0,
                anchor_ts=ts[0],
                available_at_utc_s=ts[0],
                score_original=72.0,
                avwap_series=tuple(av_res),
            )
        ],
        config=cfg,
    )

    def _tr_list(sim_res: Any) -> list[dict[str, Any]]:
        return [
            {
                "anchor_id": tr.anchor_id,
                "previous_state": tr.previous_state,
                "next_state": tr.next_state,
                "transition_reason": tr.transition_reason,
                "effective_ts": tr.effective_ts,
                "score_at_transition": tr.score_at_transition,
            }
            for tr in sim_res.transitions
        ]

    return {
        "pinch_breakout_cohort_decay_15bars": {
            "bar_count": n15,
            "transitions": _tr_list(res_a),
            "final_states": {k: v.state for k, v in res_a.final_snapshots.items()},
        },
        "chop_saturation_archival_15bars": {
            "bar_count": n15,
            "transitions": _tr_list(res_b),
            "final_states": {k: v.state for k, v in res_b.final_snapshots.items()},
        },
        "flat_decay_breakout_resurrection_25bars": {
            "bar_count": n25,
            "transitions": _tr_list(res_c),
            "final_states": {k: v.state for k, v in res_c.final_snapshots.items()},
        },
    }


def export_phase2_artifacts(root: Path | None = None) -> dict[str, Any]:
    r_dir = root if root is not None else default_oracle_root()
    data_dir = r_dir / "data"
    spec_dir = r_dir / "spec"

    policy_payload = save_avwap_context_policy(spec_dir / "avwap_context_policy.json")
    fixtures_payload: dict[str, Any] = {
        "schema_version": GOLDEN_FIXTURE_SCHEMA_VERSION,
        "generated_offline": True,
        "source_policy_version": policy_payload["policy_version"],
        "case1_nvda_split_and_earnings": _build_case1_nvda(data_dir),
        "case2_spy_ytd_wham_oi_gex_bsm": _build_case2_spy(data_dir),
        "case3_meli_adr_bayesian_degradation": _build_case3_meli(data_dir),
        "case4_cost_special_vs_regular_dividend": _build_case4_cost(data_dir),
        "case5_fsm_pinch_breakout_resurrection": _build_case5_fsm(),
    }

    gf_path = spec_dir / "golden_fixtures" / "avwap_phase2_golden_fixtures.json"
    gf_sha = write_strict_json(gf_path, fixtures_payload)
    return {
        "policy_path": str(spec_dir / "avwap_context_policy.json"),
        "golden_fixtures_path": str(gf_path),
        "golden_fixtures_bytes": gf_path.stat().st_size,
        "golden_fixtures_sha256": gf_sha,
    }


def main() -> int:
    summary = export_phase2_artifacts()
    print(json.dumps(summary, indent=2, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
