/**
 * Pieza 42 — Soporte completo de Pre-Market y After-Hours (04:00–20:00 ET) en FMP Enterprise + Tradier WS.
 *
 * Suite 100% offline: secretos sintéticos, fetch/WS simulados y referencia
 * independiente en tools/gen_extended_hours_fixture.py.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getUsEquitySessionPhase,
  type UsEquitySessionPhase,
} from '../src/core/sessions.js';
import type { WsSocketLike } from '../src/data/wsTypes.js';
import {
  FmpEnterpriseClient,
  buildFmpHistoricalPath,
  loadFmpConfigFromEnv,
  mergeFmpExtendedTradesAndQuotes,
  parseFmpAftermarketQuotes,
  parseFmpAftermarketTrades,
  parseFmpHistoricalBars,
} from '../src/server/fmpClient.js';
import {
  MarketRuntime,
  mergeUsRegularAndExtendedQuote,
} from '../src/server/marketRuntime.js';
import {
  TRADIER_WS_STREAM_FILTERS,
  TradierLiveManager,
  resolveTradierConfig,
} from '../src/server/tradierAdapter.js';
import { TradierHistoricalClient } from '../src/server/tradierStream.js';
import type { MarketTickQuote } from '../src/server/massiveStocksStream.js';

interface ExtendedHoursReferenceFixture {
  readonly version: number;
  readonly sessionCases: readonly {
    readonly name: string;
    readonly utcSec: number;
    readonly expected: UsEquitySessionPhase;
  }[];
  readonly aftermarketBatch: {
    readonly trades: unknown;
    readonly quotes: unknown;
    readonly expected: readonly {
      readonly symbol: string;
      readonly price: number;
      readonly tradeSize: number | null;
      readonly bid: number | null;
      readonly bidSize: number | null;
      readonly ask: number | null;
      readonly askSize: number | null;
      readonly asOfUtcSec: number | null;
    }[];
  };
  readonly mergeCases: readonly {
    readonly name: string;
    readonly sessionPhase: UsEquitySessionPhase;
    readonly regularPrice: number;
    readonly previousClose: number;
    readonly regularChangePct: number;
    readonly extendedPrice: number;
    readonly expectedPrice: number;
    readonly expectedRegularClose: number;
    readonly expectedChangePct: number;
    readonly expectedExtendedChangePct: number;
  }[];
  readonly intradayBars: {
    readonly rows: unknown;
    readonly expectedExtendedTimes: readonly number[];
    readonly expectedRthOnlyTimes: readonly number[];
  };
}

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'fixtures', 'extended_hours_reference.json'), 'utf-8'),
) as ExtendedHoursReferenceFixture;

describe('Pieza 42 — Sesiones US, FMP Extended Batch y Barras Intradía', () => {
  it('clasifica PRE_MARKET, RTH, AFTER_HOURS y CLOSED con DST igual a Python', () => {
    for (const tc of fixture.sessionCases) {
      expect(getUsEquitySessionPhase(tc.utcSec), tc.name).toBe(tc.expected);
    }
  });

  it('parsea y fusiona /stable/batch-aftermarket-trade + /stable/batch-aftermarket-quote sin perder precisión ni unidades UTC', () => {
    const trades = parseFmpAftermarketTrades(fixture.aftermarketBatch.trades);
    const quotes = parseFmpAftermarketQuotes(fixture.aftermarketBatch.quotes);
    const merged = mergeFmpExtendedTradesAndQuotes(
      trades.bySymbol,
      quotes.bySymbol,
      'FMP_STABLE_AFTERMARKET_BATCH',
    );
    expect(trades.discarded).toBe(1);
    expect(merged).toHaveLength(fixture.aftermarketBatch.expected.length);
    for (const exp of fixture.aftermarketBatch.expected) {
      const actual = merged.find((item) => item.symbol === exp.symbol);
      expect(actual).toBeDefined();
      expect(actual?.price).toBeCloseTo(exp.price, 9);
      expect(actual?.tradeSize).toBe(exp.tradeSize);
      expect(actual?.bid).toBe(exp.bid);
      expect(actual?.bidSize).toBe(exp.bidSize);
      expect(actual?.ask).toBe(exp.ask);
      expect(actual?.askSize).toBe(exp.askSize);
      expect(actual?.asOfUtcSec).toBe(exp.asOfUtcSec);
    }
  });

  it('cascadea ante 402/403 desde /stable hacia /api/v4 y luego pool acotado /stable/aftermarket-trade, usando fallback de keys y redactando secretos', async () => {
    const requestedUrls: string[] = [];
    const edtAfterHoursSec = fixture.sessionCases[9]?.utcSec ?? 0;
    const clientV4 = new FmpEnterpriseClient({
      config: loadFmpConfigFromEnv({ FMP_KEY_MARKET: 'secret-market-key' }),
      nowMsFn: () => edtAfterHoursSec * 1_000,
      secrets: ['secret-market-key'],
      fetchFn: async (url) => {
        requestedUrls.push(url);
        await Promise.resolve();
        if (url.includes('/stable/batch-aftermarket-trade')) {
          return { ok: false, status: 402, text: '' };
        }
        if (url.includes('/stable/batch-aftermarket-quote')) {
          return { ok: false, status: 402, text: '' };
        }
        if (url.includes('/api/v4/batch-pre-post-market-trade/')) {
          return {
            ok: true,
            status: 200,
            text: JSON.stringify([
              { symbol: 'AAPL', price: 350.5, size: 120, timestamp: 1_795_125_000_000 },
            ]),
          };
        }
        return { ok: false, status: 500, text: '' };
      },
    });

    const v4Result = await clientV4.fetchExtendedBatchQuotes(['AAPL', 'SPY']);
    expect(v4Result.keyEnvName).toBe('MARKET');
    expect(v4Result.source).toBe('FMP_V4_PRE_POST_BATCH');
    expect(v4Result.quotes[0]?.price).toBeCloseTo(350.5, 9);
    expect(requestedUrls.some((u) => u.includes('/api/v4/batch-pre-post-market-trade/AAPL%2CSPY'))).toBe(true);
    expect(requestedUrls.every((u) => u.includes('apikey=secret-market-key'))).toBe(true);

    // Fallback a pool acotado single-symbol ante 403 en stable y v4
    const singleUrls: string[] = [];
    const clientPool = new FmpEnterpriseClient({
      config: loadFmpConfigFromEnv({ FMP_KEY_QUOTES: 'secret-quotes-canary' }),
      nowMsFn: () => edtAfterHoursSec * 1_000,
      secrets: ['secret-quotes-canary'],
      fetchFn: async (url) => {
        singleUrls.push(url);
        await Promise.resolve();
        if (url.includes('/stable/batch-aftermarket-') || url.includes('/api/v4/batch-pre-post-market-trade/')) {
          return { ok: false, status: 403, text: '' };
        }
        if (url.includes('/stable/aftermarket-trade?symbol=SPY')) {
          return {
            ok: true,
            status: 200,
            text: JSON.stringify([{ symbol: 'SPY', price: 599.25, tradeSize: 50, timestamp: 1_795_125_010 }]),
          };
        }
        return { ok: false, status: 404, text: '' };
      },
    });
    const poolResult = await clientPool.fetchExtendedBatchQuotes(['SPY', 'QQQ'], { maxSinglePoolSymbols: 2 });
    expect(poolResult.source).toBe('FMP_STABLE_AFTERMARKET_SINGLE_POOL');
    expect(poolResult.quotes).toHaveLength(1);
    expect(poolResult.quotes[0]?.symbol).toBe('SPY');

    // Redacción estricta en errores de red/HTTP
    const errClient = new FmpEnterpriseClient({
      config: loadFmpConfigFromEnv({ FMP_API_KEY: 'super-secret-fmp-token' }),
      secrets: ['super-secret-fmp-token'],
      fetchFn: async (url) => {
        await Promise.resolve();
        throw new Error(`connect ECONNREFUSED ${url}`);
      },
    });
    await expect(errClient.fetchExtendedBatchQuotes(['AAPL'])).rejects.toSatisfy(
      (err: Error) =>
        !err.message.includes('super-secret-fmp-token') &&
        (err.message.includes('[REDACTED]') || err.message.includes('<redacted>')),
    );
  });

  it('preserva barras Pre-Market y After-Hours en FMP (extended=true) y Tradier REST (session_filter=all) y filtra con rthOnly', async () => {
    expect(buildFmpHistoricalPath({ symbol: 'GGAL', timeframe: '5m', includeExtended: true })).toContain('extended=true');
    const extendedParsed = parseFmpHistoricalBars(fixture.intradayBars.rows, { rthOnly: false });
    expect(extendedParsed.bars.map((b) => b.time)).toEqual(fixture.intradayBars.expectedExtendedTimes);

    const rthParsed = parseFmpHistoricalBars(fixture.intradayBars.rows, { rthOnly: true });
    expect(rthParsed.bars.map((b) => b.time)).toEqual(fixture.intradayBars.expectedRthOnlyTimes);

    const tradierUrls: string[] = [];
    const tradierHist = new TradierHistoricalClient({
      config: resolveTradierConfig({ TRADIER_TOKEN: 'secret-tradier-token' }, 'tests/.env-not-present'),
      secrets: ['secret-tradier-token'],
      httpFn: async (url) => {
        tradierUrls.push(url);
        await Promise.resolve();
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            series: {
              data: [
                { time: '2026-07-15T08:15:00-04:00', open: 61, high: 61.5, low: 60.8, close: 61.4, volume: 1200 },
                { time: '2026-07-15T10:00:00-04:00', open: 61.5, high: 62, low: 61.4, close: 61.8, volume: 5000 },
                { time: '2026-07-15T17:45:00-04:00', open: 61.8, high: 62.2, low: 61.7, close: 62.1, volume: 900 },
              ],
            },
          }),
        };
      },
    });
    const histAll = await tradierHist.fetchHistoricalBars({
      symbol: 'GGAL',
      timeframe: '5m',
      fromUtcSec: fixture.intradayBars.expectedExtendedTimes[0] ?? 0,
      toUtcSec: fixture.intradayBars.expectedExtendedTimes[2] ?? 0,
      includeExtended: true,
    });
    expect(tradierUrls[0]).toContain('session_filter=all');
    expect(histAll.bars.map((b) => b.time)).toEqual(fixture.intradayBars.expectedExtendedTimes);
  });
});

describe('Pieza 42 — Fusión Anti-Sobrescritura RTH+Extended & Flujo Tradier WS timesale', () => {
  it('mantiene regularClose y nunca sobrescribe el precio extendido con el batch RTH en PRE_MARKET ni AFTER_HOURS', async () => {
    for (const mc of fixture.mergeCases) {
      const regular: MarketTickQuote = {
        market: 'US',
        symbol: 'AAPL',
        kind: 'stock',
        currency: 'USD',
        price: mc.regularPrice,
        previousClose: mc.previousClose,
        changePct: mc.regularChangePct,
        dayLow: 345,
        dayHigh: 355,
        volume: 1_000_000,
        turnover: 350_000_000,
        asOfUtcSec: 1_795_122_000,
        source: 'FMP_ENTERPRISE_REST',
        exchange: 'NASDAQ',
      };
      const extended: MarketTickQuote = {
        market: 'US',
        symbol: 'AAPL',
        kind: 'stock',
        currency: 'USD',
        price: mc.extendedPrice,
        previousClose: null,
        changePct: null,
        dayLow: null,
        dayHigh: null,
        volume: null,
        turnover: null,
        asOfUtcSec: 1_795_125_600,
        source: 'FMP_ENTERPRISE_REST',
      };
      const merged = mergeUsRegularAndExtendedQuote({
        regular,
        extended,
        sessionPhase: mc.sessionPhase,
      });
      expect(merged?.price).toBeCloseTo(mc.expectedPrice, 9);
      expect(merged?.regularClose).toBeCloseTo(mc.expectedRegularClose, 9);
      expect(merged?.extendedPrice).toBeCloseTo(mc.expectedPrice, 9);
      expect(merged?.changePct).toBeCloseTo(mc.expectedChangePct, 9);
      expect(merged?.extendedChangePct).toBeCloseTo(mc.expectedExtendedChangePct, 9);
      expect(merged?.sessionPhase).toBe(mc.sessionPhase);
    }

    // Integración en MarketRuntime: batch RTH llega DESPUÉS del extendido y NO sobrescribe AAPL
    const ahSec = fixture.sessionCases[9]?.utcSec ?? 0; // 2026-07-15 18:30 EDT -> AFTER_HOURS
    let regularPollCount = 0;
    const runtime = new MarketRuntime({
      apiKey: 'offline-harness-key',
      enableWs: false,
      nowMsFn: () => ahSec * 1_000,
      fmpConfig: loadFmpConfigFromEnv({ FMP_API_KEY: 'fmp-ext-secret' }),
      fetchFn: async (url) => {
        await Promise.resolve();
        if (url.includes('/stable/batch-aftermarket-trade')) {
          return {
            ok: true,
            status: 200,
            text: JSON.stringify([{ symbol: 'AAPL', price: 355.4, tradeSize: 250, timestamp: ahSec + 30 }]),
          };
        }
        if (url.includes('/stable/batch-aftermarket-quote')) {
          return {
            ok: true,
            status: 200,
            text: JSON.stringify([{ symbol: 'AAPL', bidPrice: 355.3, bidSize: 100, askPrice: 355.5, askSize: 200, timestamp: ahSec + 30 }]),
          };
        }
        if (url.includes('/stable/batch-quote')) {
          regularPollCount += 1;
          return {
            ok: true,
            status: 200,
            text: JSON.stringify([
              {
                symbol: 'AAPL',
                price: 349.21,
                previousClose: 352.45,
                changePercentage: -0.91928,
                volume: 40_000_000,
                dayLow: 346.47,
                dayHigh: 355.28,
                exchange: 'NASDAQ',
                timestamp: ahSec + 120, // incluso timestamp mayor en respuesta batch RTH
              },
            ]),
          };
        }
        return { ok: false, status: 404, text: '' };
      },
    });
    try {
      await runtime.pollFmpExtendedBatchOnce();
      await runtime.resyncFmpEnterpriseBatch();
      expect(regularPollCount).toBeGreaterThanOrEqual(1);
      const aaplQuote = runtime.getLiveUsQuotes().find((q) => q.symbol === 'AAPL');
      expect(aaplQuote?.price).toBeCloseTo(355.4, 9);
      expect(aaplQuote?.extendedPrice).toBeCloseTo(355.4, 9);
      expect(aaplQuote?.regularClose).toBeCloseTo(349.21, 9);
      expect(aaplQuote?.previousClose).toBeCloseTo(352.45, 9);
      expect(aaplQuote?.sessionPhase).toBe('AFTER_HOURS');
      expect(aaplQuote?.extendedChangePct).toBeCloseTo(((355.4 - 349.21) / 349.21) * 100, 9);
    } finally {
      runtime.stopWs();
    }
  });

  it('suscribe Tradier WS con filter trade/quote/timesale/summary y propaga timesale After-Hours a liveStates1m, GgalTickStreamEngine y broadcast', async () => {
    const ahSec = fixture.sessionCases[9]?.utcSec ?? 0; // AFTER_HOURS EDT
    const sentPayloads: string[] = [];
    let socket: WsSocketLike | null = null;
    const broadcasts: { readonly type: string; readonly symbol?: string }[] = [];

    const runtime = new MarketRuntime({
      apiKey: 'offline-harness-key',
      enableWs: true,
      nowMsFn: () => ahSec * 1_000,
      massiveStocksMode: 'STANDBY_TRADIER_FMP_PRIMARY',
      tradierConfig: resolveTradierConfig({ TRADIER_LIVE_TOKEN: 'tradier-ext-secret' }, 'tests/.env-not-present'),
      tradierHttpFn: async () => {
        await Promise.resolve();
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({ stream: { sessionid: 'ext-ws-session', url: 'wss://ws.tradier.com/v1/markets/events' } }),
        };
      },
      tradierCreateSocketFn: () => {
        socket = {
          send: (data) => {
            sentPayloads.push(data);
          },
          close: () => undefined,
          onOpen: null,
          onMessage: null,
          onClose: null,
          onError: null,
        };
        return socket;
      },
    });
    runtime.addWsListener((ev) => {
      broadcasts.push({
        type: ev.type,
        ...('symbol' in ev ? { symbol: ev.symbol } : {}),
      });
    });

    try {
      await runtime.startWs();
      await new Promise<void>((r) => setTimeout(r, 15));
      expect(socket).not.toBeNull();
      const wsSocket = socket as WsSocketLike | null;
      if (wsSocket === null) throw new Error('expected socket');
      wsSocket.onOpen?.();

      expect(sentPayloads).toHaveLength(1);
      const rawSubPayload = sentPayloads[0];
      if (rawSubPayload === undefined) throw new Error('expected subscribe payload');
      const subPayload = JSON.parse(rawSubPayload) as { readonly filter: readonly string[] };
      expect(subPayload.filter).toEqual([...TRADIER_WS_STREAM_FILTERS]);
      expect(subPayload.filter).toEqual(['trade', 'quote', 'timesale', 'summary']);

      // Frame timesale en After-Hours con timestamp epoch en milisegundos
      wsSocket.onMessage?.(
        JSON.stringify({
          type: 'timesale',
          symbol: 'GGAL',
          exchange: 'Q',
          bid: 62.3,
          ask: 62.45,
          last: 62.4,
          size: 350,
          date: ahSec * 1_000,
          seq: 1,
          flag: '',
          cancel: false,
          correction: false,
          session: 'after',
        }),
      );

      const ggalQuote = runtime.getLiveUsQuotes().find((q) => q.symbol === 'GGAL');
      expect(ggalQuote?.price).toBeCloseTo(62.4, 9);
      expect(ggalQuote?.extendedPrice).toBeCloseTo(62.4, 9);
      expect(ggalQuote?.sessionPhase).toBe('AFTER_HOURS');
      expect(ggalQuote?.source).toBe('TRADIER_WS');

      expect(broadcasts.some((b) => b.type === 'trade' && b.symbol === 'GGAL')).toBe(true);
      expect(broadcasts.some((b) => b.type === 'bar_update' && b.symbol === 'GGAL')).toBe(true);
      expect(broadcasts.some((b) => b.type === 'ggal_bar_tick')).toBe(true);
    } finally {
      runtime.stopWs();
    }

    // Redacción estricta en errores de Tradier
    const errManager = new TradierLiveManager({
      config: resolveTradierConfig({ TRADIER_LIVE_TOKEN: 'tradier-secret-leak-check' }, 'tests/.env-not-present'),
      secrets: ['tradier-secret-leak-check'],
      httpFn: async () => {
        await Promise.resolve();
        throw new Error('auth failed for tradier-secret-leak-check');
      },
      reconnectBaseDelayMs: 60_000,
      reconnectMaxDelayMs: 60_000,
    });
    await errManager.start(['SPY']);
    expect(errManager.getStatus().lastError).toContain('<redacted>');
    expect(errManager.getStatus().lastError).not.toContain('tradier-secret-leak-check');
    errManager.stop();
  });
});
