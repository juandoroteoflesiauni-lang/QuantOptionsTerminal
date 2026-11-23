import type { AmericanIvStatus, ImpliedVolResolution } from '../../../src/core/options/ivContract.js';
import type {
  ContractMultiplierSource, DealerSignBasis, GexComputationStatus, OiFieldProvenance,
  OiQualityTier, OiSourceConflictRecord, OptionFieldProvenanceMap,
} from '../../../src/core/options/oiProvenance.js';

export type FeedStatus = 'LIVE' | 'EOD_CIERRE' | 'DIFERIDO_20M' | 'PARTIAL' | 'NO_DATA';

export interface GlobalIndicatorDto {
  readonly id: string;
  readonly label: string;
  readonly value: number | null;
  readonly decimals: number;
  readonly prefix?: string;
  readonly suffix?: string;
  readonly deltaPct: number | null;
  readonly help: string;
  readonly source: string;
}

export interface ArStockDto {
  readonly ticker: string;
  readonly name: string;
  readonly sector: 'Bancos' | 'Energía' | 'Reguladas' | 'Materiales' | 'Telecom' | 'Agro' | 'CEDEAR';
  readonly panel: 'Líder' | 'General' | 'CEDEAR';
  readonly color: string;
  readonly last: number | null;
  readonly bid: number | null;
  readonly ask: number | null;
  readonly deltaPct: number | null;
  readonly prevClose: number | null;
  readonly low: number | null;
  readonly high: number | null;
  readonly dayRangePos?: number | null;
  readonly vwap: number | null;
  readonly volumeM: number | null;
  readonly volMultiple: number | null;
  readonly return30dPct?: number | null;
  readonly returnYtdOr252dPct?: number | null;
  readonly realizedVol30dPct?: number | null;
  readonly beta?: number | null;
  readonly avgVolume40dM?: number | null;
  readonly signalText: string;
  readonly adrTicker?: string;
  readonly adrRatio?: number;
  readonly adrPrice?: number | null;
  readonly adrDeltaPct?: number | null;
  readonly cclImplicit?: number | null;
  readonly cclZScore?: number | null;
  readonly cclMismatchPct?: number | null;
  readonly cclMismatchArs?: number | null;
  readonly fairArsPrice?: number | null;
  readonly iv30d?: number | null;
  readonly ivSource?: 'OPRA_IV' | 'MASSIVE_RV30D' | 'NONE';
  readonly ivRank?: 'barata' | 'rango' | 'cara';
  readonly ivPercentile?: number | null;
  readonly hasUsOptions?: boolean;
  readonly hasBymaOptions?: boolean;
  readonly arbitrageSignal?: string | null;
  readonly sparkline: readonly number[];
  readonly source: string;
}

export interface MepCclArbitrageRow {
  readonly symbol: string;
  readonly category: 'BONO' | 'ADR' | 'CEDEAR';
  readonly ratio: number;
  readonly localArs: number | null;
  readonly usdPrice: number | null;
  readonly impliedRate: number | null;
  readonly medianRate: number | null;
  readonly spreadBps: number | null;
  readonly zScore: number | null;
  readonly side: 'MEP' | 'CCL';
}

export interface ArBondDto {
  readonly ticker: string;
  readonly name: string;
  readonly legislation: 'ARG' | 'NY' | 'PROVINCIAL' | 'CORPORATE' | 'TESORO';
  readonly maturity: string;
  readonly currency: 'USD' | 'ARS' | 'CER';
  readonly priceUsd: number | null;
  readonly priceArs: number | null;
  readonly deltaPct: number | null;
  readonly tirPct: number | null;
  readonly parityPct: number | null;
  readonly duration: number | null;
  readonly accruedInterest: number | null;
  readonly volumeM: number | null;
  readonly cclImplicit?: number | null;
  readonly mepImplicit?: number | null;
  readonly source: string;
}

export interface ArNoteOrCorpDto {
  readonly ticker: string;
  readonly name: string;
  readonly kind: 'LECAP_BONCAP' | 'ON_CORP';
  readonly price: number | null;
  readonly bid: number | null;
  readonly ask: number | null;
  readonly deltaPct: number | null;
  readonly volumeM: number | null;
  readonly source: string;
}

export interface ArMacroCardDto {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly numericValue: number | null;
  readonly delta: string;
  readonly deltaPct: number | null;
  readonly help: string;
  readonly source: string;
  readonly updatedAt: string | null;
}

export interface ArOverviewResponse {
  readonly asOfUtcSec: number;
  readonly feedStatus: FeedStatus;
  readonly data912Status: 'OK' | 'ERROR';
  readonly openBymaStatus: 'OK' | 'DEGRADED';
  readonly marketState: 'ABIERTO' | 'SUBASTA' | 'CERRADO' | 'PREMARKET';
  readonly marketStateLabel: string;
  readonly providerErrors: readonly string[];
  readonly globalIndicators: readonly GlobalIndicatorDto[];
  readonly mepMedian: number | null;
  readonly cclMedian: number | null;
  readonly mepCclGapPct: number | null;
  readonly mervalStocks: readonly ArStockDto[];
  readonly generalPanelStocks: readonly ArStockDto[];
  readonly cedears: readonly ArStockDto[];
  readonly mepCclMatrix: readonly MepCclArbitrageRow[];
}

export interface ArMacroResponse {
  readonly asOfUtcSec: number;
  readonly feedStatus: FeedStatus;
  readonly providerErrors: readonly string[];
  readonly cards: readonly ArMacroCardDto[];
  readonly variables: {
    readonly a3500: number | null;
    readonly badlarTna: number | null;
    readonly tamarTna: number | null;
    readonly tpmTna: number | null;
    readonly plazoFijoTna?: number | null;
    readonly cer: number | null;
    readonly uva: number | null;
    readonly reservasUsdM: number | null;
    readonly baseMonetariaArsM: number | null;
    readonly inflacionMensualPct: number | null;
    readonly inflacionInteranualPct: number | null;
    readonly riesgoPaisPb: number | null;
    readonly mep: number | null;
    readonly ccl: number | null;
    readonly canjePct?: number | null;
    readonly blue: number | null;
    readonly oficial: number | null;
  };
  readonly dolares: readonly {
    readonly casa: string;
    readonly nombre: string;
    readonly compra: number | null;
    readonly venta: number | null;
    readonly fechaActualizacion: string | null;
  }[];
  readonly sovereignCurve: readonly ArBondDto[];
}

export interface PanelVolumeDayPoint {
  readonly date: string;
  readonly totalVolumeM: number;
}

export interface PanelVolumeShareItem {
  readonly symbol: string;
  readonly name: string;
  readonly color: string;
  readonly volumeM: number;
  readonly sharePct: number;
}

export interface PanelVolHistoryPoint {
  readonly date: string;
  readonly panelVolPct: number;
  readonly avgStockVolPct: number | null;
  readonly constituents: number;
}

export type UsEquitySessionPhase = 'PRE_MARKET' | 'RTH' | 'AFTER_HOURS' | 'CLOSED';

export interface EquityPanelRowDto {
  readonly symbol: string;
  readonly name: string;
  readonly sector: string;
  readonly panel: 'Líder' | 'General';
  readonly color: string;
  readonly last: number | null;
  readonly prevClose: number | null;
  readonly dayLow: number | null;
  readonly dayHigh: number | null;
  readonly dayRangePos: number | null;
  readonly volumeM: number | null;
  readonly tradedVolumeUsd?: number | null;
  readonly return1dPct: number | null;
  readonly return30dPct: number | null;
  readonly returnYtdOr252dPct: number | null;
  readonly realizedVol30dPct: number | null;
  readonly beta: number | null;
  readonly avgVolume40dM: number | null;
  readonly iv30d: number | null;
  readonly hasUsOptions: boolean;
  readonly regularClose?: number | null;
  readonly extendedPrice?: number | null;
  readonly extendedChangePct?: number | null;
  readonly sessionPhase?: UsEquitySessionPhase;
}

export interface EquityPanelAnalyticsDto {
  readonly asOfUtcSec: number;
  readonly benchmarkSymbol: string;
  readonly panelLabel: string;
  readonly currency: 'USD' | 'ARS';
  readonly rows: readonly EquityPanelRowDto[];
  readonly panelVolume40d: readonly PanelVolumeDayPoint[];
  readonly volumeAvg40dM: number | null;
  readonly volumeShareBreakdown: readonly PanelVolumeShareItem[];
  readonly panelVolHistory: readonly PanelVolHistoryPoint[];
  readonly topGainers: readonly EquityPanelRowDto[];
  readonly topLosers: readonly EquityPanelRowDto[];
  readonly errors: readonly string[];
}

export interface ArMonitoringResponse {
  readonly asOfUtcSec: number;
  readonly feedStatus: FeedStatus;
  readonly panel: 'acciones' | 'bonos' | 'cedears' | 'cauciones';
  readonly providerErrors: readonly string[];
  readonly stocks: readonly ArStockDto[];
  readonly generalPanel: readonly ArStockDto[];
  readonly bonds: readonly ArBondDto[];
  readonly cedears: readonly ArStockDto[];
  readonly arPanelAnalytics?: EquityPanelAnalyticsDto | null;
  readonly usEquityPanel?: EquityPanelAnalyticsDto | null;
  readonly notes: readonly ArNoteOrCorpDto[];
  readonly corps: readonly ArNoteOrCorpDto[];
  readonly mepMedian: number | null;
  readonly cclMedian: number | null;
  readonly badlarTna: number | null;
}

export interface ArHistoricalBarDto {
  readonly time: number;
  readonly date: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly closeDeflatedUsd: number | null;
  readonly volume: number;
  readonly dailyReturnPct: number | null;
}

export type TerminalTimeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1D' | '1W';

export interface SerializedBarDto {
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly vw?: number | null;
}

export interface OrderBookLevelDto {
  readonly price: number;
  readonly size: number;
}

export interface OrderBook5LevelsDto {
  readonly symbol: string;
  readonly marketSymbol: string;
  readonly settlement: string;
  readonly marketState: string;
  readonly source: string;
  readonly asOfUtcSec: number;
  readonly bids: readonly OrderBookLevelDto[];
  readonly asks: readonly OrderBookLevelDto[];
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly mid: number | null;
  readonly spreadArs: number | null;
  readonly spreadPct: number | null;
  readonly bidDepthSize: number | null;
  readonly askDepthSize: number | null;
  readonly vwapBid5: number | null;
  readonly vwapAsk5: number | null;
  readonly vwapBook5: number | null;
  readonly obi5: number | null;
  readonly last: number | null;
  readonly open: number | null;
  readonly high: number | null;
  readonly low: number | null;
  readonly close: number | null;
  readonly settlementPrice: number | null;
  readonly nominalVolume: number | null;
}

export interface PrimaryDlrContractDto {
  readonly symbol: string;
  readonly maturityCode?: string | null;
  readonly maturityDate?: string | null;
  readonly category?: string | null;
  readonly price: number | null;
  readonly implicitTnaPct?: number | null;
  readonly volume?: number | null;
  readonly openInterest?: number | null;
}

export interface ArStockDetailResponse {
  readonly asOfUtcSec: number;
  readonly feedStatus: FeedStatus;
  readonly symbol: string;
  readonly assetType: 'STOCK' | 'CEDEAR' | 'BOND';
  readonly stock: ArStockDto | null;
  readonly bond: ArBondDto | null;
  readonly historicalBars: readonly ArHistoricalBarDto[];
  readonly adrBars?: {
    readonly timeframe: TerminalTimeframe;
    readonly source: 'MASSIVE_ADR_CONVERTED';
    readonly usTicker: string;
    readonly adrRatio: number;
    readonly cclUsed: number;
    readonly bars: readonly ArHistoricalBarDto[];
  } | null;
  readonly benchmarkSymbol?: string | null;
  readonly benchmarkBars1d?: readonly ArHistoricalBarDto[];
  readonly nextExpiry?: {
    readonly expiryCode: string;
    readonly expirationDate: string;
    readonly expiryUtcSec: number;
    readonly daysToExpiry: number;
    readonly ivAtm: number | null;
    readonly expectedMoveAbs: number | null;
    readonly expectedMovePct: number | null;
  } | null;
  readonly realizedVol20d: number | null;
  readonly realizedVol60d: number | null;
  readonly realizedVolUsd20d: number | null;
  readonly rsi14: number | null;
  readonly sma50: number | null;
  readonly sma200: number | null;
  readonly ema21: number | null;
  readonly mtfRegime: string;
  readonly relatedOptionsCount: number;
  readonly institutionalEngines?: ArStockInstitutionalEnginesDto | null;
  readonly orderBook5Levels?: OrderBook5LevelsDto | null;
  readonly orderBookCi?: OrderBook5LevelsDto | null;
  readonly rofexFrontContract?: PrimaryDlrContractDto | null;
  readonly providerErrors: readonly string[];
}

export interface VolumeProfileBinDto {
  readonly price: number | null;
  readonly volume: number | null;
  readonly volumeShare: number | null;
  readonly volumePercentile: number | null;
  readonly classification: string;
}

export interface VolumeProfileAmtDto {
  readonly status: 'OK' | 'NO_DATA';
  readonly asOfUtcSec: number;
  readonly poc: number | null;
  readonly vah: number | null;
  readonly val: number | null;
  readonly profileVwap: number | null;
  readonly totalVolume: number | null;
  readonly valueAreaCoverage: number | null;
  /** Pieza 50.4: ventana efectiva del perfil (`Math.min(cerradas, 252)`). */
  readonly windowBars?: number | null;
  readonly closedBarCount?: number | null;
  readonly bins: readonly VolumeProfileBinDto[];
  readonly hvnBins: readonly VolumeProfileBinDto[];
  readonly lvnBins: readonly VolumeProfileBinDto[];
}

export interface NakedPocRecordDto {
  readonly sessionDate: string;
  readonly sessionPoc: number | null;
}

export interface TrackNakedPocsDto {
  readonly status: 'OK' | 'NO_DATA';
  readonly activeNakedPocs: readonly NakedPocRecordDto[];
}

export interface QuantitativeFvgRecordDto {
  readonly id: string;
  readonly type: 'BULLISH_FVG' | 'BEARISH_FVG';
  readonly formedAtTime: number;
  readonly gapLow: number | null;
  readonly gapHigh: number | null;
  readonly gapWidth: number | null;
  readonly consequentEncroachment: number | null;
  readonly rangeZScore: number | null;
  readonly fillPct: number | null;
  readonly isMitigated: boolean;
}

export interface QuantitativeFvgDto {
  readonly status: 'OK' | 'NO_DATA';
  readonly fvgs: readonly QuantitativeFvgRecordDto[];
  readonly activeFvgs: readonly QuantitativeFvgRecordDto[];
}

export interface FreshOrderBlockRecordDto {
  readonly id: string;
  readonly type: 'BULLISH_FOB' | 'BEARISH_FOB';
  readonly formedAtTime: number;
  readonly zoneLow: number | null;
  readonly zoneHigh: number | null;
  readonly anchorPrice: number | null;
  readonly anchorSource: string;
  readonly displacementZScore: number | null;
  readonly darkPoolShare: number | null;
  readonly isFresh: boolean;
  readonly isMitigated: boolean;
}

export interface FreshOrderBlockDto {
  readonly status: 'OK' | 'NO_DATA';
  readonly orderBlocks: readonly FreshOrderBlockRecordDto[];
  readonly freshOrderBlocks: readonly FreshOrderBlockRecordDto[];
}

export interface SpatialConfluenceClusterDto {
  readonly centroidPrice: number | null;
  readonly bandLow: number | null;
  readonly bandHigh: number | null;
  readonly bandWidthAtr: number | null;
  readonly distanceToSpotAtr: number | null;
  readonly levels: readonly {
    readonly name: string;
    readonly category: string;
    readonly price: number | null;
    readonly expectedReaction: string;
  }[];
  readonly distinctCategories: readonly string[];
  readonly distinctCategoriesCount: number;
  readonly isTripleConfluence: boolean;
  readonly expectedReaction: string;
  readonly triggerAligned: boolean;
  readonly clusterStrength: number | null;
}

export interface SpatialConfluenceDto {
  readonly status: 'OK' | 'NO_DATA';
  readonly spot: number | null;
  readonly atr: number | null;
  readonly clusterRadiusAtr: number | null;
  readonly clusters: readonly SpatialConfluenceClusterDto[];
  readonly tripleConfluenceCount: number;
  readonly strongestClusterCentroid: number | null;
  readonly strongestClusterStrength: number | null;
}

export interface RelativeStrengthAndCatalystsDto {
  readonly status: 'OK' | 'NO_DATA';
  readonly assetReturn: number | null;
  readonly benchmarkReturn: number | null;
  readonly rsSpread: number | null;
  readonly rsRatioChange: number | null;
  readonly rsClassification: string;
  readonly hoursToEarnings: number | null;
  readonly entryBlocked: boolean;
  readonly blockReason: string;
}

export interface SignedOptionsOrderFlowDto {
  readonly evaluatedPrints: number;
  readonly callBuyPremiumUsd: number | null;
  readonly callSellPremiumUsd: number | null;
  readonly callNetPremiumCvdUsd: number | null;
  readonly putBuyPremiumUsd: number | null;
  readonly putSellPremiumUsd: number | null;
  readonly putNetPremiumCvdUsd: number | null;
  readonly netDirectionalPremiumUsd: number | null;
  readonly netDeltaShares: number | null;
  readonly netVegaUsd: number | null;
}

export interface VolOiAnomalyContractDto {
  readonly contractTicker: string;
  readonly strike: number | null;
  readonly expiryUtcSec: number;
  readonly contractType: 'call' | 'put';
  readonly dteDays: number | null;
  readonly dayVolume: number | null;
  readonly openInterest: number | null;
  readonly volOiRatio: number | null;
  readonly madLogScore: number | null;
  readonly isAnomaly: boolean;
  readonly delta: number | null;
}

export interface VolOiAnomalyDetectionDto {
  readonly evaluatedContracts: number;
  readonly anomalies: readonly VolOiAnomalyContractDto[];
}

export interface FlowAdjustedGexDto {
  readonly spot: number | null;
  readonly totalSignedDollarGex: number | null;
  readonly totalCharmExposure: number | null;
  readonly callWallStrike: number | null;
  readonly putWallStrike: number | null;
}

export interface GexCharmPinDto {
  readonly gexCharmPinStrike: number | null;
  readonly peakPinStrike: number | null;
  readonly pinMagnetStrength: number | null;
  readonly eligibleContractsCount: number;
}

export interface WheelByWheelTrackerDto {
  readonly regime: string;
  readonly spotReturnPct: number | null;
  readonly gammaFlipChange: number | null;
  readonly gexCharmPinChange: number | null;
  readonly distanceToPinPct: number | null;
  readonly isLateSessionEt: boolean;
  readonly snapshotsCount: number;
}

export interface RiskNeutralDistributionDto {
  readonly status: 'OK' | 'NO_DATA';
  readonly meanQ: number | null;
  readonly stdDevQ: number | null;
  readonly skewnessQ: number | null;
  readonly excessKurtosisQ: number | null;
}

export interface EmpiricalDistributionDto {
  readonly status: 'OK' | 'NO_DATA';
  readonly usedBarsCount: number;
  readonly horizonSamplesCount: number;
  readonly meanLogReturn: number | null;
  readonly stdDevLogReturn: number | null;
  readonly skewness: number | null;
  readonly excessKurtosis: number | null;
  readonly overnightVarianceShare: number | null;
  readonly rthVarianceShare: number | null;
  readonly tailEventsCount: number;
  readonly tailFrequencyPct: number | null;
}

export interface PqLevelDivergenceDto {
  readonly status: 'OK' | 'NO_DATA';
  readonly levels: readonly {
    readonly label: string;
    readonly price: number | null;
    readonly direction: 'ABOVE' | 'BELOW';
    readonly probP: number | null;
    readonly probQ: number | null;
    readonly pqSpread: number | null;
    readonly pqRatio: number | null;
    readonly classification: string;
  }[];
}

export interface VolConeAndRankDto {
  readonly status: 'OK' | 'NO_DATA';
  readonly ivAtm: number | null;
  readonly ivMin: number | null;
  readonly ivMax: number | null;
  readonly ivRank: number | null;
  readonly ivPercentile: number | null;
  readonly cones: readonly {
    readonly horizonDays: number | null;
    readonly sigmaMovePct: number | null;
    readonly upper1Sigma: number | null;
    readonly lower1Sigma: number | null;
    readonly upper2Sigma: number | null;
    readonly lower2Sigma: number | null;
  }[];
}

export interface SyntheticImpliedRatesDto {
  readonly status: 'OK' | 'NO_DATA';
  readonly medianImpliedRate: number | null;
  readonly medianImpliedTna: number | null;
  readonly impliedBorrowRate: number | null;
  readonly borrowRegime: string;
}

export interface ConversionReversalDto {
  readonly status: 'OK' | 'NO_DATA';
  readonly conversionAnnualizedTna: number | null;
  readonly reversalAnnualizedTna: number | null;
  readonly netEdgeVsRiskFreeBps: number | null;
  readonly arbitrageSignal: string;
  /** Pieza 50.3: bloqueo de anualización por DTE < 3. */
  readonly rateStatus?: 'OK' | 'BLOCKED_SHORT_DTE' | 'NO_DATA';
}

export interface BuyWriteDto {
  readonly status: 'OK' | 'NO_DATA';
  readonly netCostBasis: number | null;
  readonly breakevenPrice: number | null;
  readonly downsideProtectionPct: number | null;
  readonly staticReturnPct: number | null;
  readonly staticAnnualizedTna: number | null;
  readonly maxAssignedReturnPct: number | null;
  readonly assignedAnnualizedTna: number | null;
  readonly annualizedRate?: number | null;
  readonly rateStatus?: 'OK' | 'BLOCKED_SHORT_DTE' | 'NO_DATA';
}

export interface CalendarRollDto {
  readonly status: 'OK' | 'NO_DATA';
  readonly netRollCredit: number | null;
  readonly annualizedRollYield: number | null;
  readonly annualizedRollYieldOnSpot: number | null;
  readonly netThetaDiff: number | null;
  readonly netVegaDiff: number | null;
}

export interface EvaluatedStructureLegDto {
  readonly strike: number | null;
  readonly contractType: 'call' | 'put';
  readonly side: 'BUY' | 'SELL';
  readonly quantity: number;
  readonly bid: number | null;
  readonly ask: number | null;
  readonly executionPrice: number | null;
  readonly feeAmount: number | null;
  readonly vatAmount: number | null;
}

export interface EvaluatedOptionStructureDto {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly direction: 'BULLISH' | 'BEARISH';
  readonly legs: readonly EvaluatedStructureLegDto[];
  readonly isDefinedRisk: boolean;
  readonly grossDebitOrCredit: number | null;
  readonly totalFees: number | null;
  readonly totalVat: number | null;
  readonly totalFriction: number | null;
  readonly netDebitOrCredit: number | null;
  readonly spreadWidth: number | null;
  readonly costPctOfWidth: number | null;
  readonly maxLoss: number | null;
  readonly capitalAtRisk: number | null;
  readonly maxProfit: number | null;
  readonly breakevenPrices: readonly number[];
  readonly pop: number | null;
  readonly expectedValue: number | null;
  readonly expectedReturnOnRisk: number | null;
  readonly convexityScore: number | null;
}

export interface OptimizeOptionStructuresDto {
  readonly status: 'OK' | 'NO_DATA';
  readonly direction: 'BULLISH' | 'BEARISH';
  readonly spot: number | null;
  readonly targetPrice: number | null;
  readonly dte: number | null;
  readonly lotSize: number | null;
  readonly liquidContractsCount: number;
  readonly candidates: readonly EvaluatedOptionStructureDto[];
  readonly bestByPop: EvaluatedOptionStructureDto | null;
  readonly bestByExpectedValue: EvaluatedOptionStructureDto | null;
  readonly bestByConvexity: EvaluatedOptionStructureDto | null;
}

export interface StructureCostPercentileDto {
  readonly status: 'OK' | 'NO_DATA';
  readonly currentCostPctOfWidth: number | null;
  readonly percentile: number | null;
  readonly regime: string;
  readonly observationsUsed: number;
}

export interface ArStockInstitutionalEnginesDto {
  readonly atr14: number | null;
  readonly cvdSlopeSign: number | null;
  readonly volumeProfile: VolumeProfileAmtDto | null;
  readonly nakedPocs: TrackNakedPocsDto | null;
  readonly fvgs: QuantitativeFvgDto | null;
  readonly orderBlocks: FreshOrderBlockDto | null;
  readonly relativeStrength: RelativeStrengthAndCatalystsDto | null;
  readonly confluenceClusters: SpatialConfluenceDto | null;
}

export interface ArOptionsQuantEnginesDto {
  readonly orderFlowArs: SignedOptionsOrderFlowDto | null;
  readonly netDirectionalPremiumUsdCcl: number | null;
  readonly callNetPremiumCvdUsdCcl: number | null;
  readonly putNetPremiumCvdUsdCcl: number | null;
  readonly volOiAnomalies: VolOiAnomalyDetectionDto | null;
  readonly flowAdjustedGex: FlowAdjustedGexDto | null;
  readonly gexCharmPin: GexCharmPinDto | null;
  readonly qDistribution: RiskNeutralDistributionDto | null;
  readonly pDistribution: EmpiricalDistributionDto | null;
  readonly pqDivergence: PqLevelDivergenceDto | null;
  readonly volCone: VolConeAndRankDto | null;
  readonly syntheticRates: SyntheticImpliedRatesDto | null;
  readonly conversionReversal: ConversionReversalDto | null;
  readonly buyWrite: BuyWriteDto | null;
  readonly calendarRoll: CalendarRollDto | null;
  readonly structureOptimizerBullish: OptimizeOptionStructuresDto | null;
  readonly structureOptimizerBearish: OptimizeOptionStructuresDto | null;
  readonly structureCostPercentile: StructureCostPercentileDto | null;
  readonly confluenceClusters: SpatialConfluenceDto | null;
}

export interface SerializedTerminalEnginesDto {
  readonly atr14d: number | null;
  readonly cvdSlopeSign: number | null;
  readonly volumeProfile: VolumeProfileAmtDto | null;
  readonly nakedPocs: TrackNakedPocsDto | null;
  readonly fvgs: QuantitativeFvgDto | null;
  readonly orderBlocks: FreshOrderBlockDto | null;
  readonly orderFlow: SignedOptionsOrderFlowDto | null;
  readonly volOiAnomalies: VolOiAnomalyDetectionDto | null;
  readonly flowAdjustedGex: FlowAdjustedGexDto | null;
  readonly gexCharmPin: GexCharmPinDto | null;
  readonly wheelTracker: WheelByWheelTrackerDto | null;
  readonly qDistribution: RiskNeutralDistributionDto | null;
  readonly pDistribution: EmpiricalDistributionDto | null;
  readonly pqDivergence: PqLevelDivergenceDto | null;
  readonly volCone: VolConeAndRankDto | null;
  readonly syntheticRates: SyntheticImpliedRatesDto | null;
  readonly conversionReversal: ConversionReversalDto | null;
  readonly buyWrite: BuyWriteDto | null;
  readonly calendarRoll: CalendarRollDto | null;
  readonly relativeStrength: RelativeStrengthAndCatalystsDto | null;
  readonly confluenceClusters: SpatialConfluenceDto | null;
  readonly structureOptimizerBullish: OptimizeOptionStructuresDto | null;
  readonly structureOptimizerBearish: OptimizeOptionStructuresDto | null;
  readonly structureCostPercentile: StructureCostPercentileDto | null;
  /**
   * Pieza 50.2: referencia estructural mínima de la suite de volatilidad por
   * vencimiento (`expiriesByCode`); el tipado completo vive en `optionsDerived`.
   */
  readonly volAnalyticsSuite?: UsVolAnalyticsSuiteRef | null;
}

/** Referencia estructural mínima de la suite de volatilidad por vencimiento. */
export interface UsVolAnalyticsSuiteRef {
  readonly status: 'OK' | 'NO_DATA';
  readonly expiriesByCode: Readonly<Record<string, unknown>>;
}

export interface ArOptionContractDto {
  readonly ivStatus?: AmericanIvStatus;
  readonly ivResolution?: ImpliedVolResolution;
  readonly theoreticalPriceModel?: 'AMERICAN_BS2002_SURFACE';
  readonly fieldProvenance?: OptionFieldProvenanceMap;
  readonly oiProvenance?: OiFieldProvenance;
  readonly contractMultiplier?: number;
  readonly multiplierSource?: ContractMultiplierSource;
  readonly symbol: string;
  readonly underlying: string;
  readonly contractType: 'call' | 'put';
  readonly strike: number;
  readonly expiryCode: string;
  readonly expirationDate: string;
  readonly expiryUtcSec: number;
  readonly daysToExpiry: number;
  readonly bid: number | null;
  readonly bidSize?: number | null;
  readonly ask: number | null;
  readonly askSize?: number | null;
  readonly last: number | null;
  readonly mark: number | null;
  readonly volume: number | null;
  readonly openInterest: number | null;
  readonly iv: number | null;
  readonly delta: number | null;
  readonly gamma: number | null;
  readonly thetaDaily: number | null;
  readonly vegaPer1Pct: number | null;
  readonly rho: number | null;
  readonly vanna: number | null;
  readonly charm: number | null;
  readonly intrinsic: number;
  readonly extrinsic: number | null;
  readonly previousClose?: number | null;
  readonly changePct?: number | null;
  readonly source: 'DATA912' | 'MODEL';
  readonly quoteSource?: 'DATA912' | 'BMB_HOMEBROKER_BRIDGE' | 'OPEN_BYMA';
  readonly quoteAsOfUtcSec?: number | null;
}

export interface ArOptionExpiryDto {
  readonly expiryCode: string;
  readonly expiryLabel: string;
  readonly expirationDate: string;
  readonly expiryUtcSec: number;
  readonly days: number;
  readonly ivAtm: number | null;
  readonly riskReversal25: number | null;
  readonly butterfly25: number | null;
  readonly butterflyArbitrageFree: boolean;
  readonly strikes: readonly number[];
  readonly calls: readonly ArOptionContractDto[];
  readonly puts: readonly ArOptionContractDto[];
  /** Pieza 50.2: `true` si la cadena del vencimiento está cargada en profundidad. */
  readonly loaded?: boolean;
}

export interface ArOptionsResponse {
  readonly asOfUtcSec: number;
  readonly feedStatus: FeedStatus;
  readonly underlying: string;
  readonly market?: 'AR' | 'US';
  readonly spot: number | null;
  readonly rateTna: number | null;
  readonly continuousRate: number | null;
  readonly dividendYield: number;
  readonly lotSize: number;
  readonly settlement: 'T+0';
  readonly exerciseCutoffArt: '15:30 ART';
  readonly realizedVol20d: number | null;
  readonly realizedVol60d: number | null;
  readonly histMedianIv: number | null;
  readonly vrpSpread: number | null;
  readonly historicalCloses: readonly number[];
  readonly termStructure: readonly {
    readonly days: number;
    readonly label: string;
    readonly expiryCode: string;
    readonly atm: number;
  }[];
  readonly expiries: readonly ArOptionExpiryDto[];
  readonly exposureSummary: {
    readonly gexStatus?: GexComputationStatus;
    readonly oiQuality?: OiQualityTier;
    readonly oiCoverageRatio?: number;
    readonly isPartial?: boolean;
    readonly currency?: 'ARS';
    readonly gexUnit?: 'ARS_PER_1PCT_SPOT_MOVE';
    readonly dealerSignBasis?: DealerSignBasis;
    readonly netGex: number | null;
    readonly netDex: number | null;
    readonly netVex: number | null;
    readonly netCex: number | null;
    readonly vannaRegime: 'SUPPORTIVE_ON_IV_DROP' | 'PRESSURE_ON_IV_DROP' | 'NEUTRAL';
    readonly charmPinStrike: number | null;
    readonly callWallStrike: number | null;
    readonly putWallStrike: number | null;
    readonly gammaFlipSpot: number | null;
    readonly gammaFlipStatus: string;
    readonly expectedMoveAbs: number | null;
    readonly expectedMovePct: number | null;
    readonly expectedMoveExpirySec?: number | null;
    readonly expectedMoveExpiryCode?: string | null;
    readonly expectedMoveDays?: number | null;
    /** Pieza 50.9: candidatos de cruce (REST selecciona el más cercano). */
    readonly gammaFlipCandidates?: readonly number[];
    /** Pieza 50.9: traza honesta AR (BMB acredita último trade, no puntas). */
    readonly trace?: {
      readonly evaluationSec: number;
      readonly valuationSpot: number | null;
      readonly valuationSpotSource: 'OVERVIEW' | 'HISTORICAL_CLOSE' | null;
      readonly quoteMode: null;
      readonly coverage: 'complete' | 'partial' | 'unknown';
      readonly quoteTimes: null;
      readonly engineExpirationDates: readonly string[];
      readonly engineStrikeRange: { readonly min: number | null; readonly max: number | null };
      readonly engineStrikeCount: number;
      readonly byStrikeRange: { readonly min: number | null; readonly max: number | null };
      readonly byStrikeCount: number;
      readonly missingOiInputs?: number;
      readonly invalidOiInputs?: number;
      readonly observedZeroOiInputs?: number;
      readonly iamcOiInputs?: number;
      readonly directContractOiInputs?: number;
      readonly oiConflicts?: readonly OiSourceConflictRecord[];
      readonly oiUniverseInputs?: number;
      readonly ivStatusCounts?: Readonly<Partial<Record<AmericanIvStatus, number>>>;
      readonly directOiInputs: number;
      readonly proxyOiInputs: number;
      readonly oiProxy: boolean | null;
    };
    readonly quality?: {
      readonly usableContracts: number;
      readonly usableOpenInterest: number;
      readonly usableOpenInterestShares?: number | null;
    };
    readonly byStrike?: readonly {
      readonly strike: number;
      readonly callOi: number | null;
      readonly putOi: number | null;
      readonly callVolume?: number | null;
      readonly putVolume?: number | null;
      readonly callGex: number | null;
      readonly putGex: number | null;
      readonly netGex: number | null;
      readonly vex?: number | null;
      readonly cex?: number | null;
      readonly netVannaExposure?: number | null;
      readonly netCharmExposure?: number | null;
    }[];
  } | null;
  readonly costSchedule: {
    readonly rvMarketFeeRate: number;
    readonly optionsFeeRate: number;
    readonly shortLoanFeeRate: number;
    readonly vatRate: number;
    readonly bondsVatExempt: true;
  };
  readonly primaryLiquidExpiryCode?: string | null;
  readonly forwardIvSegments?: readonly ForwardIvSegmentDto[];
  readonly quantEngines?: ArOptionsQuantEnginesDto | null;
  /** Pieza 50.2: motores cuantitativos por vencimiento cargado on-demand. */
  readonly quantEnginesByExpiry?: Readonly<Record<string, ArOptionsQuantEnginesDto>>;
  /** Pieza 50.2: exposición de dealers por vencimiento cargado on-demand. */
  readonly exposureSummaryByExpiry?: Readonly<
    Record<string, NonNullable<ArOptionsResponse['exposureSummary']>>
  >;
  readonly providerErrors: readonly string[];
}

export interface ForwardIvSegmentDto {
  readonly nearExpiryCode: string | null;
  readonly farExpiryCode: string | null;
  readonly nearExpirySec: number | null;
  readonly farExpirySec: number | null;
  readonly nearDte: number | null;
  readonly farDte: number | null;
  readonly nearTimeToExpiry: number;
  readonly farTimeToExpiry: number;
  readonly nearIv: number | null;
  readonly farIv: number | null;
  readonly forwardVariance: number | null;
  readonly forwardIv: number | null;
  readonly calendarArbFlag: boolean;
  readonly status: 'OK' | 'CALENDAR_ARB' | 'INVALID';
}

export interface EarningsCatalystDto {
  readonly date: string;
  readonly utcSec: number;
  readonly timeOfDay?: 'bmo' | 'amc' | 'unknown' | null;
  readonly epsEstimate?: number | null;
  readonly epsActual?: number | null;
}

export interface MacroCatalystDto {
  readonly kind: 'FOMC' | 'CPI';
  readonly label: string;
  readonly date: string;
  readonly utcSec: number;
  readonly impact?: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface SymbolCatalystsResponseDto {
  readonly symbol: string;
  readonly asOfUtcSec: number;
  readonly available: boolean;
  readonly nextEarnings: EarningsCatalystDto | null;
  readonly lastEarnings: EarningsCatalystDto | null;
  readonly macroEvents: readonly MacroCatalystDto[];
  readonly earningsSource: string | null;
  readonly macroSource: string | null;
  readonly reason: string | null;
  readonly cacheHit?: boolean;
}

export type RelationOpportunityBadge =
  | 'EXTREMO COMPRA'
  | 'EXTREMO VENTA'
  | 'DESVÍO MODERADO'
  | 'EN EQUILIBRIO';

export type RelationCategoryGroup = 'ROTACION_SECTORIAL' | 'LIQUIDEZ_CREDITO';

export interface ArRelationPairDto {
  readonly id: string;
  readonly name: string;
  readonly legA: string;
  readonly legB: string;
  readonly unit: string;
  readonly category?: string;
  readonly categoryGroup?: RelationCategoryGroup;
  readonly source?: 'MASSIVE_1D' | 'DATA912' | 'MIXED_USD_CCL';
  readonly currentValue: number | null;
  readonly mean60d: number | null;
  readonly std60d: number | null;
  readonly zScore: number | null;
  readonly percentile60d: number | null;
  readonly halfLifeDays?: number | null;
  readonly capitalFlowDeltaPct?: number | null;
  readonly opportunityBadge?: RelationOpportunityBadge | null;
  readonly observationCount?: number;
  readonly sparkline?: readonly number[];
  readonly signal: string;
  readonly history: readonly { readonly time: number; readonly ratio: number; readonly zScore: number }[];
}

export type RelationPairSnapshot = ArRelationPairDto;

export interface ArRelationsSummaryDto {
  readonly extremeTwoSigmaCount: number;
  readonly moderateDeviationCount: number;
  readonly topCapitalFlowPairId: string | null;
  readonly topCapitalFlowSector: string | null;
  readonly topCapitalFlowDeltaPct: number | null;
}

export interface ArRelationsResponse {
  readonly asOfUtcSec: number;
  readonly feedStatus: FeedStatus;
  readonly providerErrors: readonly string[];
  readonly pairs: readonly ArRelationPairDto[];
  readonly extendedPairs?: readonly ArRelationPairDto[];
  readonly relationPairs?: readonly ArRelationPairDto[];
  readonly relationSummary?: ArRelationsSummaryDto;
  readonly mepCclArbitrage: readonly MepCclArbitrageRow[];
}

export interface UsUnifiedQuoteDto {
  readonly ticker: string;
  readonly assetType: 'stock' | 'index';
  readonly price: number | null;
  readonly change: number | null;
  readonly changePct: number | null;
  readonly previousClose: number | null;
  readonly dayLow?: number | null;
  readonly dayHigh?: number | null;
  readonly dayRangePos?: number | null;
  readonly volumeM?: number | null;
  readonly tradedVolumeUsd?: number | null;
  readonly iv30d?: number | null;
  readonly marketStatus: string | null;
  readonly volume: number | null;
  readonly bid?: number | null;
  readonly ask?: number | null;
  readonly bidSize?: number | null;
  readonly askSize?: number | null;
  readonly spreadPct?: number | null;
  readonly regularClose?: number | null;
  readonly extendedPrice?: number | null;
  readonly extendedChangePct?: number | null;
  readonly sessionPhase?: UsEquitySessionPhase;
}

export interface UsStrikeExposureDto {
  readonly strike: number;
  readonly callOi: number | null;
  readonly putOi: number | null;
  readonly callVolume?: number | null;
  readonly putVolume?: number | null;
  readonly callGex: number | null;
  readonly putGex: number | null;
  readonly netGex: number | null;
  readonly netDex?: number | null;
  readonly netVannaExposure?: number | null;
  readonly netCharmExposure?: number | null;
  readonly vex?: number | null;
  readonly cex?: number | null;
}

export interface UsTerminalBarsResponseDto {
  readonly status: 'OK' | 'PARTIAL';
  readonly symbol: string;
  readonly timeframe: TerminalTimeframe;
  readonly requestedTimeframe?: TerminalTimeframe;
  readonly effectiveTimeframe?: TerminalTimeframe;
  readonly fallbackReason?: string | null;
  readonly barSeconds: number;
  readonly rthOnly: boolean;
  readonly asOfUtcSec: number;
  readonly visibleStartIndex: number;
  readonly bars: readonly SerializedBarDto[];
  readonly formingBar: SerializedBarDto | null;
  readonly overlays: {
    readonly ema9?: readonly (number | null)[];
    readonly ema21: readonly (number | null)[];
    readonly ema50?: readonly (number | null)[];
    readonly ema200?: readonly (number | null)[];
    readonly sma50: readonly (number | null)[];
    readonly sma200: readonly (number | null)[];
    readonly hma55: readonly (number | null)[];
    readonly sessionVwap: readonly (number | null)[];
    readonly sessionVwapSupported: boolean;
    readonly avwap: readonly (number | null)[];
  };
  readonly subPanes: {
    readonly rsi14: readonly (number | null)[];
    readonly sessionCvd: readonly (number | null)[];
    readonly deltaMode: string | null;
  };
  /**
   * Pieza 50.5: anclas institucionales diarias Auto-AVWAP (backend `/api/bars`,
   * cacheadas por día). Espejo JSON-safe de `AutoAvwapAnchor`.
   */
  readonly autoAvwapAnchors?: readonly AutoAvwapAnchorDto[];
}

/** Pieza 50.5: rol del ancla institucional Auto-AVWAP. */
export type AutoAnchorRole = 'SUPPORT' | 'RESISTANCE' | 'EVENT';

/** Pieza 50.5: familia de detección que originó el ancla. */
export type AutoAnchorSource = 'EVENT' | 'PIVOT_MAJOR' | 'PIVOT_INTERMEDIATE' | 'RVOL';

/** Pieza 50.5: ancla institucional Auto-AVWAP tal como la serializa el backend. */
export interface AutoAvwapAnchorDto {
  readonly role: AutoAnchorRole;
  readonly anchorTimeSec: number;
  readonly windowIndex: number;
  readonly anchorPrice: number;
  readonly currentAvwap: number;
  readonly distancePct: number;
  readonly score: number;
  readonly sources: readonly AutoAnchorSource[];
  readonly eventLabel: string | null;
}

export interface UsOptionContractRowDto {
  readonly ticker: string;
  readonly contractType: 'call' | 'put';
  readonly strike: number;
  readonly expirationDate: string;
  readonly expiryUtcSec: number;
  readonly bid: number | null;
  readonly ask: number | null;
  readonly mid: number | null;
  readonly lastPrice: number | null;
  readonly openInterest: number | null;
  readonly volume: number | null;
  readonly previousClose?: number | null;
  readonly changePct?: number | null;
  readonly ownIv: number | null;
  readonly providerIv: number | null;
  readonly ivSource: 'OWN' | 'PROVIDER' | 'PARITY_OTM' | 'ATM_FALLBACK' | 'NONE';
  readonly delta: number | null;
  readonly gamma: number | null;
  readonly thetaDaily: number | null;
  readonly vegaPer1Pct: number | null;
  readonly vanna: number | null;
  readonly charm: number | null;
}

export interface UsVolSliceSummaryDto {
  readonly expirySec: number;
  readonly expirationDate: string;
  readonly timeToExpiryYears: number;
  readonly timeToExpiryDays: number;
  readonly forward: number | null;
  readonly rate: number | null;
  readonly dividendYield: number | null;
  readonly ivAtm: number | null;
  readonly riskReversal25: number | null;
  readonly butterfly25: number | null;
  readonly isButterflyArbitrageFree: boolean;
}

export interface UsSnapshotResponseDto {
  readonly status: 'OK' | 'PARTIAL';
  readonly feedMode?: 'LIVE' | 'EOD_CIERRE' | 'PARTIAL' | 'NO_DATA';
  readonly quoteMode?: 'LIVE_NBBO' | 'EOD_CLOSE_REF';
  readonly symbol: string;
  readonly correlatedSymbol?: string;
  readonly isIndex?: boolean;
  readonly asOfUtcSec: number;
  readonly marketContext?: {
    readonly unifiedQuotes?: readonly UsUnifiedQuoteDto[];
    readonly treasury?: {
      readonly date?: string | null;
      readonly yield1M?: number | null;
      readonly yield3M?: number | null;
      readonly yield1Y?: number | null;
      readonly yield2Y?: number | null;
      readonly yield10Y?: number | null;
      readonly sofr?: number | null;
      readonly rate30d?: number | null;
      readonly dividendYieldFront?: number | null;
    };
    readonly vixLevel?: number | null;
    readonly vixSlope?: number | null;
    readonly vixRegime?: string;
    readonly skewLevel?: number | null;
    readonly tailRiskAlert?: boolean | null;
  };
  readonly exposureSummary?: {
    readonly netGex: number | null;
    readonly netDex: number | null;
    readonly netVex?: number | null;
    readonly netCex?: number | null;
    readonly vannaRegime?: 'SUPPORTIVE_ON_IV_DROP' | 'PRESSURE_ON_IV_DROP' | 'NEUTRAL';
    readonly charmPinStrike?: number | null;
    readonly callWallStrike: number | null;
    readonly putWallStrike: number | null;
    readonly gammaFlipSpot: number | null;
    readonly gammaFlipStatus: string;
    /** Pieza 50.9: candidatos de cruce (REST selecciona el más cercano). */
    readonly gammaFlipCandidates?: readonly number[];
    /** Pieza 50.9: traza del insumo que produjo los niveles. */
    readonly trace?: {
      readonly evaluationSec: number;
      readonly valuationSpot: number | null;
      readonly valuationSpotSource: string | null;
      readonly headerSpot: number | null;
      readonly spotDivergenceBps: number | null;
      readonly quoteMode: 'LIVE_NBBO' | 'EOD_CLOSE_REF' | null;
      readonly coverage: 'complete' | 'partial' | 'unknown';
      readonly engineExpirationsCount: number;
      readonly engineExpirationDates: readonly string[];
      readonly engineStrikeRange: { readonly min: number | null; readonly max: number | null };
      readonly engineStrikeCount: number;
      readonly byStrikeRange: { readonly min: number | null; readonly max: number | null };
      readonly byStrikeCount: number;
      readonly catalogExpirationsCount: number | null;
      readonly catalogExpirationDates: readonly string[];
      readonly payloadContractCount: number;
      readonly payloadExpirationDates: readonly string[];
      readonly quoteTimes: {
        readonly knownCount: number;
        readonly unknownCount: number;
        readonly minUpdatedAtSec: number | null;
        readonly maxUpdatedAtSec: number | null;
        readonly newestAgeSec: number | null;
        readonly oldestAgeSec: number | null;
        readonly overlayQuoteCount: number;
        readonly eodReferenceCount: number;
      } | null;
      readonly chainCoverage: {
        readonly requestedDates: readonly string[];
        readonly deliveredDates: readonly string[];
        readonly missingDates: readonly string[];
        readonly chainTruncated: boolean;
        readonly chainErrors: boolean;
      } | null;
    };
    readonly expectedMove?: {
      readonly expiryUtcSec: number | null;
      readonly formulaMove: number | null;
      readonly formulaMovePct: number | null;
      readonly straddleMove: number | null;
      readonly straddleMovePct: number | null;
    };
    readonly quality?: {
      readonly totalContracts?: number;
      readonly activeContracts?: number;
      readonly usableContracts: number;
      readonly usableOpenInterest: number;
      readonly skippedContracts?: number;
      readonly skippedOiShare?: number | null;
    };
    readonly byStrike?: readonly UsStrikeExposureDto[];
  } | null;
  readonly volSurfaceSummary?: {
    readonly iv30d?: number | null;
    readonly butterflyArbitrageFree?: boolean;
    readonly calendarArbitrageFree?: boolean;
    readonly isArbitrageFree?: boolean;
    readonly frontSlice?: UsVolSliceSummaryDto | null;
    readonly slices?: readonly UsVolSliceSummaryDto[];
    readonly forwardIvSegments?: readonly ForwardIvSegmentDto[];
    readonly contracts?: readonly UsOptionContractRowDto[];
  } | null;
  readonly catalysts?: SymbolCatalystsResponseDto | null;
  readonly envelope?: {
    readonly snapshot?: {
      readonly metrics?: {
        readonly spot?: number | null;
        readonly iv30d?: number | null;
        readonly realizedVolAnnualized?: number | null;
        readonly rvCenteredAnnualized?: number | null;
      };
    };
    readonly metrics?: {
      readonly spot?: { readonly value: number | null };
      readonly realizedVol20d?: { readonly value: number | null };
      readonly realizedVol60d?: { readonly value: number | null };
    };
  };
  readonly terminalEngines?: SerializedTerminalEnginesDto | null;
  readonly microstructure?: {
    readonly mtf?: {
      readonly effectiveMacroRegime?: string | null;
      readonly setupStatus?: string | null;
      readonly close5m?: number | null;
      readonly ema21_15m?: number | null;
      readonly sma50_4h?: number | null;
      readonly sma200_1d?: number | null;
    } | null;
  } | null;
  readonly benchmarkBars1d?: readonly SerializedBarDto[];
  readonly usEquityPanel?: EquityPanelAnalyticsDto | null;
  readonly optionsChain?: {
    readonly selectedExpirationDate?: string | null;
    readonly selectionReason?: string | null;
    readonly prefetchExpirationDates?: readonly string[];
    readonly availableExpirations?: readonly {
      readonly expirationDate: string;
      readonly daysToExpiry: number;
      readonly loaded?: boolean;
      readonly validCallCount: number;
      readonly validPutCount: number;
      readonly nearAtmLiquidity: number;
      readonly inDefaultWindow: boolean;
      readonly hasCompleteAtmChain: boolean;
    }[];
  } | null;
}

export interface UsVolSurfaceResponseDto {
  readonly status: 'OK' | 'PARTIAL' | 'NO_DATA';
  readonly symbol: string;
  readonly asOfUtcSec: number;
  readonly cacheState: 'HIT' | 'MISS' | 'STALE' | 'UNAVAILABLE';
  readonly stale: boolean;
  readonly reason: string | null;
  readonly surface?:
    | {
        readonly status: 'OPERATIONAL';
        readonly source: 'ORATS_DELAYED_CORE';
        readonly ticker: string;
        readonly tradeDate?: string | null;
        readonly stockPrice?: number | null;
        readonly massiveSpotPrice?: number | null;
        readonly smvVol?: number | null;
        readonly iv10d?: number | null;
        readonly iv20d?: number | null;
        readonly iv30d?: number | null;
        readonly iv60d?: number | null;
        readonly iv90d?: number | null;
        readonly iv6m?: number | null;
        readonly iv1y?: number | null;
        readonly exErnIv10d?: number | null;
        readonly exErnIv20d?: number | null;
        readonly exErnIv30d?: number | null;
        readonly exErnIv60d?: number | null;
        readonly exErnIv90d?: number | null;
        readonly impliedMove?: number | null;
        readonly yangZhangAdrVol?: number | null;
        readonly strikes?: readonly {
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
        }[];
        readonly reason?: null;
      }
    | {
        readonly status: 'UNAVAILABLE';
        readonly source: 'ORATS_DELAYED_CORE';
        readonly ticker: string;
        readonly reason: string;
      }
    | null;
  readonly ivRank?:
    | {
        readonly status: 'OPERATIONAL';
        readonly source: 'ORATS_IV_RANK';
        readonly row: {
          readonly ticker: string;
          readonly tradeDate: string;
          readonly iv: number;
          readonly ivRank1m: number;
          readonly ivPct1m: number;
          readonly ivRank1y: number;
          readonly ivPct1y: number;
          readonly updatedAtUtcSec: number;
        };
      }
    | {
        readonly status: 'UNAVAILABLE';
        readonly source: 'ORATS_IV_RANK';
        readonly ticker: string;
        readonly reason: string;
      }
    | null;
}

export interface OptionsUnderlyingMetaDto {
  readonly key: string;
  readonly symbol: string;
  readonly market: 'AR' | 'US';
  readonly venue: 'BYMA' | 'OPRA';
  readonly currency: 'ARS' | 'USD';
  readonly name: string;
  readonly sector: string;
  readonly color: string;
}

/**
 * Pieza 50.2: respuesta de `GET /api/options/expiry?symbol=...&expiration=YYYY-MM-DD`
 * con el cuantitativo completo de ESA fecha (slice/Skew, exposición de dealers con
 * GEX/VEX/CEX, tasas sintéticas y suite de volatilidad evaluada con su DTE exacto).
 */
export interface UsOptionExpiryChainResponseDto {
  readonly status: 'OK' | 'PARTIAL';
  readonly feedMode: 'LIVE' | 'EOD_CIERRE' | 'PARTIAL' | 'NO_DATA';
  readonly quoteMode: 'LIVE_NBBO' | 'EOD_CLOSE_REF';
  readonly symbol: string;
  readonly expirationDate: string;
  readonly asOfUtcSec: number;
  readonly spot: number | null;
  readonly daysToExpiry: number;
  readonly expiryMeta: {
    readonly expirationDate: string;
    readonly daysToExpiry: number;
    readonly loaded: boolean;
    readonly validCallCount: number;
    readonly validPutCount: number;
    readonly nearAtmLiquidity: number;
    readonly inDefaultWindow: boolean;
    readonly hasCompleteAtmChain: boolean;
  };
  readonly slice: UsVolSliceSummaryDto | null;
  readonly contracts: readonly UsOptionContractRowDto[];
  readonly exposureSummary: NonNullable<UsSnapshotResponseDto['exposureSummary']> | null;
  readonly syntheticRates: ArOptionsQuantEnginesDto['syntheticRates'] | null;
  /** Pieza 50.3: tasas propias del vencimiento (antes quedaban congeladas al front 0DTE). */
  readonly conversionReversal?: ArOptionsQuantEnginesDto['conversionReversal'];
  readonly buyWrite?: ArOptionsQuantEnginesDto['buyWrite'];
  readonly volAnalyticsExpiry: unknown | null;
  readonly usOptionsFeed?: {
    readonly provider: 'TRADIER' | 'MASSIVE';
    readonly badge: string;
    readonly tradierOverlay?: unknown;
  };
  readonly dataQuality: {
    readonly ownSolvedIvContracts: number;
    readonly providerFallbackIvContracts: number;
    readonly parityExpiries: number;
    readonly chainContractsReceived: number;
    readonly chainContractsUsable: number;
    readonly warnings: readonly string[];
  };
}

export interface OptionsUnderlyingsResponseDto {
  readonly status: 'OK';
  readonly asOfUtcSec: number;
  readonly underlyings: readonly OptionsUnderlyingMetaDto[];
}
