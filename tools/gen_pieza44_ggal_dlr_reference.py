#!/usr/bin/env python3
"""
Pieza 44 — Generador de fixture de referencia matemática independiente en Python.

Calcula desde cero (sin copiar lógica TypeScript) los casos de referencia (tolerancia <= 1e-9) para:
  1. Ventanas regresivas FMP Enterprise y merge/dedup UTC para 15m/1H/4H (14 meses / pre-gap electoral).
  2. Repricing teórico BSM individual por strike/moneyness/DTE/IV con spot_teorico = adr * ccl / 10.
  3. Métricas Futuros ROFEX DLR fuera de rueda usando prioridad SE -> CL -> LA (`CIERRE_AJUSTE`) + Base ARS.
  4. Algoritmo geométrico de anti-colisión de etiquetas SVG en curva de bonos soberanos.
  5. Guardias de coherencia ARS vs USD para overlays/niveles en `GgalDualChartView` y Max Pain US ADR.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
OUT_PATH = ROOT / "fixtures" / "pieza44_ggal_dlr_reference.json"

SECONDS_PER_DAY = 86_400
DAYS_PER_YEAR = 365.0


def norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def bsm_price_and_greeks(
    spot: float,
    strike: float,
    t_years: float,
    rate: float,
    div_yield: float,
    vol: float,
    opt_type: str,
) -> tuple[float, float, float]:
    sqrt_t = math.sqrt(t_years)
    d1 = (math.log(spot / strike) + (rate - div_yield + 0.5 * vol * vol) * t_years) / (vol * sqrt_t)
    d2 = d1 - vol * sqrt_t
    df_q = math.exp(-div_yield * t_years)
    df_r = math.exp(-rate * t_years)
    if opt_type == "call":
        price = spot * df_q * norm_cdf(d1) - strike * df_r * norm_cdf(d2)
        delta = df_q * norm_cdf(d1)
    else:
        price = strike * df_r * norm_cdf(-d2) - spot * df_q * norm_cdf(-d1)
        delta = df_q * (norm_cdf(d1) - 1.0)
    gamma = (df_q * norm_pdf(d1)) / (spot * vol * sqrt_t)
    return price, delta, gamma


def plan_windows_ref(from_sec: int, to_sec: int, window_days: int, overlap_days: int = 1) -> list[dict[str, int]]:
    span = window_days * SECONDS_PER_DAY
    overlap = overlap_days * SECONDS_PER_DAY
    windows: list[dict[str, int]] = []
    cur = to_sec
    for _ in range(2_000):
        start = max(from_sec, cur - span)
        windows.append({"fromUtcSec": start, "toUtcSec": cur})
        if start <= from_sec:
            break
        nxt = min(cur - 1, start + overlap)
        if nxt >= cur:
            break
        cur = nxt
    return windows


def merge_pages_ref(pages: list[list[dict[str, Any]]], from_sec: int, to_sec: int) -> list[dict[str, Any]]:
    by_time: dict[int, dict[str, Any]] = {}
    for page in pages:
        for b in page:
            t = int(b["time"])
            if t < from_sec or t > to_sec:
                continue
            if b["open"] <= 0 or b["high"] <= 0 or b["low"] <= 0 or b["close"] <= 0 or b["volume"] < 0:
                continue
            by_time[t] = dict(b)
    return [by_time[k] for k in sorted(by_time.keys())]


def build_fmp_pagination_cases() -> dict[str, Any]:
    # 14 meses regresivos cubriendo el gap electoral (2025-10-27 UTC)
    now_sec = 1795132800  # 2026-11-20T00:00:00Z
    from_sec = now_sec - 430 * SECONDS_PER_DAY
    windows_15m = plan_windows_ref(from_sec, now_sec, 14, 1)
    windows_1h = plan_windows_ref(from_sec, now_sec, 30, 1)
    windows_4h = plan_windows_ref(from_sec, now_sec, 60, 1)

    p1 = [
        {"time": now_sec - 3_600, "open": 52.0, "high": 52.8, "low": 51.9, "close": 52.5, "volume": 12000},
        {"time": now_sec - 900, "open": 52.5, "high": 53.0, "low": 52.4, "close": 52.9, "volume": 15000},
    ]
    p2 = [
        {"time": 1761498000, "open": 41.2, "high": 42.1, "low": 40.9, "close": 41.8, "volume": 41000},  # pre-gap
        {"time": now_sec - 3_600, "open": 52.0, "high": 52.9, "low": 51.9, "close": 52.6, "volume": 12500},  # dup updated
    ]
    merged = merge_pages_ref([p1, p2], from_sec, now_sec)
    return {
        "fromUtcSec": from_sec,
        "toUtcSec": now_sec,
        "windows15m": windows_15m,
        "windows1h": windows_1h,
        "windows4h": windows_4h,
        "pagesInput": [p1, p2],
        "expectedMerged": merged,
    }


def build_bsm_repricing_cases() -> dict[str, Any]:
    prev_spot_ars = 7200.0
    adr_price_usd = 52.40
    ccl_rate = 1285.0
    spot_teorico = (adr_price_usd * ccl_rate) / 10.0  # 6733.40 (-6.4805% spot move)
    dte = 28
    t_years = dte / DAYS_PER_YEAR
    rate_cont = math.log(1.0 + 0.36)

    specs = [
        ("GFGC6400DI", "call", 6400.0, 0.56),
        ("GFGC6800DI", "call", 6800.0, 0.52),
        ("GFGC7200DI", "call", 7200.0, 0.49),
        ("GFGC7600DI", "call", 7600.0, 0.47),
        ("GFGC8000DI", "call", 8000.0, 0.46),
        ("GFGV7000DI", "put", 7000.0, 0.51),
    ]
    cases = []
    for sym, ctype, strike, iv in specs:
        bs0, d0, g0 = bsm_price_and_greeks(prev_spot_ars, strike, t_years, rate_cont, 0.0, iv, ctype)
        bs1, _, _ = bsm_price_and_greeks(spot_teorico, strike, t_years, rate_cont, 0.0, iv, ctype)
        prev_close = round(bs0 * 1.015, 6)  # pequeño desvío real de cierre sobre BSM puro
        fair_open = max(0.0, prev_close + (bs1 - bs0))
        delta_pct = ((fair_open - prev_close) / prev_close) * 100.0
        cases.append({
            "input": {
                "tickerByma": sym,
                "prevSpotArs": prev_spot_ars,
                "projectedSpotArs": spot_teorico,
                "strikeArs": strike,
                "contractType": ctype,
                "timeToExpiryYears": t_years,
                "iv": iv,
                "rateCont": rate_cont,
                "prevCloseArs": prev_close,
            },
            "expected": {
                "tickerByma": sym,
                "prevCloseArs": prev_close,
                "fairOpenArs": fair_open,
                "deltaRepricePct": delta_pct,
                "bsmFairPrevArs": bs0,
                "bsmFairProjectedArs": bs1,
                "deltaAtClose": d0,
                "gammaAtClose": g0,
            },
        })
    return {
        "adrPriceUsd": adr_price_usd,
        "cclRate": ccl_rate,
        "spotTeoricoArs": spot_teorico,
        "cases": cases,
    }


def build_dlr_out_of_session_cases() -> list[dict[str, Any]]:
    # Sábado 2026-11-21T15:00:00Z = 12:00 ART (fuera de rueda)
    as_of_sec = 1795273200
    a3500 = 1445.0
    scenarios = [
        {
            "name": "out_of_session_settlement_priority_over_stale_last",
            "maturityDate": "20261230",
            "maturityUtcSec": 1798675200,  # 2026-12-31T00:00:00Z approx? wait use exact formula in primaryRofex
            "last": 1545.0,
            "bestBid": None,
            "bestAsk": None,
            "settlement": 1552.5,
            "close": 1550.0,
            "outOfSession": True,
            "expectedPrice": 1552.5,
            "expectedBasis": "SETTLEMENT_EOD",
            "expectedStatus": "CIERRE_AJUSTE",
        },
        {
            "name": "out_of_session_close_cl_fallback",
            "maturityDate": "20270129",
            "last": 1598.0,
            "bestBid": None,
            "bestAsk": None,
            "settlement": None,
            "close": 1602.0,
            "outOfSession": True,
            "expectedPrice": 1602.0,
            "expectedBasis": "SETTLEMENT_EOD",
            "expectedStatus": "CIERRE_AJUSTE",
        },
        {
            "name": "out_of_session_last_fallback_without_se_or_cl",
            "maturityDate": "20270226",
            "last": 1648.5,
            "bestBid": None,
            "bestAsk": None,
            "settlement": None,
            "close": None,
            "outOfSession": True,
            "expectedPrice": 1648.5,
            "expectedBasis": "LAST",
            "expectedStatus": "CIERRE_AJUSTE",
        },
        {
            "name": "out_of_session_live_book_still_live",
            "maturityDate": "20270331",
            "last": None,
            "bestBid": 1690.0,
            "bestAsk": 1695.0,
            "settlement": 1692.0,
            "close": 1689.0,
            "outOfSession": True,
            "expectedPrice": 1692.5,
            "expectedBasis": "MID",
            "expectedStatus": "LIVE",
        },
    ]

    import datetime
    out = []
    for sc in scenarios:
        y = int(sc["maturityDate"][0:4])
        m = int(sc["maturityDate"][4:6])
        d = int(sc["maturityDate"][6:8])
        # parsePrimaryMaturityUtcSec uses Date.UTC(y, m-1, d, 18, 0, 0) / 1000
        mat_dt = datetime.datetime(y, m, d, 18, 0, 0, tzinfo=datetime.timezone.utc)
        mat_sec = int(mat_dt.timestamp())
        days = max(1, round((mat_sec - as_of_sec) / SECONDS_PER_DAY))
        ref_price = float(sc["expectedPrice"])
        ratio = ref_price / a3500
        out.append({
            "name": sc["name"],
            "input": {
                "asOfUtcSec": as_of_sec,
                "maturityDate": sc["maturityDate"],
                "last": sc["last"],
                "bestBid": sc["bestBid"],
                "bestAsk": sc["bestAsk"],
                "settlement": sc["settlement"],
                "close": sc["close"],
                "a3500": a3500,
                "dlrSpot": None,
                "outOfSession": sc["outOfSession"],
            },
            "expected": {
                "priceBasis": sc["expectedBasis"],
                "status": sc["expectedStatus"],
                "referencePrice": ref_price,
                "spotUsed": a3500,
                "spotSource": "A3500_BCRA",
                "maturityUtcSec": mat_sec,
                "days": days,
                "baseArs": ref_price - a3500,
                "devalDirectaPct": (ratio - 1.0) * 100.0,
                "tnaImplicitaPct": (ratio - 1.0) * (DAYS_PER_YEAR / days) * 100.0,
                "teaImplicitaPct": (math.pow(ratio, DAYS_PER_YEAR / days) - 1.0) * 100.0,
                "temImplicitaPct": (math.pow(ratio, 30.0 / days) - 1.0) * 100.0,
            },
        })
    return out


def build_bond_layout_case() -> dict[str, Any]:
    # Coordenadas representativas en viewBox 560x220 donde AL29/AL30 y AE38/AL35/GD35/AL41 colisionan si no se mueven
    points = [
        {"id": "AL29", "label": "AL29 (11.40%)", "x": 85.0, "y": 135.0},
        {"id": "GD29", "label": "GD29 (10.95%)", "x": 92.0, "y": 141.0},
        {"id": "AL30", "label": "AL30 (11.20%)", "x": 108.0, "y": 138.0},
        {"id": "GD30", "label": "GD30 (10.75%)", "x": 115.0, "y": 145.0},
        {"id": "AL35", "label": "AL35 (11.10%)", "x": 385.0, "y": 136.0},
        {"id": "GD35", "label": "GD35 (10.85%)", "x": 392.0, "y": 141.0},
        {"id": "AE38", "label": "AE38 (11.30%)", "x": 405.0, "y": 132.0},
        {"id": "AL41", "label": "AL41 (10.90%)", "x": 420.0, "y": 139.0},
        {"id": "GD41", "label": "GD41 (10.65%)", "x": 455.0, "y": 144.0},
    ]

    bounds = {"minX": 40.0, "maxX": 554.0, "minY": 10.0, "maxY": 192.0}
    point_radius = 6.5
    char_width = 6.0
    label_height = 12.0
    padding = 2.5

    candidates = [
        (0, -11, "middle"), (0, 17, "middle"), (10, 3, "start"), (-10, 3, "end"),
        (12, -13, "start"), (-12, -13, "end"), (12, 19, "start"), (-12, 19, "end"),
        (0, -25, "middle"), (0, 31, "middle"),
        (18, -22, "start"), (-18, -22, "end"), (18, 28, "start"), (-18, 28, "end"),
        (0, -39, "middle"), (0, 45, "middle"),
        (30, -14, "start"), (-30, -14, "end"), (30, 20, "start"), (-30, 20, "end"),
        (34, -32, "start"), (-34, -32, "end"), (34, 38, "start"), (-34, 38, "end"),
        (0, -53, "middle"), (0, 59, "middle"),
        (48, -22, "start"), (-48, -22, "end"), (48, 28, "start"), (-48, 28, "end"),
        (0, -67, "middle"), (0, 73, "middle"),
    ]

    def calc_box(lx: float, ly: float, anchor: str, text_len: int) -> dict[str, float]:
        w = max(8.0, text_len * char_width + 4.0)
        if anchor == "middle":
            left, right = lx - w / 2.0, lx + w / 2.0
        elif anchor == "start":
            left, right = lx, lx + w
        else:
            left, right = lx - w, lx
        return {"left": left, "top": ly - label_height, "right": right, "bottom": ly + 2.0}

    def overlaps(a: dict[str, float], b: dict[str, float], pad: float) -> bool:
        return (
            a["left"] < b["right"] + pad
            and a["right"] + pad > b["left"]
            and a["top"] < b["bottom"] + pad
            and a["bottom"] + pad > b["top"]
        )

    def ov_area(a: dict[str, float], b: dict[str, float], pad: float) -> float:
        ox = max(0.0, min(a["right"] + pad, b["right"] + pad) - max(a["left"], b["left"]))
        oy = max(0.0, min(a["bottom"] + pad, b["bottom"] + pad) - max(a["top"], b["top"]))
        return ox * oy

    sorted_pts = sorted(points, key=lambda p: (p["x"], p["y"], p["id"]))
    marker_boxes = [
        {"left": p["x"] - point_radius, "top": p["y"] - point_radius, "right": p["x"] + point_radius, "bottom": p["y"] + point_radius}
        for p in sorted_pts
    ]

    placed_boxes: list[dict[str, float]] = []
    expected_placements = []
    for pt in sorted_pts:
        best = None
        for dx, dy, anchor in candidates:
            lx = pt["x"] + dx
            ly = pt["y"] + dy
            box = calc_box(lx, ly, anchor, len(pt["label"]))
            oob = 1 if (box["left"] < bounds["minX"] or box["right"] > bounds["maxX"] or box["top"] < bounds["minY"] or box["bottom"] > bounds["maxY"]) else 0
            lbl_ov = 0
            area_sum = 0.0
            for prev in placed_boxes:
                if overlaps(box, prev, padding):
                    lbl_ov += 1
                    area_sum += ov_area(box, prev, padding)
            mrk_ov = 0
            for mb in marker_boxes:
                if overlaps(box, mb, 1.0):
                    mrk_ov += 1
                    area_sum += ov_area(box, mb, 1.0)
            dist = math.hypot(dx, dy)
            score = (oob, lbl_ov, mrk_ov, area_sum, dist)
            if best is None or (
                score[0] < best["score"][0]
                or (score[0] == best["score"][0] and score[1] < best["score"][1])
                or (score[0:2] == best["score"][0:2] and score[2] < best["score"][2])
                or (score[0:3] == best["score"][0:3] and score[3] < best["score"][3] - 1e-9)
                or (score[0:3] == best["score"][0:3] and abs(score[3] - best["score"][3]) <= 1e-9 and score[4] < best["score"][4] - 1e-9)
            ):
                best = {"score": score, "lx": lx, "ly": ly, "anchor": anchor, "box": box, "dist": dist}
        assert best is not None
        placed_boxes.append(best["box"])
        expected_placements.append({
            "id": pt["id"],
            "labelX": best["lx"],
            "labelY": best["ly"],
            "textAnchor": best["anchor"],
            "needsLeader": best["dist"] > 14.0,
            "overlapCount": best["score"][1],
        })

    return {"points": points, "expected": expected_placements}


def build_coord_guard_and_max_pain_cases() -> dict[str, Any]:
    us_bars = [
        {"timeSec": 1795000000, "open": 49.5, "high": 51.0, "low": 49.0, "close": 50.5, "volume": 100000},
        {"timeSec": 1795003600, "open": 50.5, "high": 53.0, "low": 50.0, "close": 52.0, "volume": 120000},
    ]
    # Un nivel ARS (7500) infiltrado en USD debe rechazarse; niveles USD coherentes (55, 45, 51, 50) pasan
    us_contracts = [
        {"strike": 45.0, "contractType": "call", "openInterest": 200},
        {"strike": 45.0, "contractType": "put", "openInterest": 900},
        {"strike": 50.0, "contractType": "call", "openInterest": 1200},
        {"strike": 50.0, "contractType": "put", "openInterest": 1400},
        {"strike": 55.0, "contractType": "call", "openInterest": 1800},
        {"strike": 55.0, "contractType": "put", "openInterest": 300},
    ]
    strikes = sorted({c["strike"] for c in us_contracts})
    best_strike = None
    min_payout = float("inf")
    for cand in strikes:
        payout = 0.0
        for c in us_contracts:
            if c["contractType"] == "call" and cand > c["strike"]:
                payout += (cand - c["strike"]) * c["openInterest"]
            elif c["contractType"] == "put" and cand < c["strike"]:
                payout += (c["strike"] - cand) * c["openInterest"]
        if payout < min_payout - 1e-9:
            min_payout = payout
            best_strike = cand

    return {
        "usBars": us_bars,
        "arsLeakOnUsdInput": {
            "activeCoordMode": "USD_ADR_NASDAQ",
            "payloadCoordMode": "USD_ADR_NASDAQ",
            "levels": {"callWall": 7500.0, "putWall": 45.0, "zeroGamma": 6800.0, "maxPain": 50.0},
        },
        "arsLeakOnUsdExpected": {"callWall": None, "putWall": 45.0, "zeroGamma": None, "maxPain": 50.0},
        "maxPainContracts": us_contracts,
        "expectedMaxPain": best_strike,
    }


def main() -> None:
    payload = {
        "fmpPagination": build_fmp_pagination_cases(),
        "bsmRepricing": build_bsm_repricing_cases(),
        "dlrOutOfSession": build_dlr_out_of_session_cases(),
        "bondCurveLayout": build_bond_layout_case(),
        "coordGuardAndMaxPain": build_coord_guard_and_max_pain_cases(),
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Generated {OUT_PATH}")


if __name__ == "__main__":
    main()
