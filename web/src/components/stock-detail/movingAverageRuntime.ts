/** Chart-owned controller. Statistical transitions remain in pure core functions. */
import type { ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import type { Bar } from '../../../../src/core/types.js';
import { advanceVwma,createVwmaState,vwmaValue,projectSeededEma,projectLiveVwma,createMtfLiveState,confirmMtfMinute,projectMtfProvisional,
  type FastMaType,type MaPreset,type MovingAveragesDto,type MtfEmaDto } from '../../../../src/core/movingAverages.js';
export interface MaChartRuntime {
  configure(preset:MaPreset):void;
  fastHistory(type:FastMaType):readonly (readonly ({time:UTCTimestamp;value:number}|{time:UTCTimestamp})[])[];
  observeMinute(forming:Bar|undefined,closed:Bar|null|undefined,asOf:number|undefined):void;
  confirm(bar:{timeSec:number;close:number;volume:number}):void;
  repairClosedRevision(bar:Bar):readonly number[]|null;
  project(bar:{timeSec:number;close:number;volume:number},fastOnly?:boolean):readonly number[];
  paintMtf(series:ISeriesApi<'Line'>|undefined,time:number,close:number):void;
  bindLegend(element:{textContent:string|null}|null):void;
  bindMaLegend(element:{textContent:string|null}|null):void;
  paintLegend(values:readonly number[]):void;
  readonly confirmedCount:number;
}
export function createMaChartRuntime(dto:MovingAveragesDto,preset:MaPreset,mtfDto:MtfEmaDto|undefined,bars:readonly Bar[]):MaChartRuntime {
  let configuration=preset;
  // This is the chart's bounded append/replacement buffer, not a provider cache.
  const liveFast=new Map<number,readonly [number,number,number,number]>();
  const capacity=Math.max(1,dto.times.length);
  const periods=[9,21,50,200] as const;
  let ema=periods.map((_,i)=>dto.emaBeforeLast[i]===null||dto.emaBeforeLast[i]===undefined?Number.NaN:dto.emaBeforeLast[i] as number);
  let vw9=createVwmaState(9),vw21=createVwmaState(21),sma50=createVwmaState(50),sma200=createVwmaState(200);
  for(const entry of dto.confirmedTail) {
    const bar={close:entry.close??Number.NaN,volume:entry.volume??Number.NaN};
    vw9=advanceVwma(vw9,bar);vw21=advanceVwma(vw21,bar);
    sma50=advanceVwma(sma50,{close:bar.close,volume:1});sma200=advanceVwma(sma200,{close:bar.close,volume:1});
  }
  let confirmedCount=Math.max(0,dto.calculationCount-1);
  let unit9=createVwmaState(9),unit21=createVwmaState(21);
  for(const bar of dto.confirmedTail){unit9=advanceVwma(unit9,{close:bar?.close??Number.NaN,volume:1});unit21=advanceVwma(unit21,{close:bar?.close??Number.NaN,volume:1});}
  let confirmedThrough=dto.confirmedThrough;
  let authoritative:Bar|null=null;
  const lastSeed=dto.confirmedTail[dto.confirmedTail.length-1];
  let lastConfirmedBar:Pick<Bar,'time'|'close'|'volume'>|undefined=lastSeed===undefined?undefined:{time:lastSeed.time,close:lastSeed.close??Number.NaN,volume:lastSeed.volume??Number.NaN};
  let invalidRevision=false;
  let beforeLast:{ema:typeof ema;vw9:typeof vw9;vw21:typeof vw21;sma50:typeof sma50;sma200:typeof sma200;unit9:typeof unit9;unit21:typeof unit21;
    confirmedCount:number;confirmedThrough:number|null;lastConfirmedBar:typeof lastConfirmedBar}|null=null;
  let mtf=createMtfLiveState(mtfDto);
  for(const bar of bars)mtf=confirmMtfMinute(mtf,bar,Math.min(bar.time+60,mtfDto?.evaluationTimeSec??Number.NEGATIVE_INFINITY));
  let pendingMtfTime:number|null=null;
  let beforeLastMtf:typeof mtf|null=null;
  let lastMtfClosingBar:Bar|null=null;
  let latestMtfTime=mtfDto?.times[mtfDto.times.length-1]??Number.NEGATIVE_INFINITY;
  let latestMtfValue=mtfDto?.values[mtfDto.values.length-1]??Number.NaN;
  let legend:{textContent:string|null}|null=null;
  let maLegend:{textContent:string|null}|null=null;
  let legendValues:readonly number[]=[];
  const writeLegend=():void=>{if(maLegend!==null)maLegend.textContent=periods.map((period,i)=>configuration.visible[i]===true?`${i<2?configuration.fastType:configuration.slowType} ${period} ${Number.isFinite(legendValues[i])?(legendValues[i] as number).toFixed(6):'—'}`:'').filter(Boolean).join(' · ');};
  const runtime:MaChartRuntime = {
    configure(next){configuration=next;writeLegend();},
    get confirmedCount(){return vw9.confirmedCount;},
    fastHistory(type){
      const indices=type==='EMA'?[0,1]:[2,3];
      const arrays=type==='EMA'?[dto.values.ema9,dto.values.ema21]:[dto.values.vwma9,dto.values.vwma21];
      return arrays.map((array,index)=>{
        const byTime=new Map<number,number>();
        dto.times.forEach((time,i)=>byTime.set(time,array[i]??Number.NaN));
        for(const [time,values] of liveFast)byTime.set(time,values[indices[index]??0]??Number.NaN);
        return [...byTime].sort(([a],[b])=>a-b).slice(-capacity).map(([time,value])=>Number.isFinite(value)?{time:time as UTCTimestamp,value}:{time:time as UTCTimestamp});
      });
    },
    bindLegend(element){legend=element;},
    bindMaLegend(element){maLegend=element;},
    paintLegend(values){legendValues=values.length===2?[values[0]??Number.NaN,values[1]??Number.NaN,legendValues[2]??Number.NaN,legendValues[3]??Number.NaN]:values;writeLegend();},
    observeMinute(_forming,closed,asOf){
      if(closed===undefined||closed===null)return;
      const old=mtf;
      mtf=confirmMtfMinute(mtf,closed,asOf??closed.time+60);
      if(mtf.confirmedThrough!==old.confirmedThrough&&mtf.confirmedThrough!==null){pendingMtfTime=mtf.confirmedThrough-60;beforeLastMtf=old;lastMtfClosingBar=closed;}
      if(confirmedThrough!==null&&closed.time<=confirmedThrough) {
        if(lastConfirmedBar?.time===closed.time&&(lastConfirmedBar.close!==closed.close||lastConfirmedBar.volume!==closed.volume))invalidRevision=true;
        return;
      }
      authoritative=closed;
    },
    confirm(previous){
      if(confirmedThrough!==null&&previous.timeSec<=confirmedThrough)return;
      beforeLast={ema,vw9,vw21,sma50,sma200,unit9,unit21,confirmedCount,confirmedThrough,lastConfirmedBar};
      const actual=authoritative?.time===previous.timeSec?authoritative:{...previous,time:previous.timeSec};
      // An arbitrary older correction requires a fresh historical bundle, outside the tick path.
      if(authoritative!==null&&confirmedThrough!==null&&authoritative.time<confirmedThrough)invalidRevision=true;
      ema=periods.map((period,i)=>projectSeededEma(ema[i]??Number.NaN,confirmedCount,[unit9,unit21,sma50,sma200][i]!,actual.close,period));
      unit9=advanceVwma(unit9,{close:actual.close,volume:1});unit21=advanceVwma(unit21,{close:actual.close,volume:1});
      confirmedCount+=1;
      vw9=advanceVwma(vw9,actual);vw21=advanceVwma(vw21,actual);
      sma50=advanceVwma(sma50,{close:actual.close,volume:1});sma200=advanceVwma(sma200,{close:actual.close,volume:1});
      confirmedThrough=previous.timeSec;lastConfirmedBar={time:previous.timeSec,close:actual.close,volume:actual.volume};authoritative=null;
    },
    // Called by the source subscription OUTSIDE flushLiveTick. Restore the immutable
    // prefix before the last confirmation, then replace that confirmation once.
    repairClosedRevision(bar){
      if(beforeLastMtf!==null&&lastMtfClosingBar?.time===bar.time&&lastMtfClosingBar.close!==bar.close) {
        mtf=confirmMtfMinute(beforeLastMtf,bar,bar.time+60);lastMtfClosingBar=bar;
        pendingMtfTime=bar.time;
      }
      if(beforeLast===null||lastConfirmedBar?.time!==bar.time||
         (lastConfirmedBar.close===bar.close&&lastConfirmedBar.volume===bar.volume))return null;
      const saved=beforeLast;
      ({ema,vw9,vw21,sma50,sma200,unit9,unit21,confirmedCount,confirmedThrough,lastConfirmedBar}=saved);
      authoritative=bar;invalidRevision=false;runtime.confirm({timeSec:bar.time,close:bar.close,volume:bar.volume});
      const weighted9=vwmaValue(vw9),weighted21=vwmaValue(vw21);
      liveFast.set(bar.time,[ema[0]??Number.NaN,ema[1]??Number.NaN,weighted9,weighted21]);
      return [configuration.fastType==='VWMA'?weighted9:ema[0]??Number.NaN,configuration.fastType==='VWMA'?weighted21:ema[1]??Number.NaN,
        configuration.slowType==='SMA'?vwmaValue(sma50):ema[2]??Number.NaN,configuration.slowType==='SMA'?vwmaValue(sma200):ema[3]??Number.NaN];
    },
    project(bar,fastOnly=false){
      if(invalidRevision)return [Number.NaN,Number.NaN,Number.NaN,Number.NaN];
      const values=(fastOnly?periods.slice(0,2):periods).map((period,i)=>projectSeededEma(ema[i]??Number.NaN,confirmedCount,[unit9,unit21,sma50,sma200][i]!,bar.close,period));
      const weighted9=projectLiveVwma(vw9,bar.close,bar.volume),weighted21=projectLiveVwma(vw21,bar.close,bar.volume);
      if(!fastOnly) {
        liveFast.set(bar.timeSec,[values[0]??Number.NaN,values[1]??Number.NaN,weighted9,weighted21]);
        if(liveFast.size>capacity){const oldest=liveFast.keys().next().value;if(oldest!==undefined)liveFast.delete(oldest);}
      }
      if(configuration.fastType==='VWMA') {values[0]=weighted9;values[1]=weighted21;}
      if(!fastOnly&&configuration.slowType==='SMA') {values[2]=projectLiveVwma(sma50,bar.close,1);values[3]=projectLiveVwma(sma200,bar.close,1);}
      return values;
    },
    paintMtf(series,time,close){
      const value=mtf.gap?Number.NaN:mtf.ema;
      if(series!==undefined) {
        if(pendingMtfTime!==null&&pendingMtfTime<=time) {
          series.update(Number.isFinite(value)?{time:pendingMtfTime as UTCTimestamp,value}:{time:pendingMtfTime as UTCTimestamp},pendingMtfTime<latestMtfTime);
          if(pendingMtfTime>=latestMtfTime)latestMtfValue=value;
          latestMtfTime=Math.max(latestMtfTime,pendingMtfTime);
        }
        if(time>latestMtfTime||(time===latestMtfTime&&!Object.is(value,latestMtfValue))) {
          series.update(Number.isFinite(value)?{time:time as UTCTimestamp,value}:{time:time as UTCTimestamp});latestMtfTime=time;latestMtfValue=value;
        }
      }
      pendingMtfTime=null;
      const provisional=projectMtfProvisional(mtf,close);
      if(legend!==null)legend.textContent=`5m EMA20 (prov) ${Number.isFinite(provisional)?provisional.toFixed(6):'—'}`;
    },
  };
  return runtime;
}
