/**
 * Pieza 50.3 — Integridad crítica de datos y cálculos de opciones:
 *  1. Aislamiento SPY (`US:SPY`) vs. GGAL (`AR:GGAL`) por clave `market:symbol` +
 *     guarda pura `validateChainIntegrity`.
 *  2. Normalización ORATS en origen (`iv20d`, `exErnIv30d`, `impliedMove`, `borrow30`).
 *  3. Deep ITM/OTM americano asintótico + dS adaptativo corto + cap IV `9.99`.
 *  4. Buy-Write / Cobertura Sintética con gate `DTE < 3` y frontera IEEE-754 `3/365`.
 *  5. 0DTE (`0DTE`, sin `1d`) y ratios 1x2 σ-escalados (±0.5σ/±1.0σ/±1.5σ, prima > 0.01).
 *
 * Referencia independiente: fixtures/options_pieza50_3_reference.json generada por
 * tools/gen_options_pieza50_3_reference.py (tolerancia 1e-9 global; 1e-6 documentada
 * para derivadas segundas por diferencias finitas).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { priceBsm } from '../src/core/options/blackScholes.js';
import {
  gammaAmericanFiniteDiffOrAnalytical,
  greeksAmericanFiniteDiffOrAnalytical,
} from '../src/core/options/american.js';
import { validateChainIntegrity } from '../src/core/options/chainIntegrity.js';
import {
  evaluateBuyWrite,
  evaluateConversionReversal,
} from '../src/core/options/syntheticRates.js';
import {
  MIN_RATIO_SHORT_LEG_PREMIUM,
  RATIO_SIGMA_MULTIPLIERS,
  computeRatiosAndStructureCosts,
  type RatiosAndStructureCostsResult,
} from '../src/core/options/volAnalyticsSuite.js';
import {
  formatDteLabel,
  normalizeOratsSignedRateToDecimal,
  normalizeOratsVolDecimal,
  normalizeOratsVolToDecimal,
  oratsVolToPct,
  sanitizeContractIv,
} from '../src/core/options/zeroDteFixes.js';
import { OratsHybridClient } from '../src/server/oratsHybridClient.js';
import { MarketRuntime, type UsOptionExpiryChainResponse } from '../src/server/marketRuntime.js';
import type { FetchFn } from '../src/data/types.js';
import { mapUsSnapshotToArOptions } from '../web/src/data/expiryChainMerge.js';
import type {
  ArOptionsResponse,
  UsOptionContractRowDto,
  UsSnapshotResponseDto,
} from '../web/src/data/liveTypes.js';
import {
  evaluateActiveExpiryHeaderTir,
  evaluateActiveExpiryRegimeAndBreaker,
} from '../web/src/components/options/activeExpiryBinding.js';

/**
 * `liveRuntimeBridge.ts`/`engine.ts` viven en el mundo web (imports sin extensión,
 * resolución bundler) y no forman parte del program NodeNext del tsconfig raíz:
 * se cargan por import dinámico de especificador variable para no contaminar tsc.
 */
interface BridgeExpiryGroupLike {
  readonly id: string;
  readonly daysToExpiry: number;
  readonly rows: readonly { readonly strike: number }[];
}
interface BridgeOptionsLike {
  readonly spot?: number | null;
  readonly underlying?: string;
}
interface BridgeStateLike {
  readonly optionExpiriesByUnderlyingKey: Readonly<Record<string, readonly BridgeExpiryGroupLike[]>>;
  readonly optionsByUnderlying: Readonly<Record<string, BridgeOptionsLike>>;
}
interface BridgeApi {
  getLiveMarketStateSnapshot(): BridgeStateLike;
  getLiveOptionsForUnderlying(state: BridgeStateLike, rawKey: string): BridgeOptionsLike | undefined;
  getOptionExpiriesForUnderlying(state: BridgeStateLike, rawKey: string): readonly BridgeExpiryGroupLike[];
  requestOptionsChain(underlying: string, force?: boolean, expiration?: string): Promise<void>;
  setActiveOptionsUnderlyingKey(rawKey: string | null): void;
}
interface EngineApi {
  readonly CURRENT_MARKET_IS_US: boolean;
}

const bridgeSpecifier = '../web/src/data/liveRuntimeBridge';
const engineSpecifier = '../web/src/components/options/engine';
const bridge = (await import(/* @vite-ignore */ bridgeSpecifier)) as unknown as BridgeApi;
const engine = (await import(/* @vite-ignore */ engineSpecifier)) as unknown as EngineApi;
const getLiveMarketStateSnapshot = (): BridgeStateLike => bridge.getLiveMarketStateSnapshot();
const getLiveOptionsForUnderlying = (
  state: BridgeStateLike,
  rawKey: string,
): BridgeOptionsLike | undefined => bridge.getLiveOptionsForUnderlying(state, rawKey);
const getOptionExpiriesForUnderlying = (
  state: BridgeStateLike,
  rawKey: string,
): readonly BridgeExpiryGroupLike[] => bridge.getOptionExpiriesForUnderlying(state, rawKey);
const requestOptionsChain = (underlying: string): Promise<void> =>
  bridge.requestOptionsChain(underlying);
const setActiveOptionsUnderlyingKey = (rawKey: string | null): void => {
  bridge.setActiveOptionsUnderlyingKey(rawKey);
};

type JsonNumber = number | null;

interface ChainIntegrityCase {
  readonly name: string;
  readonly rows: readonly JsonNumber[];
  readonly spot: JsonNumber;
  readonly expected: {
    readonly valid: boolean;
    readonly reason: string;
    readonly medianStrike: JsonNumber;
    readonly ratio: JsonNumber;
    readonly validStrikeCount: number;
  };
}

interface OratsScaleCases {
  readonly vol: readonly { readonly raw: JsonNumber; readonly expected: JsonNumber }[];
  readonly signed: readonly { readonly raw: number; readonly expected: JsonNumber }[];
  readonly pctIdempotence: readonly { readonly raw: number; readonly expectedPct: number }[];
}

interface DeepGreekCase {
  readonly name: string;
  readonly input: {
    readonly contractType: 'call' | 'put';
    readonly spot: number;
    readonly strike: number;
    readonly t: number;
    readonly rate: number;
    readonly q: number;
    readonly sigma: number;
  };
  readonly expected: {
    readonly price: number;
    readonly delta: number;
    readonly gamma: number;
    readonly theta: number;
    readonly thetaDaily: number;
    readonly vega: number;
    readonly vegaPer1Pct: number;
    readonly rho: number;
    readonly vanna: number;
    readonly charm: number;
  };
}

interface AmericanDeepAndAdaptiveCases {
  readonly deepGreeks: readonly DeepGreekCase[];
  readonly adaptiveShortDte: {
    readonly input: DeepGreekCase['input'] & { readonly dS: number };
    readonly expected: DeepGreekCase['expected'];
  };
  readonly ivCapCases: readonly {
    readonly name: string;
    readonly iv: number;
    readonly extrinsic: number;
    readonly expected: JsonNumber;
  }[];
}

interface BuyWriteCase {
  readonly name: string;
  readonly input: Parameters<typeof evaluateBuyWrite>[0];
  readonly expected: {
    readonly totalFeesPerShare: number;
    readonly netCostBasis: number;
    readonly breakevenPrice: number;
    readonly downsideProtectionPct: number;
    readonly staticProfitPerShare: number;
    readonly staticReturnPct: number;
    readonly staticAnnualizedTna: JsonNumber;
    readonly maxAssignedProfitPerShare: number;
    readonly maxAssignedReturnPct: number;
    readonly assignedAnnualizedTna: JsonNumber;
    readonly annualizedRate: JsonNumber;
    readonly rateStatus: string;
  };
}

interface ConversionReversalCase {
  readonly name: string;
  readonly input: Parameters<typeof evaluateConversionReversal>[0];
  readonly expected: {
    readonly conversionNetCost: number;
    readonly conversionAnnualizedTna: JsonNumber;
    readonly conversionEdgeVsRiskFreeBps: JsonNumber;
    readonly reversalNetProceeds: number;
    readonly shortBorrowCost: number;
    readonly reversalTerminalObligation: number;
    readonly reversalAnnualizedTna: JsonNumber;
    readonly reversalEdgeVsRiskFreeBps: JsonNumber;
    readonly netEdgeVsRiskFreeBps: JsonNumber;
    readonly arbitrageSignal: string;
    readonly rateStatus: string;
  };
}

interface RatioRowJson {
  readonly side: 'CALL' | 'PUT';
  readonly targetOffsetPct: number;
  readonly longStrike: number;
  readonly longPrice: number;
  readonly shortStrike: number;
  readonly shortPrice: number;
  readonly otmLotsPerBought: number;
  readonly netCash1x2: number;
  readonly outerBreakeven1x2: number;
}

interface RatiosCase {
  readonly name: string;
  readonly input: Parameters<typeof computeRatiosAndStructureCosts>[0];
  readonly expected: {
    readonly useSigma: boolean;
    readonly ratioExpectedMove: JsonNumber;
    readonly callRatios: readonly RatioRowJson[];
    readonly putRatios: readonly RatioRowJson[];
  };
}

interface Pieza503Fixture {
  readonly meta: { readonly generator: string; readonly tolerance: number };
  readonly chainIntegrityCases: readonly ChainIntegrityCase[];
  readonly oratsScaleCases: OratsScaleCases;
  readonly americanDeepAndAdaptiveCases: AmericanDeepAndAdaptiveCases;
  readonly buyWriteCases: readonly BuyWriteCase[];
  readonly conversionReversalCases: readonly ConversionReversalCase[];
  readonly zeroDteAndRatiosSigmaCases: {
    readonly dteLabels: readonly { readonly dte: JsonNumber; readonly expected: string }[];
    readonly ratiosCases: readonly RatiosCase[];
  };
}

const fixturePath = join(process.cwd(), 'fixtures', 'options_pieza50_3_reference.json');
const fixture: Pieza503Fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Pieza503Fixture;
const TOL = fixture.meta.tolerance;
const SECOND_ORDER_TOL = 1e-6;

function expectClose(actual: number, expected: number, tol = TOL): void {
  expect(Number.isFinite(actual)).toBe(true);
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol * Math.max(1, Math.abs(expected)));
}

function expectNumberOrNaN(actual: number, expected: JsonNumber, tol = TOL): void {
  if (expected === null) {
    expect(Number.isNaN(actual)).toBe(true);
  } else {
    expect(Number.isFinite(actual)).toBe(true);
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  setActiveOptionsUnderlyingKey(null);
});

// ---------------------------------------------------------------------------
// 1) Aislamiento de store/bridge SPY vs. GGAL + validateChainIntegrity
// ---------------------------------------------------------------------------

describe('Pieza 50.3 — Aislamiento de cadenas por `market:symbol` + guarda de integridad', () => {
  it('valida todos los chainIntegrityCases de la referencia Python (mediana y ratio exactos)', () => {
    for (const testCase of fixture.chainIntegrityCases) {
      const rows = testCase.rows.map((strike) => ({
        strike: strike === null ? Number.NaN : strike,
      }));
      const spot = testCase.spot === null ? Number.NaN : testCase.spot;
      const result = validateChainIntegrity(rows, spot);
      expect(result.valid, testCase.name).toBe(testCase.expected.valid);
      expect(result.reason, testCase.name).toBe(testCase.expected.reason);
      expect(result.validStrikeCount, testCase.name).toBe(testCase.expected.validStrikeCount);
      expectNumberOrNaN(result.medianStrike, testCase.expected.medianStrike);
      expectNumberOrNaN(result.ratio, testCase.expected.ratio);
      // Sin mutación de la entrada.
      expect(rows.length).toBe(testCase.rows.length);
    }
    // Fronteras explícitas fuera de la tolerancia relativa.
    expect(validateChainIntegrity([{ strike: 24.9999 }], 100).reason).toBe('SCALE_MISMATCH');
    expect(validateChainIntegrity([{ strike: 300.0001 }], 100).reason).toBe('SCALE_MISMATCH');
    expect(validateChainIntegrity([{ strike: 25 }], 100).valid).toBe(true);
    expect(validateChainIntegrity([{ strike: 300 }], 100).valid).toBe(true);
    expect(validateChainIntegrity([], 600).reason).toBe('EMPTY_CHAIN');
    expect(validateChainIntegrity([{ strike: 600 }], Number.NaN).reason).toBe('INVALID_SPOT');
    expect(validateChainIntegrity([{ strike: -1 }], 600).reason).toBe('INVALID_STRIKES');
  });

  it('aísla US:SPY de AR:GGAL y US:GGAL, y no pisa engine.ts con el polling AR', async () => {
    const asOfUtcSec = Math.floor(Date.UTC(2026, 10, 21, 21, 0, 0) / 1_000);
    const spyExpiry = '2026-11-23';
    const spyExpirySec = Math.floor(Date.UTC(2026, 10, 23, 21, 0, 0) / 1_000);
    const spyRow = (strike: number, type: 'call' | 'put'): UsOptionContractRowDto => ({
      ticker: `O:SPY261123${type === 'call' ? 'C' : 'P'}${String(strike * 1_000).padStart(8, '0')}`,
      contractType: type,
      strike,
      expirationDate: spyExpiry,
      expiryUtcSec: spyExpirySec,
      bid: 5,
      ask: 5.2,
      mid: 5.1,
      lastPrice: 5.1,
      openInterest: 1_000,
      volume: 100,
      previousClose: 5,
      changePct: 2,
      ownIv: 0.2,
      providerIv: 0.2,
      ivSource: 'OWN',
      delta: type === 'call' ? 0.5 : -0.5,
      gamma: 0.01,
      thetaDaily: -0.02,
      vegaPer1Pct: 0.1,
      vanna: 0,
      charm: 0,
    });
    const spySnapshot = {
      status: 'PARTIAL',
      feedMode: 'LIVE',
      quoteMode: 'LIVE_NBBO',
      symbol: 'SPY',
      isIndex: false,
      asOfUtcSec,
      envelope: { snapshot: { metrics: { spot: 600 } } },
      marketContext: {
        unifiedQuotes: [
          {
            ticker: 'SPY',
            assetType: 'stock',
            price: 600,
            change: 1,
            changePct: 0.15,
            previousClose: 599,
            dayLow: 598.5,
            dayHigh: 601,
            dayRangePos: 0.6,
            volumeM: 40,
            iv30d: 0.2,
            marketStatus: 'open',
            volume: 40_000_000,
          },
        ],
      },
      volSurfaceSummary: {
        iv30d: 0.2,
        frontSlice: null,
        slices: [
          {
            expirationDate: spyExpiry,
            expirySec: spyExpirySec,
            rate: 0.04,
            ivAtm: 0.2,
            timeToExpiryDays: 2,
          },
        ],
        contracts: [580, 600, 620].flatMap((strike) =>
          (['call', 'put'] as const).map((type) => spyRow(strike, type)),
        ),
      },
    } as unknown as UsSnapshotResponseDto;

    const arExpirySec = Math.floor(Date.UTC(2026, 10, 27, 21, 0, 0) / 1_000);
    const arContract = (strike: number, type: 'call' | 'put') => ({
      symbol: `GFGC${String(strike)}${type === 'call' ? 'C' : 'V'}`,
      underlying: 'GGAL',
      contractType: type,
      strike,
      expiryCode: '2026-11-27',
      expirationDate: '2026-11-27',
      expiryUtcSec: arExpirySec,
      daysToExpiry: 6,
      bid: type === 'call' ? 120 : 90,
      ask: type === 'call' ? 130 : 100,
      last: type === 'call' ? 125 : 95,
      mark: type === 'call' ? 125 : 95,
      volume: 10,
      openInterest: 50,
      iv: 0.55,
      delta: type === 'call' ? 0.5 : -0.5,
      gamma: 0.01,
      thetaDaily: -2,
      vegaPer1Pct: 0.5,
      rho: null,
      vanna: null,
      charm: null,
      intrinsic: type === 'call' ? 0 : Math.max(0, strike - 7200),
      extrinsic: type === 'call' ? 125 : 95,
      previousClose: 120,
      changePct: 1.5,
      source: 'DATA912' as const,
    });
    const arPayload = {
      asOfUtcSec,
      feedStatus: 'LIVE',
      underlying: 'GGAL',
      market: 'AR',
      spot: 7200,
      rateTna: 40,
      continuousRate: Math.log(1.4),
      dividendYield: 0,
      lotSize: 100,
      settlement: 'T+0',
      exerciseCutoffArt: '15:30 ART',
      realizedVol20d: null,
      realizedVol60d: null,
      histMedianIv: null,
      vrpSpread: null,
      historicalCloses: [],
      termStructure: [],
      expiries: [
        {
          expiryCode: '2026-11-27',
          expiryLabel: '2026-11-27 (6d)',
          expirationDate: '2026-11-27',
          expiryUtcSec: arExpirySec,
          days: 6,
          ivAtm: 0.55,
          riskReversal25: null,
          butterfly25: null,
          butterflyArbitrageFree: true,
          strikes: [6000, 7000, 8000],
          calls: [6000, 7000, 8000].map((strike) => arContract(strike, 'call')),
          puts: [6000, 7000, 8000].map((strike) => arContract(strike, 'put')),
          loaded: true,
        },
      ],
      exposureSummary: null,
      costSchedule: {
        rvMarketFeeRate: 0.002,
        optionsFeeRate: 0.002,
        shortLoanFeeRate: 0,
        vatRate: 0.21,
        bondsVatExempt: false,
      },
      providerErrors: [],
    } as unknown as ArOptionsResponse;

    vi.stubGlobal(
      'fetch',
      (url: string | URL) =>
        Promise.resolve(
          String(url).includes('/api/snapshot?symbol=SPY')
            ? { ok: true, status: 200, json: () => Promise.resolve(spySnapshot) }
            : String(url).includes('/api/ar/options?underlying=GGAL')
              ? { ok: true, status: 200, json: () => Promise.resolve(arPayload) }
              : { ok: false, status: 404, json: () => Promise.resolve({}) },
        ),
    );

    setActiveOptionsUnderlyingKey('US:SPY');
    await requestOptionsChain('US:SPY');
    expect(engine.CURRENT_MARKET_IS_US).toBe(true);

    const stateAfterSpy = getLiveMarketStateSnapshot();
    const spyGroupsBefore = getOptionExpiriesForUnderlying(stateAfterSpy, 'US:SPY');
    expect(spyGroupsBefore.length).toBe(1);
    expect(spyGroupsBefore[0]?.rows.map((r) => r.strike)).toEqual([580, 600, 620]);
    expect(spyGroupsBefore[0]?.daysToExpiry).toBe(2);
    // Clave canónica y cruda resuelven al MISMO payload de SPY.
    expect(getLiveOptionsForUnderlying(stateAfterSpy, 'SPY')?.spot).toBe(600);
    expect(getLiveOptionsForUnderlying(stateAfterSpy, 'US:SPY')?.underlying).toBe('SPY');

    // Llega el polling BYMA de AR:GGAL mientras el usuario opera US:SPY.
    await requestOptionsChain('AR:GGAL');
    expect(engine.CURRENT_MARKET_IS_US).toBe(true); // engine.ts NO fue pisado por AR.
    const stateAfterAr = getLiveMarketStateSnapshot();
    const spyGroupsAfter = getOptionExpiriesForUnderlying(stateAfterAr, 'US:SPY');
    expect(spyGroupsAfter.map((g) => g.id)).toEqual(spyGroupsBefore.map((g) => g.id));
    expect(spyGroupsAfter[0]?.rows.map((r) => r.strike)).toEqual([580, 600, 620]);
    expect(spyGroupsAfter[0]?.daysToExpiry).toBe(2);

    const arGroups = getOptionExpiriesForUnderlying(stateAfterAr, 'AR:GGAL');
    expect(arGroups.length).toBe(1);
    expect(arGroups[0]?.rows.map((r) => r.strike)).toEqual([6000, 7000, 8000]);
    expect(arGroups[0]?.daysToExpiry).toBe(6);
    expect(getLiveOptionsForUnderlying(stateAfterAr, 'GGAL')?.spot).toBe(7200);
    // US:GGAL (ADR) no colisiona con AR:GGAL.
    expect(getOptionExpiriesForUnderlying(stateAfterAr, 'US:GGAL')).toEqual([]);
    expect(getLiveOptionsForUnderlying(stateAfterAr, 'US:GGAL')).toBeUndefined();
    // Subyacente nunca cargado: explícitamente vacío (jamás GGAL_OPTION_EXPIRIES[0]).
    expect(getOptionExpiriesForUnderlying(stateAfterAr, 'US:NVDA')).toEqual([]);

    // Al activar AR:GGAL, el motor se alinea con la cadena cacheada (inmediato).
    setActiveOptionsUnderlyingKey('AR:GGAL');
    expect(engine.CURRENT_MARKET_IS_US).toBe(false);
    setActiveOptionsUnderlyingKey('US:SPY');
    expect(engine.CURRENT_MARKET_IS_US).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2) ORATS: normalización en origen e idempotencia
// ---------------------------------------------------------------------------

describe('Pieza 50.3 — ORATS IV Surface 20D normalizado en origen (nunca 3.582,0%)', () => {
  it('valida la referencia Python de escala vol/firmada e idempotencia de `oratsVolToPct`', () => {
    expect(normalizeOratsVolDecimal).toBe(normalizeOratsVolToDecimal);
    for (const c of fixture.oratsScaleCases.vol) {
      const v = normalizeOratsVolToDecimal(c.raw === null ? Number.NaN : c.raw);
      expectNumberOrNaN(v, c.expected);
    }
    for (const c of fixture.oratsScaleCases.signed) {
      expectNumberOrNaN(normalizeOratsSignedRateToDecimal(c.raw), c.expected);
    }
    for (const c of fixture.oratsScaleCases.pctIdempotence) {
      expectClose(oratsVolToPct(normalizeOratsVolToDecimal(c.raw)), c.expectedPct);
      expectClose(oratsVolToPct(c.raw), c.expectedPct);
    }
    // Contrato Pieza 46.1 preservado.
    expect(normalizeOratsVolDecimal(4.99)).toBe(4.99);
    expect(normalizeOratsVolDecimal(5.0)).toBe(0.05);
    expect(oratsVolToPct(0.3582)).toBeCloseTo(35.82, 9);
    expect(oratsVolToPct(35.82)).toBeCloseTo(35.82, 9);
  });

  it('normaliza `iv20d`, `exErnIv30d`, `impliedMove` y `borrow30` al hidratar /datav2/cores', async () => {
    const client = new OratsHybridClient({
      env: { ORATS_API_KEY: 'pieza503-test-key' },
      nowMsFn: () => 1_795_000_000_000,
      fetchFn: (url: string) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve(
              url.includes('/cores')
                ? {
                    data: [
                      {
                        ticker: 'SPY',
                        tradeDate: '2026-11-20',
                        stockPrice: 600,
                        smvVol: 35.82,
                        iv10d: 34.0,
                        iv20d: 35.82,
                        iv30d: 0.365,
                        iv60d: 0.37,
                        iv90d: 0.38,
                        iv6m: 0.39,
                        iv1y: 0.4,
                        exErnIv10d: 33.0,
                        exErnIv20d: 35.82,
                        exErnIv30d: 35.82,
                        exErnIv60d: 0.36,
                        exErnIv90d: 0.37,
                        fwd30_20: 37.5,
                        fwd60_30: 0.38,
                        fwd90_60: 0.39,
                        impliedMove: 5.4,
                        annIdiv: 1.0,
                        impliedNextDiv: 0.25,
                        borrow30: -6.2,
                        yieldRate: 12.5,
                      },
                    ],
                  }
                : { data: [] },
            ),
          text: () => Promise.resolve('{}'),
        }),
    });
    const surface = await client.fetchHybridSurface({
      ticker: 'SPY',
      massiveSpotPrice: 600,
      massiveSpotSourceMode: 'MASSIVE_NBBO',
      yangZhangAdrVol: 0.3,
      forceRefresh: true,
    });
    expect(surface.status).toBe('OPERATIONAL');
    if (surface.status === 'OPERATIONAL') {
      expectClose(surface.iv20d, 0.3582);
      expectClose(surface.exErnIv30d, 0.3582);
      expectClose(surface.smvVol, 0.3582);
      expectClose(surface.impliedMove, 0.054);
      expectClose(surface.borrow30, -0.062);
      expectClose(surface.yieldRate, 0.125);
      expectClose(oratsVolToPct(surface.iv20d), 35.82); // jamás 3582.
      expectClose(oratsVolToPct(surface.impliedMove), 5.4);
    }
  });
});

// ---------------------------------------------------------------------------
// 3) American Deep ITM/OTM + FD adaptativo + cap IV
// ---------------------------------------------------------------------------

describe('Pieza 50.3 — American deep ITM/OTM exacto, dS adaptativo corto y cap IV', () => {
  it('valida los casos deep y el FD adaptativo contra la referencia Python', () => {
    for (const c of fixture.americanDeepAndAdaptiveCases.deepGreeks) {
      const input = {
        spot: c.input.spot,
        strike: c.input.strike,
        timeToExpiry: c.input.t,
        rate: c.input.rate,
        dividendYield: c.input.q,
        volatility: c.input.sigma,
        contractType: c.input.contractType,
      };
      const greeks = greeksAmericanFiniteDiffOrAnalytical(input);
      expectClose(greeks.price, c.expected.price);
      expectClose(greeks.delta, c.expected.delta);
      expectClose(greeks.gamma, c.expected.gamma);
      expectClose(greeks.theta, c.expected.theta);
      expectClose(greeks.thetaDaily, c.expected.thetaDaily);
      expectClose(greeks.vega, c.expected.vega);
      expectClose(greeks.vegaPer1Pct, c.expected.vegaPer1Pct);
      expectClose(greeks.rho, c.expected.rho);
      expectClose(greeks.vanna, c.expected.vanna);
      expectClose(greeks.charm, c.expected.charm);
      expect(gammaAmericanFiniteDiffOrAnalytical(input), c.name).toBe(greeks.gamma);
    }

    const adaptive = fixture.americanDeepAndAdaptiveCases.adaptiveShortDte;
    const input = {
      spot: adaptive.input.spot,
      strike: adaptive.input.strike,
      timeToExpiry: adaptive.input.t,
      rate: adaptive.input.rate,
      dividendYield: adaptive.input.q,
      volatility: adaptive.input.sigma,
      contractType: adaptive.input.contractType,
    };
    const greeks = greeksAmericanFiniteDiffOrAnalytical(input);
    expectClose(greeks.price, adaptive.expected.price);
    expectClose(greeks.delta, adaptive.expected.delta);
    expectClose(greeks.theta, adaptive.expected.theta);
    expectClose(greeks.thetaDaily, adaptive.expected.thetaDaily);
    // FD con denominadores chicos (2·hV = 4,4e-5, dS², 4·dS·dσ) amplifican las
    // diferencias BVN Simpson↔Genz (~1e-13 de precio) a ~2e-7: tolerancia documentada
    // 1e-6, idéntica al criterio de tests/optionsAmerican.test.ts para 2º orden FD.
    expectClose(greeks.vega, adaptive.expected.vega, SECOND_ORDER_TOL);
    expectClose(greeks.vegaPer1Pct, adaptive.expected.vegaPer1Pct, SECOND_ORDER_TOL);
    expectClose(greeks.rho, adaptive.expected.rho, SECOND_ORDER_TOL);
    expectClose(greeks.gamma, adaptive.expected.gamma, SECOND_ORDER_TOL);
    expectClose(greeks.vanna, adaptive.expected.vanna, SECOND_ORDER_TOL);
    expectClose(greeks.charm, adaptive.expected.charm, SECOND_ORDER_TOL);
    expect(gammaAmericanFiniteDiffOrAnalytical(input)).toBe(greeks.gamma);
    expect(Math.abs(adaptive.input.dS)).toBeGreaterThan(0);

    for (const c of fixture.americanDeepAndAdaptiveCases.ivCapCases) {
      const sanitized = sanitizeContractIv(c.iv, c.extrinsic);
      if (c.expected === null) expect(sanitized, c.name).toBeNull();
      else expectClose(sanitized ?? Number.NaN, c.expected);
    }
  });

  it('integración MarketRuntime: Put deep ITM con IV explosiva jamás devuelve Delta -0.66 ni IV 1.000%', async () => {
    const nowSec = Math.floor(Date.UTC(2026, 0, 5, 20, 30, 0) / 1_000); // 2026-01-05 15:30 ET
    const spot = 600;
    const chainStrikes: readonly number[] = Array.from({ length: 45 }, (_, i) => 430 + i * 10);
    const occ = (date: string, type: 'call' | 'put', strike: number): string =>
      `O:SPY${date.replaceAll('-', '').slice(2)}${type === 'call' ? 'C' : 'P'}${String(
        Math.round(strike * 1_000),
      ).padStart(8, '0')}`;

    const chainRowsForDate = (date: string, dte: number): Record<string, unknown>[] => {
      const rows: Record<string, unknown>[] = [];
      const tYears = Math.max(dte, 0.5) / 365;
      for (const strike of chainStrikes) {
        for (const type of ['call', 'put'] as const) {
          const moneyness = (spot - strike) / spot;
          const sigma = 0.22 + Math.abs(moneyness) * 0.06;
          const fair = priceBsm({
            spot,
            strike,
            timeToExpiry: tYears,
            rate: 0.043,
            dividendYield: 0.012,
            volatility: sigma,
            contractType: type,
          });
          let bid = Number(Math.max(0.05, fair * 0.995).toFixed(4));
          let ask = Number((Math.max(0.05, fair * 1.005) + 0.02).toFixed(4));
          let mid = Number((0.5 * (bid + ask)).toFixed(4));
          let iv = Number(sigma.toFixed(6));
          if (type === 'put' && strike === 680) {
            // Deep ITM con mid por debajo del intrínseco (80.00) e IV proveedor explosiva 4.5.
            bid = 79.7;
            ask = 79.9;
            mid = 79.8;
            iv = 4.5;
          }
          if (type === 'put' && strike === 690) {
            // Deep ITM con IV proveedor capada 9.99 (= 999 %).
            bid = 89.68;
            ask = 89.88;
            mid = 89.78;
            iv = 9.99;
          }
          rows.push({
            details: {
              ticker: occ(date, type, strike),
              contract_type: type,
              strike_price: strike,
              expiration_date: date,
              shares_per_contract: 100,
            },
            day: { volume: 650, close: mid, previousClose: mid, change: 0 },
            open_interest: 8_000,
            implied_volatility: iv,
            last_quote: { bid, ask, midpoint: mid },
            last_trade: { price: mid, sip_timestamp: String(nowSec * 1_000_000_000) },
            underlying_asset: { ticker: 'SPY', price: spot },
          });
        }
      }
      return rows;
    };

    const fetchFn: FetchFn = (url: string) => {
      const parsed = new URL(url);
      const path = parsed.pathname;
      const respond = (payload: unknown) =>
        Promise.resolve({ ok: true, status: 200, text: JSON.stringify(payload), headers: {} });
      if (path.startsWith('/v2/aggs/ticker/')) {
        const segments = path.split('/');
        const ticker = decodeURIComponent(segments[4] ?? 'SPY');
        const timespan = segments[7] ?? 'minute';
        const barSec = timespan === 'day' ? 86_400 : 300;
        const count = timespan === 'day' ? 300 : 200;
        const results: Record<string, unknown>[] = [];
        for (let i = count - 1; i >= 0; i -= 1) {
          const t = Math.floor(nowSec / barSec) * barSec - i * barSec;
          const close = ticker === 'SPY' ? spot : spot * 0.85;
          results.push({ t: t * 1_000, o: close, h: close + 0.4, l: close - 0.4, c: close, v: 120_000, vw: close });
        }
        return respond({ status: 'OK', ticker, resultsCount: results.length, results });
      }
      if (path === '/fed/v1/treasury-yields') {
        return respond({
          status: 'OK',
          results: [
            {
              date: '2026-01-02',
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
        });
      }
      if (path === '/fed/v1/funding-conditions') {
        return respond({
          status: 'OK',
          results: [
            {
              date: '2026-01-02',
              effective_fed_funds_rate: 4.33,
              effective_fed_funds_volume: 95_000_000_000,
              sofr: 4.31,
              sofr_volume: 2_100_000_000_000,
            },
          ],
        });
      }
      if (path === '/v3/snapshot') {
        return respond({
          status: 'OK',
          results: [
            {
              ticker: 'SPY',
              type: 'stocks',
              market_status: 'open',
              last_quote: { P: spot - 0.02, p: spot + 0.02, midpoint: spot },
              last_trade: { p: spot, sip_timestamp: String(nowSec * 1_000_000_000) },
              session: { price: spot, previous_close: 598.5, change: 1.5, change_percent: 0.25 },
              day: { c: spot, v: 40_000_000, o: 598, h: 601, l: 597.5 },
            },
            {
              ticker: 'I:SPX',
              type: 'indices',
              market_status: 'open',
              value: 6000.5,
              session: { price: 6000.5, previous_close: 5975.0, change: 25.5, change_percent: 0.43 },
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
        });
      }
      if (path === '/v3/reference/options/contracts') {
        const exactDate = parsed.searchParams.get('expiration_date');
        const dates = exactDate === null ? ['2026-01-05', '2026-01-06', '2026-02-04'] : [exactDate];
        const rows: Record<string, unknown>[] = [];
        for (const date of dates) {
          for (const strike of [580, 590, 600, 610, 620, 680, 690]) {
            for (const type of ['call', 'put'] as const) {
              rows.push({
                ticker: occ(date, type, strike),
                underlying_ticker: 'SPY',
                contract_type: type,
                strike_price: strike,
                expiration_date: date,
                shares_per_contract: 100,
              });
            }
          }
        }
        return respond({ status: 'OK', results: rows });
      }
      if (path.startsWith('/v3/snapshot/options/')) {
        const exactDate = parsed.searchParams.get('expiration_date');
        const date = exactDate ?? '2026-01-05';
        const dte = date === '2026-01-05' ? 0 : date === '2026-01-06' ? 1 : 30;
        return respond({ status: 'OK', results: chainRowsForDate(date, dte) });
      }
      if (path === '/stocks/v1/dividends') {
        return respond({ status: 'OK', results: [] });
      }
      if (path === '/options/v1/unusual-trades') {
        return respond({ status: 'OK', results: [] });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        text: JSON.stringify({ status: 'NOT_FOUND', error: `Unexpected test URL ${path}` }),
        headers: {},
      });
    };

    const runtime = new MarketRuntime({
      apiKey: 'pieza503-test-key',
      secrets: ['pieza503-test-key'],
      nowMsFn: () => nowSec * 1_000,
      enableWs: false,
      fetchFn,
    });

    const response: UsOptionExpiryChainResponse = await runtime.getUsOptionExpiryChain(
      'SPY',
      '2026-01-06',
    );
    const deepRow = response.contracts.find((row) => row.strike === 680 && row.contractType === 'put');
    const cappedRow = response.contracts.find((row) => row.strike === 690 && row.contractType === 'put');
    expect(deepRow).toBeDefined();
    expect(cappedRow).toBeDefined();
    for (const row of [deepRow, cappedRow]) {
      if (row === undefined) throw new Error('fila deep ITM ausente');
      expect(row.ownIv, row.ticker).toBeNull();
      expect(row.providerIv, row.ticker).toBeNull();
      expect(row.ivSource, row.ticker).toBe('NONE');
      expect(row.delta, row.ticker).toBe(-1);
      expect(row.gamma, row.ticker).toBe(0);
      expect(row.vegaPer1Pct, row.ticker).toBe(0);
      expect(row.thetaDaily, row.ticker).toBe(0);
    }
    // Sanidad: una fila normal sí conserva IV/griegas finitas.
    const normalRow = response.contracts.find((row) => row.strike === 600 && row.contractType === 'put');
    expect(normalRow).toBeDefined();
    if (normalRow !== undefined) {
      expect(Number.isFinite(normalRow.delta ?? Number.NaN)).toBe(true);
      expect(normalRow.providerIv !== null || normalRow.ownIv !== null).toBe(true);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 4) Buy-Write & Cobertura Sintética: gate DTE < 3
// ---------------------------------------------------------------------------

describe('Pieza 50.3 — Buy-Write y Cobertura Sintética con gate DTE < 3', () => {
  it('valida la referencia Python (bloqueos DTE 0/1/2, frontera 3/365 y 30 DTE en %)', () => {
    for (const c of fixture.buyWriteCases) {
      const result = evaluateBuyWrite(c.input);
      expect(result.status, c.name).toBe('OK');
      expect(result.rateStatus, c.name).toBe(c.expected.rateStatus);
      expectClose(result.totalFeesPerShare, c.expected.totalFeesPerShare);
      expectClose(result.netCostBasis, c.expected.netCostBasis);
      expectClose(result.breakevenPrice, c.expected.breakevenPrice);
      expectClose(result.downsideProtectionPct, c.expected.downsideProtectionPct);
      expectClose(result.staticProfitPerShare, c.expected.staticProfitPerShare);
      expectClose(result.staticReturnPct, c.expected.staticReturnPct);
      expectClose(result.maxAssignedProfitPerShare, c.expected.maxAssignedProfitPerShare);
      expectClose(result.maxAssignedReturnPct, c.expected.maxAssignedReturnPct);
      expectNumberOrNaN(result.staticAnnualizedTna, c.expected.staticAnnualizedTna);
      expectNumberOrNaN(result.assignedAnnualizedTna, c.expected.assignedAnnualizedTna);
      if (c.expected.annualizedRate === null) {
        expect(result.annualizedRate, c.name).toBeNull();
      } else {
        expectClose(result.annualizedRate ?? Number.NaN, c.expected.annualizedRate);
      }
      if (c.expected.rateStatus === 'BLOCKED_SHORT_DTE') {
        expect(Number.isNaN(result.staticAnnualizedTna)).toBe(true);
        expect(Number.isNaN(result.assignedAnnualizedTna)).toBe(true);
      } else {
        // Unidades % preservadas: jamás 22.890,9% por doble * 100.
        expect(Math.abs(result.staticAnnualizedTna)).toBeLessThan(1_000);
      }
    }
  });

  it('valida la referencia Python de Conversión/Reversión (rateStatus y señales)', () => {
    for (const c of fixture.conversionReversalCases) {
      const result = evaluateConversionReversal(c.input);
      expect(result.status, c.name).toBe('OK');
      expect(result.rateStatus, c.name).toBe(c.expected.rateStatus);
      expect(result.arbitrageSignal, c.name).toBe(c.expected.arbitrageSignal);
      expectClose(result.conversionNetCost, c.expected.conversionNetCost);
      expectClose(result.reversalNetProceeds, c.expected.reversalNetProceeds);
      expectClose(result.shortBorrowCost, c.expected.shortBorrowCost);
      expectClose(result.reversalTerminalObligation, c.expected.reversalTerminalObligation);
      expectNumberOrNaN(result.conversionAnnualizedTna, c.expected.conversionAnnualizedTna);
      expectNumberOrNaN(result.conversionEdgeVsRiskFreeBps, c.expected.conversionEdgeVsRiskFreeBps);
      expectNumberOrNaN(result.reversalAnnualizedTna, c.expected.reversalAnnualizedTna);
      expectNumberOrNaN(result.reversalEdgeVsRiskFreeBps, c.expected.reversalEdgeVsRiskFreeBps);
      expectNumberOrNaN(result.netEdgeVsRiskFreeBps, c.expected.netEdgeVsRiskFreeBps);
    }
  });

  it('integración MarketRuntime: /api/options/expiry 30 DTE con Buy-Write/Cobertura propios aunque el front sea 0DTE', async () => {
    const nowSec = Math.floor(Date.UTC(2026, 0, 5, 20, 30, 0) / 1_000);
    const spot = 600;
    const chainStrikes: readonly number[] = [560, 580, 590, 600, 610, 620, 630, 640];
    const occ = (date: string, type: 'call' | 'put', strike: number): string =>
      `O:SPY${date.replaceAll('-', '').slice(2)}${type === 'call' ? 'C' : 'P'}${String(
        Math.round(strike * 1_000),
      ).padStart(8, '0')}`;
    const chainRowsForDate = (date: string, dte: number): Record<string, unknown>[] => {
      const rows: Record<string, unknown>[] = [];
      const tYears = Math.max(dte, 0.5) / 365;
      for (const strike of chainStrikes) {
        for (const type of ['call', 'put'] as const) {
          const moneyness = (spot - strike) / spot;
          const sigma = 0.22 + Math.abs(moneyness) * 0.06;
          const fair = priceBsm({
            spot,
            strike,
            timeToExpiry: tYears,
            rate: 0.043,
            dividendYield: 0.012,
            volatility: sigma,
            contractType: type,
          });
          const bid = Number(Math.max(0.05, fair * 0.995).toFixed(4));
          const ask = Number((Math.max(0.05, fair * 1.005) + 0.02).toFixed(4));
          const mid = Number((0.5 * (bid + ask)).toFixed(4));
          rows.push({
            details: {
              ticker: occ(date, type, strike),
              contract_type: type,
              strike_price: strike,
              expiration_date: date,
              shares_per_contract: 100,
            },
            day: { volume: 650, close: mid, previousClose: mid, change: 0 },
            open_interest: 8_000,
            implied_volatility: Number(sigma.toFixed(6)),
            last_quote: { bid, ask, midpoint: mid },
            last_trade: { price: mid, sip_timestamp: String(nowSec * 1_000_000_000) },
            underlying_asset: { ticker: 'SPY', price: spot },
          });
        }
      }
      return rows;
    };
    const fetchFn: FetchFn = (url: string) => {
      const parsed = new URL(url);
      const path = parsed.pathname;
      const respond = (payload: unknown) =>
        Promise.resolve({ ok: true, status: 200, text: JSON.stringify(payload), headers: {} });
      if (path.startsWith('/v2/aggs/ticker/')) {
        const segments = path.split('/');
        const ticker = decodeURIComponent(segments[4] ?? 'SPY');
        const timespan = segments[7] ?? 'minute';
        const barSec = timespan === 'day' ? 86_400 : 300;
        const count = timespan === 'day' ? 300 : 200;
        const results: Record<string, unknown>[] = [];
        for (let i = count - 1; i >= 0; i -= 1) {
          const t = Math.floor(nowSec / barSec) * barSec - i * barSec;
          const close = ticker === 'SPY' ? spot : spot * 0.85;
          results.push({ t: t * 1_000, o: close, h: close + 0.4, l: close - 0.4, c: close, v: 120_000, vw: close });
        }
        return respond({ status: 'OK', ticker, resultsCount: results.length, results });
      }
      if (path === '/fed/v1/treasury-yields') {
        return respond({
          status: 'OK',
          results: [
            {
              date: '2026-01-02',
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
        });
      }
      if (path === '/fed/v1/funding-conditions') {
        return respond({
          status: 'OK',
          results: [
            {
              date: '2026-01-02',
              effective_fed_funds_rate: 4.33,
              effective_fed_funds_volume: 95_000_000_000,
              sofr: 4.31,
              sofr_volume: 2_100_000_000_000,
            },
          ],
        });
      }
      if (path === '/v3/snapshot') {
        return respond({
          status: 'OK',
          results: [
            {
              ticker: 'SPY',
              type: 'stocks',
              market_status: 'open',
              last_quote: { P: spot - 0.02, p: spot + 0.02, midpoint: spot },
              last_trade: { p: spot, sip_timestamp: String(nowSec * 1_000_000_000) },
              session: { price: spot, previous_close: 598.5, change: 1.5, change_percent: 0.25 },
              day: { c: spot, v: 40_000_000, o: 598, h: 601, l: 597.5 },
            },
            {
              ticker: 'I:SPX',
              type: 'indices',
              market_status: 'open',
              value: 6000.5,
              session: { price: 6000.5, previous_close: 5975.0, change: 25.5, change_percent: 0.43 },
            },
            {
              ticker: 'I:VIX',
              type: 'indices',
              market_status: 'open',
              value: 16.4,
              session: { price: 16.4, previous_close: 16.9, change: -0.5, change_percent: -2.96 },
            },
          ],
        });
      }
      if (path === '/v3/reference/options/contracts') {
        const exactDate = parsed.searchParams.get('expiration_date');
        const dates = exactDate === null ? ['2026-01-05', '2026-02-04'] : [exactDate];
        const rows: Record<string, unknown>[] = [];
        for (const date of dates) {
          for (const strike of chainStrikes) {
            for (const type of ['call', 'put'] as const) {
              rows.push({
                ticker: occ(date, type, strike),
                underlying_ticker: 'SPY',
                contract_type: type,
                strike_price: strike,
                expiration_date: date,
                shares_per_contract: 100,
              });
            }
          }
        }
        return respond({ status: 'OK', results: rows });
      }
      if (path.startsWith('/v3/snapshot/options/')) {
        const exactDate = parsed.searchParams.get('expiration_date');
        const date = exactDate ?? '2026-01-05';
        return respond({ status: 'OK', results: chainRowsForDate(date, date === '2026-01-05' ? 0 : 30) });
      }
      if (path === '/stocks/v1/dividends') {
        return respond({ status: 'OK', results: [] });
      }
      if (path === '/options/v1/unusual-trades') {
        return respond({ status: 'OK', results: [] });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        text: JSON.stringify({ status: 'NOT_FOUND', error: `Unexpected test URL ${path}` }),
        headers: {},
      });
    };

    const runtime = new MarketRuntime({
      apiKey: 'pieza503-test-key',
      secrets: ['pieza503-test-key'],
      nowMsFn: () => nowSec * 1_000,
      enableWs: false,
      fetchFn,
    });

    const front: UsOptionExpiryChainResponse = await runtime.getUsOptionExpiryChain('SPY', '2026-01-05');
    expect(front.daysToExpiry).toBe(0);
    expect(front.buyWrite?.rateStatus).toBe('BLOCKED_SHORT_DTE');
    expect(front.conversionReversal?.rateStatus).toBe('BLOCKED_SHORT_DTE');
    expect(Number.isFinite(front.buyWrite?.staticAnnualizedTna ?? Number.NaN)).toBe(false);
    expect(Number.isFinite(front.conversionReversal?.conversionAnnualizedTna ?? Number.NaN)).toBe(false);

    const thirty: UsOptionExpiryChainResponse = await runtime.getUsOptionExpiryChain('SPY', '2026-02-04');
    expect(thirty.daysToExpiry).toBe(30);
    expect(thirty.buyWrite?.rateStatus).toBe('OK');
    expect(thirty.conversionReversal?.rateStatus).toBe('OK');
    expect(Number.isFinite(thirty.buyWrite?.staticAnnualizedTna ?? Number.NaN)).toBe(true);
    expect(Number.isFinite(thirty.conversionReversal?.conversionAnnualizedTna ?? Number.NaN)).toBe(true);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 5) 0DTE y Ratios 1x2 σ-escalados
// ---------------------------------------------------------------------------

describe('Pieza 50.3 — 0DTE (0DTE y jamás 1d) y ratios 1x2 σ-escalados', () => {
  it('formatea DTE 0 → 0DTE, 1 → 1d, 30 → 30d y NaN → —', () => {
    for (const c of fixture.zeroDteAndRatiosSigmaCases.dteLabels) {
      expect(formatDteLabel(c.dte === null ? Number.NaN : c.dte), String(c.dte)).toBe(c.expected);
    }
    expect(formatDteLabel(0)).toBe('0DTE');
    expect(formatDteLabel(1)).toBe('1d');
  });

  it('mapUsSnapshotToArOptions conserva days = 0 y etiqueta (0DTE) sin pasar por 1d', () => {
    const asOfUtcSec = Math.floor(Date.UTC(2026, 10, 21, 21, 0, 0) / 1_000); // sábado 16:00 ET
    const row = (date: string, strike: number, type: 'call' | 'put'): UsOptionContractRowDto => ({
      ticker: `O:SPY${date.replaceAll('-', '').slice(2)}${type === 'call' ? 'C' : 'P'}${String(strike * 1_000).padStart(8, '0')}`,
      contractType: type,
      strike,
      expirationDate: date,
      expiryUtcSec: Math.floor(Date.UTC(2026, 10, 21, 21, 0, 0) / 1_000),
      bid: 5,
      ask: 5.2,
      mid: 5.1,
      lastPrice: 5.1,
      openInterest: 1_000,
      volume: 100,
      previousClose: 5,
      changePct: 2,
      ownIv: 0.2,
      providerIv: 0.2,
      ivSource: 'OWN',
      delta: 0.5,
      gamma: 0.01,
      thetaDaily: -0.02,
      vegaPer1Pct: 0.1,
      vanna: 0,
      charm: 0,
    });
    const basePayload = (expiryDate: string, withSlice: boolean): UsSnapshotResponseDto =>
      ({
        status: 'PARTIAL',
        feedMode: 'LIVE',
        quoteMode: 'LIVE_NBBO',
        symbol: 'SPY',
        isIndex: false,
        asOfUtcSec,
        envelope: { snapshot: { metrics: { spot: 600 } } },
        marketContext: {
          unifiedQuotes: [
            {
              ticker: 'SPY',
              assetType: 'stock',
              price: 600,
              change: 1,
              changePct: 0.15,
              previousClose: 599,
              dayLow: 598.5,
              dayHigh: 601,
              dayRangePos: 0.6,
              volumeM: 40,
              iv30d: 0.2,
              marketStatus: 'open',
              volume: 40_000_000,
            },
          ],
        },
        volSurfaceSummary: {
          iv30d: 0.2,
          frontSlice: null,
          slices: withSlice
            ? [
                {
                  expirationDate: expiryDate,
                  expirySec: Math.floor(Date.UTC(2026, 10, 21, 21, 0, 0) / 1_000),
                  rate: 0.04,
                  ivAtm: 0.2,
                  timeToExpiryDays: 0,
                },
              ]
            : [],
          contracts: [580, 600, 620].flatMap((strike) =>
            (['call', 'put'] as const).map((type) => row(expiryDate, strike, type)),
          ),
        },
      }) as unknown as UsSnapshotResponseDto;

    // Caso A: vencimiento HOY ET con slice → 0DTE.
    const todayMapped = mapUsSnapshotToArOptions('SPY', basePayload('2026-11-21', true));
    expect(todayMapped.expiries[0]?.days).toBe(0);
    expect(todayMapped.expiries[0]?.expiryLabel).toBe('2026-11-21 (0DTE)');
    expect(todayMapped.expiries[0]?.expiryLabel.includes('1d')).toBe(false);

    // Caso B: fecha pasada (DTE ET no resoluble) con fallback por timestamp (~1 h) → days = 0.
    const fallbackMapped = mapUsSnapshotToArOptions('SPY', basePayload('2026-11-20', false));
    expect(fallbackMapped.expiries[0]?.days).toBe(0);
    expect(fallbackMapped.expiries[0]?.expiryLabel).toBe('2026-11-20 (0DTE)');
    expect(fallbackMapped.expiries[0]?.expiryLabel.includes('1d')).toBe(false);

    // Compatibilidad con el binding 0DTE de Pieza 50.2 (contrato intacto).
    const tir = evaluateActiveExpiryHeaderTir({
      activeDte: 0,
      activeExpiryId: '2026-11-21',
      activeParity: null,
      activeExpirySyntheticRates: null,
    });
    expect(tir.blockedShortDte).toBe(true);
    expect(Number.isNaN(tir.tirPct)).toBe(true);
    const regime = evaluateActiveExpiryRegimeAndBreaker({
      activeDte: 0,
      activeExpiryId: '2026-11-21',
      spot: 600,
      activeExposureSummary: { putWallStrike: null, netGex: Number.NaN },
      precomputedRegimeForActiveExpiry: null,
      fallbackRegimeInput: { ivAtmActiveExpiryPct: 45, rvReferencePct: 20, rvReferenceLabel: 'RV23d' },
    });
    expect(regime.blocked).toBe(true);
    expect(regime.autoSelectCreditMode).toBe(false);
    expect(regime.activeRegimeCode).toBe('NO_SHORT_PREMIUM_RISK');
  });

  it('valida los ratios σ-escalados (0.5σ/1.0σ/1.5σ) y el filtro estricto de prima > 0.01', () => {
    expect(MIN_RATIO_SHORT_LEG_PREMIUM).toBe(0.01);
    expect([...RATIO_SIGMA_MULTIPLIERS]).toEqual([0.5, 1.0, 1.5]);
    for (const c of fixture.zeroDteAndRatiosSigmaCases.ratiosCases) {
      const result: RatiosAndStructureCostsResult = computeRatiosAndStructureCosts(c.input);
      expect(result.callRatios.length, c.name).toBe(c.expected.callRatios.length);
      expect(result.putRatios.length, c.name).toBe(c.expected.putRatios.length);
      const compareRows = (
        actual: RatiosAndStructureCostsResult['callRatios'],
        expected: readonly RatioRowJson[],
      ): void => {
        actual.forEach((row, idx) => {
          const er = expected[idx];
          if (er === undefined) throw new Error(`fila extra en ${c.name}`);
          expect(row.side, c.name).toBe(er.side);
          expectClose(row.targetOffsetPct, er.targetOffsetPct);
          expect(row.longStrike, c.name).toBe(er.longStrike);
          expectClose(row.longPrice, er.longPrice);
          expect(row.shortStrike, c.name).toBe(er.shortStrike);
          expectClose(row.shortPrice, er.shortPrice);
          expectClose(row.otmLotsPerBought, er.otmLotsPerBought);
          expectClose(row.netCash1x2, er.netCash1x2);
          expectClose(row.outerBreakeven1x2, er.outerBreakeven1x2);
          // Filtro estricto: ninguna pata corta/larga $0.00/$0.01.
          expect(row.shortPrice).toBeGreaterThan(MIN_RATIO_SHORT_LEG_PREMIUM);
          expect(row.longPrice).toBeGreaterThan(MIN_RATIO_SHORT_LEG_PREMIUM);
        });
      };
      compareRows(result.callRatios, c.expected.callRatios);
      compareRows(result.putRatios, c.expected.putRatios);
    }
  });

  it('sin `ivAtmDec` conserva los offsets fijos [5, 10, 15] / [-5, -10, -15] (compatibilidad Pieza 27)', () => {
    const caseInput = fixture.zeroDteAndRatiosSigmaCases.ratiosCases[1]?.input;
    if (caseInput === undefined) throw new Error('fixture ratiosCases[1] ausente');
    const withoutSigma = computeRatiosAndStructureCosts({
      spot: caseInput.spot,
      daysToExpiry: caseInput.daysToExpiry,
      rate: caseInput.rate,
      dividendYield: caseInput.dividendYield,
      strikes: caseInput.strikes,
    });
    expect(withoutSigma.callRatios.length).toBeGreaterThan(0);
    expect(withoutSigma.putRatios.length).toBeGreaterThan(0);
    for (const row of withoutSigma.callRatios) {
      expect([5, 10, 15]).toContain(row.targetOffsetPct);
    }
    for (const row of withoutSigma.putRatios) {
      expect([-5, -10, -15]).toContain(row.targetOffsetPct);
    }
  });
});
