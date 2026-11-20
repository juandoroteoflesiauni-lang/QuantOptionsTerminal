/**
 * Motor puro de Confluencia Espacial Multi-Capa (< 0.15 ATR), Fuerza Relativa
 * con Bloqueo Causal Pre-Earnings (48h) y Optimizador de Estructuras de Opciones
 * ("Las 3 Maneras de Jugarla" + Percentil Histórico de Costo — Pieza 18, Motores 4 y 10).
 *
 * Garantías de diseño (`AGENTS.md` / `SPEC.md`):
 *  - Funciones 100 % puras: cero red, cero E/S, cero UI y cero mutación de argumentos.
 *  - Estándar temporal único en segundos UTC enteros (`time`, `asOfUtcSec`) sin look-ahead.
 *  - Cero fallbacks silenciosos: ante insumos no calculables (`atr <= 0`, masa de
 *    probabilidad nula, puntas `Bid`/`Ask` no ejecutables o series insuficientes),
 *    devuelve `Number.NaN` y estado explícito `'NO_DATA'`.
 */

import type { OptionContractType } from '../options/types.js';
import {
  DEFAULT_MIN_SPREAD_DEBIT,
  computeMultiLegBidAskPctOfMid,
  isValidButterflyStrikes,
  type LiquiditySemaphore,
} from '../options/verticalSpreads.js';
import { MAX_TIME_SECONDS } from '../sessions.js';
import type { TerminalDataStatus } from './types.js';

export const DEFAULT_CLUSTER_RADIUS_ATR = 0.15;
export const DEFAULT_MIN_DISTINCT_CATEGORIES = 2;
export const DEFAULT_RS_LOOKBACK_BARS = 20;
export const DEFAULT_RS_NEUTRAL_BAND = 0.0025;
export const DEFAULT_EARNINGS_EMBARGO_HOURS = 48;
export const DEFAULT_MAX_SPREAD_RATIO = 0.35;
export const DEFAULT_COST_LOOKBACK_WINDOW = 300;

const CLUSTER_BOUNDARY_EPS = 1e-12;
const BUTTERFLY_SYMMETRY_EPS = 1e-9;
const BREAKEVEN_ROOT_EPS = 1e-12;
const BREAKEVEN_DEDUP_EPS = 1e-9;
const SECONDS_PER_HOUR = 3600;

export type SpatialConfluenceCategory =
  | 'AMT_VOLUME_PROFILE'
  | 'MICROSTRUCTURE_FVG_FOB'
  | 'OPTIONS_DEALER';

export type ExpectedLevelReaction =
  | 'SUPPORT_BULLISH'
  | 'RESISTANCE_BEARISH'
  | 'MAGNET_NEUTRAL';

export interface SpatialLevelInput {
  readonly id?: string;
  readonly name: string;
  readonly category: SpatialConfluenceCategory;
  readonly price: number;
  readonly weight?: number;
  readonly expectedReaction?: ExpectedLevelReaction;
}

export interface DynamicFlowTriggerInput {
  readonly cvdSlopeSign: number;
  readonly optionsDeltaFlowSign: number;
}

export interface DetectSpatialConfluenceInputs {
  readonly spot: number;
  readonly atr: number;
  readonly levels: readonly SpatialLevelInput[];
  readonly clusterRadiusAtr?: number;
  readonly minDistinctCategories?: number;
  readonly trigger?: DynamicFlowTriggerInput;
}

export interface SpatialConfluenceCluster {
  readonly centroidPrice: number;
  readonly bandLow: number;
  readonly bandHigh: number;
  readonly bandWidthAtr: number;
  readonly maxMemberDistanceAtr: number;
  readonly distanceToSpotAtr: number;
  readonly levels: readonly SpatialLevelInput[];
  readonly distinctCategories: readonly SpatialConfluenceCategory[];
  readonly distinctCategoriesCount: number;
  readonly isTripleConfluence: boolean;
  readonly expectedReaction: ExpectedLevelReaction;
  readonly triggerAligned: boolean;
  readonly clusterStrength: number;
}

export interface SpatialConfluenceResult {
  readonly status: TerminalDataStatus;
  readonly spot: number;
  readonly atr: number;
  readonly clusterRadiusAtr: number;
  readonly tolerancePrice: number;
  readonly validLevelsCount: number;
  readonly skippedLevelsCount: number;
  readonly clusters: readonly SpatialConfluenceCluster[];
  readonly tripleConfluenceCount: number;
  readonly strongestClusterCentroid: number;
  readonly strongestClusterStrength: number;
}

export type RelativeStrengthClassification =
  | 'OUTPERFORMING'
  | 'UNDERPERFORMING'
  | 'INLINE'
  | 'NO_DATA';

export type CatalystBlockReason = 'NONE' | 'EARNINGS_JUMP_RISK_48H';

export interface BarClosePoint {
  readonly time: number;
  readonly close: number;
}

export interface EarningsEventInput {
  readonly earningsUtcSec: number;
  readonly announcedAtUtcSec?: number;
}

export interface RelativeStrengthAndCatalystsInputs {
  readonly asOfUtcSec: number;
  readonly assetBars: readonly BarClosePoint[];
  readonly benchmarkBars: readonly BarClosePoint[];
  readonly lookbackBars?: number;
  readonly rsNeutralBand?: number;
  readonly embargoHours?: number;
  readonly nextEarningsUtcSec?: number | null;
  readonly earningsKnownAtUtcSec?: number;
  readonly earningsCalendar?: readonly EarningsEventInput[];
}

export interface RelativeStrengthAndCatalystsResult {
  readonly status: TerminalDataStatus;
  readonly asOfUtcSec: number;
  readonly lookbackBars: number;
  readonly embargoHours: number;
  readonly causalAssetBarCount: number;
  readonly causalBenchmarkBarCount: number;
  readonly excludedFutureAssetBars: number;
  readonly excludedFutureBenchmarkBars: number;
  readonly assetReturn: number;
  readonly benchmarkReturn: number;
  readonly rsSpread: number;
  readonly rsRatioBase: number;
  readonly rsRatioCurrent: number;
  readonly rsRatioChange: number;
  readonly rsClassification: RelativeStrengthClassification;
  readonly hoursToEarnings: number;
  readonly entryBlocked: boolean;
  readonly blockReason: CatalystBlockReason;
}

export type StructureDirection = 'BULLISH' | 'BEARISH';

export type OptionStructureKind =
  | 'LONG_CALL'
  | 'LONG_PUT'
  | 'BULL_CALL_SPREAD'
  | 'BEAR_PUT_SPREAD'
  | 'CALL_RATIO_1X2'
  | 'PUT_RATIO_1X2'
  | 'CALL_BUTTERFLY'
  | 'PUT_BUTTERFLY';

export type StructureLegSide = 'BUY' | 'SELL';

export interface OptimizerOptionContractInput {
  readonly strike: number;
  readonly contractType: OptionContractType;
  readonly bid: number;
  readonly ask: number;
  readonly delta: number;
  readonly iv: number;
}

export interface EvaluatedStructureLeg {
  readonly strike: number;
  readonly contractType: OptionContractType;
  readonly side: StructureLegSide;
  readonly quantity: number;
  readonly bid: number;
  readonly ask: number;
  readonly executionPrice: number;
  readonly grossPremium: number;
  readonly feeAmount: number;
  readonly vatAmount: number;
}

export interface EvaluatedOptionStructure {
  readonly id: string;
  readonly kind: OptionStructureKind;
  readonly label: string;
  readonly direction: StructureDirection;
  readonly legs: readonly EvaluatedStructureLeg[];
  readonly isDefinedRisk: boolean;
  readonly grossDebitOrCredit: number;
  readonly totalFees: number;
  readonly totalVat: number;
  readonly totalFriction: number;
  readonly netDebitOrCredit: number;
  readonly spreadWidth: number;
  readonly costPctOfWidth: number;
  readonly maxLoss: number;
  readonly capitalAtRisk: number;
  readonly maxProfit: number;
  readonly breakevenPrices: readonly number[];
  readonly pop: number;
  readonly expectedValue: number;
  readonly positiveExpectedPayoff: number;
  readonly expectedReturnOnRisk: number;
  readonly convexityScore: number;
  readonly bidAskPctOfMid: number;
  readonly liquiditySemaphore: LiquiditySemaphore;
}

export interface OptimizeOptionStructuresInputs {
  readonly spot: number;
  readonly targetPrice: number;
  readonly direction: StructureDirection;
  readonly dte: number;
  readonly lotSize: number;
  readonly contracts: readonly OptimizerOptionContractInput[];
  readonly terminalPrices: readonly number[];
  readonly empiricalProbs: readonly number[];
  readonly feeRate: number;
  readonly vatRate: number;
  readonly maxSpreadRatio?: number;
  readonly minPerShareDebitOrCredit?: number;
}

export interface OptimizeOptionStructuresResult {
  readonly status: TerminalDataStatus;
  readonly direction: StructureDirection;
  readonly spot: number;
  readonly targetPrice: number;
  readonly dte: number;
  readonly lotSize: number;
  readonly liquidContractsCount: number;
  readonly skippedContractsCount: number;
  readonly candidates: readonly EvaluatedOptionStructure[];
  readonly bestByPop: EvaluatedOptionStructure | null;
  readonly bestByExpectedValue: EvaluatedOptionStructure | null;
  readonly bestByConvexity: EvaluatedOptionStructure | null;
}

export type HistoricalCostRegime =
  | 'CHEAP_HISTORICAL_DEBIT'
  | 'FAIR'
  | 'RICH_HISTORICAL_DEBIT'
  | 'NO_DATA';

export interface StructureCostPercentileInputs {
  readonly currentCostPctOfWidth?: number;
  readonly netDebit?: number;
  readonly spreadWidth?: number;
  readonly historicalCostPctSeries: readonly number[];
  readonly lookbackWindow?: number;
  readonly minObservations?: number;
}

export interface StructureCostPercentileResult {
  readonly status: TerminalDataStatus;
  readonly currentCostPctOfWidth: number;
  readonly percentile: number;
  readonly regime: HistoricalCostRegime;
  readonly observationsUsed: number;
  readonly minCostPct: number;
  readonly maxCostPct: number;
  readonly meanCostPct: number;
}

const CANONICAL_CATEGORIES: readonly SpatialConfluenceCategory[] = [
  'AMT_VOLUME_PROFILE',
  'MICROSTRUCTURE_FVG_FOB',
  'OPTIONS_DEALER',
];

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function assertValidUtcSeconds(time: number, label: string): void {
  if (!Number.isFinite(time) || !Number.isInteger(time) || Math.abs(time) > MAX_TIME_SECONDS) {
    throw new Error(`${label} must be finite integer UTC seconds (got ${String(time)})`);
  }
}

function assertPositiveFinite(value: number, label: string): number {
  if (!isPositiveFinite(value)) {
    throw new Error(`${label} must be a positive finite number (got ${String(value)})`);
  }
  return value;
}

function assertNonNegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite number >= 0 (got ${String(value)})`);
  }
  return value;
}

function assertIntegerInRange(
  value: number,
  label: string,
  minValue: number,
  maxValue?: number,
): number {
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < minValue ||
    (maxValue !== undefined && value > maxValue)
  ) {
    const bounds =
      maxValue !== undefined
        ? `in [${String(minValue)}, ${String(maxValue)}]`
        : `>= ${String(minValue)}`;
    throw new Error(`${label} must be an integer ${bounds} (got ${String(value)})`);
  }
  return value;
}

function signOf(value: number): number {
  if (!Number.isFinite(value)) {
    return Number.NaN;
  }
  if (value > 0) {
    return 1;
  }
  if (value < 0) {
    return -1;
  }
  return 0;
}

function computeWeightedCentroid(levels: readonly SpatialLevelInput[]): number {
  let weightedSum = 0;
  let weightTotal = 0;
  for (const level of levels) {
    const weight = level.weight ?? 1;
    weightedSum += weight * level.price;
    weightTotal += weight;
  }
  return weightTotal > 0 ? weightedSum / weightTotal : Number.NaN;
}

function isTriggerAligned(
  expectedReaction: ExpectedLevelReaction,
  trigger: DynamicFlowTriggerInput | undefined,
): boolean {
  if (trigger === undefined) {
    return false;
  }
  const cvdSign = signOf(trigger.cvdSlopeSign);
  const deltaSign = signOf(trigger.optionsDeltaFlowSign);
  if (!Number.isFinite(cvdSign) || !Number.isFinite(deltaSign)) {
    return false;
  }
  if (expectedReaction === 'SUPPORT_BULLISH') {
    return cvdSign > 0 && deltaSign > 0;
  }
  if (expectedReaction === 'RESISTANCE_BEARISH') {
    return cvdSign < 0 && deltaSign < 0;
  }
  return cvdSign !== 0 && cvdSign === deltaSign;
}

function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * Detecta clusters de confluencia espacial (`<= clusterRadiusAtr * atr`, por defecto
 * `0.15 * atr`) cruzando capas de Volume Profile/AMT, Microestructura (FVG/FOB)
 * y Derivados (Call/Put Wall, Gamma Flip, GEX/Charm Pin).
 */
export function detectSpatialConfluenceClusters(
  inputs: DetectSpatialConfluenceInputs,
): SpatialConfluenceResult {
  const clusterRadiusAtr =
    inputs.clusterRadiusAtr === undefined
      ? DEFAULT_CLUSTER_RADIUS_ATR
      : assertPositiveFinite(inputs.clusterRadiusAtr, 'clusterRadiusAtr');
  const minDistinctCategories =
    inputs.minDistinctCategories === undefined
      ? DEFAULT_MIN_DISTINCT_CATEGORIES
      : assertIntegerInRange(inputs.minDistinctCategories, 'minDistinctCategories', 1, 3);

  if (!isPositiveFinite(inputs.spot) || !isPositiveFinite(inputs.atr)) {
    return {
      status: 'NO_DATA',
      spot: inputs.spot,
      atr: inputs.atr,
      clusterRadiusAtr,
      tolerancePrice: Number.NaN,
      validLevelsCount: 0,
      skippedLevelsCount: inputs.levels.length,
      clusters: [],
      tripleConfluenceCount: 0,
      strongestClusterCentroid: Number.NaN,
      strongestClusterStrength: Number.NaN,
    };
  }

  const validLevels: SpatialLevelInput[] = [];
  for (const level of inputs.levels) {
    const validPrice = isPositiveFinite(level.price);
    const validWeight = level.weight === undefined || isPositiveFinite(level.weight);
    if (validPrice && validWeight) {
      validLevels.push(level);
    }
  }

  const skippedLevelsCount = inputs.levels.length - validLevels.length;
  const tolerancePrice = clusterRadiusAtr * inputs.atr;

  if (validLevels.length === 0) {
    return {
      status: 'NO_DATA',
      spot: inputs.spot,
      atr: inputs.atr,
      clusterRadiusAtr,
      tolerancePrice,
      validLevelsCount: 0,
      skippedLevelsCount,
      clusters: [],
      tripleConfluenceCount: 0,
      strongestClusterCentroid: Number.NaN,
      strongestClusterStrength: Number.NaN,
    };
  }

  const sortedLevels = [...validLevels].sort((a, b) => {
    if (a.price !== b.price) {
      return a.price - b.price;
    }
    const catCmp = compareStrings(a.category, b.category);
    if (catCmp !== 0) {
      return catCmp;
    }
    return compareStrings(a.name, b.name);
  });

  const rawGroups: SpatialLevelInput[][] = [];
  let currentGroup: SpatialLevelInput[] = [];

  for (const level of sortedLevels) {
    if (currentGroup.length === 0) {
      currentGroup = [level];
      continue;
    }
    const trialGroup = [...currentGroup, level];
    const trialCentroid = computeWeightedCentroid(trialGroup);
    const withinRadius = trialGroup.every(
      (member) => Math.abs(member.price - trialCentroid) <= tolerancePrice + CLUSTER_BOUNDARY_EPS,
    );
    if (withinRadius) {
      currentGroup.push(level);
    } else {
      rawGroups.push(currentGroup);
      currentGroup = [level];
    }
  }
  if (currentGroup.length > 0) {
    rawGroups.push(currentGroup);
  }

  const clusters: SpatialConfluenceCluster[] = [];
  for (const group of rawGroups) {
    const categorySet = new Set<SpatialConfluenceCategory>();
    let bandLow = Number.POSITIVE_INFINITY;
    let bandHigh = Number.NEGATIVE_INFINITY;
    for (const member of group) {
      categorySet.add(member.category);
      if (member.price < bandLow) {
        bandLow = member.price;
      }
      if (member.price > bandHigh) {
        bandHigh = member.price;
      }
    }

    const distinctCategories = CANONICAL_CATEGORIES.filter((category) => categorySet.has(category));
    const distinctCategoriesCount = distinctCategories.length;
    if (distinctCategoriesCount < minDistinctCategories) {
      continue;
    }

    const centroidPrice = computeWeightedCentroid(group);
    let maxDeviation = 0;
    for (const member of group) {
      const dev = Math.abs(member.price - centroidPrice);
      if (dev > maxDeviation) {
        maxDeviation = dev;
      }
    }

    const bandWidthAtr = (bandHigh - bandLow) / inputs.atr;
    const maxMemberDistanceAtr = maxDeviation / inputs.atr;
    const distanceToSpotAtr = (centroidPrice - inputs.spot) / inputs.atr;
    const expectedReaction: ExpectedLevelReaction =
      centroidPrice < inputs.spot
        ? 'SUPPORT_BULLISH'
        : centroidPrice > inputs.spot
          ? 'RESISTANCE_BEARISH'
          : 'MAGNET_NEUTRAL';
    const triggerAligned = isTriggerAligned(expectedReaction, inputs.trigger);

    const categoryScore = 60 * (distinctCategoriesCount / 3);
    const tightnessScore = 20 * Math.max(0, 1 - maxMemberDistanceAtr / clusterRadiusAtr);
    const densityScore = 10 * Math.min(1, (group.length - 1) / 3);
    const triggerBonus = triggerAligned ? 10 : 0;
    const clusterStrength = Math.min(
      100,
      Math.max(0, categoryScore + tightnessScore + densityScore + triggerBonus),
    );

    clusters.push({
      centroidPrice,
      bandLow,
      bandHigh,
      bandWidthAtr,
      maxMemberDistanceAtr,
      distanceToSpotAtr,
      levels: group,
      distinctCategories,
      distinctCategoriesCount,
      isTripleConfluence: distinctCategoriesCount === 3,
      expectedReaction,
      triggerAligned,
      clusterStrength,
    });
  }

  clusters.sort((a, b) => {
    if (b.clusterStrength !== a.clusterStrength) {
      return b.clusterStrength - a.clusterStrength;
    }
    const distCmp = Math.abs(a.distanceToSpotAtr) - Math.abs(b.distanceToSpotAtr);
    if (distCmp !== 0) {
      return distCmp;
    }
    return a.centroidPrice - b.centroidPrice;
  });

  let tripleConfluenceCount = 0;
  for (const cluster of clusters) {
    if (cluster.isTripleConfluence) {
      tripleConfluenceCount += 1;
    }
  }

  const strongest = clusters[0];
  if (strongest === undefined) {
    return {
      status: 'NO_DATA',
      spot: inputs.spot,
      atr: inputs.atr,
      clusterRadiusAtr,
      tolerancePrice,
      validLevelsCount: validLevels.length,
      skippedLevelsCount,
      clusters,
      tripleConfluenceCount: 0,
      strongestClusterCentroid: Number.NaN,
      strongestClusterStrength: Number.NaN,
    };
  }

  return {
    status: 'OK',
    spot: inputs.spot,
    atr: inputs.atr,
    clusterRadiusAtr,
    tolerancePrice,
    validLevelsCount: validLevels.length,
    skippedLevelsCount,
    clusters,
    tripleConfluenceCount,
    strongestClusterCentroid: strongest.centroidPrice,
    strongestClusterStrength: strongest.clusterStrength,
  };
}

function filterCausalBars(
  bars: readonly BarClosePoint[],
  asOfUtcSec: number,
  label: string,
): { readonly causal: readonly BarClosePoint[]; readonly excludedFuture: number } {
  const causal: BarClosePoint[] = [];
  let excludedFuture = 0;

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (bar === undefined) {
      continue;
    }
    assertValidUtcSeconds(bar.time, `${label}[${String(i)}].time`);
    if (bar.time > asOfUtcSec) {
      excludedFuture += 1;
      continue;
    }
    if (isPositiveFinite(bar.close)) {
      causal.push(bar);
    }
  }

  causal.sort((a, b) => a.time - b.time);
  return { causal, excludedFuture };
}

/**
 * Evalúa Fuerza Relativa (RS) frente a un benchmark (p. ej. `SPY` o ETF sectorial)
 * usando únicamente barras cerradas `<= asOfUtcSec`, junto con el bloqueo causal
 * de `48h` (configurable) previo a resultados corporativos (Jump Risk).
 */
export function evaluateRelativeStrengthAndCatalysts(
  inputs: RelativeStrengthAndCatalystsInputs,
): RelativeStrengthAndCatalystsResult {
  assertValidUtcSeconds(inputs.asOfUtcSec, 'asOfUtcSec');

  const lookbackBars =
    inputs.lookbackBars === undefined
      ? DEFAULT_RS_LOOKBACK_BARS
      : assertIntegerInRange(inputs.lookbackBars, 'lookbackBars', 1);
  const rsNeutralBand =
    inputs.rsNeutralBand === undefined
      ? DEFAULT_RS_NEUTRAL_BAND
      : assertNonNegativeFinite(inputs.rsNeutralBand, 'rsNeutralBand');
  const embargoHours =
    inputs.embargoHours === undefined
      ? DEFAULT_EARNINGS_EMBARGO_HOURS
      : assertPositiveFinite(inputs.embargoHours, 'embargoHours');

  const assetFiltered = filterCausalBars(inputs.assetBars, inputs.asOfUtcSec, 'assetBars');
  const benchFiltered = filterCausalBars(inputs.benchmarkBars, inputs.asOfUtcSec, 'benchmarkBars');

  const knownEarningsTimes: number[] = [];
  if (inputs.nextEarningsUtcSec !== undefined && inputs.nextEarningsUtcSec !== null) {
    assertValidUtcSeconds(inputs.nextEarningsUtcSec, 'nextEarningsUtcSec');
    if (inputs.earningsKnownAtUtcSec !== undefined) {
      assertValidUtcSeconds(inputs.earningsKnownAtUtcSec, 'earningsKnownAtUtcSec');
    }
    if (
      inputs.earningsKnownAtUtcSec === undefined ||
      inputs.earningsKnownAtUtcSec <= inputs.asOfUtcSec
    ) {
      knownEarningsTimes.push(inputs.nextEarningsUtcSec);
    }
  }

  if (inputs.earningsCalendar !== undefined) {
    for (let i = 0; i < inputs.earningsCalendar.length; i += 1) {
      const event = inputs.earningsCalendar[i];
      if (event === undefined) {
        continue;
      }
      assertValidUtcSeconds(event.earningsUtcSec, `earningsCalendar[${String(i)}].earningsUtcSec`);
      if (event.announcedAtUtcSec !== undefined) {
        assertValidUtcSeconds(
          event.announcedAtUtcSec,
          `earningsCalendar[${String(i)}].announcedAtUtcSec`,
        );
      }
      if (event.announcedAtUtcSec === undefined || event.announcedAtUtcSec <= inputs.asOfUtcSec) {
        knownEarningsTimes.push(event.earningsUtcSec);
      }
    }
  }

  let resolvedEarningsUtcSec: number | null = null;
  let nearestUpcoming = Number.POSITIVE_INFINITY;
  let latestPast = Number.NEGATIVE_INFINITY;
  for (const earningsSec of knownEarningsTimes) {
    if (earningsSec >= inputs.asOfUtcSec) {
      if (earningsSec < nearestUpcoming) {
        nearestUpcoming = earningsSec;
      }
    } else if (earningsSec > latestPast) {
      latestPast = earningsSec;
    }
  }
  if (Number.isFinite(nearestUpcoming)) {
    resolvedEarningsUtcSec = nearestUpcoming;
  } else if (Number.isFinite(latestPast)) {
    resolvedEarningsUtcSec = latestPast;
  }

  const hoursToEarnings =
    resolvedEarningsUtcSec !== null
      ? (resolvedEarningsUtcSec - inputs.asOfUtcSec) / SECONDS_PER_HOUR
      : Number.NaN;
  const entryBlocked =
    Number.isFinite(hoursToEarnings) && hoursToEarnings >= 0 && hoursToEarnings <= embargoHours;
  const blockReason: CatalystBlockReason = entryBlocked ? 'EARNINGS_JUMP_RISK_48H' : 'NONE';

  const causalAssetCount = assetFiltered.causal.length;
  const causalBenchCount = benchFiltered.causal.length;

  if (causalAssetCount < lookbackBars + 1 || causalBenchCount < lookbackBars + 1) {
    return {
      status: 'NO_DATA',
      asOfUtcSec: inputs.asOfUtcSec,
      lookbackBars,
      embargoHours,
      causalAssetBarCount: causalAssetCount,
      causalBenchmarkBarCount: causalBenchCount,
      excludedFutureAssetBars: assetFiltered.excludedFuture,
      excludedFutureBenchmarkBars: benchFiltered.excludedFuture,
      assetReturn: Number.NaN,
      benchmarkReturn: Number.NaN,
      rsSpread: Number.NaN,
      rsRatioBase: Number.NaN,
      rsRatioCurrent: Number.NaN,
      rsRatioChange: Number.NaN,
      rsClassification: 'NO_DATA',
      hoursToEarnings,
      entryBlocked,
      blockReason,
    };
  }

  const assetCurrent = assetFiltered.causal[causalAssetCount - 1];
  const assetBase = assetFiltered.causal[causalAssetCount - 1 - lookbackBars];
  const benchCurrent = benchFiltered.causal[causalBenchCount - 1];
  const benchBase = benchFiltered.causal[causalBenchCount - 1 - lookbackBars];

  if (
    assetCurrent === undefined ||
    assetBase === undefined ||
    benchCurrent === undefined ||
    benchBase === undefined
  ) {
    return {
      status: 'NO_DATA',
      asOfUtcSec: inputs.asOfUtcSec,
      lookbackBars,
      embargoHours,
      causalAssetBarCount: causalAssetCount,
      causalBenchmarkBarCount: causalBenchCount,
      excludedFutureAssetBars: assetFiltered.excludedFuture,
      excludedFutureBenchmarkBars: benchFiltered.excludedFuture,
      assetReturn: Number.NaN,
      benchmarkReturn: Number.NaN,
      rsSpread: Number.NaN,
      rsRatioBase: Number.NaN,
      rsRatioCurrent: Number.NaN,
      rsRatioChange: Number.NaN,
      rsClassification: 'NO_DATA',
      hoursToEarnings,
      entryBlocked,
      blockReason,
    };
  }

  const assetReturn = assetCurrent.close / assetBase.close - 1;
  const benchmarkReturn = benchCurrent.close / benchBase.close - 1;
  const rsSpread = assetReturn - benchmarkReturn;
  const rsRatioBase = assetBase.close / benchBase.close;
  const rsRatioCurrent = assetCurrent.close / benchCurrent.close;
  const rsRatioChange = rsRatioCurrent / rsRatioBase - 1;

  let rsClassification: RelativeStrengthClassification = 'INLINE';
  if (rsSpread > rsNeutralBand) {
    rsClassification = 'OUTPERFORMING';
  } else if (rsSpread < -rsNeutralBand) {
    rsClassification = 'UNDERPERFORMING';
  }

  return {
    status: 'OK',
    asOfUtcSec: inputs.asOfUtcSec,
    lookbackBars,
    embargoHours,
    causalAssetBarCount: causalAssetCount,
    causalBenchmarkBarCount: causalBenchCount,
    excludedFutureAssetBars: assetFiltered.excludedFuture,
    excludedFutureBenchmarkBars: benchFiltered.excludedFuture,
    assetReturn,
    benchmarkReturn,
    rsSpread,
    rsRatioBase,
    rsRatioCurrent,
    rsRatioChange,
    rsClassification,
    hoursToEarnings,
    entryBlocked,
    blockReason,
  };
}

interface RawLegSpec {
  readonly contract: OptimizerOptionContractInput;
  readonly side: StructureLegSide;
  readonly quantity: number;
}

interface CandidateBlueprint {
  readonly id: string;
  readonly kind: OptionStructureKind;
  readonly label: string;
  readonly spreadWidth: number;
  readonly legs: readonly RawLegSpec[];
  readonly requireNetDebit: boolean;
}

function buildNoDataOptimizerResult(
  inputs: OptimizeOptionStructuresInputs,
  liquidContractsCount: number,
  skippedContractsCount: number,
): OptimizeOptionStructuresResult {
  return {
    status: 'NO_DATA',
    direction: inputs.direction,
    spot: inputs.spot,
    targetPrice: inputs.targetPrice,
    dte: inputs.dte,
    lotSize: inputs.lotSize,
    liquidContractsCount,
    skippedContractsCount,
    candidates: [],
    bestByPop: null,
    bestByExpectedValue: null,
    bestByConvexity: null,
  };
}

function normalizeEmpiricalDistribution(
  terminalPrices: readonly number[],
  empiricalProbs: readonly number[],
): readonly number[] | null {
  if (terminalPrices.length < 2 || terminalPrices.length !== empiricalProbs.length) {
    return null;
  }

  let prevPrice = Number.NEGATIVE_INFINITY;
  let probSum = 0;

  for (let i = 0; i < terminalPrices.length; i += 1) {
    const price = terminalPrices[i];
    const prob = empiricalProbs[i];
    if (
      price === undefined ||
      prob === undefined ||
      !Number.isFinite(price) ||
      price < 0 ||
      price <= prevPrice ||
      !Number.isFinite(prob) ||
      prob < 0
    ) {
      return null;
    }
    prevPrice = price;
    probSum += prob;
  }

  if (!isPositiveFinite(probSum)) {
    return null;
  }

  return empiricalProbs.map((p) => p / probSum);
}

function filterLiquidDirectionalContracts(
  contracts: readonly OptimizerOptionContractInput[],
  targetType: OptionContractType,
  maxSpreadRatio: number,
): readonly OptimizerOptionContractInput[] {
  const bestByStrike = new Map<
    number,
    { readonly contract: OptimizerOptionContractInput; readonly spreadRatio: number }
  >();

  for (const contract of contracts) {
    if (contract.contractType !== targetType) {
      continue;
    }
    if (
      !isPositiveFinite(contract.strike) ||
      !isPositiveFinite(contract.bid) ||
      !Number.isFinite(contract.ask) ||
      contract.ask < contract.bid ||
      !Number.isFinite(contract.delta) ||
      !isPositiveFinite(contract.iv)
    ) {
      continue;
    }
    const mid = 0.5 * (contract.bid + contract.ask);
    if (!isPositiveFinite(mid)) {
      continue;
    }
    const spreadRatio = (contract.ask - contract.bid) / mid;
    if (spreadRatio > maxSpreadRatio + CLUSTER_BOUNDARY_EPS) {
      continue;
    }

    const existing = bestByStrike.get(contract.strike);
    if (existing === undefined || spreadRatio < existing.spreadRatio) {
      bestByStrike.set(contract.strike, { contract, spreadRatio });
    }
  }

  return Array.from(bestByStrike.values(), (entry) => entry.contract).sort(
    (a, b) => a.strike - b.strike,
  );
}

function intrinsicPerShare(
  spotAtExpiry: number,
  legs: readonly EvaluatedStructureLeg[],
): number {
  let total = 0;
  for (const leg of legs) {
    const sign = leg.side === 'BUY' ? 1 : -1;
    const pay =
      leg.contractType === 'call'
        ? Math.max(spotAtExpiry - leg.strike, 0)
        : Math.max(leg.strike - spotAtExpiry, 0);
    total += sign * leg.quantity * pay;
  }
  return total;
}

function appendUniqueBreakeven(roots: number[], candidate: number): void {
  if (!Number.isFinite(candidate) || candidate <= BREAKEVEN_ROOT_EPS) {
    return;
  }
  for (const existing of roots) {
    if (Math.abs(existing - candidate) <= BREAKEVEN_DEDUP_EPS) {
      return;
    }
  }
  roots.push(candidate);
}

function computePayoffExtremesAndBreakevens(
  legs: readonly EvaluatedStructureLeg[],
  lotSize: number,
  netDebitOrCredit: number,
  isDefinedRisk: boolean,
  netCallLots: number,
): {
  readonly maxLoss: number;
  readonly maxProfit: number;
  readonly breakevenPrices: readonly number[];
} {
  const strikeSet = new Set<number>();
  for (const leg of legs) {
    strikeSet.add(leg.strike);
  }
  const sortedStrikes = Array.from(strikeSet).sort((a, b) => a - b);
  const vertices = [0, ...sortedStrikes];

  const evalNetPayoff = (s: number): number =>
    lotSize * intrinsicPerShare(s, legs) - netDebitOrCredit;

  let minVertexPayoff = Number.POSITIVE_INFINITY;
  let maxVertexPayoff = Number.NEGATIVE_INFINITY;
  for (const vertex of vertices) {
    const val = evalNetPayoff(vertex);
    if (val < minVertexPayoff) {
      minVertexPayoff = val;
    }
    if (val > maxVertexPayoff) {
      maxVertexPayoff = val;
    }
  }

  const maxLoss = isDefinedRisk ? Math.max(0, -minVertexPayoff) : Number.POSITIVE_INFINITY;
  const infSlope = lotSize * netCallLots;
  const maxProfit = infSlope > 0 ? Number.POSITIVE_INFINITY : maxVertexPayoff;

  const breakevens: number[] = [];
  for (let i = 0; i < vertices.length - 1; i += 1) {
    const a = vertices[i];
    const b = vertices[i + 1];
    if (a === undefined || b === undefined || b <= a) {
      continue;
    }
    const va = evalNetPayoff(a);
    const vb = evalNetPayoff(b);
    if (va === vb) {
      continue;
    }
    if ((va <= 0 && vb >= 0) || (va >= 0 && vb <= 0)) {
      const rawRoot = a + ((-va) * (b - a)) / (vb - va);
      const clampedRoot = Math.max(a, Math.min(b, rawRoot));
      appendUniqueBreakeven(breakevens, clampedRoot);
    }
  }

  const lastStrike = sortedStrikes[sortedStrikes.length - 1];
  if (lastStrike !== undefined && Math.abs(infSlope) > BREAKEVEN_ROOT_EPS) {
    const vLast = evalNetPayoff(lastStrike);
    const rayRoot = lastStrike - vLast / infSlope;
    if (rayRoot >= lastStrike - BREAKEVEN_ROOT_EPS) {
      appendUniqueBreakeven(breakevens, Math.max(lastStrike, rayRoot));
    }
  }

  breakevens.sort((a, b) => a - b);
  return { maxLoss, maxProfit, breakevenPrices: breakevens };
}

function evaluateCandidateBlueprint(
  blueprint: CandidateBlueprint,
  direction: StructureDirection,
  lotSize: number,
  feeRate: number,
  vatRate: number,
  terminalPrices: readonly number[],
  normalizedProbs: readonly number[],
  minPerShareDebitOrCredit = DEFAULT_MIN_SPREAD_DEBIT,
): EvaluatedOptionStructure | null {
  const evaluatedLegs: EvaluatedStructureLeg[] = [];
  let signedGrossCash = 0;
  let totalFees = 0;
  let totalVat = 0;
  let signedNetCash = 0;
  let netCallLots = 0;
  let netPutLots = 0;

  for (const rawLeg of blueprint.legs) {
    const executionPrice = rawLeg.side === 'BUY' ? rawLeg.contract.ask : rawLeg.contract.bid;
    if (!isPositiveFinite(executionPrice)) {
      return null;
    }
    const grossPremium = rawLeg.quantity * lotSize * executionPrice;
    const feeAmount = grossPremium * feeRate;
    const vatAmount = feeAmount * vatRate;
    const cashDirection = rawLeg.side === 'BUY' ? -1 : 1;
    const positionSign = rawLeg.side === 'BUY' ? 1 : -1;

    signedGrossCash += cashDirection * grossPremium;
    totalFees += feeAmount;
    totalVat += vatAmount;
    signedNetCash += cashDirection * grossPremium - feeAmount - vatAmount;

    if (rawLeg.contract.contractType === 'call') {
      netCallLots += positionSign * rawLeg.quantity;
    } else {
      netPutLots += positionSign * rawLeg.quantity;
    }

    evaluatedLegs.push({
      strike: rawLeg.contract.strike,
      contractType: rawLeg.contract.contractType,
      side: rawLeg.side,
      quantity: rawLeg.quantity,
      bid: rawLeg.contract.bid,
      ask: rawLeg.contract.ask,
      executionPrice,
      grossPremium,
      feeAmount,
      vatAmount,
    });
  }

  const grossDebitOrCredit = -signedGrossCash;
  const totalFriction = totalFees + totalVat;
  const netDebitOrCredit = -signedNetCash;

  if (blueprint.requireNetDebit && netDebitOrCredit <= 0) {
    return null;
  }

  // Pieza 45: Piso de débito/crédito por acción (>= 0.10) para evitar spreads profundos OTM de $0.01 con R/B artificial
  if (Math.abs(grossDebitOrCredit) < minPerShareDebitOrCredit * lotSize - 1e-12) {
    return null;
  }

  const liqMetrics = computeMultiLegBidAskPctOfMid(evaluatedLegs);
  if (!liqMetrics.allLegsHavePositiveBid) {
    return null;
  }

  const costPctOfWidth =
    Number.isFinite(blueprint.spreadWidth) && blueprint.spreadWidth > 0 && netDebitOrCredit > 0
      ? netDebitOrCredit / blueprint.spreadWidth
      : Number.NaN;

  const isDefinedRisk = netCallLots >= 0 && netPutLots >= 0;
  const extremes = computePayoffExtremesAndBreakevens(
    evaluatedLegs,
    lotSize,
    netDebitOrCredit,
    isDefinedRisk,
    netCallLots,
  );

  let pop = 0;
  let expectedValue = 0;
  let positiveExpectedPayoff = 0;
  let maxGridLoss = 0;

  for (let j = 0; j < terminalPrices.length; j += 1) {
    const price = terminalPrices[j];
    const prob = normalizedProbs[j];
    if (price === undefined || prob === undefined) {
      continue;
    }
    const netPayoff = lotSize * intrinsicPerShare(price, evaluatedLegs) - netDebitOrCredit;
    expectedValue += prob * netPayoff;
    if (netPayoff > 0) {
      pop += prob;
      positiveExpectedPayoff += prob * netPayoff;
    }
    if (-netPayoff > maxGridLoss) {
      maxGridLoss = -netPayoff;
    }
  }

  const capitalAtRisk = Math.max(Math.max(0, netDebitOrCredit), maxGridLoss);
  const expectedReturnOnRisk =
    Number.isFinite(extremes.maxLoss) && extremes.maxLoss > 0
      ? expectedValue / extremes.maxLoss
      : Number.NaN;

  const effectiveRiskDenom = Number.isFinite(extremes.maxLoss)
    ? Math.max(extremes.maxLoss, capitalAtRisk)
    : capitalAtRisk;
  const convexityScore =
    effectiveRiskDenom > 0 ? positiveExpectedPayoff / effectiveRiskDenom : Number.NaN;

  return {
    id: blueprint.id,
    kind: blueprint.kind,
    label: blueprint.label,
    direction,
    legs: evaluatedLegs,
    isDefinedRisk,
    grossDebitOrCredit,
    totalFees,
    totalVat,
    totalFriction,
    netDebitOrCredit,
    spreadWidth: blueprint.spreadWidth,
    costPctOfWidth,
    maxLoss: extremes.maxLoss,
    capitalAtRisk,
    maxProfit: extremes.maxProfit,
    breakevenPrices: extremes.breakevenPrices,
    pop,
    expectedValue,
    positiveExpectedPayoff,
    expectedReturnOnRisk,
    convexityScore,
    bidAskPctOfMid: liqMetrics.bidAskPctOfMid,
    liquiditySemaphore: liqMetrics.liquiditySemaphore,
  };
}

function generateDirectionalBlueprints(
  liquidContracts: readonly OptimizerOptionContractInput[],
  spot: number,
  targetPrice: number,
  direction: StructureDirection,
  lotSize: number,
): readonly CandidateBlueprint[] {
  const firstContract = liquidContracts[0];
  const lastContract = liquidContracts[liquidContracts.length - 1];
  if (firstContract === undefined || lastContract === undefined) {
    return [];
  }

  let atmContract = firstContract;
  let bestAtmDist = Math.abs(atmContract.strike - spot);
  for (let i = 1; i < liquidContracts.length; i += 1) {
    const candidate = liquidContracts[i];
    if (candidate === undefined) {
      continue;
    }
    const dist = Math.abs(candidate.strike - spot);
    if (dist < bestAtmDist) {
      bestAtmDist = dist;
      atmContract = candidate;
    }
  }

  const blueprints: CandidateBlueprint[] = [];

  if (direction === 'BULLISH') {
    const kMin = Math.min(spot, atmContract.strike);
    let kTargetUpper = lastContract.strike;
    for (const contract of liquidContracts) {
      if (contract.strike >= targetPrice) {
        kTargetUpper = contract.strike;
        break;
      }
    }

    for (const c1 of liquidContracts) {
      if (c1.strike >= kMin && c1.strike <= kTargetUpper) {
        blueprints.push({
          id: `LONG_CALL_${String(c1.strike)}`,
          kind: 'LONG_CALL',
          label: `Long Call ${String(c1.strike)}`,
          spreadWidth: Number.NaN,
          legs: [{ contract: c1, side: 'BUY', quantity: 1 }],
          requireNetDebit: true,
        });
      }
    }

    for (let i = 0; i < liquidContracts.length; i += 1) {
      const c1 = liquidContracts[i];
      if (c1 === undefined || c1.strike < kMin || c1.strike > kTargetUpper) {
        continue;
      }
      for (let j = i + 1; j < liquidContracts.length; j += 1) {
        const c2 = liquidContracts[j];
        if (c2 === undefined || c2.strike > kTargetUpper) {
          continue;
        }
        const width = (c2.strike - c1.strike) * lotSize;
        blueprints.push({
          id: `BULL_CALL_SPREAD_${String(c1.strike)}_${String(c2.strike)}`,
          kind: 'BULL_CALL_SPREAD',
          label: `Bull Call Spread ${String(c1.strike)}/${String(c2.strike)}`,
          spreadWidth: width,
          legs: [
            { contract: c1, side: 'BUY', quantity: 1 },
            { contract: c2, side: 'SELL', quantity: 1 },
          ],
          requireNetDebit: true,
        });
        blueprints.push({
          id: `CALL_RATIO_1X2_${String(c1.strike)}_${String(c2.strike)}`,
          kind: 'CALL_RATIO_1X2',
          label: `Call Ratio 1x2 ${String(c1.strike)}/${String(c2.strike)}`,
          spreadWidth: width,
          legs: [
            { contract: c1, side: 'BUY', quantity: 1 },
            { contract: c2, side: 'SELL', quantity: 2 },
          ],
          requireNetDebit: false,
        });
      }
    }

    for (let i = 0; i < liquidContracts.length; i += 1) {
      const c1 = liquidContracts[i];
      if (c1 === undefined) {
        continue;
      }
      for (let j = i + 1; j < liquidContracts.length; j += 1) {
        const c2 = liquidContracts[j];
        if (c2 === undefined || c2.strike < kMin || c2.strike > kTargetUpper) {
          continue;
        }
        const leftWing = c2.strike - c1.strike;
        for (let m = j + 1; m < liquidContracts.length; m += 1) {
          const c3 = liquidContracts[m];
          if (c3 === undefined) {
            continue;
          }
          const rightWing = c3.strike - c2.strike;
          if (
            isValidButterflyStrikes(c1.strike, c2.strike, c3.strike, false) &&
            Math.abs(leftWing - rightWing) <= BUTTERFLY_SYMMETRY_EPS
          ) {
            blueprints.push({
              id: `CALL_BUTTERFLY_${String(c1.strike)}_${String(c2.strike)}_${String(c3.strike)}`,
              kind: 'CALL_BUTTERFLY',
              label: `Call Butterfly ${String(c1.strike)}/${String(c2.strike)}/${String(c3.strike)}`,
              spreadWidth: leftWing * lotSize,
              legs: [
                { contract: c1, side: 'BUY', quantity: 1 },
                { contract: c2, side: 'SELL', quantity: 2 },
                { contract: c3, side: 'BUY', quantity: 1 },
              ],
              requireNetDebit: true,
            });
          }
        }
      }
    }
  } else {
    const kMax = Math.max(spot, atmContract.strike);
    let kTargetLower = firstContract.strike;
    for (let i = liquidContracts.length - 1; i >= 0; i -= 1) {
      const contract = liquidContracts[i];
      if (contract !== undefined && contract.strike <= targetPrice) {
        kTargetLower = contract.strike;
        break;
      }
    }

    for (const c1 of liquidContracts) {
      if (c1.strike >= kTargetLower && c1.strike <= kMax) {
        blueprints.push({
          id: `LONG_PUT_${String(c1.strike)}`,
          kind: 'LONG_PUT',
          label: `Long Put ${String(c1.strike)}`,
          spreadWidth: Number.NaN,
          legs: [{ contract: c1, side: 'BUY', quantity: 1 }],
          requireNetDebit: true,
        });
      }
    }

    for (let i = 0; i < liquidContracts.length; i += 1) {
      const c2 = liquidContracts[i];
      if (c2 === undefined || c2.strike < kTargetLower) {
        continue;
      }
      for (let j = i + 1; j < liquidContracts.length; j += 1) {
        const c1 = liquidContracts[j];
        if (c1 === undefined || c1.strike > kMax) {
          continue;
        }
        const width = (c1.strike - c2.strike) * lotSize;
        blueprints.push({
          id: `BEAR_PUT_SPREAD_${String(c1.strike)}_${String(c2.strike)}`,
          kind: 'BEAR_PUT_SPREAD',
          label: `Bear Put Spread ${String(c1.strike)}/${String(c2.strike)}`,
          spreadWidth: width,
          legs: [
            { contract: c1, side: 'BUY', quantity: 1 },
            { contract: c2, side: 'SELL', quantity: 1 },
          ],
          requireNetDebit: true,
        });
        blueprints.push({
          id: `PUT_RATIO_1X2_${String(c1.strike)}_${String(c2.strike)}`,
          kind: 'PUT_RATIO_1X2',
          label: `Put Ratio 1x2 ${String(c1.strike)}/${String(c2.strike)}`,
          spreadWidth: width,
          legs: [
            { contract: c1, side: 'BUY', quantity: 1 },
            { contract: c2, side: 'SELL', quantity: 2 },
          ],
          requireNetDebit: false,
        });
      }
    }

    for (let i = 0; i < liquidContracts.length; i += 1) {
      const c1 = liquidContracts[i];
      if (c1 === undefined) {
        continue;
      }
      for (let j = i + 1; j < liquidContracts.length; j += 1) {
        const c2 = liquidContracts[j];
        if (c2 === undefined || c2.strike < kTargetLower || c2.strike > kMax) {
          continue;
        }
        const leftWing = c2.strike - c1.strike;
        for (let m = j + 1; m < liquidContracts.length; m += 1) {
          const c3 = liquidContracts[m];
          if (c3 === undefined) {
            continue;
          }
          const rightWing = c3.strike - c2.strike;
          if (
            isValidButterflyStrikes(c1.strike, c2.strike, c3.strike, false) &&
            Math.abs(leftWing - rightWing) <= BUTTERFLY_SYMMETRY_EPS
          ) {
            blueprints.push({
              id: `PUT_BUTTERFLY_${String(c1.strike)}_${String(c2.strike)}_${String(c3.strike)}`,
              kind: 'PUT_BUTTERFLY',
              label: `Put Butterfly ${String(c1.strike)}/${String(c2.strike)}/${String(c3.strike)}`,
              spreadWidth: leftWing * lotSize,
              legs: [
                { contract: c1, side: 'BUY', quantity: 1 },
                { contract: c2, side: 'SELL', quantity: 2 },
                { contract: c3, side: 'BUY', quantity: 1 },
              ],
              requireNetDebit: true,
            });
          }
        }
      }
    }
  }

  return blueprints;
}

function scoreOrNegInf(value: number): number {
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function pickBestCandidate(
  pool: readonly EvaluatedOptionStructure[],
  primary: (s: EvaluatedOptionStructure) => number,
  secondary: (s: EvaluatedOptionStructure) => number,
  tertiary: (s: EvaluatedOptionStructure) => number,
): EvaluatedOptionStructure | null {
  const first = pool[0];
  if (first === undefined) {
    return null;
  }
  const sorted = [...pool].sort((a, b) => {
    const pDiff = scoreOrNegInf(primary(b)) - scoreOrNegInf(primary(a));
    if (pDiff !== 0) {
      return pDiff;
    }
    const sDiff = scoreOrNegInf(secondary(b)) - scoreOrNegInf(secondary(a));
    if (sDiff !== 0) {
      return sDiff;
    }
    const tDiff = scoreOrNegInf(tertiary(b)) - scoreOrNegInf(tertiary(a));
    if (tDiff !== 0) {
      return tDiff;
    }
    return compareStrings(a.id, b.id);
  });
  return sorted[0] ?? null;
}

/**
 * Selector Automático de Estructuras ("Las 3 Maneras de Jugarla"): evalúa
 * combinaciones líquidas (`Single Long`, `Vertical Spread`, `Ratio 1x2`, `Butterfly`)
 * descontando puntas `Bid`/`Ask` reales, aranceles/derechos e IVA configurable, e integra
 * sobre la distribución empírica `P` para rankear por `PoP`, `+EV` y `Convexidad`.
 */
export function optimizeOptionStructures(
  inputs: OptimizeOptionStructuresInputs,
): OptimizeOptionStructuresResult {
  const maxSpreadRatio =
    inputs.maxSpreadRatio === undefined
      ? DEFAULT_MAX_SPREAD_RATIO
      : assertNonNegativeFinite(inputs.maxSpreadRatio, 'maxSpreadRatio');

  const directionalValid =
    inputs.direction === 'BULLISH'
      ? inputs.targetPrice > inputs.spot
      : inputs.targetPrice < inputs.spot;

  if (
    !isPositiveFinite(inputs.spot) ||
    !isPositiveFinite(inputs.targetPrice) ||
    !isPositiveFinite(inputs.dte) ||
    !isPositiveFinite(inputs.lotSize) ||
    !Number.isFinite(inputs.feeRate) ||
    inputs.feeRate < 0 ||
    !Number.isFinite(inputs.vatRate) ||
    inputs.vatRate < 0 ||
    !directionalValid
  ) {
    return buildNoDataOptimizerResult(inputs, 0, inputs.contracts.length);
  }

  const normalizedProbs = normalizeEmpiricalDistribution(
    inputs.terminalPrices,
    inputs.empiricalProbs,
  );
  if (normalizedProbs === null) {
    return buildNoDataOptimizerResult(inputs, 0, inputs.contracts.length);
  }

  const targetType: OptionContractType = inputs.direction === 'BULLISH' ? 'call' : 'put';
  const liquidContracts = filterLiquidDirectionalContracts(
    inputs.contracts,
    targetType,
    maxSpreadRatio,
  );
  const skippedContractsCount = inputs.contracts.length - liquidContracts.length;

  if (liquidContracts.length === 0) {
    return buildNoDataOptimizerResult(inputs, 0, skippedContractsCount);
  }

  const blueprints = generateDirectionalBlueprints(
    liquidContracts,
    inputs.spot,
    inputs.targetPrice,
    inputs.direction,
    inputs.lotSize,
  );

  const minPerShareDebitOrCredit =
    inputs.minPerShareDebitOrCredit === undefined
      ? DEFAULT_MIN_SPREAD_DEBIT
      : assertNonNegativeFinite(inputs.minPerShareDebitOrCredit, 'minPerShareDebitOrCredit');

  const candidates: EvaluatedOptionStructure[] = [];
  for (const blueprint of blueprints) {
    const evaluated = evaluateCandidateBlueprint(
      blueprint,
      inputs.direction,
      inputs.lotSize,
      inputs.feeRate,
      inputs.vatRate,
      inputs.terminalPrices,
      normalizedProbs,
      minPerShareDebitOrCredit,
    );
    if (evaluated !== null) {
      candidates.push(evaluated);
    }
  }

  candidates.sort((a, b) => {
    if (b.expectedValue !== a.expectedValue) {
      return b.expectedValue - a.expectedValue;
    }
    if (b.pop !== a.pop) {
      return b.pop - a.pop;
    }
    return compareStrings(a.id, b.id);
  });

  if (candidates.length === 0) {
    return buildNoDataOptimizerResult(inputs, liquidContracts.length, skippedContractsCount);
  }

  const bestByPop = pickBestCandidate(
    candidates,
    (s) => s.pop,
    (s) => s.expectedValue,
    (s) => s.convexityScore,
  );

  const evPoolWithoutPop =
    bestByPop !== null ? candidates.filter((c) => c.id !== bestByPop.id) : candidates;
  const bestByExpectedValue = pickBestCandidate(
    evPoolWithoutPop.length > 0 ? evPoolWithoutPop : candidates,
    (s) => s.expectedValue,
    (s) => s.pop,
    (s) => s.convexityScore,
  );

  const definedRiskCandidates = candidates.filter(
    (c) => Number.isFinite(c.maxLoss) && Number.isFinite(c.convexityScore),
  );
  const convexityFiltered = definedRiskCandidates.filter(
    (c) => c.id !== bestByPop?.id && c.id !== bestByExpectedValue?.id,
  );
  const bestByConvexity = pickBestCandidate(
    convexityFiltered.length > 0 ? convexityFiltered : definedRiskCandidates,
    (s) => s.convexityScore,
    (s) => s.expectedValue,
    (s) => s.pop,
  );

  return {
    status: 'OK',
    direction: inputs.direction,
    spot: inputs.spot,
    targetPrice: inputs.targetPrice,
    dte: inputs.dte,
    lotSize: inputs.lotSize,
    liquidContractsCount: liquidContracts.length,
    skippedContractsCount,
    candidates,
    bestByPop,
    bestByExpectedValue,
    bestByConvexity,
  };
}

/**
 * Calcula el percentil histórico empírico del costo normalizado de una estructura
 * (`netDebit / spreadWidth`) sobre la ventana histórica (por defecto `300` ruedas).
 */
export function computeStructureCostPercentile(
  inputs: StructureCostPercentileInputs,
): StructureCostPercentileResult {
  const lookbackWindow =
    inputs.lookbackWindow === undefined
      ? DEFAULT_COST_LOOKBACK_WINDOW
      : assertIntegerInRange(inputs.lookbackWindow, 'lookbackWindow', 1);
  const minObservations =
    inputs.minObservations === undefined
      ? 1
      : assertIntegerInRange(inputs.minObservations, 'minObservations', 1);

  let currentCostPctOfWidth = Number.NaN;
  if (inputs.currentCostPctOfWidth !== undefined) {
    currentCostPctOfWidth = isPositiveFinite(inputs.currentCostPctOfWidth)
      ? inputs.currentCostPctOfWidth
      : Number.NaN;
  } else if (
    inputs.netDebit !== undefined &&
    inputs.spreadWidth !== undefined &&
    isPositiveFinite(inputs.netDebit) &&
    isPositiveFinite(inputs.spreadWidth)
  ) {
    currentCostPctOfWidth = inputs.netDebit / inputs.spreadWidth;
  }

  if (!isPositiveFinite(currentCostPctOfWidth)) {
    return {
      status: 'NO_DATA',
      currentCostPctOfWidth: Number.NaN,
      percentile: Number.NaN,
      regime: 'NO_DATA',
      observationsUsed: 0,
      minCostPct: Number.NaN,
      maxCostPct: Number.NaN,
      meanCostPct: Number.NaN,
    };
  }

  const validHistory: number[] = [];
  for (const val of inputs.historicalCostPctSeries) {
    if (isPositiveFinite(val)) {
      validHistory.push(val);
    }
  }

  const windowSeries = validHistory.slice(-lookbackWindow);
  const observationsUsed = windowSeries.length;
  if (observationsUsed < minObservations) {
    return {
      status: 'NO_DATA',
      currentCostPctOfWidth,
      percentile: Number.NaN,
      regime: 'NO_DATA',
      observationsUsed,
      minCostPct: Number.NaN,
      maxCostPct: Number.NaN,
      meanCostPct: Number.NaN,
    };
  }

  let leCount = 0;
  let minCostPct = Number.POSITIVE_INFINITY;
  let maxCostPct = Number.NEGATIVE_INFINITY;
  let sumCostPct = 0;

  for (const h of windowSeries) {
    if (h <= currentCostPctOfWidth) {
      leCount += 1;
    }
    if (h < minCostPct) {
      minCostPct = h;
    }
    if (h > maxCostPct) {
      maxCostPct = h;
    }
    sumCostPct += h;
  }

  const percentile = (leCount / observationsUsed) * 100;
  const meanCostPct = sumCostPct / observationsUsed;
  const regime: HistoricalCostRegime =
    percentile <= 25
      ? 'CHEAP_HISTORICAL_DEBIT'
      : percentile >= 75
        ? 'RICH_HISTORICAL_DEBIT'
        : 'FAIR';

  return {
    status: 'OK',
    currentCostPctOfWidth,
    percentile,
    regime,
    observationsUsed,
    minCostPct,
    maxCostPct,
    meanCostPct,
  };
}
