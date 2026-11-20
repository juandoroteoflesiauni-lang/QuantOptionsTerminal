import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIN_CREDIT_PER_SHARE,
  rankCreditStructures,
  resolveDefaultSpreadModeFromRegime,
  type CreditOptionQuoteInput,
} from '../src/core/terminal/structureOptimizer.js';
import { evaluateCatalystWindow } from '../src/core/options/catalysts.js';
import {
  computeForwardIvPair,
  computeForwardIvTermStructure,
} from '../src/core/options/volSurface.js';
import {
  evaluateWhatIfPoint,
  simulateWhatIfPayoffSurface,
} from '../src/core/options/whatIfPayoff.js';
import {
  classifyDealerGammaRegime,
  computeDealerExposure,
} from '../src/core/options/exposure.js';
import {
  parseFmpEarningsCalendar,
  parseFmpEconomicCalendarMacroEvents,
} from '../src/server/fmpClient.js';
import { MarketRuntime } from '../src/server/marketRuntime.js';
import type { FetchResponse } from '../src/data/types.js';

interface CreditExpectedFixture {
  readonly id: string;
  readonly kind: 'BULL_PUT_SPREAD' | 'BEAR_CALL_SPREAD' | 'IRON_CONDOR';
  readonly widthPerShare: number;
  readonly netCreditPerShare: number;
  readonly creditPctOfWidth: number;
  readonly maxProfitContract: number;
  readonly maxLossPerShare: number;
  readonly maxLossContract: number;
  readonly breakevens: readonly number[];
  readonly pop: number;
  readonly expectedValuePerShare: number;
  readonly expectedValueContract: number;
  readonly netThetaDaily: number;
  readonly netVegaPer1Pct: number;
  readonly absThetaToVegaRatio: number | null;
  readonly bidAskPctOfMid: number;
  readonly compositeScore: number;
}

interface WhatIfFixtureCase {
  readonly name: string;
  readonly input: {
    readonly spot: number;
    readonly evalSpot: number;
    readonly rate: number;
    readonly dividendYield: number;
    readonly legs: readonly {
      readonly contractType: 'call' | 'put';
      readonly strike: number;
      readonly quantity: number;
      readonly iv: number;
      readonly timeToExpiry: number;
      readonly entryPrice: number;
    }[];
    readonly ivShiftPts: number;
    readonly elapsedDays: number;
    readonly horizonDte: number;
    readonly contracts: number;
    readonly contractMultiplier: number;
  };
  readonly expected: {
    readonly pnlT0: number;
    readonly pnlTn: number;
    readonly pnlExpiry: number;
    readonly pnlTnZeroIvShift: number;
    readonly ivShockPnlAttribution: number;
    readonly timeDecayPnlAttribution: number;
    readonly valuePerUnitT0: number;
    readonly valuePerUnitTn: number;
    readonly valuePerUnitExpiry: number;
    readonly greeksTn: {
      readonly deltaPerUnit: number;
      readonly gammaPerUnit: number;
      readonly thetaDailyPerUnit: number;
      readonly vegaPer1PctPerUnit: number;
      readonly deltaShares: number;
      readonly gammaShares: number;
      readonly thetaDailyUsd: number;
      readonly vegaPer1PctUsd: number;
    };
  };
}

interface Pieza46Fixture {
  readonly meta: { readonly tolerance: number };
  readonly creditSpreadsAndIronCondors: {
    readonly inputs: {
      readonly spot: number;
      readonly daysToExpiry: number;
      readonly rate: number;
      readonly dividendYield: number;
      readonly atmIv: number;
      readonly lotSize: number;
      readonly contracts: readonly CreditOptionQuoteInput[];
      readonly densityNodes: readonly { readonly strike: number; readonly densityQ: number }[];
    };
    readonly blExpected: readonly CreditExpectedFixture[];
    readonly lognormalExpected: readonly CreditExpectedFixture[];
    readonly excludedIds: readonly string[];
  };
  readonly forwardVolatility: readonly {
    readonly name: string;
    readonly nearTimeToExpiry: number;
    readonly nearIv: number;
    readonly farTimeToExpiry: number;
    readonly farIv: number;
    readonly forwardVariance: number | null;
    readonly forwardIv: number | null;
    readonly calendarArbFlag: boolean;
    readonly status: 'OK' | 'CALENDAR_ARB' | 'INVALID';
  }[];
  readonly catalysts: {
    readonly asOfUtcSec: number;
    readonly expiryInside7dUtcSec: number;
    readonly earningsInside3dUtcSec: number;
    readonly fomcInside2dUtcSec: number;
    readonly lastEarnings3dAgoUtcSec: number;
    readonly earningsOutside45dUtcSec: number;
  };
  readonly whatIfPayoff: readonly WhatIfFixtureCase[];
  readonly dealerExposure: readonly {
    readonly name: string;
    readonly spot: number;
    readonly nowUtcSec: number;
    readonly rate: number;
    readonly dividendYield: number;
    readonly contracts: readonly {
      readonly contractType: 'call' | 'put';
      readonly strike: number;
      readonly expiryUtcSec: number;
      readonly openInterest: number;
      readonly sharesPerContract: number;
      readonly iv: number;
    }[];
    readonly expected: {
      readonly regime: 'LONG_GAMMA' | 'SHORT_GAMMA' | 'NEUTRAL' | 'NO_DATA';
      readonly hasSufficientOi: boolean;
      readonly callGex: number;
      readonly putGex: number;
      readonly netGex: number;
      readonly callWallStrike: number | null;
      readonly putWallStrike: number | null;
      readonly zeroGammaSpot: number | null;
    };
  }[];
}

const FIXTURE_PATH = resolve(process.cwd(), 'fixtures', 'options_pieza46_reference.json');
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Pieza46Fixture;
const TOLERANCE = fixture.meta.tolerance;

function expectWithinTol(actual: number, expected: number, tol = TOLERANCE): void {
  expect(Number.isFinite(actual)).toBe(true);
  const absDiff = Math.abs(actual - expected);
  const scale = Math.abs(expected);
  if (scale <= 1) {
    expect(absDiff).toBeLessThanOrEqual(tol);
  } else {
    expect(absDiff / scale).toBeLessThanOrEqual(tol);
  }
}

describe('Pieza 46 — Toggle Crédito/Débito por Régimen y Ranking de Crédito (<= 1e-9)', () => {
  it('preselecciona Crédito en Venta de Prima Cubierta y Débito en Compra de Convexidad', () => {
    expect(resolveDefaultSpreadModeFromRegime('VENTA_PRIMA_CUBIERTA')).toBe('CREDIT');
    expect(resolveDefaultSpreadModeFromRegime('COMPRA_CONVEXIDAD_CALENDAR')).toBe('DEBIT');
    expect(resolveDefaultSpreadModeFromRegime('NEUTRAL_SELECTIVO')).toBe('DEBIT');
    expect(resolveDefaultSpreadModeFromRegime('NO_DATA')).toBe('DEBIT');
    expect(DEFAULT_MIN_CREDIT_PER_SHARE).toBe(0.1);
  });

  it('valida Bull Put, Bear Call e Iron Condor contra referencia Python usando densidad BL y filtros', () => {
    const inp = fixture.creditSpreadsAndIronCondors.inputs;
    const result = rankCreditStructures({
      spot: inp.spot,
      daysToExpiry: inp.daysToExpiry,
      rate: inp.rate,
      dividendYield: inp.dividendYield,
      atmIv: inp.atmIv,
      lotSize: inp.lotSize,
      contracts: inp.contracts,
      densityNodes: inp.densityNodes,
      operativeRegimeCode: 'VENTA_PRIMA_CUBIERTA',
    });

    expect(result.status).toBe('OK');
    expect(result.suggestedMode).toBe('CREDIT');
    expect(result.bestBullPut).not.toBeNull();
    expect(result.bestBearCall).not.toBeNull();
    expect(result.bestIronCondor).not.toBeNull();

    // Verifica que bid=0, Bid-Ask > 35% del Mid y crédito < $0.10 fueron excluidos
    const allIds = new Set(result.allCandidates.map((c) => c.id));
    for (const excludedId of fixture.creditSpreadsAndIronCondors.excludedIds) {
      expect(allIds.has(excludedId)).toBe(false);
    }

    for (const exp of fixture.creditSpreadsAndIronCondors.blExpected) {
      const actual = result.allCandidates.find((c) => c.id === exp.id);
      if (!actual) {
        throw new Error(`Missing BL candidate ${exp.id}`);
      }
      expect(actual.kind).toBe(exp.kind);
      expect(actual.popSource).toBe('BL_DENSITY');
      expectWithinTol(actual.widthPerShare, exp.widthPerShare);
      expectWithinTol(actual.netCreditPerShare, exp.netCreditPerShare);
      expectWithinTol(actual.creditPctOfWidth, exp.creditPctOfWidth);
      expectWithinTol(actual.maxProfitContract, exp.maxProfitContract);
      expectWithinTol(actual.maxLossPerShare, exp.maxLossPerShare);
      expectWithinTol(actual.maxLossContract, exp.maxLossContract);
      expect(actual.breakevens.length).toBe(exp.breakevens.length);
      for (let i = 0; i < exp.breakevens.length; i += 1) {
        const bAct = actual.breakevens[i];
        const bExp = exp.breakevens[i];
        if (bAct === undefined || bExp === undefined) {
          throw new Error('Missing breakeven element');
        }
        expectWithinTol(bAct, bExp);
      }
      expectWithinTol(actual.pop, exp.pop);
      expectWithinTol(actual.expectedValuePerShare, exp.expectedValuePerShare);
      expectWithinTol(actual.expectedValueContract, exp.expectedValueContract);
      expectWithinTol(actual.netThetaDaily, exp.netThetaDaily);
      expectWithinTol(actual.netVegaPer1Pct, exp.netVegaPer1Pct);
      if (exp.absThetaToVegaRatio !== null) {
        expectWithinTol(actual.absThetaToVegaRatio, exp.absThetaToVegaRatio);
      }
      expectWithinTol(actual.bidAskPctOfMid, exp.bidAskPctOfMid);
      expectWithinTol(actual.compositeScore, exp.compositeScore);
    }
  });

  it('valida POP y EV por lognormal analítica cuando falta densidad BL y degrada honestamente ante NO_DATA', () => {
    const inp = fixture.creditSpreadsAndIronCondors.inputs;
    const result = rankCreditStructures({
      spot: inp.spot,
      daysToExpiry: inp.daysToExpiry,
      rate: inp.rate,
      dividendYield: inp.dividendYield,
      atmIv: inp.atmIv,
      lotSize: inp.lotSize,
      contracts: inp.contracts,
    });

    expect(result.status).toBe('OK');
    for (const exp of fixture.creditSpreadsAndIronCondors.lognormalExpected) {
      const actual = result.allCandidates.find((c) => c.id === exp.id);
      if (!actual) {
        throw new Error(`Missing Lognormal candidate ${exp.id}`);
      }
      expect(actual.popSource).toBe('LOGNORMAL');
      expectWithinTol(actual.pop, exp.pop);
      expectWithinTol(actual.expectedValuePerShare, exp.expectedValuePerShare);
      expectWithinTol(actual.compositeScore, exp.compositeScore);
    }

    const noData = rankCreditStructures({
      spot: Number.NaN,
      daysToExpiry: 30,
      rate: 0.05,
      atmIv: 0.25,
      contracts: inp.contracts,
    });
    expect(noData.status).toBe('NO_DATA');
    expect(noData.allCandidates).toHaveLength(0);
    expect(noData.bestIronCondor).toBeNull();
  });
});

describe('Pieza 46 — Catalizadores (Earnings/FOMC/CPI) y Forward Volatility (<= 1e-9)', () => {
  it('calcula Forward IV contango/backwardation y marca calendarArbFlag: true cuando forwardVar <= 0', () => {
    for (const refCase of fixture.forwardVolatility) {
      const res = computeForwardIvPair({
        nearExpiryCode: 'T1',
        farExpiryCode: 'T2',
        nearTimeToExpiry: refCase.nearTimeToExpiry,
        farTimeToExpiry: refCase.farTimeToExpiry,
        nearIv: refCase.nearIv,
        farIv: refCase.farIv,
      });

      expect(res.status).toBe(refCase.status);
      expect(res.calendarArbFlag).toBe(refCase.calendarArbFlag);
      if (refCase.forwardVariance !== null) {
        expectWithinTol(res.forwardVariance, refCase.forwardVariance);
      }
      if (refCase.forwardIv === null) {
        expect(res.forwardIv).toBeNull();
      } else {
        expect(res.forwardIv).not.toBeNull();
        expectWithinTol(res.forwardIv ?? Number.NaN, refCase.forwardIv);
      }
    }

    const series = computeForwardIvTermStructure([
      { expiryCode: '2026-12-18', dte: 30, timeToExpiry: 30 / 365, atmIv: 0.22 },
      { expiryCode: '2027-01-15', dte: 60, timeToExpiry: 60 / 365, atmIv: 0.25 },
      { expiryCode: '2027-02-19', dte: 90, timeToExpiry: 90 / 365, atmIv: 0.19 },
    ]);
    expect(series).toHaveLength(2);
    expect(series[0]?.calendarArbFlag).toBe(false);
    expect(series[1]?.calendarArbFlag).toBe(true);
    expect(series[1]?.forwardIv).toBeNull();
  });

  it('cruza Earnings y FOMC/CPI contra el vencimiento activo con degradación honesta', () => {
    const c = fixture.catalysts;

    const earnInside = evaluateCatalystWindow({
      asOfUtcSec: c.asOfUtcSec,
      activeExpiryUtcSec: c.expiryInside7dUtcSec,
      nextEarnings: { date: '2026-11-23', utcSec: c.earningsInside3dUtcSec, timeOfDay: 'amc' },
      macroEvents: [
        { kind: 'FOMC', label: 'FOMC Rate Decision', date: '2026-11-22', utcSec: c.fomcInside2dUtcSec, impact: 'HIGH' },
      ],
    });
    expect(earnInside.status).toBe('EARNINGS_IN_EXPIRY');
    expect(earnInside.severity).toBe('DANGER');
    expect(earnInside.badgeLabel).toContain('DENTRO DEL VENCIMIENTO');
    expect(earnInside.earningsInsideExpiry).toBe(true);
    expect(earnInside.macroEventsInsideExpiry).toHaveLength(1);

    const macroOnlyInside = evaluateCatalystWindow({
      asOfUtcSec: c.asOfUtcSec,
      activeExpiryUtcSec: c.expiryInside7dUtcSec,
      nextEarnings: { date: '2027-01-04', utcSec: c.earningsOutside45dUtcSec, timeOfDay: 'bmo' },
      macroEvents: [
        { kind: 'FOMC', label: 'FOMC Rate Decision', date: '2026-11-22', utcSec: c.fomcInside2dUtcSec, impact: 'HIGH' },
      ],
    });
    expect(macroOnlyInside.status).toBe('MACRO_IN_EXPIRY');
    expect(macroOnlyInside.severity).toBe('DANGER');
    expect(macroOnlyInside.earningsInsideExpiry).toBe(false);

    const postEarn = evaluateCatalystWindow({
      asOfUtcSec: c.asOfUtcSec,
      activeExpiryUtcSec: c.expiryInside7dUtcSec,
      nextEarnings: { date: '2027-01-04', utcSec: c.earningsOutside45dUtcSec },
      lastEarnings: { date: '2026-11-17', utcSec: c.lastEarnings3dAgoUtcSec, epsActual: 2.1 },
      macroEvents: [],
    });
    expect(postEarn.status).toBe('POST_EARNINGS');
    expect(postEarn.severity).toBe('NEUTRAL');
    expect(postEarn.badgeLabel).toContain('Post-Earnings');

    const noData = evaluateCatalystWindow({
      asOfUtcSec: c.asOfUtcSec,
      activeExpiryUtcSec: c.expiryInside7dUtcSec,
      nextEarnings: null,
      macroEvents: [],
    });
    expect(noData.status).toBe('NO_DATA');
    expect(noData.badgeLabel).toBe('Sin evento en ventana');
  });

  it('parsea FMP Earnings/Economic Calendar, cachea 24h en MarketRuntime y nunca filtra secretos', async () => {
    const parsedEarn = parseFmpEarningsCalendar(
      [
        { symbol: 'AAPL', date: '2026-11-01', time: 'amc', epsEstimated: 1.5, epsActual: 1.62 },
        { symbol: 'AAPL', date: '2027-01-28', time: 'amc', epsEstimated: 2.1, epsActual: null },
        { symbol: 'MSFT', date: '2026-11-25', time: 'bmo', epsEstimated: 3.1, epsActual: null },
      ],
      'AAPL',
      1_795_000_000,
    );
    expect(parsedEarn.events).toHaveLength(2);
    expect(parsedEarn.nextEarnings?.date).toBe('2027-01-28');
    expect(parsedEarn.lastEarnings?.date).toBe('2026-11-01');

    const parsedMacro = parseFmpEconomicCalendarMacroEvents([
      { country: 'US', event: 'FOMC Rate Decision', date: '2026-12-16 14:00:00', impact: 'High' },
      { country: 'US', event: 'Core CPI m/m', date: '2026-12-10 08:30:00', impact: 'High' },
      { country: 'EU', event: 'CPI y/y', date: '2026-12-11 05:00:00', impact: 'High' },
    ]);
    expect(parsedMacro.map((m) => m.kind)).toEqual(['CPI', 'FOMC']);

    let nowMs = 1_795_000_000_000;
    let earningsHits = 0;
    let macroHits = 0;
    const fakeCalSecret = 'TEST_FMP_CAL_SECRET_XYZ';
    const fakeMacroSecret = 'TEST_FMP_MACRO_SECRET_ABC';

    const mockFetch = (url: string): Promise<FetchResponse> => {
      if (url.includes('/stable/earnings?')) {
        earningsHits += 1;
        return Promise.resolve({
          ok: true,
          status: 200,
          text: JSON.stringify([
            { symbol: 'AAPL', date: '2027-01-28', time: 'amc', epsEstimated: 2.15 },
          ]),
        });
      }
      if (url.includes('/stable/economic-calendar?')) {
        macroHits += 1;
        return Promise.resolve({
          ok: true,
          status: 200,
          text: JSON.stringify([
            { country: 'US', event: 'FOMC Press Conference', date: '2026-12-16 14:30:00', impact: 'High' },
          ]),
        });
      }
      return Promise.resolve({ ok: false, status: 404, text: '[]' });
    };

    const runtime = new MarketRuntime({
      apiKey: 'TEST_MASSIVE_UNUSED',
      fetchFn: mockFetch,
      nowMsFn: () => nowMs,
      enableWs: false,
      fmpConfig: {
        apiKey: null,
        quotesApiKey: null,
        marketApiKey: null,
        etfApiKey: null,
        macroApiKey: fakeMacroSecret,
        calendarsApiKey: fakeCalSecret,
        configured: true,
        baseUrl: 'https://financialmodelingprep.com',
      },
    });

    const first = await runtime.getSymbolCatalysts('AAPL');
    expect(first.available).toBe(true);
    expect(first.nextEarnings?.date).toBe('2027-01-28');
    expect(first.macroEvents).toHaveLength(1);
    expect(first.cacheHit).toBe(false);
    expect(earningsHits).toBe(1);
    expect(macroHits).toBe(1);

    // Segundo llamado a 2 horas -> hit diario 24h sin pegarle a FMP
    nowMs += 2 * 60 * 60 * 1_000;
    const cachedSecond = await runtime.getSymbolCatalysts('AAPL');
    expect(cachedSecond.cacheHit).toBe(true);
    expect(earningsHits).toBe(1);
    expect(macroHits).toBe(1);

    // Otro símbolo reusa el calendario macro cacheado pero consulta sus propios earnings
    const nvda = await runtime.getSymbolCatalysts('NVDA');
    expect(nvda.macroEvents).toHaveLength(1);
    expect(earningsHits).toBe(2);
    expect(macroHits).toBe(1);

    // Runtime que falla red redacta cualquier secreto de FMP
    const failingRuntime = new MarketRuntime({
      apiKey: 'TEST_MASSIVE_UNUSED',
      fetchFn: (url) => Promise.reject(new Error(`FMP boom at ${url}`)),
      enableWs: false,
      fmpConfig: {
        apiKey: null,
        quotesApiKey: null,
        marketApiKey: null,
        etfApiKey: null,
        macroApiKey: fakeMacroSecret,
        calendarsApiKey: fakeCalSecret,
        configured: true,
        baseUrl: 'https://financialmodelingprep.com',
      },
    });
    const failedRes = await failingRuntime.getSymbolCatalysts('AAPL');
    expect(failedRes.available).toBe(false);
    expect(failedRes.nextEarnings).toBeNull();
    expect(failedRes.reason ?? '').not.toContain(fakeCalSecret);
    expect(failedRes.reason ?? '').not.toContain(fakeMacroSecret);

    // Sin clave FMP configurada: degrada a available: false y nextEarnings: null
    const noFmpRuntime = new MarketRuntime({
      apiKey: 'TEST_MASSIVE_UNUSED',
      fetchFn: mockFetch,
      enableWs: false,
    });
    const noFmp = await noFmpRuntime.getSymbolCatalysts('AAPL');
    expect(noFmp.available).toBe(false);
    expect(noFmp.nextEarnings).toBeNull();
  });
});

describe('Pieza 46 — Simulador What-If BSM (T+0, T+n, ΔIV = -15 pts, Vencimiento <= 1e-9)', () => {
  it('valida todas las estructuras multipata (Bull Call, Bull Put, Iron Condor, Butterfly, Calendar) contra BSM Python', () => {
    for (const tc of fixture.whatIfPayoff) {
      const actual = evaluateWhatIfPoint({
        spot: tc.input.evalSpot,
        legs: tc.input.legs,
        rate: tc.input.rate,
        dividendYield: tc.input.dividendYield,
        ivShiftPts: tc.input.ivShiftPts,
        elapsedDays: tc.input.elapsedDays,
        horizonDte: tc.input.horizonDte,
        contracts: tc.input.contracts,
        contractMultiplier: tc.input.contractMultiplier,
      });

      expectWithinTol(actual.pnlT0, tc.expected.pnlT0);
      expectWithinTol(actual.pnlTn, tc.expected.pnlTn);
      expectWithinTol(actual.pnlExpiry, tc.expected.pnlExpiry);
      expectWithinTol(actual.pnlTnZeroIvShift, tc.expected.pnlTnZeroIvShift);
      expectWithinTol(actual.ivShockPnlAttribution, tc.expected.ivShockPnlAttribution);
      expectWithinTol(actual.timeDecayPnlAttribution, tc.expected.timeDecayPnlAttribution);
      expectWithinTol(actual.valuePerUnitT0, tc.expected.valuePerUnitT0);
      expectWithinTol(actual.valuePerUnitTn, tc.expected.valuePerUnitTn);
      expectWithinTol(actual.valuePerUnitExpiry, tc.expected.valuePerUnitExpiry);
      expectWithinTol(actual.greeksTn.deltaPerUnit, tc.expected.greeksTn.deltaPerUnit);
      expectWithinTol(actual.greeksTn.gammaPerUnit, tc.expected.greeksTn.gammaPerUnit);
      expectWithinTol(actual.greeksTn.thetaDailyPerUnit, tc.expected.greeksTn.thetaDailyPerUnit);
      expectWithinTol(actual.greeksTn.vegaPer1PctPerUnit, tc.expected.greeksTn.vegaPer1PctPerUnit);
      expectWithinTol(actual.greeksTn.deltaShares, tc.expected.greeksTn.deltaShares);
      expectWithinTol(actual.greeksTn.gammaShares, tc.expected.greeksTn.gammaShares);
      expectWithinTol(actual.greeksTn.thetaDailyUsd, tc.expected.greeksTn.thetaDailyUsd);
      expectWithinTol(actual.greeksTn.vegaPer1PctUsd, tc.expected.greeksTn.vegaPer1PctUsd);
    }

    // Iron Condor debe ganar dinero por IV crush (-15 pts) al ser short vega neto
    const icCase = fixture.whatIfPayoff.find((c) => c.name === 'iron_condor_iv_crush_spot_100');
    if (!icCase) throw new Error('Missing IC case');
    const icPoint = evaluateWhatIfPoint({
      spot: icCase.input.evalSpot,
      legs: icCase.input.legs,
      rate: icCase.input.rate,
      dividendYield: icCase.input.dividendYield,
      ivShiftPts: icCase.input.ivShiftPts,
      elapsedDays: icCase.input.elapsedDays,
      horizonDte: icCase.input.horizonDte,
    });
    expect(icPoint.ivShockPnlAttribution).toBeGreaterThan(0);

    // Superficie completa y degradación honesta NaN ante IV inválida
    const surface = simulateWhatIfPayoffSurface({
      referenceSpot: icCase.input.spot,
      legs: icCase.input.legs,
      rate: icCase.input.rate,
      dividendYield: icCase.input.dividendYield,
      ivShiftPts: -15,
      elapsedDays: 10,
      horizonDte: 30,
      gridSteps: 41,
    });
    expect(surface.curve.length).toBeGreaterThanOrEqual(41);

    const brokenSurface = simulateWhatIfPayoffSurface({
      referenceSpot: 100,
      legs: [{ contractType: 'call', strike: 100, quantity: 1, iv: Number.NaN, timeToExpiry: 30 / 365, entryPrice: 2 }],
      rate: 0.05,
      dividendYield: 0,
      ivShiftPts: 0,
      elapsedDays: 5,
      horizonDte: 30,
    });
    expect(Number.isNaN(brokenSurface.atSpot.pnlTn)).toBe(true);
    expect(brokenSurface.curve).toHaveLength(0);
  });
});

describe('Pieza 46 — Exposición Gamma de Dealers: Call Wall, Put Wall, Zero Gamma y Régimen (<= 1e-9)', () => {
  it('valida LONG_GAMMA, SHORT_GAMMA, niveles exactos y degradación honesta NO_DATA con OI insuficiente', () => {
    for (const tc of fixture.dealerExposure) {
      const exposure = computeDealerExposure(tc.contracts, {
        spot: tc.spot,
        nowUtcSec: tc.nowUtcSec,
        rate: tc.rate,
        dividendYield: tc.dividendYield,
      });
      const report = classifyDealerGammaRegime(exposure);

      expect(report.regime).toBe(tc.expected.regime);
      expect(report.hasSufficientOi).toBe(tc.expected.hasSufficientOi);

      if (!tc.expected.hasSufficientOi) {
        expect(Number.isNaN(report.zeroGammaSpot)).toBe(true);
        expect(Number.isNaN(report.callWallStrike)).toBe(true);
        expect(Number.isNaN(report.putWallStrike)).toBe(true);
        expect(report.creditStrategySignal).toBe('NO_DATA');
        continue;
      }

      expectWithinTol(exposure.callGex, tc.expected.callGex);
      expectWithinTol(exposure.putGex, tc.expected.putGex);
      expectWithinTol(exposure.netGex, tc.expected.netGex);
      expectWithinTol(report.netGex, tc.expected.netGex);
      expect(report.callWallStrike).toBe(tc.expected.callWallStrike);
      expect(report.putWallStrike).toBe(tc.expected.putWallStrike);

      if (tc.expected.regime === 'LONG_GAMMA') {
        expect(report.creditStrategySignal).toBe('GREEN_LIGHT');
      } else if (tc.expected.regime === 'SHORT_GAMMA') {
        expect(report.creditStrategySignal).toBe('CAUTION_SHORT_WINGS');
      }

      if (tc.expected.zeroGammaSpot === null) {
        expect(Number.isNaN(report.zeroGammaSpot)).toBe(true);
      } else {
        expectWithinTol(report.zeroGammaSpot, tc.expected.zeroGammaSpot);
      }
    }
  });
});
