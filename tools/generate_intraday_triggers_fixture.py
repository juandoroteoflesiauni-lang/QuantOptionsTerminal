#!/usr/bin/env python3
"""
Oráculo independiente (Decimal, prec=50) para Sub-fase 2 · Pieza 6 (`S2-3`):
  - FSM FVG / IFVG (6 estados exactos) sobre barras cerradas 1m y 5m
  - Tope determinista de hasta 3 zonas activas prioritarias
  - Detector causal de Liquidity Sweeps contra PDH/PDL, PMH/PML, ORH/ORL, CALL_WALL/PUT_WALL
  - Degradación honesta ante niveles ausentes / NaN / PROVISIONAL / UNAVAILABLE
  - Exclusión estricta de barras en formación e invariancia causal de prefijo

Salida: fixtures/intraday_triggers_sweeps_fvg_ifvg.json
"""

from __future__ import annotations

import json
import math
from decimal import Decimal, getcontext
from pathlib import Path
from typing import Any

getcontext().prec = 50

D = Decimal
ZERO = D("0")
ONE = D("1")
HALF = D("0.5")
TIE_EPS = D("1e-12")

SWEEP_LEVEL_ORDER = [
    "PDH",
    "PDL",
    "PMH",
    "PML",
    "ORH",
    "ORL",
    "CALL_WALL",
    "PUT_WALL",
]


def dec(v: Any) -> Decimal | None:
    if v is None:
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        if isinstance(v, float) and not math.isfinite(v):
            return None
        return D(str(v))
    if isinstance(v, str):
        try:
            res = D(v)
            return res if res.is_finite() else None
        except Exception:
            return None
    return None


def ffloat(d: Decimal | None) -> float | None:
    return None if d is None else float(d)


def clamp_ratio(val: Decimal) -> Decimal:
    if val <= ZERO:
        return ZERO
    if val >= ONE:
        return ONE
    return val


def bar_dict(t: int, o: float, h: float, l: float, c: float, v: float) -> dict[str, Any]:
    return {"time": t, "open": o, "high": h, "low": l, "close": c, "volume": v}


def is_valid_bar(b: dict[str, Any]) -> bool:
    t = b.get("time")
    if not isinstance(t, int) or isinstance(t, bool) or t <= 0:
        return False
    o = dec(b.get("open"))
    h = dec(b.get("high"))
    l = dec(b.get("low"))
    c = dec(b.get("close"))
    v = dec(b.get("volume"))
    if o is None or h is None or l is None or c is None or v is None:
        return False
    if o <= ZERO or h <= ZERO or l <= ZERO or c <= ZERO or v < ZERO:
        return False
    if h < l or h < o or h < c or l > o or l > c:
        return False
    return True


def eval_intraday_triggers(
    bars: list[dict[str, Any]],
    options: dict[str, Any],
) -> dict[str, Any]:
    tf = options["timeframe"]
    if tf == "1m":
        bar_sec = 60
    elif tf == "5m":
        bar_sec = 300
    else:
        return {
            "status": "UNSUPPORTED_TIMEFRAME",
            "methodology": "OHLCV",
            "timeframe": None,
            "barSeconds": None,
            "asOfUtcSec": options["asOfUtcSec"],
            "closedBarCount": 0,
            "excludedFormingOrFutureCount": 0,
            "referencePrice": None,
            "activeZones": [],
            "allZones": [],
            "visibleSweeps": [],
            "allSweeps": [],
        }

    as_of = int(options["asOfUtcSec"])
    min_abs_gap = dec(options.get("minAbsGap", 0.01)) or ZERO
    min_gap_ratio = dec(options.get("minGapRatio", 0.0004)) or ZERO
    min_disp_ratio = clamp_ratio(dec(options.get("minDisplacementBodyRatio", 0.45)) or ZERO)
    max_triplet_span = int(options.get("maxTripletSpanSec", 6 * bar_sec))
    max_age_default = 120 if tf == "1m" else 78
    max_age_bars = int(options.get("maxZoneAgeBars", max_age_default))
    max_active_zones = max(1, min(3, int(options.get("maxActiveZones", 3))))
    min_abs_exc = dec(options.get("minAbsSweepExcursion", 0)) or ZERO
    min_exc_ratio = dec(options.get("minSweepExcursionRatio", 0.0001)) or ZERO
    min_abs_rec = dec(options.get("minAbsSweepRecovery", 0)) or ZERO
    min_rec_ratio = dec(options.get("minSweepRecoveryRatio", 0.00005)) or ZERO
    sweep_cooldown = int(options.get("sweepCooldownBars", 3))
    max_visible_sweeps = int(options.get("maxVisibleSweeps", 6))

    deduped: dict[int, dict[str, Any]] = {}
    excluded = 0
    for b in bars:
        if not is_valid_bar(b):
            excluded += 1
            continue
        if b["time"] + bar_sec > as_of:
            excluded += 1
            continue
        deduped[b["time"]] = b
    closed = [deduped[t] for t in sorted(deduped.keys())]

    # Normalize reference levels
    raw_levels = options.get("referenceLevels", []) or []
    by_id: dict[str, dict[str, Any]] = {}
    for lvl in raw_levels:
        if lvl.get("status") in ("UNAVAILABLE", "PROVISIONAL"):
            continue
        p = dec(lvl.get("price"))
        if p is None or p <= ZERO:
            continue
        af = lvl.get("activeFromUtcSec")
        af_int = int(af) if isinstance(af, (int, float)) and math.isfinite(af) and af >= 0 else 0
        by_id[lvl["id"]] = {
            "id": lvl["id"],
            "side": lvl["side"],
            "price": p,
            "activeFromUtcSec": af_int,
        }
    levels = [by_id[lid] for lid in SWEEP_LEVEL_ORDER if lid in by_id]

    zones: list[dict[str, Any]] = []
    last_sweep_idx: dict[str, int] = {}
    sweeps: list[dict[str, Any]] = []

    for k, b in enumerate(closed):
        bo = dec(b["open"])
        bh = dec(b["high"])
        bl = dec(b["low"])
        bc = dec(b["close"])
        bt = int(b["time"])
        assert bo is not None and bh is not None and bl is not None and bc is not None

        # Step A: advance existing zones
        for z in zones:
            st = z["state"]
            if st in ("IFVG_MITIGATED", "EXPIRED"):
                continue
            age_anchor = z["invertedAtBarIndex"] if (z["isInverted"] and z["invertedAtBarIndex"] is not None) else z["formedAtBarIndex"]
            if k - age_anchor > max_age_bars:
                z["state"] = "EXPIRED"
                z["expiredAtTime"] = bt
                continue

            if st in ("ACTIVE_UNMITIGATED", "ACTIVE_PARTIALLY_MITIGATED"):
                if z["initialDirection"] == "BULLISH":
                    if bc < z["gapLow"]:
                        z["state"] = "INVERTED_IFVG_ACTIVE"
                        z["activeDirection"] = "BEARISH"
                        z["isInverted"] = True
                        z["mitigationRatio"] = ONE
                        z["ifvgMitigationRatio"] = ZERO
                        if z["mitigatedAtTime"] is None:
                            z["mitigatedAtTime"] = bt
                        z["invertedAtTime"] = bt
                        z["invertedAtBarIndex"] = k
                    elif bl <= z["gapLow"]:
                        z["state"] = "MITIGATED_FILLED"
                        z["mitigationRatio"] = ONE
                        z["mitigatedAtTime"] = bt
                    elif bl < z["gapHigh"]:
                        fill = clamp_ratio((z["gapHigh"] - bl) / z["gapWidth"])
                        if fill > z["mitigationRatio"]:
                            z["mitigationRatio"] = fill
                        z["state"] = "ACTIVE_PARTIALLY_MITIGATED"
                else:
                    if bc > z["gapHigh"]:
                        z["state"] = "INVERTED_IFVG_ACTIVE"
                        z["activeDirection"] = "BULLISH"
                        z["isInverted"] = True
                        z["mitigationRatio"] = ONE
                        z["ifvgMitigationRatio"] = ZERO
                        if z["mitigatedAtTime"] is None:
                            z["mitigatedAtTime"] = bt
                        z["invertedAtTime"] = bt
                        z["invertedAtBarIndex"] = k
                    elif bh >= z["gapHigh"]:
                        z["state"] = "MITIGATED_FILLED"
                        z["mitigationRatio"] = ONE
                        z["mitigatedAtTime"] = bt
                    elif bh > z["gapLow"]:
                        fill = clamp_ratio((bh - z["gapLow"]) / z["gapWidth"])
                        if fill > z["mitigationRatio"]:
                            z["mitigationRatio"] = fill
                        z["state"] = "ACTIVE_PARTIALLY_MITIGATED"
            elif st == "MITIGATED_FILLED":
                if z["initialDirection"] == "BULLISH" and bc < z["gapLow"]:
                    z["state"] = "INVERTED_IFVG_ACTIVE"
                    z["activeDirection"] = "BEARISH"
                    z["isInverted"] = True
                    z["ifvgMitigationRatio"] = ZERO
                    z["invertedAtTime"] = bt
                    z["invertedAtBarIndex"] = k
                elif z["initialDirection"] == "BEARISH" and bc > z["gapHigh"]:
                    z["state"] = "INVERTED_IFVG_ACTIVE"
                    z["activeDirection"] = "BULLISH"
                    z["isInverted"] = True
                    z["ifvgMitigationRatio"] = ZERO
                    z["invertedAtTime"] = bt
                    z["invertedAtBarIndex"] = k
            elif st == "INVERTED_IFVG_ACTIVE":
                if z["activeDirection"] == "BEARISH":
                    if bh >= z["gapHigh"] or bc > z["gapHigh"]:
                        z["state"] = "IFVG_MITIGATED"
                        z["ifvgMitigationRatio"] = ONE
                        z["ifvgMitigatedAtTime"] = bt
                    elif bh > z["gapLow"]:
                        fill = clamp_ratio((bh - z["gapLow"]) / z["gapWidth"])
                        if fill > z["ifvgMitigationRatio"]:
                            z["ifvgMitigationRatio"] = fill
                else:
                    if bl <= z["gapLow"] or bc < z["gapLow"]:
                        z["state"] = "IFVG_MITIGATED"
                        z["ifvgMitigationRatio"] = ONE
                        z["ifvgMitigatedAtTime"] = bt
                    elif bl < z["gapHigh"]:
                        fill = clamp_ratio((z["gapHigh"] - bl) / z["gapWidth"])
                        if fill > z["ifvgMitigationRatio"]:
                            z["ifvgMitigationRatio"] = fill

        # Step B: detect new FVG on 3rd closed candle
        if k >= 2:
            c0 = closed[k - 2]
            c1 = closed[k - 1]
            if bt - int(c0["time"]) <= max_triplet_span:
                c1o = dec(c1["open"])
                c1h = dec(c1["high"])
                c1l = dec(c1["low"])
                c1c = dec(c1["close"])
                c0h = dec(c0["high"])
                c0l = dec(c0["low"])
                assert c1o is not None and c1h is not None and c1l is not None and c1c is not None and c0h is not None and c0l is not None
                c1_range = c1h - c1l
                c1_body = abs(c1c - c1o)
                if c1_range > ZERO and c1_body >= min_disp_ratio * c1_range:
                    min_gap = max(min_abs_gap, min_gap_ratio * c1c)
                    if bl > c0h and c1c > c1o:
                        gap_w = bl - c0h
                        if gap_w >= min_gap and gap_w > ZERO:
                            zones.append({
                                "id": f"fvg:{tf}:{bt}:BULLISH",
                                "timeframe": tf,
                                "methodology": "OHLCV",
                                "state": "ACTIVE_UNMITIGATED",
                                "initialDirection": "BULLISH",
                                "activeDirection": "BULLISH",
                                "isInverted": False,
                                "anchorStartTime": int(c0["time"]),
                                "formedAtTime": bt,
                                "formedAtBarIndex": k,
                                "gapLow": c0h,
                                "gapHigh": bl,
                                "gapWidth": gap_w,
                                "midpoint": HALF * (c0h + bl),
                                "mitigationRatio": ZERO,
                                "ifvgMitigationRatio": ZERO,
                                "mitigatedAtTime": None,
                                "invertedAtTime": None,
                                "invertedAtBarIndex": None,
                                "ifvgMitigatedAtTime": None,
                                "expiredAtTime": None,
                            })
                    if bh < c0l and c1c < c1o:
                        gap_w = c0l - bh
                        if gap_w >= min_gap and gap_w > ZERO:
                            zones.append({
                                "id": f"fvg:{tf}:{bt}:BEARISH",
                                "timeframe": tf,
                                "methodology": "OHLCV",
                                "state": "ACTIVE_UNMITIGATED",
                                "initialDirection": "BEARISH",
                                "activeDirection": "BEARISH",
                                "isInverted": False,
                                "anchorStartTime": int(c0["time"]),
                                "formedAtTime": bt,
                                "formedAtBarIndex": k,
                                "gapLow": bh,
                                "gapHigh": c0l,
                                "gapWidth": gap_w,
                                "midpoint": HALF * (bh + c0l),
                                "mitigationRatio": ZERO,
                                "ifvgMitigationRatio": ZERO,
                                "mitigatedAtTime": None,
                                "invertedAtTime": None,
                                "invertedAtBarIndex": None,
                                "ifvgMitigatedAtTime": None,
                                "expiredAtTime": None,
                            })

        # Step C: detect causal Liquidity Sweeps
        prev_bar = closed[k - 1] if k > 0 else None
        for lvl in levels:
            if bt < lvl["activeFromUtcSec"]:
                continue
            li = last_sweep_idx.get(lvl["id"])
            if li is not None and k - li < sweep_cooldown:
                continue
            elig_prev = prev_bar if (prev_bar is not None and int(prev_bar["time"]) >= lvl["activeFromUtcSec"]) else None
            lp = lvl["price"]
            min_exc = max(min_abs_exc, min_exc_ratio * lp)
            min_rec = max(min_abs_rec, min_rec_ratio * lp)

            if lvl["side"] == "HIGH":
                if elig_prev is not None:
                    prev_c = dec(elig_prev["close"])
                    if prev_c is not None and prev_c > lp:
                        continue
                exc = bh - lp
                rec = lp - bc
                if bh > lp and bc < lp and exc >= min_exc and rec >= min_rec:
                    last_sweep_idx[lvl["id"]] = k
                    sweeps.append({
                        "id": f"sweep:{tf}:{bt}:{lvl['id']}",
                        "timeframe": tf,
                        "methodology": "OHLCV",
                        "provenanceLabel": "OHLCV_WICK_CLOSE_RECOVERY",
                        "levelId": lvl["id"],
                        "levelSide": "HIGH",
                        "direction": "BEARISH",
                        "levelPrice": float(lp),
                        "barTime": bt,
                        "barIndex": k,
                        "wickExtreme": float(bh),
                        "closePrice": float(bc),
                        "wickExcursion": float(exc),
                        "closeRecovery": float(rec),
                    })
            else:
                if elig_prev is not None:
                    prev_c = dec(elig_prev["close"])
                    if prev_c is not None and prev_c < lp:
                        continue
                exc = lp - bl
                rec = bc - lp
                if bl < lp and bc > lp and exc >= min_exc and rec >= min_rec:
                    last_sweep_idx[lvl["id"]] = k
                    sweeps.append({
                        "id": f"sweep:{tf}:{bt}:{lvl['id']}",
                        "timeframe": tf,
                        "methodology": "OHLCV",
                        "provenanceLabel": "OHLCV_WICK_CLOSE_RECOVERY",
                        "levelId": lvl["id"],
                        "levelSide": "LOW",
                        "direction": "BULLISH",
                        "levelPrice": float(lp),
                        "barTime": bt,
                        "barIndex": k,
                        "wickExtreme": float(bl),
                        "closePrice": float(bc),
                        "wickExcursion": float(exc),
                        "closeRecovery": float(rec),
                    })

    ref_explicit = dec(options.get("referencePrice"))
    if ref_explicit is not None:
        ref_price: Decimal | None = ref_explicit
    elif closed:
        ref_price = dec(closed[-1]["close"])
    else:
        ref_price = None

    def dist_zone(gl: Decimal, gh: Decimal) -> Decimal | None:
        if ref_price is None:
            return None
        if ref_price >= gl and ref_price <= gh:
            return ZERO
        if ref_price < gl:
            return gl - ref_price
        return ref_price - gh

    all_zones_out: list[dict[str, Any]] = []
    for z in zones:
        d_val = dist_zone(z["gapLow"], z["gapHigh"])
        all_zones_out.append({
            "id": z["id"],
            "timeframe": z["timeframe"],
            "methodology": "OHLCV",
            "state": z["state"],
            "initialDirection": z["initialDirection"],
            "activeDirection": z["activeDirection"],
            "isInverted": z["isInverted"],
            "anchorStartTime": z["anchorStartTime"],
            "formedAtTime": z["formedAtTime"],
            "formedAtBarIndex": z["formedAtBarIndex"],
            "gapLow": float(z["gapLow"]),
            "gapHigh": float(z["gapHigh"]),
            "gapWidth": float(z["gapWidth"]),
            "midpoint": float(z["midpoint"]),
            "mitigationRatio": float(z["mitigationRatio"]),
            "ifvgMitigationRatio": float(z["ifvgMitigationRatio"]),
            "mitigatedAtTime": z["mitigatedAtTime"],
            "invertedAtTime": z["invertedAtTime"],
            "invertedAtBarIndex": z["invertedAtBarIndex"],
            "ifvgMitigatedAtTime": z["ifvgMitigatedAtTime"],
            "expiredAtTime": z["expiredAtTime"],
            "distanceToPrice": ffloat(d_val),
            "_d_dec": d_val,
            "_rem_dec": ONE - (z["ifvgMitigationRatio"] if z["isInverted"] else z["mitigationRatio"]),
            "_ev_t": z["invertedAtTime"] if z["invertedAtTime"] is not None else z["formedAtTime"],
            "_gl_dec": z["gapLow"],
        })

    active_candidates = [
        z for z in all_zones_out
        if z["state"] in ("ACTIVE_UNMITIGATED", "ACTIVE_PARTIALLY_MITIGATED", "INVERTED_IFVG_ACTIVE")
    ]

    # Exact deterministic ranking parity via bubble/merge comparator matching TS sort with TIE_EPS
    from functools import cmp_to_key

    def cmp_active(a: dict[str, Any], b: dict[str, Any]) -> int:
        da = a["_d_dec"]
        db = b["_d_dec"]
        if da is None and db is not None:
            return 1
        if da is not None and db is None:
            return -1
        if da is not None and db is not None and abs(da - db) > TIE_EPS:
            return -1 if da < db else 1

        ra = a["_rem_dec"]
        rb = b["_rem_dec"]
        if abs(ra - rb) > TIE_EPS:
            return -1 if rb < ra else 1

        ea = a["_ev_t"]
        eb = b["_ev_t"]
        if ea != eb:
            return -1 if eb < ea else 1

        ga = a["_gl_dec"]
        gb = b["_gl_dec"]
        if ga != gb:
            return -1 if ga < gb else 1
        return 0

    active_candidates.sort(key=cmp_to_key(cmp_active))

    def strip_priv(z: dict[str, Any]) -> dict[str, Any]:
        return {k: v for k, v in z.items() if not k.startswith("_")}

    active_zones_out = [strip_priv(z) for z in active_candidates[:max_active_zones]]
    all_zones_clean = [strip_priv(z) for z in all_zones_out]
    visible_sweeps = sweeps[-max_visible_sweeps:] if len(sweeps) > max_visible_sweeps else list(sweeps)

    return {
        "status": "NO_CLOSED_BARS" if len(closed) == 0 else "OK",
        "methodology": "OHLCV",
        "timeframe": tf,
        "barSeconds": bar_sec,
        "asOfUtcSec": as_of,
        "closedBarCount": len(closed),
        "excludedFormingOrFutureCount": excluded,
        "referencePrice": ffloat(ref_price),
        "activeZones": active_zones_out,
        "allZones": all_zones_clean,
        "visibleSweeps": visible_sweeps,
        "allSweeps": sweeps,
    }


def build_scenarios() -> list[dict[str, Any]]:
    # 2026-06-10 09:30:00 ET (EDT -04:00) = 13:30:00 UTC = 1781098200
    t0 = 1781098200

    # 1. All 6 FSM states in bullish and bearish orientations (1m, maxZoneAgeBars=10)
    s1_bars = [
        # k=0..2: Bearish FVG #0 formed high up at [120, 122] -> will EXPIRE after k=12
        bar_dict(t0 + 0 * 60, 122.5, 123.0, 122.0, 122.1, 100),
        bar_dict(t0 + 1 * 60, 122.0, 122.2, 119.5, 119.6, 220),
        bar_dict(t0 + 2 * 60, 119.6, 120.0, 119.0, 119.1, 150),
        # k=3..5: Bullish FVG #1 [119.4, 120.8] -> k=6 partial fill -> k=7 MITIGATED_FILLED -> k=8 INVERTED_IFVG_ACTIVE -> k=9 IFVG_MITIGATED
        bar_dict(t0 + 3 * 60, 119.1, 119.4, 118.8, 119.3, 140),
        bar_dict(t0 + 4 * 60, 119.3, 121.6, 119.2, 121.4, 300),
        bar_dict(t0 + 5 * 60, 121.4, 122.0, 120.8, 121.8, 180),
        # k=6: touches into [119.4, 120.8] down to 120.1 (partial fill)
        bar_dict(t0 + 6 * 60, 121.8, 121.9, 120.1, 121.0, 160),
        # k=7: wick all the way through 119.4 down to 119.2, closes >= 119.4 -> MITIGATED_FILLED
        bar_dict(t0 + 7 * 60, 121.0, 121.1, 119.2, 119.6, 170),
        # k=8: breaks and closes below 119.4 -> INVERTED_IFVG_ACTIVE (Bearish IFVG [119.4, 120.8])
        bar_dict(t0 + 8 * 60, 119.6, 119.8, 118.5, 118.7, 210),
        # k=9: pushes back up >= 120.8 -> IFVG_MITIGATED
        bar_dict(t0 + 9 * 60, 118.7, 121.0, 118.6, 120.9, 240),
        # k=10..12: Bearish FVG #2 formed below at [115.0, 117.0] -> stays ACTIVE_UNMITIGATED or inverted -> wait: keep clean!
        bar_dict(t0 + 10 * 60, 117.5, 118.0, 117.0, 117.2, 140),
        bar_dict(t0 + 11 * 60, 117.2, 117.4, 114.2, 114.4, 320),
        bar_dict(t0 + 12 * 60, 114.4, 115.0, 113.8, 114.0, 190),
        # k=13: Bearish FVG #0 (age 13-2=11 > 10) becomes EXPIRED! Bearish FVG #2 partial fill to 116.0
        bar_dict(t0 + 13 * 60, 114.0, 116.0, 113.9, 114.5, 160),
        # k=14..16: Bullish FVG #3 [114.8, 115.6] stays ACTIVE_UNMITIGATED
        bar_dict(t0 + 14 * 60, 114.5, 114.8, 114.1, 114.7, 130),
        bar_dict(t0 + 15 * 60, 114.7, 116.1, 114.6, 115.9, 280),
        bar_dict(t0 + 16 * 60, 115.9, 116.5, 115.6, 116.3, 150),
        # k=17..19: Bearish FVG #4 [112.0, 113.5] -> k=20 closed above 113.5 -> INVERTED_IFVG_ACTIVE (Bullish IFVG)
        bar_dict(t0 + 17 * 60, 114.0, 114.2, 113.5, 113.6, 120),
        bar_dict(t0 + 18 * 60, 113.6, 113.7, 111.0, 111.2, 310),
        bar_dict(t0 + 19 * 60, 111.2, 112.0, 110.8, 111.5, 160),
        bar_dict(t0 + 20 * 60, 111.5, 114.1, 111.4, 113.9, 290),
        # k=21: Partial retest of Bullish IFVG #4 (low 112.8 > 112.0), Bearish FVG #2 also hits >= 117.0 at k=15? wait k=15 high=116.1 (< 117.0) so #2 stays ACTIVE_PARTIALLY_MITIGATED until age=10 expires at k=23!
        bar_dict(t0 + 21 * 60, 113.9, 114.2, 112.8, 113.4, 150),
        # k=22..24: Bullish FVG [113.6, 114.5] -> k=25 touches down to 113.5 and closes >= 113.6 -> stays MITIGATED_FILLED!
        bar_dict(t0 + 22 * 60, 113.4, 113.6, 113.1, 113.5, 130),
        bar_dict(t0 + 23 * 60, 113.5, 115.0, 113.4, 114.9, 260),
        bar_dict(t0 + 24 * 60, 114.9, 115.2, 114.5, 114.8, 140),
        bar_dict(t0 + 25 * 60, 114.8, 114.9, 113.5, 113.8, 180),
        # k=26..28: Final fresh Bullish FVG [114.0, 114.8] -> k=29 dips into 114.4 (ACTIVE_PARTIALLY_MITIGATED), leaving k=21 ACTIVE_UNMITIGATED!
        bar_dict(t0 + 26 * 60, 113.8, 114.0, 113.7, 113.9, 110),
        bar_dict(t0 + 27 * 60, 113.9, 115.4, 113.8, 115.2, 250),
        bar_dict(t0 + 28 * 60, 115.2, 115.6, 114.8, 115.4, 140),
        bar_dict(t0 + 29 * 60, 115.4, 115.5, 114.4, 114.7, 160),
    ]
    s1_opts = {
        "timeframe": "1m",
        "asOfUtcSec": t0 + 30 * 60,
        "maxZoneAgeBars": 12,
        "maxActiveZones": 3,
    }

    # 2. Max 3 active zones deterministic ranking in 5m (5+ simultaneous active zones)
    t5 = t0
    s2_bars = [
        # Zone 1 Bullish FVG [100.5, 101.5]
        bar_dict(t5 + 0 * 300, 100.0, 100.5, 99.8, 100.4, 1000),
        bar_dict(t5 + 1 * 300, 100.4, 102.2, 100.3, 102.0, 2000),
        bar_dict(t5 + 2 * 300, 102.0, 102.5, 101.5, 102.3, 1500),
        # Zone 2 Bullish FVG [102.5, 103.5]
        bar_dict(t5 + 3 * 300, 102.3, 104.2, 102.2, 104.0, 2100),
        bar_dict(t5 + 4 * 300, 104.0, 104.5, 103.5, 104.3, 1400),
        # Zone 3 Bullish FVG [104.5, 105.5]
        bar_dict(t5 + 5 * 300, 104.3, 106.2, 104.2, 106.0, 2200),
        bar_dict(t5 + 6 * 300, 106.0, 106.5, 105.5, 106.2, 1600),
        # Zone 4 Bullish FVG [106.5, 107.5]
        bar_dict(t5 + 7 * 300, 106.2, 108.2, 106.1, 108.0, 2300),
        bar_dict(t5 + 8 * 300, 108.0, 108.5, 107.5, 108.2, 1500),
        # Zone 5 Bearish FVG -> inverted to Bullish IFVG near top [109.0, 110.0]
        bar_dict(t5 + 9 * 300, 110.2, 110.6, 110.0, 110.1, 1200),
        bar_dict(t5 + 10 * 300, 110.1, 110.2, 108.1, 108.3, 2500),
        bar_dict(t5 + 11 * 300, 108.3, 109.0, 108.0, 108.8, 1400),
        bar_dict(t5 + 12 * 300, 108.8, 110.5, 108.7, 110.3, 2400),
        # Partial fill on Zone 4? Close stays 107.2 inside [106.5, 107.5]
        bar_dict(t5 + 13 * 300, 110.3, 110.4, 107.1, 107.2, 1700),
    ]
    s2_opts = {
        "timeframe": "5m",
        "asOfUtcSec": t5 + 14 * 300,
        "maxZoneAgeBars": 40,
        "maxActiveZones": 3,
    }

    # 3. Causal Liquidity Sweeps + Missing/Provisional/NaN/Unavailable levels + Non-sweep breakout
    s3_bars = [
        # k=0 (t0+0): before ORH activeFrom (t0+900), pierces above 202.0 -> MUST BE IGNORED
        bar_dict(t0 + 0 * 60, 200.5, 202.8, 200.2, 201.0, 500),
        # k=1 (t0+60): sweeps PDL (198.0): low=197.6, close=198.4 -> BULLISH sweep of PDL
        bar_dict(t0 + 1 * 60, 199.0, 199.4, 197.6, 198.4, 800),
        # k=2 (t0+120): sweeps PDH (205.0): high=205.6, close=204.5 -> BEARISH sweep of PDH
        bar_dict(t0 + 2 * 60, 204.2, 205.6, 203.9, 204.5, 900),
        # k=3 (t0+180): immediate re-touch of PDH inside cooldown=3 (3-2=1 < 3) -> MUST BE IGNORED
        bar_dict(t0 + 3 * 60, 204.5, 205.4, 204.1, 204.6, 600),
        # k=4 (t0+240): sweeps CALL_WALL (206.0) + close < 206.0
        bar_dict(t0 + 4 * 60, 204.6, 206.7, 204.4, 205.2, 950),
        # k=5..14 filler before ORH becomes definitive at t0+900
        bar_dict(t0 + 14 * 60, 201.5, 201.9, 200.8, 201.2, 400),
        # k=6 (t0+900): ORH active! Pierces ORH (202.0) and closes below -> BEARISH sweep of ORH
        bar_dict(t0 + 15 * 60, 201.2, 202.5, 201.1, 201.6, 700),
        # k=7 (t0+960): breaks DOWN through ORL (199.5) and closes at 198.8 (no recovery!) -> NOT a sweep
        bar_dict(t0 + 16 * 60, 200.0, 200.1, 198.6, 198.8, 850),
    ]
    s3_levels = [
        {"id": "PDH", "side": "HIGH", "price": 205.0, "status": "DEFINITIVE", "activeFromUtcSec": t0 - 3600},
        {"id": "PDL", "side": "LOW", "price": 198.0, "status": "DEFINITIVE", "activeFromUtcSec": t0 - 3600},
        {"id": "PMH", "side": "HIGH", "price": None, "status": "UNAVAILABLE", "activeFromUtcSec": t0},
        {"id": "PML", "side": "LOW", "price": float("nan"), "status": "DEFINITIVE", "activeFromUtcSec": t0},
        {"id": "ORH", "side": "HIGH", "price": 202.0, "status": "DEFINITIVE", "activeFromUtcSec": t0 + 900},
        {"id": "ORL", "side": "LOW", "price": 199.5, "status": "DEFINITIVE", "activeFromUtcSec": t0 + 900},
        {"id": "CALL_WALL", "side": "HIGH", "price": 206.0, "status": "DEFINITIVE", "activeFromUtcSec": t0},
        {"id": "PUT_WALL", "side": "LOW", "price": 196.0, "status": "PROVISIONAL", "activeFromUtcSec": t0},
    ]
    s3_opts = {
        "timeframe": "1m",
        "asOfUtcSec": t0 + 17 * 60,
        "referenceLevels": s3_levels,
        "sweepCooldownBars": 3,
    }

    # 4. Forming bar exclusion + causal prefix invariance
    s4_bars_full = [
        bar_dict(t0 + 0 * 60, 100.0, 100.4, 99.7, 100.2, 100),
        bar_dict(t0 + 1 * 60, 100.2, 102.2, 100.1, 102.0, 300),
        bar_dict(t0 + 2 * 60, 102.0, 102.4, 101.4, 102.1, 180),  # Bullish FVG [100.4, 101.4]
        bar_dict(t0 + 3 * 60, 102.1, 102.3, 101.0, 101.7, 150),  # Partial fill
        # Forming bar at t0 + 4*60: ends at t0 + 5*60, with asOfUtcSec = t0 + 4*60 + 30 -> MUST BE EXCLUDED!
        bar_dict(t0 + 4 * 60, 101.7, 101.8, 99.0, 99.2, 400),
    ]
    s4_opts = {
        "timeframe": "1m",
        "asOfUtcSec": t0 + 4 * 60 + 30,
        "referenceLevels": [
            {"id": "PDL", "side": "LOW", "price": 100.0, "status": "DEFINITIVE", "activeFromUtcSec": t0},
        ],
    }

    scenarios_raw = [
        ("fsm_all_six_states_bullish_and_bearish_1m", s1_bars, s1_opts),
        ("active_zones_cap_max_3_priority_5m", s2_bars, s2_opts),
        ("causal_liquidity_sweeps_and_missing_levels_1m", s3_bars, s3_opts),
        ("forming_bar_exclusion_and_prefix_invariance", s4_bars_full, s4_opts),
    ]

    scenarios_out = []
    for name, bars, opts in scenarios_raw:
        # Clean JSON-safe copy of levels (NaN -> null for JSON storage; test checks both NaN & null)
        json_opts = json.loads(json.dumps(opts, allow_nan=True))
        if "referenceLevels" in opts:
            cleaned_lvls = []
            for l in opts["referenceLevels"]:
                p = l["price"]
                cleaned_lvls.append({
                    **l,
                    "price": None if (p is None or (isinstance(p, float) and not math.isfinite(p))) else p,
                })
            json_opts["referenceLevels"] = cleaned_lvls
        scenarios_out.append({
            "name": name,
            "bars": bars,
            "options": json_opts,
            "expected": eval_intraday_triggers(bars, opts),
        })
    return scenarios_out


def main() -> None:
    payload = {
        "meta": {
            "generator": "tools/generate_intraday_triggers_fixture.py",
            "decimalPrecision": 50,
            "tolerance": 1e-9,
            "methodology": "OHLCV",
        },
        "scenarios": build_scenarios(),
    }
    out_path = Path(__file__).resolve().parent.parent / "fixtures" / "intraday_triggers_sweeps_fvg_ifvg.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n", encoding="utf-8")
    print(f"Wrote {out_path} ({len(payload['scenarios'])} scenarios)")


if __name__ == "__main__":
    main()
