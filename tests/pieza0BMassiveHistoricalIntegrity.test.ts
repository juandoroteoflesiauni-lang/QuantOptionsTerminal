import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import type { Bar } from '../src/core/types.js';
import { historicalMomentsSince, historicalObservation, mergeHistoricalSegments, planUsFmpHistorical, planUsHistorical, rollupUsHistorical, usHistoricalSession, type HistoricalPlan, type UsHistoricalTimeframe, type UsSession } from '../src/core/usHistorical.js';
import { normalizeMassiveAggs } from '../src/data/normalizeMassive.js';
import { restHistoricalFromUtcSec } from '../src/data/restHistoricalWindow.js';
import type { FetchResponse } from '../src/data/types.js';
import { createDefaultFmpHttpFn, FmpEnterpriseClient, resolveFmpConfig, type FmpHttpFn } from '../src/server/fmpClient.js';
import { MassiveKeyRouter } from '../src/server/massiveKeyPool.js';
import { UsHistoricalService, serializeHistoricalIntegrity } from '../src/server/usHistoricalService.js';
import { MarketRuntime } from '../src/server/marketRuntime.js';

interface PlanCase { tf: UsHistoricalTimeframe; now: number; rth: boolean; visible: number | null; massive: HistoricalPlan; fmp: HistoricalPlan | null }
interface ServiceCase { tf: UsHistoricalTimeframe; now: number; rth: boolean; pages: number; downloadedBars: number; finalBars: number; volume: number; intermediate30mBars: number; counterfactual5mBars: number }
interface RollCase { date: string; minutes: number; rth: boolean; now: number; bars: Bar[] | null; expected: Record<string, unknown>[] }
interface VwCase { bar: Omit<Bar, 'vw'> & { vw?: unknown }; price: number; source: string; moments: Record<string, number> }
const fixture = JSON.parse(readFileSync('fixtures/pieza0b_massive_rest_reference.json', 'utf8')) as {
  calendar: { time: number; session: UsSession | null }[]; plans: PlanCase[]; services: ServiceCase[]; rollups: RollCase[]; vwCases: VwCase[];
};
// Test transport input generation: index the same independently supplied sessions
// instead of scanning the full calendar for every serialized FMP row.
const mockSessionByDay = new Map(fixture.calendar.flatMap(({ session }) => session === null ? [] : [[Math.floor((session.extendedOpen - 4 * 3600) / 86400), session] as const]));
const benchmark = process.env['PIEZA0B_BENCHMARK'] === '1';

function compare(actual: unknown, expected: unknown): void {
  if (typeof expected === 'number') {
    expect(typeof actual).toBe('number');
    expect(Math.abs(Number(actual) - expected)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(expected)));
  } else if (Array.isArray(expected)) {
    expect(Array.isArray(actual)).toBe(true);
    const values = actual as unknown[];
    expect(values).toHaveLength(expected.length);
    expected.forEach((value: unknown, i: number) => { compare(values[i], value); });
  } else if (expected !== null && typeof expected === 'object') {
    for (const [key, value] of Object.entries(expected)) compare(Reflect.get(actual as object, key), value);
  } else expect(actual).toEqual(expected);
}

function decodeBar(input: VwCase['bar']): Bar {
  const copy = { ...input };
  if (typeof copy.vw === 'string') copy.vw = Number(copy.vw);
  return copy as Bar;
}

function makeBar(time: number, minutes: number): Bar {
  const prices = Array.from({ length: minutes }, (_, i) => 100 + ((time / 60 + i) % 32) / 8);
  const volumes = prices.map((_, i) => 1 + ((time / 60 + i) % 3));
  const volume = volumes.reduce((a, b) => a + b, 0);
  return { time, open: prices[0] as number, high: Math.max(...prices) + 1, low: Math.min(...prices) - 1,
    close: (prices[prices.length - 1] as number) + 0.5, volume,
    vw: prices.reduce((sum, price, i) => sum + price * (volumes[i] as number), 0) / volume };
}

function marketRows(from: number, to: number, minutes: number, rth = false): Bar[] {
  const rows: Bar[] = [];
  for (const item of fixture.calendar) {
    const s = item.session;
    if (s === null || s.extendedClose <= from || s.extendedOpen >= to) continue;
    const start = rth ? s.open : s.extendedOpen;
    const end = rth ? s.close : s.extendedClose;
    for (let t = start; t < end; t += minutes * 60) if (t >= from && t < to) rows.push(makeBar(t, Math.min(minutes, (end - t) / 60)));
  }
  return rows;
}

function ok(body: unknown): FetchResponse { return { ok: true, status: 200, text: JSON.stringify(body) }; }

function harness(options: { emptyPool?: boolean; failAfter?: number; rateLimit?: boolean; now?: number; omitNext?: boolean } = {}) {
  const requests: string[] = [];
  let clock = (options.now ?? fixture.services[0]?.now ?? 0) * 1000;
  let calls = 0;
  const sourceRanges = new Map<string, Bar[]>();
  const sourceBars: Record<string, number> = {};
  const router = new MassiveKeyRouter({ env: options.emptyPool ? {} : { MASSIVE_KEY_2: 'SYNTH_2', MASSIVE_KEY_3: 'SYNTH_3', MASSIVE_KEY_1: 'SYNTH_1', MASSIVE_API_KEY: 'SYNTH_OPTIONS' }, fileValues: new Map() }, { nowMsFn: () => clock });
  const fetchFn = (url: string): Promise<FetchResponse> => {
    requests.push(url); calls += 1;
    if (options.rateLimit) return Promise.resolve({ ok: false, status: 429, text: 'rate limit' });
    if (options.failAfter !== undefined && calls > options.failAfter) return Promise.resolve({ ok: false, status: 404, text: '{}' });
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/');
    const minutes = Number(parts[6]); const from = Number(parts[8]) / 1000; const to = (Number(parts[9]) + 1) / 1000;
    const rangeKey = `${String(from)}|${String(to)}|${String(minutes)}`;
    let bars = sourceRanges.get(rangeKey);
    if (bars === undefined) {
      bars = marketRows(from, to, minutes).filter((bar) => bar.time + minutes * 60 <= to);
      sourceRanges.set(rangeKey, bars);
    }
    const offset = Number(parsed.searchParams.get('cursor') ?? 0);
    const width = Math.floor(50000 / minutes);
    const page = bars.slice(offset, offset + width);
    sourceBars[String(minutes)] = (sourceBars[String(minutes)] ?? 0) + page.length;
    const next = new URL(parsed); next.searchParams.delete('apikey'); next.searchParams.delete('apiKey'); next.searchParams.set('cursor', String(offset + width));
    return Promise.resolve(ok({ status: 'OK', adjusted: true, queryCount: offset + width < bars.length ? 50000 : page.length * minutes,
      results: page.map((b) => ({ t: b.time * 1000, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume, vw: b.vw })),
      ...(offset + width < bars.length && !options.omitNext ? { next_url: next.toString() } : {}) }));
  };
  const fmpRequests: string[] = [];
  const fmpFetch: FmpHttpFn = (url) => {
    fmpRequests.push(url);
    const parsed = new URL(url);
    const minutes = parsed.pathname.includes('/1hour') ? 60 : parsed.pathname.includes('/15min') ? 15 : parsed.pathname.includes('/5min') ? 5 : 1;
    const fromKey = parsed.searchParams.get('from') ?? '2025-01-01'; const toKey = parsed.searchParams.get('to') ?? '2028-12-31';
    const dates = fixture.calendar.filter((item) => item.session !== null && item.session.dateKey >= fromKey && item.session.dateKey <= toKey);
    const first = dates[0]?.session; const last = dates[dates.length - 1]?.session;
    const rows = first === null || first === undefined || last === null || last === undefined ? [] : marketRows(first.extendedOpen, Math.min(last.extendedClose, clock / 1000), minutes, parsed.searchParams.get('extended') !== 'true');
    return Promise.resolve(ok(rows.map((b) => {
      const s = mockSessionByDay.get(Math.floor((b.time - 4 * 3600) / 86400));
      if (s === undefined) throw new Error('Test session missing');
      const minute = 240 + (b.time - s.extendedOpen) / 60;
      return { date: `${s.dateKey} ${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00`, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
    })));
  };
  const fmp = new FmpEnterpriseClient({ config: resolveFmpConfig({ FMP_API_KEY: 'SYNTH_FMP' }), fetchFn: fmpFetch, nowMsFn: () => clock });
  const service = new UsHistoricalService({ router, fetchFn, fmp, nowMs: () => clock });
  return { service, router, fmp, fetchFn, sourceBars, requests, fmpRequests, advance: (ms: number): void => { clock += ms; } };
}

describe('Pieza 0B — independent calendar, policies and weighted moments', () => {
  it('matches all 2020–2028 published-calendar dates, DST, mourning and New Year exceptions', () => {
    for (const item of fixture.calendar) expect(usHistoricalSession(item.time), String(item.time)).toEqual(item.session);
    expect(() => usHistoricalSession(Date.parse('2019-12-31T17:00:00Z') / 1000)).toThrow(/OUT_OF_COVERAGE/);
    expect(() => usHistoricalSession(1862049600)).toThrow(/OUT_OF_COVERAGE/);
  });

  it('matches Massive and FMP plans independently, preserving provider-specific lookback', () => {
    for (const c of fixture.plans) {
      expect(planUsHistorical(c.tf, c.now, c.rth, c.visible === null ? undefined : c.visible)).toEqual(c.massive);
      if (c.fmp !== null) expect(planUsFmpHistorical(c.tf, c.now, c.rth, c.fmp.visibleBars)).toEqual(c.fmp);
      if (c.fmp !== null) expect(planUsFmpHistorical(c.tf, c.now, c.rth, c.fmp.visibleBars, c.fmp.historyFrom - 86400).historyFrom).toBe(c.fmp.historyFrom - 86400);
      expect(planUsHistorical(c.tf, c.now, c.rth, c.visible === null ? undefined : c.visible)).toEqual(c.massive);
    }
    expect(() => planUsHistorical('5m', fixture.plans[0]?.now ?? 0, false, -1)).toThrow();
  });

  it('accepts VW outside OHLC verbatim, handles every invalid VW, preserves precision and seconds', () => {
    for (const c of fixture.vwCases) {
      const b = Object.freeze(decodeBar(c.bar));
      const row = historicalObservation(b, 'MASSIVE_REST', 1);
      expect(Object.is(row.bar.vw, b.vw)).toBe(true);
      expect(row.priceSource).toBe(c.source); compare(row.price, c.price); compare(row.moments, c.moments);
      const normalized = normalizeMassiveAggs({ status: 'OK', results: [{ t: b.time * 1000, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume, vw: b.vw }] }, { barSeconds: 60 });
      expect(normalized.bars[0]?.time).toBe(b.time);
      const adapted = historicalObservation(normalized.bars[0] as Bar, 'MASSIVE_REST', 1);
      expect(adapted.priceSource).toBe(c.source);
      if (c.source === 'REAL_VW') expect(adapted.bar.vw).toBe(b.vw);
    }
    expect(() => historicalObservation({ ...decodeBar(fixture.vwCases[0]?.bar as VwCase['bar']), open: Number.NaN }, 'MASSIVE_REST', 1)).toThrow();
  });

  it('conserves OHLCV, provenance, PV/V/P2V at all buckets including early final partial hour', () => {
    for (const c of fixture.rollups) {
      const bars = fixture.rollups.find((item) => item.date === c.date && item.bars !== null)?.bars;
      if (bars === undefined || bars === null) throw new Error('Fixture bars missing');
      const input = bars.map((bar) => historicalObservation(Object.freeze({ ...bar }), 'MASSIVE_REST', 1));
      const actual = rollupUsHistorical(input, c.minutes, c.rth, c.now);
      const projected = actual.map((row) => ({ ...row.bar, endExclusive: row.endExclusive, moments: row.moments, realVwBars: row.realVwBars, proxyBars: row.proxyBars, priceSource: row.priceSource }));
      compare(projected, c.expected);
      const selected = rollupUsHistorical(input, 1, c.rth, c.now);
      const anchor = selected[Math.min(10, selected.length - 1)]?.bar.time ?? 0;
      const end = selected[selected.length - 1]?.endExclusive ?? 0;
      // Compare all resolutions at identical confirmed boundaries.
      compare(historicalMomentsSince(actual, 0, c.now), historicalMomentsSince(selected, 0, c.now));
      expect(historicalMomentsSince(selected, anchor, end).V).toBeLessThan(historicalMomentsSince(selected, 0, end).V);
      if (c.rth && c.minutes === 60) expect(actual[actual.length - 1]?.endExclusive).toBe(usHistoricalSession(c.now - 3600)?.close);
    }
  });

  it('rejects overlap/double counting, crossing intermediates and keeps zero-volume price NaN', () => {
    const bar = decodeBar(fixture.vwCases[0]?.bar as VwCase['bar']);
    const row = historicalObservation(bar, 'MASSIVE_REST', 1);
    expect(() => mergeHistoricalSegments([[row], [row]])).toThrow(/Overlapping/);
    expect(() => rollupUsHistorical([historicalObservation({ ...bar, time: bar.time + 60 }, 'MASSIVE_REST', 30)], 15, true, bar.time + 3600)).toThrow(/crosses/);
    const zero = rollupUsHistorical([historicalObservation({ ...bar, volume: 0 }, 'MASSIVE_REST', 1)], 5, true, bar.time + 3600);
    expect(zero[0]?.price).toBeNaN(); expect(zero[0]?.moments).toEqual({ PV: 0, V: 0, P2V: 0 });
    expect(mergeHistoricalSegments([[{ ...row, bar: { ...bar, time: bar.time - 60 }, endExclusive: bar.time }], [row]])).toHaveLength(2);
  });
});

describe('Pieza 0B — HTTP pools, pagination, cache and clean FMP fallback', () => {
  const metrics: unknown[] = [];
  it.each(fixture.services)('matches $tf RTH=$rth independent counts, warm-up, cold and hot cache', async (c) => {
      const h = harness(); const request = { symbol: 'SYN', timeframe: c.tf, rthOnly: c.rth, now: c.now, visibleBars: 1000 };
      let legacyRequests = 0; let legacyBytes = 0;
      const legacyStart = performance.now();
      // A comparative benchmark does not belong in every verify worker. The
      // dedicated measurement run still executes it with PIEZA0B_BENCHMARK=1.
      const legacy = benchmark ? await h.fmp.fetchHistoricalPaginated({ symbol: 'SYN', timeframe: c.tf, fromUtcSec: restHistoricalFromUtcSec({ toUtcSec: c.now, provider: 'FMP_ENTERPRISE_REST', timeframe: c.tf, includeExtended: !c.rth, targetBars: 2000 }), toUtcSec: c.now, includeExtended: !c.rth,
        onHttp: (_status, bytes) => { legacyRequests += 1; legacyBytes += bytes; } }) : null;
      const legacyMs = performance.now() - legacyStart; const heapBefore = process.memoryUsage().heapUsed;
      const start = performance.now(); const cold = await h.service.load(request); const coldMs = performance.now() - start;
      expect(cold.metrics.pages).toBe(c.pages); expect(cold.metrics.downloadedBars).toBe(c.downloadedBars);
      expect(cold.rows).toHaveLength(c.finalBars); expect(cold.rows.reduce((sum, row) => sum + row.bar.volume, 0)).toBe(c.volume);
      expect(cold.warmupSatisfied).toBe(true); expect(cold.metrics.fallbackCause).toBeNull();
      if (c.tf === '1h') {
        expect(h.requests.some((url) => url.includes('/range/30/minute/'))).toBe(true);
        expect(h.requests.some((url) => url.includes('/range/5/minute/'))).toBe(false);
        expect(h.sourceBars['30']).toBe(c.intermediate30mBars);
        expect((h.sourceBars['30'] as number) * 6).toBe(c.counterfactual5mBars);
      }
      expect(cold.rows.every((row) => row.historicalProvider === 'MASSIVE_REST')).toBe(true);
      const before = h.requests.length; const warmStart = performance.now(); const hot = await h.service.load(request); const hotMs = performance.now() - warmStart;
      expect(h.requests).toHaveLength(before); expect(hot.metrics.cacheHit).toBe(true);
      compare(historicalMomentsSince(cold.canonicalMonth, cold.plan.monthAnchor, c.now), historicalMomentsSince(hot.canonicalMonth, hot.plan.monthAnchor, c.now));
      expect(cold.metrics.cacheRows).toBeLessThanOrEqual(100000);
      const dto = serializeHistoricalIntegrity(cold, cold.rows[cold.rows.length - 1000]?.bar.time ?? 0);
      expect(dto.observations).toHaveLength(1000); expect(dto.priceSource).toBe('REAL_VW'); expect(JSON.stringify(dto)).not.toContain('SYNTH_');
      metrics.push({ tf: c.tf, rth: c.rth, legacy: legacy === null ? null : { requests: legacyRequests, bytes: legacyBytes, rows: legacy.bars.length, latencyMs: legacyMs, canonicalPrefix: false }, sourceBars: h.sourceBars, counterfactual5mBars: c.counterfactual5mBars, coldMs, hotMs, cold: cold.metrics, hot: hot.metrics, rows: cold.rows.length, required: cold.plan.requiredBars, heapBefore, sampledHeapAfter: process.memoryUsage().heapUsed });
    if (benchmark) {
      mkdirSync('.cache', { recursive: true });
      writeFileSync('.cache/pieza0b-historical-metrics.json', JSON.stringify({ kind: 'DETERMINISTIC_HTTP_MOCKS_NOT_PROVIDER_MEASUREMENTS', metrics }, null, 2));
    }
  });

  it('deduplicates concurrent consumers and reuses monthly 1m across TF without redownloading the prefix', async () => {
    const h = harness(); const now = fixture.services[0]?.now ?? 0;
    const request = { symbol: 'SYN', timeframe: '1m' as const, rthOnly: false, now, visibleBars: 1000 };
    const [first, second] = await Promise.all([h.service.load(request), h.service.load(request)]);
    expect(first).toBe(second); const prefixCount = h.requests.length;
    await h.service.load({ ...request, timeframe: '15m' });
    const subsequent1m = h.requests.slice(prefixCount).filter((url) => new URL(url).pathname.includes('/range/1/minute/'));
    expect(subsequent1m).toHaveLength(0);
    h.service.invalidate('SYN'); await h.service.load(request); expect(h.requests.length).toBeGreaterThan(prefixCount);
    h.advance(9000); const refreshed = await h.service.load({ ...request, now: now + 60 });
    expect(refreshed.metrics.downloadedBars).toBeLessThan(first.metrics.downloadedBars);
  });

  it('recalculates native FMP floor after partial Massive failure, and direct FMP uses the same policy', async () => {
    const c = fixture.plans.find((item) => item.tf === '15m' && item.rth && item.visible === 1000) as PlanCase;
    const request = { symbol: 'SYN', timeframe: c.tf, rthOnly: c.rth, now: c.now, visibleBars: 1000 };
    const failing = harness({ failAfter: 1 }); const direct = harness({ emptyPool: true });
    const fallback = await failing.service.load(request); const native = await direct.service.load(request);
    expect(fallback.plan).toEqual(c.fmp); expect(native.plan).toEqual(c.fmp);
    expect(fallback.rows.every((row) => row.historicalProvider === 'FMP' && row.priceSource === 'HLC3_PROXY')).toBe(true);
    expect(fallback.rows).toEqual(native.rows); expect(fallback.warmupSatisfied).toBe(true);
    expect(fallback.coverage.adjustment).toBe('FMP_NATIVE_UNVERIFIED');
    expect(direct.requests).toHaveLength(0); expect(fallback.metrics.fmpRequests).toBe(failing.fmpRequests.length);
    const earliest = failing.fmpRequests.map((url) => new URL(url).searchParams.get('from')).filter((x): x is string => x !== null).sort()[0];
    expect(earliest).toBe(new Date((c.fmp?.historyFrom ?? 0) * 1000).toISOString().slice(0, 10));
  });

  it('exhausts only authorized stocks slots before FMP, reports insufficient history explicitly', async () => {
    const h = harness({ rateLimit: true }); const c = fixture.services[0] as ServiceCase;
    const result = await h.service.load({ symbol: 'SYN', timeframe: '1m', rthOnly: false, now: c.now, visibleBars: 1000 });
    expect(h.requests.map((url) => new URL(url).searchParams.get('apikey') ?? new URL(url).searchParams.get('apiKey'))).toEqual(['SYNTH_2', 'SYNTH_3', 'SYNTH_1', 'SYNTH_OPTIONS']);
    expect(result.plan.historicalProvider).toBe('FMP');
    const short = new UsHistoricalService({ router: h.router, fetchFn: () => Promise.resolve(ok({})), nowMs: () => c.now * 1000,
      fmp: { fetchHistoricalPaginated: () => Promise.resolve({ bars: [makeBar(c.now - 60, 1)], source: 'FMP_STABLE', endpoint: 'HISTORICAL_CHART', requestedAtUtcSec: c.now, httpStatus: 200, rows: 1, discarded: 0, legacyFallbackUsed: false, keyEnvName: 'MARKET', fromUtcSec: c.now - 60, toUtcSec: c.now }) } });
    const insufficient = await short.load({ symbol: 'NEW', timeframe: '1m', rthOnly: false, now: c.now, visibleBars: 1000 });
    expect(insufficient.warmupSatisfied).toBe(false); expect(insufficient.coverage.canonicalPrefix).toBe('MISSING_1M');
  });

  it('cancels the transport only when the last shared consumer aborts; never falls back on abort', async () => {
    const h = harness(); let aborted = false; let release: ((value: FetchResponse) => void) | undefined;
    const service = new UsHistoricalService({ router: h.router, fmp: h.fmp, nowMs: () => 0, fetchFn: (_url, signal) => new Promise((resolve, reject) => {
      release = resolve; signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    }) });
    const c = fixture.services[0] as ServiceCase; const a = new AbortController(); const b = new AbortController();
    const request = { symbol: 'SYN', timeframe: '1m' as const, rthOnly: false, now: c.now, visibleBars: 1000 };
    const first = service.load({ ...request, signal: a.signal }); const second = service.load({ ...request, signal: b.signal });
    a.abort(); await expect(first).rejects.toMatchObject({ name: 'AbortError' }); expect(aborted).toBe(false);
    b.abort(); await expect(second).rejects.toMatchObject({ name: 'AbortError' }); expect(aborted).toBe(true);
    release?.(ok({ results: [] })); expect(h.fmpRequests).toHaveLength(0);
  });

  it('continues saturated base pages without next_url, and rejects unsafe pagination atomically', async () => {
    const c = fixture.services.find((item) => item.tf === '1h' && item.rth) as ServiceCase;
    const h = harness({ omitNext: true });
    const request = { symbol: 'SYN', timeframe: c.tf, rthOnly: c.rth, now: c.now, visibleBars: 1000 };
    const result = await h.service.load(request);
    expect(result.rows).toHaveLength(c.finalBars); expect(result.metrics.pages).toBe(c.pages);
    for (const next of ['https://evil.invalid/v2/aggs/ticker/SYN', 'CYCLE']) {
      const broken = harness();
      const service = new UsHistoricalService({ router: broken.router, fmp: broken.fmp, nowMs: () => 0, fetchFn: (url) => {
        const page = new URL(url); page.searchParams.delete('apikey');
        return Promise.resolve(ok({ status: 'OK', results: [], next_url: next === 'CYCLE' ? page.toString() : next }));
      } });
      const fallback = await service.load(request);
      expect(fallback.metrics.fallbackCause).toMatch(/HISTORICAL_(INVALID_NEXT_URL|PAGINATION_CYCLE)/);
      expect(fallback.rows.every((row) => row.historicalProvider === 'FMP')).toBe(true);
    }
  });

  it('caches FMP histories independently, incrementally refreshes, and cancels native FMP HTTP', async () => {
    const h = harness({ emptyPool: true }); const c = fixture.services[0] as ServiceCase;
    const request = { symbol: 'SYN', timeframe: '5m' as const, rthOnly: false, now: c.now, visibleBars: 1000 };
    const cold = await h.service.load(request); const count = h.fmpRequests.length;
    const concurrent = harness({ emptyPool: true });
    await Promise.all([concurrent.service.load(request), concurrent.service.load({ ...request, timeframe: '15m' })]);
    expect(concurrent.fmpRequests.filter((url) => url.includes('/1min?'))).toHaveLength(h.fmpRequests.filter((url) => url.includes('/1min?')).length);
    const hot = await h.service.load(request); expect(h.fmpRequests).toHaveLength(count); expect(hot.metrics.cacheHit).toBe(true);
    h.advance(9000); const incremental = await h.service.load({ ...request, now: c.now + 60 });
    expect(incremental.metrics.downloadedBars).toBeLessThan(cold.metrics.downloadedBars);
    let cancelled = false;
    const client = new FmpEnterpriseClient({ config: resolveFmpConfig({ FMP_API_KEY: 'SYNTH_FMP_CANCEL' }), fetchFn: (_url, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => { cancelled = true; reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    }) });
    const service = new UsHistoricalService({ router: h.router, fmp: client, nowMs: () => 0, fetchFn: () => Promise.resolve(ok({})) });
    const controller = new AbortController(); const pending = service.load({ ...request, signal: controller.signal });
    controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); expect(cancelled).toBe(true);
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    }));
    try {
      const abort = new AbortController(); const native = createDefaultFmpHttpFn()('https://financialmodelingprep.com/stable/historical-chart/1min', abort.signal);
      abort.abort(); await expect(native).rejects.toMatchObject({ name: 'AbortError' });
    } finally { spy.mockRestore(); }
  });

  it('transports canonical provenance and compact moments through MarketRuntime without non-finite JSON', async () => {
    const h = harness(); const c = fixture.services[0] as ServiceCase;
    const runtime = new MarketRuntime({ apiKey: '', massiveEnv: { MASSIVE_KEY_2: 'SYNTH_RUNTIME_2' }, enableWs: false,
      fmpConfig: resolveFmpConfig({}), nowMsFn: () => c.now * 1000,
      fetchFn: (url) => url.includes('/range/1/day/') ? Promise.resolve(ok({ status: 'OK', results: [] })) : h.fetchFn(url) });
    try {
      const result = await runtime.getBars('SYN', '1m', { visibleBars: 20, includeOverlays: false });
      expect(result.bars).toHaveLength(20); expect(result.barsProvider).toBe('MASSIVE_REST');
      expect(result.historicalIntegrity?.warmupSatisfied).toBe(true);
      expect(result.historicalIntegrity?.observations).toHaveLength(20);
      expect(result.historicalIntegrity?.priceSource).toBe('REAL_VW');
      expect(JSON.stringify(result)).not.toMatch(/SYNTH_|NaN|Infinity/);
      const last = result.bars[result.bars.length - 1];
      expect(last?.vw).toBe(makeBar(last?.time ?? 0, 1).vw);
      expect(result.historicalIntegrity?.monthSeed.V).toBeGreaterThan(0);
    } finally { runtime.stopWs(); }
  });

  it('keeps mixed provenance explicit and serializes uncalculable moments as null', async () => {
    const h = harness(); const c = fixture.services[0] as ServiceCase;
    const result = await h.service.load({ symbol: 'SYN', timeframe: '1m', now: c.now, rthOnly: false, visibleBars: 1000 });
    const reference = fixture.vwCases.find((item) => item.bar.vw === 0) as VwCase;
    const proxy = historicalObservation(decodeBar(reference.bar), 'MASSIVE_REST', 1);
    const rows = result.rows.map((row) => row.bar.time === proxy.bar.time ? proxy : row);
    const dto = serializeHistoricalIntegrity({ ...result, rows, canonicalMonth: rows }, proxy.bar.time);
    expect(dto.priceSource).toBe('MIXED_VW_HLC3');
    expect(dto.observations.find((row) => row.time === proxy.bar.time)?.priceSource).toBe('HLC3_PROXY');
    compare(dto.observations.find((row) => row.time === proxy.bar.time)?.moments, reference.moments);
    const invalid = serializeHistoricalIntegrity({ ...result, rows: [{ ...proxy, moments: { PV: Number.NaN, V: 0, P2V: Infinity } }], canonicalMonth: [] }, proxy.bar.time);
    expect(invalid.observations[0]?.moments).toEqual({ PV: null, V: 0, P2V: null });
    expect(JSON.stringify(invalid)).not.toMatch(/NaN|Infinity/);
  });

  it('bounds retained observations across symbols and separates sessions and provider identities', async () => {
    const h = harness(); const c = fixture.services[0] as ServiceCase;
    const request = { symbol: 'SYN', timeframe: '1m' as const, now: c.now, rthOnly: false, visibleBars: 1000 };
    await h.service.load(request); const before = h.requests.length;
    await h.service.load({ ...request, rthOnly: true }); expect(h.requests.length).toBeGreaterThan(before);
    for (let i = 0; i < 8; i += 1) {
      const result = await h.service.load({ ...request, symbol: `SYN${String(i)}` });
      expect(result.metrics.cacheRows).toBeLessThanOrEqual(100000);
      expect(result.metrics.peakCacheRows).toBeLessThanOrEqual(100000);
    }
    const prior = h.requests.length; await h.service.load(request); expect(h.requests.length).toBeGreaterThan(prior);
  });

  it('invalidates the closed prefix after an OHLC revision at the incremental seam', async () => {
    const h = harness(); const c = fixture.services[0] as ServiceCase; let revised = false;
    const service = new UsHistoricalService({ router: h.router, fmp: h.fmp, nowMs: () => revised ? 9000 : 0, fetchFn: async (url) => {
      const response = await h.fetchFn(url);
      if (!revised) return response;
      const raw = JSON.parse(response.text) as { results: Record<string, number>[] };
      raw.results = raw.results.map((row) => ({ ...row, o: (row['o'] as number) + 100, h: (row['h'] as number) + 100, l: (row['l'] as number) + 100, c: (row['c'] as number) + 100, vw: (row['vw'] as number) + 100 }));
      return { ...response, text: JSON.stringify(raw) };
    } });
    const request = { symbol: 'SYN', timeframe: '1m' as const, now: c.now, rthOnly: false, visibleBars: 1000 };
    const original = await service.load(request); revised = true; const updated = await service.load(request);
    const old = historicalMomentsSince(original.canonicalMonth, original.plan.monthAnchor, c.now);
    const current = historicalMomentsSince(updated.canonicalMonth, updated.plan.monthAnchor, c.now);
    expect(updated.metrics.requests).toBe(2); expect(current.V).toBe(old.V);
    compare(current.PV, old.PV + 100 * old.V); compare(current.P2V, old.P2V + 200 * old.PV + 10000 * old.V);
  });
});
