"""Generate the independent reference for the Tradier and GGAL replays."""
from datetime import datetime, timezone
from decimal import Decimal, getcontext
import json
from pathlib import Path

getcontext().prec = 50
ROOT = Path(__file__).resolve().parents[1]


def utc(iso):
    return int(datetime.fromisoformat(iso).timestamp())


def native_ms(iso):
    instant = datetime.fromisoformat(iso)
    return int((instant - datetime(1970, 1, 1, tzinfo=timezone.utc)).total_seconds() * 1000)


def ohlcv(trades, start):
    ordered = sorted(trades, key=lambda trade: (trade['timeSec'], trade.get('sequence', 0)))
    prices = [trade['price'] for trade in ordered]
    return dict(timeSec=start, open=prices[0], high=max(prices), low=min(prices),
                close=prices[-1], volume=sum(trade['size'] for trade in ordered))


def ccl_case(now, byma, adr, regime, state, reason=None, eod=False):
    matching = state in ('CONTEMPORANEOUS', 'EOD_CLOSE_REF')
    return dict(
        input=dict(byma=dict(price=6000, timeSec=byma),
                   adr=dict(price=50 if adr is not None else 0, timeSec=adr),
                   evaluationNowSec=now, marketRegime=regime, isEodMode=eod),
        cclQuality=state, rejectReason=reason, livePublishable=state == 'CONTEMPORANEOUS',
        legSkewSec=abs(byma - adr) if adr is not None else None,
        valuationTimestamp=min(byma, adr) if matching else None,
        value=str(Decimal(6000) * Decimal(10) / Decimal(50)) if adr is not None else None,
    )


def build_reference():
    now = utc('2026-11-17T15:00:00Z')
    other_day = utc('2026-11-16T19:50:00Z')
    solo = utc('2026-11-17T20:30:00Z')
    sat = utc('2026-11-21T15:00:00Z')
    timestamps = [
        (1763049600, 'GENERIC', 1763049600 * 1000, 'EPOCH_SEC'),
        ('1763049600', 'GENERIC', 1763049600 * 1000, 'EPOCH_SEC'),
        (1763049600789, 'GENERIC', 1763049600789, 'EPOCH_MS'),
        ('1763049600789', 'GENERIC', 1763049600789, 'EPOCH_MS'),
        ('2026-11-13T16:00:00.250Z', 'GENERIC', native_ms('2026-11-13T16:00:00.250Z'), 'ISO_8601_TZ'),
        ('2026-11-13T11:00:00-05:00', 'GENERIC', native_ms('2026-11-13T11:00:00-05:00'), 'ISO_8601_TZ'),
        ('2026-11-13 16:00:00', 'GREEKS_UPDATED_AT', native_ms('2026-11-13T16:00:00Z'), 'TRADIER_GREEKS_UTC_SPACE'),
    ]
    rejections = [
        (None, 'MISSING'), ('', 'MISSING'), (False, 'INVALID_TYPE'),
        (0, 'OUT_OF_RANGE'), (-100, 'OUT_OF_RANGE'), (12345, 'OUT_OF_RANGE'),
        (10_000_000_000, 'AMBIGUOUS_UNIT'), (100_000_000_000, 'AMBIGUOUS_UNIT'),
        (1_763_049_600_000_000, 'OUT_OF_RANGE'), ('1763049600000000000', 'OUT_OF_RANGE'),
        (1763049600.5, 'NON_INTEGER_EPOCH'), ('2026-11-13T16:00:00', 'MISSING_TIMEZONE'),
        ('2026-11-13 16:00:00', 'MISSING_TIMEZONE'), ('2026-02-30T12:00:00Z', 'INVALID_CALENDAR_DATE'),
    ]
    massive = dict(bid=1, ask=2, midpoint='1.5', bidSize=15, askSize=20, gamma='0.05', updatedAt=now-5)
    def iso(seconds):
        return datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat()
    greeks = dict(delta=.45, gamma=.06, theta=-.025, vega=.11, updated_at=iso(now-120))
    valid = dict(bid=1.1, ask=1.3, bid_size=8, ask_size=12,
                 bid_date=(now-2)*1000, ask_date=(now-1)*1000, trade_date=(now-300)*1000, greeks=greeks)
    tradier = dict(bid=valid['bid'], ask=valid['ask'], bidSize=8, askSize=12,
                   updatedAt=now-2, midpoint=str((Decimal('1.1') + Decimal('1.3')) / 2), gamma='0.06')
    overlay = [
        dict(name='critical partial', raw=dict(bid=4, ask=0, bid_date=0, ask_date=None, trade_date=None,
                                               greeks=dict(greeks, gamma=.99, updated_at=iso(now))),
             expected=massive, count='rejectedRowStructural', accepted=False),
        dict(name='crossed', raw=dict(valid, bid=2.5, ask=2.1), expected=massive,
             count='rejectedCrossedBook', accepted=False),
        dict(name='valid independent clocks', raw=valid, expected=tradier,
             count='overlaidBidAsk', accepted=True),
        dict(name='trade and Greeks cannot timestamp the book',
             raw=dict(valid, bid_date=None, ask_date=None, trade_date=now-1),
             expected=massive, count='rejectedInvalidTimestamp', accepted=False),
        dict(name='fresh BBO with stale Greeks', raw=dict(valid, greeks=dict(greeks, updated_at=iso(now-700))),
             expected=dict(tradier, gamma=massive['gamma']), count='overlaidBidAsk', accepted=True),
        dict(name='independent Greeks', raw=dict(valid, bid=0, ask=0),
             expected=dict(massive, gamma=tradier['gamma']), count='overlaidGreeksIndependent',
             greeksMissing=True, accepted=False),
        dict(name='stale BBO', raw=dict(valid, bid_date=now-25, ask_date=now-25), expected=massive,
             count='skippedStaleQuotes', accepted=False),
        dict(name='incoherent side times', raw=dict(valid, bid_date=now-15),
             expected=massive, count='rejectedBidAskSkew', accepted=False),
        dict(name='future BBO', raw=dict(valid, bid_date=now+10),
             expected=massive, count='rejectedFutureSkew', accepted=False),
    ]
    def tick(offset, price, size, **attrs):
        return dict(timeSec=now+offset, price=price, size=size, **attrs)
    active = tick(0, 50, 3)
    late = tick(-60, 40, 8)
    ordered_cases = [
        [tick(40, 52, 2), tick(10, 48, 5), tick(25, 55, 3)],
        [tick(25, 53, 2, sequence=20), tick(25, 51, 1, sequence=10)],
    ]
    cumulative = [10000, 10250, 10250, 10100, 10600]
    night = utc('2026-11-17T20:58:00Z')
    open_next = utc('2026-11-18T14:30:00Z')
    return dict(
        now=now,
        validTimestamps=[dict(value=v, hint=h, nativeMs=m, utcSec=m//1000, unit=u)
                         for v, h, m, u in timestamps],
        rejectedTimestamps=[dict(value=v, reason=r) for v, r in rejections],
        massive=massive, overlays=overlay,
        ccl=[
            ccl_case(now, now, now-15, 'OVERLAP', 'CONTEMPORANEOUS'),
            ccl_case(now, other_day, now, 'OVERLAP', 'SKEW_DEGRADED', 'CROSS_SESSION_DAY_MISMATCH'),
            ccl_case(solo, solo, solo, 'NASDAQ_SOLO_17_18', 'SKEW_DEGRADED', 'NON_OVERLAP_REGIME'),
            ccl_case(now, now-300, now-305, 'OVERLAP', 'STALE_LEG', 'BYMA_LEG_STALE'),
            ccl_case(sat, now, now-15, 'CLOSED', 'EOD_CLOSE_REF', eod=True),
            ccl_case(sat, other_day, now, 'CLOSED', 'SKEW_DEGRADED', 'CROSS_SESSION_DAY_MISMATCH', True),
            ccl_case(now, now, None, 'OVERLAP', 'MISSING_LEG', 'MISSING_ADR_LEG'),
        ],
        late=dict(ticks=[active, late, tick(-55, 42, 2)], active=ohlcv([active], now),
                  revision=ohlcv([late], now-60), revision2=ohlcv([late, tick(-55, 42, 2)], now-60)),
        intrabucket=[dict(ticks=t, expected=ohlcv(t, now)) for t in ordered_cases],
        duplicates=dict(ticks=[tick(0, 50, 2, tradeId='GGAL1'), tick(1, 51, 3, sequence=2), tick(2, 52, 4)],
                        expectedVolume=2+3+4),
        cumulative=dict(ticks=[tick(i, 50, value, volumeMode='CUMULATIVE_SESSION')
                               for i, value in enumerate(cumulative)],
                        expectedVolume=max(cumulative)-cumulative[0]),
        session=dict(ticks=[dict(timeSec=t, price=p, size=v) for t, p, v in [
            (night, 50, 3), (utc('2026-11-17T23:59:00Z'), 52, 1),
            (utc('2026-11-18T00:01:00Z'), 53, 1), (open_next, 60, 5),
            (utc('2026-11-17T23:59:30Z'), 40, 5),
        ]], expectedVwaps=['50', '50', '50', '60']),
        outOfWindow=dict(ticks=[active, tick(-1200, 40, 8)], expectedLateCount=1),
    )


if __name__ == '__main__':
    target = ROOT / 'fixtures' / 'pieza_m1_m2_reference.json'
    target.write_text(json.dumps(build_reference(), indent=2, sort_keys=True) + '\n', encoding='utf-8')
