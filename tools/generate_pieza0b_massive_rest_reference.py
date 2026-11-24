"""Independent 0B oracle: Python date/zoneinfo enumeration and Decimal accounting.

No TS imports or execution. Calendar rules checked against the published NYSE
2020–2028 tables; New Year Saturday is NOT observed on the previous Friday.
Numerics: mixed error <= 1e-9 * max(1, abs(reference)); discrete fields exact.
"""
import calendar
import json
from datetime import date, datetime, timedelta
from decimal import Decimal, getcontext
from pathlib import Path
from zoneinfo import ZoneInfo

getcontext().prec = 50
ET = ZoneInfo('America/New_York')
ROOT = Path(__file__).resolve().parents[1]


def nth(y, m, weekday, n):
    return [date(y, m, d) for d in range(1, calendar.monthrange(y, m)[1] + 1)
            if date(y, m, d).weekday() == weekday][n - 1 if n > 0 else n]


def easter(y):
    # Butcher's Gregorian computus, independent of the TS date table.
    a, b, c = y % 19, y // 100, y % 100
    h = (19*a + b - b//4 - (b - (b+8)//25 + 1)//3 + 15) % 30
    ell = (32 + 2*(b % 4) + 2*(c//4) - h - c % 4) % 7
    n = h + ell - 7*((a + 11*h + 22*ell)//451) + 114
    return date(y, n//31, n % 31 + 1)


def observed(d):
    return d + timedelta(days={5: -1, 6: 1}.get(d.weekday(), 0))


def utc(d, minutes):
    return int(datetime(d.year, d.month, d.day, minutes//60, minutes % 60, tzinfo=ET).timestamp())


def schedule(d):
    y = d.year
    new_year = date(y, 1, 1)
    holidays = {nth(y, 1, 0, 3), nth(y, 2, 0, 3), easter(y)-timedelta(days=2),
                nth(y, 5, 0, -1), observed(date(y, 7, 4)),
                nth(y, 9, 0, 1), nth(y, 11, 3, 4), observed(date(y, 12, 25))}
    if new_year.weekday() != 5:
        holidays.add(observed(new_year))
    if y >= 2022:
        holidays.add(observed(date(y, 6, 19)))
    holidays.add(date(2025, 1, 9))
    if d.weekday() > 4 or d in holidays:
        return None
    early = {nth(y, 11, 3, 4)+timedelta(days=1)}
    for m, day in [(7, 3), (12, 24)]:
        candidate = date(y, m, day)
        if candidate.weekday() < 5 and candidate not in holidays:
            early.add(candidate)
    return {'dateKey': str(d), 'open': utc(d, 570), 'close': utc(d, 780 if d in early else 960),
            'extendedOpen': utc(d, 240), 'extendedClose': utc(d, 1020 if d in early else 1200)}


CAL = []
d = date(2020, 1, 1)
while d < date(2029, 1, 1):
    CAL.append({'time': utc(d, 720), 'session': schedule(d)})
    d += timedelta(days=1)


def sample_bar(time, minutes=1):
    # Deterministic test-only market rows, parameterized by minute of UTC day.
    prices = [Decimal(100) + Decimal((time//60 + i) % 32)/8 for i in range(minutes)]
    volumes = [1 + (time//60 + i) % 3 for i in range(minutes)]
    volume = sum(volumes)
    return {'time': time, 'open': float(prices[0]), 'high': float(max(prices)+1),
            'low': float(min(prices)-1), 'close': float(prices[-1]+Decimal('0.5')),
            'volume': volume, 'vw': float(sum(p*v for p, v in zip(prices, volumes))/volume)}


def moments(bars, provider='MASSIVE_REST'):
    result = {'PV': Decimal(0), 'V': Decimal(0), 'P2V': Decimal(0)}
    for b in bars:
        value = b.get('vw')
        valid = provider == 'MASSIVE_REST' and isinstance(value, (int, float)) and value > 0
        p = Decimal(str(value)) if valid else sum(Decimal(str(b[k])) for k in ('high', 'low', 'close'))/3
        v = Decimal(b['volume'])
        result['PV'] += p*v
        result['V'] += v
        result['P2V'] += p*p*v
    return {k: float(v) for k, v in result.items()}


def roll(bars, minutes, rth, now):
    buckets = {}
    for b in bars:
        local = datetime.fromtimestamp(b['time'], ET).date()
        s = schedule(local)
        if not s:
            continue
        start, close = (s['open'], s['close']) if rth else (s['extendedOpen'], s['extendedClose'])
        if not start <= b['time'] < close:
            continue
        index = next(i for i, opening in enumerate(range(start, close, minutes*60))
                     if opening <= b['time'] < min(opening+minutes*60, close))
        opening = start + index*minutes*60
        end = min(opening+minutes*60, close)
        if end <= now:
            buckets.setdefault((opening, end), []).append(b)
    out = []
    for (time, end), group in sorted(buckets.items()):
        real = sum(isinstance(b.get('vw'), (float, int)) and b['vw'] > 0 for b in group)
        out.append({'time': time, 'endExclusive': end, 'open': group[0]['open'],
                    'high': max(b['high'] for b in group), 'low': min(b['low'] for b in group),
                    'close': group[-1]['close'], 'volume': sum(b['volume'] for b in group),
                    'moments': moments(group), 'realVwBars': real, 'proxyBars': len(group)-real,
                    'priceSource': 'REAL_VW' if real == len(group) else 'HLC3_PROXY' if not real else 'MIXED_VW_HLC3'})
    return out


def massive_plan(tf, now, rth, visible=None):
    minutes = {'1m': 1, '5m': 5, '15m': 15, '1h': 60}[tf]
    local = datetime.fromtimestamp(now, ET).date()
    sessions = [x['session'] for x in CAL if x['session'] and x['session']['open'] <= now]
    month = [s for s in sessions if s['dateKey'][:7] == str(local)[:7]]
    anchor = (month[0]['open' if rth else 'extendedOpen'] if month else utc(local.replace(day=1), 0))
    count = {'1m': 5 if rth else 3, '5m': min(23, max(22, len(month))), '15m': 40, '1h': 0}[tf]
    capacities = []
    for s in sessions:
        start, close = (s['open'], s['close']) if rth else (s['extendedOpen'], s['extendedClose'])
        bars = sum(min(t+minutes*60, close) <= now for t in range(start, close, minutes*60))
        if bars:
            capacities.append((start, bars))
    policy_visible = 1000 if tf == '1h' else sum(n for _, n in capacities[-count:])
    rendering = policy_visible if visible is None else visible
    required = rendering+1000 if tf == '1h' else max(policy_visible, rendering)+1000
    total = 0
    for start, n in reversed(capacities):
        total += n
        if total >= required:
            history_from = start
            break
    canonical_from = min(history_from, anchor) if tf in ('1m', '5m') else anchor
    segments = []
    if history_from < canonical_from:
        segments.append({'from': history_from, 'to': canonical_from, 'sourceMinutes': 15 if tf == '15m' else 30})
    segments.append({'from': canonical_from, 'to': now//60*60, 'sourceMinutes': 1})
    return {'historicalProvider': 'MASSIVE_REST', 'historyFrom': history_from, 'monthAnchor': anchor,
            'visibleBars': rendering, 'warmupBars': 1000, 'requiredBars': required, 'segments': segments}


def fmp_plan(tf, now, rth, visible, additional=None):
    density = {'1m': 390 if rth else 960, '5m': 78 if rth else 192,
               '15m': 26 if rth else 64, '1h': 7 if rth else 16}[tf]
    days = int((Decimal(visible+1000)*Decimal('1.03')/density*Decimal('365.25')/250).to_integral_value(rounding='ROUND_CEILING'))+10
    start = now-days*86400
    if additional is not None:
        start = min(start, additional)
    anchor = massive_plan(tf, now, rth, visible)['monthAnchor']
    if tf == '1m':
        start = min(start, anchor)
    return {'historicalProvider': 'FMP', 'historyFrom': start, 'monthAnchor': anchor, 'visibleBars': visible,
            'warmupBars': 1000, 'requiredBars': visible+1000,
            'segments': [{'from': start, 'to': now, 'sourceMinutes': {'1m': 1, '5m': 5, '15m': 15, '1h': 60}[tf]}]}


now = utc(date(2026, 11, 20), 720)
plans = []
for tf in ('1m', '5m', '15m', '1h'):
    for rth in (False, True):
        for visible in (None, 1000):
            plans.append({'tf': tf, 'now': now, 'rth': rth, 'visible': visible,
                          'massive': massive_plan(tf, now, rth, visible),
                          'fmp': fmp_plan(tf, now, rth, 1000 if visible is None else visible)})
plans.append({'tf': '5m', 'now': utc(date(2025, 10, 31), 1200), 'rth': False, 'visible': None,
              'massive': massive_plan('5m', utc(date(2025, 10, 31), 1200), False), 'fmp': None})
for year, month, day, visible in [(2024, 3, 11, 60), (2025, 3, 10, 60), (2026, 11, 20, 60)]:
    asof = utc(date(year, month, day), 885)
    for rth in (False, True):
        plans.append({'tf': '1h', 'now': asof, 'rth': rth, 'visible': visible,
                      'massive': massive_plan('1h', asof, rth, visible),
                      'fmp': fmp_plan('1h', asof, rth, visible)})
vw_cases = []
for value in (100.125, 130.123456789123, 70.987654321987, 0, -2, None, 'ABSENT', 'NaN', 'Infinity', '-Infinity'):
    b = {'time': utc(date(2026, 11, 20), 570), 'open': 100, 'high': 102, 'low': 98, 'close': 101, 'volume': 13}
    if value != 'ABSENT':
        b['vw'] = value
    valid = isinstance(value, (float, int)) and value > 0
    vw_cases.append({'bar': b, 'price': float(Decimal(str(value)) if valid else Decimal(301)/3),
                     'source': 'REAL_VW' if valid else 'HLC3_PROXY', 'moments': moments([b])})

rollups = []
for d in (date(2026, 3, 6), date(2026, 3, 9), date(2026, 11, 27)):
    s = schedule(d)
    bars = [sample_bar(t) for t in range(s['extendedOpen'], s['extendedClose'], 60)]
    for i in range(0, len(bars), 7):
        bars[i].pop('vw')
    for rth in (False, True):
        for minutes in (1, 5, 15, 60):
            rollups.append({'date': str(d), 'minutes': minutes, 'rth': rth,
                            'now': s['extendedClose'], 'bars': bars if minutes == 1 and not rth else None,
                            'expected': roll(bars, minutes, rth, s['extendedClose'])})

services = []
for case in plans:
    if case['visible'] != 1000:
        continue
    source = []
    pages = 0
    downloaded = 0
    intermediate30 = 0
    for segment in case['massive']['segments']:
        minute = segment['sourceMinutes']
        rows = []
        for item in CAL:
            s = item['session']
            if s is None or s['extendedClose'] <= segment['from'] or s['extendedOpen'] >= segment['to']:
                continue
            for t in range(s['extendedOpen'], s['extendedClose'], minute*60):
                if segment['from'] <= t and t+minute*60 <= segment['to']:
                    rows.append(sample_bar(t, minute))
        source.extend(rows)
        downloaded += len(rows)
        if minute == 30:
            intermediate30 += len(rows)
        per_page = 50000//minute
        pages += max(1, (len(rows)+per_page-1)//per_page)
    final = roll(source, {'1m': 1, '5m': 5, '15m': 15, '1h': 60}[case['tf']], case['rth'], case['now'])
    services.append({'tf': case['tf'], 'rth': case['rth'], 'now': case['now'], 'pages': pages,
                     'downloadedBars': downloaded, 'finalBars': len(final), 'volume': sum(b['volume'] for b in final),
                     'intermediate30mBars': intermediate30, 'counterfactual5mBars': intermediate30*6})

fixture = {'meta': {'generator': 'tools/generate_pieza0b_massive_rest_reference.py',
                    'tolerance': 'abs(error) <= 1e-9 * max(1, abs(reference)); discrete exact',
                    'sources': ['https://www.nyse.com/trade/hours-calendars',
                                'https://ir.theice.com/press/news-details/2019/NYSE-Group-Announces-2020-2021-and-2022-Holiday-and-Early-Closings-Calendar/default.aspx',
                                'https://ir.theice.com/press/news-details/2021/NYSE-Group-Announces-2022-2023-and-2024-Holiday-and-Early-Closings-Calendar/default.aspx',
                                'https://ir.theice.com/press/news-details/2024/NYSE-Group-Announces-2025-2026-and-2027-Holiday-and-Early-Closings-Calendar/default.aspx',
                                'https://ir.theice.com/press/news-details/2024/The-New-York-Stock-Exchange-Will-Close-Markets-on-January-9-to-Honor-the-Passing-of-Former-President-Jimmy-Carter-on-National-Day-of-Mourning/default.aspx']},
           'calendar': CAL, 'plans': plans, 'vwCases': vw_cases, 'rollups': rollups, 'services': services}
output = ROOT/'fixtures/pieza0b_massive_rest_reference.json'
output.write_text(json.dumps(fixture, separators=(',', ':'), allow_nan=False)+'\n', encoding='utf-8')
print(f'{output.name}: {len(CAL)} calendar dates, {len(plans)} plans, {len(vw_cases)} VW cases, {len(rollups)} rollups')
