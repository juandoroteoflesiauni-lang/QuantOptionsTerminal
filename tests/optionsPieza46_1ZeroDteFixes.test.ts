import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateBuyWrite } from '../src/core/options/syntheticRates.js';
import { extractRiskNeutralDistributionQ } from '../src/core/options/probabilisticDivergence.js';
import {
  computeActiveExpiryVrpAndRegime,
  computeParityAndSyntheticRatesByStrike,
  computeRatiosAndStructureCosts,
} from '../src/core/options/volAnalyticsSuite.js';
import { evaluateWhatIfPoint, simulateWhatIfPayoffSurface } from '../src/core/options/whatIfPayoff.js';
import {
  SHORT_PREMIUM_RISK_MESSAGE,
  annualizeEffectiveRate,
  buildHardenedBlDensity,
  calendarDteEt,
  computeFallbackGreeks,
  evaluateShortPremiumBreaker,
  expectedMoveSigma,
  findBreakevens,
  formatBreakevenLabel,
  formatDteLabel,
  hoursRemainingGrid,
  hoursToCloseEt,
  includeInParityCpPp,
  isRatioCardValid,
  normalizeOratsVolDecimal,
  oratsVolToPct,
  pickSigmaStrikes,
  sanitizeContractIv,
  timeYearsFromHours,
  todayEtDate,
} from '../src/core/options/zeroDteFixes.js';
import { OratsHybridClient } from '../src/server/oratsHybridClient.js';

interface Pieza46_1ReferenceFixture {
  readonly oratsScale: readonly {
    readonly raw: number;
    readonly expected: number | null;
  }[];
  readonly fallbackGreeks: readonly {
    readonly input: {
      readonly side: 'call' | 'put';
      readonly spot: number;
      readonly strike: number;
      readonly t: number;
      readonly rate: number;
      readonly q: number;
      readonly contractIv: number | null;
      readonly extrinsic: number;
      readonly ivAtm: number;
    };
    readonly expected: {
      readonly iv: number | null;
      readonly delta: number;
      readonly gamma: number;
      readonly vega: number;
      readonly theta: number;
      readonly source: 'CONTRACT_IV' | 'ATM_FALLBACK' | 'DEEP_ITM_INTRINSIC' | 'NO_DATA';
    };
  }[];
  readonly annualize: readonly {
    readonly periodReturn: number;
    readonly dte: number;
    readonly annualizedRate: number | null;
    readonly rateStatus: 'OK' | 'BLOCKED_SHORT_DTE' | 'NO_DATA';
  }[];
  readonly et: readonly {
    readonly utc: string;
    readonly nowMs: number;
    readonly todayEt: string;
    readonly hoursToClose: number;
    readonly dte: readonly {
      readonly expiry: string;
      readonly dte: number;
    }[];
  }[];
  readonly breaker: readonly {
    readonly dte: number;
    readonly spot: number;
    readonly putWall: number | null;
    readonly netGex: number;
    readonly blocked: boolean;
  }[];
  readonly sigmaStrikes: readonly {
    readonly spot: number;
    readonly ivAtm: number;
    readonly t: number;
    readonly strikes: readonly number[];
    readonly expectedMove: number;
    readonly minus2: number;
    readonly minus1: number;
    readonly plus1: number;
    readonly plus2: number;
  }[];
  readonly ratioCards: readonly {
    readonly a: number;
    readonly b: number;
    readonly valid: boolean;
  }[];
  readonly blDensity: readonly {
    readonly input: {
      readonly spot: number;
      readonly rate: number;
      readonly q: number;
      readonly t: number;
      readonly dte: number;
      readonly expectedMove: number;
      readonly nodes: readonly {
        readonly strike: number;
        readonly iv: number | null;
        readonly bid: number;
        readonly ask?: number;
      }[];
    };
    readonly expected: {
      readonly usedNodes: number;
      readonly step: number;
      readonly rawArea: number;
      readonly strikes: readonly number[];
      readonly density: readonly number[];
    };
  }[];
  readonly breakevens: {
    readonly spots: readonly number[];
    readonly pnl: readonly number[];
    readonly expected: readonly number[];
  };
  readonly hoursGrid: readonly {
    readonly start: number;
    readonly step: number;
    readonly expected: readonly number[];
  }[];
  readonly hoursToYears: readonly {
    readonly h: number;
    readonly t: number;
  }[];
}

const TOL = 1e-9;
const fx = JSON.parse(
  readFileSync(resolve(__dirname, '../fixtures/options_pieza46_1_reference.json'), 'utf-8'),
) as Pieza46_1ReferenceFixture;

function close(a: number, b: number, tol = TOL): void {
  expect(Number.isFinite(a)).toBe(true);
  expect(Math.abs(a - b)).toBeLessThanOrEqual(tol * Math.max(1, Math.abs(b)));
}

describe('Pieza 46.1 — referencia Python independiente e integración', () => {
  it('1. escala ORATS: normaliza % a decimal y evita doble * 100 (nunca 3.582,0%)', async () => {
    for (const c of fx.oratsScale) {
      const v = normalizeOratsVolDecimal(c.raw);
      if (c.expected === null) expect(Number.isNaN(v)).toBe(true);
      else close(v, c.expected);
    }
    close(normalizeOratsVolDecimal(35.82), 0.3582);
    close(oratsVolToPct(0.3582), 35.82);
    close(oratsVolToPct(35.82), 35.82);

    const client = new OratsHybridClient({
      env: { ORATS_API_KEY: 'test-orats-key' },
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
                        ticker: 'AAPL',
                        tradeDate: '2026-11-20',
                        stockPrice: 220,
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
                        impliedMove: 0.04,
                        annIdiv: 1.0,
                        impliedNextDiv: 0.25,
                        borrow30: 0.005,
                        yieldRate: 0.0045,
                      },
                    ],
                  }
                : { data: [] },
            ),
          text: () => Promise.resolve('{}'),
        }),
    });

    const surface = await client.fetchHybridSurface({
      ticker: 'AAPL',
      massiveSpotPrice: 220,
      massiveSpotSourceMode: 'MASSIVE_NBBO',
      yangZhangAdrVol: 0.3,
      forceRefresh: true,
    });
    expect(surface.status).toBe('OPERATIONAL');
    if (surface.status === 'OPERATIONAL') {
      close(surface.iv20d, 0.3582);
      close(surface.exErnIv30d, 0.3582);
      close(surface.smvVol, 0.3582);
      close(oratsVolToPct(surface.iv20d), 35.82);
    }
  });

  it('2. griegas fallback ATM / deep ITM y exclusión de IV capada >= 999% en paridad C-P', () => {
    for (const c of fx.fallbackGreeks) {
      const i = c.input;
      const r = computeFallbackGreeks({
        side: i.side,
        spot: i.spot,
        strike: i.strike,
        timeToExpiry: i.t,
        rate: i.rate,
        dividendYield: i.q,
        contractIv: i.contractIv,
        extrinsic: i.extrinsic,
        ivAtm: i.ivAtm,
      });
      expect(r.source).toBe(c.expected.source);
      expect(r.iv).toBe(c.expected.iv);
      for (const k of ['delta', 'gamma', 'vega', 'theta'] as const) close(r[k], c.expected[k]);
    }
    expect(sanitizeContractIv(9.99, 1)).toBeNull();
    expect(sanitizeContractIv(0.3, 0.01)).toBeNull();
    expect(sanitizeContractIv(0.3, 0.5)).toBe(0.3);
    expect(includeInParityCpPp(0.3, 1, 9.99, 1)).toBe(false);
    expect(includeInParityCpPp(0.3, 1, 0.3, 1)).toBe(true);

    const parity = computeParityAndSyntheticRatesByStrike({
      spotMid: 100,
      daysToExpiry: 10,
      dividendYield: 0,
      benchmarkTeaPct: 4.5,
      pairs: [
        {
          strike: 170,
          callBid: 0.01,
          callAsk: 0.02,
          callMid: 0.015,
          callIvPct: 999,
          putBid: 69.95,
          putAsk: 70.05,
          putMid: 70.0,
          putIvPct: 999,
        },
        {
          strike: 100,
          callBid: 2.4,
          callAsk: 2.5,
          callMid: 2.45,
          callIvPct: 32.0,
          putBid: 2.2,
          putAsk: 2.3,
          putMid: 2.25,
          putIvPct: 31.0,
        },
      ],
    });
    const deepItmRow = parity.strikes.find((r) => r.strike === 170);
    expect(deepItmRow).toBeDefined();
    expect(Number.isNaN(deepItmRow?.putIvPct ?? 0)).toBe(true);
    expect(Number.isNaN(deepItmRow?.ivSpreadPp ?? 0)).toBe(true);
    const atmRow = parity.strikes.find((r) => r.strike === 100);
    expect(atmRow).toBeDefined();
    close(atmRow?.ivSpreadPp ?? Number.NaN, 1.0);
  });

  it('3. gate BLOCKED_SHORT_DTE en Buy-Write cuando DTE < 3', () => {
    for (const c of fx.annualize) {
      const r = annualizeEffectiveRate(c.periodReturn, c.dte);
      expect(r.rateStatus).toBe(c.rateStatus);
      if (c.annualizedRate === null) expect(r.annualizedRate).toBeNull();
      else {
        expect(r.annualizedRate).not.toBeNull();
        close(r.annualizedRate ?? Number.NaN, c.annualizedRate);
      }
    }

    const blockedBw = evaluateBuyWrite({
      spotAsk: 100,
      strike: 101,
      callBid: 0.85,
      timeToExpiry: 1 / 365,
      vatRate: 0,
    });
    expect(blockedBw.status).toBe('OK');
    expect(blockedBw.rateStatus).toBe('BLOCKED_SHORT_DTE');
    expect(blockedBw.annualizedRate).toBeNull();
    expect(Number.isNaN(blockedBw.staticAnnualizedTna)).toBe(true);
    expect(Number.isNaN(blockedBw.assignedAnnualizedTna)).toBe(true);

    const openBw = evaluateBuyWrite({
      spotAsk: 100,
      strike: 105,
      callBid: 2.2,
      timeToExpiry: 30 / 365,
      vatRate: 0,
    });
    expect(openBw.rateStatus).toBe('OK');
    expect(openBw.annualizedRate).not.toBeNull();
    expect(Number.isFinite(openBw.staticAnnualizedTna)).toBe(true);
  });

  it('4a. DTE en America/New_York, etiqueta 0DTE y horas reales hasta las 16:00 ET', () => {
    for (const c of fx.et) {
      expect(todayEtDate(c.nowMs)).toBe(c.todayEt);
      close(hoursToCloseEt(c.nowMs), c.hoursToClose);
      for (const d of c.dte) expect(calendarDteEt(d.expiry, c.nowMs)).toBe(d.dte);
    }
    expect(formatDteLabel(0)).toBe('0DTE');
    expect(formatDteLabel(1)).toBe('1d');
    const firstEt = fx.et[0];
    expect(firstEt).toBeDefined();
    if (firstEt !== undefined) {
      expect(Number.isNaN(calendarDteEt('2020-01-01', firstEt.nowMs))).toBe(true);
    }
  });

  it('4b. circuit breaker de venta de prima (0DTE/1DTE o Short Gamma < Put Wall)', () => {
    for (const c of fx.breaker) {
      const r = evaluateShortPremiumBreaker({
        dte: c.dte,
        spot: c.spot,
        putWall: c.putWall,
        netGex: c.netGex,
      });
      expect(r.blocked).toBe(c.blocked);
      expect(r.autoSelectCreditMode).toBe(!c.blocked);
      expect(r.status).toBe(c.blocked ? 'NO_SHORT_PREMIUM_RISK' : 'OK');
    }

    const blockedZeroDte = computeActiveExpiryVrpAndRegime({
      expiryCode: '2026-11-20',
      daysToExpiry: 0,
      ivAtmActiveExpiryPct: 45,
      rvReferencePct: 20,
      fallbackIvRank: 85,
      spot: 100,
      putWallStrike: 95,
      netGex: 100_000,
    });
    expect(blockedZeroDte.status).toBe('OK');
    expect(blockedZeroDte.daysToExpiry).toBe(0);
    expect(blockedZeroDte.operativeRegime.code).toBe('NO_SHORT_PREMIUM_RISK');
    expect(blockedZeroDte.operativeRegime.label).toBe(SHORT_PREMIUM_RISK_MESSAGE);

    const blockedShortGamma = computeActiveExpiryVrpAndRegime({
      expiryCode: '2026-12-04',
      daysToExpiry: 14,
      ivAtmActiveExpiryPct: 45,
      rvReferencePct: 20,
      fallbackIvRank: 85,
      spot: 94,
      putWallStrike: 95,
      netGex: -50_000,
    });
    expect(blockedShortGamma.operativeRegime.code).toBe('NO_SHORT_PREMIUM_RISK');
    expect(blockedShortGamma.operativeRegime.label).toBe(SHORT_PREMIUM_RISK_MESSAGE);
  });

  it('5. strikes dinámicos ±1σ/±2σ y filtro cero en Ratios 1x2', () => {
    for (const c of fx.sigmaStrikes) {
      close(expectedMoveSigma(c.spot, c.ivAtm, c.t), c.expectedMove);
      const r = pickSigmaStrikes(c.spot, c.ivAtm, c.t, c.strikes);
      expect([r.minus2, r.minus1, r.plus1, r.plus2]).toEqual([c.minus2, c.minus1, c.plus1, c.plus2]);
    }
    for (const c of fx.ratioCards) expect(isRatioCardValid(c.a, c.b)).toBe(c.valid);

    const ratios = computeRatiosAndStructureCosts({
      spot: 100,
      daysToExpiry: 0,
      rate: 0.04,
      dividendYield: 0,
      ivAtmDec: 0.25,
      strikes: [
        { strike: 96, callBid: 4.1, callAsk: 4.2, callMid: 4.15, putBid: 0.002, putAsk: 0.004, putMid: 0.003 },
        { strike: 99, callBid: 1.5, callAsk: 1.6, callMid: 1.55, putBid: 0.35, putAsk: 0.4, putMid: 0.375 },
        { strike: 100, callBid: 0.85, callAsk: 0.9, callMid: 0.875, putBid: 0.8, putAsk: 0.85, putMid: 0.825 },
        { strike: 101, callBid: 0.35, callAsk: 0.4, callMid: 0.375, putBid: 1.45, putAsk: 1.55, putMid: 1.5 },
        { strike: 102, callBid: 0.1, callAsk: 0.14, callMid: 0.12, putBid: 2.2, putAsk: 2.3, putMid: 2.25 },
      ],
    });
    expect(ratios.callRatios.length).toBeGreaterThan(0);
    expect(ratios.putRatios.every((row) => row.shortPrice > 0.005)).toBe(true);
  });

  it('6. densidad BL endurecida: filtrado, PCHIP, grilla uniforme y área = 1', () => {
    for (const c of fx.blDensity) {
      const i = c.input;
      const r = buildHardenedBlDensity({
        spot: i.spot,
        rate: i.rate,
        dividendYield: i.q,
        timeToExpiry: i.t,
        dte: i.dte,
        expectedMove: i.expectedMove,
        nodes: i.nodes,
      });
      expect(r.status).toBe('OK');
      expect(r.usedNodes).toBe(c.expected.usedNodes);
      expect(r.nodes.length).toBe(c.expected.strikes.length);
      close(r.step, c.expected.step);
      close(r.rawArea, c.expected.rawArea, 1e-9);
      r.nodes.forEach((n, j) => {
        const expStrike = c.expected.strikes[j];
        const expDens = c.expected.density[j];
        expect(expStrike).toBeDefined();
        expect(expDens).toBeDefined();
        if (expStrike !== undefined && expDens !== undefined) {
          close(n.strike, expStrike);
          close(n.densityQ, expDens);
        }
        expect(n.densityQ).toBeGreaterThanOrEqual(0);
      });
      let area = 0;
      for (let j = 0; j < r.nodes.length - 1; j += 1) {
        const n0 = r.nodes[j];
        const n1 = r.nodes[j + 1];
        if (n0 !== undefined && n1 !== undefined) {
          area += 0.5 * (n0.densityQ + n1.densityQ) * r.step;
        }
      }
      close(area, 1.0);
    }

    const firstBl = fx.blDensity[0];
    expect(firstBl).toBeDefined();
    if (firstBl !== undefined) {
      const q = extractRiskNeutralDistributionQ({
        spot: firstBl.input.spot,
        rate: firstBl.input.rate,
        dividendYield: firstBl.input.q,
        timeToExpiry: firstBl.input.t,
        dte: 0,
        expectedMove: firstBl.input.expectedMove,
        smoothTotalVariancePchip: true,
        smoothShortDteDensity: true,
        nodes: firstBl.input.nodes.filter(
          (n): n is { readonly strike: number; readonly iv: number; readonly bid: number; readonly ask?: number } =>
            n.iv !== null,
        ),
      });
      expect(q.status).toBe('OK');
      expect(q.nodes.every((n) => n.densityQ >= 0)).toBe(true);
      close(q.normalizedArea, 1.0);
    }
  });

  it('7. What-If intradiario en horas (T = hours / (365*24)) y breakevens exactos', () => {
    const be = findBreakevens(fx.breakevens.spots, fx.breakevens.pnl);
    expect(be.length).toBe(fx.breakevens.expected.length);
    be.forEach((v, j) => {
      const expBe = fx.breakevens.expected[j];
      expect(expBe).toBeDefined();
      if (expBe !== undefined) close(v, expBe);
    });
    for (const c of fx.hoursGrid) {
      const g = hoursRemainingGrid(c.start, c.step);
      expect(g.length).toBe(c.expected.length);
      g.forEach((v, j) => {
        const expHour = c.expected[j];
        expect(expHour).toBeDefined();
        if (expHour !== undefined) close(v, expHour);
      });
    }
    for (const c of fx.hoursToYears) close(timeYearsFromHours(c.h), c.t);
    expect(formatBreakevenLabel(101.5)).toBe('BE $101.50');

    // Valuación What-If 0DTE a 2.5 horas restantes vs 4.5 horas iniciales
    const startHours = 4.5;
    const targetHours = 2.5;
    const t0 = timeYearsFromHours(startHours);
    const pt = evaluateWhatIfPoint({
      spot: 100,
      rate: 0.04,
      dividendYield: 0,
      ivShiftPts: 0,
      elapsedDays: (startHours - targetHours) / 24,
      horizonDte: startHours / 24,
      contracts: 1,
      contractMultiplier: 100,
      legs: [{ id: 'c100', contractType: 'call', strike: 100, quantity: 1, iv: 0.35, timeToExpiry: t0, entryPrice: 0.32 }],
    });
    const surf = simulateWhatIfPayoffSurface({
      referenceSpot: 100,
      rate: 0.04,
      dividendYield: 0,
      ivShiftPts: 0,
      elapsedDays: (startHours - targetHours) / 24,
      horizonDte: startHours / 24,
      contracts: 1,
      contractMultiplier: 100,
      extraSpots: [100],
      legs: [{ id: 'c100', contractType: 'call', strike: 100, quantity: 1, iv: 0.35, timeToExpiry: t0, entryPrice: 0.32 }],
    });
    const curveBe = findBreakevens(
      surf.curve.map((p) => p.spot),
      surf.curve.map((p) => p.pnlExpiry),
    );
    expect(Number.isFinite(pt.pnlTn)).toBe(true);
    expect(curveBe).toHaveLength(1);
    close(curveBe[0] ?? Number.NaN, 100.32);
  });
});
