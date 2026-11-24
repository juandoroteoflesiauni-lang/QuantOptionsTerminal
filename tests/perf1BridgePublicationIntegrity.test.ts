import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface UsStockRowLike {
  readonly ticker: string;
  readonly price: number;
}

const marketDataSpecifier = '../web/src/data/marketData';
const { US_MARKET_DATA } = (await import(/* @vite-ignore */ marketDataSpecifier)) as {
  readonly US_MARKET_DATA: readonly UsStockRowLike[];
};

interface BridgeStateLike {
  readonly version: number;
  readonly usSnapshotsBySymbol: Readonly<Record<string, Record<string, unknown> | undefined>>;
  readonly optionsByUnderlying: Readonly<Record<string, Record<string, unknown> | undefined>>;
  readonly loadingOptionExpiries: Readonly<Record<string, boolean>>;
}

interface BridgeApi {
  getLiveMarketStateSnapshot(): BridgeStateLike;
  requestUsSnapshot(
    symbol: string,
    options?: { readonly force?: boolean; readonly signal?: AbortSignal; readonly prefetch?: boolean },
  ): Promise<unknown>;
  requestOptionsChain(underlying: string, force?: boolean, expiration?: string): Promise<void>;
  requestUsOptionExpiry(underlying: string, expirationDate: string, force?: boolean): Promise<void>;
}

const bridgeSpecifier = '../web/src/data/liveRuntimeBridge';
const bridge = (await import(/* @vite-ignore */ bridgeSpecifier)) as unknown as BridgeApi;

interface DeferredFetch {
  readonly url: string;
  readonly resolveJson: (body: unknown) => void;
}

const pendingFetches: DeferredFetch[] = [];

async function waitForFetchCount(count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(pendingFetches.length).toBe(count);
  });
}

function fetchAt(index: number): DeferredFetch {
  const entry = pendingFetches[index];
  if (entry === undefined) throw new Error(`Missing deferred fetch #${String(index)}`);
  return entry;
}

function rec(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected object record');
  }
  return value as Record<string, unknown>;
}

function recArray(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('Expected array');
  return value as readonly Record<string, unknown>[];
}

function expiryFact(
  date: string,
  input: { readonly loaded: boolean; readonly calls: number; readonly puts: number },
): Record<string, unknown> {
  return {
    expirationDate: date,
    daysToExpiry: 21,
    loaded: input.loaded,
    validCallCount: input.calls,
    validPutCount: input.puts,
    nearAtmLiquidity: input.loaded ? 90_000 : 0,
    inDefaultWindow: true,
    hasCompleteAtmChain: input.loaded,
  };
}

function makeSnapshotPayload(input: {
  readonly symbol: string;
  readonly asOfUtcSec: number;
  readonly spot: number;
  readonly aggregateGex: number;
  readonly calls: number;
  readonly loaded: boolean;
  readonly expirationDate?: string;
}): Record<string, unknown> {
  const expDate = input.expirationDate ?? '2026-08-21';
  return {
    status: 'OK',
    feedMode: 'LIVE',
    quoteMode: 'LIVE_NBBO',
    symbol: input.symbol,
    asOfUtcSec: input.asOfUtcSec,
    envelope: { snapshot: { metrics: { spot: input.spot } } },
    marketContext: {
      unifiedQuotes: [
        {
          ticker: input.symbol,
          assetType: 'stock',
          price: input.spot,
          change: 0,
          changePct: 0,
          previousClose: input.spot,
          dayLow: input.spot,
          dayHigh: input.spot,
          dayRangePos: 0.5,
          volumeM: 1,
          iv30d: 0.22,
          marketStatus: 'open',
          volume: 1_000_000,
        },
      ],
      treasury: { rate30d: 0.05, dividendYieldFront: 0 },
    },
    optionsChain: {
      selectedExpirationDate: expDate,
      selectionReason: 'DEFAULT_LIQUID_14_45_DTE',
      prefetchExpirationDates: [],
      availableExpirations: [
        expiryFact(expDate, { loaded: input.loaded, calls: input.calls, puts: input.calls }),
      ],
    },
    exposureSummary: {
      netGex: input.aggregateGex,
      netDex: 1,
      netVex: null,
      netCex: null,
      vannaRegime: 'NEUTRAL',
      charmPinStrike: null,
      callWallStrike: 65,
      putWallStrike: 60,
      gammaFlipSpot: 62,
      gammaFlipStatus: 'ABOVE',
      trace: {
        evaluationSec: input.asOfUtcSec,
        valuationSpot: input.spot,
        valuationSpotSource: 'PARITY_IMPLIED',
        headerSpot: input.spot,
        spotDivergenceBps: 0,
        quoteMode: 'LIVE_NBBO',
        coverage: 'partial',
        engineExpirationsCount: 1,
        engineExpirationDates: [expDate],
        engineStrikeRange: { min: 60, max: 65 },
        engineStrikeCount: 2,
        byStrikeRange: { min: 60, max: 65 },
        byStrikeCount: 2,
        catalogExpirationsCount: null,
        catalogExpirationDates: [],
        payloadContractCount: 2,
        payloadExpirationDates: [expDate],
        quoteTimes: null,
        chainCoverage: null,
      },
    },
    terminalEngines: {
      volAnalyticsSuite: { expiriesByCode: { [expDate]: { expiryCode: expDate, daysToExpiry: 21, ivAtm: 0.35 } } },
    },
    volSurfaceSummary: { iv30d: 0.22, frontSlice: null, slices: [], contracts: [] },
  };
}

function makeExpiryChainPayload(input: {
  readonly symbol: string;
  readonly expirationDate: string;
  readonly asOfUtcSec: number;
  readonly calls: number;
}): Record<string, unknown> {
  return {
    status: 'OK',
    feedMode: 'LIVE',
    quoteMode: 'LIVE_NBBO',
    symbol: input.symbol,
    expirationDate: input.expirationDate,
    asOfUtcSec: input.asOfUtcSec,
    spot: 61.5,
    daysToExpiry: 21,
    expiryMeta: {
      expirationDate: input.expirationDate,
      daysToExpiry: 21,
      loaded: true,
      validCallCount: input.calls,
      validPutCount: input.calls,
      nearAtmLiquidity: 88_000,
      inDefaultWindow: true,
      hasCompleteAtmChain: true,
    },
    contracts: [],
    slice: null,
    exposureSummary: null,
    syntheticRates: null,
    volAnalyticsExpiry: { expiryCode: input.expirationDate, daysToExpiry: 21, ivAtm: 0.44 },
    dataQuality: { parityExpiries: 1 },
  };
}

describe('Perf-1 Bridge Publication Integrity (Borders B1 / B2 / B3)', () => {
  beforeEach(() => {
    pendingFetches.length = 0;
    vi.stubGlobal('fetch', (rawUrl: unknown) => {
      return new Promise((resolve) => {
        pendingFetches.push({
          url: String(rawUrl),
          resolveJson: (body) => {
            resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
          },
        });
      });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('B1: point-snap rechazado por más viejo no pisa optionsByUnderlying ni hidrata US_MARKET_DATA', async () => {
    const basePromise = bridge.requestOptionsChain('US:ZQPG');
    await waitForFetchCount(1);
    fetchAt(0).resolveJson(
      makeSnapshotPayload({ symbol: 'ZQPG', asOfUtcSec: 5_000, spot: 120, aggregateGex: 150, calls: 180, loaded: true }),
    );
    await basePromise;

    const baseOpts = bridge.getLiveMarketStateSnapshot().optionsByUnderlying['US:ZQPG'];
    expect(baseOpts).toBeDefined();
    const baseSpot = baseOpts?.['spot'];

    // Point-snap retrógrado sobre 2026-08-21 debe ser rechazado antes de syncOptionEngineMarket/optionsByUnderlying
    const stalePoint = bridge.requestOptionsChain('US:ZQPG', false, '2026-08-21');
    await waitForFetchCount(2);
    fetchAt(1).resolveJson(
      makeSnapshotPayload({ symbol: 'ZQPG', asOfUtcSec: 3_000, spot: 999, aggregateGex: 999, calls: 10, loaded: true }),
    );
    await stalePoint;

    const afterStaleOpts = bridge.getLiveMarketStateSnapshot().optionsByUnderlying['US:ZQPG'];
    expect(afterStaleOpts).toBe(baseOpts);
    expect(afterStaleOpts?.['spot']).toBe(baseSpot);

    // Point-snap sin base previa no muta el singleton US_MARKET_DATA
    const targetRow = US_MARKET_DATA[0];
    expect(targetRow).toBeDefined();
    if (targetRow !== undefined) {
      const sym = targetRow.ticker;
      const priceBefore = targetRow.price;
      const pointWithoutBase = bridge.requestOptionsChain(`US:${sym}`, false, '2026-08-21');
      await waitForFetchCount(3);
      fetchAt(2).resolveJson(
        makeSnapshotPayload({ symbol: sym, asOfUtcSec: 2_500, spot: 9_876.54, aggregateGex: 50, calls: 80, loaded: true }),
      );
      await pointWithoutBase;
      expect(targetRow.price).toBe(priceBefore);
    }
  });

  it('B2: currentFactState consulta pendingPointFactsBySymbol cuando previous === undefined', async () => {
    // Expiry chain llega primero a 4_000 cuando aún no hay base snapshot de ZQPI
    const expPromise = bridge.requestUsOptionExpiry('US:ZQPI', '2026-08-21');
    await waitForFetchCount(1);
    fetchAt(0).resolveJson(
      makeExpiryChainPayload({ symbol: 'ZQPI', expirationDate: '2026-08-21', asOfUtcSec: 4_000, calls: 210 }),
    );
    await expPromise;

    // Luego un point-snap más viejo (2_500) intenta pisar el hecho pendiente sin base previa -> rechazado
    const olderPoint = bridge.requestOptionsChain('US:ZQPI', false, '2026-08-21');
    await waitForFetchCount(2);
    fetchAt(1).resolveJson(
      makeSnapshotPayload({ symbol: 'ZQPI', asOfUtcSec: 2_500, spot: 88, aggregateGex: 88, calls: 15, loaded: true }),
    );
    await olderPoint;

    // Finalmente llega una base más vieja (1_000): gana el hecho pendiente de 4_000 (calls=210), NO 15
    const basePromise = bridge.requestUsSnapshot('ZQPI');
    await waitForFetchCount(3);
    fetchAt(2).resolveJson(
      makeSnapshotPayload({ symbol: 'ZQPI', asOfUtcSec: 1_000, spot: 55, aggregateGex: 55, calls: 0, loaded: false }),
    );
    await basePromise;

    const snap = bridge.getLiveMarketStateSnapshot().usSnapshotsBySymbol['ZQPI'];
    const entries = recArray(rec(snap?.['optionsChain'])['availableExpirations']);
    const entry = entries.find((e) => e['expirationDate'] === '2026-08-21');
    expect(entry?.['loaded']).toBe(true);
    expect(entry?.['validCallCount']).toBe(210);
  });

  it('B3: requestUsOptionExpiry ejecuta un único notify() al completar y limpiar loadingOptionExpiries', async () => {
    const versionBeforeStart = bridge.getLiveMarketStateSnapshot().version;
    const req = bridge.requestUsOptionExpiry('US:ZQPJ', '2026-08-21');
    await waitForFetchCount(1);
    const versionWhileLoading = bridge.getLiveMarketStateSnapshot().version;
    expect(versionWhileLoading).toBe(versionBeforeStart + 1);
    expect(bridge.getLiveMarketStateSnapshot().loadingOptionExpiries['ZQPJ:2026-08-21']).toBe(true);

    fetchAt(0).resolveJson(
      makeExpiryChainPayload({ symbol: 'ZQPJ', expirationDate: '2026-08-21', asOfUtcSec: 6_000, calls: 95 }),
    );
    await req;

    const versionAfterComplete = bridge.getLiveMarketStateSnapshot().version;
    expect(versionAfterComplete).toBe(versionWhileLoading + 1);
    expect(bridge.getLiveMarketStateSnapshot().loadingOptionExpiries['ZQPJ:2026-08-21']).toBe(false);
  });
});
