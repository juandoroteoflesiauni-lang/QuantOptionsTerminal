import json
from pathlib import Path


def main():
    subscriptions = {
        "spy": {"usSnapshot:SPY"},
        "qqq": {"usSnapshot:QQQ"},
        "macro": {"macro"},
        "status": {"status"},
        "ggal": {"options:AR:GGAL"},
        "spyOptions": {"options:US:SPY"},
        "spyLoading": {"optionLoading:US:SPY"},
        "combined": {"options:US:SPY", "usSnapshot:SPY"},
    }
    publications = {
        "qqq": [{"usSnapshot:QQQ"}],
        "health": [{"status"}],
        "healthUnchanged": [],
        "spyChain": [{"usSnapshot:SPY", "options:US:SPY"}],
        "spyExpiry": [
            {"optionLoading:US:SPY"},
            {"optionLoading:US:SPY", "options:US:SPY", "usSnapshot:SPY"},
        ],
    }
    counts = {
        name: {
            listener: sum(bool(writes & reads) for writes in transactions)
            for listener, reads in subscriptions.items()
        }
        for name, transactions in publications.items()
    }
    outcomes = [
        {
            "canceled": sorted(canceled),
            "fetchAborted": canceled == {1, 2},
            "received": sorted({1, 2} - canceled),
        }
        for canceled in ({1}, {1, 2})
    ]
    fixture = Path(__file__).resolve().parents[1] / "fixtures/perf2_state_slices_reference.json"
    fixture.write_text(json.dumps({"notifications": counts, "waiters": outcomes}, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
