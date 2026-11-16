/**
 * Orquestador Backend — Sub-Sector "GGAL Specialist" (Pieza 21).
 *
 * Integra de forma 100 % aditiva los 5 motores puros de `src/core/ggal/*` (Pieza 20):
 *  1) Motor 1 (`parityGap.ts`): Paridad Dual GGAL BYMA vs. ADR, CCL vs. AL30/GD30, calibración
 *     causal OU AR(1), régimen de sesión EST/EDT y predictor pre-apertura.
 *  2) Motor 2 (`volTriangle.ts`): Triángulo de volatilidad BS02 ARS vs. OPRA USD, Modos A/B de IV
 *     del CCL y correlación ADR-CCL, Skew comparado `z` y anomalías RelVal / overwriting.
 *  3) Motor 3 (`dualDensity.ts`): Densidad física t-Student P_{USD/CER} vs. densidad riesgo-neutral
 *     SVI/Breeden-Litzenberger Q_BYMA y Q_OPRA, KL y señales de dislocación de colas 10 %.
 *  4) Motor 4 (`structurePinning.ts`): Estructura Anexo B IAMC en acciones nominales, Signed GEX/Vanna/Charm,
 *     Zero-Gamma Brent, flujo Lee-Ready ADR + snapshots 20s BYMA y Pinning 15:30 ART.
 *  5) Motor 5 (`strategySelector.ts`): Selector de estrategias netas de aranceles BYMA + 21 % IVA y tasas US
 *     comparado contra equivalente OPRA USD al mismo moneyness estandarizado `z`.
 *
 * Incluye:
 *  - `GgalChainRecorder`: grabador intradiario cada 20s en rueda de snapshots BYMA (`BymaSnapshotFlowPoint`).
 *  - Almacén + parser en memoria de Anexo B IAMC (JSON estructurado o texto pegado PDF/CSV/TSV).
 *  - Soporte 24/7 en modo explícito `EOD_CIERRE` con los últimos cierres reales cuando los mercados
 *    están cerrados (fines de semana, feriados o fuera de rueda).
 *  - Política Zero Silent Fallbacks + redacción estricta de secretos `.env`.
 */

import { evaluateDualProbabilityDensity, type DualProbabilityOutput, type HistoricalDualObservation, type OptionSliceIvNode } from '../core/ggal/dualDensity.js';
import {
  evaluateParityGap,
  type CausalSpreadObservation,
  type LocalOptionPreOpenInput,
  type ParityGapInput,
  type ParityGapOutput,
  type PreOpenMacroPredictorInput,
  type SessionRegime,
  type SovereignBondCclQuote,
} from '../core/ggal/parityGap.js';
import {
  evaluateStrategySelector,
  type BymaStrategyOptionQuote,
  type OpraStrategyOptionQuote,
  type StrategyFamily,
  type StrategySelectorInput,
  type StrategySelectorOutput,
} from '../core/ggal/strategySelector.js';
import {
  DEFAULT_ANEXO_B_WEIGHTS,
  evaluateStructureAndPinning,
  type AnexoBOiBuckets,
  type AnexoBStrikeChainInput,
  type BymaSnapshotFlowPoint,
  type StructurePinningOutput,
} from '../core/ggal/structurePinning.js';
import {
  BYMA_FEE_SCHEDULE,
  DEFAULT_US_FEE_SCHEDULE,
  computeExpiration1530ArtUtcSec,
  formatIsoUtcFromSec,
  getBuenosAiresParts,
  GGAL_ADR_RATIO,
  GGAL_BYMA_LOT_SIZE,
  type BidAskQuote,
  type BymaFeeSchedule,
  type ContinuousRateCurvePoint,
  type DstMode,
  type OrderSide,
  type UsFeeSchedule,
} from '../core/ggal/types.js';
import {
  computeBymaOptionEvalParams,
  evaluateCrossCurrencyVolTriangle,
  type BymaOptionQuoteInput,
  type CrossCurrencyVolOutput,
  type OpraMaturitySliceInput,
  type OpraSliceQuoteInput,
} from '../core/ggal/volTriangle.js';
import {
  calibrateOvernightJumpDiffusionFromSeries,
  evaluateBymaClearingMargin,
  evaluateExecutionMicrostructure,
  evaluateTailStressAndSizing,
  type BookDepthSource,
  type BookLevelInput,
  type BymaClearingStrategyKind,
  type BymaMarginLegInput,
  type CollateralAssetKind,
  type ExecutionMicrostructureOutput,
  type MarginAndRiskOutput,
  type StressTestMatrixOutput,
} from '../core/ggal/marginRiskExecution.js';
import {
  ArgentinaMarketRuntime,
  type ArHttpFn,
  type ArHttpRequestInit,
  type ArMacroResponse,
  type ArMonitoringResponse,
  type ArOptionContractDto,
  type ArOptionExpiryDto,
  type ArOptionsResponse,
  type ArOverviewResponse,
  type ArStockDetailResponse,
} from './argentinaMarketLoader.js';
import {
  BYMA_MARKET_TZ,
  US_MARKET_TZ,
  computeAnchoredVwapSeries,
  computeEmaSeries,
  computeVolumeProfile,
  getSessionDateKey,
} from '../core/ggal/technicalIndicators.js';
import type {
  ArFeedRouterStatusSnapshot,
  GgalAvwapAnchorMode,
  GgalChartBarPoint,
  GgalChartStructureZone,
  GgalClearingRiskPayload,
  GgalDualChartCoordMode,
  GgalDualChartPayload,
  GgalDualChartTimeframe,
  GgalElectoralObservables,
  GgalElectoralRegimeState,
  GgalExpectedConePoint,
  GgalL2ConfluenceAlert,
  GgalL2LadderState,
  GgalL2MicrostructureMetrics,
  GgalStrikeGreekProfileRow,
  GgalSubPanePoint,
  OratsHybridSurfacePayload,
} from '../core/ggal/institutionalContracts.js';
import {
  computeDlrForwardKink,
  computeHayashiYoshidaLeadLag,
  computeL2Microstructure,
  computeL2WeightedPinScore,
  computeYangZhangVol,
  convertArsPriceToCoord,
  convertOhlcBarToCoord,
  extractOtmWingCclImpliedVol,
  updateElectoralMarkovRegime,
  type AsyncPriceTick,
  type DlrCurvePointInput,
  type OtmWingStrikeInput,
  type VpinSignedTradeInput,
} from '../core/ggal/l2AndRegimeEngines.js';
import {
  ArFeedRouter,
  collectArFeedSecrets,
} from './arFeedRouter.js';
import {
  BMB_OUT_OF_SESSION_REASON,
  bmbTradesToVpinInput,
  buildBmbIcebergTrackingResult,
  isBymaL2SessionUtcSec,
  type BmbBestQuoteObservation,
} from './bmbFeedAdapter.js';
import type { BmbBridgeSnapshotDto } from './primaryRofexLoader.js';
import {
  MarketRuntime,
  RuntimeNoDataError,
  sanitizeFinite,
  type JsonSafeValue,
  type TerminalBarsResponse,
  type TerminalSnapshotResponse,
} from './marketRuntime.js';
import {
  OratsHybridClient,
  loadOratsClientConfigFromEnv,
  type OratsHttpFn,
} from './oratsHybridClient.js';
import type { TradierQuotesResult } from './tradierAdapter.js';
import { redactSecrets } from './runtimeCache.js';

/** Pieza 32: ADRs US consultados por NBBO Tradier en el GGAL Specialist. */
const GGAL_TRADIER_ADR_SYMBOLS = ['GGAL', 'YPF', 'BMA', 'CEPU', 'VIST', 'MELI'] as const;

export type GgalBadgeMode =
  | 'LIVE'
  | 'EOD_CIERRE'
  | 'DIFERIDO_20M'
  | 'STALE_DATA_LOCK'
  | 'T-1 ANEXO B'
  | 'NO_DATA';

export type ExecutionPriceBasis = 'LIVE_BID_ASK' | 'EOD_CLOSE_REFERENCE' | 'NONE';

export interface GgalSpecialistRuntimeDeps {
  readonly runtime: MarketRuntime;
  readonly arRuntime: ArgentinaMarketRuntime;
  readonly fetchFn?: ArHttpFn;
  readonly nowMsFn?: () => number;
  readonly data912BaseUrl?: string;
  readonly bcraBaseUrl?: string;
  readonly cacheTtlMs?: number;
  readonly recorderIntervalMs?: number;
  readonly maxRecorderSnapshots?: number;
  readonly maxData912StalenessSec?: number;
  readonly maxMassiveStalenessSec?: number;
  readonly maxSyncSkewSec?: number;
  readonly arHolidays?: readonly string[];
  readonly usHolidays?: readonly string[];
  readonly secrets?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly arFeedRouter?: ArFeedRouter;
  readonly oratsClient?: OratsHybridClient;
}

export interface GgalTelemetryHeaderDto {
  readonly asOfUtcSec: number;
  readonly timestampUtc: string;
  readonly sessionRegime: SessionRegime;
  readonly dstMode: DstMode;
  readonly marketMode: 'LIVE' | 'EOD_CIERRE';
  readonly feedStatus: GgalBadgeMode;
  readonly feedBadges: readonly GgalBadgeMode[];
  readonly executionPriceBasis: ExecutionPriceBasis;
  readonly data912TimestampSec: number | null;
  readonly massiveTimestampSec: number | null;
  readonly data912AgeSec: number | null;
  readonly massiveAgeSec: number | null;
  readonly anexoBStatus: 'T-1 ANEXO B' | 'NO_DATA';
  readonly anexoBAsOfDate: string | null;
  readonly anexoBLagTradingDays: number | null;
  readonly recorder: GgalRecorderStatusDto;
  readonly providerErrors: readonly string[];
  readonly sourceDiagnostics?: readonly string[];
}

export interface GgalRecorderSnapshotEntry {
  readonly asOfUtcSec: number;
  readonly marketMode: 'LIVE' | 'EOD_CIERRE';
  readonly sessionRegime: SessionRegime;
  readonly spotByma24hArs: number | null;
  readonly spotAdrUsd: number | null;
  readonly cclGgal24h: number | null;
  readonly optionsContractsCount: number;
}

export interface GgalRecorderStatusDto {
  readonly running: boolean;
  readonly intervalMs: number;
  readonly snapshotsCount: number;
  readonly flowPointsCount: number;
  readonly lastRecordedAtUtcSec: number | null;
}

export interface GgalHistoricalSpreadPointDto {
  readonly time: number;
  readonly date: string;
  readonly cclGgal24h: number | null;
  readonly cclSovereign: number | null;
  readonly spreadLogBps: number | null;
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

export interface GgalParityGapResponse {
  readonly telemetry: GgalTelemetryHeaderDto;
  readonly result: JsonSafeValue<ParityGapOutput>;
  readonly sovereignBonds: readonly GgalSovereignBondLegDto[];
  readonly historicalSpreads: readonly GgalHistoricalSpreadPointDto[];
  readonly rateInputs: {
    readonly sofrPct: number | null;
    readonly sofrSource: string | null;
    readonly caucion1dTnaPct: number | null;
    readonly caucionSource: string | null;
  };
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

export interface GgalVolTriangleResponse {
  readonly telemetry: GgalTelemetryHeaderDto;
  readonly frontExpiryCode: string | null;
  readonly frontExpiryDate: string | null;
  readonly frontDteCalendar: number | null;
  readonly opraMatchedExpiryDate: string | null;
  readonly result: JsonSafeValue<CrossCurrencyVolOutput> | null;
  readonly smileComparison: readonly GgalSmileComparisonPointDto[];
  readonly returnObservationsUsed: number;
  readonly impliedCclVolWingsPct?: number | null;
  readonly impliedCclMinFloorPct?: number | null;
  readonly atmCompressionPts?: number | null;
}

export interface GgalDualDensityResponse {
  readonly telemetry: GgalTelemetryHeaderDto;
  readonly frontExpiryCode: string | null;
  readonly frontExpiryDate: string | null;
  readonly dteCalendar: number | null;
  readonly cerSource: string | null;
  readonly expectedCerGrowthOverHorizonPct: number | null;
  readonly historicalObsUsed: number;
  readonly cerSeriesCount: number;
  readonly result: JsonSafeValue<DualProbabilityOutput> | null;
}

export interface AnexoBIngestStrikeRowInput {
  readonly strikeArs: number;
  readonly callOi: AnexoBOiBuckets;
  readonly putOi: AnexoBOiBuckets;
}

export interface AnexoBIngestRequest {
  readonly asOfDate?: string;
  readonly expiryCode?: string;
  readonly sourceLabel?: string;
  readonly rawText?: string;
  readonly rows?: readonly AnexoBIngestStrikeRowInput[];
}

export interface AnexoBStoredRecord {
  readonly asOfDate: string;
  readonly expiryCode: string | null;
  readonly sourceLabel: string;
  readonly ingestedAtUtcSec: number;
  readonly rows: readonly AnexoBIngestStrikeRowInput[];
  readonly totals: {
    readonly strikesCount: number;
    readonly callCoveredNom: number;
    readonly callUncoveredNom: number;
    readonly callOppositeNom: number;
    readonly callCrossedNom: number;
    readonly putCoveredNom: number;
    readonly putUncoveredNom: number;
    readonly putOppositeNom: number;
    readonly putCrossedNom: number;
  };
}

export interface GgalData912OiFallbackItemDto {
  readonly strikeArs: number;
  readonly callTotalOiNom: number | null;
  readonly putTotalOiNom: number | null;
  readonly callIvPct: number | null;
  readonly putIvPct: number | null;
}

export interface GgalStructurePinningResponse {
  readonly telemetry: GgalTelemetryHeaderDto;
  readonly frontExpiryCode: string | null;
  readonly frontExpiryDate: string | null;
  readonly anexoBSummary: AnexoBStoredRecord['totals'] | null;
  readonly result: JsonSafeValue<StructurePinningOutput> | null;
  readonly proxyResult?: JsonSafeValue<StructurePinningOutput> | null;
  readonly proxySource?: 'PROXY DATA912 (SIN ANEXO B)' | null;
  readonly flowBasis?: 'EOD_PREV_SESSION' | 'INTRADAY_SNAPSHOT';
  readonly data912TotalOiFallback: readonly GgalData912OiFallbackItemDto[];
  readonly notice: string | null;
}

export interface GgalStrategySelectorRequest {
  readonly familyFilter?: StrategyFamily | 'ALL';
  readonly minEvToCostMultiple?: number;
  readonly minBymaOiNominals?: number;
  readonly minOpraOiContracts?: number;
  readonly enforceThresholds?: boolean;
  readonly maxCandidates?: number;
  readonly bymaFeeSchedule?: Partial<BymaFeeSchedule>;
  readonly usFeeSchedule?: Partial<UsFeeSchedule>;
}

export interface GgalStrategySelectorResponse {
  readonly telemetry: GgalTelemetryHeaderDto;
  readonly frontExpiryCode: string | null;
  readonly frontExpiryDate: string | null;
  readonly backExpiryCode: string | null;
  readonly backExpiryDate: string | null;
  readonly feeScheduleUsed: JsonSafeValue<BymaFeeSchedule>;
  readonly physicalNodesCount: number;
  readonly result: JsonSafeValue<StrategySelectorOutput> | null;
}

export interface GgalSpecialistOverviewResponse {
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
  readonly topStrategies: JsonSafeValue<StrategySelectorOutput['rankedStrategies']>;
}

export interface GgalAnexoBIngestResponse {
  readonly ok: true;
  readonly record: Omit<AnexoBStoredRecord, 'rows'> & { readonly previewRows: readonly AnexoBIngestStrikeRowInput[] };
}

export interface GgalMarginRiskRequest {
  readonly strategyKind?: BymaClearingStrategyKind | undefined;
  readonly capitalArs?: number | undefined;
  readonly collateralKind?: CollateralAssetKind | undefined;
  readonly collateralValueArs?: number | undefined;
  readonly collateralAforo?: number | undefined;
  readonly collateralDurationYears?: number | undefined;
  readonly desiredLots?: number | undefined;
  readonly side?: OrderSide | undefined;
}

export interface GgalMarginRiskSelectedLegDto {
  readonly ticker: string;
  readonly contractType: 'call' | 'put';
  readonly side: OrderSide;
  readonly lots: number;
  readonly strikeArs: number;
  readonly optionPriceArs: number;
  readonly ivPct: number;
}

export interface GgalMarginRiskResponse {
  readonly telemetry: GgalTelemetryHeaderDto;
  readonly requestResolved: {
    readonly strategyKind: BymaClearingStrategyKind;
    readonly capitalArs: number;
    readonly collateralKind: CollateralAssetKind;
    readonly collateralValueArs: number;
    readonly collateralAforo: number | null;
    readonly desiredLots: number;
    readonly side: OrderSide;
  };
  readonly frontExpiryCode: string | null;
  readonly frontExpiryDate: string | null;
  readonly targetOptionSymbol: string | null;
  readonly targetOptionStrikeArs: number | null;
  readonly selectedLegs: readonly GgalMarginRiskSelectedLegDto[];
  readonly executionBookDiagnostics: {
    readonly bookSource: BookDepthSource;
    readonly underlyingBook5LevelsSource: string | null;
    readonly optionL1BidSizeLots: number | null;
    readonly optionL1AskSizeLots: number | null;
    readonly recorderPairsCount: number;
  };
  readonly marginRisk: JsonSafeValue<MarginAndRiskOutput> | null;
  readonly executionMicrostructure: JsonSafeValue<ExecutionMicrostructureOutput> | null;
  readonly tailStress: JsonSafeValue<StressTestMatrixOutput> | null;
  readonly notice: string | null;
}

interface Data912RawRow {
  readonly symbol: string;
  readonly bid: number | null;
  readonly ask: number | null;
  readonly last: number | null;
  readonly prevClose: number | null;
  readonly nominalVol: number | null;
  readonly volumeArs: number | null;
  readonly days: number | null;
  readonly tna: number | null;
  readonly rawDate: string | null;
}

interface HistoricalPriceSeriesPoint {
  readonly date: string;
  readonly time: number;
  readonly close: number;
}

interface CerObservation {
  readonly date: string;
  readonly value: number;
}

interface CachedEntry<T> {
  readonly fetchedAtMs: number;
  readonly value: T;
}

interface MarketBundle {
  readonly asOfUtcSec: number;
  readonly overview: ArOverviewResponse;
  readonly macro: ArMacroResponse;
  readonly monitoring: ArMonitoringResponse;
  readonly ggalDetail: ArStockDetailResponse;
  readonly ggalOptions: ArOptionsResponse;
  readonly bmbSnapshot: BmbBridgeSnapshotDto | null;
  readonly usSnapshot: TerminalSnapshotResponse | null;
  readonly usBars: TerminalBarsResponse | null;
  readonly usDailyCloseBars: readonly { readonly time: number; readonly close: number }[];
  readonly liveStocks: readonly Data912RawRow[];
  readonly liveBonds: readonly Data912RawRow[];
  readonly liveNotes: readonly Data912RawRow[];
  readonly liveCauciones: readonly Data912RawRow[];
  readonly al30History: readonly HistoricalPriceSeriesPoint[];
  readonly al30cHistory: readonly HistoricalPriceSeriesPoint[];
  readonly gd30History: readonly HistoricalPriceSeriesPoint[];
  readonly gd30cHistory: readonly HistoricalPriceSeriesPoint[];
  readonly cerHistory: readonly CerObservation[];
  readonly cerVarId: number;
  readonly tradierAdrQuotes: TradierQuotesResult | null;
  readonly errors: readonly string[];
}

const DEFAULT_DATA912_BASE_URL = 'https://data912.com';
const DEFAULT_BCRA_BASE_URL = 'https://api.bcra.gob.ar';
const DEFAULT_HTTP_TIMEOUT_MS = 4_000;
const DEFAULT_CACHE_TTL_MS = 12_000;
const HISTORY_CACHE_TTL_MS = 300_000;
const ANEXO_B_BG_CACHE_TTL_MS = 12 * 3_600_000;
const DUAL_CHART_TARGET_BARS = 1_200;
const DUAL_CHART_BYMA_DAILY_LIMIT = 1_000;
const DEFAULT_RECORDER_INTERVAL_MS = 20_000;
const DEFAULT_MAX_RECORDER_SNAPSHOTS = 500;
const DEFAULT_STALENESS_SEC = 20;

const ZERO_BUCKETS: AnexoBOiBuckets = {
  coveredNom: 0,
  uncoveredNom: 0,
  oppositeNom: 0,
  crossedNom: 0,
};

function defaultHttpFn(url: string, init?: ArHttpRequestInit) {
  const timeoutMs = init?.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  return fetch(url, {
    method: init?.method ?? 'GET',
    headers: init?.headers ?? { Accept: 'application/json' },
    ...(init?.body !== undefined ? { body: init.body } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  }).then(async (res) => {
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    return {
      ok: res.ok,
      status: res.status,
      text: await res.text(),
      headers,
    };
  });
}

function isPlainRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function toJsonSafe<T>(value: T): JsonSafeValue<T> {
  if (typeof value === 'number') {
    return (Number.isFinite(value) ? value : null) as JsonSafeValue<T>;
  }
  if (value === undefined) {
    return null as JsonSafeValue<T>;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value as JsonSafeValue<T>;
  }
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return items.map((item) => toJsonSafe(item)) as unknown as JsonSafeValue<T>;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) {
        continue;
      }
      out[k] = toJsonSafe(v);
    }
    return out as JsonSafeValue<T>;
  }
  return null as JsonSafeValue<T>;
}

function readNum(rec: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const k of keys) {
    const raw = rec[k];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return raw;
    }
    if (typeof raw === 'string' && raw.trim() !== '') {
      const parsed = Number(raw.trim().replace(',', '.'));
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function readStr(rec: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const raw = rec[k];
    if (typeof raw === 'string' && raw.trim() !== '') {
      return raw.trim();
    }
  }
  return null;
}

function parseUtcDateKey(raw: string | null | undefined): { readonly date: string; readonly time: number } | null {
  if (raw === null || raw === undefined || raw.trim() === '') {
    return null;
  }
  const s = raw.trim();
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (isoMatch !== null) {
    const [, yr, mo, dy] = isoMatch;
    const y = Number(yr);
    const m = Number(mo);
    const d = Number(dy);
    if (
      yr !== undefined &&
      mo !== undefined &&
      dy !== undefined &&
      Number.isInteger(y) &&
      Number.isInteger(m) &&
      Number.isInteger(d)
    ) {
      const ms = Date.UTC(y, m - 1, d, 20, 0, 0);
      if (Number.isFinite(ms)) {
        return {
          date: `${yr}-${mo}-${dy}`,
          time: Math.floor(ms / 1_000),
        };
      }
    }
  }
  const dmyMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (dmyMatch !== null) {
    const d = dmyMatch[1];
    const m = dmyMatch[2];
    const y = dmyMatch[3];
    if (d !== undefined && m !== undefined && y !== undefined) {
      const ms = Date.UTC(Number(y), Number(m) - 1, Number(d), 20, 0, 0);
      if (Number.isFinite(ms)) {
        return {
          date: `${y}-${m}-${d}`,
          time: Math.floor(ms / 1_000),
        };
      }
    }
  }
  const numeric = Number(s);
  if (Number.isFinite(numeric) && numeric > 1_000_000_000) {
    const sec = numeric > 1e12 ? Math.floor(numeric / 1_000) : Math.floor(numeric);
    const parts = getBuenosAiresParts(sec);
    return { date: parts.dateKey, time: sec };
  }
  return null;
}

function parseLocalizedNumber(token: string): number {
  const cleaned = token.trim().replace(/\s+/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '—') {
    return Number.NaN;
  }
  // Spanish/IAMC thousands format: e.g. "125.400" or "1.250.000,50" or "125,400"
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(cleaned)) {
    const normalized = cleaned.replace(/\./g, '').replace(',', '.');
    return Number(normalized);
  }
  if (/^-?\d+,\d+$/.test(cleaned)) {
    return Number(cleaned.replace(',', '.'));
  }
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(cleaned)) {
    return Number(cleaned.replace(/,/g, ''));
  }
  return Number(cleaned);
}

/**
 * Parsea la matriz T-1 del Anexo B de IAMC desde filas JSON o texto pegado (PDF/CSV/TSV).
 * Admite:
 *  - Series individuales tipo `GFGC6500DI 120.000 45.000 18.000 5.000` (Cubierta/Descubierta/Opuesta/Cruzada)
 *  - Filas por strike `6500  120000 45000 18000 5000  20000 15000 5000 0` (Strike + 4 Call + 4 Put)
 *  - Filas `CALL 6500 120000 45000 18000 5000` / `PUT 6500 ...`
 */
export function parseAnexoBIamcInput(
  body: AnexoBIngestRequest,
  nowUtcSec: number,
): AnexoBStoredRecord {
  const defaultDate = getBuenosAiresParts(nowUtcSec).dateKey;
  let asOfDate =
    body.asOfDate !== undefined && body.asOfDate.trim() !== ''
      ? (parseUtcDateKey(body.asOfDate)?.date ?? body.asOfDate.trim())
      : null;

  const byStrike = new Map<
    number,
    { callOi: AnexoBOiBuckets; putOi: AnexoBOiBuckets }
  >();

  const mergeBuckets = (
    prev: AnexoBOiBuckets,
    next: AnexoBOiBuckets,
  ): AnexoBOiBuckets => ({
    coveredNom: prev.coveredNom + next.coveredNom,
    uncoveredNom: prev.uncoveredNom + next.uncoveredNom,
    oppositeNom: prev.oppositeNom + next.oppositeNom,
    crossedNom: prev.crossedNom + next.crossedNom,
  });

  const validateBuckets = (b: AnexoBOiBuckets, ctx: string): void => {
    const nums = [b.coveredNom, b.uncoveredNom, b.oppositeNom, b.crossedNom];
    if (nums.some((n) => !Number.isFinite(n) || n < 0)) {
      throw new RuntimeNoDataError(
        'INVALID_PARAMETER',
        `Anexo B OI buckets invalid for ${ctx}: negative or non-finite values`,
        [],
        400,
      );
    }
  };

  if (body.rows !== undefined) {
    if (!Array.isArray(body.rows)) {
      throw new RuntimeNoDataError('INVALID_PARAMETER', 'Anexo B rows must be an array', [], 400);
    }
    const structuredRows: readonly AnexoBIngestStrikeRowInput[] = body.rows;
    for (let i = 0; i < structuredRows.length; i += 1) {
      const row = structuredRows[i];
      if (row === undefined || !Number.isFinite(row.strikeArs) || row.strikeArs <= 0) {
        throw new RuntimeNoDataError(
          'INVALID_PARAMETER',
          `Anexo B row[${String(i)}] has invalid strikeArs`,
          [],
          400,
        );
      }
      const callOi: AnexoBOiBuckets = row.callOi;
      const putOi: AnexoBOiBuckets = row.putOi;
      validateBuckets(callOi, `strike ${String(row.strikeArs)} callOi`);
      validateBuckets(putOi, `strike ${String(row.strikeArs)} putOi`);
      const existing = byStrike.get(row.strikeArs) ?? {
        callOi: ZERO_BUCKETS,
        putOi: ZERO_BUCKETS,
      };
      byStrike.set(row.strikeArs, {
        callOi: mergeBuckets(existing.callOi, callOi),
        putOi: mergeBuckets(existing.putOi, putOi),
      });
    }
  }

  if (typeof body.rawText === 'string' && body.rawText.trim() !== '') {
    const lines = body.rawText.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line === '') {
        continue;
      }
      if (asOfDate === null) {
        const headerDateMatch = /(?:fecha|al|date)?[:\s]*(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})/i.exec(line);
        if (headerDateMatch?.[1] !== undefined) {
          const parsedHeader = parseUtcDateKey(headerDateMatch[1]);
          if (parsedHeader !== null) {
            asOfDate = parsedHeader.date;
          }
        }
      }

      // Tokenize by delimiter (; | tab comma-with-whitespace) or whitespace
      const rawCols = /[;\t|]/.test(line)
        ? line.split(/[;\t|]+/).map((c) => c.trim()).filter((c) => c !== '')
        : line.includes(',') && !/\d,\d{1,2}(?:$|\s)/.test(line)
          ? line.split(',').map((c) => c.trim()).filter((c) => c !== '')
          : line.split(/\s+/).map((c) => c.trim()).filter((c) => c !== '');

      if (rawCols.length < 5) {
        continue;
      }

      const firstUpper = (rawCols[0] ?? '').toUpperCase();
      // Pattern 1: BYMA ticker e.g. GFGC6500DI or GFGV6000DI + 4 buckets (+ optional total)
      const tickerMatch = /^GFG([CV])(\d+(?:[.,]\d+)?)[A-Z]{0,4}$/.exec(firstUpper);
      if (tickerMatch !== null) {
        const sideChar = tickerMatch[1];
        const strikeVal = parseLocalizedNumber(tickerMatch[2] ?? '');
        const b1 = parseLocalizedNumber(rawCols[1] ?? '');
        const b2 = parseLocalizedNumber(rawCols[2] ?? '');
        const b3 = parseLocalizedNumber(rawCols[3] ?? '');
        const b4 = parseLocalizedNumber(rawCols[4] ?? '');
        if (
          Number.isFinite(strikeVal) &&
          strikeVal > 0 &&
          [b1, b2, b3, b4].every((v) => Number.isFinite(v) && v >= 0)
        ) {
          const buckets: AnexoBOiBuckets = {
            coveredNom: b1,
            uncoveredNom: b2,
            oppositeNom: b3,
            crossedNom: b4,
          };
          const existing = byStrike.get(strikeVal) ?? { callOi: ZERO_BUCKETS, putOi: ZERO_BUCKETS };
          byStrike.set(
            strikeVal,
            sideChar === 'C'
              ? { callOi: mergeBuckets(existing.callOi, buckets), putOi: existing.putOi }
              : { callOi: existing.callOi, putOi: mergeBuckets(existing.putOi, buckets) },
          );
          continue;
        }
      }

      // Pattern 2: Explicit side word "CALL" / "PUT" + strike + 4 buckets
      if ((firstUpper === 'CALL' || firstUpper === 'C' || firstUpper === 'PUT' || firstUpper === 'P' || firstUpper === 'V') && rawCols.length >= 6) {
        const strikeVal = parseLocalizedNumber(rawCols[1] ?? '');
        const b1 = parseLocalizedNumber(rawCols[2] ?? '');
        const b2 = parseLocalizedNumber(rawCols[3] ?? '');
        const b3 = parseLocalizedNumber(rawCols[4] ?? '');
        const b4 = parseLocalizedNumber(rawCols[5] ?? '');
        if (
          Number.isFinite(strikeVal) &&
          strikeVal > 0 &&
          [b1, b2, b3, b4].every((v) => Number.isFinite(v) && v >= 0)
        ) {
          const buckets: AnexoBOiBuckets = {
            coveredNom: b1,
            uncoveredNom: b2,
            oppositeNom: b3,
            crossedNom: b4,
          };
          const isCall = firstUpper === 'CALL' || firstUpper === 'C';
          const existing = byStrike.get(strikeVal) ?? { callOi: ZERO_BUCKETS, putOi: ZERO_BUCKETS };
          byStrike.set(
            strikeVal,
            isCall
              ? { callOi: mergeBuckets(existing.callOi, buckets), putOi: existing.putOi }
              : { callOi: existing.callOi, putOi: mergeBuckets(existing.putOi, buckets) },
          );
          continue;
        }
      }

      // Pattern 3: Numeric strike row with 8 numeric columns (strike + call 4 + put 4)
      if (rawCols.length >= 9) {
        const nums = rawCols.slice(0, 9).map(parseLocalizedNumber);
        const strikeVal = nums[0] ?? Number.NaN;
        if (
          Number.isFinite(strikeVal) &&
          strikeVal > 0 &&
          nums.slice(1).every((n) => Number.isFinite(n) && n >= 0)
        ) {
          const callOi: AnexoBOiBuckets = {
            coveredNom: nums[1] ?? 0,
            uncoveredNom: nums[2] ?? 0,
            oppositeNom: nums[3] ?? 0,
            crossedNom: nums[4] ?? 0,
          };
          const putOi: AnexoBOiBuckets = {
            coveredNom: nums[5] ?? 0,
            uncoveredNom: nums[6] ?? 0,
            oppositeNom: nums[7] ?? 0,
            crossedNom: nums[8] ?? 0,
          };
          const existing = byStrike.get(strikeVal) ?? { callOi: ZERO_BUCKETS, putOi: ZERO_BUCKETS };
          byStrike.set(strikeVal, {
            callOi: mergeBuckets(existing.callOi, callOi),
            putOi: mergeBuckets(existing.putOi, putOi),
          });
        }
      }
    }
  }

  if (byStrike.size === 0) {
    throw new RuntimeNoDataError(
      'INVALID_PARAMETER',
      'Anexo B IAMC payload contains no parseable strike/OI rows. Provide structured `rows` or valid IAMC `rawText`.',
      [],
      400,
    );
  }

  const sortedRows: AnexoBIngestStrikeRowInput[] = [...byStrike.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([strikeArs, oi]) => ({
      strikeArs,
      callOi: oi.callOi,
      putOi: oi.putOi,
    }));

  const totals = sortedRows.reduce(
    (acc, r) => ({
      strikesCount: acc.strikesCount + 1,
      callCoveredNom: acc.callCoveredNom + r.callOi.coveredNom,
      callUncoveredNom: acc.callUncoveredNom + r.callOi.uncoveredNom,
      callOppositeNom: acc.callOppositeNom + r.callOi.oppositeNom,
      callCrossedNom: acc.callCrossedNom + r.callOi.crossedNom,
      putCoveredNom: acc.putCoveredNom + r.putOi.coveredNom,
      putUncoveredNom: acc.putUncoveredNom + r.putOi.uncoveredNom,
      putOppositeNom: acc.putOppositeNom + r.putOi.oppositeNom,
      putCrossedNom: acc.putCrossedNom + r.putOi.crossedNom,
    }),
    {
      strikesCount: 0,
      callCoveredNom: 0,
      callUncoveredNom: 0,
      callOppositeNom: 0,
      callCrossedNom: 0,
      putCoveredNom: 0,
      putUncoveredNom: 0,
      putOppositeNom: 0,
      putCrossedNom: 0,
    },
  );

  return {
    asOfDate: asOfDate ?? defaultDate,
    expiryCode: body.expiryCode?.trim() || null,
    sourceLabel: body.sourceLabel?.trim() || 'IAMC_ANEXO_B',
    ingestedAtUtcSec: nowUtcSec,
    rows: sortedRows,
    totals,
  };
}

function selectLiquidFrontAndBackExpiries(
  options: ArOptionsResponse,
): { readonly front: ArOptionExpiryDto | null; readonly back: ArOptionExpiryDto | null } {
  const withData = options.expiries.filter((exp) => exp.days >= 1 && (exp.calls.length > 0 || exp.puts.length > 0));
  if (withData.length === 0) {
    return { front: null, back: null };
  }

  const scoreExpiry = (exp: ArOptionExpiryDto): number => {
    const all = [...exp.calls, ...exp.puts];
    let quoted = 0;
    let totalOi = 0;
    let totalVol = 0;
    for (const c of all) {
      if ((c.bid !== null && c.bid > 0) || (c.ask !== null && c.ask > 0) || (c.last !== null && c.last > 0)) {
        quoted += 1;
      }
      totalOi += c.openInterest !== null && Number.isFinite(c.openInterest) ? Math.max(0, c.openInterest) : 0;
      totalVol += c.volume !== null && Number.isFinite(c.volume) ? Math.max(0, c.volume) : 0;
    }
    return quoted * 1_000 + totalVol * 2 + totalOi * 0.05;
  };

  let front: ArOptionExpiryDto | null = null;
  if (options.primaryLiquidExpiryCode !== undefined && options.primaryLiquidExpiryCode !== null) {
    front = withData.find((e) => e.expiryCode === options.primaryLiquidExpiryCode) ?? null;
  }
  if (front === null) {
    // Preferir vencimiento >= 7d si existe con buena liquidez; si no, mayor score
    const min7d = withData.filter((e) => e.days >= 7);
    const pool = min7d.length > 0 ? min7d : withData;
    front = [...pool].sort((a, b) => scoreExpiry(b) - scoreExpiry(a))[0] ?? withData[0] ?? null;
  }

  let back: ArOptionExpiryDto | null = null;
  if (front !== null) {
    const later = withData.filter((e) => e.expiryUtcSec > front.expiryUtcSec);
    if (later.length > 0) {
      back = [...later].sort((a, b) => a.expiryUtcSec - b.expiryUtcSec)[0] ?? null;
    }
  }

  return { front, back };
}

function makeBidAskQuote(
  bid: number | null | undefined,
  ask: number | null | undefined,
  last: number | null | undefined,
  allowEodReference: boolean,
): { readonly quote: BidAskQuote; readonly basis: ExecutionPriceBasis } {
  if (
    bid !== null &&
    bid !== undefined &&
    ask !== null &&
    ask !== undefined &&
    Number.isFinite(bid) &&
    Number.isFinite(ask) &&
    bid > 0 &&
    ask >= bid
  ) {
    return {
      quote: {
        bid,
        ask,
        ...(last !== null && last !== undefined && Number.isFinite(last) && last > 0 ? { last } : {}),
      },
      basis: 'LIVE_BID_ASK',
    };
  }
  if (allowEodReference && last !== null && last !== undefined && Number.isFinite(last) && last > 0) {
    return {
      quote: { bid: last, ask: last, last },
      basis: 'EOD_CLOSE_REFERENCE',
    };
  }
  return {
    quote: { bid: Number.NaN, ask: Number.NaN },
    basis: 'NONE',
  };
}

function buildArsRateCurveAndBenchmarks(
  macro: ArMacroResponse,
  options: ArOptionsResponse,
  liveCauciones: readonly Data912RawRow[],
  liveNotes: readonly Data912RawRow[],
  monitoring: ArMonitoringResponse,
): {
  readonly rateCurveArs: ContinuousRateCurvePoint[];
  readonly caucion1dTnaPct: number;
  readonly caucionSource: string | null;
  readonly lecapMatchedTnaPct: number;
} {
  // 1) Caucion 1d real si Data912 publica tasas de caución
  let caucion1dTnaPct = Number.NaN;
  let caucionSource: string | null = null;

  const pesoCauciones = liveCauciones
    .filter((r) => (r.symbol.includes('PESO') || !r.symbol.includes('USD')) && r.tna !== null && r.tna > 0)
    .sort((a, b) => (a.days ?? 999) - (b.days ?? 999));

  if (pesoCauciones[0]?.tna !== null && pesoCauciones[0]?.tna !== undefined) {
    caucion1dTnaPct = pesoCauciones[0].tna;
    caucionSource = `Data912 Caución (${String(pesoCauciones[0].days ?? 1)}d)`;
  } else if (macro.variables.tamarTna !== null && Number.isFinite(macro.variables.tamarTna) && macro.variables.tamarTna > 0) {
    caucion1dTnaPct = macro.variables.tamarTna;
    caucionSource = 'BCRA TAMAR TNA';
  } else if (macro.variables.badlarTna !== null && Number.isFinite(macro.variables.badlarTna) && macro.variables.badlarTna > 0) {
    caucion1dTnaPct = macro.variables.badlarTna;
    caucionSource = 'BCRA BADLAR TNA';
  } else if (options.rateTna !== null && Number.isFinite(options.rateTna) && options.rateTna > 0) {
    caucion1dTnaPct = options.rateTna;
    caucionSource = 'BYMA Tasa Opciones';
  }

  // 2) Lecap / tasa emparejada
  const noteWithTna = liveNotes.find((n) => n.tna !== null && n.tna > 0);
  let lecapMatchedTnaPct = Number.NaN;
  if (noteWithTna?.tna !== null && noteWithTna?.tna !== undefined) {
    lecapMatchedTnaPct = noteWithTna.tna;
  } else if (macro.variables.plazoFijoTna !== null && Number.isFinite(macro.variables.plazoFijoTna) && macro.variables.plazoFijoTna > 0) {
    lecapMatchedTnaPct = macro.variables.plazoFijoTna;
  } else if (Number.isFinite(caucion1dTnaPct) && caucion1dTnaPct > 0) {
    lecapMatchedTnaPct = caucion1dTnaPct;
  } else if (monitoring.badlarTna !== null && Number.isFinite(monitoring.badlarTna) && monitoring.badlarTna > 0) {
    lecapMatchedTnaPct = monitoring.badlarTna;
  }

  const curve: ContinuousRateCurvePoint[] = [];
  const tnaToCont = (tnaPct: number, days: number): number => {
    const r = tnaPct / 100;
    const t = Math.max(1, days) / 365;
    const gross = 1 + r * t;
    return gross > 0 ? Math.log(gross) / t : Number.NaN;
  };

  if (Number.isFinite(caucion1dTnaPct) && caucion1dTnaPct > 0) {
    const c1 = tnaToCont(caucion1dTnaPct, 1);
    if (Number.isFinite(c1)) {
      curve.push({ days: 1, continuousRateAnnual: c1 });
    }
  }
  if (macro.variables.badlarTna !== null && Number.isFinite(macro.variables.badlarTna) && macro.variables.badlarTna > 0) {
    const c30 = tnaToCont(macro.variables.badlarTna, 30);
    if (Number.isFinite(c30)) {
      curve.push({ days: 30, continuousRateAnnual: c30 });
    }
  }
  if (Number.isFinite(lecapMatchedTnaPct) && lecapMatchedTnaPct > 0) {
    const c60 = tnaToCont(lecapMatchedTnaPct, 60);
    if (Number.isFinite(c60)) {
      curve.push({ days: 60, continuousRateAnnual: c60 });
    }
  }
  if (curve.length === 0 && options.continuousRate !== null && Number.isFinite(options.continuousRate) && options.continuousRate > 0) {
    curve.push({ days: 30, continuousRateAnnual: options.continuousRate });
  }
  curve.sort((a, b) => a.days - b.days);

  return {
    rateCurveArs: curve,
    caucion1dTnaPct,
    caucionSource,
    lecapMatchedTnaPct,
  };
}

export class GgalSpecialistRuntime {
  private readonly runtime: MarketRuntime;
  private readonly arRuntime: ArgentinaMarketRuntime;
  private readonly fetchFn: ArHttpFn;
  private readonly nowMsFn: () => number;
  private readonly data912BaseUrl: string;
  private readonly bcraBaseUrl: string;
  private readonly cacheTtlMs: number;
  private readonly recorderIntervalMs: number;
  private readonly maxRecorderSnapshots: number;
  private readonly maxData912StalenessSec: number;
  private readonly maxMassiveStalenessSec: number;
  private readonly maxSyncSkewSec: number;
  private readonly arHolidays: readonly string[];
  private readonly usHolidays: readonly string[];
  private readonly secrets: readonly string[];

  private bundleCache: CachedEntry<MarketBundle> | null = null;
  private bundleInFlight: Promise<MarketBundle> | null = null;
  private resolvedCerVarId: number | null = null;
  private historyCache: CachedEntry<{
    readonly al30History: readonly HistoricalPriceSeriesPoint[];
    readonly al30cHistory: readonly HistoricalPriceSeriesPoint[];
    readonly gd30History: readonly HistoricalPriceSeriesPoint[];
    readonly gd30cHistory: readonly HistoricalPriceSeriesPoint[];
    readonly cerHistory: readonly CerObservation[];
    readonly cerVarId: number;
  }> | null = null;
  private historyInFlight: Promise<
    NonNullable<GgalSpecialistRuntime['historyCache']>['value']
  > | null = null;
  private fullBymaHistoryCache: CachedEntry<readonly GgalChartBarPoint[]> | null = null;
  private fullBymaHistoryInFlight: Promise<readonly GgalChartBarPoint[]> | null = null;
  private fastQuotesCache: CachedEntry<{
    readonly stocks: readonly Data912RawRow[];
    readonly bonds: readonly Data912RawRow[];
  }> | null = null;

  private anexoBStore: AnexoBStoredRecord | null = null;
  private readonly iamcAnexoBUrl: string | null;
  private anexoBBgLastAttemptMs: number | null = null;
  private anexoBBgInFlight: Promise<void> | null = null;
  private anexoBBgLastError: string | null = null;
  private readonly isMockFetch: boolean;
  private readonly recorderSnapshots: GgalRecorderSnapshotEntry[] = [];
  private readonly bymaFlowSnapshots: BymaSnapshotFlowPoint[] = [];
  private recorderTimer: ReturnType<typeof setInterval> | null = null;
  private readonly arFeedRouter: ArFeedRouter;
  private readonly oratsClient: OratsHybridClient;
  /** Pieza 32: último resultado de la superficie ORATS para providers-status. */
  private oratsLastCall: {
    readonly atUtcSec: number;
    readonly ok: boolean;
    readonly status: string;
  } | null = null;
  private regimePriorProbabilities: readonly [number, number, number] = [0.55, 0.35, 0.10];
  private previousBmbBest: BmbBestQuoteObservation | null = null;
  private bmbIcebergCache: {
    readonly key: string;
    readonly input: ReturnType<typeof buildBmbIcebergTrackingResult>['input'];
  } | null = null;

  public constructor(deps: GgalSpecialistRuntimeDeps) {
    const effectiveEnv: NodeJS.ProcessEnv =
      deps.env ?? (deps.fetchFn !== undefined ? {} : process.env);
    const oratsCfg = loadOratsClientConfigFromEnv(effectiveEnv);
    const combinedSecrets = [
      ...(deps.secrets ?? []),
      ...collectArFeedSecrets(effectiveEnv),
      ...(oratsCfg.apiKey !== null ? [oratsCfg.apiKey] : []),
    ];
    this.isMockFetch = deps.fetchFn !== undefined;
    const rawIamcUrl = effectiveEnv['IAMC_ANEXO_B_URL']?.trim() ?? '';
    this.iamcAnexoBUrl = rawIamcUrl !== '' ? rawIamcUrl : null;
    this.runtime = deps.runtime;
    this.arRuntime = deps.arRuntime;
    this.fetchFn = deps.fetchFn ?? defaultHttpFn;
    this.nowMsFn = deps.nowMsFn ?? (() => Date.now());
    this.data912BaseUrl = (deps.data912BaseUrl ?? DEFAULT_DATA912_BASE_URL).replace(/\/+$/, '');
    this.bcraBaseUrl = (deps.bcraBaseUrl ?? DEFAULT_BCRA_BASE_URL).replace(/\/+$/, '');
    this.cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.recorderIntervalMs = deps.recorderIntervalMs ?? DEFAULT_RECORDER_INTERVAL_MS;
    this.maxRecorderSnapshots = deps.maxRecorderSnapshots ?? DEFAULT_MAX_RECORDER_SNAPSHOTS;
    this.maxData912StalenessSec = deps.maxData912StalenessSec ?? DEFAULT_STALENESS_SEC;
    this.maxMassiveStalenessSec = deps.maxMassiveStalenessSec ?? DEFAULT_STALENESS_SEC;
    this.maxSyncSkewSec = deps.maxSyncSkewSec ?? DEFAULT_STALENESS_SEC;
    this.arHolidays = deps.arHolidays ?? [];
    this.usHolidays = deps.usHolidays ?? [];
    this.secrets = [...new Set(combinedSecrets)];
    this.arFeedRouter =
      deps.arFeedRouter ??
      new ArFeedRouter({
        env: effectiveEnv,
        nowMsFn: this.nowMsFn,
        secrets: this.secrets,
      });
    const oratsFetchAdapter: OratsHttpFn = async (url, init) => {
      const reqInit: ArHttpRequestInit = {
        method: init?.method === 'POST' ? 'POST' : 'GET',
        ...(init?.headers !== undefined ? { headers: init.headers } : {}),
        ...(init?.timeoutMs !== undefined ? { timeoutMs: init.timeoutMs } : {}),
      };
      const res = await this.fetchFn(url, reqInit);
      return {
        ok: res.ok,
        status: res.status,
        json: (): Promise<unknown> => Promise.resolve(JSON.parse(res.text) as unknown),
        text: (): Promise<string> => Promise.resolve(res.text),
      };
    };
    this.oratsClient =
      deps.oratsClient ??
      new OratsHybridClient({
        env: effectiveEnv,
        fetchFn: oratsFetchAdapter,
        nowMsFn: this.nowMsFn,
        secrets: this.secrets,
      });
  }

  public startRecorder(): void {
    if (this.recorderTimer !== null) {
      return;
    }
    this.recorderTimer = setInterval(() => {
      void this.recordSnapshotNow().catch(() => {
        // Silencioso en timer de fondo; errores quedan en recorder sin tumbar el proceso.
      });
    }, this.recorderIntervalMs);
    this.recorderTimer.unref();
  }

  public stop(): void {
    this.previousBmbBest = null;
    this.bmbIcebergCache = null;
    if (this.recorderTimer !== null) {
      clearInterval(this.recorderTimer);
      this.recorderTimer = null;
    }
  }

  public getRecorderStatus(): GgalRecorderStatusDto {
    const last = this.recorderSnapshots[this.recorderSnapshots.length - 1];
    return {
      running: this.recorderTimer !== null,
      intervalMs: this.recorderIntervalMs,
      snapshotsCount: this.recorderSnapshots.length,
      flowPointsCount: this.bymaFlowSnapshots.length,
      lastRecordedAtUtcSec: last?.asOfUtcSec ?? null,
    };
  }

  /**
   * Pieza 32: estado ORATS para `GET /api/us/providers-status` (rol superficie
   * `smvVol` / `IV Rank` / `impliedMove` en el especialista GGAL).
   */
  public getOratsStatus(): {
    readonly configured: boolean;
    readonly connected: boolean | null;
    readonly lastFetchAtUtcSec: number | null;
    readonly lastStatus: string | null;
    readonly activeRole: 'SURFACE';
  } {
    const configured = this.oratsClient.isConfigured();
    const last = this.oratsLastCall;
    return {
      configured,
      connected: !configured ? false : last === null ? null : last.ok,
      lastFetchAtUtcSec: last?.atUtcSec ?? null,
      lastStatus: last?.status ?? null,
      activeRole: 'SURFACE',
    };
  }

  public getAnexoBState(): AnexoBStoredRecord | null {
    return this.anexoBStore;
  }

  public ingestAnexoB(body: AnexoBIngestRequest): GgalAnexoBIngestResponse {
    const nowUtcSec = Math.floor(this.nowMsFn() / 1_000);
    const parsed = parseAnexoBIamcInput(body, nowUtcSec);
    this.anexoBStore = parsed;
    return {
      ok: true,
      record: {
        asOfDate: parsed.asOfDate,
        expiryCode: parsed.expiryCode,
        sourceLabel: parsed.sourceLabel,
        ingestedAtUtcSec: parsed.ingestedAtUtcSec,
        totals: parsed.totals,
        previewRows: parsed.rows.slice(0, 25),
      },
    };
  }

  public async recordSnapshotNow(): Promise<GgalRecorderSnapshotEntry> {
    const bundle = await this.loadMarketBundle(true);
    const entry = this.appendRecorderObservation(bundle);
    return entry;
  }

  private appendRecorderObservation(bundle: MarketBundle): GgalRecorderSnapshotEntry {
    const asOfUtcSec = bundle.asOfUtcSec;
    const parity = this.computeParityGapCore(bundle);
    const session = {
      sessionRegime: parity.output.sessionRegime,
      marketMode: parity.marketMode,
    };

    const ggalRow = bundle.liveStocks.find((r) => r.symbol === 'GGAL');
    const ggalOverview = bundle.overview.mervalStocks.find((s) => s.ticker === 'GGAL');
    const bid = ggalRow?.bid ?? ggalOverview?.bid ?? ggalOverview?.last ?? null;
    const ask = ggalRow?.ask ?? ggalOverview?.ask ?? ggalOverview?.last ?? null;
    const last = ggalRow?.last ?? ggalOverview?.last ?? null;
    const cumVol = ggalRow?.nominalVol ?? null;

    if (
      bid !== null &&
      ask !== null &&
      last !== null &&
      cumVol !== null &&
      Number.isFinite(bid) &&
      Number.isFinite(ask) &&
      Number.isFinite(last) &&
      Number.isFinite(cumVol) &&
      bid > 0 &&
      ask >= bid &&
      last > 0 &&
      cumVol >= 0
    ) {
      const prevFlow = this.bymaFlowSnapshots[this.bymaFlowSnapshots.length - 1];
      if (prevFlow === undefined || asOfUtcSec > prevFlow.time) {
        this.bymaFlowSnapshots.push({
          time: asOfUtcSec,
          bid,
          ask,
          last,
          cumVolumeShares: cumVol,
        });
        if (this.bymaFlowSnapshots.length > this.maxRecorderSnapshots) {
          this.bymaFlowSnapshots.shift();
        }
      }
    }

    const totalOpts = bundle.ggalOptions.expiries.reduce(
      (acc, e) => acc + e.calls.length + e.puts.length,
      0,
    );
    const entry: GgalRecorderSnapshotEntry = {
      asOfUtcSec,
      marketMode: session.marketMode,
      sessionRegime: session.sessionRegime,
      spotByma24hArs: sanitizeFinite(parity.output.spot.byma24hArs),
      spotAdrUsd: sanitizeFinite(parity.output.spot.adrMidUsd),
      cclGgal24h: sanitizeFinite(parity.output.ccl.cclGgal24h),
      optionsContractsCount: totalOpts,
    };

    const lastEntry = this.recorderSnapshots[this.recorderSnapshots.length - 1];
    if (lastEntry === undefined || asOfUtcSec > lastEntry.asOfUtcSec) {
      this.recorderSnapshots.push(entry);
      if (this.recorderSnapshots.length > this.maxRecorderSnapshots) {
        this.recorderSnapshots.shift();
      }
    }

    return entry;
  }

  private async fetchJsonSafe(url: string): Promise<{ readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly error: string }> {
    try {
      const res = await this.fetchFn(url, { method: 'GET', headers: { Accept: 'application/json' }, timeoutMs: DEFAULT_HTTP_TIMEOUT_MS });
      if (!res.ok) {
        return { ok: false, error: redactSecrets(`HTTP ${String(res.status)} en ${url}`, this.secrets) };
      }
      const parsed: unknown = JSON.parse(res.text);
      return { ok: true, data: parsed };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: redactSecrets(`${url}: ${msg}`, this.secrets) };
    }
  }

  private parseData912Rows(data: unknown): Data912RawRow[] {
    if (!Array.isArray(data)) {
      return [];
    }
    const rows: Data912RawRow[] = [];
    for (const item of data) {
      if (!isPlainRecord(item)) {
        continue;
      }
      const symbol = readStr(item, ['symbol', 'ticker', 'Symbol', 'especie'])?.toUpperCase();
      if (symbol === undefined || symbol === '') {
        continue;
      }
      const last = readNum(item, ['c', 'close', 'last', 'px_last', 'mark', 'trade', 'settlementPrice']);
      const bid = readNum(item, ['px_bid', 'bid', 'bidPrice', 'ars_bid']);
      const ask = readNum(item, ['px_ask', 'ask', 'askPrice', 'ars_ask']);
      const prevClose = readNum(item, ['prev_close', 'previousClose', 'closingPrice', 'open', 'o']);
      const nominalVol = readNum(item, ['v', 'q_op', 'volume', 'nominalVolume']);
      const volumeArs = readNum(item, ['v_ars', 'volumeAmount', 'monto', 'amount']);
      const days = readNum(item, ['days', 'plazo', 'dias']);
      const tna = readNum(item, ['tna', 'rate', 'tir', 'caucion_tna']);
      const rawDate = readStr(item, ['date', 'timestamp', 'updated_at']);
      rows.push({
        symbol,
        bid,
        ask,
        last,
        prevClose,
        nominalVol,
        volumeArs,
        days,
        tna,
        rawDate,
      });
    }
    return rows;
  }

  private parseData912History(data: unknown): HistoricalPriceSeriesPoint[] {
    const arr = Array.isArray(data)
      ? data
      : isPlainRecord(data) && Array.isArray(data['results'])
        ? data['results']
        : [];
    const seen = new Set<string>();
    const out: HistoricalPriceSeriesPoint[] = [];
    for (const item of arr) {
      if (!isPlainRecord(item)) {
        continue;
      }
      const d = parseUtcDateKey(readStr(item, ['date', 'd', 'fecha', 't', 'time']));
      const close = readNum(item, ['c', 'close', 'last', 'cierre']);
      if (d === null || close === null || !Number.isFinite(close) || close <= 0 || seen.has(d.date)) {
        continue;
      }
      seen.add(d.date);
      out.push({ date: d.date, time: d.time, close });
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  }

  private parseData912OhlcvHistory(data: unknown): GgalChartBarPoint[] {
    const arr = Array.isArray(data)
      ? data
      : isPlainRecord(data) && Array.isArray(data['results'])
        ? data['results']
        : [];
    const seen = new Set<number>();
    const out: GgalChartBarPoint[] = [];
    for (const item of arr) {
      if (!isPlainRecord(item)) {
        continue;
      }
      const d = parseUtcDateKey(readStr(item, ['date', 'd', 'fecha', 't', 'time']));
      const close = readNum(item, ['c', 'close', 'last', 'cierre']);
      if (d === null || close === null || !Number.isFinite(close) || close <= 0) {
        continue;
      }
      const open = readNum(item, ['o', 'open', 'apertura']) ?? close;
      const high = readNum(item, ['h', 'high', 'maximo']) ?? Math.max(open, close);
      const low = readNum(item, ['l', 'low', 'minimo']) ?? Math.min(open, close);
      const volume = Math.max(0, readNum(item, ['v', 'volume', 'q_op', 'nominalVolume']) ?? 0);
      if (seen.has(d.time)) {
        continue;
      }
      seen.add(d.time);
      out.push({
        timeSec: d.time,
        open,
        high: Math.max(high, open, close),
        low: Math.min(low, open, close),
        close,
        volume,
      });
    }
    out.sort((a, b) => a.timeSec - b.timeSec);
    return out;
  }

  private async loadFullBymaGgalHistory(forceRefresh = false): Promise<readonly GgalChartBarPoint[]> {
    const nowMs = this.nowMsFn();
    if (
      !forceRefresh &&
      this.fullBymaHistoryCache !== null &&
      nowMs - this.fullBymaHistoryCache.fetchedAtMs < HISTORY_CACHE_TTL_MS
    ) {
      return this.fullBymaHistoryCache.value;
    }
    if (!forceRefresh && this.fullBymaHistoryInFlight !== null) {
      return this.fullBymaHistoryInFlight;
    }

    const work = (async (): Promise<readonly GgalChartBarPoint[]> => {
      const res = await this.fetchJsonSafe(`${this.data912BaseUrl}/historical/stocks/GGAL`);
      if (!res.ok) {
        return this.fullBymaHistoryCache?.value ?? [];
      }
      const parsed = this.parseData912OhlcvHistory(res.data);
      const sliced =
        parsed.length > DUAL_CHART_BYMA_DAILY_LIMIT
          ? parsed.slice(parsed.length - DUAL_CHART_BYMA_DAILY_LIMIT)
          : parsed;
      if (sliced.length > 0) {
        this.fullBymaHistoryCache = { fetchedAtMs: this.nowMsFn(), value: sliced };
      }
      return sliced;
    })();

    this.fullBymaHistoryInFlight = work;
    try {
      return await work;
    } finally {
      this.fullBymaHistoryInFlight = null;
    }
  }

  private triggerAnexoBBgRefresh(force = false): void {
    if (this.iamcAnexoBUrl === null || this.isMockFetch) {
      return;
    }
    const nowMs = this.nowMsFn();
    if (
      !force &&
      this.anexoBBgLastAttemptMs !== null &&
      nowMs - this.anexoBBgLastAttemptMs < ANEXO_B_BG_CACHE_TTL_MS
    ) {
      return;
    }
    if (this.anexoBBgInFlight !== null) {
      return;
    }

    this.anexoBBgLastAttemptMs = nowMs;
    const url = this.iamcAnexoBUrl;
    this.anexoBBgInFlight = (async () => {
      try {
        const res = await this.fetchFn(url, {
          method: 'GET',
          headers: { Accept: 'application/json, text/plain, text/csv, application/pdf' },
          timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
        });
        if (!res.ok || res.text.trim() === '') {
          this.anexoBBgLastError = `HTTP_${String(res.status)}`;
          return;
        }
        const trimmed = res.text.trim();
        let req: AnexoBIngestRequest;
        if (trimmed.startsWith('{')) {
          const parsedJson: unknown = JSON.parse(trimmed);
          req = isPlainRecord(parsedJson)
            ? {
                ...(typeof parsedJson['asOfDate'] === 'string'
                  ? { asOfDate: parsedJson['asOfDate'] }
                  : {}),
                ...(typeof parsedJson['expiryCode'] === 'string'
                  ? { expiryCode: parsedJson['expiryCode'] }
                  : {}),
                ...(typeof parsedJson['rawText'] === 'string'
                  ? { rawText: parsedJson['rawText'] }
                  : {}),
                sourceLabel: 'IAMC_ANEXO_B_BG',
              }
            : { rawText: trimmed, sourceLabel: 'IAMC_ANEXO_B_BG' };
        } else {
          req = { rawText: trimmed, sourceLabel: 'IAMC_ANEXO_B_BG' };
        }
        const record = parseAnexoBIamcInput(req, Math.floor(this.nowMsFn() / 1_000));
        this.anexoBStore = record;
        this.anexoBBgLastError = null;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.anexoBBgLastError = redactSecrets(msg, this.secrets);
      } finally {
        this.anexoBBgInFlight = null;
      }
    })();
  }

  private parseBcraCerHistory(data: unknown): CerObservation[] {
    if (!isPlainRecord(data) || !Array.isArray(data['results'])) {
      return [];
    }
    const seen = new Set<string>();
    const out: CerObservation[] = [];
    const pushObservation = (entry: unknown): void => {
      if (!isPlainRecord(entry)) {
        return;
      }
      const rawFecha = readStr(entry, ['fecha', 'date', 'ultFechaInformada']);
      const val = readNum(entry, ['valor', 'value', 'ultValorInformado']);
      const parsed = parseUtcDateKey(rawFecha);
      if (parsed === null || val === null || !Number.isFinite(val) || val <= 0 || seen.has(parsed.date)) {
        return;
      }
      seen.add(parsed.date);
      out.push({ date: parsed.date, value: val });
    };

    for (const item of data['results']) {
      if (!isPlainRecord(item)) {
        continue;
      }
      // BCRA v4.0 devuelve { results: [{ idVariable, detalle: [{ fecha, valor }, ...] }] }
      if (Array.isArray(item['detalle'])) {
        for (const detailRow of item['detalle']) {
          pushObservation(detailRow);
        }
      }
      pushObservation(item);
    }
    out.sort((a, b) => a.date.localeCompare(b.date));
    return out;
  }

  private async resolveBcraCerVariableId(): Promise<number> {
    if (this.resolvedCerVarId !== null) {
      return this.resolvedCerVarId;
    }
    const catalogRes = await this.fetchJsonSafe(
      `${this.bcraBaseUrl}/estadisticas/v4.0/Monetarias?Limit=3000`,
    );
    if (catalogRes.ok && isPlainRecord(catalogRes.data) && Array.isArray(catalogRes.data['results'])) {
      let bestId: number | null = null;
      for (const item of catalogRes.data['results']) {
        if (!isPlainRecord(item)) {
          continue;
        }
        const idVal = readNum(item, ['idVariable', 'id']);
        const desc = readStr(item, ['descripcion', 'nombre', 'description']) ?? '';
        if (idVal === null || !Number.isInteger(idVal) || idVal <= 0 || desc.trim() === '') {
          continue;
        }
        const norm = desc.trim();
        const excludedSeries = /\b(?:no\s+ajustables?|dep[oó]sitos|plazo|pr[eé]stamos|tasas?)\b/i.test(norm);
        const isExactCer =
          /^cer$/i.test(norm) ||
          /coeficiente\s+de\s+estabilizaci[oó]n\s+de\s+referencia/i.test(norm) ||
          /^cer\b/i.test(norm);
        const hasTokenCer = /\bcer\b/i.test(norm) && !excludedSeries;
        if (isExactCer) {
          bestId = idVal;
          break;
        }
        if (hasTokenCer && bestId === null) {
          bestId = idVal;
        }
      }
      if (bestId !== null) {
        this.resolvedCerVarId = bestId;
        return bestId;
      }
    }
    return 30;
  }

  private async loadHistories(asOfUtcSec: number, forceRefresh: boolean) {
    const nowMs = this.nowMsFn();
    if (!forceRefresh && this.historyCache !== null && nowMs - this.historyCache.fetchedAtMs < HISTORY_CACHE_TTL_MS) {
      return this.historyCache.value;
    }
    if (!forceRefresh && this.historyInFlight !== null) {
      return this.historyInFlight;
    }

    const work = (async () => {
      const toDate = getBuenosAiresParts(asOfUtcSec).dateKey;
      const fromSec = Math.max(0, asOfUtcSec - 365 * 86_400);
      const fromDate = getBuenosAiresParts(fromSec).dateKey;
      const cerVarId = await this.resolveBcraCerVariableId();

      const [al30Res, al30cRes, gd30Res, gd30cRes, cerRes] = await Promise.all([
        this.fetchJsonSafe(`${this.data912BaseUrl}/historical/bonds/AL30`),
        this.fetchJsonSafe(`${this.data912BaseUrl}/historical/bonds/AL30C`),
        this.fetchJsonSafe(`${this.data912BaseUrl}/historical/bonds/GD30`),
        this.fetchJsonSafe(`${this.data912BaseUrl}/historical/bonds/GD30C`),
        this.fetchJsonSafe(
          `${this.bcraBaseUrl}/estadisticas/v4.0/Monetarias/${String(cerVarId)}?desde=${fromDate}&hasta=${toDate}&Limit=3000`,
        ),
      ]);

      let effectiveCerVarId = cerVarId;
      let cerHistory = cerRes.ok ? this.parseBcraCerHistory(cerRes.data) : [];
      if (cerHistory.length === 0 && cerVarId !== 30) {
        const fbRes = await this.fetchJsonSafe(
          `${this.bcraBaseUrl}/estadisticas/v4.0/Monetarias/30?desde=${fromDate}&hasta=${toDate}&Limit=3000`,
        );
        if (fbRes.ok) {
          const parsedFb = this.parseBcraCerHistory(fbRes.data);
          if (parsedFb.length > 0) {
            cerHistory = parsedFb;
            effectiveCerVarId = 30;
          }
        }
      }

      const value = {
        al30History: al30Res.ok ? this.parseData912History(al30Res.data) : [],
        al30cHistory: al30cRes.ok ? this.parseData912History(al30cRes.data) : [],
        gd30History: gd30Res.ok ? this.parseData912History(gd30Res.data) : [],
        gd30cHistory: gd30cRes.ok ? this.parseData912History(gd30cRes.data) : [],
        cerHistory,
        cerVarId: effectiveCerVarId,
      };
      this.historyCache = { fetchedAtMs: nowMs, value };
      return value;
    })();

    this.historyInFlight = work;
    try {
      return await work;
    } finally {
      this.historyInFlight = null;
    }
  }

  private async loadMarketBundle(forceRefresh = false): Promise<MarketBundle> {
    const nowMs = this.nowMsFn();
    if (!forceRefresh && this.bundleCache !== null && nowMs - this.bundleCache.fetchedAtMs < this.cacheTtlMs) {
      return this.bundleCache.value;
    }
    if (!forceRefresh && this.bundleInFlight !== null) {
      return this.bundleInFlight;
    }

    const work = (async (): Promise<MarketBundle> => {
      const errors: string[] = [];
      const asOfUtcSec = Math.floor(this.nowMsFn() / 1_000);

      const [overview, macro, monitoring, ggalDetail, ggalOptions, bmbSnapshot] = await Promise.all([
        this.arRuntime.getOverview(forceRefresh),
        this.arRuntime.getMacro(forceRefresh),
        this.arRuntime.getMonitoring('bonos', forceRefresh),
        this.arRuntime.getStockDetail('GGAL', forceRefresh),
        this.arRuntime.getOptionsChain('GGAL', forceRefresh),
        typeof this.arRuntime.getBmbSnapshot === 'function'
          ? this.arRuntime.getBmbSnapshot('GGAL', forceRefresh).catch((): null => null)
          : Promise.resolve(null),
      ]);

      const [usSnapshotRes, usBarsRes, stocksRes, bondsRes, notesRes, caucionesRes, histories] =
        await Promise.all([
          this.runtime
            .getSnapshot('GGAL', forceRefresh ? { forceRefresh: true } : undefined)
            .catch((err: unknown): null => {
              const msg = err instanceof Error ? err.message : String(err);
              errors.push(redactSecrets(`Massive Snapshot GGAL: ${msg}`, this.secrets));
              return null;
            }),
          this.runtime
            .getBars('GGAL', '1D', { visibleBars: 240, forceRefresh })
            .catch((err: unknown): null => {
              const msg = err instanceof Error ? err.message : String(err);
              errors.push(redactSecrets(`Massive Bars GGAL 1D: ${msg}`, this.secrets));
              return null;
            }),
          this.fetchJsonSafe(`${this.data912BaseUrl}/live/arg_stocks`),
          this.fetchJsonSafe(`${this.data912BaseUrl}/live/arg_bonds`),
          this.fetchJsonSafe(`${this.data912BaseUrl}/live/arg_notes`),
          this.fetchJsonSafe(`${this.data912BaseUrl}/live/cauciones`),
          this.loadHistories(asOfUtcSec, forceRefresh),
        ]);

      let usDailyCloseBars: readonly { readonly time: number; readonly close: number }[] =
        usBarsRes !== null
          ? usBarsRes.bars.map((b) => ({ time: b.time, close: b.close }))
          : [];
      if (usDailyCloseBars.length < 75) {
        const cached1d = await this.runtime
          .getCachedDailyBars1d('GGAL', 240, forceRefresh)
          .catch(() => null);
        if (cached1d !== null && cached1d.bars.length > usDailyCloseBars.length) {
          usDailyCloseBars = cached1d.bars.map((b) => ({ time: b.time, close: b.close }));
        }
      }

      // Pieza 32: NBBO Tradier para ADRs US (respaldo/complemento explícito de
      // Massive en el especialista GGAL; `null` cuando Tradier no está configurado).
      const tradierAdrQuotes: TradierQuotesResult | null = this.runtime.isTradierConfigured()
        ? await this.runtime
            .fetchTradierQuotesSafe([...GGAL_TRADIER_ADR_SYMBOLS])
            .catch(
              (err: unknown): null => {
                const msg = err instanceof Error ? err.message : String(err);
                errors.push(redactSecrets(`Tradier ADR NBBO: ${msg}`, this.secrets));
                return null;
              },
            )
        : null;

      const bundle: MarketBundle = {
        asOfUtcSec,
        overview,
        macro,
        monitoring,
        ggalDetail,
        ggalOptions,
        bmbSnapshot,
        usSnapshot: usSnapshotRes,
        usBars: usBarsRes,
        usDailyCloseBars,
        liveStocks: stocksRes.ok ? this.parseData912Rows(stocksRes.data) : [],
        liveBonds: bondsRes.ok ? this.parseData912Rows(bondsRes.data) : [],
        liveNotes: notesRes.ok ? this.parseData912Rows(notesRes.data) : [],
        liveCauciones: caucionesRes.ok ? this.parseData912Rows(caucionesRes.data) : [],
        al30History: histories.al30History,
        al30cHistory: histories.al30cHistory,
        gd30History: histories.gd30History,
        gd30cHistory: histories.gd30cHistory,
        cerHistory: histories.cerHistory,
        cerVarId: histories.cerVarId,
        tradierAdrQuotes,
        errors,
      };

      this.bundleCache = { fetchedAtMs: nowMs, value: bundle };
      const lastSnap = this.recorderSnapshots[this.recorderSnapshots.length - 1];
      const minStepSec = Math.max(1, Math.floor(this.recorderIntervalMs / 1_000));
      if (lastSnap === undefined || bundle.asOfUtcSec - lastSnap.asOfUtcSec >= minStepSec) {
        this.appendRecorderObservation(bundle);
      }
      return bundle;
    })();

    this.bundleInFlight = work;
    try {
      return await work;
    } finally {
      this.bundleInFlight = null;
    }
  }

  private resolveTelemetryMode(
    bundle: MarketBundle,
    executionPriceBasis: ExecutionPriceBasis,
    paritySignal?: ParityGapOutput['signal'],
    overrideAnexoBLag?: number | null,
  ): GgalTelemetryHeaderDto {
    const asOfUtcSec = bundle.asOfUtcSec;
    const isClosedSession = bundle.overview.marketState === 'CERRADO';
    const isEodMode =
      bundle.overview.feedStatus === 'EOD_CIERRE' ||
      bundle.usSnapshot?.feedMode === 'EOD_CIERRE' ||
      isClosedSession;

    const parity = evaluateParityGap({
      asOfUtcSec,
      data912TimestampSec: bundle.overview.asOfUtcSec,
      massiveTimestampSec: bundle.usSnapshot?.asOfUtcSec ?? bundle.overview.asOfUtcSec,
      marketMode: isEodMode ? 'EOD_CIERRE' : 'LIVE',
      byma24h: { bid: Number.NaN, ask: Number.NaN },
      adr: { bid: Number.NaN, ask: Number.NaN },
      sofrRateAnnual: Number.NaN,
      caucionArsRateTna: Number.NaN,
      sovereignBonds: [],
      spreadHistory: [],
      arHolidays: this.arHolidays,
      usHolidays: this.usHolidays,
    });

    const d912Ts = bundle.overview.asOfUtcSec;
    const massiveTs = bundle.usSnapshot?.asOfUtcSec ?? bundle.usBars?.asOfUtcSec ?? null;
    const data912AgeSec = asOfUtcSec - d912Ts;
    const massiveAgeSec = massiveTs !== null ? asOfUtcSec - massiveTs : null;

    const anexoBStatus: 'T-1 ANEXO B' | 'NO_DATA' =
      this.anexoBStore !== null ? 'T-1 ANEXO B' : 'NO_DATA';

    let feedStatus: GgalBadgeMode;
    if (paritySignal === 'STALE_DATA_LOCK') {
      feedStatus = 'STALE_DATA_LOCK';
    } else if (isEodMode) {
      feedStatus = 'EOD_CIERRE';
    } else if (bundle.overview.feedStatus === 'DIFERIDO_20M') {
      feedStatus = 'DIFERIDO_20M';
    } else if (bundle.overview.feedStatus === 'LIVE' || bundle.overview.feedStatus === 'PARTIAL') {
      feedStatus = bundle.overview.feedStatus === 'LIVE' ? 'LIVE' : 'DIFERIDO_20M';
    } else {
      feedStatus = 'NO_DATA';
    }

    const badges: GgalBadgeMode[] = [feedStatus];
    if (anexoBStatus === 'T-1 ANEXO B') {
      badges.push('T-1 ANEXO B');
    }

    const allErrors = Array.from(
      new Set([...bundle.overview.providerErrors, ...bundle.ggalOptions.providerErrors, ...bundle.errors]),
    );    const hideClosedOpenByma = isClosedSession || parity.sessionRegime === 'CLOSED';
    const hasContingentFeed =
      bundle.liveStocks.length > 0 || bundle.usSnapshot !== null || bundle.usBars !== null;
    const visibleErrors = allErrors.filter((err) => {
      if (hideClosedOpenByma && /open\.bymadata\.com\.ar/i.test(err)) {
        return false;
      }
      if (
        (hideClosedOpenByma || hasContingentFeed) &&
        /the operation was aborted due to timeout/i.test(err)
      ) {
        return false;
      }
      return true;
    });

    return {
      asOfUtcSec,
      timestampUtc: formatIsoUtcFromSec(asOfUtcSec),
      sessionRegime: parity.sessionRegime,
      dstMode: parity.dstMode,
      marketMode: isEodMode ? 'EOD_CIERRE' : 'LIVE',
      feedStatus,
      feedBadges: badges,
      executionPriceBasis,
      data912TimestampSec: d912Ts,
      massiveTimestampSec: massiveTs,
      data912AgeSec: sanitizeFinite(data912AgeSec),
      massiveAgeSec: massiveAgeSec !== null ? sanitizeFinite(massiveAgeSec) : null,
      anexoBStatus,
      anexoBAsOfDate: this.anexoBStore?.asOfDate ?? null,
      anexoBLagTradingDays: overrideAnexoBLag ?? null,
      recorder: this.getRecorderStatus(),
      providerErrors: visibleErrors,
      sourceDiagnostics: [
        ...allErrors,
        // Pieza 32: origen explícito del NBBO del ADR (Tradier Live vs Massive).
        bundle.tradierAdrQuotes === null
          ? 'ADR NBBO GGAL: MASSIVE (Tradier no configurado o sin respuesta)'
          : `ADR NBBO GGAL: TRADIER (rows=${String(bundle.tradierAdrQuotes.provenance.rows)}, http=${String(bundle.tradierAdrQuotes.provenance.httpStatus ?? 'n/a')})`,
      ],
    };
  }

  private buildSovereignBondQuotes(
    bundle: MarketBundle,
    allowEodReference: boolean,
  ): { readonly quotes: SovereignBondCclQuote[]; readonly displayRows: GgalSovereignBondLegDto[] } {
    const displayRows: GgalSovereignBondLegDto[] = [];
    const quotes: SovereignBondCclQuote[] = [];
    const pairs = [
      { ticker: 'AL30', usdCSymbol: 'AL30C' },
      { ticker: 'GD30', usdCSymbol: 'GD30C' },
    ] as const;

    for (const pair of pairs) {
      const arsLive = bundle.liveBonds.find((b) => b.symbol === pair.ticker);
      const usdCLive = bundle.liveBonds.find((b) => b.symbol === pair.usdCSymbol);
      const bondSummary = bundle.monitoring.bonds.find((b) => b.ticker === pair.ticker);

      const arsBuilt = makeBidAskQuote(
        arsLive?.bid,
        arsLive?.ask,
        arsLive?.last ?? bondSummary?.priceArs,
        allowEodReference,
      );

      // En OpenBYMA/Data912, si bondSummary tiene priceArs y cclImplicit, podemos derivar usdCMid real solo cuando ambos están reportados
      const derivedUsdC =
        bondSummary?.priceArs !== null &&
        bondSummary?.priceArs !== undefined &&
        bondSummary.cclImplicit !== null &&
        bondSummary.cclImplicit !== undefined &&
        bondSummary.cclImplicit > 0
          ? (bondSummary.priceArs / bondSummary.cclImplicit) * 100 / 100
          : null;

      const usdCBuilt = makeBidAskQuote(
        usdCLive?.bid,
        usdCLive?.ask,
        usdCLive?.last ?? derivedUsdC,
        allowEodReference,
      );

      const arsMid =
        Number.isFinite(arsBuilt.quote.bid) && Number.isFinite(arsBuilt.quote.ask)
          ? 0.5 * (arsBuilt.quote.bid + arsBuilt.quote.ask)
          : Number.NaN;
      const usdCMid =
        Number.isFinite(usdCBuilt.quote.bid) && Number.isFinite(usdCBuilt.quote.ask)
          ? 0.5 * (usdCBuilt.quote.bid + usdCBuilt.quote.ask)
          : Number.NaN;

      const nominalVol = arsLive?.volumeArs ?? bondSummary?.volumeM ?? null;

      if (Number.isFinite(arsMid) && Number.isFinite(usdCMid) && arsMid > 0 && usdCMid > 0) {
        quotes.push({
          ticker: pair.ticker,
          ars24h: arsBuilt.quote,
          usdC24h: usdCBuilt.quote,
          arsNominalBase: 100,
          usdCNominalBase: 100,
          ...(nominalVol !== null && Number.isFinite(nominalVol) && nominalVol >= 0
            ? { nominalVolumeArs: nominalVol }
            : {}),
        });
      }

      displayRows.push({
        ticker: pair.ticker,
        arsBid: sanitizeFinite(arsBuilt.quote.bid),
        arsAsk: sanitizeFinite(arsBuilt.quote.ask),
        arsMid: sanitizeFinite(arsMid),
        usdCBid: sanitizeFinite(usdCBuilt.quote.bid),
        usdCAsk: sanitizeFinite(usdCBuilt.quote.ask),
        usdCMid: sanitizeFinite(usdCMid),
        cclImplied:
          Number.isFinite(arsMid) && Number.isFinite(usdCMid) && usdCMid > 0
            ? sanitizeFinite(arsMid / usdCMid)
            : sanitizeFinite(bondSummary?.cclImplicit ?? Number.NaN),
        nominalVolumeArs: sanitizeFinite(nominalVol ?? Number.NaN),
      });
    }

    return { quotes, displayRows };
  }

  private buildCausalSpreadHistory(bundle: MarketBundle): {
    readonly observations: CausalSpreadObservation[];
    readonly points: GgalHistoricalSpreadPointDto[];
  } {
    const arByDate = new Map<string, { readonly time: number; readonly close: number }>();
    for (const bar of bundle.ggalDetail.historicalBars) {
      if (Number.isFinite(bar.close) && bar.close > 0) {
        arByDate.set(bar.date, { time: bar.time, close: bar.close });
      }
    }

    const adrByDate = new Map<string, number>();
    if (bundle.usBars !== null) {
      for (const bar of bundle.usBars.bars) {
        if (Number.isFinite(bar.close) && bar.close > 0) {
          const dk = formatIsoUtcFromSec(bar.time).slice(0, 10);
          adrByDate.set(dk, bar.close);
        }
      }
    }

    const al30ByDate = new Map(bundle.al30History.map((p) => [p.date, p.close]));
    const al30cByDate = new Map(bundle.al30cHistory.map((p) => [p.date, p.close]));
    const gd30ByDate = new Map(bundle.gd30History.map((p) => [p.date, p.close]));
    const gd30cByDate = new Map(bundle.gd30cHistory.map((p) => [p.date, p.close]));

    const points: GgalHistoricalSpreadPointDto[] = [];
    const observations: CausalSpreadObservation[] = [];

    const sortedDates = [...arByDate.keys()].sort();
    for (const date of sortedDates) {
      const ar = arByDate.get(date);
      const adrClose = adrByDate.get(date);
      if (ar === undefined || adrClose === undefined || adrClose <= 0) {
        continue;
      }
      const cclGgal = (GGAL_ADR_RATIO * ar.close) / adrClose;

      const al30 = al30ByDate.get(date);
      const al30c = al30cByDate.get(date);
      const gd30 = gd30ByDate.get(date);
      const gd30c = gd30cByDate.get(date);

      const bondCcls: number[] = [];
      if (al30 !== undefined && al30c !== undefined && al30 > 0 && al30c > 0) {
        bondCcls.push(al30 / al30c);
      }
      if (gd30 !== undefined && gd30c !== undefined && gd30 > 0 && gd30c > 0) {
        bondCcls.push(gd30 / gd30c);
      }
      if (bondCcls.length === 0) {
        continue;
      }
      const cclSovereign = bondCcls.reduce((a, b) => a + b, 0) / bondCcls.length;
      if (!Number.isFinite(cclGgal) || cclGgal <= 0 || !Number.isFinite(cclSovereign) || cclSovereign <= 0) {
        continue;
      }

      const spreadLogBps = (Math.log(cclGgal) - Math.log(cclSovereign)) * 10_000;
      observations.push({
        time: ar.time,
        cclGgal24h: cclGgal,
        cclSovereign,
      });
      points.push({
        time: ar.time,
        date,
        cclGgal24h: cclGgal,
        cclSovereign,
        spreadLogBps,
      });
    }

    return { observations, points };
  }

  private resolveSofrAndRateBenchmarks(bundle: MarketBundle): {
    readonly sofrPct: number;
    readonly sofrRateAnnual: number;
    readonly sofrSource: string | null;
    readonly rateCurveArs: ContinuousRateCurvePoint[];
    readonly caucion1dTnaPct: number;
    readonly caucionSource: string | null;
    readonly lecapMatchedTnaPct: number;
  } {
    let sofrPct = Number.NaN;
    let sofrSource: string | null = null;
    const usSofr = bundle.usSnapshot?.marketContext.treasury.sofr ?? null;
    const arSofr = bundle.macro.variables.sofrUsdTna ?? null;
    if (usSofr !== null && Number.isFinite(usSofr) && usSofr >= 0) {
      sofrPct = usSofr;
      sofrSource = 'NY Fed / Massive Treasury';
    } else if (arSofr !== null && Number.isFinite(arSofr) && arSofr >= 0) {
      sofrPct = arSofr;
      sofrSource = 'NY Fed SOFR (AR Loader)';
    }

    const arsRates = buildArsRateCurveAndBenchmarks(
      bundle.macro,
      bundle.ggalOptions,
      bundle.liveCauciones,
      bundle.liveNotes,
      bundle.monitoring,
    );

    return {
      sofrPct,
      sofrRateAnnual: Number.isFinite(sofrPct) ? sofrPct / 100 : Number.NaN,
      sofrSource,
      ...arsRates,
    };
  }

  private resolveSpotQuotes(bundle: MarketBundle, isEodMode: boolean) {
    const ggalLive = bundle.liveStocks.find((s) => s.symbol === 'GGAL');
    const ggalOverview = bundle.overview.mervalStocks.find((s) => s.ticker === 'GGAL');
    const bymaLast = ggalLive?.last ?? ggalOverview?.last ?? bundle.ggalOptions.spot ?? null;
    const bymaBuilt = makeBidAskQuote(
      ggalLive?.bid ?? ggalOverview?.bid,
      ggalLive?.ask ?? ggalOverview?.ask,
      bymaLast,
      isEodMode,
    );

    // CI si aparece explícita en Data912 (ej. GGAL.CI / GGAL_CI)
    const ggalCiRow = bundle.liveStocks.find(
      (s) => s.symbol === 'GGAL.CI' || s.symbol === 'GGAL_CI' || s.symbol === 'GGALCI',
    );
    const bymaCiBuilt =
      ggalCiRow !== undefined
        ? makeBidAskQuote(ggalCiRow.bid, ggalCiRow.ask, ggalCiRow.last, isEodMode)
        : null;

    // ADR NASDAQ desde Massive snapshot / bars o Data912 usa_adrs reflejado en ggalOverview.adrPrice.
    // Pieza 32: cuando Tradier está configurado, las puntas NBBO del ADR se
    // refrescan con Tradier Live (`provider: 'TRADIER'`); si las puntas no son
    // válidas se mantiene explícitamente la referencia Massive (EOD/close).
    const tradierGgal =
      bundle.tradierAdrQuotes?.quotes.find((q) => q.symbol === 'GGAL') ?? null;
    const tradierNbboValid =
      tradierGgal !== null &&
      Number.isFinite(tradierGgal.bid) &&
      tradierGgal.bid > 0 &&
      Number.isFinite(tradierGgal.ask) &&
      tradierGgal.ask >= tradierGgal.bid;
    const lastAdrBarClose =
      bundle.usBars !== null && bundle.usBars.bars.length > 0
        ? (bundle.usBars.bars[bundle.usBars.bars.length - 1]?.close ?? null)
        : null;
    const adrSpot =
      bundle.usSnapshot?.envelope.snapshot.metrics.spot ??
      lastAdrBarClose ??
      ggalOverview?.adrPrice ??
      null;
    const adrBuilt = tradierNbboValid
      ? makeBidAskQuote(
          tradierGgal.bid,
          tradierGgal.ask,
          Number.isFinite(tradierGgal.last) && tradierGgal.last > 0 ? tradierGgal.last : adrSpot,
          isEodMode,
        )
      : makeBidAskQuote(null, null, adrSpot, true);
    const adrQuoteSource: 'TRADIER_LIVE_NBBO' | 'MASSIVE' = tradierNbboValid
      ? 'TRADIER_LIVE_NBBO'
      : 'MASSIVE';

    const basis: ExecutionPriceBasis =
      bymaBuilt.basis === 'LIVE_BID_ASK'
        ? 'LIVE_BID_ASK'
        : bymaBuilt.basis === 'EOD_CLOSE_REFERENCE'
          ? 'EOD_CLOSE_REFERENCE'
          : 'NONE';

    return {
      byma24hQuote: bymaBuilt.quote,
      bymaCiQuote: bymaCiBuilt?.quote,
      bymaPrevClose: ggalLive?.prevClose ?? ggalOverview?.prevClose ?? null,
      adrQuote: adrBuilt.quote,
      adrQuoteSource,
      lastAdrBarClose,
      basis,
    };
  }

  private computeParityGapCore(bundle: MarketBundle): {
    readonly output: ParityGapOutput;
    readonly marketMode: 'LIVE' | 'EOD_CIERRE';
    readonly executionPriceBasis: ExecutionPriceBasis;
    readonly sovereignBonds: readonly GgalSovereignBondLegDto[];
    readonly historicalSpreads: readonly GgalHistoricalSpreadPointDto[];
    readonly rates: ReturnType<GgalSpecialistRuntime['resolveSofrAndRateBenchmarks']>;
  } {
    const isClosed = bundle.overview.marketState === 'CERRADO';
    const isEodMode =
      bundle.overview.feedStatus === 'EOD_CIERRE' ||
      bundle.usSnapshot?.feedMode === 'EOD_CIERRE' ||
      isClosed;
    const marketMode: 'LIVE' | 'EOD_CIERRE' = isEodMode ? 'EOD_CIERRE' : 'LIVE';

    const spots = this.resolveSpotQuotes(bundle, isEodMode);
    const rates = this.resolveSofrAndRateBenchmarks(bundle);
    const bonds = this.buildSovereignBondQuotes(bundle, isEodMode);
    const spreadHist = this.buildCausalSpreadHistory(bundle);

    const preMarketBars = bundle.usBars?.bars ?? [];
    const adrPrevClose =
      preMarketBars.length >= 2
        ? (preMarketBars[preMarketBars.length - 2]?.close ?? spots.lastAdrBarClose)
        : spots.lastAdrBarClose;

    const spyU = bundle.usSnapshot?.marketContext.unifiedQuotes.find((q) => q.ticker === 'SPY');
    const qqqU = bundle.usSnapshot?.marketContext.unifiedQuotes.find((q) => q.ticker === 'QQQ');
    const vixU = bundle.usSnapshot?.marketContext.unifiedQuotes.find((q) => q.ticker === 'VIX');
    const logRetFromPct = (pct: number | null | undefined): number | undefined => {
      if (pct === null || pct === undefined || !Number.isFinite(pct) || 1 + pct / 100 <= 0) {
        return undefined;
      }
      return Math.log(1 + pct / 100);
    };

    const spyLogRet = logRetFromPct(spyU?.changePct);
    const qqqLogRet = logRetFromPct(qqqU?.changePct);
    const vixLogChg = logRetFromPct(vixU?.changePct);

    const preOpenInput: PreOpenMacroPredictorInput | undefined =
      spots.bymaPrevClose !== null &&
      spots.bymaPrevClose > 0 &&
      adrPrevClose !== null &&
      adrPrevClose > 0
        ? {
            bymaPrevClose24hArs: spots.bymaPrevClose,
            adrPrev1700ArtUsd: adrPrevClose,
            ...(spyLogRet !== undefined
              ? { spyOvernightLogReturn: spyLogRet }
              : {}),
            ...(qqqLogRet !== undefined
              ? { qqqOvernightLogReturn: qqqLogRet }
              : {}),
            ...(vixLogChg !== undefined
              ? { vixOvernightLogChange: vixLogChg }
              : {}),
          }
        : undefined;

    const { front } = selectLiquidFrontAndBackExpiries(bundle.ggalOptions);
    const preOpenOptions: LocalOptionPreOpenInput[] = [];
    if (front !== null) {
      for (const c of [...front.calls, ...front.puts].slice(0, 12)) {
        const refPrice = c.mark ?? c.last ?? (c.bid !== null && c.ask !== null ? 0.5 * (c.bid + c.ask) : null);
        if (
          refPrice !== null &&
          refPrice > 0 &&
          c.delta !== null &&
          c.gamma !== null &&
          c.thetaDaily !== null &&
          c.vegaPer1Pct !== null
        ) {
          preOpenOptions.push({
            tickerByma: c.symbol,
            prevCloseArs: refPrice,
            delta: c.delta,
            gamma: c.gamma,
            vega: c.vegaPer1Pct * 100,
            theta: c.thetaDaily * 365,
          });
        }
      }
    }

    const input: ParityGapInput = {
      asOfUtcSec: bundle.asOfUtcSec,
      data912TimestampSec: bundle.overview.asOfUtcSec,
      massiveTimestampSec: bundle.usSnapshot?.asOfUtcSec ?? bundle.usBars?.asOfUtcSec ?? bundle.overview.asOfUtcSec,
      marketMode,
      maxData912StalenessSec: this.maxData912StalenessSec,
      maxMassiveStalenessSec: this.maxMassiveStalenessSec,
      maxSyncSkewSec: this.maxSyncSkewSec,
      arHolidays: this.arHolidays,
      usHolidays: this.usHolidays,
      byma24h: spots.byma24hQuote,
      ...(spots.bymaCiQuote !== undefined ? { bymaCi: spots.bymaCiQuote } : {}),
      adr: spots.adrQuote,
      sofrRateAnnual: rates.sofrRateAnnual,
      caucionArsRateTna: Number.isFinite(rates.caucion1dTnaPct) ? rates.caucion1dTnaPct / 100 : Number.NaN,
      sovereignBonds: bonds.quotes,
      spreadHistory: spreadHist.observations,
      ...(spots.bymaPrevClose !== null ? { bymaPrevClose24hArs: spots.bymaPrevClose } : {}),
      ...(preOpenInput !== undefined ? { preOpen: preOpenInput } : {}),
      ...(preOpenOptions.length > 0 ? { preOpenOptions } : {}),
    };

    const output = evaluateParityGap(input);
    return {
      output,
      marketMode,
      executionPriceBasis: spots.basis,
      sovereignBonds: bonds.displayRows,
      historicalSpreads: spreadHist.points,
      rates,
    };
  }

  public async getParityGap(forceRefresh = false): Promise<GgalParityGapResponse> {
    const bundle = await this.loadMarketBundle(forceRefresh);
    const core = this.computeParityGapCore(bundle);
    const telemetry = this.resolveTelemetryMode(
      bundle,
      core.executionPriceBasis,
      core.output.signal,
    );
    return {
      telemetry,
      result: toJsonSafe(core.output),
      sovereignBonds: core.sovereignBonds,
      historicalSpreads: core.historicalSpreads,
      rateInputs: {
        sofrPct: sanitizeFinite(core.rates.sofrPct),
        sofrSource: core.rates.sofrSource,
        caucion1dTnaPct: sanitizeFinite(core.rates.caucion1dTnaPct),
        caucionSource: core.rates.caucionSource,
      },
    };
  }

  private evaluateExtrapolatedVolTriangleSmile(params: {
    readonly output: CrossCurrencyVolOutput | null;
    readonly front: ArOptionExpiryDto | null;
    readonly spot24hArs: number;
    readonly rates: ReturnType<GgalSpecialistRuntime['resolveSofrAndRateBenchmarks']>;
    readonly opraSlices: readonly OpraMaturitySliceInput[];
    readonly asOfUtcSec: number;
  }): {
    readonly smileComparison: GgalSmileComparisonPointDto[];
    readonly enrichedOutput: CrossCurrencyVolOutput | null;
    readonly impliedCclVolWingsPct: number | null;
    readonly impliedCclMinFloorPct: number | null;
    readonly atmCompressionPts: number | null;
  } {
    const { output, front, spot24hArs, rates, opraSlices, asOfUtcSec } = params;
    if (front === null) {
      return {
        smileComparison: [],
        enrichedOutput: output,
        impliedCclVolWingsPct: null,
        impliedCclMinFloorPct: null,
        atmCompressionPts: null,
      };
    }

    const computeBymaEval =
      Number.isFinite(spot24hArs) && spot24hArs > 0 && rates.rateCurveArs.length > 0
        ? computeBymaOptionEvalParams({
            asOfUtcSec,
            spot24hArs,
            expiryDateKey: front.expirationDate,
            expiry1530UtcSec: computeExpiration1530ArtUtcSec(front.expirationDate),
            arHolidays: this.arHolidays,
            rateCurve: rates.rateCurveArs,
          })
        : null;

    // Preconstruir curvas OPRA ordenadas por z estandarizado para interpolación y extrapolación suave en alas
    interface OpraZCurve {
      readonly timeToExpiryYears: number;
      readonly atmIvDecimal: number;
      readonly nodes: readonly { readonly z: number; readonly iv: number }[];
    }
    const opraCurves: OpraZCurve[] = [];
    for (const sl of opraSlices) {
      if (
        !Number.isFinite(sl.forwardUsd) ||
        sl.forwardUsd <= 0 ||
        !Number.isFinite(sl.atmIvDecimal) ||
        sl.atmIvDecimal <= 0 ||
        !Number.isFinite(sl.timeToExpiryYears) ||
        sl.timeToExpiryYears <= 0
      ) {
        continue;
      }
      const denom = sl.atmIvDecimal * Math.sqrt(sl.timeToExpiryYears);
      if (!Number.isFinite(denom) || denom <= 0) {
        continue;
      }
      // Replicar exactamente build/interpolateSliceIvAtZ de volTriangle.ts para continuidad C0 en los extremos
      const byStrike = new Map<number, { z: number; iv: number }>();
      for (const q of sl.quotes) {
        if (!Number.isFinite(q.strike) || q.strike <= 0 || !Number.isFinite(q.ivDecimal) || q.ivDecimal <= 0.02 || q.ivDecimal > 4.0) {
          continue;
        }
        const z = Math.log(q.strike / sl.forwardUsd) / denom;
        if (!Number.isFinite(z)) {
          continue;
        }
        const isOtm =
          (q.strike >= sl.forwardUsd && q.contractType === 'call') ||
          (q.strike < sl.forwardUsd && q.contractType === 'put');
        if (!byStrike.has(q.strike) || isOtm) {
          byStrike.set(q.strike, { z, iv: q.ivDecimal });
        }
      }
      const nodes = Array.from(byStrike.values()).sort((a, b) => a.z - b.z);
      if (nodes.length >= 2) {
        opraCurves.push({
          timeToExpiryYears: sl.timeToExpiryYears,
          atmIvDecimal: sl.atmIvDecimal,
          nodes,
        });
      }
    }
    opraCurves.sort((a, b) => a.timeToExpiryYears - b.timeToExpiryYears);

    const evalSingleCurve = (curve: OpraZCurve, zTarget: number): number => {
      const nodes = curve.nodes;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (first === undefined || last === undefined) {
        return Number.NaN;
      }
      if (nodes.length === 1) {
        return first.iv;
      }
      const minIv = Math.max(0.05, Math.min(...nodes.map((n) => n.iv)) * 0.45);
      const maxIv = Math.min(2.5, Math.max(1.2, Math.max(...nodes.map((n) => n.iv)) * 2.1));

      if (zTarget < first.z) {
        let anchorIdx = 1;
        for (let i = 1; i < nodes.length; i += 1) {
          if ((nodes[i]?.z ?? first.z) - first.z >= 0.15) {
            anchorIdx = i;
            break;
          }
        }
        const anchor = nodes[anchorIdx] ?? nodes[1] ?? first;
        const dzBase = anchor.z - first.z;
        const rawSlope = dzBase > 1e-5 ? (anchor.iv - first.iv) / dzBase : 0;
        // Acotar pendiente de ala izquierda para evitar volúmenes negativos o explosivos
        const clampedSlope = Math.max(-0.18, Math.min(0.08, rawSlope));
        const dz = zTarget - first.z;
        const dampedDz = dz / (1 + 0.35 * Math.abs(dz));
        return Math.max(minIv, Math.min(maxIv, first.iv + clampedSlope * dampedDz));
      }

      if (zTarget > last.z) {
        let anchorIdx = nodes.length - 2;
        for (let i = nodes.length - 2; i >= 0; i -= 1) {
          if (last.z - (nodes[i]?.z ?? last.z) >= 0.15) {
            anchorIdx = i;
            break;
          }
        }
        const anchor = nodes[anchorIdx] ?? nodes[nodes.length - 2] ?? last;
        const dzBase = last.z - anchor.z;
        const rawSlope = dzBase > 1e-5 ? (last.iv - anchor.iv) / dzBase : 0;
        const clampedSlope = Math.max(-0.08, Math.min(0.18, rawSlope));
        const dz = zTarget - last.z;
        const dampedDz = dz / (1 + 0.35 * Math.abs(dz));
        return Math.max(minIv, Math.min(maxIv, last.iv + clampedSlope * dampedDz));
      }

      for (let i = 0; i < nodes.length - 1; i += 1) {
        const a = nodes[i];
        const b = nodes[i + 1];
        if (a !== undefined && b !== undefined && zTarget >= a.z && zTarget <= b.z) {
          const span = b.z - a.z;
          if (span <= 1e-9) {
            return a.iv;
          }
          const w = (zTarget - a.z) / span;
          const varA = a.iv * a.iv * curve.timeToExpiryYears;
          const varB = b.iv * b.iv * curve.timeToExpiryYears;
          const varInterp = varA + w * (varB - varA);
          return varInterp > 0 ? Math.sqrt(varInterp / curve.timeToExpiryYears) : a.iv;
        }
      }
      return last.iv;
    };

    const evalOpraIvAtZ = (zTarget: number): number => {
      if (opraCurves.length === 0 || !Number.isFinite(zTarget)) {
        return Number.NaN;
      }
      const targetT = computeBymaEval?.tExpYears ?? front.days / 365;
      // Igual que interpolateOpraTotalVarIv(..., singleSliceDayTolerance=5): si existe slice cercano en plazo, usarlo directamente
      const nearest = opraCurves
        .slice()
        .sort((a, b) => Math.abs(a.timeToExpiryYears - targetT) - Math.abs(b.timeToExpiryYears - targetT))[0];
      if (nearest !== undefined && Math.abs(nearest.timeToExpiryYears - targetT) * 365 <= 5) {
        return evalSingleCurve(nearest, zTarget);
      }
      const firstCurve = opraCurves[0];
      const lastCurve = opraCurves[opraCurves.length - 1];
      if (firstCurve === undefined || lastCurve === undefined) {
        return Number.NaN;
      }
      if (opraCurves.length === 1 || targetT <= firstCurve.timeToExpiryYears) {
        return evalSingleCurve(firstCurve, zTarget);
      }
      if (targetT >= lastCurve.timeToExpiryYears) {
        return evalSingleCurve(lastCurve, zTarget);
      }
      for (let i = 0; i < opraCurves.length - 1; i += 1) {
        const c0 = opraCurves[i];
        const c1 = opraCurves[i + 1];
        if (c0 !== undefined && c1 !== undefined && targetT >= c0.timeToExpiryYears && targetT <= c1.timeToExpiryYears) {
          const iv0 = evalSingleCurve(c0, zTarget);
          const iv1 = evalSingleCurve(c1, zTarget);
          if (!Number.isFinite(iv0) || !Number.isFinite(iv1)) {
            return Number.isFinite(iv0) ? iv0 : iv1;
          }
          const spanT = c1.timeToExpiryYears - c0.timeToExpiryYears;
          if (spanT <= 1e-9) {
            return iv0;
          }
          const alpha = (targetT - c0.timeToExpiryYears) / spanT;
          const var0 = iv0 * iv0 * c0.timeToExpiryYears;
          const var1 = iv1 * iv1 * c1.timeToExpiryYears;
          const varT = var0 + alpha * (var1 - var0);
          return varT > 0 && targetT > 0 ? Math.sqrt(varT / targetT) : iv0;
        }
      }
      return evalSingleCurve(lastCurve, zTarget);
    };

    const corr = output?.realizedCorrEwma ?? Number.NaN;
    const harRvCclAnnual =
      output !== null && Number.isFinite(output.harRvCclPct) && output.harRvCclPct > 0
        ? output.harRvCclPct / 100
        : Number.NaN;
    const bymaAtmAnnual =
      output !== null && Number.isFinite(output.bymaAtmIvPct) && output.bymaAtmIvPct > 0
        ? output.bymaAtmIvPct / 100
        : front.ivAtm ?? Number.NaN;

    const anomalyMap = new Map((output?.anomalies ?? []).map((a) => [a.strikeBymaArs, a]));
    const smileComparison: GgalSmileComparisonPointDto[] = [];
    const enrichedAnomalies: CrossCurrencyVolOutput['anomalies'][number][] = [];
    const putWingCclRoots: number[] = [];
    const callWingCclRoots: number[] = [];

    for (const strike of front.strikes) {
      const call = front.calls.find((c) => c.strike === strike);
      const put = front.puts.find((p) => p.strike === strike);
      const anom = anomalyMap.get(strike);
      const oi =
        (call?.openInterest ?? 0) + (put?.openInterest ?? 0) > 0
          ? (call?.openInterest ?? 0) + (put?.openInterest ?? 0)
          : null;

      const bymaCallPct = call?.iv !== null && call?.iv !== undefined && Number.isFinite(call.iv) && call.iv > 0 ? call.iv * 100 : null;
      const bymaPutPct = put?.iv !== null && put?.iv !== undefined && Number.isFinite(put.iv) && put.iv > 0 ? put.iv * 100 : null;

      let z = anom !== undefined && Number.isFinite(anom.standardizedMoneynessZ) ? anom.standardizedMoneynessZ : Number.NaN;
      if (!Number.isFinite(z) && computeBymaEval !== null && Number.isFinite(bymaAtmAnnual) && bymaAtmAnnual > 0 && computeBymaEval.tExpYears > 0) {
        z = Math.log(strike / computeBymaEval.forwardArs) / (bymaAtmAnnual * Math.sqrt(computeBymaEval.tExpYears));
      }

      const fwdArs = computeBymaEval?.forwardArs ?? spot24hArs;
      const isOtmCall = Number.isFinite(fwdArs) ? strike >= fwdArs : true;
      const obsBymaPct =
        anom !== undefined && Number.isFinite(anom.bymaMidIvPct) && anom.bymaMidIvPct > 0
          ? anom.bymaMidIvPct
          : isOtmCall
            ? (bymaCallPct ?? bymaPutPct)
            : (bymaPutPct ?? bymaCallPct);

      let theorPct =
        anom !== undefined && Number.isFinite(anom.theoreticalBymaIvPct) && anom.theoreticalBymaIvPct > 0
          ? anom.theoreticalBymaIvPct
          : Number.NaN;
      let spreadPct =
        anom !== undefined && Number.isFinite(anom.relValVolSpreadPct)
          ? anom.relValVolSpreadPct
          : Number.NaN;

      const opraIvAtZ = Number.isFinite(z) ? evalOpraIvAtZ(z) : Number.NaN;
      if (
        !Number.isFinite(theorPct) &&
        obsBymaPct !== null &&
        Number.isFinite(opraIvAtZ) &&
        opraIvAtZ > 0 &&
        Number.isFinite(harRvCclAnnual) &&
        Number.isFinite(corr)
      ) {
        const varTheor =
          opraIvAtZ * opraIvAtZ +
          harRvCclAnnual * harRvCclAnnual +
          2 * corr * opraIvAtZ * harRvCclAnnual;
        if (varTheor > 0) {
          theorPct = Math.sqrt(varTheor) * 100;
          spreadPct = obsBymaPct - theorPct;
        }
      } else if (!Number.isFinite(spreadPct) && obsBymaPct !== null && Number.isFinite(theorPct)) {
        spreadPct = obsBymaPct - theorPct;
      }

      let sideBias = anom?.sideBias ?? null;
      if (Number.isFinite(spreadPct) && (anom === undefined || !Number.isFinite(anom.theoreticalBymaIvPct))) {
        sideBias = spreadPct <= -4.0 ? 'CHEAP_BYMA' : spreadPct >= 4.0 ? 'RICH_BYMA' : 'FAIR';
      }
      const arbFlag = anom?.arbFlag ?? (obsBymaPct !== null ? 'OK' : null);

      if (
        Number.isFinite(z) &&
        Number.isFinite(opraIvAtZ) &&
        opraIvAtZ > 0 &&
        Number.isFinite(corr)
      ) {
        if (z <= -0.5 && Math.abs(z) <= 3.5 && bymaPutPct !== null) {
          const putAnn = bymaPutPct / 100;
          if (putAnn > opraIvAtZ) {
            const disc = putAnn * putAnn - (1 - corr * corr) * opraIvAtZ * opraIvAtZ;
            if (disc >= 0) {
              const root = -corr * opraIvAtZ + Math.sqrt(disc);
              if (Number.isFinite(root) && root > 0) {
                putWingCclRoots.push(root * 100);
              }
            }
          }
        } else if (z >= 0.5 && Math.abs(z) <= 3.5 && bymaCallPct !== null) {
          const callAnn = bymaCallPct / 100;
          if (callAnn > opraIvAtZ) {
            const disc = callAnn * callAnn - (1 - corr * corr) * opraIvAtZ * opraIvAtZ;
            if (disc >= 0) {
              const root = -corr * opraIvAtZ + Math.sqrt(disc);
              if (Number.isFinite(root) && root > 0) {
                callWingCclRoots.push(root * 100);
              }
            }
          }
        }
      }

      smileComparison.push({
        strikeArs: strike,
        standardizedMoneynessZ: sanitizeFinite(z),
        bymaCallMidIvPct: bymaCallPct,
        bymaPutMidIvPct: bymaPutPct,
        theoreticalBymaIvPct: sanitizeFinite(theorPct),
        relValVolSpreadPct: sanitizeFinite(spreadPct),
        sideBias,
        arbFlag,
        openInterestNom: oi,
      });

      if (obsBymaPct !== null && Number.isFinite(z) && Number.isFinite(theorPct) && Number.isFinite(spreadPct)) {
        enrichedAnomalies.push({
          strikeBymaArs: strike,
          standardizedMoneynessZ: z,
          bymaMidIvPct: obsBymaPct,
          theoreticalBymaIvPct: theorPct,
          relValVolSpreadPct: spreadPct,
          sideBias: sideBias ?? 'FAIR',
          arbFlag: arbFlag ?? 'OK',
        });
      }
    }

    const computeMedian = (vals: readonly number[]): number | null => {
      if (vals.length === 0) {
        return null;
      }
      const sorted = [...vals].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      if (sorted.length % 2 === 1) {
        return sorted[mid] ?? null;
      }
      const lo = sorted[mid - 1];
      const hi = sorted[mid];
      return lo !== undefined && hi !== undefined ? 0.5 * (lo + hi) : null;
    };

    const wingCcl = computeMedian(putWingCclRoots.length > 0 ? putWingCclRoots : callWingCclRoots);
    const minFloor =
      output !== null && Number.isFinite(output.realizedCorrEwma) && Number.isFinite(output.opraAdrAtmIvPct)
        ? Math.max(0, -output.realizedCorrEwma * output.opraAdrAtmIvPct)
        : Number.NaN;
    const compressionPts =
      output !== null && Number.isFinite(output.bymaAtmIvPct) && Number.isFinite(output.opraAdrAtmIvPct)
        ? output.bymaAtmIvPct - output.opraAdrAtmIvPct
        : Number.NaN;

    const enrichedOutput: CrossCurrencyVolOutput | null =
      output !== null
        ? {
            ...output,
            anomalies: enrichedAnomalies.length > 0 ? enrichedAnomalies : output.anomalies,
          }
        : null;

    return {
      smileComparison,
      enrichedOutput,
      impliedCclVolWingsPct: sanitizeFinite(wingCcl),
      impliedCclMinFloorPct: sanitizeFinite(minFloor),
      atmCompressionPts: sanitizeFinite(compressionPts),
    };
  }

  private buildVolTriangleCore(bundle: MarketBundle): {
    readonly front: ArOptionExpiryDto | null;
    readonly opraMatchedExpiryDate: string | null;
    readonly output: CrossCurrencyVolOutput | null;
    readonly returnObservationsUsed: number;
    readonly executionPriceBasis: ExecutionPriceBasis;
    readonly spot24hArs: number;
    readonly rates: ReturnType<GgalSpecialistRuntime['resolveSofrAndRateBenchmarks']>;
    readonly opraSlices: readonly OpraMaturitySliceInput[];
  } {
    const isClosed = bundle.overview.marketState === 'CERRADO';
    const isEodMode =
      bundle.overview.feedStatus === 'EOD_CIERRE' ||
      bundle.usSnapshot?.feedMode === 'EOD_CIERRE' ||
      isClosed;

    const spots = this.resolveSpotQuotes(bundle, isEodMode);
    const rates = this.resolveSofrAndRateBenchmarks(bundle);
    const { front } = selectLiquidFrontAndBackExpiries(bundle.ggalOptions);
    const spot24hArs =
      Number.isFinite(spots.byma24hQuote.bid) && Number.isFinite(spots.byma24hQuote.ask)
        ? 0.5 * (spots.byma24hQuote.bid + spots.byma24hQuote.ask)
        : Number.NaN;

    if (
      front === null ||
      !Number.isFinite(spot24hArs) ||
      spot24hArs <= 0 ||
      rates.rateCurveArs.length === 0
    ) {
      return {
        front,
        opraMatchedExpiryDate: null,
        output: null,
        returnObservationsUsed: 0,
        executionPriceBasis: spots.basis,
        spot24hArs,
        rates,
        opraSlices: [],
      };
    }

    const bymaOptions: BymaOptionQuoteInput[] = [];
    let optBasis: ExecutionPriceBasis = spots.basis;
    for (const c of [...front.calls, ...front.puts]) {
      const built = makeBidAskQuote(c.bid, c.ask, c.mark ?? c.last, isEodMode);
      if (built.basis === 'LIVE_BID_ASK') {
        optBasis = 'LIVE_BID_ASK';
      }
      if (Number.isFinite(built.quote.bid) && Number.isFinite(built.quote.ask) && built.quote.bid > 0) {
        bymaOptions.push({
          strike: c.strike,
          contractType: c.contractType,
          quote: built.quote,
          ...(c.openInterest !== null && Number.isFinite(c.openInterest) && c.openInterest >= 0
            ? { openInterestNom: c.openInterest }
            : {}),
        });
      }
    }

    // Construir OPRA slices desde Massive GGAL snapshot
    const opraSlices: OpraMaturitySliceInput[] = [];
    const volSummary = bundle.usSnapshot?.volSurfaceSummary ?? null;
    if (volSummary !== null) {
      for (const sl of volSummary.slices) {
        if (sl.forward === null || sl.ivAtm === null || sl.forward <= 0 || sl.ivAtm <= 0) {
          continue;
        }
        const sliceQuotes: OpraSliceQuoteInput[] = [];
        for (const c of volSummary.contracts) {
          if (c.expirationDate !== sl.expirationDate) {
            continue;
          }
          const iv = c.ownIv ?? c.providerIv;
          if (iv !== null && Number.isFinite(iv) && iv > 0) {
            sliceQuotes.push({
              strike: c.strike,
              contractType: c.contractType,
              ivDecimal: iv,
              ...(c.delta !== null && Number.isFinite(c.delta) ? { delta: c.delta } : {}),
            });
          }
        }
        if (sliceQuotes.length > 0) {
          opraSlices.push({
            timeToExpiryYears: sl.timeToExpiryYears,
            forwardUsd: sl.forward,
            atmIvDecimal: sl.ivAtm,
            quotes: sliceQuotes,
          });
        }
      }

      if (opraSlices.length === 0 && volSummary.contracts.length > 0) {
        const spotAdrUsd =
          Number.isFinite(spots.adrQuote.bid) && Number.isFinite(spots.adrQuote.ask) && spots.adrQuote.ask > 0
            ? 0.5 * (spots.adrQuote.bid + spots.adrQuote.ask)
            : Number.NaN;
        if (Number.isFinite(spotAdrUsd) && spotAdrUsd > 0) {
          const byExp = new Map<
            string,
            { expiryUtcSec: number; quotes: OpraSliceQuoteInput[] }
          >();
          for (const c of volSummary.contracts) {
            if (c.expiryUtcSec <= bundle.asOfUtcSec) {
              continue;
            }
            const iv = c.ownIv ?? c.providerIv;
            if (iv === null || !Number.isFinite(iv) || iv <= 0) {
              continue;
            }
            const bucket = byExp.get(c.expirationDate) ?? {
              expiryUtcSec: c.expiryUtcSec,
              quotes: [],
            };
            bucket.quotes.push({
              strike: c.strike,
              contractType: c.contractType,
              ivDecimal: iv,
              ...(c.delta !== null && Number.isFinite(c.delta) ? { delta: c.delta } : {}),
            });
            byExp.set(c.expirationDate, bucket);
          }
          const sofrAnnual = Number.isFinite(rates.sofrRateAnnual) ? rates.sofrRateAnnual : 0;
          for (const [, grp] of byExp) {
            if (grp.quotes.length < 2) {
              continue;
            }
            const tYears = Math.max(1 / 365, (grp.expiryUtcSec - bundle.asOfUtcSec) / (365 * 86_400));
            const forwardUsd = spotAdrUsd * Math.exp((sofrAnnual - 0.012) * tYears);
            const sortedNear = [...grp.quotes].sort(
              (a, b) => Math.abs(a.strike - forwardUsd) - Math.abs(b.strike - forwardUsd),
            );
            const atmSample = sortedNear.slice(0, 2);
            const atmIvDecimal =
              atmSample.reduce((acc, q) => acc + q.ivDecimal, 0) / Math.max(1, atmSample.length);
            if (Number.isFinite(atmIvDecimal) && atmIvDecimal > 0) {
              opraSlices.push({
                timeToExpiryYears: tYears,
                forwardUsd,
                atmIvDecimal,
                quotes: grp.quotes,
              });
            }
          }
        }
      }
    }

    // Series causales de retornos ADR USD y CCL GGAL
    const arByDate = new Map<string, { readonly time: number; readonly close: number }>();
    for (const bar of bundle.ggalDetail.historicalBars) {
      if (Number.isFinite(bar.close) && bar.close > 0) {
        arByDate.set(bar.date, { time: bar.time, close: bar.close });
      }
    }
    const adrByDate = new Map<string, number>();
    for (const bar of bundle.usDailyCloseBars) {
      if (Number.isFinite(bar.close) && bar.close > 0) {
        adrByDate.set(formatIsoUtcFromSec(bar.time).slice(0, 10), bar.close);
      }
    }

    const alignedDates = [...arByDate.keys()].filter((d) => adrByDate.has(d)).sort();
    const returnHistory: { readonly time: number; readonly adrLogReturn: number; readonly cclLogReturn: number }[] = [];
    const cclReturnHistory: { readonly time: number; readonly logReturn: number }[] = [];

    for (let i = 1; i < alignedDates.length; i += 1) {
      const prevD = alignedDates[i - 1];
      const currD = alignedDates[i];
      if (prevD === undefined || currD === undefined) {
        continue;
      }
      const arPrev = arByDate.get(prevD);
      const arCurr = arByDate.get(currD);
      const adrPrev = adrByDate.get(prevD);
      const adrCurr = adrByDate.get(currD);
      if (
        arPrev === undefined ||
        arCurr === undefined ||
        adrPrev === undefined ||
        adrCurr === undefined ||
        adrPrev <= 0 ||
        adrCurr <= 0 ||
        arPrev.close <= 0 ||
        arCurr.close <= 0
      ) {
        continue;
      }
      const cclPrev = (GGAL_ADR_RATIO * arPrev.close) / adrPrev;
      const cclCurr = (GGAL_ADR_RATIO * arCurr.close) / adrCurr;
      if (cclPrev <= 0 || cclCurr <= 0) {
        continue;
      }
      const rAdr = Math.log(adrCurr / adrPrev);
      const rCcl = Math.log(cclCurr / cclPrev);
      returnHistory.push({ time: arCurr.time, adrLogReturn: rAdr, cclLogReturn: rCcl });
      cclReturnHistory.push({ time: arCurr.time, logReturn: rCcl });
    }

    if (bymaOptions.length === 0 || opraSlices.length === 0 || returnHistory.length < 10) {
      return {
        front,
        opraMatchedExpiryDate: volSummary?.slices[0]?.expirationDate ?? null,
        output: null,
        returnObservationsUsed: returnHistory.length,
        executionPriceBasis: optBasis,
        spot24hArs,
        rates,
        opraSlices,
      };
    }

    const expiryDateKey = front.expirationDate;
    const output = evaluateCrossCurrencyVolTriangle({
      asOfUtcSec: bundle.asOfUtcSec,
      bymaEval: {
        asOfUtcSec: bundle.asOfUtcSec,
        spot24hArs,
        expiryDateKey,
        expiry1530UtcSec: computeExpiration1530ArtUtcSec(expiryDateKey),
        arHolidays: this.arHolidays,
        rateCurve: rates.rateCurveArs,
      },
      bymaOptions,
      opraSlices,
      returnHistory,
      cclReturnHistory,
      minCorrObs: 10,
      minHarObs: 22,
    });

    const targetYears = front.days / 365;
    const matchedSlice =
      volSummary?.slices
        .slice()
        .sort((a, b) => Math.abs(a.timeToExpiryYears - targetYears) - Math.abs(b.timeToExpiryYears - targetYears))[0] ??
      null;

    return {
      front,
      opraMatchedExpiryDate: matchedSlice?.expirationDate ?? null,
      output,
      returnObservationsUsed: returnHistory.length,
      executionPriceBasis: optBasis,
      spot24hArs,
      rates,
      opraSlices,
    };
  }

  public async getVolTriangle(forceRefresh = false): Promise<GgalVolTriangleResponse> {
    const bundle = await this.loadMarketBundle(forceRefresh);
    const core = this.buildVolTriangleCore(bundle);
    const telemetry = this.resolveTelemetryMode(bundle, core.executionPriceBasis);

    const ext = this.evaluateExtrapolatedVolTriangleSmile({
      output: core.output,
      front: core.front,
      spot24hArs: core.spot24hArs,
      rates: core.rates,
      opraSlices: core.opraSlices,
      asOfUtcSec: bundle.asOfUtcSec,
    });

    return {
      telemetry,
      frontExpiryCode: core.front?.expiryCode ?? null,
      frontExpiryDate: core.front?.expirationDate ?? null,
      frontDteCalendar: core.front?.days ?? null,
      opraMatchedExpiryDate: core.opraMatchedExpiryDate,
      result: ext.enrichedOutput !== null ? toJsonSafe(ext.enrichedOutput) : null,
      smileComparison: ext.smileComparison,
      returnObservationsUsed: core.returnObservationsUsed,
      impliedCclVolWingsPct: ext.impliedCclVolWingsPct,
      impliedCclMinFloorPct: ext.impliedCclMinFloorPct,
      atmCompressionPts: ext.atmCompressionPts,
    };
  }

  private buildDualDensityCore(bundle: MarketBundle): {
    readonly front: ArOptionExpiryDto | null;
    readonly cerSource: string | null;
    readonly expectedCerGrowthOverHorizon: number;
    readonly historicalSeries: HistoricalDualObservation[];
    readonly output: DualProbabilityOutput | null;
    readonly executionPriceBasis: ExecutionPriceBasis;
  } {
    const isClosed = bundle.overview.marketState === 'CERRADO';
    const isEodMode =
      bundle.overview.feedStatus === 'EOD_CIERRE' ||
      bundle.usSnapshot?.feedMode === 'EOD_CIERRE' ||
      isClosed;
    const spots = this.resolveSpotQuotes(bundle, isEodMode);
    const rates = this.resolveSofrAndRateBenchmarks(bundle);
    const { front } = selectLiquidFrontAndBackExpiries(bundle.ggalOptions);

    const spotByma24hArs =
      Number.isFinite(spots.byma24hQuote.bid) && Number.isFinite(spots.byma24hQuote.ask)
        ? 0.5 * (spots.byma24hQuote.bid + spots.byma24hQuote.ask)
        : Number.NaN;
    const spotAdrUsd =
      Number.isFinite(spots.adrQuote.bid) && Number.isFinite(spots.adrQuote.ask)
        ? 0.5 * (spots.adrQuote.bid + spots.adrQuote.ask)
        : Number.NaN;

    const arByDate = new Map(bundle.ggalDetail.historicalBars.map((b) => [b.date, b]));
    const adrByDate = new Map<string, { readonly time: number; readonly close: number }>();
    for (const b of bundle.usDailyCloseBars) {
      if (Number.isFinite(b.close) && b.close > 0) {
        adrByDate.set(formatIsoUtcFromSec(b.time).slice(0, 10), { time: b.time, close: b.close });
      }
    }

    // CCL soberano por fecha desde AL30/AL30C y GD30/GD30C para complementar feriados locales
    const al30ByDate = new Map(bundle.al30History.map((p) => [p.date, p.close]));
    const al30cByDate = new Map(bundle.al30cHistory.map((p) => [p.date, p.close]));
    const gd30ByDate = new Map(bundle.gd30History.map((p) => [p.date, p.close]));
    const gd30cByDate = new Map(bundle.gd30cHistory.map((p) => [p.date, p.close]));
    const bondCclByDate = new Map<string, number>();
    for (const date of adrByDate.keys()) {
      const ratios: number[] = [];
      const a = al30ByDate.get(date);
      const ac = al30cByDate.get(date);
      if (a !== undefined && ac !== undefined && a > 0 && ac > 0) {
        ratios.push(a / ac);
      }
      const g = gd30ByDate.get(date);
      const gc = gd30cByDate.get(date);
      if (g !== undefined && gc !== undefined && g > 0 && gc > 0) {
        ratios.push(g / gc);
      }
      if (ratios.length > 0) {
        bondCclByDate.set(date, ratios.reduce((acc, v) => acc + v, 0) / ratios.length);
      }
    }

    // Alinear BCRA CER (exacta o último día hábil publicado <= fecha de barra)
    const cerSorted = bundle.cerHistory;
    const findCerOnOrBefore = (date: string): number | null => {
      let latest: number | null = null;
      for (const c of cerSorted) {
        if (c.date <= date) {
          latest = c.value;
        } else {
          break;
        }
      }
      return latest;
    };

    const historicalSeries: HistoricalDualObservation[] = [];
    for (const date of [...adrByDate.keys()].sort()) {
      const arBar = arByDate.get(date);
      const adrEntry = adrByDate.get(date);
      const cerVal = findCerOnOrBefore(date);
      if (adrEntry === undefined || cerVal === null || adrEntry.close <= 0 || cerVal <= 0) {
        continue;
      }
      const cclVal =
        arBar !== undefined && arBar.close > 0
          ? (GGAL_ADR_RATIO * arBar.close) / adrEntry.close
          : bondCclByDate.get(date);
      if (cclVal === undefined || !Number.isFinite(cclVal) || cclVal <= 0) {
        continue;
      }
      historicalSeries.push({
        time: arBar?.time ?? adrEntry.time,
        adrCloseUsd: adrEntry.close,
        cclGgal: cclVal,
        cerIndex: cerVal,
      });
    }

    let expectedCerGrowth = Number.NaN;
    let cerSource: string | null =
      cerSorted.length > 0 ? `BCRA v4.0 Variable ${String(bundle.cerVarId)} (CER)` : null;
    if (front !== null) {
      const dte = front.days;
      const infM = bundle.macro.variables.inflacionMensualPct;
      if (infM !== null && Number.isFinite(infM) && infM > -99) {
        expectedCerGrowth = Math.pow(1 + infM / 100, dte / 30) - 1;
        cerSource = cerSource ?? 'ArgentinaDatos IPC Mensual';
      } else if (cerSorted.length >= 25) {
        const tail = cerSorted[cerSorted.length - 1];
        const ref = cerSorted[Math.max(0, cerSorted.length - 22)];
        if (tail !== undefined && ref !== undefined && ref.value > 0) {
          const monthlyFactor = tail.value / ref.value;
          expectedCerGrowth = Math.pow(monthlyFactor, dte / 30) - 1;
        }
      }
    }

    if (
      front === null ||
      !Number.isFinite(spotByma24hArs) ||
      spotByma24hArs <= 0 ||
      !Number.isFinite(spotAdrUsd) ||
      spotAdrUsd <= 0 ||
      !Number.isFinite(expectedCerGrowth) ||
      rates.rateCurveArs.length === 0
    ) {
      return {
        front,
        cerSource,
        expectedCerGrowthOverHorizon: expectedCerGrowth,
        historicalSeries,
        output: null,
        executionPriceBasis: spots.basis,
      };
    }

    const bymaEval = computeBymaOptionEvalParams({
      asOfUtcSec: bundle.asOfUtcSec,
      spot24hArs: spotByma24hArs,
      expiryDateKey: front.expirationDate,
      expiry1530UtcSec: computeExpiration1530ArtUtcSec(front.expirationDate),
      arHolidays: this.arHolidays,
      rateCurve: rates.rateCurveArs,
    });

    const bymaNodes: OptionSliceIvNode[] = [];
    const bymaFwdRef = bymaEval?.forwardArs ?? spotByma24hArs;
    for (const strike of front.strikes) {
      const c = front.calls.find((x) => x.strike === strike);
      const p = front.puts.find((x) => x.strike === strike);
      const callIv = c?.iv !== null && c?.iv !== undefined && Number.isFinite(c.iv) && c.iv >= 0.03 && c.iv <= 3.0 ? c.iv : null;
      const putIv = p?.iv !== null && p?.iv !== undefined && Number.isFinite(p.iv) && p.iv >= 0.03 && p.iv <= 3.0 ? p.iv : null;
      const otmIv = strike >= bymaFwdRef ? (callIv ?? putIv) : (putIv ?? callIv);
      if (otmIv !== null) {
        bymaNodes.push({ strike, ivDecimal: otmIv });
      }
    }
    if (bymaNodes.length < 5) {
      bymaNodes.length = 0;
      for (const strike of front.strikes) {
        const c = front.calls.find((x) => x.strike === strike);
        const p = front.puts.find((x) => x.strike === strike);
        const ivs = [c?.iv, p?.iv].filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v) && v > 0.01);
        if (ivs.length > 0) {
          bymaNodes.push({
            strike,
            ivDecimal: ivs.reduce((a, b) => a + b, 0) / ivs.length,
          });
        }
      }
    }

    const slices = bundle.usSnapshot?.volSurfaceSummary?.slices ?? [];
    const targetYears = front.days / 365;
    const matchedSlice =
      slices
        .slice()
        .sort((a, b) => Math.abs(a.timeToExpiryYears - targetYears) - Math.abs(b.timeToExpiryYears - targetYears))[0] ??
      null;

    const opraNodes: OptionSliceIvNode[] = [];
    if (matchedSlice !== null) {
      for (const node of matchedSlice.nodes) {
        if (node.iv !== null && Number.isFinite(node.iv) && node.iv >= 0.03 && node.iv <= 3.0) {
          opraNodes.push({ strike: node.strike, ivDecimal: node.iv });
        }
      }
    }

    let opraForwardPrice = matchedSlice?.forward ?? null;
    let opraTimeToExpiryYears = matchedSlice?.timeToExpiryYears ?? null;
    let opraRiskFreeContinuous = matchedSlice?.rate ?? null;

    if (opraNodes.length < 5) {
      const contracts = bundle.usSnapshot?.volSurfaceSummary?.contracts ?? [];
      const validByExp = new Map<
        string,
        { expiryUtcSec: number; byStrike: Map<number, { calls: number[]; puts: number[] }> }
      >();
      for (const c of contracts) {
        if (c.expiryUtcSec <= bundle.asOfUtcSec) {
          continue;
        }
        const iv = c.ownIv ?? c.providerIv;
        if (iv === null || !Number.isFinite(iv) || iv < 0.03 || iv > 3.0) {
          continue;
        }
        const grp = validByExp.get(c.expirationDate) ?? {
          expiryUtcSec: c.expiryUtcSec,
          byStrike: new Map<number, { calls: number[]; puts: number[] }>(),
        };
        const bucket = grp.byStrike.get(c.strike) ?? { calls: [], puts: [] };
        if (c.contractType === 'call') {
          bucket.calls.push(iv);
        } else {
          bucket.puts.push(iv);
        }
        grp.byStrike.set(c.strike, bucket);
        validByExp.set(c.expirationDate, grp);
      }
      const bestExp = [...validByExp.values()]
        .filter((g) => g.byStrike.size >= 3)
        .sort((a, b) => {
          const tA = Math.max(1 / 365, (a.expiryUtcSec - bundle.asOfUtcSec) / (365 * 86_400));
          const tB = Math.max(1 / 365, (b.expiryUtcSec - bundle.asOfUtcSec) / (365 * 86_400));
          return Math.abs(tA - targetYears) - Math.abs(tB - targetYears);
        })[0];

      if (bestExp !== undefined) {
        opraNodes.length = 0;
        const tYears = Math.max(1 / 365, (bestExp.expiryUtcSec - bundle.asOfUtcSec) / (365 * 86_400));
        const rFree = Number.isFinite(rates.sofrRateAnnual) ? rates.sofrRateAnnual : 0;
        const estForward = spotAdrUsd * Math.exp((rFree - 0.012) * tYears);
        const strikesSorted = [...bestExp.byStrike.keys()].sort((a, b) => a - b);
        for (const k of strikesSorted) {
          const bucket = bestExp.byStrike.get(k);
          if (bucket === undefined) {
            continue;
          }
          const primary = k >= estForward ? bucket.calls : bucket.puts;
          const fallback = k >= estForward ? bucket.puts : bucket.calls;
          const ivArr = primary.length > 0 ? primary : fallback;
          if (ivArr.length > 0) {
            opraNodes.push({
              strike: k,
              ivDecimal: ivArr.reduce((acc, v) => acc + v, 0) / ivArr.length,
            });
          }
        }
        opraTimeToExpiryYears = tYears;
        opraRiskFreeContinuous = rFree;
        opraForwardPrice = estForward;
      }
    }

    if (
      bymaEval === null ||
      bymaNodes.length < 5 ||
      opraForwardPrice === null ||
      opraTimeToExpiryYears === null ||
      opraRiskFreeContinuous === null ||
      opraNodes.length < 3 ||
      historicalSeries.length < 25
    ) {
      return {
        front,
        cerSource,
        expectedCerGrowthOverHorizon: expectedCerGrowth,
        historicalSeries,
        output: null,
        executionPriceBasis: spots.basis,
      };
    }

    const output = evaluateDualProbabilityDensity({
      asOfUtcSec: bundle.asOfUtcSec,
      expiryDate: front.expirationDate,
      dteCalendar: front.days,
      spotByma24hArs,
      spotAdrUsd,
      expectedCerGrowthOverHorizon: expectedCerGrowth,
      historicalSeries,
      bymaMarket: {
        forwardPrice: bymaEval.forwardArs,
        timeToExpiryYears: bymaEval.tExpYears,
        riskFreeContinuous: bymaEval.rEff,
        timeToSettleYears: bymaEval.tSettleYears,
        nodes: bymaNodes,
      },
      opraMarket: {
        forwardPrice: opraForwardPrice,
        timeToExpiryYears: opraTimeToExpiryYears,
        riskFreeContinuous: opraRiskFreeContinuous,
        timeToSettleYears: opraTimeToExpiryYears,
        nodes: opraNodes,
      },
      minHistoricalObs: 25,
    });

    return {
      front,
      cerSource,
      expectedCerGrowthOverHorizon: expectedCerGrowth,
      historicalSeries,
      output,
      executionPriceBasis: spots.basis,
    };
  }

  public async getDualDensity(forceRefresh = false): Promise<GgalDualDensityResponse> {
    const bundle = await this.loadMarketBundle(forceRefresh);
    const core = this.buildDualDensityCore(bundle);
    const telemetry = this.resolveTelemetryMode(bundle, core.executionPriceBasis);

    return {
      telemetry,
      frontExpiryCode: core.front?.expiryCode ?? null,
      frontExpiryDate: core.front?.expirationDate ?? null,
      dteCalendar: core.front?.days ?? null,
      cerSource: core.cerSource,
      expectedCerGrowthOverHorizonPct: Number.isFinite(core.expectedCerGrowthOverHorizon)
        ? sanitizeFinite(core.expectedCerGrowthOverHorizon * 100)
        : null,
      historicalObsUsed: core.historicalSeries.length,
      cerSeriesCount: bundle.cerHistory.length,
      result: core.output !== null ? toJsonSafe(core.output) : null,
    };
  }

  public async getStructurePinning(forceRefresh = false): Promise<GgalStructurePinningResponse> {
    const bundle = await this.loadMarketBundle(forceRefresh);
    const isClosed = bundle.overview.marketState === 'CERRADO';
    const isEodMode =
      bundle.overview.feedStatus === 'EOD_CIERRE' ||
      bundle.usSnapshot?.feedMode === 'EOD_CIERRE' ||
      isClosed;
    const spots = this.resolveSpotQuotes(bundle, isEodMode);
    const rates = this.resolveSofrAndRateBenchmarks(bundle);
    const { front } = selectLiquidFrontAndBackExpiries(bundle.ggalOptions);

    const data912TotalOiFallback: GgalData912OiFallbackItemDto[] = [];
    if (front !== null) {
      for (const strike of front.strikes) {
        const c = front.calls.find((x) => x.strike === strike);
        const p = front.puts.find((x) => x.strike === strike);
        data912TotalOiFallback.push({
          strikeArs: strike,
          callTotalOiNom: c?.openInterest ?? null,
          putTotalOiNom: p?.openInterest ?? null,
          callIvPct: c?.iv !== null && c?.iv !== undefined ? sanitizeFinite(c.iv * 100) : null,
          putIvPct: p?.iv !== null && p?.iv !== undefined ? sanitizeFinite(p.iv * 100) : null,
        });
      }
    }

    const spot24hArs =
      Number.isFinite(spots.byma24hQuote.bid) && Number.isFinite(spots.byma24hQuote.ask)
        ? 0.5 * (spots.byma24hQuote.bid + spots.byma24hQuote.ask)
        : Number.NaN;

    const computeEodPrevSessionFlows = (): {
      readonly bymaNetSignedArs: number;
      readonly adrNetSignedUsd: number;
    } => {
      let bymaNetSignedArs = 0;
      if (front !== null) {
        for (const opt of [...front.calls, ...front.puts]) {
          const vol = opt.volume !== null && Number.isFinite(opt.volume) && opt.volume > 0 ? opt.volume : 0;
          const price =
            opt.last !== null && Number.isFinite(opt.last) && opt.last > 0
              ? opt.last
              : opt.mark !== null && Number.isFinite(opt.mark) && opt.mark > 0
                ? opt.mark
                : 0;
          const varPct =
            opt.changePct !== null && opt.changePct !== undefined && Number.isFinite(opt.changePct)
              ? opt.changePct
              : 0;
          const sign = varPct > 0 ? 1 : varPct < 0 ? -1 : 0;
          if (vol > 0 && price > 0 && sign !== 0) {
            bymaNetSignedArs += vol * price * 100 * sign;
          }
        }
      }

      let adrNetSignedUsd = 0;
      const usBars = bundle.usBars?.bars ?? [];
      const lastBar = usBars.length > 0 ? usBars[usBars.length - 1] : undefined;
      if (lastBar !== undefined) {
        const range = lastBar.high - lastBar.low;
        const vwap =
          lastBar.vw !== null && Number.isFinite(lastBar.vw) && lastBar.vw > 0
            ? lastBar.vw
            : (lastBar.high + lastBar.low + lastBar.close) / 3;
        if (
          Number.isFinite(range) &&
          range > 0 &&
          Number.isFinite(lastBar.volume) &&
          lastBar.volume > 0 &&
          Number.isFinite(vwap) &&
          vwap > 0
        ) {
          adrNetSignedUsd = ((lastBar.close - lastBar.open) / range) * lastBar.volume * vwap;
        }
      }

      return { bymaNetSignedArs, adrNetSignedUsd };
    };

    const applyEodFlowIfClosedZero = (
      out: StructurePinningOutput,
    ): { readonly output: StructurePinningOutput; readonly flowBasis: 'EOD_PREV_SESSION' | 'INTRADAY_SNAPSHOT' } => {
      if (
        isClosed &&
        out.intradayFlow.bymaNetSignedArs === 0 &&
        out.intradayFlow.adrNetSignedUsd === 0
      ) {
        const eod = computeEodPrevSessionFlows();
        return {
          output: {
            ...out,
            intradayFlow: {
              ...out.intradayFlow,
              bymaNetSignedArs: eod.bymaNetSignedArs,
              adrNetSignedUsd: eod.adrNetSignedUsd,
            },
          },
          flowBasis: 'EOD_PREV_SESSION',
        };
      }
      return {
        output: out,
        flowBasis: isClosed ? 'EOD_PREV_SESSION' : 'INTRADAY_SNAPSHOT',
      };
    };

    if (this.anexoBStore === null) {
      let proxyOut: StructurePinningOutput | null = null;
      let flowBasis: 'EOD_PREV_SESSION' | 'INTRADAY_SNAPSHOT' = isClosed
        ? 'EOD_PREV_SESSION'
        : 'INTRADAY_SNAPSHOT';
      if (
        front !== null &&
        Number.isFinite(spot24hArs) &&
        spot24hArs > 0 &&
        rates.rateCurveArs.length > 0 &&
        front.ivAtm !== null &&
        Number.isFinite(front.ivAtm) &&
        front.ivAtm > 0
      ) {
        const proxyStrikes: AnexoBStrikeChainInput[] = [];
        for (const strike of front.strikes) {
          const c = front.calls.find((x) => x.strike === strike);
          const p = front.puts.find((x) => x.strike === strike);
          const rawCallLots = Math.max(0, c?.openInterest ?? c?.volume ?? 0);
          const rawPutLots = Math.max(0, p?.openInterest ?? p?.volume ?? 0);
          const callIv =
            c?.iv !== null && c?.iv !== undefined && Number.isFinite(c.iv) && c.iv > 0
              ? c.iv
              : front.ivAtm;
          const putIv =
            p?.iv !== null && p?.iv !== undefined && Number.isFinite(p.iv) && p.iv > 0
              ? p.iv
              : front.ivAtm;
          if ((rawCallLots > 0 || rawPutLots > 0) && Number.isFinite(callIv) && Number.isFinite(putIv)) {
            proxyStrikes.push({
              strikeArs: strike,
              callOi: { coveredNom: 0, uncoveredNom: rawCallLots * 100, oppositeNom: 0, crossedNom: 0 },
              putOi: { coveredNom: 0, uncoveredNom: rawPutLots * 100, oppositeNom: 0, crossedNom: 0 },
              callIvDecimal: callIv,
              putIvDecimal: putIv,
            });
          }
        }
        if (proxyStrikes.length > 0) {
          const rawProxyOut = evaluateStructureAndPinning({
            asOfUtcSec: bundle.asOfUtcSec,
            anexoBAsOfDate: formatIsoUtcFromSec(bundle.asOfUtcSec).slice(0, 10),
            bymaEval: {
              asOfUtcSec: bundle.asOfUtcSec,
              spot24hArs,
              expiryDateKey: front.expirationDate,
              expiry1530UtcSec: computeExpiration1530ArtUtcSec(front.expirationDate),
              arHolidays: this.arHolidays,
              rateCurve: rates.rateCurveArs,
            },
            atmIvDecimal: front.ivAtm,
            strikes: proxyStrikes,
            weights: DEFAULT_ANEXO_B_WEIGHTS,
            arHolidays: this.arHolidays,
            ...(this.bymaFlowSnapshots.length >= 2 ? { bymaSnapshots: this.bymaFlowSnapshots } : {}),
          });
          const resolved = applyEodFlowIfClosedZero(rawProxyOut);
          proxyOut = resolved.output;
          flowBasis = resolved.flowBasis;
        }
      }
      const telemetry = this.resolveTelemetryMode(bundle, spots.basis);
      return {
        telemetry,
        frontExpiryCode: front?.expiryCode ?? null,
        frontExpiryDate: front?.expirationDate ?? null,
        anexoBSummary: null,
        result: null,
        proxyResult: proxyOut !== null ? toJsonSafe(proxyOut) : null,
        proxySource: proxyOut !== null ? ('PROXY DATA912 (SIN ANEXO B)' as const) : null,
        flowBasis,
        data912TotalOiFallback,
        notice:
          proxyOut !== null
            ? 'Modo PROXY DATA912 (SIN ANEXO B): GEX/Zero-Gamma/Pinning calculados sobre volumen/OI activo de Data912. Ingesta Anexo B IAMC para desglose oficial Cubierta/Descubierta/Opuesta/Cruzada.'
            : 'Sin matriz Anexo B IAMC cargada. Ingresa las columnas Cubierta / Descubierta / Opuesta / Cruzada (en acciones nominales) para activar GEX/Vanna/Charm y Zero-Gamma Brent.',
      };
    }

    if (
      front === null ||
      !Number.isFinite(spot24hArs) ||
      spot24hArs <= 0 ||
      rates.rateCurveArs.length === 0
    ) {
      const telemetry = this.resolveTelemetryMode(bundle, spots.basis);
      return {
        telemetry,
        frontExpiryCode: front?.expiryCode ?? null,
        frontExpiryDate: front?.expirationDate ?? null,
        anexoBSummary: this.anexoBStore.totals,
        result: null,
        proxyResult: null,
        proxySource: null,
        flowBasis: isClosed ? 'EOD_PREV_SESSION' : 'INTRADAY_SNAPSHOT',
        data912TotalOiFallback,
        notice: 'Falta cadena líquida o curva de tasas ARS para evaluar Anexo B contra BS02.',
      };
    }

    const fallbackAtmIv = front.ivAtm ?? 0.45;
    const strikesInput: AnexoBStrikeChainInput[] = [];
    for (const row of this.anexoBStore.rows) {
      const c = front.calls.find((x) => x.strike === row.strikeArs);
      const p = front.puts.find((x) => x.strike === row.strikeArs);
      const callIv = c?.iv !== null && c?.iv !== undefined && Number.isFinite(c.iv) && c.iv > 0 ? c.iv : fallbackAtmIv;
      const putIv = p?.iv !== null && p?.iv !== undefined && Number.isFinite(p.iv) && p.iv > 0 ? p.iv : fallbackAtmIv;
      strikesInput.push({
        strikeArs: row.strikeArs,
        callOi: row.callOi,
        putOi: row.putOi,
        callIvDecimal: callIv,
        putIvDecimal: putIv,
      });
    }

    const rawOut = evaluateStructureAndPinning({
      asOfUtcSec: bundle.asOfUtcSec,
      anexoBAsOfDate: this.anexoBStore.asOfDate,
      bymaEval: {
        asOfUtcSec: bundle.asOfUtcSec,
        spot24hArs,
        expiryDateKey: front.expirationDate,
        expiry1530UtcSec: computeExpiration1530ArtUtcSec(front.expirationDate),
        arHolidays: this.arHolidays,
        rateCurve: rates.rateCurveArs,
      },
      atmIvDecimal: front.ivAtm ?? Number.NaN,
      strikes: strikesInput,
      weights: DEFAULT_ANEXO_B_WEIGHTS,
      arHolidays: this.arHolidays,
      ...(this.bymaFlowSnapshots.length >= 2 ? { bymaSnapshots: this.bymaFlowSnapshots } : {}),
    });
    const resolvedOut = applyEodFlowIfClosedZero(rawOut);
    const out = resolvedOut.output;

    const telemetry = this.resolveTelemetryMode(
      bundle,
      spots.basis,
      undefined,
      out.anexoBLagTradingDays,
    );

    return {
      telemetry,
      frontExpiryCode: front.expiryCode,
      frontExpiryDate: front.expirationDate,
      anexoBSummary: this.anexoBStore.totals,
      result: toJsonSafe(out),
      proxyResult: null,
      proxySource: null,
      flowBasis: resolvedOut.flowBasis,
      data912TotalOiFallback,
      notice: null,
    };
  }

  public async runStrategySelector(
    reqBody: GgalStrategySelectorRequest = {},
    forceRefresh = false,
  ): Promise<GgalStrategySelectorResponse> {
    const bundle = await this.loadMarketBundle(forceRefresh);
    const isClosed = bundle.overview.marketState === 'CERRADO';
    const isEodMode =
      bundle.overview.feedStatus === 'EOD_CIERRE' ||
      bundle.usSnapshot?.feedMode === 'EOD_CIERRE' ||
      isClosed;
    const spots = this.resolveSpotQuotes(bundle, isEodMode);
    const rates = this.resolveSofrAndRateBenchmarks(bundle);
    const { front, back } = selectLiquidFrontAndBackExpiries(bundle.ggalOptions);
    const dual = this.buildDualDensityCore(bundle);

    const feeSchedule: BymaFeeSchedule = {
      ...BYMA_FEE_SCHEDULE,
      ...(reqBody.bymaFeeSchedule ?? {}),
    };
    const usFeeSchedule: UsFeeSchedule = {
      ...DEFAULT_US_FEE_SCHEDULE,
      ...(reqBody.usFeeSchedule ?? {}),
    };

    const spot24hArs =
      Number.isFinite(spots.byma24hQuote.bid) && Number.isFinite(spots.byma24hQuote.ask)
        ? 0.5 * (spots.byma24hQuote.bid + spots.byma24hQuote.ask)
        : Number.NaN;
    const spotAdrUsd =
      Number.isFinite(spots.adrQuote.bid) && Number.isFinite(spots.adrQuote.ask)
        ? 0.5 * (spots.adrQuote.bid + spots.adrQuote.ask)
        : Number.NaN;

    const physicalNodes = dual.output?.simulatedNodes ?? [];
    if (
      front === null ||
      !Number.isFinite(spot24hArs) ||
      spot24hArs <= 0 ||
      !Number.isFinite(spotAdrUsd) ||
      spotAdrUsd <= 0 ||
      physicalNodes.length === 0 ||
      rates.rateCurveArs.length === 0
    ) {
      const telemetry = this.resolveTelemetryMode(bundle, spots.basis);
      return {
        telemetry,
        frontExpiryCode: front?.expiryCode ?? null,
        frontExpiryDate: front?.expirationDate ?? null,
        backExpiryCode: back?.expiryCode ?? null,
        backExpiryDate: back?.expirationDate ?? null,
        feeScheduleUsed: toJsonSafe(feeSchedule),
        physicalNodesCount: physicalNodes.length,
        result: null,
      };
    }

    const anexoOiByStrike = new Map<number, { readonly callNom: number; readonly putNom: number }>();
    if (this.anexoBStore !== null) {
      for (const row of this.anexoBStore.rows) {
        anexoOiByStrike.set(row.strikeArs, {
          callNom:
            row.callOi.coveredNom +
            row.callOi.uncoveredNom +
            row.callOi.oppositeNom +
            row.callOi.crossedNom,
          putNom:
            row.putOi.coveredNom +
            row.putOi.uncoveredNom +
            row.putOi.oppositeNom +
            row.putOi.crossedNom,
        });
      }
    }

    const bymaChain: BymaStrategyOptionQuote[] = [];
    let optBasis: ExecutionPriceBasis = spots.basis;
    const selectedExpiries = back !== null ? [front, back] : [front];
    for (const exp of selectedExpiries) {
      const anexoAppliesToExp =
        this.anexoBStore !== null &&
        exp.expiryCode === front.expiryCode &&
        (this.anexoBStore.expiryCode === null || this.anexoBStore.expiryCode === exp.expiryCode);
      for (const c of [...exp.calls, ...exp.puts]) {
        const built = makeBidAskQuote(c.bid, c.ask, c.mark ?? c.last, isEodMode);
        if (built.basis === 'LIVE_BID_ASK') {
          optBasis = 'LIVE_BID_ASK';
        }
        const baseOi =
          c.openInterest !== null && Number.isFinite(c.openInterest) ? Math.max(0, c.openInterest) : 0;
        const anexoRow = anexoAppliesToExp ? anexoOiByStrike.get(c.strike) : undefined;
        const anexoNom =
          anexoRow !== undefined ? (c.contractType === 'call' ? anexoRow.callNom : anexoRow.putNom) : 0;
        const effectiveOiNom = Math.max(baseOi, anexoNom);
        if (Number.isFinite(built.quote.bid) && Number.isFinite(built.quote.ask) && built.quote.bid > 0) {
          bymaChain.push({
            ticker: c.symbol,
            contractType: c.contractType,
            strikeArs: c.strike,
            expiryDateKey: exp.expirationDate,
            expiry1530UtcSec: computeExpiration1530ArtUtcSec(exp.expirationDate),
            bidArs: built.quote.bid,
            askArs: built.quote.ask,
            openInterestNom: effectiveOiNom,
            ...(c.iv !== null && Number.isFinite(c.iv) && c.iv > 0 ? { ivDecimal: c.iv } : {}),
          });
        }
      }
    }

    const opraChain: OpraStrategyOptionQuote[] = [];
    for (const c of bundle.usSnapshot?.volSurfaceSummary?.contracts ?? []) {
      const built = makeBidAskQuote(c.bid, c.ask, c.mid ?? c.lastPrice, isEodMode);
      const iv = c.ownIv ?? c.providerIv;
      if (Number.isFinite(built.quote.bid) && Number.isFinite(built.quote.ask) && built.quote.bid > 0) {
        opraChain.push({
          ticker: c.ticker,
          contractType: c.contractType,
          strikeUsd: c.strike,
          expiryDateKey: c.expirationDate,
          expiryUtcSec: c.expiryUtcSec,
          bidUsd: built.quote.bid,
          askUsd: built.quote.ask,
          openInterestContracts: c.openInterest !== null && Number.isFinite(c.openInterest) ? Math.max(0, c.openInterest) : 0,
          ...(iv !== null && Number.isFinite(iv) && iv > 0 ? { ivDecimal: iv } : {}),
        });
      }
    }

    const selectorInput: StrategySelectorInput = {
      asOfUtcSec: bundle.asOfUtcSec,
      spotByma24hArs: spot24hArs,
      spotByma24hQuote: spots.byma24hQuote,
      spotAdrUsd,
      spotAdrQuote: spots.adrQuote,
      frontExpiryDateKey: front.expirationDate,
      frontExpiry1530UtcSec: computeExpiration1530ArtUtcSec(front.expirationDate),
      ...(back !== null
        ? {
            backExpiryDateKey: back.expirationDate,
            backExpiry1530UtcSec: computeExpiration1530ArtUtcSec(back.expirationDate),
          }
        : {}),
      arHolidays: this.arHolidays,
      caucion1dTnaPct: rates.caucion1dTnaPct,
      lecapMatchedTnaPct: rates.lecapMatchedTnaPct,
      sofrPct: rates.sofrPct,
      rateCurveArs: rates.rateCurveArs,
      bymaChain,
      opraChain,
      physicalNodes,
      feeSchedule,
      usFeeSchedule,
      filterThresholds: {
        ...(reqBody.minBymaOiNominals !== undefined
          ? { minBymaOiNominals: reqBody.minBymaOiNominals }
          : this.anexoBStore === null || isEodMode
            ? { minBymaOiNominals: 0 }
            : {}),
        ...(reqBody.minOpraOiContracts !== undefined
          ? { minOpraOiContracts: reqBody.minOpraOiContracts }
          : this.anexoBStore === null || isEodMode
            ? { minOpraOiContracts: 0 }
            : {}),
        ...(reqBody.minEvToCostMultiple !== undefined ? { minEvToRoundTripCostMultiple: reqBody.minEvToCostMultiple } : {}),
        enforceThresholds: reqBody.enforceThresholds ?? false,
        maxCandidates: reqBody.maxCandidates ?? 30,
      },
    };

    const rawOut = evaluateStrategySelector(selectorInput);
    const filtered =
      reqBody.familyFilter !== undefined && reqBody.familyFilter !== 'ALL'
        ? {
            ...rawOut,
            rankedStrategies: rawOut.rankedStrategies.filter(
              (s) => s.family === reqBody.familyFilter,
            ),
          }
        : rawOut;

    const telemetry = this.resolveTelemetryMode(bundle, optBasis);
    return {
      telemetry,
      frontExpiryCode: front.expiryCode,
      frontExpiryDate: front.expirationDate,
      backExpiryCode: back?.expiryCode ?? null,
      backExpiryDate: back?.expirationDate ?? null,
      feeScheduleUsed: toJsonSafe(feeSchedule),
      physicalNodesCount: physicalNodes.length,
      result: toJsonSafe(filtered),
    };
  }

  public async getMarginAndRiskReport(
    req: GgalMarginRiskRequest = {},
    forceRefresh = false,
  ): Promise<GgalMarginRiskResponse> {
    const bundle = await this.loadMarketBundle(forceRefresh);
    this.appendRecorderObservation(bundle);

    const strategyKind: BymaClearingStrategyKind = req.strategyKind ?? 'VERTICAL_CREDIT_SPREAD';
    const capitalArs =
      req.capitalArs !== undefined && Number.isFinite(req.capitalArs) && req.capitalArs > 0
        ? req.capitalArs
        : 25_000_000;
    const collateralKind: CollateralAssetKind = req.collateralKind ?? 'CASH_ARS';
    const collateralValueArs =
      req.collateralValueArs !== undefined &&
      Number.isFinite(req.collateralValueArs) &&
      req.collateralValueArs >= 0
        ? req.collateralValueArs
        : 5_000_000;
    const collateralAforo =
      req.collateralAforo !== undefined &&
      Number.isFinite(req.collateralAforo) &&
      req.collateralAforo > 0 &&
      req.collateralAforo <= 1
        ? req.collateralAforo
        : undefined;
    const desiredLots =
      req.desiredLots !== undefined && Number.isFinite(req.desiredLots) && req.desiredLots > 0
        ? Math.round(req.desiredLots)
        : 20;
    const side: OrderSide = req.side ?? 'BUY';

    const isClosed = bundle.overview.marketState === 'CERRADO';
    const isEodMode =
      bundle.overview.feedStatus === 'EOD_CIERRE' ||
      bundle.usSnapshot?.feedMode === 'EOD_CIERRE' ||
      isClosed;
    const spots = this.resolveSpotQuotes(bundle, isEodMode);
    const rates = this.resolveSofrAndRateBenchmarks(bundle);
    const { front } = selectLiquidFrontAndBackExpiries(bundle.ggalOptions);
    const dual = this.buildDualDensityCore(bundle);
    const telemetry = this.resolveTelemetryMode(bundle, spots.basis);

    const spot24hArs =
      Number.isFinite(spots.byma24hQuote.bid) && Number.isFinite(spots.byma24hQuote.ask)
        ? 0.5 * (spots.byma24hQuote.bid + spots.byma24hQuote.ask)
        : Number.NaN;
    const spotAdrUsd =
      Number.isFinite(spots.adrQuote.bid) && Number.isFinite(spots.adrQuote.ask)
        ? 0.5 * (spots.adrQuote.bid + spots.adrQuote.ask)
        : Number.NaN;
    const cclArs =
      Number.isFinite(spot24hArs) &&
      spot24hArs > 0 &&
      Number.isFinite(spotAdrUsd) &&
      spotAdrUsd > 0
        ? (spot24hArs / spotAdrUsd) * GGAL_ADR_RATIO
        : Number.NaN;

    const requestResolved = {
      strategyKind,
      capitalArs,
      collateralKind,
      collateralValueArs,
      collateralAforo: collateralAforo ?? null,
      desiredLots,
      side,
    };

    const recorderBymaTicks = this.recorderSnapshots
      .filter((s) => s.spotByma24hArs !== null && Number.isFinite(s.spotByma24hArs) && s.spotByma24hArs > 0)
      .map((s) => ({ utcSec: s.asOfUtcSec, midPrice: s.spotByma24hArs as number }));
    const recorderAdrTicks = this.recorderSnapshots
      .filter((s) => s.spotAdrUsd !== null && Number.isFinite(s.spotAdrUsd) && s.spotAdrUsd > 0)
      .map((s) => ({ utcSec: s.asOfUtcSec, midPrice: s.spotAdrUsd as number }));
    const underlyingBook = bundle.ggalDetail.orderBook5Levels ?? null;

    const buildOptionMid = (c: ArOptionContractDto): number | null => {
      if (c.bid !== null && c.ask !== null && Number.isFinite(c.bid) && Number.isFinite(c.ask) && c.bid > 0 && c.ask >= c.bid) {
        return 0.5 * (c.bid + c.ask);
      }
      if (c.last !== null && Number.isFinite(c.last) && c.last > 0) return c.last;
      if (c.mark !== null && Number.isFinite(c.mark) && c.mark > 0) return c.mark;
      return null;
    };

    if (
      front === null ||
      !Number.isFinite(spot24hArs) ||
      spot24hArs <= 0 ||
      rates.rateCurveArs.length === 0
    ) {
      return {
        telemetry,
        requestResolved,
        frontExpiryCode: front?.expiryCode ?? null,
        frontExpiryDate: front?.expirationDate ?? null,
        targetOptionSymbol: null,
        targetOptionStrikeArs: null,
        selectedLegs: [],
        executionBookDiagnostics: {
          bookSource: 'NO_DATA',
          underlyingBook5LevelsSource: underlyingBook?.source ?? null,
          optionL1BidSizeLots: null,
          optionL1AskSizeLots: null,
          recorderPairsCount: Math.min(recorderBymaTicks.length, recorderAdrTicks.length),
        },
        marginRisk: null,
        executionMicrostructure: null,
        tailStress: null,
        notice: 'Falta cadena líquida GGAL, spot 24h o curva ARS para evaluar Motor 6.',
      };
    }

    const callsValid = front.calls
      .filter((c) => buildOptionMid(c) !== null && c.iv !== null && Number.isFinite(c.iv) && c.iv > 0)
      .slice()
      .sort((a, b) => a.strike - b.strike);
    const putsValid = front.puts
      .filter((p) => buildOptionMid(p) !== null && p.iv !== null && Number.isFinite(p.iv) && p.iv > 0)
      .slice()
      .sort((a, b) => a.strike - b.strike);

    const toLeg = (c: ArOptionContractDto, legSide: OrderSide, lots: number): BymaMarginLegInput => ({
      ticker: c.symbol,
      contractType: c.contractType,
      side: legSide,
      lots,
      strikeArs: c.strike,
      optionPriceArs: buildOptionMid(c) as number,
      ivDecimal: c.iv as number,
    });

    const nearestIndex = (arr: readonly ArOptionContractDto[], targetStrike: number): number => {
      let bestIdx = 0;
      let bestDist = Infinity;
      arr.forEach((item, idx) => {
        const d = Math.abs(item.strike - targetStrike);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = idx;
        }
      });
      return bestIdx;
    };

    const marginLegs: BymaMarginLegInput[] = [];
    let targetContract: ArOptionContractDto | null = null;
    let underlyingSharesHeld: number | undefined;

    if (callsValid.length > 0 || putsValid.length > 0) {
      const atmCallIdx = callsValid.length > 0 ? nearestIndex(callsValid, spot24hArs) : -1;
      const atmPutIdx = putsValid.length > 0 ? nearestIndex(putsValid, spot24hArs) : -1;
      const cAtm = atmCallIdx >= 0 ? callsValid[atmCallIdx] : undefined;
      const cUpper =
        atmCallIdx >= 0 && atmCallIdx + 1 < callsValid.length
          ? callsValid[atmCallIdx + 1]
          : callsValid[callsValid.length - 1];
      const pAtm = atmPutIdx >= 0 ? putsValid[atmPutIdx] : undefined;
      const pLower =
        atmPutIdx > 0 ? putsValid[atmPutIdx - 1] : putsValid[0];

      switch (strategyKind) {
        case 'UNCOVERED_SHORT': {
          const leg = cUpper ?? cAtm ?? pAtm;
          if (leg) {
            marginLegs.push(toLeg(leg, 'SELL', 10));
            targetContract = leg;
          }
          break;
        }
        case 'VERTICAL_DEBIT_SPREAD': {
          if (cAtm && cUpper && cAtm.symbol !== cUpper.symbol) {
            marginLegs.push(toLeg(cAtm, 'BUY', 10), toLeg(cUpper, 'SELL', 10));
            targetContract = cAtm;
          } else if (cAtm) {
            marginLegs.push(toLeg(cAtm, 'BUY', 10));
            targetContract = cAtm;
          }
          break;
        }
        case 'VERTICAL_CREDIT_SPREAD': {
          if (pAtm && pLower && pAtm.symbol !== pLower.symbol) {
            marginLegs.push(toLeg(pAtm, 'SELL', 10), toLeg(pLower, 'BUY', 10));
            targetContract = pAtm;
          } else if (cAtm && cUpper && cAtm.symbol !== cUpper.symbol) {
            marginLegs.push(toLeg(cAtm, 'SELL', 10), toLeg(cUpper, 'BUY', 10));
            targetContract = cAtm;
          } else {
            const fb = pAtm ?? cAtm;
            if (fb !== undefined) {
              marginLegs.push(toLeg(fb, 'SELL', 10));
              targetContract = fb;
            }
          }
          break;
        }
        case 'RATIO_SPREAD_1X2': {
          if (cAtm && cUpper && cAtm.symbol !== cUpper.symbol) {
            marginLegs.push(toLeg(cAtm, 'BUY', 10), toLeg(cUpper, 'SELL', 20));
            targetContract = cUpper;
          } else if (cAtm) {
            marginLegs.push(toLeg(cAtm, 'SELL', 20));
            targetContract = cAtm;
          }
          break;
        }
        case 'RATIO_SPREAD_1X3': {
          if (cAtm && cUpper && cAtm.symbol !== cUpper.symbol) {
            marginLegs.push(toLeg(cAtm, 'BUY', 10), toLeg(cUpper, 'SELL', 30));
            targetContract = cUpper;
          } else if (cAtm) {
            marginLegs.push(toLeg(cAtm, 'SELL', 30));
            targetContract = cAtm;
          }
          break;
        }
        case 'SHORT_STRADDLE_STRANGLE': {
          const shortCall = cUpper ?? cAtm;
          const shortPut = pLower ?? pAtm;
          if (shortCall) marginLegs.push(toLeg(shortCall, 'SELL', 10));
          if (shortPut) marginLegs.push(toLeg(shortPut, 'SELL', 10));
          targetContract = shortCall ?? shortPut ?? null;
          break;
        }
        case 'COVERED_CALL': {
          const shortCall = cUpper ?? cAtm;
          if (shortCall) {
            marginLegs.push(toLeg(shortCall, 'SELL', 10));
            underlyingSharesHeld = 10 * GGAL_BYMA_LOT_SIZE;
            targetContract = shortCall;
          }
          break;
        }
        case 'CROSS_COLLATERAL_STRATEGY': {
          const shortPut = pLower ?? pAtm;
          const longCall = cUpper ?? cAtm;
          if (shortPut) marginLegs.push(toLeg(shortPut, 'SELL', 12));
          if (longCall) marginLegs.push(toLeg(longCall, 'BUY', 6));
          targetContract = shortPut ?? longCall ?? null;
          break;
        }
      }
    }

    if (marginLegs.length === 0 || targetContract === null) {
      return {
        telemetry,
        requestResolved,
        frontExpiryCode: front.expiryCode,
        frontExpiryDate: front.expirationDate,
        targetOptionSymbol: null,
        targetOptionStrikeArs: null,
        selectedLegs: [],
        executionBookDiagnostics: {
          bookSource: 'NO_DATA',
          underlyingBook5LevelsSource: underlyingBook?.source ?? null,
          optionL1BidSizeLots: null,
          optionL1AskSizeLots: null,
          recorderPairsCount: Math.min(recorderBymaTicks.length, recorderAdrTicks.length),
        },
        marginRisk: null,
        executionMicrostructure: null,
        tailStress: null,
        notice: `Sin contratos líquidos con VI válida en ${front.expiryCode} para armar ${strategyKind}.`,
      };
    }

    const expiry1530UtcSec = computeExpiration1530ArtUtcSec(front.expirationDate);
    const marginOut = evaluateBymaClearingMargin({
      asOfUtcSec: bundle.asOfUtcSec,
      expiryDateKey: front.expirationDate,
      expiry1530UtcSec,
      spot24hArs,
      rateCurveArs: rates.rateCurveArs,
      arHolidays: this.arHolidays,
      strategyKind,
      legs: marginLegs,
      ...(underlyingSharesHeld !== undefined ? { underlyingSharesHeld } : {}),
      collateralAssets: [
        {
          id: collateralKind,
          kind: collateralKind,
          marketValueArs: collateralValueArs,
          ...(collateralAforo !== undefined ? { explicitAforo: collateralAforo } : {}),
          ...(req.collateralDurationYears !== undefined
            ? { modifiedDurationYears: req.collateralDurationYears }
            : {}),
        },
      ],
    });

    // Microestructura L1–L2 real sin fabricar niveles
    const optBid = targetContract.bid ?? Number.NaN;
    const optAsk = targetContract.ask ?? Number.NaN;
    const optLast = targetContract.last ?? buildOptionMid(targetContract) ?? Number.NaN;
    const optBidSize = targetContract.bidSize ?? null;
    const optAskSize = targetContract.askSize ?? null;
    const hasPrimaryUnderlyingL2 =
      underlyingBook !== null &&
      (underlyingBook.source === 'BMB_HOMEBROKER' || underlyingBook.source === 'PRIMARY_MERV');
    const hasOptionL1Sizes =
      optBidSize !== null &&
      optAskSize !== null &&
      Number.isFinite(optBidSize) &&
      Number.isFinite(optAskSize) &&
      optBidSize > 0 &&
      optAskSize > 0 &&
      Number.isFinite(optBid) &&
      Number.isFinite(optAsk) &&
      optBid > 0 &&
      optAsk > optBid;

    const bookSource: BookDepthSource = hasPrimaryUnderlyingL2 && hasOptionL1Sizes
      ? 'PRIMARY_L2'
      : Number.isFinite(optBid) && Number.isFinite(optAsk) && optBid > 0
        ? 'BYMA_L1_ONLY'
        : 'NO_DATA';
    const bidsL1L2: BookLevelInput[] =
      bookSource === 'PRIMARY_L2'
        ? [{ priceArs: optBid, sizeLots: optBidSize as number }]
        : [];
    const asksL1L2: BookLevelInput[] =
      bookSource === 'PRIMARY_L2'
        ? [{ priceArs: optAsk, sizeLots: optAskSize as number }]
        : [];

    const tickSizeArs = Number.isFinite(optBid) && optBid < 100 ? 0.5 : 1.0;
    const targetAnexoRow = this.anexoBStore?.rows.find(
      (r) => Math.abs(r.strikeArs - targetContract.strike) < 1e-6,
    );
    const bucketUncoveredNom =
      targetAnexoRow === undefined
        ? undefined
        : targetContract.contractType === 'call'
          ? targetAnexoRow.callOi.uncoveredNom
          : targetAnexoRow.putOi.uncoveredNom;
    const uncoveredOiLots =
      bucketUncoveredNom !== undefined && bucketUncoveredNom > 0
        ? bucketUncoveredNom / GGAL_BYMA_LOT_SIZE
        : targetContract.openInterest !== null && targetContract.openInterest > 0
          ? targetContract.openInterest
          : Number.NaN;
    const adv20Lots =
      targetContract.volume !== null && Number.isFinite(targetContract.volume) && targetContract.volume > 0
        ? targetContract.volume
        : Number.NaN;

    let lambdaBasePerSec = Number.NaN;
    if (this.bymaFlowSnapshots.length >= 2) {
      const f0 = this.bymaFlowSnapshots[0];
      const fLast = this.bymaFlowSnapshots[this.bymaFlowSnapshots.length - 1];
      if (f0 !== undefined && fLast !== undefined) {
        const dtFlow = fLast.time - f0.time;
        const dShares = fLast.cumVolumeShares - f0.cumVolumeShares;
        if (dtFlow > 0 && dShares >= 0) {
          lambdaBasePerSec = dShares / GGAL_BYMA_LOT_SIZE / dtFlow;
        }
      }
    } else if (!isEodMode && Number.isFinite(adv20Lots) && adv20Lots > 0) {
      // Flujo promedio observado en lo que va de la rueda (~18000s / sesión) solo si hay volumen real
      lambdaBasePerSec = adv20Lots / 18_000;
    }

    const quoteAgeSecRef = telemetry.data912TimestampSec ?? bundle.asOfUtcSec;
    const execOut = evaluateExecutionMicrostructure({
      asOfUtcSec: bundle.asOfUtcSec,
      telemetryMode: telemetry.marketMode,
      side,
      desiredLots,
      quoteAsOfUtcSec: quoteAgeSecRef,
      bidArs: optBid,
      askArs: optAsk,
      lastTradeArs: optLast,
      tickSizeArs,
      depthSource: bookSource,
      bidsL1L2,
      asksL1L2,
      adv20Lots,
      uncoveredOiLots,
      lambdaBasePerSec,
      expectedEdgeArsPerShare:
        Number.isFinite(optAsk) && Number.isFinite(optBid) ? 0.25 * Math.max(0, optAsk - optBid) : Number.NaN,
      optionIvDecimal: targetContract.iv ?? Number.NaN,
      bymaTicks: recorderBymaTicks,
      adrTicks: recorderAdrTicks,
    });

    // Motor 6.3 Stress Test + Jump-Diffusion Overnight + Sizing Kelly-CVaR
    const calibratedOvernight = calibrateOvernightJumpDiffusionFromSeries(dual.historicalSeries);
    const totalLotsInUnit = Math.max(
      1,
      marginLegs.reduce((acc, l) => acc + l.lots, 0),
    );
    const scaleDivisor = Math.max(
      1,
      marginLegs.reduce((acc, l) => Math.min(acc, l.lots), Infinity),
    );
    const bymaLegsPerUnit: BymaMarginLegInput[] = marginLegs.map((l) => ({
      ...l,
      lots: Math.max(1, Math.round(l.lots / scaleDivisor)),
    }));
    const marginPerUnitArs = Number.isFinite(marginOut.totalRequiredWithBuffersArs)
      ? marginOut.totalRequiredWithBuffersArs / Math.max(1, scaleDivisor)
      : Number.NaN;

    let tailStressOut: StressTestMatrixOutput | null = null;
    let tailNotice: string | null = null;
    if (
      calibratedOvernight !== null &&
      Number.isFinite(spotAdrUsd) &&
      spotAdrUsd > 0 &&
      Number.isFinite(cclArs) &&
      cclArs > 0 &&
      Number.isFinite(marginOut.totalEffectiveCollateralArs)
    ) {
      tailStressOut = evaluateTailStressAndSizing({
        asOfUtcSec: bundle.asOfUtcSec,
        expiryDateKey: front.expirationDate,
        expiry1530UtcSec,
        spot24hArs,
        spotAdrUsd,
        cclArs,
        rateCurveArs: rates.rateCurveArs,
        arHolidays: this.arHolidays,
        bymaLegsPerUnit,
        capitalArs,
        totalEffectiveCollateralArs: marginOut.totalEffectiveCollateralArs,
        marginRequiredPerUnitArs: Number.isFinite(marginPerUnitArs) ? marginPerUnitArs : 0,
        collateralAssets: [
          {
            id: collateralKind,
            kind: collateralKind,
            marketValueArs: collateralValueArs,
            ...(collateralAforo !== undefined ? { explicitAforo: collateralAforo } : {}),
            ...(req.collateralDurationYears !== undefined
              ? { modifiedDurationYears: req.collateralDurationYears }
              : {}),
          },
        ],
        overnightParams: calibratedOvernight,
      });
    } else if (calibratedOvernight === null) {
      tailNotice = `Historial ADR/CCL insuficiente (< 15 ruedas, actual=${String(dual.historicalSeries.length)}) para calibrar Jump-Diffusion overnight.`;
    } else if (!Number.isFinite(marginOut.totalEffectiveCollateralArs)) {
      tailNotice = `Falta aforo explícito válido en colateral ${collateralKind} para evaluar solvencia de estrés y sizing Kelly-CVaR.`;
    }

    const totalUnitNotice = [
      marginOut.status === 'NO_DATA' && marginOut.collateralStatus === 'MISSING_EXPLICIT_AFORO'
        ? `Colateral ${collateralKind} requiere aforo explícito (0 < aforo ≤ 1) sin valor de respaldo silencioso.`
        : null,
      execOut.status === 'DEGRADED_L1_ONLY'
        ? `Microestructura L2 degradada (${underlyingBook?.source ?? 'SIN_L2_PRIMARIO'} / sin puntas de tamaño): cota máxima de orden marcada como —.`
        : null,
      tailNotice,
      totalLotsInUnit > 0 ? null : null,
    ]
      .filter((x): x is string => x !== null)
      .join(' ');

    return {
      telemetry,
      requestResolved,
      frontExpiryCode: front.expiryCode,
      frontExpiryDate: front.expirationDate,
      targetOptionSymbol: targetContract.symbol,
      targetOptionStrikeArs: targetContract.strike,
      selectedLegs: marginLegs.map((l) => ({
        ticker: l.ticker,
        contractType: l.contractType,
        side: l.side,
        lots: l.lots,
        strikeArs: l.strikeArs,
        optionPriceArs: l.optionPriceArs,
        ivPct: l.ivDecimal * 100,
      })),
      executionBookDiagnostics: {
        bookSource,
        underlyingBook5LevelsSource: underlyingBook?.source ?? null,
        optionL1BidSizeLots: optBidSize,
        optionL1AskSizeLots: optAskSize,
        recorderPairsCount: Math.min(recorderBymaTicks.length, recorderAdrTicks.length),
      },
      marginRisk: toJsonSafe(marginOut),
      executionMicrostructure: toJsonSafe(execOut),
      tailStress: tailStressOut !== null ? toJsonSafe(tailStressOut) : null,
      notice: totalUnitNotice.length > 0 ? totalUnitNotice : null,
    };
  }

  public async getOverview(forceRefresh = false): Promise<GgalSpecialistOverviewResponse> {
    const bundle = await this.loadMarketBundle(forceRefresh);
    const parity = this.computeParityGapCore(bundle);
    const vol = this.buildVolTriangleCore(bundle);
    const dual = this.buildDualDensityCore(bundle);
    const structure = await this.getStructurePinning(false);
    const strat = await this.runStrategySelector({ maxCandidates: 3, enforceThresholds: false }, false);

    const telemetry = this.resolveTelemetryMode(
      bundle,
      parity.executionPriceBasis,
      parity.output.signal,
      structure.telemetry.anexoBLagTradingDays,
    );

    const strRes = structure.result ?? structure.proxyResult ?? null;

    return {
      telemetry,
      spot: {
        byma24hArs: sanitizeFinite(parity.output.spot.byma24hArs),
        bymaCiArs: sanitizeFinite(parity.output.spot.bymaCiArs),
        adrMidUsd: sanitizeFinite(parity.output.spot.adrMidUsd),
        fairBymaOpenArs: sanitizeFinite(parity.output.spot.fairBymaOpenArs),
        fairAdrUsd: sanitizeFinite(parity.output.spot.fairAdrUsd),
        gapPctVsPrevClose: sanitizeFinite(parity.output.spot.gapPctVsPrevClose),
        cclGgal24h: sanitizeFinite(parity.output.ccl.cclGgal24h),
        cclSovereignBenchmark: sanitizeFinite(parity.output.ccl.cclSovereignBenchmark),
        parityZScore: sanitizeFinite(parity.output.ccl.zScore),
        paritySignal: parity.output.signal,
      },
      volatility: {
        bymaAtmIvPct: vol.output !== null ? sanitizeFinite(vol.output.bymaAtmIvPct) : null,
        opraAdrAtmIvPct: vol.output !== null ? sanitizeFinite(vol.output.opraAdrAtmIvPct) : null,
        impliedCclVolPct: vol.output?.impliedCclVolPct ?? null,
        boundaryRegime: vol.output?.boundaryRegime ?? null,
        anomaliesCount: vol.output?.anomalies.length ?? 0,
      },
      density: {
        status: dual.output !== null ? dual.output.physicalMetricsUsd.status : 'NO_DATA',
        studentTCopulaDof:
          dual.output !== null ? sanitizeFinite(dual.output.physicalMetricsUsd.studentTCopulaDof) : null,
        klBymaPvsQ:
          dual.output !== null ? sanitizeFinite(dual.output.riskNeutralBymaArs.klDivergencePvsQ) : null,
        tailSignal: dual.output !== null ? dual.output.tailDislocationSignal : null,
      },
      structure: {
        regime: strRes?.regime ?? 'NO_DATA',
        zeroGammaLevelArs: strRes?.zeroGammaLevelArs ?? null,
        callWallArs: strRes?.callWallArs ?? null,
        putWallArs: strRes?.putWallArs ?? null,
        peakPinStrikeArs: strRes?.peakPinStrikeArs ?? null,
        bymaNetSignedArs: strRes?.intradayFlow.bymaNetSignedArs ?? null,
        adrNetSignedUsd: strRes?.intradayFlow.adrNetSignedUsd ?? null,
      },
      topStrategies: strat.result?.rankedStrategies ?? [],
    };
  }

  private syncFeedRouterWithBundle(bundle: MarketBundle): ArFeedRouterStatusSnapshot {
    this.triggerAnexoBBgRefresh(false);
    const connHealth =
      typeof this.arRuntime.getConnectorHealth === 'function'
        ? this.arRuntime.getConnectorHealth()
        : null;
    const primaryWsConnected = connHealth?.primaryRofex.wsConnected ?? false;
    const primaryFuturesLive =
      connHealth?.primaryRofex.wsConnected === true && connHealth.primaryRofex.liveDlrCount > 0;
    const rawBook = bundle.ggalDetail.orderBook5Levels ?? null;
    const evaluationUtcSec = Math.floor(this.nowMsFn() / 1_000);
    const endpoints = this.arFeedRouter.getEndpointsConfig();
    const bmbOutOfSession = endpoints.bmbConfigured && !isBymaL2SessionUtcSec(evaluationUtcSec);
    const bmbHealth = bundle.bmbSnapshot?.health ?? connHealth?.bullMarket ?? null;
    const bmbHasL2Levels =
      !bmbOutOfSession &&
      rawBook !== null &&
      rawBook.source === 'BMB_HOMEBROKER' &&
      rawBook.bids.length > 0 &&
      rawBook.asks.length > 0 &&
      bmbHealth?.connected === true;
    const primaryHasL2Levels =
      rawBook !== null &&
      rawBook.source === 'PRIMARY_MERV' &&
      rawBook.bids.length > 0 &&
      rawBook.asks.length > 0 &&
      primaryWsConnected;

    const primaryConfigured = endpoints.matrizWsConfigured;
    const ppiConfigured =
      endpoints.ppiBaseUrl !== null && endpoints.ppiApiKey !== null && endpoints.ppiApiSecret !== null;
    const iolConfigured = connHealth?.iol.configured ?? false;
    const maeConfigured = endpoints.maeBaseUrl !== null && endpoints.maeApiKey !== null;
    const bymaClearingConfigured = endpoints.bymaClearingUrl !== null;

    this.arFeedRouter.updateFromRuntimeTelemetry({
      asOfUtcSec: evaluationUtcSec,
      primaryConfigured,
      primaryConnected: primaryHasL2Levels,
      primaryLastMsgUtcSec:
        rawBook?.source === 'PRIMARY_MERV' ? rawBook.asOfUtcSec : null,
      primaryError: primaryConfigured ? (connHealth?.primaryRofex.lastError ?? null) : null,
      primaryFuturesLive,
      primaryFuturesLastMsgUtcSec: connHealth?.primaryRofex.liveDlrLastUpdateUtcSec ?? null,
      primaryFuturesCount: connHealth?.primaryRofex.liveDlrCount ?? 0,
      primaryEnvironment: connHealth?.primaryRofex.wsEnvironment ?? null,
      bmbConfigured: endpoints.bmbConfigured,
      bmbConnected: bmbHasL2Levels,
      bmbLastMsgUtcSec:
        rawBook?.source === 'BMB_HOMEBROKER' ? rawBook.asOfUtcSec : null,
      bmbError: bmbOutOfSession ? BMB_OUT_OF_SESSION_REASON : (bmbHealth?.error ?? null),
      bmbOutOfSession,
      ppiConfigured,
      ppiHealthy: ppiConfigured && bundle.ggalDetail.stock !== null,
      ppiLastMsgUtcSec: ppiConfigured ? bundle.asOfUtcSec : null,
      ppiError: null,
      iolConfigured,
      iolHealthy: connHealth?.iol.connected ?? false,
      iolLastMsgUtcSec: connHealth?.iol.lastMessageUtcSec ?? null,
      iolError: connHealth?.iol.error ?? null,
      maeConfigured,
      maeHealthy: maeConfigured && bundle.macro.variables.a3500 !== null,
      maeLastMsgUtcSec: maeConfigured ? bundle.asOfUtcSec : null,
      maeError: null,
      bymaClearingConfigured,
      bymaClearingHealthy: bymaClearingConfigured && bundle.ggalOptions.expiries.length > 0,
      bymaClearingLastMsgUtcSec: bymaClearingConfigured ? bundle.asOfUtcSec : null,
      bymaClearingError: null,
      anexoBLoaded: this.anexoBStore !== null,
      anexoBLastMsgUtcSec: this.anexoBStore?.ingestedAtUtcSec ?? null,
      anexoBError: this.anexoBStore === null ? this.anexoBBgLastError : null,
      data912Reachable: bundle.liveStocks.length > 0 || bundle.ggalDetail.stock !== null,
      data912LastMsgUtcSec:
        bundle.liveStocks.length > 0 || bundle.ggalDetail.stock !== null
          ? bundle.asOfUtcSec
          : null,
      data912Error: null,
    });

    return this.arFeedRouter.getStatusSnapshot(evaluationUtcSec);
  }

  private resolveMassiveSpotAndYzVol(bundle: MarketBundle): {
    readonly massiveSpotPrice: number | null;
    readonly massiveSpotSourceMode: 'MASSIVE_NBBO' | 'MASSIVE_BARS' | 'UNAVAILABLE';
    readonly yangZhangAdrVol: number;
  } {
    const snap = bundle.usSnapshot;
    let massiveSpotPrice: number | null = null;
    let massiveSpotSourceMode: 'MASSIVE_NBBO' | 'MASSIVE_BARS' | 'UNAVAILABLE' = 'UNAVAILABLE';

    if (snap !== null) {
      const snapSpot = snap.envelope.snapshot.metrics.spot;
      if (snapSpot !== null && Number.isFinite(snapSpot) && snapSpot > 0) {
        massiveSpotPrice = snapSpot;
        massiveSpotSourceMode =
          snap.quoteMode === 'LIVE_NBBO' ? 'MASSIVE_NBBO' : 'MASSIVE_BARS';
      }
    }

    const rawBars = bundle.usBars?.bars ?? [];
    const sortedBars = rawBars
      .filter(
        (b) =>
          Number.isInteger(b.time) &&
          b.time > 0 &&
          Number.isFinite(b.open) &&
          b.open > 0 &&
          Number.isFinite(b.high) &&
          b.high >= Math.max(b.open, b.close) &&
          Number.isFinite(b.low) &&
          b.low <= Math.min(b.open, b.close) &&
          Number.isFinite(b.close) &&
          b.close > 0,
      )
      .slice()
      .sort((a, b) => a.time - b.time);

    if (massiveSpotPrice === null && sortedBars.length > 0) {
      const lastBar = sortedBars[sortedBars.length - 1];
      if (lastBar !== undefined) {
        massiveSpotPrice = lastBar.close;
        massiveSpotSourceMode = 'MASSIVE_BARS';
      }
    }

    const yzBars = sortedBars.slice(-21).map((b) => ({
      timeSec: b.time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    }));
    const yangZhangAdrVol = computeYangZhangVol(yzBars, 252);

    return {
      massiveSpotPrice,
      massiveSpotSourceMode,
      yangZhangAdrVol,
    };
  }

  private buildVpinTradesFromBundle(bundle: MarketBundle): {
    readonly trades: readonly VpinSignedTradeInput[];
    readonly adv20Shares: number;
  } {
    const hist = bundle.ggalDetail.historicalBars;
    const recent20 = hist.slice(-20);
    let volSum = 0;
    let volCount = 0;
    for (const b of recent20) {
      if (Number.isFinite(b.volume) && b.volume > 0) {
        volSum += b.volume;
        volCount += 1;
      }
    }
    const adv20Shares = volCount > 0 ? volSum / volCount : Number.NaN;

    const rawBook = bundle.ggalDetail.orderBook5Levels ?? null;
    if (rawBook?.source === 'BMB_HOMEBROKER') {
      const bmbTrades = bundle.bmbSnapshot?.tradesBySymbol?.['GGAL'] ?? [];
      return { trades: bmbTradesToVpinInput(bmbTrades), adv20Shares };
    }

    const trades: VpinSignedTradeInput[] = [];
    const sourceBars = bundle.ggalDetail.historicalBars.slice(-60);
    for (const bar of sourceBars) {
      if (!Number.isFinite(bar.close) || bar.close <= 0 || !Number.isFinite(bar.volume) || bar.volume <= 0) {
        continue;
      }
      const range = Math.max(1e-6, bar.high - bar.low);
      const buyRatio = Math.min(1, Math.max(0, (bar.close - bar.low) / range));
      trades.push({
        timeSec: bar.time,
        price: bar.close,
        buyVolume: bar.volume * buyRatio,
        sellVolume: bar.volume * (1 - buyRatio),
      });
    }

    return { trades, adv20Shares };
  }

  private buildIcebergInputFromBmb(
    bundle: MarketBundle,
    ladder: GgalL2LadderState,
  ) {
    if (!ladder.available || ladder.activeProvider !== 'BMB_HOMEBROKER_BRIDGE') {
      this.previousBmbBest = null;
      this.bmbIcebergCache = null;
      return null;
    }
    const bid = ladder.bids.find((level) => level.level === 1);
    const ask = ladder.asks.find((level) => level.level === 1);
    if (bid === undefined || ask === undefined) {
      this.previousBmbBest = null;
      this.bmbIcebergCache = null;
      return null;
    }
    const current = {
      bidPrice: bid.price,
      bidSize: bid.size,
      askPrice: ask.price,
      askSize: ask.size,
    };
    const trades = bundle.bmbSnapshot?.tradesBySymbol?.['GGAL'] ?? [];
    const maxSequence = trades.reduce((max, trade) => Math.max(max, trade.sequence), 0);
    const snapshotKey = [
      bundle.ggalDetail.orderBook5Levels?.asOfUtcSec ?? 'NO_BOOK_TIME',
      maxSequence,
      current.bidPrice,
      current.bidSize,
      current.askPrice,
      current.askSize,
    ].join(':');
    if (this.bmbIcebergCache?.key === snapshotKey) {
      return this.bmbIcebergCache.input;
    }
    const tracked = buildBmbIcebergTrackingResult(this.previousBmbBest, current, trades);
    this.previousBmbBest = { ...current, lastTradeSequence: tracked.lastTradeSequence };
    this.bmbIcebergCache = { key: snapshotKey, input: tracked.input };
    return tracked.input;
  }

  private buildL2MetricsFromBundle(bundle: MarketBundle): {
    readonly routerStatus: ArFeedRouterStatusSnapshot;
    readonly l2Ladder: GgalL2LadderState;
    readonly microstructure: GgalL2MicrostructureMetrics;
  } {
    const routerStatus = this.syncFeedRouterWithBundle(bundle);
    const l2Ladder = this.arFeedRouter.resolveL2LadderState(
      'GGAL',
      bundle.ggalDetail.orderBook5Levels ?? null,
      Math.floor(this.nowMsFn() / 1_000),
    );

    const { trades, adv20Shares } = this.buildVpinTradesFromBundle(bundle);
    const vpinInput =
      Number.isFinite(adv20Shares) && adv20Shares > 0 && trades.length > 0
        ? {
            trades,
            adv20Shares,
            windowBuckets: 50,
            bucketAdvFraction: 0.02,
            historicalVpinDistribution: null,
          }
        : null;

    const microstructure = computeL2Microstructure({
      ladder: l2Ladder,
      decayAlpha: 0.55,
      icebergInput: this.buildIcebergInputFromBmb(bundle, l2Ladder),
      vpinInput,
    });

    return {
      routerStatus,
      l2Ladder,
      microstructure,
    };
  }

  private buildOtmWingCclFromBundle(bundle: MarketBundle) {
    const vol = this.buildVolTriangleCore(bundle);
    const { front } = selectLiquidFrontAndBackExpiries(bundle.ggalOptions);
    const strikes: OtmWingStrikeInput[] = [];

    const bymaAtmIv =
      vol.output !== null && Number.isFinite(vol.output.bymaAtmIvPct)
        ? vol.output.bymaAtmIvPct / 100
        : Number.NaN;
    const usAtmIv =
      vol.output !== null && Number.isFinite(vol.output.opraAdrAtmIvPct)
        ? vol.output.opraAdrAtmIvPct / 100
        : Number.NaN;
    const corrAdrCcl =
      vol.output !== null && Number.isFinite(vol.output.realizedCorrEwma)
        ? vol.output.realizedCorrEwma
        : 0;

    if (front !== null && Number.isFinite(usAtmIv)) {
      const jul26NoStrikeAdj =
        front.expiryCode.toUpperCase().includes('JU') ||
        front.expirationDate.includes('-06-') ||
        front.expirationDate.includes('-07-') ||
        front.expirationDate.includes('-08-');
      for (const c of front.calls) {
        if (
          c.delta !== null &&
          c.iv !== null &&
          Number.isFinite(c.delta) &&
          Number.isFinite(c.iv) &&
          c.iv > 0
        ) {
          strikes.push({
            strikeArs: c.strike,
            side: 'CALL',
            absDelta: Math.abs(c.delta),
            bymaIv: c.iv,
            usWingIv: usAtmIv,
            isJul26DividendNoStrikeAdj: jul26NoStrikeAdj,
          });
        }
      }
      for (const p of front.puts) {
        if (
          p.delta !== null &&
          p.iv !== null &&
          Number.isFinite(p.delta) &&
          Number.isFinite(p.iv) &&
          p.iv > 0
        ) {
          strikes.push({
            strikeArs: p.strike,
            side: 'PUT',
            absDelta: Math.abs(p.delta),
            bymaIv: p.iv,
            usWingIv: usAtmIv,
            isJul26DividendNoStrikeAdj: jul26NoStrikeAdj,
          });
        }
      }
    }

    return extractOtmWingCclImpliedVol({
      bymaAtmIv,
      usAtmIv,
      corrAdrCcl,
      jul26DividendYieldDragAnn: 0.03,
      strikes,
    });
  }

  public async getFeedStatus(forceRefresh = false): Promise<ArFeedRouterStatusSnapshot> {
    const bundle = await this.loadMarketBundle(forceRefresh);
    return this.syncFeedRouterWithBundle(bundle);
  }

  public async getMicrostructure(forceRefresh = false): Promise<{
    readonly routerStatus: ArFeedRouterStatusSnapshot;
    readonly l2Ladder: JsonSafeValue<GgalL2LadderState>;
    readonly microstructure: JsonSafeValue<GgalL2MicrostructureMetrics>;
  }> {
    const bundle = await this.loadMarketBundle(forceRefresh);
    const { routerStatus, l2Ladder, microstructure } = this.buildL2MetricsFromBundle(bundle);
    return {
      routerStatus,
      l2Ladder: toJsonSafe(l2Ladder),
      microstructure: toJsonSafe(microstructure),
    };
  }

  public async getOptionsSurface(forceRefresh = false): Promise<{
    readonly routerStatus: ArFeedRouterStatusSnapshot;
    readonly surface: JsonSafeValue<OratsHybridSurfacePayload>;
    readonly otmWingCclVol: ReturnType<typeof extractOtmWingCclImpliedVol>;
  }> {
    const bundle = await this.loadMarketBundle(forceRefresh);
    const routerStatus = this.syncFeedRouterWithBundle(bundle);
    const { massiveSpotPrice, massiveSpotSourceMode, yangZhangAdrVol } =
      this.resolveMassiveSpotAndYzVol(bundle);

    const surface = await this.oratsClient.fetchHybridSurface({
      ticker: 'GGAL',
      massiveSpotPrice,
      massiveSpotSourceMode,
      yangZhangAdrVol,
      forceRefresh,
    });
    this.oratsLastCall = {
      atUtcSec: Math.floor(this.nowMsFn() / 1_000),
      ok: surface.status === 'OPERATIONAL',
      status: surface.status,
    };
    const otmWingCclVol = this.buildOtmWingCclFromBundle(bundle);

    return {
      routerStatus,
      surface: toJsonSafe(surface),
      otmWingCclVol: toJsonSafe(otmWingCclVol) as ReturnType<typeof extractOtmWingCclImpliedVol>,
    };
  }

  public async getClearingRisk(forceRefresh = false): Promise<{
    readonly routerStatus: ArFeedRouterStatusSnapshot;
    readonly clearingRisk: JsonSafeValue<GgalClearingRiskPayload>;
  }> {
    const bundle = await this.loadMarketBundle(forceRefresh);
    const { routerStatus, microstructure } = this.buildL2MetricsFromBundle(bundle);
    const structure = await this.getStructurePinning(false);
    const otmWingCclVol = this.buildOtmWingCclFromBundle(bundle);

    const strRes = structure.result ?? structure.proxyResult ?? null;
    if (strRes === null) {
      return {
        routerStatus,
        clearingRisk: toJsonSafe({
          status: 'UNAVAILABLE',
          asOfUtcSec: bundle.asOfUtcSec,
          reason: 'NO_STRUCTURE_PINNING_DATA_AVAILABLE',
        } satisfies GgalClearingRiskPayload),
      };
    }

    const spots = this.resolveSpotQuotes(bundle, bundle.overview.marketState === 'CERRADO');
    const spotArs =
      Number.isFinite(spots.byma24hQuote.bid) && Number.isFinite(spots.byma24hQuote.ask)
        ? 0.5 * (spots.byma24hQuote.bid + spots.byma24hQuote.ask)
        : (bundle.ggalDetail.stock?.last ?? Number.NaN);

    const pinStrikeArs = strRes.peakPinStrikeArs ?? Number.NaN;
    const basePin = strRes.maxPinScore ?? Number.NaN;

    const l2PinScore = computeL2WeightedPinScore({
      asOfUtcSec: bundle.asOfUtcSec,
      pinStrikeArs,
      spotArs,
      baseAnexoBPinScore: basePin,
      l2Metrics: microstructure,
    });

    const anexoTotals = this.anexoBStore?.totals ?? null;
    const totalUncoveredContracts =
      anexoTotals !== null
        ? Math.round((anexoTotals.callUncoveredNom + anexoTotals.putUncoveredNom) / 100)
        : 0;
    const totalCoveredContracts =
      anexoTotals !== null
        ? Math.round((anexoTotals.callCoveredNom + anexoTotals.putCoveredNom) / 100)
        : 0;

    const { front } = selectLiquidFrontAndBackExpiries(bundle.ggalOptions);
    const jul26Flag =
      front !== null &&
      (front.expiryCode.toUpperCase().includes('JU') ||
        front.expirationDate.includes('-06-') ||
        front.expirationDate.includes('-07-') ||
        front.expirationDate.includes('-08-'));

    const payload: GgalClearingRiskPayload = {
      status: 'OPERATIONAL',
      asOfUtcSec: bundle.asOfUtcSec,
      anexoBStatus:
        this.anexoBStore === null
          ? 'UNAVAILABLE'
          : structure.telemetry.anexoBLagTradingDays !== null &&
              structure.telemetry.anexoBLagTradingDays > 0
            ? 'CARRY_FORWARD_NO_TRADE'
            : 'FRESH',
      anexoBTradeDate: this.anexoBStore?.asOfDate ?? null,
      jul26DividendNoStrikeAdjFlag: jul26Flag,
      bymaInitialMarginPct: totalUncoveredContracts > 0 ? 18.0 : Number.NaN,
      clearingHaircutPct: totalUncoveredContracts > 0 ? 25.0 : Number.NaN,
      totalUncoveredContracts,
      totalCoveredContracts,
      l2PinScore,
      otmWingCclVol,
      reason: null,
    };

    return {
      routerStatus,
      clearingRisk: toJsonSafe(payload),
    };
  }

  public async getRegime2027(forceRefresh = false): Promise<{
    readonly routerStatus: ArFeedRouterStatusSnapshot;
    readonly regime: JsonSafeValue<GgalElectoralRegimeState>;
  }> {
    const bundle = await this.loadMarketBundle(forceRefresh);
    const routerStatus = this.syncFeedRouterWithBundle(bundle);
    const { yangZhangAdrVol } = this.resolveMassiveSpotAndYzVol(bundle);

    const rofxContracts = bundle.macro.rofxFutures ?? [];
    const dlrCurve: DlrCurvePointInput[] = rofxContracts
      .filter(
        (c): c is typeof c & { readonly days: number; readonly price: number } =>
          c.days !== null &&
          Number.isFinite(c.days) &&
          c.days > 0 &&
          c.price !== null &&
          c.price > 0,
      )
      .map((c) => ({
        maturityLabel: c.contract,
        daysToMaturity: c.days,
        priceArs: c.price,
        isElectoralWindow: c.contract.includes('27') || c.days >= 120,
      }));
    const dlrKinkDetail = computeDlrForwardKink(dlrCurve);

    const bankTickers = ['GGAL', 'BMA', 'BBAR', 'SUPV'] as const;
    const bankBarResults = await Promise.all(
      bankTickers.map((tk) =>
        this.runtime
          .getBars(tk, '5m', { visibleBars: 120, forceRefresh })
          .catch(() => null),
      ),
    );

    const toTicks = (res: TerminalBarsResponse | null): readonly AsyncPriceTick[] => {
      if (res === null) {
        return [];
      }
      return res.bars
        .filter((b) => Number.isInteger(b.time) && b.time > 0 && Number.isFinite(b.close) && b.close > 0)
        .map((b) => ({ timeSec: b.time, price: b.close }));
    };

    const ggalTicks = toTicks(bankBarResults[0] ?? bundle.usBars);
    const leadLagDetail = computeHayashiYoshidaLeadLag({
      GGAL: ggalTicks,
      BMA: toTicks(bankBarResults[1] ?? null),
      BBAR: toTicks(bankBarResults[2] ?? null),
      SUPV: toTicks(bankBarResults[3] ?? null),
    });

    const vol = this.buildVolTriangleCore(bundle);
    const otmWing = this.buildOtmWingCclFromBundle(bundle);
    const parity = this.computeParityGapCore(bundle);

    // 25-delta skew from front BYMA or ORATS surface if configured
    const { front } = selectLiquidFrontAndBackExpiries(bundle.ggalOptions);
    let ggal25DeltaSkew = Number.NaN;
    if (front !== null) {
      const put25 = front.puts.find(
        (p) => p.delta !== null && p.iv !== null && Math.abs(Math.abs(p.delta) - 0.25) <= 0.08,
      );
      const call25 = front.calls.find(
        (c) => c.delta !== null && c.iv !== null && Math.abs(Math.abs(c.delta) - 0.25) <= 0.08,
      );
      if (put25?.iv !== null && put25?.iv !== undefined && call25?.iv !== null && call25?.iv !== undefined) {
        ggal25DeltaSkew = put25.iv - call25.iv;
      }
    }

    // Sovereign NY vs ARG legislation spread (%) from monitoring bonds (GD30 vs AL30 parity/TIR or CCL)
    const al30 = bundle.monitoring.bonds.find((b) => b.ticker === 'AL30');
    const gd30 = bundle.monitoring.bonds.find((b) => b.ticker === 'GD30');
    let sovereignLegislationSpreadPct = Number.NaN;
    if (
      al30?.parityPct !== null &&
      al30?.parityPct !== undefined &&
      gd30?.parityPct !== null &&
      gd30?.parityPct !== undefined &&
      al30.parityPct > 0
    ) {
      sovereignLegislationSpreadPct = Math.abs(gd30.parityPct - al30.parityPct);
    } else if (
      Number.isFinite(parity.output.ccl.cclAl30_24h) &&
      Number.isFinite(parity.output.ccl.cclGd30_24h) &&
      parity.output.ccl.cclAl30_24h > 0
    ) {
      sovereignLegislationSpreadPct =
        (Math.abs(parity.output.ccl.cclGd30_24h - parity.output.ccl.cclAl30_24h) /
          parity.output.ccl.cclAl30_24h) *
        100;
    }

    const bankBasketIv30ExErn =
      vol.output !== null && Number.isFinite(vol.output.opraAdrAtmIvPct)
        ? vol.output.opraAdrAtmIvPct / 100
        : otmWing.status === 'OPERATIONAL'
          ? otmWing.extractedCclImplVol
          : Number.NaN;

    const observables: GgalElectoralObservables | null =
      dlrKinkDetail.available &&
      leadLagDetail.available &&
      Number.isFinite(bankBasketIv30ExErn) &&
      Number.isFinite(ggal25DeltaSkew) &&
      Number.isFinite(sovereignLegislationSpreadPct)
        ? {
            bankBasketIv30ExErn,
            ggal25DeltaSkew,
            sovereignLegislationSpreadPct,
            dlrElectoralForwardKink: dlrKinkDetail.maxSecondDifferencePct,
            crossBankLeadLagLeader: leadLagDetail.leader,
            crossBankLeadLagIntensity: Math.abs(leadLagDetail.leaderAverageLeadScore),
          }
        : null;

    const regimeState = updateElectoralMarkovRegime({
      asOfUtcSec: bundle.asOfUtcSec,
      priorProbabilities: this.regimePriorProbabilities,
      observables,
      dlrKinkDetail,
      leadLagDetail,
      yangZhangVol20d: yangZhangAdrVol,
      customTransitionMatrix: null,
    });

    if (regimeState.status === 'OPERATIONAL') {
      this.regimePriorProbabilities = regimeState.posteriorProbabilities;
    }

    return {
      routerStatus,
      regime: toJsonSafe(regimeState),
    };
  }

  private buildStandaloneFastRouterStatus(
    asOfUtcSec: number,
    liveStocksCount: number,
  ): { readonly routerStatus: ArFeedRouterStatusSnapshot; readonly l2Ladder: GgalL2LadderState } {
    this.triggerAnexoBBgRefresh(false);
    const endpoints = this.arFeedRouter.getEndpointsConfig();
    const ppiConfigured =
      endpoints.ppiBaseUrl !== null && endpoints.ppiApiKey !== null && endpoints.ppiApiSecret !== null;
    const iolConfigured = typeof this.arRuntime.getConnectorHealth === 'function'
      ? this.arRuntime.getConnectorHealth().iol.configured
      : false;
    const maeConfigured = endpoints.maeBaseUrl !== null && endpoints.maeApiKey !== null;
    const bymaClearingConfigured = endpoints.bymaClearingUrl !== null;
    const bmbOutOfSession = endpoints.bmbConfigured && !isBymaL2SessionUtcSec(asOfUtcSec);
    const connectorHealth = typeof this.arRuntime.getConnectorHealth === 'function'
      ? this.arRuntime.getConnectorHealth()
      : null;
    const bmbHealth = connectorHealth?.bullMarket ?? null;
    const primaryFuturesLive =
      connectorHealth?.primaryRofex.wsConnected === true && connectorHealth.primaryRofex.liveDlrCount > 0;

    this.arFeedRouter.updateFromRuntimeTelemetry({
      asOfUtcSec,
      primaryConfigured: endpoints.matrizWsConfigured,
      primaryConnected: false,
      primaryLastMsgUtcSec: null,
      primaryError: null,
      primaryFuturesLive,
      primaryFuturesLastMsgUtcSec: connectorHealth?.primaryRofex.liveDlrLastUpdateUtcSec ?? null,
      primaryFuturesCount: connectorHealth?.primaryRofex.liveDlrCount ?? 0,
      primaryEnvironment: connectorHealth?.primaryRofex.wsEnvironment ?? null,
      bmbConfigured: endpoints.bmbConfigured,
      bmbConnected: false,
      bmbLastMsgUtcSec: null,
      bmbError: bmbOutOfSession ? BMB_OUT_OF_SESSION_REASON : (bmbHealth?.error ?? 'AWAITING_BMB_L2_SNAPSHOT'),
      bmbOutOfSession,
      ppiConfigured,
      ppiHealthy: false,
      ppiLastMsgUtcSec: null,
      ppiError: null,
      iolConfigured,
      iolHealthy: connectorHealth?.iol.connected ?? false,
      iolLastMsgUtcSec: connectorHealth?.iol.lastMessageUtcSec ?? null,
      iolError: connectorHealth?.iol.error ?? null,
      maeConfigured,
      maeHealthy: false,
      maeLastMsgUtcSec: null,
      maeError: null,
      bymaClearingConfigured,
      bymaClearingHealthy: false,
      bymaClearingLastMsgUtcSec: null,
      bymaClearingError: null,
      anexoBLoaded: this.anexoBStore !== null,
      anexoBLastMsgUtcSec: this.anexoBStore?.ingestedAtUtcSec ?? null,
      anexoBError: this.anexoBStore === null ? this.anexoBBgLastError : null,
      data912Reachable: liveStocksCount > 0,
      data912LastMsgUtcSec: liveStocksCount > 0 ? asOfUtcSec : null,
      data912Error: null,
    });

    return {
      routerStatus: this.arFeedRouter.getStatusSnapshot(asOfUtcSec),
      l2Ladder: this.arFeedRouter.resolveL2LadderState('GGAL', null, asOfUtcSec),
    };
  }

  public async getDualChart(opts: {
    readonly coordMode: GgalDualChartCoordMode;
    readonly timeframe: GgalDualChartTimeframe;
    readonly avwapAnchor: GgalAvwapAnchorMode;
    readonly forceRefresh: boolean;
  }): Promise<{
    readonly routerStatus: ArFeedRouterStatusSnapshot;
    readonly dualChart: JsonSafeValue<GgalDualChartPayload>;
  }> {
    const runtimeTf =
      opts.timeframe === '1H' ? '1h' : opts.timeframe === '4H' ? '4h' : opts.timeframe;
    const peerTimeout = <T>(p: Promise<T>, ms = 2_500): Promise<T | null> =>
      this.isMockFetch
        ? p.catch(() => null)
        : Promise.race<T | null>([
            p.catch(() => null),
            new Promise<null>((resolve) => {
              const t = setTimeout(() => {
                resolve(null);
              }, ms);
              t.unref();
            }),
          ]);

    const nowMs = this.nowMsFn();
    const hasWarmBundle =
      !opts.forceRefresh &&
      this.bundleCache !== null &&
      nowMs - this.bundleCache.fetchedAtMs < HISTORY_CACHE_TTL_MS;

    if (hasWarmBundle && this.bundleCache !== null && nowMs - this.bundleCache.fetchedAtMs >= this.cacheTtlMs) {
      // Stale-while-revalidate en segundo plano para mantener respuestas < 50 ms
      void this.loadMarketBundle(false).catch(() => undefined);
    }

    let bundleRacePromise: Promise<MarketBundle | null>;
    if (this.bundleCache !== null && !opts.forceRefresh) {
      if (!hasWarmBundle) {
        void this.loadMarketBundle(false).catch(() => undefined);
      }
      bundleRacePromise = Promise.resolve(this.bundleCache.value);
    } else if (this.isMockFetch) {
      bundleRacePromise = this.loadMarketBundle(opts.forceRefresh);
    } else if (!opts.forceRefresh && this.bundleInFlight !== null) {
      // Warmup ya corriendo en segundo plano: no bloquear cada cambio de timeframe
      bundleRacePromise = Promise.resolve(null);
    } else {
      const bgPromise = this.loadMarketBundle(opts.forceRefresh);
      bgPromise.catch(() => undefined);
      bundleRacePromise = Promise.race<MarketBundle | null>([
        bgPromise,
        new Promise<null>((resolve) => {
          const timer = setTimeout(() => {
            resolve(null);
          }, 1_000);
          timer.unref();
        }),
      ]);
    }

    const [
      racedBundle,
      bymaFullDailyBars,
      adrBarsRes,
      adrDailyRes,
      bmaBarsRes,
      bbarBarsRes,
      supvBarsRes,
    ] = await Promise.all([
      bundleRacePromise,
      this.loadFullBymaGgalHistory(opts.forceRefresh),
      this.runtime
        .getBars('GGAL', runtimeTf, { visibleBars: DUAL_CHART_TARGET_BARS, forceRefresh: opts.forceRefresh })
        .catch(() => null),
      opts.timeframe === '1D'
        ? Promise.resolve(null)
        : this.runtime
            .getBars('GGAL', '1D', { visibleBars: DUAL_CHART_TARGET_BARS, forceRefresh: false })
            .catch(() => null),
      peerTimeout(
        this.runtime.getBars('BMA', runtimeTf, {
          visibleBars: DUAL_CHART_TARGET_BARS,
          forceRefresh: false,
        }),
      ),
      peerTimeout(
        this.runtime.getBars('BBAR', runtimeTf, {
          visibleBars: DUAL_CHART_TARGET_BARS,
          forceRefresh: false,
        }),
      ),
      peerTimeout(
        this.runtime.getBars('SUPV', runtimeTf, {
          visibleBars: DUAL_CHART_TARGET_BARS,
          forceRefresh: false,
        }),
      ),
    ]);

    let bundle = racedBundle;
    let fastLiveStocks: readonly Data912RawRow[] = [];
    let fastLiveBonds: readonly Data912RawRow[] = [];
    let fastUsSnap: TerminalSnapshotResponse | null = null;
    if (bundle === null) {
      const fastQuotesValid =
        !opts.forceRefresh &&
        !this.isMockFetch &&
        this.fastQuotesCache !== null &&
        this.nowMsFn() - this.fastQuotesCache.fetchedAtMs < 15_000;
      const [quotesPair, snapFast] = await Promise.all([
        fastQuotesValid && this.fastQuotesCache !== null
          ? Promise.resolve(this.fastQuotesCache.value)
          : Promise.all([
              this.fetchJsonSafe(`${this.data912BaseUrl}/live/arg_stocks`),
              this.fetchJsonSafe(`${this.data912BaseUrl}/live/arg_bonds`),
            ]).then(([stocksFast, bondsFast]) => {
              const pair = {
                stocks: stocksFast.ok ? this.parseData912Rows(stocksFast.data) : [],
                bonds: bondsFast.ok ? this.parseData912Rows(bondsFast.data) : [],
              };
              if (!this.isMockFetch && (pair.stocks.length > 0 || pair.bonds.length > 0)) {
                this.fastQuotesCache = { fetchedAtMs: this.nowMsFn(), value: pair };
              }
              return pair;
            }),
        this.runtime.getSnapshot('GGAL', undefined).catch(() => null),
      ]);
      fastLiveStocks = quotesPair.stocks;
      fastLiveBonds = quotesPair.bonds;
      fastUsSnap = snapFast;
      // Si cache llegó mientras buscábamos fast data, úsala directamente
      if (this.bundleCache !== null) {
        bundle = this.bundleCache.value;
      }
    }

    const asOfUtcSec = bundle?.asOfUtcSec ?? Math.floor(this.nowMsFn() / 1_000);
    const l2AndRouter =
      bundle !== null
        ? this.buildL2MetricsFromBundle(bundle)
        : this.buildStandaloneFastRouterStatus(asOfUtcSec, fastLiveStocks.length);
    const { routerStatus, l2Ladder } = l2AndRouter;
    const structure =
      bundle !== null ? await this.getStructurePinning(false).catch(() => null) : null;

    const adrRawBars = adrBarsRes?.bars ?? bundle?.usBars?.bars ?? [];
    const bymaDetailBars: readonly GgalChartBarPoint[] = (bundle?.ggalDetail.historicalBars ?? []).map(
      (b) => ({
        timeSec: b.time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      }),
    );
    const bymaEffectiveDailyBars =
      bymaFullDailyBars.length >= bymaDetailBars.length ? bymaFullDailyBars : bymaDetailBars;
    const bymaLegacyRawBars = bymaEffectiveDailyBars.map((b) => ({
      time: b.timeSec,
      date: formatIsoUtcFromSec(b.timeSec).slice(0, 10),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    }));

    const parity = bundle !== null ? this.computeParityGapCore(bundle) : null;
    const adrLastUsdFromFast =
      fastUsSnap?.envelope.snapshot.metrics.spot ??
      adrRawBars[adrRawBars.length - 1]?.close ??
      Number.NaN;
    const adrLastUsd =
      parity !== null &&
      Number.isFinite(parity.output.spot.adrMidUsd) &&
      parity.output.spot.adrMidUsd > 0
        ? parity.output.spot.adrMidUsd
        : adrLastUsdFromFast;

    const ggalLiveFast = fastLiveStocks.find((r) => r.symbol === 'GGAL');
    const bymaLastFast =
      ggalLiveFast?.last ??
      bymaEffectiveDailyBars[bymaEffectiveDailyBars.length - 1]?.close ??
      Number.NaN;
    const fastGgalCcl =
      Number.isFinite(bymaLastFast) && bymaLastFast > 0 && Number.isFinite(adrLastUsd) && adrLastUsd > 0
        ? (bymaLastFast * GGAL_ADR_RATIO) / adrLastUsd
        : Number.NaN;
    const fastAl30 = fastLiveBonds.find((r) => r.symbol === 'AL30')?.last;
    const fastAl30c = fastLiveBonds.find((r) => r.symbol === 'AL30C')?.last;
    const fastBondCcl =
      fastAl30 !== undefined &&
      fastAl30 !== null &&
      fastAl30c !== undefined &&
      fastAl30c !== null &&
      fastAl30 > 0 &&
      fastAl30c > 0
        ? fastAl30 / fastAl30c
        : Number.NaN;

    const cclRate =
      parity !== null &&
      Number.isFinite(parity.output.ccl.cclGgal24h) &&
      parity.output.ccl.cclGgal24h > 0
        ? parity.output.ccl.cclGgal24h
        : (bundle?.macro.variables.ccl ??
          (Number.isFinite(fastGgalCcl) ? fastGgalCcl : fastBondCcl));

    // Construir mapa histórico CCL diario por fecha YYYY-MM-DD para escalado fiel intradiario ARS
    const adrDailyBars = opts.timeframe === '1D' ? adrRawBars : (adrDailyRes?.bars ?? bundle?.usBars?.bars ?? []);
    const adrCloseByDate = new Map<string, number>();
    for (const ab of adrDailyBars) {
      if (Number.isFinite(ab.close) && ab.close > 0) {
        adrCloseByDate.set(formatIsoUtcFromSec(ab.time).slice(0, 10), ab.close);
      }
    }
    const cclByDate = new Map<string, number>();
    let lastBymaDateKey = '';
    for (const bb of bymaEffectiveDailyBars) {
      const dateKey = formatIsoUtcFromSec(bb.timeSec).slice(0, 10);
      if (dateKey > lastBymaDateKey) {
        lastBymaDateKey = dateKey;
      }
      const adrClose = adrCloseByDate.get(dateKey);
      if (adrClose !== undefined && adrClose > 0 && bb.close > 0) {
        cclByDate.set(dateKey, (bb.close * GGAL_ADR_RATIO) / adrClose);
      }
    }

    const convertedBars: GgalChartBarPoint[] = [];
    if (opts.coordMode === 'ARS_BYMA') {
      if (opts.timeframe === '1D' && bymaEffectiveDailyBars.length > 0) {
        for (const b of bymaEffectiveDailyBars) {
          const bar = convertOhlcBarToCoord(b, null, 'ARS_BYMA');
          if (bar !== null) {
            convertedBars.push(bar);
          }
        }
      } else if (adrRawBars.length > 0 && Number.isFinite(cclRate) && cclRate > 0) {
        for (const b of adrRawBars) {
          const dateKey = formatIsoUtcFromSec(b.time).slice(0, 10);
          const effectiveCcl =
            dateKey <= lastBymaDateKey ? (cclByDate.get(dateKey) ?? cclRate) : cclRate;
          const factor = effectiveCcl / GGAL_ADR_RATIO;
          convertedBars.push({
            timeSec: b.time,
            open: b.open * factor,
            high: b.high * factor,
            low: b.low * factor,
            close: b.close * factor,
            volume: b.volume * GGAL_ADR_RATIO,
          });
        }
      }
    } else if (opts.coordMode === 'USD_ADR_NASDAQ') {
      for (const b of adrRawBars) {
        const bar = convertOhlcBarToCoord(
          null,
          { timeSec: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume },
          'USD_ADR_NASDAQ',
        );
        if (bar !== null) {
          convertedBars.push(bar);
        }
      }
    } else {
      // RATIO_CCL: alinear barras diarias BYMA + ADR por fecha UTC
      const adrByDate = new Map<string, GgalChartBarPoint>();
      const sourceAdrForRatio = opts.timeframe === '1D' ? adrRawBars : (adrDailyBars.length > 0 ? adrDailyBars : adrRawBars);
      for (const b of sourceAdrForRatio) {
        const dateKey = formatIsoUtcFromSec(b.time).slice(0, 10);
        adrByDate.set(dateKey, {
          timeSec: b.time,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          volume: b.volume,
        });
      }
      for (const b of bymaEffectiveDailyBars) {
        const dateKey = formatIsoUtcFromSec(b.timeSec).slice(0, 10);
        const adrMatch = adrByDate.get(dateKey) ?? null;
        const bar = convertOhlcBarToCoord(b, adrMatch, 'RATIO_CCL');
        if (bar !== null) {
          convertedBars.push(bar);
        }
      }
    }

    convertedBars.sort((a, b) => a.timeSec - b.timeSec);

    if (convertedBars.length === 0) {
      const convertedLadder = this.convertLadderToCoord(
        l2Ladder,
        opts.coordMode,
        cclRate,
        adrLastUsd,
      );
      return {
        routerStatus,
        dualChart: toJsonSafe({
          status: 'UNAVAILABLE',
          asOfUtcSec,
          coordMode: opts.coordMode,
          timeframe: opts.timeframe,
          avwapAnchor: opts.avwapAnchor,
          reason: `NO_ALIGNED_BARS_FOR_${opts.coordMode}_${opts.timeframe}`,
          l2Ladder: convertedLadder,
        } satisfies GgalDualChartPayload),
      };
    }

    const ema9 = computeEmaSeries(convertedBars, 9);
    const ema21 = computeEmaSeries(convertedBars, 21);
    const ema50 = computeEmaSeries(convertedBars, 50);
    const ema200 = computeEmaSeries(convertedBars, 200);

    // Resolver ancla AVWAP consciente del horizonte temporal
    let anchorIdx = 0;
    const lastBar = convertedBars[convertedBars.length - 1];
    if (lastBar !== undefined) {
      if (opts.avwapAnchor === 'MONTH_START') {
        const lastMonth = formatIsoUtcFromSec(lastBar.timeSec).slice(0, 7);
        const found = convertedBars.findIndex(
          (b) => formatIsoUtcFromSec(b.timeSec).slice(0, 7) === lastMonth,
        );
        anchorIdx = found >= 0 ? found : 0;
      } else if (opts.avwapAnchor === 'LAST_BIMONTHLY_EXPIRY') {
        const targetSec = lastBar.timeSec - 45 * 86_400;
        const found = convertedBars.findIndex((b) => b.timeSec >= targetSec);
        anchorIdx = found >= 0 ? found : 0;
      } else if (opts.avwapAnchor === 'LAST_EARNINGS') {
        const targetSec = lastBar.timeSec - 90 * 86_400;
        const found = convertedBars.findIndex((b) => b.timeSec >= targetSec);
        anchorIdx = found >= 0 ? found : 0;
      } else {
        // ELECTORAL_GAP: mayor gap overnight |open - prev.close| / prev.close
        let maxGap = -1;
        for (let i = 1; i < convertedBars.length; i += 1) {
          const prev = convertedBars[i - 1];
          const curr = convertedBars[i];
          if (prev !== undefined && curr !== undefined && prev.close > 0) {
            const gap = Math.abs(curr.open - prev.close) / prev.close;
            if (gap > maxGap) {
              maxGap = gap;
              anchorIdx = i;
            }
          }
        }
      }
    }

    const avwapAnchorUtcSec =
      convertedBars[anchorIdx]?.timeSec ?? convertedBars[0]?.timeSec ?? asOfUtcSec;
    const avwapBands = computeAnchoredVwapSeries(convertedBars, avwapAnchorUtcSec);

    const marketTz = opts.coordMode === 'USD_ADR_NASDAQ' ? US_MARKET_TZ : BYMA_MARKET_TZ;
    const volumeProfile = computeVolumeProfile(convertedBars, 32, marketTz);
    const zones = this.detectUnmitigatedZones(convertedBars);

    const strRes = structure?.result ?? structure?.proxyResult ?? null;
    const callWall = convertArsPriceToCoord(
      strRes?.callWallArs ?? Number.NaN,
      opts.coordMode,
      cclRate,
      adrLastUsd,
    );
    const putWall = convertArsPriceToCoord(
      strRes?.putWallArs ?? Number.NaN,
      opts.coordMode,
      cclRate,
      adrLastUsd,
    );
    const zeroGamma = convertArsPriceToCoord(
      strRes?.zeroGammaLevelArs ?? Number.NaN,
      opts.coordMode,
      cclRate,
      adrLastUsd,
    );
    const maxPain = convertArsPriceToCoord(
      strRes?.peakPinStrikeArs ?? Number.NaN,
      opts.coordMode,
      cclRate,
      adrLastUsd,
    );

    const spotPrice = lastBar?.close ?? Number.NaN;
    const frontExpiry =
      bundle !== null ? selectLiquidFrontAndBackExpiries(bundle.ggalOptions).front : null;
    const volTriangle = bundle !== null ? this.buildVolTriangleCore(bundle) : null;
    // Sin IV ATM real no se dibuja un cono: nada de volatilidades de respaldo.
    const atmIvDec =
      volTriangle?.output !== null &&
      volTriangle?.output !== undefined &&
      Number.isFinite(volTriangle.output.bymaAtmIvPct) &&
      volTriangle.output.bymaAtmIvPct > 0
        ? volTriangle.output.bymaAtmIvPct / 100
        : frontExpiry?.ivAtm !== null &&
            frontExpiry?.ivAtm !== undefined &&
            Number.isFinite(frontExpiry.ivAtm) &&
            frontExpiry.ivAtm > 0
          ? frontExpiry.ivAtm
          : Number.NaN;
    // Cono al vencimiento activo: sin expiry real no se dibuja un cono sintético.
    const expiryUtcSec = frontExpiry?.expiryUtcSec ?? Number.NaN;
    const expectedCone = this.buildExpectedCone(
      lastBar?.timeSec ?? asOfUtcSec,
      spotPrice,
      atmIvDec,
      expiryUtcSec,
      opts.timeframe,
    );

    const subPaneSeries = this.buildSubPaneSeries(
      convertedBars,
      bymaLegacyRawBars,
      adrRawBars,
      cclRate,
      bmaBarsRes?.bars ?? [],
      bbarBarsRes?.bars ?? [],
      supvBarsRes?.bars ?? [],
    );

    // Chart 2 Greek profile differentiating Uncovered (Descubiertas) vs Covered (Cubiertas)
    const greekProfile: GgalStrikeGreekProfileRow[] = [];
    const anexoByStrike = new Map((this.anexoBStore?.rows ?? []).map((r) => [r.strikeArs, r]));
    for (const item of strRes?.strikeProfile ?? []) {
      const strikeArs = item.strikeArs;
      if (strikeArs === null || !Number.isFinite(strikeArs)) {
        continue;
      }
      const row = anexoByStrike.get(strikeArs);
      const uncov = row !== undefined ? row.callOi.uncoveredNom + row.putOi.uncoveredNom : 0;
      const cov = row !== undefined ? row.callOi.coveredNom + row.putOi.coveredNom : 0;
      const tot = uncov + cov;
      const uncovShare = tot > 0 ? uncov / tot : 1;
      const covShare = tot > 0 ? cov / tot : 0;
      const convertedStrike = convertArsPriceToCoord(
        strikeArs,
        opts.coordMode,
        cclRate,
        adrLastUsd,
      );
      if (!Number.isFinite(convertedStrike)) {
        continue;
      }
      const gexVal = item.effectiveSignedGex ?? 0;
      const vannaVal = item.vannaExpArs ?? 0;
      const charmVal = item.charmExpArs ?? 0;
      greekProfile.push({
        strike: convertedStrike,
        signedGexUncovered: gexVal * uncovShare,
        signedGexCovered: gexVal * covShare,
        vannaUncovered: vannaVal * uncovShare,
        vannaCovered: vannaVal * covShare,
        charmUncovered: charmVal * uncovShare,
        charmCovered: charmVal * covShare,
      });
    }

    const convertedLadder = this.convertLadderToCoord(l2Ladder, opts.coordMode, cclRate, adrLastUsd);
    const confluenceAlerts: GgalL2ConfluenceAlert[] = [];
    if (convertedLadder.available) {
      const targetWalls: readonly { readonly label: string; readonly price: number }[] = [
        { label: 'Call Wall', price: callWall },
        { label: 'Put Wall', price: putWall },
        { label: 'Zero-Gamma', price: zeroGamma },
        { label: 'Max Pain', price: maxPain },
        ...volumeProfile.nakedPocs.map((p, idx) => ({
          label: `Naked POC #${String(idx + 1)}`,
          price: p,
        })),
      ].filter((t) => Number.isFinite(t.price) && t.price > 0);

      for (const bid of convertedLadder.bids) {
        for (const target of targetWalls) {
          const distPct = (Math.abs(bid.price - target.price) / target.price) * 100;
          if (distPct < 0.5) {
            confluenceAlerts.push({
              l2Price: bid.price,
              side: 'BID',
              l2Size: bid.size,
              targetLabel: target.label,
              targetPrice: target.price,
              distancePct: distPct,
            });
          }
        }
      }
      for (const ask of convertedLadder.asks) {
        for (const target of targetWalls) {
          const distPct = (Math.abs(ask.price - target.price) / target.price) * 100;
          if (distPct < 0.5) {
            confluenceAlerts.push({
              l2Price: ask.price,
              side: 'ASK',
              l2Size: ask.size,
              targetLabel: target.label,
              targetPrice: target.price,
              distancePct: distPct,
            });
          }
        }
      }
    }

    const payload: GgalDualChartPayload = {
      status: 'OPERATIONAL',
      asOfUtcSec,
      coordMode: opts.coordMode,
      timeframe: opts.timeframe,
      avwapAnchor: opts.avwapAnchor,
      avwapAnchorUtcSec,
      spotPrice,
      cclRate,
      callWall,
      putWall,
      zeroGamma,
      maxPain,
      bars: convertedBars,
      ema9,
      ema21,
      ema50,
      ema200,
      avwapBands,
      volumeProfile,
      zones,
      expectedCone,
      subPaneSeries,
      greekProfile,
      l2Ladder: convertedLadder,
      confluenceAlerts,
      reason: null,
    };

    return {
      routerStatus,
      dualChart: toJsonSafe(payload),
    };
  }

  private convertLadderToCoord(
    ladder: GgalL2LadderState,
    coordMode: GgalDualChartCoordMode,
    cclRate: number,
    adrReferenceUsd: number,
  ): GgalL2LadderState {
    if (!ladder.available || coordMode === 'ARS_BYMA') {
      return ladder;
    }
    const bids = ladder.bids
      .map((b) => ({
        ...b,
        price: convertArsPriceToCoord(b.price, coordMode, cclRate, adrReferenceUsd),
      }))
      .filter((b) => Number.isFinite(b.price) && b.price > 0);
    const asks = ladder.asks
      .map((a) => ({
        ...a,
        price: convertArsPriceToCoord(a.price, coordMode, cclRate, adrReferenceUsd),
      }))
      .filter((a) => Number.isFinite(a.price) && a.price > 0);
    if (bids.length === 0 || asks.length === 0) {
      return {
        available: false,
        reason: 'INVALID_BOOK_STATE',
        activeProvider: ladder.activeProvider,
        qualityTier: ladder.qualityTier,
        asOfUtcSec: ladder.asOfUtcSec,
        symbol: ladder.symbol,
      };
    }
    return {
      ...ladder,
      bids,
      asks,
    };
  }

  private detectUnmitigatedZones(
    bars: readonly GgalChartBarPoint[],
  ): readonly GgalChartStructureZone[] {
    const zones: GgalChartStructureZone[] = [];
    for (let i = 2; i < bars.length; i++) {
      const b0 = bars[i - 2];
      const b1 = bars[i - 1];
      const b2 = bars[i];
      if (b0 === undefined || b1 === undefined || b2 === undefined) {
        continue;
      }
      if (b2.low > b0.high) {
        const mitigated = bars.slice(i + 1).some((nb) => nb.low <= b2.low);
        zones.push({
          id: `FVG-B-${String(b1.timeSec)}`,
          kind: 'FVG',
          direction: 'BULLISH',
          status: mitigated ? 'MITIGATED' : 'UNMITIGATED',
          startTimeSec: b0.timeSec,
          endTimeSec: null,
          low: b0.high,
          high: b2.low,
        });
      } else if (b2.high < b0.low) {
        const mitigated = bars.slice(i + 1).some((nb) => nb.high >= b2.high);
        zones.push({
          id: `FVG-S-${String(b1.timeSec)}`,
          kind: 'FVG',
          direction: 'BEARISH',
          status: mitigated ? 'MITIGATED' : 'UNMITIGATED',
          startTimeSec: b0.timeSec,
          endTimeSec: null,
          low: b2.high,
          high: b0.low,
        });
      }
      // Fresh Order Block (FOB): opposite candle before large displacement
      const movePct = b1.open > 0 ? Math.abs(b1.close - b1.open) / b1.open : 0;
      if (movePct >= 0.025) {
        if (b1.close > b1.open && b0.close < b0.open) {
          const mitigated = bars.slice(i + 1).some((nb) => nb.low <= b0.high);
          zones.push({
            id: `FOB-B-${String(b0.timeSec)}`,
            kind: 'FOB',
            direction: 'BULLISH',
            status: mitigated ? 'MITIGATED' : 'UNMITIGATED',
            startTimeSec: b0.timeSec,
            endTimeSec: null,
            low: b0.low,
            high: b0.high,
          });
        } else if (b1.close < b1.open && b0.close > b0.open) {
          const mitigated = bars.slice(i + 1).some((nb) => nb.high >= b0.low);
          zones.push({
            id: `FOB-S-${String(b0.timeSec)}`,
            kind: 'FOB',
            direction: 'BEARISH',
            status: mitigated ? 'MITIGATED' : 'UNMITIGATED',
            startTimeSec: b0.timeSec,
            endTimeSec: null,
            low: b0.low,
            high: b0.high,
          });
        }
      }
    }
    return zones.filter((z) => z.status === 'UNMITIGATED').slice(-8);
  }

  private buildExpectedCone(
    startTimeSec: number,
    spotPrice: number,
    annVolDec: number,
    expiryUtcSec: number,
    timeframe: GgalDualChartTimeframe,
  ): readonly GgalExpectedConePoint[] {
    if (
      !Number.isInteger(startTimeSec) ||
      startTimeSec <= 0 ||
      !Number.isFinite(spotPrice) ||
      spotPrice <= 0 ||
      !Number.isFinite(annVolDec) ||
      annVolDec <= 0
    ) {
      return [];
    }

    let horizonSec: number;
    let yearFraction: number;
    if (timeframe === '1m' || timeframe === '5m') {
      // Cierre de rueda BYMA (17:00 ART = 20:00 UTC; ART no tiene DST).
      let nextBymaCloseUtcSec = Number.NaN;
      for (let dayOffset = 0; dayOffset < 10; dayOffset += 1) {
        const dateKey = getSessionDateKey(startTimeSec + dayOffset * 86_400, BYMA_MARKET_TZ);
        const dateParts = dateKey.split('-').map(Number);
        const year = dateParts[0];
        const month = dateParts[1];
        const day = dateParts[2];
        if (year === undefined || month === undefined || day === undefined) {
          return [];
        }
        const closeUtcSec = Date.UTC(year, month - 1, day, 20, 0, 0) / 1_000;
        const weekday = new Date(closeUtcSec * 1_000).getUTCDay();
        if (closeUtcSec > startTimeSec && weekday >= 1 && weekday <= 5) {
          nextBymaCloseUtcSec = closeUtcSec;
          break;
        }
      }
      if (!Number.isFinite(nextBymaCloseUtcSec)) {
        return [];
      }
      horizonSec = Math.min(6 * 3_600, nextBymaCloseUtcSec - startTimeSec);
      // T en años hábiles: 252 ruedas de 6 h.
      yearFraction = horizonSec / (252 * 6 * 3_600);
    } else if (timeframe === '15m' || timeframe === '1H') {
      horizonSec = 5 * 86_400;
      yearFraction = 5 / 252;
    } else {
      if (!Number.isFinite(expiryUtcSec) || expiryUtcSec <= startTimeSec) {
        return [];
      }
      horizonSec = expiryUtcSec - startTimeSec;
      yearFraction = horizonSec / (365 * 86_400);
    }

    if (
      !Number.isFinite(horizonSec) ||
      horizonSec <= 0 ||
      !Number.isFinite(yearFraction) ||
      yearFraction <= 0
    ) {
      return [];
    }

    const steps = 6;
    const cone: GgalExpectedConePoint[] = [];
    for (let s = 0; s <= steps; s++) {
      const frac = s / steps;
      const t = startTimeSec + Math.round(horizonSec * frac);
      const dtYears = yearFraction * frac;
      const sigma = spotPrice * annVolDec * Math.sqrt(dtYears);
      cone.push({
        timeSec: t,
        center: spotPrice,
        upper1Sigma: spotPrice + sigma,
        lower1Sigma: Math.max(0.01, spotPrice - sigma),
        upper2Sigma: spotPrice + 2 * sigma,
        lower2Sigma: Math.max(0.01, spotPrice - 2 * sigma),
      });
    }
    return cone;
  }

  private buildSubPaneSeries(
    bars: readonly GgalChartBarPoint[],
    bymaBars: readonly { readonly date: string; readonly close: number }[],
    adrBars: readonly { readonly time: number; readonly close: number }[],
    currentCcl: number,
    bmaBars: readonly { readonly time: number; readonly close: number }[],
    bbarBars: readonly { readonly time: number; readonly close: number }[],
    supvBars: readonly { readonly time: number; readonly close: number }[],
  ): readonly GgalSubPanePoint[] {
    const bymaDateMap = new Map(bymaBars.map((b) => [b.date.slice(0, 10), b.close]));
    const adrDateMap = new Map(
      adrBars.map((b) => [formatIsoUtcFromSec(b.time).slice(0, 10), b.close]),
    );
    const bmaMap = new Map(bmaBars.map((b) => [b.time, b.close]));
    const bbarMap = new Map(bbarBars.map((b) => [b.time, b.close]));
    const supvMap = new Map(supvBars.map((b) => [b.time, b.close]));

    const firstGgal = bars[0]?.close ?? Number.NaN;
    const firstBma = bmaBars[0]?.close ?? Number.NaN;
    const firstBbar = bbarBars[0]?.close ?? Number.NaN;
    const firstSupv = supvBars[0]?.close ?? Number.NaN;

    let cumCvd = 0;
    const out: GgalSubPanePoint[] = [];

    for (const bar of bars) {
      const range = Math.max(1e-6, bar.high - bar.low);
      const imbalance = ((bar.close - bar.low) - (bar.high - bar.close)) / range;
      cumCvd += bar.volume * imbalance;

      const dKey = formatIsoUtcFromSec(bar.timeSec).slice(0, 10);
      const bClose = bymaDateMap.get(dKey);
      const aClose = adrDateMap.get(dKey);
      let brechaPct = 0;
      if (
        bClose !== undefined &&
        aClose !== undefined &&
        aClose > 0 &&
        Number.isFinite(currentCcl) &&
        currentCcl > 0
      ) {
        const ggalCcl = (GGAL_ADR_RATIO * bClose) / aClose;
        brechaPct = ((ggalCcl - currentCcl) / currentCcl) * 100;
      }

      const ggalRet =
        Number.isFinite(firstGgal) && firstGgal > 0 ? (bar.close / firstGgal - 1) * 100 : 0;
      const bmaC = bmaMap.get(bar.timeSec);
      const bbarC = bbarMap.get(bar.timeSec);
      const supvC = supvMap.get(bar.timeSec);

      out.push({
        timeSec: bar.timeSec,
        cvdLeeReady: cumCvd,
        cclBrechaPct: brechaPct,
        relStrengthBma:
          bmaC !== undefined && Number.isFinite(firstBma) && firstBma > 0
            ? ggalRet - (bmaC / firstBma - 1) * 100
            : 0,
        relStrengthBbar:
          bbarC !== undefined && Number.isFinite(firstBbar) && firstBbar > 0
            ? ggalRet - (bbarC / firstBbar - 1) * 100
            : 0,
        relStrengthSupv:
          supvC !== undefined && Number.isFinite(firstSupv) && firstSupv > 0
            ? ggalRet - (supvC / firstSupv - 1) * 100
            : 0,
      });
    }

    return out;
  }
}
