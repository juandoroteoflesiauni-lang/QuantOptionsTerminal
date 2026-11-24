import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeAnchoredVwap } from '../src/core/avwap.js';
import { calculateEma } from '../src/core/ema.js';
import { computeSessionVwap } from '../src/core/sessionVwap.js';
import type { Bar } from '../src/core/types.js';
import {
  createLiveBarState,
  ingestWsEvents,
  normalizeWsPayload,
  parseWsJsonPayload,
  projectLiveIndicators,
} from '../src/data/liveBarConsolidator.js';
import {
  computeReconnectBackoffMs,
  MassiveWsClient,
} from '../src/data/wsClient.js';
import {
  MIN_RECONNECT_BACKOFF_MS,
  OPTIONS_MAX_QUOTE_SUBSCRIPTIONS,
  WS_CLUSTER_URLS,
  type WsClientError,
  type WsConnectionState,
  type WsSocketFactory,
  type WsSocketLike,
} from '../src/data/wsTypes.js';

interface FixtureFile {
  readonly meta: {
    readonly precisionTolerance: number;
  };
  readonly scenario1_ticks_a_am: {
    readonly initialClosedBars: readonly Bar[];
    readonly step1Trades: readonly Record<string, unknown>[];
    readonly expectedAfterStep1: Bar;
    readonly step2ABars: readonly Record<string, unknown>[];
    readonly expectedAfterStep2: Bar;
    readonly step3ARebroadcastAndStaleT: readonly Record<string, unknown>[];
    readonly expectedAfterStep3: Bar;
    readonly expectedSecondRebroadcastOverwritesAfterStep3: number;
    readonly expectedStaleEventsIgnoredAfterStep3: number;
    readonly step4NextMinTickAndAm: readonly Record<string, unknown>[];
    readonly expectedClosedBarsAfterStep4: readonly Bar[];
    readonly expectedFormingBarAfterStep4: Bar;
  };
  readonly scenario2_am_rebroadcast: {
    readonly closedBarsBefore: readonly Bar[];
    readonly rebroadcastEvent: Record<string, unknown>;
    readonly expectedClosedBarsAfter: readonly Bar[];
    readonly expectedRebroadcastOverwrites: number;
  };
  readonly scenario3_5m_consolidation: {
    readonly barSeconds: number;
    readonly initialAmEvents: readonly Record<string, unknown>[];
    readonly expectedClosed5mInitial: readonly Bar[];
    readonly rebroadcastAmEvent: Record<string, unknown>;
    readonly expectedClosed5mAfterRebroadcast: readonly Bar[];
  };
  readonly scenario4_1s_rebroadcast: {
    readonly barSeconds: number;
    readonly events: readonly Record<string, unknown>[];
    readonly expectedClosedBars: readonly Bar[];
    readonly expectedRebroadcastOverwrites: number;
  };
  readonly scenario5_live_projections: {
    readonly closedBars: readonly Bar[];
    readonly formingEvents: readonly Record<string, unknown>[];
    readonly expectedFormingBar: Bar;
    readonly emaPeriod: number;
    readonly expectedClosedEma: number;
    readonly expectedLiveEma: number;
    readonly expectedLiveSessionVwap: {
      readonly time: number;
      readonly vwap: number;
      readonly cumVolume: number;
      readonly frozen: boolean;
      readonly source: 'VW' | 'HLC3' | 'NONE';
    };
    readonly expectedLiveAvwap: {
      readonly time: number;
      readonly vwap: number;
      readonly stdDev: number;
      readonly cumVolume: number;
      readonly upper1: number;
      readonly lower1: number;
      readonly upper2: number;
      readonly lower2: number;
      readonly upper2_5: number;
      readonly lower2_5: number;
    };
  };
  readonly scenario6_invalid_discards: {
    readonly payload: readonly unknown[];
    readonly expectedAcceptedCount: number;
    readonly expectedDiscardedCount: number;
    readonly expectedDiscardCounts: Readonly<Record<string, number>>;
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(HERE, '../fixtures/live_bar_reference.json');
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as FixtureFile;
const TOL = fixture.meta.precisionTolerance;

let maxObservedDiff = 0;

function expectClose(actual: number, expected: number, label: string): void {
  const diff = Math.abs(actual - expected);
  if (diff > maxObservedDiff) {
    maxObservedDiff = diff;
  }
  expect(diff, `${label}: actual=${String(actual)} expected=${String(expected)}`).toBeLessThanOrEqual(TOL);
}

function expectBarClose(actual: Bar | null, expected: Bar, label: string): void {
  expect(actual, `${label} must not be null`).not.toBeNull();
  if (actual === null) {
    return;
  }
  expect(actual.time, `${label}.time`).toBe(expected.time);
  expectClose(actual.open, expected.open, `${label}.open`);
  expectClose(actual.high, expected.high, `${label}.high`);
  expectClose(actual.low, expected.low, `${label}.low`);
  expectClose(actual.close, expected.close, `${label}.close`);
  expectClose(actual.volume, expected.volume, `${label}.volume`);
  if (expected.vw !== undefined) {
    expect(actual.vw, `${label}.vw should exist`).toBeDefined();
    if (actual.vw !== undefined) {
      expectClose(actual.vw, expected.vw, `${label}.vw`);
    }
  } else {
    expect(actual.vw, `${label}.vw should be undefined`).toBeUndefined();
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      const prop = (value as Record<string, unknown>)[key];
      if (prop !== null && (typeof prop === 'object' || typeof prop === 'function') && !Object.isFrozen(prop)) {
        deepFreeze(prop);
      }
    }
  }
  return value;
}

class MockWsSocket implements WsSocketLike {
  readonly sentFrames: string[] = [];
  readonly closeCalls: { readonly code?: number; readonly reason?: string }[] = [];
  onOpen: (() => void) | null = null;
  onMessage: ((data: string) => void) | null = null;
  onClose: ((info: { readonly code: number; readonly reason: string; readonly wasClean: boolean }) => void) | null = null;
  onError: ((error: unknown) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sentFrames.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({
      ...(code !== undefined ? { code } : {}),
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  triggerOpen(): void {
    this.onOpen?.();
  }

  triggerMessage(payload: unknown): void {
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.onMessage?.(raw);
  }

  triggerClose(code = 1006, reason = 'connection reset', wasClean = false): void {
    this.onClose?.({ code, reason, wasClean });
  }

  triggerError(err: unknown): void {
    this.onError?.(err);
  }
}

function createMockSocketHarness(): {
  readonly factory: WsSocketFactory;
  readonly sockets: MockWsSocket[];
} {
  const sockets: MockWsSocket[] = [];
  const factory: WsSocketFactory = (url) => {
    const sock = new MockWsSocket(url);
    sockets.push(sock);
    return sock;
  };
  return { factory, sockets };
}

function createFakeSleep(): {
  readonly sleep: (ms: number) => Promise<void>;
  readonly delays: number[];
  readonly releaseNext: () => void;
  readonly pendingCount: () => number;
} {
  const delays: number[] = [];
  const resolvers: (() => void)[] = [];

  const sleep = (ms: number): Promise<void> => {
    delays.push(ms);
    return new Promise<void>((resolve) => {
      resolvers.push(resolve);
    });
  };

  const releaseNext = (): void => {
    const fn = resolvers.shift();
    if (fn !== undefined) {
      fn();
    }
  };

  return {
    sleep,
    delays,
    releaseNext,
    pendingCount: () => resolvers.length,
  };
}

async function flushMicrotasks(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

describe('liveBarConsolidator — pure forming-bar and rebroadcast state machine', () => {
  it('matches Python fixture scenario 1: T ticks -> A overwrite -> A rebroadcast overwrite -> AM seal', () => {
    const s1 = fixture.scenario1_ticks_a_am;
    const initialClosedFrozen = deepFreeze(structuredClone(s1.initialClosedBars));

    const state0 = deepFreeze(createLiveBarState(initialClosedFrozen, 60));
    expect(state0.formingBar).toBeNull();
    expect(state0.closedBars).toHaveLength(s1.initialClosedBars.length);

    const state1 = deepFreeze(ingestWsEvents(state0, deepFreeze(structuredClone(s1.step1Trades)), { symbol: 'SPY' }));
    expectBarClose(state1.formingBar, s1.expectedAfterStep1, 'scenario1.afterStep1');

    const state2 = deepFreeze(ingestWsEvents(state1, deepFreeze(structuredClone(s1.step2ABars)), { symbol: 'SPY' }));
    expectBarClose(state2.formingBar, s1.expectedAfterStep2, 'scenario1.afterStep2');

    const state3 = deepFreeze(
      ingestWsEvents(state2, deepFreeze(structuredClone(s1.step3ARebroadcastAndStaleT)), { symbol: 'SPY' }),
    );
    expectBarClose(state3.formingBar, s1.expectedAfterStep3, 'scenario1.afterStep3');
    expect(state3.metrics.secondRebroadcastOverwrites).toBe(
      s1.expectedSecondRebroadcastOverwritesAfterStep3,
    );
    expect(state3.metrics.staleEventsIgnored).toBe(s1.expectedStaleEventsIgnoredAfterStep3);

    const state4 = ingestWsEvents(state3, deepFreeze(structuredClone(s1.step4NextMinTickAndAm)), {
      symbol: 'SPY',
    });
    expect(state4.closedBars).toHaveLength(s1.expectedClosedBarsAfterStep4.length);
    for (let i = 0; i < s1.expectedClosedBarsAfterStep4.length; i += 1) {
      const exp = s1.expectedClosedBarsAfterStep4[i];
      const act = state4.closedBars[i];
      if (exp !== undefined && act !== undefined) {
        expectBarClose(act, exp, `scenario1.closed[${String(i)}]`);
      }
    }
    expectBarClose(state4.formingBar, s1.expectedFormingBarAfterStep4, 'scenario1.formingAfterStep4');

    // Verify historical state snapshots remained strictly unmutated
    expect(state0.formingBar).toBeNull();
    expect(state1.formingBar?.volume).toBe(s1.expectedAfterStep1.volume);
  });

  it('matches Python fixture scenario 2: AM 15-min FINRA TRF rebroadcast overwrites instead of summing or duplicating', () => {
    const s2 = fixture.scenario2_am_rebroadcast;
    const state0 = deepFreeze(createLiveBarState(s2.closedBarsBefore, 60));
    const state1 = ingestWsEvents(state0, JSON.stringify([s2.rebroadcastEvent]));

    expect(state1.metrics.rebroadcastOverwrites).toBe(s2.expectedRebroadcastOverwrites);
    expect(state1.closedBars).toHaveLength(s2.expectedClosedBarsAfter.length);
    for (let i = 0; i < s2.expectedClosedBarsAfter.length; i += 1) {
      const exp = s2.expectedClosedBarsAfter[i];
      const act = state1.closedBars[i];
      if (exp !== undefined && act !== undefined) {
        expectBarClose(act, exp, `scenario2.closed[${String(i)}]`);
      }
    }
  });

  it('matches Python fixture scenario 3: multi-minute 5m consolidation and AM rebroadcast update', () => {
    const s3 = fixture.scenario3_5m_consolidation;
    const state0 = createLiveBarState([], s3.barSeconds);
    const state1 = ingestWsEvents(state0, s3.initialAmEvents);

    expect(state1.closedBars).toHaveLength(s3.expectedClosed5mInitial.length);
    const exp0 = s3.expectedClosed5mInitial[0];
    if (exp0 !== undefined) {
      expectBarClose(state1.closedBars[0] ?? null, exp0, 'scenario3.initial5m');
    }

    const state2 = ingestWsEvents(state1, [s3.rebroadcastAmEvent]);
    expect(state2.closedBars).toHaveLength(s3.expectedClosed5mAfterRebroadcast.length);
    const exp1 = s3.expectedClosed5mAfterRebroadcast[0];
    if (exp1 !== undefined) {
      expectBarClose(state2.closedBars[0] ?? null, exp1, 'scenario3.rebroadcast5m');
    }
  });

  it('matches Python fixture scenario 4: 1s sub-minute A rebroadcast overwrites cleanly', () => {
    const s4 = fixture.scenario4_1s_rebroadcast;
    const state0 = createLiveBarState([], s4.barSeconds);
    const state1 = ingestWsEvents(state0, s4.events);

    expect(state1.metrics.rebroadcastOverwrites).toBe(s4.expectedRebroadcastOverwrites);
    expect(state1.closedBars).toHaveLength(s4.expectedClosedBars.length);
    const exp = s4.expectedClosedBars[0];
    if (exp !== undefined) {
      expectBarClose(state1.closedBars[0] ?? null, exp, 'scenario4.1s');
    }
  });

  it('matches Python fixture scenario 5: pure live indicator projections (EMA, Session VWAP, AVWAP)', () => {
    const s5 = fixture.scenario5_live_projections;
    const closedFrozen = deepFreeze(structuredClone(s5.closedBars));

    const closedEmas = calculateEma(
      closedFrozen.map((b) => b.close),
      s5.emaPeriod,
    );
    const lastClosedEma = closedEmas[closedEmas.length - 1] ?? Number.NaN;
    expectClose(lastClosedEma, s5.expectedClosedEma, 'scenario5.closedEma');

    const vwapOptions = deepFreeze({
      market: 'EQUITY' as const,
      barSeconds: 60,
      priceSource: 'TRADE_VWAP' as const,
    });
    const sessionVwapRes = computeSessionVwap(closedFrozen, vwapOptions);
    const avwapRes = computeAnchoredVwap(closedFrozen, 'SESSION', { market: 'EQUITY' });

    const stateClosedOnly = createLiveBarState(closedFrozen, 60);
    // Without forming bar: zero fallback values; ema must be NaN and sessionVwap/avwap must be null
    const emptyProjection = projectLiveIndicators(stateClosedOnly, {
      ema: { lastClosedEma, period: s5.emaPeriod },
      sessionVwap: { closedState: deepFreeze(sessionVwapRes.state), options: vwapOptions },
      avwap: { closedState: deepFreeze(avwapRes.state) },
    });
    expect(emptyProjection.formingTime).toBeNull();
    expect(Number.isNaN(emptyProjection.ema)).toBe(true);
    expect(emptyProjection.sessionVwap).toBeNull();
    expect(emptyProjection.avwap).toBeNull();

    const stateWithForming = ingestWsEvents(stateClosedOnly, s5.formingEvents);
    expectBarClose(stateWithForming.formingBar, s5.expectedFormingBar, 'scenario5.formingBar');

    const liveProjection = projectLiveIndicators(stateWithForming, {
      ema: { lastClosedEma, period: s5.emaPeriod },
      sessionVwap: { closedState: sessionVwapRes.state, options: vwapOptions },
      avwap: { closedState: avwapRes.state },
    });

    expect(liveProjection.formingTime).toBe(s5.expectedFormingBar.time);
    expectClose(liveProjection.ema, s5.expectedLiveEma, 'scenario5.liveEma');

    expect(liveProjection.sessionVwap).not.toBeNull();
    if (liveProjection.sessionVwap !== null) {
      expect(liveProjection.sessionVwap.time).toBe(s5.expectedLiveSessionVwap.time);
      expect(liveProjection.sessionVwap.frozen).toBe(s5.expectedLiveSessionVwap.frozen);
      expect(liveProjection.sessionVwap.source).toBe(s5.expectedLiveSessionVwap.source);
      expectClose(liveProjection.sessionVwap.vwap, s5.expectedLiveSessionVwap.vwap, 'scenario5.sessionVwap.vwap');
      expectClose(
        liveProjection.sessionVwap.cumVolume,
        s5.expectedLiveSessionVwap.cumVolume,
        'scenario5.sessionVwap.cumVolume',
      );
    }

    expect(liveProjection.avwap).not.toBeNull();
    if (liveProjection.avwap !== null) {
      expect(liveProjection.avwap.time).toBe(s5.expectedLiveAvwap.time);
      expectClose(liveProjection.avwap.vwap, s5.expectedLiveAvwap.vwap, 'scenario5.avwap.vwap');
      expectClose(liveProjection.avwap.stdDev, s5.expectedLiveAvwap.stdDev, 'scenario5.avwap.stdDev');
      expectClose(liveProjection.avwap.cumVolume, s5.expectedLiveAvwap.cumVolume, 'scenario5.avwap.cumVolume');
      expectClose(liveProjection.avwap.upper1, s5.expectedLiveAvwap.upper1, 'scenario5.avwap.upper1');
      expectClose(liveProjection.avwap.lower1, s5.expectedLiveAvwap.lower1, 'scenario5.avwap.lower1');
      expectClose(liveProjection.avwap.upper2, s5.expectedLiveAvwap.upper2, 'scenario5.avwap.upper2');
      expectClose(liveProjection.avwap.lower2, s5.expectedLiveAvwap.lower2, 'scenario5.avwap.lower2');
      expectClose(liveProjection.avwap.upper2_5, s5.expectedLiveAvwap.upper2_5, 'scenario5.avwap.upper2_5');
      expectClose(liveProjection.avwap.lower2_5, s5.expectedLiveAvwap.lower2_5, 'scenario5.avwap.lower2_5');
    }

    expect(maxObservedDiff).toBeLessThanOrEqual(TOL);
    console.info(`[liveWs.test] maxAbsDiff vs Python fixture = ${maxObservedDiff.toExponential(3)}`);
  });

  it('matches Python fixture scenario 6: validates malformed JSON, second-timestamps, and invalid OHLCV without NaN fallbacks', () => {
    const s6 = fixture.scenario6_invalid_discards;
    const parsed = normalizeWsPayload(s6.payload);
    expect(parsed.events).toHaveLength(s6.expectedAcceptedCount);
    expect(parsed.discarded).toBe(s6.expectedDiscardedCount);
    expect(parsed.discardCounts).toEqual(s6.expectedDiscardCounts);

    const badJson = parseWsJsonPayload('{not-valid-json');
    expect(badJson.events).toHaveLength(0);
    expect(badJson.discarded).toBe(1);
    expect(badJson.discardCounts.malformedRow).toBe(1);

    const state = createLiveBarState([], 60);
    const updated = ingestWsEvents(state, '{not-valid-json');
    expect(updated.formingBar).toBeNull();
    expect(updated.metrics.discardedEvents).toBe(1);
  });

  it('rejects closing or rewinding formingBar with stale A/T from already-closed buckets and handles vw without fake fallback', () => {
    const closed: Bar[] = [
      { time: 1_794_580_200, open: 100, high: 101, low: 99, close: 100.5, volume: 500 },
    ];
    const state0 = createLiveBarState(closed, 60);

    // A for closed bucket 1_794_580_200 -> ignored
    const stateStale = ingestWsEvents(state0, [
      { ev: 'A', sym: 'SPY', o: 100, h: 102, l: 98, c: 101, v: 999, s: 1_794_580_215_000, e: 1_794_580_216_000 },
    ]);
    expect(stateStale.formingBar).toBeNull();
    expect(stateStale.metrics.staleEventsIgnored).toBe(1);

    // Zero-volume A bar without vw: vw remains undefined (never invented from close)
    const stateZeroVol = ingestWsEvents(stateStale, [
      { ev: 'A', sym: 'SPY', o: 100.5, h: 100.5, l: 100.5, c: 100.5, v: 0, s: 1_794_580_260_000, e: 1_794_580_261_000 },
    ]);
    expect(stateZeroVol.formingBar?.volume).toBe(0);
    expect(stateZeroVol.formingBar?.vw).toBeUndefined();
  });
});

describe('MassiveWsClient — protocol state machine, limits, reconnect backoff, queue, redaction', () => {
  it('enforces connected -> auth -> auth_success -> subscribe ordering and uses exact cluster URLs', async () => {
    const harness = createMockSocketHarness();
    const states: WsConnectionState[] = [];

    const client = new MassiveWsClient({
      apiKey: 'SECRET_API_KEY_999',
      cluster: 'stocks',
      initialSubscriptions: 'AM.SPY,A.SPY',
      socketFactory: harness.factory,
      onStateChange: (s) => states.push(s),
    });

    const connectPromise = client.connect();
    expect(harness.sockets).toHaveLength(1);
    const sock = harness.sockets[0];
    expect(sock?.url).toBe(WS_CLUSTER_URLS.stocks);
    if (sock === undefined) {
      throw new Error('Expected mock socket');
    }

    sock.triggerOpen();
    expect(sock.sentFrames).toHaveLength(0);

    // Queue another subscription before auth_success
    client.subscribe('T.QQQ');
    expect(sock.sentFrames).toHaveLength(0);

    // Connected status triggers auth frame (without subscribing yet)
    sock.triggerMessage([{ ev: 'status', status: 'connected', message: 'Connected Successfully' }]);
    expect(sock.sentFrames).toEqual([JSON.stringify({ action: 'auth', params: 'SECRET_API_KEY_999' })]);

    // Auth success flushes desired subscriptions and resolves connect()
    sock.triggerMessage([{ ev: 'status', status: 'auth_success', message: 'authenticated' }]);
    await connectPromise;

    expect(states).toContain('authenticating');
    expect(states[states.length - 1]).toBe('ready');
    expect(sock.sentFrames).toEqual([
      JSON.stringify({ action: 'auth', params: 'SECRET_API_KEY_999' }),
      JSON.stringify({ action: 'subscribe', params: 'AM.SPY,A.SPY,T.QQQ' }),
    ]);

    // Subsequent subscribe & unsubscribe while ready send immediately
    client.unsubscribe('T.QQQ');
    client.subscribe('AM.IWM');
    expect(sock.sentFrames[2]).toBe(JSON.stringify({ action: 'unsubscribe', params: 'T.QQQ' }));
    expect(sock.sentFrames[3]).toBe(JSON.stringify({ action: 'subscribe', params: 'AM.IWM' }));

    client.close();
  });

  it('prohibits Q.* and enforces the 1,000-contract hard cap on /options without mutating active state', async () => {
    const harness = createMockSocketHarness();

    // Wildcard Q.* rejected upfront on options
    expect(
      () =>
        new MassiveWsClient({
          apiKey: 'SECRET_OPT_KEY',
          cluster: 'options',
          initialSubscriptions: ['Q.*'],
          socketFactory: harness.factory,
        }),
    ).toThrow(/wildcard quote/i);

    // Bare Q also rejected on options
    expect(
      () =>
        new MassiveWsClient({
          apiKey: 'SECRET_OPT_KEY',
          cluster: 'options',
          initialSubscriptions: ['Q'],
          socketFactory: harness.factory,
        }),
    ).toThrow(/wildcard quote/i);

    // 1001 contracts rejected upfront
    const tooManyQuotes = Array.from(
      { length: OPTIONS_MAX_QUOTE_SUBSCRIPTIONS + 1 },
      (_, idx) => `Q.O:SPY261218C${String(idx).padStart(8, '0')}`,
    );
    expect(
      () =>
        new MassiveWsClient({
          apiKey: 'SECRET_OPT_KEY',
          cluster: 'options',
          initialSubscriptions: tooManyQuotes,
          socketFactory: harness.factory,
        }),
    ).toThrow(/1000/);

    // Exactly 1000 contracts allowed on options + A.*/AM.* also allowed
    const maxQuotes = tooManyQuotes.slice(0, OPTIONS_MAX_QUOTE_SUBSCRIPTIONS);
    const optClient = new MassiveWsClient({
      apiKey: 'SECRET_OPT_KEY',
      cluster: 'options',
      initialSubscriptions: [...maxQuotes, 'AM.*'],
      socketFactory: harness.factory,
    });
    expect(optClient.getSnapshot().activeQuoteSubscriptionCount).toBe(OPTIONS_MAX_QUOTE_SUBSCRIPTIONS);

    const connectPromise = optClient.connect();
    const sock = harness.sockets[0];
    if (sock === undefined) {
      throw new Error('Expected socket');
    }
    sock.triggerMessage([{ ev: 'status', status: 'connected', message: 'Connected Successfully' }]);
    sock.triggerMessage([{ ev: 'status', status: 'auth_success', message: 'authenticated' }]);
    await connectPromise;

    const sentCountBefore = sock.sentFrames.length;
    // Trying to add contract #1001 must throw and leave state untouched
    expect(() => {
      optClient.subscribe('Q.O:SPY261218P00500000');
    }).toThrow(/1000/);
    expect(() => {
      optClient.subscribe('Q.*');
    }).toThrow(/wildcard quote/i);
    expect(sock.sentFrames.length).toBe(sentCountBefore);
    expect(optClient.getSnapshot().activeQuoteSubscriptionCount).toBe(OPTIONS_MAX_QUOTE_SUBSCRIPTIONS);

    // Stocks cluster DOES allow Q.*
    const stocksClient = new MassiveWsClient({
      apiKey: 'SECRET_OPT_KEY',
      cluster: 'stocks',
      initialSubscriptions: 'Q.*,AM.*',
      socketFactory: harness.factory,
    });
    expect(stocksClient.getSnapshot().subscriptions).toEqual(['Q.*', 'AM.*']);

    optClient.close();
    stocksClient.close();
  });

  it('never leaks apiKey in errors/snapshots and halts immediately on auth_failed without hammering', async () => {
    const harness = createMockSocketHarness();
    const fakeSleep = createFakeSleep();
    const capturedErrors: WsClientError[] = [];
    const secret = 'SUPER_SECRET_KEY_XYZ_123';

    const client = new MassiveWsClient({
      apiKey: secret,
      cluster: 'stocks',
      socketFactory: harness.factory,
      sleep: fakeSleep.sleep,
      onError: (err) => capturedErrors.push(err),
    });

    const connectPromise = client.connect();
    const sock = harness.sockets[0];
    if (sock === undefined) {
      throw new Error('Expected socket');
    }
    sock.triggerMessage([{ ev: 'status', status: 'connected', message: 'ok' }]);
    sock.triggerMessage([
      {
        ev: 'status',
        status: 'auth_failed',
        message: `authentication failed for key ${secret}`,
      },
    ]);

    let rejectedMsg = '';
    try {
      await connectPromise;
    } catch (err) {
      rejectedMsg = err instanceof Error ? err.message : String(err);
    }

    expect(rejectedMsg).not.toBe('');
    expect(rejectedMsg).not.toContain(secret);
    expect(rejectedMsg).toContain('<redacted>');

    expect(fakeSleep.delays).toHaveLength(0);
    expect(harness.sockets).toHaveLength(1);
    expect(capturedErrors).toHaveLength(1);
    expect(capturedErrors[0]?.code).toBe('auth_failed');
    expect(capturedErrors[0]?.message).not.toContain(secret);

    const snap = client.getSnapshot();
    expect(snap.state).toBe('error');
    expect(snap.lastError?.message).not.toContain(secret);
    expect(JSON.stringify(snap)).not.toContain(secret);
  });

  it('preserves >= 15s midnight ET reconnect and re-subscription, and trips the circuit on max_connections', async () => {
    const harness = createMockSocketHarness();
    const fakeSleep = createFakeSleep();
    const errors: WsClientError[] = [];

    // Even if minReconnectDelayMs is configured too small (e.g. 500ms), client clamps >= 15,000ms
    expect(computeReconnectBackoffMs({ attempt: 0, minDelayMs: 500, baseDelayMs: 500 })).toBe(
      MIN_RECONNECT_BACKOFF_MS,
    );
    expect(computeReconnectBackoffMs({ attempt: 1 })).toBe(30_000);
    expect(computeReconnectBackoffMs({ attempt: 2 })).toBe(60_000);
    expect(computeReconnectBackoffMs({ attempt: 3 })).toBe(120_000);
    expect(computeReconnectBackoffMs({ attempt: 6 })).toBe(120_000);

    const client = new MassiveWsClient({
      apiKey: 'KEY_RECONNECT_TEST',
      cluster: 'options',
      initialSubscriptions: ['A.O:SPY261218C00600000', 'AM.O:SPY261218C00600000'],
      socketFactory: harness.factory,
      sleep: fakeSleep.sleep,
      minReconnectDelayMs: 500,
      baseReconnectDelayMs: 500,
      onError: (e) => errors.push(e),
    });

    const pConnect = client.connect();
    const sock1 = harness.sockets[0];
    if (sock1 === undefined) {
      throw new Error('Expected sock1');
    }
    sock1.triggerMessage([{ ev: 'status', status: 'connected', message: 'ok' }]);
    sock1.triggerMessage([{ ev: 'status', status: 'auth_success', message: 'ok' }]);
    await pConnect;

    // Simulate midnight ET clean close while idle
    sock1.triggerClose(1000, 'Daily reset maintenance', true);
    expect(client.getSnapshot().state).toBe('reconnecting');
    expect(fakeSleep.delays).toEqual([MIN_RECONNECT_BACKOFF_MS]);

    // Before backoff elapses, no 2nd socket is opened
    expect(harness.sockets).toHaveLength(1);
    fakeSleep.releaseNext();
    await flushMicrotasks();

    expect(harness.sockets).toHaveLength(2);
    const sock2 = harness.sockets[1];
    if (sock2 === undefined) {
      throw new Error('Expected sock2');
    }
    sock2.triggerMessage([{ ev: 'status', status: 'connected', message: 'ok' }]);
    sock2.triggerMessage([{ ev: 'status', status: 'auth_success', message: 'ok' }]);

    expect(client.getSnapshot().state).toBe('ready');
    expect(sock2.sentFrames).toEqual([
      JSON.stringify({ action: 'auth', params: 'KEY_RECONNECT_TEST' }),
      JSON.stringify({
        action: 'subscribe',
        params: 'A.O:SPY261218C00600000,AM.O:SPY261218C00600000',
      }),
    ]);

    // Simulate max_connections status on sock2
    sock2.triggerMessage([
      { ev: 'status', status: 'max_connections', message: 'Maximum number of connections exceeded' },
    ]);
    expect(errors.some((e) => e.code === 'max_connections')).toBe(true);
    expect(client.getSnapshot().circuitBreakerOpen).toBe(true);
    expect(client.getSnapshot().circuitBreakerReason).toBe('max_connections');
    expect(client.getSnapshot().pendingReconnectTimers).toBe(0);
    expect(fakeSleep.delays).toEqual([MIN_RECONNECT_BACKOFF_MS]);
    expect(harness.sockets).toHaveLength(2);

    // Duplicate callbacks cannot schedule a reconnect after the circuit opens.
    sock2.triggerError(new Error('Maximum number of connections exceeded'));
    sock2.triggerClose(1008, 'Maximum number of connections exceeded', false);
    expect(client.getSnapshot().pendingReconnectTimers).toBe(0);
    expect(fakeSleep.delays).toEqual([MIN_RECONNECT_BACKOFF_MS]);
    expect(errors.filter((e) => e.code === 'max_connections')).toHaveLength(1);

    // Closing the client leaves no pending backoff and no third socket.
    client.close();
    fakeSleep.releaseNext();
    await flushMicrotasks();
    expect(harness.sockets).toHaveLength(2);
    expect(client.getSnapshot().state).toBe('closed');
  });

  it('buffers inbound messages non-blockingly for slow consumers and enforces bounded queue cap', async () => {
    const harness = createMockSocketHarness();
    const client = new MassiveWsClient({
      apiKey: 'QUEUE_TEST_KEY',
      cluster: 'stocks',
      socketFactory: harness.factory,
      maxQueueSize: 4,
    });

    const pConnect = client.connect();
    const sock = harness.sockets[0];
    if (sock === undefined) {
      throw new Error('Expected socket');
    }
    sock.triggerMessage([{ ev: 'status', status: 'connected', message: 'ok' }]);
    sock.triggerMessage([{ ev: 'status', status: 'auth_success', message: 'ok' }]);
    await pConnect;

    // Drain initial 2 status batches
    expect(client.drainInboundQueue()).toHaveLength(2);
    expect(client.getSnapshot().queueDepth).toBe(0);

    // Flood 6 inbound trade batches without draining -> bounded capacity 4 keeps newest 4, drops oldest 2
    for (let i = 1; i <= 6; i += 1) {
      sock.triggerMessage([
        { ev: 'T', sym: 'SPY', p: 500 + i, s: 10, t: 1_794_580_680_000 + i * 100 },
      ]);
    }

    const snap = client.getSnapshot();
    expect(snap.queueDepth).toBe(4);
    expect(snap.droppedQueueMessages).toBe(2);

    const firstTwo = client.drainInboundQueue(2);
    expect(firstTwo).toHaveLength(2);
    expect(firstTwo[0]?.ev).toBe('T');
    if (firstTwo[0]?.ev === 'T' && firstTwo[1]?.ev === 'T') {
      expect(firstTwo[0].price).toBe(503);
      expect(firstTwo[1].price).toBe(504);
    }

    const rest = client.drainInboundQueue();
    expect(rest).toHaveLength(2);
    expect(client.getSnapshot().queueDepth).toBe(0);

    client.close();
  });
});
