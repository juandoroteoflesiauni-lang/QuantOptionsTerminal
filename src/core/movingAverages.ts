/** S1-8: pure MA contracts. All times are UTC opening seconds. */
import type { Bar } from './types.js';
import { calculateEma, projectLiveEma } from './ema.js';
import { computeSmaSeries } from './microstructure/mtfStructure.js';
import { usHistoricalSession } from './usHistorical.js';
import { resampleDailyToWeekly,getCalendarWeekMondayKey } from './resampleWeekly.js';

export type FastMaType = 'EMA' | 'VWMA';
export interface MaPreset {
  readonly fastType: FastMaType;
  readonly slowType: 'EMA' | 'SMA';
  readonly visible: readonly [boolean, boolean, boolean, boolean];
  readonly sessionVwap: boolean;
  readonly mtfEma20: boolean;
  readonly fastSelectable: boolean;
  readonly mtfAvailable: boolean;
}
export function resolveMaPresetForTimeframe(timeframe: string): MaPreset {
  const tf = timeframe === '1H' ? '1h' : timeframe;
  if (!['1m','5m','15m','1h','4h','1D','1W'].includes(tf)) throw new RangeError('Unsupported MA timeframe');
  return { fastType: 'EMA', slowType: ['1h','1D','1W'].includes(tf) ? 'SMA' : 'EMA',
    visible: tf === '1m' ? [true,true,false,false] : tf === '5m' ? [true,true,true,false] : [true,true,true,true],
    sessionVwap: tf === '1m' || tf === '5m', mtfEma20: false,
    fastSelectable: tf === '1m' || tf === '5m', mtfAvailable: tf === '1m' };
}
export function overrideMaPreset(preset: MaPreset, patch: Partial<Pick<MaPreset,'fastType'|'visible'|'sessionVwap'|'mtfEma20'>>): MaPreset {
  return { ...preset, ...patch, fastType: preset.fastSelectable ? patch.fastType ?? preset.fastType : 'EMA',
    mtfEma20: preset.mtfAvailable && (patch.mtfEma20 ?? preset.mtfEma20) };
}
interface Entry { readonly cv: number; readonly v: number; readonly invalid: boolean }
/** Persistent fixed-capacity indexed ring; a write copies only its bounded tree path. */
interface RingNode { readonly left?: RingNode; readonly right?: RingNode; readonly entry?: Entry }
export interface VwmaState {
  readonly period: number;
  readonly sumCV: number; readonly sumV: number;
  readonly compensationCV: number; readonly compensationV: number;
  readonly validCount: number; readonly invalidCount: number;
  readonly ringIndex: number; readonly confirmedCount: number;
  readonly size: number; readonly capacity: number;
  readonly ring: RingNode; readonly resyncCount: number;
}
function readRing(node: RingNode, index: number, capacity: number): Entry | undefined {
  if (capacity === 1) return node.entry;
  const half = capacity / 2;
  const child = index < half ? node.left : node.right;
  return child === undefined ? undefined : readRing(child,index < half ? index : index-half,half);
}
function writeRing(node: RingNode, index: number, capacity: number, entry: Entry): RingNode {
  if (capacity === 1) return { entry };
  const half = capacity / 2;
  return index < half ? { ...node,left:writeRing(node.left ?? {},index,half,entry) }
    : { ...node,right:writeRing(node.right ?? {},index-half,half,entry) };
}
function contribution(bar: Pick<Bar,'close'|'volume'>): Entry {
  const invalid = !Number.isFinite(bar.close) || !Number.isFinite(bar.volume) || bar.volume < 0 || !Number.isFinite(bar.close*bar.volume);
  return invalid ? { cv:0,v:0,invalid:true } : { cv:bar.close*bar.volume,v:bar.volume,invalid:false };
}
/** Neumaier summation, including removals. Binary sums remain approximate. */
function compensated(sum: number, correction: number, value: number): readonly [number,number] {
  const next = sum + value;
  return [next,correction + (Math.abs(sum) >= Math.abs(value) ? (sum-next)+value : (value-next)+sum)];
}
export function createVwmaState(period: number): VwmaState {
  if (![9,21,50,200].includes(period)) throw new RangeError('Unsupported fixed MA period');
  return { period,sumCV:0,sumV:0,compensationCV:0,compensationV:0,validCount:0,invalidCount:0,
    ringIndex:0,confirmedCount:0,size:0,capacity:2**Math.ceil(Math.log2(period)),ring:{},resyncCount:0 };
}
export function advanceVwma(state: VwmaState, bar: Pick<Bar,'close'|'volume'>): VwmaState {
  const old = readRing(state.ring,state.ringIndex,state.capacity);
  const entry = contribution(bar);
  let [sumCV,compensationCV] = compensated(state.sumCV,state.compensationCV,-(old?.cv ?? 0));
  [sumCV,compensationCV] = compensated(sumCV,compensationCV,entry.cv);
  let [sumV,compensationV] = compensated(state.sumV,state.compensationV,-(old?.v ?? 0));
  [sumV,compensationV] = compensated(sumV,compensationV,entry.v);
  const ring = writeRing(state.ring,state.ringIndex,state.capacity,entry);
  const confirmedCount = state.confirmedCount+1;
  const size = Math.min(state.size+1,state.period);
  let invalidCount = state.invalidCount - (old?.invalid === true ? 1 : 0) + (entry.invalid ? 1 : 0);
  const resync = state.period<=21 && confirmedCount % 512 === 0;
  const repair=![sumCV,compensationCV,sumV,compensationV].every(Number.isFinite);
  if (resync||repair) {
    sumCV=0;sumV=0;compensationCV=0;compensationV=0;invalidCount=0;
    for (let i=0;i<size;i+=1) {
      const item=readRing(ring,i,state.capacity);
      if (item === undefined) throw new Error('Incomplete MA ring');
      [sumCV,compensationCV]=compensated(sumCV,compensationCV,item.cv);
      [sumV,compensationV]=compensated(sumV,compensationV,item.v);
      if(item.invalid) invalidCount+=1;
    }
  }
  return { ...state,ring,sumCV,sumV,compensationCV,compensationV,size,invalidCount,
    validCount:size-invalidCount,ringIndex:(state.ringIndex+1)%state.period,confirmedCount,
    resyncCount:state.resyncCount+(resync?1:0) };
}
export function vwmaValue(state: VwmaState): number {
  const cv=state.sumCV+state.compensationCV;const v=state.sumV+state.compensationV;
  const result=cv/v;
  return state.size===state.period && state.invalidCount===0 && v>0 && Number.isFinite(cv) && Number.isFinite(v) && Number.isFinite(result) ? result : Number.NaN;
}
/** Replace only the provisional snapshot. Never advance or resynchronize confirmed state. */
export function projectLiveVwma(state: VwmaState, formingClose: number, formingVolume: number): number {
  if(state.size<state.period-1) return Number.NaN;
  const old=state.size===state.period ? readRing(state.ring,state.ringIndex,state.capacity) : undefined;
  const entry=contribution({close:formingClose,volume:formingVolume});
  if(entry.invalid || state.invalidCount-(old?.invalid===true?1:0)>0) return Number.NaN;
  let [cv,cc]=compensated(state.sumCV,state.compensationCV,-(old?.cv ?? 0));
  [cv,cc]=compensated(cv,cc,entry.cv);
  let [v,vc]=compensated(state.sumV,state.compensationV,-(old?.v ?? 0));
  [v,vc]=compensated(v,vc,entry.v);
  const numerator=cv+cc,denominator=v+vc,result=numerator/denominator;
  return denominator>0 && Number.isFinite(numerator) && Number.isFinite(denominator) && Number.isFinite(result) ? result : Number.NaN;
}
export function computeVwmaSeriesPure(bars: readonly Bar[], period: number): readonly number[] {
  if(period!==9 && period!==21) throw new RangeError('VWMA period must be 9 or 21');
  let state=createVwmaState(period);
  return bars.map(bar=>{state=advanceVwma(state,bar);return vwmaValue(state);});
}
export interface MaSeries {
  readonly ema9: readonly number[]; readonly ema21: readonly number[];
  readonly ema50: readonly number[]; readonly ema200: readonly number[];
  readonly sma50: readonly number[]; readonly sma200: readonly number[];
  readonly vwma9: readonly number[]; readonly vwma21: readonly number[];
}
export interface MovingAveragesDto {
  readonly times: readonly number[];
  readonly values: { readonly [K in keyof MaSeries]: readonly (number|null)[] };
  /** At most 200 actual observations BEFORE the last displayed bar. */
  readonly confirmedTail: readonly {readonly time:number;readonly close:number|null;readonly volume:number|null}[];
  readonly emaBeforeLast: readonly (number|null)[];
  readonly confirmedThrough: number|null;
  readonly calculationCount: number;
}
export function computeMaSeriesPure(bars: readonly Bar[]): MaSeries {
  const closes=bars.map(bar=>bar.close);
  return { ema9:calculateEma(closes,9),ema21:calculateEma(closes,21),ema50:calculateEma(closes,50),ema200:calculateEma(closes,200),
    sma50:computeSmaSeries(closes,50),sma200:computeSmaSeries(closes,200),vwma9:computeVwmaSeriesPure(bars,9),vwma21:computeVwmaSeriesPure(bars,21) };
}
const finite=(value:number|undefined):number|null=>value!==undefined&&Number.isFinite(value)?value:null;
export function serializeMovingAverages(bars: readonly Bar[],start=0,series:MaSeries=computeMaSeriesPure(bars)): MovingAveragesDto {
  const keys=['ema9','ema21','ema50','ema200','sma50','sma200','vwma9','vwma21'] as const;
  const values=Object.fromEntries(keys.map(key=>[key,series[key].slice(start).map(finite)])) as unknown as MovingAveragesDto['values'];
  return { times:bars.slice(start).map(bar=>bar.time),values,
    confirmedTail:bars.slice(Math.max(0,bars.length-201),Math.max(0,bars.length-1)).map(bar=>({time:bar.time,close:finite(bar.close),volume:finite(bar.volume)})),
    emaBeforeLast:[series.ema9,series.ema21,series.ema50,series.ema200].map(array=>finite(array[bars.length-2])),
    confirmedThrough:bars[bars.length-2]?.time ?? null,calculationCount:bars.length };
}
export interface MtfEmaProjection {
  readonly evaluationTimeSec:number|null;
  readonly values: readonly number[];
  readonly warmupBeforeFirst: number;
  readonly confirmedCount: number;
  readonly confirmedThrough: number|null;
  readonly lastConfirmed: number;
  readonly provisional: number;
  readonly status: 'CONFIRMED'|'INSUFFICIENT_WARMUP'|'GAP'|'UNAVAILABLE';
}
export interface MtfEmaDto {
  readonly evaluationTimeSec:number|null;
  readonly values: readonly (number|null)[];
  readonly times: readonly number[];
  readonly warmupBeforeFirst: number;
  readonly confirmedCount: number;
  readonly confirmedThrough: number|null;
  readonly lastConfirmed: number|null;
  readonly provisional: number|null;
  readonly status: MtfEmaProjection['status'];
  readonly source: 'CACHE_5M'|'EXACT_1M_ROLLUP'|'ACQUIRED_5M'|'UNAVAILABLE';
  readonly acquisitionAttempted: boolean;
  readonly adjustmentSignature: string;
  readonly sessionMode: 'RTH'|'EXTENDED';
}
/** Normalization is separate from the O(N+M) projection. Latest duplicate is a legitimate revision. */
export function normalizeMaBars(bars:readonly Bar[]): readonly Bar[] {
  const byTime=new Map<number,Bar>();
  for(const bar of bars) if(Number.isInteger(bar.time)&&Math.abs(bar.time)<100_000_000_000) byTime.set(bar.time,bar);
  return [...byTime.values()].sort((a,b)=>a.time-b.time);
}
export function areConsecutiveFiveMinuteBars(previous:number,next:number,rthOnly:boolean):boolean {
  if(next===previous+300) return true;
  const a=usHistoricalSession(previous),b=usHistoricalSession(next);
  if(a===null||b===null) return false;
  const end=rthOnly?a.close:a.extendedClose,start=rthOnly?b.open:b.extendedOpen;
  if(previous+300!==end||next!==start) return false;
  // A weekend/holiday is legitimate; an omitted entire trading session is not.
  for(let t=end+12*3600;t<start;t+=86400) {
    const s=usHistoricalSession(t);
    if(s!==null&&(rthOnly?s.open:s.extendedOpen)>end&&(rthOnly?s.open:s.extendedOpen)<start) return false;
  }
  return true;
}
export function projectMtfEmaToLowerBarsPure(bars1m:readonly Pick<Bar,'time'>[],bars5m:readonly Bar[],period=20,
  options:{readonly evaluationTimeSec?:number;readonly rthOnly?:boolean;readonly checkSessions?:boolean;readonly forming5mClose?:number}={}):MtfEmaProjection {
  const evalTime=options.evaluationTimeSec ?? bars1m[bars1m.length-1]?.time ?? Number.NEGATIVE_INFINITY;
  // Future observations are excluded before seeding EMA (future NaNs cannot poison history).
  const closed=bars5m.filter(bar=>bar.time+300<=evalTime);
  const emas=calculateEma(closed.map(bar=>bar.close),period);
  let pointer=0,gap=false,warmupBeforeFirst=0;
  const first=bars1m[0]?.time;
  if(first!==undefined) for(const bar of closed) {if(bar.time+300<=Math.min(first,evalTime)) warmupBeforeFirst+=1;else break;}
  let prev:number|undefined;
  let expectedNextClose=Number.POSITIVE_INFINITY;
  const values:number[]=[];
  for(const bar of bars1m) {
    const cutoff=Math.min(bar.time+60,evalTime);
    while(pointer<closed.length) {
      const candidate=closed[pointer];if(candidate===undefined||candidate.time+300>cutoff) break;
      if(prev!==undefined && !(options.checkSessions===false ? candidate.time===prev+300 : areConsecutiveFiveMinuteBars(prev,candidate.time,options.rthOnly===true))) gap=true;
      prev=candidate.time;pointer+=1;
      expectedNextClose=options.checkSessions===false?prev+600:nextFiveMinuteClose(prev,options.rthOnly===true);
    }
    // A missing first bucket after an overnight/session gap is missing too.
    if(prev!==undefined&&(!Number.isFinite(expectedNextClose)||expectedNextClose<=cutoff))gap=true;
    values.push(!gap&&pointer>=250 ? emas[pointer-1] ?? Number.NaN : Number.NaN);
  }
  const lastConfirmed=!gap&&pointer>=250 ? emas[pointer-1] ?? Number.NaN : Number.NaN;
  const provisional=options.forming5mClose===undefined ? Number.NaN : projectLiveEma(lastConfirmed,options.forming5mClose,period);
  return {evaluationTimeSec:Number.isFinite(evalTime)?evalTime:null,values,warmupBeforeFirst,confirmedCount:pointer,confirmedThrough:closed[pointer-1]===undefined?null:(closed[pointer-1]?.time ?? 0)+300,
    lastConfirmed,provisional,status:gap?'GAP':pointer===0?'UNAVAILABLE':warmupBeforeFirst<250?'INSUFFICIENT_WARMUP':!Number.isFinite(lastConfirmed)?'UNAVAILABLE':'CONFIRMED'};
}
export function serializeMtfEma(projection:MtfEmaProjection,bars1m:readonly Bar[],context:Pick<MtfEmaDto,'source'|'acquisitionAttempted'|'adjustmentSignature'|'sessionMode'>):MtfEmaDto {
  return {...context,evaluationTimeSec:projection.evaluationTimeSec,values:projection.values.map(finite),times:bars1m.map(bar=>bar.time),warmupBeforeFirst:projection.warmupBeforeFirst,
    confirmedCount:projection.confirmedCount,confirmedThrough:projection.confirmedThrough,lastConfirmed:finite(projection.lastConfirmed),provisional:finite(projection.provisional),status:projection.status};
}

/** Actual eligible 5m intervals before the first visible opening, target 300. */
export function resolveMtfWarmupFrom(firstVisible:number,rthOnly:boolean,target=300):number {
  let count=0;
  for(let day=0;day<60;day+=1) {
    const session=usHistoricalSession(firstVisible-day*86400);if(session===null) continue;
    const open=rthOnly?session.open:session.extendedOpen,close=rthOnly?session.close:session.extendedClose;
    for(let time=Math.min(close,Math.floor(firstVisible/300)*300)-300;time>=open;time-=300) {
      count+=1;if(count>=target)return time;
    }
  }
  throw new Error('MTF_WARMUP_OUT_OF_COVERAGE');
}

export interface MtfLiveState {
  readonly ema:number;readonly confirmedThrough:number|null;readonly count:number;
  readonly bucket:number|null;readonly seenMask:number;readonly close:number;
  readonly lastMinute:number|null;readonly gap:boolean;readonly rthOnly:boolean;
}
export function createMtfLiveState(dto:MtfEmaDto|undefined):MtfLiveState {
  return {ema:dto?.lastConfirmed===null||dto?.lastConfirmed===undefined?Number.NaN:dto.lastConfirmed,
    confirmedThrough:dto?.confirmedThrough??null,count:dto?.confirmedCount??0,bucket:null,seenMask:0,close:Number.NaN,
    lastMinute:null,gap:dto?.status!=='CONFIRMED',rthOnly:dto?.sessionMode==='RTH'};
}
/** Authoritative CLOSED minute snapshots only; five observed slots prove completeness. */
export function confirmMtfMinute(state:MtfLiveState,bar:Bar,evaluationTimeSec:number):MtfLiveState {
  if(bar.time+60>evaluationTimeSec||bar.time<(state.confirmedThrough??Number.POSITIVE_INFINITY)||state.gap)return state;
  const bucket=Math.floor(bar.time/300)*300,offset=(bar.time-bucket)/60;
  if(!Number.isInteger(offset)||offset<0||offset>4)return {...state,gap:true};
  if(state.bucket!==null&&bucket<state.bucket)return state;
  if(state.bucket!==null&&bucket>state.bucket&&state.seenMask!==0)return {...state,gap:true};
  if(state.bucket!==bucket&&state.confirmedThrough!==null&&bucket!==state.confirmedThrough&&
     !areConsecutiveFiveMinuteBars(state.confirmedThrough-300,bucket,state.rthOnly))return {...state,gap:true};
  const mask=(state.bucket===bucket?state.seenMask:0)|(1<<offset);
  const close=state.lastMinute===null||bar.time>=state.lastMinute?bar.close:state.close;
  if(!Number.isFinite(close))return {...state,gap:true};
  if(mask===31) {
    const ema=projectLiveEma(state.ema,close,20);
    return {...state,ema,count:state.count+1,confirmedThrough:bucket+300,bucket:null,seenMask:0,close:Number.NaN,lastMinute:null,gap:!Number.isFinite(ema)};
  }
  return {...state,bucket,seenMask:mask,close,lastMinute:Math.max(state.lastMinute??bar.time,bar.time)};
}
export function projectMtfProvisional(state:MtfLiveState,close:number):number {
  return state.gap?Number.NaN:projectLiveEma(state.ema,close,20);
}

/** Resample the calculation buffer BEFORE trimming; the viewport cannot reseed weekly SMA. */
export function serializeWeeklyMovingAverages(dailyBars:readonly Bar[],visibleFrom:number,timeZone:string):{readonly bars:readonly Bar[];readonly movingAverages:MovingAveragesDto} {
  const weeks=resampleDailyToWeekly(dailyBars,timeZone);
  const firstWeek=getCalendarWeekMondayKey(visibleFrom,timeZone);
  const index=weeks.findIndex(bar=>getCalendarWeekMondayKey(bar.time,timeZone)===firstWeek);
  const start=index<0?weeks.length:index;
  return {bars:weeks.slice(start),movingAverages:serializeMovingAverages(weeks,start)};
}
/** Live EMA seed must obey the historical SMA-seed convention at n observations. */
export function projectSeededEma(last:number,confirmedCount:number,unitVolumeWindow:VwmaState,close:number,period:number):number {
  return confirmedCount===period-1?projectLiveVwma(unitVolumeWindow,close,1):projectLiveEma(last,close,period);
}

/** Close of the next eligible 5m session interval; never fill a missing opening bucket. */
export function nextFiveMinuteClose(previous:number,rthOnly:boolean):number {
  const session=usHistoricalSession(previous);
  if(session===null)return Number.NaN;
  const start=rthOnly?session.open:session.extendedOpen,end=rthOnly?session.close:session.extendedClose;
  if(previous<start||previous+300>end||(previous-start)%300!==0)return Number.NaN;
  if(previous+300<end)return previous+600;
  for(let day=1;day<=10;day+=1) {
    const next=usHistoricalSession(previous+day*86400);
    if(next!==null)return (rthOnly?next.open:next.extendedOpen)+300;
  }
  return Number.NaN;
}
