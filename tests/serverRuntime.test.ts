/**
 * Suite Vitest 100 % offline para la Pieza 13 (`src/server/*`).
 *
 * Verifica:
 *  - TTL dinámico ET exacto (`8_000 ms` power hour 14:30-16:00 ET, `10_000 ms` RTH 09:30-14:30 ET,
 *    `30_000 ms` off-hours/fines de semana) manejando EST y EDT sin mutar relojes del sistema.
 *  - Deduplicación single-flight (`SingleFlightRuntimeCache`) + no cacheo de errores.
 *  - Redacción estricta de secretos (`redactSecrets` y ausencia total en HTTP 503/JSON/WS).
 *  - Ciclo HTTP completo (`GET /api/health`, `/api/snapshot`, `/api/bars`, `/api/unusual`),
 *    con errores `503 NO_DATA` ante fallos del proveedor.
 *  - Broadcast WebSocket (`/ws`) con timestamps exclusivamente en segundos UTC enteros.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { priceBsm } from '../src/core/options/blackScholes.js';
import { MAX_TIME_SECONDS } from '../src/core/sessions.js';
import type { FetchFn } from '../src/data/types.js';
import type { MassiveWsClientOptions, WsNormalizedEvent } from '../src/data/wsTypes.js';
import {
  createHttpWsServer,
  type HttpWsServerHandle,
} from '../src/server/httpWsServer.js';
import {
  MarketRuntime,
  type MassiveWsClientLike,
  type TerminalBarsResponse,
  type TerminalSnapshotResponse,
  type TerminalUnusualResponse,
} from '../src/server/marketRuntime.js';
import {
  OFF_HOURS_TTL_MS,
  POWER_HOUR_TTL_MS,
  RTH_TTL_MS,
  SingleFlightRuntimeCache,
  computeDynamicTtlMs,
  redactSecrets,
} from '../src/server/runtimeCache.js';

function etDateTimeToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
  isEdt = false,
): number {
  const offsetHours = isEdt ? 4 : 5;
  return Date.UTC(year, month - 1, day, hour + offsetHours, minute, second);
}

function buildRealisticBarsPayload(
  symbol: string,
  multiplier: number,
  timeframe: string,
  asOfUtcSec: number,
): Record<string, unknown> {
  const unitSec =
    timeframe === 'day'
      ? 86_400
      : timeframe === 'hour'
        ? 3_600
        : 60;
  const barSec = Math.max(60, multiplier * unitSec);
  const count = 260;
  const results: Record<string, unknown>[] = [];
  // Termina la serie exactamente una barra antes de asOfUtcSec para simular historial cerrado reciente
  const endOpenSec = Math.floor((asOfUtcSec - barSec) / barSec) * barSec;
  for (let i = count - 1; i >= 0; i -= 1) {
    const tSec = endOpenSec - i * barSec;
    const idx = count - 1 - i;
    const base = symbol === 'QQQ' ? 500 : symbol === 'I:VIX' ? 16 : 590;
    const drift = base + idx * 0.04 + Math.sin(idx * 0.25) * 0.8;
    const open = Number((drift - 0.12).toFixed(4));
    const close = Number(drift.toFixed(4));
    const high = Number((Math.max(open, close) + 0.35).toFixed(4));
    const low = Number((Math.min(open, close) - 0.35).toFixed(4));
    const volume = symbol === 'I:VIX' ? 0 : 120_000 + (idx % 17) * 5_000;
    results.push({
      t: tSec * 1_000,
      o: open,
      h: high,
      l: low,
      c: close,
      v: volume,
      vw: Number(((high + low + close) / 3).toFixed(4)),
    });
  }
  return {
    status: 'OK',
    ticker: symbol,
    resultsCount: results.length,
    results,
  };
}

function createOfflineMassiveFetch(params: {
  readonly asOfUtcSec: number;
  readonly secretKey: string;
  readonly failMode?: boolean;
}): FetchFn {
  const { asOfUtcSec, secretKey, failMode = false } = params;
  const expiryDate1 = '2025-04-11';
  const expiryDate2 = '2025-04-25';
  const spot = 595.0;
  const rate = 0.043;
  const q = 0.012;
  const strikes = [565, 575, 585, 590, 595, 600, 605, 615, 625];

  const makeOcc = (expCompact: string, typeChar: 'C' | 'P', strike: number): string => {
    const padded = String(Math.round(strike * 1_000)).padStart(8, '0');
    return `O:SPY${expCompact}${typeChar}${padded}`;
  };

  return (url: string) => {
    if (failMode) {
      return Promise.resolve({
        ok: false,
        status: 502,
        text: JSON.stringify({
          status: 'ERROR',
          error: `Upstream Massive failure for request https://api.massive.com/x?apiKey=${secretKey}`,
        }),
        headers: {},
      });
    }

    const parsed = new URL(url);
    const path = parsed.pathname;

    if (path.startsWith('/v2/aggs/ticker/')) {
      const segments = path.split('/');
      const ticker = decodeURIComponent(segments[4] ?? 'SPY');
      const multiplier = Number(segments[6] ?? '5') || 5;
      const timespan = segments[7] ?? 'minute';
      return Promise.resolve({
        ok: true,
        status: 200,
        text: JSON.stringify(buildRealisticBarsPayload(ticker, multiplier, timespan, asOfUtcSec)),
        headers: {},
      });
    }

    if (path === '/fed/v1/treasury-yields') {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: JSON.stringify({
          status: 'OK',
          results: [
            {
              date: '2025-03-10',
              yield_1_month: 4.31,
              yield_3_month: 4.3,
              yield_6_month: 4.25,
              yield_1_year: 4.15,
              yield_2_year: 4.02,
              yield_3_year: 4.04,
              yield_5_year: 4.1,
              yield_7_year: 4.18,
              yield_10_year: 4.26,
              yield_20_year: 4.5,
              yield_30_year: 4.56,
            },
          ],
        }),
        headers: {},
      });
    }

    if (path === '/fed/v1/funding-conditions') {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: JSON.stringify({
          status: 'OK',
          results: [
            {
              date: '2025-03-10',
              effective_fed_funds_rate: 4.33,
              effective_fed_funds_volume: 95_000_000_000,
              sofr: 4.31,
              sofr_volume: 2_100_000_000_000,
            },
          ],
        }),
        headers: {},
      });
    }

    if (path === '/v3/snapshot') {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: JSON.stringify({
          status: 'OK',
          results: [
            {
              ticker: 'SPY',
              type: 'stocks',
              market_status: 'open',
              session: {
                price: spot,
                close: spot,
                previous_close: 592.5,
                change: 2.5,
                change_percent: 0.4219,
                volume: 42_000_000,
              },
              last_trade: { price: spot, size: 100, sip_timestamp: String(asOfUtcSec * 1_000_000_000) },
              last_quote: { bid: 594.98, ask: 595.02, midpoint: 595.0 },
            },
            {
              ticker: 'QQQ',
              type: 'stocks',
              market_status: 'open',
              session: {
                price: 505.25,
                close: 505.25,
                previous_close: 503.0,
                change: 2.25,
                change_percent: 0.4473,
                volume: 28_000_000,
              },
            },
            {
              ticker: 'I:SPX',
              type: 'indices',
              market_status: 'open',
              value: 5950.5,
              session: { price: 5950.5, previous_close: 5925.0, change: 25.5, change_percent: 0.43 },
            },
            {
              ticker: 'I:VIX',
              type: 'indices',
              market_status: 'open',
              value: 16.4,
              session: { price: 16.4, previous_close: 16.9, change: -0.5, change_percent: -2.96 },
            },
            {
              ticker: 'I:SKEW',
              type: 'indices',
              market_status: 'open',
              value: 138.2,
              session: { price: 138.2, previous_close: 137.0, change: 1.2, change_percent: 0.87 },
            },
          ],
        }),
        headers: {},
      });
    }

    if (path === '/v3/reference/options/contracts') {
      const results: Record<string, unknown>[] = [];
      for (const [expDate, expCompact] of [
        [expiryDate1, '250411'],
        [expiryDate2, '250425'],
      ] as const) {
        for (const strike of strikes) {
          for (const ct of ['call', 'put'] as const) {
            results.push({
              ticker: makeOcc(expCompact, ct === 'call' ? 'C' : 'P', strike),
              underlying_ticker: 'SPY',
              contract_type: ct,
              strike_price: strike,
              expiration_date: expDate,
              shares_per_contract: 100,
            });
          }
        }
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: JSON.stringify({ status: 'OK', results }),
        headers: {},
      });
    }

    if (path.startsWith('/v3/snapshot/options/')) {
      const results: Record<string, unknown>[] = [];
      const expirySpecs: readonly { date: string; compact: string; t: number }[] = [
        {
          date: expiryDate1,
          compact: '250411',
          t: (Math.floor(Date.UTC(2025, 3, 11, 20, 0, 0) / 1_000) - asOfUtcSec) / (365 * 86_400),
        },
        {
          date: expiryDate2,
          compact: '250425',
          t: (Math.floor(Date.UTC(2025, 3, 25, 20, 0, 0) / 1_000) - asOfUtcSec) / (365 * 86_400),
        },
      ];
      for (const spec of expirySpecs) {
        for (const strike of strikes) {
          const moneyness = (spot - strike) / spot;
          const sigma = 0.18 + Math.max(0, moneyness) * 0.25 + Math.abs(moneyness) * 0.08;
          for (const ct of ['call', 'put'] as const) {
            const fair = priceBsm({
              spot,
              strike,
              timeToExpiry: spec.t,
              rate,
              dividendYield: q,
              volatility: sigma,
              contractType: ct,
            });
            const bid = Number(Math.max(0.05, fair * 0.99).toFixed(4));
            const ask = Number((fair * 1.01 + 0.02).toFixed(4));
            const mid = Number((0.5 * (bid + ask)).toFixed(4));
            results.push({
              details: {
                ticker: makeOcc(spec.compact, ct === 'call' ? 'C' : 'P', strike),
                contract_type: ct,
                strike_price: strike,
                expiration_date: spec.date,
                shares_per_contract: 100,
              },
              day: { volume: 650 },
              open_interest: ct === 'call' && strike === 605 ? 18_000 : 8_000,
              implied_volatility: sigma,
              last_quote: { bid, ask, midpoint: mid },
              last_trade: { price: mid, sip_timestamp: String(asOfUtcSec * 1_000_000_000) },
              underlying_asset: { ticker: 'SPY', price: spot },
            });
          }
        }
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: JSON.stringify({ status: 'OK', results }),
        headers: {},
      });
    }

    if (path === '/stocks/v1/dividends') {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: JSON.stringify({ status: 'OK', results: [] }),
        headers: {},
      });
    }

    if (path === '/options/v1/unusual-trades') {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: JSON.stringify({
          status: 'OK',
          results: [
            {
              ticker: makeOcc('250411', 'C', 605),
              underlying_ticker: 'SPY',
              sip_timestamp: String(asOfUtcSec * 1_000_000_000 + 123_456_789),
              price: 4.85,
              size: 400,
              exchange: 302,
              conditions: [209],
              flags: ['block_premium', 'iso'],
              sequence_number: 99_001,
            },
          ],
        }),
        headers: {},
      });
    }

    return Promise.resolve({
      ok: false,
      status: 404,
      text: JSON.stringify({ status: 'NOT_FOUND', error: `Unexpected test URL ${path}` }),
      headers: {},
    });
  };
}

describe('serverRuntime — cache, ET TTL, redaction & HTTP/WS integration (offline)', () => {
  const activeServers: HttpWsServerHandle[] = [];

  afterEach(async () => {
    while (activeServers.length > 0) {
      const handle = activeServers.pop();
      if (handle !== undefined) {
        await handle.stop();
      }
    }
  });

  it('computes dynamic ET TTL accurately across EST, EDT, RTH, power hour and weekends', () => {
    // 2025-01-15 = miércoles en horario estándar EST (UTC-5)
    expect(computeDynamicTtlMs(etDateTimeToUtcMs(2025, 1, 15, 9, 29, 59, false))).toBe(
      OFF_HOURS_TTL_MS,
    );
    expect(computeDynamicTtlMs(etDateTimeToUtcMs(2025, 1, 15, 9, 30, 0, false))).toBe(RTH_TTL_MS);
    expect(computeDynamicTtlMs(etDateTimeToUtcMs(2025, 1, 15, 14, 29, 59, false))).toBe(
      RTH_TTL_MS,
    );
    expect(computeDynamicTtlMs(etDateTimeToUtcMs(2025, 1, 15, 14, 30, 0, false))).toBe(
      POWER_HOUR_TTL_MS,
    );
    expect(computeDynamicTtlMs(etDateTimeToUtcMs(2025, 1, 15, 15, 59, 59, false))).toBe(
      POWER_HOUR_TTL_MS,
    );
    expect(computeDynamicTtlMs(etDateTimeToUtcMs(2025, 1, 15, 16, 0, 0, false))).toBe(
      OFF_HOURS_TTL_MS,
    );
    // Sábado EST -> off-hours
    expect(computeDynamicTtlMs(etDateTimeToUtcMs(2025, 1, 18, 12, 0, 0, false))).toBe(
      OFF_HOURS_TTL_MS,
    );

    // 2025-07-15 = martes en horario de verano EDT (UTC-4)
    expect(computeDynamicTtlMs(etDateTimeToUtcMs(2025, 7, 15, 10, 15, 0, true))).toBe(RTH_TTL_MS);
    expect(computeDynamicTtlMs(etDateTimeToUtcMs(2025, 7, 15, 15, 0, 0, true))).toBe(
      POWER_HOUR_TTL_MS,
    );
    expect(computeDynamicTtlMs(etDateTimeToUtcMs(2025, 7, 15, 16, 5, 0, true))).toBe(
      OFF_HOURS_TTL_MS,
    );

    expect(() => computeDynamicTtlMs(-1)).toThrow(/Invalid nowMs/);
  });

  it('deduplicates concurrent calls via single-flight and never caches rejected loads', async () => {
    let clockMs = etDateTimeToUtcMs(2025, 3, 10, 14, 45, 0, true); // power hour -> 8_000 ms
    const cache = new SingleFlightRuntimeCache<string>({
      nowFn: () => clockMs,
    });

    let loadCalls = 0;
    const loader = async (): Promise<string> => {
      loadCalls += 1;
      await new Promise((r) => setTimeout(r, 15));
      return `v${String(loadCalls)}`;
    };

    const [a, b, c] = await Promise.all([
      cache.getOrCompute('SPY', loader),
      cache.getOrCompute('SPY', loader),
      cache.getOrCompute('SPY', loader),
    ]);
    expect(loadCalls).toBe(1);
    expect(a.value).toBe('v1');
    expect(b.value).toBe('v1');
    expect(c.value).toBe('v1');
    expect(a.sharedInFlight || b.sharedInFlight || c.sharedInFlight).toBe(true);

    // Within 8_000 ms TTL -> cache hit
    clockMs += 5_000;
    const warm = await cache.getOrCompute('SPY', loader);
    expect(warm.cacheHit).toBe(true);
    expect(loadCalls).toBe(1);

    // Past 8_000 ms TTL -> recompute
    clockMs += 3_500;
    const refreshed = await cache.getOrCompute('SPY', loader);
    expect(refreshed.cacheHit).toBe(false);
    expect(refreshed.value).toBe('v2');
    expect(loadCalls).toBe(2);

    // Errors are never cached
    let attempt = 0;
    const flakyLoader = (): Promise<string> => {
      attempt += 1;
      if (attempt === 1) {
        return Promise.reject(new Error('transient upstream error'));
      }
      return Promise.resolve('recovered');
    };
    await expect(cache.getOrCompute('QQQ', flakyLoader)).rejects.toThrow(/transient/);
    const recovered = await cache.getOrCompute('QQQ', flakyLoader);
    expect(recovered.value).toBe('recovered');
    expect(attempt).toBe(2);
  });

  it('redacts raw keys, encoded keys, URL params and bearer tokens cleanly', () => {
    const secret = 'my+secret/key=42';
    const raw = `GET https://api.massive.com/v2/aggs?apiKey=${encodeURIComponent(secret)} header Bearer ${secret} raw=${secret}`;
    const cleaned = redactSecrets(raw, [secret]);
    expect(cleaned).not.toContain(secret);
    expect(cleaned).not.toContain(encodeURIComponent(secret));
    expect(cleaned).toContain('[REDACTED]');
  });

  it('serves /api/health, /api/snapshot, /api/bars, /api/unusual cleanly without NaN or secrets', async () => {    const fixedNowMs = etDateTimeToUtcMs(2025, 3, 10, 14, 45, 0, true);
    const fixedNowSec = Math.floor(fixedNowMs / 1_000);
    const secretKey = 'TOP_SECRET_OFFLINE_KEY_987';

    const runtime = new MarketRuntime({
      apiKey: secretKey,
      secrets: [secretKey],
      nowMsFn: () => fixedNowMs,
      enableWs: false,
      fetchFn: createOfflineMassiveFetch({ asOfUtcSec: fixedNowSec, secretKey }),
    });

    const server = createHttpWsServer({
      runtime,
      host: '127.0.0.1',
      port: 0,
      secrets: [secretKey],
      startRuntimeWs: false,
    });
    activeServers.push(server);
    const { host, port } = await server.start();
    const base = `http://${host}:${String(port)}`;

    const healthRes = await fetch(`${base}/api/health`);
    expect(healthRes.status).toBe(200);
    const healthJson = (await healthRes.json()) as { readonly hasApiKey: boolean; readonly ok: boolean };
    expect(healthJson.ok).toBe(true);
    expect(healthJson.hasApiKey).toBe(true);

    const snapRes = await fetch(`${base}/api/snapshot?symbol=SPY`);
    const snapText = await snapRes.text();
    expect(snapRes.status, `snapshot failed: ${snapText}`).toBe(200);
    expect(snapText).not.toContain(secretKey);
    expect(snapText).not.toMatch(/(?<=[:,[])\s*(?:NaN|-?Infinity|undefined)\b/);
    const snap = JSON.parse(snapText) as TerminalSnapshotResponse;
    expect(snap.symbol).toBe('SPY');
    expect(snap.asOfUtcSec).toBeLessThanOrEqual(MAX_TIME_SECONDS);
    expect(snap.envelope.envelopeStatus).toMatch(/^(OK|PARTIAL)$/);
    expect(snap.exposureSummary).not.toBeNull();
    expect(typeof snap.exposureSummary?.netGex).toBe('number');
    expect(snap.exposureSummary?.callWallStrike).not.toBeNull();
    expect(snap.exposureSummary?.putWallStrike).not.toBeNull();
    expect(snap.volSurfaceSummary?.frontSlice).not.toBeNull();
    expect(snap.volSurfaceSummary?.contracts.length).toBeGreaterThan(0);

    const barsRes = await fetch(`${base}/api/bars?symbol=SPY&timeframe=5m&visibleBars=120`);
    expect(barsRes.status).toBe(200);
    const barsPayload = (await barsRes.json()) as TerminalBarsResponse;
    expect(barsPayload.bars.length).toBeGreaterThan(20);
    expect(barsPayload.overlays.sessionVwapSupported).toBe(true);
    expect(barsPayload.overlays.ema21.length).toBe(barsPayload.bars.length);
    for (const b of barsPayload.bars) {
      expect(Number.isInteger(b.time)).toBe(true);
      expect(b.time).toBeLessThanOrEqual(MAX_TIME_SECONDS);
    }

    // Session VWAP is strictly unsupported for 1h (>30m): zero silent fallback, returns all nulls
    const bars1hRes = await fetch(`${base}/api/bars?symbol=SPY&timeframe=1h&visibleBars=60`);
    expect(bars1hRes.status).toBe(200);
    const bars1h = (await bars1hRes.json()) as TerminalBarsResponse;
    expect(bars1h.overlays.sessionVwapSupported).toBe(false);
    expect(bars1h.overlays.sessionVwap.every((v) => v === null)).toBe(true);

    const unusualRes = await fetch(`${base}/api/unusual?symbol=SPY&limit=10`);
    expect(unusualRes.status).toBe(200);
    const unusual = (await unusualRes.json()) as TerminalUnusualResponse;
    expect(unusual.status).toBe('OK');
    expect(unusual.trades.length).toBe(1);
    expect(unusual.trades[0]?.time).toBe(fixedNowSec);
    expect(unusual.trades[0]?.ticker).toBe('O:SPY250411C00605000');
  }, 15_000);

  it('returns HTTP 503 NO_DATA without exposing secrets when Massive upstream fails', async () => {
    const fixedNowMs = etDateTimeToUtcMs(2025, 3, 10, 14, 45, 0, true);
    const fixedNowSec = Math.floor(fixedNowMs / 1_000);
    const secretKey = 'ULTRA_SECRET_LEAK_GUARD_777';

    const runtime = new MarketRuntime({
      apiKey: secretKey,
      secrets: [secretKey],
      nowMsFn: () => fixedNowMs,
      enableWs: false,
      fetchFn: createOfflineMassiveFetch({
        asOfUtcSec: fixedNowSec,
        secretKey,
        failMode: true,
      }),
    });

    const server = createHttpWsServer({
      runtime,
      host: '127.0.0.1',
      port: 0,
      secrets: [secretKey],
      startRuntimeWs: false,
    });
    activeServers.push(server);
    const { host, port } = await server.start();
    const base = `http://${host}:${String(port)}`;

    const snapFail = await fetch(`${base}/api/snapshot?symbol=SPY`);
    expect(snapFail.status).toBe(503);
    const snapText = await snapFail.text();
    expect(snapText).not.toContain(secretKey);
    const snapJson = JSON.parse(snapText) as { readonly status: string; readonly reason: string; readonly detail: string };
    expect(snapJson.status).toBe('NO_DATA');
    expect(snapJson.detail).not.toContain(secretKey);

    const barsFail = await fetch(`${base}/api/bars?symbol=SPY&timeframe=5m`);
    expect(barsFail.status).toBe(503);
    const barsText = await barsFail.text();
    expect(barsText).not.toContain(secretKey);
    expect((JSON.parse(barsText) as { readonly status: string }).status).toBe('NO_DATA');

    const unusualFail = await fetch(`${base}/api/unusual?symbol=SPY`);
    expect(unusualFail.status).toBe(503);
    const unusualText = await unusualFail.text();
    expect(unusualText).not.toContain(secretKey);
    expect((JSON.parse(unusualText) as { readonly status: string }).status).toBe('NO_DATA');
  });

  it('broadcasts normalized WS events over /ws strictly in integer UTC seconds', async () => {
    const fixedNowMs = etDateTimeToUtcMs(2025, 3, 10, 14, 45, 0, true);
    const fixedNowSec = Math.floor(fixedNowMs / 1_000);
    const secretKey = 'WS_OFFLINE_SECRET_111';

    let captureOnEvents: ((events: readonly WsNormalizedEvent[]) => void) | undefined;
    const mockWsClientFactory = (opts: MassiveWsClientOptions): MassiveWsClientLike => {
      captureOnEvents = opts.onEvents;
      return {
        connect: () => Promise.resolve(),
        subscribe: () => undefined,
        unsubscribe: () => undefined,
        close: () => undefined,
        getSnapshot: () => ({
          cluster: opts.cluster,
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

    const runtime = new MarketRuntime({
      apiKey: secretKey,
      secrets: [secretKey],
      nowMsFn: () => fixedNowMs,
      enableWs: true,
      watchedSymbols: ['SPY'],
      createWsClientFn: mockWsClientFactory,
      fetchFn: createOfflineMassiveFetch({ asOfUtcSec: fixedNowSec, secretKey }),
    });

    const server = createHttpWsServer({
      runtime,
      host: '127.0.0.1',
      port: 0,
      secrets: [secretKey],
      startRuntimeWs: true,
    });
    activeServers.push(server);
    const { host, port } = await server.start();

    const receivedMessages: Record<string, unknown>[] = [];
    const client = new WebSocket(`ws://${host}:${String(port)}/ws`);

    await new Promise<void>((resolveOpen, rejectOpen) => {
      client.once('open', () => {
        resolveOpen();
      });
      client.once('error', (err) => {
        rejectOpen(err);
      });
    });

    client.on('message', (raw) => {
      const text = typeof raw === 'string' ? raw : Buffer.from(raw as Uint8Array).toString('utf-8');
      receivedMessages.push(JSON.parse(text) as Record<string, unknown>);
    });

    await new Promise((r) => setTimeout(r, 30));

    expect(captureOnEvents).toBeDefined();
    captureOnEvents?.([
      {
        ev: 'T',
        sym: 'SPY',
        price: 595.4,
        size: 200,
        timeSec: fixedNowSec,
        eventTimeMs: fixedNowSec * 1_000,
      },
      {
        ev: 'A',
        sym: 'SPY',
        startMs: (fixedNowSec - 1) * 1_000,
        endMs: fixedNowSec * 1_000,
        bar: {
          time: fixedNowSec - 1,
          open: 595.1,
          high: 595.5,
          low: 595.0,
          close: 595.4,
          volume: 12_500,
          vw: 595.28,
        },
      },
    ]);

    await new Promise((r) => setTimeout(r, 120));
    client.close();

    const batchMessages = receivedMessages.filter((m) => m['type'] === 'market_batch');
    const tradeMsg = batchMessages
      .flatMap((batch) => (Array.isArray(batch['events']) ? (batch['events'] as Record<string, unknown>[]) : []))
      .find((event) => event['type'] === 'trade');
    const barUpdateMsg = batchMessages
      .flatMap((batch) => (Array.isArray(batch['events']) ? (batch['events'] as Record<string, unknown>[]) : []))
      .find((event) => event['type'] === 'bar_update');
    expect(batchMessages.length).toBeGreaterThan(0);
    expect(tradeMsg).toBeDefined();
    expect(barUpdateMsg).toBeDefined();
    expect(tradeMsg?.['time']).toBe(fixedNowSec);
    expect(barUpdateMsg?.['time']).toBeLessThanOrEqual(MAX_TIME_SECONDS);
    expect(JSON.stringify(receivedMessages)).not.toContain(secretKey);
  });

  it('computes Piezas 15-18 terminalEngines, supports EOD_CIERRE when closed, warmup() & /api/health warmupStatus (Pieza 19)', async () => {
    const secretKey = 'SECRET_PIEZA19_KEY';
    const fixedNowMs = etDateTimeToUtcMs(2025, 3, 10, 15, 0, 0);
    const fixedNowSec = Math.floor(fixedNowMs / 1_000);
    const baseFetch = createOfflineMassiveFetch({ asOfUtcSec: fixedNowSec, secretKey });

    const closedMarketFetch: FetchFn = async (url) => {
      const res = await baseFetch(url);
      const { pathname } = new URL(url);
      if (pathname === '/v3/snapshot' && typeof res.text === 'string') {
        return {
          ...res,
          text: res.text.replaceAll('"market_status":"open"', '"market_status":"closed"'),
        };
      }
      return res;
    };

    const runtime = new MarketRuntime({
      apiKey: secretKey,
      secrets: [secretKey],
      nowMsFn: () => fixedNowMs,
      enableWs: false,
      fetchFn: closedMarketFetch,
    });

    await runtime.warmup(['SPY']);
    const snap = await runtime.getSnapshot('SPY');
    expect(snap.feedMode).toBe('EOD_CIERRE');
    expect(snap.terminalEngines).toBeDefined();
    expect(snap.terminalEngines).not.toBeNull();
    expect(snap.terminalEngines?.atr14d).toBeGreaterThan(0);
    expect(snap.terminalEngines?.volumeProfile?.status).toBe('OK');
    expect(snap.terminalEngines?.nakedPocs).not.toBeNull();
    expect(snap.terminalEngines?.fvgs).not.toBeNull();
    expect(snap.terminalEngines?.orderBlocks).not.toBeNull();
    expect(snap.terminalEngines?.orderFlow).not.toBeNull();
    expect(snap.terminalEngines?.volOiAnomalies).not.toBeNull();
    expect(snap.terminalEngines?.flowAdjustedGex).not.toBeNull();
    expect(snap.terminalEngines?.gexCharmPin).not.toBeNull();
    expect(snap.terminalEngines?.wheelTracker).not.toBeNull();
    expect(snap.terminalEngines?.qDistribution?.status).toBe('OK');
    expect(snap.terminalEngines?.pDistribution?.status).toBe('OK');
    expect(snap.terminalEngines?.pqDivergence?.status).toBe('OK');
    expect(snap.terminalEngines?.volCone?.status).toBe('OK');
    expect(snap.terminalEngines?.syntheticRates).not.toBeNull();
    expect(snap.terminalEngines?.buyWrite?.status).toBe('OK');
    expect(snap.terminalEngines?.confluenceClusters).not.toBeNull();
    expect(snap.terminalEngines?.structureOptimizerBullish?.status).toBe('OK');
    expect(snap.terminalEngines?.structureOptimizerBearish).not.toBeNull();

    const server = createHttpWsServer({
      runtime,
      host: '127.0.0.1',
      port: 0,
      secrets: [secretKey],
      startRuntimeWs: false,
      enableBackgroundWarmup: false,
    });
    activeServers.push(server);
    const { host, port } = await server.start();

    const healthRes = await fetch(`http://${host}:${String(port)}/api/health`);
    expect(healthRes.status).toBe(200);
    const healthText = await healthRes.text();
    expect(healthText).not.toContain(secretKey);
    const healthJson = JSON.parse(healthText) as {
      ok: boolean;
      hasApiKey: boolean;
      warmupStatus: string;
    };
    expect(healthJson.ok).toBe(true);
    expect(healthJson.hasApiKey).toBe(true);
    expect(['IDLE', 'WARMING_UP', 'READY']).toContain(healthJson.warmupStatus);
  });

  it('serializes NaN callVolume/putVolume in exposureSummary.byStrike as null without crashing snapshot', async () => {
    const secretKey = 'SECRET_VOLUME_NULL_KEY';
    const fixedNowMs = etDateTimeToUtcMs(2025, 3, 10, 14, 45, 0, true);
    const fixedNowSec = Math.floor(fixedNowMs / 1_000);
    const baseFetch = createOfflineMassiveFetch({ asOfUtcSec: fixedNowSec, secretKey });

    const missingVolumeFetch: FetchFn = async (url) => {
      const res = await baseFetch(url);
      const { pathname } = new URL(url);
      if (pathname.startsWith('/v3/snapshot/options/') && typeof res.text === 'string') {
        const parsed = JSON.parse(res.text) as { status: string; results: Record<string, unknown>[] };
        for (const item of parsed.results) {
          const details = item['details'] as { strike_price?: number; contract_type?: string } | undefined;
          if (details?.strike_price === 605 && details.contract_type === 'call') {
            item['day'] = {};
          }
        }
        return { ...res, text: JSON.stringify(parsed) };
      }
      return res;
    };

    const runtime = new MarketRuntime({
      apiKey: secretKey,
      secrets: [secretKey],
      nowMsFn: () => fixedNowMs,
      enableWs: false,
      fetchFn: missingVolumeFetch,
    });

    const snap = await runtime.getSnapshot('SPY');
    const row605 = snap.exposureSummary?.byStrike.find((s) => s.strike === 605);
    expect(row605).toBeDefined();
    expect(row605?.callVolume).toBeNull();
    expect(row605?.putVolume).toBeGreaterThan(0);
  });
});
