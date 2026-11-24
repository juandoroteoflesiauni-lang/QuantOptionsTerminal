import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { resolveAdaptiveVisibleBars, restHistoricalFromUtcSec, type HistoricalSessionMode } from '../src/data/restHistoricalWindow.js';
import type { Timeframe } from '../src/data/types.js';
import { planUsHistorical, planUsFmpHistorical, usHistoricalMtdSessions, type UsHistoricalTimeframe, type UsSession } from '../src/core/usHistorical.js';
import { planFmpIntradayDateWindows, mergeFmpPaginatedBars, type FmpDateWindow } from '../src/core/ggal/fmpPagination.js';
import { MarketRuntime } from '../src/server/marketRuntime.js';
import { FmpEnterpriseClient, resolveFmpConfig } from '../src/server/fmpClient.js';
import type { Bar } from '../src/core/types.js';
import { UsHistoricalService } from '../src/server/usHistoricalService.js';
import { MassiveKeyRouter } from '../src/server/massiveKeyPool.js';

interface PlanCase { tf: UsHistoricalTimeframe; now: number; rth: boolean; mtd: number; nominal: number; historyFrom: number; requiredBars: number; visibleFrom?: number; expectedVisibleBars?: number; fmpFrom: number; fmpRequired: number }
const reference = JSON.parse(readFileSync('fixtures/subfase1_pieza1_reference.json', 'utf8')) as {
  matrix: { tf: Timeframe; mode: HistoricalSessionMode; mtd: number | string | null; expected: number | null }[];
  plans: PlanCase[];
  pagination: { tf: Timeframe; rth: boolean; fromUtcSec: number; toUtcSec: number; before: FmpDateWindow[]; after: FmpDateWindow[] }[];
};
const calendar = JSON.parse(readFileSync('fixtures/pieza0b_massive_rest_reference.json', 'utf8')) as { calendar: { session: UsSession | null }[] };
const sessions = calendar.calendar.flatMap((c) => c.session === null ? [] : [c.session]);

function minuteBars(from: number, to: number, sparse: boolean): Bar[] {
  return sessions.flatMap((s) => {
    if (s.extendedClose <= from || s.extendedOpen >= to) return [];
    const out: Bar[] = [];
    for (let t = Math.max(from, s.extendedOpen); t + 60 <= Math.min(to, s.extendedClose); t += 60) {
      if (!sparse || t % 180 === 0) out.push({ time: t, open: 100, high: 102, low: 99, close: 101, volume: 10, vw: 100.5 });
    }
    return out;
  });
}

describe('Pieza 1 — adaptive nominal budgets and effective session coverage (Python)', () => {
  it('matches the complete matrix, including absent/invalid MTD and unsupported legacy TF', () => {
    for (const c of reference.matrix) {
      const value = c.mtd === null ? undefined : typeof c.mtd === 'string' ? Number.NaN : c.mtd;
      const actual = resolveAdaptiveVisibleBars(c.tf, c.mode, value);
      if (c.expected === null) expect(actual).toBeNaN(); else expect(actual).toBe(c.expected);
    }
  });

  it('enumerates ET sessions across holidays, early close, DST and month boundaries without nominal padding', () => {
    for (const c of reference.plans) {
      expect(usHistoricalMtdSessions(c.now)).toBe(c.mtd);
      const actual = planUsHistorical(c.tf, c.now, c.rth, undefined, true);
      expect(actual.visibleBars).toBe(c.nominal);
      expect(actual.historyFrom).toBe(c.historyFrom);
      expect(actual.requiredBars).toBe(c.requiredBars);
      expect(actual.visibleFrom).toBe(c.visibleFrom);
      expect(actual.expectedVisibleBars).toBe(c.expectedVisibleBars);
      expect(actual.warmupBars).toBe(1000);
      const native = planUsFmpHistorical(c.tf, c.now, c.rth, c.nominal, actual.historyFrom);
      expect(native.historyFrom).toBe(c.fmpFrom);
      expect(native.requiredBars).toBe(c.fmpRequired);
      expect(native.historyFrom).toBeLessThanOrEqual(restHistoricalFromUtcSec({ toUtcSec: c.now, provider: 'FMP_ENTERPRISE_REST', timeframe: c.tf, includeExtended: !c.rth, targetBars: c.nominal+1000 }));
    }
    expect(() => usHistoricalMtdSessions(Date.parse('2019-12-31T17:00:00Z')/1000)).toThrow(/OUT_OF_COVERAGE/);
  });

  it('keeps explicit 1000 and 60 independent of adaptive defaults, with one warm-up', () => {
    const c = reference.plans.find((p) => p.tf === '1h' && p.rth) as PlanCase;
    expect(planUsHistorical('1h', c.now, true, 60).requiredBars).toBe(1060);
    for (const tf of ['1m','5m','15m','1h'] as const) {
      expect(planUsFmpHistorical(tf,c.now,false,1000).requiredBars).toBe(2000);
    }
  });

  it('hydrates exactly the effective early-close window, preserves explicit/cache identities and reports sparse warm-up', async () => {
    const c = reference.plans.find((p) => p.tf === '1m' && p.rth && p.now === Date.parse('2025-11-28T23:00:00Z')/1000) as PlanCase;
    expect(c).toBeDefined();
    const stats: unknown[] = [];
    for (const sparse of [false,true]) {
      let calls = 0;
      const runtime = new MarketRuntime({ apiKey: '', massiveEnv: { MASSIVE_KEY_2: 'SYNTH_P1' }, enableWs: false,
        fmpConfig: resolveFmpConfig({}), nowMsFn: () => c.now*1000,
        fetchFn: (url) => {
          calls += 1;
          const parts = new URL(url).pathname.split('/');
          const from = Number(parts[8])/1000; const to = (Number(parts[9])+1)/1000;
          const rows = url.includes('/range/1/minute/') ? minuteBars(from,to,sparse) : [];
          return Promise.resolve({ ok: true, status: 200, text: JSON.stringify({ status:'OK', adjusted:true, queryCount:rows.length,
            results: rows.map((b) => ({t:b.time*1000,o:b.open,h:b.high,l:b.low,c:b.close,v:b.volume,vw:b.vw})) }) });
        } });
      try {
        const start = performance.now();
        const cold = await runtime.getBars('SYN','1m',{rthOnly:true,includeOverlays:false});
        const coldMs = performance.now()-start; const before = calls;
        const hot = await runtime.getBars('SYN','1m',{rthOnly:true,includeOverlays:false});
        expect(hot).toBe(cold); expect(calls).toBe(before);
        expect(cold.bars.length).toBeLessThan(c.nominal);
        expect(cold.bars.every((b) => b.time >= (c.visibleFrom as number))).toBe(true);
        expect(cold.historicalIntegrity?.plan.expectedVisibleBars).toBe(c.expectedVisibleBars);
        expect(cold.historicalIntegrity?.warmupSatisfied).toBe(!sparse);
        const explicit = await runtime.getBars('SYN','1m',{visibleBars:1000,rthOnly:true,includeOverlays:false});
        expect(explicit.bars).toHaveLength(1000);
        expect(explicit.historicalIntegrity?.plan.visibleFrom).toBeUndefined();
        stats.push({ kind:'HTTP_MOCK_NOT_PROVIDER', sparse, coldMs, calls, visible:cold.bars.length, nominal:c.nominal, expected:c.expectedVisibleBars, cold:cold.historicalIntegrity?.metrics });
      } finally { runtime.stopWs(); }
    }
    mkdirSync('.cache',{recursive:true}); writeFileSync('.cache/pieza1-adaptive-metrics.json',JSON.stringify(stats,null,2));
  });

  it('keeps the native daily endpoint and 1250 rows without extending the intraday calendar', async () => {
    const now = Date.parse('2024-03-11T22:00:00Z')/1000;
    let earliest = now;
    const runtime = new MarketRuntime({ apiKey:'', massiveEnv:{}, enableWs:false, fmpConfig:resolveFmpConfig({FMP_API_KEY:'SYNTH_P1_DAILY'}), nowMsFn:()=>now*1000,
      fetchFn:(url)=>{
        const parsed = new URL(url); const from = parsed.searchParams.get('from');
        if (from !== null) earliest = Math.min(earliest,Date.parse(from+'T00:00:00Z')/1000);
        const rows = Array.from({length:2250},(_,i)=>({date:new Date((now-(2250-i)*86400)*1000).toISOString().slice(0,10),open:100,high:102,low:99,close:101,volume:10}));
        return Promise.resolve({ok:true,status:200,text:JSON.stringify(rows)});
      } });
    try {
      const result = await runtime.getBars('SYN','1D',{includeOverlays:false});
      expect(result.bars).toHaveLength(1250); expect(earliest).toBeLessThan(Date.parse('2020-01-01T00:00:00Z')/1000);
    } finally { runtime.stopWs(); }
  });

  it('preserves adaptive session bounds, native floor and hot cache both directly in FMP and after Massive failure', async()=>{
    const c=reference.plans.find((p)=>p.tf==='1m'&&p.rth&&p.now===Date.parse('2025-11-28T23:00:00Z')/1000) as PlanCase;
    for(const active of [false,true]) {
      let calls=0;
      const service=new UsHistoricalService({router:new MassiveKeyRouter({env:active?{MASSIVE_KEY_2:'SYNTH_P1_FALLBACK'}:{},fileValues:new Map()}),
        nowMs:()=>c.now*1000,fetchFn:()=>Promise.resolve({ok:false,status:404,text:'{}'}),
        fmp:{fetchHistoricalPaginated:(req)=>{
          calls+=1;expect(req.fromUtcSec).toBe(c.fmpFrom);
          return Promise.resolve({bars:minuteBars(req.fromUtcSec as number,c.now,false),source:'FMP_STABLE',endpoint:'HISTORICAL_CHART',requestedAtUtcSec:c.now,httpStatus:200,rows:1,discarded:0,legacyFallbackUsed:false,keyEnvName:'MARKET',fromUtcSec:req.fromUtcSec as number,toUtcSec:c.now});
        }} });
      const request={symbol:'SYN',timeframe:'1m' as const,rthOnly:true,now:c.now,visibleBars:c.nominal,adaptiveWindow:true};
      const cold=await service.load(request);const hot=await service.load(request);
      expect(cold.plan.historicalProvider).toBe('FMP');expect(cold.plan.visibleFrom).toBe(c.visibleFrom);
      expect(cold.plan.requiredBars).toBe(c.nominal+1000);expect(cold.warmupSatisfied).toBe(true);
      expect(cold.rows.filter((r)=>r.bar.time>=(c.visibleFrom as number))).toHaveLength(c.expectedVisibleBars as number);
      expect(hot.rows).toEqual(cold.rows);expect(calls).toBe(1);
    }
  });

  it('proves 14/28-day pages preserve the union, seam deduplication and native floor while reducing calls', async () => {
    const stats: unknown[] = [];
    for (const c of reference.pagination) {
      const input = {fromUtcSec:c.fromUtcSec,toUtcSec:c.toUtcSec,timeframe:c.tf};
      // Candidate measured through the existing override; defaults stay sealed
      // by Pieza 44's exact pagination fixture (no legacy expectations changed).
      expect(planFmpIntradayDateWindows(input)).toEqual(c.before);
      expect(planFmpIntradayDateWindows({...input,windowDaysOverride:c.tf==='5m'?14:28})).toEqual(c.after);
      const rows: Bar[] = [];
      const minutes = c.tf==='5m'?5:15;
      for (const s of sessions) {
        for (let t=c.rth?s.open:s.extendedOpen;t<(c.rth?s.close:s.extendedClose);t+=minutes*60) {
          if (t>=c.fromUtcSec && t<=c.toUtcSec) rows.push({time:t,open:100,high:102,low:99,close:101,volume:10});
        }
      }
      const transport = (windows: FmpDateWindow[]) => windows.map((w)=>rows.filter((b)=>b.time>=w.fromUtcSec && b.time<=w.toUtcSec));
      const oldPages=transport(c.before); const newPages=transport(c.after);
      expect(newPages.every((p)=>p.length<5000)).toBe(true);
      expect(mergeFmpPaginatedBars(newPages,input)).toEqual(mergeFmpPaginatedBars(oldPages,input));
      expect(mergeFmpPaginatedBars(newPages,input)).toEqual(rows);
      expect(c.after.length).toBeLessThan(c.before.length);
      const byDay=new Map(sessions.map((s)=>[Math.floor((s.extendedOpen-4*3600)/86400),s]));
      const wire=rows.map((b)=>{
        const s=byDay.get(Math.floor((b.time-4*3600)/86400));
        if(s===undefined) throw new Error('Missing independent session');
        const minute=240+(b.time-s.extendedOpen)/60;
        return {...b,date:`${s.dateKey} ${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}:00`};
      });
      const measured:number[]=[];
      for(const days of [c.tf==='5m'?7:14,c.tf==='5m'?14:28]) {
        let calls=0;
        const client=new FmpEnterpriseClient({config:resolveFmpConfig({FMP_API_KEY:'SYNTH_P1_PAGE'}),nowMsFn:()=>c.toUtcSec*1000,
          fetchFn:(url)=>{
            calls+=1;const parsed=new URL(url);const from=parsed.searchParams.get('from');const to=parsed.searchParams.get('to');
            if(from===null||to===null) throw new Error('Native range omitted');
            const page=wire.filter((b)=>b.date.slice(0,10)>=from&&b.date.slice(0,10)<=to).slice(0,5000);
            return Promise.resolve({ok:true,status:200,text:JSON.stringify(page)});
          }});
        const result=await client.fetchHistoricalPaginated({symbol:'SYN',timeframe:c.tf,includeExtended:!c.rth,fromUtcSec:c.fromUtcSec,toUtcSec:c.toUtcSec,windowDaysOverride:days});
        expect(result.bars).toEqual(rows);measured.push(calls);
      }
      expect(measured).toEqual([c.before.length,c.after.length]);
      stats.push({kind:'OFFLINE_FMP_CLIENT_HTTP_MOCK',candidateApplied:false,reason:'LEGACY_EXACT_PAGINATION',tf:c.tf,rth:c.rth,before:measured[0],after:measured[1],rows:rows.length,from:c.fromUtcSec,to:c.toUtcSec,maxPage:Math.max(...newPages.map((p)=>p.length))});
    }
    mkdirSync('.cache',{recursive:true}); writeFileSync('.cache/pieza1-fmp-pagination-metrics.json',JSON.stringify(stats,null,2));
  });
});
