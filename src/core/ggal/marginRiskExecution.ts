import { isIsoContractDate } from './anexoBIdentity.js';
import type { AdrQuoteQualityMode } from './adrQuoteIntegrity.js';
import type { BymaStrikeResolutionStatus } from './bymaContractResolver.js';
import type { AmericanIvStatus, MarginModelBasis, MarginRiskStatus } from '../options/ivContract.js';
import type { ArMarketFieldSource, ContractMultiplierSource } from '../options/oiProvenance.js';
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
export const DEFAULT_CROSS_COLLATERAL_OFFSET_RATIO = 0;
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
  readonly underlying?: string;
  readonly expiryDateKey?: string;
  readonly expiryUtcSec?: number;
  readonly contractMultiplier?: number;
  readonly multiplierSource?: ContractMultiplierSource;
  readonly currency?: 'ARS' | 'USD';
  readonly exerciseStyle?: 'AMERICAN' | 'EUROPEAN';
  readonly ivStatus?: AmericanIvStatus;
  readonly quoteSource?: ArMarketFieldSource;
  readonly quoteAsOfUtcSec?: number | null;
  readonly strikeResolutionStatus?: BymaStrikeResolutionStatus;
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
  readonly crossCollateralEligibility?: {
    readonly verifiedByClearingRule: boolean;
    readonly maxOffsetRatio: number;
    readonly offsetRatio?: number;
  };
  readonly positionBasis?: 'DECLARED_POSITION' | 'SIMULATED_STRATEGY_TEMPLATE';
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

const CLEARING_RULE_HIERARCHY = [
  { basis: 'OFFICIAL_CLEARING_RULE_OR_TARIFF', source: 'Tarifario BYMA Ago-2026 y Circular 3588 §1.3',
    scope: 'Derechos + IVA, lotes BYMA, liquidación T+0/T+1 y corte 15:30 ART' },
  { basis: 'BROKER_OR_USER_DECLARED', source: 'Insumos declarados por usuario o ALyC',
    scope: 'Aforos locales, acciones en tenencia y elegibilidad de compensación' },
  { basis: 'INTERNAL_RISK_MODEL_ESTIMATE', source: 'Modelo interno CCP BS02',
    scope: 'Grilla spot/volatilidad, piso escalonado, buffers y aforos no locales' },
  { basis: 'SIMULATION_OR_STRESS_PROXY', source: 'Motor 6',
    scope: 'Plantillas de posición, escenarios de estrés y sizing' },
] as const;

interface StrategyValidation {
  readonly requestedStrategyKind: BymaClearingStrategyKind;
  readonly effectiveStrategyKind: BymaClearingStrategyKind;
  readonly matchesLegs: boolean;
  readonly code: string;
  readonly detail: string;
}

export interface StrategyMarginBreakdownItem {
  readonly applicableToCurrentLegs: boolean;
  readonly evaluationBasis: 'ACTUAL_POSITION_MATCH' | 'NOT_APPLICABLE_TO_CURRENT_LEGS';
  readonly applicabilityReason: string;
  readonly strategyKind: BymaClearingStrategyKind;
  readonly label: string;
  readonly ccpRiskArrayLossArs: number;
  readonly steppedFloorArs: number;
  readonly requiredMarginArs: number;
}

export interface MarginAndRiskOutput {
  readonly riskStatus: MarginRiskStatus;
  readonly marginModelBasis: MarginModelBasis;
  readonly clearingRuleHierarchy: typeof CLEARING_RULE_HIERARCHY;
  readonly strategyValidation: StrategyValidation;
  readonly positionBasis: NonNullable<BymaClearingMarginInput['positionBasis']>;
  readonly assumptions: readonly string[];
  readonly degradedLegs: readonly { readonly ticker: string; readonly side: OrderSide; readonly reason: string }[];
  readonly conservativeIntrinsicFloorArs: number;
  readonly conservativeIntrinsicFloorBasis: 'LOWER_BOUND_DIAGNOSTIC_ONLY';
  readonly appliedCrossOffsetRatio: number;
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
  readonly adrQuoteMode?: AdrQuoteQualityMode;
  readonly adrBidUsd?: number | null;
  readonly adrAskUsd?: number | null;
  readonly adrExecutableL1?: boolean;
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
  readonly adrBookDiagnostics?: {
    readonly adrBookQuality: AdrQuoteQualityMode;
    readonly adrBidUsd: number;
    readonly adrAskUsd: number;
    readonly adrSpreadUsd: number;
    readonly adrExecutableL1: boolean;
    readonly crossVenueExecutionAllowed: boolean;
    readonly adrExecutionBlockedReason: string | null;
  };
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
  readonly spotAdrPriceBasis?: 'L1_MID' | 'LAST_TRADE' | 'EOD_CLOSE' | 'NONE';
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
  readonly spotAdrPriceBasis?: 'L1_MID' | 'LAST_TRADE' | 'EOD_CLOSE' | 'NONE';
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
const CLEARING_STRATEGIES = Object.keys(STRATEGY_LABELS) as BymaClearingStrategyKind[];

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

type VerifiedMarginLeg = BymaMarginLegInput & {
  readonly underlying: string;
  readonly expiryDateKey: string;
  readonly expiryUtcSec: number;
  readonly contractMultiplier: number;
};
type LegPair = readonly [VerifiedMarginLeg, VerifiedMarginLeg];

export function classifyAndValidateMarginStructure(input: BymaClearingMarginInput) {
  const verified: VerifiedMarginLeg[] = [];
  const invalid: { ticker: string; side: OrderSide; reason: string }[] = [];
  const degraded: typeof invalid = [];
  const allImplicit = input.legs.every((leg) => leg.underlying === undefined);
  const underlyings = new Set(input.legs.map((leg) => leg.underlying?.trim().toUpperCase()));
  const mixedUnderlying = !allImplicit && (underlyings.size !== 1 || underlyings.has(undefined));
  const shares = input.underlyingSharesHeld ?? 0;
  for (const leg of input.legs) {
    const underlying = allImplicit ? 'GGAL' : leg.underlying?.trim().toUpperCase() ?? '';
    const expiryDateKey = leg.expiryDateKey ?? input.expiryDateKey;
    const expiryUtcSec = leg.expiryUtcSec ?? (expiryDateKey === input.expiryDateKey ? input.expiry1530UtcSec : undefined)
      ?? computeExpiration1530ArtUtcSec(expiryDateKey);
    const contractMultiplier = leg.contractMultiplier ?? (underlying === 'GGAL' ? GGAL_BYMA_LOT_SIZE : Number.NaN);
    const multiplierSource = leg.multiplierSource ??
      (underlying === 'GGAL' && contractMultiplier === GGAL_BYMA_LOT_SIZE ? 'BYMA_STANDARD_TABLE' : 'UNVERIFIED');
    const reason = mixedUnderlying || underlying === '' ? 'MIXED_UNDERLYING'
      : leg.currency !== undefined && leg.currency !== 'ARS' ? 'CURRENCY_MISMATCH'
      : leg.exerciseStyle !== undefined && leg.exerciseStyle !== 'AMERICAN' ? 'UNSUPPORTED_EXERCISE_STYLE'
      : leg.strikeResolutionStatus !== undefined &&
          leg.strikeResolutionStatus !== 'EXPLICIT_METADATA' &&
          leg.strikeResolutionStatus !== 'CANONICAL_SYMBOL'
        ? 'AMBIGUOUS_STRIKE_SCALE'
      : multiplierSource === 'UNVERIFIED' || !Number.isSafeInteger(contractMultiplier) || contractMultiplier <= 0
        ? 'UNVERIFIED_MULTIPLIER'
      : !isIsoContractDate(expiryDateKey) || !isValidUtcSec(expiryUtcSec) || expiryUtcSec <= input.asOfUtcSec ||
        expiryUtcSec !== computeExpiration1530ArtUtcSec(expiryDateKey) ? 'INVALID_CONTRACTUAL_EXPIRY'
      : !Number.isSafeInteger(leg.lots) || leg.lots <= 0 || !isPositiveFinite(leg.strikeArs) ||
        !Number.isSafeInteger(shares) || shares < 0 ? 'INVALID_LEG_OR_HOLDING' : null;
    if (reason !== null) {
      invalid.push({ ticker: leg.ticker, side: leg.side, reason });
      continue;
    }
    const ivReason = leg.ivStatus !== undefined && leg.ivStatus !== 'SOLVED_AMERICAN' ? leg.ivStatus
      : !isPositiveFinite(leg.ivDecimal) ? 'INVALID_IV'
      : !isPositiveFinite(leg.optionPriceArs) ? 'MISSING_OBSERVED_PRICE' : null;
    if (ivReason !== null) {
      (leg.side === 'SELL' ? invalid : degraded).push({ ticker: leg.ticker, side: leg.side, reason: ivReason });
    } else {
      verified.push({ ...leg, underlying, expiryDateKey, expiryUtcSec, contractMultiplier, multiplierSource });
    }
  }
  const queue = (side: OrderSide) => verified.filter((leg) => leg.side === side)
    .map((leg) => ({ leg, remaining: leg.lots }))
    .sort((a, b) => a.leg.expiryUtcSec - b.leg.expiryUtcSec || a.leg.strikeArs - b.leg.strikeArs ||
      a.leg.ticker.localeCompare(b.leg.ticker));
  const longs = queue('BUY');
  const shorts = queue('SELL');
  const debitCoveredPairs: LegPair[] = [];
  const creditSpreadPairs: LegPair[] = [];
  for (const protective of [true, false]) {
    for (const short of shorts) {
      const { leg } = short;
      const candidates = longs.filter(({ leg: long, remaining }) =>
        remaining > 0 && long.contractType === leg.contractType && long.expiryUtcSec >= leg.expiryUtcSec &&
        long.contractMultiplier === leg.contractMultiplier &&
        (leg.contractType === 'call' ? long.strikeArs <= leg.strikeArs : long.strikeArs >= leg.strikeArs) === protective,
      ).sort((a, b) => a.leg.expiryUtcSec - b.leg.expiryUtcSec ||
        Math.abs(a.leg.strikeArs - leg.strikeArs) - Math.abs(b.leg.strikeArs - leg.strikeArs));
      for (const long of candidates) {
        if (short.remaining === 0) break;
        const lots = Math.min(short.remaining, long.remaining);
        short.remaining -= lots;
        long.remaining -= lots;
        (protective ? debitCoveredPairs : creditSpreadPairs).push([{ ...leg, lots }, { ...long.leg, lots }]);
      }
    }
  }
  let remainingShares = shares;
  let shareCoveredCallLots = 0;
  for (const short of shorts) {
    if (short.leg.contractType !== 'call') continue;
    const lots = Math.min(short.remaining, Math.floor(remainingShares / short.leg.contractMultiplier));
    remainingShares -= lots * short.leg.contractMultiplier;
    short.remaining -= lots;
    shareCoveredCallLots += lots;
  }
  const uncoveredShortLegs = shorts.filter(({ remaining }) => remaining > 0)
    .map(({ leg, remaining }) => ({ ...leg, lots: remaining }));
  const hasStrangle = uncoveredShortLegs.some((call) => call.contractType === 'call' &&
    uncoveredShortLegs.some((put) => put.contractType === 'put' && put.expiryUtcSec === call.expiryUtcSec &&
      put.contractMultiplier === call.contractMultiplier));
  const shortLots = shorts.reduce((sum, { leg }) => sum + leg.lots, 0);
  const longLots = longs.reduce((sum, { leg }) => sum + leg.lots, 0);
  const debitLots = debitCoveredPairs.reduce((sum, [leg]) => sum + leg.lots, 0);
  const creditLots = creditSpreadPairs.reduce((sum, [leg]) => sum + leg.lots, 0);
  const twoLeg = verified.length === 2 && shortLots > 0 && longLots > 0;
  const applicable: Record<BymaClearingStrategyKind, boolean> = {
    UNCOVERED_SHORT: uncoveredShortLegs.length > 0 && debitLots === 0 && creditLots === 0 && shareCoveredCallLots === 0,
    VERTICAL_DEBIT_SPREAD: twoLeg && debitLots === shortLots && shortLots === longLots,
    VERTICAL_CREDIT_SPREAD: creditLots > 0,
    RATIO_SPREAD_1X2: twoLeg && debitLots === longLots && shortLots === 2 * longLots,
    RATIO_SPREAD_1X3: twoLeg && debitLots === longLots && shortLots === 3 * longLots,
    SHORT_STRADDLE_STRANGLE: hasStrangle,
    COVERED_CALL: shareCoveredCallLots > 0 && uncoveredShortLegs.length === 0 && debitLots === 0 && creditLots === 0,
    CROSS_COLLATERAL_STRATEGY: verified.length > 1 && shortLots > 0 && longLots > 0,
  };
  return { verified, invalid, degraded, debitCoveredPairs, creditSpreadPairs, shareCoveredCallLots, uncoveredShortLegs, applicable };
}

function computeSteppedUncoveredFloorArs(spot: number, shorts: readonly VerifiedMarginLeg[]): number {
  return shorts.reduce((sum, leg) =>
    sum + leg.lots * leg.contractMultiplier * spot * computeOtmSteppedFloorRate(spot, leg.strikeArs, leg.contractType), 0);
}

type CcpGrid = { readonly worstLossArs: number; readonly worstNode: CcpGridNodeResult; readonly oppositeAtWorst: boolean };
function evaluatePortfolioCcpGrid(
  baseInput: Parameters<typeof buildEvalParamsForSpot>[0],
  spot: number,
  legs: readonly VerifiedMarginLeg[],
  spotShocks: readonly number[],
  volShocks: readonly number[],
  minStressVol: number,
): CcpGrid | null {
  const values = (currentSpot: number, volShock: number) => legs.map((leg) => {
    const params = buildEvalParamsForSpot({
      ...baseInput, expiryDateKey: leg.expiryDateKey, expiry1530UtcSec: leg.expiryUtcSec,
    }, currentSpot);
    const price = params === null ? Number.NaN
      : priceBymaAmericanBs02(params, leg.strikeArs, Math.max(minStressVol, leg.ivDecimal + volShock), leg.contractType);
    return (leg.side === 'BUY' ? 1 : -1) * leg.lots * leg.contractMultiplier * price;
  });
  const baseValues = values(spot, 0);
  if (!baseValues.every(Number.isFinite)) return null;
  let worst: CcpGrid | null = null;
  for (const ds of spotShocks) {
    const shockedSpotArs = spot * (1 + ds);
    if (!isPositiveFinite(shockedSpotArs)) continue;
    for (const dv of volShocks) {
      const losses = values(shockedSpotArs, dv).map((value, index) => (baseValues[index] ?? Number.NaN) - value);
      if (!losses.every(Number.isFinite)) return null;
      const loss = Math.max(0, losses.reduce((sum, amount) => sum + amount, 0));
      if (worst === null || loss > worst.worstLossArs) {
        worst = { worstLossArs: loss,
          worstNode: { spotShockPct: ds, volShockDecimal: dv, shockedSpotArs, portfolioMtmLossArs: loss },
          oppositeAtWorst: losses.some((value) => value > 0) && losses.some((value) => value < 0) };
      }
    }
  }
  return worst;
}

function evaluateStrategyRequiredMargin(
  input: BymaClearingMarginInput,
  structure: ReturnType<typeof classifyAndValidateMarginStructure>,
  baseInput: Parameters<typeof buildEvalParamsForSpot>[0],
) {
  const spot = input.spot24hArs;
  const grid = (legs: readonly VerifiedMarginLeg[]) => evaluatePortfolioCcpGrid(
    baseInput, spot, legs, input.spotShocks ?? DEFAULT_CCP_SPOT_SHOCKS, input.volShocks ?? DEFAULT_CCP_VOL_SHOCKS,
    input.minStressVol ?? MIN_CCP_STRESS_VOL,
  );
  const portfolio = grid(structure.verified);
  if (portfolio === null) return null;
  let ccp = 0;
  let floor = 0;
  let required = 0;
  let worstNode = portfolio.worstNode;
  const uncovered = structure.uncoveredShortLegs.map((leg) => ({ leg, lots: leg.lots }));
  for (const pair of structure.creditSpreadPairs) {
    const result = grid(pair);
    if (result === null) return null;
    const [short, long] = pair;
    const cap = Math.abs(short.strikeArs - long.strikeArs) * short.contractMultiplier * short.lots;
    const pairCcp = Math.min(result.worstLossArs, cap);
    const pairFloor = Math.min(computeSteppedUncoveredFloorArs(spot, [short]), cap);
    ccp += pairCcp;
    floor += pairFloor;
    required += Math.max(pairCcp, pairFloor);
  }
  if (input.strategyKind === 'SHORT_STRADDLE_STRANGLE') {
    for (const call of uncovered.filter(({ leg }) => leg.contractType === 'call')) {
      for (const put of uncovered.filter(({ leg }) => leg.contractType === 'put' &&
        leg.expiryUtcSec === call.leg.expiryUtcSec && leg.contractMultiplier === call.leg.contractMultiplier)) {
        const lots = Math.min(call.lots, put.lots);
        if (lots === 0) continue;
        call.lots -= lots;
        put.lots -= lots;
        const callLeg = { ...call.leg, lots };
        const putLeg = { ...put.leg, lots };
        const callGrid = grid([callLeg]);
        const putGrid = grid([putLeg]);
        if (callGrid === null || putGrid === null) return null;
        const callFloor = computeSteppedUncoveredFloorArs(spot, [callLeg]);
        const putFloor = computeSteppedUncoveredFloorArs(spot, [putLeg]);
        const callMargin = Math.max(callGrid.worstLossArs, callFloor);
        const putMargin = Math.max(putGrid.worstLossArs, putFloor);
        const opposite = callMargin >= putMargin ? putLeg : callLeg;
        const intrinsic = Math.max(0, opposite.contractType === 'call' ? spot - opposite.strikeArs : opposite.strikeArs - spot);
        required += Math.max(callMargin, putMargin) +
          Math.max(intrinsic, opposite.optionPriceArs) * opposite.contractMultiplier * lots;
        floor += callFloor + putFloor;
      }
    }
  }
  const remainder = uncovered.filter(({ lots }) => lots > 0).map(({ leg, lots }) => ({ ...leg, lots }));
  if (remainder.length > 0) {
    const result = grid(remainder);
    if (result === null) return null;
    const remainderFloor = computeSteppedUncoveredFloorArs(spot, remainder);
    ccp += result.worstLossArs;
    floor += remainderFloor;
    required += Math.max(result.worstLossArs, remainderFloor);
    worstNode = result.worstNode;
  }
  const eligibility = input.crossCollateralEligibility;
  let appliedCrossOffsetRatio = 0;
  if (input.strategyKind === 'CROSS_COLLATERAL_STRATEGY' && structure.applicable.CROSS_COLLATERAL_STRATEGY) {
    const requested = eligibility?.offsetRatio ?? input.crossCollateralOffsetRatio ?? DEFAULT_CROSS_COLLATERAL_OFFSET_RATIO;
    if (eligibility?.verifiedByClearingRule === true && portfolio.oppositeAtWorst &&
        Number.isFinite(requested) && Number.isFinite(eligibility.maxOffsetRatio)) {
      appliedCrossOffsetRatio = clamp(requested, 0, clamp(eligibility.maxOffsetRatio, 0, 1));
    }
    const portfolioLoss = portfolio.worstLossArs * (1 - appliedCrossOffsetRatio);
    ccp = appliedCrossOffsetRatio > 0 ? portfolioLoss : Math.max(ccp, portfolioLoss);
    required = appliedCrossOffsetRatio > 0 ? Math.max(floor, portfolioLoss) : Math.max(required, portfolioLoss);
    worstNode = portfolio.worstNode;
  }
  if (structure.applicable.VERTICAL_DEBIT_SPREAD || structure.applicable.SHORT_STRADDLE_STRANGLE) {
    ccp = Math.max(ccp, portfolio.worstLossArs);
    worstNode = portfolio.worstNode;
  }
  return { ccpRiskArrayLossArs: ccp, worstNode: { ...worstNode, portfolioMtmLossArs: ccp },
    steppedFloorArs: floor, requiredMarginArs: required, appliedCrossOffsetRatio };
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
  const structure = classifyAndValidateMarginStructure(input);
  const positionBasis = input.positionBasis ?? 'DECLARED_POSITION';
  const assumptions: string[] = [];
  if (positionBasis === 'SIMULATED_STRATEGY_TEMPLATE') {
    assumptions.push('Patas elegidas por la plantilla del simulador.');
    if (input.strategyKind === 'COVERED_CALL') {
      assumptions.push(`Tenencia evaluada: ${String(input.underlyingSharesHeld)} acciones.`);
    }
  }
  if (input.collateralAssets.some((asset) => asset.explicitAforo === undefined &&
      asset.kind !== 'CASH_ARS' && FIXED_DEFAULT_AFORO[asset.kind] !== undefined)) {
    assumptions.push('Aforos del modelo interno para colateral no local.');
  }
  const invalidUnits = structure.invalid.some(({ reason }) =>
    ['MIXED_UNDERLYING', 'CURRENCY_MISMATCH', 'UNVERIFIED_MULTIPLIER', 'UNSUPPORTED_EXERCISE_STYLE'].includes(reason));
  const conservativeIntrinsicFloorArs = invalidUnits || !isPositiveFinite(input.spot24hArs)
    ? Number.NaN : input.legs.reduce((sum, leg) => {
    if (leg.side !== 'SELL' || !isPositiveFinite(leg.strikeArs) || !isPositiveFinite(leg.lots)) return sum;
    const multiplier = leg.contractMultiplier ?? GGAL_BYMA_LOT_SIZE;
    const intrinsic = Math.max(0, leg.contractType === 'call'
      ? input.spot24hArs - leg.strikeArs : leg.strikeArs - input.spot24hArs);
    return sum + intrinsic * multiplier * leg.lots;
  }, 0);
  const matchesLegs = structure.applicable[input.strategyKind];
  const effectiveStrategyKind = matchesLegs ? input.strategyKind : CLEARING_STRATEGIES
    .find((kind) => structure.applicable[kind]) ?? 'UNCOVERED_SHORT';
  const strategyValidation = {
    requestedStrategyKind: input.strategyKind, effectiveStrategyKind, matchesLegs,
    code: matchesLegs ? 'MATCHES_POSITION' : structure.uncoveredShortLegs.length > 0
      ? 'STRATEGY_MISMATCH_UNCOVERED_SHORT_DETECTED' : 'STRATEGY_MISMATCH',
    detail: matchesLegs ? 'Estructura acreditada por las patas.' : 'Se aplican las garantías de las patas y la tenencia verificadas.',
  };
  const evidence = {
    marginModelBasis: 'INTERNAL_CCP_BS02_MODEL' as const,
    clearingRuleHierarchy: CLEARING_RULE_HIERARCHY, positionBasis, assumptions,
    strategyValidation, degradedLegs: [...structure.invalid, ...structure.degraded],
    conservativeIntrinsicFloorArs, conservativeIntrinsicFloorBasis: 'LOWER_BOUND_DIAGNOSTIC_ONLY' as const,
  };
  const makeNoData = (reason: string): MarginAndRiskOutput => ({
    ...evidence,
    riskStatus: 'INDETERMINATE_MARGIN',
    appliedCrossOffsetRatio: 0,
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
    strategyReferenceMatrix: CLEARING_STRATEGIES.map((strategyKind) => ({
      strategyKind, label: STRATEGY_LABELS[strategyKind], applicableToCurrentLegs: false,
      evaluationBasis: 'NOT_APPLICABLE_TO_CURRENT_LEGS', applicabilityReason: reason,
      ccpRiskArrayLossArs: Number.NaN, steppedFloorArs: Number.NaN, requiredMarginArs: Number.NaN,
    })),
  });

  if (
    !isValidUtcSec(input.asOfUtcSec) ||
    !isPositiveFinite(input.spot24hArs) ||
    input.legs.length === 0 ||
    input.rateCurveArs.length === 0
  ) {
    return makeNoData('Entradas inválidas o vacías en evaluateBymaClearingMargin.');
  }
  if (structure.invalid.length > 0 || structure.verified.length === 0) {
    return makeNoData(structure.invalid[0]?.reason ?? 'NO_VALID_LEGS');
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

  const liquidBufferRate = input.liquidBufferRate ?? DEFAULT_LIQUID_BUFFER_RATE;
  const wwrSurchargeRate = input.wrongWayRiskSurchargeRate ?? DEFAULT_WWR_SURCHARGE_RATE;
  const sharesHeld = input.underlyingSharesHeld ?? 0;
  const activeStrategyMargin = evaluateStrategyRequiredMargin(input, structure, evalBaseInput);
  if (!activeStrategyMargin) {
    return makeNoData('No pudo evaluarse la grilla BS02 CCP BYMA.');
  }

  const collateralEval = evaluateCollateralPortfolio(input.collateralAssets);
  const baseRequiredMarginArs = collateralEval.status === 'OK'
    ? activeStrategyMargin.requiredMarginArs : Number.NaN;
  const liquidBufferArs = baseRequiredMarginArs * liquidBufferRate;

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
    const multiplier = leg.contractMultiplier ?? GGAL_BYMA_LOT_SIZE;
    const premNotional = isFiniteNonNegative(leg.optionPriceArs) ? leg.optionPriceArs * multiplier * leg.lots : Number.NaN;
    const sign = leg.side === 'SELL' ? 1 : -1;
    t0GrossPremiumCashflowArs += sign * premNotional;
    grossOptionNotionalArs += premNotional;
    grossStrikeExerciseNotionalArs += leg.strikeArs * multiplier * leg.lots;
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
  const strategyReferenceMatrix = CLEARING_STRATEGIES.map((kind): StrategyMarginBreakdownItem => {
    const applicable = structure.applicable[kind] &&
      (kind !== 'CROSS_COLLATERAL_STRATEGY' || activeStrategyMargin.appliedCrossOffsetRatio > 0);
    const res = applicable ? kind === input.strategyKind ? activeStrategyMargin
      : evaluateStrategyRequiredMargin({ ...input, strategyKind: kind }, structure, evalBaseInput) : null;
    return {
      strategyKind: kind,
      label: STRATEGY_LABELS[kind],
      applicableToCurrentLegs: applicable,
      evaluationBasis: applicable ? 'ACTUAL_POSITION_MATCH' : 'NOT_APPLICABLE_TO_CURRENT_LEGS',
      applicabilityReason: applicable ? 'Patas y tenencia compatibles.' : 'Las patas o la tenencia no acreditan la regla.',
      ccpRiskArrayLossArs: res?.ccpRiskArrayLossArs ?? Number.NaN,
      steppedFloorArs: res?.steppedFloorArs ?? Number.NaN,
      requiredMarginArs: collateralEval.status === 'OK' ? res?.requiredMarginArs ?? Number.NaN : Number.NaN,
    };
  });
  if (activeStrategyMargin.appliedCrossOffsetRatio > 0) assumptions.push('Compensación con elegibilidad declarada.');
  const crossUnverified = input.strategyKind === 'CROSS_COLLATERAL_STRATEGY' && activeStrategyMargin.appliedCrossOffsetRatio === 0;
  return {
    ...evidence,
    strategyValidation: crossUnverified ? { ...strategyValidation,
      code: 'CROSS_COLLATERAL_OFFSET_NOT_VERIFIED', detail: 'Sin compensación acreditada en el peor nodo.' } : strategyValidation,
    appliedCrossOffsetRatio: activeStrategyMargin.appliedCrossOffsetRatio,
    riskStatus: collateralEval.status !== 'OK' ? 'INDETERMINATE_MARGIN'
      : structure.degraded.length > 0 ? 'PARTIAL_COVERAGE_CONSERVATIVE'
      : assumptions.length > 0 ? 'ESTIMATED_WITH_ASSUMPTIONS' : 'VALID_MODEL_MARGIN',
    status: collateralEval.status === 'OK' ? 'OK' : 'NO_DATA',
    strategyKind: input.strategyKind,
    spot24hArs: input.spot24hArs,
    expiryDateKey: input.expiryDateKey,
    ccpRiskArrayLossArs: activeStrategyMargin.ccpRiskArrayLossArs,
    worstCcpNode: activeStrategyMargin.worstNode,
    steppedFloorArs: activeStrategyMargin.steppedFloorArs,
    baseRequiredMarginArs,
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

  const adrBookDiagnostics: ExecutionMicrostructureOutput['adrBookDiagnostics'] =
    input.adrQuoteMode !== undefined
      ? (() => {
          const adrBookQuality = input.adrQuoteMode;
          const adrBidRaw =
            input.adrBidUsd !== undefined &&
            input.adrBidUsd !== null &&
            isPositiveFinite(input.adrBidUsd)
              ? input.adrBidUsd
              : Number.NaN;
          const adrAskRaw =
            input.adrAskUsd !== undefined &&
            input.adrAskUsd !== null &&
            isPositiveFinite(input.adrAskUsd)
              ? input.adrAskUsd
              : Number.NaN;
          const adrExecutableL1 =
            input.adrExecutableL1 === true &&
            adrBookQuality === 'LIVE_BID_ASK' &&
            isPositiveFinite(adrBidRaw) &&
            isPositiveFinite(adrAskRaw) &&
            adrAskRaw >= adrBidRaw;
          const adrBidUsd = adrExecutableL1 ? adrBidRaw : Number.NaN;
          const adrAskUsd = adrExecutableL1 ? adrAskRaw : Number.NaN;
          const adrSpreadUsd = adrExecutableL1 ? adrAskRaw - adrBidRaw : Number.NaN;
          const crossVenueExecutionAllowed =
            adrExecutableL1 && validBookPrices && gate1FreshnessPassed && input.telemetryMode === 'LIVE';
          const adrExecutionBlockedReason = adrExecutableL1
            ? null
            : adrBookQuality === 'EOD_CLOSE_REF'
              ? 'MARKET_EOD_REFERENCE_ONLY'
              : 'ADR_NO_BILATERAL_L1_BBO';
          return {
            adrBookQuality,
            adrBidUsd,
            adrAskUsd,
            adrSpreadUsd,
            adrExecutableL1,
            crossVenueExecutionAllowed,
            adrExecutionBlockedReason,
          };
        })()
      : undefined;

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
    ...(adrBookDiagnostics !== undefined ? { adrBookDiagnostics } : {}),
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
    totalArs += sign * leg.lots * (leg.contractMultiplier ?? GGAL_BYMA_LOT_SIZE) * pxArs;
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
      (acc, l) => acc + l.optionPriceArs * (l.contractMultiplier ?? GGAL_BYMA_LOT_SIZE) * l.lots * BYMA_OPTION_PREMIUM_DM_RATE_WITH_IVA,
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
    ...(input.spotAdrPriceBasis !== undefined ? { spotAdrPriceBasis: input.spotAdrPriceBasis } : {}),
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
