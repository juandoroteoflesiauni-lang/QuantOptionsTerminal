import { resolveMtfWarmupFrom, projectMtfEmaToLowerBarsPure, normalizeMaBars, type MtfEmaDto } from '../core/movingAverages.js';
import { enumerateRecentUsSessions } from '../core/microstructure/multiHorizonVolumeProfile.js';
import type { Bar } from '../core/types.js';
import { historicalMomentsSince, historicalObservation, mergeHistoricalSegments, planUsHistorical, planUsFmpHistorical, rollupUsHistorical, usHistoricalSession, type HistoricalObservation, type HistoricalPlan, type UsHistoricalTimeframe } from '../core/usHistorical.js';
import { normalizeMassiveAggs } from '../data/normalizeMassive.js';
import type { FetchResponse } from '../data/types.js';
import type { FmpEnterpriseClient, FmpHistoricalRequest, FmpHistoricalResult } from './fmpClient.js';
import { mergeFmpPaginatedBars } from '../core/ggal/fmpPagination.js';
import type { MassiveKeyRouter } from './massiveKeyPool.js';

export interface HistoricalMetrics {
  readonly requests: number;
  readonly pages: number;
  readonly downloadedBars: number;
  readonly baseAggregates: number | null;
  readonly bytes: number;
  readonly latencyMs: number;
  readonly cacheHit: boolean;
  readonly cacheRows: number;
  readonly fallbackCause: string | null;
  readonly fmpRequests: number;
  readonly massiveRequests: number;
  readonly peakCacheRows: number;
}
export interface UsHistoricalResult {
  readonly rows: readonly HistoricalObservation[];
  readonly canonicalMonth: readonly HistoricalObservation[];
  /** Original source intervals for causal session extrema; no extra requests or retained cache. */
  readonly sessionSources?: readonly HistoricalObservation[];
  readonly plan: HistoricalPlan;
  readonly warmupSatisfied: boolean;
  readonly metrics: HistoricalMetrics;
  readonly coverage: {
    readonly requestedFrom: number;
    readonly firstTime: number | null;
    readonly lastEndExclusive: number | null;
    readonly receivedBars: number;
    readonly canonicalPrefix: 'OBSERVED_1M' | 'MISSING_1M';
    readonly adjustment: 'SPLIT_ADJUSTED' | 'FMP_NATIVE_UNVERIFIED';
  };
}
interface Request {
  readonly symbol: string;
  readonly timeframe: UsHistoricalTimeframe;
  readonly now: number;
  readonly rthOnly: boolean;
  readonly visibleBars?: number;
  readonly adaptiveWindow?: boolean;
  readonly signal?: AbortSignal;
}
interface CacheEntry {
  readonly from: number;
  readonly to: number;
  readonly at: number;
  readonly prefixAt: number;
  readonly rows: readonly HistoricalObservation[];
  readonly nativeMetadata?: FmpHistoricalResult;
}
interface Flight {
  readonly controller: AbortController;
  readonly promise: Promise<UsHistoricalResult>;
  users: number;
}
type Counters = { requests: number; pages: number; downloadedBars: number; baseAggregates: number | null; bytes: number };

/** Compact JSON-safe transport: preserve per-bar moments without resending 1m history. */
export function serializeHistoricalIntegrity(result: UsHistoricalResult, visibleFrom: number) {
  const finite = (value: number): number | null => Number.isFinite(value) ? value : null;
  const encodeMoments = (moments: HistoricalObservation['moments']) => ({ PV: finite(moments.PV), V: finite(moments.V), P2V: finite(moments.P2V) });
  const real = result.rows.some((row) => row.realVwBars > 0);
  const proxy = result.rows.some((row) => row.proxyBars > 0);
  return {
    historicalProvider: result.plan.historicalProvider,
    priceSource: real && proxy ? 'MIXED_VW_HLC3' : real ? 'REAL_VW' : 'HLC3_PROXY',
    plan: result.plan, coverage: result.coverage, warmupSatisfied: result.warmupSatisfied, metrics: result.metrics,
    secondMomentMeaning: 'SOURCE_BAR_PRICES_NOT_INDIVIDUAL_TRADES',
    monthSeed: encodeMoments(historicalMomentsSince(result.canonicalMonth, result.plan.monthAnchor, visibleFrom)),
    monthMoments: encodeMoments(historicalMomentsSince(result.canonicalMonth, result.plan.monthAnchor, Number.MAX_SAFE_INTEGER)),
    observations: result.rows.filter((row) => row.bar.time >= visibleFrom).map((row) => ({ time: row.bar.time, endExclusive: row.endExclusive,
      historicalProvider: row.historicalProvider, priceSource: row.priceSource, sourceMinutes: row.sourceMinutes, quality: row.quality, adjustment: row.adjustment, moments: encodeMoments(row.moments) })),
  };
}

/** Bounded, shared 1m storage. No indicator/render code owns this cache. */
export class UsHistoricalService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly flights = new Map<string, Flight>();
  private readonly segmentFlights = new Map<string, Promise<readonly HistoricalObservation[]>>();
  private readonly fmpFlights = new Map<string, Promise<FmpHistoricalResult>>();
  private peakCacheRows = 0;
  private canonicalRevision = 0;
  private readonly canonicalRevisions = new Map<string,number>();
  /** Metadata generation owned by the existing historical cache, not another cache. */
  public adjustmentRevision(symbol:string): number {
    const current=this.canonicalRevisions.get(symbol);
    if(current!==undefined) return current;
    return this.nextCanonicalRevision(symbol);
  }

  private nextCanonicalRevision(symbol:string):number {
    this.canonicalRevision += 1;
    this.canonicalRevisions.delete(symbol);this.canonicalRevisions.set(symbol,this.canonicalRevision);
    while(this.canonicalRevisions.size>16) {
      const oldest=this.canonicalRevisions.keys().next().value;if(oldest===undefined) break;
      this.canonicalRevisions.delete(oldest);
    }
    return this.canonicalRevision;
  }
  public constructor(private readonly deps: {
    readonly router: MassiveKeyRouter;
    readonly fetchFn: (url: string, signal: AbortSignal) => Promise<FetchResponse>;
    readonly fmp: Pick<FmpEnterpriseClient, 'fetchHistoricalPaginated'>;
    readonly nowMs: () => number;
  }) {}

  public load(request: Request): Promise<UsHistoricalResult> {
    if (request.signal?.aborted === true) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    const key = JSON.stringify([request.symbol, request.timeframe, request.rthOnly, request.visibleBars, request.adaptiveWindow, Math.floor(request.now / 60)]);
    let flight = this.flights.get(key);
    if (flight === undefined) {
      const controller = new AbortController();
      const promise = this.compute(request, controller.signal).finally(() => {
        if (this.flights.get(key)?.controller === controller) this.flights.delete(key);
      });
      flight = { controller, promise, users: 0 };
      this.flights.set(key, flight);
    }
    const active = flight;
    active.users += 1;
    return new Promise<UsHistoricalResult>((resolve, reject) => {
      let done = false;
      const finish = (): boolean => {
        if (done) return false;
        done = true; request.signal?.removeEventListener('abort', abort); active.users -= 1;
        return true;
      };
      const abort = (): void => {
        if (!finish()) return;
        if (active.users === 0) active.controller.abort();
        reject(new DOMException('Aborted', 'AbortError'));
      };
      request.signal?.addEventListener('abort', abort, { once: true });
      active.promise.then((value) => { if (finish()) resolve(value); }, (error: unknown) => { if (finish()) reject(error instanceof Error ? error : new Error(String(error))); });
    });
  }

  /** S1-8: reuse this owner's source cache/single-flight, never a parallel MA cache. */
  public async resolveMtfFiveMinuteSource(request: {
    readonly symbol:string;readonly firstVisible:number;readonly now:number;readonly rthOnly:boolean;
    readonly provider:'MASSIVE_REST'|'FMP';readonly allowAcquisition:boolean;readonly signal?:AbortSignal;
  }):Promise<{readonly bars:readonly Bar[];readonly source:MtfEmaDto['source'];readonly acquisitionAttempted:boolean;readonly requests:number;readonly pages:number}> {
    const from=resolveMtfWarmupFrom(request.firstVisible,request.rthOnly);
    const session=request.rthOnly?'RTH':'EXT';
    const massive=request.provider==='MASSIVE_REST';
    const key=massive?`MASSIVE_REST|${request.symbol}|${session}|SPLIT_ADJUSTED|BAR_MOMENTS|5`
      :`FMP|${request.symbol}|${session}|FMP_NATIVE_UNVERIFIED|HLC3|5m`;
    const hot=(entry:CacheEntry|undefined):entry is CacheEntry=>entry!==undefined&&this.deps.nowMs()-entry.prefixAt<900000&&
      this.deps.nowMs()-entry.at<8000&&entry.from<=from&&entry.to>=request.now;
    const sufficient=(bars:readonly Bar[]):boolean=>{
      // Evaluation coordinates only; no synthetic OHLCV observations.
      const lower=[{time:request.firstVisible},{time:Math.max(request.firstVisible,request.now-60)}];
      const result=projectMtfEmaToLowerBarsPure(lower,bars,20,{evaluationTimeSec:request.now,rthOnly:request.rthOnly});
      return result.warmupBeforeFirst>=250&&result.status==='CONFIRMED';
    };
    const cached=this.cache.get(key);
    if(hot(cached)) {
      const bars=rollupUsHistorical(cached.rows.filter(row=>row.bar.time>=from&&row.endExclusive<=request.now),5,request.rthOnly,request.now).map(row=>row.bar);
      if(sufficient(bars))return {bars,source:'CACHE_5M',acquisitionAttempted:false,requests:0,pages:0};
    }
    const minuteKey=massive?`MASSIVE_REST|${request.symbol}|${session}|SPLIT_ADJUSTED|BAR_MOMENTS|1`
      :`FMP|${request.symbol}|${session}|FMP_NATIVE_UNVERIFIED|HLC3|1m`;
    const minutes=this.cache.get(minuteKey);
    if(hot(minutes)) {
      const rows=minutes.rows.filter(row=>row.bar.time>=from&&row.endExclusive<=request.now);
      // Provider coverage does not certify omitted no-trade minutes. Only fully observed
      // intervals can prove an exact rollup; sparse windows use the native 5m path.
      const observed=new Set(rows.map(row=>row.bar.time));
      const bars=rollupUsHistorical(rows,5,request.rthOnly,request.now).filter(row=>{
        for(let t=row.bar.time;t<row.endExclusive;t+=60)if(!observed.has(t))return false;
        return true;
      }).map(row=>row.bar);
      if(sufficient(bars))return {bars,source:'EXACT_1M_ROLLUP',acquisitionAttempted:false,requests:0,pages:0};
    }
    if(!request.allowAcquisition)return {bars:[],source:'UNAVAILABLE',acquisitionAttempted:false,requests:0,pages:0};
    const signal=request.signal??new AbortController().signal;
    const counters:Counters={requests:0,pages:0,downloadedBars:0,baseAggregates:0,bytes:0};
    const rows=massive?await this.segment({symbol:request.symbol,timeframe:'5m',now:request.now,rthOnly:request.rthOnly},
      {from,to:request.now,sourceMinutes:5},signal,counters)
      :null;
    if(rows!==null)return {bars:normalizeMaBars(rollupUsHistorical(rows,5,request.rthOnly,request.now).map(row=>row.bar)),source:'ACQUIRED_5M',acquisitionAttempted:true,requests:counters.requests,pages:counters.pages};
    const result=await this.fmpRange({symbol:request.symbol,timeframe:'5m',fromUtcSec:from,toUtcSec:request.now,includeExtended:!request.rthOnly,signal,onHttp:()=>{counters.requests+=1;},onPage:()=>{counters.pages+=1;}});
    if(result.discarded>0||(result.httpStatus!==null&&result.httpStatus>=400))throw new Error('MTF_NATIVE_SOURCE_INVALID');
    return {bars:normalizeMaBars(rollupUsHistorical(result.bars.map(bar=>historicalObservation(bar,'FMP',5)),5,request.rthOnly,request.now).map(row=>row.bar)),source:'ACQUIRED_5M',acquisitionAttempted:true,requests:counters.requests,pages:counters.pages};
  }

  /**
   * S2-1: Reutiliza las barras `1m` y `5m` ya cacheadas en `UsHistoricalService` sin disparar
   * requests redundantes. Si `allowAcquisition === true` y falta cobertura `1m`/`5m` para `5D`/`20D`,
   * adquiere mediante `this.load` (single-flight deduplicado).
   */
  public async resolveVpIntradaySources(request: {
    readonly symbol: string;
    readonly now: number;
    readonly rthOnly: boolean;
    readonly provider: 'MASSIVE_REST' | 'FMP';
    readonly allowAcquisition: boolean;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly bars1m: readonly Bar[];
    readonly coveredFrom1m: number | null;
    readonly bars5m: readonly Bar[];
    readonly coveredFrom5m: number | null;
    readonly acquisitionAttempted: boolean;
  }> {
    const session = request.rthOnly ? 'RTH' : 'EXT';
    const massiveKey = (minutes: 1 | 5) =>
      `MASSIVE_REST|${request.symbol}|${session}|SPLIT_ADJUSTED|BAR_MOMENTS|${String(minutes)}`;
    const fmpKey = (tf: '1m' | '5m') =>
      `FMP|${request.symbol}|${session}|FMP_NATIVE_UNVERIFIED|HLC3|${tf}`;

    const isFreshPrefix = (entry: CacheEntry | undefined): entry is CacheEntry =>
      entry !== undefined && this.deps.nowMs() - entry.prefixAt < 900_000;

    const readCached1m = (): CacheEntry | undefined => {
      const m = this.cache.get(massiveKey(1));
      if (isFreshPrefix(m)) return m;
      const f = this.cache.get(fmpKey('1m'));
      return isFreshPrefix(f) ? f : undefined;
    };

    const readCached5m = (): CacheEntry | undefined => {
      const m = this.cache.get(massiveKey(5));
      if (isFreshPrefix(m)) return m;
      const f = this.cache.get(fmpKey('5m'));
      return isFreshPrefix(f) ? f : undefined;
    };

    let acquisitionAttempted = false;
    if (request.allowAcquisition) {
      const sessions5d = enumerateRecentUsSessions(request.now, 5, request.rthOnly, 60);
      const sessions20d = enumerateRecentUsSessions(request.now, 20, request.rthOnly, 300);
      const first5d = sessions5d[0];
      const first20d = sessions20d[0];
      const need5dFrom = first5d === undefined ? Number.POSITIVE_INFINITY : request.rthOnly ? first5d.open : first5d.extendedOpen;
      const need20dFrom = first20d === undefined ? Number.POSITIVE_INFINITY : request.rthOnly ? first20d.open : first20d.extendedOpen;

      const c1mBefore = readCached1m();
      const c5mBefore = readCached5m();
      const has5d1m = c1mBefore !== undefined && c1mBefore.from <= need5dFrom && c1mBefore.to >= request.now - 120;
      const has20d5m =
        (c5mBefore !== undefined && c5mBefore.from <= need20dFrom && c5mBefore.to >= request.now - 600) ||
        (c1mBefore !== undefined && c1mBefore.from <= need20dFrom && c1mBefore.to >= request.now - 600);

      if (!has20d5m) {
        acquisitionAttempted = true;
        await this.load({
          symbol: request.symbol,
          timeframe: '5m',
          now: request.now,
          rthOnly: request.rthOnly,
          adaptiveWindow: true,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
      }
      const c1mMid = readCached1m();
      const has5dAfter5m = c1mMid !== undefined && c1mMid.from <= need5dFrom && c1mMid.to >= request.now - 120;
      if (!has5d1m && !has5dAfter5m) {
        acquisitionAttempted = true;
        await this.load({
          symbol: request.symbol,
          timeframe: '1m',
          now: request.now,
          rthOnly: request.rthOnly,
          adaptiveWindow: true,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
      }
    }

    const entry1m = readCached1m();
    const entry5m = readCached5m();

    const rows1m = entry1m === undefined ? [] : rollupUsHistorical(entry1m.rows, 1, request.rthOnly, request.now);
    const bars1m = rows1m.map((row) => row.bar);
    const coveredFrom1m = entry1m?.from ?? null;

    let bars5m: readonly Bar[] = [];
    let coveredFrom5m: number | null = null;
    if (entry5m !== undefined && (entry1m === undefined || entry5m.from <= entry1m.from)) {
      bars5m = rollupUsHistorical(entry5m.rows, 5, request.rthOnly, request.now).map((row) => row.bar);
      coveredFrom5m = entry5m.from;
    } else if (entry1m !== undefined) {
      bars5m = rollupUsHistorical(entry1m.rows, 5, request.rthOnly, request.now).map((row) => row.bar);
      coveredFrom5m = entry1m.from;
    }

    return {
      bars1m,
      coveredFrom1m,
      bars5m,
      coveredFrom5m,
      acquisitionAttempted,
    };
  }

  public invalidate(symbol: string): void {
    this.nextCanonicalRevision(symbol);
    for (const key of this.cache.keys()) if (key.split('|')[1] === symbol) this.cache.delete(key);
    for (const [key, flight] of this.flights) {
      const identity = JSON.parse(key) as unknown[];
      if (identity[0] === symbol) { flight.controller.abort(); this.flights.delete(key); }
    }
  }

  private reviseCanonicalHistory(symbol:string,currentKey:string,signal:AbortSignal|undefined):void {
    this.nextCanonicalRevision(symbol);
    for(const key of this.cache.keys()) if(key!==currentKey&&key.split('|')[1]===symbol) this.cache.delete(key);
    for(const [key,flight] of this.flights) {
      const identity=JSON.parse(key) as unknown[];
      if(identity[0]===symbol&&signal!==undefined&&flight.controller.signal!==signal) flight.controller.abort();
    }
  }

  private async compute(request: Request, signal: AbortSignal): Promise<UsHistoricalResult> {
    const started = this.deps.nowMs();
    const activePool = this.deps.router.status().domains.STOCKS_REST.activeSlotCount > 0;
    const adaptivePlan = request.adaptiveWindow === true
      ? planUsHistorical(request.timeframe, request.now, request.rthOnly, undefined, true) : undefined;
    let plan = activePool ? adaptivePlan ?? planUsHistorical(request.timeframe, request.now, request.rthOnly, request.visibleBars)
      : planUsFmpHistorical(request.timeframe, request.now, request.rthOnly, request.visibleBars ?? 1000, adaptivePlan?.historyFrom);
    const counters: Counters = { requests: 0, pages: 0, downloadedBars: 0, baseAggregates: 0, bytes: 0 };
    const segments: (readonly HistoricalObservation[])[] = [];
    let fallbackCause: string | null = null;
    let fmpRows: readonly HistoricalObservation[] | null = null;
    let fmpRequests = 0;
    let fmpSessionRows: readonly HistoricalObservation[] = [];
    let fmpCanonical: readonly HistoricalObservation[] = [];
    try {
      if (!activePool) throw new Error('HISTORICAL_MASSIVE_POOL_UNAVAILABLE');
      for (const segment of plan.segments) {
        segments.push(await this.segment(request, segment, signal, counters));
      }
      if (segments.every((segment) => segment.length === 0)) throw new Error('HISTORICAL_EMPTY');
    } catch (error: unknown) {
      signal.throwIfAborted();
      fallbackCause = error instanceof Error && error.message.startsWith('HISTORICAL_') ? error.message : 'MASSIVE_UNAVAILABLE';
      // Discard the entire operation's Massive segments, including successful pages.
      segments.length = 0;
      plan = planUsFmpHistorical(request.timeframe, request.now, request.rthOnly, request.visibleBars ?? plan.visibleBars, adaptivePlan?.historyFrom);
      if (adaptivePlan?.visibleFrom !== undefined && adaptivePlan.expectedVisibleBars !== undefined) plan = { ...plan, visibleFrom: adaptivePlan.visibleFrom, expectedVisibleBars: adaptivePlan.expectedVisibleBars };
      const from = plan.historyFrom;
      const transport = {
        signal,
        onHttp: (_status: number | null, bytes: number): void => { counters.requests += 1; fmpRequests += 1; counters.bytes += bytes; },
        onPage: (count: number): void => { counters.pages += 1; counters.downloadedBars += count; },
      };
      const result = await this.fmpRange({ symbol: request.symbol, timeframe: request.timeframe, fromUtcSec: from, toUtcSec: request.now, includeExtended: !request.rthOnly, ...transport });
      signal.throwIfAborted();
      if (result.bars.length === 0 || result.discarded > 0 || (result.httpStatus !== null && result.httpStatus >= 400)) throw new Error('HISTORICAL_FMP_UNAVAILABLE');
      const minutes = { '1m': 1, '5m': 5, '15m': 15, '1h': 60 }[request.timeframe];
      let activeSession: ReturnType<typeof usHistoricalSession> = null;
      fmpRows = result.bars.filter((bar) => bar.time >= from && bar.time < request.now).flatMap((bar) => {
        if (activeSession === null || bar.time < activeSession.extendedOpen || bar.time >= activeSession.extendedClose) activeSession = usHistoricalSession(bar.time);
        const session = activeSession;
        if (session === null || bar.time < (request.rthOnly ? session.open : session.extendedOpen) || bar.time >= (request.rthOnly ? session.close : session.extendedClose)) return [];
        const row = historicalObservation(bar, 'FMP', minutes);
        const endExclusive = Math.min(row.endExclusive, request.rthOnly ? session.close : session.extendedClose);
        return endExclusive <= request.now ? [{ ...row, endExclusive }] : [];
      });
      fmpSessionRows = fmpRows;
      // Native history retains FMP's lookback and conventions. The monthly seed is
      // requested independently at 1m, never reconstructed from native TF prices.
      if (request.timeframe === '1m') {
        fmpCanonical = fmpRows.filter((row) => row.bar.time >= plan.monthAnchor);
      } else if (!result.legacyFallbackUsed && plan.monthAnchor < request.now) {
        try {
          const prefix = await this.fmpRange({ symbol: request.symbol, timeframe: '1m', fromUtcSec: plan.monthAnchor, toUtcSec: request.now, includeExtended: !request.rthOnly, ...transport });
          fmpCanonical = rollupUsHistorical(prefix.bars.filter((bar) => bar.time >= plan.monthAnchor && bar.time + 60 <= request.now).map((bar) => historicalObservation(bar, 'FMP', 1)), 1, request.rthOnly, request.now);
        } catch {
          signal.throwIfAborted();
          // Honest unavailable seed; native candles and warm-up remain usable.
          fmpCanonical = [];
        }
      }
      if (fmpCanonical[0]?.bar.time === plan.monthAnchor && request.timeframe !== '1m') {
        const monthly = rollupUsHistorical(fmpCanonical, minutes, request.rthOnly, request.now);
        fmpRows = mergeHistoricalSegments([fmpRows.filter((row) => row.endExclusive <= plan.monthAnchor), monthly]);
      }
    }
    signal.throwIfAborted();
    const source = mergeHistoricalSegments(segments);
    const minutes = { '1m': 1, '5m': 5, '15m': 15, '1h': 60 }[request.timeframe];
    const rows = fmpRows ?? rollupUsHistorical(source, minutes, request.rthOnly, request.now);
    const canonicalMonth = fmpRows !== null ? fmpCanonical : request.timeframe === '1m'
      ? rows.filter((row) => row.bar.time >= plan.monthAnchor)
      : rollupUsHistorical(source.filter((row) => row.sourceMinutes === 1 && row.bar.time >= plan.monthAnchor), 1, request.rthOnly, request.now);
    const cacheRows = [...this.cache.values()].reduce((sum, entry) => sum + entry.rows.length, 0);
    const sessionSources = fmpRows === null ? source : fmpCanonical.length===0 ? fmpSessionRows
      : [...fmpSessionRows.filter(row=>row.endExclusive<=plan.monthAnchor),...fmpCanonical];
    return { rows, canonicalMonth, sessionSources, plan, warmupSatisfied: plan.visibleFrom === undefined
      ? rows.filter((row) => row.bar.time >= plan.historyFrom).length >= plan.requiredBars
      : rows.filter((row) => row.bar.time >= plan.historyFrom && row.endExclusive <= (plan.visibleFrom as number)).length >= plan.warmupBars,
      coverage: { requestedFrom: plan.historyFrom, firstTime: rows[0]?.bar.time ?? null, lastEndExclusive: rows[rows.length - 1]?.endExclusive ?? null, receivedBars: rows.length,
        canonicalPrefix: canonicalMonth[0]?.bar.time === plan.monthAnchor ? 'OBSERVED_1M' : 'MISSING_1M', adjustment: fmpRows === null ? 'SPLIT_ADJUSTED' : 'FMP_NATIVE_UNVERIFIED' },
      metrics: { ...counters, fmpRequests, massiveRequests: counters.requests - fmpRequests, peakCacheRows: this.peakCacheRows, latencyMs: this.deps.nowMs() - started, cacheHit: counters.requests === 0, cacheRows, fallbackCause } };
  }

  private async fmpRange(request: FmpHistoricalRequest & { readonly fromUtcSec: number; readonly toUtcSec: number }): Promise<FmpHistoricalResult> {
    const key = `FMP|${request.symbol}|${request.includeExtended === true ? 'EXT' : 'RTH'}|FMP_NATIVE_UNVERIFIED|HLC3|${request.timeframe}`;
    const pending = this.fmpFlights.get(key);
    if (pending !== undefined) {
      try { await pending; } catch { request.signal?.throwIfAborted(); }
      request.signal?.throwIfAborted();
      return this.fmpRange(request);
    }
    const promise = this.loadFmpRange(key, request);
    this.fmpFlights.set(key, promise);
    try { return await promise; } finally { this.fmpFlights.delete(key); }
  }

  private async loadFmpRange(key: string, request: FmpHistoricalRequest & { readonly fromUtcSec: number; readonly toUtcSec: number }): Promise<FmpHistoricalResult> {
    const cached = this.cache.get(key); const now = this.deps.nowMs();
    const valid = cached !== undefined && cached.nativeMetadata !== undefined && now - cached.prefixAt < 900000 && cached.to >= request.fromUtcSec && cached.from <= request.toUtcSec;
    if (valid && now - cached.at < 8000 && cached.from <= request.fromUtcSec && cached.to >= request.toUtcSec) {
      const bars = cached.rows.map((row) => row.bar).filter((bar) => bar.time >= request.fromUtcSec && bar.time <= request.toUtcSec);
      return { ...cached.nativeMetadata, bars, rows: bars.length, fromUtcSec: request.fromUtcSec, toUtcSec: request.toUtcSec };
    }
    const from = valid && cached.from <= request.fromUtcSec ? Math.max(request.fromUtcSec, Math.min(cached.to, request.toUtcSec - 2 * 86400)) : request.fromUtcSec;
    let result = await this.deps.fmp.fetchHistoricalPaginated({ ...request, fromUtcSec: from });
    request.signal?.throwIfAborted();
    const previous = new Map(cached?.rows.map((row) => [row.bar.time, row.bar]));
    const observedRevision = result.bars.some((bar) => {
      const old = previous.get(bar.time);
      return old !== undefined && (old.open !== bar.open || old.high !== bar.high || old.low !== bar.low || old.close !== bar.close || old.volume !== bar.volume);
    });
    const revised = valid && from > request.fromUtcSec && observedRevision;
    if (observedRevision) this.reviseCanonicalHistory(request.symbol,key,request.signal);
    if (revised) {
      result = await this.deps.fmp.fetchHistoricalPaginated(request);
    }
    request.signal?.throwIfAborted();
    const retained = valid && !revised ? cached.rows.map((row) => row.bar).filter((bar) => bar.time < from || bar.time > request.toUtcSec) : [];
    const bars = mergeFmpPaginatedBars([retained, result.bars], { fromUtcSec: request.fromUtcSec, toUtcSec: request.toUtcSec });
    const minutes = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1D': 1440 }[request.timeframe];
    if (bars.length <= 100000 && result.discarded === 0) {
      this.cache.set(key, { from: request.fromUtcSec, to: request.toUtcSec, at: now, prefixAt: valid && !observedRevision ? cached.prefixAt : now, nativeMetadata: { ...result, bars: [] }, rows: Object.freeze(bars.map((bar) => {
        const row = historicalObservation(bar, 'FMP', minutes);
        return Object.freeze({ ...row, bar: Object.freeze({ ...bar }), moments: Object.freeze({ ...row.moments }) });
      })) });
      while (this.cache.size > 16 || [...this.cache.values()].reduce((sum, entry) => sum + entry.rows.length, 0) > 100000) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
      this.peakCacheRows = Math.max(this.peakCacheRows, [...this.cache.values()].reduce((sum, entry) => sum + entry.rows.length, 0));
    }
    return { ...result, bars, rows: bars.length, fromUtcSec: request.fromUtcSec, toUtcSec: request.toUtcSec };
  }

  private async segment(request: Request, segment: HistoricalPlan['segments'][number], signal: AbortSignal, counters: Counters): Promise<readonly HistoricalObservation[]> {
    const key = `MASSIVE_REST|${request.symbol}|${request.rthOnly ? 'RTH' : 'EXT'}|SPLIT_ADJUSTED|BAR_MOMENTS|${String(segment.sourceMinutes)}`;
    const pending = this.segmentFlights.get(key);
    if (pending !== undefined) {
      try { await pending; } catch { signal.throwIfAborted(); }
      signal.throwIfAborted();
      return this.segment(request, segment, signal, counters);
    }
    const promise = this.loadSegment(key, request, segment, signal, counters);
    this.segmentFlights.set(key, promise);
    try { return await promise; } finally { this.segmentFlights.delete(key); }
  }

  private async loadSegment(key: string, request: Request, segment: HistoricalPlan['segments'][number], signal: AbortSignal, counters: Counters): Promise<readonly HistoricalObservation[]> {
    const cached = this.cache.get(key);
    const at = this.deps.nowMs();
    if (cached !== undefined && at - cached.at < 8000 && at - cached.prefixAt < 900000 && cached.from <= segment.from && cached.to >= segment.to) {
      return cached.rows.filter((row) => row.bar.time >= segment.from && row.endExclusive <= segment.to);
    }
    // Reuse closed prefix for 15 minutes, refresh only the last two calendar days.
    const valid = cached !== undefined && at - cached.prefixAt < 900000 && cached.to >= segment.from && cached.from <= segment.to;
    const leftOnly = valid && at - cached.at < 8000 && cached.from > segment.from && cached.to >= segment.to;
    const from = valid && cached.from <= segment.from ? Math.max(segment.from, Math.min(cached.to, segment.to - 2 * 86400)) : segment.from;
    let loaded = await this.massiveRange(request.symbol, from, leftOnly ? cached.from : segment.to, segment.sourceMinutes, signal, counters);
    signal.throwIfAborted();
    const oldRowsByTime = new Map(cached?.rows.map((row) => [row.bar.time, row]));
    const observedRevision = loaded.some((row)=>{
      const old=oldRowsByTime.get(row.bar.time);
      return old!==undefined&&['open','high','low','close','volume','vw'].some((name)=>!Object.is(Reflect.get(row.bar,name),Reflect.get(old.bar,name)));
    });
    const revised = valid && from > segment.from && observedRevision;
    if (observedRevision) this.reviseCanonicalHistory(request.symbol,key,signal);
    if (revised) {
      loaded = await this.massiveRange(request.symbol, segment.from, segment.to, segment.sourceMinutes, signal, counters);
    }
    const retained = valid && !revised ? leftOnly ? cached.rows : cached.rows.filter((row) => row.bar.time < from || row.bar.time >= segment.to) : [];
    const rows = mergeHistoricalSegments([retained, loaded]);
    // Never retain more than 100k observations or 16 identities; no cache mutation of arguments.
    if (rows.length <= 100000 && !signal.aborted) this.cache.set(key, { from: valid && !revised ? Math.min(cached.from, segment.from) : segment.from, to: valid && !revised ? Math.max(cached.to, segment.to) : segment.to, at, prefixAt: valid && !observedRevision ? cached.prefixAt : at, rows: Object.freeze(rows.map((row) => Object.freeze({ ...row, bar: Object.freeze({ ...row.bar }), moments: Object.freeze({ ...row.moments }) }))) });
    while (this.cache.size > 16 || [...this.cache.values()].reduce((sum, entry) => sum + entry.rows.length, 0) > 100000) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.peakCacheRows = Math.max(this.peakCacheRows, [...this.cache.values()].reduce((sum, entry) => sum + entry.rows.length, 0));
    return rows.filter((row) => row.bar.time >= segment.from && row.endExclusive <= segment.to);
  }

  private async massiveRange(symbol: string, from: number, to: number, minutes: number, signal: AbortSignal, counters: Counters): Promise<readonly HistoricalObservation[]> {
    const path = `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${String(minutes)}/minute/`;
    let url: string | null = `https://api.massive.com${path}${String(from * 1000)}/${String(to * 1000 - 1)}?adjusted=true&sort=asc&limit=50000`;
    const visited = new Set<string>();
    const bars: Bar[] = [];
    while (url !== null) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const target: URL = new URL(url);
      if (!['https://api.massive.com', 'https://api.polygon.io'].includes(target.origin) || !target.pathname.startsWith(path) || target.username !== '' || target.password !== '') throw new Error('HISTORICAL_INVALID_NEXT_URL');
      for (const name of [...target.searchParams.keys()]) if (/key|token|secret/i.test(name)) target.searchParams.delete(name);
      if (visited.has(target.toString())) throw new Error('HISTORICAL_PAGINATION_CYCLE');
      visited.add(target.toString());
      const response = await this.deps.router.executeRest({ domain: 'STOCKS_REST', url: target.toString(), signal, fetchFn: async (authedUrl) => {
        counters.requests += 1;
        const result = await this.deps.fetchFn(authedUrl, signal);
        counters.bytes += Buffer.byteLength(result.text, 'utf8');
        return result;
      } });
      if (!response.ok) throw new Error(`HISTORICAL_HTTP_${String(response.status)}`);
      const raw = JSON.parse(response.text) as Record<string, unknown>;
      const normalized = normalizeMassiveAggs(raw, { barSeconds: minutes * 60 });
      if (raw['adjusted'] === false || normalized.report.malformedResponse || normalized.report.providerError !== null || normalized.report.discarded > 0) throw new Error('HISTORICAL_INVALID_PAGE');
      counters.pages += 1; counters.downloadedBars += normalized.report.received;
      const queryCount = raw['queryCount'];
      if (typeof queryCount === 'number' && Number.isFinite(queryCount) && queryCount >= 0) {
        if (counters.baseAggregates !== null) counters.baseAggregates += queryCount;
      } else counters.baseAggregates = null;
      bars.push(...normalized.bars.filter((bar) => bar.time >= from && bar.time + minutes * 60 <= to));
      const next = raw['next_url'];
      if (next !== undefined && next !== null && typeof next !== 'string') throw new Error('HISTORICAL_INVALID_NEXT_URL');
      url = typeof next === 'string' && next !== '' ? next : null;
      // limit counts base aggregates. A saturated page without next_url is not
      // evidence that a long range is complete: continue from the last full bar.
      if (url === null && typeof queryCount === 'number' && queryCount >= 50000) {
        const last = normalized.bars[normalized.bars.length - 1];
        if (last === undefined || last.time + minutes * 60 <= from) throw new Error('HISTORICAL_PAGINATION_NO_PROGRESS');
        const resume = last.time + minutes * 60;
        if (resume < to) url = `https://api.massive.com${path}${String(resume * 1000)}/${String(to * 1000 - 1)}?adjusted=true&sort=asc&limit=50000`;
      }
    }
    // Repeated rows across pages are permitted only if identical; never double-count volume.
    const dedup = new Map<number, Bar>();
    for (const bar of bars) {
      const existing = dedup.get(bar.time);
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(bar)) throw new Error('HISTORICAL_CONFLICTING_DUPLICATE');
      dedup.set(bar.time, bar);
    }
    return [...dedup.values()].sort((a, b) => a.time - b.time).map((bar) => historicalObservation(bar, 'MASSIVE_REST', minutes));
  }
}
