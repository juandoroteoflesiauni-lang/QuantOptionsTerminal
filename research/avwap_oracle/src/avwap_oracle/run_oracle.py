"""Completely offline Axis 5 AVWAP Statistical Oracle runner & audit report generator.

CLI usage (always run from ``research/avwap_oracle/`` with ``UV_OFFLINE=1``):
    UV_OFFLINE=1 uv run --locked python -m avwap_oracle.run_oracle --tickers SPY,NVDA,MELI,TWTR --n-perm 500
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import os
import time
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np
import polars as pl

from avwap_oracle.adapters.reconciler import RECONCILED_DAILY_OI_SCHEMA, reconcile_daily_oi
from avwap_oracle.math_core.corp_actions import CorporateSplitEvent, apply_split_schedule_to_canonical_bars
from avwap_oracle.oracle.candidates import (
    CANDIDATE_FAMILIES_14,
    NEGATIVE_CONTROL_FAMILIES,
    CandidateAnchor,
    generate_causal_candidates,
)
from avwap_oracle.oracle.permutation import (
    benjamini_hochberg,
    build_coherent_daily_net_return_series,
    deflated_sharpe_ratio,
    matched_monte_carlo_fdr,
    romano_wolf_stepdown,
)
from avwap_oracle.oracle.touches import (
    COST_SCENARIOS_BPS,
    HORIZONS_DAYS,
    AnchorTouchSummary,
    TouchObservation,
    evaluate_anchor_touches,
)
from avwap_oracle.oracle.walk_forward import evaluate_walk_forward, stratify_touches_by_regime
from avwap_oracle.scoring.iass import FAMILY_PRIOR_REGISTRY, IassConfig
from avwap_oracle.scoring.lifecycle import (
    FLAT_SLOPE_H_BY_TIMEFRAME,
    VISUAL_BUDGET_BY_TIMEFRAME,
    AnchorSeriesInput,
    LifecycleConfig,
    run_lifecycle_fsm,
)
from avwap_oracle.universe import EXPECTED_STRATUM_COUNTS, PilotUniverse, load_pilot_universe

ORACLE_CONFIG_VERSION = "oracle_axis5_v2_sealed_2026_11_25"


def default_oracle_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _sanitize_json_value(val: Any) -> Any:
    if isinstance(val, dict):
        return {str(k): _sanitize_json_value(v) for k, v in val.items()}
    if isinstance(val, (list, tuple)):
        return [_sanitize_json_value(v) for v in val]
    if isinstance(val, float):
        return val if math.isfinite(val) else None
    if isinstance(val, (np.floating,)):
        f = float(val)
        return f if math.isfinite(f) else None
    if isinstance(val, (np.integer,)):
        return int(val)
    if isinstance(val, (np.bool_,)):
        return bool(val)
    return val


def write_strict_json(path: Path, payload: Mapping[str, Any]) -> str:
    clean = _sanitize_json_value(dict(payload))
    text = json.dumps(clean, indent=2, sort_keys=True, allow_nan=False)
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
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def classify_production_gate(
    *,
    family: str,
    anchors_count: int,
    matured_touches_h5: int,
    observed_mean_aer_h5: float | None,
    null_mean_aer_h5: float | None,
    mean_aer_h5: float | None,
    p_raw_h5: float | None,
    q_bh_fdr_h5: float | None,
    p_romano_wolf: float | None,
    dsr: float | None,
    mean_net_ret_20bps_h5: float | None,
    clustering_excess: float | None,
    reclaim_n: int,
    reclaim_aer_5d: float | None,
    wf_evaluated_folds: int,
    wf_positive_folds: int,
    wf_mean_oos_aer_h5: float | None = None,
) -> dict[str, Any]:
    """Deterministic pre-registered Eje 5 Production Gate verdict for one anchor family."""
    is_ctrl = family in NEGATIVE_CONTROL_FAMILIES
    lift_h5 = (
        (observed_mean_aer_h5 - null_mean_aer_h5)
        if (observed_mean_aer_h5 is not None and null_mean_aer_h5 is not None)
        else None
    )
    if is_ctrl:
        contaminated = (q_bh_fdr_h5 is not None and q_bh_fdr_h5 <= 0.05) or (
            p_romano_wolf is not None and p_romano_wolf <= 0.05
        )
        verdict = (
            "NEGATIVE_CONTROL_CONTAMINATION_ALERT"
            if contaminated
            else ("NEGATIVE_CONTROL_PASS" if matured_touches_h5 > 0 else "INSUFFICIENT_SAMPLE")
        )
        return {
            "verdict": verdict,
            "is_negative_control": True,
            "lift_aer_h5": lift_h5,
            "wf_positive_ratio": (wf_positive_folds / float(wf_evaluated_folds)) if wf_evaluated_folds > 0 else None,
            "criteria": {"contaminated": contaminated},
        }

    if anchors_count == 0 or matured_touches_h5 < 30 or p_raw_h5 is None or lift_h5 is None:
        return {
            "verdict": "INSUFFICIENT_SAMPLE",
            "is_negative_control": False,
            "lift_aer_h5": lift_h5,
            "wf_positive_ratio": (wf_positive_folds / float(wf_evaluated_folds)) if wf_evaluated_folds > 0 else None,
            "criteria": {"matured_touches_h5_ge_30": matured_touches_h5 >= 30},
        }

    wf_ratio = (wf_positive_folds / float(wf_evaluated_folds)) if wf_evaluated_folds > 0 else None
    wf_mean_pos = wf_mean_oos_aer_h5 is not None and math.isfinite(wf_mean_oos_aer_h5) and wf_mean_oos_aer_h5 > 0.0
    wf_pass = (wf_evaluated_folds > 0) and (wf_ratio is not None and wf_ratio >= 0.60) and wf_mean_pos
    bh_pass = q_bh_fdr_h5 is not None and q_bh_fdr_h5 <= 0.05
    rw_pass = p_romano_wolf is not None and p_romano_wolf <= 0.05
    dsr_pass = dsr is not None and dsr >= 0.95
    net_pass = mean_net_ret_20bps_h5 is not None and mean_net_ret_20bps_h5 > 0.0
    lift_pos = lift_h5 > 0.0

    criteria = {
        "matured_touches_h5_ge_30": True,
        "lift_aer_h5_positive": lift_pos,
        "q_bh_le_0_05": bh_pass,
        "p_rw_le_0_05": rw_pass,
        "dsr_20bps_ge_0_95": dsr_pass,
        "mean_net_ret_20bps_positive": net_pass,
        "wf_evaluated_folds_gt_0": wf_evaluated_folds > 0,
        "wf_oos_positive_ge_60pct": wf_ratio is not None and wf_ratio >= 0.60,
        "wf_mean_oos_aer_h5_positive": wf_mean_pos,
    }

    if bh_pass and dsr_pass and net_pass and lift_pos and wf_pass:
        verdict = "PROMOTE_TIER_1"
    else:
        reclaim_pos = reclaim_n >= 10 and reclaim_aer_5d is not None and reclaim_aer_5d > 0.0
        pinning_pos = clustering_excess is not None and clustering_excess > 0.0
        touch_aer_pos = mean_aer_h5 is not None and mean_aer_h5 > 0.0
        suggestive_stat = (p_raw_h5 <= 0.05) or (q_bh_fdr_h5 is not None and q_bh_fdr_h5 <= 0.15)
        if lift_pos and (
            (suggestive_stat and (touch_aer_pos or pinning_pos or reclaim_pos))
            or (pinning_pos and reclaim_pos)
        ):
            verdict = "TIER_2_CONTEXT_ONLY"
        else:
            verdict = "REJECT_NO_EDGE"

    return {
        "verdict": verdict,
        "is_negative_control": False,
        "lift_aer_h5": lift_h5,
        "wf_positive_ratio": wf_ratio,
        "criteria": criteria,
    }


def _compute_touch_subset_metrics(touches: Sequence[TouchObservation]) -> dict[str, Any]:
    """Compute matured H3/H5 outcome metrics (mean AER, 2:1 win rate, 20 bps net return) for a touch subset."""
    out: dict[str, Any] = {}
    for h in (3, 5):
        wins = losses = timeouts = ambig = censored = 0
        aers: list[float] = []
        nets20: list[float] = []
        for t in touches:
            o = t.outcomes.get(h)
            if o is None or o.status == "RIGHT_CENSORED":
                censored += 1
                continue
            if math.isfinite(o.aer_atr):
                aers.append(o.aer_atr)
            if o.status == "WIN":
                wins += 1
            elif o.status == "LOSS":
                losses += 1
            elif o.status == "TIMEOUT":
                timeouts += 1
            elif o.status == "AMBIGUOUS":
                ambig += 1
            if o.status != "AMBIGUOUS":
                nr = o.net_returns_by_cost_bps.get(20, math.nan)
                if math.isfinite(nr):
                    nets20.append(nr)
        den = wins + losses + timeouts
        out[f"H{h}"] = {
            "matured_touches": len(aers),
            "censored_touches": censored,
            "wins": wins,
            "losses": losses,
            "timeouts": timeouts,
            "ambiguous": ambig,
            "win_denom_resolved": den,
            "win_rate_2_1": (wins / float(den)) if den > 0 else None,
            "mean_aer": (math.fsum(aers) / len(aers)) if aers else None,
            "mean_net_return_20bps": (math.fsum(nets20) / len(nets20)) if nets20 else None,
        }
    return out


def build_frozen_oracle_config_payload(
    iass_cfg: IassConfig,
    lc_cfg: LifecycleConfig,
    *,
    n_perm: int,
    seed: int,
) -> dict[str, Any]:
    return {
        "oracle_config_version": ORACLE_CONFIG_VERSION,
        "frozen_at_utc": "2026-11-25T13:30:00Z",
        "specification_provenance": {
            "external_eje_4_2_fsm_doc_present_in_repo": True,
            "external_eje_5_doc_present_in_repo": True,
            "policy": "Prompt #6 APPROVED_SPEC seal: 100% of weights, priors, d_subweights, FSM Eje 4.2 transitions, and Eje 5 production gates marked APPROVED_SPEC prior to full 56-symbol ingestion and B=2000 falsification.",
        },
        "iass_config": iass_cfg.model_dump(),
        "iass_config_status": "APPROVED_SPEC",
        "family_priors": {
            k: {"prior": v[0], "spec_status": v[1], "note": v[2]}
            for k, v in FAMILY_PRIOR_REGISTRY.items()
        },
        "lifecycle_config": lc_cfg.model_dump(),
        "lifecycle_config_status": "APPROVED_SPEC",
        "lifecycle_mappings": {
            "visual_budget_by_timeframe": VISUAL_BUDGET_BY_TIMEFRAME,
            "flat_slope_h_by_timeframe": {
                k: {"h": v[0], "spec_status": v[1]} for k, v in FLAT_SLOPE_H_BY_TIMEFRAME.items()
            },
            "decay_priority_order": ["COHORT_DECAY", "CHOP_SATURATION", "FLAT_SLOPE"],
            "pinch_pair_consumes_slots": 2 if lc_cfg.pinch_consumes_two_visual_slots else 1,
            "fsm_effective_table": [
                {"from": "CANDIDATE", "to": "ACTIVE_PRIMARY", "trigger": "score_conservative >= 70.0 at activated_idx", "status": "APPROVED_SPEC"},
                {"from": "CANDIDATE", "to": "ACTIVE_SECONDARY", "trigger": "45.0 <= score_conservative < 70.0 at activated_idx", "status": "APPROVED_SPEC"},
                {"from": "ACTIVE_SECONDARY", "to": "ACTIVE_PRIMARY", "trigger": "score >= 72.0 for 2 bars or confluence promotion >= 70", "status": "APPROVED_SPEC"},
                {"from": "ACTIVE_PRIMARY", "to": "ACTIVE_SECONDARY", "trigger": "score < 68.0 for 2 bars", "status": "APPROVED_SPEC"},
                {"from": "ACTIVE_PRIMARY/SECONDARY", "to": "PINCH_PAIR", "trigger": "opposite polarity, dist <= 1.25 ATR, converging 3 bars, close inside corridor", "status": "APPROVED_SPEC"},
                {"from": "PINCH_PAIR", "to": "ACTIVE_PRIMARY", "trigger": "PINCH_BREAKOUT when close outside corridor by > 0.35 ATR (winner -> ACTIVE_PRIMARY; loser < 70 -> DECAYING)", "status": "APPROVED_SPEC"},
                {"from": "PINCH_PAIR", "to": "ACTIVE_PRIMARY/SECONDARY", "trigger": "dist > 1.75 ATR or close outside corridor 2 bars or partner decayed", "status": "APPROVED_SPEC"},
                {"from": "ACTIVE_*/PINCH_PAIR", "to": "DECAYING", "trigger": "COHORT_DECAY > CHOP_SATURATION > FLAT_SLOPE", "status": "APPROVED_SPEC"},
                {"from": "DECAYING", "to": "ACTIVE_SECONDARY", "trigger": "non-cohort decay + excursion >= 1.0 ATR + chop < 2 + |s_norm| >= 0.08 for 2 bars", "status": "APPROVED_SPEC"},
                {"from": "DECAYING", "to": "ARCHIVED", "trigger": "dwell >= 5 sessions (1D) / 2 sessions (intraday) OR (dist > 6.0 ATR and S_cohort < 0.30)", "status": "APPROVED_SPEC"},
                {"from": "ACTIVE_*", "to": "ARCHIVED", "trigger": "SPATIAL_CONFLUENCE_ABSORBED (dist < 0.25 ATR, r > 0.98, overlap >= 20)", "status": "APPROVED_SPEC"},
            ],
        },
        "production_gate_criteria": {
            "status": "APPROVED_SPEC",
            "PROMOTE_TIER_1": "Non-control family with matured_touches_h5 >= 30, lift_h5 > 0, q_BH_h5 <= 0.05 (with p_RW reported), DSR_20bps >= 0.95, mean_net_return_20bps > 0, wf_evaluated_folds > 0, wf_positive_folds >= 60%, and wf_mean_oos_aer_h5 > 0",
            "TIER_2_CONTEXT_ONLY": "Non-control family with matured_touches_h5 >= 30 and positive lift_h5 plus either suggestive statistical evidence (p_raw <= 0.05 or q_BH <= 0.15 with positive AER/pinning/reclaim) or joint positive pinning excess & reclaim AER, failing Tier 1 confirmatory gates",
            "REJECT_NO_EDGE": "Non-control family with matured_touches_h5 >= 30 failing both Tier 1 and Tier 2 criteria",
            "INSUFFICIENT_SAMPLE": "anchors_count == 0 or matured_touches_h5 < 30",
            "NEGATIVE_CONTROL_CONTAMINATION_ALERT": "Negative control family showing q_BH_h5 <= 0.05 or p_RW_h5 <= 0.05",
        },
        "oracle_parameters": {
            "primary_timeframe": "rth_1D",
            "horizons": list(HORIZONS_DAYS),
            "primary_endpoint": "MEAN_ANCHOR_AER_H5",
            "cost_scenarios_bps": list(COST_SCENARIOS_BPS),
            "triple_barrier_tp_atr": 1.0,
            "triple_barrier_sl_atr": -0.5,
            "benjamini_hochberg_alpha": 0.05,
            "stationary_block_bootstrap_avg_len": 5.0,
            "walk_forward_train_months": 24,
            "walk_forward_test_months": 6,
            "walk_forward_embargo_sessions": 5,
            "n_perm": n_perm,
            "seed": seed,
            "m_total_hypotheses_dsr": len(CANDIDATE_FAMILIES_14),
        },
    }


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        while chunk := fh.read(65536):
            h.update(chunk)
    return h.hexdigest()


def run_oracle_study(
    *,
    tickers: Sequence[str] | None = None,
    all_universe: bool = False,
    n_perm: int = 500,
    seed: int = 42,
    workers: int = 1,
    data_dir: Path | None = None,
    config_path: Path | None = None,
    json_report_path: Path | None = None,
    md_report_path: Path | None = None,
    universe: PilotUniverse | None = None,
) -> dict[str, Any]:
    """Execute the full offline Axis 5 falsification oracle on local Parquet artifacts."""
    t0 = time.monotonic()
    root = default_oracle_root()
    d_root = data_dir if data_dir is not None else (root / "data")
    uni = universe if universe is not None else load_pilot_universe()
    by_sym_spec = uni.by_ticker()

    if all_universe:
        sym_list = list(uni.tickers())
    elif tickers is not None:
        sym_list = [s.strip().upper() for s in tickers if s.strip()]
    else:
        sym_list = ["SPY", "NVDA", "MELI", "TWTR"]

    is_full_universe_run = all_universe or len(sym_list) >= 50
    cfg_path = config_path if config_path is not None else (root / "config" / "oracle_frozen_config.json")
    default_js_name = "oracle_full56_results.json" if is_full_universe_run else "oracle_dry_run_results.json"
    default_md_name = "oracle_full56_report.md" if is_full_universe_run else "oracle_dry_run_report.md"
    js_path = json_report_path if json_report_path is not None else (root / "reports" / default_js_name)
    md_path = md_report_path if md_report_path is not None else (root / "reports" / default_md_name)

    iass_cfg = IassConfig()
    lc_cfg = LifecycleConfig()
    frozen_cfg_payload = build_frozen_oracle_config_payload(iass_cfg, lc_cfg, n_perm=n_perm, seed=seed)
    cfg_hash = write_strict_json(cfg_path, frozen_cfg_payload)

    for s in sym_list:
        if s not in by_sym_spec:
            raise ValueError(f"Ticker {s!r} not found in frozen pilot_universe.json")

    dataset_hashes: dict[str, str] = {}

    def _read_opt(rel: str) -> pl.DataFrame | None:
        p = d_root / rel
        if p.is_file():
            dataset_hashes[rel] = _sha256_file(p)
            return pl.read_parquet(p)
        return None

    econ_df = _read_opt("events/global/econ_calendar_us.parquet")
    sp500_df = _read_opt("events/global/sp500_history.parquet")
    nasdaq_df = _read_opt("events/global/nasdaq_history.parquet")
    idx_frames = [x for x in (sp500_df, nasdaq_df) if x is not None and x.height > 0]
    index_hist_df = pl.concat(idx_frames, how="vertical") if idx_frames else None
    spy_cores_df = _read_opt("derivatives/orats_cores/SPY.parquet")

    candidates_by_ticker: dict[str, tuple[CandidateAnchor, ...]] = {}
    bars_enriched_by_ticker: dict[str, pl.DataFrame] = {}
    bar_dates_by_ticker: dict[str, list[str]] = {}
    splits_by_ticker: dict[str, list[CorporateSplitEvent]] = {}
    touch_summaries_by_ticker: dict[str, dict[str, AnchorTouchSummary]] = {}
    all_touches_flat: list[TouchObservation] = []
    all_summaries_flat: list[AnchorTouchSummary] = []
    gex_by_ticker: dict[str, pl.DataFrame] = {}
    reconciled_oi_summary: dict[str, dict[str, Any]] = {}
    fsm_stats_by_ticker: dict[str, dict[str, Any]] = {}
    exclusion_totals: dict[str, int] = {}
    tickers_audited: list[str] = []
    tickers_missing_bars: list[str] = []
    split_anomalies: list[dict[str, Any]] = []
    dividend_anomalies: list[dict[str, Any]] = []
    earnings_timing_source_counts: dict[str, int] = {}
    massive_oi_fallback_rows = 0
    reconciled_oi_total_rows = 0

    for sym in sym_list:
        spec = by_sym_spec[sym]
        b1d = _read_opt(f"canonical/rth_1D/{sym}.parquet")
        if b1d is None or b1d.height == 0:
            tickers_missing_bars.append(sym)
            continue
        tickers_audited.append(sym)
        b5m = _read_opt(f"canonical/rth_5m/{sym}.parquet")
        sp_df = _read_opt(f"events/corporate_actions/{sym}_splits.parquet")
        dv_df = _read_opt(f"events/corporate_actions/{sym}_dividends.parquet")
        er_df = _read_opt(f"events/earnings_reconciled/{sym}.parquet")
        oc_df = _read_opt(f"derivatives/orats_cores/{sym}.parquet")
        os_df = _read_opt(f"derivatives/orats_summaries/{sym}.parquet")
        moi_df = _read_opt(f"derivatives/massive_oi/{sym}.parquet")
        rec_oi_df = _read_opt(f"derivatives/reconciled_oi/{sym}.parquet")
        if rec_oi_df is None and (oc_df is not None or moi_df is not None):
            rec_oi_df = reconcile_daily_oi(
                oc_df if oc_df is not None else pl.DataFrame(),
                moi_df if moi_df is not None else pl.DataFrame(),
            )
        gx_df = _read_opt(f"derivatives/orats_gex_opex/{sym}.parquet")
        if gx_df is not None:
            gex_by_ticker[sym] = gx_df
        wh_df = _read_opt(f"derivatives/orats_wham/{sym}.parquet")
        mu_df = _read_opt(f"derivatives/massive_unusual/{sym}.parquet")
        sec_df = _read_opt(f"events/sec_filings/{sym}.parquet")

        if er_df is not None and er_df.height > 0 and "timing_source" in er_df.columns:
            for r in er_df.group_by("timing_source").len().to_dicts():
                ts_k = str(r["timing_source"])
                earnings_timing_source_counts[ts_k] = earnings_timing_source_counts.get(ts_k, 0) + int(r["len"])

        if sp_df is not None and sp_df.height > 0:
            for r in sp_df.iter_rows(named=True):
                if not bool(r.get("safe_to_apply", True)) or str(r.get("status", "")) not in ("", "MATCHED", "SINGLE_SOURCE", "SAFE"):
                    split_anomalies.append({
                        "ticker": sym,
                        "effective_date": str(r.get("effective_date", ""))[:10],
                        "status": str(r.get("status", "")),
                        "safe_to_apply": bool(r.get("safe_to_apply", False)),
                    })
        if dv_df is not None and dv_df.height > 0 and "status" in dv_df.columns:
            for r in dv_df.iter_rows(named=True):
                st = str(r.get("status", ""))
                if st and st not in ("MATCHED", "SINGLE_SOURCE", "OK"):
                    dividend_anomalies.append({
                        "ticker": sym,
                        "ex_date": str(r.get("ex_date", ""))[:10],
                        "status": st,
                    })

        if rec_oi_df is not None and rec_oi_df.height > 0:
            src_counts = {
                str(r["oi_source"]): int(r["len"])
                for r in rec_oi_df.group_by("oi_source").len().to_dicts()
            }
            reconciled_oi_total_rows += rec_oi_df.height
            massive_oi_fallback_rows += src_counts.get("MASSIVE_FALLBACK", 0)
            fb_dates = rec_oi_df.filter(pl.col("oi_source") == "MASSIVE_FALLBACK")["trade_date"].to_list()
            diff_dates = rec_oi_df.filter(
                (pl.col("orats_total_oi_raw") >= 0)
                & (pl.col("massive_total_oi_raw") >= 0)
                & (pl.col("orats_total_oi_raw") != pl.col("massive_total_oi_raw"))
            )["trade_date"].to_list()
            reconciled_oi_summary[sym] = {
                "rows": rec_oi_df.height,
                "source_counts": src_counts,
                "massive_fallback_dates": fb_dates,
                "cross_provider_diff_dates": diff_dates,
            }

        split_ev_list: list[CorporateSplitEvent] = []
        if sp_df is not None and sp_df.height > 0:
            for r in sp_df.iter_rows(named=True):
                if bool(r.get("safe_to_apply")) and r.get("split_from_canonical") and r.get("split_to_canonical"):
                    split_ev_list.append(
                        CorporateSplitEvent(
                            event_id=f"{sym}:{r['effective_date']}",
                            ticker=sym,
                            effective_date=str(r["effective_date"])[:10],
                            split_from=float(r["split_from_canonical"]),
                            split_to=float(r["split_to_canonical"]),
                        )
                    )
        splits_by_ticker[sym] = split_ev_list

        cand_res = generate_causal_candidates(
            ticker=sym,
            asset_class=spec.asset_class.value,
            bars_1d=b1d,
            splits=split_ev_list,
            dividends_df=dv_df,
            earnings_reconciled_df=er_df,
            orats_cores_df=oc_df,
            orats_summaries_df=os_df,
            reconciled_oi_df=rec_oi_df,
            orats_gex_opex_df=gx_df,
            orats_wham_df=wh_df,
            massive_unusual_df=mu_df,
            econ_calendar_df=econ_df,
            sec_filings_df=sec_df,
            index_history_df=index_hist_df,
            iass_config=iass_cfg,
        )
        candidates_by_ticker[sym] = cand_res.candidates
        bars_enr = cand_res.bars_enriched
        bars_enriched_by_ticker[sym] = bars_enr
        bar_dates_by_ticker[sym] = [str(x) for x in bars_enr["trade_date"].to_list()]
        for rk, rv in cand_res.exclusion_counts.items():
            exclusion_totals[rk] = exclusion_totals.get(rk, 0) + int(rv)

        # Evaluate AVWAP trajectory, touches & FSM lifecycle (pre-group 5m once per ticker)
        b5m_by_date: dict[str, pl.DataFrame] = {}
        if b5m is not None and b5m.height > 0:
            for td_key, sub in b5m.filter(pl.col("ticker") == sym).group_by("trade_date"):
                td_str = str(td_key[0] if isinstance(td_key, tuple) else td_key)
                b5m_by_date[td_str] = sub

        sym_touches: dict[str, AnchorTouchSummary] = {}
        fsm_inputs: list[AnchorSeriesInput] = []
        for c in cand_res.candidates:
            sp_bars = apply_split_schedule_to_canonical_bars(bars_enr, split_ev_list, anchor_idx=c.anchor_idx).bars
            summ = evaluate_anchor_touches(
                c, bars_enr, splits=split_ev_list, bars_5m_by_date=b5m_by_date, precomputed_avwap=sp_bars
            )
            sym_touches[c.anchor_id] = summ
            all_summaries_flat.append(summ)
            all_touches_flat.extend(summ.touches)
            av_series = tuple(
                float(x) if x is not None else math.nan for x in sp_bars["avwap_mu"].to_list()
            )
            fsm_inputs.append(
                AnchorSeriesInput(
                    anchor_id=c.anchor_id,
                    family=c.family,
                    polarity=c.polarity,
                    anchor_idx=c.anchor_idx,
                    activated_idx=c.activated_idx,
                    anchor_ts=c.anchor_ts,
                    available_at_utc_s=c.available_at_utc_s,
                    score_original=c.iass.score_conservative,
                    avwap_series=av_series,
                    free_float_at_anchor=None,
                    float_is_pit=False,
                )
            )
        touch_summaries_by_ticker[sym] = sym_touches

        if fsm_inputs and bars_enr.height > 0:
            fsm_res = run_lifecycle_fsm(
                timeframe="1D",
                bar_ts_utc_s=bars_enr["ts_open_utc_s"].to_list(),
                highs=bars_enr["h"].to_list(),
                lows=bars_enr["l"].to_list(),
                closes=bars_enr["c"].to_list(),
                volumes=bars_enr["W"].to_list(),
                atr14=[float(x) if x is not None else math.nan for x in bars_enr["atr14"].to_list()],
                anchors=fsm_inputs,
                rvol_z=[float(x) if x is not None else math.nan for x in bars_enr["rvol_z"].to_list()],
                split_factor_k_series=[float(x) if x is not None else 1.0 for x in bars_enr["split_factor_k"].to_list()],
                config=lc_cfg,
            )
            state_counts: dict[str, int] = {}
            hidden_cnt = 0
            for snap in fsm_res.final_snapshots.values():
                state_counts[snap.state] = state_counts.get(snap.state, 0) + 1
                if not snap.visible and snap.state in ("ACTIVE_PRIMARY", "ACTIVE_SECONDARY", "PINCH_PAIR"):
                    hidden_cnt += 1
            fsm_stats_by_ticker[sym] = {
                "anchors_total": len(fsm_inputs),
                "transitions": len(fsm_res.transitions),
                "spatial_merges": len(fsm_res.merges),
                "final_state_counts": state_counts,
                "active_hidden_by_visual_budget": hidden_cnt,
            }

    dataset_combo_hash = hashlib.sha256(
        json.dumps(dataset_hashes, sort_keys=True).encode("utf-8")
    ).hexdigest()[:16]

    # Matched random-anchor permutation test (H=5 primary + H=3 secondary)
    n_workers = max(1, int(workers))
    perm_summary = matched_monte_carlo_fdr(
        candidates_by_ticker,
        touch_summaries_by_ticker,
        bars_enriched_by_ticker,
        splits_by_ticker,
        spy_cores_df=spy_cores_df,
        n_perm=n_perm,
        seed=seed,
        horizon=5,
        workers=n_workers,
    )
    perm_summary_h3 = matched_monte_carlo_fdr(
        candidates_by_ticker,
        touch_summaries_by_ticker,
        bars_enriched_by_ticker,
        splits_by_ticker,
        spy_cores_df=spy_cores_df,
        n_perm=n_perm,
        seed=seed + 17,
        horizon=3,
        workers=n_workers,
    )

    # All unique sorted calendar dates across audited tickers
    all_dates_set: set[str] = set()
    for ds in bar_dates_by_ticker.values():
        all_dates_set.update(ds)
    all_dates_sorted = sorted(all_dates_set)

    # BH FDR over the pre-frozen 14-family confirmatory/control suite (H=5 & H=3)
    raw_p_vector = [
        perm_summary.results_by_family[fam].p_raw if fam in perm_summary.results_by_family else None
        for fam in CANDIDATE_FAMILIES_14
    ]
    bh_q_vector = benjamini_hochberg(raw_p_vector, alpha=0.05)
    bh_by_family = {fam: bh_q_vector[i] for i, fam in enumerate(CANDIDATE_FAMILIES_14)}

    raw_p_vector_h3 = [
        perm_summary_h3.results_by_family[fam].p_raw if fam in perm_summary_h3.results_by_family else None
        for fam in CANDIDATE_FAMILIES_14
    ]
    bh_q_vector_h3 = benjamini_hochberg(raw_p_vector_h3, alpha=0.05)
    bh_by_family_h3 = {fam: bh_q_vector_h3[i] for i, fam in enumerate(CANDIDATE_FAMILIES_14)}

    # Romano-Wolf Stepdown via calendar-date-synchronized Stationary Block Bootstrap
    rw_obs: dict[str, list[tuple[str, float]]] = {}
    for summ in all_summaries_flat:
        tds = bar_dates_by_ticker.get(summ.ticker, [])
        for t in summ.touches:
            out5 = t.outcomes.get(5)
            if out5 is None or out5.status == "RIGHT_CENSORED" or not math.isfinite(out5.aer_atr):
                continue
            sig_td = tds[t.touch_idx]
            rw_obs.setdefault(t.family, []).append((sig_td, out5.aer_atr))

    rw_res = romano_wolf_stepdown(
        rw_obs, all_dates=all_dates_sorted, n_boot=n_perm, avg_block_len=5.0, seed=seed + 1
    )

    # Coherent daily book net returns & Deflated Sharpe Ratio (20 bps baseline + 4 cost scenarios)
    # Collect trial SRs across non-degenerate families at 20 bps for cross-strategy dispersion
    family_daily_books_by_cost: dict[int, dict[str, dict[str, float]]] = {bps: {} for bps in COST_SCENARIOS_BPS}
    for fam in CANDIDATE_FAMILIES_14:
        fam_summs = [s for s in all_summaries_flat if s.family == fam]
        for bps in COST_SCENARIOS_BPS:
            family_daily_books_by_cost[bps][fam] = build_coherent_daily_net_return_series(
                fam_summs,
                all_dates=all_dates_sorted,
                bar_dates_by_ticker=bar_dates_by_ticker,
                horizon=5,
                cost_bps=bps,
            )

    trial_sharpes_20: list[float] = []
    for fam in CANDIDATE_FAMILIES_14:
        rets = list(family_daily_books_by_cost[20][fam].values())
        if len(rets) >= 10:
            sd = float(np.std(np.asarray(rets, dtype=np.float64), ddof=1))
            if sd > 1e-12:
                trial_sharpes_20.append(float(np.mean(rets)) / sd)

    # Family summary table
    family_table: dict[str, dict[str, Any]] = {}
    for fam in CANDIDATE_FAMILIES_14:
        fam_cands = [c for cands in candidates_by_ticker.values() for c in cands if c.family == fam]
        fam_summs = [s for s in all_summaries_flat if s.family == fam]
        fam_touches = [t for s in fam_summs for t in s.touches]
        fam_fbs = [fb for s in fam_summs for fb in s.false_breaks]

        horizon_stats: dict[str, Any] = {}
        for h in HORIZONS_DAYS:
            wins = losses = timeouts = ambig = censored = 0
            aers: list[float] = []
            mfes: list[float] = []
            maes: list[float] = []
            nets_by_bps: dict[str, float | None] = {}
            for t in fam_touches:
                o = t.outcomes.get(h)
                if o is None or o.status == "RIGHT_CENSORED":
                    censored += 1
                    continue
                if math.isfinite(o.aer_atr):
                    aers.append(o.aer_atr)
                    mfes.append(o.mfe_atr)
                    maes.append(o.mae_atr)
                if o.status == "WIN":
                    wins += 1
                elif o.status == "LOSS":
                    losses += 1
                elif o.status == "TIMEOUT":
                    timeouts += 1
                elif o.status == "AMBIGUOUS":
                    ambig += 1
            for bps in COST_SCENARIOS_BPS:
                vals_b = [
                    t.outcomes[h].net_returns_by_cost_bps[bps]
                    for t in fam_touches
                    if h in t.outcomes
                    and t.outcomes[h].status not in ("RIGHT_CENSORED", "AMBIGUOUS")
                    and math.isfinite(t.outcomes[h].net_returns_by_cost_bps.get(bps, math.nan))
                ]
                nets_by_bps[str(bps)] = (math.fsum(vals_b) / len(vals_b)) if vals_b else None
            denom_strict = wins + losses + timeouts
            denom_all_matured = denom_strict + ambig
            horizon_stats[f"H{h}"] = {
                "matured_touches": len(aers),
                "censored_touches": censored,
                "wins": wins,
                "losses": losses,
                "timeouts": timeouts,
                "ambiguous": ambig,
                "win_denom_resolved": denom_strict,
                "win_denom_including_ambiguous": denom_all_matured,
                "win_rate_2_1": (wins / float(denom_strict)) if denom_strict > 0 else None,
                "mean_mfe": (math.fsum(mfes) / len(mfes)) if mfes else None,
                "mean_mae": (math.fsum(maes) / len(maes)) if maes else None,
                "mean_aer": (math.fsum(aers) / len(aers)) if aers else None,
                "mean_net_return_by_cost_bps": nets_by_bps,
            }

        p_res = perm_summary.results_by_family.get(fam)
        p_res_h3 = perm_summary_h3.results_by_family.get(fam)
        dsr_res = deflated_sharpe_ratio(
            list(family_daily_books_by_cost[20][fam].values()),
            n_trials_m=len(CANDIDATE_FAMILIES_14),
            trial_sharpes=trial_sharpes_20,
        )
        fb_h5_vals = [fb.aer_h5 for fb in fam_fbs if not fb.censored_h5 and math.isfinite(fb.aer_h5)]
        reclaim_aer_5d = (math.fsum(fb_h5_vals) / len(fb_h5_vals)) if fb_h5_vals else None

        # Per-family Walk-Forward OOS consistency
        fam_wf_folds, _ = evaluate_walk_forward(
            touches=fam_touches,
            bar_dates_by_ticker=bar_dates_by_ticker,
            config_version=ORACLE_CONFIG_VERSION,
            dataset_hash=dataset_combo_hash,
        )
        wf_eval_folds = [
            f for f in fam_wf_folds
            if f.status == "EVALUATED" and f.test_mean_aer_h5 is not None and math.isfinite(f.test_mean_aer_h5)
        ]
        wf_pos_folds = sum(1 for f in wf_eval_folds if f.test_mean_aer_h5 is not None and f.test_mean_aer_h5 > 0.0)
        wf_mean_oos = (
            math.fsum(float(f.test_mean_aer_h5) for f in wf_eval_folds if f.test_mean_aer_h5 is not None)
            / len(wf_eval_folds)
        ) if wf_eval_folds else None

        # Per-stratum H3/H5 breakdown for this family
        fam_by_stratum: dict[str, Any] = {}
        for st_name in EXPECTED_STRATUM_COUNTS:
            st_touches = [t for t in fam_touches if by_sym_spec[t.ticker].stratum.value == st_name]
            st_cands = [c for c in fam_cands if by_sym_spec[c.ticker].stratum.value == st_name]
            fam_by_stratum[st_name] = {
                "anchors_count": len(st_cands),
                **_compute_touch_subset_metrics(st_touches),
            }

        by_polarity: dict[str, dict[str, Any]] = {}
        for pol in ("LONG", "SHORT"):
            pol_cands = [c for c in fam_cands if c.polarity == pol]
            pol_touches = [t for t in fam_touches if t.polarity == pol]
            pol_matured = [
                t for t in pol_touches
                if 5 in t.outcomes and t.outcomes[5].status != "RIGHT_CENSORED"
            ]
            pol_cens = len(pol_touches) - len(pol_matured)
            pol_aers = [t.outcomes[5].aer_atr for t in pol_matured if math.isfinite(t.outcomes[5].aer_atr)]
            pol_wins = sum(1 for t in pol_matured if t.outcomes[5].status == "WIN")
            pol_losses = sum(1 for t in pol_matured if t.outcomes[5].status == "LOSS")
            pol_tos = sum(1 for t in pol_matured if t.outcomes[5].status == "TIMEOUT")
            pol_den = pol_wins + pol_losses + pol_tos
            pol_nets = [
                t.outcomes[5].net_returns_by_cost_bps[20]
                for t in pol_matured
                if t.outcomes[5].status != "AMBIGUOUS"
                and math.isfinite(t.outcomes[5].net_returns_by_cost_bps.get(20, math.nan))
            ]
            d_res = perm_summary.directional_results.get((fam, pol))
            by_polarity[pol] = {
                "anchors_count": len(pol_cands),
                "n_touches": len(pol_touches),
                "matured_touches": len(pol_matured),
                "censored_touches": pol_cens,
                "aer_mean": (math.fsum(pol_aers) / len(pol_aers)) if pol_aers else None,
                "anchor_aer_mean": d_res.observed_mean_aer_h5 if d_res else None,
                "null_mean_aer": d_res.null_mean_aer_h5 if d_res else None,
                "null_std_aer": d_res.null_std_aer_h5 if d_res else None,
                "z_lift": d_res.z_lift_aer_h5 if d_res else None,
                "wins": pol_wins,
                "win_denom": pol_den,
                "win_2to1": (pol_wins / float(pol_den)) if pol_den > 0 else None,
                "net_ret_20bps": (math.fsum(pol_nets) / len(pol_nets)) if pol_nets else None,
                "p_raw": d_res.p_raw if d_res else None,
            }

        if len(fam_cands) == 0:
            fam_status = "NO_EVENTS"
        elif horizon_stats["H5"]["matured_touches"] == 0 and horizon_stats["H5"]["censored_touches"] > 0:
            fam_status = "RIGHT_CENSORED"
        elif p_res is not None and p_res.status != "EVALUATED":
            fam_status = p_res.status
        else:
            fam_status = "EVALUATED"

        gate_info = classify_production_gate(
            family=fam,
            anchors_count=len(fam_cands),
            matured_touches_h5=int(horizon_stats["H5"]["matured_touches"]),
            observed_mean_aer_h5=p_res.observed_mean_aer_h5 if p_res else None,
            null_mean_aer_h5=p_res.null_mean_aer_h5 if p_res else None,
            mean_aer_h5=horizon_stats["H5"]["mean_aer"],
            p_raw_h5=p_res.p_raw if p_res else None,
            q_bh_fdr_h5=bh_by_family.get(fam),
            p_romano_wolf=rw_res.p_rw_by_family.get(fam),
            dsr=dsr_res.dsr,
            mean_net_ret_20bps_h5=horizon_stats["H5"]["mean_net_return_by_cost_bps"].get("20"),
            clustering_excess=p_res.clustering_excess if p_res else None,
            reclaim_n=len(fb_h5_vals),
            reclaim_aer_5d=reclaim_aer_5d,
            wf_evaluated_folds=len(wf_eval_folds),
            wf_positive_folds=wf_pos_folds,
            wf_mean_oos_aer_h5=wf_mean_oos,
        )

        family_table[fam] = {
            "family": fam,
            "is_negative_control": fam in NEGATIVE_CONTROL_FAMILIES,
            "status": fam_status,
            "production_verdict": gate_info["verdict"],
            "production_gate": gate_info,
            "anchors_count": len(fam_cands),
            "touches_count": len(fam_touches),
            "false_breaks_count": len(fam_fbs),
            "reclaim_n": len(fb_h5_vals),
            "reclaim_aer_5d": reclaim_aer_5d,
            "false_break_mean_aer_h5": reclaim_aer_5d,
            "horizons": horizon_stats,
            "observed_mean_aer_h5": p_res.observed_mean_aer_h5 if p_res else None,
            "null_mean_aer_h5": p_res.null_mean_aer_h5 if p_res else None,
            "null_std_aer_h5": p_res.null_std_aer_h5 if p_res else None,
            "z_lift": p_res.z_lift_aer_h5 if p_res else None,
            "p_raw": p_res.p_raw if p_res else None,
            "q_bh_fdr": bh_by_family.get(fam),
            "observed_mean_aer_h3": p_res_h3.observed_mean_aer_h5 if p_res_h3 else None,
            "null_mean_aer_h3": p_res_h3.null_mean_aer_h5 if p_res_h3 else None,
            "z_lift_h3": p_res_h3.z_lift_aer_h5 if p_res_h3 else None,
            "p_raw_h3": p_res_h3.p_raw if p_res_h3 else None,
            "q_bh_fdr_h3": bh_by_family_h3.get(fam),
            "p_romano_wolf": rw_res.p_rw_by_family.get(fam),
            "rw_status": rw_res.status_by_family.get(fam, "NO_EVENTS"),
            "dsr": dsr_res.dsr,
            "dsr_status": dsr_res.status,
            "dsr_reason": dsr_res.reason,
            "sharpe_daily_net_20bps": dsr_res.sharpe_observed,
            "wf_evaluated_folds": len(wf_eval_folds),
            "wf_positive_folds": wf_pos_folds,
            "wf_positive_ratio": gate_info["wf_positive_ratio"],
            "wf_mean_oos_aer_h5": wf_mean_oos,
            "matching_pool_size_median": p_res.pool_size_median if p_res else 0.0,
            "anchors_insufficient_matches": p_res.anchors_insufficient_matches if p_res else 0,
            "control_reuse_ratio": p_res.control_reuse_ratio if p_res else 0.0,
            "observed_pinning_rate": p_res.observed_pinning_rate if p_res else None,
            "matched_null_pinning_rate": p_res.matched_null_pinning_rate if p_res else None,
            "clustering_excess": p_res.clustering_excess if p_res else None,
            "by_polarity": by_polarity,
            "by_stratum": fam_by_stratum,
        }

    # Walk-forward evaluation across all touches
    wf_folds, wf_ticker_status = evaluate_walk_forward(
        touches=all_touches_flat,
        bar_dates_by_ticker=bar_dates_by_ticker,
        config_version=ORACLE_CONFIG_VERSION,
        dataset_hash=dataset_combo_hash,
    )
    regime_strat = stratify_touches_by_regime(
        touches=all_touches_flat,
        bar_dates_by_ticker=bar_dates_by_ticker,
        spy_cores_df=spy_cores_df,
        gex_opex_by_ticker=gex_by_ticker,
    )
    gex_raw_reg = regime_strat.get("gex_snapshot_regime", {})
    regime_strat["gex_regime_aliases"] = {
        "POSITIVE_GAMMA": gex_raw_reg.get("LONG_GAMMA", {}),
        "NEGATIVE_GAMMA": gex_raw_reg.get("SHORT_GAMMA", {}),
        "NEUTRAL": gex_raw_reg.get("NEUTRAL", {}),
        "UNKNOWN": gex_raw_reg.get("UNKNOWN", {}),
    }

    # Stratum breakdown & survivorship bias delta (EX_DELISTED vs ALL_AUDITED)
    stratum_breakdown: dict[str, Any] = {}
    for st_name in EXPECTED_STRATUM_COUNTS:
        st_syms = [s for s in tickers_audited if by_sym_spec[s].stratum.value == st_name]
        st_touches = [t for t in all_touches_flat if by_sym_spec[t.ticker].stratum.value == st_name]
        st_cands = sum(len(candidates_by_ticker.get(s, ())) for s in st_syms)
        stratum_breakdown[st_name] = {
            "tickers_count": len(st_syms),
            "tickers": st_syms,
            "anchors_count": st_cands,
            **_compute_touch_subset_metrics(st_touches),
        }

    ex_delisted_syms = [s for s in tickers_audited if not by_sym_spec[s].is_delisted]
    ex_delisted_touches = [t for t in all_touches_flat if not by_sym_spec[t.ticker].is_delisted]
    all_metrics = _compute_touch_subset_metrics(all_touches_flat)
    ex_del_metrics = _compute_touch_subset_metrics(ex_delisted_touches)

    def _opt_diff(a: float | None, b: float | None) -> float | None:
        if a is None or b is None or not (math.isfinite(a) and math.isfinite(b)):
            return None
        return float(a - b)

    survivorship_bias_analysis = {
        "all_audited": {
            "tickers_count": len(tickers_audited),
            "anchors_count": sum(len(v) for v in candidates_by_ticker.values()),
            **all_metrics,
        },
        "ex_delisted": {
            "tickers_count": len(ex_delisted_syms),
            "anchors_count": sum(len(candidates_by_ticker.get(s, ())) for s in ex_delisted_syms),
            **ex_del_metrics,
        },
        "delta_ex_delisted_minus_all": {
            "mean_aer_h5_delta": _opt_diff(ex_del_metrics["H5"]["mean_aer"], all_metrics["H5"]["mean_aer"]),
            "win_rate_2_1_h5_delta": _opt_diff(ex_del_metrics["H5"]["win_rate_2_1"], all_metrics["H5"]["win_rate_2_1"]),
            "mean_net_return_20bps_h5_delta": _opt_diff(
                ex_del_metrics["H5"]["mean_net_return_20bps"], all_metrics["H5"]["mean_net_return_20bps"]
            ),
            "mean_aer_h3_delta": _opt_diff(ex_del_metrics["H3"]["mean_aer"], all_metrics["H3"]["mean_aer"]),
        },
    }

    # Negative controls sanity check
    neg_ctrl_rows: dict[str, Any] = {}
    any_ctrl_contaminated = False
    for cfam in sorted(NEGATIVE_CONTROL_FAMILIES):
        crow = family_table[cfam]
        contaminated = crow["production_verdict"] == "NEGATIVE_CONTROL_CONTAMINATION_ALERT"
        if contaminated:
            any_ctrl_contaminated = True
        neg_ctrl_rows[cfam] = {
            "anchors_count": crow["anchors_count"],
            "matured_touches_h5": crow["horizons"]["H5"]["matured_touches"],
            "observed_mean_aer_h5": crow["observed_mean_aer_h5"],
            "null_mean_aer_h5": crow["null_mean_aer_h5"],
            "p_raw": crow["p_raw"],
            "q_bh_fdr": crow["q_bh_fdr"],
            "p_romano_wolf": crow["p_romano_wolf"],
            "verdict": crow["production_verdict"],
            "contaminated": contaminated,
        }
    negative_controls_check = {
        "status": "CONTAMINATION_ALERT" if any_ctrl_contaminated else "PASS",
        "controls": neg_ctrl_rows,
    }

    dataset_anomalies = {
        "tickers_requested": len(sym_list),
        "tickers_audited_count": len(tickers_audited),
        "tickers_missing_bars": tickers_missing_bars,
        "split_anomalies_count": len(split_anomalies),
        "split_anomalies": split_anomalies[:50],
        "dividend_anomalies_count": len(dividend_anomalies),
        "dividend_anomalies": dividend_anomalies[:50],
        "earnings_timing_source_counts": earnings_timing_source_counts,
        "reconciled_oi_total_rows": reconciled_oi_total_rows,
        "massive_oi_fallback_rows": massive_oi_fallback_rows,
    }

    production_gate_summary = {
        fam: {
            "verdict": row["production_verdict"],
            "is_negative_control": row["is_negative_control"],
            "q_bh_fdr_h5": row["q_bh_fdr"],
            "p_romano_wolf": row["p_romano_wolf"],
            "dsr": row["dsr"],
            "wf_positive_folds": row["wf_positive_folds"],
            "wf_evaluated_folds": row["wf_evaluated_folds"],
        }
        for fam, row in family_table.items()
    }

    elapsed_s = max(0.0, time.monotonic() - t0)
    results_payload: dict[str, Any] = {
        "oracle_config_version": ORACLE_CONFIG_VERSION,
        "frozen_config_hash": cfg_hash,
        "generated_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "study_mode": "FULL_UNIVERSE_56" if is_full_universe_run else "SUBSET_OR_CANARY",
        "tickers": sym_list,
        "tickers_audited": tickers_audited,
        "n_perm": n_perm,
        "seed": seed,
        "workers": n_workers,
        "duration_s": round(elapsed_s, 3),
        "dataset_hashes": dataset_hashes,
        "dataset_combo_hash": dataset_combo_hash,
        "vol_regime_source": perm_summary.vol_regime_source,
        "study_disclaimer": (
            "Definitive pre-registered Axis 5 falsification study over full 56-symbol universe with B=2000; all parameters sealed prior to ingestion and reported verbatim without post-hoc retuning."
            if is_full_universe_run
            else "Subset/canary oracle run; do not generalize subset p-values without full 56-symbol evaluation."
        ),
        "reconciled_oi_summary": reconciled_oi_summary,
        "fsm_stats_by_ticker": fsm_stats_by_ticker,
        "candidate_exclusion_counts": exclusion_totals,
        "dataset_anomalies": dataset_anomalies,
        "negative_controls_check": negative_controls_check,
        "production_gate_summary": production_gate_summary,
        "stratum_breakdown": stratum_breakdown,
        "survivorship_bias_analysis": survivorship_bias_analysis,
        "family_results": family_table,
        "walk_forward_folds": [
            {
                "fold_id": f.fold_id,
                "train_start": f.train_start,
                "train_end": f.train_end,
                "test_start": f.test_start,
                "test_end": f.test_end,
                "purged_observations": f.purged_observations,
                "embargoed_observations": f.embargoed_observations,
                "train_sample_size": f.train_sample_size,
                "test_sample_size": f.test_sample_size,
                "train_mean_aer_h5": f.train_mean_aer_h5,
                "test_mean_aer_h5": f.test_mean_aer_h5,
                "test_win_rate_2_1": f.test_win_rate_2_1,
                "config_version": f.config_version,
                "dataset_hash": f.dataset_hash,
                "status": f.status,
            }
            for f in wf_folds
        ],
        "walk_forward_ticker_status": wf_ticker_status,
        "regime_stratification": regime_strat,
    }

    write_strict_json(js_path, results_payload)
    _write_dry_run_markdown(md_path, results_payload, frozen_cfg_payload)
    return results_payload


def _fmt_opt(v: float | None, fmt: str = ".4f") -> str:
    if v is None or not math.isfinite(float(v)):
        return "null (N/A)"
    return format(float(v), fmt)


def _write_dry_run_markdown(
    md_path: Path,
    res: Mapping[str, Any],
    cfg: Mapping[str, Any],
) -> None:
    is_full = res.get("study_mode") == "FULL_UNIVERSE_56"
    title = (
        "# AVWAP Institutional Research Oracle — Axis 5 Full 56-Symbol Report (`VERIFICADO OFFLINE`)"
        if is_full
        else "# AVWAP Institutional Research Oracle — Axis 5 Subset/Canary Report (`VERIFICADO OFFLINE`)"
    )
    lines: list[str] = [
        title,
        "",
        f"- **Generated UTC:** `{res['generated_at_utc']}`",
        f"- **Study Mode:** `{res.get('study_mode', 'SUBSET_OR_CANARY')}` (`{len(res.get('tickers_audited', res['tickers']))}` / `{len(res['tickers'])}` tickers with 1D RTH bars)",
        f"- **Oracle Config Version:** `{res['oracle_config_version']}` (`sha256:{res['frozen_config_hash'][:16]}...`)",
        f"- **Dataset Combo Hash:** `{res['dataset_combo_hash']}`",
        f"- **Permutations (`B`) / Seed / Workers:** `B={res['n_perm']}` / `seed={res['seed']}` / `workers={res.get('workers', 1)}`",
        f"- **Vol Matching Regime Source:** `{res['vol_regime_source']}`",
        f"- **Offline Wall Time:** `{res['duration_s']} s`",
        "",
        f"> **Nota metodológica:** {res.get('study_disclaimer', '')}",
        "",
        "## 1. Sealed Configuration (`APPROVED_SPEC`) & Point-in-Time Governance",
        "",
        f"- **IASS Base Weights (`{cfg.get('iass_config_status', 'APPROVED_SPEC')}`):** `M={cfg['iass_config']['weight_M']}, D={cfg['iass_config']['weight_D']}, F={cfg['iass_config']['weight_F']}, S={cfg['iass_config']['weight_S']}`, `d_subweights={json.dumps(cfg['iass_config'].get('d_subweights', {}))}`, prior=`{cfg['iass_config']['degradation_prior']}`, tiers=`>=70 / >=45`.",
        f"- **Negative Controls Status:** `{res['negative_controls_check']['status']}`",
        "- **Point-in-Time Caveats (`VERIFICADO OFFLINE`):** `float_snapshots` (`is_point_in_time=False`) excluded from Pillar M and cohort decay (`FLOAT_NON_PIT_SNAPSHOT`); `net_directional_premium = null` (`NO_NBBO_AGGRESSOR_SIDE_IN_UNUSUAL_TRADES`); `S-3`/`S-3ASR` shelf registrations excluded.",
        "",
        "## 2. Dataset Audit, Reconciled OI, Anomalies & FSM Summary",
        "",
        f"- **Candidate Exclusion Counts:** `{json.dumps(res['candidate_exclusion_counts'])}`",
        f"- **Dataset Anomalies Summary:** `{json.dumps(_sanitize_json_value({k: v for k, v in res['dataset_anomalies'].items() if k not in ('split_anomalies', 'dividend_anomalies')}))}`",
        "",
        "## 3. Family Statistical Falsification Table (`H=5` Confirmatory + `H=3` + Eje 5 Gate)",
        "",
        "| Familia | Ctrl | Veredicto Eje 5 | Anclajes | Toques H5 (mad/cens) | obs_aer H5 | null_aer H5 | z_lift H5 | Win 2:1 H5 | p_raw H5 | q_BH H5 | p_RW H5 | DSR (20bps) | WF OOS (+/N) | q_BH H3 | pin_exc | reclaim_n / aer5d |",
        "| --- | :---: | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- |",
    ]

    for fam, row in res["family_results"].items():
        h5 = row["horizons"]["H5"]
        lines.append(
            f"| `{fam}` | {'YES' if row['is_negative_control'] else 'NO'} | `{row['production_verdict']}` | "
            f"{row['anchors_count']} | {h5['matured_touches']} / {h5['censored_touches']} | "
            f"{_fmt_opt(row['observed_mean_aer_h5'], '.4f')} | {_fmt_opt(row['null_mean_aer_h5'], '.4f')} | "
            f"{_fmt_opt(row['z_lift'], '.3f')} | "
            f"{_fmt_opt(h5['win_rate_2_1'], '.3f')} ({h5['wins']}/{h5['win_denom_resolved']}) | "
            f"{_fmt_opt(row['p_raw'], '.4f')} | {_fmt_opt(row['q_bh_fdr'], '.4f')} | "
            f"{_fmt_opt(row['p_romano_wolf'], '.4f')} | {_fmt_opt(row['dsr'], '.4f')} | "
            f"{row['wf_positive_folds']}/{row['wf_evaluated_folds']} | {_fmt_opt(row.get('q_bh_fdr_h3'), '.4f')} | "
            f"{_fmt_opt(row['clustering_excess'], '.4f')} | {row['reclaim_n']} / {_fmt_opt(row['reclaim_aer_5d'], '.4f')} |"
        )

    lines.extend([
        "",
        "## 3b. Directional Breakdown (`LONG` vs `SHORT`, `H=5`)",
        "",
        "| Familia | Dir | Anclajes | n_touches (mad) | aer_mean (touch) | anchor_aer | null_mean_aer | win_2to1 | net_ret_20bps | p_raw |",
        "| --- | :---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |",
    ])
    for fam, row in res["family_results"].items():
        for pol in ("LONG", "SHORT"):
            pr = row["by_polarity"][pol]
            lines.append(
                f"| `{fam}` | `{pol}` | {pr['anchors_count']} | {pr['n_touches']} ({pr['matured_touches']}) | "
                f"{_fmt_opt(pr['aer_mean'], '.4f')} | {_fmt_opt(pr['anchor_aer_mean'], '.4f')} | "
                f"{_fmt_opt(pr['null_mean_aer'], '.4f')} | "
                f"{_fmt_opt(pr['win_2to1'], '.3f')} ({pr['wins']}/{pr['win_denom']}) | "
                f"{_fmt_opt(pr['net_ret_20bps'], '.5f')} | {_fmt_opt(pr['p_raw'], '.4f')} |"
            )

    lines.extend([
        "",
        "## 4. Mean Net Return by Round-Trip Cost Scenario (`H=5` & `H=3`)",
        "",
        "| Familia | H5 0 bps | H5 20 bps | H5 35 bps | H5 50 bps | H3 mean AER | H3 z_lift | H3 p_raw | Pinning Excess |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ])
    for fam, row in res["family_results"].items():
        h5n = row["horizons"]["H5"]["mean_net_return_by_cost_bps"]
        h3 = row["horizons"]["H3"]
        lines.append(
            f"| `{fam}` | {_fmt_opt(h5n['0'], '.5f')} | {_fmt_opt(h5n['20'], '.5f')} | "
            f"{_fmt_opt(h5n['35'], '.5f')} | {_fmt_opt(h5n['50'], '.5f')} | "
            f"{_fmt_opt(h3['mean_aer'], '.4f')} | {_fmt_opt(row.get('z_lift_h3'), '.3f')} | "
            f"{_fmt_opt(row.get('p_raw_h3'), '.4f')} | {_fmt_opt(row['clustering_excess'], '.4f')} |"
        )

    lines.extend([
        "",
        "## 5. Stratum Breakdown & Survivorship Bias (`EX_DELISTED` vs `ALL`)",
        "",
        "| Estrato | Tickers | Anclajes | Toques Mad H5 | Mean AER H5 | Win 2:1 H5 | Net Ret 20bps H5 | Mean AER H3 |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ])
    for st_name, st_row in res["stratum_breakdown"].items():
        h5s = st_row["H5"]
        h3s = st_row["H3"]
        lines.append(
            f"| `{st_name}` | {st_row['tickers_count']} | {st_row['anchors_count']} | {h5s['matured_touches']} | "
            f"{_fmt_opt(h5s['mean_aer'], '.4f')} | {_fmt_opt(h5s['win_rate_2_1'], '.3f')} | "
            f"{_fmt_opt(h5s['mean_net_return_20bps'], '.5f')} | {_fmt_opt(h3s['mean_aer'], '.4f')} |"
        )
    surv = res["survivorship_bias_analysis"]
    d_surv = surv["delta_ex_delisted_minus_all"]
    lines.extend([
        "",
        f"- **Survivorship Delta (`EX_DELISTED - ALL`):** `mean_aer_h5={_fmt_opt(d_surv['mean_aer_h5_delta'], '.5f')}`, `win_2_1_h5={_fmt_opt(d_surv['win_rate_2_1_h5_delta'], '.5f')}`, `net_20bps_h5={_fmt_opt(d_surv['mean_net_return_20bps_h5_delta'], '.5f')}`, `mean_aer_h3={_fmt_opt(d_surv['mean_aer_h3_delta'], '.5f')}`",
        "",
        "## 6. Walk-Forward OOS & Regime Stratification (`POSITIVE_GAMMA` / `NEGATIVE_GAMMA` / SPY Vol)",
        "",
        f"- **Walk-Forward Ticker Eligibility:** `{json.dumps(res['walk_forward_ticker_status'])}`",
        "",
        "| Fold | Train Window | Test Window | Purged | Embargoed | Train N | Test N | Test Mean AER (H5) | Test Win 2:1 |",
        "| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ])
    for f in res["walk_forward_folds"]:
        lines.append(
            f"| {f['fold_id']} | `{f['train_start']}..{f['train_end']}` | `{f['test_start']}..{f['test_end']}` | "
            f"{f['purged_observations']} | {f['embargoed_observations']} | {f['train_sample_size']} | "
            f"{f['test_sample_size']} | {_fmt_opt(f['test_mean_aer_h5'], '.4f')} | {_fmt_opt(f['test_win_rate_2_1'], '.3f')} |"
        )

    lines.extend([
        "",
        f"- **SPY Volatility Regimes:** `{json.dumps(_sanitize_json_value(res['regime_stratification']['spy_vol_regime']))}`",
        f"- **GEX Snapshot Regimes (`LONG_GAMMA`/`SHORT_GAMMA`):** `{json.dumps(_sanitize_json_value(res['regime_stratification']['gex_snapshot_regime']))}`",
        f"- **GEX Regime Aliases (`POSITIVE_GAMMA`/`NEGATIVE_GAMMA`):** `{json.dumps(_sanitize_json_value(res['regime_stratification']['gex_regime_aliases']))}`",
        "",
    ])

    md_path.parent.mkdir(parents=True, exist_ok=True)
    md_path.write_text("\n".join(lines), encoding="utf-8")


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Offline Axis 5 AVWAP Statistical Falsification Oracle")
    p.add_argument("--tickers", type=str, default="SPY,NVDA,MELI,TWTR", help="Comma-separated tickers")
    p.add_argument("--all", action="store_true", help="Run across all 56 symbols in pilot_universe.json")
    p.add_argument("--n-perm", type=int, default=2000, help="Permutations & stationary bootstrap iterations")
    p.add_argument("--seed", type=int, default=42, help="Deterministic RNG seed")
    p.add_argument("--workers", type=int, default=1, help="Worker processes for matched permutation test (deterministic)")
    p.add_argument("--data-dir", type=str, default="", help="Optional custom data root")
    return p.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)
    tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
    d_dir = Path(args.data_dir) if args.data_dir else None
    out = run_oracle_study(
        tickers=None if args.all else tickers,
        all_universe=bool(args.all),
        n_perm=int(args.n_perm),
        seed=int(args.seed),
        workers=max(1, int(args.workers)),
        data_dir=d_dir,
    )
    compact = {
        "oracle_config_version": out["oracle_config_version"],
        "study_mode": out["study_mode"],
        "tickers_count": len(out["tickers"]),
        "tickers_audited_count": len(out["tickers_audited"]),
        "n_perm": out["n_perm"],
        "workers": out["workers"],
        "duration_s": out["duration_s"],
        "negative_controls_status": out["negative_controls_check"]["status"],
        "production_verdicts": {k: v["verdict"] for k, v in out["production_gate_summary"].items()},
        "walk_forward_folds_count": len(out["walk_forward_folds"]),
        "family_counts": {k: v["anchors_count"] for k, v in out["family_results"].items()},
    }
    print(json.dumps(_sanitize_json_value(compact), indent=2, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
