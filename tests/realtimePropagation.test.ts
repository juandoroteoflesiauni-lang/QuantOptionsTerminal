/**
 * Pieza 34 — End-to-end real-time propagation:
 *  - Pure projections match the independent Python reference (tolerance 1e-12).
 *  - A real WebSocket client receives `TICK_DELTA` frames < 300 ms after the
 *    AR bus / Massive WS stream ingests new ticks.
 *  - The server recomputes MEP / CCL Mediano / CCL GGAL / Canje from the live
 *    quotes and exposes them on the same frame, without cache resets.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  appendLiveTapeTick,
  computeLiveFxFromQuotes,
  projectLiveCandle,
  projectLiveCvd,
  projectLiveSessionVwap,
  type LiveChartBar,
  type LiveFxSnapshot,
  type LiveTapeTick,
  type PropagationQuote,
} from '../src/core/realtimePropagation.js';
import type { MassiveWsClientOptions, WsNormalizedEvent } from '../src/data/wsTypes.js';
import { ArRealtimeBus } from '../src/server/arRealtimeBus.js';
import { IolFeedAdapter } from '../src/server/iolFeedAdapter.js';
import {
  ArgentinaMarketRuntime,
} from '../src/server/argentinaMarketLoader.js';
import { createHttpWsServer, type HttpWsServerHandle } from '../src/server/httpWsServer.js';
import {
  MarketRuntime,
  type MassiveWsClientLike,
} from '../src/server/marketRuntime.js';
import type { PrimaryDlrContractDto } from '../src/server/primaryRofexLoader.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(HERE, '../fixtures/realtime_propagation_reference.json');

interface PropagationFixture {
  readonly meta: { readonly precisionTolerance: number };
  readonly fx: {
    readonly quotes: readonly PropagationQuote[];
    readonly expected: LiveFxSnapshot;
  };
  readonly candle: {
    readonly bar: LiveChartBar;
    readonly sameBucketTick: { readonly price: number; readonly timeSec: number; readonly volumeDelta: number };
    readonly sameBucketBarSeconds: number;
    readonly expectedSameBucket: LiveChartBar;
    readonly newBucketTick: { readonly price: number; readonly timeSec: number; readonly volumeDelta: number };
    readonly newBucketBarSeconds: number;
    readonly expectedNewBucket: LiveChartBar;
  };
  readonly sessionVwap: {
    readonly closedBars: readonly LiveChartBar[];
    readonly formingBar: LiveChartBar;
    readonly marketTz: string;
    readonly expected: { readonly timeSec: number; readonly value: number };
  };
  readonly cvd: {
    readonly lastCvd: number;
    readonly ticks: readonly LiveTapeTick[];
    readonly expected: number;
  };
  readonly tapeAppend: {
    readonly before: readonly LiveTapeTick[];
    readonly tick: LiveTapeTick;
    readonly expected: readonly LiveTapeTick[];
  };
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as PropagationFixture;

function expectClose(actual: number, expected: number, label: string): void {
  const diff = Math.abs(actual - expected);
  expect(
    diff,
    `${label}: actual=${String(actual)} expected=${String(expected)}`,
  ).toBeLessThanOrEqual(fixture.meta.precisionTolerance);
}

function expectBar(actual: LiveChartBar, expected: LiveChartBar, label: string): void {
  expect(actual.timeSec).toBe(expected.timeSec);
  expectClose(actual.open, expected.open, `${label}.open`);
  expectClose(actual.high, expected.high, `${label}.high`);
  expectClose(actual.low, expected.low, `${label}.low`);
  expectClose(actual.close, expected.close, `${label}.close`);
  expectClose(actual.volume, expected.volume, `${label}.volume`);
}

interface ServerMessage {
  readonly type?: unknown;
  readonly sequence?: unknown;
  readonly deltaRevision?: unknown;
  readonly delta?: unknown;
  readonly quotes?: unknown;
  readonly liveFx?: unknown;
  readonly futures?: unknown;
}

function makeDlrContract(contract: string): PrimaryDlrContractDto {
  return {
    contract,
    category: 'OUTRIGHT',
    marketId: 'ROFX',
    maturity: '2026-12-31',
    expiryUtcSec: 1_797_657_600,
    days: 45,
    price: 1_250.5,
    priceBasis: 'LAST',
    last: 1_250.5,
    settlement: null,
    close: null,
    bid: 1_250.0,
    bidPrice: 1_250.0,
    bidSize: 10,
    ask: 1_251.0,
    askPrice: 1_251.0,
    askSize: 8,
    bids: [{ price: 1_250.0, size: 10 }],
    asks: [{ price: 1_251.0, size: 8 }],
    openInterest: 1_234,
    nominalVolume: 56_789,
    open: null,
    high: null,
    low: null,
    spotUsed: 1_248.0,
    spotSource: 'A3500_BCRA',
    devalDirectaPct: 0.2,
    tnaImplicitaPct: 1.6,
    teaImplicitaPct: 1.7,
    temImplicitaPct: 0.13,
    forwardToForwardPct: null,
    contractMultiplier: 1_000,
    minPriceIncrement: 0.5,
    updatedAtUtcSec: 1_794_580_680,
    source: 'PRIMARY_ROFEX',
  };
}

describe('pure real-time projections', () => {
  it('matches the Python fixture for FX, candle, VWAP, CVD and tape retention', () => {
    const fx = computeLiveFxFromQuotes(fixture.fx.quotes);
    expectClose(fx.mepMedian ?? Number.NaN, fixture.fx.expected.mepMedian ?? Number.NaN, 'fx.mepMedian');
    expectClose(fx.cclMedian ?? Number.NaN, fixture.fx.expected.cclMedian ?? Number.NaN, 'fx.cclMedian');
    expectClose(
      fx.cclImplicitGgal ?? Number.NaN,
      fixture.fx.expected.cclImplicitGgal ?? Number.NaN,
      'fx.cclImplicitGgal',
    );
    expectClose(fx.canjePct ?? Number.NaN, fixture.fx.expected.canjePct ?? Number.NaN, 'fx.canjePct');

    const sameBucketBar = projectLiveCandle(
      fixture.candle.bar,
      fixture.candle.sameBucketTick,
      fixture.candle.sameBucketBarSeconds,
    );
    expect(sameBucketBar).not.toBeNull();
    if (sameBucketBar !== null) {
      expectBar(sameBucketBar, fixture.candle.expectedSameBucket, 'candle.sameBucket');
    }

    const newBucketBar = projectLiveCandle(
      fixture.candle.bar,
      fixture.candle.newBucketTick,
      fixture.candle.newBucketBarSeconds,
    );
    expect(newBucketBar).not.toBeNull();
    if (newBucketBar !== null) {
      expectBar(newBucketBar, fixture.candle.expectedNewBucket, 'candle.newBucket');
    }

    const vwap = projectLiveSessionVwap(
      fixture.sessionVwap.closedBars,
      fixture.sessionVwap.formingBar,
      fixture.sessionVwap.marketTz,
    );
    expect(vwap).not.toBeNull();
    if (vwap !== null) {
      expect(vwap.timeSec).toBe(fixture.sessionVwap.expected.timeSec);
      expectClose(vwap.value, fixture.sessionVwap.expected.value, 'sessionVwap.value');
    }

    const cvd = projectLiveCvd(fixture.cvd.lastCvd, fixture.cvd.ticks);
    expectClose(cvd, fixture.cvd.expected, 'cvd');

    const tape = appendLiveTapeTick(fixture.tapeAppend.before, fixture.tapeAppend.tick);
    expect(tape).toHaveLength(200);
    expect(tape[tape.length - 1]).toEqual(fixture.tapeAppend.tick);
    expect(tape[0]).toEqual(fixture.tapeAppend.before[0]);
  });
});

describe('WebSocket tick propagation', () => {
  const servers: HttpWsServerHandle[] = [];

  afterAll(async () => {
    for (const server of servers) {
      await server.stop();
    }
  });

  it('propagates AR/US ticks and recomputes FX in under 300 ms', async () => {
    let capturedOnEvents: ((events: readonly WsNormalizedEvent[]) => void) | undefined;
    const createWsClientFn = (options: MassiveWsClientOptions): MassiveWsClientLike => {
      capturedOnEvents = options.onEvents;
      return {
        connect: () => Promise.resolve(),
        subscribe: () => undefined,
        unsubscribe: () => undefined,
        close: () => undefined,
        getSnapshot: () => ({
          cluster: options.cluster,
          url: 'wss://socket.massive.com/stocks',
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
    };

    const iolClient = new IolFeedAdapter({ env: {} });
    const bus = new ArRealtimeBus({ bmbClient: null, iolClient });
    const fixedNowMs = 1_794_580_680_000;
    const arRuntime = new ArgentinaMarketRuntime({
      realtimeBus: bus,
      fetchFn: () => Promise.reject(new Error('offline test harness')),
      nowMsFn: () => fixedNowMs,
      env: {},
    });
    const runtime = new MarketRuntime({
      apiKey: 'TEST_KEY',
      secrets: ['TEST_KEY'],
      nowMsFn: () => fixedNowMs,
      enableWs: true,
      watchedSymbols: ['GGAL', 'NVDA'],
      createWsClientFn,
      fetchFn: () => Promise.reject(new Error('offline test harness')),
    });
    const server = createHttpWsServer({
      runtime,
      arRuntime,
      host: '127.0.0.1',
      port: 0,
      startRuntimeWs: true,
      enableBackgroundWarmup: false,
    });
    servers.push(server);
    const { host, port } = await server.start();

    const messages: ServerMessage[] = [];
    let firstTickDeltaAtMs = Number.NaN;
    const client = new WebSocket(`ws://${host}:${String(port)}/ws`);
    client.on('message', (raw) => {
      const text = typeof raw === 'string' ? raw : Buffer.from(raw as Uint8Array).toString('utf-8');
      const message = JSON.parse(text) as ServerMessage;
      if (
        message.type === 'market_batch' &&
        message.delta !== undefined &&
        message.delta !== null &&
        Number.isNaN(firstTickDeltaAtMs)
      ) {
        firstTickDeltaAtMs = Date.now();
      }
      messages.push(message);
    });
    await new Promise<void>((resolveOpen, rejectOpen) => {
      client.once('open', () => {
        resolveOpen();
      });
      client.once('error', rejectOpen);
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    messages.length = 0;

    bus.ingestQuotes([
      { market: 'AR', symbol: 'AL30', kind: 'bond', currency: 'ARS', price: 1000, previousClose: null, changePct: null, dayLow: null, dayHigh: null, volume: null, turnover: null, asOfUtcSec: 1_794_580_680, source: 'IOL_REST' },
      { market: 'AR', symbol: 'AL30D', kind: 'bond', currency: 'USD', price: 50, previousClose: null, changePct: null, dayLow: null, dayHigh: null, volume: null, turnover: null, asOfUtcSec: 1_794_580_680, source: 'IOL_REST' },
      { market: 'AR', symbol: 'AL30C', kind: 'bond', currency: 'USD', price: 45, previousClose: null, changePct: null, dayLow: null, dayHigh: null, volume: null, turnover: null, asOfUtcSec: 1_794_580_680, source: 'IOL_REST' },
      { market: 'AR', symbol: 'GD30', kind: 'bond', currency: 'ARS', price: 900, previousClose: null, changePct: null, dayLow: null, dayHigh: null, volume: null, turnover: null, asOfUtcSec: 1_794_580_680, source: 'IOL_REST' },
      { market: 'AR', symbol: 'GD30D', kind: 'bond', currency: 'USD', price: 45, previousClose: null, changePct: null, dayLow: null, dayHigh: null, volume: null, turnover: null, asOfUtcSec: 1_794_580_680, source: 'IOL_REST' },
      { market: 'AR', symbol: 'GD30C', kind: 'bond', currency: 'USD', price: 40, previousClose: null, changePct: null, dayLow: null, dayHigh: null, volume: null, turnover: null, asOfUtcSec: 1_794_580_680, source: 'IOL_REST' },
      { market: 'AR', symbol: 'GGAL', kind: 'stock', currency: 'ARS', price: 1000, previousClose: null, changePct: null, dayLow: null, dayHigh: null, volume: null, turnover: null, asOfUtcSec: 1_794_580_680, source: 'IOL_REST' },
    ]);
    bus.ingestFutures([makeDlrContract('DLR/DIC26')]);

    const injectedAtMs = Date.now();
    capturedOnEvents?.([
      { ev: 'T', sym: 'GGAL', price: 20.0, size: 10, timeSec: 1_794_580_680, eventTimeMs: fixedNowMs },
      { ev: 'T', sym: 'NVDA', price: 175.25, size: 25, timeSec: 1_794_580_680, eventTimeMs: fixedNowMs },
    ]);

    await new Promise<void>((resolve) => setTimeout(resolve, 180));
    client.close();

    const batches = messages.filter((message) => message.type === 'market_batch');
    expect(batches.length).toBeGreaterThan(0);
    const deltaWithFx = batches
      .map((batch) => batch.delta as ServerMessage | undefined)
      .find((delta) => delta?.liveFx !== undefined && delta.liveFx !== null);
    expect(deltaWithFx).toBeDefined();
    if (deltaWithFx === undefined) {
      throw new Error('Expected market_batch delta with liveFx');
    }
    const liveFx = deltaWithFx.liveFx as LiveFxSnapshot;
    expect(liveFx.mepMedian).not.toBeNull();
    expect(liveFx.cclMedian).not.toBeNull();
    expect(liveFx.cclImplicitGgal).not.toBeNull();
    expect(liveFx.canjePct).not.toBeNull();
    expectClose(liveFx.mepMedian ?? Number.NaN, 20, 'liveFx.mepMedian');
    expectClose(liveFx.cclMedian ?? Number.NaN, 22.5, 'liveFx.cclMedian');
    expectClose(liveFx.cclImplicitGgal ?? Number.NaN, 500, 'liveFx.cclImplicitGgal');
    expectClose(liveFx.canjePct ?? Number.NaN, 12.5, 'liveFx.canjePct');

    const deltaQuotes = Array.isArray(deltaWithFx.quotes) ? deltaWithFx.quotes : [];
    const symbols = new Set<string>();
    for (const quote of deltaQuotes) {
      if (typeof quote === 'object' && quote !== null && 'symbol' in quote) {
        symbols.add(String((quote as { readonly symbol?: unknown }).symbol));
      }
    }
    expect(symbols.has('AL30')).toBe(true);
    expect(symbols.has('GGAL')).toBe(true);
    expect(symbols.has('NVDA')).toBe(true);

    const futures = Array.isArray(deltaWithFx.futures) ? deltaWithFx.futures : [];
    const contracts = futures
      .map((contract) => (typeof contract === 'object' && contract !== null ? (contract as { readonly contract?: unknown }).contract : null))
      .filter((contract): contract is string => typeof contract === 'string');
    expect(contracts).toContain('DLR/DIC26');

    // The same tick frame is the cache-free source used by the frontend, so the
    // projection parity check proves the chart state can be rebuilt without a reload.
    const fxFromQuotes = computeLiveFxFromQuotes(
      deltaQuotes.filter(
        (quote): quote is PropagationQuote =>
          typeof quote === 'object' &&
          quote !== null &&
          typeof (quote as { readonly market?: unknown }).market === 'string' &&
          typeof (quote as { readonly symbol?: unknown }).symbol === 'string' &&
          typeof (quote as { readonly price?: unknown }).price === 'number',
      ),
    );
    expectClose(fxFromQuotes.mepMedian ?? Number.NaN, liveFx.mepMedian ?? Number.NaN, 'projection.fx.mepMedian');
    expectClose(fxFromQuotes.cclMedian ?? Number.NaN, liveFx.cclMedian ?? Number.NaN, 'projection.fx.cclMedian');
    expectClose(
      fxFromQuotes.cclImplicitGgal ?? Number.NaN,
      liveFx.cclImplicitGgal ?? Number.NaN,
      'projection.fx.cclImplicitGgal',
    );

    const elapsedMs = firstTickDeltaAtMs - injectedAtMs;
    expect(elapsedMs).toBeLessThan(300);
  });
});
