/**
 * Suite Vitest 100% offline para Pieza 43:
 *  1) Paridad estricta (< 1e-9) con `fixtures/stock_detail_stability_reference.json`
 *     (picker tabs, normalización L2, anti-huérfanos BID/ASK, fallback AR y estado global).
 *  2) Auto-negociación REST Live<->Sandbox ante HTTP 401/403, circuit-breaker `AUTH_INVALID`
 *     y fallback automático del ADR NBBO de GGAL Specialist hacia FMP Enterprise.
 *  3) `FeedsHealthMonitor`: emisión de `AUTH_INVALID` para `TRADIER_LIVE_WS` sin degradar
 *     el estado operativo global y preservando esquema de pulso.
 *  4) BYMA intraday fallback (`1m`/`5m`/`15m`/`1h`/`4h` -> `1D`) y limpieza L1/L2 en `BMA`.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  formatHeaderSideQuote,
  normalizeStockDetailHeaderQuotes,
  normalizeStockDetailOrderBook,
  resolveGlobalConnectivityStatus,
  resolveStockPickerOnOpenTransition,
  type GlobalConnectivityStatusInput,
  type RawOrderBookLevelInput,
  type StockPickerTransitionInput,
} from '../src/core/stockDetailStability.js';
import type { Bar } from '../src/core/types.js';
import type { FetchFn } from '../src/data/types.js';
import { ArgentinaMarketRuntime } from '../src/server/argentinaMarketLoader.js';
import {
  FeedsHealthMonitor,
  emptyFeedTelemetrySnapshot,
  type FeedsHealthMonitorDeps,
} from '../src/server/feedsHealthMonitor.js';
import { FMP_STABLE_BASE_URL } from '../src/server/fmpClient.js';
import { GgalSpecialistRuntime } from '../src/server/ggalSpecialistRuntime.js';
import { MarketRuntime } from '../src/server/marketRuntime.js';
import type { BmbBridgeClient, BmbBridgeSnapshotDto } from '../src/server/primaryRofexLoader.js';
import {
  TRADIER_PROD_REST_BASE,
  TRADIER_SANDBOX_REST_BASE,
  TRADIER_SANDBOX_WS_BASE,
  TRADIER_WS_BASE,
  TradierAuthCircuitBreaker,
  TradierAuthInvalidError,
  fetchTradierOptionChain,
  fetchTradierQuotes,
  type TradierConfig,
  type TradierHttpFn,
} from '../src/server/tradierAdapter.js';
import { TradierHistoricalClient } from '../src/server/tradierStream.js';
import { resolveArIntradayFallback } from '../src/server/wsCoalescerAndStability.js';
import { resolveArTimeframeFallback } from '../web/src/components/stock-detail/stockDetailRouting.js';

interface StabilityFixture {
  readonly meta: { readonly precisionTolerance: number };
  readonly pickerTransitions: readonly {
    readonly name: string;
    readonly input: StockPickerTransitionInput;
    readonly expected: {
      readonly activeCategory: string;
      readonly query: string;
      readonly activeIndex: number;
      readonly shouldFocusInput: boolean;
    };
  }[];
  readonly l2Cases: readonly {
    readonly name: string;
    readonly bids: readonly RawOrderBookLevelInput[];
    readonly asks: readonly RawOrderBookLevelInput[];
    readonly headerInput: {
      readonly quoteBid: number | null;
      readonly quoteBidSize: number | null;
      readonly quoteAsk: number | null;
      readonly quoteAskSize: number | null;
    };
    readonly expectedBook: {
      readonly bids: readonly { readonly price: number; readonly size: number; readonly orderCount?: number }[];
      readonly asks: readonly { readonly price: number; readonly size: number; readonly orderCount?: number }[];
      readonly bestBid: number | null;
      readonly bestBidSize: number | null;
      readonly bestAsk: number | null;
      readonly bestAskSize: number | null;
      readonly spreadAbs: number | null;
      readonly spreadPct: number | null;
      readonly mid: number | null;
      readonly obi5: number | null;
    };
    readonly expectedHeader: {
      readonly bid: number | null;
      readonly bidSize: number | null;
      readonly ask: number | null;
      readonly askSize: number | null;
      readonly spreadAbs: number | null;
      readonly spreadPct: number | null;
    };
  }[];
  readonly arIntradayFallback: Readonly<
    Record<
      string,
      {
        readonly requestedTimeframe: string;
        readonly effectiveTimeframe: string;
        readonly fallbackReason: string | null;
      }
    >
  >;
  readonly connectivityCases: readonly {
    readonly name: string;
    readonly input: GlobalConnectivityStatusInput;
    readonly expected: {
      readonly tone: string;
      readonly label: string;
      readonly operationalActiveCount: number;
      readonly degradedOperationalCount: number;
    };
  }[];
}

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/stock_detail_stability_reference.json', import.meta.url), 'utf-8'),
) as StabilityFixture;

const TOL = fixture.meta.precisionTolerance;

function makeTradierCfg(apiEnv: 'prod' | 'sandbox'): TradierConfig {
  return {
    accessToken: 'unit-test-tradier-secret',
    tokenEnvName: 'TRADIER_API_TOKEN',
    apiEnv,
    restBaseUrl: apiEnv === 'sandbox' ? TRADIER_SANDBOX_REST_BASE : TRADIER_PROD_REST_BASE,
    wsBaseUrl: apiEnv === 'sandbox' ? TRADIER_SANDBOX_WS_BASE : TRADIER_WS_BASE,
    configured: true,
    tokenIsGeneric: false,
    sandboxFallbackAllowed: true,
  };
}

function makeDailyBars(count: number, startSec = 1_760_000_000): readonly Bar[] {
  return Array.from({ length: count }, (_, idx) => {
    const time = startSec + idx * 86_400;
    const base = 8_000 + idx * 12;
    return {
      time,
      open: base - 25,
      high: base + 55,
      low: base - 45,
      close: base,
      volume: 15_000 + idx * 10,
      vw: base,
    };
  });
}

describe('Pieza 43 — paridad Python para picker, L2, anti-huérfanos, fallback AR y estado global', () => {
  it('mantiene pestaña y búsqueda del Stock Picker al recibir updates en vivo', () => {
    for (const c of fixture.pickerTransitions) {
      expect(resolveStockPickerOnOpenTransition(c.input), c.name).toEqual(c.expected);
    }
  });

  it('normaliza libro L2 (price > 0), calcula Spread moneda/% y evita tamaños huérfanos BID/ASK', () => {
    for (const c of fixture.l2Cases) {
      const actualBook = normalizeStockDetailOrderBook(c.bids, c.asks, 5);
      expect(actualBook.bids, c.name).toEqual(c.expectedBook.bids);
      expect(actualBook.asks, c.name).toEqual(c.expectedBook.asks);
      expect(actualBook.bestBid, c.name).toBe(c.expectedBook.bestBid);
      expect(actualBook.bestBidSize, c.name).toBe(c.expectedBook.bestBidSize);
      expect(actualBook.bestAsk, c.name).toBe(c.expectedBook.bestAsk);
      expect(actualBook.bestAskSize, c.name).toBe(c.expectedBook.bestAskSize);

      const expectNumOrNaN = (actual: number, expected: number | null, field: string): void => {
        if (expected === null) {
          expect(Number.isNaN(actual), `${c.name}.${field}`).toBe(true);
        } else {
          expect(Math.abs(actual - expected), `${c.name}.${field}`).toBeLessThan(TOL);
        }
      };

      expectNumOrNaN(actualBook.spreadAbs, c.expectedBook.spreadAbs, 'spreadAbs');
      expectNumOrNaN(actualBook.spreadPct, c.expectedBook.spreadPct, 'spreadPct');
      expectNumOrNaN(actualBook.mid, c.expectedBook.mid, 'mid');
      expectNumOrNaN(actualBook.obi5, c.expectedBook.obi5, 'obi5');

      const actualHeader = normalizeStockDetailHeaderQuotes({
        ...c.headerInput,
        book: c.expectedBook.bids.length === 0 && c.expectedBook.asks.length === 0 ? null : actualBook,
      });
      expect(actualHeader.bid, `${c.name}.hdr.bid`).toBe(c.expectedHeader.bid);
      expect(actualHeader.bidSize, `${c.name}.hdr.bidSize`).toBe(c.expectedHeader.bidSize);
      expect(actualHeader.ask, `${c.name}.hdr.ask`).toBe(c.expectedHeader.ask);
      expect(actualHeader.askSize, `${c.name}.hdr.askSize`).toBe(c.expectedHeader.askSize);
      expectNumOrNaN(actualHeader.spreadAbs, c.expectedHeader.spreadAbs, 'hdr.spreadAbs');
      expectNumOrNaN(actualHeader.spreadPct, c.expectedHeader.spreadPct, 'hdr.spreadPct');
    }

    expect(
      formatHeaderSideQuote(
        null,
        50,
        (n) => n.toFixed(2),
        (n) => String(n),
      ),
    ).toBe('—');
    expect(
      formatHeaderSideQuote(
        0,
        30,
        (n) => n.toFixed(2),
        (n) => String(n),
      ),
    ).toBe('—');
    expect(
      formatHeaderSideQuote(
        11435.5,
        50,
        (n) => n.toFixed(2),
        (n) => String(n),
      ),
    ).toBe('11435.50 (50 u.)');
  });

  it('resuelve fallback 1D para todos los timeframes intradiarios AR en backend y frontend', () => {
    for (const [tf, expected] of Object.entries(fixture.arIntradayFallback)) {
      expect(resolveArIntradayFallback(tf)).toEqual(expected);
      const ui = resolveArTimeframeFallback(tf as '1m' | '5m' | '15m' | '1h' | '4h' | '1D');
      expect(ui.effective).toBe(expected.effectiveTimeframe);
      expect(ui.fallback).toBe(expected.fallbackReason !== null);
    }
  });

  it('evalúa estado global sin degradar por STANDBY o TRADIER AUTH_INVALID cuando hay motores activos', () => {
    for (const c of fixture.connectivityCases) {
      expect(resolveGlobalConnectivityStatus(c.input), c.name).toEqual(c.expected);
    }
  });
});

describe('Pieza 43 — negociación REST 401 Tradier, circuit-breaker AUTH_INVALID y fallback FMP en GGAL Specialist', () => {
  it('negocia SANDBOX (401) -> LIVE (200) y LIVE (401) -> SANDBOX (200) en fetchTradierQuotes', async () => {
    const urlsSandboxFirst: string[] = [];
    let negotiatedEnv: string | null = null;
    const httpSandboxToLive: TradierHttpFn = (url) => {
      urlsSandboxFirst.push(url);
      if (url.startsWith(TRADIER_SANDBOX_REST_BASE)) {
        return Promise.resolve({ ok: false, status: 401, text: 'Unauthorized' });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: JSON.stringify({
          quotes: {
            quote: {
              symbol: 'GGAL',
              bid: 54.1,
              bidsize: 4,
              ask: 54.2,
              asksize: 6,
              last: 54.15,
              volume: 100_000,
              change_percentage: 1.5,
            },
          },
        }),
      });
    };

    const resProd = await fetchTradierQuotes(['GGAL'], {
      config: makeTradierCfg('sandbox'),
      httpFn: httpSandboxToLive,
      nowMsFn: () => 1_790_000_000_000,
      onEnvironmentNegotiated: (cfg) => {
        negotiatedEnv = cfg.apiEnv;
      },
    });
    expect(urlsSandboxFirst).toHaveLength(2);
    expect(urlsSandboxFirst[0]).toContain(TRADIER_SANDBOX_REST_BASE);
    expect(urlsSandboxFirst[1]).toContain(TRADIER_PROD_REST_BASE);
    expect(negotiatedEnv).toBe('prod');
    expect(resProd.quotes[0]?.bid).toBe(54.1);

    const urlsLiveFirst: string[] = [];
    const httpLiveToSandbox: TradierHttpFn = (url) => {
      urlsLiveFirst.push(url);
      if (url.startsWith(TRADIER_PROD_REST_BASE)) {
        return Promise.resolve({ ok: false, status: 401, text: 'Unauthorized' });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: JSON.stringify({
          quotes: {
            quote: { symbol: 'YPF', bid: 31.2, bidsize: 2, ask: 31.3, asksize: 3, last: 31.25 },
          },
        }),
      });
    };

    const resSandbox = await fetchTradierQuotes(['YPF'], {
      config: makeTradierCfg('prod'),
      httpFn: httpLiveToSandbox,
      nowMsFn: () => 1_790_000_000_000,
    });
    expect(urlsLiveFirst[0]).toContain(TRADIER_PROD_REST_BASE);
    expect(urlsLiveFirst[1]).toContain(TRADIER_SANDBOX_REST_BASE);
    expect(resSandbox.quotes[0]?.symbol).toBe('YPF');
  });

  it('abre TradierAuthCircuitBreaker tras doble 401 y evita spam REST/chains/historical durante cooldown', async () => {
    let httpCalls = 0;
    const always401Http: TradierHttpFn = () => {
      httpCalls += 1;
      return Promise.resolve({ ok: false, status: 401, text: 'Unauthorized' });
    };
    const breaker = new TradierAuthCircuitBreaker({ cooldownMs: 300_000 });
    const nowMs = 1_790_000_000_000;
    const cfg = makeTradierCfg('sandbox');

    await expect(
      fetchTradierQuotes(['GGAL'], {
        config: cfg,
        httpFn: always401Http,
        nowMsFn: () => nowMs,
        authBreaker: breaker,
      }),
    ).rejects.toBeInstanceOf(TradierAuthInvalidError);
    expect(httpCalls).toBe(2);
    expect(breaker.isOpen(nowMs)).toBe(true);

    // Llamadas subsecuentes dentro del cooldown fallan inmediato con 0 HTTP hits.
    await expect(
      fetchTradierQuotes(['GGAL'], {
        config: cfg,
        httpFn: always401Http,
        nowMsFn: () => nowMs + 10_000,
        authBreaker: breaker,
      }),
    ).rejects.toBeInstanceOf(TradierAuthInvalidError);
    await expect(
      fetchTradierOptionChain('GGAL', '2026-12-18', {
        config: cfg,
        httpFn: always401Http,
        nowMsFn: () => nowMs + 10_000,
        authBreaker: breaker,
      }),
    ).rejects.toBeInstanceOf(TradierAuthInvalidError);

    const hist = new TradierHistoricalClient({
      config: cfg,
      httpFn: always401Http,
      nowMsFn: () => nowMs + 10_000,
      authBreaker: breaker,
    });
    await expect(
      hist.fetchHistoricalBars({
        symbol: 'GGAL',
        timeframe: '5m',
        fromUtcSec: 1_789_900_000,
        toUtcSec: 1_790_000_000,
      }),
    ).rejects.toBeInstanceOf(TradierAuthInvalidError);
    expect(httpCalls).toBe(2);
  });

  it('GGAL Specialist cae a FMP_ENTERPRISE ante Tradier 401 sin emitir error rojo Tradier ADR NBBO', async () => {
    const nowMs = Date.UTC(2026, 10, 19, 17, 30, 0);
    const nowSec = Math.floor(nowMs / 1_000);
    const dailyBars = makeDailyBars(60, nowSec - 60 * 86_400);
    let tradierHttpCalls = 0;

    const mockFetch: FetchFn = (url) => {
      if (url.includes('financialmodelingprep.com')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {},
          text: JSON.stringify([
            {
              symbol: 'GGAL',
              name: 'Grupo Financiero Galicia',
              exchange: 'NASDAQ',
              price: 54.4,
              previousClose: 53.0,
              change: 1.4,
              changesPercentage: 2.6415,
              volume: 1_200_000,
              dayLow: 52.8,
              dayHigh: 54.9,
              timestamp: nowSec,
            },
          ]),
        });
      }
      if (url.includes('/live/arg_stocks')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {},
          text: JSON.stringify([
            { symbol: 'GGAL', px_bid: 6500, px_ask: 6520, c: 6510, prev_close: 6400, v: 500_000 },
          ]),
        });
      }
      if (url.includes('/live/arg_bonds')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {},
          text: JSON.stringify([
            { symbol: 'AL30', c: 76_000, px_bid: 75_900, px_ask: 76_100 },
            { symbol: 'AL30C', c: 63.0, px_bid: 62.9, px_ask: 63.1 },
            { symbol: 'AL30D', c: 63.5, px_bid: 63.4, px_ask: 63.6 },
          ]),
        });
      }
      if (url.includes('/historical/stocks/GGAL')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {},
          text: JSON.stringify(
            dailyBars.map((b) => ({
              date: new Date(b.time * 1_000).toISOString().slice(0, 10),
              o: b.open,
              h: b.high,
              l: b.low,
              c: b.close,
              v: b.volume,
            })),
          ),
        });
      }
      return Promise.resolve({ ok: true, status: 200, headers: {}, text: '[]' });
    };

    const runtime = new MarketRuntime({
      apiKey: 'massive-stub',
      enableWs: false,
      nowMsFn: () => nowMs,
      fetchFn: mockFetch,
      fmpConfig: {
        configured: true,
        apiKey: 'fmp-stub-secret',
        quotesApiKey: 'fmp-stub-secret',
        marketApiKey: null,
        etfApiKey: null,
        macroApiKey: null,
        baseUrl: FMP_STABLE_BASE_URL,
      },
      tradierConfig: makeTradierCfg('sandbox'),
      tradierHttpFn: () => {
        tradierHttpCalls += 1;
        return Promise.resolve({ ok: false, status: 401, text: 'Unauthorized' });
      },
      loadBarsFn: ((req: { readonly visibleBars?: number }) =>
        Promise.resolve({
          bars: dailyBars.slice(-(req.visibleBars ?? 60)),
          visibleStart: 0,
          report: { provider: 'massive', fetchedPages: 1, barsCount: 60, providerError: null },
        })) as unknown as NonNullable<NonNullable<ConstructorParameters<typeof MarketRuntime>[0]>['loadBarsFn']>,
    });

    const arRuntime = new ArgentinaMarketRuntime({
      fetchFn: mockFetch,
      minData912IntervalMs: 0,
      nowMsFn: () => nowMs,
      usRuntime: runtime,
    });

    const specialist = new GgalSpecialistRuntime({
      runtime,
      arRuntime,
      fetchFn: mockFetch,
      nowMsFn: () => nowMs,
      env: {},
    });

    const parity = await specialist.getParityGap(true);
    expect(tradierHttpCalls).toBe(2);
    expect(runtime.isTradierAuthInvalid()).toBe(true);
    expect(runtime.getTradierLiveStatus().state).toBe('AUTH_INVALID');
    expect(parity.result.spot.adrMidUsd).toBeCloseTo(54.4, 9);
    const fmpFallbackQuotes = await runtime.fetchFmpAdrQuotesSafe(['GGAL']);
    expect(fmpFallbackQuotes[0]?.price).toBeCloseTo(54.4, 9);
    expect(parity.telemetry.providerErrors.some((err) => /Tradier ADR NBBO/i.test(err))).toBe(false);
    expect(parity.telemetry.sourceDiagnostics?.some((d) => d.includes('FMP_ENTERPRISE'))).toBe(true);

    // Segunda llamada no vuelve a pegarle a Tradier HTTP mientras dure el breaker.
    await specialist.getParityGap(true);
    expect(tradierHttpCalls).toBe(2);
  });
});

describe('Pieza 43 — FeedsHealthMonitor AUTH_INVALID sin falsa degradación', () => {
  it('marca TRADIER_LIVE_WS como AUTH_INVALID manteniendo degradedCount=0 y claves de pulso intactas', () => {
    const nowMs = Date.UTC(2026, 10, 19, 17, 30, 0);
    const fmpTelemetry = {
      ...emptyFeedTelemetrySnapshot(),
      lastTickAtMs: nowMs - 1_500,
      lastHttpSuccessAtMs: nowMs - 1_500,
      messagesPerMinute: 170,
    };

    const deps: FeedsHealthMonitorDeps = {
      nowMsFn: () => nowMs,
      getMassiveWs: () => ({
        configured: true,
        connected: false,
        stocksMode: 'STANDBY_TRADIER_FMP_PRIMARY',
        keySlot: null,
        lastError: null,
        telemetry: emptyFeedTelemetrySnapshot(),
        subscribedSymbols: [],
        activeSymbolCount: 0,
        subscribedOptionQuotes: 0,
        lastWsMessageAgeMs: null,
      }),
      getMassiveRest: () => ({
        configured: true,
        poolSize: 1,
        slots: [{ envName: 'MASSIVE_API_KEY', slotIndex: 0 }],
        lastSlotIndex: 0,
        roundRobinRequests: 4,
        telemetry: {
          ...emptyFeedTelemetrySnapshot(),
          lastTickAtMs: nowMs - 2_000,
          lastHttpSuccessAtMs: nowMs - 2_000,
          messagesPerMinute: 12,
        },
      }),
      getTradier: () => ({
        configured: true,
        connected: false,
        authInvalid: true,
        sessionCreated: false,
        reconnectAttempts: 0,
        subscribedSymbols: ['GGAL', 'SPY'],
        lastError: 'Tradier quotes HTTP 401 (both Sandbox and Live rejected)',
        telemetry: emptyFeedTelemetrySnapshot(),
        apiEnv: 'prod',
        environment: 'LIVE',
        restBaseUrl: TRADIER_PROD_REST_BASE,
        wsBaseUrl: TRADIER_WS_BASE,
      }),
      getFmp: () => ({
        configured: true,
        lastSuccessAtMs: nowMs - 1_500,
        lastError: null,
        requestCount: 40,
        quoteCount: 172,
        subscribedSymbols: ['SPY', 'QQQ', 'GGAL'],
        batchMode: 'stable-single-pool',
        telemetry: fmpTelemetry,
      }),
      getOrats: () => ({
        configured: false,
        connected: false,
        lastFetchAtUtcSec: null,
        lastStatus: null,
        planTier: null,
        quotaRemaining: null,
        quotaLimit: null,
        quotaResetAtUtcSec: null,
        circuitBreaker: { state: 'CLOSED', consecutiveFailures: 0, openedAtMs: null },
        telemetry: emptyFeedTelemetrySnapshot(),
      }),
      getPrimary: () => ({
        configured: false,
        authenticated: false,
        wsConnected: false,
        tokenValidUntilUtcSec: null,
        tokenRenewCount: 0,
        wsEnvironment: 'PRIMARY_ECO_XOMS_WS',
        dlrSubscribedCount: 0,
        liveDlrCount: 0,
        liveDlrLastUpdateUtcSec: null,
        lastError: null,
        telemetry: emptyFeedTelemetrySnapshot(),
      }),
      getBmb: () => ({
        configured: false,
        healthStatus: 'DISABLED_NO_PASSWORD',
        connected: false,
        signalRMode: false,
        lastUpdateUtcSec: null,
        orderBookCount: 0,
        caucionCount: 0,
        optionCount: 0,
        lastError: null,
        telemetry: emptyFeedTelemetrySnapshot(),
      }),
      getIol: () => ({
        configured: false,
        connected: false,
        authMethod: null,
        passwordAuthCount: 0,
        refreshAuthCount: 0,
        tokenExpiresAtUtcSec: null,
        lastAuthAtUtcSec: null,
        quoteCount: 0,
        lastError: null,
        telemetry: emptyFeedTelemetrySnapshot(),
      }),
      reconnectMassiveWs: () => Promise.resolve('OK'),
      resyncMassiveRest: () => Promise.resolve('OK'),
      reconnectTradier: () => Promise.resolve('OK'),
      resyncOrats: () => Promise.resolve('OK'),
      reconnectPrimary: () => Promise.resolve('OK'),
      reconnectBmb: () => Promise.resolve('OK'),
      reconnectIol: () => Promise.resolve('OK'),
    };

    const monitor = new FeedsHealthMonitor(deps);
    const snap = monitor.getSnapshot();
    const tradier = snap.providers.find((p) => p.id === 'TRADIER_LIVE_WS');
    const fmp = snap.providers.find((p) => p.id === 'FMP_ENTERPRISE_REST');
    expect(tradier?.state).toBe('AUTH_INVALID');
    expect(tradier?.connected).toBe(false);
    expect(tradier?.tradier?.authInvalid).toBe(true);
    expect(fmp?.state).toBe('CONNECTED');
    expect(snap.summary.degradedCount).toBe(0);
    expect(snap.summary.authInvalidCount).toBe(1);
    expect(snap.summary.standbyCount).toBe(1);

    const pulse = monitor.getPulse();
    for (const p of pulse.providers) {
      expect(Object.keys(p).sort()).toEqual([
        'id',
        'lastTickAgeMs',
        'latencyMs',
        'messagesPerMinute',
        'sessionMode',
        'state',
      ]);
    }
  });
});

describe('Pieza 43 — AR 4h/1h -> 1D fallback y normalización L1/L2 en ArgentinaMarketRuntime', () => {
  it('sirve BMA 4h y 1h haciendo fallback a 1D y limpia BID/ASK con precio 0 + puntas L2 inválidas', async () => {
    const nowMs = Date.UTC(2026, 10, 19, 17, 30, 0);
    const nowSec = Math.floor(nowMs / 1_000);
    const bmaDailyBars = makeDailyBars(120, nowSec - 120 * 86_400);

    const mockFetch: FetchFn = (url) => {
      if (url.includes('/historical/stocks/BMA')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {},
          text: JSON.stringify(
            bmaDailyBars.map((b) => ({
              date: new Date(b.time * 1_000).toISOString().slice(0, 10),
              o: b.open,
              h: b.high,
              l: b.low,
              c: b.close,
              v: b.volume,
            })),
          ),
        });
      }
      if (url.includes('/live/arg_stocks')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {},
          text: JSON.stringify([
            {
              symbol: 'BMA',
              c: 8_120,
              prev_close: 8_050,
              px_bid: 0,
              q_bid: 50,
              px_ask: 0,
              q_ask: 30,
              v: 20_000,
            },
          ]),
        });
      }
      return Promise.resolve({ ok: true, status: 200, headers: {}, text: '[]' });
    };

    const fakeBmbClient = {
      getSafeHealthStatus: () => ({
        configured: true,
        status: 'CONNECTED_L2' as const,
        brokerId: 152,
        accountLabel: null,
        pyhomebrokerInstalled: true,
        passwordConfigured: true,
        connected: true,
        lastUpdateUtcSec: nowSec - 2,
        counts: { cauciones: 0, orderBooks: 1, options: 0 },
        error: null,
      }),
      getSnapshot: (): Promise<BmbBridgeSnapshotDto> =>
        Promise.resolve({
          health: {
            configured: true,
            status: 'CONNECTED_L2',
            brokerId: 152,
            accountLabel: null,
            pyhomebrokerInstalled: true,
            passwordConfigured: true,
            connected: true,
            lastUpdateUtcSec: nowSec - 2,
            counts: { cauciones: 0, orderBooks: 1, options: 0 },
            error: null,
          },
          cauciones: [],
          orderBooksBySymbol: {
            BMA: {
              symbol: 'BMA',
              settlement: '24hs',
              asOfUtcSec: nowSec - 2,
              source: 'BMB_HOMEBROKER',
              bids: [
                { price: 0, size: 50 },
                { price: 8_100, size: 500 },
              ],
              asks: [
                { price: 0, size: 30 },
                { price: 8_140, size: 300 },
              ],
            },
          },
          options: [],
        }),
    } as unknown as BmbBridgeClient;

    const arNoL2 = new ArgentinaMarketRuntime({
      fetchFn: mockFetch,
      minData912IntervalMs: 0,
      nowMsFn: () => nowMs,
    });

    const res4h = await arNoL2.getArTerminalBars('BMA', '4h');
    const res1h = await arNoL2.getArTerminalBars('BMA', '1h');
    expect(res4h.effectiveTimeframe).toBe('1D');
    expect(res4h.fallbackReason).toBe('NO_4H_BARS_AR');
    expect(res4h.bars.length).toBeGreaterThan(0);
    expect(res1h.effectiveTimeframe).toBe('1D');
    expect(res1h.fallbackReason).toBe('NO_1H_BARS_AR');
    expect(res1h.bars.length).toBeGreaterThan(0);

    // Con BID=0/ASK=0 en Data912 y sin L2, jamás filtra precios 0 ni tamaños huérfanos.
    const detailNoL2 = await arNoL2.getStockDetail('BMA');
    expect(detailNoL2.stock?.bid).toBeNull();
    expect(detailNoL2.stock?.ask).toBeNull();
    expect(detailNoL2.orderBook5Levels?.bids).toEqual([]);
    expect(detailNoL2.orderBook5Levels?.asks).toEqual([]);
    expect(detailNoL2.orderBook5Levels?.spreadPct).toBeNull();

    // Con libro BMB L2 mixto (nodos inválidos con price=0 + puntas válidas), limpia price<=0 y rellena stock.bid/ask + Spread.
    const arWithL2 = new ArgentinaMarketRuntime({
      fetchFn: mockFetch,
      minData912IntervalMs: 0,
      nowMsFn: () => nowMs,
      bmbClient: fakeBmbClient,
    });
    const detailWithL2 = await arWithL2.getStockDetail('BMA');
    expect(detailWithL2.orderBook5Levels?.bids).toEqual([{ price: 8_100, size: 500 }]);
    expect(detailWithL2.orderBook5Levels?.asks).toEqual([{ price: 8_140, size: 300 }]);
    expect(detailWithL2.orderBook5Levels?.bestBid).toBe(8_100);
    expect(detailWithL2.orderBook5Levels?.bestAsk).toBe(8_140);
    expect(detailWithL2.orderBook5Levels?.spreadArs).toBeCloseTo(40, 9);
    expect(detailWithL2.orderBook5Levels?.spreadPct).toBeCloseTo((40 / 8_140) * 100, 9);
    expect(detailWithL2.stock?.bid).toBe(8_100);
    expect(detailWithL2.stock?.ask).toBe(8_140);
  });
});
