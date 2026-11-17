import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Bar } from '../src/core/types.js';
import type { FetchFn } from '../src/data/types.js';
import type {
  MassiveWsClientOptions,
  WsNormalizedEvent,
  WsTradeEvent,
} from '../src/data/wsTypes.js';
import { ArgentinaMarketRuntime } from '../src/server/argentinaMarketLoader.js';
import { MarketRuntime } from '../src/server/marketRuntime.js';
import { MassiveStocksStream } from '../src/server/massiveStocksStream.js';
import { createHttpWsServer, type HttpWsServerHandle } from '../src/server/httpWsServer.js';
import {
  buildMassiveWsChannels,
  coalesceLatestByKey,
  computeMassiveDynamicLeases,
  normalizeIolHistoricalBars,
  resolveArIntradayFallback,
} from '../src/server/wsCoalescerAndStability.js';

interface FixtureMeta {
  readonly precisionTolerance: number;
  readonly generalIntervalMs: number;
  readonly focusIntervalMs: number;
  readonly closeTimeoutMs: number;
}

interface CoalesceItem {
  readonly key: string;
  readonly value: number;
}

interface LeaseOperation {
  readonly action: 'acquire' | 'release';
  readonly symbol: string;
  readonly owner: string;
}

interface IolHistoryRow {
  readonly fechaHora: string;
  readonly apertura: number;
  readonly maximo: number;
  readonly minimo: number;
  readonly ultimoPrecio: number;
  readonly volumenNominal?: number | null;
  readonly precioPromedio?: number | null;
}

interface WsCoalescerFixture {
  readonly meta: FixtureMeta;
  readonly coalesce_latest: {
    readonly input: readonly CoalesceItem[];
    readonly expected: Readonly<Record<string, CoalesceItem>>;
  };
  readonly massive_core: {
    readonly symbols: readonly string[];
    readonly forbiddenWildcards: readonly string[];
    readonly channelsBySymbol: Readonly<Record<string, readonly string[]>>;
  };
  readonly massive_dynamic_leases: {
    readonly operations: readonly LeaseOperation[];
    readonly coreSymbols: readonly string[];
    readonly expected: Readonly<Record<string, readonly string[]>>;
  };
  readonly ar_intraday_fallback: Readonly<
    Record<'1m' | '5m' | '1D', { readonly requestedTimeframe: string; readonly effectiveTimeframe: string; readonly fallbackReason: string | null }>
  >;
  readonly iol_history: {
    readonly input: readonly IolHistoryRow[];
    readonly expected: readonly Bar[];
    readonly firstTimeSec: number;
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(resolve(HERE, '../fixtures/ws_coalescer_reference.json'), 'utf8'),
) as WsCoalescerFixture;
const TOL = FIXTURE.meta.precisionTolerance;

describe('Pieza 40 — referencia Python independiente', () => {
  it('coalesceLatestByKey aplica latest-write-wins por clave', () => {
    const actual = coalesceLatestByKey(FIXTURE.coalesce_latest.input);
    expect(Object.fromEntries(actual)).toEqual(FIXTURE.coalesce_latest.expected);
  });

  it('construye canales T/Q/A/AM explícitos y nunca wildcards', () => {
    for (const [symbol, expected] of Object.entries(FIXTURE.massive_core.channelsBySymbol)) {
      expect(buildMassiveWsChannels(symbol)).toEqual(expected);
    }
    for (const wildcard of FIXTURE.massive_core.forbiddenWildcards) {
      expect(buildMassiveWsChannels(wildcard.replace(/\..*$/, ''))).not.toContain(wildcard);
    }
    expect(buildMassiveWsChannels('I:VIX')).toEqual([]);
  });

  it('resuelve leases dinámicos con conteo de referencias y núcleo protegido', () => {
    const actual = computeMassiveDynamicLeases(
      FIXTURE.massive_dynamic_leases.operations,
      FIXTURE.massive_dynamic_leases.coreSymbols,
    );
    const normalized = Object.fromEntries(
      [...actual.entries()].map(([symbol, owners]) => [symbol, [...owners]]),
    );
    expect(normalized).toEqual(FIXTURE.massive_dynamic_leases.expected);
  });

  it('resuelve el fallback AR 1m -> 1D de forma explícita', () => {
    for (const [timeframe, expected] of Object.entries(FIXTURE.ar_intraday_fallback)) {
      const actual = resolveArIntradayFallback(timeframe);
      expect(actual.requestedTimeframe).toBe(expected.requestedTimeframe);
      expect(actual.effectiveTimeframe).toBe(expected.effectiveTimeframe);
      expect(actual.fallbackReason).toBe(expected.fallbackReason);
    }
  });

  it('normaliza la serie histórica IOL a barras reales en segundos UTC', () => {
    const actual = normalizeIolHistoricalBars(FIXTURE.iol_history.input);
    expect(actual).toHaveLength(FIXTURE.iol_history.expected.length);
    for (let i = 0; i < actual.length; i += 1) {
      const act = actual[i];
      const exp = FIXTURE.iol_history.expected[i];
      if (act === undefined || exp === undefined) throw new Error(`Missing bar ${String(i)}`);
      expect(act.time).toBe(exp.time);
      for (const field of ['open', 'high', 'low', 'close', 'volume'] as const) {
        expect(Math.abs(act[field] - exp[field])).toBeLessThanOrEqual(TOL);
      }
      if (exp.vw === undefined) {
        expect(act.vw).toBeUndefined();
      } else {
        expect(Math.abs((act.vw ?? Number.NaN) - exp.vw)).toBeLessThanOrEqual(TOL);
      }
    }
    expect(actual[0]?.time).toBe(FIXTURE.iol_history.firstTimeSec);
  });
});

interface ServerBatchMessage {
  readonly type: string;
  readonly focusSymbol?: string | null;
  readonly delta?: { readonly type?: string; readonly deltaRevision?: number };
  readonly events?: readonly { readonly type?: string; readonly symbol?: string }[];
}

const FIXED_NOW_MS = Date.UTC(2026, 0, 14, 15, 0, 0);
const activeServers: HttpWsServerHandle[] = [];

async function startTestServer(): Promise<string> {
  let capturedOnEvents: ((events: readonly WsNormalizedEvent[]) => void) | undefined;
  const runtime = new MarketRuntime({
    apiKey: 'WS_COALESCER_TEST_KEY',
    secrets: ['WS_COALESCER_TEST_KEY'],
    nowMsFn: () => FIXED_NOW_MS,
    enableWs: true,
    watchedSymbols: ['SPY', 'NVDA'],
    createWsClientFn: (options: MassiveWsClientOptions) => {
      capturedOnEvents = options.onEvents;
      return {
        connect: () => Promise.resolve(),
        subscribe: () => undefined,
        unsubscribe: () => undefined,
        close: () => undefined,
        getSnapshot: () =>
          ({
            cluster: options.cluster,
            url: 'wss://socket.massive.com/stocks',
            state: 'closed',
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
    fetchFn: () => Promise.reject(new Error('offline test harness')),
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
  });
  activeServers.push(server);
  const { host, port } = await server.start();
  await vi.waitFor(() => {
    expect(capturedOnEvents).toBeDefined();
  });
  return `ws://${host}:${String(port)}/ws`;
}

function openClient(url: string): Promise<WebSocket> {
  return new Promise((resolveOpen, rejectOpen) => {
    const client = new WebSocket(url);
    client.once('open', () => {
      resolveOpen(client);
    });
    client.once('error', rejectOpen);
  });
}

async function collectMessages(
  client: WebSocket,
  waitMs: number,
): Promise<readonly ServerBatchMessage[]> {
  const messages: ServerBatchMessage[] = [];
  const onMessage = (raw: unknown): void => {
    const text = typeof raw === 'string' ? raw : Buffer.from(raw as Uint8Array).toString('utf8');
    messages.push(JSON.parse(text) as ServerBatchMessage);
  };
  client.on('message', onMessage);
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, waitMs));
  client.off('message', onMessage);
  return messages;
}

function makeTrade(symbol: string, price: number): WsTradeEvent {
  return {
    ev: 'T',
    sym: symbol,
    price,
    size: 10,
    timeSec: Math.floor(FIXED_NOW_MS / 1_000),
    eventTimeMs: FIXED_NOW_MS,
  };
}

describe('Pieza 40 — batching 10 Hz / foco 20 Hz sobre /ws', () => {
  afterAll(async () => {
    for (const server of activeServers.splice(0)) {
      await server.stop();
    }
  });

  it('emite market_batch general a ~10 Hz y eventos enfocados a ~20 Hz', async () => {
    const url = await startTestServer();
    const general = await openClient(url);
    const focused = await openClient(url);
    focused.send(JSON.stringify({ action: 'focus', symbol: 'NVDA' }));

    let emitIdx = 0;
    const emitter = setInterval(() => {
      emitIdx += 1;
      // El listener del runtime está capturado en el factory; el server ya está listo.
      const runtime = activeServers[activeServers.length - 1]?.runtime;
      if (runtime === undefined) {
        return;
      }
      // Inyectamos por el bus interno equivalente al callback del stream.
      (runtime as unknown as { handleStockWsEvents(events: readonly WsTradeEvent[]): void }).handleStockWsEvents([
        makeTrade('SPY', 500 + emitIdx),
        makeTrade('NVDA', 180 + emitIdx),
      ]);
    }, 25);

    const [generalMessages, focusedMessages] = await Promise.all([
      collectMessages(general, 550),
      collectMessages(focused, 550),
    ]);
    clearInterval(emitter);
    general.close();
    focused.close();

    const generalBatches = generalMessages.filter((message) => message.type === 'market_batch');
    const focusedBatches = focusedMessages.filter((message) => message.type === 'market_batch');
    expect(generalBatches.length).toBeGreaterThanOrEqual(4);
    expect(generalBatches.length).toBeLessThanOrEqual(7);
    expect(focusedBatches.length).toBeGreaterThanOrEqual(8);
    expect(focusedBatches.length).toBeLessThanOrEqual(14);
    const generalWithDelta = generalBatches.find((batch) => batch.delta !== undefined);
    expect(generalWithDelta?.delta?.type).toBe('TICK_DELTA');
    const focusedWithEvent = focusedBatches.find(
      (batch) => (batch.events ?? []).some((event) => event.symbol === 'NVDA'),
    );
    expect(focusedWithEvent).toBeDefined();
  });
});

describe('Pieza 40 — reconexión acotada y fallback StockDetail', () => {
  afterAll(async () => {
    for (const server of activeServers.splice(0)) {
      await server.stop();
    }
  });

  it('nunca espera más de 4000 ms por un socket que no confirma cierre', async () => {
    vi.useFakeTimers();
    try {
      const stuckClient = {
        connect: () => Promise.resolve(),
        subscribe: () => undefined,
        unsubscribe: () => undefined,
        close: () => undefined,
        getSnapshot: () =>
          ({
            cluster: 'stocks' as const,
            url: 'wss://socket.massive.com/stocks',
            state: 'ready' as const,
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
      const stream = new MassiveStocksStream({
        apiKey: 'close_timeout_key',
        symbols: ['SPY'],
        coreSymbols: ['SPY'],
        fetchFn: () => Promise.resolve({ ok: true, status: 200, text: JSON.stringify({ tickers: [] }), headers: {} }),
        createWsClientFn: () => stuckClient,
      });
      await stream.start();
      const stopPromise = stream.stopAndWait(FIXTURE.meta.closeTimeoutMs);
      await vi.advanceTimersByTimeAsync(FIXTURE.meta.closeTimeoutMs + 25);
      await expect(stopPromise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('acepta la reconexión manual de inmediato y completa en background', async () => {
    const runtime = new MarketRuntime({
      apiKey: 'RECONNECT_TEST_KEY',
      secrets: ['RECONNECT_TEST_KEY'],
      enableWs: true,
      watchedSymbols: ['SPY'],
      createWsClientFn: () => ({
        connect: () => Promise.resolve(),
        subscribe: () => undefined,
        unsubscribe: () => undefined,
        close: () => undefined,
        getSnapshot: () =>
          ({
            cluster: 'stocks',
            url: 'wss://socket.massive.com/stocks',
            state: 'closed',
            subscriptions: [],
            activeQuoteSubscriptionCount: 0,
            queueDepth: 0,
            droppedQueueMessages: 0,
            reconnectAttempts: 0,
            totalMessagesReceived: 0,
            discardedPayloads: 0,
            lastError: null,
          }),
      }),
      fetchFn: () => Promise.reject(new Error('offline reconnect harness')),
    });
    await runtime.startWs();
    const startedAtMs = Date.now();
    const result = await runtime.reconnectMassiveStocksWs();
    expect(Date.now() - startedAtMs).toBeLessThan(100);
    expect(result).toBe('MASSIVE_WS_STOCKS_RECONNECT_ACCEPTED');
    const work = runtime.getMassiveWsReconnectPromise();
    expect(work).not.toBeNull();
    await work;
    runtime.stopWs();
  });

  it('fallback AR 1m -> 1D responde con campos explícitos en <500 ms', async () => {
    const dailyBars: Bar[] = Array.from({ length: 300 }, (_, idx) => {
      const time = Math.floor(FIXED_NOW_MS / 1_000) - (299 - idx) * 86_400;
      const close = 4_000 + idx;
      return { time, open: close - 5, high: close + 8, low: close - 8, close, volume: 1_000 + idx };
    });
    const mockFetch: FetchFn = (url) => {
      if (url.includes('/historical/stocks/GGAL')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: JSON.stringify(
            dailyBars.map((bar) => ({
              date: new Date(bar.time * 1_000).toISOString().slice(0, 10),
              o: bar.open,
              h: bar.high,
              l: bar.low,
              c: bar.close,
              v: bar.volume,
            })),
          ),
          headers: {},
        });
      }
      return Promise.resolve({ ok: true, status: 200, text: '[]', headers: {} });
    };
    const arRuntime = new ArgentinaMarketRuntime({
      nowMsFn: () => FIXED_NOW_MS,
      minData912IntervalMs: 0,
      fetchFn: mockFetch,
    });
    const runtime = new MarketRuntime({
      apiKey: 'FALLBACK_TEST_KEY',
      secrets: ['FALLBACK_TEST_KEY'],
      enableWs: false,
      nowMsFn: () => FIXED_NOW_MS,
      fetchFn: mockFetch,
    });
    const server = createHttpWsServer({
      runtime,
      arRuntime,
      host: '127.0.0.1',
      port: 0,
      startRuntimeWs: false,
      enableBackgroundWarmup: false,
    });
    activeServers.push(server);
    const { host, port } = await server.start();
    const startedAtMs = Date.now();
    const response = await fetch(
      `http://${host}:${String(port)}/api/bars?symbol=GGAL&market=AR&timeframe=1m&visibleBars=120`,
    );
    const elapsedMs = Date.now() - startedAtMs;
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['requestedTimeframe']).toBe('1m');
    expect(body['effectiveTimeframe']).toBe('1D');
    expect(body['fallbackReason']).toBe('NO_1M_BARS_AR');
    expect(Array.isArray(body['bars'])).toBe(true);
    expect((body['bars'] as readonly unknown[]).length).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(500);
  });
});
