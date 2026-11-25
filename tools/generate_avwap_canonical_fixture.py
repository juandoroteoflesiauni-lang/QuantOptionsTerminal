"""Independent Decimal(50) oracle: exact weighted sums, with separate two-pass
variance audits. No TypeScript execution/imports. Reuses the verified exchange
calendar as data, not the production accumulation/rollup algorithm.
"""
import json
import random
from bisect import bisect_right
from datetime import datetime
from decimal import Decimal, getcontext
from pathlib import Path
from zoneinfo import ZoneInfo

getcontext().prec = 50
ROOT = Path(__file__).resolve().parents[1]
ET = ZoneInfo('America/New_York')
calendar = json.loads((ROOT/'fixtures/pieza0b_massive_rest_reference.json').read_text())['calendar']
sessions = [c['session'] for c in calendar if c['session'] is not None]


def instant(text):
    return int(datetime.fromisoformat(text).replace(tzinfo=ET).timestamp())


def price(b):
    vw = b.get('vw')
    return Decimal(str(vw)) if vw is not None and vw > 0 else sum(Decimal(str(b[k])) for k in ['high','low','close'])/3


def output(W, P, P2):
    if W == 0: return [None]*5
    mean = P/W
    var = max(Decimal(0), P2/W-mean*mean)
    sd = var.sqrt()
    return [float(v) for v in [mean,mean+sd,mean-sd,mean+2*sd,mean-2*sd]]


def scenario(name, date_end, base, tiny=False, zero=False, proxy_only=False):
    now = instant(date_end)
    month = datetime.fromtimestamp(now,ET).strftime('%Y-%m')
    selected = [s for s in sessions if s['dateKey'].startswith(month) and s['extendedOpen'] < now]
    rows = []
    base = Decimal(base)
    quantum = Decimal('0.000001') if tiny else Decimal('0.125')
    for s in selected:
        for time in range(s['extendedOpen'], min(now,s['extendedClose']),60):
            i = len(rows)
            mid = base + Decimal(i % 17-8)*quantum
            v = 0 if zero or i % 37 == 0 else (100000 if i % 137 == 0 else 1+i % 31)
            vw = mid + Decimal(i % 3-1)*quantum
            if not tiny and i % 83 == 0: vw = mid + Decimal('3.5')
            b = dict(time=time,open=float(mid),high=float(mid+quantum*2),low=float(mid-quantum*2),close=float(mid+quantum),volume=v)
            if proxy_only: pass
            elif i % 11 != 0: b['vw'] = float(vw)
            elif i % 22 == 0: b['vw'] = 0
            rows.append(b)
    # Real last-wins revision plus deterministic disorder.
    ordered = rows[:]
    if len(rows)>20 and not zero:
        revised = {**rows[19], 'volume': rows[19]['volume']+7}
        ordered[19] = revised
        rows.append(revised)
    first_part = rows[:-1] if rows else []
    random.Random(20261124).shuffle(first_part)
    input_rows = first_part+[rows[-1]] if rows else []
    result = dict(name=name,now=now,bars=input_rows,modes=[])
    for mode in ['RTH','EXTENDED']:
        anchor = selected[0]['open'] if mode=='RTH' else selected[0]['extendedOpen']
        eligible = [b for b in ordered if any((s['open'] if mode=='RTH' else s['extendedOpen']) <= b['time'] < (s['close'] if mode=='RTH' else s['extendedClose']) for s in selected)]
        W=P=P2=Decimal(0)
        count=real=proxy=0
        expected=[]
        pairs=[]
        for b in eligible:
            p,v=price(b),Decimal(b['volume'])
            if v>0:
                W+=v;P+=p*v;P2+=p*p*v;count+=1;pairs.append((p,v))
                if b.get('vw',0)>0: real+=1
                else: proxy+=1
            values=output(W,P,P2)
            expected.append([b['time'],*values,float(W),count,float(P2-P*P/W) if W else 0])
        # Explicit independent two-pass audit of the final population variance.
        if W:
            mean = sum(p*v for p,v in pairs)/W
            two_pass_m2 = sum(v*(p-mean)**2 for p,v in pairs)
            assert abs(two_pass_m2-(P2-P*P/W)) < Decimal('1e-25')
        targets={}
        ends=[b['time']+60 for b in eligible]
        for minutes in [1,5,15,60]:
            targets[str(minutes)]=[]
            for s in selected:
                start,end=(s['open'],s['close']) if mode=='RTH' else (s['extendedOpen'],s['extendedClose'])
                for t in range(start,min(now,end),minutes*60):
                    end_exclusive=min(t+minutes*60,end)
                    cutoff=min(end_exclusive,ends[-1] if ends else anchor)
                    targets[str(minutes)].append([t,end_exclusive,bisect_right(ends,cutoff)-1])
        result['modes'].append(dict(mode=mode,anchor=anchor,expected=expected,targets=targets,
            coverage='COMPLETE_CANONICAL_1M' if now>=anchor else 'UNAVAILABLE',
            source='MIXED_VW_HLC3' if real and proxy else 'REAL_VW' if real else 'HLC3_PROXY',
            final=dict(count=count,V=float(W),PV=float(P),P2V=float(P2),mean=float(P/W) if W else None,m2=float(P2-P*P/W) if W else 0)))
    return result


cases = [
    scenario('holiday_day1_USD','2025-09-02T14:00:00','500'),
    scenario('march_DST_USD_spikes','2025-03-10T16:00:00','500'),
    scenario('november_DST_ARS_tiny_dispersion','2025-11-04T20:00:00','80000',tiny=True),
    scenario('november_early_close_ARS','2025-11-28T17:00:00','80000'),
    scenario('all_zero_volume','2025-09-02T05:00:00','500',zero=True),
    scenario('complete_HLC3_proxy','2025-09-02T11:00:00','500',proxy_only=True),
]
seed_rows=sorted({b['time']:b for b in cases[0]['bars']}.values(),key=lambda b:b['time'])[:3]
a={**seed_rows[-1],'time':seed_rows[-1]['time']+60,'volume':8,'vw':0}
b={**a,'volume':13}
c={**a,'time':a['time']+60,'volume':5}
live=[]
for forming,closed in [(a,None),(b,None),(b,None),(c,b)]:
    rows=seed_rows+([closed] if closed is not None else [])+[forming]
    W=sum(Decimal(r['volume']) for r in rows)
    P=sum(price(r)*Decimal(r['volume']) for r in rows)
    P2=sum(price(r)**2*Decimal(r['volume']) for r in rows)
    live.append(dict(forming=forming,closed=closed,expected=output(W,P,P2),V=float(W)))
path = ROOT/'fixtures/avwap_canonical_multitemporal.json'
path.write_text(json.dumps(dict(method='DECIMAL_50_EXACT_SUMS_AND_TWO_PASS_AUDIT',scenarios=cases,live=dict(seedBars=seed_rows,events=live)),separators=(',',':'))+'\n')
print(f'{path.name}: {len(cases)} scenarios, {sum(len(c["bars"]) for c in cases)} source rows; every eligible 1m close expected independently')
