/**
 * Motor 6 — Márgenes BYMA Clearing 2026, Microestructura Asíncrona L1–L2
 * y Riesgo de Cola Jump-Diffusion / Kelly-CVaR (Pieza 25).
 *
 * Funciones 100 % puras: cero red, cero E/S, cero UI y cero mutación de argumentos.
 * Cumple Zero Silent Fallbacks: entradas faltantes o inválidas retornan `NaN` / `'NO_DATA'`.
 */

import { priceAmericanBjerksund2002 } from '../options/american.js';
import type { OptionContractType } from '../options/types.js';
import { invNormCdf } from './dualDensity.js';
import {
  clamp,
  computeExpiration1530ArtUtcSec,
  DAYS_PER_YEAR,
  getBuenosAiresParts,
  GGAL_ADR_RATIO,
  GGAL_BYMA_LOT_SIZE,
  interpolateContinuousRate,
  isPositiveFinite,
  isValidUtcSec,
  type ContinuousRateCurvePoint,
  type DiscreteOrdinaryDividend,
  type OrderSide,
} from './types.js';
import {
  computeBymaOptionEvalParams,
  priceBymaAmericanBs02,
  type BymaOptionEvalParams,
} from './volTriangle.js';
import {
  BYMA_EQUITY_PPT_DM_RATE_WITH_IVA,
  BYMA_EXERCISE_DM_RATE_WITH_IVA,
  BYMA_OPTION_PREMIUM_DM_RATE_WITH_IVA,
} from './types.js';

export const OPRA_CONTRACT_SHARES = 100;
export const OVERNIGHT_HORIZON_HOURS = 18;
export const OVERNIGHT_HORIZON_YEARS = OVERNIGHT_HORIZON_HOURS / (24 * DAYS_PER_YEAR);

export const DEFAULT_CCP_SPOT_SHOCKS: readonly number[] = [-0.25, -0.15, 0, 0.15, 0.25];
export const DEFAULT_CCP_VOL_SHOCKS: readonly number[] = [-0.10, 0, 0.10];
export const MIN_CCP_STRESS_VOL = 0.05;
export const DEFAULT_LIQUID_BUFFER_RATE = 0.10;
export const DEFAULT_WWR_SURCHARGE_RATE = 0.15;
export const DEFAULT_CROSS_COLLATERAL_OFFSET_RATIO = 0.10;
export const CIRCULAR_3588_WINDOW_MINUTES = 60;
export const CIRCULAR_3588_ATM_BAND_PCT = 0.005;

export const DEFAULT_GATE_MAX_AGE_SEC = 30;
export const DEFAULT_GATE_MAX_SPREAD_PCT = 0.04;
export const DEFAULT_GATE_MIN_L1_DEPTH_LOTS = 5;
export const DEFAULT_ORDER_HORIZON_SEC = 60;
export const DEFAULT_HAYASHI_LAG_GRID_SEC: readonly number[] = [
  -15, -10, -5, -2, -1, 0, 1, 2, 5, 10, 15,
];

export const DEFAULT_KELLY_FRACTION = 0.25;
export const DEFAULT_NO_RUIN_CAPITAL_FACTOR = 0.95;
export const DEFAULT_CVAR_CONFIDENCE_ALPHA = 0.01;
export const DEFAULT_MAX_CVAR_99_PCT = 0.15;
export const DEFAULT_MAX_DRAWDOWN_PCT = 0.20;
export const DEFAULT_SQRT_IMPACT_COEF = 0.50;
export const DEFAULT_MAX_IMPACT_RATIO = 0.015;
export const DEFAULT_SQRT_IMPACT_EXPONENT = 0.60;

export type BymaClearingStrategyKind =
  | 'UNCOVERED_SHORT'
  | 'VERTICAL_DEBIT_SPREAD'
  | 'VERTICAL_CREDIT_SPREAD'
  | 'RATIO_SPREAD_1X2'
  | 'RATIO_SPREAD_1X3'
  | 'SHORT_STRADDLE_STRANGLE'
  | 'COVERED_CALL'
  | 'CROSS_COLLATERAL_STRATEGY';

export type CollateralAssetKind =
  | 'US_TREASURY_BILL'
  | 'US_TREASURY_NOTE'
  | 'US_TREASURY_BOND'
  | 'CASH_ARS'
  | 'CASH_USD'
  | 'LECAP'
  | 'SOVEREIGN_BOND_AR'
  | 'EQUITY_LOCAL';

export interface BymaMarginLegInput {
  readonly ticker: string;
  readonly contractType: OptionContractType;
  readonly side: OrderSide;
  readonly lots: number;
  readonly strikeArs: number;
  readonly optionPriceArs: number;
  readonly ivDecimal: number;
}

export interface BymaCollateralAssetInput {
  readonly id: string;
  readonly kind: CollateralAssetKind;
  readonly marketValueArs: number;
  /** Obligatorio en (0, 1] para activos locales correlacionados (LECAP, bonos AR, acciones). */
  readonly explicitAforo?: number;
  /** Duración modificada en años para stress de tasa LECAP en escenarios macro (opcional). */
  readonly modifiedDurationYears?: number;
}

export interface BymaClearingMarginInput {
  readonly asOfUtcSec: number;
  readonly expiryDateKey: string;
  readonly expiry1530UtcSec?: number;
  readonly spot24hArs: number;
  readonly rateCurveArs: readonly ContinuousRateCurvePoint[];
  readonly caucionRateContinuous?: number;
  readonly dividendsArs?: readonly DiscreteOrdinaryDividend[];
  readonly deltaAr1Days?: number;
  readonly deltaExDays?: number;
  readonly arHolidays?: readonly string[];
  readonly strategyKind: BymaClearingStrategyKind;
  readonly legs: readonly BymaMarginLegInput[];
  readonly underlyingSharesHeld?: number;
  readonly collateralAssets: readonly BymaCollateralAssetInput[];
  readonly spotShocks?: readonly number[];
  readonly volShocks?: readonly number[];
  readonly minStressVol?: number;
  readonly liquidBufferRate?: number;
  readonly wrongWayRiskSurchargeRate?: number;
  readonly crossCollateralOffsetRatio?: number;
}

export interface CcpGridNodeResult {
  readonly spotShockPct: number;
  readonly volShockDecimal: number;
  readonly shockedSpotArs: number;
  readonly portfolioMtmLossArs: number;
}

export interface CollateralBreakdownItem {
  readonly id: string;
  readonly kind: CollateralAssetKind;
  readonly marketValueArs: number;
  readonly aforo: number;
  readonly effectiveValueArs: number;
  readonly isLocalCorrelated: boolean;
  readonly status: 'OK' | 'MISSING_EXPLICIT_AFORO' | 'INVALID_INPUT';
}

export interface Circular3588AlertOutput {
  readonly active: boolean;
  readonly isExpiryDay: boolean;
  readonly minutesToCutoff: number;
  readonly atmDistancePctMin: number;
  readonly blockingAtmStrikes: readonly number[];
  readonly reason: string;
}

export interface StrategyMarginBreakdownItem {
  readonly strategyKind: BymaClearingStrategyKind;
  readonly label: string;
  readonly ccpRiskArrayLossArs: number;
  readonly steppedFloorArs: number;
  readonly requiredMarginArs: number;
}

export interface MarginAndRiskOutput {
  readonly status: 'OK' | 'NO_DATA';
  readonly reason?: string;
  readonly strategyKind: BymaClearingStrategyKind;
  readonly spot24hArs: number;
  readonly expiryDateKey: string;
  readonly ccpRiskArrayLossArs: number;
  readonly worstCcpNode: CcpGridNodeResult;
  readonly steppedFloorArs: number;
  readonly baseRequiredMarginArs: number;
  readonly liquidBufferArs: number;
  readonly wrongWayRiskSurchargeArs: number;
  readonly totalRequiredWithBuffersArs: number;
  readonly collateralStatus: 'OK' | 'MISSING_EXPLICIT_AFORO' | 'NO_DATA';
  readonly totalCollateralMarketArs: number;
  readonly totalEffectiveCollateralArs: number;
  readonly localCorrelatedEffectiveArs: number;
  readonly nonCorrelatedEffectiveArs: number;
  readonly excessOrDeficitArs: number;
  readonly collateralBreakdown: readonly CollateralBreakdownItem[];
  readonly t0GrossPremiumCashflowArs: number;
  readonly t0OptionFeesDmIvaArs: number;
  readonly t0NetCashflowArs: number;
  readonly projectedT1ExerciseFeeDmIvaArs: number;
  readonly projectedSpotEquityFeeDmIvaArs: number;
  readonly dailyMarginCarryCostArs: number;
  readonly circular3588Alert: Circular3588AlertOutput;
  readonly strategyReferenceMatrix: readonly StrategyMarginBreakdownItem[];
}

export interface AsyncMidTick {
  readonly utcSec: number;
  readonly midPrice: number;
}

export interface BookLevelInput {
  readonly priceArs: number;
  readonly sizeLots: number;
}

export type ExecutionTelemetryMode = 'LIVE' | 'EOD_CIERRE';
export type BookDepthSource = 'PRIMARY_L2' | 'BYMA_L1_ONLY' | 'NO_DATA';
export type ExecutionDecisionKind =
  | 'POST_PASSIVE_L1'
  | 'PRICE_IMPROVE_1_TICK'
  | 'CROSS_BOOK'
  | 'ABORT_STALE';

export interface ExecutionMicrostructureInput {
  readonly asOfUtcSec: number;
  readonly telemetryMode: ExecutionTelemetryMode;
  readonly side: OrderSide;
  readonly desiredLots: number;
  readonly orderHorizonSec?: number;
  readonly quoteAsOfUtcSec: number;
  readonly bidArs: number;
  readonly askArs: number;
  readonly lastTradeArs: number;
  readonly tickSizeArs: number;
  readonly depthSource: BookDepthSource;
  readonly bidsL1L2: readonly BookLevelInput[];
  readonly asksL1L2: readonly BookLevelInput[];
  readonly adv20Lots: number;
  readonly uncoveredOiLots: number;
  readonly lambdaBasePerSec: number;
  readonly expectedEdgeArsPerShare: number;
  readonly optionIvDecimal: number;
  readonly dailyVolPct?: number;
  readonly bymaTicks: readonly AsyncMidTick[];
  readonly adrTicks: readonly AsyncMidTick[];
  readonly leadLagOffsetsSec?: readonly number[];
  readonly maxAgeSec?: number;
  readonly maxSpreadPct?: number;
  readonly minL1DepthLots?: number;
  readonly sqrtImpactCoef?: number;
  readonly maxImpactRatio?: number;
}

export interface HayashiYoshidaLagPoint {
  readonly lagSec: number;
  readonly correlation: number;
  readonly overlappingPairs: number;
}

export interface HayashiYoshidaOutput {
  readonly status: 'OK' | 'NO_DATA';
  readonly reason?: string;
  readonly genuineBymaReturns: number;
  readonly genuineAdrReturns: number;
  readonly contemporaneousCorrelation: number;
  readonly optimalLagSec: number;
  readonly optimalCorrelation: number;
  readonly leadLagSignal: 'ADR_LEADS_BYMA' | 'BYMA_LEADS_ADR' | 'SYNCHRONOUS' | 'NO_DATA';
  readonly lagProfile: readonly HayashiYoshidaLagPoint[];
}

export interface ExecutionGateEvaluation {
  readonly gate1FreshnessPassed: boolean;
  readonly gate1Status: 'PASS' | 'FAIL_STALE' | 'BYPASSED_EOD' | 'INVALID_TIMESTAMP';
  readonly quoteAgeSec: number;
  readonly gate2SpreadPassed: boolean;
  readonly spreadPct: number;
  readonly gate3DepthPassed: boolean;
  readonly l1JoinLots: number;
  readonly l1CrossLots: number;
  readonly gate4TickConfirmPassed: boolean;
  readonly allGatesPassed: boolean;
}

export interface ExecutionMicrostructureOutput {
  readonly status: 'OK' | 'DEGRADED_L1_ONLY' | 'NO_DATA';
  readonly decision: ExecutionDecisionKind;
  readonly decisionReason: string;
  readonly hayashiYoshida: HayashiYoshidaOutput;
  readonly gates: ExecutionGateEvaluation;
  readonly spreadTicks: number;
  readonly halfSpreadArs: number;
  readonly queueAheadL1Lots: number;
  readonly lambdaEffectivePerSec: number;
  readonly fillProbPassiveL1: number;
  readonly fillProbImprove1Tick: number;
  readonly adverseSelectionCostArs: number;
  readonly esPassiveL1Ars: number;
  readonly esImprove1TickArs: number;
  readonly esCrossBookArs: number;
  readonly crossBookVwapSlippageArs: number;
  readonly visibleTargetDepthLots: number;
  readonly maxSingleOrderLots: number;
  readonly sqrtImpactCapLots: number;
  readonly liquidityCapBindingReason: string;
}

export interface StressOpraLegInput {
  readonly ticker: string;
  readonly contractType: OptionContractType;
  readonly side: OrderSide;
  readonly contracts: number;
  readonly strikeUsd: number;
  readonly expiryUtcSec: number;
  readonly ivDecimal: number;
  readonly rateUsdContinuous: number;
  readonly dividendYieldUsd?: number;
}

export interface StressScenarioSpec {
  readonly id: string;
  readonly label: string;
  readonly adrShockPct: number;
  readonly cclShockPct: number;
  readonly ivShiftDecimal: number;
  readonly lecapBpsShift: number;
}

export interface OvernightJumpDiffusionParams {
  readonly muAdrAnnual: number;
  readonly sigmaAdrDiffAnnual: number;
  readonly lambdaJumpAdrAnnual: number;
  readonly jumpMeanAdr: number;
  readonly jumpVolAdr: number;
  readonly muCclAnnual: number;
  readonly sigmaCclDiffAnnual: number;
  readonly rhoDiffAdrCcl: number;
  readonly cclCoJumpBeta: number;
  readonly sigmaCoJumpCcl: number;
  readonly nAdrQuantiles?: number;
  readonly nCclQuantiles?: number;
}

export interface TailStressAndSizingInput {
  readonly asOfUtcSec: number;
  readonly expiryDateKey: string;
  readonly expiry1530UtcSec?: number;
  readonly spot24hArs: number;
  readonly spotAdrUsd: number;
  readonly cclArs: number;
  readonly rateCurveArs: readonly ContinuousRateCurvePoint[];
  readonly caucionRateContinuous?: number;
  readonly dividendsArs?: readonly DiscreteOrdinaryDividend[];
  readonly deltaAr1Days?: number;
  readonly deltaExDays?: number;
  readonly arHolidays?: readonly string[];
  /** Patas BYMA de 1 lote-estructura base para escalamiento de sizing. */
  readonly bymaLegsPerUnit: readonly BymaMarginLegInput[];
  /** Patas OPRA de cobertura por cada 10 lotes BYMA (ej. 0.1 contratos si ratio 1:10). */
  readonly opraLegsPerTenBymaLots?: readonly StressOpraLegInput[];
  readonly capitalArs: number;
  readonly totalEffectiveCollateralArs: number;
  readonly marginRequiredPerUnitArs: number;
  readonly collateralAssets: readonly BymaCollateralAssetInput[];
  readonly overnightParams: OvernightJumpDiffusionParams;
  readonly scenarios?: readonly StressScenarioSpec[];
  readonly kellyFraction?: number;
  readonly noRuinCapitalFactor?: number;
  readonly maxCvar99PctOfCapital?: number;
  readonly maxDrawdownPctOfCapital?: number;
}

export interface StressScenarioResult {
  readonly id: string;
  readonly label: string;
  readonly adrShockPct: number;
  readonly cclShockPct: number;
  readonly ivShiftDecimal: number;
  readonly lecapBpsShift: number;
  readonly shockedAdrUsd: number;
  readonly shockedCclArs: number;
  readonly shockedSpotArs: number;
  readonly spotArsChangePct: number;
  readonly portfolioPnlPerUnitArs: number;
  readonly collateralRateImpactArs: number;
  readonly stressedEffectiveCollateralArs: number;
  readonly unitCapitalStressPct: number;
}

export interface SizingConstraintBreakdown {
  readonly fullKellyLots: number;
  readonly quarterKellyLots: number;
  readonly noRuinCapLots: number;
  readonly cvar99CapLots: number;
  readonly drawdownCapLots: number;
  readonly collateralMarginCapLots: number;
  readonly bindingConstraint: string;
}

export interface StressTestMatrixOutput {
  readonly status: 'OK' | 'NO_DATA';
  readonly reason?: string;
  readonly scenarioResults: readonly StressScenarioResult[];
  readonly worstScenarioId: string;
  readonly worstUnitLossArs: number;
  readonly overnightNodesCount: number;
  readonly overnightExpectedPnlPerUnitArs: number;
  readonly overnightStdDevPerUnitArs: number;
  readonly overnightMaxLossPerUnitArs: number;
  readonly overnightVar99PerUnitArs: number;
  readonly overnightCvar99PerUnitArs: number;
  readonly sizingBreakdown: SizingConstraintBreakdown;
  readonly recommendedBymaLots: number;
  readonly recommendedOpraContractsExact: number;
  readonly recommendedOpraContractsFloored: number;
}

export const DEFAULT_MACRO_STRESS_SCENARIOS: readonly StressScenarioSpec[] = [
  {
    id: 'CCL_UP_15_ADR_DOWN_10',
    label: 'CCL +15 % / ADR −10 %',
    adrShockPct: -0.10,
    cclShockPct: 0.15,
    ivShiftDecimal: 0.12,
    lecapBpsShift: 200,
  },
  {
    id: 'GAP_COMPRESS_10_ADR_UP_12',
    label: 'Compresión Gap −10 % / ADR +12 %',
    adrShockPct: 0.12,
    cclShockPct: -0.10,
    ivShiftDecimal: -0.06,
    lecapBpsShift: -150,
  },
  {
    id: 'LECAP_RATE_SPIKE_1500BPS',
    label: 'Suba Tasas LECAP +1500 bps',
    adrShockPct: -0.04,
    cclShockPct: 0.04,
    ivShiftDecimal: 0.05,
    lecapBpsShift: 1500,
  },
  {
    id: 'OVERNIGHT_ELECTION_TAIL',
    label: 'Cola Electoral / Fin de Semana',
    adrShockPct: -0.22,
    cclShockPct: 0.25,
    ivShiftDecimal: 0.30,
    lecapBpsShift: 1200,
  },
  {
    id: 'BAND_INTERVENTION_DOUBLE_DROP',
    label: 'Doble Caída Intervención Bandas',
    adrShockPct: -0.12,
    cclShockPct: -0.15,
    ivShiftDecimal: 0.15,
    lecapBpsShift: 600,
  },
];

const STRATEGY_LABELS: Readonly<Record<BymaClearingStrategyKind, string>> = {
  UNCOVERED_SHORT: 'Lanzamiento Descubierto',
  VERTICAL_DEBIT_SPREAD: 'Vertical Spread Deudor',
  VERTICAL_CREDIT_SPREAD: 'Vertical Spread Acreedor',
  RATIO_SPREAD_1X2: 'Ratio Spread 1x2',
  RATIO_SPREAD_1X3: 'Ratio Spread 1x3',
  SHORT_STRADDLE_STRANGLE: 'Straddle / Strangle Vendido',
  COVERED_CALL: 'Lanzamiento Cubierto',
  CROSS_COLLATERAL_STRATEGY: 'Estrategia Cruzada / Cross-Collateral',
};

const FIXED_DEFAULT_AFORO: Readonly<Partial<Record<CollateralAssetKind, number>>> = {
  US_TREASURY_BILL: 0.98,
  US_TREASURY_NOTE: 0.96,
  US_TREASURY_BOND: 0.94,
  CASH_ARS: 1.0,
  CASH_USD: 1.0,
};

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function buildEvalParamsForSpot(
  baseInput: {
    readonly asOfUtcSec: number;
    readonly expiryDateKey: string;
    readonly expiry1530UtcSec?: number;
    readonly deltaAr1Days?: number;
    readonly deltaExDays?: number;
    readonly arHolidays?: readonly string[];
    readonly caucionRateContinuous?: number;
    readonly rateCurve: readonly ContinuousRateCurvePoint[];
    readonly dividends?: readonly DiscreteOrdinaryDividend[];
  },
  spot24hArs: number,
  rateShiftContinuous = 0,
): BymaOptionEvalParams | null {
  const shiftedCurve: readonly ContinuousRateCurvePoint[] =
    rateShiftContinuous === 0
      ? baseInput.rateCurve
      : baseInput.rateCurve.map((pt) => ({
          days: pt.days,
          continuousRateAnnual: pt.continuousRateAnnual + rateShiftContinuous,
        }));

  const evalInput: Parameters<typeof computeBymaOptionEvalParams>[0] = {
    asOfUtcSec: baseInput.asOfUtcSec,
    spot24hArs,
    expiryDateKey: baseInput.expiryDateKey,
    rateCurve: shiftedCurve,
    ...(baseInput.expiry1530UtcSec !== undefined
      ? { expiry1530UtcSec: baseInput.expiry1530UtcSec }
      : {}),
    ...(baseInput.deltaAr1Days !== undefined ? { deltaAr1Days: baseInput.deltaAr1Days } : {}),
    ...(baseInput.deltaExDays !== undefined ? { deltaExDays: baseInput.deltaExDays } : {}),
    ...(baseInput.arHolidays !== undefined ? { arHolidays: baseInput.arHolidays } : {}),
    ...(baseInput.caucionRateContinuous !== undefined
      ? { caucionRateContinuous: baseInput.caucionRateContinuous + rateShiftContinuous }
      : {}),
    ...(baseInput.dividends !== undefined ? { dividends: baseInput.dividends } : {}),
  };
  return computeBymaOptionEvalParams(evalInput);
}

function computeOtmSteppedFloorRate(
  spot24hArs: number,
  strikeArs: number,
  contractType: OptionContractType,
): number {
  if (!isPositiveFinite(spot24hArs) || !isPositiveFinite(strikeArs)) {
    return Number.NaN;
  }
  const otmDistanceRatio =
    contractType === 'call'
      ? Math.max(0, (strikeArs - spot24hArs) / spot24hArs)
      : Math.max(0, (spot24hArs - strikeArs) / spot24hArs);
  if (otmDistanceRatio > 0.05) {
    return 0.01;
  }
  if (otmDistanceRatio >= 0.025) {
    return 0.025;
  }
  return 0.05;
}

/**
 * Empareja lotes largos contra lotes cortos del mismo tipo (conservadoramente empezando
 * por patas de menor piso primero) y calcula el piso escalonado sobre los lotes descubiertos.
 */
function computeSteppedUncoveredFloorArs(
  spot24hArs: number,
  legs: readonly BymaMarginLegInput[],
  coveredCallShares = 0,
): number {
  let remainingCoveredCallLots = Math.max(0, coveredCallShares) / GGAL_BYMA_LOT_SIZE;

  const computeTypeFloor = (contractType: OptionContractType): number => {
    const typeLegs = legs.filter((leg) => leg.contractType === contractType);
    const totalLongLots = typeLegs
      .filter((leg) => leg.side === 'BUY')
      .reduce((acc, leg) => acc + leg.lots, 0);
    let longCredit = totalLongLots + (contractType === 'call' ? remainingCoveredCallLots : 0);
    if (contractType === 'call') {
      remainingCoveredCallLots = 0;
    }

    const shortItems = typeLegs
      .filter((leg) => leg.side === 'SELL')
      .map((leg) => ({
        lots: leg.lots,
        floorRate: computeOtmSteppedFloorRate(spot24hArs, leg.strikeArs, contractType),
      }))
      .sort((a, b) => a.floorRate - b.floorRate);

    let floorSum = 0;
    for (const item of shortItems) {
      if (!Number.isFinite(item.floorRate)) {
        return Number.NaN;
      }
      const covered = Math.min(longCredit, item.lots);
      longCredit -= covered;
      const uncoveredLots = Math.max(0, item.lots - covered);
      floorSum += uncoveredLots * GGAL_BYMA_LOT_SIZE * spot24hArs * item.floorRate;
    }
    return floorSum;
  };

  return computeTypeFloor('call') + computeTypeFloor('put');
}

function evaluatePortfolioCcpGrid(
  baseInput: Parameters<typeof buildEvalParamsForSpot>[0],
  spot24hArs: number,
  legs: readonly BymaMarginLegInput[],
  spotShocks: readonly number[],
  volShocks: readonly number[],
  minStressVol: number,
): {
  readonly worstLossArs: number;
  readonly worstNode: CcpGridNodeResult;
} | null {
  const baseEval = buildEvalParamsForSpot(baseInput, spot24hArs);
  if (!baseEval) {
    return null;
  }

  let basePortfolioValueArs = 0;
  for (const leg of legs) {
    const sigmaBase = Math.max(minStressVol, leg.ivDecimal);
    const pBase = priceBymaAmericanBs02(baseEval, leg.strikeArs, sigmaBase, leg.contractType);
    if (!Number.isFinite(pBase)) {
      return null;
    }
    const sign = leg.side === 'BUY' ? 1 : -1;
    basePortfolioValueArs += sign * leg.lots * GGAL_BYMA_LOT_SIZE * pBase;
  }

  let worstLossArs = -Infinity;
  let worstNode: CcpGridNodeResult = {
    spotShockPct: 0,
    volShockDecimal: 0,
    shockedSpotArs: spot24hArs,
    portfolioMtmLossArs: Number.NaN,
  };

  for (const ds of spotShocks) {
    const shockedSpotArs = spot24hArs * (1 + ds);
    if (!isPositiveFinite(shockedSpotArs)) {
      continue;
    }
    const shockedEval = buildEvalParamsForSpot(baseInput, shockedSpotArs);
    if (!shockedEval) {
      return null;
    }
    for (const dv of volShocks) {
      let nodeValueArs = 0;
      for (const leg of legs) {
        const sigmaNode = Math.max(minStressVol, leg.ivDecimal + dv);
        const pNode = priceBymaAmericanBs02(shockedEval, leg.strikeArs, sigmaNode, leg.contractType);
        if (!Number.isFinite(pNode)) {
          return null;
        }
        const sign = leg.side === 'BUY' ? 1 : -1;
        nodeValueArs += sign * leg.lots * GGAL_BYMA_LOT_SIZE * pNode;
      }
      const mtmLossArs = Math.max(0, basePortfolioValueArs - nodeValueArs);
      if (mtmLossArs > worstLossArs) {
        worstLossArs = mtmLossArs;
        worstNode = {
          spotShockPct: ds,
          volShockDecimal: dv,
          shockedSpotArs,
          portfolioMtmLossArs: mtmLossArs,
        };
      }
    }
  }

  if (!Number.isFinite(worstLossArs)) {
    return null;
  }
  return { worstLossArs, worstNode };
}

function evaluateStrategyRequiredMargin(
  strategyKind: BymaClearingStrategyKind,
  baseInput: Parameters<typeof buildEvalParamsForSpot>[0],
  spot24hArs: number,
  legs: readonly BymaMarginLegInput[],
  underlyingSharesHeld: number,
  spotShocks: readonly number[],
  volShocks: readonly number[],
  minStressVol: number,
  crossCollateralOffsetRatio: number,
): {
  readonly ccpRiskArrayLossArs: number;
  readonly worstNode: CcpGridNodeResult;
  readonly steppedFloorArs: number;
  readonly requiredMarginArs: number;
} | null {
  const ccpEval = evaluatePortfolioCcpGrid(
    baseInput,
    spot24hArs,
    legs,
    spotShocks,
    volShocks,
    minStressVol,
  );
  if (!ccpEval) {
    return null;
  }
  const steppedFloorUncovered = computeSteppedUncoveredFloorArs(
    spot24hArs,
    legs,
    strategyKind === 'COVERED_CALL' ? underlyingSharesHeld : 0,
  );
  if (!Number.isFinite(steppedFloorUncovered)) {
    return null;
  }

  switch (strategyKind) {
    case 'UNCOVERED_SHORT': {
      return {
        ccpRiskArrayLossArs: ccpEval.worstLossArs,
        worstNode: ccpEval.worstNode,
        steppedFloorArs: steppedFloorUncovered,
        requiredMarginArs: Math.max(ccpEval.worstLossArs, steppedFloorUncovered),
      };
    }
    case 'VERTICAL_DEBIT_SPREAD': {
      return {
        ccpRiskArrayLossArs: ccpEval.worstLossArs,
        worstNode: ccpEval.worstNode,
        steppedFloorArs: 0,
        requiredMarginArs: 0,
      };
    }
    case 'VERTICAL_CREDIT_SPREAD': {
      const shortLegs = legs.filter((l) => l.side === 'SELL');
      const longLegs = legs.filter((l) => l.side === 'BUY');
      let maxLossCapArs = Infinity;
      const sLeg = shortLegs[0];
      const lLeg = longLegs[0];
      if (sLeg !== undefined && lLeg !== undefined && sLeg.contractType === lLeg.contractType) {
        const pairedLots = Math.min(sLeg.lots, lLeg.lots);
        maxLossCapArs =
          Math.abs(sLeg.strikeArs - lLeg.strikeArs) * GGAL_BYMA_LOT_SIZE * pairedLots;
      }
      const cappedCcp = Math.min(ccpEval.worstLossArs, maxLossCapArs);
      const rawShortFloor = computeSteppedUncoveredFloorArs(spot24hArs, shortLegs, 0);
      const cappedFloor = Math.min(rawShortFloor, maxLossCapArs);
      return {
        ccpRiskArrayLossArs: cappedCcp,
        worstNode: { ...ccpEval.worstNode, portfolioMtmLossArs: cappedCcp },
        steppedFloorArs: cappedFloor,
        requiredMarginArs: Math.max(cappedCcp, cappedFloor),
      };
    }
    case 'RATIO_SPREAD_1X2':
    case 'RATIO_SPREAD_1X3': {
      return {
        ccpRiskArrayLossArs: ccpEval.worstLossArs,
        worstNode: ccpEval.worstNode,
        steppedFloorArs: steppedFloorUncovered,
        requiredMarginArs: Math.max(ccpEval.worstLossArs, steppedFloorUncovered),
      };
    }
    case 'SHORT_STRADDLE_STRANGLE': {
      const callLegs = legs.filter((l) => l.contractType === 'call');
      const putLegs = legs.filter((l) => l.contractType === 'put');
      const callCcp =
        callLegs.length > 0
          ? evaluatePortfolioCcpGrid(
              baseInput,
              spot24hArs,
              callLegs,
              spotShocks,
              volShocks,
              minStressVol,
            )
          : null;
      const putCcp =
        putLegs.length > 0
          ? evaluatePortfolioCcpGrid(
              baseInput,
              spot24hArs,
              putLegs,
              spotShocks,
              volShocks,
              minStressVol,
            )
          : null;
      const callFloor = computeSteppedUncoveredFloorArs(spot24hArs, callLegs, 0);
      const putFloor = computeSteppedUncoveredFloorArs(spot24hArs, putLegs, 0);
      const marginCall = Math.max(callCcp?.worstLossArs ?? 0, callFloor);
      const marginPut = Math.max(putCcp?.worstLossArs ?? 0, putFloor);
      const callMarkTotal = callLegs
        .filter((l) => l.side === 'SELL')
        .reduce((acc, l) => acc + l.optionPriceArs * GGAL_BYMA_LOT_SIZE * l.lots, 0);
      const putMarkTotal = putLegs
        .filter((l) => l.side === 'SELL')
        .reduce((acc, l) => acc + l.optionPriceArs * GGAL_BYMA_LOT_SIZE * l.lots, 0);
      const requiredMarginArs =
        marginCall >= marginPut ? marginCall + putMarkTotal : marginPut + callMarkTotal;
      return {
        ccpRiskArrayLossArs: ccpEval.worstLossArs,
        worstNode: ccpEval.worstNode,
        steppedFloorArs: steppedFloorUncovered,
        requiredMarginArs,
      };
    }
    case 'COVERED_CALL': {
      const totalShortCallShares = legs
        .filter((l) => l.contractType === 'call' && l.side === 'SELL')
        .reduce((acc, l) => acc + l.lots * GGAL_BYMA_LOT_SIZE, 0);
      if (underlyingSharesHeld >= totalShortCallShares && totalShortCallShares > 0) {
        return {
          ccpRiskArrayLossArs: 0,
          worstNode: { ...ccpEval.worstNode, portfolioMtmLossArs: 0 },
          steppedFloorArs: 0,
          requiredMarginArs: 0,
        };
      }
      const uncoveredRatio =
        totalShortCallShares > 0
          ? clamp((totalShortCallShares - Math.max(0, underlyingSharesHeld)) / totalShortCallShares, 0, 1)
          : 1;
      const adjCcp = ccpEval.worstLossArs * uncoveredRatio;
      return {
        ccpRiskArrayLossArs: adjCcp,
        worstNode: { ...ccpEval.worstNode, portfolioMtmLossArs: adjCcp },
        steppedFloorArs: steppedFloorUncovered,
        requiredMarginArs: Math.max(adjCcp, steppedFloorUncovered),
      };
    }
    case 'CROSS_COLLATERAL_STRATEGY': {
      const reducedCcp = ccpEval.worstLossArs * (1 - clamp(crossCollateralOffsetRatio, 0, 0.5));
      return {
        ccpRiskArrayLossArs: reducedCcp,
        worstNode: { ...ccpEval.worstNode, portfolioMtmLossArs: reducedCcp },
        steppedFloorArs: steppedFloorUncovered,
        requiredMarginArs: Math.max(reducedCcp, steppedFloorUncovered),
      };
    }
  }
}

function evaluateCollateralPortfolio(assets: readonly BymaCollateralAssetInput[]): {
  readonly status: 'OK' | 'MISSING_EXPLICIT_AFORO' | 'NO_DATA';
  readonly totalMarketArs: number;
  readonly totalEffectiveArs: number;
  readonly localCorrelatedEffectiveArs: number;
  readonly nonCorrelatedEffectiveArs: number;
  readonly breakdown: readonly CollateralBreakdownItem[];
} {
  let hasMissingExplicitAforo = false;
  let hasInvalid = false;
  let totalMarketArs = 0;
  let totalEffectiveArs = 0;
  let localCorrelatedEffectiveArs = 0;
  let nonCorrelatedEffectiveArs = 0;

  const breakdown: CollateralBreakdownItem[] = [];
  for (const asset of assets) {
    const isLocalCorrelated =
      asset.kind === 'LECAP' || asset.kind === 'SOVEREIGN_BOND_AR' || asset.kind === 'EQUITY_LOCAL';
    if (!isFiniteNonNegative(asset.marketValueArs)) {
      hasInvalid = true;
      breakdown.push({
        id: asset.id,
        kind: asset.kind,
        marketValueArs: Number.NaN,
        aforo: Number.NaN,
        effectiveValueArs: Number.NaN,
        isLocalCorrelated,
        status: 'INVALID_INPUT',
      });
      continue;
    }

    let resolvedAforo: number;
    if (isLocalCorrelated) {
      if (
        asset.explicitAforo === undefined ||
        !Number.isFinite(asset.explicitAforo) ||
        asset.explicitAforo <= 0 ||
        asset.explicitAforo > 1
      ) {
        hasMissingExplicitAforo = true;
        totalMarketArs += asset.marketValueArs;
        breakdown.push({
          id: asset.id,
          kind: asset.kind,
          marketValueArs: asset.marketValueArs,
          aforo: Number.NaN,
          effectiveValueArs: Number.NaN,
          isLocalCorrelated,
          status: 'MISSING_EXPLICIT_AFORO',
        });
        continue;
      }
      resolvedAforo = asset.explicitAforo;
    } else {
      const def = FIXED_DEFAULT_AFORO[asset.kind];
      const candidate = asset.explicitAforo !== undefined ? asset.explicitAforo : def;
      if (
        candidate === undefined ||
        !Number.isFinite(candidate) ||
        candidate <= 0 ||
        candidate > 1
      ) {
        hasInvalid = true;
        breakdown.push({
          id: asset.id,
          kind: asset.kind,
          marketValueArs: asset.marketValueArs,
          aforo: Number.NaN,
          effectiveValueArs: Number.NaN,
          isLocalCorrelated,
          status: 'INVALID_INPUT',
        });
        continue;
      }
      resolvedAforo = candidate;
    }

    const eff = asset.marketValueArs * resolvedAforo;
    totalMarketArs += asset.marketValueArs;
    totalEffectiveArs += eff;
    if (isLocalCorrelated) {
      localCorrelatedEffectiveArs += eff;
    } else {
      nonCorrelatedEffectiveArs += eff;
    }

    breakdown.push({
      id: asset.id,
      kind: asset.kind,
      marketValueArs: asset.marketValueArs,
      aforo: resolvedAforo,
      effectiveValueArs: eff,
      isLocalCorrelated,
      status: 'OK',
    });
  }

  if (hasMissingExplicitAforo) {
    return {
      status: 'MISSING_EXPLICIT_AFORO',
      totalMarketArs,
      totalEffectiveArs: Number.NaN,
      localCorrelatedEffectiveArs: Number.NaN,
      nonCorrelatedEffectiveArs,
      breakdown,
    };
  }
  if (hasInvalid) {
    return {
      status: 'NO_DATA',
      totalMarketArs: Number.NaN,
      totalEffectiveArs: Number.NaN,
      localCorrelatedEffectiveArs: Number.NaN,
      nonCorrelatedEffectiveArs: Number.NaN,
      breakdown,
    };
  }
  return {
    status: 'OK',
    totalMarketArs,
    totalEffectiveArs,
    localCorrelatedEffectiveArs,
    nonCorrelatedEffectiveArs,
    breakdown,
  };
}

function buildCircular3588Alert(
  asOfUtcSec: number,
  expiryDateKey: string,
  expiry1530UtcSec: number,
  spot24hArs: number,
  legs: readonly BymaMarginLegInput[],
): Circular3588AlertOutput {
  const baParts = getBuenosAiresParts(asOfUtcSec);
  const isExpiryDay = baParts.dateKey === expiryDateKey;
  const minutesToCutoff = (expiry1530UtcSec - asOfUtcSec) / 60;

  let atmDistancePctMin = Infinity;
  const blockingAtmStrikes: number[] = [];
  for (const leg of legs) {
    if (!isPositiveFinite(leg.strikeArs)) {
      continue;
    }
    const dist = Math.abs(spot24hArs - leg.strikeArs) / leg.strikeArs;
    if (dist < atmDistancePctMin) {
      atmDistancePctMin = dist;
    }
    if (dist <= CIRCULAR_3588_ATM_BAND_PCT && !blockingAtmStrikes.includes(leg.strikeArs)) {
      blockingAtmStrikes.push(leg.strikeArs);
    }
  }

  const inLastHour =
    isExpiryDay && minutesToCutoff >= 0 && minutesToCutoff <= CIRCULAR_3588_WINDOW_MINUTES;
  const active = inLastHour && blockingAtmStrikes.length > 0;
  const reason = active
    ? `Circular N° 3588 Sec. 1.3 ACTIVA: últimos ${minutesToCutoff.toFixed(1)} min antes de 15:30 ART con strike ATM (${blockingAtmStrikes.join(', ')}). Riesgo binario de asignación automática/manual.`
    : inLastHour
      ? `Ventana última hora previa al corte 15:30 ART (${minutesToCutoff.toFixed(1)} min), sin patas dentro de ±0.5 % ATM.`
      : isExpiryDay
        ? `Día de vencimiento (${minutesToCutoff.toFixed(1)} min al corte 15:30 ART).`
        : 'Fuera de fecha de vencimiento (Circular N° 3588 Sec. 1.3 sin bloqueo).';

  return {
    active,
    isExpiryDay,
    minutesToCutoff,
    atmDistancePctMin: Number.isFinite(atmDistancePctMin) ? atmDistancePctMin : Number.NaN,
    blockingAtmStrikes,
    reason,
  };
}

/**
 * Evalúa el requerimiento de margen BYMA Clearing 2026, aforos de colateral,
 * recargo por Wrong-Way Risk (15 %), buffer líquido (10 %), carry T+0/T+1 con DM+IVA
 * y alerta reglamentaria de la Circular N° 3588 Sec. 1.3.
 */
export function evaluateBymaClearingMargin(
  input: BymaClearingMarginInput,
): MarginAndRiskOutput {
  const makeNoData = (reason: string): MarginAndRiskOutput => ({
    status: 'NO_DATA',
    reason,
    strategyKind: input.strategyKind,
    spot24hArs: Number.NaN,
    expiryDateKey: input.expiryDateKey,
    ccpRiskArrayLossArs: Number.NaN,
    worstCcpNode: {
      spotShockPct: Number.NaN,
      volShockDecimal: Number.NaN,
      shockedSpotArs: Number.NaN,
      portfolioMtmLossArs: Number.NaN,
    },
    steppedFloorArs: Number.NaN,
    baseRequiredMarginArs: Number.NaN,
    liquidBufferArs: Number.NaN,
    wrongWayRiskSurchargeArs: Number.NaN,
    totalRequiredWithBuffersArs: Number.NaN,
    collateralStatus: 'NO_DATA',
    totalCollateralMarketArs: Number.NaN,
    totalEffectiveCollateralArs: Number.NaN,
    localCorrelatedEffectiveArs: Number.NaN,
    nonCorrelatedEffectiveArs: Number.NaN,
    excessOrDeficitArs: Number.NaN,
    collateralBreakdown: [],
    t0GrossPremiumCashflowArs: Number.NaN,
    t0OptionFeesDmIvaArs: Number.NaN,
    t0NetCashflowArs: Number.NaN,
    projectedT1ExerciseFeeDmIvaArs: Number.NaN,
    projectedSpotEquityFeeDmIvaArs: Number.NaN,
    dailyMarginCarryCostArs: Number.NaN,
    circular3588Alert: {
      active: false,
      isExpiryDay: false,
      minutesToCutoff: Number.NaN,
      atmDistancePctMin: Number.NaN,
      blockingAtmStrikes: [],
      reason,
    },
    strategyReferenceMatrix: [],
  });

  if (
    !isValidUtcSec(input.asOfUtcSec) ||
    !isPositiveFinite(input.spot24hArs) ||
    input.legs.length === 0 ||
    input.rateCurveArs.length === 0
  ) {
    return makeNoData('Entradas inválidas o vacías en evaluateBymaClearingMargin.');
  }
  for (const leg of input.legs) {
    if (
      !isPositiveFinite(leg.lots) ||
      !isPositiveFinite(leg.strikeArs) ||
      !isFiniteNonNegative(leg.optionPriceArs) ||
      !isPositiveFinite(leg.ivDecimal)
    ) {
      return makeNoData(`Pata inválida en ${leg.ticker || 'OPCIÓN'}.`);
    }
  }
  if (input.strategyKind === 'COVERED_CALL' && input.underlyingSharesHeld === undefined) {
    return makeNoData('COVERED_CALL exige especificar underlyingSharesHeld explícitamente.');
  }

  const expiry1530UtcSec =
    input.expiry1530UtcSec ?? computeExpiration1530ArtUtcSec(input.expiryDateKey);
  if (!isValidUtcSec(expiry1530UtcSec) || expiry1530UtcSec <= input.asOfUtcSec) {
    return makeNoData('Fecha de vencimiento 15:30 ART inválida o expirada.');
  }

  const evalBaseInput: Parameters<typeof buildEvalParamsForSpot>[0] = {
    asOfUtcSec: input.asOfUtcSec,
    expiryDateKey: input.expiryDateKey,
    expiry1530UtcSec,
    rateCurve: input.rateCurveArs,
    ...(input.deltaAr1Days !== undefined ? { deltaAr1Days: input.deltaAr1Days } : {}),
    ...(input.deltaExDays !== undefined ? { deltaExDays: input.deltaExDays } : {}),
    ...(input.arHolidays !== undefined ? { arHolidays: input.arHolidays } : {}),
    ...(input.caucionRateContinuous !== undefined
      ? { caucionRateContinuous: input.caucionRateContinuous }
      : {}),
    ...(input.dividendsArs !== undefined ? { dividends: input.dividendsArs } : {}),
  };

  const spotShocks = input.spotShocks ?? DEFAULT_CCP_SPOT_SHOCKS;
  const volShocks = input.volShocks ?? DEFAULT_CCP_VOL_SHOCKS;
  const minStressVol = input.minStressVol ?? MIN_CCP_STRESS_VOL;
  const liquidBufferRate = input.liquidBufferRate ?? DEFAULT_LIQUID_BUFFER_RATE;
  const wwrSurchargeRate = input.wrongWayRiskSurchargeRate ?? DEFAULT_WWR_SURCHARGE_RATE;
  const crossOffsetRatio = input.crossCollateralOffsetRatio ?? DEFAULT_CROSS_COLLATERAL_OFFSET_RATIO;
  const sharesHeld = input.underlyingSharesHeld ?? 0;

  const activeStrategyMargin = evaluateStrategyRequiredMargin(
    input.strategyKind,
    evalBaseInput,
    input.spot24hArs,
    input.legs,
    sharesHeld,
    spotShocks,
    volShocks,
    minStressVol,
    crossOffsetRatio,
  );
  if (!activeStrategyMargin) {
    return makeNoData('No pudo evaluarse la grilla BS02 CCP BYMA.');
  }

  const collateralEval = evaluateCollateralPortfolio(input.collateralAssets);
  const liquidBufferArs = activeStrategyMargin.requiredMarginArs * liquidBufferRate;

  let wrongWayRiskSurchargeArs = 0;
  let totalRequiredWithBuffersArs = Number.NaN;
  let excessOrDeficitArs = Number.NaN;

  if (collateralEval.status === 'OK') {
    const uncoveredByNonCorr = Math.max(
      0,
      activeStrategyMargin.requiredMarginArs - collateralEval.nonCorrelatedEffectiveArs,
    );
    const localMarginBackedArs = Math.min(
      uncoveredByNonCorr,
      collateralEval.localCorrelatedEffectiveArs,
    );
    wrongWayRiskSurchargeArs = localMarginBackedArs * wwrSurchargeRate;
    totalRequiredWithBuffersArs =
      activeStrategyMargin.requiredMarginArs + liquidBufferArs + wrongWayRiskSurchargeArs;
    excessOrDeficitArs = collateralEval.totalEffectiveArs - totalRequiredWithBuffersArs;
  } else {
    wrongWayRiskSurchargeArs = Number.NaN;
  }

  // Costos T+0 (prima + DM+IVA) y T+1 (proyección ejercicio + carry caución diaria)
  let t0GrossPremiumCashflowArs = 0;
  let grossOptionNotionalArs = 0;
  let grossStrikeExerciseNotionalArs = 0;
  for (const leg of input.legs) {
    const premNotional = leg.optionPriceArs * GGAL_BYMA_LOT_SIZE * leg.lots;
    const sign = leg.side === 'SELL' ? 1 : -1;
    t0GrossPremiumCashflowArs += sign * premNotional;
    grossOptionNotionalArs += premNotional;
    grossStrikeExerciseNotionalArs += leg.strikeArs * GGAL_BYMA_LOT_SIZE * leg.lots;
  }
  const t0OptionFeesDmIvaArs = grossOptionNotionalArs * BYMA_OPTION_PREMIUM_DM_RATE_WITH_IVA;
  const t0NetCashflowArs = t0GrossPremiumCashflowArs - t0OptionFeesDmIvaArs;
  const projectedT1ExerciseFeeDmIvaArs =
    grossStrikeExerciseNotionalArs * BYMA_EXERCISE_DM_RATE_WITH_IVA;
  const projectedSpotEquityFeeDmIvaArs =
    sharesHeld > 0 ? sharesHeld * input.spot24hArs * BYMA_EQUITY_PPT_DM_RATE_WITH_IVA : 0;

  const baseEvalParams = buildEvalParamsForSpot(evalBaseInput, input.spot24hArs);
  const caucionCont =
    baseEvalParams?.r1Continuous ?? interpolateContinuousRate(input.rateCurveArs, 1);
  const dailyMarginCarryCostArs = Number.isFinite(totalRequiredWithBuffersArs)
    ? totalRequiredWithBuffersArs * (Math.exp(caucionCont / DAYS_PER_YEAR) - 1)
    : Number.NaN;

  const circular3588Alert = buildCircular3588Alert(
    input.asOfUtcSec,
    input.expiryDateKey,
    expiry1530UtcSec,
    input.spot24hArs,
    input.legs,
  );

  // Matriz comparativa determinista de referencia para las 8 estrategias sobre las mismas patas
  const allKinds: readonly BymaClearingStrategyKind[] = [
    'UNCOVERED_SHORT',
    'VERTICAL_DEBIT_SPREAD',
    'VERTICAL_CREDIT_SPREAD',
    'RATIO_SPREAD_1X2',
    'RATIO_SPREAD_1X3',
    'SHORT_STRADDLE_STRANGLE',
    'COVERED_CALL',
    'CROSS_COLLATERAL_STRATEGY',
  ];
  const strategyReferenceMatrix: StrategyMarginBreakdownItem[] = [];
  for (const kind of allKinds) {
    const res =
      kind === input.strategyKind
        ? activeStrategyMargin
        : evaluateStrategyRequiredMargin(
            kind,
            evalBaseInput,
            input.spot24hArs,
            input.legs,
            kind === 'COVERED_CALL'
              ? input.underlyingSharesHeld ??
                  input.legs
                    .filter((l) => l.contractType === 'call' && l.side === 'SELL')
                    .reduce((acc, l) => acc + l.lots * GGAL_BYMA_LOT_SIZE, 0)
              : sharesHeld,
            spotShocks,
            volShocks,
            minStressVol,
            crossOffsetRatio,
          );
    if (res) {
      strategyReferenceMatrix.push({
        strategyKind: kind,
        label: STRATEGY_LABELS[kind],
        ccpRiskArrayLossArs: res.ccpRiskArrayLossArs,
        steppedFloorArs: res.steppedFloorArs,
        requiredMarginArs: res.requiredMarginArs,
      });
    }
  }

  return {
    status: collateralEval.status === 'OK' ? 'OK' : 'NO_DATA',
    strategyKind: input.strategyKind,
    spot24hArs: input.spot24hArs,
    expiryDateKey: input.expiryDateKey,
    ccpRiskArrayLossArs: activeStrategyMargin.ccpRiskArrayLossArs,
    worstCcpNode: activeStrategyMargin.worstNode,
    steppedFloorArs: activeStrategyMargin.steppedFloorArs,
    baseRequiredMarginArs: activeStrategyMargin.requiredMarginArs,
    liquidBufferArs,
    wrongWayRiskSurchargeArs,
    totalRequiredWithBuffersArs,
    collateralStatus: collateralEval.status,
    totalCollateralMarketArs: collateralEval.totalMarketArs,
    totalEffectiveCollateralArs: collateralEval.totalEffectiveArs,
    localCorrelatedEffectiveArs: collateralEval.localCorrelatedEffectiveArs,
    nonCorrelatedEffectiveArs: collateralEval.nonCorrelatedEffectiveArs,
    excessOrDeficitArs,
    collateralBreakdown: collateralEval.breakdown,
    t0GrossPremiumCashflowArs,
    t0OptionFeesDmIvaArs,
    t0NetCashflowArs,
    projectedT1ExerciseFeeDmIvaArs,
    projectedSpotEquityFeeDmIvaArs,
    dailyMarginCarryCostArs,
    circular3588Alert,
    strategyReferenceMatrix,
  };
}

interface ReturnInterval {
  readonly tStart: number;
  readonly tEnd: number;
  readonly logReturn: number;
}

function buildGenuineReturnIntervals(ticks: readonly AsyncMidTick[]): readonly ReturnInterval[] | null {
  if (ticks.length < 2) {
    return [];
  }
  const kept: AsyncMidTick[] = [];
  let prevTime = -Infinity;
  for (const tick of ticks) {
    if (!isValidUtcSec(tick.utcSec) || !isPositiveFinite(tick.midPrice) || tick.utcSec < prevTime) {
      return null;
    }
    prevTime = tick.utcSec;
    const lastKept = kept[kept.length - 1];
    if (!lastKept) {
      kept.push(tick);
      continue;
    }
    if (tick.midPrice !== lastKept.midPrice && tick.utcSec > lastKept.utcSec) {
      kept.push(tick);
    }
  }

  const intervals: ReturnInterval[] = [];
  for (let i = 1; i < kept.length; i++) {
    const prev = kept[i - 1];
    const curr = kept[i];
    if (prev === undefined || curr === undefined) {
      continue;
    }
    intervals.push({
      tStart: prev.utcSec,
      tEnd: curr.utcSec,
      logReturn: Math.log(curr.midPrice / prev.midPrice),
    });
  }
  return intervals;
}

/**
 * Estimador asíncrono de covarianza/correlación Hayashi-Yoshida con barrido lead-lag
 * sobre cambios genuinos de precio (sin interpolación ni grilla artificial).
 */
export function computeHayashiYoshidaLeadLag(
  bymaTicks: readonly AsyncMidTick[],
  adrTicks: readonly AsyncMidTick[],
  leadLagOffsetsSec: readonly number[] = DEFAULT_HAYASHI_LAG_GRID_SEC,
): HayashiYoshidaOutput {
  const empty = (reason: string): HayashiYoshidaOutput => ({
    status: 'NO_DATA',
    reason,
    genuineBymaReturns: 0,
    genuineAdrReturns: 0,
    contemporaneousCorrelation: Number.NaN,
    optimalLagSec: Number.NaN,
    optimalCorrelation: Number.NaN,
    leadLagSignal: 'NO_DATA',
    lagProfile: [],
  });

  const bymaIntervals = buildGenuineReturnIntervals(bymaTicks);
  const adrIntervals = buildGenuineReturnIntervals(adrTicks);
  if (!bymaIntervals || !adrIntervals) {
    return empty('Timestamps o precios inválidos en ticks asíncronos.');
  }
  if (bymaIntervals.length < 2 || adrIntervals.length < 2) {
    return {
      status: 'NO_DATA',
      reason: 'Insuficientes cambios genuinos de precio en arranque/cierre para Hayashi-Yoshida.',
      genuineBymaReturns: bymaIntervals.length,
      genuineAdrReturns: adrIntervals.length,
      contemporaneousCorrelation: Number.NaN,
      optimalLagSec: Number.NaN,
      optimalCorrelation: Number.NaN,
      leadLagSignal: 'NO_DATA',
      lagProfile: [],
    };
  }

  let bymaVar = 0;
  for (const iv of bymaIntervals) {
    bymaVar += iv.logReturn * iv.logReturn;
  }
  let adrVar = 0;
  for (const jv of adrIntervals) {
    adrVar += jv.logReturn * jv.logReturn;
  }
  const denom = Math.sqrt(bymaVar * adrVar);
  if (!isPositiveFinite(denom)) {
    return empty('Varianza nula en intervalos Hayashi-Yoshida.');
  }

  const evalAtLag = (lagSec: number): HayashiYoshidaLagPoint => {
    let cov = 0;
    let overlappingPairs = 0;
    let jStart = 0;
    for (const bi of bymaIntervals) {
      while (jStart < adrIntervals.length) {
        const aHead = adrIntervals[jStart];
        if (aHead === undefined || aHead.tEnd + lagSec > bi.tStart) {
          break;
        }
        jStart++;
      }
      for (let j = jStart; j < adrIntervals.length; j++) {
        const aj = adrIntervals[j];
        if (aj === undefined) {
          continue;
        }
        const ajStart = aj.tStart + lagSec;
        const ajEnd = aj.tEnd + lagSec;
        if (ajStart >= bi.tEnd) {
          break;
        }
        if (Math.max(bi.tStart, ajStart) < Math.min(bi.tEnd, ajEnd)) {
          cov += bi.logReturn * aj.logReturn;
          overlappingPairs++;
        }
      }
    }
    return {
      lagSec,
      correlation: overlappingPairs > 0 ? clamp(cov / denom, -1, 1) : 0,
      overlappingPairs,
    };
  };

  const lagProfile: HayashiYoshidaLagPoint[] = leadLagOffsetsSec.map((lag) => evalAtLag(lag));
  const zeroPoint = lagProfile.find((p) => p.lagSec === 0) ?? evalAtLag(0);

  let bestPoint = zeroPoint;
  for (const pt of lagProfile) {
    const diff = Math.abs(pt.correlation) - Math.abs(bestPoint.correlation);
    if (
      diff > 1e-12 ||
      (Math.abs(diff) <= 1e-12 && Math.abs(pt.lagSec) < Math.abs(bestPoint.lagSec))
    ) {
      bestPoint = pt;
    }
  }

  const leadLagSignal =
    bestPoint.lagSec > 0
      ? 'ADR_LEADS_BYMA'
      : bestPoint.lagSec < 0
        ? 'BYMA_LEADS_ADR'
        : 'SYNCHRONOUS';

  return {
    status: 'OK',
    genuineBymaReturns: bymaIntervals.length,
    genuineAdrReturns: adrIntervals.length,
    contemporaneousCorrelation: zeroPoint.correlation,
    optimalLagSec: bestPoint.lagSec,
    optimalCorrelation: bestPoint.correlation,
    leadLagSignal,
    lagProfile,
  };
}

function computeCrossBookVwapSlippage(
  levels: readonly BookLevelInput[],
  desiredLots: number,
  bestOppositePriceArs: number,
): number {
  if (levels.length === 0 || !isPositiveFinite(desiredLots) || !isPositiveFinite(bestOppositePriceArs)) {
    return Number.NaN;
  }
  let remaining = desiredLots;
  let weightedSum = 0;
  let filled = 0;
  for (const lvl of levels) {
    if (!isPositiveFinite(lvl.priceArs) || !isFiniteNonNegative(lvl.sizeLots) || lvl.sizeLots === 0) {
      continue;
    }
    const take = Math.min(remaining, lvl.sizeLots);
    weightedSum += take * lvl.priceArs;
    filled += take;
    remaining -= take;
    if (remaining <= 1e-12) {
      break;
    }
  }
  if (filled <= 0 || remaining > 1e-9) {
    const lastLevel = levels[levels.length - 1];
    if (lastLevel === undefined || !isPositiveFinite(lastLevel.priceArs)) {
      return Number.NaN;
    }
    weightedSum += Math.max(0, remaining) * lastLevel.priceArs;
    filled += Math.max(0, remaining);
  }
  const vwap = weightedSum / filled;
  return Math.abs(vwap - bestOppositePriceArs);
}

/**
 * Evalúa microestructura de ejecución L1–L2: correlación asíncrona Hayashi-Yoshida,
 * filtro de 4 compuertas anti-flujo tóxico, probabilidad Poisson de llenado L1–L2,
 * decisión óptima de enrutamiento y cota máxima de orden individual por liquidez.
 */
export function evaluateExecutionMicrostructure(
  input: ExecutionMicrostructureInput,
): ExecutionMicrostructureOutput {
  const maxAgeSec = input.maxAgeSec ?? DEFAULT_GATE_MAX_AGE_SEC;
  const maxSpreadPct = input.maxSpreadPct ?? DEFAULT_GATE_MAX_SPREAD_PCT;
  const minL1DepthLots = input.minL1DepthLots ?? DEFAULT_GATE_MIN_L1_DEPTH_LOTS;
  const orderHorizonSec = input.orderHorizonSec ?? DEFAULT_ORDER_HORIZON_SEC;
  const sqrtImpactCoef = input.sqrtImpactCoef ?? DEFAULT_SQRT_IMPACT_COEF;
  const maxImpactRatio = input.maxImpactRatio ?? DEFAULT_MAX_IMPACT_RATIO;

  const hy = computeHayashiYoshidaLeadLag(
    input.bymaTicks,
    input.adrTicks,
    input.leadLagOffsetsSec ?? DEFAULT_HAYASHI_LAG_GRID_SEC,
  );

  const validTimestamps = isValidUtcSec(input.asOfUtcSec) && isValidUtcSec(input.quoteAsOfUtcSec);
  const quoteAgeSec = validTimestamps ? input.asOfUtcSec - input.quoteAsOfUtcSec : Number.NaN;

  let gate1Status: ExecutionGateEvaluation['gate1Status'] = 'INVALID_TIMESTAMP';
  let gate1FreshnessPassed = false;
  if (validTimestamps && quoteAgeSec >= 0) {
    if (input.telemetryMode === 'EOD_CIERRE') {
      gate1Status = 'BYPASSED_EOD';
      gate1FreshnessPassed = true;
    } else if (quoteAgeSec <= maxAgeSec) {
      gate1Status = 'PASS';
      gate1FreshnessPassed = true;
    } else {
      gate1Status = 'FAIL_STALE';
    }
  }

  const validBookPrices =
    isPositiveFinite(input.bidArs) &&
    isPositiveFinite(input.askArs) &&
    input.askArs > input.bidArs &&
    isPositiveFinite(input.tickSizeArs) &&
    isPositiveFinite(input.desiredLots);
  const midArs = validBookPrices ? 0.5 * (input.bidArs + input.askArs) : Number.NaN;
  const spreadArs = validBookPrices ? input.askArs - input.bidArs : Number.NaN;
  const spreadPct = validBookPrices ? spreadArs / midArs : Number.NaN;
  const gate2SpreadPassed = validBookPrices && spreadPct <= maxSpreadPct;

  const hasL2Depth =
    input.depthSource === 'PRIMARY_L2' && input.bidsL1L2.length > 0 && input.asksL1L2.length > 0;
  const l1BidLots = hasL2Depth ? (input.bidsL1L2[0]?.sizeLots ?? Number.NaN) : Number.NaN;
  const l1AskLots = hasL2Depth ? (input.asksL1L2[0]?.sizeLots ?? Number.NaN) : Number.NaN;
  const l1JoinLots = input.side === 'BUY' ? l1BidLots : l1AskLots;
  const l1CrossLots = input.side === 'BUY' ? l1AskLots : l1BidLots;
  const gate3DepthPassed =
    hasL2Depth &&
    isPositiveFinite(l1JoinLots) &&
    isPositiveFinite(l1CrossLots) &&
    l1JoinLots >= minL1DepthLots &&
    l1CrossLots >= minL1DepthLots;

  const gate4TickConfirmPassed =
    validBookPrices &&
    isPositiveFinite(input.lastTradeArs) &&
    input.lastTradeArs >= input.bidArs - spreadArs &&
    input.lastTradeArs <= input.askArs + spreadArs;

  const allGatesPassed =
    gate1FreshnessPassed && gate2SpreadPassed && gate3DepthPassed && gate4TickConfirmPassed;

  const spreadTicks = validBookPrices ? Math.round(spreadArs / input.tickSizeArs) : Number.NaN;
  const halfSpreadArs = validBookPrices ? 0.5 * spreadArs : Number.NaN;

  const leadLagBoost =
    hy.status === 'OK' && Number.isFinite(hy.optimalCorrelation)
      ? 1 + clamp(Math.abs(hy.optimalCorrelation), 0, 1)
      : 1;
  const lambdaEffectivePerSec = isFiniteNonNegative(input.lambdaBasePerSec)
    ? input.lambdaBasePerSec * leadLagBoost
    : Number.NaN;

  const fillProbPassiveL1 =
    hasL2Depth &&
    isPositiveFinite(l1JoinLots) &&
    isFiniteNonNegative(lambdaEffectivePerSec) &&
    isPositiveFinite(orderHorizonSec)
      ? 1 - Math.exp(-(lambdaEffectivePerSec * orderHorizonSec) / (l1JoinLots + input.desiredLots))
      : Number.NaN;

  const fillProbImprove1Tick =
    validBookPrices &&
    spreadTicks >= 2 &&
    isFiniteNonNegative(lambdaEffectivePerSec) &&
    isPositiveFinite(orderHorizonSec)
      ? 1 - Math.exp(-(lambdaEffectivePerSec * orderHorizonSec) / input.desiredLots)
      : Number.NaN;

  const adverseSelectionCostArs =
    validBookPrices && isPositiveFinite(input.optionIvDecimal) && isPositiveFinite(orderHorizonSec)
      ? 0.4 *
        midArs *
        input.optionIvDecimal *
        Math.sqrt(orderHorizonSec / (DAYS_PER_YEAR * 86_400)) *
        (hy.status === 'OK' ? 1 + clamp(Math.abs(hy.optimalCorrelation), 0, 1) : 1)
      : Number.NaN;

  const esPassiveL1Ars =
    Number.isFinite(fillProbPassiveL1) && Number.isFinite(adverseSelectionCostArs)
      ? fillProbPassiveL1 * -halfSpreadArs +
        (1 - fillProbPassiveL1) * (adverseSelectionCostArs + halfSpreadArs)
      : Number.NaN;

  const esImprove1TickArs =
    Number.isFinite(fillProbImprove1Tick) && Number.isFinite(adverseSelectionCostArs)
      ? fillProbImprove1Tick * -(halfSpreadArs - input.tickSizeArs) +
        (1 - fillProbImprove1Tick) * (adverseSelectionCostArs + halfSpreadArs)
      : Number.NaN;

  const targetLevels = input.side === 'BUY' ? input.asksL1L2 : input.bidsL1L2;
  const bestOpposite = input.side === 'BUY' ? input.askArs : input.bidArs;
  const crossBookVwapSlippageArs = hasL2Depth
    ? computeCrossBookVwapSlippage(targetLevels, input.desiredLots, bestOpposite)
    : Number.NaN;
  const esCrossBookArs =
    validBookPrices && Number.isFinite(crossBookVwapSlippageArs)
      ? halfSpreadArs + crossBookVwapSlippageArs
      : Number.NaN;

  let decision: ExecutionDecisionKind = 'ABORT_STALE';
  let decisionReason = '';
  if (!allGatesPassed) {
    const failed: string[] = [];
    if (!gate1FreshnessPassed) failed.push(`Gate1(${gate1Status})`);
    if (!gate2SpreadPassed) failed.push('Gate2(Spread>4%)');
    if (!gate3DepthPassed) failed.push(hasL2Depth ? 'Gate3(Depth<5)' : 'Gate3(NO_L2_DEPTH)');
    if (!gate4TickConfirmPassed) failed.push('Gate4(TickMismatch)');
    decision = 'ABORT_STALE';
    decisionReason = `Bloqueado por filtro 4 compuertas: ${failed.join(', ')}.`;
  } else if (
    fillProbPassiveL1 < 0.25 ||
    (Number.isFinite(input.expectedEdgeArsPerShare) &&
      input.expectedEdgeArsPerShare > esCrossBookArs &&
      esCrossBookArs <= Math.min(esPassiveL1Ars, Number.isFinite(esImprove1TickArs) ? esImprove1TickArs : Infinity))
  ) {
    decision = 'CROSS_BOOK';
    decisionReason =
      fillProbPassiveL1 < 0.25
        ? `P(fill L1)=${(fillProbPassiveL1 * 100).toFixed(1)}% < 25% umbral: cruzar libro optimiza ejecución.`
        : 'Ventaja neta supera costo de cruce con menor Expected Shortfall.';
  } else if (
    spreadTicks >= 2 &&
    Number.isFinite(esImprove1TickArs) &&
    esImprove1TickArs <= esPassiveL1Ars
  ) {
    decision = 'PRICE_IMPROVE_1_TICK';
    decisionReason = `Spread de ${String(spreadTicks)} ticks con ES mejorado (${esImprove1TickArs.toFixed(2)}) <= ES pasivo (${esPassiveL1Ars.toFixed(2)}).`;
  } else {
    decision = 'POST_PASSIVE_L1';
    decisionReason = `Spread ${String(spreadTicks)} tick(s) y P(fill L1)=${(fillProbPassiveL1 * 100).toFixed(1)}% adecuada: postear pasivo en L1.`;
  }

  // Cota máxima de orden individual: min(50% book L1-L2, 5% ADV20, 10% OI, impacto raíz-potencia)
  const visibleTargetDepthLots = hasL2Depth
    ? targetLevels.reduce((acc, lvl) => acc + Math.max(0, lvl.sizeLots), 0)
    : Number.NaN;
  const dailySigma = isPositiveFinite(input.dailyVolPct ?? Number.NaN)
    ? (input.dailyVolPct as number)
    : isPositiveFinite(input.optionIvDecimal)
      ? input.optionIvDecimal / Math.sqrt(252)
      : Number.NaN;
  const sqrtImpactCapLots =
    isPositiveFinite(input.adv20Lots) && isPositiveFinite(dailySigma)
      ? input.adv20Lots *
        Math.pow(maxImpactRatio / (sqrtImpactCoef * dailySigma), 1 / DEFAULT_SQRT_IMPACT_EXPONENT)
      : Number.NaN;

  let maxSingleOrderLots = Number.NaN;
  let liquidityCapBindingReason = 'NO_DATA';
  if (
    hasL2Depth &&
    isPositiveFinite(visibleTargetDepthLots) &&
    isPositiveFinite(input.adv20Lots) &&
    isPositiveFinite(input.uncoveredOiLots) &&
    isPositiveFinite(sqrtImpactCapLots)
  ) {
    const candidates: readonly { readonly name: string; readonly cap: number }[] = [
      { name: '50% L1-L2 Visible Depth', cap: 0.50 * visibleTargetDepthLots },
      { name: '5% ADV20', cap: 0.05 * input.adv20Lots },
      { name: '10% Uncovered OI', cap: 0.10 * input.uncoveredOiLots },
      { name: 'Sqrt Market Impact Cap', cap: sqrtImpactCapLots },
    ];
    let minCap = Infinity;
    let binder = '';
    for (const c of candidates) {
      if (c.cap < minCap) {
        minCap = c.cap;
        binder = c.name;
      }
    }
    maxSingleOrderLots = Math.max(0, Math.floor(minCap));
    liquidityCapBindingReason = binder;
  }

  const status: ExecutionMicrostructureOutput['status'] = !validBookPrices
    ? 'NO_DATA'
    : hasL2Depth
      ? 'OK'
      : 'DEGRADED_L1_ONLY';

  return {
    status,
    decision,
    decisionReason,
    hayashiYoshida: hy,
    gates: {
      gate1FreshnessPassed,
      gate1Status,
      quoteAgeSec,
      gate2SpreadPassed,
      spreadPct,
      gate3DepthPassed,
      l1JoinLots,
      l1CrossLots,
      gate4TickConfirmPassed,
      allGatesPassed,
    },
    spreadTicks,
    halfSpreadArs,
    queueAheadL1Lots: l1JoinLots,
    lambdaEffectivePerSec,
    fillProbPassiveL1,
    fillProbImprove1Tick,
    adverseSelectionCostArs,
    esPassiveL1Ars,
    esImprove1TickArs,
    esCrossBookArs,
    crossBookVwapSlippageArs,
    visibleTargetDepthLots,
    maxSingleOrderLots,
    sqrtImpactCapLots,
    liquidityCapBindingReason,
  };
}

function priceUnitPortfolioArs(
  bymaEval: BymaOptionEvalParams,
  bymaLegs: readonly BymaMarginLegInput[],
  opraLegs: readonly StressOpraLegInput[],
  spotAdrUsd: number,
  cclArs: number,
  ivShiftDecimal: number,
  minStressVol: number,
): number | null {
  let totalArs = 0;
  for (const leg of bymaLegs) {
    const sigma = Math.max(minStressVol, leg.ivDecimal + ivShiftDecimal);
    const pxArs = priceBymaAmericanBs02(bymaEval, leg.strikeArs, sigma, leg.contractType);
    if (!Number.isFinite(pxArs)) {
      return null;
    }
    const sign = leg.side === 'BUY' ? 1 : -1;
    totalArs += sign * leg.lots * GGAL_BYMA_LOT_SIZE * pxArs;
  }
  for (const opra of opraLegs) {
    const tExp = Math.max(1 / (24 * DAYS_PER_YEAR), (opra.expiryUtcSec - bymaEval.asOfUtcSec) / (DAYS_PER_YEAR * 86_400));
    const sigma = Math.max(minStressVol, opra.ivDecimal + ivShiftDecimal);
    const pxUsd = priceAmericanBjerksund2002({
      spot: spotAdrUsd,
      strike: opra.strikeUsd,
      timeToExpiry: tExp,
      rate: opra.rateUsdContinuous,
      dividendYield: opra.dividendYieldUsd ?? 0,
      volatility: sigma,
      contractType: opra.contractType,
    });
    if (!Number.isFinite(pxUsd)) {
      return null;
    }
    const sign = opra.side === 'BUY' ? 1 : -1;
    // opraLegs son por cada 10 lotes BYMA -> dividir por 10 para escala de 1 lote-estructura base
    totalArs += (sign * opra.contracts * OPRA_CONTRACT_SHARES * pxUsd * cclArs) / 10;
  }
  return totalArs;
}

/**
 * Ejecuta la matriz de estrés conjunta ADR + CCL + IV + LECAP (5 escenarios),
 * la simulación discreta determinista Merton Jump-Diffusion overnight 18h (Poisson k={0,1,2} ×
 * grilla cuantílica normal 2D) y el dimensionamiento óptimo Quarter-Kelly + CVaR 99 % + No-Ruin.
 */
export function evaluateTailStressAndSizing(
  input: TailStressAndSizingInput,
): StressTestMatrixOutput {
  const makeNoData = (reason: string): StressTestMatrixOutput => ({
    status: 'NO_DATA',
    reason,
    scenarioResults: [],
    worstScenarioId: 'NO_DATA',
    worstUnitLossArs: Number.NaN,
    overnightNodesCount: 0,
    overnightExpectedPnlPerUnitArs: Number.NaN,
    overnightStdDevPerUnitArs: Number.NaN,
    overnightMaxLossPerUnitArs: Number.NaN,
    overnightVar99PerUnitArs: Number.NaN,
    overnightCvar99PerUnitArs: Number.NaN,
    sizingBreakdown: {
      fullKellyLots: Number.NaN,
      quarterKellyLots: Number.NaN,
      noRuinCapLots: Number.NaN,
      cvar99CapLots: Number.NaN,
      drawdownCapLots: Number.NaN,
      collateralMarginCapLots: Number.NaN,
      bindingConstraint: 'NO_DATA',
    },
    recommendedBymaLots: 0,
    recommendedOpraContractsExact: 0,
    recommendedOpraContractsFloored: 0,
  });

  if (
    !isValidUtcSec(input.asOfUtcSec) ||
    !isPositiveFinite(input.spot24hArs) ||
    !isPositiveFinite(input.spotAdrUsd) ||
    !isPositiveFinite(input.cclArs) ||
    !isPositiveFinite(input.capitalArs) ||
    !Number.isFinite(input.totalEffectiveCollateralArs) ||
    !isFiniteNonNegative(input.marginRequiredPerUnitArs) ||
    input.bymaLegsPerUnit.length === 0 ||
    input.rateCurveArs.length === 0
  ) {
    return makeNoData('Entradas inválidas en evaluateTailStressAndSizing.');
  }

  const expiry1530UtcSec =
    input.expiry1530UtcSec ?? computeExpiration1530ArtUtcSec(input.expiryDateKey);
  if (!isValidUtcSec(expiry1530UtcSec) || expiry1530UtcSec <= input.asOfUtcSec) {
    return makeNoData('Fecha de vencimiento 15:30 ART inválida o expirada.');
  }

  const evalBaseInput: Parameters<typeof buildEvalParamsForSpot>[0] = {
    asOfUtcSec: input.asOfUtcSec,
    expiryDateKey: input.expiryDateKey,
    expiry1530UtcSec,
    rateCurve: input.rateCurveArs,
    ...(input.deltaAr1Days !== undefined ? { deltaAr1Days: input.deltaAr1Days } : {}),
    ...(input.deltaExDays !== undefined ? { deltaExDays: input.deltaExDays } : {}),
    ...(input.arHolidays !== undefined ? { arHolidays: input.arHolidays } : {}),
    ...(input.caucionRateContinuous !== undefined
      ? { caucionRateContinuous: input.caucionRateContinuous }
      : {}),
    ...(input.dividendsArs !== undefined ? { dividends: input.dividendsArs } : {}),
  };

  const baseEval = buildEvalParamsForSpot(evalBaseInput, input.spot24hArs);
  if (!baseEval) {
    return makeNoData('No pudo construirse EvalParams base BYMA.');
  }

  const opraLegs = input.opraLegsPerTenBymaLots ?? [];
  const baseUnitValueArs = priceUnitPortfolioArs(
    baseEval,
    input.bymaLegsPerUnit,
    opraLegs,
    input.spotAdrUsd,
    input.cclArs,
    0,
    MIN_CCP_STRESS_VOL,
  );
  if (baseUnitValueArs === null) {
    return makeNoData('Fallo en valoración base BS02 de piernas BYMA/OPRA.');
  }

  // Round-trip fees estimados por lote-estructura (DM + IVA entrada/salida sobre primas base)
  const unitPremiumFeeRoundTripArs =
    2 *
    input.bymaLegsPerUnit.reduce(
      (acc, l) => acc + l.optionPriceArs * GGAL_BYMA_LOT_SIZE * l.lots * BYMA_OPTION_PREMIUM_DM_RATE_WITH_IVA,
      0,
    );

  // 1) Evaluación de los 5 escenarios deterministas de estrés macro
  const scenarios = input.scenarios ?? DEFAULT_MACRO_STRESS_SCENARIOS;
  const scenarioResults: StressScenarioResult[] = [];
  let worstScenarioId = scenarios[0]?.id ?? 'NONE';
  let worstUnitLossArs = 0;

  for (const sc of scenarios) {
    const shockedAdrUsd = input.spotAdrUsd * (1 + sc.adrShockPct);
    const shockedCclArs = input.cclArs * (1 + sc.cclShockPct);
    const spotArsChangePct = (1 + sc.adrShockPct) * (1 + sc.cclShockPct) - 1;
    const shockedSpotArs = input.spot24hArs * (1 + spotArsChangePct);
    const lecapShiftDecimal = sc.lecapBpsShift / 10_000;

    const scEval = buildEvalParamsForSpot(evalBaseInput, shockedSpotArs, lecapShiftDecimal);
    if (!scEval) {
      return makeNoData(`Fallo en escenario ${sc.id}.`);
    }
    const scVal = priceUnitPortfolioArs(
      scEval,
      input.bymaLegsPerUnit,
      opraLegs,
      shockedAdrUsd,
      shockedCclArs,
      sc.ivShiftDecimal,
      MIN_CCP_STRESS_VOL,
    );
    if (scVal === null) {
      return makeNoData(`Fallo al valuar opciones en escenario ${sc.id}.`);
    }
    const portfolioPnlPerUnitArs = scVal - baseUnitValueArs - unitPremiumFeeRoundTripArs;

    // Impacto sobre colateral LECAP/bonos AR por cambio de tasas en bps
    let collateralRateImpactArs = 0;
    for (const c of input.collateralAssets) {
      const aforo = c.explicitAforo ?? FIXED_DEFAULT_AFORO[c.kind];
      if (!Number.isFinite(aforo) || !isFiniteNonNegative(c.marketValueArs)) {
        continue;
      }
      if (c.kind === 'LECAP' || c.kind === 'SOVEREIGN_BOND_AR') {
        const dur = c.modifiedDurationYears ?? 0;
        collateralRateImpactArs += c.marketValueArs * (aforo as number) * (-dur * lecapShiftDecimal);
      }
    }
    const stressedEffectiveCollateralArs = Math.max(
      0,
      input.totalEffectiveCollateralArs + collateralRateImpactArs,
    );
    const unitCapitalStressPct = (-portfolioPnlPerUnitArs / input.capitalArs) * 100;
    if (-portfolioPnlPerUnitArs > worstUnitLossArs) {
      worstUnitLossArs = -portfolioPnlPerUnitArs;
      worstScenarioId = sc.id;
    }

    scenarioResults.push({
      id: sc.id,
      label: sc.label,
      adrShockPct: sc.adrShockPct,
      cclShockPct: sc.cclShockPct,
      ivShiftDecimal: sc.ivShiftDecimal,
      lecapBpsShift: sc.lecapBpsShift,
      shockedAdrUsd,
      shockedCclArs,
      shockedSpotArs,
      spotArsChangePct,
      portfolioPnlPerUnitArs,
      collateralRateImpactArs,
      stressedEffectiveCollateralArs,
      unitCapitalStressPct,
    });
  }

  // 2) Simulación determinista overnight 18h Merton Jump-Diffusion (k={0,1,2} × grilla Z1 × Z2)
  const p = input.overnightParams;
  if (
    !Number.isFinite(p.muAdrAnnual) ||
    !isFiniteNonNegative(p.sigmaAdrDiffAnnual) ||
    !isFiniteNonNegative(p.lambdaJumpAdrAnnual) ||
    !Number.isFinite(p.jumpMeanAdr) ||
    !isFiniteNonNegative(p.jumpVolAdr) ||
    !Number.isFinite(p.muCclAnnual) ||
    !isFiniteNonNegative(p.sigmaCclDiffAnnual) ||
    !Number.isFinite(p.rhoDiffAdrCcl) ||
    Math.abs(p.rhoDiffAdrCcl) > 1 ||
    !Number.isFinite(p.cclCoJumpBeta) ||
    !isFiniteNonNegative(p.sigmaCoJumpCcl)
  ) {
    return makeNoData('Parámetros Jump-Diffusion overnight inválidos.');
  }

  const dt = OVERNIGHT_HORIZON_YEARS;
  const nZ1 = Math.max(5, Math.min(21, p.nAdrQuantiles ?? 9));
  const nZ2 = Math.max(3, Math.min(15, p.nCclQuantiles ?? 5));
  const lambdaDt = p.lambdaJumpAdrAnnual * dt;
  const p0 = Math.exp(-lambdaDt);
  const p1 = p0 * lambdaDt;
  const p2 = Math.max(0, 1 - p0 - p1);
  const poissonWeights: readonly { readonly k: number; readonly prob: number }[] = [
    { k: 0, prob: p0 },
    { k: 1, prob: p1 },
    { k: 2, prob: p2 },
  ];

  // Compensador de Merton E[exp(J_ADR) - 1]
  const kappaAdr = Math.exp(p.jumpMeanAdr + 0.5 * p.jumpVolAdr * p.jumpVolAdr) - 1;
  // Salto compuesto del CCL co-saltante
  const coJumpMeanCcl = p.cclCoJumpBeta * p.jumpMeanAdr;
  const coJumpVarCcl =
    p.cclCoJumpBeta * p.cclCoJumpBeta * p.jumpVolAdr * p.jumpVolAdr +
    p.sigmaCoJumpCcl * p.sigmaCoJumpCcl;
  const kappaCcl = Math.exp(coJumpMeanCcl + 0.5 * coJumpVarCcl) - 1;

  const adrDriftDt =
    (p.muAdrAnnual - 0.5 * p.sigmaAdrDiffAnnual * p.sigmaAdrDiffAnnual - p.lambdaJumpAdrAnnual * kappaAdr) * dt;
  const cclDriftDt =
    (p.muCclAnnual - 0.5 * p.sigmaCclDiffAnnual * p.sigmaCclDiffAnnual - p.lambdaJumpAdrAnnual * kappaCcl) * dt;
  const sqrtDt = Math.sqrt(dt);
  const orthCclScale = Math.sqrt(Math.max(0, 1 - p.rhoDiffAdrCcl * p.rhoDiffAdrCcl));

  // Evaluamos en t + 18h (en tNext = asOfUtcSec + 18*3600 salvo que supere expiración)
  const nextAsOfUtcSec = Math.min(expiry1530UtcSec - 60, input.asOfUtcSec + OVERNIGHT_HORIZON_HOURS * 3600);
  const nextEvalBase: Parameters<typeof buildEvalParamsForSpot>[0] = {
    ...evalBaseInput,
    asOfUtcSec: nextAsOfUtcSec,
  };

  interface OvernightNodeOutcome {
    readonly prob: number;
    readonly pnlPerUnitArs: number;
  }
  const nodes: OvernightNodeOutcome[] = [];

  for (const pw of poissonWeights) {
    if (pw.prob <= 0) {
      continue;
    }
    const cellProb = pw.prob / (nZ1 * nZ2);
    const totalAdrStd = Math.sqrt(
      p.sigmaAdrDiffAnnual * p.sigmaAdrDiffAnnual * dt + pw.k * p.jumpVolAdr * p.jumpVolAdr,
    );
    const jumpAdrMean = pw.k * p.jumpMeanAdr;

    for (let i = 0; i < nZ1; i++) {
      const z1 = invNormCdf((i + 0.5) / nZ1);
      // Descomposición exacta: componente total estándar z1 del ADR bajo k saltos
      const logRetAdr = adrDriftDt + jumpAdrMean + totalAdrStd * z1;
      const nodeAdrUsd = input.spotAdrUsd * Math.exp(logRetAdr);

      const jumpShare =
        totalAdrStd > 0 && pw.k > 0
          ? (Math.sqrt(pw.k) * p.jumpVolAdr) / totalAdrStd
          : 0;
      const jumpDev = jumpShare * totalAdrStd * z1;

      for (let j = 0; j < nZ2; j++) {
        const z2 = invNormCdf((j + 0.5) / nZ2);
        const cclDiffTerm =
          p.sigmaCclDiffAnnual * sqrtDt * (p.rhoDiffAdrCcl * z1 + orthCclScale * z2);
        const cclCoJumpTerm =
          pw.k * coJumpMeanCcl +
          p.cclCoJumpBeta * jumpDev +
          Math.sqrt(pw.k) * p.sigmaCoJumpCcl * z2;

        const nodeCclArs = input.cclArs * Math.exp(cclDriftDt + cclDiffTerm + cclCoJumpTerm);
        const nodeSpotArs =
          input.spot24hArs * (nodeAdrUsd / input.spotAdrUsd) * (nodeCclArs / input.cclArs);

        const nodeEval = buildEvalParamsForSpot(nextEvalBase, nodeSpotArs);
        if (!nodeEval) {
          return makeNoData('Fallo en nodo Jump-Diffusion overnight.');
        }
        const nodeVal = priceUnitPortfolioArs(
          nodeEval,
          input.bymaLegsPerUnit,
          opraLegs,
          nodeAdrUsd,
          nodeCclArs,
          0,
          MIN_CCP_STRESS_VOL,
        );
        if (nodeVal === null) {
          return makeNoData('Fallo al revaluar opciones en nodo Jump-Diffusion.');
        }
        nodes.push({
          prob: cellProb,
          pnlPerUnitArs: nodeVal - baseUnitValueArs - unitPremiumFeeRoundTripArs,
        });
      }
    }
  }

  // Estadísticos de la distribución discreta overnight + VaR/CVaR 99 %
  let expectedPnl = 0;
  let totalProb = 0;
  for (const n of nodes) {
    expectedPnl += n.prob * n.pnlPerUnitArs;
    totalProb += n.prob;
  }
  if (totalProb <= 0) {
    return makeNoData('Probabilidad total nula en grilla Jump-Diffusion.');
  }
  expectedPnl /= totalProb;

  let varPnl = 0;
  let maxLoss = 0;
  for (const n of nodes) {
    const diff = n.pnlPerUnitArs - expectedPnl;
    varPnl += (n.prob / totalProb) * diff * diff;
    if (-n.pnlPerUnitArs > maxLoss) {
      maxLoss = -n.pnlPerUnitArs;
    }
  }
  const stdDevPnl = Math.sqrt(varPnl);

  // Ordenar por pérdida descendente (-pnl descendente) para VaR/CVaR 99% exacto
  const sortedByLossDesc = [...nodes].sort((a, b) => a.pnlPerUnitArs - b.pnlPerUnitArs);
  const alpha = DEFAULT_CVAR_CONFIDENCE_ALPHA;
  let cumTailProb = 0;
  let tailLossWeighted = 0;
  let var99 = 0;
  for (const n of sortedByLossDesc) {
    const pNorm = n.prob / totalProb;
    const loss = Math.max(0, -n.pnlPerUnitArs);
    if (cumTailProb >= alpha) {
      break;
    }
    const takeProb = Math.min(pNorm, alpha - cumTailProb);
    tailLossWeighted += takeProb * loss;
    cumTailProb += takeProb;
    var99 = loss;
  }
  const cvar99 = cumTailProb > 0 ? tailLossWeighted / cumTailProb : 0;

  // 3) Dimensionamiento óptimo Quarter-Kelly + CVaR 99 % + No-Ruin + Margen/Drawdown
  const kellyFraction = input.kellyFraction ?? DEFAULT_KELLY_FRACTION;
  const noRuinFactor = input.noRuinCapitalFactor ?? DEFAULT_NO_RUIN_CAPITAL_FACTOR;
  const maxCvar99Pct = input.maxCvar99PctOfCapital ?? DEFAULT_MAX_CVAR_99_PCT;
  const maxDrawdownPct = input.maxDrawdownPctOfCapital ?? DEFAULT_MAX_DRAWDOWN_PCT;

  const expectedReturnPerLot = expectedPnl / input.capitalArs;
  const varianceReturnPerLot = varPnl / (input.capitalArs * input.capitalArs);
  const fullKellyLots =
    expectedReturnPerLot > 0 && varianceReturnPerLot > 0
      ? expectedReturnPerLot / varianceReturnPerLot
      : 0;
  const quarterKellyLots = kellyFraction * fullKellyLots;

  const noRuinCapLots = maxLoss > 0 ? (noRuinFactor * input.capitalArs) / maxLoss : Infinity;
  const cvar99CapLots = cvar99 > 0 ? (maxCvar99Pct * input.capitalArs) / cvar99 : Infinity;
  const drawdownCapLots =
    worstUnitLossArs > 0 ? (maxDrawdownPct * input.capitalArs) / worstUnitLossArs : Infinity;
  const collateralMarginCapLots =
    input.marginRequiredPerUnitArs > 0 && input.totalEffectiveCollateralArs >= 0
      ? input.totalEffectiveCollateralArs / input.marginRequiredPerUnitArs
      : input.totalEffectiveCollateralArs >= 0
        ? Infinity
        : 0;

  const caps: readonly { readonly label: string; readonly val: number }[] = [
    { label: 'Quarter-Kelly 0.25x', val: quarterKellyLots },
    { label: 'No-Ruin Overnight (95%)', val: noRuinCapLots },
    { label: 'CVaR 99% Budget', val: cvar99CapLots },
    { label: 'Max Stress Drawdown', val: drawdownCapLots },
    { label: 'BYMA Clearing Collateral', val: collateralMarginCapLots },
  ];
  let bestLots = Infinity;
  let bindingConstraint = 'Quarter-Kelly 0.25x';
  for (const c of caps) {
    if (c.val < bestLots) {
      bestLots = c.val;
      bindingConstraint = c.label;
    }
  }
  const recommendedBymaLots = Math.max(0, Math.floor(Number.isFinite(bestLots) ? bestLots : 0));
  const adrsPerLot = GGAL_BYMA_LOT_SIZE / GGAL_ADR_RATIO; // 10 ADRs por lote BYMA
  const opraRatioPerLot = adrsPerLot / OPRA_CONTRACT_SHARES; // 0.10 contratos OPRA por lote BYMA
  const recommendedOpraContractsExact = recommendedBymaLots * opraRatioPerLot;
  const recommendedOpraContractsFloored = Math.floor(recommendedOpraContractsExact);

  return {
    status: 'OK',
    scenarioResults,
    worstScenarioId,
    worstUnitLossArs,
    overnightNodesCount: nodes.length,
    overnightExpectedPnlPerUnitArs: expectedPnl,
    overnightStdDevPerUnitArs: stdDevPnl,
    overnightMaxLossPerUnitArs: maxLoss,
    overnightVar99PerUnitArs: var99,
    overnightCvar99PerUnitArs: cvar99,
    sizingBreakdown: {
      fullKellyLots,
      quarterKellyLots,
      noRuinCapLots,
      cvar99CapLots,
      drawdownCapLots,
      collateralMarginCapLots,
      bindingConstraint,
    },
    recommendedBymaLots,
    recommendedOpraContractsExact,
    recommendedOpraContractsFloored,
  };
}

function sampleMean(vals: readonly number[]): number {
  let sum = 0;
  for (const v of vals) sum += v;
  return vals.length > 0 ? sum / vals.length : Number.NaN;
}

function sampleStd(vals: readonly number[], mean: number): number {
  if (vals.length < 2) return 0;
  let ss = 0;
  for (const v of vals) {
    const d = v - mean;
    ss += d * d;
  }
  return Math.sqrt(ss / (vals.length - 1));
}

/**
 * Calibra parámetros deterministas Merton Jump-Diffusion + co-salto CCL desde
 * series históricas alineadas (sin inventar datos; retorna `null` si < 15 observaciones).
 */
export function calibrateOvernightJumpDiffusionFromSeries(
  series: readonly { readonly adrCloseUsd: number; readonly cclGgal: number }[],
): OvernightJumpDiffusionParams | null {
  if (series.length < 15) {
    return null;
  }
  const rAdr: number[] = [];
  const rCcl: number[] = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1];
    const curr = series[i];
    if (
      prev === undefined ||
      curr === undefined ||
      !isPositiveFinite(prev.adrCloseUsd) ||
      !isPositiveFinite(curr.adrCloseUsd) ||
      !isPositiveFinite(prev.cclGgal) ||
      !isPositiveFinite(curr.cclGgal)
    ) {
      return null;
    }
    rAdr.push(Math.log(curr.adrCloseUsd / prev.adrCloseUsd));
    rCcl.push(Math.log(curr.cclGgal / prev.cclGgal));
  }
  const n = rAdr.length;
  if (n < 14) {
    return null;
  }
  const meanAdr = sampleMean(rAdr);
  const stdAdrAll = sampleStd(rAdr, meanAdr);
  const meanCcl = sampleMean(rCcl);
  const stdCclAll = sampleStd(rCcl, meanCcl);
  if (!Number.isFinite(stdAdrAll) || stdAdrAll <= 0 || !Number.isFinite(stdCclAll) || stdCclAll <= 0) {
    return null;
  }

  const threshold = 2.0 * stdAdrAll;
  const jumpIdx: number[] = [];
  const normIdx: number[] = [];
  for (let i = 0; i < n; i++) {
    const val = rAdr[i];
    if (val === undefined) {
      continue;
    }
    if (Math.abs(val - meanAdr) > threshold) {
      jumpIdx.push(i);
    } else {
      normIdx.push(i);
    }
  }

  const diffIndices = normIdx.length >= 5 ? normIdx : rAdr.map((_, idx) => idx);
  const normAdrVals: number[] = [];
  const normCclVals: number[] = [];
  for (const idx of diffIndices) {
    const va = rAdr[idx];
    const vc = rCcl[idx];
    if (va !== undefined && vc !== undefined) {
      normAdrVals.push(va);
      normCclVals.push(vc);
    }
  }
  const mNormAdr = sampleMean(normAdrVals);
  const mNormCcl = sampleMean(normCclVals);
  const sNormAdr = sampleStd(normAdrVals, mNormAdr);
  const sNormCcl = sampleStd(normCclVals, mNormCcl);

  let covNorm = 0;
  for (let k = 0; k < normAdrVals.length; k++) {
    const va = normAdrVals[k];
    const vc = normCclVals[k];
    if (va !== undefined && vc !== undefined) {
      covNorm += (va - mNormAdr) * (vc - mNormCcl);
    }
  }
  const rhoDiff =
    normAdrVals.length >= 2 && sNormAdr > 0 && sNormCcl > 0
      ? clamp(covNorm / ((normAdrVals.length - 1) * sNormAdr * sNormCcl), -0.99, 0.99)
      : 0;

  let lambdaJumpAdrAnnual = 0;
  let jumpMeanAdr = 0;
  let jumpVolAdr = 0;
  let cclCoJumpBeta = 0;
  let sigmaCoJumpCcl = 0;
  if (jumpIdx.length > 0) {
    lambdaJumpAdrAnnual = (jumpIdx.length / n) * 252;
    const jAdr: number[] = [];
    const jCcl: number[] = [];
    for (const idx of jumpIdx) {
      const va = rAdr[idx];
      const vc = rCcl[idx];
      if (va !== undefined && vc !== undefined) {
        jAdr.push(va);
        jCcl.push(vc);
      }
    }
    jumpMeanAdr = sampleMean(jAdr);
    jumpVolAdr = jAdr.length >= 2 ? sampleStd(jAdr, jumpMeanAdr) : Math.abs(jumpMeanAdr) * 0.5;
    if (jAdr.length >= 2) {
      const mJc = sampleMean(jCcl);
      let ssAdr = 0;
      let sp = 0;
      for (let k = 0; k < jAdr.length; k++) {
        const va = jAdr[k];
        const vc = jCcl[k];
        if (va !== undefined && vc !== undefined) {
          const da = va - jumpMeanAdr;
          const dc = vc - mJc;
          ssAdr += da * da;
          sp += da * dc;
        }
      }
      cclCoJumpBeta = ssAdr > 1e-12 ? sp / ssAdr : 0;
      const resids = jCcl.map((c, k) => c - cclCoJumpBeta * (jAdr[k] ?? 0));
      sigmaCoJumpCcl = sampleStd(resids, sampleMean(resids));
    } else {
      const ja0 = jAdr[0] ?? 0;
      const jc0 = jCcl[0] ?? 0;
      cclCoJumpBeta = Math.abs(ja0) > 1e-8 ? jc0 / ja0 : 0;
      sigmaCoJumpCcl = sNormCcl;
    }
  }

  return {
    muAdrAnnual: meanAdr * 252,
    sigmaAdrDiffAnnual: sNormAdr * Math.sqrt(252),
    lambdaJumpAdrAnnual,
    jumpMeanAdr,
    jumpVolAdr,
    muCclAnnual: meanCcl * 252,
    sigmaCclDiffAnnual: sNormCcl * Math.sqrt(252),
    rhoDiffAdrCcl: rhoDiff,
    cclCoJumpBeta,
    sigmaCoJumpCcl,
    nAdrQuantiles: 9,
    nCclQuantiles: 5,
  };
}
