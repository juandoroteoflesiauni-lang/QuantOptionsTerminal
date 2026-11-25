#!/usr/bin/env python3
"""Independent Decimal(50) oracle for Sub-fase 2 Pieza 5 (S2-1 + S2-2):
  - Multi-horizon Volume Profile (1D, 5D, 20D, 252R) on shared k * tickSize grid
  - Exact volume conservation, POC deterministic tie-breaking, 70% Value Area
  - Topological HVN/LVN node detection (active-support trim, symmetric [1,2,3,2,1]/9
    reflected smoothing, topographic prominence, internal price gap consolidation,
    minimum separation >= w bins, 3+3 cap).

Zero dependency beyond Python standard library. Deterministic output JSON.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP, localcontext
import json
from pathlib import Path
from zoneinfo import ZoneInfo

D = Decimal
NY_TZ = ZoneInfo("America/New_York")
OUT_PATH = Path(__file__).resolve().parent.parent / "fixtures" / "multi_horizon_vp_hvn_lvn.json"

MAX_PROFILE_BINS = 4000
BIN_EPS = D("1e-12")
PLATEAU_REL_EPS = D("1e-9")

NYSE_CLOSED = {
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
    "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
}
NYSE_EARLY = {"2026-11-27", "2026-12-24"}


def et_wall_utc(year: int, month: int, day: int, minutes: int) -> int:
    h, m = divmod(minutes, 60)
    return int(datetime(year, month, day, h, m, tzinfo=NY_TZ).timestamp())


def nyse_session_for_date(d: datetime) -> dict | None:
    if d.weekday() >= 5:
        return None
    key = d.strftime("%Y-%m-%d")
    if key in NYSE_CLOSED:
        return None
    early = key in NYSE_EARLY
    return {
        "dateKey": key,
        "open": et_wall_utc(d.year, d.month, d.day, 9 * 60 + 30),
        "close": et_wall_utc(d.year, d.month, d.day, 13 * 60 if early else 16 * 60),
        "extendedOpen": et_wall_utc(d.year, d.month, d.day, 4 * 60),
        "extendedClose": et_wall_utc(d.year, d.month, d.day, 17 * 60 if early else 20 * 60),
    }


def price_to_bin(price: Decimal, tick: Decimal) -> int:
    # Half-up integer grid k * tick
    ratio = price / tick + BIN_EPS
    return int((ratio).quantize(D("1"), rounding=ROUND_HALF_UP))


def scaled_tick(min_p: Decimal, max_p: Decimal, base_tick: Decimal) -> Decimal:
    if price_to_bin(max_p, base_tick) - price_to_bin(min_p, base_tick) + 1 <= MAX_PROFILE_BINS:
        return base_tick
    mult = max(2, int(((max_p - min_p) / ((MAX_PROFILE_BINS - 1) * base_tick)).to_integral_value(rounding="ROUND_CEILING")))
    while price_to_bin(max_p, base_tick * mult) - price_to_bin(min_p, base_tick * mult) + 1 > MAX_PROFILE_BINS:
        mult += 1
    return base_tick * mult


def build_histogram_from_bars(bars: list[dict], tick: Decimal) -> dict:
    min_bin = None
    max_bin = None
    min_p = None
    max_p = None
    for b in bars:
        lo = D(str(b["low"]))
        hi = D(str(b["high"]))
        cl = D(str(b["close"]))
        vol = D(str(b["volume"]))
        if vol <= 0 or hi < lo:
            continue
        li = price_to_bin(cl if hi == lo else lo, tick)
        hi_idx = li if hi == lo else price_to_bin(hi, tick)
        min_bin = li if min_bin is None else min(min_bin, li)
        max_bin = hi_idx if max_bin is None else max(max_bin, hi_idx)
        min_p = lo if min_p is None else min(min_p, lo)
        max_p = hi if max_p is None else max(max_p, hi)

    assert min_bin is not None and max_bin is not None
    bins = [D(0)] * (max_bin - min_bin + 1)
    total_vol = D(0)
    pv_sum = D(0)
    for b in bars:
        lo = D(str(b["low"]))
        hi = D(str(b["high"]))
        cl = D(str(b["close"]))
        vol = D(str(b["volume"]))
        if vol <= 0 or hi < lo:
            continue
        li = price_to_bin(cl if hi == lo else lo, tick)
        hi_idx = li if hi == lo else price_to_bin(hi, tick)
        cnt = hi_idx - li + 1
        per_bin = vol / D(cnt)
        for idx in range(li, hi_idx + 1):
            bins[idx - min_bin] += per_bin
        total_vol += vol
        vw_raw = b.get("vw")
        typ = D(str(vw_raw)) if (vw_raw is not None and D(str(vw_raw)) > 0) else (hi + lo + cl) / D(3)
        pv_sum += typ * vol

    profile_vwap = pv_sum / total_vol
    max_v = max(bins)
    tie_eps = BIN_EPS * max(D(1), max_v)
    best_i = 0
    best_dist = None
    best_price = None
    for i, v in enumerate(bins):
        if v < max_v - tie_eps:
            continue
        px = D(min_bin + i) * tick
        dist = abs(px - profile_vwap)
        if best_price is None:
            best_i, best_dist, best_price = i, dist, px
            continue
        if dist < best_dist - tie_eps:
            best_i, best_dist, best_price = i, dist, px
        elif abs(dist - best_dist) <= tie_eps and px < best_price:
            best_i, best_dist, best_price = i, dist, px

    va_lo = best_i
    va_hi = best_i
    covered = bins[best_i]
    target = D("0.70") * total_vol
    va_eps = BIN_EPS * max(D(1), total_vol)
    while covered < target - va_eps and (va_lo > 0 or va_hi < len(bins) - 1):
        lv = bins[va_lo - 1] if va_lo > 0 else D(-1)
        rv = bins[va_hi + 1] if va_hi < len(bins) - 1 else D(-1)
        if lv < 0:
            va_hi += 1
            covered += rv
        elif rv < 0:
            va_lo -= 1
            covered += lv
        elif lv > rv + va_eps:
            va_lo -= 1
            covered += lv
        elif rv > lv + va_eps:
            va_hi += 1
            covered += rv
        else:
            va_lo -= 1
            va_hi += 1
            covered += lv + rv

    return {
        "minBinIndex": min_bin,
        "maxBinIndex": max_bin,
        "binVolumes": bins,
        "totalVolume": total_vol,
        "minPrice": min_p,
        "maxPrice": max_p,
        "poc": D(min_bin + best_i) * tick,
        "val": D(min_bin + va_lo) * tick,
        "vah": D(min_bin + va_hi) * tick,
        "profileVwap": profile_vwap,
        "valueAreaVolume": covered,
        "valueAreaCoverage": covered / total_vol,
    }


def reflect_idx(idx: int, n: int) -> int:
    if n <= 1:
        return 0
    k = idx
    while k < 0 or k >= n:
        if k < 0:
            k = -k - 1
        else:
            k = 2 * n - k - 1
    return k


def p_tol(ref: Decimal) -> Decimal:
    return PLATEAU_REL_EPS * max(D(1), ref)


def detect_nodes(bin_volumes: list[Decimal], min_bin_index: int, tick: Decimal, ref_price: Decimal | None = None, max_hvn: int = 3, max_lvn: int = 3) -> dict:
    i_min = next((i for i, v in enumerate(bin_volumes) if v > 0), -1)
    i_max = next((i for i in range(len(bin_volumes) - 1, -1, -1) if bin_volumes[i] > 0), -1)
    if i_min == -1 or i_max == -1:
        return {
            "activeStartIndex": -1, "activeEndIndex": -1, "activeBinCount": 0,
            "neighborhoodRadius": 0, "smoothedPocVolume": None, "totalVolume": 0.0,
            "hvnZones": [], "lvnZones": [],
        }

    active = bin_volumes[i_min : i_max + 1]
    n = len(active)
    total_vol = sum(active, D(0))

    s = [
        (
            active[reflect_idx(u - 2, n)]
            + D(2) * active[reflect_idx(u - 1, n)]
            + D(3) * active[u]
            + D(2) * active[reflect_idx(u + 1, n)]
            + active[reflect_idx(u + 2, n)]
        ) / D(9)
        for u in range(n)
    ]
    s_poc = max(s)
    s_min = min(s)
    w = min(12, max(2, int((D("0.015") * n).to_integral_value(rounding="ROUND_FLOOR"))))

    plateaus = []
    cur = 0
    while cur < n:
        anchor = s[cur]
        tol = p_tol(anchor)
        r = cur
        while r + 1 < n and abs(s[r + 1] - anchor) <= tol:
            r += 1
        seg = s[cur : r + 1]
        plateaus.append((cur, r, max(seg), min(seg)))
        cur = r + 1

    poc_eps = p_tol(s_poc)

    # HVN
    raw_hvn = []
    for pl, pr, h, _ in plateaus:
        heps = p_tol(h)
        if h / s_poc < D("0.35") - BIN_EPS:
            continue
        ws, we = max(0, pl - w), min(n - 1, pr + w)
        if any(s[j] > h + heps for j in range(ws, we + 1)):
            continue
        left_higher = -1
        left_col = h
        for j in range(pl - 1, -1, -1):
            if s[j] < left_col:
                left_col = s[j]
            if s[j] > h + heps or abs(s[j] - h) <= heps:
                left_higher = j
                break
        right_higher = -1
        right_col = h
        for j in range(pr + 1, n):
            if s[j] < right_col:
                right_col = s[j]
            if s[j] > h + heps:
                right_higher = j
                break
        if left_higher != -1 and right_higher != -1:
            base = max(left_col, right_col)
        elif left_higher != -1:
            base = left_col
        elif right_higher != -1:
            base = right_col
        else:
            base = s_min
        prom = max(D(0), h - base)
        if prom < D("0.15") * s_poc - poc_eps:
            continue
        floor_val = D("0.75") * h - heps
        bl, br = pl, pr
        while bl > 0 and s[bl - 1] >= floor_val:
            bl -= 1
        while br + 1 < n and s[br + 1] >= floor_val:
            br += 1
        raw_hvn.append([bl, br, prom])

    raw_hvn.sort(key=lambda x: (x[0], x[1]))
    merged_hvn = []
    for b in raw_hvn:
        if merged_hvn and b[0] <= merged_hvn[-1][1] + 2:
            merged_hvn[-1][1] = max(merged_hvn[-1][1], b[1])
            merged_hvn[-1][2] = max(merged_hvn[-1][2], b[2])
        else:
            merged_hvn.append(list(b))

    hvn_occ = {u for bl, br, _ in merged_hvn for u in range(bl, br + 1)}
    hvn_cands = []
    for bl, br, prom in merged_hvn:
        rv = sum(active[bl : br + 1], D(0))
        coff = sum((D(u) * active[u] for u in range(bl, br + 1)), D(0)) / rv if rv > 0 else D(bl + br) / D(2)
        hvn_cands.append(("HVN", bl, br, coff, prom, False))

    # LVN
    raw_lvn = []
    if n >= 3:
        min_flank = D("0.30") * s_poc - poc_eps
        for pl, pr, _, v in plateaus:
            if pl == 0 or pr == n - 1:
                continue
            ws, we = max(0, pl - w), min(n - 1, pr + w)
            if any(s[j] < v - poc_eps for j in range(ws, we + 1)):
                continue
            peak_l_idx = max(range(0, pl), key=lambda j: s[j])
            peak_r_idx = max(range(pr + 1, n), key=lambda j: s[j])
            sp_l, sp_r = s[peak_l_idx], s[peak_r_idx]
            if sp_l < min_flank or sp_r < min_flank:
                continue
            flank = min(sp_l, sp_r)
            if flank <= 0 or v / flank > D("0.35") + BIN_EPS:
                continue
            prom = max(D(0), flank - v)
            if all(active[u] > 0 for u in range(pl, pr + 1)):
                cap = min(D("0.35") * flank, v + D("0.25") * (flank - v)) + poc_eps
                bl, br = pl, pr
                while bl - 1 > peak_l_idx and bl - 1 > 0 and (bl - 1) not in hvn_occ and active[bl - 1] > 0 and s[bl - 1] <= cap:
                    bl -= 1
                while br + 1 < peak_r_idx and br + 1 < n - 1 and (br + 1) not in hvn_occ and active[br + 1] > 0 and s[br + 1] <= cap:
                    br += 1
                raw_lvn.append([bl, br, prom, False])
            else:
                z_indices = [u for u in range(pl, pr + 1) if active[u] == 0]
                if z_indices and z_indices[0] > 0 and z_indices[-1] < n - 1:
                    gap_min_s = min(s[u] for u in z_indices)
                    raw_lvn.append([z_indices[0], z_indices[-1], max(D(0), flank - gap_min_s), True])

        g = 1
        while g < n - 1:
            if active[g] != 0:
                g += 1
                continue
            gl = g
            gr = g
            while gr + 1 < n - 1 and active[gr + 1] == 0:
                gr += 1
            sp_l = max(s[0:gl])
            sp_r = max(s[gr + 1 : n])
            if sp_l >= min_flank and sp_r >= min_flank:
                flank = min(sp_l, sp_r)
                min_s = min(s[u] for u in range(gl, gr + 1))
                raw_lvn.append([gl, gr, max(D(0), flank - min_s), True])
            g = gr + 1

    raw_lvn.sort(key=lambda x: (x[0], x[1]))
    merged_lvn = []
    for b in raw_lvn:
        if merged_lvn and b[0] <= merged_lvn[-1][1] + 2:
            merged_lvn[-1][1] = max(merged_lvn[-1][1], b[1])
            merged_lvn[-1][2] = max(merged_lvn[-1][2], b[2])
            merged_lvn[-1][3] = merged_lvn[-1][3] or b[3]
        else:
            merged_lvn.append(list(b))

    lvn_cands = []
    for bl, br, prom, is_gap in merged_lvn:
        has_zero = is_gap or any(active[u] == 0 for u in range(bl, br + 1))
        lvn_cands.append(("LVN", bl, br, D(bl + br) / D(2), prom, has_zero))

    price_span = max(tick, D(n - 1) * tick)

    def select(cands: list, limit: int) -> list[dict]:
        if limit <= 0 or not cands:
            return []
        scored = []
        for kind, bl, br, coff, prom, is_gap in cands:
            sb = min_bin_index + i_min + bl
            eb = min_bin_index + i_min + br
            lp = D(sb) * tick
            hp = D(eb) * tick
            cp = (D(min_bin_index + i_min) + coff) * tick
            rv = sum(active[bl : br + 1], D(0))
            share = D(100) * rv / total_vol
            pratio = prom / s_poc
            if ref_price is not None:
                dnorm = abs(cp - ref_price) / price_span
                pfac = D(1) / (D(1) + dnorm)
                score = pratio * (D("0.70") + D("0.30") * pfac)
                dabs = abs(cp - ref_price)
            else:
                score = pratio
                dabs = cp
            scored.append((score, prom, dabs, cp, coff, {
                "kind": kind,
                "startBinIndex": sb,
                "endBinIndex": eb,
                "lowPrice": float(lp),
                "highPrice": float(hp),
                "centerPrice": float(cp),
                "volume": float(rv),
                "volumeSharePct": float(share),
                "prominence": float(prom),
                "prominenceRatio": float(pratio),
                "isPriceGap": is_gap,
            }))
        scored.sort(key=lambda item: (-float(item[0]), -float(item[1]), float(item[2]), float(item[3])))
        kept = []
        for item in scored:
            if len(kept) >= limit:
                break
            if any(abs(item[4] - k[4]) < D(w) - D("1e-9") for k in kept):
                continue
            kept.append(item)
        return [k[5] for k in kept]

    return {
        "activeStartIndex": i_min,
        "activeEndIndex": i_max,
        "activeBinCount": n,
        "neighborhoodRadius": w,
        "smoothedPocVolume": float(s_poc),
        "totalVolume": float(total_vol),
        "hvnZones": select(hvn_cands, max_hvn),
        "lvnZones": select(lvn_cands, max_lvn),
    }


def serialize_hist_summary(h: dict, nodes: dict) -> dict:
    return {
        "minBinIndex": h["minBinIndex"],
        "maxBinIndex": h["maxBinIndex"],
        "minPrice": float(h["minPrice"]),
        "maxPrice": float(h["maxPrice"]),
        "poc": float(h["poc"]),
        "vah": float(h["vah"]),
        "val": float(h["val"]),
        "profileVwap": float(h["profileVwap"]),
        "totalVolume": float(h["totalVolume"]),
        "valueAreaVolume": float(h["valueAreaVolume"]),
        "valueAreaCoverage": float(h["valueAreaCoverage"]),
        "hvnZones": nodes["hvnZones"],
        "lvnZones": nodes["lvnZones"],
    }


def generate_fixture() -> dict:
    # 1) Multi-horizon NYSE 2026-10-28 .. 2026-11-27 (includes DST 2026-11-01, Thanksgiving 2026-11-26, early close 2026-11-27 13:00 ET)
    sessions = []
    cur_d = datetime(2026, 10, 20)
    end_d = datetime(2026, 11, 27)
    while cur_d <= end_d:
        s = nyse_session_for_date(cur_d)
        if s is not None:
            sessions.append(s)
        cur_d += timedelta(days=1)

    sessions_20 = sessions[-20:]
    sessions_5 = sessions[-5:]
    as_of = sessions_20[-1]["close"]  # 2026-11-27 13:00 ET early close (closed RTH)
    tick = D("0.10")

    bars_5m = []
    bars_1m = []
    for s_idx, sess in enumerate(sessions_20):
        open_t = sess["open"]
        close_t = sess["close"]
        # Create deterministic bimodal structure across 20D with slight upward drift
        center = D("100.00") + D(s_idx % 3) * D("0.80")
        t = open_t
        step = 0
        while t + 300 <= close_t:
            offset = D("-1.50") if step % 4 < 2 else D("1.50")
            lo = center + offset - D("0.30")
            hi = center + offset + D("0.30")
            cl = center + offset + (D("0.10") if step % 2 == 0 else D("-0.10"))
            vol = D(1000 + (s_idx * 37 + step * 13) % 500)
            bars_5m.append({
                "time": t,
                "open": float(center + offset),
                "high": float(hi),
                "low": float(lo),
                "close": float(cl),
                "volume": float(vol),
                "vw": float((hi + lo + cl) / D(3)),
            })
            if sess in sessions_5:
                for m in range(5):
                    mt = t + m * 60
                    m_vol = vol / D(5)
                    bars_1m.append({
                        "time": mt,
                        "open": float(center + offset),
                        "high": float(hi),
                        "low": float(lo),
                        "close": float(cl),
                        "volume": float(m_vol),
                        "vw": float((hi + lo + cl) / D(3)),
                    })
            t += 300
            step += 1

    # 252R synthetic daily bars
    bars_1d = []
    d_start = datetime(2025, 11, 1, tzinfo=timezone.utc)
    for i in range(260):
        t_day = int((d_start + timedelta(days=i)).timestamp())
        base = D("95.00") + D((i * 19) % 40) * D("0.25")
        bars_1d.append({
            "time": t_day,
            "open": float(base),
            "high": float(base + D("1.20")),
            "low": float(base - D("1.00")),
            "close": float(base + D("0.40")),
            "volume": float(50000 + (i * 997) % 20000),
            "vw": float(base + D("0.20")),
        })

    ref_px = D(str(bars_1m[-1]["close"]))
    bars_1d_today = [b for b in bars_1m if b["time"] >= sessions_5[-1]["open"]]
    h1d = build_histogram_from_bars(bars_1d_today, tick)
    n1d = detect_nodes(h1d["binVolumes"], h1d["minBinIndex"], tick, ref_px)

    h5d = build_histogram_from_bars(bars_1m, tick)
    n5d = detect_nodes(h5d["binVolumes"], h5d["minBinIndex"], tick, ref_px)

    h20d = build_histogram_from_bars(bars_5m, tick)
    n20d = detect_nodes(h20d["binVolumes"], h20d["minBinIndex"], tick, ref_px)

    bars_252 = bars_1d[-252:]
    h252 = build_histogram_from_bars(bars_252, tick)
    n252 = detect_nodes(h252["binVolumes"], h252["minBinIndex"], tick, ref_px)

    # 2) Deterministic POC & Value Area tie-break cases
    tie_cases = []
    # 2a: Two bins with equal volume, closer to VWAP wins
    t0 = sessions_5[-1]["open"]
    tie_bars_vwap = [
        {"time": t0, "open": 100.0, "high": 100.0, "low": 100.0, "close": 100.0, "volume": 500.0, "vw": 101.8},
        {"time": t0 + 60, "open": 102.0, "high": 102.0, "low": 102.0, "close": 102.0, "volume": 500.0, "vw": 101.8},
    ]
    h_tie_vwap = build_histogram_from_bars(tie_bars_vwap, D("1.0"))
    tie_cases.append({"name": "poc_tie_closer_to_vwap", "tickSize": 1.0, "bars": tie_bars_vwap, "expected": serialize_hist_summary(h_tie_vwap, detect_nodes(h_tie_vwap["binVolumes"], h_tie_vwap["minBinIndex"], D("1.0")))})

    # 2b: Equidistant from VWAP -> lower price wins
    tie_bars_eq = [
        {"time": t0, "open": 100.0, "high": 100.0, "low": 100.0, "close": 100.0, "volume": 500.0, "vw": 101.0},
        {"time": t0 + 60, "open": 102.0, "high": 102.0, "low": 102.0, "close": 102.0, "volume": 500.0, "vw": 101.0},
    ]
    h_tie_eq = build_histogram_from_bars(tie_bars_eq, D("1.0"))
    tie_cases.append({"name": "poc_tie_equidistant_lower_price", "tickSize": 1.0, "bars": tie_bars_eq, "expected": serialize_hist_summary(h_tie_eq, detect_nodes(h_tie_eq["binVolumes"], h_tie_eq["minBinIndex"], D("1.0")))})

    # 2c: Bilateral VA tie (leftVol == rightVol expands both)
    tie_bars_va = [
        {"time": t0, "open": 100.0, "high": 100.0, "low": 100.0, "close": 100.0, "volume": 200.0, "vw": 101.0},
        {"time": t0 + 60, "open": 101.0, "high": 101.0, "low": 101.0, "close": 101.0, "volume": 400.0, "vw": 101.0},
        {"time": t0 + 120, "open": 102.0, "high": 102.0, "low": 102.0, "close": 102.0, "volume": 200.0, "vw": 101.0},
    ]
    h_tie_va = build_histogram_from_bars(tie_bars_va, D("1.0"))
    tie_cases.append({"name": "va_bilateral_tie_expansion", "tickSize": 1.0, "bars": tie_bars_va, "expected": serialize_hist_summary(h_tie_va, detect_nodes(h_tie_va["binVolumes"], h_tie_va["minBinIndex"], D("1.0")))})

    # 3) MAX_PROFILE_BINS = 4000 scaling case
    wide_bars = [
        {"time": t0, "open": 100.0, "high": 160.0, "low": 100.0, "close": 130.0, "volume": 12000.0},
        {"time": t0 + 60, "open": 130.0, "high": 132.0, "low": 128.0, "close": 130.0, "volume": 6000.0},
    ]
    s_tick = scaled_tick(D("100.0"), D("160.0"), D("0.01"))
    h_wide = build_histogram_from_bars(wide_bars, s_tick)
    wide_case = {
        "name": "max_profile_bins_4000_scaling",
        "baseTickSize": 0.01,
        "expectedTickSize": float(s_tick),
        "bars": wide_bars,
        "expected": serialize_hist_summary(h_wide, detect_nodes(h_wide["binVolumes"], h_wide["minBinIndex"], s_tick)),
    }

    # 4) Topological HVN/LVN node detection scenarios
    node_cases = []

    def add_node_case(name: str, bins: list[float], min_bin: int = 1000, tick_sz: float = 0.1, ref_p: float | None = None, max_h: int = 3, max_l: int = 3):
        dec_bins = [D(str(x)) for x in bins]
        res = detect_nodes(dec_bins, min_bin, D(str(tick_sz)), D(str(ref_p)) if ref_p is not None else None, max_h, max_l)
        node_cases.append({
            "name": name,
            "minBinIndex": min_bin,
            "tickSize": tick_sz,
            "referencePrice": ref_p,
            "maxHvnZones": max_h,
            "maxLvnZones": max_l,
            "binVolumes": bins,
            "expected": res,
        })

    # 4a: Unimodal bell
    add_node_case("unimodal_bell", [10, 25, 50, 85, 140, 220, 340, 500, 340, 220, 140, 85, 50, 25, 10])

    # 4b: Double-distribution bimodal with negotiated central LVN
    add_node_case("bimodal_double_distribution_lvn", [20, 80, 220, 420, 500, 420, 220, 70, 20, 12, 20, 75, 210, 390, 460, 390, 210, 80, 20])

    # 4c: Flat uniform plateau (prominence = 0 -> 0 HVN, 0 LVN)
    add_node_case("flat_uniform_zero_prominence", [100] * 16)

    # 4d: Elevated plateau peak (weighted center within 1e-9)
    add_node_case("elevated_plateau_peak", [10, 20, 40, 100, 300, 300, 300, 300, 100, 40, 20, 10])

    # 4e: Exterior zero padding invariance (must never classify exterior zeros as LVN)
    core_bimodal = [30, 150, 380, 500, 380, 120, 20, 10, 20, 130, 350, 440, 350, 140, 30]
    add_node_case("exterior_zero_padded_bimodal", [0, 0, 0, 0] + core_bimodal + [0, 0, 0, 0], min_bin=996)

    # 4f: Single internal price gap (V=0) -> isPriceGap = true, volume = 0
    add_node_case("internal_price_gap_single", [40, 160, 380, 480, 360, 140, 0, 150, 370, 450, 340, 120, 30])

    # 4g: Multi-bin internal price gap (4 bins of V=0) -> consolidated into 1 LVN band
    add_node_case("internal_price_gap_multi_bin_consolidated", [40, 160, 380, 480, 360, 140, 0, 0, 0, 0, 150, 370, 450, 340, 120, 30])

    # 4h: Two internal gaps separated by 1 thin bin -> consolidated into 1 LVN band
    add_node_case("internal_price_gaps_1bin_bridge_consolidated", [40, 160, 380, 480, 360, 140, 0, 5, 0, 150, 370, 450, 340, 120, 30])

    # 4i: 5 HVN peaks + 4 LVN valleys -> separation >= w, ranked with referencePrice, capped 3+3
    multi_modal = [
        20, 120, 420, 120, 10, 5, 5, 5, 10,
        130, 460, 130, 10, 4, 4, 4, 10,
        140, 500, 140, 10, 3, 3, 3, 10,
        125, 440, 125, 10, 6, 6, 6, 10,
        110, 390, 110, 20,
    ]
    add_node_case("multi_modal_capped_3_plus_3", multi_modal, min_bin=1000, tick_sz=0.5, ref_p=509.0, max_h=3, max_l=3)

    return {
        "meta": {
            "generator": "tools/generate_multi_horizon_vp_nodes_fixture.py",
            "precision": "Decimal(50)",
            "tolerance": 1e-9,
        },
        "multiHorizonCase": {
            "symbol": "TEST_VP",
            "asOfUtcSec": as_of,
            "rthOnly": True,
            "tickSize": float(tick),
            "referencePrice": float(ref_px),
            "bars1m": bars_1m,
            "bars5m": bars_5m,
            "bars1d": bars_1d,
            "expected": {
                "1D": {**serialize_hist_summary(h1d, n1d), "sessionsCovered": 1, "closedBarCount": len(bars_1d_today)},
                "5D": {**serialize_hist_summary(h5d, n5d), "sessionsCovered": 5, "closedBarCount": len(bars_1m)},
                "20D": {**serialize_hist_summary(h20d, n20d), "sessionsCovered": 20, "closedBarCount": len(bars_5m)},
                "252R": {**serialize_hist_summary(h252, n252), "sessionsCovered": 252, "closedBarCount": 252},
            },
        },
        "tieCases": tie_cases,
        "scalingCase": wide_case,
        "nodeCases": node_cases,
    }


def main() -> None:
    with localcontext() as ctx:
        ctx.prec = 50
        payload = generate_fixture()
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
