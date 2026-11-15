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
