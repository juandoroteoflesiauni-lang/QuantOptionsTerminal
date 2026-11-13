import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  black76ArbitrageBounds,
  bsmArbitrageBounds,
  evaluateOptionAtExpiry,
  greeksBlack76,
  greeksBsm,
  priceBlack76,
  priceBsm,
  SECONDS_PER_YEAR_365,
  timeToExpiryYears,
} from '../src/core/options/blackScholes.js';
import { solveImpliedVolBlack76, solveImpliedVolBsm } from '../src/core/options/impliedVol.js';
import { erfcCody, normCdf, normPdf } from '../src/core/options/math.js';
import type {
  Black76Input,
  BsmInput,
  ImpliedVolSolverOptions,
  OptionContractType,
  OptionGreeksResult,
  SolveImpliedVolBlack76Input,
  SolveImpliedVolBsmInput,
} from '../src/core/options/types.js';

type NumericOrNan = number | 'NaN';

interface ErfcFixtureCase {
  readonly x: number;
  readonly erfc: number;
  readonly normCdf: number;
  readonly normPdf: number;
}

interface TimeToExpiryFixtureCase {
  readonly label: string;
  readonly nowUtcSec: number;
  readonly expiryUtcSec: number;
  readonly secondsPerYear?: number;
  readonly expected: NumericOrNan;
}

interface ExpiryPayoffFixtureCase {
  readonly underlier: number;
  readonly strike: number;
  readonly contractType: OptionContractType;
  readonly expected: NumericOrNan;
}

interface GreeksFixtureCase<TInput> {
  readonly label: string;
  readonly input: TInput;
  readonly bounds: { readonly lower: number; readonly upper: number };
  readonly expected: OptionGreeksResult;
  readonly impliedVolRoundTrip: NumericOrNan;
}

interface DegenerateCase {
  readonly label: string;
  readonly model: 'bsm' | 'black76';
  readonly input: Record<string, unknown>;
}

interface IvFixtureCase {
  readonly label: string;
  readonly model: 'bsm' | 'black76';
  readonly input: {
    readonly spot?: number;
    readonly forward?: number;
    readonly strike: number;
    readonly timeToExpiry: number;
    readonly rate: number;
    readonly dividendYield?: number;
    readonly contractType: OptionContractType;
    readonly price: number;
    readonly options?: ImpliedVolSolverOptions;
  };
  readonly expectedIv: NumericOrNan;
}

interface OptionsBsmFixture {
  readonly erfcCases: readonly ErfcFixtureCase[];
  readonly timeToExpiryCases: readonly TimeToExpiryFixtureCase[];
  readonly expiryPayoffCases: readonly ExpiryPayoffFixtureCase[];
  readonly bsmCases: readonly GreeksFixtureCase<BsmInput>[];
  readonly black76Cases: readonly GreeksFixtureCase<Black76Input>[];
  readonly degenerateGreeksCases: readonly DegenerateCase[];
  readonly ivCases: readonly IvFixtureCase[];
}

const REL_TOL = 1e-9;
// Documented near-zero absolute floor for deep-wing Greeks whose true value is ~0 (<= 1e-12).
const NEAR_ZERO_MAGNITUDE = 1e-12;
const NEAR_ZERO_ABS_TOL = 1e-13;

const fixturePath = resolve(process.cwd(), 'fixtures', 'options_bsm_reference.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as OptionsBsmFixture;

const GREEK_KEYS: readonly (keyof OptionGreeksResult)[] = [
  'price',
  'delta',
  'gamma',
  'theta',
  'thetaDaily',
  'vega',
  'vegaPer1Pct',
  'rho',
  'vanna',
  'charm',
];

function hydrateUnknownInput(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = value === 'NaN' ? Number.NaN : value;
  }
  return out;
}

function expectCloseToReference(
  actual: number,
  expected: number,
  context: string,
): { readonly relDiff: number; readonly absDiff: number } {
  expect(Number.isFinite(actual), `${context}: actual must be finite, got ${String(actual)}`).toBe(
    true,
  );
  const absDiff = Math.abs(actual - expected);
  const scale = Math.abs(expected);
  if (scale <= NEAR_ZERO_MAGNITUDE) {
    expect(
      absDiff,
      `${context}: near-zero |${String(actual)} - ${String(expected)}| = ${String(absDiff)}`,
    ).toBeLessThan(NEAR_ZERO_ABS_TOL);
    return { relDiff: 0, absDiff };
  }
  const relDiff = absDiff / scale;
  expect(
    relDiff,
    `${context}: relDiff=${String(relDiff)} (actual=${String(actual)}, expected=${String(expected)})`,
  ).toBeLessThan(REL_TOL);
  return { relDiff, absDiff };
}

function expectAllGreeksNan(result: OptionGreeksResult, label: string): void {
  for (const key of GREEK_KEYS) {
    expect(Number.isNaN(result[key]), `${label}.${key} must be NaN`).toBe(true);
  }
}

describe('options math (erfc, normPdf, normCdf)', () => {
  it('matches Python math.erfc and normal PDF/CDF across all Cody branches and extreme tails', () => {
    let maxRelErr = 0;
    for (const c of fixture.erfcCases) {
      const actualErfc = erfcCody(c.x);
      const actualCdf = normCdf(c.x);
      const actualPdf = normPdf(c.x);

      const tailTol = Math.abs(c.x) > 10 ? 1e-12 : 1e-13;

      if (c.erfc > 1e-300) {
        const erfcRel = Math.abs(actualErfc - c.erfc) / c.erfc;
        expect(erfcRel, `erfc(${String(c.x)})`).toBeLessThan(tailTol);
        maxRelErr = Math.max(maxRelErr, erfcRel);
      } else {
        expect(actualErfc).toBeLessThanOrEqual(1e-300);
      }

      if (c.normCdf > 1e-300) {
        const cdfRel = Math.abs(actualCdf - c.normCdf) / c.normCdf;
        expect(cdfRel, `normCdf(${String(c.x)})`).toBeLessThan(tailTol);
        maxRelErr = Math.max(maxRelErr, cdfRel);
      } else {
        expect(actualCdf).toBeLessThanOrEqual(1e-300);
      }

      if (c.normPdf > 1e-300) {
        const pdfRel = Math.abs(actualPdf - c.normPdf) / c.normPdf;
        expect(pdfRel, `normPdf(${String(c.x)})`).toBeLessThan(1e-13);
        maxRelErr = Math.max(maxRelErr, pdfRel);
      } else {
        expect(actualPdf).toBeLessThanOrEqual(1e-300);
      }
    }
    expect(maxRelErr).toBeLessThan(1e-12);

    // Deep-tail precision: must NOT lose digits via (1 - Phi(+10)) cancellation
    const tail10 = normCdf(-10);
    expect(tail10).toBeGreaterThan(7.6e-24);
    expect(tail10).toBeLessThan(7.65e-24);

    expect(Number.isNaN(erfcCody(Number.NaN))).toBe(true);
    expect(Number.isNaN(normPdf(Number.NaN))).toBe(true);
    expect(Number.isNaN(normCdf(Number.NaN))).toBe(true);
    expect(normPdf(Number.POSITIVE_INFINITY)).toBe(0);
    expect(normPdf(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(normCdf(Number.POSITIVE_INFINITY)).toBe(1);
    expect(normCdf(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe('timeToExpiryYears & evaluateOptionAtExpiry', () => {
  it('computes ACT/365 expiry in UTC seconds and rejects milliseconds or expired contracts', () => {
    expect(SECONDS_PER_YEAR_365).toBe(365 * 86_400);

    for (const c of fixture.timeToExpiryCases) {
      const actual =
        c.secondsPerYear === undefined
          ? timeToExpiryYears(c.nowUtcSec, c.expiryUtcSec)
          : timeToExpiryYears(c.nowUtcSec, c.expiryUtcSec, c.secondsPerYear);
      if (c.expected === 'NaN') {
        expect(Number.isNaN(actual), c.label).toBe(true);
      } else {
        expect(Math.abs(actual - c.expected), c.label).toBeLessThan(1e-15);
      }
    }

    expect(Number.isNaN(timeToExpiryYears(Number.NaN, 1_700_000_000))).toBe(true);
    expect(Number.isNaN(timeToExpiryYears(1_700_000_000, Number.POSITIVE_INFINITY))).toBe(true);
  });

  it('computes terminal expiry payoff explicitly and rejects non-positive inputs', () => {
    for (const c of fixture.expiryPayoffCases) {
      const actual = evaluateOptionAtExpiry(c.underlier, c.strike, c.contractType);
      if (c.expected === 'NaN') {
        expect(Number.isNaN(actual)).toBe(true);
      } else {
        expect(actual).toBe(c.expected);
      }
    }
  });
});

describe('Black-Scholes-Merton (BSM) engine vs Python reference', () => {
  it('matches price, all 1st/2nd-order Greeks, arbitrage bounds, and IV round-trips within 1e-9', () => {
    let maxRelDiff = 0;
    let maxNearZeroAbsDiff = 0;

    for (const c of fixture.bsmCases) {
      const frozenInput = Object.freeze({ ...c.input });
      const price = priceBsm(frozenInput);
      const greeks = greeksBsm(frozenInput);
      const bounds = bsmArbitrageBounds({
        spot: frozenInput.spot,
        strike: frozenInput.strike,
        timeToExpiry: frozenInput.timeToExpiry,
        rate: frozenInput.rate,
        dividendYield: frozenInput.dividendYield,
        contractType: frozenInput.contractType,
      });

      expect(greeks.price).toBe(price);
      expect(greeks.gamma).toBeGreaterThanOrEqual(0);
      expect(greeks.vega).toBeGreaterThanOrEqual(0);
      expect(Math.abs(greeks.thetaDaily - greeks.theta / 365)).toBeLessThan(1e-14);
      expect(Math.abs(greeks.vegaPer1Pct - greeks.vega / 100)).toBeLessThan(1e-14);

      expectCloseToReference(bounds.lower, c.bounds.lower, `${c.label}.bounds.lower`);
      expectCloseToReference(bounds.upper, c.bounds.upper, `${c.label}.bounds.upper`);

      for (const key of GREEK_KEYS) {
        const diff = expectCloseToReference(
          greeks[key],
          c.expected[key],
          `${c.label}.${key}`,
        );
        maxRelDiff = Math.max(maxRelDiff, diff.relDiff);
        if (Math.abs(c.expected[key]) <= NEAR_ZERO_MAGNITUDE) {
          maxNearZeroAbsDiff = Math.max(maxNearZeroAbsDiff, diff.absDiff);
        }
      }

      const solvedIv = solveImpliedVolBsm({
        spot: frozenInput.spot,
        strike: frozenInput.strike,
        timeToExpiry: frozenInput.timeToExpiry,
        rate: frozenInput.rate,
        dividendYield: frozenInput.dividendYield,
        contractType: frozenInput.contractType,
        price,
      });

      const wellConditionedIv =
        greeks.vega * 1e-9 > 10 * Number.EPSILON * Math.max(1, c.expected.price);

      if (c.impliedVolRoundTrip === 'NaN') {
        expect(Number.isNaN(solvedIv), `${c.label} round-trip expected NaN`).toBe(true);
      } else if (wellConditionedIv) {
        const ivDiff = expectCloseToReference(
          solvedIv,
          frozenInput.volatility,
          `${c.label}.roundTripIv`,
        );
        expectCloseToReference(solvedIv, c.impliedVolRoundTrip, `${c.label}.roundTripVsPy`);
        maxRelDiff = Math.max(maxRelDiff, ivDiff.relDiff);
      } else {
        // Near float64 quantization floor (extrinsic ~1e-13 on large ITM price): verify repricing or NaN
        expect(
          Number.isNaN(solvedIv) ||
            Math.abs(priceBsm({ ...frozenInput, volatility: solvedIv }) - price) <= 1e-12,
          `${c.label}.quantizedIv`,
        ).toBe(true);
      }
    }

    console.log(
      `[BSM Fixture Report] Max relative diff: ${maxRelDiff.toExponential(4)}, Max near-zero abs diff: ${maxNearZeroAbsDiff.toExponential(4)}`,
    );
    expect(maxRelDiff).toBeLessThan(REL_TOL);
    expect(maxNearZeroAbsDiff).toBeLessThan(NEAR_ZERO_ABS_TOL);
  });

  it('satisfies exact analytical Put-Call parity across prices and all Greeks', () => {
    const baseCall: BsmInput = {
      spot: 100,
      strike: 105,
      timeToExpiry: 0.75,
      rate: 0.045,
      dividendYield: 0.018,
      volatility: 0.27,
      contractType: 'call',
    };
    const basePut: BsmInput = { ...baseCall, contractType: 'put' };
    const c = greeksBsm(baseCall);
    const p = greeksBsm(basePut);

    const discS = baseCall.spot * Math.exp(-baseCall.dividendYield * baseCall.timeToExpiry);
    const discK = baseCall.strike * Math.exp(-baseCall.rate * baseCall.timeToExpiry);
    const discQ = Math.exp(-baseCall.dividendYield * baseCall.timeToExpiry);
    const discR = Math.exp(-baseCall.rate * baseCall.timeToExpiry);

    expect(Math.abs(c.price - p.price - (discS - discK))).toBeLessThan(1e-12);
    expect(Math.abs(c.delta - p.delta - discQ)).toBeLessThan(1e-12);
    expect(Math.abs(c.gamma - p.gamma)).toBeLessThan(1e-12);
    expect(Math.abs(c.vega - p.vega)).toBeLessThan(1e-12);
    expect(Math.abs(c.vanna - p.vanna)).toBeLessThan(1e-12);
    expect(Math.abs(c.rho - p.rho - baseCall.strike * baseCall.timeToExpiry * discR)).toBeLessThan(
      1e-12,
    );
    expect(
      Math.abs(c.theta - p.theta - (baseCall.dividendYield * discS - baseCall.rate * discK)),
    ).toBeLessThan(1e-11);
    expect(Math.abs(c.charm - p.charm - baseCall.dividendYield * discQ)).toBeLessThan(1e-12);
  });
});

describe('Black-76 futures/VIX engine vs Python reference', () => {
  it('matches price, all Greeks (positive gamma/vega on deep ITM VIX), and IV round-trips within 1e-9', () => {
    let maxRelDiff = 0;

    for (const c of fixture.black76Cases) {
      const frozenInput = Object.freeze({ ...c.input });
      const price = priceBlack76(frozenInput);
      const greeks = greeksBlack76(frozenInput);
      const bounds = black76ArbitrageBounds({
        forward: frozenInput.forward,
        strike: frozenInput.strike,
        timeToExpiry: frozenInput.timeToExpiry,
        rate: frozenInput.rate,
        contractType: frozenInput.contractType,
      });

      expect(greeks.price).toBe(price);
      expect(greeks.gamma).toBeGreaterThanOrEqual(0);
      expect(greeks.vega).toBeGreaterThanOrEqual(0);
      expect(Math.abs(greeks.rho - -frozenInput.timeToExpiry * price)).toBeLessThan(1e-12);

      expectCloseToReference(bounds.lower, c.bounds.lower, `${c.label}.bounds.lower`);
      expectCloseToReference(bounds.upper, c.bounds.upper, `${c.label}.bounds.upper`);

      for (const key of GREEK_KEYS) {
        const diff = expectCloseToReference(
          greeks[key],
          c.expected[key],
          `${c.label}.${key}`,
        );
        maxRelDiff = Math.max(maxRelDiff, diff.relDiff);
      }

      const solvedIv = solveImpliedVolBlack76({
        forward: frozenInput.forward,
        strike: frozenInput.strike,
        timeToExpiry: frozenInput.timeToExpiry,
        rate: frozenInput.rate,
        contractType: frozenInput.contractType,
        price,
      });

      if (c.impliedVolRoundTrip === 'NaN') {
        expect(Number.isNaN(solvedIv)).toBe(true);
      } else {
        const ivDiff = expectCloseToReference(
          solvedIv,
          frozenInput.volatility,
          `${c.label}.roundTripIv`,
        );
        maxRelDiff = Math.max(maxRelDiff, ivDiff.relDiff);
      }
    }

    console.log(`[Black-76 Fixture Report] Max relative diff: ${maxRelDiff.toExponential(4)}`);
    expect(maxRelDiff).toBeLessThan(REL_TOL);
  });
});

describe('Degenerate inputs, no-arbitrage bounds, monotonicity & immutability', () => {
  it('returns NaN cleanly for all invalid or degenerate inputs without fallbacks', () => {
    for (const c of fixture.degenerateGreeksCases) {
      const hydrated = Object.freeze(hydrateUnknownInput(c.input));
      if (c.model === 'bsm') {
        const inp = hydrated as unknown as BsmInput;
        expect(Number.isNaN(priceBsm(inp)), `${c.label}.priceBsm`).toBe(true);
        expectAllGreeksNan(greeksBsm(inp), c.label);
      } else {
        const inp = hydrated as unknown as Black76Input;
        expect(Number.isNaN(priceBlack76(inp)), `${c.label}.priceBlack76`).toBe(true);
        expectAllGreeksNan(greeksBlack76(inp), c.label);
      }
    }
  });

  it('validates IV market quotes, strict arbitrage bounds, flat-vega plateaus, and solver options', () => {
    let maxIvRelDiff = 0;

    for (const c of fixture.ivCases) {
      const frozenOptions = c.input.options ? Object.freeze({ ...c.input.options }) : undefined;
      if (c.model === 'bsm') {
        const inp: SolveImpliedVolBsmInput = Object.freeze({
          spot: c.input.spot ?? Number.NaN,
          strike: c.input.strike,
          timeToExpiry: c.input.timeToExpiry,
          rate: c.input.rate,
          dividendYield: c.input.dividendYield ?? Number.NaN,
          contractType: c.input.contractType,
          price: c.input.price,
          ...(frozenOptions === undefined ? {} : { options: frozenOptions }),
        });
        const iv = solveImpliedVolBsm(inp);
        if (c.expectedIv === 'NaN') {
          expect(Number.isNaN(iv), `${c.label} expected NaN`).toBe(true);
        } else {
          const diff = expectCloseToReference(iv, c.expectedIv, c.label);
          maxIvRelDiff = Math.max(maxIvRelDiff, diff.relDiff);
          const repriced = priceBsm({
            spot: inp.spot,
            strike: inp.strike,
            timeToExpiry: inp.timeToExpiry,
            rate: inp.rate,
            dividendYield: inp.dividendYield,
            volatility: iv,
            contractType: inp.contractType,
          });
          expectCloseToReference(repriced, inp.price, `${c.label}.repriced`);
        }
      } else {
        const inp: SolveImpliedVolBlack76Input = Object.freeze({
          forward: c.input.forward ?? Number.NaN,
          strike: c.input.strike,
          timeToExpiry: c.input.timeToExpiry,
          rate: c.input.rate,
          contractType: c.input.contractType,
          price: c.input.price,
          ...(frozenOptions === undefined ? {} : { options: frozenOptions }),
        });
        const iv = solveImpliedVolBlack76(inp);
        if (c.expectedIv === 'NaN') {
          expect(Number.isNaN(iv), `${c.label} expected NaN`).toBe(true);
        } else {
          const diff = expectCloseToReference(iv, c.expectedIv, c.label);
          maxIvRelDiff = Math.max(maxIvRelDiff, diff.relDiff);
          const repriced = priceBlack76({
            forward: inp.forward,
            strike: inp.strike,
            timeToExpiry: inp.timeToExpiry,
            rate: inp.rate,
            volatility: iv,
            contractType: inp.contractType,
          });
          expectCloseToReference(repriced, inp.price, `${c.label}.repriced`);
        }
      }
    }

    expect(maxIvRelDiff).toBeLessThan(REL_TOL);

    // Invalid solver options reject cleanly with NaN
    const validQuote: SolveImpliedVolBsmInput = {
      spot: 100,
      strike: 100,
      timeToExpiry: 0.5,
      rate: 0.04,
      dividendYield: 0.01,
      contractType: 'call',
      price: 6.5,
    };
    expect(Number.isNaN(solveImpliedVolBsm({ ...validQuote, options: { minVolatility: 0 } }))).toBe(
      true,
    );
    expect(
      Number.isNaN(
        solveImpliedVolBsm({
          ...validQuote,
          options: { minVolatility: 0.5, maxVolatility: 0.5 },
        }),
      ),
    ).toBe(true);
    expect(Number.isNaN(solveImpliedVolBsm({ ...validQuote, options: { tolerance: 0 } }))).toBe(
      true,
    );
    expect(
      Number.isNaN(solveImpliedVolBsm({ ...validQuote, options: { maxIterations: 2.5 } })),
    ).toBe(true);
    expect(Number.isNaN(solveImpliedVolBsm({ ...validQuote, options: { minVega: -1 } }))).toBe(true);
  });

  it('maintains strict price monotonicity wrt volatility across BSM and Black-76 grids', () => {
    const vols = [0.005, 0.05, 0.15, 0.3, 0.75, 1.5, 3.0, 6.0];
    let prevBsm = -1;
    let prevB76 = -1;
    for (const volatility of vols) {
      const gBsm = greeksBsm({
        spot: 5850,
        strike: 5750,
        timeToExpiry: 0.05,
        rate: 0.045,
        dividendYield: 0.013,
        volatility,
        contractType: 'call',
      });
      const gB76 = greeksBlack76({
        forward: 24.0,
        strike: 12.0,
        timeToExpiry: 14 / 365,
        rate: 0.045,
        volatility,
        contractType: 'call',
      });
      expect(gBsm.vega).toBeGreaterThanOrEqual(0);
      expect(gB76.vega).toBeGreaterThanOrEqual(0);
      expect(gBsm.price).toBeGreaterThanOrEqual(prevBsm);
      expect(gB76.price).toBeGreaterThanOrEqual(prevB76);
      prevBsm = gBsm.price;
      prevB76 = gB76.price;
    }
  });
});
