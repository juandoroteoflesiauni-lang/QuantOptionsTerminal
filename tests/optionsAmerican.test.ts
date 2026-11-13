import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  bivariateNormCdf,
  DEFAULT_CRR_STEPS,
  greeksAmericanFiniteDiffOrAnalytical,
  MAX_CRR_STEPS,
  priceAmericanBjerksund2002,
  priceAmericanCrrDiscrete,
  solveImpliedVolAmerican,
} from '../src/core/options/american.js';
import { greeksBsm, priceBsm } from '../src/core/options/blackScholes.js';
import {
  impliedDividendYieldFromForward,
  inferForwardFromParity,
  inferForwardFromParityDetailed,
  type ParityOptionPair,
} from '../src/core/options/forward.js';
import type { BsmInput, OptionContractType, OptionGreeksResult } from '../src/core/options/types.js';

type JsonNumber = number | 'NaN';

interface RawParityPairFixture {
  readonly strike: number;
  readonly callMid: JsonNumber;
  readonly putMid: JsonNumber;
  readonly callBid?: number;
  readonly callAsk?: number;
  readonly putBid?: number;
  readonly putAsk?: number;
}

interface ForwardFixtureCase {
  readonly name: string;
  readonly spot: number;
  readonly timeToExpiry: number;
  readonly rate: number;
  readonly discountFactor: number;
  readonly pairs: readonly RawParityPairFixture[];
  readonly options: {
    readonly nearAtmCount?: number;
    readonly maxRelativeSpread?: number;
    readonly requirePositiveBid?: boolean;
  };
  readonly expectedValidCount?: number;
  readonly expectedUsedCount?: number;
  readonly expectedDiscardedCount?: number;
  readonly expectedMedianForward: number;
  readonly expectedWeightedForward: number;
  readonly expectedImpliedYieldFromMedian?: number;
  readonly expectedImpliedYieldFromWeighted?: number;
}

interface BvnFixtureCase {
  readonly a: number;
  readonly b: number;
  readonly rho: number;
  readonly expected: number;
}

interface Bjerksund2002FixtureCase {
  readonly name: string;
  readonly input: BsmInput;
  readonly expectedBs2002: number;
  readonly expectedEuropean: number;
  readonly expectedIntrinsic: number;
  readonly crrRichardsonRef: number;
  readonly expectedGreeks: OptionGreeksResult;
}

interface InvalidBsmFixtureCase {
  readonly name: string;
  readonly spot: number;
  readonly strike: number;
  readonly timeToExpiry: number;
  readonly rate: number;
  readonly dividendYield: number;
  readonly volatility: number;
  readonly contractType: OptionContractType;
}

interface CrrDiscreteFixtureCase {
  readonly name: string;
  readonly input: BsmInput & {
    readonly steps: number;
    readonly discreteDividends: readonly { readonly time: number; readonly amount: number }[];
  };
  readonly expectedPrice: number;
}

interface ImpliedVolFixtureCase {
  readonly name: string;
  readonly input: Omit<BsmInput, 'volatility'> & {
    readonly marketPrice: number;
    readonly discreteDividends?: readonly { readonly time: number; readonly amount: number }[];
    readonly steps?: number;
  };
  readonly trueVolatility: number;
  readonly expectedPythonBisectionVol: number;
}

interface AmericanFixtureFile {
  readonly meta: { readonly generator: string; readonly notes: string };
  readonly bvnCases: readonly BvnFixtureCase[];
  readonly forwardCases: readonly ForwardFixtureCase[];
  readonly bjerksund2002Cases: readonly Bjerksund2002FixtureCase[];
  readonly bjerksund2002InvalidCases: readonly InvalidBsmFixtureCase[];
  readonly crrDiscreteCases: readonly CrrDiscreteFixtureCase[];
  readonly impliedVolCases: readonly ImpliedVolFixtureCase[];
}

const fixturePath = resolve(process.cwd(), 'fixtures/options_american_reference.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as AmericanFixtureFile;

const diffStats = {
  maxBs02AbsDiff: 0,
  maxCrrDiscreteAbsDiff: 0,
  maxForwardAbsDiff: 0,
  maxFirstOrderGreekRelDiff: 0,
  maxSecondOrderFdAbsDiff: 0,
  maxIvAbsDiff: 0,
  maxBs02VsCrrContinuousDiff: 0,
  maxBs02VsCrrRelStrikeDiff: 0,
  comparisons: 0,
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

function toNumber(v: JsonNumber): number {
  return v === 'NaN' ? Number.NaN : v;
}

function toParityPairs(rawPairs: readonly RawParityPairFixture[]): ParityOptionPair[] {
  return rawPairs.map((pair) => ({
    strike: pair.strike,
    callMid: toNumber(pair.callMid),
    putMid: toNumber(pair.putMid),
    ...(pair.callBid !== undefined ? { callBid: pair.callBid } : {}),
    ...(pair.callAsk !== undefined ? { callAsk: pair.callAsk } : {}),
    ...(pair.putBid !== undefined ? { putBid: pair.putBid } : {}),
    ...(pair.putAsk !== undefined ? { putAsk: pair.putAsk } : {}),
  }));
}

function recordDiff(bucket: keyof typeof diffStats, actual: number, expected: number): void {
  const err = Math.abs(actual - expected);
  diffStats.comparisons += 1;
  if (err > diffStats[bucket]) {
    diffStats[bucket] = err;
  }
}

describe('Pieza 3: Bivariate Normal, Put-Call Forward Parity, Bjerksund-Stensland 2002 & Discrete CRR', () => {
  afterAll(() => {
    console.info(
      `[optionsAmerican] comparisons=${String(diffStats.comparisons)} ` +
        `maxForwardDiff=${diffStats.maxForwardAbsDiff.toExponential(3)} ` +
        `maxBs02VsPyDiff=${diffStats.maxBs02AbsDiff.toExponential(3)} ` +
        `max1stOrderGreekRelDiff=${diffStats.maxFirstOrderGreekRelDiff.toExponential(3)} ` +
        `max2ndOrderFdAbsDiff=${diffStats.maxSecondOrderFdAbsDiff.toExponential(3)} ` +
        `maxCrrDiscreteVsPyDiff=${diffStats.maxCrrDiscreteAbsDiff.toExponential(3)} ` +
        `maxIvDiff=${diffStats.maxIvAbsDiff.toExponential(3)} ` +
        `maxBs02VsCrrRichardsonDiff=${diffStats.maxBs02VsCrrContinuousDiff.toExponential(3)} ` +
        `(${(diffStats.maxBs02VsCrrRelStrikeDiff * 100).toFixed(4)}% of K)`,
    );
  });

  describe('bivariateNormCdf (Genz 2004 Gauss-Legendre vs Python 1D Simpson)', () => {
    it('matches independent Python numerical integration across all correlation regimes', () => {
      for (const tc of fixture.bvnCases) {
        const actual = bivariateNormCdf(tc.a, tc.b, tc.rho);
        diffStats.comparisons += 1;
        expect(actual).toBeGreaterThanOrEqual(0);
        expect(actual).toBeLessThanOrEqual(1);
        expect(Math.abs(actual - tc.expected)).toBeLessThan(1e-11);
      }
    });

    it('rejects out-of-range rho or non-finite inputs with NaN', () => {
      expect(bivariateNormCdf(0, 0, 1.01)).toBeNaN();
      expect(bivariateNormCdf(0, 0, -1.01)).toBeNaN();
      expect(bivariateNormCdf(Number.NaN, 0, 0.5)).toBeNaN();
      expect(bivariateNormCdf(0, Number.NaN, 0.5)).toBeNaN();
      expect(bivariateNormCdf(0, 0, Number.NaN)).toBeNaN();
    });
  });

  describe('inferForwardFromParity & impliedDividendYieldFromForward', () => {
    it('matches independent Python median & liquidity-weighted parity forward estimates and yields', () => {
      for (const tc of fixture.forwardCases) {
        const pairs = deepFreeze(toParityPairs(tc.pairs));

        const medFwd = inferForwardFromParity(pairs, tc.discountFactor, {
          method: 'median',
          ...tc.options,
        });
        recordDiff('maxForwardAbsDiff', medFwd, tc.expectedMedianForward);
        expect(Math.abs(medFwd - tc.expectedMedianForward)).toBeLessThan(1e-12);

        const weightedDetailed = inferForwardFromParityDetailed(pairs, tc.discountFactor, {
          method: 'weightedMean',
          ...tc.options,
        });
        recordDiff('maxForwardAbsDiff', weightedDetailed.forward, tc.expectedWeightedForward);
        expect(Math.abs(weightedDetailed.forward - tc.expectedWeightedForward)).toBeLessThan(1e-12);

        if (tc.expectedValidCount !== undefined) {
          expect(weightedDetailed.validPairsCount).toBe(tc.expectedValidCount);
        }
        if (tc.expectedUsedCount !== undefined) {
          expect(weightedDetailed.usedPairsCount).toBe(tc.expectedUsedCount);
        }
        if (tc.expectedDiscardedCount !== undefined) {
          expect(weightedDetailed.discardedPairsCount).toBe(tc.expectedDiscardedCount);
        }

        if (tc.expectedImpliedYieldFromMedian !== undefined) {
          const qMed = impliedDividendYieldFromForward({
            spot: tc.spot,
            forward: medFwd,
            timeToExpiry: tc.timeToExpiry,
            rate: tc.rate,
          });
          expect(Math.abs(qMed - tc.expectedImpliedYieldFromMedian)).toBeLessThan(1e-12);
        }

        if (tc.expectedImpliedYieldFromWeighted !== undefined) {
          const qWeighted = impliedDividendYieldFromForward(
            tc.spot,
            weightedDetailed.forward,
            tc.timeToExpiry,
            tc.rate,
          );
          expect(Math.abs(qWeighted - tc.expectedImpliedYieldFromWeighted)).toBeLessThan(1e-12);
        }
      }
    });

    it('returns explicit NaN without spot fallbacks when pairs or inputs are invalid', () => {
      expect(inferForwardFromParity([], 0.99)).toBeNaN();
      expect(
        inferForwardFromParity([{ strike: 100, callMid: Number.NaN, putMid: 3 }], 0.99),
      ).toBeNaN();
      expect(
        inferForwardFromParity(
          [{ strike: 100, callMid: 4, putMid: 3, callBid: 0, callAsk: 0.2 }],
          0.99,
          { requirePositiveBid: true },
        ),
      ).toBeNaN();
      expect(
        inferForwardFromParity([{ strike: 100, callMid: 4, putMid: 3 }], 0),
      ).toBeNaN();
      expect(
        impliedDividendYieldFromForward({
          spot: 0,
          forward: 100,
          timeToExpiry: 0.25,
          rate: 0.05,
        }),
      ).toBeNaN();
      expect(
        impliedDividendYieldFromForward({
          spot: 100,
          forward: 100,
          timeToExpiry: 0,
          rate: 0.05,
        }),
      ).toBeNaN();
    });
  });

  describe('priceAmericanBjerksund2002 & greeksAmericanFiniteDiffOrAnalytical', () => {
    it('matches independent Python BS2002 prices (< 1e-10) and enforces arbitrage bounds', () => {
      for (const tc of fixture.bjerksund2002Cases) {
        const input = deepFreeze(tc.input);
        const tsPrice = priceAmericanBjerksund2002(input);
        const tsEur = priceBsm(input);

        recordDiff('maxBs02AbsDiff', tsPrice, tc.expectedBs2002);
        expect(Math.abs(tsPrice - tc.expectedBs2002)).toBeLessThan(1e-10);
        expect(tsPrice).toBeGreaterThanOrEqual(tsEur - 1e-12);
        expect(tsPrice).toBeGreaterThanOrEqual(tc.expectedIntrinsic - 1e-12);

        const crrGap = Math.abs(tsPrice - tc.crrRichardsonRef);
        const relStrikeGap = crrGap / input.strike;
        if (crrGap > diffStats.maxBs02VsCrrContinuousDiff) {
          diffStats.maxBs02VsCrrContinuousDiff = crrGap;
        }
        if (relStrikeGap > diffStats.maxBs02VsCrrRelStrikeDiff) {
          diffStats.maxBs02VsCrrRelStrikeDiff = relStrikeGap;
        }
        // Two-barrier piecewise constant approximation stays tightly close to N=2000 Richardson CRR.
        expect(relStrikeGap).toBeLessThan(0.001);
        expect(tsPrice).toBeLessThanOrEqual(tc.crrRichardsonRef + 1e-3);
      }
    });

    it('matches exact European BSM on zero-early-exercise Merton cases', () => {
      const noDivCall: BsmInput = {
        spot: 112.5,
        strike: 100,
        timeToExpiry: 0.75,
        rate: 0.05,
        dividendYield: 0,
        volatility: 0.24,
        contractType: 'call',
      };
      expect(Math.abs(priceAmericanBjerksund2002(noDivCall) - priceBsm(noDivCall))).toBeLessThan(
        1e-14,
      );
      expect(greeksAmericanFiniteDiffOrAnalytical(noDivCall)).toEqual(greeksBsm(noDivCall));

      const negRatePut: BsmInput = {
        spot: 95,
        strike: 100,
        timeToExpiry: 0.5,
        rate: -0.02,
        dividendYield: 0.01,
        volatility: 0.25,
        contractType: 'put',
      };
      expect(Math.abs(priceAmericanBjerksund2002(negRatePut) - priceBsm(negRatePut))).toBeLessThan(
        1e-14,
      );
      expect(greeksAmericanFiniteDiffOrAnalytical(negRatePut)).toEqual(greeksBsm(negRatePut));
    });

    it('matches independent Python American Greeks and preserves non-negative Gamma and Vega', () => {
      const firstOrderKeys: readonly (keyof OptionGreeksResult)[] = [
        'price',
        'delta',
        'theta',
        'thetaDaily',
        'vega',
        'vegaPer1Pct',
        'rho',
      ];
      const secondOrderFdKeys: readonly (keyof OptionGreeksResult)[] = [
        'gamma',
        'vanna',
        'charm',
      ];

      for (const tc of fixture.bjerksund2002Cases) {
        const input = deepFreeze(tc.input);
        const greeks = greeksAmericanFiniteDiffOrAnalytical(input);
        expect(greeks.gamma).toBeGreaterThanOrEqual(-1e-10);
        expect(greeks.vega).toBeGreaterThanOrEqual(-1e-10);
        expect(Math.abs(greeks.thetaDaily - greeks.theta / 365)).toBeLessThan(1e-15);
        expect(Math.abs(greeks.vegaPer1Pct - greeks.vega / 100)).toBeLessThan(1e-15);

        for (const key of firstOrderKeys) {
          const actual = greeks[key];
          const expected = tc.expectedGreeks[key];
          const absErr = Math.abs(actual - expected);
          const scale = Math.abs(expected);
          diffStats.comparisons += 1;
          // Standard relative+absolute check: < 1e-9 relative when |expected| >= 1, < 1e-9 abs when |expected| < 1.
          const tol = 1e-9 * Math.max(1, scale);
          if (scale > 0 && absErr / scale > diffStats.maxFirstOrderGreekRelDiff && scale >= 1) {
            diffStats.maxFirstOrderGreekRelDiff = absErr / scale;
          }
          expect(absErr, `${tc.name}.${key}`).toBeLessThan(tol);
        }
        for (const key of secondOrderFdKeys) {
          recordDiff('maxSecondOrderFdAbsDiff', greeks[key], tc.expectedGreeks[key]);
          // Documented tolerance (< 1e-6): 2nd-order FD (1/dS^2 or 1/(4*dS*dSig) ~ 2e6)
          // amplifies ~1e-13 cross-implementation erfc/BVN diffs (Cody vs libm) to ~2e-7.
          expect(Math.abs(greeks[key] - tc.expectedGreeks[key]), `${tc.name}.${key}`).toBeLessThan(
            1e-6,
          );
        }
      }
    });

    it('stays finite across extreme volatilities [1e-9, 100] and returns NaN on invalid domain inputs', () => {
      for (const sig of [1e-9, 1e-4, 0.25, 10, 100]) {
        const p = priceAmericanBjerksund2002({
          spot: 40,
          strike: 42,
          timeToExpiry: 0.5,
          rate: 0.05,
          dividendYield: 0,
          volatility: sig,
          contractType: 'put',
        });
        expect(Number.isFinite(p)).toBe(true);
        expect(p).toBeGreaterThanOrEqual(2 - 1e-12);
        expect(p).toBeLessThanOrEqual(42);
      }

      for (const bad of fixture.bjerksund2002InvalidCases) {
        expect(priceAmericanBjerksund2002(bad)).toBeNaN();
        expect(greeksAmericanFiniteDiffOrAnalytical(bad).price).toBeNaN();
      }
    });
  });

  describe('priceAmericanCrrDiscrete', () => {
    it('matches independent Python discrete-dividend CRR tree (< 1e-11) and preserves argument immutability', () => {
      for (const tc of fixture.crrDiscreteCases) {
        const input = deepFreeze(tc.input);
        const actual = priceAmericanCrrDiscrete(input);
        recordDiff('maxCrrDiscreteAbsDiff', actual, tc.expectedPrice);
        expect(Math.abs(actual - tc.expectedPrice)).toBeLessThan(1e-11);

        // Call just before large discrete dividend must exceed European price with same discrete PV subtracted:
        if (tc.name === 'call_single_large_div_pre_expiry') {
          const eurAdj = priceBsm({
            spot:
              input.spot -
              3.0 * Math.exp(-input.rate * 0.24),
            strike: input.strike,
            timeToExpiry: input.timeToExpiry,
            rate: input.rate,
            dividendYield: input.dividendYield,
            volatility: input.volatility,
            contractType: 'call',
          });
          expect(actual).toBeGreaterThan(eurAdj);
        }
      }
    });

    it('enforces explicit step caps, dividend bounds, and valid defaults', () => {
      expect(DEFAULT_CRR_STEPS).toBe(200);
      expect(MAX_CRR_STEPS).toBe(5000);

      const base: BsmInput = {
        spot: 100,
        strike: 100,
        timeToExpiry: 0.5,
        rate: 0.05,
        dividendYield: 0,
        volatility: 0.25,
        contractType: 'put',
      };

      expect(priceAmericanCrrDiscrete({ ...base, steps: MAX_CRR_STEPS + 1 })).toBeNaN();
      expect(priceAmericanCrrDiscrete({ ...base, steps: 150, maxSteps: 100 })).toBeNaN();
      expect(priceAmericanCrrDiscrete({ ...base, steps: 0 })).toBeNaN();
      expect(priceAmericanCrrDiscrete({ ...base, steps: 50.5 })).toBeNaN();
      expect(
        priceAmericanCrrDiscrete({
          ...base,
          discreteDividends: [{ time: 0.2, amount: -0.5 }],
        }),
      ).toBeNaN();
      expect(
        priceAmericanCrrDiscrete({
          ...base,
          discreteDividends: [{ time: 0, amount: 1 }],
        }),
      ).toBeNaN();
      expect(
        priceAmericanCrrDiscrete({
          ...base,
          discreteDividends: [{ time: 0.6, amount: 1 }],
        }),
      ).toBeNaN();
      expect(
        priceAmericanCrrDiscrete({
          ...base,
          discreteDividends: [{ time: 0.1, amount: 105 }],
        }),
      ).toBeNaN();
    });
  });

  describe('solveImpliedVolAmerican (Pure Brent root-finder)', () => {
    it('recovers true volatility and matches Python 150-step bisection to < 1e-9', () => {
      for (const tc of fixture.impliedVolCases) {
        const input = deepFreeze(tc.input);
        const solved = solveImpliedVolAmerican(input);
        recordDiff('maxIvAbsDiff', solved, tc.trueVolatility);
        expect(Math.abs(solved - tc.trueVolatility)).toBeLessThan(1e-9);
        expect(Math.abs(solved - tc.expectedPythonBisectionVol)).toBeLessThan(1e-9);
      }
    });

    it('rejects intrinsic/sub-arbitrage/super-arbitrage prices cleanly with NaN', () => {
      // Exact intrinsic on deep ITM Put has vega = 0 (non-unique IV) -> NaN.
      expect(
        solveImpliedVolAmerican({
          spot: 60,
          strike: 100,
          timeToExpiry: 0.25,
          rate: 0.08,
          dividendYield: 0,
          contractType: 'put',
          marketPrice: 40,
        }),
      ).toBeNaN();

      // Below European lower bound -> NaN.
      expect(
        solveImpliedVolAmerican({
          spot: 110,
          strike: 100,
          timeToExpiry: 0.5,
          rate: 0.05,
          dividendYield: 0,
          contractType: 'call',
          marketPrice: 10.5,
        }),
      ).toBeNaN();

      // Above or equal to American upper bound (S for Call, K for Put) -> NaN.
      expect(
        solveImpliedVolAmerican({
          spot: 100,
          strike: 100,
          timeToExpiry: 0.5,
          rate: 0.05,
          dividendYield: 0,
          contractType: 'call',
          marketPrice: 100,
        }),
      ).toBeNaN();
      expect(
        solveImpliedVolAmerican({
          spot: 100,
          strike: 100,
          timeToExpiry: 0.5,
          rate: 0.05,
          dividendYield: 0,
          contractType: 'put',
          marketPrice: 100.5,
        }),
      ).toBeNaN();
    });
  });
});
