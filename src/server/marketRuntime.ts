/**
 * Orquestador runtime local para QuantOptionsTerminal (Pieza 13).
 *
 * Responsabilidades:
 *  - Leer `MASSIVE_API_KEY` (o alias) exclusivamente en servidor desde `process.env` / `.env`,
 *    redactando cualquier secreto de errores, payloads o logs.
 *  - Cachear peticiones REST por símbolo / timeframe con `SingleFlightRuntimeCache`
 *    y TTL dinámico ET (`8s` power hour / `10s` RTH / `30s` off-hours).
 *  - Ejecutar los motores matemáticos puros de `src/core/*`, `src/core/options/*`,
 *    `src/core/microstructure/*` y `src/core/terminal/*` sin modificar ninguno de ellos.
 *  - Mantener exactamente una conexión WS por cluster (`stocks`, `options`) mediante
 *    `MassiveWsClient` + `createLiveBarState` / `ingestWsEvents`, difundiendo eventos
 *    normalizados (segundos UTC) a clientes locales.
 *  - Cero silent fallbacks: ante fallo o ausencia de datos, lanzar `RuntimeNoDataError`
 *    (HTTP 503 `{ status: "NO_DATA", reason, detail }`) o emitir `null` donde un escalar
 *    no sea calculable.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeAnchoredVwap } from '../core/avwap.js';
import {
  detectAutoAvwapAnchors,
  type AutoAvwapAnchor,
  type AutoAvwapEventInput,
} from '../core/autoAvwap.js';
import { calculateEma } from '../core/ema.js';
import {
  evaluateMacroVolatilityRegime,
  type MacroVolatilityRegimeResult,
  type VixRegime,
} from '../core/microstructure/breadthMacro.js';
import {
  analyzeCvdAndAbsorption,
  type CvdAbsorptionResult,
} from '../core/microstructure/cvdAbsorption.js';
import {
  computeWilderRsiSeries,
  detectRsiDivergences,
  detectSmtDivergences,
  type RsiDivergenceResult,
  type SmtDivergenceResult,
} from '../core/microstructure/divergences.js';
import {
  computeHmaSeries,
  computeSmaSeries,
  computeWilderAtrSeries,
  evaluateMtfStructure,
  type MtfEffectiveRegime,
  type MtfRegime1d,
  type MtfSetupStatus,
  type MtfStructureResult,
} from '../core/microstructure/mtfStructure.js';
import { evaluateOpeningAuction } from '../core/microstructure/openingAuction.js';
import {
  DEFAULT_VOLUME_PROFILE_LOOKBACK_BARS,
  computeVolumeProfileAmt,
  trackNakedPocs,
  type TrackNakedPocsResult,
  type VolumeProfileAmtResult,
} from '../core/microstructure/volumeProfileAmt.js';
import {
  detectFreshOrderBlocks,
  detectQuantitativeFvgs,
  type FreshOrderBlockResult,
  type QuantitativeFvgResult,
} from '../core/microstructure/fvgFobEngine.js';
import type {
  BalanceType,
  InitialBalanceClassification,
  InventoryRiskType,
  OpeningAuctionResult,
  OpeningDirection,
  OpeningType,
} from '../core/microstructure/types.js';
import {
  greeksAmericanFiniteDiffOrAnalytical,
  solveImpliedVolAmerican,
} from '../core/options/american.js';
import { greeksBsm, timeToExpiryYears } from '../core/options/blackScholes.js';
import {
  buildExposureTraceMetadata,
  resolveExposureCoverage,
  summarizeChainCoverage,
  summarizeQuoteTimes,
  type ChainDateReport,
  type ExposureTraceMetadata,
} from '../core/exposureTrace.js';
import {
  computeDealerExposure,
  type DealerExposureResult,
  type ExposureContractInput,
  type GammaFlipStatus,
  type VannaRegime,
} from '../core/options/exposure.js';
import {
  computeSignedOptionsOrderFlow,
  detectVolOiAnomaliesMad,
  type OpraTradePrintInput,
  type SignedOptionsOrderFlowResult,
  type VolOiAnomalyContractInput,
  type VolOiAnomalyDetectionResult,
} from '../core/options/optionsOrderFlow.js';
import {
  computeFlowAdjustedSignedGex,
  computeGexCharmPin,
  evaluateWheelByWheelTracker,
  type FlowAdjustedGexResult,
  type GexCharmPinResult,
  type WheelByWheelTrackerResult,
  type WheelSnapshotInput,
} from '../core/options/pinTracker.js';
import {
  analyzeEmpiricalDistributionP,
  computeVolConeAndRank,
  evaluatePqLevelDivergence,
  extractRiskNeutralDistributionQ,
  type EmpiricalDistributionResult,
  type PqLevelDivergenceResult,
  type RiskNeutralDistributionResult,
  type RiskNeutralInputNode,
  type VolConeAndRankResult,
} from '../core/options/probabilisticDivergence.js';
import {
  MIN_SYNTHETIC_RATE_T,
  computeSyntheticImpliedRates,
  evaluateBuyWrite,
  evaluateCalendarRoll,
  evaluateConversionReversal,
  type BuyWriteResult,
  type CalendarRollResult,
  type ConversionReversalResult,
  type SyntheticImpliedRatesResult,
} from '../core/options/syntheticRates.js';
import {
  impliedDividendYieldFromForward,
  inferForwardFromParityDetailed,
  type ParityOptionPair,
} from '../core/options/forward.js';
import { solveImpliedVolBsm } from '../core/options/impliedVol.js';
import {
  buildVolTermStructure,
  computeSliceVolMetrics,
  interpolateTermIvAtm,
  type VolSliceMetrics,
} from '../core/options/volMetrics.js';
import {
  buildVolSlice,
  buildVolSurface,
  computeForwardIvTermStructure,
  type ForwardIvStatus,
  type VolQuoteInput,
  type VolSlice,
} from '../core/options/volSurface.js';
import type {
  EarningsCatalystEvent,
  MacroCatalystEvent,
} from '../core/options/catalysts.js';
import {
  buildExpectedConeAndLognormalSummary,
  buildNormalizedMoneynessMatrix,
  buildSeparatedOtmSmile,
  computeActiveExpiryVrpAndRegime,
  computeHistoricalVolConditionalTable,
  computeParityAndSyntheticRatesByStrike,
  computeRatiosAndStructureCosts,
  computeRollingRvDistributionAtWindow,
  type CompositeOtmSmilePoint,
  type HistoricalDailyBarInput,
  type SeparatedSmileResult,
  type VolAnalyticsExpirySuiteResult,
  type VolAnalyticsPriorSmileSnapshot,
  type VolAnalyticsSuiteResult,
} from '../core/options/volAnalyticsSuite.js';
import {
  EXTRINSIC_EPS,
  IV_CAP_DECIMAL,
  MIN_EXPECTED_MOVE_T_YEARS,
  calendarDteEt,
  computeFallbackGreeks,
  etExpiryUtcSecFromDate,
  expectedMoveSigma,
  extrinsicValue,
  formatDteLabel,
  isIvUnreliable,
  resolveParityItmRescueIv,
  todayEtDate,
  type ParityItmRescueResult,
} from '../core/options/zeroDteFixes.js';
import {
  computeYangZhangVol,
  type YangZhangOhlcBar,
} from '../core/ggal/l2AndRegimeEngines.js';
import {
  getMarketParts,
  getUsEquitySessionPhase,
  isExtendedHoursPhase,
  isRth,
  MAX_TIME_SECONDS,
  type UsEquitySessionPhase,
} from '../core/sessions.js';
import { computeSessionVwap } from '../core/sessionVwap.js';
import { evaluateTerminalConfluence } from '../core/terminal/confluenceOrchestrator.js';
import { computeIntradayRealizedVol } from '../core/terminal/realizedVol.js';
import {
  assertJsonSafeSerialized,
  serializeTerminalSnapshot,
} from '../core/terminal/serializer.js';
import {
  computeStructureCostPercentile,
  detectSpatialConfluenceClusters,
  evaluateRelativeStrengthAndCatalysts,
  optimizeOptionStructures,
  type OptimizeOptionStructuresResult,
  type OptimizerOptionContractInput,
  type RelativeStrengthAndCatalystsResult,
  type SpatialConfluenceResult,
  type SpatialLevelInput,
  type StructureCostPercentileResult,
} from '../core/terminal/structureOptimizer.js';
import type {
  KeyLevelName,
  KeyLevelSource,
  TerminalSerializedEnvelope,
} from '../core/terminal/types.js';
import type { Bar } from '../core/types.js';
import {
  createLiveBarState,
  ingestWsEvents,
  projectLiveIndicators,
} from '../data/liveBarConsolidator.js';
import {
  GgalTickStreamEngine,
} from './ggalTickStream.js';
import {
  extractOptionUnderlying,
  hasOptionQuoteChanged,
  type LiveOptionQuoteSnapshot,
} from './wsViewScopeBackpressure.js';
import {
  deepHistoryFromUtcSec,
  GGAL_DEEP_HISTORY_MAX_BARS,
  GgalAdrDeepHistoryStore,
  isGgalDeepHistoryTimeframe,
  isGgalPaginatedHistoryTimeframe,
  type GgalPaginatedHistoryTimeframe,
} from './ggalDeepHistory.js';
import { loadBars } from '../data/loader.js';
import {
  loadDividends,
  loadFundingConditions,
  loadTreasuryYields,
  loadUnifiedSnapshot,
} from '../data/macroLoader.js';
import type {
  TreasuryYieldObservation,
  UnifiedIndexSnapshot,
  UnifiedStockSnapshot,
} from '../data/macroTypes.js';
import { interpolateTreasuryYield, TREASURY_TENORS } from '../data/normalizeMacro.js';
import { toErrorMessage } from '../data/normalizeShared.js';
import { parseExpirationDate } from '../data/normalizeOptions.js';
import {
  loadOptionChain,
  loadOptionContracts,
  toReferenceUnderlyingTicker,
} from '../data/optionsLoader.js';
import type {
  OptionContract,
  OptionSnapshotContract,
  OptionUnderlyingSnapshot,
} from '../data/optionsTypes.js';
import { restHistoricalFromUtcSec } from '../data/restHistoricalWindow.js';
import type { FetchFn, FetchResponse, Timeframe } from '../data/types.js';
import {
  loadUnusualTrades,
  type LoadUnusualTradesOptions,
  type UnusualTradeRecord,
} from '../data/unusualTradesLoader.js';
import {
  MassiveWsClient,
  countQuoteSubscriptions,
} from '../data/wsClient.js';
import type {
  LiveBarState,
  MassiveWsClientOptions,
  WsClientError,
  WsClientSnapshot,
  WsConnectionState,
  WsNormalizedEvent,
  WsTradeEvent,
} from '../data/wsTypes.js';
import {
  SingleFlightRuntimeCache,
  computeDynamicTtlMs,
  redactSecrets,
} from './runtimeCache.js';
import {
  getUsLiveSession,
  MassiveStocksStream,
  type MarketTickQuote,
} from './massiveStocksStream.js';
import {
  RollingFeedTelemetry,
  emptyFeedTelemetrySnapshot,
} from './feedsHealthMonitor.js';
import {
  getMassiveKeyPoolStatus,
  getMassiveRestKey,
  getMassiveStocksWsKey,
  type MassiveKeySlot,
} from './massiveKeyPool.js';
import {
  OratsHybridClient,
  type OratsIvRankPayload,
  type OratsHybridSurfacePayload,
} from './oratsHybridClient.js';
import {
  fetchTradierOptionChain,
  fetchTradierQuotes,
  resolveTradierConfig,
  overlayTradierChainOnCanonicalContracts,
  TRADIER_PROD_REST_BASE,
  TRADIER_WS_BASE,
  TradierAuthCircuitBreaker,
  TradierAuthInvalidError,
  TradierLiveManager,
  type TradierChainOverlaySummary,
  type TradierConfig,
  type TradierHttpFn,
  type TradierOptionChainResult,
  type TradierOptionContractNormalized,
  type TradierQuotesResult,
  type TradierSocketFactory,
  type TradierStreamTick,
} from './tradierAdapter.js';
import {
  fetchAsFmpHttpFn,
  FmpEnterpriseClient,
  fmpEtDateKey,
  loadFmpConfigFromEnv,
  resolveFmpConfig,
  type FmpBatchMode,
  type FmpBatchQuote,
  type FmpConfig,
  type FmpExtendedQuote,
  type FmpMacroCalendarResult,
  type FmpSymbolEarningsResult,
} from './fmpClient.js';
import { TradierHistoricalClient, TradierStocksStream, TRADIER_CORE_US_SYMBOLS } from './tradierStream.js';
import { resolveMassiveStocksMode } from './massiveStocksStream.js';

/** Pieza 41: primer instante del gap electoral. */
export const ELECTORAL_GAP_START_UTC_SEC = Date.UTC(2025, 9, 1, 4, 0, 0) / 1_000;

export const DEFAULT_TERMINAL_SYMBOLS = ['SPY', 'QQQ', 'I:SPX'] as const;

/** Pieza 41: cadencia no solapada del batch completo FMP Enterprise. */
export const FMP_BATCH_QUOTE_INTERVAL_MS = 1_500;
/** Pieza 42: cadencia del poll extendido Pre-Market / After-Hours (04:00–20:00 ET). */
export const FMP_EXTENDED_QUOTE_INTERVAL_MS = 2_000;
/** Pieza 50.5.1: backoff corto de reintento cuando FMP falla al resolver eventos Auto-AVWAP. */
export const FMP_EVENT_FAILURE_BACKOFF_MS = 5 * 60 * 1_000;

const KEY_ENV_NAMES = [
  'MASSIVE_API_KEY',
  'MASSIVE_KEY',
  'MASSIVE_KEY_OPTIONS',
  'MASSIVE_OPTIONS',
] as const;

const EXTRA_SECRET_ENV_NAMES = [
  ...KEY_ENV_NAMES,
  'MASSIVE_KEY_FUTURES',
  'BINGX_API_KEY',
  'FMP_KEY_CALENDARS',
] as const;

const TIMEFRAME_SECONDS: Readonly<Record<Timeframe, number>> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3_600,
  '4h': 14_400,
  '1D': 86_400,
};

/** Pieza 50.5 (Bloque 2): velas previas al tramo visible para calentar la EMA 200 (SPEC.md:4). */
const REST_EMA_WARMUP_BARS = 1_000;

const KNOWN_INDEX_ROOTS = new Set<string>(['SPX', 'NDX', 'VIX', 'SKEW', 'RUT', 'DJX', 'OEX']);
const MAX_SERIALIZED_CONTRACTS = 480;
/** Pieza 50.1/50.2: cuota balanceada por vencimiento (activo/front + anclas) para no perder vencimientos. */
const MAX_SERIALIZED_PRIMARY_CONTRACTS = 120;
/** Cuota fija por vencimiento ancla adicional (regresión Pieza 50.1: 48 por vencimiento). */
const MAX_SERIALIZED_SECONDARY_CONTRACTS = 48;
const MAX_WS_OPTION_CONTRACTS = 40;
/** Pieza 50.2: tope duro del proveedor Massive para suscripciones `Q.` de opciones. */
const MAX_MASSIVE_WS_OPTION_QUOTES = 1_000;
/** Pieza 50.2: TTL del catálogo completo `availableExpirations` (12 min, dentro de 10–15 min). */
export const US_EXPIRY_CATALOG_TTL_MS = 12 * 60 * 1_000;
/** Pieza 50.2: máximo de vencimientos ancla precargados por snapshot (front + 5 buckets). */
const MAX_PRELOAD_EXPIRY_DATES = 6;
const SYMBOL_PATTERN = /^[A-Z0-9.:_-]{1,24}$/;

export type NoDataReason =
  | 'INVALID_SYMBOL'
  | 'INVALID_PARAMETER'
  | 'MISSING_API_KEY'
  | 'NO_MARKET_DATA'
  | 'NO_BARS_DATA'
  | 'PROVIDER_ERROR';

export interface NoDataPayload {
  readonly status: 'NO_DATA';
  readonly reason: NoDataReason;
  readonly detail: string;
}

export class RuntimeNoDataError extends Error {
  public readonly status = 'NO_DATA' as const;
  public readonly reason: NoDataReason;
  public readonly detail: string;
  public readonly httpStatus: number;

  public constructor(
    reason: NoDataReason,
    detail: string,
    secrets: readonly string[] = [],
    httpStatus = 503,
  ) {
    const safeDetail = redactSecrets(detail, secrets);
    super(`${reason}: ${safeDetail}`);
    this.name = 'RuntimeNoDataError';
    this.reason = reason;
    this.detail = safeDetail;
    this.httpStatus = httpStatus;
  }

  public toPayload(): NoDataPayload {
    return {
      status: 'NO_DATA',
      reason: this.reason,
      detail: this.detail,
    };
  }
}

export interface MassiveAuthConfig {
  readonly apiKey: string;
  readonly secrets: readonly string[];
}

/** Slot seguro del pool REST/WS para exponer por HTTP (sin material secreto). */
export interface UsProviderKeySlotStatus {
  readonly envName: string;
  readonly slotIndex: number;
  readonly poolSize: number;
}

export interface UsMassiveWsProviderStatus {
  readonly configured: boolean;
  readonly connected: boolean;
  readonly state: string;
  readonly keySlot: UsProviderKeySlotStatus | null;
  readonly activeRole: 'WS_STOCKS';
  readonly lastError: string | null;
  readonly subscribedOptionQuotes: number;
}

export interface UsRestPoolProviderStatus {
  readonly configured: boolean;
  readonly poolSize: number;
  readonly slots: readonly { readonly envName: string; readonly slotIndex: number }[];
  readonly lastSlotIndex: number | null;
  readonly roundRobinRequests: number;
  readonly activeRole: 'REST_LOADERS';
}

export interface FmpAdrFallbackQuote {
  readonly symbol: string;
  readonly price: number;
  readonly previousClose: number | null;
  readonly changePct: number | null;
  readonly asOfUtcSec: number | null;
  readonly extendedPrice: number | null;
  readonly extendedChangePct: number | null;
  readonly sessionPhase: UsEquitySessionPhase;
}

export interface UsTradierProviderStatus {
  readonly configured: boolean;
  readonly connected: boolean;
  readonly state: string;
  readonly authInvalid?: boolean;
  readonly sessionCreated: boolean;
  readonly subscribedSymbols: readonly string[];
  readonly lastTickAtUtcSec: number | null;
  readonly lastError: string | null;
  readonly activeRole: 'LIVE_STREAM' | 'STANDBY';
  readonly apiEnv: 'prod' | 'sandbox';
  readonly environment: 'LIVE' | 'SANDBOX';
  readonly restBaseUrl: string;
  readonly wsBaseUrl: string;
}

export interface UsProvidersStatus {
  readonly asOfUtcSec: number;
  readonly MASSIVE_WS: UsMassiveWsProviderStatus;
  readonly MASSIVE_REST_POOL: UsRestPoolProviderStatus;
  readonly TRADIER_LIVE: UsTradierProviderStatus;
}

/** Origen declarado del feed de opciones US en el snapshot (Pieza 32). */
export type UsOptionsFeedBadge = 'TRADIER LIVE + ORATS' | 'MASSIVE + ORATS';

export interface UsOptionsFeedProvenance {
  readonly provider: 'TRADIER' | 'MASSIVE';
  readonly badge: UsOptionsFeedBadge;
  readonly tradierOverlay: TradierChainOverlaySummary | null;
}

export interface UsOptionExpiryDto {
  readonly expirationDate: string;
  readonly daysToExpiry: number;
  /** Pieza 50.2: `true` si la cadena de este vencimiento ya está cargada en memoria. */
  readonly loaded: boolean;
  readonly validCallCount: number;
  readonly validPutCount: number;
  readonly nearAtmLiquidity: number;
  readonly inDefaultWindow: boolean;
  readonly hasCompleteAtmChain: boolean;
}

/** Pieza 50.2: entrada liviana del catálogo completo de vencimientos OPRA. */
export interface UsOptionExpiryCatalogEntry {
  readonly expirationDate: string;
  readonly daysToExpiry: number;
  /** Contratos de referencia cerca de ATM (±15 % del spot) para desempate estructural. */
  readonly nearAtmContracts: number;
}

/** Pieza 50.2: resultado cacheado del catálogo completo de vencimientos US. */
export interface UsExpiryCatalogResult {
  readonly canonicalSymbol: string;
  readonly asOfUtcSec: number;
  readonly expirations: readonly UsOptionExpiryCatalogEntry[];
  /** Contratos de referencia (calls, banda ATM angosta) usados también como metadata. */
  readonly contracts: readonly OptionContract[];
  /** `false` si la paginación de descubrimiento agotó `maxPages` incluso en el reintento. */
  readonly complete: boolean;
  readonly warnings: readonly string[];
}

export interface UsOptionsChainMeta {
  readonly selectedExpirationDate: string | null;
  readonly selectionReason: string | null;
  readonly prefetchExpirationDates: readonly string[];
  readonly availableExpirations: readonly UsOptionExpiryDto[];
}

/**
 * Pieza 50.2: respuesta puntual de un vencimiento US cargado on-demand
 * (`GET /api/options/expiry`) con cuantitativo completo de ESA fecha: slice/Skew,
 * exposición de dealers, tasas sintéticas y suite de volatilidad evaluados con el
 * DTE calendario ET exacto del vencimiento.
 */
export interface UsOptionExpiryChainResponse {
  readonly status: 'OK' | 'PARTIAL';
  readonly feedMode: 'LIVE' | 'EOD_CIERRE' | 'PARTIAL' | 'NO_DATA';
  readonly quoteMode: 'LIVE_NBBO' | 'EOD_CLOSE_REF';
  readonly symbol: string;
  readonly expirationDate: string;
  readonly asOfUtcSec: number;
  readonly spot: number | null;
  readonly daysToExpiry: number;
  readonly expiryMeta: UsOptionExpiryDto;
  readonly slice: SerializedVolSliceSummary | null;
  readonly contracts: readonly SerializedOptionContractRow[];
  readonly exposureSummary: SerializedExposureSummary | null;
  readonly syntheticRates: JsonSafeValue<SyntheticImpliedRatesResult> | null;
  /** Pieza 50.3: Buy-Write y Cobertura Sintética propias del vencimiento pedido. */
  readonly conversionReversal?: JsonSafeValue<ConversionReversalResult> | null;
  readonly buyWrite?: JsonSafeValue<BuyWriteResult> | null;
  readonly volAnalyticsExpiry: JsonSafeValue<VolAnalyticsExpirySuiteResult> | null;
  readonly usOptionsFeed?: UsOptionsFeedProvenance | undefined;
  readonly dataQuality: SnapshotDataQuality;
}

export interface SerializedStrikeExposure {
  readonly strike: number;
  readonly callOi: number | null;
  readonly putOi: number | null;
  readonly callVolume: number | null;
  readonly putVolume: number | null;
  readonly callGex: number | null;
  readonly putGex: number | null;
  readonly netGex: number | null;
  readonly netSpotGamma: number | null;
  readonly netDex: number | null;
  readonly netVannaExposure: number | null;
  readonly netCharmExposure: number | null;
  readonly vex: number | null;
  readonly cex: number | null;
}

export interface SerializedExposureSummary {
  readonly netGex: number | null;
  readonly callGex: number | null;
  readonly putGex: number | null;
  readonly netSpotGamma: number | null;
  readonly netDex: number | null;
  readonly netVannaExposure: number | null;
  readonly netCharmExposure: number | null;
  readonly netVex: number | null;
  readonly netCex: number | null;
  readonly vannaRegime: VannaRegime;
  readonly charmPinStrike: number | null;
  readonly callWallStrike: number | null;
  readonly putWallStrike: number | null;
  readonly gammaFlipSpot: number | null;
  readonly gammaFlipStatus: GammaFlipStatus;
  /** Pieza 50.9: candidatos de cruce de gamma (REST selecciona el más cercano). */
  readonly gammaFlipCandidates: readonly number[];
  /** Pieza 50.9: trazabilidad opcional del insumo que produjo los niveles. */
  readonly trace?: ExposureTraceMetadata;
  readonly expectedMove: {
    readonly expiryUtcSec: number | null;
    readonly formulaMove: number | null;
    readonly formulaMovePct: number | null;
    readonly straddleStrike: number | null;
    readonly straddleMove: number | null;
    readonly straddleMovePct: number | null;
  };
  readonly quality: {
    readonly totalContracts: number;
    readonly activeContracts: number;
    readonly usableContracts: number;
    readonly usableOpenInterest: number;
    readonly skippedContracts: number;
    readonly skippedOiShare: number | null;
  };
  readonly byStrike: readonly SerializedStrikeExposure[];
}

export interface SerializedForwardIvSegment {
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
  readonly status: ForwardIvStatus;
}

export interface SerializedSymbolCatalystsDto {
  readonly symbol: string;
  readonly asOfUtcSec: number;
  readonly available: boolean;
  readonly nextEarnings: EarningsCatalystEvent | null;
  readonly lastEarnings: EarningsCatalystEvent | null;
  readonly macroEvents: readonly MacroCatalystEvent[];
  readonly earningsSource: string | null;
  readonly macroSource: string | null;
  readonly reason: string | null;
  readonly cacheHit?: boolean;
}

export interface SerializedVolSliceNode {
  readonly strike: number;
  readonly k: number;
  readonly iv: number | null;
  readonly totalVariance: number | null;
  readonly slope: number | null;
  readonly spreadRatio: number | null;
  readonly openInterest: number;
}

export interface SerializedVolSliceSummary {
  readonly expirySec: number;
  readonly expirationDate: string;
  readonly timeToExpiryYears: number;
  readonly timeToExpiryDays: number;
  readonly forward: number | null;
  readonly rate: number | null;
  readonly dividendYield: number | null;
  readonly ivAtm: number | null;
  readonly delta25PutIv: number | null;
  readonly delta25CallIv: number | null;
  readonly riskReversal25: number | null;
  readonly butterfly25: number | null;
  readonly isButterflyArbitrageFree: boolean;
  readonly butterflyMinDensity: number | null;
  readonly nodes: readonly SerializedVolSliceNode[];
}

export interface SerializedOptionContractRow {
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
  readonly previousClose: number | null;
  readonly changePct: number | null;
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

export interface SerializedVolSurfaceSummary {
  readonly iv30d: number | null;
  readonly butterflyArbitrageFree: boolean;
  readonly calendarArbitrageFree: boolean;
  readonly isArbitrageFree: boolean;
  readonly frontSlice: SerializedVolSliceSummary | null;
  readonly slices: readonly SerializedVolSliceSummary[];
  readonly forwardIvSegments?: readonly SerializedForwardIvSegment[];
  readonly contracts: readonly SerializedOptionContractRow[];
}

export interface SerializedOpeningAuctionSummary {
  readonly balanceType: BalanceType;
  readonly inventoryRisk: InventoryRiskType;
  readonly openingType: OpeningType;
  readonly openingDirection: OpeningDirection;
  readonly ibClassification: InitialBalanceClassification;
  readonly pmh: number | null;
  readonly pml: number | null;
  readonly onPoc: number | null;
  readonly onVah: number | null;
  readonly onVal: number | null;
  readonly ibh: number | null;
  readonly ibl: number | null;
  readonly ibWidth: number | null;
  readonly atr14d: number | null;
  readonly gapPct: number | null;
  readonly macro0830SpikeDetected: boolean;
}

export interface SerializedAbsorptionMarker {
  readonly time: number;
  readonly direction: 'BUY_ABSORPTION' | 'SELL_ABSORPTION';
  readonly price: number | null;
  readonly levelName: string | null;
  readonly levelPrice: number | null;
  readonly barDelta: number | null;
  readonly sessionCvd: number | null;
}

export interface SerializedDivergenceMarker {
  readonly kind: 'RSI' | 'SMT';
  readonly type: string;
  readonly pivotTime: number;
  readonly confirmTime: number;
  readonly price: number | null;
}

export interface SerializedMicrostructureSummary {
  readonly mtf: {
    readonly regime1d: MtfRegime1d;
    readonly aligned4h: boolean;
    readonly effectiveMacroRegime: MtfEffectiveRegime;
    readonly pullback15mInZone: boolean;
    readonly absorption15m: boolean;
    readonly executionTriggerActive: boolean;
    readonly setupStatus: MtfSetupStatus;
    readonly sma200_1d: number | null;
    readonly sma50_4h: number | null;
    readonly ema21_15m: number | null;
    readonly hma55: number | null;
    readonly close5m: number | null;
  } | null;
  readonly cvd: {
    readonly deltaMode: string;
    readonly currentSessionDate: string | null;
    readonly currentSessionCvd: number | null;
    readonly absorptionEvents: readonly SerializedAbsorptionMarker[];
  } | null;
  readonly rsiDivergences: {
    readonly status: string;
    readonly latestRsi: number | null;
    readonly events: readonly SerializedDivergenceMarker[];
  } | null;
  readonly smtDivergences: {
    readonly status: string;
    readonly correlatedSymbol: string;
    readonly events: readonly SerializedDivergenceMarker[];
  } | null;
}

export interface SerializedUnifiedQuote {
  readonly ticker: string;
  readonly assetType: 'stock' | 'index';
  readonly price: number | null;
  readonly change: number | null;
  readonly changePct: number | null;
  readonly previousClose: number | null;
  readonly dayLow: number | null;
  readonly dayHigh: number | null;
  readonly dayRangePos: number | null;
  readonly volumeM: number | null;
  readonly tradedVolumeUsd?: number | null;
  readonly iv30d: number | null;
  readonly marketStatus: string | null;
  readonly volume: number | null;
  readonly bid?: number | null | undefined;
  readonly ask?: number | null | undefined;
  readonly bidSize?: number | null | undefined;
  readonly askSize?: number | null | undefined;
  readonly spreadPct?: number | null | undefined;
  readonly regularClose?: number | null | undefined;
  readonly extendedPrice?: number | null | undefined;
  readonly extendedChangePct?: number | null | undefined;
  readonly sessionPhase?: UsEquitySessionPhase | undefined;
}

export interface SerializedMarketContext {
  readonly unifiedQuotes: readonly SerializedUnifiedQuote[];
  readonly treasury: {
    readonly date: string | null;
    readonly yield1M: number | null;
    readonly yield3M: number | null;
    readonly yield1Y: number | null;
    readonly yield2Y: number | null;
    readonly yield10Y: number | null;
    readonly sofr: number | null;
    readonly rate30d: number | null;
    readonly dividendYieldFront: number | null;
  };
  readonly vixLevel: number | null;
  readonly vixSlope: number | null;
  readonly vixRegime: VixRegime | 'NO_DATA';
  readonly skewLevel: number | null;
  readonly tailRiskAlert: boolean | null;
}

export interface SnapshotDataQuality {
  readonly ownSolvedIvContracts: number;
  readonly providerFallbackIvContracts: number;
  readonly parityExpiries: number;
  readonly chainContractsReceived: number;
  readonly chainContractsUsable: number;
  readonly warnings: readonly string[];
}

export type JsonSafeValue<T> = T extends number
  ? number | null
  : T extends readonly (infer U)[]
    ? readonly JsonSafeValue<U>[]
    : T extends object
      ? { readonly [K in keyof T]: JsonSafeValue<T[K]> }
      : T;

export interface SerializedTickAggression {
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

function computeUsOptionsTickAggression(
  contracts: readonly OptionSnapshotContract[],
  evalSecUs: number,
): SerializedTickAggression | null {
  let askNotional = 0;
  let bidNotional = 0;
  let neutralNotional = 0;
  let classifiedContracts = 0;
  let leeReadyCount = 0;
  let variationCount = 0;

  for (const c of contracts) {
    if (c.expirationTime <= evalSecUs) {
      continue;
    }
    const vol = c.day.volume;
    if (!Number.isFinite(vol) || vol <= 0) {
      continue;
    }
    const mid = resolveQuoteMid(c);
    const px =
      Number.isFinite(c.lastTrade.price) && c.lastTrade.price > 0
        ? c.lastTrade.price
        : Number.isFinite(mid) && mid > 0
          ? mid
          : Number.isFinite(c.day.close) && c.day.close > 0
            ? c.day.close
            : Number.NaN;
    if (!Number.isFinite(px) || px <= 0) {
      continue;
    }
    const mult =
      Number.isFinite(c.sharesPerContract) && c.sharesPerContract > 0
        ? c.sharesPerContract
        : 100;
    const weight = vol * px * mult;
    if (!Number.isFinite(weight) || weight <= 0) {
      continue;
    }

    const { bid, ask } = c.lastQuote;
    const tickDelta = Number.isFinite(c.day.change)
      ? c.day.change
      : Number.isFinite(c.day.previousClose) && c.day.previousClose > 0
        ? px - c.day.previousClose
        : Number.NaN;

    if (Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > bid) {
      const bboMid = 0.5 * (bid + ask);
      if (px >= ask - 1e-9 || px > bboMid + 1e-9) {
        askNotional += weight;
      } else if (px <= bid + 1e-9 || px < bboMid - 1e-9) {
        bidNotional += weight;
      } else if (Number.isFinite(tickDelta) && Math.abs(tickDelta) > 1e-6) {
        if (tickDelta > 0) {
          askNotional += weight;
        } else {
          bidNotional += weight;
        }
      } else {
        neutralNotional += weight;
      }
      leeReadyCount += 1;
      classifiedContracts += 1;
      continue;
    }

    if (Number.isFinite(tickDelta)) {
      if (tickDelta > 1e-6) {
        askNotional += weight;
      } else if (tickDelta < -1e-6) {
        bidNotional += weight;
      } else {
        neutralNotional += weight;
      }
      variationCount += 1;
      classifiedContracts += 1;
    }
  }

  const totalNotional = askNotional + bidNotional + neutralNotional;
  if (classifiedContracts === 0 || !Number.isFinite(totalNotional) || totalNotional <= 0) {
    return null;
  }
  const askPct = (askNotional / totalNotional) * 100;
  const bidPct = (bidNotional / totalNotional) * 100;
  const neutralPct = (neutralNotional / totalNotional) * 100;
  const netBiasPct = askPct - bidPct;
  const direction: SerializedTickAggression['direction'] =
    netBiasPct > 2 ? 'COMPRADOR' : netBiasPct < -2 ? 'VENDEDOR' : 'EQUILIBRADO';
  const sign = netBiasPct >= 0 ? '+' : '';
  return {
    askPct,
    bidPct,
    neutralPct,
    netBiasPct,
    direction,
    label: `${direction} ${sign}${netBiasPct.toFixed(1)}%`,
    totalNotional,
    classifiedContracts,
    method: leeReadyCount >= variationCount ? 'LEE_READY_BBO' : 'TICK_VARIATION_EOD',
  };
}

export interface SerializedNearestInstitutionalLevel {
  readonly name: string;
  readonly category: string;
  readonly price: number;
  readonly distanceAbs: number;
  readonly distancePct: number;
  readonly distanceAtr: number | null;
  readonly side: 'ABOVE' | 'BELOW' | 'AT_SPOT';
  readonly clusterRadiusAtrUsed: number | null;
}

export interface SerializedTerminalEngines {
  readonly atr14d: number | null;
  readonly cvdSlopeSign: number | null;
  readonly volumeProfile: JsonSafeValue<VolumeProfileAmtResult> | null;
  readonly nakedPocs: JsonSafeValue<TrackNakedPocsResult> | null;
  readonly fvgs: JsonSafeValue<QuantitativeFvgResult> | null;
  readonly orderBlocks: JsonSafeValue<FreshOrderBlockResult> | null;
  readonly orderFlow: (JsonSafeValue<SignedOptionsOrderFlowResult> & {
    readonly agresionTicks?: JsonSafeValue<SerializedTickAggression> | null | undefined;
  }) | null;
  readonly agresionTicks?: JsonSafeValue<SerializedTickAggression> | null | undefined;
  readonly volOiAnomalies: JsonSafeValue<VolOiAnomalyDetectionResult> | null;
  readonly flowAdjustedGex: JsonSafeValue<FlowAdjustedGexResult> | null;
  readonly gexCharmPin: JsonSafeValue<GexCharmPinResult> | null;
  readonly wheelTracker: JsonSafeValue<WheelByWheelTrackerResult> | null;
  readonly qDistribution: JsonSafeValue<RiskNeutralDistributionResult> | null;
  readonly pDistribution: JsonSafeValue<EmpiricalDistributionResult> | null;
  readonly pqDivergence: JsonSafeValue<PqLevelDivergenceResult> | null;
  readonly volCone: JsonSafeValue<VolConeAndRankResult> | null;
  readonly syntheticRates: JsonSafeValue<SyntheticImpliedRatesResult> | null;
  readonly conversionReversal: JsonSafeValue<ConversionReversalResult> | null;
  readonly buyWrite: JsonSafeValue<BuyWriteResult> | null;
  readonly calendarRoll: JsonSafeValue<CalendarRollResult> | null;
  readonly relativeStrength: JsonSafeValue<RelativeStrengthAndCatalystsResult> | null;
  readonly confluenceClusters: JsonSafeValue<SpatialConfluenceResult> | null;
  readonly nearestInstitutionalLevel?: JsonSafeValue<SerializedNearestInstitutionalLevel> | null | undefined;
  readonly structureOptimizerBullish: JsonSafeValue<OptimizeOptionStructuresResult> | null;
  readonly structureOptimizerBearish: JsonSafeValue<OptimizeOptionStructuresResult> | null;
  readonly structureCostPercentile: JsonSafeValue<StructureCostPercentileResult> | null;
  readonly volAnalyticsSuite?: JsonSafeValue<VolAnalyticsSuiteResult> | null;
}

export interface TerminalSnapshotResponse {
  readonly status: 'OK' | 'PARTIAL';
  readonly feedMode?: 'LIVE' | 'EOD_CIERRE' | 'PARTIAL' | 'NO_DATA';
  readonly quoteMode?: 'LIVE_NBBO' | 'EOD_CLOSE_REF';
  readonly symbol: string;
  readonly correlatedSymbol: string;
  readonly isIndex: boolean;
  readonly asOfUtcSec: number;
  readonly envelope: TerminalSerializedEnvelope;
  readonly exposureSummary: SerializedExposureSummary | null;
  readonly volSurfaceSummary: SerializedVolSurfaceSummary | null;
  readonly openingAuction: SerializedOpeningAuctionSummary | null;
  readonly microstructure: SerializedMicrostructureSummary;
  readonly marketContext: SerializedMarketContext;
  readonly terminalEngines?: SerializedTerminalEngines | null;
  readonly benchmarkBars1d?: readonly SerializedBar[] | undefined;
  readonly usEquityPanel?: EquityPanelAnalyticsDto | null;
  readonly usOptionsFeed?: UsOptionsFeedProvenance | undefined;
  readonly optionsChain?: UsOptionsChainMeta | null;
  readonly catalysts?: SerializedSymbolCatalystsDto | null;
  readonly dataQuality: SnapshotDataQuality;
}

export interface SerializedBar {
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly vw: number | null;
}

export interface SerializedKeyLevel {
  readonly name: KeyLevelName;
  readonly source: KeyLevelSource;
  readonly price: number | null;
}

export interface TerminalBarsResponse {
  readonly status: 'OK' | 'PARTIAL';
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly barSeconds: number;
  readonly rthOnly: boolean;
  readonly asOfUtcSec: number;
  readonly visibleStartIndex: number;
  readonly bars: readonly SerializedBar[];
  readonly formingBar: SerializedBar | null;
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
    readonly avwapUpper1: readonly (number | null)[];
    readonly avwapLower1: readonly (number | null)[];
    readonly avwapUpper2: readonly (number | null)[];
    readonly avwapLower2: readonly (number | null)[];
  };
  readonly subPanes: {
    readonly rsi14: readonly (number | null)[];
    readonly sessionCvd: readonly (number | null)[];
    readonly deltaMode: string | null;
  };
  readonly zones: {
    readonly onVal: number | null;
    readonly onVah: number | null;
    readonly onPoc: number | null;
    readonly ibl: number | null;
    readonly ibh: number | null;
  } | null;
  readonly keyLevels: readonly SerializedKeyLevel[];
  readonly markers: readonly (SerializedAbsorptionMarker | SerializedDivergenceMarker)[];
  /** Pieza 41: provenance explícita del proveedor de velas. */
  readonly barsProvider: 'FMP_ENTERPRISE_REST' | 'TRADIER_REST' | 'MASSIVE_REST';
  readonly barsProviderFallbackUsed: readonly string[];
  /**
   * Pieza 50.5: anclas institucionales diarias Auto-AVWAP (cacheadas por día
   * `US:${symbol}:${fmpEtDateKey}`). Aditivo y opcional: `[]` cuando no hay datos.
   */
  readonly autoAvwapAnchors?: readonly AutoAvwapAnchor[];
}

export interface SerializedUnusualTradeRow {
  readonly ticker: string;
  readonly underlyingTicker: string | null;
  readonly root: string;
  readonly rootKind: string;
  readonly contractType: 'call' | 'put' | null;
  readonly strike: number | null;
  readonly expirationDate: string | null;
  readonly time: number;
  readonly timestampNs: string;
  readonly price: number | null;
  readonly size: number | null;
  readonly sharesPerContract: number | null;
  readonly notional: number | null;
  readonly flags: readonly string[];
  readonly exchange: number | null;
  readonly sequenceNumber: number;
}

export interface TerminalUnusualResponse {
  readonly status: 'OK' | 'NO_DATA';
  readonly asOfUtcSec: number;
  readonly symbol: string | null;
  readonly received: number;
  readonly accepted: number;
  readonly filteredOut: number;
  readonly trades: readonly SerializedUnusualTradeRow[];
}

export type RuntimeWsBroadcast =
  | {
      readonly type: 'bar_update';
      readonly cluster: 'stocks' | 'options';
      readonly symbol: string;
      readonly time: number;
      readonly formingBar: SerializedBar | null;
      readonly lastClosedBar: SerializedBar | null;
      readonly projectedEma21: number | null;
      readonly projectedSessionVwap: number | null;
      readonly projectedAvwap: number | null;
      readonly serverTimeSec: number;
    }
  | {
      readonly type: 'trade';
      readonly cluster: 'stocks' | 'options';
      readonly symbol: string;
      readonly time: number;
      readonly price: number;
      readonly size: number;
    }
  | {
      readonly type: 'quote';
      readonly cluster: 'stocks' | 'options';
      readonly symbol: string;
      readonly time: number;
      readonly bid: number | null;
      readonly ask: number | null;
      readonly mid: number | null;
    }
  | {
      readonly type: 'status';
      readonly cluster: 'stocks' | 'options';
      readonly state: string;
      readonly message: string;
      readonly time: number;
    }
  | {
      /** Pieza 39: tick-by-tick GGAL (ADR/ARS/CCL) con vela abierta mutada e
       * indicadores proyectados (EMA 9/21/50/200, VWAP sesión, AVWAP anclado). */
      readonly type: 'ggal_bar_tick';
      readonly symbol: 'GGAL';
      readonly mode: 'ADR' | 'ARS' | 'CCL';
      readonly timeframe: '1m' | '5m' | '15m' | '1h' | '4h' | '1D';
      readonly bar: {
        readonly timeSec: number;
        readonly open: number;
        readonly high: number;
        readonly low: number;
        readonly close: number;
        readonly volume: number;
      };
      readonly indicatorsPoint: {
        readonly timeSec: number;
        readonly ema9: number | null;
        readonly ema21: number | null;
        readonly ema50: number | null;
        readonly ema200: number | null;
        readonly sessionVwap: number | null;
        readonly avwap: number | null;
        readonly avwapPlus1Sigma: number | null;
        readonly avwapMinus1Sigma: number | null;
      };
      readonly serverTimeSec: number;
    };

export interface MassiveWsClientLike {
  connect(): Promise<void>;
  subscribe(channels: string | readonly string[]): void;
  unsubscribe(channels: string | readonly string[]): void;
  close(code?: number, reason?: string): void;
  getSnapshot(): WsClientSnapshot;
}

export interface MarketRuntimeDeps {
  readonly apiKey?: string;
  readonly secrets?: readonly string[];
  readonly baseUrl?: string;
  readonly fetchFn?: FetchFn;
  readonly loadBarsFn?: typeof loadBars;
  readonly loadOptionChainFn?: typeof loadOptionChain;
  readonly loadOptionContractsFn?: typeof loadOptionContracts;
  readonly loadTreasuryYieldsFn?: typeof loadTreasuryYields;
  readonly loadFundingConditionsFn?: typeof loadFundingConditions;
  readonly loadUnifiedSnapshotFn?: typeof loadUnifiedSnapshot;
  readonly loadDividendsFn?: typeof loadDividends;
  readonly loadUnusualTradesFn?: typeof loadUnusualTrades;
  readonly createWsClientFn?: (options: MassiveWsClientOptions) => MassiveWsClientLike;
  readonly nowMsFn?: () => number;
  readonly ttlResolver?: (nowMs: number) => number;
  readonly enableWs?: boolean;
  readonly watchedSymbols?: readonly string[];
  /** Pieza 32: configuración Tradier inyectada explícitamente (tests/harness). */
  readonly tradierConfig?: TradierConfig;
  /** Pieza 32: manager Tradier pre-construido (tests/harness). */
  readonly tradierManager?: TradierLiveManager;
  /** Pieza 32: funciones Tradier inyectables para determinismo en tests. */
  readonly tradierChainFetchFn?: typeof fetchTradierOptionChain;
  readonly tradierQuotesFetchFn?: typeof fetchTradierQuotes;
  /** Pieza 41: configuración FMP inyectada (tests/harness); producción lee `process.env`. */
  readonly fmpConfig?: FmpConfig;
  /** Pieza 41: modo stocks Massive inyectado para tests; producción resuelve por env. */
  readonly massiveStocksMode?: ReturnType<typeof resolveMassiveStocksMode>;
  /** Pieza 41: habilita el REST histórico Tradier en harness; producción siempre true. */
  readonly tradierHistoricalBars?: boolean;
  /** Pieza 36: cliente ORATS inyectable; tests offline sin inyección quedan UNAVAILABLE. */
  readonly oratsClient?: OratsHybridClient | null;
  /** Pieza 42: inyección de socket/http Tradier para pruebas de flujo WS offline. */
  readonly tradierCreateSocketFn?: TradierSocketFactory;
  readonly tradierHttpFn?: TradierHttpFn;
}

interface ParsedSymbol {
  readonly canonicalSymbol: string;
  readonly referenceUnderlying: string;
  readonly correlatedSymbol: string;
  readonly isIndex: boolean;
}

interface ExpiryParityEvaluation {
  readonly expirySec: number;
  readonly expirationDate: string;
  readonly timeToExpiry: number;
  readonly rate: number;
  readonly forward: number;
  readonly dividendYield: number;
}

interface SlicePackage {
  readonly parity: ExpiryParityEvaluation;
  readonly slice: VolSlice;
  readonly metrics: VolSliceMetrics;
  readonly isButterflyArbitrageFree: boolean;
  readonly butterflyMinDensity: number;
}

export const DEFAULT_RELATIONS_US_TICKERS = [
  'YPF',
  'VIST',
  'SPY',
  'QQQ',
  'IWM',
  'XLF',
  'XLE',
  'HYG',
  'LQD',
  'TLT',
  'GLD',
  'EWZ',
  'GGAL',
  'BMA',
  'PAM',
] as const;

export type UsEquitySector =
  | 'Mega Caps / Tech'
  | 'Semiconductores'
  | 'Finanzas'
  | 'Consumo'
  | 'Energía'
  | 'Salud'
  | 'Industrial'
  | 'Índices / ETF';

export interface UsEquityUniverseMeta {
  readonly symbol: string;
  readonly name: string;
  readonly sector: UsEquitySector;
  readonly panel: 'Líder' | 'General';
  readonly color: string;
  readonly hasUsOptions: boolean;
}

function makeGeneralUsEquityMeta(
  symbol: string,
  name: string,
  sector: UsEquitySector,
  color: string,
): UsEquityUniverseMeta {
  return {
    symbol,
    name,
    sector,
    panel: 'General',
    color,
    hasUsOptions: false,
  };
}

/**
 * Universo líquido US (162 acciones, ETFs sectoriales y ADRs) para análisis
 * sectorial, volatilidad, beta contra SPY y rotación de volumen 40 ruedas.
 * Pieza 35: se amplía con AI/Space/Nuclear/crypto/data-center sin alterar las
 * 8 categorías sectoriales existentes ni el panel líder.
 */
export const US_EQUITY_UNIVERSE: readonly UsEquityUniverseMeta[] = [
  // Mega Caps / Tech
  { symbol: 'AAPL', name: 'Apple Inc.', sector: 'Mega Caps / Tech', panel: 'Líder', color: '#4BA3FF', hasUsOptions: true },
  { symbol: 'MSFT', name: 'Microsoft Corp.', sector: 'Mega Caps / Tech', panel: 'Líder', color: '#00A4EF', hasUsOptions: true },
  { symbol: 'NVDA', name: 'NVIDIA Corp.', sector: 'Mega Caps / Tech', panel: 'Líder', color: '#2EDC7E', hasUsOptions: true },
  { symbol: 'AMZN', name: 'Amazon.com Inc.', sector: 'Mega Caps / Tech', panel: 'Líder', color: '#FF9900', hasUsOptions: true },
  { symbol: 'GOOGL', name: 'Alphabet Inc.', sector: 'Mega Caps / Tech', panel: 'Líder', color: '#F5B544', hasUsOptions: true },
  { symbol: 'META', name: 'Meta Platforms', sector: 'Mega Caps / Tech', panel: 'Líder', color: '#38BDF8', hasUsOptions: true },
  { symbol: 'TSLA', name: 'Tesla Inc.', sector: 'Mega Caps / Tech', panel: 'Líder', color: '#E82127', hasUsOptions: true },
  { symbol: 'CRM', name: 'Salesforce Inc.', sector: 'Mega Caps / Tech', panel: 'General', color: '#00A1E0', hasUsOptions: true },
  { symbol: 'ORCL', name: 'Oracle Corp.', sector: 'Mega Caps / Tech', panel: 'General', color: '#F80000', hasUsOptions: true },
  { symbol: 'NFLX', name: 'Netflix Inc.', sector: 'Mega Caps / Tech', panel: 'General', color: '#E50914', hasUsOptions: true },
  // Semiconductores
  { symbol: 'AVGO', name: 'Broadcom Inc.', sector: 'Semiconductores', panel: 'Líder', color: '#CC092F', hasUsOptions: true },
  { symbol: 'AMD', name: 'Advanced Micro Devices', sector: 'Semiconductores', panel: 'Líder', color: '#8B7CF6', hasUsOptions: true },
  { symbol: 'TSM', name: 'Taiwan Semiconductor', sector: 'Semiconductores', panel: 'Líder', color: '#6366F1', hasUsOptions: true },
  { symbol: 'INTC', name: 'Intel Corp.', sector: 'Semiconductores', panel: 'General', color: '#0071C5', hasUsOptions: true },
  { symbol: 'QCOM', name: 'Qualcomm Inc.', sector: 'Semiconductores', panel: 'General', color: '#3253DC', hasUsOptions: true },
  { symbol: 'MU', name: 'Micron Technology', sector: 'Semiconductores', panel: 'General', color: '#06B6D4', hasUsOptions: true },
  // Finanzas
  { symbol: 'JPM', name: 'JPMorgan Chase', sector: 'Finanzas', panel: 'Líder', color: '#60A5FA', hasUsOptions: true },
  { symbol: 'BAC', name: 'Bank of America', sector: 'Finanzas', panel: 'Líder', color: '#E31837', hasUsOptions: true },
  { symbol: 'WFC', name: 'Wells Fargo & Co.', sector: 'Finanzas', panel: 'General', color: '#D71E28', hasUsOptions: true },
  { symbol: 'GS', name: 'Goldman Sachs Group', sector: 'Finanzas', panel: 'Líder', color: '#7399C6', hasUsOptions: true },
  { symbol: 'MS', name: 'Morgan Stanley', sector: 'Finanzas', panel: 'General', color: '#3B82F6', hasUsOptions: true },
  { symbol: 'C', name: 'Citigroup Inc.', sector: 'Finanzas', panel: 'General', color: '#003B70', hasUsOptions: true },
  { symbol: 'V', name: 'Visa Inc.', sector: 'Finanzas', panel: 'Líder', color: '#1A1F71', hasUsOptions: true },
  { symbol: 'MA', name: 'Mastercard Inc.', sector: 'Finanzas', panel: 'Líder', color: '#EB001B', hasUsOptions: true },
  { symbol: 'BRK.B', name: 'Berkshire Hathaway B', sector: 'Finanzas', panel: 'Líder', color: '#A78BFA', hasUsOptions: true },
  { symbol: 'BLK', name: 'BlackRock Inc.', sector: 'Finanzas', panel: 'General', color: '#94A3B8', hasUsOptions: true },
  { symbol: 'NU', name: 'Nu Holdings', sector: 'Finanzas', panel: 'General', color: '#820AD1', hasUsOptions: true },
  { symbol: 'GGAL', name: 'Grupo Fin. Galicia ADR', sector: 'Finanzas', panel: 'General', color: '#4BA3FF', hasUsOptions: true },
  { symbol: 'BMA', name: 'Banco Macro ADR', sector: 'Finanzas', panel: 'General', color: '#8B7CF6', hasUsOptions: true },
  // Consumo
  { symbol: 'WMT', name: 'Walmart Inc.', sector: 'Consumo', panel: 'Líder', color: '#0071CE', hasUsOptions: true },
  { symbol: 'COST', name: 'Costco Wholesale', sector: 'Consumo', panel: 'Líder', color: '#E31837', hasUsOptions: true },
  { symbol: 'KO', name: 'Coca-Cola Co.', sector: 'Consumo', panel: 'Líder', color: '#F40009', hasUsOptions: true },
  { symbol: 'PEP', name: 'PepsiCo Inc.', sector: 'Consumo', panel: 'General', color: '#004B93', hasUsOptions: true },
  { symbol: 'MCD', name: "McDonald's Corp.", sector: 'Consumo', panel: 'General', color: '#FFC72C', hasUsOptions: true },
  { symbol: 'NKE', name: 'Nike Inc.', sector: 'Consumo', panel: 'General', color: '#F97316', hasUsOptions: true },
  { symbol: 'HD', name: 'Home Depot Inc.', sector: 'Consumo', panel: 'General', color: '#F96302', hasUsOptions: true },
  { symbol: 'DIS', name: 'Walt Disney Co.', sector: 'Consumo', panel: 'General', color: '#38BDF8', hasUsOptions: true },
  { symbol: 'PG', name: 'Procter & Gamble', sector: 'Consumo', panel: 'General', color: '#003DA5', hasUsOptions: true },
  { symbol: 'MELI', name: 'MercadoLibre Inc.', sector: 'Consumo', panel: 'Líder', color: '#FFE600', hasUsOptions: true },
  // Energía
  { symbol: 'XOM', name: 'Exxon Mobil Corp.', sector: 'Energía', panel: 'Líder', color: '#FF5468', hasUsOptions: true },
  { symbol: 'CVX', name: 'Chevron Corp.', sector: 'Energía', panel: 'Líder', color: '#005A9C', hasUsOptions: true },
  { symbol: 'SLB', name: 'SLB (Schlumberger)', sector: 'Energía', panel: 'General', color: '#004B87', hasUsOptions: true },
  { symbol: 'COP', name: 'ConocoPhillips', sector: 'Energía', panel: 'General', color: '#DC2626', hasUsOptions: true },
  { symbol: 'OXY', name: 'Occidental Petroleum', sector: 'Energía', panel: 'General', color: '#EF4444', hasUsOptions: true },
  { symbol: 'PBR', name: 'Petrobras ADR', sector: 'Energía', panel: 'General', color: '#10B981', hasUsOptions: true },
  { symbol: 'YPF', name: 'YPF S.A. ADR', sector: 'Energía', panel: 'General', color: '#38BDF8', hasUsOptions: true },
  { symbol: 'VIST', name: 'Vista Energy ADR', sector: 'Energía', panel: 'General', color: '#2EDC7E', hasUsOptions: true },
  { symbol: 'PAM', name: 'Pampa Energía ADR', sector: 'Energía', panel: 'General', color: '#F59E0B', hasUsOptions: true },
  // Salud
  { symbol: 'LLY', name: 'Eli Lilly & Co.', sector: 'Salud', panel: 'Líder', color: '#D52B1E', hasUsOptions: true },
  { symbol: 'UNH', name: 'UnitedHealth Group', sector: 'Salud', panel: 'Líder', color: '#002677', hasUsOptions: true },
  { symbol: 'JNJ', name: 'Johnson & Johnson', sector: 'Salud', panel: 'General', color: '#D51900', hasUsOptions: true },
  { symbol: 'PFE', name: 'Pfizer Inc.', sector: 'Salud', panel: 'General', color: '#0093D0', hasUsOptions: true },
  { symbol: 'ABBV', name: 'AbbVie Inc.', sector: 'Salud', panel: 'General', color: '#071D49', hasUsOptions: true },
  { symbol: 'MRK', name: 'Merck & Co.', sector: 'Salud', panel: 'General', color: '#00857C', hasUsOptions: true },
  // Industrial
  { symbol: 'CAT', name: 'Caterpillar Inc.', sector: 'Industrial', panel: 'Líder', color: '#FFCD11', hasUsOptions: true },
  { symbol: 'BA', name: 'Boeing Co.', sector: 'Industrial', panel: 'Líder', color: '#1D4ED8', hasUsOptions: true },
  { symbol: 'GE', name: 'GE Aerospace', sector: 'Industrial', panel: 'General', color: '#3B82F6', hasUsOptions: true },
  { symbol: 'HON', name: 'Honeywell Intl.', sector: 'Industrial', panel: 'General', color: '#EE3124', hasUsOptions: true },
  { symbol: 'UPS', name: 'United Parcel Service', sector: 'Industrial', panel: 'General', color: '#92400E', hasUsOptions: true },
  { symbol: 'DE', name: 'Deere & Co.', sector: 'Industrial', panel: 'General', color: '#367C2B', hasUsOptions: true },
  { symbol: 'LMT', name: 'Lockheed Martin', sector: 'Industrial', panel: 'General', color: '#0EA5E9', hasUsOptions: true },
  // Índices / ETF
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF', sector: 'Índices / ETF', panel: 'Líder', color: '#2EDC7E', hasUsOptions: true },
  { symbol: 'QQQ', name: 'Invesco QQQ Trust', sector: 'Índices / ETF', panel: 'Líder', color: '#8B7CF6', hasUsOptions: true },
  { symbol: 'IWM', name: 'iShares Russell 2000', sector: 'Índices / ETF', panel: 'Líder', color: '#F59E0B', hasUsOptions: true },
  { symbol: 'DIA', name: 'SPDR Dow Jones ETF', sector: 'Índices / ETF', panel: 'Líder', color: '#60A5FA', hasUsOptions: true },
  { symbol: 'XLF', name: 'Financial Select ETF', sector: 'Índices / ETF', panel: 'General', color: '#3B82F6', hasUsOptions: true },
  { symbol: 'XLE', name: 'Energy Select ETF', sector: 'Índices / ETF', panel: 'General', color: '#EF4444', hasUsOptions: true },
  { symbol: 'XLK', name: 'Technology Select ETF', sector: 'Índices / ETF', panel: 'General', color: '#8B5CF6', hasUsOptions: true },
  { symbol: 'XLV', name: 'Health Care Select ETF', sector: 'Índices / ETF', panel: 'General', color: '#14B8A6', hasUsOptions: true },
  { symbol: 'XLI', name: 'Industrial Select ETF', sector: 'Índices / ETF', panel: 'General', color: '#F97316', hasUsOptions: true },
  { symbol: 'GLD', name: 'SPDR Gold Shares', sector: 'Índices / ETF', panel: 'General', color: '#F5B544', hasUsOptions: true },
  { symbol: 'SLV', name: 'iShares Silver Trust', sector: 'Índices / ETF', panel: 'General', color: '#94A3B8', hasUsOptions: true },
  { symbol: 'EWZ', name: 'iShares MSCI Brazil', sector: 'Índices / ETF', panel: 'General', color: '#22C55E', hasUsOptions: true },
  // Pieza 35: expansión AI / Space / Nuclear / data-center / fintech / consumo.
  makeGeneralUsEquityMeta('IREN', 'Iris Energy Ltd.', 'Energía', '#38BDF8'),
  makeGeneralUsEquityMeta('CRWV', 'CoreWeave Inc.', 'Mega Caps / Tech', '#8B7CF6'),
  makeGeneralUsEquityMeta('ASTS', 'AST SpaceMobile Inc.', 'Industrial', '#38BDF8'),
  makeGeneralUsEquityMeta('RKLB', 'Rocket Lab USA Inc.', 'Industrial', '#2EDC7E'),
  makeGeneralUsEquityMeta('LUNR', 'Intuitive Machines Inc.', 'Industrial', '#F5B544'),
  makeGeneralUsEquityMeta('NBIS', 'Nebius Group N.V.', 'Mega Caps / Tech', '#8B7CF6'),
  makeGeneralUsEquityMeta('CLSK', 'CleanSpark Inc.', 'Finanzas', '#2EDC7E'),
  makeGeneralUsEquityMeta('MARA', 'Marathon Digital Holdings Inc.', 'Finanzas', '#F5B544'),
  makeGeneralUsEquityMeta('RIOT', 'Riot Platforms Inc.', 'Finanzas', '#38BDF8'),
  makeGeneralUsEquityMeta('WULF', 'TeraWulf Inc.', 'Energía', '#2EDC7E'),
  makeGeneralUsEquityMeta('CORZ', 'Core Scientific Inc.', 'Energía', '#38BDF8'),
  makeGeneralUsEquityMeta('HUT', 'Hut 8 Corp.', 'Energía', '#F5B544'),
  makeGeneralUsEquityMeta('OKLO', 'Oklo Inc.', 'Energía', '#2EDC7E'),
  makeGeneralUsEquityMeta('SMR', 'NuScale Power Corp.', 'Energía', '#38BDF8'),
  makeGeneralUsEquityMeta('VST', 'Vistra Corp.', 'Energía', '#F5B544'),
  makeGeneralUsEquityMeta('CEG', 'Constellation Energy Corp.', 'Energía', '#2EDC7E'),
  makeGeneralUsEquityMeta('GEV', 'GE Vernova Inc.', 'Energía', '#38BDF8'),
  makeGeneralUsEquityMeta('VRT', 'Vertiv Holdings Co.', 'Industrial', '#8B7CF6'),
  makeGeneralUsEquityMeta('ETN', 'Eaton Corp. plc', 'Industrial', '#38BDF8'),
  makeGeneralUsEquityMeta('ANET', 'Arista Networks Inc.', 'Mega Caps / Tech', '#2EDC7E'),
  makeGeneralUsEquityMeta('MRVL', 'Marvell Technology Inc.', 'Semiconductores', '#F5B544'),
  makeGeneralUsEquityMeta('ARM', 'Arm Holdings plc', 'Semiconductores', '#38BDF8'),
  makeGeneralUsEquityMeta('TXN', 'Texas Instruments Inc.', 'Semiconductores', '#2EDC7E'),
  makeGeneralUsEquityMeta('AMAT', 'Applied Materials Inc.', 'Semiconductores', '#F5B544'),
  makeGeneralUsEquityMeta('LRCX', 'Lam Research Corp.', 'Semiconductores', '#38BDF8'),
  makeGeneralUsEquityMeta('KLAC', 'KLA Corp.', 'Semiconductores', '#2EDC7E'),
  makeGeneralUsEquityMeta('ASML', 'ASML Holding N.V.', 'Semiconductores', '#F5B544'),
  makeGeneralUsEquityMeta('SNOW', 'Snowflake Inc.', 'Mega Caps / Tech', '#38BDF8'),
  makeGeneralUsEquityMeta('DDOG', 'Datadog Inc.', 'Mega Caps / Tech', '#2EDC7E'),
  makeGeneralUsEquityMeta('NET', 'Cloudflare Inc.', 'Mega Caps / Tech', '#F5B544'),
  makeGeneralUsEquityMeta('CRWD', 'CrowdStrike Holdings Inc.', 'Mega Caps / Tech', '#38BDF8'),
  makeGeneralUsEquityMeta('PANW', 'Palo Alto Networks Inc.', 'Mega Caps / Tech', '#2EDC7E'),
  makeGeneralUsEquityMeta('ZS', 'Zscaler Inc.', 'Mega Caps / Tech', '#F5B544'),
  makeGeneralUsEquityMeta('FTNT', 'Fortinet Inc.', 'Mega Caps / Tech', '#38BDF8'),
  makeGeneralUsEquityMeta('MDB', 'MongoDB Inc.', 'Mega Caps / Tech', '#2EDC7E'),
  makeGeneralUsEquityMeta('SHOP', 'Shopify Inc.', 'Mega Caps / Tech', '#F5B544'),
  makeGeneralUsEquityMeta('SQ', 'Block Inc.', 'Finanzas', '#38BDF8'),
  makeGeneralUsEquityMeta('AFRM', 'Affirm Holdings Inc.', 'Finanzas', '#2EDC7E'),
  makeGeneralUsEquityMeta('UPST', 'Upstart Holdings Inc.', 'Finanzas', '#F5B544'),
  makeGeneralUsEquityMeta('SOFI', 'SoFi Technologies Inc.', 'Finanzas', '#38BDF8'),
  makeGeneralUsEquityMeta('HOOD', 'Robinhood Markets Inc.', 'Finanzas', '#2EDC7E'),
  makeGeneralUsEquityMeta('COIN', 'Coinbase Global Inc.', 'Finanzas', '#F5B544'),
  makeGeneralUsEquityMeta('MSTR', 'MicroStrategy Inc.', 'Finanzas', '#38BDF8'),
  makeGeneralUsEquityMeta('RBLX', 'Roblox Corp.', 'Mega Caps / Tech', '#2EDC7E'),
  makeGeneralUsEquityMeta('U', 'Unity Software Inc.', 'Mega Caps / Tech', '#F5B544'),
  makeGeneralUsEquityMeta('APP', 'AppLovin Corp.', 'Mega Caps / Tech', '#38BDF8'),
  makeGeneralUsEquityMeta('DUOL', 'Duolingo Inc.', 'Mega Caps / Tech', '#2EDC7E'),
  makeGeneralUsEquityMeta('SPOT', 'Spotify Technology S.A.', 'Mega Caps / Tech', '#F5B544'),
  makeGeneralUsEquityMeta('ABNB', 'Airbnb Inc.', 'Mega Caps / Tech', '#38BDF8'),
  makeGeneralUsEquityMeta('UBER', 'Uber Technologies Inc.', 'Mega Caps / Tech', '#2EDC7E'),
  makeGeneralUsEquityMeta('DASH', 'DoorDash Inc.', 'Mega Caps / Tech', '#F5B544'),
  makeGeneralUsEquityMeta('BKNG', 'Booking Holdings Inc.', 'Mega Caps / Tech', '#38BDF8'),
  makeGeneralUsEquityMeta('LULU', 'lululemon athletica inc.', 'Consumo', '#2EDC7E'),
  makeGeneralUsEquityMeta('SBUX', 'Starbucks Corp.', 'Consumo', '#F5B544'),
  makeGeneralUsEquityMeta('CMG', 'Chipotle Mexican Grill Inc.', 'Consumo', '#38BDF8'),
  makeGeneralUsEquityMeta('TGT', 'Target Corp.', 'Consumo', '#2EDC7E'),
  makeGeneralUsEquityMeta('LOW', "Lowe's Companies Inc.", 'Consumo', '#F5B544'),
  makeGeneralUsEquityMeta('RTX', 'RTX Corp.', 'Industrial', '#38BDF8'),
  makeGeneralUsEquityMeta('NOC', 'Northrop Grumman Corp.', 'Industrial', '#2EDC7E'),
  makeGeneralUsEquityMeta('GD', 'General Dynamics Corp.', 'Industrial', '#F5B544'),
  makeGeneralUsEquityMeta('UNP', 'Union Pacific Corp.', 'Industrial', '#38BDF8'),
  makeGeneralUsEquityMeta('FDX', 'FedEx Corp.', 'Industrial', '#2EDC7E'),
  makeGeneralUsEquityMeta('HAL', 'Halliburton Co.', 'Energía', '#F5B544'),
  makeGeneralUsEquityMeta('FCX', 'Freeport-McMoRan Inc.', 'Energía', '#38BDF8'),
  makeGeneralUsEquityMeta('NEM', 'Newmont Corp.', 'Energía', '#2EDC7E'),
  makeGeneralUsEquityMeta('AA', 'Alcoa Corp.', 'Energía', '#F5B544'),
  makeGeneralUsEquityMeta('NUE', 'Nucor Corp.', 'Industrial', '#38BDF8'),
  makeGeneralUsEquityMeta('SCHW', 'Charles Schwab Corp.', 'Finanzas', '#2EDC7E'),
  makeGeneralUsEquityMeta('AXP', 'American Express Co.', 'Finanzas', '#F5B544'),
  makeGeneralUsEquityMeta('NVO', 'Novo Nordisk A/S', 'Salud', '#38BDF8'),
  makeGeneralUsEquityMeta('ISRG', 'Intuitive Surgical Inc.', 'Salud', '#2EDC7E'),
  makeGeneralUsEquityMeta('TMO', 'Thermo Fisher Scientific Inc.', 'Salud', '#F5B544'),
  makeGeneralUsEquityMeta('DHR', 'Danaher Corp.', 'Salud', '#38BDF8'),
  makeGeneralUsEquityMeta('AMGN', 'Amgen Inc.', 'Salud', '#2EDC7E'),
  makeGeneralUsEquityMeta('GILD', 'Gilead Sciences Inc.', 'Salud', '#F5B544'),
  makeGeneralUsEquityMeta('BIIB', 'Biogen Inc.', 'Salud', '#38BDF8'),
  makeGeneralUsEquityMeta('MRNA', 'Moderna Inc.', 'Salud', '#2EDC7E'),
  makeGeneralUsEquityMeta('VKTX', 'Viking Therapeutics Inc.', 'Salud', '#F5B544'),
  makeGeneralUsEquityMeta('HIMS', 'Hims & Hers Health Inc.', 'Salud', '#38BDF8'),
  makeGeneralUsEquityMeta('TEM', 'Tempus AI Inc.', 'Salud', '#2EDC7E'),
  makeGeneralUsEquityMeta('RXRX', 'Recursion Pharmaceuticals Inc.', 'Salud', '#F5B544'),
  makeGeneralUsEquityMeta('IONQ', 'IonQ Inc.', 'Semiconductores', '#38BDF8'),
  makeGeneralUsEquityMeta('RGTI', 'Rigetti Computing Inc.', 'Semiconductores', '#2EDC7E'),
  makeGeneralUsEquityMeta('QBTS', 'D-Wave Quantum Inc.', 'Semiconductores', '#F5B544'),
  makeGeneralUsEquityMeta('SOUN', 'SoundHound AI Inc.', 'Semiconductores', '#38BDF8'),
  makeGeneralUsEquityMeta('BBAI', 'BigBear.ai Holdings Inc.', 'Semiconductores', '#2EDC7E'),
  makeGeneralUsEquityMeta('PATH', 'UiPath Inc.', 'Mega Caps / Tech', '#F5B544'),
  makeGeneralUsEquityMeta('AI', 'C3.ai Inc.', 'Mega Caps / Tech', '#38BDF8'),
  makeGeneralUsEquityMeta('PLTR', 'Palantir Technologies Inc.', 'Mega Caps / Tech', '#101010'),
] as const;

/**
 * Pieza 50.5: ETFs líquidos US (sector 'Índices / ETF' del universo + TLT/HYG)
 * usados para elegir el calendario macro FOMC/CPI como fuente de eventos del
 * Motor Auto-AVWAP. Los índices puros se resuelven vía `KNOWN_INDEX_ROOTS`.
 */
const US_INDEX_ETF_SYMBOLS: ReadonlySet<string> = new Set<string>([
  ...US_EQUITY_UNIVERSE.filter((meta) => meta.sector === 'Índices / ETF').map((meta) => meta.symbol),
  'TLT',
  'HYG',
]);

/** Pieza 50.5: `true` si el símbolo canónico es índice puro (`I:SPX`) o ETF US. */
function isIndexOrEtfSymbol(canonicalSymbol: string): boolean {
  const stripped = canonicalSymbol.startsWith('I:') ? canonicalSymbol.slice(2) : canonicalSymbol;
  return KNOWN_INDEX_ROOTS.has(stripped) || US_INDEX_ETF_SYMBOLS.has(stripped);
}

export const US_EQUITY_META_MAP: ReadonlyMap<string, UsEquityUniverseMeta> = new Map(
  US_EQUITY_UNIVERSE.map((m) => [m.symbol, m]),
);

export const US_LIQUID_OPTION_UNDERLYINGS: ReadonlySet<string> = new Set([
  ...US_EQUITY_UNIVERSE.filter((u) => u.hasUsOptions).map((u) => u.symbol),
  'BABA',
  'GLOB',
]);

/**
 * Tick-by-tick US panel: los ~73 símbolos líquidos del panel EE.UU. (acciones,
 * ETFs sectoriales y ADRs ya presentes en `US_EQUITY_UNIVERSE`).
 */
export const US_PANEL_TICKERS: readonly string[] = US_EQUITY_UNIVERSE.map((u) => u.symbol);

/**
 * ADRs argentinos listados en NYSE/NASDAQ, derivados de `AR_STOCK_META`
 * (adrTicker). Complementan el panel US para los overlays CEDEAR/ADR del
 * Monitoreo: los que ya están en `US_EQUITY_UNIVERSE` no se duplican.
 */
export const US_ADR_TICKERS: readonly string[] = [
  'GGAL',
  'YPF',
  'PAM',
  'BMA',
  'SUPV',
  'BBAR',
  'CEPU',
  'TGS',
  'EDN',
  'TEO',
  'LOMA',
  'CRESY',
  'IRS',
] as const;

/**
 * Universo completo suscrito por tick (WS `T.<símbolo>` + batch REST):
 * panel de 73 + ADRs argentinos + ETFs índice + VIX. Sin duplicados.
 */
export const US_STREAM_SYMBOLS: readonly string[] = [
  ...new Set([
    ...US_PANEL_TICKERS,
    ...US_ADR_TICKERS,
    'SPY',
    'QQQ',
    'IWM',
    'DIA',
    'I:VIX',
  ]),
] as const;

/**
 * Pieza 40: núcleo líquido suscripto por WS sin wildcards. Los tickers BYMA
 * solicitados se mapean a sus ADR reales (YPFD→YPF, PAMP→PAM, TGSU2→TGS,
 * CRES→CRESY). `I:VIX` sigue disponible por batch REST para la UI actual.
 */
export const MASSIVE_WS_CORE_SYMBOLS: readonly string[] = [
  'SPY',
  'QQQ',
  'IWM',
  'DIA',
  'VIXY',
  'GGAL',
  'YPF',
  'BMA',
  'PAM',
  'BBAR',
  'SUPV',
  'TGS',
  'CEPU',
  'CRESY',
  'EDN',
  'LOMA',
  'MELI',
  'NVDA',
  'AAPL',
  'MSFT',
  'AMZN',
  'META',
  'TSLA',
  'GOOGL',
  'KO',
  'EWZ',
  'IBIT',
] as const;

export interface OptionsUnderlyingMetaDto {
  /** Clave estable para el selector: GGAL BYMA es `GGAL`; el ADR es `US:GGAL`. */
  readonly key: string;
  readonly symbol: string;
  readonly market: 'AR' | 'US';
  readonly venue: 'BYMA' | 'OPRA';
  readonly currency: 'ARS' | 'USD';
  readonly name: string;
  readonly sector: string;
  readonly color: string;
}

/** Extensión exclusiva del selector de Opciones (Pieza 36), sin alterar el panel. */
const OPTIONS_ONLY_US_EXTENSIONS: readonly OptionsUnderlyingMetaDto[] = [
  {
    key: 'IBIT',
    symbol: 'IBIT',
    market: 'US',
    venue: 'OPRA',
    currency: 'USD',
    name: 'iShares Bitcoin Trust ETF',
    sector: 'Índices / ETF',
    color: '#F7931A',
  },
] as const;

export const OPTIONS_UNDERLYING_UNIVERSE: readonly OptionsUnderlyingMetaDto[] = [
  ...US_EQUITY_UNIVERSE.map((meta): OptionsUnderlyingMetaDto => ({
    key: meta.symbol === 'GGAL' ? 'US:GGAL' : meta.symbol,
    symbol: meta.symbol,
    market: 'US',
    venue: 'OPRA',
    currency: 'USD',
    name: meta.name,
    sector: meta.sector,
    color: meta.color,
  })),
  ...OPTIONS_ONLY_US_EXTENSIONS,
  {
    key: 'GGAL',
    symbol: 'GGAL',
    market: 'AR',
    venue: 'BYMA',
    currency: 'ARS',
    name: 'Grupo Financiero Galicia',
    sector: 'Bancos',
    color: '#8B7CF6',
  },
];

export const OPTIONS_UNDERLYING_BY_KEY: ReadonlyMap<string, OptionsUnderlyingMetaDto> = new Map(
  OPTIONS_UNDERLYING_UNIVERSE.map((meta) => [meta.key, meta]),
);

export interface UsOptionExpiryCandidate {
  readonly expirationDate: string;
  readonly daysToExpiry: number;
  readonly loaded: boolean;
  readonly validCallCount: number;
  readonly validPutCount: number;
  readonly nearAtmLiquidity: number;
  readonly inDefaultWindow: boolean;
  readonly hasCompleteAtmChain: boolean;
}

export interface UsOptionExpirySelection {
  readonly defaultExpirationDate: string | null;
  readonly prefetchExpirationDates: readonly string[];
  readonly availableExpirations: readonly UsOptionExpiryCandidate[];
  readonly reason: string | null;
}

function isValidOptionQuote(contract: OptionSnapshotContract): boolean {
  const { bid, ask } = contract.lastQuote;
  if (Number.isFinite(bid) && bid >= 0 && Number.isFinite(ask) && ask > 0) return true;
  return Number.isFinite(contract.lastTrade.price) && contract.lastTrade.price > 0;
}

function isNearAtm(contract: OptionSnapshotContract, spot: number): boolean {
  return Number.isFinite(spot) && spot > 0 && Math.abs(contract.strikePrice - spot) <= spot * 0.15;
}

function liquidityValue(contract: OptionSnapshotContract): number {
  const volume = Number.isFinite(contract.day.volume) && contract.day.volume >= 0 ? contract.day.volume : 0;
  const openInterest = Number.isFinite(contract.openInterest) && contract.openInterest >= 0 ? contract.openInterest : 0;
  return volume + openInterest;
}

/**
 * Selección determinista del vencimiento US por defecto (Pieza 36):
 *  1) ventana 14–45 DTE con calls y puts usables alrededor de ATM;
 *  2) menor DTE y, ante empate, mayor liquidez cerca de ATM;
 *  3) si no hay candidatos, primer vencimiento con cadena ATM completa.
 * No hay fallback a 0–4 DTE con cadena incompleta.
 */
export function selectUsOptionExpirations(
  contracts: readonly OptionSnapshotContract[],
  spot: number,
  nowSec: number,
  requestedExpiration?: string,
): UsOptionExpirySelection {
  const byDate = new Map<string, OptionSnapshotContract[]>();
  for (const contract of contracts) {
    if (!(contract.expirationTime > nowSec + 60)) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(contract.expirationDate)) continue;
    const list = byDate.get(contract.expirationDate) ?? [];
    list.push(contract);
    byDate.set(contract.expirationDate, list);
  }

  const available: UsOptionExpiryCandidate[] = [];
  for (const [expirationDate, list] of byDate) {
    const validContracts = list.filter(isValidOptionQuote);
    const validCalls = validContracts.filter((c) => c.contractType === 'call');
    const validPuts = validContracts.filter((c) => c.contractType === 'put');
    const nearCalls = validCalls.filter((c) => isNearAtm(c, spot));
    const nearPuts = validPuts.filter((c) => isNearAtm(c, spot));
    const sampleExpirationTime = list[0]?.expirationTime ?? nowSec + 86_400;
    const dteEt = calendarDteEt(expirationDate, nowSec * 1_000);
    const approxDays = Math.max(0, Math.floor((sampleExpirationTime - nowSec) / 86_400));
    const daysToExpiry =
      Number.isFinite(dteEt) && Math.abs(dteEt - approxDays) <= 2 ? dteEt : approxDays;
    const hasCompleteAtmChain = nearCalls.length >= 2 && nearPuts.length >= 2;
    available.push({
      expirationDate,
      daysToExpiry,
      loaded: true,
      validCallCount: validCalls.length,
      validPutCount: validPuts.length,
      nearAtmLiquidity: [...nearCalls, ...nearPuts].reduce((sum, c) => sum + liquidityValue(c), 0),
      inDefaultWindow: daysToExpiry >= 14 && daysToExpiry <= 45,
      hasCompleteAtmChain,
    });
  }

  available.sort((a, b) => a.expirationDate.localeCompare(b.expirationDate));
  const complete = available.filter((e) => e.hasCompleteAtmChain);
  const windowed = complete.filter((e) => e.inDefaultWindow);
  const ranked = [...windowed]
    .sort((a, b) => a.daysToExpiry - b.daysToExpiry || b.nearAtmLiquidity - a.nearAtmLiquidity)
    .concat(
      complete
        .filter((e) => !e.inDefaultWindow)
        .sort((a, b) => a.daysToExpiry - b.daysToExpiry || b.nearAtmLiquidity - a.nearAtmLiquidity),
    );

  const requested = requestedExpiration?.trim() ?? '';
  const requestedCandidate =
    requested !== '' ? available.find((e) => e.expirationDate === requested) ?? null : null;
  if (requested !== '' && requestedCandidate === null) {
    return {
      defaultExpirationDate: ranked[0]?.expirationDate ?? null,
      prefetchExpirationDates: ranked.slice(0, 2).map((e) => e.expirationDate),
      availableExpirations: available,
      reason: `REQUESTED_EXPIRATION_NOT_AVAILABLE:${requested}`,
    };
  }

  const defaultCandidate = requestedCandidate ?? ranked[0] ?? null;
  if (defaultCandidate === null) {
    return {
      defaultExpirationDate: null,
      prefetchExpirationDates: [],
      availableExpirations: available,
      reason: 'NO_COMPLETE_ATM_OPTION_EXPIRY',
    };
  }

  const byLiquidity = [...complete]
    .filter((e) => e.expirationDate !== defaultCandidate.expirationDate)
    .sort((a, b) => b.nearAtmLiquidity - a.nearAtmLiquidity || a.daysToExpiry - b.daysToExpiry);
  const prefetch = [defaultCandidate.expirationDate, byLiquidity[0]?.expirationDate]
    .filter((date): date is string => typeof date === 'string')
    .slice(0, 2);

  return {
    defaultExpirationDate: defaultCandidate.expirationDate,
    prefetchExpirationDates: prefetch,
    availableExpirations: available,
    reason:
      requestedCandidate !== null
        ? 'REQUESTED_EXPIRATION_SELECTED'
        : windowed.length > 0
          ? 'DEFAULT_LIQUID_14_45_DTE'
          : 'FIRST_COMPLETE_ATM_EXPIRY',
  };
}

export interface CuratedUsExpirationsResult {
  readonly curatedExpirationDates: readonly string[];
  readonly reason: string | null;
}

/**
 * Pieza 50.1: selección curada de hasta 6 vencimientos US (0–60 DTE) a partir del
 * índice liviano de contratos de referencia, evitando paginar la ventana completa:
 *  1) `requestedExpiration` (si se pidió explícitamente, aunque no esté en el índice);
 *  2) front / próximo vencimiento líquido (≥ 0 DTE);
 *  3) próximos 2 semanales espaciados (2–13 DTE);
 *  4) mensual/líquido principal en ventana 14–45 DTE (mayor liquidez cerca de ATM);
 *  5) siguiente vencimiento en (mensual, 60 DTE] para habilitar estructura temporal.
 * Deduplicado y en orden ascendente; sin datos no inventa fechas.
 */
export function selectCuratedUsExpirations(
  contracts: readonly OptionContract[],
  spot: number,
  nowSec: number,
  requestedExpiration?: string,
): CuratedUsExpirationsResult {
  interface DateInfo {
    readonly expirationDate: string;
    readonly daysToExpiry: number;
    readonly nearAtmLiquidity: number;
    readonly expirationTime: number;
  }
  const isNearAtm = (strike: number): boolean =>
    Number.isFinite(spot) && spot > 0 && Math.abs(strike - spot) <= spot * 0.15;

  const byDate = new Map<string, DateInfo>();
  for (const contract of contracts) {
    const date = contract.expirationDate;
    if (!(contract.expirationTime > nowSec + 60)) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const existing = byDate.get(date);
    if (existing !== undefined) {
      if (isNearAtm(contract.strikePrice)) {
        byDate.set(date, { ...existing, nearAtmLiquidity: existing.nearAtmLiquidity + 1 });
      }
      continue;
    }
    const dteEt = calendarDteEt(date, nowSec * 1_000);
    const approxDays = Math.max(0, Math.floor((contract.expirationTime - nowSec) / 86_400));
    const daysToExpiry =
      Number.isFinite(dteEt) && Math.abs(dteEt - approxDays) <= 2 ? dteEt : approxDays;
    byDate.set(date, {
      expirationDate: date,
      daysToExpiry,
      nearAtmLiquidity: isNearAtm(contract.strikePrice) ? 1 : 0,
      expirationTime: contract.expirationTime,
    });
  }

  const all = [...byDate.values()].sort(
    (a, b) =>
      a.expirationTime - b.expirationTime || a.expirationDate.localeCompare(b.expirationDate),
  );

  const requested = requestedExpiration?.trim() ?? '';
  if (all.length === 0 && requested === '') {
    return { curatedExpirationDates: [], reason: 'NO_REFERENCE_EXPIRATIONS' };
  }

  const selected = new Set<string>();
  let reason: string | null = null;

  if (requested !== '') {
    if (byDate.has(requested)) {
      selected.add(requested);
    } else {
      const dteRequested = calendarDteEt(requested, nowSec * 1_000);
      if (
        /^\d{4}-\d{2}-\d{2}$/.test(requested) &&
        Number.isFinite(dteRequested) &&
        dteRequested >= 0
      ) {
        // Carga directa por fecha exacta aunque no esté en el índice liviano (máx 60–95 DTE).
        selected.add(requested);
      } else {
        reason = `REQUESTED_EXPIRATION_INVALID:${requested}`;
      }
    }
  }

  const front = all[0] ?? null;
  if (front !== null) {
    selected.add(front.expirationDate);
  }

  const weeklies = all.filter((d) => d.daysToExpiry >= 2 && d.daysToExpiry <= 13);
  let weekliesTaken = 0;
  let lastWeeklyDte: number | null = null;
  for (const weekly of weeklies) {
    if (weekliesTaken >= 2) break;
    if (lastWeeklyDte !== null && weekly.daysToExpiry - lastWeeklyDte < 2) continue;
    selected.add(weekly.expirationDate);
    lastWeeklyDte = weekly.daysToExpiry;
    weekliesTaken += 1;
  }

  const byLiquidity = (a: DateInfo, b: DateInfo): number =>
    b.nearAtmLiquidity - a.nearAtmLiquidity ||
    a.daysToExpiry - b.daysToExpiry ||
    a.expirationDate.localeCompare(b.expirationDate);

  const monthly =
    all.filter((d) => d.daysToExpiry >= 14 && d.daysToExpiry <= 45).sort(byLiquidity)[0] ?? null;
  if (monthly !== null) {
    selected.add(monthly.expirationDate);
  }

  const nextMonthlyFloor = monthly?.daysToExpiry ?? 30;
  const nextMonthly =
    all
      .filter((d) => d.daysToExpiry > nextMonthlyFloor && d.daysToExpiry <= 60)
      .sort(byLiquidity)[0] ?? null;
  if (nextMonthly !== null) {
    selected.add(nextMonthly.expirationDate);
  }

  const curatedExpirationDates = [...selected].sort((a, b) => a.localeCompare(b)).slice(0, 6);
  return {
    curatedExpirationDates,
    reason:
      curatedExpirationDates.length === 0
        ? 'NO_CURATED_EXPIRATIONS'
        : requested !== '' && !byDate.has(requested) && selected.has(requested)
          ? `REQUESTED_EXPIRATION_OUTSIDE_REFERENCE:${requested}`
          : reason,
  };
}

/**
 * Pieza 50.2: extrae el catálogo 100 % de vencimientos a partir de los contratos de
 * referencia (calls, banda ATM angosta) SIN truncar por cantidad ni horizonte:
 * deduplica fechas `YYYY-MM-DD` válidas con `expirationTime > nowSec + 60` (o DTE ET
 * >= 0), calcula el DTE calendario ET exacto y contabiliza contratos dentro de ±15 %
 * del spot como liquidez estructural. Orden ascendente determinista por fecha.
 */
export function extractUsExpiryCatalog(
  contracts: readonly OptionContract[],
  spot: number,
  nowSec: number,
): readonly UsOptionExpiryCatalogEntry[] {
  const isNearAtm = (strike: number): boolean =>
    Number.isFinite(spot) && spot > 0 && Math.abs(strike - spot) <= spot * 0.15;
  const byDate = new Map<string, { daysToExpiry: number; nearAtmContracts: number }>();
  for (const contract of contracts) {
    const date = contract.expirationDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const dteEt = calendarDteEt(date, nowSec * 1_000);
    const dteKnown = Number.isFinite(dteEt) && dteEt >= 0;
    if (!(contract.expirationTime > nowSec + 60) && !dteKnown) continue;
    const existing = byDate.get(date);
    if (existing !== undefined) {
      if (isNearAtm(contract.strikePrice)) {
        byDate.set(date, { ...existing, nearAtmContracts: existing.nearAtmContracts + 1 });
      }
      continue;
    }
    const approxDays = Math.max(0, Math.floor((contract.expirationTime - nowSec) / 86_400));
    const daysToExpiry = Number.isFinite(dteEt) ? dteEt : approxDays;
    byDate.set(date, {
      daysToExpiry,
      nearAtmContracts: isNearAtm(contract.strikePrice) ? 1 : 0,
    });
  }

  return [...byDate.entries()]
    .map(([expirationDate, info]): UsOptionExpiryCatalogEntry => ({
      expirationDate,
      daysToExpiry: info.daysToExpiry,
      nearAtmContracts: info.nearAtmContracts,
    }))
    .sort((a, b) => a.expirationDate.localeCompare(b.expirationDate));
}

/** Pieza 50.2: buckets representativos de las anclas de precarga (target, min, max) DTE. */
const ANCHOR_EXPIRY_BUCKETS: readonly { readonly target: number; readonly min: number; readonly max: number }[] = [
  { target: 7, min: 3, max: 12 },
  { target: 28, min: 16, max: 40 },
  { target: 60, min: 45, max: 78 },
  { target: 90, min: 79, max: 125 },
  { target: 180, min: 135, max: 240 },
];

/**
 * Pieza 50.2: selecciona hasta 6 vencimientos ancla representativos del catálogo
 * completo (front, ~7d, ~28d, ~60d, ~90d y ~180d) para arranque rápido y estructura
 * temporal completa. `requestedExpiration` presente en el catálogo se incluye siempre
 * como prioritario; si el total supera 6 se descarta primero el bucket más distante
 * (nunca front ni requested). Devuelve fechas ordenadas ascendentemente.
 */
export function selectAnchorUsExpirations(
  catalogExpirations: readonly UsOptionExpiryCatalogEntry[],
  requestedExpiration?: string,
): readonly string[] {
  const entries = [...catalogExpirations].sort((a, b) => a.expirationDate.localeCompare(b.expirationDate));
  const byDate = new Map(entries.map((entry) => [entry.expirationDate, entry]));
  const selected: string[] = [];
  const add = (date: string | null | undefined): void => {
    if (date === null || date === undefined || date === '') return;
    if (!selected.includes(date)) selected.push(date);
  };

  const requested = requestedExpiration?.trim() ?? '';
  const requestedEntry = requested !== '' ? byDate.get(requested) ?? null : null;
  if (requestedEntry !== null) {
    add(requestedEntry.expirationDate);
  }

  const front = entries[0] ?? null;
  if (front !== null) {
    add(front.expirationDate);
  }

  for (const bucket of ANCHOR_EXPIRY_BUCKETS) {
    let best: UsOptionExpiryCatalogEntry | null = null;
    for (const entry of entries) {
      if (entry.daysToExpiry < bucket.min || entry.daysToExpiry > bucket.max) continue;
      if (best === null) {
        best = entry;
        continue;
      }
      const dist = Math.abs(entry.daysToExpiry - bucket.target);
      const bestDist = Math.abs(best.daysToExpiry - bucket.target);
      if (
        dist < bestDist ||
        (dist === bestDist && entry.nearAtmContracts > best.nearAtmContracts) ||
        (dist === bestDist &&
          entry.nearAtmContracts === best.nearAtmContracts &&
          entry.expirationDate.localeCompare(best.expirationDate) < 0)
      ) {
        best = entry;
      }
    }
    add(best?.expirationDate ?? null);
  }

  if (selected.length > MAX_PRELOAD_EXPIRY_DATES) {
    const protectedDates = new Set<string>();
    if (front !== null) protectedDates.add(front.expirationDate);
    if (requestedEntry !== null) protectedDates.add(requestedEntry.expirationDate);
    const droppable = selected
      .filter((date) => !protectedDates.has(date))
      .sort((a, b) => {
        const dteA = byDate.get(a)?.daysToExpiry ?? Number.NaN;
        const dteB = byDate.get(b)?.daysToExpiry ?? Number.NaN;
        return dteB - dteA || a.localeCompare(b);
      });
    while (selected.length > MAX_PRELOAD_EXPIRY_DATES && droppable.length > 0) {
      const drop = droppable.shift();
      if (drop === undefined) break;
      const idx = selected.indexOf(drop);
      if (idx >= 0) selected.splice(idx, 1);
    }
  }

  return [...selected].sort((a, b) => a.localeCompare(b));
}

/**
 * Pieza 50.2: fusiona el catálogo 100 % de fechas con las métricas reales de los
 * vencimientos ya cargados (`selectUsOptionExpirations`). Las fechas pendientes quedan
 * `loaded: false` (contadores en 0, ventana 14–45 DTE explícita) y las fechas cargadas
 * fuera del catálogo cacheado también se incluyen con `loaded: true`. Sin recortes.
 */
export function mergeUsOptionExpiryCatalog(
  catalogExpirations: readonly UsOptionExpiryCatalogEntry[],
  loadedExpirations: readonly UsOptionExpiryDto[],
): readonly UsOptionExpiryDto[] {
  const loadedByDate = new Map(loadedExpirations.map((entry) => [entry.expirationDate, entry]));
  const merged = new Map<string, UsOptionExpiryDto>();

  for (const entry of catalogExpirations) {
    const loaded = loadedByDate.get(entry.expirationDate);
    if (loaded !== undefined) {
      loadedByDate.delete(entry.expirationDate);
      merged.set(entry.expirationDate, {
        expirationDate: entry.expirationDate,
        daysToExpiry: Number.isFinite(loaded.daysToExpiry) ? loaded.daysToExpiry : entry.daysToExpiry,
        loaded: true,
        validCallCount: loaded.validCallCount,
        validPutCount: loaded.validPutCount,
        nearAtmLiquidity: loaded.nearAtmLiquidity,
        inDefaultWindow: loaded.inDefaultWindow,
        hasCompleteAtmChain: loaded.hasCompleteAtmChain,
      });
      continue;
    }
    merged.set(entry.expirationDate, {
      expirationDate: entry.expirationDate,
      daysToExpiry: entry.daysToExpiry,
      loaded: false,
      validCallCount: 0,
      validPutCount: 0,
      nearAtmLiquidity: 0,
      inDefaultWindow: entry.daysToExpiry >= 14 && entry.daysToExpiry <= 45,
      hasCompleteAtmChain: false,
    });
  }

  for (const loaded of loadedByDate.values()) {
    merged.set(loaded.expirationDate, { ...loaded, loaded: true });
  }

  return [...merged.values()].sort((a, b) => a.expirationDate.localeCompare(b.expirationDate));
}

export type OpraAlignedSpotSource =
  | 'FEED'
  | 'RTH_CLOSE'
  | 'PARITY_IMPLIED'
  | 'FEED_CLOSED_NO_REF';

export interface OpraAlignedSpotInput {
  /** Spot del feed (tick extendido / último trade; puede incluir after-hours). */
  readonly feedSpot: number;
  /** Cierre RTH más reciente (bars 5m 09:30–16:00 ET o cierre diario) o NaN. */
  readonly rthCloseSpot: number;
  /** Spot implícito por paridad Put-Call (`forward * exp(-(r-q)T)`) o NaN. */
  readonly parityImpliedSpot: number;
  /** `true` si el mercado está cerrado (`anyClosedMarket || isWeekendEt || EOD_CIERRE`). */
  readonly marketClosed: boolean;
  /** Umbral relativo de divergencia contra paridad para alinear (default 25 bps = 0.0025). */
  readonly divergenceThresholdRel?: number;
}

export interface OpraAlignedSpotResult {
  readonly valuationSpot: number;
  /** Spot informativo de encabezado (feed extendido) separado del spot de valuación OPRA. */
  readonly headerSpot: number;
  readonly source: OpraAlignedSpotSource;
  readonly divergenceBps: number;
}

/**
 * Pieza 50.1: alinea el spot de valuación de la cadena OPRA cuando el mercado está
 * cerrado o cuando el feed diverge > umbral de la paridad Put-Call mediana ATM.
 * Prefiere el spot implícito por paridad si el cierre RTH está más cerca de la paridad
 * que el precio extendido; caso contrario el cierre RTH. Sin referencias válidas
 * degrada honestamente al feed (`FEED_CLOSED_NO_REF`) sin inventar un precio.
 */
export function resolveOpraAlignedSpot(input: OpraAlignedSpotInput): OpraAlignedSpotResult {
  const threshold =
    input.divergenceThresholdRel !== undefined &&
    Number.isFinite(input.divergenceThresholdRel) &&
    input.divergenceThresholdRel >= 0
      ? input.divergenceThresholdRel
      : 0.0025;
  const feed = Number.isFinite(input.feedSpot) && input.feedSpot > 0 ? input.feedSpot : Number.NaN;
  const rth =
    Number.isFinite(input.rthCloseSpot) && input.rthCloseSpot > 0
      ? input.rthCloseSpot
      : Number.NaN;
  const parity =
    Number.isFinite(input.parityImpliedSpot) && input.parityImpliedSpot > 0
      ? input.parityImpliedSpot
      : Number.NaN;

  if (!Number.isFinite(feed)) {
    if (Number.isFinite(parity)) {
      return {
        valuationSpot: parity,
        headerSpot: Number.NaN,
        source: 'PARITY_IMPLIED',
        divergenceBps: Number.NaN,
      };
    }
    if (Number.isFinite(rth)) {
      return {
        valuationSpot: rth,
        headerSpot: Number.NaN,
        source: 'RTH_CLOSE',
        divergenceBps: Number.NaN,
      };
    }
    return {
      valuationSpot: Number.NaN,
      headerSpot: Number.NaN,
      source: 'FEED',
      divergenceBps: Number.NaN,
    };
  }

  const parityDivergenceRel = Number.isFinite(parity)
    ? Math.abs(feed - parity) / parity
    : Number.NaN;
  const triggersAlignment =
    input.marketClosed ||
    (Number.isFinite(parityDivergenceRel) && parityDivergenceRel > threshold);

  if (!triggersAlignment) {
    return {
      valuationSpot: feed,
      headerSpot: feed,
      source: 'FEED',
      divergenceBps: Number.isFinite(parityDivergenceRel) ? parityDivergenceRel * 10_000 : Number.NaN,
    };
  }

  if (Number.isFinite(rth) && Number.isFinite(parity)) {
    const parityConsistentWithRth = Math.abs(rth - parity) <= Math.abs(rth - feed);
    const chosen = parityConsistentWithRth ? parity : rth;
    return {
      valuationSpot: chosen,
      headerSpot: feed,
      source: parityConsistentWithRth ? 'PARITY_IMPLIED' : 'RTH_CLOSE',
      divergenceBps: (Math.abs(feed - chosen) / chosen) * 10_000,
    };
  }
  if (Number.isFinite(parity)) {
    return {
      valuationSpot: parity,
      headerSpot: feed,
      source: 'PARITY_IMPLIED',
      divergenceBps: (Math.abs(feed - parity) / parity) * 10_000,
    };
  }
  if (Number.isFinite(rth)) {
    return {
      valuationSpot: rth,
      headerSpot: feed,
      source: 'RTH_CLOSE',
      divergenceBps: (Math.abs(feed - rth) / rth) * 10_000,
    };
  }
  return {
    valuationSpot: feed,
    headerSpot: feed,
    source: 'FEED_CLOSED_NO_REF',
    divergenceBps: Number.isFinite(parityDivergenceRel) ? parityDivergenceRel * 10_000 : Number.NaN,
  };
}

/**
 * Pieza 50.1: variación % diaria estricta de un contrato (columna `var%`).
 * Prioriza `day.changePercent`; si falta, deriva de `previousClose` y un precio de
 * referencia válido; sin datos suficientes → `null` (sin fallbacks inventados).
 */
export function resolveContractChangePct(
  changePercent: number,
  previousClose: number,
  referencePrice: number,
): number | null {
  if (Number.isFinite(changePercent)) {
    return changePercent;
  }
  if (
    Number.isFinite(previousClose) &&
    previousClose > 0 &&
    Number.isFinite(referencePrice) &&
    referencePrice > 0
  ) {
    return ((referencePrice - previousClose) / previousClose) * 100;
  }
  return null;
}

export const US_VOL_SURFACE_TTL_MS = 10 * 60 * 1_000;

export interface UsVolSurfaceResponse {
  readonly status: 'OK' | 'PARTIAL' | 'NO_DATA';
  readonly symbol: string;
  readonly asOfUtcSec: number;
  readonly cacheState: 'HIT' | 'MISS' | 'STALE' | 'UNAVAILABLE';
  readonly stale: boolean;
  readonly reason: string | null;
  readonly surface: JsonSafeValue<OratsHybridSurfacePayload>;
  readonly ivRank: JsonSafeValue<OratsIvRankPayload>;
}

export interface EquityRiskReturnMetrics {
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
  readonly observationCount: number;
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

export interface CachedDailyBarsResult {
  readonly symbol: string;
  readonly bars: readonly Bar[];
  readonly error: string | null;
  readonly cacheHit: boolean;
}

const DEFAULT_DAILY_1D_CACHE_TTL_MS = 15 * 60 * 1_000;
const US_DAILY_1D_WEEKEND_TTL_MS = 2 * 60 * 60 * 1_000;
const US_PANEL_CONCURRENCY_LIMIT = 6;
const US_PANEL_MAX_CLOSED_BARS = 260;
/** Pieza 32: TTL de cache de cadenas de opciones Tradier por (símbolo, vencimiento). */
const TRADIER_CHAIN_CACHE_TTL_MS = 15_000;
/** Pieza 32: máximo de vencimientos distintos refrescados por snapshot. */
const TRADIER_MAX_CHAIN_EXPIRIES = 6;
const NYFED_SOFR_LAST_URL = 'https://markets.newyorkfed.org/api/rates/secured/sofr/last/1.json';
const FRED_GRAPH_CSV_BASE = 'https://fred.stlouisfed.org/graph/fredgraph.csv';

function computeUsHistoricalPanelTtlMs(nowMs: number): number {
  const nowSec = Math.floor(nowMs / 1_000);
  if (!Number.isFinite(nowSec) || nowSec < 0 || nowSec > MAX_TIME_SECONDS) {
    return DEFAULT_DAILY_1D_CACHE_TTL_MS;
  }
  const parts = getMarketParts(nowSec, 'EQUITY');
  const isWeekday = parts.weekday >= 1 && parts.weekday <= 5;
  if (!isWeekday) {
    return US_DAILY_1D_WEEKEND_TTL_MS;
  }
  if (parts.minutesOfDay >= 9 * 60 + 30 && parts.minutesOfDay < 16 * 60) {
    return DEFAULT_DAILY_1D_CACHE_TTL_MS;
  }
  return US_DAILY_1D_WEEKEND_TTL_MS;
}

export function sanitizeFinite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim() !== '') {
    return err.message;
  }
  return toErrorMessage(err, fallback);
}

function parseEnvFile(path: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  let raw = '';
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return values;
  }

  for (const rawLine of raw.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    if (line.startsWith('export ')) {
      line = line.slice('export '.length).trim();
    }
    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (value.length >= 2 && (value.startsWith("'") || value.startsWith('"'))) {
      const quote = value.charAt(0);
      if (value.endsWith(quote)) {
        value = value.slice(1, -1);
      }
    }
    if (key !== '') {
      values.set(key, value);
    }
  }
  return values;
}

/**
 * Resuelve la clave API de Massive desde `process.env` o `.env` sin exponerla nunca.
 */
export function loadRuntimeAuth(
  env: NodeJS.ProcessEnv = process.env,
  envFilePath: string = resolve(process.cwd(), '.env'),
): MassiveAuthConfig {
  const fileValues = parseEnvFile(envFilePath);
  const secretSet = new Set<string>();

  for (const keyName of EXTRA_SECRET_ENV_NAMES) {
    for (const candidate of [env[keyName], fileValues.get(keyName)]) {
      if (typeof candidate === 'string') {
        const trimmed = candidate.trim();
        if (trimmed !== '') {
          secretSet.add(trimmed);
        }
      }
    }
  }

  let apiKey = '';
  for (const keyName of KEY_ENV_NAMES) {
    const candidate = (env[keyName] ?? fileValues.get(keyName) ?? '').trim();
    if (candidate !== '') {
      apiKey = candidate;
      break;
    }
  }

  return {
    apiKey,
    secrets: [...secretSet],
  };
}

export function createRedactingFetch(secrets: readonly string[]): FetchFn {  return async (url: string) => {
    const parsedUrl = new URL(url);
    const endpoint = `${parsedUrl.origin}${parsedUrl.pathname}`;
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();
      const headersRecord: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headersRecord[name.toLowerCase()] = value;
      });
      return {
        ok: response.ok,
        status: response.status,
        text: redactSecrets(text, secrets),
        headers: headersRecord,
      };
    } catch (err: unknown) {
      throw new Error(
        redactSecrets(
          `HTTP GET ${endpoint} failed: ${extractErrorMessage(err, 'network error')}`,
          secrets,
        ),
      );
    }
  };
}

export function parseTerminalSymbol(rawSymbol: string, secrets: readonly string[] = []): ParsedSymbol {
  const upper = rawSymbol.trim().toUpperCase();
  if (!SYMBOL_PATTERN.test(upper)) {
    throw new RuntimeNoDataError(
      'INVALID_SYMBOL',
      `Invalid ticker symbol "${rawSymbol}"`,
      secrets,
      400,
    );
  }

  let canonicalSymbol = upper;
  let referenceUnderlying = upper;
  let isIndex = false;

  if (upper.startsWith('I:')) {
    isIndex = true;
    referenceUnderlying = upper.slice(2);
    if (referenceUnderlying === '') {
      throw new RuntimeNoDataError('INVALID_SYMBOL', `Invalid index symbol "${rawSymbol}"`, secrets, 400);
    }
  } else if (KNOWN_INDEX_ROOTS.has(upper)) {
    isIndex = true;
    canonicalSymbol = `I:${upper}`;
    referenceUnderlying = upper;
  }

  let correlatedSymbol = 'SPY';
  if (canonicalSymbol === 'SPY') {
    correlatedSymbol = 'QQQ';
  } else if (canonicalSymbol === 'QQQ') {
    correlatedSymbol = 'SPY';
  } else if (canonicalSymbol === 'I:SPX') {
    correlatedSymbol = 'I:NDX';
  } else if (canonicalSymbol === 'I:NDX') {
    correlatedSymbol = 'I:SPX';
  }

  return {
    canonicalSymbol,
    referenceUnderlying,
    correlatedSymbol,
    isIndex,
  };
}

export function parseTimeframe(raw: string | undefined, secrets: readonly string[] = []): Timeframe {
  const tf = (raw ?? '5m').trim();
  if (tf === '1m' || tf === '5m' || tf === '15m' || tf === '1h' || tf === '4h' || tf === '1D') {
    return tf;
  }
  throw new RuntimeNoDataError(
    'INVALID_PARAMETER',
    `Unsupported timeframe "${tf}". Expected one of: 1m, 5m, 15m, 1h, 4h, 1D`,
    secrets,
    400,
  );
}

function addCalendarDaysEt(nowUtcSec: number, deltaDays: number): string {
  const parts = getMarketParts(nowUtcSec, 'EQUITY');
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + deltaDays));
  return d.toISOString().slice(0, 10);
}

function serializeBar(bar: Bar): SerializedBar {
  return {
    time: bar.time,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    vw: sanitizeFinite(bar.vw),
  };
}

function resolveUnifiedStockPrice(stock: UnifiedStockSnapshot | undefined): number {
  if (stock === undefined) {
    return Number.NaN;
  }
  const candidates: readonly (number | undefined)[] = [
    stock.lastTrade?.price,
    stock.lastQuote?.midpoint,
    stock.session.price,
    stock.session.close,
    stock.session.previousClose,
  ];
  for (const c of candidates) {
    if (c !== undefined && Number.isFinite(c) && c > 0) {
      return c;
    }
  }
  return Number.NaN;
}

function resolveUnifiedIndexLevel(indexSnap: UnifiedIndexSnapshot | undefined): number {
  if (indexSnap === undefined) {
    return Number.NaN;
  }
  const candidates: readonly number[] = [
    indexSnap.value,
    indexSnap.session.price,
    indexSnap.session.close,
    indexSnap.session.previousClose,
  ];
  for (const c of candidates) {
    if (Number.isFinite(c) && c > 0) {
      return c;
    }
  }
  return Number.NaN;
}

function resolveSpotPrice(
  chainUnderlying: OptionUnderlyingSnapshot | null,
  unifiedStock: UnifiedStockSnapshot | undefined,
  unifiedIndex: UnifiedIndexSnapshot | undefined,
  bars5m: readonly Bar[],
  bars1d: readonly Bar[],
): number {
  if (chainUnderlying !== null && Number.isFinite(chainUnderlying.price) && chainUnderlying.price > 0) {
    return chainUnderlying.price;
  }
  const stockPx = resolveUnifiedStockPrice(unifiedStock);
  if (Number.isFinite(stockPx) && stockPx > 0) {
    return stockPx;
  }
  const idxPx = resolveUnifiedIndexLevel(unifiedIndex);
  if (Number.isFinite(idxPx) && idxPx > 0) {
    return idxPx;
  }
  const last5m = bars5m[bars5m.length - 1];
  if (last5m !== undefined && Number.isFinite(last5m.close) && last5m.close > 0) {
    return last5m.close;
  }
  const last1d = bars1d[bars1d.length - 1];
  if (last1d !== undefined && Number.isFinite(last1d.close) && last1d.close > 0) {
    return last1d.close;
  }
  return Number.NaN;
}

/**
 * Pieza 50.1: cierre RTH más reciente para alinear el spot de valuación OPRA.
 * Prioriza la última barra 5m dentro de 09:30–16:00 ET (<= ahora) y degrada al
 * último cierre diario; `NaN` si no hay referencias válidas.
 */
function resolveRthCloseSpot(
  bars5m: readonly Bar[],
  bars1d: readonly Bar[],
  nowSec: number,
): number {
  const nowParts = getMarketParts(nowSec, 'EQUITY');
  for (let i = bars5m.length - 1; i >= 0; i -= 1) {
    const bar = bars5m[i];
    if (bar === undefined || bar.time > nowSec) continue;
    const parts = getMarketParts(bar.time, 'EQUITY');
    const isRthBar =
      parts.weekday >= 1 &&
      parts.weekday <= 5 &&
      parts.minutesOfDay >= 570 &&
      parts.minutesOfDay <= 960 &&
      parts.dateKey <= nowParts.dateKey;
    if (!isRthBar) continue;
    return Number.isFinite(bar.close) && bar.close > 0 ? bar.close : Number.NaN;
  }
  for (let i = bars1d.length - 1; i >= 0; i -= 1) {
    const bar = bars1d[i];
    if (bar === undefined || bar.time > nowSec) continue;
    if (Number.isFinite(bar.close) && bar.close > 0) {
      return bar.close;
    }
  }
  return Number.NaN;
}

function resolveQuoteMid(contract: OptionSnapshotContract): number {
  const { bid, ask, midpoint } = contract.lastQuote;
  if (Number.isFinite(midpoint) && midpoint > 0) {
    if (Number.isFinite(bid) && Number.isFinite(ask) && ask >= bid) {
      const tol = 1e-9 * Math.max(1, midpoint);
      if (midpoint >= bid - tol && midpoint <= ask + tol) {
        return midpoint;
      }
    } else {
      return midpoint;
    }
  }
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid) {
    return 0.5 * (bid + ask);
  }
  const lastPx = contract.lastTrade.price;
  if (Number.isFinite(lastPx) && lastPx > 0) {
    return lastPx;
  }
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid === 0 && ask > 0) {
    return 0.5 * ask;
  }
  return Number.NaN;
}

function interpolateLiveRate(
  treasuryObs: TreasuryYieldObservation | undefined,
  sofrRate: number,
  tenorYears: number,
): number {
  if (treasuryObs === undefined) {
    return Number.isFinite(sofrRate) ? sofrRate : Number.NaN;
  }
  const allowMissing = treasuryObs.finiteTenors < TREASURY_TENORS.length;
  return interpolateTreasuryYield(treasuryObs, tenorYears, {
    allowMissingTenors: allowMissing,
    ...(Number.isFinite(sofrRate) ? { overnightRate: sofrRate } : {}),
    method: 'linear',
    extrapolation: 'clamp',
  });
}

function evaluateParityForExpiry(
  expirySec: number,
  expiryContracts: readonly OptionSnapshotContract[],
  nowSec: number,
  spot: number,
  treasuryObs: TreasuryYieldObservation | undefined,
  sofrRate: number,
): ExpiryParityEvaluation | null {
  const first = expiryContracts[0];
  if (first === undefined || !Number.isFinite(spot) || spot <= 0) {
    return null;
  }
  const timeToExpiry = timeToExpiryYears(nowSec, expirySec);
  if (!Number.isFinite(timeToExpiry) || timeToExpiry <= 0) {
    return null;
  }
  const rate = interpolateLiveRate(treasuryObs, sofrRate, timeToExpiry);
  if (!Number.isFinite(rate)) {
    return null;
  }

  interface PairAccum {
    call?: OptionSnapshotContract;
    put?: OptionSnapshotContract;
  }
  const byStrike = new Map<number, PairAccum>();
  for (const c of expiryContracts) {
    let slot = byStrike.get(c.strikePrice);
    if (slot === undefined) {
      slot = {};
      byStrike.set(c.strikePrice, slot);
    }
    if (c.contractType === 'call' && slot.call === undefined) {
      slot.call = c;
    } else if (c.contractType === 'put' && slot.put === undefined) {
      slot.put = c;
    }
  }

  const pairs: ParityOptionPair[] = [];
  for (const [strike, slot] of byStrike.entries()) {
    if (slot.call === undefined || slot.put === undefined) {
      continue;
    }
    const callMid = resolveQuoteMid(slot.call);
    const putMid = resolveQuoteMid(slot.put);
    if (!Number.isFinite(callMid) || !Number.isFinite(putMid)) {
      continue;
    }
    const callOi = slot.call.openInterest;
    const putOi = slot.put.openInterest;
    const liqWeight =
      Number.isFinite(callOi) && Number.isFinite(putOi) && callOi > 0 && putOi > 0
        ? Math.min(callOi, putOi)
        : 1;
    pairs.push({
      strike,
      callMid,
      putMid,
      ...(Number.isFinite(slot.call.lastQuote.bid) ? { callBid: slot.call.lastQuote.bid } : {}),
      ...(Number.isFinite(slot.call.lastQuote.ask) ? { callAsk: slot.call.lastQuote.ask } : {}),
      ...(Number.isFinite(slot.put.lastQuote.bid) ? { putBid: slot.put.lastQuote.bid } : {}),
      ...(Number.isFinite(slot.put.lastQuote.ask) ? { putAsk: slot.put.lastQuote.ask } : {}),
      liquidityWeight: liqWeight,
    });
  }
  if (pairs.length < 3) {
    return {
      expirySec,
      expirationDate: first.expirationDate,
      timeToExpiry,
      rate,
      forward: spot * Math.exp(rate * timeToExpiry),
      dividendYield: 0,
    };
  }

  const parity = inferForwardFromParityDetailed(pairs, Math.exp(-rate * timeToExpiry), {
    method: 'median',
    nearAtmCount: 5,
    maxRelativeSpread: 0.35,
    requirePositiveBid: true,
    minValidPairs: 3,
  });
  if (!Number.isFinite(parity.forward) || parity.forward <= 0) {
    return {
      expirySec,
      expirationDate: first.expirationDate,
      timeToExpiry,
      rate,
      forward: spot * Math.exp(rate * timeToExpiry),
      dividendYield: 0,
    };
  }
  const dividendYield =
    timeToExpiry < MIN_SYNTHETIC_RATE_T - 1e-12
      ? 0
      : impliedDividendYieldFromForward({
          spot,
          forward: parity.forward,
          timeToExpiry,
          rate,
        });
  if (!Number.isFinite(dividendYield)) {
    return {
      expirySec,
      expirationDate: first.expirationDate,
      timeToExpiry,
      rate,
      forward: spot * Math.exp(rate * timeToExpiry),
      dividendYield: 0,
    };
  }

  return {
    expirySec,
    expirationDate: first.expirationDate,
    timeToExpiry,
    rate,
    forward: parity.forward,
    dividendYield,
  };
}

function solveContractOwnIv(
  contract: OptionSnapshotContract,
  spot: number,
  timeToExpiry: number,
  rate: number,
  dividendYield: number,
  isIndex: boolean,
): number {
  const mid = resolveQuoteMid(contract);
  if (!Number.isFinite(mid) || mid <= 0) {
    return Number.NaN;
  }
  const { bid, ask } = contract.lastQuote;
  if (Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask >= bid) {
    const spreadRatio = (ask - bid) / mid;
    if (!Number.isFinite(spreadRatio) || spreadRatio > 0.85) {
      return Number.NaN;
    }
  }

  // Pieza 50.3: sin extrínseco no hay IV invertible (nunca una solución explosiva
  // de deep ITM por encima del cap de 999 %).
  const ext = extrinsicValue(contract.contractType, spot, contract.strikePrice, mid);
  if (!Number.isFinite(ext) || ext <= EXTRINSIC_EPS) {
    return Number.NaN;
  }

  const solved = isIndex
    ? solveImpliedVolBsm({
        spot,
        strike: contract.strikePrice,
        timeToExpiry,
        rate,
        dividendYield,
        contractType: contract.contractType,
        price: mid,
      })
    : solveImpliedVolAmerican({
        spot,
        strike: contract.strikePrice,
        timeToExpiry,
        rate,
        dividendYield,
        contractType: contract.contractType,
        marketPrice: mid,
      });
  return Number.isFinite(solved) && solved > 0 && solved < IV_CAP_DECIMAL ? solved : Number.NaN;
}

function serializeSlice(pkg: SlicePackage): SerializedVolSliceSummary {
  return {
    expirySec: pkg.parity.expirySec,
    expirationDate: pkg.parity.expirationDate,
    timeToExpiryYears: pkg.parity.timeToExpiry,
    timeToExpiryDays: pkg.parity.timeToExpiry * 365,
    forward: sanitizeFinite(pkg.parity.forward),
    rate: sanitizeFinite(pkg.parity.rate),
    dividendYield: sanitizeFinite(pkg.parity.dividendYield),
    ivAtm: sanitizeFinite(pkg.metrics.ivAtm),
    delta25PutIv: sanitizeFinite(pkg.metrics.delta25PutIv),
    delta25CallIv: sanitizeFinite(pkg.metrics.delta25CallIv),
    riskReversal25: sanitizeFinite(pkg.metrics.riskReversal25),
    butterfly25: sanitizeFinite(pkg.metrics.butterfly25),
    isButterflyArbitrageFree: pkg.isButterflyArbitrageFree,
    butterflyMinDensity: sanitizeFinite(pkg.butterflyMinDensity),
    nodes: pkg.slice.nodes.map((node) => ({
      strike: node.strike,
      k: node.k,
      iv: sanitizeFinite(node.iv),
      totalVariance: sanitizeFinite(node.totalVariance),
      slope: sanitizeFinite(node.slope),
      spreadRatio: sanitizeFinite(node.spreadRatio),
      openInterest: node.openInterest,
    })),
  };
}

function serializeExposure(
  exposure: DealerExposureResult,
  trace?: ExposureTraceMetadata,
): SerializedExposureSummary {
  return {
    netGex: sanitizeFinite(exposure.netGex),
    callGex: sanitizeFinite(exposure.callGex),
    putGex: sanitizeFinite(exposure.putGex),
    netSpotGamma: sanitizeFinite(exposure.netSpotGamma),
    netDex: sanitizeFinite(exposure.netDex),
    netVannaExposure: sanitizeFinite(exposure.netVannaExposure),
    netCharmExposure: sanitizeFinite(exposure.netCharmExposure),
    netVex: sanitizeFinite(exposure.netVannaExposure),
    netCex: sanitizeFinite(exposure.netCharmExposure),
    vannaRegime: exposure.vannaRegime,
    charmPinStrike: sanitizeFinite(exposure.charmPinStrike),
    callWallStrike: sanitizeFinite(exposure.callWallStrike),
    putWallStrike: sanitizeFinite(exposure.putWallStrike),
    gammaFlipSpot: sanitizeFinite(exposure.gammaFlipSpot),
    gammaFlipStatus: exposure.gammaFlipStatus,
    gammaFlipCandidates: exposure.gammaFlipCandidates.filter((value) => Number.isFinite(value)),
    ...(trace !== undefined ? { trace } : {}),
    expectedMove: {
      expiryUtcSec: sanitizeFinite(exposure.expectedMove.expiryUtcSec),
      formulaMove: sanitizeFinite(exposure.expectedMove.formulaMove),
      formulaMovePct: sanitizeFinite(exposure.expectedMove.formulaMovePct),
      straddleStrike: sanitizeFinite(exposure.expectedMove.straddleStrike),
      straddleMove: sanitizeFinite(exposure.expectedMove.straddleMove),
      straddleMovePct: sanitizeFinite(exposure.expectedMove.straddleMovePct),
    },
    quality: {
      totalContracts: exposure.quality.inputContracts,
      activeContracts: exposure.quality.activeContracts,
      usableContracts: exposure.quality.usableContracts,
      usableOpenInterest: exposure.quality.usableOpenInterest,
      skippedContracts: exposure.quality.skippedContracts,
      skippedOiShare: sanitizeFinite(exposure.quality.skippedOiShare),
    },
    byStrike: exposure.byStrike.map((s) => ({
      strike: s.strike,
      callOi: sanitizeFinite(s.callOpenInterest),
      putOi: sanitizeFinite(s.putOpenInterest),
      callVolume: sanitizeFinite(s.callVolume),
      putVolume: sanitizeFinite(s.putVolume),
      callGex: sanitizeFinite(s.callGex),
      putGex: sanitizeFinite(s.putGex),
      netGex: sanitizeFinite(s.netGex),
      netSpotGamma: sanitizeFinite(s.netSpotGamma),
      netDex: sanitizeFinite(s.netDex),
      netVannaExposure: sanitizeFinite(s.netVannaExposure),
      netCharmExposure: sanitizeFinite(s.netCharmExposure),
      vex: sanitizeFinite(s.netVannaExposure),
      cex: sanitizeFinite(s.netCharmExposure),
    })),
  };
}

function resolvePreviousCompletedDayLevels(
  bars1d: readonly Bar[],
  bars5m: readonly Bar[],
  nowSec: number,
): { readonly pdh: number; readonly pdl: number; readonly pdc: number } | undefined {
  const currentDateKey = getMarketParts(nowSec, 'EQUITY').dateKey;

  for (let i = bars1d.length - 1; i >= 0; i -= 1) {
    const bar = bars1d[i];
    if (bar === undefined) {
      continue;
    }
    const barDateKey = getMarketParts(bar.time, 'EQUITY').dateKey;
    if (barDateKey < currentDateKey && Number.isFinite(bar.high) && Number.isFinite(bar.low) && Number.isFinite(bar.close)) {
      return { pdh: bar.high, pdl: bar.low, pdc: bar.close };
    }
  }

  let prevDateKey: string | null = null;
  let pdh = Number.NEGATIVE_INFINITY;
  let pdl = Number.POSITIVE_INFINITY;
  let pdc = Number.NaN;
  for (let i = bars5m.length - 1; i >= 0; i -= 1) {
    const bar = bars5m[i];
    if (bar === undefined) {
      continue;
    }
    const parts = getMarketParts(bar.time, 'EQUITY');
    if (parts.dateKey >= currentDateKey) {
      continue;
    }
    if (prevDateKey === null) {
      prevDateKey = parts.dateKey;
    }
    if (parts.dateKey !== prevDateKey) {
      break;
    }
    if (bar.high > pdh) {
      pdh = bar.high;
    }
    if (bar.low < pdl) {
      pdl = bar.low;
    }
    if (!Number.isFinite(pdc)) {
      pdc = bar.close;
    }
  }

  if (Number.isFinite(pdh) && Number.isFinite(pdl) && Number.isFinite(pdc)) {
    return { pdh, pdl, pdc };
  }
  return undefined;
}

function serializeOpeningAuction(
  result: OpeningAuctionResult,
  atr14d: number | undefined,
): SerializedOpeningAuctionSummary {
  return {
    balanceType: result.balanceType,
    inventoryRisk: result.inventoryRisk,
    openingType: result.openingType,
    openingDirection: result.openingDirection,
    ibClassification: result.ibClassification,
    pmh: sanitizeFinite(result.pmh),
    pml: sanitizeFinite(result.pml),
    onPoc: sanitizeFinite(result.onPoc),
    onVah: sanitizeFinite(result.onVah),
    onVal: sanitizeFinite(result.onVal),
    ibh: sanitizeFinite(result.ibh),
    ibl: sanitizeFinite(result.ibl),
    ibWidth: sanitizeFinite(result.ibWidth),
    atr14d: sanitizeFinite(atr14d),
    gapPct: sanitizeFinite(result.trueGapAtr),
    macro0830SpikeDetected: result.macro0830Detected,
  };
}

function sanitizeJsonUnknownUs(value: unknown): unknown {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonUnknownUs(item === undefined ? null : item));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        out[k] = sanitizeJsonUnknownUs(v);
      }
    }
    return out;
  }
  return null;
}

function sanitizeJsonValue<T>(value: T): JsonSafeValue<T> {
  return sanitizeJsonUnknownUs(value) as JsonSafeValue<T>;
}

function normalizeClosedDailyBarsUs(bars: readonly Bar[], asOfUtcSec: number): readonly Bar[] {
  const evalSec = Math.floor(asOfUtcSec);
  const byDay = new Map<number, Bar>();
  for (const b of bars) {
    if (
      !Number.isFinite(b.time) ||
      !Number.isFinite(b.open) ||
      !Number.isFinite(b.high) ||
      !Number.isFinite(b.low) ||
      !Number.isFinite(b.close) ||
      !Number.isFinite(b.volume) ||
      b.close <= 0 ||
      b.high < b.low ||
      b.volume < 0
    ) {
      continue;
    }
    const rawTime = Math.floor(b.time);
    if (rawTime > evalSec) {
      continue;
    }
    const dayOpenSec = Math.floor(rawTime / 86_400) * 86_400;
    if (dayOpenSec + 86_400 <= evalSec) {
      byDay.set(dayOpenSec, {
        ...b,
        time: dayOpenSec,
      });
    }
  }
  return [...byDay.values()].sort((a, b) => a.time - b.time);
}

/**
 * Pieza 50.5 (Bloque 3): elegibilidad conservadora de rueda cerrada US para
 * Auto-AVWAP. Reutiliza el criterio de `normalizeClosedDailyBarsUs` (el día UTC
 * de la apertura ya terminó: nunca admite la sesión en curso ni barras futuras,
 * y cubre cierres reducidos porque el día UTC termina después del cierre ET),
 * sin reescribir el timestamp original.
 */
export function isUsClosedDailyBar(bar: Bar, asOfUtcSec: number): boolean {
  const evalSec = Math.floor(asOfUtcSec);
  if (!Number.isFinite(evalSec) || evalSec <= 0) {
    return false;
  }
  if (
    !Number.isFinite(bar.time) ||
    bar.time <= 0 ||
    Math.abs(bar.time) > MAX_TIME_SECONDS ||
    !Number.isFinite(bar.open) ||
    !Number.isFinite(bar.high) ||
    !Number.isFinite(bar.low) ||
    !Number.isFinite(bar.close) ||
    !Number.isFinite(bar.volume) ||
    bar.close <= 0 ||
    bar.high < bar.low ||
    bar.volume < 0
  ) {
    return false;
  }
  const rawTime = Math.floor(bar.time);
  if (rawTime > evalSec) {
    return false;
  }
  const dayOpenSec = Math.floor(rawTime / 86_400) * 86_400;
  return dayOpenSec + 86_400 <= evalSec;
}

/**
 * Ruedas cerradas mínimas para un insumo Auto-AVWAP completo (ventana por
 * defecto de `detectAutoAvwapAnchors`).
 */
export const AUTO_AVWAP_MIN_CLOSED_DAILY_BARS = 380;

/**
 * Pieza 50.5 (Bloque 3): filtra las ruedas cerradas válidas, deduplica por
 * `time` (última ocurrencia) y ordena ascendente sin mutar la entrada.
 */
function filterClosedDailyBarsUs(bars: readonly Bar[], asOfUtcSec: number): readonly Bar[] {
  const byTime = new Map<number, Bar>();
  for (const bar of bars) {
    if (!isUsClosedDailyBar(bar, asOfUtcSec)) {
      continue;
    }
    const time = Math.floor(bar.time);
    byTime.set(time, { ...bar, time });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function computeWilderAtr14Us(bars: readonly Bar[]): number | null {
  if (bars.length < 15) {
    return null;
  }
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i += 1) {
    const prev = bars[i - 1];
    const curr = bars[i];
    if (prev !== undefined && curr !== undefined) {
      const tr = Math.max(
        curr.high - curr.low,
        Math.abs(curr.high - prev.close),
        Math.abs(curr.low - prev.close),
      );
      if (Number.isFinite(tr) && tr >= 0) {
        trs.push(tr);
      }
    }
  }
  if (trs.length < 14) {
    return null;
  }
  let atr = trs.slice(0, 14).reduce((acc, v) => acc + v, 0) / 14;
  for (let i = 14; i < trs.length; i += 1) {
    const val = trs[i];
    if (val !== undefined) {
      atr = (atr * 13 + val) / 14;
    }
  }
  return Number.isFinite(atr) && atr > 0 ? atr : null;
}

function computeDailyRealizedVolUs(bars: readonly Bar[], windowDays: number): number | null {
  if (bars.length < windowDays + 1) {
    return null;
  }
  const recent = bars.slice(-(windowDays + 1));
  const rets: number[] = [];
  for (let i = 1; i < recent.length; i += 1) {
    const p = recent[i - 1];
    const c = recent[i];
    if (p !== undefined && c !== undefined && p.close > 0 && c.close > 0) {
      rets.push(Math.log(c.close / p.close));
    }
  }
  if (rets.length < 2) {
    return null;
  }
  const mean = rets.reduce((acc, v) => acc + v, 0) / rets.length;
  const variance = rets.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / (rets.length - 1);
  const rv = Math.sqrt(Math.max(0, variance)) * Math.sqrt(252);
  return Number.isFinite(rv) && rv > 0 ? rv : null;
}

function serializeAbsorptionEvents(
  cvd: CvdAbsorptionResult,
): readonly SerializedAbsorptionMarker[] {
  return cvd.absorptionEvents.map((ev) => ({
    time: ev.time,
    direction: ev.absorbingSide,
    price: sanitizeFinite(ev.close),
    levelName: ev.primaryLevel.name,
    levelPrice: sanitizeFinite(ev.primaryLevel.price),
    barDelta: sanitizeFinite(ev.barDelta),
    sessionCvd: sanitizeFinite(ev.sessionCvd),
  }));
}

function serializeMicrostructure(params: {
  readonly mtf: MtfStructureResult;
  readonly cvd: CvdAbsorptionResult;
  readonly rsiDiv: RsiDivergenceResult;
  readonly smtDiv: SmtDivergenceResult | undefined;
  readonly correlatedSymbol: string;
}): SerializedMicrostructureSummary {
  const { mtf, cvd, rsiDiv, smtDiv, correlatedSymbol } = params;
  return {
    mtf: {
      regime1d: mtf.regime1d,
      aligned4h: mtf.aligned4h,
      effectiveMacroRegime: mtf.effectiveMacroRegime,
      pullback15mInZone: mtf.pullback15mInZone,
      absorption15m: mtf.absorption15m,
      executionTriggerActive: mtf.executionTriggerActive,
      setupStatus: mtf.setupStatus,
      sma200_1d: sanitizeFinite(mtf.sma200_1d),
      sma50_4h: sanitizeFinite(mtf.sma50_4h),
      ema21_15m: sanitizeFinite(mtf.ema21_15m),
      hma55: sanitizeFinite(mtf.hma55),
      close5m: sanitizeFinite(mtf.close5m),
    },
    cvd: {
      deltaMode: cvd.deltaMode,
      currentSessionDate: cvd.currentSessionDate,
      currentSessionCvd: sanitizeFinite(cvd.currentSessionCvd),
      absorptionEvents: serializeAbsorptionEvents(cvd),
    },
    rsiDivergences: {
      status: rsiDiv.status,
      latestRsi: sanitizeFinite(rsiDiv.latestRsi),
      events: rsiDiv.divergences.map((d) => ({
        kind: 'RSI',
        type: d.type,
        pivotTime: d.pivot2Time,
        confirmTime: d.confirmedAtTime,
        price: sanitizeFinite(d.price2),
      })),
    },
    smtDivergences:
      smtDiv === undefined
        ? null
        : {
            status: smtDiv.status,
            correlatedSymbol,
            events: smtDiv.divergences.map((d) => ({
              kind: 'SMT',
              type: d.type,
              pivotTime: d.primaryPivot2Time,
              confirmTime: d.confirmedAtTime,
              price: sanitizeFinite(d.primaryPrice2),
            })),
          },
  };
}

function buildKeyLevelsFromAuctionAndHma(params: {
  readonly auction: OpeningAuctionResult;
  readonly hma55: number | undefined;
}): readonly SerializedKeyLevel[] {
  const out: SerializedKeyLevel[] = [];
  const push = (
    name: KeyLevelName,
    source: KeyLevelSource,
    price: number | undefined,
  ): void => {
    if (price !== undefined && Number.isFinite(price) && price > 0) {
      out.push({ name, source, price });
    }
  };
  push('PMH', 'OPENING_AUCTION', params.auction.pmh);
  push('PML', 'OPENING_AUCTION', params.auction.pml);
  push('ON_POC', 'OPENING_AUCTION', params.auction.onPoc);
  push('ON_VAH', 'OPENING_AUCTION', params.auction.onVah);
  push('ON_VAL', 'OPENING_AUCTION', params.auction.onVal);
  push('IBH', 'OPENING_AUCTION', params.auction.ibh);
  push('IBL', 'OPENING_AUCTION', params.auction.ibl);
  push('HMA55_5M', 'MTF', params.hma55);
  return out;
}

function toUtcDateKey(sec: number): string {
  return new Date(Math.floor(sec) * 1_000).toISOString().slice(0, 10);
}

function normalizeEquityDailyBars(bars: readonly Bar[], asOfUtcSec?: number): readonly Bar[] {
  const closedInput =
    asOfUtcSec !== undefined && Number.isFinite(asOfUtcSec)
      ? normalizeClosedDailyBarsUs(bars, asOfUtcSec)
      : bars;
  const byDay = new Map<string, Bar>();
  for (const b of closedInput) {
    if (
      !Number.isFinite(b.time) ||
      !Number.isFinite(b.open) ||
      !Number.isFinite(b.high) ||
      !Number.isFinite(b.low) ||
      !Number.isFinite(b.close) ||
      !Number.isFinite(b.volume) ||
      b.open <= 0 ||
      b.high <= 0 ||
      b.low <= 0 ||
      b.close <= 0 ||
      b.high < b.low ||
      b.volume < 0
    ) {
      continue;
    }
    byDay.set(toUtcDateKey(b.time), b);
  }
  return Array.from(byDay.values()).sort((a, b) => a.time - b.time);
}

function barNotionalMillions(bar: Bar): number {
  const px = bar.vw !== undefined && Number.isFinite(bar.vw) && bar.vw > 0 ? bar.vw : bar.close;
  return (px * bar.volume) / 1_000_000;
}

function computeSampleStdDev(values: readonly number[]): number | null {
  if (values.length < 2) {
    return null;
  }
  let sum = 0;
  for (const v of values) {
    sum += v;
  }
  const mean = sum / values.length;
  let sqSum = 0;
  for (const v of values) {
    const d = v - mean;
    sqSum += d * d;
  }
  const variance = sqSum / (values.length - 1);
  return Number.isFinite(variance) && variance >= 0 ? Math.sqrt(variance) : null;
}

/**
 * Calcula métricas puras de retorno, rango diario, volatilidad realizada 30D (anualizada),
 * beta contra benchmark (`SPY` o índice local) y volumen promedio de 40 ruedas.
 */
export function computeEquityRiskAndReturnMetrics(params: {
  readonly bars: readonly Bar[];
  readonly benchmarkBars: readonly Bar[];
  readonly liveLast?: number | null;
  readonly livePrevClose?: number | null;
  readonly liveLow?: number | null;
  readonly liveHigh?: number | null;
  readonly liveChangePct?: number | null;
  readonly liveVolumeM?: number | null;
  readonly asOfUtcSec?: number;
}): EquityRiskReturnMetrics {
  const closed = normalizeEquityDailyBars(params.bars, params.asOfUtcSec);
  const benchClosed = normalizeEquityDailyBars(params.benchmarkBars, params.asOfUtcSec);
  const n = closed.length;
  const lastClosed = n > 0 ? closed[n - 1] : undefined;
  const prevClosed = n >= 2 ? closed[n - 2] : undefined;

  const last = sanitizeFinite(
    params.liveLast !== null && params.liveLast !== undefined && Number.isFinite(params.liveLast) && params.liveLast > 0
      ? params.liveLast
      : lastClosed?.close,
  );
  const prevClose = sanitizeFinite(
    params.livePrevClose !== null &&
      params.livePrevClose !== undefined &&
      Number.isFinite(params.livePrevClose) &&
      params.livePrevClose > 0
      ? params.livePrevClose
      : prevClosed?.close,
  );
  const dayLow = sanitizeFinite(
    params.liveLow !== null && params.liveLow !== undefined && Number.isFinite(params.liveLow) && params.liveLow > 0
      ? params.liveLow
      : lastClosed?.low,
  );
  const dayHigh = sanitizeFinite(
    params.liveHigh !== null && params.liveHigh !== undefined && Number.isFinite(params.liveHigh) && params.liveHigh > 0
      ? params.liveHigh
      : lastClosed?.high,
  );
  const dayRangePos =
    last !== null && dayLow !== null && dayHigh !== null && dayHigh > dayLow
      ? sanitizeFinite((last - dayLow) / (dayHigh - dayLow))
      : null;

  const histLastVolM =
    lastClosed !== undefined && lastClosed.volume > 0 ? sanitizeFinite(barNotionalMillions(lastClosed)) : null;
  const volumeM = sanitizeFinite(
    params.liveVolumeM !== null &&
      params.liveVolumeM !== undefined &&
      Number.isFinite(params.liveVolumeM) &&
      params.liveVolumeM >= 0
      ? params.liveVolumeM
      : histLastVolM,
  );

  const return1dPct =
    params.liveChangePct !== null &&
    params.liveChangePct !== undefined &&
    Number.isFinite(params.liveChangePct)
      ? sanitizeFinite(params.liveChangePct)
      : last !== null && prevClose !== null && prevClose > 0
        ? sanitizeFinite(((last / prevClose) - 1) * 100)
        : null;

  let return30dPct: number | null = null;
  if (last !== null && lastClosed !== undefined && n >= 20) {
    const target30Sec = lastClosed.time - 30 * 86_400;
    let idx30 = -1;
    for (let i = n - 1; i >= 0; i -= 1) {
      const b = closed[i];
      if (b !== undefined && b.time <= target30Sec) {
        idx30 = i;
        break;
      }
    }
    const anchorBar30 = idx30 >= 0 ? closed[idx30] : undefined;
    if (anchorBar30 !== undefined && n - 1 - idx30 >= 15 && anchorBar30.close > 0) {
      return30dPct = sanitizeFinite(((last / anchorBar30.close) - 1) * 100);
    }
  }

  let returnYtdOr252dPct: number | null = null;
  const firstClosed = closed[0];
  if (last !== null && lastClosed !== undefined && firstClosed !== undefined && n >= 15) {
    if (n >= 240 && lastClosed.time - firstClosed.time >= 350 * 86_400) {
      const target1ySec = lastClosed.time - 365 * 86_400;
      let idx1y = 0;
      for (let i = n - 1; i >= 0; i -= 1) {
        const b = closed[i];
        if (b !== undefined && b.time <= target1ySec) {
          idx1y = i;
          break;
        }
      }
      const anchorBar1y = closed[idx1y];
      if (anchorBar1y !== undefined && anchorBar1y.close > 0) {
        returnYtdOr252dPct = sanitizeFinite(((last / anchorBar1y.close) - 1) * 100);
      }
    } else {
      const curYear = new Date(lastClosed.time * 1_000).getUTCFullYear();
      const firstInYearIdx = closed.findIndex((b) => new Date(b.time * 1_000).getUTCFullYear() === curYear);
      let anchorIdx = -1;
      if (firstInYearIdx >= 1 && n - 1 - (firstInYearIdx - 1) >= 10) {
        anchorIdx = firstInYearIdx - 1;
      } else if (firstInYearIdx === 0 && n >= 15) {
        const d0 = new Date(firstClosed.time * 1_000);
        if (d0.getUTCMonth() === 0 && d0.getUTCDate() <= 10) {
          anchorIdx = 0;
        }
      }
      const anchorBarYtd = anchorIdx >= 0 ? closed[anchorIdx] : undefined;
      if (anchorBarYtd !== undefined && anchorBarYtd.close > 0) {
        returnYtdOr252dPct = sanitizeFinite(((last / anchorBarYtd.close) - 1) * 100);
      }
    }
  }

  let realizedVol30dPct: number | null = null;
  if (n >= 21) {
    const volBars = closed.slice(-31);
    const logReturns: number[] = [];
    for (let i = 1; i < volBars.length; i += 1) {
      const prevBar = volBars[i - 1];
      const curBar = volBars[i];
      if (prevBar !== undefined && curBar !== undefined && prevBar.close > 0 && curBar.close > 0) {
        logReturns.push(Math.log(curBar.close / prevBar.close));
      }
    }
    if (logReturns.length >= 20) {
      const sd = computeSampleStdDev(logReturns);
      if (sd !== null) {
        realizedVol30dPct = sanitizeFinite(sd * Math.sqrt(252) * 100);
      }
    }
  }

  let beta: number | null = null;
  if (n >= 21 && benchClosed.length >= 21) {
    const stockRetByDay = new Map<string, number>();
    const startStock = Math.max(1, n - 60);
    for (let i = startStock; i < n; i += 1) {
      const prevBar = closed[i - 1];
      const curBar = closed[i];
      if (prevBar !== undefined && curBar !== undefined && prevBar.close > 0 && curBar.close > 0) {
        stockRetByDay.set(toUtcDateKey(curBar.time), curBar.close / prevBar.close - 1);
      }
    }
    const benchRetByDay = new Map<string, number>();
    for (let i = 1; i < benchClosed.length; i += 1) {
      const prevBar = benchClosed[i - 1];
      const curBar = benchClosed[i];
      if (prevBar !== undefined && curBar !== undefined && prevBar.close > 0 && curBar.close > 0) {
        benchRetByDay.set(toUtcDateKey(curBar.time), curBar.close / prevBar.close - 1);
      }
    }
    const aligned: Array<readonly [number, number]> = [];
    for (const [day, ri] of stockRetByDay.entries()) {
      const rb = benchRetByDay.get(day);
      if (rb !== undefined && Number.isFinite(ri) && Number.isFinite(rb)) {
        aligned.push([ri, rb]);
      }
    }
    if (aligned.length >= 20) {
      const m = aligned.length;
      let sumI = 0;
      let sumB = 0;
      for (const [ri, rb] of aligned) {
        sumI += ri;
        sumB += rb;
      }
      const meanI = sumI / m;
      const meanB = sumB / m;
      let covSum = 0;
      let varSumB = 0;
      for (const [ri, rb] of aligned) {
        const di = ri - meanI;
        const db = rb - meanB;
        covSum += di * db;
        varSumB += db * db;
      }
      if (varSumB > 1e-12) {
        beta = sanitizeFinite(covSum / varSumB);
      }
    }
  }

  let avgVolume40dM: number | null = null;
  if (n >= 20) {
    const volWindow = closed.slice(-40);
    let totalVolM = 0;
    let positiveCount = 0;
    for (const b of volWindow) {
      const mVal = barNotionalMillions(b);
      if (Number.isFinite(mVal) && mVal >= 0) {
        totalVolM += mVal;
        if (mVal > 0) {
          positiveCount += 1;
        }
      }
    }
    if (positiveCount > 0) {
      avgVolume40dM = sanitizeFinite(totalVolM / volWindow.length);
    }
  }

  return {
    last,
    prevClose,
    dayLow,
    dayHigh,
    dayRangePos,
    volumeM,
    return1dPct,
    return30dPct,
    returnYtdOr252dPct,
    realizedVol30dPct,
    beta,
    avgVolume40dM,
    observationCount: n,
  };
}

/**
 * Construye series agregadas de volumen diario de las últimas 40 ruedas,
 * participación porcentual por papel (`Cómo se repartió`) y volatilidad
 * histórica del panel equiponderado en el tiempo.
 */
export function computePanelVolumeAndVolSeries(params: {
  readonly items: readonly {
    readonly symbol: string;
    readonly name: string;
    readonly color: string;
    readonly bars: readonly Bar[];
  }[];
  readonly asOfUtcSec?: number;
  readonly maxVolumeDays?: number;
  readonly rollingVolWindow?: number;
}): {
  readonly panelVolume40d: readonly PanelVolumeDayPoint[];
  readonly volumeAvg40dM: number | null;
  readonly volumeShareBreakdown: readonly PanelVolumeShareItem[];
  readonly panelVolHistory: readonly PanelVolHistoryPoint[];
} {
  const maxDays = params.maxVolumeDays ?? 40;
  const rollingW = params.rollingVolWindow ?? 20;

  const dailyVolumeByDate = new Map<string, number>();
  const symbolVolByDate = new Map<string, Map<string, number>>();
  const dateSet = new Set<string>();

  interface CleanSeries {
    readonly symbol: string;
    readonly name: string;
    readonly color: string;
    readonly simpleRetByDate: Map<string, number>;
    readonly logRetByDate: Map<string, number>;
  }
  const cleanSeriesList: CleanSeries[] = [];

  for (const item of params.items) {
    const closed = normalizeEquityDailyBars(item.bars, params.asOfUtcSec);
    const volMap = new Map<string, number>();
    const simpleRetByDate = new Map<string, number>();
    const logRetByDate = new Map<string, number>();

    for (let i = 0; i < closed.length; i += 1) {
      const b = closed[i];
      if (b === undefined) {
        continue;
      }
      const day = toUtcDateKey(b.time);
      dateSet.add(day);
      const vm = barNotionalMillions(b);
      if (Number.isFinite(vm) && vm > 0) {
        volMap.set(day, vm);
        dailyVolumeByDate.set(day, (dailyVolumeByDate.get(day) ?? 0) + vm);
      }
      if (i > 0) {
        const prevBar = closed[i - 1];
        if (prevBar !== undefined && prevBar.close > 0 && b.close > 0) {
          simpleRetByDate.set(day, b.close / prevBar.close - 1);
          logRetByDate.set(day, Math.log(b.close / prevBar.close));
        }
      }
    }

    symbolVolByDate.set(item.symbol, volMap);
    cleanSeriesList.push({
      symbol: item.symbol,
      name: item.name,
      color: item.color,
      simpleRetByDate,
      logRetByDate,
    });
  }

  const allDates = Array.from(dateSet).sort();
  const volDates = allDates.filter((d) => (dailyVolumeByDate.get(d) ?? 0) > 0).slice(-maxDays);
  const panelVolume40d: PanelVolumeDayPoint[] = volDates.map((d) => ({
    date: d,
    totalVolumeM: sanitizeFinite(dailyVolumeByDate.get(d)) ?? 0,
  }));

  const volumeAvg40dM =
    panelVolume40d.length > 0
      ? sanitizeFinite(
          panelVolume40d.reduce((acc, p) => acc + p.totalVolumeM, 0) / panelVolume40d.length,
        )
      : null;

  const volDateSet = new Set(volDates);
  const perStockTotals: Array<{
    readonly symbol: string;
    readonly name: string;
    readonly color: string;
    readonly volumeM: number;
  }> = [];
  let grandTotalVolM = 0;
  for (const item of params.items) {
    const map = symbolVolByDate.get(item.symbol);
    let sumM = 0;
    if (map !== undefined) {
      for (const d of volDateSet) {
        sumM += map.get(d) ?? 0;
      }
    }
    if (sumM > 0) {
      perStockTotals.push({
        symbol: item.symbol,
        name: item.name,
        color: item.color,
        volumeM: sumM,
      });
      grandTotalVolM += sumM;
    }
  }
  perStockTotals.sort((a, b) => b.volumeM - a.volumeM);

  const volumeShareBreakdown: PanelVolumeShareItem[] = [];
  if (grandTotalVolM > 0) {
    const topItems = perStockTotals.slice(0, 6);
    for (const s of topItems) {
      volumeShareBreakdown.push({
        symbol: s.symbol,
        name: s.name,
        color: s.color,
        volumeM: sanitizeFinite(s.volumeM) ?? 0,
        sharePct: sanitizeFinite((s.volumeM / grandTotalVolM) * 100) ?? 0,
      });
    }
    const restSumM = perStockTotals.slice(6).reduce((acc, s) => acc + s.volumeM, 0);
    if (restSumM > 0) {
      volumeShareBreakdown.push({
        symbol: 'RESTO',
        name: 'Resto del panel',
        color: '#52526B',
        volumeM: sanitizeFinite(restSumM) ?? 0,
        sharePct: sanitizeFinite((restSumM / grandTotalVolM) * 100) ?? 0,
      });
    }
  }

  const panelReturnSeries: Array<{ readonly date: string; readonly logRet: number; readonly constituents: number }> = [];
  for (const d of allDates) {
    let sumRet = 0;
    let count = 0;
    for (const s of cleanSeriesList) {
      const r = s.simpleRetByDate.get(d);
      if (r !== undefined && Number.isFinite(r)) {
        sumRet += r;
        count += 1;
      }
    }
    if (count >= 3) {
      const avgSimple = sumRet / count;
      if (1 + avgSimple > 0) {
        panelReturnSeries.push({
          date: d,
          logRet: Math.log(1 + avgSimple),
          constituents: count,
        });
      }
    }
  }

  const panelVolHistoryAll: PanelVolHistoryPoint[] = [];
  for (let idx = rollingW - 1; idx < panelReturnSeries.length; idx += 1) {
    const slice = panelReturnSeries.slice(idx - rollingW + 1, idx + 1);
    const sliceDates = slice.map((p) => p.date);
    const panelSd = computeSampleStdDev(slice.map((p) => p.logRet));
    if (panelSd === null) {
      continue;
    }
    const panelVolPct = sanitizeFinite(panelSd * Math.sqrt(252) * 100);
    if (panelVolPct === null) {
      continue;
    }

    let sumStockVol = 0;
    let stockVolCount = 0;
    for (const s of cleanSeriesList) {
      const logs: number[] = [];
      for (const sdDate of sliceDates) {
        const lr = s.logRetByDate.get(sdDate);
        if (lr !== undefined && Number.isFinite(lr)) {
          logs.push(lr);
        }
      }
      if (logs.length >= Math.max(12, Math.floor(rollingW * 0.7))) {
        const sd = computeSampleStdDev(logs);
        if (sd !== null) {
          sumStockVol += sd * Math.sqrt(252) * 100;
          stockVolCount += 1;
        }
      }
    }

    const curPanelPoint = panelReturnSeries[idx];
    if (curPanelPoint !== undefined) {
      panelVolHistoryAll.push({
        date: curPanelPoint.date,
        panelVolPct,
        avgStockVolPct: stockVolCount > 0 ? sanitizeFinite(sumStockVol / stockVolCount) : null,
        constituents: curPanelPoint.constituents,
      });
    }
  }

  return {
    panelVolume40d,
    volumeAvg40dM,
    volumeShareBreakdown,
    panelVolHistory: panelVolHistoryAll.slice(-60),
  };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIdx = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const runWorker = async (): Promise<void> => {
    while (nextIdx < items.length) {
      const idx = nextIdx;
      nextIdx += 1;
      const item = items[idx];
      if (item !== undefined) {
        results[idx] = await fn(item, idx);
      }
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

interface V2StockBatchQuote {
  readonly ticker: string;
  readonly price: number;
  readonly dayClose: number;
  readonly previousClose: number;
  readonly change: number;
  readonly changePct: number;
  readonly dayLow: number;
  readonly dayHigh: number;
  readonly volume: number;
  readonly vwap: number;
  readonly bid: number;
  readonly ask: number;
  readonly bidSize: number;
  readonly askSize: number;
  readonly marketStatus: string | null;
}

function firstPositiveFinite(values: readonly (number | null | undefined)[]): number {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      return v;
    }
  }
  return Number.NaN;
}

function asFiniteNum(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : Number.NaN;
}

function asPositiveNum(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : Number.NaN;
}

function withMassiveAuthUrl(rawUrl: string, apiKey: string): string {
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.toLowerCase();
  const paramName = host === 'api.massive.com' || host.endsWith('.massive.com') ? 'apikey' : 'apiKey';
  parsed.searchParams.set(paramName, apiKey);
  return parsed.toString();
}

function parseV2StockTickerSnapshot(raw: unknown): V2StockBatchQuote | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  const tickerRaw = rec['ticker'];
  if (typeof tickerRaw !== 'string' || tickerRaw.trim() === '') {
    return null;
  }
  const ticker = tickerRaw.trim().toUpperCase();
  const day = (rec['day'] !== null && typeof rec['day'] === 'object' ? rec['day'] : {}) as Record<string, unknown>;
  const prevDay = (rec['prevDay'] !== null && typeof rec['prevDay'] === 'object' ? rec['prevDay'] : {}) as Record<string, unknown>;
  const minBar = (rec['min'] !== null && typeof rec['min'] === 'object' ? rec['min'] : {}) as Record<string, unknown>;
  const lastTrade = (rec['lastTrade'] !== null && typeof rec['lastTrade'] === 'object' ? rec['lastTrade'] : {}) as Record<string, unknown>;
  const lastQuote = (rec['lastQuote'] !== null && typeof rec['lastQuote'] === 'object' ? rec['lastQuote'] : {}) as Record<string, unknown>;

  const dayClose = asPositiveNum(day['c']);
  const dayLow = asPositiveNum(day['l']);
  const dayHigh = asPositiveNum(day['h']);
  const volume = asPositiveNum(day['v']);
  const vwap = asPositiveNum(day['vw']);
  const prevClose = asPositiveNum(prevDay['c']);
  const lastTradePx = asPositiveNum(lastTrade['p']);
  const minClose = asPositiveNum(minBar['c']);
  const bid = asPositiveNum(lastQuote['p']);
  const ask = asPositiveNum(lastQuote['P']);
  const bidSize = asPositiveNum(lastQuote['s']);
  const askSize = asPositiveNum(lastQuote['S']);
  const quoteMid =
    Number.isFinite(bid) && Number.isFinite(ask) && ask >= bid ? 0.5 * (bid + ask) : Number.NaN;
  const price = firstPositiveFinite([dayClose, lastTradePx, minClose, quoteMid]);
  const change = asFiniteNum(rec['todaysChange']);
  const changePct = asFiniteNum(rec['todaysChangePerc']);
  const marketStatusRaw = rec['market_status'];
  const marketStatus = typeof marketStatusRaw === 'string' && marketStatusRaw.trim() !== '' ? marketStatusRaw.trim() : null;

  return {
    ticker,
    price,
    dayClose,
    previousClose: prevClose,
    change,
    changePct,
    dayLow,
    dayHigh,
    volume,
    vwap,
    bid,
    ask,
    bidSize,
    askSize,
    marketStatus,
  };
}

interface EffectiveOpraContractsResult {
  readonly contracts: readonly OptionSnapshotContract[];
  readonly usedEodCloseRef: boolean;
  readonly liveNbboCount: number;
  /** Pieza 50.9: tickers con punta sustituida por referencia EOD (sin cotización nueva). */
  readonly eodFixedTickers: ReadonlySet<string>;
}

function applyEodCloseRefQuotes(
  contracts: readonly OptionSnapshotContract[],
  params: { readonly evalSecUs: number; readonly marketIsClosed: boolean },
): EffectiveOpraContractsResult {
  let liveNbboCount = 0;
  let eodFixableCount = 0;
  for (const c of contracts) {
    if (c.expirationTime <= params.evalSecUs) {
      continue;
    }
    const { bid, ask } = c.lastQuote;
    if (Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask >= bid) {
      liveNbboCount += 1;
    } else {
      const ref = firstPositiveFinite([
        c.day.close,
        c.lastTrade.price,
        c.day.vwap,
        c.day.previousClose,
      ]);
      if (Number.isFinite(ref) && ref > 0) {
        eodFixableCount += 1;
      }
    }
  }

  const shouldUseEodRef =
    eodFixableCount > 0 &&
    (liveNbboCount < 4 || (params.marketIsClosed && liveNbboCount < eodFixableCount));

  if (!shouldUseEodRef) {
    return { contracts, usedEodCloseRef: false, liveNbboCount, eodFixedTickers: new Set<string>() };
  }

  let modified = false;
  const eodFixedTickers = new Set<string>();
  const mapped = contracts.map((c) => {
    const { bid, ask, bidSize, askSize } = c.lastQuote;
    if (Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask >= bid) {
      return c;
    }
    const ref = firstPositiveFinite([
      c.day.close,
      c.lastTrade.price,
      c.day.vwap,
      c.day.previousClose,
    ]);
    if (!Number.isFinite(ref) || ref <= 0) {
      return c;
    }
    modified = true;
    eodFixedTickers.add(c.ticker);
    return {
      ...c,
      lastQuote: {
        ...c.lastQuote,
        bid: ref * 0.995,
        ask: ref * 1.005,
        midpoint: ref,
        bidSize: Number.isFinite(bidSize) && bidSize > 0 ? bidSize : 1,
        askSize: Number.isFinite(askSize) && askSize > 0 ? askSize : 1,
      },
    };
  });

  return {
    contracts: mapped,
    usedEodCloseRef: modified,
    liveNbboCount,
    eodFixedTickers,
  };
}

function resolveStockSnapshotWith1dFallback(params: {
  readonly ticker: string;
  readonly v2: V2StockBatchQuote | undefined;
  readonly v3: UnifiedStockSnapshot | undefined;
  readonly bars1d: readonly Bar[];
  readonly cachedIvMap: ReadonlyMap<string, number>;
}): SerializedUnifiedQuote {
  const { ticker, v2, v3, bars1d } = params;
  const lastBar = bars1d.length > 0 ? bars1d[bars1d.length - 1] : undefined;
  const prevBar = bars1d.length > 1 ? bars1d[bars1d.length - 2] : undefined;

  const snapDayClose = firstPositiveFinite([
    v2?.dayClose,
    v3 !== undefined && Number.isFinite(v3.session.close) && v3.session.close > 0 ? v3.session.close : Number.NaN,
  ]);
  const v3Price = v3 !== undefined ? resolveUnifiedStockPrice(v3) : Number.NaN;
  const use1dBarFallback = (!Number.isFinite(snapDayClose) || snapDayClose <= 0) && lastBar !== undefined;

  const priceRaw = use1dBarFallback
    ? firstPositiveFinite([lastBar.close, v2?.price, v3Price])
    : firstPositiveFinite([v2?.price, v3Price, snapDayClose, lastBar?.close]);
  const dayLowRaw = use1dBarFallback
    ? firstPositiveFinite([lastBar.low, v2?.dayLow, v3?.session.low])
    : firstPositiveFinite([v2?.dayLow, v3?.session.low, lastBar?.low]);
  const dayHighRaw = use1dBarFallback
    ? firstPositiveFinite([lastBar.high, v2?.dayHigh, v3?.session.high])
    : firstPositiveFinite([v2?.dayHigh, v3?.session.high, lastBar?.high]);
  const volumeRaw = use1dBarFallback
    ? firstPositiveFinite([lastBar.volume, v2?.volume, v3?.session.volume])
    : firstPositiveFinite([v2?.volume, v3?.session.volume, lastBar?.volume]);
  const vwapRaw = use1dBarFallback
    ? firstPositiveFinite([lastBar.vw, lastBar.close, v2?.vwap, v3?.session.vwap, priceRaw])
    : firstPositiveFinite([v2?.vwap, v3?.session.vwap, priceRaw, lastBar?.vw]);
  const prevCloseRaw = use1dBarFallback
    ? firstPositiveFinite([prevBar?.close, v2?.previousClose, v3?.session.previousClose])
    : firstPositiveFinite([v2?.previousClose, v3?.session.previousClose, prevBar?.close]);

  const changeRaw =
    Number.isFinite(priceRaw) && Number.isFinite(prevCloseRaw) && prevCloseRaw > 0
      ? priceRaw - prevCloseRaw
      : firstPositiveFinite([v2?.change, v3?.session.change]);
  const changePctRaw =
    use1dBarFallback && Number.isFinite(priceRaw) && Number.isFinite(prevCloseRaw) && prevCloseRaw > 0
      ? ((priceRaw - prevCloseRaw) / prevCloseRaw) * 100
      : Number.isFinite(v2?.changePct)
        ? (v2?.changePct ?? Number.NaN)
        : v3 !== undefined && Number.isFinite(v3.session.changePercent)
          ? v3.session.changePercent
          : Number.isFinite(priceRaw) && Number.isFinite(prevCloseRaw) && prevCloseRaw > 0
            ? ((priceRaw - prevCloseRaw) / prevCloseRaw) * 100
            : Number.NaN;

  const price = sanitizeFinite(priceRaw);
  const previousClose = sanitizeFinite(prevCloseRaw);
  const change = Number.isFinite(changeRaw) ? changeRaw : price !== null && previousClose !== null ? price - previousClose : null;
  const changePct = sanitizeFinite(changePctRaw);
  const dayLow = sanitizeFinite(dayLowRaw);
  const dayHigh = sanitizeFinite(dayHighRaw);
  const dayRangePos =
    price !== null && dayLow !== null && dayHigh !== null && dayHigh > dayLow
      ? sanitizeFinite(Math.max(0, Math.min(1, (price - dayLow) / (dayHigh - dayLow))))
      : null;

  const volume = sanitizeFinite(volumeRaw);
  const refVw = Number.isFinite(vwapRaw) && vwapRaw > 0 ? vwapRaw : priceRaw;
  const tradedVolumeUsd =
    Number.isFinite(volumeRaw) && volumeRaw > 0 && Number.isFinite(refVw) && refVw > 0
      ? sanitizeFinite(volumeRaw * refVw)
      : null;
  const volumeM = tradedVolumeUsd !== null ? sanitizeFinite(tradedVolumeUsd / 1_000_000) : null;

  const qBid = sanitizeFinite(firstPositiveFinite([v2?.bid, v3?.lastQuote?.bid]));
  const qAsk = sanitizeFinite(firstPositiveFinite([v2?.ask, v3?.lastQuote?.ask]));
  const qBidSize = sanitizeFinite(firstPositiveFinite([v2?.bidSize, v3?.lastQuote?.bidSize]));
  const qAskSize = sanitizeFinite(firstPositiveFinite([v2?.askSize, v3?.lastQuote?.askSize]));
  const qSpreadPct =
    qBid !== null && qAsk !== null && qAsk >= qBid && qBid + qAsk > 0
      ? sanitizeFinite(((qAsk - qBid) / (0.5 * (qBid + qAsk))) * 100)
      : null;

  return {
    ticker,
    assetType: 'stock',
    price,
    change,
    changePct,
    previousClose,
    dayLow,
    dayHigh,
    dayRangePos,
    volumeM,
    tradedVolumeUsd,
    iv30d: sanitizeFinite(params.cachedIvMap.get(ticker) ?? null),
    marketStatus: v3?.marketStatus ?? v2?.marketStatus ?? null,
    volume,
    bid: qBid,
    ask: qAsk,
    bidSize: qBidSize,
    askSize: qAskSize,
    spreadPct: qSpreadPct,
  };
}

function parseCsvLineValues(line: string): readonly string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      out.push(cur.trim());
      cur = '';
    } else if (ch !== undefined) {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

function parseTreasuryDateIso(rawDate: string): string | null {
  const trimmed = rawDate.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  const slashMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(trimmed);
  if (
    slashMatch !== null &&
    slashMatch[1] !== undefined &&
    slashMatch[2] !== undefined &&
    slashMatch[3] !== undefined
  ) {
    return `${slashMatch[3]}-${slashMatch[1]}-${slashMatch[2]}`;
  }
  return null;
}

function parseTreasuryPercentToDecimal(rawVal: string | undefined): number {
  if (rawVal === undefined) return Number.NaN;
  const trimmed = rawVal.trim();
  if (trimmed === '' || trimmed === '.' || trimmed.toUpperCase() === 'N/A' || trimmed.toUpperCase() === 'ND') {
    return Number.NaN;
  }
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n / 100 : Number.NaN;
}

async function fetchNyFedSofrDecimal(fetchFn: FetchFn): Promise<{ readonly sofr: number; readonly date: string | null; readonly error: string | null }> {
  try {
    const res = await fetchFn(NYFED_SOFR_LAST_URL);
    if (!res.ok) {
      return { sofr: Number.NaN, date: null, error: `NY Fed SOFR HTTP ${String(res.status)}` };
    }
    const parsed = JSON.parse(res.text) as Record<string, unknown>;
    const refRates = parsed['refRates'];
    if (!Array.isArray(refRates) || refRates.length === 0) {
      return { sofr: Number.NaN, date: null, error: 'NY Fed SOFR empty refRates' };
    }
    const first = refRates[0] as Record<string, unknown>;
    const pct = typeof first['percentRate'] === 'number' ? first['percentRate'] : Number(first['percentRate']);
    const date = typeof first['effectiveDate'] === 'string' ? first['effectiveDate'] : null;
    if (!Number.isFinite(pct) || pct < 0) {
      return { sofr: Number.NaN, date, error: 'NY Fed SOFR invalid percentRate' };
    }
    return { sofr: pct / 100, date, error: null };
  } catch (err: unknown) {
    return { sofr: Number.NaN, date: null, error: extractErrorMessage(err, 'NY Fed SOFR request failed') };
  }
}

async function fetchFredSeriesLatestDecimal(fetchFn: FetchFn, seriesId: string): Promise<{ readonly date: string | null; readonly rate: number }> {
  try {
    const res = await fetchFn(`${FRED_GRAPH_CSV_BASE}?id=${encodeURIComponent(seriesId)}`);
    if (!res.ok) {
      return { date: null, rate: Number.NaN };
    }
    const lines = res.text.trim().split(/\r?\n/);
    for (let i = lines.length - 1; i >= 1; i -= 1) {
      const line = lines[i];
      if (line === undefined || line.trim() === '') continue;
      const [dateStr, valStr] = parseCsvLineValues(line);
      const dec = parseTreasuryPercentToDecimal(valStr);
      if (Number.isFinite(dec)) {
        return { date: dateStr ?? null, rate: dec };
      }
    }
    return { date: null, rate: Number.NaN };
  } catch {
    return { date: null, rate: Number.NaN };
  }
}

async function fetchFallbackUsTreasuryCurve(
  fetchFn: FetchFn,
  nowMs: number,
): Promise<{ readonly observation: TreasuryYieldObservation | null; readonly error: string | null }> {
  const year = new Date(nowMs).getUTCFullYear();
  const csvUrl = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${String(year)}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${String(year)}&_format=csv`;

  let dateStr: string | null = null;
  let y1m = Number.NaN;
  let y3m = Number.NaN;
  let y6m = Number.NaN;
  let y1y = Number.NaN;
  let y2y = Number.NaN;
  let y3y = Number.NaN;
  let y5y = Number.NaN;
  let y7y = Number.NaN;
  let y10y = Number.NaN;
  let y20y = Number.NaN;
  let y30y = Number.NaN;
  const errors: string[] = [];

  try {
    const res = await fetchFn(csvUrl);
    if (res.ok && res.text.trim() !== '') {
      const lines = res.text.trim().split(/\r?\n/);
      if (lines.length >= 2) {
        const headers = parseCsvLineValues(lines[0] ?? '').map((h) => h.toLowerCase());
        const findCol = (candidates: readonly string[]): number =>
          headers.findIndex((h) => candidates.some((c) => h === c || h.includes(c)));
        const idxDate = findCol(['date']);
        const idx1m = findCol(['1 mo', '1 month']);
        const idx3m = findCol(['3 mo', '3 month']);
        const idx6m = findCol(['6 mo', '6 month']);
        const idx1y = findCol(['1 yr', '1 year']);
        const idx2y = findCol(['2 yr', '2 year']);
        const idx3y = findCol(['3 yr', '3 year']);
        const idx5y = findCol(['5 yr', '5 year']);
        const idx7y = findCol(['7 yr', '7 year']);
        const idx10y = findCol(['10 yr', '10 year']);
        const idx20y = findCol(['20 yr', '20 year']);
        const idx30y = findCol(['30 yr', '30 year']);

        for (let r = 1; r < lines.length; r += 1) {
          const cols = parseCsvLineValues(lines[r] ?? '');
          const isoDate = idxDate >= 0 ? parseTreasuryDateIso(cols[idxDate] ?? '') : null;
          if (isoDate === null) continue;
          if (dateStr !== null && isoDate <= dateStr) continue;
          const cand2y = idx2y >= 0 ? parseTreasuryPercentToDecimal(cols[idx2y]) : Number.NaN;
          const cand10y = idx10y >= 0 ? parseTreasuryPercentToDecimal(cols[idx10y]) : Number.NaN;
          if (!Number.isFinite(cand2y) && !Number.isFinite(cand10y)) continue;
          dateStr = isoDate;
          y1m = idx1m >= 0 ? parseTreasuryPercentToDecimal(cols[idx1m]) : Number.NaN;
          y3m = idx3m >= 0 ? parseTreasuryPercentToDecimal(cols[idx3m]) : Number.NaN;
          y6m = idx6m >= 0 ? parseTreasuryPercentToDecimal(cols[idx6m]) : Number.NaN;
          y1y = idx1y >= 0 ? parseTreasuryPercentToDecimal(cols[idx1y]) : Number.NaN;
          y2y = cand2y;
          y3y = idx3y >= 0 ? parseTreasuryPercentToDecimal(cols[idx3y]) : Number.NaN;
          y5y = idx5y >= 0 ? parseTreasuryPercentToDecimal(cols[idx5y]) : Number.NaN;
          y7y = idx7y >= 0 ? parseTreasuryPercentToDecimal(cols[idx7y]) : Number.NaN;
          y10y = cand10y;
          y20y = idx20y >= 0 ? parseTreasuryPercentToDecimal(cols[idx20y]) : Number.NaN;
          y30y = idx30y >= 0 ? parseTreasuryPercentToDecimal(cols[idx30y]) : Number.NaN;
        }
      }
    } else if (!res.ok) {
      errors.push(`US Treasury HTTP ${String(res.status)}`);
    }
  } catch (err: unknown) {
    errors.push(extractErrorMessage(err, 'US Treasury CSV failed'));
  }

  if (!Number.isFinite(y2y) || !Number.isFinite(y10y)) {
    const [f1m, f3m, f1y, f2y, f10y] = await Promise.all([
      Number.isFinite(y1m) ? Promise.resolve({ date: dateStr, rate: y1m }) : fetchFredSeriesLatestDecimal(fetchFn, 'DGS1MO'),
      Number.isFinite(y3m) ? Promise.resolve({ date: dateStr, rate: y3m }) : fetchFredSeriesLatestDecimal(fetchFn, 'DGS3MO'),
      Number.isFinite(y1y) ? Promise.resolve({ date: dateStr, rate: y1y }) : fetchFredSeriesLatestDecimal(fetchFn, 'DGS1'),
      Number.isFinite(y2y) ? Promise.resolve({ date: dateStr, rate: y2y }) : fetchFredSeriesLatestDecimal(fetchFn, 'DGS2'),
      Number.isFinite(y10y) ? Promise.resolve({ date: dateStr, rate: y10y }) : fetchFredSeriesLatestDecimal(fetchFn, 'DGS10'),
    ]);
    y1m = Number.isFinite(y1m) ? y1m : f1m.rate;
    y3m = Number.isFinite(y3m) ? y3m : f3m.rate;
    y1y = Number.isFinite(y1y) ? y1y : f1y.rate;
    y2y = Number.isFinite(y2y) ? y2y : f2y.rate;
    y10y = Number.isFinite(y10y) ? y10y : f10y.rate;
    dateStr = dateStr ?? f10y.date ?? f2y.date;
  }

  const allTenors = [y1m, y3m, y6m, y1y, y2y, y3y, y5y, y7y, y10y, y20y, y30y];
  const finiteTenors = allTenors.filter((v) => Number.isFinite(v)).length;
  if (finiteTenors === 0 || dateStr === null) {
    return {
      observation: null,
      error: errors.length > 0 ? errors.join('; ') : 'Fallback Treasury curve empty',
    };
  }

  const parsedMs = Date.parse(`${dateStr}T00:00:00Z`);
  const dateTime = Number.isFinite(parsedMs) ? Math.floor(parsedMs / 1_000) : Math.floor(nowMs / 1_000);

  return {
    observation: {
      date: dateStr,
      dateTime,
      yield1Month: y1m,
      yield3Month: y3m,
      yield6Month: y6m,
      yield1Year: y1y,
      yield2Year: y2y,
      yield3Year: y3y,
      yield5Year: y5y,
      yield7Year: y7y,
      yield10Year: y10y,
      yield20Year: y20y,
      yield30Year: y30y,
      finiteTenors,
    },
    error: null,
  };
}

/**
 * Pieza 42: fusiona explícitamente el baseline RTH con cotizaciones de horario
 * extendido (`PRE_MARKET` / `AFTER_HOURS`). En horario extendido, el batch RTH
 * jamás sobrescribe un tick extendido válido y se preservan `regularClose`,
 * `previousClose`, `extendedPrice`, `extendedChangePct` y `sessionPhase`.
 */
export function mergeUsRegularAndExtendedQuote(input: {
  readonly regular: MarketTickQuote | null;
  readonly extended: MarketTickQuote | null;
  readonly sessionPhase: UsEquitySessionPhase;
}): MarketTickQuote | null {
  const { regular, extended, sessionPhase } = input;
  if (regular === null && extended === null) {
    return null;
  }
  const previousClose = regular?.previousClose ?? extended?.previousClose ?? null;
  const regularClose =
    sessionPhase === 'PRE_MARKET'
      ? (regular?.previousClose ?? regular?.regularClose ?? regular?.price ?? extended?.regularClose ?? null)
      : sessionPhase === 'RTH'
        ? (regular?.regularClose ?? previousClose)
        : (regular?.regularClose ?? regular?.price ?? extended?.regularClose ?? previousClose);

  if (
    isExtendedHoursPhase(sessionPhase) &&
    extended !== null &&
    Number.isFinite(extended.price) &&
    extended.price > 0
  ) {
    const extRef =
      sessionPhase === 'AFTER_HOURS'
        ? (regularClose ?? previousClose)
        : (previousClose ?? regularClose);
    const extendedChangePct =
      extRef !== null && extRef > 0
        ? ((extended.price - extRef) / extRef) * 100
        : (extended.extendedChangePct ?? extended.changePct ?? null);
    const mergedChangePct =
      sessionPhase === 'PRE_MARKET'
        ? (extendedChangePct ?? regular?.changePct ?? null)
        : (regular?.changePct ?? extendedChangePct);
    const mergedDayLow =
      regular?.dayLow ?? extended.dayLow ?? null;
    const mergedDayHigh =
      regular?.dayHigh ?? extended.dayHigh ?? null;
    return {
      market: 'US',
      symbol: extended.symbol,
      kind: regular?.kind ?? extended.kind,
      currency: 'USD',
      price: extended.price,
      previousClose,
      changePct: mergedChangePct,
      dayLow: mergedDayLow,
      dayHigh: mergedDayHigh,
      volume: extended.volume ?? regular?.volume ?? null,
      turnover: regular?.turnover ?? extended.turnover ?? null,
      asOfUtcSec: extended.asOfUtcSec ?? regular?.asOfUtcSec ?? null,
      source: extended.source,
      exchange: regular?.exchange ?? extended.exchange ?? null,
      regularClose,
      extendedPrice: extended.price,
      extendedChangePct,
      sessionPhase,
    };
  }

  const base = regular ?? extended;
  if (base === null) return null;
  if (sessionPhase === 'CLOSED') {
    const extPrice =
      extended !== null && Number.isFinite(extended.price) && extended.price > 0
        ? extended.price
        : (base.extendedPrice ?? null);
    const extRef = regularClose ?? previousClose;
    const extChangePct =
      extPrice !== null && extRef !== null && extRef > 0
        ? ((extPrice - extRef) / extRef) * 100
        : (extended?.extendedChangePct ?? base.extendedChangePct ?? null);
    return {
      ...base,
      previousClose,
      regularClose,
      extendedPrice: extPrice,
      extendedChangePct: extChangePct,
      sessionPhase: 'CLOSED',
    };
  }

  return {
    ...base,
    previousClose,
    regularClose,
    extendedPrice: null,
    extendedChangePct: null,
    sessionPhase: 'RTH',
  };
}

/**
 * Runtime central en servidor para datos de mercado, cálculos cuantitativos y WebSocket live.
 */
export class MarketRuntime {
  private readonly apiKey: string;
  private readonly secrets: readonly string[];
  private readonly baseUrl: string | undefined;
  private readonly fetchFn: FetchFn;
  private readonly restTelemetry = new RollingFeedTelemetry({
    latencyKind: 'HTTP_ROUND_TRIP',
  });
  private readonly loadBarsFn: typeof loadBars;
  private readonly loadOptionChainFn: typeof loadOptionChain;
  private readonly loadOptionContractsFn: typeof loadOptionContracts;
  private readonly loadTreasuryYieldsFn: typeof loadTreasuryYields;
  private readonly loadFundingConditionsFn: typeof loadFundingConditions;
  private readonly loadUnifiedSnapshotFn: typeof loadUnifiedSnapshot;
  private readonly loadDividendsFn: typeof loadDividends;
  private readonly loadUnusualTradesFn: typeof loadUnusualTrades;
  private readonly createWsClientFn: (options: MassiveWsClientOptions) => MassiveWsClientLike;
  private readonly nowMsFn: () => number;
  private readonly enableWs: boolean;
  private readonly watchedSymbols: readonly string[];
  /**
   * Clave inyectada explícitamente por deps SOLO si difiere de la cadena de
   * entorno (tests/harness); `null` => delega al pool multi-key (Pieza 32).
   */
  private readonly depsApiKey: string | null;
  private readonly tradierConfigOverride: TradierConfig | null;
  private readonly tradierHistoricalBarsRequested: boolean;
  private tradierManager: TradierLiveManager | null;
  private readonly tradierChainFetchFn: typeof fetchTradierOptionChain;
  private readonly tradierQuotesFetchFn: typeof fetchTradierQuotes;
  private readonly tradierCreateSocketFn: TradierSocketFactory | undefined;
  private readonly tradierHttpFn: TradierHttpFn | undefined;
  private readonly oratsClient: OratsHybridClient | null;
  private readonly usVolSurfaceCache = new Map<
    string,
    { readonly fetchedAtMs: number; readonly response: UsVolSurfaceResponse }
  >();
  private readonly usVolSurfaceInFlight = new Map<string, Promise<UsVolSurfaceResponse>>();
  private lastUsOptionsPrefetchError: string | null = null;
  private readonly tradierChainCache = new Map<
    string,
    { readonly atMs: number; readonly result: TradierOptionChainResult }
  >();
  private readonly tradierChainInFlight = new Map<string, Promise<TradierOptionChainResult>>();
  private readonly tradierQuoteTicks = new Map<string, MarketTickQuote>();
  private readonly fmpConfigOverride: FmpConfig | null;
  private readonly fmpClient: FmpEnterpriseClient;
  private fmpBatchTimer: ReturnType<typeof setTimeout> | null = null;
  private fmpBatchRunning = false;
  private fmpExtendedTimer: ReturnType<typeof setTimeout> | null = null;
  private fmpExtendedRunning = false;
  private readonly fmpQuoteTicks = new Map<string, MarketTickQuote>();
  private readonly fmpExtendedQuoteTicks = new Map<string, MarketTickQuote>();
  private readonly fmpTelemetry = new RollingFeedTelemetry({ latencyKind: 'HTTP_ROUND_TRIP' });
  private readonly tradierAuthBreaker = new TradierAuthCircuitBreaker();
  private negotiatedTradierConfig: TradierConfig | null = null;
  private readonly tradierHistoricalClient: TradierHistoricalClient | null;
  private tradierStocksStream: TradierStocksStream | null = null;
  private readonly massiveStocksModeOverride: ReturnType<typeof resolveMassiveStocksMode> | null;
  private readonly injectedMarketHarness: boolean;

  private get fmpConfig(): FmpConfig {
    if (this.fmpConfigOverride !== null) return this.fmpConfigOverride;
    return this.injectedMarketHarness ? loadFmpConfigFromEnv({}) : resolveFmpConfig();
  }

  private get fmpHistoricalProviderEnabled(): boolean {
    return this.fmpConfig.configured && (!this.injectedMarketHarness || this.fmpConfigOverride !== null);
  }

  private get tradierConfig(): TradierConfig {
    if (this.tradierConfigOverride !== null) return this.tradierConfigOverride;
    return this.injectedMarketHarness
      ? {
          accessToken: null,
          tokenEnvName: null,
          apiEnv: 'prod',
          restBaseUrl: TRADIER_PROD_REST_BASE,
          wsBaseUrl: TRADIER_WS_BASE,
          configured: false,
          tokenIsGeneric: false,
          sandboxFallbackAllowed: false,
        }
      : resolveTradierConfig();
  }

  private get tradierHistoricalProviderEnabled(): boolean {
    return this.tradierConfig.configured && (!this.injectedMarketHarness || this.tradierHistoricalBarsRequested);
  }

  private get massiveStocksMode(): ReturnType<typeof resolveMassiveStocksMode> {
    if (this.massiveStocksModeOverride !== null) return this.massiveStocksModeOverride;
    return this.injectedMarketHarness ? 'MASSIVE_STOCKS_ENABLED' : resolveMassiveStocksMode();
  }

  private readonly snapshotCache: SingleFlightRuntimeCache<TerminalSnapshotResponse>;
  private readonly barsCache: SingleFlightRuntimeCache<TerminalBarsResponse>;
  private readonly unusualCache: SingleFlightRuntimeCache<TerminalUnusualResponse>;
  private readonly treasuryCache: SingleFlightRuntimeCache<Awaited<ReturnType<typeof loadTreasuryYields>>>;
  private readonly fundingCache: SingleFlightRuntimeCache<Awaited<ReturnType<typeof loadFundingConditions>>>;
  private readonly unifiedCache: SingleFlightRuntimeCache<Awaited<ReturnType<typeof loadUnifiedSnapshot>>>;
  private readonly stocksV2Cache: SingleFlightRuntimeCache<{
    readonly map: ReadonlyMap<string, V2StockBatchQuote>;
    readonly error: string | null;
  }>;
  private readonly nyfedSofrCache: SingleFlightRuntimeCache<{
    readonly sofr: number;
    readonly date: string | null;
    readonly error: string | null;
  }>;
  private readonly fallbackTreasuryCache: SingleFlightRuntimeCache<{
    readonly observation: TreasuryYieldObservation | null;
    readonly error: string | null;
  }>;
  private readonly daily1dCache: SingleFlightRuntimeCache<readonly Bar[]>;
  private readonly usPanelCache: SingleFlightRuntimeCache<EquityPanelAnalyticsDto>;
  private readonly earningsCatalystCache: SingleFlightRuntimeCache<FmpSymbolEarningsResult>;
  private readonly macroCalendarCache: SingleFlightRuntimeCache<FmpMacroCalendarResult>;
  /** Pieza 50.5: anclas Auto-AVWAP por símbolo/día (`US:SYM:YYYY-MM-DD`, máx 500). */
  private readonly autoAvwapCache: SingleFlightRuntimeCache<readonly AutoAvwapAnchor[]>;
  /** Pieza 50.5: calendario macro plurianual FOMC/CPI compartido por índices/ETFs (1 por día, máx 4). */
  private readonly macroCalendarHistoryCache: SingleFlightRuntimeCache<FmpMacroCalendarResult>;
  /** Pieza 50.5: guard de re-entrada para no reingresar a la caché durante el fetch 1D anidado. */
  private readonly autoAvwapResolveInFlight = new Set<string>();
  /** Pieza 50.2: catálogo 100 % de vencimientos OPRA por subyacente (TTL 12 min). */
  private readonly usExpiryCatalogCache: SingleFlightRuntimeCache<UsExpiryCatalogResult>;
  /** Pieza 50.2: cadena on-demand por vencimiento exacto (TTL dinámico RTH/fuera de RTH). */
  private readonly usExpiryChainCache: SingleFlightRuntimeCache<UsOptionExpiryChainResponse>;

  private stockWsClient: MassiveWsClientLike | null = null;
  private optionsWsClient: MassiveWsClientLike | null = null;
  private massiveStocksStream: MassiveStocksStream | null = null;
  /** Pieza 40: leases dinámicos por conexión WebSocket enfocada. */
  private readonly massiveSymbolLeases = new Map<string, Set<string>>();
  private massiveReconnectInFlight: Promise<void> | null = null;
  private lastUsPanelBase: EquityPanelAnalyticsDto | null = null;
  private readonly liveStates1m = new Map<string, LiveBarState>();
  /** Pieza 39: historial profundo ADR (gap electoral) con caché LRU + disco. */
  private readonly ggalDeepHistory = new GgalAdrDeepHistoryStore();
  /** Pieza 41: caché profunda separada por proveedor para no mezclar Massive/FMP. */
  private readonly ggalFmpDeepHistory = new GgalAdrDeepHistoryStore({
    cacheDir: resolve(process.cwd(), '.cache', 'ggal-deep-history', 'fmp-enterprise'),
  });
  /** Pieza 39: motor tick-by-tick GGAL (ADR/ARS/CCL) con broadcast WS. */
  private readonly ggalTickEngine: GgalTickStreamEngine;
  private readonly closedInputs1m = new Map<
    string,
    {
      readonly ema: { readonly lastClosedEma: number; readonly period: number };
      readonly sessionVwap: {
        readonly closedState: ReturnType<typeof computeSessionVwap>['state'];
        readonly options: { readonly market: 'EQUITY'; readonly barSeconds: 60 };
      };
      readonly avwap: { readonly closedState: ReturnType<typeof computeAnchoredVwap>['state'] };
    }
  >();
  private readonly subscribedOptionContracts = new Set<string>();
  private readonly liveOptionQuotes = new Map<string, LiveOptionQuoteSnapshot>();
  private readonly wsListeners = new Set<(event: RuntimeWsBroadcast) => void>();
  private readonly wheelHistoryBySymbol = new Map<string, WheelSnapshotInput[]>();
  private readonly usPriorSmileCache = new Map<
    string,
    readonly {
      readonly dateKey: string;
      readonly atmIvPct: number;
      readonly compositeOtmPoints: readonly CompositeOtmSmilePoint[];
    }[]
  >();

  private recordAndResolveUsPriorSmile(
    cacheKey: string,
    dateKey: string,
    atmIvPct: number,
    compositeOtmPoints: readonly CompositeOtmSmilePoint[],
  ): VolAnalyticsPriorSmileSnapshot | null {
    if (!Number.isFinite(atmIvPct) || atmIvPct <= 0 || compositeOtmPoints.length < 2) {
      return null;
    }
    const existing = this.usPriorSmileCache.get(cacheKey) ?? [];
    const filtered = existing.filter((e) => e.dateKey !== dateKey);
    const updated = [...filtered, { dateKey, atmIvPct, compositeOtmPoints }]
      .sort((a, b) => a.dateKey.localeCompare(b.dateKey))
      .slice(-20);
    this.usPriorSmileCache.set(cacheKey, updated);

    const lastIdx = updated.length - 1;
    let best: VolAnalyticsPriorSmileSnapshot | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < lastIdx; i += 1) {
      const ago = lastIdx - i;
      if (ago < 5 || ago > 10) continue;
      const dist = Math.abs(ago - 7);
      const entry = updated[i];
      if (entry !== undefined && dist < bestDist) {
        bestDist = dist;
        best = {
          dateKey: entry.dateKey,
          tradingDaysAgo: ago,
          atmIvPct: entry.atmIvPct,
          compositeOtmPoints: entry.compositeOtmPoints,
        };
      }
    }
    return best;
  }

  private buildUsVolAnalyticsSuite(params: {
    readonly canonicalSymbol: string;
    readonly spot: number;
    readonly spotBid: number;
    readonly spotAsk: number;
    readonly evalRateUs: number;
    readonly evalDivUs: number;
    readonly sofrRate: number;
    readonly r30d: number;
    readonly nowSec: number;
    readonly closedDailyUs: readonly Bar[];
    readonly contracts: readonly OptionSnapshotContract[];
    readonly contractOwnIvMap: ReadonlyMap<string, number>;
    readonly deltaByTicker: ReadonlyMap<string, number | null>;
    readonly validSlices: readonly SlicePackage[];
    readonly expiryParityMap: ReadonlyMap<number, ExpiryParityEvaluation>;
    readonly qDistributionFront: RiskNeutralDistributionResult | null;
    readonly putWallStrike?: number | null;
    readonly netGex?: number | null;
  }): VolAnalyticsSuiteResult | null {
    const {
      canonicalSymbol,
      spot,
      spotBid,
      spotAsk,
      evalRateUs,
      evalDivUs,
      sofrRate,
      r30d,
      nowSec,
      closedDailyUs,
      contracts,
      contractOwnIvMap,
      deltaByTicker,
      validSlices,
      expiryParityMap,
      qDistributionFront,
      putWallStrike = null,
      netGex = null,
    } = params;

    if (!Number.isFinite(spot) || spot <= 0) {
      return null;
    }

    const histInputs: HistoricalDailyBarInput[] = closedDailyUs.map((b) => ({
      time: b.time,
      close: b.close,
      open: b.open,
      high: b.high,
      low: b.low,
    }));

    const frontSlicePkg = validSlices[0];
    const frontIvAtmPct =
      frontSlicePkg !== undefined && Number.isFinite(frontSlicePkg.metrics.ivAtm) && frontSlicePkg.metrics.ivAtm > 0
        ? frontSlicePkg.metrics.ivAtm * 100
        : null;

    const historicalConditional = computeHistoricalVolConditionalTable(
      {
        bars: histInputs,
        currentIvAtmPct: frontIvAtmPct,
      },
      {
        rvWindowDays: 23,
        forwardTradingDays: 21,
        maxHistoryPoints: 750,
        tailSigmaThreshold: 3.0,
      },
    );

    const rvWindows = {
      rv20: computeRollingRvDistributionAtWindow(histInputs, 20, 750),
      rv60: computeRollingRvDistributionAtWindow(histInputs, 60, 750),
      rv120: computeRollingRvDistributionAtWindow(histInputs, 120, 750),
    };

    const histVolSeriesForCost = historicalConditional.historySeries
      .slice(-252)
      .map((p) => p.rvPct);

    const benchmarkRateDec =
      Number.isFinite(sofrRate) && sofrRate > 0
        ? sofrRate
        : Number.isFinite(r30d) && r30d > 0
          ? r30d
          : Number.isFinite(evalRateUs)
            ? evalRateUs
            : Number.NaN;
    const benchmarkTeaPct = Number.isFinite(benchmarkRateDec)
      ? Math.expm1(benchmarkRateDec) * 100
      : Number.NaN;
    const benchmarkLabel =
      Number.isFinite(sofrRate) && sofrRate > 0 ? 'SOFR (USD)' : 'US Treasury 30D';

    // Agrupar contratos por fecha de vencimiento (top 10 futuros)
    const contractsByDate = new Map<string, OptionSnapshotContract[]>();
    for (const c of contracts) {
      if (c.expirationTime <= nowSec + 60) continue;
      const list = contractsByDate.get(c.expirationDate) ?? [];
      list.push(c);
      contractsByDate.set(c.expirationDate, list);
    }

    const validSliceByDate = new Map<string, SlicePackage>();
    for (const sp of validSlices) {
      const dk = new Date(sp.parity.expirySec * 1_000).toISOString().slice(0, 10);
      if (!validSliceByDate.has(dk)) {
        validSliceByDate.set(dk, sp);
      }
    }

    const sortedExpDates = [...contractsByDate.keys()].sort().slice(0, 10);
    const dateKeyUtc = new Date(nowSec * 1_000).toISOString().slice(0, 10);

    const smileOtmMap = new Map<string, SeparatedSmileResult>();
    const smileAllMap = new Map<string, SeparatedSmileResult>();
    const expDaysMap = new Map<string, number>();
    const expFallbackAtmMap = new Map<string, number | null>();
    const expiriesByCode: Record<string, VolAnalyticsExpirySuiteResult> = {};

    for (const expDate of sortedExpDates) {
      const list = contractsByDate.get(expDate) ?? [];
      if (list.length === 0) continue;
      const sampleExpTime = list[0]?.expirationTime ?? nowSec + 86_400;
      const tExp = Math.max(MIN_EXPECTED_MOVE_T_YEARS, timeToExpiryYears(nowSec, sampleExpTime));
      const dteEt = calendarDteEt(expDate, nowSec * 1_000);
      const days = Number.isFinite(dteEt)
        ? dteEt
        : Math.max(0, Math.round((sampleExpTime - nowSec) / 86_400));
      expDaysMap.set(expDate, days);

      const slicePkg = validSliceByDate.get(expDate);
      const parityInfo = slicePkg?.parity ?? expiryParityMap.get(sampleExpTime);
      const rate = parityInfo !== undefined && Number.isFinite(parityInfo.rate) ? parityInfo.rate : evalRateUs;
      const dividendYield =
        parityInfo !== undefined && Number.isFinite(parityInfo.dividendYield)
          ? parityInfo.dividendYield
          : evalDivUs;

      const smileContracts = list.map((c) => {
        const ownIv = contractOwnIvMap.get(c.ticker);
        const rawIv =
          ownIv !== undefined && Number.isFinite(ownIv) && ownIv > 0
            ? ownIv
            : Number.isFinite(c.impliedVolatility) && c.impliedVolatility > 0
              ? c.impliedVolatility
              : null;
        const iv = rawIv !== null && rawIv < IV_CAP_DECIMAL ? rawIv : null;
        const mid = resolveQuoteMid(c);
        return {
          strike: c.strikePrice,
          contractType: c.contractType,
          iv,
          bid: Number.isFinite(c.lastQuote.bid) && c.lastQuote.bid > 0 ? c.lastQuote.bid : null,
          ask: Number.isFinite(c.lastQuote.ask) && c.lastQuote.ask > 0 ? c.lastQuote.ask : null,
          last: Number.isFinite(c.lastTrade.price) && c.lastTrade.price > 0 ? c.lastTrade.price : null,
          mid: Number.isFinite(mid) && mid > 0 ? mid : null,
          volume: Number.isFinite(c.day.volume) ? c.day.volume : null,
          openInterest: Number.isFinite(c.openInterest) ? c.openInterest : null,
          delta: deltaByTicker.get(c.ticker) ?? null,
        };
      });

      const smileOtmOnly = buildSeparatedOtmSmile(
        {
          spot,
          timeToExpiryYears: tExp,
          daysToExpiry: days,
          rate,
          dividendYield,
          contracts: smileContracts,
        },
        { onlyOtm: true },
      );
      const smileAll = buildSeparatedOtmSmile(
        {
          spot,
          timeToExpiryYears: tExp,
          daysToExpiry: days,
          rate,
          dividendYield,
          contracts: smileContracts,
        },
        { onlyOtm: false },
      );

      smileOtmMap.set(expDate, smileOtmOnly);
      smileAllMap.set(expDate, smileAll);
      const fallbackAtm =
        slicePkg !== undefined && Number.isFinite(slicePkg.metrics.ivAtm) && slicePkg.metrics.ivAtm > 0
          ? slicePkg.metrics.ivAtm * 100
          : null;
      expFallbackAtmMap.set(expDate, fallbackAtm);

      const priorSmile = this.recordAndResolveUsPriorSmile(
        `${canonicalSymbol}:${expDate}`,
        dateKeyUtc,
        smileOtmOnly.atmIvPct,
        smileOtmOnly.compositeOtmPoints,
      );

      let qDistForExp: RiskNeutralDistributionResult | null = null;
      if (frontSlicePkg !== undefined && slicePkg === frontSlicePkg) {
        qDistForExp = qDistributionFront;
      } else if (slicePkg !== undefined) {
        const qInputs: RiskNeutralInputNode[] = [];
        for (const c of list) {
          const ivRaw = contractOwnIvMap.get(c.ticker) ?? c.impliedVolatility;
          if (Number.isFinite(ivRaw) && ivRaw > 0 && ivRaw < IV_CAP_DECIMAL) {
            const bid = Number.isFinite(c.lastQuote.bid) && c.lastQuote.bid > 0 ? c.lastQuote.bid : null;
            const ask = Number.isFinite(c.lastQuote.ask) && c.lastQuote.ask > 0 ? c.lastQuote.ask : null;
            qInputs.push({
              strike: c.strikePrice,
              iv: ivRaw,
              bid,
              ...(ask !== null ? { ask } : {}),
            });
          }
        }
        const atmIvForQ =
          Number.isFinite(smileOtmOnly.atmIvPct) && smileOtmOnly.atmIvPct > 0
            ? smileOtmOnly.atmIvPct / 100
            : slicePkg.metrics.ivAtm;
        const em = expectedMoveSigma(spot, atmIvForQ, slicePkg.parity.timeToExpiry);
        if (qInputs.length >= 5) {
          qDistForExp = extractRiskNeutralDistributionQ({
            spot,
            timeToExpiry: slicePkg.parity.timeToExpiry,
            rate: slicePkg.parity.rate,
            dividendYield: slicePkg.parity.dividendYield,
            nodes: qInputs,
            smoothTotalVariancePchip: true,
            dte: days,
            ...(Number.isFinite(em) ? { expectedMove: em } : {}),
            smoothShortDteDensity: true,
          });
        }
      }

      const atmIvForCone =
        Number.isFinite(smileOtmOnly.atmIvPct) && smileOtmOnly.atmIvPct > 0
          ? smileOtmOnly.atmIvPct
          : fallbackAtm ?? Number.NaN;

      const expectedCone = buildExpectedConeAndLognormalSummary({
        spot,
        atmIvPct: atmIvForCone,
        daysToExpiry: days,
        rate,
        dividendYield,
        ...(qDistForExp !== null && qDistForExp.status === 'OK'
          ? {
              qNodes: qDistForExp.nodes.map((n) => ({
                strike: n.strike,
                densityQ: n.densityQ,
                probAboveQ: n.probAboveQ,
              })),
            }
          : {}),
      });

      const callByK = new Map<number, OptionSnapshotContract>();
      const putByK = new Map<number, OptionSnapshotContract>();
      const strikeSet = new Set<number>();
      for (const c of list) {
        strikeSet.add(c.strikePrice);
        if (c.contractType === 'call') {
          callByK.set(c.strikePrice, c);
        } else {
          putByK.set(c.strikePrice, c);
        }
      }
      const sortedK = [...strikeSet].sort((a, b) => a - b);

      const contractIvPct = (c: OptionSnapshotContract | undefined): number | null => {
        if (c === undefined) return null;
        const raw = contractOwnIvMap.get(c.ticker) ?? c.impliedVolatility;
        return Number.isFinite(raw) && raw > 0 && raw < IV_CAP_DECIMAL ? raw * 100 : null;
      };
      const cleanQuote = (x: number): number | null => (Number.isFinite(x) && x > 0 ? x : null);
      const contractMid = (c: OptionSnapshotContract | undefined): number | null => {
        if (c === undefined) return null;
        const m = resolveQuoteMid(c);
        return Number.isFinite(m) && m > 0 ? m : null;
      };

      const parityPairs = sortedK.map((k) => {
        const c = callByK.get(k);
        const p = putByK.get(k);
        return {
          strike: k,
          callBid: c !== undefined ? cleanQuote(c.lastQuote.bid) : null,
          callAsk: c !== undefined ? cleanQuote(c.lastQuote.ask) : null,
          callMid: contractMid(c),
          callIvPct: contractIvPct(c),
          putBid: p !== undefined ? cleanQuote(p.lastQuote.bid) : null,
          putAsk: p !== undefined ? cleanQuote(p.lastQuote.ask) : null,
          putMid: contractMid(p),
          putIvPct: contractIvPct(p),
          callVolume: c !== undefined && Number.isFinite(c.day.volume) ? c.day.volume : null,
          putVolume: p !== undefined && Number.isFinite(p.day.volume) ? p.day.volume : null,
        };
      });

      const parity = computeParityAndSyntheticRatesByStrike({
        spotMid: spot,
        spotBid,
        spotAsk,
        daysToExpiry: days,
        dividendYield,
        benchmarkTeaPct: Number.isFinite(benchmarkTeaPct) ? benchmarkTeaPct : null,
        benchmarkLabel,
        pairs: parityPairs,
      });

      const ratioStrikes = sortedK.map((k) => {
        const c = callByK.get(k);
        const p = putByK.get(k);
        return {
          strike: k,
          callBid: c !== undefined ? cleanQuote(c.lastQuote.bid) : null,
          callAsk: c !== undefined ? cleanQuote(c.lastQuote.ask) : null,
          callMid: contractMid(c),
          putBid: p !== undefined ? cleanQuote(p.lastQuote.bid) : null,
          putAsk: p !== undefined ? cleanQuote(p.lastQuote.ask) : null,
          putMid: contractMid(p),
        };
      });

      const ratioAtmIvPct =
        Number.isFinite(smileOtmOnly.atmIvPct) && smileOtmOnly.atmIvPct > 0
          ? smileOtmOnly.atmIvPct
          : smileAll.atmIvPct;
      const ratiosAndStructures = computeRatiosAndStructureCosts({
        spot,
        daysToExpiry: days,
        rate,
        dividendYield,
        strikes: ratioStrikes,
        historicalVolPctSeries: histVolSeriesForCost,
        ...(Number.isFinite(ratioAtmIvPct) && ratioAtmIvPct > 0
          ? { ivAtmDec: ratioAtmIvPct / 100 }
          : {}),
      });

      const activeExpiryVrp = computeActiveExpiryVrpAndRegime({
        expiryCode: expDate,
        daysToExpiry: days,
        spot,
        putWallStrike,
        netGex,
        ivAtmActiveExpiryPct: Number.isFinite(smileOtmOnly.atmIvPct)
          ? smileOtmOnly.atmIvPct
          : null,
        sameExpiryFallbackIvAtmPct: Number.isFinite(smileAll.atmIvPct)
          ? smileAll.atmIvPct
          : fallbackAtm,
        rvReferencePct: Number.isFinite(historicalConditional.latestRv23Pct)
          ? historicalConditional.latestRv23Pct
          : Number.isFinite(historicalConditional.latestRv20Pct)
            ? historicalConditional.latestRv20Pct
            : null,
        rvReferenceLabel: Number.isFinite(historicalConditional.latestRv23Pct) ? 'RV23d' : 'RV20d',
        historicalRvSeriesPct: histVolSeriesForCost,
        historicalRvMinPct: Number.isFinite(historicalConditional.quantiles.minPct)
          ? historicalConditional.quantiles.minPct
          : null,
        historicalRvMaxPct: Number.isFinite(historicalConditional.quantiles.maxPct)
          ? historicalConditional.quantiles.maxPct
          : null,
        fallbackIvRank: Number.isFinite(historicalConditional.ivRank)
          ? historicalConditional.ivRank
          : null,
        fallbackIvPercentile: Number.isFinite(historicalConditional.ivPercentile)
          ? historicalConditional.ivPercentile
          : null,
      });

      expiriesByCode[expDate] = {
        expiryCode: expDate,
        expirationDate: expDate,
        daysToExpiry: days,
        smileOtmOnly,
        smileAll,
        priorSmile,
        expectedCone,
        parity,
        ratiosAndStructures,
        activeExpiryVrp,
      };
    }

    const matrixExps = sortedExpDates.filter((d) => expDaysMap.has(d));
    const moneynessMatrixOtm = buildNormalizedMoneynessMatrix(
      matrixExps.map((d) => ({
        expiryCode: d,
        expiryLabel: `${d} (${formatDteLabel(expDaysMap.get(d) ?? 0)})`,
        daysToExpiry: expDaysMap.get(d) ?? 0,
        compositeOtmPoints: smileOtmMap.get(d)?.compositeOtmPoints ?? [],
        fallbackAtmIvPct: expFallbackAtmMap.get(d) ?? null,
      })),
    );
    const moneynessMatrixAll = buildNormalizedMoneynessMatrix(
      matrixExps.map((d) => ({
        expiryCode: d,
        expiryLabel: `${d} (${formatDteLabel(expDaysMap.get(d) ?? 0)})`,
        daysToExpiry: expDaysMap.get(d) ?? 0,
        compositeOtmPoints: smileAllMap.get(d)?.compositeOtmPoints ?? [],
        fallbackAtmIvPct: expFallbackAtmMap.get(d) ?? null,
      })),
    );

    const frontDate =
      frontSlicePkg !== undefined
        ? new Date(frontSlicePkg.parity.expirySec * 1_000).toISOString().slice(0, 10)
        : sortedExpDates[0] ?? null;

    return {
      status:
        historicalConditional.status === 'OK' || sortedExpDates.length > 0 ? 'OK' : 'NO_DATA',
      market: 'US',
      underlying: canonicalSymbol,
      spot,
      rateContinuous: evalRateUs,
      rateTeaPct: benchmarkTeaPct,
      benchmarkLabel,
      dividendYield: evalDivUs,
      activeExpiryCode: frontDate,
      hasDualAdr: false,
      nonDualMessage: 'Activo sin ADR dual — Ver estructura completa en Tab 2',
      moneynessMatrixOtm,
      moneynessMatrixAll,
      historicalConditional,
      rvWindows,
      dualSurface: null,
      expiriesByCode,
    };
  }

  public constructor(deps: MarketRuntimeDeps = {}) {
    const auth = loadRuntimeAuth();
    // Pieza 32: `deps.apiKey` es una inyección explícita (tests/harness) SOLO cuando
    // difiere de la clave resuelta por la cadena de entorno. Cuando el entrypoint
    // re-pasa `loadRuntimeAuth().apiKey` (mismo valor), se delega al pool multi-key
    // (`MASSIVE_WS_STOCKS_KEY` / `MASSIVE_REST_KEY` / `MASSIVE_REST_KEYS`) para que
    // la separación WS/REST y el round-robin operen en producción.
    this.depsApiKey =
      deps.apiKey !== undefined && deps.apiKey.trim() !== '' && deps.apiKey !== auth.apiKey
        ? deps.apiKey
        : null;
    this.apiKey = deps.apiKey ?? auth.apiKey;
    const secretSet = new Set<string>(auth.secrets);
    if (deps.secrets !== undefined) {
      for (const s of deps.secrets) {
        secretSet.add(s);
      }
    }
    if (this.apiKey !== '') {
      secretSet.add(this.apiKey);
    }
    // Pieza 32/41.1: en harness Tradier/FMP quedan explícitamente vacíos salvo
    // inyección directa, para no golpear la red real ni depender del orden dotenv.
    const isMockFetch = deps.fetchFn !== undefined;
    this.injectedMarketHarness =
      isMockFetch ||
      deps.loadBarsFn !== undefined ||
      deps.createWsClientFn !== undefined ||
      deps.apiKey !== undefined;
    this.tradierConfigOverride = deps.tradierConfig ?? null;
    if (this.tradierConfig.accessToken !== null) {
      secretSet.add(this.tradierConfig.accessToken);
    }
    this.fmpConfigOverride = deps.fmpConfig ?? null;
    for (const fmpKey of [
      this.fmpConfig.apiKey,
      this.fmpConfig.quotesApiKey,
      this.fmpConfig.marketApiKey,
      this.fmpConfig.etfApiKey,
      this.fmpConfig.macroApiKey,
      this.fmpConfig.calendarsApiKey ?? null,
    ]) {
      if (fmpKey !== null) secretSet.add(fmpKey);
    }
    this.massiveStocksModeOverride = deps.massiveStocksMode ?? null;
    this.tradierHistoricalBarsRequested = deps.tradierHistoricalBars === true;
    this.tradierManager = deps.tradierManager ?? null;
    this.tradierChainFetchFn = deps.tradierChainFetchFn ?? fetchTradierOptionChain;
    this.tradierQuotesFetchFn = deps.tradierQuotesFetchFn ?? fetchTradierQuotes;
    this.tradierCreateSocketFn = deps.tradierCreateSocketFn;
    this.tradierHttpFn = deps.tradierHttpFn;
    this.secrets = [...secretSet];
    const harnessFmpConfig = loadFmpConfigFromEnv({});
    this.fmpClient = new FmpEnterpriseClient({
      config: this.fmpConfigOverride ?? harnessFmpConfig,
      ...(this.fmpConfigOverride === null
        ? {
            resolveConfigFn: this.injectedMarketHarness
              ? (): FmpConfig => harnessFmpConfig
              : (): FmpConfig => resolveFmpConfig(),
          }
        : {}),
      ...(deps.fetchFn === undefined ? {} : { fetchFn: fetchAsFmpHttpFn(deps.fetchFn) }),
      ...(deps.nowMsFn === undefined ? {} : { nowMsFn: deps.nowMsFn }),
      secrets: this.secrets,
      onResponse: ({ httpStatus, latencyMs }) => {
        this.fmpTelemetry.record({
          atMs: this.nowMsFn(),
          latencyMs,
          ...(httpStatus !== null && httpStatus >= 200 && httpStatus < 300 ? { isValidTick: true } : {}),
          ...(httpStatus === null ? {} : { httpStatus }),
        });
      },
    });
    this.tradierHistoricalClient = new TradierHistoricalClient({
      resolveConfigFn: (): TradierConfig => this.getEffectiveTradierConfig(),
      ...(deps.nowMsFn === undefined ? {} : { nowMsFn: deps.nowMsFn }),
      secrets: this.secrets,
      authBreaker: this.tradierAuthBreaker,
      onEnvironmentNegotiated: (nextConfig) => {
        this.negotiatedTradierConfig = nextConfig;
      },
    });
    this.oratsClient =
      deps.oratsClient !== undefined
        ? deps.oratsClient
        : isMockFetch
          ? null
          : new OratsHybridClient({
              env: process.env,
              nowMsFn: deps.nowMsFn ?? (() => Date.now()),
              cacheTtlMs: US_VOL_SURFACE_TTL_MS,
              secrets: this.secrets,
            });
    this.baseUrl = deps.baseUrl;
    const baseFetch = deps.fetchFn ?? createRedactingFetch(this.secrets);
    const massiveRestBase = (this.baseUrl ?? 'https://api.massive.com').replace(/\/+$/, '');
    const isMassiveRestUrl = (url: string): boolean => {
      if (url.startsWith(massiveRestBase)) return true;
      try {
        const parsed = new URL(url);
        return (
          (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
          (parsed.hostname === 'api.massive.com' || parsed.hostname.endsWith('.massive.com'))
        );
      } catch {
        return false;
      }
    };
    this.fetchFn = async (url: string): Promise<FetchResponse> => {
      const startedAtMs = this.nowMsFn();
      try {
        const response = await baseFetch(url);
        if (isMassiveRestUrl(url)) {
          this.restTelemetry.record({
            atMs: this.nowMsFn(),
            latencyMs: this.nowMsFn() - startedAtMs,
            httpStatus: response.status,
          });
        }
        return response;
      } catch (err: unknown) {
        if (isMassiveRestUrl(url)) {
          this.restTelemetry.record({
            atMs: this.nowMsFn(),
            latencyMs: this.nowMsFn() - startedAtMs,
          });
        }
        throw err;
      }
    };
    this.loadBarsFn = deps.loadBarsFn ?? loadBars;
    this.loadOptionChainFn = deps.loadOptionChainFn ?? loadOptionChain;
    this.loadOptionContractsFn = deps.loadOptionContractsFn ?? loadOptionContracts;
    this.loadTreasuryYieldsFn = deps.loadTreasuryYieldsFn ?? loadTreasuryYields;
    this.loadFundingConditionsFn = deps.loadFundingConditionsFn ?? loadFundingConditions;
    this.loadUnifiedSnapshotFn = deps.loadUnifiedSnapshotFn ?? loadUnifiedSnapshot;
    this.loadDividendsFn = deps.loadDividendsFn ?? loadDividends;
    this.loadUnusualTradesFn = deps.loadUnusualTradesFn ?? loadUnusualTrades;
    this.createWsClientFn =
      deps.createWsClientFn ??
      ((options: MassiveWsClientOptions): MassiveWsClientLike => new MassiveWsClient(options));
    this.nowMsFn = deps.nowMsFn ?? ((): number => Date.now());
    this.enableWs = deps.enableWs ?? true;
    this.watchedSymbols = deps.watchedSymbols ?? [...DEFAULT_TERMINAL_SYMBOLS];

    const ttlResolver = deps.ttlResolver ?? computeDynamicTtlMs;
    const quoteTtlResolver =
      deps.ttlResolver ??
      ((nowMs: number): number => {
        const baseline = computeDynamicTtlMs(nowMs);
        return getUsLiveSession(nowMs) === 'CLOSED' ? baseline : Math.min(baseline, 1_500);
      });
    this.snapshotCache = new SingleFlightRuntimeCache({
      nowFn: this.nowMsFn,
      ttlResolver: quoteTtlResolver,
    });
    this.barsCache = new SingleFlightRuntimeCache({
      nowFn: this.nowMsFn,
      ttlResolver,
    });
    this.unusualCache = new SingleFlightRuntimeCache({
      nowFn: this.nowMsFn,
      ttlResolver,
    });
    this.treasuryCache = new SingleFlightRuntimeCache({
      nowFn: this.nowMsFn,
      ttlResolver,
    });
    this.fundingCache = new SingleFlightRuntimeCache({
      nowFn: this.nowMsFn,
      ttlResolver,
    });
    this.unifiedCache = new SingleFlightRuntimeCache({
      nowFn: this.nowMsFn,
      ttlResolver: quoteTtlResolver,
    });
    this.stocksV2Cache = new SingleFlightRuntimeCache({
      nowFn: this.nowMsFn,
      ttlResolver: quoteTtlResolver,
    });
    this.nyfedSofrCache = new SingleFlightRuntimeCache({
      nowFn: this.nowMsFn,
      ttlResolver: deps.ttlResolver ?? (() => 60 * 60 * 1_000),
    });
    this.fallbackTreasuryCache = new SingleFlightRuntimeCache({
      nowFn: this.nowMsFn,
      ttlResolver: deps.ttlResolver ?? (() => 2 * 60 * 60 * 1_000),
    });
    this.daily1dCache = new SingleFlightRuntimeCache({
      nowFn: this.nowMsFn,
      ttlResolver: deps.ttlResolver ?? ((nowMs) => computeUsHistoricalPanelTtlMs(nowMs)),
    });
    this.usPanelCache = new SingleFlightRuntimeCache({
      nowFn: this.nowMsFn,
      ttlResolver: deps.ttlResolver ?? ((nowMs) => computeUsHistoricalPanelTtlMs(nowMs)),
    });
    const DAILY_CATALYST_TTL_MS = 24 * 60 * 60 * 1_000;
    this.earningsCatalystCache = new SingleFlightRuntimeCache({
      nowFn: this.nowMsFn,
      ttlResolver: () => DAILY_CATALYST_TTL_MS,
    });
    this.macroCalendarCache = new SingleFlightRuntimeCache({
      nowFn: this.nowMsFn,
      ttlResolver: () => DAILY_CATALYST_TTL_MS,
    });
    // Pieza 50.5: anclas Auto-AVWAP y calendario macro plurianual cacheados por día.
    this.autoAvwapCache = new SingleFlightRuntimeCache({
      nowFn: this.nowMsFn,
      ttlResolver: () => DAILY_CATALYST_TTL_MS,
      maxEntries: 500,
    });
    this.macroCalendarHistoryCache = new SingleFlightRuntimeCache({
      nowFn: this.nowMsFn,
      ttlResolver: () => DAILY_CATALYST_TTL_MS,
      maxEntries: 4,
    });
    this.usExpiryCatalogCache = new SingleFlightRuntimeCache({
      nowFn: this.nowMsFn,
      ttlResolver: () => US_EXPIRY_CATALOG_TTL_MS,
    });
    this.usExpiryChainCache = new SingleFlightRuntimeCache({
      nowFn: this.nowMsFn,
      // Pieza 50.2: TTL dinámico ET — 15 s en RTH, 60 s fuera de RTH / fin de semana.
      ttlResolver: (nowMs) => (getUsLiveSession(nowMs) === 'RTH' ? 15_000 : 60_000),
    });

    if (
      deps.fetchFn === undefined &&
      deps.loadBarsFn === undefined &&
      deps.nowMsFn === undefined
    ) {
      registerSharedMarketRuntime(this);
    }
    this.ggalTickEngine = new GgalTickStreamEngine({
      nowMsFn: this.nowMsFn,
      emit: (event) => {
        this.emitBroadcast(event);
      },
    });
  }

  /** Pieza 39: acceso de solo-lectura del motor tick para anclas AVWAP. */
  public getGgalTickEngine(): GgalTickStreamEngine {
    return this.ggalTickEngine;
  }

  /** Pieza 39: fuente de ticks ARS (BMB SignalR SendPrices / IOL REST). */
  public attachGgalArsTickSource(
    source: { readonly setGgalArsTickListener: (listener: ((tick: { readonly price: number; readonly size: number; readonly timeSec: number }) => void) | null) => void } | null,
  ): void {
    if (source === null) {
      return;
    }
    source.setGgalArsTickListener((tick) => {
      this.ggalTickEngine.applyArsTick(tick);
    });
  }

  public addWsListener(listener: (event: RuntimeWsBroadcast) => void): () => void {
    this.wsListeners.add(listener);
    return () => {
      this.wsListeners.delete(listener);
    };
  }

  private emitBroadcast(event: RuntimeWsBroadcast): void {
    assertJsonSafeSerialized(event);
    for (const listener of this.wsListeners) {
      try {
        listener(event);
      } catch {
        // Ignoramos errores de consumidores individuales para no interrumpir el broadcast.
      }
    }
  }

  private assertApiKey(): string {
    if (this.apiKey.trim() === '') {
      throw new RuntimeNoDataError(
        'MISSING_API_KEY',
        'MASSIVE_API_KEY is not configured in server environment or .env',
        this.secrets,
        503,
      );
    }
    return this.apiKey;
  }

  /**
   * Pieza 32: slot REST del pool round-robin (`MASSIVE_REST_KEY` ->
   * `MASSIVE_REST_KEYS` -> `MASSIVE_API_KEY`). Con una inyección explícita de
   * `deps.apiKey` distinta de la cadena de entorno (tests/harness) se usa esa
   * clave directamente sin rotación.
   */
  private restKeySlot(): MassiveKeySlot {
    if (this.depsApiKey !== null) {
      return {
        key: this.depsApiKey,
        envName: 'deps.apiKey',
        slotIndex: 0,
        poolSize: 1,
        role: 'REST',
      };
    }
    return getMassiveRestKey();
  }

  /** Pieza 32: clave del socket de stocks (`MASSIVE_WS_STOCKS_KEY` -> `MASSIVE_API_KEY`). */
  private wsStocksKeySlot(): MassiveKeySlot {
    if (this.depsApiKey !== null) {
      return {
        key: this.depsApiKey,
        envName: 'deps.apiKey',
        slotIndex: 0,
        poolSize: 1,
        role: 'WS_STOCKS',
      };
    }
    return getMassiveStocksWsKey();
  }

  private restBatchApiKey(): string {
    return this.restKeySlot().key;
  }

  /** Clave REST obligatoria para loaders Massive (lanza 503 si el pool está vacío). */
  private assertRestApiKey(): string {
    const key = this.restKeySlot().key;
    if (key.trim() === '') {
      throw new RuntimeNoDataError(
        'MISSING_API_KEY',
        'Massive REST key pool is empty: MASSIVE_REST_KEY / MASSIVE_REST_KEYS / MASSIVE_API_KEY missing',
        this.secrets,
        503,
      );
    }
    return key;
  }

  public getHealth(): {
    readonly ok: boolean;
    readonly nowUtcSec: number;
    readonly hasApiKey: boolean;
    readonly watchedSymbols: readonly string[];
    readonly ws: {
      readonly stocks: WsClientSnapshot | null;
      readonly options: WsClientSnapshot | null;
      readonly subscribedOptionQuotes: number;
    };
    readonly cache: {
      readonly snapshot: ReturnType<SingleFlightRuntimeCache<TerminalSnapshotResponse>['stats']>;
      readonly bars: ReturnType<SingleFlightRuntimeCache<TerminalBarsResponse>['stats']>;
      readonly unusual: ReturnType<SingleFlightRuntimeCache<TerminalUnusualResponse>['stats']>;
    };
  } {
    return {
      ok: true,
      nowUtcSec: Math.floor(this.nowMsFn() / 1_000),
      hasApiKey: this.apiKey.trim() !== '',
      watchedSymbols: this.watchedSymbols,
      ws: {
        stocks: this.stockWsClient?.getSnapshot() ?? this.massiveStocksStream?.getWsSnapshot() ?? null,
        options: this.optionsWsClient?.getSnapshot() ?? null,
        subscribedOptionQuotes: this.subscribedOptionContracts.size,
      },
      cache: {
        snapshot: this.snapshotCache.stats(),
        bars: this.barsCache.stats(),
        unusual: this.unusualCache.stats(),
      },
    };
  }

  public async warmup(
    symbols: readonly string[] = ['SPY', 'QQQ', 'I:SPX', 'NVDA', 'AAPL', 'MSFT', 'GGAL'],
  ): Promise<void> {
    if (this.apiKey.trim() === '') {
      return;
    }
    const [firstSym, ...restSyms] = symbols;
    if (firstSym !== undefined) {
      // Calentamos primero el símbolo líder (y caches compartidas macro/unified) junto con unusual SPY.
      await Promise.allSettled([
        this.getSnapshot(firstSym),
        this.getUnusualTrades({ symbol: 'SPY', limit: 60 }),
      ]);
    } else {
      await Promise.allSettled([this.getUnusualTrades({ symbol: 'SPY', limit: 60 })]);
    }
    for (const sym of restSyms) {
      await new Promise<void>((r) => setTimeout(r, 15));
      await Promise.allSettled([this.getSnapshot(sym)]);
    }
  }

  public async startWs(): Promise<void> {
    if (!this.enableWs) {
      return;
    }
    const symbols = [
      ...new Set([
        ...US_STREAM_SYMBOLS,
        ...MASSIVE_WS_CORE_SYMBOLS,
        ...this.watchedSymbols.map((symbol) => symbol.trim().toUpperCase()),
      ]),
    ].filter((symbol) => symbol !== '');
    // Pieza 41: FMP batch y Tradier WS arrancan sin depender de una clave
    // Massive. El socket Massive solo se abre cuando no está en standby.
    if (this.fmpConfig.configured) {
      this.startFmpBatchQuoteLoop();
      this.startFmpExtendedQuoteLoop();
    }
    this.ensureTradierLiveStream(symbols);
    const wsStocksKey = this.wsStocksKeySlot();
    if (this.massiveStocksMode === 'STANDBY_TRADIER_FMP_PRIMARY') {
      if (this.massiveStocksStream !== null) {
        await this.massiveStocksStream.stopAndWait(4_000).catch(() => undefined);
        this.massiveStocksStream = null;
      }
      return;
    }
    if (wsStocksKey.key.trim() === '') {
      return;
    }
    if (this.massiveStocksStream !== null) {
      await this.massiveStocksStream.start();
      return;
    }

    const stream = new MassiveStocksStream({
      apiKey: wsStocksKey.key,
      restApiKeyFn: () => this.restBatchApiKey(),
      symbols,
      coreSymbols: MASSIVE_WS_CORE_SYMBOLS,
      fetchFn: this.fetchFn,
      createWsClientFn: this.createWsClientFn,
      nowMsFn: this.nowMsFn,
      ...(this.baseUrl === undefined ? {} : { baseUrl: this.baseUrl }),
      onEvents: (events) => {
        this.handleStockWsEvents(events);
      },
      onStateChange: (state) => {
        this.emitBroadcast({
          type: 'status',
          cluster: 'stocks',
          state,
          message: `stocks ws state: ${state}`,
          time: Math.floor(this.nowMsFn() / 1_000),
        });
      },
      onError: (message) => {
        this.emitBroadcast({
          type: 'status',
          cluster: 'stocks',
          state: 'error',
          message: redactSecrets(message, this.secrets),
          time: Math.floor(this.nowMsFn() / 1_000),
        });
      },
    });
    this.massiveStocksStream = stream;
    await stream.start();
    this.applyMassiveSymbolLeases();
  }

  /** Pieza 41: universo real de batch-quote (acciones/ETFs, sin índices). */
  public getFmpBatchSymbols(): readonly string[] {
    return [...new Set([
      ...US_PANEL_TICKERS,
      ...US_STREAM_SYMBOLS.filter((symbol) => !symbol.startsWith('I:')),
      ...TRADIER_CORE_US_SYMBOLS,
      ...this.watchedSymbols.filter((symbol) => !symbol.startsWith('I:')),
      ...this.massiveSymbolLeases.keys(),
    ])].map((symbol) => symbol.trim().toUpperCase()).filter((symbol) => symbol !== '').sort();
  }

  private ingestFmpBatchQuotes(quotes: readonly FmpBatchQuote[]): void {
    for (const quote of quotes) {
      const stored = this.fmpQuoteTicks.get(quote.symbol);
      const previousLow = stored?.dayLow ?? null;
      const previousHigh = stored?.dayHigh ?? null;
      const preserveLow =
        previousLow !== null && (quote.dayLow === null || previousLow < quote.dayLow);
      const preserveHigh =
        previousHigh !== null && (quote.dayHigh === null || previousHigh > quote.dayHigh);
      const nextQuote: MarketTickQuote = {
        market: 'US',
        symbol: quote.symbol,
        kind: 'stock',
        currency: 'USD',
        price: quote.price,
        previousClose: quote.previousClose,
        changePct: quote.changePct,
        dayLow: preserveLow ? previousLow : quote.dayLow,
        dayHigh: preserveHigh ? previousHigh : quote.dayHigh,
        volume: quote.volume,
        turnover: quote.turnover,
        asOfUtcSec: quote.asOfUtcSec,
        source: 'FMP_ENTERPRISE_REST',
        exchange: quote.exchange,
      };
      this.fmpQuoteTicks.set(quote.symbol, nextQuote);
    }
  }

  private shouldContinueFmpBatch(): boolean {
    return this.fmpBatchRunning && this.enableWs && this.fmpConfig.configured;
  }

  private startFmpBatchQuoteLoop(): void {
    if (!this.fmpConfig.configured || this.fmpBatchTimer !== null || this.fmpBatchRunning) {
      return;
    }
    const run = async (): Promise<void> => {
      if (!this.shouldContinueFmpBatch()) return;
      try {
        await this.fmpClient.fetchBatchQuotes(this.getFmpBatchSymbols(), {
          onChunk: ({ quotes }) => {
            this.ingestFmpBatchQuotes(quotes);
          },
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.emitBroadcast({
          type: 'status',
          cluster: 'stocks',
          state: 'error',
          message: redactSecrets(`FMP batch quote failed: ${message}`, this.secrets),
          time: Math.floor(this.nowMsFn() / 1_000),
        });
      }
      if (!this.shouldContinueFmpBatch()) return;
      this.fmpBatchTimer = setTimeout(() => {
        this.fmpBatchTimer = null;
        if (!this.shouldContinueFmpBatch()) return;
        void run();
      }, FMP_BATCH_QUOTE_INTERVAL_MS);
      this.fmpBatchTimer.unref();
    };
    this.fmpBatchRunning = true;
    void run();
  }

  private stopFmpBatchQuoteLoop(): void {
    if (this.fmpBatchTimer !== null) {
      clearTimeout(this.fmpBatchTimer);
      this.fmpBatchTimer = null;
    }
    this.fmpBatchRunning = false;
  }

  /** Pieza 42: prioriza símbolos enfocados (leases) y núcleo US/ADR antes del resto. */
  public getFmpExtendedBatchSymbols(): readonly string[] {
    return [...new Set([
      ...[...this.massiveSymbolLeases.keys()].map((s) => s.trim().toUpperCase()),
      ...TRADIER_CORE_US_SYMBOLS,
      ...this.watchedSymbols.map((s) => s.trim().toUpperCase()),
      ...this.getFmpBatchSymbols(),
    ])].filter((s) => s !== '' && !s.startsWith('I:'));
  }

  private ingestFmpExtendedQuotes(quotes: readonly FmpExtendedQuote[]): void {
    const tradierLiveConnected =
      (this.tradierStocksStream?.getStatus() ?? this.tradierManager?.getStatus())?.connected === true;
    const nowSec = Math.floor(this.nowMsFn() / 1_000);
    const phase = getUsEquitySessionPhase(nowSec);
    for (const quote of quotes) {
      const prevExt = this.fmpExtendedQuoteTicks.get(quote.symbol);
      const reg = this.fmpQuoteTicks.get(quote.symbol);
      const extTimeSec = quote.asOfUtcSec ?? nowSec;
      if (
        prevExt !== undefined &&
        prevExt.asOfUtcSec !== null &&
        quote.asOfUtcSec !== null &&
        quote.asOfUtcSec < prevExt.asOfUtcSec
      ) {
        continue;
      }
      const prevClose = reg?.previousClose ?? prevExt?.previousClose ?? null;
      const regularClose =
        phase === 'AFTER_HOURS'
          ? (reg?.price ?? prevExt?.regularClose ?? prevClose)
          : (prevClose ?? reg?.price ?? prevExt?.regularClose ?? null);
      const extRef = phase === 'AFTER_HOURS' ? (regularClose ?? prevClose) : (prevClose ?? regularClose);
      const extendedChangePct =
        extRef !== null && extRef > 0 ? ((quote.price - extRef) / extRef) * 100 : null;
      const nextExt: MarketTickQuote = {
        market: 'US',
        symbol: quote.symbol,
        kind: reg?.kind ?? 'stock',
        currency: 'USD',
        price: quote.price,
        previousClose: prevClose,
        changePct: phase === 'PRE_MARKET' ? extendedChangePct : (reg?.changePct ?? extendedChangePct),
        dayLow: reg?.dayLow ?? prevExt?.dayLow ?? null,
        dayHigh: reg?.dayHigh ?? prevExt?.dayHigh ?? null,
        volume: reg?.volume ?? prevExt?.volume ?? null,
        turnover: reg?.turnover ?? prevExt?.turnover ?? null,
        asOfUtcSec: extTimeSec,
        source: 'FMP_ENTERPRISE_REST',
        exchange: reg?.exchange ?? null,
        regularClose,
        extendedPrice: quote.price,
        extendedChangePct,
        sessionPhase: phase,
      };
      this.fmpExtendedQuoteTicks.set(quote.symbol, nextExt);

      const priceChanged = prevExt === undefined || Math.abs(prevExt.price - quote.price) > 1e-6;
      if (isExtendedHoursPhase(phase) && !tradierLiveConnected && priceChanged) {
        const size = quote.tradeSize ?? 0;
        this.ingestLiveTradeInto1m(quote.symbol, quote.price, size, extTimeSec);
        if (quote.symbol === 'GGAL' && this.massiveStocksStream === null) {
          this.ggalTickEngine.applyAdrTick({
            price: quote.price,
            size,
            timeSec: extTimeSec,
          });
        }
      }
    }
  }

  public async pollFmpExtendedBatchOnce(): Promise<number> {
    if (!this.fmpConfig.configured) return 0;
    const symbols = this.getFmpExtendedBatchSymbols();
    if (symbols.length === 0) return 0;
    const result = await this.fmpClient.fetchExtendedBatchQuotes(symbols, {
      onChunk: ({ quotes }) => {
        this.ingestFmpExtendedQuotes(quotes);
      },
    });
    return result.rows;
  }

  private shouldContinueFmpExtendedBatch(): boolean {
    return this.fmpExtendedRunning && this.enableWs && this.fmpConfig.configured;
  }

  private startFmpExtendedQuoteLoop(): void {
    if (!this.fmpConfig.configured || this.fmpExtendedTimer !== null || this.fmpExtendedRunning) {
      return;
    }
    const run = async (): Promise<void> => {
      if (!this.shouldContinueFmpExtendedBatch()) return;
      const nowSec = Math.floor(this.nowMsFn() / 1_000);
      const phase = getUsEquitySessionPhase(nowSec);
      const inExtended = isExtendedHoursPhase(phase);
      if (inExtended) {
        try {
          await this.pollFmpExtendedBatchOnce();
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this.emitBroadcast({
            type: 'status',
            cluster: 'stocks',
            state: 'error',
            message: redactSecrets(`FMP extended batch quote failed: ${message}`, this.secrets),
            time: nowSec,
          });
        }
      }
      if (!this.shouldContinueFmpExtendedBatch()) return;
      const delayMs = inExtended ? FMP_EXTENDED_QUOTE_INTERVAL_MS : 15_000;
      this.fmpExtendedTimer = setTimeout(() => {
        this.fmpExtendedTimer = null;
        if (!this.shouldContinueFmpExtendedBatch()) return;
        void run();
      }, delayMs);
      this.fmpExtendedTimer.unref();
    };
    this.fmpExtendedRunning = true;
    void run();
  }

  private stopFmpExtendedQuoteLoop(): void {
    if (this.fmpExtendedTimer !== null) {
      clearTimeout(this.fmpExtendedTimer);
      this.fmpExtendedTimer = null;
    }
    this.fmpExtendedRunning = false;
  }

  public getFmpEnterpriseFeedHealth(): {
    readonly configured: boolean;
    readonly lastSuccessAtMs: number | null;
    readonly requestCount: number;
    readonly quoteCount: number;
    readonly subscribedSymbols: readonly string[];
    readonly telemetry: ReturnType<RollingFeedTelemetry['snapshot']>;
    readonly lastError: string | null;
    readonly batchMode: FmpBatchMode;
  } {
    const diagnostics = this.fmpClient.getDiagnostics();
    return {
      configured: this.fmpConfig.configured,
      lastSuccessAtMs: diagnostics.lastSuccessAtMs,
      requestCount: diagnostics.requests,
      quoteCount: this.fmpQuoteTicks.size,
      subscribedSymbols: this.getFmpBatchSymbols(),
      telemetry: this.fmpTelemetry.snapshot(this.nowMsFn()),
      lastError: diagnostics.lastError,
      batchMode: diagnostics.batchMode,
    };
  }

  public async resyncFmpEnterpriseBatch(): Promise<string> {
    if (!this.fmpConfig.configured) {
      throw new Error('FMP_API_KEY is not configured');
    }
    this.startFmpBatchQuoteLoop();
    const result = await this.fmpClient.fetchBatchQuotes(this.getFmpBatchSymbols(), {
      onChunk: ({ quotes }) => {
        this.ingestFmpBatchQuotes(quotes);
      },
    });
    if (result.rows === 0) throw new Error('FMP batch quote returned no rows');
    return 'FMP_ENTERPRISE_REST_RESYNC_COMPLETED';
  }

  /** Pieza 40: valida y toma un lease dinámico para un cliente enfocado. */
  public acquireMassiveStockSymbol(rawSymbol: string, ownerId: string): boolean {
    const symbol = rawSymbol.trim().toUpperCase();
    const owner = ownerId.trim();
    if (symbol === '' || owner === '' || symbol.startsWith('I:') || !/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol)) {
      return false;
    }
    if (MASSIVE_WS_CORE_SYMBOLS.includes(symbol)) return true;
    const owners = this.massiveSymbolLeases.get(symbol) ?? new Set<string>();
    owners.add(owner);
    this.massiveSymbolLeases.set(symbol, owners);
    this.applyMassiveSymbolLeases();
    return true;
  }

  /** Pieza 40: libera un lease; solo desuscribe al perder el último dueño. */
  public releaseMassiveStockSymbol(rawSymbol: string, ownerId: string): void {
    const symbol = rawSymbol.trim().toUpperCase();
    const owner = ownerId.trim();
    const owners = this.massiveSymbolLeases.get(symbol);
    if (owners === undefined || owner === '') return;
    owners.delete(owner);
    if (owners.size === 0) this.massiveSymbolLeases.delete(symbol);
    this.applyMassiveSymbolLeases();
  }

  public releaseMassiveStockOwner(ownerId: string): void {
    const owner = ownerId.trim();
    if (owner === '') return;
    for (const [symbol, owners] of [...this.massiveSymbolLeases.entries()]) {
      owners.delete(owner);
      if (owners.size === 0) this.massiveSymbolLeases.delete(symbol);
    }
    this.applyMassiveSymbolLeases();
  }

  private applyMassiveSymbolLeases(): void {
    if (this.massiveStocksStream !== null) {
      const dynamic = [...this.massiveSymbolLeases.keys()];
      const subscribed = new Set(this.massiveStocksStream.getDynamicSubscribedSymbols());
      const toSubscribe = dynamic.filter((symbol) => !subscribed.has(symbol));
      const toUnsubscribe = [...subscribed].filter((symbol) => !this.massiveSymbolLeases.has(symbol));
      if (toSubscribe.length > 0) this.massiveStocksStream.subscribeSymbols(toSubscribe);
      if (toUnsubscribe.length > 0) this.massiveStocksStream.unsubscribeSymbols(toUnsubscribe);
    }
    if (this.tradierStocksStream !== null && this.tradierManager === null) {
      void this.tradierStocksStream
        .setDynamicSymbols([...this.massiveSymbolLeases.keys()])
        .catch(() => undefined);
    }
  }

  /** Pieza 40: visibilidad para tests del ciclo de reconexión en background. */
  public getMassiveWsReconnectPromise(): Promise<void> | null {
    return this.massiveReconnectInFlight;
  }

  /**
   * Pieza 41: stream Tradier US/ADR principal. `tradierStream.ts` maneja el
   * núcleo líquido + leases; el manager inyectado por tests sigue soportado.
   */
  private ensureTradierLiveStream(symbols: readonly string[]): void {
    if (!this.tradierConfig.configured || this.tradierManager !== null || this.isTradierAuthInvalid()) {
      return;
    }
    const equities = symbols
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s !== '' && !s.startsWith('I:'));
    if (equities.length === 0) {
      return;
    }
    if (this.tradierStocksStream !== null) {
      void this.tradierStocksStream.setDynamicSymbols(equities).catch(() => undefined);
      return;
    }
    const stream = new TradierStocksStream({
      config: this.getEffectiveTradierConfig(),
      ...(this.tradierCreateSocketFn === undefined ? {} : { createSocketFn: this.tradierCreateSocketFn }),
      ...(this.tradierHttpFn === undefined ? {} : { httpFn: this.tradierHttpFn }),
      nowMsFn: this.nowMsFn,
      secrets: this.secrets,
      authBreaker: this.tradierAuthBreaker,
      onEnvironmentNegotiated: (nextConfig) => {
        this.negotiatedTradierConfig = nextConfig;
      },
      onTick: (tick) => {
        this.ingestTradierTick(tick);
      },
      onStateChange: (state) => {
        this.emitBroadcast({
          type: 'status',
          cluster: 'stocks',
          state: state === 'CONNECTED' ? 'ready' : state === 'ERROR' || state === 'AUTH_INVALID' ? 'error' : 'connecting',
          message: `tradier stream state: ${state}`,
          time: Math.floor(this.nowMsFn() / 1_000),
        });
      },
      onError: (message) => {
        this.emitBroadcast({
          type: 'status',
          cluster: 'stocks',
          state: 'error',
          message: redactSecrets(message, this.secrets),
          time: Math.floor(this.nowMsFn() / 1_000),
        });
      },
    });
    this.tradierStocksStream = stream;
    void stream.start().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.emitBroadcast({
        type: 'status',
        cluster: 'stocks',
        state: 'error',
        message: redactSecrets(`tradier stream start failed: ${message}`, this.secrets),
        time: Math.floor(this.nowMsFn() / 1_000),
      });
    });
  }

  private ingestLiveTradeInto1m(
    symbol: string,
    price: number,
    size: number,
    timeSec: number,
  ): void {
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(timeSec) || timeSec <= 0) {
      return;
    }
    const cleanTimeSec = Math.floor(timeSec);
    const cleanSize = Number.isFinite(size) && size >= 0 ? size : 0;
    const tradeEvent: WsTradeEvent = {
      ev: 'T',
      sym: symbol,
      price,
      size: cleanSize,
      timeSec: cleanTimeSec,
      eventTimeMs: cleanTimeSec * 1_000,
    };
    const currentState = this.liveStates1m.get(symbol) ?? createLiveBarState([], 60);
    const nextState = ingestWsEvents(currentState, [tradeEvent], {
      symbol,
      maxClosedBars: 600,
    });
    this.liveStates1m.set(symbol, nextState);
    const lastClosed = nextState.closedBars[nextState.closedBars.length - 1];
    this.emitBroadcast({
      type: 'bar_update',
      cluster: 'stocks',
      symbol,
      time: cleanTimeSec,
      formingBar: nextState.formingBar !== null ? serializeBar(nextState.formingBar) : null,
      lastClosedBar: lastClosed !== undefined ? serializeBar(lastClosed) : null,
      projectedEma21: null,
      projectedSessionVwap: null,
      projectedAvwap: null,
      serverTimeSec: cleanTimeSec,
    });
  }

  /**
   * Pieza 32: ingiere un tick Tradier al bus interno (wsListeners) y al estado de
   * cotizaciones US como complemento explícito de Massive (source `TRADIER_WS`).
   * Pieza 42: procesa `trade` y `timesale` en RTH, Pre-Market y After-Hours,
   * alimentando `liveStates1m`, `market_batch` y `GgalTickStreamEngine`.
   */
  private ingestTradierTick(tick: TradierStreamTick): void {
    const symbol = tick.symbol.trim().toUpperCase();
    if (symbol === '') return;
    const existing = this.tradierQuoteTicks.get(symbol) ?? null;
    const bidAskMid =
      Number.isFinite(tick.bid) && Number.isFinite(tick.ask) && tick.bid > 0 && tick.ask >= tick.bid
        ? 0.5 * (tick.bid + tick.ask)
        : Number.NaN;
    const price = Number.isFinite(tick.price) && tick.price > 0 ? tick.price : bidAskMid;
    const asOfUtcSec = Number.isFinite(tick.asOfUtcSec) ? tick.asOfUtcSec : null;
    if (existing !== null && asOfUtcSec !== null && existing.asOfUtcSec !== null && asOfUtcSec < existing.asOfUtcSec) {
      return;
    }
    const tickTimeSec = asOfUtcSec ?? Math.floor(this.nowMsFn() / 1_000);
    const phase = tick.sessionPhase ?? getUsEquitySessionPhase(tickTimeSec);
    if (!Number.isFinite(price) || price <= 0) {
      if (tick.event === 'quote' && Number.isFinite(tick.bid) && Number.isFinite(tick.ask)) {
        this.emitBroadcast({
          type: 'quote',
          cluster: 'stocks',
          symbol,
          time: tickTimeSec,
          bid: Number.isFinite(tick.bid) ? tick.bid : null,
          ask: Number.isFinite(tick.ask) ? tick.ask : null,
          mid: Number.isFinite(bidAskMid) ? bidAskMid : null,
        });
      }
      return;
    }
    const previousClose =
      Number.isFinite(tick.previousClose) && tick.previousClose > 0
        ? tick.previousClose
        : existing?.previousClose ?? null;
    const regularBaseline =
      this.fmpQuoteTicks.get(symbol)?.price ??
      existing?.regularClose ??
      previousClose;
    const isExt = isExtendedHoursPhase(phase);
    const extRef = phase === 'AFTER_HOURS' ? (regularBaseline ?? previousClose) : (previousClose ?? regularBaseline);
    const extendedChangePct =
      isExt && extRef !== null && extRef > 0 ? ((price - extRef) / extRef) * 100 : null;
    const volume = Number.isFinite(tick.cumulativeVolume) && tick.cumulativeVolume >= 0
      ? tick.cumulativeVolume
      : existing?.volume ?? null;
    const quote: MarketTickQuote = {
      market: 'US',
      symbol,
      kind: 'stock',
      currency: 'USD',
      price,
      previousClose,
      changePct:
        isExt && phase === 'PRE_MARKET'
          ? extendedChangePct
          : previousClose !== null && previousClose > 0
            ? ((price - previousClose) / previousClose) * 100
            : null,
      dayLow: existing?.dayLow ?? null,
      dayHigh: existing?.dayHigh ?? null,
      volume,
      turnover: existing?.turnover ?? null,
      asOfUtcSec: tickTimeSec,
      source: 'TRADIER_WS',
      regularClose: regularBaseline,
      extendedPrice: isExt ? price : null,
      extendedChangePct,
      sessionPhase: phase,
    };
    this.tradierQuoteTicks.set(symbol, quote);
    const isTradeLike = tick.event === 'trade' || tick.event === 'timesale';
    if (isTradeLike) {
      const size = Number.isFinite(tick.size) && tick.size >= 0 ? tick.size : 0;
      this.ingestLiveTradeInto1m(symbol, price, size, tickTimeSec);
      if (symbol === 'GGAL' && this.massiveStocksStream === null) {
        this.ggalTickEngine.applyAdrTick({
          price,
          size,
          timeSec: tickTimeSec,
        });
      }
      this.emitBroadcast({
        type: 'trade',
        cluster: 'stocks',
        symbol,
        time: tickTimeSec,
        price,
        size,
      });
    } else {
      this.emitBroadcast({
        type: 'quote',
        cluster: 'stocks',
        symbol,
        time: tickTimeSec,
        bid: Number.isFinite(tick.bid) ? tick.bid : null,
        ask: Number.isFinite(tick.ask) ? tick.ask : null,
        mid: Number.isFinite(bidAskMid) ? bidAskMid : null,
      });
    }
  }

  public stopWs(): void {
    this.stopFmpBatchQuoteLoop();
    this.stopFmpExtendedQuoteLoop();
    this.massiveStocksStream?.stop();
    this.massiveStocksStream = null;
    this.massiveSymbolLeases.clear();
    if (this.tradierStocksStream !== null) {
      this.tradierStocksStream.stop();
      this.tradierStocksStream = null;
    }
    if (this.tradierManager !== null) {
      this.tradierManager.stop();
      this.tradierManager = null;
    }
    this.tradierQuoteTicks.clear();
    if (this.stockWsClient !== null) {
      this.stockWsClient.close(1000, 'server_shutdown');
      this.stockWsClient = null;
    }
    if (this.optionsWsClient !== null) {
      this.optionsWsClient.close(1000, 'server_shutdown');
      this.optionsWsClient = null;
    }
    this.subscribedOptionContracts.clear();
    this.liveOptionQuotes.clear();
  }

  /**
   * Pieza 50.2: alta de suscripciones `T./Q.` de contratos de opciones con tope duro
   * de Massive (`MAX_MASSIVE_WS_OPTION_QUOTES = 1000`). `this.subscribedOptionContracts`
   * mantiene orden LRU (inserción): los tickers del lote actual se refrescan al extremo
   * más reciente y, si faltan slots, se evictan los más antiguos que no pertenezcan al
   * conjunto activo (con `unsubscribe` explícito de sus canales `T./Q.`).
   */
  private async ensureOptionQuoteSubscriptions(
    contractTickers: readonly string[],
    options: { readonly prioritize?: boolean } = {},
  ): Promise<void> {
    if (!this.enableWs || this.apiKey.trim() === '' || contractTickers.length === 0) {
      return;
    }

    // Refresco LRU: todo ticker ya suscripto que vuelve a pedirse se mueve al extremo
    // más reciente del `Set` (orden de inserción) para protegerlo de la evicción.
    for (const ticker of contractTickers) {
      if (this.subscribedOptionContracts.has(ticker)) {
        this.subscribedOptionContracts.delete(ticker);
        this.subscribedOptionContracts.add(ticker);
      }
    }

    let candidates: string[] = [];
    for (const ticker of contractTickers) {
      if (candidates.length >= MAX_WS_OPTION_CONTRACTS) {
        break;
      }
      if (!this.subscribedOptionContracts.has(ticker)) {
        candidates.push(ticker);
      }
    }
    if (candidates.length === 0) {
      return;
    }

    const activePrioritySet = new Set(contractTickers);
    // Presupuesto de crecimiento: el vencimiento activo (`prioritize`) puede usar el tope
    // completo de 1.000; las precargas normales conservan 50 slots de reserva.
    const slotBudget =
      options.prioritize === true ? MAX_MASSIVE_WS_OPTION_QUOTES : MAX_MASSIVE_WS_OPTION_QUOTES - 50;
    const neededSlots = this.subscribedOptionContracts.size + candidates.length - slotBudget;
    if (neededSlots > 0) {
      const evicted: string[] = [];
      for (const subscribed of this.subscribedOptionContracts) {
        if (evicted.length >= neededSlots) break;
        if (activePrioritySet.has(subscribed)) continue;
        evicted.push(subscribed);
      }
      if (evicted.length > 0) {
        const evictChannels = evicted.flatMap((c) => [`T.${c}`, `Q.${c}`]);
        try {
          this.optionsWsClient?.unsubscribe(evictChannels);
        } catch {
          // Ignoramos si aún está conectando.
        }
        for (const c of evicted) {
          this.subscribedOptionContracts.delete(c);
        }
      }
      const remainingSlots = slotBudget - this.subscribedOptionContracts.size;
      if (candidates.length > remainingSlots) {
        candidates = candidates.slice(0, Math.max(0, remainingSlots));
      }
    }
    if (candidates.length === 0) {
      return;
    }

    const channels: string[] = [];
    for (const c of candidates) {
      channels.push(`T.${c}`, `Q.${c}`);
    }
    // Invariante estricto: contratos y canales `Q.` (1 por contrato) nunca superan 1000
    // en la conexión WS de opciones administrada por este runtime.
    if (this.subscribedOptionContracts.size + candidates.length > MAX_MASSIVE_WS_OPTION_QUOTES) {
      return;
    }
    if (countQuoteSubscriptions(channels) > MAX_MASSIVE_WS_OPTION_QUOTES) {
      return;
    }

    if (this.optionsWsClient === null) {
      const client = this.createWsClientFn({
        apiKey: this.apiKey,
        cluster: 'options',
        initialSubscriptions: channels,
        autoReconnect: true,
        onEvents: (events: readonly WsNormalizedEvent[]) => {
          this.handleOptionWsEvents(events);
        },
        onStateChange: (state: WsConnectionState) => {
          this.emitBroadcast({
            type: 'status',
            cluster: 'options',
            state,
            message: `options ws state: ${state}`,
            time: Math.floor(this.nowMsFn() / 1_000),
          });
        },
        onError: (err: WsClientError) => {
          this.emitBroadcast({
            type: 'status',
            cluster: 'options',
            state: 'error',
            message: redactSecrets(err.message, this.secrets),
            time: Math.floor(this.nowMsFn() / 1_000),
          });
        },
      });
      this.optionsWsClient = client;
      for (const c of candidates) {
        this.subscribedOptionContracts.add(c);
      }
      try {
        await client.connect();
      } catch (err: unknown) {
        this.emitBroadcast({
          type: 'status',
          cluster: 'options',
          state: 'error',
          message: redactSecrets(extractErrorMessage(err, 'options ws connect error'), this.secrets),
          time: Math.floor(this.nowMsFn() / 1_000),
        });
      }
      return;
    }

    for (const c of candidates) {
      this.subscribedOptionContracts.add(c);
    }
    try {
      this.optionsWsClient.subscribe(channels);
    } catch {
      // Ignoramos si aún está conectando.
    }
  }

  private handleStockWsEvents(events: readonly WsNormalizedEvent[]): void {
    const bySymbol = new Map<string, WsNormalizedEvent[]>();
    const serverTimeSec = Math.floor(this.nowMsFn() / 1_000);

    for (const ev of events) {
      if (ev.ev === 'status') {
        this.emitBroadcast({
          type: 'status',
          cluster: 'stocks',
          state: ev.status,
          message: redactSecrets(ev.message, this.secrets),
          time: serverTimeSec,
        });
        continue;
      }
      if (ev.ev === 'T') {
        this.emitBroadcast({
          type: 'trade',
          cluster: 'stocks',
          symbol: ev.sym,
          time: ev.timeSec,
          price: ev.price,
          size: ev.size,
        });
      }
      if (ev.ev === 'T' || ev.ev === 'A' || ev.ev === 'AM') {
        const list = bySymbol.get(ev.sym);
        if (list !== undefined) {
          list.push(ev);
        } else {
          bySymbol.set(ev.sym, [ev]);
        }
      }
    }

    for (const [symbol, symEvents] of bySymbol.entries()) {
      const currentState = this.liveStates1m.get(symbol) ?? createLiveBarState([], 60);
      const prevLen = currentState.closedBars.length;
      const prevLast = currentState.closedBars[prevLen - 1];
      const prevRebroadcast = currentState.metrics.rebroadcastOverwrites;

      const nextState = ingestWsEvents(currentState, symEvents, {
        symbol,
        maxClosedBars: 600,
      });
      this.liveStates1m.set(symbol, nextState);

      // Pieza 39: tick-by-tick GGAL ADR desde el consolidador 1m (dedupe
      // T/A/AM ya resuelto); alimenta velas multi-timeframe + indicadores.
      if (symbol === 'GGAL') {
        const forming = nextState.formingBar;
        if (forming !== null) {
          this.ggalTickEngine.applyAdrMinute({
            timeSec: forming.time,
            open: forming.open,
            high: forming.high,
            low: forming.low,
            close: forming.close,
            volume: forming.volume,
          });
        }
        const lastClosed = nextState.closedBars[nextState.closedBars.length - 1];
        if (lastClosed !== undefined && (forming === null || lastClosed.time > forming.time)) {
          this.ggalTickEngine.applyAdrMinute({
            timeSec: lastClosed.time,
            open: lastClosed.open,
            high: lastClosed.high,
            low: lastClosed.low,
            close: lastClosed.close,
            volume: lastClosed.volume,
          });
        }
      }

      const currLast = nextState.closedBars[nextState.closedBars.length - 1];
      const mutated =
        nextState.closedBars.length !== prevLen ||
        currLast?.time !== prevLast?.time ||
        currLast?.close !== prevLast?.close ||
        currLast?.volume !== prevLast?.volume ||
        nextState.metrics.rebroadcastOverwrites !== prevRebroadcast;

      let closedInputs = this.closedInputs1m.get(symbol);
      if ((mutated || closedInputs === undefined) && nextState.closedBars.length >= 21) {
        const closes = nextState.closedBars.map((b) => b.close);
        const ema21 = calculateEma(closes, 21);
        const lastClosedEma = ema21[ema21.length - 1] ?? Number.NaN;
        const sessionVwap = computeSessionVwap(nextState.closedBars, {
          market: 'EQUITY',
          barSeconds: 60,
        });
        const avwap = computeAnchoredVwap(nextState.closedBars, 'SESSION', {
          market: 'EQUITY',
        });
        closedInputs = {
          ema: { lastClosedEma, period: 21 },
          sessionVwap: {
            closedState: sessionVwap.state,
            options: { market: 'EQUITY', barSeconds: 60 },
          },
          avwap: { closedState: avwap.state },
        };
        this.closedInputs1m.set(symbol, closedInputs);
      }

      const projection =
        nextState.formingBar !== null && closedInputs !== undefined
          ? projectLiveIndicators(nextState, closedInputs)
          : null;

      this.emitBroadcast({
        type: 'bar_update',
        cluster: 'stocks',
        symbol,
        time: nextState.formingBar?.time ?? currLast?.time ?? serverTimeSec,
        formingBar: nextState.formingBar !== null ? serializeBar(nextState.formingBar) : null,
        lastClosedBar: currLast !== undefined ? serializeBar(currLast) : null,
        projectedEma21: sanitizeFinite(projection?.ema),
        projectedSessionVwap: sanitizeFinite(projection?.sessionVwap?.vwap),
        projectedAvwap: sanitizeFinite(projection?.avwap?.vwap),
        serverTimeSec,
      });
    }
  }

  public getLiveOptionQuotes(underlying?: string): readonly LiveOptionQuoteSnapshot[] {
    if (underlying === undefined || underlying.trim() === '') {
      return [...this.liveOptionQuotes.values()];
    }
    const target = underlying.trim().toUpperCase();
    const out: LiveOptionQuoteSnapshot[] = [];
    for (const quote of this.liveOptionQuotes.values()) {
      if (quote.underlying === target) {
        out.push(quote);
      }
    }
    return out;
  }

  public getLiveOptionQuoteSnapshot(symbol: string): LiveOptionQuoteSnapshot | undefined {
    return this.liveOptionQuotes.get(symbol.trim().toUpperCase());
  }

  private handleOptionWsEvents(events: readonly WsNormalizedEvent[]): void {
    const serverTimeSec = Math.floor(this.nowMsFn() / 1_000);
    for (const ev of events) {
      if (ev.ev === 'status') {
        this.emitBroadcast({
          type: 'status',
          cluster: 'options',
          state: ev.status,
          message: redactSecrets(ev.message, this.secrets),
          time: serverTimeSec,
        });
      } else if (ev.ev === 'T') {
        const key = ev.sym.trim().toUpperCase();
        const prev = this.liveOptionQuotes.get(key);
        const underlying = prev?.underlying ?? extractOptionUnderlying(key) ?? '';
        const last = sanitizeFinite(ev.price);
        const size = sanitizeFinite(ev.size);
        const next: LiveOptionQuoteSnapshot = {
          symbol: key,
          underlying,
          time: ev.timeSec,
          bid: prev?.bid ?? null,
          ask: prev?.ask ?? null,
          mid: prev?.mid ?? null,
          last,
          size,
        };
        this.liveOptionQuotes.set(key, next);
        this.emitBroadcast({
          type: 'trade',
          cluster: 'options',
          symbol: ev.sym,
          time: ev.timeSec,
          price: ev.price,
          size: ev.size,
        });
      } else if (ev.ev === 'Q') {
        const key = ev.sym.trim().toUpperCase();
        const prev = this.liveOptionQuotes.get(key);
        const underlying = prev?.underlying ?? extractOptionUnderlying(key) ?? '';
        const bid = sanitizeFinite(ev.bidPrice);
        const ask = sanitizeFinite(ev.askPrice);
        const mid = bid !== null && ask !== null && ask >= bid ? 0.5 * (bid + ask) : null;
        const next: LiveOptionQuoteSnapshot = {
          symbol: key,
          underlying,
          time: ev.timeSec,
          bid,
          ask,
          mid,
          last: prev?.last ?? null,
          size: prev?.size ?? null,
        };
        this.liveOptionQuotes.set(key, next);
        if (!hasOptionQuoteChanged(prev, next)) {
          continue;
        }
        this.emitBroadcast({
          type: 'quote',
          cluster: 'options',
          symbol: ev.sym,
          time: ev.timeSec,
          bid,
          ask,
          mid,
        });
      }
    }
  }

  public getLiveUsQuotes(): readonly MarketTickQuote[] {
    const nowSec = Math.floor(this.nowMsFn() / 1_000);
    const sessionPhase = getUsEquitySessionPhase(nowSec);
    const regularBySymbol = new Map<string, MarketTickQuote>();
    const extendedBySymbol = new Map<string, MarketTickQuote>();

    const panel = this.lastUsPanelBase;
    if (panel !== null) {
      for (const row of panel.rows) {
        if (row.last === null || !Number.isFinite(row.last) || row.last <= 0) continue;
        regularBySymbol.set(row.symbol, {
          market: 'US',
          symbol: row.symbol,
          kind: 'stock',
          currency: 'USD',
          price: row.last,
          previousClose: row.prevClose,
          changePct: row.return1dPct,
          dayLow: row.dayLow,
          dayHigh: row.dayHigh,
          volume: null,
          turnover:
            row.tradedVolumeUsd !== undefined && row.tradedVolumeUsd !== null
              ? row.tradedVolumeUsd
              : row.volumeM !== null
                ? row.volumeM * 1_000_000
                : null,
          asOfUtcSec: null,
          source: 'MASSIVE_PANEL',
        });
      }
    }
    for (const quote of this.massiveStocksStream?.getQuotes() ?? []) {
      regularBySymbol.set(quote.symbol, quote);
    }
    for (const fmpQuote of this.fmpQuoteTicks.values()) {
      const existing = regularBySymbol.get(fmpQuote.symbol);
      if (existing === undefined) {
        regularBySymbol.set(fmpQuote.symbol, fmpQuote);
        continue;
      }
      regularBySymbol.set(fmpQuote.symbol, {
        ...existing,
        price: fmpQuote.price,
        previousClose: fmpQuote.previousClose ?? existing.previousClose,
        changePct: fmpQuote.changePct ?? existing.changePct,
        dayLow: existing.dayLow !== null && (fmpQuote.dayLow === null || existing.dayLow < fmpQuote.dayLow)
          ? existing.dayLow
          : fmpQuote.dayLow,
        dayHigh: existing.dayHigh !== null && (fmpQuote.dayHigh === null || existing.dayHigh > fmpQuote.dayHigh)
          ? existing.dayHigh
          : fmpQuote.dayHigh,
        volume: fmpQuote.volume ?? existing.volume,
        turnover: fmpQuote.turnover ?? existing.turnover,
        asOfUtcSec: fmpQuote.asOfUtcSec ?? existing.asOfUtcSec,
        source: 'FMP_ENTERPRISE_REST',
        exchange: fmpQuote.exchange ?? existing.exchange ?? null,
      });
    }

    for (const extQuote of this.fmpExtendedQuoteTicks.values()) {
      extendedBySymbol.set(extQuote.symbol, extQuote);
    }

    // Pieza 41 + 42: Tradier WS gobierna cuando su timestamp es más nuevo; en
    // Pre-Market / After-Hours un tick Tradier entra como cotización extendida
    // para que jamás sea sobrescrito por el batch RTH congelado.
    for (const tradierQuote of this.tradierQuoteTicks.values()) {
      const tickPhase = tradierQuote.sessionPhase ?? sessionPhase;
      if (tickPhase === 'RTH') {
        const existingReg = regularBySymbol.get(tradierQuote.symbol);
        if (
          existingReg !== undefined &&
          existingReg.asOfUtcSec !== null &&
          tradierQuote.asOfUtcSec !== null &&
          tradierQuote.asOfUtcSec < existingReg.asOfUtcSec
        ) {
          continue;
        }
        regularBySymbol.set(tradierQuote.symbol, {
          ...(existingReg ?? tradierQuote),
          ...tradierQuote,
          previousClose: tradierQuote.previousClose ?? existingReg?.previousClose ?? null,
          changePct:
            tradierQuote.previousClose !== null && tradierQuote.previousClose > 0
              ? ((tradierQuote.price - tradierQuote.previousClose) / tradierQuote.previousClose) * 100
              : tradierQuote.changePct ?? existingReg?.changePct ?? null,
          dayLow: tradierQuote.dayLow ?? existingReg?.dayLow ?? null,
          dayHigh: tradierQuote.dayHigh ?? existingReg?.dayHigh ?? null,
          volume: tradierQuote.volume ?? existingReg?.volume ?? null,
          turnover: tradierQuote.turnover ?? existingReg?.turnover ?? null,
          asOfUtcSec: tradierQuote.asOfUtcSec ?? existingReg?.asOfUtcSec ?? null,
          source: 'TRADIER_WS',
        });
      } else {
        const existingExt = extendedBySymbol.get(tradierQuote.symbol);
        if (
          existingExt !== undefined &&
          existingExt.asOfUtcSec !== null &&
          tradierQuote.asOfUtcSec !== null &&
          tradierQuote.asOfUtcSec < existingExt.asOfUtcSec
        ) {
          continue;
        }
        extendedBySymbol.set(tradierQuote.symbol, tradierQuote);
      }
    }

    const allSymbols = new Set<string>([
      ...regularBySymbol.keys(),
      ...extendedBySymbol.keys(),
    ]);
    const mergedQuotes: MarketTickQuote[] = [];
    for (const symbol of allSymbols) {
      const merged = mergeUsRegularAndExtendedQuote({
        regular: regularBySymbol.get(symbol) ?? null,
        extended: extendedBySymbol.get(symbol) ?? null,
        sessionPhase,
      });
      if (merged !== null) {
        mergedQuotes.push(merged);
      }
    }
    return mergedQuotes;
  }

  public getUsLiveSourceMode():
    | 'TRADIER_WS'
    | 'FMP_ENTERPRISE_REST'
    | 'MASSIVE_WS'
    | 'MASSIVE_BATCH'
    | 'NO_DATA' {
    const tradierStatus = this.tradierStocksStream?.getStatus() ?? this.tradierManager?.getStatus() ?? null;
    if (tradierStatus?.connected === true) return 'TRADIER_WS';
    if (this.fmpQuoteTicks.size > 0) return 'FMP_ENTERPRISE_REST';
    const streamMode = this.massiveStocksStream?.getDiagnostics().sourceMode;
    if (streamMode !== undefined) return streamMode;
    return this.lastUsPanelBase !== null ? 'MASSIVE_BATCH' : 'NO_DATA';
  }

  private getEffectiveTradierConfig(): TradierConfig {
    return (
      this.negotiatedTradierConfig ??
      this.tradierAuthBreaker.getNegotiatedConfig() ??
      this.tradierStocksStream?.getEffectiveConfig() ??
      this.tradierManager?.getEffectiveConfig() ??
      this.tradierConfig
    );
  }

  public isTradierAuthInvalid(): boolean {
    if (this.tradierAuthBreaker.isOpen(this.nowMsFn())) return true;
    const status = this.tradierStocksStream?.getStatus() ?? this.tradierManager?.getStatus() ?? null;
    return status?.authInvalid === true;
  }

  /** Pieza 32: Tradier configurado con token explícito. */
  public isTradierConfigured(): boolean {
    return this.tradierConfig.configured;
  }

  /** Pieza 32: estado del stream Tradier live (sin material secreto). */
  public getTradierLiveStatus(): UsTradierProviderStatus {
    const status =
      this.tradierStocksStream?.getStatus() ??
      this.tradierManager?.getStatus() ??
      null;
    const effective = this.getEffectiveTradierConfig();
    const authInvalid = this.isTradierAuthInvalid();
    const breakerStatus = this.tradierAuthBreaker.getStatus(this.nowMsFn());
    if (status === null) {
      return {
        configured: effective.configured,
        connected: false,
        state: authInvalid ? 'AUTH_INVALID' : 'IDLE',
        authInvalid,
        sessionCreated: false,
        subscribedSymbols: [],
        lastTickAtUtcSec: null,
        lastError: authInvalid ? breakerStatus.lastReason : null,
        activeRole: 'STANDBY',
        apiEnv: effective.apiEnv,
        environment: effective.apiEnv === 'sandbox' ? ('SANDBOX' as const) : ('LIVE' as const),
        restBaseUrl: effective.restBaseUrl,
        wsBaseUrl: effective.wsBaseUrl,
      };
    }
    return {
      configured: status.configured,
      connected: status.connected,
      state: authInvalid ? 'AUTH_INVALID' : status.state,
      authInvalid,
      sessionCreated: status.sessionCreated,
      subscribedSymbols: [...status.subscribedSymbols],
      lastTickAtUtcSec: status.lastTickAtUtcSec,
      lastError: status.lastError ?? (authInvalid ? breakerStatus.lastReason : null),
      activeRole: status.activeRole,
      apiEnv: status.apiEnv,
      environment: status.environment,
      restBaseUrl: status.restBaseUrl,
      wsBaseUrl: status.wsBaseUrl,
    };
  }

  /**
   * Pieza 32: estado real de los proveedores de mercado US para
   * `GET /api/us/providers-status`. ORATS se compone en `httpWsServer` con el
   * cliente híbrido del GGAL Specialist (rol superficie).
   */
  public getUsProvidersStatus(): UsProvidersStatus {
    const nowUtcSec = Math.floor(this.nowMsFn() / 1_000);
    const wsSlot = this.wsStocksKeySlot();
    const wsSnapshot = this.massiveStocksStream?.getWsSnapshot() ?? null;
    const wsConfigured = wsSlot.key.trim() !== '';
    const poolStatus = this.depsApiKey !== null ? null : getMassiveKeyPoolStatus();
    const restSlots: readonly { readonly envName: string; readonly slotIndex: number }[] =
      poolStatus?.rest.slots ??
      (this.depsApiKey !== null ? [{ envName: 'deps.apiKey', slotIndex: 0 }] : []);
    const wsKeySlot: UsProviderKeySlotStatus | null =
      wsSlot.envName === ''
        ? null
        : {
            envName: wsSlot.envName,
            slotIndex: wsSlot.slotIndex,
            poolSize: wsSlot.poolSize,
          };
    return {
      asOfUtcSec: nowUtcSec,
      MASSIVE_WS: {
        configured: wsConfigured,
        connected: wsSnapshot?.state === 'ready',
        state: wsSnapshot?.state ?? 'disconnected',
        keySlot: wsKeySlot,
        activeRole: 'WS_STOCKS',
        lastError: wsSnapshot?.lastError?.message ?? null,
        subscribedOptionQuotes: this.subscribedOptionContracts.size,
      },
      MASSIVE_REST_POOL: {
        configured: this.depsApiKey !== null ? true : poolStatus?.rest.configured === true,
        poolSize: poolStatus?.rest.poolSize ?? (this.depsApiKey !== null ? 1 : 0),
        slots: restSlots,
        lastSlotIndex: poolStatus?.rest.lastSlotIndex ?? (this.depsApiKey !== null ? 0 : null),
        roundRobinRequests: poolStatus?.rest.roundRobinRequests ?? 0,
        activeRole: 'REST_LOADERS',
      },
      TRADIER_LIVE: this.getTradierLiveStatus(),
    };
  }

  /** Pieza 33: telemetría real del socket Massive de acciones. */
  public getMassiveWsFeedHealth() {
    const nowMs = this.nowMsFn();
    const stream = this.massiveStocksStream;
    const wsSlot = this.wsStocksKeySlot();
    const diagnostics = stream?.getDiagnostics() ?? null;
    const wsSnapshot = stream?.getWsSnapshot() ?? null;
    return {
      configured: wsSlot.key.trim() !== '',
      connected: wsSnapshot?.state === 'ready',
      stocksMode: this.massiveStocksMode,
      keySlot:
        wsSlot.envName === ''
          ? null
          : {
              envName: wsSlot.envName,
              slotIndex: wsSlot.slotIndex,
              poolSize: wsSlot.poolSize,
            },
      lastError: wsSnapshot?.lastError?.message ?? null,
      telemetry: stream?.getFeedTelemetrySnapshot() ?? emptyFeedTelemetrySnapshot(),
      subscribedSymbols: stream?.getSubscribedSymbols() ?? [],      activeSymbolCount: diagnostics?.quoteCount ?? 0,
      subscribedOptionQuotes: this.subscribedOptionContracts.size,
      lastWsMessageAgeMs:
        diagnostics?.lastWsMessageMs !== null &&
        diagnostics?.lastWsMessageMs !== undefined &&
        nowMs >= diagnostics.lastWsMessageMs
          ? nowMs - diagnostics.lastWsMessageMs
          : null,
    };
  }

  /** Pieza 33: telemetría HTTP del pool REST (sin avanzar round-robin). */
  public getMassiveRestFeedHealth() {
    const poolStatus = this.depsApiKey !== null ? null : getMassiveKeyPoolStatus();
    return {
      configured: this.depsApiKey !== null ? true : poolStatus?.rest.configured === true,
      poolSize: poolStatus?.rest.poolSize ?? (this.depsApiKey !== null ? 1 : 0),
      slots:
        poolStatus?.rest.slots ??
        (this.depsApiKey !== null ? [{ envName: 'deps.apiKey', slotIndex: 0 }] : []),
      lastSlotIndex: poolStatus?.rest.lastSlotIndex ?? (this.depsApiKey !== null ? 0 : null),
      roundRobinRequests: poolStatus?.rest.roundRobinRequests ?? 0,
      telemetry: this.restTelemetry.snapshot(this.nowMsFn()),
    };
  }

  /** Pieza 33: telemetría Tradier live. */
  public getTradierFeedHealth() {
    const status =
      this.tradierStocksStream?.getStatus() ??
      this.tradierManager?.getStatus() ??
      null;
    const effective = this.getEffectiveTradierConfig();
    const authInvalid = this.isTradierAuthInvalid();
    const breakerStatus = this.tradierAuthBreaker.getStatus(this.nowMsFn());
    const apiEnv = status?.apiEnv ?? effective.apiEnv;
    return {
      configured: effective.configured,
      connected: status?.connected ?? false,
      authInvalid,
      sessionCreated: status?.sessionCreated ?? false,
      reconnectAttempts: status?.reconnectAttempts ?? 0,
      subscribedSymbols: status?.subscribedSymbols ?? [],
      lastError: status?.lastError ?? (authInvalid ? breakerStatus.lastReason : null),
      apiEnv,
      environment: apiEnv === 'sandbox' ? ('SANDBOX' as const) : ('LIVE' as const),
      restBaseUrl: status?.restBaseUrl ?? effective.restBaseUrl,
      wsBaseUrl: status?.wsBaseUrl ?? effective.wsBaseUrl,
      telemetry:
        this.tradierStocksStream?.getFeedTelemetrySnapshot(this.nowMsFn()) ??
        this.tradierManager?.getFeedTelemetrySnapshot(this.nowMsFn()) ??
        emptyFeedTelemetrySnapshot(),
    };
  }

  /** Pieza 33/40: reinicio no bloqueante del stream de acciones con cierre acotado. */
  public reconnectMassiveStocksWs(): Promise<string> {
    if (this.massiveStocksMode === 'STANDBY_TRADIER_FMP_PRIMARY') {
      throw new Error('MASSIVE_WS_STOCKS_STANDBY_TRADIER_FMP_PRIMARY');
    }
    if (!this.enableWs) {
      throw new Error('Massive WS is disabled by runtime configuration');
    }
    const wsKey = this.wsStocksKeySlot().key;
    if (wsKey.trim() === '') {
      throw new Error('MASSIVE_WS_STOCKS_KEY / MASSIVE_API_KEY not configured');
    }
    if (this.massiveReconnectInFlight !== null) {
      return Promise.resolve('MASSIVE_WS_STOCKS_RECONNECT_ACCEPTED');
    }
    const work = (async (): Promise<void> => {
      const previous = this.massiveStocksStream;
      this.massiveStocksStream = null;
      await previous?.stopAndWait(4_000).catch(() => undefined);
      await this.startWs();
    })().finally(() => {
      this.massiveReconnectInFlight = null;
    });
    this.massiveReconnectInFlight = work;
    work.catch(() => undefined);
    return Promise.resolve('MASSIVE_WS_STOCKS_RECONNECT_ACCEPTED');
  }

  /** Pieza 33: sonda real del pool REST mediante refresco forzado de snapshot. */
  public async resyncMassiveRestPool(): Promise<string> {
    await this.getSnapshot('SPY', { forceRefresh: true });
    return 'MASSIVE_REST_POOL_RESYNC_COMPLETED';
  }

  /** Pieza 33: resincronización exclusiva del stream Tradier. */
  public async reconnectTradierLive(): Promise<string> {
    if (!this.tradierConfig.configured) {
      throw new Error('Tradier access token not configured');
    }
    this.tradierAuthBreaker.reset();
    this.negotiatedTradierConfig = null;
    if (this.tradierStocksStream !== null) {
      this.tradierStocksStream.stop();
      await this.tradierStocksStream.start();
      return 'TRADIER_LIVE_WS_RECONNECT_ACCEPTED';
    }
    if (this.tradierManager !== null) {
      await this.tradierManager.reconnect();
      return 'TRADIER_LIVE_WS_RECONNECT_ACCEPTED';
    }
    const symbols = [...new Set([...US_STREAM_SYMBOLS, ...this.watchedSymbols])]
      .map((symbol) => symbol.trim().toUpperCase())
      .filter((symbol) => symbol !== '' && !symbol.startsWith('I:'));
    if (symbols.length === 0) {
      throw new Error('Tradier live has no configured equity symbols');
    }
    this.ensureTradierLiveStream(symbols);
    return 'TRADIER_LIVE_WS_START_ACCEPTED';
  }

  /**
   * Pieza 32 / 43: cotizaciones NBBO Tradier para ADRs/acciones US con
   * negociación Live↔Sandbox y circuit-breaker ante 401.
   */
  public async fetchTradierQuotesSafe(
    symbols: readonly string[],
  ): Promise<TradierQuotesResult | null> {
    const config = this.getEffectiveTradierConfig();
    if (!config.configured) {
      return null;
    }
    if (this.isTradierAuthInvalid()) {
      throw new TradierAuthInvalidError('Tradier authentication invalid (HTTP 401 cooldown active)');
    }
    return this.tradierQuotesFetchFn(symbols, {
      config,
      ...(this.tradierHttpFn === undefined ? {} : { httpFn: this.tradierHttpFn }),
      nowMsFn: this.nowMsFn,
      secrets: this.secrets,
      authBreaker: this.tradierAuthBreaker,
      onEnvironmentNegotiated: (nextConfig) => {
        this.negotiatedTradierConfig = nextConfig;
      },
    });
  }

  /**
   * Pieza 43: respaldo de cotizaciones ADR/US vía FMP Enterprise (ticks vivos o
   * consulta directa batch + extended hours) cuando Tradier está en AUTH_INVALID.
   */
  public async fetchFmpAdrQuotesSafe(
    symbols: readonly string[],
  ): Promise<readonly FmpAdrFallbackQuote[]> {
    const clean = [
      ...new Set(symbols.map((s) => s.trim().toUpperCase()).filter((s) => s !== '')),
    ];
    if (clean.length === 0) {
      return [];
    }
    const nowSec = Math.floor(this.nowMsFn() / 1_000);
    const sessionPhase = getUsEquitySessionPhase(nowSec);
    const outMap = new Map<string, FmpAdrFallbackQuote>();
    const liveQuotes = new Map(this.getLiveUsQuotes().map((q) => [q.symbol, q]));
    for (const symbol of clean) {
      const live = liveQuotes.get(symbol);
      if (live === undefined) continue;
      const extPrice =
        live.extendedPrice !== undefined &&
        live.extendedPrice !== null &&
        Number.isFinite(live.extendedPrice) &&
        live.extendedPrice > 0
          ? live.extendedPrice
          : null;
      const basePrice = Number.isFinite(live.price) && live.price > 0 ? live.price : extPrice;
      if (basePrice === null) continue;
      outMap.set(symbol, {
        symbol,
        price: basePrice,
        previousClose: live.previousClose,
        changePct: live.changePct,
        asOfUtcSec: live.asOfUtcSec,
        extendedPrice: extPrice,
        extendedChangePct: live.extendedChangePct ?? null,
        sessionPhase: live.sessionPhase ?? sessionPhase,
      });
    }

    const missing = clean.filter((sym) => !outMap.has(sym));
    if (missing.length > 0 && this.fmpConfig.configured) {
      const batchRes = await this.fmpClient.fetchBatchQuotes(missing).catch(() => null);
      const extRes = isExtendedHoursPhase(sessionPhase)
        ? await this.fmpClient.fetchExtendedBatchQuotes(missing).catch(() => null)
        : null;
      const extBySym = new Map((extRes?.quotes ?? []).map((q) => [q.symbol, q]));
      const regBySym = new Map((batchRes?.quotes ?? []).map((q) => [q.symbol, q]));
      for (const symbol of missing) {
        const reg = regBySym.get(symbol);
        const ext = extBySym.get(symbol);
        const extPrice = ext !== undefined && Number.isFinite(ext.price) && ext.price > 0 ? ext.price : null;
        const regPrice = reg !== undefined && Number.isFinite(reg.price) && reg.price > 0 ? reg.price : null;
        const price = extPrice !== null && isExtendedHoursPhase(sessionPhase) ? extPrice : regPrice ?? extPrice;
        if (price === null) continue;
        const previousClose =
          reg?.previousClose !== null && reg?.previousClose !== undefined && Number.isFinite(reg.previousClose)
            ? reg.previousClose
            : null;
        const extendedChangePct =
          extPrice !== null && previousClose !== null && previousClose > 0
            ? ((extPrice - previousClose) / previousClose) * 100
            : null;
        const changePct =
          reg?.changePct !== null && reg?.changePct !== undefined && Number.isFinite(reg.changePct)
            ? reg.changePct
            : previousClose !== null && previousClose > 0
              ? ((price - previousClose) / previousClose) * 100
              : null;
        outMap.set(symbol, {
          symbol,
          price,
          previousClose,
          changePct,
          asOfUtcSec: ext?.asOfUtcSec ?? reg?.asOfUtcSec ?? null,
          extendedPrice: extPrice,
          extendedChangePct,
          sessionPhase,
        });
      }
    }
    return [...outMap.values()];
  }

  private overlayLiveUsPanel(base: EquityPanelAnalyticsDto): EquityPanelAnalyticsDto {
    const liveBySymbol = new Map(this.getLiveUsQuotes().map((quote) => [quote.symbol, quote]));
    if (liveBySymbol.size === 0) return base;
    let asOfUtcSec = base.asOfUtcSec;
    const rows = base.rows.map((row) => {
      const live = liveBySymbol.get(row.symbol);
      if (live === undefined) return row;
      if (live.asOfUtcSec !== null) asOfUtcSec = Math.max(asOfUtcSec, live.asOfUtcSec);
      const dayRangePos =
        live.dayLow !== null && live.dayHigh !== null && live.dayHigh > live.dayLow
          ? Math.max(0, Math.min(1, (live.price - live.dayLow) / (live.dayHigh - live.dayLow)))
          : null;
      return {
        ...row,
        last: live.price,
        prevClose: live.previousClose ?? row.prevClose,
        dayLow: live.dayLow ?? row.dayLow,
        dayHigh: live.dayHigh ?? row.dayHigh,
        dayRangePos,
        volumeM: live.turnover !== null ? live.turnover / 1_000_000 : row.volumeM,
        tradedVolumeUsd: live.turnover ?? row.tradedVolumeUsd ?? null,
        return1dPct: live.changePct ?? row.return1dPct,
        ...(live.regularClose !== undefined ? { regularClose: live.regularClose } : {}),
        ...(live.extendedPrice !== undefined ? { extendedPrice: live.extendedPrice } : {}),
        ...(live.extendedChangePct !== undefined ? { extendedChangePct: live.extendedChangePct } : {}),
        ...(live.sessionPhase !== undefined ? { sessionPhase: live.sessionPhase } : {}),
      };
    });
    return {
      ...base,
      asOfUtcSec,
      rows,
      topGainers: rows
        .filter((row) => row.return1dPct !== null && row.return1dPct > 0)
        .sort((a, b) => (b.return1dPct ?? 0) - (a.return1dPct ?? 0))
        .slice(0, 8),
      topLosers: rows
        .filter((row) => row.return1dPct !== null && row.return1dPct < 0)
        .sort((a, b) => (a.return1dPct ?? 0) - (b.return1dPct ?? 0))
        .slice(0, 8),
    };
  }

  private overlayLiveSnapshot(base: TerminalSnapshotResponse): TerminalSnapshotResponse {
    const liveBySymbol = new Map(this.getLiveUsQuotes().map((quote) => [quote.symbol, quote]));
    if (liveBySymbol.size === 0) return base;
    const unifiedQuotes = base.marketContext.unifiedQuotes.map((quote) => {
      const live = liveBySymbol.get(quote.ticker.toUpperCase());
      if (live === undefined) return quote;
      return {
        ...quote,
        price: live.price,
        change:
          live.previousClose !== null && live.previousClose > 0
            ? live.price - live.previousClose
            : quote.change,
        changePct: live.changePct,
        previousClose: live.previousClose ?? quote.previousClose,
        dayLow: live.dayLow ?? quote.dayLow,
        dayHigh: live.dayHigh ?? quote.dayHigh,
        dayRangePos:
          live.dayLow !== null && live.dayHigh !== null && live.dayHigh > live.dayLow
            ? Math.max(0, Math.min(1, (live.price - live.dayLow) / (live.dayHigh - live.dayLow)))
            : null,
        volume: live.volume ?? quote.volume,
        volumeM: live.turnover !== null ? live.turnover / 1_000_000 : quote.volumeM,
        tradedVolumeUsd: live.turnover ?? quote.tradedVolumeUsd ?? null,
        ...(live.regularClose !== undefined ? { regularClose: live.regularClose } : {}),
        ...(live.extendedPrice !== undefined ? { extendedPrice: live.extendedPrice } : {}),
        ...(live.extendedChangePct !== undefined ? { extendedChangePct: live.extendedChangePct } : {}),
        ...(live.sessionPhase !== undefined ? { sessionPhase: live.sessionPhase } : {}),
      };
    });
    const vix = liveBySymbol.get('I:VIX');
    return {
      ...base,
      marketContext: {
        ...base.marketContext,
        unifiedQuotes,
        vixLevel: vix?.price ?? base.marketContext.vixLevel,
      },
      ...(base.usEquityPanel !== undefined && base.usEquityPanel !== null
        ? { usEquityPanel: this.overlayLiveUsPanel(base.usEquityPanel) }
        : {}),
    };
  }

  public async getSnapshot(
    rawSymbol: string,
    options: {
      readonly forceRefresh?: boolean;
      readonly expiration?: string;
      /** Solo para usos internos (warmup/vol-surface): evita precalentar cadenas recursivamente. */
      readonly prefetch?: boolean;
    } = {},
  ): Promise<TerminalSnapshotResponse> {
    const parsed = parseTerminalSymbol(rawSymbol, this.secrets);
    const normalizedExpiration = options.expiration?.trim().toUpperCase() ?? '';
    const cacheKey = normalizedExpiration === ''
      ? `snapshot:${parsed.canonicalSymbol}`
      : `snapshot:${parsed.canonicalSymbol}:${normalizedExpiration}`;
    const result = await this.snapshotCache.getOrCompute(
      cacheKey,
      () => this.computeSnapshot(parsed, { ...(normalizedExpiration === '' ? {} : { expiration: normalizedExpiration }) }),
      {
        ttlMs: 15_000,
        ...(options.forceRefresh === undefined ? {} : { forceRefresh: options.forceRefresh }),
      },
    );
    if (options.prefetch === true && normalizedExpiration === '') {
      const selection = result.value.optionsChain ?? null;
      // Pieza 50.2: las fechas ya precargadas como anclas (`loaded: true`) no vuelven
      // a disparar un snapshot completo recursivo; solo se prefetcha lo pendiente.
      const loadedDates = new Set(
        (selection?.availableExpirations ?? [])
          .filter((candidate) => candidate.loaded)
          .map((candidate) => candidate.expirationDate),
      );
      for (const expiration of selection?.prefetchExpirationDates ?? []) {
        if (loadedDates.has(expiration)) continue;
        void this.getSnapshot(parsed.canonicalSymbol, {
          expiration,
          prefetch: false,
        }).catch((err: unknown) => {
          this.lastUsOptionsPrefetchError = redactSecrets(
            extractErrorMessage(err, 'US option snapshot prefetch failed'),
            this.secrets,
          );
        });
      }
    }
    return this.overlayLiveSnapshot(result.value);
  }

  private async computeUsVolSurface(canonicalSymbol: string, forceRefresh: boolean): Promise<UsVolSurfaceResponse> {
    const nowSec = Math.floor(this.nowMsFn() / 1_000);
    if (this.oratsClient === null) {
      const unavailableSurface: OratsHybridSurfacePayload = {
        status: 'UNAVAILABLE',
        source: 'ORATS_DELAYED_CORE',
        ticker: canonicalSymbol,
        asOfUtcSec: nowSec,
        reason: 'ORATS_API_KEY_NOT_CONFIGURED',
        massiveSpotPrice: null,
        massiveSpotSourceMode: 'UNAVAILABLE',
        yangZhangAdrVol: Number.NaN,
      };
      const unavailableRank: OratsIvRankPayload = {
        status: 'UNAVAILABLE',
        source: 'ORATS_IV_RANK',
        ticker: canonicalSymbol,
        reason: 'ORATS_API_KEY_NOT_CONFIGURED',
      };
      return {
        status: 'NO_DATA',
        symbol: canonicalSymbol,
        asOfUtcSec: nowSec,
        cacheState: 'UNAVAILABLE',
        stale: false,
        reason: 'ORATS_CLIENT_NOT_CONFIGURED',
        surface: sanitizeJsonValue(unavailableSurface),
        ivRank: sanitizeJsonValue(unavailableRank),
      };
    }

    // La cadena base nunca consulta ORATS; aquí solo se consume su snapshot ya cacheado.
    const snapshot = await this.getSnapshot(canonicalSymbol, { prefetch: false });
    const spot = sanitizeFinite(snapshot.envelope.snapshot.metrics.spot);
    const quote = snapshot.marketContext.unifiedQuotes.find((q) => q.ticker === canonicalSymbol);
    const quoteBid = quote?.bid;
    const quoteAsk = quote?.ask;
    const hasNbbo =
      quoteBid !== undefined &&
      quoteBid !== null &&
      Number.isFinite(quoteBid) &&
      quoteBid > 0 &&
      quoteAsk !== undefined &&
      quoteAsk !== null &&
      Number.isFinite(quoteAsk) &&
      quoteAsk > 0 &&
      quoteAsk >= quoteBid;
    const barsRes = await this.getCachedDailyBars1d(canonicalSymbol, 265, false);
    const yzBars: YangZhangOhlcBar[] = normalizeClosedDailyBarsUs(barsRes.bars, nowSec).map((b) => ({
      timeSec: b.time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    }));
    const yangZhangAdrVol = computeYangZhangVol(yzBars, 252);

    const [surface, ivRank] = await Promise.all([
      this.oratsClient.fetchHybridSurface({
        ticker: canonicalSymbol,
        massiveSpotPrice: spot,
        massiveSpotSourceMode: hasNbbo ? 'MASSIVE_NBBO' : spot !== null ? 'MASSIVE_BARS' : 'UNAVAILABLE',
        yangZhangAdrVol,
        forceRefresh,
      }),
      this.oratsClient.fetchIvRank(canonicalSymbol, forceRefresh),
    ]);

    const surfaceOk = surface.status === 'OPERATIONAL';
    const ivRankOk = ivRank.status === 'OPERATIONAL';
    const status: UsVolSurfaceResponse['status'] =
      surfaceOk && ivRankOk ? 'OK' : surfaceOk || ivRankOk ? 'PARTIAL' : 'NO_DATA';
    const reason =
      surfaceOk && ivRankOk
        ? null
        : `${surfaceOk ? 'SURFACE_OK' : `SURFACE:${surface.reason}`} | ${
            ivRankOk ? 'IV_RANK_OK' : `IV_RANK:${ivRank.reason}`
          }`;
    return {
      status,
      symbol: canonicalSymbol,
      asOfUtcSec: nowSec,
      cacheState: 'MISS',
      stale: false,
      reason,
      surface: sanitizeJsonValue(surface),
      ivRank: sanitizeJsonValue(ivRank),
    };
  }

  public async getUsVolSurface(
    rawSymbol: string,
    options: { readonly forceRefresh?: boolean } = {},
  ): Promise<UsVolSurfaceResponse> {
    const parsed = parseTerminalSymbol(rawSymbol, this.secrets);
    const cacheKey = `us:vol-surface:${parsed.canonicalSymbol}`;
    const forceRefresh = options.forceRefresh === true;
    const nowMs = this.nowMsFn();
    if (!forceRefresh) {
      const cached = this.usVolSurfaceCache.get(cacheKey);
      if (cached !== undefined) {
        const ageMs = nowMs - cached.fetchedAtMs;
        if (ageMs < US_VOL_SURFACE_TTL_MS) {
          return { ...cached.response, cacheState: 'HIT', stale: false };
        }
        const inflight = this.usVolSurfaceInFlight.get(cacheKey);
        if (inflight === undefined) {
          const refresh = this.computeUsVolSurface(parsed.canonicalSymbol, false)
            .then((fresh) => {
              this.usVolSurfaceCache.set(cacheKey, { fetchedAtMs: this.nowMsFn(), response: fresh });
              return fresh;
            })
            .finally(() => {
              this.usVolSurfaceInFlight.delete(cacheKey);
            });
          this.usVolSurfaceInFlight.set(cacheKey, refresh);
        }
        return { ...cached.response, cacheState: 'STALE', stale: true };
      }
    }

    const inflight = this.usVolSurfaceInFlight.get(cacheKey);
    if (inflight !== undefined) {
      return inflight;
    }
    const compute = this.computeUsVolSurface(parsed.canonicalSymbol, forceRefresh)
      .then((fresh) => {
        this.usVolSurfaceCache.set(cacheKey, { fetchedAtMs: this.nowMsFn(), response: fresh });
        return fresh;
      })
      .finally(() => {
        if (this.usVolSurfaceInFlight.get(cacheKey) === compute) {
          this.usVolSurfaceInFlight.delete(cacheKey);
        }
      });
    this.usVolSurfaceInFlight.set(cacheKey, compute);
    return compute;
  }

  private async getUsStocksV2Batch(
    tickers: readonly string[],
    forceRefresh = false,
  ): Promise<{ readonly map: ReadonlyMap<string, V2StockBatchQuote>; readonly error: string | null }> {
    const cleanTickers = [...new Set(tickers.map((t) => t.trim().toUpperCase()).filter((t) => t.length > 0))];
    if (cleanTickers.length === 0) {
      return { map: new Map(), error: null };
    }
    const cacheKey = `v2stocks:${[...cleanTickers].sort().join(',')}`;
    const res = await this.stocksV2Cache.getOrCompute(
      cacheKey,
      async () => {
        const base = (this.baseUrl ?? 'https://api.massive.com').replace(/\/+$/, '');
        const rawUrl = `${base}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${encodeURIComponent(cleanTickers.join(','))}`;
        const authedUrl = withMassiveAuthUrl(rawUrl, this.restBatchApiKey());
        try {
          const httpRes = await this.fetchFn(authedUrl);
          if (!httpRes.ok) {
            return {
              map: new Map<string, V2StockBatchQuote>(),
              error: redactSecrets(`Massive v2 snapshot HTTP ${String(httpRes.status)}`, this.secrets),
            };
          }
          const parsed = JSON.parse(httpRes.text) as Record<string, unknown>;
          const rawTickers = parsed['tickers'];
          const out = new Map<string, V2StockBatchQuote>();
          if (Array.isArray(rawTickers)) {
            for (const item of rawTickers) {
              const q = parseV2StockTickerSnapshot(item);
              if (q !== null) {
                out.set(q.ticker, q);
              }
            }
          }
          return { map: out, error: null };
        } catch (err: unknown) {
          return {
            map: new Map<string, V2StockBatchQuote>(),
            error: redactSecrets(extractErrorMessage(err, 'Massive v2 snapshot failed'), this.secrets),
          };
        }
      },
      { forceRefresh },
    );
    return res.value;
  }

  /**
   * Pieza 32: obtiene la cadena Tradier por vencimiento con cache (15s) y
   * single-flight; lanza el error redactado hacia el caller.
   */
  private async getTradierChainWithCache(
    symbol: string,
    expiration: string,
  ): Promise<TradierOptionChainResult> {
    if (this.isTradierAuthInvalid()) {
      throw new TradierAuthInvalidError('Tradier authentication invalid (HTTP 401 cooldown active)');
    }
    const cacheKey = `${symbol}:${expiration}`;
    const nowMs = this.nowMsFn();
    const cached = this.tradierChainCache.get(cacheKey);
    if (cached !== undefined && nowMs - cached.atMs < TRADIER_CHAIN_CACHE_TTL_MS) {
      return cached.result;
    }
    const inflight = this.tradierChainInFlight.get(cacheKey);
    if (inflight !== undefined) {
      return inflight;
    }
    const promise = this.tradierChainFetchFn(symbol, expiration, {
      config: this.getEffectiveTradierConfig(),
      ...(this.tradierHttpFn === undefined ? {} : { httpFn: this.tradierHttpFn }),
      nowMsFn: this.nowMsFn,
      secrets: this.secrets,
      authBreaker: this.tradierAuthBreaker,
      onEnvironmentNegotiated: (nextConfig) => {
        this.negotiatedTradierConfig = nextConfig;
      },
    })
      .then((result) => {
        this.tradierChainCache.set(cacheKey, { atMs: nowMs, result });
        if (this.tradierChainCache.size > 64) {
          const oldestKey = this.tradierChainCache.keys().next().value;
          if (oldestKey !== undefined) {
            this.tradierChainCache.delete(oldestKey);
          }
        }
        return result;
      })
      .finally(() => {
        this.tradierChainInFlight.delete(cacheKey);
      });
    this.tradierChainInFlight.set(cacheKey, promise);
    return promise;
  }

  /**
   * Pieza 50.2: descubre el catálogo 100 % de vencimientos OPRA con una consulta
   * liviana (`contract_type=call`, banda ATM angosta, sin `maxDte`) paginada en
   * 1–3 páginas, cacheada 12 min por subyacente. Si la banda angosta no devuelve
   * contratos o agota `maxPages`, reintenta sin `minStrike`/`maxStrike` (banda total)
   * y registra warning si aun así queda truncado.
   */
  private async getUsExpiryCatalog(
    canonicalSymbol: string,
    isIndex: boolean,
    spot: number,
    nowSec: number,
    baseTransport: { readonly apiKey: string; readonly fetchFn: FetchFn; readonly baseUrl?: string },
    warnings: string[],
  ): Promise<UsExpiryCatalogResult> {
    const cacheKey = `us:expiry-catalog:${canonicalSymbol}`;
    const result = await this.usExpiryCatalogCache.getOrCompute(cacheKey, async () => {
      const todayEt = todayEtDate(this.nowMsFn()) ?? addCalendarDaysEt(nowSec, 0);
      const halfBand = Math.max(spot * (spot >= 1_000 ? 0.03 : 0.04), 5);
      const minStrike = Math.max(0.01, Math.floor((spot - halfBand) * 100) / 100);
      const maxStrike = Math.ceil((spot + halfBand) * 100) / 100;
      const queryCatalog = async (
        withBand: boolean,
        maxPages: number,
      ): Promise<Awaited<ReturnType<typeof loadOptionContracts>>> =>
        this.loadOptionContractsFn({
          underlying: canonicalSymbol,
          isIndex,
          expired: false,
          expirationDateGte: todayEt,
          contractType: 'call',
          ...(withBand ? { minStrike, maxStrike } : {}),
          excludeBinary: true,
          excludeAdjusted: true,
          limit: 1_000,
          maxPages,
          ...baseTransport,
        });

      let res = await queryCatalog(true, 15);
      if (res.contracts.length === 0 || res.report.stoppedReason === 'maxPages') {
        res = await queryCatalog(false, 25);
      }
      const catalogWarnings: string[] = [];
      if (res.report.providerError !== null) {
        catalogWarnings.push(
          `US expiry catalog error: ${redactSecrets(res.report.providerError.message, this.secrets)}`,
        );
      }
      const complete = res.report.stoppedReason !== 'maxPages';
      if (!complete) {
        catalogWarnings.push('US expiry catalog truncated: maxPages reached');
      }
      return {
        canonicalSymbol,
        asOfUtcSec: nowSec,
        expirations: extractUsExpiryCatalog(res.contracts, spot, nowSec),
        contracts: res.contracts,
        complete,
        warnings: catalogWarnings,
      };
    });
    for (const warning of result.value.warnings) {
      if (!warnings.includes(warning)) {
        warnings.push(warning);
      }
    }
    return result.value;
  }

  /**
   * Pieza 50.2: evalúa la paridad de un vencimiento exacto y, cuando la sonrisa OTM
   * permite, su slice + métricas (IV propia BSM/Americana por contrato, relajación EOD
   * explícita), registrando la IV propia resuelta en `contractOwnIvMap`. La paridad se
   * devuelve aunque el slice sea inválido (comportamiento Pieza 50.1 para valuar
   * contratos y exposición del front); `null` solo si la paridad no es calculable.
   */
  private buildExpiryEvaluation(params: {
    readonly expirySec: number;
    readonly expiryContracts: readonly OptionSnapshotContract[];
    readonly spot: number;
    readonly nowSec: number;
    readonly latestTreasury: TreasuryYieldObservation | undefined;
    readonly sofrRate: number;
    readonly isIndex: boolean;
    readonly contractOwnIvMap: Map<string, number>;
    readonly relaxShortHorizon: boolean;
  }): { readonly parity: ExpiryParityEvaluation; readonly pkg: SlicePackage | null } | null {
    const {
      expirySec,
      expiryContracts,
      spot,
      nowSec,
      latestTreasury,
      sofrRate,
      isIndex,
      contractOwnIvMap,
      relaxShortHorizon,
    } = params;
    const parity = evaluateParityForExpiry(
      expirySec,
      expiryContracts,
      nowSec,
      spot,
      latestTreasury,
      sofrRate,
    );
    if (parity === null) {
      return null;
    }

    const quotes: VolQuoteInput[] = [];
    for (const c of expiryContracts) {
      const { bid, ask } = c.lastQuote;
      const mid = resolveQuoteMid(c);
      if (!Number.isFinite(mid) || mid <= 0) {
        continue;
      }
      const ownIv = solveContractOwnIv(
        c,
        spot,
        parity.timeToExpiry,
        parity.rate,
        parity.dividendYield,
        isIndex,
      );
      if (Number.isFinite(ownIv) && ownIv > 0) {
        contractOwnIvMap.set(c.ticker, ownIv);
      }
      if (Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask >= bid) {
        quotes.push({
          strike: c.strikePrice,
          contractType: c.contractType,
          iv: ownIv,
          bid,
          ask,
          mid,
          openInterest: Number.isFinite(c.openInterest) ? c.openInterest : 0,
        });
      }
    }

    const strictSlice = buildVolSlice(
      {
        timeToExpiry: parity.timeToExpiry,
        expirySec,
        forward: parity.forward,
        spot,
        rate: parity.rate,
        dividendYield: parity.dividendYield,
        quotes,
      },
      {
        requirePositiveBid: true,
        maxSpreadRatio: 0.35,
        minOpenInterest: 1,
        minPoints: 6,
        quoteSelection: 'otm',
      },
    );
    let slice = strictSlice;
    if (!slice.isValid && relaxShortHorizon) {
      const relaxedQuotes: VolQuoteInput[] = [];
      for (const c of expiryContracts) {
        const midRaw = resolveQuoteMid(c);
        const effMid =
          Number.isFinite(midRaw) && midRaw > 0
            ? midRaw
            : Number.isFinite(c.day.close) && c.day.close > 0
              ? c.day.close
              : Number.NaN;
        if (!Number.isFinite(effMid) || effMid <= 0) {
          continue;
        }
        const ownIv = contractOwnIvMap.get(c.ticker) ?? Number.NaN;
        const effIv =
          Number.isFinite(ownIv) && ownIv > 0
            ? ownIv
            : Number.isFinite(c.impliedVolatility) && c.impliedVolatility > 0
              ? c.impliedVolatility
              : Number.NaN;
        if (!Number.isFinite(effIv) || effIv <= 0) {
          continue;
        }
        const { bid, ask } = c.lastQuote;
        const effBid = Number.isFinite(bid) && bid > 0 ? bid : effMid * 0.96;
        const effAsk = Number.isFinite(ask) && ask >= effBid ? ask : effMid * 1.04;
        relaxedQuotes.push({
          strike: c.strikePrice,
          contractType: c.contractType,
          iv: effIv,
          bid: effBid,
          ask: effAsk,
          mid: effMid,
          openInterest: Number.isFinite(c.openInterest) ? c.openInterest : 0,
        });
      }
      if (relaxedQuotes.length >= 3) {
        const otmRelaxed = buildVolSlice(
          {
            timeToExpiry: parity.timeToExpiry,
            expirySec,
            forward: parity.forward,
            spot,
            rate: parity.rate,
            dividendYield: parity.dividendYield,
            quotes: relaxedQuotes,
          },
          {
            requirePositiveBid: false,
            maxSpreadRatio: 1.5,
            minOpenInterest: 0,
            minPoints: 3,
            quoteSelection: 'otm',
          },
        );
        slice = otmRelaxed.isValid
          ? otmRelaxed
          : buildVolSlice(
              {
                timeToExpiry: parity.timeToExpiry,
                expirySec,
                forward: parity.forward,
                spot,
                rate: parity.rate,
                dividendYield: parity.dividendYield,
                quotes: relaxedQuotes,
              },
              {
                requirePositiveBid: false,
                maxSpreadRatio: 1.5,
                minOpenInterest: 0,
                minPoints: 3,
                quoteSelection: 'spreadWeightedMean',
              },
            );
      }
    }
    if (!slice.isValid) {
      return { parity, pkg: null };
    }
    const metrics = computeSliceVolMetrics(slice, {
      spot,
      rate: parity.rate,
      dividendYield: parity.dividendYield,
      deltaConvention: 'spotBsm',
    });
    if (!Number.isFinite(metrics.ivAtm)) {
      return { parity, pkg: null };
    }
    return {
      parity,
      pkg: {
        parity,
        slice,
        metrics,
        isButterflyArbitrageFree: metrics.isButterflyArbitrageFree,
        butterflyMinDensity: Number.NaN,
      },
    };
  }

  /** Pieza 50.2: IV ATM por vencimiento (slice válida o promedio OTM cercano al spot). */
  private buildExpiryAtmIvMap(
    validSlices: readonly SlicePackage[],
    contracts: readonly OptionSnapshotContract[],
    contractOwnIvMap: ReadonlyMap<string, number>,
    spot: number,
  ): Map<number, number> {
    const expiryAtmIvMap = new Map<number, number>();
    for (const sp of validSlices) {
      if (Number.isFinite(sp.metrics.ivAtm) && sp.metrics.ivAtm > 0 && sp.metrics.ivAtm < IV_CAP_DECIMAL) {
        expiryAtmIvMap.set(sp.parity.expirySec, sp.metrics.ivAtm);
      }
    }
    for (const c of contracts) {
      if (expiryAtmIvMap.has(c.expirationTime)) continue;
      const nearContracts = contracts
        .filter((row) => row.expirationTime === c.expirationTime)
        .sort((a, b) => Math.abs(a.strikePrice - spot) - Math.abs(b.strikePrice - spot));
      const nearOtmIvs: number[] = [];
      for (const row of nearContracts.slice(0, 4)) {
        const isOtm = row.contractType === 'call' ? row.strikePrice >= spot - 1e-6 : row.strikePrice <= spot + 1e-6;
        if (!isOtm) continue;
        const ivVal = contractOwnIvMap.get(row.ticker) ?? row.impliedVolatility;
        if (Number.isFinite(ivVal) && ivVal > 0 && ivVal < IV_CAP_DECIMAL) {
          nearOtmIvs.push(ivVal);
        }
      }
      if (nearOtmIvs.length > 0) {
        expiryAtmIvMap.set(
          c.expirationTime,
          nearOtmIvs.reduce((acc, v) => acc + v, 0) / nearOtmIvs.length,
        );
      }
    }
    return expiryAtmIvMap;
  }

  /** Pieza 50.2: IV OTM confiable por `(expirySec, strike)` para el rescate ITM por paridad. */
  private buildOtmIvByExpiryStrike(
    contracts: readonly OptionSnapshotContract[],
    contractOwnIvMap: ReadonlyMap<string, number>,
    spot: number,
    nowSec: number,
  ): Map<string, number> {
    const otmIvByExpiryStrike = new Map<string, number>();
    for (const c of contracts) {
      if (!(c.expirationTime > nowSec + 60)) continue;
      const isOtm =
        c.contractType === 'call'
          ? c.strikePrice >= spot - 1e-6
          : c.strikePrice <= spot + 1e-6;
      if (!isOtm) continue;
      const ivVal = contractOwnIvMap.get(c.ticker) ?? c.impliedVolatility;
      if (!Number.isFinite(ivVal) || ivVal <= 0 || ivVal >= IV_CAP_DECIMAL) continue;
      const otmExtrinsic = extrinsicValue(
        c.contractType,
        spot,
        c.strikePrice,
        resolveQuoteMid(c),
      );
      if (!Number.isFinite(otmExtrinsic) || otmExtrinsic <= 0.01) continue;
      const key = `${String(c.expirationTime)}|${String(c.strikePrice)}`;
      if (!otmIvByExpiryStrike.has(key)) {
        otmIvByExpiryStrike.set(key, ivVal);
      }
    }
    return otmIvByExpiryStrike;
  }

  /**
   * Pieza 50.2: serializa filas OPRA con IV propia/proveedor saneada, rescate ITM por
   * paridad o IV ATM, y griegas BSM (índices) / Americanas (acciones y ADR). Cero
   * fallbacks silenciosos: lo no calculable viaja como `null` y la UI muestra `—`.
   */
  private serializeExpiryContractRows(params: {
    readonly selected: readonly OptionSnapshotContract[];
    readonly spot: number;
    readonly nowSec: number;
    readonly isIndex: boolean;
    readonly expiryParityMap: ReadonlyMap<number, ExpiryParityEvaluation>;
    readonly fallbackParity: ExpiryParityEvaluation;
    readonly contractOwnIvMap: ReadonlyMap<string, number>;
    readonly expiryAtmIvMap: ReadonlyMap<number, number>;
    readonly otmIvByExpiryStrike: ReadonlyMap<string, number>;
  }): SerializedOptionContractRow[] {
    const {
      selected,
      spot,
      nowSec,
      isIndex,
      expiryParityMap,
      fallbackParity,
      contractOwnIvMap,
      expiryAtmIvMap,
      otmIvByExpiryStrike,
    } = params;
    return selected.map((c) => {
      const parity = expiryParityMap.get(c.expirationTime) ?? fallbackParity;
      const tExp = timeToExpiryYears(nowSec, c.expirationTime);
      const ownIv = contractOwnIvMap.get(c.ticker) ?? Number.NaN;
      const provIv = c.impliedVolatility;
      const mid = resolveQuoteMid(c);
      const rawExt = extrinsicValue(c.contractType, spot, c.strikePrice, mid);
      const effTExp = Number.isFinite(tExp) && tExp > 0 ? Math.max(tExp, 1e-4) : Number.NaN;
      const fallbackAtmIv = expiryAtmIvMap.get(c.expirationTime) ?? Number.NaN;
      const itmContract =
        c.contractType === 'call' ? c.strikePrice < spot - 1e-6 : c.strikePrice > spot - 1e-6;
      const moneynessAbs = Number.isFinite(spot) && spot > 0
        ? Math.abs(c.strikePrice - spot) / spot
        : Number.NaN;
      const rawUsedIv =
        Number.isFinite(ownIv) && ownIv > 0
          ? ownIv
          : Number.isFinite(provIv) && provIv > 0
            ? provIv
            : Number.NaN;
      // Pieza 50.3: extrínseco agotado = `rawExt <= EXTRINSIC_EPS` (incluye mid por debajo
      // del intrínseco por spread/tick de spot). Antes se anulaba a NaN y desactivaba el
      // colapso DEEP_ITM_INTRINSIC, dejando pasar una IV ruidosa (Delta -0.66/-0.70).
      const extrinsicExhausted = Number.isFinite(rawExt) && rawExt <= EXTRINSIC_EPS;
      const isDeep4SigmaByAtm =
        Number.isFinite(fallbackAtmIv) &&
        fallbackAtmIv > 0 &&
        Number.isFinite(effTExp) &&
        Math.abs(spot - c.strikePrice) > 4 * spot * fallbackAtmIv * Math.sqrt(effTExp);
      const blownProviderDeepItm =
        itmContract &&
        isDeep4SigmaByAtm &&
        Number.isFinite(rawUsedIv) &&
        rawUsedIv > Math.max(3.0, fallbackAtmIv * 4);
      const unreliableIv =
        extrinsicExhausted ||
        blownProviderDeepItm ||
        (Number.isFinite(rawUsedIv) && isIvUnreliable(rawUsedIv, rawExt));
      const cleanOwnIv =
        !unreliableIv && Number.isFinite(ownIv) && ownIv > 0 && ownIv < IV_CAP_DECIMAL
          ? ownIv
          : Number.NaN;
      const cleanProvIv =
        !unreliableIv && Number.isFinite(provIv) && provIv > 0 && provIv < IV_CAP_DECIMAL
          ? provIv
          : Number.NaN;
      const usedIv = Number.isFinite(cleanOwnIv)
        ? cleanOwnIv
        : Number.isFinite(cleanProvIv)
          ? cleanProvIv
          : Number.NaN;

      const effUsedIv = Number.isFinite(usedIv) && usedIv > 0 ? Math.max(usedIv, 1e-4) : Number.NaN;

      // Pieza 50.1: rescate ITM vía contraparte OTM del mismo strike (paridad Put-Call)
      // o IV ATM (±15 % moneyness) antes de colapsar a DEEP_ITM_INTRINSIC. Pieza 50.3:
      // la cola deep 4σ por IV ATM NO se rescata (el colapso honesto es ±1 / 0).
      const counterpartOtmIv =
        otmIvByExpiryStrike.get(`${String(c.expirationTime)}|${String(c.strikePrice)}`) ??
        Number.NaN;
      const itmRescue: ParityItmRescueResult =
        unreliableIv && itmContract && !isDeep4SigmaByAtm
          ? resolveParityItmRescueIv({
              counterpartOtmIv,
              atmIv: fallbackAtmIv,
              moneynessAbs,
            })
          : { iv: null, source: null };
      const rescuedEngineIv =
        itmRescue.iv !== null && Number.isFinite(effTExp)
          ? Math.max(itmRescue.iv, 1e-4)
          : Number.NaN;
      const engineIv = Number.isFinite(rescuedEngineIv) ? rescuedEngineIv : effUsedIv;
      const ivSource: SerializedOptionContractRow['ivSource'] = Number.isFinite(rescuedEngineIv)
        ? itmRescue.source === 'ATM_RESCUE'
          ? 'ATM_FALLBACK'
          : 'PARITY_OTM'
        : Number.isFinite(cleanOwnIv)
          ? 'OWN'
          : Number.isFinite(cleanProvIv)
            ? 'PROVIDER'
            : 'NONE';

      const fallbackGreeks =
        itmRescue.iv === null && unreliableIv && Number.isFinite(effTExp)
          ? computeFallbackGreeks({
              side: c.contractType,
              spot,
              strike: c.strikePrice,
              timeToExpiry: effTExp,
              rate: parity.rate,
              dividendYield: parity.dividendYield,
              contractIv: null,
              // Pieza 50.3: el extrínseco real finito (no NaN) dispara DEEP_ITM_INTRINSIC.
              extrinsic: rawExt,
              ivAtm: fallbackAtmIv,
            })
          : null;
      const rawGreeks =
        fallbackGreeks !== null
          ? fallbackGreeks.source === 'NO_DATA'
            ? null
            : {
                delta: fallbackGreeks.delta,
                gamma: fallbackGreeks.gamma,
                thetaDaily: fallbackGreeks.theta / 365,
                vegaPer1Pct: fallbackGreeks.vega / 100,
                rho: 0,
                vanna: 0,
                charm: 0,
              }
          : Number.isFinite(engineIv) && Number.isFinite(effTExp)
          ? isIndex
            ? greeksBsm({
                spot,
                strike: c.strikePrice,
                timeToExpiry: effTExp,
                rate: parity.rate,
                dividendYield: parity.dividendYield,
                volatility: engineIv,
                contractType: c.contractType,
              })
            : greeksAmericanFiniteDiffOrAnalytical({
                spot,
                strike: c.strikePrice,
                timeToExpiry: effTExp,
                rate: parity.rate,
                dividendYield: parity.dividendYield,
                volatility: engineIv,
                contractType: c.contractType,
              })
          : null;
      const needUsBsmFallback =
        fallbackGreeks === null &&
        rawGreeks !== null &&
        (!Number.isFinite(rawGreeks.gamma) ||
          !Number.isFinite(rawGreeks.delta) ||
          !Number.isFinite(rawGreeks.thetaDaily) ||
          !Number.isFinite(rawGreeks.vegaPer1Pct));
      const bsmUsFallback =
        needUsBsmFallback && Number.isFinite(engineIv) && Number.isFinite(effTExp)
          ? greeksBsm({
              spot,
              strike: c.strikePrice,
              timeToExpiry: effTExp,
              rate: parity.rate,
              dividendYield: parity.dividendYield,
              volatility: engineIv,
              contractType: c.contractType,
            })
          : null;
      const greeks =
        rawGreeks === null
          ? null
          : bsmUsFallback === null
            ? rawGreeks
            : {
                delta: Number.isFinite(rawGreeks.delta) ? rawGreeks.delta : bsmUsFallback.delta,
                gamma: Number.isFinite(rawGreeks.gamma) ? rawGreeks.gamma : bsmUsFallback.gamma,
                thetaDaily: Number.isFinite(rawGreeks.thetaDaily)
                  ? rawGreeks.thetaDaily
                  : bsmUsFallback.thetaDaily,
                vegaPer1Pct: Number.isFinite(rawGreeks.vegaPer1Pct)
                  ? rawGreeks.vegaPer1Pct
                  : bsmUsFallback.vegaPer1Pct,
                rho: Number.isFinite(rawGreeks.rho) ? rawGreeks.rho : bsmUsFallback.rho,
                vanna: Number.isFinite(rawGreeks.vanna) ? rawGreeks.vanna : bsmUsFallback.vanna,
                charm: Number.isFinite(rawGreeks.charm) ? rawGreeks.charm : bsmUsFallback.charm,
              };

      const changePct = resolveContractChangePct(
        c.day.changePercent,
        c.day.previousClose,
        firstPositiveFinite([c.day.close, c.lastTrade.price, mid]),
      );

      return {
        ticker: c.ticker,
        contractType: c.contractType,
        strike: c.strikePrice,
        expirationDate: c.expirationDate,
        expiryUtcSec: c.expirationTime,
        bid: sanitizeFinite(c.lastQuote.bid),
        ask: sanitizeFinite(c.lastQuote.ask),
        mid: sanitizeFinite(mid),
        lastPrice: sanitizeFinite(c.lastTrade.price),
        openInterest: sanitizeFinite(c.openInterest),
        volume: sanitizeFinite(c.day.volume),
        previousClose: sanitizeFinite(c.day.previousClose),
        changePct,
        ownIv: sanitizeFinite(cleanOwnIv),
        providerIv: sanitizeFinite(cleanProvIv),
        ivSource,
        delta: sanitizeFinite(greeks?.delta),
        gamma: sanitizeFinite(greeks?.gamma),
        thetaDaily: sanitizeFinite(greeks?.thetaDaily),
        vegaPer1Pct: sanitizeFinite(greeks?.vegaPer1Pct),
        vanna: sanitizeFinite(greeks?.vanna),
        charm: sanitizeFinite(greeks?.charm),
      };
    });
  }

  /**
   * Pieza 50.2: insumos de exposición de dealers por contrato (IV propia resuelta con
   * conteo explícito de fallback al proveedor) reutilizados por snapshot y cadena
   * on-demand sin duplicar lógica.
   */
  private buildExposureInputs(params: {
    readonly contracts: readonly OptionSnapshotContract[];
    readonly expiryParityMap: ReadonlyMap<number, ExpiryParityEvaluation>;
    readonly fallbackParity: ExpiryParityEvaluation;
    readonly contractOwnIvMap: ReadonlyMap<string, number>;
    readonly spot: number;
  }): {
    readonly inputs: ExposureContractInput[];
    readonly ownSolvedIvContracts: number;
    readonly providerFallbackIvContracts: number;
  } {
    const { contracts, expiryParityMap, fallbackParity, contractOwnIvMap, spot } = params;
    const inputs: ExposureContractInput[] = [];
    let ownSolvedIvContracts = 0;
    let providerFallbackIvContracts = 0;
    for (const c of contracts) {
      const expParity = expiryParityMap.get(c.expirationTime) ?? fallbackParity;
      const ownIv = contractOwnIvMap.get(c.ticker);
      let ivToUse = Number.NaN;
      if (ownIv !== undefined && Number.isFinite(ownIv) && ownIv > 0) {
        ivToUse = ownIv;
        ownSolvedIvContracts += 1;
      } else if (Number.isFinite(c.impliedVolatility) && c.impliedVolatility > 0) {
        ivToUse = c.impliedVolatility;
        providerFallbackIvContracts += 1;
      }
      const mid = resolveQuoteMid(c);
      const { bid, ask } = c.lastQuote;
      inputs.push({
        contractType: c.contractType,
        strike: c.strikePrice,
        expiryUtcSec: c.expirationTime,
        openInterest: c.openInterest,
        ...(Number.isFinite(c.day.volume) && c.day.volume >= 0 ? { volume: c.day.volume } : {}),
        sharesPerContract: c.sharesPerContract,
        spot,
        forward: expParity.forward,
        rate: expParity.rate,
        dividendYield: expParity.dividendYield,
        ...(Number.isFinite(ivToUse) && ivToUse > 0 ? { iv: ivToUse } : {}),
        ...(Number.isFinite(mid) && mid > 0 ? { midPrice: mid } : {}),
        ...(Number.isFinite(bid) && bid >= 0 ? { bid } : {}),
        ...(Number.isFinite(ask) && ask > 0 ? { ask } : {}),
      });
    }
    return { inputs, ownSolvedIvContracts, providerFallbackIvContracts };
  }

  /**
   * Pieza 32: refresco en vivo de puntas `bid/ask/size`, volumen, open interest y
   * griegas de la cadena US/ADR con Tradier (`provider: 'TRADIER'`), manteniendo
   * Massive como base canónica. Índices (`I:*`) y snapshots sin contratos quedan
   * explícitamente fuera (summary `null`); los errores se reportan como warnings.
   */
  private async tryTradierChainOverlay(
    canonicalSymbol: string,
    isIndex: boolean,
    contracts: readonly OptionSnapshotContract[],
    nowSec: number,
    warnings: string[],
  ): Promise<{
    readonly contracts: readonly OptionSnapshotContract[];
    readonly summary: TradierChainOverlaySummary | null;
    readonly quoteSubstitutedTickers: ReadonlySet<string>;
  }> {
    if (!this.tradierConfig.configured || this.isTradierAuthInvalid() || isIndex || contracts.length === 0) {
      return { contracts, summary: null, quoteSubstitutedTickers: new Set<string>() };
    }
    const expirations = [...new Set(contracts.map((c) => c.expirationDate))]
      .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
      .sort()
      .slice(0, TRADIER_MAX_CHAIN_EXPIRIES);
    if (expirations.length === 0) {
      return { contracts, summary: null, quoteSubstitutedTickers: new Set<string>() };
    }

    const chainParts: TradierOptionContractNormalized[] = [];
    const errors: string[] = [];
    let httpStatus: number | null = null;
    for (const expiration of expirations) {
      try {
        const res = await this.getTradierChainWithCache(canonicalSymbol, expiration);
        chainParts.push(...res.contracts);
        if (res.provenance.httpStatus !== null) {
          httpStatus = res.provenance.httpStatus;
        }
      } catch (err: unknown) {
        if (err instanceof TradierAuthInvalidError) {
          return { contracts, summary: null, quoteSubstitutedTickers: new Set<string>() };
        }
        errors.push(
          `Tradier chain ${expiration}: ${redactSecrets(extractErrorMessage(err, 'tradier chain failed'), this.secrets)}`,
        );
      }
    }

    const lastError = errors.length > 0 ? errors.join('; ') : null;
    if (chainParts.length === 0) {
      warnings.push(...errors);
      return {
        contracts,
        summary: {
          provider: 'TRADIER',
          requestedExpirations: expirations,
          tradierContracts: 0,
          matchedByOcc: 0,
          matchedByStrikeType: 0,
          unmatchedTradierContracts: 0,
          overlaidContracts: 0,
          overlaidBidAsk: 0,
          overlaidSizes: 0,
          overlaidVolume: 0,
          overlaidOpenInterest: 0,
          overlaidGreeks: 0,
          overlaidMidIv: 0,
          skippedStaleQuotes: 0,
          httpStatus,
          lastError,
        },
        quoteSubstitutedTickers: new Set<string>(),
      };
    }
    warnings.push(...errors);
    const overlay = overlayTradierChainOnCanonicalContracts(contracts, chainParts, { nowSec });
    return {
      contracts: overlay.contracts,
      summary: {
        ...overlay.summary,
        requestedExpirations: expirations,
        httpStatus,
        lastError,
      },
      quoteSubstitutedTickers: overlay.quoteSubstitutedTickers,
    };
  }

  private async computeSnapshot(
    parsed: ParsedSymbol,
    options: { readonly expiration?: string } = {},
  ): Promise<TerminalSnapshotResponse> {
    const apiKey = this.assertRestApiKey();
    const nowSec = Math.floor(this.nowMsFn() / 1_000);
    const { canonicalSymbol, correlatedSymbol, isIndex } = parsed;
    const warnings: string[] = [];
    // Pieza 50.9: evidencia de la carga de cadena (fechas pedidas/entregadas).
    let chainRequestedDates: readonly string[] = [];
    const chainDateReports: ChainDateReport[] = [];

    const macroDateGte = addCalendarDaysEt(nowSec, -35);
    const unifiedTickers = [
      ...new Set([
        canonicalSymbol,
        correlatedSymbol,
        ...US_EQUITY_UNIVERSE.map((u) => u.symbol),
        'TLT',
        'HYG',
        'LQD',
        'XLY',
        'I:SPX',
        'I:VIX',
        'I:SKEW',
        'I:VVIX',
        'I:OVX',
        'I:DXY',
      ]),
    ];

    const baseTransport = {
      apiKey,
      fetchFn: this.fetchFn,
      ...(this.baseUrl === undefined ? {} : { baseUrl: this.baseUrl }),
    };

    const [
      treasuryRes,
      fundingRes,
      unifiedRes,
      v2StocksRes,
      bars1dRes,
      bars4hRes,
      bars15mRes,
      bars5mRes,
      corrBars5mRes,
      vixBars1dRes,
      spyBars1dRes,
    ] = await Promise.all([
      this.treasuryCache
        .getOrCompute(`treasury:${macroDateGte}`, () =>
          this.loadTreasuryYieldsFn({ ...baseTransport, dateGte: macroDateGte, limit: 100, maxPages: 1 }),
        )
        .then((r) => r.value),
      this.fundingCache
        .getOrCompute(`funding:${macroDateGte}`, () =>
          this.loadFundingConditionsFn({ ...baseTransport, dateGte: macroDateGte, limit: 100, maxPages: 1 }),
        )
        .then((r) => r.value),
      this.unifiedCache
        .getOrCompute(`unified:${[...new Set(unifiedTickers)].sort().join(',')}`, () =>
          this.loadUnifiedSnapshotFn({ ...baseTransport, tickers: unifiedTickers, limit: 250, maxPages: 1 }),
        )
        .then((r) => r.value),
      this.getUsStocksV2Batch(
        US_EQUITY_UNIVERSE.map((u) => u.symbol),
        false,
      ),
      this.loadBarsFn({
        provider: 'massive',
        symbol: canonicalSymbol,
        timeframe: '1D',
        visibleBars: 60,
        warmupBars: 720,
        maxPages: 3,
        now: nowSec,
        ...baseTransport,
      }),
      this.loadBarsFn({
        provider: 'massive',
        symbol: canonicalSymbol,
        timeframe: '4h',
        visibleBars: 60,
        warmupBars: 60,
        maxPages: 3,
        now: nowSec,
        ...baseTransport,
      }),
      this.loadBarsFn({
        provider: 'massive',
        symbol: canonicalSymbol,
        timeframe: '15m',
        visibleBars: 90,
        warmupBars: 40,
        rthOnly: true,
        maxPages: 3,
        now: nowSec,
        ...baseTransport,
      }),
      this.loadBarsFn({
        provider: 'massive',
        symbol: canonicalSymbol,
        timeframe: '5m',
        visibleBars: 240,
        warmupBars: 60,
        rthOnly: false,
        maxPages: 5,
        now: nowSec,
        ...baseTransport,
      }),
      this.loadBarsFn({
        provider: 'massive',
        symbol: correlatedSymbol,
        timeframe: '5m',
        visibleBars: 120,
        warmupBars: 30,
        rthOnly: false,
        maxPages: 3,
        now: nowSec,
        ...baseTransport,
      }),
      this.loadBarsFn({
        provider: 'massive',
        symbol: 'I:VIX',
        timeframe: '1D',
        visibleBars: 20,
        warmupBars: 10,
        maxPages: 1,
        now: nowSec,
        ...baseTransport,
      }).catch(() => null),
      canonicalSymbol === 'SPY'
        ? Promise.resolve(null)
        : this.loadBarsFn({
            provider: 'massive',
            symbol: 'SPY',
            timeframe: '1D',
            visibleBars: 60,
            warmupBars: 60,
            maxPages: 1,
            now: nowSec,
            ...baseTransport,
          }).catch(() => null),
    ]);

    if (bars5mRes.report.providerError !== null) {
      warnings.push(
        `5m bars error: ${redactSecrets(bars5mRes.report.providerError.message, this.secrets)}`,
      );
    }
    if (treasuryRes.report.providerError !== null) {
      warnings.push(
        `treasury error: ${redactSecrets(treasuryRes.report.providerError.message, this.secrets)}`,
      );
    }
    if (unifiedRes.report.providerError !== null) {
      warnings.push(
        `unified error: ${redactSecrets(unifiedRes.report.providerError.message, this.secrets)}`,
      );
    }

    const stockByTicker = new Map(unifiedRes.stocks.map((s) => [s.ticker, s]));
    const indexByTicker = new Map(unifiedRes.indices.map((idx) => [idx.ticker, idx]));

    let spot = resolveSpotPrice(
      null,
      stockByTicker.get(canonicalSymbol),
      indexByTicker.get(canonicalSymbol),
      bars5mRes.bars,
      bars1dRes.bars,
    );
    const v2Own = v2StocksRes.map.get(canonicalSymbol);
    if (!Number.isFinite(spot) && v2Own !== undefined && Number.isFinite(v2Own.price) && v2Own.price > 0) {
      spot = v2Own.price;
    }

    if (
      bars5mRes.bars.length === 0 &&
      bars15mRes.bars.length === 0 &&
      bars1dRes.bars.length === 0 &&
      !Number.isFinite(spot)
    ) {
      const errDetail =
        bars5mRes.report.providerError?.message ??
        bars1dRes.report.providerError?.message ??
        unifiedRes.report.providerError?.message ??
        `No market data returned by Massive for ${canonicalSymbol}`;
      throw new RuntimeNoDataError('NO_MARKET_DATA', errDetail, this.secrets, 503);
    }

    let latestTreasury =
      [...treasuryRes.observations]
        .reverse()
        .find((obs) => obs.finiteTenors === TREASURY_TENORS.length) ??
      treasuryRes.observations[treasuryRes.observations.length - 1];
    const latestFunding = [...fundingRes.observations]
      .reverse()
      .find((obs) => Number.isFinite(obs.sofr));
    let sofrRate = latestFunding?.sofr ?? Number.NaN;

    const hasMassiveCoreData =
      bars1dRes.bars.length > 0 ||
      bars5mRes.bars.length > 0 ||
      unifiedRes.stocks.length > 0 ||
      unifiedRes.indices.length > 0 ||
      v2StocksRes.map.size > 0;

    if (hasMassiveCoreData) {
      const needSofrFallback = !Number.isFinite(sofrRate);
      const needTreasuryFallback =
        latestTreasury === undefined ||
        !Number.isFinite(latestTreasury.yield2Year) ||
        !Number.isFinite(latestTreasury.yield10Year);
      const [nyfedCacheRes, fbTreasuryCacheRes] = await Promise.all([
        needSofrFallback
          ? this.nyfedSofrCache
              .getOrCompute('nyfed:sofr:last', () => fetchNyFedSofrDecimal(this.fetchFn))
              .then((r) => r.value)
          : Promise.resolve(null),
        needTreasuryFallback
          ? this.fallbackTreasuryCache
              .getOrCompute('treasury:fallback:latest', () =>
                fetchFallbackUsTreasuryCurve(this.fetchFn, this.nowMsFn()),
              )
              .then((r) => r.value)
          : Promise.resolve(null),
      ]);
      if (needSofrFallback && nyfedCacheRes !== null && Number.isFinite(nyfedCacheRes.sofr)) {
        sofrRate = nyfedCacheRes.sofr;
      }
      if (needTreasuryFallback && fbTreasuryCacheRes !== null && fbTreasuryCacheRes.observation !== null) {
        const fb = fbTreasuryCacheRes.observation;
        if (latestTreasury === undefined) {
          latestTreasury = fb;
        } else {
          const merged: TreasuryYieldObservation = {
            date: latestTreasury.date || fb.date,
            dateTime: latestTreasury.dateTime || fb.dateTime,
            yield1Month: Number.isFinite(latestTreasury.yield1Month) ? latestTreasury.yield1Month : fb.yield1Month,
            yield3Month: Number.isFinite(latestTreasury.yield3Month) ? latestTreasury.yield3Month : fb.yield3Month,
            yield6Month: Number.isFinite(latestTreasury.yield6Month) ? latestTreasury.yield6Month : fb.yield6Month,
            yield1Year: Number.isFinite(latestTreasury.yield1Year) ? latestTreasury.yield1Year : fb.yield1Year,
            yield2Year: Number.isFinite(latestTreasury.yield2Year) ? latestTreasury.yield2Year : fb.yield2Year,
            yield3Year: Number.isFinite(latestTreasury.yield3Year) ? latestTreasury.yield3Year : fb.yield3Year,
            yield5Year: Number.isFinite(latestTreasury.yield5Year) ? latestTreasury.yield5Year : fb.yield5Year,
            yield7Year: Number.isFinite(latestTreasury.yield7Year) ? latestTreasury.yield7Year : fb.yield7Year,
            yield10Year: Number.isFinite(latestTreasury.yield10Year) ? latestTreasury.yield10Year : fb.yield10Year,
            yield20Year: Number.isFinite(latestTreasury.yield20Year) ? latestTreasury.yield20Year : fb.yield20Year,
            yield30Year: Number.isFinite(latestTreasury.yield30Year) ? latestTreasury.yield30Year : fb.yield30Year,
            finiteTenors: 0,
          };
          const count = [
            merged.yield1Month,
            merged.yield3Month,
            merged.yield6Month,
            merged.yield1Year,
            merged.yield2Year,
            merged.yield3Year,
            merged.yield5Year,
            merged.yield7Year,
            merged.yield10Year,
            merged.yield20Year,
            merged.yield30Year,
          ].filter((v) => Number.isFinite(v)).length;
          latestTreasury = { ...merged, finiteTenors: count };
        }
      }
    }

    let contracts: readonly OptionSnapshotContract[] = [];
    let chainUnderlying: OptionUnderlyingSnapshot | null = null;
    let referenceContracts: readonly OptionContract[] = [];
    let usExpiryCatalog: UsExpiryCatalogResult | null = null;

    if (Number.isFinite(spot) && spot > 0) {
      const minStrike = Math.max(0.01, Math.floor(spot * 0.75 * 100) / 100);
      const maxStrike = Math.ceil(spot * 1.25 * 100) / 100;
      const optionMaxDte = canonicalSymbol === 'GGAL' ? 95 : 45;
      const referenceMaxDte = canonicalSymbol === 'GGAL' ? 95 : 60;
      try {
        if (canonicalSymbol === 'GGAL') {
          // GGAL conserva el camino legacy (índice liviano 0–95 DTE) para no alterar
          // la cadena exacta que fija su test de integración Pieza 44.
          const refRes = await this.loadOptionContractsFn({
            underlying: canonicalSymbol,
            isIndex,
            minDte: 0,
            maxDte: referenceMaxDte,
            now: nowSec,
            minStrike,
            maxStrike,
            excludeBinary: false,
            excludeAdjusted: false,
            limit: 1_000,
            maxPages: 3,
            ...baseTransport,
          });
          referenceContracts = refRes.contracts;

          const chainRes = await this.loadOptionChainFn({
            underlying: canonicalSymbol,
            isIndex,
            minDte: 0,
            maxDte: optionMaxDte,
            now: nowSec,
            minStrike,
            maxStrike,
            excludeBinary: true,
            excludeAdjusted: true,
            referenceContracts,
            snapshotLimit: 250,
            maxPages: 4,
            ...baseTransport,
          });
          contracts = chainRes.contracts;
          chainUnderlying = chainRes.underlying;
          // Pieza 50.9: evidencia de la carga por rango DTE (no equivale a fechas pedidas).
          chainDateReports.push({
            dateKey: null,
            kind: 'DTE_RANGE',
            stoppedReason: chainRes.report.stoppedReason,
            providerError: chainRes.report.providerError !== null,
            contractCount: chainRes.contracts.length,
          });
          if (chainRes.report.providerError !== null) {
            warnings.push(
              `options chain error: ${redactSecrets(chainRes.report.providerError.message, this.secrets)}`,
            );
          }
        } else {
          // Pieza 50.2: catálogo 100 % de vencimientos (calls, banda ATM angosta, sin
          // horizonte máximo) en 1–2 páginas + precarga de ≤6 anclas representativas
          // con carga puntual por fecha (concurrencia ≤3) y relleno curado Pieza 50.1.
          usExpiryCatalog = await this.getUsExpiryCatalog(
            canonicalSymbol,
            isIndex,
            spot,
            nowSec,
            baseTransport,
            warnings,
          );
          referenceContracts = usExpiryCatalog.contracts;

          const curated = selectCuratedUsExpirations(
            referenceContracts,
            spot,
            nowSec,
            options.expiration,
          );
          if (curated.reason !== null) {
            warnings.push(`US options curated expirations: ${curated.reason}`);
          }

          const anchorDates = selectAnchorUsExpirations(usExpiryCatalog.expirations, options.expiration);
          const loadDates: string[] = [];
          const pushLoadDate = (date: string | null | undefined): void => {
            if (date === null || date === undefined || date === '') return;
            if (loadDates.includes(date)) return;
            if (loadDates.length >= MAX_PRELOAD_EXPIRY_DATES) return;
            loadDates.push(date);
          };
          const requestedValid =
            options.expiration !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(options.expiration);
          if (requestedValid) {
            pushLoadDate(options.expiration);
          }
          for (const date of anchorDates) {
            pushLoadDate(date);
          }
          for (const date of curated.curatedExpirationDates) {
            pushLoadDate(date);
          }
          loadDates.sort((a, b) => a.localeCompare(b));

          if (loadDates.length > 0) {
            chainRequestedDates = [...loadDates];
            const chainResultsByDate = new Map<
              string,
              {
                readonly contracts: readonly OptionSnapshotContract[];
                readonly underlying: OptionUnderlyingSnapshot | null;
              }
            >();
            const loadExpiry = async (expirationDate: string, isPrimary: boolean): Promise<void> => {
              // Banda adaptativa al horizonte (clave para LEAPS donde 1σ supera ±25 %).
              const dteForDate = calendarDteEt(expirationDate, nowSec * 1_000);
              const horizon = Number.isFinite(dteForDate) ? dteForDate : 30;
              const bandPct =
                horizon >= 180
                  ? isPrimary
                    ? 0.45
                    : 0.3
                  : horizon >= 90
                    ? isPrimary
                      ? 0.35
                      : 0.25
                    : isPrimary
                      ? 0.25
                      : 0.15;
              const bandMin = Math.max(0.01, Math.floor(spot * (1 - bandPct) * 100) / 100);
              const bandMax = Math.ceil(spot * (1 + bandPct) * 100) / 100;
              // Referencia por fecha (del catálogo liviano) para etiquetar binarias/ajustadas.
              const referenceForDate = referenceContracts.filter(
                (c) => c.expirationDate === expirationDate,
              );
              const chainRes = await this.loadOptionChainFn({
                underlying: canonicalSymbol,
                isIndex,
                expirationDate,
                now: nowSec,
                minStrike: bandMin,
                maxStrike: bandMax,
                excludeBinary: true,
                excludeAdjusted: true,
                referenceContracts:
                  referenceForDate.length > 0 ? referenceForDate : referenceContracts,
                snapshotLimit: 250,
                maxPages: 2,
                ...baseTransport,
              });
              if (chainRes.report.providerError !== null) {
                warnings.push(
                  `options chain error (${expirationDate}): ${redactSecrets(chainRes.report.providerError.message, this.secrets)}`,
                );
              }
              // El proveedor puede devolver más fechas de las pedidas: filtrado determinista
              // por fecha exacta para fusionar sin duplicados entre cargas paralelas.
              const filteredContracts = chainRes.contracts.filter((c) => c.expirationDate === expirationDate);
              // Pieza 50.9: evidencia real de corte/error/faltante por fecha.
              chainDateReports.push({
                dateKey: expirationDate,
                kind: 'DATE',
                stoppedReason: chainRes.report.stoppedReason,
                providerError: chainRes.report.providerError !== null,
                contractCount: filteredContracts.length,
              });
              chainResultsByDate.set(expirationDate, {
                contracts: filteredContracts,
                underlying: chainRes.underlying,
              });
            };
            const loadConcurrency = 3;
            for (let i = 0; i < loadDates.length; i += loadConcurrency) {
              const batch = loadDates.slice(i, i + loadConcurrency);
              await Promise.all(batch.map((date, idx) => loadExpiry(date, i + idx === 0)));
            }
            const mergedContracts: OptionSnapshotContract[] = [];
            let mergedUnderlying: OptionUnderlyingSnapshot | null = null;
            for (const date of loadDates) {
              const res = chainResultsByDate.get(date);
              if (res === undefined) continue;
              mergedContracts.push(...res.contracts);
              if (mergedUnderlying === null && res.underlying !== null) {
                mergedUnderlying = res.underlying;
              }
            }
            contracts = mergedContracts;
            chainUnderlying = mergedUnderlying;
          } else {
            const chainRes = await this.loadOptionChainFn({
              underlying: canonicalSymbol,
              isIndex,
              minDte: 0,
              maxDte: optionMaxDte,
              now: nowSec,
              minStrike,
              maxStrike,
              excludeBinary: true,
              excludeAdjusted: true,
              referenceContracts,
              snapshotLimit: 250,
              maxPages: 4,
              ...baseTransport,
            });
            contracts = chainRes.contracts;
            chainUnderlying = chainRes.underlying;
            // Pieza 50.9: evidencia de la carga por rango DTE sin lista de fechas.
            chainDateReports.push({
              dateKey: null,
              kind: 'DTE_RANGE',
              stoppedReason: chainRes.report.stoppedReason,
              providerError: chainRes.report.providerError !== null,
              contractCount: chainRes.contracts.length,
            });
            if (chainRes.report.providerError !== null) {
              warnings.push(
                `options chain error: ${redactSecrets(chainRes.report.providerError.message, this.secrets)}`,
              );
            }
          }
        }
      } catch (err: unknown) {
        warnings.push(
          `options load skipped: ${redactSecrets(extractErrorMessage(err, 'options fetch failed'), this.secrets)}`,
        );
      }

      if (!isIndex) {
        await this.loadDividendsFn({
          ticker: toReferenceUnderlyingTicker(canonicalSymbol, false),
          limit: 12,
          maxPages: 1,
          ...baseTransport,
        }).catch(() => null);
      }
    }

    spot = resolveSpotPrice(
      chainUnderlying,
      stockByTicker.get(canonicalSymbol),
      indexByTicker.get(canonicalSymbol),
      bars5mRes.bars,
      bars1dRes.bars,
    );
    if (!Number.isFinite(spot) && v2Own !== undefined && Number.isFinite(v2Own.price) && v2Own.price > 0) {
      spot = v2Own.price;
    }

    const marketPartsEt = getMarketParts(nowSec, 'EQUITY');
    const isWeekendEt = marketPartsEt.weekday === 0 || marketPartsEt.weekday === 6;
    const anyClosedMarket =
      unifiedRes.stocks.some((s) => s.marketStatus?.toLowerCase() === 'closed') ||
      unifiedRes.indices.some((idx) => idx.marketStatus?.toLowerCase() === 'closed') ||
      [...v2StocksRes.map.values()].some((q) => q.marketStatus?.toLowerCase() === 'closed');

    // Pieza 50.9: procedencia previa al overlay Tradier (hora de cotización Massive).
    const tradierOverlay = await this.tryTradierChainOverlay(canonicalSymbol, isIndex, contracts, nowSec, warnings);
    contracts = tradierOverlay.contracts;

    const usExpirySelection = selectUsOptionExpirations(
      contracts,
      spot,
      nowSec,
      options.expiration,
    );
    if (usExpirySelection.reason !== null && usExpirySelection.defaultExpirationDate === null) {
      warnings.push(`US options expiry selection: ${usExpirySelection.reason}`);
    }
    // Pieza 50.2: `availableExpirations` expone el 100 % del catálogo (con `loaded`
    // por fecha) en lugar de solo los vencimientos ya descargados.
    const mergedAvailableExpirations = mergeUsOptionExpiryCatalog(
      usExpiryCatalog?.expirations ?? [],
      usExpirySelection.availableExpirations,
    );

    const rawOptionContracts: readonly OptionSnapshotContract[] = contracts;
    const eodQuotesRes = applyEodCloseRefQuotes(rawOptionContracts, {
      evalSecUs: nowSec,
      marketIsClosed: anyClosedMarket || isWeekendEt,
    });
    contracts = eodQuotesRes.contracts;
    const usedEodCloseRef = eodQuotesRes.usedEodCloseRef;
    const quoteMode: 'LIVE_NBBO' | 'EOD_CLOSE_REF' = usedEodCloseRef ? 'EOD_CLOSE_REF' : 'LIVE_NBBO';

    // Pieza 50.1: alineación del spot de valuación OPRA. Si el mercado está cerrado
    // (`closed`/finde/EOD_CIERRE) o el precio extendido diverge >25 bps de la paridad
    // Put-Call mediana ATM, se valúa la cadena contra el cierre RTH o el spot implícito
    // por paridad; el precio extendido queda solo como dato informativo de encabezado.
    const frontAlignmentSec = contracts
      .filter((c) => c.expirationTime > nowSec + 60)
      .reduce<number | null>(
        (min, c) => (min === null || c.expirationTime < min ? c.expirationTime : min),
        null,
      );
    const frontAlignmentContracts =
      frontAlignmentSec === null
        ? []
        : contracts.filter((c) => c.expirationTime === frontAlignmentSec);
    const frontAlignmentParity =
      frontAlignmentSec === null
        ? null
        : evaluateParityForExpiry(
            frontAlignmentSec,
            frontAlignmentContracts,
            nowSec,
            spot,
            latestTreasury,
            sofrRate,
          );
    const parityImpliedSpot =
      frontAlignmentParity !== null &&
      Number.isFinite(frontAlignmentParity.forward) &&
      frontAlignmentParity.forward > 0 &&
      Number.isFinite(frontAlignmentParity.rate) &&
      Number.isFinite(frontAlignmentParity.timeToExpiry) &&
      frontAlignmentParity.timeToExpiry > 0
        ? frontAlignmentParity.forward *
          Math.exp(-frontAlignmentParity.rate * frontAlignmentParity.timeToExpiry)
        : Number.NaN;
    const alignedSpot = resolveOpraAlignedSpot({
      feedSpot: spot,
      rthCloseSpot: resolveRthCloseSpot(bars5mRes.bars, bars1dRes.bars, nowSec),
      parityImpliedSpot,
      marketClosed: anyClosedMarket || isWeekendEt || usedEodCloseRef,
    });
    if (Number.isFinite(alignedSpot.valuationSpot) && alignedSpot.valuationSpot > 0) {
      spot = alignedSpot.valuationSpot;
    }
    if (alignedSpot.source !== 'FEED' && Number.isFinite(alignedSpot.divergenceBps)) {
      warnings.push(
        `US options spot alignment: feed=${alignedSpot.headerSpot.toFixed(4)} valuation=${alignedSpot.valuationSpot.toFixed(4)} source=${alignedSpot.source} divergence=${alignedSpot.divergenceBps.toFixed(2)}bps`,
      );
    }

    const byExpiry = new Map<number, OptionSnapshotContract[]>();
    for (const c of contracts) {
      if (c.expirationTime <= nowSec + 60) {
        continue;
      }
      const list = byExpiry.get(c.expirationTime);
      if (list !== undefined) {
        list.push(c);
      } else {
        byExpiry.set(c.expirationTime, [c]);
      }
    }
    const sortedExpiries = [...byExpiry.keys()].sort((a, b) => a - b);
    const expiryParityMap = new Map<number, ExpiryParityEvaluation>();
    const validSlices: SlicePackage[] = [];
    let ownSolvedIvContracts = 0;
    let providerFallbackIvContracts = 0;
    const contractOwnIvMap = new Map<string, number>();

    for (const expirySec of sortedExpiries) {
      const expiryContracts = byExpiry.get(expirySec);
      if (expiryContracts === undefined) {
        continue;
      }
      const evaluation = this.buildExpiryEvaluation({
        expirySec,
        expiryContracts,
        spot,
        nowSec,
        latestTreasury,
        sofrRate,
        isIndex,
        contractOwnIvMap,
        relaxShortHorizon:
          canonicalSymbol === 'GGAL' || usedEodCloseRef || anyClosedMarket || isWeekendEt,
      });
      if (evaluation === null) {
        continue;
      }
      expiryParityMap.set(expirySec, evaluation.parity);
      if (evaluation.pkg !== null) {
        validSlices.push(evaluation.pkg);
      }
    }

    const frontSlicePkg = validSlices[0];
    const firstValidParity = sortedExpiries
      .map((e) => expiryParityMap.get(e))
      .find((p): p is ExpiryParityEvaluation => p !== undefined);
    const activeFrontParity = frontSlicePkg?.parity ?? firstValidParity;
    let exposureResult: DealerExposureResult | undefined;
    let terminalExposureInputs: ExposureContractInput[] = [];
    let volSurfaceSummary: SerializedVolSurfaceSummary | null = null;
    let iv30d = Number.NaN;
    let exposureTrace: ExposureTraceMetadata | undefined;

    if (activeFrontParity !== undefined && Number.isFinite(spot) && spot > 0 && contracts.length > 0) {
      const surfaceSlices = validSlices.slice(0, 12);
      const surface =
        surfaceSlices.length > 0
          ? buildVolSurface(
              surfaceSlices.map((p) => ({
                timeToExpiry: p.parity.timeToExpiry,
                expirySec: p.parity.expirySec,
                forward: p.parity.forward,
                spot,
                rate: p.parity.rate,
                dividendYield: p.parity.dividendYield,
                quotes: p.slice.nodes.map((n) => ({
                  strike: n.strike,
                  contractType: n.strike >= p.parity.forward ? 'call' : 'put',
                  iv: n.iv,
                  bid: 1,
                  ask: 1 + n.spreadRatio,
                  openInterest: n.openInterest,
                })),
              })),
              { filter: { minPoints: 4, minOpenInterest: 1, maxSpreadRatio: 0.99 } },
            )
          : null;

      if (surface !== null && surface.slices.length >= 2) {
        const term = buildVolTermStructure(surface.slices, { omitInvalid: true });
        iv30d = interpolateTermIvAtm(term, 30 / 365);
      } else if (frontSlicePkg !== undefined) {
        iv30d = frontSlicePkg.metrics.ivAtm;
      }

      const exposureBuild = this.buildExposureInputs({
        contracts,
        expiryParityMap,
        fallbackParity: activeFrontParity,
        contractOwnIvMap,
        spot,
      });
      terminalExposureInputs = exposureBuild.inputs;
      ownSolvedIvContracts += exposureBuild.ownSolvedIvContracts;
      providerFallbackIvContracts += exposureBuild.providerFallbackIvContracts;

      exposureResult = computeDealerExposure(
        terminalExposureInputs,
        {
          spot,
          nowUtcSec: nowSec,
          rate: activeFrontParity.rate,
          dividendYield: activeFrontParity.dividendYield,
          forward: activeFrontParity.forward,
        },
        {
          model: isIndex ? 'bsm' : 'american',
          wallCriterion: 'gex',
          wallScope: 'all',
          gammaFlipHalfWidth: 0.2,
          gammaFlipGridSteps: 80,
          gammaFlipMultiRootPolicy: 'nearestSpot',
          ivResolutionMode: 'ivThenMidPrice',
          expectedMoveExpirySec: activeFrontParity.expirySec,
          ...(frontSlicePkg !== undefined
            ? { expectedMoveIvAtmOverride: frontSlicePkg.metrics.ivAtm }
            : {}),
        },
      );

      const expiryAtmIvMap = this.buildExpiryAtmIvMap(validSlices, contracts, contractOwnIvMap, spot);
      const otmIvByExpiryStrike = this.buildOtmIvByExpiryStrike(
        contracts,
        contractOwnIvMap,
        spot,
        nowSec,
      );

      // Pieza 50.1: cuota balanceada por vencimiento (front 120 + 48 por curado adicional)
      // para que todos los vencimientos lleguen al selector y a la estructura temporal.
      const serializableContracts = [...contracts].filter((c) => c.expirationTime > nowSec + 60);
      const serializableByDate = new Map<string, OptionSnapshotContract[]>();
      for (const c of serializableContracts) {
        const list = serializableByDate.get(c.expirationDate) ?? [];
        list.push(c);
        serializableByDate.set(c.expirationDate, list);
      }
      const serializableDates = [...serializableByDate.keys()].sort((a, b) => a.localeCompare(b));
      const primarySerializationDate =
        usExpirySelection.defaultExpirationDate !== null &&
        serializableByDate.has(usExpirySelection.defaultExpirationDate)
          ? usExpirySelection.defaultExpirationDate
          : (serializableDates[0] ?? null);
      const byDistanceToSpot = (a: OptionSnapshotContract, b: OptionSnapshotContract): number =>
        Math.abs(a.strikePrice - spot) - Math.abs(b.strikePrice - spot);
      const selectedForSerialization: OptionSnapshotContract[] = [];
      if (primarySerializationDate !== null) {
        const primaryList = [...(serializableByDate.get(primarySerializationDate) ?? [])].sort(
          byDistanceToSpot,
        );
        selectedForSerialization.push(...primaryList.slice(0, MAX_SERIALIZED_PRIMARY_CONTRACTS));
      }
      let serializationBudget = MAX_SERIALIZED_CONTRACTS - selectedForSerialization.length;
      for (const date of serializableDates) {
        if (date === primarySerializationDate || serializationBudget <= 0) continue;
        const list = [...(serializableByDate.get(date) ?? [])].sort(byDistanceToSpot);
        const take = Math.min(MAX_SERIALIZED_SECONDARY_CONTRACTS, serializationBudget, list.length);
        selectedForSerialization.push(...list.slice(0, take));
        serializationBudget -= take;
      }

      // Pieza 50.9: la traza se captura junto con la exposición que produjo los
      // niveles. Los tiempos de cotización son los inputs reales del motor; una
      // punta sustituida por Tradier (aunque coincida en precio/hora) cuenta como
      // desconocida, y las referencias EOD quedan fuera del rango verificable.
      const chainCoverage = summarizeChainCoverage(chainDateReports, chainRequestedDates);
      const exposureQuoteTimes = summarizeQuoteTimes(
        contracts.map((c) => {
          const substituted = tradierOverlay.quoteSubstitutedTickers.has(c.ticker);
          return {
            updatedAtSec: substituted ? null : c.lastQuote.updatedAt,
            fromOverlay: substituted,
            eodReference: eodQuotesRes.eodFixedTickers.has(c.ticker),
          };
        }),
        nowSec,
      );
      exposureTrace = buildExposureTraceMetadata({
        evaluationSec: nowSec,
        valuationSpot: alignedSpot.valuationSpot,
        valuationSpotSource: alignedSpot.source,
        headerSpot: alignedSpot.headerSpot,
        spotDivergenceBps: alignedSpot.divergenceBps,
        quoteMode,
        coverage: resolveExposureCoverage({
          evidenced: true,
          engineInputs: terminalExposureInputs.length,
          skippedContracts: exposureResult.quality.skippedContracts,
          chainTruncated: chainCoverage.chainTruncated,
          chainErrors: chainCoverage.chainErrors,
          malformedResponse: chainCoverage.malformedResponse,
          missingDatesCount: chainCoverage.missingDates.length,
          loadEvidenced: chainDateReports.length > 0,
        }),
        engineStrikes: terminalExposureInputs.map((input) => input.strike),
        engineExpirationDates: [
          ...new Set(terminalExposureInputs.map((input) => getMarketParts(input.expiryUtcSec, 'EQUITY').dateKey)),
        ].sort(),
        byStrike: exposureResult.byStrike.map((s) => s.strike),
        catalogExpirationsCount: mergedAvailableExpirations.length,
        catalogExpirationDates: mergedAvailableExpirations.map((entry) => entry.expirationDate),
        payloadContractCount: selectedForSerialization.length,
        payloadExpirationDates: [...new Set(selectedForSerialization.map((c) => c.expirationDate))].sort(),
        quoteTimes: exposureQuoteTimes,
        chainCoverage,
      });

      const serializedContracts: SerializedOptionContractRow[] = this.serializeExpiryContractRows({
        selected: selectedForSerialization.sort(
          (a, b) =>
            a.expirationTime - b.expirationTime ||
            Math.abs(a.strikePrice - spot) - Math.abs(b.strikePrice - spot),
        ),
        spot,
        nowSec,
        isIndex,
        expiryParityMap,
        fallbackParity: activeFrontParity,
        contractOwnIvMap,
        expiryAtmIvMap,
        otmIvByExpiryStrike,
      });

      const butterflyReports = surface?.butterflyReports ?? [];
      const serializedSlices = surfaceSlices.map((pkg, idx) => {
        const bf = butterflyReports[idx];
        return serializeSlice({
          ...pkg,
          isButterflyArbitrageFree: bf?.isArbitrageFree ?? pkg.isButterflyArbitrageFree,
          butterflyMinDensity: bf?.minDensity ?? Number.NaN,
        });
      });

      const forwardIvSegments = computeForwardIvTermStructure(
        serializedSlices.map((s) => ({
          expiryCode: s.expirationDate,
          expirySec: s.expirySec,
          dte: Math.max(0, Math.round(s.timeToExpiryDays)),
          timeToExpiry: s.timeToExpiryYears,
          ...(s.ivAtm !== null ? { atmIv: s.ivAtm } : {}),
        })),
      ).map((seg): SerializedForwardIvSegment => ({
        nearExpiryCode: seg.nearExpiryCode,
        farExpiryCode: seg.farExpiryCode,
        nearExpirySec: seg.nearExpirySec,
        farExpirySec: seg.farExpirySec,
        nearDte: seg.nearDte,
        farDte: seg.farDte,
        nearTimeToExpiry: seg.nearTimeToExpiry,
        farTimeToExpiry: seg.farTimeToExpiry,
        nearIv: sanitizeFinite(seg.nearIv),
        farIv: sanitizeFinite(seg.farIv),
        forwardVariance: sanitizeFinite(seg.forwardVariance),
        forwardIv: sanitizeFinite(seg.forwardIv),
        calendarArbFlag: seg.calendarArbFlag,
        status: seg.status,
      }));

      volSurfaceSummary = {
        iv30d: sanitizeFinite(iv30d),
        butterflyArbitrageFree: surface?.butterflyArbitrageFree ?? true,
        calendarArbitrageFree: surface?.calendarArbitrageFree ?? true,
        isArbitrageFree: surface?.isArbitrageFree ?? true,
        frontSlice: serializedSlices[0] ?? null,
        slices: serializedSlices,
        forwardIvSegments,
        contracts: serializedContracts,
      };

      // Pieza 50.2: las suscripciones WS priorizan el vencimiento activo/serializado
      // primario (más cercano al spot) en lugar del front cronológico.
      const primaryWsRows = serializedContracts
        .filter((c) => c.expirationDate === primarySerializationDate)
        .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
        .slice(0, MAX_WS_OPTION_CONTRACTS);
      const primaryWsTickers = new Set(primaryWsRows.map((c) => c.ticker));
      const liquidWsTickers = [
        ...primaryWsRows.map((c) => c.ticker),
        ...serializedContracts.filter((c) => !primaryWsTickers.has(c.ticker)).map((c) => c.ticker),
      ]
        .slice(0, MAX_WS_OPTION_CONTRACTS);
      void this.ensureOptionQuoteSubscriptions(liquidWsTickers);
    } else if (contracts.length === 0) {
      warnings.push('No option contracts returned or parity slice unsolvable');
    }

    const mtf = evaluateMtfStructure(
      {
        bars1d: bars1dRes.bars,
        bars4h: bars4hRes.bars,
        bars15m: bars15mRes.bars,
        bars5m: bars5mRes.bars,
      },
      { asOfUtcSec: nowSec },
    );

    const referenceLevels = resolvePreviousCompletedDayLevels(bars1dRes.bars, bars5mRes.bars, nowSec);
    const atr14dSeries = computeWilderAtrSeries(bars1dRes.bars, 14);
    const atr14d = atr14dSeries[atr14dSeries.length - 1];

    const openingAuction = evaluateOpeningAuction(bars5mRes.bars, {
      asOfUtcSec: nowSec,
      barSeconds: 300,
      ...(referenceLevels === undefined
        ? {}
        : {
            prevRthClose: referenceLevels.pdc,
            prevRthHigh: referenceLevels.pdh,
            prevRthLow: referenceLevels.pdl,
          }),
      ...(atr14d !== undefined && Number.isFinite(atr14d) && atr14d > 0 ? { atr14d } : {}),
    });

    const cvdLevels: { readonly name: string; readonly price: number }[] = [];
    if (Number.isFinite(openingAuction.pmh)) {
      cvdLevels.push({ name: 'PMH', price: openingAuction.pmh });
    }
    if (Number.isFinite(openingAuction.pml)) {
      cvdLevels.push({ name: 'PML', price: openingAuction.pml });
    }
    if (Number.isFinite(openingAuction.onPoc)) {
      cvdLevels.push({ name: 'ON_POC', price: openingAuction.onPoc });
    }
    if (referenceLevels !== undefined) {
      cvdLevels.push(
        { name: 'PDH', price: referenceLevels.pdh },
        { name: 'PDL', price: referenceLevels.pdl },
      );
    }

    const atr5mSeries = computeWilderAtrSeries(bars5mRes.bars, 14);
    const atr5m = atr5mSeries[atr5mSeries.length - 1];

    const cvdAbsorption = analyzeCvdAndAbsorption(bars5mRes.bars, {
      asOfUtcSec: nowSec,
      barSeconds: 300,
      sessionScope: 'RTH',
      levels: cvdLevels,
      ...(atr5m !== undefined && Number.isFinite(atr5m) && atr5m > 0
        ? { atr: atr5m }
        : { levelProximityPct: 0.0015 }),
    });

    const rsiDivergences = detectRsiDivergences(bars5mRes.bars, {
      asOfUtcSec: nowSec,
      barSeconds: 300,
    });

    const smtDivergences =
      corrBars5mRes.bars.length > 0
        ? detectSmtDivergences(bars5mRes.bars, corrBars5mRes.bars, {
            asOfUtcSec: nowSec,
            barSeconds: 300,
          })
        : undefined;

    const vixSnap = indexByTicker.get('I:VIX');
    const skewSnap = indexByTicker.get('I:SKEW');
    const vixLevel = resolveUnifiedIndexLevel(vixSnap);
    let skewLevel = resolveUnifiedIndexLevel(skewSnap);
    if ((!Number.isFinite(skewLevel) || skewLevel <= 0) && hasMassiveCoreData) {
      const skewBarsRes = await this.getCachedDailyBars1d('I:SKEW', 10, false);
      for (let i = skewBarsRes.bars.length - 1; i >= 0; i -= 1) {
        const b = skewBarsRes.bars[i];
        if (b !== undefined && b.time <= nowSec && Number.isFinite(b.close) && b.close > 0) {
          skewLevel = b.close;
          break;
        }
      }
    }
    const vixSeries: { readonly time: number; readonly value: number }[] = [];
    let vixBarSeconds = 86_400;
    if (vixBars1dRes !== null && vixBars1dRes.bars.length > 0) {
      for (const vb of vixBars1dRes.bars) {
        if (vb.time <= nowSec && Number.isFinite(vb.close) && vb.close > 0) {
          vixSeries.push({ time: vb.time, value: vb.close });
        }
      }
    }
    if (vixSeries.length === 0 && Number.isFinite(vixLevel) && vixLevel > 0) {
      vixSeries.push({ time: nowSec, value: vixLevel });
      vixBarSeconds = 0;
    }

    const macroVol: MacroVolatilityRegimeResult | undefined =
      vixSeries.length > 0
        ? evaluateMacroVolatilityRegime(
            {
              vix: vixSeries,
              cboeSkew: Number.isFinite(skewLevel) && skewLevel > 0 ? skewLevel : Number.NaN,
            },
            { asOfUtcSec: nowSec, vixBarSeconds },
          )
        : undefined;

    const realizedVol = computeIntradayRealizedVol(bars5mRes.bars, {
      asOfUtcSec: nowSec,
      minReturns: 12,
    });

    const confluenceSnapshot = evaluateTerminalConfluence({
      mtf,
      ...(exposureResult === undefined ? {} : { exposure: exposureResult }),
      ...(frontSlicePkg === undefined ? {} : { volMetrics: frontSlicePkg.metrics }),
      openingAuction,
      cvdAbsorption,
      rsiDivergences,
      ...(smtDivergences === undefined ? {} : { smtDivergences }),
      ...(macroVol === undefined ? {} : { macroVol }),
      realizedVol,
      ...(referenceLevels === undefined ? {} : { referenceLevels }),
      options: {
        asOfUtcSec: nowSec,
        ...(Number.isFinite(iv30d) && iv30d > 0 ? { iv30d } : {}),
      },
    });

    const sessionDate = getMarketParts(nowSec, 'EQUITY').dateKey;
    const envelope = serializeTerminalSnapshot(confluenceSnapshot, {
      symbol: canonicalSymbol,
      generatedAtUtcSec: nowSec,
      timeframe: '5m',
      sessionDate,
      asOfUtcSec: nowSec,
    });

    const cachedIvMap = this.getCachedIv30Map(
      canonicalSymbol,
      volSurfaceSummary?.iv30d ?? null,
    );
    const unifiedStockTickers = [
      ...new Set([
        ...unifiedRes.stocks.map((s) => s.ticker.toUpperCase()),
        ...v2StocksRes.map.keys(),
      ]),
    ];
    const unifiedQuotes: SerializedUnifiedQuote[] = [
      ...unifiedStockTickers.map((sym) => {
        const cached1d =
          this.daily1dCache.peek(`us1d:${sym}:265`)?.value ??
          (sym === canonicalSymbol ? bars1dRes.bars : []);
        const closed1d = cached1d.length > 0 ? normalizeClosedDailyBarsUs(cached1d, nowSec) : [];
        return resolveStockSnapshotWith1dFallback({
          ticker: sym,
          v2: v2StocksRes.map.get(sym),
          v3: stockByTicker.get(sym),
          bars1d: closed1d,
          cachedIvMap,
        });
      }),
      ...unifiedRes.indices.map((idx) => ({
        ticker: idx.ticker,
        assetType: 'index' as const,
        price: sanitizeFinite(resolveUnifiedIndexLevel(idx)),
        change: sanitizeFinite(idx.session.change),
        changePct: sanitizeFinite(idx.session.changePercent),
        previousClose: sanitizeFinite(idx.session.previousClose),
        dayLow: sanitizeFinite(idx.session.low > 0 ? idx.session.low : null),
        dayHigh: sanitizeFinite(idx.session.high > 0 ? idx.session.high : null),
        dayRangePos: null,
        volumeM: null,
        iv30d: null,
        marketStatus: idx.marketStatus,
        volume: null,
        bid: null,
        ask: null,
        bidSize: null,
        askSize: null,
        spreadPct: null,
      })),
    ];

    const r30d = interpolateLiveRate(latestTreasury, sofrRate, 30 / 365);

    // Motores Cuantitativos Institucionales Piezas 15–18 (Terminal US)
    const evalSecUs = Math.floor(nowSec);
    const closedDailyUs = normalizeClosedDailyBarsUs(bars1dRes.bars, evalSecUs);
    const closedBenchUs = normalizeClosedDailyBarsUs(
      spyBars1dRes !== null ? spyBars1dRes.bars : bars1dRes.bars,
      evalSecUs,
    );
    const atrDaily14 =
      computeWilderAtr14Us(closedDailyUs) ??
      (atr14d !== undefined && Number.isFinite(atr14d) && atr14d > 0 ? atr14d : null);
    const cvdWindow = bars5mRes.bars.slice(-24);
    let cvdDelta = 0;
    for (const b of cvdWindow) {
      cvdDelta += b.close >= b.open ? b.volume : -b.volume;
    }
    const cvdSlopeSign = cvdDelta > 0 ? 1 : cvdDelta < 0 ? -1 : 0;

    const tickSizeUs =
      Number.isFinite(spot) && spot > 0
        ? Math.max(0.01, Math.round((spot / 500) * 100) / 100)
        : 0.01;

    // Pieza 50.4: el POC/VAH/VAL se acota a las últimas 252 ruedas (1 año operativo);
    // `closedDailyUs` completo se mantiene para EMA 200, gráfico y resto de motores.
    const volumeProfileBarsUs = closedDailyUs.slice(-DEFAULT_VOLUME_PROFILE_LOOKBACK_BARS);
    const volumeProfileUs =
      volumeProfileBarsUs.length >= 2
        ? computeVolumeProfileAmt(volumeProfileBarsUs, {
            asOfUtcSec: evalSecUs,
            barSeconds: 86_400,
            tickSize: tickSizeUs,
            lookbackBars: DEFAULT_VOLUME_PROFILE_LOOKBACK_BARS,
          })
        : null;
    const nakedPocsUs =
      closedDailyUs.length >= 2
        ? trackNakedPocs(closedDailyUs, {
            asOfUtcSec: evalSecUs,
            barSeconds: 86_400,
            tickSize: tickSizeUs,
          })
        : null;
    const fvgsUs =
      closedDailyUs.length >= 5
        ? detectQuantitativeFvgs(closedDailyUs, {
            asOfUtcSec: evalSecUs,
            barSeconds: 86_400,
            tickSize: tickSizeUs,
            minRangeZScore: 1.0,
            maxLvnPercentile: 50,
            minDeltaImbalanceRatio: 0,
          })
        : null;
    const orderBlocksUs =
      closedDailyUs.length >= 8
        ? detectFreshOrderBlocks(closedDailyUs, {
            asOfUtcSec: evalSecUs,
            barSeconds: 86_400,
            minDisplacementZScore: 1.0,
            minAbsorptionVolumePercentile: 60,
            minDarkPoolShare: 0,
            anchorMode: 'HLC3',
          })
        : null;

    const relativeStrengthUs =
      closedDailyUs.length >= 2 && closedBenchUs.length >= 2
        ? evaluateRelativeStrengthAndCatalysts({
            asOfUtcSec: evalSecUs,
            assetBars: closedDailyUs.map((b) => ({ time: b.time, close: b.close })),
            benchmarkBars: closedBenchUs.map((b) => ({ time: b.time, close: b.close })),
            lookbackBars: Math.min(20, Math.max(1, closedDailyUs.length - 1)),
          })
        : null;

    let orderFlowUs: SignedOptionsOrderFlowResult | null = null;
    let agresionTicksUs: SerializedTickAggression | null = null;
    let volOiAnomaliesUs: VolOiAnomalyDetectionResult | null = null;
    let flowAdjustedGexUs: FlowAdjustedGexResult | null = null;
    let gexCharmPinUs: GexCharmPinResult | null = null;
    let wheelTrackerUs: WheelByWheelTrackerResult | null = null;
    let qDistributionUs: RiskNeutralDistributionResult | null = null;
    let pDistributionUs: EmpiricalDistributionResult | null = null;
    let pqDivergenceUs: PqLevelDivergenceResult | null = null;
    let volConeUs: VolConeAndRankResult | null = null;
    let syntheticRatesUs: SyntheticImpliedRatesResult | null = null;
    let conversionReversalUs: ConversionReversalResult | null = null;
    let buyWriteUs: BuyWriteResult | null = null;
    let calendarRollUs: CalendarRollResult | null = null;
    let confluenceClustersUs: SpatialConfluenceResult | null = null;
    let nearestInstitutionalLevelUs: SerializedNearestInstitutionalLevel | null = null;
    let structureOptimizerBullishUs: OptimizeOptionStructuresResult | null = null;
    let structureOptimizerBearishUs: OptimizeOptionStructuresResult | null = null;
    let structureCostPercentileUs: StructureCostPercentileResult | null = null;
    let volAnalyticsSuiteUs: VolAnalyticsSuiteResult | null = null;

    const evalRateUs =
      activeFrontParity !== undefined && Number.isFinite(activeFrontParity.rate)
        ? activeFrontParity.rate
        : Number.isFinite(r30d)
          ? r30d
          : 0;
    const evalDivUs =
      activeFrontParity !== undefined && Number.isFinite(activeFrontParity.dividendYield)
        ? activeFrontParity.dividendYield
        : 0;

    if (Number.isFinite(spot) && spot > 0) {
      const printsUs: OpraTradePrintInput[] = [];
      const volOiInputsUs: VolOiAnomalyContractInput[] = [];
      for (const c of contracts) {
        if (c.expirationTime <= evalSecUs) {
          continue;
        }
        const tradePx =
          Number.isFinite(c.lastTrade.price) && c.lastTrade.price > 0
            ? c.lastTrade.price
            : resolveQuoteMid(c);
        const printVolume =
          Number.isFinite(c.day.volume) && c.day.volume > 0
            ? c.day.volume
            : quoteMode === 'EOD_CLOSE_REF' &&
                Number.isFinite(c.lastTrade.size) &&
                c.lastTrade.size > 0
              ? c.lastTrade.size
              : 0;
        if (
          printVolume > 0 &&
          Number.isFinite(tradePx) &&
          tradePx > 0 &&
          Number.isFinite(c.lastQuote.bid) &&
          c.lastQuote.bid >= 0 &&
          Number.isFinite(c.lastQuote.ask) &&
          c.lastQuote.ask > 0
        ) {
          printsUs.push({
            contractTicker: c.ticker,
            underlyingTicker: canonicalSymbol,
            strike: c.strikePrice,
            expiryUtcSec: Math.floor(c.expirationTime),
            contractType: c.contractType,
            price: tradePx,
            size: printVolume,
            bid: c.lastQuote.bid,
            ask: c.lastQuote.ask,
            ...(Number.isFinite(c.day.previousClose) && c.day.previousClose > 0
              ? { prevPrice: c.day.previousClose }
              : Number.isFinite(c.day.change) && c.day.change !== 0
                ? { prevPrice: Math.max(0.0001, (Number.isFinite(c.lastTrade.price) && c.lastTrade.price > 0 ? c.lastTrade.price : resolveQuoteMid(c)) - c.day.change) }
                : {}),
            ...(Number.isFinite(c.impliedVolatility) && c.impliedVolatility > 0
              ? { impliedVolatility: c.impliedVolatility }
              : {}),
            timestampUtcSec: evalSecUs,
            sharesPerContract: c.sharesPerContract,
          });
        }
        if (
          Number.isFinite(c.day.volume) &&
          c.day.volume >= 0 &&
          Number.isFinite(c.openInterest) &&
          c.openInterest > 0
        ) {
          const ownOrProvIv = contractOwnIvMap.get(c.ticker) ?? c.impliedVolatility;
          if (Number.isFinite(ownOrProvIv) && ownOrProvIv > 0) {
            volOiInputsUs.push({
              contractTicker: c.ticker,
              strike: c.strikePrice,
              expiryUtcSec: Math.floor(c.expirationTime),
              contractType: c.contractType,
              dayVolume: c.day.volume,
              openInterest: c.openInterest,
              impliedVolatility: ownOrProvIv,
              sharesPerContract: c.sharesPerContract,
            });
          }
        }
      }

      const flowCtxUs = {
        asOfUtcSec: evalSecUs,
        spot,
        rate: evalRateUs,
        dividendYield: evalDivUs,
        model: isIndex ? ('bsm' as const) : ('american' as const),
      };

      if (printsUs.length > 0) {
        orderFlowUs = computeSignedOptionsOrderFlow(printsUs, flowCtxUs);
      }
      agresionTicksUs = computeUsOptionsTickAggression(rawOptionContracts, evalSecUs);
      if (volOiInputsUs.length >= 2) {
        volOiAnomaliesUs = detectVolOiAnomaliesMad(
          volOiInputsUs,
          flowCtxUs,
          { minVolume: 1, minOpenInterest: 1, minBucketSize: 2 },
        );
      }

      if (terminalExposureInputs.length > 0 && activeFrontParity !== undefined) {
        const expMarketUs = {
          spot,
          nowUtcSec: evalSecUs,
          rate: evalRateUs,
          dividendYield: evalDivUs,
          forward: activeFrontParity.forward,
        };
        flowAdjustedGexUs = computeFlowAdjustedSignedGex(
          terminalExposureInputs,
          expMarketUs,
          orderFlowUs?.byStrikeFlow ?? [],
        );
        gexCharmPinUs = computeGexCharmPin(terminalExposureInputs, expMarketUs, { maxPinDte: 14 });
        const gammaFlipVal =
          exposureResult !== undefined && Number.isFinite(exposureResult.gammaFlipSpot)
            ? exposureResult.gammaFlipSpot
            : spot;
        const pinVal = Number.isFinite(gexCharmPinUs.gexCharmPinStrike)
          ? gexCharmPinUs.gexCharmPinStrike
          : spot;
        const histList = this.wheelHistoryBySymbol.get(canonicalSymbol) ?? [];
        const prevSnap = histList[histList.length - 1];
        if (prevSnap === undefined || prevSnap.timestampUtcSec !== evalSecUs) {
          histList.push({
            timestampUtcSec: evalSecUs,
            spot,
            gammaFlip: gammaFlipVal,
            gexCharmPin: pinVal,
            netDeltaShares: orderFlowUs?.netDeltaShares ?? 0,
          });
          if (histList.length > 120) {
            histList.splice(0, histList.length - 120);
          }
          this.wheelHistoryBySymbol.set(canonicalSymbol, histList);
        }
        wheelTrackerUs = evaluateWheelByWheelTracker(histList, evalSecUs);
      }

      // Q vs P + Cono de Volatilidad
      const frontSlice = validSlices[0];
      const frontContractsUs =
        frontSlice !== undefined
          ? contracts.filter((c) => c.expirationTime === frontSlice.parity.expirySec)
          : [];
      const qNodeMap = new Map<number, RiskNeutralInputNode>();
      for (const c of frontContractsUs) {
        const ivVal = contractOwnIvMap.get(c.ticker) ?? c.impliedVolatility;
        if (Number.isFinite(ivVal) && ivVal > 0 && ivVal < IV_CAP_DECIMAL) {
          const isOtmSide =
            (c.strikePrice >= spot && c.contractType === 'call') ||
            (c.strikePrice < spot && c.contractType === 'put');
          if (!qNodeMap.has(c.strikePrice) || isOtmSide) {
            const bid = Number.isFinite(c.lastQuote.bid) && c.lastQuote.bid > 0 ? c.lastQuote.bid : null;
            const ask = Number.isFinite(c.lastQuote.ask) && c.lastQuote.ask > 0 ? c.lastQuote.ask : null;
            qNodeMap.set(c.strikePrice, {
              strike: c.strikePrice,
              iv: ivVal,
              bid,
              ...(ask !== null ? { ask } : {}),
            });
          }
        }
      }
      const frontDteEt =
        frontSlice !== undefined
          ? calendarDteEt(frontSlice.parity.expirationDate, evalSecUs * 1_000)
          : Number.NaN;
      const frontDteCalendar = Number.isFinite(frontDteEt)
        ? frontDteEt
        : frontSlice !== undefined
          ? Math.max(0, Math.round((frontSlice.parity.expirySec - evalSecUs) / 86_400))
          : 21;
      const qNodesUs = [...qNodeMap.values()].sort((a, b) => a.strike - b.strike);
      if (frontSlice !== undefined && qNodesUs.length >= 5) {
        const liquidBidCount = qNodesUs.filter(
          (n) => n.bid !== null && n.bid !== undefined && n.bid > 0,
        ).length;
        const frontTForQ = Math.max(MIN_EXPECTED_MOVE_T_YEARS, frontSlice.parity.timeToExpiry);
        const frontEm = expectedMoveSigma(spot, frontSlice.metrics.ivAtm, frontTForQ);
        qDistributionUs = extractRiskNeutralDistributionQ({
          spot,
          rate: evalRateUs,
          dividendYield: evalDivUs,
          timeToExpiry: frontTForQ,
          nodes: qNodesUs,
          smoothTotalVariancePchip: true,
          requirePositiveBid: liquidBidCount >= 5,
          dte: frontDteCalendar,
          ...(Number.isFinite(frontEm) ? { expectedMove: frontEm } : {}),
          smoothShortDteDensity: true,
        });
      }

      const frontDteUs = Math.max(1, frontDteCalendar);
      if (closedDailyUs.length >= frontDteUs + 5) {
        pDistributionUs = analyzeEmpiricalDistributionP(
          closedDailyUs.map((b) => ({ time: b.time, open: b.open, close: b.close })),
          {
            asOfUtcSec: evalSecUs,
            spot,
            horizonDays: frontDteUs,
            dailyRiskFreeRate: evalRateUs / 252,
            minHistoryBars: frontDteUs + 2,
          },
        );
      }

      if (
        qDistributionUs !== null &&
        qDistributionUs.status === 'OK' &&
        pDistributionUs !== null &&
        pDistributionUs.status === 'OK'
      ) {
        const targetsUs = [
          ...(exposureResult !== undefined && Number.isFinite(exposureResult.callWallStrike)
            ? [{ label: 'Call Wall', price: exposureResult.callWallStrike, direction: 'ABOVE' as const }]
            : []),
          ...(exposureResult !== undefined && Number.isFinite(exposureResult.putWallStrike)
            ? [{ label: 'Put Wall', price: exposureResult.putWallStrike, direction: 'BELOW' as const }]
            : []),
          { label: '+5% Upside', price: spot * 1.05, direction: 'ABOVE' as const },
          { label: '-5% Downside', price: spot * 0.95, direction: 'BELOW' as const },
        ];
        pqDivergenceUs = evaluatePqLevelDivergence({
          spot,
          qDistribution: qDistributionUs,
          pDistribution: pDistributionUs,
          targetLevels: targetsUs,
        });
      }

      const rollingRvUs: number[] = [];
      for (let i = 21; i <= closedDailyUs.length; i += 1) {
        const rv = computeDailyRealizedVolUs(closedDailyUs.slice(i - 21, i), 20);
        if (rv !== null && Number.isFinite(rv) && rv > 0) {
          rollingRvUs.push(rv);
        }
      }
      const resolvedFrontIvUs =
        Number.isFinite(iv30d) && iv30d > 0
          ? iv30d
          : frontSlice !== undefined && Number.isFinite(frontSlice.metrics.ivAtm)
            ? frontSlice.metrics.ivAtm
            : Number.NaN;
      if (Number.isFinite(resolvedFrontIvUs) && resolvedFrontIvUs > 0) {
        volConeUs = computeVolConeAndRank({
          spot,
          ivAtm: resolvedFrontIvUs,
          horizonsDays: [5, 10, 20, 30, 60],
          ivHistory: rollingRvUs,
          minIvHistoryCount: 5,
        });
      }

      // Tasas Sintéticas, Conversion/Reversal, Buy-Write, Calendar Roll
      if (frontSlice !== undefined && frontContractsUs.length > 0) {
        const frontT = Math.max(1 / 365, frontSlice.parity.timeToExpiry);
        const callMap = new Map<number, OptionSnapshotContract>();
        const putMap = new Map<number, OptionSnapshotContract>();
        for (const c of frontContractsUs) {
          if (c.contractType === 'call') callMap.set(c.strikePrice, c);
          else putMap.set(c.strikePrice, c);
        }
        const synthPairs: { strike: number; callMid: number; putMid: number }[] = [];
        for (const [k, cRow] of callMap.entries()) {
          const pRow = putMap.get(k);
          if (pRow !== undefined) {
            const cM = resolveQuoteMid(cRow);
            const pM = resolveQuoteMid(pRow);
            if (Number.isFinite(cM) && cM > 0 && Number.isFinite(pM) && pM > 0) {
              synthPairs.push({ strike: k, callMid: cM, putMid: pM });
            }
          }
        }
        if (synthPairs.length > 0) {
          syntheticRatesUs = computeSyntheticImpliedRates({
            spot,
            riskFreeRate: evalRateUs,
            dividendYield: evalDivUs,
            timeToExpiry: frontT,
            dte: frontDteCalendar,
            pairs: synthPairs,
          });
        }

        const atmStrike = [...callMap.keys()].sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot))[0];
        if (atmStrike !== undefined) {
          const cAtm = callMap.get(atmStrike);
          const pAtm = putMap.get(atmStrike);
          if (
            cAtm !== undefined &&
            pAtm !== undefined &&
            cAtm.lastQuote.bid > 0 &&
            cAtm.lastQuote.ask >= cAtm.lastQuote.bid &&
            pAtm.lastQuote.bid > 0 &&
            pAtm.lastQuote.ask >= pAtm.lastQuote.bid
          ) {
            conversionReversalUs = evaluateConversionReversal({
              strike: atmStrike,
              timeToExpiry: frontT,
              riskFreeTna: Math.max(0, Math.exp(evalRateUs) - 1),
              spotBid: spot,
              spotAsk: spot,
              callBid: cAtm.lastQuote.bid,
              callAsk: cAtm.lastQuote.ask,
              putBid: pAtm.lastQuote.bid,
              putAsk: pAtm.lastQuote.ask,
              stockFeeRate: 0.0005,
              optionFeeRate: 0.002,
              vatRate: 0,
              dte: frontDteCalendar,
            });
          }
        }

        const otmCallUs = [...callMap.values()]
          .filter((c) => c.strikePrice >= spot && c.lastQuote.bid > 0)
          .sort((a, b) => a.strikePrice - b.strikePrice)[0];
        if (otmCallUs !== undefined) {
          buyWriteUs = evaluateBuyWrite({
            spotAsk: spot,
            strike: otmCallUs.strikePrice,
            callBid: otmCallUs.lastQuote.bid,
            timeToExpiry: frontT,
            stockFeeRate: 0.0005,
            optionFeeRate: 0.002,
            vatRate: 0,
            dte: frontDteCalendar,
          });
        }

        const secondSlice = validSlices[1];
        if (secondSlice !== undefined && secondSlice.parity.timeToExpiry > frontT) {
          const farContracts = contracts.filter(
            (c) => c.expirationTime === secondSlice.parity.expirySec && c.contractType === 'call',
          );
          const farByStrike = new Map(farContracts.map((c) => [c.strikePrice, c]));
          const nearMatch = [...callMap.values()]
            .filter((c) => {
              const far = farByStrike.get(c.strikePrice);
              return (
                c.lastQuote.ask > 0 &&
                far !== undefined &&
                far.lastQuote.bid > 0
              );
            })
            .sort((a, b) => Math.abs(a.strikePrice - spot) - Math.abs(b.strikePrice - spot))[0];
          if (nearMatch !== undefined) {
            const farMatch = farByStrike.get(nearMatch.strikePrice);
            const nearS = volSurfaceSummary?.contracts.find((sc) => sc.ticker === nearMatch.ticker);
            const farS = farMatch !== undefined ? volSurfaceSummary?.contracts.find((sc) => sc.ticker === farMatch.ticker) : undefined;
            if (
              farMatch !== undefined &&
              nearS?.thetaDaily !== null &&
              nearS?.thetaDaily !== undefined &&
              nearS.vegaPer1Pct !== null &&
              farS?.thetaDaily !== null &&
              farS?.thetaDaily !== undefined &&
              farS.vegaPer1Pct !== null
            ) {
              calendarRollUs = evaluateCalendarRoll({
                spot,
                strike: nearMatch.strikePrice,
                nearAsk: nearMatch.lastQuote.ask,
                farBid: farMatch.lastQuote.bid,
                nearTimeToExpiry: frontT,
                farTimeToExpiry: secondSlice.parity.timeToExpiry,
                nearThetaDaily: nearS.thetaDaily,
                farThetaDaily: farS.thetaDaily,
                nearVegaPer1Pct: nearS.vegaPer1Pct,
                farVegaPer1Pct: farS.vegaPer1Pct,
                optionFeeRate: 0.002,
                vatRate: 0,
              });
            }
          }
        }
      }

      // Confluencias Espaciales < 0.15 ATR + Optimizador "Las 3 Maneras de Jugarla" (Pieza 18)
      const confLevels: SpatialLevelInput[] = [];
      if (volumeProfileUs !== null && volumeProfileUs.status === 'OK') {
        confLevels.push(
          { name: 'POC', category: 'AMT_VOLUME_PROFILE', price: volumeProfileUs.poc, expectedReaction: 'MAGNET_NEUTRAL' },
          { name: 'VAH', category: 'AMT_VOLUME_PROFILE', price: volumeProfileUs.vah, expectedReaction: 'RESISTANCE_BEARISH' },
          { name: 'VAL', category: 'AMT_VOLUME_PROFILE', price: volumeProfileUs.val, expectedReaction: 'SUPPORT_BULLISH' },
          { name: 'AVWAP', category: 'AMT_VOLUME_PROFILE', price: volumeProfileUs.profileVwap, expectedReaction: 'MAGNET_NEUTRAL' },
        );
      }
      if (nakedPocsUs !== null && nakedPocsUs.status === 'OK') {
        for (const np of nakedPocsUs.activeNakedPocs.slice(-3)) {
          confLevels.push({
            name: `Naked POC (${np.sessionDate})`,
            category: 'AMT_VOLUME_PROFILE',
            price: np.sessionPoc,
            expectedReaction: np.sessionPoc >= spot ? 'RESISTANCE_BEARISH' : 'SUPPORT_BULLISH',
          });
        }
      }
      if (fvgsUs !== null && fvgsUs.status === 'OK') {
        for (const fvg of fvgsUs.activeFvgs.slice(-4)) {
          confLevels.push({
            name: fvg.type === 'BULLISH_FVG' ? 'FVG Bull CE' : 'FVG Bear CE',
            category: 'MICROSTRUCTURE_FVG_FOB',
            price: fvg.consequentEncroachment,
            expectedReaction: fvg.type === 'BULLISH_FVG' ? 'SUPPORT_BULLISH' : 'RESISTANCE_BEARISH',
          });
        }
      }
      if (orderBlocksUs !== null && orderBlocksUs.status === 'OK') {
        for (const fob of orderBlocksUs.freshOrderBlocks.slice(-4)) {
          confLevels.push({
            name: fob.type === 'BULLISH_FOB' ? 'Fresh OB Bull' : 'Fresh OB Bear',
            category: 'MICROSTRUCTURE_FVG_FOB',
            price: fob.anchorPrice,
            expectedReaction: fob.type === 'BULLISH_FOB' ? 'SUPPORT_BULLISH' : 'RESISTANCE_BEARISH',
          });
        }
      }
      if (exposureResult !== undefined && Number.isFinite(exposureResult.callWallStrike)) {
        confLevels.push({ name: 'Call Wall', category: 'OPTIONS_DEALER', price: exposureResult.callWallStrike, expectedReaction: 'RESISTANCE_BEARISH' });
      }
      if (exposureResult !== undefined && Number.isFinite(exposureResult.putWallStrike)) {
        confLevels.push({ name: 'Put Wall', category: 'OPTIONS_DEALER', price: exposureResult.putWallStrike, expectedReaction: 'SUPPORT_BULLISH' });
      }
      if (exposureResult !== undefined && Number.isFinite(exposureResult.gammaFlipSpot)) {
        confLevels.push({ name: 'Gamma Flip', category: 'OPTIONS_DEALER', price: exposureResult.gammaFlipSpot, expectedReaction: 'MAGNET_NEUTRAL' });
      }
      if (gexCharmPinUs !== null && Number.isFinite(gexCharmPinUs.gexCharmPinStrike)) {
        confLevels.push({ name: 'GEX/Charm Pin', category: 'OPTIONS_DEALER', price: gexCharmPinUs.gexCharmPinStrike, expectedReaction: 'MAGNET_NEUTRAL' });
      }

      const flowSignUs =
        orderFlowUs !== null
          ? orderFlowUs.netDeltaShares > 0
            ? 1
            : orderFlowUs.netDeltaShares < 0
              ? -1
              : 0
          : 0;
      if (atrDaily14 !== null && atrDaily14 > 0 && confLevels.length > 0) {
        const strictConf = detectSpatialConfluenceClusters({
          spot,
          atr: atrDaily14,
          levels: confLevels,
          trigger: {
            cvdSlopeSign,
            optionsDeltaFlowSign: flowSignUs,
          },
        });
        confluenceClustersUs =
          strictConf.clusters.length > 0
            ? strictConf
            : detectSpatialConfluenceClusters({
                spot,
                atr: atrDaily14,
                clusterRadiusAtr: 0.35,
                levels: confLevels,
                trigger: {
                  cvdSlopeSign,
                  optionsDeltaFlowSign: flowSignUs,
                },
              });
      }

      if (Number.isFinite(spot) && spot > 0 && confLevels.length > 0) {
        let bestLevel: SpatialLevelInput | null = null;
        let bestDistAbs = Number.POSITIVE_INFINITY;
        for (const lvl of confLevels) {
          if (!Number.isFinite(lvl.price) || lvl.price <= 0) {
            continue;
          }
          const dAbs = Math.abs(lvl.price - spot);
          if (dAbs < bestDistAbs) {
            bestDistAbs = dAbs;
            bestLevel = lvl;
          }
        }
        if (bestLevel !== null && Number.isFinite(bestDistAbs)) {
          const distPct = ((bestLevel.price - spot) / spot) * 100;
          const distAtr =
            atrDaily14 !== null && atrDaily14 > 0 ? bestDistAbs / atrDaily14 : null;
          nearestInstitutionalLevelUs = {
            name: bestLevel.name,
            category: bestLevel.category,
            price: bestLevel.price,
            distanceAbs: bestDistAbs,
            distancePct: distPct,
            distanceAtr: distAtr,
            side: bestLevel.price > spot ? 'ABOVE' : bestLevel.price < spot ? 'BELOW' : 'AT_SPOT',
            clusterRadiusAtrUsed: confluenceClustersUs?.clusterRadiusAtr ?? null,
          };
        }
      }

      if (
        frontSlice !== undefined &&
        pDistributionUs !== null &&
        pDistributionUs.status === 'OK' &&
        pDistributionUs.projectedTerminalPrices.length >= 2 &&
        volSurfaceSummary !== null
      ) {
        const frontContractRows = volSurfaceSummary.contracts.filter(
          (sc) => sc.expiryUtcSec === frontSlice.parity.expirySec,
        );
        const optInputs: OptimizerOptionContractInput[] = [];
        for (const sc of frontContractRows) {
          const ivVal = sc.ownIv ?? sc.providerIv;
          if (
            sc.bid !== null &&
            sc.bid > 0 &&
            sc.ask !== null &&
            sc.ask >= sc.bid &&
            sc.delta !== null &&
            Number.isFinite(sc.delta) &&
            ivVal !== null &&
            ivVal > 0
          ) {
            optInputs.push({
              strike: sc.strike,
              contractType: sc.contractType,
              bid: sc.bid,
              ask: sc.ask,
              delta: sc.delta,
              iv: ivVal,
            });
          }
        }
        if (optInputs.length >= 2) {
          const proj = [...pDistributionUs.projectedTerminalPrices].sort((a, b) => a - b);
          const minP = proj[0];
          const maxP = proj[proj.length - 1];
          if (minP !== undefined && maxP !== undefined && maxP > minP) {
            const binsCount = Math.min(20, Math.max(8, Math.floor(Math.sqrt(proj.length))));
            const step = (maxP - minP) / binsCount;
            const terminalPrices: number[] = [];
            const empiricalProbs: number[] = [];
            for (let bIdx = 0; bIdx < binsCount; bIdx += 1) {
              const loE = minP + bIdx * step;
              const hiE = bIdx === binsCount - 1 ? maxP + 1e-9 : loE + step;
              const cnt = proj.filter((v) => v >= loE && v < hiE).length;
              if (cnt > 0) {
                terminalPrices.push(loE + 0.5 * step);
                empiricalProbs.push(cnt / proj.length);
              }
            }
            if (terminalPrices.length >= 2) {
              const lotUs = frontContractsUs[0]?.sharesPerContract ?? 100;
              structureOptimizerBullishUs = optimizeOptionStructures({
                spot,
                targetPrice: spot * 1.06,
                direction: 'BULLISH',
                dte: frontDteCalendar,
                lotSize: lotUs,
                contracts: optInputs,
                terminalPrices,
                empiricalProbs,
                feeRate: 0.002,
                vatRate: 0,
              });
              structureOptimizerBearishUs = optimizeOptionStructures({
                spot,
                targetPrice: spot * 0.94,
                direction: 'BEARISH',
                dte: frontDteCalendar,
                lotSize: lotUs,
                contracts: optInputs,
                terminalPrices,
                empiricalProbs,
                feeRate: 0.002,
                vatRate: 0,
              });
              const refBest =
                structureOptimizerBullishUs.bestByExpectedValue ??
                structureOptimizerBullishUs.bestByPop ??
                structureOptimizerBullishUs.candidates[0] ??
                null;
              if (
                refBest !== null &&
                Number.isFinite(refBest.costPctOfWidth) &&
                rollingRvUs.length >= 10 &&
                Number.isFinite(resolvedFrontIvUs) &&
                resolvedFrontIvUs > 0
              ) {
                structureCostPercentileUs = computeStructureCostPercentile({
                  currentCostPctOfWidth: refBest.costPctOfWidth,
                  historicalCostPctSeries: rollingRvUs.map((rv) => refBest.costPctOfWidth * (rv / resolvedFrontIvUs)),
                });
              }
            }
          }
        }
      }
    }

    const underlyingQuoteSnap = stockByTicker.get(canonicalSymbol);
    const underlyingBidUs =
      underlyingQuoteSnap?.lastQuote !== null &&
      underlyingQuoteSnap?.lastQuote !== undefined &&
      Number.isFinite(underlyingQuoteSnap.lastQuote.bid) &&
      underlyingQuoteSnap.lastQuote.bid > 0
        ? underlyingQuoteSnap.lastQuote.bid
        : spot;
    const underlyingAskUs =
      underlyingQuoteSnap?.lastQuote !== null &&
      underlyingQuoteSnap?.lastQuote !== undefined &&
      Number.isFinite(underlyingQuoteSnap.lastQuote.ask) &&
      underlyingQuoteSnap.lastQuote.ask > 0
        ? underlyingQuoteSnap.lastQuote.ask
        : spot;
    const deltaByTickerUs = new Map<string, number | null>(
      (volSurfaceSummary?.contracts ?? []).map((sc) => [sc.ticker, sc.delta]),
    );
    volAnalyticsSuiteUs = this.buildUsVolAnalyticsSuite({
      canonicalSymbol,
      spot,
      spotBid: underlyingBidUs,
      spotAsk: underlyingAskUs,
      evalRateUs,
      evalDivUs,
      sofrRate,
      r30d,
      nowSec: evalSecUs,
      closedDailyUs,
      contracts,
      contractOwnIvMap,
      deltaByTicker: deltaByTickerUs,
      validSlices,
      expiryParityMap,
      qDistributionFront: qDistributionUs,
      putWallStrike: exposureResult?.putWallStrike ?? flowAdjustedGexUs?.putWallStrike ?? null,
      netGex: exposureResult?.netGex ?? null,
    });

    const terminalEngines: SerializedTerminalEngines = sanitizeJsonValue({
      atr14d: sanitizeFinite(atrDaily14),
      cvdSlopeSign,
      volumeProfile: volumeProfileUs,
      nakedPocs: nakedPocsUs,
      fvgs: fvgsUs,
      orderBlocks: orderBlocksUs,
      orderFlow:
        orderFlowUs !== null
          ? {
              ...orderFlowUs,
              agresionTicks: agresionTicksUs,
            }
          : null,
      agresionTicks: agresionTicksUs,
      volOiAnomalies: volOiAnomaliesUs,
      flowAdjustedGex: flowAdjustedGexUs,
      gexCharmPin: gexCharmPinUs,
      wheelTracker: wheelTrackerUs,
      qDistribution: qDistributionUs,
      pDistribution: pDistributionUs,
      pqDivergence: pqDivergenceUs,
      volCone: volConeUs,
      syntheticRates: syntheticRatesUs,
      conversionReversal: conversionReversalUs,
      buyWrite: buyWriteUs,
      calendarRoll: calendarRollUs,
      relativeStrength: relativeStrengthUs,
      confluenceClusters: confluenceClustersUs,
      nearestInstitutionalLevel: nearestInstitutionalLevelUs,
      structureOptimizerBullish: structureOptimizerBullishUs,
      structureOptimizerBearish: structureOptimizerBearishUs,
      structureCostPercentile: structureCostPercentileUs,
      volAnalyticsSuite: volAnalyticsSuiteUs,
    });

    const feedMode: 'LIVE' | 'EOD_CIERRE' | 'PARTIAL' | 'NO_DATA' =
      anyClosedMarket ||
      usedEodCloseRef ||
      isWeekendEt ||
      (bars1dRes.bars.length > 0 && unifiedRes.stocks.length === 0 && unifiedRes.indices.length === 0 && v2StocksRes.map.size === 0)
        ? 'EOD_CIERRE'
        : envelope.envelopeStatus === 'OK' && warnings.length === 0
          ? 'LIVE'
          : 'PARTIAL';

    if (canonicalSymbol === 'SPY' && this.usPanelCache.peek('us:equity:panel') === undefined && hasMassiveCoreData) {
      void this.getUsEquityPanelAnalytics(false).catch(() => {});
    }

    const rateDecToPct = (dec: number | undefined): number | null =>
      dec !== undefined && Number.isFinite(dec) ? dec * 100 : null;

    const cachedEarnings = this.earningsCatalystCache.peek(`fmp:earnings:${canonicalSymbol}`)?.value;
    const cachedMacro = this.macroCalendarCache.peek('fmp:macro-calendar:us')?.value;
    const cachedCatalysts: SerializedSymbolCatalystsDto | null =
      cachedEarnings !== undefined || cachedMacro !== undefined
        ? {
            symbol: canonicalSymbol,
            asOfUtcSec: nowSec,
            available: Boolean(cachedEarnings?.available || cachedMacro?.available),
            nextEarnings: cachedEarnings?.nextEarnings ?? null,
            lastEarnings: cachedEarnings?.lastEarnings ?? null,
            macroEvents: cachedMacro?.events ?? [],
            earningsSource: cachedEarnings?.source ?? null,
            macroSource: cachedMacro?.source ?? null,
            reason: cachedEarnings?.reason ?? cachedMacro?.reason ?? null,
          }
        : null;

    const response: TerminalSnapshotResponse = {
      status: envelope.envelopeStatus === 'OK' && warnings.length === 0 ? 'OK' : 'PARTIAL',
      feedMode,
      quoteMode,
      symbol: canonicalSymbol,
      correlatedSymbol,
      isIndex,
      asOfUtcSec: nowSec,
      envelope,
      exposureSummary: exposureResult === undefined ? null : serializeExposure(exposureResult, exposureTrace),
      volSurfaceSummary,
      openingAuction: serializeOpeningAuction(openingAuction, atr14d),
      microstructure: serializeMicrostructure({
        mtf,
        cvd: cvdAbsorption,
        rsiDiv: rsiDivergences,
        smtDiv: smtDivergences,
        correlatedSymbol,
      }),
      marketContext: {
        unifiedQuotes,
        treasury: {
          date: latestTreasury?.date ?? null,
          yield1M: rateDecToPct(latestTreasury?.yield1Month),
          yield3M: rateDecToPct(latestTreasury?.yield3Month),
          yield1Y: rateDecToPct(latestTreasury?.yield1Year),
          yield2Y: rateDecToPct(latestTreasury?.yield2Year),
          yield10Y: rateDecToPct(latestTreasury?.yield10Year),
          sofr: rateDecToPct(sofrRate),
          rate30d: sanitizeFinite(r30d),
          dividendYieldFront: sanitizeFinite(frontSlicePkg?.parity.dividendYield),
        },
        vixLevel: sanitizeFinite(macroVol?.vixLevel ?? vixLevel),
        vixSlope: sanitizeFinite(macroVol?.vixSlope),
        vixRegime: macroVol?.vixRegime ?? 'NO_DATA',
        skewLevel: sanitizeFinite(skewLevel),
        tailRiskAlert: macroVol?.tailRiskAlert ?? null,
      },
      terminalEngines,
      benchmarkBars1d: (canonicalSymbol === 'SPY' ? bars1dRes.bars : spyBars1dRes?.bars ?? [])
        .slice(-120)
        .map(serializeBar),
      usEquityPanel: this.usPanelCache.peek('us:equity:panel')?.value ?? null,
      ...(cachedCatalysts !== null ? { catalysts: cachedCatalysts } : {}),
      ...(tradierOverlay.summary !== null
        ? {
            usOptionsFeed: {
              provider:
                tradierOverlay.summary.tradierContracts > 0 &&
                tradierOverlay.summary.matchedByOcc + tradierOverlay.summary.matchedByStrikeType > 0
                  ? ('TRADIER' as const)
                  : ('MASSIVE' as const),
              badge:
                tradierOverlay.summary.tradierContracts > 0 &&
                tradierOverlay.summary.matchedByOcc + tradierOverlay.summary.matchedByStrikeType > 0
                  ? ('TRADIER LIVE + ORATS' as const)
                  : ('MASSIVE + ORATS' as const),
              tradierOverlay: tradierOverlay.summary,
            },
          }
        : {}),
      optionsChain: {
        selectedExpirationDate: usExpirySelection.defaultExpirationDate,
        selectionReason: usExpirySelection.reason,
        prefetchExpirationDates: usExpirySelection.prefetchExpirationDates,
        availableExpirations: mergedAvailableExpirations,
      },
      dataQuality: {
        ownSolvedIvContracts,
        providerFallbackIvContracts,
        parityExpiries: expiryParityMap.size,
        chainContractsReceived: contracts.length,
        chainContractsUsable: exposureResult?.quality.usableContracts ?? 0,
        warnings,
      },
    };

    assertJsonSafeSerialized(response);
    return response;
  }

  /**
   * Pieza 50.2: carga on-demand el cuantitativo completo de un vencimiento OPRA exacto
   * (`GET /api/options/expiry`). Reusa el contexto liviano cacheado (spot/quote, curva
   * Treasury, SOFR, barras 1D cerradas) sin recalcular barras intradía/MTF/FVG/macro,
   * con caché dedicada por fecha (TTL dinámico ET: 15 s en RTH / 60 s fuera de RTH) y
   * single-flight para evitar ráfagas duplicadas al clicar rápido.
   */
  public async getUsOptionExpiryChain(
    rawSymbol: string,
    rawExpirationDate: string,
    options: { readonly forceRefresh?: boolean } = {},
  ): Promise<UsOptionExpiryChainResponse> {
    const parsed = parseTerminalSymbol(rawSymbol, this.secrets);
    const expirationDate = rawExpirationDate.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expirationDate) || parseExpirationDate(expirationDate) === null) {
      throw new RuntimeNoDataError(
        'INVALID_PARAMETER',
        `Parameter "expiration" must be a valid YYYY-MM-DD date (got "${rawExpirationDate}")`,
        this.secrets,
        400,
      );
    }
    if (!Number.isFinite(calendarDteEt(expirationDate, this.nowMsFn()))) {
      throw new RuntimeNoDataError(
        'INVALID_PARAMETER',
        `Parameter "expiration" must not be in the past (got "${expirationDate}")`,
        this.secrets,
        400,
      );
    }
    const cacheKey = `us:expiry-chain:${parsed.canonicalSymbol}:${expirationDate}`;
    const result = await this.usExpiryChainCache.getOrCompute(
      cacheKey,
      () => this.computeUsOptionExpiryChain(parsed, expirationDate),
      options.forceRefresh === undefined ? {} : { forceRefresh: options.forceRefresh },
    );
    return result.value;
  }

  /**
   * Pieza 50.2: pipeline REST acotado a UNA fecha (referencia de binarias/ajustadas de
   * esa fecha + snapshot de la cadena con banda de strikes adaptativa al DTE + overlay
   * Tradier exclusivo de esa fecha), cuantitativo completo (paridad, slice/Skew,
   * griegas, exposición de dealers, tasas sintéticas y suite de volatilidad con el DTE
   * calendario ET exacto) y priorización de los 40 contratos ATM más líquidos en el WS.
   */
  private async computeUsOptionExpiryChain(
    parsed: ParsedSymbol,
    expirationDate: string,
  ): Promise<UsOptionExpiryChainResponse> {
    const apiKey = this.assertRestApiKey();
    const nowSec = Math.floor(this.nowMsFn() / 1_000);
    const { canonicalSymbol, correlatedSymbol, isIndex } = parsed;
    const warnings: string[] = [];
    const macroDateGte = addCalendarDaysEt(nowSec, -35);
    const unifiedTickers = [
      ...new Set([
        canonicalSymbol,
        correlatedSymbol,
        ...US_EQUITY_UNIVERSE.map((u) => u.symbol),
        'TLT',
        'HYG',
        'LQD',
        'XLY',
        'I:SPX',
        'I:VIX',
        'I:SKEW',
        'I:VVIX',
        'I:OVX',
        'I:DXY',
      ]),
    ];
    const baseTransport = {
      apiKey,
      fetchFn: this.fetchFn,
      ...(this.baseUrl === undefined ? {} : { baseUrl: this.baseUrl }),
    };

    // Contexto liviano: caches compartidas con el snapshot principal (treasury/SOFR/
    // unified) + barras 1D cerradas para tablas de RV y VRP del vencimiento puntual.
    const [treasuryRes, fundingRes, unifiedRes, bars1dRes] = await Promise.all([
      this.treasuryCache
        .getOrCompute(`treasury:${macroDateGte}`, () =>
          this.loadTreasuryYieldsFn({ ...baseTransport, dateGte: macroDateGte, limit: 100, maxPages: 1 }),
        )
        .then((r) => r.value),
      this.fundingCache
        .getOrCompute(`funding:${macroDateGte}`, () =>
          this.loadFundingConditionsFn({ ...baseTransport, dateGte: macroDateGte, limit: 100, maxPages: 1 }),
        )
        .then((r) => r.value),
      this.unifiedCache
        .getOrCompute(`unified:${[...new Set(unifiedTickers)].sort().join(',')}`, () =>
          this.loadUnifiedSnapshotFn({ ...baseTransport, tickers: unifiedTickers, limit: 250, maxPages: 1 }),
        )
        .then((r) => r.value),
      this.loadBarsFn({
        provider: 'massive',
        symbol: canonicalSymbol,
        timeframe: '1D',
        visibleBars: 260,
        warmupBars: 0,
        maxPages: 3,
        now: nowSec,
        ...baseTransport,
      }),
    ]);

    const stockByTicker = new Map(unifiedRes.stocks.map((s) => [s.ticker, s]));
    const indexByTicker = new Map(unifiedRes.indices.map((idx) => [idx.ticker, idx]));
    let spot = resolveSpotPrice(
      null,
      stockByTicker.get(canonicalSymbol),
      indexByTicker.get(canonicalSymbol),
      [],
      bars1dRes.bars,
    );
    if (!Number.isFinite(spot) || spot <= 0) {
      throw new RuntimeNoDataError(
        'NO_MARKET_DATA',
        `No market data available to value ${canonicalSymbol} ${expirationDate}`,
        this.secrets,
        503,
      );
    }

    const latestTreasury =
      [...treasuryRes.observations]
        .reverse()
        .find((obs) => obs.finiteTenors === TREASURY_TENORS.length) ??
      treasuryRes.observations[treasuryRes.observations.length - 1];
    const latestFunding = [...fundingRes.observations]
      .reverse()
      .find((obs) => Number.isFinite(obs.sofr));
    const sofrRate = latestFunding?.sofr ?? Number.NaN;

    const dteEt = calendarDteEt(expirationDate, nowSec * 1_000);
    const horizon = Number.isFinite(dteEt) ? dteEt : 30;
    const bandPct = horizon >= 180 ? 0.45 : horizon >= 90 ? 0.35 : 0.25;
    const bandMin = Math.max(0.01, Math.floor(spot * (1 - bandPct) * 100) / 100);
    const bandMax = Math.ceil(spot * (1 + bandPct) * 100) / 100;

    // Referencia por fecha exacta para etiquetar binarias/ajustadas de esa fecha.
    let referenceForChain: readonly OptionContract[] = [];
    try {
      const refRes = await this.loadOptionContractsFn({
        underlying: canonicalSymbol,
        isIndex,
        expirationDate,
        now: nowSec,
        minStrike: bandMin,
        maxStrike: bandMax,
        excludeBinary: false,
        excludeAdjusted: false,
        limit: 1_000,
        maxPages: 2,
        ...baseTransport,
      });
      referenceForChain = refRes.contracts;
      if (refRes.report.providerError !== null) {
        warnings.push(
          `options expiry reference error (${expirationDate}): ${redactSecrets(refRes.report.providerError.message, this.secrets)}`,
        );
      }
    } catch (err: unknown) {
      warnings.push(
        `options expiry reference skipped (${expirationDate}): ${redactSecrets(extractErrorMessage(err, 'options reference fetch failed'), this.secrets)}`,
      );
    }
    if (referenceForChain.length === 0) {
      const cachedCatalog =
        this.usExpiryCatalogCache.peek(`us:expiry-catalog:${canonicalSymbol}`)?.value ?? null;
      referenceForChain =
        cachedCatalog?.contracts.filter((c) => c.expirationDate === expirationDate) ?? [];
    }

    let contracts: readonly OptionSnapshotContract[] = [];
    let chainUnderlying: OptionUnderlyingSnapshot | null = null;
    try {
      const chainRes = await this.loadOptionChainFn({
        underlying: canonicalSymbol,
        isIndex,
        expirationDate,
        now: nowSec,
        minStrike: bandMin,
        maxStrike: bandMax,
        excludeBinary: true,
        excludeAdjusted: true,
        referenceContracts: referenceForChain,
        snapshotLimit: 250,
        maxPages: 3,
        ...baseTransport,
      });
      contracts = chainRes.contracts.filter((c) => c.expirationDate === expirationDate);
      chainUnderlying = chainRes.underlying;
      if (chainRes.report.providerError !== null) {
        warnings.push(
          `options expiry chain error (${expirationDate}): ${redactSecrets(chainRes.report.providerError.message, this.secrets)}`,
        );
      }
    } catch (err: unknown) {
      warnings.push(
        `options expiry chain skipped (${expirationDate}): ${redactSecrets(extractErrorMessage(err, 'options expiry chain failed'), this.secrets)}`,
      );
    }

    const marketPartsEt = getMarketParts(nowSec, 'EQUITY');
    const isWeekendEt = marketPartsEt.weekday === 0 || marketPartsEt.weekday === 6;
    const anyClosedMarket =
      unifiedRes.stocks.some((s) => s.marketStatus?.toLowerCase() === 'closed') ||
      unifiedRes.indices.some((idx) => idx.marketStatus?.toLowerCase() === 'closed');

    // Overlay Tradier acotado exclusivamente a `expiryContracts` (una sola fecha) y
    // sin pisar volumen/OI canónicos de Massive.
    const tradierOverlay = await this.tryTradierChainOverlay(
      canonicalSymbol,
      isIndex,
      contracts,
      nowSec,
      warnings,
    );
    contracts = tradierOverlay.contracts;

    const eodQuotesRes = applyEodCloseRefQuotes(contracts, {
      evalSecUs: nowSec,
      marketIsClosed: anyClosedMarket || isWeekendEt,
    });
    contracts = eodQuotesRes.contracts;
    const usedEodCloseRef = eodQuotesRes.usedEodCloseRef;
    const quoteMode: 'LIVE_NBBO' | 'EOD_CLOSE_REF' = usedEodCloseRef ? 'EOD_CLOSE_REF' : 'LIVE_NBBO';

    // Alineación del spot OPRA solo si el mercado está cerrado o el feed diverge.
    const resolvedSpot = resolveSpotPrice(
      chainUnderlying,
      stockByTicker.get(canonicalSymbol),
      indexByTicker.get(canonicalSymbol),
      [],
      bars1dRes.bars,
    );
    if (Number.isFinite(resolvedSpot) && resolvedSpot > 0) {
      spot = resolvedSpot;
    }
    const expirySec = contracts[0]?.expirationTime ?? etExpiryUtcSecFromDate(expirationDate);
    const alignmentParity =
      contracts.length > 0
        ? evaluateParityForExpiry(expirySec, contracts, nowSec, spot, latestTreasury, sofrRate)
        : null;
    const parityImpliedSpot =
      alignmentParity !== null &&
      Number.isFinite(alignmentParity.forward) &&
      alignmentParity.forward > 0 &&
      Number.isFinite(alignmentParity.rate) &&
      Number.isFinite(alignmentParity.timeToExpiry) &&
      alignmentParity.timeToExpiry > 0
        ? alignmentParity.forward * Math.exp(-alignmentParity.rate * alignmentParity.timeToExpiry)
        : Number.NaN;
    const alignedSpot = resolveOpraAlignedSpot({
      feedSpot: spot,
      rthCloseSpot: resolveRthCloseSpot([], bars1dRes.bars, nowSec),
      parityImpliedSpot,
      marketClosed: anyClosedMarket || isWeekendEt || usedEodCloseRef,
    });
    if (Number.isFinite(alignedSpot.valuationSpot) && alignedSpot.valuationSpot > 0) {
      spot = alignedSpot.valuationSpot;
    }
    if (alignedSpot.source !== 'FEED' && Number.isFinite(alignedSpot.divergenceBps)) {
      warnings.push(
        `US options spot alignment: feed=${alignedSpot.headerSpot.toFixed(4)} valuation=${alignedSpot.valuationSpot.toFixed(4)} source=${alignedSpot.source} divergence=${alignedSpot.divergenceBps.toFixed(2)}bps`,
      );
    }

    // Cuantitativo completo SOLO para esa fecha.
    const contractOwnIvMap = new Map<string, number>();
    const expiryParityMap = new Map<number, ExpiryParityEvaluation>();
    const validSlices: SlicePackage[] = [];
    let ownSolvedIvContracts = 0;
    let providerFallbackIvContracts = 0;
    const evaluation =
      contracts.length > 0
        ? this.buildExpiryEvaluation({
            expirySec,
            expiryContracts: contracts,
            spot,
            nowSec,
            latestTreasury,
            sofrRate,
            isIndex,
            contractOwnIvMap,
            relaxShortHorizon: usedEodCloseRef || anyClosedMarket || isWeekendEt,
          })
        : null;
    const expiryParity = evaluation?.parity ?? null;
    const slicePkg = evaluation?.pkg ?? null;
    if (evaluation !== null) {
      expiryParityMap.set(expirySec, evaluation.parity);
      if (evaluation.pkg !== null) {
        validSlices.push(evaluation.pkg);
      }
    }

    let exposureResult: DealerExposureResult | undefined;
    if (expiryParity !== null && Number.isFinite(spot) && spot > 0) {
      const exposureBuild = this.buildExposureInputs({
        contracts,
        expiryParityMap,
        fallbackParity: expiryParity,
        contractOwnIvMap,
        spot,
      });
      ownSolvedIvContracts = exposureBuild.ownSolvedIvContracts;
      providerFallbackIvContracts = exposureBuild.providerFallbackIvContracts;
      exposureResult = computeDealerExposure(
        exposureBuild.inputs,
        {
          spot,
          nowUtcSec: nowSec,
          rate: expiryParity.rate,
          dividendYield: expiryParity.dividendYield,
          forward: expiryParity.forward,
        },
        {
          model: isIndex ? 'bsm' : 'american',
          wallCriterion: 'gex',
          wallScope: 'all',
          gammaFlipHalfWidth: 0.2,
          gammaFlipGridSteps: 80,
          gammaFlipMultiRootPolicy: 'nearestSpot',
          ivResolutionMode: 'ivThenMidPrice',
          expectedMoveExpirySec: expirySec,
          ...(slicePkg !== null ? { expectedMoveIvAtmOverride: slicePkg.metrics.ivAtm } : {}),
        },
      );
    }

    // Contratos serializados: vecinos al spot hasta la cuota primaria (sin fabricar).
    const expiryAtmIvMap = this.buildExpiryAtmIvMap(validSlices, contracts, contractOwnIvMap, spot);
    const otmIvByExpiryStrike = this.buildOtmIvByExpiryStrike(
      contracts,
      contractOwnIvMap,
      spot,
      nowSec,
    );
    const selectedForSerialization =
      expiryParity !== null
        ? [...contracts]
            .filter((c) => c.expirationTime > nowSec + 60)
            .sort((a, b) => Math.abs(a.strikePrice - spot) - Math.abs(b.strikePrice - spot))
            .slice(0, MAX_SERIALIZED_PRIMARY_CONTRACTS)
        : [];
    const serializedContracts =
      expiryParity !== null
        ? this.serializeExpiryContractRows({
            selected: selectedForSerialization,
            spot,
            nowSec,
            isIndex,
            expiryParityMap,
            fallbackParity: expiryParity,
            contractOwnIvMap,
            expiryAtmIvMap,
            otmIvByExpiryStrike,
          })
        : [];

    // Tasas sintéticas de ese vencimiento con el DTE exacto de `expirationDate`.
    let syntheticRates: SyntheticImpliedRatesResult | null = null;
    let conversionReversal: ConversionReversalResult | null = null;
    let buyWrite: BuyWriteResult | null = null;
    if (expiryParity !== null && contracts.length > 0) {
      const callMap = new Map<number, OptionSnapshotContract>();
      const putMap = new Map<number, OptionSnapshotContract>();
      for (const c of contracts) {
        if (c.contractType === 'call') callMap.set(c.strikePrice, c);
        else putMap.set(c.strikePrice, c);
      }
      const synthPairs: { strike: number; callMid: number; putMid: number }[] = [];
      for (const [strike, callRow] of callMap.entries()) {
        const putRow = putMap.get(strike);
        if (putRow === undefined) continue;
        const callMid = resolveQuoteMid(callRow);
        const putMid = resolveQuoteMid(putRow);
        if (Number.isFinite(callMid) && callMid > 0 && Number.isFinite(putMid) && putMid > 0) {
          synthPairs.push({ strike, callMid, putMid });
        }
      }
      const expiryDteCalendar = Number.isFinite(dteEt)
        ? dteEt
        : Math.max(0, Math.round((expirySec - nowSec) / 86_400));
      if (synthPairs.length > 0) {
        syntheticRates = computeSyntheticImpliedRates({
          spot,
          riskFreeRate: expiryParity.rate,
          dividendYield: expiryParity.dividendYield,
          timeToExpiry: Math.max(1 / 365, expiryParity.timeToExpiry),
          dte: expiryDteCalendar,
          pairs: synthPairs,
        });
      }
      // Pieza 50.3: Buy-Write y Cobertura Sintética del vencimiento exacto, no congelados
      // al front 0DTE del snapshot (DTE < 3 → BLOCKED_SHORT_DTE; DTE exacto sin clamp).
      const expiryT = Math.max(1 / 365, expiryParity.timeToExpiry);
      const atmStrikeExpiry = [...callMap.keys()].sort(
        (a, b) => Math.abs(a - spot) - Math.abs(b - spot),
      )[0];
      if (atmStrikeExpiry !== undefined) {
        const cAtm = callMap.get(atmStrikeExpiry);
        const pAtm = putMap.get(atmStrikeExpiry);
        if (
          cAtm !== undefined &&
          pAtm !== undefined &&
          cAtm.lastQuote.bid > 0 &&
          cAtm.lastQuote.ask >= cAtm.lastQuote.bid &&
          pAtm.lastQuote.bid > 0 &&
          pAtm.lastQuote.ask >= pAtm.lastQuote.bid
        ) {
          conversionReversal = evaluateConversionReversal({
            strike: atmStrikeExpiry,
            timeToExpiry: expiryT,
            riskFreeTna: Math.max(0, Math.exp(expiryParity.rate) - 1),
            spotBid: spot,
            spotAsk: spot,
            callBid: cAtm.lastQuote.bid,
            callAsk: cAtm.lastQuote.ask,
            putBid: pAtm.lastQuote.bid,
            putAsk: pAtm.lastQuote.ask,
            stockFeeRate: 0.0005,
            optionFeeRate: 0.002,
            vatRate: 0,
            dte: expiryDteCalendar,
          });
        }
      }
      const otmCallExpiry = [...callMap.values()]
        .filter((c) => c.strikePrice >= spot && c.lastQuote.bid > 0)
        .sort((a, b) => a.strikePrice - b.strikePrice)[0];
      if (otmCallExpiry !== undefined) {
        buyWrite = evaluateBuyWrite({
          spotAsk: spot,
          strike: otmCallExpiry.strikePrice,
          callBid: otmCallExpiry.lastQuote.bid,
          timeToExpiry: expiryT,
          stockFeeRate: 0.0005,
          optionFeeRate: 0.002,
          vatRate: 0,
          dte: expiryDteCalendar,
        });
      }
    }

    // Suite de volatilidad del vencimiento exacto (paridad VRP/skew/cone/ratios con su
    // propio `daysToExpiry`).
    let volAnalyticsExpiry: VolAnalyticsExpirySuiteResult | null = null;
    if (expiryParity !== null) {
      const underlyingQuoteSnap = stockByTicker.get(canonicalSymbol);
      const underlyingBidUs =
        underlyingQuoteSnap?.lastQuote !== null &&
        underlyingQuoteSnap?.lastQuote !== undefined &&
        Number.isFinite(underlyingQuoteSnap.lastQuote.bid) &&
        underlyingQuoteSnap.lastQuote.bid > 0
          ? underlyingQuoteSnap.lastQuote.bid
          : spot;
      const underlyingAskUs =
        underlyingQuoteSnap?.lastQuote !== null &&
        underlyingQuoteSnap?.lastQuote !== undefined &&
        Number.isFinite(underlyingQuoteSnap.lastQuote.ask) &&
        underlyingQuoteSnap.lastQuote.ask > 0
          ? underlyingQuoteSnap.lastQuote.ask
          : spot;
      const suite = this.buildUsVolAnalyticsSuite({
        canonicalSymbol,
        spot,
        spotBid: underlyingBidUs,
        spotAsk: underlyingAskUs,
        evalRateUs: expiryParity.rate,
        evalDivUs: expiryParity.dividendYield,
        sofrRate,
        r30d: interpolateLiveRate(latestTreasury, sofrRate, 30 / 365),
        nowSec,
        closedDailyUs: normalizeClosedDailyBarsUs(bars1dRes.bars, nowSec),
        contracts,
        contractOwnIvMap,
        deltaByTicker: new Map(serializedContracts.map((sc) => [sc.ticker, sc.delta])),
        validSlices,
        expiryParityMap,
        qDistributionFront: null,
        putWallStrike: exposureResult?.putWallStrike ?? null,
        netGex: exposureResult?.netGex ?? null,
      });
      volAnalyticsExpiry = suite?.expiriesByCode[expirationDate] ?? null;
    }

    const feedMode: 'LIVE' | 'EOD_CIERRE' | 'PARTIAL' | 'NO_DATA' =
      contracts.length === 0
        ? 'NO_DATA'
        : anyClosedMarket || usedEodCloseRef || isWeekendEt
          ? 'EOD_CIERRE'
          : warnings.length === 0
            ? 'LIVE'
            : 'PARTIAL';

    const expiryMeta: UsOptionExpiryDto = (() => {
      const base: UsOptionExpiryDto = {
        expirationDate,
        daysToExpiry: Number.isFinite(dteEt) ? dteEt : 0,
        loaded: true,
        validCallCount: 0,
        validPutCount: 0,
        nearAtmLiquidity: 0,
        inDefaultWindow: Number.isFinite(dteEt) && dteEt >= 14 && dteEt <= 45,
        hasCompleteAtmChain: false,
      };
      if (contracts.length === 0) {
        return base;
      }
      const valid = contracts.filter(isValidOptionQuote);
      const validCalls = valid.filter((c) => c.contractType === 'call');
      const validPuts = valid.filter((c) => c.contractType === 'put');
      const nearCalls = validCalls.filter((c) => isNearAtm(c, spot));
      const nearPuts = validPuts.filter((c) => isNearAtm(c, spot));
      return {
        ...base,
        validCallCount: validCalls.length,
        validPutCount: validPuts.length,
        nearAtmLiquidity: [...nearCalls, ...nearPuts].reduce((sum, c) => sum + liquidityValue(c), 0),
        hasCompleteAtmChain: nearCalls.length >= 2 && nearPuts.length >= 2,
      };
    })();

    // Streaming WS: hasta 40 contratos ATM más líquidos de esta fecha priorizados.
    const activeExpiryWsTickers = [...contracts]
      .filter((c) => c.expirationTime > nowSec + 60)
      .sort((a, b) => {
        const dist = Math.abs(a.strikePrice - spot) - Math.abs(b.strikePrice - spot);
        if (dist !== 0) return dist;
        return liquidityValue(b) - liquidityValue(a);
      })
      .slice(0, MAX_WS_OPTION_CONTRACTS)
      .map((c) => c.ticker);
    void this.ensureOptionQuoteSubscriptions(activeExpiryWsTickers, { prioritize: true });

    const response: UsOptionExpiryChainResponse = {
      status: contracts.length === 0 ? 'PARTIAL' : warnings.length === 0 ? 'OK' : 'PARTIAL',
      feedMode,
      quoteMode,
      symbol: canonicalSymbol,
      expirationDate,
      asOfUtcSec: nowSec,
      spot: Number.isFinite(spot) ? spot : null,
      daysToExpiry: dteEt,
      expiryMeta,
      slice: slicePkg !== null ? serializeSlice(slicePkg) : null,
      contracts: serializedContracts,
      exposureSummary: exposureResult === undefined ? null : serializeExposure(exposureResult),
      syntheticRates: syntheticRates === null ? null : sanitizeJsonValue(syntheticRates),
      // Pieza 50.3: tasas propias del vencimiento pedido (antes congeladas al front 0DTE).
      conversionReversal: conversionReversal === null ? null : sanitizeJsonValue(conversionReversal),
      buyWrite: buyWrite === null ? null : sanitizeJsonValue(buyWrite),
      volAnalyticsExpiry:
        volAnalyticsExpiry === null ? null : sanitizeJsonValue(volAnalyticsExpiry),
      ...(tradierOverlay.summary !== null
        ? {
            usOptionsFeed: {
              provider:
                tradierOverlay.summary.tradierContracts > 0 &&
                tradierOverlay.summary.matchedByOcc + tradierOverlay.summary.matchedByStrikeType > 0
                  ? ('TRADIER' as const)
                  : ('MASSIVE' as const),
              badge:
                tradierOverlay.summary.tradierContracts > 0 &&
                tradierOverlay.summary.matchedByOcc + tradierOverlay.summary.matchedByStrikeType > 0
                  ? ('TRADIER LIVE + ORATS' as const)
                  : ('MASSIVE + ORATS' as const),
              tradierOverlay: tradierOverlay.summary,
            },
          }
        : {}),
      dataQuality: {
        ownSolvedIvContracts,
        providerFallbackIvContracts,
        parityExpiries: expiryParityMap.size,
        chainContractsReceived: contracts.length,
        chainContractsUsable: exposureResult?.quality.usableContracts ?? 0,
        warnings,
      },
    };

    assertJsonSafeSerialized(response);
    return response;
  }

  public async getBars(
    rawSymbol: string,
    rawTimeframe: string | undefined,
    options: {
      readonly visibleBars?: number;
      readonly rthOnly?: boolean;
      readonly forceRefresh?: boolean;
    } = {},
  ): Promise<TerminalBarsResponse> {
    const parsed = parseTerminalSymbol(rawSymbol, this.secrets);
    const timeframe = parseTimeframe(rawTimeframe, this.secrets);
    const maxVisible = timeframe === '1D' ? 1_250 : 1_000;
    const defaultVisible = maxVisible;
    const visibleBars = Math.min(Math.max(options.visibleBars ?? defaultVisible, 20), maxVisible);
    const requestedRthOnly = options.rthOnly ?? false;
    const effectiveRthOnly = requestedRthOnly && timeframe !== '1D' && timeframe !== '4h';
    const cacheKey = `bars:${parsed.canonicalSymbol}:${timeframe}:${effectiveRthOnly ? 'rth' : 'ext'}:${String(visibleBars)}`;

    const result = await this.barsCache.getOrCompute(
      cacheKey,
      () => this.computeBars(parsed, timeframe, visibleBars, effectiveRthOnly, cacheKey),
      options.forceRefresh === undefined ? {} : { forceRefresh: options.forceRefresh },
    );
    return result.value;
  }

  private async computeBars(
    parsed: ParsedSymbol,
    timeframe: Timeframe,
    visibleBars: number,
    rthOnly: boolean,
    barsCacheKey: string,
  ): Promise<TerminalBarsResponse> {
    const nowSec = Math.floor(this.nowMsFn() / 1_000);
    const barSeconds = TIMEFRAME_SECONDS[timeframe];
    const canUseFmp = this.fmpHistoricalProviderEnabled;
    const canUseTradierHistorical = this.tradierHistoricalProviderEnabled && this.tradierHistoricalClient !== null;
    const providerChain: readonly ('FMP_ENTERPRISE_REST' | 'TRADIER_REST' | 'MASSIVE_REST')[] =
      canUseFmp
        ? (canUseTradierHistorical ? ['FMP_ENTERPRISE_REST', 'TRADIER_REST'] : ['FMP_ENTERPRISE_REST'])
        : canUseTradierHistorical
          ? ['TRADIER_REST']
          : ['MASSIVE_REST'];

    // Pieza 39: GGAL ADR intradía usa historial profundo (14 meses) para cubrir
    // el gap electoral en el AVWAP Anclado. Caché LRU + snapshot en disco por
    // proveedor: las consultas posteriores responden desde la caché (<15 ms).
    const useDeepHistory =
      parsed.canonicalSymbol === 'GGAL' &&
      Number.isFinite(deepHistoryFromUtcSec(nowSec)) &&
      (isGgalDeepHistoryTimeframe(timeframe) ||
        (providerChain[0] === 'FMP_ENTERPRISE_REST' &&
          isGgalPaginatedHistoryTimeframe(timeframe)));

    let bars: readonly Bar[];
    let barsStatusOk = true;
    let visibleStart = 0;
    let barsProvider: TerminalBarsResponse['barsProvider'] = providerChain[0] ?? 'MASSIVE_REST';    const providerFallbackUsed: string[] = [];
    const includeExtended = timeframe !== '1D' && !rthOnly;
    // Pieza 50.5 (Bloque 2, SPEC.md:4): el tramo visible exige 1.000 velas
    // previas de calentamiento. Se piden como objetivo interno en las ramas
    // ordinarias FMP/Tradier; el recorte y el payload conservan `visibleBars`
    // y la EMA se calcula sobre la serie completa antes del recorte.
    const restFetchTargetBars = visibleBars + REST_EMA_WARMUP_BARS;
    if (useDeepHistory) {
      const fromSec = deepHistoryFromUtcSec(nowSec);
      const fmpLoad = async (): Promise<readonly Bar[]> => {
        const result = await this.fmpClient.fetchHistoricalPaginated({
          symbol: parsed.canonicalSymbol,
          timeframe,
          fromUtcSec: fromSec,
          toUtcSec: nowSec,
          includeExtended,
        });
        if (result.rows === 0) throw new Error('FMP deep history returned no bars');
        const first = result.bars[0];
        if (first === undefined || first.time >= ELECTORAL_GAP_START_UTC_SEC) {
          throw new Error('FMP deep history does not cover the pre-electoral edge');
        }
        return result.bars;
      };
      const tradierDeepLoad = async (): Promise<readonly Bar[]> => {
        if (this.tradierHistoricalClient === null) throw new Error('Tradier historical is unavailable');
        return (await this.tradierHistoricalClient.fetchHistoricalBars({
          symbol: parsed.canonicalSymbol,
          timeframe,
          fromUtcSec: fromSec,
          toUtcSec: nowSec,
          includeExtended,
        })).bars;
      };
      const massiveDeepLoad = async (): Promise<readonly Bar[]> => {
        const apiKey = this.assertRestApiKey();
        const res = await this.loadBarsFn({
          provider: 'massive',
          symbol: parsed.canonicalSymbol,
          timeframe,
          visibleBars: GGAL_DEEP_HISTORY_MAX_BARS,
          warmupBars: 0,
          rthOnly,
          maxPages: 8,
          now: nowSec,
          apiKey,
          fetchFn: this.fetchFn,
          ...(this.baseUrl === undefined ? {} : { baseUrl: this.baseUrl }),
          window: { from: fromSec, to: nowSec },
          sort: 'asc',
          pageLimit: 5_000,
        });
        if (res.report.providerError !== null) {
          throw new Error(res.report.providerError.message);
        }
        return res.bars;
      };
      const store =
        providerChain[0] === 'FMP_ENTERPRISE_REST'
          ? this.ggalFmpDeepHistory
          : this.ggalDeepHistory;
      let lastError: Error | null = null;
      let loadedBars: readonly Bar[] = [];
      for (let index = 0; index < providerChain.length; index += 1) {
        const provider = providerChain[index];
        if (provider === undefined) continue;
        try {
          loadedBars = await (provider === 'FMP_ENTERPRISE_REST'
            ? store.ensure(timeframe as GgalPaginatedHistoryTimeframe, {
                forceRefresh: false,
                loadFn: fmpLoad,
              })
            : (provider === 'TRADIER_REST'
                ? tradierDeepLoad()
                : massiveDeepLoad()));
          if (loadedBars.length > 0) {
            barsProvider = provider;
            break;
          }
        } catch (err: unknown) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (provider !== providerChain[providerChain.length - 1]) providerFallbackUsed.push(provider);
        }
      }
      if (loadedBars.length === 0) {
        throw new RuntimeNoDataError(
          'NO_BARS_DATA',
          `No deep history available for ${parsed.canonicalSymbol} (${timeframe})${lastError === null ? '' : `: ${lastError.message}`}`,
          this.secrets,
          503,
        );
      }
      bars = loadedBars;
    } else if (providerChain[0] === 'FMP_ENTERPRISE_REST') {
      // Pieza 50.5 (Bloque 1): la ventana se deriva de la densidad real por
      // sesión del adaptador, no de `visibleBars * barSeconds + 14 días`.
      const fromSec = restHistoricalFromUtcSec({
        toUtcSec: nowSec,
        provider: 'FMP_ENTERPRISE_REST',
        timeframe,
        includeExtended,
        targetBars: restFetchTargetBars,
      });
      // Intradía reutiliza el paginador FMP acotado al rango planificado (una
      // sola consulta cuando el rango cabe en una ventana del planificador);
      // 1D conserva una única consulta EOD. Con la caída a legacy (URL sin
      // rango) el merge recorta al rango pedido y deduplica.
      const fmpResult =
        timeframe === '1D'
          ? await this.fmpClient.fetchHistorical({
              symbol: parsed.canonicalSymbol,
              timeframe,
              fromUtcSec: fromSec,
              toUtcSec: nowSec,
              includeExtended,
            })
          : await this.fmpClient.fetchHistoricalPaginated({
              symbol: parsed.canonicalSymbol,
              timeframe,
              fromUtcSec: fromSec,
              toUtcSec: nowSec,
              includeExtended,
            });
      if (fmpResult.bars.length === 0) {
        if (canUseTradierHistorical) {
          providerFallbackUsed.push('FMP_ENTERPRISE_REST');
          barsProvider = 'TRADIER_REST';
          const tradierFromSec = restHistoricalFromUtcSec({
            toUtcSec: nowSec,
            provider: 'TRADIER_REST',
            timeframe,
            includeExtended,
            targetBars: restFetchTargetBars,
          });
          const tradierResult = await this.tradierHistoricalClient.fetchHistoricalBars({
            symbol: parsed.canonicalSymbol,
            timeframe,
            fromUtcSec: tradierFromSec,
            toUtcSec: nowSec,
            includeExtended,
          });
          if (tradierResult.bars.length === 0) {
            throw new RuntimeNoDataError('NO_BARS_DATA', `No bars available for ${parsed.canonicalSymbol} (${timeframe})`, this.secrets, 503);
          }
          bars = rthOnly && timeframe !== '1D' ? tradierResult.bars.filter((b) => isRth(b.time)) : tradierResult.bars;
        } else {
          throw new RuntimeNoDataError('NO_BARS_DATA', `No bars available from FMP for ${parsed.canonicalSymbol} (${timeframe})`, this.secrets, 503);
        }
      } else {
        bars = rthOnly && timeframe !== '1D' ? fmpResult.bars.filter((b) => isRth(b.time)) : fmpResult.bars;
      }
      const startIdx = Math.max(0, bars.length - visibleBars);
      visibleStart = startIdx;
    } else if (providerChain[0] === 'TRADIER_REST') {
      if (this.tradierHistoricalClient === null) {
        throw new RuntimeNoDataError('NO_BARS_DATA', 'Tradier historical client is unavailable', this.secrets, 503);
      }
      const fromSec = restHistoricalFromUtcSec({
        toUtcSec: nowSec,
        provider: 'TRADIER_REST',
        timeframe,
        includeExtended,
        targetBars: restFetchTargetBars,
      });
      const tradierResult = await this.tradierHistoricalClient.fetchHistoricalBars({
        symbol: parsed.canonicalSymbol,
        timeframe,
        fromUtcSec: fromSec,
        toUtcSec: nowSec,
        includeExtended,
      });
      if (tradierResult.bars.length === 0) {
        throw new RuntimeNoDataError('NO_BARS_DATA', `No bars available from Tradier for ${parsed.canonicalSymbol} (${timeframe})`, this.secrets, 503);
      }
      bars = rthOnly && timeframe !== '1D' ? tradierResult.bars.filter((b) => isRth(b.time)) : tradierResult.bars;
      visibleStart = Math.max(0, bars.length - visibleBars);
    } else {
      const apiKey = this.assertRestApiKey();
      const res = await this.loadBarsFn({
        provider: 'massive',
        symbol: parsed.canonicalSymbol,
        timeframe,
        visibleBars,
        warmupBars: 0,
        rthOnly,
        maxPages: timeframe === '1D' ? 12 : 8,
        now: nowSec,
        apiKey,
        fetchFn: this.fetchFn,
        ...(this.baseUrl === undefined ? {} : { baseUrl: this.baseUrl }),
      });
      if (res.bars.length === 0) {
        const msg =
          res.report.providerError?.message ??
          `No bars available from Massive for ${parsed.canonicalSymbol} (${timeframe})`;
        throw new RuntimeNoDataError('NO_BARS_DATA', msg, this.secrets, 503);
      }
      bars = res.bars;
      barsStatusOk = res.report.providerError === null;
      visibleStart = res.visibleStart;
    }
    if (useDeepHistory) {
      this.ggalTickEngine.seedHistory(
        'ADR',
        timeframe,
        bars.map((bar) => ({
          timeSec: bar.time,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
          ...(Number.isFinite(bar.vw) ? { vw: bar.vw as number } : {}),
        })),
      );
    }

    const closes = bars.map((b) => b.close);
    const ema9 = calculateEma(closes, 9);
    const ema21 = calculateEma(closes, 21);
    const ema50 = calculateEma(closes, 50);
    const ema200 = calculateEma(closes, 200);
    const sma50 = computeSmaSeries(closes, 50);
    const sma200 = computeSmaSeries(closes, 200);
    const hma55 = computeHmaSeries(closes, 55);

    const sessionVwapSupported = 1_800 % barSeconds === 0;
    const sessionVwap = sessionVwapSupported
      ? computeSessionVwap(bars, { market: 'EQUITY', barSeconds })
      : null;
    const avwap = computeAnchoredVwap(
      bars,
      timeframe === '1D' ? 'MONTH' : 'SESSION',
      { market: 'EQUITY' },
    );
    const rsi14 = computeWilderRsiSeries(closes, 14);

    const cvdResult = analyzeCvdAndAbsorption(bars, {
      asOfUtcSec: nowSec,
      barSeconds,
      sessionScope: rthOnly ? 'RTH' : 'FULL_ET',
      levels: [],
      levelProximityPct: 0.0015,
    });
    const cvdByTime = new Map<number, number>();
    for (const cBar of cvdResult.bars) {
      cvdByTime.set(cBar.time, cBar.sessionCvd);
    }

    const rsiDiv = detectRsiDivergences(bars, { asOfUtcSec: nowSec, barSeconds });
    const cachedSnapshot = this.snapshotCache.peek(`snapshot:${parsed.canonicalSymbol}`)?.value;

    let zones: TerminalBarsResponse['zones'] = null;
    let keyLevels: readonly SerializedKeyLevel[] = cachedSnapshot?.envelope.snapshot.keyLevels ?? [];
    if (cachedSnapshot?.openingAuction !== undefined && cachedSnapshot.openingAuction !== null) {
      zones = {
        onVal: cachedSnapshot.openingAuction.onVal,
        onVah: cachedSnapshot.openingAuction.onVah,
        onPoc: cachedSnapshot.openingAuction.onPoc,
        ibl: cachedSnapshot.openingAuction.ibl,
        ibh: cachedSnapshot.openingAuction.ibh,
      };
    } else if (barSeconds <= 900) {
      const auction = evaluateOpeningAuction(bars, {
        asOfUtcSec: nowSec,
        barSeconds,
      });
      const lastHma55 = hma55[hma55.length - 1];
      zones = {
        onVal: sanitizeFinite(auction.onVal),
        onVah: sanitizeFinite(auction.onVah),
        onPoc: sanitizeFinite(auction.onPoc),
        ibl: sanitizeFinite(auction.ibl),
        ibh: sanitizeFinite(auction.ibh),
      };
      if (keyLevels.length === 0) {
        keyLevels = buildKeyLevelsFromAuctionAndHma({
          auction,
          hma55: lastHma55,
        });
      }
    }

    const markers: (SerializedAbsorptionMarker | SerializedDivergenceMarker)[] = [
      ...serializeAbsorptionEvents(cvdResult),
      ...rsiDiv.divergences.map((d) => ({
        kind: 'RSI' as const,
        type: d.type,
        pivotTime: d.pivot2Time,
        confirmTime: d.confirmedAtTime,
        price: sanitizeFinite(d.price2),
      })),
    ];

    const startSlice = Math.max(0, visibleStart);
    const slicedBars = bars.slice(startSlice);
    const avwapByTime = new Map(avwap.points.map((point) => [point.time, point] as const));
    const avwapAligned = (selector: (point: typeof avwap.points[number]) => number): (number | null)[] =>
      slicedBars.map((bar) => {
        const point = avwapByTime.get(bar.time);
        return point === undefined ? null : sanitizeFinite(selector(point));
      });
    const formingState = timeframe === '1m' ? this.liveStates1m.get(parsed.canonicalSymbol) : undefined;

    // Pieza 50.5: anclas Auto-AVWAP adjuntas al payload, cacheadas por día. Ante
    // cualquier error se degrada a `[]` y jamás bloquea `/api/bars`.
    let autoAvwapAnchors: readonly AutoAvwapAnchor[] = [];
    try {
      autoAvwapAnchors = await this.resolveAutoAvwapAnchorsForUs(
        parsed.canonicalSymbol,
        timeframe === '1D' ? bars : null,
        nowSec,
        barsCacheKey,
      );
    } catch {
      autoAvwapAnchors = [];
    }

    const payload: TerminalBarsResponse = {
      status: barsStatusOk ? 'OK' : 'PARTIAL',
      symbol: parsed.canonicalSymbol,
      timeframe,
      barSeconds,
      rthOnly,
      asOfUtcSec: nowSec,
      visibleStartIndex: visibleStart - startSlice,
      bars: slicedBars.map(serializeBar),
      formingBar:
        formingState?.formingBar !== undefined && formingState.formingBar !== null
          ? serializeBar(formingState.formingBar)
          : null,
      overlays: {
        ema9: ema9.slice(startSlice).map((v) => sanitizeFinite(v)),
        ema21: ema21.slice(startSlice).map((v) => sanitizeFinite(v)),
        ema50: ema50.slice(startSlice).map((v) => sanitizeFinite(v)),
        ema200: ema200.slice(startSlice).map((v) => sanitizeFinite(v)),
        sma50: sma50.slice(startSlice).map((v) => sanitizeFinite(v)),
        sma200: sma200.slice(startSlice).map((v) => sanitizeFinite(v)),
        hma55: hma55.slice(startSlice).map((v) => sanitizeFinite(v)),
        sessionVwap: sessionVwapSupported && sessionVwap !== null
          ? (() => {
              const sessionVwapByTime = new Map(sessionVwap.points.map((point) => [point.time, point.vwap] as const));
              return slicedBars.map((bar) => sanitizeFinite(sessionVwapByTime.get(bar.time)));
            })()
          : slicedBars.map(() => null),
        sessionVwapSupported,
        avwap: avwapAligned((point) => point.vwap),
        avwapUpper1: avwapAligned((point) => point.upper1),
        avwapLower1: avwapAligned((point) => point.lower1),
        avwapUpper2: avwapAligned((point) => point.upper2),
        avwapLower2: avwapAligned((point) => point.lower2),
      },
      subPanes: {
        rsi14: rsi14.slice(startSlice).map((v) => sanitizeFinite(v)),
        sessionCvd: slicedBars.map((b) => sanitizeFinite(cvdByTime.get(b.time))),
        deltaMode: cvdResult.deltaMode,
      },
      zones,
      keyLevels,
      markers,
      barsProvider,
      barsProviderFallbackUsed: [...providerFallbackUsed],
      autoAvwapAnchors,
    };

    assertJsonSafeSerialized(payload);
    return payload;
  }

  /** Pieza 50.5.1: backoff corto anti-tormenta cuando FMP falla al resolver eventos. */
  private readonly fmpEventBackoffUntilMs = new Map<string, number>();
  private isFmpEventBackoffActive(key: string): boolean {
    const until = this.fmpEventBackoffUntilMs.get(key);
    return until !== undefined && this.nowMsFn() < until;
  }

  private markFmpEventBackoff(key: string): void {
    this.fmpEventBackoffUntilMs.set(key, this.nowMsFn() + FMP_EVENT_FAILURE_BACKOFF_MS);
  }

  private clearFmpEventBackoff(key: string): void {
    this.fmpEventBackoffUntilMs.delete(key);
  }

  /**
   * Pieza 50.5.1: resuelve las anclas Auto-AVWAP US con caché diario
   * (`US:${symbol}:${fmpEtDateKey}`, TTL 24 h).
   *
   * Pieza 50.5 (Bloque 3): el insumo de anclas son **solo ruedas cerradas**
   * (`isUsClosedDailyBar`). Un hint con menos de 380 ruedas cerradas válidas no
   * evita la carga diaria completa: se reutiliza la caché `1D:ext:400` o se
   * carga una vez, con el mismo filtro antes de detectar y el guard de
   * re-entrada intacto. Con cobertura corta real se degrada con datos válidos
   * sin sellar la caché diaria como si el insumo fuera completo.
   *
   * Hotfix 50.5 (single-flight): `enclosingBarsKey` es la clave de barras que
   * está computando esta resolución. Si es la propia `bars:…:1D:ext:400`, la
   * carga de recuperación queda prohibida porque `getOrCompute` de esa clave
   * devolvería el vuelo pendiente de la operación (espera circular); en ese
   * caso se degrada con las cerradas ya disponibles.
   *
   * Si FMP está habilitado pero la consulta de eventos falló, devuelve las anclas
   * degradadas (`PIVOT + RVOL`) **sin** sellar la caché diaria, permitiendo recuperar
   * `EVENT` automáticamente al siguiente refresh tras el backoff corto.
   */
  private async resolveAutoAvwapAnchorsForUs(
    canonicalSymbol: string,
    dailyBarsHint: readonly Bar[] | null,
    nowSec: number,
    enclosingBarsKey: string,
  ): Promise<readonly AutoAvwapAnchor[]> {
    const cacheKey = `US:${canonicalSymbol}:${fmpEtDateKey(nowSec)}`;
    const cached = this.autoAvwapCache.peek(cacheKey);
    if (cached !== undefined) return cached.value;

    // Bloque 3: el hint solo sirve si llega a la ventana completa de cerradas.
    const closedHint =
      dailyBarsHint === null ? [] : filterClosedDailyBarsUs(dailyBarsHint, nowSec);
    const hintCoversWindow = closedHint.length >= AUTO_AVWAP_MIN_CLOSED_DAILY_BARS;

    // Re-entrada (computeBars anidado de 1D): calcular directo desde el hint
    // cerrado, sin caché ni cargas nuevas (evita la espera circular).
    if (this.autoAvwapResolveInFlight.has(cacheKey)) {
      const reentrant = await this.computeAutoAvwapAnchorsOutcome(
        canonicalSymbol,
        closedHint,
        nowSec,
      );
      return reentrant.anchors;
    }

    const daily400Key = `bars:${canonicalSymbol}:1D:ext:400`;
    // Hotfix: nunca esperar la propia clave SingleFlight en vuelo.
    const canLoadDailyWindow = enclosingBarsKey !== daily400Key;

    this.autoAvwapResolveInFlight.add(cacheKey);
    try {
      // Fuente única: hint suficiente, caché diaria de 400 o una sola carga.
      let dailyBars: readonly Bar[] = hintCoversWindow ? closedHint : [];
      if (dailyBars.length === 0 && canLoadDailyWindow) {
        const peeked = this.barsCache.peek(daily400Key)?.value;
        if (peeked !== undefined) {
          const cachedClosed = filterClosedDailyBarsUs(
            peeked.bars.map((bar) => ({
              time: bar.time,
              open: bar.open,
              high: bar.high,
              low: bar.low,
              close: bar.close,
              volume: bar.volume,
            })),
            nowSec,
          );
          if (cachedClosed.length > dailyBars.length) dailyBars = cachedClosed;
        }
      }
      if (dailyBars.length === 0 && canLoadDailyWindow) {
        const fetched = await this.getBars(canonicalSymbol, '1D', { visibleBars: 400 });
        const fetchedClosed = filterClosedDailyBarsUs(
          fetched.bars.map((bar) => ({
            time: bar.time,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: bar.volume,
          })),
          nowSec,
        );
        if (fetchedClosed.length > dailyBars.length) dailyBars = fetchedClosed;
      }
      if (dailyBars.length === 0 && !canLoadDailyWindow) {
        // Se está computando la propia ventana 1D:400: sin otra fuente posible
        // sin esperar el propio vuelo, se degrada con las cerradas disponibles.
        dailyBars = closedHint;
      }
      const outcome = await this.computeAutoAvwapAnchorsOutcome(canonicalSymbol, dailyBars, nowSec);
      assertJsonSafeSerialized(outcome.anchors);
      if (outcome.fmpFailed) {
        return outcome.anchors;
      }
      if (dailyBars.length < AUTO_AVWAP_MIN_CLOSED_DAILY_BARS) {
        // Cobertura corta real: degradación con datos válidos, sin sellar una
        // ventana incompleta durante el TTL diario.
        return outcome.anchors;
      }
      const sealed = await this.autoAvwapCache.getOrCompute(
        cacheKey,
        () => Promise.resolve(outcome.anchors),
      );
      return sealed.value;
    } finally {
      this.autoAvwapResolveInFlight.delete(cacheKey);
    }
  }

  /**
   * Pieza 50.5.1: calcula anclas y reporta si FMP falló al consultar los eventos.
   * Cualquier excepción del proveedor se captura aquí: la degradación es limpia a
   * `PIVOT + RVOL`, y jamás bloquea `/api/bars`.
   */
  private async computeAutoAvwapAnchorsOutcome(
    canonicalSymbol: string,
    dailyBars: readonly Bar[],
    nowSec: number,
  ): Promise<{ readonly anchors: readonly AutoAvwapAnchor[]; readonly fmpFailed: boolean }> {
    if (dailyBars.length === 0) {
      return { anchors: [], fmpFailed: false };
    }
    let events: readonly AutoAvwapEventInput[] = [];
    let fmpFailed = false;
    if (this.fmpHistoricalProviderEnabled) {
      try {
        const loaded = await this.loadAutoAvwapEventsForUs(canonicalSymbol, nowSec);
        events = loaded.events;
        fmpFailed = loaded.fmpFailed;
      } catch {
        fmpFailed = true;
      }
    }
    return { anchors: detectAutoAvwapAnchors(dailyBars, events), fmpFailed };
  }

  /**
   * Pieza 50.5.1: consulta eventos FMP **solo** con `fmpHistoricalProviderEnabled === true`.
   * Índices/ETFs usan el calendario macro plurianual (560 días, tramos ≤ 85 d, 1 sola
   * consulta diaria compartida); acciones individuales usan Earnings. Los eventos
   * futuros se filtran (`utcSec <= nowSec`) y un fallo (`available === false`) lanza un
   * error interno para no sellar la caché 24 h; un backoff corto de 5 min evita
   * tormentas de requests mientras la API está caída.
   */
  private async loadAutoAvwapEventsForUs(
    canonicalSymbol: string,
    nowSec: number,
  ): Promise<{ readonly events: readonly AutoAvwapEventInput[]; readonly fmpFailed: boolean }> {
    if (isIndexOrEtfSymbol(canonicalSymbol)) {
      const cacheKey = `fmp:macro-calendar-history:us:${fmpEtDateKey(nowSec)}`;
      if (this.isFmpEventBackoffActive(cacheKey)) {
        return { events: [], fmpFailed: true };
      }
      try {
        const result = await this.macroCalendarHistoryCache.getOrCompute(cacheKey, async () => {
          const res = await this.fmpClient.fetchUsMacroCalendar(nowSec, 560);
          if (!res.available) {
            throw new Error('AUTO_AVWAP_FMP_MACRO_UNAVAILABLE');
          }
          return res;
        });
        if (!result.value.available) {
          this.markFmpEventBackoff(cacheKey);
          return { events: [], fmpFailed: true };
        }
        const events = result.value.events
          .filter((event) => event.utcSec <= nowSec)
          .map((event) => ({
            utcSec: event.utcSec,
            label: event.kind,
            date: event.date,
            timeOfDay: 'bmo' as const,
          }));
        this.clearFmpEventBackoff(cacheKey);
        return { events, fmpFailed: false };
      } catch {
        this.markFmpEventBackoff(cacheKey);
        return { events: [], fmpFailed: true };
      }
    }

    const cacheKey = `fmp:earnings:${canonicalSymbol}`;
    if (this.isFmpEventBackoffActive(cacheKey)) {
      return { events: [], fmpFailed: true };
    }
    try {
      const result = await this.earningsCatalystCache.getOrCompute(cacheKey, async () => {
        const res = await this.fmpClient.fetchSymbolEarnings(canonicalSymbol, nowSec);
        if (!res.available) {
          throw new Error('AUTO_AVWAP_FMP_EARNINGS_UNAVAILABLE');
        }
        return res;
      });
      if (!result.value.available) {
        this.markFmpEventBackoff(cacheKey);
        return { events: [], fmpFailed: true };
      }
      const events = result.value.events
        .filter((event) => event.utcSec <= nowSec)
        .map((event) => ({
          utcSec: event.utcSec,
          label: 'Earnings',
          date: event.date,
          timeOfDay: event.timeOfDay ?? ('unknown' as const),
        }));
      this.clearFmpEventBackoff(cacheKey);
      return { events, fmpFailed: false };
    } catch {
      this.markFmpEventBackoff(cacheKey);
      return { events: [], fmpFailed: true };
    }
  }

  public async getUnusualTrades(options: {
    readonly symbol?: string;
    readonly ticker?: string;
    readonly root?: string;
    readonly limit?: number;
    readonly minPremium?: number;
    readonly forceRefresh?: boolean;
  } = {}): Promise<TerminalUnusualResponse> {
    const cleanSymbol =
      options.symbol === undefined || options.symbol.trim() === ''
        ? undefined
        : parseTerminalSymbol(options.symbol, this.secrets).referenceUnderlying;
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1_000);
    const cacheKey = `unusual:${cleanSymbol ?? ''}:${options.root ?? ''}:${options.ticker ?? ''}:${String(limit)}:${String(options.minPremium ?? '')}`;

    const result = await this.unusualCache.getOrCompute(
      cacheKey,
      () =>
        this.computeUnusualTrades({
          ...(cleanSymbol === undefined ? {} : { underlyingTicker: cleanSymbol }),
          ...(options.ticker === undefined ? {} : { ticker: options.ticker }),
          ...(options.root === undefined ? {} : { root: options.root }),
          ...(options.minPremium === undefined ? {} : { minPremium: options.minPremium }),
          limit,
        }),
      options.forceRefresh === undefined ? {} : { forceRefresh: options.forceRefresh },
    );
    return result.value;
  }

  private async computeUnusualTrades(params: {
    readonly underlyingTicker?: string;
    readonly ticker?: string;
    readonly root?: string;
    readonly limit: number;
    readonly minPremium?: number;
  }): Promise<TerminalUnusualResponse> {
    const apiKey = this.assertRestApiKey();
    const nowSec = Math.floor(this.nowMsFn() / 1_000);

    const loadOpts: LoadUnusualTradesOptions = {
      apiKey,
      fetchFn: this.fetchFn,
      ...(this.baseUrl === undefined ? {} : { baseUrl: this.baseUrl }),
      ...(params.ticker === undefined ? {} : { ticker: params.ticker }),
      ...(params.root === undefined ? {} : { root: params.root }),
      ...(params.underlyingTicker === undefined
        ? {}
        : { underlyingTicker: params.underlyingTicker }),
      ...(params.minPremium === undefined ? {} : { minPremium: params.minPremium }),
      limit: params.limit,
      maxPages: 2,
      defaultSharesPerContract: 100,
    };

    const res = await this.loadUnusualTradesFn(loadOpts);
    if (res.report.providerError !== null && res.trades.length === 0) {
      throw new RuntimeNoDataError(
        'PROVIDER_ERROR',
        redactSecrets(res.report.providerError.message, this.secrets),
        this.secrets,
        503,
      );
    }

    const trades: SerializedUnusualTradeRow[] = res.trades.map((t: UnusualTradeRecord) => ({
      ticker: t.ticker,
      underlyingTicker: t.underlyingTicker,
      root: t.root,
      rootKind: t.rootKind,
      contractType: t.contractType,
      strike: sanitizeFinite(t.strikePrice),
      expirationDate: t.expirationDate,
      time: t.time,
      timestampNs: t.subsecond.timestampNs,
      price: sanitizeFinite(t.price),
      size: sanitizeFinite(t.size),
      sharesPerContract: sanitizeFinite(t.sharesPerContract),
      notional: sanitizeFinite(t.notional),
      flags: [...t.flags.raw],
      exchange: sanitizeFinite(t.exchange),
      sequenceNumber: t.sequenceNumber,
    }));

    const payload: TerminalUnusualResponse = {
      status: trades.length > 0 ? 'OK' : 'NO_DATA',
      asOfUtcSec: nowSec,
      symbol: params.underlyingTicker ?? params.root ?? params.ticker ?? null,
      received: res.report.received,
      accepted: res.report.accepted,
      filteredOut: res.report.filteredOut,
      trades,
    };
    assertJsonSafeSerialized(payload);
    return payload;
  }

  /**
   * Obtiene y cachea barras diarias ajustadas (`1D`, últimas `lookbackBars` ruedas cerradas)
   * de Massive API para pares cuantitativos US/ADR (`/relaciones` y rotación sectorial).
   */
  public async getCachedDailyBars1d(
    rawSymbol: string,
    lookbackBars = 90,
    forceRefresh = false,
  ): Promise<CachedDailyBarsResult> {
    const cleanInput = rawSymbol.trim().toUpperCase();
    const boundedLookback = Math.min(Math.max(Math.trunc(lookbackBars), 20), 365);

    if (this.apiKey.trim() === '') {
      return {
        symbol: cleanInput,
        bars: [],
        error: 'MASSIVE_API_KEY not configured for 1D US relations',
        cacheHit: false,
      };
    }

    try {
      const symbol = parseTerminalSymbol(cleanInput, this.secrets).canonicalSymbol;
      const cacheKey = `us1d:${symbol}:${String(boundedLookback)}`;
      const cached = await this.daily1dCache.getOrCompute(
        cacheKey,
        async () => {
          const nowSec = Math.floor(this.nowMsFn() / 1_000);
          const res = await this.loadBarsFn({
            provider: 'massive',
            symbol,
            timeframe: '1D',
            visibleBars: boundedLookback,
            warmupBars: 0,
            rthOnly: false,
            maxPages: 2,
            now: nowSec,
            apiKey: this.restBatchApiKey(),
            fetchFn: this.fetchFn,
            ...(this.baseUrl === undefined ? {} : { baseUrl: this.baseUrl }),
          });
          const bars = res.bars.slice(-boundedLookback);
          if (bars.length === 0) {
            const reason =
              res.report.providerError?.message ??
              `No 1D bars available from Massive for ${symbol}`;
            throw new Error(reason);
          }
          return bars;
        },
        { forceRefresh },
      );

      return {
        symbol,
        bars: cached.value,
        error: null,
        cacheHit: cached.cacheHit,
      };
    } catch (err: unknown) {
      const msg = redactSecrets(
        extractErrorMessage(err, `Massive 1D bars failed for ${cleanInput}`),
        this.secrets,
      );
      return {
        symbol: cleanInput,
        bars: [],
        error: msg,
        cacheHit: false,
      };
    }
  }

  public async getCachedDailyBars1dBatch(
    symbols: readonly string[] = DEFAULT_RELATIONS_US_TICKERS,
    lookbackBars = 90,
    forceRefresh = false,
  ): Promise<ReadonlyMap<string, CachedDailyBarsResult>> {
    return fetchCachedUsDailyBars1dMap(this, symbols, lookbackBars, forceRefresh);
  }

  /**
   * Devuelve un mapa `ticker -> iv30d` (decimal, ej. `0.24` = 24%) leído únicamente
   * desde snapshots de cadenas de opciones ya cacheados en memoria, sin provocar
   * peticiones de red adicionales.
   */
  public getCachedIv30Map(
    extraSymbol?: string,
    extraIv30d?: number | null,
  ): ReadonlyMap<string, number> {
    const out = new Map<string, number>();
    const candidates = new Set<string>([
      ...US_EQUITY_UNIVERSE.map((u) => u.symbol),
      'BABA',
      'GLOB',
    ]);
    if (extraSymbol !== undefined && extraIv30d !== undefined && extraIv30d !== null && Number.isFinite(extraIv30d) && extraIv30d > 0) {
      out.set(extraSymbol.trim().toUpperCase(), extraIv30d);
    }
    for (const sym of candidates) {
      if (out.has(sym)) {
        continue;
      }
      const cached = this.snapshotCache.peek(`snapshot:${sym}`);
      const iv = cached?.value.volSurfaceSummary?.iv30d;
      if (iv !== undefined && iv !== null && Number.isFinite(iv) && iv > 0) {
        out.set(sym, iv);
      }
    }
    return out;
  }

  /** Pieza 44: lectura síncrona de snapshot US cacheado en memoria para GGAL Specialist. */
  public getCachedSnapshot(symbol: string): TerminalSnapshotResponse | null {
    const clean = symbol.trim().toUpperCase();
    if (clean === '') return null;
    return this.snapshotCache.peek(`snapshot:${clean}`)?.value ?? null;
  }

  /**
   * Calcula y cachea la analítica completa de las ~73 acciones líquidas de EE.UU.
   * usando un batch `/v3/snapshot` + barras diarias `1D` cacheadas (hasta 265 ruedas).
   */
  public async getUsEquityPanelAnalytics(
    forceRefresh = false,
  ): Promise<EquityPanelAnalyticsDto> {
    const cached = await this.usPanelCache.getOrCompute(
      'us:equity:panel',
      async () => {
        const nowSec = Math.floor(this.nowMsFn() / 1_000);
        const errors: string[] = [];
        const universeSymbols = US_EQUITY_UNIVERSE.map((u) => u.symbol);

        if (!this.apiKey) {
          return {
            asOfUtcSec: nowSec,
            benchmarkSymbol: 'SPY',
            panelLabel: 'Panel EE.UU. (Massive 1D)',
            currency: 'USD' as const,
            rows: [],
            panelVolume40d: [],
            volumeAvg40dM: null,
            volumeShareBreakdown: [],
            panelVolHistory: [],
            topGainers: [],
            topLosers: [],
            errors: ['Falta MASSIVE_API_KEY en el servidor'],
          };
        }

        const baseTransport = {
          apiKey: this.restBatchApiKey(),
          fetchFn: this.fetchFn,
          ...(this.baseUrl === undefined ? {} : { baseUrl: this.baseUrl }),
        };

        const unifiedTickers = [
          ...new Set([
            ...universeSymbols,
            'SPY',
            'QQQ',
            'TLT',
            'HYG',
            'LQD',
            'XLY',
            'I:SPX',
            'I:VIX',
            'I:SKEW',
            'I:VVIX',
            'I:OVX',
            'I:DXY',
          ]),
        ];

        const [v2StocksRes, unifiedRes, barsResults] = await Promise.all([
          this.getUsStocksV2Batch(universeSymbols, forceRefresh),
          this.unifiedCache
            .getOrCompute(
              `unified:${[...unifiedTickers].sort().join(',')}`,
              () =>
                this.loadUnifiedSnapshotFn({
                  ...baseTransport,
                  tickers: unifiedTickers,
                  limit: 250,
                  maxPages: 1,
                }),
              { forceRefresh },
            )
            .then((r) => r.value)
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : 'Massive unified snapshot failed';
              errors.push(redactSecrets(msg, this.secrets));
              return null;
            }),
          mapWithConcurrency(universeSymbols, US_PANEL_CONCURRENCY_LIMIT, (sym) =>
            this.getCachedDailyBars1d(sym, 265, forceRefresh),
          ),
        ]);

        const barsBySymbol = new Map<string, readonly Bar[]>();
        for (const res of barsResults) {
          const closedBars = normalizeClosedDailyBarsUs(res.bars, nowSec).slice(-US_PANEL_MAX_CLOSED_BARS);
          barsBySymbol.set(res.symbol, closedBars);
          if (res.error !== null) {
            errors.push(`Massive 1D ${res.symbol}: ${res.error}`);
          }
        }

        const unifiedBySymbol = new Map<string, UnifiedStockSnapshot>();
        if (unifiedRes !== null) {
          for (const s of unifiedRes.stocks) {
            unifiedBySymbol.set(s.ticker.toUpperCase(), s);
          }
        }

        const benchmarkBars = barsBySymbol.get('SPY') ?? [];
        const cachedIvMap = this.getCachedIv30Map();
        const rows: EquityPanelRowDto[] = [];
        const seriesInputs: Array<{
          readonly symbol: string;
          readonly name: string;
          readonly color: string;
          readonly bars: readonly Bar[];
        }> = [];

        for (const meta of US_EQUITY_UNIVERSE) {
          const bars = barsBySymbol.get(meta.symbol) ?? [];
          const resolvedQuote = resolveStockSnapshotWith1dFallback({
            ticker: meta.symbol,
            v2: v2StocksRes.map.get(meta.symbol),
            v3: unifiedBySymbol.get(meta.symbol),
            bars1d: bars,
            cachedIvMap,
          });
          const liveLast = resolvedQuote.price;
          const livePrevClose = resolvedQuote.previousClose;
          const liveLow = resolvedQuote.dayLow;
          const liveHigh = resolvedQuote.dayHigh;
          const liveChangePct = resolvedQuote.changePct;
          const liveVolumeM = resolvedQuote.volumeM;

          const metrics = computeEquityRiskAndReturnMetrics({
            bars,
            benchmarkBars,
            liveLast,
            livePrevClose,
            liveLow,
            liveHigh,
            liveChangePct,
            liveVolumeM,
            asOfUtcSec: nowSec,
          });

          const rawIv = cachedIvMap.get(meta.symbol) ?? null;
          const iv30d =
            rawIv !== null && Number.isFinite(rawIv) && rawIv > 0
              ? sanitizeFinite(rawIv * 100)
              : null;
          const tradedVolumeUsd =
            resolvedQuote.tradedVolumeUsd ??
            (metrics.volumeM !== null && Number.isFinite(metrics.volumeM)
              ? sanitizeFinite(metrics.volumeM * 1_000_000)
              : null);

          rows.push({
            symbol: meta.symbol,
            name: meta.name,
            sector: meta.sector,
            panel: meta.panel,
            color: meta.color,
            last: metrics.last,
            prevClose: metrics.prevClose,
            dayLow: metrics.dayLow,
            dayHigh: metrics.dayHigh,
            dayRangePos: metrics.dayRangePos,
            volumeM: metrics.volumeM,
            tradedVolumeUsd,
            return1dPct: metrics.return1dPct,
            return30dPct: metrics.return30dPct,
            returnYtdOr252dPct: metrics.returnYtdOr252dPct,
            realizedVol30dPct: metrics.realizedVol30dPct,
            beta: metrics.beta,
            avgVolume40dM: metrics.avgVolume40dM,
            iv30d,
            hasUsOptions: meta.hasUsOptions,
          });

          if (bars.length > 0) {
            seriesInputs.push({
              symbol: meta.symbol,
              name: meta.name,
              color: meta.color,
              bars,
            });
          }
        }

        const panelSeries = computePanelVolumeAndVolSeries({
          items: seriesInputs,
          asOfUtcSec: nowSec,
          maxVolumeDays: 40,
          rollingVolWindow: 20,
        });

        const topGainers = [...rows]
          .filter((r) => r.return1dPct !== null && r.return1dPct > 0)
          .sort((a, b) => (b.return1dPct ?? 0) - (a.return1dPct ?? 0))
          .slice(0, 8);
        const topLosers = [...rows]
          .filter((r) => r.return1dPct !== null && r.return1dPct < 0)
          .sort((a, b) => (a.return1dPct ?? 0) - (b.return1dPct ?? 0))
          .slice(0, 8);

        return {
          asOfUtcSec: nowSec,
          benchmarkSymbol: 'SPY',
          panelLabel: 'EE.UU. · NYSE / NASDAQ (Massive 1D)',
          currency: 'USD' as const,
          rows,
          panelVolume40d: panelSeries.panelVolume40d,
          volumeAvg40dM: panelSeries.volumeAvg40dM,
          volumeShareBreakdown: panelSeries.volumeShareBreakdown,
          panelVolHistory: panelSeries.panelVolHistory,
          topGainers,
          topLosers,
          errors,
        };
      },
      { forceRefresh },
    );
    this.lastUsPanelBase = cached.value;
    return this.overlayLiveUsPanel(cached.value);
  }

  /**
   * Pieza 46: consulta Earnings (FMP Enterprise) + calendario macro US (`FOMC` / `CPI`)
   * con caché diario de 24 horas y degradación honesta ante ausencia de clave o datos.
   */
  public async getSymbolCatalysts(
    rawSymbol: string,
    options: { readonly forceRefresh?: boolean; readonly nowUtcSec?: number } = {},
  ): Promise<SerializedSymbolCatalystsDto> {
    const parsed = parseTerminalSymbol(rawSymbol, this.secrets);
    const canonicalSymbol = parsed.canonicalSymbol;
    const nowSec =
      options.nowUtcSec !== undefined && Number.isFinite(options.nowUtcSec)
        ? Math.floor(options.nowUtcSec)
        : Math.floor(this.nowMsFn() / 1_000);
    const forceRefresh = options.forceRefresh === true;

    if (!this.fmpHistoricalProviderEnabled) {
      const payload: SerializedSymbolCatalystsDto = {
        symbol: canonicalSymbol,
        asOfUtcSec: nowSec,
        available: false,
        nextEarnings: null,
        lastEarnings: null,
        macroEvents: [],
        earningsSource: null,
        macroSource: null,
        reason: 'FMP Enterprise no configurado o deshabilitado',
        cacheHit: false,
      };
      assertJsonSafeSerialized(payload);
      return payload;
    }

    const strippedRoot = canonicalSymbol.startsWith('I:')
      ? canonicalSymbol.slice(2)
      : canonicalSymbol;
    const isIndexSymbol =
      canonicalSymbol.startsWith('I:') || KNOWN_INDEX_ROOTS.has(strippedRoot);

    const macroPromise = this.macroCalendarCache.getOrCompute(
      'fmp:macro-calendar:us',
      () => this.fmpClient.fetchUsMacroCalendar(nowSec),
      { forceRefresh },
    );

    const earningsPromise = isIndexSymbol
      ? Promise.resolve<{
          readonly value: FmpSymbolEarningsResult;
          readonly cacheHit: boolean;
        } | null>(null)
      : this.earningsCatalystCache.getOrCompute(
          `fmp:earnings:${canonicalSymbol}`,
          () => this.fmpClient.fetchSymbolEarnings(canonicalSymbol, nowSec),
          { forceRefresh },
        );

    const [macroCached, earningsCached] = await Promise.all([macroPromise, earningsPromise]);
    const macroRes = macroCached.value;
    const earningsRes = earningsCached?.value ?? null;

    const available = macroRes.available || (earningsRes !== null && earningsRes.available);
    const reason =
      earningsRes !== null && !earningsRes.available && earningsRes.reason !== null
        ? earningsRes.reason
        : !macroRes.available && macroRes.reason !== null
          ? macroRes.reason
          : null;

    const payload: SerializedSymbolCatalystsDto = {
      symbol: canonicalSymbol,
      asOfUtcSec: nowSec,
      available,
      nextEarnings: earningsRes?.nextEarnings ?? null,
      lastEarnings: earningsRes?.lastEarnings ?? null,
      macroEvents: macroRes.events,
      earningsSource: earningsRes?.source ?? null,
      macroSource: macroRes.source ?? null,
      reason: reason === null ? null : redactSecrets(reason, this.secrets),
      cacheHit: macroCached.cacheHit && (earningsCached === null || earningsCached.cacheHit),
    };
    assertJsonSafeSerialized(payload);
    return payload;
  }
}

let sharedDefaultMarketRuntime: MarketRuntime | null = null;

function registerSharedMarketRuntime(runtime: MarketRuntime): void {
  sharedDefaultMarketRuntime = runtime;
}

export function getSharedMarketRuntime(): MarketRuntime | null {
  return sharedDefaultMarketRuntime;
}

export async function fetchCachedUsDailyBars1dMap(
  runtime: Pick<MarketRuntime, 'getCachedDailyBars1d'>,
  symbols: readonly string[] = DEFAULT_RELATIONS_US_TICKERS,
  lookbackBars = 90,
  forceRefresh = false,
): Promise<ReadonlyMap<string, CachedDailyBarsResult>> {
  const unique = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter((s) => s !== ''))];
  const entries = await Promise.all(
    unique.map(async (symbol) => {
      const res = await runtime.getCachedDailyBars1d(symbol, lookbackBars, forceRefresh);
      return [res.symbol, res] as const;
    }),
  );
  return new Map(entries);
}
