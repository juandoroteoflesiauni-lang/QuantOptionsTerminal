export type GgalBadgeMode =
  | 'LIVE'
  | 'EOD_CIERRE'
  | 'DIFERIDO_20M'
  | 'STALE_DATA_LOCK'
  | 'T-1 ANEXO B'
  | 'NO_DATA';

export type GgalSessionRegime =
  | 'BYMA_ONLY'
  | 'OVERLAP'
  | 'NASDAQ_SOLO_17_18'
  | 'PREMARKET_REPRICE'
  | 'CLOSED';

export type GgalExecutionPriceBasis = 'LIVE_BID_ASK' | 'EOD_CLOSE_REFERENCE' | 'NONE';

export type GgalStrategyFamily =
  | 'BULL_CALL_SPREAD'
  | 'BEAR_PUT_SPREAD'
  | 'RATIO_1X2'
  | 'RATIO_1X3'
  | 'BUY_WRITE_T0'
  | 'CALENDAR_ROLL_2M';

export interface GgalRecorderStatusDto {
  readonly running: boolean;
  readonly intervalMs: number;
  readonly snapshotsCount: number;
  readonly flowPointsCount: number;
  readonly lastRecordedAtUtcSec: number | null;
}

export interface GgalTelemetryHeaderDto {
  readonly asOfUtcSec: number;
  readonly timestampUtc: string;
  readonly sessionRegime: GgalSessionRegime;
  readonly dstMode: 'EST' | 'EDT';
  readonly marketMode: 'LIVE' | 'EOD_CIERRE';
  readonly feedStatus: GgalBadgeMode;
  readonly feedBadges: readonly GgalBadgeMode[];
  readonly executionPriceBasis: GgalExecutionPriceBasis;
  readonly data912TimestampSec: number | null;
  readonly massiveTimestampSec: number | null;
  readonly data912AgeSec: number | null;
  readonly massiveAgeSec: number | null;
  readonly anexoBStatus: 'T-1 ANEXO B' | 'NO_DATA';
  readonly anexoBAsOfDate: string | null;
  readonly anexoBLagTradingDays: number | null;
  readonly recorder: GgalRecorderStatusDto;
  readonly providerErrors: readonly string[];
}

export interface GgalParityGapOutputDto {
  readonly timestampUtc: string;
  readonly asOfUtcSec: number;
  readonly sessionRegime: GgalSessionRegime;
  readonly dstMode: 'EST' | 'EDT';
  readonly deltaAr1Days: number | null;
  readonly deltaUs1Days: number | null;
  readonly feedStalenessSec: {
    readonly massive: number | null;
    readonly data912: number | null;
  };
  readonly spot: {
    readonly byma24hArs: number | null;
    readonly bymaCiArs: number | null;
    readonly adrMidUsd: number | null;
    readonly fairBymaOpenArs: number | null;
    readonly fairAdrUsd: number | null;
    readonly gapPctVsPrevClose: number | null;
  };
  readonly ccl: {
    readonly cclGgal24h: number | null;
    readonly cclGgalCiTo24h: number | null;
    readonly cclAl30_24h: number | null;
    readonly cclGd30_24h: number | null;
    readonly cclSovereignBenchmark: number | null;
    readonly spreadLogBps: number | null;
    readonly ouMeanBps: number | null;
    readonly ouHalfLifeDays: number | null;
    readonly ouEqSigmaBps: number | null;
    readonly zScore: number | null;
    readonly netEdgeAfterCostsBps: number | null;
    readonly closeProbability5d: number | null;
  };
  readonly ouCalibration: {
    readonly status: 'OK' | 'NO_DATA';
    readonly observationsUsed: number;
    readonly excludedFutureCount: number;
    readonly phi: number | null;
    readonly intercept: number | null;
    readonly kappaPerDay: number | null;
    readonly muLog: number | null;
    readonly halfLifeDays: number | null;
    readonly residualSigma: number | null;
    readonly eqSigma: number | null;
  };
  readonly signal: 'LONG_BYMA_SHORT_ADR' | 'SHORT_BYMA_LONG_ADR' | 'NEUTRAL' | 'STALE_DATA_LOCK';
  readonly preOpenOptionRepricing: readonly {
    readonly tickerByma: string;
    readonly prevCloseArs: number | null;
    readonly fairOpenArs: number | null;
    readonly deltaRepricePct: number | null;
  }[];
}

export interface GgalSovereignBondLegDto {
  readonly ticker: string;
  readonly arsBid: number | null;
  readonly arsAsk: number | null;
  readonly arsMid: number | null;
  readonly usdCBid: number | null;
  readonly usdCAsk: number | null;
  readonly usdCMid: number | null;
  readonly cclImplied: number | null;
  readonly nominalVolumeArs: number | null;
}

export interface GgalHistoricalSpreadPointDto {
  readonly time: number;
  readonly date: string;
  readonly cclGgal24h: number | null;
  readonly cclSovereign: number | null;
  readonly spreadLogBps: number | null;
}

export interface GgalParityGapResponseDto {
  readonly telemetry: GgalTelemetryHeaderDto;
  readonly result: GgalParityGapOutputDto;
  readonly sovereignBonds: readonly GgalSovereignBondLegDto[];
  readonly historicalSpreads: readonly GgalHistoricalSpreadPointDto[];
  readonly rateInputs: {
    readonly sofrPct: number | null;
    readonly sofrSource: string | null;
    readonly caucion1dTnaPct: number | null;
    readonly caucionSource: string | null;
  };
}

export interface GgalVolTriangleAnomalyDto {
  readonly standardizedMoneynessZ: number | null;
  readonly strikeBymaArs: number | null;
  readonly bymaMidIvPct: number | null;
  readonly theoreticalBymaIvPct: number | null;
  readonly relValVolSpreadPct: number | null;
  readonly sideBias: 'CHEAP_BYMA' | 'RICH_BYMA' | 'FAIR';
  readonly arbFlag: string;
}

export interface GgalVolTriangleOutputDto {
  readonly timestampUtc: string;
  readonly asOfUtcSec: number;
  readonly maturityBucketDays: number | null;
  readonly bymaAtmIvPct: number | null;
  readonly opraAdrAtmIvPct: number | null;
  readonly realizedCorrEwma: number | null;
  readonly harRvCclPct: number | null;
  readonly impliedCclVolPct: number | null;
  readonly impliedCorrelation: number | null;
  readonly boundaryRegime: 'NORMAL_UNIQUE_ROOT' | 'DUAL_ROOT_NEG_CORR' | 'VIOLATION_BYMA_COMPRESSED' | 'NO_DATA';
  readonly skewMetrics: {
    readonly byma25dPutMinusCallPct: number | null;
    readonly opra25dPutMinusCallPct: number | null;
    readonly overwritingCompressionScore: number | null;
  };
  readonly arbViolationsCount: number;
  readonly anomalies: readonly GgalVolTriangleAnomalyDto[];
}

export interface GgalSmileComparisonPointDto {
  readonly strikeArs: number;
  readonly standardizedMoneynessZ: number | null;
  readonly bymaCallMidIvPct: number | null;
  readonly bymaPutMidIvPct: number | null;
  readonly theoreticalBymaIvPct: number | null;
  readonly relValVolSpreadPct: number | null;
  readonly sideBias: 'CHEAP_BYMA' | 'RICH_BYMA' | 'FAIR' | null;
  readonly arbFlag: string | null;
  readonly openInterestNom: number | null;
}

export interface GgalVolTriangleResponseDto {
  readonly telemetry: GgalTelemetryHeaderDto;
  readonly frontExpiryCode: string | null;
  readonly frontExpiryDate: string | null;
  readonly frontDteCalendar: number | null;
  readonly opraMatchedExpiryDate: string | null;
  readonly result: GgalVolTriangleOutputDto | null;
  readonly smileComparison: readonly GgalSmileComparisonPointDto[];
  readonly returnObservationsUsed: number;
}

export interface GgalDualDensityOutputDto {
  readonly timestampUtc: string;
  readonly asOfUtcSec: number;
  readonly expiryDate: string;
  readonly dteCalendar: number | null;
  readonly physicalMetricsUsd: {
    readonly status: 'OK' | 'NO_DATA';
    readonly expectedReturnPct: number | null;
    readonly volatilityPct: number | null;
    readonly cvar95UsdPct: number | null;
    readonly studentTCopulaDof: number | null;
    readonly studentTCopulaRho: number | null;
  };
  readonly riskNeutralBymaArs: {
    readonly impliedMeanArs: number | null;
    readonly impliedVolPct: number | null;
    readonly impliedSkewness: number | null;
    readonly impliedExcessKurtosis: number | null;
    readonly leftTail10PctProbDiff: number | null;
    readonly rightTail10PctProbDiff: number | null;
    readonly klDivergencePvsQ: number | null;
  };
  readonly riskNeutralOpraUsd: {
    readonly impliedMeanUsd: number | null;
    readonly impliedVolPct: number | null;
    readonly impliedSkewness: number | null;
    readonly impliedExcessKurtosis: number | null;
    readonly leftTail10PctProbDiff: number | null;
    readonly rightTail10PctProbDiff: number | null;
    readonly klDivergencePvsQ: number | null;
  };
  readonly tailDislocationSignal: 'SELL_LEFT_TAIL_BYMA' | 'BUY_RIGHT_TAIL_BYMA' | 'OPRA_TAIL_RICH' | 'ALIGNED' | 'NO_DATA';
  readonly simulatedNodes: readonly {
    readonly spotUsd: number | null;
    readonly spotArs: number | null;
    readonly probability: number | null;
  }[];
}

export interface GgalDualDensityResponseDto {
  readonly telemetry: GgalTelemetryHeaderDto;
  readonly frontExpiryCode: string | null;
  readonly frontExpiryDate: string | null;
  readonly dteCalendar: number | null;
  readonly cerSource: string | null;
  readonly expectedCerGrowthOverHorizonPct: number | null;
  readonly historicalObsUsed: number;
  readonly cerSeriesCount: number;
  readonly result: GgalDualDensityOutputDto | null;
}

export interface AnexoBOiBucketsDto {
  readonly coveredNom: number;
  readonly uncoveredNom: number;
  readonly oppositeNom: number;
  readonly crossedNom: number;
}

export interface AnexoBIngestStrikeRowDto {
  readonly strikeArs: number;
  readonly callOi: AnexoBOiBucketsDto;
  readonly putOi: AnexoBOiBucketsDto;
}

export interface AnexoBIngestRequestDto {
  readonly asOfDate?: string;
  readonly expiryCode?: string;
  readonly sourceLabel?: string;
  readonly rawText?: string;
  readonly rows?: readonly AnexoBIngestStrikeRowDto[];
}

export interface AnexoBSummaryTotalsDto {
  readonly strikesCount: number;
  readonly callCoveredNom: number;
  readonly callUncoveredNom: number;
  readonly callOppositeNom: number;
  readonly callCrossedNom: number;
  readonly putCoveredNom: number;
  readonly putUncoveredNom: number;
  readonly putOppositeNom: number;
  readonly putCrossedNom: number;
}

export interface GgalStructurePinningResponseDto {
  readonly telemetry: GgalTelemetryHeaderDto;
  readonly frontExpiryCode: string | null;
  readonly frontExpiryDate: string | null;
  readonly anexoBSummary: AnexoBSummaryTotalsDto | null;
  readonly result: {
    readonly timestampUtc: string;
    readonly asOfUtcSec: number;
    readonly anexoBAsOfDate: string;
    readonly anexoBLagTradingDays: number | null;
    readonly isExpiryDay: boolean;
    readonly minutesTo1530Cutoff: number | null;
    readonly regime: 'POSITIVE_GAMMA_MEAN_REVERTING' | 'NEGATIVE_GAMMA_TRENDING' | 'PIN_LOCKED' | 'NO_DATA';
    readonly zeroGammaLevelArs: number | null;
    readonly callWallArs: number | null;
    readonly putWallArs: number | null;
    readonly peakPinStrikeArs: number | null;
    readonly maxPinScore: number | null;
    readonly maxUncoveredCrossedConcentrationPct: number | null;
    readonly netEffectiveGexArsPer1Pct: number | null;
    readonly netVannaArsPerVolPt: number | null;
    readonly netCharmArsPerDay: number | null;
    readonly intradayFlow: {
      readonly bymaNetSignedArs: number | null;
      readonly adrNetSignedUsd: number | null;
      readonly leeReadyConfidence: 'TICK_TAPE' | 'SNAPSHOT_20S_APPROX';
    };
    readonly strikeProfile: readonly {
      readonly strikeArs: number | null;
      readonly oiCoveredNom: number | null;
      readonly oiUncoveredNom: number | null;
      readonly oiOppositeNom: number | null;
      readonly oiCrossedNom: number | null;
      readonly callEffectiveOiNom: number | null;
      readonly putEffectiveOiNom: number | null;
      readonly effectiveSignedGex: number | null;
      readonly vannaExpArs: number | null;
      readonly charmExpArs: number | null;
      readonly pinScore: number | null;
    }[];
  } | null;
  readonly data912TotalOiFallback: readonly {
    readonly strikeArs: number;
    readonly callTotalOiNom: number | null;
    readonly putTotalOiNom: number | null;
    readonly callIvPct: number | null;
    readonly putIvPct: number | null;
  }[];
  readonly notice: string | null;
}

export interface GgalStrategyLegDto {
  readonly ticker: string;
  readonly side: 'BUY' | 'SELL';
  readonly qtyContracts: number;
  readonly execPrice: number | null;
  readonly currency: 'ARS' | 'USD';
  readonly settlement: 'T0' | 'T1';
}

export interface GgalRankedStrategyDto {
  readonly id: string;
  readonly venue: 'BYMA_ARS' | 'OPRA_USD' | 'CROSS_VENUE_RELATIVE';
  readonly family: GgalStrategyFamily;
  readonly legs: readonly GgalStrategyLegDto[];
  readonly economics: {
    readonly grossDebitOrCredit: number | null;
    readonly allInFeesAndIva: number | null;
    readonly marginRequired: number | null;
    readonly tnaYieldPct: number | null;
    readonly spreadOverLecapBps: number | null;
    readonly expectedValueUnderP: number | null;
    readonly probProfitUnderP: number | null;
    readonly maxLoss: number | null;
    readonly netSharpeProxy: number | null;
  };
  readonly usdAlternativeComparison: {
    readonly opraEquivalentSharpe: number | null;
    readonly bymaAdvantageBps: number | null;
  };
}

export interface GgalStrategySelectorRequestDto {
  readonly familyFilter?: GgalStrategyFamily | 'ALL';
  readonly minEvToCostMultiple?: number;
  readonly minBymaOiNominals?: number;
  readonly minOpraOiContracts?: number;
  readonly enforceThresholds?: boolean;
  readonly maxCandidates?: number;
}

export interface GgalStrategySelectorResponseDto {
  readonly telemetry: GgalTelemetryHeaderDto;
  readonly frontExpiryCode: string | null;
  readonly frontExpiryDate: string | null;
  readonly backExpiryCode: string | null;
  readonly backExpiryDate: string | null;
  readonly physicalNodesCount: number;
  readonly result: {
    readonly timestampUtc: string;
    readonly status: 'OK' | 'NO_DATA';
    readonly marketBenchmarks: {
      readonly caucion1dTnaPct: number | null;
      readonly lecapMatchedTnaPct: number | null;
      readonly sofrPct: number | null;
    };
    readonly rankedStrategies: readonly GgalRankedStrategyDto[];
  } | null;
}

export interface GgalSpecialistOverviewResponseDto {
  readonly telemetry: GgalTelemetryHeaderDto;
  readonly spot: {
    readonly byma24hArs: number | null;
    readonly bymaCiArs: number | null;
    readonly adrMidUsd: number | null;
    readonly fairBymaOpenArs: number | null;
    readonly fairAdrUsd: number | null;
    readonly gapPctVsPrevClose: number | null;
    readonly cclGgal24h: number | null;
    readonly cclSovereignBenchmark: number | null;
    readonly parityZScore: number | null;
    readonly paritySignal: string | null;
  };
  readonly volatility: {
    readonly bymaAtmIvPct: number | null;
    readonly opraAdrAtmIvPct: number | null;
    readonly impliedCclVolPct: number | null;
    readonly boundaryRegime: string | null;
    readonly anomaliesCount: number;
  };
  readonly density: {
    readonly status: 'OK' | 'NO_DATA';
    readonly studentTCopulaDof: number | null;
    readonly klBymaPvsQ: number | null;
    readonly tailSignal: string | null;
  };
  readonly structure: {
    readonly regime: string;
    readonly zeroGammaLevelArs: number | null;
    readonly callWallArs: number | null;
    readonly putWallArs: number | null;
    readonly peakPinStrikeArs: number | null;
    readonly bymaNetSignedArs: number | null;
    readonly adrNetSignedUsd: number | null;
  };
  readonly topStrategies: readonly GgalRankedStrategyDto[];
}

export interface GgalAnexoBIngestResponseDto {
  readonly ok: true;
  readonly record: {
    readonly asOfDate: string;
    readonly expiryCode: string | null;
    readonly sourceLabel: string;
    readonly ingestedAtUtcSec: number;
    readonly totals: AnexoBSummaryTotalsDto;
    readonly previewRows: readonly AnexoBIngestStrikeRowDto[];
  };
}

async function requestJson<T>(
  url: string,
  init: RequestInit & { readonly signal?: AbortSignal },
): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  let parsed: unknown = null;
  if (text.trim() !== '') {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = null;
    }
  }
  if (!res.ok) {
    const rec = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
    const detail =
      (rec && typeof rec['detail'] === 'string' && rec['detail']) ||
      (rec && typeof rec['message'] === 'string' && rec['message']) ||
      `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return parsed as T;
}

export function fetchGgalSpecialistOverview(
  options: { readonly forceRefresh?: boolean; readonly signal?: AbortSignal } = {},
): Promise<GgalSpecialistOverviewResponseDto> {
  const qs = options.forceRefresh ? '?refresh=1' : '';
  return requestJson<GgalSpecialistOverviewResponseDto>(
    `/api/ar/ggal-specialist/overview${qs}`,
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
  );
}

export function fetchGgalParityGap(
  options: { readonly forceRefresh?: boolean; readonly signal?: AbortSignal } = {},
): Promise<GgalParityGapResponseDto> {
  const qs = options.forceRefresh ? '?refresh=1' : '';
  return requestJson<GgalParityGapResponseDto>(
    `/api/ar/ggal-specialist/parity-gap${qs}`,
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
  );
}

export function fetchGgalVolTriangle(
  options: { readonly forceRefresh?: boolean; readonly signal?: AbortSignal } = {},
): Promise<GgalVolTriangleResponseDto> {
  const qs = options.forceRefresh ? '?refresh=1' : '';
  return requestJson<GgalVolTriangleResponseDto>(
    `/api/ar/ggal-specialist/vol-triangle${qs}`,
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
  );
}

export function fetchGgalDualDensity(
  options: { readonly forceRefresh?: boolean; readonly signal?: AbortSignal } = {},
): Promise<GgalDualDensityResponseDto> {
  const qs = options.forceRefresh ? '?refresh=1' : '';
  return requestJson<GgalDualDensityResponseDto>(
    `/api/ar/ggal-specialist/dual-density${qs}`,
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
  );
}

export function fetchGgalStructurePinning(
  options: { readonly forceRefresh?: boolean; readonly signal?: AbortSignal } = {},
): Promise<GgalStructurePinningResponseDto> {
  const qs = options.forceRefresh ? '?refresh=1' : '';
  return requestJson<GgalStructurePinningResponseDto>(
    `/api/ar/ggal-specialist/structure-pinning${qs}`,
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
  );
}

export function postGgalStrategySelector(
  body: GgalStrategySelectorRequestDto,
  options: { readonly forceRefresh?: boolean; readonly signal?: AbortSignal } = {},
): Promise<GgalStrategySelectorResponseDto> {
  const qs = options.forceRefresh ? '?refresh=1' : '';
  return requestJson<GgalStrategySelectorResponseDto>(
    `/api/ar/ggal-specialist/strategy-selector${qs}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
  );
}

export function postGgalAnexoBIngest(
  body: AnexoBIngestRequestDto,
  options: { readonly signal?: AbortSignal } = {},
): Promise<GgalAnexoBIngestResponseDto> {
  return requestJson<GgalAnexoBIngestResponseDto>(
    '/api/ar/ggal-specialist/anexo-b/ingest',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
  );
}

// ---------------------------------------------------------------------------
// Pieza 28 — Feed Router, Hybrid ORATS Surface, Microestructura L2/VPIN,
// Clearing Risk, Régimen Electoral 2027 & Dual Synchronized Chart DTOs
// ---------------------------------------------------------------------------

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

export interface ArProviderHealthEntryDto {
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

export interface ArFeedRouterStatusSnapshotDto {
  readonly asOfUtcSec: number;
  readonly activePrimaryEquityProvider: ArFeedProviderId | null;
  readonly activeQualityTier: FeedQualityTier;
  readonly l2Available: boolean;
  readonly activeFxFuturesProvider: ArFeedProviderId | null;
  readonly activeSovereignProvider: ArFeedProviderId | null;
  readonly activeAnexoBProvider: ArFeedProviderId | null;
  readonly isContingencyEod: boolean;
  readonly degradationReason: string | null;
  readonly providers: readonly ArProviderHealthEntryDto[];
  readonly futuresDlrLive?: 'CONNECTED' | 'DISCONNECTED';
  readonly futuresDlrProvider?: 'PRIMARY_MATRIZ_WS' | 'PRIMARY_REMARKETS_SANDBOX' | null;
  readonly futuresDlrLastMsgUtcSec?: number | null;
  readonly futuresDlrCount?: number;
}

export interface GgalL2OrderLevelDto {
  readonly level: 1 | 2 | 3 | 4 | 5;
  readonly price: number;
  readonly size: number;
  readonly orderCount: number | null;
}

export type GgalL2LadderStateDto =
  | {
      readonly available: true;
      readonly activeProvider: ArFeedProviderId;
      readonly qualityTier: 'REALTIME_L2_TICK';
      readonly asOfUtcSec: number;
      readonly symbol: string;
      readonly bids: readonly GgalL2OrderLevelDto[];
      readonly asks: readonly GgalL2OrderLevelDto[];
    }
  | {
      readonly available: false;
      readonly reason: 'NON_L2_FEED_ACTIVE' | 'FEED_DISCONNECTED' | 'INVALID_BOOK_STATE' | 'OUT_OF_SESSION';
      readonly activeProvider: ArFeedProviderId | null;
      readonly qualityTier: FeedQualityTier;
      readonly asOfUtcSec: number;
      readonly symbol: string;
    };

export type GgalL2MicrostructureMetricsDto =
  | {
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
      readonly iceberg: {
        readonly detected: boolean;
        readonly side: 'BID' | 'ASK' | 'NONE';
        readonly priceLevel: number | null;
        readonly executedVolumeAtBest: number;
        readonly visibleDropAtBest: number;
        readonly reloadedVolumeEstimate: number;
        readonly reloadRatio: number;
      };
      readonly vpin: {
        readonly bucketSizeShares: number | null;
        readonly windowBuckets: number;
        readonly populatedBuckets: number;
        readonly vpin: number | null;
        readonly percentileRank: number | null;
        readonly toxicAlert: boolean;
        readonly bucketSeries: readonly number[];
      };
      readonly reason: null;
    }
  | {
      readonly status: 'UNAVAILABLE';
      readonly reason: 'DEGRADED_TO_NON_L2_FEED' | 'INVALID_L2_INPUT' | 'INSUFFICIENT_DEPTH';
      readonly activeProvider: ArFeedProviderId | null;
      readonly qualityTier: FeedQualityTier;
      readonly asOfUtcSec: number;
      readonly detail: string;
    };

export interface GgalMicrostructureResponseDto {
  readonly routerStatus: ArFeedRouterStatusSnapshotDto;
  readonly l2Ladder: GgalL2LadderStateDto;
  readonly microstructure: GgalL2MicrostructureMetricsDto;
}

export interface GgalOptionsSurfaceResponseDto {
  readonly routerStatus: ArFeedRouterStatusSnapshotDto;
  readonly surface:
    | {
        readonly status: 'OPERATIONAL';
        readonly source: 'ORATS_DELAYED_CORE';
        readonly ticker: string;
        readonly tradeDate: string;
        readonly asOfUtcSec: number;
        readonly stockPrice: number | null;
        readonly massiveSpotPrice: number | null;
        readonly massiveSpotSourceMode: 'MASSIVE_NBBO' | 'MASSIVE_BARS' | 'UNAVAILABLE';
        readonly smvVol: number | null;
        readonly iv30d: number | null;
        readonly exErnIv30d: number | null;
        readonly impliedMove: number | null;
        readonly annIdiv: number | null;
        readonly impliedNextDiv: number | null;
        readonly borrow30: number | null;
        readonly yieldRate: number | null;
        readonly yangZhangAdrVol: number | null;
      }
    | {
        readonly status: 'UNAVAILABLE';
        readonly source: 'ORATS_DELAYED_CORE';
        readonly ticker: string;
        readonly asOfUtcSec: number;
        readonly reason: string;
        readonly massiveSpotPrice: number | null;
        readonly massiveSpotSourceMode: 'MASSIVE_NBBO' | 'MASSIVE_BARS' | 'UNAVAILABLE';
        readonly yangZhangAdrVol: number | null;
      };
  readonly otmWingCclVol: {
    readonly status: 'OPERATIONAL' | 'UNAVAILABLE';
    readonly extractedCclImplVol: number | null;
    readonly atmBymaCompressedIv: number | null;
    readonly callOverwritingCompressionPct: number | null;
    readonly selectedWingsCount: number;
    readonly reason: string | null;
  };
}

export interface GgalClearingRiskResponseDto {
  readonly routerStatus: ArFeedRouterStatusSnapshotDto;
  readonly clearingRisk:
    | {
        readonly status: 'OPERATIONAL';
        readonly asOfUtcSec: number;
        readonly anexoBStatus: 'FRESH' | 'CARRY_FORWARD_NO_TRADE' | 'UNAVAILABLE';
        readonly anexoBTradeDate: string | null;
        readonly jul26DividendNoStrikeAdjFlag: boolean;
        readonly bymaInitialMarginPct: number | null;
        readonly clearingHaircutPct: number | null;
        readonly totalUncoveredContracts: number;
        readonly totalCoveredContracts: number;
        readonly l2PinScore: {
          readonly status: 'OPERATIONAL' | 'UNAVAILABLE';
          readonly weightedPinScore: number | null;
          readonly isClosingWindow1530Art: boolean;
          readonly asOfBuenosAiresTime: string;
          readonly reason: string | null;
        };
      }
    | {
        readonly status: 'UNAVAILABLE';
        readonly asOfUtcSec: number;
        readonly reason: string;
      };
}

export type GgalElectoralRegimeId =
  | 'CALM_COMPRESSION'
  | 'FX_BRECHA_TENSION'
  | 'ELECTORAL_TAIL_JUMP';

export interface GgalRegime2027ResponseDto {
  readonly routerStatus: ArFeedRouterStatusSnapshotDto;
  readonly regime:
    | {
        readonly status: 'OPERATIONAL';
        readonly asOfUtcSec: number;
        readonly currentRegime: GgalElectoralRegimeId;
        readonly posteriorProbabilities: readonly [number, number, number];
        readonly effectiveJumpIntensity: number;
        readonly kellyFractionMultiplier: number;
        readonly overnightCvar99Pct: number;
        readonly recommendedHedgeWeights: {
          readonly dlrFuturesWeight: number;
          readonly otmPutWingWeight: number;
          readonly cashArsCollarWeight: number;
          readonly adrDeltaHedgeWeight: number;
        };
        readonly observables: {
          readonly bankBasketIv30ExErn: number;
          readonly ggal25DeltaSkew: number;
          readonly sovereignLegislationSpreadPct: number;
          readonly dlrElectoralForwardKink: number;
          readonly crossBankLeadLagLeader: 'GGAL' | 'BMA' | 'BBAR' | 'SUPV';
          readonly crossBankLeadLagIntensity: number;
        };
        readonly dlrKinkDetail: {
          readonly available: boolean;
          readonly maxSecondDifferencePct: number | null;
          readonly peakMaturityLabel: string | null;
          readonly annualizedTermSlopePct: number | null;
          readonly reason: string | null;
        };
        readonly leadLagDetail: {
          readonly available: boolean;
          readonly leader: 'GGAL' | 'BMA' | 'BBAR' | 'SUPV' | null;
          readonly byBankScore: Readonly<Record<'GGAL' | 'BMA' | 'BBAR' | 'SUPV', number>> | null;
          readonly reason: string | null;
        };
        readonly yangZhangVol20d: number | null;
      }
    | {
        readonly status: 'UNAVAILABLE';
        readonly asOfUtcSec: number;
        readonly reason: string;
        readonly currentRegime: null;
      };
}

export type GgalDualChartCoordMode = 'ARS_BYMA' | 'USD_ADR_NASDAQ' | 'RATIO_CCL';
export type GgalDualChartTimeframe = '1m' | '5m' | '15m' | '1H' | '4H' | '1D';
export type GgalAvwapAnchorMode =
  | 'MONTH_START'
  | 'LAST_BIMONTHLY_EXPIRY'
  | 'LAST_EARNINGS'
  | 'ELECTORAL_GAP';
export type GgalSubPaneIndicatorMode = 'CVD_LEE_READY' | 'CCL_BRECHA_PCT' | 'REL_STRENGTH_BANKS';
export type GgalGreekProfileMode = 'SIGNED_GEX' | 'VANNA' | 'CHARM';

export interface GgalDualChartPayloadDto {
  readonly status: 'OPERATIONAL' | 'UNAVAILABLE';
  readonly asOfUtcSec: number;
  readonly coordMode: GgalDualChartCoordMode;
  readonly timeframe: GgalDualChartTimeframe;
  readonly avwapAnchor: GgalAvwapAnchorMode;
  readonly avwapAnchorUtcSec?: number;
  readonly spotPrice?: number | null;
  readonly cclRate?: number | null;
  readonly callWall?: number | null;
  readonly putWall?: number | null;
  readonly zeroGamma?: number | null;
  readonly maxPain?: number | null;
  readonly bars?: readonly {
    readonly timeSec: number;
    readonly open: number;
    readonly high: number;
    readonly low: number;
    readonly close: number;
    readonly volume: number;
  }[];
  readonly ema9?: readonly { readonly timeSec: number; readonly value: number }[];
  readonly ema21?: readonly { readonly timeSec: number; readonly value: number }[];
  readonly ema50?: readonly { readonly timeSec: number; readonly value: number }[];
  readonly ema200?: readonly { readonly timeSec: number; readonly value: number }[];
  readonly avwapBands?: readonly {
    readonly timeSec: number;
    readonly avwap: number;
    readonly plus1Sigma: number;
    readonly minus1Sigma: number;
    readonly plus2Sigma: number;
    readonly minus2Sigma: number;
  }[];
  readonly volumeProfile?: {
    readonly poc: number | null;
    readonly vah: number | null;
    readonly val: number | null;
    readonly nakedPocs: readonly number[];
    readonly bins: readonly {
      readonly priceMid: number;
      readonly volume: number;
      readonly isValToVah: boolean;
      readonly isPoc: boolean;
    }[];
  };
  readonly zones?: readonly {
    readonly id: string;
    readonly kind: 'FVG' | 'FOB';
    readonly direction: 'BULLISH' | 'BEARISH';
    readonly status: 'UNMITIGATED' | 'MITIGATED';
    readonly startTimeSec: number;
    readonly endTimeSec: number | null;
    readonly low: number;
    readonly high: number;
  }[];
  readonly expectedCone?: readonly {
    readonly timeSec: number;
    readonly center: number;
    readonly upper1Sigma: number;
    readonly lower1Sigma: number;
    readonly upper2Sigma: number;
    readonly lower2Sigma: number;
  }[];
  readonly subPaneSeries?: readonly {
    readonly timeSec: number;
    readonly cvdLeeReady: number;
    readonly cclBrechaPct: number;
    readonly relStrengthBma: number;
    readonly relStrengthBbar: number;
    readonly relStrengthSupv: number;
  }[];
  readonly greekProfile?: readonly {
    readonly strike: number;
    readonly signedGexUncovered: number;
    readonly signedGexCovered: number;
    readonly vannaUncovered: number;
    readonly vannaCovered: number;
    readonly charmUncovered: number;
    readonly charmCovered: number;
  }[];
  readonly l2Ladder: GgalL2LadderStateDto;
  readonly confluenceAlerts?: readonly {
    readonly l2Price: number;
    readonly side: 'BID' | 'ASK';
    readonly l2Size: number;
    readonly targetLabel: string;
    readonly targetPrice: number;
    readonly distancePct: number;
  }[];
  readonly reason: string | null;
}

export interface GgalDualChartResponseDto {
  readonly routerStatus: ArFeedRouterStatusSnapshotDto;
  readonly dualChart: GgalDualChartPayloadDto;
}

export function fetchGgalFeedStatus(
  options: { readonly forceRefresh?: boolean; readonly signal?: AbortSignal } = {},
): Promise<ArFeedRouterStatusSnapshotDto> {
  const qs = options.forceRefresh ? '?refresh=1' : '';
  return requestJson<ArFeedRouterStatusSnapshotDto>(
    `/api/ar/ggal-specialist/feed-status${qs}`,
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
  );
}

export function fetchGgalMicrostructure(
  options: { readonly forceRefresh?: boolean; readonly signal?: AbortSignal } = {},
): Promise<GgalMicrostructureResponseDto> {
  const qs = options.forceRefresh ? '?refresh=1' : '';
  return requestJson<GgalMicrostructureResponseDto>(
    `/api/ar/ggal-specialist/microstructure${qs}`,
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
  );
}

export function fetchGgalOptionsSurface(
  options: { readonly forceRefresh?: boolean; readonly signal?: AbortSignal } = {},
): Promise<GgalOptionsSurfaceResponseDto> {
  const qs = options.forceRefresh ? '?refresh=1' : '';
  return requestJson<GgalOptionsSurfaceResponseDto>(
    `/api/ar/ggal-specialist/options-surface${qs}`,
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
  );
}

export function fetchGgalClearingRisk(
  options: { readonly forceRefresh?: boolean; readonly signal?: AbortSignal } = {},
): Promise<GgalClearingRiskResponseDto> {
  const qs = options.forceRefresh ? '?refresh=1' : '';
  return requestJson<GgalClearingRiskResponseDto>(
    `/api/ar/ggal-specialist/clearing-risk${qs}`,
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
  );
}

export function fetchGgalRegime2027(
  options: { readonly forceRefresh?: boolean; readonly signal?: AbortSignal } = {},
): Promise<GgalRegime2027ResponseDto> {
  const qs = options.forceRefresh ? '?refresh=1' : '';
  return requestJson<GgalRegime2027ResponseDto>(
    `/api/ar/ggal-specialist/regime-2027${qs}`,
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
  );
}

export function fetchGgalDualChart(
  params: {
    readonly coord: GgalDualChartCoordMode;
    readonly timeframe: GgalDualChartTimeframe;
    readonly avwapAnchor: GgalAvwapAnchorMode;
    readonly forceRefresh?: boolean;
    readonly signal?: AbortSignal;
  },
): Promise<GgalDualChartResponseDto> {
  const sp = new URLSearchParams({
    coord: params.coord,
    timeframe: params.timeframe,
    avwapAnchor: params.avwapAnchor,
  });
  if (params.forceRefresh) {
    sp.set('refresh', '1');
  }
  return requestJson<GgalDualChartResponseDto>(
    `/api/ar/ggal-specialist/dual-chart?${sp.toString()}`,
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
    },
  );
}

export function fetchGgalDualChartSeries(
  params: {
    readonly coord: GgalDualChartCoordMode;
    readonly timeframe: GgalDualChartTimeframe;
    readonly avwapAnchor: GgalAvwapAnchorMode;
    readonly forceRefresh?: boolean;
    readonly signal?: AbortSignal;
  },
): Promise<GgalDualChartResponseDto> {
  const sp = new URLSearchParams({
    coord: params.coord,
    timeframe: params.timeframe,
    avwapAnchor: params.avwapAnchor,
    light: '1',
  });
  if (params.forceRefresh) {
    sp.set('refresh', '1');
  }
  return requestJson<GgalDualChartResponseDto>(
    `/api/ar/ggal-specialist/dual-chart?${sp.toString()}`,
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
    },
  );
}

// ---------- MOTOR 6 DTOs & CLIENT ----------

export type BymaClearingStrategyKindDto =
  | 'UNCOVERED_SHORT'
  | 'VERTICAL_DEBIT_SPREAD'
  | 'VERTICAL_CREDIT_SPREAD'
  | 'RATIO_SPREAD_1X2'
  | 'RATIO_SPREAD_1X3'
  | 'SHORT_STRADDLE_STRANGLE'
  | 'COVERED_CALL'
  | 'CROSS_COLLATERAL_STRATEGY';

export type CollateralAssetKindDto =
  | 'US_TREASURY_BILL'
  | 'US_TREASURY_NOTE'
  | 'US_TREASURY_BOND'
  | 'CASH_ARS'
  | 'CASH_USD'
  | 'LECAP'
  | 'SOVEREIGN_BOND_AR'
  | 'EQUITY_LOCAL';

export interface GgalMarginRiskQueryDto {
  readonly strategyKind?: BymaClearingStrategyKindDto;
  readonly capitalArs?: number;
  readonly collateralKind?: CollateralAssetKindDto;
  readonly collateralValueArs?: number;
  readonly collateralAforo?: number;
  readonly collateralDurationYears?: number;
  readonly desiredLots?: number;
  readonly side?: 'BUY' | 'SELL';
}

export interface GgalMarginRiskResponseDto {
  readonly telemetry: GgalTelemetryHeaderDto;
  readonly requestResolved: {
    readonly strategyKind: BymaClearingStrategyKindDto;
    readonly capitalArs: number;
    readonly collateralKind: CollateralAssetKindDto;
    readonly collateralValueArs: number;
    readonly collateralAforo: number | null;
    readonly desiredLots: number;
    readonly side: 'BUY' | 'SELL';
  };
  readonly frontExpiryCode: string | null;
  readonly frontExpiryDate: string | null;
  readonly targetOptionSymbol: string | null;
  readonly targetOptionStrikeArs: number | null;
  readonly selectedLegs: readonly {
    readonly ticker: string;
    readonly contractType: 'call' | 'put';
    readonly side: 'BUY' | 'SELL';
    readonly lots: number;
    readonly strikeArs: number;
    readonly optionPriceArs: number;
    readonly ivPct: number;
  }[];
  readonly executionBookDiagnostics: {
    readonly bookSource: 'PRIMARY_L2' | 'BYMA_L1_ONLY' | 'NO_DATA';
    readonly underlyingBook5LevelsSource: string | null;
    readonly optionL1BidSizeLots: number | null;
    readonly optionL1AskSizeLots: number | null;
    readonly recorderPairsCount: number;
  };
  readonly marginRisk: {
    readonly status: 'OK' | 'NO_DATA';
    readonly reason: string | null;
    readonly strategyKind: BymaClearingStrategyKindDto;
    readonly spot24hArs: number | null;
    readonly expiryDateKey: string;
    readonly ccpRiskArrayLossArs: number | null;
    readonly worstCcpNode: {
      readonly spotShockPct: number | null;
      readonly volShockDecimal: number | null;
      readonly shockedSpotArs: number | null;
      readonly portfolioMtmLossArs: number | null;
    };
    readonly steppedFloorArs: number | null;
    readonly baseRequiredMarginArs: number | null;
    readonly liquidBufferArs: number | null;
    readonly wrongWayRiskSurchargeArs: number | null;
    readonly totalRequiredWithBuffersArs: number | null;
    readonly collateralStatus: 'OK' | 'MISSING_EXPLICIT_AFORO' | 'NO_DATA';
    readonly totalCollateralMarketArs: number | null;
    readonly totalEffectiveCollateralArs: number | null;
    readonly localCorrelatedEffectiveArs: number | null;
    readonly nonCorrelatedEffectiveArs: number | null;
    readonly excessOrDeficitArs: number | null;
    readonly collateralBreakdown: readonly {
      readonly id: string;
      readonly kind: CollateralAssetKindDto;
      readonly marketValueArs: number | null;
      readonly aforo: number | null;
      readonly effectiveValueArs: number | null;
      readonly isLocalCorrelated: boolean;
      readonly status: 'OK' | 'MISSING_EXPLICIT_AFORO' | 'INVALID_INPUT';
    }[];
    readonly t0GrossPremiumCashflowArs: number | null;
    readonly t0OptionFeesDmIvaArs: number | null;
    readonly t0NetCashflowArs: number | null;
    readonly projectedT1ExerciseFeeDmIvaArs: number | null;
    readonly projectedSpotEquityFeeDmIvaArs: number | null;
    readonly dailyMarginCarryCostArs: number | null;
    readonly circular3588Alert: {
      readonly active: boolean;
      readonly isExpiryDay: boolean;
      readonly minutesToCutoff: number | null;
      readonly atmDistancePctMin: number | null;
      readonly blockingAtmStrikes: readonly number[];
      readonly reason: string;
    };
    readonly strategyReferenceMatrix: readonly {
      readonly strategyKind: BymaClearingStrategyKindDto;
      readonly label: string;
      readonly ccpRiskArrayLossArs: number | null;
      readonly steppedFloorArs: number | null;
      readonly requiredMarginArs: number | null;
    }[];
  } | null;
  readonly executionMicrostructure: {
    readonly status: 'OK' | 'DEGRADED_L1_ONLY' | 'NO_DATA';
    readonly decision: 'POST_PASSIVE_L1' | 'PRICE_IMPROVE_1_TICK' | 'CROSS_BOOK' | 'ABORT_STALE';
    readonly decisionReason: string;
    readonly hayashiYoshida: {
      readonly status: 'OK' | 'NO_DATA';
      readonly reason: string | null;
      readonly genuineBymaReturns: number;
      readonly genuineAdrReturns: number;
      readonly contemporaneousCorrelation: number | null;
      readonly optimalLagSec: number | null;
      readonly optimalCorrelation: number | null;
      readonly leadLagSignal: 'ADR_LEADS_BYMA' | 'BYMA_LEADS_ADR' | 'SYNCHRONOUS' | 'NO_DATA';
      readonly lagProfile: readonly {
        readonly lagSec: number;
        readonly correlation: number | null;
        readonly overlappingPairs: number;
      }[];
    };
    readonly gates: {
      readonly gate1FreshnessPassed: boolean;
      readonly gate1Status: 'PASS' | 'FAIL_STALE' | 'BYPASSED_EOD' | 'INVALID_TIMESTAMP';
      readonly quoteAgeSec: number | null;
      readonly gate2SpreadPassed: boolean;
      readonly spreadPct: number | null;
      readonly gate3DepthPassed: boolean;
      readonly l1JoinLots: number | null;
      readonly l1CrossLots: number | null;
      readonly gate4TickConfirmPassed: boolean;
      readonly allGatesPassed: boolean;
    };
    readonly spreadTicks: number | null;
    readonly halfSpreadArs: number | null;
    readonly queueAheadL1Lots: number | null;
    readonly lambdaEffectivePerSec: number | null;
    readonly fillProbPassiveL1: number | null;
    readonly fillProbImprove1Tick: number | null;
    readonly adverseSelectionCostArs: number | null;
    readonly esPassiveL1Ars: number | null;
    readonly esImprove1TickArs: number | null;
    readonly esCrossBookArs: number | null;
    readonly crossBookVwapSlippageArs: number | null;
    readonly visibleTargetDepthLots: number | null;
    readonly maxSingleOrderLots: number | null;
    readonly sqrtImpactCapLots: number | null;
    readonly liquidityCapBindingReason: string;
  } | null;
  readonly tailStress: {
    readonly status: 'OK' | 'NO_DATA';
    readonly reason: string | null;
    readonly scenarioResults: readonly {
      readonly id: string;
      readonly label: string;
      readonly adrShockPct: number;
      readonly cclShockPct: number;
      readonly ivShiftDecimal: number;
      readonly lecapBpsShift: number;
      readonly shockedAdrUsd: number | null;
      readonly shockedCclArs: number | null;
      readonly shockedSpotArs: number | null;
      readonly spotArsChangePct: number | null;
      readonly portfolioPnlPerUnitArs: number | null;
      readonly collateralRateImpactArs: number | null;
      readonly stressedEffectiveCollateralArs: number | null;
      readonly unitCapitalStressPct: number | null;
    }[];
    readonly worstScenarioId: string;
    readonly worstUnitLossArs: number | null;
    readonly overnightNodesCount: number;
    readonly overnightExpectedPnlPerUnitArs: number | null;
    readonly overnightStdDevPerUnitArs: number | null;
    readonly overnightMaxLossPerUnitArs: number | null;
    readonly overnightVar99PerUnitArs: number | null;
    readonly overnightCvar99PerUnitArs: number | null;
    readonly sizingBreakdown: {
      readonly fullKellyLots: number | null;
      readonly quarterKellyLots: number | null;
      readonly noRuinCapLots: number | null;
      readonly cvar99CapLots: number | null;
      readonly drawdownCapLots: number | null;
      readonly collateralMarginCapLots: number | null;
      readonly bindingConstraint: string;
    };
    readonly recommendedBymaLots: number;
    readonly recommendedOpraContractsExact: number | null;
    readonly recommendedOpraContractsFloored: number;
  } | null;
  readonly notice: string | null;
}

export function fetchGgalMarginRisk(
  query: GgalMarginRiskQueryDto = {},
  options: { readonly forceRefresh?: boolean; readonly signal?: AbortSignal } = {},
): Promise<GgalMarginRiskResponseDto> {
  const sp = new URLSearchParams();
  if (options.forceRefresh) sp.set('refresh', '1');
  if (query.strategyKind !== undefined) sp.set('strategyKind', query.strategyKind);
  if (query.capitalArs !== undefined && Number.isFinite(query.capitalArs) && query.capitalArs > 0) {
    sp.set('capitalArs', String(query.capitalArs));
  }
  if (query.collateralKind !== undefined) sp.set('collateralKind', query.collateralKind);
  if (
    query.collateralValueArs !== undefined &&
    Number.isFinite(query.collateralValueArs) &&
    query.collateralValueArs >= 0
  ) {
    sp.set('collateralValueArs', String(query.collateralValueArs));
  }
  if (
    query.collateralAforo !== undefined &&
    Number.isFinite(query.collateralAforo) &&
    query.collateralAforo > 0 &&
    query.collateralAforo <= 1
  ) {
    sp.set('collateralAforo', String(query.collateralAforo));
  }
  if (
    query.collateralDurationYears !== undefined &&
    Number.isFinite(query.collateralDurationYears) &&
    query.collateralDurationYears > 0
  ) {
    sp.set('collateralDurationYears', String(query.collateralDurationYears));
  }
  if (query.desiredLots !== undefined && Number.isFinite(query.desiredLots) && query.desiredLots > 0) {
    sp.set('desiredLots', String(query.desiredLots));
  }
  if (query.side !== undefined) sp.set('side', query.side);

  const qs = sp.toString();
  return requestJson<GgalMarginRiskResponseDto>(
    `/api/ar/ggal-specialist/margin-risk${qs ? `?${qs}` : ''}`,
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
  );
}
