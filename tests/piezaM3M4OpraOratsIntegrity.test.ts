import { WebSocketServer } from 'ws';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { applyOpraEvent, coalesceOptionQuoteUpdate, parseOpraWireRow, type OpraContractLiveState, type LiveOptionQuoteSnapshot } from '../src/core/opraOptionIntegrity.js';
import { parseOratsTradeDate, parseOratsUpdatedAtUtcSec } from '../src/core/oratsIntegrity.js';
import { normalizeWsPayload } from '../src/data/liveBarConsolidator.js';
import type { WsTradeEvent, WsQuoteEvent } from '../src/data/wsTypes.js';
import { MarketRuntime, type UsVolSurfaceResponse } from '../src/server/marketRuntime.js';
import { createHttpWsServer } from '../src/server/httpWsServer.js';
import { OratsHybridClient, type OratsHttpFn } from '../src/server/oratsHybridClient.js';
import { BitmaskConflationEngine, MarketStoreSoA, MAX_DELTA_ITEMS_PER_FRAME_V2, SOA_DELTA_STRIDE_V2, DELTA_FRAME_BUFFER_BYTES } from '../web/src/store/marketStoreSoa.js';

interface Step { event: Record<string, unknown> & { t: number }; reason: string | null; expected: Record<string, unknown> }
const fx = JSON.parse(readFileSync(new URL('../fixtures/pieza_m3_m4_reference.json', import.meta.url), 'utf8')) as {
  replay: Step[]; ties: Step[]; unsequenced: Step[]; wire: { ms: number; sec: number; count: number; stride: number; bytes: number };
  session: [number, number, number]; dates: Record<string, string | null>; start: number;
  breaker: { failures: number; retry: [number, number]; rateLimit: number }; endpoints: Record<string, string>;
  strikes: { strike: number; expirDate: string; dte: number }[]; pulse: string[];
};

function normalize(raw: Step['event']): WsQuoteEvent | WsTradeEvent {
  // The adapter requires a modern network epoch. Replay the normalized event at oracle time.
  const event = normalizeWsPayload({ ...raw, t: fx.start + raw.t }).events[0];
  if (event?.ev !== 'Q' && event?.ev !== 'T') throw new Error('Expected OPRA event');
  return { ...event, eventTimeMs: raw.t, timeSec: Math.floor(raw.t / 1000) };
}

describe('M3 · OPRA Q/T', () => {
  for (const [name, steps] of Object.entries({ replay: fx.replay, ties: fx.ties, unsequenced: fx.unsequenced })) {
    it(name + ' through the normalizer, reducer and broadcast gate', () => {
      const runtime = new MarketRuntime({ apiKey: '', enableWs: false, fetchFn: () => Promise.reject(new Error('offline')) });
      const inject = runtime as unknown as { handleOptionWsEvents(events: (WsQuoteEvent | WsTradeEvent)[]): void };
      const emitted = vi.fn();
      runtime.addWsListener(emitted);
      let state: OpraContractLiveState | undefined;
      let accepted = 0;
      for (const step of steps) {
        const ev = normalize(step.event);
        const result = applyOpraEvent(state, 'SPY', ev);
        expect(result.reason).toBe(step.reason);
        if (step.reason) expect(result.state).toBe(state);
        else accepted++;
        state = result.state;
        inject.handleOptionWsEvents([ev]);
        const { mid, ...exact } = step.expected;
        expect(runtime.getLiveOptionQuoteSnapshot(ev.sym)).toMatchObject(exact);
        expect(state?.snapshot).toMatchObject(exact);
        if (typeof mid === 'number') expect(Math.abs((state?.snapshot.mid ?? NaN) - mid)).toBeLessThanOrEqual(1e-9);
        expect(emitted).toHaveBeenCalledTimes(accepted);
      }
    });
  }

  it('converges across interleaved WebSocket windows and keeps quote-only last empty', () => {
    const incoming = fx.replay.map(s => {
      const ev = normalize(s.event);
      return parseOpraWireRow({ ...s.event, updatedChannels: [ev.ev], ...(ev.ev === 'Q'
        ? { quoteTimestampMs: ev.eventTimeMs, bid: ev.bidPrice, ask: ev.askPrice, bidSize: ev.bidSize, askSize: ev.askSize }
        : { tradeTimestampMs: ev.eventTimeMs, last: ev.price, size: ev.size }) }, ev.sym);
    });
    for (const order of [[0, 1, 2, 3, 4, 5], [1, 3, 0, 4, 5]]) {
      let row: LiveOptionQuoteSnapshot | undefined;
      for (const i of order) {
        const item = incoming[i];
        if (!item) throw new Error('Missing fixture');
        row = coalesceOptionQuoteUpdate(row, item);
        if (i === 0 && order[0] === 0) expect(row.last).toBeNull();
      }
      expect(row).toMatchObject({ quoteTimestamp: 110, tradeTimestamp: 105, last: 1.15, bidSize: 15, askSize: 25, updatedChannels: ['Q', 'T'] });
    }
  });

  it('rejects invalid book, size and clock and resets duplicate IDs at ET midnight', () => {
    const step = fx.replay[0];
    if (!step) throw new Error('Missing quote');
    const q = normalize(step.event);
    if (q.ev !== 'Q') throw new Error('Expected quote');
    for (const invalid of [{ bidPrice: NaN }, { askPrice: 0 }, { bidSize: -1 }, { eventTimeMs: 1e18 }]) {
      expect(applyOpraEvent(undefined, 'SPY', { ...q, ...invalid }).reason).toBe('INVALID_QUOTE');
    }
    let state: OpraContractLiveState | undefined;
    const reasons: (string | null)[] = [];
    for (const ms of fx.session) {
      const result = applyOpraEvent(state, 'SPY', { ev: 'T', sym: q.sym, timeSec: Math.floor(ms / 1000), eventTimeMs: ms, size: 3, price: 1, tradeId: 'reused' });
      reasons.push(result.reason);
      state = result.state;
    }
    expect(reasons).toEqual([null, 'DUPLICATE_TRADE', null]);
    expect(state?.snapshot).toMatchObject({ tradeCount: 1, tradeVolume: 3 });
  });

  it('keeps arrival ties deterministic and counts an explicitly eligible late print only once', () => {
    const quote = normalize({ ev: 'Q', sym: 'SPY', t: fx.wire.ms, bp: 1, ap: 2, bs: 4, as: 6 });
    if (quote.ev !== 'Q') throw new Error('Expected quote');
    const base = applyOpraEvent(undefined, 'SPY', quote, { arrivalSeq: 8 }).state;
    const other = { ...quote, bidSize: 0 };
    expect(applyOpraEvent(base, 'SPY', other, { arrivalSeq: 7 }).reason).toBe('STALE_ARRIVAL_TIE');
    expect(applyOpraEvent(base, 'SPY', other, { tiePolicy: 'REJECT_WITHOUT_SEQ' }).reason).toBe('UNSEQUENCED_TIE');
    const print = normalize({ ev: 'T', sym: 'SPY', t: fx.wire.ms, p: 1.15, s: 3, i: 'new' });
    if (print.ev !== 'T') throw new Error('Expected trade');
    const current = applyOpraEvent(base, 'SPY', print).state;
    const late = { ...print, eventTimeMs: fx.wire.ms - 1, price: 1, tradeId: 'late' };
    const policy = { lateTradeVolumePolicy: 'ACCUMULATE_IF_UNIQUE_ID' as const };
    const once = applyOpraEvent(current, 'SPY', late, policy);
    expect(once.state?.snapshot).toMatchObject({ tradeVolume: 6, tradeCount: 2, last: 1.15, tradeTimestampMs: fx.wire.ms });
    expect(applyOpraEvent(once.state, 'SPY', late, policy).reason).toBe('DUPLICATE_TRADE');
  });

  it('runs the worker message protocol with a loopback WebSocket and recycles the actual transferable', async () => {
    const ws = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>(resolve => ws.once('listening', resolve));
    const address = ws.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    type Batch = { type: string; count: number; stride: number; buffer: ArrayBuffer; bindings: [number, string][] };
    const messages: Batch[] = [];
    vi.stubGlobal('postMessage', (message: Batch, transfer: ArrayBuffer[] = []) => {
      messages.push(structuredClone(message, { transfer }));
    });
    vi.stubGlobal('onmessage', null);
    const workerModule = '../web/src/workers/marketFeed.worker.ts';
    await import(workerModule);
    const send = (data: Record<string, unknown>) => { (globalThis as unknown as { onmessage: (event: { data: Record<string, unknown> }) => void }).onmessage({ data }); };
    const main = new MarketStoreSoA();
    try {
      const connected = new Promise<import('ws').WebSocket>(resolve => ws.once('connection', resolve));
      send({ type: 'CONNECT', url: `ws://127.0.0.1:${String(address.port)}` });
      const peer = await connected;
      let epoch = 0;
      const scope = (focusSymbol: string) => { send({ type: 'SET_VIEW_SCOPE', view: 'options', focusMarket: 'US', focusSymbol, optionScopeEpoch: ++epoch }); };
      const apply = async (symbol: string, row: Record<string, unknown>) => {
        messages.length = 0;
        peer.send(JSON.stringify({ type: 'option_quotes_batch', underlying: symbol, schemaVersion: 2, quotes: [{ symbol: symbol + '261120C00600000', underlying: symbol, ...row }] }));
        await vi.waitFor(() => { expect(messages.some(m => m.type === 'DELTAS_READY')).toBe(true); });
        send({ type: 'PULL_DELTAS' });
        const batch = messages.find(m => m.type === 'DELTA_BATCH');
        if (!batch) throw new Error('Missing worker delta');
        expect(batch.buffer.byteLength).toBe(fx.wire.bytes);
        expect(batch.stride).toBe(fx.wire.stride);
        for (const [id, name] of batch.bindings) main.bindSymbolId(id, name);
        main.applyBinaryDelta(new Float64Array(batch.buffer), batch.count, batch.stride);
        send({ type: 'RETURN_BUFFER', buffer: structuredClone(batch.buffer, { transfer: [batch.buffer] }) });
      };
      scope('SPY');
      await apply('SPY', { updatedChannels: ['Q'], bid: 1, ask: 1.2, mid: 1.1, bidSize: 10, askSize: 20, quoteTimestampMs: fx.wire.ms });
      expect(main.last[0]).toBeNaN();
      await apply('SPY', { updatedChannels: ['T'], last: 1.15, size: 3, tradeTimestampMs: fx.wire.ms + 4321 });
      expect([main.quoteTimestampMs[0], main.tradeTimestampMs[0], main.lastSize[0], main.bidSize[0], main.askSize[0]]).toEqual([fx.wire.ms, fx.wire.ms + 4321, 3, 10, 20]);
      scope('QQQ');
      await apply('QQQ', { updatedChannels: ['T'], last: .9, size: 0, tradeTimestampMs: fx.wire.ms });
      expect(main.getId('QQQ261120C00600000')).toBe(0);
      expect(main.bid[0]).toBeNaN();
      expect(main.quoteTimestampMs[0]).toBeNaN();
    } finally {
      send({ type: 'DISCONNECT' });
      for (const peer of ws.clients) peer.terminate();
      await new Promise<void>(resolve => { ws.close(() => { resolve(); }); });
      vi.unstubAllGlobals();
    }
  });

  it('transfers 100 contracts at exact millisecond precision and clears reassigned slots', () => {
    const { bytes, count, stride, ms, sec } = fx.wire;
    expect([MAX_DELTA_ITEMS_PER_FRAME_V2, SOA_DELTA_STRIDE_V2, DELTA_FRAME_BUFFER_BYTES]).toEqual([count, stride, bytes]);
    const stage = new MarketStoreSoA(count);
    const main = new MarketStoreSoA(count);
    const bits = new BitmaskConflationEngine(count);
    const frame = new Float64Array(new ArrayBuffer(bytes));
    bits.setAllVisible(true);
    for (let i = 0; i < count; i++) {
      const symbol = 'SPY261120C' + String(i).padStart(8, '0');
      stage.bindSymbolId(i, symbol);
      main.bindSymbolId(i, symbol);
      stage.writeNbboQuoteInPlace(i, 1, 1.2, i === 0 ? NaN : 10, 0, sec, ms);
      if (i !== 0) stage.writeTradeInPlace(i, 1.15, 3, sec + 5, ms + 5001);
      bits.markDirty(i);
    }
    expect(bits.packVisibleDirtyDelta(stage, frame, count, stride)).toBe(count);
    expect(main.applyBinaryDelta(frame, count, stride)).toBe(count);
    expect(main.last[0]).toBeNaN();
    expect(main.hasBidSize[0]).toBe(0);
    expect(main.hasAskSize[0]).toBe(1);
    expect(main.askSize[0]).toBe(0);
    expect(main.quoteTimestamp[99]).toBe(sec);
    expect(main.quoteTimestampMs[99]).toBe(ms);
    expect(main.tradeTimestamp[99]).toBe(sec + 5);
    expect(main.tradeTimestampMs[99]).toBe(ms + 5001);
    expect([main.last[99], main.bidSize[99], main.askSize[99], main.lastSize[99]]).toEqual([1.15, 10, 0, 3]);
    main.bindSymbolId(99, 'SPY270101P00000100');
    for (const array of [main.bid, main.ask, main.last, main.quoteTimestamp, main.tradeTimestamp, main.quoteTimestampMs, main.tradeTimestampMs, main.iv, main.gamma, main.delta]) expect(array[99]).toBeNaN();
    for (const array of [main.lastSize, main.bidSize, main.askSize, main.hasBidSize, main.hasAskSize, main.hasLastSize]) expect(array[99]).toBe(0);
    main.writeTradeInPlace(99, 10, 1, sec, ms);
    expect(main.getFieldValue(99, 'mid')).toBeNaN();
    main.resetOptionSlots();
    expect(main.getCount()).toBe(0);
    expect(main.registerSymbol('SPY270101P00000100')).toBe(0);
  });
});

const input = { ticker: 'SPY', massiveSpotPrice: null, massiveSpotSourceMode: 'UNAVAILABLE' as const, yangZhangAdrVol: NaN, forceRefresh: true };
type Reply = Awaited<ReturnType<OratsHttpFn>>;
const response = (data: unknown, status = 200): Reply => ({
  ok: status === 200, status, json: () => Promise.resolve(data), text: () => Promise.resolve(''),
});
function provider() {
  const plan = {
    now: fx.start, date: '2026-11-19' as string | null, strikes: (): Promise<Reply> => Promise.resolve(response({ data: fx.strikes })),
    cores: (): Promise<Reply> => Promise.resolve(response({ data: [{ ticker: 'SPY', smvVol: 0.33, tradeDate: plan.date, updatedAt: '2026-11-20T18:00:00Z' }] })),
    rank: (): Promise<Reply> => Promise.resolve(response({ data: [{ ticker: 'SPY', tradeDate: plan.date, iv: .3, ivRank1y: 22, ivPct1y: 21 }] })),
  };
  const calls = { cores: 0, strikes: 0, ivrank: 0 };
  const client = new OratsHybridClient({ env: { ORATS_API_KEY: 'fixture' }, nowMsFn: () => plan.now,
    fetchFn: (url) => {
      const endpoint = new URL(url).pathname.split('/').pop();
      if (endpoint !== 'cores' && endpoint !== 'strikes' && endpoint !== 'ivrank') throw new Error('Unknown endpoint');
      calls[endpoint]++;
      return endpoint === 'ivrank' ? plan.rank() : plan[endpoint]();
    } });
  return { plan, calls, client, load: () => client.fetchHybridSurface(input) };
}

describe('M4 · ORATS', () => {
  it('distinguishes a partial response from a healthy empty surface and a stale 12-strike surface', async () => {
    const { client, plan, load } = provider();
    plan.strikes = () => Promise.resolve(response({}, 503));
    expect(await load()).toMatchObject({ status: fx.endpoints['partial'], tradeDate: plan.date, strikes: [], surfaceCompleteness: fx.endpoints['incomplete'],
      reason: fx.endpoints['reason'], endpoints: { cores: { ok: true }, strikes: { ok: false, httpStatus: 503, consecutiveFailures: 1 } } });
    plan.strikes = () => Promise.resolve(response({ data: [] }));
    expect(await load()).toMatchObject({ status: 'OPERATIONAL', endpoints: { strikes: { ok: true, payloadState: fx.endpoints['empty'] } } });
    plan.strikes = () => Promise.resolve(response({ data: fx.strikes }));
    const healthy = await load();
    expect(healthy).toMatchObject({ status: 'OPERATIONAL', tradeDateVerified: true, providerUpdatedAtUtcSec: 1795197600 });
    plan.now += 30_001;
    plan.date = '2026-11-20';
    plan.strikes = () => Promise.resolve(response({}, 503));
    const stale = await load();
    expect(stale).toMatchObject({ status: fx.endpoints['stale'], dataProvenance: 'STALE_CACHE', tradeDate: '2026-11-19', stale: true,
      cacheAgeMs: 30001, strikes: fx.strikes, reason: fx.endpoints['reason'] });
    expect(client.getHealthSnapshot().healthStatus).toBe('STALE_CACHE');
    expect(await client.fetchHybridSurface({ ...input, forceRefresh: false })).toMatchObject({ status: 'STALE_CACHE', strikes: fx.strikes });
  });

  it('accepts only Gregorian provider dates and zoned provider timestamps', async () => {
    for (const [raw, expected] of Object.entries(fx.dates)) expect(parseOratsTradeDate(raw)).toBe(expected);
    expect(parseOratsUpdatedAtUtcSec('2026-11-20T18:00:00')).toBeNull();
    for (const date of [null, '2026-02-30']) {
      const { plan, load } = provider();
      plan.date = date;
      expect(await load()).toMatchObject({ status: 'PARTIAL_FAILURE', tradeDate: null, tradeDateVerified: false, receivedAtUtcSec: fx.start / 1000 });
    }
  });

  it('classifies transport, HTTP and schema errors without turning error objects into rows', async () => {
    const scenarios: [() => Promise<Reply>, string][] = [
      [() => Promise.reject(Object.assign(new Error('timeout'), { name: 'AbortError' })), 'TIMEOUT'],
      [() => Promise.reject(new Error('offline')), 'NETWORK_ERROR'],
      [() => Promise.resolve({ ...response({}), json: () => Promise.reject(new SyntaxError()) }), 'INVALID_JSON'],
      [() => Promise.resolve(response({ error: 'limit' })), 'INVALID_SCHEMA'],
      [() => Promise.resolve(response({ data: [{}] })), 'INVALID_SCHEMA'],
      [() => Promise.resolve(response({}, 429)), 'HTTP_429'],
      [() => Promise.resolve(response({}, 401)), 'HTTP_4XX'],
      [() => Promise.resolve(response({ data: [] })), 'UNEXPECTED_EMPTY'],
    ];
    for (const [reply, errorKind] of scenarios) {
      const { plan, load } = provider();
      plan.cores = reply;
      expect(await load()).toMatchObject({ status: 'UNAVAILABLE', endpoints: { cores: { errorKind, consecutiveFailures: 1 } } });
    }
  });

  it('opens independently, excludes concurrent half-open probes, backs off and recovers', async () => {
    const { plan, calls, load } = provider();
    plan.strikes = () => Promise.resolve(response({}, 503));
    for (let i = 0; i < fx.breaker.failures; i++) await load();
    const blocked = await load();
    expect(blocked.endpoints?.strikes).toMatchObject({ circuitState: 'OPEN', errorKind: 'CIRCUIT_OPEN', nextRetryAtMs: fx.breaker.retry[0] });
    expect(calls).toMatchObject({ strikes: 3, cores: 4 });
    plan.now = fx.breaker.retry[0];
    let resolveProbe: ((r: Reply) => void) | undefined;
    plan.strikes = () => new Promise(resolve => { resolveProbe = resolve; });
    const probe = load();
    const busy = await load();
    expect(busy.endpoints?.strikes).toMatchObject({ errorKind: 'HALF_OPEN_PROBE_BUSY', halfOpenProbeInFlight: true });
    expect(calls.strikes).toBe(4);
    if (!resolveProbe) throw new Error('Missing probe');
    resolveProbe(response({}, 503));
    expect((await probe).endpoints?.strikes).toMatchObject({ circuitState: 'OPEN', openCycles: 2, nextRetryAtMs: fx.breaker.retry[1], halfOpenProbeInFlight: false });
    plan.now = fx.breaker.retry[1];
    plan.strikes = () => Promise.resolve(response({ data: [] }));
    expect(await load()).toMatchObject({ status: 'OPERATIONAL', endpoints: { strikes: { ok: true, circuitState: 'CLOSED', consecutiveFailures: 0, openCycles: 0 } } });
  });

  it('keeps IV rank cache independent and requires a verified date to recover', async () => {
    const { plan, client, load } = provider();
    expect((await client.fetchIvRank('SPY')).status).toBe('OPERATIONAL');
    plan.rank = () => Promise.resolve(response({}, 429));
    for (let i = 0; i < 3; i++) expect(await client.fetchIvRank('SPY', true)).toMatchObject({ status: 'STALE_CACHE', row: { tradeDate: plan.date } });
    expect(client.getCircuitBreaker(plan.now).endpoints.ivrank.nextRetryAtMs).toBe(fx.breaker.rateLimit);
    plan.cores = () => Promise.resolve(response({}, 503));
    for (let i = 0; i < 3; i++) await load();
    plan.now = fx.breaker.retry[0];
    plan.cores = () => Promise.resolve(response({ data: [{ smvVol: .3 }] }));
    expect((await load()).endpoints?.cores).toMatchObject({ circuitState: 'OPEN', openCycles: 2, providerTradeDate: null });
  });

  it('propagates 503 through the HTTP surface, health, providers and six-key pulse outside session', async () => {
    const { client, plan } = provider();
    const runtime = new MarketRuntime({ apiKey: '', nowMsFn: () => fx.start, enableWs: false, oratsClient: client, fetchFn: () => Promise.reject(new Error('offline')) });
    // Isolate the unrelated underlying-bar loaders. Exercise real surface caches and HTTP handlers.
    vi.spyOn(runtime, 'getSnapshot').mockResolvedValue({ envelope: { snapshot: { metrics: { spot: null } } }, marketContext: { unifiedQuotes: [] } } as unknown as Awaited<ReturnType<typeof runtime.getSnapshot>>);
    vi.spyOn(runtime, 'getCachedDailyBars1d').mockResolvedValue({ bars: [] } as unknown as Awaited<ReturnType<typeof runtime.getCachedDailyBars1d>>);
    const server = createHttpWsServer({ runtime, env: {}, port: 0, enableBackgroundWarmup: false });
    const { host, port } = await server.start();
    const base = `http://${host}:${String(port)}`;
    const url = base + '/api/us/vol-surface?symbol=SPY';
    try {
      plan.strikes = () => Promise.resolve(response({}, 503));
      const first = await (await fetch(url)).json() as UsVolSurfaceResponse;
      expect(first).toMatchObject({ status: 'PARTIAL', providerTradeDate: plan.date, endpoints: { strikes: { ok: false } } });
      expect(await (await fetch(base + '/api/health')).json()).toMatchObject({ orats: { healthStatus: 'PARTIAL_FAILURE' } });
      expect(await (await fetch(base + '/api/us/providers-status')).json()).toMatchObject({ providers: { ORATS: { connected: false, healthStatus: 'PARTIAL_FAILURE' } } });
      const clock = vi.spyOn(Date, 'now').mockReturnValue(fx.start);
      try {
        const pulse = server.feedsHealthMonitor.getPulse().providers.find(p => p.id === 'ORATS_API');
        expect(Object.keys(pulse ?? {}).sort()).toEqual(fx.pulse);
        expect(pulse).toMatchObject({ state: 'DEGRADED', sessionMode: 'OUT_OF_SESSION' });
      } finally { clock.mockRestore(); }
      plan.strikes = () => Promise.resolve(response({ data: fx.strikes }));
      expect(await (await fetch(url)).json()).toMatchObject({ status: 'OK' });
      plan.strikes = () => Promise.resolve(response({}, 503));
      for (const target of [url + '&force=true', url]) expect(await (await fetch(target)).json()).toMatchObject({
        status: 'PARTIAL', healthStatus: 'STALE_CACHE', stale: true, surface: { status: 'STALE_CACHE', strikes: fx.strikes } });
    } finally { await server.stop(); }
  });
});
