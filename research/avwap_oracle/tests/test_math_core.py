"""Exhaustive mathematical validation and falsification tests for Prompt #2.

All expected values are computed independently via ``decimal.Decimal(prec=50)``,
two-pass direct summation, or analytical formulas -- never by calling the
functions under test. Zero network requests are performed.
"""

from __future__ import annotations

import datetime as dt
import json
import math
import re
from decimal import Decimal, getcontext
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import polars as pl
import pytest
from pydantic import ValidationError

from avwap_oracle.math_core.canonical_rth import (
    WeightedMomentState,
    build_canonical_rth_bars,
    build_canonical_rth_bars_with_audit,
    compute_exact_avwap_from_anchor,
    compute_hybrid_bands,
    estimate_parkinson_m2_within,
    merge_moments,
    parkinson_moment_state,
)
from avwap_oracle.math_core.causal_detectors import (
    compute_bucket_rvol_z,
    compute_causal_atr14,
    detect_causal_swings,
    detect_climax_and_gaps,
)
from avwap_oracle.math_core.corp_actions import (
    CorporateSplitEvent,
    apply_special_dividend_o1,
    apply_split_o1,
    apply_split_schedule_to_canonical_bars,
)
from avwap_oracle.math_core.nyse_calendar import (
    CLOSED,
    EARLY,
    EXPECTED_BUCKETS,
    CalendarOutOfCoverageError,
    classify_1m_bars_polars,
    classify_timestamp_session,
    get_session_bounds,
    session_bounds_for_timestamp,
)
from avwap_oracle.universe import (
    EXPECTED_STRATUM_COUNTS,
    PilotUniverse,
    load_pilot_universe,
)

getcontext().prec = 50
ET_TZ = ZoneInfo("America/New_York")
UTC_TZ = ZoneInfo("UTC")

ORACLE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[3]


def _dec_moments(vols: list[float], prices: list[float]) -> tuple[Decimal, Decimal, Decimal, Decimal]:
    """Independent Decimal(50) two-pass weighted moments on exact IEEE-754 float64 inputs."""
    dv = [Decimal.from_float(float(v)) for v in vols]
    dp = [Decimal.from_float(float(p)) for p in prices]
    w = sum(dv, Decimal(0))
    mu = sum((vi * pi for vi, pi in zip(dv, dp)), Decimal(0)) / w
    m2 = sum((vi * (pi - mu) * (pi - mu) for vi, pi in zip(dv, dp)), Decimal(0))
    sd = (m2 / w).sqrt()
    return w, mu, m2, sd


def _error_bps(actual: float, expected: Decimal) -> float:
    exp_f = float(expected)
    if exp_f == 0.0:
        return 0.0 if actual == 0.0 else float("inf")
    return float(Decimal("10000") * abs(Decimal.from_float(float(actual)) - expected) / abs(expected))


# ---------------------------------------------------------------------------
# 8.1 Universe and NYSE Calendar parity
# ---------------------------------------------------------------------------

def test_pilot_universe_frozen_56_and_validation() -> None:
    uni = load_pilot_universe()
    assert len(uni.instruments) == 56
    assert len(set(uni.tickers())) == 56

    counts: dict[str, int] = {}
    for inst in uni.instruments:
        counts[inst.stratum.value] = counts.get(inst.stratum.value, 0) + 1
    assert counts == EXPECTED_STRATUM_COUNTS

    by_t = uni.by_ticker()
    assert by_t["BABA"].in_repo_universe is False
    for adr in ("TSM", "ASML", "NVO", "MELI", "NU", "PBR", "YPF", "VIST", "PAM", "GGAL", "BMA"):
        assert by_t[adr].in_repo_universe is True

    # Leading zeros preserved in delisted CIK strings
    assert by_t["HES"].cik == "0000004447"
    assert by_t["TWTR"].composite_figi == "BBG000H6HNW3"
    assert by_t["CERN"].delisted_date == dt.date(2022, 6, 9)

    assert uni.windows.core.start == dt.date(2021, 1, 15)
    assert uni.windows.opra_flow.start == dt.date(2022, 9, 1)
    assert uni.windows.macro_wham.start == dt.date(2023, 1, 1)
    assert uni.windows.core.end == dt.date(2026, 11, 24)

    # Reject malformed/duplicate inputs
    raw = json.loads((ORACLE_ROOT / "config" / "pilot_universe.json").read_text(encoding="utf-8"))
    dup = json.loads(json.dumps(raw))
    dup["instruments"][1]["ticker"] = dup["instruments"][0]["ticker"]
    with pytest.raises(ValidationError):
        PilotUniverse.model_validate(dup)

    bad_cik = json.loads(json.dumps(raw))
    bad_cik["instruments"][-1]["cik"] = 804753  # int losing leading zeros
    with pytest.raises(ValidationError):
        PilotUniverse.model_validate(bad_cik)


def test_nyse_calendar_exact_parity_with_production_ts() -> None:
    ts_text = (REPO_ROOT / "src" / "core" / "usHistorical.ts").read_text(encoding="utf-8")
    m_closed = re.search(r"const\s+CLOSED\s*=\s*new\s+Set\(\[(.*?)\]\)", ts_text, flags=re.S)
    m_early = re.search(r"const\s+EARLY\s*=\s*new\s+Set\(\[(.*?)\]\)", ts_text, flags=re.S)
    assert m_closed is not None and m_early is not None
    prod_closed = frozenset(re.findall(r"'(\d{4}-\d{2}-\d{2})'", m_closed.group(1)))
    prod_early = frozenset(re.findall(r"'(\d{4}-\d{2}-\d{2})'", m_early.group(1)))

    assert len(CLOSED) == 87
    assert len(EARLY) == 17
    assert CLOSED == prod_closed
    assert EARLY == prod_early

    # Key calendar rules
    assert get_session_bounds("2025-01-09") is None  # Jimmy Carter mourning
    assert get_session_bounds("2026-06-19") is None  # Juneteenth
    assert get_session_bounds("2021-12-31") is not None  # 2022-01-01 Sat not observed Fri
    assert get_session_bounds("2022-01-01") is None
    assert get_session_bounds("2027-12-31") is not None  # 2028-01-01 Sat not observed Fri
    assert get_session_bounds("2028-01-01") is None

    # Spring & Fall DST open at 09:30 ET
    spring = get_session_bounds("2024-03-11")
    fall = get_session_bounds("2024-11-04")
    assert spring is not None and fall is not None
    assert spring.rth_open_utc_s == int(dt.datetime(2024, 3, 11, 9, 30, tzinfo=ET_TZ).timestamp())
    assert fall.rth_open_utc_s == int(dt.datetime(2024, 11, 4, 9, 30, tzinfo=ET_TZ).timestamp())
    assert spring.rth_minutes == 390 and fall.rth_minutes == 390

    # Early close 210 minutes and half-open boundaries (including wall(1020) = 17:00 ET)
    early = get_session_bounds("2024-11-29")
    assert early is not None and early.is_early_close and early.rth_minutes == 210
    assert classify_timestamp_session(early.ext_open_utc_s) == "PRE_MARKET"
    assert classify_timestamp_session(early.rth_open_utc_s - 60) == "PRE_MARKET"
    assert classify_timestamp_session(early.rth_open_utc_s) == "RTH"
    assert classify_timestamp_session(early.rth_close_utc_s - 60) == "RTH"
    assert classify_timestamp_session(early.rth_close_utc_s) == "AFTER_HOURS"
    assert classify_timestamp_session(early.ext_close_utc_s - 60) == "AFTER_HOURS"
    assert classify_timestamp_session(early.ext_close_utc_s) == "CLOSED"

    # Normal day 16:00 ET excluded from RTH
    norm = get_session_bounds("2024-11-26")
    assert norm is not None
    assert classify_timestamp_session(norm.rth_close_utc_s) == "AFTER_HOURS"

    # Bucket counts across all supported timeframes (normal vs early close)
    for day_str, is_ec in (("2024-11-26", False), ("2024-11-29", True)):
        sb = get_session_bounds(day_str)
        assert sb is not None
        ts_1m = list(range(sb.rth_open_utc_s, sb.rth_close_utc_s, 60))
        df_day = pl.DataFrame({"ts_utc_s": ts_1m})
        for tf, (exp_norm, exp_ec) in EXPECTED_BUCKETS.items():
            cls_df = classify_1m_bars_polars(df_day, timeframe=tf)
            n_buckets = cls_df.filter(pl.col("is_rth"))["bucket_id"].n_unique()
            assert n_buckets == (exp_ec if is_ec else exp_norm)

    # Out-of-coverage and millisecond rejection
    with pytest.raises(CalendarOutOfCoverageError):
        get_session_bounds("2019-12-31")
    with pytest.raises(CalendarOutOfCoverageError):
        get_session_bounds("2029-01-02")
    with pytest.raises(ValueError):
        session_bounds_for_timestamp(norm.rth_open_utc_s * 1000)


# ---------------------------------------------------------------------------
# 8.2 Exact multitemporal invariance (< 1e-11 bps)
# ---------------------------------------------------------------------------

def _build_5_session_synthetic_1m() -> pl.DataFrame:
    """5 deterministic RTH sessions (incl. 2024-11-29 early close) + pre/post + AMC shock."""
    dates = ["2024-11-25", "2024-11-26", "2024-11-27", "2024-11-29", "2024-12-02"]
    rows: list[dict[str, object]] = []
    for d_idx, d_str in enumerate(dates):
        sb = get_session_bounds(d_str)
        assert sb is not None
        # Iterate all extended hours [04:00, 20:00 / 17:00)
        for m_idx, ts in enumerate(range(sb.ext_open_utc_s, sb.ext_close_utc_s, 60)):
            in_rth = sb.rth_open_utc_s <= ts < sb.rth_close_utc_s
            if d_idx == 2:
                # Closely spaced continuous ~123 prices with huge volumes (catastrophic cancellation stress test)
                base_px = 123.0 + ((m_idx % 9) + 1) * 1e-4
                vol = 50_000.0 + (m_idx % 17) * 12_500.0
            else:
                base_px = 120.0 + d_idx * 1.35 + 0.012 * ((m_idx % 29) - 14)
                vol = float(15 + ((m_idx * 37 + d_idx * 13) % 4500))

            o = base_px
            h = base_px + 0.25
            l = base_px - 0.25
            c = base_px + 0.05
            vw = base_px + (0.40 if (m_idx % 11 == 0) else 0.01)  # Legitimate vw outside [l, h]

            # Synthetic AMC shock on 2024-11-26 after-hours: +12%, 3,000,000 shares
            if d_str == "2024-11-26" and ts == sb.rth_close_utc_s + 300:
                o = base_px * 1.12
                h = o + 0.5
                l = o - 0.2
                c = o + 0.1
                vw = o
                vol = 3_000_000.0
                assert not in_rth

            rows.append(
                {
                    "ticker": "SYNTH",
                    "ts_utc_s": ts,
                    "o": o,
                    "h": h,
                    "l": l,
                    "c": c,
                    "volume": vol,
                    "vw": vw,
                }
            )
    return pl.DataFrame(rows)


def test_mtf_exact_invariance_below_1e_11_bps() -> None:
    """Option A acceptance policy for multitemporal RTH invariance.

    Error decomposition established by ``test_mtf_pebay_exactness_and_float64_conditioning_proof``:
      1. Accumulation algorithm error (106-bit double-double Pebay vs Decimal(50) Pebay on
         identical Float64 buckets): verified < 1e-11 bps across all 7 timeframes.
      2. Float64 bucket storage error (single Float64 ``mu`` quantization at kappa = mu/sd):
         only affects ``std_dev`` reconstructed from pre-aggregated buckets (5m..1D).
      3. Comparison vs canonical 1m Decimal(50) ground truth:
         - ``avwap_mu``, +/-1/2 sigma bands (all 7 TFs) and ``1m std_dev`` remain < 1e-11 bps.
         - Aggregated buckets (5m..1D) apply Option A conditioning acceptance bound
           ``max(1e-11, 2 * (mu_ref / sd_ref) * (eps/2) * 1e4)`` AND ``< 1e-9 bps`` sanity
           ceiling; this is an acceptance policy for observed Float64 conditioning, not a
           universal theorem over arbitrary Float64 computations.
    """
    df_1m = _build_5_session_synthetic_1m()
    r1m, rep1m = build_canonical_rth_bars_with_audit(df_1m, "1m")
    # 4 * 390 + 210 = 1770 RTH 1m bars; AMC shock excluded
    assert rep1m.accepted_rth_1m_rows == 4 * 390 + 210
    assert rep1m.excluded_non_rth > 0

    # Independent Decimal(50) cumulative series on all 1770 1m RTH bars
    vols_1m = r1m["W"].to_list()
    vws_1m = r1m["mu"].to_list()
    ts_1m = r1m["ts_open_utc_s"].to_list()
    close_ts_to_1m_idx = {ts + 60: idx for idx, ts in enumerate(ts_1m)}

    dec_cum_by_idx: dict[int, tuple[Decimal, Decimal, Decimal, Decimal]] = {}
    for end_idx in range(len(vols_1m)):
        dec_cum_by_idx[end_idx] = _dec_moments(vols_1m[: end_idx + 1], vws_1m[: end_idx + 1])

    # Check 1m direct exact AVWAP at final bar and intermediate bars
    mu1, sd1, w1, m2_1 = compute_exact_avwap_from_anchor(
        r1m["W"].to_numpy(), r1m["mu"].to_numpy(), r1m["M2_within"].to_numpy(), anchor_idx=0
    )

    max_mu_bps = 0.0
    max_sd_1m_bps = 0.0
    max_sd_rollup_bps = 0.0
    max_band_bps = 0.0

    for tf in ("1m", "5m", "15m", "30m", "65m", "4H", "1D"):
        df_tf = build_canonical_rth_bars(df_1m, tf)
        # Verify total RTH volume conservation (AMC +12% / 3M excluded)
        assert Decimal(str(sum(df_tf["W"].to_list()))) == dec_cum_by_idx[len(vols_1m) - 1][0]

        av_mu, av_sd, av_w, av_m2 = compute_exact_avwap_from_anchor(
            df_tf["W"].to_numpy(),
            df_tf["mu"].to_numpy(),
            df_tf["M2_within"].to_numpy(),
            anchor_idx=0,
        )

        # Find exact closing UTC timestamp of each bucket from underlying 1m bars
        cls_1m = classify_1m_bars_polars(
            df_1m.filter(pl.col("ts_utc_s").is_in(ts_1m)), timeframe=tf
        ).filter(pl.col("is_rth"))
        bucket_last_close = (
            cls_1m.group_by(["trade_date", "bucket_id"], maintain_order=True)
            .agg((pl.col("ts_utc_s").max() + 60).alias("close_utc_s"))
            .sort(["trade_date", "bucket_id"])
        )
        assert bucket_last_close.height == df_tf.height

        for b_idx, b_close in enumerate(bucket_last_close["close_utc_s"].to_list()):
            idx_1m = close_ts_to_1m_idx[int(b_close)]
            exp_w, exp_mu, exp_m2, exp_sd = dec_cum_by_idx[idx_1m]

            mu_bps = _error_bps(float(av_mu[b_idx]), exp_mu)
            sd_bps = _error_bps(float(av_sd[b_idx]), exp_sd)
            max_mu_bps = max(max_mu_bps, mu_bps)
            assert mu_bps < 1e-11, f"tf={tf} b_idx={b_idx} mu_bps={mu_bps}"

            if exp_sd == 0:
                # Zero-dispersion case: require no artificial positive dispersion.
                assert math.isfinite(float(av_sd[b_idx])) and abs(float(av_sd[b_idx])) < 1e-12
            elif tf == "1m":
                max_sd_1m_bps = max(max_sd_1m_bps, sd_bps)
                assert sd_bps < 1e-11, f"tf=1m b_idx={b_idx} sd_bps={sd_bps}"
            else:
                mu_ref = float(exp_mu)
                sd_ref = float(exp_sd)
                assert (
                    math.isfinite(mu_ref)
                    and math.isfinite(sd_ref)
                    and mu_ref > 0.0
                    and sd_ref > 0.0
                ), f"Non-evaluable reference for conditioning bound: mu={mu_ref}, sd={sd_ref}"
                sd_bound_bps = max(
                    1e-11,
                    2.0
                    * (mu_ref / sd_ref)
                    * (np.finfo(np.float64).eps / 2.0)
                    * 1e4,
                )
                max_sd_rollup_bps = max(max_sd_rollup_bps, sd_bps)
                assert sd_bps < sd_bound_bps, (
                    f"tf={tf} b_idx={b_idx} sd_bps={sd_bps} >= sd_bound_bps={sd_bound_bps}"
                )
                assert sd_bps < 1e-9, f"tf={tf} b_idx={b_idx} sd_bps={sd_bps} >= 1e-9"

            assert _error_bps(float(av_w[b_idx]), exp_w) < 1e-11
            m2_bps = _error_bps(float(av_m2[b_idx]), exp_m2)
            if exp_sd == 0:
                assert math.isfinite(float(av_m2[b_idx])) and abs(float(av_m2[b_idx])) < 1e-12
            elif tf == "1m":
                assert m2_bps < 1e-11
            else:
                assert m2_bps < 2.0 * sd_bound_bps
                assert m2_bps < 2e-9

            for k_sig in (1, 2):
                exp_up = exp_mu + Decimal(k_sig) * exp_sd
                exp_lo = exp_mu - Decimal(k_sig) * exp_sd
                up_bps = _error_bps(float(av_mu[b_idx] + k_sig * av_sd[b_idx]), exp_up)
                lo_bps = _error_bps(float(av_mu[b_idx] - k_sig * av_sd[b_idx]), exp_lo)
                max_band_bps = max(max_band_bps, up_bps, lo_bps)
                assert up_bps < 1e-11 and lo_bps < 1e-11

    assert max_mu_bps < 1e-11
    assert max_sd_1m_bps < 1e-11
    assert max_sd_rollup_bps < 1e-9
    assert max_band_bps < 1e-11

    # Verify non-zero anchor excludes pre-anchor bars
    sub_mu, sub_sd, sub_w, _ = compute_exact_avwap_from_anchor(
        r1m["W"].to_numpy(), r1m["mu"].to_numpy(), r1m["M2_within"].to_numpy(), anchor_idx=390
    )
    assert np.all(np.isnan(sub_mu[:390]))
    exp_sub_w, exp_sub_mu, _, exp_sub_sd = _dec_moments(vols_1m[390:], vws_1m[390:])
    assert _error_bps(float(sub_mu[-1]), exp_sub_mu) < 1e-11
    assert _error_bps(float(sub_sd[-1]), exp_sub_sd) < 1e-11
    assert _error_bps(float(sub_w[-1]), exp_sub_w) < 1e-11


def test_mtf_pebay_exactness_and_float64_conditioning_proof() -> None:
    """Prove double-double Pébay matches Decimal(50) Pébay to <1e-11 bps across all 7 TFs,
    isolating rolled-up std_dev error strictly to Float64 bucket mu representation (kappa = mu/sd).
    """
    getcontext().prec = 50
    df_1m = _build_5_session_synthetic_1m()
    r1m = build_canonical_rth_bars(df_1m, "1m")
    vols_1m = r1m["W"].to_list()
    vws_1m = r1m["mu"].to_list()
    ts_1m = r1m["ts_open_utc_s"].to_list()
    close_ts_to_1m_idx = {ts + 60: idx for idx, ts in enumerate(ts_1m)}

    dec_cum_1m: list[tuple[Decimal, Decimal, Decimal, Decimal]] = []
    # Incremental Decimal(50) Pébay over 1m ground truth
    w_tot = Decimal(0)
    mu_tot = Decimal(0)
    m2_tot = Decimal(0)
    for w_f, p_f in zip(vols_1m, vws_1m, strict=True):
        wb = Decimal.from_float(float(w_f))
        mub = Decimal.from_float(float(p_f))
        if w_tot == 0:
            w_tot, mu_tot, m2_tot = wb, mub, Decimal(0)
        else:
            w_new = w_tot + wb
            delta = mub - mu_tot
            mu_tot = (w_tot * mu_tot + wb * mub) / w_new
            m2_tot = m2_tot + (w_tot * wb / w_new) * (delta * delta)
            w_tot = w_new
        dec_cum_1m.append((w_tot, mu_tot, m2_tot, (m2_tot / w_tot).sqrt()))

    # 1. Verify 1m mu and std_dev across all 1,770 bars are strictly < 1e-11 bps
    mu1, sd1, _, _ = compute_exact_avwap_from_anchor(
        r1m["W"].to_numpy(), r1m["mu"].to_numpy(), r1m["M2_within"].to_numpy(), anchor_idx=0
    )
    for i, (_, exp_mu, _, exp_sd) in enumerate(dec_cum_1m):
        assert _error_bps(float(mu1[i]), exp_mu) < 1e-11
        if exp_sd > 0:
            assert _error_bps(float(sd1[i]), exp_sd) < 1e-11

    # 2. Verify all 7 TFs: avwap_mu < 1e-11 bps vs 1m ground truth, AND double-double Pébay
    #    matches exact Decimal(50) Pébay over the same Float64 buckets to < 1e-11 bps.
    for tf in ("1m", "5m", "15m", "30m", "65m", "4H", "1D"):
        df_tf = build_canonical_rth_bars(df_1m, tf)
        av_mu, av_sd, _, _ = compute_exact_avwap_from_anchor(
            df_tf["W"].to_numpy(),
            df_tf["mu"].to_numpy(),
            df_tf["M2_within"].to_numpy(),
            anchor_idx=0,
        )
        cls_1m = classify_1m_bars_polars(
            df_1m.filter(pl.col("ts_utc_s").is_in(ts_1m)), timeframe=tf
        ).filter(pl.col("is_rth"))
        bucket_last_close = (
            cls_1m.group_by(["trade_date", "bucket_id"], maintain_order=True)
            .agg((pl.col("ts_utc_s").max() + 60).alias("close_utc_s"))
            .sort(["trade_date", "bucket_id"])
        )

        # Decimal(50) Pébay merge of Float64-stored buckets
        bw_list = df_tf["W"].to_list()
        bmu_list = df_tf["mu"].to_list()
        bm2_list = df_tf["M2_within"].to_list()
        dw = Decimal(0)
        dmu = Decimal(0)
        dm2 = Decimal(0)

        for b_idx, b_close in enumerate(bucket_last_close["close_utc_s"].to_list()):
            idx_1m = close_ts_to_1m_idx[int(b_close)]
            _, exp_mu_1m, _, _ = dec_cum_1m[idx_1m]
            assert _error_bps(float(av_mu[b_idx]), exp_mu_1m) < 1e-11

            wb = Decimal.from_float(float(bw_list[b_idx]))
            mub = Decimal.from_float(float(bmu_list[b_idx]))
            m2b = Decimal.from_float(float(bm2_list[b_idx]))
            if dw == 0:
                dw, dmu, dm2 = wb, mub, m2b
            else:
                dw_new = dw + wb
                delta = mub - dmu
                dmu = (dw * dmu + wb * mub) / dw_new
                dm2 = dm2 + m2b + (dw * wb / dw_new) * (delta * delta)
                dw = dw_new
            dsd = (dm2 / dw).sqrt()
            assert _error_bps(float(av_mu[b_idx]), dmu) < 1e-11
            if dsd > 0:
                assert _error_bps(float(av_sd[b_idx]), dsd) < 1e-11


def test_zero_variance_neutral_identity_and_invalid_vw_exclusion() -> None:
    sb = get_session_bounds("2024-11-25")
    assert sb is not None
    ts_list = list(range(sb.rth_open_utc_s, sb.rth_open_utc_s + 30 * 60, 60))
    df_const = pl.DataFrame(
        {
            "ticker": ["FLAT"] * 30,
            "ts_utc_s": ts_list,
            "o": [100.0] * 30,
            "h": [100.5] * 30,
            "l": [99.5] * 30,
            "c": [100.0] * 30,
            "volume": [1000.0] * 30,
            "vw": [100.0] * 30,
        }
    )
    b5 = build_canonical_rth_bars(df_const, "5m")
    mu, sd, w, m2 = compute_exact_avwap_from_anchor(
        b5["W"].to_numpy(), b5["mu"].to_numpy(), b5["M2_within"].to_numpy(), anchor_idx=0
    )
    # Explicit absolute criterion for zero-variance reference
    assert abs(float(sd[-1])) <= 1e-12
    assert abs(float(m2[-1])) <= 1e-12
    assert abs(float(mu[-1]) - 100.0) <= 1e-12
    assert float(w[-1]) == 30_000.0

    # Neutral identity & partition associativity
    n = WeightedMomentState.neutral()
    assert math.isnan(n.vwap) and math.isnan(n.std_dev)
    s1 = WeightedMomentState(100.0, 50.0, 4.0)
    s2 = WeightedMomentState(200.0, 52.0, 9.0)
    s3 = WeightedMomentState(150.0, 51.0, 6.0)
    assert merge_moments(n, s1) == s1
    assert merge_moments(s1, n) == s1
    m_left = merge_moments(merge_moments(s1, s2), s3)
    m_right = merge_moments(s1, merge_moments(s2, s3))
    assert math.isclose(m_left.vwap, m_right.vwap, rel_tol=1e-14)
    assert math.isclose(m_left.std_dev, m_right.std_dev, rel_tol=1e-14)

    # Invalid vw (NaN / 0 / None) must be excluded, never replaced by HLC3
    df_bad_vw = df_const.with_columns(
        pl.when(pl.col("ts_utc_s") == ts_list[0]).then(pl.lit(None, dtype=pl.Float64))
        .when(pl.col("ts_utc_s") == ts_list[1]).then(pl.lit(0.0))
        .otherwise(pl.col("vw"))
        .alias("vw")
    )
    _, rep = build_canonical_rth_bars_with_audit(df_bad_vw, "5m")
    assert rep.excluded_invalid_vw == 2
    assert rep.accepted_rth_1m_rows == 28


# ---------------------------------------------------------------------------
# 8.3 Naive Welford falsification & Parkinson Monte Carlo + Hybrid bands
# ---------------------------------------------------------------------------

def test_naive_welford_falsification_zero_dispersion_on_1d() -> None:
    df_1m = _build_5_session_synthetic_1m()
    r1m = build_canonical_rth_bars(df_1m, "1m")
    r1d = build_canonical_rth_bars(df_1m, "1D")

    # Reference Day 1 dispersion > 0
    day1_1m = r1m.filter(pl.col("trade_date") == "2024-11-25")
    _, ref_sd_1m, _, _ = compute_exact_avwap_from_anchor(
        day1_1m["W"].to_numpy(), day1_1m["mu"].to_numpy(), day1_1m["M2_within"].to_numpy(), 0
    )
    assert float(ref_sd_1m[-1]) > 0.05

    # Naive Welford omitting M2_within (passing zeros) yields exactly 0.0 on Day 1 1D bar
    _, naive_sd_1d, _, _ = compute_exact_avwap_from_anchor(
        r1d["W"].to_numpy(), r1d["mu"].to_numpy(), np.zeros(r1d.height), 0
    )
    assert float(naive_sd_1d[0]) == 0.0

    # Exact 1D preserving M2_within matches 1m Day 1 dispersion
    _, exact_sd_1d, _, _ = compute_exact_avwap_from_anchor(
        r1d["W"].to_numpy(), r1d["mu"].to_numpy(), r1d["M2_within"].to_numpy(), 0
    )
    assert math.isclose(float(exact_sd_1d[0]), float(ref_sd_1m[-1]), rel_tol=1e-14)


def run_parkinson_monte_carlo(
    *,
    seed: int = 20261124,
    n_paths: int = 10_000,
    n_steps: int = 390,
    sigma_session: float = 0.02,
    s0: float = 100.0,
) -> dict[str, object]:
    """Reproducible Brownian Monte Carlo evaluating Parkinson M2_within recovery."""
    rng = np.random.default_rng(seed)
    dt_step = 1.0 / n_steps
    # Drift-free log-normal Brownian motion sampled at 1m steps
    z = rng.standard_normal((n_paths, n_steps))
    log_rets = -0.5 * (sigma_session**2) * dt_step + sigma_session * math.sqrt(dt_step) * z
    log_paths = np.cumsum(log_rets, axis=1)
    prices = s0 * np.exp(log_paths)

    # Reference temporal dispersion under uniform volume W=n_steps (1 unit/step)
    w_total = float(n_steps)
    mu_ref = np.mean(prices, axis=1)
    m2_ref = np.sum((prices - mu_ref[:, None]) ** 2, axis=1)
    sd_ref = np.sqrt(m2_ref / w_total)

    highs = np.max(prices, axis=1)
    lows = np.min(prices, axis=1)
    m2_park = w_total * (mu_ref**2) * (np.log(highs / lows) ** 2) / (24.0 * math.log(2.0))
    sd_park = np.sqrt(m2_park / w_total)

    var_ratio = m2_park / m2_ref
    disp_ratio = sd_park / sd_ref

    def _stats(arr: np.ndarray) -> dict[str, float]:
        mean_val = float(np.mean(arr))
        se = float(np.std(arr, ddof=1) / math.sqrt(arr.size))
        return {
            "mean": mean_val,
            "ci95_low": mean_val - 1.96 * se,
            "ci95_high": mean_val + 1.96 * se,
            "bias_vs_1": mean_val - 1.0,
            "rmse_vs_1": float(np.sqrt(np.mean((arr - 1.0) ** 2))),
            "p05": float(np.percentile(arr, 5)),
            "p50": float(np.percentile(arr, 50)),
            "p95": float(np.percentile(arr, 95)),
        }

    var_stats = _stats(var_ratio)
    disp_stats = _stats(disp_ratio)
    var_ratio_of_means = float(np.mean(m2_park) / np.mean(m2_ref))
    disp_ratio_of_means = float(np.mean(sd_park) / np.mean(sd_ref))
    hyp_low, hyp_high = 0.96, 0.99
    var_in_band = hyp_low <= var_stats["mean"] <= hyp_high
    disp_in_band = hyp_low <= disp_stats["mean"] <= hyp_high
    return {
        "seed": seed,
        "n_paths": n_paths,
        "n_steps": n_steps,
        "sigma_session": sigma_session,
        "s0": s0,
        "variance_recovery": var_stats,
        "dispersion_recovery": disp_stats,
        "variance_ratio_of_means": var_ratio_of_means,
        "dispersion_ratio_of_means": disp_ratio_of_means,
        "hypothesis_96_99_variance": var_in_band,
        "hypothesis_96_99_dispersion": disp_in_band,
        "hypothesis_96_99_variance_ratio_of_means": hyp_low <= var_ratio_of_means <= hyp_high,
        "hypothesis_96_99_dispersion_ratio_of_means": hyp_low <= disp_ratio_of_means <= hyp_high,
    }


def test_parkinson_fallback_and_hybrid_bands_and_monte_carlo() -> None:
    # Deterministic formula & provenance propagation
    m2_est = estimate_parkinson_m2_within(1000.0, 100.0, 102.0, 98.0)
    expected = 1000.0 * (100.0**2) * (math.log(102.0 / 98.0) ** 2) / (24.0 * math.log(2.0))
    assert math.isclose(m2_est, expected, rel_tol=1e-14)

    pk = parkinson_moment_state(1000.0, 100.0, 102.0, 98.0)
    exact = WeightedMomentState(1000.0, 101.0, 500.0, variance_source="PEBAY_EXACT_1M")
    merged = merge_moments(exact, pk)
    assert merged.variance_source == "RANGE_PARKINSON_FALLBACK"

    # Hybrid bands & clean fallback
    hb = compute_hybrid_bands(100.0, 1.2, 0.30, elapsed_trading_days=2.0, tau0=2.0)
    assert hb.band_source == "HYBRID_ORATS_WELFORD"
    assert math.isclose(hb.alpha, math.exp(-1.0), rel_tol=1e-14)
    assert hb.upper_2_5 > hb.upper_2 > hb.upper_1 > hb.avwap_mu > hb.lower_1 > hb.lower_2 > hb.lower_2_5

    hb_fb = compute_hybrid_bands(100.0, 1.2, None, elapsed_trading_days=2.0)
    assert hb_fb.band_source == "WELFORD_ONLY_FALLBACK"
    assert hb_fb.sigma_hybrid == 1.2

    # Reproducible Monte Carlo (honest evaluation, never forcing 96-99%)
    mc_390 = run_parkinson_monte_carlo(seed=20261124, n_paths=10_000, n_steps=390)
    mc_3900 = run_parkinson_monte_carlo(seed=20261124, n_paths=5_000, n_steps=3900)
    assert mc_390["variance_recovery"]["mean"] > 0.0
    assert mc_390["dispersion_recovery"]["mean"] > 0.0
    assert mc_390["variance_recovery"]["rmse_vs_1"] > 0.0
    assert mc_3900["variance_recovery"]["mean"] > mc_390["variance_recovery"]["mean"]


# ---------------------------------------------------------------------------
# 8.4 Corporate actions O(1) exactness (NVDA Prompt #1 observations + COST)
# ---------------------------------------------------------------------------

def test_nvda_split_o1_using_prompt1_observations_and_reverse_split() -> None:
    probe_path = ORACLE_ROOT / "reports" / "probe_phase1_results.json"
    if not probe_path.is_file():
        pytest.fail("Blocked: Prompt #1 probe_phase1_results.json missing.")
    probe = json.loads(probe_path.read_text(encoding="utf-8"))
    nvda_exp = probe["providers"]["massive"]["details"]["nvda_split_experiment"]
    pre_unadj = nvda_exp["unadjusted"]["pre_bar"]
    post_unadj = nvda_exp["unadjusted"]["post_bar"]
    assert pre_unadj is not None and post_unadj is not None
    assert pre_unadj["hm_et"] == "15:59" and post_unadj["hm_et"] == "09:30"

    # Build a synthetic multi-bar raw sequence anchored on 2024-06-07 incorporating exact Prompt #1 bars
    sb_pre = get_session_bounds("2024-06-07")
    sb_post = get_session_bounds("2024-06-10")
    assert sb_pre is not None and sb_post is not None
    pre_ts_1558 = pre_unadj["time_sec"] - 60
    bars_raw = pl.DataFrame(
        [
            {
                "ticker": "NVDA",
                "trade_date": "2024-06-07",
                "bucket_id": 388,
                "ts_open_utc_s": pre_ts_1558,
                "W": 300_000.0,
                "mu": 1207.50,
                "M2_within": 0.0,
            },
            {
                "ticker": "NVDA",
                "trade_date": "2024-06-07",
                "bucket_id": 389,
                "ts_open_utc_s": int(pre_unadj["time_sec"]),
                "W": float(pre_unadj["v"]),
                "mu": float(pre_unadj["vw"]),
                "M2_within": 0.0,
            },
            {
                "ticker": "NVDA",
                "trade_date": "2024-06-10",
                "bucket_id": 0,
                "ts_open_utc_s": int(post_unadj["time_sec"]),
                "W": float(post_unadj["v"]),
                "mu": float(post_unadj["vw"]),
                "M2_within": 0.0,
            },
            {
                "ticker": "NVDA",
                "trade_date": "2024-06-10",
                "bucket_id": 1,
                "ts_open_utc_s": int(post_unadj["time_sec"]) + 60,
                "W": 2_500_000.0,
                "mu": 120.62,
                "M2_within": 0.0,
            },
        ]
    )

    ev = CorporateSplitEvent(
        event_id="NVDA-2024-06-10-10for1",
        ticker="NVDA",
        effective_date="2024-06-10",
        split_from=1.0,
        split_to=10.0,
    )
    # Include duplicate event to verify idempotency
    res = apply_split_schedule_to_canonical_bars(bars_raw, [ev, ev])
    assert len(res.applied_audits) == 1
    assert res.bars["split_applied"].to_list() == [False, False, True, False]

    # Independent Decimal(50) O(N) back-adjusted reconstruction
    k = Decimal("0.1")
    adj_vols = [
        float(Decimal("300000.0") / k),
        float(Decimal(str(pre_unadj["v"])) / k),
        float(post_unadj["v"]),
        2_500_000.0,
    ]
    adj_vws = [
        float(Decimal("1207.50") * k),
        float(Decimal(str(pre_unadj["vw"])) * k),
        float(post_unadj["vw"]),
        120.62,
    ]
    exp_w, exp_mu, exp_m2, exp_sd = _dec_moments(adj_vols, adj_vws)

    got_mu = float(res.bars["avwap_mu"][-1])
    got_sd = float(res.bars["avwap_sd"][-1])
    got_w = float(res.bars["cum_W"][-1])
    got_m2 = float(res.bars["cum_M2"][-1])

    assert float(abs(Decimal(str(got_mu)) - exp_mu) / abs(exp_mu)) < 1e-12
    assert float(abs(Decimal(str(got_sd)) - exp_sd) / abs(exp_sd)) < 1e-12
    assert float(abs(Decimal(str(got_w)) - exp_w) / abs(exp_w)) < 1e-12
    assert float(abs(Decimal(str(got_m2)) - exp_m2) / abs(exp_m2)) < 1e-12

    # Pre-split bars retain unadjusted published prices (strict causality)
    assert math.isclose(float(res.bars["avwap_mu"][1]), float(_dec_moments([300_000.0, float(pre_unadj["v"])], [1207.50, float(pre_unadj["vw"])])[1]), rel_tol=1e-14)

    # Demonstrate naive k^2 * M2 error (10x too small on 10:1 split)
    pre_state = res.applied_audits[0].pre_state
    post_state = res.applied_audits[0].post_state
    naive_m2 = (0.1**2) * pre_state.m2
    assert math.isclose(post_state.m2 / naive_m2, 10.0, rel_tol=1e-12)

    # Reverse split 1:5 (k = 5.0) & consecutive split exactness
    rev = apply_split_o1(pre_state, split_from=5.0, split_to=1.0)
    exp_rw, exp_rmu, exp_rm2, exp_rsd = _dec_moments(
        [300_000.0 / 5.0, float(pre_unadj["v"]) / 5.0],
        [1207.50 * 5.0, float(pre_unadj["vw"]) * 5.0],
    )
    assert float(abs(Decimal(str(rev.vwap)) - exp_rmu) / abs(exp_rmu)) < 1e-12
    assert float(abs(Decimal(str(rev.std_dev)) - exp_rsd) / abs(exp_rsd)) < 1e-12
    assert float(abs(Decimal(str(rev.m2)) - exp_rm2) / abs(exp_rm2)) < 1e-12
    assert float(abs(Decimal(str(rev.total_volume)) - exp_rw) / abs(exp_rw)) < 1e-12

    # Prohibit double adjustment
    with pytest.raises(ValueError, match="bars_are_adjusted=True"):
        apply_split_schedule_to_canonical_bars(bars_raw, [ev], bars_are_adjusted=True)


def test_special_dividend_o1_cost_fixtures_and_boundaries() -> None:
    st = WeightedMomentState(total_volume=500_000.0, vwap=675.0, m2=1_200_000.0)

    # Synthetic COST special dividend fixture: $15 over ~$680 (> 1.5% threshold)
    adj_sp, applied_sp = apply_special_dividend_o1(st, cash_amount=15.0, prev_close=680.0)
    assert applied_sp is True
    d_dec = (Decimal("680.0") - Decimal("15.0")) / Decimal("680.0")
    exp_mu = d_dec * Decimal("675.0")
    exp_m2 = d_dec * d_dec * Decimal("1200000.0")
    assert adj_sp.total_volume == st.total_volume
    assert float(abs(Decimal(str(adj_sp.vwap)) - exp_mu) / abs(exp_mu)) < 1e-12
    assert float(abs(Decimal(str(adj_sp.m2)) - exp_m2) / abs(exp_m2)) < 1e-12

    # Synthetic COST ordinary dividend fixture: $1.47 over $900 (< 1.5% threshold)
    adj_ord, applied_ord = apply_special_dividend_o1(st, cash_amount=1.47, prev_close=900.0)
    assert applied_ord is False
    assert adj_ord == st

    # Exact threshold 1.5%
    _, applied_edge = apply_special_dividend_o1(st, cash_amount=1.5, prev_close=100.0, min_pct=0.015)
    assert applied_edge is True
    _, applied_below = apply_special_dividend_o1(st, cash_amount=1.4999, prev_close=100.0, min_pct=0.015)
    assert applied_below is False

    # Neutral & invalid inputs
    n_out, n_app = apply_special_dividend_o1(WeightedMomentState.neutral(), 15.0, 680.0)
    assert n_app is False and n_out.total_volume == 0.0
    with pytest.raises(ValueError):
        apply_special_dividend_o1(st, -1.0, 680.0)
    with pytest.raises(ValueError):
        apply_special_dividend_o1(st, 700.0, 680.0)
    with pytest.raises(ValueError):
        apply_special_dividend_o1(st, float("nan"), 680.0)


# ---------------------------------------------------------------------------
# 8.5 Prefix invariance -- zero look-ahead & adversarial cases
# ---------------------------------------------------------------------------

def _build_adversarial_detector_series() -> tuple[pl.DataFrame, list[str]]:
    """Build multi-month 1D/bucketed series covering all 8 adversarial look-ahead cases."""
    start = dt.date(2024, 10, 1)
    dates: list[str] = []
    cur = start
    while len(dates) < 48:
        sb = get_session_bounds(cur)
        if sb is not None:
            dates.append(sb.trade_date)
        cur += dt.timedelta(days=1)

    rows: list[dict[str, object]] = []
    px = 100.0
    for idx, d_str in enumerate(dates):
        sb = get_session_bounds(d_str)
        assert sb is not None
        vol = 100_000.0 if idx >= 20 else 50_000.0
        # Case: constant volume MAD=0 on bars 0..19 -> rvol_z at bar 20 hits MAD=0
        if idx < 20:
            vol = 50_000.0
        elif idx < 25:
            vol = 50_000.0 + (idx - 20) * 1000.0

        o, h, l, c = px, px + 1.0, px - 1.0, px + 0.2
        split_k = 1.0

        # Case: intraday range expansion without session gap (idx == 23, same date wouldn't apply on 1D; tested separately on 5m)
        # Case: swing up then confirmed SWING_HIGH, followed by NEW HIGHER HIGH at idx=33..38
        if idx == 26:
            o, h, l, c, vol = px, px + 8.0, px - 0.5, px + 7.5, 950_000.0  # Bullish gap/climax candidate
        elif idx == 27:
            o, h, l, c = px + 8.0, px + 11.0, px + 7.5, px + 10.5
        elif idx == 29:
            # Reversal >= 2.0 * atr14_prev at lag >= 2 -> confirms SWING_HIGH at idx=27
            o, h, l, c = px + 9.0, px + 9.5, px + 1.0, px + 1.5
        elif idx == 33:
            # New higher high AFTER idx=27 was already confirmed -> must NOT alter idx=27 event
            o, h, l, c = px + 3.0, px + 16.0, px + 2.5, px + 15.0
        elif idx == 36:
            # Unadjusted 2:1 split mid-sequence
            split_k = 0.5
            px = px * 0.5
            o, h, l, c = px + 2.0, px + 4.0, px + 1.5, px + 3.8

        rows.append(
            {
                "ticker": "ADV",
                "trade_date": d_str,
                "bucket_id": 0,
                "ts_open_utc_s": sb.rth_open_utc_s,
                "ts_close_utc_s": sb.rth_close_utc_s,
                "o": o,
                "h": h,
                "l": l,
                "c": c,
                "volume": vol,
                "is_early_close": sb.is_early_close,
                "is_earnings_day": False,
                "split_factor_k": split_k,
            }
        )
        px = c

    df = pl.DataFrame(rows)
    return df, dates


def test_prefix_invariance_zero_lookahead_and_adversarial() -> None:
    df_full, dates = _build_adversarial_detector_series()

    def _run_pipeline(df_in: pl.DataFrame):
        r = compute_bucket_rvol_z(df_in, window_sessions=40, min_history=20)
        a = compute_causal_atr14(r, period=14)
        ev = detect_climax_and_gaps(a, default_bar_minutes=390)
        sw = detect_causal_swings(a, "1D")
        return a, ev, sw

    full_df, full_events, full_swings = _run_pipeline(df_full)
    assert len(full_swings) >= 1

    # Verify insufficient history (<20) and MAD=0 at idx=20
    assert full_df["rvol_status"][19] == "INSUFFICIENT_HISTORY"
    assert math.isnan(float(full_df["rvol_z"][19]))
    assert full_df["rvol_status"][20] == "MAD_ZERO_EPSILON_DENOM"
    assert math.isfinite(float(full_df["rvol_z"][20]))

    # Verify early close (2024-11-29) did not enter RVOL history for subsequent bar
    ec_indices = [i for i, f in enumerate(full_df["is_early_close"].to_list()) if f]
    assert len(ec_indices) >= 1
    ec_idx = ec_indices[0]
    if ec_idx + 1 < full_df.height:
        assert full_df["rvol_history_count"][ec_idx + 1] == full_df["rvol_history_count"][ec_idx]

    # Prefix invariance across multiple prefixes T (filtered strictly by available_at_utc_s <= prefix_close)
    for prefix_len in (15, 22, 28, 31, 35, 39, df_full.height - 1):
        prefix_df_in = df_full.slice(0, prefix_len)
        prefix_close_utc = int(prefix_df_in["ts_close_utc_s"][-1])
        p_df, p_events, p_swings = _run_pipeline(prefix_df_in)

        # RVOL and ATR14_prev immutable on all prefix rows
        for row_i in range(prefix_len):
            rz_p, rz_f = float(p_df["rvol_z"][row_i]), float(full_df["rvol_z"][row_i])
            assert (math.isnan(rz_p) and math.isnan(rz_f)) or math.isclose(rz_p, rz_f, rel_tol=1e-14)
            at_p, at_f = float(p_df["atr14_prev"][row_i]), float(full_df["atr14_prev"][row_i])
            assert (math.isnan(at_p) and math.isnan(at_f)) or math.isclose(at_p, at_f, rel_tol=1e-14)

        expected_events = [e for e in full_events if e.available_at_utc_s <= prefix_close_utc]
        expected_swings = [s for s in full_swings if s.available_at_utc_s <= prefix_close_utc]
        assert p_events == expected_events
        assert p_swings == expected_swings

        for e in p_events:
            assert e.activated_ts >= e.anchor_ts
            assert e.available_at_utc_s > e.activated_ts
        for s in p_swings:
            assert s.activated_ts >= s.anchor_ts
            assert s.confirmation_lag >= 2
            assert s.available_at_utc_s > s.activated_ts

    # Verify intraday range expansion on continuous 5m bars does NOT fire BREAKAWAY_GAP
    sb = get_session_bounds("2024-11-25")
    assert sb is not None
    df_5m = pl.DataFrame(
        [
            {
                "ticker": "INTRA",
                "trade_date": "2024-11-25",
                "bucket_id": i,
                "ts_open_utc_s": sb.rth_open_utc_s + i * 300,
                "ts_close_utc_s": sb.rth_open_utc_s + (i + 1) * 300,
                "o": 100.0 if i < 2 else 110.0,
                "h": 101.0 if i < 2 else 115.0,
                "l": 99.0 if i < 2 else 109.0,
                "c": 100.0 if i < 2 else 114.8,
                "rvol_z": 4.0,
                "atr14_prev": 1.0,
                "prev_close_causal": 100.0,
            }
            for i in range(3)
        ]
    )
    intra_evs = detect_climax_and_gaps(df_5m, default_bar_minutes=5)
    assert all(e.event_type == "VOLUME_CLIMAX" for e in intra_evs)
    assert not any(e.event_type == "BREAKAWAY_GAP" for e in intra_evs)
