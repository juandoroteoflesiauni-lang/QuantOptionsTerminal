/**
 * Phase 2 TypeScript Draft Contracts for AVWAP Institutional Context & Confluence.
 *
 * ISOLATION NOTE: This `.draft.ts` lives strictly inside `research/avwap_oracle/spec/`
 * during Phase 1 closure and is NOT compiled by root `tsconfig.json`.
 *
 * Real repository coupling targets audited on HEAD (`b4ce753`) + options export (`f7aa019`):
 *  - `src/core/types.ts`: `Bar` (`time` UTC seconds, `open`, `high`, `low`, `close`, `volume`, `vw?`)
 *  - `src/core/welford.ts`: `WelfordState` (`count`, `cumWeight`, `mean`, `m2`), `combineWelfordStates`
 *  - `src/core/avwapCanonicalMonth.ts`: `CanonicalMonthDto`, `CanonicalMonthLiveState`, `AvwapSeedContract`
 *  - `src/core/usHistorical.ts`: `UsSession`, `HistoricalMoments` (`PV`, `V`, `P2V`)
 *  - `src/server/tradierAdapter.ts` & `src/server/tradierStream.ts`: `TradierStreamTick`
 *  - `src/core/microstructure/multiHorizonVolumeProfile.ts`: `HorizonVolumeProfile`, `VolumeProfileNodeZone`
 *  - `src/core/microstructure/cvdAbsorption.ts`: `CvdBarEvaluation`, `PassiveAbsorptionEvent`
 *  - `src/core/sessionKeyLevels.ts`: `SessionLevelsDto`
 *  - `web/src/data/liveTypes.ts`: `UsTerminalBarsResponseDto`, `UsSnapshotResponseDto`
 *  - `src/core/options/usOptionsIntelligenceExportTypes.ts` (`f7aa019`): `UsOptionsIntelligenceSnapshotV1`
 */

export type AvwapEmpiricalRole = 'INSTITUTIONAL_CONTEXT_ONLY';

export type AvwapEmpiricalGateStatus =
  | 'TIER_2_CONTEXT_ONLY'
  | 'CORE_INTRADAY_BENCHMARK'
  | 'ACCOUNTING_IDENTITY_AGE_LT_2Y'
  | 'REJECT_NO_EDGE'
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

/** Pure weighted moment accumulator directly compatible with `src/core/welford.ts` (`WelfordState`). */
export interface WeightedMomentState {
  readonly count: number;
  /** Cumulative volume `W` (0 -> neutral state with NaN mean). */
  readonly cumWeight: number;
  /** Volume-weighted mean `mu` (AVWAP). NaN when `cumWeight === 0`. */
  readonly mean: number;
  /** Second central moment sum `M2 = sum_i V_i * (P_i - mu)^2`. */
  readonly m2: number;
  readonly varianceSource: 'PEBAY_EXACT_1M' | 'RANGE_PARKINSON_FALLBACK';
}

export interface IassBreakdown {
  readonly configVersion: string;
  readonly family: AvwapAnchorFamily;
  readonly polarity: AvwapPolarity;
  /** Ratio in [0.0, 1.0]; 0.70 when ORATS OPRA derivatives are missing. */
  readonly dataCoverage: number;
  readonly prior: number;
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
}

export interface HybridBandSnapshot {
  readonly avwapMu: number;
  readonly welfordSd: number;
  /** Annualized `or_iv_xern_20d_dec` path dispersion if available, else NaN. */
  readonly sigmaOratsPath: number;
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

export interface AvwapConfluenceContext {
  readonly role: AvwapEmpiricalRole;
  readonly bounceConfluence: number;
  readonly breakoutConfluence: number;
  /** `g = tanh(NetGEX / (0.01 * DollarVol_20d))`; NaN when NetGEX unavailable. */
  readonly netGexNormalizedG: number;
  readonly gammaRegime: AvwapGammaRegime;
  readonly volRegime: AvwapVolRegime;
  readonly meanReversionContextActive: boolean;
  readonly spatialKernels: Readonly<{
    callWall: number;
    putWall: number;
    zeroGamma: number;
    vpPoc: number;
    vpVah: number;
    vpVal: number;
    vpHvnMax: number;
    vpLvnMax: number;
  }>;
  readonly flags: readonly AvwapDegradationFlag[];
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
 * Dual O(1) per-symbol live accumulator driven strictly by `TradierStreamTick`
 * (`src/server/tradierStream.ts`). Massive WS is banned from live execution.
 */
export interface LiveBarAccumulator {
  readonly symbol: string;
  /** Invariant adjustment revision from `UsHistoricalService.adjustmentRevision(symbol)`. */
  readonly adjSig: string;
  /** ET minute-open bucket in UTC seconds. */
  readonly currentBucketTimeSec: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly lastCumulativeDayVolume: number;
  readonly provisionalMinuteVolume: number;
  /** Accumulated `sum(price * volume)` within open live minute; NaN if zero tick volume. */
  readonly provisionalPv: number;
  /** Accumulated `M2` within open live minute for 7-FLOP parallel Pebay merge. */
  readonly provisionalM2: number;
  readonly lastTickUtcSec: number;
  readonly source: 'TRADIER_WS';
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
