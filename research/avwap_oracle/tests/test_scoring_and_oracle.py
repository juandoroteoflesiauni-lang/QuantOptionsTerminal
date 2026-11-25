"""Comprehensive offline validation suite for Prompt #4 (Tasks 1-4, SS 6.1-6.6).

Zero live network calls are permitted (enforced by tests/conftest.py). All tests
use deterministic fixtures, independent analytical/Decimal references, and MockTransport.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import math
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx
import numpy as np
import polars as pl
import pytest
from pydantic import ValidationError
from scipy import stats

from avwap_oracle.adapters.credentials import AsyncProviderTransport, OracleCredentials
from avwap_oracle.adapters.massive_rest import (
    MassiveRestClient,
    NO_AGGRESSOR_SIDE_REASON,
    parse_occ_option_right,
    select_unusual_event_gated_dates,
)
from avwap_oracle.adapters.orats_rest import (
    OratsRestClient,
    generate_opex_sampling_dates,
    resolve_macro_wham_schedule,
)
from avwap_oracle.adapters.reconciler import reconcile_daily_oi
from avwap_oracle.math_core.canonical_rth import WeightedMomentState, build_canonical_rth_bars
from avwap_oracle.math_core.corp_actions import CorporateSplitEvent
from avwap_oracle.math_core.nyse_calendar import ET_TZ, get_session_bounds
from avwap_oracle.oracle.candidates import (
    CandidateAnchor,
    attach_split_factors_and_causal_indicators,
    generate_causal_candidates,
)
from avwap_oracle.oracle.permutation import (
    benjamini_hochberg,
    build_coherent_daily_net_return_series,
    deflated_sharpe_ratio,
    matched_monte_carlo_fdr,
    romano_wolf_stepdown,
    stationary_block_bootstrap,
)
from avwap_oracle.oracle.touches import evaluate_anchor_touches
from avwap_oracle.oracle.walk_forward import evaluate_walk_forward, stratify_touches_by_regime
from avwap_oracle.run_oracle import run_oracle_study, write_strict_json
from avwap_oracle.universe import load_pilot_universe
from avwap_oracle.scoring.iass import IassConfig, IassFeatures, compute_iass
from avwap_oracle.scoring.lifecycle import (
    AnchorSeriesInput,
    LifecycleConfig,
    compute_cohort_survival_series,
    evaluate_chop_saturation,
    evaluate_flat_slope,
    run_lifecycle_fsm,
)


def _synth_creds() -> OracleCredentials:
    return OracleCredentials.from_mapping(
        {
            "MASSIVE_KEY_2": "M_STOCK_SYN_K2",
            "MASSIVE_KEY_3": "M_STOCK_SYN_K3",
            "MASSIVE_KEY_1": "M_STOCK_SYN_K1",
            "MASSIVE_API_KEY": "M_OPT_SYN",
            "ORATS_API_KEY": "ORATS_SYN_1",
            "ORATS_API_KEYS": "ORATS_SYN_1,ORATS_SYN_2,ORATS_SYN_FORBIDDEN_3",
            "FMP_API_KEY": "FMP_SYN",
        }
    )


def _trading_dates(start_date: str, count: int) -> list[str]:
    out: list[str] = []
    cur = dt.date.fromisoformat(start_date)
    while len(out) < count:
        if get_session_bounds(cur) is not None:
            out.append(cur.isoformat())
        cur += dt.timedelta(days=1)
    return out


def _make_1d_bars(
    ticker: str,
    dates: list[str],
    closes: np.ndarray,
    *,
    highs: np.ndarray | None = None,
    lows: np.ndarray | None = None,
    opens: np.ndarray | None = None,
    volumes: np.ndarray | None = None,
) -> pl.DataFrame:
    rows: list[dict[str, Any]] = []
    for i, td in enumerate(dates):
        sb = get_session_bounds(td)
        assert sb is not None
        c = float(closes[i])
        o = float(opens[i]) if opens is not None else c
        h = float(highs[i]) if highs is not None else max(o, c) * 1.005
        l = float(lows[i]) if lows is not None else min(o, c) * 0.995
        w = float(volumes[i]) if volumes is not None else 1_000_000.0
        rows.append(
            {
                "ticker": ticker,
                "trade_date": td,
                "bucket_id": 0,
                "ts_open_utc_s": sb.rth_open_utc_s,
                "ts_close_utc_s": sb.rth_close_utc_s,
                "o": o,
                "h": h,
                "l": l,
                "c": c,
                "W": w,
                "mu": (h + l + c) / 3.0,
                "M2_within": 0.0,
                "bar_count": 390,
            }
        )
    return pl.DataFrame(rows)


# ---------------------------------------------------------------------------
# Task 1: Adapter Refinements, Macro WHAM, Event-Gated Unusual, OI & OpEx Batch
# ---------------------------------------------------------------------------


def test_task1_macro_wham_schedule_and_batch_fallback() -> None:
    # Includes Good Friday holiday (2024-03-29 -> PCE) & post-close FOMC (2024-05-01 18:00 UTC -> 14:00 ET vs post-close test)
    econ = pl.DataFrame(
        [
            {"macro_event_type": "PCE", "event": "Core PCE", "event_date": "2024-03-29", "scheduled_ts_utc_s": int(dt.datetime(2024, 3, 29, 8, 30, tzinfo=ET_TZ).timestamp())},
            {"macro_event_type": "FOMC", "event": "FOMC Minutes", "event_date": "2024-05-01", "scheduled_ts_utc_s": int(dt.datetime(2024, 5, 1, 14, 0, tzinfo=ET_TZ).timestamp())},
            {"macro_event_type": "OTHER", "event": "Ignored", "event_date": "2024-05-02", "scheduled_ts_utc_s": int(dt.datetime(2024, 5, 2, 10, 0, tzinfo=ET_TZ).timestamp())},
        ]
    )
    sched = resolve_macro_wham_schedule(econ, "2024-01-01", "2024-12-31")
    # 2024-03-29 is Good Friday (CLOSED) -> shifts T to Monday 2024-04-01, T-1 is Thu 2024-03-28
    pce_ev = [e for e in sched.events if e.macro_event_type == "PCE"][0]
    assert pce_ev.assigned_session_t == "2024-04-01"
    assert pce_ev.assigned_session_t_minus_1 == "2024-03-28"
    assert set(sched.target_dates) == {"2024-03-28", "2024-04-01", "2024-04-30", "2024-05-01"}

    creds = _synth_creds()
    reqs: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        tkr = request.url.params.get("ticker", "")
        td = request.url.params.get("tradeDate", "")
        reqs.append((tkr, td))
        if "," in tkr:
            # Batch returns SPY only, omitting QQQ on 2024-04-01 -> triggers QQQ single fallback!
            return httpx.Response(200, json={"data": [{"ticker": "SPY", "tradeDate": td, "spot": 500.0}]})
        if tkr == "QQQ" and td == "2024-04-01":
            return httpx.Response(200, json={"data": [{"ticker": "QQQ", "tradeDate": td, "spot": 440.0}]})
        if tkr == "QQQ" and td == "2024-03-28":
            return httpx.Response(404, json={"message": "No record"})
        return httpx.Response(200, json={"data": [{"ticker": tkr, "tradeDate": td, "spot": 500.0}]})

    async def run() -> None:
        async with AsyncProviderTransport(creds, transport=httpx.MockTransport(handler), min_interval_by_domain={"ORATS_HISTORICAL": 0.0}) as t:
            client = OratsRestClient(t)
            res = await client.fetch_hist_wham_macro_batch(
                ["SPY", "QQQ", "NVDA"],
                ["2024-03-28", "2024-04-01"],
                asset_classes={"SPY": "US_ETF", "QQQ": "US_ETF", "NVDA": "US_EQUITY"},
            )
            assert res.by_ticker_manifest["NVDA"]["coverage_scope"] == "NOT_APPLICABLE_NON_ETF"
            assert res.by_ticker_manifest["SPY"]["status"] == "COMPLETE"
            assert res.by_ticker_manifest["SPY"]["coverage_scope"] == "MACRO_EVENT_DATES_COMPLETE"
            assert res.by_ticker_manifest["QQQ"]["status"] == "COMPLETE"
            assert "2024-03-28" in res.by_ticker_manifest["QQQ"]["verified_absent_dates"]
            assert res.by_ticker_manifest["QQQ"]["pending_dates"] == []
            assert any(tk == "QQQ" for tk, _ in reqs)

    asyncio.run(run())


def test_task1_reconcile_daily_oi_and_event_gated_unusual_contracts() -> None:
    # Simulate SPY's 9 discrepancies including exact 2025-10-06 ORATS=0 vs Massive=16,786,351
    cores = pl.DataFrame(
        [
            {"ticker": "SPY", "trade_date": "2022-09-06", "total_oi": 19_999_762},
            {"ticker": "SPY", "trade_date": "2024-04-16", "total_oi": 22_124_742},
            {"ticker": "SPY", "trade_date": "2025-10-06", "total_oi": 0},
            {"ticker": "SPY", "trade_date": "2026-11-13", "total_oi": 18_403_290},
            {"ticker": "SPY", "trade_date": "2026-11-14", "total_oi": 0},  # Saturday non-trading -> fallback rejected!
        ]
    )
    moi = pl.DataFrame(
        [
            {"ticker": "SPY", "trade_date": "2022-09-06", "total_oi": 11_560_435},
            {"ticker": "SPY", "trade_date": "2024-04-16", "total_oi": 22_133_565},
            {"ticker": "SPY", "trade_date": "2025-10-06", "total_oi": 16_786_351},
            {"ticker": "SPY", "trade_date": "2026-11-13", "total_oi": 13_480_126},
            {"ticker": "SPY", "trade_date": "2026-11-14", "total_oi": 999},
            {"ticker": "SPY", "trade_date": "2026-11-24", "total_oi": 18_000_000},
        ]
    )
    rec = reconcile_daily_oi(cores, moi)
    by_d = {r["trade_date"]: r for r in rec.to_dicts()}
    assert by_d["2025-10-06"]["oi_source"] == "MASSIVE_FALLBACK"
    assert by_d["2025-10-06"]["effective_total_oi"] == 16_786_351
    assert by_d["2025-10-06"]["orats_total_oi_raw"] == 0
    assert "MASSIVE_POSITIVE_VERIFIED" in by_d["2025-10-06"]["oi_reconciliation_reason"]
    assert by_d["2022-09-06"]["oi_source"] == "ORATS_PRIMARY" and by_d["2022-09-06"]["effective_total_oi"] == 19_999_762
    assert by_d["2024-04-16"]["oi_source"] == "ORATS_PRIMARY" and "MINOR_UNIVERSE_DIFF" in by_d["2024-04-16"]["oi_reconciliation_reason"]
    assert by_d["2026-11-14"]["oi_source"] == "ORATS_PRIMARY" and by_d["2026-11-14"]["effective_total_oi"] == 0
    assert by_d["2026-11-24"]["oi_source"] == "MASSIVE_ONLY"

    # Candidate selection strictly past 20/60 windows + zero MAD graceful handling
    tds = _trading_dates("2024-01-02", 75)
    c_rows = []
    oi_rows = []
    for idx, td in enumerate(tds):
        vol = 10_000 if idx != 70 else 30_000  # 3.0x prior 20d avg on idx 70
        oi = int(100_000 * (1.001 ** idx)) if idx < 72 else int(100_000 * (1.001 ** 71) * 1.40)  # Huge OI spike on 72
        c_rows.append({"ticker": "NVDA", "trade_date": td, "c_volu": vol // 2, "p_volu": vol // 2, "total_oi": oi})
        oi_rows.append({"ticker": "NVDA", "trade_date": td, "total_oi": oi})
    rec_nv = reconcile_daily_oi(pl.DataFrame(c_rows), pl.DataFrame(oi_rows))
    cands = select_unusual_event_gated_dates(pl.DataFrame(c_rows), rec_nv, "2024-01-02", tds[-1])
    cand_tds = cands["trade_date"].to_list()
    assert tds[70] in cand_tds and tds[72] in cand_tds

    assert parse_occ_option_right("O:SPY240621C00500000") == "C"
    assert parse_occ_option_right("O:NVDA240621P00120000") == "P"

    # Event-gated fetch: exact filter, adjusted-root NaN guard, null net_directional_premium, PARTIAL safety cap
    creds = _synth_creds()
    sb70 = get_session_bounds(tds[70])
    assert sb70 is not None
    ts_ns_70 = str(sb70.rth_open_utc_s * 1_000_000_000)

    def u_handler(request: httpx.Request) -> httpx.Response:
        qs = request.url.params
        if int(qs["sip_timestamp.gte"]) == int(dt.datetime.fromisoformat(f"{tds[70]}T00:00:00-04:00").timestamp()) * 1_000_000_000:
            return httpx.Response(
                200,
                json={
                    "results": [
                        # Call block >= 100k
                        {"ticker": "O:NVDA240621C00120000", "underlying_ticker": "NVDA", "root": "NVDA", "sip_timestamp": ts_ns_70, "price": 6.0, "size": 200, "flags": [], "sequence_number": 1},
                        # Put ISO >= 25k
                        {"ticker": "O:NVDA240621P00110000", "underlying_ticker": "NVDA", "root": "NVDA", "sip_timestamp": ts_ns_70, "price": 3.0, "size": 100, "flags": ["iso"], "sequence_number": 2},
                        # Small 1-lot ISO < 25k -> excluded!
                        {"ticker": "O:NVDA240621C00130000", "underlying_ticker": "NVDA", "root": "NVDA", "sip_timestamp": ts_ns_70, "price": 1.0, "size": 1, "flags": ["iso"], "sequence_number": 3},
                        # Adjusted root without multiplier -> never assumes 100!
                        {"ticker": "O:NVDA1240621C00120000", "underlying_ticker": "NVDA", "root": "NVDA1", "sip_timestamp": ts_ns_70, "price": 5.0, "size": 300, "flags": [], "sequence_number": 4},
                    ]
                },
            )
        # Day 72 returns infinite pagination triggering PARTIAL cap
        return httpx.Response(
            200,
            json={
                "results": [],
                "next_url": "https://api.massive.com/options/v1/unusual-trades?cursor=next" if "cursor" not in qs else None,
            },
        )

    async def run_u() -> None:
        async with AsyncProviderTransport(creds, transport=httpx.MockTransport(u_handler), min_interval_by_domain={"MASSIVE_OPTIONS_REST": 0.0}) as t:
            cli = MassiveRestClient(t)
            res = await cli.fetch_options_unusual_event_gated("NVDA", cands, max_pages_per_day=1)
            assert res.status == "PARTIAL"
            assert res.coverage_scope == "EVENT_GATED_PARTIAL"
            r70 = res.data.filter(pl.col("trade_date") == tds[70]).row(0, named=True)
            assert r70["eligible_print_count"] == 2
            assert math.isclose(r70["call_premium"], 120_000.0)
            assert math.isclose(r70["put_premium"], 30_000.0)
            assert math.isnan(r70["net_directional_premium"])
            assert r70["net_directional_reason"] == NO_AGGRESSOR_SIDE_REASON
            assert r70["unverified_adj_root_count"] == 1
            assert r70["available_at_utc_s"] >= sb70.ext_close_utc_s

    asyncio.run(run_u())


def test_task1_opex_batched_strikes_offline_verification() -> None:
    creds = _synth_creds()
    reqs: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        tkr = request.url.params.get("ticker", "")
        td = request.url.params.get("tradeDate", "")
        reqs.append(f"{tkr}@{td}")
        if "," in tkr and td == "2024-11-14":
            # Simulate truncated batch on 2024-11-14 triggering single fallbacks
            return httpx.Response(200, json={"truncated": True, "data": []})
        # Normal batch for SPY,NVDA on 2024-12-19 with intentional duplicate strike that must NOT be double counted!
        rows = [
            {"ticker": "SPY", "tradeDate": td, "expirDate": "2024-12-20", "dte": 1, "gamma": 0.02, "callOpenInterest": 1000, "putOpenInterest": 500, "callVolume": 100, "putVolume": 50, "smvVol": 0.16},
            {"ticker": "SPY", "tradeDate": td, "expirDate": "2024-12-20", "dte": 1, "gamma": 0.02, "callOpenInterest": 1000, "putOpenInterest": 500, "callVolume": 100, "putVolume": 50, "smvVol": 0.16},
            {"ticker": "NVDA", "tradeDate": td, "expirDate": "2024-12-20", "dte": 1, "gamma": 0.03, "callOpenInterest": 800, "putOpenInterest": 200, "callVolume": 50, "putVolume": 10, "smvVol": 0.40},
        ]
        #Wait - need distinct strikes to pass deduplication? Using same strike 500 vs default None? Set explicit strike!
        for r in rows:
            r["strike"] = 500.0 if r["ticker"] == "SPY" else 130.0
        return httpx.Response(200, json={"data": [r for r in rows if r["ticker"] in tkr.split(",")]})

    async def run() -> None:
        async with AsyncProviderTransport(creds, transport=httpx.MockTransport(handler), min_interval_by_domain={"ORATS_HISTORICAL": 0.0}) as t:
            cli = OratsRestClient(t)
            out = await cli.fetch_opex_and_gex_summary_batched(
                {"SPY": ["2024-11-14", "2024-12-19"], "NVDA": ["2024-11-14", "2024-12-19"]},
                spot_by_ticker_date={("SPY", "2024-12-19"): 550.0, ("NVDA", "2024-12-19"): 135.0},
            )
            assert out.truncated_batches_detected == 1
            assert out.fallbacks_triggered == 2
            assert out.duplicates_removed >= 1
            spy_1219 = out.by_ticker_data["SPY"].filter(pl.col("trade_date") == "2024-12-19").row(0, named=True)
            # Without duplicate double-counting: call_oi == 1000, put_oi == 500
            assert spy_1219["total_call_oi"] == 1000 and spy_1219["total_put_oi"] == 500

    asyncio.run(run())


# ---------------------------------------------------------------------------
# SS 6.1 IASS Verification
# ---------------------------------------------------------------------------


def test_iass_mathematics_shrinkage_pit_and_archetypes() -> None:
    with pytest.raises(ValidationError):
        IassConfig(weight_M=0.50, weight_D=0.30, weight_F=0.20, weight_S=0.20)
    with pytest.raises(ValidationError):
        IassConfig(weight_M=-0.10, weight_D=0.50, weight_F=0.30, weight_S=0.30)

    cfg = IassConfig()
    # Exact logistic values at r = 1.0, 1.5, 2.0
    for ratio, exp_l in ((1.0, 0.500000), (1.5, 0.777300), (2.0, 0.924142)):
        bd = compute_iass(
            IassFeatures(
                family="EARNINGS_BLOWOUT",
                feature_asof=1700000000,
                realized_return=ratio * 0.05,
                implied_move_dec=0.05,
                orats_opra_covered=True,
            ),
            cfg,
        )
        assert math.isclose(bd.component_scores["D_move"], exp_l, abs_tol=1e-6)  # type: ignore[arg-type]

    # Exact ADR example without Pillar D: data_coverage = 0.70, score_renormalized = 80 -> conservative = 66.5
    target_val = 0.80
    # Find rvol_z such that ndtr(z) = 0.80 -> M = 0.80, S = 0.80, F = 0.80 -> renormalized = 80.0
    z_80 = float(stats.norm.ppf(target_val))
    gap_80 = 1.5 * math.atanh(target_val)
    disp_80 = 2.0 * math.atanh(target_val)
    bd_adr = compute_iass(
        IassFeatures(
            family="INDEX_REBAL",  # prior = 0.80
            feature_asof=1700000000,
            orats_opra_covered=False,  # Pillar D = None -> data_coverage = 0.70
            rvol_z=z_80,
            auction_ratio_z=z_80,
            gap_atr=gap_80,
            close_disp_atr=disp_80,
        ),
        cfg,
    )
    assert math.isclose(bd_adr.data_coverage, 0.70, abs_tol=1e-12)
    assert math.isclose(bd_adr.score_renormalized, 80.0, abs_tol=1e-9)  # type: ignore[arg-type]
    assert math.isclose(bd_adr.score_conservative, 66.5, abs_tol=1e-9)
    assert bd_adr.tier == "TIER_2"

    # Zero coverage -> INSUFFICIENT_DATA, score_renormalized = None, score_conservative = 35.0
    bd_zero = compute_iass(
        IassFeatures(
            family="UNKNOWN_CUSTOM",
            feature_asof=1700000000,
            orats_opra_covered=False,
            catalyst_data_available=False,
            atr_valid=False,
        ),
        cfg,
    )
    assert bd_zero.data_coverage == 0.0
    assert bd_zero.score_renormalized is None
    assert bd_zero.score_conservative == 35.0
    assert bd_zero.tier == "INSUFFICIENT_DATA" and bd_zero.status == "INSUFFICIENT_DATA"

    # Unrounded tier boundaries around 45 and 70 + PIT float & surprise exclusions + OI fallback flag
    bd_non_pit = compute_iass(
        IassFeatures(
            family="EARNINGS_BLOWOUT",
            feature_asof=1700000000,
            rvol_z=1.5,
            float_turnover_pct=0.05,
            float_is_pit=False,
            oi_source="MASSIVE_FALLBACK",
            oi_gex_shock=0.0,  # Legitimate zero != missing!
            actual_value=2.0,
            estimated_value=1.0,
            surprise_is_pit_verified=False,
            implied_move_dec=0.05,
            realized_return=0.10,
            implied_move_available_at_utc_s=1700000500,  # Future relative to return start -> rejected!
            realized_return_start_ts_utc_s=1700000000,
            gap_atr=1.5,
            close_disp_atr=2.0,
        ),
        cfg,
    )
    assert bd_non_pit.component_scores["M_float"] is None
    assert "FLOAT_NON_PIT_SNAPSHOT" in bd_non_pit.degradation_reasons
    assert "SURPRISE_EXCLUDED_NON_PIT" in bd_non_pit.degradation_reasons
    assert "ORATS_OI_FALLBACK_MASSIVE" in bd_non_pit.degradation_reasons
    assert "IMPLIED_MOVE_NOT_EX_ANTE_EXCLUDED" in bd_non_pit.degradation_reasons
    assert bd_non_pit.component_scores["D_shock"] == 0.0

    # Explicit Earnings Blowout vs Earnings Inline archetypes (> 35 pts separation under frozen weights)
    blowout = compute_iass(
        IassFeatures(
            family="EARNINGS_BLOWOUT",
            feature_asof=1700000000,
            rvol_z=3.0,
            auction_ratio_z=2.5,
            realized_return=0.20,
            implied_move_dec=0.08,
            oi_gex_shock=4.0,
            iv_change_z=2.0,
            gap_atr=3.0,
            close_disp_atr=3.5,
        ),
        cfg,
    )
    inline = compute_iass(
        IassFeatures(
            family="EARNINGS_INLINE",
            feature_asof=1700000000,
            rvol_z=-1.0,
            auction_ratio_z=-0.8,
            realized_return=0.01,
            implied_move_dec=0.08,
            oi_gex_shock=0.1,
            iv_change_z=-2.0,
            gap_atr=0.05,
            close_disp_atr=0.10,
        ),
        cfg,
    )
    assert blowout.score_conservative - inline.score_conservative > 35.0
    assert blowout.tier == "TIER_1" and inline.tier in ("NOISE", "TIER_2")


# ---------------------------------------------------------------------------
# SS 6.2 Lifecycle & FSM Verification
# ---------------------------------------------------------------------------


def test_lifecycle_grinblatt_han_chop_flat_dedup_pinch_and_fsm() -> None:
    cfg = LifecycleConfig()
    # 1) Discrete Grinblatt-Han vs exp(-turnover) across 1.0x, 1.61x, 2.0x fine vs coarse blocks
    for target_turn in (1.0, 1.61, 2.0):
        # Fine partition: 5000 bars each turning over target_turn / 5000 of float -> approaches exp(-target_turn)
        n_steps = 5000
        vols_fine = [0.0] + [1_000_000.0 * (target_turn / n_steps)] * n_steps
        res_fine = compute_cohort_survival_series(
            volumes=vols_fine,
            anchor_idx=0,
            free_float=1_000_000.0,
            family="EARNINGS_BLOWOUT",
            timeframe="1D",
            float_is_pit=True,
            config=cfg,
        )
        assert math.isclose(res_fine.s_cohort[-1], math.exp(-target_turn), rel_tol=2e-3)
        # Coarse blocks (e.g., 4 blocks of 25% vs discrete product): discrete < exp(-turnover)
        vols_coarse = [0.0] + [250_000.0 * target_turn] * 4
        res_coarse = compute_cohort_survival_series(
            volumes=vols_coarse,
            anchor_idx=0,
            free_float=1_000_000.0,
            family="EARNINGS_BLOWOUT",
            timeframe="1D",
            float_is_pit=True,
            config=cfg,
        )
        assert res_coarse.s_cohort[-1] < math.exp(-target_turn)

    # Trigger < 0.20 at 1.61x turnover vs discrete difference & 1W exemption + non-PIT guard
    res_1w_exempt = compute_cohort_survival_series(
        volumes=[0.0] + [900_000.0] * 3,
        anchor_idx=0,
        free_float=1_000_000.0,
        family="CALENDAR_YTD",
        timeframe="1W",
        float_is_pit=True,
        config=cfg,
    )
    assert res_1w_exempt.exempt_applied and not res_1w_exempt.triggered
    res_no_pit = compute_cohort_survival_series(
        volumes=[0.0, 900_000.0, 900_000.0],
        anchor_idx=0,
        free_float=1_000_000.0,
        family="EARNINGS_BLOWOUT",
        timeframe="1D",
        float_is_pit=False,
        allow_non_pit_sensitivity=False,
        config=cfg,
    )
    assert not res_no_pit.triggered and res_no_pit.disabled_reason == "FLOAT_NON_PIT_EXCLUDED_CAUSAL_PATH"

    # 2) Chop saturation: zero look-ahead (3-bar lag confirmation, discarded if >= 1.0 ATR excursion)
    n_c = 25
    av = [100.0] * n_c
    atr = [2.0] * n_c
    # Start outside above (+0.5 ATR), cross below (-0.5 ATR) at bar 2, confirmed at bar 5 -> 3 crosses by bar 12
    c_arr = [101.0, 101.0, 99.0, 99.8, 99.9, 100.1, 101.2, 98.9, 99.8, 100.0, 101.1, 98.8, 99.9, 100.0, 100.1] + [100.0] * 10
    h_arr = [x + 0.2 for x in c_arr]
    l_arr = [x - 0.2 for x in c_arr]
    chop = evaluate_chop_saturation(highs=h_arr, lows=l_arr, closes=c_arr, avwap=av, atr14=atr, config=cfg)
    assert chop.triggered
    # Cross detected at 2 is NOT confirmed at 2, 3, or 4 — only at 5!
    first_ev = chop.events[0]
    assert first_ev.cross_detected_at == 2 and first_ev.cross_confirmed_at == 5
    # Verify excursion >= 1.0 ATR discards pending cross cleanly
    h_disc = list(h_arr)
    h_disc[4] = 102.5  # +1.25 ATR excursion before confirmation bar 5
    chop_disc = evaluate_chop_saturation(highs=h_disc, lows=l_arr, closes=c_arr, avwap=av, atr14=atr, config=cfg)
    assert chop_disc.events[0].status == "DISCARDED_EXCURSION"

    # 3) Flat slope: 1D (h=5) vs 65m (h=9) vs 1H (h=10), invalid ATR non-evaluable
    flat_ok = evaluate_flat_slope(closes=[100.1] * 25, avwap=[100.0] * 25, atr14=[2.0] * 25, timeframe="1D", config=cfg)
    assert flat_ok.triggered and flat_ok.horizon_h == 5
    flat_bad_atr = evaluate_flat_slope(closes=[100.1] * 25, avwap=[100.0] * 25, atr14=[math.nan] * 25, timeframe="65m", config=cfg)
    assert not flat_bad_atr.triggered and flat_bad_atr.horizon_h == 9 and flat_bad_atr.non_evaluable_bars == 25

    # 4) Spatial dedup (deterministic, idempotent +4/+8, cap 100) + PINCH_PAIR corridor protection + visual budget
    n_f = 30
    ts_f = [1_700_000_000 + i * 86400 for i in range(n_f)]
    base_av = [100.0 + 0.4 * i for i in range(n_f)]
    near_av = [val + 0.1 for val in base_av]  # dist = 0.05 ATR < 0.25, corr = 1.0 > 0.98
    opp_av = [base_av[i] + 2.0 - 0.06 * i for i in range(n_f)]  # Converging opposite-polarity leg inside corridor!
    closes_f = [0.5 * (base_av[i] + opp_av[i]) for i in range(n_f)]
    highs_f = [x + 0.3 for x in closes_f]
    lows_f = [x - 0.3 for x in closes_f]
    atr_f = [2.0] * n_f
    vols_f = [1_000_000.0] * n_f

    anchors = [
        AnchorSeriesInput("A_KEEP", "EARNINGS_BLOWOUT", "LONG", 0, 1, ts_f[0], ts_f[0], 98.0, tuple(base_av)),
        AnchorSeriesInput("B_MERGE", "CALENDAR_QTD", "LONG", 0, 1, ts_f[0], ts_f[0], 65.0, tuple(near_av)),
        AnchorSeriesInput("C_PINCH", "POST_OPEX", "SHORT", 0, 1, ts_f[0], ts_f[0], 72.0, tuple(opp_av)),
    ]
    sim_full = run_lifecycle_fsm(
        timeframe="1D",
        bar_ts_utc_s=ts_f,
        highs=highs_f,
        lows=lows_f,
        closes=closes_f,
        volumes=vols_f,
        atr14=atr_f,
        anchors=anchors,
        config=cfg,
    )
    # A_KEEP and C_PINCH form PINCH_PAIR protecting opposite polarities; B_MERGE absorbs into A_KEEP if A_KEEP isn't yet pinched OR on bar 2+ A_KEEP+C_PINCH form PINCH_PAIR!
    # Check exact prefix invariance at T = 15
    sim_pref = run_lifecycle_fsm(
        timeframe="1D",
        bar_ts_utc_s=ts_f[:15],
        highs=highs_f[:15],
        lows=lows_f[:15],
        closes=closes_f[:15],
        volumes=vols_f[:15],
        atr14=atr_f[:15],
        anchors=[
            AnchorSeriesInput(a.anchor_id, a.family, a.polarity, a.anchor_idx, a.activated_idx, a.anchor_ts, a.available_at_utc_s, a.score_original, a.avwap_series[:15])
            for a in anchors
        ],
        config=cfg,
    )
    pref_trans = [(x.anchor_id, x.previous_state, x.next_state, x.effective_ts) for x in sim_pref.transitions]
    full_trans_up_to_15 = [
        (x.anchor_id, x.previous_state, x.next_state, x.effective_ts)
        for x in sim_full.transitions
        if x.effective_ts <= ts_f[14]
    ]
    assert pref_trans == full_trans_up_to_15

    # Verify merge idempotence & 100 cap on same-polarity anchors without opposite pinch
    sim_merge = run_lifecycle_fsm(
        timeframe="1D",
        bar_ts_utc_s=ts_f,
        highs=[v + 3.0 for v in base_av],
        lows=[v + 2.0 for v in base_av],
        closes=[v + 2.5 for v in base_av],
        volumes=vols_f,
        atr14=atr_f,
        anchors=[
            AnchorSeriesInput("K", "EARNINGS_BLOWOUT", "LONG", 0, 1, ts_f[0], ts_f[0], 98.0, tuple(base_av)),
            AnchorSeriesInput("M1", "CALENDAR_QTD", "LONG", 0, 1, ts_f[0], ts_f[0], 60.0, tuple(near_av)),
            AnchorSeriesInput("M2", "CALENDAR_YTD", "LONG", 0, 1, ts_f[0], ts_f[0], 55.0, tuple(near_av)),
        ],
        config=cfg,
    )
    snap_k = sim_merge.final_snapshots["K"]
    assert snap_k.confluence_bonus == 8.0
    assert snap_k.score_with_confluence == 100.0  # Capped at 100, never 106!
    assert snap_k.score_original == 98.0
    assert sim_merge.final_snapshots["M1"].state == "ARCHIVED"


# ---------------------------------------------------------------------------
# SS 6.3 Causality, Prefix Invariance, 10:1 Split O(1), Double-Barrier, Censorship
# ---------------------------------------------------------------------------


def test_causality_prefix_invariance_10_to_1_split_and_double_barrier() -> None:
    dates = _trading_dates("2024-01-02", 45)
    # Design a clean upward-trending raw series with a 10:1 split on index 25 (price drops 10x, vol jumps 10x)
    # Touch occurs around index 22 (pre-split), entry at index 23, H=5 horizon spans across split index 25 into index 27!
    split_idx = 25
    pre_c = np.full(45, 1000.0)
    pre_o = np.full(45, 1000.0)
    pre_h = np.full(45, 1005.0)
    pre_l = np.full(45, 995.0)
    pre_v = np.full(45, 100_000.0)

    # First 15 bars stabilize ATR ~10.0; anchor idx 14 carries heavy institutional volume (AVWAP stays ~1000)
    pre_v[14] = 5_000_000.0
    # Push price +2.5 ATR above AVWAP (~1002) for indices 15..21 so 5-bar prior separation >= 0.75 ATR holds cleanly!
    for i in range(15, 22):
        pre_o[i], pre_h[i], pre_l[i], pre_c[i] = 1028.0, 1030.0, 1024.0, 1026.0
    # Touch at idx 22: drops into AVWAP band (~1004..1006) and closes well above AVWAP - 0.5 ATR!
    pre_o[22], pre_h[22], pre_l[22], pre_c[22] = 1024.0, 1025.0, 1004.0, 1018.0
    # Entry at idx 23 open = 1018.0; upward bounce across split_idx=25 reaches 1045 (pre-split) = 104.5 (post-split)
    pre_o[23], pre_h[23], pre_l[23], pre_c[23] = 1018.0, 1024.0, 1016.0, 1022.0
    pre_o[24], pre_h[24], pre_l[24], pre_c[24] = 1022.0, 1028.0, 1021.0, 1027.0
    pre_o[25], pre_h[25], pre_l[25], pre_c[25] = 1027.0, 1045.0, 1026.0, 1043.0
    for i in range(26, 45):
        pre_o[i], pre_h[i], pre_l[i], pre_c[i] = 1043.0, 1047.0, 1040.0, 1045.0

    # Independent pre-adjusted reference (10:1 adjusted everywhere: prices / 10, volumes * 10)
    adj_bars = _make_1d_bars(
        "NVDA",
        dates,
        pre_c / 10.0,
        highs=pre_h / 10.0,
        lows=pre_l / 10.0,
        opens=pre_o / 10.0,
        volumes=pre_v * 10.0,
    )
    # Raw series: pre-split unadjusted (< split_idx), post-split divided by 10 (>= split_idx)
    raw_o = np.where(np.arange(45) >= split_idx, pre_o / 10.0, pre_o)
    raw_h = np.where(np.arange(45) >= split_idx, pre_h / 10.0, pre_h)
    raw_l = np.where(np.arange(45) >= split_idx, pre_l / 10.0, pre_l)
    raw_c = np.where(np.arange(45) >= split_idx, pre_c / 10.0, pre_c)
    raw_v = np.where(np.arange(45) >= split_idx, pre_v * 10.0, pre_v)
    raw_bars = _make_1d_bars("NVDA", dates, raw_c, highs=raw_h, lows=raw_l, opens=raw_o, volumes=raw_v)

    split_ev = [CorporateSplitEvent("nvda_10_1", "NVDA", dates[split_idx], 1.0, 10.0)]
    raw_enr = attach_split_factors_and_causal_indicators(raw_bars, splits=split_ev)
    adj_enr = attach_split_factors_and_causal_indicators(adj_bars, splits=())

    cand = CandidateAnchor(
        anchor_id="NVDA:SYNTH_10_1",
        ticker="NVDA",
        family="CALENDAR_QTD",
        polarity="LONG",
        anchor_ts=int(raw_enr["ts_open_utc_s"][14]),
        activated_ts=int(raw_enr["ts_open_utc_s"][14]),
        available_at_utc_s=int(raw_enr["ts_open_utc_s"][14]),
        anchor_idx=14,
        activated_idx=14,
        confirmation_lag=0,
        event_source="test",
        feature_asof=int(raw_enr["ts_open_utc_s"][14]),
        data_coverage=1.0,
        iass=compute_iass(IassFeatures(family="CALENDAR_QTD", feature_asof=1, gap_atr=1.0)),
        is_negative_control=False,
    )
    sum_raw = evaluate_anchor_touches(cand, raw_enr, splits=split_ev)
    sum_adj = evaluate_anchor_touches(cand, adj_enr, splits=())
    assert len(sum_raw.touches) == len(sum_adj.touches) and len(sum_raw.touches) >= 1
    assert math.isclose(float(raw_enr["rvol_z"][split_idx]), float(adj_enr["rvol_z"][split_idx]), abs_tol=1e-9)

    tr_raw = sum_raw.touches[0].outcomes[5]
    tr_adj = sum_adj.touches[0].outcomes[5]
    assert tr_raw.status == tr_adj.status == "WIN"
    assert abs(tr_raw.aer_atr - tr_adj.aer_atr) < 1e-9
    assert abs(tr_raw.net_returns_by_cost_bps[20] - tr_adj.net_returns_by_cost_bps[20]) < 1e-9

    # Prefix invariance + adversarial future bars injection
    adv_c = pre_c.copy() / 10.0
    adv_c[32:] = 5000.0  # Massive adversarial jump after touch horizon matured (23..27)
    adv_bars = _make_1d_bars("NVDA", dates, adv_c, highs=adv_c * 1.1, lows=adv_c * 0.9, opens=adv_c, volumes=pre_v * 10.0)
    # Restore prefix 0..31 identical to adj_bars
    adv_prefix_same = pl.concat([adj_bars.slice(0, 32), adv_bars.slice(32, 13)], how="vertical")
    adv_enr = attach_split_factors_and_causal_indicators(adv_prefix_same, splits=())
    sum_adv = evaluate_anchor_touches(cand, adv_enr, splits=())
    assert sum_adv.touches[0].touch_idx == sum_adj.touches[0].touch_idx == 22
    assert sum_adv.touches[0].outcomes[5] == tr_adj

    # Open horizon stays RIGHT_CENSORED when truncated at entry + 2 (idx 25)
    trunc_enr = attach_split_factors_and_causal_indicators(adj_bars.slice(0, 26), splits=())
    sum_trunc = evaluate_anchor_touches(cand, trunc_enr, splits=())
    assert sum_trunc.touches[0].outcomes[5].status == "RIGHT_CENSORED"

    # Double barrier inside same daily bar -> AMBIGUOUS without 5m, WIN/LOSS resolved WITH deterministic 5m
    db_o, db_h, db_l, db_c = pre_o.copy() / 10.0, pre_h.copy() / 10.0, pre_l.copy() / 10.0, pre_c.copy() / 10.0
    # Entry at 23 open = 101.8, ATR ~ 1.1 -> SL ~ 101.25, TP ~ 102.9 -> hit BOTH on bar 23!
    db_h[23] = 104.0
    db_l[23] = 99.5
    db_bars = attach_split_factors_and_causal_indicators(
        _make_1d_bars("NVDA", dates, db_c, highs=db_h, lows=db_l, opens=db_o, volumes=pre_v * 10.0)
    )
    sum_ambig = evaluate_anchor_touches(cand, db_bars)
    assert sum_ambig.touches[0].outcomes[5].status == "AMBIGUOUS"

    sb23 = get_session_bounds(dates[23])
    assert sb23 is not None
    b5m_tp_first = pl.DataFrame(
        [
            {"ticker": "NVDA", "trade_date": dates[23], "ts_open_utc_s": sb23.rth_open_utc_s, "h": 104.0, "l": 101.75},
            {"ticker": "NVDA", "trade_date": dates[23], "ts_open_utc_s": sb23.rth_open_utc_s + 300, "h": 102.0, "l": 99.5},
        ]
    )
    sum_res5m = evaluate_anchor_touches(cand, db_bars, bars_5m=b5m_tp_first)
    assert sum_res5m.touches[0].outcomes[5].status == "WIN"
    assert sum_res5m.touches[0].outcomes[5].intrabar_resolved_by == "RTH_5M_RESOLVED"

    # SEC S-3 shelf must be excluded, while uncorroborated 424B5 is also excluded
    sec_df = pl.DataFrame(
        [
            {"ticker": "NVDA", "form_type": "S-3ASR", "filing_date": dates[16], "available_at_utc_s": int(adj_enr["ts_open_utc_s"][16])},
            {"ticker": "NVDA", "form_type": "424B5", "filing_date": dates[18], "available_at_utc_s": int(adj_enr["ts_open_utc_s"][18])},
        ]
    )
    c_sec = generate_causal_candidates(ticker="NVDA", asset_class="US_EQUITY", bars_1d=adj_bars, sec_filings_df=sec_df)
    assert not any(c.family == "SECONDARY_OFFERING" for c in c_sec.candidates)
    assert c_sec.exclusion_counts.get("SHELF_REGISTRATION_NOT_EXECUTED_OFFERING", 0) == 1
    assert c_sec.exclusion_counts.get("424B5_NO_MARKET_PLACEMENT_EVIDENCE", 0) == 1


# ---------------------------------------------------------------------------
# SS 6.4 Null Calibration, SS 6.5 Power, SS 6.6 Inference & Edge Cases
# ---------------------------------------------------------------------------


def test_null_calibration_unbiased_fpr_binomial_ci() -> None:
    """Verify matched Monte Carlo produces calibrated null p-values across pure random walks."""
    dates = _trading_dates("2022-01-03", 500)
    n = len(dates)
    rng = np.random.default_rng(np.random.PCG64(12345))
    raw_ps: list[float] = []

    for walk_i in range(10):
        shocks = rng.normal(0.0002, 0.015, size=n)
        closes = 100.0 * np.exp(np.cumsum(shocks))
        opens = np.roll(closes, 1)
        opens[0] = 100.0
        highs = np.maximum(opens, closes) * (1.0 + rng.uniform(0.002, 0.012, size=n))
        lows = np.minimum(opens, closes) * (1.0 - rng.uniform(0.002, 0.012, size=n))
        vols = rng.uniform(800_000.0, 1_500_000.0, size=n)
        bars = _make_1d_bars("SPY", dates, closes, highs=highs, lows=lows, opens=opens, volumes=vols)
        res_c = generate_causal_candidates(ticker="SPY", asset_class="US_ETF", bars_1d=bars)
        cands = [c for c in res_c.candidates if c.family == "SWING_NO_RVOL"]
        ts_map = {c.anchor_id: evaluate_anchor_touches(c, res_c.bars_enriched) for c in cands}
        perm = matched_monte_carlo_fdr(
            {"SPY": cands},
            {"SPY": ts_map},
            {"SPY": res_c.bars_enriched},
            {"SPY": ()},
            n_perm=80,
            seed=900 + walk_i,
            min_pool_size=2,
        )
        r_fam = perm.results_by_family.get("SWING_NO_RVOL")
        if r_fam and r_fam.p_raw is not None:
            raw_ps.append(r_fam.p_raw)

    assert len(raw_ps) >= 6
    fpr = sum(1 for p in raw_ps if p <= 0.05) / float(len(raw_ps))
    # Under unbiased null, mean p ~ 0.5 and FPR within Monte Carlo binomial tolerance (not systematically inflated to 1.0)
    assert np.mean(raw_ps) > 0.20
    assert fpr <= 0.35


def test_statistical_power_planted_bounce_vs_negative_control() -> None:
    """Planted deterministic institutional bounce must pass q_bh_fdr <= 0.05 while negative control stays non-significant."""
    dates = _trading_dates("2022-01-03", 500)
    n = len(dates)
    rng = np.random.default_rng(np.random.PCG64(777))
    shocks = rng.normal(0.0, 0.003, size=n)
    closes = 100.0 * np.exp(np.cumsum(shocks))
    opens = closes.copy()
    highs = closes * 1.0025
    lows = closes * 0.9975
    vols = np.full(n, 1_000_000.0)

    o_mod, h_mod, l_mod, c_mod, v_mod = opens.copy(), highs.copy(), lows.copy(), closes.copy(), vols.copy()

    qtd_idxs = [40, 85, 130, 175, 220, 265, 310, 355, 400, 445]
    for a_i in qtd_idxs:
        ref_p = c_mod[a_i - 1]
        o_mod[a_i], h_mod[a_i], l_mod[a_i], c_mod[a_i] = ref_p, ref_p * 1.002, ref_p * 0.998, ref_p
        v_mod[a_i] = 5_000_000.0
        for u in range(a_i + 1, a_i + 10):
            lvl = ref_p * (1.0 + 0.005 * min(u - a_i, 4))
            o_mod[u], h_mod[u], l_mod[u], c_mod[u] = lvl, lvl * 1.002, lvl * 0.998, lvl
        k_t = a_i + 10
        o_mod[k_t], h_mod[k_t], l_mod[k_t], c_mod[k_t] = ref_p * 1.014, ref_p * 1.015, ref_p * 1.0085, ref_p * 1.012
        for step_m in range(1, 6):
            f_i = k_t + step_m
            op_f = ref_p * (1.012 + 0.005 * (step_m - 1))
            cl_f = ref_p * (1.012 + 0.006 * step_m)
            o_mod[f_i], h_mod[f_i], l_mod[f_i], c_mod[f_i] = op_f, cl_f * 1.002, op_f * 0.999, cl_f
        last_c = c_mod[k_t + 5]
        for rem in range(k_t + 6, min(n, a_i + 45)):
            last_c = last_c * math.exp(rng.normal(0.0, 0.003))
            o_mod[rem], h_mod[rem], l_mod[rem], c_mod[rem] = last_c, last_c * 1.0025, last_c * 0.9975, last_c

    bars_planted = attach_split_factors_and_causal_indicators(
        _make_1d_bars("SPY", dates, c_mod, highs=h_mod, lows=l_mod, opens=o_mod, volumes=v_mod)
    )
    ts_opens = bars_planted["ts_open_utc_s"].to_list()
    cands: list[CandidateAnchor] = []
    for a_i in qtd_idxs:
        cands.append(
            CandidateAnchor(
                anchor_id=f"SPY:PLANTED_QTD:{a_i}",
                ticker="SPY",
                family="CALENDAR_QTD",
                polarity="LONG",
                anchor_ts=int(ts_opens[a_i]),
                activated_ts=int(ts_opens[a_i]),
                available_at_utc_s=int(ts_opens[a_i]),
                anchor_idx=a_i,
                activated_idx=a_i,
                confirmation_lag=0,
                event_source="planted_test",
                feature_asof=int(ts_opens[a_i]),
                data_coverage=1.0,
                iass=compute_iass(IassFeatures(family="CALENDAR_QTD", feature_asof=int(ts_opens[a_i]))),
                is_negative_control=False,
            )
        )
    # Plant EX_DIVIDEND_REGULAR negative controls strictly away from QTD bounce windows
    for d_i in (62, 107, 152, 197, 242, 287, 332, 377):
        cands.append(
            CandidateAnchor(
                anchor_id=f"SPY:NEG_DIV:{d_i}",
                ticker="SPY",
                family="EX_DIVIDEND_REGULAR",
                polarity="LONG",
                anchor_ts=int(ts_opens[d_i]),
                activated_ts=int(ts_opens[d_i]),
                available_at_utc_s=int(ts_opens[d_i]),
                anchor_idx=d_i,
                activated_idx=d_i,
                confirmation_lag=0,
                event_source="neg_ctrl_test",
                feature_asof=int(ts_opens[d_i]),
                data_coverage=1.0,
                iass=compute_iass(IassFeatures(family="EX_DIVIDEND_REGULAR", feature_asof=int(ts_opens[d_i]))),
                is_negative_control=True,
            )
        )

    ts_map = {c.anchor_id: evaluate_anchor_touches(c, bars_planted) for c in cands}
    perm = matched_monte_carlo_fdr(
        {"SPY": cands},
        {"SPY": ts_map},
        {"SPY": bars_planted},
        {"SPY": ()},
        n_perm=300,
        seed=42,
        min_pool_size=2,
    )
    p_qtd = perm.results_by_family["CALENDAR_QTD"].p_raw
    r_neg = perm.results_by_family.get("EX_DIVIDEND_REGULAR")
    p_neg = r_neg.p_raw if r_neg else None
    qs = benjamini_hochberg([p_qtd, p_neg], alpha=0.05)
    assert p_qtd is not None and qs[0] is not None and qs[0] <= 0.05
    if p_neg is not None:
        assert p_neg > 0.05


def test_inference_bh_romano_wolf_dsr_and_edge_cases(tmp_path: Path) -> None:
    # 1) Independent BH calculation with ties & None preservation
    p_in: list[float | None] = [0.04, None, 0.01, 0.01, 0.50]
    # Valid sorted: 0.01 (r=1 -> 0.04), 0.01 (r=2 -> 0.02), 0.04 (r=3 -> 0.0533), 0.50 (r=4 -> 0.50)
    q_out = benjamini_hochberg(p_in, alpha=0.05)
    assert q_out[1] is None
    assert math.isclose(q_out[2], 0.02, abs_tol=1e-12)  # type: ignore[arg-type]
    assert math.isclose(q_out[3], 0.02, abs_tol=1e-12)  # type: ignore[arg-type]
    assert math.isclose(q_out[0], 0.04 * 4 / 3, abs_tol=1e-12)  # type: ignore[arg-type]
    assert math.isclose(q_out[4], 0.50, abs_tol=1e-12)  # type: ignore[arg-type]

    # 2) Independent analytical DSR verification (Bailey & Lopez de Prado, Pearson kurtosis = 3 normal convention)
    rng = np.random.default_rng(np.random.PCG64(99))
    rets = list(rng.normal(0.002, 0.01, size=60))
    dsr_r = deflated_sharpe_ratio(rets, n_trials_m=10)
    arr = np.asarray(rets, dtype=np.float64)
    sr_exp = float(np.mean(arr) / np.std(arr, ddof=1))
    g3 = float(stats.skew(arr, bias=True))
    g4 = float(stats.kurtosis(arr, fisher=False, bias=True))
    eg = 0.5772156649015329
    sr_star_exp = (1.0 / math.sqrt(60.0)) * (
        (1.0 - eg) * float(stats.norm.ppf(1.0 - 0.1)) + eg * float(stats.norm.ppf(1.0 - math.exp(-1.0) * 0.1))
    )
    z_exp = ((sr_exp - sr_star_exp) * math.sqrt(59.0)) / math.sqrt(1.0 - g3 * sr_exp + ((g4 - 1.0) / 4.0) * sr_exp**2)
    assert math.isclose(dsr_r.dsr, float(stats.norm.cdf(z_exp)), abs_tol=1e-12)  # type: ignore[arg-type]

    # Edge cases: zero variance & few obs -> DSR_NOT_EVALUABLE (never Inf or fake 0 significance)
    assert deflated_sharpe_ratio([0.01] * 25, n_trials_m=5).status == "DSR_NOT_EVALUABLE"
    assert deflated_sharpe_ratio([0.01, -0.01, 0.02], n_trials_m=5).status == "DSR_NOT_EVALUABLE"

    # 3) Date-synchronized stationary block bootstrap + Romano-Wolf stepdown
    dates = _trading_dates("2024-01-02", 80)
    obs_rw = {
        "STRONG": [(d, 0.8 + 0.05 * ((i % 3) - 1)) for i, d in enumerate(dates)],
        "CORR_NULL": [(d, 0.01 * math.sin(i)) for i, d in enumerate(dates)],
        "ZERO_VAR": [(d, 0.5) for d in dates[:15]],
    }
    rw = romano_wolf_stepdown(obs_rw, all_dates=dates, n_boot=120, avg_block_len=5.0, seed=7)
    assert rw.p_rw_by_family["STRONG"] is not None and rw.p_rw_by_family["STRONG"] < 0.05
    assert rw.p_rw_by_family["ZERO_VAR"] is None and rw.status_by_family["ZERO_VAR"] == "DEGENERATE_ZERO_VARIANCE"

    # 4) Walk-forward insufficient history (< 2y -> TWTR 0 folds, no fabrication) & strict NaN-free JSON
    twtr_dates = _trading_dates("2021-01-15", 350)  # < 24 months
    _, wf_st = evaluate_walk_forward(
        touches=(),
        bar_dates_by_ticker={"TWTR": twtr_dates},
        config_version="test_v1",
        dataset_hash="abc",
    )
    assert wf_st["TWTR"] == "INSUFFICIENT_HISTORY_ZERO_FOLDS"

    j_path = tmp_path / "strict_out.json"
    write_strict_json(j_path, {"p_raw": math.nan, "dsr": float("inf"), "val": 1.5})
    loaded = json.loads(j_path.read_text(encoding="utf-8"))
    assert loaded == {"p_raw": None, "dsr": None, "val": 1.5}


# ---------------------------------------------------------------------------
# Prompt #5 Regression & Parity Tests (Task 1 Earnings + Task 2 SHORT/Workers)
# ---------------------------------------------------------------------------


def test_earnings_blowout_bmo_amc_timing_scale_and_split() -> None:
    """Verify AMC (T -> T_react close-to-close + EOD T snapshot), BMO (T-1 -> T), and split consistency."""
    dates = _trading_dates("2024-01-02", 40)
    n = len(dates)
    opens = np.full(n, 100.0)
    highs = np.full(n, 101.0)
    lows = np.full(n, 99.0)
    closes = np.full(n, 100.0)
    vols = np.full(n, 1_000_000.0)

    # 1) AMC report on index 20: overnight gap (+6%) + RTH continuation (+4% -> total +10% close-to-close!)
    # Check AMC reads pre-event impErnMv at T=20 (0.06), NOT crushed T_react=21 (0.02)!
    amc_t = 20
    amc_react = 21
    opens[amc_react], highs[amc_react], lows[amc_react], closes[amc_react] = 106.0, 111.0, 105.0, 110.0

    # 2) BMO report on index 28 with a 10:1 split on index 28: pre=27 close 110.0, react=28 open/close 11.20 (+1.82% split-adj, NOT -90%!)
    bmo_t = 28
    for i in range(amc_react + 1, bmo_t):
        opens[i] = highs[i] = lows[i] = closes[i] = 110.0
        highs[i] = 110.5
        lows[i] = 109.5
    for i in range(bmo_t, n):
        opens[i], highs[i], lows[i], closes[i] = 11.2, 11.3, 11.1, 11.2
        vols[i] = 10_000_000.0

    bars = _make_1d_bars("NVDA", dates, closes, highs=highs, lows=lows, opens=opens, volumes=vols)
    splits = [CorporateSplitEvent("nvda_10_1", "NVDA", dates[bmo_t], 1.0, 10.0)]

    sb_amc_react = get_session_bounds(dates[amc_react])
    sb_bmo_t = get_session_bounds(dates[bmo_t])
    assert sb_amc_react is not None and sb_bmo_t is not None

    earn_df = pl.DataFrame(
        [
            {
                "ticker": "NVDA",
                "earn_date_canonical": dates[amc_t],
                "earnings_timing": "AMC",
                "timing_source": "test_amc",
                "available_at_utc_s": sb_amc_react.rth_open_utc_s - 60,
                "anchor_ts_rth_utc_s": sb_amc_react.rth_open_utc_s,
            },
            {
                "ticker": "NVDA",
                "earn_date_canonical": dates[bmo_t],
                "earnings_timing": "BMO",
                "timing_source": "test_bmo",
                "available_at_utc_s": sb_bmo_t.rth_open_utc_s - 60,
                "anchor_ts_rth_utc_s": sb_bmo_t.rth_open_utc_s,
            },
        ]
    )
    cores_df = pl.DataFrame(
        [
            {"ticker": "NVDA", "trade_date": dates[amc_t], "imp_ern_mv_dec": 0.06, "cores_implied_earnings_move_dec": 0.04, "or_iv_xern_20d_dec": 0.40},
            # Crushed post-event on amc_react: must NOT be used for AMC classification!
            {"ticker": "NVDA", "trade_date": dates[amc_react], "imp_ern_mv_dec": 0.02, "cores_implied_earnings_move_dec": 0.01, "or_iv_xern_20d_dec": 0.30},
            {"ticker": "NVDA", "trade_date": dates[bmo_t - 1], "imp_ern_mv_dec": 0.08, "cores_implied_earnings_move_dec": 0.05, "or_iv_xern_20d_dec": 0.35},
            {"ticker": "NVDA", "trade_date": dates[bmo_t], "imp_ern_mv_dec": 0.01, "cores_implied_earnings_move_dec": 0.01, "or_iv_xern_20d_dec": 0.30},
        ]
    )

    res = generate_causal_candidates(
        ticker="NVDA",
        asset_class="US_EQUITY",
        bars_1d=bars,
        splits=splits,
        earnings_reconciled_df=earn_df,
        orats_cores_df=cores_df,
    )
    ern_cands = {c.anchor_idx: c for c in res.candidates if c.family in ("EARNINGS_BLOWOUT", "EARNINGS_INLINE")}
    assert amc_react in ern_cands and bmo_t in ern_cands
    # AMC: r_ern = +10% / 0.04 (isolated 1d implied move) = 2.50 >= 1.25 -> BLOWOUT!
    c_amc = ern_cands[amc_react]
    assert c_amc.family == "EARNINGS_BLOWOUT" and c_amc.polarity == "LONG"
    assert math.isclose(c_amc.iass.component_scores["D_move"], 1.0 / (1.0 + math.exp(-2.5 * (0.10 / 0.04 - 1.0))), abs_tol=1e-9)  # type: ignore[arg-type]
    # BMO across 10:1 split: (11.2 - 11.0) / 11.0 = +1.818% / 0.05 = 0.364 < 0.75 -> INLINE LONG (NOT -90% SHORT!)
    c_bmo = ern_cands[bmo_t]
    assert c_bmo.family == "EARNINGS_INLINE" and c_bmo.polarity == "LONG"


def test_touches_short_sign_directional_matching_and_workers_parity(tmp_path: Path) -> None:
    """Verify SHORT TP/SL/AER signs, reclaim symmetry, directional MC, and exact bit-for-bit workers=1 vs workers=4 parity."""
    dates = _trading_dates("2022-01-03", 280)
    n = len(dates)
    rng = np.random.default_rng(np.random.PCG64(2026))
    shocks = rng.normal(0.0, 0.004, size=n)
    c = 100.0 * np.exp(np.cumsum(shocks))
    o = c.copy()
    h = c * 1.004
    l = c * 0.996
    v = np.full(n, 1_000_000.0)

    # Plant TWO anchors on ticker SPY:
    # 1) SHORT anchor at idx=25: heavy anchor volume pins AVWAP near ref_s; 5 bars stay >= 1.5 ATR below AVWAP, then touch & drop (WIN SHORT!)
    a_short = 25
    ref_s = c[a_short - 1]
    o[a_short] = h[a_short] = l[a_short] = c[a_short] = ref_s
    h[a_short] = ref_s * 1.003
    l[a_short] = ref_s * 0.997
    v[a_short] = 20_000_000.0
    for u in range(a_short + 1, a_short + 6):
        px = ref_s * (0.985 - 0.003 * (u - a_short))
        o[u], h[u], l[u], c[u] = px, px * 1.001, px * 0.999, px
    k_s = a_short + 6  # touch from below on SHORT anchor (av_k ~ 0.995 * ref_s)
    o[k_s], h[k_s], l[k_s], c[k_s] = ref_s * 0.982, ref_s * 0.997, ref_s * 0.980, ref_s * 0.988
    # Entry at k_s+1 drops sharply -> SHORT WIN (+1.0 ATR TP hit cleanly)
    o[k_s + 1], h[k_s + 1], l[k_s + 1], c[k_s + 1] = ref_s * 0.987, ref_s * 0.988, ref_s * 0.950, ref_s * 0.952

    # 2) LONG anchor at idx=160 in different window with planted bounce
    a_long = 160
    ref_l = c[a_long - 1]
    o[a_long], h[a_long], l[a_long], c[a_long] = ref_l, ref_l * 1.003, ref_l * 0.997, ref_l
    v[a_long] = 20_000_000.0
    for u in range(a_long + 1, a_long + 6):
        px = ref_l * (1.015 + 0.003 * (u - a_long))
        o[u], h[u], l[u], c[u] = px, px * 1.001, px * 0.999, px
    k_l = a_long + 6
    o[k_l], h[k_l], l[k_l], c[k_l] = ref_l * 1.018, ref_l * 1.020, ref_l * 1.003, ref_l * 1.012
    o[k_l + 1], h[k_l + 1], l[k_l + 1], c[k_l + 1] = ref_l * 1.013, ref_l * 1.050, ref_l * 1.012, ref_l * 1.048

    # Save minimal multi-ticker offline dataset in tmp_path/data to test full run_oracle_study(workers=1 vs 4)
    d_root = tmp_path / "data"
    (d_root / "canonical" / "rth_1D").mkdir(parents=True, exist_ok=True)
    bars_spy = _make_1d_bars("SPY", dates, c, highs=h, lows=l, opens=o, volumes=v)
    bars_nvda = _make_1d_bars("NVDA", dates, c * 1.1, highs=h * 1.1, lows=l * 1.1, opens=o * 1.1, volumes=v)
    bars_spy.write_parquet(d_root / "canonical" / "rth_1D" / "SPY.parquet")
    bars_nvda.write_parquet(d_root / "canonical" / "rth_1D" / "NVDA.parquet")

    # Verify SHORT touch sign explicitly
    enr_spy = attach_split_factors_and_causal_indicators(bars_spy)
    c_short = CandidateAnchor(
        anchor_id="SPY:SHORT_TEST", ticker="SPY", family="CALENDAR_QTD", polarity="SHORT",
        anchor_ts=int(enr_spy["ts_open_utc_s"][a_short]), activated_ts=int(enr_spy["ts_open_utc_s"][a_short]),
        available_at_utc_s=int(enr_spy["ts_open_utc_s"][a_short]), anchor_idx=a_short, activated_idx=a_short,
        confirmation_lag=0, event_source="test", feature_asof=int(enr_spy["ts_open_utc_s"][a_short]),
        data_coverage=1.0, iass=compute_iass(IassFeatures(family="CALENDAR_QTD", feature_asof=1)), is_negative_control=False,
    )
    sum_s = evaluate_anchor_touches(c_short, enr_spy)
    assert len(sum_s.touches) >= 1
    out_s = sum_s.touches[0].outcomes[5]
    assert out_s.status == "WIN" and out_s.aer_atr > 0.0 and out_s.gross_return > 0.0
    assert out_s.net_returns_by_cost_bps[20] < out_s.gross_return

    # Verify matched_monte_carlo_fdr workers=1 vs workers=4 bit-for-bit parity (both combined and directional)
    enr_nvda = attach_split_factors_and_causal_indicators(bars_nvda)
    c_long = CandidateAnchor(
        anchor_id="SPY:LONG_TEST", ticker="SPY", family="CALENDAR_QTD", polarity="LONG",
        anchor_ts=int(enr_spy["ts_open_utc_s"][a_long]), activated_ts=int(enr_spy["ts_open_utc_s"][a_long]),
        available_at_utc_s=int(enr_spy["ts_open_utc_s"][a_long]), anchor_idx=a_long, activated_idx=a_long,
        confirmation_lag=0, event_source="test", feature_asof=int(enr_spy["ts_open_utc_s"][a_long]),
        data_coverage=1.0, iass=compute_iass(IassFeatures(family="CALENDAR_QTD", feature_asof=1)), is_negative_control=False,
    )
    c_nv = CandidateAnchor(
        anchor_id="NVDA:LONG_TEST", ticker="NVDA", family="CALENDAR_YTD", polarity="LONG",
        anchor_ts=int(enr_nvda["ts_open_utc_s"][a_long]), activated_ts=int(enr_nvda["ts_open_utc_s"][a_long]),
        available_at_utc_s=int(enr_nvda["ts_open_utc_s"][a_long]), anchor_idx=a_long, activated_idx=a_long,
        confirmation_lag=0, event_source="test", feature_asof=int(enr_nvda["ts_open_utc_s"][a_long]),
        data_coverage=1.0, iass=compute_iass(IassFeatures(family="CALENDAR_YTD", feature_asof=1)), is_negative_control=False,
    )
    sum_l = evaluate_anchor_touches(c_long, enr_spy)
    sum_nv = evaluate_anchor_touches(c_nv, enr_nvda)
    p1 = matched_monte_carlo_fdr(
        {"SPY": [c_short, c_long], "NVDA": [c_nv]},
        {"SPY": {c_short.anchor_id: sum_s, c_long.anchor_id: sum_l}, "NVDA": {c_nv.anchor_id: sum_nv}},
        {"SPY": enr_spy, "NVDA": enr_nvda},
        {"SPY": (), "NVDA": ()},
        n_perm=100, seed=42, min_pool_size=2, workers=1,
    )
    p4 = matched_monte_carlo_fdr(
        {"SPY": [c_short, c_long], "NVDA": [c_nv]},
        {"SPY": {c_short.anchor_id: sum_s, c_long.anchor_id: sum_l}, "NVDA": {c_nv.anchor_id: sum_nv}},
        {"SPY": enr_spy, "NVDA": enr_nvda},
        {"SPY": (), "NVDA": ()},
        n_perm=100, seed=42, min_pool_size=2, workers=4,
    )
    assert p1.results_by_family == p4.results_by_family
    assert p1.directional_results == p4.directional_results

    # Verify end-to-end run_oracle_study workers=1 vs workers=4 produces bit-for-bit identical JSON payloads
    uni_test = load_pilot_universe()
    r1 = run_oracle_study(
        tickers=["SPY", "NVDA"], n_perm=80, seed=77, workers=1, data_dir=d_root,
        config_path=tmp_path / "cfg1.json", json_report_path=tmp_path / "r1.json", md_report_path=tmp_path / "r1.md",
        universe=uni_test,
    )
    r4 = run_oracle_study(
        tickers=["SPY", "NVDA"], n_perm=80, seed=77, workers=4, data_dir=d_root,
        config_path=tmp_path / "cfg4.json", json_report_path=tmp_path / "r4.json", md_report_path=tmp_path / "r4.md",
        universe=uni_test,
    )
    j1 = json.loads((tmp_path / "r1.json").read_text(encoding="utf-8"))
    j4 = json.loads((tmp_path / "r4.json").read_text(encoding="utf-8"))
    for d_clean in (j1, j4):
        d_clean.pop("generated_at_utc", None)
        d_clean.pop("duration_s", None)
        d_clean.pop("workers", None)
    assert j1 == j4
    assert "CALENDAR_QTD" in r1["family_results"]
    assert "z_lift" in r1["family_results"]["CALENDAR_QTD"]
    assert "LONG" in r1["family_results"]["CALENDAR_QTD"]["by_polarity"]
    assert "SHORT" in r1["family_results"]["CALENDAR_QTD"]["by_polarity"]


def test_prompt5_post_opex_monthly_share_and_no_imp_ern_fusion() -> None:
    """Verify POST_OPEX uses monthly_opex_gex_share when weekly 0DTE lowers expiring_gex_share, and impErnMv never fuses."""
    dates = _trading_dates("2024-06-03", 25)
    n = len(dates)
    closes = np.linspace(500.0, 520.0, n)
    bars = _make_1d_bars("SPY", dates, closes)

    # OpEx 2024-06-21 -> PRE_OPEX 2024-06-20 has Thursday 0DTE expiring_gex_share=0.19 (<0.25)
    # but monthly_opex_gex_share=0.35 (>=0.25) -> MUST emit POST_OPEX candidate!
    # Also include one row with monthly_opex_gex_share=0.20 (<0.25) -> MUST be excluded!
    gex_df = pl.DataFrame(
        [
            {
                "ticker": "SPY",
                "trade_date": "2024-06-20",
                "sampling_mode": "PRE_OPEX",
                "monthly_opex_expir_date": "2024-06-21",
                "expiring_gex_share": 0.19,
                "monthly_opex_gex_share": 0.35,
                "net_gex_raw_gamma_oi": 1_000_000.0,
            },
            {
                "ticker": "SPY",
                "trade_date": "2024-06-13",
                "sampling_mode": "PRE_OPEX",
                "monthly_opex_expir_date": "2024-06-14",
                "expiring_gex_share": 0.40,
                "monthly_opex_gex_share": 0.20,
                "net_gex_raw_gamma_oi": -500_000.0,
            },
        ]
    )
    res_gex = generate_causal_candidates(
        ticker="SPY",
        asset_class="US_ETF",
        bars_1d=bars,
        orats_gex_opex_df=gex_df,
    )
    post_cands = [c for c in res_gex.candidates if c.family == "POST_OPEX"]
    assert len(post_cands) == 1
    assert dates[post_cands[0].anchor_idx] == "2024-06-24"
    assert res_gex.exclusion_counts.get("PRE_OPEX_GEX_SHARE_BELOW_0.25_OR_NAN", 0) == 1

    # Verify missing cores_implied_earnings_move_dec (+ absent orats_summaries) NEVER silently fuses imp_ern_mv_dec (multi-day)
    sb_react = get_session_bounds(dates[21])
    assert sb_react is not None
    earn_df = pl.DataFrame(
        [
            {
                "ticker": "SPY",
                "earn_date_canonical": dates[20],
                "earnings_timing": "AMC",
                "timing_source": "test_no_fusion",
                "available_at_utc_s": sb_react.rth_open_utc_s - 60,
                "anchor_ts_rth_utc_s": sb_react.rth_open_utc_s,
            }
        ]
    )
    cores_missing_1d = pl.DataFrame(
        [
            {
                "ticker": "SPY",
                "trade_date": dates[20],
                "imp_ern_mv_dec": 0.05,
                "cores_implied_earnings_move_dec": math.nan,
                "or_iv_xern_20d_dec": 0.20,
            }
        ]
    )
    res_ern = generate_causal_candidates(
        ticker="SPY",
        asset_class="US_EQUITY",
        bars_1d=bars,
        earnings_reconciled_df=earn_df,
        orats_cores_df=cores_missing_1d,
    )
    assert not any(c.family in ("EARNINGS_BLOWOUT", "EARNINGS_INLINE") for c in res_ern.candidates)
    assert res_ern.exclusion_counts.get("EARNINGS_MISSING_EX_ANTE_IMPLIED_MOVE", 0) == 1

    # Also verify summaries.impliedEarningsMove (primary) overrides cores_implied_earnings_move_dec causally
    prev_c = float(closes[20])
    bars_ern = bars.with_columns(
        pl.when(pl.col("trade_date") == dates[21]).then(prev_c * 1.10).otherwise(pl.col("o")).alias("o"),
        pl.when(pl.col("trade_date") == dates[21]).then(prev_c * 1.12).otherwise(pl.col("h")).alias("h"),
        pl.when(pl.col("trade_date") == dates[21]).then(prev_c * 1.08).otherwise(pl.col("l")).alias("l"),
        pl.when(pl.col("trade_date") == dates[21]).then(prev_c * 1.10).otherwise(pl.col("c")).alias("c"),
    )
    summaries_1d = pl.DataFrame(
        [
            {"ticker": "SPY", "trade_date": dates[20], "implied_earnings_move_dec": 0.05},
        ]
    )
    res_ern_prim = generate_causal_candidates(
        ticker="SPY",
        asset_class="US_EQUITY",
        bars_1d=bars_ern,
        earnings_reconciled_df=earn_df,
        orats_cores_df=cores_missing_1d,
        orats_summaries_df=summaries_1d,
    )
    blowouts = [c for c in res_ern_prim.candidates if c.family == "EARNINGS_BLOWOUT"]
    assert len(blowouts) == 1 and math.isclose(blowouts[0].iass.component_scores["D_move"], 1.0 / (1.0 + math.exp(-2.5 * (0.10 / 0.05 - 1.0))), abs_tol=1e-9)  # type: ignore[arg-type]


def test_prompt5_orats_batch_probe_offline_mock(tmp_path: Path) -> None:
    """Verify probe_orats_batch offline via MockTransport: 302 redirect, GEX/WHAM 1:1 parity, zero secret leak."""
    from avwap_oracle.adapters.orats_rest import compute_gex_opex_summary_from_strikes
    from avwap_oracle.probe_orats_batch import run_orats_batch_micro_probe

    d_root = tmp_path / "data" / "derivatives"
    (d_root / "orats_gex_opex").mkdir(parents=True, exist_ok=True)
    (d_root / "orats_wham").mkdir(parents=True, exist_ok=True)

    strike_rows_by_sym = {
        "SPY": [
            {"ticker": "SPY", "tradeDate": "2024-06-20", "expirDate": "2024-06-21", "dte": 1, "strike": 545.0, "gamma": 0.02, "callOpenInterest": 2000, "putOpenInterest": 500, "callVolume": 100, "putVolume": 50, "smvVol": 0.14},
            {"ticker": "SPY", "tradeDate": "2024-06-20", "expirDate": "2024-06-21", "dte": 1, "strike": 540.0, "gamma": 0.02, "callOpenInterest": 200, "putOpenInterest": 3000, "callVolume": 10, "putVolume": 80, "smvVol": 0.15},
        ],
        "NVDA": [
            {"ticker": "NVDA", "tradeDate": "2024-06-20", "expirDate": "2024-06-21", "dte": 1, "strike": 130.0, "gamma": 0.03, "callOpenInterest": 5000, "putOpenInterest": 1000, "callVolume": 200, "putVolume": 50, "smvVol": 0.45},
        ],
        "MELI": [
            {"ticker": "MELI", "tradeDate": "2024-06-20", "expirDate": "2024-06-21", "dte": 1, "strike": 1600.0, "gamma": 0.01, "callOpenInterest": 300, "putOpenInterest": 100, "callVolume": 20, "putVolume": 10, "smvVol": 0.32},
            {"ticker": "MELI", "tradeDate": "2024-06-20", "expirDate": "2024-06-21", "dte": 1, "strike": 1570.0, "gamma": 0.01, "callOpenInterest": 50, "putOpenInterest": 400, "callVolume": 5, "putVolume": 15, "smvVol": 0.34},
        ],
    }
    spots = {"SPY": 546.95, "NVDA": 130.72, "MELI": 1584.04}
    for sym, s_rows in strike_rows_by_sym.items():
        summ = compute_gex_opex_summary_from_strikes(
            sym, "2024-06-20", s_rows, massive_spot=spots[sym],
            sampling_mode="PRE_OPEX", is_quad_witching=True, monthly_opex_date="2024-06-21",
        )
        pl.DataFrame([summ]).write_parquet(d_root / "orats_gex_opex" / f"{sym}.parquet")

    wham_spy_row = {"ticker": "SPY", "tradeDate": "2024-06-12", "spot": 540.49, "nextSession": {"date": "2024-06-13", "impliedMovePct": 0.0071}}
    pl.DataFrame([
        {"ticker": "SPY", "trade_date": "2024-06-12", "wham_status": "OK_DATA", "payload_json": json.dumps(wham_spy_row, sort_keys=True)}
    ]).write_parquet(d_root / "orats_wham" / "SPY.parquet")

    secret_tok = "SYN_ORATS_SECRET_XYZ"

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/hist/strikes") and "redirected" not in request.url.params:
            return httpx.Response(302, headers={"Location": f"https://api.orats.io/datav2/hist/strikes?ticker=SPY,NVDA,MELI&tradeDate=2024-06-20&redirected=1&token={secret_tok}"})
        if request.url.path.endswith("/hist/strikes"):
            all_rows = strike_rows_by_sym["SPY"] + strike_rows_by_sym["NVDA"] + strike_rows_by_sym["MELI"]
            return httpx.Response(200, json={"data": all_rows})
        if request.url.path.endswith("/hist/wham"):
            return httpx.Response(200, json={
                "data": [
                    wham_spy_row,
                    {"ticker": "QQQ", "tradeDate": "2024-06-12", "spot": 470.0},
                    {"ticker": "IWM", "tradeDate": "2024-06-12", "spot": 205.0},
                ]
            })
        return httpx.Response(404)

    out = run_orats_batch_micro_probe(
        root=tmp_path,
        transport=httpx.MockTransport(handler),
        orats_token_override=secret_tok,
    )
    assert out["requests_count"] == 2
    assert out["hist_strikes"]["redirect_302_detected"] is True
    assert out["hist_strikes"]["verdict"] == "SUPPORTED"
    assert out["hist_wham"]["verdict"] == "SUPPORTED"
    assert out["hist_wham"]["spy_exact_1_to_1_match_with_parquet"] is True
    raw_written = (tmp_path / "reports" / "probe_orats_batch_results.json").read_text(encoding="utf-8")
    assert secret_tok not in raw_written


# ---------------------------------------------------------------------------
# Prompt #6: Sealed APPROVED_SPEC, Eje 4.2 FSM, WHAM quoteDate dedup, Eje 5 Gate & Stratum
# ---------------------------------------------------------------------------


def test_prompt6_iass_d_subweights_sum_and_sealed_prior() -> None:
    from avwap_oracle.scoring.iass import FAMILY_PRIOR_REGISTRY, IassConfig
    from avwap_oracle.scoring.lifecycle import FLAT_SLOPE_H_BY_TIMEFRAME

    cfg = IassConfig()
    assert cfg.config_version == "iass_v2_sealed_2026_11_25"
    assert math.isclose(sum(cfg.d_subweights.values()), 1.0, abs_tol=1e-12)
    assert cfg.d_subweights == {"D_move": 0.45, "D_shock": 0.25, "D_iv": 0.20, "D_term": 0.10}

    with pytest.raises((ValidationError, ValueError)):
        IassConfig(d_subweights={"D_move": 0.50, "D_shock": 0.20, "D_iv": 0.10, "D_term": 0.05})

    assert FAMILY_PRIOR_REGISTRY["OPTIONS_FLOW_SHOCK"][0] == 0.35
    assert FAMILY_PRIOR_REGISTRY["OPTIONS_FLOW_SHOCK"][1] == "APPROVED_SPEC"
    assert all(v[1].startswith("APPROVED_") and "PROPOSED" not in v[1] for v in FAMILY_PRIOR_REGISTRY.values())
    assert all(v[1] == "APPROVED_SPEC" for v in FLAT_SLOPE_H_BY_TIMEFRAME.values())


def test_prompt6_fsm_pinch_breakout_resurrection_and_archival() -> None:
    from avwap_oracle.scoring.lifecycle import AnchorSeriesInput, LifecycleConfig, run_lifecycle_fsm

    cfg = LifecycleConfig()
    assert cfg.config_version == "lifecycle_v2_sealed_2026_11_25"
    assert cfg.pinch_breakout_atr == 0.35
    assert cfg.resurrection_excursion_atr == 1.0
    assert cfg.archival_dwell_sessions_1d == 5
    assert cfg.archival_far_dist_atr == 6.0

    # Part A: PINCH_PAIR -> PINCH_BREAKOUT (> 0.35 ATR) & DECAYING -> ARCHIVED (5 sessions 1D) & resurrection (1.0 ATR, chop < 2, dwell=2)
    dates = _trading_dates("2024-01-02", 25)
    ts = [int(get_session_bounds(d).rth_open_utc_s) for d in dates]  # type: ignore[union-attr]
    n = len(dates)
    atr = [1.0] * n
    vols = [1_000_000.0] * n

    # Long & short converging bars 0..3 -> PINCH_PAIR at bar 3; bar 4 close=100.80 > 100.40 + 0.35 triggers PINCH_BREAKOUT
    closes_a = [100.2, 100.2, 100.2, 100.2, 100.80] + [100.80] * (n - 5)
    highs_a = [c + 0.3 for c in closes_a]
    lows_a = [c - 0.3 for c in closes_a]
    av_long = [100.0] * n
    av_short = [101.0, 100.8, 100.6, 100.4, 100.4] + [100.4] * (n - 5)

    res_pinch = run_lifecycle_fsm(
        timeframe="1D",
        bar_ts_utc_s=ts,
        highs=highs_a,
        lows=lows_a,
        closes=closes_a,
        volumes=vols,
        atr14=atr,
        anchors=[
            AnchorSeriesInput(
                anchor_id="a_long",
                family="GAP_SHOCK",
                polarity="LONG",
                anchor_idx=0,
                activated_idx=0,
                anchor_ts=ts[0],
                available_at_utc_s=ts[0],
                score_original=75.0,
                avwap_series=tuple(av_long),
            ),
            AnchorSeriesInput(
                anchor_id="a_short",
                family="GAP_SHOCK",
                polarity="SHORT",
                anchor_idx=0,
                activated_idx=0,
                anchor_ts=ts[0],
                available_at_utc_s=ts[0],
                score_original=60.0,
                avwap_series=tuple(av_short),
            ),
        ],
        config=cfg,
    )
    assert any(tr.anchor_id == "a_long" and tr.next_state == "ACTIVE_PRIMARY" and tr.transition_reason == "PINCH_BREAKOUT" for tr in res_pinch.transitions)
    assert any(tr.anchor_id == "a_short" and tr.next_state == "DECAYING" and tr.transition_reason == "PINCH_BREAKOUT_OPPOSITE" for tr in res_pinch.transitions)
    # a_short entered DECAYING at bar 4 and closes stay within <= 0.4 ATR of 100.4 -> archives after 5 distinct 1D sessions
    assert res_pinch.final_snapshots["a_short"].state == "ARCHIVED"

    # Part B: Non-cohort DECAYING resurrection (1.0 ATR, chop < 2, |s_norm| >= 0.08, dwell=2)
    # Use small chop_neutral_band / keep closes flat near 100.0 for bars 0..14 so FLAT_SLOPE decays at bar 14,
    # then breakout on bars 15..16 (close = 101.5, avwap steps +0.5/bar so |s_norm| >= 0.08, chop = 0 < 2)
    closes_b = [100.1] * 15 + [101.5, 102.0, 102.5] + [102.5] * (n - 18)
    highs_b = [c + 0.1 for c in closes_b]
    lows_b = [c - 0.1 for c in closes_b]
    av_res = [100.0] * 15 + [100.25, 100.6, 101.0, 101.2] + [101.2] * (n - 19)
    res_resurrect = run_lifecycle_fsm(
        timeframe="1D",
        bar_ts_utc_s=ts,
        highs=highs_b,
        lows=lows_b,
        closes=closes_b,
        volumes=vols,
        atr14=atr,
        anchors=[
            AnchorSeriesInput(
                anchor_id="a_res",
                family="GAP_SHOCK",
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
    assert any(tr.transition_reason == "BREAKOUT_RESURRECTION" and tr.next_state == "ACTIVE_SECONDARY" for tr in res_resurrect.transitions)

    # Part C: Immediate far-distance + low cohort survival archival (dist > 6.0 ATR & S_cohort < 0.30)
    closes_c = [100.0] * 2 + [107.0] * (n - 2)
    highs_c = [c + 0.2 for c in closes_c]
    lows_c = [c - 0.2 for c in closes_c]
    vols_c = [850.0] * n
    res_far = run_lifecycle_fsm(
        timeframe="1D",
        bar_ts_utc_s=ts,
        highs=highs_c,
        lows=lows_c,
        closes=closes_c,
        volumes=vols_c,
        atr14=atr,
        anchors=[
            AnchorSeriesInput(
                anchor_id="a_far",
                family="GAP_SHOCK",
                polarity="LONG",
                anchor_idx=0,
                activated_idx=0,
                anchor_ts=ts[0],
                available_at_utc_s=ts[0],
                score_original=72.0,
                avwap_series=tuple([100.0] * n),
                free_float_at_anchor=1000.0,
                float_is_pit=True,
            )
        ],
        config=cfg,
    )
    assert any(tr.transition_reason == "ARCHIVED_FAR_DIST_LOW_COHORT" and tr.next_state == "ARCHIVED" for tr in res_far.transitions)


def test_prompt6_wham_batch_latest_quotedate_dedup() -> None:
    creds = _synth_creds()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/hist/wham"):
            return httpx.Response(
                200,
                json={
                    "data": [
                        {"ticker": "SPY", "tradeDate": "2024-06-12", "quoteDate": "2024-06-12T13:30:00Z", "spot": 539.0},
                        {"ticker": "SPY", "tradeDate": "2024-06-12", "quoteDate": "2024-06-12T20:00:00Z", "spot": 542.5},
                        {"ticker": "SPY", "tradeDate": "2024-06-12", "quoteDate": "2024-06-12T16:00:00Z", "spot": 540.0},
                    ]
                },
            )
        return httpx.Response(404)

    async def _run() -> Any:
        async with AsyncProviderTransport(
            creds,
            transport=httpx.MockTransport(handler),
            min_interval_by_domain={"ORATS_HISTORICAL": 0.0, "ORATS_LIVE": 0.0},
        ) as transport:
            client = OratsRestClient(transport)
            return await client.fetch_hist_wham_macro_batch(
                ["SPY"],
                ["2024-06-12"],
                asset_classes={"SPY": "US_ETF"},
            )

    res = asyncio.run(_run())
    df = res.by_ticker_data["SPY"]
    assert df.height == 1
    payload = json.loads(df["payload_json"][0])
    assert payload["quoteDate"] == "2024-06-12T20:00:00Z"
    assert payload["spot"] == 542.5


def test_prompt6_production_gate_stratum_and_survivorship(tmp_path: Path) -> None:
    from avwap_oracle.run_oracle import classify_production_gate, run_oracle_study

    # All 5 Eje 5 Production Gate verdicts
    v_t1 = classify_production_gate(
        family="BREAKAWAY_GAP", anchors_count=50, matured_touches_h5=40,
        observed_mean_aer_h5=0.35, null_mean_aer_h5=0.10, mean_aer_h5=0.30,
        p_raw_h5=0.002, q_bh_fdr_h5=0.01, p_romano_wolf=0.02, dsr=0.97,
        mean_net_ret_20bps_h5=0.008, clustering_excess=0.04, reclaim_n=5, reclaim_aer_5d=0.1,
        wf_evaluated_folds=5, wf_positive_folds=4, wf_mean_oos_aer_h5=0.15,
    )
    assert v_t1["verdict"] == "PROMOTE_TIER_1"

    # Zero evaluated walk-forward folds must NOT promote to Tier 1
    v_no_wf = classify_production_gate(
        family="BREAKAWAY_GAP", anchors_count=50, matured_touches_h5=40,
        observed_mean_aer_h5=0.35, null_mean_aer_h5=0.10, mean_aer_h5=0.30,
        p_raw_h5=0.002, q_bh_fdr_h5=0.01, p_romano_wolf=0.02, dsr=0.97,
        mean_net_ret_20bps_h5=0.008, clustering_excess=0.04, reclaim_n=5, reclaim_aer_5d=0.1,
        wf_evaluated_folds=0, wf_positive_folds=0, wf_mean_oos_aer_h5=None,
    )
    assert v_no_wf["verdict"] != "PROMOTE_TIER_1"

    v_t2 = classify_production_gate(
        family="BREAKAWAY_GAP", anchors_count=50, matured_touches_h5=40,
        observed_mean_aer_h5=0.25, null_mean_aer_h5=0.10, mean_aer_h5=0.15,
        p_raw_h5=0.03, q_bh_fdr_h5=0.12, p_romano_wolf=0.18, dsr=0.70,
        mean_net_ret_20bps_h5=0.002, clustering_excess=0.02, reclaim_n=12, reclaim_aer_5d=0.2,
        wf_evaluated_folds=5, wf_positive_folds=2, wf_mean_oos_aer_h5=-0.02,
    )
    assert v_t2["verdict"] == "TIER_2_CONTEXT_ONLY"

    v_rej = classify_production_gate(
        family="BREAKAWAY_GAP", anchors_count=50, matured_touches_h5=40,
        observed_mean_aer_h5=0.05, null_mean_aer_h5=0.12, mean_aer_h5=-0.05,
        p_raw_h5=0.70, q_bh_fdr_h5=0.80, p_romano_wolf=0.85, dsr=0.10,
        mean_net_ret_20bps_h5=-0.003, clustering_excess=-0.01, reclaim_n=0, reclaim_aer_5d=None,
        wf_evaluated_folds=5, wf_positive_folds=1, wf_mean_oos_aer_h5=-0.05,
    )
    assert v_rej["verdict"] == "REJECT_NO_EDGE"

    v_insuff = classify_production_gate(
        family="BREAKAWAY_GAP", anchors_count=10, matured_touches_h5=12,
        observed_mean_aer_h5=0.40, null_mean_aer_h5=0.10, mean_aer_h5=0.30,
        p_raw_h5=0.01, q_bh_fdr_h5=0.02, p_romano_wolf=0.02, dsr=0.98,
        mean_net_ret_20bps_h5=0.01, clustering_excess=0.05, reclaim_n=0, reclaim_aer_5d=None,
        wf_evaluated_folds=2, wf_positive_folds=2, wf_mean_oos_aer_h5=0.10,
    )
    assert v_insuff["verdict"] == "INSUFFICIENT_SAMPLE"

    v_ctrl = classify_production_gate(
        family="SWING_NO_RVOL", anchors_count=50, matured_touches_h5=45,
        observed_mean_aer_h5=0.35, null_mean_aer_h5=0.10, mean_aer_h5=0.30,
        p_raw_h5=0.005, q_bh_fdr_h5=0.02, p_romano_wolf=0.04, dsr=0.96,
        mean_net_ret_20bps_h5=0.005, clustering_excess=0.02, reclaim_n=0, reclaim_aer_5d=None,
        wf_evaluated_folds=4, wf_positive_folds=3, wf_mean_oos_aer_h5=0.12,
    )
    assert v_ctrl["verdict"] == "NEGATIVE_CONTROL_CONTAMINATION_ALERT"

    # End-to-end 2-ticker offline oracle check: SPY (US_ETF) + TWTR (DELISTED)
    dates = _trading_dates("2022-01-03", 90)
    rng = np.random.default_rng(7)
    d_root = tmp_path / "data"
    (d_root / "canonical" / "rth_1D").mkdir(parents=True, exist_ok=True)
    for sym, drift in (("SPY", 0.001), ("TWTR", -0.001)):
        rets = drift + 0.01 * rng.standard_normal(len(dates))
        closes = 100.0 * np.cumprod(1.0 + rets)
        closes[30] *= 1.08  # synthetic gap shock
        b1d = _make_1d_bars(sym, dates, closes)
        b1d.write_parquet(d_root / "canonical" / "rth_1D" / f"{sym}.parquet")

    cfg_out = tmp_path / "reports" / "oracle_frozen_config.json"
    js_out = tmp_path / "reports" / "oracle_results.json"
    md_out = tmp_path / "reports" / "oracle_report.md"
    out = run_oracle_study(
        tickers=["SPY", "TWTR"],
        n_perm=20,
        seed=42,
        workers=1,
        data_dir=d_root,
        config_path=cfg_out,
        json_report_path=js_out,
        md_report_path=md_out,
    )
    assert out["oracle_config_version"] == "oracle_axis5_v2_sealed_2026_11_25"
    cfg_written = json.loads(cfg_out.read_text(encoding="utf-8"))
    assert cfg_written["iass_config_status"] == "APPROVED_SPEC"
    assert cfg_written["lifecycle_config_status"] == "APPROVED_SPEC"
    assert all(row["status"] == "APPROVED_SPEC" for row in cfg_written["lifecycle_mappings"]["fsm_effective_table"])
    assert "US_ETF" in out["stratum_breakdown"] and "DELISTED" in out["stratum_breakdown"]
    assert "delta_ex_delisted_minus_all" in out["survivorship_bias_analysis"]
    assert "POSITIVE_GAMMA" in out["regime_stratification"]["gex_regime_aliases"]
    assert "NEGATIVE_GAMMA" in out["regime_stratification"]["gex_regime_aliases"]
    assert "q_bh_fdr_h3" in out["family_results"]["BREAKAWAY_GAP"]
    assert md_out.is_file() and js_out.is_file()
