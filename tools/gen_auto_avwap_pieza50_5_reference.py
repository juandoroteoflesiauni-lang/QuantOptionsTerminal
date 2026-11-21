#!/usr/bin/env python3
"""
Referencia independiente del motor determinístico Auto-AVWAP (Pieza 50.5).

Implementación explícita en Python puro (`math`, `json`, `datetime`, `pathlib`)
de las fórmulas documentadas en `SPEC` / blueprint de la Pieza 50.5. NO importa
ni traduce código TypeScript: es una segunda opinión ejecutable que genera el
fixture `fixtures/auto_avwap_pieza50_5_reference.json` (tolerancia <= 1e-9).

Escenarios deterministas:
  1. pivot_rvol_balanced_pincer          -> ATR(14) Wilder, RVOL(20)/zVol(20) ddof=0,
                                            puntajes exactos y pinza SUPPORT/RESISTANCE/EVENT.
  2. cluster_fusion_within_3_bars        -> fusión <= 3 velas, suma por familia sin doble
                                            conteo, unión de sources, vela exacta de PIVOT
                                            y desempate por volumen en clúster sin PIVOT.
  3. far_penalty_25pct_and_global_exemption -> -20 pts con |distancePct| > 0.25 y
                                            exención exacta de extremos globales.
  4. degradation_no_events_and_zero_std  -> events=[] (solo PIVOT + RVOL) y sigma = 0
                                            => zVol = NaN, rvolScore = 0 sin Infinity.
  5. edge_short_and_empty                -> < 21 barras y [] sin NaN en anclas emitidas.

Además genera `projectionCases` para `resolveAutoAvwapBarIndex` (1D, 1W e intradiario).
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone
from functools import cmp_to_key
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_PATH = ROOT / "fixtures" / "auto_avwap_pieza50_5_reference.json"

TOLERANCE = 1e-9
SECONDS_PER_DAY = 86_400
MAX_TIME_SECONDS = 1e11

UTC = timezone.utc

WINDOW_BARS = 380
ATR_PERIOD = 14
RVOL_PERIOD = 20
PIVOT_WINDOW = 10
PIVOT_REVERSAL_ATR_MULT = 2.5
MAJOR_LOOKBACK_BARS = 126
INTERMEDIATE_MIN_BARS = 21
RVOL_THRESHOLD = 2.0
RVOL_GAP_ATR_MULT = 1.2
RVOL_RANGE_ATR_MULT = 1.5
CLUSTER_MAX_DISTANCE_BARS = 3
MAX_DISTANCE_PCT = 0.25
FAR_PENALTY = 20
MAX_ANCHORS = 3

SOURCE_PRIORITY = {
    "EVENT": 0,
    "PIVOT_MAJOR": 1,
    "PIVOT_INTERMEDIATE": 2,
    "RVOL": 3,
}

# Pieza 50.5.1: escala calibrada de puntajes.
MAJOR_SCORE_BASE = 40.0
MAJOR_SCORE_BONUS_MAX = 20.0
MAJOR_SCORE_BONUS_SPAN = WINDOW_BARS - MAJOR_LOOKBACK_BARS  # 380 - 126 = 254
RVOL_SCORE_PER_Z = 5.0
RVOL_SCORE_CAP = 15.0
TOP_DOMINANT_MIN_SPAN = 180


# ---------------------------------------------------------------------------
# Utilidades de fecha
# ---------------------------------------------------------------------------

def bar_date_key(time_sec: int) -> str:
    moment = datetime(1970, 1, 1, tzinfo=UTC) + timedelta(seconds=int(time_sec))
    return moment.strftime("%Y-%m-%d")


def weekday_series(start: datetime, count: int) -> list[datetime]:
    out: list[datetime] = []
    cursor = start
    while len(out) < count:
        if cursor.weekday() < 5:
            out.append(cursor)
        cursor += timedelta(days=1)
    return out


def mk_bar(moment: datetime, o: float, h: float, l: float, c: float, v: float) -> dict:
    return {
        "time": int(moment.timestamp()),
        "open": o,
        "high": h,
        "low": l,
        "close": c,
        "volume": v,
    }


# ---------------------------------------------------------------------------
# Sanitización de barras (misma política: sin mutar, dedupe conserva la última)
# ---------------------------------------------------------------------------

def is_valid_bar(bar: dict) -> bool:
    return (
        math.isfinite(bar["time"])
        and float(bar["time"]).is_integer()
        and abs(bar["time"]) <= MAX_TIME_SECONDS
        and all(math.isfinite(bar[key]) for key in ("open", "high", "low", "close"))
        and bar["high"] >= bar["low"]
        and math.isfinite(bar["volume"])
        and bar["volume"] >= 0
    )


def sanitize_bars(bars: list[dict]) -> list[dict]:
    by_time: dict[int, dict] = {}
    for bar in bars:
        if not isinstance(bar, dict):
            continue
        if not is_valid_bar(bar):
            continue
        by_time[int(bar["time"])] = bar
    return [by_time[key] for key in sorted(by_time)]


# ---------------------------------------------------------------------------
# Indicadores base
# ---------------------------------------------------------------------------

def atr_series(bars: list[dict], period: int = ATR_PERIOD) -> list[float | None]:
    n = len(bars)
    out: list[float | None] = [None] * n
    if n == 0 or period < 1:
        return out
    tr: list[float] = [0.0] * n
    tr[0] = bars[0]["high"] - bars[0]["low"]
    for i in range(1, n):
        h = bars[i]["high"]
        l = bars[i]["low"]
        pc = bars[i - 1]["close"]
        tr[i] = max(h - l, abs(h - pc), abs(l - pc))
    if n < period:
        return out
    seed = 0.0
    for k in range(period):
        seed += tr[k]
    out[period - 1] = seed / period
    for i in range(period, n):
        out[i] = (out[i - 1] * (period - 1) + tr[i]) / period
    return out


def volume_stats(bars: list[dict], period: int = RVOL_PERIOD) -> dict:
    n = len(bars)
    sma_vol: list[float | None] = [None] * n
    std_vol: list[float | None] = [None] * n
    rvol: list[float | None] = [None] * n
    z_vol: list[float | None] = [None] * n
    for i in range(period, n):
        total = 0.0
        for k in range(i - period, i):
            total += bars[k]["volume"]
        mean = total / period
        squared = 0.0
        for k in range(i - period, i):
            diff = bars[k]["volume"] - mean
            squared += diff * diff
        sigma = math.sqrt(squared / period)
        sma_vol[i] = mean
        std_vol[i] = sigma
        current = bars[i]["volume"]
        rvol[i] = (current / mean) if mean > 0 else None
        z_vol[i] = ((current - mean) / sigma) if sigma > 0 else None
    return {"smaVol": sma_vol, "stdVol": std_vol, "rvol": rvol, "zVol": z_vol}


def welford_last_vwap(bars: list[dict], anchor_index: int) -> float | None:
    """Welford ponderado (HLC3, peso = volumen) desde `anchor_index` hasta el final.

    Recurrencia exacta:
      W_n = W_{n-1} + V_n ; delta = P_n - mu_{n-1} ; R = delta * V_n / W_n
      mu_n = mu_{n-1} + R ; M2_n = M2_{n-1} + W_{n-1} * delta * R
    Barras con precio no finito o volumen no finito/<= 0 repiten el último valor.
    """
    count = 0
    cum_weight = 0.0
    mean = 0.0
    if anchor_index < 0 or anchor_index >= len(bars):
        return None
    for i in range(anchor_index, len(bars)):
        bar = bars[i]
        price = (bar["high"] + bar["low"] + bar["close"]) / 3.0
        volume = bar["volume"]
        valid = math.isfinite(price) and math.isfinite(volume) and volume > 0
        if not valid:
            continue
        if cum_weight <= 0:
            count = 1
            cum_weight = volume
            mean = price
            continue
        cum_weight_next = cum_weight + volume
        delta = price - mean
        ratio = (delta * volume) / cum_weight_next
        mean = mean + ratio
        cum_weight = cum_weight_next
        count += 1
    if count == 0 or cum_weight <= 0:
        return None
    return mean


# ---------------------------------------------------------------------------
# Candidatos
# ---------------------------------------------------------------------------

def event_candidates(window: list[dict], events: list[dict]) -> list[dict]:
    n = len(window)
    if n == 0:
        return []
    first_key = bar_date_key(window[0]["time"])
    last_key = bar_date_key(window[n - 1]["time"])
    labels_by_index: dict[int, list[str]] = {}

    for event in events:
        if event is None or not isinstance(event, dict):
            continue
        utc_sec = event.get("utcSec")
        if not isinstance(utc_sec, (int, float)) or not math.isfinite(utc_sec):
            continue
        if abs(utc_sec) > MAX_TIME_SECONDS:
            continue
        raw_utc = int(math.floor(utc_sec))
        date_raw = event.get("date")
        if isinstance(date_raw, str) and len(date_raw) == 10 and date_raw[4] == "-" and date_raw[7] == "-" \
                and date_raw[:4].isdigit() and date_raw[5:7].isdigit() and date_raw[8:10].isdigit():
            event_key = date_raw
        else:
            event_key = bar_date_key(raw_utc)
        if event_key < first_key or event_key > last_key:
            continue

        time_of_day = event.get("timeOfDay")
        target = -1
        if time_of_day == "amc":
            for i in range(n):
                if bar_date_key(window[i]["time"]) > event_key:
                    target = i
                    break
        else:
            for i in range(n):
                if bar_date_key(window[i]["time"]) >= event_key:
                    target = i
                    break
        if target < 0:
            continue
        label = event.get("label")
        label = label if isinstance(label, str) else ""
        labels = labels_by_index.setdefault(target, [])
        if label not in labels:
            labels.append(label)

    candidates: list[dict] = []
    for index in sorted(labels_by_index):
        joined = "/".join(sorted(set(labels_by_index[index])))
        candidates.append({
            "index": index,
            "source": "EVENT",
            "score": 35.0,
            "pivotKind": None,
            "eventLabel": joined,
            "dominanceSpan": 0,
        })
    return candidates


def find_global_extremes(window: list[dict]) -> tuple[int, int]:
    global_low_idx = -1
    global_high_idx = -1
    min_low = math.inf
    max_high = -math.inf
    for i in range(len(window)):
        if window[i]["low"] < min_low:
            min_low = window[i]["low"]
            global_low_idx = i
        if window[i]["high"] > max_high:
            max_high = window[i]["high"]
            global_high_idx = i
    return global_low_idx, global_high_idx


def dominance_span_for_low(window: list[dict], index: int, low: float) -> int:
    left_span = 0
    k = index - 1
    while k >= 0 and window[k]["low"] >= low:
        left_span += 1
        k -= 1
    right_span = 0
    k = index + 1
    while k < len(window) and window[k]["low"] >= low:
        right_span += 1
        k += 1
    return left_span + 1 + right_span


def dominance_span_for_high(window: list[dict], index: int, high: float) -> int:
    left_span = 0
    k = index - 1
    while k >= 0 and window[k]["high"] <= high:
        left_span += 1
        k -= 1
    right_span = 0
    k = index + 1
    while k < len(window) and window[k]["high"] <= high:
        right_span += 1
        k += 1
    return left_span + 1 + right_span


def pivot_major_score(dominance_span: int) -> float:
    bonus = min(
        MAJOR_SCORE_BONUS_MAX,
        ((dominance_span - MAJOR_LOOKBACK_BARS) / MAJOR_SCORE_BONUS_SPAN) * MAJOR_SCORE_BONUS_MAX,
    )
    return MAJOR_SCORE_BASE + max(0.0, bonus)


def emit_pivot_candidate(candidates: list[dict], index: int, kind: str, dominance_span: int) -> None:
    if dominance_span >= MAJOR_LOOKBACK_BARS:
        candidates.append({
            "index": index,
            "source": "PIVOT_MAJOR",
            "score": pivot_major_score(dominance_span),
            "pivotKind": kind,
            "eventLabel": None,
            "dominanceSpan": dominance_span,
        })
    elif dominance_span >= INTERMEDIATE_MIN_BARS:
        candidates.append({
            "index": index,
            "source": "PIVOT_INTERMEDIATE",
            "score": 15.0,
            "pivotKind": kind,
            "eventLabel": None,
            "dominanceSpan": dominance_span,
        })


def pivot_candidates(window: list[dict], atr: list[float | None]) -> list[dict]:
    n = len(window)
    candidates: list[dict] = []
    if n < 2 * PIVOT_WINDOW + 1:
        return candidates

    global_low_idx, global_high_idx = find_global_extremes(window)

    for i in range(PIVOT_WINDOW, n - PIVOT_WINDOW):
        atr_i = atr[i]
        if atr_i is None or not math.isfinite(atr_i) or atr_i <= 0:
            continue
        low_i = window[i]["low"]
        high_i = window[i]["high"]

        is_pivot_low = True
        for k in range(i - PIVOT_WINDOW, i + PIVOT_WINDOW + 1):
            if k == i:
                continue
            other_low = window[k]["low"]
            if k < i:
                if not (low_i < other_low):
                    is_pivot_low = False
                    break
            else:
                if not (low_i <= other_low):
                    is_pivot_low = False
                    break
        if is_pivot_low:
            max_high_after = max(window[k]["high"] for k in range(i + 1, n))
            if max_high_after - low_i >= PIVOT_REVERSAL_ATR_MULT * atr_i:
                emit_pivot_candidate(
                    candidates, i, "LOW", dominance_span_for_low(window, i, low_i)
                )

        is_pivot_high = True
        for k in range(i - PIVOT_WINDOW, i + PIVOT_WINDOW + 1):
            if k == i:
                continue
            other_high = window[k]["high"]
            if k < i:
                if not (high_i > other_high):
                    is_pivot_high = False
                    break
            else:
                if not (high_i >= other_high):
                    is_pivot_high = False
                    break
        if is_pivot_high:
            min_low_after = min(window[k]["low"] for k in range(i + 1, n))
            if high_i - min_low_after >= PIVOT_REVERSAL_ATR_MULT * atr_i:
                emit_pivot_candidate(
                    candidates, i, "HIGH", dominance_span_for_high(window, i, high_i)
                )

    # Pieza 50.5.1: extremos estructurales recientes en el borde derecho
    # (i ∈ [n - pivot_window, n - 3], mínimo 2 velas de confirmación a la derecha).
    # Solo PIVOT_MAJOR si `dominanceSpan >= 126` o extremo global del período.
    right_edge_start = max(PIVOT_WINDOW, n - PIVOT_WINDOW)
    for i in range(right_edge_start, n - 2):
        atr_i = atr[i]
        if atr_i is None or not math.isfinite(atr_i) or atr_i <= 0:
            continue
        low_i = window[i]["low"]
        high_i = window[i]["high"]

        is_pivot_low = True
        for k in range(i - PIVOT_WINDOW, i):
            if not (low_i < window[k]["low"]):
                is_pivot_low = False
                break
        if is_pivot_low:
            for k in range(i + 1, n):
                if not (low_i <= window[k]["low"]):
                    is_pivot_low = False
                    break
        if is_pivot_low:
            max_high_after = max(window[k]["high"] for k in range(i + 1, n))
            if max_high_after - low_i >= PIVOT_REVERSAL_ATR_MULT * atr_i:
                dominance_span = dominance_span_for_low(window, i, low_i)
                if dominance_span >= MAJOR_LOOKBACK_BARS or i in (global_low_idx, global_high_idx):
                    candidates.append({
                        "index": i,
                        "source": "PIVOT_MAJOR",
                        "score": pivot_major_score(dominance_span),
                        "pivotKind": "LOW",
                        "eventLabel": None,
                        "dominanceSpan": dominance_span,
                    })

        is_pivot_high = True
        for k in range(i - PIVOT_WINDOW, i):
            if not (high_i > window[k]["high"]):
                is_pivot_high = False
                break
        if is_pivot_high:
            for k in range(i + 1, n):
                if not (high_i >= window[k]["high"]):
                    is_pivot_high = False
                    break
        if is_pivot_high:
            min_low_after = min(window[k]["low"] for k in range(i + 1, n))
            if high_i - min_low_after >= PIVOT_REVERSAL_ATR_MULT * atr_i:
                dominance_span = dominance_span_for_high(window, i, high_i)
                if dominance_span >= MAJOR_LOOKBACK_BARS or i in (global_low_idx, global_high_idx):
                    candidates.append({
                        "index": i,
                        "source": "PIVOT_MAJOR",
                        "score": pivot_major_score(dominance_span),
                        "pivotKind": "HIGH",
                        "eventLabel": None,
                        "dominanceSpan": dominance_span,
                    })

    return candidates


def rvol_candidates(window: list[dict], atr: list[float | None], stats: dict) -> list[dict]:
    n = len(window)
    candidates: list[dict] = []
    for i in range(RVOL_PERIOD, n):
        atr_i = atr[i]
        rvol_i = stats["rvol"][i]
        if atr_i is None or not math.isfinite(atr_i) or atr_i <= 0:
            continue
        if rvol_i is None or not math.isfinite(rvol_i):
            continue
        if rvol_i < RVOL_THRESHOLD:
            continue
        bar = window[i]
        previous = window[i - 1]
        gap_triggered = abs(bar["open"] - previous["close"]) >= RVOL_GAP_ATR_MULT * atr_i
        range_triggered = (bar["high"] - bar["low"]) >= RVOL_RANGE_ATR_MULT * atr_i
        if not gap_triggered and not range_triggered:
            continue
        z_vol_i = stats["zVol"][i]
        if z_vol_i is not None and math.isfinite(z_vol_i):
            score = min(RVOL_SCORE_CAP, max(0.0, RVOL_SCORE_PER_Z * z_vol_i))
        else:
            score = 0.0
        candidates.append({
            "index": i, "source": "RVOL", "score": score,
            "pivotKind": None, "eventLabel": None, "dominanceSpan": 0,
        })
    return candidates


# ---------------------------------------------------------------------------
# Fusión y selección
# ---------------------------------------------------------------------------

def sorted_candidates(candidates: list[dict]) -> list[dict]:
    return sorted(candidates, key=lambda c: (c["index"], SOURCE_PRIORITY[c["source"]]))


def nearest_pivot_index(index: int, pivots: list[dict]) -> int:
    best_index = -1
    best_distance = math.inf
    for pivot in pivots:
        distance = abs(pivot["index"] - index)
        if distance < best_distance or (distance == best_distance and pivot["index"] < best_index):
            best_distance = distance
            best_index = pivot["index"]
    return best_index


def split_cluster_by_polarity(cluster: list[dict]) -> list[list[dict]]:
    low_pivots = [c for c in cluster if c["pivotKind"] == "LOW"]
    high_pivots = [c for c in cluster if c["pivotKind"] == "HIGH"]
    if not low_pivots or not high_pivots:
        return [sorted_candidates(cluster)]
    low_group = list(low_pivots)
    high_group = list(high_pivots)
    for candidate in cluster:
        if candidate["pivotKind"] is not None:
            continue
        nearest_low = nearest_pivot_index(candidate["index"], low_pivots)
        nearest_high = nearest_pivot_index(candidate["index"], high_pivots)
        distance_low = abs(candidate["index"] - nearest_low)
        distance_high = abs(candidate["index"] - nearest_high)
        if distance_low < distance_high:
            low_group.append(candidate)
        elif distance_high < distance_low:
            high_group.append(candidate)
        elif nearest_low <= nearest_high:
            low_group.append(candidate)
        else:
            high_group.append(candidate)
    return [sorted_candidates(low_group), sorted_candidates(high_group)]


def merge_clusters(window: list[dict], candidates: list[dict]) -> list[dict]:
    n = len(window)
    if n == 0:
        return []

    global_low_idx, global_high_idx = find_global_extremes(window)

    ordered = sorted_candidates(candidates)
    contiguous: list[list[dict]] = []
    current: list[dict] = []
    for candidate in ordered:
        if current and candidate["index"] - current[-1]["index"] > CLUSTER_MAX_DISTANCE_BARS:
            contiguous.append(current)
            current = []
        current.append(candidate)
    if current:
        contiguous.append(current)

    clusters: list[list[dict]] = []
    for cluster in contiguous:
        clusters.extend(split_cluster_by_polarity(cluster))

    merged: list[dict] = []
    for cluster in clusters:
        event_score = 0.0
        pivot_score = 0.0
        rvol_score = 0.0
        has_event = False
        has_pivot_major = False
        has_pivot_intermediate = False
        has_rvol = False
        max_dominance_span = 0
        event_labels: list[str] = []
        for candidate in cluster:
            max_dominance_span = max(max_dominance_span, candidate["dominanceSpan"])
            if candidate["source"] == "EVENT":
                has_event = True
                event_score = max(event_score, candidate["score"])
                if candidate["eventLabel"] is not None:
                    event_labels.append(candidate["eventLabel"])
            elif candidate["source"] == "PIVOT_MAJOR":
                has_pivot_major = True
                pivot_score = max(pivot_score, candidate["score"])
            elif candidate["source"] == "PIVOT_INTERMEDIATE":
                has_pivot_intermediate = True
                pivot_score = max(pivot_score, candidate["score"])
            elif candidate["source"] == "RVOL":
                has_rvol = True
                rvol_score = max(rvol_score, candidate["score"])

        score = event_score + pivot_score + rvol_score
        sources: list[str] = []
        if has_event:
            sources.append("EVENT")
        if has_pivot_major:
            sources.append("PIVOT_MAJOR")
        elif has_pivot_intermediate:
            sources.append("PIVOT_INTERMEDIATE")
        if has_rvol:
            sources.append("RVOL")

        pivot_members = [c for c in cluster if c["source"] in ("PIVOT_MAJOR", "PIVOT_INTERMEDIATE")]
        if pivot_members:
            winner = pivot_members[0]
            for candidate in pivot_members[1:]:
                cand_volume = window[candidate["index"]]["volume"]
                win_volume = window[winner["index"]]["volume"]
                if candidate["score"] > winner["score"]:
                    winner = candidate
                elif candidate["score"] == winner["score"] and (
                    cand_volume > win_volume
                    or (cand_volume == win_volume and candidate["index"] < winner["index"])
                ):
                    winner = candidate
        else:
            winner = cluster[0]
            for candidate in cluster[1:]:
                cand_volume = window[candidate["index"]]["volume"]
                win_volume = window[winner["index"]]["volume"]
                if cand_volume > win_volume or (
                    cand_volume == win_volume and candidate["index"] < winner["index"]
                ):
                    winner = candidate

        bar = window[winner["index"]]
        if winner["pivotKind"] == "LOW":
            anchor_price = bar["low"]
        elif winner["pivotKind"] == "HIGH":
            anchor_price = bar["high"]
        else:
            anchor_price = bar["close"]

        event_label = "/".join(sorted(set(event_labels))) if event_labels else None
        merged.append({
            "anchorIndex": winner["index"],
            "anchorPrice": anchor_price,
            "pivotKind": winner["pivotKind"],
            "sources": sources,
            "eventLabel": event_label,
            "score": score,
            "hasPivotMajor": has_pivot_major,
            "maxDominanceSpan": max_dominance_span,
            "isBullishBar": bar["close"] > bar["open"],
            "isGlobalExtreme": winner["index"] in (global_low_idx, global_high_idx),
            "currentAvwap": None,
            "distancePct": None,
            "finalScore": None,
        })
    return merged


def compare_structural_candidates(a: dict, b: dict) -> int:
    if a["hasPivotMajor"] != b["hasPivotMajor"]:
        return -1 if a["hasPivotMajor"] else 1
    if a["finalScore"] != b["finalScore"]:
        return -1 if a["finalScore"] > b["finalScore"] else 1
    if a["maxDominanceSpan"] != b["maxDominanceSpan"]:
        return -1 if a["maxDominanceSpan"] > b["maxDominanceSpan"] else 1
    distance_a = abs(a["distancePct"])
    distance_b = abs(b["distancePct"])
    if distance_a != distance_b:
        return -1 if distance_a < distance_b else 1
    if a["anchorIndex"] != b["anchorIndex"]:
        return -1 if a["anchorIndex"] > b["anchorIndex"] else 1
    return 0


def resolve_role_selection(
    scored: list[dict], last_close: float
) -> tuple[dict | None, dict | None, dict | None]:
    def pick_top_dominant(kind: str) -> dict | None:
        top: dict | None = None
        for cluster in scored:
            if cluster["pivotKind"] != kind or not cluster["hasPivotMajor"]:
                continue
            if top is None or cluster["maxDominanceSpan"] > top["maxDominanceSpan"]:
                top = cluster
        return top

    top_dominant_low = pick_top_dominant("LOW")
    top_dominant_high = pick_top_dominant("HIGH")
    for cluster in scored:
        exempt = cluster["isGlobalExtreme"] or (
            top_dominant_low is not None
            and cluster is top_dominant_low
            and top_dominant_low["maxDominanceSpan"] >= TOP_DOMINANT_MIN_SPAN
        ) or (
            top_dominant_high is not None
            and cluster is top_dominant_high
            and top_dominant_high["maxDominanceSpan"] >= TOP_DOMINANT_MIN_SPAN
        )
        if abs(cluster["distancePct"]) > MAX_DISTANCE_PCT and not exempt:
            cluster["finalScore"] = cluster["score"] - FAR_PENALTY
        else:
            cluster["finalScore"] = cluster["score"]

    def first_of_tier(tiers: list) -> dict | None:
        for tier in tiers:
            members = [cluster for cluster in scored if tier(cluster)]
            if not members:
                continue
            return sorted(members, key=cmp_to_key(compare_structural_candidates))[0]
        return None

    support = first_of_tier([
        lambda c: c["pivotKind"] == "LOW" and c["currentAvwap"] <= last_close,
        lambda c: c["pivotKind"] == "LOW" and c["anchorPrice"] <= last_close,
        lambda c: (
            c["pivotKind"] is None
            and "EVENT" in c["sources"]
            and c["isBullishBar"]
            and c["currentAvwap"] <= last_close
        ),
        lambda c: (
            c["pivotKind"] is None
            and "RVOL" in c["sources"]
            and c["isBullishBar"]
            and c["currentAvwap"] <= last_close
        ),
    ])

    resistance = first_of_tier([
        lambda c: c["pivotKind"] == "HIGH" and c["currentAvwap"] > last_close,
        lambda c: c["pivotKind"] == "HIGH" and c["anchorPrice"] >= last_close,
    ])

    event_candidates = [
        cluster for cluster in scored
        if "EVENT" in cluster["sources"]
        and (support is None or cluster["anchorIndex"] != support["anchorIndex"])
        and (resistance is None or cluster["anchorIndex"] != resistance["anchorIndex"])
    ]
    event_candidates.sort(key=lambda c: (
        -c["finalScore"], -c["anchorIndex"], abs(c["distancePct"]),
    ))
    event = event_candidates[0] if event_candidates else None
    return support, resistance, event


def select_anchors(window: list[dict], events: list[dict]) -> list[dict]:
    n = len(window)
    if n == 0:
        return []
    if not (window[n - 1]["close"] > 0):
        return []

    atr = atr_series(window)
    stats = volume_stats(window)
    candidates = (
        event_candidates(window, events)
        + pivot_candidates(window, atr)
        + rvol_candidates(window, atr, stats)
    )
    merged = merge_clusters(window, candidates)
    last_close = window[n - 1]["close"]

    scored: list[dict] = []
    for cluster in merged:
        current = welford_last_vwap(window, cluster["anchorIndex"])
        if current is None:
            continue
        cluster["currentAvwap"] = current
        cluster["distancePct"] = (current - last_close) / last_close
        scored.append(cluster)

    support, resistance, event = resolve_role_selection(scored, last_close)

    anchors: list[dict] = []
    for role, cluster in (("SUPPORT", support), ("RESISTANCE", resistance), ("EVENT", event)):
        if cluster is None:
            continue
        bar = window[cluster["anchorIndex"]]
        anchors.append({
            "role": role,
            "anchorTimeSec": bar["time"],
            "windowIndex": cluster["anchorIndex"],
            "anchorPrice": cluster["anchorPrice"],
            "currentAvwap": cluster["currentAvwap"],
            "distancePct": cluster["distancePct"],
            "score": cluster["finalScore"],
            "sources": cluster["sources"],
            "eventLabel": cluster["eventLabel"],
        })
    return anchors[:MAX_ANCHORS]


# ---------------------------------------------------------------------------
# Proyección multi-timeframe (referencia de resolveAutoAvwapBarIndex)
# ---------------------------------------------------------------------------

def find_nearest_index(bars: list[dict], target: float) -> int:
    if not math.isfinite(target):
        return -1
    best = -1
    best_distance = math.inf
    for i, bar in enumerate(bars):
        if not math.isfinite(bar["time"]):
            continue
        distance = abs(bar["time"] - target)
        if distance < best_distance:
            best_distance = distance
            best = i
    return best


def resolve_projected_index(bars: list[dict], anchor: float, timeframe: str) -> int:
    if len(bars) == 0 or not math.isfinite(anchor):
        return -1
    if timeframe == "1D":
        idx = find_nearest_index(bars, anchor)
        if idx < 0:
            return -1
        return idx if abs(bars[idx]["time"] - anchor) <= 4 * SECONDS_PER_DAY else -1
    if timeframe == "1W":
        for i in range(len(bars) - 1):
            if bars[i]["time"] <= anchor < bars[i + 1]["time"]:
                return i
        last = bars[-1]
        if anchor >= last["time"] and anchor - last["time"] <= 6 * SECONDS_PER_DAY:
            return len(bars) - 1
        fallback = find_nearest_index(bars, anchor)
        if fallback >= 0 and abs(bars[fallback]["time"] - anchor) <= 7 * SECONDS_PER_DAY:
            return fallback
        return -1
    first = bars[0]
    last = bars[-1]
    if anchor < first["time"] - SECONDS_PER_DAY or anchor > last["time"] + SECONDS_PER_DAY:
        return -1
    for i in range(len(bars)):
        if bars[i]["time"] >= anchor:
            return i
    return -1


# ---------------------------------------------------------------------------
# Construcción de escenarios deterministas
# ---------------------------------------------------------------------------

def build_scenario_1() -> dict:
    moments = weekday_series(datetime(2025, 1, 6, 13, 30, tzinfo=UTC), 200)
    bars: list[dict] = []
    for i in range(200):
        volume = 900 + (i * 7) % 200
        if i <= 30:
            close = 140.0 - (40.0 * i) / 30.0
            bar = mk_bar(moments[i], close + 0.3, close + 0.7, close - 0.5, close, volume)
        elif i == 31:
            bar = mk_bar(moments[i], 100.0, 104.0, 100.0, 103.0, 5000)
        elif i <= 150:
            close = 103.0 + (152.0 - 103.0) * (i - 32) / (150.0 - 32.0)
            bar = mk_bar(moments[i], close - 0.2, close + 0.7, close - 0.5, close, volume)
        elif i == 151:
            bar = mk_bar(moments[i], 152.0, 152.0, 146.0, 147.0, 5000)
        else:
            close = 147.0 - 2.0 * (i - 152) / 47.0
            bar = mk_bar(moments[i], close + 0.2, close + 0.5, close - 0.6, close, volume)
        bars.append(bar)

    bars[30]["open"] = 101.0
    bars[30]["high"] = 101.0
    bars[30]["low"] = 100.0
    bars[30]["close"] = 100.0

    events = [
        {
            "utcSec": int((moments[90].replace(hour=12, minute=0)).timestamp()),
            "label": "Earnings",
            "timeOfDay": "bmo",
            "date": bar_date_key(int(moments[90].timestamp())),
        },
        {
            "utcSec": int((moments[119].replace(hour=21, minute=0)).timestamp()),
            "label": "Earnings",
            "timeOfDay": "amc",
            "date": bar_date_key(int(moments[119].timestamp())),
        },
    ]
    return {"name": "pivot_rvol_balanced_pincer", "dailyBars": bars, "events": events}


def build_scenario_2() -> dict:
    moments = weekday_series(datetime(2025, 3, 3, 13, 30, tzinfo=UTC), 200)
    bars: list[dict] = []
    for i in range(200):
        volume = 900 + (i * 11) % 200
        if i <= 40:
            close = 100.0 + (169.0 - 100.0) * i / 40.0
            bar = mk_bar(moments[i], close - 0.3, close + 0.6, close - 0.5, close, volume)
        elif i == 41:
            bar = mk_bar(moments[i], 170.0, 170.5, 163.0, 164.0, 6000)
        elif i == 42:
            bar = mk_bar(moments[i], 164.0, 165.0, 162.5, 163.2, volume)
        elif i == 43:
            bar = mk_bar(moments[i], 163.0, 164.0, 158.0, 159.0, 6000)
        elif i <= 189:
            close = 159.0 - (159.0 - 121.0) * (i - 44) / 145.0
            bar = mk_bar(moments[i], close + 0.2, close + 0.5, close - 0.6, close, volume)
        elif i == 190:
            bar = mk_bar(moments[i], 120.0, 121.3, 117.9, 120.9, 2500)
        elif i == 191:
            bar = mk_bar(moments[i], 120.4, 120.8, 119.4, 120.0, volume)
        elif i == 192:
            bar = mk_bar(moments[i], 118.2, 119.3, 115.3, 119.0, 2500)
        elif i == 199:
            bar = mk_bar(moments[i], 113.6, 121.0, 113.4, 119.8, volume)
        else:
            close = 119.0 - (119.0 - 113.9) * (i - 192) / 6.0
            bar = mk_bar(moments[i], close + 0.2, close + 0.5, close - 0.6, close, volume)
        bars.append(bar)

    bars[40]["high"] = 171.0
    bars[40]["close"] = 169.4
    bars[40]["open"] = 168.6
    bars[40]["low"] = 168.2

    events = [
        {
            "utcSec": int((moments[42].replace(hour=12, minute=0)).timestamp()),
            "label": "Earnings",
            "timeOfDay": "bmo",
            "date": bar_date_key(int(moments[42].timestamp())),
        },
        {
            "utcSec": int((moments[50].replace(hour=12, minute=0)).timestamp()),
            "label": "Earnings",
            "timeOfDay": "bmo",
            "date": bar_date_key(int(moments[50].timestamp())),
        },
    ]
    return {"name": "cluster_fusion_within_3_bars", "dailyBars": bars, "events": events}


def build_scenario_3() -> dict:
    moments = weekday_series(datetime(2025, 5, 5, 13, 30, tzinfo=UTC), 200)
    bars: list[dict] = []
    for i in range(200):
        volume = 900 + (i * 5) % 200
        if i <= 15:
            close = 305.0 + (320.0 - 305.0) * i / 15.0
            bar = mk_bar(moments[i], close - 0.4, close + 0.8, close - 0.6, close, volume)
        elif i <= 60:
            close = 320.0 - (320.0 - 100.0) * (i - 16) / 44.0
            bar = mk_bar(moments[i], close + 0.6, close + 1.0, close - 1.0, close, volume)
        elif i <= 189:
            close = 100.0 + 12.0 * (i - 61) / 128.0
            bar = mk_bar(moments[i], close - 0.2, close + 0.4, close - 0.35, close, volume)
        else:
            close = 112.0 + (260.0 - 112.0) * (i - 190) / 9.0
            bar = mk_bar(moments[i], close - 2.0, close + 1.0, close - 2.5, close, volume)
        bars.append(bar)

    bars[15]["high"] = 320.0
    bars[15]["close"] = 319.0
    bars[60]["low"] = 100.0
    bars[60]["close"] = 101.0

    events = [
        {
            "utcSec": int((moments[120].replace(hour=12, minute=0)).timestamp()),
            "label": "Earnings",
            "timeOfDay": "bmo",
            "date": bar_date_key(int(moments[120].timestamp())),
        },
    ]
    return {"name": "far_penalty_25pct_and_global_exemption", "dailyBars": bars, "events": events}


def build_scenario_4() -> dict:
    moments = weekday_series(datetime(2025, 7, 7, 13, 30, tzinfo=UTC), 85)
    bars: list[dict] = []
    for i in range(85):
        if i <= 65:
            close = 150.0 + (200.0 - 150.0) * i / 65.0
            bar = mk_bar(moments[i], close - 0.3, close + 0.6, close - 0.5, close, 1000)
        elif i == 66:
            bar = mk_bar(moments[i], 199.0, 199.5, 190.0, 191.0, 6000)
        else:
            close = 191.0 - (191.0 - 160.0) * (i - 67) / 17.0
            bar = mk_bar(moments[i], close + 0.3, close + 0.6, close - 0.6, close, 1000)
        bars.append(bar)

    bars[65]["high"] = 200.0
    bars[65]["close"] = 199.4
    return {"name": "degradation_no_events_and_zero_std", "dailyBars": bars, "events": []}


def build_scenario_5() -> dict:
    moments = weekday_series(datetime(2025, 9, 1, 13, 30, tzinfo=UTC), 10)
    bars: list[dict] = []
    for i in range(10):
        close = 50.0 + i * 0.8
        bars.append(mk_bar(moments[i], close - 0.2, close + 0.4, close - 0.3, close, 1000 + i * 10))
    # Pieza 50.5.1: la vela del evento es bajista => no secuestra SUPPORT; siempre EVENT.
    bars[4]["open"] = bars[4]["close"] + 0.3
    bars[4]["high"] = bars[4]["close"] + 0.5
    bars[4]["low"] = bars[4]["close"] - 0.4
    events = [
        {
            "utcSec": int((moments[4].replace(hour=12, minute=0)).timestamp()),
            "label": "Earnings",
            "timeOfDay": "bmo",
            "date": bar_date_key(int(moments[4].timestamp())),
        },
    ]
    return {"name": "edge_short_and_empty", "dailyBars": bars, "events": events, "emptyBars": []}


def build_scenario_6() -> dict:
    """Swing Low cuyo precio posterior cae debajo de su propio AVWAP: jamás RESISTANCE."""
    moments = weekday_series(datetime(2025, 6, 2, 13, 30, tzinfo=UTC), 120)
    bars: list[dict] = []
    for i in range(120):
        volume = 900 + (i * 7) % 200
        if i <= 60:
            close = 200.0 - 100.0 * i / 60.0
            bar = mk_bar(moments[i], close + 0.3, close + 0.8, close - 0.6, close, volume)
        elif i <= 75:
            close = 100.0 + (110.0 - 100.0) * (i - 60) / 15.0
            bar = mk_bar(moments[i], close - 0.2, close + 0.5, close - 0.4, close, volume)
        else:
            close = 110.0 - (110.0 - 104.5) * (i - 75) / 44.0
            bar = mk_bar(moments[i], close + 0.2, close + 0.5, close - 0.6, close, volume)
        bars.append(bar)
    bars[60]["low"] = 100.0
    bars[60]["close"] = 100.5
    bars[75]["high"] = 110.4
    return {"name": "polarity_low_below_avwap_never_resistance", "dailyBars": bars, "events": []}


def build_scenario_7() -> dict:
    """Swing High recuperado por encima de su AVWAP: jamás SUPPORT (único pivote)."""
    moments = weekday_series(datetime(2025, 8, 4, 13, 30, tzinfo=UTC), 140)
    bars: list[dict] = []
    for i in range(140):
        volume = 900 + (i * 5) % 200
        if i <= 40:
            close = 100.0 + (149.0 - 100.0) * i / 40.0
            bar = mk_bar(moments[i], close - 0.3, close + 0.6, close - 0.5, close, volume)
        elif i <= 138:
            close = 149.0 - (149.0 - 100.0) * (i - 40) / 98.0
            bar = mk_bar(moments[i], close + 0.2, close + 0.5, close - 0.6, close, volume)
        else:
            bar = mk_bar(moments[i], 100.0, 146.0, 99.8, 145.0, volume)
        bars.append(bar)
    bars[40]["high"] = 150.0
    bars[40]["close"] = 149.4
    return {"name": "polarity_high_reclaimed_never_support", "dailyBars": bars, "events": []}


def build_scenario_8() -> dict:
    """Techo dominante 6M–1Y en el borde derecho (n-5) vs pico intermedio + RVOL."""
    moments = weekday_series(datetime(2025, 10, 6, 13, 30, tzinfo=UTC), 380)
    bars: list[dict] = []
    for i in range(380):
        volume = 900 + (i * 7) % 200
        if i <= 60:
            close = 260.0 - 160.0 * i / 60.0
            bar = mk_bar(moments[i], close + 0.5, close + 1.2, close - 1.0, close, volume)
        elif i <= 119:
            close = 100.5 + (198.0 - 100.5) * (i - 60) / 59.0
            bar = mk_bar(moments[i], close - 0.4, close + 0.8, close - 0.8, close, volume)
        elif i == 120:
            bar = mk_bar(moments[i], 198.0, 255.0, 197.0, 245.0, volume)
        elif i <= 160:
            close = 245.0 - (245.0 - 170.0) * (i - 120) / 40.0
            bar = mk_bar(moments[i], close + 0.5, close + 0.9, close - 0.9, close, volume)
        elif i == 199:
            bar = mk_bar(moments[i], 212.0, 214.0, 207.0, 213.0, 6000)
        elif i <= 199:
            close = 170.0 + (214.0 - 170.0) * (i - 160) / 39.0
            bar = mk_bar(moments[i], close - 0.4, close + 0.8, close - 0.8, close, volume)
        elif i == 200:
            bar = mk_bar(moments[i], 214.0, 225.0, 213.0, 221.0, volume)
        elif i == 201:
            bar = mk_bar(moments[i], 222.0, 223.0, 215.0, 216.0, 6000)
        elif i <= 240:
            if i <= 224:
                close = 216.0 - (216.0 - 205.0) * (i - 201) / 23.0
            else:
                close = 205.0 + (232.0 - 205.0) * (i - 224) / 16.0
            bar = mk_bar(moments[i], close - 0.3, close + 0.7, close - 0.7, close, volume)
        elif i <= 260:
            close = 232.0 - (232.0 - 208.0) * (i - 240) / 20.0
            bar = mk_bar(moments[i], close + 0.3, close + 0.7, close - 0.7, close, volume)
        elif i <= 290:
            close = 208.0 + (240.0 - 208.0) * (i - 260) / 30.0
            bar = mk_bar(moments[i], close - 0.3, close + 0.7, close - 0.7, close, volume)
        elif i <= 330:
            close = 240.0 - (240.0 - 215.0) * (i - 290) / 40.0
            bar = mk_bar(moments[i], close + 0.3, close + 0.8, close - 0.8, close, volume)
        elif i <= 374:
            close = 215.0 + (318.0 - 215.0) * (i - 330) / 44.0
            bar = mk_bar(moments[i], close - 0.3, close + 0.7, close - 0.6, close, volume)
        else:
            close = 317.0 - (317.0 - 310.0) * (i - 375) / 4.0
            bar = mk_bar(moments[i], close + 0.2, close + 0.6, close - 0.8, close, volume)
        bars.append(bar)
    bars[60]["low"] = 100.0
    bars[60]["close"] = 100.5
    bars[375]["open"] = 316.5
    bars[375]["high"] = 320.0
    bars[375]["low"] = 315.0
    bars[375]["close"] = 317.5
    return {"name": "dominant_6m_1y_beats_minor_peak_and_rvol", "dailyBars": bars, "events": []}


# ---------------------------------------------------------------------------
# Serialización del fixture
# ---------------------------------------------------------------------------

def nan_to_null(values: list[float | None]) -> list[float | None]:
    return [None if v is None or not math.isfinite(v) else v for v in values]


def serialize_scenario(scenario: dict) -> dict:
    sanitized = sanitize_bars(scenario["dailyBars"])
    window = sanitized[-WINDOW_BARS:]
    atr = atr_series(window)
    stats = volume_stats(window)
    anchors = select_anchors(window, scenario["events"])
    payload = {
        "name": scenario["name"],
        "dailyBars": scenario["dailyBars"],
        "events": scenario["events"],
        "windowBars": len(window),
        "lastClose": window[len(window) - 1]["close"] if window else None,
        "atr14": nan_to_null(atr),
        "smaVol20": nan_to_null(stats["smaVol"]),
        "stdVol20": nan_to_null(stats["stdVol"]),
        "rvol20": nan_to_null(stats["rvol"]),
        "zVol20": nan_to_null(stats["zVol"]),
        "expectedAnchors": anchors,
    }
    if "emptyBars" in scenario:
        payload["emptyBars"] = scenario["emptyBars"]
        payload["emptyAnchors"] = select_anchors([], scenario["events"])
    return payload


def assert_close(actual: float, expected: float, label: str) -> None:
    if not math.isfinite(actual) or abs(actual - expected) > TOLERANCE:
        raise AssertionError(f"{label}: {actual!r} != {expected!r} (tol {TOLERANCE})")


def validate_scenario_1(payload: dict, scenario: dict) -> None:
    bars = sanitize_bars(scenario["dailyBars"])
    anchors = payload["expectedAnchors"]
    assert [a["role"] for a in anchors] == ["SUPPORT", "RESISTANCE", "EVENT"], anchors
    support, resistance, event = anchors
    assert support["windowIndex"] == 30, support
    assert support["sources"] == ["PIVOT_MAJOR", "RVOL"], support
    expected_support = pivot_major_score(
        dominance_span_for_low(bars, 30, bars[30]["low"])
    ) + min(RVOL_SCORE_CAP, max(0.0, RVOL_SCORE_PER_Z * payload["zVol20"][31]))
    assert_close(support["score"], expected_support, "s1.support.score")
    assert_close(support["anchorPrice"], bars[30]["low"], "s1.support.anchorPrice")
    assert resistance["windowIndex"] == 150, resistance
    assert resistance["sources"] == ["PIVOT_MAJOR", "RVOL"], resistance
    expected_resistance = pivot_major_score(
        dominance_span_for_high(bars, 150, bars[150]["high"])
    ) + min(RVOL_SCORE_CAP, max(0.0, RVOL_SCORE_PER_Z * payload["zVol20"][151]))
    assert_close(resistance["score"], expected_resistance, "s1.resistance.score")
    assert_close(resistance["anchorPrice"], bars[150]["high"], "s1.resistance.anchorPrice")
    assert event["sources"] == ["EVENT"], event
    assert event["eventLabel"] == "Earnings", event
    assert_close(event["score"], 35.0, "s1.event.score")


def validate_scenario_2(payload: dict, scenario: dict) -> None:
    bars = sanitize_bars(scenario["dailyBars"])
    anchors = payload["expectedAnchors"]
    assert [a["role"] for a in anchors] == ["SUPPORT", "RESISTANCE", "EVENT"], anchors
    support, resistance, event = anchors
    assert resistance["windowIndex"] == 40, resistance
    assert resistance["sources"] == ["EVENT", "PIVOT_MAJOR", "RVOL"], resistance
    expected_resistance = 35.0 + pivot_major_score(
        dominance_span_for_high(bars, 40, bars[40]["high"])
    ) + max(
        min(RVOL_SCORE_CAP, max(0.0, RVOL_SCORE_PER_Z * payload["zVol20"][41])),
        min(RVOL_SCORE_CAP, max(0.0, RVOL_SCORE_PER_Z * payload["zVol20"][43])),
    )
    assert_close(resistance["score"], expected_resistance, "s2.resistance.score")
    assert_close(resistance["anchorPrice"], bars[40]["high"], "s2.resistance.anchorPrice")
    # Clúster sin PIVOT: fallback RVOL alcista (solo sin Swing Low), empate por volumen
    # => menor índice y máximo por familia (no la suma).
    assert support["windowIndex"] == 190, support
    assert support["sources"] == ["RVOL"], support
    z190 = payload["zVol20"][190]
    z192 = payload["zVol20"][192]
    assert z190 is not None and z192 is not None
    assert_close(
        support["score"],
        max(
            min(RVOL_SCORE_CAP, max(0.0, RVOL_SCORE_PER_Z * z190)),
            min(RVOL_SCORE_CAP, max(0.0, RVOL_SCORE_PER_Z * z192)),
        ),
        "s2.support.max-not-sum",
    )
    assert event["windowIndex"] == 50, event
    assert event["sources"] == ["EVENT"], event
    assert_close(event["score"], 35.0, "s2.event.score")


def validate_scenario_3(payload: dict, scenario: dict) -> None:
    bars = sanitize_bars(scenario["dailyBars"])
    global_low_idx, global_high_idx = find_global_extremes(bars)
    anchors = payload["expectedAnchors"]
    assert [a["role"] for a in anchors] == ["SUPPORT", "RESISTANCE", "EVENT"], anchors
    support, resistance, event = anchors
    assert support["windowIndex"] == global_low_idx, support
    assert support["sources"] == ["PIVOT_MAJOR"], support
    assert abs(support["distancePct"]) > MAX_DISTANCE_PCT, support
    assert_close(
        support["score"],
        pivot_major_score(
            dominance_span_for_low(bars, global_low_idx, bars[global_low_idx]["low"])
        ),
        "s3.support.exempt-score",
    )
    assert support["score"] > MAJOR_SCORE_BASE, support  # exento de la penalización -20
    assert resistance["windowIndex"] == global_high_idx, resistance
    assert resistance["sources"] == ["PIVOT_MAJOR"], resistance
    assert abs(resistance["distancePct"]) > MAX_DISTANCE_PCT, resistance
    assert_close(
        resistance["score"],
        pivot_major_score(
            dominance_span_for_high(bars, global_high_idx, bars[global_high_idx]["high"])
        ),
        "s3.resistance.exempt-score",
    )
    assert resistance["score"] > MAJOR_SCORE_BASE, resistance
    assert event["windowIndex"] == 120, event
    assert event["sources"] == ["EVENT"], event
    assert_close(event["score"], 35.0 - FAR_PENALTY, "s3.event.penalized-score")
    assert abs(event["distancePct"]) > MAX_DISTANCE_PCT, event


def validate_scenario_4(payload: dict, scenario: dict) -> None:
    anchors = payload["expectedAnchors"]
    assert len(anchors) == 1, anchors
    resistance = anchors[0]
    assert resistance["role"] == "RESISTANCE", resistance
    assert resistance["sources"] == ["PIVOT_INTERMEDIATE", "RVOL"], resistance
    assert_close(resistance["score"], 15.0, "s4.resistance.score")
    assert payload["zVol20"][66] is None, payload["zVol20"][66]
    assert payload["rvol20"][66] is not None and payload["rvol20"][66] >= RVOL_THRESHOLD
    for anchor in anchors:
        assert anchor["eventLabel"] is None
        for key in ("anchorTimeSec", "anchorPrice", "currentAvwap", "distancePct", "score"):
            assert math.isfinite(anchor[key]), (key, anchor)
    assert all(
        source in ("PIVOT_MAJOR", "PIVOT_INTERMEDIATE", "RVOL")
        for anchor in anchors
        for source in anchor["sources"]
    )


def validate_scenario_5(payload: dict) -> None:
    anchors = payload["expectedAnchors"]
    assert [a["role"] for a in anchors] == ["EVENT"], anchors
    event = anchors[0]
    assert event["sources"] == ["EVENT"], event
    assert event["windowIndex"] == 4, event
    assert_close(event["score"], 35.0, "s5.event.score")
    for key in ("anchorTimeSec", "anchorPrice", "currentAvwap", "distancePct", "score"):
        assert math.isfinite(event[key]), (key, event)
    assert payload["emptyAnchors"] == [], payload["emptyAnchors"]


def validate_scenario_6(payload: dict) -> None:
    anchors = payload["expectedAnchors"]
    assert [a["role"] for a in anchors] == ["SUPPORT", "RESISTANCE"], anchors
    support, resistance = anchors
    assert support["windowIndex"] == 60, support
    assert support["sources"] == ["PIVOT_INTERMEDIATE"], support
    # Piso cuyo precio posterior cayó debajo de su AVWAP: nunca RESISTANCE.
    assert support["currentAvwap"] > payload["lastClose"], support
    assert support["anchorPrice"] <= payload["lastClose"], support
    assert resistance["windowIndex"] == 75, resistance
    assert resistance["sources"] == ["PIVOT_INTERMEDIATE"], resistance
    assert resistance["windowIndex"] != support["windowIndex"]


def validate_scenario_7(payload: dict) -> None:
    anchors = payload["expectedAnchors"]
    assert [a["role"] for a in anchors] == ["RESISTANCE"], anchors
    resistance = anchors[0]
    assert resistance["windowIndex"] == 40, resistance
    assert resistance["sources"] == ["PIVOT_MAJOR"], resistance
    # Techo recuperado por encima de su AVWAP: nunca SUPPORT (único pivote de la serie).
    assert resistance["currentAvwap"] <= payload["lastClose"], resistance
    assert resistance["anchorPrice"] >= payload["lastClose"], resistance


def validate_scenario_8(payload: dict) -> None:
    n = payload["windowBars"]
    anchors = payload["expectedAnchors"]
    assert [a["role"] for a in anchors] == ["SUPPORT", "RESISTANCE"], anchors
    support, resistance = anchors
    assert support["windowIndex"] == 60, support
    assert support["sources"] == ["PIVOT_MAJOR"], support
    assert abs(support["distancePct"]) > MAX_DISTANCE_PCT, support
    # Exención top-dominante (>= 180 ruedas): 60 pts exactos pese a caer > 25% del cierre.
    assert_close(support["score"], MAJOR_SCORE_BASE + MAJOR_SCORE_BONUS_MAX, "s8.support.exempt-score")
    assert resistance["windowIndex"] == n - 5, resistance
    assert resistance["sources"] == ["PIVOT_MAJOR"], resistance
    assert "RVOL" not in resistance["sources"], resistance
    assert abs(resistance["distancePct"]) < MAX_DISTANCE_PCT, resistance


# ---------------------------------------------------------------------------
# Casos de proyección multi-timeframe
# ---------------------------------------------------------------------------

def build_projection_cases() -> list[dict]:
    cases: list[dict] = []

    daily_moments = weekday_series(datetime(2025, 1, 6, 13, 30, tzinfo=UTC), 10)
    daily_bars = [{"time": int(m.timestamp())} for m in daily_moments]
    cases.append({
        "name": "1d_nearest_inside_window",
        "bars": daily_bars,
        "anchorTimeSec": int(daily_moments[4].timestamp()) + 6 * 3_600,
        "timeframe": "1D",
        "expected": 4,
    })
    cases.append({
        "name": "1d_out_of_window_beyond_4_days",
        "bars": daily_bars,
        "anchorTimeSec": int(daily_moments[0].timestamp()) - 5 * SECONDS_PER_DAY,
        "timeframe": "1D",
        "expected": -1,
    })
    cases.append({
        "name": "1d_nearest_within_4_days_keeps_previous_on_tie",
        "bars": daily_bars,
        "anchorTimeSec": (int(daily_moments[2].timestamp()) + int(daily_moments[3].timestamp())) // 2,
        "timeframe": "1D",
        "expected": 2,
    })

    weekly_moments = [
        datetime(2025, 1, 6, 13, 30, tzinfo=UTC),
        datetime(2025, 1, 13, 13, 30, tzinfo=UTC),
        datetime(2025, 1, 21, 13, 30, tzinfo=UTC),  # MLK 2025-01-20: la semana arranca el martes
        datetime(2025, 1, 27, 13, 30, tzinfo=UTC),
        datetime(2025, 2, 3, 13, 30, tzinfo=UTC),
    ]
    weekly_bars = [{"time": int(m.timestamp())} for m in weekly_moments]
    cases.append({
        "name": "1w_containing_week_midweek_anchor",
        "bars": weekly_bars,
        "anchorTimeSec": int(datetime(2025, 1, 15, 13, 30, tzinfo=UTC).timestamp()),
        "timeframe": "1W",
        "expected": 1,
    })
    cases.append({
        "name": "1w_holiday_monday_anchor_lands_on_tuesday_bar",
        "bars": weekly_bars,
        "anchorTimeSec": int(weekly_moments[2].timestamp()),
        "timeframe": "1W",
        "expected": 2,
    })
    cases.append({
        "name": "1w_after_last_within_6_days_uses_last_week",
        "bars": weekly_bars,
        "anchorTimeSec": int(weekly_moments[-1].timestamp()) + 3 * SECONDS_PER_DAY,
        "timeframe": "1W",
        "expected": 4,
    })
    cases.append({
        "name": "1w_far_after_last_beyond_7_days_is_out",
        "bars": weekly_bars,
        "anchorTimeSec": int(weekly_moments[-1].timestamp()) + 8 * SECONDS_PER_DAY,
        "timeframe": "1W",
        "expected": -1,
    })

    intraday_moments: list[datetime] = []
    base_day = datetime(2025, 1, 6, 13, 30, tzinfo=UTC)
    for day_offset in range(2):
        for hour_index in range(4):
            intraday_moments.append(base_day + timedelta(days=day_offset, hours=hour_index))
    intraday_bars = [{"time": int(m.timestamp())} for m in intraday_moments]
    cases.append({
        "name": "intraday_first_bar_at_or_after_anchor",
        "bars": intraday_bars,
        "anchorTimeSec": int(intraday_moments[2].timestamp()) + 600,
        "timeframe": "1h",
        "expected": 3,
    })
    cases.append({
        "name": "intraday_midnight_anchor_maps_to_first_bar_same_utc_date",
        "bars": intraday_bars,
        "anchorTimeSec": int(datetime(2025, 1, 7, 0, 0, tzinfo=UTC).timestamp()),
        "timeframe": "1h",
        "expected": 4,
    })
    cases.append({
        "name": "intraday_anchor_before_window_is_out",
        "bars": intraday_bars,
        "anchorTimeSec": int(intraday_moments[0].timestamp()) - 2 * SECONDS_PER_DAY,
        "timeframe": "4h",
        "expected": -1,
    })
    cases.append({
        "name": "intraday_anchor_after_window_is_out",
        "bars": intraday_bars,
        "anchorTimeSec": int(intraday_moments[-1].timestamp()) + 2 * SECONDS_PER_DAY,
        "timeframe": "1h",
        "expected": -1,
    })
    return cases


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    scenarios = [
        build_scenario_1(),
        build_scenario_2(),
        build_scenario_3(),
        build_scenario_4(),
        build_scenario_5(),
        build_scenario_6(),
        build_scenario_7(),
        build_scenario_8(),
    ]
    payloads = [serialize_scenario(scenario) for scenario in scenarios]

    validate_scenario_1(payloads[0], scenarios[0])
    validate_scenario_2(payloads[1], scenarios[1])
    validate_scenario_3(payloads[2], scenarios[2])
    validate_scenario_4(payloads[3], scenarios[3])
    validate_scenario_5(payloads[4])
    validate_scenario_6(payloads[5])
    validate_scenario_7(payloads[6])
    validate_scenario_8(payloads[7])

    projection_cases = build_projection_cases()
    scenario_by_name = {scenario["name"]: scenario for scenario in scenarios}
    for case in projection_cases:
        # Verificación independiente del propio generador.
        expected = resolve_projected_index(case["bars"], case["anchorTimeSec"], case["timeframe"])
        if expected != case["expected"]:
            raise AssertionError(
                f"projection case {case['name']}: impl={expected} fixture={case['expected']}"
            )
    del scenario_by_name

    fixture = {
        "meta": {
            "generator": "tools/gen_auto_avwap_pieza50_5_reference.py",
            "precisionTolerance": TOLERANCE,
        },
        "scenarios": payloads,
        "projectionCases": projection_cases,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUT_PATH.open("w", encoding="utf-8") as handle:
        json.dump(fixture, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    print(f"[Pieza 50.5] Fixture generado: {OUT_PATH}")
    for payload in payloads:
        names = ", ".join(
            f"{a['role']}@{a['windowIndex']}(score={a['score']})" for a in payload["expectedAnchors"]
        )
        print(f"  - {payload['name']}: {names if names else 'sin anclas'}")


if __name__ == "__main__":
    main()
