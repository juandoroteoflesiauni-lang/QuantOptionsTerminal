import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  L2_THROTTLE_MS,
  TABLE_THROTTLE_MS,
  createAtomicKeyedStore,
  normalizeOptionContractKey,
} from '../src/core/atomicQuoteStore.js';
import type {
  MassiveWsClientOptions,
  WsNormalizedEvent,
  WsQuoteEvent,
  WsTradeEvent,
} from '../src/data/wsTypes.js';
import { ArgentinaMarketRuntime } from '../src/server/argentinaMarketLoader.js';
import { createHttpWsServer, type HttpWsServerHandle } from '../src/server/httpWsServer.js';
import { MarketRuntime } from '../src/server/marketRuntime.js';
import type { OrderBook5LevelsDto } from '../src/server/primaryRofexLoader.js';
import {
  WS_BACKPRESSURE_CLOSE_CODE,
  WS_HIGH_WATER_MARK,
  WS_KILL_WATER_MARK,
  WS_LOW_WATER_MARK,
  WS_MAX_MISSED_HEARTBEATS,
  computeOrderBookSignature,
  evaluateHeartbeatSweep,
  evaluateWsBackpressure,
  extractOptionUnderlying,
  hasMarketQuoteChanged,
  hasOptionQuoteChanged,
  normalizeViewScope,
  resolveScopedL2Symbol,
  shouldEmitGgalBarTickToClient,
  shouldEmitOptionQuoteToClient,
  type BackpressureDecision,
  type HeartbeatDecision,
  type LiveOptionQuoteSnapshot,
  type MarketTickQuoteLike,
} from '../src/server/wsViewScopeBackpressure.js';

interface PerfPhase1ReferenceFixture {
  readonly meta: {
    readonly highWaterMark: number;
    readonly lowWaterMark: number;
    readonly killWaterMark: number;
    readonly maxMissedHeartbeats: number;
    readonly backpressureCloseCode: number;
  };
  readonly extractUnderlying: readonly { readonly input: string; readonly expected: string | null }[];
  readonly optionEmitCases: readonly {
    readonly view: string | null;
    readonly focusSymbol: string | null;
    readonly underlying: string | null;
    readonly expected: boolean;
  }[];
  readonly l2ScopeCases: readonly {
    readonly view: string | null;
    readonly focusSymbol: string | null;
    readonly expected: string | null;
  }[];
  readonly backpressureCases: readonly {
    readonly bufferedAmount: number;
    readonly currentlyConflating: boolean;
    readonly expected: BackpressureDecision;
  }[];
  readonly heartbeatSequence: readonly {
    readonly pongReceived: boolean;
    readonly consecutiveMissed: number;
    readonly expected: HeartbeatDecision;
  }[];
  readonly marketQuoteDiffCases: readonly {
    readonly name: string;
    readonly prev: MarketTickQuoteLike | null;
    readonly next: MarketTickQuoteLike;
    readonly expected: boolean;
  }[];
  readonly optionQuoteDiffCases: readonly {
    readonly name: string;
    readonly prev: LiveOptionQuoteSnapshot | null;
    readonly next: LiveOptionQuoteSnapshot;
    readonly expected: boolean;
  }[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(resolve(HERE, '../fixtures/perf_phase1_reference.json'), 'utf8'),
) as PerfPhase1ReferenceFixture;
const TOL = 1e-9;

const FIXED_NOW_MS = Date.UTC(2026, 2, 18, 15, 0, 0);
const FIXED_NOW_SEC = Math.floor(FIXED_NOW_MS / 1_000);

describe('Pieza 48 — referencia Python independiente (scope, diff, contrapresión, heartbeat)', () => {
  it('coincide con las constantes y reglas de water-marks dentro de 1e-9', () => {
    expect(Math.abs(WS_HIGH_WATER_MARK - FIXTURE.meta.highWaterMark)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(WS_LOW_WATER_MARK - FIXTURE.meta.lowWaterMark)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(WS_KILL_WATER_MARK - FIXTURE.meta.killWaterMark)).toBeLessThanOrEqual(TOL);
    expect(WS_MAX_MISSED_HEARTBEATS).toBe(FIXTURE.meta.maxMissedHeartbeats);
    expect(WS_BACKPRESSURE_CLOSE_CODE).toBe(FIXTURE.meta.backpressureCloseCode);
  });

  it('extrae correctamente los subyacentes de símbolos OPRA y BYMA', () => {
    for (const tc of FIXTURE.extractUnderlying) {
      expect(extractOptionUnderlying(tc.input)).toBe(tc.expected);
    }
  });

  it('filtra emisiones option_quotes_batch y L2 según scope de vista', () => {
    for (const tc of FIXTURE.optionEmitCases) {
      const scope = normalizeViewScope({ view: tc.view, focusSymbol: tc.focusSymbol });
      expect(shouldEmitOptionQuoteToClient(scope, tc.underlying)).toBe(tc.expected);
    }
    for (const tc of FIXTURE.l2ScopeCases) {
      const scope = normalizeViewScope({ view: tc.view, focusSymbol: tc.focusSymbol });
      expect(resolveScopedL2Symbol(scope)).toBe(tc.expected);
    }
    expect(shouldEmitGgalBarTickToClient(normalizeViewScope({ view: 'ggal_specialist', focusSymbol: 'NVDA' }))).toBe(true);
    expect(shouldEmitGgalBarTickToClient(normalizeViewScope({ view: 'stock_detail', focusSymbol: 'GGAL' }))).toBe(true);
    expect(shouldEmitGgalBarTickToClient(normalizeViewScope({ view: 'stock_detail', focusSymbol: 'NVDA' }))).toBe(false);
    expect(shouldEmitGgalBarTickToClient(normalizeViewScope({ view: 'options', focusSymbol: 'GGAL' }))).toBe(false);
  });

  it('aplica histéresis de contrapresión (256 KB / 64 KB / 4 MB) y barrido de heartbeat', () => {
    for (const tc of FIXTURE.backpressureCases) {
      expect(evaluateWsBackpressure(tc.bufferedAmount, tc.currentlyConflating)).toEqual(tc.expected);
    }
    for (const step of FIXTURE.heartbeatSequence) {
      expect(evaluateHeartbeatSweep(step.pongReceived, step.consecutiveMissed)).toEqual(step.expected);
    }
  });

  it('detecta diff real en market quotes, option quotes y firmas L2', () => {
    for (const tc of FIXTURE.marketQuoteDiffCases) {
      expect(hasMarketQuoteChanged(tc.prev ?? undefined, tc.next)).toBe(tc.expected);
    }
    for (const tc of FIXTURE.optionQuoteDiffCases) {
      expect(hasOptionQuoteChanged(tc.prev ?? undefined, tc.next)).toBe(tc.expected);
    }
    expect(
      computeOrderBookSignature({
        symbol: 'GGAL',
        asOfUtcSec: FIXED_NOW_SEC,
        bids: [{ price: 7000, size: 100 }],
        asks: [{ price: 7010, size: 50 }],
      }),
    ).toBe(
      computeOrderBookSignature({
        symbol: 'GGAL',
        asOfUtcSec: FIXED_NOW_SEC,
        bids: [{ price: 7000, size: 100 }],
        asks: [{ price: 7010, size: 50 }],
      }),
    );
  });
});

describe('Pieza 48 — aislamiento y throttling del store externo atómico', () => {
  it('aisla suscriptores por clave exacta (un tick de NVDA notifica 0 veces a GGAL)', () => {
    let nowMs = 10_000;
    const store = createAtomicKeyedStore<{ readonly price: number }>({
      nowMsFn: () => nowMs,
    });

    const nvdaCalls: number[] = [];
    const ggalCalls: number[] = [];

    const unsubNvda = store.subscribeKey('US:NVDA', () => {
      nvdaCalls.push(store.get('US:NVDA')?.price ?? Number.NaN);
    });
    const unsubGgal = store.subscribeKey('AR:GGAL', () => {
      ggalCalls.push(store.get('AR:GGAL')?.price ?? Number.NaN);
    });

    store.set('AR:GGAL', { price: 7000 });
    expect(ggalCalls).toEqual([7000]);
    expect(nvdaCalls).toEqual([]);

    store.set('US:NVDA', { price: 141.5 });
    store.set('US:NVDA', { price: 142.0 });
    store.set('US:NVDA', { price: 142.5 });

    expect(nvdaCalls).toEqual([141.5, 142.0, 142.5]);
    expect(ggalCalls).toEqual([7000]);
    expect(normalizeOptionContractKey('o:nvda261120c00140000')).toBe('NVDA261120C00140000');

    unsubNvda();
    unsubGgal();
    nowMs += 1;
  });

  it('respeta cadencias diferenciadas (L2 100 ms / Tablas 250 ms) con leading + trailing', async () => {
    vi.useFakeTimers();
    try {
      let nowMs = 1_000;
      const store = createAtomicKeyedStore<{ readonly v: number }>({
        nowMsFn: () => nowMs,
      });

      const l2Hits: number[] = [];
      const tableHits: number[] = [];
      const unsubL2 = store.subscribeKeyThrottled('L2:GGAL', L2_THROTTLE_MS, () => {
        l2Hits.push(store.get('L2:GGAL')?.v ?? -1);
      });
      const unsubTbl = store.subscribeKeyThrottled('TBL:NVDA', TABLE_THROTTLE_MS, () => {
        tableHits.push(store.get('TBL:NVDA')?.v ?? -1);
      });

      expect(L2_THROTTLE_MS).toBe(100);
      expect(TABLE_THROTTLE_MS).toBe(250);

      // Leading edge fires at t=0
      store.set('L2:GGAL', { v: 1 });
      store.set('TBL:NVDA', { v: 10 });
      expect(l2Hits).toEqual([1]);
      expect(tableHits).toEqual([10]);

      // Ráfaga dentro de ventana
      nowMs = 1_040;
      await vi.advanceTimersByTimeAsync(40);
      store.set('L2:GGAL', { v: 2 });
      store.set('L2:GGAL', { v: 3 });
      store.set('TBL:NVDA', { v: 20 });
      store.set('TBL:NVDA', { v: 30 });
      expect(l2Hits).toEqual([1]);
      expect(tableHits).toEqual([10]);

      // A los 100 ms solo debe disparar L2; Tabla espera 250 ms
      nowMs = 1_105;
      await vi.advanceTimersByTimeAsync(65);
      expect(l2Hits).toEqual([1, 3]);
      expect(tableHits).toEqual([10]);

      // A los 255 ms dispara trailing de Tabla con el último valor (30)
      nowMs = 1_255;
      await vi.advanceTimersByTimeAsync(150);
      expect(tableHits).toEqual([10, 30]);

      unsubL2();
      unsubTbl();
    } finally {
      vi.useRealTimers();
    }
  });
});

interface ParsedWsEnvelope {
  readonly type?: string;
  readonly underlying?: string | null;
  readonly quotes?: readonly LiveOptionQuoteSnapshot[];
  readonly delta?: {
    readonly type?: string;
    readonly deltaRevision?: number;
    readonly quotes?: readonly { readonly market: string; readonly symbol: string; readonly price: number }[];
    readonly liveOrderBook?: { readonly symbol: string };
  };
}

function makeFakeOrderBookDto(symbol: string, bidPx: number, askPx: number): OrderBook5LevelsDto {
  return {
    symbol,
    marketSymbol: `${symbol} · 24hs`,
    settlement: '24hs',
    marketState: 'LIVE',
    source: 'PRIMARY_MERV',
    asOfUtcSec: FIXED_NOW_SEC,
    bids: [{ price: bidPx, size: 100, orderCount: 2 }],
    asks: [{ price: askPx, size: 90, orderCount: 1 }],
    bestBid: bidPx,
    bestAsk: askPx,
    mid: 0.5 * (bidPx + askPx),
    spreadArs: askPx - bidPx,
    spreadPct: ((askPx - bidPx) / bidPx) * 100,
    bidDepthSize: 100,
    askDepthSize: 90,
    vwapBid5: bidPx,
    vwapAsk5: askPx,
    vwapBook5: 0.5 * (bidPx + askPx),
    obi5: 0.05,
    last: bidPx,
    open: bidPx,
    high: askPx,
    low: bidPx,
    close: bidPx,
    settlementPrice: null,
    nominalVolume: 1_000,
  };
}

function makeStockTrade(sym: string, price: number): WsTradeEvent {
  return {
    ev: 'T',
    sym,
    price,
    size: 10,
    timeSec: FIXED_NOW_SEC,
    eventTimeMs: FIXED_NOW_MS,
  };
}

function makeOptionQuote(sym: string, bidPrice: number, askPrice: number): WsQuoteEvent {
  return {
    ev: 'Q',
    sym,
    bidPrice,
    askPrice,
    bidSize: 10,
    askSize: 10,
    timeSec: FIXED_NOW_SEC,
    eventTimeMs: FIXED_NOW_MS,
  };
}

async function openWsClientWithCollector(url: string): Promise<{
  readonly client: WebSocket;
  readonly messages: ParsedWsEnvelope[];
}> {
  const messages: ParsedWsEnvelope[] = [];
  const client = new WebSocket(url);
  client.on('message', (raw) => {
    const text = typeof raw === 'string' ? raw : Buffer.from(raw as Uint8Array).toString('utf8');
    messages.push(JSON.parse(text) as ParsedWsEnvelope);
  });
  await new Promise<void>((resolveOpen, rejectOpen) => {
    client.once('open', () => {
      resolveOpen();
    });
    client.once('error', rejectOpen);
  });
  return { client, messages };
}

describe('Pieza 48 — servidor WS view-scoped, diff real, backpressure y heartbeat', () => {
  const handles: HttpWsServerHandle[] = [];

  afterAll(async () => {
    for (const h of handles.splice(0)) {
      await h.stop();
    }
  });

  async function createTestServer(opts?: {
    readonly heartbeatIntervalMs?: number;
    readonly optionFlushIntervalMs?: number;
    readonly getClientBufferedAmount?: (client: WebSocket) => number;
  }): Promise<{
    readonly server: HttpWsServerHandle;
    readonly runtime: MarketRuntime;
    readonly arRuntime: ArgentinaMarketRuntime;
    readonly wsUrl: string;
    readonly port: number;
  }> {
    let capturedOnStockEvents = false;
    const runtime = new MarketRuntime({
      apiKey: 'TEST_KEY',
      secrets: ['TEST_KEY'],
      nowMsFn: () => FIXED_NOW_MS,
      enableWs: true,
      watchedSymbols: ['SPY', 'NVDA', 'AAPL'],
      createWsClientFn: (wsOpts: MassiveWsClientOptions) => {
        if (wsOpts.cluster === 'stocks') capturedOnStockEvents = true;
        return {
          connect: () => Promise.resolve(),
          subscribe: () => undefined,
          unsubscribe: () => undefined,
          close: () => undefined,
          getSnapshot: () => ({
            cluster: wsOpts.cluster,
            url: `wss://socket.massive.com/${wsOpts.cluster}`,
            state: 'ready',
            subscriptions: [],
            activeQuoteSubscriptionCount: 0,
            queueDepth: 0,
            droppedQueueMessages: 0,
            reconnectAttempts: 0,
            totalMessagesReceived: 0,
            discardedPayloads: 0,
            lastError: null,
          }),
        };
      },
      fetchFn: () => Promise.reject(new Error('offline')),
    });
    const arRuntime = new ArgentinaMarketRuntime({
      nowMsFn: () => FIXED_NOW_MS,
      minData912IntervalMs: 0,
      fetchFn: () => Promise.resolve({ ok: true, status: 200, text: '[]', headers: {} }),
    });
    const server = createHttpWsServer({
      runtime,
      arRuntime,
      host: '127.0.0.1',
      port: 0,
      startRuntimeWs: true,
      enableBackgroundWarmup: false,
      ...(opts?.heartbeatIntervalMs !== undefined
        ? { heartbeatIntervalMs: opts.heartbeatIntervalMs }
        : {}),
      ...(opts?.optionFlushIntervalMs !== undefined
        ? { optionFlushIntervalMs: opts.optionFlushIntervalMs }
        : {}),
      ...(opts?.getClientBufferedAmount !== undefined
        ? { getClientBufferedAmount: opts.getClientBufferedAmount }
        : {}),
    });
    handles.push(server);
    const { host, port } = await server.start();
    await vi.waitFor(() => {
      expect(capturedOnStockEvents).toBe(true);
    });
    return {
      server,
      runtime,
      arRuntime,
      port,
      wsUrl: `ws://${host}:${String(port)}/ws`,
    };
  }

  it('set_view_scope filtra option_quotes_batch (0 en stock_detail/ggal_specialist, solo focusSymbol sin duplicados en options) y acota L2', async () => {
    const { runtime, arRuntime, wsUrl } = await createTestServer({ optionFlushIntervalMs: 40 });
    vi.spyOn(arRuntime, 'getCachedPrimaryMervBook').mockImplementation((rawTicker: string) => {
      const clean = rawTicker.trim().toUpperCase();
      if (clean === 'GGAL') return makeFakeOrderBookDto('GGAL', 7050, 7060);
      if (clean === 'YPFD') return makeFakeOrderBookDto('YPFD', 41200, 41350);
      return null;
    });

    const { client: stockClient, messages: stockMsgs } = await openWsClientWithCollector(wsUrl);
    const { client: ggalClient, messages: ggalMsgs } = await openWsClientWithCollector(wsUrl);
    const { client: optionsClient, messages: optionsMsgs } = await openWsClientWithCollector(wsUrl);

    stockClient.send(JSON.stringify({ type: 'set_view_scope', view: 'stock_detail', focusSymbol: 'YPFD', focusMarket: 'AR' }));
    ggalClient.send(JSON.stringify({ type: 'set_view_scope', view: 'ggal_specialist', focusSymbol: 'GGAL', focusMarket: 'AR' }));
    optionsClient.send(JSON.stringify({ type: 'set_view_scope', view: 'options', focusSymbol: 'NVDA', focusMarket: 'US' }));

    await new Promise<void>((r) => setTimeout(r, 80));

    const optInjector = runtime as unknown as {
      handleOptionWsEvents(events: readonly WsNormalizedEvent[]): void;
    };
    const stockInjector = runtime as unknown as {
      handleStockWsEvents(events: readonly WsNormalizedEvent[]): void;
    };

    // Primer lote de opciones: NVDA, SPY y AAPL (950 contratos en backend, cliente solo recibe focusSymbol)
    optInjector.handleOptionWsEvents([
      makeOptionQuote('O:NVDA261120C00140000', 5.2, 5.4),
      makeOptionQuote('O:SPY261120C00600000', 8.1, 8.3),
      makeOptionQuote('O:AAPL261120P00220000', 3.4, 3.6),
    ]);
    stockInjector.handleStockWsEvents([makeStockTrade('NVDA', 142.5)]);

    await vi.waitFor(() => {
      const optBatches = optionsMsgs.filter((m) => m.type === 'option_quotes_batch');
      expect(optBatches.length).toBeGreaterThanOrEqual(1);
    });

    // Segundo envío IDÉNTICO para NVDA -> diff real suprime duplicados
    const countBeforeDuplicate = optionsMsgs.filter((m) => m.type === 'option_quotes_batch').length;
    optInjector.handleOptionWsEvents([makeOptionQuote('O:NVDA261120C00140000', 5.2, 5.4)]);
    await new Promise<void>((r) => setTimeout(r, 130));
    const countAfterDuplicate = optionsMsgs.filter((m) => m.type === 'option_quotes_batch').length;
    expect(countAfterDuplicate).toBe(countBeforeDuplicate);

    // Tercer envío con cambio real de precio para NVDA -> emite 1 nuevo lote
    optInjector.handleOptionWsEvents([makeOptionQuote('O:NVDA261120C00140000', 5.35, 5.55)]);
    await vi.waitFor(() => {
      expect(optionsMsgs.filter((m) => m.type === 'option_quotes_batch').length).toBe(
        countAfterDuplicate + 1,
      );
    });

    // Verificar 0 option_quotes_batch en vistas distintas a options
    expect(stockMsgs.filter((m) => m.type === 'option_quotes_batch')).toHaveLength(0);
    expect(ggalMsgs.filter((m) => m.type === 'option_quotes_batch')).toHaveLength(0);

    // Verificar contratos estrictamente de NVDA en optionsClient
    const allOptQuotes = optionsMsgs
      .filter((m) => m.type === 'option_quotes_batch')
      .flatMap((m) => m.quotes ?? []);
    expect(allOptQuotes.length).toBeGreaterThanOrEqual(2);
    expect(allOptQuotes.every((q) => q.underlying === 'NVDA')).toBe(true);
    expect(allOptQuotes.some((q) => q.underlying === 'SPY' || q.underlying === 'AAPL')).toBe(false);
    expect(runtime.getLiveOptionQuotes().length).toBe(3);

    // Verificar scoping L2: stockClient solo YPFD, ggalClient solo GGAL, optionsClient ninguno
    await vi.waitFor(() => {
      expect(stockMsgs.some((m) => m.delta?.liveOrderBook?.symbol === 'YPFD')).toBe(true);
      expect(ggalMsgs.some((m) => m.delta?.liveOrderBook?.symbol === 'GGAL')).toBe(true);
    });
    expect(optionsMsgs.some((m) => m.delta?.liveOrderBook !== undefined)).toBe(false);

    stockClient.close();
    ggalClient.close();
    optionsClient.close();
  });

  it('coalesce quotes bajo contrapresión (>256 KB con histéresis 64 KB) y cierra con 1013 sobre 4 MB', async () => {
    let mockBufferedBytes = 0;
    const { runtime, wsUrl } = await createTestServer({
      getClientBufferedAmount: () => mockBufferedBytes,
    });

    const { client: coalescingClient, messages: coalescedMsgs } =
      await openWsClientWithCollector(wsUrl);
    coalescingClient.send(JSON.stringify({ type: 'set_view_scope', view: 'monitoring', focusSymbol: null, focusMarket: 'US' }));

    await vi.waitFor(() => {
      expect(coalescedMsgs.some((m) => m.type === 'MARKET_TICK_BATCH')).toBe(true);
    });

    const tradierInjector = runtime as unknown as {
      ingestTradierTick(tick: {
        readonly event: 'trade';
        readonly symbol: string;
        readonly price: number;
        readonly size: number;
        readonly cumulativeVolume: number;
        readonly bid: number;
        readonly ask: number;
        readonly previousClose: number;
        readonly asOfUtcSec: number;
        readonly sessionPhase: 'RTH';
      }): void;
    };

    const pushNvdaTick = (price: number, timeOffsetSec: number): void => {
      tradierInjector.ingestTradierTick({
        event: 'trade',
        symbol: 'NVDA',
        price,
        size: 10,
        cumulativeVolume: 1_000 + timeOffsetSec * 10,
        bid: price - 0.05,
        ask: price + 0.05,
        previousClose: 140,
        asOfUtcSec: FIXED_NOW_SEC + timeOffsetSec,
        sessionPhase: 'RTH',
      });
    };

    // Eleva bufferedAmount por encima de HIGH_WATER_MARK (>256 KB): activa contrapresión
    mockBufferedBytes = WS_HIGH_WATER_MARK + 1_024;
    const batchesBeforePause = coalescedMsgs.filter((m) => m.type === 'market_batch').length;
    const lastRevBeforePause = coalescedMsgs
      .filter((m) => m.type === 'market_batch')
      .map((m) => m.delta?.deltaRevision ?? 0)
      .reduce((acc, r) => Math.max(acc, r), 0);

    pushNvdaTick(150.0, 1);
    await new Promise<void>((r) => setTimeout(r, 130));
    pushNvdaTick(155.0, 2);
    await new Promise<void>((r) => setTimeout(r, 130));

    // En zona de histéresis (> 64 KB) debe seguir coalesciendo (0 envíos durante pausa)
    mockBufferedBytes = WS_LOW_WATER_MARK + 512;
    pushNvdaTick(162.5, 3);
    await new Promise<void>((r) => setTimeout(r, 130));
    expect(coalescedMsgs.filter((m) => m.type === 'market_batch').length).toBe(batchesBeforePause);

    // Drena por debajo de LOW_WATER_MARK (<= 64 KB): emite 1 batch coalescido con último valor 162.5
    mockBufferedBytes = WS_LOW_WATER_MARK;
    await vi.waitFor(() => {
      expect(coalescedMsgs.filter((m) => m.type === 'market_batch').length).toBeGreaterThan(
        batchesBeforePause,
      );
    });
    const recoveryBatches = coalescedMsgs.filter((m) => m.type === 'market_batch').slice(batchesBeforePause);
    const nvdaRecoveryPrices = recoveryBatches
      .flatMap((b) => b.delta?.quotes ?? [])
      .filter((q) => q.symbol === 'NVDA')
      .map((q) => q.price);
    expect(nvdaRecoveryPrices).toEqual([162.5]);
    const recoveryRevs = recoveryBatches
      .map((b) => b.delta?.deltaRevision)
      .filter((rev): rev is number => typeof rev === 'number');
    expect(recoveryRevs.length).toBeGreaterThanOrEqual(1);
    if (lastRevBeforePause > 0) {
      expect(recoveryRevs[0]).toBe(lastRevBeforePause + 1);
    }

    // Supera KILL_WATER_MARK (> 4 MB) -> servidor cierra con código 1013
    const closePromise = new Promise<{ readonly code: number }>((resolveClose) => {
      coalescingClient.once('close', (code) => {
        resolveClose({ code });
      });
    });
    mockBufferedBytes = WS_KILL_WATER_MARK + 1;
    pushNvdaTick(163.0, 4);
    const closed = await closePromise;
    expect(closed.code).toBe(WS_BACKPRESSURE_CLOSE_CODE);
  });

  it('invoca ws.terminate() tras 2 barridos consecutivos de heartbeat sin Pong', async () => {
    const { port } = await createTestServer({ heartbeatIntervalMs: 60 });

    const { pingCount, closedPromise } = await new Promise<{
      readonly pingCount: { count: number };
      readonly closedPromise: Promise<void>;
    }>((resolveConnected, rejectConnected) => {
      const socket = net.createConnection({ port, host: '127.0.0.1' });
      const key = Buffer.alloc(16, 0x42).toString('base64');
      const expectedAccept = createHash('sha1')
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');

      let upgraded = false;
      let headBuf = Buffer.alloc(0);
      const pings = { count: 0 };
      const closedPromiseInner = new Promise<void>((resolveClosed) => {
        socket.once('close', () => {
          resolveClosed();
        });
        socket.once('end', () => {
          resolveClosed();
        });
      });

      socket.on('error', () => {
        // TCP RST tras terminate() es esperado en Windows
      });

      socket.on('data', (chunk: Buffer) => {
        if (!upgraded) {
          headBuf = Buffer.concat([headBuf, chunk]);
          const sepIdx = headBuf.indexOf('\r\n\r\n');
          if (sepIdx === -1) return;
          const headersText = headBuf.subarray(0, sepIdx).toString('utf8');
          if (!headersText.includes('101') || !headersText.includes(expectedAccept)) {
            rejectConnected(new Error(`Unexpected handshake response: ${headersText}`));
            return;
          }
          upgraded = true;
          const remainder = headBuf.subarray(sepIdx + 4);
          const firstRemByte = remainder[0];
          if (firstRemByte !== undefined && (firstRemByte & 0x0f) === 0x09) {
            pings.count += 1;
          }
          resolveConnected({ pingCount: pings, closedPromise: closedPromiseInner });
          return;
        }
        // Solo contabilizar frames Ping (opcode 0x09) y nunca responder con Pong (0x0A)
        let offset = 0;
        while (offset + 2 <= chunk.length) {
          const b0 = chunk[offset];
          const b1 = chunk[offset + 1];
          if (b0 === undefined || b1 === undefined) break;
          let payloadLen = b1 & 0x7f;
          let headerLen = 2;
          if (payloadLen === 126 && offset + 4 <= chunk.length) {
            payloadLen = chunk.readUInt16BE(offset + 2);
            headerLen = 4;
          } else if (payloadLen === 127 && offset + 10 <= chunk.length) {
            payloadLen = Number(chunk.readBigUInt64BE(offset + 2));
            headerLen = 10;
          }
          if ((b0 & 0x0f) === 0x09) {
            pings.count += 1;
          }
          offset += headerLen + payloadLen;
        }
      });

      socket.once('connect', () => {
        socket.write(
          [
            `GET /ws HTTP/1.1`,
            `Host: 127.0.0.1:${String(port)}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`,
            'Sec-WebSocket-Version: 13',
            '',
            '',
          ].join('\r\n'),
        );
      });
    });

    await closedPromise;
    expect(pingCount.count).toBeGreaterThanOrEqual(2);
  });
});
