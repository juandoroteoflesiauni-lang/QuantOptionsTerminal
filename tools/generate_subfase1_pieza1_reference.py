"""Independent integer oracle. Uses the already verified Python calendar fixture,
not TypeScript, to enumerate exchange sessions; never fabricates market bars.
"""
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
ET = ZoneInfo('America/New_York')
calendar = json.loads((ROOT/'fixtures/pieza0b_massive_rest_reference.json').read_text())['calendar']
sessions = [c['session'] for c in calendar if c['session'] is not None]


def budget(tf, mode, mtd=22):
    density = 390 if mode == 'RTH' else 960
    if not isinstance(mtd, int) or mtd < 0:
        mtd = 22
    if tf == '1m': return density*(5 if mode == 'RTH' else 3)
    if tf == '5m': return min(23, max(22, mtd))*density//5
    if tf == '15m': return 40*density//15
    return {'1h': 1000, '1D': 1250}.get(tf)


def instant(text):
    return int(datetime.fromisoformat(text).replace(tzinfo=ET).timestamp())


def plan(tf, now, rth):
    local = datetime.fromtimestamp(now, ET)
    month = local.strftime('%Y-%m')
    mtd = sum(s['dateKey'].startswith(month) and s['open'] <= now for s in sessions)
    minutes = {'1m': 1, '5m': 5, '15m': 15, '1h': 60}[tf]
    k = {'1m': 5 if rth else 3, '5m': min(23, max(22, mtd)), '15m': 40, '1h': 0}[tf]
    past = []
    for s in reversed(sessions):
        start, end = (s['open'], s['close']) if rth else (s['extendedOpen'], s['extendedClose'])
        # Count completed, session-aligned buckets, including early final hour.
        count = sum(min(t+60*minutes, end) <= now for t in range(start, end, 60*minutes))
        if count: past.append((start, count))
    visible = sum(c for _, c in past[:k]) if k else 1000
    required = visible + 1000
    total = 0
    for start, count in past:
        total += count
        if total >= required: break
    nominal = budget(tf, 'RTH' if rth else 'EXTENDED', mtd)
    # Independent exact rational ceiling of the sealed FMP floor.
    density = (390 if rth else 960)//minutes if tf != '1h' or not rth else 7
    num, den = (nominal+1000)*103*1461, 100*1000*density
    days = (num+den-1)//den + 10
    native_from = now-days*86400
    if tf == '1m':
        anchor = next((s['open'] if rth else s['extendedOpen']) for s in sessions if s['dateKey'].startswith(month))
        native_from = min(native_from, anchor)
    result = dict(tf=tf, now=now, rth=rth, mtd=mtd, nominal=nominal,
                  historyFrom=start, requiredBars=required,
                  fmpFrom=min(start, native_from), fmpRequired=nominal+1000)
    if k: result.update(visibleFrom=past[k-1][0], expectedVisibleBars=visible)
    return result


matrix = [dict(tf=tf, mode=mode, mtd=mtd, expected=budget(tf, mode, mtd))
          for tf in ['1m', '5m', '15m', '1h', '1D', '4h']
          for mode in ['EXTENDED', 'RTH'] for mtd in [None, -1, 0, 21, 22, 23, 24, 'NaN', 1.5]]
dates = ['2024-03-11T17:00:00', '2025-03-10T17:00:00', '2025-11-03T21:00:00',
         '2025-11-28T18:00:00', '2025-12-01T21:00:00', '2026-07-31T21:00:00',
         '2026-11-20T21:00:00', '2026-11-02T00:15:00', '2026-01-02T21:00:00']
plans = [plan(tf, instant(d), rth) for d in dates for tf in ['1m','5m','15m','1h'] for rth in [False, True]]


def zoom(n, options):
    target = sorted([options.get('minBars',120), options.get('defaultBars',150), options.get('maxBars',180)])[1]
    return None if n == 0 else dict(from_=max(0,n-target), to=n-1+options.get('rightOffsetBars',3))


zooms = []
for n in [0,1,80,119,120,149,150,180,500,2880]:
    for opts in [{}, {'defaultBars':80}, {'defaultBars':300}, {'rightOffsetBars':0}]:
        out = zoom(n, opts)
        if out is not None: out['from'] = out.pop('from_')
        zooms.append(dict(count=n, options=opts, expected=out))


def windows(start, end, days):
    # Integer grid of page ends, newest first, with a one-day overlap.
    step = (days-1)*86400
    return [dict(fromUtcSec=max(start, t-days*86400), toUtcSec=t)
            for t in range(end, start-86400, -step)
            if t > start+86400 or t == end][:((max(0,end-start-days*86400)+step-1)//step)+1]


pages = []
for tf, old, new in [('5m',7,14),('15m',14,28)]:
    for rth in [False,True]:
        c = plan(tf, instant('2026-11-20T21:00:00'), rth)
        pages.append(dict(tf=tf,rth=rth,fromUtcSec=c['fmpFrom'],toUtcSec=c['now'],
                          before=windows(c['fmpFrom'],c['now'],old), after=windows(c['fmpFrom'],c['now'],new)))
out = dict(matrix=matrix, plans=plans, zooms=zooms, pagination=pages)
path = ROOT/'fixtures/subfase1_pieza1_reference.json'
path.write_text(json.dumps(out, separators=(',',':'))+'\n')
print(f'{path.name}: {len(matrix)} budgets, {len(plans)} plans, {len(zooms)} zooms, {len(pages)} pagination scenarios')
