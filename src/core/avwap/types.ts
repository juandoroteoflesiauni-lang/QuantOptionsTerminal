import type { Bar } from '../types.js';
import type { WelfordState } from '../welford.js';

export type { Bar, WelfordState };

export type AvwapEmpiricalRole = 'INSTITUTIONAL_CONTEXT_ONLY';

export type AvwapEmpiricalGateStatus =
  | 'TIER_2_CONTEXT_ONLY'
  | 'CORE_INTRADAY_BENCHMARK'
  | 'ACCOUNTING_IDENTITY_AGE_LT_2Y'
  | 'REJECT_NO_EDGE'
  | 'REJECT_NO_EDGE_AUTONOMOUS_CONTEXT_CORE'
  | 'REJECT_NO_EDGE_REFUTED'
  | 'INSUFFICIENT_SAMPLE'
  | 'NEGATIVE_CONTROL_PASS_PRUNED';

export type AvwapPolicyTier =
  | 'CORE_CONTEXT'
  | 'EVENT_AND_STRUCTURAL_CONTEXT'
  | 'DEMOTED_OR_DISABLED_BY_DEFAULT';

export type AvwapAnchorFamily =
  | 'SESSION_VWAP'
  | 'CALENDAR_YTD'
  | 'EARNINGS_BLOWOUT'
  | 'IPO_DIRECT'
  | 'CALENDAR_QTD'
  | 'VOLUME_CLIMAX'
  | 'BREAKAWAY_GAP'
  | 'MACRO_SHOCK'
  | 'SECONDARY_OFFERING'
  | 'INDEX_REBAL'
  | 'OPTIONS_FLOW_SHOCK'
  | 'SWING_CAUSAL'
  | 'POST_OPEX'
  | 'EARNINGS_INLINE'
  | 'SWING_NO_RVOL'
  | 'EX_DIVIDEND_REGULAR';

export type AvwapDegradationFlag =
  | 'FLOAT_NON_PIT_SNAPSHOT'
  | 'NO_ORATS_COVERAGE'
  | 'ORATS_OI_FALLBACK_MASSIVE'
  | 'MISSING_WHAM_COVERAGE'
  | 'NO_NBBO_AGGRESSOR_SIDE'
  | 'NO_NOI_IMBALANCE_FEED'
  | 'CORP_ACTION_CONFLICT_QUARANTINED'
  | 'SHORT_GAMMA_BOUNCE_HAZARD';

export type AvwapLifecycleState =
  | 'CANDIDATE'
  | 'ACTIVE_PRIMARY'
  | 'ACTIVE_SECONDARY'
  | 'PINCH_PAIR'
  | 'DECAYING'
  | 'ARCHIVED';

export type AvwapPolarity = 'LONG' | 'SHORT' | 'NEUTRAL';

export type AvwapTimeframe = '1m' | '5m' | '15m' | '30m' | '65m' | '1H' | '4H' | '1D' | '1W';

export type AvwapGammaRegime = 'POSITIVE_GAMMA' | 'NEGATIVE_GAMMA' | 'NEUTRAL' | 'UNKNOWN';
export type AvwapVolRegime = 'LOW_VOL_CHOP' | 'MID_VOL' | 'HIGH_VOL_TREND' | 'UNKNOWN';
export type AvwapVarianceSource = 'PEBAY_EXACT_1M' | 'RANGE_PARKINSON_FALLBACK';

/**
 * Pure weighted moment accumulator directly compatible with `src/core/welford.ts` (`WelfordState`).
 */
export interface WeightedMomentState extends WelfordState {
  readonly varianceSource: AvwapVarianceSource;
}

export function toWelfordState(state: WeightedMomentState): WelfordState {
  return {
    count: state.count,
    cumWeight: state.cumWeight,
    mean: state.mean,
    m2: state.m2,
  };
}

export function fromWelfordState(
  state: WelfordState,
  varianceSource: AvwapVarianceSource = 'PEBAY_EXACT_1M',
): WeightedMomentState {
  return {
    count: state.count,
    cumWeight: state.cumWeight,
    mean: state.mean,
    m2: state.m2,
    varianceSource,
  };
}

export interface IassConfig {
  readonly configVersion: string;
  readonly weightM: number;
  readonly weightD: number;
  readonly weightF: number;
  readonly weightS: number;
  readonly degradationPrior: number;
  readonly tier1Min: number;
  readonly tier2Min: number;
  readonly floatTurnoverScale: number;
  readonly dMoveLogisticK: number;
  readonly dShockScale: number;
  readonly sGapScale: number;
  readonly sDispScale: number;
  readonly mSubweights: Readonly<{
    M_rvol: number;
    M_float: number;
    M_auction: number;
  }>;
  readonly dSubweights: Readonly<{
    D_move: number;
    D_shock: number;
    D_iv: number;
    D_term: number;
  }>;
  readonly sSubweights: Readonly<{
    S_gap: number;
    S_disp: number;
  }>;
  readonly surpriseFloor: number;
  readonly surpriseTanhScale: number;
  readonly surpriseBlendWeight: number;
}

export interface IassFeatures {
  readonly family: string;
  readonly polarity?: AvwapPolarity;
  readonly featureAsof: number;
  readonly oratsOpraCovered?: boolean;
  readonly oiSource?: string | null;
  readonly rvolZ?: number | null;
  readonly floatTurnoverPct?: number | null;
  readonly floatIsPit?: boolean;
  readonly floatAsofUtcSec?: number | null;
  readonly allowNonPitFloatSensitivity?: boolean;
  readonly auctionRatioZ?: number | null;
  readonly realizedReturn?: number | null;
  readonly realizedReturnStartTsUtcSec?: number | null;
  readonly impliedMoveDec?: number | null;
  readonly impliedMoveAvailableAtUtcSec?: number | null;
  readonly oiGexShock?: number | null;
  readonly ivChangeZ?: number | null;
  readonly termTransitionScore?: number | null;
  readonly catalystDataAvailable?: boolean;
  readonly actualValue?: number | null;
  readonly estimatedValue?: number | null;
  readonly surpriseIsPitVerified?: boolean;
  readonly surpriseAvailableAtUtcSec?: number | null;
  readonly gapAtr?: number | null;
  readonly closeDispAtr?: number | null;
  readonly atrValid?: boolean;
  readonly atrAvailableAtUtcSec?: number | null;
}

export interface IassBreakdown {
  readonly configVersion: string;
  readonly family: string;
  readonly polarity: AvwapPolarity;
  /** Ratio in [0.0, 1.0]; 0.70 when ORATS OPRA derivatives are missing. */
  readonly dataCoverage: number;
  readonly prior: number;
  readonly componentCoverage: Readonly<{
    M: number;
    D: number;
    F: number;
    S: number;
  }>;
  readonly scoreRenormalized: number | null;
  /** Bayesian shrinkage: `dataCoverage * scoreRenormalized + (1 - dataCoverage) * prior`. */
  readonly scoreConservative: number;
  readonly pillarScores: Readonly<{
    M: number | null;
    D: number | null;
    F: number | null;
    S: number | null;
  }>;
  readonly componentScores: Readonly<Record<string, number | null>>;
  readonly tier: 'TIER_1' | 'TIER_2' | 'NOISE' | 'INSUFFICIENT_DATA';
  readonly status: 'OK' | 'PARTIAL_COVERAGE' | 'INSUFFICIENT_DATA';
  readonly degradationReasons: readonly string[];
  readonly featureAsof: number;
}

export interface HybridBandsInput {
  readonly avwapMu: number;
  readonly welfordSd: number;
  readonly orIvXern20dDec: number | null;
  readonly elapsedTradingDays: number;
  readonly tau0?: number;
}

export interface HybridBandSnapshot {
  readonly avwapMu: number;
  readonly welfordSd: number;
  /** Annualized `or_iv_xern_20d_dec` path dispersion if available, else NaN. */
  readonly sigmaOratsPath: number;
  /** Single trading day implied 1-sigma move: `avwapMu * (orIvXern20dDec / sqrt(252))`. */
  readonly expectedMove1d: number;
  readonly alpha: number;
  readonly sigmaHybrid: number;
  readonly bandSource: 'HYBRID_ORATS_WELFORD' | 'WELFORD_ONLY_FALLBACK';
  readonly upper1: number;
  readonly lower1: number;
  readonly upper2: number;
  readonly lower2: number;
  readonly upper2_5: number;
  readonly lower2_5: number;
}

export type AvwapAlignedLevelType =
  | 'CALL_WALL'
  | 'PUT_WALL'
  | 'ZERO_GAMMA'
  | 'VP_POC'
  | 'VP_VAH'
  | 'VP_VAL'
  | 'VP_HVN'
  | 'VP_LVN';

export interface AvwapAlignedLevel {
  readonly levelType: AvwapAlignedLevelType;
  readonly price: number;
  readonly distanceAtr: number;
  readonly kernelWeight: number;
}

export interface AvwapSpatialKernels {
  readonly callWall: number;
  readonly putWall: number;
  readonly zeroGamma: number;
  readonly vpPoc: number;
  readonly vpVah: number;
  readonly vpVal: number;
  readonly vpHvnMax: number;
  readonly vpLvnMax: number;
}

export interface AvwapConfluenceInput {
  readonly avwapPrice: number;
  readonly spotPrice: number;
  readonly atr14: number;
  readonly polarity?: AvwapPolarity;
  readonly netGex?: number | null;
  readonly dollarVol20d: number;
  readonly callWall?: number | null;
  readonly putWall?: number | null;
  readonly zeroGamma?: number | null;
  readonly vpPoc?: number | null;
  readonly vpVah?: number | null;
  readonly vpVal?: number | null;
  readonly vpHvns?: readonly number[];
  readonly vpLvns?: readonly number[];
  readonly cvdAbsorptionScore?: number | null;
  readonly cvdDirectionalAlignment?: number | null;
  readonly bucketRvolZ?: number | null;
  readonly contango?: number | null;
  readonly spyIv30dDec?: number | null;
  readonly sigmaHybrid?: number | null;
  readonly extraDegradationFlags?: readonly AvwapDegradationFlag[];
}

export interface AvwapConfluenceContext {
  readonly role: AvwapEmpiricalRole;
  readonly bounceConfluenceScore: number;
  readonly breakoutConfluenceScore: number;
  /** `g = tanh(NetGEX / (0.01 * DollarVol_20d))`; NaN when NetGEX unavailable. */
  readonly netGexNormalizedG: number;
  readonly g0DollarVolScale: number;
  readonly gammaRegime: AvwapGammaRegime;
  readonly volRegime: AvwapVolRegime;
  readonly meanReversionContextActive: boolean;
  readonly alignedLevels: readonly AvwapAlignedLevel[];
  readonly spatialKernels: AvwapSpatialKernels;
  readonly hazardFlags: readonly AvwapDegradationFlag[];
  readonly flags: readonly AvwapDegradationFlag[];
  readonly bounceMultiplier: number;
  readonly breakoutMultiplier: number;
}

export interface InstitutionalVannaCharmInput {
  readonly spot: number;
  readonly strike: number;
  readonly dteDays: number;
  readonly smvVol: number;
  readonly riskFree: number;
  readonly residualRate?: number;
  readonly contractType?: 'call' | 'put';
}

export interface InstitutionalVannaCharmResult {
  readonly contractType: 'call' | 'put';
  readonly spot: number;
  readonly strike: number;
  readonly dteDays: number;
  readonly timeToExpiryYears: number;
  readonly smvVol: number;
  readonly riskFree: number;
  readonly residualRate: number;
  readonly dividendYieldQ: number;
  readonly d1: number;
  readonly d2: number;
  readonly price: number;
  readonly delta: number;
  readonly gamma: number;
  readonly vega: number;
  readonly vanna: number;
  readonly charm: number;
  readonly charmDaily: number;
}

export interface AvwapFamilyPolicyRule {
  readonly family: AvwapAnchorFamily;
  readonly tier: AvwapPolicyTier;
  readonly empiricalGateStatus: AvwapEmpiricalGateStatus;
  readonly enabledByDefault: boolean;
  readonly minIassConservative: number | null;
  readonly pinchEligible: boolean;
  readonly notes: string;
  readonly whamSupportedEtfs: readonly string[] | null;
  readonly whamUnsupportedEtfs: readonly string[] | null;
  readonly enabledAsSrDefault: boolean | null;
  readonly showOpexResetMarker: boolean | null;
  readonly blockedNegativeControl: boolean;
}

export interface AvwapVisualBudgetPolicy {
  readonly weeklyDailyBase: number;
  readonly weeklyDailyPinchBonus: number;
  readonly intradayMidBase: number;
  readonly intradayFastBase: number;
  readonly intradayFastMacroRefBonus: number;
  readonly intradayMacroRefMaxDistAtr: number;
  readonly topDownBoundDailyAtr: number;
  readonly topDownBoundIntradayAtr: number;
}

export interface AvwapRegimeModifiersPolicy {
  readonly kernelSigmaAtr: number;
  readonly gexScaleDollarVolFrac: number;
  readonly shortGammaHazardGThreshold: number;
  readonly shortGammaHazardFlag: 'SHORT_GAMMA_BOUNCE_HAZARD';
  readonly positiveGammaWallOrVpMaxDistAtr: number;
  readonly spyIvLowChopMax: number;
  readonly spyIvMidMax: number;
  readonly negativeGammaEvidence: string;
  readonly highVolEvidence: string;
}

export interface AvwapContextPolicy {
  readonly policyVersion: string;
  readonly sourceOracleConfigVersion: string;
  readonly sourceStudy: string;
  readonly mode: 'INSTITUTIONAL_CONTEXT_AND_CONFLUENCE_ONLY';
  readonly autonomousTier1EntrySignalsEnabled: false;
  readonly earningsImpliedMoveContract: string;
  readonly coreContext: readonly AvwapFamilyPolicyRule[];
  readonly eventAndStructuralContext: readonly AvwapFamilyPolicyRule[];
  readonly demotedOrDisabledByDefault: readonly AvwapFamilyPolicyRule[];
  readonly visualBudget: AvwapVisualBudgetPolicy;
  readonly regimeModifiers: AvwapRegimeModifiersPolicy;
  readonly mandatoryDegradationFlags: readonly AvwapDegradationFlag[];
}

export interface InstitutionalAvwapAnchor {
  readonly anchorId: string;
  readonly symbol: string;
  readonly role: AvwapEmpiricalRole;
  readonly family: AvwapAnchorFamily;
  readonly policyTier: AvwapPolicyTier;
  readonly empiricalGateStatus: AvwapEmpiricalGateStatus;
  readonly polarity: AvwapPolarity;
  /** Bar-open timestamp in UTC seconds (never milliseconds). */
  readonly anchorTimeSec: number;
  readonly activatedTimeSec: number;
  readonly availableAtUtcSec: number;
  readonly lifecycleState: AvwapLifecycleState;
  readonly visibleOnChart: boolean;
  readonly pinchPartnerId: string | null;
  readonly moments: WeightedMomentState;
  readonly bands: HybridBandSnapshot;
  readonly iass: IassBreakdown;
  readonly confluence: AvwapConfluenceContext;
  readonly distanceToSpotAtr: number;
  readonly degradationFlags: readonly AvwapDegradationFlag[];
}

/**
 * Dual O(1) provider-agnostic live bar accumulator designed for normalized ticks
 * (such as `TradierStreamTick` in Phase 2B). Massive WS remains disabled.
 */
export interface LiveBarAccumulator {
  readonly minuteBucketUtcSec: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly welford: WelfordState;
  readonly lastTickUtcSec: number | null;
  readonly tickCount: number;
  readonly symbol: string | null;
  readonly adjSig: string | null;
  readonly source: 'TRADIER_WS' | 'GENERIC_LIVE';
}

export interface LiveAnchorProjection {
  readonly state: WelfordState;
  readonly avwap: number;
  readonly stdDev: number;
  readonly cumWeight: number;
  readonly m2: number;
  readonly count: number;
  readonly minuteBucketUtcSec: number;
  readonly lastTickUtcSec: number | null;
}

export interface MultiTimeframeAvwapConfig {
  readonly mode: 'INSTITUTIONAL_CONTEXT_AND_CONFLUENCE_ONLY';
  readonly policyVersion: string;
  readonly visualBudgetByTimeframe: Readonly<Record<AvwapTimeframe, number>>;
  readonly topDownMaxDistanceAtr: Readonly<{
    daily: number;
    intraday: number;
  }>;
  readonly pinchPairAllowsExtraSlot: boolean;
  readonly postOpexShowResetMarkerDefault: boolean;
  readonly blockedNegativeControls: readonly ('EARNINGS_INLINE' | 'SWING_NO_RVOL' | 'EX_DIVIDEND_REGULAR')[];
  readonly liveMergeThrottleMs: 50;
}

/** Compact section attachable to `UsOptionsIntelligenceSnapshotV1.technical` in Phase 2. */
export interface UsOptionsAvwapContextExportPayload {
  readonly role: AvwapEmpiricalRole;
  readonly policyVersion: string;
  readonly timeframe: AvwapTimeframe;
  readonly activeAnchors: readonly InstitutionalAvwapAnchor[];
  readonly opexResetMarkerDates: readonly string[];
  readonly degradationFlags: readonly AvwapDegradationFlag[];
}
