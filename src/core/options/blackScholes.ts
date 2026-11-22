import { MAX_TIME_SECONDS } from '../sessions.js';
import { normCdf, normPdf } from './math.js';
import type {
  ArbitrageBounds,
  Black76Input,
  BsmInput,
  OptionContractType,
  OptionGreeksResult,
} from './types.js';

/** Number of seconds in an exact 365-day calendar year (ACT/365). */
export const SECONDS_PER_YEAR_365 = 365 * 86_400;
export const MIN_CONTRACTUAL_EXPIRY_SEC = 60;

type OptionModelKind = 'bsm' | 'black76';

const NAN_GREEKS_RESULT: OptionGreeksResult = Object.freeze({
  price: Number.NaN,
  delta: Number.NaN,
  gamma: Number.NaN,
  theta: Number.NaN,
  thetaDaily: Number.NaN,
  vega: Number.NaN,
  vegaPer1Pct: Number.NaN,
  rho: Number.NaN,
  vanna: Number.NaN,
  charm: Number.NaN,
});

const NAN_ARBITRAGE_BOUNDS: ArbitrageBounds = Object.freeze({
  lower: Number.NaN,
  upper: Number.NaN,
});

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isValidContractType(contractType: unknown): contractType is OptionContractType {
  return contractType === 'call' || contractType === 'put';
}

function computeDiscountedParity(
  underlier: number,
  strike: number,
  timeToExpiry: number,
  rate: number,
  carryRate: number,
  discUnderlierFactor: number,
  discStrikeFactor: number,
): number {
  const carryExponent = -carryRate * timeToExpiry;
  const rateExponent = -rate * timeToExpiry;
  // Avoid S*exp(-qT) - K*exp(-rT) catastrophic cancellation when discount factors are near 1.
  if (Math.abs(carryExponent) <= 0.5 && Math.abs(rateExponent) <= 0.5) {
    return (
      underlier -
      strike +
      underlier * Math.expm1(carryExponent) -
      strike * Math.expm1(rateExponent)
    );
  }
  return underlier * discUnderlierFactor - strike * discStrikeFactor;
}

function computeArbitrageBounds(
  underlier: number,
  strike: number,
  timeToExpiry: number,
  rate: number,
  carryRate: number,
  contractType: OptionContractType,
): ArbitrageBounds {
  if (
    !isPositiveFinite(underlier) ||
    !isPositiveFinite(strike) ||
    !isPositiveFinite(timeToExpiry) ||
    !Number.isFinite(rate) ||
    !Number.isFinite(carryRate) ||
    !isValidContractType(contractType)
  ) {
    return NAN_ARBITRAGE_BOUNDS;
  }

  const discUnderlierFactor = Math.exp(-carryRate * timeToExpiry);
  const discStrikeFactor = Math.exp(-rate * timeToExpiry);
  const discUnderlier = underlier * discUnderlierFactor;
  const discStrike = strike * discStrikeFactor;
  if (!Number.isFinite(discUnderlier) || !Number.isFinite(discStrike)) {
    return NAN_ARBITRAGE_BOUNDS;
  }

  const discParity = computeDiscountedParity(
    underlier,
    strike,
    timeToExpiry,
    rate,
    carryRate,
    discUnderlierFactor,
    discStrikeFactor,
  );
  if (!Number.isFinite(discParity)) {
    return NAN_ARBITRAGE_BOUNDS;
  }

  if (contractType === 'call') {
    return {
      lower: Math.max(0, discParity),
      upper: discUnderlier,
    };
  }

  return {
    lower: Math.max(0, -discParity),
    upper: discStrike,
  };
}

interface GeneralizedKernel {
  readonly price: number;
  readonly discUnderlierFactor: number;
  readonly discStrikeFactor: number;
  readonly d1: number;
  readonly d2: number;
  readonly sqrtT: number;
  readonly volSqrtT: number;
  readonly cdfPos: number;
  readonly cdfNeg: number;
  readonly cdfD2Pos: number;
  readonly cdfD2Neg: number;
}

function evaluatePriceKernel(
  underlier: number,
  strike: number,
  timeToExpiry: number,
  rate: number,
  carryRate: number,
  volatility: number,
  contractType: OptionContractType,
): GeneralizedKernel | null {
  if (
    !isPositiveFinite(underlier) ||
    !isPositiveFinite(strike) ||
    !isPositiveFinite(timeToExpiry) ||
    !Number.isFinite(rate) ||
    !Number.isFinite(carryRate) ||
    !isPositiveFinite(volatility) ||
    !isValidContractType(contractType)
  ) {
    return null;
  }

  const sqrtT = Math.sqrt(timeToExpiry);
  const volSqrtT = volatility * sqrtT;
  if (!isPositiveFinite(sqrtT) || !isPositiveFinite(volSqrtT)) {
    return null;
  }

  const discUnderlierFactor = Math.exp(-carryRate * timeToExpiry);
  const discStrikeFactor = Math.exp(-rate * timeToExpiry);
  const discUnderlier = underlier * discUnderlierFactor;
  const discStrike = strike * discStrikeFactor;
  if (!Number.isFinite(discUnderlier) || !Number.isFinite(discStrike)) {
    return null;
  }

  const logMoneyness = Math.log(underlier) - Math.log(strike);
  const driftTerm = (rate - carryRate + 0.5 * volatility * volatility) * timeToExpiry;
  const d1 = (logMoneyness + driftTerm) / volSqrtT;
  const d2 = d1 - volSqrtT;
  if (!Number.isFinite(d1) || !Number.isFinite(d2)) {
    return null;
  }

  // Evaluate tail CDFs directly via normCdf(-x) instead of (1 - normCdf(x)) to preserve tail accuracy.
  const cdfPos = normCdf(d1);
  const cdfNeg = normCdf(-d1);
  const cdfD2Pos = normCdf(d2);
  const cdfD2Neg = normCdf(-d2);

  const discParity = computeDiscountedParity(
    underlier,
    strike,
    timeToExpiry,
    rate,
    carryRate,
    discUnderlierFactor,
    discStrikeFactor,
  );

  // Decompose deep-ITM contracts as discounted parity + OTM time value to avoid S - K loss.
  const price =
    contractType === 'call'
      ? d2 > 0
        ? discParity + Math.max(0, discStrike * cdfD2Neg - discUnderlier * cdfNeg)
        : Math.max(0, discUnderlier * cdfPos - discStrike * cdfD2Pos)
      : d1 < 0
        ? -discParity + Math.max(0, discUnderlier * cdfPos - discStrike * cdfD2Pos)
        : Math.max(0, discStrike * cdfD2Neg - discUnderlier * cdfNeg);

  if (!Number.isFinite(price)) {
    return null;
  }

  return {
    price,
    discUnderlierFactor,
    discStrikeFactor,
    d1,
    d2,
    sqrtT,
    volSqrtT,
    cdfPos,
    cdfNeg,
    cdfD2Pos,
    cdfD2Neg,
  };
}

function evaluateGeneralizedGreeks(
  underlier: number,
  strike: number,
  timeToExpiry: number,
  rate: number,
  carryRate: number,
  volatility: number,
  contractType: OptionContractType,
  model: OptionModelKind,
): OptionGreeksResult {
  const k = evaluatePriceKernel(
    underlier,
    strike,
    timeToExpiry,
    rate,
    carryRate,
    volatility,
    contractType,
  );
  if (k === null) {
    return NAN_GREEKS_RESULT;
  }

  const pdfD1 = normPdf(k.d1);
  const gammaDenom = underlier * k.volSqrtT;
  if (!isPositiveFinite(gammaDenom)) {
    return NAN_GREEKS_RESULT;
  }

  const delta =
    contractType === 'call'
      ? k.discUnderlierFactor * k.cdfPos
      : -k.discUnderlierFactor * k.cdfNeg;

  const gamma = pdfD1 === 0 ? 0 : (k.discUnderlierFactor * pdfD1) / gammaDenom;
  const vega = pdfD1 === 0 ? 0 : underlier * k.discUnderlierFactor * k.sqrtT * pdfD1;
  const vegaPer1Pct = vega / 100;

  const timeDecayCore =
    pdfD1 === 0 ? 0 : -(underlier * k.discUnderlierFactor * pdfD1 * volatility) / (2 * k.sqrtT);

  const theta =
    contractType === 'call'
      ? timeDecayCore +
        carryRate * underlier * k.discUnderlierFactor * k.cdfPos -
        rate * strike * k.discStrikeFactor * k.cdfD2Pos
      : timeDecayCore -
        carryRate * underlier * k.discUnderlierFactor * k.cdfNeg +
        rate * strike * k.discStrikeFactor * k.cdfD2Neg;
  const thetaDaily = theta / 365;

  const rho =
    model === 'black76'
      ? -timeToExpiry * k.price
      : contractType === 'call'
        ? strike * timeToExpiry * k.discStrikeFactor * k.cdfD2Pos
        : -strike * timeToExpiry * k.discStrikeFactor * k.cdfD2Neg;

  const vanna = pdfD1 === 0 ? 0 : -k.discUnderlierFactor * pdfD1 * (k.d2 / volatility);

  // Charm = -dDelta/dT (= +dDelta/dt_calendar): rate of change of delta as calendar time passes.
  let charmDriftRatio = 0;
  if (pdfD1 !== 0) {
    const charmDenom = 2 * timeToExpiry * k.volSqrtT;
    if (!isPositiveFinite(charmDenom)) {
      return NAN_GREEKS_RESULT;
    }
    charmDriftRatio =
      (2 * (rate - carryRate) * timeToExpiry - k.d2 * k.volSqrtT) / charmDenom;
  }

  const charmCommon = pdfD1 === 0 ? 0 : k.discUnderlierFactor * pdfD1 * charmDriftRatio;
  const charm =
    contractType === 'call'
      ? carryRate * k.discUnderlierFactor * k.cdfPos - charmCommon
      : -carryRate * k.discUnderlierFactor * k.cdfNeg - charmCommon;

  if (
    !Number.isFinite(delta) ||
    !Number.isFinite(gamma) ||
    !Number.isFinite(theta) ||
    !Number.isFinite(thetaDaily) ||
    !Number.isFinite(vega) ||
    !Number.isFinite(vegaPer1Pct) ||
    !Number.isFinite(rho) ||
    !Number.isFinite(vanna) ||
    !Number.isFinite(charm)
  ) {
    return NAN_GREEKS_RESULT;
  }

  return {
    price: k.price,
    delta,
    gamma,
    theta,
    thetaDaily,
    vega,
    vegaPer1Pct,
    rho,
    vanna,
    charm,
  };
}

/**
 * Converts UTC epoch timestamps in seconds into time to expiry `T` in years.
 *
 * Enforces project-wide UTC-seconds validation (`|t| <= 1e11`) to reject
 * millisecond timestamps. Returns `NaN` if the contract has already expired
 * (`expiryUtcSec < nowUtcSec`) or any input is invalid; returns `0` when
 * `expiryUtcSec === nowUtcSec`.
 */
export function timeToExpiryYears(
  nowUtcSec: number,
  expiryUtcSec: number,
  secondsPerYear = SECONDS_PER_YEAR_365,
): number {
  if (
    !Number.isFinite(nowUtcSec) ||
    !Number.isFinite(expiryUtcSec) ||
    !isPositiveFinite(secondsPerYear)
  ) {
    return Number.NaN;
  }
  if (Math.abs(nowUtcSec) > MAX_TIME_SECONDS || Math.abs(expiryUtcSec) > MAX_TIME_SECONDS) {
    return Number.NaN;
  }
  if (expiryUtcSec < nowUtcSec) {
    return Number.NaN;
  }
  if (expiryUtcSec === nowUtcSec) {
    return 0;
  }
  return (expiryUtcSec - nowUtcSec) / secondsPerYear;
}

/** Tiempo ACT/365 sin piso para valoración continua. El límite es exclusivo. */
export function resolveContractualTimeToExpiryYears(
  nowUtcSec: number,
  expiryUtcSec: number,
  minRemainingSec = 0,
  secondsPerYear = SECONDS_PER_YEAR_365,
): number {
  if (!Number.isFinite(minRemainingSec) || minRemainingSec < 0 ||
      expiryUtcSec - nowUtcSec <= minRemainingSec) return Number.NaN;
  return timeToExpiryYears(nowUtcSec, expiryUtcSec, secondsPerYear);
}

/**
 * Exact terminal payoff at expiration (`T = 0`), kept explicit and separate from
 * continuous Greeks: `max(0, underlier - strike)` for calls, `max(0, strike - underlier)`
 * for puts. Returns `NaN` for invalid or non-positive underlier/strike.
 */
export function evaluateOptionAtExpiry(
  underlier: number,
  strike: number,
  contractType: OptionContractType,
): number {
  if (!isPositiveFinite(underlier) || !isPositiveFinite(strike) || !isValidContractType(contractType)) {
    return Number.NaN;
  }
  return contractType === 'call'
    ? Math.max(0, underlier - strike)
    : Math.max(0, strike - underlier);
}

/**
 * Strict European BSM no-arbitrage price interval `[lower, upper]`:
 * - Call: `[max(0, S * e^{-qT} - K * e^{-rT}), S * e^{-qT}]`
 * - Put: `[max(0, K * e^{-rT} - S * e^{-qT}), K * e^{-rT}]`
 */
export function bsmArbitrageBounds(input: Omit<BsmInput, 'volatility'>): ArbitrageBounds {
  return computeArbitrageBounds(
    input.spot,
    input.strike,
    input.timeToExpiry,
    input.rate,
    input.dividendYield,
    input.contractType,
  );
}

/**
 * Strict European Black-76 no-arbitrage price interval `[lower, upper]`:
 * - Call: `[max(0, e^{-rT} * (F - K)), e^{-rT} * F]`
 * - Put: `[max(0, e^{-rT} * (K - F)), e^{-rT} * K]`
 */
export function black76ArbitrageBounds(input: Omit<Black76Input, 'volatility'>): ArbitrageBounds {
  return computeArbitrageBounds(
    input.forward,
    input.strike,
    input.timeToExpiry,
    input.rate,
    input.rate,
    input.contractType,
  );
}

/**
 * Computes the European Black-Scholes-Merton (BSM) option price.
 * Returns `NaN` if any parameter is non-finite or `spot, strike, timeToExpiry, volatility <= 0`.
 */
export function priceBsm(input: BsmInput): number {
  const kernel = evaluatePriceKernel(
    input.spot,
    input.strike,
    input.timeToExpiry,
    input.rate,
    input.dividendYield,
    input.volatility,
    input.contractType,
  );
  return kernel === null ? Number.NaN : kernel.price;
}

/**
 * Computes BSM option price along with 1st- and 2nd-order analytical Greeks:
 * - `delta`: `dV/dS` (dimensionless)
 * - `gamma`: `d^2V/dS^2` (per unit^2 underlier, `>= 0`)
 * - `theta`: annualized calendar decay `-dV/dT` (currency / year)
 * - `thetaDaily`: daily calendar decay `theta / 365` (currency / day)
 * - `vega`: `dV/dSigma` per `+1.00` (`+100%`) volatility (`>= 0`)
 * - `vegaPer1Pct`: `vega / 100` per `+0.01` (`+1` vol point)
 * - `rho`: `dV/dr` per `+1.00` risk-free rate (holding `spot` and `dividendYield` fixed)
 * - `vanna`: `dDelta/dSigma = dVega/dS` per `+1.00` volatility
 * - `charm`: annualized calendar-time delta decay `-dDelta/dT` (per year)
 */
export function greeksBsm(input: BsmInput): OptionGreeksResult {
  return evaluateGeneralizedGreeks(
    input.spot,
    input.strike,
    input.timeToExpiry,
    input.rate,
    input.dividendYield,
    input.volatility,
    input.contractType,
    'bsm',
  );
}

/**
 * Computes the European Black-76 option price on a forward/futures underlier `F`
 * (e.g. VIX options or futures options).
 * Returns `NaN` if any parameter is non-finite or `forward, strike, timeToExpiry, volatility <= 0`.
 */
export function priceBlack76(input: Black76Input): number {
  const kernel = evaluatePriceKernel(
    input.forward,
    input.strike,
    input.timeToExpiry,
    input.rate,
    input.rate,
    input.volatility,
    input.contractType,
  );
  return kernel === null ? Number.NaN : kernel.price;
}

/**
 * Computes Black-76 option price along with 1st- and 2nd-order analytical Greeks:
 * - `delta`: `dV/dF` wrt forward/futures price `F`
 * - `gamma`: `d^2V/dF^2` (`>= 0`)
 * - `theta`: annualized calendar decay `-dV/dT` (currency / year)
 * - `thetaDaily`: `theta / 365` (currency / day)
 * - `vega`: `dV/dSigma` per `+1.00` volatility (`>= 0`)
 * - `vegaPer1Pct`: `vega / 100` per `+0.01` volatility
 * - `rho`: `dV/dr = -T * price` (holding forward `F` fixed)
 * - `vanna`: `dDelta/dSigma` wrt forward delta
 * - `charm`: annualized calendar-time forward-delta decay `-dDelta/dT` (per year)
 */
export function greeksBlack76(input: Black76Input): OptionGreeksResult {
  return evaluateGeneralizedGreeks(
    input.forward,
    input.strike,
    input.timeToExpiry,
    input.rate,
    input.rate,
    input.volatility,
    input.contractType,
    'black76',
  );
}

export * from './whatIfPayoff.js';
