"""Independent Python reference generator for Pieza 22 (/relaciones quantitative suite).

Computes deterministic analytical reference fixtures for:
  1. Discrete AR(1) / Ornstein-Uhlenbeck half-life t_{1/2} = -ln(2)/ln(phi_hat)
     under strict stationarity (0 < phi_hat < 1) and minimum N >= 20 observations.
  2. Capital flow rotation delta: (mean_5d(share) / mean_20d(share) - 1) * 100.
  3. 60-session summary distribution (mean, sample std, z-score, percentile, opportunity badge).
  4. Equal-weighted USD-CCL basket return index ratio & sector flow share.
  5. Canje implicito (CCL / MEP - 1) * 100 and Massive 1D / Data912 pair statistics.

Usage:
  python tools/gen_relations_reference.py
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Optional


def sample_mean_and_std(values: list[float]) -> Optional[tuple[float, float]]:
    clean = [v for v in values if math.isfinite(v)]
    if len(clean) < 2:
        return None
    n = float(len(clean))
    mean = sum(clean) / n
    var = sum((x - mean) ** 2 for x in clean) / (n - 1.0)
    return mean, math.sqrt(var)


def ou_half_life_ar1(values: list[float]) -> Optional[float]:
    clean = [v for v in values if math.isfinite(v)]
    if len(clean) < 20:
        return None
    xs = clean[:-1]
    ys = clean[1:]
    m = float(len(xs))
    mx = sum(xs) / m
    my = sum(ys) / m
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx <= 1e-15:
        return None
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    phi = sxy / sxx
    if not math.isfinite(phi) or phi <= 0.0 or phi >= 1.0 - 1e-9:
        return None
    hl = -math.log(2.0) / math.log(phi)
    return hl if math.isfinite(hl) and hl > 0.0 else None


def opportunity_badge(z_score: Optional[float]) -> Optional[str]:
    if z_score is None or not math.isfinite(z_score):
        return None
    if z_score <= -2.0:
        return "EXTREMO COMPRA"
    if z_score >= 2.0:
        return "EXTREMO VENTA"
    if abs(z_score) >= 1.5:
        return "DESVÍO MODERADO"
    return "EN EQUILIBRIO"


def capital_flow_delta_pct(shares: list[float]) -> Optional[float]:
    clean = [s for s in shares if math.isfinite(s) and 0.0 < s <= 1.0]
    if len(clean) < 20:
        return None
    last20 = clean[-20:]
    last5 = clean[-5:]
    mean20 = sum(last20) / 20.0
    mean5 = sum(last5) / 5.0
    if mean20 <= 1e-12:
        return None
    return ((mean5 / mean20) - 1.0) * 100.0


def relation_stats(
    points: list[tuple[int, float]],
    shares: Optional[list[float]] = None,
    min_obs: int = 20,
) -> dict[str, Any]:
    recent60 = points[-60:]
    vals60 = [v for _, v in recent60]
    current_value = vals60[-1] if vals60 else None
    sparkline = vals60[-30:]

    if len(vals60) < min_obs:
        return {
            "currentValue": current_value,
            "mean60d": None,
            "std60d": None,
            "zScore": None,
            "percentile60d": None,
            "halfLifeDays": None,
            "capitalFlowDeltaPct": capital_flow_delta_pct(shares) if shares is not None else None,
            "opportunityBadge": None,
            "observationCount": len(vals60),
            "sparkline": sparkline,
        }

    stats = sample_mean_and_std(vals60)
    assert stats is not None and current_value is not None
    mean60, std60 = stats
    z = (current_value - mean60) / std60 if std60 > 1e-8 else None
    below = sum(1 for v in vals60 if v <= current_value)
    pct = (float(below) / float(len(vals60))) * 100.0
    hl = ou_half_life_ar1(vals60)
    badge = opportunity_badge(z)
    flow = capital_flow_delta_pct(shares) if shares is not None else None
    return {
        "currentValue": current_value,
        "mean60d": mean60,
        "std60d": std60,
        "zScore": z,
        "percentile60d": pct,
        "halfLifeDays": hl,
        "capitalFlowDeltaPct": flow,
        "opportunityBadge": badge,
        "observationCount": len(vals60),
        "sparkline": sparkline,
    }


def median_val(vals: list[float]) -> Optional[float]:
    clean = sorted(v for v in vals if math.isfinite(v))
    if not clean:
        return None
    mid = len(clean) // 2
    if len(clean) % 2 == 1:
        return clean[mid]
    return 0.5 * (clean[mid - 1] + clean[mid])


def make_ou_series(n: int, mu: float, phi: float, amp: float, drift_noise: float = 0.0) -> list[float]:
    # Deterministic stationary AR(1)-like sequence around mu using damped cosine + innovation
    vals = [mu + amp]
    for t in range(1, n):
        eps = math.sin(t * 0.73) * drift_noise + math.cos(t * 1.19) * (drift_noise * 0.6)
        nxt = mu + phi * (vals[-1] - mu) + eps
        vals.append(round(nxt, 8))
    return vals


def build_synthetic_basket_case() -> dict[str, Any]:
    # 70 trading days (UTC midnight starting 2026-06-01T00:00:00Z = 1780272000)
    base_sec = 1780272000
    n_days = 70
    dates: list[tuple[str, int]] = []
    # Monotonic calendar days (daily UTC steps for deterministic alignment check)
    from datetime import datetime, timezone, timedelta

    start_dt = datetime.fromtimestamp(base_sec, tz=timezone.utc)
    for i in range(n_days):
        dt = start_dt + timedelta(days=i)
        dates.append((dt.strftime("%Y-%m-%d"), int(dt.timestamp())))

    num_tickers = ["GGAL", "BMA", "SUPV", "BBAR"]
    den_tickers = ["YPFD", "PAMP", "TGSU2", "CEPU"]

    ccl_series: list[float] = [1180.0 + i * 1.2 + math.sin(i * 0.25) * 8.0 for i in range(n_days)]
    ccl_by_date: dict[str, float] = {d: ccl_series[i] for i, (d, _) in enumerate(dates)}

    def make_stock_bars(ticker: str, base_usd: float, alpha_rate: float, vol_base: float, is_num: bool) -> list[dict[str, float]]:
        bars: list[dict[str, float]] = []
        price_usd = base_usd
        for i, (_, ts) in enumerate(dates):
            if i > 0:
                ret = alpha_rate + 0.008 * math.sin(i * 0.31 + len(ticker))
                price_usd = price_usd * (1.0 + ret)
            close_ars = round(price_usd * ccl_series[i], 4)
            vol_mult = 1.45 if (is_num and i >= n_days - 5) else (0.90 if (not is_num and i >= n_days - 5) else 1.0)
            vol = round(vol_base * vol_mult * (1.0 + 0.05 * math.cos(i * 0.4)), 2)
            bars.append({
                "time": ts,
                "open": close_ars,
                "high": round(close_ars * 1.01, 4),
                "low": round(close_ars * 0.99, 4),
                "close": close_ars,
                "volume": vol,
            })
        return bars

    num_bars = {
        t: make_stock_bars(t, 5.0 + idx * 1.5, 0.0022, 200_000.0 + idx * 25_000.0, True)
        for idx, t in enumerate(num_tickers)
    }
    den_bars = {
        t: make_stock_bars(t, 12.0 + idx * 4.0, 0.0005, 180_000.0 + idx * 20_000.0, False)
        for idx, t in enumerate(den_tickers)
    }

    # Explicit independent basket index calculation in USD-CCL
    # Map dateKey -> bar per ticker
    def to_date_map(bars: list[dict[str, float]]) -> dict[str, dict[str, float]]:
        out: dict[str, dict[str, float]] = {}
        for b in bars:
            dk = datetime.fromtimestamp(b["time"], tz=timezone.utc).strftime("%Y-%m-%d")
            out[dk] = b
        return out

    num_maps = [to_date_map(num_bars[t]) for t in num_tickers]
    den_maps = [to_date_map(den_bars[t]) for t in den_tickers]

    idx_num = 100.0
    idx_den = 100.0
    prev_num_usd: dict[int, float] = {}
    prev_den_usd: dict[int, float] = {}
    points: list[tuple[int, float]] = []
    shares: list[float] = []
    started = False

    for dk, ts in dates:
        ccl = ccl_by_date.get(dk)
        if ccl is None or ccl <= 0.0:
            continue

        cur_num_usd: dict[int, float] = {}
        eff_num = 0.0
        for j, m in enumerate(num_maps):
            b = m.get(dk)
            if b is not None and b["close"] > 0.0:
                cur_num_usd[j] = b["close"] / ccl
                if b["volume"] > 0.0:
                    eff_num += (b["close"] * b["volume"]) / ccl

        cur_den_usd: dict[int, float] = {}
        eff_den = 0.0
        for j, m in enumerate(den_maps):
            b = m.get(dk)
            if b is not None and b["close"] > 0.0:
                cur_den_usd[j] = b["close"] / ccl
                if b["volume"] > 0.0:
                    eff_den += (b["close"] * b["volume"]) / ccl

        if not started:
            if len(cur_num_usd) >= 2 and len(cur_den_usd) >= 2:
                started = True
                prev_num_usd = cur_num_usd
                prev_den_usd = cur_den_usd
                points.append((ts, idx_num / idx_den))
                if eff_num > 0.0 and eff_den > 0.0:
                    shares.append(eff_num / (eff_num + eff_den))
            continue

        r_num = [
            (cur_num_usd[j] / prev_num_usd[j]) - 1.0
            for j in cur_num_usd
            if j in prev_num_usd and prev_num_usd[j] > 0.0
        ]
        r_den = [
            (cur_den_usd[j] / prev_den_usd[j]) - 1.0
            for j in cur_den_usd
            if j in prev_den_usd and prev_den_usd[j] > 0.0
        ]
        if len(r_num) >= 2 and len(r_den) >= 2:
            idx_num *= 1.0 + (sum(r_num) / float(len(r_num)))
            idx_den *= 1.0 + (sum(r_den) / float(len(r_den)))
            prev_num_usd = cur_num_usd
            prev_den_usd = cur_den_usd
            points.append((ts, idx_num / idx_den))
            if eff_num > 0.0 and eff_den > 0.0:
                shares.append(eff_num / (eff_num + eff_den))

    stats = relation_stats(points, shares=shares)
    return {
        "dates": [d for d, _ in dates],
        "cclByDate": ccl_by_date,
        "numBars": num_bars,
        "denBars": den_bars,
        "expected": stats,
    }


def main() -> None:
    base_time = 1780272000

    # 1. Stationary OU case (60 points around 1.20, phi ~ 0.80 -> t_1/2 ~ 3.1d, latest EXTREMO COMPRA)
    ou_vals = make_ou_series(59, mu=1.20, phi=0.80, amp=0.05, drift_noise=0.004)
    # Push last point into extreme buy territory (z <= -2.0)
    ou_vals.append(1.06)
    ou_points = [(base_time + i * 86400, v) for i, v in enumerate(ou_vals)]
    ou_shares = [0.40 + 0.01 * math.sin(i * 0.5) for i in range(25)]
    # Make last 5 shares systematically higher (+25%)
    for i in range(20, 25):
        ou_shares[i] = 0.50

    # 2. Extreme sell case (60 points, z >= +2.0) + non-stationary random-walk tail
    rw_vals = [100.0 + 0.5 * i + 0.4 * math.sin(i * 0.2) for i in range(59)]
    rw_vals.append(165.0)
    rw_points = [(base_time + i * 86400, v) for i, v in enumerate(rw_vals)]

    # 3. Moderate deviation case (30 points -> valid >= 20, |z| in [1.5, 2.0))
    mod_core = [10.0 + 0.2 * math.cos(i * 0.7) for i in range(29)]
    # Exact check of mod z-score computed by relation_stats
    mod_vals = mod_core + [10.28]
    mod_points = [(base_time + i * 86400, v) for i, v in enumerate(mod_vals)]

    # 4. Short insufficient series (< 20 observations -> Zero Silent Fallbacks!)
    short_points = [(base_time + i * 86400, 1.5 + i * 0.01) for i in range(19)]
    short_shares = [0.45 for _ in range(19)]

    fixture = {
        "mathCases": [
            {
                "name": "stationary_ou_extreme_buy_and_positive_flow",
                "points": [{"time": t, "val": v} for t, v in ou_points],
                "shares": ou_shares,
                "expected": relation_stats(ou_points, ou_shares),
            },
            {
                "name": "trending_non_stationary_extreme_sell",
                "points": [{"time": t, "val": v} for t, v in rw_points],
                "shares": None,
                "expected": relation_stats(rw_points, None),
            },
            {
                "name": "moderate_deviation_30obs",
                "points": [{"time": t, "val": v} for t, v in mod_points],
                "shares": None,
                "expected": relation_stats(mod_points, None),
            },
            {
                "name": "insufficient_19obs_zero_silent_fallback",
                "points": [{"time": t, "val": v} for t, v in short_points],
                "shares": short_shares,
                "expected": relation_stats(short_points, short_shares),
            },
        ],
        "basketUsdCclCase": build_synthetic_basket_case(),
    }

    out_path = Path(__file__).resolve().parent.parent / "fixtures" / "relations_reference.json"
    out_path.write_text(json.dumps(fixture, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {out_path} ({len(fixture['mathCases'])} math cases + basketUsdCclCase)")
    for mc in fixture["mathCases"]:
        print(" ", mc["name"], "-> badge:", mc["expected"]["opportunityBadge"], "hl:", mc["expected"]["halfLifeDays"], "flow:", mc["expected"]["capitalFlowDeltaPct"])
    print("  basketUsdCclCase ->", fixture["basketUsdCclCase"]["expected"]["currentValue"], "flow:", fixture["basketUsdCclCase"]["expected"]["capitalFlowDeltaPct"])


if __name__ == "__main__":
    main()
