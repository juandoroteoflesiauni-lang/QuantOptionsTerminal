"""Strictly causal event detectors (RVOL, ATR14, Volume Climax, Breakaway Gaps, Swings).

Causal timestamp contract:
    Every emitted signal separates:
    - ``anchor_ts``: bar opening timestamp where the anchor originates.
    - ``activated_ts``: bar opening timestamp where confirmation occurs.
    - ``available_at_utc_s``: closing UTC timestamp of the confirming bar
      (``ts_close_utc_s``), i.e., earliest instant the signal can be known.
    - ``confirmation_lag``: integer bar index difference ``confirm_idx - anchor_idx``.
    Zero-lag detectors (``anchor_ts == activated_ts``) reflect confirmation at the
    close of that bar, NEVER look-ahead knowledge at bar open.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Literal

import numpy as np
import polars as pl

from avwap_oracle.math_core.nyse_calendar import TIMEFRAME_MINUTES

DEFAULT_SWING_PARAMS: dict[str, tuple[float, int]] = {
    "1D": (2.0, 2),
    "1H": (2.0, 2),
    "65m": (2.0, 2),
    "4H": (2.0, 2),
    "30m": (1.5, 2),
    "15m": (1.5, 2),
    "5m": (1.5, 2),
}


@dataclass(frozen=True)
class CausalEvent:
    ticker: str
    event_type: Literal["VOLUME_CLIMAX", "BREAKAWAY_GAP"]
    direction: Literal["BULLISH", "BEARISH"]
    anchor_ts: int
    activated_ts: int
    available_at_utc_s: int
    confirmation_lag: int
    bar_index: int
    rvol_z: float
    atr14_prev: float


@dataclass(frozen=True)
class CausalSwingEvent:
    ticker: str
    swing_kind: Literal["SWING_HIGH", "SWING_LOW"]
    classification: Literal["SWING_CAUSAL", "SWING_NO_RVOL", "SWING_RVOL_UNAVAILABLE"]
    anchor_ts: int
    activated_ts: int
    available_at_utc_s: int
    confirmation_lag: int
    anchor_idx: int
    confirm_idx: int
    anchor_price: float
    confirm_price: float
    atr_at_anchor: float
    anchor_rvol_z: float


def _resolve_vol_col(df: pl.DataFrame) -> str:
    if "W" in df.columns:
        return "W"
    if "volume" in df.columns:
        return "volume"
    raise ValueError("Expected 'W' or 'volume' column")


def _resolve_ts_close_series(df: pl.DataFrame, default_tf_minutes: int = 5) -> list[int]:
    if "ts_close_utc_s" in df.columns:
        return [int(x) for x in df["ts_close_utc_s"].to_list()]
    if "ts_open_utc_s" not in df.columns:
        raise ValueError("Expected 'ts_close_utc_s' or 'ts_open_utc_s'")
    opens = df["ts_open_utc_s"].to_list()
    if "rth_close_utc_s" in df.columns:
        rth_closes = df["rth_close_utc_s"].to_list()
        return [
            min(int(op) + default_tf_minutes * 60, int(rc))
            for op, rc in zip(opens, rth_closes)
        ]
    return [int(op) + default_tf_minutes * 60 for op in opens]


def compute_bucket_rvol_z(
    df: pl.DataFrame,
    *,
    window_sessions: int = 40,
    min_history: int = 20,
    epsilon: float = 1e-6,
) -> pl.DataFrame:
    """Compute strictly causal robust log-volume z-score by ``(ticker, bucket_id)``.

    History uses at most ``window_sessions`` strictly prior valid sessions
    (``trade_date_hist < trade_date_cur``) excluding ``is_earnings_day`` and
    ``is_early_close`` sessions, requiring at least ``min_history`` sessions.
    """
    if window_sessions < 1 or min_history < 1 or min_history > window_sessions:
        raise ValueError("Invalid window_sessions / min_history parameters")
    if epsilon <= 0.0 or not math.isfinite(epsilon):
        raise ValueError("epsilon must be finite > 0")

    required = {"ticker", "trade_date", "bucket_id", "ts_open_utc_s"}
    missing = sorted(required - set(df.columns))
    if missing:
        raise ValueError(f"Missing required columns for compute_bucket_rvol_z: {missing}")

    vol_col = _resolve_vol_col(df)
    if df.height == 0:
        return df.with_columns(
            pl.lit(None, dtype=pl.Float64).alias("rvol_z"),
            pl.lit(None, dtype=pl.Int32).alias("rvol_history_count"),
            pl.lit(None, dtype=pl.Boolean).alias("rvol_mad_zero"),
            pl.lit(None, dtype=pl.String).alias("rvol_status"),
        )

    ordered = df.sort(["ticker", "ts_open_utc_s"])
    has_earn = "is_earnings_day" in ordered.columns
    has_early = "is_early_close" in ordered.columns

    rvol_z_out: list[float] = []
    hist_n_out: list[int] = []
    mad_zero_out: list[bool] = []
    status_out: list[str] = []

    # Per (ticker, bucket_id) maintain strictly causal prior-session history.
    history_by_key: dict[tuple[str, int], list[tuple[str, float]]] = {}
    for row in ordered.iter_rows(named=True):
        ticker = str(row["ticker"])
        tdate = str(row["trade_date"])
        bid = int(row["bucket_id"])
        vol_raw = row[vol_col]
        is_earn = bool(row["is_earnings_day"]) if has_earn and row["is_earnings_day"] is not None else False
        is_early = bool(row["is_early_close"]) if has_early and row["is_early_close"] is not None else False

        key = (ticker, bid)
        hist = history_by_key.setdefault(key, [])
        # Strictly prior dates only; current session never enters its own baseline.
        prior_vols = [v for d_hist, v in hist if d_hist < tdate][-window_sessions:]
        n_hist = len(prior_vols)
        hist_n_out.append(n_hist)

        vol_valid = (
            vol_raw is not None
            and not isinstance(vol_raw, bool)
            and math.isfinite(float(vol_raw))
            and float(vol_raw) >= 0.0
        )

        if not vol_valid:
            rvol_z_out.append(math.nan)
            mad_zero_out.append(False)
            status_out.append("VOLUME_UNAVAILABLE")
        elif n_hist < min_history:
            rvol_z_out.append(math.nan)
            mad_zero_out.append(False)
            status_out.append("INSUFFICIENT_HISTORY")
        else:
            ell_hist = np.log(np.maximum(np.asarray(prior_vols, dtype=np.float64), 1.0))
            med = float(np.median(ell_hist))
            mad = float(np.median(np.abs(ell_hist - med)))
            ell_cur = math.log(max(float(vol_raw), 1.0))
            denom = 1.4826 * mad + epsilon
            rvol_z_out.append((ell_cur - med) / denom)
            is_mad_zero = mad == 0.0
            mad_zero_out.append(is_mad_zero)
            status_out.append("MAD_ZERO_EPSILON_DENOM" if is_mad_zero else "OK")

        if vol_valid and not is_earn and not is_early:
            # One entry per (ticker, bucket_id, trade_date).
            if not hist or hist[-1][0] != tdate:
                hist.append((tdate, float(vol_raw)))

    return ordered.with_columns(
        pl.Series("rvol_z", rvol_z_out, dtype=pl.Float64),
        pl.Series("rvol_history_count", hist_n_out, dtype=pl.Int32),
        pl.Series("rvol_mad_zero", mad_zero_out, dtype=pl.Boolean),
        pl.Series("rvol_status", status_out, dtype=pl.String),
    )


def compute_causal_atr14(
    df: pl.DataFrame,
    *,
    period: int = 14,
) -> pl.DataFrame:
    """Compute Wilder ATR(14) and strictly prior ``atr14_prev`` per ticker.

    Initialization and causality:
        - ``TR[0] = high[0] - low[0]``; for ``t >= 1``, includes overnight/session
          gaps against ``prev_close * split_factor_k``.
        - Warm-up bars ``0 .. period - 2`` emit ``atr14 = NaN``.
        - Seed at ``t = period - 1`` is SMA of first ``period`` True Ranges.
        - Recursion: ``atr14[t] = (atr14[t-1] * (period - 1) + TR[t]) / period``.
        - ``atr14_prev[t] = atr14[t-1] * split_factor_k[t]`` is strictly
          confirmed BEFORE bar ``t`` opens (available at close of bar ``t-1``).
    """
    if period < 1:
        raise ValueError(f"period must be >= 1, got {period}")
    required = {"ticker", "ts_open_utc_s", "h", "l", "c"}
    missing = sorted(required - set(df.columns))
    if missing:
        raise ValueError(f"Missing required columns for compute_causal_atr14: {missing}")

    if df.height == 0:
        return df.with_columns(
            pl.lit(None, dtype=pl.Float64).alias("tr"),
            pl.lit(None, dtype=pl.Float64).alias("atr14"),
            pl.lit(None, dtype=pl.Float64).alias("atr14_prev"),
            pl.lit(None, dtype=pl.Float64).alias("prev_close_causal"),
        )

    ordered = df.sort(["ticker", "ts_open_utc_s"])
    has_split_k = "split_factor_k" in ordered.columns

    tr_out: list[float] = []
    atr_out: list[float] = []
    atr_prev_out: list[float] = []
    prev_c_out: list[float] = []

    state_by_ticker: dict[str, dict[str, Any]] = {}
    for row in ordered.iter_rows(named=True):
        ticker = str(row["ticker"])
        h = float(row["h"])
        l = float(row["l"])
        c = float(row["c"])
        k = float(row["split_factor_k"]) if has_split_k and row["split_factor_k"] is not None else 1.0
        if not (math.isfinite(k) and k > 0.0):
            raise ValueError(f"Invalid split_factor_k={k!r}")

        st = state_by_ticker.get(ticker)
        if st is None:
            tr = h - l
            st = {
                "tr_history": [tr],
                "atr": math.nan,
                "prev_close": c,
            }
            if period == 1:
                st["atr"] = tr
            state_by_ticker[ticker] = st
            tr_out.append(tr)
            atr_out.append(st["atr"])
            atr_prev_out.append(math.nan)
            prev_c_out.append(math.nan)
            continue

        prev_c_adj = st["prev_close"] * k
        atr_prev_scaled = st["atr"] * k if math.isfinite(st["atr"]) else math.nan
        prev_c_out.append(prev_c_adj)
        atr_prev_out.append(atr_prev_scaled)

        tr = max(h - l, abs(h - prev_c_adj), abs(l - prev_c_adj))
        tr_out.append(tr)
        st["tr_history"].append(tr)
        if len(st["tr_history"]) < period:
            new_atr = math.nan
        elif len(st["tr_history"]) == period:
            new_atr = math.fsum(st["tr_history"]) / period
        else:
            new_atr = (atr_prev_scaled * (period - 1) + tr) / period
        st["atr"] = new_atr
        st["prev_close"] = c
        atr_out.append(new_atr)

    return ordered.with_columns(
        pl.Series("tr", tr_out, dtype=pl.Float64),
        pl.Series("atr14", atr_out, dtype=pl.Float64),
        pl.Series("atr14_prev", atr_prev_out, dtype=pl.Float64),
        pl.Series("prev_close_causal", prev_c_out, dtype=pl.Float64),
    )


def detect_climax_and_gaps(
    df: pl.DataFrame,
    *,
    default_bar_minutes: int = 5,
) -> list[CausalEvent]:
    """Detect strictly causal VOLUME_CLIMAX and BREAKAWAY_GAP events.

    - ``VOLUME_CLIMAX``: ``rvol_z >= 3.0``, ``(h - l) >= 1.8 * atr14_prev``,
      and close in extreme 25% matching bar direction.
    - ``BREAKAWAY_GAP``: strictly on session discontinuity (first bar of a new
      ``trade_date`` with confirmed ``prev_close_causal``), ``rvol_z >= 3.0``,
      ``abs(o - prev_close_causal) >= 1.8 * atr14_prev``, and close in extreme
      25% aligned with the gap direction.
    """
    required = {
        "ticker",
        "trade_date",
        "ts_open_utc_s",
        "o",
        "h",
        "l",
        "c",
        "rvol_z",
        "atr14_prev",
        "prev_close_causal",
    }
    missing = sorted(required - set(df.columns))
    if missing:
        raise ValueError(f"Missing required columns for detect_climax_and_gaps: {missing}")
    if df.height == 0:
        return []

    ordered = df.sort(["ticker", "ts_open_utc_s"])
    closes_utc = _resolve_ts_close_series(ordered, default_tf_minutes=default_bar_minutes)
    events: list[CausalEvent] = []

    idx_by_ticker: dict[str, int] = {}
    prev_date_by_ticker: dict[str, str] = {}

    for row, ts_close in zip(ordered.iter_rows(named=True), closes_utc):
        ticker = str(row["ticker"])
        t_idx = idx_by_ticker.get(ticker, 0)
        idx_by_ticker[ticker] = t_idx + 1

        tdate = str(row["trade_date"])
        prev_date = prev_date_by_ticker.get(ticker)
        prev_date_by_ticker[ticker] = tdate

        rvol_z = row["rvol_z"]
        atr_prev = row["atr14_prev"]
        prev_c = row["prev_close_causal"]
        o = float(row["o"])
        h = float(row["h"])
        l = float(row["l"])
        c = float(row["c"])
        ts_open = int(row["ts_open_utc_s"])

        if (
            rvol_z is None
            or atr_prev is None
            or not math.isfinite(float(rvol_z))
            or not math.isfinite(float(atr_prev))
            or float(atr_prev) <= 0.0
            or h <= l
        ):
            continue

        rz = float(rvol_z)
        ap = float(atr_prev)
        if rz < 3.0:
            continue

        bar_range = h - l
        pos_in_range = (c - l) / bar_range
        bull_extreme = pos_in_range >= 0.75
        bear_extreme = pos_in_range <= 0.25

        # Breakaway gap: requires session discontinuity (new trade_date with prior close).
        is_session_transition = prev_date is not None and tdate != prev_date
        if (
            is_session_transition
            and prev_c is not None
            and math.isfinite(float(prev_c))
            and abs(o - float(prev_c)) >= 1.8 * ap
        ):
            gap = o - float(prev_c)
            if gap > 0.0 and bull_extreme:
                events.append(
                    CausalEvent(
                        ticker=ticker,
                        event_type="BREAKAWAY_GAP",
                        direction="BULLISH",
                        anchor_ts=ts_open,
                        activated_ts=ts_open,
                        available_at_utc_s=ts_close,
                        confirmation_lag=0,
                        bar_index=t_idx,
                        rvol_z=rz,
                        atr14_prev=ap,
                    )
                )
            elif gap < 0.0 and bear_extreme:
                events.append(
                    CausalEvent(
                        ticker=ticker,
                        event_type="BREAKAWAY_GAP",
                        direction="BEARISH",
                        anchor_ts=ts_open,
                        activated_ts=ts_open,
                        available_at_utc_s=ts_close,
                        confirmation_lag=0,
                        bar_index=t_idx,
                        rvol_z=rz,
                        atr14_prev=ap,
                    )
                )

        # Volume climax
        if bar_range >= 1.8 * ap and (bull_extreme or bear_extreme):
            events.append(
                CausalEvent(
                    ticker=ticker,
                    event_type="VOLUME_CLIMAX",
                    direction="BULLISH" if bull_extreme else "BEARISH",
                    anchor_ts=ts_open,
                    activated_ts=ts_open,
                    available_at_utc_s=ts_close,
                    confirmation_lag=0,
                    bar_index=t_idx,
                    rvol_z=rz,
                    atr14_prev=ap,
                )
            )

    return events


def _classify_swing_rvol(anchor_rvol_z: float) -> Literal["SWING_CAUSAL", "SWING_NO_RVOL", "SWING_RVOL_UNAVAILABLE"]:
    if not math.isfinite(anchor_rvol_z):
        return "SWING_RVOL_UNAVAILABLE"
    return "SWING_CAUSAL" if anchor_rvol_z >= 1.5 else "SWING_NO_RVOL"


def detect_causal_swings(
    df: pl.DataFrame,
    timeframe: str,
    *,
    m_atr: float | None = None,
    k_min: int | None = None,
) -> list[CausalSwingEvent]:
    """Deterministic causal ATR swing state machine (zero look-ahead)."""
    tf_min = TIMEFRAME_MINUTES.get(timeframe)
    if tf_min is None and (m_atr is None or k_min is None):
        raise ValueError(f"Unsupported timeframe for default swing params: {timeframe!r}")

    default_m, default_k = DEFAULT_SWING_PARAMS.get(timeframe, (1.5, 2))
    mult = default_m if m_atr is None else float(m_atr)
    lag_min = default_k if k_min is None else int(k_min)
    if not (math.isfinite(mult) and mult > 0.0) or lag_min < 1:
        raise ValueError("Invalid m_atr / k_min parameters")

    required = {"ticker", "ts_open_utc_s", "h", "l", "c", "atr14_prev"}
    missing = sorted(required - set(df.columns))
    if missing:
        raise ValueError(f"Missing required columns for detect_causal_swings: {missing}")
    if df.height == 0:
        return []

    ordered = df.sort(["ticker", "ts_open_utc_s"])
    closes_utc = _resolve_ts_close_series(ordered, default_tf_minutes=tf_min or 5)
    has_rvol = "rvol_z" in ordered.columns
    has_split_k = "split_factor_k" in ordered.columns

    events: list[CausalSwingEvent] = []
    machines: dict[str, dict[str, Any]] = {}

    for row, ts_close in zip(ordered.iter_rows(named=True), closes_utc):
        ticker = str(row["ticker"])
        st = machines.setdefault(
            ticker,
            {
                "idx": 0,
                "mode": "UNINIT",
                "cand_high": None,
                "cand_low": None,
            },
        )
        i = st["idx"]
        st["idx"] += 1

        ts_open = int(row["ts_open_utc_s"])
        h = float(row["h"])
        l = float(row["l"])
        atr_raw = row["atr14_prev"]
        atr = float(atr_raw) if atr_raw is not None and math.isfinite(float(atr_raw)) else math.nan
        rz_raw = row["rvol_z"] if has_rvol else None
        rz = float(rz_raw) if rz_raw is not None and math.isfinite(float(rz_raw)) else math.nan
        k = float(row["split_factor_k"]) if has_split_k and row["split_factor_k"] is not None else 1.0
        if not (math.isfinite(k) and k > 0.0):
            raise ValueError(f"Invalid split_factor_k={k!r}")

        # Rescale in-flight unconfirmed extreme candidates when crossing a raw split.
        if k != 1.0:
            for key in ("cand_high", "cand_low"):
                cand = st[key]
                if cand is not None:
                    cand["price"] *= k
                    cand["atr"] *= k

        if not (math.isfinite(atr) and atr > 0.0):
            continue

        if st["mode"] == "UNINIT":
            st["mode"] = "INIT"
            st["cand_high"] = {"idx": i, "ts": ts_open, "price": h, "atr": atr, "rvol_z": rz}
            st["cand_low"] = {"idx": i, "ts": ts_open, "price": l, "atr": atr, "rvol_z": rz}
            continue

        if st["mode"] == "INIT":
            ch = st["cand_high"]
            cl = st["cand_low"]
            if h > ch["price"]:
                st["cand_high"] = {"idx": i, "ts": ts_open, "price": h, "atr": atr, "rvol_z": rz}
                ch = st["cand_high"]
            if l < cl["price"]:
                st["cand_low"] = {"idx": i, "ts": ts_open, "price": l, "atr": atr, "rvol_z": rz}
                cl = st["cand_low"]

            high_rev = (i - ch["idx"] >= lag_min) and ((ch["price"] - l) >= mult * ch["atr"])
            low_rev = (i - cl["idx"] >= lag_min) and ((h - cl["price"]) >= mult * cl["atr"])

            if high_rev:
                events.append(
                    CausalSwingEvent(
                        ticker=ticker,
                        swing_kind="SWING_HIGH",
                        classification=_classify_swing_rvol(ch["rvol_z"]),
                        anchor_ts=ch["ts"],
                        activated_ts=ts_open,
                        available_at_utc_s=ts_close,
                        confirmation_lag=i - ch["idx"],
                        anchor_idx=ch["idx"],
                        confirm_idx=i,
                        anchor_price=ch["price"],
                        confirm_price=l,
                        atr_at_anchor=ch["atr"],
                        anchor_rvol_z=ch["rvol_z"],
                    )
                )
                st["mode"] = "SEEK_LOW"
                st["cand_high"] = None
                st["cand_low"] = {"idx": i, "ts": ts_open, "price": l, "atr": atr, "rvol_z": rz}
            elif low_rev:
                events.append(
                    CausalSwingEvent(
                        ticker=ticker,
                        swing_kind="SWING_LOW",
                        classification=_classify_swing_rvol(cl["rvol_z"]),
                        anchor_ts=cl["ts"],
                        activated_ts=ts_open,
                        available_at_utc_s=ts_close,
                        confirmation_lag=i - cl["idx"],
                        anchor_idx=cl["idx"],
                        confirm_idx=i,
                        anchor_price=cl["price"],
                        confirm_price=h,
                        atr_at_anchor=cl["atr"],
                        anchor_rvol_z=cl["rvol_z"],
                    )
                )
                st["mode"] = "SEEK_HIGH"
                st["cand_low"] = None
                st["cand_high"] = {"idx": i, "ts": ts_open, "price": h, "atr": atr, "rvol_z": rz}
            continue

        if st["mode"] == "SEEK_HIGH":
            ch = st["cand_high"]
            if h >= ch["price"]:
                st["cand_high"] = {"idx": i, "ts": ts_open, "price": h, "atr": atr, "rvol_z": rz}
                ch = st["cand_high"]
            if (i - ch["idx"] >= lag_min) and ((ch["price"] - l) >= mult * ch["atr"]):
                events.append(
                    CausalSwingEvent(
                        ticker=ticker,
                        swing_kind="SWING_HIGH",
                        classification=_classify_swing_rvol(ch["rvol_z"]),
                        anchor_ts=ch["ts"],
                        activated_ts=ts_open,
                        available_at_utc_s=ts_close,
                        confirmation_lag=i - ch["idx"],
                        anchor_idx=ch["idx"],
                        confirm_idx=i,
                        anchor_price=ch["price"],
                        confirm_price=l,
                        atr_at_anchor=ch["atr"],
                        anchor_rvol_z=ch["rvol_z"],
                    )
                )
                st["mode"] = "SEEK_LOW"
                st["cand_high"] = None
                st["cand_low"] = {"idx": i, "ts": ts_open, "price": l, "atr": atr, "rvol_z": rz}
            continue

        if st["mode"] == "SEEK_LOW":
            cl = st["cand_low"]
            if l <= cl["price"]:
                st["cand_low"] = {"idx": i, "ts": ts_open, "price": l, "atr": atr, "rvol_z": rz}
                cl = st["cand_low"]
            if (i - cl["idx"] >= lag_min) and ((h - cl["price"]) >= mult * cl["atr"]):
                events.append(
                    CausalSwingEvent(
                        ticker=ticker,
                        swing_kind="SWING_LOW",
                        classification=_classify_swing_rvol(cl["rvol_z"]),
                        anchor_ts=cl["ts"],
                        activated_ts=ts_open,
                        available_at_utc_s=ts_close,
                        confirmation_lag=i - cl["idx"],
                        anchor_idx=cl["idx"],
                        confirm_idx=i,
                        anchor_price=cl["price"],
                        confirm_price=h,
                        atr_at_anchor=cl["atr"],
                        anchor_rvol_z=cl["rvol_z"],
                    )
                )
                st["mode"] = "SEEK_HIGH"
                st["cand_low"] = None
                st["cand_high"] = {"idx": i, "ts": ts_open, "price": h, "atr": atr, "rvol_z": rz}

    return events
