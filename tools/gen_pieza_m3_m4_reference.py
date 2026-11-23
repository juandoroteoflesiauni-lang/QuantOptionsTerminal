"""Generate the M3/M4 reference from a ledger of accepted provider observations."""
import json
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SYMBOL = "O:SPY261120C00600000"


def quote(ms, bid, ask, bs, az, **fields):
    return dict(ev="Q", sym=SYMBOL, t=ms, bp=bid, ap=ask, bs=bs, **{"as": az}, **fields)


def trade(ms, price, size, **fields):
    return dict(ev="T", sym=SYMBOL, t=ms, p=price, s=size, **fields)


def ledger(cases):
    quotes, prints, steps = [], [], []
    for event, rejection in cases:
        if rejection is None:
            (quotes if event["ev"] == "Q" else prints).append(event)
        book = quotes[-1] if quotes else {}
        last = prints[-1] if prints else {}
        midpoint = (Decimal(str(book["bp"])) + Decimal(str(book["ap"]))) / 2 if book else None
        expected = dict(bid=book.get("bp"), ask=book.get("ap"), mid=float(midpoint) if book else None,
                        last=last.get("p"), size=last.get("s"))
        if book:
            expected.update(bidSize=book["bs"], askSize=book["as"], quoteTimestamp=book["t"] // 1000,
                            quoteTimestampMs=book["t"], quoteSeq=book.get("q"))
        if last:
            expected.update(lastSize=last["s"], tradeTimestamp=last["t"] // 1000, tradeTimestampMs=last["t"],
                            tradeSeq=last.get("q"), tradeVolume=sum(p["s"] for p in prints), tradeCount=len(prints))
        steps.append(dict(event=event, reason=rejection, expected=expected))
    return steps


q1 = quote(100000, 1, 1.2, 10, 20, bx=1, ax=2)
t1 = trade(105000, 1.15, 3, i="T-99")
q2 = quote(110000, 1.05, 1.25, 15, 25)
cases = [(q1, None), (t1, None), (quote(95000, .9, 1.1, 5, 5), "STALE_QUOTE"), (q2, None),
         (trade(102000, 1.08, 7), "STALE_TRADE"), (quote(115000, 1.4, 1.2, 8, 8), "CROSSED_BOOK")]
ties = [(q2 | {"q": seq}, reason) for seq, reason in
        [(10, None), (9, "STALE_QUOTE_SEQ"), (10, "DUPLICATE_QUOTE"), (11, None)]]
ties += [(q2, "UNSEQUENCED_TIE"), (t1, None), (t1 | {"t": 106000}, "DUPLICATE_TRADE"),
         (trade(108000, 1.16, 2, q=2), None), (trade(108000, 1.17, 2, q=2), "DUPLICATE_TRADE"),
         (trade(109000, 1.16, 2), None), (trade(109000, 1.16, 2), "DUPLICATE_TRADE")]
stamp = 1794580680987
start = int(datetime(2026, 11, 21, 18, tzinfo=timezone.utc).timestamp() * 1000)
dates = {}
for value in ["2026-11-20", "2026-02-30", "2024-02-29", "2025-02-29", ""]:
    try:
        dates[value] = date.fromisoformat(value).isoformat()
    except ValueError:
        dates[value] = None
reference = {
    "replay": ledger(cases), "ties": ledger(ties), "unsequenced": ledger([(q1, None), (q1, "DUPLICATE_QUOTE"), (q1 | {"bs": 0}, None)]),
    "wire": {"ms": stamp, "sec": stamp // 1000, "count": 100, "stride": 12, "bytes": 100 * 12 * 8},
    "session": [int(datetime(2026, 11, d, h, m, tzinfo=timezone.utc).timestamp() * 1000)
                for d, h, m in [(20, 23, 59), (21, 0, 1), (21, 5, 0)]],
    "dates": dates, "start": start,
    "breaker": {"failures": 3, "retry": [start + sum(30000 * 2**n for n in range(i + 1)) for i in range(2)],
                "rateLimit": start + 60000},
    "endpoints": {"partial": "PARTIAL_FAILURE", "stale": "STALE_CACHE", "reason": "ORATS_STRIKES_HTTP_503",
                  "empty": "EMPTY_VALID", "incomplete": "INCOMPLETE_STRIKES_ERROR"},
    "strikes": [dict(strike=500 + i * 5, expirDate="2026-12-18", dte=28) for i in range(12)],
    "pulse": sorted(["id", "state", "sessionMode", "latencyMs", "lastTickAgeMs", "messagesPerMinute"]),
}
(ROOT / "fixtures/pieza_m3_m4_reference.json").write_text(json.dumps(reference, indent=2, sort_keys=True) + "\n", encoding="utf-8")
