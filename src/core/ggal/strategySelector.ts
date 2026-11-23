import type { AmericanIvStatus } from '../options/ivContract.js';
/**
 * Motor 5 — Selector Especializado de Estrategias GGAL (ARS BYMA vs. OPRA USD).
 *
 * Integra puntas ejecutables Bid/Ask reales (compra en Ask, venta en Bid), modelo completo de
 * fricciones BYMA + IVA 21 %, tarifas US vigentes (SEC Section 31 y suspensión FINRA TAF Q4-2026),
 * garantías/aforos para descubiertos, tasas de caución/Lecap/SOFR y la distribución física
 * simulada P_{USD/CER} del Motor 3 para rankear:
 *   - Bull Call Spreads & Bear Put Spreads
 *   - Ratio Spreads 1x2 y 1x3 (calls y puts)
 *   - Buy-Write T+0 / 24hs (Sección 4.1 Ec. 78 vs. Lecap emparejada)
 *   - Calendar Rolls bimestrales (BS02 sobre IV forward estimada)
 * con comparación directa frente a su equivalente en OPRA USD al mismo moneyness estandarizado z.
 *
 * Funciones 100 % puras: cero red, cero E/S, cero UI y cero mutación de argumentos.
 */

import { SECONDS_PER_YEAR_365 } from '../options/blackScholes.js';
import type { OptionContractType } from '../options/types.js';
import type { PhysicalTerminalNode } from './dualDensity.js';
import {
  BYMA_FEE_SCHEDULE,
  computeBymaFeeRate,
  computeExpiration1530ArtUtcSec,
  computeSettlementCalendarDays,
  computeUsEquityFeeRate,
  computeUsOptionFeeRate,
  DAYS_PER_YEAR,
  DEFAULT_US_FEE_SCHEDULE,
  formatIsoUtcFromSec,
  getBuenosAiresParts,
  GGAL_ADR_RATIO,
  GGAL_BYMA_LOT_SIZE,
  interpolateContinuousRate,
  isPositiveFinite,
  isValidUtcSec,
  quoteMid,
  SECONDS_PER_DAY,
  type BidAskQuote,
  type BymaFeeSchedule,
  type ContinuousRateCurvePoint,
  type DiscreteOrdinaryDividend,
  type OrderSide,
  type UsFeeSchedule,
} from './types.js';
import {
  computeBymaOptionEvalParams,
  priceBymaAmericanBs02,
  solveBymaAmericanIvHybrid,
} from './volTriangle.js';

export const DEFAULT_MIN_BYMA_OI_NOMINALS = 100_000; // 1,000 lotes
export const DEFAULT_MIN_OPRA_OI_CONTRACTS = 10;
export const DEFAULT_EV_TO_COST_MULTIPLE = 1.5;
export const DEFAULT_BYMA_SHORT_SPOT_MARGIN_RATE = 0.2;
export const DEFAULT_BYMA_SHORT_STRIKE_MIN_MARGIN_RATE = 0.1;

export type StrategyVenue = 'BYMA_ARS' | 'OPRA_USD' | 'CROSS_VENUE_RELATIVE';

export type StrategyFamily =
  | 'BULL_CALL_SPREAD'
  | 'BEAR_PUT_SPREAD'
  | 'RATIO_1X2'
  | 'RATIO_1X3'
  | 'BUY_WRITE_T0'
  | 'CALENDAR_ROLL_2M';

export interface StrategyLegOutput {
  readonly ticker: string;
  readonly side: OrderSide;
  readonly qtyContracts: number;
  readonly execPrice: number;
  readonly currency: 'ARS' | 'USD';
  readonly settlement: 'T0' | 'T1';
}

export interface StrategyEconomicsOutput {
  readonly grossDebitOrCredit: number;
  readonly allInFeesAndIva: number;
  readonly marginRequired: number;
  readonly tnaYieldPct: number | null;
  readonly spreadOverLecapBps: number | null;
  readonly expectedValueUnderP: number;
  readonly probProfitUnderP: number;
  readonly maxLoss: number | null;
  readonly netSharpeProxy: number;
}

export interface UsdAlternativeComparison {
  readonly opraEquivalentSharpe: number | null;
  readonly bymaAdvantageBps: number | null;
}

export interface RankedStrategyCandidate {
  readonly id: string;
  readonly venue: StrategyVenue;
  readonly family: StrategyFamily;
  readonly legs: readonly StrategyLegOutput[];
  readonly economics: StrategyEconomicsOutput;
  readonly usdAlternativeComparison: UsdAlternativeComparison;
}

export interface StrategySelectorOutput {
  readonly timestampUtc: string;
  readonly status: 'OK' | 'NO_DATA';
  readonly marketBenchmarks: {
    readonly caucion1dTnaPct: number;
    readonly lecapMatchedTnaPct: number;
    readonly sofrPct: number;
  };
  readonly rankedStrategies: readonly RankedStrategyCandidate[];
}

export interface BymaStrategyOptionQuote {
  readonly ivStatus?: AmericanIvStatus;
  readonly ticker: string;
  readonly contractType: OptionContractType;
  readonly strikeArs: number;
  readonly expiryDateKey: string;
  readonly expiry1530UtcSec?: number;
  readonly bidArs: number;
  readonly askArs: number;
  readonly openInterestNom: number;
  readonly ivDecimal?: number;
}

export interface OpraStrategyOptionQuote {
  readonly ticker: string;
  readonly contractType: OptionContractType;
  readonly strikeUsd: number;
  readonly expiryDateKey: string;
  readonly expiryUtcSec: number;
  readonly bidUsd: number;
  readonly askUsd: number;
  readonly openInterestContracts: number;
  readonly ivDecimal?: number;
}

export interface BymaMarginConfig {
  /** Porcentaje sobre spot para margen inicial de lanzamiento descubierto (ej. 0.20 = 20 %). */
  readonly shortSpotMarginRate: number;
  /** Piso mínimo de margen como fracción del strike para descubiertos (ej. 0.10 = 10 %). */
  readonly shortStrikeMinMarginRate: number;
}

export interface StrategyFilterThresholds {
  /** OI mínimo en nominales BYMA por pata (por defecto 100,000 = 1,000 lotes). */
  readonly minBymaOiNominals?: number;
  /** OI mínimo en contratos OPRA para emparejamiento USD. */
  readonly minOpraOiContracts?: number;
  /** Múltiplo mínimo de ventaja esperada EV_P / costo round-trip (por defecto 1.5). */
  readonly minEvToRoundTripCostMultiple?: number;
  /** Si es true (por defecto), filtra estrategias que no superen EV > 0, 1.5x round-trip y OI mínimo. */
  readonly enforceThresholds?: boolean;
  /** Límite máximo de candidatos retornados (por defecto todos los aprobados). */
  readonly maxCandidates?: number;
}

export interface StrategySelectorInput {
  readonly asOfUtcSec: number;
  readonly spotByma24hArs: number;
  readonly spotByma24hQuote: BidAskQuote;
  readonly spotAdrUsd: number;
  readonly spotAdrQuote?: BidAskQuote;
  readonly frontExpiryDateKey: string;
  readonly frontExpiry1530UtcSec?: number;
  readonly backExpiryDateKey?: string;
  readonly backExpiry1530UtcSec?: number;
  readonly deltaAr1Days?: number;
  readonly deltaExDays?: number;
  readonly arHolidays?: readonly string[];
  readonly caucion1dTnaPct: number;
  readonly lecapMatchedTnaPct: number;
  readonly sofrPct: number;
  readonly rateCurveArs: readonly ContinuousRateCurvePoint[];
  readonly dividendsArs?: readonly DiscreteOrdinaryDividend[];
  readonly rateCurveUsd?: readonly ContinuousRateCurvePoint[];
  readonly bymaChain: readonly BymaStrategyOptionQuote[];
  readonly opraChain: readonly OpraStrategyOptionQuote[];
  readonly physicalNodes: readonly PhysicalTerminalNode[];
  readonly feeSchedule?: BymaFeeSchedule;
  readonly usFeeSchedule?: UsFeeSchedule;
  readonly marginConfig?: BymaMarginConfig;
  readonly filterThresholds?: StrategyFilterThresholds;
}

interface NormalizedPhysicalNode {
  readonly spotUsd: number;
  readonly spotArs: number;
  readonly weight: number;
}

interface OptionLegSpec<TQuote> {
  readonly quote: TQuote;
  readonly side: OrderSide;
  readonly qty: number;
}

interface EvaluatedStructureMetrics {
  readonly grossDebitOrCredit: number;
  readonly netInitialCashflow: number;
  readonly entryFees: number;
  readonly allInFeesAndIva: number;
  readonly roundTripCost: number;
  readonly marginRequired: number;
  readonly tnaYieldPct: number | null;
  readonly spreadOverLecapBps: number | null;
  readonly expectedValueUnderP: number;
  readonly probProfitUnderP: number;
  readonly maxLoss: number | null;
  readonly netSharpeProxy: number;
  readonly capitalBase: number;
}

const DEFAULT_MARGIN_CONFIG: BymaMarginConfig = {
  shortSpotMarginRate: DEFAULT_BYMA_SHORT_SPOT_MARGIN_RATE,
  shortStrikeMinMarginRate: DEFAULT_BYMA_SHORT_STRIKE_MIN_MARGIN_RATE,
};

function isExecutableBidAsk(bid: number, ask: number, side: OrderSide): boolean {
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid < 0 || ask <= 0 || bid > ask) {
    return false;
  }
  return side === 'BUY' ? isPositiveFinite(ask) : isPositiveFinite(bid);
}

function getExecutableOptionPrice(bid: number, ask: number, side: OrderSide): number {
  if (!isExecutableBidAsk(bid, ask, side)) {
    return Number.NaN;
  }
  return side === 'BUY' ? ask : bid;
}

function normalizePhysicalNodes(
  nodes: readonly PhysicalTerminalNode[],
): readonly NormalizedPhysicalNode[] | null {
  if (nodes.length === 0) {
    return null;
  }
  let totalProb = 0;
  for (const node of nodes) {
    if (
      !isPositiveFinite(node.spotUsd) ||
      !isPositiveFinite(node.spotArs) ||
      !Number.isFinite(node.probability) ||
      node.probability < 0
    ) {
      return null;
    }
    totalProb += node.probability;
  }
  if (!isPositiveFinite(totalProb)) {
    return null;
  }
  return nodes.map((node) => ({
    spotUsd: node.spotUsd,
    spotArs: node.spotArs,
    weight: node.probability / totalProb,
  }));
}

function computeUncoveredShortMarginArs(
  spotArs: number,
  strikeArs: number,
  contractType: OptionContractType,
  uncoveredQty: number,
  config: BymaMarginConfig,
): number {
  if (uncoveredQty <= 0) {
    return 0;
  }
  if (!isPositiveFinite(spotArs) || !isPositiveFinite(strikeArs)) {
    return Number.NaN;
  }
  const otmDistance =
    contractType === 'call'
      ? Math.max(0, strikeArs - spotArs)
      : Math.max(0, spotArs - strikeArs);
  const formulaA = config.shortSpotMarginRate * spotArs - otmDistance;
  const formulaB = config.shortStrikeMinMarginRate * strikeArs;
  const perShareMargin = Math.max(formulaA, formulaB);
  return perShareMargin * GGAL_BYMA_LOT_SIZE * uncoveredQty;
}

function computeUncoveredShortMarginUsd(
  spotUsd: number,
  strikeUsd: number,
  contractType: OptionContractType,
  uncoveredQty: number,
  config: BymaMarginConfig,
): number {
  if (uncoveredQty <= 0) {
    return 0;
  }
  if (!isPositiveFinite(spotUsd) || !isPositiveFinite(strikeUsd)) {
    return Number.NaN;
  }
  const otmDistance =
    contractType === 'call'
      ? Math.max(0, strikeUsd - spotUsd)
      : Math.max(0, spotUsd - strikeUsd);
  const formulaA = config.shortSpotMarginRate * spotUsd - otmDistance;
  const formulaB = config.shortStrikeMinMarginRate * strikeUsd;
  return Math.max(formulaA, formulaB) * GGAL_BYMA_LOT_SIZE * uncoveredQty;
}

function computeBymaTerminalOptionLegPayoff(
  spotArs: number,
  strikeArs: number,
  contractType: OptionContractType,
  side: OrderSide,
  qty: number,
  feeSchedule: BymaFeeSchedule,
): { readonly netPayoffArs: number; readonly exerciseFeeArs: number } {
  const grossIntrinsic =
    contractType === 'call' ? Math.max(0, spotArs - strikeArs) : Math.max(0, strikeArs - spotArs);
  if (grossIntrinsic <= 0) {
    return { netPayoffArs: 0, exerciseFeeArs: 0 };
  }
  const notionalStrike = qty * strikeArs * GGAL_BYMA_LOT_SIZE;
  const exerRate = computeBymaFeeRate(notionalStrike, 'EXERCISE', feeSchedule);
  const exerFeePerShare = exerRate * strikeArs;
  if (side === 'BUY') {
    const netPerShare = grossIntrinsic - exerFeePerShare;
    if (netPerShare <= 0) {
      return { netPayoffArs: 0, exerciseFeeArs: 0 };
    }
    return {
      netPayoffArs: qty * GGAL_BYMA_LOT_SIZE * netPerShare,
      exerciseFeeArs: qty * GGAL_BYMA_LOT_SIZE * exerFeePerShare,
    };
  }
  return {
    netPayoffArs: -qty * GGAL_BYMA_LOT_SIZE * (grossIntrinsic + exerFeePerShare),
    exerciseFeeArs: qty * GGAL_BYMA_LOT_SIZE * exerFeePerShare,
  };
}

function computeUsTerminalOptionLegPayoff(
  utcSec: number,
  spotUsd: number,
  strikeUsd: number,
  contractType: OptionContractType,
  side: OrderSide,
  qty: number,
  usFeeSchedule: UsFeeSchedule,
): { readonly netPayoffUsd: number; readonly exerciseFeeUsd: number } {
  const grossIntrinsic =
    contractType === 'call' ? Math.max(0, spotUsd - strikeUsd) : Math.max(0, strikeUsd - spotUsd);
  if (grossIntrinsic <= 0) {
    return { netPayoffUsd: 0, exerciseFeeUsd: 0 };
  }
  // Entrega de acciones al ejercer Call comprado o Put vendido implica venta de ADR sujeta a SEC Sec. 31
  const isDeliveryStockSale =
    (contractType === 'call' && side === 'SELL') || (contractType === 'put' && side === 'BUY');
  const eqSellRate = isDeliveryStockSale
    ? computeUsEquityFeeRate(utcSec, strikeUsd, 'SELL', usFeeSchedule)
    : usFeeSchedule.brokerEquityPerShareUsd / strikeUsd;
  const safeRate = Number.isFinite(eqSellRate) ? eqSellRate : 0;
  const exerFeePerShare = safeRate * strikeUsd;
  if (side === 'BUY') {
    const netPerShare = grossIntrinsic - exerFeePerShare;
    if (netPerShare <= 0) {
      return { netPayoffUsd: 0, exerciseFeeUsd: 0 };
    }
    return {
      netPayoffUsd: qty * GGAL_BYMA_LOT_SIZE * netPerShare,
      exerciseFeeUsd: qty * GGAL_BYMA_LOT_SIZE * exerFeePerShare,
    };
  }
  return {
    netPayoffUsd: -qty * GGAL_BYMA_LOT_SIZE * (grossIntrinsic + exerFeePerShare),
    exerciseFeeUsd: qty * GGAL_BYMA_LOT_SIZE * exerFeePerShare,
  };
}

function summarizeDistributionPayoffs(
  pnls: readonly number[],
  nodes: readonly NormalizedPhysicalNode[],
): {
  readonly expectedValue: number;
  readonly probProfit: number;
  readonly netSharpeProxy: number;
} {
  let ev = 0;
  let probProfit = 0;
  for (let i = 0; i < pnls.length; i += 1) {
    const pnl = pnls[i];
    const node = nodes[i];
    if (pnl === undefined || node === undefined || !Number.isFinite(pnl)) {
      return {
        expectedValue: Number.NaN,
        probProfit: Number.NaN,
        netSharpeProxy: Number.NaN,
      };
    }
    ev += node.weight * pnl;
    if (pnl > 0) {
      probProfit += node.weight;
    }
  }
  let variance = 0;
  for (let i = 0; i < pnls.length; i += 1) {
    const pnl = pnls[i];
    const node = nodes[i];
    if (pnl === undefined || node === undefined) {
      continue;
    }
    const diff = pnl - ev;
    variance += node.weight * diff * diff;
  }
  const stdDev = variance > 0 ? Math.sqrt(variance) : 0;
  const netSharpeProxy =
    stdDev > 0 ? ev / stdDev : ev === 0 ? 0 : ev > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  return {
    expectedValue: ev,
    probProfit,
    netSharpeProxy,
  };
}

function evaluateBymaMultiLegExpiryStructure(
  legs: readonly OptionLegSpec<BymaStrategyOptionQuote>[],
  nodes: readonly NormalizedPhysicalNode[],
  dteExpDays: number,
  rOppByma: number,
  marginRequiredArs: number,
  maxTheoreticalLossArs: number | null,
  feeSchedule: BymaFeeSchedule,
): EvaluatedStructureMetrics | null {
  let grossCf = 0;
  let entryFees = 0;
  let netCf = 0;

  for (const leg of legs) {
    const execPrice = getExecutableOptionPrice(leg.quote.bidArs, leg.quote.askArs, leg.side);
    if (!isPositiveFinite(execPrice)) {
      return null;
    }
    const notional = leg.qty * GGAL_BYMA_LOT_SIZE * execPrice;
    const feeRate = computeBymaFeeRate(notional, 'OPTION_PREMIUM', feeSchedule);
    if (!Number.isFinite(feeRate)) {
      return null;
    }
    const fee = notional * feeRate;
    entryFees += fee;
    if (leg.side === 'BUY') {
      grossCf -= notional;
      netCf -= notional + fee;
    } else {
      grossCf += notional;
      netCf += notional - fee;
    }
  }

  const carryMultiplier = 1 + rOppByma * (dteExpDays / DAYS_PER_YEAR);
  const marginCarryCost = rOppByma * marginRequiredArs * (dteExpDays / DAYS_PER_YEAR);
  const carriedInitial = netCf * carryMultiplier;

  const pnls: number[] = [];
  let expectedExerciseFees = 0;
  let roundTripCloseBaseFees = 0;
  for (const leg of legs) {
    const exRate = computeBymaFeeRate(
      leg.qty * leg.quote.strikeArs * GGAL_BYMA_LOT_SIZE,
      'EXERCISE',
      feeSchedule,
    );
    roundTripCloseBaseFees +=
      Number.isFinite(exRate) ? leg.qty * leg.quote.strikeArs * GGAL_BYMA_LOT_SIZE * exRate : 0;
  }

  for (const node of nodes) {
    let terminalPayoff = 0;
    let nodeExerciseFee = 0;
    for (const leg of legs) {
      const legTerm = computeBymaTerminalOptionLegPayoff(
        node.spotArs,
        leg.quote.strikeArs,
        leg.quote.contractType,
        leg.side,
        leg.qty,
        feeSchedule,
      );
      terminalPayoff += legTerm.netPayoffArs;
      nodeExerciseFee += legTerm.exerciseFeeArs;
    }
    pnls.push(terminalPayoff + carriedInitial - marginCarryCost);
    expectedExerciseFees += node.weight * nodeExerciseFee;
  }

  const summary = summarizeDistributionPayoffs(pnls, nodes);
  if (!Number.isFinite(summary.expectedValue) || !Number.isFinite(summary.netSharpeProxy)) {
    return null;
  }

  const allInFees = entryFees + expectedExerciseFees;
  const roundTripCost = Math.max(2 * entryFees, entryFees + Math.max(expectedExerciseFees, roundTripCloseBaseFees * 0.5));
  const capitalBase = Math.max(
    marginRequiredArs + Math.max(0, -netCf),
    maxTheoreticalLossArs ?? marginRequiredArs,
    GGAL_BYMA_LOT_SIZE,
  );

  return {
    grossDebitOrCredit: grossCf,
    netInitialCashflow: netCf,
    entryFees,
    allInFeesAndIva: allInFees,
    roundTripCost,
    marginRequired: marginRequiredArs,
    tnaYieldPct: null,
    spreadOverLecapBps: null,
    expectedValueUnderP: summary.expectedValue,
    probProfitUnderP: summary.probProfit,
    maxLoss: maxTheoreticalLossArs,
    netSharpeProxy: summary.netSharpeProxy,
    capitalBase,
  };
}

function evaluateBuyWriteStructure(
  callQuote: BymaStrategyOptionQuote,
  spotAsk24hArs: number,
  frontExpiryUtcSec: number,
  asOfUtcSec: number,
  dteSettleDays: number,
  delta1Days: number,
  caucionRate: number,
  lecapMatchedTnaPct: number,
  dividendsArs: readonly DiscreteOrdinaryDividend[],
  nodes: readonly NormalizedPhysicalNode[],
  feeSchedule: BymaFeeSchedule,
): EvaluatedStructureMetrics | null {
  if (
    callQuote.contractType !== 'call' ||
    !isPositiveFinite(spotAsk24hArs) ||
    !isExecutableBidAsk(callQuote.bidArs, callQuote.askArs, 'SELL')
  ) {
    return null;
  }
  const holdingDays = dteSettleDays - delta1Days;
  if (!isPositiveFinite(holdingDays)) {
    return null;
  }

  const sharesPerLot = GGAL_BYMA_LOT_SIZE;
  const eqNotional = sharesPerLot * spotAsk24hArs;
  const optNotional = sharesPerLot * callQuote.bidArs;
  const cEq = computeBymaFeeRate(eqNotional, 'EQUITY', feeSchedule);
  const cOpt = computeBymaFeeRate(optNotional, 'OPTION_PREMIUM', feeSchedule);
  const cExer = computeBymaFeeRate(sharesPerLot * callQuote.strikeArs, 'EXERCISE', feeSchedule);
  if (!Number.isFinite(cEq) || !Number.isFinite(cOpt) || !Number.isFinite(cExer)) {
    return null;
  }

  // Ecuación exacta Sección 4.1 Ec. 78
  const desembolsoPerShare =
    spotAsk24hArs * (1 + cEq) -
    callQuote.bidArs * (1 - cOpt) * (1 + caucionRate * (delta1Days / DAYS_PER_YEAR));
  if (!isPositiveFinite(desembolsoPerShare)) {
    return null;
  }

  const settleHorizonEndUtcSec = frontExpiryUtcSec + Math.round((dteSettleDays - (frontExpiryUtcSec - asOfUtcSec) / SECONDS_PER_DAY) * SECONDS_PER_DAY);
  let reinvestedDivsPerShare = 0;
  for (const div of dividendsArs) {
    if (
      isValidUtcSec(div.exDivUtcSec) &&
      isValidUtcSec(div.payDateUtcSec) &&
      isPositiveFinite(div.amountArs) &&
      div.exDivUtcSec > asOfUtcSec &&
      div.exDivUtcSec <= frontExpiryUtcSec
    ) {
      const reinvestDays = Math.max(
        0,
        (settleHorizonEndUtcSec - div.payDateUtcSec) / SECONDS_PER_DAY,
      );
      reinvestedDivsPerShare += div.amountArs * (1 + caucionRate * (reinvestDays / DAYS_PER_YEAR));
    }
  }

  const calledAwayNumerator = callQuote.strikeArs * (1 - cExer) + reinvestedDivsPerShare;
  const tnaDecimal =
    (calledAwayNumerator / desembolsoPerShare - 1) * (DAYS_PER_YEAR / holdingDays);
  const tnaYieldPct = tnaDecimal * 100;
  const spreadOverLecapBps = (tnaYieldPct - lecapMatchedTnaPct) * 100;

  const rOpp = lecapMatchedTnaPct / 100;
  const desembolsoCarryLot =
    sharesPerLot * desembolsoPerShare * (1 + rOpp * (holdingDays / DAYS_PER_YEAR));

  const pnls: number[] = [];
  let expectedExerciseFees = 0;
  for (const node of nodes) {
    const isCalled = node.spotArs > callQuote.strikeArs;
    const terminalShareValue = isCalled
      ? callQuote.strikeArs * (1 - cExer)
      : node.spotArs;
    const exerciseFeeLot = isCalled ? sharesPerLot * callQuote.strikeArs * cExer : 0;
    const pnl =
      sharesPerLot * (terminalShareValue + reinvestedDivsPerShare) - desembolsoCarryLot;
    pnls.push(pnl);
    expectedExerciseFees += node.weight * exerciseFeeLot;
  }

  const summary = summarizeDistributionPayoffs(pnls, nodes);
  if (!Number.isFinite(summary.expectedValue) || !Number.isFinite(summary.netSharpeProxy)) {
    return null;
  }

  const entryEqFee = eqNotional * cEq;
  const entryOptFee = optNotional * cOpt;
  const entryFees = entryEqFee + entryOptFee;
  const allInFees = entryFees + expectedExerciseFees;
  const desembolsoLot = sharesPerLot * desembolsoPerShare;
  const maxLossLot = Math.max(0, desembolsoCarryLot - sharesPerLot * reinvestedDivsPerShare);

  return {
    grossDebitOrCredit: -(eqNotional - optNotional),
    netInitialCashflow: -desembolsoLot,
    entryFees,
    allInFeesAndIva: allInFees,
    roundTripCost: entryFees + sharesPerLot * callQuote.strikeArs * cExer,
    marginRequired: desembolsoLot,
    tnaYieldPct,
    spreadOverLecapBps,
    expectedValueUnderP: summary.expectedValue,
    probProfitUnderP: summary.probProfit,
    maxLoss: maxLossLot,
    netSharpeProxy: summary.netSharpeProxy,
    capitalBase: desembolsoLot,
  };
}

function resolveOptionIvForCalendar(
  quote: BymaStrategyOptionQuote,
  asOfUtcSec: number,
  spotByma24hArs: number,
  expiryUtcSec: number,
  delta1Days: number,
  deltaExDays: number,
  arHolidays: readonly string[],
  rateCurveArs: readonly ContinuousRateCurvePoint[],
  dividendsArs: readonly DiscreteOrdinaryDividend[],
): number {
  if (quote.ivStatus !== undefined && quote.ivStatus !== 'SOLVED_AMERICAN') return Number.NaN;
  if (quote.ivDecimal !== undefined) {
    return isPositiveFinite(quote.ivDecimal) ? quote.ivDecimal : Number.NaN;
  }
  const mid = quoteMid({ bid: quote.bidArs, ask: quote.askArs });
  if (!isPositiveFinite(mid)) {
    return Number.NaN;
  }
  const params = computeBymaOptionEvalParams({
    asOfUtcSec,
    spot24hArs: spotByma24hArs,
    expiryDateKey: quote.expiryDateKey,
    expiry1530UtcSec: expiryUtcSec,
    deltaAr1Days: delta1Days,
    deltaExDays,
    arHolidays,
    rateCurve: rateCurveArs,
    dividends: dividendsArs,
  });
  if (params === null) {
    return Number.NaN;
  }
  const solved = solveBymaAmericanIvHybrid(
    params,
    quote.strikeArs,
    quote.contractType,
    { bid: quote.bidArs, ask: quote.askArs },
  );
  return solved.arbFlag === 'OK' && isPositiveFinite(solved.iv) ? solved.iv : Number.NaN;
}

function evaluateCalendarRollStructure(
  frontShort: BymaStrategyOptionQuote,
  backLong: BymaStrategyOptionQuote,
  frontExpiryUtcSec: number,
  backExpiryUtcSec: number,
  input: StrategySelectorInput,
  delta1Days: number,
  deltaExDays: number,
  arHolidays: readonly string[],
  nodes: readonly NormalizedPhysicalNode[],
  feeSchedule: BymaFeeSchedule,
): EvaluatedStructureMetrics | null {
  if (
    frontShort.contractType !== backLong.contractType ||
    backExpiryUtcSec <= frontExpiryUtcSec ||
    !isExecutableBidAsk(frontShort.bidArs, frontShort.askArs, 'SELL') ||
    !isExecutableBidAsk(backLong.bidArs, backLong.askArs, 'BUY')
  ) {
    return null;
  }

  const dividends = input.dividendsArs ?? [];
  const ivFront = resolveOptionIvForCalendar(
    frontShort,
    input.asOfUtcSec,
    input.spotByma24hArs,
    frontExpiryUtcSec,
    delta1Days,
    deltaExDays,
    arHolidays,
    input.rateCurveArs,
    dividends,
  );
  const ivBack = resolveOptionIvForCalendar(
    backLong,
    input.asOfUtcSec,
    input.spotByma24hArs,
    backExpiryUtcSec,
    delta1Days,
    deltaExDays,
    arHolidays,
    input.rateCurveArs,
    dividends,
  );
  if (!isPositiveFinite(ivFront) || !isPositiveFinite(ivBack)) {
    return null;
  }

  const t1Exp = (frontExpiryUtcSec - input.asOfUtcSec) / SECONDS_PER_YEAR_365;
  const t2Exp = (backExpiryUtcSec - input.asOfUtcSec) / SECONDS_PER_YEAR_365;
  const remTExp = t2Exp - t1Exp;
  if (!isPositiveFinite(t1Exp) || !isPositiveFinite(remTExp)) {
    return null;
  }

  // Varianza forward entre T1 y T2: exigir monotonicidad positiva de varianza total
  const fwdVariance = (ivBack * ivBack * t2Exp - ivFront * ivFront * t1Exp) / remTExp;
  if (!isPositiveFinite(fwdVariance)) {
    return null;
  }
  const sigmaFwd = Math.sqrt(fwdVariance);

  // Curva forward desde T1 hasta T2_settle para descontar la pata larga remanente sin look-ahead
  const dteFrontExp = (frontExpiryUtcSec - input.asOfUtcSec) / SECONDS_PER_DAY;
  const dteBackExp = (backExpiryUtcSec - input.asOfUtcSec) / SECONDS_PER_DAY;
  const remExpDays = dteBackExp - dteFrontExp;
  const backDateKey = getBuenosAiresParts(backExpiryUtcSec).dateKey;
  const holidaySet = new Set(arHolidays);
  const deltaExBack = computeSettlementCalendarDays(backDateKey, 1, holidaySet);
  const dteBackSettle = dteBackExp + deltaExBack;
  const remSettleDays = dteBackSettle - dteFrontExp;
  const rContBack = interpolateContinuousRate(input.rateCurveArs, dteBackSettle);
  const rContFront = interpolateContinuousRate(input.rateCurveArs, dteFrontExp);
  const rContShortFwd = interpolateContinuousRate(input.rateCurveArs, delta1Days);
  if (
    !Number.isFinite(rContBack) ||
    !Number.isFinite(rContFront) ||
    !Number.isFinite(rContShortFwd) ||
    !isPositiveFinite(remSettleDays)
  ) {
    return null;
  }
  const rFwdLong =
    (rContBack * dteBackSettle - rContFront * dteFrontExp) / remSettleDays;
  const fwdRateCurve: readonly ContinuousRateCurvePoint[] = [
    { days: Math.max(1, delta1Days), continuousRateAnnual: rContShortFwd },
    { days: Math.max(1, remSettleDays), continuousRateAnnual: rFwdLong },
  ];

  const frontNotional = GGAL_BYMA_LOT_SIZE * frontShort.bidArs;
  const backNotional = GGAL_BYMA_LOT_SIZE * backLong.askArs;
  const frontFeeRate = computeBymaFeeRate(frontNotional, 'OPTION_PREMIUM', feeSchedule);
  const backFeeRate = computeBymaFeeRate(backNotional, 'OPTION_PREMIUM', feeSchedule);
  if (!Number.isFinite(frontFeeRate) || !Number.isFinite(backFeeRate)) {
    return null;
  }
  const frontFee = frontNotional * frontFeeRate;
  const backFee = backNotional * backFeeRate;
  const entryFees = frontFee + backFee;
  const grossCf = frontNotional - backNotional;
  const netCf = frontNotional - frontFee - (backNotional + backFee);
  const rOpp = input.lecapMatchedTnaPct / 100;
  const carriedInitial = netCf * (1 + rOpp * (dteFrontExp / DAYS_PER_YEAR));

  const pnls: number[] = [];
  let expectedExitFees = 0;

  for (const node of nodes) {
    const remParams = computeBymaOptionEvalParams({
      asOfUtcSec: frontExpiryUtcSec,
      spot24hArs: node.spotArs,
      expiryDateKey: backLong.expiryDateKey,
      expiry1530UtcSec: backExpiryUtcSec,
      deltaAr1Days: delta1Days,
      deltaExDays: deltaExBack,
      arHolidays,
      caucionRateContinuous: rContShortFwd,
      rateCurve: fwdRateCurve,
      dividends,
    });
    if (remParams === null) {
      return null;
    }
    const backValuePerShare = priceBymaAmericanBs02(
      remParams,
      backLong.strikeArs,
      sigmaFwd,
      backLong.contractType,
    );
    if (!Number.isFinite(backValuePerShare)) {
      return null;
    }
    const backCloseNotional = GGAL_BYMA_LOT_SIZE * Math.max(backValuePerShare, 1e-6);
    const backCloseFeeRate = computeBymaFeeRate(backCloseNotional, 'OPTION_PREMIUM', feeSchedule);
    const backCloseFee = Number.isFinite(backCloseFeeRate)
      ? GGAL_BYMA_LOT_SIZE * backValuePerShare * backCloseFeeRate
      : 0;
    const frontSettlement = computeBymaTerminalOptionLegPayoff(
      node.spotArs,
      frontShort.strikeArs,
      frontShort.contractType,
      'SELL',
      1,
      feeSchedule,
    );
    const pnl =
      GGAL_BYMA_LOT_SIZE * backValuePerShare -
      backCloseFee +
      frontSettlement.netPayoffArs +
      carriedInitial;
    pnls.push(pnl);
    expectedExitFees += node.weight * (backCloseFee + frontSettlement.exerciseFeeArs);
  }

  // Validar que sea estructura calendar estándar (normalmente débito cuando K_back == K_front)
  const netDebitLossBound = Math.max(0, -netCf);
  const theoreticalMaxLoss =
    frontShort.strikeArs === backLong.strikeArs ? netDebitLossBound : null;

  const summary = summarizeDistributionPayoffs(pnls, nodes);
  if (!Number.isFinite(summary.expectedValue) || !Number.isFinite(summary.netSharpeProxy)) {
    return null;
  }

  return {
    grossDebitOrCredit: grossCf,
    netInitialCashflow: netCf,
    entryFees,
    allInFeesAndIva: entryFees + expectedExitFees,
    roundTripCost: Math.max(2 * entryFees, entryFees + expectedExitFees),
    marginRequired: 0,
    tnaYieldPct: null,
    spreadOverLecapBps: null,
    expectedValueUnderP: summary.expectedValue,
    probProfitUnderP: summary.probProfit,
    maxLoss: theoreticalMaxLoss,
    netSharpeProxy: summary.netSharpeProxy,
    capitalBase: Math.max(netDebitLossBound, remExpDays > 0 ? GGAL_BYMA_LOT_SIZE : 1),
  };
}

function findMatchingOpraStrike(
  candidates: readonly OpraStrategyOptionQuote[],
  contractType: OptionContractType,
  targetZ: number,
  forwardUsd: number,
  atmIvSqrtTUsd: number,
  minOpraOiContracts: number,
  preferredSide: OrderSide,
): OpraStrategyOptionQuote | null {
  let best: OpraStrategyOptionQuote | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const opt of candidates) {
    if (
      opt.contractType !== contractType ||
      !Number.isFinite(opt.openInterestContracts) ||
      opt.openInterestContracts < minOpraOiContracts ||
      !isExecutableBidAsk(opt.bidUsd, opt.askUsd, preferredSide)
    ) {
      continue;
    }
    const zOpra = Math.log(opt.strikeUsd / forwardUsd) / atmIvSqrtTUsd;
    if (!Number.isFinite(zOpra)) {
      continue;
    }
    const dist = Math.abs(zOpra - targetZ);
    if (dist < bestDist) {
      bestDist = dist;
      best = opt;
    }
  }
  return best;
}

function estimateAtmIvSqrtT(
  strikesAndIvs: readonly { readonly strike: number; readonly iv: number }[],
  forward: number,
  tYears: number,
): number {
  if (!isPositiveFinite(forward) || !isPositiveFinite(tYears)) {
    return Number.NaN;
  }
  let bestIv = Number.NaN;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const item of strikesAndIvs) {
    if (!isPositiveFinite(item.strike) || !isPositiveFinite(item.iv)) {
      continue;
    }
    const dist = Math.abs(Math.log(item.strike / forward));
    if (dist < bestDist) {
      bestDist = dist;
      bestIv = item.iv;
    }
  }
  return isPositiveFinite(bestIv) ? bestIv * Math.sqrt(tYears) : Number.NaN;
}

function computeOpraEquivalentComparison(
  family: StrategyFamily,
  bymaLegs: readonly OptionLegSpec<BymaStrategyOptionQuote>[],
  bymaMetrics: EvaluatedStructureMetrics,
  forwardBymaArs: number,
  atmIvSqrtTByma: number,
  t1Years: number,
  dteFrontExp: number,
  input: StrategySelectorInput,
  nodes: readonly NormalizedPhysicalNode[],
  minOpraOiContracts: number,
  marginConfig: BymaMarginConfig,
  usFeeSchedule: UsFeeSchedule,
): UsdAlternativeComparison {
  if (
    input.opraChain.length === 0 ||
    !isPositiveFinite(forwardBymaArs) ||
    !isPositiveFinite(atmIvSqrtTByma) ||
    !isPositiveFinite(t1Years) ||
    !isPositiveFinite(dteFrontExp)
  ) {
    return { opraEquivalentSharpe: null, bymaAdvantageBps: null };
  }

  // Determinar vencimiento OPRA más cercano al vencimiento frontal T_1
  let frontOpraExpiryUtc = Number.NaN;
  let bestExpiryDiff = Number.POSITIVE_INFINITY;
  const frontExpiryTarget = input.asOfUtcSec + dteFrontExp * SECONDS_PER_DAY;
  for (const opt of input.opraChain) {
    if (!isValidUtcSec(opt.expiryUtcSec) || opt.expiryUtcSec <= input.asOfUtcSec) {
      continue;
    }
    const diff = Math.abs(opt.expiryUtcSec - frontExpiryTarget);
    if (diff < bestExpiryDiff) {
      bestExpiryDiff = diff;
      frontOpraExpiryUtc = opt.expiryUtcSec;
    }
  }
  if (!Number.isFinite(frontOpraExpiryUtc)) {
    return { opraEquivalentSharpe: null, bymaAdvantageBps: null };
  }

  const frontOpraCandidates = input.opraChain.filter(
    (opt) => opt.expiryUtcSec === frontOpraExpiryUtc,
  );
  const tOpraYears = (frontOpraExpiryUtc - input.asOfUtcSec) / SECONDS_PER_YEAR_365;
  const rSofr = input.sofrPct / 100;
  const forwardOpraUsd = input.spotAdrUsd * Math.exp(rSofr * tOpraYears);
  const opraIvs = frontOpraCandidates
    .filter((o) => o.ivDecimal !== undefined && isPositiveFinite(o.ivDecimal))
    .map((o) => ({ strike: o.strikeUsd, iv: o.ivDecimal as number }));
  const atmIvSqrtTOpra =
    opraIvs.length > 0
      ? estimateAtmIvSqrtT(opraIvs, forwardOpraUsd, tOpraYears)
      : atmIvSqrtTByma;
  if (!isPositiveFinite(atmIvSqrtTOpra)) {
    return { opraEquivalentSharpe: null, bymaAdvantageBps: null };
  }

  // Emparejar patas por moneyness z estandarizado
  const opraLegs: OptionLegSpec<OpraStrategyOptionQuote>[] = [];
  for (const leg of bymaLegs) {
    const zByma = Math.log(leg.quote.strikeArs / forwardBymaArs) / atmIvSqrtTByma;
    const pool =
      family === 'CALENDAR_ROLL_2M' && leg.side === 'BUY'
        ? input.opraChain.filter((o) => o.expiryUtcSec > frontOpraExpiryUtc)
        : frontOpraCandidates;
    const matched = findMatchingOpraStrike(
      pool,
      leg.quote.contractType,
      zByma,
      forwardOpraUsd,
      atmIvSqrtTOpra,
      minOpraOiContracts,
      leg.side,
    );
    if (matched === null) {
      return { opraEquivalentSharpe: null, bymaAdvantageBps: null };
    }
    opraLegs.push({
      quote: matched,
      side: leg.side,
      qty: leg.qty,
    });
  }

  // Evitar comparar spread vertical degenerado si dos patas OPRA colapsan en el mismo strike
  if (
    (family === 'BULL_CALL_SPREAD' ||
      family === 'BEAR_PUT_SPREAD' ||
      family === 'RATIO_1X2' ||
      family === 'RATIO_1X3') &&
    opraLegs.length === 2 &&
    opraLegs[0] !== undefined &&
    opraLegs[1] !== undefined &&
    opraLegs[0].quote.strikeUsd === opraLegs[1].quote.strikeUsd
  ) {
    return { opraEquivalentSharpe: null, bymaAdvantageBps: null };
  }

  // Costos OPRA bajo SEC Section 31 y FINRA TAF Q4-2026
  let cf0NetUsd = 0;
  for (const leg of opraLegs) {
    const execPriceUsd = getExecutableOptionPrice(leg.quote.bidUsd, leg.quote.askUsd, leg.side);
    if (!isPositiveFinite(execPriceUsd)) {
      return { opraEquivalentSharpe: null, bymaAdvantageBps: null };
    }
    const feeRateUsd = computeUsOptionFeeRate(
      input.asOfUtcSec,
      execPriceUsd,
      leg.side,
      usFeeSchedule,
    );
    if (!Number.isFinite(feeRateUsd)) {
      return { opraEquivalentSharpe: null, bymaAdvantageBps: null };
    }
    const notionalUsd = leg.qty * GGAL_BYMA_LOT_SIZE * execPriceUsd;
    const feeUsd = notionalUsd * feeRateUsd;
    cf0NetUsd += leg.side === 'BUY' ? -(notionalUsd + feeUsd) : notionalUsd - feeUsd;
  }

  // Margen OPRA para Buy-Write o descubiertos
  let extraOpraMarginUsd = 0;
  let buyWriteDesembolsoUsd = 0;
  if (family === 'BUY_WRITE_T0') {
    const adrAskUsd =
      input.spotAdrQuote !== undefined
        ? (isPositiveFinite(input.spotAdrQuote.ask) ? input.spotAdrQuote.ask : Number.NaN)
        : input.spotAdrUsd;
    const callLeg = opraLegs[0];
    if (!isPositiveFinite(adrAskUsd) || callLeg === undefined) {
      return { opraEquivalentSharpe: null, bymaAdvantageBps: null };
    }
    const eqFeeBuy = computeUsEquityFeeRate(input.asOfUtcSec, adrAskUsd, 'BUY', usFeeSchedule);
    const callBidUsd = callLeg.quote.bidUsd;
    const optFeeSell = computeUsOptionFeeRate(input.asOfUtcSec, callBidUsd, 'SELL', usFeeSchedule);
    if (!Number.isFinite(eqFeeBuy) || !Number.isFinite(optFeeSell)) {
      return { opraEquivalentSharpe: null, bymaAdvantageBps: null };
    }
    buyWriteDesembolsoUsd =
      GGAL_BYMA_LOT_SIZE * (adrAskUsd * (1 + eqFeeBuy) - callBidUsd * (1 - optFeeSell));
    if (!isPositiveFinite(buyWriteDesembolsoUsd)) {
      return { opraEquivalentSharpe: null, bymaAdvantageBps: null };
    }
  } else {
    const shortQty = opraLegs.reduce((acc, l) => acc + (l.side === 'SELL' ? l.qty : 0), 0);
    const longQty = opraLegs.reduce((acc, l) => acc + (l.side === 'BUY' ? l.qty : 0), 0);
    const uncoveredQty = Math.max(0, shortQty - longQty);
    const shortLeg = opraLegs.find((l) => l.side === 'SELL');
    if (uncoveredQty > 0 && shortLeg !== undefined) {
      extraOpraMarginUsd = computeUncoveredShortMarginUsd(
        input.spotAdrUsd,
        shortLeg.quote.strikeUsd,
        shortLeg.quote.contractType,
        uncoveredQty,
        marginConfig,
      );
    }
  }

  const carryOpra = 1 + rSofr * (dteFrontExp / DAYS_PER_YEAR);
  const pnlsUsd: number[] = [];
  for (const node of nodes) {
    if (family === 'BUY_WRITE_T0') {
      const callLeg = opraLegs[0];
      if (callLeg === undefined) {
        return { opraEquivalentSharpe: null, bymaAdvantageBps: null };
      }
      const assigned = node.spotUsd > callLeg.quote.strikeUsd;
      const eqSellRate = assigned
        ? computeUsEquityFeeRate(input.asOfUtcSec, callLeg.quote.strikeUsd, 'SELL', usFeeSchedule)
        : 0;
      const terminalShareUsd = assigned
        ? callLeg.quote.strikeUsd * (1 - (Number.isFinite(eqSellRate) ? eqSellRate : 0))
        : node.spotUsd;
      pnlsUsd.push(
        GGAL_BYMA_LOT_SIZE * terminalShareUsd - buyWriteDesembolsoUsd * carryOpra,
      );
    } else {
      let termPayoffUsd = 0;
      for (const leg of opraLegs) {
        termPayoffUsd += computeUsTerminalOptionLegPayoff(
          input.asOfUtcSec,
          node.spotUsd,
          leg.quote.strikeUsd,
          leg.quote.contractType,
          leg.side,
          leg.qty,
          usFeeSchedule,
        ).netPayoffUsd;
      }
      pnlsUsd.push(
        termPayoffUsd +
          cf0NetUsd * carryOpra -
          rSofr * extraOpraMarginUsd * (dteFrontExp / DAYS_PER_YEAR),
      );
    }
  }

  const opraSummary = summarizeDistributionPayoffs(pnlsUsd, nodes);
  if (!Number.isFinite(opraSummary.netSharpeProxy) || !Number.isFinite(opraSummary.expectedValue)) {
    return { opraEquivalentSharpe: null, bymaAdvantageBps: null };
  }

  // Comparar ventaja anualizada en bps ajustada por expectativa física del CCL bajo P
  const ccl0 = input.spotByma24hArs / (input.spotAdrUsd * GGAL_ADR_RATIO);
  let expectedCclT1 = 0;
  for (const node of nodes) {
    const cclNode = node.spotArs / (node.spotUsd * GGAL_ADR_RATIO);
    expectedCclT1 += node.weight * cclNode;
  }
  const cclMultiple = isPositiveFinite(ccl0) && isPositiveFinite(expectedCclT1)
    ? expectedCclT1 / ccl0
    : Number.NaN;
  const opraCapitalBaseUsd =
    family === 'BUY_WRITE_T0'
      ? buyWriteDesembolsoUsd
      : Math.max(extraOpraMarginUsd + Math.max(0, -cf0NetUsd), GGAL_BYMA_LOT_SIZE);

  if (
    !isPositiveFinite(cclMultiple) ||
    !isPositiveFinite(opraCapitalBaseUsd) ||
    !isPositiveFinite(bymaMetrics.capitalBase)
  ) {
    return {
      opraEquivalentSharpe: opraSummary.netSharpeProxy,
      bymaAdvantageBps: null,
    };
  }

  const bymaHoldReturn = bymaMetrics.expectedValueUnderP / bymaMetrics.capitalBase;
  const opraUsdHoldReturn = opraSummary.expectedValue / opraCapitalBaseUsd;
  const opraCclAdjustedHoldReturn = (1 + opraUsdHoldReturn) * cclMultiple - 1;
  const annFactor = DAYS_PER_YEAR / dteFrontExp;
  const bymaAdvantageBps = (bymaHoldReturn - opraCclAdjustedHoldReturn) * annFactor * 10_000;

  return {
    opraEquivalentSharpe: opraSummary.netSharpeProxy,
    bymaAdvantageBps: Number.isFinite(bymaAdvantageBps) ? bymaAdvantageBps : null,
  };
}

/**
 * Evalúa y rankea estructuras ejecutables en BYMA ARS frente a su alternativa equivalente
 * en OPRA USD sobre la distribución física P del Motor 3 y el esquema completo de costos.
 */
export function evaluateStrategySelector(
  input: StrategySelectorInput,
): StrategySelectorOutput {
  const emptyOutput: StrategySelectorOutput = {
    timestampUtc: isValidUtcSec(input.asOfUtcSec)
      ? formatIsoUtcFromSec(input.asOfUtcSec)
      : 'INVALID_UTC',
    status: 'NO_DATA',
    marketBenchmarks: {
      caucion1dTnaPct: Number.isFinite(input.caucion1dTnaPct) ? input.caucion1dTnaPct : Number.NaN,
      lecapMatchedTnaPct: Number.isFinite(input.lecapMatchedTnaPct)
        ? input.lecapMatchedTnaPct
        : Number.NaN,
      sofrPct: Number.isFinite(input.sofrPct) ? input.sofrPct : Number.NaN,
    },
    rankedStrategies: [],
  };

  if (
    !isValidUtcSec(input.asOfUtcSec) ||
    !isPositiveFinite(input.spotByma24hArs) ||
    !isPositiveFinite(input.spotAdrUsd) ||
    !Number.isFinite(input.caucion1dTnaPct) ||
    !Number.isFinite(input.lecapMatchedTnaPct) ||
    !Number.isFinite(input.sofrPct)
  ) {
    return emptyOutput;
  }

  const nodes = normalizePhysicalNodes(input.physicalNodes);
  if (nodes === null) {
    return emptyOutput;
  }

  const frontExpiryUtcSec =
    input.frontExpiry1530UtcSec ?? computeExpiration1530ArtUtcSec(input.frontExpiryDateKey);
  if (!isValidUtcSec(frontExpiryUtcSec) || frontExpiryUtcSec <= input.asOfUtcSec) {
    return emptyOutput;
  }

  const feeSchedule = input.feeSchedule ?? BYMA_FEE_SCHEDULE;
  const usFeeSchedule = input.usFeeSchedule ?? DEFAULT_US_FEE_SCHEDULE;
  const marginConfig = input.marginConfig ?? DEFAULT_MARGIN_CONFIG;
  const thresholds = input.filterThresholds;
  const minBymaOi = thresholds?.minBymaOiNominals ?? DEFAULT_MIN_BYMA_OI_NOMINALS;
  const minOpraOi = thresholds?.minOpraOiContracts ?? DEFAULT_MIN_OPRA_OI_CONTRACTS;
  const minEvMultiple = thresholds?.minEvToRoundTripCostMultiple ?? DEFAULT_EV_TO_COST_MULTIPLE;
  const enforceThresholds = thresholds?.enforceThresholds ?? true;

  const arHolidays = input.arHolidays ?? [];
  const holidaySet = new Set(arHolidays);
  const asOfDateKey = getBuenosAiresParts(input.asOfUtcSec).dateKey;
  const delta1Days =
    input.deltaAr1Days ?? computeSettlementCalendarDays(asOfDateKey, 1, holidaySet);
  const deltaExDays =
    input.deltaExDays ?? computeSettlementCalendarDays(input.frontExpiryDateKey, 1, holidaySet);
  if (!Number.isFinite(delta1Days) || !Number.isFinite(deltaExDays)) {
    return emptyOutput;
  }

  const dteFrontExp = (frontExpiryUtcSec - input.asOfUtcSec) / SECONDS_PER_DAY;
  const dteFrontSettle = dteFrontExp + deltaExDays;
  const t1ExpYears = (frontExpiryUtcSec - input.asOfUtcSec) / SECONDS_PER_YEAR_365;
  const rOppByma = input.lecapMatchedTnaPct / 100;
  const caucionRate = input.caucion1dTnaPct / 100;
  const dividends = input.dividendsArs ?? [];

  const evalParamsFront = computeBymaOptionEvalParams({
    asOfUtcSec: input.asOfUtcSec,
    spot24hArs: input.spotByma24hArs,
    expiryDateKey: input.frontExpiryDateKey,
    expiry1530UtcSec: frontExpiryUtcSec,
    deltaAr1Days: delta1Days,
    deltaExDays,
    arHolidays,
    rateCurve: input.rateCurveArs,
    dividends,
  });

  // Filtrar cadenas BYMA frontal y trasera líquidas
  const frontOptions = input.bymaChain
    .filter((opt) => {
      const expSec =
        opt.expiry1530UtcSec ?? computeExpiration1530ArtUtcSec(opt.expiryDateKey);
      return (
        expSec === frontExpiryUtcSec &&
        (opt.ivStatus === undefined || opt.ivStatus === 'SOLVED_AMERICAN') &&
        isPositiveFinite(opt.strikeArs) &&
        Number.isFinite(opt.openInterestNom) &&
        opt.openInterestNom >= minBymaOi
      );
    })
    .slice()
    .sort((a, b) => a.strikeArs - b.strikeArs);

  const frontCalls = frontOptions.filter((o) => o.contractType === 'call');
  const frontPuts = frontOptions.filter((o) => o.contractType === 'put');

  const forwardBymaArs = evalParamsFront !== null ? evalParamsFront.forwardArs : input.spotByma24hArs;
  const bymaIvs = frontOptions
    .map((o) => ({
      strike: o.strikeArs,
      iv: resolveOptionIvForCalendar(
        o,
        input.asOfUtcSec,
        input.spotByma24hArs,
        frontExpiryUtcSec,
        delta1Days,
        deltaExDays,
        arHolidays,
        input.rateCurveArs,
        dividends,
      ),
    }))
    .filter((x) => isPositiveFinite(x.iv));
  const atmIvSqrtTByma = estimateAtmIvSqrtT(bymaIvs, forwardBymaArs, t1ExpYears);

  const rawCandidates: Array<{
    readonly candidate: RankedStrategyCandidate;
    readonly roundTripCost: number;
  }> = [];

  const registerCandidate = (
    id: string,
    venue: StrategyVenue,
    family: StrategyFamily,
    legsOut: readonly StrategyLegOutput[],
    bymaLegsForOpra: readonly OptionLegSpec<BymaStrategyOptionQuote>[],
    metrics: EvaluatedStructureMetrics | null,
  ): void => {
    if (metrics === null) {
      return;
    }
    if (
      enforceThresholds &&
      (!Number.isFinite(metrics.expectedValueUnderP) ||
        metrics.expectedValueUnderP <= 0 ||
        metrics.expectedValueUnderP < minEvMultiple * metrics.roundTripCost)
    ) {
      return;
    }
    const comparison = computeOpraEquivalentComparison(
      family,
      bymaLegsForOpra,
      metrics,
      forwardBymaArs,
      atmIvSqrtTByma,
      t1ExpYears,
      dteFrontExp,
      input,
      nodes,
      minOpraOi,
      marginConfig,
      usFeeSchedule,
    );
    rawCandidates.push({
      candidate: {
        id,
        venue,
        family,
        legs: legsOut,
        economics: {
          grossDebitOrCredit: metrics.grossDebitOrCredit,
          allInFeesAndIva: metrics.allInFeesAndIva,
          marginRequired: metrics.marginRequired,
          tnaYieldPct: metrics.tnaYieldPct,
          spreadOverLecapBps: metrics.spreadOverLecapBps,
          expectedValueUnderP: metrics.expectedValueUnderP,
          probProfitUnderP: metrics.probProfitUnderP,
          maxLoss: metrics.maxLoss,
          netSharpeProxy: metrics.netSharpeProxy,
        },
        usdAlternativeComparison: comparison,
      },
      roundTripCost: metrics.roundTripCost,
    });
  };

  // 1. BULL CALL SPREAD (+1 C(K1), -1 C(K2), K1 < K2)
  for (let i = 0; i < frontCalls.length; i += 1) {
    for (let j = i + 1; j < frontCalls.length; j += 1) {
      const longCall = frontCalls[i];
      const shortCall = frontCalls[j];
      if (longCall === undefined || shortCall === undefined || shortCall.strikeArs <= longCall.strikeArs) {
        continue;
      }
      const legsSpec: readonly OptionLegSpec<BymaStrategyOptionQuote>[] = [
        { quote: longCall, side: 'BUY', qty: 1 },
        { quote: shortCall, side: 'SELL', qty: 1 },
      ];
      const buyPrice = getExecutableOptionPrice(longCall.bidArs, longCall.askArs, 'BUY');
      const sellPrice = getExecutableOptionPrice(shortCall.bidArs, shortCall.askArs, 'SELL');
      if (!isPositiveFinite(buyPrice) || !isPositiveFinite(sellPrice)) {
        continue;
      }
      // Pérdida máxima teórica de un Bull Call Spread
      const feeLong = GGAL_BYMA_LOT_SIZE * buyPrice * computeBymaFeeRate(GGAL_BYMA_LOT_SIZE * buyPrice, 'OPTION_PREMIUM', feeSchedule);
      const feeShort = GGAL_BYMA_LOT_SIZE * sellPrice * computeBymaFeeRate(GGAL_BYMA_LOT_SIZE * sellPrice, 'OPTION_PREMIUM', feeSchedule);
      const netCfEstimate = (sellPrice - buyPrice) * GGAL_BYMA_LOT_SIZE - feeLong - feeShort;
      const carryLoss = -netCfEstimate * (1 + rOppByma * (dteFrontExp / DAYS_PER_YEAR));
      const maxLoss = Math.max(0, carryLoss);

      const metrics = evaluateBymaMultiLegExpiryStructure(
        legsSpec,
        nodes,
        dteFrontExp,
        rOppByma,
        0,
        maxLoss,
        feeSchedule,
      );
      registerCandidate(
        `BULL_CALL_${longCall.ticker}_${shortCall.ticker}`,
        'BYMA_ARS',
        'BULL_CALL_SPREAD',
        [
          {
            ticker: longCall.ticker,
            side: 'BUY',
            qtyContracts: 1,
            execPrice: buyPrice,
            currency: 'ARS',
            settlement: 'T0',
          },
          {
            ticker: shortCall.ticker,
            side: 'SELL',
            qtyContracts: 1,
            execPrice: sellPrice,
            currency: 'ARS',
            settlement: 'T0',
          },
        ],
        legsSpec,
        metrics,
      );
    }
  }

  // 2. BEAR PUT SPREAD (+1 P(K2), -1 P(K1), K1 < K2)
  for (let i = 0; i < frontPuts.length; i += 1) {
    for (let j = i + 1; j < frontPuts.length; j += 1) {
      const shortPut = frontPuts[i];
      const longPut = frontPuts[j];
      if (shortPut === undefined || longPut === undefined || longPut.strikeArs <= shortPut.strikeArs) {
        continue;
      }
      const legsSpec: readonly OptionLegSpec<BymaStrategyOptionQuote>[] = [
        { quote: longPut, side: 'BUY', qty: 1 },
        { quote: shortPut, side: 'SELL', qty: 1 },
      ];
      const buyPrice = getExecutableOptionPrice(longPut.bidArs, longPut.askArs, 'BUY');
      const sellPrice = getExecutableOptionPrice(shortPut.bidArs, shortPut.askArs, 'SELL');
      if (!isPositiveFinite(buyPrice) || !isPositiveFinite(sellPrice)) {
        continue;
      }
      const feeLong = GGAL_BYMA_LOT_SIZE * buyPrice * computeBymaFeeRate(GGAL_BYMA_LOT_SIZE * buyPrice, 'OPTION_PREMIUM', feeSchedule);
      const feeShort = GGAL_BYMA_LOT_SIZE * sellPrice * computeBymaFeeRate(GGAL_BYMA_LOT_SIZE * sellPrice, 'OPTION_PREMIUM', feeSchedule);
      const netCfEstimate = (sellPrice - buyPrice) * GGAL_BYMA_LOT_SIZE - feeLong - feeShort;
      const maxLoss = Math.max(0, -netCfEstimate * (1 + rOppByma * (dteFrontExp / DAYS_PER_YEAR)));

      const metrics = evaluateBymaMultiLegExpiryStructure(
        legsSpec,
        nodes,
        dteFrontExp,
        rOppByma,
        0,
        maxLoss,
        feeSchedule,
      );
      registerCandidate(
        `BEAR_PUT_${longPut.ticker}_${shortPut.ticker}`,
        'BYMA_ARS',
        'BEAR_PUT_SPREAD',
        [
          {
            ticker: longPut.ticker,
            side: 'BUY',
            qtyContracts: 1,
            execPrice: buyPrice,
            currency: 'ARS',
            settlement: 'T0',
          },
          {
            ticker: shortPut.ticker,
            side: 'SELL',
            qtyContracts: 1,
            execPrice: sellPrice,
            currency: 'ARS',
            settlement: 'T0',
          },
        ],
        legsSpec,
        metrics,
      );
    }
  }

  // 3 & 4. RATIO SPREADS 1x2 y 1x3 (Calls: +1 C(K1), -m C(K2); Puts: +1 P(K2), -m P(K1))
  const ratioConfigs: readonly { readonly m: 2 | 3; readonly family: 'RATIO_1X2' | 'RATIO_1X3' }[] = [
    { m: 2, family: 'RATIO_1X2' },
    { m: 3, family: 'RATIO_1X3' },
  ];
  for (const cfg of ratioConfigs) {
    for (let i = 0; i < frontCalls.length; i += 1) {
      for (let j = i + 1; j < frontCalls.length; j += 1) {
        const longCall = frontCalls[i];
        const shortCall = frontCalls[j];
        if (longCall === undefined || shortCall === undefined || shortCall.strikeArs <= longCall.strikeArs) {
          continue;
        }
        const buyPrice = getExecutableOptionPrice(longCall.bidArs, longCall.askArs, 'BUY');
        const sellPrice = getExecutableOptionPrice(shortCall.bidArs, shortCall.askArs, 'SELL');
        if (!isPositiveFinite(buyPrice) || !isPositiveFinite(sellPrice)) {
          continue;
        }
        const legsSpec: readonly OptionLegSpec<BymaStrategyOptionQuote>[] = [
          { quote: longCall, side: 'BUY', qty: 1 },
          { quote: shortCall, side: 'SELL', qty: cfg.m },
        ];
        const uncoveredMargin = computeUncoveredShortMarginArs(
          input.spotByma24hArs,
          shortCall.strikeArs,
          'call',
          cfg.m - 1,
          marginConfig,
        );
        const metrics = evaluateBymaMultiLegExpiryStructure(
          legsSpec,
          nodes,
          dteFrontExp,
          rOppByma,
          uncoveredMargin,
          null, // Pérdida ilimitada al alza
          feeSchedule,
        );
        registerCandidate(
          `${cfg.family}_CALL_${longCall.ticker}_${shortCall.ticker}`,
          'BYMA_ARS',
          cfg.family,
          [
            {
              ticker: longCall.ticker,
              side: 'BUY',
              qtyContracts: 1,
              execPrice: buyPrice,
              currency: 'ARS',
              settlement: 'T0',
            },
            {
              ticker: shortCall.ticker,
              side: 'SELL',
              qtyContracts: cfg.m,
              execPrice: sellPrice,
              currency: 'ARS',
              settlement: 'T0',
            },
          ],
          legsSpec,
          metrics,
        );
      }
    }

    for (let i = 0; i < frontPuts.length; i += 1) {
      for (let j = i + 1; j < frontPuts.length; j += 1) {
        const shortPut = frontPuts[i];
        const longPut = frontPuts[j];
        if (shortPut === undefined || longPut === undefined || longPut.strikeArs <= shortPut.strikeArs) {
          continue;
        }
        const buyPrice = getExecutableOptionPrice(longPut.bidArs, longPut.askArs, 'BUY');
        const sellPrice = getExecutableOptionPrice(shortPut.bidArs, shortPut.askArs, 'SELL');
        if (!isPositiveFinite(buyPrice) || !isPositiveFinite(sellPrice)) {
          continue;
        }
        const legsSpec: readonly OptionLegSpec<BymaStrategyOptionQuote>[] = [
          { quote: longPut, side: 'BUY', qty: 1 },
          { quote: shortPut, side: 'SELL', qty: cfg.m },
        ];
        const uncoveredMargin = computeUncoveredShortMarginArs(
          input.spotByma24hArs,
          shortPut.strikeArs,
          'put',
          cfg.m - 1,
          marginConfig,
        );
        // En Ratio Put, pérdida máxima en S=0 es acotada
        const payAtZeroLong = computeBymaTerminalOptionLegPayoff(
          0,
          longPut.strikeArs,
          'put',
          'BUY',
          1,
          feeSchedule,
        ).netPayoffArs;
        const payAtZeroShort = computeBymaTerminalOptionLegPayoff(
          0,
          shortPut.strikeArs,
          'put',
          'SELL',
          cfg.m,
          feeSchedule,
        ).netPayoffArs;
        const feeLong = GGAL_BYMA_LOT_SIZE * buyPrice * computeBymaFeeRate(GGAL_BYMA_LOT_SIZE * buyPrice, 'OPTION_PREMIUM', feeSchedule);
        const feeShort = cfg.m * GGAL_BYMA_LOT_SIZE * sellPrice * computeBymaFeeRate(cfg.m * GGAL_BYMA_LOT_SIZE * sellPrice, 'OPTION_PREMIUM', feeSchedule);
        const netCfEst = (cfg.m * sellPrice - buyPrice) * GGAL_BYMA_LOT_SIZE - feeLong - feeShort;
        const carryEst = netCfEst * (1 + rOppByma * (dteFrontExp / DAYS_PER_YEAR)) - rOppByma * uncoveredMargin * (dteFrontExp / DAYS_PER_YEAR);
        const maxLossAtZero = Math.max(0, -(payAtZeroLong + payAtZeroShort + carryEst));

        const metrics = evaluateBymaMultiLegExpiryStructure(
          legsSpec,
          nodes,
          dteFrontExp,
          rOppByma,
          uncoveredMargin,
          maxLossAtZero,
          feeSchedule,
        );
        registerCandidate(
          `${cfg.family}_PUT_${longPut.ticker}_${shortPut.ticker}`,
          'BYMA_ARS',
          cfg.family,
          [
            {
              ticker: longPut.ticker,
              side: 'BUY',
              qtyContracts: 1,
              execPrice: buyPrice,
              currency: 'ARS',
              settlement: 'T0',
            },
            {
              ticker: shortPut.ticker,
              side: 'SELL',
              qtyContracts: cfg.m,
              execPrice: sellPrice,
              currency: 'ARS',
              settlement: 'T0',
            },
          ],
          legsSpec,
          metrics,
        );
      }
    }
  }

  // 5. BUY-WRITE T+0 / 24hs (Sección 4.1 Ec. 78 vs Lecap emparejada)
  const spotAsk24hArs = isExecutableBidAsk(
    input.spotByma24hQuote.bid,
    input.spotByma24hQuote.ask,
    'BUY',
  )
    ? input.spotByma24hQuote.ask
    : Number.NaN;
  if (isPositiveFinite(spotAsk24hArs)) {
    for (const callOpt of frontCalls) {
      const sellCallPrice = getExecutableOptionPrice(callOpt.bidArs, callOpt.askArs, 'SELL');
      if (!isPositiveFinite(sellCallPrice)) {
        continue;
      }
      const metrics = evaluateBuyWriteStructure(
        callOpt,
        spotAsk24hArs,
        frontExpiryUtcSec,
        input.asOfUtcSec,
        dteFrontSettle,
        delta1Days,
        caucionRate,
        input.lecapMatchedTnaPct,
        dividends,
        nodes,
        feeSchedule,
      );
      registerCandidate(
        `BUY_WRITE_GGAL_${callOpt.ticker}`,
        'BYMA_ARS',
        'BUY_WRITE_T0',
        [
          {
            ticker: 'GGAL',
            side: 'BUY',
            qtyContracts: 1,
            execPrice: spotAsk24hArs,
            currency: 'ARS',
            settlement: 'T1',
          },
          {
            ticker: callOpt.ticker,
            side: 'SELL',
            qtyContracts: 1,
            execPrice: sellCallPrice,
            currency: 'ARS',
            settlement: 'T0',
          },
        ],
        [{ quote: callOpt, side: 'SELL', qty: 1 }],
        metrics,
      );
    }
  }

  // 6. CALENDAR ROLL BIMESTRAL (-1 frontal T1, +1 trasero T2 > T1)
  const backOptions = input.bymaChain.filter((opt) => {
    const expSec =
      opt.expiry1530UtcSec ?? computeExpiration1530ArtUtcSec(opt.expiryDateKey);
    const targetMatches =
      input.backExpiry1530UtcSec !== undefined
        ? expSec === input.backExpiry1530UtcSec
        : input.backExpiryDateKey !== undefined
          ? opt.expiryDateKey === input.backExpiryDateKey
          : expSec > frontExpiryUtcSec;
    return (
      targetMatches &&
      (opt.ivStatus === undefined || opt.ivStatus === 'SOLVED_AMERICAN') &&
      isValidUtcSec(expSec) &&
      expSec > frontExpiryUtcSec &&
      isPositiveFinite(opt.strikeArs) &&
      Number.isFinite(opt.openInterestNom) &&
      opt.openInterestNom >= minBymaOi
    );
  });

  for (const frontOpt of frontOptions) {
    const backMatches = backOptions.filter(
      (b) =>
        b.contractType === frontOpt.contractType &&
        b.strikeArs === frontOpt.strikeArs,
    );
    for (const backOpt of backMatches) {
      const backExpSec =
        backOpt.expiry1530UtcSec ?? computeExpiration1530ArtUtcSec(backOpt.expiryDateKey);
      const frontBid = getExecutableOptionPrice(frontOpt.bidArs, frontOpt.askArs, 'SELL');
      const backAsk = getExecutableOptionPrice(backOpt.bidArs, backOpt.askArs, 'BUY');
      if (!isPositiveFinite(frontBid) || !isPositiveFinite(backAsk)) {
        continue;
      }
      const metrics = evaluateCalendarRollStructure(
        frontOpt,
        backOpt,
        frontExpiryUtcSec,
        backExpSec,
        input,
        delta1Days,
        deltaExDays,
        arHolidays,
        nodes,
        feeSchedule,
      );
      const legsSpec: readonly OptionLegSpec<BymaStrategyOptionQuote>[] = [
        { quote: frontOpt, side: 'SELL', qty: 1 },
        { quote: backOpt, side: 'BUY', qty: 1 },
      ];
      registerCandidate(
        `CALENDAR_${frontOpt.ticker}_${backOpt.ticker}`,
        'BYMA_ARS',
        'CALENDAR_ROLL_2M',
        [
          {
            ticker: frontOpt.ticker,
            side: 'SELL',
            qtyContracts: 1,
            execPrice: frontBid,
            currency: 'ARS',
            settlement: 'T0',
          },
          {
            ticker: backOpt.ticker,
            side: 'BUY',
            qtyContracts: 1,
            execPrice: backAsk,
            currency: 'ARS',
            settlement: 'T0',
          },
        ],
        legsSpec,
        metrics,
      );
    }
  }

  rawCandidates.sort((a, b) => {
    const sDiff = b.candidate.economics.netSharpeProxy - a.candidate.economics.netSharpeProxy;
    if (Math.abs(sDiff) > 1e-12) {
      return sDiff;
    }
    const evDiff =
      b.candidate.economics.expectedValueUnderP - a.candidate.economics.expectedValueUnderP;
    if (Math.abs(evDiff) > 1e-12) {
      return evDiff;
    }
    return a.candidate.id.localeCompare(b.candidate.id);
  });

  const maxCandidates = thresholds?.maxCandidates;
  const sliced =
    maxCandidates !== undefined && maxCandidates > 0
      ? rawCandidates.slice(0, maxCandidates)
      : rawCandidates;

  return {
    timestampUtc: formatIsoUtcFromSec(input.asOfUtcSec),
    status: sliced.length > 0 ? 'OK' : 'NO_DATA',
    marketBenchmarks: {
      caucion1dTnaPct: input.caucion1dTnaPct,
      lecapMatchedTnaPct: input.lecapMatchedTnaPct,
      sofrPct: input.sofrPct,
    },
    rankedStrategies: sliced.map((entry) => entry.candidate),
  };
}
