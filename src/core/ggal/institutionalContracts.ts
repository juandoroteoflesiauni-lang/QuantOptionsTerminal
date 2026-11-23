import type { OratsMetadata } from '../oratsIntegrity.js';
/**
 * Institutional TypeScript contracts for GGAL Specialist (Pieza 28).
 *
 * Strictly complies with `exactOptionalPropertyTypes: true` and `verbatimModuleSyntax: true`:
 * zero optional `?` property markers; absent or degraded values use explicit `| null`
 * and discriminated unions (`available: true | false`, `status: 'OPERATIONAL' | 'UNAVAILABLE'`).
 */

export type ArFeedProviderId =
  | 'PRIMARY_MATRIZ_WS'
  | 'PPI_REST'
  | 'IOL_REST'
  | 'BMB_HOMEBROKER_BRIDGE'
  | 'MAE_MARKETDATA_V1'
  | 'BYMA_CLEARING'
  | 'IAMC_ANEXO_B_PDF'
  | 'DATA912_EOD_CONTINGENCY';

export type FeedQualityTier =
  | 'REALTIME_L2_TICK'
  | 'POLLING_L1_REST'
  | 'EOD_CONTINGENCY'
  | 'UNAVAILABLE';

export interface ArFeedProviderPriorityEntry {
  readonly provider: ArFeedProviderId;
  readonly priority: number;
  readonly role: 'L2_EQUITY_FX_WS' | 'L2_EQUITY_OPTIONS_WS' | 'REST_L1_QUOTES' | 'MAE_FX_RATES' | 'CLEARING_MARGINS' | 'ANEXO_B_OI' | 'EOD_CONTINGENCY';
  readonly supportsL2OrderBook: boolean;
  readonly staleThresholdSec: number;
}

export interface ArMarketFeedRouterConfig {
  readonly providerOrder: readonly ArFeedProviderPriorityEntry[];
  readonly maxClockSkewSec: number;
  readonly disallowSyntheticL2: true;
  readonly allowData912OnlyAsEodContingency: true;
}

export interface ArProviderHealthEntry {
  readonly provider: ArFeedProviderId;
  readonly priority: number;
  readonly configured: boolean;
  readonly connected: boolean;
  readonly qualityTier: FeedQualityTier;
  readonly lastMessageUtcSec: number | null;
  readonly latencyMs: number | null;
  readonly stale: boolean;
  readonly errorReason: string | null;
  readonly roleDescription: string;
}

export interface ArFeedRouterStatusSnapshot {
  readonly asOfUtcSec: number;
  readonly activePrimaryEquityProvider: ArFeedProviderId | null;
  readonly activeQualityTier: FeedQualityTier;
  readonly l2Available: boolean;
  readonly activeFxFuturesProvider: ArFeedProviderId | null;
  readonly activeSovereignProvider: ArFeedProviderId | null;
  readonly activeAnexoBProvider: ArFeedProviderId | null;
  readonly isContingencyEod: boolean;
  readonly degradationReason: string | null;
  readonly providers: readonly ArProviderHealthEntry[];
}

export interface GgalL2OrderLevel {
  readonly level: 1 | 2 | 3 | 4 | 5;
  readonly price: number;
  readonly size: number;
  readonly orderCount: number | null;
}

export interface GgalL2LadderAvailable {
  readonly available: true;
  readonly activeProvider: ArFeedProviderId;
  readonly qualityTier: 'REALTIME_L2_TICK';
  readonly asOfUtcSec: number;
  readonly symbol: string;
  readonly bids: readonly GgalL2OrderLevel[];
  readonly asks: readonly GgalL2OrderLevel[];
  readonly bookStatus?: 'LIVE' | 'EOD_CIERRE';
  readonly isEodCached?: boolean;
}

export interface GgalL2LadderUnavailable {
  readonly available: false;
  readonly reason: 'NON_L2_FEED_ACTIVE' | 'FEED_DISCONNECTED' | 'INVALID_BOOK_STATE' | 'OUT_OF_SESSION';
  readonly activeProvider: ArFeedProviderId | null;
  readonly qualityTier: FeedQualityTier;
  readonly asOfUtcSec: number;
  readonly symbol: string;
}

export type GgalL2LadderState = GgalL2LadderAvailable | GgalL2LadderUnavailable;

export interface GgalIcebergReloadSignal {
  readonly detected: boolean;
  readonly side: 'BID' | 'ASK' | 'NONE';
  readonly priceLevel: number | null;
  readonly executedVolumeAtBest: number;
  readonly visibleDropAtBest: number;
  readonly reloadedVolumeEstimate: number;
  readonly reloadRatio: number;
}

export interface GgalVpinBucketSummary {
  readonly bucketSizeShares: number;
  readonly windowBuckets: number;
  readonly populatedBuckets: number;
  readonly vpin: number;
  readonly percentileRank: number;
  readonly toxicAlert: boolean;
  readonly bucketSeries: readonly number[];
}

export interface GgalL2MicrostructureOperational {
  readonly status: 'OPERATIONAL';
  readonly activeProvider: ArFeedProviderId;
  readonly qualityTier: 'REALTIME_L2_TICK';
  readonly asOfUtcSec: number;
  readonly decayAlpha: number;
  readonly bestBid: number;
  readonly bestAsk: number;
  readonly midPrice: number;
  readonly spreadAbs: number;
  readonly spreadBps: number;
  readonly obiL1: number;
  readonly obiMultiLevel: number;
  readonly micropriceL1: number;
  readonly micropriceMultiLevel: number;
  readonly totalBidDepth5: number;
  readonly totalAskDepth5: number;
  readonly iceberg: GgalIcebergReloadSignal;
  readonly vpin: GgalVpinBucketSummary;
  readonly reason: null;
}

export interface GgalL2MicrostructureUnavailable {
  readonly status: 'UNAVAILABLE';
  readonly reason: 'DEGRADED_TO_NON_L2_FEED' | 'INVALID_L2_INPUT' | 'INSUFFICIENT_DEPTH';
  readonly activeProvider: ArFeedProviderId | null;
  readonly qualityTier: FeedQualityTier;
  readonly asOfUtcSec: number;
  readonly detail: string;
}

export type GgalL2MicrostructureMetrics =
  | GgalL2MicrostructureOperational
  | GgalL2MicrostructureUnavailable;

export type GgalElectoralRegimeId =
  | 'CALM_COMPRESSION'
  | 'FX_BRECHA_TENSION'
  | 'ELECTORAL_TAIL_JUMP';

export type GgalCrossBankTicker = 'GGAL' | 'BMA' | 'BBAR' | 'SUPV';

export interface GgalHayashiYoshidaPairScore {
  readonly tickerA: GgalCrossBankTicker;
  readonly tickerB: GgalCrossBankTicker;
  readonly correlation: number;
  readonly bestLagSeconds: number;
  readonly leadScoreAOverB: number;
}

export interface GgalCrossBankLeadLagAvailable {
  readonly available: true;
  readonly leader: GgalCrossBankTicker;
  readonly leaderAverageLeadScore: number;
  readonly byBankScore: Readonly<Record<GgalCrossBankTicker, number>>;
  readonly pairs: readonly GgalHayashiYoshidaPairScore[];
  readonly reason: null;
}

export interface GgalCrossBankLeadLagUnavailable {
  readonly available: false;
  readonly reason: string;
  readonly leader: null;
  readonly leaderAverageLeadScore: number;
  readonly byBankScore: null;
  readonly pairs: readonly GgalHayashiYoshidaPairScore[];
}

export type GgalCrossBankLeadLagResult =
  | GgalCrossBankLeadLagAvailable
  | GgalCrossBankLeadLagUnavailable;

export interface GgalDlrForwardKinkAvailable {
  readonly available: true;
  readonly maxSecondDifferencePct: number;
  readonly peakMaturityLabel: string;
  readonly peakForwardRate: number;
  readonly annualizedTermSlopePct: number;
  readonly curvePointsCount: number;
  readonly reason: null;
}

export interface GgalDlrForwardKinkUnavailable {
  readonly available: false;
  readonly reason: string;
  readonly maxSecondDifferencePct: number;
  readonly peakMaturityLabel: null;
  readonly peakForwardRate: number;
  readonly annualizedTermSlopePct: number;
  readonly curvePointsCount: number;
}

export type GgalDlrForwardKinkResult =
  | GgalDlrForwardKinkAvailable
  | GgalDlrForwardKinkUnavailable;

export interface GgalElectoralObservables {
  readonly bankBasketIv30ExErn: number;
  readonly ggal25DeltaSkew: number;
  readonly sovereignLegislationSpreadPct: number;
  readonly dlrElectoralForwardKink: number;
  readonly crossBankLeadLagLeader: GgalCrossBankTicker;
  readonly crossBankLeadLagIntensity: number;
}

export interface GgalHedgeWeightRecommendation {
  readonly dlrFuturesWeight: number;
  readonly otmPutWingWeight: number;
  readonly cashArsCollarWeight: number;
  readonly adrDeltaHedgeWeight: number;
}

export interface GgalElectoralRegimeOperational {
  readonly status: 'OPERATIONAL';
  readonly asOfUtcSec: number;
  readonly currentRegime: GgalElectoralRegimeId;
  readonly priorProbabilities: readonly [number, number, number];
  readonly posteriorProbabilities: readonly [number, number, number];
  readonly likelihoods: readonly [number, number, number];
  readonly effectiveJumpIntensity: number;
  readonly kellyFractionMultiplier: number;
  readonly overnightCvar99Pct: number;
  readonly recommendedHedgeWeights: GgalHedgeWeightRecommendation;
  readonly observables: GgalElectoralObservables;
  readonly dlrKinkDetail: GgalDlrForwardKinkResult;
  readonly leadLagDetail: GgalCrossBankLeadLagResult;
  readonly yangZhangVol20d: number;
  readonly reason: null;
}

export interface GgalElectoralRegimeUnavailable {
  readonly status: 'UNAVAILABLE';
  readonly asOfUtcSec: number;
  readonly reason: string;
  readonly priorProbabilities: readonly [number, number, number];
  readonly posteriorProbabilities: readonly [number, number, number];
  readonly currentRegime: null;
}

export type GgalElectoralRegimeState =
  | GgalElectoralRegimeOperational
  | GgalElectoralRegimeUnavailable;

export interface OtmWingPointDiagnostic {
  readonly strikeArs: number;
  readonly side: 'CALL' | 'PUT';
  readonly absDelta: number;
  readonly bymaIv: number;
  readonly usWingIv: number;
  readonly impliedCclVol: number;
  readonly jul26DividendAdjusted: boolean;
}

export interface OtmWingCclIvExtractionResult {
  readonly status: 'OPERATIONAL' | 'UNAVAILABLE';
  readonly extractedCclImplVol: number;
  readonly atmBymaCompressedIv: number;
  readonly callOverwritingCompressionPct: number;
  readonly selectedWingsCount: number;
  readonly wingPoints: readonly OtmWingPointDiagnostic[];
  readonly reason: string | null;
}

export interface L2WeightedPinScoreResult {
  readonly status: 'OPERATIONAL' | 'UNAVAILABLE';
  readonly pinStrikeArs: number;
  readonly distancePct: number;
  readonly baseAnexoBPinScore: number;
  readonly obiMultiLevel: number;
  readonly l2DepthConfirmationRatio: number;
  readonly weightedPinScore: number;
  readonly asOfBuenosAiresTime: string;
  readonly isClosingWindow1530Art: boolean;
  readonly reason: string | null;
}

export interface OratsSurfaceStrikeRow {
  readonly strike: number;
  readonly expirDate: string;
  readonly dte: number;
  readonly smvVol: number;
  readonly callValue: number;
  readonly putValue: number;
  readonly callMidIv: number;
  readonly putMidIv: number;
  readonly delta: number;
  readonly gamma: number;
  readonly theta: number;
  readonly vega: number;
}

export interface OratsHybridSurfaceOperational extends OratsMetadata {
  readonly status: 'OPERATIONAL';
  readonly source: 'ORATS_DELAYED_CORE';
  readonly ticker: string;
  readonly tradeDate: string | null;
  readonly asOfUtcSec: number;
  readonly stockPrice: number;
  readonly massiveSpotPrice: number | null;
  readonly massiveSpotSourceMode: 'MASSIVE_NBBO' | 'MASSIVE_BARS' | 'UNAVAILABLE';
  readonly smvVol: number;
  readonly iv10d: number;
  readonly iv20d: number;
  readonly iv30d: number;
  readonly iv60d: number;
  readonly iv90d: number;
  readonly iv6m: number;
  readonly iv1y: number;
  readonly exErnIv10d: number;
  readonly exErnIv20d: number;
  readonly exErnIv30d: number;
  readonly exErnIv60d: number;
  readonly exErnIv90d: number;
  readonly fwd30_20: number;
  readonly fwd60_30: number;
  readonly fwd90_60: number;
  readonly impliedMove: number;
  readonly annIdiv: number;
  readonly impliedNextDiv: number;
  readonly borrow30: number;
  readonly yieldRate: number;
  readonly yangZhangAdrVol: number;
  readonly strikes: readonly OratsSurfaceStrikeRow[];
  readonly reason: null;
}

export interface OratsHybridSurfaceDegraded extends Omit<OratsHybridSurfaceOperational, 'status' | 'reason'> {
  readonly status: 'PARTIAL_FAILURE' | 'STALE_CACHE';
  readonly reason: string;
}

export interface OratsHybridSurfaceUnavailable extends OratsMetadata {
  readonly status: 'UNAVAILABLE';
  readonly source: 'ORATS_DELAYED_CORE';
  readonly ticker: string;
  readonly asOfUtcSec: number;
  readonly reason: string;
  readonly massiveSpotPrice: number | null;
  readonly massiveSpotSourceMode: 'MASSIVE_NBBO' | 'MASSIVE_BARS' | 'UNAVAILABLE';
  readonly yangZhangAdrVol: number;
}

export type OratsHybridSurfacePayload =
  | OratsHybridSurfaceOperational
  | OratsHybridSurfaceDegraded
  | OratsHybridSurfaceUnavailable;

export interface GgalClearingRiskOperational {
  readonly status: 'OPERATIONAL';
  readonly asOfUtcSec: number;
  readonly anexoBStatus: 'FRESH' | 'CARRY_FORWARD_NO_TRADE' | 'UNAVAILABLE';
  readonly anexoBTradeDate: string | null;
  readonly jul26DividendNoStrikeAdjFlag: boolean;
  readonly bymaInitialMarginPct: number;
  readonly clearingHaircutPct: number;
  readonly totalUncoveredContracts: number;
  readonly totalCoveredContracts: number;
  readonly l2PinScore: L2WeightedPinScoreResult;
  readonly otmWingCclVol: OtmWingCclIvExtractionResult;
  readonly reason: null;
}

export interface GgalClearingRiskUnavailable {
  readonly status: 'UNAVAILABLE';
  readonly asOfUtcSec: number;
  readonly reason: string;
}

export type GgalClearingRiskPayload =
  | GgalClearingRiskOperational
  | GgalClearingRiskUnavailable;

export type GgalDualChartCoordMode = 'ARS_BYMA' | 'USD_ADR_NASDAQ' | 'RATIO_CCL';
export type GgalDualChartTimeframe = '1m' | '5m' | '15m' | '1H' | '4H' | '1D';
export type GgalAvwapAnchorMode =
  | 'MONTH_START'
  | 'LAST_BIMONTHLY_EXPIRY'
  | 'LAST_EARNINGS'
  | 'ELECTORAL_GAP';
export type GgalSubPaneIndicatorMode = 'CVD_LEE_READY' | 'CCL_BRECHA_PCT' | 'REL_STRENGTH_BANKS';
export type GgalGreekProfileMode = 'SIGNED_GEX' | 'VANNA' | 'CHARM';

export interface GgalChartBarPoint {
  readonly timeSec: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface GgalLinePoint {
  readonly timeSec: number;
  readonly value: number;
}

export interface GgalAvwapBandPoint {
  readonly timeSec: number;
  readonly avwap: number;
  readonly plus1Sigma: number;
  readonly minus1Sigma: number;
  readonly plus2Sigma: number;
  readonly minus2Sigma: number;
}

export interface GgalVolumeProfileBin {
  readonly priceMid: number;
  readonly volume: number;
  readonly isValToVah: boolean;
  readonly isPoc: boolean;
}

export interface GgalVolumeProfileSummary {
  readonly poc: number;
  readonly vah: number;
  readonly val: number;
  readonly nakedPocs: readonly number[];
  readonly bins: readonly GgalVolumeProfileBin[];
}

export interface GgalChartStructureZone {
  readonly id: string;
  readonly kind: 'FVG' | 'FOB';
  readonly direction: 'BULLISH' | 'BEARISH';
  readonly status: 'UNMITIGATED' | 'MITIGATED';
  readonly startTimeSec: number;
  readonly endTimeSec: number | null;
  readonly low: number;
  readonly high: number;
}

export interface GgalExpectedConePoint {
  readonly timeSec: number;
  readonly center: number;
  readonly upper1Sigma: number;
  readonly lower1Sigma: number;
  readonly upper2Sigma: number;
  readonly lower2Sigma: number;
}

export interface GgalSubPanePoint {
  readonly timeSec: number;
  readonly cvdLeeReady: number;
  readonly cclBrechaPct: number;
  readonly relStrengthBma: number;
  readonly relStrengthBbar: number;
  readonly relStrengthSupv: number;
}

export interface GgalStrikeGreekProfileRow {
  readonly strike: number;
  readonly signedGexUncovered: number;
  readonly signedGexCovered: number;
  readonly vannaUncovered: number;
  readonly vannaCovered: number;
  readonly charmUncovered: number;
  readonly charmCovered: number;
}

export interface GgalL2ConfluenceAlert {
  readonly l2Price: number;
  readonly side: 'BID' | 'ASK';
  readonly l2Size: number;
  readonly targetLabel: string;
  readonly targetPrice: number;
  readonly distancePct: number;
}

export interface GgalDualChartOperational {
  readonly status: 'OPERATIONAL';
  readonly asOfUtcSec: number;
  readonly coordMode: GgalDualChartCoordMode;
  readonly timeframe: GgalDualChartTimeframe;
  readonly avwapAnchor: GgalAvwapAnchorMode;
  readonly avwapAnchorUtcSec: number;
  readonly spotPrice: number;
  readonly cclRate: number;
  readonly callWall: number;
  readonly putWall: number;
  readonly zeroGamma: number;
  readonly maxPain: number;
  readonly bars: readonly GgalChartBarPoint[];
  readonly ema9: readonly GgalLinePoint[];
  readonly ema21: readonly GgalLinePoint[];
  readonly ema50: readonly GgalLinePoint[];
  readonly ema200: readonly GgalLinePoint[];
  readonly avwapBands: readonly GgalAvwapBandPoint[];
  readonly volumeProfile: GgalVolumeProfileSummary;
  readonly zones: readonly GgalChartStructureZone[];
  readonly expectedCone: readonly GgalExpectedConePoint[];
  readonly subPaneSeries: readonly GgalSubPanePoint[];
  readonly greekProfile: readonly GgalStrikeGreekProfileRow[];
  readonly l2Ladder: GgalL2LadderState;
  readonly confluenceAlerts: readonly GgalL2ConfluenceAlert[];
  readonly reason: null;
}

export interface GgalDualChartUnavailable {
  readonly status: 'UNAVAILABLE';
  readonly asOfUtcSec: number;
  readonly coordMode: GgalDualChartCoordMode;
  readonly timeframe: GgalDualChartTimeframe;
  readonly avwapAnchor: GgalAvwapAnchorMode;
  readonly reason: string;
  readonly l2Ladder: GgalL2LadderState;
}

export type GgalDualChartPayload = GgalDualChartOperational | GgalDualChartUnavailable;
