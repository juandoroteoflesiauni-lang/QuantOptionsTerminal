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
  readonly vwap: number | null;
  readonly volumeM: number | null;
  readonly volMultiple: number | null;
  readonly signalText: string;
  readonly adrTicker?: string;
  readonly adrRatio?: number;
  readonly adrPrice?: number | null;
  readonly adrDeltaPct?: number | null;
  readonly cclImplicit?: number | null;
  readonly cclZScore?: number | null;
  readonly iv30d?: number | null;
  readonly ivRank?: 'barata' | 'rango' | 'cara';
  readonly ivPercentile?: number | null;
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

export interface ArMonitoringResponse {
  readonly asOfUtcSec: number;
  readonly feedStatus: FeedStatus;
  readonly panel: 'acciones' | 'bonos' | 'cedears' | 'cauciones';
  readonly providerErrors: readonly string[];
  readonly stocks: readonly ArStockDto[];
  readonly generalPanel: readonly ArStockDto[];
  readonly bonds: readonly ArBondDto[];
  readonly cedears: readonly ArStockDto[];
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

export interface ArStockDetailResponse {
  readonly asOfUtcSec: number;
  readonly feedStatus: FeedStatus;
  readonly symbol: string;
  readonly assetType: 'STOCK' | 'CEDEAR' | 'BOND';
  readonly stock: ArStockDto | null;
  readonly bond: ArBondDto | null;
  readonly historicalBars: readonly ArHistoricalBarDto[];
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
}

export interface ArOptionContractDto {
  readonly symbol: string;
  readonly underlying: string;
  readonly contractType: 'call' | 'put';
  readonly strike: number;
  readonly expiryCode: string;
  readonly expirationDate: string;
  readonly expiryUtcSec: number;
  readonly daysToExpiry: number;
  readonly bid: number | null;
  readonly ask: number | null;
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
  readonly source: 'DATA912' | 'MODEL';
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
}

export interface ArOptionsResponse {
  readonly asOfUtcSec: number;
  readonly feedStatus: FeedStatus;
  readonly underlying: string;
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
    readonly netGex: number | null;
    readonly netDex: number | null;
    readonly callWallStrike: number | null;
    readonly putWallStrike: number | null;
    readonly gammaFlipSpot: number | null;
    readonly gammaFlipStatus: string;
    readonly expectedMoveAbs: number | null;
    readonly expectedMovePct: number | null;
  } | null;
  readonly costSchedule: {
    readonly rvMarketFeeRate: number;
    readonly optionsFeeRate: number;
    readonly shortLoanFeeRate: number;
    readonly vatRate: number;
    readonly bondsVatExempt: true;
  };
  readonly quantEngines?: ArOptionsQuantEnginesDto | null;
  readonly providerErrors: readonly string[];
}

export interface ArRelationPairDto {
  readonly id: string;
  readonly name: string;
  readonly legA: string;
  readonly legB: string;
  readonly unit: string;
  readonly currentValue: number | null;
  readonly mean60d: number | null;
  readonly std60d: number | null;
  readonly zScore: number | null;
  readonly percentile60d: number | null;
  readonly signal: string;
  readonly history: readonly { readonly time: number; readonly ratio: number; readonly zScore: number }[];
}

export interface ArRelationsResponse {
  readonly asOfUtcSec: number;
  readonly feedStatus: FeedStatus;
  readonly providerErrors: readonly string[];
  readonly pairs: readonly ArRelationPairDto[];
  readonly extendedPairs?: readonly ArRelationPairDto[];
  readonly mepCclArbitrage: readonly MepCclArbitrageRow[];
}

export interface UsUnifiedQuoteDto {
  readonly ticker: string;
  readonly assetType: 'stock' | 'index';
  readonly price: number | null;
  readonly change: number | null;
  readonly changePct: number | null;
  readonly previousClose: number | null;
  readonly marketStatus: string | null;
  readonly volume: number | null;
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
  readonly ownIv: number | null;
  readonly providerIv: number | null;
  readonly ivSource: 'OWN' | 'PROVIDER' | 'NONE';
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
    readonly callWallStrike: number | null;
    readonly putWallStrike: number | null;
    readonly gammaFlipSpot: number | null;
    readonly gammaFlipStatus: string;
    readonly expectedMove?: {
      readonly expiryUtcSec: number | null;
      readonly formulaMove: number | null;
      readonly formulaMovePct: number | null;
      readonly straddleMove: number | null;
      readonly straddleMovePct: number | null;
    };
  } | null;
  readonly volSurfaceSummary?: {
    readonly iv30d?: number | null;
    readonly butterflyArbitrageFree?: boolean;
    readonly calendarArbitrageFree?: boolean;
    readonly isArbitrageFree?: boolean;
    readonly frontSlice?: UsVolSliceSummaryDto | null;
    readonly slices?: readonly UsVolSliceSummaryDto[];
    readonly contracts?: readonly UsOptionContractRowDto[];
  } | null;
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
}
