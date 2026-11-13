import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { greeksBsm } from '../src/core/options/blackScholes.js';
import {
  buildVolTermStructure,
  computeIvAtm,
  computeSliceVolMetrics,
  interpolateTermIvAtm,
  solveDeltaStrikeAndIv,
  termSlope,
  termSpread,
  type DeltaConvention,
} from '../src/core/options/volMetrics.js';
import {
  buildVolSlice,
  buildVolSurface,
  computeDurrlemanDensity,
  evaluateSliceDerivatives,
  evaluateSliceIv,
  evaluateSliceIvAtStrike,
  evaluateSliceTotalVariance,
  evaluateSurfaceIvAtStrike,
  filterVolQuotes,
  interpolateSurfaceTotalVariance,
  validateSliceButterflyArbitrage,
  validateSurfaceCalendarArbitrage,
  type VolQuoteInput,
  type VolSliceInput,
  type VolSurfaceFilterOptions,
} from '../src/core/options/volSurface.js';

interface SampleQueryRef {
  readonly logMoneyness: number;
  readonly strike: number;
  readonly totalVariance: number;
  readonly dwDk: number;
  readonly d2wDk2: number;
  readonly iv: number;
  readonly durrlemanDensity: number;
}

interface SliceExpectedRef {
  readonly timeToExpiry: number;
  readonly forward: number;
  readonly ivAtm: number;
  readonly expectedMovePct: number;
  readonly delta25PutStrike: number;
  readonly delta25PutIv: number;
  readonly delta25CallStrike: number;
  readonly delta25CallIv: number;
  readonly riskReversal25: number;
  readonly butterfly25: number;
  readonly minButterflyDensity: number;
  readonly worstLogMoneyness: number;
  readonly sampleQueries: readonly SampleQueryRef[];
}

interface ConventionExpectedRef {
  readonly ivAtm: number;
  readonly delta25PutStrike: number;
  readonly delta25PutIv: number;
  readonly delta25CallStrike: number;
  readonly delta25CallIv: number;
  readonly riskReversal25: number;
  readonly butterfly25: number;
}

interface VolSurfaceFixture {
  readonly generator: string;
  readonly tolerance: number;
  readonly scenarioA_cleanTermSurface: {
    readonly sliceInputs: readonly VolSliceInput[];
    readonly sliceExpected: readonly SliceExpectedRef[];
    readonly surfaceInterpolation: {
      readonly tMid: number;
      readonly kFixed: number;
      readonly totalVarianceAtKFixed: number;
      readonly strikeQuery: number;
      readonly ivAtStrike: number;
      readonly ivAtmMid: number;
      readonly termSpread_7d_90d: number;
      readonly termSlope_7d_90d: number;
      readonly termSpread_18d_90d: number;
      readonly termSlope_18d_90d: number;
    };
  };
  readonly scenarioB_quoteFiltering: {
    readonly sliceInput: VolSliceInput;
    readonly filterOptions: VolSurfaceFilterOptions;
    readonly expectedCounts: Readonly<Record<string, number>>;
    readonly expectedStrikes: readonly number[];
    readonly expectedIvs: readonly number[];
    readonly expectedIvAtm: number;
  };
  readonly scenarioC_deltaConventions: {
    readonly sliceInput: VolSliceInput;
    readonly expectedImpliedDividendYield: number;
    readonly byConvention: Readonly<Record<DeltaConvention, ConventionExpectedRef>>;
  };
  readonly scenarioD_butterflySpike: {
    readonly sliceInput: VolSliceInput;
    readonly minDensity: number;
    readonly worstLogMoneyness: number;
    readonly worstStrike: number;
    readonly isArbitrageFree: boolean;
  };
  readonly scenarioE_calendarAndBackwardation: {
    readonly calendarViolation: {
      readonly slices: readonly VolSliceInput[];
      readonly expectedMinVarianceDiff: number;
    };
    readonly validBackwardation: {
      readonly slices: readonly VolSliceInput[];
      readonly expectedMinVarianceDiff: number;
      readonly expectedTermSpread: number;
      readonly expectedTermSlope: number;
    };
  };
}

const FIXTURE_PATH = resolve(process.cwd(), 'fixtures/vol_surface_reference.json');
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as VolSurfaceFixture;
const TOLERANCE = FIXTURE.tolerance;

let maxAbsDiff = 0;

function expectClose(actual: number, expected: number, tol = TOLERANCE): void {
  expect(Number.isFinite(actual)).toBe(true);
  const diff = Math.abs(actual - expected);
  if (diff > maxAbsDiff) {
    maxAbsDiff = diff;
  }
  expect(diff).toBeLessThanOrEqual(tol);
}

function deepFreeze<T>(obj: T): T {
  if (obj !== null && typeof obj === 'object') {
    Object.freeze(obj);
    for (const value of Object.values(obj as Record<string, unknown>)) {
      deepFreeze(value);
    }
  }
  return obj;
}

describe('volSurface & volMetrics (Pieza 5)', () => {
  afterAll(() => {
    console.info(`[volSurface.test] maxAbsDiff vs Python fixture = ${maxAbsDiff.toExponential(3)}`);
  });

  it('Scenario A: builds multi-expiry SPY surface, matches PCHIP, Durrleman g(k), BSM 25D, and term structure within 1e-9', () => {
    const scA = FIXTURE.scenarioA_cleanTermSurface;
    const frozenInputs = deepFreeze(structuredClone(scA.sliceInputs));
    const surface = buildVolSurface(frozenInputs);

    expect(surface.validSlicesCount).toBe(3);
    expect(surface.invalidSlicesCount).toBe(0);
    expect(surface.butterflyArbitrageFree).toBe(true);
    expect(surface.calendarArbitrageFree).toBe(true);
    expect(surface.isArbitrageFree).toBe(true);
    expect(surface.calendarCheck.minVarianceDiff).toBeGreaterThanOrEqual(0);

    for (let i = 0; i < surface.slices.length; i += 1) {
      const slice = surface.slices[i];
      const expected = scA.sliceExpected[i];
      const rawInput = scA.sliceInputs[i];
      expect(slice).toBeDefined();
      expect(expected).toBeDefined();
      expect(rawInput).toBeDefined();
      if (slice === undefined || expected === undefined || rawInput === undefined) {
        continue;
      }

      expect(slice.isValid).toBe(true);
      expectClose(slice.timeToExpiry, expected.timeToExpiry);
      expectClose(slice.forward, expected.forward);

      const metrics = computeSliceVolMetrics(slice, { deltaConvention: 'spotBsm' });
      expect(metrics.isButterflyArbitrageFree).toBe(true);
      expectClose(metrics.ivAtm, expected.ivAtm);
      expectClose(metrics.expectedMovePct, expected.expectedMovePct);
      expectClose(metrics.delta25PutStrike, expected.delta25PutStrike);
      expectClose(metrics.delta25PutIv, expected.delta25PutIv);
      expectClose(metrics.delta25CallStrike, expected.delta25CallStrike);
      expectClose(metrics.delta25CallIv, expected.delta25CallIv);
      expectClose(metrics.riskReversal25, expected.riskReversal25);
      expectClose(metrics.butterfly25, expected.butterfly25);

      // Independent round-trip verification against Pieza 2 BSM delta engine.
      const spot = rawInput.spot ?? Number.NaN;
      const rate = rawInput.rate ?? Number.NaN;
      const divYield = rawInput.dividendYield ?? Number.NaN;
      const putCheck = greeksBsm({
        spot,
        strike: metrics.delta25PutStrike,
        timeToExpiry: slice.timeToExpiry,
        rate,
        dividendYield: divYield,
        volatility: metrics.delta25PutIv,
        contractType: 'put',
      });
      const callCheck = greeksBsm({
        spot,
        strike: metrics.delta25CallStrike,
        timeToExpiry: slice.timeToExpiry,
        rate,
        dividendYield: divYield,
        volatility: metrics.delta25CallIv,
        contractType: 'call',
      });
      expectClose(putCheck.delta, -0.25, 1e-11);
      expectClose(callCheck.delta, 0.25, 1e-11);

      const bf = validateSliceButterflyArbitrage(slice);
      expect(bf.isArbitrageFree).toBe(true);
      expect(bf.violations.length).toBe(0);
      expectClose(bf.minDensity, expected.minButterflyDensity);
      expectClose(bf.worstLogMoneyness, expected.worstLogMoneyness);

      for (const qPt of expected.sampleQueries) {
        const deriv = evaluateSliceDerivatives(slice, qPt.logMoneyness);
        expectClose(deriv.totalVariance, qPt.totalVariance);
        expectClose(deriv.dwDk, qPt.dwDk);
        expectClose(deriv.d2wDk2, qPt.d2wDk2);
        expectClose(deriv.iv, qPt.iv);
        expectClose(evaluateSliceTotalVariance(slice, qPt.logMoneyness), qPt.totalVariance);
        expectClose(evaluateSliceIv(slice, qPt.logMoneyness), qPt.iv);
        expectClose(evaluateSliceIvAtStrike(slice, qPt.strike), qPt.iv);
        const dens = computeDurrlemanDensity(
          qPt.logMoneyness,
          deriv.totalVariance,
          deriv.dwDk,
          deriv.d2wDk2,
        );
        expectClose(dens, qPt.durrlemanDensity);
      }
    }

    const interpRef = scA.surfaceInterpolation;
    expectClose(
      interpolateSurfaceTotalVariance(surface, interpRef.tMid, interpRef.kFixed),
      interpRef.totalVarianceAtKFixed,
    );
    expectClose(
      evaluateSurfaceIvAtStrike(surface, interpRef.tMid, interpRef.strikeQuery),
      interpRef.ivAtStrike,
    );

    const term = buildVolTermStructure(surface);
    expect(term.length).toBe(3);
    expectClose(interpolateTermIvAtm(term, interpRef.tMid), interpRef.ivAtmMid);

    const t7d = scA.sliceExpected[0]?.timeToExpiry ?? Number.NaN;
    const t90d = scA.sliceExpected[2]?.timeToExpiry ?? Number.NaN;
    expectClose(termSpread(term, t7d, t90d), interpRef.termSpread_7d_90d);
    expectClose(termSlope(surface, t7d, t90d), interpRef.termSlope_7d_90d);
    expectClose(termSpread(surface, interpRef.tMid, t90d), interpRef.termSpread_18d_90d);
    expectClose(termSlope(term, interpRef.tMid, t90d), interpRef.termSlope_18d_90d);
  });

  it('Scenario B: filters bid=0, wide spread, low OI, invalid IV/strikes, selects OTM, and merges duplicate strikes cleanly', () => {
    const scB = FIXTURE.scenarioB_quoteFiltering;
    const frozenSliceInput = deepFreeze(structuredClone(scB.sliceInput));
    const frozenOpts = deepFreeze({ ...scB.filterOptions, forward: frozenSliceInput.forward });

    const filtered = filterVolQuotes(frozenSliceInput.quotes, frozenOpts);
    expect(filtered.validOptions).toBe(true);
    for (const [reason, expectedCount] of Object.entries(scB.expectedCounts)) {
      const actualCount =
        filtered.countsByReason[reason as keyof typeof filtered.countsByReason];
      expect(actualCount).toBe(expectedCount);
    }

    expect(filtered.aggregated.map((q) => q.strike)).toEqual(scB.expectedStrikes);
    for (let i = 0; i < scB.expectedIvs.length; i += 1) {
      const agg = filtered.aggregated[i];
      const expectedIv = scB.expectedIvs[i];
      expect(agg).toBeDefined();
      expect(expectedIv).toBeDefined();
      if (agg !== undefined && expectedIv !== undefined) {
        expectClose(agg.iv, expectedIv);
      }
    }

    const slice = buildVolSlice(frozenSliceInput, scB.filterOptions);
    expect(slice.isValid).toBe(true);
    expect(slice.report.rejectionReason).toBeNull();
    expect(slice.report.strikeNodesCount).toBe(scB.expectedStrikes.length);
    expectClose(computeIvAtm(slice), scB.expectedIvAtm);

    // Explicitly verify runtime NaN IV quote rejection + 'otmStrict' ITM exclusion.
    const strictQuotes: readonly VolQuoteInput[] = deepFreeze([
      { strike: 90, contractType: 'call', iv: 0.25, bid: 10.5, ask: 10.6, openInterest: 100 },
      { strike: 95, contractType: 'put', iv: Number.NaN, bid: 2.0, ask: 2.1, openInterest: 100 },
      { strike: 100, contractType: 'call', iv: 0.21, bid: 3.0, ask: 3.1, openInterest: 100 },
      { strike: 105, contractType: 'call', iv: 0.20, bid: 1.5, ask: 1.55, openInterest: 100 },
    ]);
    const strictRes = filterVolQuotes(strictQuotes, {
      forward: 100,
      quoteSelection: 'otmStrict',
    });
    expect(strictRes.countsByReason.invalidIv).toBe(1);
    expect(strictRes.countsByReason.nonOtmExcluded).toBe(1);
    expect(strictRes.aggregated.map((q) => q.strike)).toEqual([100, 105]);
  });

  it('Scenario C: solves 25-delta metrics under spotBsm (inferred q), forward, and discountedForward conventions', () => {
    const scC = FIXTURE.scenarioC_deltaConventions;
    const slice = buildVolSlice(deepFreeze(structuredClone(scC.sliceInput)));

    expect(slice.isValid).toBe(true);
    expectClose(slice.dividendYield, scC.expectedImpliedDividendYield);

    const conventions: readonly DeltaConvention[] = [
      'spotBsm',
      'forward',
      'discountedForward',
    ];
    for (const conv of conventions) {
      const ref = scC.byConvention[conv];
      const metrics = computeSliceVolMetrics(slice, { deltaConvention: conv });
      expectClose(metrics.ivAtm, ref.ivAtm);
      expectClose(metrics.delta25PutStrike, ref.delta25PutStrike);
      expectClose(metrics.delta25PutIv, ref.delta25PutIv);
      expectClose(metrics.delta25CallStrike, ref.delta25CallStrike);
      expectClose(metrics.delta25CallIv, ref.delta25CallIv);
      expectClose(metrics.riskReversal25, ref.riskReversal25);
      expectClose(metrics.butterfly25, ref.butterfly25);
    }

    // Without dividendYield or (spot, rate), spotBsm must NOT fall back to q=0; returns NaN.
    const bareSlice = buildVolSlice({
      timeToExpiry: scC.sliceInput.timeToExpiry,
      forward: scC.sliceInput.forward,
      quotes: scC.sliceInput.quotes,
    });
    const missingSpotBsm = solveDeltaStrikeAndIv(bareSlice, 0.25, 'call', {
      deltaConvention: 'spotBsm',
    });
    expect(missingSpotBsm.strike).toBeNaN();
    expect(missingSpotBsm.iv).toBeNaN();
    expect(
      solveDeltaStrikeAndIv(bareSlice, -0.25, 'put', {
        deltaConvention: 'discountedForward',
      }).strike,
    ).toBeNaN();
    // Forward delta works purely with forward F without needing spot, rate, or q.
    const fwdCall = solveDeltaStrikeAndIv(bareSlice, 0.25, 'call', {
      deltaConvention: 'forward',
    });
    expectClose(fwdCall.strike, scC.byConvention.forward.delta25CallStrike);
  });

  it('Scenario D: detects negative Durrleman butterfly density g(k) on spiked smile and preserves PCHIP monotonicity without overshoot', () => {
    const scD = FIXTURE.scenarioD_butterflySpike;
    const badSlice = buildVolSlice(deepFreeze(structuredClone(scD.sliceInput)));
    const bfReport = validateSliceButterflyArbitrage(badSlice);

    expect(bfReport.isArbitrageFree).toBe(scD.isArbitrageFree);
    expect(bfReport.isArbitrageFree).toBe(false);
    expect(bfReport.violations.length).toBeGreaterThan(0);
    expect(bfReport.minDensity).toBeLessThan(0);
    expectClose(bfReport.minDensity, scD.minDensity);
    expectClose(bfReport.worstLogMoneyness, scD.worstLogMoneyness);
    expectClose(bfReport.worstStrike, scD.worstStrike);

    const metrics = computeSliceVolMetrics(badSlice);
    expect(metrics.isButterflyArbitrageFree).toBe(false);

    // PCHIP shape preservation: monotone flat-step wing data must never overshoot knot total variance.
    const stepSlice = buildVolSlice({
      timeToExpiry: 30 / 365,
      forward: 100,
      quotes: [
        { strike: 85, contractType: 'put', iv: 0.35, bid: 1.0, ask: 1.02, openInterest: 100 },
        { strike: 92, contractType: 'put', iv: 0.35, bid: 1.0, ask: 1.02, openInterest: 100 },
        { strike: 100, contractType: 'call', iv: 0.20, bid: 1.0, ask: 1.02, openInterest: 100 },
        { strike: 108, contractType: 'call', iv: 0.20, bid: 1.0, ask: 1.02, openInterest: 100 },
      ],
    });
    expect(stepSlice.isValid).toBe(true);
    for (let i = 0; i < stepSlice.nodes.length - 1; i += 1) {
      const left = stepSlice.nodes[i];
      const right = stepSlice.nodes[i + 1];
      if (left === undefined || right === undefined) {
        continue;
      }
      const wMin = Math.min(left.totalVariance, right.totalVariance);
      const wMax = Math.max(left.totalVariance, right.totalVariance);
      for (let m = 1; m <= 10; m += 1) {
        const kSample = left.k + ((right.k - left.k) * m) / 11;
        const wSample = evaluateSliceTotalVariance(stepSlice, kSample);
        expect(wSample).toBeGreaterThanOrEqual(wMin - 1e-15);
        expect(wSample).toBeLessThanOrEqual(wMax + 1e-15);
      }
    }
  });

  it('Scenario E: distinguishes true calendar arbitrage violation from arbitrage-free IV backwardation', () => {
    const scE = FIXTURE.scenarioE_calendarAndBackwardation;

    const badSurface = buildVolSurface(deepFreeze(structuredClone(scE.calendarViolation.slices)));
    expect(badSurface.calendarArbitrageFree).toBe(false);
    expect(badSurface.isArbitrageFree).toBe(false);
    expect(badSurface.calendarCheck.violations.length).toBeGreaterThan(0);
    expectClose(
      badSurface.calendarCheck.minVarianceDiff,
      scE.calendarViolation.expectedMinVarianceDiff,
    );

    const backwSurface = buildVolSurface(
      deepFreeze(structuredClone(scE.validBackwardation.slices)),
    );
    expect(backwSurface.butterflyArbitrageFree).toBe(true);
    expect(backwSurface.calendarArbitrageFree).toBe(true);
    expect(backwSurface.isArbitrageFree).toBe(true);
    expectClose(
      backwSurface.calendarCheck.minVarianceDiff,
      scE.validBackwardation.expectedMinVarianceDiff,
    );

    const t1 = scE.validBackwardation.slices[0]?.timeToExpiry ?? Number.NaN;
    const t2 = scE.validBackwardation.slices[1]?.timeToExpiry ?? Number.NaN;
    expect(termSlope(backwSurface, t1, t2)).toBeLessThan(0);
    expectClose(termSpread(backwSurface, t1, t2), scE.validBackwardation.expectedTermSpread);
    expectClose(termSlope(backwSurface, t1, t2), scE.validBackwardation.expectedTermSlope);
  });

  it('Scenario F: refuses extrapolation, rejects illiquid slices (< minPoints) with NaN + reason, and blocks bridging across NaN expiries', () => {
    // Fewer than minPoints valid strikes -> invalid slice + NaN metrics.
    const sparseSlice = buildVolSlice(
      {
        timeToExpiry: 30 / 365,
        forward: 100,
        spot: 100,
        rate: 0.04,
        quotes: [
          { strike: 95, contractType: 'put', iv: 0.24, bid: 1.0, ask: 1.05, openInterest: 100 },
          { strike: 100, contractType: 'call', iv: 0.21, bid: 2.0, ask: 2.05, openInterest: 100 },
          { strike: 105, contractType: 'call', iv: 0.19, bid: 1.0, ask: 1.05, openInterest: 100 },
          { strike: 110, contractType: 'call', iv: 0.20, bid: 0.0, ask: 0.2, openInterest: 100 },
        ],
      },
      { minPoints: 4 },
    );

    expect(sparseSlice.isValid).toBe(false);
    expect(sparseSlice.report.rejectionReason).toBe('insufficient_points');
    expect(sparseSlice.report.strikeNodesCount).toBe(3);
    expect(computeIvAtm(sparseSlice)).toBeNaN();
    expect(evaluateSliceTotalVariance(sparseSlice, 0)).toBeNaN();
    expect(evaluateSliceIvAtStrike(sparseSlice, 100)).toBeNaN();

    const sparseMetrics = computeSliceVolMetrics(sparseSlice);
    expect(sparseMetrics.ivAtm).toBeNaN();
    expect(sparseMetrics.expectedMovePct).toBeNaN();
    expect(sparseMetrics.riskReversal25).toBeNaN();
    expect(sparseMetrics.butterfly25).toBeNaN();
    expect(sparseMetrics.isButterflyArbitrageFree).toBe(false);

    // One-sided strike support missing ATM (k = 0 outside [kMin, kMax]) -> no wing extrapolation.
    const putWingOnly = buildVolSlice({
      timeToExpiry: 30 / 365,
      forward: 100,
      spot: 100,
      rate: 0.04,
      quotes: [
        { strike: 85, contractType: 'put', iv: 0.28, bid: 0.5, ask: 0.55, openInterest: 50 },
        { strike: 88, contractType: 'put', iv: 0.26, bid: 0.8, ask: 0.85, openInterest: 50 },
        { strike: 91, contractType: 'put', iv: 0.24, bid: 1.2, ask: 1.25, openInterest: 50 },
        { strike: 95, contractType: 'put', iv: 0.22, bid: 1.8, ask: 1.85, openInterest: 50 },
      ],
    });
    expect(putWingOnly.isValid).toBe(true);
    expect(computeIvAtm(putWingOnly)).toBeNaN();
    expect(evaluateSliceIv(putWingOnly, putWingOnly.kMin - 1e-4)).toBeNaN();
    expect(evaluateSliceIv(putWingOnly, putWingOnly.kMax + 1e-4)).toBeNaN();
    expect(evaluateSliceIvAtStrike(putWingOnly, -10)).toBeNaN();
    expect(solveDeltaStrikeAndIv(putWingOnly, 0.25, 'call').strike).toBeNaN();
    // Invalid sign convention for targetDelta returns NaN cleanly.
    expect(solveDeltaStrikeAndIv(putWingOnly, 0.25, 'put').strike).toBeNaN();

    // Surface with invalid middle expiry must NOT bridge variance/term queries across the gap.
    const validNear = FIXTURE.scenarioA_cleanTermSurface.sliceInputs[0];
    const validFar = FIXTURE.scenarioA_cleanTermSurface.sliceInputs[2];
    expect(validNear).toBeDefined();
    expect(validFar).toBeDefined();
    if (validNear !== undefined && validFar !== undefined) {
      const gapSurface = buildVolSurface([
        validNear,
        {
          timeToExpiry: 30 / 365,
          forward: 582,
          spot: 580,
          rate: 0.045,
          dividendYield: 0.013,
          quotes: validNear.quotes.slice(0, 2),
        },
        validFar,
      ]);

      expect(gapSurface.validSlicesCount).toBe(2);
      expect(gapSurface.invalidSlicesCount).toBe(1);
      expect(interpolateSurfaceTotalVariance(gapSurface, 30 / 365, 0)).toBeNaN();
      expect(interpolateSurfaceTotalVariance(gapSurface, 20 / 365, 0)).toBeNaN();
      expect(interpolateSurfaceTotalVariance(gapSurface, 60 / 365, 0)).toBeNaN();
      expect(interpolateTermIvAtm(gapSurface, 20 / 365)).toBeNaN();
      expect(evaluateSurfaceIvAtStrike(gapSurface, 20 / 365, 580)).toBeNaN();
      expect(
        interpolateSurfaceTotalVariance(gapSurface, validNear.timeToExpiry * 0.5, 0),
      ).toBeNaN();
      expect(
        interpolateSurfaceTotalVariance(gapSurface, validFar.timeToExpiry * 1.5, 0),
      ).toBeNaN();
      expect(termSpread(gapSurface, validFar.timeToExpiry, validNear.timeToExpiry)).toBeNaN();
      expect(termSlope(gapSurface, validNear.timeToExpiry, validNear.timeToExpiry)).toBeNaN();
      // Calendar arbitrage checker directly ignoring invalid slices still validates valid pair 7d vs 90d.
      const calOnly = validateSurfaceCalendarArbitrage(gapSurface.slices);
      expect(calOnly.isArbitrageFree).toBe(true);
    }
  });
});
