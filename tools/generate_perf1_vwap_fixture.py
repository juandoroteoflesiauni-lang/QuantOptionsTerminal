"""Independent Python reference generator for Perf-1 Session VWAP O(1) checkpoint tests.

Generates `fixtures/perf1_session_vwap_checkpoint.json` using stdlib `zoneinfo`
directly without inspecting or copying the TypeScript implementation.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo


def session_date_key(time_sec: int, market_tz: str) -> str:
    dt = datetime.fromtimestamp(time_sec, tz=timezone.utc).astimezone(ZoneInfo(market_tz))
    return dt.strftime("%Y-%m-%d")


def compute_session_vwap_step(closed_bars: list[dict], forming_bar: dict, market_tz: str) -> float | None:
    if not isinstance(forming_bar["timeSec"], int) or forming_bar["timeSec"] < 0:
        return None
    if forming_bar["close"] <= 0 or forming_bar["volume"] <= 0:
        return None
    target_key = session_date_key(forming_bar["timeSec"], market_tz)
    cum_pv = 0.0
    cum_vol = 0.0
    for bar in closed_bars:
        if bar["timeSec"] >= forming_bar["timeSec"]:
            continue
        if session_date_key(bar["timeSec"], market_tz) != target_key:
            continue
        if bar["volume"] <= 0:
            continue
        tp = (bar["high"] + bar["low"] + bar["close"]) / 3.0
        cum_pv += tp * bar["volume"]
        cum_vol += bar["volume"]
    forming_tp = (forming_bar["high"] + forming_bar["low"] + forming_bar["close"]) / 3.0
    total_vol = cum_vol + forming_bar["volume"]
    if total_vol <= 0:
        return None
    return (cum_pv + forming_tp * forming_bar["volume"]) / total_vol


def main() -> None:
    cases = []

    # Scenario 1: US DST / EDT multi-day sequence + bar rollover + zero-volume closed bar + overnight rollover
    us_tz = "America/New_York"
    # Day 1: 2025-05-05 (EDT = UTC-4), 19:50Z (15:50 ET) and 19:55Z (15:55 ET)
    # Day 2: 2025-05-06 (EDT = UTC-4), 13:30Z (09:30 ET), 13:35Z (09:35 ET), 13:40Z (09:40 ET)
    d1_t1 = int(datetime(2025, 5, 5, 19, 50, tzinfo=timezone.utc).timestamp())
    d1_t2 = int(datetime(2025, 5, 5, 19, 55, tzinfo=timezone.utc).timestamp())
    d2_t1 = int(datetime(2025, 5, 6, 13, 30, tzinfo=timezone.utc).timestamp())
    d2_t2 = int(datetime(2025, 5, 6, 13, 35, tzinfo=timezone.utc).timestamp())
    d2_t3 = int(datetime(2025, 5, 6, 13, 40, tzinfo=timezone.utc).timestamp())

    us_sequence = [
        {"timeSec": d1_t1, "open": 100.0, "high": 102.0, "low": 99.5, "close": 101.0, "volume": 1200.0},
        {"timeSec": d1_t2, "open": 101.0, "high": 103.0, "low": 100.0, "close": 102.5, "volume": 0.0},
        {"timeSec": d2_t1, "open": 104.0, "high": 105.5, "low": 103.5, "close": 105.0, "volume": 800.0},
        {"timeSec": d2_t2, "open": 105.0, "high": 106.0, "low": 104.0, "close": 104.5, "volume": 1500.0},
    ]
    us_live_steps = [
        # Still on Day 2 forming bar d2_t2 after d2_t1 closed
        {
            "closedBarsCount": 3,
            "formingBar": {"timeSec": d2_t2, "open": 105.0, "high": 105.4, "low": 104.8, "close": 105.2, "volume": 400.0},
        },
        # Intraday tick on same forming bar
        {
            "closedBarsCount": 3,
            "formingBar": {"timeSec": d2_t2, "open": 105.0, "high": 106.0, "low": 104.0, "close": 104.5, "volume": 1500.0},
        },
        # Bar d2_t2 closed -> advance checkpoint -> new bar d2_t3
        {
            "closedBarsCount": 4,
            "formingBar": {"timeSec": d2_t3, "open": 104.5, "high": 105.1, "low": 104.2, "close": 104.9, "volume": 650.0},
        },
    ]
    cases.append(
        {
            "name": "us_dst_day_rollover_and_zero_vol",
            "marketTz": us_tz,
            "closedBars": us_sequence,
            "steps": [
                {
                    "closedBarsCount": s["closedBarsCount"],
                    "formingBar": s["formingBar"],
                    "expectedVwap": compute_session_vwap_step(
                        us_sequence[: s["closedBarsCount"]],
                        s["formingBar"],
                        us_tz,
                    ),
                }
                for s in us_live_steps
            ],
        }
    )

    # Scenario 2: BYMA ART crossing UTC midnight (21:00 ART = 00:00Z next UTC day, still same ART day!)
    ar_tz = "America/Argentina/Buenos_Aires"
    a1 = int(datetime(2025, 5, 5, 23, 55, tzinfo=timezone.utc).timestamp())  # 20:55 ART on May 5
    a2 = int(datetime(2025, 5, 6, 0, 5, tzinfo=timezone.utc).timestamp())   # 21:05 ART STILL May 5 in BA!
    a3 = int(datetime(2025, 5, 6, 14, 0, tzinfo=timezone.utc).timestamp())  # 11:00 ART May 6 (new BA session)
    ar_seq = [
        {"timeSec": a1, "open": 7000.0, "high": 7050.0, "low": 6980.0, "close": 7020.0, "volume": 300.0},
        {"timeSec": a2, "open": 7020.0, "high": 7060.0, "low": 7010.0, "close": 7040.0, "volume": 200.0},
    ]
    ar_steps = [
        {"closedBarsCount": 1, "formingBar": ar_seq[1]},
        {"closedBarsCount": 2, "formingBar": {"timeSec": a3, "open": 7100.0, "high": 7120.0, "low": 7090.0, "close": 7110.0, "volume": 500.0}},
    ]
    cases.append(
        {
            "name": "byma_utc_midnight_vs_art_session",
            "marketTz": ar_tz,
            "closedBars": ar_seq,
            "steps": [
                {
                    "closedBarsCount": s["closedBarsCount"],
                    "formingBar": s["formingBar"],
                    "expectedVwap": compute_session_vwap_step(
                        ar_seq[: s["closedBarsCount"]],
                        s["formingBar"],
                        ar_tz,
                    ),
                }
                for s in ar_steps
            ],
        }
    )

    out_path = Path(__file__).resolve().parent.parent / "fixtures" / "perf1_session_vwap_checkpoint.json"
    out_path.write_text(json.dumps({"cases": cases}, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
