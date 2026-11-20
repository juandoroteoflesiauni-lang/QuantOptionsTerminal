#!/usr/bin/env python3
"""Independent Python reference generator for Pieza 49 (Phase 2 Optimization).

Generates fixtures/perf_phase2_reference.json without copying TypeScript logic.
"""

from __future__ import annotations

import json
import math
import struct
from pathlib import Path

DEFAULT_SOA_CAPACITY = 1200
DEFAULT_TRADE_RING_CAPACITY = 2048
SOA_DELTA_STRIDE = 10
MAX_DELTA_ITEMS_PER_FRAME = 120
DELTA_FRAME_BUFFER_BYTES = MAX_DELTA_ITEMS_PER_FRAME * SOA_DELTA_STRIDE * 8
L2_VISUAL_PULSE_MS = 100
TABLE_VISUAL_PULSE_MS = 220


def f32(val: float | None) -> float | None:
    if val is None or math.isnan(val):
        return None
    return struct.unpack("<f", struct.pack("<f", val))[0]


def format_es_ar(value: float | None, decimals: int = 2, prefix: str = "", suffix: str = "") -> str:
    if value is None or not math.isfinite(value):
        return "—"
    sign = "-" if value < 0 else ""
    fixed = f"{abs(value):.{decimals}f}"
    if "." in fixed:
        int_part, dec_part = fixed.split(".", 1)
    else:
        int_part, dec_part = fixed, ""
    grouped = f"{int(int_part):,}".replace(",", ".")
    body = f"{sign}{grouped},{dec_part}" if decimals > 0 else f"{sign}{grouped}"
    return f"{prefix}{body}{suffix}"


def build_soa_cases() -> dict[str, object]:
    raw_symbols = [
        "ar:ggal",
        "US:NVDA",
        "nvda261120c00140000",
        "AR:GGAL",
        "  us:spy ",
    ]
    sym_to_id: dict[str, int] = {}
    reg_results: list[dict[str, object]] = []
    next_id = 0
    for raw in raw_symbols:
        clean = raw.strip().upper()
        if clean not in sym_to_id:
            sym_to_id[clean] = next_id
            next_id += 1
        reg_results.append({"raw": raw, "normalized": clean, "id": sym_to_id[clean]})

    # Columns initialized to NaN / 0
    rows: dict[int, dict[str, float | int | None]] = {
        idx: {
            "bid": None,
            "ask": None,
            "last": None,
            "bidSize": 0,
            "askSize": 0,
            "timestamp": None,
            "iv": None,
            "delta": None,
            "gamma": None,
        }
        for idx in range(next_id)
    }

    deltas_batch_1 = [
        {
            "id": 0,
            "bid": 7050.25,
            "ask": 7060.75,
            "last": 7055.5,
            "bidSize": 1200,
            "askSize": 850,
            "timestamp": 1794580680.0,
            "iv": 0.4825,
            "delta": 0.5123,
            "gamma": 0.0042,
        },
        {
            "id": 2,
            "bid": 5.15,
            "ask": 5.35,
            "last": 5.25,
            "bidSize": 40,
            "askSize": 65,
            "timestamp": 1794580681.0,
            "iv": 0.6145,
            "delta": 0.4412,
            "gamma": 0.0315,
        },
        # Out-of-bounds id should be ignored
        {
            "id": 9999,
            "bid": 1.0,
            "ask": 2.0,
            "last": 1.5,
            "bidSize": 1,
            "askSize": 1,
            "timestamp": 1794580682.0,
            "iv": 0.1,
            "delta": 0.1,
            "gamma": 0.1,
        },
    ]

    # Partial update: None represents NaN sentinel (preserve existing field)
    deltas_batch_2 = [
        {
            "id": 0,
            "bid": None,
            "ask": None,
            "last": 7090.0,
            "bidSize": None,
            "askSize": None,
            "timestamp": 1794580690.0,
            "iv": None,
            "delta": None,
            "gamma": None,
        },
        {
            "id": 1,
            "bid": 141.9,
            "ask": 142.0,
            "last": 141.95,
            "bidSize": 500,
            "askSize": 300,
            "timestamp": 1794580691.0,
            "iv": None,
            "delta": None,
            "gamma": None,
        },
    ]

    for batch in (deltas_batch_1, deltas_batch_2):
        for item in batch:
            idx = int(item["id"])
            if 0 <= idx < DEFAULT_SOA_CAPACITY and idx in rows:
                target = rows[idx]
                for col in ("bid", "ask", "last", "timestamp"):
                    v = item[col]
                    if v is not None:
                        target[col] = float(v)
                for col in ("bidSize", "askSize"):
                    v = item[col]
                    if v is not None:
                        target[col] = int(v)
                for col in ("iv", "delta", "gamma"):
                    v = item[col]
                    if v is not None:
                        target[col] = f32(float(v))

    return {
        "registrations": reg_results,
        "uniqueCount": len(sym_to_id),
        "deltasBatch1": deltas_batch_1,
        "deltasBatch2": deltas_batch_2,
        "expectedApplied1": 2,
        "expectedApplied2": 2,
        "expectedRows": [
            {"id": idx, "symbol": sym, **rows[idx]}
            for sym, idx in sorted(sym_to_id.items(), key=lambda kv: kv[1])
        ],
    }


def build_ring_buffer_cases() -> dict[str, object]:
    total_pushes = 2105
    ring: list[dict[str, float | int]] = []
    for i in range(total_pushes):
        ring.append(
            {
                "price": 100.0 + i * 0.25,
                "size": (i % 50) + 1,
                "ts": 1794580000 + i,
            }
        )
    retained = ring[-DEFAULT_TRADE_RING_CAPACITY:]
    lifo = list(reversed(retained))

    queries = [
        {"offset": 0, "maxCount": 5},
        {"offset": 100, "maxCount": 4},
        {"offset": 2045, "maxCount": 10},
        {"offset": 2048, "maxCount": 5},
        {"offset": -1, "maxCount": 5},
    ]
    evaluated_queries = []
    for q in queries:
        off = q["offset"]
        mc = q["maxCount"]
        if off < 0 or off >= len(lifo):
            sliced: list[dict[str, float | int]] = []
        else:
            sliced = lifo[off : off + mc]
        evaluated_queries.append(
            {
                "offset": off,
                "maxCount": mc,
                "expectedCount": len(sliced),
                "expected": sliced,
            }
        )

    return {
        "capacity": DEFAULT_TRADE_RING_CAPACITY,
        "totalPushes": total_pushes,
        "expectedCount": len(retained),
        "queries": evaluated_queries,
    }


def build_bitmask_cases() -> dict[str, object]:
    dirty = set([0, 31, 32, 63, 64, 511, 512, 1199])
    visible_1 = {31, 64, 100, 512}
    frame_1 = sorted(dirty & visible_1)
    dirty -= set(frame_1)
    remaining_after_1 = sorted(dirty)

    visible_2 = {0, 63, 1199}
    frame_2 = sorted(dirty & visible_2)
    dirty -= set(frame_2)
    remaining_after_2 = sorted(dirty)

    burst_ids = list(range(250))
    burst_frame_1 = burst_ids[:MAX_DELTA_ITEMS_PER_FRAME]
    burst_frame_2 = burst_ids[MAX_DELTA_ITEMS_PER_FRAME : 2 * MAX_DELTA_ITEMS_PER_FRAME]
    burst_frame_3 = burst_ids[2 * MAX_DELTA_ITEMS_PER_FRAME :]

    return {
        "selective": {
            "initialDirty": [0, 31, 32, 63, 64, 511, 512, 1199],
            "visible1": sorted(visible_1),
            "expectedFrame1": frame_1,
            "expectedRemaining1": remaining_after_1,
            "visible2": sorted(visible_2),
            "expectedFrame2": frame_2,
            "expectedRemaining2": remaining_after_2,
        },
        "burstPagination": {
            "totalDirtyVisible": len(burst_ids),
            "expectedFrameCounts": [len(burst_frame_1), len(burst_frame_2), len(burst_frame_3)],
            "expectedHasMore": [True, True, False],
            "maxFrameBytes": DELTA_FRAME_BUFFER_BYTES,
        },
    }


def build_dom_registry_cases() -> dict[str, object]:
    steps = [
        {"value": 142.5, "expectMutated": False, "expectText": "$ 142,50", "expectDir": None},
        {
            "value": 142.5000000001,
            "expectMutated": False,
            "expectText": "$ 142,50",
            "expectDir": None,
        },
        {"value": 143.25, "expectMutated": True, "expectText": "$ 143,25", "expectDir": "up"},
        {"value": 141.8, "expectMutated": True, "expectText": "$ 141,80", "expectDir": "down"},
        {"value": None, "expectMutated": True, "expectText": "—", "expectDir": None},
        {"value": None, "expectMutated": False, "expectText": "—", "expectDir": None},
        {"value": 140.0, "expectMutated": True, "expectText": "$ 140,00", "expectDir": None},
    ]

    # Cross-check formatting independently
    for step in steps:
        val = step["value"]
        assert format_es_ar(val, 2, "$ ") == step["expectText"]

    return {
        "initialValue": 142.5,
        "initialText": "$ 142,50",
        "decimals": 2,
        "prefix": "$ ",
        "steps": steps,
    }


def main() -> None:
    payload = {
        "meta": {
            "defaultSoaCapacity": DEFAULT_SOA_CAPACITY,
            "defaultTradeRingCapacity": DEFAULT_TRADE_RING_CAPACITY,
            "soaDeltaStride": SOA_DELTA_STRIDE,
            "maxDeltaItemsPerFrame": MAX_DELTA_ITEMS_PER_FRAME,
            "deltaFrameBufferBytes": DELTA_FRAME_BUFFER_BYTES,
            "l2VisualPulseMs": L2_VISUAL_PULSE_MS,
            "tableVisualPulseMs": TABLE_VISUAL_PULSE_MS,
        },
        "soaCases": build_soa_cases(),
        "ringBufferCases": build_ring_buffer_cases(),
        "bitmaskCases": build_bitmask_cases(),
        "domRegistryCases": build_dom_registry_cases(),
    }

    out_path = Path(__file__).resolve().parents[1] / "fixtures" / "perf_phase2_reference.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
