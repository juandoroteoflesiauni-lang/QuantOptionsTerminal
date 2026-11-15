#!/usr/bin/env python3
"""
Referencia independiente en Python para validar el motor matemático de
`web/src/components/stock-detail/stockDetailMath.ts` (Stock Detail unificado AR/US).

Genera `fixtures/stock_detail_reference.json` con vectores deterministas calculados
de forma explícita (sin copiar implementación TS) usando `math`, `statistics` y `datetime`.
"""

from __future__ import annotations

import datetime as dt
import json
import math
import statistics
from pathlib import Path
from typing import Any


def to_json_val(v: float) -> float | None:
    return None if not math.isfinite(v) else v


def ema_series_py(closes: list[float], period: int) -> list[float | None]:
    n = len(closes)
    out: list[float | None] = [None] * n
    if n < period or period <= 0:
        return out
    seed = statistics.fmean(closes[:period])
    out[period - 1] = seed
    alpha = 2.0 / (period + 1.0)
    prev = seed
    for i in range(period, n):
        curr = alpha * closes[i] + (1.0 - alpha) * prev
        out[i] = curr
        prev = curr
    return out


def wilder_atr_py(bars: list[dict[str, Any]], period: int) -> list[float | None]:
    n = len(bars)
    out: list[float | None] = [None] * n
    if n < period + 1:
        return out
    trs = [math.nan] * n
    for i in range(1, n):
        hi = float(bars[i]["high"])
        lo = float(bars[i]["low"])
        pc = float(bars[i - 1]["close"])
        trs[i] = max(hi - lo, abs(hi - pc), abs(lo - pc))
    first_atr = statistics.fmean(trs[1 : period + 1])
    out[period] = first_atr
    prev = first_atr
    for i in range(period + 1, n):
        curr = (prev * (period - 1) + trs[i]) / period
        out[i] = curr
        prev = curr
    return out


def session_vwap_py(bars: list[dict[str, Any]], is_intraday: bool, tz_offset_sec: int = 0) -> list[float | None]:
    if not is_intraday:
        return [None] * len(bars)
    out: list[float | None] = []
    cur_day = None
    pv_sum = 0.0
    v_sum = 0.0
    for b in bars:
        day_id = math.floor((b["time"] + tz_offset_sec) / 86400.0)
        if cur_day is None or day_id != cur_day:
            cur_day = day_id
            pv_sum = 0.0
            v_sum = 0.0
        vw = b.get("vw")
        tp = float(vw) if (vw is not None and vw > 0) else (b["high"] + b["low"] + b["close"]) / 3.0
        vol = float(b["volume"])
        if vol > 0:
            pv_sum += tp * vol
            v_sum += vol
        out.append(pv_sum / v_sum if v_sum > 0 else None)
    return out


def third_friday_utc_sec_py(year: int, month_1_based: int) -> int:
    d = dt.datetime(year, month_1_based, 1, 0, 0, 0, tzinfo=dt.timezone.utc)
    # Python weekday(): Monday=0 .. Friday=4
    days_until_fri = (4 - d.weekday()) % 7
    third_fri = d + dt.timedelta(days=days_until_fri + 14)
    return int(third_fri.timestamp())


def anchored_vwap_py(bars: list[dict[str, Any]], anchor_idx: int) -> list[float | None]:
    n = len(bars)
    out: list[float | None] = [None] * n
    if anchor_idx < 0 or anchor_idx >= n:
        return out
    pv = 0.0
    vv = 0.0
    for i in range(anchor_idx, n):
        b = bars[i]
        vw = b.get("vw")
        tp = float(vw) if (vw is not None and vw > 0) else (b["high"] + b["low"] + b["close"]) / 3.0
        vol = float(b["volume"])
        if vol > 0:
            pv += tp * vol
            vv += vol
        out[i] = pv / vv if vv > 0 else None
    return out


def lee_ready_bar_flow_py(bars: list[dict[str, Any]]) -> list[dict[str, float | None]]:
    out: list[dict[str, float | None]] = []
    cvd = 0.0
    cum_buy = 0.0
    cum_sell = 0.0
    tot_vol = 0.0
    for idx, b in enumerate(bars):
        rng = b["high"] - b["low"]
        if rng > 0:
            clv = max(-1.0, min(1.0, (2.0 * b["close"] - b["high"] - b["low"]) / rng))
        elif idx > 0:
            pc = bars[idx - 1]["close"]
            clv = 1.0 if b["close"] > pc else (-1.0 if b["close"] < pc else 0.0)
        else:
            clv = 0.0
        buy_frac = 0.5 * (clv + 1.0)
        sell_frac = 1.0 - buy_frac
        vol = b["volume"]
        bar_delta = vol * clv
        cvd += bar_delta
        cum_buy += vol * buy_frac
        cum_sell += vol * sell_frac
        tot_vol += vol
        out.append(
            {
                "time": b["time"],
                "barDelta": bar_delta,
                "cvd": cvd,
                "buyerPct": (cum_buy / tot_vol) * 100.0 if tot_vol > 0 else None,
                "sellerPct": (cum_sell / tot_vol) * 100.0 if tot_vol > 0 else None,
            }
        )
    return out


def relative_strength_py(asset_bars: list[dict[str, Any]], bench_bars: list[dict[str, Any]]) -> list[dict[str, float | None]]:
    out: list[dict[str, float | None]] = []
    j = 0
    last_bench = math.nan
    base_ratio = math.nan
    for a in asset_bars:
        a_day = math.floor(a["time"] / 86400.0)
        while j < len(bench_bars) and math.floor(bench_bars[j]["time"] / 86400.0) <= a_day:
            if bench_bars[j]["close"] > 0:
                last_bench = bench_bars[j]["close"]
            j += 1
        if not math.isfinite(last_bench):
            out.append({"time": a["time"], "rsRatio": None, "rsNormalizedPct": None})
            continue
        ratio = a["close"] / last_bench
        if not math.isfinite(base_ratio):
            base_ratio = ratio
        norm_pct = ((ratio / base_ratio) - 1.0) * 100.0
        out.append({"time": a["time"], "rsRatio": ratio, "rsNormalizedPct": norm_pct})
    return out


def rolling_rv_py(bars: list[dict[str, Any]], window: int = 30, ann_days: int = 252) -> list[float | None]:
    n = len(bars)
    out: list[float | None] = [None] * n
    if n <= window:
        return out
    rets = [math.nan] * n
    for i in range(1, n):
        rets[i] = math.log(bars[i]["close"] / bars[i - 1]["close"])
    factor = math.sqrt(ann_days) * 100.0
    for i in range(window, n):
        sample = rets[i - window + 1 : i + 1]
        out[i] = statistics.stdev(sample) * factor
    return out


def build_daily_bars() -> list[dict[str, Any]]:
    # 70 días desde 2026-08-03 18:00 UTC (lunes) Saltando fines de semana
    start_dt = dt.datetime(2026, 8, 3, 18, 0, 0, tzinfo=dt.timezone.utc)
    days: list[dt.datetime] = []
    cur = start_dt
    while len(days) < 70:
        if cur.weekday() < 5:
            days.append(cur)
        cur += dt.timedelta(days=1)

    bars: list[dict[str, Any]] = []
    price = 7450.0
    for i, d in enumerate(days):
        wave = math.sin(i * 0.27) * 115.0 + math.cos(i * 0.13) * 65.0
        drift = 12.5 * i
        close = round(price + drift + wave, 2)
        if i == 25:
            # Barra plana H == L para validar tick tie-breaker Lee-Ready
            open_p = close
            high_p = close
            low_p = close
        else:
            open_p = round(close - math.sin(i * 0.5) * 42.0, 2)
            high_p = round(max(open_p, close) + 38.0 + (i % 5) * 9.5, 2)
            low_p = round(min(open_p, close) - 34.0 - (i % 4) * 8.0, 2)
        vol = float(1_200_000 + (i % 7) * 185_000 + int(abs(math.sin(i)) * 450_000))
        bars.append(
            {
                "time": int(d.timestamp()),
                "open": open_p,
                "high": high_p,
                "low": low_p,
                "close": close,
                "volume": vol,
            }
        )
    return bars


def build_benchmark_bars(daily_bars: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # Comienza 3 días después para validar el pre-alineamiento causal (primeros días -> None/NaN)
    out: list[dict[str, Any]] = []
    for idx, b in enumerate(daily_bars[3:]):
        bench_c = round(580.0 + idx * 0.9 + math.cos(idx * 0.19) * 4.5, 4)
        out.append(
            {
                "time": b["time"],
                "open": bench_c - 0.8,
                "high": bench_c + 1.4,
                "low": bench_c - 1.2,
                "close": bench_c,
                "volume": 52_000_000.0,
            }
        )
    return out


def build_intraday_bars() -> list[dict[str, Any]]:
    # 16 barras de 15m en 2 sesiones UTC distintas
    s1 = int(dt.datetime(2026, 11, 5, 20, 0, 0, tzinfo=dt.timezone.utc).timestamp())
    s2 = int(dt.datetime(2026, 11, 6, 14, 30, 0, tzinfo=dt.timezone.utc).timestamp())
    out: list[dict[str, Any]] = []
    for k in range(8):
        c = round(235.0 + k * 0.65, 2)
        out.append(
            {
                "time": s1 + k * 900,
                "open": round(c - 0.3, 2),
                "high": round(c + 0.55, 2),
                "low": round(c - 0.45, 2),
                "close": c,
                "volume": float(110_000 + k * 15_000),
                "vw": round(c + 0.08, 3),
            }
        )
    for k in range(8):
        c = round(241.0 + math.sin(k * 0.4) * 1.4, 2)
        out.append(
            {
                "time": s2 + k * 900,
                "open": round(c - 0.4, 2),
                "high": round(c + 0.7, 2),
                "low": round(c - 0.6, 2),
                "close": c,
                "volume": float(140_000 + k * 20_000),
                "vw": round(c - 0.05, 3),
            }
        )
    return out


def main() -> None:
    daily_bars = build_daily_bars()
    bench_bars = build_benchmark_bars(daily_bars)
    intraday_bars = build_intraday_bars()

    closes = [b["close"] for b in daily_bars]
    ema9 = ema_series_py(closes, 9)
    ema21 = ema_series_py(closes, 21)
    ema50 = ema_series_py(closes, 50)
    atr14 = wilder_atr_py(daily_bars, 14)

    intraday_vwap = session_vwap_py(intraday_bars, True, 0)
    daily_vwap = session_vwap_py(daily_bars, False, 0)

    # Anchor tests sobre daily_bars
    last_dt = dt.datetime.fromtimestamp(daily_bars[-1]["time"], tz=dt.timezone.utc)
    month_start_ts = int(dt.datetime(last_dt.year, last_dt.month, 1, 0, 0, 0, tzinfo=dt.timezone.utc).timestamp())
    month_anchor = next(i for i, b in enumerate(daily_bars) if b["time"] >= month_start_ts)

    win60_start = max(0, len(daily_bars) - 60)
    swing_high_anchor = max(range(win60_start, len(daily_bars)), key=lambda idx: (daily_bars[idx]["high"], -idx))
    swing_low_anchor = min(range(win60_start, len(daily_bars)), key=lambda idx: (daily_bars[idx]["low"], idx))

    opex_nov_2026 = third_friday_utc_sec_py(2026, 11)
    opex_oct_2026 = third_friday_utc_sec_py(2026, 10)
    earnings_anchor_sec = daily_bars[45]["time"]
    earnings_anchor_idx = 45

    avwap_month = anchored_vwap_py(daily_bars, month_anchor)
    avwap_swing_hi = anchored_vwap_py(daily_bars, swing_high_anchor)
    avwap_swing_lo = anchored_vwap_py(daily_bars, swing_low_anchor)
    avwap_earnings = anchored_vwap_py(daily_bars, earnings_anchor_idx)

    flow = lee_ready_bar_flow_py(daily_bars)
    rs = relative_strength_py(daily_bars, bench_bars)
    rv30 = rolling_rv_py(daily_bars, 30, 252)

    # Carry CI <-> 24hs
    ci_px = 7950.0
    hs24_px = 7962.5
    spread_pct = (hs24_px / ci_px - 1.0) * 100.0
    tna_pct = (hs24_px / ci_px - 1.0) * 365.0 * 100.0

    # Expected Move +-1 sigma
    spot_em = 8100.0
    iv_dec = 0.52
    dte_em = 28.0
    sig_dec = iv_dec * math.sqrt(dte_em / 365.0)
    one_sig_abs = spot_em * sig_dec
    one_sig_pct = sig_dec * 100.0

    # ATR Position sizing
    eq = 5_000_000.0
    risk_pct = 1.5
    entry_px = 8100.0
    atr_val = 240.0
    atr_mult = 1.5
    stop_dist = atr_val * atr_mult
    stop_px = entry_px - stop_dist
    risk_budget = eq * (risk_pct / 100.0)
    qty = math.floor(risk_budget / stop_dist)

    # Spatial proximity
    levels_input = [
        {"name": "POC", "category": "AMT", "price": 8085.0},
        {"name": "Put Wall", "category": "OPTIONS", "price": 8000.0},
        {"name": "Call Wall", "category": "OPTIONS", "price": 8300.0},
        {"name": "FOB Bull", "category": "ICT", "price": 8078.0},
    ]
    prox = []
    for lv in levels_input:
        sdist = lv["price"] - spot_em
        dabs = abs(sdist)
        datr = dabs / atr_val
        prox.append(
            {
                "name": lv["name"],
                "category": lv["category"],
                "price": lv["price"],
                "signedDistAbs": sdist,
                "distanceAbs": dabs,
                "distancePct": (sdist / spot_em) * 100.0,
                "distanceAtr": datr,
                "withinBand": datr <= 0.15,
            }
        )
    prox.sort(key=lambda x: x["distanceAtr"])

    payload = {
        "meta": {"generator": "tools/gen_stock_detail_fixture.py", "tolerance": 1e-9},
        "dailyBars": daily_bars,
        "benchmarkBars": bench_bars,
        "intradayBars": intraday_bars,
        "ema9": ema9,
        "ema21": ema21,
        "ema50": ema50,
        "atr14": atr14,
        "intradaySessionVwap": intraday_vwap,
        "dailySessionVwap": daily_vwap,
        "opexTimestamps": {"oct2026": opex_oct_2026, "nov2026": opex_nov_2026},
        "avwap": {
            "monthAnchorIdx": month_anchor,
            "swingHighAnchorIdx": swing_high_anchor,
            "swingLowAnchorIdx": swing_low_anchor,
            "earningsAnchorSec": earnings_anchor_sec,
            "earningsAnchorIdx": earnings_anchor_idx,
            "monthSeries": avwap_month,
            "swingHighSeries": avwap_swing_hi,
            "swingLowSeries": avwap_swing_lo,
            "earningsSeries": avwap_earnings,
        },
        "leeReadyFlow": flow,
        "relativeStrength": rs,
        "rollingRv30": rv30,
        "ci24hCarry": {"priceCi": ci_px, "price24h": hs24_px, "settlementDays": 1, "spreadPct": spread_pct, "impliedTnaPct": tna_pct},
        "expectedMove": {
            "spot": spot_em,
            "ivDecimal": iv_dec,
            "daysToExpiry": dte_em,
            "oneSigmaAbs": one_sig_abs,
            "oneSigmaPct": one_sig_pct,
            "upper1Sigma": spot_em + one_sig_abs,
            "lower1Sigma": spot_em - one_sig_abs,
        },
        "atrSizing": {
            "equity": eq,
            "riskPct": risk_pct,
            "entryPrice": entry_px,
            "atr14": atr_val,
            "atrMultiple": atr_mult,
            "stopLossPrice": stop_px,
            "stopDistanceAbs": stop_dist,
            "riskBudget": risk_budget,
            "suggestedQty": qty,
        },
        "spatialProximity": {"spot": spot_em, "atr14": atr_val, "bandAtr": 0.15, "levels": levels_input, "expected": prox},
    }

    out_path = Path("fixtures/stock_detail_reference.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote {out_path} ({len(daily_bars)} daily bars, {len(intraday_bars)} intraday bars)")


if __name__ == "__main__":
    main()
