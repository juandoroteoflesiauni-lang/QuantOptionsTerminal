"""Independent S1-8 oracle: Decimal(50), direct windows (no incremental ring).
Inputs are decimal strings; invalid observations are named, never nonstandard JSON.
Run from the repository root. No dependency beyond Python's standard library.
"""
from decimal import Decimal, localcontext
from pathlib import Path
from datetime import datetime, timedelta, timezone
import json
D=Decimal

def number(s):
    return D(str(s))

def encoded(v):
    return str(v) if v is not None and v.is_finite() else None

def weighted(rows,n):
    out=[]
    for end in range(len(rows)):
        window=rows[max(0,end-n+1):end+1]
        good=len(window)==n and all(number(b['close']).is_finite() and number(b['volume']).is_finite() and number(b['volume'])>=0 for b in window)
        if not good: out.append(None);continue
        den=sum((number(b['volume']) for b in window),D(0))
        out.append(encoded(sum((number(b['close'])*number(b['volume']) for b in window),D(0))/den) if den>0 else None)
    return out

def sma(rows,n):
    out=[]
    for i in range(len(rows)):
        w=[number(b['close']) for b in rows[max(0,i-n+1):i+1]]
        out.append(encoded(sum(w,D(0))/n) if len(w)==n and all(v.is_finite() for v in w) else None)
    return out

def ema(rows,n):
    out=[None]*len(rows)
    if len(rows)<n:return out
    seed=[number(b['close']) for b in rows[:n]]
    if not all(v.is_finite() for v in seed):return out
    prev=sum(seed,D(0))/n;out[n-1]=encoded(prev)
    alpha=D(2)/D(n+1)
    for i in range(n,len(rows)):
        close=number(rows[i]['close'])
        if not close.is_finite():break
        prev=alpha*close+(1-alpha)*prev
        out[i]=encoded(prev)
    return out

def bar(t,c,v):
    return dict(time=t,open=str(c),high=str(c),low=str(c),close=str(c),volume=str(v),vw='1')

def references(rows):
    return {**{f'ema{n}':ema(rows,n) for n in [9,21,50,200]},**{f'sma{n}':sma(rows,n) for n in [50,200]},**{f'vwma{n}':weighted(rows,n) for n in [9,21]}}

def main():
    with localcontext() as ctx:
        ctx.prec=50
        cases=[]
        for name,base,count in [('usd',D('500'),1300),('ars',D('80000'),1300),('constant',D('500'),1050),('invalid',D('500'),1100)]:
            rows=[bar(1793781000+i*60,base+(D((i*37)%103)-51)*D('0.00000013') if name!='constant' else base,0 if i%43==0 else ((i*7919)%100003)+1) for i in range(count)]
            if name=='invalid':
                for i,field,value in [(7,'close','NaN'),(47,'volume','-1'),(113,'volume','Infinity'),(164,'close','-Infinity'),(211,'volume','NaN')]:rows[i][field]=value
                for i in range(280,310):rows[i]['volume']='0'
            live=[]
            for index in [8,20,50,511,512,513,1023,1024,1025]:
                for vol in ['0','123','4567']:
                    forming=bar(rows[index]['time']+60,base+D('0.00314159'),vol)
                    live.append(dict(index=index,forming=forming,expected={str(n):weighted(rows[:index+1]+[forming],n)[-1] for n in [9,21]}))
            cases.append(dict(name=name,bars=rows,expected=references(rows),live=live))
        # Actual NYSE sessions in November 2026: Thanksgiving closed; Friday early close.
        five=[]
        day=datetime(2026,11,16,tzinfo=timezone.utc)
        while day.day<=27:
            if day.weekday()<5 and day.day!=26:
                start=day+timedelta(hours=14,minutes=30)
                count=42 if day.day==27 else 78
                for j in range(count):
                    i=len(five);five.append(bar(int(start.timestamp())+j*300,D('500')+D((i*17)%131)/1000,100+i))
            day+=timedelta(days=1)
        start=int(datetime(2026,11,20,14,30,tzinfo=timezone.utc).timestamp())
        lower=[bar(start+i*60,D('501')+D(i)/1000,500) for i in range(12)]
        mtf=[]
        for label,source,eval_time in [('before_close',five,start+299),('at_close',five,start+300),('after_close',five,start+720),('minimum250',five[62:],start+720),('insufficient',five[70:],start+720)]:
            closed=[b for b in source if b['time']+300<=eval_time]
            es=ema(closed,20)
            values=[]
            for b in lower:
                eligible=[i for i,f in enumerate(closed) if f['time']+300<=min(b['time']+60,eval_time)]
                values.append(es[eligible[-1]] if len(eligible)>=250 else None)
            count=sum(b['time']+300<=min(lower[0]['time'],eval_time) for b in closed)
            last=values[-1]
            provisional=encoded(D(last)+(D(2)/21)*(D('502.125')-D(last))) if last is not None else None
            live_confirmed=encoded(D(last)+(D(2)/21)*(number(lower[4]['close'])-D(last))) if last is not None else None
            revision_index=max(0,len(closed)-3)
            revision_rows=[dict(b) for b in closed];revision_rows[revision_index]['close']='1000'
            revision_emas=ema(revision_rows,20)
            revision_expected=[]
            for b in lower:
                eligible=[i for i,f in enumerate(revision_rows) if f['time']+300<=min(b['time']+60,eval_time)]
                revision_expected.append(revision_emas[eligible[-1]] if len(eligible)>=250 else None)
            mtf.append(dict(revisionIndex=revision_index,revisionExpected=revision_expected,liveConfirmed=live_confirmed,name=label,bars1m=lower,bars5m=source,evaluationTimeSec=eval_time,warmupBeforeFirst=count,expected=values,formingClose='502.125',provisional=provisional))
        # Independent ISO calendar grouping, without calling the TypeScript resampler.
        daily=[];day=datetime(2020,1,2,15,tzinfo=timezone.utc)
        while len(daily)<2300:
            if day.weekday()<5:
                i=len(daily);daily.append(bar(int(day.timestamp()),D('80000')+D((i*37)%997)/1000,1000+i))
            day+=timedelta(days=1)
        groups={}
        for b in daily:
            dt=datetime.fromtimestamp(b['time'],timezone.utc);key=(dt-timedelta(days=dt.weekday())).date().isoformat()
            groups.setdefault(key,[]).append(b)
        weekly=[]
        for group in groups.values():
            prices=[number(b['close']) for b in group]
            b=bar(group[0]['time'],prices[-1],sum((number(b['volume']) for b in group),D(0)))
            b.update(open=group[0]['open'],high=str(max(prices)),low=str(min(prices)));weekly.append(b)
        revised=[dict(b) for b in cases[0]['bars']];revised[1291]['close']='1000'
        last=dict(cases[0]['bars'][-1]);last['volume']='123'
        second=bar(last['time']+60,D('501'),'234');forming=bar(last['time']+120,D('502'),'333')
        coalesced_rows=cases[0]['bars'][:-1]+[last,second,forming]
        correction=dict(second);correction.update(close='501.125',volume='500')
        correction_rows=coalesced_rows[:-2]+[correction,forming]
        coalesced=dict(correction=correction,correctionExpected={str(n):weighted(correction_rows,n)[-1] for n in [9,21]},closed=[last,second],forming=forming,expected={str(n):weighted(coalesced_rows,n)[-1] for n in [9,21]},ema={str(n):ema(coalesced_rows,n)[-1] for n in [9,21]})
        result=dict(coalesced=coalesced,weekly=dict(daily=daily,bars=weekly,expected=references(weekly),visibleFrom=daily[-1250]['time']),revision=dict(bars=revised,expected=references(revised)),precision=50,method='direct Decimal windows; independent EMA recurrence with SMA seed',presets={
          '1m':['EMA','EMA',[True,True,False,False],True,False], '5m':['EMA','EMA',[True,True,True,False],True,False],
          '15m':['EMA','EMA',[True]*4,False,False],**{tf:['EMA','SMA',[True]*4,False,False] for tf in ['1h','1D','1W']},'4h':['EMA','EMA',[True]*4,False,False]},cases=cases,mtf=mtf)
        target=Path(__file__).resolve().parents[1]/'fixtures/ma_vwma_mtf_reference.json'
        target.write_text(json.dumps(result,indent=2,allow_nan=False)+'\n',encoding='utf-8')
        print(target.name)
if __name__=='__main__':main()
