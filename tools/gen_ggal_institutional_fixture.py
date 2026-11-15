#!/usr/bin/env python3
"""Independent pure-Python reference generator for GGAL Specialist Institutional Engines (Pieza 28).

Implements from mathematical first principles (stdlib `math` only):
- Motor 8: L1-L5 OBI & Microprice with exponential level decay, Iceberg reload,
  rolling 50-bucket volume-clock VPIN
- Motor 9: Yang-Zhang OHLC realized volatility, DLR/* forward curvature kink,
  asynchronous Hayashi-Yoshida cross-bank lead-lag, 3-state Hamilton filter
- Motor 2 / 4 enhancements: OTM-wing CCL implied vol extraction, 15:30 ART L2 PinScore,
  and ARS_BYMA / USD_ADR_NASDAQ / RATIO_CCL coordinate transforms.

Outputs deterministic JSON to `fixtures/ggal_institutional_reference.json`.
"""

from __future__ import annotations

import datetime as dt
import json
import math
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
FIXTURE_PATH = REPO_ROOT / "fixtures" / "ggal_institutional_reference.json"

GGAL_ADR_RATIO = 10.0


def encode_json_safe(obj: Any) -> Any:
    if isinstance(obj, float):
        if math.isnan(obj):
            return "__NaN__"
        if math.isinf(obj):
            return "__PosInf__" if obj > 0 else "__NegInf__"
        return obj
    if isinstance(obj, dict):
        return {k: encode_json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [encode_json_safe(v) for v in obj]
    return obj


# ---------------------------------------------------------------------------
# Motor 8: L2 Microstructure
# ---------------------------------------------------------------------------

def py_l2_microstructure(
    bids: list[dict[str, Any]],
    asks: list[dict[str, Any]],
    decay_alpha: float,
) -> dict[str, Any]:
    bids_s = sorted(bids, key=lambda r: r["level"])
    asks_s = sorted(asks, key=lambda r: r["level"])

    b1 = bids_s[0]
    a1 = asks_s[0]
    obi_l1 = (b1["size"] - a1["size"]) / (b1["size"] + a1["size"])
    microprice_l1 = (b1["price"] * a1["size"] + a1["price"] * b1["size"]) / (b1["size"] + a1["size"])

    w_bid_q = 0.0
    w_bid_pq = 0.0
    tot_bid5 = 0.0
    for b in bids_s:
        w = math.exp(-decay_alpha * (b["level"] - 1))
        w_bid_q += w * b["size"]
        w_bid_pq += w * b["size"] * b["price"]
        tot_bid5 += b["size"]

    w_ask_q = 0.0
    w_ask_pq = 0.0
    tot_ask5 = 0.0
    for a in asks_s:
        w = math.exp(-decay_alpha * (a["level"] - 1))
        w_ask_q += w * a["size"]
        w_ask_pq += w * a["size"] * a["price"]
        tot_ask5 += a["size"]

    obi_multi = (w_bid_q - w_ask_q) / (w_bid_q + w_ask_q)
    w_bid_p = w_bid_pq / w_bid_q
    w_ask_p = w_ask_pq / w_ask_q
    microprice_multi = (w_bid_p * w_ask_q + w_ask_p * w_bid_q) / (w_bid_q + w_ask_q)

    mid = 0.5 * (b1["price"] + a1["price"])
    spread_abs = a1["price"] - b1["price"]
    spread_bps = (spread_abs / mid) * 10000.0

    return {
        "bestBid": b1["price"],
        "bestAsk": a1["price"],
        "midPrice": mid,
        "spreadAbs": spread_abs,
        "spreadBps": spread_bps,
        "obiL1": obi_l1,
        "obiMultiLevel": obi_multi,
        "micropriceL1": microprice_l1,
        "micropriceMultiLevel": microprice_multi,
        "totalBidDepth5": tot_bid5,
        "totalAskDepth5": tot_ask5,
    }


def py_detect_iceberg(
    prev_best: dict[str, float],
    curr_best: dict[str, float],
    exec_bid: float,
    exec_ask: float,
) -> dict[str, Any]:
    candidates = []
    if abs(curr_best["bidPrice"] - prev_best["bidPrice"]) <= 1e-8 * max(1.0, prev_best["bidPrice"]):
        drop = max(0.0, prev_best["bidSize"] - curr_best["bidSize"])
        if exec_bid > drop + 1e-9:
            reloaded = exec_bid - drop
            candidates.append(
                {
                    "detected": True,
                    "side": "BID",
                    "priceLevel": curr_best["bidPrice"],
                    "executedVolumeAtBest": exec_bid,
                    "visibleDropAtBest": drop,
                    "reloadedVolumeEstimate": reloaded,
                    "reloadRatio": exec_bid / drop if drop > 0.0 else exec_bid,
                }
            )
    if abs(curr_best["askPrice"] - prev_best["askPrice"]) <= 1e-8 * max(1.0, prev_best["askPrice"]):
        drop = max(0.0, prev_best["askSize"] - curr_best["askSize"])
        if exec_ask > drop + 1e-9:
            reloaded = exec_ask - drop
            candidates.append(
                {
                    "detected": True,
                    "side": "ASK",
                    "priceLevel": curr_best["askPrice"],
                    "executedVolumeAtBest": exec_ask,
                    "visibleDropAtBest": drop,
                    "reloadedVolumeEstimate": reloaded,
                    "reloadRatio": exec_ask / drop if drop > 0.0 else exec_ask,
                }
            )
    if not candidates:
        return {
            "detected": False,
            "side": "NONE",
            "priceLevel": None,
            "executedVolumeAtBest": 0.0,
            "visibleDropAtBest": 0.0,
            "reloadedVolumeEstimate": 0.0,
            "reloadRatio": 0.0,
        }
    candidates.sort(key=lambda c: c["reloadedVolumeEstimate"], reverse=True)
    return candidates[0]


def py_compute_vpin(
    trades: list[dict[str, float]],
    adv20: float,
    window_buckets: int = 50,
    bucket_fraction: float = 0.02,
    historical_dist: list[float] | None = None,
) -> dict[str, Any]:
    bucket_size = bucket_fraction * adv20
    bucket_imbs: list[float] = []
    acc_buy = 0.0
    acc_sell = 0.0
    acc_tot = 0.0

    for tr in trades:
        rem_buy = tr["buyVolume"]
        rem_sell = tr["sellVolume"]
        rem_tot = rem_buy + rem_sell
        while rem_tot > 1e-12:
            space = bucket_size - acc_tot
            if rem_tot >= space - 1e-12:
                ratio = space / rem_tot
                sb = rem_buy * ratio
                ss = rem_sell * ratio
                bucket_imbs.append(abs((acc_buy + sb) - (acc_sell + ss)) / bucket_size)
                rem_buy -= sb
                rem_sell -= ss
                rem_tot = max(0.0, rem_buy + rem_sell)
                acc_buy = 0.0
                acc_sell = 0.0
                acc_tot = 0.0
            else:
                acc_buy += rem_buy
                acc_sell += rem_sell
                acc_tot += rem_tot
                rem_tot = 0.0

    completed = len(bucket_imbs)
    window_slice = bucket_imbs[max(0, completed - window_buckets):]
    vpin = sum(window_slice) / len(window_slice)

    if completed >= window_buckets:
        rolling = []
        run_sum = 0.0
        for i, val in enumerate(bucket_imbs):
            run_sum += val
            if i >= window_buckets:
                run_sum -= bucket_imbs[i - window_buckets]
            if i >= window_buckets - 1:
                rolling.append(run_sum / window_buckets)
    else:
        rolling = list(bucket_imbs)

    ref_dist = historical_dist if historical_dist else rolling
    le_count = sum(1 for x in ref_dist if x <= vpin + 1e-12)
    pct_rank = (le_count / len(ref_dist)) * 100.0

    return {
        "bucketSizeShares": bucket_size,
        "windowBuckets": window_buckets,
        "populatedBuckets": len(window_slice),
        "vpin": vpin,
        "percentileRank": pct_rank,
        "toxicAlert": pct_rank >= 90.0,
        "bucketSeries": rolling,
    }


# ---------------------------------------------------------------------------
# Motor 9: Yang-Zhang, DLR Kink, Hayashi-Yoshida, Hamilton Filter
# ---------------------------------------------------------------------------

def py_yang_zhang(bars: list[dict[str, float]], annualization: float = 252.0) -> float:
    n = len(bars) - 1
    os_list: list[float] = []
    cs_list: list[float] = []
    rs_sum = 0.0
    for i in range(1, len(bars)):
        prev = bars[i - 1]
        cur = bars[i]
        o = math.log(cur["open"] / prev["close"])
        c = math.log(cur["close"] / cur["open"])
        u = math.log(cur["high"] / cur["open"])
        d = math.log(cur["low"] / cur["open"])
        os_list.append(o)
        cs_list.append(c)
        rs_sum += u * (u - c) + d * (d - c)
    mean_o = sum(os_list) / n
    mean_c = sum(cs_list) / n
    var_o = sum((x - mean_o) ** 2 for x in os_list) / (n - 1)
    var_c = sum((x - mean_c) ** 2 for x in cs_list) / (n - 1)
    var_rs = rs_sum / n
    k = 0.34 / (1.34 + (n + 1.0) / (n - 1.0))
    yz_var = max(0.0, var_o + k * var_c + (1.0 - k) * var_rs)
    return math.sqrt(annualization * yz_var)


def py_dlr_kink(points: list[dict[str, Any]]) -> dict[str, Any]:
    pts = sorted(points, key=lambda p: p["daysToMaturity"])
    segs = []
    for i in range(1, len(pts)):
        dt_yrs = (pts[i]["daysToMaturity"] - pts[i - 1]["daysToMaturity"]) / 365.0
        fwd = math.log(pts[i]["priceArs"] / pts[i - 1]["priceArs"]) / dt_yrs
        segs.append(
            {
                "label": pts[i]["maturityLabel"],
                "fwd": fwd,
                "elec": pts[i]["isElectoralWindow"],
            }
        )
    has_elec = any(s["elec"] for s in segs)
    best_diff = -1.0
    best_label = ""
    best_fwd = math.nan
    for j in range(1, len(segs) - 1):
        left, mid, right = segs[j - 1], segs[j], segs[j + 1]
        if has_elec and not (left["elec"] or mid["elec"] or right["elec"]):
            continue
        diff_pct = abs((right["fwd"] - mid["fwd"]) - (mid["fwd"] - left["fwd"])) * 100.0
        if diff_pct > best_diff:
            best_diff = diff_pct
            best_label = mid["label"]
            best_fwd = mid["fwd"]
    slope = (segs[-1]["fwd"] - segs[0]["fwd"]) * 100.0
    return {
        "available": True,
        "maxSecondDifferencePct": best_diff,
        "peakMaturityLabel": best_label,
        "peakForwardRate": best_fwd,
        "annualizedTermSlopePct": slope,
        "curvePointsCount": len(pts),
    }


def py_hayashi_yoshida(
    series_by_bank: dict[str, list[dict[str, float]]],
    lag_grid: list[int],
) -> dict[str, Any]:
    tickers = ["GGAL", "BMA", "BBAR", "SUPV"]
    intervals: dict[str, list[tuple[float, float, float]]] = {}
    rvs: dict[str, float] = {}
    for tk in tickers:
        s = sorted(series_by_bank[tk], key=lambda x: x["timeSec"])
        ivs = []
        rv = 0.0
        for i in range(1, len(s)):
            lr = math.log(s[i]["price"] / s[i - 1]["price"])
            ivs.append((s[i - 1]["timeSec"], s[i]["timeSec"], lr))
            rv += lr * lr
        intervals[tk] = ivs
        rvs[tk] = rv

    scores = {tk: 0.0 for tk in tickers}
    pairs = []
    for i in range(len(tickers)):
        for j in range(i + 1, len(tickers)):
            a, b = tickers[i], tickers[j]
            best_lag = 0
            best_corr = 0.0
            best_abs = -1.0
            pos_sum = 0.0
            pos_cnt = 0
            neg_sum = 0.0
            neg_cnt = 0
            for lag in lag_grid:
                cov = 0.0
                for a0, a1, ra in intervals[a]:
                    sa0, sa1 = a0 + lag, a1 + lag
                    for b0, b1, rb in intervals[b]:
                        if max(sa0, b0) < min(sa1, b1):
                            cov += ra * rb
                corr = max(-1.0, min(1.0, cov / math.sqrt(rvs[a] * rvs[b])))
                ac = abs(corr)
                if lag > 0:
                    pos_sum += ac
                    pos_cnt += 1
                elif lag < 0:
                    neg_sum += ac
                    neg_cnt += 1
                if ac > best_abs + 1e-12 or (abs(ac - best_abs) <= 1e-12 and abs(lag) < abs(best_lag)):
                    best_abs = ac
                    best_corr = corr
                    best_lag = lag
            if best_lag > 0:
                lead = best_abs
            elif best_lag < 0:
                lead = -best_abs
            else:
                pm = pos_sum / pos_cnt if pos_cnt else 0.0
                nm = neg_sum / neg_cnt if neg_cnt else 0.0
                lead = pm - nm
            scores[a] += lead
            scores[b] -= lead
            pairs.append(
                {
                    "tickerA": a,
                    "tickerB": b,
                    "correlation": best_corr,
                    "bestLagSeconds": best_lag,
                    "leadScoreAOverB": lead,
                }
            )
    by_bank = {tk: scores[tk] / 3.0 for tk in tickers}
    leader = max(tickers, key=lambda tk: by_bank[tk])
    return {
        "available": True,
        "leader": leader,
        "leaderAverageLeadScore": by_bank[leader],
        "byBankScore": by_bank,
        "pairs": pairs,
    }


def py_hamilton_regime(
    prior: list[float],
    obs: dict[str, Any],
    yz_vol: float,
) -> dict[str, Any]:
    states = ["CALM_COMPRESSION", "FX_BRECHA_TENSION", "ELECTORAL_TAIL_JUMP"]
    P = [
        [0.93, 0.06, 0.01],
        [0.08, 0.84, 0.08],
        [0.03, 0.12, 0.85],
    ]
    means = [
        [0.38, 0.025, 0.90, 1.50, 0.18],
        [0.62, 0.085, 2.80, 7.00, 0.45],
        [0.98, 0.180, 6.00, 18.50, 0.78],
    ]
    stds = [
        [0.10, 0.025, 0.60, 1.80, 0.14],
        [0.14, 0.035, 1.10, 3.50, 0.18],
        [0.22, 0.055, 2.00, 7.50, 0.20],
    ]
    jump_int = [0.35, 1.65, 4.20]
    kelly_mult = [1.00, 0.55, 0.20]
    cvar_base = [4.80, 11.50, 24.00]
    hedge_rows = [
        [0.15, 0.20, 0.35, 0.30],
        [0.42, 0.28, 0.15, 0.15],
        [0.38, 0.44, 0.08, 0.10],
    ]

    s = sum(prior)
    pr = [x / s for x in prior]
    pred = [sum(pr[i] * P[i][j] for i in range(3)) for j in range(3)]
    y = [
        obs["bankBasketIv30ExErn"],
        obs["ggal25DeltaSkew"],
        obs["sovereignLegislationSpreadPct"],
        obs["dlrElectoralForwardKink"],
        obs["crossBankLeadLagIntensity"],
    ]
    ll = []
    for k in range(3):
        total = 0.0
        for d in range(5):
            z = (y[d] - means[k][d]) / stds[k][d]
            total += -0.5 * (math.log(2.0 * math.pi * stds[k][d] ** 2) + z * z)
        ll.append(total)
    m_ll = max(ll)
    liks = [math.exp(v - m_ll) for v in ll]
    unnorm = [pred[j] * liks[j] for j in range(3)]
    denom = sum(unnorm)
    post = [u / denom for u in unnorm]

    best_idx = 0
    if post[1] > post[0] and post[1] >= post[2]:
        best_idx = 1
    elif post[2] > post[0] and post[2] > post[1]:
        best_idx = 2

    daily_yz_pct = (yz_vol / math.sqrt(252.0)) * 100.0
    return {
        "currentRegime": states[best_idx],
        "posteriorProbabilities": post,
        "likelihoods": liks,
        "effectiveJumpIntensity": sum(post[j] * jump_int[j] for j in range(3)),
        "kellyFractionMultiplier": sum(post[j] * kelly_mult[j] for j in range(3)),
        "overnightCvar99Pct": sum(post[j] * cvar_base[j] for j in range(3)) + 0.35 * daily_yz_pct * 2.6652,
        "recommendedHedgeWeights": {
            "dlrFuturesWeight": sum(post[j] * hedge_rows[j][0] for j in range(3)),
            "otmPutWingWeight": sum(post[j] * hedge_rows[j][1] for j in range(3)),
            "cashArsCollarWeight": sum(post[j] * hedge_rows[j][2] for j in range(3)),
            "adrDeltaHedgeWeight": sum(post[j] * hedge_rows[j][3] for j in range(3)),
        },
    }


def py_otm_wing_ccl(
    byma_atm_iv: float,
    us_atm_iv: float,
    corr_adr_ccl: float,
    div_drag: float,
    strikes: list[dict[str, Any]],
) -> dict[str, Any]:
    w_sum = 0.0
    val_sum = 0.0
    pts = []
    for s in strikes:
        ad = s["absDelta"]
        if ad < 0.15 or ad > 0.25:
            continue
        eff_byma = (
            max(0.01, s["bymaIv"] - 0.5 * div_drag)
            if (s["isJul26DividendNoStrikeAdj"] and s["side"] == "PUT")
            else (s["bymaIv"] + 0.5 * div_drag if s["isJul26DividendNoStrikeAdj"] else s["bymaIv"])
        )
        b = corr_adr_ccl * s["usWingIv"]
        disc = b * b + eff_byma * eff_byma - s["usWingIv"] * s["usWingIv"]
        if disc < 0.0:
            continue
        ccl_iv = -b + math.sqrt(disc)
        w = 1.0 / (0.02 + abs(ad - 0.20))
        w_sum += w
        val_sum += w * ccl_iv
        pts.append({"strikeArs": s["strikeArs"], "impliedCclVol": ccl_iv, "bymaIv": eff_byma})

    return {
        "status": "OPERATIONAL",
        "extractedCclImplVol": val_sum / w_sum,
        "callOverwritingCompressionPct": ((us_atm_iv - byma_atm_iv) / us_atm_iv) * 100.0,
        "selectedWingsCount": len(pts),
        "wingPoints": pts,
    }


def py_l2_pin_score(
    as_of_utc_sec: int,
    pin_strike: float,
    spot_ars: float,
    base_pin_score: float,
    obi_multi: float,
) -> dict[str, Any]:
    art = dt.datetime.fromtimestamp(as_of_utc_sec, tz=dt.timezone(dt.timedelta(hours=-3)))
    minute_of_day = art.hour * 60 + art.minute
    is_closing = (15 * 60 + 20) <= minute_of_day <= (17 * 60)
    dist_pct = ((spot_ars - pin_strike) / pin_strike) * 100.0
    if abs(dist_pct) < 0.15:
        align = 1.0 - abs(obi_multi)
    elif dist_pct > 0.0:
        align = -obi_multi
    else:
        align = obi_multi
    ratio = max(0.5, min(1.5, 1.0 + 0.35 * align))
    closing_mult = 1.15 if is_closing else 1.0
    weighted = max(0.0, min(1.0, base_pin_score * ratio * closing_mult))
    return {
        "distancePct": dist_pct,
        "l2DepthConfirmationRatio": ratio,
        "isClosingWindow1530Art": is_closing,
        "weightedPinScore": weighted,
    }


def main() -> None:
    # 1) Motor 8 L2 fixture
    bids = [
        {"level": 1, "price": 7185.0, "size": 2400.0, "orderCount": 5},
        {"level": 2, "price": 7180.0, "size": 4100.0, "orderCount": 7},
        {"level": 3, "price": 7175.0, "size": 6500.0, "orderCount": 9},
        {"level": 4, "price": 7170.0, "size": 9200.0, "orderCount": 11},
        {"level": 5, "price": 7165.0, "size": 5000.0, "orderCount": 6},
    ]
    asks = [
        {"level": 1, "price": 7195.0, "size": 950.0, "orderCount": 3},
        {"level": 2, "price": 7200.0, "size": 1800.0, "orderCount": 4},
        {"level": 3, "price": 7205.0, "size": 2700.0, "orderCount": 5},
        {"level": 4, "price": 7210.0, "size": 11000.0, "orderCount": 14},
        {"level": 5, "price": 7215.0, "size": 4400.0, "orderCount": 6},
    ]
    decay_alpha = 0.55
    prev_best = {"bidPrice": 7185.0, "bidSize": 2400.0, "askPrice": 7195.0, "askSize": 1000.0}
    curr_best = {"bidPrice": 7185.0, "bidSize": 2400.0, "askPrice": 7195.0, "askSize": 700.0}
    exec_bid = 0.0
    exec_ask = 3200.0

    # Generate 65 trades so rolling 50-bucket VPIN has 15+ rolling observations
    base_ts = 1760000000
    vpin_trades = []
    for idx in range(72):
        # First 45 trades moderately balanced; last 27 trades heavily sell-skewed to force >90th pct toxic spike
        if idx < 45:
            buy_v = 11500.0 + (idx % 5) * 400.0
            sell_v = 9500.0 + ((idx + 2) % 5) * 350.0
        else:
            buy_v = 2200.0
            sell_v = 23800.0
        vpin_trades.append(
            {
                "timeSec": base_ts + idx * 15,
                "price": 7190.0 - idx * 0.25,
                "buyVolume": buy_v,
                "sellVolume": sell_v,
            }
        )
    adv20 = 1_000_000.0  # V_bucket = 20,000 shares

    l2_res = py_l2_microstructure(bids, asks, decay_alpha)
    iceberg_res = py_detect_iceberg(prev_best, curr_best, exec_bid, exec_ask)
    vpin_res = py_compute_vpin(vpin_trades, adv20, 50, 0.02, None)

    # 2) Motor 9 fixture
    yz_bars = []
    price = 52.0
    for i in range(22):
        gap = 0.008 * math.sin(i * 0.7)
        o = price * (1.0 + gap)
        c = o * (1.0 + 0.012 * math.cos(i * 0.5))
        h = max(o, c) * (1.015 + 0.005 * (i % 3))
        l = min(o, c) * (0.986 - 0.004 * (i % 2))
        yz_bars.append(
            {
                "timeSec": base_ts - (22 - i) * 86400,
                "open": round(o, 6),
                "high": round(h, 6),
                "low": round(l, 6),
                "close": round(c, 6),
            }
        )
        price = c
    yz_vol = py_yang_zhang(yz_bars, 252.0)

    dlr_curve = [
        {"maturityLabel": "DLR/NOV27", "daysToMaturity": 30, "priceArs": 1340.0, "isElectoralWindow": False},
        {"maturityLabel": "DLR/DIC27", "daysToMaturity": 60, "priceArs": 1387.0, "isElectoralWindow": False},
        {"maturityLabel": "DLR/MAR28", "daysToMaturity": 150, "priceArs": 1545.9, "isElectoralWindow": True},
        {"maturityLabel": "DLR/ABR28", "daysToMaturity": 180, "priceArs": 1618.7, "isElectoralWindow": True},
        {"maturityLabel": "DLR/JUN28", "daysToMaturity": 240, "priceArs": 1742.9, "isElectoralWindow": False},
    ]
    dlr_res = py_dlr_kink(dlr_curve)

    # Asynchronous bank ticks where GGAL jumps +1.5% then BMA/BBAR/SUPV follow 20-40s later
    lag_grid = [-120, -60, -30, -15, 0, 15, 30, 60, 120]
    series_by_bank = {
        "GGAL": [
            {"timeSec": base_ts + 0, "price": 54.0},
            {"timeSec": base_ts + 25, "price": 54.6},
            {"timeSec": base_ts + 55, "price": 55.4},
            {"timeSec": base_ts + 85, "price": 55.1},
            {"timeSec": base_ts + 115, "price": 56.2},
            {"timeSec": base_ts + 145, "price": 57.0},
        ],
        "BMA": [
            {"timeSec": base_ts + 20, "price": 88.0},
            {"timeSec": base_ts + 50, "price": 88.8},
            {"timeSec": base_ts + 80, "price": 89.9},
            {"timeSec": base_ts + 110, "price": 89.4},
            {"timeSec": base_ts + 140, "price": 91.0},
            {"timeSec": base_ts + 170, "price": 92.1},
        ],
        "BBAR": [
            {"timeSec": base_ts + 30, "price": 17.5},
            {"timeSec": base_ts + 60, "price": 17.68},
            {"timeSec": base_ts + 90, "price": 17.92},
            {"timeSec": base_ts + 120, "price": 17.81},
            {"timeSec": base_ts + 150, "price": 18.14},
            {"timeSec": base_ts + 180, "price": 18.39},
        ],
        "SUPV": [
            {"timeSec": base_ts + 35, "price": 13.1},
            {"timeSec": base_ts + 65, "price": 13.22},
            {"timeSec": base_ts + 95, "price": 13.39},
            {"timeSec": base_ts + 125, "price": 13.31},
            {"timeSec": base_ts + 155, "price": 13.56},
            {"timeSec": base_ts + 185, "price": 13.74},
        ],
    }
    hy_res = py_hayashi_yoshida(series_by_bank, lag_grid)

    prior_electoral = [0.55, 0.35, 0.10]
    obs_electoral = {
        "bankBasketIv30ExErn": 0.94,
        "ggal25DeltaSkew": 0.175,
        "sovereignLegislationSpreadPct": 5.8,
        "dlrElectoralForwardKink": dlr_res["maxSecondDifferencePct"],
        "crossBankLeadLagLeader": hy_res["leader"],
        "crossBankLeadLagIntensity": abs(hy_res["leaderAverageLeadScore"]),
    }
    hamilton_tail = py_hamilton_regime(prior_electoral, obs_electoral, yz_vol)

    obs_calm = {
        "bankBasketIv30ExErn": 0.36,
        "ggal25DeltaSkew": 0.022,
        "sovereignLegislationSpreadPct": 0.85,
        "dlrElectoralForwardKink": 1.2,
        "crossBankLeadLagLeader": hy_res["leader"],
        "crossBankLeadLagIntensity": 0.16,
    }
    hamilton_calm = py_hamilton_regime([0.75, 0.20, 0.05], obs_calm, yz_vol)

    # 3) OTM Wing CCL & L2 PinScore
    wing_strikes = [
        {"strikeArs": 6200.0, "side": "PUT", "absDelta": 0.21, "bymaIv": 0.58, "usWingIv": 0.44, "isJul26DividendNoStrikeAdj": True},
        {"strikeArs": 6800.0, "side": "PUT", "absDelta": 0.48, "bymaIv": 0.42, "usWingIv": 0.47, "isJul26DividendNoStrikeAdj": True},
        {"strikeArs": 8200.0, "side": "CALL", "absDelta": 0.19, "bymaIv": 0.55, "usWingIv": 0.43, "isJul26DividendNoStrikeAdj": True},
    ]
    otm_ccl_res = py_otm_wing_ccl(0.41, 0.47, 0.18, 0.04, wing_strikes)

    # 15:40 ART = 18:40 UTC on 2026-06-18
    close_utc_sec = int(dt.datetime(2026, 6, 18, 18, 40, 0, tzinfo=dt.timezone.utc).timestamp())
    pin_res = py_l2_pin_score(close_utc_sec, 7200.0, 7188.0, 0.78, l2_res["obiMultiLevel"])

    payload = {
        "schemaVersion": "1.0.0",
        "generatedUtcIso": dt.datetime.now(dt.timezone.utc).isoformat(),
        "motor8": {
            "bids": bids,
            "asks": asks,
            "decayAlpha": decay_alpha,
            "expectedL2Metrics": l2_res,
            "icebergInput": {
                "previousBest": prev_best,
                "currentBest": curr_best,
                "executedVolumeAtBid": exec_bid,
                "executedVolumeAtAsk": exec_ask,
            },
            "expectedIceberg": iceberg_res,
            "vpinInput": {
                "trades": vpin_trades,
                "adv20Shares": adv20,
                "windowBuckets": 50,
                "bucketAdvFraction": 0.02,
            },
            "expectedVpin": vpin_res,
        },
        "motor9": {
            "yzBars": yz_bars,
            "expectedYangZhangVol": yz_vol,
            "dlrCurve": dlr_curve,
            "expectedDlrKink": dlr_res,
            "lagGrid": lag_grid,
            "seriesByBank": series_by_bank,
            "expectedHayashiYoshida": hy_res,
            "hamiltonTailInput": {
                "priorProbabilities": prior_electoral,
                "observables": obs_electoral,
                "yangZhangVol20d": yz_vol,
            },
            "expectedHamiltonTail": hamilton_tail,
            "hamiltonCalmInput": {
                "priorProbabilities": [0.75, 0.20, 0.05],
                "observables": obs_calm,
                "yangZhangVol20d": yz_vol,
            },
            "expectedHamiltonCalm": hamilton_calm,
        },
        "enhancements": {
            "otmWingInput": {
                "bymaAtmIv": 0.41,
                "usAtmIv": 0.47,
                "corrAdrCcl": 0.18,
                "jul26DividendYieldDragAnn": 0.04,
                "strikes": wing_strikes,
            },
            "expectedOtmWingCcl": otm_ccl_res,
            "l2PinInput": {
                "asOfUtcSec": close_utc_sec,
                "pinStrikeArs": 7200.0,
                "spotArs": 7188.0,
                "baseAnexoBPinScore": 0.78,
            },
            "expectedL2Pin": pin_res,
        },
        "coordinates": {
            "arsPrice": 7200.0,
            "cclRate": 1250.0,
            "adrReferenceUsd": 57.6,
            "expectedUsdAdr": (7200.0 * GGAL_ADR_RATIO) / 1250.0,
            "expectedRatioCcl": (7200.0 * GGAL_ADR_RATIO) / 57.6,
        },
    }

    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE_PATH.write_text(
        json.dumps(encode_json_safe(payload), indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Generated {FIXTURE_PATH} successfully.")


if __name__ == "__main__":
    main()
