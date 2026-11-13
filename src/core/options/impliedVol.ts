import {
  black76ArbitrageBounds,
  bsmArbitrageBounds,
  greeksBlack76,
  greeksBsm,
} from './blackScholes.js';
import type {
  ArbitrageBounds,
  ImpliedVolSolverOptions,
  OptionGreeksResult,
  SolveImpliedVolBlack76Input,
  SolveImpliedVolBsmInput,
} from './types.js';

const DEFAULT_MIN_VOL = 1e-9;
const DEFAULT_MAX_VOL = 100.0;
const DEFAULT_TOLERANCE = 1e-11;
const DEFAULT_MAX_ITERATIONS = 120;
const DEFAULT_MIN_VEGA = 1e-16;
const LOG_MIDPOINT_RATIO_THRESHOLD = 16;

interface ResolvedSolverConfig {
  readonly minVolatility: number;
  readonly maxVolatility: number;
  readonly tolerance: number;
  readonly maxIterations: number;
  readonly minVega: number;
}

function resolveSolverConfig(options?: ImpliedVolSolverOptions): ResolvedSolverConfig | null {
  const minVolatility = options?.minVolatility ?? DEFAULT_MIN_VOL;
  const maxVolatility = options?.maxVolatility ?? DEFAULT_MAX_VOL;
  const tolerance = options?.tolerance ?? DEFAULT_TOLERANCE;
  const maxIterations = options?.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const minVega = options?.minVega ?? DEFAULT_MIN_VEGA;

  if (
    !Number.isFinite(minVolatility) ||
    minVolatility <= 0 ||
    !Number.isFinite(maxVolatility) ||
    maxVolatility <= minVolatility ||
    !Number.isFinite(tolerance) ||
    tolerance <= 0 ||
    !Number.isInteger(maxIterations) ||
    maxIterations <= 0 ||
    !Number.isFinite(minVega) ||
    minVega < 0
  ) {
    return null;
  }

  return {
    minVolatility,
    maxVolatility,
    tolerance,
    maxIterations,
    minVega,
  };
}

function chooseBisectionMidpoint(lo: number, hi: number): number {
  const midpoint =
    lo > 0 && hi / lo > LOG_MIDPOINT_RATIO_THRESHOLD ? Math.sqrt(lo * hi) : 0.5 * (lo + hi);
  if (midpoint > lo && midpoint < hi) {
    return midpoint;
  }
  return 0.5 * (lo + hi);
}

function computeInitialGuess(
  underlier: number,
  timeToExpiry: number,
  targetPrice: number,
  lowerBound: number,
  lo: number,
  hi: number,
): number {
  const timeValue = Math.max(0, targetPrice - lowerBound);
  const brenner = Math.sqrt((2 * Math.PI) / timeToExpiry) * (timeValue / underlier);
  if (Number.isFinite(brenner) && brenner > lo && brenner < hi) {
    return brenner;
  }
  return chooseBisectionMidpoint(lo, hi);
}

function solveBracketedImpliedVol(
  underlier: number,
  timeToExpiry: number,
  targetPrice: number,
  bounds: ArbitrageBounds,
  evaluateAtVol: (sigma: number) => OptionGreeksResult,
  options?: ImpliedVolSolverOptions,
): number {
  const config = resolveSolverConfig(options);
  if (
    config === null ||
    !Number.isFinite(targetPrice) ||
    !Number.isFinite(bounds.lower) ||
    !Number.isFinite(bounds.upper)
  ) {
    return Number.NaN;
  }

  // Strict no-arbitrage interior condition: boundary equality corresponds to 0 or +Inf vol.
  if (targetPrice <= bounds.lower || targetPrice >= bounds.upper) {
    return Number.NaN;
  }

  let lo = config.minVolatility;
  let hi = config.maxVolatility;

  const lowEval = evaluateAtVol(lo);
  const highEval = evaluateAtVol(hi);
  if (!Number.isFinite(lowEval.price) || !Number.isFinite(highEval.price)) {
    return Number.NaN;
  }

  const fLow = lowEval.price - targetPrice;
  const fHigh = highEval.price - targetPrice;
  if (fLow > 0 || fHigh < 0) {
    return Number.NaN;
  }
  if (fLow === 0) {
    return lowEval.vega > config.minVega ? lo : Number.NaN;
  }
  if (fHigh === 0) {
    return highEval.vega > config.minVega ? hi : Number.NaN;
  }

  let sigma = computeInitialGuess(underlier, timeToExpiry, targetPrice, bounds.lower, lo, hi);
  let stepPrev = hi - lo;
  let step = stepPrev;

  for (let iter = 0; iter < config.maxIterations; iter += 1) {
    const current = evaluateAtVol(sigma);
    if (!Number.isFinite(current.price) || !Number.isFinite(current.vega)) {
      return Number.NaN;
    }

    const diff = current.price - targetPrice;
    if (diff < 0) {
      lo = sigma;
    } else {
      hi = sigma;
    }

    const sigmaTol = config.tolerance * Math.max(1, sigma);
    const priceTol = config.tolerance * Math.max(1, targetPrice);
    const vegaUsable = current.vega > config.minVega;
    const sigmaResolvable =
      current.vega * sigmaTol > 4 * Number.EPSILON * Math.max(1, targetPrice);
    const residualInSigma = vegaUsable ? Math.abs(diff) / current.vega : Number.POSITIVE_INFINITY;

    if (
      Math.abs(diff) <= priceTol &&
      (hi - lo <= sigmaTol || (vegaUsable && sigmaResolvable && residualInSigma <= sigmaTol))
    ) {
      return vegaUsable ? sigma : Number.NaN;
    }

    // Safeguarded Newton step (Press et al. rtsafe): take tangent only when strictly
    // inside the active bracket and shrinking faster than half the prior step.
    let nextSigma: number;
    let nextStep: number;
    if (vegaUsable) {
      const newtonCandidate = sigma - diff / current.vega;
      const inBracket = newtonCandidate > lo && newtonCandidate < hi;
      const sufficientDecrease = Math.abs(2 * diff) < Math.abs(stepPrev * current.vega);
      if (Number.isFinite(newtonCandidate) && inBracket && sufficientDecrease) {
        nextStep = Math.abs(sigma - newtonCandidate);
        nextSigma = newtonCandidate;
      } else {
        nextSigma = chooseBisectionMidpoint(lo, hi);
        nextStep = Math.abs(sigma - nextSigma);
      }
    } else {
      nextSigma = chooseBisectionMidpoint(lo, hi);
      nextStep = Math.abs(sigma - nextSigma);
    }

    if (!(nextSigma > lo && nextSigma < hi)) {
      return Math.abs(diff) <= priceTol && vegaUsable ? sigma : Number.NaN;
    }

    stepPrev = step;
    step = nextStep;
    sigma = nextSigma;
  }

  return Number.NaN;
}

/**
 * Inverts European Black-Scholes-Merton implied volatility `sigma` for an option price.
 *
 * Strictly checks European no-arbitrage bounds before solving:
 * - Call: `price` in `(max(0, S*e^{-qT} - K*e^{-rT}), S*e^{-qT})`
 * - Put: `price` in `(max(0, K*e^{-rT} - S*e^{-qT}), K*e^{-rT})`
 *
 * Returns `NaN` on invalid inputs, no-arbitrage violations, flat-vega indeterminacy,
 * or failure to bracket/converge within `[minVolatility, maxVolatility]`.
 */
export function solveImpliedVolBsm(input: SolveImpliedVolBsmInput): number {
  const bounds = bsmArbitrageBounds({
    spot: input.spot,
    strike: input.strike,
    timeToExpiry: input.timeToExpiry,
    rate: input.rate,
    dividendYield: input.dividendYield,
    contractType: input.contractType,
  });

  return solveBracketedImpliedVol(
    input.spot,
    input.timeToExpiry,
    input.price,
    bounds,
    (volatility) =>
      greeksBsm({
        spot: input.spot,
        strike: input.strike,
        timeToExpiry: input.timeToExpiry,
        rate: input.rate,
        dividendYield: input.dividendYield,
        volatility,
        contractType: input.contractType,
      }),
    input.options,
  );
}

/**
 * Inverts European Black-76 implied volatility `sigma` for an option on forward/futures `F`.
 *
 * Strictly checks European Black-76 no-arbitrage bounds before solving:
 * - Call: `price` in `(max(0, e^{-rT} * (F - K)), e^{-rT} * F)`
 * - Put: `price` in `(max(0, e^{-rT} * (K - F)), e^{-rT} * K)`
 *
 * Returns `NaN` on invalid inputs, no-arbitrage violations, flat-vega indeterminacy,
 * or failure to bracket/converge within `[minVolatility, maxVolatility]`.
 */
export function solveImpliedVolBlack76(input: SolveImpliedVolBlack76Input): number {
  const bounds = black76ArbitrageBounds({
    forward: input.forward,
    strike: input.strike,
    timeToExpiry: input.timeToExpiry,
    rate: input.rate,
    contractType: input.contractType,
  });

  return solveBracketedImpliedVol(
    input.forward,
    input.timeToExpiry,
    input.price,
    bounds,
    (volatility) =>
      greeksBlack76({
        forward: input.forward,
        strike: input.strike,
        timeToExpiry: input.timeToExpiry,
        rate: input.rate,
        volatility,
        contractType: input.contractType,
      }),
    input.options,
  );
}
