/**
 * Motor 2 — Triángulo de Volatilidad Cross-Currency (IV ARS BS02 vs. IV ADR OPRA),
 * Modos A/B de inversión de volatilidad implícita del CCL y correlación ADR-CCL,
 * interpolación por varianza total, Skew comparado por moneyness estandarizado `z`
 * y detector de Call Overwriting (Secciones 3, 4.1, 5.2 y 8.2).
 *
 * Funciones 100 % puras: cero red, cero E/S, cero UI y cero mutación de argumentos.
 */

import {
  greeksAmericanFiniteDiffOrAnalytical,
  priceAmericanBjerksund2002,
} from '../options/american.js';
import { SECONDS_PER_YEAR_365 } from '../options/blackScholes.js';
import type { OptionContractType, OptionGreeksResult } from '../options/types.js';
import {
  computeExpiration1530ArtUtcSec,
  computeSettlementCalendarDays,
  DAYS_PER_YEAR,
  formatIsoUtcFromSec,
  getBuenosAiresParts,
  interpolateContinuousRate,
  isPositiveFinite,
  isValidUtcSec,
  quoteMid,
  TRADING_DAYS_PER_YEAR,
  type BidAskQuote,
  type ContinuousRateCurvePoint,
  type DiscreteOrdinaryDividend,
} from './types.js';

export const MIN_BYMA_IV = 0.01;
export const MAX_BYMA_IV = 4.0;
export const BYMA_IV_PRICE_TOL_ARS = 1e-7;
export const DEFAULT_RELVAL_THRESHOLD_VOL_PTS = 4.0;

export type BymaOptionArbFlag = 'OK' | 'ARB_INTRINSIC_VIOLATION' | 'OUT_OF_BRACKET' | 'INVALID_INPUT';

export type VolTriangleRegime =
  | 'NORMAL_UNIQUE_ROOT'
  | 'DUAL_ROOT_NEG_CORR'
  | 'VIOLATION_BYMA_COMPRESSED'
  | 'NO_DATA';

export type VolAnomalyBias = 'CHEAP_BYMA' | 'RICH_BYMA' | 'FAIR';

export interface BymaOptionEvalParamsInput {
  readonly asOfUtcSec: number;
  readonly spot24hArs: number;
  readonly expiryDateKey: string;
  readonly expiry1530UtcSec?: number;
  readonly deltaAr1Days?: number;
  readonly deltaExDays?: number;
  readonly arHolidays?: readonly string[];
  readonly caucionRateContinuous?: number;
  readonly rateCurve: readonly ContinuousRateCurvePoint[];
  readonly dividends?: readonly DiscreteOrdinaryDividend[];
}

export interface BymaOptionEvalParams {
  readonly asOfUtcSec: number;
  readonly expiry1530UtcSec: number;
  readonly spot24hArs: number;
  readonly adjustedSpotArs: number;
  readonly forwardArs: number;
  readonly t1Years: number;
  readonly r1Continuous: number;
  readonly tExpYears: number;
  readonly tSettleYears: number;
  readonly rContAtSettle: number;
  readonly rEff: number;
  readonly pvDividendsArs: number;
  readonly maturityDays: number;
}

export interface BymaOptionIvResult {
  readonly iv: number;
  readonly arbFlag: BymaOptionArbFlag;
  readonly lowerBoundArs: number;
  readonly modelPriceAtIvArs: number;
  readonly greeks: OptionGreeksResult | null;
}

export interface EarlyExercisePreExDivInput {
  readonly spotPreExArs: number;
  readonly spotPostEx24hArs: number;
  readonly remainingDividendsPostEx?: readonly DiscreteOrdinaryDividend[];
  readonly strike: number;
  readonly remainingTExpYears: number;
  readonly rEff: number;
  readonly t1Years: number;
  readonly r1Continuous: number;
  readonly volatility: number;
  readonly exerciseAllInCostArs: number;
}

export interface EarlyExercisePreExDivResult {
  readonly continuationValueArs: number;
  readonly earlyExerciseNetValueArs: number;
  readonly edgeArs: number;
  readonly shouldExerciseEarly: boolean;
}

export interface BymaOptionQuoteInput {
  readonly strike: number;
  readonly contractType: OptionContractType;
  readonly quote: BidAskQuote;
  /** Permite inyectar IV externa ya verificada o forzar inversión BS02 desde mid/ask. */
  readonly openInterestNom?: number;
}

export interface OpraSliceQuoteInput {
  readonly strike: number;
  readonly contractType: OptionContractType;
  readonly ivDecimal: number;
  readonly delta?: number;
}

export interface OpraMaturitySliceInput {
  readonly timeToExpiryYears: number;
  readonly forwardUsd: number;
  readonly atmIvDecimal: number;
  readonly quotes: readonly OpraSliceQuoteInput[];
}

export interface ReturnPairObservation {
  readonly time: number;
  readonly adrLogReturn: number;
  readonly cclLogReturn: number;
}

export interface DailyLogReturnObservation {
  readonly time: number;
  readonly logReturn: number;
}

export interface CrossCurrencyVolInput {
  readonly asOfUtcSec: number;
  readonly bymaEval: BymaOptionEvalParamsInput;
  readonly bymaOptions: readonly BymaOptionQuoteInput[];
  readonly opraSlices: readonly OpraMaturitySliceInput[];
  readonly returnHistory?: readonly ReturnPairObservation[];
  readonly cclReturnHistory?: readonly DailyLogReturnObservation[];
  readonly ewmaLambda?: number;
  readonly minCorrObs?: number;
  readonly minHarObs?: number;
  readonly realizedCorrEwmaOverride?: number;
  readonly harRvCclAnnualOverride?: number;
  readonly relValThresholdVolPts?: number;
  readonly singleOpraSliceDayTolerance?: number;
  readonly rightWingMinZ?: number;
}

export interface VolTriangleAnomalyItem {
  readonly standardizedMoneynessZ: number;
  readonly strikeBymaArs: number;
  readonly bymaMidIvPct: number;
  readonly theoreticalBymaIvPct: number;
  readonly relValVolSpreadPct: number;
  readonly sideBias: VolAnomalyBias;
  readonly arbFlag: BymaOptionArbFlag;
}

export interface CrossCurrencyVolOutput {
  readonly timestampUtc: string;
  readonly asOfUtcSec: number;
  readonly maturityBucketDays: number;
  readonly bymaAtmIvPct: number;
  readonly opraAdrAtmIvPct: number;
  readonly realizedCorrEwma: number;
  readonly harRvCclPct: number;
  readonly impliedCclVolPct: number | null;
  readonly impliedCorrelation: number | null;
  readonly boundaryRegime: VolTriangleRegime;
  readonly skewMetrics: {
    readonly byma25dPutMinusCallPct: number;
    readonly opra25dPutMinusCallPct: number;
    readonly overwritingCompressionScore: number;
  };
  readonly arbViolationsCount: number;
  readonly anomalies: readonly VolTriangleAnomalyItem[];
}

const NAN_GREEKS: OptionGreeksResult = {
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
};

/**
 * Construye los parámetros ajustados BS02 T+0 / acciones 24hs / dividendos post-JUL-26 sin ajuste de strike.
 */
export function computeBymaOptionEvalParams(
  input: BymaOptionEvalParamsInput,
): BymaOptionEvalParams | null {
  if (!isValidUtcSec(input.asOfUtcSec) || !isPositiveFinite(input.spot24hArs)) {
    return null;
  }

  const expiry1530UtcSec =
    input.expiry1530UtcSec ?? computeExpiration1530ArtUtcSec(input.expiryDateKey);
  if (!isValidUtcSec(expiry1530UtcSec) || expiry1530UtcSec <= input.asOfUtcSec) {
    return null;
  }

  const art = getBuenosAiresParts(input.asOfUtcSec);
  const arHolidaySet = new Set(input.arHolidays ?? []);
  const deltaAr1Days =
    input.deltaAr1Days ?? computeSettlementCalendarDays(art.dateKey, 1, arHolidaySet);
  const deltaExDays =
    input.deltaExDays ?? computeSettlementCalendarDays(input.expiryDateKey, 1, arHolidaySet);
  if (
    !Number.isFinite(deltaAr1Days) ||
    deltaAr1Days < 0 ||
    !Number.isFinite(deltaExDays) ||
    deltaExDays < 0
  ) {
    return null;
  }

  const t1Years = deltaAr1Days / DAYS_PER_YEAR;
  const tExpYears = (expiry1530UtcSec - input.asOfUtcSec) / SECONDS_PER_YEAR_365;
  const tSettleYears = tExpYears + deltaExDays / DAYS_PER_YEAR;
  if (!isPositiveFinite(tExpYears) || !isPositiveFinite(tSettleYears)) {
    return null;
  }

  const r1Continuous =
    input.caucionRateContinuous ??
    interpolateContinuousRate(input.rateCurve, Math.max(1, deltaAr1Days));
  const rContAtSettle = interpolateContinuousRate(input.rateCurve, tSettleYears * DAYS_PER_YEAR);
  if (!Number.isFinite(r1Continuous) || !Number.isFinite(rContAtSettle)) {
    return null;
  }

  const rEff = rContAtSettle * (tSettleYears / tExpYears);
  if (!Number.isFinite(rEff)) {
    return null;
  }

  let pvDividendsArs = 0;
  for (const div of input.dividends ?? []) {
    if (
      !isValidUtcSec(div.exDivUtcSec) ||
      !isValidUtcSec(div.payDateUtcSec) ||
      !Number.isFinite(div.amountArs) ||
      div.amountArs < 0
    ) {
      return null;
    }
    if (div.exDivUtcSec > input.asOfUtcSec && div.exDivUtcSec <= expiry1530UtcSec) {
      const tauPayYears = Math.max(0, (div.payDateUtcSec - input.asOfUtcSec) / SECONDS_PER_YEAR_365);
      const rPay =
        tauPayYears > 0
          ? interpolateContinuousRate(input.rateCurve, Math.max(1, tauPayYears * DAYS_PER_YEAR))
          : 0;
      if (!Number.isFinite(rPay)) {
        return null;
      }
      pvDividendsArs += div.amountArs * Math.exp(-rPay * tauPayYears);
    }
  }

  const adjustedSpotArs = input.spot24hArs * Math.exp(-r1Continuous * t1Years) - pvDividendsArs;
  const forwardArs = adjustedSpotArs * Math.exp(rEff * tExpYears);
  if (!isPositiveFinite(adjustedSpotArs) || !isPositiveFinite(forwardArs)) {
    return null;
  }

  return {
    asOfUtcSec: input.asOfUtcSec,
    expiry1530UtcSec,
    spot24hArs: input.spot24hArs,
    adjustedSpotArs,
    forwardArs,
    t1Years,
    r1Continuous,
    tExpYears,
    tSettleYears,
    rContAtSettle,
    rEff,
    pvDividendsArs,
    maturityDays: tExpYears * DAYS_PER_YEAR,
  };
}

export function priceBymaAmericanBs02(
  evalParams: BymaOptionEvalParams,
  strike: number,
  volatility: number,
  contractType: OptionContractType,
): number {
  return priceAmericanBjerksund2002({
    spot: evalParams.adjustedSpotArs,
    strike,
    timeToExpiry: evalParams.tExpYears,
    rate: evalParams.rEff,
    dividendYield: 0,
    volatility,
    contractType,
  });
}

export function greeksBymaAmericanBs02(
  evalParams: BymaOptionEvalParams,
  strike: number,
  volatility: number,
  contractType: OptionContractType,
): OptionGreeksResult {
  const g = greeksAmericanFiniteDiffOrAnalytical({
    spot: evalParams.adjustedSpotArs,
    strike,
    timeToExpiry: evalParams.tExpYears,
    rate: evalParams.rEff,
    dividendYield: 0,
    volatility,
    contractType,
  });
  if (!Number.isFinite(g.price)) {
    return NAN_GREEKS;
  }
  const dAdjDSpot = Math.exp(-evalParams.r1Continuous * evalParams.t1Years);
  return {
    ...g,
    delta: g.delta * dAdjDSpot,
    gamma: g.gamma * dAdjDSpot * dAdjDSpot,
    vanna: g.vanna * dAdjDSpot,
    charm: g.charm * dAdjDSpot,
  };
}

export function computeBymaAdjustedLowerBound(
  evalParams: BymaOptionEvalParams,
  strike: number,
  contractType: OptionContractType,
): number {
  if (!isPositiveFinite(strike)) {
    return Number.NaN;
  }
  const discK = strike * Math.exp(-evalParams.rEff * evalParams.tExpYears);
  if (contractType === 'call') {
    return Math.max(0, evalParams.adjustedSpotArs - strike, evalParams.adjustedSpotArs - discK);
  }
  return Math.max(0, strike - evalParams.adjustedSpotArs, discK - evalParams.adjustedSpotArs);
}

/**
 * Inversión híbrida Brent-Newton de IV sobre BS02 BYMA en [0.01, 4.00] con tol = 1e-7 ARS.
 * Emite ARB_INTRINSIC_VIOLATION si ask o precio de referencia cae bajo el intrínseco ajustado.
 */
export function solveBymaAmericanIvHybrid(
  evalParams: BymaOptionEvalParams,
  strike: number,
  contractType: OptionContractType,
  marketQuote: BidAskQuote,
  toleranceArs = BYMA_IV_PRICE_TOL_ARS,
  maxIterations = 100,
): BymaOptionIvResult {
  const invalid: BymaOptionIvResult = {
    iv: Number.NaN,
    arbFlag: 'INVALID_INPUT',
    lowerBoundArs: Number.NaN,
    modelPriceAtIvArs: Number.NaN,
    greeks: null,
  };

  if (!isPositiveFinite(strike) || !isPositiveFinite(toleranceArs)) {
    return invalid;
  }
  const mid = quoteMid(marketQuote);
  const lowerBound = computeBymaAdjustedLowerBound(evalParams, strike, contractType);
  if (!Number.isFinite(lowerBound)) {
    return invalid;
  }
  const upperBound = contractType === 'call' ? evalParams.adjustedSpotArs : strike;

  if (!isPositiveFinite(mid)) {
    return { ...invalid, lowerBoundArs: lowerBound };
  }

  if (marketQuote.ask <= lowerBound || mid <= lowerBound || mid >= upperBound) {
    return {
      iv: Number.NaN,
      arbFlag: 'ARB_INTRINSIC_VIOLATION',
      lowerBoundArs: lowerBound,
      modelPriceAtIvArs: Number.NaN,
      greeks: null,
    };
  }

  const evalResidual = (sigma: number): number =>
    priceBymaAmericanBs02(evalParams, strike, sigma, contractType) - mid;

  let lo = MIN_BYMA_IV;
  let hi = MAX_BYMA_IV;
  const fLow = evalResidual(lo);
  const fHigh = evalResidual(hi);
  if (!Number.isFinite(fLow) || !Number.isFinite(fHigh)) {
    return { ...invalid, lowerBoundArs: lowerBound };
  }
  if (Math.abs(fLow) <= toleranceArs) {
    return {
      iv: lo,
      arbFlag: 'OK',
      lowerBoundArs: lowerBound,
      modelPriceAtIvArs: mid + fLow,
      greeks: greeksBymaAmericanBs02(evalParams, strike, lo, contractType),
    };
  }
  if (Math.abs(fHigh) <= toleranceArs) {
    return {
      iv: hi,
      arbFlag: 'OK',
      lowerBoundArs: lowerBound,
      modelPriceAtIvArs: mid + fHigh,
      greeks: greeksBymaAmericanBs02(evalParams, strike, hi, contractType),
    };
  }
  if (fLow > 0 || fHigh < 0) {
    return {
      iv: Number.NaN,
      arbFlag: fLow > 0 ? 'ARB_INTRINSIC_VIOLATION' : 'OUT_OF_BRACKET',
      lowerBoundArs: lowerBound,
      modelPriceAtIvArs: Number.NaN,
      greeks: null,
    };
  }

  let sigma = 0.5 * (lo + hi);
  let prevStep = hi - lo;
  let step = prevStep;

  for (let iter = 0; iter < maxIterations; iter += 1) {
    const f = evalResidual(sigma);
    if (!Number.isFinite(f)) {
      break;
    }
    if (f < 0) {
      lo = sigma;
    } else {
      hi = sigma;
    }
    if (Math.abs(f) <= toleranceArs || hi - lo <= 1e-12) {
      return {
        iv: sigma,
        arbFlag: 'OK',
        lowerBoundArs: lowerBound,
        modelPriceAtIvArs: mid + f,
        greeks: greeksBymaAmericanBs02(evalParams, strike, sigma, contractType),
      };
    }

    const dSig = Math.max(1e-5, sigma * 1e-4);
    const sUp = Math.min(MAX_BYMA_IV, sigma + dSig);
    const sDn = Math.max(MIN_BYMA_IV, sigma - dSig);
    const vegaApprox =
      sUp > sDn
        ? (priceBymaAmericanBs02(evalParams, strike, sUp, contractType) -
            priceBymaAmericanBs02(evalParams, strike, sDn, contractType)) /
          (sUp - sDn)
        : 0;

    let nextSigma: number;
    let nextStep: number;
    if (Number.isFinite(vegaApprox) && vegaApprox > 1e-10) {
      const newton = sigma - f / vegaApprox;
      const inBracket = newton > lo && newton < hi;
      const fastEnough = Math.abs(2 * f) < Math.abs(prevStep * vegaApprox);
      if (Number.isFinite(newton) && inBracket && fastEnough) {
        nextSigma = newton;
        nextStep = Math.abs(sigma - newton);
      } else {
        nextSigma = 0.5 * (lo + hi);
        nextStep = Math.abs(sigma - nextSigma);
      }
    } else {
      nextSigma = 0.5 * (lo + hi);
      nextStep = Math.abs(sigma - nextSigma);
    }

    prevStep = step;
    step = nextStep;
    sigma = nextSigma;
  }

  const finalRes = evalResidual(sigma);
  if (Number.isFinite(finalRes) && Math.abs(finalRes) <= 10 * toleranceArs) {
    return {
      iv: sigma,
      arbFlag: 'OK',
      lowerBoundArs: lowerBound,
      modelPriceAtIvArs: mid + finalRes,
      greeks: greeksBymaAmericanBs02(evalParams, strike, sigma, contractType),
    };
  }
  return { ...invalid, lowerBoundArs: lowerBound };
}

/**
 * Ecuación (76) / Hipótesis H_6: evalúa frontera de ejercicio anticipado pre-ex-dividendo en Call post-JUL-26.
 */
export function evaluatePreExDivEarlyExercise(
  input: EarlyExercisePreExDivInput,
): EarlyExercisePreExDivResult {
  if (
    !isPositiveFinite(input.spotPreExArs) ||
    !isPositiveFinite(input.spotPostEx24hArs) ||
    !isPositiveFinite(input.strike) ||
    !isPositiveFinite(input.remainingTExpYears) ||
    !isPositiveFinite(input.volatility) ||
    !Number.isFinite(input.rEff) ||
    !Number.isFinite(input.r1Continuous) ||
    !Number.isFinite(input.t1Years) ||
    !Number.isFinite(input.exerciseAllInCostArs)
  ) {
    return {
      continuationValueArs: Number.NaN,
      earlyExerciseNetValueArs: Number.NaN,
      edgeArs: Number.NaN,
      shouldExerciseEarly: false,
    };
  }

  let remPvDiv = 0;
  for (const div of input.remainingDividendsPostEx ?? []) {
    if (Number.isFinite(div.amountArs) && div.amountArs > 0) {
      remPvDiv += div.amountArs;
    }
  }
  const sAdjPost =
    input.spotPostEx24hArs * Math.exp(-input.r1Continuous * input.t1Years) - remPvDiv;
  if (!isPositiveFinite(sAdjPost)) {
    return {
      continuationValueArs: Number.NaN,
      earlyExerciseNetValueArs: Number.NaN,
      edgeArs: Number.NaN,
      shouldExerciseEarly: false,
    };
  }

  const continuationValueArs = priceAmericanBjerksund2002({
    spot: sAdjPost,
    strike: input.strike,
    timeToExpiry: input.remainingTExpYears,
    rate: input.rEff,
    dividendYield: 0,
    volatility: input.volatility,
    contractType: 'call',
  });
  const earlyExerciseNetValueArs =
    (input.spotPreExArs - input.strike) * Math.exp(-input.r1Continuous * input.t1Years) -
    input.exerciseAllInCostArs;
  const edgeArs = earlyExerciseNetValueArs - continuationValueArs;
  return {
    continuationValueArs,
    earlyExerciseNetValueArs,
    edgeArs,
    shouldExerciseEarly: Number.isFinite(edgeArs) && edgeArs > 0,
  };
}

/**
 * Correlación EWMA estrictamente causal (time <= asOfUtcSec) sobre retornos sincrónicos (r_ADR, r_CCL).
 */
export function computeEwmaCorrelation(
  observations: readonly ReturnPairObservation[],
  asOfUtcSec: number,
  lambda = 0.94,
  minObs = 15,
): number {
  if (
    !isValidUtcSec(asOfUtcSec) ||
    !Number.isFinite(lambda) ||
    lambda <= 0 ||
    lambda >= 1
  ) {
    return Number.NaN;
  }

  const causal = observations
    .filter(
      (o) =>
        isValidUtcSec(o.time) &&
        o.time <= asOfUtcSec &&
        Number.isFinite(o.adrLogReturn) &&
        Number.isFinite(o.cclLogReturn),
    )
    .slice()
    .sort((a, b) => a.time - b.time);

  const n = causal.length;
  if (n < minObs) {
    return Number.NaN;
  }

  let wSum = 0;
  let meanA = 0;
  let meanC = 0;
  const weights: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const item = causal[i];
    if (item === undefined) {
      return Number.NaN;
    }
    const w = Math.pow(lambda, n - 1 - i);
    weights.push(w);
    wSum += w;
    meanA += w * item.adrLogReturn;
    meanC += w * item.cclLogReturn;
  }
  if (!isPositiveFinite(wSum)) {
    return Number.NaN;
  }
  meanA /= wSum;
  meanC /= wSum;

  let cov = 0;
  let varA = 0;
  let varC = 0;
  for (let i = 0; i < n; i += 1) {
    const item = causal[i];
    const w = weights[i];
    if (item === undefined || w === undefined) {
      return Number.NaN;
    }
    const da = item.adrLogReturn - meanA;
    const dc = item.cclLogReturn - meanC;
    cov += w * da * dc;
    varA += w * da * da;
    varC += w * dc * dc;
  }
  const denom = Math.sqrt(varA * varC);
  if (!isPositiveFinite(denom)) {
    return Number.NaN;
  }
  const rho = cov / denom;
  return rho < -1 ? -1 : rho > 1 ? 1 : rho;
}

function solveLinearSystem4x4(aIn: readonly (readonly number[])[], bIn: readonly number[]): number[] | null {
  const n = 4;
  const a = aIn.map((row) => row.slice());
  const b = bIn.slice();

  for (let col = 0; col < n; col += 1) {
    let pivotRow = col;
    let pivotAbs = Math.abs(a[col]?.[col] ?? 0);
    for (let r = col + 1; r < n; r += 1) {
      const candidate = Math.abs(a[r]?.[col] ?? 0);
      if (candidate > pivotAbs) {
        pivotAbs = candidate;
        pivotRow = r;
      }
    }
    if (pivotAbs <= 1e-18) {
      return null;
    }
    if (pivotRow !== col) {
      const tmpRow = a[col];
      const pivRowArr = a[pivotRow];
      if (tmpRow === undefined || pivRowArr === undefined) {
        return null;
      }
      a[col] = pivRowArr;
      a[pivotRow] = tmpRow;
      const tmpB = b[col] ?? 0;
      b[col] = b[pivotRow] ?? 0;
      b[pivotRow] = tmpB;
    }

    const colRow = a[col];
    if (colRow === undefined) {
      return null;
    }
    const diag = colRow[col] ?? 0;
    for (let r = col + 1; r < n; r += 1) {
      const targetRow = a[r];
      if (targetRow === undefined) {
        return null;
      }
      const factor = (targetRow[col] ?? 0) / diag;
      for (let c = col; c < n; c += 1) {
        targetRow[c] = (targetRow[c] ?? 0) - factor * (colRow[c] ?? 0);
      }
      b[r] = (b[r] ?? 0) - factor * (b[col] ?? 0);
    }
  }

  const x = [0, 0, 0, 0];
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = a[i];
    if (row === undefined) {
      return null;
    }
    let rhs = b[i] ?? 0;
    for (let c = i + 1; c < n; c += 1) {
      rhs -= (row[c] ?? 0) * (x[c] ?? 0);
    }
    const diag = row[i] ?? 0;
    if (Math.abs(diag) <= 1e-18) {
      return null;
    }
    x[i] = rhs / diag;
  }
  return x;
}

/**
 * Pronóstico HAR-RV causal (Corsi 2009: diario, semanal 5d, mensual 22d) anualizado en decimal.
 */
export function computeHarRvForecast(
  dailyReturns: readonly DailyLogReturnObservation[],
  asOfUtcSec: number,
  minObs = 40,
): number {
  if (!isValidUtcSec(asOfUtcSec)) {
    return Number.NaN;
  }

  const causal = dailyReturns
    .filter((o) => isValidUtcSec(o.time) && o.time <= asOfUtcSec && Number.isFinite(o.logReturn))
    .slice()
    .sort((a, b) => a.time - b.time);

  if (causal.length < minObs || causal.length < 25) {
    return Number.NaN;
  }

  const rvs = causal.map((o) => o.logReturn * o.logReturn);
  const rvAt = (idx: number): number => rvs[idx] ?? 0;
  const rollingMean = (endIdx: number, win: number): number => {
    let acc = 0;
    for (let j = endIdx - win + 1; j <= endIdx; j += 1) {
      acc += rvAt(j);
    }
    return acc / win;
  };

  const rowsX: number[][] = [];
  const targetsY: number[] = [];
  for (let t = 21; t < rvs.length - 1; t += 1) {
    rowsX.push([1, rvAt(t), rollingMean(t, 5), rollingMean(t, 22)]);
    targetsY.push(rvAt(t + 1));
  }

  if (rowsX.length < 10) {
    return Number.NaN;
  }

  const xtx = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  const xty = [0, 0, 0, 0];

  for (let r = 0; r < rowsX.length; r += 1) {
    const xr = rowsX[r];
    const yr = targetsY[r];
    if (xr === undefined || yr === undefined) {
      return Number.NaN;
    }
    for (let i = 0; i < 4; i += 1) {
      xty[i] = (xty[i] ?? 0) + (xr[i] ?? 0) * yr;
      const rowI = xtx[i];
      if (rowI === undefined) {
        return Number.NaN;
      }
      for (let j = 0; j < 4; j += 1) {
        rowI[j] = (rowI[j] ?? 0) + (xr[i] ?? 0) * (xr[j] ?? 0);
      }
    }
  }

  const lastIdx = rvs.length - 1;
  const xNext = [1, rvAt(lastIdx), rollingMean(lastIdx, 5), rollingMean(lastIdx, 22)];

  const beta = solveLinearSystem4x4(xtx, xty);
  let predDailyRv: number;
  if (beta !== null) {
    predDailyRv =
      (beta[0] ?? 0) * (xNext[0] ?? 1) +
      (beta[1] ?? 0) * (xNext[1] ?? 0) +
      (beta[2] ?? 0) * (xNext[2] ?? 0) +
      (beta[3] ?? 0) * (xNext[3] ?? 0);
  } else {
    // Si la serie de retornos al cuadrado es estrictamente idéntica (colinealidad pura), usar su varianza exacta
    const firstRv = rvAt(0);
    const allEqual = rvs.every((v) => Math.abs(v - firstRv) <= 1e-18);
    if (!allEqual || !isPositiveFinite(firstRv)) {
      return Number.NaN;
    }
    predDailyRv = firstRv;
  }

  if (!isPositiveFinite(predDailyRv)) {
    return Number.NaN;
  }
  return Math.sqrt(TRADING_DAYS_PER_YEAR * predDailyRv);
}

function interpolateSliceIvAtZ(slice: OpraMaturitySliceInput, targetZ: number): number {
  if (
    !isPositiveFinite(slice.timeToExpiryYears) ||
    !isPositiveFinite(slice.forwardUsd) ||
    !isPositiveFinite(slice.atmIvDecimal)
  ) {
    return Number.NaN;
  }
  const denom = slice.atmIvDecimal * Math.sqrt(slice.timeToExpiryYears);
  const byStrike = new Map<number, { z: number; iv: number }>();
  for (const q of slice.quotes) {
    if (!isPositiveFinite(q.strike) || !isPositiveFinite(q.ivDecimal)) {
      continue;
    }
    const z = Math.log(q.strike / slice.forwardUsd) / denom;
    const isOtm =
      (q.strike >= slice.forwardUsd && q.contractType === 'call') ||
      (q.strike < slice.forwardUsd && q.contractType === 'put');
    if (!byStrike.has(q.strike) || isOtm) {
      byStrike.set(q.strike, { z, iv: q.ivDecimal });
    }
  }
  const pts = Array.from(byStrike.values()).sort((a, b) => a.z - b.z);
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first === undefined || last === undefined || targetZ < first.z || targetZ > last.z) {
    return Number.NaN;
  }
  for (let i = 0; i < pts.length; i += 1) {
    const cur = pts[i];
    if (cur === undefined) {
      continue;
    }
    if (Math.abs(cur.z - targetZ) <= 1e-12) {
      return cur.iv;
    }
    if (i > 0) {
      const prev = pts[i - 1];
      if (prev !== undefined && targetZ <= cur.z) {
        const span = cur.z - prev.z;
        if (span <= 0) {
          return cur.iv;
        }
        const alpha = (targetZ - prev.z) / span;
        return prev.iv * (1 - alpha) + cur.iv * alpha;
      }
    }
  }
  return Number.NaN;
}

function interpolateOpraTotalVarIv(
  slices: readonly OpraMaturitySliceInput[],
  targetTimeYears: number,
  targetZ: number,
  singleSliceDayTolerance: number,
): number {
  const validSlices = slices
    .filter((s) => isPositiveFinite(s.timeToExpiryYears) && s.quotes.length >= 2)
    .slice()
    .sort((a, b) => a.timeToExpiryYears - b.timeToExpiryYears);
  if (validSlices.length === 0 || !isPositiveFinite(targetTimeYears)) {
    return Number.NaN;
  }

  for (const s of validSlices) {
    if (Math.abs(s.timeToExpiryYears - targetTimeYears) * DAYS_PER_YEAR <= singleSliceDayTolerance) {
      const directIv = interpolateSliceIvAtZ(s, targetZ);
      if (isPositiveFinite(directIv)) {
        return directIv;
      }
    }
  }

  for (let i = 1; i < validSlices.length; i += 1) {
    const left = validSlices[i - 1];
    const right = validSlices[i];
    if (left === undefined || right === undefined) {
      continue;
    }
    if (targetTimeYears >= left.timeToExpiryYears && targetTimeYears <= right.timeToExpiryYears) {
      const ivLeft = interpolateSliceIvAtZ(left, targetZ);
      const ivRight = interpolateSliceIvAtZ(right, targetZ);
      if (!isPositiveFinite(ivLeft) || !isPositiveFinite(ivRight)) {
        return Number.NaN;
      }
      const tvLeft = ivLeft * ivLeft * left.timeToExpiryYears;
      const tvRight = ivRight * ivRight * right.timeToExpiryYears;
      const span = right.timeToExpiryYears - left.timeToExpiryYears;
      const alpha = span > 0 ? (targetTimeYears - left.timeToExpiryYears) / span : 0;
      const tvTarget = tvLeft * (1 - alpha) + tvRight * alpha;
      return tvTarget > 0 ? Math.sqrt(tvTarget / targetTimeYears) : Number.NaN;
    }
  }
  return Number.NaN;
}

function interpolateIvAtTargetDelta(
  points: readonly { readonly delta: number; readonly iv: number }[],
  targetDelta: number,
): number {
  const clean = points
    .filter((p) => Number.isFinite(p.delta) && isPositiveFinite(p.iv))
    .slice()
    .sort((a, b) => a.delta - b.delta);
  const first = clean[0];
  const last = clean[clean.length - 1];
  if (first === undefined || last === undefined || targetDelta < first.delta || targetDelta > last.delta) {
    return Number.NaN;
  }
  for (let i = 1; i < clean.length; i += 1) {
    const prev = clean[i - 1];
    const cur = clean[i];
    if (prev === undefined || cur === undefined) {
      continue;
    }
    if (targetDelta <= cur.delta) {
      const span = cur.delta - prev.delta;
      if (span <= 0) {
        return cur.iv;
      }
      const alpha = (targetDelta - prev.delta) / span;
      return prev.iv * (1 - alpha) + cur.iv * alpha;
    }
  }
  return first.delta === targetDelta ? first.iv : Number.NaN;
}

/**
 * Evaluador principal del Motor 2: BS02 T+0/24hs, Modos A y B de triángulo IV, moneyness z y Call Overwriting.
 */
export function evaluateCrossCurrencyVolTriangle(
  input: CrossCurrencyVolInput,
): CrossCurrencyVolOutput {
  if (!isValidUtcSec(input.asOfUtcSec)) {
    throw new Error(`asOfUtcSec must be valid integer UTC seconds (got ${String(input.asOfUtcSec)})`);
  }

  const evalParams = computeBymaOptionEvalParams(input.bymaEval);
  const emptyResult: CrossCurrencyVolOutput = {
    timestampUtc: formatIsoUtcFromSec(input.asOfUtcSec),
    asOfUtcSec: input.asOfUtcSec,
    maturityBucketDays: evalParams?.maturityDays ?? Number.NaN,
    bymaAtmIvPct: Number.NaN,
    opraAdrAtmIvPct: Number.NaN,
    realizedCorrEwma: Number.NaN,
    harRvCclPct: Number.NaN,
    impliedCclVolPct: null,
    impliedCorrelation: null,
    boundaryRegime: 'VIOLATION_BYMA_COMPRESSED',
    skewMetrics: {
      byma25dPutMinusCallPct: Number.NaN,
      opra25dPutMinusCallPct: Number.NaN,
      overwritingCompressionScore: Number.NaN,
    },
    arbViolationsCount: 0,
    anomalies: [],
  };

  if (evalParams === null || input.bymaOptions.length === 0) {
    return { ...emptyResult, boundaryRegime: 'NO_DATA' };
  }

  let arbViolationsCount = 0;
  const bymaSolvedByStrike = new Map<
    number,
    {
      readonly strike: number;
      call?: BymaOptionIvResult;
      put?: BymaOptionIvResult;
      otmIv: number;
      otmArbFlag: BymaOptionArbFlag;
    }
  >();

  const bymaCallDeltaPts: { delta: number; iv: number }[] = [];
  const bymaPutDeltaPts: { delta: number; iv: number }[] = [];

  for (const opt of input.bymaOptions) {
    const solved = solveBymaAmericanIvHybrid(evalParams, opt.strike, opt.contractType, opt.quote);
    if (solved.arbFlag === 'ARB_INTRINSIC_VIOLATION') {
      arbViolationsCount += 1;
    }
    if (solved.greeks !== null && isPositiveFinite(solved.iv)) {
      if (opt.contractType === 'call') {
        bymaCallDeltaPts.push({ delta: solved.greeks.delta, iv: solved.iv });
      } else {
        bymaPutDeltaPts.push({ delta: solved.greeks.delta, iv: solved.iv });
      }
    }

    let bucket = bymaSolvedByStrike.get(opt.strike);
    if (bucket === undefined) {
      bucket = {
        strike: opt.strike,
        otmIv: Number.NaN,
        otmArbFlag: 'INVALID_INPUT',
      };
      bymaSolvedByStrike.set(opt.strike, bucket);
    }
    if (opt.contractType === 'call') {
      bucket.call = solved;
    } else {
      bucket.put = solved;
    }
  }

  const bymaMidSmile: { strike: number; iv: number; arbFlag: BymaOptionArbFlag }[] = [];
  for (const entry of bymaSolvedByStrike.values()) {
    const isOtmCall = entry.strike >= evalParams.forwardArs;
    const primary = isOtmCall ? entry.call : entry.put;
    const fallback = isOtmCall ? entry.put : entry.call;
    const chosen =
      primary !== undefined && isPositiveFinite(primary.iv)
        ? primary
        : fallback !== undefined && isPositiveFinite(fallback.iv)
          ? fallback
          : primary ?? fallback;
    if (chosen !== undefined && isPositiveFinite(chosen.iv)) {
      bymaMidSmile.push({ strike: entry.strike, iv: chosen.iv, arbFlag: chosen.arbFlag });
    }
  }
  bymaMidSmile.sort((a, b) => a.strike - b.strike);

  // Obtener IV ATM BYMA por interpolación lineal en strike alrededor de F_BYMA(T)
  let bymaAtmIv = Number.NaN;
  const firstByma = bymaMidSmile[0];
  const lastByma = bymaMidSmile[bymaMidSmile.length - 1];
  if (
    firstByma !== undefined &&
    lastByma !== undefined &&
    evalParams.forwardArs >= firstByma.strike &&
    evalParams.forwardArs <= lastByma.strike
  ) {
    for (let i = 0; i < bymaMidSmile.length; i += 1) {
      const cur = bymaMidSmile[i];
      if (cur === undefined) {
        continue;
      }
      if (Math.abs(cur.strike - evalParams.forwardArs) <= 1e-12) {
        bymaAtmIv = cur.iv;
        break;
      }
      if (i > 0) {
        const prev = bymaMidSmile[i - 1];
        if (prev !== undefined && evalParams.forwardArs <= cur.strike) {
          const alpha = (evalParams.forwardArs - prev.strike) / (cur.strike - prev.strike);
          bymaAtmIv = prev.iv * (1 - alpha) + cur.iv * alpha;
          break;
        }
      }
    }
  }

  const singleSliceTolDays = input.singleOpraSliceDayTolerance ?? 1.5;
  const opraAdrAtmIv = interpolateOpraTotalVarIv(
    input.opraSlices,
    evalParams.tExpYears,
    0,
    singleSliceTolDays,
  );

  const realizedCorrEwma =
    input.realizedCorrEwmaOverride ??
    computeEwmaCorrelation(
      input.returnHistory ?? [],
      input.asOfUtcSec,
      input.ewmaLambda ?? 0.94,
      input.minCorrObs ?? 15,
    );

  const harRvCclAnnual =
    input.harRvCclAnnualOverride ??
    computeHarRvForecast(input.cclReturnHistory ?? [], input.asOfUtcSec, input.minHarObs ?? 40);

  let boundaryRegime: VolTriangleRegime = 'VIOLATION_BYMA_COMPRESSED';
  let impliedCclVolPct: number | null = null;
  let impliedCorrelation: number | null = null;

  if (
    !isPositiveFinite(bymaAtmIv) ||
    !isPositiveFinite(opraAdrAtmIv) ||
    !Number.isFinite(realizedCorrEwma)
  ) {
    boundaryRegime = 'NO_DATA';
  } else {
    // Modo A: sigma_CCL^2 + (2*rho*sigma_ADR)*sigma_CCL + (sigma_ADR^2 - sigma_BYMA^2) = 0
    const deltaVar =
      bymaAtmIv * bymaAtmIv - (1 - realizedCorrEwma * realizedCorrEwma) * opraAdrAtmIv * opraAdrAtmIv;
    if (deltaVar < 0) {
      boundaryRegime = 'VIOLATION_BYMA_COMPRESSED';
      impliedCclVolPct = null;
    } else {
      const sqrtDisc = Math.sqrt(deltaVar);
      const sigmaPlus = -realizedCorrEwma * opraAdrAtmIv + sqrtDisc;
      const sigmaMinus = -realizedCorrEwma * opraAdrAtmIv - sqrtDisc;

      if (sigmaPlus <= 0) {
        boundaryRegime = 'VIOLATION_BYMA_COMPRESSED';
        impliedCclVolPct = null;
      } else if (bymaAtmIv > opraAdrAtmIv) {
        boundaryRegime = 'NORMAL_UNIQUE_ROOT';
        impliedCclVolPct = sigmaPlus * 100;
      } else if (realizedCorrEwma < 0 && sigmaMinus >= 0) {
        boundaryRegime = 'DUAL_ROOT_NEG_CORR';
        if (isPositiveFinite(harRvCclAnnual)) {
          const distPlus = Math.abs(sigmaPlus - harRvCclAnnual);
          const distMinus = Math.abs(sigmaMinus - harRvCclAnnual);
          impliedCclVolPct = (distMinus < distPlus ? sigmaMinus : sigmaPlus) * 100;
        } else {
          impliedCclVolPct = null;
        }
      } else {
        boundaryRegime = 'VIOLATION_BYMA_COMPRESSED';
        impliedCclVolPct = null;
      }
    }

    // Modo B: rho_impl = (sigma_BYMA^2 - sigma_ADR^2 - sigma_CCL_HAR^2) / (2 * sigma_ADR * sigma_CCL_HAR)
    if (isPositiveFinite(harRvCclAnnual)) {
      const denom = 2 * opraAdrAtmIv * harRvCclAnnual;
      if (isPositiveFinite(denom)) {
        impliedCorrelation =
          (bymaAtmIv * bymaAtmIv - opraAdrAtmIv * opraAdrAtmIv - harRvCclAnnual * harRvCclAnnual) /
          denom;
      }
    }
  }

  const relValThreshold = input.relValThresholdVolPts ?? DEFAULT_RELVAL_THRESHOLD_VOL_PTS;
  const rightWingMinZ = input.rightWingMinZ ?? 0.5;
  const anomalies: VolTriangleAnomalyItem[] = [];
  const rightWingCompressions: number[] = [];

  if (
    isPositiveFinite(bymaAtmIv) &&
    Number.isFinite(realizedCorrEwma) &&
    isPositiveFinite(harRvCclAnnual)
  ) {
    const zScale = bymaAtmIv * Math.sqrt(evalParams.tExpYears);
    for (const node of bymaMidSmile) {
      const z = Math.log(node.strike / evalParams.forwardArs) / zScale;
      const opraIvAtZ = interpolateOpraTotalVarIv(
        input.opraSlices,
        evalParams.tExpYears,
        z,
        singleSliceTolDays,
      );
      let teorByma = Number.NaN;
      if (isPositiveFinite(opraIvAtZ)) {
        const varTheor =
          opraIvAtZ * opraIvAtZ +
          harRvCclAnnual * harRvCclAnnual +
          2 * realizedCorrEwma * opraIvAtZ * harRvCclAnnual;
        if (varTheor > 0) {
          teorByma = Math.sqrt(varTheor);
        }
      }
      const bymaPct = node.iv * 100;
      const teorPct = Number.isFinite(teorByma) ? teorByma * 100 : Number.NaN;
      const relValPct = Number.isFinite(teorPct) ? bymaPct - teorPct : Number.NaN;
      let sideBias: VolAnomalyBias = 'FAIR';
      if (Number.isFinite(relValPct)) {
        if (relValPct <= -relValThreshold) {
          sideBias = 'CHEAP_BYMA';
        } else if (relValPct >= relValThreshold) {
          sideBias = 'RICH_BYMA';
        }
        if (z > rightWingMinZ) {
          rightWingCompressions.push(Math.max(0, -relValPct));
        }
      }
      anomalies.push({
        standardizedMoneynessZ: z,
        strikeBymaArs: node.strike,
        bymaMidIvPct: bymaPct,
        theoreticalBymaIvPct: teorPct,
        relValVolSpreadPct: relValPct,
        sideBias,
        arbFlag: node.arbFlag,
      });
    }
  }

  const bymaPut25 = interpolateIvAtTargetDelta(bymaPutDeltaPts, -0.25);
  const bymaCall25 = interpolateIvAtTargetDelta(bymaCallDeltaPts, 0.25);
  const byma25dPutMinusCallPct =
    isPositiveFinite(bymaPut25) && isPositiveFinite(bymaCall25)
      ? (bymaPut25 - bymaCall25) * 100
      : Number.NaN;

  // OPRA 25-delta skew en la slice más cercana a T_exp
  let opra25dPutMinusCallPct = Number.NaN;
  const sortedOpra = input.opraSlices
    .filter((s) => isPositiveFinite(s.timeToExpiryYears))
    .slice()
    .sort(
      (a, b) =>
        Math.abs(a.timeToExpiryYears - evalParams.tExpYears) -
        Math.abs(b.timeToExpiryYears - evalParams.tExpYears),
    );
  const nearestOpra = sortedOpra[0];
  if (nearestOpra !== undefined) {
    const opraCalls: { delta: number; iv: number }[] = [];
    const opraPuts: { delta: number; iv: number }[] = [];
    for (const q of nearestOpra.quotes) {
      if (q.delta !== undefined && Number.isFinite(q.delta) && isPositiveFinite(q.ivDecimal)) {
        if (q.contractType === 'call') {
          opraCalls.push({ delta: q.delta, iv: q.ivDecimal });
        } else {
          opraPuts.push({ delta: q.delta, iv: q.ivDecimal });
        }
      }
    }
    const opraPut25 = interpolateIvAtTargetDelta(opraPuts, -0.25);
    const opraCall25 = interpolateIvAtTargetDelta(opraCalls, 0.25);
    if (isPositiveFinite(opraPut25) && isPositiveFinite(opraCall25)) {
      opra25dPutMinusCallPct = (opraPut25 - opraCall25) * 100;
    }
  }

  const overwritingCompressionScore =
    rightWingCompressions.length > 0
      ? rightWingCompressions.reduce((acc, v) => acc + v, 0) / rightWingCompressions.length
      : Number.NaN;

  return {
    timestampUtc: formatIsoUtcFromSec(input.asOfUtcSec),
    asOfUtcSec: input.asOfUtcSec,
    maturityBucketDays: evalParams.maturityDays,
    bymaAtmIvPct: isPositiveFinite(bymaAtmIv) ? bymaAtmIv * 100 : Number.NaN,
    opraAdrAtmIvPct: isPositiveFinite(opraAdrAtmIv) ? opraAdrAtmIv * 100 : Number.NaN,
    realizedCorrEwma,
    harRvCclPct: isPositiveFinite(harRvCclAnnual) ? harRvCclAnnual * 100 : Number.NaN,
    impliedCclVolPct,
    impliedCorrelation,
    boundaryRegime,
    skewMetrics: {
      byma25dPutMinusCallPct,
      opra25dPutMinusCallPct,
      overwritingCompressionScore,
    },
    arbViolationsCount,
    anomalies,
  };
}
