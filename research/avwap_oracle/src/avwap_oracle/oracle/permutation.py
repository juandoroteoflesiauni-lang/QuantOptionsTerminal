"""Statistical falsification & multiple-hypothesis control engine (Axis 5).

Implements:
- Matched Random-Anchor Permutation Test (plus-one empirical p-value)
- Benjamini-Hochberg FDR step-up (``q_bh_fdr``)
- Politis-Romano Stationary Block Bootstrap synchronized by calendar date
- Romano-Wolf stepdown FWER control on studentized null-centered statistics
- Bailey & Lopez de Prado Deflated Sharpe Ratio (DSR) on coherent daily book returns
"""

from __future__ import annotations

import concurrent.futures
import math
from dataclasses import dataclass, field
from typing import Any, Literal, Mapping, Sequence

import numpy as np
import polars as pl
from scipy import stats
from scipy.special import ndtr

from avwap_oracle.math_core.corp_actions import CorporateSplitEvent
from avwap_oracle.oracle.candidates import CandidateAnchor
from avwap_oracle.oracle.touches import AnchorTouchSummary


@dataclass(frozen=True)
class MatchedPoolSpec:
    ticker: str
    year: str
    vol_quartile: int
    polarity: Literal["LONG", "SHORT"]
    confirmation_lag: int
    age_span_bars: int


@dataclass(frozen=True)
class PermutationFamilyResult:
    family: str
    anchors_total: int
    anchors_with_mature_touches: int
    anchors_matched: int
    anchors_insufficient_matches: int
    pool_size_median: float
    control_reuse_ratio: float
    observed_mean_aer_h5: float | None
    null_mean_aer_h5: float | None
    p_raw: float | None
    observed_pinning_rate: float | None
    matched_null_pinning_rate: float | None
    clustering_excess: float | None
    n_perm: int
    status: Literal["EVALUATED", "NO_EVENTS", "INSUFFICIENT_MATCHES", "INSUFFICIENT_SAMPLE"]
    null_std_aer_h5: float | None = None
    z_lift_aer_h5: float | None = None


@dataclass(frozen=True)
class MatchedPermutationSummary:
    results_by_family: dict[str, PermutationFamilyResult]
    vol_regime_source: str
    seed: int
    n_perm: int
    primary_endpoint: str
    directional_results: dict[tuple[str, Literal["LONG", "SHORT"]], PermutationFamilyResult] = field(default_factory=dict)
    workers: int = 1


@dataclass(frozen=True)
class DsrResult:
    dsr: float | None
    sharpe_observed: float | None
    sharpe_benchmark_sr_star: float | None
    n_obs: int
    n_trials_m: int
    skewness: float | None
    kurtosis_pearson: float | None
    kurtosis_convention: str
    status: Literal["OK", "DSR_NOT_EVALUABLE"]
    reason: str


@dataclass(frozen=True)
class RomanoWolfResult:
    p_rw_by_family: dict[str, float | None]
    t_stat_by_family: dict[str, float | None]
    status_by_family: dict[str, str]
    n_boot: int
    avg_block_len: float
    seed: int


def assign_spy_vol_quartiles(
    trade_dates: Sequence[str],
    spy_cores_df: pl.DataFrame | None = None,
    *,
    train_end_date: str | None = None,
) -> tuple[dict[str, int], str]:
    """Map each ``trade_date`` to volatility quartile ``1..4`` using SPY 30d ATM IV.

    Important distinction:
    - When ``train_end_date`` is provided (walk-forward), quartile cutoffs are fitted
      STRICTLY on ``trade_date <= train_end_date`` (``CAUSAL_TRAIN_ONLY_SPY_IV30D``).
    - Otherwise, full-sample SPY quartiles are tagged ``FULL_SAMPLE_RETROSPECTIVE_MATCH``.
    """
    if spy_cores_df is None or spy_cores_df.height == 0 or "iv_30d_dec" not in spy_cores_df.columns:
        return {td: 1 for td in trade_dates}, "UNIFORM_FALLBACK_NO_SPY_IV"

    valid_rows = spy_cores_df.filter(
        pl.col("iv_30d_dec").is_not_null() & pl.col("iv_30d_dec").is_finite() & (pl.col("iv_30d_dec") > 0.0)
    ).sort("trade_date")
    if valid_rows.height < 4:
        return {td: 1 for td in trade_dates}, "UNIFORM_FALLBACK_SPARSE_SPY_IV"

    if train_end_date is not None:
        fit_rows = valid_rows.filter(pl.col("trade_date") <= train_end_date)
        src_tag = "CAUSAL_TRAIN_ONLY_SPY_IV30D"
    else:
        fit_rows = valid_rows
        src_tag = "FULL_SAMPLE_RETROSPECTIVE_MATCH"

    if fit_rows.height < 4:
        return {td: 1 for td in trade_dates}, "UNIFORM_FALLBACK_SHORT_TRAIN_IV"

    q25, q50, q75 = np.quantile(fit_rows["iv_30d_dec"].to_numpy(), [0.25, 0.50, 0.75])
    iv_map = {str(r["trade_date"])[:10]: float(r["iv_30d_dec"]) for r in valid_rows.select(["trade_date", "iv_30d_dec"]).to_dicts()}

    # Forward-lookup exact trade_date only (do NOT invent unseen dates; if missing, nearest prior <= 5d)
    sorted_iv_dates = sorted(iv_map.keys())
    out: dict[str, int] = {}
    for td in trade_dates:
        iv = iv_map.get(td)
        if iv is None:
            # Find latest available SPY IV <= td
            prior = [d for d in sorted_iv_dates if d <= td]
            iv = iv_map[prior[-1]] if prior else iv_map[sorted_iv_dates[0]]
        if iv <= q25:
            out[td] = 1
        elif iv <= q50:
            out[td] = 2
        elif iv <= q75:
            out[td] = 3
        else:
            out[td] = 4
    return out, src_tag


def _prepare_split_normalized_arrays(
    bars_df: pl.DataFrame,
    splits: Sequence[CorporateSplitEvent],
) -> dict[str, Any]:
    """Convert raw bars to common final-session share/price units for ultra-fast O(1) null pool evaluation."""
    ordered = bars_df.sort("ts_open_utc_s")
    n = ordered.height
    dates = [str(x) for x in ordered["trade_date"].to_list()]
    o_arr = np.asarray(ordered["o"].to_list(), dtype=np.float64)
    h_arr = np.asarray(ordered["h"].to_list(), dtype=np.float64)
    l_arr = np.asarray(ordered["l"].to_list(), dtype=np.float64)
    c_arr = np.asarray(ordered["c"].to_list(), dtype=np.float64)
    w_arr = np.asarray(ordered["W"].to_list(), dtype=np.float64)
    mu_arr = np.asarray(ordered["mu"].to_list(), dtype=np.float64)
    atr_arr = np.asarray([float(x) if x is not None else math.nan for x in ordered["atr14"].to_list()], dtype=np.float64)
    atrp_arr = np.asarray([float(x) if x is not None else math.nan for x in ordered["atr14_prev"].to_list()], dtype=np.float64)

    sym = str(ordered["ticker"][0])
    sp_sorted = sorted([s for s in splits if s.ticker == sym], key=lambda x: x.effective_date)
    # Build forward cumulative split factor to convert all bars into FINAL bar's share/price units:
    # price_final = price_t * prod_{splits > date_t} k_s; volume_final = volume_t / prod_{splits > date_t} k_s
    k_step = np.ones(n, dtype=np.float64)
    sp_ptr = 0
    for idx, td in enumerate(dates):
        while sp_ptr < len(sp_sorted) and td >= sp_sorted[sp_ptr].effective_date:
            if idx > 0:
                k_step[idx] *= sp_sorted[sp_ptr].split_from / sp_sorted[sp_ptr].split_to
            sp_ptr += 1

    # suffix_k[i] = prod_{j=i+1..n-1} k_step[j] converts bar i prices to bar (n-1) units
    suffix_k = np.ones(n, dtype=np.float64)
    acc = 1.0
    for i in range(n - 1, -1, -1):
        suffix_k[i] = acc
        acc *= k_step[i]

    p_scale = suffix_k
    v_scale = 1.0 / suffix_k
    w_norm = w_arr * v_scale
    wm_norm = w_norm * (mu_arr * p_scale)

    pref_w = np.zeros(n + 1, dtype=np.float64)
    pref_wm = np.zeros(n + 1, dtype=np.float64)
    pref_w[1:] = np.cumsum(w_norm)
    pref_wm[1:] = np.cumsum(wm_norm)

    return {
        "n": n,
        "dates": dates,
        "o": o_arr * p_scale,
        "h": h_arr * p_scale,
        "l": l_arr * p_scale,
        "c": c_arr * p_scale,
        "atr": atr_arr * p_scale,
        "atrp": atrp_arr * p_scale,
        "pref_w": pref_w,
        "pref_wm": pref_wm,
    }


def _eval_null_anchor_fast(
    norm: dict[str, Any],
    *,
    anchor_idx: int,
    confirmation_lag: int,
    age_span: int,
    polarity: Literal["LONG", "SHORT"],
    horizon: int = 5,
) -> tuple[float | None, float | None, int]:
    """Evaluate a single non-catalyst counterfactual anchor over exact matched lag/age/horizon."""
    n = norm["n"]
    activated_idx = anchor_idx + confirmation_lag
    end_eval = min(n - 1, anchor_idx + max(age_span, confirmation_lag + horizon + 2))
    start_eval = max(activated_idx, anchor_idx + 1)
    if end_eval - start_eval < 5:
        return None, None, 0

    pref_w = norm["pref_w"]
    pref_wm = norm["pref_wm"]
    h = norm["h"]
    l = norm["l"]
    c = norm["c"]
    atr = norm["atr"]
    atrp = norm["atrp"]

    # Fast AVWAP slice on [anchor_idx .. end_eval]
    w_base = pref_w[anchor_idx]
    wm_base = pref_wm[anchor_idx]
    denom = pref_w[anchor_idx + 1 : end_eval + 2] - w_base
    num = pref_wm[anchor_idx + 1 : end_eval + 2] - wm_base
    av = np.where(denom > 0.0, num / denom, math.nan)

    def _av(idx: int) -> float:
        return float(av[idx - anchor_idx])

    elig_bars = 0
    pin_bars = 0
    touch_aers: list[float] = []
    last_touch = None

    for k in range(start_eval, end_eval + 1):
        atr_k = float(atr[k])
        av_k = _av(k)
        if not (math.isfinite(atr_k) and atr_k > 0.0 and math.isfinite(av_k) and av_k > 0.0):
            continue
        elig_bars += 1
        if abs(float(c[k]) - av_k) <= 0.20 * atr_k:
            pin_bars += 1

        if k < anchor_idx + 5:
            continue
        if last_touch is not None and (k - last_touch) < 3:
            continue

        sep_ok = True
        for u in range(k - 5, k):
            atr_u = float(atr[u])
            av_u = _av(u)
            if not (math.isfinite(atr_u) and atr_u > 0.0 and math.isfinite(av_u)):
                sep_ok = False
                break
            sep_u = ((float(l[u]) - av_u) / atr_u) if polarity == "LONG" else ((av_u - float(h[u])) / atr_u)
            if sep_u < 0.75:
                sep_ok = False
                break
        if not sep_ok:
            continue

        if polarity == "LONG":
            touched = float(l[k]) <= av_k + 0.25 * atr_k and float(h[k]) >= av_k - 0.25 * atr_k
            pen = (av_k - float(c[k])) / atr_k
        else:
            touched = float(h[k]) >= av_k - 0.25 * atr_k and float(l[k]) <= av_k + 0.25 * atr_k
            pen = (float(c[k]) - av_k) / atr_k

        if not (touched and pen <= 0.50):
            continue

        last_touch = k
        entry_idx = k + 1
        end_h = entry_idx + horizon - 1
        if end_h >= n:
            continue
        atr_ent = float(atrp[entry_idx])
        entry_px = float(norm["o"][entry_idx])
        if not (math.isfinite(atr_ent) and atr_ent > 0.0):
            continue

        if polarity == "LONG":
            mfe = float(np.max(np.maximum(0.0, (h[entry_idx : end_h + 1] - entry_px) / atr_ent)))
            mae = float(np.max(np.maximum(0.0, (entry_px - l[entry_idx : end_h + 1]) / atr_ent)))
        else:
            mfe = float(np.max(np.maximum(0.0, (entry_px - l[entry_idx : end_h + 1]) / atr_ent)))
            mae = float(np.max(np.maximum(0.0, (h[entry_idx : end_h + 1] - entry_px) / atr_ent)))
        touch_aers.append(mfe - mae)

    pin_rate = (pin_bars / float(elig_bars)) if elig_bars > 0 else None
    mean_aer = (math.fsum(touch_aers) / float(len(touch_aers))) if touch_aers else None
    return mean_aer, pin_rate, len(touch_aers)


def _age_bucket(span: int) -> int:
    return max(10, int(round(span / 20.0) * 20))


def _build_ticker_pools_worker(
    task: tuple[
        str,
        dict[str, Any],
        frozenset[int],
        dict[str, int],
        tuple[tuple[str, int, Literal["LONG", "SHORT"], int, int], ...],
        int,
    ],
) -> dict[tuple[str, str, int, Literal["LONG", "SHORT"], int, int], list[tuple[int, float | None, float | None]]]:
    """Compute counterfactual anchor pools for a single ticker cleanly (picklable worker)."""
    sym, norm, excl, vol_q_by_date, subkeys, horizon = task
    dates = norm["dates"]
    n = norm["n"]
    out: dict[tuple[str, str, int, Literal["LONG", "SHORT"], int, int], list[tuple[int, float | None, float | None]]] = {}
    for yr, vq, pol, lag, age_b in subkeys:
        full_key = (sym, yr, vq, pol, lag, age_b)
        if full_key in out:
            continue
        pool: list[tuple[int, float | None, float | None]] = []
        upper = n - max(horizon + lag + 6, 12)
        for u in range(14, upper):
            if u in excl:
                continue
            td = dates[u]
            if td[:4] != yr or vol_q_by_date.get(td, 1) != vq:
                continue
            if not (math.isfinite(float(norm["atr"][u])) and float(norm["atr"][u]) > 0.0):
                continue
            m_aer, p_rate, _ = _eval_null_anchor_fast(
                norm, anchor_idx=u, confirmation_lag=lag, age_span=age_b, polarity=pol, horizon=horizon
            )
            pool.append((u, m_aer, p_rate))
        out[full_key] = pool
    return out


def _eval_family_perm_worker(
    task: tuple[
        str,
        int,
        int,
        int,
        list[float],
        list[np.ndarray],
        list[float],
        list[np.ndarray],
        list[int],
        int,
        np.random.SeedSequence,
    ],
) -> PermutationFamilyResult:
    """Evaluate Monte Carlo permutation draws for one group/family with its isolated deterministic SeedSequence."""
    (
        fam_label,
        anchors_total,
        mature_cnt,
        insuff_cnt,
        obs_anchor_aers,
        matched_aer_pools,
        obs_pins,
        matched_pin_pools,
        pool_sizes,
        n_perm,
        child_ss,
    ) = task

    obs_pin_mean = float(np.mean(obs_pins)) if obs_pins else None
    null_pin_mean = float(np.mean([float(np.mean(p)) for p in matched_pin_pools])) if matched_pin_pools else None
    clust_exc = (obs_pin_mean - null_pin_mean) if (obs_pin_mean is not None and null_pin_mean is not None) else None

    if anchors_total == 0:
        return PermutationFamilyResult(
            family=fam_label, anchors_total=0, anchors_with_mature_touches=0,
            anchors_matched=0, anchors_insufficient_matches=0,
            pool_size_median=0.0, control_reuse_ratio=0.0,
            observed_mean_aer_h5=None, null_mean_aer_h5=None, p_raw=None,
            observed_pinning_rate=None, matched_null_pinning_rate=None,
            clustering_excess=None, n_perm=n_perm, status="NO_EVENTS",
            null_std_aer_h5=None, z_lift_aer_h5=None,
        )

    if mature_cnt == 0:
        return PermutationFamilyResult(
            family=fam_label, anchors_total=anchors_total, anchors_with_mature_touches=0,
            anchors_matched=0, anchors_insufficient_matches=insuff_cnt,
            pool_size_median=float(np.median(pool_sizes)) if pool_sizes else 0.0,
            control_reuse_ratio=0.0,
            observed_mean_aer_h5=None, null_mean_aer_h5=None, p_raw=None,
            observed_pinning_rate=obs_pin_mean, matched_null_pinning_rate=null_pin_mean,
            clustering_excess=clust_exc, n_perm=n_perm, status="INSUFFICIENT_SAMPLE",
            null_std_aer_h5=None, z_lift_aer_h5=None,
        )

    if len(obs_anchor_aers) == 0:
        return PermutationFamilyResult(
            family=fam_label, anchors_total=anchors_total, anchors_with_mature_touches=mature_cnt,
            anchors_matched=0, anchors_insufficient_matches=insuff_cnt,
            pool_size_median=0.0, control_reuse_ratio=0.0,
            observed_mean_aer_h5=None, null_mean_aer_h5=None, p_raw=None,
            observed_pinning_rate=obs_pin_mean, matched_null_pinning_rate=null_pin_mean,
            clustering_excess=clust_exc, n_perm=n_perm, status="INSUFFICIENT_MATCHES",
            null_std_aer_h5=None, z_lift_aer_h5=None,
        )

    rng_fam = np.random.default_rng(np.random.PCG64(child_ss))
    obs_stat = float(np.mean(obs_anchor_aers))
    m_matched = len(matched_aer_pools)
    unique_drawn_sum = 0
    acc_draws = np.zeros(n_perm, dtype=np.float64)
    for pool_arr in matched_aer_pools:
        idxs = rng_fam.integers(0, len(pool_arr), size=n_perm)
        unique_drawn_sum += int(len(np.unique(idxs)))
        acc_draws += pool_arr[idxs]
    null_stats = acc_draws / float(m_matched)

    count_ge = int(np.sum(null_stats >= obs_stat))
    p_raw = float((1 + count_ge) / float(n_perm + 1))
    null_mean = float(np.mean(null_stats))
    null_std = float(np.std(null_stats, ddof=1)) if n_perm >= 2 else None
    z_lift = (
        float((obs_stat - null_mean) / null_std)
        if (null_std is not None and math.isfinite(null_std) and null_std > 1e-12)
        else None
    )
    reuse = float(m_matched * n_perm) / float(max(1, unique_drawn_sum))

    return PermutationFamilyResult(
        family=fam_label,
        anchors_total=anchors_total,
        anchors_with_mature_touches=mature_cnt,
        anchors_matched=m_matched,
        anchors_insufficient_matches=insuff_cnt,
        pool_size_median=float(np.median(pool_sizes)),
        control_reuse_ratio=reuse,
        observed_mean_aer_h5=obs_stat,
        null_mean_aer_h5=null_mean,
        p_raw=p_raw,
        observed_pinning_rate=obs_pin_mean,
        matched_null_pinning_rate=null_pin_mean,
        clustering_excess=clust_exc,
        n_perm=n_perm,
        status="EVALUATED",
        null_std_aer_h5=null_std,
        z_lift_aer_h5=z_lift,
    )


def matched_monte_carlo_fdr(
    candidates_by_ticker: Mapping[str, Sequence[CandidateAnchor]],
    touch_summaries_by_ticker: Mapping[str, Mapping[str, AnchorTouchSummary]],
    bars_by_ticker: Mapping[str, pl.DataFrame],
    splits_by_ticker: Mapping[str, Sequence[CorporateSplitEvent]],
    *,
    spy_cores_df: pl.DataFrame | None = None,
    train_end_date: str | None = None,
    n_perm: int = 2000,
    seed: int = 42,
    horizon: int = 5,
    min_pool_size: int = 3,
    workers: int = 1,
) -> MatchedPermutationSummary:
    """Run matched random-anchor permutation test per family controlling ticker, year, vol quartile, polarity, lag, and age."""
    if n_perm < 1:
        raise ValueError(f"n_perm must be >= 1, got {n_perm}")
    n_workers = max(1, int(workers))

    all_dates: set[str] = set()
    for df in bars_by_ticker.values():
        if df.height > 0:
            all_dates.update(str(x) for x in df["trade_date"].to_list())
    vol_q_by_date, vol_src = assign_spy_vol_quartiles(
        sorted(all_dates), spy_cores_df, train_end_date=train_end_date
    )

    norm_by_ticker: dict[str, dict[str, Any]] = {}
    catalyst_excl_by_ticker: dict[str, frozenset[int]] = {}
    for sym, bdf in bars_by_ticker.items():
        if bdf.height == 0:
            continue
        norm_by_ticker[sym] = _prepare_split_normalized_arrays(bdf, splits_by_ticker.get(sym, ()))
        cat_set: set[int] = set()
        for c in candidates_by_ticker.get(sym, ()):
            for offset in (-1, 0, 1):
                cat_set.add(c.anchor_idx + offset)
        catalyst_excl_by_ticker[sym] = frozenset(cat_set)

    # Group real candidates by family and by (family, polarity) across all tickers
    by_family: dict[str, list[tuple[CandidateAnchor, AnchorTouchSummary]]] = {}
    by_family_pol: dict[tuple[str, Literal["LONG", "SHORT"]], list[tuple[CandidateAnchor, AnchorTouchSummary]]] = {}
    needed_subkeys_by_ticker: dict[str, set[tuple[str, int, Literal["LONG", "SHORT"], int, int]]] = {}

    for sym in sorted(candidates_by_ticker.keys()):
        cands = candidates_by_ticker[sym]
        ts_map = touch_summaries_by_ticker.get(sym, {})
        norm = norm_by_ticker.get(sym)
        for c in cands:
            summ = ts_map.get(c.anchor_id)
            if summ is None:
                continue
            by_family.setdefault(c.family, []).append((c, summ))
            by_family_pol.setdefault((c.family, c.polarity), []).append((c, summ))
            if norm is not None:
                td_anchor = norm["dates"][c.anchor_idx]
                yr = td_anchor[:4]
                vq = vol_q_by_date.get(td_anchor, 1)
                age_b = _age_bucket((norm["n"] - 1) - c.anchor_idx)
                needed_subkeys_by_ticker.setdefault(sym, set()).add(
                    (yr, vq, c.polarity, c.confirmation_lag, age_b)
                )

    ticker_tasks = [
        (
            sym,
            norm_by_ticker[sym],
            catalyst_excl_by_ticker.get(sym, frozenset()),
            vol_q_by_date,
            tuple(sorted(needed_subkeys_by_ticker[sym])),
            horizon,
        )
        for sym in sorted(needed_subkeys_by_ticker.keys())
        if sym in norm_by_ticker and needed_subkeys_by_ticker[sym]
    ]

    stratum_cache: dict[tuple[str, str, int, Literal["LONG", "SHORT"], int, int], list[tuple[int, float | None, float | None]]] = {}
    if ticker_tasks:
        if n_workers > 1 and len(ticker_tasks) > 1:
            with concurrent.futures.ProcessPoolExecutor(max_workers=min(n_workers, len(ticker_tasks))) as pool_exec:
                for chunk in pool_exec.map(_build_ticker_pools_worker, ticker_tasks):
                    stratum_cache.update(chunk)
        else:
            for t_task in ticker_tasks:
                stratum_cache.update(_build_ticker_pools_worker(t_task))

    def _assemble_group_inputs(
        fam_label: str,
        items: Sequence[tuple[CandidateAnchor, AnchorTouchSummary]],
        child_ss: np.random.SeedSequence,
    ) -> tuple[
        str,
        int,
        int,
        int,
        list[float],
        list[np.ndarray],
        list[float],
        list[np.ndarray],
        list[int],
        int,
        np.random.SeedSequence,
    ]:
        obs_anchor_aers: list[float] = []
        matched_aer_pools: list[np.ndarray] = []
        obs_pins: list[float] = []
        matched_pin_pools: list[np.ndarray] = []
        pool_sizes: list[int] = []
        insuff_cnt = 0
        mature_cnt = 0

        for cand, summ in items:
            norm = norm_by_ticker.get(cand.ticker)
            if norm is None:
                insuff_cnt += 1
                continue
            td_anchor = norm["dates"][cand.anchor_idx]
            yr = td_anchor[:4]
            vq = vol_q_by_date.get(td_anchor, 1)
            age_b = _age_bucket((norm["n"] - 1) - cand.anchor_idx)
            key = (cand.ticker, yr, vq, cand.polarity, cand.confirmation_lag, age_b)
            pool = stratum_cache.get(key, [])

            pin_vals = np.asarray([p for _, _, p in pool if p is not None and math.isfinite(p)], dtype=np.float64)
            if math.isfinite(summ.pinning_rate) and len(pin_vals) >= min_pool_size:
                obs_pins.append(float(summ.pinning_rate))
                matched_pin_pools.append(pin_vals)

            aers_h = [
                t.outcomes[horizon].aer_atr
                for t in summ.touches
                if horizon in t.outcomes
                and t.outcomes[horizon].status != "RIGHT_CENSORED"
                and math.isfinite(t.outcomes[horizon].aer_atr)
            ]
            if not aers_h:
                continue
            mature_cnt += 1
            aer_pool = np.asarray([a for _, a, _ in pool if a is not None and math.isfinite(a)], dtype=np.float64)
            if len(aer_pool) < min_pool_size:
                insuff_cnt += 1
                continue

            obs_anchor_aers.append(float(math.fsum(aers_h) / len(aers_h)))
            matched_aer_pools.append(aer_pool)
            pool_sizes.append(len(aer_pool))

        return (
            fam_label,
            len(items),
            mature_cnt,
            insuff_cnt,
            obs_anchor_aers,
            matched_aer_pools,
            obs_pins,
            matched_pin_pools,
            pool_sizes,
            n_perm,
            child_ss,
        )

    fam_keys = sorted(by_family.keys())
    fam_seeds = np.random.SeedSequence(seed).spawn(len(fam_keys))
    fam_tasks = [
        _assemble_group_inputs(fam, by_family[fam], fam_seeds[idx])
        for idx, fam in enumerate(fam_keys)
    ]

    dir_keys = sorted(by_family_pol.keys())
    dir_seeds = np.random.SeedSequence(seed + 10_000).spawn(len(dir_keys))
    dir_tasks = [
        _assemble_group_inputs(f"{fam}:{pol}", by_family_pol[(fam, pol)], dir_seeds[idx])
        for idx, (fam, pol) in enumerate(dir_keys)
    ]

    all_tasks = fam_tasks + dir_tasks
    all_outputs: list[PermutationFamilyResult]
    if n_workers > 1 and len(all_tasks) > 1:
        with concurrent.futures.ProcessPoolExecutor(max_workers=min(n_workers, len(all_tasks))) as perm_exec:
            all_outputs = list(perm_exec.map(_eval_family_perm_worker, all_tasks))
    else:
        all_outputs = [_eval_family_perm_worker(t_item) for t_item in all_tasks]

    results = {fam: all_outputs[idx] for idx, fam in enumerate(fam_keys)}
    offset = len(fam_keys)
    directional_results = {
        dir_keys[idx]: all_outputs[offset + idx]
        for idx in range(len(dir_keys))
    }

    return MatchedPermutationSummary(
        results_by_family=results,
        vol_regime_source=vol_src,
        seed=seed,
        n_perm=n_perm,
        primary_endpoint=f"MEAN_ANCHOR_AER_H{horizon}",
        directional_results=directional_results,
        workers=n_workers,
    )


def benjamini_hochberg(
    p_values: Sequence[float | None],
    *,
    alpha: float = 0.05,
) -> list[float | None]:
    """Compute Benjamini-Hochberg FDR adjusted q-values, preserving ``None`` and original order."""
    if not (0.0 < alpha <= 1.0):
        raise ValueError(f"alpha must be in (0, 1], got {alpha}")
    valid: list[tuple[int, float]] = []
    for idx, p in enumerate(p_values):
        if p is not None and not isinstance(p, bool) and math.isfinite(float(p)):
            pv = max(0.0, min(1.0, float(p)))
            valid.append((idx, pv))

    out: list[float | None] = [None] * len(p_values)
    m = len(valid)
    if m == 0:
        return out

    valid.sort(key=lambda pair: pair[1])
    q_sorted = [0.0] * m
    running_min = 1.0
    for rank_0 in range(m - 1, -1, -1):
        rank_1 = rank_0 + 1
        raw_q = valid[rank_0][1] * float(m) / float(rank_1)
        running_min = min(running_min, raw_q, 1.0)
        q_sorted[rank_0] = running_min

    # Preserve exact equality across identical ties
    i = m - 1
    while i >= 0:
        p_cur = valid[i][1]
        j = i
        while j > 0 and math.isclose(valid[j - 1][1], p_cur, rel_tol=0.0, abs_tol=1e-15):
            j -= 1
        shared_q = min(q_sorted[k] for k in range(j, i + 1))
        for k in range(j, i + 1):
            out[valid[k][0]] = shared_q
        i = j - 1

    return out


def stationary_block_bootstrap(
    n_dates: int,
    *,
    n_boot: int,
    avg_block_len: float = 5.0,
    rng: np.random.Generator | None = None,
) -> np.ndarray:
    """Politis-Romano circular stationary bootstrap generating integer date index paths ``(n_boot, n_dates)``."""
    if n_dates < 1 or n_boot < 1:
        raise ValueError("n_dates and n_boot must be >= 1")
    if not (math.isfinite(avg_block_len) and avg_block_len >= 1.0):
        raise ValueError(f"avg_block_len must be >= 1.0, got {avg_block_len}")

    gen = rng if rng is not None else np.random.default_rng(np.random.PCG64(42))
    p_stop = 1.0 / float(avg_block_len)
    paths = np.empty((n_boot, n_dates), dtype=np.int64)
    starts = gen.integers(0, n_dates, size=(n_boot, n_dates))
    breaks = gen.random(size=(n_boot, n_dates)) < p_stop
    paths[:, 0] = starts[:, 0]
    for t in range(1, n_dates):
        paths[:, t] = np.where(breaks[:, t], starts[:, t], (paths[:, t - 1] + 1) % n_dates)
    return paths


def romano_wolf_stepdown(
    observations_by_family: Mapping[str, Sequence[tuple[str, float]]],
    *,
    all_dates: Sequence[str],
    n_boot: int = 500,
    avg_block_len: float = 5.0,
    seed: int = 42,
    min_obs_days: int = 5,
) -> RomanoWolfResult:
    """Date-synchronized Romano-Wolf stepdown FWER control using Politis-Romano stationary bootstrap."""
    families = sorted(observations_by_family.keys())
    dates_sorted = sorted(set(all_dates))
    date_to_pos = {d: i for i, d in enumerate(dates_sorted)}
    n_dates = len(dates_sorted)

    p_rw: dict[str, float | None] = {f: None for f in families}
    t_obs: dict[str, float | None] = {f: None for f in families}
    status_map: dict[str, str] = {}

    # Aggregate daily family series aligned across all_dates
    evaluable_fams: list[str] = []
    daily_means_mat: list[np.ndarray] = []
    daily_present_mat: list[np.ndarray] = []
    obs_means: list[float] = []
    obs_t_vals: list[float] = []

    for fam in families:
        by_d: dict[str, list[float]] = {}
        for td, val in observations_by_family[fam]:
            if td in date_to_pos and math.isfinite(float(val)):
                by_d.setdefault(td, []).append(float(val))
        if len(by_d) < min_obs_days:
            status_map[fam] = "INSUFFICIENT_DAYS"
            continue
        vec = np.full(n_dates, math.nan, dtype=np.float64)
        mask = np.zeros(n_dates, dtype=bool)
        for td, vals in by_d.items():
            pos = date_to_pos[td]
            vec[pos] = math.fsum(vals) / float(len(vals))
            mask[pos] = True
        active_vals = vec[mask]
        sd = float(np.std(active_vals, ddof=1))
        if not math.isfinite(sd) or sd <= 1e-12:
            status_map[fam] = "DEGENERATE_ZERO_VARIANCE"
            continue
        mean_v = float(np.mean(active_vals))
        se_v = sd / math.sqrt(float(len(active_vals)))
        t_val = mean_v / se_v
        evaluable_fams.append(fam)
        daily_means_mat.append(vec)
        daily_present_mat.append(mask)
        obs_means.append(mean_v)
        obs_t_vals.append(t_val)
        t_obs[fam] = t_val
        status_map[fam] = "EVALUATED"

    k_eval = len(evaluable_fams)
    if k_eval == 0 or n_dates == 0:
        return RomanoWolfResult(
            p_rw_by_family=p_rw,
            t_stat_by_family=t_obs,
            status_by_family=status_map,
            n_boot=n_boot,
            avg_block_len=avg_block_len,
            seed=seed,
        )

    rng = np.random.default_rng(np.random.PCG64(seed))
    boot_paths = stationary_block_bootstrap(n_dates, n_boot=n_boot, avg_block_len=avg_block_len, rng=rng)

    # Null-centered studentized bootstrap matrix t_star[k_eval, n_boot]
    t_star = np.full((k_eval, n_boot), -np.inf, dtype=np.float64)
    for j in range(k_eval):
        vec = np.nan_to_num(daily_means_mat[j], nan=0.0)
        msk = daily_present_mat[j]
        mu_obs = obs_means[j]

        boot_vals = vec[boot_paths]
        boot_msk = msk[boot_paths]
        cnts = np.sum(boot_msk, axis=1)
        valid_b = cnts >= max(2, min_obs_days // 2)
        if not np.any(valid_b):
            continue

        sums = np.sum(boot_vals * boot_msk, axis=1)
        means = np.where(valid_b, sums / np.maximum(cnts, 1), 0.0)
        diffs = (boot_vals - means[:, None]) * boot_msk
        vars_b = np.sum(diffs * diffs, axis=1) / np.maximum(cnts - 1, 1)
        ses = np.sqrt(np.maximum(vars_b, 0.0) / np.maximum(cnts, 1))
        good = valid_b & (ses > 1e-12)
        t_vals = np.where(good, (means - mu_obs) / np.where(good, ses, 1.0), -np.inf)
        t_star[j, :] = t_vals

    # Romano-Wolf stepdown loop sorted by descending observed t-statistic
    order = sorted(range(k_eval), key=lambda idx: obs_t_vals[idx], reverse=True)
    prev_p = 0.0
    for step_pos, idx in enumerate(order):
        rem = order[step_pos:]
        max_null = np.max(t_star[rem, :], axis=0)
        valid_null = max_null[np.isfinite(max_null)]
        if len(valid_null) == 0:
            adj_p = 1.0
        else:
            cnt = int(np.sum(valid_null >= obs_t_vals[idx]))
            raw_p = float((1 + cnt) / float(len(valid_null) + 1))
            adj_p = min(1.0, max(prev_p, raw_p))
        prev_p = adj_p
        p_rw[evaluable_fams[idx]] = adj_p

    return RomanoWolfResult(
        p_rw_by_family=p_rw,
        t_stat_by_family=t_obs,
        status_by_family=status_map,
        n_boot=n_boot,
        avg_block_len=avg_block_len,
        seed=seed,
    )


def build_coherent_daily_net_return_series(
    touches: Sequence[AnchorTouchSummary],
    *,
    all_dates: Sequence[str],
    bar_dates_by_ticker: Mapping[str, Sequence[str]],
    horizon: int = 5,
    cost_bps: int = 20,
) -> dict[str, float]:
    """Construct a coherent daily active-book equal-weight net return series without overlap inflation.

    Each matured trade splits its single round-trip net return ``r_net`` evenly across its
    ``L = exit_idx - entry_idx + 1`` active sessions, and the portfolio daily return on date
    ``d`` is the equal-weighted average across all active positions held on date ``d``.
    Dates with zero active positions carry ``0.0`` daily strategy return only when flat vs active
    book is built explicitly over ``all_dates``. Here we return active-position daily returns
    across the strategy's active calendar dates cleanly.
    """
    daily_contribs: dict[str, list[float]] = {}
    for summ in touches:
        td_list = bar_dates_by_ticker.get(summ.ticker, ())
        for t in summ.touches:
            out = t.outcomes.get(horizon)
            if out is None or out.status in ("RIGHT_CENSORED", "AMBIGUOUS") or t.entry_idx is None or out.exit_idx is None:
                continue
            r_net = out.net_returns_by_cost_bps.get(cost_bps, math.nan)
            if not math.isfinite(r_net):
                continue
            span = max(1, out.exit_idx - t.entry_idx + 1)
            daily_alloc = (1.0 + r_net) ** (1.0 / float(span)) - 1.0
            for j in range(t.entry_idx, min(len(td_list), out.exit_idx + 1)):
                daily_contribs.setdefault(str(td_list[j]), []).append(daily_alloc)

    return {
        td: float(math.fsum(daily_contribs[td]) / float(len(daily_contribs[td])))
        for td in sorted(daily_contribs.keys())
        if daily_contribs[td]
    }


def deflated_sharpe_ratio(
    daily_net_returns: Sequence[float],
    *,
    n_trials_m: int,
    trial_sharpes: Sequence[float] | None = None,
    min_obs: int = 10,
) -> DsrResult:
    """Compute Bailey & Lopez de Prado (2014) Deflated Sharpe Ratio on net portfolio returns.

    Kurtosis convention: Pearson fourth central moment ``gamma_4 = mu_4 / sigma^4``
    (``normal = 3.0``; NOT excess kurtosis).
    """
    finite = [float(x) for x in daily_net_returns if x is not None and not isinstance(x, bool) and math.isfinite(float(x))]
    n = len(finite)
    m_trials = max(1, int(n_trials_m))

    if n < min_obs:
        return DsrResult(
            dsr=None,
            sharpe_observed=None,
            sharpe_benchmark_sr_star=None,
            n_obs=n,
            n_trials_m=m_trials,
            skewness=None,
            kurtosis_pearson=None,
            kurtosis_convention="PEARSON_NON_EXCESS_NORMAL_3",
            status="DSR_NOT_EVALUABLE",
            reason=f"INSUFFICIENT_OBS:{n}<{min_obs}",
        )

    arr = np.asarray(finite, dtype=np.float64)
    sd = float(np.std(arr, ddof=1))
    if not math.isfinite(sd) or sd <= 1e-12:
        return DsrResult(
            dsr=None,
            sharpe_observed=None,
            sharpe_benchmark_sr_star=None,
            n_obs=n,
            n_trials_m=m_trials,
            skewness=None,
            kurtosis_pearson=None,
            kurtosis_convention="PEARSON_NON_EXCESS_NORMAL_3",
            status="DSR_NOT_EVALUABLE",
            reason="ZERO_OR_DEGENERATE_VARIANCE",
        )

    sr_hat = float(np.mean(arr)) / sd
    skew_g3 = float(stats.skew(arr, bias=True))
    kurt_g4 = float(stats.kurtosis(arr, fisher=False, bias=True))

    if m_trials <= 1:
        sr_star = 0.0
    else:
        euler_gamma = 0.5772156649015329
        valid_srs = [float(s) for s in (trial_sharpes or ()) if math.isfinite(float(s))]
        if len(valid_srs) >= 2:
            var_sr = max(1.0 / float(n), float(np.var(np.asarray(valid_srs, dtype=np.float64), ddof=1)))
        else:
            var_sr = 1.0 / float(n)
        z1 = float(stats.norm.ppf(1.0 - 1.0 / float(m_trials)))
        z2 = float(stats.norm.ppf(1.0 - math.exp(-1.0) / float(m_trials)))
        sr_star = math.sqrt(var_sr) * ((1.0 - euler_gamma) * z1 + euler_gamma * z2)

    inside_var = 1.0 - skew_g3 * sr_hat + ((kurt_g4 - 1.0) / 4.0) * (sr_hat * sr_hat)
    if not math.isfinite(inside_var) or inside_var <= 1e-12:
        return DsrResult(
            dsr=None,
            sharpe_observed=sr_hat,
            sharpe_benchmark_sr_star=sr_star,
            n_obs=n,
            n_trials_m=m_trials,
            skewness=skew_g3,
            kurtosis_pearson=kurt_g4,
            kurtosis_convention="PEARSON_NON_EXCESS_NORMAL_3",
            status="DSR_NOT_EVALUABLE",
            reason="NON_POSITIVE_SHARPE_VARIANCE_DENOMINATOR",
        )

    z_dsr = ((sr_hat - sr_star) * math.sqrt(float(n - 1))) / math.sqrt(inside_var)
    dsr_val = float(ndtr(z_dsr))
    return DsrResult(
        dsr=dsr_val,
        sharpe_observed=sr_hat,
        sharpe_benchmark_sr_star=sr_star,
        n_obs=n,
        n_trials_m=m_trials,
        skewness=skew_g3,
        kurtosis_pearson=kurt_g4,
        kurtosis_convention="PEARSON_NON_EXCESS_NORMAL_3",
        status="OK",
        reason="OK",
    )
