/**
 * Motor puro de Tasas Implícitas del Sintético, Costo de Short Borrow (HTB),
 * Arbitraje de Conversión/Reversión, Lanzamiento Cubierto (Buy-Write) y
 * Roleo de Plazos (Calendar Rolls) con fricciones configurables y 21 % IVA
 * (Pieza 17 — Bloque III Parte 1, Motor 9).
 *
 * Funciones 100 % puras: cero red, cero E/S, cero UI y cero mutación de argumentos.
 */

const DEFAULT_NEAR_ATM_COUNT = 5;
const DEFAULT_MODERATE_BORROW_THRESHOLD = 0.02;
const DEFAULT_HARD_TO_BORROW_THRESHOLD = 0.05;
const DEFAULT_STOCK_FEE_RATE = 0.0005;
const DEFAULT_OPTION_FEE_RATE = 0.0020;
const DEFAULT_VAT_RATE = 0.21;
const DEFAULT_SHORT_BORROW_RATE_TNA = 0.02;
const BPS_PER_UNIT = 10_000;
export const MIN_SYNTHETIC_RATE_DTE = 3;
export const MIN_SYNTHETIC_RATE_T = MIN_SYNTHETIC_RATE_DTE / 365;
const SHORT_DTE_EPS = 1e-12;

export type SyntheticEngineStatus = 'OK' | 'NO_DATA';
export type ImpliedRateStatus = 'OK' | 'BLOCKED_SHORT_DTE' | 'NO_DATA';

export type BorrowRegime =
  | 'EASY_TO_BORROW'
  | 'MODERATE_SHORT_DEMAND'
  | 'HARD_TO_BORROW_SQUEEZE_ALERT'
  | 'NO_DATA';

export interface SyntheticStrikePairInput {
  readonly strike: number;
  readonly callMid: number;
  readonly putMid: number;
}

export interface SyntheticImpliedRatesInput {
  readonly spot: number;
  readonly riskFreeRate: number;
  readonly dividendYield: number;
  readonly timeToExpiry: number;
  readonly dte?: number;
  readonly pairs: readonly SyntheticStrikePairInput[];
  readonly nearAtmCount?: number;
  readonly moderateBorrowThreshold?: number;
  readonly hardToBorrowThreshold?: number;
}

export interface SyntheticStrikeRateNode {
  readonly strike: number;
  readonly callMid: number;
  readonly putMid: number;
  readonly syntheticForward: number;
  readonly impliedRateContinuous: number;
  readonly impliedTna: number;
  readonly absLogMoneyness: number;
}

export interface SyntheticImpliedRatesResult {
  readonly status: SyntheticEngineStatus;
  readonly impliedRateStatus: ImpliedRateStatus;
  readonly medianImpliedRate: number;
  readonly medianImpliedTna: number;
  readonly impliedBorrowRate: number;
  readonly impliedBorrowRateNullable: number | null;
  readonly htbAlert: boolean;
  readonly borrowRegime: BorrowRegime;
  readonly strikes: readonly SyntheticStrikeRateNode[];
}

export type ConversionReversalSignal =
  | 'EXECUTABLE_CONVERSION'
  | 'EXECUTABLE_REVERSAL'
  | 'NO_ARBITRAGE_WITHIN_BOUNDS'
  | 'NO_DATA';

export interface ConversionReversalInput {
  readonly strike: number;
  readonly timeToExpiry: number;
  readonly riskFreeTna: number;
  readonly spotBid: number;
  readonly spotAsk: number;
  readonly callBid: number;
  readonly callAsk: number;
  readonly putBid: number;
  readonly putAsk: number;
  readonly dividendPresentValue?: number;
  readonly stockFeeRate?: number;
  readonly optionFeeRate?: number;
  readonly vatRate?: number;
  readonly shortBorrowRateTna?: number;
}

export interface ConversionReversalResult {
  readonly status: SyntheticEngineStatus;
  readonly conversionNetCost: number;
  readonly conversionAnnualizedTna: number;
  readonly conversionEdgeVsRiskFreeBps: number;
  readonly reversalNetProceeds: number;
  readonly shortBorrowCost: number;
  readonly reversalTerminalObligation: number;
  readonly reversalAnnualizedTna: number;
  readonly reversalEdgeVsRiskFreeBps: number;
  readonly netEdgeVsRiskFreeBps: number;
  readonly arbitrageSignal: ConversionReversalSignal;
}

export interface BuyWriteInput {
  readonly spotAsk: number;
  readonly strike: number;
  readonly callBid: number;
  readonly timeToExpiry: number;
  readonly dividendCash?: number;
  readonly stockFeeRate?: number;
  readonly optionFeeRate?: number;
  readonly vatRate?: number;
}

export interface BuyWriteResult {
  readonly status: SyntheticEngineStatus;
  readonly totalFeesPerShare: number;
  readonly netCostBasis: number;
  readonly breakevenPrice: number;
  readonly downsideProtectionPct: number;
  readonly staticProfitPerShare: number;
  readonly staticReturnPct: number;
  readonly staticAnnualizedTna: number;
  readonly maxAssignedProfitPerShare: number;
  readonly maxAssignedReturnPct: number;
  readonly assignedAnnualizedTna: number;
}

export interface CalendarRollInput {
  readonly spot: number;
  readonly strike: number;
  readonly nearAsk: number;
  readonly farBid: number;
  readonly nearTimeToExpiry: number;
  readonly farTimeToExpiry: number;
  readonly nearThetaDaily: number;
  readonly farThetaDaily: number;
  readonly nearVegaPer1Pct: number;
  readonly farVegaPer1Pct: number;
  readonly optionFeeRate?: number;
  readonly vatRate?: number;
}

export interface CalendarRollResult {
  readonly status: SyntheticEngineStatus;
  readonly rollDurationYears: number;
  readonly grossRollCredit: number;
  readonly rollFeesPerShare: number;
  readonly netRollCredit: number;
  readonly annualizedRollYield: number;
  readonly annualizedRollYieldOnSpot: number;
  readonly netThetaDiff: number;
  readonly netVegaDiff: number;
}

const NO_DATA_SYNTH_RATES: SyntheticImpliedRatesResult = Object.freeze({
  status: 'NO_DATA',
  impliedRateStatus: 'NO_DATA',
  medianImpliedRate: Number.NaN,
  medianImpliedTna: Number.NaN,
  impliedBorrowRate: Number.NaN,
  impliedBorrowRateNullable: null,
  htbAlert: false,
  borrowRegime: 'NO_DATA',
  strikes: [],
});

const NO_DATA_CONV_REV: ConversionReversalResult = Object.freeze({
  status: 'NO_DATA',
  conversionNetCost: Number.NaN,
  conversionAnnualizedTna: Number.NaN,
  conversionEdgeVsRiskFreeBps: Number.NaN,
  reversalNetProceeds: Number.NaN,
  shortBorrowCost: Number.NaN,
  reversalTerminalObligation: Number.NaN,
  reversalAnnualizedTna: Number.NaN,
  reversalEdgeVsRiskFreeBps: Number.NaN,
  netEdgeVsRiskFreeBps: Number.NaN,
  arbitrageSignal: 'NO_DATA',
});

const NO_DATA_BUY_WRITE: BuyWriteResult = Object.freeze({
  status: 'NO_DATA',
  totalFeesPerShare: Number.NaN,
  netCostBasis: Number.NaN,
  breakevenPrice: Number.NaN,
  downsideProtectionPct: Number.NaN,
  staticProfitPerShare: Number.NaN,
  staticReturnPct: Number.NaN,
  staticAnnualizedTna: Number.NaN,
  maxAssignedProfitPerShare: Number.NaN,
  maxAssignedReturnPct: Number.NaN,
  assignedAnnualizedTna: Number.NaN,
});

const NO_DATA_CALENDAR_ROLL: CalendarRollResult = Object.freeze({
  status: 'NO_DATA',
  rollDurationYears: Number.NaN,
  grossRollCredit: Number.NaN,
  rollFeesPerShare: Number.NaN,
  netRollCredit: Number.NaN,
  annualizedRollYield: Number.NaN,
  annualizedRollYieldOnSpot: Number.NaN,
  netThetaDiff: Number.NaN,
  netVegaDiff: Number.NaN,
});

function isRuntimeArray(value: unknown): boolean {
  return Array.isArray(value);
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function computeMedianSorted(sortedValues: readonly number[]): number {
  const n = sortedValues.length;
  if (n === 0) {
    return Number.NaN;
  }
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) {
    return sortedValues[mid] ?? Number.NaN;
  }
  const left = sortedValues[mid - 1];
  const right = sortedValues[mid];
  if (left === undefined || right === undefined) {
    return Number.NaN;
  }
  return 0.5 * (left + right);
}

/**
 * Despeja la tasa implícita continua (`r_impl`) y TNA del sintético strike a strike
 * a partir de paridad Call-Put media y clasifica el régimen de Short Borrow / HTB.
 */
export function computeSyntheticImpliedRates(
  input: SyntheticImpliedRatesInput,
): SyntheticImpliedRatesResult {
  const { spot, riskFreeRate, dividendYield, timeToExpiry, pairs } = input;
  const nearAtmCount = input.nearAtmCount ?? DEFAULT_NEAR_ATM_COUNT;
  const moderateBorrowThreshold =
    input.moderateBorrowThreshold ?? DEFAULT_MODERATE_BORROW_THRESHOLD;
  const hardToBorrowThreshold =
    input.hardToBorrowThreshold ?? DEFAULT_HARD_TO_BORROW_THRESHOLD;

  if (
    !isPositiveFinite(spot) ||
    !Number.isFinite(riskFreeRate) ||
    !Number.isFinite(dividendYield) ||
    !isPositiveFinite(timeToExpiry) ||
    !isRuntimeArray(pairs) ||
    !Number.isInteger(nearAtmCount) ||
    nearAtmCount < 1 ||
    !isNonNegativeFinite(moderateBorrowThreshold) ||
    !isNonNegativeFinite(hardToBorrowThreshold) ||
    hardToBorrowThreshold < moderateBorrowThreshold
  ) {
    return NO_DATA_SYNTH_RATES;
  }

  const discSpot = spot * Math.exp(-dividendYield * timeToExpiry);
  if (!isPositiveFinite(discSpot)) {
    return NO_DATA_SYNTH_RATES;
  }

  const isShortDteBlocked =
    (input.dte !== undefined && Number.isFinite(input.dte) && input.dte < MIN_SYNTHETIC_RATE_DTE) ||
    timeToExpiry < MIN_SYNTHETIC_RATE_T - SHORT_DTE_EPS;

  const nodes: SyntheticStrikeRateNode[] = [];
  for (const pair of pairs) {
    if (
      !isPositiveFinite(pair.strike) ||
      !isPositiveFinite(pair.callMid) ||
      !isPositiveFinite(pair.putMid)
    ) {
      continue;
    }
    const discStrike = discSpot - (pair.callMid - pair.putMid);
    if (!isPositiveFinite(discStrike)) {
      continue;
    }
    const absLogMoneyness = Math.abs(Math.log(pair.strike / spot));
    if (!Number.isFinite(absLogMoneyness)) {
      continue;
    }

    if (isShortDteBlocked) {
      const syntheticForward = (pair.strike * pair.strike) / discStrike;
      if (!Number.isFinite(syntheticForward)) {
        continue;
      }
      nodes.push({
        strike: pair.strike,
        callMid: pair.callMid,
        putMid: pair.putMid,
        syntheticForward,
        impliedRateContinuous: Number.NaN,
        impliedTna: Number.NaN,
        absLogMoneyness,
      });
      continue;
    }

    const impliedRateContinuous = -Math.log(discStrike / pair.strike) / timeToExpiry;
    const syntheticForward = pair.strike * Math.exp(impliedRateContinuous * timeToExpiry);
    const impliedTna = Math.expm1(impliedRateContinuous * timeToExpiry) / timeToExpiry;
    if (
      !Number.isFinite(impliedRateContinuous) ||
      !Number.isFinite(syntheticForward) ||
      !Number.isFinite(impliedTna)
    ) {
      continue;
    }
    nodes.push({
      strike: pair.strike,
      callMid: pair.callMid,
      putMid: pair.putMid,
      syntheticForward,
      impliedRateContinuous,
      impliedTna,
      absLogMoneyness,
    });
  }

  if (nodes.length === 0) {
    return NO_DATA_SYNTH_RATES;
  }

  const sortedByStrike = nodes.slice().sort((a, b) => a.strike - b.strike);

  if (isShortDteBlocked) {
    return {
      status: 'OK',
      impliedRateStatus: 'BLOCKED_SHORT_DTE',
      medianImpliedRate: Number.NaN,
      medianImpliedTna: Number.NaN,
      impliedBorrowRate: Number.NaN,
      impliedBorrowRateNullable: null,
      htbAlert: false,
      borrowRegime: 'NO_DATA',
      strikes: sortedByStrike,
    };
  }

  const nearAtmRates = sortedByStrike
    .slice()
    .sort((a, b) =>
      a.absLogMoneyness !== b.absLogMoneyness
        ? a.absLogMoneyness - b.absLogMoneyness
        : a.strike - b.strike,
    )
    .slice(0, nearAtmCount)
    .map((n) => n.impliedRateContinuous)
    .sort((a, b) => a - b);

  const medianImpliedRate = computeMedianSorted(nearAtmRates);
  if (!Number.isFinite(medianImpliedRate)) {
    return NO_DATA_SYNTH_RATES;
  }
  const medianImpliedTna = Math.expm1(medianImpliedRate * timeToExpiry) / timeToExpiry;
  const impliedBorrowRate = riskFreeRate - medianImpliedRate;

  let borrowRegime: BorrowRegime;
  if (impliedBorrowRate >= hardToBorrowThreshold) {
    borrowRegime = 'HARD_TO_BORROW_SQUEEZE_ALERT';
  } else if (impliedBorrowRate >= moderateBorrowThreshold) {
    borrowRegime = 'MODERATE_SHORT_DEMAND';
  } else {
    borrowRegime = 'EASY_TO_BORROW';
  }

  return {
    status: 'OK',
    impliedRateStatus: 'OK',
    medianImpliedRate,
    medianImpliedTna,
    impliedBorrowRate,
    impliedBorrowRateNullable: Number.isFinite(impliedBorrowRate) ? impliedBorrowRate : null,
    htbAlert: borrowRegime === 'HARD_TO_BORROW_SQUEEZE_ALERT',
    borrowRegime,
    strikes: sortedByStrike,
  };
}

/**
 * Evalúa la rentabilidad anualizada ejecutable de Conversión y Reversión sobre puntas reales
 * (Bid/Ask) descontando derechos, comisiones con IVA y costo de préstamo en corto.
 */
export function evaluateConversionReversal(
  input: ConversionReversalInput,
): ConversionReversalResult {
  const {
    strike,
    timeToExpiry,
    riskFreeTna,
    spotBid,
    spotAsk,
    callBid,
    callAsk,
    putBid,
    putAsk,
  } = input;

  const dividendPresentValue = input.dividendPresentValue ?? 0;
  const stockFeeRate = input.stockFeeRate ?? DEFAULT_STOCK_FEE_RATE;
  const optionFeeRate = input.optionFeeRate ?? DEFAULT_OPTION_FEE_RATE;
  const vatRate = input.vatRate ?? DEFAULT_VAT_RATE;
  const shortBorrowRateTna = input.shortBorrowRateTna ?? DEFAULT_SHORT_BORROW_RATE_TNA;

  if (
    !isPositiveFinite(strike) ||
    !isPositiveFinite(timeToExpiry) ||
    !Number.isFinite(riskFreeTna) ||
    !isPositiveFinite(spotBid) ||
    !isPositiveFinite(spotAsk) ||
    spotAsk < spotBid ||
    !isPositiveFinite(callBid) ||
    !isPositiveFinite(callAsk) ||
    callAsk < callBid ||
    !isPositiveFinite(putBid) ||
    !isPositiveFinite(putAsk) ||
    putAsk < putBid ||
    !isNonNegativeFinite(dividendPresentValue) ||
    !isNonNegativeFinite(stockFeeRate) ||
    !isNonNegativeFinite(optionFeeRate) ||
    !isNonNegativeFinite(vatRate) ||
    !isNonNegativeFinite(shortBorrowRateTna)
  ) {
    return NO_DATA_CONV_REV;
  }

  const fStock = stockFeeRate * (1 + vatRate);
  const fOpt = optionFeeRate * (1 + vatRate);

  const conversionNetCost =
    spotAsk * (1 + fStock) +
    putAsk * (1 + fOpt) -
    callBid * (1 - fOpt) -
    dividendPresentValue;

  const reversalNetProceeds =
    spotBid * (1 - fStock) +
    putBid * (1 - fOpt) -
    callAsk * (1 + fOpt) -
    dividendPresentValue;

  if (!isPositiveFinite(conversionNetCost) || !isPositiveFinite(reversalNetProceeds)) {
    return NO_DATA_CONV_REV;
  }

  const conversionAnnualizedTna =
    ((strike - conversionNetCost) / conversionNetCost) / timeToExpiry;
  const conversionEdgeVsRiskFreeBps =
    (conversionAnnualizedTna - riskFreeTna) * BPS_PER_UNIT;

  const shortBorrowCost = spotBid * shortBorrowRateTna * timeToExpiry;
  const reversalTerminalObligation = strike + shortBorrowCost;
  const reversalAnnualizedTna =
    ((reversalTerminalObligation - reversalNetProceeds) / reversalNetProceeds) /
    timeToExpiry;
  const reversalEdgeVsRiskFreeBps =
    (riskFreeTna - reversalAnnualizedTna) * BPS_PER_UNIT;

  const netEdgeVsRiskFreeBps = Math.max(
    conversionEdgeVsRiskFreeBps,
    reversalEdgeVsRiskFreeBps,
  );

  let arbitrageSignal: ConversionReversalSignal;
  if (
    conversionEdgeVsRiskFreeBps > 0 &&
    conversionEdgeVsRiskFreeBps >= reversalEdgeVsRiskFreeBps
  ) {
    arbitrageSignal = 'EXECUTABLE_CONVERSION';
  } else if (reversalEdgeVsRiskFreeBps > 0) {
    arbitrageSignal = 'EXECUTABLE_REVERSAL';
  } else {
    arbitrageSignal = 'NO_ARBITRAGE_WITHIN_BOUNDS';
  }

  return {
    status: 'OK',
    conversionNetCost,
    conversionAnnualizedTna,
    conversionEdgeVsRiskFreeBps,
    reversalNetProceeds,
    shortBorrowCost,
    reversalTerminalObligation,
    reversalAnnualizedTna,
    reversalEdgeVsRiskFreeBps,
    netEdgeVsRiskFreeBps,
    arbitrageSignal,
  };
}

/**
 * Evalúa un lanzamiento cubierto (Buy-Write) ejecutable al Ask del subyacente y Bid del Call,
 * descontando comisiones con IVA e incorporando dividendos esperados hasta vencimiento.
 */
export function evaluateBuyWrite(input: BuyWriteInput): BuyWriteResult {
  const { spotAsk, strike, callBid, timeToExpiry } = input;
  const dividendCash = input.dividendCash ?? 0;
  const stockFeeRate = input.stockFeeRate ?? DEFAULT_STOCK_FEE_RATE;
  const optionFeeRate = input.optionFeeRate ?? DEFAULT_OPTION_FEE_RATE;
  const vatRate = input.vatRate ?? DEFAULT_VAT_RATE;

  if (
    !isPositiveFinite(spotAsk) ||
    !isPositiveFinite(strike) ||
    !isPositiveFinite(callBid) ||
    !isPositiveFinite(timeToExpiry) ||
    !isNonNegativeFinite(dividendCash) ||
    !isNonNegativeFinite(stockFeeRate) ||
    !isNonNegativeFinite(optionFeeRate) ||
    !isNonNegativeFinite(vatRate)
  ) {
    return NO_DATA_BUY_WRITE;
  }

  const fStock = stockFeeRate * (1 + vatRate);
  const fOpt = optionFeeRate * (1 + vatRate);

  const totalFeesPerShare = spotAsk * fStock + callBid * fOpt;
  const netCostBasis = spotAsk * (1 + fStock) - callBid * (1 - fOpt);
  if (!isPositiveFinite(netCostBasis)) {
    return NO_DATA_BUY_WRITE;
  }

  const breakevenPrice = netCostBasis - dividendCash;
  const downsideProtectionPct = ((spotAsk - breakevenPrice) / spotAsk) * 100;

  const staticProfitPerShare = Math.min(spotAsk, strike) + dividendCash - netCostBasis;
  const staticReturnPct = (staticProfitPerShare / netCostBasis) * 100;
  const staticAnnualizedTna = staticReturnPct / timeToExpiry;

  const maxAssignedProfitPerShare = strike + dividendCash - netCostBasis;
  const maxAssignedReturnPct = (maxAssignedProfitPerShare / netCostBasis) * 100;
  const assignedAnnualizedTna = maxAssignedReturnPct / timeToExpiry;

  return {
    status: 'OK',
    totalFeesPerShare,
    netCostBasis,
    breakevenPrice,
    downsideProtectionPct,
    staticProfitPerShare,
    staticReturnPct,
    staticAnnualizedTna,
    maxAssignedProfitPerShare,
    maxAssignedReturnPct,
    assignedAnnualizedTna,
  };
}

/**
 * Evalúa el roleo horizontal de un contrato corto frontal al próximo vencimiento (`farBid - nearAsk`)
 * reportando crédito neto tras comisiones/IVA, tasa anualizada del roll y diferenciales de Theta/Vega.
 */
export function evaluateCalendarRoll(input: CalendarRollInput): CalendarRollResult {
  const {
    spot,
    strike,
    nearAsk,
    farBid,
    nearTimeToExpiry,
    farTimeToExpiry,
    nearThetaDaily,
    farThetaDaily,
    nearVegaPer1Pct,
    farVegaPer1Pct,
  } = input;

  const optionFeeRate = input.optionFeeRate ?? DEFAULT_OPTION_FEE_RATE;
  const vatRate = input.vatRate ?? DEFAULT_VAT_RATE;

  if (
    !isPositiveFinite(spot) ||
    !isPositiveFinite(strike) ||
    !isPositiveFinite(nearAsk) ||
    !isPositiveFinite(farBid) ||
    !isPositiveFinite(nearTimeToExpiry) ||
    !isPositiveFinite(farTimeToExpiry) ||
    farTimeToExpiry <= nearTimeToExpiry ||
    !Number.isFinite(nearThetaDaily) ||
    !Number.isFinite(farThetaDaily) ||
    !Number.isFinite(nearVegaPer1Pct) ||
    !Number.isFinite(farVegaPer1Pct) ||
    !isNonNegativeFinite(optionFeeRate) ||
    !isNonNegativeFinite(vatRate)
  ) {
    return NO_DATA_CALENDAR_ROLL;
  }

  const fOpt = optionFeeRate * (1 + vatRate);
  const rollDurationYears = farTimeToExpiry - nearTimeToExpiry;
  const grossRollCredit = farBid - nearAsk;
  const rollFeesPerShare = (farBid + nearAsk) * fOpt;
  const netRollCredit = farBid * (1 - fOpt) - nearAsk * (1 + fOpt);

  const annualizedRollYield = (netRollCredit / (strike * rollDurationYears)) * 100;
  const annualizedRollYieldOnSpot = (netRollCredit / (spot * rollDurationYears)) * 100;
  const netThetaDiff = farThetaDaily - nearThetaDaily;
  const netVegaDiff = farVegaPer1Pct - nearVegaPer1Pct;

  return {
    status: 'OK',
    rollDurationYears,
    grossRollCredit,
    rollFeesPerShare,
    netRollCredit,
    annualizedRollYield,
    annualizedRollYieldOnSpot,
    netThetaDiff,
    netVegaDiff,
  };
}
