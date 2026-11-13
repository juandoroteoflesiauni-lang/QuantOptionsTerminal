#!/usr/bin/env python3
"""Independent Python reference generator for Pieza 12:
- Intraday Realized Volatility (5m RTH with sqrt(78 * 252), strict intra-session ET)
- Variance Risk Premium (VRP Spread = IV_30d - RV_ann)
- Multi-Layer Terminal Confluence Orchestrator (6 Pillars + Key Levels)
- JSON-Safe Boundary Serializer (NaN / ±Inf -> null, envelopeStatus OK / PARTIAL / NO_DATA)

Zero TS code copying: all formulas, calendar/DST mapping (ZoneInfo("America/New_York")),
and serialization logic are written independently in Python using stdlib only.
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

NY_TZ = ZoneInfo("America/New_York")
RTH_START_MINUTES = 9 * 60 + 30
RTH_END_MINUTES = 16 * 60
BAR_SECONDS_5M = 300
ANNUALIZATION_FACTOR_5M = math.sqrt(78 * 252)

PILLAR_ORDER = [
    "mtf",
    "optionsPositioning",
    "openingAuction",
    "cvdAbsorption",
    "divergences",
    "breadthMacro",
]

PILLAR_LABELS = {
    "mtf": "Estructura MTF en Cascada",
    "optionsPositioning": "Posicionamiento de Opciones y Gamma",
    "openingAuction": "Subasta de Apertura e Inventario",
    "cvdAbsorption": "Flujo CVD y Absorción Pasiva",
    "divergences": "Divergencias RSI(14) y SMT",
    "breadthMacro": "Amplitud A/D y Régimen Macro VIX/SKEW",
}

KEY_LEVEL_ORDER = [
    "CallWall",
    "PutWall",
    "GammaFlip",
    "PMH",
    "PML",
    "ON_POC",
    "ON_VAH",
    "ON_VAL",
    "IBH",
    "IBL",
    "PDH",
    "PDL",
    "PDC",
    "SMA200_1D",
    "SMA50_4H",
    "EMA21_15M",
    "HMA55_5M",
]


def utc_ts(year: int, month: int, day: int, hour: int, minute: int, tz: Any = NY_TZ) -> int:
    dt = datetime(year, month, day, hour, minute, 0, tzinfo=tz)
    return int(dt.astimezone(timezone.utc).timestamp())


def et_parts(ts_sec: int) -> tuple[str, int]:
    dt = datetime.fromtimestamp(ts_sec, tz=timezone.utc).astimezone(NY_TZ)
    return dt.strftime("%Y-%m-%d"), dt.hour * 60 + dt.minute


def is_finite_num(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def sign_of(x: float | None) -> float | None:
    if x is None or not is_finite_num(x):
        return None
    if x > 0.0:
        return 1.0
    if x < 0.0:
        return -1.0
    return 0.0


def py_compute_intraday_rv(
    bars: list[dict[str, Any]],
    as_of_utc_sec: int,
    min_returns: int = 77,
    max_returns: int | None = None,
) -> dict[str, Any]:
    excluded_future = 0
    excluded_non_rth = 0
    closed_rth = 0
    invalid_close = False

    session_order: list[str] = []
    session_stats: dict[str, dict[str, Any]] = {}
    intra_returns: list[float] = []

    for bar in bars:
        t = bar["time"]
        if t + BAR_SECONDS_5M > as_of_utc_sec:
            excluded_future += 1
            continue
        date_key, mod = et_parts(t)
        if mod < RTH_START_MINUTES or mod >= RTH_END_MINUTES:
            excluded_non_rth += 1
            continue

        closed_rth += 1
        if date_key not in session_stats:
            session_order.append(date_key)
            session_stats[date_key] = {
                "sessionDate": date_key,
                "rthBarCount": 0,
                "returnsCount": 0,
                "prevClose": None,
            }
        st = session_stats[date_key]
        st["rthBarCount"] += 1

        c = bar["close"]
        if not is_finite_num(c) or c <= 0.0:
            invalid_close = True
            st["prevClose"] = None
            continue

        if st["prevClose"] is not None and not invalid_close:
            r = math.log(float(c) / float(st["prevClose"]))
            intra_returns.append(r)
            st["returnsCount"] += 1

        st["prevClose"] = float(c)

    sessions_out = [
        {
            "sessionDate": d,
            "rthBarCount": session_stats[d]["rthBarCount"],
            "returnsCount": 0 if invalid_close else session_stats[d]["returnsCount"],
        }
        for d in session_order
    ]

    if invalid_close:
        return {
            "status": "NO_DATA",
            "asOfUtcSec": as_of_utc_sec,
            "barSeconds": BAR_SECONDS_5M,
            "annualizationFactor": ANNUALIZATION_FACTOR_5M,
            "closedRthBarCount": closed_rth,
            "excludedFutureCount": excluded_future,
            "excludedNonRthCount": excluded_non_rth,
            "sessionCount": len(sessions_out),
            "totalAvailableReturns": 0,
            "returnsCount": 0,
            "meanLogReturn": None,
            "realizedVolAnnualized": None,
            "rvCenteredAnnualized": None,
            "sessions": sessions_out,
        }

    total_avail = len(intra_returns)
    used = intra_returns[-max_returns:] if (max_returns is not None and total_avail > max_returns) else intra_returns
    n = len(used)
    if n < min_returns or n == 0:
        return {
            "status": "NO_DATA",
            "asOfUtcSec": as_of_utc_sec,
            "barSeconds": BAR_SECONDS_5M,
            "annualizationFactor": ANNUALIZATION_FACTOR_5M,
            "closedRthBarCount": closed_rth,
            "excludedFutureCount": excluded_future,
            "excludedNonRthCount": excluded_non_rth,
            "sessionCount": len(sessions_out),
            "totalAvailableReturns": total_avail,
            "returnsCount": n,
            "meanLogReturn": None,
            "realizedVolAnnualized": None,
            "rvCenteredAnnualized": None,
            "sessions": sessions_out,
        }

    mean_r = sum(used) / n
    rv_ann = math.sqrt(sum(r * r for r in used) / n) * ANNUALIZATION_FACTOR_5M
    rv_cent = (
        math.sqrt(sum((r - mean_r) ** 2 for r in used) / (n - 1)) * ANNUALIZATION_FACTOR_5M
        if n >= 2
        else None
    )

    return {
        "status": "OK",
        "asOfUtcSec": as_of_utc_sec,
        "barSeconds": BAR_SECONDS_5M,
        "annualizationFactor": ANNUALIZATION_FACTOR_5M,
        "closedRthBarCount": closed_rth,
        "excludedFutureCount": excluded_future,
        "excludedNonRthCount": excluded_non_rth,
        "sessionCount": len(sessions_out),
        "totalAvailableReturns": total_avail,
        "returnsCount": n,
        "meanLogReturn": mean_r,
        "realizedVolAnnualized": rv_ann,
        "rvCenteredAnnualized": rv_cent,
        "sessions": sessions_out,
    }


def py_compute_vrp(iv30d: float | None, rv_ann: float | None) -> float | None:
    if not is_finite_num(iv30d) or iv30d <= 0.0 or not is_finite_num(rv_ann) or rv_ann <= 0.0:
        return None
    return float(iv30d) - float(rv_ann)


def py_ols_slope(values: list[float]) -> float | None:
    n = len(values)
    if n < 2:
        return None
    if any(not is_finite_num(v) for v in values):
        return None
    mean_x = (n - 1) / 2.0
    mean_y = sum(values) / n
    sxx = sum((i - mean_x) ** 2 for i in range(n))
    sxy = sum((i - mean_x) * (values[i] - mean_y) for i in range(n))
    return sxy / sxx if sxx > 0.0 else None


def py_evaluate_confluence(inputs: dict[str, Any]) -> dict[str, Any]:
    opts = inputs.get("options") or {}
    weights_raw = opts.get("weights") or {}
    weights = {p: float(weights_raw.get(p, 1.0)) for p in PILLAR_ORDER}
    ad_slope_window = int(opts.get("adSlopeWindow", 5))

    mtf = inputs.get("mtf")
    exposure = inputs.get("exposure")
    vol_metrics = inputs.get("volMetrics")
    opening = inputs.get("openingAuction")
    cvd = inputs.get("cvdAbsorption")
    rsi_div = inputs.get("rsiDivergences")
    smt_div = inputs.get("smtDivergences")
    breadth = inputs.get("breadth")
    macro_vol = inputs.get("macroVol")
    realized_vol = inputs.get("realizedVol")
    ref_levels = inputs.get("referenceLevels")

    # Resolve asOfUtcSec
    if "asOfUtcSec" in opts and opts["asOfUtcSec"] is not None:
        as_of_utc_sec = opts["asOfUtcSec"]
    else:
        ts_candidates = []
        for mod, key in [
            (mtf, "asOfUtcSec"),
            (exposure, "nowUtcSec"),
            (opening, "asOfUtcSec"),
            (cvd, "asOfUtcSec"),
            (rsi_div, "asOfUtcSec"),
            (smt_div, "asOfUtcSec"),
            (breadth, "asOfUtcSec"),
            (macro_vol, "asOfUtcSec"),
            (realized_vol, "asOfUtcSec"),
        ]:
            if mod is not None and mod.get(key) is not None and is_finite_num(mod[key]):
                ts_candidates.append(int(mod[key]))
        as_of_utc_sec = max(ts_candidates) if ts_candidates else None

    # Gamma regime
    gamma_regime = "NO_DATA"
    if exposure is not None:
        s = exposure.get("spot")
        gf = exposure.get("gammaFlipSpot")
        gex = exposure.get("netGex")
        if is_finite_num(s) and s > 0.0 and is_finite_num(gf) and gf > 0.0 and is_finite_num(gex):
            if s > gf and gex > 0.0:
                gamma_regime = "POSITIVE_GAMMA"
            elif s < gf and gex < 0.0:
                gamma_regime = "NEGATIVE_GAMMA"
            else:
                gamma_regime = "TRANSITION_ZONE"

    # Pillar 1: MTF
    if mtf is None or mtf.get("effectiveMacroRegime") == "INSUFFICIENT_DATA":
        p1_score, p1_code = None, "NO_DATA"
    else:
        reg = mtf["effectiveMacroRegime"]
        trig = bool(mtf.get("executionTriggerActive", False))
        base = 1.0 if reg == "BULLISH_REGIME" else (-1.0 if reg == "BEARISH_REGIME" else 0.0)
        if trig and reg == "BULLISH_REGIME":
            p1_score, p1_code = clamp(base + 0.25, -1.0, 1.0), "BULLISH_REGIME_TRIGGERED"
        elif trig and reg == "BEARISH_REGIME":
            p1_score, p1_code = clamp(base - 0.25, -1.0, 1.0), "BEARISH_REGIME_TRIGGERED"
        else:
            p1_score, p1_code = base, reg

    # Pillar 2: Options
    dex_sig = sign_of(exposure.get("netDex")) if exposure is not None else None
    rr_raw = vol_metrics.get("riskReversal25") if vol_metrics is not None else None
    rr_sig = sign_of(-float(rr_raw)) if is_finite_num(rr_raw) else None
    if dex_sig is not None and rr_sig is not None:
        p2_score = clamp(0.5 * dex_sig + 0.5 * rr_sig, -1.0, 1.0)
        p2_code = gamma_regime if gamma_regime != "NO_DATA" else "DEX_AND_SKEW_25D"
    elif dex_sig is not None:
        p2_score = dex_sig
        p2_code = f"{gamma_regime}_DEX_ONLY" if gamma_regime != "NO_DATA" else "DEX_ONLY"
    elif rr_sig is not None:
        p2_score = rr_sig
        p2_code = f"{gamma_regime}_SKEW_ONLY" if gamma_regime != "NO_DATA" else "SKEW_25D_ONLY"
    else:
        p2_score, p2_code = None, "NO_DATA"

    # Pillar 3: Opening Auction
    if opening is None:
        p3_score, p3_code = None, "NO_DATA"
    elif (
        opening.get("openingType") == "PENDING_OPEN"
        or opening.get("rthBarCount", 0) <= 0
        or not is_finite_num(opening.get("currentClose"))
    ):
        p3_score, p3_code = None, "PENDING_OPEN"
    else:
        dir_map = {"BULLISH": 1.0, "BEARISH": -1.0, "NEUTRAL": 0.0}
        conv_map = {
            "OPEN_DRIVE": 1.0,
            "OPEN_TEST_DRIVE": 0.75,
            "OPEN_REJECTION_REVERSE": 0.5,
            "OPEN_AUCTION": 0.0,
        }
        inv_map = {
            "SHORT_COVERING_RISK": 1.0,
            "LONG_LIQUIDATION_RISK": -1.0,
            "NEUTRAL": 0.0,
        }
        o_type = opening["openingType"]
        o_dir = opening["openingDirection"]
        i_risk = opening["inventoryRisk"]
        p3_score = clamp(0.6 * (conv_map[o_type] * dir_map[o_dir]) + 0.4 * inv_map[i_risk], -1.0, 1.0)
        p3_code = f"{o_type}_{o_dir}" if i_risk == "NEUTRAL" else f"{o_type}_{o_dir}_{i_risk}"

    # Pillar 4: CVD & Passive Absorption
    if (
        cvd is None
        or cvd.get("closedInSessionCount", 0) <= 0
        or not is_finite_num(cvd.get("currentSessionCvd"))
    ):
        p4_score, p4_code = None, "NO_DATA"
    else:
        cvd_sig = sign_of(cvd["currentSessionCvd"])
        assert cvd_sig is not None
        cur_sess = cvd.get("currentSessionDate")
        events = cvd.get("absorptionEvents", [])
        sess_events = [e for e in events if cur_sess is None or e.get("sessionDate") == cur_sess]
        if sess_events:
            latest_ev = sess_events[-1]
            abs_sig = 1.0 if latest_ev["absorbingSide"] == "BUY_ABSORPTION" else -1.0
            p4_score = clamp(0.5 * cvd_sig + 0.5 * abs_sig, -1.0, 1.0)
            p4_code = latest_ev["absorbingSide"]
        else:
            p4_score = cvd_sig
            p4_code = "CVD_POSITIVE" if cvd_sig > 0 else ("CVD_NEGATIVE" if cvd_sig < 0 else "CVD_FLAT")

    # Pillar 5: RSI & SMT Divergences
    rsi_ok = rsi_div is not None and rsi_div.get("status") == "OK"
    smt_ok = smt_div is not None and smt_div.get("status") == "OK"
    if not rsi_ok and not smt_ok:
        p5_score, p5_code = None, "NO_DATA"
    else:
        smt_lat = smt_div.get("latestDivergence") if smt_ok else None
        rsi_lat = rsi_div.get("latestDivergence") if rsi_ok else None
        if smt_lat is None and rsi_lat is None:
            p5_score, p5_code = 0.0, "NONE"
        elif smt_lat is not None and (
            rsi_lat is None or smt_lat["confirmedAtCloseUtcSec"] >= rsi_lat["confirmedAtCloseUtcSec"]
        ):
            p5_score = 1.0 if smt_lat["type"] == "SMT_BULLISH" else -1.0
            p5_code = smt_lat["type"]
        else:
            assert rsi_lat is not None
            p5_score = 0.75 if "BULLISH" in rsi_lat["type"] else -0.75
            p5_code = rsi_lat["type"]

    # Pillar 6: Breadth A/D & Macro Volatility
    ad_slope = None
    if breadth is not None and breadth.get("closedBarCount", 0) > 0 and len(breadth.get("series", [])) >= 2:
        pts = breadth["series"][-ad_slope_window:]
        ad_vals = [pt["adLine"] for pt in pts]
        if all(is_finite_num(v) for v in ad_vals):
            ad_slope = py_ols_slope([float(v) for v in ad_vals])

    if breadth is None or breadth.get("closedBarCount", 0) <= 0:
        p6_score, p6_code = None, "NO_DATA"
    else:
        slope_sig = (
            sign_of(ad_slope)
            if is_finite_num(ad_slope)
            else (sign_of(breadth.get("latestAdNet")) if len(breadth.get("series", [])) == 1 else None)
        )
        div_st = breadth.get("divergenceStatus")
        div_sig = (
            1.0
            if div_st == "BULLISH_BREADTH_DIVERGENCE"
            else (-1.0 if div_st == "BEARISH_BREADTH_DIVERGENCE" else (0.0 if div_st == "NONE" else None))
        )
        if slope_sig is not None and div_sig is not None:
            raw_b = 0.5 * slope_sig + 0.5 * div_sig
        elif slope_sig is not None:
            raw_b = slope_sig
        elif div_sig is not None:
            raw_b = div_sig
        else:
            raw_b = None

        if raw_b is None:
            p6_score, p6_code = None, "NO_DATA"
        else:
            macro_valid = (
                macro_vol is not None
                and macro_vol.get("vixRegime") != "INSUFFICIENT_DATA"
                and is_finite_num(macro_vol.get("positionSizeMultiplier"))
                and macro_vol["positionSizeMultiplier"] > 0.0
            )
            if macro_valid:
                p6_score = clamp(raw_b * float(macro_vol["positionSizeMultiplier"]), -1.0, 1.0)
                reg = macro_vol["vixRegime"]
                p6_code = f"{reg}_TAIL_ALERT" if macro_vol.get("tailRiskAlert") else reg
            else:
                p6_score = clamp(raw_b, -1.0, 1.0)
                p6_code = "BREADTH_ONLY_MACRO_NO_DATA"

    pillar_specs = [
        ("mtf", p1_score, p1_code),
        ("optionsPositioning", p2_score, p2_code),
        ("openingAuction", p3_score, p3_code),
        ("cvdAbsorption", p4_score, p4_code),
        ("divergences", p5_score, p5_code),
        ("breadthMacro", p6_score, p6_code),
    ]

    pillars = []
    active_count = 0
    total_active_weight = 0.0
    weighted_sum = 0.0
    for pid, sc, code in pillar_specs:
        w = weights[pid]
        valid = sc is not None and is_finite_num(sc)
        if valid:
            active_count += 1
            total_active_weight += w
            weighted_sum += float(sc) * w
        pillars.append(
            {
                "id": pid,
                "label": PILLAR_LABELS[pid],
                "status": "OK" if valid else "NO_DATA",
                "score": float(sc) if valid else None,
                "weight": w,
                "weightedContribution": float(sc) * w if valid else None,
                "summaryCode": code,
            }
        )

    confluence_score = None
    if active_count > 0 and total_active_weight > 0.0:
        confluence_score = max(-100.0, min(100.0, (weighted_sum / total_active_weight) * 100.0))

    if confluence_score is None:
        bias = "NO_DATA"
    elif confluence_score >= 50.0:
        bias = "STRONG_BULLISH"
    elif confluence_score >= 15.0:
        bias = "BULLISH"
    elif confluence_score > -15.0:
        bias = "NEUTRAL"
    elif confluence_score > -50.0:
        bias = "BEARISH"
    else:
        bias = "STRONG_BEARISH"

    # Key Levels
    key_levels = []

    def add_lvl(name: str, source: str, val: Any) -> None:
        if is_finite_num(val) and float(val) > 0.0:
            key_levels.append({"name": name, "source": source, "price": float(val)})

    if exposure is not None:
        add_lvl("CallWall", "OPTIONS", exposure.get("callWallStrike"))
        add_lvl("PutWall", "OPTIONS", exposure.get("putWallStrike"))
        add_lvl("GammaFlip", "OPTIONS", exposure.get("gammaFlipSpot"))
    if opening is not None:
        add_lvl("PMH", "OPENING_AUCTION", opening.get("pmh"))
        add_lvl("PML", "OPENING_AUCTION", opening.get("pml"))
        add_lvl("ON_POC", "OPENING_AUCTION", opening.get("onPoc"))
        add_lvl("ON_VAH", "OPENING_AUCTION", opening.get("onVah"))
        add_lvl("ON_VAL", "OPENING_AUCTION", opening.get("onVal"))
        add_lvl("IBH", "OPENING_AUCTION", opening.get("ibh"))
        add_lvl("IBL", "OPENING_AUCTION", opening.get("ibl"))
    if ref_levels is not None:
        add_lvl("PDH", "REFERENCE", ref_levels.get("pdh"))
        add_lvl("PDL", "REFERENCE", ref_levels.get("pdl"))
        add_lvl("PDC", "REFERENCE", ref_levels.get("pdc"))
    if mtf is not None:
        add_lvl("SMA200_1D", "MTF", mtf.get("sma200_1d"))
        add_lvl("SMA50_4H", "MTF", mtf.get("sma50_4h"))
        add_lvl("EMA21_15M", "MTF", mtf.get("ema21_15m"))
        add_lvl("HMA55_5M", "MTF", mtf.get("hma55"))

    key_levels.sort(key=lambda lv: (lv["price"], KEY_LEVEL_ORDER.index(lv["name"])))

    # Headline spot & auxiliary metrics
    spot = None
    for cand in [
        exposure.get("spot") if exposure else None,
        opening.get("currentClose") if opening else None,
        opening.get("referencePrice") if opening else None,
        mtf.get("close5m") if mtf else None,
        mtf.get("close15m") if mtf else None,
        mtf.get("close1d") if mtf else None,
    ]:
        if is_finite_num(cand) and float(cand) > 0.0:
            spot = float(cand)
            break

    iv30d = (
        opts["iv30dOverride"]
        if "iv30dOverride" in opts
        else (vol_metrics.get("ivAtm") if vol_metrics is not None else None)
    )
    rv_ann = realized_vol.get("realizedVolAnnualized") if realized_vol is not None else None
    rv_cent = realized_vol.get("rvCenteredAnnualized") if realized_vol is not None else None
    vrp = py_compute_vrp(iv30d, rv_ann)

    metrics = {
        "spot": spot,
        "netDollarGex": exposure.get("netGex") if exposure else None,
        "netDex": exposure.get("netDex") if exposure else None,
        "gammaFlipSpot": exposure.get("gammaFlipSpot") if exposure else None,
        "callWallStrike": exposure.get("callWallStrike") if exposure else None,
        "putWallStrike": exposure.get("putWallStrike") if exposure else None,
        "expectedMove": exposure["expectedMove"].get("formulaMove") if exposure else None,
        "expectedMovePct": exposure["expectedMove"].get("formulaMovePct") if exposure else None,
        "iv30d": iv30d if is_finite_num(iv30d) else None,
        "riskReversal25": vol_metrics.get("riskReversal25") if vol_metrics else None,
        "butterfly25": vol_metrics.get("butterfly25") if vol_metrics else None,
        "realizedVolAnnualized": rv_ann if is_finite_num(rv_ann) else None,
        "rvCenteredAnnualized": rv_cent if is_finite_num(rv_cent) else None,
        "vrpSpread": vrp,
        "vixLevel": macro_vol.get("vixLevel") if macro_vol else None,
        "vixSlope": macro_vol.get("vixSlope") if macro_vol else None,
        "cboeSkewLevel": macro_vol.get("cboeSkewLevel") if macro_vol else None,
        "vixRegime": macro_vol.get("vixRegime") if macro_vol else "NO_DATA",
        "tailRiskAlert": (
            macro_vol.get("tailRiskAlert")
            if (macro_vol is not None and macro_vol.get("vixRegime") != "INSUFFICIENT_DATA")
            else None
        ),
        "positionSizeMultiplier": macro_vol.get("positionSizeMultiplier") if macro_vol else None,
        "adLineSlope": ad_slope,
        "latestAdLine": breadth.get("latestAdLine") if breadth else None,
        "currentSessionCvd": cvd.get("currentSessionCvd") if cvd else None,
        "latestRsi": rsi_div.get("latestRsi") if rsi_div else None,
    }

    pillar_map = {p["id"]: p for p in pillars}
    snapshot = {
        "status": "NO_DATA" if active_count == 0 else "OK",
        "asOfUtcSec": as_of_utc_sec,
        "activePillarsCount": active_count,
        "totalPillarsCount": 6,
        "totalActiveWeight": total_active_weight,
        "confluenceScore": confluence_score,
        "directionalBias": bias,
        "gammaRegime": gamma_regime,
        "pillars": pillars,
        "pillarMap": pillar_map,
        "keyLevels": key_levels,
        "metrics": metrics,
    }
    return snapshot


def py_serialize_snapshot(
    snapshot: dict[str, Any],
    metadata: dict[str, Any],
) -> dict[str, Any]:
    non_finite_paths: list[str] = []

    def walk(val: Any, path: str) -> Any:
        if val is None:
            # In our Python representation, None in numeric fields corresponds to NaN in TS
            return None
        if isinstance(val, (str, bool)):
            return val
        if isinstance(val, (int, float)):
            if not math.isfinite(val):
                non_finite_paths.append(path)
                return None
            return 0 if val == 0 else val
        if isinstance(val, list):
            return [walk(v, f"{path}[{i}]") for i, v in enumerate(val)]
        if isinstance(val, dict):
            return {k: walk(v, f"{path}.{k}" if path else k) for k, v in val.items()}
        raise TypeError(f"Unsupported type at {path}: {type(val)}")

    # Explicitly track fields that represent NaN in TS (null numeric slots, NOT intentionally nullable fields)
    INTENTIONALLY_NULLABLE = {
        "snapshot.asOfUtcSec",
        "snapshot.metrics.tailRiskAlert",
        "snapshot.pillarMap",
    }

    def collect_nan_paths(val: Any, path: str) -> None:
        if path in INTENTIONALLY_NULLABLE:
            return
        if val is None:
            non_finite_paths.append(path)
            return
        if isinstance(val, list):
            for i, elem in enumerate(val):
                collect_nan_paths(elem, f"{path}[{i}]")
        elif isinstance(val, dict):
            for k, v in val.items():
                sub = f"{path}.{k}" if path else k
                if k == "pillarMap":
                    # Mirror TS order: metadata -> snapshot (including pillarMap after pillars)
                    for pid in PILLAR_ORDER:
                        collect_nan_paths(v[pid], f"{sub}.{pid}")
                else:
                    collect_nan_paths(v, sub)

    san_meta = walk(metadata, "metadata")
    san_snap = walk(snapshot, "snapshot")
    non_finite_paths.clear()
    collect_nan_paths(metadata, "metadata")
    collect_nan_paths(snapshot, "snapshot")

    m = san_snap["metrics"]
    if san_snap["status"] == "NO_DATA":
        env_status = "NO_DATA"
    elif san_snap["activePillarsCount"] < san_snap["totalPillarsCount"]:
        env_status = "PARTIAL"
    elif any(
        m[k] is None
        for k in (
            "vrpSpread",
            "gammaFlipSpot",
            "callWallStrike",
            "putWallStrike",
            "expectedMove",
            "positionSizeMultiplier",
        )
    ):
        env_status = "PARTIAL"
    else:
        env_status = "OK"

    return {
        "schemaVersion": "1.0.0",
        "envelopeStatus": env_status,
        "nonFiniteFieldCount": len(non_finite_paths),
        "nonFinitePaths": non_finite_paths,
        "metadata": san_meta,
        "snapshot": san_snap,
    }


def build_rv_bar(time_sec: int, close: float) -> dict[str, Any]:
    return {
        "time": time_sec,
        "open": close,
        "high": close * 1.0005 if close > 0 else close,
        "low": close * 0.9995 if close > 0 else close,
        "close": close,
        "volume": 12000.0,
    }


def generate_multi_session_rv_bars() -> dict[str, Any]:
    """2025-03-07 (EST, UTC-5) -> 2025-03-10 (EDT, UTC-4): crosses US spring DST + +8.5% overnight gap."""
    bars: list[dict[str, Any]] = []

    # Pre-market 2025-03-07 (08:30..09:25 EST) -> must be excluded
    t_pm1 = utc_ts(2025, 3, 7, 8, 30)
    for k in range(12):
        bars.append(build_rv_bar(t_pm1 + k * 300, 99.2 + 0.05 * k))

    # Full 78 RTH bars on 2025-03-07 (09:30..15:55 EST) -> 77 intra-session returns
    t_rth1 = utc_ts(2025, 3, 7, 9, 30)
    price = 100.0
    for k in range(78):
        step = 0.0014 * math.sin(k * 0.37 + 0.2) + 0.0006 * math.cos(k * 0.71)
        price = price * math.exp(step)
        bars.append(build_rv_bar(t_rth1 + k * 300, price))

    # After-hours 2025-03-07 (16:00..16:30 EST) -> must be excluded
    t_ah1 = utc_ts(2025, 3, 7, 16, 0)
    for k in range(6):
        bars.append(build_rv_bar(t_ah1 + k * 300, price * 1.03))

    # Overnight +8.5% jump before 2025-03-10 EDT open! Must NEVER create a return across closing Friday->Monday open.
    # Pre-market 2025-03-10 EDT
    t_pm2 = utc_ts(2025, 3, 10, 8, 45)
    for k in range(9):
        bars.append(build_rv_bar(t_pm2 + k * 300, price * 1.084))

    # 35 RTH bars on 2025-03-10 (09:30..12:20 EDT): first 30 closed by 12:00 EDT, last 5 in future!
    t_rth2 = utc_ts(2025, 3, 10, 9, 30)
    day2_price = price * 1.085
    for k in range(35):
        step = -0.0011 * math.cos(k * 0.43) + 0.0007 * math.sin(k * 0.29)
        day2_price = day2_price * math.exp(step)
        bars.append(build_rv_bar(t_rth2 + k * 300, day2_price))

    as_of_cutoff = utc_ts(2025, 3, 10, 12, 0)  # bars opening 09:30..11:55 EDT close by 12:00 EDT (30 bars -> 29 returns)
    as_of_end_day1_before_close = t_rth1 + 77 * 300 + 299  # 15:59:59 EST -> bar 77 not closed yet (76 returns)
    as_of_end_day1_exact_close = t_rth1 + 78 * 300  # 16:00:00 EST -> 78 bars -> 77 returns

    full_res = py_compute_intraday_rv(bars, as_of_cutoff, min_returns=77, max_returns=None)
    rolling_77 = py_compute_intraday_rv(bars, as_of_cutoff, min_returns=77, max_returns=77)
    before_close_res = py_compute_intraday_rv(bars, as_of_end_day1_before_close, min_returns=77)
    exact_close_res = py_compute_intraday_rv(bars, as_of_end_day1_exact_close, min_returns=77)

    # Same returns with zero overnight gap (if day2 opened flat instead of +8.5%) -> MUST produce exact same RV!
    flat_bars = [
        {**b, "close": b["close"] / 1.085 if b["time"] >= t_pm2 else b["close"]}
        for b in bars
    ]
    flat_res = py_compute_intraday_rv(flat_bars, as_of_cutoff, min_returns=77)

    return {
        "bars": bars,
        "asOfCutoff": as_of_cutoff,
        "asOfEndDay1BeforeClose": as_of_end_day1_before_close,
        "asOfEndDay1ExactClose": as_of_end_day1_exact_close,
        "fullResult": full_res,
        "rolling77Result": rolling_77,
        "beforeCloseDay1Result": before_close_res,
        "exactCloseDay1Result": exact_close_res,
        "flatOvernightResult": flat_res,
        "iv30dSample": 0.215,
        "expectedVrpFull": py_compute_vrp(0.215, full_res["realizedVolAnnualized"]),
    }


def make_mtf_stub(
    regime: str,
    trigger: bool,
    as_of: int,
    sma200: float = 560.0,
    sma50: float = 578.0,
    ema21: float = 591.5,
    hma55: float = 593.2,
    close5m: float = 595.0,
) -> dict[str, Any]:
    return {
        "asOfUtcSec": as_of,
        "closed1dCount": 210,
        "closed4hCount": 60,
        "closed15mCount": 40,
        "closed5mCount": 80,
        "excludedFuture1dCount": 0,
        "excludedFuture4hCount": 0,
        "excludedFuture15mCount": 0,
        "excludedFuture5mCount": 0,
        "close1d": close5m,
        "sma200_1d": sma200,
        "atr14_1d": 6.5,
        "distSma200Pct": (close5m - sma200) / sma200 if math.isfinite(sma200) else None,
        "distSma200Atr": (close5m - sma200) / 6.5 if math.isfinite(sma200) else None,
        "regime1d": regime,
        "close4h": close5m,
        "sma50_4h": sma50,
        "aligned4h": regime in ("BULLISH_REGIME", "BEARISH_REGIME"),
        "effectiveMacroRegime": regime,
        "close15m": close5m,
        "ema21_15m": ema21,
        "atr14_15m": 1.2,
        "pullback15mDistance": 0.25,
        "pullback15mInZone": trigger,
        "wickToBodyRatio15m": 2.1,
        "volume15mPercentile": 85.0,
        "absorption15m": trigger,
        "close5m": close5m,
        "hma55": hma55,
        "hma55Prev": hma55 - 0.1,
        "hma55Prev2": hma55 - 0.15,
        "hma55Slope": 0.1,
        "hma55SlopePrev": 0.05,
        "executionTriggerActive": trigger,
        "setupStatus": (
            "ACTIVE_BULLISH"
            if (regime == "BULLISH_REGIME" and trigger)
            else (
                "ACTIVE_BEARISH"
                if (regime == "BEARISH_REGIME" and trigger)
                else ("INSUFFICIENT_DATA" if regime == "INSUFFICIENT_DATA" else "STANDBY")
            )
        ),
    }


def make_exposure_stub(
    now_sec: int,
    spot: float,
    net_gex: float,
    net_dex: float,
    gamma_flip: float | None,
    call_wall: float | None,
    put_wall: float | None,
    expected_move: float | None,
    iv_atm: float | None = 0.18,
) -> dict[str, Any]:
    return {
        "spot": spot,
        "nowUtcSec": now_sec,
        "model": "bsm",
        "dealerPositionSign": {"call": 1, "put": -1},
        "units": {
            "dollarGex": "USD_PER_1PCT_SPOT_MOVE",
            "spotShareGamma": "USD_DELTA_PER_1_DOLLAR_SPOT_MOVE",
            "dex": "USD_NOTIONAL",
            "vannaExposure": "USD_DELTA_PER_1PCT_IV_MOVE",
            "charmExposure": "USD_DELTA_PER_DAY",
        },
        "callGex": max(net_gex, 0.0),
        "putGex": min(net_gex, 0.0),
        "netGex": net_gex,
        "absGex": abs(net_gex),
        "netSpotGamma": net_gex / (spot * 0.01) if spot > 0 else None,
        "callDex": max(net_dex, 0.0),
        "putDex": min(net_dex, 0.0),
        "netDex": net_dex,
        "callVannaExposure": 15000.0,
        "putVannaExposure": -5000.0,
        "netVannaExposure": 10000.0,
        "callCharmExposure": -2000.0,
        "putCharmExposure": 1000.0,
        "netCharmExposure": -1000.0,
        "callWallStrike": call_wall,
        "putWallStrike": put_wall,
        "gammaFlipSpot": gamma_flip,
        "gammaFlipStatus": "unique" if gamma_flip is not None else "no_crossing",
        "gammaFlipCandidates": [gamma_flip] if gamma_flip is not None else [],
        "expectedMove": {
            "expiryUtcSec": now_sec + 7 * 86400,
            "timeToExpiry": 7.0 / 365.0,
            "ivAtm": iv_atm,
            "formulaMove": expected_move,
            "formulaMovePct": (expected_move / spot) if (expected_move is not None and spot > 0) else None,
            "straddleStrike": round(spot),
            "straddleCallPrice": (expected_move * 0.6) if expected_move is not None else None,
            "straddlePutPrice": (expected_move * 0.6) if expected_move is not None else None,
            "straddleMove": expected_move,
            "straddleMovePct": (expected_move / spot) if (expected_move is not None and spot > 0) else None,
        },
        "expectedMoveByExpiry": [],
        "byStrike": [],
        "quality": {
            "inputContracts": 20,
            "activeContracts": 20,
            "usableContracts": 20,
            "zeroOiContracts": 0,
            "invalidOiContracts": 0,
            "skippedContracts": 0,
            "totalActiveOpenInterest": 50000,
            "usableOpenInterest": 50000,
            "skippedOpenInterest": 0,
            "skippedOiShare": 0.0,
            "countsByReason": {
                "invalidContractType": 0,
                "invalidStrike": 0,
                "invalidSharesPerContract": 0,
                "invalidExpiry": 0,
                "expired": 0,
                "invalidUnderlier": 0,
                "invalidRates": 0,
                "invalidIv": 0,
                "ivSolveFailed": 0,
                "nonFiniteGreeks": 0,
            },
            "skippedDetails": [],
        },
    }


def make_vol_metrics_stub(iv_atm: float | None, rr25: float | None, bf25: float | None = 0.012) -> dict[str, Any]:
    return {
        "timeToExpiry": 30.0 / 365.0,
        "expirySec": utc_ts(2025, 4, 11, 16, 0),
        "forward": 595.4,
        "ivAtm": iv_atm,
        "expectedMovePct": iv_atm * math.sqrt(30.0 / 365.0) if iv_atm is not None else None,
        "delta25PutIv": (iv_atm + (rr25 or 0.0) * 0.5) if iv_atm is not None else None,
        "delta25CallIv": (iv_atm - (rr25 or 0.0) * 0.5) if iv_atm is not None else None,
        "delta25PutStrike": 575.0,
        "delta25CallStrike": 615.0,
        "riskReversal25": rr25,
        "butterfly25": bf25,
        "isButterflyArbitrageFree": True,
    }


def make_opening_stub(
    as_of: int,
    opening_type: str,
    opening_dir: str,
    inv_risk: str,
    rth_count: int = 12,
    pmh: float = 594.0,
    pml: float = 589.0,
    on_poc: float = 591.0,
    on_vah: float = 593.0,
    on_val: float = 590.0,
    ibh: float = 596.0,
    ibl: float = 590.5,
    close_px: float | None = 595.0,
) -> dict[str, Any]:
    return {
        "sessionDate": "2025-03-10",
        "asOfUtcSec": as_of,
        "preMarketBarCount": 30,
        "rthBarCount": rth_count,
        "excludedFutureBarCount": 0,
        "pmh": pmh,
        "pml": pml,
        "onPoc": on_poc,
        "onVah": on_vah,
        "onVal": on_val,
        "preMarketVwap": (pmh + pml) / 2.0,
        "overnightVolumeProfile": {
            "pmh": pmh,
            "pml": pml,
            "onPoc": on_poc,
            "onVah": on_vah,
            "onVal": on_val,
            "preMarketVwap": (pmh + pml) / 2.0,
            "totalVolume": 100000.0,
            "valueAreaVolume": 70000.0,
            "valueAreaCoverage": 0.7,
            "bins": [],
        },
        "referencePrice": close_px if close_px is not None else on_poc,
        "open0930": 592.0 if rth_count > 0 else None,
        "currentClose": close_px if rth_count > 0 else None,
        "sessionVwap": 593.5 if rth_count > 0 else None,
        "trueGap": 2.0,
        "trueGapAtr": 0.3,
        "macro0830Detected": False,
        "macro0830High": None,
        "macro0830Low": None,
        "medianPreMarketRange": 0.4,
        "medianPreMarketVolume": 3000.0,
        "balanceType": "OUT_OF_BALANCE" if rth_count > 0 else "INSUFFICIENT_DATA",
        "rthCumVolume": 500000.0 if rth_count > 0 else None,
        "openingRvol": 2.8 if rth_count > 0 else None,
        "lowImmediateReversalProb": rth_count > 0,
        "pctVolumeAbovePrevClose": 0.9,
        "pctVolumeBelowPrevClose": 0.1,
        "cumulativeRthDelta": 65000.0 if rth_count > 0 else None,
        "inventoryRisk": inv_risk,
        "statisticalTargets": [590.0],
        "openingType": opening_type,
        "openingDirection": opening_dir,
        "openCrossCount": 0,
        "vwapCrossCount": 0,
        "ibh": ibh,
        "ibl": ibl,
        "ibWidth": ibh - ibl if (ibh is not None and ibl is not None) else None,
        "ibWidthAtr": 0.85 if (ibh is not None and ibl is not None) else None,
        "ibClassification": "NORMAL_IB" if rth_count > 0 else "PENDING_IB",
    }


def make_cvd_stub(
    as_of: int,
    session_date: str,
    session_cvd: float | None,
    events: list[tuple[str, str]],
    closed_count: int = 24,
) -> dict[str, Any]:
    ev_objs = [
        {
            "time": as_of - (len(events) - i) * 300,
            "sessionDate": sdate,
            "deltaMode": "TICK_EXACT",
            "close": 595.0,
            "high": 595.4,
            "low": 594.8,
            "volume": 40000.0,
            "barDelta": -12000.0 if side == "BUY_ABSORPTION" else 12000.0,
            "sessionCvd": float(session_cvd or 0.0),
            "absorbingSide": side,
            "volumePercentile": 95.0,
            "deltaPercentile": 94.0,
            "bodyDisplacementPercentile": 10.0,
            "primaryLevel": {"name": "ON_POC", "price": 591.0, "tolerance": 0.2, "distance": 0.1},
            "matchedLevels": [{"name": "ON_POC", "price": 591.0, "tolerance": 0.2, "distance": 0.1}],
        }
        for i, (sdate, side) in enumerate(events)
    ]
    return {
        "asOfUtcSec": as_of,
        "barSeconds": 300,
        "sessionScope": "RTH",
        "closedInSessionCount": closed_count,
        "excludedFutureCount": 0,
        "excludedOutOfSessionCount": 0,
        "skippedInvalidLevelCount": 0,
        "toleranceValid": True,
        "atrProximityTolerance": 0.2,
        "deltaMode": "TICK_EXACT" if closed_count > 0 else "INSUFFICIENT_DATA",
        "sessionDeltaModes": [],
        "currentSessionDate": session_date if closed_count > 0 else None,
        "currentSessionCvd": session_cvd,
        "bars": [],
        "absorptionEvents": ev_objs,
    }


def make_rsi_div_stub(
    as_of: int,
    status: str,
    latest_rsi: float | None,
    div_type: str | None = None,
    confirmed_at_close: int | None = None,
) -> dict[str, Any]:
    ev = (
        {
            "type": div_type,
            "pivot1Index": 15,
            "pivot2Index": 25,
            "pivot1Time": (confirmed_at_close or as_of) - 3600,
            "pivot2Time": (confirmed_at_close or as_of) - 900,
            "price1": 588.0,
            "price2": 586.5,
            "rsi1": 31.2,
            "rsi2": 38.4,
            "confirmedAtIndex": 28,
            "confirmedAtTime": (confirmed_at_close or as_of) - 300,
            "confirmedAtCloseUtcSec": confirmed_at_close or as_of,
        }
        if div_type is not None
        else None
    )
    return {
        "asOfUtcSec": as_of,
        "barSeconds": 300,
        "closedBarCount": 40 if status == "OK" else 10,
        "excludedFutureCount": 0,
        "status": status,
        "rsiPeriod": 14,
        "rsiSeries": [],
        "latestRsi": latest_rsi,
        "swingHighs": [],
        "swingLows": [],
        "divergences": [ev] if ev is not None else [],
        "latestDivergence": ev,
    }


def make_smt_div_stub(
    as_of: int,
    status: str,
    div_type: str | None = None,
    confirmed_at_close: int | None = None,
) -> dict[str, Any]:
    ev = (
        {
            "type": div_type,
            "sweepingAsset": "PRIMARY",
            "primaryPivot1Index": 10,
            "primaryPivot2Index": 22,
            "correlatedPivot1Index": 10,
            "correlatedPivot2Index": 22,
            "primaryPivot1Time": (confirmed_at_close or as_of) - 3600,
            "primaryPivot2Time": (confirmed_at_close or as_of) - 900,
            "correlatedPivot1Time": (confirmed_at_close or as_of) - 3600,
            "correlatedPivot2Time": (confirmed_at_close or as_of) - 900,
            "primaryPrice1": 589.0,
            "primaryPrice2": 587.5,
            "correlatedPrice1": 502.0,
            "correlatedPrice2": 503.1,
            "confirmedAtTime": (confirmed_at_close or as_of) - 300,
            "confirmedAtCloseUtcSec": confirmed_at_close or as_of,
        }
        if div_type is not None
        else None
    )
    return {
        "asOfUtcSec": as_of,
        "barSeconds": 300,
        "synchronizedBarCount": 40 if status == "OK" else 5,
        "excludedFuturePrimaryCount": 0,
        "excludedFutureCorrelatedCount": 0,
        "status": status,
        "primarySwingHighs": [],
        "primarySwingLows": [],
        "correlatedSwingHighs": [],
        "correlatedSwingLows": [],
        "divergences": [ev] if ev is not None else [],
        "latestDivergence": ev,
    }


def make_breadth_stub(
    as_of: int,
    ad_lines: list[float],
    div_status: str,
) -> dict[str, Any]:
    series = []
    prev = 0.0
    for i, al in enumerate(ad_lines):
        net = al - prev if i > 0 else al
        prev = al
        series.append(
            {
                "time": as_of - (len(ad_lines) - i) * 300,
                "indexClose": 590.0 + i,
                "advances": 320.0 if net >= 0 else 180.0,
                "declines": 180.0 if net >= 0 else 320.0,
                "adNet": net,
                "adLine": al,
                "adRatio": 320.0 / 180.0 if net >= 0 else 180.0 / 320.0,
            }
        )
    return {
        "asOfUtcSec": as_of,
        "barSeconds": 300,
        "closedBarCount": len(series),
        "excludedFutureCount": 0,
        "series": series,
        "latestAdNet": series[-1]["adNet"] if series else None,
        "latestAdLine": series[-1]["adLine"] if series else None,
        "latestAdRatio": series[-1]["adRatio"] if series else None,
        "indexSwingHighs": [],
        "indexSwingLows": [],
        "divergences": [],
        "latestDivergence": None,
        "divergenceStatus": div_status,
    }


def make_macro_vol_stub(
    as_of: int,
    vix_regime: str,
    vix_level: float | None,
    vix_slope: float | None,
    skew_level: float | None,
    tail_alert: bool,
    multiplier: float | None,
) -> dict[str, Any]:
    return {
        "asOfUtcSec": as_of,
        "closedVixCount": 10 if vix_level is not None else 0,
        "excludedFutureVixCount": 0,
        "closedSkewCount": 10 if skew_level is not None else 0,
        "excludedFutureSkewCount": 0,
        "vixLevel": vix_level,
        "vixSlope": vix_slope,
        "cboeSkewLevel": skew_level,
        "vixRegime": vix_regime,
        "tailRiskAlert": tail_alert,
        "baseVixFactor": multiplier,
        "vixSlopePenaltyFactor": 1.0 if vix_regime != "INSUFFICIENT_DATA" else None,
        "skewPenaltyFactor": 1.0 if vix_regime != "INSUFFICIENT_DATA" else None,
        "positionSizeMultiplier": multiplier,
    }


def make_rv_stub(
    as_of: int,
    status: str,
    rv_ann: float | None,
    rv_cent: float | None,
) -> dict[str, Any]:
    return {
        "status": status,
        "asOfUtcSec": as_of,
        "barSeconds": 300,
        "annualizationFactor": ANNUALIZATION_FACTOR_5M,
        "closedRthBarCount": 78 if status == "OK" else 20,
        "excludedFutureCount": 0,
        "excludedNonRthCount": 0,
        "sessionCount": 1,
        "totalAvailableReturns": 77 if status == "OK" else 19,
        "returnsCount": 77 if status == "OK" else 19,
        "meanLogReturn": 0.0001 if status == "OK" else None,
        "realizedVolAnnualized": rv_ann,
        "rvCenteredAnnualized": rv_cent,
        "sessions": [{"sessionDate": "2025-03-10", "rthBarCount": 78 if status == "OK" else 20, "returnsCount": 77 if status == "OK" else 19}],
    }


def generate_confluence_scenarios() -> list[dict[str, Any]]:
    as_of = utc_ts(2025, 3, 10, 11, 0)
    scenarios = []

    # 1. All 6 pillars aligned strongly bullish + OK envelopeStatus (all key auxiliary metrics finite)
    s1_inputs = {
        "mtf": make_mtf_stub("BULLISH_REGIME", True, as_of, sma200=560.0, sma50=578.0, ema21=591.5, hma55=593.2, close5m=595.0),
        "exposure": make_exposure_stub(as_of, spot=595.0, net_gex=12_500_000.0, net_dex=48_000_000.0, gamma_flip=588.0, call_wall=605.0, put_wall=580.0, expected_move=4.85, iv_atm=0.195),
        "volMetrics": make_vol_metrics_stub(iv_atm=0.195, rr25=-0.025, bf25=0.011),
        "openingAuction": make_opening_stub(as_of, "OPEN_DRIVE", "BULLISH", "SHORT_COVERING_RISK", pmh=594.0, pml=587.0, on_poc=590.5, on_vah=593.0, on_val=589.5, ibh=596.0, ibl=590.0, close_px=595.0),
        "cvdAbsorption": make_cvd_stub(as_of, "2025-03-10", 82000.0, [("2025-03-10", "BUY_ABSORPTION")]),
        "rsiDivergences": make_rsi_div_stub(as_of, "OK", 61.5, "RSI_HIDDEN_BULLISH", as_of - 900),
        "smtDivergences": make_smt_div_stub(as_of, "OK", "SMT_BULLISH", as_of - 300),
        "breadth": make_breadth_stub(as_of, [-40.0, -10.0, 25.0, 70.0, 120.0], "BULLISH_BREADTH_DIVERGENCE"),
        "macroVol": make_macro_vol_stub(as_of, "LOW_VOL_COMPLACENCY", 13.4, -0.25, 130.0, False, 1.0),
        "realizedVol": make_rv_stub(as_of, "OK", 0.145, 0.1442),
        "referenceLevels": {"pdh": 594.0, "pdl": 584.0, "pdc": 589.0},
        "options": {"asOfUtcSec": as_of},
    }
    s1_meta = {"symbol": "SPY", "generatedAtUtcSec": as_of, "timeframe": "5m", "sessionDate": "2025-03-10", "asOfUtcSec": as_of}
    s1_snap = py_evaluate_confluence(s1_inputs)
    scenarios.append({
        "name": "full_bullish_positive_gamma_ok",
        "inputs": s1_inputs,
        "metadata": s1_meta,
        "expectedSnapshot": s1_snap,
        "expectedEnvelope": py_serialize_snapshot(s1_snap, s1_meta),
    })

    # 2. Mixed bearish, negative gamma, custom weights, PARTIAL due to missing realizedVol/vixSlope (NaN -> null)
    s2_inputs = {
        "mtf": make_mtf_stub("BEARISH_REGIME", False, as_of, sma200=598.0, sma50=586.0, ema21=575.5, hma55=573.8, close5m=572.0),
        "exposure": make_exposure_stub(as_of, spot=572.0, net_gex=-18_000_000.0, net_dex=-62_000_000.0, gamma_flip=580.0, call_wall=585.0, put_wall=560.0, expected_move=7.25, iv_atm=0.28),
        "volMetrics": make_vol_metrics_stub(iv_atm=0.28, rr25=0.042, bf25=0.019),
        "openingAuction": make_opening_stub(as_of, "OPEN_AUCTION", "NEUTRAL", "LONG_LIQUIDATION_RISK", pmh=579.0, pml=571.0, on_poc=576.0, on_vah=577.5, on_val=574.0, ibh=577.0, ibl=571.5, close_px=572.0),
        "cvdAbsorption": make_cvd_stub(as_of, "2025-03-10", -45000.0, [("2025-03-10", "BUY_ABSORPTION")]),
        "rsiDivergences": make_rsi_div_stub(as_of, "OK", 39.2, "RSI_REGULAR_BEARISH", as_of - 600),
        "smtDivergences": make_smt_div_stub(as_of, "INSUFFICIENT_DATA"),
        "breadth": make_breadth_stub(as_of, [100.0, 65.0, 20.0, -30.0, -90.0], "BEARISH_BREADTH_DIVERGENCE"),
        "macroVol": make_macro_vol_stub(as_of, "ELEVATED_VOL_EXPANSION", 24.5, None, 148.0, True, 0.442),
        "realizedVol": make_rv_stub(as_of, "NO_DATA", None, None),
        "referenceLevels": {"pdh": 581.0, "pdl": 570.5, "pdc": 577.0},
        "options": {
            "asOfUtcSec": as_of,
            "adSlopeWindow": 4,
            "weights": {
                "mtf": 2.0,
                "optionsPositioning": 2.0,
                "openingAuction": 1.0,
                "cvdAbsorption": 1.5,
                "divergences": 1.0,
                "breadthMacro": 1.5,
            },
        },
    }
    s2_meta = {"symbol": "QQQ", "generatedAtUtcSec": as_of, "timeframe": "5m"}
    s2_snap = py_evaluate_confluence(s2_inputs)
    scenarios.append({
        "name": "mixed_bearish_negative_gamma_partial_custom_weights",
        "inputs": s2_inputs,
        "metadata": s2_meta,
        "expectedSnapshot": s2_snap,
        "expectedEnvelope": py_serialize_snapshot(s2_snap, s2_meta),
    })

    # 3. Pre-market pending open + missing exposure/macroVol + zero/invalid levels filtered out -> PARTIAL
    as_of_pm = utc_ts(2025, 3, 10, 9, 15)
    s3_inputs = {
        "mtf": make_mtf_stub("CONFLICTED_NO_SETUP", False, as_of_pm, sma200=580.0, sma50=None if False else 585.0, ema21=583.0, hma55=583.5, close5m=583.2),
        "exposure": None,
        "volMetrics": make_vol_metrics_stub(iv_atm=0.17, rr25=0.015, bf25=0.01),
        "openingAuction": make_opening_stub(as_of_pm, "PENDING_OPEN", "NEUTRAL", "NEUTRAL", rth_count=0, pmh=584.5, pml=581.0, on_poc=582.5, on_vah=583.8, on_val=581.5, ibh=None, ibl=None, close_px=None),
        "cvdAbsorption": make_cvd_stub(as_of_pm, "2025-03-10", 0.0, []),
        "rsiDivergences": make_rsi_div_stub(as_of_pm, "OK", 50.0, None, None),
        "smtDivergences": make_smt_div_stub(as_of_pm, "INSUFFICIENT_DATA"),
        "breadth": make_breadth_stub(as_of_pm, [10.0, 22.0, 35.0], "INSUFFICIENT_DATA"),
        "macroVol": make_macro_vol_stub(as_of_pm, "INSUFFICIENT_DATA", None, None, None, False, None),
        "realizedVol": make_rv_stub(as_of_pm, "OK", 0.13, 0.129),
        "referenceLevels": {"pdh": 0.0, "pdl": -1.0, "pdc": 582.0},
        "options": {"asOfUtcSec": as_of_pm, "iv30dOverride": 0.17},
    }
    s3_meta = {"symbol": "SPY", "generatedAtUtcSec": as_of_pm}
    s3_snap = py_evaluate_confluence(s3_inputs)
    scenarios.append({
        "name": "pending_open_conflicted_partial_missing_macro",
        "inputs": s3_inputs,
        "metadata": s3_meta,
        "expectedSnapshot": s3_snap,
        "expectedEnvelope": py_serialize_snapshot(s3_snap, s3_meta),
    })

    # 4. TRANSITION_ZONE + stale absorption event from yesterday ignored + more recent RSI overrides older SMT
    s4_inputs = {
        "mtf": make_mtf_stub("BULLISH_REGIME", False, as_of, sma200=570.0, sma50=576.0, ema21=581.0, hma55=582.5, close5m=583.0),
        "exposure": make_exposure_stub(as_of, spot=583.0, net_gex=-400_000.0, net_dex=12_000_000.0, gamma_flip=580.0, call_wall=590.0, put_wall=570.0, expected_move=3.9, iv_atm=0.16),
        "volMetrics": make_vol_metrics_stub(iv_atm=0.16, rr25=-0.01, bf25=0.008),
        "openingAuction": make_opening_stub(as_of, "OPEN_TEST_DRIVE", "BULLISH", "NEUTRAL", pmh=582.0, pml=578.0, on_poc=580.5, on_vah=581.5, on_val=579.0, ibh=584.0, ibl=579.5, close_px=583.0),
        "cvdAbsorption": make_cvd_stub(as_of, "2025-03-10", 18000.0, [("2025-03-07", "SELL_ABSORPTION")]),
        "rsiDivergences": make_rsi_div_stub(as_of, "OK", 56.0, "RSI_REGULAR_BULLISH", as_of - 300),
        "smtDivergences": make_smt_div_stub(as_of, "OK", "SMT_BEARISH", as_of - 1800),
        "breadth": make_breadth_stub(as_of, [5.0, 15.0, 25.0, 35.0, 45.0], "NONE"),
        "macroVol": make_macro_vol_stub(as_of, "NORMAL_VOL_REGIME", 18.2, 0.4, 138.0, False, 0.72),
        "realizedVol": make_rv_stub(as_of, "OK", 0.14, 0.139),
    }
    s4_meta = {"symbol": "I:SPX", "generatedAtUtcSec": as_of, "sessionDate": "2025-03-10"}
    s4_snap = py_evaluate_confluence(s4_inputs)
    scenarios.append({
        "name": "transition_zone_stale_absorption_ignored_ok",
        "inputs": s4_inputs,
        "metadata": s4_meta,
        "expectedSnapshot": s4_snap,
        "expectedEnvelope": py_serialize_snapshot(s4_snap, s4_meta),
    })

    # 5. Completely empty / NO_DATA inputs -> status 'NO_DATA', confluenceScore None(NaN), envelopeStatus 'NO_DATA'
    s5_inputs = {
        "mtf": None,
        "exposure": None,
        "volMetrics": None,
        "openingAuction": None,
        "cvdAbsorption": None,
        "rsiDivergences": make_rsi_div_stub(as_of, "INSUFFICIENT_DATA", None),
        "smtDivergences": make_smt_div_stub(as_of, "INSUFFICIENT_DATA"),
        "breadth": None,
        "macroVol": make_macro_vol_stub(as_of, "INSUFFICIENT_DATA", None, None, None, False, None),
        "realizedVol": make_rv_stub(as_of, "NO_DATA", None, None),
    }
    s5_meta = {"symbol": "SPY", "generatedAtUtcSec": as_of}
    s5_snap = py_evaluate_confluence(s5_inputs)
    scenarios.append({
        "name": "all_no_data_empty_snapshot",
        "inputs": s5_inputs,
        "metadata": s5_meta,
        "expectedSnapshot": s5_snap,
        "expectedEnvelope": py_serialize_snapshot(s5_snap, s5_meta),
    })

    return scenarios


def main() -> None:
    rv_multi = generate_multi_session_rv_bars()

    short_bars = [build_rv_bar(utc_ts(2025, 3, 10, 9, 30) + k * 300, 100.0 + 0.02 * k) for k in range(30)]
    rv_short = {
        "bars": short_bars,
        "asOfUtcSec": utc_ts(2025, 3, 10, 12, 30),
        "expected": py_compute_intraday_rv(short_bars, utc_ts(2025, 3, 10, 12, 30), min_returns=77),
    }

    corrupt_bars = [build_rv_bar(utc_ts(2025, 3, 10, 9, 30) + k * 300, 100.0 + 0.01 * k) for k in range(80)]
    corrupt_bars[40] = build_rv_bar(corrupt_bars[40]["time"], 0.0)
    rv_corrupt = {
        "bars": corrupt_bars,
        "asOfUtcSec": utc_ts(2025, 3, 10, 16, 10),
        "expected": py_compute_intraday_rv(corrupt_bars, utc_ts(2025, 3, 10, 16, 10), min_returns=50),
    }

    vrp_cases = [
        {"iv30d": 0.22, "rv": 0.16, "expected": py_compute_vrp(0.22, 0.16)},
        {"iv30d": 0.15, "rv": 0.24, "expected": py_compute_vrp(0.15, 0.24)},
        {"iv30d": 0.0, "rv": 0.16, "expected": py_compute_vrp(0.0, 0.16)},
        {"iv30d": 0.22, "rv": -0.05, "expected": py_compute_vrp(0.22, -0.05)},
        {"iv30d": None, "rv": 0.16, "expected": py_compute_vrp(None, 0.16)},
    ]

    confluence_scenarios = generate_confluence_scenarios()

    payload = {
        "meta": {
            "annualizationFactor5m": ANNUALIZATION_FACTOR_5M,
            "barSeconds5m": BAR_SECONDS_5M,
            "generatedBy": "tools/gen_terminal_confluence_fixture.py",
        },
        "realizedVolMultiSessionDst": rv_multi,
        "realizedVolShortage": rv_short,
        "realizedVolCorruptedClose": rv_corrupt,
        "vrpCases": vrp_cases,
        "confluenceScenarios": confluence_scenarios,
    }

    out_path = Path(__file__).resolve().parent.parent / "fixtures" / "terminal_confluence_reference.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8", newline="\n") as f:
        json.dump(payload, f, indent=2, allow_nan=False)
        f.write("\n")

    print(
        f"Generated {out_path.name}: "
        f"rv_full={rv_multi['fullResult']['realizedVolAnnualized']:.8f}, "
        f"rv_cent={rv_multi['fullResult']['rvCenteredAnnualized']:.8f}, "
        f"vrp={rv_multi['expectedVrpFull']:.8f}, "
        f"scenarios={len(confluence_scenarios)}"
    )


if __name__ == "__main__":
    main()
