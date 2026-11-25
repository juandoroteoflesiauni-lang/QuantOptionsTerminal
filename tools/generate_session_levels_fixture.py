"""Independent timestamp/set-coverage oracle. No TypeScript execution or network."""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from decimal import Decimal, getcontext
from pathlib import Path
import json
getcontext().prec=50
ROOT=Path(__file__).resolve().parents[1]
NY=ZoneInfo("America/New_York")
AR=ZoneInfo("America/Argentina/Buenos_Aires")
calendar=json.loads((ROOT/"fixtures/pieza0b_massive_rest_reference.json").read_text(encoding="utf-8"))["calendar"]
US={r["session"]["dateKey"]:r["session"] for r in calendar if r["session"] is not None}
def stamp(day,hm,zone=NY):
    return int(datetime.fromisoformat(day+"T"+hm).replace(tzinfo=zone).timestamp())
def rows(start,end,step=60):
    out=[]
    for i,t in enumerate(range(start,end,step)):
        p=Decimal("500")+Decimal(i%19)/Decimal(100)
        b={"time":t,"open":float(p),"high":float(p+Decimal("0.25")),"low":float(p-Decimal("0.15")),"close":float(p),"volume":i%7}
        out.append({"bar":b,"endExclusive":t+step})
    return out
DATA={}
CASES=[]
def expected(dataset,market,evaluation,opening,ar_sessions):
    zone=NY if market=="US" else AR
    day=datetime.fromtimestamp(evaluation,zone).date().isoformat()
    schedule=US if market=="US" else {s["dateKey"]:s for s in ar_sessions}
    current=schedule.get(day)
    windows={}
    if current:
        earlier=[s for k,s in schedule.items() if k<day]
        prev=max(earlier,key=lambda s:s["dateKey"]) if earlier else None
        if prev: windows["PD"]=(prev["dateKey"],prev["open"],prev["close"])
        if market=="US":windows["PM"]=(day,current["extendedOpen"],current["open"])
        windows["OR"]=(day,current["open"],min(current["close"],current["open"]+opening*60))
    unique={(r["bar"]["time"],r["endExclusive"]):r for r in dataset}
    result=[]
    for pair in ["PD","PM","OR"]:
        window=windows.get(pair)
        eligible=[];observed=set()
        if window:
            ref,start,end=window
            for row in unique.values():
                b=row["bar"];finish=row["endExclusive"]
                if start<=b["time"]<finish<=min(evaluation,end):
                    eligible.append(b);observed.update(range(b["time"],finish,60))
            closed=evaluation>=end
            complete=set(range(start,end,60)).issubset(observed)
            status="UNAVAILABLE" if not eligible or (closed and not complete) else "DEFINITIVE" if closed else "PROVISIONAL"
        else:
            ref=day;start=end=None;status="UNAVAILABLE"
        for letter in ["H","L"]:
            value=None if status=="UNAVAILABLE" else max(b["high"] for b in eligible) if letter=="H" else min(b["low"] for b in eligible)
            result.append(dict(id=pair+letter,value=value,status=status,sessionDate=ref,start=start,endExclusive=end))
    return result
for label,day,prev in [("before_DST","2025-03-07","2025-03-06"),("after_DST","2025-03-10","2025-03-07"),("holiday_previous","2025-09-02","2025-08-29"),("early_close_previous","2025-12-01","2025-11-28")]:
    a=US[day];b=US[prev]
    DATA[label]=rows(b["open"],b["close"])+rows(a["extendedOpen"],a["close"])
    for hm in ["03:59:59","04:00:00","04:01:00","09:29:59","09:30:00","09:34:59","09:35:00","09:44:59","09:45:00","09:59:59","10:00:00","16:00:00"]:
        e=stamp(day,hm)
        CASES.append(dict(name=label+"_"+hm,dataset=label,market="US",evalTimeSec=e,arSessions=[],expected={str(w):expected(DATA[label],"US",e,w,[]) for w in [5,15,30]}))
DATA["next_session"]=rows(US["2025-03-10"]["open"],US["2025-03-10"]["close"])+rows(stamp("2025-03-11","09:30"),stamp("2025-03-11","09:35"))
e=stamp("2025-03-11","09:35")
CASES.append(dict(name="next_session",dataset="next_session",market="US",evalTimeSec=e,arSessions=[],expected={str(w):expected(DATA["next_session"],"US",e,w,[]) for w in [5,15,30]}))
# A missing eligible minute cannot be certified after the window closes.
base=DATA["after_DST"]
for label,predicate in [("missing_PM",lambda t:t!=stamp("2025-03-10","06:00")),("no_PM",lambda t:not stamp("2025-03-10","04:00")<=t<stamp("2025-03-10","09:30")),("missing_PD",lambda t:t!=stamp("2025-03-07","12:00")),("missing_OR",lambda t:t!=stamp("2025-03-10","09:32"))]:
    DATA[label]=[r for r in base if predicate(r["bar"]["time"])]
    e=stamp("2025-03-10","10:00")
    CASES.append(dict(name=label,dataset=label,market="US",evalTimeSec=e,arSessions=[],expected={str(w):expected(DATA[label],"US",e,w,[]) for w in [5,15,30]}))
for label,day in [("weekend","2025-03-09"),("holiday","2025-11-27")]:
    e=stamp(day,"12:00");CASES.append(dict(name=label,dataset="after_DST",market="US",evalTimeSec=e,arSessions=[],expected={str(w):expected(base,"US",e,w,[]) for w in [5,15,30]}))
# Explicit exchange-session evidence for AR, never a fabricated production calendar.
ar_sessions=[dict(dateKey=d,open=stamp(d,"11:00",AR),close=stamp(d,"17:00",AR),extendedOpen=stamp(d,"11:00",AR),extendedClose=stamp(d,"17:00",AR)) for d in ["2025-03-07","2025-03-10"]]
DATA["AR"]=sum((rows(s["open"],s["close"]) for s in ar_sessions),[])
for hm in ["10:59:59","11:00:00","11:01:00","11:05:00","11:15:00","11:30:00"]:
    e=stamp("2025-03-10",hm,AR)
    CASES.append(dict(name="AR_"+hm,dataset="AR",market="AR",evalTimeSec=e,arSessions=ar_sessions,expected={str(w):expected(DATA["AR"],"AR",e,w,ar_sessions) for w in [5,15,30]}))
for label,step,hm in [("aggregate_crosses_OR",900,"09:45"),("aggregate_still_open",900,"09:37")]:
    DATA[label]=rows(stamp("2025-03-10","09:30"),stamp("2025-03-10","10:00"),step)
    e=stamp("2025-03-10",hm)
    CASES.append(dict(name=label,dataset=label,market="US",evalTimeSec=e,arSessions=[],expected={str(w):expected(DATA[label],"US",e,w,[]) for w in [5,15,30]}))
# Hysteresis references use Decimal comparisons, explicit state transitions and decimal equality.
sequences=[]
for mode,scale in [("PCT_1_5","100"),("ATR_1_5","80000")]:
    denominator=Decimal(scale) if mode=="PCT_1_5" else Decimal("100")
    distances=["0.0149","0.0160","0.0165","0.0166","0.0160","0.0150"] if mode=="PCT_1_5" else ["1.49","1.60","1.65","1.66","1.60","1.50"]
    visible=False;steps=[]
    for d in distances:
        bound=(Decimal("0.0165") if visible else Decimal("0.015")) if mode=="PCT_1_5" else (Decimal("1.65") if visible else Decimal("1.5"))
        visible=Decimal(d)<=bound
        steps.append(dict(referencePrice=float(Decimal(scale)),currentAvwap=float(Decimal(scale)+Decimal(d)*denominator),atr14D=100,visible=visible))
    sequences.append(dict(mode=mode,steps=steps))
# USD and ARS, below/at/above entry/exit; invalid ATR cannot borrow percentage state.
proximity=[]
for mode in ["PCT_1_5","ATR_1_5","SHOW_ALL"]:
    for scale in [Decimal("500"),Decimal("80000")]:
        for was in [False,True]:
            for distance in [Decimal("1.49"),Decimal("1.50"),Decimal("1.60"),Decimal("1.65"),Decimal("1.66")]:
                delta=scale*distance/100 if mode=="PCT_1_5" else distance*100
                bound=Decimal("1.65") if was else Decimal("1.50")
                proximity.append(dict(mode=mode,referencePrice=float(scale),currentAvwap=float(scale+delta),atr14D=100,wasVisible=was,visible=mode=="SHOW_ALL" or distance<=bound))
for atr in [None,"NaN","Infinity",0,-1]:
    proximity.append(dict(mode="ATR_1_5",referencePrice=500,currentAvwap=500,atr14D=atr,wasVisible=True,visible=False))
live_start=stamp("2025-03-10","09:30")
DATA["live"]=rows(live_start,live_start+120)
live=[]
for high,low,closed in [(502,498,False),(501,499,False),(501,499,True)]:
    bar=dict(time=live_start+120,open=500,high=high,low=low,close=500,volume=100)
    live.append(dict(bar=bar,endExclusive=bar["time"]+60,observedAt=bar["time"]+(60 if closed else 20),confirmed=closed,expectedHigh=max(500.26,high),expectedLow=min(499.85,low)))
live[1]["quote"]=dict(price=503,time=live_start+145,expectedHigh=503,expectedLow=499)
confirmed_revision=dict(bar=dict(time=live_start+120,open=500,high=500.5,low=499.5,close=500,volume=100),endExclusive=live_start+180,observedAt=live_start+190,expectedHigh=500.5,expectedLow=499.5)
label_time=stamp("2025-03-09","23:30")
label_dates=[dict(time=label_time,zone=str(zone),expected=datetime.fromtimestamp(label_time,zone).strftime("%d/%m/%y")) for zone in [NY,AR]]
result=dict(labelDates=label_dates,confirmedRevision=confirmed_revision,meta=dict(precision=50,timezones=[str(NY),str(AR)],coverage="independent eligible-minute sets; no TypeScript"),datasets=DATA,cases=CASES,proximity=proximity,sequences=sequences,live=live)
path=ROOT/"fixtures/session_key_levels_reference.json"
path.write_text(json.dumps(result,ensure_ascii=False,allow_nan=False,separators=(",",":"))+"\n",encoding="utf-8")
print(f"{len(CASES)} session evaluations x 3 OR; {len(proximity)} proximity cases; {len(sequences)} state sequences")
