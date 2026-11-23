import {
  DEFAULT_CRR_STEPS, MAX_CRR_STEPS, priceAmericanBjerksund2002, priceAmericanCrrDiscrete, solveImpliedVolAmerican,
  type SolveImpliedVolAmericanInput,
} from './american.js';
import { MIN_CONTRACTUAL_EXPIRY_SEC } from './blackScholes.js';
import { solveImpliedVolBsm } from './impliedVol.js';
import type { AmericanIvStatus, ImpliedVolResolution, ObservedOptionQuote } from './ivContract.js';
import { resolveContractMultiplier, type ArMarketFieldSource, type ContractMultiplierSource } from './oiProvenance.js';

type BoundsInput = Pick<SolveImpliedVolAmericanInput,
  'spot' | 'strike' | 'contractType' | 'timeToExpiry' | 'rate' | 'dividendYield' | 'discreteDividends'>;

export interface AmericanIvDiagnosticInput extends Omit<SolveImpliedVolAmericanInput, 'timeToExpiry' | 'marketPrice'> {
  readonly instrumentId: string;
  readonly asOfUtcSec: number;
  readonly expiryUtcSec: number;
  readonly bid?: number | null;
  readonly ask?: number | null;
  readonly last?: number | null;
  readonly source?: ArMarketFieldSource;
  readonly quoteAsOfUtcSec?: number | null;
  readonly maxQuoteAgeSec?: number;
  readonly bypassStaleness?: boolean;
  readonly currency?: 'ARS' | 'USD';
  readonly exerciseStyle?: 'AMERICAN' | 'EUROPEAN';
  readonly contractMultiplier?: number;
  readonly multiplierSource?: ContractMultiplierSource;
  readonly includeDiagnosticEuropeanProxy?: boolean;
}

const finite = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const positive = (value: number | null): value is number => value !== null && value > 0;
const contractTypes: readonly string[] = ['call', 'put'];
const currencies: readonly string[] = ['ARS', 'USD'];

export function computeAmericanArbitrageBounds(input: BoundsInput) {
  const { spot, strike, timeToExpiry: t, rate, dividendYield, contractType, discreteDividends = [] } = input;
  if (![spot, strike, t, rate, dividendYield].every(Number.isFinite) || spot <= 0 || strike <= 0 ||
      t <= 0 || !contractTypes.includes(contractType)) return null;
  let pv = 0;
  for (const { time, amount } of discreteDividends) {
    if (!Number.isFinite(time) || time <= 0 || time > t || !Number.isFinite(amount) || amount < 0) return null;
    pv += amount * Math.exp(-rate * time);
  }
  const escrowedSpot = spot - pv;
  if (!(escrowedSpot > 0)) return null;
  const rT = -rate * t;
  const qT = -dividendYield * t;
  const parity = Math.abs(rT) <= 0.5 && Math.abs(qT) <= 0.5
    ? (escrowedSpot - strike) + escrowedSpot * Math.expm1(qT) - strike * Math.expm1(rT)
    : escrowedSpot * Math.exp(qT) - strike * Math.exp(rT);
  if (!Number.isFinite(parity)) return null;
  const sign = contractType === 'call' ? 1 : -1;
  const intrinsic = Math.max(0, sign * (spot - strike));
  const europeanFloor = Math.max(0, sign * parity);
  return { intrinsic, europeanFloor, lower: Math.max(intrinsic, europeanFloor),
    upper: contractType === 'call' ? spot : strike, escrowedSpot };
}

export function solveImpliedVolAmericanDetailed(input: AmericanIvDiagnosticInput): ImpliedVolResolution {
  const bid = finite(input.bid);
  const ask = finite(input.ask);
  const last = finite(input.last);
  const crossed = positive(bid) && positive(ask) && bid > ask;
  const mid = positive(bid) && positive(ask) && !crossed ? bid / 2 + ask / 2 : null;
  const referencePrice = crossed ? null : mid ?? (positive(last) ? last : null);
  const timestamp = finite(input.quoteAsOfUtcSec);
  const source = input.source ?? 'NONE';
  const currency = input.currency ?? 'ARS';
  const observedQuote: ObservedOptionQuote = {
    bid, ask, mid, last, referencePrice, source, timestamp, currency,
    referenceBasis: mid !== null ? 'MID' : referencePrice !== null ? 'LAST' : 'NONE',
  };
  const remainingSec = input.expiryUtcSec - input.asOfUtcSec;
  const timeToExpiry = remainingSec / 31_536_000;
  const modelInput = { ...input, timeToExpiry };
  const bounds = computeAmericanArbitrageBounds(modelInput);
  const evidence = {
    instrumentId: input.instrumentId, observedQuote, source, timestamp,
    units: { currency, contractMultiplier: finite(input.contractMultiplier), multiplierSource: input.multiplierSource ?? 'UNVERIFIED',
      exerciseStyle: 'AMERICAN' as const, timeBasis: 'ACT_365' as const },
    bounds: {
      intrinsic: bounds?.intrinsic ?? null, europeanFloor: bounds?.europeanFloor ?? null,
      lower: bounds?.lower ?? null, upper: bounds?.upper ?? null,
      priceMinusLower: bounds !== null && referencePrice !== null ? referencePrice - bounds.lower : null,
    },
  };
  const fail = (modelStatus: Exclude<AmericanIvStatus, 'SOLVED_AMERICAN'>, reasonCode: string,
    repricingError: number | null = null) => ({
    ...evidence, modelStatus, reasonCode, impliedVol: null, pricingModel: 'NONE' as const,
    inputQuality: modelStatus === 'STALE_INPUT' ? 'STALE' as const
      : referencePrice === null && !crossed ? 'MISSING' as const : 'INVALID' as const,
    riskStatus: 'INDETERMINATE_MARGIN' as const, repricingError,
  });
  if (!Number.isSafeInteger(input.asOfUtcSec) || !Number.isSafeInteger(input.expiryUtcSec)) {
    return fail('INVALID_INPUT', 'INVALID_DOMAIN');
  }
  if (remainingSec <= 0) return fail('INVALID_INPUT', 'EXPIRED_OR_NON_POSITIVE_TIME');
  const { minVolatility = 1e-6, maxVolatility = 9.99, maxIterations = 120 } = input;
  const lattice = (input.discreteDividends?.length ?? 0) > 0 || input.steps !== undefined || input.maxSteps !== undefined;
  const maxSteps = input.maxSteps ?? MAX_CRR_STEPS;
  const steps = input.steps ?? DEFAULT_CRR_STEPS;
  if (bounds === null || !currencies.includes(currency) ||
      (input.exerciseStyle !== undefined && input.exerciseStyle !== 'AMERICAN') ||
      (input.contractMultiplier !== undefined &&
        resolveContractMultiplier(input.contractMultiplier, input.multiplierSource ?? 'UNVERIFIED') === null) ||
      !Number.isFinite(minVolatility) || minVolatility <= 0 || !Number.isFinite(maxVolatility) ||
      maxVolatility <= minVolatility || !Number.isSafeInteger(maxIterations) || maxIterations < 1 ||
      (input.tolerance !== undefined && !(Number.isFinite(input.tolerance) && input.tolerance > 0)) ||
      (lattice && (!Number.isSafeInteger(steps) || !Number.isSafeInteger(maxSteps) ||
        steps < 1 || steps > maxSteps || maxSteps > MAX_CRR_STEPS))) return fail('INVALID_INPUT', 'INVALID_DOMAIN');
  if (crossed) return fail('INVALID_INPUT', 'CROSSED_BOOK');
  if (!positive(referencePrice)) return fail('INVALID_INPUT', 'MISSING_OBSERVED_PRICE');
  if (input.bypassStaleness !== true && timestamp !== null && input.maxQuoteAgeSec !== undefined) {
    if (!Number.isSafeInteger(timestamp) || !Number.isFinite(input.maxQuoteAgeSec) || input.maxQuoteAgeSec < 0) {
      return fail('INVALID_INPUT', 'INVALID_DOMAIN');
    }
    const age = input.asOfUtcSec - timestamp;
    if (age < -30) return fail('STALE_INPUT', 'FUTURE_TIMESTAMP');
    if (age > input.maxQuoteAgeSec) return fail('STALE_INPUT', 'QUOTE_STALE');
  }

  const price = (volatility: number) => lattice
    ? priceAmericanCrrDiscrete({ ...modelInput, volatility, steps, maxSteps })
    : priceAmericanBjerksund2002({ ...modelInput, volatility });
  const boundEps = 1e-12 * Math.max(1, input.spot, input.strike);
  if (referencePrice < bounds.lower - boundEps) {
    const result = fail('BELOW_INTRINSIC', referencePrice < bounds.intrinsic - boundEps
      ? 'BELOW_IMMEDIATE_INTRINSIC' : 'BELOW_DISCOUNTED_PARITY_FLOOR');
    if (!input.includeDiagnosticEuropeanProxy) return result;
    const iv = solveImpliedVolBsm({
      ...modelInput, spot: bounds.escrowedSpot, price: referencePrice, options: { minVolatility, maxVolatility },
    });
    return Number.isFinite(iv) && iv > 0
      ? { ...result, diagnosticProxy: { iv, pricingModel: 'EUROPEAN_BSM_DIAGNOSTIC',
        repricingAmericanPrice: finite(price(iv)), disclaimer: 'DIAGNOSTIC_ONLY_NOT_AMERICAN_IV' } }
      : result;
  }
  if (referencePrice > bounds.upper + boundEps) return fail('ABOVE_UPPER_BOUND', 'EXCEEDS_AMERICAN_UPPER_BOUND');
  if (Math.abs(referencePrice - bounds.lower) <= boundEps) return fail('UNIDENTIFIABLE_AMERICAN_IV', 'AT_LOWER_BOUND_ZERO_VEGA');
  if (Math.abs(referencePrice - bounds.upper) <= boundEps) return fail('UNIDENTIFIABLE_AMERICAN_IV', 'AT_UPPER_BOUND_INFINITE_VOL');
  if (remainingSec <= MIN_CONTRACTUAL_EXPIRY_SEC) return fail('UNIDENTIFIABLE_AMERICAN_IV', 'NEAR_EXPIRY_DEGENERATE');

  const low = lattice ? Math.max(minVolatility,
    Math.abs(input.rate - input.dividendYield) * Math.sqrt(timeToExpiry / steps) * (1 + 1e-6) + 1e-9) : minVolatility;
  const high = lattice ? Math.min(maxVolatility,
    (680 - Math.max(0, Math.log(bounds.escrowedSpot))) / Math.sqrt(steps * timeToExpiry)) : maxVolatility;
  if (low >= high) return fail('UNIDENTIFIABLE_AMERICAN_IV', 'BELOW_MIN_VOL_DOMAIN');
  const lowPrice = price(low);
  const highPrice = price(high);
  if (!Number.isFinite(lowPrice) || !Number.isFinite(highPrice)) return fail('SOLVER_FAILURE', 'PRICER_NON_FINITE');
  const priceTol = Math.min(1e-9, input.tolerance ?? 1e-9);
  if (lowPrice > referencePrice + priceTol) return fail('UNIDENTIFIABLE_AMERICAN_IV', 'BELOW_MIN_VOL_DOMAIN');
  if (highPrice < referencePrice - priceTol) return fail('UNIDENTIFIABLE_AMERICAN_IV', 'ABOVE_MAX_VOL_DOMAIN');
  const iv = solveImpliedVolAmerican({
    ...modelInput, marketPrice: referencePrice, minVolatility, maxVolatility, maxIterations, tolerance: Math.min(priceTol, 1e-12),
  });
  if (!(Number.isFinite(iv) && iv > 0)) return fail('SOLVER_FAILURE', 'NON_CONVERGENCE');
  const error = price(iv) - referencePrice;
  if (!Number.isFinite(error)) return fail('SOLVER_FAILURE', 'PRICER_NON_FINITE');
  if (Math.abs(error) > priceTol) return fail('SOLVER_FAILURE', 'REPRICING_RESIDUAL_EXCEEDED', error);
  const step = Math.max(1e-7, iv * 1e-4);
  const right = Math.min(high, iv + step);
  const left = Math.max(low, iv - step);
  const vega = (price(right) - price(left)) / (right - left);
  if (!Number.isFinite(vega)) return fail('SOLVER_FAILURE', 'PRICER_NON_FINITE');
  if (vega <= 1e-12 * Math.max(1, referencePrice)) return fail('UNIDENTIFIABLE_AMERICAN_IV', 'FLAT_VEGA_EARLY_EXERCISE_REGION');
  return { ...evidence, modelStatus: 'SOLVED_AMERICAN', reasonCode: 'OK', impliedVol: iv,
    pricingModel: lattice ? 'AMERICAN_CRR_DISCRETE' : 'AMERICAN_BS2002', repricingError: error,
    inputQuality: 'OBSERVED', riskStatus: 'VALID_MODEL_MARGIN' };
}
