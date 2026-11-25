"""Canonical RTH rollups, Chan/Golub/LeVeque-Pebay fusion, Parkinson fallback, and hybrid bands.

Mathematical accuracy contract:
    The canonical research unit is ``(vw_i, volume_i)`` of valid 1m bars.
    ``M2`` and ``std_dev`` describe the volume-weighted dispersion of canonical
    1m bar VWAPs, NOT the tick-by-tick dispersion of individual trades inside
    a 1m bar (which cannot be recovered from Massive 1m aggregates alone).
    RTH filtering excludes observations outside RTH bounds, but does not by
    itself prove exclusion of late/Form T prints reported inside RTH bars.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Literal

import numpy as np
import polars as pl

from avwap_oracle.math_core.nyse_calendar import (
    TIMEFRAME_MINUTES,
    classify_1m_bars_polars,
    validate_timeframe,
)

VarianceSource = Literal["PEBAY_EXACT_1M", "RANGE_PARKINSON_FALLBACK"]

# Veltkamp splitter for IEEE-754 float64 Dekker TwoProd: 2**27 + 1.
_SPLITTER = 134217729.0


def _two_sum(a: float, b: float) -> tuple[float, float]:
    s = a + b
    v = s - a
    e = (a - (s - v)) + (b - v)
    return s, e


def _two_prod(a: float, b: float) -> tuple[float, float]:
    p = a * b
    ca = _SPLITTER * a
    ah = ca - (ca - a)
    al = a - ah
    cb = _SPLITTER * b
    bh = cb - (cb - b)
    bl = b - bh
    e = ((ah * bh - p) + ah * bl + al * bh) + al * bl
    return p, e


def _dd_add(ah: float, al: float, bh: float, bl: float) -> tuple[float, float]:
    sh, sl = _two_sum(ah, bh)
    th, tl = _two_sum(al, bl)
    sl += th
    sh, sl = _two_sum(sh, sl)
    sl += tl
    return _two_sum(sh, sl)


def _dd_sub(ah: float, al: float, bh: float, bl: float) -> tuple[float, float]:
    return _dd_add(ah, al, -bh, -bl)


def _dd_mul(ah: float, al: float, bh: float, bl: float) -> tuple[float, float]:
    ph, pl = _two_prod(ah, bh)
    pl += ah * bl + al * bh
    return _two_sum(ph, pl)


def _dd_div(ah: float, al: float, bh: float, bl: float) -> tuple[float, float]:
    q1 = ah / bh
    ph, pl = _dd_mul(q1, 0.0, bh, bl)
    rh, rl = _dd_sub(ah, al, ph, pl)
    q2 = (rh + rl) / bh
    q1, q2 = _two_sum(q1, q2)
    ph, pl = _dd_mul(q1, q2, bh, bl)
    rh, rl = _dd_sub(ah, al, ph, pl)
    q3 = (rh + rl) / bh
    qh, ql = _two_sum(q1, q2)
    return _dd_add(qh, ql, q3, 0.0)


@dataclass(frozen=True)
class WeightedMomentState:
    """Immutable weighted moment state ``(W, mu, M2)``."""

    total_volume: float
    vwap: float
    m2: float
    variance_source: VarianceSource = "PEBAY_EXACT_1M"

    def __post_init__(self) -> None:
        if self.variance_source not in ("PEBAY_EXACT_1M", "RANGE_PARKINSON_FALLBACK"):
            raise ValueError(f"Unsupported variance_source: {self.variance_source!r}")
        if not math.isfinite(self.total_volume) or self.total_volume < 0.0:
            raise ValueError(f"total_volume must be finite >= 0, got {self.total_volume!r}")
        if self.total_volume == 0.0:
            if not math.isnan(self.vwap):
                raise ValueError(
                    f"Neutral state (W=0) must keep vwap=NaN, never {self.vwap!r}"
                )
            if not math.isfinite(self.m2) or self.m2 != 0.0:
                raise ValueError(f"Neutral state (W=0) requires m2=0.0, got {self.m2!r}")
            return
        if not math.isfinite(self.vwap) or self.vwap <= 0.0:
            raise ValueError(f"vwap must be finite > 0 when W > 0, got {self.vwap!r}")
        if not math.isfinite(self.m2):
            raise ValueError(f"m2 must be finite when W > 0, got {self.m2!r}")
        neg_tol = 1e-12 * max(1.0, self.total_volume * self.vwap * self.vwap)
        if self.m2 < -neg_tol:
            raise ValueError(f"Materially negative m2={self.m2!r} invalid for W={self.total_volume!r}")
        if self.m2 < 0.0:
            object.__setattr__(self, "m2", 0.0)

    @classmethod
    def neutral(cls, variance_source: VarianceSource = "PEBAY_EXACT_1M") -> WeightedMomentState:
        return cls(total_volume=0.0, vwap=math.nan, m2=0.0, variance_source=variance_source)

    @property
    def std_dev(self) -> float:
        if self.total_volume == 0.0:
            return math.nan
        return math.sqrt(max(0.0, self.m2 / self.total_volume))


def merge_moments(a: WeightedMomentState, b: WeightedMomentState) -> WeightedMomentState:
    """Parallel Chan/Golub/LeVeque-Pebay weighted moment merge."""
    source: VarianceSource = (
        "RANGE_PARKINSON_FALLBACK"
        if "RANGE_PARKINSON_FALLBACK" in (a.variance_source, b.variance_source)
        else "PEBAY_EXACT_1M"
    )
    if a.total_volume == 0.0 and b.total_volume == 0.0:
        return WeightedMomentState.neutral(variance_source=source)
    if a.total_volume == 0.0:
        return WeightedMomentState(
            total_volume=b.total_volume,
            vwap=b.vwap,
            m2=b.m2,
            variance_source=source,
        )
    if b.total_volume == 0.0:
        return WeightedMomentState(
            total_volume=a.total_volume,
            vwap=a.vwap,
            m2=a.m2,
            variance_source=source,
        )

    wa, wb = a.total_volume, b.total_volume
    w_ab = wa + wb
    delta = b.vwap - a.vwap
    if wa >= wb:
        mu_ab = a.vwap + delta * (wb / w_ab)
        cross = wa * (wb / w_ab)
    else:
        mu_ab = b.vwap - delta * (wa / w_ab)
        cross = wb * (wa / w_ab)

    m2_ab = a.m2 + b.m2 + (delta * delta) * cross
    neg_tol = 1e-12 * max(1.0, w_ab * mu_ab * mu_ab)
    if m2_ab < -neg_tol:
        raise ValueError(f"Merged m2 materially negative: {m2_ab}")
    if m2_ab < 0.0:
        m2_ab = 0.0

    return WeightedMomentState(
        total_volume=w_ab,
        vwap=mu_ab,
        m2=m2_ab,
        variance_source=source,
    )


@dataclass(frozen=True)
class CanonicalCoverageReport:
    total_input_rows: int
    accepted_rth_1m_rows: int
    excluded_non_rth: int
    excluded_non_positive_volume: int
    excluded_invalid_vw: int
    excluded_invalid_ohlc: int
    output_buckets: int


def _validate_1m_schema_and_uniqueness(df_1m: pl.DataFrame) -> None:
    required = {"ticker", "ts_utc_s", "o", "h", "l", "c", "volume", "vw"}
    missing = sorted(required - set(df_1m.columns))
    if missing:
        raise ValueError(f"Missing required 1m columns: {missing}")
    if df_1m.height == 0:
        return

    if df_1m["ticker"].null_count() > 0 or df_1m.filter(pl.col("ticker").cast(pl.String).str.strip_chars() == "").height > 0:
        raise ValueError("Ticker column contains null or empty values")

    dups = (
        df_1m.group_by(["ticker", "ts_utc_s"])
        .len()
        .filter(pl.col("len") > 1)
    )
    if dups.height > 0:
        raise ValueError(f"Conflicting/duplicate (ticker, ts_utc_s) rows detected: {dups.height}")

    # Enforce strict chronological ordering per ticker.
    diffs = (
        df_1m.select(
            "ticker",
            (pl.col("ts_utc_s") - pl.col("ts_utc_s").shift(1).over("ticker")).alias("dt_s"),
        )
        .filter(pl.col("dt_s").is_not_null() & (pl.col("dt_s") <= 0))
    )
    if diffs.height > 0:
        raise ValueError("Input 1m bars must be strictly chronologically ordered per ticker")


def _bucket_moments_high_precision(vols: list[float], vws: list[float]) -> tuple[float, float, float]:
    """Two-pass shifted-origin exact float64 summation using math.fsum."""
    w = math.fsum(vols)
    p0 = vws[0]
    deltas = [p - p0 for p in vws]
    mu_shift = math.fsum(v * d for v, d in zip(vols, deltas)) / w
    mu = p0 + mu_shift
    # Refine residual mean shift to reduce 1-ULP error even when p0 is far from mu.
    res = [p - mu for p in vws]
    corr = math.fsum(v * r for v, r in zip(vols, res)) / w
    mu = mu + corr
    res2 = [p - mu for p in vws]
    m2 = math.fsum(v * r * r for v, r in zip(vols, res2))
    return w, mu, max(0.0, m2)


def build_canonical_rth_bars_with_audit(
    df_1m: pl.DataFrame,
    timeframe: str,
) -> tuple[pl.DataFrame, CanonicalCoverageReport]:
    """Build session-anchored canonical RTH rollup bars and return coverage audit."""
    tf_min = validate_timeframe(timeframe)
    _validate_1m_schema_and_uniqueness(df_1m)

    empty_out = pl.DataFrame(
        schema={
            "ticker": pl.String,
            "trade_date": pl.String,
            "bucket_id": pl.Int32,
            "ts_open_utc_s": pl.Int64,
            "o": pl.Float64,
            "h": pl.Float64,
            "l": pl.Float64,
            "c": pl.Float64,
            "W": pl.Float64,
            "mu": pl.Float64,
            "M2_within": pl.Float64,
            "bar_count": pl.Int32,
        }
    )
    if df_1m.height == 0:
        return empty_out, CanonicalCoverageReport(0, 0, 0, 0, 0, 0, 0)

    classified = classify_1m_bars_polars(df_1m, ts_col="ts_utc_s", timeframe=timeframe)
    total_rows = classified.height

    rth_df = classified.filter(pl.col("is_rth"))
    excluded_non_rth = total_rows - rth_df.height

    vol_ok = rth_df.filter(
        pl.col("volume").is_not_null()
        & pl.col("volume").cast(pl.Float64).is_finite()
        & (pl.col("volume").cast(pl.Float64) > 0.0)
    )
    excluded_non_positive_volume = rth_df.height - vol_ok.height

    # Never synthesize invalid vw with HLC3 on the canonical exact path; exclude & report.
    vw_ok = vol_ok.filter(
        pl.col("vw").is_not_null()
        & pl.col("vw").cast(pl.Float64).is_finite()
        & (pl.col("vw").cast(pl.Float64) > 0.0)
    )
    excluded_invalid_vw = vol_ok.height - vw_ok.height

    ohlc_ok = vw_ok.filter(
        pl.col("o").cast(pl.Float64).is_finite()
        & pl.col("h").cast(pl.Float64).is_finite()
        & pl.col("l").cast(pl.Float64).is_finite()
        & pl.col("c").cast(pl.Float64).is_finite()
        & (pl.col("o").cast(pl.Float64) > 0.0)
        & (pl.col("h").cast(pl.Float64) > 0.0)
        & (pl.col("l").cast(pl.Float64) > 0.0)
        & (pl.col("c").cast(pl.Float64) > 0.0)
        & (pl.col("h").cast(pl.Float64) >= pl.col("l").cast(pl.Float64))
        & (pl.col("o").cast(pl.Float64) >= pl.col("l").cast(pl.Float64))
        & (pl.col("o").cast(pl.Float64) <= pl.col("h").cast(pl.Float64))
        & (pl.col("c").cast(pl.Float64) >= pl.col("l").cast(pl.Float64))
        & (pl.col("c").cast(pl.Float64) <= pl.col("h").cast(pl.Float64))
    )
    excluded_invalid_ohlc = vw_ok.height - ohlc_ok.height

    if ohlc_ok.height == 0:
        return empty_out, CanonicalCoverageReport(
            total_input_rows=total_rows,
            accepted_rth_1m_rows=0,
            excluded_non_rth=excluded_non_rth,
            excluded_non_positive_volume=excluded_non_positive_volume,
            excluded_invalid_vw=excluded_invalid_vw,
            excluded_invalid_ohlc=excluded_invalid_ohlc,
            output_buckets=0,
        )

    ordered = ohlc_ok.sort(["ticker", "ts_utc_s"])
    grouped = ordered.group_by(["ticker", "trade_date", "bucket_id"], maintain_order=True).agg(
        pl.col("bucket_open_utc_s").first().alias("ts_open_utc_s"),
        pl.col("o").cast(pl.Float64).first().alias("o"),
        pl.col("h").cast(pl.Float64).max().alias("h"),
        pl.col("l").cast(pl.Float64).min().alias("l"),
        pl.col("c").cast(pl.Float64).last().alias("c"),
        pl.col("volume").cast(pl.Float64).alias("_vols"),
        pl.col("vw").cast(pl.Float64).alias("_vws"),
        pl.len().cast(pl.Int32).alias("bar_count"),
    )

    out_rows: list[dict[str, Any]] = []
    for row in grouped.iter_rows(named=True):
        w_val, mu_val, m2_val = _bucket_moments_high_precision(row["_vols"], row["_vws"])
        out_rows.append(
            {
                "ticker": row["ticker"],
                "trade_date": row["trade_date"],
                "bucket_id": row["bucket_id"],
                "ts_open_utc_s": row["ts_open_utc_s"],
                "o": row["o"],
                "h": row["h"],
                "l": row["l"],
                "c": row["c"],
                "W": w_val,
                "mu": mu_val,
                "M2_within": m2_val,
                "bar_count": row["bar_count"],
            }
        )

    out_df = pl.DataFrame(out_rows, schema=empty_out.schema).sort(
        ["ticker", "trade_date", "bucket_id"]
    )
    report = CanonicalCoverageReport(
        total_input_rows=total_rows,
        accepted_rth_1m_rows=ohlc_ok.height,
        excluded_non_rth=excluded_non_rth,
        excluded_non_positive_volume=excluded_non_positive_volume,
        excluded_invalid_vw=excluded_invalid_vw,
        excluded_invalid_ohlc=excluded_invalid_ohlc,
        output_buckets=out_df.height,
    )
    return out_df, report


def build_canonical_rth_bars(df_1m: pl.DataFrame, timeframe: str) -> pl.DataFrame:
    """Build session-anchored canonical RTH rollup bars for ``timeframe``."""
    out_df, _ = build_canonical_rth_bars_with_audit(df_1m, timeframe)
    return out_df


def compute_exact_avwap_from_anchor(
    W: np.ndarray | list[float],
    mu: np.ndarray | list[float],
    M2_within: np.ndarray | list[float],
    anchor_idx: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Incremental O(N) exact AVWAP from ``anchor_idx`` via compensated double-double Pebay.

    Returns ``(avwap_mu, avwap_sd, cum_W, cum_M2)``. Positions strictly prior to
    ``anchor_idx`` carry ``NaN`` (zero pre-anchor contamination).
    """
    w_arr = np.asarray(W, dtype=np.float64)
    mu_arr = np.asarray(mu, dtype=np.float64)
    m2_arr = np.asarray(M2_within, dtype=np.float64)

    if w_arr.ndim != 1 or mu_arr.shape != w_arr.shape or m2_arr.shape != w_arr.shape:
        raise ValueError("W, mu, and M2_within must be 1-D arrays of identical length")
    n = int(w_arr.shape[0])
    if n == 0:
        empty = np.empty(0, dtype=np.float64)
        return empty, empty.copy(), empty.copy(), empty.copy()
    if not isinstance(anchor_idx, int) or isinstance(anchor_idx, bool) or anchor_idx < 0 or anchor_idx >= n:
        raise ValueError(f"Invalid anchor_idx={anchor_idx} for array of length {n}")

    out_mu = np.full(n, np.nan, dtype=np.float64)
    out_sd = np.full(n, np.nan, dtype=np.float64)
    out_w = np.full(n, np.nan, dtype=np.float64)
    out_m2 = np.full(n, np.nan, dtype=np.float64)

    # Double-double accumulators (hi, lo) for O(1)-per-step compensated Pebay fusion.
    cw_h, cw_l = 0.0, 0.0
    cmu_h, cmu_l = 0.0, 0.0
    cm2_h, cm2_l = 0.0, 0.0

    for i in range(anchor_idx, n):
        wi = float(w_arr[i])
        mui = float(mu_arr[i])
        m2i = float(m2_arr[i])
        if not math.isfinite(wi) or wi < 0.0:
            raise ValueError(f"Invalid W[{i}]={wi!r}")
        if wi == 0.0:
            if cw_h > 0.0:
                out_w[i] = cw_h + cw_l
                out_mu[i] = cmu_h + cmu_l
                out_m2[i] = max(0.0, cm2_h + cm2_l)
                var_h, var_l = _dd_div(max(0.0, cm2_h), cm2_l if cm2_h >= 0.0 else 0.0, cw_h, cw_l)
                out_sd[i] = math.sqrt(max(0.0, var_h + var_l))
            continue

        if not (math.isfinite(mui) and mui > 0.0):
            raise ValueError(f"Invalid mu[{i}]={mui!r} for positive volume")
        if not (math.isfinite(m2i) and m2i >= 0.0):
            raise ValueError(f"Invalid M2_within[{i}]={m2i!r}")

        if cw_h == 0.0:
            cw_h, cw_l = wi, 0.0
            cmu_h, cmu_l = mui, 0.0
            cm2_h, cm2_l = m2i, 0.0
        else:
            nw_h, nw_l = _dd_add(cw_h, cw_l, wi, 0.0)
            dh, dl = _dd_sub(mui, 0.0, cmu_h, cmu_l)
            ratio_h, ratio_l = _dd_div(wi, 0.0, nw_h, nw_l)
            step_h, step_l = _dd_mul(dh, dl, ratio_h, ratio_l)
            nmu_h, nmu_l = _dd_add(cmu_h, cmu_l, step_h, step_l)

            d2_h, d2_l = _dd_mul(dh, dl, dh, dl)
            cross_h, cross_l = _dd_mul(cw_h, cw_l, ratio_h, ratio_l)
            between_h, between_l = _dd_mul(d2_h, d2_l, cross_h, cross_l)

            sum_m2_h, sum_m2_l = _dd_add(cm2_h, cm2_l, m2i, 0.0)
            nm2_h, nm2_l = _dd_add(sum_m2_h, sum_m2_l, between_h, between_l)

            cw_h, cw_l = nw_h, nw_l
            cmu_h, cmu_l = nmu_h, nmu_l
            cm2_h, cm2_l = nm2_h, nm2_l

        w_out = cw_h + cw_l
        mu_out = cmu_h + cmu_l
        m2_total = cm2_h + cm2_l
        neg_tol = 1e-12 * max(1.0, w_out * mu_out * mu_out)
        if m2_total < -neg_tol:
            raise ValueError(f"Cumulative M2 materially negative at idx={i}: {m2_total}")
        if m2_total < 0.0:
            cm2_h, cm2_l = 0.0, 0.0
            m2_total = 0.0

        var_h, var_l = _dd_div(cm2_h, cm2_l, cw_h, cw_l)
        out_w[i] = w_out
        out_mu[i] = mu_out
        out_m2[i] = m2_total
        out_sd[i] = math.sqrt(max(0.0, var_h + var_l))

    return out_mu, out_sd, out_w, out_m2


# ---------------------------------------------------------------------------
# Section 5: Parkinson intrabar fallback and ORATS hybrid bands
# ---------------------------------------------------------------------------

def estimate_parkinson_m2_within(
    W: float,
    mu: float,
    high: float,
    low: float,
) -> float:
    """Estimate intrabar M2 via Parkinson range under Brownian-path assumptions.

    Uses ``M2_within_est = W * mu^2 * ln(high / low)^2 / (24 * ln(2))``.
    The ``1/6`` multiplier reflects uniform time dispersion along a Brownian
    path, NOT a universal traded-volume identity.
    """
    if not (math.isfinite(W) and W >= 0.0):
        raise ValueError(f"W must be finite >= 0, got {W!r}")
    if not (math.isfinite(mu) and mu > 0.0):
        raise ValueError(f"mu must be finite > 0, got {mu!r}")
    if not (math.isfinite(high) and math.isfinite(low) and low > 0.0 and high >= low):
        raise ValueError(f"Expected finite high >= low > 0, got high={high!r}, low={low!r}")
    if W == 0.0 or high == low:
        return 0.0
    log_hl = math.log(high / low)
    return W * (mu * mu) * (log_hl * log_hl) / (24.0 * math.log(2.0))


def parkinson_moment_state(
    W: float,
    mu: float,
    high: float,
    low: float,
) -> WeightedMomentState:
    """Construct a ``WeightedMomentState`` explicitly tagged ``RANGE_PARKINSON_FALLBACK``."""
    if W == 0.0:
        return WeightedMomentState.neutral(variance_source="RANGE_PARKINSON_FALLBACK")
    m2_est = estimate_parkinson_m2_within(W, mu, high, low)
    return WeightedMomentState(
        total_volume=W,
        vwap=mu,
        m2=m2_est,
        variance_source="RANGE_PARKINSON_FALLBACK",
    )


@dataclass(frozen=True)
class HybridBandsResult:
    avwap_mu: float
    sigma_hybrid: float
    sigma_orats_path: float
    welford_sd: float
    alpha: float
    band_source: Literal["HYBRID_ORATS_WELFORD", "WELFORD_ONLY_FALLBACK"]
    upper_1: float
    lower_1: float
    upper_2: float
    lower_2: float
    upper_2_5: float
    lower_2_5: float


def compute_hybrid_bands(
    avwap_mu: float,
    welford_sd: float,
    or_iv_xern_20d_dec: float | None,
    elapsed_trading_days: float,
    tau0: float = 2.0,
) -> HybridBandsResult:
    """Compute ORATS-blended dispersion bands with clean fallback to ``welford_sd``.

    Note: ``welford_sd`` measures historical volume-weighted price dispersion
    since anchor, whereas ``or_iv_xern_20d_dec`` is annualized forward implied
    volatility; blending them yields a research band model requiring out-of-sample
    empirical calibration.
    """
    if not (math.isfinite(avwap_mu) and avwap_mu > 0.0):
        raise ValueError(f"avwap_mu must be finite > 0, got {avwap_mu!r}")
    if not (math.isfinite(welford_sd) and welford_sd >= 0.0):
        raise ValueError(f"welford_sd must be finite >= 0, got {welford_sd!r}")
    if not (math.isfinite(elapsed_trading_days) and elapsed_trading_days >= 0.0):
        raise ValueError(f"elapsed_trading_days must be finite >= 0, got {elapsed_trading_days!r}")
    if not (math.isfinite(tau0) and tau0 > 0.0):
        raise ValueError(f"tau0 must be finite > 0, got {tau0!r}")

    if or_iv_xern_20d_dec is None or not math.isfinite(or_iv_xern_20d_dec):
        sigma_orats = math.nan
        alpha = 0.0
        sigma_hybrid = welford_sd
        source: Literal["HYBRID_ORATS_WELFORD", "WELFORD_ONLY_FALLBACK"] = "WELFORD_ONLY_FALLBACK"
    else:
        if or_iv_xern_20d_dec < 0.0:
            raise ValueError(f"or_iv_xern_20d_dec must be >= 0, got {or_iv_xern_20d_dec!r}")
        sigma_orats = (
            avwap_mu
            * (or_iv_xern_20d_dec / math.sqrt(252.0))
            * math.sqrt(elapsed_trading_days / 6.0)
        )
        alpha = math.exp(-elapsed_trading_days / tau0)
        sigma_hybrid = math.sqrt(
            alpha * (sigma_orats * sigma_orats) + (1.0 - alpha) * (welford_sd * welford_sd)
        )
        source = "HYBRID_ORATS_WELFORD"

    return HybridBandsResult(
        avwap_mu=avwap_mu,
        sigma_hybrid=sigma_hybrid,
        sigma_orats_path=sigma_orats,
        welford_sd=welford_sd,
        alpha=alpha,
        band_source=source,
        upper_1=avwap_mu + sigma_hybrid,
        lower_1=avwap_mu - sigma_hybrid,
        upper_2=avwap_mu + 2.0 * sigma_hybrid,
        lower_2=avwap_mu - 2.0 * sigma_hybrid,
        upper_2_5=avwap_mu + 2.5 * sigma_hybrid,
        lower_2_5=avwap_mu - 2.5 * sigma_hybrid,
    )
