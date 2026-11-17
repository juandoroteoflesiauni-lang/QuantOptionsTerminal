/**
 * Pieza 41 — FMP Enterprise, Tradier US/ADR, Eco Primary BYMA y Stock Detail.
 *
 * Suite 100% offline: secretos sintéticos, proveedores HTTP/WS simulados y
 * referencia independiente en tools/gen_fmp_enterprise_and_argy_stream_fixture.py.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  FmpEnterpriseClient,
  loadFmpConfigFromEnv,
  parseFmpBatchQuotes,
  parseFmpEtDateTimeToUtcSec,
  parseFmpHistoricalBars,
} from '../src/server/fmpClient.js';
import {
  aggregateTradierBars,
  parseTradierDailyHistory,
  parseTradierTimesales,
  TRADIER_CORE_US_SYMBOLS,
} from '../src/server/tradierStream.js';
import { resolveMassiveStocksMode } from '../src/server/massiveStocksStream.js';
import {
  BYMA_L2_FIXED_INCOME_TICKERS,
  parseMervInstrumentSymbol,
  selectBymaL2Products,
} from '../src/server/primaryRofexLoader.js';
import {
  ArRealtimeBus,
  realtimeQuoteKey,
} from '../src/server/arRealtimeBus.js';
import { primaryFrameToMarketTickQuote } from '../src/server/argentinaMarketLoader.js';
import { mergePrimaryMarketData } from '../src/server/primaryRofexLoader.js';
import { FeedsHealthMonitor } from '../src/server/feedsHealthMonitor.js';
import { redactSecrets } from '../src/server/runtimeCache.js';
import { MarketRuntime, ELECTORAL_GAP_START_UTC_SEC } from '../src/server/marketRuntime.js';
import {
  localSymbolForAdr,
  parseStockDetailKey,
  resolveArTimeframeFallback,
  resolveStockDetailRoute,
} from '../web/src/components/stock-detail/stockDetailRouting.js';

interface ReferenceFixture {
  readonly version: number;
  readonly electoralGapStartUtcSec: number;
  readonly fmpHistorical: {
    readonly rows: unknown;
    readonly expectedBars: readonly {
      readonly time: number;
      readonly open: number;
      readonly high: number;
      readonly low: number;
      readonly close: number;
      readonly volume: number;
      readonly vw?: number;
    }[];
    readonly expectedDiscarded: number;
  };
  readonly fmpBatch: {
    readonly rows: unknown;
    readonly expectedQuotes: readonly {
      readonly symbol: string;
      readonly exchange: string;
      readonly price: number;
      readonly changePct: number;
      readonly previousClose: number;
      readonly volume: number;
      readonly asOfUtcSec: number;
    }[];
    readonly expectedDiscarded: number;
  };
  readonly routing: {
    readonly cases: readonly {
      readonly key: string;
      readonly providerSymbol: string;
      readonly market: 'AR' | 'US';
      readonly mode: 'BYMA_ARS' | 'ADR_USD';
      readonly isAdr: boolean;
      readonly exchange: string;
      readonly badge: string;
      readonly currencySymbol: 'ARS' | 'USD';
    }[];
  };
  readonly massiveStocksMode: {
    readonly cases: readonly { readonly env: Readonly<Record<string, string>>; readonly expected: string }[];
  };
  readonly primarySelection: {
    readonly instruments: readonly { readonly marketId: string; readonly symbol: string }[];
    readonly expectedSymbols: readonly string[];
  };
  readonly primaryMdMerge: {
    readonly base: Record<string, unknown>;
    readonly bookOnlyFrame: Record<string, unknown>;
    readonly bookOnlyPresent: readonly string[];
    readonly expected: Record<string, unknown>;
    readonly futureFrameReceivedSec: number;
    readonly futureFrameTimeSec: number;
    readonly expectedFutureRejected: boolean;
  };
  readonly primaryQuotes: {
    readonly frames: readonly {
      readonly ticker: string;
      readonly settlement: string;
      readonly price?: number;
      readonly close?: number;
      readonly low?: number;
      readonly high?: number;
      readonly volume?: number;
      readonly turnover?: number | null;
      readonly rate?: number;
      readonly bid?: number;
      readonly ask?: number;
      readonly timeSec: number;
    }[];
    readonly expectedQuoteKeys: readonly string[];
    readonly expectedCaucion: {
      readonly termDays: number;
      readonly currency: 'ARS';
      readonly tnaWeighted: number;
      readonly bidTna: number;
      readonly askTna: number;
      readonly turnoverArs: number;
      readonly source: 'PRIMARY_ECO_WS';
    };
  };
  readonly redaction: {
    readonly secrets: readonly string[];
    readonly cases: readonly { readonly input: string; readonly expected: string }[];
  };
  readonly health: {
    readonly defaultProviderIds: readonly string[];
    readonly standby: {
      readonly id: string;
      readonly state: string;
      readonly connected: null;
      readonly reconnectable: boolean;
    };
  };
}

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'fixtures', 'fmp_enterprise_and_argy_stream_reference.json'), 'utf-8'),
) as ReferenceFixture;

const EMPTY_TELEMETRY = {
  startedAtMs: null,
  totalMessages: 0,
  messagesPerMinute: null,
  averageLatencyMs: null,
  latencySamples: 0,
  lastMessageAtMs: null,
  lastTickAtMs: null,
  lastHttpSuccessAtMs: null,
  lastHttpFailureAtMs: null,
  lastHttp429AtMs: null,
  http429PerMinute: null,
};

describe('Pieza 41 — FMP Enterprise intradiario/EOD y batch-quote', () => {
  it('normaliza fecha civil ET a apertura UTC con DST y deduplica/ordena velas', () => {
    const parsed = parseFmpHistoricalBars(fixture.fmpHistorical.rows);
    expect(parsed.discarded).toBe(fixture.fmpHistorical.expectedDiscarded);
    expect(parsed.bars).toHaveLength(fixture.fmpHistorical.expectedBars.length);
    for (let i = 0; i < parsed.bars.length; i += 1) {
      const actual = parsed.bars[i];
      const expected = fixture.fmpHistorical.expectedBars[i];
      expect(actual?.time).toBe(expected?.time);
      expect(actual?.open).toBeCloseTo(expected?.open ?? Number.NaN, 12);
      expect(actual?.high).toBeCloseTo(expected?.high ?? Number.NaN, 12);
      expect(actual?.low).toBeCloseTo(expected?.low ?? Number.NaN, 12);
      expect(actual?.close).toBeCloseTo(expected?.close ?? Number.NaN, 12);
      expect(actual?.volume).toBeCloseTo(expected?.volume ?? Number.NaN, 12);
    }
  });

  it('descarta VW invalida y conserva VW solo si FMP la entrega', () => {
    expect(parseFmpEtDateTimeToUtcSec('2026-01-30 13:20:00')).toBe(parseFmpHistoricalBars([
      { date: '2026-01-30 13:20:00', open: 20, high: 20.1, low: 19.8, close: 20, volume: 5 },
    ]).bars[0]?.time);    expect(Number.isNaN(parseFmpEtDateTimeToUtcSec('2026-13-01 13:20:00'))).toBe(true);
    expect(Number.isNaN(parseFmpEtDateTimeToUtcSec('2026-01-30 24:00:00'))).toBe(true);
  });

  it('parsea batch-quote completo sin fabricar bid/ask ni turnover', () => {
    const parsed = parseFmpBatchQuotes(fixture.fmpBatch.rows);
    expect(parsed.discarded).toBe(fixture.fmpBatch.expectedDiscarded);
    expect(parsed.quotes).toHaveLength(fixture.fmpBatch.expectedQuotes.length);
    for (let i = 0; i < parsed.quotes.length; i += 1) {
      const actual = parsed.quotes[i];
      const expected = fixture.fmpBatch.expectedQuotes[i];
      expect(actual?.symbol).toBe(expected?.symbol);
      expect(actual?.exchange).toBe(expected?.exchange);
      expect(actual?.price).toBeCloseTo(expected?.price ?? Number.NaN, 12);
      expect(actual?.changePct).toBeCloseTo(expected?.changePct ?? Number.NaN, 12);
      expect(actual?.previousClose).toBeCloseTo(expected?.previousClose ?? Number.NaN, 12);
      expect(actual?.volume).toBe(expected?.volume);
      expect(actual?.asOfUtcSec).toBe(expected?.asOfUtcSec);
      expect(actual?.turnover).toBeNull();
    }
  });

  it('usa fallback legacy explícito solo ante fallo stable y redacta la key en errores', async () => {
    const urls: string[] = [];
    let call = 0;
    const client = new FmpEnterpriseClient({
      config: { apiKey: 'fmp-test-secret', configured: true, baseUrl: 'https://financialmodelingprep.com' },
      fetchFn: async (url) => {
        urls.push(url);
        call += 1;
        await Promise.resolve();
        if (call === 1) return { ok: false, status: 502, text: '' };
        return {
          ok: true,
          status: 200,
          text: JSON.stringify([{ date: '2026-07-30 13:16:00', open: 10, high: 10.5, low: 9.9, close: 10.4, volume: 100 }]),
        };
      },
      nowMsFn: () => 1_700_000_000_000,
    });
    const result = await client.fetchHistorical({ symbol: 'GGAL', timeframe: '5m' });
    expect(result.source).toBe('FMP_LEGACY');
    expect(result.legacyFallbackUsed).toBe(true);
    expect(result.rows).toBe(1);
    expect(urls.some((url) => url.includes('/stable/historical-chart/5min'))).toBe(true);
    expect(urls.some((url) => url.includes('/api/v3/historical-chart/5min/GGAL'))).toBe(true);
    expect(client.getDiagnostics().lastError).toBeNull();
    const failingClient = new FmpEnterpriseClient({
      config: { apiKey: 'fmp-test-secret', configured: true, baseUrl: 'https://financialmodelingprep.com' },
      fetchFn: async () => {
        await Promise.resolve();
        return { ok: false, status: 502, text: '' };
      },
      nowMsFn: () => 1_700_000_000_000,
      secrets: ['fmp-test-secret'],
    });
    await expect(failingClient.fetchHistorical({ symbol: 'GGAL', timeframe: '1D' })).rejects.toThrow('HTTP 502');
  });

  it('no acepta una serie profunda FMP que empiece después del gap electoral', () => {
    expect(ELECTORAL_GAP_START_UTC_SEC).toBe(fixture.electoralGapStartUtcSec);
  });
});

describe('Pieza 41 — Tradier stream e histórico REST', () => {
  it('define el núcleo líquido exacto sin índices Massive', () => {
    const required = ['SPY', 'QQQ', 'IWM', 'DIA', 'VIXY', 'GGAL', 'YPF', 'BMA', 'PAM', 'BBAR', 'SUPV', 'TGS', 'CEPU', 'CRESY', 'EDN', 'LOMA', 'MELI', 'NVDA', 'AAPL', 'MSFT', 'AMZN', 'META', 'TSLA', 'GOOGL', 'KO', 'EWZ', 'IBIT'];
    expect([...TRADIER_CORE_US_SYMBOLS].sort()).toEqual([...required].sort());
    expect(TRADIER_CORE_US_SYMBOLS.some((symbol) => symbol.startsWith('I:'))).toBe(false);
  });

  it('agrega 15m a 1h/4h por muro ET y no inventa volumen/vw', () => {
    const minute = parseTradierTimesales({
      series: {
        data: [
          { time: '2026-07-30T09:30:00-04:00', open: 10, high: 10.2, low: 10, close: 10.1, volume: 10 },
          { time: '2026-07-30T09:45:00-04:00', open: 10.1, high: 10.4, low: 10.05, close: 10.3, volume: 20 },
          { time: '2026-07-30T10:15:00-04:00', open: 10.3, high: 10.5, low: 10.2, close: 10.4, volume: 30 },
        ],
      },
    }).bars;
    const hourly = aggregateTradierBars(minute, '1h');
    expect(hourly).toHaveLength(2);
    expect(hourly[0]?.high).toBeCloseTo(10.4, 12);
    expect(hourly[0]?.volume).toBe(30);
    expect(hourly[1]?.volume).toBe(30);
  });

  it('normaliza historial diario Tradier a 00:00 ET', () => {
    const parsed = parseTradierDailyHistory({
      history: {
        day: [
          { date: '2026-07-30', open: 100, high: 101, low: 99, close: 100.5, volume: 12345 },
          { date: '2026-07-31', open: 100.5, high: 102, low: 100.2, close: 101.1, volume: 999 },
        ],
      },
    });
    expect(parsed.bars).toHaveLength(2);
    expect(parsed.bars[0]?.volume).toBe(12345);
    expect(parsed.bars[1]?.volume).toBe(999);
  });
});

describe('Pieza 41 — Massive standby STANDBY_TRADIER_FMP_PRIMARY', () => {
  it('resuelve el modo con FMP o cualquier alias Tradier y respeta el override', () => {
    for (const caseItem of fixture.massiveStocksMode.cases) {
      expect(resolveMassiveStocksMode(caseItem.env)).toBe(caseItem.expected);
    }
  });

  it('reporta Massive en standby y no lo mezcla con DEGRADED/ARMED', () => {
    const monitor = new FeedsHealthMonitor({
      getMassiveWs: () => ({
        configured: true,
        connected: false,
        keySlot: { envName: 'MASSIVE_WS_STOCKS_KEY', slotIndex: 0, poolSize: 1 },
        lastError: null,
        telemetry: { ...EMPTY_TELEMETRY },
        subscribedSymbols: [],
        activeSymbolCount: 0,
        subscribedOptionQuotes: 0,
        lastWsMessageAgeMs: null,
        stocksMode: 'STANDBY_TRADIER_FMP_PRIMARY',
      }),
      getMassiveRest: () => ({ configured: true, poolSize: 1, slots: [], lastSlotIndex: 0, roundRobinRequests: 0, telemetry: { ...EMPTY_TELEMETRY } }),
      getTradier: () => ({ configured: true, connected: true, sessionCreated: true, reconnectAttempts: 0, subscribedSymbols: [...TRADIER_CORE_US_SYMBOLS], lastError: null, telemetry: { ...EMPTY_TELEMETRY } }),
      getFmp: () => ({ configured: true, lastSuccessAtMs: 1, lastError: null, requestCount: 1, quoteCount: 1, subscribedSymbols: ['AAPL'], telemetry: { ...EMPTY_TELEMETRY } }),
      getOrats: () => ({ configured: true, connected: true, lastFetchAtUtcSec: 1, lastStatus: 'OK', planTier: null, quotaRemaining: null, quotaLimit: null, quotaResetAtUtcSec: null, circuitBreaker: { state: 'CLOSED', consecutiveFailures: 0, openedAtMs: null }, telemetry: { ...EMPTY_TELEMETRY } }),
      getPrimary: () => ({ configured: true, authenticated: true, wsConnected: true, tokenValidUntilUtcSec: null, tokenRenewCount: 0, wsEnvironment: 'PRIMARY_ECO_XOMS_WS', dlrSubscribedCount: 0, liveDlrCount: 0, liveDlrLastUpdateUtcSec: null, lastError: null, telemetry: { ...EMPTY_TELEMETRY } }),
      getBmb: () => ({ configured: false, healthStatus: 'OFF', connected: false, lastUpdateUtcSec: null, orderBookCount: 0, caucionCount: 0, optionCount: 0, lastError: null, signalRMode: false, telemetry: { ...EMPTY_TELEMETRY } }),
      getIol: () => ({ configured: false, connected: false, authMethod: null, passwordAuthCount: 0, refreshAuthCount: 0, tokenExpiresAtUtcSec: null, lastAuthAtUtcSec: null, quoteCount: 0, lastError: null, telemetry: { ...EMPTY_TELEMETRY } }),
      reconnectMassiveWs: () => Promise.resolve('ok'),
      resyncMassiveRest: () => Promise.resolve('ok'),
      reconnectTradier: () => Promise.resolve('ok'),
      resyncOrats: () => Promise.resolve('ok'),
      reconnectPrimary: () => Promise.resolve('ok'),
      reconnectBmb: () => Promise.resolve('ok'),
      reconnectIol: () => Promise.resolve('ok'),
      nowMsFn: () => 10_000,
      secrets: [],
    });
    const snapshot = monitor.getSnapshot();
    expect(snapshot.providers.map((provider) => provider.id)).toEqual(fixture.health.defaultProviderIds);
    expect(snapshot.summary.totalProviders).toBe(8);
    const massive = snapshot.providers.find((provider) => provider.id === fixture.health.standby.id);
    expect(massive?.state).toBe(fixture.health.standby.state);
    expect(massive?.connected).toBe(fixture.health.standby.connected);
    expect(massive?.reconnectable).toBe(fixture.health.standby.reconnectable);
    expect(snapshot.summary.standbyCount).toBe(1);
  });

  it('arranca FMP batch y no construye el socket Massive en standby', async () => {
    const responses = [
      { ok: true, status: 200, text: JSON.stringify([{ symbol: 'AAPL', price: 100, previousClose: 99, volume: 1, exchange: 'NASDAQ', timestamp: 1_700_000_000 }]) },
    ];
    const fetchFn = vi.fn(async () => {
      const response = responses[0];
      await Promise.resolve();
      if (response === undefined) throw new Error('unexpected fetch');
      return response;
    });
    const createWsClient = vi.fn(() => {
      throw new Error('Massive stocks WS must not start in standby');
    });
    const runtime = new MarketRuntime({
      fetchFn,
      nowMsFn: () => 1_700_000_000_000,
      fmpConfig: loadFmpConfigFromEnv({ FMP_API_KEY: 'fmp-test-secret' }),
      massiveStocksMode: 'STANDBY_TRADIER_FMP_PRIMARY',
      createWsClientFn: createWsClient,
    });
    await runtime.startWs();
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(createWsClient).not.toHaveBeenCalled();
    const quote = runtime.getLiveUsQuotes().find((row) => row.symbol === 'AAPL');
    expect(quote?.source).toBe('FMP_ENTERPRISE_REST');
    expect(quote?.exchange).toBe('NASDAQ');
    expect(runtime.getUsLiveSourceMode()).toBe('FMP_ENTERPRISE_REST');
    runtime.stopWs();
  });
});

describe('Pieza 41 — Eco Primary XOMS renta fija, CER y cauciones', () => {
  it('suscribe la renta fija completa, CER activo y cauciones con T1/24hs deduplicado', () => {
    const products = selectBymaL2Products(fixture.primarySelection.instruments, {
      fixedIncomeTickers: [...BYMA_L2_FIXED_INCOME_TICKERS, 'TX26'],
    });
    expect(products.map((product) => product.symbol)).toEqual(fixture.primarySelection.expectedSymbols);
    for (const required of ['AL30', 'AL30D', 'GD30', 'GD30D', 'TX26', 'PESOS - 1D', 'PESOS - 3D', 'PESOS - 7D']) {
      const parsed = fixture.primarySelection.instruments
        .map((instrument) => parseMervInstrumentSymbol(instrument.symbol))
        .filter((value): value is NonNullable<ReturnType<typeof parseMervInstrumentSymbol>> => value !== null);
      expect(parsed.some((value) => value.ticker === required)).toBe(true);
    }
  });

  it('fusiona frames Md incrementales sin perder LA/OP/CL/HI/LO/NV', () => {
    const base = fixture.primaryMdMerge.base as unknown as Parameters<typeof mergePrimaryMarketData>[0];
    const next = fixture.primaryMdMerge.bookOnlyFrame as unknown as Parameters<typeof mergePrimaryMarketData>[1];
    const merged = mergePrimaryMarketData(base, next, new Set(fixture.primaryMdMerge.bookOnlyPresent)) as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(fixture.primaryMdMerge.expected)) {
      expect(merged[key]).toEqual(value);
    }
    expect(merged['updatedAtUtcSec']).toBe(104);
  });

  it('convierte frames reales a quotes por settlement y cauciones Primary', () => {
    const offlineIol = new OfflineIolStub() as unknown as import('../src/server/iolFeedAdapter.js').IolFeedAdapter;
    const bus = new ArRealtimeBus({ bmbClient: null, iolClient: offlineIol, nowMsFn: () => 1_000 });
    const quoteFrames = fixture.primaryQuotes.frames.filter((frame) => frame.rate === undefined);
    for (const frame of quoteFrames) {
      const quote = primaryFrameToMarketTickQuote({
        ticker: frame.ticker,
        settlement: frame.settlement,
        snapshot: {
          last: frame.price ?? null,
          close: frame.close ?? null,
          open: null,
          high: frame.high ?? null,
          low: frame.low ?? null,
          nominalVolume: frame.volume ?? null,
          turnover: frame.turnover ?? null,
          lastTradeAtUtcSec: frame.timeSec,
        },
      });
      if (quote !== null) bus.ingestQuotes([quote]);
    }
    const quotes = bus.getQuotes();
    const keys = quotes.map((quote) => `${quote.market}:${quote.symbol}:${quote.settlement ?? '24hs'}`);
    expect(keys).toEqual(fixture.primaryQuotes.expectedQuoteKeys);
    const al30 = quotes.find((quote) => quote.symbol === 'AL30' && quote.settlement === '24hs');
    const al30Ci = quotes.find((quote) => quote.symbol === 'AL30' && quote.settlement === 'CI');
    expect(al30?.price).toBeCloseTo(77.05, 12);
    expect(al30Ci?.price).toBeCloseTo(77.06, 12);
    const caucionFrame = fixture.primaryQuotes.frames.find((frame) => frame.rate !== undefined);
    expect(caucionFrame).toBeDefined();
    bus.ingestCauciones([
      {
        symbol: caucionFrame?.ticker ?? 'PESOS - 3D',
        termDays: 3,
        currency: 'ARS',
        tnaWeighted: caucionFrame?.rate ?? 0,
        bidTna: caucionFrame?.bid ?? null,
        askTna: caucionFrame?.ask ?? null,
        turnoverArs: caucionFrame?.turnover ?? null,
        asOfUtcSec: caucionFrame?.timeSec ?? null,
        source: 'PRIMARY_ECO_WS',
      },
    ]);
    const caucion = bus.getCauciones().find((row) => row.termDays === 3);
    expect(caucion?.tnaWeighted).toBeCloseTo(fixture.primaryQuotes.expectedCaucion.tnaWeighted, 12);
    expect(caucion?.source).toBe(fixture.primaryQuotes.expectedCaucion.source);
    expect(bus.getSourceMode()).toBe('LIVE_PRIMARY');
  });
});

describe('Pieza 41 — Stock Detail AR:/US: y fallback BYMA', () => {
  it('resuelve identidad calificada sin colisionar CEDEAR con subyacente US', () => {
    for (const expected of fixture.routing.cases) {
      const route = resolveStockDetailRoute({ rawTicker: expected.key, isArLocalSymbol: false });
      expect(route?.key).toBe(expected.key);
      expect(route?.providerSymbol).toBe(expected.providerSymbol);
      expect(route?.market).toBe(expected.market);
      expect(route?.mode).toBe(expected.mode);
      expect(route?.isAdr).toBe(expected.isAdr);
      expect(route?.exchange).toBe(expected.exchange);
      expect(route?.badge).toBe(expected.badge);
      expect(route?.currencySymbol).toBe(expected.currencySymbol);
    }
    expect(localSymbolForAdr('YPF')).toBe('YPFD');
    expect(localSymbolForAdr('PAM')).toBe('PAMP');
  });

  it('aplica el fallback AR 1m -> 1D y mantiene el timeframe solicitado como metadata', () => {
    const fallback = resolveArTimeframeFallback('1m');
    expect(fallback.requested).toBe('1m');
    expect(fallback.effective).toBe('1D');
    expect(fallback.fallback).toBe(true);
    const direct = resolveArTimeframeFallback('1D');
    expect(direct.fallback).toBe(false);
  });

  it('separa settlement en la clave canónica de quotes AR', () => {
    expect(realtimeQuoteKey('AL30', '24hs')).toBe('AL30|24');
    expect(realtimeQuoteKey('AL30', 'CI')).toBe('AL30|CI');
    expect(parseStockDetailKey('US:YPF')).toEqual({ key: 'US:YPF', symbol: 'YPF', market: 'US' });
  });
});

describe('Pieza 41 — redacción estricta de FMP/Tradier y secretos broker', () => {
  it('redacta apikey URL-encoded y secretos raw', () => {
    for (const caseItem of fixture.redaction.cases) {
      expect(redactSecrets(caseItem.input, fixture.redaction.secrets)).toBe(caseItem.expected);
    }
  });
});

/** Stub IOL offline para el bus AR. */
class OfflineIolStub {
  public getQuotes(): never[] { return []; }
  public getCauciones(): never[] { return []; }
  public start(): void {}
  public stop(): void {}
  public getHealth(): never { throw new Error('offline stub'); }
}
