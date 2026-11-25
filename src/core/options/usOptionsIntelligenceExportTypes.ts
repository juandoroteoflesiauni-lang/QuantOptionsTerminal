/**
 * Contratos DTO versionados v1 para US Options Intelligence Export Engine (Pieza EXPORT-1).
 * 100 % tipos puros TypeScript — cero DOM, cero React, cero red.
 */

import type {
  UsOptionContractRowDto,
  UsSnapshotResponseDto,
  UsTerminalBarsResponseDto,
  UsVolSurfaceResponseDto,
} from '../../../web/src/data/liveTypes.js';
import type { CatalystWindowResult } from './catalysts.js';
import type { LiquiditySemaphore } from './verticalSpreads.js';

export interface UsVolAnalyticsExpiryRef {
  readonly expiryCode?: string;
  readonly expirationDate?: string;
  readonly daysToExpiry?: number;
  readonly smileOtmOnly?: {
    readonly atmIvPct?: number | null;
    readonly iv25DeltaCallPct?: number | null;
    readonly iv25DeltaPutPct?: number | null;
    readonly riskReversal25DeltaPp?: number | null;
    readonly callVsPutSkewPp?: number | null;
  } & Record<string, unknown>;
  readonly expectedCone?: {
    readonly horizonMove1SigmaPct?: number | null;
    readonly upper1Sigma?: number | null;
    readonly lower1Sigma?: number | null;
    readonly upper2Sigma?: number | null;
    readonly lower2Sigma?: number | null;
  } & Record<string, unknown>;
  readonly activeExpiryVrp?: {
    readonly status?: string;
    readonly ivAtmActiveExpiryPct?: number | null;
    readonly ivSource?: string | null;
    readonly vrpActiveExpiryPts?: number | null;
    readonly ivRankActiveExpiry?: number | null;
    readonly ivPercentileActiveExpiry?: number | null;
    readonly operativeRegime?: {
      readonly code?: string;
      readonly label?: string;
      readonly rationale?: string;
    } | null;
  } & Record<string, unknown>;
  readonly ratiosAndStructures?: {
    readonly status?: string;
    readonly structures?: readonly ({
      readonly id: string;
      readonly name: string;
      readonly legsLabel: string;
      readonly costPctOfMaxProfit: number | null;
      readonly bs2002HistoricalPercentile: number | null;
      readonly bs2002HistoricalMedianPct: number | null;
      readonly bs2002HistoricalObs?: number | null;
    } & Record<string, unknown>)[];
  } & Record<string, unknown>;
}

export const US_OPTIONS_EXPORT_SCHEMA_VERSION = '1.0.0' as const;
export const TARGET_MARKDOWN_BUDGET_BYTES = 15_360;

export type SnapshotMode = 'intraday' | 'swing';
export type SnapshotFormat = 'markdown' | 'pdf';
export type SwingChainFilterMode = 'DELTA_005_055' | 'SIGMA_1_5' | 'SIGMA_2_0';
export type UsSessionRegime = 'PRE' | 'RTH' | 'POST' | 'CLOSED' | 'UNKNOWN';
export type BlockQualityStatus = 'OK' | 'PARTIAL' | 'STALE' | 'EOD_REFERENCE' | 'UNAVAILABLE';
export type RealMoneynessClass = 'ITM' | 'ATM' | 'OTM' | 'UNKNOWN';

export const PRECISION_POLICY = Object.freeze({
  spotAndLevelUsd: 2,
  optionPremiumUsd: 2,
  lowPremiumUsd: 4,
  lowPremiumThreshold: 1.0,
  percent: 2,
  volPoints: 2,
  delta: 4,
  gamma: 5,
  smallGammaThreshold: 0.001,
  smallGamma: 6,
  thetaDaily: 4,
  vegaPer1Pct: 4,
  exposureUsd: 0,
  contractsInt: 0,
  ratio: 2,
});

export interface ExportUsOptionsSnapshotRequest {
  readonly ticker: string;
  readonly expirations: readonly string[];
  readonly mode: SnapshotMode;
  readonly format: SnapshotFormat;
  readonly includeCharts: boolean;
  readonly chartTimeframes?: readonly ('15m' | '1h')[];
  readonly swingChainFilter?: SwingChainFilterMode;
  readonly allowExceedSizeBudget?: boolean;
}

export interface DualTimezoneTimestamp {
  readonly utcSec: number;
  readonly isoUtc: string;
  readonly etFormatted: string;
  readonly artFormatted: string;
  readonly etDateKey: string;
}

export interface UnifiedContractCalcInput {
  readonly ticker: string;
  readonly contractType: 'call' | 'put';
  readonly strike: number;
  readonly spot: number;
  readonly bid: number | null | undefined;
  readonly ask: number | null | undefined;
  readonly lastPrice: number | null | undefined;
  readonly volume: number | null | undefined;
  readonly openInterest: number | null | undefined;
  readonly ivDecimal: number | null | undefined;
  readonly ivSource: string;
  readonly delta: number | null | undefined;
  readonly gamma: number | null | undefined;
  readonly thetaDaily: number | null | undefined;
  readonly vegaPer1Pct: number | null | undefined;
  readonly strikeGex: number | null | undefined;
  readonly sharesPerContract: number | null | undefined;
  readonly exerciseStyle: string | null | undefined;
  readonly settlementType: string | null | undefined;
  readonly valuationModel: string | null | undefined;
  readonly quoteQuality: string | null | undefined;
  readonly quoteSource: string | null | undefined;
  readonly quoteTimestampUtcSec: number | null | undefined;
}

export interface UnifiedContractCalcResult {
  readonly ticker: string;
  readonly contractType: 'call' | 'put';
  readonly strike: number;
  readonly validBook: boolean;
  readonly bookInvalidReason: string | null;
  readonly bid: number;
  readonly ask: number;
  readonly mid: number;
  readonly spreadUsd: number;
  readonly spreadPct: number;
  readonly delta: number;
  readonly gamma: number;
  readonly thetaDaily: number;
  readonly vegaPer1Pct: number;
  readonly ivPct: number;
  readonly ivSource: string;
  readonly intrinsic: number;
  readonly timeValue: number;
  readonly volume: number;
  readonly volumeKnown: boolean;
  readonly openInterest: number;
  readonly openInterestKnown: boolean;
  readonly gex: number;
  readonly distanceSpotPct: number;
  readonly moneynessClass: RealMoneynessClass;
  readonly sharesPerContract: number;
  readonly sharesPerContractKnown: boolean;
  readonly exerciseStyle: string;
  readonly settlementType: string;
  readonly valuationModel: string;
  readonly quoteQuality: string;
  readonly quoteSource: string | null;
  readonly quoteTimestampUtcSec: number | null;
}

export interface CreditLegCalcInput {
  readonly contractType: 'call' | 'put';
  readonly side: 'BUY' | 'SELL';
  readonly strike: number;
  readonly quantity: number;
  readonly bid: number | null | undefined;
  readonly ask: number | null | undefined;
  readonly quoteQuality?: string | null | undefined;
}

export interface MultiLegCreditCalcResult {
  readonly validBboAllLegs: boolean;
  readonly invalidReason: string | null;
  readonly midCreditPerShare: number;
  readonly conservativeCreditPerShare: number;
  readonly midCreditContractUsd: number;
  readonly conservativeCreditContractUsd: number;
  readonly widthPerShare: number;
  readonly widthContractUsd: number;
  readonly maxProfitPerShare: number;
  readonly maxLossPerShare: number;
  readonly maxProfitContractUsd: number;
  readonly maxLossContractUsd: number;
  readonly riskRewardRatio: number;
  readonly breakevens: readonly number[];
}

export interface UsVolAnalyticsSuiteCompatRef {
  readonly status: 'OK' | 'NO_DATA';
  readonly market?: 'BYMA' | 'US';
  readonly underlying?: string;
  readonly spot?: number;
  readonly rateContinuous?: number;
  readonly rateTeaPct?: number;
  readonly benchmarkLabel?: string;
  readonly dividendYield?: number;
  readonly activeExpiryCode?: string | null;
  readonly hasDualAdr?: boolean;
  readonly nonDualMessage?: string | null;
  readonly moneynessMatrixOtm?: {
    readonly status?: string;
    readonly termRegime?: string;
    readonly termSpreadPp?: number | null;
  } & Record<string, unknown>;
  readonly historicalConditional?: {
    readonly status?: string;
    readonly latestRv20Pct?: number | null;
    readonly latestRv23Pct?: number | null;
    readonly latestRv60Pct?: number | null;
    readonly vrpVsRv23Pts?: number | null;
    readonly ivRank?: number | null;
    readonly ivPercentile?: number | null;
    readonly operativeRegime?: {
      readonly code?: string;
      readonly label?: string;
      readonly rationale?: string;
    } | null;
    readonly buckets?: readonly ({
      readonly id?: string;
      readonly label: string;
      readonly rangeLabel: string;
      readonly occurrences: number;
      readonly avgVolChange30dPts: number | null;
      readonly avgUnderlyingReturn30dPct: number | null;
      readonly pctVolDecreased: number | null;
      readonly isCurrent: boolean;
    } & Record<string, unknown>)[];
    readonly seasonalityMonths?: readonly ({
      readonly monthIndex?: number;
      readonly monthLabel: string;
      readonly monthsSampled: number;
      readonly avgMonthlyReturnPct: number | null;
      readonly annualizedVolPct: number | null;
      readonly positiveMonthRatePct: number | null;
    } & Record<string, unknown>)[];
    readonly historySeries?: readonly ({ readonly rvPct?: number | null } & Record<string, unknown>)[];
  } & Record<string, unknown>;
  readonly rvWindows?: {
    readonly rv20?: { readonly currentPct?: number | null } & Record<string, unknown>;
    readonly rv60?: { readonly currentPct?: number | null } & Record<string, unknown>;
    readonly rv120?: { readonly currentPct?: number | null } & Record<string, unknown>;
  } & Record<string, unknown>;
  readonly expiriesByCode: Readonly<Record<string, unknown>>;
}

export interface UsOptionsTickAggressionCompat {
  readonly askPct: number;
  readonly bidPct: number;
  readonly neutralPct: number;
  readonly netBiasPct: number;
  readonly direction: 'COMPRADOR' | 'VENDEDOR' | 'EQUILIBRADO';
  readonly label: string;
  readonly totalNotional: number;
  readonly classifiedContracts: number;
  readonly method: 'LEE_READY_BBO' | 'TICK_VARIATION_EOD';
}

export type ExportUsUnifiedQuoteDto = NonNullable<
  NonNullable<UsSnapshotResponseDto['marketContext']>['unifiedQuotes']
>[number] & {
  readonly dayOpen?: number | null;
  readonly quoteTimestampUtcSec?: number | null;
};

export type ExportUsVolSliceSummaryDto = NonNullable<
  NonNullable<UsSnapshotResponseDto['volSurfaceSummary']>['slices']
>[number] & {
  readonly delta25PutIv?: number | null;
  readonly delta25CallIv?: number | null;
};

export type ExportUsOptionContractRowDto = UsOptionContractRowDto & {
  readonly sharesPerContract?: number | null;
};

export type ExportUsSnapshotInputDto = Omit<
  UsSnapshotResponseDto,
  'marketContext' | 'exposureSummary' | 'volSurfaceSummary' | 'terminalEngines'
> & {
  readonly marketContext?: Omit<
    NonNullable<UsSnapshotResponseDto['marketContext']>,
    'unifiedQuotes'
  > & {
    readonly unifiedQuotes?: readonly ExportUsUnifiedQuoteDto[];
  };
  readonly exposureSummary?: (NonNullable<UsSnapshotResponseDto['exposureSummary']> & {
    readonly callGex?: number | null;
    readonly putGex?: number | null;
  }) | null;
  readonly volSurfaceSummary?: (Omit<
    NonNullable<UsSnapshotResponseDto['volSurfaceSummary']>,
    'slices'
  > & {
    readonly slices?: readonly ExportUsVolSliceSummaryDto[];
  }) | null;
  readonly terminalEngines?: (Omit<
    NonNullable<UsSnapshotResponseDto['terminalEngines']>,
    'volAnalyticsSuite'
  > & {
    readonly agresionTicks?: UsOptionsTickAggressionCompat | null;
    readonly orderFlow?: (NonNullable<
      NonNullable<UsSnapshotResponseDto['terminalEngines']>['orderFlow']
    > & {
      readonly agresionTicks?: UsOptionsTickAggressionCompat | null;
    }) | null;
    readonly volAnalyticsSuite?: UsVolAnalyticsSuiteCompatRef | null;
  }) | null;
  readonly openingAuction?: {
    readonly balanceType?: string;
    readonly inventoryRisk?: string;
    readonly openingType?: string;
    readonly openingDirection?: string;
    readonly ibClassification?: string;
    readonly pmh?: number | null;
    readonly pml?: number | null;
    readonly onPoc?: number | null;
    readonly onVah?: number | null;
    readonly onVal?: number | null;
    readonly ibh?: number | null;
    readonly ibl?: number | null;
    readonly ibWidth?: number | null;
    readonly atr14d?: number | null;
    readonly gapPct?: number | null;
    readonly macro0830SpikeDetected?: boolean;
  } | null;
  readonly envelope?: {
    readonly snapshot?: NonNullable<
      NonNullable<UsSnapshotResponseDto['envelope']>['snapshot']
    > & {
      readonly directionalBias?: string | null;
      readonly confluenceScore?: number | null;
      readonly gammaRegime?: string | null;
      readonly keyLevels?: readonly {
        readonly name: string;
        readonly source: string;
        readonly price: number | null;
      }[];
    };
  };
  readonly microstructure?: {
    readonly mtf?: (NonNullable<
      NonNullable<UsSnapshotResponseDto['microstructure']>['mtf']
    > & {
      readonly regime1d?: string | null;
      readonly aligned4h?: boolean | null;
      readonly hma55?: number | null;
    }) | null;
    readonly cvd?: {
      readonly deltaMode?: string | null;
      readonly currentSessionDate?: string | null;
      readonly currentSessionCvd?: number | null;
      readonly absorptionEvents?: readonly unknown[];
    } | null;
  } | null;
  readonly usOptionsFeed?: {
    readonly source?: string;
    readonly activeProvider?: string;
    readonly oiEffectiveDate?: string | null;
    readonly refreshedAtUtcSec?: number | null;
  } | null;
  readonly dataQuality?: {
    readonly ownSolvedIvContracts?: number;
    readonly providerFallbackIvContracts?: number;
    readonly parityExpiries?: number;
    readonly chainContractsReceived?: number;
    readonly chainContractsUsable?: number;
    readonly warnings?: readonly string[];
  } | null;
};

export interface RawExpiryInputBundle {
  readonly expirationDate: string;
  readonly daysToExpiry: number;
  readonly expiryUtcSec: number;
  readonly contracts: readonly ExportUsOptionContractRowDto[];
  readonly exposureSummary: ExportUsSnapshotInputDto['exposureSummary'] | null;
  readonly volAnalyticsExpiry: UsVolAnalyticsExpiryRef | null;
  readonly volSlice: NonNullable<NonNullable<ExportUsSnapshotInputDto['volSurfaceSummary']>['slices']>[number] | null;
  readonly sourceKind: 'EXPIRY_ENDPOINT' | 'SNAPSHOT_PRELOADED';
}

export interface RawUsOptionsSnapshotInput {
  readonly request: ExportUsOptionsSnapshotRequest;
  readonly capturedAtUtcSec: number;
  readonly usSnapshot: ExportUsSnapshotInputDto;
  readonly expiries: readonly RawExpiryInputBundle[];
  readonly barsResponse: UsTerminalBarsResponseDto | null;
  readonly barsTimeframe: '15m' | '1h' | null;
  readonly barsAsOfUtcSec: number | null;
  readonly usVolSurface: UsVolSurfaceResponseDto | null;
  readonly liveSpotQuote: {
    readonly price: number | null;
    readonly dayOpen?: number | null;
    readonly previousClose?: number | null;
    readonly dayLow?: number | null;
    readonly dayHigh?: number | null;
    readonly bid?: number | null;
    readonly ask?: number | null;
    readonly quoteTimestampUtcSec?: number | null;
    readonly asOfUtcSec?: number | null;
    readonly sessionPhase?: string | null;
  } | null;
  readonly additionalRequestsCount: number;
}

export interface ExportAvwapReference {
  readonly label: string;
  readonly kind: 'MONTH_START' | 'SUPPORT' | 'RESISTANCE' | 'EVENT';
  readonly anchorDate: string | null;
  readonly value: number;
  readonly distanceSpotPct: number;
  readonly coverage: string;
}

export interface ExportFvgZone {
  readonly type: 'BULLISH_FVG' | 'BEARISH_FVG';
  readonly gapLow: number;
  readonly gapHigh: number;
  readonly consequentEncroachment: number;
  readonly distanceSpotPct: number;
}

export interface ExportStrikeFlowRow {
  readonly strike: number;
  readonly tags: readonly string[];
  readonly callOi: number;
  readonly callOiKnown: boolean;
  readonly putOi: number;
  readonly putOiKnown: boolean;
  readonly callVolume: number;
  readonly callVolKnown: boolean;
  readonly putVolume: number;
  readonly putVolKnown: boolean;
  readonly callGex: number;
  readonly putGex: number;
  readonly netGex: number;
  readonly vex: number;
  readonly cex: number;
}

export interface ExportFlowSummaryBlock {
  readonly scope: 'GLOBAL' | 'EXPIRY';
  readonly expirationDate: string | null;
  readonly regime: string;
  readonly regimeLabel: string;
  readonly creditStrategySignal: string;
  readonly spotVsZeroGamma: string;
  readonly distanceToZeroGammaPct: number;
  readonly netGex: number;
  readonly callGex: number;
  readonly putGex: number;
  readonly netVex: number;
  readonly netCex: number;
  readonly callWallStrike: number;
  readonly putWallStrike: number;
  readonly zeroGammaSpot: number;
  readonly zeroGammaStatus: string;
  readonly maxPainStrike: number;
  readonly charmPinStrike: number;
  readonly gexCharmPinStrike: number;
  readonly putCallRatioVol: number;
  readonly putCallRatioOi: number;
  readonly totalCallVolume: number;
  readonly totalPutVolume: number;
  readonly totalLots: number;
  readonly totalCallOi: number;
  readonly totalPutOi: number;
  readonly netDirectionalPremiumUsd: number;
  readonly aggressionDirection: string;
  readonly aggressionNetBiasPct: number;
  readonly aggressionMethod: string | null;
  readonly deltaFlowShares: number;
  readonly isFlowSnapshotApprox: true;
  readonly usableContracts: number;
  readonly totalContracts: number;
  readonly usableOpenInterest: number;
  readonly coverage: string;
  readonly engineExpirationDates: readonly string[];
  readonly allStrikes: readonly ExportStrikeFlowRow[];
  readonly strikesWindow?: readonly ExportStrikeFlowRow[];
  readonly windowStats?: {
    readonly atmStrike: number;
    readonly totalAvailable: number;
    readonly included: number;
    readonly excluded: number;
    readonly outOfWindowStructuralLevels: readonly string[];
  };
}

export interface ExportTermStructurePoint {
  readonly expirationDate: string;
  readonly daysToExpiry: number;
  readonly ivAtmPct: number;
  readonly em1SigmaUsd: number;
  readonly em1SigmaPct: number;
  readonly skew25Pts: number;
  readonly quality: string;
}

export interface ExportExpiryVolatilityBlock {
  readonly expirationDate: string;
  readonly daysToExpiry: number;
  readonly ivAtmPct: number;
  readonly ivAtmSource: string;
  readonly ivRv20Ratio: number;
  readonly vrpPts: number;
  readonly vrpDefinition: 'IV_MINUS_RV_VOL_PTS';
  readonly vrpRvRefLabel: string;
  readonly ivRank: number;
  readonly ivRankSource: string;
  readonly ivPercentile: number;
  readonly ivPercentileSource: string;
  readonly iv25PutPct: number;
  readonly iv25CallPct: number;
  readonly skew25PutMinusCallPts: number;
  readonly em1SigmaUsd: number;
  readonly em1SigmaPct: number;
  readonly upper1Sigma: number;
  readonly lower1Sigma: number;
  readonly em2SigmaUsd: number;
  readonly em2SigmaPct: number;
  readonly upper2Sigma: number;
  readonly lower2Sigma: number;
  readonly emStraddleUsd: number;
  readonly emMethodology: string;
  readonly relativeStructureCosts: readonly {
    readonly id: string;
    readonly name: string;
    readonly legsLabel: string;
    readonly costPctOfMaxProfit: number;
    readonly historicalPercentile: number;
    readonly historicalMedianPct: number;
    readonly obs: number;
  }[];
  readonly qAndP: {
    readonly frontExpiryDate: string | null;
    readonly frontDte: number;
    readonly correspondsToFrontOnly: boolean;
    readonly comparableHorizon: boolean;
    readonly note: string;
    readonly qMean: number;
    readonly qStdDev: number;
    readonly qSkewness: number;
    readonly qExcessKurtosis: number;
    readonly pHorizonDays: number;
    readonly pSamples: number;
    readonly pTailFreqPct: number;
    readonly pOvernightSharePct: number;
    readonly comparisons: readonly {
      readonly label: string;
      readonly price: number;
      readonly direction: 'ABOVE' | 'BELOW';
      readonly probQ: number;
      readonly probP: number;
      readonly pqSpread: number;
      readonly classification: string;
    }[];
  };
}

export interface ExportSpreadCandidateRow {
  readonly id: string;
  readonly strategy: string;
  readonly kind: 'BULL_PUT_SPREAD' | 'BEAR_CALL_SPREAD' | 'IRON_CONDOR';
  readonly expirationDate: string;
  readonly legsSummary: string;
  readonly widthUsd: number;
  readonly contractMultiplier: number;
  readonly midCreditPerShare: number;
  readonly conservativeCreditPerShare: number;
  readonly midCreditContractUsd: number;
  readonly conservativeCreditContractUsd: number;
  readonly maxProfitPerShare: number;
  readonly maxLossPerShare: number;
  readonly maxProfitContractUsd: number;
  readonly maxLossContractUsd: number;
  readonly breakevens: readonly number[];
  readonly pItmPct: number;
  readonly popPct: number;
  readonly popSource: string;
  readonly riskRewardRatio: number;
  readonly distBeVsEmSigma: number;
  readonly bidAskPctOfMid: number;
  readonly liquiditySemaphore: LiquiditySemaphore;
  readonly warnings: readonly string[];
}

export interface ExportSpreadsBlock {
  readonly expirationDate: string;
  readonly daysToExpiry: number;
  readonly enabled: boolean;
  readonly disabledReason: string | null;
  readonly shortPremiumBreakerStatus: 'OK' | 'NO_SHORT_PREMIUM_RISK';
  readonly shortPremiumBreakerReason: string | null;
  readonly dealerCreditSignal: string;
  readonly spotVsZeroGamma: string;
  readonly zeroGammaOperationalNote: string | null;
  readonly widthFilterUsd: { readonly min: number; readonly max: number };
  readonly evaluatedCount: number;
  readonly excludedCount: number;
  readonly candidates: readonly ExportSpreadCandidateRow[];
}

export interface ExportExpiryComparisonRow {
  readonly expirationDate: string;
  readonly daysToExpiry: number;
  readonly ivAtmPct: number;
  readonly em1SigmaUsd: number;
  readonly em1SigmaPct: number;
  readonly skew25Pts: number;
  readonly netGex: number;
  readonly maxPainStrike: number;
  readonly atmThetaDaily: number;
  readonly validSpreadCandidates: number;
  readonly bestSpreadSummary: string | null;
  readonly bestConservativeCreditUsd: number;
  readonly bestRiskUsd: number;
  readonly bestMultiplier: number;
  readonly bestWidthUsd: number;
}

export interface ExportFilteredChainSide {
  readonly totalAvailable: number;
  readonly included: number;
  readonly excludedByReason: Readonly<Record<string, number>>;
  readonly rows: readonly UnifiedContractCalcResult[];
}

export interface UsOptionsIntelligenceSnapshotV1 {
  readonly schemaVersion: typeof US_OPTIONS_EXPORT_SCHEMA_VERSION;
  readonly snapshotId: string;
  readonly meta: {
    readonly ticker: string;
    readonly currency: 'USD';
    readonly mode: SnapshotMode;
    readonly selectedExpirations: readonly string[];
    readonly capturedAt: DualTimezoneTimestamp;
    readonly sessionRegime: UsSessionRegime;
    readonly globalQuality: BlockQualityStatus;
    readonly catalystWindow: CatalystWindowResult;
    readonly warnings: readonly string[];
    readonly additionalRequestsCount: number;
  };
  readonly timestamps: {
    readonly spotAsOf: DualTimezoneTimestamp | null;
    readonly optionsQuoteMin: DualTimezoneTimestamp | null;
    readonly optionsQuoteMax: DualTimezoneTimestamp | null;
    readonly optionsQuoteMedian: DualTimezoneTimestamp | null;
    readonly oiEffectiveDate: string;
    readonly volSurfaceAsOf: DualTimezoneTimestamp | null;
    readonly oratsTradeDate: string | null;
    readonly barsAsOf: DualTimezoneTimestamp | null;
    readonly catalystsAsOf: DualTimezoneTimestamp | null;
    readonly clockSkewWarnings: readonly string[];
  };
  readonly technical: {
    readonly valuationSpot: number;
    readonly liveSpotAtCapture: number;
    readonly spotDriftPct: number;
    readonly changeAbs: number;
    readonly changePct: number;
    readonly dayOpen: number;
    readonly previousClose: number;
    readonly dayHigh: number;
    readonly dayLow: number;
    readonly sessionRangeUsd: number;
    readonly atr14d: number;
    readonly atrTravelledPct: number;
    readonly atrTravelledFormula: string;
    readonly spotBid: number;
    readonly spotAsk: number;
    readonly spotSpreadPct: number;
    readonly barsTimeframe: '15m' | '1h' | null;
    readonly emas: readonly {
      readonly period: 9 | 21 | 50 | 200;
      readonly timeframe: string;
      readonly value: number;
      readonly distanceSpotPct: number;
    }[];
    readonly ema20Available: false;
    readonly smas: readonly {
      readonly period: 50 | 200;
      readonly timeframe: string;
      readonly value: number;
      readonly distanceSpotPct: number;
    }[];
    readonly sessionVwap: {
      readonly timeframe: string;
      readonly value: number;
      readonly distanceSpotPct: number;
      readonly supported: boolean;
    };
    readonly avwapMonthStart: ExportAvwapReference | null;
    readonly autoAvwaps: readonly ExportAvwapReference[];
    readonly mtfStructure: {
      readonly regime1d: string | null;
      readonly aligned4h: boolean | null;
      readonly effectiveMacroRegime: string | null;
      readonly setupStatus: string | null;
      readonly directionalBias: string | null;
      readonly confluenceScore: number;
    };
    readonly volumeProfile1y: {
      readonly poc: number;
      readonly vah: number;
      readonly val: number;
      readonly hvnPrices: readonly number[];
      readonly lvnPrices: readonly number[];
      readonly lookbackDays: number;
      readonly methodology: string;
    };
    readonly overnightProfile: {
      readonly onPoc: number;
      readonly onVah: number;
      readonly onVal: number;
    };
    readonly nakedPocs: readonly { readonly sessionDate: string; readonly price: number; readonly distanceSpotPct: number }[];
    readonly keyLevels: {
      readonly pdh: number;
      readonly pdl: number;
      readonly pmh: number;
      readonly pml: number;
      readonly ibh: number;
      readonly ibl: number;
      readonly ibWidth: number;
      readonly ibClassification: string;
    };
    readonly activeFvgs: readonly ExportFvgZone[];
    readonly ifvgAvailable: false;
    readonly liquiditySweepsAvailable: false;
    readonly cvdApprox: {
      readonly value: number;
      readonly bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'UNKNOWN';
      readonly slopeSign: number;
      readonly isApproximation: true;
      readonly label: string;
    };
  };
  readonly flowGlobal: ExportFlowSummaryBlock;
  readonly flowByExpiry: Readonly<Record<string, ExportFlowSummaryBlock>>;
  readonly volatility: {
    readonly rv20Pct: number;
    readonly rv60Pct: number;
    readonly rv120Pct: number;
    readonly rv23RefPct: number;
    readonly iv30dPct: number;
    readonly termRegime: string;
    readonly termSpreadPp: number;
    readonly termStructureTop6: readonly ExportTermStructurePoint[];
    readonly currentQuintile: {
      readonly label: string;
      readonly rangeLabel: string;
      readonly occurrences: number;
      readonly avgVolChange30dPts: number;
      readonly avgUnderlyingReturn30dPct: number;
      readonly pctVolDecreased: number;
    } | null;
    readonly currentMonthSeasonality: {
      readonly monthLabel: string;
      readonly monthsSampled: number;
      readonly avgMonthlyReturnPct: number;
      readonly annualizedVolPct: number;
      readonly positiveMonthRatePct: number;
    } | null;
    readonly byExpiry: Readonly<Record<string, ExportExpiryVolatilityBlock>>;
  };
  readonly chainsByExpiry: Readonly<Record<string, {
    readonly expirationDate: string;
    readonly daysToExpiry: number;
    readonly calls: readonly UnifiedContractCalcResult[];
    readonly puts: readonly UnifiedContractCalcResult[];
  }>>;
  readonly spreadsByExpiry: Readonly<Record<string, ExportSpreadsBlock>>;
  readonly metadataByExpiry: Readonly<Record<string, { readonly expirationDate: string; readonly daysToExpiry: number; readonly expiryUtcSec: number; readonly sourceKind: 'EXPIRY_ENDPOINT' | 'SNAPSHOT_PRELOADED' }>>;
}

export interface SnapshotBlockProvenance {
  readonly block: string;
  readonly source: string;
  readonly asOf: string;
  readonly status: BlockQualityStatus;
  readonly coverage: string;
}

export interface SnapshotIntegrityReport {
  readonly valid: boolean;
  readonly globalQuality: BlockQualityStatus;
  readonly blockingErrors: readonly string[];
  readonly warnings: readonly string[];
  readonly clockSkewWarnings: readonly string[];
  readonly provenanceTable: readonly SnapshotBlockProvenance[];
  readonly gexMethodology: string;
  readonly volatilityMethodology: string;
  readonly unavailableFields: readonly string[];
  readonly limitations: readonly string[];
}

export interface FilteredUsOptionsSnapshotV1 {
  readonly snapshot: UsOptionsIntelligenceSnapshotV1;
  readonly mode: SnapshotMode;
  readonly swingChainFilter: SwingChainFilterMode | null;
  readonly flowByExpiry: Readonly<Record<string, ExportFlowSummaryBlock>>;
  readonly chainsByExpiry: Readonly<Record<string, {
    readonly expirationDate: string;
    readonly daysToExpiry: number;
    readonly calls: ExportFilteredChainSide;
    readonly puts: ExportFilteredChainSide;
  }>>;
  readonly spreadsByExpiry: Readonly<Record<string, ExportSpreadsBlock>>;
  readonly expiryComparison: readonly ExportExpiryComparisonRow[];
  readonly excludedRowsSummary: readonly string[];
}

export interface CapturedSnapshotChartPng {
  readonly id: 'chart_precio_niveles' | 'chart_gex_por_base' | 'chart_cono_smile';
  readonly filename: string;
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
  readonly asOfUtcSec: number;
}

export interface SnapshotExportTimingsMs {
  readonly collectMs: number;
  readonly validateAndFilterMs: number;
  readonly serializeMarkdownMs: number;
  readonly captureChartsMs: number;
  readonly renderPdfMs: number;
  readonly totalMs: number;
}

export interface MarkdownRenderOutput {
  readonly markdown: string;
  readonly byteLengthUtf8: number;
  readonly exceedsTargetBudget: boolean;
  readonly targetBudgetBytes: number;
  readonly truncationApplied: false;
}

export interface SnapshotExportResult {
  readonly snapshotId: string;
  readonly schemaVersion: typeof US_OPTIONS_EXPORT_SCHEMA_VERSION;
  readonly dto: FilteredUsOptionsSnapshotV1;
  readonly integrity: SnapshotIntegrityReport;
  readonly markdown: string;
  readonly markdownByteLength: number;
  readonly exceedsTargetBudget: boolean;
  readonly charts: readonly CapturedSnapshotChartPng[];
  readonly pdfBlob: Blob | null;
  readonly timingsMs: SnapshotExportTimingsMs;
  readonly additionalRequestsCount: number;
}
