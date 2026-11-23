/**
 * Pieza P1 Q3 + Q4 — Integridad contractual de Opciones US (estilo de ejercicio OPRA),
 * consistencia matemática end-to-end (BSM europeo / BS2002 & CRR-1200 americano / UNKNOWN fail-closed)
 * y superficies de volatilidad fail-closed sin BBOs sintéticos.
 *
 * Oráculo independiente: `fixtures/pieza_q3_q4_reference.json` generado por
 * `tools/gen_pieza_q3_q4_reference.py` (`Decimal` prec=50, BSM `math.erfc`, CRR-1200, BS2002 Simpson-8000).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  priceAmericanBjerksund2002,
  priceAmericanCrrDiscrete,
  greeksAmericanFiniteDiffOrAnalytical,
} from '../src/core/options/american.js';
import { solveImpliedVolAmericanDetailed } from '../src/core/options/americanIvDiagnostics.js';
import { greeksBsm, priceBsm } from '../src/core/options/blackScholes.js';
import {
  CANONICAL_OPRA_ROOT_SPECS,
  extractOpraContractRoot,
  resolveUsOptionContractIdentity,
} from '../src/core/options/contractStyle.js';
import { computeDealerExposure, type ExposureContractInput } from '../src/core/options/exposure.js';
import {
  computeSignedOptionsOrderFlow,
  detectVolOiAnomaliesMad,
  type OpraTradePrintInput,
  type VolOiAnomalyContractInput,
} from '../src/core/options/optionsOrderFlow.js';
import {
  buildVolSlice,
  buildVolSurface,
  validateSliceButterflyArbitrage,
  validateSurfaceCalendarArbitrage,
} from '../src/core/options/volSurface.js';
import type { OptionSnapshotContract } from '../src/data/optionsTypes.js';
import type { FetchFn, FetchResponse } from '../src/data/types.js';
import { createHttpWsServer, type HttpWsServerHandle } from '../src/server/httpWsServer.js';
import { ArgentinaMarketRuntime } from '../src/server/argentinaMarketLoader.js';
import { GgalSpecialistRuntime } from '../src/server/ggalSpecialistRuntime.js';
import {
  MarketRuntime,
  resolveQuoteMidForPolicy,
  resolveUsOptionsSessionPolicy,
  solveContractOwnIvDetailed,
  type TerminalSnapshotResponse,
  type UsOptionExpiryChainResponse,
} from '../src/server/marketRuntime.js';
import { mapUsSnapshotToArOptions } from '../web/src/data/expiryChainMerge.js';
import type { UsSnapshotResponseDto } from '../web/src/data/liveTypes.js';

interface GreeksRefJson {
  readonly price: number;
  readonly delta: number;
  readonly gamma: number;
  readonly theta: number;
  readonly thetaDaily: number;
  readonly vega: number;
  readonly vegaPer1Pct: number;
  readonly rho?: number;
  readonly vanna: number;
  readonly charm: number;
}

interface Q4SliceRowJson {
  readonly strike: number;
  readonly iv: number;
  readonly callFairEur: number;
  readonly putFairEur: number;
  readonly callFairAmr: number;
  readonly putFairAmr: number;
  readonly callBidEur: number;
  readonly callAskEur: number;
  readonly putBidEur: number;
  readonly putAskEur: number;
  readonly callBidAmr: number;
  readonly callAskAmr: number;
  readonly putBidAmr: number;
  readonly putAskAmr: number;
}

interface Q3Q4FixtureJson {
  readonly q3: {
    readonly canonical_oex_put: {
      readonly spot: number;
      readonly strike: number;
      readonly timeToExpiry: number;
      readonly rate: number;
      readonly dividendYield: number;
      readonly bid: number;
      readonly ask: number;
      readonly mid: number;
      readonly belowIntrinsicMid: number;
      readonly europeanLowerBound: number;
      readonly europeanUpperBound: number;
      readonly americanImmediateIntrinsic: number;
      readonly americanLowerBound: number;
      readonly americanUpperBound: number;
      readonly ivBsm: number;
      readonly ivCrr1200: number;
      readonly ivBs02: number;
      readonly crr1200PriceAtBsmIv: number;
      readonly overpricingCrrAtBsmIv: number;
      readonly crr1200PriceAtBs02Iv: number;
      readonly bs02PriceAtBs02Iv: number;
      readonly bs02RepricingErrorRelAtBsmIv: number;
      readonly bs02Greeks: GreeksRefJson;
      readonly crr1200Greeks: GreeksRefJson;
      readonly bsmGreeks: GreeksRefJson;
    };
    readonly atm_fallback_oex_vs_xeo: {
      readonly atmIv: number;
      readonly oexBs02Greeks: GreeksRefJson;
      readonly xeoBsmGreeks: GreeksRefJson;
    };
    readonly merton_and_dividend_call: {
      readonly mertonZeroDiv: {
        readonly spot: number;
        readonly strike: number;
        readonly timeToExpiry: number;
        readonly rate: number;
        readonly dividendYield: number;
        readonly sigma: number;
        readonly priceBsm: number;
        readonly priceBs02: number;
        readonly priceCrr1200: number;
      };
      readonly highDivEarlyExerciseCall: {
        readonly spot: number;
        readonly strike: number;
        readonly timeToExpiry: number;
        readonly rate: number;
        readonly dividendYield: number;
        readonly mid: number;
        readonly priceAmrAt030: number;
        readonly priceEurAt030: number;
        readonly ivBsm: number;
        readonly ivBs02: number;
        readonly ivCrr1200: number;
        readonly bs02Greeks: GreeksRefJson;
      };
    };
  };
  readonly q4: {
    readonly spot: number;
    readonly rate: number;
    readonly dividendYield: number;
    readonly t1: number;
    readonly t2: number;
    readonly strikes: readonly number[];
    readonly rthValidTwoSliceFlat: {
      readonly ivFlat: number;
      readonly forwardT1: number;
      readonly forwardT2: number;
      readonly totalVarianceT1: number;
      readonly totalVarianceT2: number;
      readonly minDurrlemanT1: number;
      readonly minDurrlemanT2: number;
      readonly sliceT1: readonly Q4SliceRowJson[];
      readonly sliceT2: readonly Q4SliceRowJson[];
    };
    readonly mildSkewArbitrageFree: {
      readonly strikes: readonly number[];
      readonly ivsT1: readonly number[];
      readonly ivsT2: readonly number[];
      readonly minDurrlemanT1: number;
      readonly minDurrlemanT2: number;
    };
    readonly butterflyViolation: {
      readonly strikes: readonly number[];
      readonly ivs: readonly number[];
      readonly forward: number;
      readonly t: number;
      readonly minDurrleman: number;
      readonly expectedStatus: 'FAIL';
    };
    readonly calendarViolation: {
      readonly strikes: readonly number[];
      readonly ivsT1: readonly number[];
      readonly ivsT2: readonly number[];
      readonly t1: number;
      readonly t2: number;
      readonly minVarianceDiff: number;
      readonly expectedStatus: 'FAIL';
    };
  };
}

const fixture = JSON.parse(
  readFileSync(join(process.cwd(), 'fixtures', 'pieza_q3_q4_reference.json'), 'utf-8'),
) as Q3Q4FixtureJson;

function expectMatchTol(actual: number | null | undefined, expected: number, tol: number, label: string): void {
  expect(actual, `${label} should not be null/undefined`).not.toBeNull();
  expect(actual, `${label} should be defined`).toBeDefined();
  const num = actual as number;
  expect(Number.isFinite(num), `${label} should be finite`).toBe(true);
  const scale = Math.abs(expected) >= 1 ? Math.abs(expected) : 1;
  const err = Math.abs(num - expected) / scale;
  expect(
    err,
    `${label}: actual=${String(num)}, expected=${String(expected)}, err=${String(err)} > tol=${String(tol)}`,
  ).toBeLessThanOrEqual(tol);
}

function makeSnapshotContract(opts: {
  readonly ticker: string;
  readonly contractType: 'call' | 'put';
  readonly strike: number;
  readonly expirationDate: string;
  readonly expiryUtcSec: number;
  readonly underlyingTicker: string;
  readonly spot: number;
  readonly bid: number;
  readonly ask: number;
  readonly midpoint?: number;
  readonly dayClose?: number;
  readonly lastTradePrice?: number;
  readonly iv?: number;
  readonly openInterest?: number;
  readonly volume?: number;
  readonly exerciseStyle?: 'american' | 'european' | null;
  readonly updatedAt?: number;
  readonly quoteQuality?: OptionSnapshotContract['lastQuote']['quoteQuality'];
}): OptionSnapshotContract {
  const bid = opts.bid;
  const ask = opts.ask;
  const midpoint =
    opts.midpoint ??
    (Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask >= bid ? 0.5 * (bid + ask) : Number.NaN);
  const ts = opts.updatedAt ?? 1_792_089_000;
  return {
    ticker: opts.ticker,
    contractType: opts.contractType,
    exerciseStyle: opts.exerciseStyle ?? null,
    expirationDate: opts.expirationDate,
    expirationTime: opts.expiryUtcSec,
    strikePrice: opts.strike,
    sharesPerContract: 100,
    breakEvenPrice: Number.NaN,
    impliedVolatility: opts.iv ?? Number.NaN,
    openInterest: opts.openInterest ?? 500,
    greeks: { delta: Number.NaN, gamma: Number.NaN, theta: Number.NaN, vega: Number.NaN },
    greeksMissing: true,
    day: {
      open: opts.dayClose ?? Number.NaN,
      high: opts.dayClose ?? Number.NaN,
      low: opts.dayClose ?? Number.NaN,
      close: opts.dayClose ?? Number.NaN,
      volume: opts.volume ?? 120,
      vwap: opts.dayClose ?? Number.NaN,
      previousClose: opts.dayClose ?? Number.NaN,
      change: 0,
      changePercent: 0,
      updatedAt: ts,
    },
    lastQuote: {
      ...(opts.quoteQuality !== undefined ? { quoteQuality: opts.quoteQuality } : {}),
      bid,
      ask,
      midpoint,
      bidSize: bid > 0 ? 10 : Number.NaN,
      askSize: ask > 0 ? 10 : Number.NaN,
      bidExchange: 1,
      askExchange: 1,
      updatedAt: ts,
      timeframe: null,
    },
    lastTrade: {
      price: opts.lastTradePrice ?? Number.NaN,
      size: opts.volume ?? 10,
      exchange: 1,
      conditions: [],
      sipTimestamp: ts,
      timeframe: null,
    },
    underlyingAsset: {
      ticker: opts.underlyingTicker,
      price: opts.spot,
      sourceField: 'price',
      changeToBreakEven: 0,
      updatedAt: ts,
      timeframe: 'REAL-TIME',
    },
    additionalUnderlyings: [],
    isBinary: false,
    isAdjusted: false,
    isNonStandard: false,
  };
}

interface MockRawContractSpec {
  readonly ticker: string;
  readonly contractType: 'call' | 'put';
  readonly strike: number;
  readonly expirationDate: string;
  readonly exerciseStyle: 'american' | 'european' | null;
  readonly underlyingTicker: string;
  readonly bid: number;
  readonly ask: number;
  readonly dayClose?: number;
  readonly lastTradePrice?: number;
  readonly impliedVolatility?: number;
  readonly volume?: number;
  readonly openInterest?: number;
}

function createOfflineMassiveFetch(params: {
  readonly symbol: string;
  readonly isIndex: boolean;
  readonly spot: number;
  readonly nowSec: number;
  readonly marketStatus: 'open' | 'closed';
  readonly treasuryYieldPct: number;
  readonly sofrPct: number;
  readonly contracts: readonly MockRawContractSpec[];
}): FetchFn {
  const jsonRes = (body: unknown): FetchResponse => ({
    ok: true,
    status: 200,
    headers: {},
    text: JSON.stringify(body),
  });

  return (url) => {
    const parsed = new URL(url);
    const { pathname } = parsed;
    if (pathname === '/v3/snapshot') {
      return Promise.resolve(
        jsonRes({
          status: 'OK',
          results: [
            {
              ticker: params.symbol,
              type: params.isIndex ? 'indices' : 'stocks',
              market_status: params.marketStatus,
              value: params.spot,
              session: {
                price: params.spot,
                close: params.spot,
                previous_close: params.spot,
                open: params.spot,
                high: params.spot + 0.5,
                low: params.spot - 0.5,
              },
            },
          ],
        }),
      );
    }
    if (pathname.startsWith('/v3/snapshot/options/')) {
      const requestedExp = parsed.searchParams.get('expiration_date');
      const filtered =
        requestedExp !== null
          ? params.contracts.filter((c) => c.expirationDate === requestedExp)
          : params.contracts;
      const results = filtered.map((c) => {
        const hasValidBbo = c.bid > 0 && c.ask >= c.bid;
        const mid = hasValidBbo ? 0.5 * (c.bid + c.ask) : 0;
        const tsNs = String(params.nowSec * 1_000_000_000);
        return {
          details: {
            ticker: c.ticker,
            expiration_date: c.expirationDate,
            contract_type: c.contractType,
            ...(c.exerciseStyle !== null ? { exercise_style: c.exerciseStyle } : {}),
            strike_price: c.strike,
            shares_per_contract: 100,
          },
          implied_volatility: c.impliedVolatility,
          open_interest: c.openInterest ?? 500,
          day: {
            close: c.dayClose,
            previous_close: c.dayClose,
            volume: c.volume ?? 150,
            vwap: c.dayClose,
            change: 0,
            change_percent: 0,
            last_updated: tsNs,
          },
          last_quote: {
            bid: c.bid,
            ask: c.ask,
            midpoint: mid,
            bid_size: c.bid > 0 ? 15 : 0,
            ask_size: c.ask > 0 ? 15 : 0,
            sip_timestamp: tsNs,
          },
          last_trade: {
            price: c.lastTradePrice ?? c.dayClose,
            size: c.volume ?? 25,
            sip_timestamp: tsNs,
          },
          underlying_asset: {
            ticker: params.symbol,
            price: params.spot,
            timeframe: 'REAL-TIME',
          },
        };
      });
      return Promise.resolve(jsonRes({ status: 'OK', results }));
    }
    if (pathname === '/v3/reference/options/contracts') {
      const requestedExp = parsed.searchParams.get('expiration_date');
      const filtered =
        requestedExp !== null
          ? params.contracts.filter((c) => c.expirationDate === requestedExp)
          : params.contracts;
      const results = filtered.map((c) => ({
        ticker: c.ticker,
        underlying_ticker: c.underlyingTicker,
        contract_type: c.contractType,
        ...(c.exerciseStyle !== null ? { exercise_style: c.exerciseStyle } : {}),
        expiration_date: c.expirationDate,
        strike_price: c.strike,
        shares_per_contract: 100,
      }));
      return Promise.resolve(jsonRes({ status: 'OK', results }));
    }
    if (pathname.startsWith('/v2/aggs/ticker/')) {
      const segments = pathname.split('/');
      const timespan = segments[7] ?? 'day';
      const barSec = timespan === 'day' ? 86_400 : timespan === 'hour' ? 3_600 : 300;
      const count = timespan === 'day' ? 280 : 120;
      const bars: Record<string, unknown>[] = [];
      for (let i = count - 1; i >= 0; i -= 1) {
        const t = Math.floor(params.nowSec / barSec) * barSec - i * barSec;
        const wiggle = (i % 5) * 0.05;
        const c = params.spot + wiggle;
        bars.push({
          t: t * 1_000,
          o: c,
          h: c + 0.4,
          l: c - 0.4,
          c,
          v: 200_000,
          vw: c,
        });
      }
      return Promise.resolve(jsonRes({ status: 'OK', results: bars }));
    }
    if (pathname === '/fed/v1/treasury-yields') {
      const y = params.treasuryYieldPct;
      return Promise.resolve(
        jsonRes({
          status: 'OK',
          results: [
            {
              date: '2026-10-14',
              yield_1_month: y,
              yield_3_month: y,
              yield_6_month: y,
              yield_1_year: y,
              yield_2_year: y,
              yield_3_year: y,
              yield_5_year: y,
              yield_7_year: y,
              yield_10_year: y,
              yield_20_year: y,
              yield_30_year: y,
            },
          ],
        }),
      );
    }
    if (pathname === '/fed/v1/funding-conditions') {
      return Promise.resolve(
        jsonRes({
          status: 'OK',
          results: [{ date: '2026-10-14', sofr: params.sofrPct }],
        }),
      );
    }
    return Promise.resolve(jsonRes({ status: 'OK', results: [] }));
  };
}

function occTicker(root: string, expDate: string, type: 'call' | 'put', strike: number): string {
  const compact = expDate.replaceAll('-', '').slice(2);
  const cp = type === 'call' ? 'C' : 'P';
  const kStr = String(Math.round(strike * 1000)).padStart(8, '0');
  return `O:${root}${compact}${cp}${kStr}`;
}

function utcDatePlusDays(baseSec: number, days: number): { readonly date: string; readonly expiryUtcSec: number } {
  const sec = baseSec + days * 86_400;
  const date = new Date(sec * 1_000).toISOString().slice(0, 10);
  // 21:00 UTC corresponds to 16:00 EST / 17:00 EDT; exact UTC expiry timestamp matching (nowSec + days * 86400)
  return { date, expiryUtcSec: sec };
}

describe('Pieza P1 Q3 — Integridad contractual OPRA y consistencia de modelo end-to-end', () => {
  const servers: HttpWsServerHandle[] = [];

  afterEach(async () => {
    for (const s of servers.splice(0, servers.length)) {
      await s.stop();
    }
  });

  it('Q3-1: clasifica OEX como INDEX AMERICAN/CASH via OPRA_ROOT_TABLE y separa raíces europeas vs americanas', () => {
    expect(extractOpraContractRoot('O:OEX260619P00100000', 'I:OEX')).toBe('OEX');
    expect(extractOpraContractRoot('O:SPXW260619C05800000', 'I:SPX')).toBe('SPXW');

    const oexId = resolveUsOptionContractIdentity({
      optionSymbol: 'O:OEX260619P00100000',
      underlyingSymbol: 'I:OEX',
      isIndexHint: true,
      explicitExerciseStyle: null,
    });
    expect(oexId.contractRoot).toBe('OEX');
    expect(oexId.underlyingType).toBe('INDEX');
    expect(oexId.exerciseStyle).toBe('AMERICAN');
    expect(oexId.settlementType).toBe('CASH');
    expect(oexId.exerciseStyleSource).toBe('OPRA_ROOT_TABLE');
    expect(oexId.conflictCode).toBe('NONE');

    expect(CANONICAL_OPRA_ROOT_SPECS['OEX']?.exerciseStyle).toBe('AMERICAN');
    expect(CANONICAL_OPRA_ROOT_SPECS['XEO']?.exerciseStyle).toBe('EUROPEAN');
  });

  it('Q3-2: caso canónico PUT OEX (S=80, K=100, T=0.5, r=0.10, q=0, mid=21) converge a IV americana y rechaza BSM 48,73%', () => {
    const can = fixture.q3.canonical_oex_put;
    const oexIdentity = resolveUsOptionContractIdentity({
      optionSymbol: 'O:OEX260619P00100000',
      underlyingSymbol: 'I:OEX',
      isIndexHint: true,
      explicitExerciseStyle: null,
    });
    const nowSec = 1_766_000_000;
    const expiryUtcSec = nowSec + Math.round(can.timeToExpiry * 365 * 86_400);
    const oexContract = makeSnapshotContract({
      ticker: 'O:OEX260619P00100000',
      contractType: 'put',
      strike: can.strike,
      expirationDate: '2026-06-19',
      expiryUtcSec,
      underlyingTicker: 'I:OEX',
      spot: can.spot,
      bid: can.bid,
      ask: can.ask,
    });

    const solved = solveContractOwnIvDetailed({
      contract: oexContract,
      spot: can.spot,
      timeToExpiry: can.timeToExpiry,
      rate: can.rate,
      dividendYield: can.dividendYield,
      identity: oexIdentity,
      quotePolicy: 'RTH_STRICT_BBO',
      nowSec,
    });
    expect(solved.status).toBe('SOLVED_AMERICAN');
    expect(solved.model).toBe('AMERICAN_BS2002');
    expectMatchTol(solved.impliedVol, can.ivBs02, 1e-9, 'OEX PUT BS2002 IV');

    const crrAtCrrIv = priceAmericanCrrDiscrete({
      spot: can.spot,
      strike: can.strike,
      timeToExpiry: can.timeToExpiry,
      rate: can.rate,
      dividendYield: can.dividendYield,
      volatility: can.ivCrr1200,
      contractType: 'put',
      steps: 1200,
    });
    expectMatchTol(crrAtCrrIv, can.mid, 1e-9, 'CRR-1200 reprice at CRR IV');

    const crrAtBsmIv = priceAmericanCrrDiscrete({
      spot: can.spot,
      strike: can.strike,
      timeToExpiry: can.timeToExpiry,
      rate: can.rate,
      dividendYield: can.dividendYield,
      volatility: can.ivBsm,
      contractType: 'put',
      steps: 1200,
    });
    expectMatchTol(crrAtBsmIv, can.crr1200PriceAtBsmIv, 1e-9, 'CRR-1200 overpricing at BSM IV');
    expect(Math.abs(solved.impliedVol - can.ivCrr1200)).toBeLessThanOrEqual(3e-3);
    expect(can.ivBsm - solved.impliedVol).toBeGreaterThanOrEqual(8e-2);
  });

  it('Q3-3: rechaza IV europea del proveedor (48,73%) cuando converge IV americana o falla cota americana (mid=19.50)', async () => {
    const can = fixture.q3.canonical_oex_put;
    // Use RTH timestamp 2026-10-15 14:30 EDT = 18:30 UTC; 2027-04-16 is EDT -> 16:00 ET = 20:00 UTC
    const nowSec = Math.floor(Date.UTC(2026, 9, 15, 18, 30, 0) / 1_000);
    const expiryDate = '2027-04-16';
    const putValidTicker = occTicker('OEX', expiryDate, 'put', 100);

    const expSec = Math.floor(Date.UTC(2027, 3, 16, 20, 0, 0) / 1_000);
    const exactT = (expSec - nowSec) / (365 * 86_400);
    const exactMid100 = priceAmericanBjerksund2002({
      spot: can.spot,
      strike: 100,
      timeToExpiry: exactT,
      rate: 0.1,
      dividendYield: 0,
      volatility: can.ivBs02,
      contractType: 'put',
    });

    const contracts: MockRawContractSpec[] = [100, 105].flatMap((strike): MockRawContractSpec[] => {
      const cFair = priceAmericanBjerksund2002({ spot: can.spot, strike, timeToExpiry: exactT, rate: 0.1, dividendYield: 0, volatility: can.ivBs02, contractType: 'call' });
      const pFair = strike === 100
        ? exactMid100
        : priceAmericanBjerksund2002({ spot: can.spot, strike, timeToExpiry: exactT, rate: 0.1, dividendYield: 0, volatility: can.ivBs02, contractType: 'put' });
      return [
        {
          ticker: occTicker('OEX', expiryDate, 'call', strike),
          contractType: 'call',
          strike,
          expirationDate: expiryDate,
          exerciseStyle: null,
          underlyingTicker: 'OEX',
          bid: Math.max(0.05, cFair * 0.99),
          ask: Math.max(0.06, cFair * 1.01),
          impliedVolatility: can.ivBs02,
        },
        {
          ticker: occTicker('OEX', expiryDate, 'put', strike),
          contractType: 'put',
          strike,
          expirationDate: expiryDate,
          exerciseStyle: null,
          underlyingTicker: 'OEX',
          bid: strike === 105 ? 24.4 : pFair - 0.1,
          ask: strike === 105 ? 24.6 : pFair + 0.1,
          // Inject erroneous European IV 48.73% from provider!
          impliedVolatility: can.ivBsm,
        },
      ];
    });

    const runtime = new MarketRuntime({
      apiKey: 'q3-offline-key',
      enableWs: false,
      nowMsFn: () => nowSec * 1_000,
      fetchFn: createOfflineMassiveFetch({
        symbol: 'I:OEX',
        isIndex: true,
        spot: can.spot,
        nowSec,
        marketStatus: 'open',
        treasuryYieldPct: 10,
        sofrPct: 10,
        contracts,
      }),
    });

    const chain = await runtime.getUsOptionExpiryChain('I:OEX', expiryDate);
    const row100 = chain.contracts.find((r) => r.ticker === putValidTicker);
    expect(row100).toBeDefined();
    expect(row100?.exerciseStyle).toBe('AMERICAN');
    expect(row100?.settlementType).toBe('CASH');
    expect(row100?.exerciseStyleSource).toBe('OPRA_ROOT_TABLE');
    expect(row100?.ivSource).toBe('OWN');
    expect(row100?.valuationModel).toBe('AMERICAN_BS2002');
    expect(row100?.ivQualityStatus).toBe('SOLVED_AMERICAN');
    // Own American IV wins over European provider IV 0.4873 cleanly to 1e-9!
    expectMatchTol(row100?.ownIv, can.ivBs02, 1e-9, 'Q3-3 OEX PUT ownIv vs Python BS2002');
    expect(row100?.providerIv).toBeNull();

    // Strike 105 Put: mid=24.5 < intrinsic=25.0 -> BELOW_INTRINSIC -> must reject provider IV too!
    const put105 = chain.contracts.find((r) => r.strike === 105 && r.contractType === 'put');
    expect(put105).toBeDefined();
    expect(put105?.ownIv).toBeNull();
    expect(put105?.providerIv).toBeNull();
    expect(put105?.ivQualityStatus).toBe('BELOW_INTRINSIC');
  });

  it('Q3-4: XEO, SPX, SPXW, XSP, NDX, RUT, VIX, DJX, XND resuelven EUROPEAN/CASH y valoran XEO PUT por BSM exacto', () => {
    const can = fixture.q3.canonical_oex_put;
    const euroRoots = ['XEO', 'SPX', 'SPXW', 'XSP', 'NDX', 'NDXP', 'RUT', 'RUTW', 'VIX', 'VIXW', 'DJX', 'XND'];
    for (const root of euroRoots) {
      const id = resolveUsOptionContractIdentity({
        optionSymbol: occTicker(root, '2026-06-19', 'put', 100),
        underlyingSymbol: `I:${root === 'SPXW' ? 'SPX' : root === 'XEO' ? 'OEX' : root}`,
        isIndexHint: true,
        explicitExerciseStyle: null,
      });
      expect(id.exerciseStyle, root).toBe('EUROPEAN');
      expect(id.settlementType, root).toBe('CASH');
      expect(id.exerciseStyleSource, root).toBe('OPRA_ROOT_TABLE');
    }

    const xeoId = resolveUsOptionContractIdentity({
      optionSymbol: 'O:XEO260619P00100000',
      underlyingSymbol: 'I:OEX',
      isIndexHint: true,
      explicitExerciseStyle: null,
    });
    const nowSec = 1_766_000_000;
    const expiryUtcSec = nowSec + Math.round(can.timeToExpiry * 365 * 86_400);
    const xeoContract = makeSnapshotContract({
      ticker: 'O:XEO260619P00100000',
      contractType: 'put',
      strike: can.strike,
      expirationDate: '2026-06-19',
      expiryUtcSec,
      underlyingTicker: 'I:OEX',
      spot: can.spot,
      bid: can.bid,
      ask: can.ask,
    });
    const solved = solveContractOwnIvDetailed({
      contract: xeoContract,
      spot: can.spot,
      timeToExpiry: can.timeToExpiry,
      rate: can.rate,
      dividendYield: can.dividendYield,
      identity: xeoId,
      quotePolicy: 'RTH_STRICT_BBO',
      nowSec,
    });
    expect(solved.status).toBe('SOLVED_EUROPEAN');
    expect(solved.model).toBe('EUROPEAN_BSM');
    expectMatchTol(solved.impliedVol, can.ivBsm, 1e-9, 'XEO PUT BSM IV');

    const bsmG = greeksBsm({
      spot: can.spot,
      strike: can.strike,
      timeToExpiry: can.timeToExpiry,
      rate: can.rate,
      dividendYield: can.dividendYield,
      volatility: solved.impliedVol,
      contractType: 'put',
    });
    expectMatchTol(bsmG.delta, can.bsmGreeks.delta, 1e-9, 'XEO delta');
    expectMatchTol(bsmG.gamma, can.bsmGreeks.gamma, 1e-9, 'XEO gamma');
    expectMatchTol(bsmG.vegaPer1Pct, can.bsmGreeks.vegaPer1Pct, 1e-9, 'XEO vegaPer1Pct');
    expectMatchTol(bsmG.thetaDaily, can.bsmGreeks.thetaDaily, 1e-9, 'XEO thetaDaily');
    expectMatchTol(bsmG.vanna, can.bsmGreeks.vanna, 1e-9, 'XEO vanna');
    expectMatchTol(bsmG.charm, can.bsmGreeks.charm, 1e-9, 'XEO charm');
  });

  it('Q3-5: índice genérico I:CUSTIDX con exerciseStyle explícito american respeta Nivel 1 CONTRACT_EXPLICIT', () => {
    const can = fixture.q3.canonical_oex_put;
    const custId = resolveUsOptionContractIdentity({
      optionSymbol: 'O:CUST260619P00100000',
      underlyingSymbol: 'I:CUSTIDX',
      isIndexHint: true,
      explicitExerciseStyle: 'american',
    });
    expect(custId.exerciseStyle).toBe('AMERICAN');
    expect(custId.underlyingType).toBe('INDEX');
    expect(custId.exerciseStyleSource).toBe('CONTRACT_EXPLICIT');
    expect(custId.conflictCode).toBe('NONE');

    const nowSec = 1_766_000_000;
    const contract = makeSnapshotContract({
      ticker: 'O:CUST260619P00100000',
      contractType: 'put',
      strike: can.strike,
      expirationDate: '2026-06-19',
      expiryUtcSec: nowSec + Math.round(can.timeToExpiry * 365 * 86_400),
      underlyingTicker: 'I:CUSTIDX',
      spot: can.spot,
      bid: can.bid,
      ask: can.ask,
      exerciseStyle: 'american',
    });
    const solved = solveContractOwnIvDetailed({
      contract,
      spot: can.spot,
      timeToExpiry: can.timeToExpiry,
      rate: can.rate,
      dividendYield: can.dividendYield,
      identity: custId,
      quotePolicy: 'RTH_STRICT_BBO',
      nowSec,
    });
    expect(solved.status).toBe('SOLVED_AMERICAN');
    expect(solved.model).toBe('AMERICAN_BS2002');
    expectMatchTol(solved.impliedVol, can.ivBs02, 1e-9, 'I:CUSTIDX BS2002 IV');
  });

  it('Q3-6: índice desconocido I:UNKNIDX sin estilo explícito queda UNKNOWN fail-closed (IV/Greeks bloqueados, excluido de exposición/flujo)', async () => {
    const unknId = resolveUsOptionContractIdentity({
      optionSymbol: 'O:UNKN260619P00100000',
      underlyingSymbol: 'I:UNKNIDX',
      isIndexHint: true,
      explicitExerciseStyle: null,
    });
    expect(unknId.exerciseStyle).toBe('UNKNOWN');
    expect(unknId.exerciseStyleSource).toBe('UNRESOLVED_INDEX_UNKNOWN');

    const bermId = resolveUsOptionContractIdentity({
      optionSymbol: 'O:BERM260619P00100000',
      underlyingSymbol: 'I:SPX',
      isIndexHint: true,
      explicitExerciseStyle: 'bermudan',
    });
    expect(bermId.exerciseStyle).toBe('UNKNOWN');
    expect(bermId.conflictCode).toBe('UNSUPPORTED_BERMUDAN_STYLE');

    const nowSec = Math.floor(Date.UTC(2026, 9, 15, 18, 30, 0) / 1_000);
    const expDate = utcDatePlusDays(nowSec, 30).date;
    const runtime = new MarketRuntime({
      apiKey: 'q3-unkn-key',
      enableWs: false,
      nowMsFn: () => nowSec * 1_000,
      fetchFn: createOfflineMassiveFetch({
        symbol: 'I:UNKNIDX',
        isIndex: true,
        spot: 100,
        nowSec,
        marketStatus: 'open',
        treasuryYieldPct: 4,
        sofrPct: 4,
        contracts: [95, 100, 105].flatMap((k): MockRawContractSpec[] => [
          {
            ticker: occTicker('UNKN', expDate, 'call', k),
            contractType: 'call',
            strike: k,
            expirationDate: expDate,
            exerciseStyle: null,
            underlyingTicker: 'I:UNKNIDX',
            bid: 2.0,
            ask: 2.2,
            impliedVolatility: 0.25,
          },
          {
            ticker: occTicker('UNKN', expDate, 'put', k),
            contractType: 'put',
            strike: k,
            expirationDate: expDate,
            exerciseStyle: null,
            underlyingTicker: 'I:UNKNIDX',
            bid: 2.0,
            ask: 2.2,
            impliedVolatility: 0.25,
          },
        ]),
      }),
    });

    const snap = await runtime.getSnapshot('I:UNKNIDX', { expiration: expDate, prefetch: false });
    expect(snap.volSurfaceSummary?.contracts.length).toBeGreaterThan(0);
    for (const row of snap.volSurfaceSummary?.contracts ?? []) {
      expect(row.exerciseStyle).toBe('UNKNOWN');
      expect(row.exerciseStyleSource).toBe('UNRESOLVED_INDEX_UNKNOWN');
      expect(row.ownIv).toBeNull();
      expect(row.providerIv).toBeNull();
      expect(row.delta).toBeNull();
      expect(row.gamma).toBeNull();
      expect(row.ivSource).toBe('NONE');
      expect(row.ivQualityStatus).toBe('BLOCKED_UNKNOWN_STYLE');
      expect(row.valuationModel).toBe('NONE');
    }
    expect(snap.exposureSummary?.quality.usableContracts ?? 0).toBe(0);
    expect(snap.terminalEngines?.orderFlow ?? null).toBeNull();
  });

  it('Q3-7: conflicto explícito vs tabla canónica (SPX=american, OEX=european) respeta Nivel 1, marca CONFLICT y emite warning', async () => {
    const nowSec = Math.floor(Date.UTC(2026, 9, 15, 18, 30, 0) / 1_000);
    const expDate = utcDatePlusDays(nowSec, 30).date;

    const spxConflict = resolveUsOptionContractIdentity({
      optionSymbol: occTicker('SPX', expDate, 'put', 100),
      underlyingSymbol: 'I:SPX',
      isIndexHint: true,
      explicitExerciseStyle: 'american',
    });
    expect(spxConflict.exerciseStyle).toBe('AMERICAN');
    expect(spxConflict.exerciseStyleSource).toBe('CONFLICT_CONTRACT_OVERRIDES_TABLE');
    expect(spxConflict.conflictCode).toBe('EXPLICIT_CONFLICTS_WITH_CANONICAL_ROOT');

    const runtime = new MarketRuntime({
      apiKey: 'q3-conflict-key',
      enableWs: false,
      nowMsFn: () => nowSec * 1_000,
      fetchFn: createOfflineMassiveFetch({
        symbol: 'I:OEX',
        isIndex: true,
        spot: 100,
        nowSec,
        marketStatus: 'open',
        treasuryYieldPct: 4,
        sofrPct: 4,
        contracts: [95, 100, 105].map((k) => ({
          ticker: occTicker('OEX', expDate, 'put', k),
          contractType: 'put',
          strike: k,
          expirationDate: expDate,
          exerciseStyle: 'european',
          underlyingTicker: 'I:OEX',
          bid: 2.0,
          ask: 2.2,
          impliedVolatility: 0.25,
        })),
      }),
    });

    const chain = await runtime.getUsOptionExpiryChain('I:OEX', expDate);
    const first = chain.contracts[0];
    expect(first?.exerciseStyle).toBe('EUROPEAN');
    expect(first?.exerciseStyleSource).toBe('CONFLICT_CONTRACT_OVERRIDES_TABLE');
    expect(first?.exerciseStyleConflict).toBe('EXPLICIT_CONFLICTS_WITH_CANONICAL_ROOT');
    expect(
      chain.dataQuality.warnings.some((w) => w.includes('conflicts with canonical OPRA root "OEX"')),
    ).toBe(true);
  });

  it('Q3-8: consistencia end-to-end de griegas (OEX BS2002 vs XEO BSM), rescate ATM_FALLBACK sin cambio a BSM, exposición y flujo', async () => {
    const can = fixture.q3.canonical_oex_put;
    const amrGreeks = greeksAmericanFiniteDiffOrAnalytical({
      spot: can.spot,
      strike: can.strike,
      timeToExpiry: can.timeToExpiry,
      rate: can.rate,
      dividendYield: can.dividendYield,
      volatility: can.ivBs02,
      contractType: 'put',
    });
    expectMatchTol(amrGreeks.delta, can.bs02Greeks.delta, 1e-8, 'OEX BS2002 delta');
    expectMatchTol(amrGreeks.thetaDaily, can.bs02Greeks.thetaDaily, 1e-8, 'OEX BS2002 thetaDaily');
    expectMatchTol(amrGreeks.gamma, can.bs02Greeks.gamma, 1e-6, 'OEX BS2002 gamma');
    expectMatchTol(amrGreeks.vegaPer1Pct, can.bs02Greeks.vegaPer1Pct, 1e-6, 'OEX BS2002 vegaPer1Pct');
    expectMatchTol(amrGreeks.vanna, can.bs02Greeks.vanna, 1e-6, 'OEX BS2002 vanna');
    expectMatchTol(amrGreeks.charm, can.bs02Greeks.charm, 1e-6, 'OEX BS2002 charm');

    // Verify ATM_FALLBACK inside MarketRuntime for OEX never falls back to BSM Greeks!
    const atmFb = fixture.q3.atm_fallback_oex_vs_xeo;
    const nowSec = Math.floor(Date.UTC(2026, 9, 15, 18, 30, 0) / 1_000);
    const expDate = '2027-04-16';
    const exactExpTs = Math.floor(Date.UTC(2027, 3, 16, 20, 0, 0) / 1_000);
    const exactT = (exactExpTs - nowSec) / (365 * 86_400);
    const oexContracts: MockRawContractSpec[] = [
      // 2 ATM OTM Call/Put anchors near S=80 solving cleanly to atmIv = 0.35 with q=0
      ...([78, 82].flatMap((k): MockRawContractSpec[] => {
        const cP = priceAmericanBjerksund2002({ spot: can.spot, strike: k, timeToExpiry: exactT, rate: can.rate, dividendYield: 0, volatility: atmFb.atmIv, contractType: 'call' });
        const pP = priceAmericanBjerksund2002({ spot: can.spot, strike: k, timeToExpiry: exactT, rate: can.rate, dividendYield: 0, volatility: atmFb.atmIv, contractType: 'put' });
        return [
          { ticker: occTicker('OEX', expDate, 'call', k), contractType: 'call', strike: k, expirationDate: expDate, exerciseStyle: null, underlyingTicker: 'OEX', bid: cP * 0.995, ask: cP * 1.005, impliedVolatility: atmFb.atmIv },
          { ticker: occTicker('OEX', expDate, 'put', k), contractType: 'put', strike: k, expirationDate: expDate, exerciseStyle: null, underlyingTicker: 'OEX', bid: pP * 0.995, ask: pP * 1.005, impliedVolatility: atmFb.atmIv },
        ];
      })),
      // Wide spread (> 0.85) + >IV_CAP provider IV at K=100 -> forces ATM_FALLBACK without counterpart OTM IV at K=100!
      {
        ticker: occTicker('OEX', expDate, 'put', 100),
        contractType: 'put',
        strike: 100,
        expirationDate: expDate,
        exerciseStyle: null,
        underlyingTicker: 'OEX',
        bid: 10.0,
        ask: 32.0, // mid = 21.0 (> intrinsic 20, ext = 1 > 0.01), spreadRatio = 22/21 > 0.85 so ownIv = NaN
        impliedVolatility: 12.0, // > IV_CAP_DECIMAL -> rejected by isIvUnreliable/sanitizer -> ATM_FALLBACK
      },
    ];

    const runtimeOex = new MarketRuntime({
      apiKey: 'q3-atmfb-key',
      enableWs: false,
      nowMsFn: () => nowSec * 1_000,
      fetchFn: createOfflineMassiveFetch({
        symbol: 'I:OEX',
        isIndex: true,
        spot: can.spot,
        nowSec,
        marketStatus: 'open',
        treasuryYieldPct: 10,
        sofrPct: 10,
        contracts: oexContracts,
      }),
    });
    const chainOex = await runtimeOex.getUsOptionExpiryChain('I:OEX', expDate);
    const put100 = chainOex.contracts.find((r) => r.strike === 100 && r.contractType === 'put');
    expect(put100?.exerciseStyle).toBe('AMERICAN');
    // Must stay AMERICAN_BS2002 (NOT EUROPEAN_BSM!) even under ATM_FALLBACK!
    expect(put100?.valuationModel).toBe('AMERICAN_BS2002');
    expect(put100?.ivSource).toBe('ATM_FALLBACK');
    const expOexG = greeksAmericanFiniteDiffOrAnalytical({
      spot: can.spot,
      strike: 100,
      timeToExpiry: exactT,
      rate: can.rate,
      dividendYield: 0,
      volatility: atmFb.atmIv,
      contractType: 'put',
    });
    expectMatchTol(put100?.delta, expOexG.delta, 1e-8, 'OEX ATM_FALLBACK keeps American delta');
    expect(Math.abs((put100?.delta ?? 0) - atmFb.xeoBsmGreeks.delta)).toBeGreaterThan(0.10);

    // Exposure & OrderFlow per-contract model propagation
    const oexInput: ExposureContractInput = {
      model: 'american',
      contractType: 'put',
      strike: can.strike,
      expiryUtcSec: nowSec + Math.round(can.timeToExpiry * 365 * 86_400),
      openInterest: 100,
      sharesPerContract: 100,
      iv: can.ivBs02,
      spot: can.spot,
      rate: can.rate,
      dividendYield: can.dividendYield,
    };
    const xeoInput: ExposureContractInput = {
      ...oexInput,
      model: 'bsm',
      iv: can.ivBsm,
    };
    const marketExp = { spot: can.spot, nowUtcSec: nowSec, rate: can.rate, dividendYield: can.dividendYield };
    const expOexOnly = computeDealerExposure([oexInput], marketExp, { model: 'american' });
    const expOexEvenIfFallbackBsm = computeDealerExposure([oexInput], marketExp, { model: 'bsm' });
    expectMatchTol(expOexEvenIfFallbackBsm.netGex, expOexOnly.netGex, 1e-9, 'per-contract american model in exposure overrides chain fallback');
    const expXeoOnly = computeDealerExposure([xeoInput], marketExp, { model: 'bsm' });
    expect(Math.abs(expOexOnly.netGex - expXeoOnly.netGex)).toBeGreaterThan(1e-3);

    const oexPrint: OpraTradePrintInput = {
      contractTicker: 'O:OEX260619P00100000',
      underlyingTicker: 'I:OEX',
      strike: can.strike,
      expiryUtcSec: marketExp.nowUtcSec + Math.round(can.timeToExpiry * 365 * 86_400),
      contractType: 'put',
      model: 'american',
      price: 21.1,
      size: 10,
      bid: 20.9,
      ask: 21.1,
      impliedVolatility: can.ivBs02,
      timestampUtcSec: nowSec,
      sharesPerContract: 100,
    };
    const flowCtxBsm = { asOfUtcSec: nowSec, spot: can.spot, rate: can.rate, dividendYield: 0, model: 'bsm' as const };
    const flowCtxAmr = { ...flowCtxBsm, model: 'american' as const };
    const flow1 = computeSignedOptionsOrderFlow([oexPrint], flowCtxBsm);
    const flow2 = computeSignedOptionsOrderFlow([oexPrint], flowCtxAmr);
    expectMatchTol(flow1.netDeltaShares, flow2.netDeltaShares, 1e-9, 'per-contract american flow overrides ctx fallback');
    expectMatchTol(flow1.netVegaUsd, flow2.netVegaUsd, 1e-9, 'per-contract american vega flow');
    const xeoFlow = computeSignedOptionsOrderFlow(
      [{ ...oexPrint, model: 'bsm', impliedVolatility: can.ivBsm }],
      flowCtxAmr,
    );
    expect(Math.abs(flow1.netDeltaShares - xeoFlow.netDeltaShares)).toBeGreaterThan(100);

    const anomInputs: VolOiAnomalyContractInput[] = [
      { contractTicker: 'O:OEX_1', strike: 100, expiryUtcSec: oexPrint.expiryUtcSec, contractType: 'put', model: 'american', dayVolume: 500, openInterest: 100, impliedVolatility: can.ivBs02, sharesPerContract: 100 },
      { contractTicker: 'O:OEX_2', strike: 105, expiryUtcSec: oexPrint.expiryUtcSec, contractType: 'put', model: 'american', dayVolume: 50, openInterest: 100, impliedVolatility: can.ivBs02, sharesPerContract: 100 },
    ];
    const anom = detectVolOiAnomaliesMad(anomInputs, flowCtxBsm, { minVolume: 1, minOpenInterest: 1, minBucketSize: 2 });
    const anomAmr = detectVolOiAnomaliesMad(anomInputs, flowCtxAmr, { minVolume: 1, minOpenInterest: 1, minBucketSize: 2 });
    expect(anom.evaluatedContracts).toBe(2);
    expectMatchTol(anom.contracts[0]?.delta, anomAmr.contracts[0]?.delta ?? Number.NaN, 1e-9, 'Vol/OI anomaly per-contract american delta');
  });

  it('Q3-9: dividend yield q=0 (identidad de Merton exactitud <= 1e-12) vs q=0.08 Call ITM americano (prima positiva e IV_AMR < IV_EUR)', () => {
    const merton = fixture.q3.merton_and_dividend_call.mertonZeroDiv;
    const pBsm = priceBsm({
      spot: merton.spot,
      strike: merton.strike,
      timeToExpiry: merton.timeToExpiry,
      rate: merton.rate,
      dividendYield: merton.dividendYield,
      volatility: merton.sigma,
      contractType: 'call',
    });
    const pBs02 = priceAmericanBjerksund2002({
      spot: merton.spot,
      strike: merton.strike,
      timeToExpiry: merton.timeToExpiry,
      rate: merton.rate,
      dividendYield: merton.dividendYield,
      volatility: merton.sigma,
      contractType: 'call',
    });
    expect(Math.abs(pBs02 - pBsm)).toBeLessThanOrEqual(1e-12);
    expectMatchTol(pBs02, merton.priceBsm, 1e-9, 'Merton Call q=0 vs Python');

    const highDiv = fixture.q3.merton_and_dividend_call.highDivEarlyExerciseCall;
    const pxAmr030 = priceAmericanBjerksund2002({
      spot: highDiv.spot,
      strike: highDiv.strike,
      timeToExpiry: highDiv.timeToExpiry,
      rate: highDiv.rate,
      dividendYield: highDiv.dividendYield,
      volatility: 0.30,
      contractType: 'call',
    });
    const pxEur030 = priceBsm({
      spot: highDiv.spot,
      strike: highDiv.strike,
      timeToExpiry: highDiv.timeToExpiry,
      rate: highDiv.rate,
      dividendYield: highDiv.dividendYield,
      volatility: 0.30,
      contractType: 'call',
    });
    expect(pxAmr030 - pxEur030).toBeGreaterThan(0.5);
    expectMatchTol(pxAmr030, highDiv.priceAmrAt030, 1e-9, 'Call q=0.08 American price at 0.30');

    const nowSec = 1_766_000_000;
    const expiryUtcSec = nowSec + Math.round(highDiv.timeToExpiry * 365 * 86_400);
    const eqId = resolveUsOptionContractIdentity({
      optionSymbol: 'O:AAPL260619C00100000',
      underlyingSymbol: 'AAPL',
      isIndexHint: false,
      explicitExerciseStyle: null,
    });
    const eqCallContract = makeSnapshotContract({
      ticker: 'O:AAPL260619C00100000',
      contractType: 'call',
      strike: highDiv.strike,
      expirationDate: '2026-06-19',
      expiryUtcSec,
      underlyingTicker: 'AAPL',
      spot: highDiv.spot,
      bid: highDiv.mid - 0.05,
      ask: highDiv.mid + 0.05,
    });
    const solvedAmr = solveContractOwnIvDetailed({
      contract: eqCallContract,
      spot: highDiv.spot,
      timeToExpiry: highDiv.timeToExpiry,
      rate: highDiv.rate,
      dividendYield: highDiv.dividendYield,
      identity: eqId,
      quotePolicy: 'RTH_STRICT_BBO',
      nowSec,
    });
    expect(solvedAmr.status).toBe('SOLVED_AMERICAN');
    expect(solvedAmr.impliedVol).toBeLessThan(highDiv.ivBsm);
    expectMatchTol(solvedAmr.impliedVol, highDiv.ivBs02, 1e-9, 'High-div Call American IV');
  });

  it('Q3-10: reutiliza 1 a 1 los estados diagnósticos AmericanIvStatus de A3 sin exponer IV numérica en fallos', () => {
    const can = fixture.q3.canonical_oex_put;
    const identity = resolveUsOptionContractIdentity({
      optionSymbol: 'O:OEX260619P00100000',
      underlyingSymbol: 'I:OEX',
      isIndexHint: true,
      explicitExerciseStyle: null,
    });
    const nowSec = 1_766_000_000;
    const expiryUtcSec = nowSec + Math.round(can.timeToExpiry * 365 * 86_400);

    const scenarios: readonly { readonly name: string; readonly bid: number; readonly ask: number; readonly expirySec?: number; readonly qQual?: OptionSnapshotContract['lastQuote']['quoteQuality'] }[] = [
      { name: 'SOLVED_AMERICAN', bid: can.bid, ask: can.ask },
      { name: 'BELOW_INTRINSIC', bid: 19.4, ask: 19.6 },
      { name: 'ABOVE_UPPER_BOUND', bid: 100.5, ask: 101.0 },
      { name: 'UNIDENTIFIABLE_AMERICAN_IV', bid: can.bid, ask: can.ask, expirySec: nowSec + 30 },
      { name: 'INVALID_INPUT', bid: 22.0, ask: 20.0 },
      { name: 'STALE_QUOTE', bid: can.bid, ask: can.ask, qQual: 'STALE' },
    ];

    for (const sc of scenarios) {
      const expSec = sc.expirySec ?? expiryUtcSec;
      const t = (expSec - nowSec) / (365 * 86_400);
      const c = makeSnapshotContract({
        ticker: 'O:OEX260619P00100000',
        contractType: 'put',
        strike: can.strike,
        expirationDate: '2026-06-19',
        expiryUtcSec: expSec,
        underlyingTicker: 'I:OEX',
        spot: can.spot,
        bid: sc.bid,
        ask: sc.ask,
        ...(sc.qQual !== undefined ? { quoteQuality: sc.qQual } : {}),
      });
      const wrapperRes = solveContractOwnIvDetailed({
        contract: c,
        spot: can.spot,
        timeToExpiry: t,
        rate: can.rate,
        dividendYield: can.dividendYield,
        identity,
        quotePolicy: 'RTH_STRICT_BBO',
        nowSec,
      });

      if (sc.qQual === 'STALE') {
        expect(wrapperRes.status).toBe('STALE_INPUT');
        expect(wrapperRes.impliedVol).toBeNaN();
        continue;
      }

      const a3Direct = solveImpliedVolAmericanDetailed({
        instrumentId: c.ticker,
        asOfUtcSec: nowSec,
        expiryUtcSec: expSec,
        spot: can.spot,
        strike: can.strike,
        contractType: 'put',
        rate: can.rate,
        dividendYield: can.dividendYield,
        bid: sc.bid,
        ask: sc.ask,
        currency: 'USD',
        exerciseStyle: 'AMERICAN',
        bypassStaleness: true,
        maxVolatility: 9.99,
      });
      expect(wrapperRes.status, sc.name).toBe(a3Direct.modelStatus);
      if (a3Direct.modelStatus === 'SOLVED_AMERICAN') {
        expectMatchTol(wrapperRes.impliedVol, a3Direct.impliedVol, 1e-12, sc.name);
      } else {
        expect(wrapperRes.impliedVol, sc.name).toBeNaN();
      }
    }
  });
});

describe('Pieza P1 Q4 — Superficies sin cotizaciones fabricadas y controles de arbitraje fail-closed', () => {
  const servers: HttpWsServerHandle[] = [];

  afterEach(async () => {
    for (const s of servers.splice(0, servers.length)) {
      await s.stop();
    }
  });

  it('Q4-1 & Q4-2: GGAL ADR en RTH sin BBO válido jamás fabrica BBOs (0.995/1.005 ni 0.96/1.04) y degrada fail-closed', async () => {
    // Thursday 2026-10-15 14:30 EDT = 18:30 UTC (inside RTH)
    const rthNowSec = Math.floor(Date.UTC(2026, 9, 15, 18, 30, 0) / 1_000);
    const expDate = utcDatePlusDays(rthNowSec, 30).date;
    const contracts: MockRawContractSpec[] = [45, 50, 55].map((k) => ({
      ticker: occTicker('GGAL', expDate, 'call', k),
      contractType: 'call',
      strike: k,
      expirationDate: expDate,
      exerciseStyle: null,
      underlyingTicker: 'GGAL',
      bid: 0,
      ask: 0,
      dayClose: 1.0,
      lastTradePrice: 1.0,
      impliedVolatility: 0.2,
    }));

    const runtime = new MarketRuntime({
      apiKey: 'q4-ggal-rth-key',
      enableWs: false,
      nowMsFn: () => rthNowSec * 1_000,
      fetchFn: createOfflineMassiveFetch({
        symbol: 'GGAL',
        isIndex: false,
        spot: 50,
        nowSec: rthNowSec,
        marketStatus: 'open',
        treasuryYieldPct: 4,
        sofrPct: 4,
        contracts,
      }),
    });

    const snap: TerminalSnapshotResponse = await runtime.getSnapshot('GGAL', {
      expiration: expDate,
      prefetch: false,
    });
    expect(snap.quoteMode).toBe('LIVE_NBBO');
    const summary = snap.volSurfaceSummary;
    expect(summary).not.toBeNull();
    expect(summary?.surfaceQuotePolicy).toBe('RTH_STRICT_BBO');
    expect(summary?.surfaceMode).toBe('UNAVAILABLE');
    expect(summary?.surfaceQuality).toBe('MISSING_BBO');
    expect(summary?.rejectionReason).toBe('missing_valid_rth_bbo');
    expect(summary?.slices).toEqual([]);
    expect(summary?.frontSlice).toBeNull();
    expect(summary?.butterflyCheckStatus).toBe('NOT_EVALUATED');
    expect(summary?.calendarCheckStatus).toBe('NOT_EVALUATED');
    expect(summary?.arbitrageCheckStatus).toBe('NOT_EVALUATED');
    expect(summary?.butterflyArbitrageFree).toBe(false);
    expect(summary?.calendarArbitrageFree).toBe(false);
    expect(summary?.isArbitrageFree).toBe(false);

    for (const row of summary?.contracts ?? []) {
      expect(row.bid).toBeNull();
      expect(row.ask).toBeNull();
      expect(row.ownIv).toBeNull();
      expect(row.quoteQuality).toBe('MISSING_BBO');
    }

    const chain = await runtime.getUsOptionExpiryChain('GGAL', expDate);
    expect(chain.quoteMode).toBe('LIVE_NBBO');
    expect(chain.slice).toBeNull();
    for (const row of chain.contracts) {
      expect(row.bid).toBeNull();
      expect(row.ask).toBeNull();
      expect(row.quoteQuality).toBe('MISSING_BBO');
    }
  });

  it('Q4-3: cadena RTH líquida normal (>= 6 strikes BBO real, 2 vencimientos sin arbitraje) aprueba con exactitud', async () => {
    const rthNowSec = Math.floor(Date.UTC(2026, 9, 15, 18, 30, 0) / 1_000);
    const { rate, dividendYield, spot: spotQ4, t1, t2, rthValidTwoSliceFlat } = fixture.q4;
    // Construct two expiries in standard time whose UTC 21:00 close matches t1 and t2 accurately,
    // or verify MarketRuntime RTH pipeline with European I:SPX so BSM fair quotes give exact flat 0.25 IV!
    const exp1Date = new Date((rthNowSec + Math.round(t1 * 365 * 86_400)) * 1_000).toISOString().slice(0, 10);
    const exp2Date = new Date((rthNowSec + Math.round(t2 * 365 * 86_400)) * 1_000).toISOString().slice(0, 10);
    const exp1Ts = Math.floor(Date.UTC(Number(exp1Date.slice(0, 4)), Number(exp1Date.slice(5, 7)) - 1, Number(exp1Date.slice(8, 10)), 21, 0, 0) / 1_000);
    const exp2Ts = Math.floor(Date.UTC(Number(exp2Date.slice(0, 4)), Number(exp2Date.slice(5, 7)) - 1, Number(exp2Date.slice(8, 10)), 21, 0, 0) / 1_000);
    const exactT1 = (exp1Ts - rthNowSec) / (365 * 86_400);
    const exactT2 = (exp2Ts - rthNowSec) / (365 * 86_400);

    const makeBsmChain = (expDate: string, tVal: number): MockRawContractSpec[] =>
      fixture.q4.strikes.flatMap((k): MockRawContractSpec[] => {
        const cPx = priceBsm({ spot: spotQ4, strike: k, timeToExpiry: tVal, rate, dividendYield, volatility: rthValidTwoSliceFlat.ivFlat, contractType: 'call' });
        const pPx = priceBsm({ spot: spotQ4, strike: k, timeToExpiry: tVal, rate, dividendYield, volatility: rthValidTwoSliceFlat.ivFlat, contractType: 'put' });
        return [
          {
            ticker: occTicker('SPX', expDate, 'call', k),
            contractType: 'call',
            strike: k,
            expirationDate: expDate,
            exerciseStyle: 'european',
            underlyingTicker: 'I:SPX',
            bid: cPx * 0.99,
            ask: cPx * 1.01,
            dayClose: cPx,
            impliedVolatility: rthValidTwoSliceFlat.ivFlat,
          },
          {
            ticker: occTicker('SPX', expDate, 'put', k),
            contractType: 'put',
            strike: k,
            expirationDate: expDate,
            exerciseStyle: 'european',
            underlyingTicker: 'I:SPX',
            bid: pPx * 0.99,
            ask: pPx * 1.01,
            dayClose: pPx,
            impliedVolatility: rthValidTwoSliceFlat.ivFlat,
          },
        ];
      });

    const contracts = [...makeBsmChain(exp1Date, exactT1), ...makeBsmChain(exp2Date, exactT2)];
    const runtime = new MarketRuntime({
      apiKey: 'q4-rth-valid-key',
      enableWs: false,
      nowMsFn: () => rthNowSec * 1_000,
      fetchFn: createOfflineMassiveFetch({
        symbol: 'I:SPX',
        isIndex: true,
        spot: spotQ4,
        nowSec: rthNowSec,
        marketStatus: 'open',
        treasuryYieldPct: rate * 100,
        sofrPct: rate * 100,
        contracts,
      }),
    });

    const snap = await runtime.getSnapshot('I:SPX', { expiration: exp1Date, prefetch: false });
    const summary = snap.volSurfaceSummary;
    expect(summary?.surfaceQuotePolicy).toBe('RTH_STRICT_BBO');
    expect(summary?.surfaceMode).toBe('LIVE_RTH');
    expect(summary?.surfaceQuality).toBe('LIVE_VALID');
    expect(summary?.validSlicesCount).toBe(2);
    expect(summary?.butterflyCheckStatus).toBe('PASS');
    expect(summary?.calendarCheckStatus).toBe('PASS');
    expect(summary?.arbitrageCheckStatus).toBe('PASS');
    expect(summary?.isArbitrageFree).toBe(true);
    expectMatchTol(summary?.frontSlice?.ivAtm, rthValidTwoSliceFlat.ivFlat, 1e-6, 'RTH SPX front ivAtm');
    for (const sl of summary?.slices ?? []) {
      expect(sl.sliceMode).toBe('LIVE_RTH');
      expect(sl.sliceQuality).toBe('LIVE_VALID');
      for (const n of sl.nodes) {
        expect(n.spreadRatio).not.toBeNull();
        expect(Math.abs((n.spreadRatio ?? 0) - 0.08)).toBeGreaterThan(1e-4);
      }
    }
  });

  it('Q4-4: fin de semana EOD (sábado weekday=6 y domingo weekday=7) usa EOD_CLOSE_REF con bid/ask null y spreadRatio null', async () => {
    // Saturday 2026-10-17 18:00 UTC (weekday 6) & Sunday 2026-10-18 18:00 UTC (weekday 7)
    const satSec = Math.floor(Date.UTC(2026, 9, 17, 18, 0, 0) / 1_000);
    const sunSec = Math.floor(Date.UTC(2026, 9, 18, 18, 0, 0) / 1_000);
    expect(resolveUsOptionsSessionPolicy(satSec, false)).toMatchObject({
      isWeekendEt: true,
      marketIsClosed: true,
      surfaceQuotePolicy: 'EOD_CLOSE_REF',
    });
    // Q4-D4 regression check: Sunday MUST ALSO resolve isWeekendEt=true!
    expect(resolveUsOptionsSessionPolicy(sunSec, false)).toMatchObject({
      isWeekendEt: true,
      marketIsClosed: true,
      surfaceQuotePolicy: 'EOD_CLOSE_REF',
    });

    const { rate, dividendYield, spot: spotQ4, t1, t2, rthValidTwoSliceFlat } = fixture.q4;
    const exp1Date = new Date((sunSec + Math.round(t1 * 365 * 86_400)) * 1_000).toISOString().slice(0, 10);
    const exp2Date = new Date((sunSec + Math.round(t2 * 365 * 86_400)) * 1_000).toISOString().slice(0, 10);
    const exp1Ts = Math.floor(Date.UTC(Number(exp1Date.slice(0, 4)), Number(exp1Date.slice(5, 7)) - 1, Number(exp1Date.slice(8, 10)), 21, 0, 0) / 1_000);
    const exp2Ts = Math.floor(Date.UTC(Number(exp2Date.slice(0, 4)), Number(exp2Date.slice(5, 7)) - 1, Number(exp2Date.slice(8, 10)), 21, 0, 0) / 1_000);
    const exactT1 = (exp1Ts - sunSec) / (365 * 86_400);
    const exactT2 = (exp2Ts - sunSec) / (365 * 86_400);

    const makeEodChain = (expDate: string, tVal: number): MockRawContractSpec[] =>
      fixture.q4.strikes.flatMap((k): MockRawContractSpec[] => {
        const cFair = priceAmericanBjerksund2002({ spot: spotQ4, strike: k, timeToExpiry: tVal, rate, dividendYield, volatility: rthValidTwoSliceFlat.ivFlat, contractType: 'call' });
        const pFair = priceAmericanBjerksund2002({ spot: spotQ4, strike: k, timeToExpiry: tVal, rate, dividendYield, volatility: rthValidTwoSliceFlat.ivFlat, contractType: 'put' });
        return [
          {
            ticker: occTicker('SPY', expDate, 'call', k),
            contractType: 'call',
            strike: k,
            expirationDate: expDate,
            exerciseStyle: 'american',
            underlyingTicker: 'SPY',
            bid: 0,
            ask: 0,
            dayClose: cFair,
            lastTradePrice: cFair,
            impliedVolatility: rthValidTwoSliceFlat.ivFlat,
          },
          {
            ticker: occTicker('SPY', expDate, 'put', k),
            contractType: 'put',
            strike: k,
            expirationDate: expDate,
            exerciseStyle: 'american',
            underlyingTicker: 'SPY',
            bid: 0,
            ask: 0,
            dayClose: pFair,
            lastTradePrice: pFair,
            impliedVolatility: rthValidTwoSliceFlat.ivFlat,
          },
        ];
      });

    const contracts = [...makeEodChain(exp1Date, exactT1), ...makeEodChain(exp2Date, exactT2)];
    const runtime = new MarketRuntime({
      apiKey: 'q4-sunday-eod-key',
      enableWs: false,
      nowMsFn: () => sunSec * 1_000,
      fetchFn: createOfflineMassiveFetch({
        symbol: 'SPY',
        isIndex: false,
        spot: spotQ4,
        nowSec: sunSec,
        marketStatus: 'closed',
        treasuryYieldPct: rate * 100,
        sofrPct: rate * 100,
        contracts,
      }),
    });

    const snap = await runtime.getSnapshot('SPY', { expiration: exp1Date, prefetch: false });
    expect(snap.feedMode).toBe('EOD_CIERRE');
    expect(snap.quoteMode).toBe('EOD_CLOSE_REF');
    expect(snap.volSurfaceSummary?.surfaceQuotePolicy).toBe('EOD_CLOSE_REF');
    expect(snap.volSurfaceSummary?.surfaceMode).toBe('EOD_REFERENCE');
    expect(snap.volSurfaceSummary?.surfaceQuality).toBe('EOD_CLOSE_REF');
    expect(snap.volSurfaceSummary?.slices.length).toBe(2);

    for (const row of snap.volSurfaceSummary?.contracts ?? []) {
      expect(row.bid).toBeNull();
      expect(row.ask).toBeNull();
      expect(row.mid).not.toBeNull();
      expect(row.quoteQuality).toBe('EOD_CLOSE_REF');
    }
    for (const sl of snap.volSurfaceSummary?.slices ?? []) {
      expect(sl.sliceMode).toBe('EOD_REFERENCE');
      for (const n of sl.nodes) {
        expect(n.spreadRatio).toBeNull();
      }
    }
  });

  it('Q4-5: cadena RTH con solo 2 o 3 strikes con BBO válido rechaza superficie sin inventar puntas', async () => {
    const rthNowSec = Math.floor(Date.UTC(2026, 9, 15, 18, 30, 0) / 1_000);
    const expDate = utcDatePlusDays(rthNowSec, 30).date;
    const contracts: MockRawContractSpec[] = [95, 100, 105].map((k) => ({
      ticker: occTicker('SPY', expDate, k >= 100 ? 'call' : 'put', k),
      contractType: k >= 100 ? 'call' : 'put',
      strike: k,
      expirationDate: expDate,
      exerciseStyle: 'american',
      underlyingTicker: 'SPY',
      bid: 2.4,
      ask: 2.6,
      impliedVolatility: 0.25,
    }));

    const runtime = new MarketRuntime({
      apiKey: 'q4-insuff-key',
      enableWs: false,
      nowMsFn: () => rthNowSec * 1_000,
      fetchFn: createOfflineMassiveFetch({
        symbol: 'SPY',
        isIndex: false,
        spot: 100,
        nowSec: rthNowSec,
        marketStatus: 'open',
        treasuryYieldPct: 4,
        sofrPct: 4,
        contracts,
      }),
    });
    const snap = await runtime.getSnapshot('SPY', { expiration: expDate, prefetch: false });
    expect(snap.volSurfaceSummary?.surfaceMode).toBe('UNAVAILABLE');
    expect(snap.volSurfaceSummary?.surfaceQuality).toBe('INSUFFICIENT_STRIKES');
    expect(snap.volSurfaceSummary?.rejectionReason).toBe('insufficient_points');
    expect(snap.volSurfaceSummary?.slices).toEqual([]);
    expect(snap.volSurfaceSummary?.frontSlice).toBeNull();
    expect(snap.volSurfaceSummary?.isArbitrageFree).toBe(false);
  });

  it('Q4-6 & Q4-7: Durrleman butterfly y calendar arbitrage coinciden con el oráculo Python (PASS y FAIL)', () => {
    const { rate, dividendYield, spot, t1, t2, mildSkewArbitrageFree, butterflyViolation, calendarViolation } = fixture.q4;
    const fwd1 = spot * Math.exp((rate - dividendYield) * t1);
    const fwd2 = spot * Math.exp((rate - dividendYield) * t2);

    const makeSliceInputs = (strikes: readonly number[], ivs: readonly number[], t: number, fwd: number, expSec: number) => ({
      timeToExpiry: t,
      expirySec: expSec,
      forward: fwd,
      spot,
      rate,
      dividendYield,
      quotes: strikes.map((k, idx) => {
        const contractType: 'call' | 'put' = k >= fwd ? 'call' : 'put';
        return {
          strike: k,
          contractType,
          iv: ivs[idx] ?? 0.25,
          bid: 1.9,
          ask: 2.1,
          openInterest: 100,
        };
      }),
    });

    const passSurface = buildVolSurface([
      makeSliceInputs(mildSkewArbitrageFree.strikes, mildSkewArbitrageFree.ivsT1, t1, fwd1, 1_800_000_000),
      makeSliceInputs(mildSkewArbitrageFree.strikes, mildSkewArbitrageFree.ivsT2, t2, fwd2, 1_802_592_000),
    ]);
    expect(passSurface.butterflyCheckStatus).toBe('PASS');
    expect(passSurface.calendarCheckStatus).toBe('PASS');
    expect(passSurface.arbitrageCheckStatus).toBe('PASS');
    expect(passSurface.butterflyArbitrageFree).toBe(true);
    expect(passSurface.calendarArbitrageFree).toBe(true);
    expect(passSurface.isArbitrageFree).toBe(true);
    expectMatchTol(passSurface.butterflyReports[0]?.minDensity, mildSkewArbitrageFree.minDurrlemanT1, 1e-9, 'minDurrlemanT1');
    expectMatchTol(passSurface.butterflyReports[1]?.minDensity, mildSkewArbitrageFree.minDurrlemanT2, 1e-9, 'minDurrlemanT2');

    // Q4-7a: Butterfly violation
    const bfBadSurface = buildVolSurface([
      makeSliceInputs(butterflyViolation.strikes, butterflyViolation.ivs, butterflyViolation.t, butterflyViolation.forward, 1_800_000_000),
      makeSliceInputs(mildSkewArbitrageFree.strikes, mildSkewArbitrageFree.ivsT2, t2, fwd2, 1_802_592_000),
    ]);
    expect(bfBadSurface.butterflyCheckStatus).toBe('FAIL');
    expect(bfBadSurface.arbitrageCheckStatus).toBe('FAIL');
    expect(bfBadSurface.butterflyArbitrageFree).toBe(false);
    expect(bfBadSurface.isArbitrageFree).toBe(false);
    expectMatchTol(bfBadSurface.butterflyReports[0]?.minDensity, butterflyViolation.minDurrleman, 1e-9, 'bf minDurrleman FAIL');

    // Q4-7b: Calendar violation
    const calBadSurface = buildVolSurface([
      makeSliceInputs(calendarViolation.strikes, calendarViolation.ivsT1, calendarViolation.t1, fwd1, 1_800_000_000),
      makeSliceInputs(calendarViolation.strikes, calendarViolation.ivsT2, calendarViolation.t2, fwd2, 1_802_592_000),
    ]);
    expect(calBadSurface.calendarCheckStatus).toBe('FAIL');
    expect(calBadSurface.arbitrageCheckStatus).toBe('FAIL');
    expect(calBadSurface.calendarArbitrageFree).toBe(false);
    expect(calBadSurface.isArbitrageFree).toBe(false);
    expectMatchTol(calBadSurface.calendarCheck.minVarianceDiff, calendarViolation.minVarianceDiff, 1e-9, 'cal minVarianceDiff FAIL');
  });

  it('Q4-8 & Q4-9: checks ausentes o parciales reportan NOT_EVALUATED y jamás se promueven a true', () => {
    const emptySurface = buildVolSurface([]);
    expect(emptySurface.butterflyCheckStatus).toBe('NOT_EVALUATED');
    expect(emptySurface.calendarCheckStatus).toBe('NOT_EVALUATED');
    expect(emptySurface.arbitrageCheckStatus).toBe('NOT_EVALUATED');
    expect(emptySurface.butterflyArbitrageFree).toBe(false);
    expect(emptySurface.calendarArbitrageFree).toBe(false);
    expect(emptySurface.isArbitrageFree).toBe(false);

    const invalidSlice = buildVolSlice(
      { timeToExpiry: 0.1, forward: 100, quotes: [] },
      { minPoints: 4 },
    );
    expect(invalidSlice.isValid).toBe(false);
    const bfInvalid = validateSliceButterflyArbitrage(invalidSlice);
    expect(bfInvalid.status).toBe('NOT_EVALUATED');
    expect(bfInvalid.isArbitrageFree).toBe(false);

    // Q4-9a: 1 valid slice -> butterfly PASS, calendar NOT_EVALUATED, overall NOT_EVALUATED & false!
    const { rate, dividendYield, spot, t1, t2, mildSkewArbitrageFree } = fixture.q4;
    const fwd1 = spot * Math.exp((rate - dividendYield) * t1);
    const fwd2 = spot * Math.exp((rate - dividendYield) * t2);
    const oneSlice = buildVolSurface([
      {
        timeToExpiry: t1,
        expirySec: 1_800_000_000,
        forward: fwd1,
        spot,
        rate,
        dividendYield,
        quotes: mildSkewArbitrageFree.strikes.map((k, idx) => ({
          strike: k,
          contractType: k >= fwd1 ? 'call' : 'put',
          iv: mildSkewArbitrageFree.ivsT1[idx] ?? 0.25,
          bid: 1.9,
          ask: 2.1,
          openInterest: 100,
        })),
      },
    ]);
    expect(oneSlice.butterflyCheckStatus).toBe('PASS');
    expect(oneSlice.butterflyArbitrageFree).toBe(true);
    expect(oneSlice.calendarCheckStatus).toBe('NOT_EVALUATED');
    expect(oneSlice.calendarArbitrageFree).toBe(false);
    expect(oneSlice.arbitrageCheckStatus).toBe('NOT_EVALUATED');
    expect(oneSlice.isArbitrageFree).toBe(false);
    expect(validateSurfaceCalendarArbitrage(oneSlice.slices).status).toBe('NOT_EVALUATED');

    // Q4-9b: 2 valid slices + 1 invalid intermediate slice -> partial validation != PASS
    const partialSurface = buildVolSurface([
      {
        timeToExpiry: t1,
        expirySec: 1_800_000_000,
        forward: fwd1,
        spot,
        rate,
        dividendYield,
        quotes: mildSkewArbitrageFree.strikes.map((k, idx) => ({
          strike: k,
          contractType: k >= fwd1 ? 'call' : 'put',
          iv: mildSkewArbitrageFree.ivsT1[idx] ?? 0.25,
          bid: 1.9,
          ask: 2.1,
          openInterest: 100,
        })),
      },
      {
        timeToExpiry: 0.5 * (t1 + t2),
        expirySec: 1_801_296_000,
        forward: 0.5 * (fwd1 + fwd2),
        spot,
        rate,
        dividendYield,
        quotes: [], // invalid slice
      },
      {
        timeToExpiry: t2,
        expirySec: 1_802_592_000,
        forward: fwd2,
        spot,
        rate,
        dividendYield,
        quotes: mildSkewArbitrageFree.strikes.map((k, idx) => ({
          strike: k,
          contractType: k >= fwd2 ? 'call' : 'put',
          iv: mildSkewArbitrageFree.ivsT2[idx] ?? 0.255,
          bid: 1.9,
          ask: 2.1,
          openInterest: 100,
        })),
      },
    ]);
    expect(partialSurface.validSlicesCount).toBe(2);
    expect(partialSurface.invalidSlicesCount).toBe(1);
    expect(partialSurface.arbitrageCheckStatus).toBe('NOT_EVALUATED');
    expect(partialSurface.isArbitrageFree).toBe(false);
  });

  it('Q4-10: propagación HTTP /api/snapshot, /api/options/expiry, mapUsSnapshotToArOptions y GgalSpecialistRuntime', async () => {
    const rthNowSec = Math.floor(Date.UTC(2026, 9, 15, 18, 30, 0) / 1_000);
    const expDate = utcDatePlusDays(rthNowSec, 30).date;
    // RTH GGAL missing BBO -> zero fabricated slices & zero executable OPRA legs in GgalSpecialistRuntime
    const contracts: MockRawContractSpec[] = [45, 50, 55].map((k) => ({
      ticker: occTicker('GGAL', expDate, k >= 50 ? 'call' : 'put', k),
      contractType: k >= 50 ? 'call' : 'put',
      strike: k,
      expirationDate: expDate,
      exerciseStyle: 'american',
      underlyingTicker: 'GGAL',
      bid: 0,
      ask: 0,
      dayClose: 1.5,
    }));

    const runtime = new MarketRuntime({
      apiKey: 'q4-http-e2e-key',
      secrets: ['q4-http-e2e-key'],
      enableWs: false,
      nowMsFn: () => rthNowSec * 1_000,
      fetchFn: createOfflineMassiveFetch({
        symbol: 'GGAL',
        isIndex: false,
        spot: 50,
        nowSec: rthNowSec,
        marketStatus: 'open',
        treasuryYieldPct: 4,
        sofrPct: 4,
        contracts,
      }),
    });

    const arRuntime = new ArgentinaMarketRuntime({
      fetchFn: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: {},
          text: JSON.stringify({}),
        }),
      secrets: ['q4-http-e2e-key'],
      nowMsFn: () => rthNowSec * 1_000,
      minData912IntervalMs: 0,
      usRuntime: runtime,
    });
    const ggalSpecialist = new GgalSpecialistRuntime({
      runtime,
      arRuntime,
      secrets: ['q4-http-e2e-key'],
      nowMsFn: () => rthNowSec * 1_000,
    });

    const server = createHttpWsServer({
      runtime,
      arRuntime,
      ggalRuntime: ggalSpecialist,
      host: '127.0.0.1',
      port: 0,
      secrets: ['q4-http-e2e-key'],
      startRuntimeWs: false,
    });
    servers.push(server);
    const { host, port } = await server.start();
    const base = `http://${host}:${String(port)}`;

    const snapRes = await fetch(`${base}/api/snapshot?symbol=GGAL&expiration=${expDate}&prefetch=0`);
    expect(snapRes.status).toBe(200);
    const snapJson = (await snapRes.json()) as UsSnapshotResponseDto;
    expect(snapJson.volSurfaceSummary?.surfaceMode).toBe('UNAVAILABLE');
    expect(snapJson.volSurfaceSummary?.surfaceQuality).toBe('MISSING_BBO');
    expect(snapJson.volSurfaceSummary?.isArbitrageFree).toBe(false);
    expect(snapJson.volSurfaceSummary?.slices).toEqual([]);

    const expRes = await fetch(`${base}/api/options/expiry?symbol=GGAL&expiration=${expDate}`);
    expect(expRes.status).toBe(200);
    const expJson = (await expRes.json()) as UsOptionExpiryChainResponse;
    expect(expJson.slice).toBeNull();
    expect(expJson.contracts.every((c) => c.bid === null && c.ask === null && c.quoteQuality === 'MISSING_BBO')).toBe(true);

    // Web adapter must mark missing slice butterflyArbitrageFree as false (never ?? true!)
    const mappedWeb = mapUsSnapshotToArOptions('GGAL', snapJson);
    expect(mappedWeb.expiries.length).toBeGreaterThan(0);
    for (const expEntry of mappedWeb.expiries) {
      expect(expEntry.butterflyArbitrageFree).toBe(false);
    }

    // Also verify policy utility preserves strictness on missing/stale quotes
    const missingContract = makeSnapshotContract({
      ticker: 'O:GGAL261120C00050000',
      contractType: 'call',
      strike: 50,
      expirationDate: expDate,
      expiryUtcSec: rthNowSec + 30 * 86_400,
      underlyingTicker: 'GGAL',
      spot: 50,
      bid: 0,
      ask: 0,
      dayClose: 1.5,
      lastTradePrice: 1.5,
    });
    expect(resolveQuoteMidForPolicy(missingContract, 'RTH_STRICT_BBO', rthNowSec)).toMatchObject({
      quoteQuality: 'MISSING_BBO',
    });
    expect(resolveQuoteMidForPolicy(missingContract, 'EOD_CLOSE_REF', rthNowSec)).toMatchObject({
      quoteQuality: 'EOD_CLOSE_REF',
      mid: 1.5,
    });
    expect(ggalSpecialist).toBeDefined();
  });
});
