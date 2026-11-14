"""
Independent Python reference generator for Pieza 16 (Options Order Flow, Vol/OI MAD
Anomalies, Flow-Adjusted Signed GEX, GEX/Charm Pin, and Wheel-by-Wheel Tracker).

Implements BSM closed-form equations and microstructure/regime logic from scratch
without reading or copying TypeScript source code, and writes:
  fixtures/options_flow_pin_reference.json
"""

from __future__ import annotations

import json
import math
import statistics
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

SECONDS_PER_YEAR_365 = 365 * 86_400
SECONDS_PER_DAY = 86_400
DAYS_PER_YEAR = 365
SHARES_PER_CONTRACT = 100
MAD_CONSISTENCY = 1.4826
QUOTE_EPS = 1e-12
NY_TZ = ZoneInfo("America/New_York")


def norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def bsm_greeks(
    spot: float,
    strike: float,
    tau: float,
    rate: float,
    div_yield: float,
    vol: float,
    contract_type: str,
) -> dict[str, float]:
    sqrt_t = math.sqrt(tau)
    vol_sqrt_t = vol * sqrt_t
    d1 = (math.log(spot / strike) + (rate - div_yield + 0.5 * vol * vol) * tau) / vol_sqrt_t
    d2 = d1 - vol_sqrt_t

    disc_q = math.exp(-div_yield * tau)
    pdf_d1 = norm_pdf(d1)

    if contract_type == "call":
        delta = disc_q * norm_cdf(d1)
    else:
        delta = -disc_q * norm_cdf(-d1)

    gamma = (disc_q * pdf_d1) / (spot * vol_sqrt_t)
    vega = spot * disc_q * sqrt_t * pdf_d1
    vega_per_1pct = vega / 100.0

    drift_ratio = (2.0 * (rate - div_yield) * tau - d2 * vol_sqrt_t) / (2.0 * tau * vol_sqrt_t)
    charm_common = disc_q * pdf_d1 * drift_ratio
    if contract_type == "call":
        charm = div_yield * disc_q * norm_cdf(d1) - charm_common
    else:
        charm = -div_yield * disc_q * norm_cdf(-d1) - charm_common

    return {
        "delta": delta,
        "gamma": gamma,
        "vegaPer1Pct": vega_per_1pct,
        "charm": charm,
    }


def classify_opra_print(
    price: float,
    bid: float,
    ask: float,
    prev_price: float | None = None,
) -> dict[str, Any]:
    if (
        not math.isfinite(price)
        or price <= 0.0
        or not math.isfinite(bid)
        or bid <= 0.0
        or not math.isfinite(ask)
        or ask < bid
    ):
        return {"side": "INVALID_QUOTE", "aggressorSign": 0, "midpoint": None}

    midpoint = 0.5 * (bid + ask)
    if price >= ask - QUOTE_EPS or price > midpoint + QUOTE_EPS:
        return {"side": "ASK_SIDE_BUY", "aggressorSign": 1, "midpoint": midpoint}
    if price <= bid + QUOTE_EPS or price < midpoint - QUOTE_EPS:
        return {"side": "BID_SIDE_SELL", "aggressorSign": -1, "midpoint": midpoint}

    if prev_price is not None and math.isfinite(prev_price) and prev_price > 0.0:
        if price > prev_price + QUOTE_EPS:
            return {"side": "ASK_SIDE_BUY", "aggressorSign": 1, "midpoint": midpoint}
        if price < prev_price - QUOTE_EPS:
            return {"side": "BID_SIDE_SELL", "aggressorSign": -1, "midpoint": midpoint}

    return {"side": "MID_NEUTRAL", "aggressorSign": 0, "midpoint": midpoint}


def sanitize_json(obj: Any) -> Any:
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None
        return obj
    if isinstance(obj, dict):
        return {k: sanitize_json(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [sanitize_json(x) for x in obj]
    return obj


def compute_order_flow_ref(prints: list[dict[str, Any]], context: dict[str, Any]) -> dict[str, Any]:
    as_of = context["asOfUtcSec"]
    spot = context["spot"]
    rate = context["rate"]
    div_yield = context["dividendYield"]

    causal = [
        (idx, p)
        for idx, p in enumerate(prints)
        if p["timestampUtcSec"] <= as_of
    ]
    causal.sort(key=lambda pair: (pair[1]["timestampUtcSec"], pair[1].get("sipTimestampNs", 0), pair[0]))

    last_price: dict[str, float] = {}
    strikes: dict[float, dict[str, float]] = {}
    evaluated = 0
    skipped = 0
    call_buy_prem = 0.0
    call_sell_prem = 0.0
    put_buy_prem = 0.0
    put_sell_prem = 0.0
    net_delta = 0.0
    net_vega = 0.0

    for _, p in causal:
        ctype = p["contractType"]
        key = p.get("contractTicker") or f"{p.get('underlyingTicker', '')}|{p['expiryUtcSec']}|{p['strike']}|{ctype}"
        prev = p.get("prevPrice")
        if prev is None:
            prev = last_price.get(key)

        cls = classify_opra_print(p["price"], p["bid"], p["ask"], prev)
        if cls["side"] == "INVALID_QUOTE" or p["size"] <= 0 or p["strike"] <= 0:
            skipped += 1
            continue

        spc = p.get("sharesPerContract", SHARES_PER_CONTRACT)
        if "delta" in p and "vegaPer1Pct" in p and p["delta"] is not None and p["vegaPer1Pct"] is not None:
            delta = p["delta"]
            vega_1pct = p["vegaPer1Pct"]
        else:
            tau = (p["expiryUtcSec"] - p["timestampUtcSec"]) / SECONDS_PER_YEAR_365
            if tau <= 0 or p.get("impliedVolatility", 0.0) <= 0:
                skipped += 1
                continue
            g = bsm_greeks(spot, p["strike"], tau, rate, div_yield, p["impliedVolatility"], ctype)
            delta = g["delta"]
            vega_1pct = g["vegaPer1Pct"]

        last_price[key] = p["price"]
        evaluated += 1
        sign = cls["aggressorSign"]
        prem = p["price"] * p["size"] * spc
        d_shares = p["size"] * spc * delta * sign
        v_usd = p["size"] * spc * vega_1pct * sign

        k_strike = float(p["strike"])
        if k_strike not in strikes:
            strikes[k_strike] = {
                "strike": k_strike,
                "callBuyVolume": 0.0,
                "callSellVolume": 0.0,
                "putBuyVolume": 0.0,
                "putSellVolume": 0.0,
                "callBuyPremiumUsd": 0.0,
                "callSellPremiumUsd": 0.0,
                "putBuyPremiumUsd": 0.0,
                "putSellPremiumUsd": 0.0,
                "netDeltaShares": 0.0,
                "netVegaUsd": 0.0,
            }
        b = strikes[k_strike]
        if ctype == "call":
            if sign == 1:
                call_buy_prem += prem
                b["callBuyVolume"] += p["size"]
                b["callBuyPremiumUsd"] += prem
            elif sign == -1:
                call_sell_prem += prem
                b["callSellVolume"] += p["size"]
                b["callSellPremiumUsd"] += prem
        else:
            if sign == 1:
                put_buy_prem += prem
                b["putBuyVolume"] += p["size"]
                b["putBuyPremiumUsd"] += prem
            elif sign == -1:
                put_sell_prem += prem
                b["putSellVolume"] += p["size"]
                b["putSellPremiumUsd"] += prem

        net_delta += d_shares
        net_vega += v_usd
        b["netDeltaShares"] += d_shares
        b["netVegaUsd"] += v_usd

    by_strike = []
    for k in sorted(strikes.keys()):
        b = strikes[k]
        by_strike.append({
            **b,
            "netCallAggressiveContracts": b["callBuyVolume"] - b["callSellVolume"],
            "netPutAggressiveContracts": b["putBuyVolume"] - b["putSellVolume"],
        })

    call_cvd = call_buy_prem - call_sell_prem
    put_cvd = put_buy_prem - put_sell_prem
    return {
        "asOfUtcSec": as_of,
        "evaluatedPrints": evaluated,
        "skippedPrints": skipped,
        "callBuyPremiumUsd": call_buy_prem,
        "callSellPremiumUsd": call_sell_prem,
        "callNetPremiumCvdUsd": call_cvd,
        "putBuyPremiumUsd": put_buy_prem,
        "putSellPremiumUsd": put_sell_prem,
        "putNetPremiumCvdUsd": put_cvd,
        "netDirectionalPremiumUsd": call_cvd - put_cvd,
        "netDeltaShares": net_delta,
        "netVegaUsd": net_vega,
        "byStrikeFlow": by_strike,
    }


def detect_vol_oi_anomalies_ref(
    contracts: list[dict[str, Any]],
    context: dict[str, Any],
    min_volume: float = 100.0,
    min_oi: float = 100.0,
    min_bucket_size: int = 3,
    threshold: float = 2.5,
) -> dict[str, Any]:
    as_of = context["asOfUtcSec"]
    spot = context["spot"]
    rate = context["rate"]
    div_yield = context["dividendYield"]

    prepared = []
    groups: dict[str, list[dict[str, Any]]] = {}
    skipped = 0

    for c in contracts:
        if (
            c["dayVolume"] < min_volume
            or c["openInterest"] < min_oi
            or c["expiryUtcSec"] <= as_of
            or c["impliedVolatility"] <= 0
            or c["strike"] <= 0
        ):
            skipped += 1
            continue

        rem_sec = c["expiryUtcSec"] - as_of
        tau = rem_sec / SECONDS_PER_YEAR_365
        dte_days = max(0, rem_sec // SECONDS_PER_DAY)
        if dte_days <= 0:
            dte_bucket = "0DTE"
        elif dte_days <= 7:
            dte_bucket = "1_7DTE"
        elif dte_days <= 30:
            dte_bucket = "8_30DTE"
        else:
            dte_bucket = "31_PLUS_DTE"

        log_m_abs = abs(math.log(c["strike"] / spot))
        ctype = c["contractType"]
        if log_m_abs <= 0.015:
            m_bucket = "ATM"
        elif (ctype == "call" and c["strike"] < spot) or (ctype == "put" and c["strike"] > spot):
            m_bucket = "ITM"
        elif log_m_abs <= 0.06:
            m_bucket = "OTM"
        else:
            m_bucket = "DEEP_OTM"

        g = bsm_greeks(spot, c["strike"], tau, rate, div_yield, c["impliedVolatility"], ctype)
        ratio = c["dayVolume"] / c["openInterest"]
        log_ratio = math.log(ratio)
        bkey = f"{dte_bucket}|{m_bucket}|{ctype}"

        item = {
            "contractTicker": c["contractTicker"],
            "strike": c["strike"],
            "expiryUtcSec": c["expiryUtcSec"],
            "contractType": ctype,
            "dteDays": dte_days,
            "dteBucket": dte_bucket,
            "logMoneynessAbs": log_m_abs,
            "moneynessBucket": m_bucket,
            "dayVolume": c["dayVolume"],
            "openInterest": c["openInterest"],
            "volOiRatio": ratio,
            "logVolOiRatio": log_ratio,
            "delta": g["delta"],
            "vegaPer1Pct": g["vegaPer1Pct"],
            "bucketKey": bkey,
        }
        prepared.append(item)
        groups.setdefault(bkey, []).append(item)

    stats: dict[str, tuple[float | None, float | None, int]] = {}
    for key, grp in groups.items():
        if len(grp) < min_bucket_size:
            stats[key] = (None, None, len(grp))
        else:
            xs = [x["logVolOiRatio"] for x in grp]
            med = float(statistics.median(xs))
            mad = float(statistics.median([abs(x - med) for x in xs]))
            stats[key] = (med, mad, len(grp))

    out_contracts = []
    for item in prepared:
        med, mad, cnt = stats[item["bucketKey"]]
        score = None
        is_anom = False
        if cnt >= min_bucket_size and mad is not None and med is not None and mad > 0.0:
            score = (item["logVolOiRatio"] - med) / (MAD_CONSISTENCY * mad)
            is_anom = score >= threshold
        out_contracts.append({
            "contractTicker": item["contractTicker"],
            "strike": item["strike"],
            "expiryUtcSec": item["expiryUtcSec"],
            "contractType": item["contractType"],
            "dteDays": item["dteDays"],
            "dteBucket": item["dteBucket"],
            "logMoneynessAbs": item["logMoneynessAbs"],
            "moneynessBucket": item["moneynessBucket"],
            "dayVolume": item["dayVolume"],
            "openInterest": item["openInterest"],
            "volOiRatio": item["volOiRatio"],
            "logVolOiRatio": item["logVolOiRatio"],
            "bucketMedianLogRatio": med,
            "bucketMadLogRatio": mad,
            "madLogScore": score,
            "isAnomaly": is_anom,
            "delta": item["delta"],
            "vegaPer1Pct": item["vegaPer1Pct"],
        })

    anomalies = sorted(
        [c for c in out_contracts if c["isAnomaly"]],
        key=lambda c: (-c["madLogScore"], c["contractTicker"]),
    )

    return {
        "asOfUtcSec": as_of,
        "evaluatedContracts": len(out_contracts),
        "skippedContracts": skipped,
        "contracts": out_contracts,
        "anomalies": anomalies,
    }


def compute_flow_adjusted_gex_ref(
    contracts: list[dict[str, Any]],
    market: dict[str, Any],
    by_strike_flow: list[dict[str, Any]],
    prior_weight: float = 0.5,
) -> dict[str, Any]:
    now_sec = market["nowUtcSec"]
    spot = market["spot"]
    rate = market["rate"]
    div_yield = market["dividendYield"]

    flow_map: dict[float, dict[str, float]] = {}
    for b in by_strike_flow:
        k = float(b["strike"])
        if k not in flow_map:
            flow_map[k] = {
                "callBuyVolume": 0.0,
                "callSellVolume": 0.0,
                "putBuyVolume": 0.0,
                "putSellVolume": 0.0,
            }
        flow_map[k]["callBuyVolume"] += b["callBuyVolume"]
        flow_map[k]["callSellVolume"] += b["callSellVolume"]
        flow_map[k]["putBuyVolume"] += b["putBuyVolume"]
        flow_map[k]["putSellVolume"] += b["putSellVolume"]

    acc_map: dict[float, dict[str, Any]] = {}
    evaluated = 0
    skipped = 0

    for c in contracts:
        tau = (c["expiryUtcSec"] - now_sec) / SECONDS_PER_YEAR_365
        if tau <= 0 or c["openInterest"] <= 0 or c["iv"] <= 0:
            skipped += 1
            continue

        g = bsm_greeks(spot, c["strike"], tau, rate, div_yield, c["iv"], c["contractType"])
        evaluated += 1
        k = float(c["strike"])
        if k not in acc_map:
            f = flow_map.get(k)
            c_tot = (f["callBuyVolume"] + f["callSellVolume"]) if f else 0.0
            p_tot = (f["putBuyVolume"] + f["putSellVolume"]) if f else 0.0
            c_flow_sign = -(f["callBuyVolume"] - f["callSellVolume"]) / c_tot if (f and c_tot > 0) else None
            p_flow_sign = -(f["putBuyVolume"] - f["putSellVolume"]) / p_tot if (f and p_tot > 0) else None
            c_eff = (prior_weight * 1.0 + (1.0 - prior_weight) * c_flow_sign) if c_flow_sign is not None else 1.0
            p_eff = (prior_weight * (-1.0) + (1.0 - prior_weight) * p_flow_sign) if p_flow_sign is not None else -1.0
            acc_map[k] = {
                "strike": k,
                "callStructuralSign": 1.0,
                "putStructuralSign": -1.0,
                "callDealerFlowSign": c_flow_sign,
                "putDealerFlowSign": p_flow_sign,
                "callEffectiveSign": c_eff,
                "putEffectiveSign": p_eff,
                "callSignedDollarGex": 0.0,
                "putSignedDollarGex": 0.0,
                "netCharmExposure": 0.0,
            }

        base_count = c["openInterest"] * c["sharesPerContract"]
        u_gex = base_count * g["gamma"] * spot * spot * 0.01
        u_charm = base_count * (g["charm"] / DAYS_PER_YEAR) * spot
        row = acc_map[k]
        if c["contractType"] == "call":
            row["callSignedDollarGex"] += row["callEffectiveSign"] * u_gex
            row["netCharmExposure"] += row["callEffectiveSign"] * u_charm
        else:
            row["putSignedDollarGex"] += row["putEffectiveSign"] * u_gex
            row["netCharmExposure"] += row["putEffectiveSign"] * u_charm

    by_strike = []
    total_gex = 0.0
    total_charm = 0.0
    call_wall = None
    call_max = 0.0
    put_wall = None
    put_min = 0.0

    for k in sorted(acc_map.keys()):
        r = acc_map[k]
        net_gex = r["callSignedDollarGex"] + r["putSignedDollarGex"]
        r["netSignedDollarGex"] = net_gex
        by_strike.append(r)
        total_gex += net_gex
        total_charm += r["netCharmExposure"]
        if r["callSignedDollarGex"] > call_max:
            call_max = r["callSignedDollarGex"]
            call_wall = r["strike"]
        if r["putSignedDollarGex"] < put_min:
            put_min = r["putSignedDollarGex"]
            put_wall = r["strike"]

    return {
        "spot": spot,
        "priorWeight": prior_weight,
        "evaluatedContractsCount": evaluated,
        "skippedContractsCount": skipped,
        "totalSignedDollarGex": total_gex,
        "totalCharmExposure": total_charm,
        "callWallStrike": call_wall,
        "putWallStrike": put_wall,
        "byStrike": by_strike,
    }


def compute_gex_charm_pin_ref(
    contracts: list[dict[str, Any]],
    market: dict[str, Any],
    max_pin_dte: float = 7.0,
    gex_weight: float = 0.6,
    charm_weight: float = 0.4,
) -> dict[str, Any]:
    now_sec = market["nowUtcSec"]
    spot = market["spot"]
    rate = market["rate"]
    div_yield = market["dividendYield"]
    max_rem_sec = SECONDS_PER_DAY if max_pin_dte == 0 else max_pin_dte * SECONDS_PER_DAY

    strikes: dict[float, dict[str, float]] = {}
    eligible = 0
    for c in contracts:
        rem = c["expiryUtcSec"] - now_sec
        if rem <= 0 or rem > max_rem_sec or c["openInterest"] <= 0 or c["iv"] <= 0:
            continue
        tau = rem / SECONDS_PER_YEAR_365
        g = bsm_greeks(spot, c["strike"], tau, rate, div_yield, c["iv"], c["contractType"])
        eligible += 1
        sign = 1.0 if c["contractType"] == "call" else -1.0
        notional = sign * c["openInterest"] * c["sharesPerContract"]
        d_gex = notional * g["gamma"] * spot * spot * 0.01
        d_charm = notional * (g["charm"] / DAYS_PER_YEAR) * spot
        k = float(c["strike"])
        if k not in strikes:
            strikes[k] = {"netGex": 0.0, "netCharm": 0.0}
        strikes[k]["netGex"] += d_gex
        strikes[k]["netCharm"] += d_charm

    sorted_k = sorted(strikes.keys())
    tot_abs_gex = sum(abs(strikes[k]["netGex"]) for k in sorted_k)
    tot_abs_charm = sum(abs(strikes[k]["netCharm"]) for k in sorted_k)

    weights = []
    w_sum = 0.0
    wk_sum = 0.0
    peak_k = None
    max_w = -1.0

    for k in sorted_k:
        ag = abs(strikes[k]["netGex"])
        ac = abs(strikes[k]["netCharm"])
        ng = ag / tot_abs_gex if tot_abs_gex > 0 else 0.0
        nc = ac / tot_abs_charm if tot_abs_charm > 0 else 0.0
        if tot_abs_gex > 0 and tot_abs_charm > 0:
            cw = (gex_weight * ng + charm_weight * nc) / (gex_weight + charm_weight)
        elif tot_abs_gex > 0:
            cw = ng
        else:
            cw = nc
        weights.append({
            "strike": k,
            "absDollarGex": ag,
            "absCharmExposure": ac,
            "normalizedGexShare": ng,
            "normalizedCharmShare": nc,
            "combinedWeight": cw,
        })
        wk_sum += cw * k
        w_sum += cw
        if cw > max_w:
            max_w = cw
            peak_k = k

    return {
        "gexCharmPinStrike": wk_sum / w_sum,
        "peakPinStrike": peak_k,
        "pinMagnetStrength": min(1.0, max(0.0, max_w)),
        "eligibleContractsCount": eligible,
        "strikeWeights": weights,
    }


def evaluate_wheel_tracker_ref(
    snapshots: list[dict[str, Any]],
    as_of_sec: int,
    pin_proximity_pct: float = 0.0025,
    late_start_minutes_et: int = 840,
    min_spot_ret_pct: float = 0.0005,
) -> dict[str, Any]:
    causal = [
        (i, s)
        for i, s in enumerate(snapshots)
        if s["timestampUtcSec"] <= as_of_sec and s["spot"] > 0
    ]
    causal.sort(key=lambda pair: (pair[1]["timestampUtcSec"], pair[0]))

    if len(causal) < 2:
        return {
            "asOfUtcSec": as_of_sec,
            "regime": "NO_DATA",
            "spotChange": None,
            "spotReturnPct": None,
            "gammaFlipChange": None,
            "gexCharmPinChange": None,
            "netDeltaSharesChange": None,
            "distanceToPinPct": None,
            "isLateSessionEt": False,
            "snapshotsCount": len(causal),
        }

    first = causal[0][1]
    last = causal[-1][1]
    spot_chg = last["spot"] - first["spot"]
    spot_ret = spot_chg / first["spot"]
    gf_chg = (
        None
        if (last["gammaFlip"] is None or first["gammaFlip"] is None)
        else last["gammaFlip"] - first["gammaFlip"]
    )
    pin_chg = (
        None
        if (last["gexCharmPin"] is None or first["gexCharmPin"] is None)
        else last["gexCharmPin"] - first["gexCharmPin"]
    )
    delta_chg = last["netDeltaShares"] - first["netDeltaShares"]
    dist_pin = (
        None
        if last["gexCharmPin"] is None
        else abs(last["spot"] - last["gexCharmPin"]) / last["spot"]
    )

    dt_ny = datetime.fromtimestamp(last["timestampUtcSec"], tz=timezone.utc).astimezone(NY_TZ)
    iso_weekday = dt_ny.isoweekday()
    mins_et = dt_ny.hour * 60 + dt_ny.minute
    is_late = (1 <= iso_weekday <= 5) and (late_start_minutes_et <= mins_et < 16 * 60)

    regime = "NEUTRAL"
    if is_late and dist_pin is not None and dist_pin <= pin_proximity_pct:
        regime = "PINNING_REGIME"
    elif spot_ret >= min_spot_ret_pct:
        if delta_chg > 0 and (gf_chg is None or gf_chg >= 0):
            regime = "DERIVATIVES_CONFIRMED_UPTREND"
        elif delta_chg < 0 and (gf_chg is None or gf_chg <= 0):
            regime = "UNSUPPORTED_SPOT_RALLY"
    elif spot_ret <= -min_spot_ret_pct:
        if delta_chg < 0 and (gf_chg is None or gf_chg <= 0):
            regime = "DERIVATIVES_CONFIRMED_DOWNTREND"
        elif delta_chg > 0 and (gf_chg is None or gf_chg >= 0):
            regime = "UNSUPPORTED_SPOT_SELLOFF"

    return {
        "asOfUtcSec": as_of_sec,
        "regime": regime,
        "spotChange": spot_chg,
        "spotReturnPct": spot_ret,
        "gammaFlipChange": gf_chg,
        "gexCharmPinChange": pin_chg,
        "netDeltaSharesChange": delta_chg,
        "distanceToPinPct": dist_pin,
        "isLateSessionEt": is_late,
        "snapshotsCount": len(causal),
    }


def main() -> None:
    # Base timestamp: Wednesday 2026-06-17 11:30:00 ET (EDT = UTC-4 -> 15:30:00 UTC)
    t_base = int(datetime(2026, 6, 17, 15, 30, 0, tzinfo=timezone.utc).timestamp())
    t_0dte_exp = int(datetime(2026, 6, 17, 20, 0, 0, tzinfo=timezone.utc).timestamp())
    t_3dte_exp = int(datetime(2026, 6, 20, 20, 0, 0, tzinfo=timezone.utc).timestamp())
    t_15dte_exp = int(datetime(2026, 7, 2, 20, 0, 0, tzinfo=timezone.utc).timestamp())
    t_45dte_exp = int(datetime(2026, 8, 1, 20, 0, 0, tzinfo=timezone.utc).timestamp())

    classification_cases = [
        {"name": "ask_exact", "price": 2.50, "bid": 2.40, "ask": 2.50, "prevPrice": None},
        {"name": "ask_side_mid", "price": 2.48, "bid": 2.40, "ask": 2.50, "prevPrice": None},
        {"name": "bid_exact", "price": 2.40, "bid": 2.40, "ask": 2.50, "prevPrice": None},
        {"name": "bid_side_mid", "price": 2.42, "bid": 2.40, "ask": 2.50, "prevPrice": None},
        {"name": "mid_uptick", "price": 2.45, "bid": 2.40, "ask": 2.50, "prevPrice": 2.43},
        {"name": "mid_downtick", "price": 2.45, "bid": 2.40, "ask": 2.50, "prevPrice": 2.47},
        {"name": "mid_neutral", "price": 2.45, "bid": 2.40, "ask": 2.50, "prevPrice": None},
        {"name": "invalid_crossed", "price": 2.45, "bid": 2.60, "ask": 2.50, "prevPrice": None},
        {"name": "invalid_zero_bid", "price": 2.45, "bid": 0.0, "ask": 2.50, "prevPrice": None},
    ]
    classification_results = {
        c["name"]: classify_opra_print(c["price"], c["bid"], c["ask"], c["prevPrice"])
        for c in classification_cases
    }

    flow_context = {
        "asOfUtcSec": t_base + 120,
        "spot": 500.0,
        "rate": 0.045,
        "dividendYield": 0.013,
    }
    flow_prints = [
        # Quadrant 1: Call Ask Buy (+1 * +delta) -> +netDeltaShares
        {
            "timestampUtcSec": t_base + 10,
            "sipTimestampNs": 100,
            "contractTicker": "O:SPY260620C00500000",
            "strike": 500.0,
            "expiryUtcSec": t_3dte_exp,
            "contractType": "call",
            "price": 4.20,
            "size": 120,
            "bid": 4.10,
            "ask": 4.20,
            "impliedVolatility": 0.21,
        },
        # Quadrant 2: Call Bid Sell (-1 * +delta) -> -netDeltaShares
        {
            "timestampUtcSec": t_base + 20,
            "sipTimestampNs": 200,
            "contractTicker": "O:SPY260620C00505000",
            "strike": 505.0,
            "expiryUtcSec": t_3dte_exp,
            "contractType": "call",
            "price": 2.05,
            "size": 40,
            "bid": 2.05,
            "ask": 2.15,
            "impliedVolatility": 0.20,
        },
        # Quadrant 3: Put Ask Buy (+1 * -|delta|) -> -netDeltaShares
        {
            "timestampUtcSec": t_base + 30,
            "sipTimestampNs": 300,
            "contractTicker": "O:SPY260620P00495000",
            "strike": 495.0,
            "expiryUtcSec": t_3dte_exp,
            "contractType": "put",
            "price": 1.85,
            "size": 50,
            "bid": 1.75,
            "ask": 1.85,
            "impliedVolatility": 0.22,
        },
        # Quadrant 4: Put Bid Sell (-1 * -|delta|) -> +netDeltaShares (bullish!)
        {
            "timestampUtcSec": t_base + 40,
            "sipTimestampNs": 400,
            "contractTicker": "O:SPY260620P00490000",
            "strike": 490.0,
            "expiryUtcSec": t_3dte_exp,
            "contractType": "put",
            "price": 1.05,
            "size": 100,
            "bid": 1.05,
            "ask": 1.15,
            "impliedVolatility": 0.24,
        },
        # Midpoint uptick vs prior price on O:SPY260620C00500000 (4.20 -> 4.25)
        {
            "timestampUtcSec": t_base + 50,
            "sipTimestampNs": 500,
            "contractTicker": "O:SPY260620C00500000",
            "strike": 500.0,
            "expiryUtcSec": t_3dte_exp,
            "contractType": "call",
            "price": 4.25,
            "size": 30,
            "bid": 4.20,
            "ask": 4.30,
            "impliedVolatility": 0.21,
        },
        # Invalid quote (bid = 0) -> skippedPrints = 1
        {
            "timestampUtcSec": t_base + 60,
            "sipTimestampNs": 600,
            "contractTicker": "O:SPY260620C00510000",
            "strike": 510.0,
            "expiryUtcSec": t_3dte_exp,
            "contractType": "call",
            "price": 1.10,
            "size": 25,
            "bid": 0.0,
            "ask": 1.15,
            "impliedVolatility": 0.19,
        },
        # Non-causal future print -> excluded from causal window
        {
            "timestampUtcSec": t_base + 180,
            "sipTimestampNs": 700,
            "contractTicker": "O:SPY260620C00500000",
            "strike": 500.0,
            "expiryUtcSec": t_3dte_exp,
            "contractType": "call",
            "price": 4.40,
            "size": 500,
            "bid": 4.30,
            "ask": 4.40,
            "impliedVolatility": 0.21,
        },
    ]
    order_flow_result = compute_order_flow_ref(flow_prints, flow_context)

    mad_contracts = [
        # Bucket 1: 0DTE | OTM | call (4 contracts; contract 4 is extreme anomaly)
        {
            "contractTicker": "C0_510",
            "strike": 510.0,
            "expiryUtcSec": t_0dte_exp,
            "contractType": "call",
            "dayVolume": 400,
            "openInterest": 1000,
            "impliedVolatility": 0.22,
        },
        {
            "contractTicker": "C0_515",
            "strike": 515.0,
            "expiryUtcSec": t_0dte_exp,
            "contractType": "call",
            "dayVolume": 500,
            "openInterest": 1000,
            "impliedVolatility": 0.23,
        },
        {
            "contractTicker": "C0_520",
            "strike": 520.0,
            "expiryUtcSec": t_0dte_exp,
            "contractType": "call",
            "dayVolume": 450,
            "openInterest": 1000,
            "impliedVolatility": 0.24,
        },
        {
            "contractTicker": "C0_525_ANOM",
            "strike": 525.0,
            "expiryUtcSec": t_0dte_exp,
            "contractType": "call",
            "dayVolume": 18000,
            "openInterest": 1000,
            "impliedVolatility": 0.25,
        },
        # Bucket 2: 1_7DTE | ATM | put (3 contracts with identical Vol/OI => MAD = 0 => madLogScore = null)
        {
            "contractTicker": "P3_498",
            "strike": 498.0,
            "expiryUtcSec": t_3dte_exp,
            "contractType": "put",
            "dayVolume": 500,
            "openInterest": 1000,
            "impliedVolatility": 0.20,
        },
        {
            "contractTicker": "P3_500",
            "strike": 500.0,
            "expiryUtcSec": t_3dte_exp,
            "contractType": "put",
            "dayVolume": 1000,
            "openInterest": 2000,
            "impliedVolatility": 0.20,
        },
        {
            "contractTicker": "P3_502",
            "strike": 502.0,
            "expiryUtcSec": t_3dte_exp,
            "contractType": "put",
            "dayVolume": 750,
            "openInterest": 1500,
            "impliedVolatility": 0.20,
        },
        # Bucket 3: 31_PLUS_DTE | DEEP_OTM | put (only 2 contracts < minBucketSize=3 => NaN/null)
        {
            "contractTicker": "P45_440",
            "strike": 440.0,
            "expiryUtcSec": t_45dte_exp,
            "contractType": "put",
            "dayVolume": 600,
            "openInterest": 1200,
            "impliedVolatility": 0.26,
        },
        {
            "contractTicker": "P45_450",
            "strike": 450.0,
            "expiryUtcSec": t_45dte_exp,
            "contractType": "put",
            "dayVolume": 900,
            "openInterest": 1000,
            "impliedVolatility": 0.25,
        },
        # Bucket 4: 8_30DTE | ITM | call (3 contracts normal variance)
        {
            "contractTicker": "C15_460",
            "strike": 460.0,
            "expiryUtcSec": t_15dte_exp,
            "contractType": "call",
            "dayVolume": 200,
            "openInterest": 500,
            "impliedVolatility": 0.24,
        },
        {
            "contractTicker": "C15_470",
            "strike": 470.0,
            "expiryUtcSec": t_15dte_exp,
            "contractType": "call",
            "dayVolume": 350,
            "openInterest": 500,
            "impliedVolatility": 0.23,
        },
        {
            "contractTicker": "C15_480",
            "strike": 480.0,
            "expiryUtcSec": t_15dte_exp,
            "contractType": "call",
            "dayVolume": 550,
            "openInterest": 500,
            "impliedVolatility": 0.22,
        },
        # Low-volume contract below threshold -> skipped
        {
            "contractTicker": "LOW_VOL",
            "strike": 500.0,
            "expiryUtcSec": t_3dte_exp,
            "contractType": "call",
            "dayVolume": 50,
            "openInterest": 1000,
            "impliedVolatility": 0.20,
        },
    ]
    mad_result = detect_vol_oi_anomalies_ref(mad_contracts, flow_context)

    gex_market = {
        "spot": 500.0,
        "nowUtcSec": t_base,
        "rate": 0.045,
        "dividendYield": 0.013,
    }
    gex_contracts = [
        {"contractType": "put", "strike": 490.0, "expiryUtcSec": t_3dte_exp, "openInterest": 12000, "sharesPerContract": 100, "iv": 0.22},
        {"contractType": "call", "strike": 500.0, "expiryUtcSec": t_3dte_exp, "openInterest": 10000, "sharesPerContract": 100, "iv": 0.20},
        {"contractType": "put", "strike": 500.0, "expiryUtcSec": t_3dte_exp, "openInterest": 4000, "sharesPerContract": 100, "iv": 0.20},
        {"contractType": "call", "strike": 505.0, "expiryUtcSec": t_0dte_exp, "openInterest": 8000, "sharesPerContract": 100, "iv": 0.19},
        {"contractType": "call", "strike": 520.0, "expiryUtcSec": t_3dte_exp, "openInterest": 7000, "sharesPerContract": 100, "iv": 0.20},
        # Far 45DTE contract included in GEX but excluded from 7DTE Pin calculation
        {"contractType": "call", "strike": 550.0, "expiryUtcSec": t_45dte_exp, "openInterest": 15000, "sharesPerContract": 100, "iv": 0.21},
    ]
    gex_flow_buckets = order_flow_result["byStrikeFlow"]

    gex_structural = compute_flow_adjusted_gex_ref(gex_contracts, gex_market, gex_flow_buckets, prior_weight=1.0)
    gex_flow_flipped = compute_flow_adjusted_gex_ref(gex_contracts, gex_market, gex_flow_buckets, prior_weight=0.2)
    pin_result = compute_gex_charm_pin_ref(gex_contracts, gex_market, max_pin_dte=7.0, gex_weight=0.6, charm_weight=0.4)

    # Wheel-by-wheel timestamps on 2026-06-17 (Wednesday EDT = UTC-4)
    t_open_1000 = int(datetime(2026, 6, 17, 14, 0, 0, tzinfo=timezone.utc).timestamp())
    t_mid_1130 = int(datetime(2026, 6, 17, 15, 30, 0, tzinfo=timezone.utc).timestamp())
    t_late_1510 = int(datetime(2026, 6, 17, 19, 10, 0, tzinfo=timezone.utc).timestamp())

    wheel_cases = {
        "PINNING_REGIME": evaluate_wheel_tracker_ref(
            [
                {"timestampUtcSec": t_open_1000, "spot": 499.0, "gammaFlip": 498.0, "gexCharmPin": 500.2, "netDeltaShares": 10000.0},
                {"timestampUtcSec": t_late_1510, "spot": 500.1, "gammaFlip": 498.5, "gexCharmPin": 500.2, "netDeltaShares": 12000.0},
            ],
            t_late_1510,
        ),
        "DERIVATIVES_CONFIRMED_UPTREND": evaluate_wheel_tracker_ref(
            [
                {"timestampUtcSec": t_open_1000, "spot": 500.0, "gammaFlip": 498.0, "gexCharmPin": 505.0, "netDeltaShares": 10000.0},
                {"timestampUtcSec": t_mid_1130, "spot": 503.0, "gammaFlip": 499.5, "gexCharmPin": 506.0, "netDeltaShares": 55000.0},
            ],
            t_mid_1130,
        ),
        "UNSUPPORTED_SPOT_RALLY": evaluate_wheel_tracker_ref(
            [
                {"timestampUtcSec": t_open_1000, "spot": 500.0, "gammaFlip": 498.0, "gexCharmPin": 505.0, "netDeltaShares": 10000.0},
                {"timestampUtcSec": t_mid_1130, "spot": 503.0, "gammaFlip": 496.5, "gexCharmPin": 504.0, "netDeltaShares": -25000.0},
            ],
            t_mid_1130,
        ),
        "DERIVATIVES_CONFIRMED_DOWNTREND": evaluate_wheel_tracker_ref(
            [
                {"timestampUtcSec": t_open_1000, "spot": 500.0, "gammaFlip": 498.0, "gexCharmPin": 495.0, "netDeltaShares": -5000.0},
                {"timestampUtcSec": t_mid_1130, "spot": 496.5, "gammaFlip": 495.5, "gexCharmPin": 494.0, "netDeltaShares": -65000.0},
            ],
            t_mid_1130,
        ),
        "UNSUPPORTED_SPOT_SELLOFF": evaluate_wheel_tracker_ref(
            [
                {"timestampUtcSec": t_open_1000, "spot": 500.0, "gammaFlip": 498.0, "gexCharmPin": 495.0, "netDeltaShares": -5000.0},
                {"timestampUtcSec": t_mid_1130, "spot": 496.5, "gammaFlip": 499.0, "gexCharmPin": 496.0, "netDeltaShares": 40000.0},
            ],
            t_mid_1130,
        ),
        "NEUTRAL": evaluate_wheel_tracker_ref(
            [
                {"timestampUtcSec": t_open_1000, "spot": 500.0, "gammaFlip": 498.0, "gexCharmPin": 502.0, "netDeltaShares": 1000.0},
                {"timestampUtcSec": t_mid_1130, "spot": 500.1, "gammaFlip": 498.0, "gexCharmPin": 502.0, "netDeltaShares": 1500.0},
            ],
            t_mid_1130,
        ),
        "NO_DATA_CAUSAL": evaluate_wheel_tracker_ref(
            [
                {"timestampUtcSec": t_open_1000, "spot": 500.0, "gammaFlip": 498.0, "gexCharmPin": 502.0, "netDeltaShares": 1000.0},
                {"timestampUtcSec": t_late_1510, "spot": 504.0, "gammaFlip": 500.0, "gexCharmPin": 504.0, "netDeltaShares": 50000.0},
            ],
            t_mid_1130,
        ),
    }

    payload = {
        "inputs": {
            "tBase": t_base,
            "t0dteExp": t_0dte_exp,
            "t3dteExp": t_3dte_exp,
            "t15dteExp": t_15dte_exp,
            "t45dteExp": t_45dte_exp,
            "tOpen1000": t_open_1000,
            "tMid1130": t_mid_1130,
            "tLate1510": t_late_1510,
            "classificationCases": classification_cases,
            "flowContext": flow_context,
            "flowPrints": flow_prints,
            "madContracts": mad_contracts,
            "gexMarket": gex_market,
            "gexContracts": gex_contracts,
        },
        "expected": {
            "classifications": classification_results,
            "orderFlow": order_flow_result,
            "madAnomalies": mad_result,
            "flowAdjustedGexStructural": gex_structural,
            "flowAdjustedGexFlipped": gex_flow_flipped,
            "gexCharmPin": pin_result,
            "wheelTrackerCases": wheel_cases,
        },
    }

    out_path = Path(__file__).resolve().parent.parent / "fixtures" / "options_flow_pin_reference.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as fh:
        json.dump(sanitize_json(payload), fh, indent=2, allow_nan=False)
        fh.write("\n")

    print(f"Generated {out_path}")


if __name__ == "__main__":
    main()
