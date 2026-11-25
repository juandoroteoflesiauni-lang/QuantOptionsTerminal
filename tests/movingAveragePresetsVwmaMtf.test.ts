import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe,it,expect,afterAll,vi } from 'vitest';
import type { FetchResponse } from '../src/data/types.js';
import type { Bar } from '../src/core/types.js';
import { calculateEma,projectLiveEma } from '../src/core/ema.js';
import { computeSmaSeries } from '../src/core/microstructure/mtfStructure.js';
import { resolveMaPresetForTimeframe,overrideMaPreset,createVwmaState,advanceVwma,vwmaValue,computeVwmaSeriesPure,projectLiveVwma,
  serializeMovingAverages,serializeWeeklyMovingAverages,projectSeededEma,computeMaSeriesPure,normalizeMaBars,projectMtfEmaToLowerBarsPure,serializeMtfEma,createMtfLiveState,confirmMtfMinute,projectMtfProvisional,
  areConsecutiveFiveMinuteBars,nextFiveMinuteClose,resolveMtfWarmupFrom,type MaSeries,type MaPreset } from '../src/core/movingAverages.js';
import { createMaChartRuntime } from '../web/src/components/stock-detail/movingAverageRuntime.js';
import { UsHistoricalService } from '../src/server/usHistoricalService.js';
import { MassiveKeyRouter } from '../src/server/massiveKeyPool.js';
import type { FmpHistoricalResult } from '../src/server/fmpClient.js';
interface InputBar {time:number;open:string;high:string;low:string;close:string;volume:string;vw:string}
interface Scenario {name:string;bars:InputBar[];expected:Record<keyof MaSeries,(string|null)[]>;live:{index:number;forming:InputBar;expected:Record<string,string|null>;ema:Record<string,string|null>}[]}
interface MtfScenario {revisionIndex:number;revisionExpected:(string|null)[];liveConfirmed:string|null;name:string;bars1m:InputBar[];bars5m:InputBar[];evaluationTimeSec:number;warmupBeforeFirst:number;expected:(string|null)[];formingClose:string;provisional:string|null}
const raw=readFileSync('fixtures/ma_vwma_mtf_reference.json','utf8');
const fixture=JSON.parse(raw) as {presets:Record<string,[string,string,boolean[],boolean,boolean]>;cases:Scenario[];mtf:MtfScenario[];weekly:{daily:InputBar[];bars:InputBar[];expected:Scenario['expected'];visibleFrom:number};revision:{bars:InputBar[];expected:Scenario['expected']};coalesced:{ema:Record<string,string|null>;correction:InputBar;correctionExpected:Record<string,string|null>;closed:InputBar[];forming:InputBar;expected:Record<string,string|null>}};
const decode=(b:InputBar):Bar=>({time:b.time,open:Number(b.open),high:Number(b.high),low:Number(b.low),close:Number(b.close),volume:Number(b.volume),vw:Number(b.vw)});
const maxima:Record<string,number>={EMA:0,SMA50:0,SMA200:0,VWMA9:0,VWMA21:0,VWMA_provisional:0,MTF_EMA20:0,MTF_EMA20_provisional:0};
const compare=(actual:number,expected:string|null,key:string):void=>{
  if(expected===null){expect(actual).toBeNaN();return;}
  expect(Number.isFinite(actual)).toBe(true);
  const error=Math.abs(actual-Number(expected));maxima[key]=Math.max(maxima[key]??0,error);expect(error).toBeLessThanOrEqual(1e-9);
};
afterAll(()=>{mkdirSync('.cache',{recursive:true});writeFileSync('.cache/pieza4-math-metrics.json',JSON.stringify({fixtureSha256:createHash('sha256').update(raw).digest('hex'),absoluteTolerance:1e-9,maxAbsoluteError:maxima},null,2)+'\n');});
describe('S1-8 independent Decimal oracle and fixed immutable VWMA ring',()=>{
  it.each(Object.entries(fixture.presets))('resolves the independently specified %s preset',(tf,expected)=>{
    const p=resolveMaPresetForTimeframe(tf);expect([p.fastType,p.slowType,p.visible,p.sessionVwap,p.mtfEma20]).toEqual(expected);
    expect(p.fastSelectable).toBe(tf==='1m'||tf==='5m');expect(p.mtfAvailable).toBe(tf==='1m');
  });
  it('isolates session-only overrides by timeframe and rejects unknown frames',()=>{
    const defaults=resolveMaPresetForTimeframe('1m');const memory:Record<string,MaPreset>={};
    memory['1m']=overrideMaPreset(defaults,{fastType:'VWMA',mtfEma20:true,sessionVwap:false});
    memory['5m']=overrideMaPreset(resolveMaPresetForTimeframe('5m'),{visible:[false,true,true,false]});
    expect(memory['1m'].fastType).toBe('VWMA');expect(memory['5m'].fastType).toBe('EMA');expect(defaults.mtfEma20).toBe(false);
    expect(overrideMaPreset(resolveMaPresetForTimeframe('1h'),{fastType:'VWMA',mtfEma20:true}).fastType).toBe('EMA');
    expect(resolveMaPresetForTimeframe('1H')).toEqual(resolveMaPresetForTimeframe('1h'));
    expect(()=>resolveMaPresetForTimeframe('2m')).toThrow();expect(()=>createVwmaState(10)).toThrow();expect(()=>computeVwmaSeriesPure([],50)).toThrow();
  });
  it.each(fixture.cases)('$name: every EMA/SMA/VWMA window agrees within absolute 1e-9',scenario=>{
    const rows=scenario.bars.map(decode);const before=JSON.stringify(rows);const result=computeMaSeriesPure(rows);
    for(const key of Object.keys(result) as (keyof MaSeries)[])result[key].forEach((value,i)=>{compare(value,scenario.expected[key][i]??null,key.startsWith('ema')?'EMA':key.toUpperCase());});
    expect(JSON.stringify(rows)).toBe(before);
    expect(result.sma50).toEqual(computeSmaSeries(rows.map(b=>b.close),50));
    expect(result.sma200).toEqual(computeSmaSeries(rows.map(b=>b.close),200));
    expect(result.ema200).toEqual(calculateEma(rows.map(b=>b.close),200));
    for(const period of [9,21]) {
      let state=createVwmaState(period);
      rows.forEach((bar,index)=>{
        const old=state;const snapshot=JSON.stringify(old);state=advanceVwma(old,bar);
        expect(JSON.stringify(old)).toBe(snapshot);expect(state.confirmedCount).toBe(index+1);expect(state.resyncCount).toBe(Math.floor((index+1)/512));
        expect(state.invalidCount+state.validCount).toBe(state.size);expect(state.size).toBeLessThanOrEqual(period);
        compare(vwmaValue(state),scenario.expected[`vwma${String(period)}` as keyof MaSeries][index]??null,`VWMA${String(period)}`);
      });
      for(const live of scenario.live) {
        let confirmed=createVwmaState(period);for(const bar of rows.slice(0,live.index+1))confirmed=advanceVwma(confirmed,bar);
        const snapshot=JSON.stringify(confirmed);const b=decode(live.forming);
        for(let tick=0;tick<25;tick+=1)compare(projectLiveVwma(confirmed,b.close,b.volume),live.expected[String(period)]??null,'VWMA_provisional');
        expect(JSON.stringify(confirmed)).toBe(snapshot);
      }
    }
  });
  it('retains zero/invalid observations and recovers only when the offending observation exits',()=>{
    const rows=fixture.cases.find(c=>c.name==='invalid')?.bars.map(decode)??[];
    const values=computeVwmaSeriesPure(rows,9);
    expect(values[47]).toBeNaN();expect(values[55]).toBeNaN();expect(Number.isFinite(values[56])).toBe(true);
    expect(values[288]).toBeNaN();expect(Number.isFinite(values[310])).toBe(true);
    expect(projectLiveVwma(createVwmaState(9),500,1)).toBeNaN();
    let state=createVwmaState(9);for(let i=0;i<9;i+=1)state=advanceVwma(state,{close:500,volume:1});
    expect(projectLiveVwma(state,Number.NaN,1)).toBeNaN();expect(projectLiveVwma(state,500,-1)).toBeNaN();
    expect(computeVwmaSeriesPure(rows.map(b=>({...b,volume:0})),21).every(Number.isNaN)).toBe(true);
  });
  it('rebuilds legitimate historical revisions and keeps warm-up before the visible boundary',()=>{
    const rows=(fixture.cases[0] as Scenario).bars.map(decode);const dto=serializeMovingAverages(rows,1100);
    expect(dto.times).toEqual(rows.slice(1100).map(b=>b.time));expect(dto.values.sma200[0]).not.toBeNull();
    compare(dto.values.sma200[0]??Number.NaN,(fixture.cases[0] as Scenario).expected.sma200[1100]??null,'SMA200');
    expect(dto.confirmedTail).toHaveLength(200);expect(dto.confirmedThrough).toBe(rows[rows.length-2]?.time);
    const short=serializeMovingAverages(rows.slice(0,199));expect(short.values.sma200.every(v=>v===null)).toBe(true);
    const modified=normalizeMaBars([...rows,{...(rows[1291] as Bar),close:1000}]);
    expect(modified).toEqual(fixture.revision.bars.map(decode));
    computeVwmaSeriesPure(modified,21).forEach((value,i)=>{compare(value,fixture.revision.expected.vwma21[i]??null,'VWMA21');});
    expect(serializeMovingAverages(modified,1100).values.vwma21).not.toEqual(dto.values.vwma21);
    expect(normalizeMaBars([...rows].reverse())).toEqual(rows);expect(normalizeMaBars([{...(rows[0] as Bar),time:1e14}])).toEqual([]);
    expect(JSON.stringify(dto)).not.toMatch(/NaN|Infinity/);
    const invalid=serializeMovingAverages((fixture.cases[3] as Scenario).bars.map(decode).slice(0,220));
    expect(invalid.confirmedTail.some(observation=>observation.volume===null)).toBe(true);expect(JSON.stringify(invalid)).not.toMatch(/NaN|Infinity/);
  });
});
describe('S1-8 real weekly calculation depth and live SMA seed',()=>{
  it('computes weekly SMA on all calculation weeks before trimming daily coverage to the viewport',()=>{
    const c=fixture.weekly;const full=serializeWeeklyMovingAverages(c.daily.map(decode),c.daily[0]?.time??0,'America/New_York');
    expect(full.bars).toEqual(c.bars.map(decode));
    const visible=serializeWeeklyMovingAverages(c.daily.map(decode),c.visibleFrom,'America/New_York');
    expect(visible.movingAverages.values.sma200[0]).not.toBeNull();
    const index=c.bars.findIndex(b=>b.time===visible.bars[0]?.time);
    for(const period of [50,200] as const)visible.movingAverages.values[`sma${String(period)}` as 'sma50'|'sma200'].forEach((value,i)=>{compare(value??Number.NaN,c.expected[`sma${String(period)}` as 'sma50'|'sma200'][index+i]??null,`SMA${String(period)}`);});
    expect(serializeWeeklyMovingAverages(c.daily.slice(-100).map(decode),c.visibleFrom,'America/New_York').bars).toEqual([]);
  });
  it('preserves a valid close for live SMA when only its seed volume is invalid',()=>{
    const c=fixture.cases.find(scenario=>scenario.name==='invalid') as Scenario;
    const rows=c.bars.slice(0,140).map(decode),dto=serializeMovingAverages(rows);
    expect(JSON.stringify(dto)).not.toMatch(/NaN|Infinity/);
    const runtime=createMaChartRuntime(dto,resolveMaPresetForTimeframe('1h'),undefined,rows),last=rows.at(-1) as Bar;
    compare(runtime.project({timeSec:last.time,close:last.close,volume:last.volume})[2]??Number.NaN,c.expected.sma50[139]??null,'SMA50');
    const seed=dto.confirmedTail.find(observation=>observation.time===(rows[113] as Bar).time);
    expect(seed?.volume).toBeNull();expect(seed?.close).toBe((rows[113] as Bar).close);
  });
  it('seeds the first live EMA from the same independent n-close SMA and never chains snapshots',()=>{
    const c=fixture.cases[0] as Scenario,rows=c.bars.map(decode);
    for(const period of [9,21,50,200]) {
      let unit=createVwmaState(period);for(const bar of rows.slice(0,period-1))unit=advanceVwma(unit,{close:bar.close,volume:1});
      compare(projectSeededEma(Number.NaN,period-1,unit,(rows[period-1] as Bar).close,period),c.expected[`ema${String(period)}` as keyof MaSeries][period-1]??null,'EMA');
      const dto=serializeMovingAverages(rows.slice(0,period));const runtime=createMaChartRuntime(dto,resolveMaPresetForTimeframe('1h'),undefined,rows.slice(0,period));
      const result=runtime.project({timeSec:(rows[period-1] as Bar).time,close:(rows[period-1] as Bar).close,volume:1});
      if(period===9||period===21)compare(result[period===9?0:1]??Number.NaN,c.expected[`ema${String(period)}` as keyof MaSeries][period-1]??null,'EMA');
    }
  });
});
describe('S1-8 confirmed causal EMA20(5m), exact opening/closing boundaries',()=>{
  it.each(fixture.mtf)('$name: matches independent Decimal EMA and provisional reference',scenario=>{
    const one=scenario.bars1m.map(decode),five=scenario.bars5m.map(decode);
    const options={evaluationTimeSec:scenario.evaluationTimeSec,rthOnly:true,forming5mClose:Number(scenario.formingClose)};
    const result=projectMtfEmaToLowerBarsPure(one,five,20,options);
    result.values.forEach((value,i)=>{compare(value,scenario.expected[i]??null,'MTF_EMA20');});
    compare(result.provisional,scenario.provisional,'MTF_EMA20_provisional');expect(result.warmupBeforeFirst).toBe(scenario.warmupBeforeFirst);
    const future=five.map(b=>b.time+300>options.evaluationTimeSec?{...b,close:Number.NaN,volume:1e12}:b);
    expect(projectMtfEmaToLowerBarsPure(one,future,20,options)).toEqual(result);
    expect(projectMtfEmaToLowerBarsPure(one,five.filter(b=>b.time+300<=options.evaluationTimeSec),20,options)).toEqual(result);
    expect(projectMtfEmaToLowerBarsPure(one,five.map(b=>b.time+300>options.evaluationTimeSec?{...b,close:1e20,volume:1e20}:b),20,options)).toEqual(result);
    const revised=normalizeMaBars([...five].reverse().concat([{...(five[scenario.revisionIndex] as Bar),close:1000}]));
    projectMtfEmaToLowerBarsPure(one,revised,20,options).values.forEach((value,i)=>{compare(value,scenario.revisionExpected[i]??null,'MTF_EMA20');});

    const provisionalOnly=projectMtfEmaToLowerBarsPure(one,five,20,{...options,forming5mClose:90000});
    expect(provisionalOnly.values).toEqual(result.values);expect(provisionalOnly.lastConfirmed).toEqual(result.lastConfirmed);
    const dto=serializeMtfEma(result,one,{source:'CACHE_5M',acquisitionAttempted:false,adjustmentSignature:'A',sessionMode:'RTH'});
    expect(JSON.stringify(dto)).not.toMatch(/NaN|Infinity/);expect(dto.values).toHaveLength(one.length);
  });
  it('holds the old value at 09:34 open and changes only at real 09:35 confirmation',()=>{
    const before=fixture.mtf[0] as MtfScenario,at=fixture.mtf[1] as MtfScenario;
    const one=before.bars1m.map(decode),five=before.bars5m.map(decode);
    const a=projectMtfEmaToLowerBarsPure(one,five,20,{evaluationTimeSec:before.evaluationTimeSec,rthOnly:true});
    const b=projectMtfEmaToLowerBarsPure(one,five,20,{evaluationTimeSec:at.evaluationTimeSec,rthOnly:true});
    expect(a.values[4]).toBe(a.values[0]);expect(b.values[3]).toBe(a.values[3]);expect(b.values[4]).not.toBe(a.values[4]);expect(b.values[5]).toBe(b.values[4]);
    expect(a.provisional).toBeNaN();expect(a.warmupBeforeFirst).toBeGreaterThanOrEqual(300);
    expect(projectMtfEmaToLowerBarsPure(one,[],20,{evaluationTimeSec:at.evaluationTimeSec}).status).toBe('UNAVAILABLE');
    expect(projectMtfEmaToLowerBarsPure(one,five).confirmedThrough).toBeLessThanOrEqual(one[one.length-1]?.time??0);
  });
  it('rejects missing eligible buckets but accepts overnight, holidays and early closes',()=>{
    const scenario=fixture.mtf[2] as MtfScenario,one=scenario.bars1m.map(decode),five=scenario.bars5m.map(decode);
    const gap=projectMtfEmaToLowerBarsPure(one,five.filter((_,i)=>i!==301),20,{evaluationTimeSec:scenario.evaluationTimeSec,rthOnly:true});
    expect(gap.status).toBe('GAP');expect(gap.values.every(Number.isNaN)).toBe(true);
    const t=(iso:string)=>Date.parse(iso)/1000;
    expect(areConsecutiveFiveMinuteBars(t('2026-11-25T20:55:00Z'),t('2026-11-27T14:30:00Z'),true)).toBe(true);
    expect(areConsecutiveFiveMinuteBars(t('2026-11-27T17:55:00Z'),t('2026-11-30T14:30:00Z'),true)).toBe(true);
    expect(areConsecutiveFiveMinuteBars(t('2026-11-24T20:55:00Z'),t('2026-11-27T14:30:00Z'),true)).toBe(false);
    expect(resolveMtfWarmupFrom(one[0]?.time??0,true)).toBe(five[12]?.time);
    expect(nextFiveMinuteClose(t('2026-11-25T20:55:00Z'),true)).toBe(t('2026-11-27T14:35:00Z'));
    expect(nextFiveMinuteClose(t('2026-11-27T17:55:00Z'),true)).toBe(t('2026-11-30T14:35:00Z'));
    const missingOpen=five.filter(b=>b.time!==(one[0]?.time));
    expect(projectMtfEmaToLowerBarsPure(one,missingOpen,20,{evaluationTimeSec:scenario.evaluationTimeSec,rthOnly:true}).status).toBe('GAP');

  });
  it('keeps provisional metadata out of the real persistent series, even under extreme ticks and late confirmation',()=>{
    const c=fixture.mtf[0] as MtfScenario,one=c.bars1m.slice(0,6).map(decode),five=c.bars5m.map(decode);
    const projection=projectMtfEmaToLowerBarsPure(one,five,20,{evaluationTimeSec:c.evaluationTimeSec,rthOnly:true});
    const dto=serializeMtfEma(projection,one,{source:'CACHE_5M',acquisitionAttempted:false,adjustmentSignature:'A',sessionMode:'RTH'});
    const runtime=createMaChartRuntime(serializeMovingAverages(one),overrideMaPreset(resolveMaPresetForTimeframe('1m'),{mtfEma20:true}),dto,one);
    const update=vi.fn(),series={update} as unknown as Parameters<typeof runtime.paintMtf>[0];const legend={textContent:''};runtime.bindLegend(legend);
    const time=(one[5] as Bar).time;
    runtime.paintMtf(series,time,501);const first=legend.textContent;
    runtime.paintMtf(series,time,1e9);expect(legend.textContent).not.toBe(first);
    expect(update).not.toHaveBeenCalled();
    // A quote may reach 09:35 before the authoritative 09:34 closed snapshot.
    runtime.paintMtf(series,(one[5] as Bar).time,501);
    for(const bar of one.slice(0,5))runtime.observeMinute(undefined,bar,bar.time+60);
    runtime.paintMtf(series,(one[5] as Bar).time,501);
    const historical=update.mock.calls.find(call=>call[1]===true);
    expect(historical).toBeDefined();compare((historical?.[0] as {value:number}).value,c.liveConfirmed,'MTF_EMA20');
    const count=runtime.confirmedCount;runtime.observeMinute(undefined,one[4],(one[4] as Bar).time+60);runtime.paintMtf(series,(one[5] as Bar).time,502);expect(runtime.confirmedCount).toBe(count);
  });
  it('confirms 5m once from five authoritative closed 1m snapshots; provisional never chains',()=>{
    const scenario=fixture.mtf[0] as MtfScenario,one=scenario.bars1m.map(decode),five=scenario.bars5m.map(decode);
    const result=projectMtfEmaToLowerBarsPure(one,five,20,{evaluationTimeSec:one[0]?.time??0,rthOnly:true});
    const dto=serializeMtfEma(result,one,{source:'CACHE_5M',acquisitionAttempted:false,adjustmentSignature:'A',sessionMode:'RTH'});
    let state=createMtfLiveState(dto);const old=JSON.stringify(state);
    expect(projectMtfProvisional(state,502)).toBe(projectLiveEma(state.ema,502,20));expect(projectMtfProvisional(state,503)).toBe(projectLiveEma(state.ema,503,20));expect(JSON.stringify(state)).toBe(old);
    for(const b of one.slice(0,5))state=confirmMtfMinute(state,b,b.time+60);
    expect(state.count).toBe(result.confirmedCount+1);expect(state.ema).toBe(projectLiveEma(result.lastConfirmed,(one[4] as Bar).close,20));
    expect(confirmMtfMinute(state,one[4] as Bar,(one[4] as Bar).time+60)).toBe(state);
    expect(confirmMtfMinute(createMtfLiveState(dto),one[0] as Bar,(one[0] as Bar).time)).toEqual(createMtfLiveState(dto));
    let missing=createMtfLiveState(dto);missing=confirmMtfMinute(missing,one[0] as Bar,(one[0] as Bar).time+60);missing=confirmMtfMinute(missing,one[5] as Bar,(one[5] as Bar).time+60);expect(missing.gap).toBe(true);expect(projectMtfProvisional(missing,500)).toBeNaN();
  });
});
describe('S1-8 real chart controller, source ownership and performance contracts',()=>{
  it('replaces cumulative snapshots, confirms once, switches only algorithms and keeps NaN as whitespace',()=>{
    const rows=(fixture.cases[0] as Scenario).bars.map(decode),dto=serializeMovingAverages(rows,1100);
    const preset=overrideMaPreset(resolveMaPresetForTimeframe('1m'),{fastType:'VWMA'});
    const runtime=createMaChartRuntime(dto,preset,undefined,rows.slice(1100));const last=rows[rows.length-1] as Bar;
    const forming={timeSec:last.time,close:last.close,volume:last.volume};
    compare(runtime.project(forming)[0]??Number.NaN,(fixture.cases[0] as Scenario).expected.vwma9.at(-1)??null,'VWMA9');
    const count=runtime.confirmedCount;for(let i=0;i<1000;i+=1)runtime.project({...forming,volume:i});expect(runtime.confirmedCount).toBe(count);
    runtime.observeMinute(undefined,{...last,volume:123},last.time+60);runtime.confirm(forming);runtime.confirm(forming);expect(runtime.confirmedCount).toBe(count+1);
    const rebuilt=computeVwmaSeriesPure([...rows.slice(0,-1),{...last,volume:123},{...last,time:last.time+60,close:501,volume:456}],9).at(-1)??Number.NaN;
    expect(runtime.project({timeSec:last.time+60,close:501,volume:456})[0]).toBeCloseTo(rebuilt,10);
    runtime.configure(resolveMaPresetForTimeframe('1h'));const values=runtime.project({timeSec:last.time+60,close:501,volume:456});
    const closes=[...rows.slice(0,-1),{...last,volume:123},{...last,time:last.time+60,close:501,volume:456}].map(b=>b.close);
    expect(values[2]).toBeCloseTo(computeSmaSeries(closes,50).at(-1)??Number.NaN,9);expect(values[3]).toBeCloseTo(computeSmaSeries(closes,200).at(-1)??Number.NaN,9);
    const legend={textContent:''};runtime.bindMaLegend(legend);runtime.paintLegend(values);expect(legend.textContent).toContain('SMA 200');
    runtime.bindLegend(legend);runtime.paintMtf(undefined,last.time,500);expect(legend.textContent).toContain('—');
  });
  it('uses the existing native FMP single-flight cache across concurrency/toggles; expires and isolates identities',async()=>{
    const scenario=fixture.mtf[2] as MtfScenario;const source=scenario.bars5m.map(decode);let clock=scenario.evaluationTimeSec*1000;
    const native=vi.fn((request:{fromUtcSec?:number;toUtcSec?:number}):Promise<FmpHistoricalResult>=>Promise.resolve({bars:source.filter(b=>b.time>=(request.fromUtcSec??0)&&b.time<=(request.toUtcSec??Infinity)),source:'FMP_STABLE',endpoint:'HISTORICAL_CHART',requestedAtUtcSec:clock/1000,httpStatus:200,rows:source.length,discarded:0,legacyFallbackUsed:false,keyEnvName:'PRIMARY',fromUtcSec:request.fromUtcSec??null,toUtcSec:request.toUtcSec??null}));
    const owner=new UsHistoricalService({router:new MassiveKeyRouter({env:{},fileValues:new Map()}),fetchFn:()=>Promise.reject(new Error('wrong provider')),fmp:{fetchHistoricalPaginated:native},nowMs:()=>clock});
    const request={symbol:'MA_FIXTURE',firstVisible:(scenario.bars1m[0] as InputBar).time,now:scenario.evaluationTimeSec,rthOnly:true,provider:'FMP' as const,allowAcquisition:true};
    const none=await owner.resolveMtfFiveMinuteSource({...request,allowAcquisition:false});expect(none.source).toBe('UNAVAILABLE');expect(native).toHaveBeenCalledTimes(0);
    const [first,second]=await Promise.all([owner.resolveMtfFiveMinuteSource(request),owner.resolveMtfFiveMinuteSource(request)]);
    expect(first.bars).toEqual(second.bars);expect(native).toHaveBeenCalledTimes(1);
    expect((await owner.resolveMtfFiveMinuteSource(request)).source).toBe('CACHE_5M');expect(native).toHaveBeenCalledTimes(1);
    await owner.resolveMtfFiveMinuteSource({...request,symbol:'OTHER'});expect(native).toHaveBeenCalledTimes(2);
    await owner.resolveMtfFiveMinuteSource({...request,rthOnly:false});expect(native).toHaveBeenCalledTimes(3);
    clock+=900001;await owner.resolveMtfFiveMinuteSource(request);expect(native).toHaveBeenCalledTimes(4);
    owner.invalidate(request.symbol);await owner.resolveMtfFiveMinuteSource(request);expect(native).toHaveBeenCalledTimes(5);
  });
  it('reuses complete cached 1m intervals, rejects incomplete rollups and counts actual native Massive pages',async()=>{
    const scenario=fixture.mtf[2] as MtfScenario;
    const five=scenario.bars5m.map(decode);
    const minutes=five.flatMap(b=>Array.from({length:5},(_,i)=>({...b,time:b.time+i*60,volume:b.volume/5})));
    const makeOwner=(sparse=false)=>{
      const urls:string[]=[];
      const fetchFn=(url:string):Promise<FetchResponse>=>{
        urls.push(url);const target=new URL(url),parts=target.pathname.split('/');
        const size=Number(parts[6]),from=Number(parts[8])/1000,to=(Number(parts[9])+1)/1000;
        const rows=(size===1?minutes.filter((_,i)=>!sparse||i!==75):five).filter(b=>b.time>=from&&b.time+size*60<=to);
        const cursor=Number(target.searchParams.get('cursor')??0),width=size===5?150:50000,page=rows.slice(cursor,cursor+width);
        const next=new URL(target);next.searchParams.delete('apikey');next.searchParams.delete('apiKey');next.searchParams.set('cursor',String(cursor+width));
        return Promise.resolve({ok:true,status:200,text:JSON.stringify({adjusted:true,queryCount:page.length*size,
          results:page.map(b=>({t:b.time*1000,o:b.open,h:b.high,l:b.low,c:b.close,v:b.volume,vw:b.vw})),
          ...(cursor+width<rows.length?{next_url:next.toString()}:{} )})});
      };
      const owner=new UsHistoricalService({router:new MassiveKeyRouter({env:{MASSIVE_KEY_2:'FIXTURE_ONLY'},fileValues:new Map()}),fetchFn,
        fmp:{fetchHistoricalPaginated:()=>Promise.reject(new Error('unexpected fallback'))},nowMs:()=>scenario.evaluationTimeSec*1000});
      return {owner,urls};
    };
    const request={symbol:'MA_SOURCE',firstVisible:(scenario.bars1m[0] as InputBar).time,now:scenario.evaluationTimeSec,rthOnly:true,provider:'MASSIVE_REST' as const,allowAcquisition:true};
    const native=makeOwner();const [a,b]=await Promise.all([native.owner.resolveMtfFiveMinuteSource(request),native.owner.resolveMtfFiveMinuteSource(request)]);
    expect(a.bars).toEqual(b.bars);expect(a.requests+b.requests).toBe(native.urls.length);expect(a.pages+b.pages).toBe(native.urls.length);expect(native.urls).toHaveLength(3);
    const hot=await native.owner.resolveMtfFiveMinuteSource(request);expect(hot.source).toBe('CACHE_5M');expect(hot.requests).toBe(0);
    const complete=makeOwner();await complete.owner.load({symbol:request.symbol,timeframe:'1m',now:request.now,rthOnly:true,visibleBars:5000});const before=complete.urls.length;
    const rollup=await complete.owner.resolveMtfFiveMinuteSource(request);expect(rollup.source).toBe('EXACT_1M_ROLLUP');expect(complete.urls).toHaveLength(before);
    const sparse=makeOwner(true);await sparse.owner.load({symbol:request.symbol,timeframe:'1m',now:request.now,rthOnly:true,visibleBars:5000});
    const repaired=await sparse.owner.resolveMtfFiveMinuteSource(request);expect(repaired.source).toBe('ACQUIRED_5M');expect(repaired.requests).toBe(3);
    writeFileSync('.cache/pieza4-cache-metrics.json',JSON.stringify({logicalNativeAcquisitions:1,concurrentHttpRequests:native.urls.length,actualPages:a.pages+b.pages,hotRequests:hot.requests,exactRollupExtraRequests:complete.urls.length-before,incompleteRollupNativePages:repaired.pages},null,2)+'\n');
  });
  it('bounds ring reads independently of historical length and does not resynchronize on 10000 ticks',()=>{
    let state=createVwmaState(21);const rows=(fixture.cases[1] as Scenario).bars.map(decode);
    for(const bar of rows)state=advanceVwma(state,bar);
    let reads=0;
    const tracked=(object:object):object=>new Proxy(object,{get(target,key,receiver){reads+=1;const value:unknown=Reflect.get(target,key,receiver);return value!==null&&typeof value==='object'?tracked(value):value;}});
    const counted=tracked(state) as typeof state;const count=state.confirmedCount,resync=state.resyncCount;
    let maximum=0;for(let i=0;i<10000;i+=1){reads=0;projectLiveVwma(counted,80000.001,i);maximum=Math.max(maximum,reads);}
    expect(maximum).toBeLessThan(80);expect(state.confirmedCount).toBe(count);expect(state.resyncCount).toBe(resync);
    writeFileSync('.cache/pieza4-live-metrics.json',JSON.stringify({ticks:10000,maximumStateAndRingReadsPerTick:maximum,confirmedAdvancesDuringTicks:state.confirmedCount-count,resynchronizationsDuringTicks:state.resyncCount-resync},null,2)+'\n');
  });
  it('executes actual coalesced flush: two authoritative confirmations, cumulative replacement and no full writes',()=>{
    const source=readFileSync('web/src/components/StockDetailView.tsx','utf8'),ast=ts.createSourceFile('view.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let painter='',flush='';
    const visit=(node:ts.Node):void=>{if(ts.isVariableDeclaration(node)){if(node.name.getText(ast)==='paintFormingBar')painter=node.initializer?.getText(ast)??'';if(node.name.getText(ast)==='flushLiveTick')flush=node.initializer?.getText(ast)??'';}ts.forEachChild(node,visit);};visit(ast);
    const rows=(fixture.cases[0] as Scenario).bars.map(decode),dto=serializeMovingAverages(rows),last=rows.at(-1) as Bar;
    const runtime=createMaChartRuntime(dto,overrideMaPreset(resolveMaPresetForTimeframe('1m'),{fastType:'VWMA'}),undefined,rows);
    const update=vi.fn(),setData=vi.fn(()=>{throw new Error('forbidden');});
    const closed=fixture.coalesced.closed.map(decode),forming=decode(fixture.coalesced.forming);
    const events=[{kind:'minute',snapshot:{...(closed[1] as Bar),timeSec:(closed[1] as Bar).time,volume:100},canonicalClosed:closed[0],canonicalAsOf:(closed[1] as Bar).time},
      {kind:'minute',snapshot:{...forming,timeSec:forming.time},canonicalClosed:closed[1],canonicalAsOf:forming.time}];
    const context={tickRafIdRef:{current:1},pendingLiveEventsRef:{current:events},formingBarRef:{current:{...last,timeSec:last.time}},candleRef:{current:{update,setData}},
      canonicalMonthLiveRef:{current:null},canonicalCoverageRef:{current:null},emaRefs:{current:Array.from({length:5},()=>({update,setData}))},
      emaBaseBeforeFormingRef:{current:{9:null,21:null,50:null,200:null,maRuntime:runtime}},emaEndOfFormingRef:{current:{9:null,21:null,50:null,200:null,maRuntime:runtime}},timeframe:'1m'};
    const execute=runInNewContext(ts.transpileModule(`(()=>{const paintFormingBar=${painter};return ${flush};})()`,{compilerOptions:{target:ts.ScriptTarget.ES2023}}).outputText,context) as ()=>void;
    const before=runtime.confirmedCount;execute();expect(runtime.confirmedCount).toBe(before+2);expect(setData).not.toHaveBeenCalled();
    const actual=runtime.project({timeSec:forming.time,close:forming.close,volume:forming.volume});
    compare(actual[0]??Number.NaN,fixture.coalesced.expected['9']??null,'VWMA_provisional');compare(actual[1]??Number.NaN,fixture.coalesced.expected['21']??null,'VWMA_provisional');
    const history=runtime.fastHistory('VWMA');
    compare((history[0]?.at(-1) as {value:number}).value,fixture.coalesced.expected['9']??null,'VWMA9');
    expect(history[0]?.some(point=>point.time===(closed[1] as Bar).time)).toBe(true);
    runtime.configure(resolveMaPresetForTimeframe('1m'));
    const emaHistory=runtime.fastHistory('EMA');
    compare((emaHistory[0]?.at(-1) as {value:number}).value,fixture.coalesced.ema['9']??null,'EMA');
    compare((emaHistory[1]?.at(-1) as {value:number}).value,fixture.coalesced.ema['21']??null,'EMA');
    expect(history[0]?.length).toBeLessThanOrEqual(dto.times.length);

    execute();expect(runtime.confirmedCount).toBe(before+2);
    runtime.configure(overrideMaPreset(resolveMaPresetForTimeframe('1m'),{fastType:'VWMA'}));
    const correction=decode(fixture.coalesced.correction);expect(runtime.repairClosedRevision(correction)).not.toBeNull();
    expect(runtime.confirmedCount).toBe(before+2);expect(runtime.repairClosedRevision(correction)).toBeNull();
    const corrected=runtime.project({timeSec:forming.time,close:forming.close,volume:forming.volume});
    compare(corrected[0]??Number.NaN,fixture.coalesced.correctionExpected['9']??null,'VWMA9');
    compare(corrected[1]??Number.NaN,fixture.coalesced.correctionExpected['21']??null,'VWMA21');
  });
  it('executes the actual live painter with the new runtime, no setData or historical scan',()=>{
    const source=readFileSync('web/src/components/StockDetailView.tsx','utf8');const ast=ts.createSourceFile('view.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let painter='';
    const visit=(n:ts.Node):void=>{if(ts.isVariableDeclaration(n)&&n.name.getText(ast)==='paintFormingBar')painter=n.initializer?.getText(ast)??'';ts.forEachChild(n,visit);};visit(ast);expect(painter).not.toBe('');
    const rows=(fixture.cases[0] as Scenario).bars.map(decode),dto=serializeMovingAverages(rows),last=rows.at(-1) as Bar;
    const runtime=createMaChartRuntime(dto,overrideMaPreset(resolveMaPresetForTimeframe('1m'),{fastType:'VWMA'}),undefined,rows);
    const update=vi.fn(),setData=vi.fn(()=>{throw new Error('forbidden');});
    const refs={emaBaseBeforeFormingRef:{current:{9:null,21:null,50:null,200:null,maRuntime:runtime}},emaEndOfFormingRef:{current:{9:null,21:null,50:null,200:null,maRuntime:runtime}}};
    const paint=runInNewContext(ts.transpileModule(`(${painter})`,{compilerOptions:{target:ts.ScriptTarget.ES2023}}).outputText,{...refs,candleRef:{current:{update,setData}},emaRefs:{current:Array.from({length:5},()=>({update,setData}))},formingBarRef:{current:null},canonicalMonthLiveRef:{current:null},canonicalCoverageRef:{current:null},projectLiveEma}) as (a:{timeSec:number;close:number;volume:number},b:{timeSec:number;close:number;volume:number})=>void;
    const current={timeSec:last.time,close:last.close,volume:last.volume};const before=runtime.confirmedCount;
    for(let i=0;i<100;i+=1)paint({...current,volume:i},current);expect(runtime.confirmedCount).toBe(before);
    paint({...current,timeSec:current.timeSec+60},current);expect(runtime.confirmedCount).toBe(before+1);expect(setData).not.toHaveBeenCalled();
    expect(source.match(/if \(nextBar.timeSec > currentForming.timeSec\)/g)).toHaveLength(1);
    expect(source.match(/setOverlays\(/g)).toHaveLength(1);expect(source.match(/vwapRef.current\?\.setData\(/g)).toHaveLength(2);expect(source.match(/vwapRef.current\?\.update\(/g)??[]).toHaveLength(0);
    expect(source).not.toMatch(/localStorage|sessionStorage/);expect(source).toContain('}, [bundle, ticker, timeframe]);');
    let controls='';
    const findControls=(node:ts.Node):void=>{if(ts.isCallExpression(node)&&node.expression.getText(ast)==='useEffect'&&node.arguments[0]?.getText(ast).includes('runtime?.fastHistory'))controls=node.arguments[0].getText(ast);ts.forEachChild(node,findControls);};findControls(ast);
    expect(controls).not.toBe('');
    const slots=Array.from({length:5},()=>({setData:vi.fn(),update:vi.fn(),applyOptions:vi.fn()}));
    const emaPreset=resolveMaPresetForTimeframe('1m'),weightedPreset=overrideMaPreset(emaPreset,{fastType:'VWMA'}),bundle={movingAverages:dto,bars:rows,sessionVwapAvailable:true};
    const configure=runInNewContext(ts.transpileModule(`(${controls})`,{compilerOptions:{target:ts.ScriptTarget.ES2023}}).outputText,{...refs,maPreset:weightedPreset,mtfLegendRef:{current:null},maLegendRef:{current:null},
      lastMaConfigurationRef:{current:{bundle,fastType:'EMA',preset:emaPreset,master:true}},bundle,emaRefs:{current:slots},formingBarRef:{current},overlays:{emas:true,sessionVwap:true},vwapRef:{current:{applyOptions:vi.fn()}},timeframe:'1m'}) as ()=>void;
    configure();expect(slots[0]?.setData).toHaveBeenCalledTimes(1);expect(slots[1]?.setData).toHaveBeenCalledTimes(1);
    for(const slot of slots.slice(2)){expect(slot.setData).not.toHaveBeenCalled();expect(slot.update).not.toHaveBeenCalled();expect(slot.applyOptions).not.toHaveBeenCalled();}
  });
});
