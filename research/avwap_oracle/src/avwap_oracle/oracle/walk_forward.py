"""Walk-forward validation with purging/embargo and SPY IV + GEX regime stratification."""

from __future__ import annotations

import datetime as dt
import math
from dataclasses import dataclass
from typing import Any, Literal, Mapping, Sequence

import numpy as np
import polars as pl

from avwap_oracle.math_core.nyse_calendar import get_session_bounds
from avwap_oracle.oracle.touches import AnchorTouchSummary, TouchObservation

SpyVolRegime = Literal["LOW", "MID", "HIGH", "UNKNOWN"]
GexRegime = Literal["LONG_GAMMA", "SHORT_GAMMA", "NEUTRAL", "UNKNOWN"]


@dataclass(frozen=True)
class WalkForwardFold:
    fold_id: int
    train_start: str
    train_end: str
    test_start: str
    test_end: str
    purged_observations: int
    embargoed_observations: int
    train_sample_size: int
    test_sample_size: int
    train_mean_aer_h5: float | None
    test_mean_aer_h5: float | None
    test_win_rate_2_1: float | None
    config_version: str
    dataset_hash: str
    status: str


def _add_months(d: dt.date, months: int) -> dt.date:
    y = d.year + (d.month - 1 + months) // 12
    m = (d.month - 1 + months) % 12 + 1
    # Clamp day safely to month end
    for day in (d.day, 28, 29, 30):
        try:
            return dt.date(y, m, min(d.day, day))
        except ValueError:
            continue
    return dt.date(y, m, 28)


def _advance_trading_days(d: dt.date, count: int) -> dt.date:
    cur = d
    step = 0
    while step < count:
        cur += dt.timedelta(days=1)
        if get_session_bounds(cur) is not None:
            step += 1
    return cur


def classify_spy_vol_regime(iv_30d_dec: float | None) -> SpyVolRegime:
    if iv_30d_dec is None or not math.isfinite(float(iv_30d_dec)) or float(iv_30d_dec) <= 0.0:
        return "UNKNOWN"
    v = float(iv_30d_dec)
    if v < 0.15:
        return "LOW"
    if v <= 0.25:
        return "MID"
    return "HIGH"


def classify_gex_regime(net_gex_raw: float | None, coverage_status: str | None) -> GexRegime:
    if coverage_status != "COMPLETE" or net_gex_raw is None or not math.isfinite(float(net_gex_raw)):
        return "UNKNOWN"
    g = float(net_gex_raw)
    if g > 0.0:
        return "LONG_GAMMA"
    if g < 0.0:
        return "SHORT_GAMMA"
    return "NEUTRAL"


def build_walk_forward_folds(
    trade_dates: Sequence[str],
    *,
    train_months: int = 24,
    test_months: int = 6,
    embargo_sessions: int = 5,
    max_label_horizon: int = 5,
) -> list[tuple[int, str, str, str, str, str]]:
    """Build anchored/rolling walk-forward boundaries ``(fold_id, train_s, train_e, test_s, test_e, embargo_end)``."""
    if not trade_dates:
        return []
    ordered = sorted(set(trade_dates))
    start_d = dt.date.fromisoformat(ordered[0])
    end_d = dt.date.fromisoformat(ordered[-1])

    folds: list[tuple[int, str, str, str, str, str]] = []
    fid = 1
    cur_train_start = start_d
    while True:
        train_end_target = _add_months(cur_train_start, train_months) - dt.timedelta(days=1)
        train_dates = [d for d in ordered if cur_train_start.isoformat() <= d <= train_end_target.isoformat()]
        if len(train_dates) < 200:
            break
        embargo_end = _advance_trading_days(dt.date.fromisoformat(train_dates[-1]), embargo_sessions)
        test_start_target = embargo_end + dt.timedelta(days=1)
        test_end_target = _add_months(test_start_target, test_months) - dt.timedelta(days=1)
        if test_start_target > end_d:
            break
        test_dates = [d for d in ordered if test_start_target.isoformat() <= d <= test_end_target.isoformat()]
        if len(test_dates) < 10:
            break
        folds.append(
            (
                fid,
                train_dates[0],
                train_dates[-1],
                test_dates[0],
                test_dates[-1],
                embargo_end.isoformat(),
            )
        )
        fid += 1
        cur_train_start = _add_months(cur_train_start, test_months)

    return folds


def evaluate_walk_forward(
    *,
    touches: Sequence[TouchObservation],
    bar_dates_by_ticker: Mapping[str, Sequence[str]],
    config_version: str,
    dataset_hash: str,
    embargo_sessions: int = 5,
    max_label_horizon: int = 5,
    train_months: int = 24,
    test_months: int = 6,
) -> tuple[list[WalkForwardFold], dict[str, str]]:
    """Evaluate walk-forward folds with label-overlap purging & NYSE embargo; report insufficient tickers."""
    all_dates: list[str] = []
    for ds in bar_dates_by_ticker.values():
        all_dates.extend(ds)
    fold_specs = build_walk_forward_folds(
        all_dates,
        train_months=train_months,
        test_months=test_months,
        embargo_sessions=embargo_sessions,
        max_label_horizon=max_label_horizon,
    )

    ticker_fold_status: dict[str, str] = {}
    for sym, ds in bar_dates_by_ticker.items():
        sym_folds = build_walk_forward_folds(
            ds,
            train_months=train_months,
            test_months=test_months,
            embargo_sessions=embargo_sessions,
            max_label_horizon=max_label_horizon,
        )
        ticker_fold_status[sym] = f"VALID_FOLDS:{len(sym_folds)}" if sym_folds else "INSUFFICIENT_HISTORY_ZERO_FOLDS"

    if not fold_specs:
        return [], ticker_fold_status

    folds_out: list[WalkForwardFold] = []
    for fid, tr_s, tr_e, te_s, te_e, emb_end in fold_specs:
        train_aers: list[float] = []
        test_aers: list[float] = []
        test_wins = 0
        test_den = 0
        purged = 0
        embargoed = 0

        for t in touches:
            tds = bar_dates_by_ticker.get(t.ticker, ())
            if t.entry_idx is None or t.entry_idx >= len(tds):
                continue
            out5 = t.outcomes.get(max_label_horizon)
            if out5 is None or out5.status == "RIGHT_CENSORED":
                continue
            ent_date = str(tds[t.entry_idx])
            ex_idx = out5.exit_idx if out5.exit_idx is not None else min(len(tds) - 1, t.entry_idx + max_label_horizon - 1)
            ex_date = str(tds[ex_idx])

            if tr_s <= ent_date <= tr_e:
                # Purge any training observation whose outcome horizon extends beyond train_end
                if ex_date > tr_e:
                    purged += 1
                    continue
                if math.isfinite(out5.aer_atr):
                    train_aers.append(out5.aer_atr)
            elif tr_e < ent_date <= emb_end:
                embargoed += 1
            elif te_s <= ent_date <= te_e:
                if math.isfinite(out5.aer_atr):
                    test_aers.append(out5.aer_atr)
                if out5.status in ("WIN", "LOSS", "TIMEOUT"):
                    test_den += 1
                    if out5.status == "WIN":
                        test_wins += 1

        folds_out.append(
            WalkForwardFold(
                fold_id=fid,
                train_start=tr_s,
                train_end=tr_e,
                test_start=te_s,
                test_end=te_e,
                purged_observations=purged,
                embargoed_observations=embargoed,
                train_sample_size=len(train_aers),
                test_sample_size=len(test_aers),
                train_mean_aer_h5=(math.fsum(train_aers) / len(train_aers)) if train_aers else None,
                test_mean_aer_h5=(math.fsum(test_aers) / len(test_aers)) if test_aers else None,
                test_win_rate_2_1=(test_wins / float(test_den)) if test_den > 0 else None,
                config_version=config_version,
                dataset_hash=dataset_hash,
                status="EVALUATED" if test_aers else "INSUFFICIENT_OOS_TOUCHES",
            )
        )

    return folds_out, ticker_fold_status


def stratify_touches_by_regime(
    *,
    touches: Sequence[TouchObservation],
    bar_dates_by_ticker: Mapping[str, Sequence[str]],
    spy_cores_df: pl.DataFrame | None,
    gex_opex_by_ticker: Mapping[str, pl.DataFrame],
    horizon: int = 5,
    cost_bps: int = 20,
) -> dict[str, dict[str, dict[str, Any]]]:
    """Stratify matured touches strictly on available SPY IV and available GEX snapshots (no unlimited forward-fill)."""
    spy_iv_map: dict[str, float] = {}
    if spy_cores_df is not None and spy_cores_df.height > 0:
        for r in spy_cores_df.select(["trade_date", "iv_30d_dec"]).to_dicts():
            iv_v = r.get("iv_30d_dec")
            if iv_v is not None and math.isfinite(float(iv_v)):
                spy_iv_map[str(r["trade_date"])[:10]] = float(iv_v)

    gex_snapshot_map: dict[tuple[str, str], tuple[float | None, str | None]] = {}
    for sym, gdf in gex_opex_by_ticker.items():
        if gdf.height == 0:
            continue
        for r in gdf.iter_rows(named=True):
            td = str(r.get("trade_date") or "")[:10]
            cov = str(r.get("coverage_status") or "")
            ng = r.get("net_gex_raw_gamma_oi")
            gex_snapshot_map[(sym, td)] = (float(ng) if ng is not None else None, cov)

    vol_buckets: dict[str, list[TouchObservation]] = {"LOW": [], "MID": [], "HIGH": [], "UNKNOWN": []}
    gex_buckets: dict[str, list[TouchObservation]] = {"LONG_GAMMA": [], "SHORT_GAMMA": [], "NEUTRAL": [], "UNKNOWN": []}

    for t in touches:
        tds = bar_dates_by_ticker.get(t.ticker, ())
        if t.entry_idx is None or t.entry_idx >= len(tds):
            continue
        sig_date = str(tds[t.touch_idx])
        v_reg = classify_spy_vol_regime(spy_iv_map.get(sig_date))
        vol_buckets[v_reg].append(t)

        # Gamma stratification strictly limited to snapshots available on signal date (never FF over months!)
        ng, cov = gex_snapshot_map.get((t.ticker, sig_date), (None, None))
        g_reg = classify_gex_regime(ng, cov)
        gex_buckets[g_reg].append(t)

    def _agg(bucket: Sequence[TouchObservation]) -> dict[str, Any]:
        aers: list[float] = []
        nets: list[float] = []
        wins = 0
        den = 0
        censored = 0
        for t in bucket:
            out = t.outcomes.get(horizon)
            if out is None or out.status == "RIGHT_CENSORED":
                censored += 1
                continue
            if math.isfinite(out.aer_atr):
                aers.append(out.aer_atr)
            nv = out.net_returns_by_cost_bps.get(cost_bps, math.nan)
            if math.isfinite(nv):
                nets.append(nv)
            if out.status in ("WIN", "LOSS", "TIMEOUT"):
                den += 1
                if out.status == "WIN":
                    wins += 1
        return {
            "count_touches": len(bucket),
            "matured_count": len(aers),
            "censored_count": censored,
            "mean_aer": (math.fsum(aers) / len(aers)) if aers else None,
            "win_rate_2_1": (wins / float(den)) if den > 0 else None,
            "win_denom": den,
            f"mean_net_ret_{cost_bps}bps": (math.fsum(nets) / len(nets)) if nets else None,
        }

    return {
        "spy_vol_regime": {k: _agg(v) for k, v in vol_buckets.items()},
        "gex_snapshot_regime": {k: _agg(v) for k, v in gex_buckets.items()},
    }
