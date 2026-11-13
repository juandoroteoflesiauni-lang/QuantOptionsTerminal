"""Independent Python reference generator for Pieza 6 (Dealer Exposure Engine).

Implements independent textbook BSM & Black-76 analytical formulas using math.erf,
bisection IV inversion, dealer GEX / Spot-share Gamma / DEX / Vanna / Charm
exposures, Call/Put Walls, Zero Gamma (Gamma Flip) grid + bisection, and
Expected Move (formula & ATM straddle), strictly in pure Python stdlib.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

SECONDS_PER_YEAR_365 = 365 * 86400
SECONDS_PER_DAY = 86400
DAYS_PER_YEAR_365 = 365.0
SQRT_2 = math.sqrt(2.0)
SQRT_2PI = math.sqrt(2.0 * math.pi)


def norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / SQRT_2PI


def norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / SQRT_2))


def generalized_bs_greeks(
    underlier: float,
    strike: float,
    t: float,
    r: float,
    carry_q: float,
    vol: float,
    opt_type: str,
    model: str = "bsm",
) -> dict[str, float]:
    sqrt_t = math.sqrt(t)
    vol_sqrt_t = vol * sqrt_t
    d1 = (math.log(underlier / strike) + (r - carry_q + 0.5 * vol * vol) * t) / vol_sqrt_t
    d2 = d1 - vol_sqrt_t

    disc_q = math.exp(-carry_q * t)
    disc_r = math.exp(-r * t)
    pdf_d1 = norm_pdf(d1)

    if opt_type == "call":
        price = underlier * disc_q * norm_cdf(d1) - strike * disc_r * norm_cdf(d2)
        delta = disc_q * norm_cdf(d1)
    else:
        price = strike * disc_r * norm_cdf(-d2) - underlier * disc_q * norm_cdf(-d1)
        delta = -disc_q * norm_cdf(-d1)

    gamma = (disc_q * pdf_d1) / (underlier * vol_sqrt_t)
    vanna = -disc_q * pdf_d1 * (d2 / vol)

    charm_drift = (2.0 * (r - carry_q) * t - d2 * vol_sqrt_t) / (2.0 * t * vol_sqrt_t)
    charm_common = disc_q * pdf_d1 * charm_drift
    if opt_type == "call":
        charm = carry_q * disc_q * norm_cdf(d1) - charm_common
    else:
        charm = -carry_q * disc_q * norm_cdf(-d1) - charm_common

    if model == "black76":
        assert abs(carry_q - r) < 1e-15

    return {
        "price": price,
        "delta": delta,
        "gamma": gamma,
        "vanna": vanna,
        "charm": charm,
    }


def solve_iv_bisection(
    underlier: float,
    strike: float,
    t: float,
    r: float,
    carry_q: float,
    opt_type: str,
    target_price: float,
) -> float:
    lo = 1e-8
    hi = 5.0
    while (
        generalized_bs_greeks(underlier, strike, t, r, carry_q, hi, opt_type)["price"]
        < target_price
        and hi < 100.0
    ):
        hi *= 2.0
    for _ in range(120):
        mid = 0.5 * (lo + hi)
        pm = generalized_bs_greeks(underlier, strike, t, r, carry_q, mid, opt_type)["price"]
        if abs(pm - target_price) <= 1e-13 or (hi - lo) <= 1e-14:
            return mid
        if pm < target_price:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def compute_exposures_python(
    contracts: list[dict[str, Any]],
    market: dict[str, Any],
    call_sign: float = 1.0,
    put_sign: float = -1.0,
    model: str = "bsm",
    gamma_flip_half_width: float = 0.25,
    gamma_flip_steps: int = 200,
    wall_criterion: str = "gex",
    wall_scope: str = "all",
) -> dict[str, Any]:
    spot = market["spot"]
    now = market["nowUtcSec"]
    rate = market["rate"]
    div_yield_default = market.get("dividendYield")
    fwd_default = market.get("forward")

    prepared: list[dict[str, Any]] = []
    skipped_oi = 0.0
    total_active_oi = 0.0
    skipped_count = 0
    zero_oi_count = 0
    invalid_oi_count = 0

    for c in contracts:
        oi = c["openInterest"]
        if oi == "NaN" or not isinstance(oi, (int, float)) or not math.isfinite(oi) or oi < 0:
            invalid_oi_count += 1
            continue
        if oi == 0:
            zero_oi_count += 1
            continue

        total_active_oi += oi
        t_sec = c["expiryUtcSec"] - now
        if t_sec <= 0:
            skipped_count += 1
            skipped_oi += oi
            continue
        t = t_sec / SECONDS_PER_YEAR_365

        r = c.get("rate", rate)
        if model == "black76":
            u = c.get("forward", fwd_default)
            q = r
        else:
            u = c.get("spot", spot)
            q = c.get("dividendYield", div_yield_default)

        iv_raw = c.get("iv")
        mid_raw = c.get("midPrice")
        if isinstance(iv_raw, (int, float)) and math.isfinite(iv_raw) and iv_raw > 0:
            iv = float(iv_raw)
        elif (iv_raw is None or iv_raw == "NaN") and isinstance(mid_raw, (int, float)) and math.isfinite(mid_raw) and mid_raw > 0:
            iv = solve_iv_bisection(u, c["strike"], t, r, q, c["contractType"], float(mid_raw))
        else:
            skipped_count += 1
            skipped_oi += oi
            continue

        gr = generalized_bs_greeks(u, c["strike"], t, r, q, iv, c["contractType"], model=model)
        sgn = call_sign if c["contractType"] == "call" else put_sign
        mult = c["sharesPerContract"]
        vol_raw = c.get("volume")
        vol_val = float(vol_raw) if isinstance(vol_raw, (int, float)) and math.isfinite(vol_raw) and vol_raw >= 0 else math.nan

        prepared.append(
            {
                "contractType": c["contractType"],
                "strike": c["strike"],
                "expiryUtcSec": c["expiryUtcSec"],
                "timeToExpiry": t,
                "oi": float(oi),
                "volume": vol_val,
                "sharesPerContract": float(mult),
                "sign": sgn,
                "underlier": float(u),
                "rate": float(r),
                "dividendYield": float(q),
                "iv": iv,
                "greeks": gr,
                "marketMid": float(mid_raw) if isinstance(mid_raw, (int, float)) else None,
                "bid": c.get("bid"),
                "ask": c.get("ask"),
            }
        )

    strike_buckets: dict[float, dict[str, Any]] = {}
    for p in prepared:
        k = p["strike"]
        if k not in strike_buckets:
            strike_buckets[k] = {
                "strike": k,
                "callOI": 0.0,
                "putOI": 0.0,
                "hasCall": False,
                "hasPut": False,
                "callVol": 0.0,
                "putVol": 0.0,
                "callVolNaN": False,
                "putVolNaN": False,
                "callGex": 0.0,
                "putGex": 0.0,
                "callSpotGamma": 0.0,
                "putSpotGamma": 0.0,
                "callDex": 0.0,
                "putDex": 0.0,
                "callVanna": 0.0,
                "putVanna": 0.0,
                "callCharm": 0.0,
                "putCharm": 0.0,
            }
        b = strike_buckets[k]
        scale = p["sign"] * p["oi"] * p["sharesPerContract"]
        u = p["underlier"]
        gr = p["greeks"]
        gex = scale * gr["gamma"] * u * u * 0.01
        sgam = scale * gr["gamma"] * u
        dex = scale * gr["delta"] * u
        vanna_exp = scale * gr["vanna"] * u * 0.01
        charm_exp = scale * (gr["charm"] / DAYS_PER_YEAR_365) * u

        if p["contractType"] == "call":
            b["hasCall"] = True
            b["callOI"] += p["oi"]
            if math.isnan(p["volume"]):
                b["callVolNaN"] = True
            else:
                b["callVol"] += p["volume"]
            b["callGex"] += gex
            b["callSpotGamma"] += sgam
            b["callDex"] += dex
            b["callVanna"] += vanna_exp
            b["callCharm"] += charm_exp
        else:
            b["hasPut"] = True
            b["putOI"] += p["oi"]
            if math.isnan(p["volume"]):
                b["putVolNaN"] = True
            else:
                b["putVol"] += p["volume"]
            b["putGex"] += gex
            b["putSpotGamma"] += sgam
            b["putDex"] += dex
            b["putVanna"] += vanna_exp
            b["putCharm"] += charm_exp

    by_strike = []
    tot = {
        "callGex": 0.0,
        "putGex": 0.0,
        "absGex": 0.0,
        "netSpotGamma": 0.0,
        "callDex": 0.0,
        "putDex": 0.0,
        "callVanna": 0.0,
        "putVanna": 0.0,
        "callCharm": 0.0,
        "putCharm": 0.0,
    }
    for k in sorted(strike_buckets.keys()):
        b = strike_buckets[k]
        cv = "NaN" if (b["hasCall"] and b["callVolNaN"]) else (b["callVol"] if b["hasCall"] else 0.0)
        pv = "NaN" if (b["hasPut"] and b["putVolNaN"]) else (b["putVol"] if b["hasPut"] else 0.0)
        tv = "NaN" if (cv == "NaN" or pv == "NaN") else (cv + pv)
        row = {
            "strike": k,
            "callOpenInterest": b["callOI"],
            "putOpenInterest": b["putOI"],
            "totalOpenInterest": b["callOI"] + b["putOI"],
            "callVolume": cv,
            "putVolume": pv,
            "totalVolume": tv,
            "callGex": b["callGex"],
            "putGex": b["putGex"],
            "netGex": b["callGex"] + b["putGex"],
            "absGex": abs(b["callGex"]) + abs(b["putGex"]),
            "callSpotGamma": b["callSpotGamma"],
            "putSpotGamma": b["putSpotGamma"],
            "netSpotGamma": b["callSpotGamma"] + b["putSpotGamma"],
            "callDex": b["callDex"],
            "putDex": b["putDex"],
            "netDex": b["callDex"] + b["putDex"],
            "callVannaExposure": b["callVanna"],
            "putVannaExposure": b["putVanna"],
            "netVannaExposure": b["callVanna"] + b["putVanna"],
            "callCharmExposure": b["callCharm"],
            "putCharmExposure": b["putCharm"],
            "netCharmExposure": b["callCharm"] + b["putCharm"],
        }
        by_strike.append(row)
        tot["callGex"] += row["callGex"]
        tot["putGex"] += row["putGex"]
        tot["absGex"] += row["absGex"]
        tot["netSpotGamma"] += row["netSpotGamma"]
        tot["callDex"] += row["callDex"]
        tot["putDex"] += row["putDex"]
        tot["callVanna"] += row["callVannaExposure"]
        tot["putVanna"] += row["putVannaExposure"]
        tot["callCharm"] += row["callCharmExposure"]
        tot["putCharm"] += row["putCharmExposure"]

    # Walls
    call_wall: float | str = "NaN"
    best_c = 0.0
    put_wall: float | str = "NaN"
    best_p = 0.0
    for row in by_strike:
        if wall_scope == "all" or row["strike"] >= spot:
            val = row["callOpenInterest"] if wall_criterion == "oi" else abs(row["callGex"])
            if val > 0 and row["callOpenInterest"] > 0 and val > best_c:
                best_c = val
                call_wall = row["strike"]
        if wall_scope == "all" or row["strike"] <= spot:
            val = row["putOpenInterest"] if wall_criterion == "oi" else abs(row["putGex"])
            if val > 0 and row["putOpenInterest"] > 0 and val > best_p:
                best_p = val
                put_wall = row["strike"]

    # Gamma flip
    def net_gex_at(cand_s: float) -> float:
        ratio = cand_s / spot
        acc = 0.0
        for p in prepared:
            eu = p["underlier"] * ratio
            g = generalized_bs_greeks(
                eu,
                p["strike"],
                p["timeToExpiry"],
                p["rate"],
                p["dividendYield"],
                p["iv"],
                p["contractType"],
                model=model,
            )["gamma"]
            acc += p["sign"] * p["oi"] * p["sharesPerContract"] * g * eu * eu * 0.01
        return acc

    s_min = spot * (1.0 - gamma_flip_half_width)
    s_max = spot * (1.0 + gamma_flip_half_width)
    gs = [s_min + (s_max - s_min) * i / gamma_flip_steps for i in range(gamma_flip_steps + 1)]
    gf = [net_gex_at(s) for s in gs]
    roots = []
    tol_abs = 1e-12 * spot
    for i in range(gamma_flip_steps):
        if gf[i] * gf[i + 1] < 0.0:
            lo, hi = gs[i], gs[i + 1]
            flo = gf[i]
            for _ in range(100):
                mid = 0.5 * (lo + hi)
                if hi - lo <= tol_abs:
                    break
                fm = net_gex_at(mid)
                if fm == 0.0:
                    lo = hi = mid
                    break
                if flo * fm < 0.0:
                    hi = mid
                else:
                    lo = mid
                    flo = fm
            roots.append(0.5 * (lo + hi))
        elif gf[i] == 0.0 and i > 0 and gf[i - 1] * gf[i + 1] < 0.0:
            roots.append(gs[i])

    if len(roots) == 0:
        flip_spot: float | str = "NaN"
        flip_status = "no_crossing"
    elif len(roots) == 1:
        flip_spot = roots[0]
        flip_status = "unique"
    else:
        flip_spot = "NaN"
        flip_status = "multiple_crossings"

    # Expected Move per expiry
    exp_groups: dict[int, list[dict[str, Any]]] = {}
    for p in prepared:
        exp_groups.setdefault(p["expiryUtcSec"], []).append(p)
    raw_groups: dict[int, list[dict[str, Any]]] = {}
    for c in contracts:
        raw_groups.setdefault(c["expiryUtcSec"], []).append(c)

    em_list = []
    for exp in sorted(exp_groups.keys()):
        ep = exp_groups[exp]
        t = ep[0]["timeToExpiry"]
        # Solve IV_ATM
        by_k: dict[float, dict[str, float]] = {}
        for p in ep:
            by_k.setdefault(p["strike"], {})[p["contractType"]] = p["iv"]
        nodes = []
        for k in sorted(by_k.keys()):
            d = by_k[k]
            if abs(k - spot) / spot <= 1e-9:
                if "call" in d and "put" in d:
                    nodes.append((k, math.sqrt(0.5 * (d["call"] ** 2 + d["put"] ** 2))))
                else:
                    nodes.append((k, next(iter(d.values()))))
            elif k < spot:
                nodes.append((k, d.get("put", d.get("call"))))
            else:
                nodes.append((k, d.get("call", d.get("put"))))
        iv_atm: float | str = "NaN"
        for k, iv_v in nodes:
            if abs(k - spot) / spot <= 1e-9:
                iv_atm = iv_v
                break
        if iv_atm == "NaN":
            for idx in range(len(nodes) - 1):
                k0, iv0 = nodes[idx]
                k1, iv1 = nodes[idx + 1]
                if k0 < spot < k1:
                    lk0, lk1 = math.log(k0 / spot), math.log(k1 / spot)
                    a = -lk0 / (lk1 - lk0)
                    w = (1.0 - a) * (iv0**2 * t) + a * (iv1**2 * t)
                    iv_atm = math.sqrt(w / t)
                    break

        f_pct = iv_atm * math.sqrt(t) if isinstance(iv_atm, float) else "NaN"
        f_move = spot * f_pct if isinstance(f_pct, float) else "NaN"

        # ATM straddle
        pair_prices: dict[float, dict[str, float]] = {}
        for raw in raw_groups.get(exp, []):
            k = raw["strike"]
            ct = raw["contractType"]
            price = None
            if "midPrice" in raw and isinstance(raw["midPrice"], (int, float)) and math.isfinite(raw["midPrice"]) and raw["midPrice"] > 0:
                price = float(raw["midPrice"])
            elif "bid" in raw and "ask" in raw and isinstance(raw["bid"], (int, float)) and isinstance(raw["ask"], (int, float)) and raw["ask"] >= raw["bid"] >= 0:
                price = 0.5 * (raw["bid"] + raw["ask"])
            elif "midPrice" not in raw and "bid" not in raw and "ask" not in raw:
                match = [p for p in ep if p["strike"] == k and p["contractType"] == ct]
                if match:
                    price = match[0]["greeks"]["price"]
            if price is not None:
                pair_prices.setdefault(k, {})[ct] = price

        best_sk = "NaN"
        best_dist = math.inf
        for k in sorted(pair_prices.keys()):
            if "call" in pair_prices[k] and "put" in pair_prices[k]:
                rd = abs(k - spot) / spot
                if rd <= 0.05 and rd < best_dist:
                    best_dist = rd
                    best_sk = k
        if isinstance(best_sk, float):
            sc = pair_prices[best_sk]["call"]
            sp = pair_prices[best_sk]["put"]
            sm = sc + sp
            smp = sm / spot
        else:
            sc = sp = sm = smp = "NaN"

        em_list.append(
            {
                "expiryUtcSec": exp,
                "timeToExpiry": t,
                "ivAtm": iv_atm,
                "formulaMove": f_move,
                "formulaMovePct": f_pct,
                "straddleStrike": best_sk,
                "straddleCallPrice": sc,
                "straddlePutPrice": sp,
                "straddleMove": sm,
                "straddleMovePct": smp,
            }
        )

    return {
        "callGex": tot["callGex"],
        "putGex": tot["putGex"],
        "netGex": tot["callGex"] + tot["putGex"],
        "absGex": tot["absGex"],
        "netSpotGamma": tot["netSpotGamma"],
        "callDex": tot["callDex"],
        "putDex": tot["putDex"],
        "netDex": tot["callDex"] + tot["putDex"],
        "callVannaExposure": tot["callVanna"],
        "putVannaExposure": tot["putVanna"],
        "netVannaExposure": tot["callVanna"] + tot["putVanna"],
        "callCharmExposure": tot["callCharm"],
        "putCharmExposure": tot["putCharm"],
        "netCharmExposure": tot["callCharm"] + tot["putCharm"],
        "callWallStrike": call_wall,
        "putWallStrike": put_wall,
        "gammaFlipSpot": flip_spot,
        "gammaFlipStatus": flip_status,
        "gammaFlipCandidates": roots,
        "expectedMoveByExpiry": em_list,
        "byStrike": by_strike,
        "quality": {
            "activeContracts": len(prepared) + skipped_count,
            "usableContracts": len(prepared),
            "zeroOiContracts": zero_oi_count,
            "invalidOiContracts": invalid_oi_count,
            "skippedContracts": skipped_count,
            "totalActiveOpenInterest": total_active_oi,
            "skippedOpenInterest": skipped_oi,
            "skippedOiShare": skipped_oi / total_active_oi if total_active_oi > 0 else 0.0,
        },
    }


def build_scenario_1_realistic() -> dict[str, Any]:
    now = 1770000000
    spot = 585.0
    rate = 0.045
    q = 0.013
    exp7 = now + 7 * 86400
    exp30 = now + 30 * 86400
    market = {"spot": spot, "nowUtcSec": now, "rate": rate, "dividendYield": q}

    strikes = [545.0, 560.0, 565.0, 575.0, 585.0, 595.0, 605.0, 615.0, 630.0]
    # Heavy Put Wall GEX at 565 (huge OI on 545 far wing so 'oi' Picks 545/630 while 'gex' Picks 565/605!)
    call_ois_7 = [50, 120, 200, 900, 2400, 4200, 7500, 3100, 9500]
    put_ois_7 = [11000, 4800, 9200, 5100, 2100, 700, 150, 40, 10]
    call_ois_30 = [100, 200, 350, 1200, 3100, 5400, 8800, 4100, 11000]
    put_ois_30 = [12000, 6000, 9800, 6100, 2600, 900, 220, 60, 20]

    contracts: list[dict[str, Any]] = []
    for idx, k in enumerate(strikes):
        moneyness = math.log(k / spot)
        iv_7 = max(0.11, 0.165 - 0.55 * moneyness + 0.9 * moneyness * moneyness)
        iv_30 = max(0.12, 0.178 - 0.45 * moneyness + 0.7 * moneyness * moneyness)

        for exp, t_days, iv, coi, poi in [
            (exp7, 7.0, iv_7, call_ois_7[idx], put_ois_7[idx]),
            (exp30, 30.0, iv_30, call_ois_30[idx], put_ois_30[idx]),
        ]:
            t = t_days / 365.0
            c_gr = generalized_bs_greeks(spot, k, t, rate, q, iv, "call")
            p_gr = generalized_bs_greeks(spot, k, t, rate, q, iv, "put")

            # Use midPrice without explicit iv on alternating ITM/OTM strikes to verify IV solver integration!
            call_entry: dict[str, Any] = {
                "contractType": "call",
                "strike": k,
                "expiryUtcSec": exp,
                "openInterest": coi,
                "volume": int(coi * 0.45),
                "sharesPerContract": 100,
            }
            if idx % 2 == 0:
                call_entry["iv"] = iv
                if k == 585.0:
                    call_entry["bid"] = c_gr["price"] - 0.05
                    call_entry["ask"] = c_gr["price"] + 0.05
            else:
                call_entry["midPrice"] = c_gr["price"]

            put_entry: dict[str, Any] = {
                "contractType": "put",
                "strike": k,
                "expiryUtcSec": exp,
                "openInterest": poi,
                "volume": int(poi * 0.4),
                "sharesPerContract": 100,
                "iv": iv,
            }
            if k == 585.0:
                put_entry["bid"] = p_gr["price"] - 0.05
                put_entry["ask"] = p_gr["price"] + 0.05

            contracts.append(call_entry)
            contracts.append(put_entry)

    expected_gex = compute_exposures_python(contracts, market, wall_criterion="gex")
    expected_oi = compute_exposures_python(contracts, market, wall_criterion="oi")
    return {
        "market": market,
        "contracts": contracts,
        "expectedDefault": expected_gex,
        "expectedWallsOi": {
            "callWallStrike": expected_oi["callWallStrike"],
            "putWallStrike": expected_oi["putWallStrike"],
        },
        "netGexAtSpot95Pct": sum(
            (
                1.0 if p["contractType"] == "call" else -1.0
            )
            * p["openInterest"]
            * 100
            * generalized_bs_greeks(
                spot * 0.95,
                p["strike"],
                (p["expiryUtcSec"] - now) / SECONDS_PER_YEAR_365,
                rate,
                q,
                p["iv"] if "iv" in p else solve_iv_bisection(spot, p["strike"], (p["expiryUtcSec"] - now) / SECONDS_PER_YEAR_365, rate, q, p["contractType"], p["midPrice"]),
                p["contractType"],
            )["gamma"]
            * (spot * 0.95) ** 2
            * 0.01
            for p in contracts
        ),
    }


def build_scenario_2_quality() -> dict[str, Any]:
    now = 1770000000
    exp = now + 21 * 86400
    market = {"spot": 100.0, "nowUtcSec": now, "rate": 0.04, "dividendYield": 0.0}
    contracts = [
        # Inactive / invalid OI -> zero exposure contribution, excluded from active skipped counts
        {"contractType": "call", "strike": 95.0, "expiryUtcSec": exp, "openInterest": 0, "volume": 10, "sharesPerContract": 100, "iv": 0.25},
        {"contractType": "put", "strike": 95.0, "expiryUtcSec": exp, "openInterest": -10, "volume": 5, "sharesPerContract": 100, "iv": 0.25},
        {"contractType": "put", "strike": 90.0, "expiryUtcSec": exp, "openInterest": "NaN", "volume": 5, "sharesPerContract": 100, "iv": 0.27},
        # Active with IV=NaN and no midPrice -> skipped & counted in skippedOiShare!
        {"contractType": "put", "strike": 95.0, "expiryUtcSec": exp, "openInterest": 250, "volume": 50, "sharesPerContract": 100, "iv": "NaN"},
        {"contractType": "call", "strike": 105.0, "expiryUtcSec": exp, "openInterest": 150, "volume": 20, "sharesPerContract": 100, "iv": "NaN"},
        # Active expired contract -> skipped
        {"contractType": "call", "strike": 100.0, "expiryUtcSec": now - 60, "openInterest": 100, "volume": 10, "sharesPerContract": 100, "iv": 0.22},
        # Usable contracts (note: K=105 has NaN volume -> strike volume NaN, exposure healthy!)
        {"contractType": "put", "strike": 95.0, "expiryUtcSec": exp, "openInterest": 600, "volume": 120, "sharesPerContract": 100, "iv": 0.26, "midPrice": 1.15},
        {"contractType": "put", "strike": 100.0, "expiryUtcSec": exp, "openInterest": 400, "volume": 80, "sharesPerContract": 100, "iv": 0.23, "midPrice": 2.15},
        {"contractType": "call", "strike": 100.0, "expiryUtcSec": exp, "openInterest": 500, "volume": 90, "sharesPerContract": 100, "iv": 0.23, "midPrice": 2.38},
        {"contractType": "call", "strike": 105.0, "expiryUtcSec": exp, "openInterest": 1000, "volume": "NaN", "sharesPerContract": 100, "iv": 0.21},
    ]
    expected = compute_exposures_python(contracts, market)
    return {
        "market": market,
        "contracts": contracts,
        "expected": expected,
    }


def build_scenario_3_flip_variants() -> dict[str, Any]:
    now = 1770000000
    exp = now + 14 * 86400
    market = {"spot": 100.0, "nowUtcSec": now, "rate": 0.04, "dividendYield": 0.0}

    # 3A: Calls only -> strictly positive netGex everywhere -> NO Zero Gamma crossing -> NaN
    calls_only = [
        {"contractType": "call", "strike": 95.0, "expiryUtcSec": exp, "openInterest": 500, "volume": 10, "sharesPerContract": 100, "iv": 0.22},
        {"contractType": "call", "strike": 100.0, "expiryUtcSec": exp, "openInterest": 800, "volume": 20, "sharesPerContract": 100, "iv": 0.20},
        {"contractType": "call", "strike": 105.0, "expiryUtcSec": exp, "openInterest": 600, "volume": 15, "sharesPerContract": 100, "iv": 0.21},
    ]
    res_no_cross = compute_exposures_python(calls_only, market)

    # 3B: Butterfly positioning (+Calls wings, heavy -Puts ATM) -> 2 crossings in +-25% -> NaN by default, nearest if opted in
    double_cross = [
        {"contractType": "call", "strike": 88.0, "expiryUtcSec": exp, "openInterest": 2500, "volume": 10, "sharesPerContract": 100, "iv": 0.22},
        {"contractType": "put", "strike": 100.0, "expiryUtcSec": exp, "openInterest": 2200, "volume": 10, "sharesPerContract": 100, "iv": 0.22},
        {"contractType": "call", "strike": 112.0, "expiryUtcSec": exp, "openInterest": 2500, "volume": 10, "sharesPerContract": 100, "iv": 0.22},
    ]
    res_multi = compute_exposures_python(double_cross, market)
    nearest_root = min(res_multi["gammaFlipCandidates"], key=lambda r: abs(r - 100.0))

    # 3C: Flipped custom sign (call: -1, put: +1) on mixed chain
    mixed = [
        {"contractType": "put", "strike": 92.0, "expiryUtcSec": exp, "openInterest": 1200, "volume": 50, "sharesPerContract": 100, "iv": 0.26},
        {"contractType": "call", "strike": 105.0, "expiryUtcSec": exp, "openInterest": 1500, "volume": 70, "sharesPerContract": 100, "iv": 0.21},
    ]
    res_std = compute_exposures_python(mixed, market, call_sign=1.0, put_sign=-1.0)
    res_inv = compute_exposures_python(mixed, market, call_sign=-1.0, put_sign=1.0)

    return {
        "market": market,
        "noCrossingCallsOnly": {"contracts": calls_only, "expected": res_no_cross},
        "doubleCrossing": {
            "contracts": double_cross,
            "expectedDefault": res_multi,
            "expectedNearestRoot": nearest_root,
        },
        "invertedSign": {
            "contracts": mixed,
            "expectedStd": res_std,
            "expectedInverted": res_inv,
        },
    }


def build_scenario_4_black76() -> dict[str, Any]:
    now = 1770000000
    exp = now + 28 * 86400
    # Forward F=21.5 (e.g. VIX futures option chain)
    market = {"spot": 21.5, "forward": 21.5, "nowUtcSec": now, "rate": 0.045}
    contracts = [
        {"contractType": "call", "strike": 12.0, "expiryUtcSec": exp, "openInterest": 500, "volume": 200, "sharesPerContract": 100, "iv": 0.85},
        {"contractType": "put", "strike": 19.0, "expiryUtcSec": exp, "openInterest": 9500, "volume": 600, "sharesPerContract": 100, "iv": 0.78},
        {"contractType": "call", "strike": 25.0, "expiryUtcSec": exp, "openInterest": 12000, "volume": 900, "sharesPerContract": 100, "iv": 0.92},
        {"contractType": "call", "strike": 35.0, "expiryUtcSec": exp, "openInterest": 7000, "volume": 400, "sharesPerContract": 100, "iv": 1.05},
    ]
    expected = compute_exposures_python(contracts, market, model="black76", gamma_flip_half_width=0.40)
    return {
        "market": market,
        "contracts": contracts,
        "expected": expected,
    }


def main() -> None:
    payload = {
        "generator": "tools/gen_options_exposure_fixture.py",
        "tolerance": 1e-9,
        "scenario1_realisticSpy": build_scenario_1_realistic(),
        "scenario2_qualityDegraded": build_scenario_2_quality(),
        "scenario3_flipAndSigns": build_scenario_3_flip_variants(),
        "scenario4_black76": build_scenario_4_black76(),
    }
    out_path = Path(__file__).resolve().parent.parent / "fixtures" / "options_exposure_reference.json"
    out_path.write_text(json.dumps(payload, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
