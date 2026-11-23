import {
  classifyRawOiValue,
  explicitVolumeOi,
  mergeOptionFieldProvenance,
  missingOi,
  resolveArExposureOiQuality,
  resolveContractMultiplier,
  resolveOiSourcePrecedence,
  type ContractMultiplierSource,
  type DealerSignBasis,
  type GexComputationStatus,
  type OiFieldProvenance,
  type OiQualityTier,
  type OiSourceConflictRecord,
  type OptionFieldProvenanceMap,
} from '../core/options/oiProvenance.js';
export type { OiFieldProvenance, OptionFieldProvenanceMap } from '../core/options/oiProvenance.js';
import { OPTION_PREFIX_TO_UNDERLYING } from '../core/ggal/anexoBIdentity.js';
import {
  resolveBymaOptionContract,
  type BymaContractMetadataRecord,
  type BymaStrikeNormalizationEvidence,
  type BymaStrikeResolutionStatus,
  type BymaStrikeSource,
  type ResolvedBymaOptionContract,
} from '../core/ggal/bymaContractResolver.js';
export type {
  BymaContractMetadataRecord,
  BymaStrikeNormalizationEvidence,
  BymaStrikeResolutionStatus,
  BymaStrikeSource,
} from '../core/ggal/bymaContractResolver.js';
/**
 * Cargador e integrador cuantitativo para el Mercado Argentino en Tiempo Real / Diferido
 * y Macro Local (`src/server/argentinaMarketLoader.ts`).
 *
 * Fuentes públicas gratuitas (sin credenciales):
 *  - Data912 (`https://data912.com`):
 *      /live/mep, /live/ccl, /live/usa_adrs, /live/usa_stocks,
 *      /live/arg_stocks, /live/arg_options, /live/arg_cedears,
 *      /live/arg_notes, /live/arg_corp, /live/arg_bonds,
 *      /historical/stocks/{ticker}, /historical/cedears/{ticker}, /historical/bonds/{ticker}
 *    Con limitador de ritmo configurable (<= 120 req/min por defecto).
 *  - Open BYMA (`https://open.bymadata.com.ar/vanoms-be-core/rest/api/bymadata/free/`):
 *      leading-equity, general-equity, cedears, public-bonds, index-summary (POST JSON),
 *      con tolerancia a timeouts/respuestas vacías fuera de rueda y degradación explícita.
 *  - BCRA API v4.0 (`https://api.bcra.gob.ar/estadisticas/v4.0/Monetarias`) +
 *    ArgentinaDatos (`https://api.argentinadatos.com/v1/`):
 *      A3500, BADLAR, TAMAR, TPM, CER, UVA, Reservas, Base Monetaria, Inflación mensual e
 *      interanual, Dólares de mercado y Riesgo País (EMBI+).
 *
 * Motores cuantitativos:
 *  - Opciones BYMA americanas con **Bjerksund-Stensland (2002)** (`src/core/options/american.ts`),
 *    lote de 100 acciones, liquidación prima `T+0`, corte operativo `15:30 ART` al vencimiento,
 *    superficie PCHIP/SVI (`src/core/options/volSurface.ts`, `volMetrics.ts`), exposición
 *    dealer GEX/DEX/Walls/Gamma Flip (`src/core/options/exposure.ts`), densidad $\mathbb{Q}$ vs
 *    $\mathbb{P}$ deflactada y evaluador "Las 3 maneras de jugarla" neto de derechos BYMA + 21% IVA.
 *  - Bonos soberanos argentinos (flujos reales de prospecto Decreto 676/2020) con XIRR (TIR),
 *    Duration Modificada y Paridad Técnica calculadas numéricamente sin valores inventados.
 *
 * Política Zero Silent Fallbacks:
 *  - Cualquier métrica no calculable se serializa como `null` (jamás se inventan precios ni tasas).
 *  - Si una fuente falla o entrega datos incompletos, se reporta el `feedStatus` real
 *    (`LIVE`, `DIFERIDO_20M`, `PARTIAL`, `NO_DATA`) y `providerErrors`.
 */

import { calculateEma, computeEmaSuite } from '../core/ema.js';
import {
  detectAutoAvwapAnchors,
  type AutoAvwapAnchor,
} from '../core/autoAvwap.js';
import {
  computeHmaSeries,
  computeSmaSeries,
  evaluateMtfStructure,
} from '../core/microstructure/mtfStructure.js';
import { computeWilderRsiSeries } from '../core/microstructure/divergences.js';
import {
  BYMA_MARKET_TZ,
  computeAnchoredVwapSeries,
  computeSessionVwapSeries,
  getSessionDateKey,
} from '../core/ggal/technicalIndicators.js';
import type { GgalChartBarPoint } from '../core/ggal/institutionalContracts.js';
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
import {
  greeksAmericanFiniteDiffOrAnalytical,
  priceAmericanBjerksund2002,
  solveImpliedVolAmericanDetailed,
  type AmericanIvStatus,
  type ImpliedVolResolution,
} from '../core/options/american.js';
import { MIN_CONTRACTUAL_EXPIRY_SEC } from '../core/options/blackScholes.js';
import {
  resolveArOiProvenance,
  type ArOiProvenanceInput,
} from '../core/exposureTrace.js';
import {
  computeDealerExposure,
  type ExposureContractInput,
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
  type FlowAdjustedGexResult,
  type GexCharmPinResult,
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
  computeSyntheticImpliedRates,
  evaluateBuyWrite,
  evaluateCalendarRoll,
  evaluateConversionReversal,
  type BuyWriteResult,
  type CalendarRollResult,
  type ConversionReversalResult,
  type SyntheticImpliedRatesResult,
} from '../core/options/syntheticRates.js';
import { computeSliceVolMetrics } from '../core/options/volMetrics.js';
import { buildVolSlice, evaluateSliceIvAtStrike, type VolQuoteInput } from '../core/options/volSurface.js';
import {
  buildExpectedConeAndLognormalSummary,
  buildNormalizedMoneynessMatrix,
  buildSeparatedOtmSmile,
  computeActiveExpiryVrpAndRegime,
  computeCclVolAndAdrCorrelation,
  computeDualBymaVsOpraSurface,
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
import { IV_CAP_DECIMAL, expectedMoveSigma } from '../core/options/zeroDteFixes.js';
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
import type { Bar } from '../core/types.js';
import type { FetchResponse, Timeframe } from '../data/types.js';
import { assertJsonSafeSerialized } from '../core/terminal/serializer.js';
import {
  BmbBridgeClient,
  collectBrokerSecretsFromEnv,
  computeCaucionTeaEffectivePct,
  computeOrderBookL2Metrics,
  computeSpreadVsBadlarBps,
  isBmbInversionesSignalRConfigured,
  PrimaryRofexClient,
  type ArBrokerPositionsResponse,
  type BmbBridgeSnapshotDto,
  type BmbConnectorHealthDto,
  type BmbOptionRowDto,
  type BmbTradeRowDto,
  type PrimaryConnectorHealthDto,
  type PrimaryDlrContractDto,
  type OrderBook5LevelsDto,
} from './primaryRofexLoader.js';
import {
  computeEquityRiskAndReturnMetrics,
  computePanelVolumeAndVolSeries,
  DEFAULT_RELATIONS_US_TICKERS,
  getSharedMarketRuntime,
  MarketRuntime,
  parseTimeframe,
  RuntimeNoDataError,
  US_EQUITY_META_MAP,
  US_LIQUID_OPTION_UNDERLYINGS,
  type CachedDailyBarsResult,
  type EquityPanelAnalyticsDto,
  type EquityPanelRowDto,
  type TerminalBarsResponse,
  type TerminalSnapshotResponse,
} from './marketRuntime.js';
import { redactSecrets, SingleFlightRuntimeCache } from './runtimeCache.js';
import { emptyFeedTelemetrySnapshot } from './feedsHealthMonitor.js';
import { BmbFeedAdapter, isBymaL2SessionUtcSec } from './bmbFeedAdapter.js';
import { IolFeedAdapter } from './iolFeedAdapter.js';
import { resolveArIntradayFallback } from './wsCoalescerAndStability.js';
import { normalizeStockDetailOrderBook } from '../core/stockDetailStability.js';
import { ArRealtimeBus, realtimeQuoteKey } from './arRealtimeBus.js';
import type { MarketTickQuote } from './massiveStocksStream.js';

export type FeedStatus = 'LIVE' | 'EOD_CIERRE' | 'DIFERIDO_20M' | 'PARTIAL' | 'NO_DATA';

export interface ArHttpRequestInit {
  readonly method?: 'GET' | 'POST';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs?: number;
}

export type ArHttpFn = (url: string, init?: ArHttpRequestInit) => Promise<FetchResponse>;

export type UsRuntimeAdapter = Pick<MarketRuntime, 'getCachedDailyBars1d'> &
  Partial<
    Pick<
      MarketRuntime,
      | 'getSnapshot'
      | 'getUsEquityPanelAnalytics'
      | 'getCachedIv30Map'
      | 'getCachedDailyBars1dBatch'
      | 'getBars'
      | 'attachGgalArsTickSource'
      | 'getGgalTickEngine'
    >
  >;

export interface ArgentinaRuntimeDeps {
  readonly fetchFn?: ArHttpFn;
  readonly nowMsFn?: () => number;
  readonly cacheTtlMs?: number;
  readonly minData912IntervalMs?: number;
  readonly timeoutMs?: number;
  readonly secrets?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly primaryClient?: PrimaryRofexClient;
  readonly bmbClient?: BmbBridgeClient | BmbFeedAdapter;
  readonly iolClient?: IolFeedAdapter;
  readonly realtimeBus?: ArRealtimeBus;
  readonly data912BaseUrl?: string;
  readonly openBymaBaseUrl?: string;
  readonly bcraBaseUrl?: string;
  readonly argentinaDatosBaseUrl?: string;
  readonly nyfedBaseUrl?: string;
  readonly usRuntime?: UsRuntimeAdapter;
  readonly usDailyBarsFn?: (
    symbol: string,
    lookbackBars?: number,
    forceRefresh?: boolean,
  ) => Promise<CachedDailyBarsResult>;
  readonly arHolidays?: readonly string[];
}

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
  readonly quoteAsOfUtcSec?: number | null;
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
  readonly quoteAsOfUtcSec?: number | null;
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
  readonly quoteAsOfUtcSec?: number | null;
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
  readonly sourceMode?: 'LIVE_BMB' | 'LIVE_IOL' | 'DATA912';
  readonly data912Status: 'OK' | 'ERROR';
  readonly openBymaStatus: 'OK' | 'DEGRADED';
  readonly marketState: 'ABIERTO' | 'SUBASTA' | 'CERRADO' | 'PREMARKET';
  readonly marketStateLabel: string;
  readonly providerErrors: readonly string[];
  readonly globalIndicators: readonly GlobalIndicatorDto[];
  readonly mepMedian: number | null;
  readonly cclMedian: number | null;
  readonly mepCclGapPct: number | null;
  readonly atmIvPct?: number | null;
  readonly atmIvExpiryCode?: string | null;
  readonly atmIvExpiryLabel?: string | null;
  readonly atmIvDaysToExpiry?: number | null;
  readonly atmIvRateTnaPct?: number | null;
  readonly mervalStocks: readonly ArStockDto[];
  readonly generalPanelStocks: readonly ArStockDto[];
  readonly cedears: readonly ArStockDto[];
  readonly mepCclMatrix: readonly MepCclArbitrageRow[];
}

export interface ArSyntheticUsdFutureDto {
  readonly contract: string;
  readonly maturity: string;
  readonly expiryUtcSec: number;
  readonly days: number;
  readonly spotA3500: number;
  readonly forwardPrice: number;
  readonly impliedDevalPct: number;
  readonly temPct: number;
  readonly tnaPct: number;
  readonly teaPct: number;
  readonly arsRateTnaPct: number;
  readonly arsRateSource: string;
  readonly usdRatePct: number;
  readonly usdRateSource: string;
  readonly spreadVsCclPct: number | null;
  readonly badge: 'SINTÉTICO IMPLÍCITO';
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
    readonly plazoFijoTna: number | null;
    readonly sofrUsdTna?: number | null;
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
  readonly syntheticFutures?: readonly ArSyntheticUsdFutureDto[];
  readonly rofxFutures?: readonly PrimaryDlrContractDto[];
  readonly rofxSpotA3500?: number | null;
  readonly rofxSpotSource?: 'A3500_BCRA' | 'DLR_SPOT' | 'NONE';
}

export interface ArCaucionCurveRowDto {
  readonly termDays: number;
  readonly label: string;
  readonly currency: 'ARS' | 'USD';
  readonly tnaWeighted: number | null;
  readonly teaEffective: number | null;
  readonly bidTna: number | null;
  readonly askTna: number | null;
  readonly volumeArs: number | null;
  readonly spreadVsBadlarBps: number | null;
  readonly referenceInstrument: string;
  readonly originLabel: string;
  readonly source: 'PRIMARY_ECO_WS' | 'BMB_HOMEBROKER' | 'IOL_REST' | 'DATA912_CAUCION' | 'BCRA_LECAP_REF';
  readonly asOfUtcSec: number | null;
}

export interface ArMonitoringResponse {
  readonly asOfUtcSec: number;
  readonly feedStatus: FeedStatus;
  readonly sourceMode?: 'LIVE_BMB' | 'LIVE_IOL' | 'DATA912';
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
  readonly cauciones?: readonly ArCaucionCurveRowDto[];
  readonly caucionesStatus?: 'LIVE_PRIMARY' | 'LIVE_BMB' | 'REFERENCE_BCRA_LECAP' | 'NO_DATA';
  readonly bmbHealth?: BmbConnectorHealthDto;
  readonly arPanelAnalytics?: EquityPanelAnalyticsDto | null;
  readonly usEquityPanel?: EquityPanelAnalyticsDto | null;
}

export interface ArLiveMarketSnapshot {
  readonly overview: ArOverviewResponse | null;
  readonly monitoring: ArMonitoringResponse | null;
  readonly quotes: readonly MarketTickQuote[];
  readonly cauciones: readonly ArCaucionCurveRowDto[];
  readonly futures: readonly PrimaryDlrContractDto[];
  readonly futuresSource: 'PRIMARY_WS' | 'PRIMARY_REST' | 'NONE';
  readonly sourceMode: 'LIVE_PRIMARY' | 'LIVE_BMB' | 'LIVE_IOL' | 'DATA912' | 'NO_DATA';
  readonly bmbHealth: BmbConnectorHealthDto | null;
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

/**
 * Pieza 38: DTO completo de velas reales en ARS para `GET /api/bars` cuando el
 * símbolo pertenece al universo argentino. Misma forma que
 * `TerminalBarsResponse` (US) con campos aditivos `market`/`currency` para
 * desambiguar NVDA CEDEAR (ARS) vs NVDA US (USD) en el cliente.
 */
export type ArTerminalBarsResponse = TerminalBarsResponse & {
  readonly market: 'AR';
  readonly currency: 'ARS';
  /** Pieza 40: fallback explícito 1m -> 1D para activos sin velas BYMA 1m. */
  readonly requestedTimeframe?: Timeframe;
  readonly effectiveTimeframe?: Timeframe;
  readonly fallbackReason?: string;
  /**
   * Pieza 50.5: anclas institucionales Auto-AVWAP en ARS (Data912 1D), cacheadas
   * por día `AR:${symbol}:${artDateKey}`. Degradación limpia a `PIVOT + RVOL`
   * (sin FMP para BYMA/CEDEARs).
   */
  readonly autoAvwapAnchors?: readonly AutoAvwapAnchor[];
};

export type JsonSafe<T> = T extends number
  ? number | null
  : T extends readonly (infer U)[]
    ? readonly JsonSafe<U>[]
    : T extends object
      ? { readonly [K in keyof T]: JsonSafe<T[K]> }
      : T;

export interface ArStockInstitutionalEnginesDto {
  readonly atr14: number | null;
  readonly cvdSlopeSign: number | null;
  readonly volumeProfile: JsonSafe<VolumeProfileAmtResult> | null;
  readonly nakedPocs: JsonSafe<TrackNakedPocsResult> | null;
  readonly fvgs: JsonSafe<QuantitativeFvgResult> | null;
  readonly orderBlocks: JsonSafe<FreshOrderBlockResult> | null;
  readonly relativeStrength: JsonSafe<RelativeStrengthAndCatalystsResult> | null;
  readonly confluenceClusters: JsonSafe<SpatialConfluenceResult> | null;
}

export interface ArOptionsTickAggressionDto {
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

export interface ArOptionsQuantEnginesDto {
  readonly orderFlowArs: JsonSafe<SignedOptionsOrderFlowResult> | null;
  readonly agresionTicks?: JsonSafe<ArOptionsTickAggressionDto> | null;
  readonly netDirectionalPremiumUsdCcl: number | null;
  readonly callNetPremiumCvdUsdCcl: number | null;
  readonly putNetPremiumCvdUsdCcl: number | null;
  readonly volOiAnomalies: JsonSafe<VolOiAnomalyDetectionResult> | null;
  readonly flowAdjustedGex: JsonSafe<FlowAdjustedGexResult> | null;
  readonly gexCharmPin: JsonSafe<GexCharmPinResult> | null;
  readonly qDistribution: JsonSafe<RiskNeutralDistributionResult> | null;
  readonly pDistribution: JsonSafe<EmpiricalDistributionResult> | null;
  readonly pqDivergence: JsonSafe<PqLevelDivergenceResult> | null;
  readonly volCone: JsonSafe<VolConeAndRankResult> | null;
  readonly syntheticRates: JsonSafe<SyntheticImpliedRatesResult> | null;
  readonly conversionReversal: JsonSafe<ConversionReversalResult> | null;
  readonly buyWrite: JsonSafe<BuyWriteResult> | null;
  readonly calendarRoll: JsonSafe<CalendarRollResult> | null;
  readonly structureOptimizerBullish: JsonSafe<OptimizeOptionStructuresResult> | null;
  readonly structureOptimizerBearish: JsonSafe<OptimizeOptionStructuresResult> | null;
  readonly structureCostPercentile: JsonSafe<StructureCostPercentileResult> | null;
  readonly confluenceClusters: JsonSafe<SpatialConfluenceResult> | null;
  readonly volAnalyticsSuite?: JsonSafe<VolAnalyticsSuiteResult> | null;
}

export interface ArStockDetailIndicatorOverlays {
  readonly ema9: readonly (number | null)[];
  readonly ema21: readonly (number | null)[];
  readonly ema50: readonly (number | null)[];
  readonly ema200: readonly (number | null)[];
  readonly sessionVwap: readonly (number | null)[];
  readonly sessionVwapSupported: boolean;
  readonly avwap: readonly (number | null)[];
  readonly avwapUpper1: readonly (number | null)[];
  readonly avwapLower1: readonly (number | null)[];
  readonly avwapUpper2: readonly (number | null)[];
  readonly avwapLower2: readonly (number | null)[];
  readonly avwapAnchorAvailable: boolean;
  readonly avwapAnchorMode: 'MONTH_START';
  readonly avwapAnchorUtcSec: number | null;
}

function barsToGgalChartPoints(bars: readonly Bar[]): readonly GgalChartBarPoint[] {
  return bars.map((bar) => ({
    timeSec: bar.time,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  }));
}

function sanitizeIndicatorSeries(values: readonly (number | undefined)[]): readonly (number | null)[] {
  return values.map((value) => sanitizeFinite(value ?? Number.NaN));
}

function alignPointsToBars(
  bars: readonly Bar[],
  points: readonly { readonly timeSec: number; readonly value: number }[],
): readonly (number | null)[] {
  const byTime = new Map(points.map((point) => [point.timeSec, point.value] as const));
  return bars.map((bar) => sanitizeFinite(byTime.get(bar.time) ?? Number.NaN));
}

function alignBandPointsToBars(
  bars: readonly Bar[],
  points: readonly {
    readonly timeSec: number;
    readonly avwap: number;
    readonly plus1Sigma: number;
    readonly minus1Sigma: number;
    readonly plus2Sigma: number;
    readonly minus2Sigma: number;
  }[],
): {
  readonly avwap: readonly (number | null)[];
  readonly upper1: readonly (number | null)[];
  readonly lower1: readonly (number | null)[];
  readonly upper2: readonly (number | null)[];
  readonly lower2: readonly (number | null)[];
} {
  const byTime = new Map(points.map((point) => [point.timeSec, point] as const));
  return {
    avwap: bars.map((bar) => sanitizeFinite(byTime.get(bar.time)?.avwap ?? Number.NaN)),
    upper1: bars.map((bar) => sanitizeFinite(byTime.get(bar.time)?.plus1Sigma ?? Number.NaN)),
    lower1: bars.map((bar) => sanitizeFinite(byTime.get(bar.time)?.minus1Sigma ?? Number.NaN)),
    upper2: bars.map((bar) => sanitizeFinite(byTime.get(bar.time)?.plus2Sigma ?? Number.NaN)),
    lower2: bars.map((bar) => sanitizeFinite(byTime.get(bar.time)?.minus2Sigma ?? Number.NaN)),
  };
}

function buildArStockDetailOverlays(
  bars: readonly Bar[],
  timeframe: Timeframe,
): ArStockDetailIndicatorOverlays {
  const indicatorWindowStart = Math.max(0, bars.length - 250);
  const indicatorWindow = bars.slice(indicatorWindowStart);
  const indicatorChartPoints = barsToGgalChartPoints(indicatorWindow);
  const emaCloses = indicatorWindow.map((bar) => bar.close);
  const emaSuite = computeEmaSuite(emaCloses);
  const sessionVwapPoints =
    timeframe === '1D' ? [] : computeSessionVwapSeries(indicatorChartPoints, BYMA_MARKET_TZ);

  const lastBar = bars[bars.length - 1];
  const sessionDateKeys = bars.map((bar) => getSessionDateKey(bar.time, BYMA_MARKET_TZ));
  let anchorBarIndex = -1;
  if (lastBar !== undefined) {
    const monthKey = sessionDateKeys.at(-1)?.slice(0, 7) ?? null;
    anchorBarIndex = monthKey === null ? -1 : sessionDateKeys.findIndex((dateKey) => dateKey.slice(0, 7) === monthKey);
  }
  const anchorBar = anchorBarIndex >= 0 ? bars[anchorBarIndex] : undefined;
  const anchorTimeSec = anchorBar?.time ?? null;
  // AVWAP se calcula sobre la ventana operativa reciente: el ancla de mes/año/click
  // siempre cae dentro de las últimas 250 ruedas para 1D y 1000 velas intradiarias.
  const avwapWindowStart = Math.max(0, bars.length - 250);
  const avwapWindow = bars.slice(avwapWindowStart);
  const avwapChartPoints = barsToGgalChartPoints(avwapWindow);
  const avwapPoints =
    anchorTimeSec === null ? [] : computeAnchoredVwapSeries(avwapChartPoints, anchorTimeSec);
  const avwapBands = alignBandPointsToBars(avwapWindow, avwapPoints);
  const avwapLeadingNulls = Array.from({ length: avwapWindowStart }, () => null);

  const emaLeadingNulls = Array.from({ length: indicatorWindowStart }, () => null);
  return {
    ema9: [...emaLeadingNulls, ...sanitizeIndicatorSeries(emaSuite[9])],
    ema21: [...emaLeadingNulls, ...sanitizeIndicatorSeries(emaSuite[21])],
    ema50: [...emaLeadingNulls, ...sanitizeIndicatorSeries(emaSuite[50])],
    ema200: [...emaLeadingNulls, ...sanitizeIndicatorSeries(emaSuite[200])],
    sessionVwap: alignPointsToBars(bars, sessionVwapPoints),
    sessionVwapSupported: timeframe !== '1D',
    avwap: [...avwapLeadingNulls, ...avwapBands.avwap],
    avwapUpper1: [...avwapLeadingNulls, ...avwapBands.upper1],
    avwapLower1: [...avwapLeadingNulls, ...avwapBands.lower1],
    avwapUpper2: [...avwapLeadingNulls, ...avwapBands.upper2],
    avwapLower2: [...avwapLeadingNulls, ...avwapBands.lower2],
    avwapAnchorAvailable: anchorBarIndex >= 0,
    avwapAnchorMode: 'MONTH_START',
    avwapAnchorUtcSec: anchorTimeSec,
  };
}

/**
 * Pieza 38: payload completo de velas reales ARS para `GET /api/bars`
 * (`symbol` del universo argentino, timeframe `1D`).
 *
 * Indicadores con paridad de semántica con la ruta US de `MarketRuntime.computeBars`:
 * - `computeEmaSuite` (ema9/21/50/200) y SMA/HMA sobre el historial completo;
 * - `sessionVwap` no calculable sobre velas diarias EOD => `null` explícito
 *   (la UI muestra "—", cero fallbacks silenciosos);
 * - AVWAP anclado al inicio del mes corriente en el calendario BYMA (ART),
 *   misma semántica que `buildArStockDetailOverlays` para `/api/ar/stock`;
 * - `sessionCvd` no calculable sin tick side (velas diarias) => `null`.
 */
function computeArTerminalBarsPayload(
  symbol: string,
  timeframe: Timeframe,
  bars: readonly Bar[],
  nowSec: number,
): ArTerminalBarsResponse {
  const closes = bars.map((bar) => bar.close);
  const emaSuite = computeEmaSuite(closes);
  const sma50 = computeSmaSeries(closes, 50);
  const sma200 = computeSmaSeries(closes, 200);
  const hma55 = computeHmaSeries(closes, 55);
  const rsi14 = computeWilderRsiSeries(closes, 14);

  const lastBar = bars[bars.length - 1];
  const sessionDateKeys = bars.map((bar) => getSessionDateKey(bar.time, BYMA_MARKET_TZ));
  const monthKey = lastBar === undefined ? null : (sessionDateKeys.at(-1)?.slice(0, 7) ?? null);
  const anchorIndex = monthKey === null ? -1 : sessionDateKeys.findIndex((dateKey) => dateKey.slice(0, 7) === monthKey);
  const anchorTimeSec = anchorIndex >= 0 ? (bars[anchorIndex]?.time ?? null) : null;
  const avwapPoints =
    anchorTimeSec === null ? [] : computeAnchoredVwapSeries(barsToGgalChartPoints(bars), anchorTimeSec);
  // Los puntos AVWAP empiezan en el ancla: la alineación por `time` deja
  // `null` en las velas previas (longitud == bars.length, sin doble conteo).
  const avwapBands = alignBandPointsToBars(bars, avwapPoints);

  return {
    status: 'OK',
    symbol,
    timeframe,
    barSeconds: 86_400,
    rthOnly: false,
    asOfUtcSec: nowSec,
    visibleStartIndex: 0,
    barsProvider: 'MASSIVE_REST',
    barsProviderFallbackUsed: [],
    bars: bars.map((bar) => ({
      time: bar.time,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      vw: sanitizeFinite(bar.vw),
    })),
    formingBar: null,
    overlays: {
      ema9: sanitizeIndicatorSeries(emaSuite[9]),
      ema21: sanitizeIndicatorSeries(emaSuite[21]),
      ema50: sanitizeIndicatorSeries(emaSuite[50]),
      ema200: sanitizeIndicatorSeries(emaSuite[200]),
      sma50: sma50.map((value) => sanitizeFinite(value)),
      sma200: sma200.map((value) => sanitizeFinite(value)),
      hma55: hma55.map((value) => sanitizeFinite(value)),
      sessionVwap: bars.map(() => null),
      sessionVwapSupported: false,
      avwap: avwapBands.avwap,
      avwapUpper1: avwapBands.upper1,
      avwapLower1: avwapBands.lower1,
      avwapUpper2: avwapBands.upper2,
      avwapLower2: avwapBands.lower2,
    },
    subPanes: {
      rsi14: rsi14.map((value) => sanitizeFinite(value)),
      sessionCvd: bars.map(() => null),
      deltaMode: null,
    },
    zones: null,
    keyLevels: [],
    markers: [],
    market: 'AR',
    currency: 'ARS',
  };
}

export interface ArStockDetailResponse {
  readonly asOfUtcSec: number;
  readonly feedStatus: FeedStatus;
  readonly symbol: string;
  readonly assetType: 'STOCK' | 'CEDEAR' | 'BOND';
  readonly stock: ArStockDto | null;
  readonly bond: ArBondDto | null;
  readonly historicalBars: readonly ArHistoricalBarDto[];
  readonly overlays?: ArStockDetailIndicatorOverlays | null;
  readonly adrBars?: {
    readonly timeframe: Timeframe;
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

export interface ArUnresolvedOptionContractDto {
  readonly symbol: string;
  readonly underlying: string | null;
  readonly contractType: 'call' | 'put' | null;
  readonly strike: null;
  readonly canonicalContractId: null;
  readonly strikeResolutionStatus: Extract<
    BymaStrikeResolutionStatus,
    'AMBIGUOUS_SCALE_UNRESOLVED' | 'CONFLICTING_METADATA' | 'INVALID_SYMBOL'
  >;
  readonly strikeSource: 'NONE';
  readonly expiryCode: string | null;
  readonly expirationDate: string | null;
  readonly expiryUtcSec: number | null;
  readonly bid: number | null;
  readonly bidSize?: number | null;
  readonly ask: number | null;
  readonly askSize?: number | null;
  readonly last: number | null;
  readonly volume: number | null;
  readonly openInterest: number | null;
  readonly quoteSource?: 'DATA912' | 'BMB_HOMEBROKER_BRIDGE' | 'OPEN_BYMA';
  readonly quoteAsOfUtcSec?: number | null;
  readonly exclusionReason: string;
  readonly normalizationEvidence: BymaStrikeNormalizationEvidence;
}

export interface ArStrikeQualitySummaryDto {
  readonly resolvedExplicitCount: number;
  readonly resolvedCanonicalCount: number;
  readonly ambiguousUnresolvedCount: number;
  readonly conflictingMetadataCount: number;
}

export interface ArOptionContractDto {
  readonly ivStatus?: AmericanIvStatus;
  readonly ivResolution?: ImpliedVolResolution;
  readonly theoreticalPriceModel?: 'AMERICAN_BS2002_SURFACE';
  readonly fieldProvenance?: OptionFieldProvenanceMap;
  readonly oiProvenance?: OiFieldProvenance;
  readonly contractMultiplier?: number;
  readonly multiplierSource?: ContractMultiplierSource;
  readonly canonicalContractId?: string | null;
  readonly strikeResolutionStatus?: BymaStrikeResolutionStatus;
  readonly strikeSource?: BymaStrikeSource;
  readonly normalizationEvidence?: BymaStrikeNormalizationEvidence;
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
  readonly changePct?: number | null;
  readonly mark: number | null;
  readonly theoreticalPrice?: number | null;
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
  /** Monto operado en ARS = lotes operados (`v`) × precio de referencia × tamaño de lote. */
  readonly volumeArs?: number | null;
  /** Origen de la VI: `SOLVED` (invertida sobre precio de mercado) o `INHERITED` (paridad / superficie). */
  readonly ivOrigin?: 'SOLVED' | 'INHERITED' | 'NONE';
  readonly source: 'DATA912' | 'MODEL';
  /** Proveedor de la caja de puntas; `source` se conserva para el origen de VI por compatibilidad. */
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
  readonly maxPainStrike?: number | null;
  readonly maxPainDistPct?: number | null;
  readonly strikes: readonly number[];
  readonly calls: readonly ArOptionContractDto[];
  readonly puts: readonly ArOptionContractDto[];
  readonly unresolvedContracts?: readonly ArUnresolvedOptionContractDto[];
}

export interface ArOptionStrategyCardDto {
  readonly id: string;
  readonly rankReason: 'POP' | 'EV' | 'CONVEXITY';
  readonly family: string;
  readonly name: string;
  readonly desc: string;
  readonly legs: readonly {
    readonly side: 1 | -1;
    readonly type: 'C' | 'P';
    readonly strike: number;
    readonly ratio: number;
    readonly symbol: string;
    readonly premium: number;
    readonly iv: number | null;
    readonly delta: number | null;
  }[];
  readonly cashNetArs: number;
  readonly feesAndVatArs: number;
  readonly maxGainArs: number | null;
  readonly maxLossArs: number | null;
  readonly popQ: number;
  readonly popP: number;
  readonly expectedValueArs: number;
  readonly rewardRiskRatio: number | null;
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
  readonly unresolvedContracts?: readonly ArUnresolvedOptionContractDto[];
  readonly strikeQuality?: ArStrikeQualitySummaryDto;
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
    readonly vannaRegime: VannaRegime;
    readonly charmPinStrike: number | null;
    readonly callWallStrike: number | null;
    readonly putWallStrike: number | null;
    readonly gammaFlipSpot: number | null;
    readonly gammaFlipStatus: string;
    /** Pieza 50.9: candidatos de cruce (REST selecciona el más cercano). */
    readonly gammaFlipCandidates?: readonly number[];
    /** Pieza 50.9: trazabilidad honesta (la hora BMB acredita último trade, no puntas). */
    readonly trace?: {
      readonly evaluationSec: number;
      readonly valuationSpot: number | null;
      readonly valuationSpotSource: 'OVERVIEW' | 'HISTORICAL_CLOSE' | null;
      readonly quoteMode: null;
      readonly coverage: 'unknown';
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
      readonly strikeQuality?: ArStrikeQualitySummaryDto;
      readonly directOiInputs: number;
      readonly proxyOiInputs: number;
      /** `true` si el motor usó OI proxy de volumen nominal; `null` sin inputs acreditables. */
      readonly oiProxy: boolean | null;
    };
    readonly expectedMoveAbs: number | null;
    readonly expectedMovePct: number | null;
    readonly expectedMoveExpirySec?: number | null;
    readonly expectedMoveExpiryCode?: string | null;
    readonly expectedMoveDays?: number | null;
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
  readonly quantEngines?: ArOptionsQuantEnginesDto | null;
  /** Código del vencimiento líquido principal sobre el que se calculan `quantEngines`. */
  readonly primaryLiquidExpiryCode?: string | null;
  /** Motores cuantitativos recalculados por vencimiento líquido (clave = `expiryCode`). */
  readonly quantEnginesByExpiry?: Readonly<Record<string, ArOptionsQuantEnginesDto | null>>;
  /** Exposición de dealers recalculada por vencimiento (clave = `expiryCode`). */
  readonly exposureSummaryByExpiry?: Readonly<
    Record<string, NonNullable<ArOptionsResponse['exposureSummary']>>
  >;
  readonly providerErrors: readonly string[];
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

const DEFAULT_DATA912_BASE = 'https://data912.com';
const DEFAULT_OPEN_BYMA_BASE = 'https://open.bymadata.com.ar/vanoms-be-core/rest/api/bymadata/free';
const DEFAULT_BCRA_BASE = 'https://api.bcra.gob.ar';
const DEFAULT_ARGDATOS_BASE = 'https://api.argentinadatos.com';
const DEFAULT_NYFED_BASE = 'https://markets.newyorkfed.org';

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_CACHE_TTL_MS = 18_000;
const AR_LIVE_QUOTE_CACHE_TTL_MS = 1_500;
const AR_LIVE_REFRESH_INTERVAL_MS = 2_500;
const DEFAULT_HIST_CACHE_TTL_MS = 15 * 60 * 1_000;
const AR_HIST_WEEKEND_TTL_MS = 2 * 60 * 60 * 1_000;
const DEFAULT_MACRO_CACHE_TTL_MS = 300_000;
// Data912 tope público: 120 req/min (~500 ms). Margen conservador en vivo: 550 ms en cola compartida o 0 en tests.
const DEFAULT_MIN_DATA912_INTERVAL_MS = 120;
const AR_PANEL_CONCURRENCY_LIMIT = 6;
const AR_PANEL_MAX_CLOSED_BARS = 260;

function computeArHistoricalPanelTtlMs(nowMs: number): number {
  const artDate = new Date(nowMs - 3 * 3_600 * 1_000);
  const dow = artDate.getUTCDay();
  if (dow === 0 || dow === 6) {
    return AR_HIST_WEEKEND_TTL_MS;
  }
  const minutes = artDate.getUTCHours() * 60 + artDate.getUTCMinutes();
  if (minutes >= 10 * 60 + 30 && minutes < 17 * 60 + 30) {
    return DEFAULT_HIST_CACHE_TTL_MS;
  }
  return AR_HIST_WEEKEND_TTL_MS;
}

async function mapWithConcurrencyLimit<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<readonly R[]> {
  if (items.length === 0) {
    return [];
  }
  const capped = Math.max(1, Math.min(limit, items.length));
  const out = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      const item = items[idx];
      if (item !== undefined) {
        out[idx] = await mapper(item, idx);
      }
    }
  };
  await Promise.all(Array.from({ length: capped }, () => worker()));
  return out;
}

const BYMA_RV_FEE = 0.0005; // 3 bps negociación + 2 bps post-trade
const BYMA_OPTION_FEE = 0.0020; // 20 bps referencia opciones
const BYMA_SHORT_LOAN_FEE = 0.0002; // 2 bps préstamo de títulos
const BYMA_VAT_RATE = 0.21; // 21% IVA sobre derechos/comisiones (exento en Títulos Públicos/ONs)
const OPTION_LOT_SIZE = 100;

interface StockMetadata {
  readonly ticker: string;
  readonly name: string;
  readonly sector: ArStockDto['sector'];
  readonly panel: 'Líder' | 'General';
  readonly color: string;
  readonly adrTicker?: string;
  readonly adrRatio?: number;
  readonly dividendYield?: number;
}

const AR_STOCK_META: readonly StockMetadata[] = [
  { ticker: 'GGAL', name: 'Grupo Financiero Galicia', sector: 'Bancos', panel: 'Líder', color: '#8B7CF6', adrTicker: 'GGAL', adrRatio: 10, dividendYield: 0.012 },
  { ticker: 'YPFD', name: 'YPF S.A.', sector: 'Energía', panel: 'Líder', color: '#4BA3FF', adrTicker: 'YPF', adrRatio: 1, dividendYield: 0 },
  { ticker: 'PAMP', name: 'Pampa Energía', sector: 'Energía', panel: 'Líder', color: '#2EDC7E', adrTicker: 'PAM', adrRatio: 25, dividendYield: 0 },
  { ticker: 'BMA', name: 'Banco Macro', sector: 'Bancos', panel: 'Líder', color: '#F5B544', adrTicker: 'BMA', adrRatio: 10, dividendYield: 0.015 },
  { ticker: 'SUPV', name: 'Grupo Supervielle', sector: 'Bancos', panel: 'Líder', color: '#E5558F', adrTicker: 'SUPV', adrRatio: 5, dividendYield: 0 },
  { ticker: 'BBAR', name: 'BBVA Argentina', sector: 'Bancos', panel: 'Líder', color: '#4BA3FF', adrTicker: 'BBAR', adrRatio: 3, dividendYield: 0.01 },
  { ticker: 'CEPU', name: 'Central Puerto', sector: 'Energía', panel: 'Líder', color: '#2EDC7E', adrTicker: 'CEPU', adrRatio: 10, dividendYield: 0 },
  { ticker: 'TGSU2', name: 'Transportadora de Gas del Sur', sector: 'Reguladas', panel: 'Líder', color: '#5B8CFF', adrTicker: 'TGS', adrRatio: 5, dividendYield: 0 },
  { ticker: 'EDN', name: 'Edenor', sector: 'Reguladas', panel: 'Líder', color: '#34D3C7', adrTicker: 'EDN', adrRatio: 20, dividendYield: 0 },
  { ticker: 'TXAR', name: 'Ternium Argentina', sector: 'Materiales', panel: 'Líder', color: '#E5558F', dividendYield: 0.01 },
  { ticker: 'ALUA', name: 'Aluar Aluminio Argentino', sector: 'Materiales', panel: 'Líder', color: '#FF8A4C', dividendYield: 0.01 },
  { ticker: 'COME', name: 'Sociedad Comercial del Plata', sector: 'Energía', panel: 'Líder', color: '#8B7CF6', dividendYield: 0 },
  { ticker: 'TECO2', name: 'Telecom Argentina', sector: 'Telecom', panel: 'Líder', color: '#4BA3FF', adrTicker: 'TEO', adrRatio: 5, dividendYield: 0 },
  { ticker: 'LOMA', name: 'Loma Negra', sector: 'Materiales', panel: 'Líder', color: '#2EDC7E', adrTicker: 'LOMA', adrRatio: 5, dividendYield: 0 },
  { ticker: 'CRES', name: 'Cresud', sector: 'Agro', panel: 'Líder', color: '#FF8A4C', adrTicker: 'CRESY', adrRatio: 10, dividendYield: 0 },
  { ticker: 'BYMA', name: 'Bolsas y Mercados Argentinos', sector: 'Bancos', panel: 'Líder', color: '#8B7CF6', dividendYield: 0.01 },
  { ticker: 'TRAN', name: 'Transener', sector: 'Reguladas', panel: 'Líder', color: '#F5B544', dividendYield: 0 },
  { ticker: 'VALO', name: 'Banco de Valores', sector: 'Bancos', panel: 'Líder', color: '#8B5CF6', dividendYield: 0 },
  { ticker: 'IRSA', name: 'IRSA Inversiones y Representaciones', sector: 'Agro', panel: 'General', color: '#6366F1', adrTicker: 'IRS', adrRatio: 10, dividendYield: 0 },
  { ticker: 'TGNO4', name: 'Transportadora de Gas del Norte', sector: 'Reguladas', panel: 'Líder', color: '#0EA5E9', dividendYield: 0 },
  { ticker: 'METR', name: 'Metrogas S.A.', sector: 'Reguladas', panel: 'Líder', color: '#3B82F6', dividendYield: 0 },
  { ticker: 'MIRG', name: 'Mirgor S.A.', sector: 'Materiales', panel: 'Líder', color: '#EC4899', dividendYield: 0 },
  { ticker: 'BHIP', name: 'Banco Hipotecario', sector: 'Bancos', panel: 'General', color: '#F59E0B', dividendYield: 0 },
  { ticker: 'CECO2', name: 'Central Costanera', sector: 'Energía', panel: 'General', color: '#10B981', dividendYield: 0 },
  { ticker: 'CVH', name: 'Cablevisión Holding', sector: 'Telecom', panel: 'General', color: '#06B6D4', dividendYield: 0 },
  { ticker: 'AUSO', name: 'Autopistas del Sol', sector: 'Reguladas', panel: 'General', color: '#F97316', dividendYield: 0 },
  { ticker: 'HARG', name: 'Holcim Argentina', sector: 'Materiales', panel: 'General', color: '#14B8A6', dividendYield: 0 },
  { ticker: 'AGRO', name: 'Agrometal S.A.', sector: 'Agro', panel: 'General', color: '#84CC16', dividendYield: 0 },
  { ticker: 'MORI', name: 'Morixe Hermanos', sector: 'Agro', panel: 'General', color: '#EAB308', dividendYield: 0 },
  { ticker: 'BPAT', name: 'Banco Patagonia', sector: 'Bancos', panel: 'General', color: '#3B82F6', dividendYield: 0 },
  { ticker: 'CGPA2', name: 'Camuzzi Gas Pampeana', sector: 'Reguladas', panel: 'General', color: '#14B8A6', dividendYield: 0 },
  { ticker: 'DGCU2', name: 'Distribuidora de Gas Cuyana', sector: 'Reguladas', panel: 'General', color: '#0EA5E9', dividendYield: 0 },
  { ticker: 'SEMI', name: 'Molinos Juan Semino', sector: 'Agro', panel: 'General', color: '#22C55E', dividendYield: 0 },
  { ticker: 'MOLI', name: 'Molinos Río de la Plata', sector: 'Agro', panel: 'General', color: '#8B7CF6', dividendYield: 0 },
  { ticker: 'LEDE', name: 'Ledesma S.A.A.I.', sector: 'Agro', panel: 'General', color: '#10B981', dividendYield: 0 },
  { ticker: 'GCLA', name: 'Grupo Clarín', sector: 'Telecom', panel: 'General', color: '#6366F1', dividendYield: 0 },
  { ticker: 'BOLT', name: 'Boldt S.A.', sector: 'Telecom', panel: 'General', color: '#06B6D4', dividendYield: 0 },
  { ticker: 'INVJ', name: 'Inversora Juramento', sector: 'Agro', panel: 'General', color: '#F59E0B', dividendYield: 0 },
  { ticker: 'OEST', name: 'Grupo Concesionario del Oeste', sector: 'Reguladas', panel: 'General', color: '#10B981', dividendYield: 0 },
];

const STOCK_META_MAP = new Map<string, StockMetadata>(
  AR_STOCK_META.map((m) => [m.ticker, m]),
);

const DUAL_ADR_OPTIONS_TICKERS = new Set<string>([
  'GGAL',
  'YPFD',
  'PAMP',
  'BMA',
  'CEPU',
  'TGSU2',
  'EDN',
  'SUPV',
  'BBAR',
  'LOMA',
]);

const CEDEAR_RATIOS: Readonly<Record<string, { readonly usTicker: string; readonly ratio: number; readonly name: string }>> = {
  SPY: { usTicker: 'SPY', ratio: 20, name: 'SPDR S&P 500 ETF Trust' },
  QQQ: { usTicker: 'QQQ', ratio: 20, name: 'Invesco QQQ Trust' },
  AAPL: { usTicker: 'AAPL', ratio: 20, name: 'Apple Inc.' },
  AMZN: { usTicker: 'AMZN', ratio: 144, name: 'Amazon.com Inc.' },
  NVDA: { usTicker: 'NVDA', ratio: 24, name: 'NVIDIA Corporation' },
  MELI: { usTicker: 'MELI', ratio: 120, name: 'MercadoLibre Inc.' },
  KO: { usTicker: 'KO', ratio: 5, name: 'Coca-Cola Co.' },
  TSLA: { usTicker: 'TSLA', ratio: 15, name: 'Tesla Inc.' },
  MSFT: { usTicker: 'MSFT', ratio: 30, name: 'Microsoft Corporation' },
  GOOGL: { usTicker: 'GOOGL', ratio: 58, name: 'Alphabet Inc.' },
  META: { usTicker: 'META', ratio: 24, name: 'Meta Platforms Inc.' },
  BRKB: { usTicker: 'BRK.B', ratio: 22, name: 'Berkshire Hathaway' },
  VISTA: { usTicker: 'VIST', ratio: 3, name: 'Vista Energy SAB' },
  VIST: { usTicker: 'VIST', ratio: 3, name: 'Vista Energy SAB' },
  XOM: { usTicker: 'XOM', ratio: 10, name: 'Exxon Mobil Corp.' },
  SLB: { usTicker: 'SLB', ratio: 3, name: 'SLB (Schlumberger)' },
  JPM: { usTicker: 'JPM', ratio: 15, name: 'JPMorgan Chase & Co.' },
  BAC: { usTicker: 'BAC', ratio: 4, name: 'Bank of America Corp.' },
  AMD: { usTicker: 'AMD', ratio: 10, name: 'Advanced Micro Devices' },
  NFLX: { usTicker: 'NFLX', ratio: 48, name: 'Netflix Inc.' },
  GLOB: { usTicker: 'GLOB', ratio: 18, name: 'Globant S.A.' },
  BABA: { usTicker: 'BABA', ratio: 9, name: 'Alibaba Group' },
  WMT: { usTicker: 'WMT', ratio: 18, name: 'Walmart Inc.' },
  DIS: { usTicker: 'DIS', ratio: 12, name: 'Walt Disney Co.' },
  XLE: { usTicker: 'XLE', ratio: 2, name: 'Energy Select Sector SPDR Fund' },
  XLF: { usTicker: 'XLF', ratio: 2, name: 'Financial Select Sector SPDR Fund' },
  EWZ: { usTicker: 'EWZ', ratio: 2, name: 'iShares MSCI Brazil ETF' },
  IWM: { usTicker: 'IWM', ratio: 10, name: 'iShares Russell 2000 ETF' },
  DIA: { usTicker: 'DIA', ratio: 20, name: 'SPDR Dow Jones Industrial' },
  AVGO: { usTicker: 'AVGO', ratio: 39, name: 'Broadcom Inc.' },
  TSM: { usTicker: 'TSM', ratio: 9, name: 'Taiwan Semiconductor' },
  INTC: { usTicker: 'INTC', ratio: 5, name: 'Intel Corp.' },
  QCOM: { usTicker: 'QCOM', ratio: 11, name: 'Qualcomm Inc.' },
  MU: { usTicker: 'MU', ratio: 5, name: 'Micron Technology' },
  CRM: { usTicker: 'CRM', ratio: 18, name: 'Salesforce Inc.' },
  ORCL: { usTicker: 'ORCL', ratio: 3, name: 'Oracle Corp.' },
  WFC: { usTicker: 'WFC', ratio: 5, name: 'Wells Fargo & Co.' },
  GS: { usTicker: 'GS', ratio: 13, name: 'Goldman Sachs Group' },
  MS: { usTicker: 'MS', ratio: 41, name: 'Morgan Stanley' },
  V: { usTicker: 'V', ratio: 18, name: 'Visa Inc.' },
  MA: { usTicker: 'MA', ratio: 33, name: 'Mastercard Inc.' },
  BLK: { usTicker: 'BLK', ratio: 30, name: 'BlackRock Inc.' },
  COST: { usTicker: 'COST', ratio: 48, name: 'Costco Wholesale' },
  PEP: { usTicker: 'PEP', ratio: 18, name: 'PepsiCo Inc.' },
  MCD: { usTicker: 'MCD', ratio: 24, name: "McDonald's Corp." },
  NKE: { usTicker: 'NKE', ratio: 12, name: 'Nike Inc.' },
  HD: { usTicker: 'HD', ratio: 32, name: 'Home Depot Inc.' },
  PG: { usTicker: 'PG', ratio: 15, name: 'Procter & Gamble' },
  CVX: { usTicker: 'CVX', ratio: 16, name: 'Chevron Corp.' },
  COP: { usTicker: 'COP', ratio: 25, name: 'ConocoPhillips' },
  OXY: { usTicker: 'OXY', ratio: 5, name: 'Occidental Petroleum' },
  LLY: { usTicker: 'LLY', ratio: 56, name: 'Eli Lilly & Co.' },
  UNH: { usTicker: 'UNH', ratio: 33, name: 'UnitedHealth Group' },
  JNJ: { usTicker: 'JNJ', ratio: 15, name: 'Johnson & Johnson' },
  PFE: { usTicker: 'PFE', ratio: 4, name: 'Pfizer Inc.' },
  ABBV: { usTicker: 'ABBV', ratio: 10, name: 'AbbVie Inc.' },
  MRK: { usTicker: 'MRK', ratio: 5, name: 'Merck & Co.' },
  CAT: { usTicker: 'CAT', ratio: 20, name: 'Caterpillar Inc.' },
  BA: { usTicker: 'BA', ratio: 24, name: 'Boeing Co.' },
  GE: { usTicker: 'GE', ratio: 8, name: 'GE Aerospace' },
  HON: { usTicker: 'HON', ratio: 4, name: 'Honeywell Intl.' },
  DE: { usTicker: 'DE', ratio: 40, name: 'Deere & Co.' },
  LMT: { usTicker: 'LMT', ratio: 20, name: 'Lockheed Martin' },
  GLD: { usTicker: 'GLD', ratio: 50, name: 'SPDR Gold Shares' },
  SLV: { usTicker: 'SLV', ratio: 6, name: 'iShares Silver Trust' },
  NU: { usTicker: 'NU', ratio: 2, name: 'Nu Holdings' },
  PBR: { usTicker: 'PBR', ratio: 1, name: 'Petrobras ADR' },
};

const BYMA_OPTION_UNDERLYINGS: ReadonlySet<string> = new Set([
  'GGAL',
  'YPFD',
  'PAMP',
  'BMA',
  'COME',
  'ALUA',
  'TXAR',
  'EDN',
  'TGSU2',
  'CRES',
]);

/** Alias de tickers CEDEAR para consultar `/historical/cedears/{ticker}` (clave local -> ticker BYMA canónico). */
const CEDEAR_TICKER_ALIASES: Readonly<Record<string, string>> = {
  VISTA: 'VIST',
};

const SYNTHETIC_MONTH_ABBR = [
  'ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC',
] as const;

/**
 * Curva de Futuros Sintéticos USD bajo paridad cubierta de tasas (CIP):
 * `F_USD(T) = S_A3500 · exp((r_ARS − r_USD) · T)`, con `T = días / 365`.
 * Devuelve `[]` si falta cualquiera de las tasas o el tipo de cambio mayorista (sin inventar valores).
 */
export function computeSyntheticUsdFuturesCurve(params: {
  readonly nowSec: number;
  readonly a3500: number | null;
  readonly arsRateTnaPct: number | null;
  readonly arsRateSource: string;
  readonly usdRatePct: number | null;
  readonly usdRateSource: string;
  readonly ccl: number | null;
  readonly monthsCount?: number;
}): readonly ArSyntheticUsdFutureDto[] {
  const { a3500, arsRateTnaPct, usdRatePct } = params;
  if (
    a3500 === null ||
    !Number.isFinite(a3500) ||
    a3500 <= 0 ||
    arsRateTnaPct === null ||
    !Number.isFinite(arsRateTnaPct) ||
    arsRateTnaPct <= 0 ||
    usdRatePct === null ||
    !Number.isFinite(usdRatePct) ||
    usdRatePct < 0
  ) {
    return [];
  }
  const count = params.monthsCount ?? 6;
  const rArsCont = (365 / 30) * Math.log(1 + (arsRateTnaPct / 100) * (30 / 365));
  const rUsdCont = Math.log(1 + usdRatePct / 100);
  const nowDate = new Date(params.nowSec * 1_000);
  let startYear = nowDate.getUTCFullYear();
  let startMonth = nowDate.getUTCMonth();

  const firstEomSec = Math.floor(Date.UTC(startYear, startMonth + 1, 0, 18, 0, 0) / 1_000);
  if (firstEomSec - params.nowSec < 86_400) {
    startMonth += 1;
    if (startMonth >= 12) {
      startMonth -= 12;
      startYear += 1;
    }
  }

  const out: ArSyntheticUsdFutureDto[] = [];
  for (let i = 0; i < count; i += 1) {
    const totalMonths = startMonth + i;
    const y = startYear + Math.floor(totalMonths / 12);
    const m = totalMonths % 12;
    const eomDate = new Date(Date.UTC(y, m + 1, 0, 18, 0, 0));
    const expiryUtcSec = Math.floor(eomDate.getTime() / 1_000);
    const days = Math.max(1, Math.round((expiryUtcSec - params.nowSec) / 86_400));
    const tYears = days / 365;
    const forwardPrice = a3500 * Math.exp((rArsCont - rUsdCont) * tYears);
    const ratio = forwardPrice / a3500;
    const impliedDevalPct = (ratio - 1) * 100;
    const temPct = (Math.pow(ratio, 30 / days) - 1) * 100;
    const tnaPct = (ratio - 1) * (365 / days) * 100;
    const teaPct = (Math.pow(ratio, 365 / days) - 1) * 100;
    const monthAbbr = SYNTHETIC_MONTH_ABBR[m] ?? 'MES';
    const yy = String(y).slice(-2);
    const maturity = eomDate.toISOString().slice(0, 10);
    const spreadVsCclPct =
      params.ccl !== null && Number.isFinite(params.ccl) && params.ccl > 0
        ? (forwardPrice / params.ccl - 1) * 100
        : null;

    out.push({
      contract: `DLR-${monthAbbr}${yy}-SINT`,
      maturity,
      expiryUtcSec,
      days,
      spotA3500: a3500,
      forwardPrice,
      impliedDevalPct,
      temPct,
      tnaPct,
      teaPct,
      arsRateTnaPct,
      arsRateSource: params.arsRateSource,
      usdRatePct,
      usdRateSource: params.usdRateSource,
      spreadVsCclPct,
      badge: 'SINTÉTICO IMPLÍCITO',
    });
  }
  return out;
}

interface BondFlow {
  readonly dateUtcSec: number;
  readonly coupon: number;
  readonly amortization: number;
}

interface SovereignBondSpec {
  readonly baseTicker: string;
  readonly name: string;
  readonly legislation: 'ARG' | 'NY' | 'TESORO';
  readonly maturity: string;
  readonly currency?: 'USD' | 'ARS' | 'CER';
  readonly cerBase?: number;
  readonly flows: readonly BondFlow[];
}

function isoUtcSec(dateStr: string): number {
  return Math.floor(Date.parse(`${dateStr}T12:00:00Z`) / 1_000);
}

function generateSemiannualFlows(params: {
  readonly startDate: string;
  readonly endDate: string;
  readonly couponRateAt: (dateStr: string) => number;
  readonly amortAt: (dateStr: string) => number;
}): readonly BondFlow[] {
  const start = new Date(`${params.startDate}T12:00:00Z`);
  const end = new Date(`${params.endDate}T12:00:00Z`);
  const out: BondFlow[] = [];
  let residualPrincipal = 100;
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth() + 1;
  const d = start.getUTCDate();

  while (Date.UTC(y, m - 1, d, 12, 0, 0) <= end.getTime() + 1_000) {
    const mm = String(m).padStart(2, '0');
    const dd = String(d).padStart(2, '0');
    const dateStr = `${String(y)}-${mm}-${dd}`;
    const annualRate = params.couponRateAt(dateStr);
    const coupon = residualPrincipal * (annualRate / 2);
    const amort = Math.min(residualPrincipal, params.amortAt(dateStr));
    out.push({
      dateUtcSec: isoUtcSec(dateStr),
      coupon,
      amortization: amort,
    });
    residualPrincipal = Math.max(0, residualPrincipal - amort);
    m += 6;
    if (m > 12) {
      m -= 12;
      y += 1;
    }
  }
  return out;
}

const SOVEREIGN_BONDS: readonly SovereignBondSpec[] = [
  {
    baseTicker: 'AL29',
    name: 'Bonar 2029 USD Ley Argentina',
    legislation: 'ARG',
    maturity: '2029-07-09',
    flows: generateSemiannualFlows({
      startDate: '2025-01-09',
      endDate: '2029-07-09',
      couponRateAt: () => 0.01,
      amortAt: () => 10,
    }),
  },
  {
    baseTicker: 'GD29',
    name: 'Global 2029 USD Ley NY',
    legislation: 'NY',
    maturity: '2029-07-09',
    flows: generateSemiannualFlows({
      startDate: '2025-01-09',
      endDate: '2029-07-09',
      couponRateAt: () => 0.01,
      amortAt: () => 10,
    }),
  },
  {
    baseTicker: 'AL30',
    name: 'Bonar 2030 Step-Up Ley Argentina',
    legislation: 'ARG',
    maturity: '2030-07-09',
    flows: generateSemiannualFlows({
      startDate: '2024-07-09',
      endDate: '2030-07-09',
      couponRateAt: (d) => (d >= '2028-01-01' ? 0.0175 : 0.0075),
      amortAt: (d) => (d === '2024-07-09' ? 4 : 8),
    }),
  },
  {
    baseTicker: 'GD30',
    name: 'Global 2030 Step-Up Ley NY',
    legislation: 'NY',
    maturity: '2030-07-09',
    flows: generateSemiannualFlows({
      startDate: '2024-07-09',
      endDate: '2030-07-09',
      couponRateAt: (d) => (d >= '2028-01-01' ? 0.0175 : 0.0075),
      amortAt: (d) => (d === '2024-07-09' ? 4 : 8),
    }),
  },
  {
    baseTicker: 'AL35',
    name: 'Bonar 2035 Step-Up Ley Argentina',
    legislation: 'ARG',
    maturity: '2035-07-09',
    flows: generateSemiannualFlows({
      startDate: '2025-01-09',
      endDate: '2035-07-09',
      couponRateAt: (d) => (d >= '2029-01-01' ? 0.05 : d >= '2028-01-01' ? 0.0475 : 0.04125),
      amortAt: (d) => (d >= '2031-01-09' ? 10 : 0),
    }),
  },
  {
    baseTicker: 'GD35',
    name: 'Global 2035 Step-Up Ley NY',
    legislation: 'NY',
    maturity: '2035-07-09',
    flows: generateSemiannualFlows({
      startDate: '2025-01-09',
      endDate: '2035-07-09',
      couponRateAt: (d) => (d >= '2029-01-01' ? 0.05 : d >= '2028-01-01' ? 0.0475 : 0.04125),
      amortAt: (d) => (d >= '2031-01-09' ? 10 : 0),
    }),
  },
  {
    baseTicker: 'AE38',
    name: 'Bonar 2038 Step-Up Ley Argentina',
    legislation: 'ARG',
    maturity: '2038-01-09',
    flows: generateSemiannualFlows({
      startDate: '2025-01-09',
      endDate: '2038-01-09',
      couponRateAt: () => 0.05,
      amortAt: (d) => (d >= '2027-07-09' ? 100 / 22 : 0),
    }),
  },
  {
    baseTicker: 'GD38',
    name: 'Global 2038 Step-Up Ley NY',
    legislation: 'NY',
    maturity: '2038-01-09',
    flows: generateSemiannualFlows({
      startDate: '2025-01-09',
      endDate: '2038-01-09',
      couponRateAt: () => 0.05,
      amortAt: (d) => (d >= '2027-07-09' ? 100 / 22 : 0),
    }),
  },
  {
    baseTicker: 'AL41',
    name: 'Bonar 2041 Step-Up Ley Argentina',
    legislation: 'ARG',
    maturity: '2041-07-09',
    flows: generateSemiannualFlows({
      startDate: '2025-01-09',
      endDate: '2041-07-09',
      couponRateAt: (d) => (d >= '2030-01-01' ? 0.04875 : 0.035),
      amortAt: (d) => (d >= '2028-01-09' ? 100 / 28 : 0),
    }),
  },
  {
    baseTicker: 'GD41',
    name: 'Global 2041 Step-Up Ley NY',
    legislation: 'NY',
    maturity: '2041-07-09',
    flows: generateSemiannualFlows({
      startDate: '2025-01-09',
      endDate: '2041-07-09',
      couponRateAt: (d) => (d >= '2030-01-01' ? 0.04875 : 0.035),
      amortAt: (d) => (d >= '2028-01-09' ? 100 / 28 : 0),
    }),
  },
  {
    baseTicker: 'TX26',
    name: 'Boncer 2026 CER + 2.00%',
    legislation: 'TESORO',
    maturity: '2026-11-09',
    currency: 'CER',
    cerBase: 22.8491,
    flows: generateSemiannualFlows({
      startDate: '2024-11-09',
      endDate: '2026-11-09',
      couponRateAt: () => 0.02,
      amortAt: () => 20,
    }),
  },
  {
    baseTicker: 'TX28',
    name: 'Boncer 2028 CER + 2.25%',
    legislation: 'TESORO',
    maturity: '2028-11-09',
    currency: 'CER',
    cerBase: 22.8491,
    flows: generateSemiannualFlows({
      startDate: '2024-05-09',
      endDate: '2028-11-09',
      couponRateAt: () => 0.0225,
      amortAt: () => 10,
    }),
  },
  {
    baseTicker: 'TZX26',
    name: 'Boncer Cero Cupón 2026 CER',
    legislation: 'TESORO',
    maturity: '2026-06-30',
    currency: 'CER',
    cerBase: 162.5,
    flows: [
      {
        dateUtcSec: isoUtcSec('2026-06-30'),
        coupon: 0,
        amortization: 100,
      },
    ],
  },
];

/**
 * Pieza 38: mercado por defecto de un ticker para `GET /api/bars` sin el
 * parámetro `market` explícito. Los locales BYMA (Panel Líder / Panel General
 * en `AR_STOCK_META`) y los soberanos (AL30/GD30/... con sus variantes D/C)
 * resuelven a `'AR'`; los CEDEARs NO resuelven por defecto porque su ticker
 * colisiona con el subyacente US (NVDA CEDEAR en ARS vs NVDA stock en USD,
 * SPEC punto 10) y exigen `market=AR` explícito. `null` => ruta US.
 */
export function resolveArDefaultTerminalMarket(rawSymbol: string): 'AR' | null {
  const upper = rawSymbol.trim().toUpperCase();
  if (upper === '') return null;
  const isBond = SOVEREIGN_BONDS.some(
    (bond) => bond.baseTicker === upper || `${bond.baseTicker}D` === upper || `${bond.baseTicker}C` === upper,
  );
  if (isBond) return 'AR';
  return STOCK_META_MAP.has(upper) ? 'AR' : null;
}

/** Set de instrumentos BYMA explicitamente tradables como acciones/renta fija. */
const BYMA_FIXED_INCOME_TICKER_SET = new Set<string>([
  ...['AL29', 'AL29D', 'AL30', 'AL30D', 'GD29', 'GD29D', 'GD30', 'GD30D', 'AL35', 'AL35D', 'GD35', 'GD35D', 'AE38', 'AE38D', 'GD38', 'GD38D', 'AL41', 'AL41D', 'GD41', 'GD41D', 'BPY26', 'BPOA7', 'BPOB7', 'BPOC7', 'BPOD7', 'BA37D', 'TO26'],
  ...SOVEREIGN_BONDS.map((bond) => bond.baseTicker),
  ...SOVEREIGN_BONDS.flatMap((bond) => [`${bond.baseTicker}D`, `${bond.baseTicker}C`]),
]);

const BYMA_OPTION_PREFIXES = ['GFGC', 'GFGV'];

/**
 * Pieza 41: normaliza un frame `Md` a `MarketTickQuote` sin inferir moneda de
 * instrumentos desconocidos. Solo LA con precio real crea quote; puntas no.
 */
export function primaryFrameToMarketTickQuote(frame: {
  readonly ticker: string | null;
  readonly settlement: string | null;
  readonly snapshot: {
    readonly last: number | null;
    readonly close: number | null;
    readonly open: number | null;
    readonly high: number | null;
    readonly low: number | null;
    readonly nominalVolume?: number | null;
    readonly turnover?: number | null;
    readonly lastTradeAtUtcSec?: number | null;
  };
}): MarketTickQuote | null {
  const rawTicker = frame.ticker?.trim().toUpperCase() ?? '';
  const ticker = rawTicker;
  const price = frame.snapshot.last;
  if (
    ticker === '' || BYMA_OPTION_PREFIXES.some((prefix) => ticker.startsWith(prefix)) ||
    price === null || !Number.isFinite(price) || price <= 0
  ) {
    return null;
  }
  const isFixedIncome = BYMA_FIXED_INCOME_TICKER_SET.has(ticker);
  const isStock = STOCK_META_MAP.has(ticker) || Object.hasOwn(CEDEAR_RATIOS, ticker);
  if (!isFixedIncome && !isStock) return null;
  const previousClose =
    frame.snapshot.close !== null && Number.isFinite(frame.snapshot.close) && frame.snapshot.close > 0
      ? frame.snapshot.close
      : null;
  return {
    market: 'AR',
    symbol: ticker,
    kind: isFixedIncome ? 'bond' : 'stock',
    currency:
      isFixedIncome
        ? (ticker.endsWith('D') || ticker.endsWith('C') ? 'USD' : 'ARS')
        : 'ARS',
    price,
    previousClose,
    changePct:
      previousClose !== null && previousClose > 0
        ? ((price - previousClose) / previousClose) * 100
        : null,
    dayLow: frame.snapshot.low !== null && Number.isFinite(frame.snapshot.low) ? frame.snapshot.low : null,
    dayHigh: frame.snapshot.high !== null && Number.isFinite(frame.snapshot.high) ? frame.snapshot.high : null,
    volume: frame.snapshot.nominalVolume ?? null,
    turnover: frame.snapshot.turnover ?? null,
    asOfUtcSec: frame.snapshot.lastTradeAtUtcSec ?? null,
    source: 'PRIMARY_ECO_WS',
    settlement: frame.settlement,
  };
}

function sanitizeFinite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sanitizeJsonUnknown(value: unknown): unknown {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonUnknown(item === undefined ? null : item));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        out[key] = sanitizeJsonUnknown(v);
      }
    }
    return out;
  }
  return null;
}

function sanitizeJsonPayload<T>(value: T): JsonSafe<T> {
  return sanitizeJsonUnknown(value) as JsonSafe<T>;
}

/** Mínimo de bases con VI invertida para considerar líquido un vencimiento. */
const MIN_LIQUID_IV_STRIKES = 5;

function computeArOptionsTickAggression(
  contracts: readonly ArOptionContractDto[],
  rawRowBySymbol: ReadonlyMap<string, NormalizedQuoteRow>,
  lotSize: number,
): ArOptionsTickAggressionDto | null {
  let askNotional = 0;
  let bidNotional = 0;
  let neutralNotional = 0;
  let classifiedContracts = 0;
  let leeReadyCount = 0;
  let variationCount = 0;

  for (const c of contracts) {
    const vol = c.volume;
    const px = c.last !== null && c.last > 0 ? c.last : c.mark;
    if (vol === null || !Number.isFinite(vol) || vol <= 0 || px === null || !Number.isFinite(px) || px <= 0) {
      continue;
    }
    const weight = vol * px * lotSize;
    if (!Number.isFinite(weight) || weight <= 0) {
      continue;
    }

    const bid = c.bid;
    const ask = c.ask;
    const raw = rawRowBySymbol.get(c.symbol);
    const prevClose = raw?.prevClose ?? null;
    const deltaPct = raw?.deltaPct ?? null;
    const tickDelta =
      prevClose !== null && Number.isFinite(prevClose) && prevClose > 0
        ? px - prevClose
        : deltaPct !== null && Number.isFinite(deltaPct)
          ? deltaPct
          : null;

    if (bid !== null && ask !== null && bid > 0 && ask > bid) {
      const mid = 0.5 * (bid + ask);
      if (px >= ask - 1e-9 || px > mid + 1e-9) {
        askNotional += weight;
        leeReadyCount += 1;
        classifiedContracts += 1;
      } else if (px <= bid + 1e-9 || px < mid - 1e-9) {
        bidNotional += weight;
        leeReadyCount += 1;
        classifiedContracts += 1;
      } else if (tickDelta !== null && Math.abs(tickDelta) > 1e-6) {
        if (tickDelta > 0) {
          askNotional += weight;
        } else {
          bidNotional += weight;
        }
        leeReadyCount += 1;
        classifiedContracts += 1;
      } else {
        neutralNotional += weight;
        leeReadyCount += 1;
        classifiedContracts += 1;
      }
      continue;
    }

    if (tickDelta !== null && Number.isFinite(tickDelta)) {
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
  const direction: ArOptionsTickAggressionDto['direction'] =
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

function sanitizePositive(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0 ? value : null;
}

function resolvePositiveQuoteRate(row: NormalizedQuoteRow): number | null {
  const direct = sanitizePositive(row.mark) ?? sanitizePositive(row.last);
  if (direct !== null) {
    return direct;
  }
  if (row.arsBid !== null && row.arsBid > 0 && row.usdAsk !== null && row.usdAsk > 0) {
    return row.arsBid / row.usdAsk;
  }
  return null;
}

function hasPositiveLast(rows: readonly NormalizedQuoteRow[]): boolean {
  return rows.some((r) => r.last !== null && Number.isFinite(r.last) && r.last > 0);
}

function normalizeClosedDailyBarsForEngines(bars: readonly Bar[], asOfUtcSec: number): readonly Bar[] {
  const byDay = new Map<number, Bar>();
  const evalSec = Math.floor(asOfUtcSec);
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
    // Estricto no look-ahead: solo barras cuyo cierre conocido es <= asOfUtcSec
    if (rawTime > evalSec) {
      continue;
    }
    // Normalizamos al inicio del día UTC para motores cuyo contrato exige open + barSeconds <= asOfUtcSec
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

function computeWilderAtr14(bars: readonly Bar[]): number | null {
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

function computeCausalCvdSlopeSign(bars: readonly Bar[]): number {
  const window = bars.slice(-10);
  if (window.length < 2) {
    return 0;
  }
  let netDelta = 0;
  for (const b of window) {
    if (b.volume <= 0) {
      continue;
    }
    netDelta += b.close >= b.open ? b.volume : -b.volume;
  }
  if (netDelta > 0) return 1;
  if (netDelta < 0) return -1;
  return 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNum(rec: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const raw = rec[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return raw;
    }
    if (typeof raw === 'string' && raw.trim() !== '') {
      const parsed = Number(raw.replace(',', '.'));
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function readStr(rec: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const raw = rec[key];
    if (typeof raw === 'string' && raw.trim() !== '') {
      return raw.trim();
    }
  }
  return null;
}

function parseTimestampSec(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw > 1e11 ? Math.floor(raw / 1_000) : Math.floor(raw);
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const s = raw.trim();
    const num = Number(s);
    if (Number.isFinite(num) && num > 0) {
      return num > 1e11 ? Math.floor(num / 1_000) : Math.floor(num);
    }
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T20:00:00Z` : s;
    const ms = Date.parse(iso);
    if (Number.isFinite(ms) && ms > 0) {
      return Math.floor(ms / 1_000);
    }
  }
  return null;
}

function defaultArHttpFn(url: string, init?: ArHttpRequestInit): Promise<FetchResponse> {
  const timeoutMs = init?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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

function computeMedian(values: readonly number[]): number | null {
  const clean = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (clean.length === 0) {
    return null;
  }
  const mid = Math.floor(clean.length / 2);
  if (clean.length % 2 === 1) {
    return clean[mid] ?? null;
  }
  const a = clean[mid - 1];
  const b = clean[mid];
  return a !== undefined && b !== undefined ? 0.5 * (a + b) : null;
}

function computeMeanAndStd(values: readonly number[]): { readonly mean: number; readonly std: number } | null {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length < 2) {
    return null;
  }
  const sum = clean.reduce((acc, v) => acc + v, 0);
  const mean = sum / clean.length;
  const varSum = clean.reduce((acc, v) => acc + (v - mean) * (v - mean), 0);
  const std = Math.sqrt(varSum / (clean.length - 1));
  return { mean, std };
}

function computeDailyRealizedVol(bars: readonly Bar[], windowDays: number): number | null {
  if (bars.length < windowDays + 1) {
    return null;
  }
  const recent = bars.slice(-(windowDays + 1));
  const returns: number[] = [];
  for (let i = 1; i < recent.length; i += 1) {
    const prev = recent[i - 1];
    const curr = recent[i];
    if (prev !== undefined && curr !== undefined && prev.close > 0 && curr.close > 0) {
      returns.push(Math.log(curr.close / prev.close));
    }
  }
  const stats = computeMeanAndStd(returns);
  if (stats === null || !Number.isFinite(stats.std) || stats.std <= 0) {
    return null;
  }
  return stats.std * Math.sqrt(252);
}

function toUtcDateKey(timeSec: number): string {
  return new Date(timeSec * 1_000).toISOString().slice(0, 10);
}

/**
 * Vida media de reversión discreta AR(1) / Ornstein-Uhlenbeck:
 * t_{1/2} = -ln(2) / ln(phi_hat) cuando 0 < phi_hat < 1 y existen >= 20 observaciones.
 */
export function computeOuHalfLifeDays(values: readonly number[]): number | null {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length < 20) {
    return null;
  }
  const nPairs = clean.length - 1;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < nPairs; i += 1) {
    const x = clean[i];
    const y = clean[i + 1];
    if (x === undefined || y === undefined) {
      return null;
    }
    sumX += x;
    sumY += y;
  }
  const meanX = sumX / nPairs;
  const meanY = sumY / nPairs;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < nPairs; i += 1) {
    const x = clean[i];
    const y = clean[i + 1];
    if (x === undefined || y === undefined) {
      return null;
    }
    const dx = x - meanX;
    const dy = y - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
  }
  if (sxx <= 1e-15) {
    return null;
  }
  const phi = sxy / sxx;
  if (!Number.isFinite(phi) || phi <= 0 || phi >= 1 - 1e-9) {
    return null;
  }
  const halfLife = -Math.LN2 / Math.log(phi);
  return Number.isFinite(halfLife) && halfLife > 0 ? halfLife : null;
}

/**
 * Etiqueta cuantitativa de oportunidad según z-score respecto a media 60 ruedas.
 */
export function computeOpportunityBadge(zScore: number | null): RelationOpportunityBadge | null {
  if (zScore === null || !Number.isFinite(zScore)) {
    return null;
  }
  if (zScore <= -2.0) {
    return 'EXTREMO COMPRA';
  }
  if (zScore >= 2.0) {
    return 'EXTREMO VENTA';
  }
  if (Math.abs(zScore) >= 1.5) {
    return 'DESVÍO MODERADO';
  }
  return 'EN EQUILIBRIO';
}

/**
 * Giro relativo de volumen efectivo: cambio porcentual de la media 5d
 * respecto a la media 20d sobre la participación diaria del numerador (0 < s <= 1).
 */
export function computeCapitalFlowDeltaPct(shares: readonly number[]): number | null {
  const clean = shares.filter((s) => Number.isFinite(s) && s > 0 && s <= 1);
  if (clean.length < 20) {
    return null;
  }
  const last20 = clean.slice(-20);
  const last5 = clean.slice(-5);
  let sum20 = 0;
  for (const s of last20) {
    sum20 += s;
  }
  let sum5 = 0;
  for (const s of last5) {
    sum5 += s;
  }
  const mean20 = sum20 / last20.length;
  const mean5 = sum5 / last5.length;
  if (mean20 <= 1e-12) {
    return null;
  }
  const deltaPct = ((mean5 / mean20) - 1) * 100;
  return Number.isFinite(deltaPct) ? deltaPct : null;
}

export interface RelationSeriesPoint {
  readonly time: number;
  readonly val: number;
  readonly volumeShare?: number | null;
}

function deduplicateBarsByDate(bars: readonly Bar[]): readonly { readonly dateKey: string; readonly bar: Bar }[] {
  const byDate = new Map<string, Bar>();
  for (const b of bars) {
    if (!Number.isFinite(b.close) || !Number.isFinite(b.time)) {
      continue;
    }
    const key = toUtcDateKey(b.time);
    const prev = byDate.get(key);
    if (prev === undefined || b.time >= prev.time) {
      byDate.set(key, b);
    }
  }
  return [...byDate.entries()]
    .map(([dateKey, bar]) => ({ dateKey, bar }))
    .sort((a, b) => a.bar.time - b.bar.time);
}

/**
 * Alinea dos series diarias por fecha UTC sin rellenos ni fallbacks silenciosos.
 */
export function alignDailyPairSeries(
  barsA: readonly Bar[],
  barsB: readonly Bar[],
  mode: 'RATIO' | 'DIFF',
  includeVolumeShare = true,
  denominatorIsSuperset = false,
): readonly RelationSeriesPoint[] {
  const dedupA = deduplicateBarsByDate(barsA);
  const mapB = new Map<string, Bar>();
  for (const { dateKey, bar } of deduplicateBarsByDate(barsB)) {
    mapB.set(dateKey, bar);
  }

  const out: RelationSeriesPoint[] = [];
  for (const { dateKey, bar: a } of dedupA) {
    const b = mapB.get(dateKey);
    if (b === undefined || a.close <= 0 || b.close <= 0) {
      continue;
    }
    const val = mode === 'DIFF' ? a.close - b.close : a.close / b.close;
    if (!Number.isFinite(val)) {
      continue;
    }
    let volumeShare: number | null = null;
    if (includeVolumeShare) {
      const effA = a.close * a.volume;
      const effB = b.close * b.volume;
      if (Number.isFinite(effA) && Number.isFinite(effB) && effA > 0 && effB > 0) {
        if (denominatorIsSuperset) {
          volumeShare = effA <= effB ? effA / effB : null;
        } else {
          volumeShare = effA / (effA + effB);
        }
      }
    }
    out.push({ time: a.time, val, volumeShare });
  }
  return out;
}

/**
 * Construye serie histórica diaria de USD CCL mediano combinando bonos cable
 * y paridad implícita de ADRs locales vs. NYSE.
 */
export function buildHistoricalCclByDate(sources: {
  readonly gd30Bars?: readonly Bar[];
  readonly gd30cBars?: readonly Bar[];
  readonly al30Bars?: readonly Bar[];
  readonly al30cBars?: readonly Bar[];
  readonly equityPairs?: ReadonlyArray<{
    readonly arBars: readonly Bar[];
    readonly usBars: readonly Bar[];
    readonly adrRatio: number;
  }>;
}): { readonly byDate: ReadonlyMap<string, number>; readonly timeByDate: ReadonlyMap<string, number> } {
  const candidates = new Map<string, number[]>();
  const timeByDate = new Map<string, number>();

  const pushCandidate = (dateKey: string, timeSec: number, val: number): void => {
    if (!Number.isFinite(val) || val <= 0) {
      return;
    }
    const arr = candidates.get(dateKey);
    if (arr === undefined) {
      candidates.set(dateKey, [val]);
    } else {
      arr.push(val);
    }
    const prevT = timeByDate.get(dateKey);
    if (prevT === undefined || timeSec > prevT) {
      timeByDate.set(dateKey, timeSec);
    }
  };

  const addCross = (
    numBars: readonly Bar[] | undefined,
    denBars: readonly Bar[] | undefined,
    multiplier: number,
  ): void => {
    if (numBars === undefined || denBars === undefined) {
      return;
    }
    const denMap = new Map<string, Bar>();
    for (const { dateKey, bar } of deduplicateBarsByDate(denBars)) {
      denMap.set(dateKey, bar);
    }
    for (const { dateKey, bar: n } of deduplicateBarsByDate(numBars)) {
      const d = denMap.get(dateKey);
      if (d !== undefined && n.close > 0 && d.close > 0) {
        pushCandidate(dateKey, n.time, (n.close * multiplier) / d.close);
      }
    }
  };

  addCross(sources.gd30Bars, sources.gd30cBars, 1);
  addCross(sources.al30Bars, sources.al30cBars, 1);
  for (const eq of sources.equityPairs ?? []) {
    addCross(eq.arBars, eq.usBars, eq.adrRatio);
  }

  const byDate = new Map<string, number>();
  for (const [dateKey, vals] of candidates.entries()) {
    const med = computeMedian(vals);
    if (med !== null && med > 0) {
      byDate.set(dateKey, med);
    }
  }
  return { byDate, timeByDate };
}

/**
 * Construye serie histórica diaria del Canje Implícito `(CCL / MEP - 1) * 100`.
 */
export function computeHistoricalCanjeSeries(sources: {
  readonly gd30Bars: readonly Bar[];
  readonly gd30dBars: readonly Bar[];
  readonly gd30cBars: readonly Bar[];
  readonly al30Bars: readonly Bar[];
  readonly al30dBars: readonly Bar[];
  readonly al30cBars: readonly Bar[];
  readonly equityPairs?: ReadonlyArray<{
    readonly arBars: readonly Bar[];
    readonly usBars: readonly Bar[];
    readonly adrRatio: number;
  }>;
}): readonly RelationSeriesPoint[] {
  const ccl = buildHistoricalCclByDate(sources);
  const mepCandidates = new Map<string, number[]>();

  const addMep = (arsBars: readonly Bar[], usdBars: readonly Bar[]): void => {
    const usdMap = new Map<string, Bar>();
    for (const { dateKey, bar } of deduplicateBarsByDate(usdBars)) {
      usdMap.set(dateKey, bar);
    }
    for (const { dateKey, bar: ars } of deduplicateBarsByDate(arsBars)) {
      const usd = usdMap.get(dateKey);
      if (usd !== undefined && ars.close > 0 && usd.close > 0) {
        const val = ars.close / usd.close;
        const arr = mepCandidates.get(dateKey);
        if (arr === undefined) {
          mepCandidates.set(dateKey, [val]);
        } else {
          arr.push(val);
        }
      }
    }
  };

  addMep(sources.al30Bars, sources.al30dBars);
  addMep(sources.gd30Bars, sources.gd30dBars);

  const sortedDates = [...ccl.byDate.keys()].sort();
  const out: RelationSeriesPoint[] = [];
  for (const dk of sortedDates) {
    const cclVal = ccl.byDate.get(dk);
    const mepList = mepCandidates.get(dk);
    const mepVal = mepList !== undefined ? computeMedian(mepList) : null;
    const timeSec = ccl.timeByDate.get(dk);
    if (cclVal === undefined || mepVal === null || mepVal <= 0 || timeSec === undefined) {
      continue;
    }
    const canjePct = ((cclVal / mepVal) - 1) * 100;
    if (Number.isFinite(canjePct)) {
      out.push({ time: timeSec, val: canjePct, volumeShare: null });
    }
  }
  return out;
}

/**
 * Índice relativo equiponderado de retornos diarios (o mediana en denominador para benchmark)
 * en USD-CCL o moneda homogénea, más participación de volumen efectivo por fecha.
 */
export function computeBasketRelativeSeries(params: {
  readonly numBarsList: readonly (readonly Bar[])[];
  readonly denBarsList: readonly (readonly Bar[])[];
  readonly deflatorByDate?: ReadonlyMap<string, number> | null;
  readonly denominatorAggregator?: 'EQUAL_RETURN_INDEX' | 'MEDIAN_RETURN_INDEX';
  readonly denominatorIsSuperset?: boolean;
}): readonly RelationSeriesPoint[] {
  const {
    numBarsList,
    denBarsList,
    deflatorByDate = null,
    denominatorAggregator = 'EQUAL_RETURN_INDEX',
    denominatorIsSuperset = false,
  } = params;

  const numMaps = numBarsList.map((bars) => {
    const m = new Map<string, Bar>();
    for (const { dateKey, bar } of deduplicateBarsByDate(bars)) {
      m.set(dateKey, bar);
    }
    return m;
  });
  const denMaps = denBarsList.map((bars) => {
    const m = new Map<string, Bar>();
    for (const { dateKey, bar } of deduplicateBarsByDate(bars)) {
      m.set(dateKey, bar);
    }
    return m;
  });

  const dateToTime = new Map<string, number>();
  for (const m of [...numMaps, ...denMaps]) {
    for (const [dk, bar] of m.entries()) {
      const prev = dateToTime.get(dk);
      if (prev === undefined || bar.time > prev) {
        dateToTime.set(dk, bar.time);
      }
    }
  }

  const allDates = [...dateToTime.keys()].sort();
  const minNum = Math.min(2, numMaps.length);
  const minDen = Math.min(2, denMaps.length);

  let started = false;
  let idxNum = 100;
  let idxDen = 100;
  let prevNum = new Map<number, number>();
  let prevDen = new Map<number, number>();
  const out: RelationSeriesPoint[] = [];

  for (const dk of allDates) {
    const ts = dateToTime.get(dk);
    if (ts === undefined) {
      continue;
    }
    const defl = deflatorByDate !== null ? deflatorByDate.get(dk) : 1;
    if (defl === undefined || !Number.isFinite(defl) || defl <= 0) {
      continue;
    }

    const curNum = new Map<number, number>();
    let effNum = 0;
    for (let j = 0; j < numMaps.length; j += 1) {
      const m = numMaps[j];
      const b = m?.get(dk);
      if (b !== undefined && b.close > 0) {
        curNum.set(j, b.close / defl);
        if (b.volume > 0) {
          effNum += (b.close * b.volume) / defl;
        }
      }
    }

    const curDen = new Map<number, number>();
    let effDen = 0;
    for (let j = 0; j < denMaps.length; j += 1) {
      const m = denMaps[j];
      const b = m?.get(dk);
      if (b !== undefined && b.close > 0) {
        curDen.set(j, b.close / defl);
        if (b.volume > 0) {
          effDen += (b.close * b.volume) / defl;
        }
      }
    }

    const computeShare = (): number | null => {
      if (effNum <= 0 || effDen <= 0) {
        return null;
      }
      if (denominatorIsSuperset) {
        return effNum <= effDen ? effNum / effDen : null;
      }
      return effNum / (effNum + effDen);
    };

    if (!started) {
      if (curNum.size >= minNum && curDen.size >= minDen) {
        started = true;
        prevNum = curNum;
        prevDen = curDen;
        out.push({ time: ts, val: idxNum / idxDen, volumeShare: computeShare() });
      }
      continue;
    }

    const rNum: number[] = [];
    for (const [j, px] of curNum.entries()) {
      const pPrev = prevNum.get(j);
      if (pPrev !== undefined && pPrev > 0) {
        rNum.push(px / pPrev - 1);
      }
    }

    const rDen: number[] = [];
    for (const [j, px] of curDen.entries()) {
      const pPrev = prevDen.get(j);
      if (pPrev !== undefined && pPrev > 0) {
        rDen.push(px / pPrev - 1);
      }
    }

    if (rNum.length < minNum || rDen.length < minDen) {
      continue;
    }

    const meanRNum = rNum.reduce((acc, r) => acc + r, 0) / rNum.length;
    const aggRDen =
      denominatorAggregator === 'MEDIAN_RETURN_INDEX'
        ? computeMedian(rDen)
        : rDen.reduce((acc, r) => acc + r, 0) / rDen.length;

    if (aggRDen === null || 1 + meanRNum <= 0 || 1 + aggRDen <= 0) {
      continue;
    }

    idxNum *= 1 + meanRNum;
    idxDen *= 1 + aggRDen;
    prevNum = curNum;
    prevDen = curDen;
    const ratio = idxNum / idxDen;
    if (Number.isFinite(ratio)) {
      out.push({ time: ts, val: ratio, volumeShare: computeShare() });
    }
  }

  return out;
}

/**
 * Calcula estadísticos completos de una relación (`>= 20` obs requeridas, `60` objetivo)
 * sin fallbacks silenciosos.
 */
export function computeRelationPairStats(
  series: readonly RelationSeriesPoint[],
  explicitShares: readonly number[] | null = null,
  minObservations = 20,
): {
  readonly currentValue: number | null;
  readonly mean60d: number | null;
  readonly std60d: number | null;
  readonly zScore: number | null;
  readonly percentile60d: number | null;
  readonly halfLifeDays: number | null;
  readonly capitalFlowDeltaPct: number | null;
  readonly opportunityBadge: RelationOpportunityBadge | null;
  readonly observationCount: number;
  readonly sparkline: readonly number[];
  readonly history: readonly { readonly time: number; readonly ratio: number; readonly zScore: number }[];
} {
  const recent60 = series.slice(-60).filter((p) => Number.isFinite(p.val) && Number.isFinite(p.time));
  const vals60 = recent60.map((p) => p.val);
  const latest = vals60.length > 0 ? vals60[vals60.length - 1] ?? null : null;
  const currentValue = sanitizeFinite(latest);
  const sparkline = vals60.slice(-30);

  let derivedFlowDelta: number | null = null;
  if (explicitShares !== null) {
    derivedFlowDelta = sanitizeFinite(computeCapitalFlowDeltaPct(explicitShares));
  } else {
    const tail5AllValid =
      recent60.length >= 20 &&
      recent60
        .slice(-5)
        .every((p) => typeof p.volumeShare === 'number' && Number.isFinite(p.volumeShare) && p.volumeShare > 0);
    if (tail5AllValid) {
      const validShares = recent60
        .map((p) => p.volumeShare)
        .filter((s): s is number => typeof s === 'number' && Number.isFinite(s) && s > 0 && s <= 1);
      derivedFlowDelta = sanitizeFinite(computeCapitalFlowDeltaPct(validShares));
    }
  }

  if (vals60.length < minObservations || currentValue === null) {
    return {
      currentValue,
      mean60d: null,
      std60d: null,
      zScore: null,
      percentile60d: null,
      halfLifeDays: null,
      capitalFlowDeltaPct: derivedFlowDelta,
      opportunityBadge: null,
      observationCount: vals60.length,
      sparkline,
      history: [],
    };
  }

  const stats = computeMeanAndStd(vals60);
  const mean60d = sanitizeFinite(stats?.mean);
  const std60d = sanitizeFinite(stats?.std);
  const zScore =
    mean60d !== null && std60d !== null && std60d > 1e-8
      ? sanitizeFinite((currentValue - mean60d) / std60d)
      : null;
  const belowCount = vals60.filter((v) => v <= currentValue).length;
  const percentile60d = sanitizeFinite((belowCount / vals60.length) * 100);
  const halfLifeDays = sanitizeFinite(computeOuHalfLifeDays(vals60));
  const opportunityBadge = computeOpportunityBadge(zScore);
  const history = recent60.map((p) => ({
    time: p.time,
    ratio: p.val,
    zScore:
      mean60d !== null && std60d !== null && std60d > 1e-8
        ? (p.val - mean60d) / std60d
        : 0,
  }));

  return {
    currentValue,
    mean60d,
    std60d,
    zScore,
    percentile60d,
    halfLifeDays,
    capitalFlowDeltaPct: derivedFlowDelta,
    opportunityBadge,
    observationCount: vals60.length,
    sparkline,
    history,
  };
}

/**
 * Calcula valor técnico residual, TIR (XIRR anualizada ACT/365) y Duration Modificada
 * de un bono soberano argentino sobre sus flujos reales de prospecto.
 */
export function evaluateSovereignBondMath(
  spec: SovereignBondSpec,
  marketPriceUsd: number,
  asOfUtcSec: number,
): {
  readonly tirPct: number | null;
  readonly parityPct: number | null;
  readonly duration: number | null;
  readonly accruedInterest: number | null;
} {
  if (!Number.isFinite(marketPriceUsd) || marketPriceUsd <= 0) {
    return { tirPct: null, parityPct: null, duration: null, accruedInterest: null };
  }

  const futureFlows = spec.flows.filter((f) => f.dateUtcSec > asOfUtcSec);
  const prevFlow = [...spec.flows].reverse().find((f) => f.dateUtcSec <= asOfUtcSec);
  if (futureFlows.length === 0) {
    return { tirPct: null, parityPct: null, duration: null, accruedInterest: null };
  }

  const residualPrincipal = futureFlows.reduce((acc, f) => acc + f.amortization, 0);
  if (residualPrincipal <= 0) {
    return { tirPct: null, parityPct: null, duration: null, accruedInterest: null };
  }

  const nextFlow = futureFlows[0];
  let accruedInterest = 0;
  if (nextFlow !== undefined) {
    const prevSec = prevFlow?.dateUtcSec ?? nextFlow.dateUtcSec - 182.5 * 86_400;
    const periodSec = Math.max(86_400, nextFlow.dateUtcSec - prevSec);
    const elapsedSec = Math.max(0, asOfUtcSec - prevSec);
    accruedInterest = nextFlow.coupon * Math.min(1, elapsedSec / periodSec);
  }
  const technicalValue = residualPrincipal + accruedInterest;
  const parityPct = technicalValue > 0 ? (marketPriceUsd / technicalValue) * 100 : null;

  const yearFrac = (tSec: number): number => Math.max(1 / 365, (tSec - asOfUtcSec) / (365 * 86_400));

  const npvMinusPrice = (y: number): number => {
    let pv = 0;
    for (const f of futureFlows) {
      const t = yearFrac(f.dateUtcSec);
      const cf = f.coupon + f.amortization;
      pv += cf / Math.pow(1 + y, t);
    }
    return pv - marketPriceUsd;
  };

  let lo = -0.5;
  let hi = 2.5;
  let fLo = npvMinusPrice(lo);
  let fHi = npvMinusPrice(hi);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo * fHi > 0) {
    return {
      tirPct: null,
      parityPct: sanitizeFinite(parityPct),
      duration: null,
      accruedInterest: sanitizeFinite(accruedInterest),
    };
  }

  for (let i = 0; i < 80; i += 1) {
    const mid = 0.5 * (lo + hi);
    const fMid = npvMinusPrice(mid);
    if (!Number.isFinite(fMid)) {
      break;
    }
    if (Math.abs(fMid) < 1e-8 || hi - lo < 1e-8) {
      lo = mid;
      hi = mid;
      break;
    }
    if (fLo * fMid <= 0) {
      hi = mid;
      fHi = fMid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  const yieldIrr = 0.5 * (lo + hi);

  let macWeighted = 0;
  let totalPv = 0;
  for (const f of futureFlows) {
    const t = yearFrac(f.dateUtcSec);
    const pv = (f.coupon + f.amortization) / Math.pow(1 + yieldIrr, t);
    macWeighted += t * pv;
    totalPv += pv;
  }
  const macDuration = totalPv > 0 ? macWeighted / totalPv : Number.NaN;
  const modDuration = Number.isFinite(macDuration) ? macDuration / (1 + yieldIrr) : Number.NaN;

  return {
    tirPct: sanitizeFinite(yieldIrr * 100),
    parityPct: sanitizeFinite(parityPct),
    duration: sanitizeFinite(modDuration),
    accruedInterest: sanitizeFinite(accruedInterest),
  };
}

interface ParsedBymaOptionSymbol {
  readonly symbol: string;
  readonly underlying: string;
  readonly contractType: 'call' | 'put';
  readonly strike: number;
  readonly expiryCode: string;
  readonly expiryLabel: string;
  readonly expirationDate: string;
  readonly expiryUtcSec: number;
  readonly daysToExpiry: number;
}

/**
 * Parsea determinísticamente símbolos de opciones BYMA sin heurísticas basadas en el precio spot.
 * Contratos sin metadata explícita cuya escala de strike sea ambigua devuelven `null`.
 */
export function parseBymaOptionSymbol(
  rawSymbol: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _spotHint: number | null = null,
  asOfUtcSec = 0,
  includeNearExpiry = false,
  arHolidays: readonly string[] = [],
  metadataRecords?: readonly BymaContractMetadataRecord[],
): ParsedBymaOptionSymbol | null {
  const resolved = resolveBymaOptionContract({
    rawSymbol,
    asOfUtcSec,
    includeNearExpiry,
    arHolidays,
    knownUnderlyings: STOCK_META_MAP,
    ...(metadataRecords !== undefined ? { metadataRecords } : {}),
  });
  if (
    (resolved.strikeResolutionStatus !== 'EXPLICIT_METADATA' &&
      resolved.strikeResolutionStatus !== 'CANONICAL_SYMBOL') ||
    resolved.underlying === null ||
    resolved.side === null ||
    resolved.strike === null ||
    resolved.contractualExpiry === null ||
    resolved.expiryCode === null ||
    resolved.expiryLabel === null ||
    resolved.expiryUtcSec === null ||
    resolved.daysToExpiry === null
  ) {
    return null;
  }

  return {
    symbol: resolved.nativeSymbol,
    underlying: resolved.underlying,
    contractType: resolved.side,
    strike: Math.round(resolved.strike * 10_000) / 10_000,
    expiryCode: resolved.expiryCode,
    expiryLabel: resolved.expiryLabel,
    expirationDate: resolved.contractualExpiry,
    expiryUtcSec: resolved.expiryUtcSec,
    daysToExpiry: resolved.daysToExpiry,
  };
}

function getArgentinaMarketState(nowUtcSec: number): {
  readonly state: ArOverviewResponse['marketState'];
  readonly label: string;
} {
  // ART = UTC-3 (sin DST desde 2009)
  const artMs = (nowUtcSec - 3 * 3_600) * 1_000;
  const artDate = new Date(artMs);
  const dow = artDate.getUTCDay();
  const minutes = artDate.getUTCHours() * 60 + artDate.getUTCMinutes();
  const isWeekday = dow >= 1 && dow <= 5;
  if (!isWeekday) {
    return { state: 'CERRADO', label: 'Fin de semana · Último cierre BYMA' };
  }
  if (minutes >= 10 * 60 + 30 && minutes < 11 * 60) {
    return { state: 'SUBASTA', label: 'Subasta de apertura BYMA (10:30–11:00 ART)' };
  }
  if (minutes >= 11 * 60 && minutes < 17 * 60) {
    return { state: 'ABIERTO', label: 'Rueda BYMA abierta (11:00–17:00 ART)' };
  }
  if (minutes >= 9 * 60 + 30 && minutes < 10 * 60 + 30) {
    return { state: 'PREMARKET', label: 'Pre-apertura BYMA / Rueda Cauciones' };
  }
  return { state: 'CERRADO', label: 'Post-cierre BYMA · Datos consolidados' };
}

export interface NormalizedQuoteRow {
  readonly fieldProvenance?: OptionFieldProvenanceMap;

  readonly symbol: string;
  readonly last: number | null;
  readonly bid: number | null;
  readonly bidSize: number | null;
  readonly ask: number | null;
  readonly askSize: number | null;
  readonly prevClose: number | null;
  readonly deltaPct: number | null;
  readonly low: number | null;
  readonly high: number | null;
  readonly vwap: number | null;
  readonly volumeArs: number | null;
  readonly nominalVol: number | null;
  readonly mark: number | null;
  readonly impliedUsdArs: number | null;
  readonly arsBid: number | null;
  readonly arsAsk: number | null;
  readonly usdBid: number | null;
  readonly usdAsk: number | null;
  readonly openInterest?: number | null;
  readonly quoteSource?: 'DATA912' | 'BMB_HOMEBROKER_BRIDGE' | 'OPEN_BYMA';
  readonly quoteAsOfUtcSec?: number | null;
  readonly explicitStrike?: number | null;
  readonly explicitExpirationDate?: string | null;
  readonly explicitUnderlying?: string | null;
  readonly explicitMetadataSource?: 'DATA912_METADATA' | 'OPEN_BYMA_METADATA';
}

export function normalizeData912Rows(
  raw: unknown,
  source: 'DATA912' | 'OPEN_BYMA' = 'DATA912',
  options = false,
): readonly NormalizedQuoteRow[] {
  let arr: readonly unknown[] = [];
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (isPlainRecord(raw)) {
    for (const key of ['data', 'results', 'items', 'quotes']) {
      const candidate = raw[key];
      if (Array.isArray(candidate)) {
        arr = candidate;
        break;
      }
    }
  }

  const rows: NormalizedQuoteRow[] = [];
  for (const item of arr) {
    if (!isPlainRecord(item)) {
      continue;
    }
    const sym = readStr(item, ['symbol', 'ticker', 'Symbol', 'especie']);
    if (sym === null) {
      continue;
    }
    const cleanSym = sym.toUpperCase();
    const last = readNum(item, ['c', 'close', 'last', 'px_last', 'mark', 'trade', 'settlementPrice']);
    const bid = sanitizePositive(readNum(item, ['px_bid', 'bid', 'bidPrice', 'ars_bid']));
    const bidSizeRaw = readNum(item, ['q_bid', 'bidSize', 'bid_size', 'bidQty']);
    const ask = sanitizePositive(readNum(item, ['px_ask', 'ask', 'askPrice', 'ars_ask']));
    const askSizeRaw = readNum(item, ['q_ask', 'askSize', 'ask_size', 'askQty']);
    const bidSize = bid !== null ? sanitizePositive(bidSizeRaw) : null;
    const askSize = ask !== null ? sanitizePositive(askSizeRaw) : null;
    const prevCloseRaw = readNum(item, ['prev_close', 'previousClose', 'closingPrice', 'open', 'o']);
    const deltaPctRaw = readNum(item, ['pct_change', 'imbalance', 'variation', 'changePct', 'var']);
    const lowRaw = readNum(item, ['l', 'low', 'min', 'lowPrice']);
    const highRaw = readNum(item, ['h', 'high', 'max', 'highPrice']);
    const vwap = readNum(item, ['vw', 'vwap']);
    const volumeArsRaw = readNum(item, ['v_ars', 'volumeAmount', 'monto', 'amount']);
    const nominalVol = readNum(item, ['v', 'q_op', 'volume', 'nominalVolume']);
    const itemTsSec = parseTimestampSec(item['timestamp'] ?? item['updated_at'] ?? item['date'] ?? item['t']);
    const openInterestRaw = item['open_interest'] ?? item['openInterest'] ?? item['oi'];
    const optionPrefix = /^([A-Z]{3,4})[CV]\d/.exec(cleanSym)?.[1];
    const explicitMult = readNum(item, ['contractMultiplier', 'shares_per_contract', 'lotSize']);
    const multiplier = explicitMult !== null
      ? resolveContractMultiplier(explicitMult, 'EXCHANGE_CONTRACT_SPEC')
      : options && optionPrefix !== undefined && OPTION_PREFIX_TO_UNDERLYING[optionPrefix] !== undefined
        ? resolveContractMultiplier(OPTION_LOT_SIZE, 'BYMA_STANDARD_TABLE')
        : null;
    const oi = classifyRawOiValue(openInterestRaw, source, itemTsSec, multiplier);
    const openInterest = oi.status === 'DIRECT_CONTRACT_OI' ? oi.contracts : null;
    const fieldProvenance = mergeOptionFieldProvenance(
      oi, { volume: nominalVol, bid, ask, bidSize, askSize, lastTrade: last }, source, itemTsSec,
    );
    const mark = readNum(item, ['mark', 'c', 'close', 'last']);
    const arsBid = readNum(item, ['ars_bid']);
    const arsAsk = readNum(item, ['ars_ask']);
    const usdBid = readNum(item, ['usd_bid']);
    const usdAsk = readNum(item, ['usd_ask']);
    const explicitStrike = sanitizePositive(readNum(item, ['strike', 'strikePrice', 'exercisePrice']));
    const explicitExpirationDate = readStr(item, ['expirationDate', 'contractualExpiry', 'maturityDate']);
    const explicitUnderlying = readStr(item, ['underlying', 'underlyingSymbol'])?.toUpperCase() ?? null;

    const prevClose =
      prevCloseRaw !== null
        ? prevCloseRaw
        : last !== null && last > 0 && deltaPctRaw !== null && Number.isFinite(deltaPctRaw) && deltaPctRaw > -99
          ? Number((last / (1 + deltaPctRaw / 100)).toFixed(4))
          : null;

    let computedDeltaPct = deltaPctRaw;
    if (computedDeltaPct === null && last !== null && prevClose !== null && prevClose > 0) {
      computedDeltaPct = ((last - prevClose) / prevClose) * 100;
    }

    const volumeArs =
      volumeArsRaw !== null
        ? volumeArsRaw
        : nominalVol !== null && last !== null && nominalVol > 0 && last > 0
          ? Math.round(nominalVol * last)
          : null;

    const rangeCandidates = [last, prevClose, bid, ask].filter(
      (v): v is number => v !== null && Number.isFinite(v) && v > 0,
    );
    const low = lowRaw !== null ? lowRaw : rangeCandidates.length > 0 ? Math.min(...rangeCandidates) : null;
    const high = highRaw !== null ? highRaw : rangeCandidates.length > 0 ? Math.max(...rangeCandidates) : null;

    rows.push({
      symbol: cleanSym,
      last,
      bid,
      bidSize,
      ask,
      askSize,
      prevClose,
      deltaPct: sanitizeFinite(computedDeltaPct),
      low,
      high,
      vwap,
      volumeArs,
      nominalVol,
      mark,
      impliedUsdArs: mark,
      arsBid,
      arsAsk,
      usdBid,
      usdAsk,
      openInterest,
      fieldProvenance,
      quoteSource: source,
      quoteAsOfUtcSec: itemTsSec,
      ...(explicitStrike !== null
        ? {
            explicitStrike,
            explicitMetadataSource: source === 'OPEN_BYMA' ? ('OPEN_BYMA_METADATA' as const) : ('DATA912_METADATA' as const),
          }
        : {}),
      ...(explicitExpirationDate !== null ? { explicitExpirationDate } : {}),
      ...(explicitUnderlying !== null ? { explicitUnderlying } : {}),
    });
  }
  return rows;
}

interface BmbNormalizedMergeResult {
  readonly rows: readonly NormalizedQuoteRow[];
  readonly hasLiveActivity: boolean;
  readonly hasLiveLast: boolean;
}

function bmbSnapshotHasLiveActivity(snapshot: BmbBridgeSnapshotDto | null): boolean {
  return (
    snapshot !== null &&
    snapshot.health.connected &&
    (snapshot.health.status === 'READY' || snapshot.health.status === 'CONNECTED_L2')
  );
}

/**
 * Overlay only genuine BMB observations. A BBO updates bid/ask fields but is
 * never promoted to a synthetic last trade. Data912 remains the explicit last-
 * price baseline for symbols for which the bridge exposes books but no trades.
 */
function mergeBmbNormalizedRows(
  rows: readonly NormalizedQuoteRow[],
  snapshot: BmbBridgeSnapshotDto | null,
  nowUtcSec: number,
  allowedSymbols: ReadonlySet<string>,
  maxAgeSec = 20,
): BmbNormalizedMergeResult {
  if (!bmbSnapshotHasLiveActivity(snapshot) || snapshot === null) {
    return { rows, hasLiveActivity: false, hasLiveLast: false };
  }
  const bySymbol = new Map(rows.map((row) => [row.symbol.toUpperCase(), row]));
  let hasLiveActivity = false;
  let hasLiveLast = false;
  const symbols = new Set(
    [...allowedSymbols]
      .map((symbol) => symbol.toUpperCase())
      .filter(
        (symbol) =>
          snapshot.orderBooksBySymbol[symbol] !== undefined ||
          (snapshot.tradesBySymbol?.[symbol]?.length ?? 0) > 0,
      ),
  );
  for (const rawSymbol of symbols) {
    const symbol = rawSymbol.toUpperCase();
    const existing = bySymbol.get(symbol);
    const book = snapshot.orderBooksBySymbol[symbol];
    const bookFresh =
      book !== undefined &&
      book.asOfUtcSec !== null &&
      Number.isInteger(book.asOfUtcSec) &&
      nowUtcSec >= book.asOfUtcSec &&
      nowUtcSec - book.asOfUtcSec <= maxAgeSec;
    const bids = bookFresh ? book.bids : [];
    const asks = bookFresh ? book.asks : [];
    const bestBid = bids[0];
    const bestAsk = asks[0];
    let latestTrade: BmbTradeRowDto | null = null;
    for (const trade of snapshot.tradesBySymbol?.[symbol] ?? []) {
      if (
        !Number.isInteger(trade.timeSec) ||
        trade.timeSec <= 0 ||
        nowUtcSec < trade.timeSec ||
        nowUtcSec - trade.timeSec > maxAgeSec ||
        !Number.isFinite(trade.price) ||
        trade.price <= 0
      ) {
        continue;
      }
      if (
        latestTrade === null ||
        trade.timeSec > latestTrade.timeSec ||
        (trade.timeSec === latestTrade.timeSec && trade.sequence > latestTrade.sequence)
      ) {
        latestTrade = trade;
      }
    }
    if (!bookFresh && latestTrade === null) continue;
    hasLiveActivity = true;
    if (latestTrade !== null) hasLiveLast = true;
    const inferredPrevClose =
      existing?.prevClose ??
      (existing?.last !== null &&
      existing?.last !== undefined &&
      existing.last > 0 &&
      existing.deltaPct !== null &&
      Number.isFinite(existing.deltaPct) &&
      existing.deltaPct > -99
        ? existing.last / (1 + existing.deltaPct / 100)
        : null);
    const liveLast = latestTrade?.price ?? existing?.last ?? null;
    const deltaPct =
      latestTrade !== null && inferredPrevClose !== null && inferredPrevClose > 0
        ? ((latestTrade.price - inferredPrevClose) / inferredPrevClose) * 100
        : existing?.deltaPct ?? null;
    const low =
      latestTrade !== null && existing?.low !== null && existing?.low !== undefined
        ? Math.min(existing.low, latestTrade.price)
        : existing?.low ?? null;
    const high =
      latestTrade !== null && existing?.high !== null && existing?.high !== undefined
        ? Math.max(existing.high, latestTrade.price)
        : existing?.high ?? null;
    bySymbol.set(symbol, {
      symbol,
      last: liveLast,
      bid: bestBid?.price ?? existing?.bid ?? null,
      bidSize: bestBid?.size ?? existing?.bidSize ?? null,
      ask: bestAsk?.price ?? existing?.ask ?? null,
      askSize: bestAsk?.size ?? existing?.askSize ?? null,
      prevClose: inferredPrevClose,
      deltaPct: sanitizeFinite(deltaPct),
      low,
      high,
      vwap: existing?.vwap ?? null,
      volumeArs: existing?.volumeArs ?? null,
      nominalVol: existing?.nominalVol ?? null,
      mark: existing?.mark ?? liveLast,
      impliedUsdArs: existing?.impliedUsdArs ?? null,
      arsBid: existing?.arsBid ?? null,
      arsAsk: existing?.arsAsk ?? null,
      usdBid: existing?.usdBid ?? null,
      usdAsk: existing?.usdAsk ?? null,
      ...(existing === undefined || existing.fieldProvenance !== undefined
        ? {
            fieldProvenance: (() => {
              const baseOi = existing?.fieldProvenance?.openInterest ?? missingOi('L1_OVERLAY_NO_OI');
              const bboProvenance = mergeOptionFieldProvenance(
                baseOi,
                {
                  bid: bestBid?.price ?? null,
                  bidSize: bestBid?.size ?? null,
                  ask: bestAsk?.price ?? null,
                  askSize: bestAsk?.size ?? null,
                },
                'BMB_HOMEBROKER_BRIDGE',
                book?.asOfUtcSec ?? null,
                existing?.fieldProvenance,
              );
              return latestTrade === null
                ? bboProvenance
                : mergeOptionFieldProvenance(
                    baseOi,
                    { lastTrade: latestTrade.price },
                    'BMB_HOMEBROKER_BRIDGE',
                    latestTrade.timeSec,
                    bboProvenance,
                  );
            })(),
          }
        : {}),
      ...(existing?.openInterest !== undefined ? { openInterest: existing.openInterest } : {}),
      ...(latestTrade !== null || existing === undefined
        ? { quoteSource: 'BMB_HOMEBROKER_BRIDGE' as const }
        : existing.quoteSource !== undefined
          ? { quoteSource: existing.quoteSource }
          : {}),
      quoteAsOfUtcSec: latestTrade?.timeSec ?? existing?.quoteAsOfUtcSec ?? null,
    });
  }
  return { rows: [...bySymbol.values()], hasLiveActivity, hasLiveLast };
}

export interface MergeBmbOptionQuotesInput {
  readonly rows: readonly NormalizedQuoteRow[];
  readonly bmbSnapshot: BmbBridgeSnapshotDto | null;
  readonly underlying: string;
  readonly spotHint: number | null;
  readonly nowUtcSec: number;
  readonly maxQuoteAgeSec?: number;
  readonly trackFieldProvenance?: boolean;
  readonly arHolidays?: readonly string[];
}

/**
 * Overlay fresh BMB option BBO/size/last/volume on Data912 contract metadata.
 * OI is never inferred from BMB volume; stale or unauthenticated panels change nothing.
 */
export function mergeBmbOptionQuotes(input: MergeBmbOptionQuotesInput): readonly NormalizedQuoteRow[] {
  const snapshot = input.bmbSnapshot;
  const maxAgeSec = input.maxQuoteAgeSec ?? 30;
  if (
    snapshot === null ||
    (snapshot.health.status !== 'READY' && snapshot.health.status !== 'CONNECTED_L2') ||
    !snapshot.health.connected ||
    !Number.isInteger(input.nowUtcSec) ||
    !Number.isFinite(maxAgeSec) ||
    maxAgeSec < 0
  ) {
    return input.rows;
  }

  const positiveOrNull = (value: number | null): number | null =>
    value !== null && Number.isFinite(value) && value > 0 ? value : null;
  const nonNegativeOrNull = (value: number | null): number | null =>
    value !== null && Number.isFinite(value) && value >= 0 ? value : null;
  const underlying = input.underlying.trim().toUpperCase();
  const freshBySymbol = new Map<string, BmbOptionRowDto>();
  for (const quote of snapshot.options) {
    const symbol = quote.symbol.trim().toUpperCase();
    const ageSec = quote.asOfUtcSec !== null ? input.nowUtcSec - quote.asOfUtcSec : Number.NaN;
    if (
      symbol === '' ||
      quote.asOfUtcSec === null ||
      !Number.isInteger(quote.asOfUtcSec) ||
      ageSec < 0 ||
      ageSec > maxAgeSec
    ) {
      continue;
    }
    const quoteStrike = positiveOrNull(quote.strike ?? null);
    const quoteExpiry =
      typeof quote.expirationDate === 'string' && quote.expirationDate.trim() !== ''
        ? quote.expirationDate.trim()
        : null;
    const bmbMeta: BymaContractMetadataRecord | undefined =
      quoteStrike !== null
        ? {
            source: 'BMB_OPTION_METADATA',
            nativeSymbol: symbol,
            underlying: quote.underlying,
            strike: quoteStrike,
            ...(quoteExpiry !== null ? { contractualExpiry: quoteExpiry } : {}),
            unit: 'ARS',
          }
        : undefined;
    const resolved = resolveBymaOptionContract({
      rawSymbol: symbol,
      asOfUtcSec: input.nowUtcSec,
      includeNearExpiry: input.trackFieldProvenance === true,
      arHolidays: input.arHolidays ?? [],
      knownUnderlyings: STOCK_META_MAP,
      ...(bmbMeta !== undefined ? { metadataRecords: [bmbMeta] } : {}),
    });
    if (resolved.strikeResolutionStatus === 'INVALID_SYMBOL' || resolved.underlying !== underlying) {
      continue;
    }
    freshBySymbol.set(symbol, quote);
  }
  if (freshBySymbol.size === 0) {
    return input.rows;
  }

  const underlyingHasStandardTable = Object.values(OPTION_PREFIX_TO_UNDERLYING).includes(underlying);
  const applyQuote = (row: NormalizedQuoteRow, quote: BmbOptionRowDto): NormalizedQuoteRow => {
    const track = input.trackFieldProvenance === true || row.fieldProvenance !== undefined;
    const bid = positiveOrNull(quote.bid) ?? (track ? row.bid : null);
    const ask = positiveOrNull(quote.ask) ?? (track ? row.ask : null);
    const last = positiveOrNull(quote.last) ?? (track ? row.last : null);
    const bidSize = positiveOrNull(quote.bidSize) ?? (track && positiveOrNull(quote.bid) === null ? row.bidSize : null);
    const askSize = positiveOrNull(quote.askSize) ?? (track && positiveOrNull(quote.ask) === null ? row.askSize : null);
    const volume = nonNegativeOrNull(quote.volume) ?? (track ? row.nominalVol : null);
    const mid = bid !== null && ask !== null && ask >= bid ? 0.5 * (bid + ask) : last;
    const baseOiSource =
      row.quoteSource === 'OPEN_BYMA'
        ? 'OPEN_BYMA'
        : row.quoteSource === 'BMB_HOMEBROKER_BRIDGE'
          ? 'BMB_HOMEBROKER_BRIDGE'
          : 'DATA912';
    const baseOi = track
      ? row.fieldProvenance?.openInterest ??
        (row.openInterest != null
          ? classifyRawOiValue(
              row.openInterest,
              baseOiSource,
              row.quoteAsOfUtcSec ?? null,
              underlyingHasStandardTable
                ? resolveContractMultiplier(OPTION_LOT_SIZE, 'BYMA_STANDARD_TABLE')
                : null,
            )
          : missingOi('L1_OVERLAY_NO_OI'))
      : undefined;
    const fieldProvenance = track && baseOi !== undefined ? mergeOptionFieldProvenance(
      baseOi,
      { bid: positiveOrNull(quote.bid), ask: positiveOrNull(quote.ask),
        bidSize: positiveOrNull(quote.bidSize), askSize: positiveOrNull(quote.askSize),
        lastTrade: positiveOrNull(quote.last), volume: nonNegativeOrNull(quote.volume) },
      'BMB_HOMEBROKER_BRIDGE', quote.asOfUtcSec, row.fieldProvenance,
    ) : undefined;
    const openInterest = track && baseOi !== undefined
      ? (baseOi.status === 'DIRECT_CONTRACT_OI' ? baseOi.contracts : null)
      : (row.openInterest ?? null);
    return {
      ...row,
      symbol: quote.symbol.trim().toUpperCase(),
      last, bid, bidSize, ask, askSize,
      deltaPct: sanitizeFinite(quote.varPct) ?? (track ? row.deltaPct : null),
      nominalVol: volume,
      volumeArs: nonNegativeOrNull(quote.turnover) ?? (track ? row.volumeArs : null),
      mark: mid,
      openInterest,
      ...(fieldProvenance !== undefined ? { fieldProvenance } : {}),
      quoteSource: 'BMB_HOMEBROKER_BRIDGE',
      quoteAsOfUtcSec: quote.asOfUtcSec,
    };
  };

  const out: NormalizedQuoteRow[] = [];
  const seen = new Set<string>();
  for (const row of input.rows) {
    const symbol = row.symbol.trim().toUpperCase();
    const quote = freshBySymbol.get(symbol);
    if (quote === undefined) {
      out.push(row);
    } else {
      out.push(applyQuote(row, quote));
      seen.add(symbol);
    }
  }

  for (const [symbol, quote] of freshBySymbol) {
    if (seen.has(symbol) || input.rows.some((row) => row.symbol.trim().toUpperCase() === symbol)) {
      continue;
    }
    const bid = positiveOrNull(quote.bid);
    const ask = positiveOrNull(quote.ask);
    const last = positiveOrNull(quote.last);
    const mid = bid !== null && ask !== null && ask >= bid ? 0.5 * (bid + ask) : last;
    const row: NormalizedQuoteRow = {
      symbol,
      last,
      bid,
      bidSize: positiveOrNull(quote.bidSize),
      ask,
      askSize: positiveOrNull(quote.askSize),
      prevClose: null,
      deltaPct: quote.varPct !== null && Number.isFinite(quote.varPct) ? quote.varPct : null,
      low: null,
      high: null,
      vwap: null,
      volumeArs: nonNegativeOrNull(quote.turnover),
      nominalVol: nonNegativeOrNull(quote.volume),
      mark: mid,
      impliedUsdArs: null,
      arsBid: null,
      arsAsk: null,
      usdBid: null,
      usdAsk: null,
      openInterest: null,
      quoteSource: 'BMB_HOMEBROKER_BRIDGE',
      quoteAsOfUtcSec: quote.asOfUtcSec,
    };
    out.push(input.trackFieldProvenance === true ? applyQuote(row, quote) : row);
  }
  return out;
}

function normalizeHistoricalBars(raw: unknown): readonly Bar[] {
  let arr: readonly unknown[] = [];
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (isPlainRecord(raw)) {
    for (const key of ['data', 'results', 'bars', 'history']) {
      const candidate = raw[key];
      if (Array.isArray(candidate)) {
        arr = candidate;
        break;
      }
    }
  }

  const out: Bar[] = [];
  const seenTime = new Set<number>();
  for (const item of arr) {
    if (!isPlainRecord(item)) {
      continue;
    }
    const time = parseTimestampSec(item['date'] ?? item['t'] ?? item['time'] ?? item['timestamp']);
    const close = readNum(item, ['c', 'close', 'last', 'closingPrice']);
    const open = readNum(item, ['o', 'open', 'openingPrice']) ?? close;
    const high = readNum(item, ['h', 'high', 'maxPrice']) ?? (open !== null && close !== null ? Math.max(open, close) : null);
    const low = readNum(item, ['l', 'low', 'minPrice']) ?? (open !== null && close !== null ? Math.min(open, close) : null);
    const volume = readNum(item, ['v', 'volume', 'nominalVolume']) ?? 0;

    if (
      time === null ||
      open === null ||
      high === null ||
      low === null ||
      close === null ||
      open <= 0 ||
      high <= 0 ||
      low <= 0 ||
      close <= 0 ||
      high < Math.max(open, close) ||
      low > Math.min(open, close) ||
      seenTime.has(time)
    ) {
      continue;
    }
    seenTime.add(time);
    out.push({
      time,
      open,
      high,
      low,
      close,
      volume: Math.max(0, volume),
    });
  }

  out.sort((a, b) => a.time - b.time);
  return out;
}

/**
 * Construye la tabla estructurada de cauciones desde BMB HomeBroker vivo o,
 * en su ausencia (fin de semana / sin contraseña / sin pyhomebroker), una curva de
 * referencia BCRA + Lecap sin inventar puntas Tomadora/Colocadora ni volumen.
 */
export function buildCaucionesLiquidityCurve(params: {
  readonly bmbSnapshot: BmbBridgeSnapshotDto;
  readonly tpmTna: number | null;
  readonly badlarTna: number | null;
  readonly tamarTna: number | null;
  readonly plazoFijoTna: number | null;
  readonly notes: readonly ArNoteOrCorpDto[];
  readonly nowSec: number;
}): {
  readonly rows: readonly ArCaucionCurveRowDto[];
  readonly status: 'LIVE_BMB' | 'REFERENCE_BCRA_LECAP' | 'NO_DATA';
} {
  const { bmbSnapshot, tpmTna, badlarTna, tamarTna, plazoFijoTna, notes, nowSec } = params;

  if ((bmbSnapshot.health.status === 'READY' || bmbSnapshot.health.status === 'CONNECTED_L2') && bmbSnapshot.health.connected && bmbSnapshot.cauciones.length > 0) {
    const rows: ArCaucionCurveRowDto[] = bmbSnapshot.cauciones.map((c) => {
      const tea =
        c.tnaWeighted !== null && Number.isFinite(c.tnaWeighted)
          ? sanitizeFinite(computeCaucionTeaEffectivePct(c.tnaWeighted, c.termDays))
          : sanitizeFinite(c.teaEffective);
      const spreadBps =
        c.tnaWeighted !== null && badlarTna !== null
          ? sanitizeFinite(computeSpreadVsBadlarBps(c.tnaWeighted, badlarTna))
          : sanitizeFinite(c.spreadVsBadlarBps);
      return {
        termDays: c.termDays,
        label: c.termDays === 1 ? '1 día hábil' : `${String(c.termDays)} días`,
        currency: c.currency,
        tnaWeighted: sanitizeFinite(c.tnaWeighted),
        teaEffective: tea,
        bidTna: sanitizeFinite(c.bidTna),
        askTna: sanitizeFinite(c.askTna),
        volumeArs: sanitizeFinite(c.turnoverArs),
        spreadVsBadlarBps: spreadBps,
        referenceInstrument: c.symbol,
        originLabel: 'Puntas vivas Bull Market HomeBroker',
        source: 'BMB_HOMEBROKER',
        asOfUtcSec: c.asOfUtcSec ?? nowSec,
      };
    });
    return { rows, status: 'LIVE_BMB' };
  }

  const lecapTickers = notes
    .filter((n) => n.kind === 'LECAP_BONCAP')
    .slice(0, 3)
    .map((n) => n.ticker)
    .join(' / ');

  const shortRate = tpmTna ?? tamarTna ?? badlarTna ?? plazoFijoTna;
  const shortLabel =
    tpmTna !== null
      ? 'BCRA Pol. Monetaria'
      : tamarTna !== null
        ? 'BCRA TAMAR'
        : badlarTna !== null
          ? 'BCRA BADLAR'
          : 'ArgentinaDatos PF';

  const midRate = badlarTna ?? tamarTna ?? plazoFijoTna ?? tpmTna;
  const midLabel =
    badlarTna !== null
      ? 'BCRA BADLAR'
      : tamarTna !== null
        ? 'BCRA TAMAR'
        : plazoFijoTna !== null
          ? 'ArgentinaDatos PF'
          : 'BCRA Pol. Monetaria';

  const longRate = tamarTna ?? badlarTna ?? plazoFijoTna ?? tpmTna;
  const longBaseLabel =
    tamarTna !== null
      ? 'BCRA TAMAR'
      : badlarTna !== null
        ? 'BCRA BADLAR'
        : plazoFijoTna !== null
          ? 'ArgentinaDatos PF'
          : 'BCRA Pol. Monetaria';
  const longLabel = lecapTickers !== '' ? `${longBaseLabel} / ${lecapTickers}` : longBaseLabel;

  const standardTenors = [1, 3, 7, 14, 30, 60, 90, 120] as const;
  const rows: ArCaucionCurveRowDto[] = [];

  for (const termDays of standardTenors) {
    const rate = termDays <= 14 ? shortRate : termDays === 30 ? midRate : longRate;
    const refInstrument = termDays <= 14 ? shortLabel : termDays === 30 ? midLabel : longLabel;
    if (rate === null || !Number.isFinite(rate)) {
      continue;
    }
    const tea = sanitizeFinite(computeCaucionTeaEffectivePct(rate, termDays));
    const spreadBps =
      badlarTna !== null ? sanitizeFinite(computeSpreadVsBadlarBps(rate, badlarTna)) : null;

    rows.push({
      termDays,
      label: termDays === 1 ? '1 día hábil' : `${String(termDays)} días`,
      currency: 'ARS',
      tnaWeighted: rate,
      teaEffective: tea,
      bidTna: null,
      askTna: null,
      volumeArs: null,
      spreadVsBadlarBps: spreadBps,
      referenceInstrument: refInstrument,
      originLabel: 'Referencia implícita BCRA / Lecap (sin libro BMB vivo)',
      source: 'BCRA_LECAP_REF',
      asOfUtcSec: nowSec,
    });
  }

  return {
    rows,
    status: rows.length > 0 ? 'REFERENCE_BCRA_LECAP' : 'NO_DATA',
  };
}

function mergeDlrContracts(
  base: readonly PrimaryDlrContractDto[],
  live: readonly PrimaryDlrContractDto[],
): readonly PrimaryDlrContractDto[] {
  if (live.length === 0) return base;
  const byContract = new Map(base.map((contract) => [contract.contract, contract]));
  for (const contract of live) {
    byContract.set(contract.contract, contract);
  }
  return [...byContract.values()].sort((a, b) => {
    const ta = a.expiryUtcSec ?? Number.MAX_SAFE_INTEGER;
    const tb = b.expiryUtcSec ?? Number.MAX_SAFE_INTEGER;
    if (ta !== tb) return ta - tb;
    return a.contract.localeCompare(b.contract);
  });
}

export class ArgentinaMarketRuntime {
  private readonly fetchFn: ArHttpFn;
  private readonly nowMsFn: () => number;
  private readonly timeoutMs: number;
  private readonly minData912IntervalMs: number;
  private readonly secrets: readonly string[];
  private readonly data912BaseUrl: string;
  private readonly openBymaBaseUrl: string;
  private readonly bcraBaseUrl: string;
  private readonly argDatosBaseUrl: string;
  private readonly nyfedBaseUrl: string;
  private readonly primaryClient: PrimaryRofexClient;
  private readonly bmbClient: BmbBridgeClient | BmbFeedAdapter;
  private readonly iolClient: IolFeedAdapter;
  private readonly realtimeBus: ArRealtimeBus;
  private readonly usRuntime: UsRuntimeAdapter | null;
  private readonly usDailyBarsFn:
    | ((symbol: string, lookbackBars?: number, forceRefresh?: boolean) => Promise<CachedDailyBarsResult>)
    | null;
  private readonly allowSharedUsRuntime: boolean;
  private lazyUsRuntime: MarketRuntime | null = null;
  private lastOverview: ArOverviewResponse | null = null;
  private lastMonitoring: ArMonitoringResponse | null = null;
  private lastMacro: ArMacroResponse | null = null;
  private lastBmbSnapshot: BmbBridgeSnapshotDto | null = null;
  private readonly lastOptionsBySymbol = new Map<string, ArOptionsResponse>();
  private liveRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private liveStreaming = false;
  private liveRefreshInFlight = false;

  private readonly liveCache: SingleFlightRuntimeCache<unknown>;
  private readonly histCache: SingleFlightRuntimeCache<readonly Bar[]>;
  private readonly macroCache: SingleFlightRuntimeCache<unknown>;
  private readonly computedCache: SingleFlightRuntimeCache<unknown>;
  private readonly quoteTtlResolver: (nowMs: number) => number;
  private anexoBOptions: {
    readonly byContract: ReadonlyMap<string, Extract<OiFieldProvenance, { status: 'IAMC_ANEXO_B' }>>;
    readonly cache: SingleFlightRuntimeCache<ArOptionsResponse>;
  } | null = null;
  private anexoBContractMetadata: ReadonlyMap<string, readonly BymaContractMetadataRecord[]> = new Map();
  private primaryContractMetadata: ReadonlyMap<string, readonly BymaContractMetadataRecord[]> = new Map();
  private readonly priorSmileCache = new Map<
    string,
    readonly {
      readonly dateKey: string;
      readonly atmIvPct: number;
      readonly compositeOtmPoints: readonly CompositeOtmSmilePoint[];
    }[]
  >();
  private readonly arOverlayCache = new Map<string, ArStockDetailIndicatorOverlays>();
  private readonly stockDetailCache = new Map<
    string,
    { readonly atMs: number; readonly response: ArStockDetailResponse }
  >();
  /** Pieza 50.5: anclas Auto-AVWAP ARS por día (`AR:${symbol}:${artDateKey}`), acotado a 300. */
  private readonly arAutoAvwapAnchorsCache = new Map<string, readonly AutoAvwapAnchor[]>();

  private data912Queue: Promise<void> = Promise.resolve();
  private lastData912ReqMs = 0;
  private readonly effectiveEnv: NodeJS.ProcessEnv;
  private arHolidays: readonly string[];

  public constructor(deps: ArgentinaRuntimeDeps = {}) {
    this.fetchFn = deps.fetchFn ?? defaultArHttpFn;
    this.nowMsFn = deps.nowMsFn ?? (() => Date.now());
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.minData912IntervalMs = deps.minData912IntervalMs ?? DEFAULT_MIN_DATA912_INTERVAL_MS;
    this.arHolidays = [...(deps.arHolidays ?? [])];

    // Aislamiento de tests offline: si el caller inyecta fetchFn sin env explícito,
    // evitamos leer process.env para no disparar peticiones reales no mockeadas.
    const effectiveEnv: NodeJS.ProcessEnv =
      deps.env !== undefined ? deps.env : deps.fetchFn !== undefined ? {} : process.env;
    this.effectiveEnv = effectiveEnv;

    const secretSet = new Set<string>(deps.secrets ?? []);
    for (const s of collectBrokerSecretsFromEnv(effectiveEnv)) {
      secretSet.add(s);
    }
    this.secrets = [...secretSet];

    this.data912BaseUrl = (deps.data912BaseUrl ?? DEFAULT_DATA912_BASE).replace(/\/+$/, '');
    this.openBymaBaseUrl = (deps.openBymaBaseUrl ?? DEFAULT_OPEN_BYMA_BASE).replace(/\/+$/, '');
    this.bcraBaseUrl = (deps.bcraBaseUrl ?? DEFAULT_BCRA_BASE).replace(/\/+$/, '');
    this.argDatosBaseUrl = (deps.argentinaDatosBaseUrl ?? DEFAULT_ARGDATOS_BASE).replace(/\/+$/, '');
    this.nyfedBaseUrl = (deps.nyfedBaseUrl ?? DEFAULT_NYFED_BASE).replace(/\/+$/, '');

    this.primaryClient =
      deps.primaryClient ??
      new PrimaryRofexClient({
        env: effectiveEnv,
        fetchFn: this.fetchFn,
        nowMsFn: this.nowMsFn,
        secrets: this.secrets,
        timeoutMs: this.timeoutMs,
      });
    this.bmbClient =
      deps.bmbClient ??
      new BmbFeedAdapter({
        env: effectiveEnv,
        fetchFn: this.fetchFn,
        nowMsFn: this.nowMsFn,
        secrets: this.secrets,
      });
    this.iolClient = deps.iolClient ?? new IolFeedAdapter({
      env: effectiveEnv,
      fetchFn: this.fetchFn,
      nowMsFn: this.nowMsFn,
      secrets: this.secrets,
    });
    this.realtimeBus = deps.realtimeBus ?? new ArRealtimeBus({
      bmbClient: this.bmbClient instanceof BmbFeedAdapter ? this.bmbClient : null,
      iolClient: this.iolClient,
      primaryClient: this.primaryClient,
      nowMsFn: this.nowMsFn,
    });
    this.usRuntime = deps.usRuntime ?? null;
    this.usDailyBarsFn = deps.usDailyBarsFn ?? null;
    this.allowSharedUsRuntime = deps.fetchFn === undefined || deps.env !== undefined;

    // Pieza 39: ticks ARS del GGAL Specialist desde los trades clasificados del
    // bridge BMB (SignalR SendPrices) hacia el motor tick del runtime US.
    if (this.bmbClient instanceof BmbFeedAdapter) {
      this.usRuntime?.attachGgalArsTickSource?.(this.bmbClient);
    }

    // Eco Valores XOMS: ticks ARS de GGAL (LA/BI/OF) desde el stream L2 de Primary.
    // Prioridad explícita: cuando el bridge BMB está conectado (L2 vivo) sus trades
    // alimentan el motor; el tick de Primary solo se aplica con BMB L2 deshabilitado
    // o desconectado, evitando doble conteo de volumen en la vela ARS.
    const bmbTickAdapter = this.bmbClient instanceof BmbFeedAdapter ? this.bmbClient : null;
    this.usRuntime?.attachGgalArsTickSource?.({
      setGgalArsTickListener: (tickListener) => {
        this.primaryClient.setGgalArsTickListener((tick) => {
          if (bmbTickAdapter !== null && bmbTickAdapter.getSafeHealthStatus().connected) {
            return;
          }
          if (tickListener === null) {
            return;
          }
          tickListener(tick);
        });
      },
    });

    const ttlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    const quoteTtlResolver = (nowMs: number): number => {
      if (deps.cacheTtlMs !== undefined) return ttlMs;
      return isBymaL2SessionUtcSec(Math.floor(nowMs / 1_000))
        ? Math.min(ttlMs, AR_LIVE_QUOTE_CACHE_TTL_MS)
        : ttlMs;
    };
    this.quoteTtlResolver = quoteTtlResolver;
    this.liveCache = new SingleFlightRuntimeCache({ ttlResolver: quoteTtlResolver, nowFn: this.nowMsFn });
    this.histCache = new SingleFlightRuntimeCache({
      ttlResolver: (nowMs) => computeArHistoricalPanelTtlMs(nowMs),
      nowFn: this.nowMsFn,
    });
    this.macroCache = new SingleFlightRuntimeCache({ ttlResolver: () => DEFAULT_MACRO_CACHE_TTL_MS, nowFn: this.nowMsFn });
    this.computedCache = new SingleFlightRuntimeCache({ ttlResolver: quoteTtlResolver, nowFn: this.nowMsFn });
    this.attachPrimaryMarketDataListener();
  }

  public getSecrets(): readonly string[] {
    const out = new Set<string>(this.secrets);
    for (const s of this.primaryClient.getSecrets()) {
      out.add(s);
    }
    for (const s of this.iolClient.getSecrets()) {
      out.add(s);
    }
    return [...out];
  }

  /** Pieza 41: cache/ingestión de quotes y cauciones Eco Primary. */
  public attachPrimaryMarketDataListener(): void {
    this.primaryClient.setMervMarketDataListener((frame) => {
      if (frame.ticker === null || frame.settlement === null) return;
      const caucionMatch = /^PESOS\s*-\s*(\d+)D$/i.exec(frame.ticker);
      if (caucionMatch !== null) {
        const termDays = Number(caucionMatch[1]);
        const snap = frame.snapshot;
        const rate = snap.last;
        if (termDays <= 0 || rate === null || !Number.isFinite(rate) || rate <= 0) return;
        this.realtimeBus.ingestCauciones([
          {
            symbol: frame.ticker,
            termDays,
            currency: 'ARS',
            tnaWeighted: rate,
            bidTna: snap.bids[0]?.price ?? null,
            askTna: snap.asks[0]?.price ?? null,
            turnoverArs: snap.turnover ?? null,
            asOfUtcSec: snap.lastTradeAtUtcSec ?? null,
            source: 'PRIMARY_ECO_WS',
          },
        ]);
        return;
      }
      const quote = primaryFrameToMarketTickQuote(frame);
      if (quote !== null) {
        this.realtimeBus.ingestQuotes([quote]);
      }
    });
  }

  public getConnectorHealth(): {
    readonly primaryRofex: PrimaryConnectorHealthDto;
    readonly bullMarket: BmbConnectorHealthDto;
    readonly iol: ReturnType<IolFeedAdapter['getHealth']>;
  } {
    return {
      primaryRofex: this.primaryClient.getSafeHealthStatus(),
      bullMarket: this.bmbClient.getSafeHealthStatus(),
      iol: this.iolClient.getHealth(),
    };
  }

  /** Pieza 33: telemetría real del stream Primary DLR + L2 BYMA (Eco Valores XOMS). */
  public getPrimaryFeedHealth() {
    const health = this.primaryClient.getSafeHealthStatus();
    const nowMs = this.nowMsFn();
    return {
      configured: health.configured,
      authenticated: health.authenticated,
      wsConnected: health.wsConnected,
      tokenValidUntilUtcSec: health.tokenValidUntilUtcSec,
      tokenRenewCount: health.tokenRenewCount,
      wsEnvironment: health.wsEnvironment,
      apiUrl: health.apiUrl,
      dlrSubscribedCount: health.dlrSubscribedCount,
      dlrSubscribedSymbols: this.primaryClient.getDlrSubscribedSymbols(),
      mervSubscribedCount: health.mervSubscribedCount,
      bymaL2SubscribedSymbols: this.primaryClient.getBymaL2SubscribedSymbols(),
      liveDlrCount: health.liveDlrCount,
      liveDlrLastUpdateUtcSec: health.liveDlrLastUpdateUtcSec,
      liveMervBookCount: health.liveMervBookCount,
      lastError: health.lastError,
      telemetry: this.primaryClient.getFeedTelemetrySnapshot(nowMs),
    };
  }

  /** Pieza 33: telemetría del bridge BMB y estado real de libros. */
  public getBmbFeedHealth() {
    const adapter = this.bmbClient instanceof BmbFeedAdapter ? this.bmbClient : null;
    if (adapter !== null) {
      return adapter.getFeedHealth();
    }
    const health = this.bmbClient.getSafeHealthStatus();
    return {
      configured: health.passwordConfigured,
      healthStatus: health.status,
      connected: health.connected,
      lastUpdateUtcSec: health.lastUpdateUtcSec,
      orderBookCount: health.counts.orderBooks,
      caucionCount: health.counts.cauciones,
      optionCount: health.counts.options,
      lastError: health.error,
      signalRMode: isBmbInversionesSignalRConfigured(this.effectiveEnv),
      telemetry: emptyFeedTelemetrySnapshot(),
    };
  }

  /** Pieza 33: telemetría OAuth/HTTP de IOL REST v2. */
  public getIolFeedHealth() {
    return this.iolClient.getFeedHealth();
  }

  /** Pieza 44: accesores síncronos en memoria/caché para fast-path de GGAL Specialist. */
  public getCachedPrimaryMervBook(
    rawTicker: string,
    preferredSettlement?: '24HS' | 'CI',
  ): OrderBook5LevelsDto | null {
    return this.primaryClient.getCachedMervOrderBook5LevelsSync(rawTicker, preferredSettlement);
  }

  public getCachedOptionsChain(rawUnderlying = 'GGAL'): ArOptionsResponse | null {
    return this.lastOptionsBySymbol.get(rawUnderlying.trim().toUpperCase()) ?? null;
  }

  public getCachedBmbSnapshot(): BmbBridgeSnapshotDto | null {
    return this.lastBmbSnapshot;
  }

  /** Pieza 33: reconexión individual de Primary DLR con token nuevo. */
  public async reconnectPrimaryDlr(): Promise<string> {
    await this.primaryClient.reconnectDlrLiveStream();
    return 'PRIMARY_REMARKETS_DLR_RECONNECT_ACCEPTED';
  }

  /** Pieza 33: reconexión individual del bridge BMB. */
  public async reconnectBmb(): Promise<string> {
    const adapter = this.bmbClient instanceof BmbFeedAdapter ? this.bmbClient : null;
    if (adapter !== null) {
      return adapter.reconnect();
    }
    if (this.bmbClient instanceof BmbBridgeClient) {
      await this.bmbClient.requestReconnect();
      return 'BMB_HOMEBROKER_L2_RECONNECT_REQUESTED';
    }
    throw new Error('BMB reconnect is unavailable for injected bridge stubs without reconnect support');
  }

  /** Pieza 33: reconexión individual de IOL con OAuth limpio en memoria. */
  public async reconnectIol(): Promise<string> {
    return this.iolClient.reconnect();
  }

  public close(): void {
    this.liveStreaming = false;
    if (this.liveRefreshTimer !== null) clearTimeout(this.liveRefreshTimer);
    this.liveRefreshTimer = null;
    this.primaryClient.closeWebSocket();
    this.realtimeBus.stop();
  }

  public async getBmbSnapshot(symbol?: string, forceRefresh = false): Promise<BmbBridgeSnapshotDto> {
    const snapshot = await this.bmbClient.getSnapshot(symbol, null, forceRefresh);
    this.lastBmbSnapshot = snapshot;
    return snapshot;
  }

  private isLiveStreamingActive(): boolean {
    return this.liveStreaming;
  }

  private currentLiveDlrFutures(): readonly PrimaryDlrContractDto[] {
    const busFutures = this.realtimeBus.getFutures();
    return busFutures.length > 0 ? busFutures : this.primaryClient.getLiveDlrFutures();
  }

  /** Starts AR refresh only from the explicit HTTP server lifecycle, never in offline constructors. */
  public startLiveStreaming(): void {
    if (this.liveStreaming) return;
    this.liveStreaming = true;
    const symbols = [
      ...AR_STOCK_META.map((meta) => meta.ticker),
      ...Object.keys(CEDEAR_RATIOS),
      ...SOVEREIGN_BONDS.flatMap((bond) => [bond.baseTicker, `${bond.baseTicker}D`, `${bond.baseTicker}C`]),
    ];
    this.realtimeBus.start(symbols);
    // Stream productivo Eco Valores XOMS: L2 BYMA 5 puntas (MERV) + curva DLR/* (incluyendo CL y SE).
    void this.primaryClient
      .startBymaL2LiveStream({
        fixedIncomeTickers: SOVEREIGN_BONDS
          .filter((bond) => bond.currency === 'CER')
          .map((bond) => bond.baseTicker),
      })
      .catch(() => undefined)
      .finally(() => {
        void this.primaryClient.startDlrLiveStream().catch(() => undefined);
      });
    const run = async (): Promise<void> => {
      if (!this.liveStreaming || this.liveRefreshInFlight) return;
      const inSession = isBymaL2SessionUtcSec(Math.floor(this.nowMsFn() / 1_000));
      if (!inSession) {
        this.liveRefreshTimer = setTimeout(() => {
          void run();
        }, 5_000);
        this.liveRefreshTimer.unref();
        return;
      }
      this.liveRefreshInFlight = true;
      try {
        const core = await this.getOverviewCore(true);
        const previous = this.lastOverview;
        this.lastOverview = {
          ...core,
          ...(previous === null
            ? {}
            : {
                atmIvPct: previous.atmIvPct ?? null,
                atmIvExpiryCode: previous.atmIvExpiryCode ?? null,
                atmIvExpiryLabel: previous.atmIvExpiryLabel ?? null,
                atmIvDaysToExpiry: previous.atmIvDaysToExpiry ?? null,
                atmIvRateTnaPct: previous.atmIvRateTnaPct ?? null,
              }),
        };
        const panel = this.lastMonitoring?.panel;
        if (panel !== undefined) {
          // getOverviewCore(true) above already refreshed the shared inputs.
          await this.getMonitoring(panel, false);
        }
      } catch {
        // Existing endpoint/provider errors remain explicit in the next REST response.
      } finally {
        this.liveRefreshInFlight = false;
        if (this.isLiveStreamingActive()) {
          this.liveRefreshTimer = setTimeout(() => {
            void run();
          }, AR_LIVE_REFRESH_INTERVAL_MS);
          this.liveRefreshTimer.unref();
        }
      }
    };
    void run();
  }

  private overlayStockWithCurrentBmb(
    stock: ArStockDto,
    snapshot: BmbBridgeSnapshotDto | null,
    nowUtcSec: number,
  ): ArStockDto {
    if (!bmbSnapshotHasLiveActivity(snapshot)) return stock;
    const baseRow: NormalizedQuoteRow = {
      symbol: stock.ticker,
      last: stock.last,
      bid: stock.bid,
      bidSize: null,
      ask: stock.ask,
      askSize: null,
      prevClose: stock.prevClose,
      deltaPct: stock.deltaPct,
      low: stock.low,
      high: stock.high,
      vwap: stock.vwap,
      volumeArs: stock.volumeM !== null ? stock.volumeM * 1_000_000 : null,
      nominalVol: null,
      mark: stock.last,
      impliedUsdArs: null,
      arsBid: null,
      arsAsk: null,
      usdBid: null,
      usdAsk: null,
      ...(stock.source === 'BMB_HOMEBROKER'
        ? { quoteSource: 'BMB_HOMEBROKER_BRIDGE' as const }
        : { quoteSource: 'DATA912' as const }),
      quoteAsOfUtcSec: stock.quoteAsOfUtcSec ?? null,
    };
    const merged = mergeBmbNormalizedRows([baseRow], snapshot, nowUtcSec, new Set([stock.ticker])).rows.find(
      (row) => row.symbol === stock.ticker,
    );
    if (merged === undefined) return stock;
    const last = merged.last;
    const cclImplicit =
      last !== null && last > 0 && stock.adrPrice !== null && stock.adrPrice !== undefined && stock.adrPrice > 0 && stock.adrRatio !== undefined
        ? (last * stock.adrRatio) / stock.adrPrice
        : null;
    return {
      ...stock,
      last: sanitizeFinite(last),
      bid: sanitizeFinite(merged.bid),
      ask: sanitizeFinite(merged.ask),
      deltaPct: sanitizeFinite(merged.deltaPct),
      prevClose: sanitizeFinite(merged.prevClose),
      low: sanitizeFinite(merged.low),
      high: sanitizeFinite(merged.high),
      dayRangePos:
        last !== null && merged.low !== null && merged.high !== null && merged.high > merged.low
          ? sanitizeFinite((last - merged.low) / (merged.high - merged.low))
          : null,
      cclImplicit: sanitizeFinite(cclImplicit),
      source: merged.quoteSource === 'BMB_HOMEBROKER_BRIDGE' ? 'BMB_HOMEBROKER' : stock.source,
      quoteAsOfUtcSec: merged.quoteAsOfUtcSec ?? stock.quoteAsOfUtcSec ?? null,
    };
  }

  private applyCurrentBmbToOverview(
    base: ArOverviewResponse,
    snapshot: BmbBridgeSnapshotDto | null,
  ): ArOverviewResponse {
    const nowUtcSec = Math.floor(this.nowMsFn() / 1_000);
    const activityUniverse = new Set([
      ...AR_STOCK_META.map((meta) => meta.ticker),
      ...Object.keys(CEDEAR_RATIOS),
      ...SOVEREIGN_BONDS.flatMap((bond) => [bond.baseTicker, `${bond.baseTicker}D`, `${bond.baseTicker}C`]),
    ]);
    const activity = mergeBmbNormalizedRows([], snapshot, nowUtcSec, activityUniverse);
    if (!activity.hasLiveActivity) return { ...base, sourceMode: 'DATA912' };
    const mapStock = (stock: ArStockDto): ArStockDto => this.overlayStockWithCurrentBmb(stock, snapshot, nowUtcSec);
    let mervalStocks = base.mervalStocks.map(mapStock);
    let generalPanelStocks = base.generalPanelStocks.map(mapStock);
    let cedears = base.cedears.map(mapStock);
    const liveCclValues = [...mervalStocks, ...generalPanelStocks, ...cedears]
      .filter(
        (stock) =>
          stock.source === 'BMB_HOMEBROKER' &&
          stock.quoteAsOfUtcSec !== null &&
          stock.quoteAsOfUtcSec !== undefined &&
          nowUtcSec >= stock.quoteAsOfUtcSec &&
          nowUtcSec - stock.quoteAsOfUtcSec <= 20,
      )
      .map((stock) => stock.cclImplicit)
      .filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value) && value > 0);
    const liveCclMedian = computeMedian(liveCclValues);
    const hasLiveCcl = liveCclMedian !== null;
    const cclMedian = liveCclMedian ?? base.cclMedian;
    const withParity = (stock: ArStockDto): ArStockDto => {
      const fairArsPrice =
        stock.adrPrice !== null && stock.adrPrice !== undefined && stock.adrPrice > 0 &&
        stock.adrRatio !== undefined && stock.adrRatio > 0 && cclMedian !== null && cclMedian > 0
          ? (stock.adrPrice * cclMedian) / stock.adrRatio
          : null;
      const cclMismatchPct =
        stock.cclImplicit !== null && stock.cclImplicit !== undefined && cclMedian !== null && cclMedian > 0
          ? ((stock.cclImplicit - cclMedian) / cclMedian) * 100
          : null;
      return {
        ...stock,
        fairArsPrice: sanitizeFinite(fairArsPrice),
        cclMismatchPct: sanitizeFinite(cclMismatchPct),
        cclMismatchArs:
          stock.last !== null && fairArsPrice !== null ? sanitizeFinite(stock.last - fairArsPrice) : null,
      };
    };
    mervalStocks = mervalStocks.map(withParity);
    generalPanelStocks = generalPanelStocks.map(withParity);
    cedears = cedears.map(withParity);
    const mepCclGapPct =
      base.mepMedian !== null && base.mepMedian > 0 && cclMedian !== null
        ? ((cclMedian - base.mepMedian) / base.mepMedian) * 100
        : null;
    return {
      ...base,
      feedStatus: 'LIVE',
      sourceMode: 'LIVE_BMB',
      mervalStocks,
      generalPanelStocks,
      cedears,
      cclMedian: sanitizeFinite(cclMedian),
      mepCclGapPct: sanitizeFinite(mepCclGapPct),
      globalIndicators: base.globalIndicators.map((indicator) =>
        indicator.id === 'ccl' && hasLiveCcl
          ? { ...indicator, value: sanitizeFinite(cclMedian), source: 'BMB_HOMEBROKER' }
          : indicator,
      ),
    };
  }

  public getLiveArMarketSnapshot(): ArLiveMarketSnapshot {
    const realtimeQuotes = this.realtimeBus.getQuotes();
    const realtimeSourceMode = this.realtimeBus.getSourceMode();
    const cachedBmb = this.bmbClient instanceof BmbFeedAdapter ? this.bmbClient.getCachedSnapshot() : null;
    const bmbSnapshot = cachedBmb ?? this.lastBmbSnapshot;
    const overviewBase = this.lastOverview;
    const overview = overviewBase === null ? null : this.applyCurrentBmbToOverview(overviewBase, bmbSnapshot);
    const monitoring = this.lastMonitoring;
    const bonds = monitoring?.bonds ?? this.lastMacro?.sovereignCurve ?? [];
    const quotes: MarketTickQuote[] = [];
    const appendStock = (stock: ArStockDto): void => {
      if (stock.last === null || !Number.isFinite(stock.last) || stock.last <= 0) return;
      quotes.push({
        market: 'AR',
        symbol: stock.ticker,
        kind: 'stock',
        currency: 'ARS',
        price: stock.last,
        previousClose: stock.prevClose,
        changePct: stock.deltaPct,
        dayLow: stock.low,
        dayHigh: stock.high,
        volume: null,
        turnover: stock.volumeM !== null ? stock.volumeM * 1_000_000 : null,
        asOfUtcSec: stock.quoteAsOfUtcSec ?? null,
        source: stock.source,
      });
    };
    if (overview !== null) {
      overview.mervalStocks.forEach(appendStock);
      overview.generalPanelStocks.forEach(appendStock);
      overview.cedears.forEach(appendStock);
    }
    for (const bond of bonds) {
      const price = bond.currency === 'USD' ? bond.priceUsd : bond.priceArs;
      if (price === null || !Number.isFinite(price) || price <= 0) continue;
      quotes.push({
        market: 'AR',
        symbol: bond.ticker,
        kind: 'bond',
        currency: bond.currency === 'USD' ? 'USD' : 'ARS',
        price,
        previousClose: null,
        changePct: bond.deltaPct,
        dayLow: null,
        dayHigh: null,
        volume: null,
        turnover: bond.volumeM !== null ? bond.volumeM * 1_000_000 : null,
        asOfUtcSec: bond.quoteAsOfUtcSec ?? null,
        source: bond.source,
      });
    }
    for (const note of [...(monitoring?.notes ?? []), ...(monitoring?.corps ?? [])]) {
      if (note.price === null || !Number.isFinite(note.price) || note.price <= 0) continue;
      quotes.push({
        market: 'AR',
        symbol: note.ticker,
        kind: note.kind === 'ON_CORP' ? 'corp' : 'note',
        currency: 'ARS',
        price: note.price,
        previousClose: null,
        changePct: note.deltaPct,
        dayLow: null,
        dayHigh: null,
        volume: null,
        turnover: note.volumeM !== null ? note.volumeM * 1_000_000 : null,
        asOfUtcSec: note.quoteAsOfUtcSec ?? null,
        source: note.source,
      });
    }
    const caucionesCurve = buildCaucionesLiquidityCurve({
      bmbSnapshot:
        bmbSnapshot ??
        ({
          health: this.bmbClient.getSafeHealthStatus(),
          cauciones: [],
          orderBooksBySymbol: {},
          options: [],
        } satisfies BmbBridgeSnapshotDto),
      tpmTna: this.lastMacro?.variables.tpmTna ?? null,
      badlarTna: monitoring?.badlarTna ?? this.lastMacro?.variables.badlarTna ?? null,
      tamarTna: this.lastMacro?.variables.tamarTna ?? null,
      plazoFijoTna: this.lastMacro?.variables.plazoFijoTna ?? null,
      notes: monitoring?.notes ?? [],
      nowSec: Math.floor(this.nowMsFn() / 1_000),
    });
    const busCauciones = this.realtimeBus.getCauciones();
    const primaryCauciones: readonly ArCaucionCurveRowDto[] = busCauciones
      .filter((row) => row.source === 'PRIMARY_ECO_WS')
      .map((row) => ({
        termDays: row.termDays,
        label: `${String(row.termDays)} días`,
        currency: row.currency,
        tnaWeighted: row.tnaWeighted,
        teaEffective: row.tnaWeighted !== null ? sanitizeFinite(computeCaucionTeaEffectivePct(row.tnaWeighted, row.termDays)) : null,
        bidTna: row.bidTna,
        askTna: row.askTna,
        volumeArs: row.turnoverArs,
        spreadVsBadlarBps: null,
        referenceInstrument: row.symbol,
        originLabel: 'Puntas/trades vivos Eco Primary XOMS',
        source: 'PRIMARY_ECO_WS',
        asOfUtcSec: row.asOfUtcSec,
      }));
    const iolCauciones: readonly ArCaucionCurveRowDto[] = busCauciones
      .filter((row) => row.source === 'IOL_REST')
      .map((row) => ({
      termDays: row.termDays,
      label: `${String(row.termDays)} días`,
      currency: row.currency,
      tnaWeighted: row.tnaWeighted,
      teaEffective: row.tnaWeighted !== null ? sanitizeFinite(computeCaucionTeaEffectivePct(row.tnaWeighted, row.termDays)) : null,
      bidTna: row.bidTna,
      askTna: row.askTna,
      volumeArs: row.turnoverArs,
      spreadVsBadlarBps: null,
      referenceInstrument: row.symbol,
      originLabel: 'IOL REST v2 L1',
      source: 'IOL_REST',
      asOfUtcSec: row.asOfUtcSec,
    }));
    const bmbTenors = new Set(caucionesCurve.status === 'LIVE_BMB' ? caucionesCurve.rows.map((row) => `${row.currency}:${String(row.termDays)}`) : []);
    const cauciones: readonly ArCaucionCurveRowDto[] =
      primaryCauciones.length > 0
        ? [...primaryCauciones, ...[
            ...caucionesCurve.rows,
            ...iolCauciones,
          ].filter((row) => !primaryCauciones.some((primary) => primary.currency === row.currency && primary.termDays === row.termDays))]
        : caucionesCurve.status === 'LIVE_BMB'
          ? [...caucionesCurve.rows, ...iolCauciones.filter((row) => !bmbTenors.has(`${row.currency}:${String(row.termDays)}`))]
          : iolCauciones.length > 0
            ? iolCauciones
            : caucionesCurve.rows;
    const mergedQuotes = new Map<string, MarketTickQuote>();
    const quoteKey = (quote: MarketTickQuote): string => realtimeQuoteKey(quote.symbol, quote.settlement);
    for (const quote of quotes) {
      mergedQuotes.set(quoteKey(quote), quote);
    }
    for (const quote of realtimeQuotes) {
      const base = mergedQuotes.get(quoteKey(quote));
      mergedQuotes.set(quoteKey(quote), {
        ...quote,
        previousClose: quote.previousClose ?? base?.previousClose ?? null,
        changePct: quote.changePct ?? base?.changePct ?? null,
        dayLow: quote.dayLow ?? base?.dayLow ?? null,
        dayHigh: quote.dayHigh ?? base?.dayHigh ?? null,
        volume: quote.volume ?? base?.volume ?? null,
        turnover: quote.turnover ?? base?.turnover ?? null,
        asOfUtcSec: quote.asOfUtcSec ?? base?.asOfUtcSec ?? null,
      });
    }
    const fallbackSourceMode = overview?.sourceMode === 'LIVE_BMB' || overview?.sourceMode === 'LIVE_IOL' || caucionesCurve.status === 'LIVE_BMB'
      ? overview?.sourceMode === 'LIVE_IOL' ? 'LIVE_IOL' : 'LIVE_BMB'
      : overview !== null
        ? 'DATA912'
        : 'NO_DATA';
    const sourceMode = realtimeSourceMode !== 'NO_DATA'
      ? realtimeSourceMode
      : busCauciones.length > 0
        ? 'LIVE_IOL'
        : fallbackSourceMode;
    const liveFutures = this.currentLiveDlrFutures();
    const futures = mergeDlrContracts(this.lastMacro?.rofxFutures ?? [], liveFutures);
    const futuresSource: 'PRIMARY_WS' | 'PRIMARY_REST' | 'NONE' =
      liveFutures.length > 0 ? 'PRIMARY_WS' : futures.length > 0 ? 'PRIMARY_REST' : 'NONE';
    return {
      overview,
      monitoring,
      quotes: [...mergedQuotes.values()],
      cauciones,
      futures,
      futuresSource,
      sourceMode,
      bmbHealth: bmbSnapshot?.health ?? this.bmbClient.getSafeHealthStatus(),
    };
  }

  private async scheduleData912<T>(task: () => Promise<T>): Promise<T> {
    // Espaciamos únicamente el inicio de cada dispatch HTTP hacia Data912 para respetar
    // su rate limit sin serializar las respuestas de red entre pares históricos o paneles.
    const acquireDispatchSlot = async (): Promise<void> => {
      if (this.minData912IntervalMs > 0) {
        const now = this.nowMsFn();
        const waitMs = this.lastData912ReqMs + this.minData912IntervalMs - now;
        if (waitMs > 0) {
          await new Promise<void>((r) => setTimeout(r, waitMs));
        }
      }
      this.lastData912ReqMs = this.nowMsFn();
    };
    const ticket = this.data912Queue.then(acquireDispatchSlot, acquireDispatchSlot);
    this.data912Queue = ticket.then(
      () => undefined,
      () => undefined,
    );
    await ticket;
    return task();
  }

  private async fetchJsonSafe(
    url: string,
    init?: ArHttpRequestInit,
    useData912Limiter = false,
  ): Promise<{ readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly error: string }> {
    const exec = async () => {
      const res = await this.fetchFn(url, {
        ...(init ?? {}),
        timeoutMs: init?.timeoutMs ?? this.timeoutMs,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${String(res.status)} on ${url}`);
      }
      if (res.text.trim() === '') {
        throw new Error(`Empty response on ${url}`);
      }
      return JSON.parse(res.text) as unknown;
    };

    try {
      const data = useData912Limiter ? await this.scheduleData912(exec) : await exec();
      return { ok: true, data };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Upstream fetch error';
      return { ok: false, error: redactSecrets(msg, this.secrets) };
    }
  }

  private async getData912Live(
    endpoint: string,
    forceRefresh = false,
  ): Promise<{ readonly rows: readonly NormalizedQuoteRow[]; readonly error: string | null }> {
    const url = `${this.data912BaseUrl}${endpoint}`;
    try {
      const cached = await this.liveCache.getOrCompute(
        `d912:${endpoint}`,
        async () => {
          const res = await this.fetchJsonSafe(url, { headers: { Accept: 'application/json' } }, true);
          if (!res.ok) {
            throw new Error(res.error);
          }
          return normalizeData912Rows(res.data, 'DATA912', endpoint === '/live/arg_options');
        },
        { forceRefresh },
      );
      return { rows: cached.value as readonly NormalizedQuoteRow[], error: null };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : `Data912 ${endpoint} failed`;
      return { rows: [], error: redactSecrets(msg, this.secrets) };
    }
  }

  /** Resuelve alias de tickers CEDEAR (`VISTA -> VIST`) probando cada candidato en `/historical/cedears/{ticker}`. */
  private async getCedearHistoryWithAlias(
    ticker: string,
    forceRefresh = false,
  ): Promise<{ readonly bars: readonly Bar[]; readonly error: string | null }> {
    const upper = ticker.trim().toUpperCase();
    const canonical = CEDEAR_TICKER_ALIASES[upper];
    const candidates = [...new Set([...(canonical !== undefined ? [canonical] : []), upper])];
    let last: { readonly bars: readonly Bar[]; readonly error: string | null } = {
      bars: [],
      error: null,
    };
    for (const cand of candidates) {
      const res = await this.getData912History('cedears', cand, forceRefresh);
      if (res.bars.length > 0) {
        return res;
      }
      last = res;
    }
    return last;
  }

  private async getData912History(
    kind: 'stocks' | 'cedears' | 'bonds',
    ticker: string,
    forceRefresh = false,
  ): Promise<{ readonly bars: readonly Bar[]; readonly error: string | null }> {
    const cleanTicker = encodeURIComponent(ticker.trim().toUpperCase());
    const url = `${this.data912BaseUrl}/historical/${kind}/${cleanTicker}`;
    try {
      const cached = await this.histCache.getOrCompute(
        `d912hist:${kind}:${cleanTicker}`,
        async () => {
          const res = await this.fetchJsonSafe(url, { headers: { Accept: 'application/json' } }, true);
          if (!res.ok) {
            throw new Error(res.error);
          }
          return normalizeHistoricalBars(res.data);
        },
        { forceRefresh },
      );
      return { bars: cached.value, error: null };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : `History ${kind}/${cleanTicker} failed`;
      return { bars: [], error: redactSecrets(msg, this.secrets) };
    }
  }

  private async getOpenBymaPanel(
    endpoint: string,
    forceRefresh = false,
  ): Promise<{ readonly rows: readonly NormalizedQuoteRow[]; readonly error: string | null }> {
    const url = `${this.openBymaBaseUrl}/${endpoint}`;
    try {
      const cached = await this.liveCache.getOrCompute(
        `byma:${endpoint}`,
        async () => {
          const body = JSON.stringify({
            excludeZeroPxAndQty: true,
            T2: false,
            T1: true,
            T0: false,
          });
          const res = await this.fetchJsonSafe(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body,
          });
          if (!res.ok) {
            throw new Error(res.error);
          }
          return normalizeData912Rows(res.data, 'OPEN_BYMA');
        },
        { forceRefresh },
      );
      return { rows: cached.value as readonly NormalizedQuoteRow[], error: null };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : `OpenBYMA ${endpoint} unavailable`;
      return { rows: [], error: redactSecrets(msg, this.secrets) };
    }
  }

  private async fetchBcraAndArgDatos(forceRefresh = false): Promise<{
    readonly variables: ArMacroResponse['variables'];
    readonly dolares: ArMacroResponse['dolares'];
    readonly errors: readonly string[];
    readonly updatedAt: string | null;
  }> {
    const cached = await this.macroCache.getOrCompute(
      'macro:bcra_argdatos',
      async () => {
        const errors: string[] = [];
        const [bcraRes, dolaresRes, infMRes, infYRes, riesgoRes, plazoFijoRes, nyfedSofrRes] = await Promise.all([
          this.fetchJsonSafe(`${this.bcraBaseUrl}/estadisticas/v4.0/Monetarias`),
          this.fetchJsonSafe(`${this.argDatosBaseUrl}/v1/cotizaciones/dolares`),
          this.fetchJsonSafe(`${this.argDatosBaseUrl}/v1/finanzas/indices/inflacion`),
          this.fetchJsonSafe(`${this.argDatosBaseUrl}/v1/finanzas/indices/inflacionInteranual`),
          this.fetchJsonSafe(`${this.argDatosBaseUrl}/v1/finanzas/indices/riesgo-pais`),
          this.fetchJsonSafe(`${this.argDatosBaseUrl}/v1/finanzas/tasas/plazoFijo`),
          this.fetchJsonSafe(`${this.nyfedBaseUrl}/api/rates/secured/sofr/last/1.json`),
        ]);

        let a3500: number | null = null;
        let badlarTna: number | null = null;
        let tamarTna: number | null = null;
        let tpmTna: number | null = null;
        let cer: number | null = null;
        let uva: number | null = null;
        let reservasUsdM: number | null = null;
        let baseMonetariaArsM: number | null = null;
        let updatedAt: string | null = null;

        const secondaryBcraIds = new Set([35, 45, 46, 59, 64, 66, 71, 197]);
        if (!bcraRes.ok) {
          errors.push(`BCRA v4.0: ${bcraRes.error}`);
        } else if (isPlainRecord(bcraRes.data) && Array.isArray(bcraRes.data['results'])) {
          for (const item of bcraRes.data['results']) {
            if (!isPlainRecord(item)) {
              continue;
            }
            const idVar = readNum(item, ['idVariable', 'id']);
            const desc = (readStr(item, ['descripcion', 'nombre']) ?? '').toLowerCase();
            const val = readNum(item, ['ultValorInformado', 'valor', 'value']);
            const fecha = readStr(item, ['ultFechaInformada', 'fecha', 'date']);
            if (fecha !== null && (updatedAt === null || fecha > updatedAt)) {
              updatedAt = fecha;
            }
            if (val === null) {
              continue;
            }
            if (idVar === 5) {
              a3500 = val;
            } else if (idVar === 7) {
              badlarTna = val;
            } else if (idVar === 44) {
              tamarTna = val;
            } else if (idVar === 6) {
              tpmTna = val;
            } else if (idVar === 30) {
              cer = val;
            } else if (idVar === 31) {
              uva = val;
            } else if (idVar === 1) {
              reservasUsdM = val;
            } else if (idVar === 15) {
              baseMonetariaArsM = val;
            } else if (idVar === null || !secondaryBcraIds.has(idVar)) {
              if (desc.includes('mayorista') || desc.includes('3500')) {
                a3500 = a3500 ?? val;
              } else if (desc.includes('badlar')) {
                badlarTna = badlarTna ?? val;
              } else if (desc.includes('tamar')) {
                tamarTna = tamarTna ?? val;
              } else if (desc.includes('política monetaria') || desc.includes('politica monetaria')) {
                tpmTna = tpmTna ?? val;
              } else if (desc === 'cer' || desc.includes('coeficiente de estabilización')) {
                cer = cer ?? val;
              } else if (desc.includes('uva')) {
                uva = uva ?? val;
              } else if (desc.includes('reservas internacionales')) {
                reservasUsdM = reservasUsdM ?? val;
              } else if (desc.includes('base monetaria')) {
                baseMonetariaArsM = baseMonetariaArsM ?? val;
              }
            }
          }
        }

        const dolarDisplayNames: Readonly<Record<string, string>> = {
          oficial: 'Oficial',
          mayorista: 'Mayorista',
          bolsa: 'MEP (Bolsa)',
          contadoconliqui: 'Contado con Liqui',
          blue: 'Blue',
          cripto: 'Cripto',
          tarjeta: 'Tarjeta',
          solidario: 'Solidario',
        };
        const latestDolaresByCasa = new Map<string, ArMacroResponse['dolares'][number]>();

        if (!dolaresRes.ok) {
          errors.push(`ArgentinaDatos dolares: ${dolaresRes.error}`);
        } else if (Array.isArray(dolaresRes.data)) {
          for (const d of dolaresRes.data) {
            if (!isPlainRecord(d)) {
              continue;
            }
            const casa = (readStr(d, ['casa']) ?? '').toLowerCase();
            if (casa.length === 0) {
              continue;
            }
            const nombre = readStr(d, ['nombre']) ?? dolarDisplayNames[casa] ?? casa.toUpperCase();
            const compra = readNum(d, ['compra']);
            const venta = readNum(d, ['venta']);
            const fecha = readStr(d, ['fechaActualizacion', 'fecha']);
            if (compra === null && venta === null) {
              continue;
            }
            const prev = latestDolaresByCasa.get(casa);
            const isNewer =
              prev === undefined ||
              (fecha !== null && (prev.fechaActualizacion === null || fecha >= prev.fechaActualizacion)) ||
              (fecha === null && prev.fechaActualizacion === null);
            if (isNewer) {
              latestDolaresByCasa.set(casa, { casa, nombre, compra, venta, fechaActualizacion: fecha });
            }
          }
        }
        const dolares: ArMacroResponse['dolares'][number][] = [...latestDolaresByCasa.values()];
        const mepRow = latestDolaresByCasa.get('bolsa') ?? latestDolaresByCasa.get('mep');
        const cclRow = latestDolaresByCasa.get('contadoconliqui') ?? latestDolaresByCasa.get('ccl');
        const blueRow = latestDolaresByCasa.get('blue');
        const oficialRow = latestDolaresByCasa.get('oficial');
        const pickDolarPos = (row: ArMacroResponse['dolares'][number] | undefined): number | null => {
          if (!row) return null;
          return sanitizePositive(row.venta) ?? sanitizePositive(row.compra);
        };
        const mepArgDatos = pickDolarPos(mepRow);
        const cclArgDatos = pickDolarPos(cclRow);
        const blue = pickDolarPos(blueRow);
        const oficial = pickDolarPos(oficialRow);

        const extractLatestIndex = (res: typeof infMRes, label: string): number | null => {
          if (!res.ok) {
            errors.push(`ArgentinaDatos ${label}: ${res.error}`);
            return null;
          }
          if (!Array.isArray(res.data) || res.data.length === 0) {
            return null;
          }
          const arr = res.data as readonly unknown[];
          const lastItem = arr[arr.length - 1];
          return isPlainRecord(lastItem) ? readNum(lastItem, ['valor', 'value']) : null;
        };

        const inflacionMensualPct = extractLatestIndex(infMRes, 'inflacion');
        const inflacionInteranualPct = extractLatestIndex(infYRes, 'inflacionInteranual');
        const riesgoPaisPb = extractLatestIndex(riesgoRes, 'riesgo-pais');

        // Plazo Fijo (ArgentinaDatos auxiliar; si no está disponible o da 404, no degrada macro)
        let plazoFijoTna: number | null = null;
        if (plazoFijoRes.ok && Array.isArray(plazoFijoRes.data)) {
          const pfRates: number[] = [];
          for (const item of plazoFijoRes.data) {
            if (!isPlainRecord(item)) {
              continue;
            }
            const rawRate = readNum(item, ['tnaClientes', 'tnaNoClientes', 'tna', 'valor', 'tasa']);
            if (rawRate !== null && rawRate > 0) {
              pfRates.push(rawRate <= 2 ? rawRate * 100 : rawRate);
            }
          }
          plazoFijoTna = computeMedian(pfRates);
        }

        let sofrUsdTna: number | null = null;
        if (nyfedSofrRes.ok && isPlainRecord(nyfedSofrRes.data)) {
          const refRatesUnknown: unknown = nyfedSofrRes.data['refRates'];
          if (Array.isArray(refRatesUnknown)) {
            const firstRef: unknown = refRatesUnknown[0];
            if (isPlainRecord(firstRef)) {
              const pct = readNum(firstRef, ['percentRate']);
              if (pct !== null && Number.isFinite(pct) && pct >= 0) {
                sofrUsdTna = pct;
              }
            }
          }
        }

        return {
          variables: {
            a3500,
            badlarTna,
            tamarTna,
            tpmTna,
            plazoFijoTna,
            sofrUsdTna,
            cer,
            uva,
            reservasUsdM,
            baseMonetariaArsM,
            inflacionMensualPct,
            inflacionInteranualPct,
            riesgoPaisPb,
            mep: mepArgDatos,
            ccl: cclArgDatos,
            blue,
            oficial,
          },
          dolares,
          errors,
          updatedAt,
        };
      },
      { forceRefresh },
    );

    return cached.value as {
      readonly variables: ArMacroResponse['variables'];
      readonly dolares: ArMacroResponse['dolares'];
      readonly errors: readonly string[];
      readonly updatedAt: string | null;
    };
  }

  private computeMepCclMatrix(params: {
    readonly mepRows: readonly NormalizedQuoteRow[];
    readonly cclRows: readonly NormalizedQuoteRow[];
    readonly argStocks: readonly NormalizedQuoteRow[];
    readonly usaAdrs: readonly NormalizedQuoteRow[];
    readonly argCedears: readonly NormalizedQuoteRow[];
    readonly usaStocks: readonly NormalizedQuoteRow[];
    readonly argBonds: readonly NormalizedQuoteRow[];
    readonly fallbackMep: number | null;
    readonly fallbackCcl: number | null;
    readonly preferredMepMedian?: number | null;
    readonly preferredCclMedian?: number | null;
  }): {
    readonly mepMedian: number | null;
    readonly cclMedian: number | null;
    readonly rows: readonly MepCclArbitrageRow[];
  } {
    const stockMap = new Map(params.argStocks.map((r) => [r.symbol, r]));
    const adrMap = new Map(params.usaAdrs.map((r) => [r.symbol, r]));
    const cedearMap = new Map(params.argCedears.map((r) => [r.symbol, r]));
    const usaMap = new Map(params.usaStocks.map((r) => [r.symbol, r]));
    const bondMap = new Map(params.argBonds.map((r) => [r.symbol, r]));

    const rawRows: {
      symbol: string;
      category: MepCclArbitrageRow['category'];
      ratio: number;
      localArs: number | null;
      usdPrice: number | null;
      impliedRate: number | null;
      side: 'MEP' | 'CCL';
    }[] = [];

    // 1. Directo /live/mep y /live/ccl de Data912
    const liveMepRates: number[] = [];
    const liveCclRates: number[] = [];
    for (const r of params.mepRows) {
      const rate = resolvePositiveQuoteRate(r);
      if (rate !== null) {
        liveMepRates.push(rate);
        rawRows.push({
          symbol: r.symbol,
          category: 'BONO',
          ratio: 1,
          localArs: null,
          usdPrice: null,
          impliedRate: rate,
          side: 'MEP',
        });
      }
    }
    for (const r of params.cclRows) {
      const rate = resolvePositiveQuoteRate(r);
      if (rate !== null) {
        liveCclRates.push(rate);
        rawRows.push({
          symbol: r.symbol,
          category: 'BONO',
          ratio: 1,
          localArs: null,
          usdPrice: null,
          impliedRate: rate,
          side: 'CCL',
        });
      }
    }

    // 2. Bonos soberanos directos (AL30/GD30 prioridad, luego AL35/GD35)
    const bondMepPriorityRates: number[] = [];
    const bondMepOtherRates: number[] = [];
    const bondCclPriorityRates: number[] = [];
    const bondCclOtherRates: number[] = [];
    for (const base of ['AL30', 'GD30', 'AL35', 'GD35']) {
      const ars = bondMap.get(base)?.last ?? null;
      const usdD = bondMap.get(`${base}D`)?.last ?? null;
      const usdC = bondMap.get(`${base}C`)?.last ?? null;
      const isPriority = base === 'AL30' || base === 'GD30';
      if (ars !== null && ars > 0 && usdD !== null && usdD > 0) {
        const implied = ars / usdD;
        (isPriority ? bondMepPriorityRates : bondMepOtherRates).push(implied);
        rawRows.push({
          symbol: `${base} (D)`,
          category: 'BONO',
          ratio: 1,
          localArs: ars,
          usdPrice: usdD,
          impliedRate: implied,
          side: 'MEP',
        });
      }
      if (ars !== null && ars > 0 && usdC !== null && usdC > 0) {
        const implied = ars / usdC;
        (isPriority ? bondCclPriorityRates : bondCclOtherRates).push(implied);
        rawRows.push({
          symbol: `${base} (C)`,
          category: 'BONO',
          ratio: 1,
          localArs: ars,
          usdPrice: usdC,
          impliedRate: implied,
          side: 'CCL',
        });
      }
    }

    // 3. ADRs con ratio oficial
    const equityCclRates: number[] = [];
    for (const meta of AR_STOCK_META) {
      if (meta.adrTicker === undefined || meta.adrRatio === undefined) {
        continue;
      }
      const localPx = stockMap.get(meta.ticker)?.last ?? null;
      const adrPx = adrMap.get(meta.adrTicker)?.last ?? usaMap.get(meta.adrTicker)?.last ?? null;
      if (localPx !== null && localPx > 0 && adrPx !== null && adrPx > 0) {
        const implied = (localPx * meta.adrRatio) / adrPx;
        equityCclRates.push(implied);
        rawRows.push({
          symbol: `${meta.ticker}/${meta.adrTicker}`,
          category: 'ADR',
          ratio: meta.adrRatio,
          localArs: localPx,
          usdPrice: adrPx,
          impliedRate: implied,
          side: 'CCL',
        });
      }
    }

    // 4. CEDEARs líquidos con ratio oficial Comafi
    for (const [cedSym, info] of Object.entries(CEDEAR_RATIOS)) {
      const cedPx = cedearMap.get(cedSym)?.last ?? null;
      const usPx = usaMap.get(info.usTicker)?.last ?? adrMap.get(info.usTicker)?.last ?? null;
      if (cedPx !== null && cedPx > 0 && usPx !== null && usPx > 0) {
        const implied = (cedPx * info.ratio) / usPx;
        equityCclRates.push(implied);
        rawRows.push({
          symbol: cedSym,
          category: 'CEDEAR',
          ratio: info.ratio,
          localArs: cedPx,
          usdPrice: usPx,
          impliedRate: implied,
          side: 'CCL',
        });
      }
    }

    const mepRates = rawRows.filter((r) => r.side === 'MEP' && r.impliedRate !== null).map((r) => r.impliedRate as number);
    const cclRates = rawRows.filter((r) => r.side === 'CCL' && r.impliedRate !== null).map((r) => r.impliedRate as number);

    // Cascada explícita compartida por /api/ar/overview y /api/ar/macro:
    // Data912 (/live/mep & /live/ccl) → Paridad implícita AL30/GD30 (y otros bonos/ADRs/CEDEARs) → ArgentinaDatos (bolsa / contadoconliqui)
    const mepMedian =
      sanitizePositive(params.preferredMepMedian) ??
      computeMedian(liveMepRates) ??
      computeMedian(bondMepPriorityRates) ??
      computeMedian(bondMepOtherRates) ??
      sanitizePositive(params.fallbackMep);
    const cclMedian =
      sanitizePositive(params.preferredCclMedian) ??
      computeMedian(liveCclRates) ??
      computeMedian(bondCclPriorityRates) ??
      computeMedian(bondCclOtherRates) ??
      computeMedian(equityCclRates) ??
      sanitizePositive(params.fallbackCcl);
    const cclStats = computeMeanAndStd(cclRates);
    const mepStats = computeMeanAndStd(mepRates);

    const rows: MepCclArbitrageRow[] = rawRows.map((r) => {
      const med = r.side === 'MEP' ? mepMedian : cclMedian;
      const st = r.side === 'MEP' ? mepStats : cclStats;
      const spreadBps =
        med !== null && med > 0 && r.impliedRate !== null
          ? ((r.impliedRate - med) / med) * 10_000
          : null;
      const zScore =
        st !== null && st.std > 1e-6 && r.impliedRate !== null
          ? (r.impliedRate - st.mean) / st.std
          : null;
      return {
        symbol: r.symbol,
        category: r.category,
        ratio: r.ratio,
        localArs: sanitizeFinite(r.localArs),
        usdPrice: sanitizeFinite(r.usdPrice),
        impliedRate: sanitizeFinite(r.impliedRate),
        medianRate: sanitizeFinite(med),
        spreadBps: sanitizeFinite(spreadBps),
        zScore: sanitizeFinite(zScore),
        side: r.side,
      };
    });

    return { mepMedian, cclMedian, rows };
  }

  private computeParityMismatchAndArb(params: {
    readonly usTicker?: string | undefined;
    readonly ratio?: number | undefined;
    readonly localLast: number | null;
    readonly usLast: number | null;
    readonly cclImplicit: number | null;
    readonly cclMedian: number | null;
    readonly hasBymaOptions: boolean;
  }): {
    readonly cclMismatchPct: number | null;
    readonly cclMismatchArs: number | null;
    readonly fairArsPrice: number | null;
    readonly hasUsOptions: boolean;
    readonly hasBymaOptions: boolean;
    readonly arbitrageSignal: string | null;
  } {
    const cleanUs = params.usTicker?.replace(/ US$/i, '').trim().toUpperCase();
    const hasUsOptions = cleanUs !== undefined && US_LIQUID_OPTION_UNDERLYINGS.has(cleanUs);
    const fairArsPrice =
      params.usLast !== null &&
      params.usLast > 0 &&
      params.cclMedian !== null &&
      params.cclMedian > 0 &&
      params.ratio !== undefined &&
      params.ratio > 0
        ? sanitizeFinite((params.usLast * params.cclMedian) / params.ratio)
        : null;
    const cclMismatchPct =
      params.cclImplicit !== null &&
      params.cclImplicit > 0 &&
      params.cclMedian !== null &&
      params.cclMedian > 0
        ? sanitizeFinite(((params.cclImplicit - params.cclMedian) / params.cclMedian) * 100)
        : null;
    const cclMismatchArs =
      params.localLast !== null && params.localLast > 0 && fairArsPrice !== null
        ? sanitizeFinite(params.localLast - fairArsPrice)
        : null;

    let arbitrageSignal: string | null = null;
    if (cclMismatchPct !== null) {
      if (cclMismatchPct <= -1.2) {
        arbitrageSignal = `DESCUENTO ${cclMismatchPct.toFixed(1)}% · Long ARS${hasUsOptions ? ' / Put US (OPRA)' : ''}${params.hasBymaOptions ? ' / Call BYMA' : ''}`;
      } else if (cclMismatchPct >= 1.2) {
        arbitrageSignal = `PRIMA +${cclMismatchPct.toFixed(1)}% · Short ARS${hasUsOptions ? ' / Call US (OPRA)' : ''}${params.hasBymaOptions ? ' / Lanzar BYMA' : ''}`;
      } else {
        arbitrageSignal = `En paridad (${cclMismatchPct >= 0 ? '+' : ''}${cclMismatchPct.toFixed(1)}%)${params.hasBymaOptions ? ' · OPRA + BYMA' : hasUsOptions ? ' · OPRA' : ''}`;
      }
    }

    return {
      cclMismatchPct,
      cclMismatchArs,
      fairArsPrice,
      hasUsOptions,
      hasBymaOptions: params.hasBymaOptions,
      arbitrageSignal,
    };
  }

  private computeRelativeVolumeMultiple(params: {
    readonly todayShares: number | null;
    readonly bars: readonly Bar[];
    readonly asOfUtcSec: number;
  }): number | null {
    const { todayShares, bars, asOfUtcSec } = params;
    if (todayShares === null || !Number.isFinite(todayShares) || todayShares <= 0 || bars.length < 11) {
      return null;
    }
    const todayKey = new Date(asOfUtcSec * 1_000).toISOString().slice(0, 10);
    const lastBar = bars[bars.length - 1];
    if (lastBar === undefined) {
      return null;
    }
    const lastDateKey = new Date(lastBar.time * 1_000).toISOString().slice(0, 10);
    const excludeLast = lastDateKey === todayKey || Math.abs(lastBar.volume - todayShares) <= 1e-6;
    const candidateBars = (excludeLast ? bars.slice(0, -1) : bars).slice(-20);
    const posVols = candidateBars.map((b) => b.volume).filter((v) => Number.isFinite(v) && v > 0);
    if (posVols.length < 10) {
      return null;
    }
    const avgVol20 = posVols.reduce((acc, v) => acc + v, 0) / posVols.length;
    return avgVol20 > 0 ? sanitizeFinite(todayShares / avgVol20) : null;
  }

  private buildEqualWeightIndexBars(seriesList: readonly (readonly Bar[])[]): readonly Bar[] {
    const retByDate = new Map<string, number[]>();
    const timeByDate = new Map<string, number>();

    for (const bars of seriesList) {
      for (let i = 1; i < bars.length; i += 1) {
        const prev = bars[i - 1];
        const cur = bars[i];
        if (prev !== undefined && cur !== undefined && prev.close > 0 && cur.close > 0) {
          const day = new Date(cur.time * 1_000).toISOString().slice(0, 10);
          const list = retByDate.get(day) ?? [];
          list.push(cur.close / prev.close - 1);
          retByDate.set(day, list);
          timeByDate.set(day, cur.time);
        }
      }
    }

    const dates = Array.from(retByDate.keys()).sort();
    const out: Bar[] = [];
    let level = 100;
    for (const d of dates) {
      const rets = retByDate.get(d);
      const t = timeByDate.get(d);
      if (rets === undefined || rets.length < 3 || t === undefined) {
        continue;
      }
      const avgRet = rets.reduce((acc, r) => acc + r, 0) / rets.length;
      const prevLevel = level;
      level = Math.max(0.01, prevLevel * (1 + avgRet));
      out.push({
        time: t,
        open: prevLevel,
        high: Math.max(prevLevel, level),
        low: Math.min(prevLevel, level),
        close: level,
        volume: 0,
      });
    }
    return out;
  }

  private buildStockDtos(params: {
    readonly argStocks: readonly NormalizedQuoteRow[];
    readonly bymaRows: readonly NormalizedQuoteRow[];
    readonly usaAdrs: readonly NormalizedQuoteRow[];
    readonly usaStocks: readonly NormalizedQuoteRow[];
    readonly cclMedian: number | null;
    readonly useBymaFallback: boolean;
  }): readonly ArStockDto[] {
    const d912Map = new Map(params.argStocks.map((r) => [r.symbol, r]));
    const bymaMap = new Map(params.bymaRows.map((r) => [r.symbol, r]));
    const adrMap = new Map(params.usaAdrs.map((r) => [r.symbol, r]));
    const usaMap = new Map(params.usaStocks.map((r) => [r.symbol, r]));

    return AR_STOCK_META.map((meta) => {
      const byma = bymaMap.get(meta.ticker);
      const d912 = d912Map.get(meta.ticker);
      const primary = byma ?? d912;
      const source =
        primary?.quoteSource === 'BMB_HOMEBROKER_BRIDGE' && primary.last !== null
          ? 'BMB_HOMEBROKER'
          : byma !== undefined
            ? 'OPEN_BYMA'
            : d912 !== undefined
              ? 'DATA912'
              : 'NONE';

      const last = primary?.last ?? d912?.last ?? null;
      const prevClose = primary?.prevClose ?? d912?.prevClose ?? null;
      const deltaPct = primary?.deltaPct ?? d912?.deltaPct ?? null;
      const low = primary?.low ?? d912?.low ?? null;
      const high = primary?.high ?? d912?.high ?? null;
      const dayRangePos =
        last !== null && low !== null && high !== null && high > low
          ? sanitizeFinite((last - low) / (high - low))
          : null;
      const vwap = primary?.vwap ?? d912?.vwap ?? null;
      const volumeArs = primary?.volumeArs ?? d912?.volumeArs ?? null;
      const volumeM = volumeArs !== null ? volumeArs / 1_000_000 : null;

      let adrPrice: number | null = null;
      let adrDeltaPct: number | null = null;
      let cclImplicit: number | null = null;
      if (meta.adrTicker !== undefined) {
        const adrRow = adrMap.get(meta.adrTicker) ?? usaMap.get(meta.adrTicker);
        adrPrice = adrRow?.last ?? null;
        adrDeltaPct = adrRow?.deltaPct ?? null;
        if (last !== null && last > 0 && adrPrice !== null && adrPrice > 0 && meta.adrRatio !== undefined) {
          cclImplicit = (last * meta.adrRatio) / adrPrice;
        }
      }

      const hasBymaOptions = BYMA_OPTION_UNDERLYINGS.has(meta.ticker);
      const parity = this.computeParityMismatchAndArb({
        usTicker: meta.adrTicker,
        ratio: meta.adrRatio,
        localLast: last,
        usLast: adrPrice,
        cclImplicit,
        cclMedian: params.cclMedian,
        hasBymaOptions,
      });

      const signalText =
        deltaPct === null
          ? 'Sin datos de cotización'
          : deltaPct >= 2.0
            ? 'Impulso alcista sobre cierre previo'
            : deltaPct <= -2.0
              ? 'Presión vendedora intradiaria'
              : Math.abs(deltaPct) < 0.35
                ? 'Lateralización de rango estrecho'
                : deltaPct > 0
                  ? 'Sesgo comprador moderado'
                  : 'Retroceso moderado';

      return {
        ticker: meta.ticker,
        name: meta.name,
        sector: meta.sector,
        panel: meta.panel,
        color: meta.color,
        last: sanitizeFinite(last),
        bid: sanitizePositive(primary?.bid ?? d912?.bid),
        ask: sanitizePositive(primary?.ask ?? d912?.ask),
        deltaPct: sanitizeFinite(deltaPct),
        prevClose: sanitizeFinite(prevClose),
        low: sanitizeFinite(low),
        high: sanitizeFinite(high),
        dayRangePos,
        vwap: sanitizeFinite(vwap),
        volumeM: sanitizeFinite(volumeM),
        volMultiple: null,
        signalText: params.useBymaFallback && byma === undefined && d912 !== undefined ? `${signalText} (Data912)` : signalText,
        ...(meta.adrTicker !== undefined ? { adrTicker: `${meta.adrTicker} US`, adrRatio: meta.adrRatio } : {}),
        adrPrice: sanitizeFinite(adrPrice),
        adrDeltaPct: sanitizeFinite(adrDeltaPct),
        cclImplicit: sanitizeFinite(cclImplicit),
        cclZScore:
          cclImplicit !== null && params.cclMedian !== null && params.cclMedian > 0
            ? sanitizeFinite(((cclImplicit - params.cclMedian) / params.cclMedian) * 100)
            : null,
        cclMismatchPct: parity.cclMismatchPct,
        cclMismatchArs: parity.cclMismatchArs,
        fairArsPrice: parity.fairArsPrice,
        hasUsOptions: parity.hasUsOptions,
        hasBymaOptions: parity.hasBymaOptions,
        arbitrageSignal: parity.arbitrageSignal,
        sparkline: [prevClose, low, high, last].filter((v): v is number => v !== null && Number.isFinite(v)),
        source,
        quoteAsOfUtcSec: primary?.quoteAsOfUtcSec ?? d912?.quoteAsOfUtcSec ?? null,
      };
    });
  }

  private buildCedearDtos(params: {
    readonly argCedears: readonly NormalizedQuoteRow[];
    readonly usaStocks: readonly NormalizedQuoteRow[];
    readonly usaAdrs: readonly NormalizedQuoteRow[];
    readonly cclMedian: number | null;
  }): readonly ArStockDto[] {
    const cedearMap = new Map(params.argCedears.map((r) => [r.symbol, r]));
    const usaMap = new Map(params.usaStocks.map((r) => [r.symbol, r]));
    const adrMap = new Map(params.usaAdrs.map((r) => [r.symbol, r]));

    const cedearEntries = Object.entries(CEDEAR_RATIOS).filter(([ticker]) => {
      if (ticker === 'VISTA') {
        return cedearMap.has('VISTA') || !cedearMap.has('VIST');
      }
      if (ticker === 'VIST') {
        return cedearMap.has('VIST') || !cedearMap.has('VISTA');
      }
      return true;
    });

    return cedearEntries.map(([ticker, info]) => {
      const row = cedearMap.get(ticker);
      const usRow = usaMap.get(info.usTicker) ?? adrMap.get(info.usTicker);
      const last = row?.last ?? null;
      const usLast = usRow?.last ?? null;
      const cclImplicit =
        last !== null && last > 0 && usLast !== null && usLast > 0
          ? (last * info.ratio) / usLast
          : null;
      const dayRangePos =
        last !== null &&
        row !== undefined &&
        row.low !== null &&
        row.high !== null &&
        row.high > row.low
          ? sanitizeFinite((last - row.low) / (row.high - row.low))
          : null;
      const parity = this.computeParityMismatchAndArb({
        usTicker: info.usTicker,
        ratio: info.ratio,
        localLast: last,
        usLast,
        cclImplicit,
        cclMedian: params.cclMedian,
        hasBymaOptions: false,
      });

      return {
        ticker,
        name: info.name,
        sector: 'CEDEAR',
        panel: 'CEDEAR',
        color: '#38BDF8',
        last: sanitizeFinite(last),
        bid: sanitizeFinite(row?.bid),
        ask: sanitizeFinite(row?.ask),
        deltaPct: sanitizeFinite(row?.deltaPct),
        prevClose: sanitizeFinite(row?.prevClose),
        low: sanitizeFinite(row?.low),
        high: sanitizeFinite(row?.high),
        dayRangePos,
        vwap: sanitizeFinite(row?.vwap),
        volumeM: row?.volumeArs !== null && row?.volumeArs !== undefined ? sanitizeFinite(row.volumeArs / 1_000_000) : null,
        volMultiple: null,
        signalText: cclImplicit !== null ? `Ratio ${String(info.ratio)}:1 · Subyacente ${info.usTicker}` : 'Sin datos',
        adrTicker: `${info.usTicker} US`,
        adrRatio: info.ratio,
        adrPrice: sanitizeFinite(usLast),
        adrDeltaPct: sanitizeFinite(usRow?.deltaPct),
        cclImplicit: sanitizeFinite(cclImplicit),
        cclZScore: parity.cclMismatchPct,
        cclMismatchPct: parity.cclMismatchPct,
        cclMismatchArs: parity.cclMismatchArs,
        fairArsPrice: parity.fairArsPrice,
        ivSource: 'NONE',
        hasUsOptions: parity.hasUsOptions,
        hasBymaOptions: false,
        arbitrageSignal: parity.arbitrageSignal,
        sparkline: [row?.prevClose ?? null, row?.low ?? null, row?.high ?? null, last].filter(
          (v): v is number => v !== null && Number.isFinite(v),
        ),
        source: row?.quoteSource === 'BMB_HOMEBROKER_BRIDGE' ? 'BMB_HOMEBROKER' : row !== undefined ? 'DATA912' : 'NONE',
        quoteAsOfUtcSec: row?.quoteAsOfUtcSec ?? null,
      };
    });
  }

  private buildSovereignBonds(
    argBonds: readonly NormalizedQuoteRow[],
    mepMedian: number | null,
    cclMedian: number | null,
    asOfUtcSec: number,
    cerIndex: number | null = null,
  ): readonly ArBondDto[] {
    const bondMap = new Map(argBonds.map((r) => [r.symbol, r]));
    return SOVEREIGN_BONDS.map((spec) => {
      const currency = spec.currency ?? 'USD';
      const rowArs = bondMap.get(spec.baseTicker);
      const rowD = bondMap.get(`${spec.baseTicker}D`);
      const rowC = bondMap.get(`${spec.baseTicker}C`);

      const priceArs = rowArs?.last ?? null;
      let priceUsd = rowD?.last ?? rowC?.last ?? null;
      if (priceUsd === null && priceArs !== null && mepMedian !== null && mepMedian > 0) {
        priceUsd = priceArs / mepMedian;
      }
      const selectedPriceRow =
        currency === 'USD'
          ? rowD?.last !== null && rowD?.last !== undefined
            ? rowD
            : rowC?.last !== null && rowC?.last !== undefined
              ? rowC
              : rowArs
          : rowArs;

      let math: {
        readonly tirPct: number | null;
        readonly parityPct: number | null;
        readonly duration: number | null;
        readonly accruedInterest: number | null;
      } = { tirPct: null, parityPct: null, duration: null, accruedInterest: null };

      if (currency === 'CER') {
        if (
          cerIndex !== null &&
          cerIndex > 0 &&
          spec.cerBase !== undefined &&
          spec.cerBase > 0 &&
          priceArs !== null &&
          priceArs > 0
        ) {
          const cerFactor = cerIndex / spec.cerBase;
          const deflatedBase100 = priceArs / cerFactor;
          math = evaluateSovereignBondMath(spec, deflatedBase100, asOfUtcSec);
        }
      } else if (priceUsd !== null && priceUsd > 0) {
        math = evaluateSovereignBondMath(spec, priceUsd, asOfUtcSec);
      }

      const mepImplicit =
        currency === 'USD' && priceArs !== null && priceArs > 0 && rowD?.last !== null && rowD?.last !== undefined && rowD.last > 0
          ? priceArs / rowD.last
          : null;
      const cclImplicit =
        currency === 'USD' && priceArs !== null && priceArs > 0 && rowC?.last !== null && rowC?.last !== undefined && rowC.last > 0
          ? priceArs / rowC.last
          : cclMedian !== null && cclMedian > 0 && priceUsd !== null && priceUsd > 0 && priceArs !== null && priceArs > 0
            ? priceArs / priceUsd
            : null;

      return {
        ticker: spec.baseTicker,
        name: spec.name,
        legislation: spec.legislation,
        maturity: spec.maturity,
        currency,
        priceUsd: sanitizeFinite(priceUsd),
        priceArs: sanitizeFinite(priceArs),
        deltaPct: sanitizeFinite(selectedPriceRow?.deltaPct ?? rowD?.deltaPct ?? rowC?.deltaPct ?? rowArs?.deltaPct),
        tirPct: math.tirPct,
        parityPct: math.parityPct,
        duration: math.duration,
        accruedInterest: math.accruedInterest,
        volumeM:
          rowArs?.volumeArs !== null && rowArs?.volumeArs !== undefined
            ? sanitizeFinite(rowArs.volumeArs / 1_000_000)
            : null,
        mepImplicit: sanitizeFinite(mepImplicit),
        cclImplicit: sanitizeFinite(cclImplicit),
        source:
          selectedPriceRow?.quoteSource === 'BMB_HOMEBROKER_BRIDGE' && selectedPriceRow.last !== null
            ? 'BMB_HOMEBROKER'
            : selectedPriceRow !== undefined
              ? 'DATA912'
              : 'NONE',
        quoteAsOfUtcSec: selectedPriceRow?.quoteAsOfUtcSec ?? null,
      };
    });
  }

  private historyBarsToQuoteRow(symbol: string, bars: readonly Bar[]): NormalizedQuoteRow | null {
    const lastBar = bars[bars.length - 1];
    if (lastBar === undefined || !Number.isFinite(lastBar.close) || lastBar.close <= 0) {
      return null;
    }
    const prevBar = bars[bars.length - 2];
    const deltaPct =
      prevBar !== undefined && Number.isFinite(prevBar.close) && prevBar.close > 0
        ? ((lastBar.close - prevBar.close) / prevBar.close) * 100
        : null;
    return {
      symbol: symbol.toUpperCase(),
      last: lastBar.close,
      bid: null,
      bidSize: null,
      ask: null,
      askSize: null,
      prevClose: sanitizeFinite(prevBar?.close),
      deltaPct: sanitizeFinite(deltaPct),
      low: sanitizeFinite(lastBar.low),
      high: sanitizeFinite(lastBar.high),
      vwap: sanitizeFinite(lastBar.vw ?? lastBar.close),
      volumeArs: Number.isFinite(lastBar.volume) ? sanitizeFinite(lastBar.volume * lastBar.close) : null,
      nominalVol: Number.isFinite(lastBar.volume) ? sanitizeFinite(lastBar.volume) : null,
      mark: lastBar.close,
      impliedUsdArs: null,
      arsBid: null,
      arsAsk: null,
      usdBid: null,
      usdAsk: null,
    };
  }

  private async populateEodRowsFromHistorical(
    kind: 'stocks' | 'cedears' | 'bonds',
    tickers: readonly string[],
    forceRefresh = false,
  ): Promise<readonly NormalizedQuoteRow[]> {
    const results = await mapWithConcurrencyLimit(
      tickers,
      AR_PANEL_CONCURRENCY_LIMIT,
      async (ticker) => {
        const hist =
          kind === 'cedears'
            ? await this.getCedearHistoryWithAlias(ticker, forceRefresh)
            : await this.getData912History(kind, ticker, forceRefresh);
        return this.historyBarsToQuoteRow(ticker, hist.bars);
      },
    );
    return results.filter((r): r is NormalizedQuoteRow => r !== null);
  }

  public async warmup(forceRefresh = false): Promise<void> {
    // Priorizamos panorama (que además precalienta macro, bonos y cadena GGAL) antes de
    // hidratar monitoreo de bonos y relaciones sin recomputar la cadena GGAL en paralelo.
    await Promise.allSettled([this.getOverview(forceRefresh)]);
    await Promise.allSettled([
      this.getMacro(forceRefresh),
      this.getMonitoring('bonos', forceRefresh),
    ]);
    await new Promise<void>((r) => setTimeout(r, 10));
    await Promise.allSettled([
      this.getOptionsChain('GGAL', false),
      this.getRelations(forceRefresh),
    ]);
  }

  private async getOverviewCore(forceRefresh = false): Promise<ArOverviewResponse> {
    const cached = await this.computedCache.getOrCompute(
      'ar:overview:core',
      async () => {
        const nowSec = Math.floor(this.nowMsFn() / 1_000);
        const [
          mepRes,
          cclRes,
          stocksRes,
          adrsRes,
          cedearsRes,
          usaStocksRes,
          bondsRes,
          bymaBlueRes,
          bymaGeneralRes,
          macroData,
        ] = await Promise.all([
          this.getData912Live('/live/mep', forceRefresh),
          this.getData912Live('/live/ccl', forceRefresh),
          this.getData912Live('/live/arg_stocks', forceRefresh),
          this.getData912Live('/live/usa_adrs', forceRefresh),
          this.getData912Live('/live/arg_cedears', forceRefresh),
          this.getData912Live('/live/usa_stocks', forceRefresh),
          this.getData912Live('/live/arg_bonds', forceRefresh),
          this.getOpenBymaPanel('leading-equity', forceRefresh),
          this.getOpenBymaPanel('general-equity', forceRefresh),
          this.fetchBcraAndArgDatos(forceRefresh),
        ]);

        const bmbSnap = await this.bmbClient.getSnapshot(undefined, null, forceRefresh);
        this.lastBmbSnapshot = bmbSnap;
        let bymaMerged: readonly NormalizedQuoteRow[] = [...bymaBlueRes.rows, ...bymaGeneralRes.rows];
        const liveData912Ok =
          hasPositiveLast(stocksRes.rows) ||
          hasPositiveLast(bondsRes.rows) ||
          hasPositiveLast(cedearsRes.rows);
        const openBymaOk = hasPositiveLast(bymaMerged) || bymaMerged.length > 0;

        // Respaldo EOD 24/7 (fines de semana / feriados / pre-apertura cuando /live/* devuelve vacío, error o precios 0)
        const needStocksEod = !hasPositiveLast(stocksRes.rows) && !hasPositiveLast(bymaMerged);
        const needCedearsEod = !hasPositiveLast(cedearsRes.rows);
        const needBondsEod = !hasPositiveLast(bondsRes.rows);
        const parityBondTickers = ['AL30', 'AL30D', 'AL30C', 'GD30', 'GD30D', 'GD30C'] as const;
        const bondPosSet = new Set(
          bondsRes.rows.filter((r) => r.last !== null && r.last > 0).map((r) => r.symbol),
        );
        const missingParityBondTickers = parityBondTickers.filter((tk) => !bondPosSet.has(tk));

        const [eodStocks, eodCedears, eodBonds, eodParityBonds] = await Promise.all([
          needStocksEod
            ? this.populateEodRowsFromHistorical(
                'stocks',
                AR_STOCK_META.filter((m) => m.panel === 'Líder').map((m) => m.ticker),
                forceRefresh,
              )
            : Promise.resolve([] as readonly NormalizedQuoteRow[]),
          needCedearsEod
            ? this.populateEodRowsFromHistorical(
                'cedears',
                Object.keys(CEDEAR_RATIOS).filter((t) => t !== 'VIST'),
                forceRefresh,
              )
            : Promise.resolve([] as readonly NormalizedQuoteRow[]),
          needBondsEod
            ? this.populateEodRowsFromHistorical(
                'bonds',
                SOVEREIGN_BONDS.flatMap((b) =>
                  (b.currency ?? 'USD') === 'USD' ? [b.baseTicker, `${b.baseTicker}D`, `${b.baseTicker}C`] : [b.baseTicker],
                ),
                forceRefresh,
              )
            : Promise.resolve([] as readonly NormalizedQuoteRow[]),
          !needBondsEod && missingParityBondTickers.length > 0
            ? this.populateEodRowsFromHistorical('bonds', missingParityBondTickers, forceRefresh)
            : Promise.resolve([] as readonly NormalizedQuoteRow[]),
        ]);

        let effectiveStocks = eodStocks.length > 0 ? eodStocks : stocksRes.rows;
        let effectiveCedears = eodCedears.length > 0 ? eodCedears : cedearsRes.rows;
        let effectiveBonds =
          eodBonds.length > 0
            ? eodBonds
            : eodParityBonds.length > 0
              ? [
                  ...bondsRes.rows.filter((r) => r.last !== null && r.last > 0),
                  ...eodParityBonds.filter((p) => !bondPosSet.has(p.symbol)),
                ]
              : bondsRes.rows;
        const stockUniverse = new Set(AR_STOCK_META.map((meta) => meta.ticker));
        const cedearUniverse = new Set(Object.keys(CEDEAR_RATIOS));
        const bondUniverse = new Set(
          SOVEREIGN_BONDS.flatMap((bond) => [bond.baseTicker, `${bond.baseTicker}D`, `${bond.baseTicker}C`]),
        );
        const bmbStockMerge = mergeBmbNormalizedRows(effectiveStocks, bmbSnap, nowSec, stockUniverse);
        const bmbCedearMerge = mergeBmbNormalizedRows(effectiveCedears, bmbSnap, nowSec, cedearUniverse);
        const bmbBondMerge = mergeBmbNormalizedRows(effectiveBonds, bmbSnap, nowSec, bondUniverse);
        const bmbBymaMerge = mergeBmbNormalizedRows(bymaMerged, bmbSnap, nowSec, stockUniverse);
        effectiveStocks = bmbStockMerge.rows;
        effectiveCedears = bmbCedearMerge.rows;
        effectiveBonds = bmbBondMerge.rows;
        bymaMerged = bmbBymaMerge.rows;
        const bmbLiveActive =
          bmbStockMerge.hasLiveActivity ||
          bmbCedearMerge.hasLiveActivity ||
          bmbBondMerge.hasLiveActivity ||
          bmbBymaMerge.hasLiveActivity;
        const bmbLiveLast =
          bmbStockMerge.hasLiveLast ||
          bmbCedearMerge.hasLiveLast ||
          bmbBondMerge.hasLiveLast ||
          bmbBymaMerge.hasLiveLast;
        const usedEodFallback =
          eodStocks.length > 0 || eodCedears.length > 0 || eodBonds.length > 0;

        const providerErrors: string[] = [
          ...macroData.errors,
          ...[
            mepRes.error,
            cclRes.error,
            stocksRes.error,
            adrsRes.error,
            cedearsRes.error,
            usaStocksRes.error,
            bondsRes.error,
            bymaBlueRes.error,
            bymaGeneralRes.error,
          ].filter((e): e is string => e !== null),
        ];

        let fallbackMep = macroData.variables.mep;
        let fallbackCcl = macroData.variables.ccl;
        if (fallbackMep === null || fallbackCcl === null) {
          const preCheck = this.computeMepCclMatrix({
            mepRows: mepRes.rows,
            cclRows: cclRes.rows,
            argStocks: effectiveStocks,
            usaAdrs: adrsRes.rows,
            argCedears: effectiveCedears,
            usaStocks: usaStocksRes.rows,
            argBonds: effectiveBonds,
            fallbackMep,
            fallbackCcl,
          });
          if (preCheck.mepMedian === null || preCheck.cclMedian === null) {
            const directDolares = await this.fetchJsonSafe(`${this.argDatosBaseUrl}/v1/cotizaciones/dolares`);
            if (directDolares.ok && Array.isArray(directDolares.data)) {
              for (const d of directDolares.data) {
                if (!isPlainRecord(d)) continue;
                const casa = (readStr(d, ['casa']) ?? '').toLowerCase();
                const val = sanitizePositive(readNum(d, ['venta'])) ?? sanitizePositive(readNum(d, ['compra']));
                if (val === null) continue;
                if ((casa === 'bolsa' || casa === 'mep') && fallbackMep === null) {
                  fallbackMep = val;
                } else if ((casa === 'contadoconliqui' || casa === 'ccl') && fallbackCcl === null) {
                  fallbackCcl = val;
                }
              }
            }
          }
        }

        const bmbCclRates: number[] = [];
        const bmbMepRates: number[] = [];
        if (bmbLiveLast) {
          const liveStockMap = new Map(effectiveStocks.map((row) => [row.symbol, row]));
          const liveCedearMap = new Map(effectiveCedears.map((row) => [row.symbol, row]));
          const liveBondMap = new Map(effectiveBonds.map((row) => [row.symbol, row]));
          const adrMap = new Map(adrsRes.rows.map((row) => [row.symbol, row]));
          const usaMap = new Map(usaStocksRes.rows.map((row) => [row.symbol, row]));
          for (const meta of AR_STOCK_META) {
            const local = liveStockMap.get(meta.ticker);
            if (local?.quoteSource !== 'BMB_HOMEBROKER_BRIDGE' || local.last === null || local.last <= 0 || meta.adrTicker === undefined || meta.adrRatio === undefined) continue;
            const usd = adrMap.get(meta.adrTicker)?.last ?? usaMap.get(meta.adrTicker)?.last ?? null;
            if (usd !== null && usd > 0) bmbCclRates.push((local.last * meta.adrRatio) / usd);
          }
          for (const [ticker, info] of Object.entries(CEDEAR_RATIOS)) {
            const local = liveCedearMap.get(ticker);
            if (local?.quoteSource !== 'BMB_HOMEBROKER_BRIDGE' || local.last === null || local.last <= 0) continue;
            const usd = usaMap.get(info.usTicker)?.last ?? adrMap.get(info.usTicker)?.last ?? null;
            if (usd !== null && usd > 0) bmbCclRates.push((local.last * info.ratio) / usd);
          }
          for (const base of ['AL30', 'GD30', 'AL35', 'GD35']) {
            const ars = liveBondMap.get(base);
            if (ars?.quoteSource !== 'BMB_HOMEBROKER_BRIDGE' || ars.last === null || ars.last <= 0) continue;
            const usdC = liveBondMap.get(`${base}C`)?.last ?? null;
            const usdD = liveBondMap.get(`${base}D`)?.last ?? null;
            if (usdC !== null && usdC > 0) bmbCclRates.push(ars.last / usdC);
            if (usdD !== null && usdD > 0) bmbMepRates.push(ars.last / usdD);
          }
        }

        const matrix = this.computeMepCclMatrix({
          mepRows: mepRes.rows,
          cclRows: cclRes.rows,
          argStocks: effectiveStocks,
          usaAdrs: adrsRes.rows,
          argCedears: effectiveCedears,
          usaStocks: usaStocksRes.rows,
          argBonds: effectiveBonds,
          fallbackMep,
          fallbackCcl,
          preferredMepMedian: computeMedian(bmbMepRates),
          preferredCclMedian: computeMedian(bmbCclRates),
        });

        const useBymaFallback = bymaMerged.length === 0;
        const allStocks = this.buildStockDtos({
          argStocks: effectiveStocks,
          bymaRows: bymaMerged,
          usaAdrs: adrsRes.rows,
          usaStocks: usaStocksRes.rows,
          cclMedian: matrix.cclMedian,
          useBymaFallback,
        });

        const mervalStocks = allStocks.filter((s) => s.panel === 'Líder');
        const generalPanelStocks = allStocks.filter((s) => s.panel === 'General');
        const cedears = this.buildCedearDtos({
          argCedears: effectiveCedears,
          usaStocks: usaStocksRes.rows,
          usaAdrs: adrsRes.rows,
          cclMedian: matrix.cclMedian,
        });

        const usaMap = new Map(usaStocksRes.rows.map((u) => [u.symbol, u]));
        const spyUs = usaMap.get('SPY');
        const mepCclGapPct =
          matrix.mepMedian !== null && matrix.cclMedian !== null && matrix.mepMedian > 0
            ? ((matrix.cclMedian - matrix.mepMedian) / matrix.mepMedian) * 100
            : null;

        const globalIndicators: GlobalIndicatorDto[] = [
          {
            id: 'mep',
            label: 'Dólar MEP',
            value: sanitizeFinite(matrix.mepMedian),
            decimals: 2,
            prefix: '$ ',
            deltaPct: null,
            help: 'Paridad implícita AL30 / GD30 liquidación MEP (Data912 + ArgentinaDatos).',
            source: mepRes.rows.length > 0 ? 'DATA912' : 'ARGENTINADATOS',
          },
          {
            id: 'ccl',
            label: 'Dólar CCL',
            value: sanitizeFinite(matrix.cclMedian),
            decimals: 2,
            prefix: '$ ',
            deltaPct: null,
            help: 'Contado con Liquidación mediana sobre canasta de ADRs, Bonos y CEDEARs.',
            source: cclRes.rows.length > 0 ? 'DATA912' : 'ADR_ARBITRAGE',
          },
          {
            id: 'embi',
            label: 'Riesgo País',
            value: sanitizeFinite(macroData.variables.riesgoPaisPb),
            decimals: 0,
            suffix: ' pb',
            deltaPct: null,
            help: 'Sobretasa EMBI+ Argentina sobre Treasuries EE.UU. (ArgentinaDatos).',
            source: 'ARGENTINADATOS',
          },
          {
            id: 'badlar',
            label: 'BADLAR TNA',
            value: sanitizeFinite(macroData.variables.badlarTna),
            decimals: 2,
            suffix: ' %',
            deltaPct: null,
            help: 'Tasa BADLAR Bancos Privados en % TNA (API Oficial BCRA v4.0 id=7).',
            source: 'BCRA_V4',
          },
          {
            id: 'a3500',
            label: 'Dólar A3500',
            value: sanitizeFinite(macroData.variables.a3500),
            decimals: 2,
            prefix: '$ ',
            deltaPct: null,
            help: 'Tipo de Cambio Mayorista Com. A3500 (API Oficial BCRA v4.0 id=5).',
            source: 'BCRA_V4',
          },
          {
            id: 'spy',
            label: 'SPY US',
            value: sanitizeFinite(spyUs?.last),
            decimals: 2,
            prefix: '$ ',
            deltaPct: sanitizeFinite(spyUs?.deltaPct),
            help: 'ETF S&P 500 referencia EE.UU. vía Data912.',
            source: 'DATA912',
          },
        ];

        const data912Ok =
          liveData912Ok ||
          eodStocks.length > 0 ||
          eodCedears.length > 0 ||
          eodBonds.length > 0;
        const feedStatus: FeedStatus = bmbLiveActive
          ? 'LIVE'
          : !data912Ok && !openBymaOk
            ? 'NO_DATA'
            : openBymaOk && liveData912Ok
              ? 'LIVE'
              : liveData912Ok
                ? 'DIFERIDO_20M'
                : openBymaOk
                  ? 'PARTIAL'
                  : usedEodFallback
                    ? 'EOD_CIERRE'
                    : 'NO_DATA';

        const mktState = getArgentinaMarketState(nowSec);

        return {
          asOfUtcSec: nowSec,
          feedStatus,
          sourceMode: bmbLiveActive ? 'LIVE_BMB' : 'DATA912',
          data912Status: data912Ok ? 'OK' : 'ERROR',
          openBymaStatus: openBymaOk ? 'OK' : 'DEGRADED',
          marketState: mktState.state,
          marketStateLabel: mktState.label,
          providerErrors,
          globalIndicators,
          mepMedian: sanitizeFinite(matrix.mepMedian),
          cclMedian: sanitizeFinite(matrix.cclMedian),
          mepCclGapPct: sanitizeFinite(mepCclGapPct),
          mervalStocks,
          generalPanelStocks,
          cedears,
          mepCclMatrix: matrix.rows,
        };
      },
      { forceRefresh },
    );

    const core = cached.value as ArOverviewResponse;
    const previous = this.lastOverview;
    this.lastOverview = {
      ...core,
      ...(previous === null
        ? {}
        : {
            atmIvPct: previous.atmIvPct ?? null,
            atmIvExpiryCode: previous.atmIvExpiryCode ?? null,
            atmIvExpiryLabel: previous.atmIvExpiryLabel ?? null,
            atmIvDaysToExpiry: previous.atmIvDaysToExpiry ?? null,
            atmIvRateTnaPct: previous.atmIvRateTnaPct ?? null,
          }),
    };
    return core;
  }

  public async getOverview(forceRefresh = false): Promise<ArOverviewResponse> {
    const cached = await this.computedCache.getOrCompute(
      'ar:overview',
      async () => {
        const core = await this.getOverviewCore(forceRefresh);
        const ggalOpts =
          core.feedStatus === 'NO_DATA'
            ? null
            : await this.getOptionsChainInternal('GGAL', forceRefresh, core).catch((): null => null);
        const targetExp =
          ggalOpts?.expiries.find((e) => e.expiryCode === ggalOpts.primaryLiquidExpiryCode) ??
          ggalOpts?.expiries.find((e) => e.ivAtm !== null && Number.isFinite(e.ivAtm) && e.ivAtm > 0) ??
          ggalOpts?.expiries[0] ??
          null;
        const atmIvPct =
          targetExp?.ivAtm !== null &&
          targetExp?.ivAtm !== undefined &&
          Number.isFinite(targetExp.ivAtm) &&
          targetExp.ivAtm > 0
            ? sanitizeFinite(targetExp.ivAtm * 100)
            : null;
        return {
          ...core,
          atmIvPct,
          atmIvExpiryCode: targetExp?.expiryCode ?? null,
          atmIvExpiryLabel: targetExp?.expiryLabel ?? null,
          atmIvDaysToExpiry: targetExp?.days ?? null,
          atmIvRateTnaPct: sanitizeFinite(ggalOpts?.rateTna),
        };
      },
      { forceRefresh },
    );

    const overview = cached.value as ArOverviewResponse;
    this.lastOverview = overview;
    return this.applyCurrentBmbToOverview(overview, this.bmbClient instanceof BmbFeedAdapter ? this.bmbClient.getCachedSnapshot() : this.lastBmbSnapshot);
  }

  public async getMacro(forceRefresh = false): Promise<ArMacroResponse> {
    const cached = await this.computedCache.getOrCompute(
      'ar:macro',
      async () => {
        const nowSec = Math.floor(this.nowMsFn() / 1_000);
        const overview = await this.getOverviewCore(forceRefresh);
        const [macroData, bondsRes] = await Promise.all([
          this.fetchBcraAndArgDatos(false),
          this.getData912Live('/live/arg_bonds', false),
        ]);

        const sharedMep = overview.mepMedian ?? macroData.variables.mep;
        const sharedCcl = overview.cclMedian ?? macroData.variables.ccl;
        const sharedCanjePct =
          overview.mepCclGapPct ??
          (sharedMep !== null && sharedCcl !== null && sharedMep > 0
            ? ((sharedCcl - sharedMep) / sharedMep) * 100
            : null);
        const vars = {
          ...macroData.variables,
          mep: sharedMep,
          ccl: sharedCcl,
          canjePct: sanitizeFinite(sharedCanjePct),
        };

        const brechaPct =
          vars.ccl !== null && vars.a3500 !== null && vars.a3500 > 0
            ? ((vars.ccl - vars.a3500) / vars.a3500) * 100
            : null;
        const badlarTem =
          vars.badlarTna !== null
            ? (Math.pow(1 + vars.badlarTna / 100 / 12, 1) - 1) * 100
            : null;

        const fmtVal = (v: number | null, dec = 2, prefix = '', suffix = ''): string => {
          if (v === null || !Number.isFinite(v)) {
            return '—';
          }
          const formatted = Math.abs(v).toFixed(dec).replace('.', ',');
          return `${prefix}${v < 0 ? '-' : ''}${formatted}${suffix}`;
        };

        const cards: ArMacroCardDto[] = [
          {
            id: 'a3500',
            label: 'Dólar Mayorista A3500',
            value: fmtVal(vars.a3500, 2, '$ '),
            numericValue: vars.a3500,
            delta: brechaPct !== null ? `Brecha CCL ${fmtVal(brechaPct, 1, '', '%')}` : 'BCRA v4.0 id=5',
            deltaPct: brechaPct,
            help: 'Tipo de cambio de referencia Comunicación A3500 (BCRA v4.0).',
            source: 'BCRA_V4',
            updatedAt: macroData.updatedAt,
          },
          {
            id: 'badlar',
            label: 'BADLAR Bancos Privados',
            value: fmtVal(vars.badlarTna, 2, '', '% TNA'),
            numericValue: vars.badlarTna,
            delta: badlarTem !== null ? `TEM ${fmtVal(badlarTem, 2, '', '%')}` : 'BCRA v4.0 id=7',
            deltaPct: badlarTem,
            help: 'Tasa de interés promedio por depósitos a plazo >$1M en bancos privados.',
            source: 'BCRA_V4',
            updatedAt: macroData.updatedAt,
          },
          {
            id: 'tamar',
            label: 'TAMAR Bancos Privados',
            value: fmtVal(vars.tamarTna, 2, '', '% TNA'),
            numericValue: vars.tamarTna,
            delta: 'BCRA v4.0',
            deltaPct: null,
            help: 'Tasa mayorista de referencia (BCRA v4.0).',
            source: 'BCRA_V4',
            updatedAt: macroData.updatedAt,
          },
          {
            id: 'inf_m',
            label: 'Inflación Mensual (IPC)',
            value: fmtVal(vars.inflacionMensualPct, 1, '', '%'),
            numericValue: vars.inflacionMensualPct,
            delta: vars.inflacionInteranualPct !== null ? `YoY ${fmtVal(vars.inflacionInteranualPct, 1, '', '%')}` : 'INDEC',
            deltaPct: vars.inflacionInteranualPct,
            help: 'Variación mensual e interanual del IPC Nacional (ArgentinaDatos / INDEC).',
            source: 'ARGENTINADATOS',
            updatedAt: macroData.updatedAt,
          },
          {
            id: 'reservas',
            label: 'Reservas Internacionales',
            value: fmtVal(vars.reservasUsdM, 0, 'USD ', ' M'),
            numericValue: vars.reservasUsdM,
            delta: vars.baseMonetariaArsM !== null ? `BM $${Math.round(vars.baseMonetariaArsM).toLocaleString('es-AR')} M` : 'BCRA v4.0',
            deltaPct: null,
            help: 'Stock de reservas internacionales brutas del BCRA en millones de USD.',
            source: 'BCRA_V4',
            updatedAt: macroData.updatedAt,
          },
          {
            id: 'cer_uva',
            label: 'CER / UVA',
            value: fmtVal(vars.cer, 2),
            numericValue: vars.cer,
            delta: vars.uva !== null ? `UVA ${fmtVal(vars.uva, 2)}` : 'BCRA v4.0',
            deltaPct: null,
            help: 'Coeficiente de Estabilización de Referencia y Unidad de Valor Adquisitivo.',
            source: 'BCRA_V4',
            updatedAt: macroData.updatedAt,
          },
          {
            id: 'riesgo_pais',
            label: 'Riesgo País (EMBI+)',
            value: fmtVal(vars.riesgoPaisPb, 0, '', ' pb'),
            numericValue: vars.riesgoPaisPb,
            delta: 'Spread soberano',
            deltaPct: null,
            help: 'Diferencial de tasa de bonos soberanos argentinos frente al Tesoro de EE.UU.',
            source: 'ARGENTINADATOS',
            updatedAt: macroData.updatedAt,
          },
          {
            id: 'mep_ccl',
            label: 'CCL / MEP Implícito',
            value: fmtVal(vars.ccl, 2, '$ '),
            numericValue: vars.ccl,
            delta: vars.mep !== null ? `MEP $${fmtVal(vars.mep, 2)}` : 'Arbitraje vivo',
            deltaPct: overview.mepCclGapPct,
            help: 'Mediana en vivo de Contado con Liquidación y Dólar Bolsa.',
            source: 'DATA912',
            updatedAt: macroData.updatedAt,
          },
          ...(vars.plazoFijoTna != null
            ? [
                {
                  id: 'plazo_fijo',
                  label: 'Plazo Fijo Minorista',
                  value: fmtVal(vars.plazoFijoTna, 2, '', '% TNA'),
                  numericValue: vars.plazoFijoTna,
                  delta: 'Mediana bancos',
                  deltaPct: null,
                  help: 'Mediana TNA Plazo Fijo minorista 30 días en bancos argentinos (ArgentinaDatos).',
                  source: 'ARGENTINADATOS',
                  updatedAt: macroData.updatedAt,
                },
              ]
            : []),
        ];

        let effectiveBondRows = bondsRes.rows;
        if (!hasPositiveLast(effectiveBondRows)) {
          const eodBonds = await this.populateEodRowsFromHistorical(
            'bonds',
            SOVEREIGN_BONDS.flatMap((b) =>
              (b.currency ?? 'USD') === 'USD' ? [b.baseTicker, `${b.baseTicker}D`] : [b.baseTicker],
            ),
            forceRefresh,
          );
          if (eodBonds.length > 0) {
            effectiveBondRows = eodBonds;
          }
        }
        const sovereignCurve = this.buildSovereignBonds(
          effectiveBondRows,
          vars.mep,
          vars.ccl,
          nowSec,
          vars.cer,
        );
        const arsRateSource =
          vars.tamarTna !== null
            ? 'BCRA TAMAR'
            : vars.badlarTna !== null
              ? 'BCRA BADLAR'
              : vars.tpmTna !== null
                ? 'BCRA TPM'
                : 'ArgentinaDatos PF';
        const arsRateTnaPct = vars.tamarTna ?? vars.badlarTna ?? vars.tpmTna ?? vars.plazoFijoTna;
        const syntheticFutures = computeSyntheticUsdFuturesCurve({
          nowSec,
          a3500: vars.a3500,
          arsRateTnaPct,
          arsRateSource,
          usdRatePct: vars.sofrUsdTna ?? null,
          usdRateSource: 'NY Fed SOFR',
          ccl: vars.ccl,
        });

        const dlrRes = await this.primaryClient.getDlrFuturesAndDerivatives({
          asOfUtcSec: nowSec,
          a3500: vars.a3500,
          forceRefresh,
        });

        const providerErrors = [
          ...macroData.errors,
          ...overview.providerErrors,
          ...(dlrRes.error !== null ? [dlrRes.error] : []),
        ];
        const hasAnyMacro = cards.some((c) => c.numericValue !== null) || dlrRes.contracts.length > 0;
        const feedStatus: FeedStatus = !hasAnyMacro
          ? 'NO_DATA'
          : sovereignCurve.length > 0 && macroData.errors.length === 0
            ? overview.feedStatus
            : 'PARTIAL';

        return {
          asOfUtcSec: nowSec,
          feedStatus,
          providerErrors,
          cards,
          variables: vars,
          dolares: macroData.dolares,
          sovereignCurve,
          syntheticFutures,
          rofxFutures: dlrRes.contracts,
          rofxSpotA3500: dlrRes.spotUsed,
          rofxSpotSource: dlrRes.spotSource,
        };
      },
      { forceRefresh },
    );

    const macro = cached.value as ArMacroResponse;
    this.primaryClient.setReferenceSpotA3500(macro.rofxSpotA3500 ?? null);
    const liveFutures = this.currentLiveDlrFutures();
    const mergedMacro =
      liveFutures.length > 0
        ? {
            ...macro,
            rofxFutures: mergeDlrContracts(macro.rofxFutures ?? [], liveFutures),
          }
        : macro;
    this.lastMacro = mergedMacro;
    return mergedMacro;
  }

  public async getMonitoring(
    panel: ArMonitoringResponse['panel'] = 'acciones',
    forceRefresh = false,
  ): Promise<ArMonitoringResponse> {
    const nowSec = Math.floor(this.nowMsFn() / 1_000);
    const [overview, bondsRes, notesRes, corpRes, macroData] = await Promise.all([
      this.getOverviewCore(forceRefresh),
      this.getData912Live('/live/arg_bonds', forceRefresh),
      this.getData912Live('/live/arg_notes', forceRefresh),
      this.getData912Live('/live/arg_corp', forceRefresh),
      this.fetchBcraAndArgDatos(forceRefresh),
    ]);

    const bmbSnap = await this.bmbClient.getSnapshot(
      undefined,
      macroData.variables.badlarTna,
      forceRefresh,
    );
    this.lastBmbSnapshot = bmbSnap;

    const monitoringBondUniverse = new Set(
      SOVEREIGN_BONDS.flatMap((bond) => [bond.baseTicker, `${bond.baseTicker}D`, `${bond.baseTicker}C`]),
    );
    let effectiveBondRows = mergeBmbNormalizedRows(bondsRes.rows, bmbSnap, nowSec, monitoringBondUniverse).rows;
    if (!hasPositiveLast(effectiveBondRows)) {
      const eodBonds = await this.populateEodRowsFromHistorical(
        'bonds',
        SOVEREIGN_BONDS.flatMap((b) =>
          (b.currency ?? 'USD') === 'USD' ? [b.baseTicker, `${b.baseTicker}D`] : [b.baseTicker],
        ),
        forceRefresh,
      );
      if (eodBonds.length > 0) {
        effectiveBondRows = eodBonds;
      }
    }

    const bonds = this.buildSovereignBonds(
      effectiveBondRows,
      overview.mepMedian,
      overview.cclMedian,
      nowSec,
      macroData.variables.cer,
    );
    const mapNoteOrCorp = (rows: readonly NormalizedQuoteRow[], kind: ArNoteOrCorpDto['kind']): readonly ArNoteOrCorpDto[] =>
      rows.slice(0, 60).map((r) => ({
        ticker: r.symbol,
        name: kind === 'LECAP_BONCAP' ? `Letra/Bono ${r.symbol}` : `ON ${r.symbol}`,
        kind,
        price: sanitizeFinite(r.last),
        bid: sanitizeFinite(r.bid),
        ask: sanitizeFinite(r.ask),
        deltaPct: sanitizeFinite(r.deltaPct),
        volumeM: r.volumeArs !== null ? sanitizeFinite(r.volumeArs / 1_000_000) : null,
        source: r.quoteSource === 'BMB_HOMEBROKER_BRIDGE' ? 'BMB_HOMEBROKER' : 'DATA912',
        quoteAsOfUtcSec: r.quoteAsOfUtcSec ?? null,
      }));

    const notes = mapNoteOrCorp(
      mergeBmbNormalizedRows(notesRes.rows, bmbSnap, nowSec, new Set(notesRes.rows.map((row) => row.symbol))).rows,
      'LECAP_BONCAP',
    );
    const corps = mapNoteOrCorp(
      mergeBmbNormalizedRows(corpRes.rows, bmbSnap, nowSec, new Set(corpRes.rows.map((row) => row.symbol))).rows,
      'ON_CORP',
    );
    const busCaucionesMonitoring = this.realtimeBus.getCauciones();
    const primaryCaucionesMonitoring: readonly ArCaucionCurveRowDto[] = busCaucionesMonitoring
      .filter((row) => row.source === 'PRIMARY_ECO_WS')
      .map((row) => ({
        termDays: row.termDays,
        label: `${String(row.termDays)} días`,
        currency: row.currency,
        tnaWeighted: row.tnaWeighted,
        teaEffective: row.tnaWeighted !== null ? sanitizeFinite(computeCaucionTeaEffectivePct(row.tnaWeighted, row.termDays)) : null,
        bidTna: row.bidTna,
        askTna: row.askTna,
        volumeArs: row.turnoverArs,
        spreadVsBadlarBps: null,
        referenceInstrument: row.symbol,
        originLabel: 'Puntas/trades vivos Eco Primary XOMS',
        source: 'PRIMARY_ECO_WS',
        asOfUtcSec: row.asOfUtcSec,
      }));
    const caucionesCurve = buildCaucionesLiquidityCurve({
      bmbSnapshot: bmbSnap,
      tpmTna: macroData.variables.tpmTna,
      badlarTna: macroData.variables.badlarTna,
      tamarTna: macroData.variables.tamarTna,
      plazoFijoTna: macroData.variables.plazoFijoTna,
      notes,
      nowSec,
    });
    const providerErrors = [
      ...overview.providerErrors,
      ...[bondsRes.error, notesRes.error, corpRes.error].filter((e): e is string => e !== null),
    ];

    let enrichedMerval = overview.mervalStocks;
    let enrichedGeneral = overview.generalPanelStocks;
    let enrichedCedears = overview.cedears;
    let arPanelAnalytics: EquityPanelAnalyticsDto | null =
      (this.computedCache.peek('ar:panel:acciones:analytics')?.value as
        | { readonly analytics?: EquityPanelAnalyticsDto }
        | undefined)?.analytics ??
      null;
    let usEquityPanel: EquityPanelAnalyticsDto | null = null;

    if (panel === 'acciones') {
      const arPanelRes = await this.buildArPanelAnalytics({
        overview,
        argStocks: (await this.getData912Live('/live/arg_stocks', forceRefresh)).rows,
        nowSec,
        forceRefresh,
      });
      enrichedMerval = arPanelRes.mervalStocks;
      enrichedGeneral = arPanelRes.generalPanelStocks;
      arPanelAnalytics = arPanelRes.analytics;
      providerErrors.push(...arPanelRes.errors);
    } else if (panel === 'cedears') {
      const cedEnrichment = await this.enrichCedearsAndAdrsMonitoring({
        overview,
        nowSec,
        forceRefresh,
      });
      enrichedCedears = cedEnrichment.cedears;
      enrichedMerval = cedEnrichment.enrichedMervalStocks;
      usEquityPanel = cedEnrichment.usEquityPanel;
      providerErrors.push(...cedEnrichment.errors);
    }

    const response: ArMonitoringResponse = {
      asOfUtcSec: nowSec,
      feedStatus: overview.feedStatus,
      sourceMode: overview.sourceMode ?? (caucionesCurve.status === 'LIVE_BMB' ? 'LIVE_BMB' : 'DATA912'),
      panel,
      providerErrors,
      stocks: enrichedMerval,
      generalPanel: enrichedGeneral,
      bonds,
      cedears: enrichedCedears,
      notes,
      corps,
      mepMedian: overview.mepMedian,
      cclMedian: overview.cclMedian,
      badlarTna: macroData.variables.badlarTna,
      cauciones: primaryCaucionesMonitoring.length > 0 ? primaryCaucionesMonitoring : caucionesCurve.rows,
      caucionesStatus:
        primaryCaucionesMonitoring.length > 0
          ? 'LIVE_PRIMARY'
          : caucionesCurve.status,
      bmbHealth: bmbSnap.health,
      arPanelAnalytics,
      usEquityPanel,
    };
    this.lastMonitoring = response;
    this.lastOverview = overview;
    return response;
  }

  private recordAndResolvePriorSmile(
    cacheKey: string,
    dateKey: string,
    atmIvPct: number,
    compositeOtmPoints: readonly CompositeOtmSmilePoint[],
  ): VolAnalyticsPriorSmileSnapshot | null {
    if (!Number.isFinite(atmIvPct) || atmIvPct <= 0 || compositeOtmPoints.length < 2) {
      return null;
    }
    const existing = this.priorSmileCache.get(cacheKey) ?? [];
    const filtered = existing.filter((e) => e.dateKey !== dateKey);
    const updated = [...filtered, { dateKey, atmIvPct, compositeOtmPoints }]
      .sort((a, b) => a.dateKey.localeCompare(b.dateKey))
      .slice(-20);
    this.priorSmileCache.set(cacheKey, updated);

    const lastIdx = updated.length - 1;
    let bestCandidate: VolAnalyticsPriorSmileSnapshot | null = null;
    let bestDistFromTarget = Number.POSITIVE_INFINITY;
    for (let i = 0; i < lastIdx; i += 1) {
      const ago = lastIdx - i;
      if (ago < 5 || ago > 10) continue;
      const dist = Math.abs(ago - 7);
      const entry = updated[i];
      if (entry !== undefined && dist < bestDistFromTarget) {
        bestDistFromTarget = dist;
        bestCandidate = {
          dateKey: entry.dateKey,
          tradingDaysAgo: ago,
          atmIvPct: entry.atmIvPct,
          compositeOtmPoints: entry.compositeOtmPoints,
        };
      }
    }
    return bestCandidate;
  }

  private pickArCaucionBenchmarkTea(params: {
    readonly bmbSnap: BmbBridgeSnapshotDto | null;
    readonly macroVars: ArMacroResponse['variables'];
    readonly continuousRate: number | null;
    readonly targetDays: number;
  }): { readonly teaPct: number; readonly label: string } {
    const { bmbSnap, macroVars, continuousRate, targetDays } = params;
    if (bmbSnap !== null && (bmbSnap.health.status === 'READY' || bmbSnap.health.status === 'CONNECTED_L2') && bmbSnap.health.connected && bmbSnap.cauciones.length > 0) {
      const valid = bmbSnap.cauciones
        .filter(
          (c) =>
            c.currency === 'ARS' &&
            c.termDays > 0 &&
            ((c.teaEffective !== null && Number.isFinite(c.teaEffective)) ||
              (c.tnaWeighted !== null && c.tnaWeighted > 0)),
        )
        .slice()
        .sort((a, b) => Math.abs(a.termDays - targetDays) - Math.abs(b.termDays - targetDays));
      const best = valid[0];
      if (best !== undefined) {
        const tea =
          best.teaEffective !== null && Number.isFinite(best.teaEffective)
            ? best.teaEffective
            : best.tnaWeighted !== null
              ? computeCaucionTeaEffectivePct(best.tnaWeighted, best.termDays)
              : Number.NaN;
        if (Number.isFinite(tea)) {
          return { teaPct: tea, label: `Caución ${String(best.termDays)}d` };
        }
      }
    }
    const bcraRefTna =
      macroVars.tamarTna ?? macroVars.badlarTna ?? macroVars.tpmTna ?? macroVars.plazoFijoTna;
    const bcraSourceName =
      macroVars.tamarTna !== null
        ? 'Caución Ref. TAMAR'
        : macroVars.badlarTna !== null
          ? 'Caución Ref. BADLAR'
          : macroVars.tpmTna !== null
            ? 'Caución Ref. TPM'
            : 'Caución Ref. BCRA';
    if (bcraRefTna !== null && Number.isFinite(bcraRefTna) && bcraRefTna > 0) {
      const daysClamped = Math.max(1, Math.min(90, Math.round(targetDays)));
      const tea = computeCaucionTeaEffectivePct(bcraRefTna, daysClamped);
      if (Number.isFinite(tea)) {
        return { teaPct: tea, label: bcraSourceName };
      }
    }
    if (continuousRate !== null && Number.isFinite(continuousRate)) {
      const tea = Math.expm1(continuousRate) * 100;
      if (Number.isFinite(tea)) {
        return { teaPct: tea, label: 'Tasa Libre BYMA' };
      }
    }
    return { teaPct: Number.NaN, label: 'Caución / BCRA' };
  }

  private buildArVolAnalyticsSuite(params: {
    readonly underlying: string;
    readonly spot: number | null;
    readonly spotBid: number | null;
    readonly spotAsk: number | null;
    readonly evalRate: number;
    readonly continuousRate: number | null;
    readonly dividendYield: number;
    readonly nowSec: number;
    readonly closedBars: readonly Bar[];
    readonly expiries: readonly ArOptionExpiryDto[];
    readonly termExpiries: readonly ArOptionExpiryDto[];
    readonly primaryExp: ArOptionExpiryDto | undefined;
    readonly qDistByExpiry: ReadonlyMap<string, RiskNeutralDistributionResult | null>;
    readonly bmbSnap: BmbBridgeSnapshotDto | null;
    readonly macroVars: ArMacroResponse['variables'];
    readonly adrSnap: TerminalSnapshotResponse | null;
    readonly adrBars: readonly Bar[];
    readonly adrTicker: string | null;
    readonly adrRatio: number | null;
  }): VolAnalyticsSuiteResult | null {
    const {
      underlying,
      spot,
      spotBid,
      spotAsk,
      evalRate,
      continuousRate,
      dividendYield,
      nowSec,
      closedBars,
      expiries,
      termExpiries,
      primaryExp,
      qDistByExpiry,
      bmbSnap,
      macroVars,
      adrSnap,
      adrBars,
      adrTicker,
      adrRatio,
    } = params;

    if (spot === null || spot <= 0) {
      return null;
    }

    const histInputs: HistoricalDailyBarInput[] = closedBars.map((b) => ({
      time: b.time,
      close: b.close,
      open: b.open,
      high: b.high,
      low: b.low,
    }));

    const primaryIvAtmPct =
      primaryExp?.ivAtm !== null && primaryExp?.ivAtm !== undefined && primaryExp.ivAtm > 0
        ? primaryExp.ivAtm * 100
        : null;

    const historicalConditional = computeHistoricalVolConditionalTable(
      {
        bars: histInputs,
        currentIvAtmPct: primaryIvAtmPct,
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

    const dateKeyUtc = new Date(nowSec * 1_000).toISOString().slice(0, 10);
    const rateForSmile = Number.isFinite(evalRate) ? evalRate : 0;

    const smileOtmMap = new Map<string, SeparatedSmileResult>();
    const smileAllMap = new Map<string, SeparatedSmileResult>();
    const expiriesByCode: Record<string, VolAnalyticsExpirySuiteResult> = {};

    for (const exp of expiries) {
      const tExp = Math.max(1 / 365, exp.days / 365);
      const contractsInput = [...exp.calls, ...exp.puts].map((c) => ({
        strike: c.strike,
        contractType: c.contractType,
        iv: c.iv,
        bid: c.bid,
        ask: c.ask,
        last: c.last,
        mid: c.mark,
        volume: c.volume,
        openInterest: c.openInterest,
        delta: c.delta,
      }));

      const smileOtmOnly = buildSeparatedOtmSmile(
        {
          spot,
          timeToExpiryYears: tExp,
          daysToExpiry: exp.days,
          rate: rateForSmile,
          dividendYield,
          contracts: contractsInput,
        },
        { onlyOtm: true },
      );
      const smileAll = buildSeparatedOtmSmile(
        {
          spot,
          timeToExpiryYears: tExp,
          daysToExpiry: exp.days,
          rate: rateForSmile,
          dividendYield,
          contracts: contractsInput,
        },
        { onlyOtm: false },
      );
      smileOtmMap.set(exp.expiryCode, smileOtmOnly);
      smileAllMap.set(exp.expiryCode, smileAll);

      const priorSmile = this.recordAndResolvePriorSmile(
        `${underlying}:${exp.expiryCode}`,
        dateKeyUtc,
        smileOtmOnly.atmIvPct,
        smileOtmOnly.compositeOtmPoints,
      );

      const atmIvForCone =
        Number.isFinite(smileOtmOnly.atmIvPct) && smileOtmOnly.atmIvPct > 0
          ? smileOtmOnly.atmIvPct
          : exp.ivAtm !== null && exp.ivAtm > 0
            ? exp.ivAtm * 100
            : Number.NaN;

      const qDist = qDistByExpiry.get(exp.expiryCode) ?? null;
      const expectedCone = buildExpectedConeAndLognormalSummary({
        spot,
        atmIvPct: atmIvForCone,
        daysToExpiry: exp.days,
        rate: rateForSmile,
        dividendYield,
        ...(qDist !== null && qDist.status === 'OK'
          ? {
              qNodes: qDist.nodes.map((n) => ({
                strike: n.strike,
                densityQ: n.densityQ,
                probAboveQ: n.probAboveQ,
              })),
            }
          : {}),
      });

      const callByK = new Map(exp.calls.map((c) => [c.strike, c]));
      const putByK = new Map(exp.puts.map((p) => [p.strike, p]));
      const parityPairs = exp.strikes.map((k) => {
        const c = callByK.get(k);
        const p = putByK.get(k);
        return {
          strike: k,
          callBid: c?.bid ?? null,
          callAsk: c?.ask ?? null,
          callMid: c?.mark ?? c?.last ?? null,
          callIvPct: c?.iv !== null && c?.iv !== undefined && c.iv > 0 ? c.iv * 100 : null,
          putBid: p?.bid ?? null,
          putAsk: p?.ask ?? null,
          putMid: p?.mark ?? p?.last ?? null,
          putIvPct: p?.iv !== null && p?.iv !== undefined && p.iv > 0 ? p.iv * 100 : null,
          callVolume: c?.volume ?? null,
          putVolume: p?.volume ?? null,
        };
      });

      const expBench = this.pickArCaucionBenchmarkTea({
        bmbSnap,
        macroVars,
        continuousRate,
        targetDays: exp.days,
      });

      const parity = computeParityAndSyntheticRatesByStrike({
        spotMid: spot,
        spotBid,
        spotAsk,
        daysToExpiry: exp.days,
        dividendYield,
        benchmarkTeaPct: Number.isFinite(expBench.teaPct) ? expBench.teaPct : null,
        benchmarkLabel: expBench.label,
        pairs: parityPairs,
      });

      const ratioStrikes = exp.strikes.map((k) => {
        const c = callByK.get(k);
        const p = putByK.get(k);
        return {
          strike: k,
          callBid: c?.bid ?? null,
          callAsk: c?.ask ?? null,
          callMid: c?.mark ?? c?.last ?? null,
          putBid: p?.bid ?? null,
          putAsk: p?.ask ?? null,
          putMid: p?.mark ?? p?.last ?? null,
        };
      });

      const ratioAtmIvPct =
        Number.isFinite(smileOtmOnly.atmIvPct) && smileOtmOnly.atmIvPct > 0
          ? smileOtmOnly.atmIvPct
          : smileAll.atmIvPct;
      const ratiosAndStructures = computeRatiosAndStructureCosts({
        spot,
        daysToExpiry: exp.days,
        rate: rateForSmile,
        dividendYield,
        strikes: ratioStrikes,
        historicalVolPctSeries: histVolSeriesForCost,
        ...(Number.isFinite(ratioAtmIvPct) && ratioAtmIvPct > 0
          ? { ivAtmDec: ratioAtmIvPct / 100 }
          : {}),
      });

      const activeExpiryVrp = computeActiveExpiryVrpAndRegime({
        expiryCode: exp.expiryCode,
        daysToExpiry: exp.days,
        ivAtmActiveExpiryPct: Number.isFinite(smileOtmOnly.atmIvPct)
          ? smileOtmOnly.atmIvPct
          : null,
        sameExpiryFallbackIvAtmPct: Number.isFinite(smileAll.atmIvPct)
          ? smileAll.atmIvPct
          : exp.ivAtm !== null && exp.ivAtm > 0
            ? exp.ivAtm * 100
            : null,
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

      expiriesByCode[exp.expiryCode] = {
        expiryCode: exp.expiryCode,
        expirationDate: exp.expirationDate,
        daysToExpiry: exp.days,
        smileOtmOnly,
        smileAll,
        priorSmile,
        expectedCone,
        parity,
        ratiosAndStructures,
        activeExpiryVrp,
      };
    }

    const matrixExps = termExpiries.length > 0 ? termExpiries : expiries;
    const moneynessMatrixOtm = buildNormalizedMoneynessMatrix(
      matrixExps.map((e) => ({
        expiryCode: e.expiryCode,
        expiryLabel: e.expiryLabel,
        daysToExpiry: e.days,
        compositeOtmPoints: smileOtmMap.get(e.expiryCode)?.compositeOtmPoints ?? [],
        fallbackAtmIvPct: e.ivAtm !== null && e.ivAtm > 0 ? e.ivAtm * 100 : null,
      })),
    );
    const moneynessMatrixAll = buildNormalizedMoneynessMatrix(
      matrixExps.map((e) => ({
        expiryCode: e.expiryCode,
        expiryLabel: e.expiryLabel,
        daysToExpiry: e.days,
        compositeOtmPoints: smileAllMap.get(e.expiryCode)?.compositeOtmPoints ?? [],
        fallbackAtmIvPct: e.ivAtm !== null && e.ivAtm > 0 ? e.ivAtm * 100 : null,
      })),
    );

    const hasDualAdr = DUAL_ADR_OPTIONS_TICKERS.has(underlying) && adrTicker !== null;
    let dualSurface: VolAnalyticsSuiteResult['dualSurface'] = null;
    if (
      hasDualAdr &&
      adrRatio !== null &&
      adrRatio > 0 &&
      primaryExp !== undefined &&
      adrSnap !== null &&
      adrSnap.volSurfaceSummary !== null
    ) {
      const adrSpotUsd = adrSnap.envelope.snapshot.metrics.spot;
      const opraSlices = adrSnap.volSurfaceSummary.slices;
      const matchedOpraSlice =
        opraSlices.length > 0
          ? opraSlices
              .slice()
              .sort(
                (a, b) =>
                  Math.abs(a.timeToExpiryDays - primaryExp.days) -
                  Math.abs(b.timeToExpiryDays - primaryExp.days),
              )[0] ?? null
          : adrSnap.volSurfaceSummary.frontSlice;
      if (adrSpotUsd !== null && adrSpotUsd > 0 && matchedOpraSlice !== null) {
        const opraContracts = adrSnap.volSurfaceSummary.contracts.filter(
          (c) => c.expirationDate === matchedOpraSlice.expirationDate,
        );
        const opraSmile = buildSeparatedOtmSmile(
          {
            spot: adrSpotUsd,
            timeToExpiryYears: Math.max(1 / 365, matchedOpraSlice.timeToExpiryYears),
            daysToExpiry: Math.max(1, matchedOpraSlice.timeToExpiryDays),
            rate: matchedOpraSlice.rate ?? 0.045,
            dividendYield: matchedOpraSlice.dividendYield ?? 0,
            contracts: opraContracts.map((c) => ({
              strike: c.strike,
              contractType: c.contractType,
              iv: c.ownIv ?? c.providerIv,
              bid: c.bid,
              ask: c.ask,
              last: c.lastPrice,
              mid: c.mid,
              volume: c.volume,
              openInterest: c.openInterest,
              delta: c.delta,
            })),
          },
          { onlyOtm: true },
        );
        const bymaSmilePts = smileOtmMap.get(primaryExp.expiryCode)?.compositeOtmPoints ?? [];
        const cclStats = computeCclVolAndAdrCorrelation({
          arBars: histInputs,
          adrBars: adrBars.map((b) => ({ time: b.time, close: b.close })),
          adrRatio,
        });
        const cclImplicit = (spot * adrRatio) / adrSpotUsd;
        dualSurface = computeDualBymaVsOpraSurface({
          arUnderlying: underlying,
          adrTicker,
          adrRatio,
          bymaSpotArs: spot,
          adrSpotUsd,
          cclImplicit,
          bymaExpiryCode: primaryExp.expiryCode,
          bymaDays: primaryExp.days,
          opraExpiryDate: matchedOpraSlice.expirationDate,
          opraDays: matchedOpraSlice.timeToExpiryDays,
          bymaCompositeOtmPoints: bymaSmilePts,
          opraCompositeOtmPoints: opraSmile.compositeOtmPoints,
          cclAnnualVolPct: cclStats.cclAnnualVolPct,
          corrAdrCcl: cclStats.corrAdrCcl,
        });
      }
    }

    const frontBench = this.pickArCaucionBenchmarkTea({
      bmbSnap,
      macroVars,
      continuousRate,
      targetDays: primaryExp?.days ?? 30,
    });

    return {
      status:
        historicalConditional.status === 'OK' || expiries.length > 0 ? 'OK' : 'NO_DATA',
      market: 'BYMA',
      underlying,
      spot,
      rateContinuous: evalRate,
      rateTeaPct: frontBench.teaPct,
      benchmarkLabel: frontBench.label,
      dividendYield,
      activeExpiryCode: primaryExp?.expiryCode ?? null,
      hasDualAdr,
      nonDualMessage: hasDualAdr
        ? null
        : 'Activo sin ADR dual — Ver estructura completa en Tab 2',
      moneynessMatrixOtm,
      moneynessMatrixAll,
      historicalConditional,
      rvWindows,
      dualSurface,
      expiriesByCode,
    };
  }

  private resolveEffectiveUsRuntime(): UsRuntimeAdapter | null {
    if (this.usRuntime !== null) {
      return this.usRuntime;
    }
    if (!this.allowSharedUsRuntime) {
      return null;
    }
    const shared = getSharedMarketRuntime();
    if (shared !== null) {
      return shared;
    }
    this.lazyUsRuntime ??= new MarketRuntime({ enableWs: false, secrets: this.secrets });
    return this.lazyUsRuntime;
  }

  /** Pieza 40: serie histórica MERV de IOL; fallback explícito al panel EW. */
  private async getIolMervBenchmarkBars(
    forceRefresh = false,
  ): Promise<{ readonly bars: readonly Bar[]; readonly error: string | null }> {
    const cached = await this.computedCache.getOrCompute(
      'iol:merv:benchmark',
      async () => {
        try {
          const bars = await this.iolClient.getInstrumentHistory('MERV', {
            market: 'bCBA',
            calendarDays: 400,
          });
          if (bars.length < 60) {
            return {
              bars: [] as readonly Bar[],
              error: 'IOL MERV history returned fewer than 60 sessions',
            };
          }
          return { bars, error: null };
        } catch (err: unknown) {
          return {
            bars: [] as readonly Bar[],
            error: redactSecrets(err instanceof Error ? err.message : String(err), this.secrets),
          };
        }
      },
      { forceRefresh, ttlMs: AR_HIST_WEEKEND_TTL_MS },
    );
    return cached.value as { readonly bars: readonly Bar[]; readonly error: string | null };
  }

  private async buildArPanelAnalytics(params: {
    readonly overview: ArOverviewResponse;
    readonly argStocks: readonly NormalizedQuoteRow[];
    readonly nowSec: number;
    readonly forceRefresh: boolean;
  }): Promise<{
    readonly mervalStocks: readonly ArStockDto[];
    readonly generalPanelStocks: readonly ArStockDto[];
    readonly analytics: EquityPanelAnalyticsDto;
    readonly errors: readonly string[];
  }> {
    const cached = await this.computedCache.getOrCompute(
      'ar:panel:acciones:analytics',
      async () => {
        const errors: string[] = [];
        const rawByTicker = new Map(params.argStocks.map((r) => [r.symbol, r]));
        const histEntries = await mapWithConcurrencyLimit(
          AR_STOCK_META,
          AR_PANEL_CONCURRENCY_LIMIT,
          async (meta) => {
            const res = await this.getData912History('stocks', meta.ticker, params.forceRefresh);
            const closedBars = normalizeClosedDailyBarsForEngines(res.bars, params.nowSec).slice(
              -AR_PANEL_MAX_CLOSED_BARS,
            );
            return [meta.ticker, { bars: closedBars, error: res.error }] as const;
          },
        );
        const barsByTicker = new Map<string, readonly Bar[]>();
        const liderSeries: (readonly Bar[])[] = [];
        for (const [ticker, res] of histEntries) {
          barsByTicker.set(ticker, res.bars);
          if (res.error !== null && res.bars.length === 0) {
            errors.push(`Data912 hist ${ticker}: ${res.error}`);
          }
          if (STOCK_META_MAP.get(ticker)?.panel === 'Líder' && res.bars.length >= 2) {
            liderSeries.push(res.bars);
          }
        }
        const mervRes = await this.getIolMervBenchmarkBars(params.forceRefresh);
        if (mervRes.error !== null) {
          errors.push(mervRes.error);
        }
        const benchmarkBars =
          mervRes.bars.length > 0
            ? mervRes.bars
            : this.buildEqualWeightIndexBars(liderSeries);
        const benchmarkSymbol = mervRes.bars.length > 0 ? 'MERV' : 'PANEL_LIDER_EW';

        const enrichList = (list: readonly ArStockDto[]): readonly ArStockDto[] =>
          list.map((dto) => {
            const bars = barsByTicker.get(dto.ticker) ?? [];
            const raw = rawByTicker.get(dto.ticker);
            const metrics = computeEquityRiskAndReturnMetrics({
              bars,
              benchmarkBars,
              liveLast: dto.last,
              livePrevClose: dto.prevClose,
              liveLow: dto.low,
              liveHigh: dto.high,
              liveChangePct: dto.deltaPct,
              liveVolumeM: dto.volumeM,
              asOfUtcSec: params.nowSec,
            });
            const lastBar = bars[bars.length - 1];
            const todayShares =
              raw?.nominalVol !== null && raw?.nominalVol !== undefined && raw.nominalVol > 0
                ? raw.nominalVol
                : dto.volumeM !== null && dto.volumeM > 0 && dto.last !== null && dto.last > 0
                  ? (dto.volumeM * 1_000_000) / dto.last
                  : lastBar !== undefined && lastBar.volume > 0
                    ? lastBar.volume
                    : null;
            const volMultiple =
              this.computeRelativeVolumeMultiple({
                todayShares,
                bars,
                asOfUtcSec: params.nowSec,
              }) ?? dto.volMultiple;
            return {
              ...dto,
              dayRangePos: metrics.dayRangePos,
              volMultiple,
              return30dPct: metrics.return30dPct,
              returnYtdOr252dPct: metrics.returnYtdOr252dPct,
              realizedVol30dPct: metrics.realizedVol30dPct,
              beta: metrics.beta,
              avgVolume40dM: metrics.avgVolume40dM,
            };
          });

        const enrichedMerval = enrichList(params.overview.mervalStocks);
        const enrichedGeneral = enrichList(params.overview.generalPanelStocks);
        const combined = [...enrichedMerval, ...enrichedGeneral];

        const panelRows: EquityPanelRowDto[] = combined.map((s) => ({
          symbol: s.ticker,
          name: s.name,
          sector: s.sector,
          panel: s.panel === 'Líder' ? 'Líder' : 'General',
          color: s.color,
          last: s.last,
          prevClose: s.prevClose,
          dayLow: s.low,
          dayHigh: s.high,
          dayRangePos: s.dayRangePos ?? null,
          volumeM: s.volumeM,
          return1dPct: s.deltaPct,
          return30dPct: s.return30dPct ?? null,
          returnYtdOr252dPct: s.returnYtdOr252dPct ?? null,
          realizedVol30dPct: s.realizedVol30dPct ?? null,
          beta: s.beta ?? null,
          avgVolume40dM: s.avgVolume40dM ?? null,
          iv30d: s.iv30d ?? null,
          hasUsOptions: s.hasUsOptions ?? false,
        }));

        const panelSeries = computePanelVolumeAndVolSeries({
          items: combined.map((s) => ({
            symbol: s.ticker,
            name: s.name,
            color: s.color,
            bars: barsByTicker.get(s.ticker) ?? [],
          })),
          asOfUtcSec: params.nowSec,
          maxVolumeDays: 40,
          rollingVolWindow: 20,
        });

        const topGainers = [...panelRows]
          .filter((r) => r.return1dPct !== null && r.return1dPct > 0)
          .sort((a, b) => (b.return1dPct ?? 0) - (a.return1dPct ?? 0))
          .slice(0, 8);
        const topLosers = [...panelRows]
          .filter((r) => r.return1dPct !== null && r.return1dPct < 0)
          .sort((a, b) => (a.return1dPct ?? 0) - (b.return1dPct ?? 0))
          .slice(0, 8);

        return {
          mervalStocks: enrichedMerval,
          generalPanelStocks: enrichedGeneral,
          analytics: {
            asOfUtcSec: params.nowSec,
            benchmarkSymbol,
            panelLabel: 'BYMA · Panel Líder y General (Data912)',
            currency: 'ARS' as const,
            rows: panelRows,
            panelVolume40d: panelSeries.panelVolume40d,
            volumeAvg40dM: panelSeries.volumeAvg40dM,
            volumeShareBreakdown: panelSeries.volumeShareBreakdown,
            panelVolHistory: panelSeries.panelVolHistory,
            topGainers,
            topLosers,
            errors,
          },
          errors,
        };
      },
      { forceRefresh: params.forceRefresh },
    );

    return cached.value as {
      readonly mervalStocks: readonly ArStockDto[];
      readonly generalPanelStocks: readonly ArStockDto[];
      readonly analytics: EquityPanelAnalyticsDto;
      readonly errors: readonly string[];
    };
  }

  private async enrichCedearsAndAdrsMonitoring(params: {
    readonly overview: ArOverviewResponse;
    readonly nowSec: number;
    readonly forceRefresh: boolean;
  }): Promise<{
    readonly cedears: readonly ArStockDto[];
    readonly enrichedMervalStocks: readonly ArStockDto[];
    readonly usEquityPanel: EquityPanelAnalyticsDto | null;
    readonly errors: readonly string[];
  }> {
    const errors: string[] = [];
    const usRt = this.resolveEffectiveUsRuntime();

    let usEquityPanel: EquityPanelAnalyticsDto | null = null;
    if (usRt?.getUsEquityPanelAnalytics !== undefined) {
      try {
        usEquityPanel = await usRt.getUsEquityPanelAnalytics(params.forceRefresh);
        errors.push(...usEquityPanel.errors);
      } catch (err: unknown) {
        errors.push(
          redactSecrets(err instanceof Error ? err.message : 'Massive US equity panel error', this.secrets),
        );
      }
    }

    const usRowMap = new Map<string, EquityPanelRowDto>(
      (usEquityPanel?.rows ?? []).map((r) => [r.symbol.toUpperCase(), r]),
    );
    const cachedIvMap = usRt?.getCachedIv30Map?.() ?? new Map<string, number>();

    const allUsUnderlyings = [
      ...new Set([
        ...params.overview.cedears
          .map((c) => c.adrTicker?.replace(/ US$/i, '').trim().toUpperCase())
          .filter((s): s is string => s !== undefined && s !== ''),
        ...AR_STOCK_META.map((m) => m.adrTicker).filter((s): s is string => s !== undefined),
      ]),
    ];

    const missingRvUsTickers = allUsUnderlyings.filter((sym) => {
      const panelRow = usRowMap.get(sym);
      return panelRow === undefined || panelRow.realizedVol30dPct === null;
    });

    const fallbackRv30ByUs = new Map<string, { readonly last: number | null; readonly deltaPct: number | null; readonly rv30: number | null }>();
    if (missingRvUsTickers.length > 0 && (this.usDailyBarsFn !== null || usRt !== null)) {
      const dailyRes = await this.getUsDailyBars1dMap(missingRvUsTickers, 90, params.forceRefresh);
      errors.push(...dailyRes.errors);
      for (const [sym, bars] of dailyRes.bySymbol.entries()) {
        if (bars.length > 0) {
          const m = computeEquityRiskAndReturnMetrics({
            bars,
            benchmarkBars: bars,
            asOfUtcSec: params.nowSec,
          });
          fallbackRv30ByUs.set(sym, {
            last: m.last,
            deltaPct: m.return1dPct,
            rv30: m.realizedVol30dPct,
          });
        }
      }
    }

    const cedLiveRes = await this.getData912Live('/live/arg_cedears', params.forceRefresh);
    const cedLiveMap = new Map(cedLiveRes.rows.map((r) => [r.symbol, r]));
    const activeCedearTickers = params.overview.cedears
      .filter((c) => c.last !== null && c.last > 0)
      .map((c) => c.ticker);
    const cedHistEntries = await Promise.all(
      activeCedearTickers.map(async (ticker) => {
        const res = await this.getCedearHistoryWithAlias(ticker, params.forceRefresh);
        return [ticker, res.bars] as const;
      }),
    );
    const cedHistMap = new Map<string, readonly Bar[]>(cedHistEntries);

    const resolveIvAndPriceForUs = (
      usSym: string | undefined,
    ): {
      readonly usLast: number | null;
      readonly usDeltaPct: number | null;
      readonly iv30d: number | null;
      readonly ivSource: 'OPRA_IV' | 'MASSIVE_RV30D' | 'NONE';
    } => {
      if (usSym === undefined || usSym === '') {
        return { usLast: null, usDeltaPct: null, iv30d: null, ivSource: 'NONE' };
      }
      const panelRow = usRowMap.get(usSym);
      const fb = fallbackRv30ByUs.get(usSym);
      const cachedIvDec = cachedIvMap.get(usSym) ?? null;
      const opraIvPct =
        cachedIvDec !== null && Number.isFinite(cachedIvDec) && cachedIvDec > 0
          ? sanitizeFinite(cachedIvDec * 100)
          : panelRow?.iv30d !== undefined && panelRow.iv30d !== null && panelRow.iv30d > 0
            ? sanitizeFinite(panelRow.iv30d)
            : null;
      const rv30Pct = panelRow?.realizedVol30dPct ?? fb?.rv30 ?? null;
      const iv30d = opraIvPct ?? sanitizeFinite(rv30Pct);
      const ivSource: 'OPRA_IV' | 'MASSIVE_RV30D' | 'NONE' =
        opraIvPct !== null ? 'OPRA_IV' : rv30Pct !== null ? 'MASSIVE_RV30D' : 'NONE';
      const usLast = panelRow?.last ?? fb?.last ?? null;
      const usDeltaPct = panelRow?.return1dPct ?? fb?.deltaPct ?? null;
      return { usLast, usDeltaPct, iv30d, ivSource };
    };

    const enrichedCedears: ArStockDto[] = params.overview.cedears.map((c) => {
      const usSym = c.adrTicker?.replace(/ US$/i, '').trim().toUpperCase();
      const usInfo = resolveIvAndPriceForUs(usSym);
      const effectiveUsLast: number | null =
        c.adrPrice !== undefined && c.adrPrice !== null && c.adrPrice > 0
          ? c.adrPrice
          : usInfo.usLast;
      const effectiveUsDelta: number | null =
        c.adrDeltaPct !== undefined && c.adrDeltaPct !== null
          ? c.adrDeltaPct
          : usInfo.usDeltaPct;
      const ratio = c.adrRatio;
      const cclImplicit =
        c.cclImplicit !== null && c.cclImplicit !== undefined && c.cclImplicit > 0
          ? c.cclImplicit
          : c.last !== null &&
              c.last > 0 &&
              effectiveUsLast !== null &&
              effectiveUsLast > 0 &&
              ratio !== undefined &&
              ratio > 0
            ? sanitizeFinite((c.last * ratio) / effectiveUsLast)
            : null;
      const parity = this.computeParityMismatchAndArb({
        usTicker: usSym,
        ratio,
        localLast: c.last,
        usLast: effectiveUsLast,
        cclImplicit,
        cclMedian: params.overview.cclMedian,
        hasBymaOptions: false,
      });

      const liveRow = cedLiveMap.get(c.ticker);
      const bars = cedHistMap.get(c.ticker) ?? [];
      const lastBar = bars[bars.length - 1];
      const todayShares =
        liveRow?.nominalVol !== null && liveRow?.nominalVol !== undefined && liveRow.nominalVol > 0
          ? liveRow.nominalVol
          : c.volumeM !== null && c.volumeM > 0 && c.last !== null && c.last > 0
            ? (c.volumeM * 1_000_000) / c.last
            : lastBar !== undefined && lastBar.volume > 0
              ? lastBar.volume
              : null;
      const volMultiple =
        this.computeRelativeVolumeMultiple({
          todayShares,
          bars,
          asOfUtcSec: params.nowSec,
        }) ?? c.volMultiple;

      const usMeta = usSym !== undefined ? US_EQUITY_META_MAP.get(usSym) : undefined;
      return {
        ...c,
        adrPrice: sanitizeFinite(effectiveUsLast),
        adrDeltaPct: sanitizeFinite(effectiveUsDelta),
        cclImplicit: sanitizeFinite(cclImplicit),
        cclZScore: parity.cclMismatchPct ?? c.cclZScore ?? null,
        cclMismatchPct: parity.cclMismatchPct,
        cclMismatchArs: parity.cclMismatchArs,
        fairArsPrice: parity.fairArsPrice,
        volMultiple,
        iv30d: usInfo.iv30d ?? c.iv30d ?? null,
        ivSource: usInfo.iv30d !== null ? usInfo.ivSource : c.ivSource ?? 'NONE',
        hasUsOptions: parity.hasUsOptions || (usMeta?.hasUsOptions ?? false),
        hasBymaOptions: false,
        arbitrageSignal: parity.arbitrageSignal,
      };
    });

    const enrichedMervalStocks: ArStockDto[] = params.overview.mervalStocks.map((s) => {
      if (s.adrTicker === undefined) {
        return s;
      }
      const usSym = s.adrTicker.replace(/ US$/i, '').trim().toUpperCase();
      const usInfo = resolveIvAndPriceForUs(usSym);
      const effectiveUsLast: number | null =
        s.adrPrice !== undefined && s.adrPrice !== null && s.adrPrice > 0
          ? s.adrPrice
          : usInfo.usLast;
      const cclImplicit =
        s.cclImplicit !== null && s.cclImplicit !== undefined && s.cclImplicit > 0
          ? s.cclImplicit
          : s.last !== null &&
              s.last > 0 &&
              effectiveUsLast !== null &&
              effectiveUsLast > 0 &&
              s.adrRatio !== undefined &&
              s.adrRatio > 0
            ? sanitizeFinite((s.last * s.adrRatio) / effectiveUsLast)
            : null;
      const hasBymaOptions = BYMA_OPTION_UNDERLYINGS.has(s.ticker);
      const parity = this.computeParityMismatchAndArb({
        usTicker: usSym,
        ratio: s.adrRatio,
        localLast: s.last,
        usLast: effectiveUsLast,
        cclImplicit,
        cclMedian: params.overview.cclMedian,
        hasBymaOptions,
      });
      return {
        ...s,
        adrPrice: sanitizeFinite(effectiveUsLast),
        adrDeltaPct: sanitizeFinite(s.adrDeltaPct ?? usInfo.usDeltaPct),
        cclImplicit: sanitizeFinite(cclImplicit),
        cclMismatchPct: parity.cclMismatchPct,
        cclMismatchArs: parity.cclMismatchArs,
        fairArsPrice: parity.fairArsPrice,
        iv30d: s.iv30d ?? usInfo.iv30d ?? null,
        ivSource: s.iv30d !== undefined && s.iv30d !== null ? (s.ivSource ?? 'OPRA_IV') : usInfo.ivSource,
        hasUsOptions: parity.hasUsOptions,
        hasBymaOptions,
        arbitrageSignal: parity.arbitrageSignal,
      };
    });

    return {
      cedears: enrichedCedears,
      enrichedMervalStocks,
      usEquityPanel,
      errors,
    };
  }

  private computeStockInstitutionalEngines(params: {
    readonly asOfUtcSec: number;
    readonly spot: number | null;
    readonly bars: readonly Bar[];
    readonly benchmarkBars: readonly Bar[];
    readonly dealerLevels?: readonly SpatialLevelInput[];
    readonly optionsDeltaFlowSign?: number;
  }): ArStockInstitutionalEnginesDto {
    const evalSec = Math.floor(params.asOfUtcSec);
    const closedBars = normalizeClosedDailyBarsForEngines(params.bars.slice(-90), evalSec);
    const closedBench = normalizeClosedDailyBarsForEngines(params.benchmarkBars.slice(-90), evalSec);
    const spot = params.spot ?? closedBars[closedBars.length - 1]?.close ?? null;
    const atr14 = computeWilderAtr14(closedBars);
    const cvdSlopeSign = computeCausalCvdSlopeSign(closedBars);

    const tickSize =
      spot !== null && spot > 0
        ? Math.max(0.01, Math.round((spot / 120) * 100) / 100)
        : 0.05;

    // Pieza 50.4: `closedBars` (90 ruedas) se conserva para ATR/CVD/POCs/FVGs/FOBs y
    // fuerza relativa; el Volume Profile usa su propia ventana de 252 ruedas (1 año).
    const closedBarsVp = normalizeClosedDailyBarsForEngines(
      params.bars.slice(-DEFAULT_VOLUME_PROFILE_LOOKBACK_BARS),
      evalSec,
    );
    const volumeProfile =
      closedBarsVp.length >= 2
        ? computeVolumeProfileAmt(closedBarsVp, {
            asOfUtcSec: evalSec,
            barSeconds: 86_400,
            tickSize,
            lookbackBars: DEFAULT_VOLUME_PROFILE_LOOKBACK_BARS,
          })
        : null;

    const nakedPocs =
      closedBars.length >= 2
        ? trackNakedPocs(closedBars, {
            asOfUtcSec: evalSec,
            barSeconds: 86_400,
            tickSize,
          })
        : null;

    const fvgs =
      closedBars.length >= 5
        ? detectQuantitativeFvgs(closedBars, {
            asOfUtcSec: evalSec,
            barSeconds: 86_400,
            tickSize,
            minRangeZScore: 1.0,
            maxLvnPercentile: 50,
            minDeltaImbalanceRatio: 0,
          })
        : null;

    const orderBlocks =
      closedBars.length >= 8
        ? detectFreshOrderBlocks(closedBars, {
            asOfUtcSec: evalSec,
            barSeconds: 86_400,
            minDisplacementZScore: 1.0,
            minAbsorptionVolumePercentile: 60,
            minDarkPoolShare: 0,
            anchorMode: 'HLC3',
          })
        : null;

    const relativeStrength =
      closedBars.length >= 2 && closedBench.length >= 2
        ? evaluateRelativeStrengthAndCatalysts({
            asOfUtcSec: evalSec,
            assetBars: closedBars.map((b) => ({ time: b.time, close: b.close })),
            benchmarkBars: closedBench.map((b) => ({ time: b.time, close: b.close })),
            lookbackBars: Math.min(20, Math.max(1, closedBars.length - 1)),
          })
        : null;

    const levels: SpatialLevelInput[] = [];
    if (volumeProfile !== null && volumeProfile.status === 'OK') {
      levels.push(
        { name: 'POC', category: 'AMT_VOLUME_PROFILE', price: volumeProfile.poc, expectedReaction: 'MAGNET_NEUTRAL' },
        { name: 'VAH', category: 'AMT_VOLUME_PROFILE', price: volumeProfile.vah, expectedReaction: 'RESISTANCE_BEARISH' },
        { name: 'VAL', category: 'AMT_VOLUME_PROFILE', price: volumeProfile.val, expectedReaction: 'SUPPORT_BULLISH' },
        { name: 'AVWAP', category: 'AMT_VOLUME_PROFILE', price: volumeProfile.profileVwap, expectedReaction: 'MAGNET_NEUTRAL' },
      );
    }
    if (nakedPocs !== null && nakedPocs.status === 'OK') {
      for (const np of nakedPocs.activeNakedPocs.slice(-3)) {
        levels.push({
          name: `Naked POC (${np.sessionDate})`,
          category: 'AMT_VOLUME_PROFILE',
          price: np.sessionPoc,
          expectedReaction: spot !== null && np.sessionPoc >= spot ? 'RESISTANCE_BEARISH' : 'SUPPORT_BULLISH',
        });
      }
    }
    if (fvgs !== null && fvgs.status === 'OK') {
      for (const fvg of fvgs.activeFvgs.slice(-4)) {
        levels.push({
          name: fvg.type === 'BULLISH_FVG' ? 'FVG Alcista CE' : 'FVG Bajista CE',
          category: 'MICROSTRUCTURE_FVG_FOB',
          price: fvg.consequentEncroachment,
          expectedReaction: fvg.type === 'BULLISH_FVG' ? 'SUPPORT_BULLISH' : 'RESISTANCE_BEARISH',
        });
      }
    }
    if (orderBlocks !== null && orderBlocks.status === 'OK') {
      for (const fob of orderBlocks.freshOrderBlocks.slice(-4)) {
        levels.push({
          name: fob.type === 'BULLISH_FOB' ? 'Fresh OB Demanda' : 'Fresh OB Oferta',
          category: 'MICROSTRUCTURE_FVG_FOB',
          price: fob.anchorPrice,
          expectedReaction: fob.type === 'BULLISH_FOB' ? 'SUPPORT_BULLISH' : 'RESISTANCE_BEARISH',
        });
      }
    }
    if (params.dealerLevels !== undefined) {
      for (const lvl of params.dealerLevels) {
        levels.push(lvl);
      }
    }

    const confluenceClusters =
      spot !== null && spot > 0 && atr14 !== null && atr14 > 0 && levels.length > 0
        ? detectSpatialConfluenceClusters({
            spot,
            atr: atr14,
            levels,
            trigger: {
              cvdSlopeSign,
              optionsDeltaFlowSign: params.optionsDeltaFlowSign ?? 0,
            },
          })
        : null;

    return sanitizeJsonPayload({
      atr14: sanitizeFinite(atr14),
      cvdSlopeSign,
      volumeProfile,
      nakedPocs,
      fvgs,
      orderBlocks,
      relativeStrength,
      confluenceClusters,
    });
  }

  /**
   * Pieza 38: clasifica un ticker AR para elegir el histórico de Data912.
   * Misma regla que `getStockDetail`: soberanos (con variantes D/C) => bonds,
   * CEDEARs (que no sean también locales BYMA) => cedears, resto => stocks.
   */
  private resolveArHistoryKind(symbol: string): 'stocks' | 'cedears' | 'bonds' {
    const isBond = SOVEREIGN_BONDS.some(
      (b) => b.baseTicker === symbol || `${b.baseTicker}D` === symbol || `${b.baseTicker}C` === symbol,
    );
    const isCedear = symbol in CEDEAR_RATIOS && !STOCK_META_MAP.has(symbol);
    return isBond ? 'bonds' : isCedear ? 'cedears' : 'stocks';
  }

  /**
   * Pieza 50.5: anclas Auto-AVWAP en ARS con caché diario acotado a 300 entradas.
   * Data912 es diario y no expone earnings/macro: degradación limpia a `PIVOT + RVOL`.
   */
  private resolveArAutoAvwapAnchors(
    symbol: string,
    bars: readonly Bar[],
    nowSec: number,
  ): readonly AutoAvwapAnchor[] {
    const cacheKey = `AR:${symbol}:${getSessionDateKey(nowSec, BYMA_MARKET_TZ)}`;
    const cached = this.arAutoAvwapAnchorsCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const anchors = detectAutoAvwapAnchors(bars, []);
    if (this.arAutoAvwapAnchorsCache.size >= 300) {
      const oldestKey = this.arAutoAvwapAnchorsCache.keys().next().value;
      if (oldestKey !== undefined) this.arAutoAvwapAnchorsCache.delete(oldestKey);
    }
    this.arAutoAvwapAnchorsCache.set(cacheKey, anchors);
    return anchors;
  }

  /**
   * Pieza 38: velas reales en ARS para `GET /api/bars` con símbolo del
   * universo argentino (Panel Líder, Panel General, CEDEARs, soberanos).
   *
   * Fuente: histórico Data912 (`/historical/{stocks|cedears|bonds}/{ticker}`,
   * la misma fuente que `getStockDetail` usa para GGAL y los paneles AR),
   * resuelto con caché single-flight y recortado a las últimas 1.250 ruedas.
   * Sólo `1D`: el histórico Data912 es diario; el intradiario AR sigue
   * disponible vía `adrBars` en `getStockDetail` y un timeframe intradiario
   * aquí responde `NO_BARS_DATA` (sin fallbacks silenciosos).
   */
  public async getArTerminalBars(
    rawSymbol: string,
    rawTimeframe: string,
    options: { readonly visibleBars?: number; readonly forceRefresh?: boolean } = {},
  ): Promise<ArTerminalBarsResponse> {
    const symbol = rawSymbol.trim().toUpperCase();
    if (symbol === '' || !/^[A-Z0-9.:_-]{1,24}$/.test(symbol)) {
      throw new RuntimeNoDataError('INVALID_SYMBOL', `Invalid AR ticker "${rawSymbol}"`, this.secrets, 400);
    }
    const parsedTimeframe = parseTimeframe(rawTimeframe, this.secrets);
    const fallback = resolveArIntradayFallback(parsedTimeframe);
    const timeframe = fallback.effectiveTimeframe;
    if (timeframe !== '1D') {
      throw new RuntimeNoDataError(
        'NO_BARS_DATA',
        `Sin histórico intradiario BYMA para ${symbol} (${timeframe}) — disponible en 1D`,
        this.secrets,
        503,
      );
    }
    const forceRefresh = options.forceRefresh ?? false;
    const kind = this.resolveArHistoryKind(symbol);
    const history = kind === 'cedears'
      ? await this.getCedearHistoryWithAlias(symbol, forceRefresh)
      : await this.getData912History(kind, symbol, forceRefresh);
    const bars = history.bars.slice(-1_250);
    if (bars.length === 0) {
      throw new RuntimeNoDataError(
        'NO_BARS_DATA',
        history.error !== null && history.error !== ''
          ? history.error
          : `No AR history available for ${symbol} (${kind})`,
        this.secrets,
        503,
      );
    }
    const nowSec = Math.floor(this.nowMsFn() / 1_000);
    const visibleBars = Math.min(Math.max(options.visibleBars ?? 1_250, 20), 1_250);
    const full = computeArTerminalBarsPayload(symbol, timeframe, bars, nowSec);
    // Pieza 50.5: anclas institucionales Auto-AVWAP en ARS (Data912 diario, sin
    // earnings/macro FMP): degradación limpia a PIVOT + RVOL, cacheada por día.
    const anchoredFull: ArTerminalBarsResponse = {
      ...full,
      autoAvwapAnchors: this.resolveArAutoAvwapAnchors(symbol, bars, nowSec),
    };
    const fallbackFields =
      fallback.fallbackReason === null
        ? {}
        : {
            requestedTimeframe: fallback.requestedTimeframe,
            effectiveTimeframe: fallback.effectiveTimeframe,
            fallbackReason: fallback.fallbackReason,
          };
    assertJsonSafeSerialized(anchoredFull);
    const startSlice = Math.max(0, bars.length - visibleBars);
    if (startSlice === 0) return { ...anchoredFull, ...fallbackFields };
    const fullOverlays = anchoredFull.overlays;
    const sliced: ArTerminalBarsResponse = {
      ...anchoredFull,
      visibleStartIndex: 0,
      bars: full.bars.slice(startSlice),
      overlays: {
        ...(fullOverlays.ema9 === undefined ? {} : { ema9: fullOverlays.ema9.slice(startSlice) }),
        ema21: fullOverlays.ema21.slice(startSlice),
        ...(fullOverlays.ema50 === undefined ? {} : { ema50: fullOverlays.ema50.slice(startSlice) }),
        ...(fullOverlays.ema200 === undefined ? {} : { ema200: fullOverlays.ema200.slice(startSlice) }),
        sma50: fullOverlays.sma50.slice(startSlice),
        sma200: fullOverlays.sma200.slice(startSlice),
        hma55: fullOverlays.hma55.slice(startSlice),
        sessionVwap: fullOverlays.sessionVwap.slice(startSlice),
        sessionVwapSupported: fullOverlays.sessionVwapSupported,
        avwap: fullOverlays.avwap.slice(startSlice),
        avwapUpper1: fullOverlays.avwapUpper1.slice(startSlice),
        avwapLower1: fullOverlays.avwapLower1.slice(startSlice),
        avwapUpper2: fullOverlays.avwapUpper2.slice(startSlice),
        avwapLower2: fullOverlays.avwapLower2.slice(startSlice),
      },
      subPanes: {
        rsi14: full.subPanes.rsi14.slice(startSlice),
        sessionCvd: full.subPanes.sessionCvd.slice(startSlice),
        deltaMode: full.subPanes.deltaMode,
      },
    };
    assertJsonSafeSerialized(sliced);
    return { ...sliced, ...fallbackFields };
  }

  public async getStockDetail(
    rawSymbol: string,
    forceRefresh = false,
    timeframe: Timeframe = '1D',
  ): Promise<ArStockDetailResponse> {
    const symbol = rawSymbol.trim().toUpperCase();
    const cacheKey = `${symbol}:${timeframe}`;
    const nowMs = this.nowMsFn();
    if (!forceRefresh) {
      const cached = this.stockDetailCache.get(cacheKey);
      if (cached !== undefined && nowMs - cached.atMs < 1_500) {
        return cached.response;
      }
    }
    const nowSec = Math.floor(nowMs / 1_000);
    const kind = this.resolveArHistoryKind(symbol);
    const isBond = kind === 'bonds';
    const isCedear = kind === 'cedears';

    const [histRes, overview, optionsRes, bondsLive, spyHistRes, macroData, mervBook, mervBookCi, bmbSnap, macroIfPrimary] =
      await Promise.all([
        this.getData912History(kind, symbol, forceRefresh),
        this.getOverviewCore(forceRefresh),
        this.getData912Live('/live/arg_options', forceRefresh),
        isBond
          ? this.getData912Live('/live/arg_bonds', forceRefresh)
          : Promise.resolve({ rows: [] as readonly NormalizedQuoteRow[], error: null }),
        symbol === 'SPY'
          ? Promise.resolve({ bars: [] as readonly Bar[], error: null })
          : this.getData912History('cedears', 'SPY', forceRefresh),
        isBond ? this.fetchBcraAndArgDatos(forceRefresh) : Promise.resolve(null),
        this.primaryClient.getMervOrderBook5Levels(symbol, forceRefresh, '24HS'),
        this.primaryClient.getMervOrderBook5Levels(symbol, forceRefresh, 'CI'),
        this.bmbClient.getSnapshot(symbol, null, forceRefresh),
        this.primaryClient.isConfigured()
          ? this.getMacro(forceRefresh).catch(() => null)
          : Promise.resolve(null),
      ]);

    const stock =
      overview.mervalStocks.find((s) => s.ticker === symbol) ??
      overview.generalPanelStocks.find((s) => s.ticker === symbol) ??
      overview.cedears.find((s) => s.ticker === symbol) ??
      null;

    let effectiveBondRows = bondsLive.rows;
    if (isBond && !hasPositiveLast(effectiveBondRows)) {
      const eodRow = this.historyBarsToQuoteRow(symbol, histRes.bars);
      if (eodRow !== null) {
        effectiveBondRows = [eodRow];
      }
    }

    const bond = isBond
      ? this.buildSovereignBonds(
          effectiveBondRows,
          overview.mepMedian,
          overview.cclMedian,
          nowSec,
          macroData?.variables.cer ?? null,
        ).find((b) => symbol.startsWith(b.ticker)) ?? null
      : null;

    const bars = histRes.bars;
    const closes = bars.map((b) => b.close);
    const rsiSeries = closes.length >= 15 ? computeWilderRsiSeries(closes, 14) : [];
    const sma50Series = closes.length >= 50 ? computeSmaSeries(closes, 50) : [];
    const sma200Series = closes.length >= 200 ? computeSmaSeries(closes, 200) : [];
    const ema21Series = closes.length >= 21 ? calculateEma(closes, 21) : [];

    const rv20 = computeDailyRealizedVol(bars, 20);
    const rv60 = computeDailyRealizedVol(bars, 60);
    const cclDiv = overview.cclMedian ?? overview.mepMedian ?? null;
    const deflatedBars: readonly Bar[] =
      cclDiv !== null && cclDiv > 0
        ? bars.map((b) => ({
            ...b,
            open: b.open / cclDiv,
            high: b.high / cclDiv,
            low: b.low / cclDiv,
            close: b.close / cclDiv,
          }))
        : [];
    const rvUsd20 = computeDailyRealizedVol(deflatedBars, 20);

    const mtf = bars.length > 0
      ? evaluateMtfStructure({ bars1d: bars, bars4h: [], bars15m: [], bars5m: [] }, { asOfUtcSec: nowSec })
      : null;

    const parsedOptionsForSymbol = optionsRes.rows
      .map((o) => parseBymaOptionSymbol(o.symbol, null, nowSec))
      .filter((p): p is ParsedBymaOptionSymbol => p !== null && p.underlying === symbol);
    const relatedOptionsCount = parsedOptionsForSymbol.length;

    const upcomingExpiries = [...new Map(
      parsedOptionsForSymbol
        .filter((p) => p.daysToExpiry >= 0)
        .sort((a, b) => a.expiryUtcSec - b.expiryUtcSec)
        .map((p) => [p.expiryCode, p] as const),
    ).values()];
    const nearestOptionExpiry = upcomingExpiries[0] ?? null;

    const benchBars = symbol === 'SPY' ? bars : spyHistRes.bars;
    const institutionalEngines = this.computeStockInstitutionalEngines({
      asOfUtcSec: nowSec,
      spot: stock?.last ?? bond?.priceArs ?? (bars[bars.length - 1]?.close ?? null),
      bars,
      benchmarkBars: benchBars,
    });

    const recentBars = bars.slice(-1_250);
    const lastRecentBar = recentBars.at(-1);
    const overlayCacheKey =
      lastRecentBar === undefined
        ? null
        : `${symbol}:${timeframe}:${String(lastRecentBar.time)}:${String(recentBars.length)}`;
    let arIndicatorOverlays: ArStockDetailIndicatorOverlays | null = null;
    if (overlayCacheKey !== null) {
      const cachedOverlays = this.arOverlayCache.get(overlayCacheKey);
      if (cachedOverlays !== undefined) {
        arIndicatorOverlays = cachedOverlays;
      } else {
        arIndicatorOverlays = buildArStockDetailOverlays(recentBars, timeframe);
        this.arOverlayCache.set(overlayCacheKey, arIndicatorOverlays);
        if (this.arOverlayCache.size > 64) {
          const oldestKey = this.arOverlayCache.keys().next().value;
          if (oldestKey !== undefined) this.arOverlayCache.delete(oldestKey);
        }
      }
    }
    const toArBarDtos = (srcBars: readonly Bar[], divCcl: number | null): readonly ArHistoricalBarDto[] =>
      srcBars.map((b, idx) => {
        const prev = srcBars[idx - 1];
        const ret = prev !== undefined && prev.close > 0 ? ((b.close - prev.close) / prev.close) * 100 : null;
        const d = new Date(b.time * 1_000);
        return {
          time: b.time,
          date: d.toISOString().slice(0, 10),
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          closeDeflatedUsd: divCcl !== null && divCcl > 0 ? sanitizeFinite(b.close / divCcl) : null,
          volume: b.volume,
          dailyReturnPct: sanitizeFinite(ret),
        };
      });

    const historicalBars = toArBarDtos(recentBars, cclDiv);
    const benchmarkBars1d = toArBarDtos(benchBars.slice(-120), cclDiv);

    // Soporte intradiario real vía ADR US en Massive convertido a ARS por CCL vigente
    let adrBars: ArStockDetailResponse['adrBars'] = null;
    const stockMeta = STOCK_META_MAP.get(symbol);
    const cedearMeta = isCedear ? CEDEAR_RATIOS[symbol] : undefined;
    const adrUsTicker = stockMeta?.adrTicker ?? cedearMeta?.usTicker;
    const adrUsRatio = stockMeta?.adrRatio ?? cedearMeta?.ratio;
    const effectiveCclForAdr = stock?.cclImplicit ?? cclDiv;
    if (
      timeframe !== '1D' &&
      adrUsTicker !== undefined &&
      adrUsRatio !== undefined &&
      adrUsRatio > 0 &&
      effectiveCclForAdr !== null &&
      effectiveCclForAdr > 0
    ) {
      const usRt = this.resolveEffectiveUsRuntime();
      if (usRt !== null && typeof usRt.getBars === 'function') {
        try {
          const usBarsRes = await usRt.getBars(adrUsTicker, timeframe, {
            visibleBars: 180,
            forceRefresh,
          });
          if (usBarsRes.bars.length > 0) {
            const convFactor = effectiveCclForAdr / adrUsRatio;
            const convertedBars: ArHistoricalBarDto[] = usBarsRes.bars.map((b, idx) => {
              const prev = usBarsRes.bars[idx - 1];
              const ret = prev !== undefined && prev.close > 0 ? ((b.close - prev.close) / prev.close) * 100 : null;
              return {
                time: b.time,
                date: new Date(b.time * 1_000).toISOString().slice(0, 10),
                open: b.open * convFactor,
                high: b.high * convFactor,
                low: b.low * convFactor,
                close: b.close * convFactor,
                closeDeflatedUsd: sanitizeFinite(b.close / adrUsRatio),
                volume: b.volume,
                dailyReturnPct: sanitizeFinite(ret),
              };
            });
            adrBars = {
              timeframe,
              source: 'MASSIVE_ADR_CONVERTED',
              usTicker: adrUsTicker,
              adrRatio: adrUsRatio,
              cclUsed: effectiveCclForAdr,
              bars: convertedBars,
            };
          }
        } catch {
          adrBars = null;
        }
      }
    }

    const providerErrors = [
      ...overview.providerErrors,
      ...(histRes.error !== null ? [histRes.error] : []),
      ...(optionsRes.error !== null ? [optionsRes.error] : []),
    ];

    const feedStatus: FeedStatus = stock === null && bond === null && bars.length === 0 ? 'NO_DATA' : overview.feedStatus;

    const bmbBook = bmbSnap.orderBooksBySymbol[symbol] ?? null;
    const bmbBookFresh =
      bmbBook?.asOfUtcSec !== null &&
      bmbBook?.asOfUtcSec !== undefined &&
      nowSec >= bmbBook.asOfUtcSec &&
      nowSec - bmbBook.asOfUtcSec <= 20;
    let orderBook5Levels: OrderBook5LevelsDto | null = null;
    if (
      bmbBook !== null &&
      bmbBookFresh &&
      bmbSnap.health.connected &&
      (bmbSnap.health.status === 'READY' || bmbSnap.health.status === 'CONNECTED_L2') &&
      bmbBook.bids.length > 0 &&
      bmbBook.asks.length > 0
    ) {
      const l2 = computeOrderBookL2Metrics(bmbBook.bids, bmbBook.asks);
      orderBook5Levels = {
        symbol,
        marketSymbol: `${symbol} - ${bmbBook.settlement}`,
        settlement: bmbBook.settlement,
        marketState: 'LIVE',
        source: 'BMB_HOMEBROKER',
        asOfUtcSec: bmbBook.asOfUtcSec,
        bids: bmbBook.bids,
        asks: bmbBook.asks,
        bestBid: sanitizeFinite(l2.bestBid),
        bestAsk: sanitizeFinite(l2.bestAsk),
        mid: sanitizeFinite(l2.mid),
        spreadArs: sanitizeFinite(l2.spread),
        spreadPct: sanitizeFinite(l2.spreadPct),
        bidDepthSize: sanitizeFinite(l2.bidDepthSize),
        askDepthSize: sanitizeFinite(l2.askDepthSize),
        vwapBid5: sanitizeFinite(l2.vwapBid5),
        vwapAsk5: sanitizeFinite(l2.vwapAsk5),
        vwapBook5: sanitizeFinite(l2.vwapBook5),
        obi5: sanitizeFinite(l2.obi5),
        last: stock?.last ?? bond?.priceArs ?? null,
        open: null,
        high: stock?.high ?? null,
        low: stock?.low ?? null,
        close: stock?.prevClose ?? null,
        settlementPrice: null,
        nominalVolume: null,
      };
    } else if (mervBook !== null && (mervBook.bids.length > 0 || mervBook.asks.length > 0)) {
      orderBook5Levels = mervBook;
    } else if (mervBookCi !== null && (mervBookCi.bids.length > 0 || mervBookCi.asks.length > 0)) {
      orderBook5Levels = mervBookCi;
    } else if (mervBook !== null) {
      orderBook5Levels = mervBook;
    } else if (mervBookCi !== null) {
      orderBook5Levels = mervBookCi;
    } else if (stock !== null) {
      const l1Bids = stock.bid !== null && Number.isFinite(stock.bid) && stock.bid > 0 ? [{ price: stock.bid, size: 0 }] : [];
      const l1Asks = stock.ask !== null && Number.isFinite(stock.ask) && stock.ask > 0 ? [{ price: stock.ask, size: 0 }] : [];
      const l1Metrics = computeOrderBookL2Metrics(l1Bids, l1Asks);
      orderBook5Levels = {
        symbol,
        marketSymbol: `${symbol} - 24hs`,
        settlement: '24hs',
        marketState: l1Bids.length > 0 || l1Asks.length > 0 ? 'LIVE' : 'UNAVAILABLE',
        source: 'BYMA_L1_ONLY',
        asOfUtcSec: nowSec,
        bids: l1Bids,
        asks: l1Asks,
        bestBid: sanitizeFinite(l1Metrics.bestBid),
        bestAsk: sanitizeFinite(l1Metrics.bestAsk),
        mid: sanitizeFinite(l1Metrics.mid),
        spreadArs: sanitizeFinite(l1Metrics.spread),
        spreadPct: sanitizeFinite(l1Metrics.spreadPct),
        bidDepthSize: null,
        askDepthSize: null,
        vwapBid5: null,
        vwapAsk5: null,
        vwapBook5: null,
        obi5: null,
        last: stock.last,
        open: null,
        high: stock.high,
        low: stock.low,
        close: stock.prevClose,
        settlementPrice: null,
        nominalVolume: null,
      };
    }

    const normalizeDetailBook = (book: OrderBook5LevelsDto | null): OrderBook5LevelsDto | null => {
      if (book === null) return null;
      const norm = normalizeStockDetailOrderBook(book.bids, book.asks, 5);
      const bidDepthSum = norm.bids.reduce((acc, lvl) => acc + lvl.size, 0);
      const askDepthSum = norm.asks.reduce((acc, lvl) => acc + lvl.size, 0);
      return {
        ...book,
        bids: norm.bids.map((lvl) => ({ price: lvl.price, size: lvl.size })),
        asks: norm.asks.map((lvl) => ({ price: lvl.price, size: lvl.size })),
        bestBid: sanitizeFinite(norm.bestBid),
        bestAsk: sanitizeFinite(norm.bestAsk),
        mid: sanitizeFinite(norm.mid),
        spreadArs: sanitizeFinite(norm.spreadAbs),
        spreadPct: sanitizeFinite(norm.spreadPct),
        bidDepthSize: bidDepthSum > 0 ? sanitizeFinite(bidDepthSum) : null,
        askDepthSize: askDepthSum > 0 ? sanitizeFinite(askDepthSum) : null,
        obi5: sanitizeFinite(norm.obi5),
      };
    };
    orderBook5Levels = normalizeDetailBook(orderBook5Levels);
    const normalizedOrderBookCi = normalizeDetailBook(mervBookCi);
    const normalizedStock: ArStockDto | null =
      stock === null
        ? null
        : {
            ...stock,
            bid: sanitizePositive(stock.bid) ?? orderBook5Levels?.bestBid ?? null,
            ask: sanitizePositive(stock.ask) ?? orderBook5Levels?.bestAsk ?? null,
          };

    const rofexFrontContract =
      macroIfPrimary?.rofxFutures?.find((c) => c.category === 'OUTRIGHT' && c.price !== null) ??
      macroIfPrimary?.rofxFutures?.find((c) => (c.category === 'OUTRIGHT' || c.category === 'MINI') && c.price !== null) ??
      null;

    const response: ArStockDetailResponse = {
      asOfUtcSec: nowSec,
      feedStatus,
      symbol,
      assetType: isBond ? 'BOND' : isCedear ? 'CEDEAR' : 'STOCK',
      stock: normalizedStock,
      bond,
      historicalBars,
      overlays: arIndicatorOverlays,
      adrBars,
      benchmarkSymbol: symbol === 'SPY' ? 'SPY CEDEAR' : 'SPY CEDEAR',
      benchmarkBars1d,
      nextExpiry:
        nearestOptionExpiry !== null
          ? {
              expiryCode: nearestOptionExpiry.expiryCode,
              expirationDate: nearestOptionExpiry.expirationDate,
              expiryUtcSec: nearestOptionExpiry.expiryUtcSec,
              daysToExpiry: nearestOptionExpiry.daysToExpiry,
              ivAtm: null,
              expectedMoveAbs: null,
              expectedMovePct: null,
            }
          : null,
      realizedVol20d: sanitizeFinite(rv20),
      realizedVol60d: sanitizeFinite(rv60),
      realizedVolUsd20d: sanitizeFinite(rvUsd20),
      rsi14: sanitizeFinite(rsiSeries[rsiSeries.length - 1]),
      sma50: sanitizeFinite(sma50Series[sma50Series.length - 1]),
      sma200: sanitizeFinite(sma200Series[sma200Series.length - 1]),
      ema21: sanitizeFinite(ema21Series[ema21Series.length - 1]),
      mtfRegime: mtf?.regime1d ?? 'NO_DATA',
      relatedOptionsCount,
      institutionalEngines,
      orderBook5Levels,
      orderBookCi: normalizedOrderBookCi,
      rofexFrontContract,
      providerErrors,
    };
    if (!forceRefresh) {
      this.stockDetailCache.set(cacheKey, { atMs: nowMs, response });
      if (this.stockDetailCache.size > 32) {
        const oldestKey = this.stockDetailCache.keys().next().value;
        if (oldestKey !== undefined) this.stockDetailCache.delete(oldestKey);
      }
    }
    return response;
  }

  public setArHolidays(arHolidays: readonly string[]): void {
    this.arHolidays = [...arHolidays];
  }

  private normalizeMetadataSeriesMap(
    byNativeSeries: ReadonlyMap<string, BymaContractMetadataRecord | readonly BymaContractMetadataRecord[]>,
  ): Map<string, readonly BymaContractMetadataRecord[]> {
    const next = new Map<string, readonly BymaContractMetadataRecord[]>();
    const isRecordList = (
      val: BymaContractMetadataRecord | readonly BymaContractMetadataRecord[],
    ): val is readonly BymaContractMetadataRecord[] => Array.isArray(val);
    for (const [rawKey, entry] of byNativeSeries) {
      const cleanKey = rawKey.trim().toUpperCase().replace(/[^A-Z0-9.,]/g, '').replace(/,/g, '.');
      if (cleanKey === '') continue;
      next.set(cleanKey, isRecordList(entry) ? [...entry] : [entry]);
    }
    return next;
  }

  private invalidateOptionChainCaches(): void {
    this.computedCache.clear();
    if (this.anexoBOptions !== null) {
      this.anexoBOptions = {
        byContract: this.anexoBOptions.byContract,
        cache: new SingleFlightRuntimeCache({ ttlResolver: this.quoteTtlResolver, nowFn: this.nowMsFn }),
      };
    }
  }

  public setAnexoBContractMetadata(
    byNativeSeries: ReadonlyMap<string, BymaContractMetadataRecord | readonly BymaContractMetadataRecord[]>,
  ): void {
    this.anexoBContractMetadata = this.normalizeMetadataSeriesMap(byNativeSeries);
    this.invalidateOptionChainCaches();
  }

  public setPrimaryContractMetadata(
    byNativeSeries: ReadonlyMap<string, BymaContractMetadataRecord | readonly BymaContractMetadataRecord[]>,
  ): void {
    this.primaryContractMetadata = this.normalizeMetadataSeriesMap(byNativeSeries);
    this.invalidateOptionChainCaches();
  }

  public setAnexoBOpenInterest(
    byContract: ReadonlyMap<string, Extract<OiFieldProvenance, { status: 'IAMC_ANEXO_B' }>>,
  ): void {
    this.anexoBOptions = {
      byContract: new Map(byContract),
      cache: new SingleFlightRuntimeCache({ ttlResolver: this.quoteTtlResolver, nowFn: this.nowMsFn }),
    };
  }

  public async getOptionsChain(
    rawUnderlying = 'GGAL',
    forceRefresh = false,
    options: { readonly allowProxyOi?: boolean } = {},
  ): Promise<ArOptionsResponse> {
    return this.getOptionsChainInternal(rawUnderlying, forceRefresh, undefined, options);
  }

  private async getOptionsChainInternal(
    rawUnderlying = 'GGAL',
    forceRefresh = false,
    preloadedOverviewCore?: ArOverviewResponse,
    options: { readonly allowProxyOi?: boolean } = {},
  ): Promise<ArOptionsResponse> {
    const underlying = rawUnderlying.trim().toUpperCase();
    const cacheKey = `ar:options:${underlying}${options.allowProxyOi === true ? ':proxy' : ''}`;
    const anexoB = underlying === 'GGAL' ? this.anexoBOptions : null;
    const cached = await (anexoB?.cache ?? this.computedCache).getOrCompute(
      cacheKey,
      async () => {
        const nowSec = Math.floor(this.nowMsFn() / 1_000);
        const dualMeta = STOCK_META_MAP.get(underlying);
        const dualAdrTicker =
          preloadedOverviewCore === undefined &&
          dualMeta?.adrTicker !== undefined &&
          DUAL_ADR_OPTIONS_TICKERS.has(underlying)
            ? dualMeta.adrTicker
            : null;
        const dualUsRt = dualAdrTicker !== null ? this.resolveEffectiveUsRuntime() : null;
        const bmbHealth = this.bmbClient.getSafeHealthStatus();
        const bmbConfigured = bmbHealth.passwordConfigured && bmbHealth.status !== 'DISABLED_NO_PASSWORD';

        const [optionsRes, overview, macroData, histRes, dualBmbSnap, dualAdrSnap, dualAdrBarsRes] =
          await Promise.all([
            this.getData912Live('/live/arg_options', forceRefresh),
            preloadedOverviewCore !== undefined
              ? Promise.resolve(preloadedOverviewCore)
              : this.getOverviewCore(forceRefresh),
            this.fetchBcraAndArgDatos(preloadedOverviewCore !== undefined ? false : forceRefresh),
            this.getData912History('stocks', underlying, forceRefresh),
            bmbConfigured
              ? this.bmbClient.getSnapshot(undefined, null, forceRefresh).catch((): null => null)
              : Promise.resolve(null),
            dualAdrTicker !== null && dualUsRt !== null && typeof dualUsRt.getSnapshot === 'function'
              ? dualUsRt.getSnapshot(dualAdrTicker, { forceRefresh: false }).catch((): null => null)
              : Promise.resolve(null),
            dualAdrTicker !== null && dualUsRt !== null
              ? dualUsRt.getCachedDailyBars1d(dualAdrTicker, 320, false).catch((): null => null)
              : Promise.resolve(null),
          ]);

        const stock =
          overview.mervalStocks.find((s) => s.ticker === underlying) ??
          overview.generalPanelStocks.find((s) => s.ticker === underlying) ??
          null;
        const bars = histRes.bars;
        const spot = stock?.last ?? (bars.length > 0 ? bars[bars.length - 1]?.close ?? null : null);
        // Pieza 50.9: origen real del spot elegido (overview vs cierre histórico).
        const arSpotSource: 'OVERVIEW' | 'HISTORICAL_CLOSE' | null =
          spot === null || !Number.isFinite(spot) || spot <= 0
            ? null
            : stock?.last !== null && stock?.last !== undefined && spot === stock.last
              ? 'OVERVIEW'
              : 'HISTORICAL_CLOSE';
        const dividendYield = STOCK_META_MAP.get(underlying)?.dividendYield ?? 0;

        // Tasa libre de riesgo desde BCRA BADLAR/TAMAR/TPM/PF; sin fallback inventado si falta BCRA
        const rateTnaPct =
          macroData.variables.badlarTna ??
          macroData.variables.tamarTna ??
          macroData.variables.tpmTna ??
          macroData.variables.plazoFijoTna ??
          null;
        const continuousRate =
          rateTnaPct !== null && rateTnaPct > 0 ? Math.log(1 + rateTnaPct / 100) : null;

        const rv20 = computeDailyRealizedVol(bars, 20);
        const rv60 = computeDailyRealizedVol(bars, 60);
        const historicalCloses = bars.slice(-90).map((b) => b.close);

        const mergedOptionRows = mergeBmbOptionQuotes({
          trackFieldProvenance: true,
          rows: optionsRes.rows,
          bmbSnapshot: dualBmbSnap,
          underlying,
          spotHint: spot,
          nowUtcSec: nowSec,
          arHolidays: this.arHolidays,
        });
        const hasLiveBmbOptions = mergedOptionRows.some(
          (row) =>
            row.quoteSource === 'BMB_HOMEBROKER_BRIDGE' &&
            [row.bid, row.ask, row.last].some(
              (value) => value !== null && Number.isFinite(value) && value > 0,
            ),
        );
        const bmbMetaBySymbol = new Map<string, BymaContractMetadataRecord>();
        if (dualBmbSnap !== null) {
          for (const bmbOpt of dualBmbSnap.options) {
            const symKey = bmbOpt.symbol.trim().toUpperCase().replace(/[^A-Z0-9.,]/g, '').replace(/,/g, '.');
            if (symKey === '') continue;
            if (
              bmbOpt.strike !== undefined &&
              bmbOpt.strike !== null &&
              Number.isFinite(bmbOpt.strike) &&
              bmbOpt.strike > 0
            ) {
              bmbMetaBySymbol.set(symKey, {
                source: 'BMB_OPTION_METADATA',
                nativeSymbol: symKey,
                underlying: bmbOpt.underlying,
                strike: bmbOpt.strike,
                ...(typeof bmbOpt.expirationDate === 'string' && bmbOpt.expirationDate.trim() !== ''
                  ? { contractualExpiry: bmbOpt.expirationDate.trim() }
                  : {}),
                unit: 'ARS',
              });
            }
          }
        }

        const buildMetaRecordsForRow = (
          row: NormalizedQuoteRow,
          symKey: string,
          extraPrimary?: BymaContractMetadataRecord,
        ): readonly BymaContractMetadataRecord[] => {
          const out: BymaContractMetadataRecord[] = [];
          const anexoRecs = this.anexoBContractMetadata.get(symKey);
          if (anexoRecs !== undefined) {
            out.push(...anexoRecs);
          }
          const primaryRecs = this.primaryContractMetadata.get(symKey);
          if (primaryRecs !== undefined) {
            out.push(...primaryRecs);
          } else if (extraPrimary !== undefined) {
            out.push(extraPrimary);
          }
          const bmbRec = bmbMetaBySymbol.get(symKey);
          if (bmbRec !== undefined) {
            out.push(bmbRec);
          }
          if (
            row.explicitStrike !== undefined &&
            row.explicitStrike !== null &&
            Number.isFinite(row.explicitStrike) &&
            row.explicitStrike > 0
          ) {
            out.push({
              source:
                row.explicitMetadataSource ??
                (row.quoteSource === 'OPEN_BYMA' ? 'OPEN_BYMA_METADATA' : 'DATA912_METADATA'),
              nativeSymbol: symKey,
              ...(row.explicitUnderlying !== undefined ? { underlying: row.explicitUnderlying } : {}),
              strike: row.explicitStrike,
              ...(row.explicitExpirationDate !== undefined ? { contractualExpiry: row.explicitExpirationDate } : {}),
              unit: 'ARS',
            });
          }
          return out;
        };

        const resolveRowContract = (
          row: NormalizedQuoteRow,
          extraPrimary?: BymaContractMetadataRecord,
        ): ResolvedBymaOptionContract => {
          const symKey = row.symbol.trim().toUpperCase().replace(/[^A-Z0-9.,]/g, '').replace(/,/g, '.');
          return resolveBymaOptionContract({
            rawSymbol: row.symbol,
            metadataRecords: buildMetaRecordsForRow(row, symKey, extraPrimary),
            asOfUtcSec: nowSec,
            includeNearExpiry: true,
            arHolidays: this.arHolidays,
            knownUnderlyings: STOCK_META_MAP,
          });
        };

        let initialResolved = mergedOptionRows.map((row) => ({
          row,
          symKey: row.symbol.trim().toUpperCase().replace(/[^A-Z0-9.,]/g, '').replace(/,/g, '.'),
          resolved: resolveRowContract(row),
        }));

        const ambiguousForPrimary = [
          ...new Set(
            initialResolved
              .filter(
                (item) =>
                  item.resolved.strikeResolutionStatus === 'AMBIGUOUS_SCALE_UNRESOLVED' &&
                  item.resolved.underlying === underlying,
              )
              .map((item) => item.symKey),
          ),
        ].slice(0, 12);

        if (ambiguousForPrimary.length > 0 && this.primaryClient.isConfigured()) {
          const primaryDetails = await mapWithConcurrencyLimit(ambiguousForPrimary, 4, async (symKey) => {
            const detail = await this.primaryClient.getInstrumentDetail(symKey, 'ROFX').catch((): null => null);
            return { symKey, detail };
          });
          const fetchedPrimaryMap = new Map<string, BymaContractMetadataRecord>();
          for (const { symKey, detail } of primaryDetails) {
            if (
              detail !== null &&
              detail.strikePrice !== null &&
              Number.isFinite(detail.strikePrice) &&
              detail.strikePrice > 0
            ) {
              fetchedPrimaryMap.set(symKey, {
                source: 'PRIMARY_INSTRUMENT_DETAIL',
                nativeSymbol: symKey,
                underlying: detail.underlying,
                strike: detail.strikePrice,
                contractualExpiry: detail.maturityDate,
                unit: 'ARS',
              });
            }
          }
          if (fetchedPrimaryMap.size > 0) {
            initialResolved = initialResolved.map((item) => {
              const extraPrimary = fetchedPrimaryMap.get(item.symKey);
              return extraPrimary !== undefined
                ? { ...item, resolved: resolveRowContract(item.row, extraPrimary) }
                : item;
            });
          }
        }

        const parsedContracts: {
          readonly parsed: ParsedBymaOptionSymbol;
          readonly resolved: ResolvedBymaOptionContract;
          readonly row: NormalizedQuoteRow;
        }[] = [];
        const unresolvedContracts: ArUnresolvedOptionContractDto[] = [];
        const unresolvedByExpiry = new Map<string, ArUnresolvedOptionContractDto[]>();
        const rawRowBySymbol = new Map<string, NormalizedQuoteRow>();
        let resolvedExplicitCount = 0;
        let resolvedCanonicalCount = 0;
        let ambiguousUnresolvedCount = 0;
        let conflictingMetadataCount = 0;

        for (const { row, resolved } of initialResolved) {
          if (resolved.strikeResolutionStatus === 'INVALID_SYMBOL' || resolved.underlying !== underlying) {
            continue;
          }
          if (
            resolved.strikeResolutionStatus === 'AMBIGUOUS_SCALE_UNRESOLVED' ||
            resolved.strikeResolutionStatus === 'CONFLICTING_METADATA'
          ) {
            if (resolved.strikeResolutionStatus === 'AMBIGUOUS_SCALE_UNRESOLVED') {
              ambiguousUnresolvedCount += 1;
            } else {
              conflictingMetadataCount += 1;
            }
            const unresolvedDto: ArUnresolvedOptionContractDto = {
              symbol: resolved.nativeSymbol,
              underlying: resolved.underlying,
              contractType: resolved.side,
              strike: null,
              canonicalContractId: null,
              strikeResolutionStatus: resolved.strikeResolutionStatus,
              strikeSource: 'NONE',
              expiryCode: resolved.expiryCode,
              expirationDate: resolved.contractualExpiry,
              expiryUtcSec: resolved.expiryUtcSec,
              bid: sanitizeFinite(row.bid),
              bidSize: row.bidSize ?? null,
              ask: sanitizeFinite(row.ask),
              askSize: row.askSize ?? null,
              last: sanitizeFinite(row.last),
              volume: sanitizeFinite(row.nominalVol),
              openInterest: sanitizeFinite(row.openInterest),
              quoteSource: row.quoteSource ?? 'DATA912',
              quoteAsOfUtcSec: row.quoteAsOfUtcSec ?? null,
              exclusionReason:
                resolved.normalizationEvidence.exclusionReason ?? resolved.strikeResolutionStatus,
              normalizationEvidence: resolved.normalizationEvidence,
            };
            unresolvedContracts.push(unresolvedDto);
            if (resolved.contractualExpiry !== null) {
              const expBucket = unresolvedByExpiry.get(resolved.contractualExpiry);
              if (expBucket !== undefined) {
                expBucket.push(unresolvedDto);
              } else {
                unresolvedByExpiry.set(resolved.contractualExpiry, [unresolvedDto]);
              }
            }
            continue;
          }

          if (
            resolved.side === null ||
            resolved.strike === null ||
            resolved.contractualExpiry === null ||
            resolved.expiryCode === null ||
            resolved.expiryLabel === null ||
            resolved.expiryUtcSec === null ||
            resolved.daysToExpiry === null
          ) {
            continue;
          }

          if (resolved.strikeResolutionStatus === 'EXPLICIT_METADATA') {
            resolvedExplicitCount += 1;
          } else {
            resolvedCanonicalCount += 1;
          }

          const parsed: ParsedBymaOptionSymbol = {
            symbol: resolved.nativeSymbol,
            underlying: resolved.underlying,
            contractType: resolved.side,
            strike: resolved.strike,
            expiryCode: resolved.expiryCode,
            expiryLabel: resolved.expiryLabel,
            expirationDate: resolved.contractualExpiry,
            expiryUtcSec: resolved.expiryUtcSec,
            daysToExpiry: resolved.daysToExpiry,
          };
          parsedContracts.push({ parsed, resolved, row });
          rawRowBySymbol.set(parsed.symbol, row);
        }

        const strikeQuality: ArStrikeQualitySummaryDto = {
          resolvedExplicitCount,
          resolvedCanonicalCount,
          ambiguousUnresolvedCount,
          conflictingMetadataCount,
        };

        const providerErrors = [
          ...overview.providerErrors,
          ...macroData.errors,
          ...[optionsRes.error, histRes.error].filter((e): e is string => e !== null),
          ...(dualBmbSnap !== null &&
          dualBmbSnap.health.error !== null &&
          dualBmbSnap.health.status !== 'OUT_OF_SESSION' &&
          dualBmbSnap.health.status !== 'DISABLED_NO_PASSWORD'
            ? [redactSecrets(`BMB options degradado a Data912 EOD: ${dualBmbSnap.health.error}`, this.secrets)]
            : []),
        ];

        const byExpiry = new Map<string, typeof parsedContracts>();
        for (const item of parsedContracts) {
          const key = item.parsed.expirationDate;
          const bucket = byExpiry.get(key);
          if (bucket !== undefined) {
            bucket.push(item);
          } else {
            byExpiry.set(key, [item]);
          }
        }

        const sortedExpKeys = [...byExpiry.keys()].sort();
        const expiries: ArOptionExpiryDto[] = [];
        const allExposureInputs: ExposureContractInput[] = [];
        // Pieza 50.9: procedencia del OI usado por el motor (directo vs proxy de volumen).
        const oiEntries: { oi: OiFieldProvenance; index: number | null }[] = [];
        const exposureInputsByExpiry = new Map<string, ExposureContractInput[]>();
        const oiEntriesByExpiry = new Map<string, { oi: OiFieldProvenance; index: number | null }[]>();
        const ivStatusCountsByExpiry = new Map<string, Partial<Record<AmericanIvStatus, number>>>();
        const multiplier = Object.values(OPTION_PREFIX_TO_UNDERLYING).includes(underlying)
          ? resolveContractMultiplier(OPTION_LOT_SIZE, 'BYMA_STANDARD_TABLE')
          : null;
        const evalRate = continuousRate ?? Number.NaN;
        const ivStatusCounts: Partial<Record<AmericanIvStatus, number>> = {};

        for (const expKey of sortedExpKeys) {
          const bucket = byExpiry.get(expKey);
          if (bucket === undefined || bucket.length === 0) {
            continue;
          }
          const sample = bucket[0]?.parsed;
          if (sample === undefined) {
            continue;
          }
          const tExp = (sample.expiryUtcSec - nowSec) / 31_536_000;
          const calls: ArOptionContractDto[] = [];
          const puts: ArOptionContractDto[] = [];
          const volQuotes: VolQuoteInput[] = [];
          const strikeSet = new Set<number>();
          const sliceExposureInputs = exposureInputsByExpiry.get(sample.expiryCode) ?? [];
          const sliceOiEntries = oiEntriesByExpiry.get(sample.expiryCode) ?? [];
          const sliceIvStatusCounts = ivStatusCountsByExpiry.get(sample.expiryCode) ?? {};
          exposureInputsByExpiry.set(sample.expiryCode, sliceExposureInputs);
          oiEntriesByExpiry.set(sample.expiryCode, sliceOiEntries);
          ivStatusCountsByExpiry.set(sample.expiryCode, sliceIvStatusCounts);

          for (const { parsed, resolved, row } of bucket) {
            strikeSet.add(parsed.strike);
            const { bid, ask, last } = row;
            const resolution = solveImpliedVolAmericanDetailed({
              instrumentId: parsed.symbol, spot: spot ?? Number.NaN, strike: parsed.strike,
              rate: evalRate, dividendYield, contractType: parsed.contractType,
              asOfUtcSec: nowSec, expiryUtcSec: parsed.expiryUtcSec, bid, ask, last,
              source: row.quoteSource ?? 'DATA912', quoteAsOfUtcSec: row.quoteAsOfUtcSec ?? null,
              maxQuoteAgeSec: 30, bypassStaleness: overview.feedStatus === 'EOD_CIERRE',
              currency: 'ARS', exerciseStyle: 'AMERICAN', ...(multiplier ?? {}),
            });
            const ivStatus = resolution.modelStatus;
            ivStatusCounts[ivStatus] = (ivStatusCounts[ivStatus] ?? 0) + 1;
            sliceIvStatusCounts[ivStatus] = (sliceIvStatusCounts[ivStatus] ?? 0) + 1;
            const mid = resolution.observedQuote.referencePrice ?? (last !== null && last > 0 ? last : null);

            const feedOi = row.fieldProvenance?.openInterest ?? missingOi('FIELD_ABSENT_IN_FEED');
            const anexoOi = anexoB?.byContract.get(
              [underlying, parsed.expirationDate, parsed.contractType, Math.round(parsed.strike * 10_000)].join('|'),
            );
            const observedOi = anexoOi === undefined ? feedOi
              : feedOi.status === 'DIRECT_CONTRACT_OI' ? resolveOiSourcePrecedence(anexoOi, feedOi) : anexoOi;
            const proxyOi = options.allowProxyOi === true && observedOi.status === 'MISSING_OI'
              ? explicitVolumeOi(row.fieldProvenance?.volume, multiplier)
              : null;
            const oi = proxyOi ?? observedOi;
            const modelOpenInterest = oi.status === 'DIRECT_CONTRACT_OI' ? oi.contracts
              : oi.status === 'IAMC_ANEXO_B' ? oi.nominalShares
              : oi.status === 'EXPLICIT_PROXY' ? oi.estimatedContracts : null;
            const sharesPerContract = oi.status === 'DIRECT_CONTRACT_OI' || oi.status === 'EXPLICIT_PROXY'
              ? oi.contractMultiplier
              : oi.status === 'IAMC_ANEXO_B' ? oi.appliedMultiplier : null;
            const effectiveLotMultiplier = multiplier ?? (
              oi.status === 'DIRECT_CONTRACT_OI' || oi.status === 'EXPLICIT_PROXY'
                ? { contractMultiplier: oi.contractMultiplier, multiplierSource: oi.multiplierSource }
                : null
            );

            const intrinsic =
              spot !== null
                ? parsed.contractType === 'call'
                  ? Math.max(0, spot - parsed.strike)
                  : Math.max(0, parsed.strike - spot)
                : 0;

            const iv = resolution.impliedVol;
            const greeks = spot !== null && iv !== null
              ? greeksAmericanFiniteDiffOrAnalytical({
                  spot, strike: parsed.strike, timeToExpiry: tExp,
                  rate: evalRate, dividendYield, volatility: iv, contractType: parsed.contractType,
                })
              : null;

            if (iv !== null && mid !== null && mid > 0) {
              const effBid = bid !== null && bid > 0 ? bid : mid * 0.98;
              const effAsk = ask !== null && ask >= effBid ? ask : mid * 1.02;
              volQuotes.push({
                strike: parsed.strike,
                contractType: parsed.contractType,
                iv,
                bid: effBid,
                ask: effAsk,
                mid,
                openInterest: observedOi.status === 'DIRECT_CONTRACT_OI' ? observedOi.contracts : 0,
              });
            }

            const forward =
              spot !== null && Number.isFinite(evalRate)
                ? spot * Math.exp((evalRate - dividendYield) * tExp)
                : Number.NaN;

            let exposureIndex: number | null = null;
            let sliceExposureIndex: number | null = null;
            if (
              modelOpenInterest !== null &&
              sharesPerContract !== null &&
              spot !== null &&
              spot > 0 &&
              Number.isFinite(evalRate) &&
              Number.isFinite(forward) &&
              iv !== null
            ) {
              const expInput: ExposureContractInput = {
                contractType: parsed.contractType,
                strike: parsed.strike,
                expiryUtcSec: parsed.expiryUtcSec,
                openInterest: modelOpenInterest,
                ...(row.nominalVol !== null ? { volume: row.nominalVol } : {}),
                sharesPerContract,
                spot,
                forward,
                rate: evalRate,
                dividendYield,
                iv,
                ...(bid !== null && bid >= 0 ? { bid } : {}),
                ...(ask !== null && ask > 0 ? { ask } : {}),
              };
              exposureIndex = allExposureInputs.length;
              allExposureInputs.push(expInput);
              sliceExposureIndex = sliceExposureInputs.length;
              sliceExposureInputs.push(expInput);
            }
            if (parsed.expiryUtcSec > nowSec) {
              oiEntries.push({ oi, index: exposureIndex });
              sliceOiEntries.push({ oi, index: sliceExposureIndex });
            }

            const dto: ArOptionContractDto = {
              symbol: parsed.symbol,
              underlying: parsed.underlying,
              contractType: parsed.contractType,
              strike: parsed.strike,
              expiryCode: parsed.expiryCode,
              expirationDate: parsed.expirationDate,
              expiryUtcSec: parsed.expiryUtcSec,
              daysToExpiry: parsed.daysToExpiry,
              bid: sanitizeFinite(bid),
              bidSize: row.bidSize,
              ask: sanitizeFinite(ask),
              askSize: row.askSize,
              last: sanitizeFinite(last),
              changePct: sanitizeFinite(row.deltaPct),
              mark: sanitizeFinite(mid),
              theoreticalPrice: null,
              volume: sanitizeFinite(row.nominalVol),
              openInterest: observedOi.status === 'DIRECT_CONTRACT_OI' ? observedOi.contracts
                : observedOi.status === 'IAMC_ANEXO_B' && multiplier !== null
                  ? observedOi.nominalShares / multiplier.contractMultiplier : null,
              oiProvenance: oi,
              ...(row.fieldProvenance !== undefined ? { fieldProvenance: { ...row.fieldProvenance, openInterest: observedOi } } : {}),
              ...(multiplier ?? {}),
              canonicalContractId: resolved.canonicalContractId,
              strikeResolutionStatus: resolved.strikeResolutionStatus,
              strikeSource: resolved.strikeSource,
              normalizationEvidence: resolved.normalizationEvidence,
              iv: sanitizeFinite(iv),
              delta: sanitizeFinite(greeks?.delta),
              gamma: sanitizeFinite(greeks?.gamma),
              thetaDaily: sanitizeFinite(greeks?.thetaDaily),
              vegaPer1Pct: sanitizeFinite(greeks?.vegaPer1Pct),
              rho: sanitizeFinite(greeks?.rho),
              vanna: sanitizeFinite(greeks?.vanna),
              charm: sanitizeFinite(greeks?.charm),
              intrinsic: Math.round(intrinsic * 100) / 100,
              extrinsic: mid !== null ? sanitizeFinite(Math.max(0, mid - intrinsic)) : null,
              volumeArs: (() => {
                if (row.quoteSource === 'BMB_HOMEBROKER_BRIDGE') {
                  return sanitizeFinite(row.volumeArs);
                }
                const refPx = last !== null && last > 0 ? last : mid;
                return row.nominalVol !== null && row.nominalVol > 0 && refPx !== null && refPx > 0 && effectiveLotMultiplier !== null
                  ? sanitizeFinite(row.nominalVol * refPx * effectiveLotMultiplier.contractMultiplier)
                  : null;
              })(),
              ivStatus,
              ivResolution: resolution,
              ivOrigin: iv === null ? 'NONE' : 'SOLVED',
              source: 'DATA912',
              quoteSource: row.quoteSource ?? 'DATA912',
              quoteAsOfUtcSec: row.quoteAsOfUtcSec ?? null,
            };

            if (parsed.contractType === 'call') {
              calls.push(dto);
            } else {
              puts.push(dto);
            }
          }

          calls.sort((a, b) => a.strike - b.strike);
          puts.sort((a, b) => a.strike - b.strike);

          let ivAtm = Number.NaN;
          let riskReversal25 = Number.NaN;
          let butterfly25 = Number.NaN;
          let butterflyArbitrageFree = false;
          let validSlice: ReturnType<typeof buildVolSlice> | null = null;

          const computeNearAtmFallbackIv = (spotPx: number): number => {
            const nearAtmIvs = volQuotes
              .filter((q) => Math.abs(q.strike - spotPx) / spotPx <= 0.12)
              .map((q) => q.iv);
            return computeMedian(nearAtmIvs) ?? computeMedian(volQuotes.map((q) => q.iv)) ?? Number.NaN;
          };

          if (spot !== null && spot > 0 && Number.isFinite(evalRate) && volQuotes.length >= 4) {
            const forward = spot * Math.exp((evalRate - dividendYield) * tExp);
            const slice = buildVolSlice(
              {
                timeToExpiry: tExp,
                expirySec: sample.expiryUtcSec,
                forward,
                spot,
                rate: evalRate,
                dividendYield,
                quotes: volQuotes,
              },
              {
                requirePositiveBid: false,
                maxSpreadRatio: 0.9,
                minOpenInterest: 0,
                minPoints: 4,
                quoteSelection: 'otm',
              },
            );
            if (slice.isValid) {
              validSlice = slice;
              const metrics = computeSliceVolMetrics(slice, {
                spot,
                rate: evalRate,
                dividendYield,
                deltaConvention: 'spotBsm',
              });
              ivAtm = metrics.ivAtm;
              riskReversal25 = metrics.riskReversal25;
              butterfly25 = metrics.butterfly25;
              butterflyArbitrageFree = metrics.isButterflyArbitrageFree;
            }
            if (!Number.isFinite(ivAtm)) {
              // Mediana de IV de strikes cercanos al ATM (+/- 12%) si la interpolación de slice cae fuera de soporte
              ivAtm = computeNearAtmFallbackIv(spot);
            }
          } else if (new Set(volQuotes.map((q) => q.strike)).size >= 3 && spot !== null && spot > 0) {
            ivAtm = computeNearAtmFallbackIv(spot);
          }

          const sortedStrikes = [...strikeSet].sort((a, b) => a - b);

          const computeTheoForDto = (c: ArOptionContractDto): ArOptionContractDto => {
            if (spot === null || spot <= 0 || !Number.isFinite(evalRate)) {
              return c;
            }
            const sliceVol = validSlice !== null ? evaluateSliceIvAtStrike(validSlice, c.strike) : Number.NaN;
            const modelVol =
              Number.isFinite(sliceVol) && sliceVol > 0
                ? sliceVol
                : Number.isFinite(ivAtm) && ivAtm > 0
                  ? ivAtm
                  : Number.NaN;
            if (!Number.isFinite(modelVol) || modelVol <= 0) {
              return c;
            }
            if (sample.expiryUtcSec - nowSec <= MIN_CONTRACTUAL_EXPIRY_SEC) return c;
            const theo = priceAmericanBjerksund2002({
              spot, strike: c.strike, timeToExpiry: tExp, rate: evalRate,
              dividendYield, volatility: modelVol, contractType: c.contractType,
            });
            return Number.isFinite(theo) && theo >= 0
              ? { ...c, theoreticalPrice: Math.round(theo * 100) / 100, theoreticalPriceModel: 'AMERICAN_BS2002_SURFACE' }
              : c;
          };

          const pricedCalls = calls.map(computeTheoForDto);
          const pricedPuts = puts.map(computeTheoForDto);

          // Max Pain exacto sobre Open Interest positivo del vencimiento
          const observedNominal = (contract: ArOptionContractDto): number => {
            const oi = contract.oiProvenance;
            return oi?.status === 'IAMC_ANEXO_B' || oi?.status === 'DIRECT_CONTRACT_OI' ? oi.nominalShares : 0;
          };
          let totalOiExp = 0;
          for (const c of pricedCalls) {
            totalOiExp += observedNominal(c);
          }
          for (const p of pricedPuts) {
            totalOiExp += observedNominal(p);
          }
          let maxPainStrike: number | null = null;
          let maxPainDistPct: number | null = null;
          if (totalOiExp > 0 && sortedStrikes.length > 0) {
            let bestPayout = Number.POSITIVE_INFINITY;
            let bestDist = Number.POSITIVE_INFINITY;
            for (const candStrike of sortedStrikes) {
              let payout = 0;
              for (const c of pricedCalls) {
                if (candStrike > c.strike) {
                  payout += observedNominal(c) * (candStrike - c.strike);
                }
              }
              for (const p of pricedPuts) {
                if (p.strike > candStrike) {
                  payout += observedNominal(p) * (p.strike - candStrike);
                }
              }
              const distSpot = spot !== null && spot > 0 ? Math.abs(candStrike - spot) : 0;
              if (payout < bestPayout - 1e-6 || (Math.abs(payout - bestPayout) <= 1e-6 && distSpot < bestDist)) {
                bestPayout = payout;
                bestDist = distSpot;
                maxPainStrike = candStrike;
              }
            }
            if (maxPainStrike !== null && spot !== null && spot > 0) {
              maxPainDistPct = sanitizeFinite(((maxPainStrike - spot) / spot) * 100);
            }
          }

          const unresolvedForExp = unresolvedByExpiry.get(sample.expirationDate);
          expiries.push({
            expiryCode: sample.expiryCode,
            expiryLabel: sample.expiryLabel,
            expirationDate: sample.expirationDate,
            expiryUtcSec: sample.expiryUtcSec,
            days: sample.daysToExpiry,
            ivAtm: sanitizeFinite(ivAtm),
            riskReversal25: sanitizeFinite(riskReversal25),
            butterfly25: sanitizeFinite(butterfly25),
            butterflyArbitrageFree,
            maxPainStrike,
            maxPainDistPct,
            strikes: sortedStrikes,
            calls: pricedCalls,
            puts: pricedPuts,
            ...(unresolvedForExp !== undefined && unresolvedForExp.length > 0
              ? { unresolvedContracts: unresolvedForExp }
              : {}),
          });
        }

        // Vencimiento líquido principal: >= 5 bases con VI invertida y mayor volumen operado
        const liquidIvStrikeCount = (e: ArOptionExpiryDto): number =>
          new Set(
            [...e.calls, ...e.puts]
              .filter((c) => c.ivStatus === 'SOLVED_AMERICAN')
              .map((c) => c.strike),
          ).size;
        const expiryVolumeLots = (e: ArOptionExpiryDto): number =>
          [...e.calls, ...e.puts].reduce((acc, c) => acc + (c.volume !== null && c.volume > 0 ? c.volume : 0), 0);
        let primaryExp: ArOptionExpiryDto | undefined;
        for (const e of expiries) {
          if (liquidIvStrikeCount(e) < MIN_LIQUID_IV_STRIKES) {
            continue;
          }
          if (primaryExp === undefined || expiryVolumeLots(e) > expiryVolumeLots(primaryExp)) {
            primaryExp = e;
          }
        }
        if (primaryExp === undefined && expiries.length > 0) {
          primaryExp = [...expiries].sort(
            (a, b) => liquidIvStrikeCount(b) - liquidIvStrikeCount(a) || expiryVolumeLots(b) - expiryVolumeLots(a),
          )[0];
        }
        const termExpiries = expiries.filter(
          (e) => e.ivAtm !== null && (liquidIvStrikeCount(e) >= 3 || e === primaryExp),
        );
        const buildExposureSummaryForSlice = (
          sliceInputs: readonly ExposureContractInput[],
          sliceOiEntries: readonly { oi: OiFieldProvenance; index: number | null }[],
          sliceIvStatusCounts: Readonly<Partial<Record<AmericanIvStatus, number>>>,
          refExp: ArOptionExpiryDto | undefined,
        ): NonNullable<ArOptionsResponse['exposureSummary']> => {
          const expResult = computeDealerExposure(
            sliceInputs,
            {
              spot: spot ?? Number.NaN,
              nowUtcSec: nowSec,
              rate: evalRate,
              dividendYield,
              forward:
                refExp !== undefined && spot !== null
                  ? spot * Math.exp((evalRate - dividendYield) * ((refExp.expiryUtcSec - nowSec) / 31_536_000))
                  : spot ?? Number.NaN,
            },
            {
              model: 'american',
              wallCriterion: 'gex',
              wallScope: 'all',
              gammaFlipHalfWidth: 0.2,
              gammaFlipGridSteps: 80,
              gammaFlipMultiRootPolicy: 'nearestSpot',
              ivResolutionMode: 'ivOnly',
              ...(refExp !== undefined ? { expectedMoveExpirySec: refExp.expiryUtcSec } : {}),
              ...(refExp?.ivAtm !== null && refExp?.ivAtm !== undefined
                ? { expectedMoveIvAtmOverride: refExp.ivAtm }
                : {}),
            },
          );

          const arExposureStrikes = expResult.byStrike
            .map((s) => s.strike)
            .filter((value) => Number.isFinite(value));
          const arEngineStrikes = sliceInputs
            .map((input) => input.strike)
            .filter((value) => Number.isFinite(value));
          const arEngineExpirationDates = [
            ...new Set(
              sliceInputs.map((input) =>
                new Date(input.expiryUtcSec * 1_000).toISOString().slice(0, 10),
              ),
            ),
          ].sort();
          const marketValid = spot !== null && spot > 0 && Number.isFinite(evalRate);
          const skippedIndices = new Set(expResult.quality.skippedDetails.map(({ index }) => index));
          const evaluatedOi = sliceOiEntries.map(({ oi, index }) => ({
            oi, index, used: marketValid && index !== null && !skippedIndices.has(index) &&
              (Number.isFinite(expResult.netGex) || expResult.quality.zeroOiContracts > 0) &&
              (expResult.quality.usableContracts > 0 || ('nominalShares' in oi && oi.nominalShares === 0)),
          }));
          const { missingOiInputs, invalidOiInputs, observedZeroOiInputs, iamcOiInputs, directContractOiInputs,
            oiConflicts, ...gexQuality } = resolveArExposureOiQuality(evaluatedOi);
          const arOiProvenance: ArOiProvenanceInput[] = evaluatedOi
            .filter(({ used }) => used)
            .map(({ oi }) => ({ oiFromReported: oi.status !== 'EXPLICIT_PROXY', status: oi.status }));
          const arOiSummary = resolveArOiProvenance(arOiProvenance);
          const gexAvailable = gexQuality.gexStatus !== 'INVALID_DATA_OR_MODEL' &&
            gexQuality.gexStatus !== 'UNAVAILABLE_MISSING_OI';
          const hasOnlyZero = gexAvailable && expResult.quality.usableContracts === 0;
          // The engine accepts both IAMC shares and contracts. Publish OI in lot equivalents without fabricating lots when multiplier is unverified.
          const lotOiByStrike = new Map<number, Record<'call' | 'put', number>>();
          let usableOpenInterestLots = 0;
          let usableOpenInterestShares = 0;
          for (const { oi, used, index } of evaluatedOi) {
            const input = used && index !== null ? sliceInputs[index] : undefined;
            if (input === undefined) continue;
            const shares = oi.status === 'IAMC_ANEXO_B'
              ? oi.nominalShares
              : input.openInterest * input.sharesPerContract;
            usableOpenInterestShares += shares;
            if (oi.status === 'IAMC_ANEXO_B') {
              if (multiplier === null) continue;
              const lots = oi.nominalShares / multiplier.contractMultiplier;
              const totals = lotOiByStrike.get(input.strike) ?? { call: 0, put: 0 };
              totals[input.contractType] += lots;
              lotOiByStrike.set(input.strike, totals);
              usableOpenInterestLots += lots;
            } else {
              const lots = input.openInterest;
              const totals = lotOiByStrike.get(input.strike) ?? { call: 0, put: 0 };
              totals[input.contractType] += lots;
              lotOiByStrike.set(input.strike, totals);
              usableOpenInterestLots += lots;
            }
          }
          return {
            ...gexQuality,
            currency: 'ARS',
            gexUnit: 'ARS_PER_1PCT_SPOT_MOVE',
            dealerSignBasis: 'THEORETICAL_DEALER_PROXY',
            netGex: hasOnlyZero ? 0 : gexAvailable ? sanitizeFinite(expResult.netGex) : null,
            netDex: hasOnlyZero ? 0 : gexAvailable ? sanitizeFinite(expResult.netDex) : null,
            netVex: hasOnlyZero ? 0 : gexAvailable ? sanitizeFinite(expResult.netVannaExposure) : null,
            netCex: hasOnlyZero ? 0 : gexAvailable ? sanitizeFinite(expResult.netCharmExposure) : null,
            vannaRegime: expResult.vannaRegime,
            charmPinStrike: gexAvailable && !hasOnlyZero ? sanitizeFinite(expResult.charmPinStrike) : null,
            callWallStrike: gexAvailable && !hasOnlyZero ? sanitizeFinite(expResult.callWallStrike) : null,
            putWallStrike: gexAvailable && !hasOnlyZero ? sanitizeFinite(expResult.putWallStrike) : null,
            gammaFlipSpot: gexAvailable && !hasOnlyZero ? sanitizeFinite(expResult.gammaFlipSpot) : null,
            gammaFlipStatus: gexAvailable && !hasOnlyZero ? expResult.gammaFlipStatus : 'indeterminate',
            gammaFlipCandidates: gexAvailable ? expResult.gammaFlipCandidates.filter(Number.isFinite) : [],
            trace: {
              evaluationSec: nowSec,
              valuationSpot: spot !== null && Number.isFinite(spot) && spot > 0 ? spot : null,
              valuationSpotSource: arSpotSource,
              quoteMode: null,
              coverage: 'unknown',
              quoteTimes: null,
              engineExpirationDates: arEngineExpirationDates,
              engineStrikeRange: {
                min: arEngineStrikes.length > 0 ? Math.min(...arEngineStrikes) : null,
                max: arEngineStrikes.length > 0 ? Math.max(...arEngineStrikes) : null,
              },
              engineStrikeCount: sliceInputs.length,
              byStrikeRange: {
                min: arExposureStrikes.length > 0 ? Math.min(...arExposureStrikes) : null,
                max: arExposureStrikes.length > 0 ? Math.max(...arExposureStrikes) : null,
              },
              byStrikeCount: expResult.byStrike.length,
              missingOiInputs, invalidOiInputs, observedZeroOiInputs, iamcOiInputs, directContractOiInputs,
              oiConflicts, oiUniverseInputs: sliceOiEntries.length, ivStatusCounts: sliceIvStatusCounts,
              strikeQuality,
              directOiInputs: arOiSummary.directOiInputs,
              proxyOiInputs: arOiSummary.proxyOiInputs,
              oiProxy: arOiSummary.oiProxy,
            },
            expectedMoveAbs: sanitizeFinite(expResult.expectedMove.formulaMove),
            expectedMovePct: sanitizeFinite(expResult.expectedMove.formulaMovePct),
            expectedMoveExpirySec: refExp?.expiryUtcSec ?? null,
            expectedMoveExpiryCode: refExp?.expiryCode ?? null,
            expectedMoveDays: refExp?.days ?? null,
            quality: {
              usableContracts: expResult.quality.usableContracts,
              usableOpenInterest: usableOpenInterestLots,
              usableOpenInterestShares,
            },
            byStrike: (gexAvailable ? expResult.byStrike : []).map((s) => ({
              strike: s.strike,
              callOi: sanitizeFinite(lotOiByStrike.get(s.strike)?.call),
              putOi: sanitizeFinite(lotOiByStrike.get(s.strike)?.put),
              callVolume: sanitizeFinite(s.callVolume),
              putVolume: sanitizeFinite(s.putVolume),
              callGex: sanitizeFinite(s.callGex),
              putGex: sanitizeFinite(s.putGex),
              netGex: sanitizeFinite(s.netGex),
              vex: sanitizeFinite(s.netVannaExposure),
              cex: sanitizeFinite(s.netCharmExposure),
            })),
          };
        };

        let exposureSummary: ArOptionsResponse['exposureSummary'] = null;
        const exposureSummaryByExpiry: Record<string, NonNullable<ArOptionsResponse['exposureSummary']>> = {};
        if (expiries.length > 0) {
          exposureSummary = buildExposureSummaryForSlice(
            allExposureInputs,
            oiEntries,
            ivStatusCounts,
            primaryExp,
          );
          for (const e of expiries) {
            exposureSummaryByExpiry[e.expiryCode] = buildExposureSummaryForSlice(
              exposureInputsByExpiry.get(e.expiryCode) ?? [],
              oiEntriesByExpiry.get(e.expiryCode) ?? [],
              ivStatusCountsByExpiry.get(e.expiryCode) ?? {},
              e,
            );
          }
        }

        const termStructure = termExpiries
          .filter((e): e is ArOptionExpiryDto & { readonly ivAtm: number } => e.ivAtm !== null)
          .map((e) => ({
            days: e.days,
            label: e.expiryCode,
            expiryCode: e.expiryCode,
            atm: e.ivAtm,
          }));

        const primaryIvAtm = primaryExp?.ivAtm ?? null;
        const vrpSpread = primaryIvAtm !== null && rv20 !== null ? primaryIvAtm - rv20 : null;
        const exposureFinal = exposureSummary;

        // Motores Cuantitativos Institucionales (Piezas 15–18) para Opciones BYMA, por vencimiento
        const buildQuantEngines = (
          frontExp: ArOptionExpiryDto | undefined,
          nextExp: ArOptionExpiryDto | undefined,
          frontIvAtm: number | null,
        ): ArOptionsQuantEnginesDto | null => {
          if (!(spot !== null && spot > 0 && Number.isFinite(evalRate))) {
            return null;
          }
          const expExposureSummary =
            frontExp !== undefined ? exposureSummaryByExpiry[frontExp.expiryCode] ?? null : exposureFinal;
          const expExposureInputs =
            frontExp !== undefined ? exposureInputsByExpiry.get(frontExp.expiryCode) ?? [] : allExposureInputs;
          const exposureSummary = expExposureSummary;
          const evalSec = Math.floor(nowSec);
          const closedBars = normalizeClosedDailyBarsForEngines(bars.slice(-120), evalSec);
          const cclDiv = overview.cclMedian ?? overview.mepMedian ?? null;

          // 1) Order Flow Neto BYMA en ARS + USD-CCL y Anomalías Vol/OI MAD (Pieza 16)
          const printsArs: OpraTradePrintInput[] = [];
          const volOiInputs: VolOiAnomalyContractInput[] = [];
          for (const exp of frontExp !== undefined ? [frontExp] : expiries) {
            for (const c of [...exp.calls, ...exp.puts]) {
              const tradePx = c.last ?? c.mark;
              const vol = c.volume;
              if (
                vol !== null &&
                vol > 0 &&
                tradePx !== null &&
                tradePx > 0 &&
                c.bid !== null &&
                c.bid >= 0 &&
                c.ask !== null &&
                c.ask > 0
              ) {
                printsArs.push({
                  contractTicker: c.symbol,
                  underlyingTicker: underlying,
                  strike: c.strike,
                  expiryUtcSec: Math.floor(c.expiryUtcSec),
                  contractType: c.contractType,
                  price: tradePx,
                  size: vol,
                  bid: c.bid,
                  ask: c.ask,
                  ...(c.iv !== null && c.iv > 0 ? { impliedVolatility: c.iv } : {}),
                  timestampUtcSec: evalSec,
                  sharesPerContract: 1,
                });
              }
              if (
                c.volume !== null &&
                c.volume >= 0 &&
                c.openInterest !== null &&
                c.openInterest > 0 &&
                c.iv !== null &&
                c.iv > 0
              ) {
                volOiInputs.push({
                  contractTicker: c.symbol,
                  strike: c.strike,
                  expiryUtcSec: Math.floor(c.expiryUtcSec),
                  contractType: c.contractType,
                  dayVolume: c.volume,
                  openInterest: c.openInterest,
                  impliedVolatility: c.iv,
                  sharesPerContract: c.contractMultiplier ?? Number.NaN,
                });
              }
            }
          }

          const flowContext = {
            asOfUtcSec: evalSec,
            spot,
            rate: evalRate,
            dividendYield,
            model: 'american' as const,
          };

          const orderFlowArs =
            printsArs.length > 0
              ? computeSignedOptionsOrderFlow(printsArs, flowContext)
              : null;

          const expContractsForAggression =
            frontExp !== undefined
              ? [...frontExp.calls, ...frontExp.puts]
              : expiries.flatMap((e) => [...e.calls, ...e.puts]);
          const agresionTicks = computeArOptionsTickAggression(
            expContractsForAggression,
            rawRowBySymbol,
            OPTION_LOT_SIZE,
          );

          const netDirectionalPremiumUsdCcl =
            orderFlowArs !== null && cclDiv !== null && cclDiv > 0
              ? sanitizeFinite(orderFlowArs.netDirectionalPremiumUsd / cclDiv)
              : null;
          const callNetPremiumCvdUsdCcl =
            orderFlowArs !== null && cclDiv !== null && cclDiv > 0
              ? sanitizeFinite(orderFlowArs.callNetPremiumCvdUsd / cclDiv)
              : null;
          const putNetPremiumCvdUsdCcl =
            orderFlowArs !== null && cclDiv !== null && cclDiv > 0
              ? sanitizeFinite(orderFlowArs.putNetPremiumCvdUsd / cclDiv)
              : null;

          const volOiAnomalies =
            volOiInputs.length >= 2
              ? detectVolOiAnomaliesMad(
                  volOiInputs,
                  flowContext,
                  { minVolume: 1, minOpenInterest: 1, minBucketSize: 2 },
                )
              : null;

          // 2) Flow-Adjusted GEX + GEX/Charm Pin (Pieza 16)
          const marketExp = {
            spot,
            nowUtcSec: evalSec,
            rate: evalRate,
            dividendYield,
            forward:
              frontExp !== undefined
                ? spot * Math.exp((evalRate - dividendYield) * (frontExp.expiryUtcSec - nowSec) / 31_536_000)
                : spot,
          };

          const flowAdjustedGex =
            expExposureSummary?.netGex != null && (expExposureSummary.quality?.usableContracts ?? 0) > 0
              ? computeFlowAdjustedSignedGex(
                  expExposureInputs,
                  marketExp,
                  orderFlowArs?.byStrikeFlow ?? [],
                )
              : null;

          const gexCharmPin =
            expExposureSummary?.netGex != null && (expExposureSummary.quality?.usableContracts ?? 0) > 0
              ? computeGexCharmPin(expExposureInputs, marketExp, { maxPinDte: 60 })
              : null;

          // 3) Divergencia Probabilística Q vs P & Cono Vol (Pieza 17 + Pieza 45 PCHIP)
          let qDistribution: RiskNeutralDistributionResult | null = null;
          if (frontExp !== undefined) {
            const frontTExp = (frontExp.expiryUtcSec - nowSec) / 31_536_000;
            const nodeMap = new Map<number, RiskNeutralInputNode>();
            for (const c of [...frontExp.calls, ...frontExp.puts]) {
              if (c.iv !== null && c.iv > 0 && c.iv < IV_CAP_DECIMAL) {
                const isOtmSide =
                  (c.strike >= spot && c.contractType === 'call') ||
                  (c.strike < spot && c.contractType === 'put');
                if (!nodeMap.has(c.strike) || isOtmSide) {
                  nodeMap.set(c.strike, {
                    strike: c.strike,
                    iv: c.iv,
                    bid: c.bid !== null && Number.isFinite(c.bid) && c.bid > 0 ? c.bid : null,
                    ask: c.ask !== null && Number.isFinite(c.ask) && c.ask > 0 ? c.ask : null,
                  });
                }
              }
            }
            const nodes = [...nodeMap.values()].sort((a, b) => a.strike - b.strike);
            if (nodes.length >= 5) {
              const liquidBidCount = nodes.filter(
                (n) => n.bid !== null && n.bid !== undefined && n.bid > 0,
              ).length;
              const frontIvAtm = frontExp.ivAtm ?? Number.NaN;
              const frontEm = expectedMoveSigma(spot, frontIvAtm, frontTExp);
              qDistribution = extractRiskNeutralDistributionQ({
                spot,
                rate: evalRate,
                dividendYield,
                timeToExpiry: frontTExp,
                nodes,
                smoothTotalVariancePchip: true,
                requirePositiveBid: liquidBidCount >= 5,
                dte: frontExp.days,
                ...(Number.isFinite(frontEm) ? { expectedMove: frontEm } : {}),
                smoothShortDteDensity: true,
              });
            }
          }

          const horizonDays = Math.max(1, frontExp?.days ?? 21);
          const pDistribution =
            closedBars.length >= horizonDays + 5
              ? analyzeEmpiricalDistributionP(
                  closedBars.map((b) => ({ time: b.time, open: b.open, close: b.close })),
                  {
                    asOfUtcSec: evalSec,
                    spot,
                    horizonDays,
                    dailyRiskFreeRate: evalRate / 252,
                    minHistoryBars: horizonDays + 2,
                  },
                )
              : null;

          const targetLevels = [
            ...(exposureSummary?.callWallStrike !== null && exposureSummary?.callWallStrike !== undefined
              ? [{ label: 'Call Wall', price: exposureSummary.callWallStrike, direction: 'ABOVE' as const }]
              : []),
            ...(exposureSummary?.putWallStrike !== null && exposureSummary?.putWallStrike !== undefined
              ? [{ label: 'Put Wall', price: exposureSummary.putWallStrike, direction: 'BELOW' as const }]
              : []),
            { label: '+10% Upside', price: spot * 1.1, direction: 'ABOVE' as const },
            { label: '-10% Downside', price: spot * 0.9, direction: 'BELOW' as const },
          ];

          const pqDivergence =
            qDistribution !== null &&
            qDistribution.status === 'OK' &&
            pDistribution !== null &&
            pDistribution.status === 'OK' &&
            targetLevels.length > 0
              ? evaluatePqLevelDivergence({
                  spot,
                  qDistribution,
                  pDistribution,
                  targetLevels,
                })
              : null;

          const rollingRv20Series: number[] = [];
          for (let idx = 21; idx <= closedBars.length; idx += 1) {
            const rvSlice = computeDailyRealizedVol(closedBars.slice(idx - 21, idx), 20);
            if (rvSlice !== null && Number.isFinite(rvSlice) && rvSlice > 0) {
              rollingRv20Series.push(rvSlice);
            }
          }
          const rawVolCone =
            frontIvAtm !== null && frontIvAtm > 0
              ? computeVolConeAndRank({
                  spot,
                  ivAtm: frontIvAtm,
                  horizonsDays: [10, 20, 40, 60],
                  ivHistory: rollingRv20Series,
                  minIvHistoryCount: 5,
                })
              : null;
          const clampPct = (v: number): number =>
            Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : v;
          const volCone =
            rawVolCone === null
              ? null
              : {
                  ...rawVolCone,
                  ivRank: clampPct(rawVolCone.ivRank),
                  ivPercentile: clampPct(rawVolCone.ivPercentile),
                };

          // 4) Tasas Sintéticas, Conversion/Reversal, Buy-Write, Calendar Roll (Pieza 17)
          let syntheticRates: SyntheticImpliedRatesResult | null = null;
          let conversionReversal: ConversionReversalResult | null = null;
          let buyWrite: BuyWriteResult | null = null;
          let calendarRoll: CalendarRollResult | null = null;

          if (frontExp !== undefined && frontExp.days > 0) {
            const frontTExp = (frontExp.expiryUtcSec - nowSec) / 31_536_000;
            const callByStrike = new Map(frontExp.calls.map((c) => [c.strike, c]));
            const putByStrike = new Map(frontExp.puts.map((p) => [p.strike, p]));
            const pairs: { strike: number; callMid: number; putMid: number }[] = [];
            for (const strike of frontExp.strikes) {
              const c = callByStrike.get(strike);
              const p = putByStrike.get(strike);
              const cMid = c?.mark ?? c?.last ?? null;
              const pMid = p?.mark ?? p?.last ?? null;
              if (cMid !== null && cMid > 0 && pMid !== null && pMid > 0) {
                pairs.push({ strike, callMid: cMid, putMid: pMid });
              }
            }
            if (pairs.length > 0) {
              syntheticRates = computeSyntheticImpliedRates({
                spot,
                riskFreeRate: evalRate,
                dividendYield,
                timeToExpiry: frontTExp,
                dte: frontExp.days,
                pairs,
              });
            }

            // ATM executable Conversion/Reversal
            const sortedStrikes = [...frontExp.strikes].sort(
              (a, b) => Math.abs(a - spot) - Math.abs(b - spot),
            );
            const atmStrike = sortedStrikes[0];
            if (atmStrike !== undefined && rateTnaPct !== null) {
              const cAtm = callByStrike.get(atmStrike);
              const pAtm = putByStrike.get(atmStrike);
              const sBid = stock?.bid ?? spot;
              const sAsk = stock?.ask ?? spot;
              if (
                cAtm !== undefined &&
                pAtm !== undefined &&
                cAtm.bid !== null &&
                cAtm.bid > 0 &&
                cAtm.ask !== null &&
                cAtm.ask >= cAtm.bid &&
                pAtm.bid !== null &&
                pAtm.bid > 0 &&
                pAtm.ask !== null &&
                pAtm.ask >= pAtm.bid
              ) {
                conversionReversal = evaluateConversionReversal({
                  strike: atmStrike,
                  timeToExpiry: frontTExp,
                  riskFreeTna: rateTnaPct / 100,
                  spotBid: sBid,
                  spotAsk: sAsk,
                  callBid: cAtm.bid,
                  callAsk: cAtm.ask,
                  putBid: pAtm.bid,
                  putAsk: pAtm.ask,
                  stockFeeRate: BYMA_RV_FEE,
                  optionFeeRate: BYMA_OPTION_FEE,
                  vatRate: BYMA_VAT_RATE,
                  dte: frontExp.days,
                });
              }
            }

            // Covered Call (Buy-Write) sobre primer call OTM >= spot con Bid vivo
            const otmCall = [...frontExp.calls]
              .filter((c) => c.strike >= spot && c.bid !== null && c.bid > 0)
              .sort((a, b) => a.strike - b.strike)[0];
            if (otmCall !== undefined && otmCall.bid !== null) {
              buyWrite = evaluateBuyWrite({
                spotAsk: stock?.ask ?? spot,
                strike: otmCall.strike,
                callBid: otmCall.bid,
                timeToExpiry: frontTExp,
                stockFeeRate: BYMA_RV_FEE,
                optionFeeRate: BYMA_OPTION_FEE,
                vatRate: BYMA_VAT_RATE,
                dte: frontExp.days,
              });
            }

            // Calendar Roll si hay >= 2 vencimientos
            const secondExp = nextExp;
            if (secondExp !== undefined && secondExp.days > frontExp.days) {
              const farCallByStrike = new Map(secondExp.calls.map((c) => [c.strike, c]));
              const sharedCall = [...frontExp.calls]
                .filter((c) => {
                  const farC = farCallByStrike.get(c.strike);
                  return (
                    c.ask !== null &&
                    c.ask > 0 &&
                    c.thetaDaily !== null &&
                    c.vegaPer1Pct !== null &&
                    farC !== undefined &&
                    farC.bid !== null &&
                    farC.bid > 0 &&
                    farC.thetaDaily !== null &&
                    farC.vegaPer1Pct !== null
                  );
                })
                .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))[0];
              if (sharedCall !== undefined) {
                const farC = farCallByStrike.get(sharedCall.strike);
                if (
                  farC !== undefined &&
                  sharedCall.ask !== null &&
                  farC.bid !== null &&
                  sharedCall.thetaDaily !== null &&
                  farC.thetaDaily !== null &&
                  sharedCall.vegaPer1Pct !== null &&
                  farC.vegaPer1Pct !== null
                ) {
                  calendarRoll = evaluateCalendarRoll({
                    spot,
                    strike: sharedCall.strike,
                    nearAsk: sharedCall.ask,
                    farBid: farC.bid,
                    nearTimeToExpiry: (frontExp.expiryUtcSec - nowSec) / 31_536_000,
                    farTimeToExpiry: (secondExp.expiryUtcSec - nowSec) / 31_536_000,
                    nearThetaDaily: sharedCall.thetaDaily,
                    farThetaDaily: farC.thetaDaily,
                    nearVegaPer1Pct: sharedCall.vegaPer1Pct,
                    farVegaPer1Pct: farC.vegaPer1Pct,
                    optionFeeRate: BYMA_OPTION_FEE,
                    vatRate: BYMA_VAT_RATE,
                  });
                }
              }
            }
          }

          // 5) Confluencias Espaciales (< 0.15 ATR) + Optimizador "Las 3 Maneras de Jugarla" (Pieza 18)
          const dealerLevels: SpatialLevelInput[] = [];
          if (exposureSummary?.callWallStrike !== null && exposureSummary?.callWallStrike !== undefined) {
            dealerLevels.push({
              name: 'Call Wall',
              category: 'OPTIONS_DEALER',
              price: exposureSummary.callWallStrike,
              expectedReaction: 'RESISTANCE_BEARISH',
            });
          }
          if (exposureSummary?.putWallStrike !== null && exposureSummary?.putWallStrike !== undefined) {
            dealerLevels.push({
              name: 'Put Wall',
              category: 'OPTIONS_DEALER',
              price: exposureSummary.putWallStrike,
              expectedReaction: 'SUPPORT_BULLISH',
            });
          }
          if (exposureSummary?.gammaFlipSpot !== null && exposureSummary?.gammaFlipSpot !== undefined) {
            dealerLevels.push({
              name: 'Gamma Flip',
              category: 'OPTIONS_DEALER',
              price: exposureSummary.gammaFlipSpot,
              expectedReaction: 'MAGNET_NEUTRAL',
            });
          }
          if (gexCharmPin !== null && Number.isFinite(gexCharmPin.gexCharmPinStrike)) {
            dealerLevels.push({
              name: 'GEX/Charm Pin',
              category: 'OPTIONS_DEALER',
              price: gexCharmPin.gexCharmPinStrike,
              expectedReaction: 'MAGNET_NEUTRAL',
            });
          }
          const optionsDeltaFlowSign =
            orderFlowArs !== null
              ? orderFlowArs.netDeltaShares > 0
                ? 1
                : orderFlowArs.netDeltaShares < 0
                  ? -1
                  : 0
              : 0;
          const stockInst = this.computeStockInstitutionalEngines({
            asOfUtcSec: evalSec,
            spot,
            bars,
            benchmarkBars: bars,
            dealerLevels,
            optionsDeltaFlowSign,
          });
          const confluenceClusters = stockInst.confluenceClusters;

          let structureOptimizerBullish: OptimizeOptionStructuresResult | null = null;
          let structureOptimizerBearish: OptimizeOptionStructuresResult | null = null;
          let structureCostPercentile: StructureCostPercentileResult | null = null;

          if (
            frontExp !== undefined &&
            pDistribution !== null &&
            pDistribution.status === 'OK' &&
            pDistribution.projectedTerminalPrices.length >= 2
          ) {
            const optimizerContracts: OptimizerOptionContractInput[] = [];
            for (const c of [...frontExp.calls, ...frontExp.puts]) {
              if (
                c.bid !== null &&
                c.bid > 0 &&
                c.ask !== null &&
                c.ask >= c.bid &&
                c.delta !== null &&
                Number.isFinite(c.delta) &&
                c.iv !== null &&
                c.iv > 0
              ) {
                optimizerContracts.push({
                  strike: c.strike,
                  contractType: c.contractType,
                  bid: c.bid,
                  ask: c.ask,
                  delta: c.delta,
                  iv: c.iv,
                });
              }
            }

            if (optimizerContracts.length >= 2) {
              // Histograma empírico ordenado sobre projectedTerminalPrices
              const proj = [...pDistribution.projectedTerminalPrices].sort((a, b) => a - b);
              const minP = proj[0];
              const maxP = proj[proj.length - 1];
              if (minP !== undefined && maxP !== undefined && maxP > minP) {
                const binsCount = Math.min(20, Math.max(8, Math.floor(Math.sqrt(proj.length))));
                const step = (maxP - minP) / binsCount;
                const terminalPrices: number[] = [];
                const empiricalProbs: number[] = [];
                for (let bIdx = 0; bIdx < binsCount; bIdx += 1) {
                  const lowEdge = minP + bIdx * step;
                  const highEdge = bIdx === binsCount - 1 ? maxP + 1e-9 : lowEdge + step;
                  const count = proj.filter((v) => v >= lowEdge && v < highEdge).length;
                  if (count > 0) {
                    terminalPrices.push(lowEdge + 0.5 * step);
                    empiricalProbs.push(count / proj.length);
                  }
                }
                if (terminalPrices.length >= 2) {
                  structureOptimizerBullish = optimizeOptionStructures({
                    spot,
                    targetPrice: spot * 1.12,
                    direction: 'BULLISH',
                    dte: frontExp.days,
                    lotSize: OPTION_LOT_SIZE,
                    contracts: optimizerContracts,
                    terminalPrices,
                    empiricalProbs,
                    feeRate: BYMA_OPTION_FEE,
                    vatRate: BYMA_VAT_RATE,
                  });
                  structureOptimizerBearish = optimizeOptionStructures({
                    spot,
                    targetPrice: spot * 0.88,
                    direction: 'BEARISH',
                    dte: frontExp.days,
                    lotSize: OPTION_LOT_SIZE,
                    contracts: optimizerContracts,
                    terminalPrices,
                    empiricalProbs,
                    feeRate: BYMA_OPTION_FEE,
                    vatRate: BYMA_VAT_RATE,
                  });

                  const bestDebit =
                    structureOptimizerBullish.bestByExpectedValue ??
                    structureOptimizerBullish.bestByPop ??
                    structureOptimizerBullish.candidates[0] ??
                    null;
                  if (
                    bestDebit !== null &&
                    Number.isFinite(bestDebit.costPctOfWidth) &&
                    rollingRv20Series.length >= 10 &&
                    frontIvAtm !== null &&
                    frontIvAtm > 0
                  ) {
                    const costSeries = rollingRv20Series.map(
                      (rv) => bestDebit.costPctOfWidth * (rv / frontIvAtm),
                    );
                    structureCostPercentile = computeStructureCostPercentile({
                      currentCostPctOfWidth: bestDebit.costPctOfWidth,
                      historicalCostPctSeries: costSeries,
                    });
                  }
                }
              }
            }
          }

          return sanitizeJsonPayload({
            orderFlowArs,
            agresionTicks,
            netDirectionalPremiumUsdCcl,
            callNetPremiumCvdUsdCcl,
            putNetPremiumCvdUsdCcl,
            volOiAnomalies,
            flowAdjustedGex,
            gexCharmPin,
            qDistribution,
            pDistribution,
            pqDivergence,
            volCone,
            syntheticRates,
            conversionReversal,
            buyWrite,
            calendarRoll,
            structureOptimizerBullish,
            structureOptimizerBearish,
            structureCostPercentile,
            confluenceClusters,
          });
        };

        const nextExpiryAfter = (e: ArOptionExpiryDto): ArOptionExpiryDto | undefined =>
          termExpiries.find((x) => x.days > e.days) ?? expiries.find((x) => x.days > e.days);
        const quantEnginesByExpiry: Record<string, ArOptionsQuantEnginesDto | null> = {};
        for (const e of expiries) {
          if (liquidIvStrikeCount(e) >= 3 || e === primaryExp) {
            quantEnginesByExpiry[e.expiryCode] = buildQuantEngines(e, nextExpiryAfter(e), e.ivAtm);
          }
        }

        const qDistByExpiry = new Map<string, RiskNeutralDistributionResult | null>();
        for (const [code, qe] of Object.entries(quantEnginesByExpiry)) {
          const qd = qe?.qDistribution ?? null;
          if (qd !== null) {
            qDistByExpiry.set(code, {
              ...qd,
              rawArea: qd.rawArea ?? Number.NaN,
              normalizedArea: qd.normalizedArea ?? Number.NaN,
              meanQ: qd.meanQ ?? Number.NaN,
              varianceQ: qd.varianceQ ?? Number.NaN,
              stdDevQ: qd.stdDevQ ?? Number.NaN,
              skewnessQ: qd.skewnessQ ?? Number.NaN,
              excessKurtosisQ: qd.excessKurtosisQ ?? Number.NaN,
              nodes: qd.nodes.map((n) => ({
                strike: n.strike ?? Number.NaN,
                iv: n.iv ?? Number.NaN,
                callPrice: n.callPrice ?? Number.NaN,
                dCdK: n.dCdK ?? Number.NaN,
                d2CdK2: n.d2CdK2 ?? Number.NaN,
                probAboveQ: n.probAboveQ ?? Number.NaN,
                rawDensityQ: n.rawDensityQ ?? Number.NaN,
                densityQ: n.densityQ ?? Number.NaN,
              })),
            });
          }
        }

        const closedBarsVolSuite = normalizeClosedDailyBarsForEngines(
          bars.slice(-760),
          Math.floor(nowSec),
        );
        const volAnalyticsSuiteBase = this.buildArVolAnalyticsSuite({
          underlying,
          spot,
          spotBid: stock?.bid ?? null,
          spotAsk: stock?.ask ?? null,
          evalRate,
          continuousRate,
          dividendYield,
          nowSec: Math.floor(nowSec),
          closedBars: closedBarsVolSuite,
          expiries,
          termExpiries,
          primaryExp,
          qDistByExpiry,
          bmbSnap: dualBmbSnap,
          macroVars: macroData.variables,
          adrSnap: dualAdrSnap,
          adrBars: dualAdrBarsRes?.bars ?? [],
          adrTicker: dualAdrTicker,
          adrRatio: dualMeta?.adrRatio ?? null,
        });

        if (volAnalyticsSuiteBase !== null) {
          for (const [code, qe] of Object.entries(quantEnginesByExpiry)) {
            if (qe !== null) {
              const expVrp = volAnalyticsSuiteBase.expiriesByCode[code]?.activeExpiryVrp;
              quantEnginesByExpiry[code] = sanitizeJsonPayload({
                ...qe,
                volAnalyticsSuite: {
                  ...volAnalyticsSuiteBase,
                  activeExpiryCode: code,
                  ...(expVrp !== undefined
                    ? {
                        historicalConditional: {
                          ...volAnalyticsSuiteBase.historicalConditional,
                          currentEvalVolPct: expVrp.ivAtmActiveExpiryPct,
                          vrpVsRv23Pts: expVrp.vrpActiveExpiryPts,
                          ivRank: expVrp.ivRankActiveExpiry,
                          ivPercentile: expVrp.ivPercentileActiveExpiry,
                          operativeRegime: expVrp.operativeRegime,
                        },
                      }
                    : {}),
                },
              });
            }
          }
        }

        const quantEngines: ArOptionsQuantEnginesDto | null =
          primaryExp !== undefined ? (quantEnginesByExpiry[primaryExp.expiryCode] ?? null) : null;

        const feedStatus: FeedStatus =
          spot === null && expiries.length === 0
            ? 'NO_DATA'
            : expiries.length === 0 || rateTnaPct === null
              ? 'PARTIAL'
              : hasLiveBmbOptions
                ? 'LIVE'
                : overview.feedStatus;

        return {
          asOfUtcSec: nowSec,
          feedStatus,
          underlying,
          spot: sanitizeFinite(spot),
          rateTna: sanitizeFinite(rateTnaPct),
          continuousRate: sanitizeFinite(continuousRate),
          dividendYield,
          lotSize: OPTION_LOT_SIZE,
          settlement: 'T+0' as const,
          exerciseCutoffArt: '15:30 ART' as const,
          realizedVol20d: sanitizeFinite(rv20),
          realizedVol60d: sanitizeFinite(rv60),
          histMedianIv: sanitizeFinite(rv60 !== null ? rv60 * 1.12 : null),
          vrpSpread: sanitizeFinite(vrpSpread),
          historicalCloses,
          termStructure,
          expiries,
          unresolvedContracts,
          strikeQuality,
          exposureSummary,
          exposureSummaryByExpiry,
          costSchedule: {
            rvMarketFeeRate: BYMA_RV_FEE,
            optionsFeeRate: BYMA_OPTION_FEE,
            shortLoanFeeRate: BYMA_SHORT_LOAN_FEE,
            vatRate: BYMA_VAT_RATE,
            bondsVatExempt: true as const,
          },
          quantEngines,
          primaryLiquidExpiryCode: primaryExp?.expiryCode ?? null,
          quantEnginesByExpiry,
          providerErrors,
        };
      },
      { forceRefresh },
    );

    const result = cached.value as ArOptionsResponse;
    this.lastOptionsBySymbol.set(rawUnderlying.trim().toUpperCase(), result);
    return result;
  }

  private async getUsDailyBars1dMap(
    symbols: readonly string[],
    lookbackBars = 90,
    forceRefresh = false,
  ): Promise<{
    readonly bySymbol: ReadonlyMap<string, readonly Bar[]>;
    readonly errors: readonly string[];
  }> {
    const unique = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter((s) => s !== ''))];
    const injectedRuntime = this.usRuntime;
    const providerFn =
      this.usDailyBarsFn ??
      (injectedRuntime !== null
        ? (sym: string, lb?: number, fr?: boolean) =>
            injectedRuntime.getCachedDailyBars1d(sym, lb, fr)
        : null);

    let effectiveFn = providerFn;
    if (effectiveFn === null && this.allowSharedUsRuntime) {
      const shared = getSharedMarketRuntime();
      const rt = shared ?? (this.lazyUsRuntime ??= new MarketRuntime({ enableWs: false, secrets: this.secrets }));
      effectiveFn = (sym: string, lb?: number, fr?: boolean) =>
        rt.getCachedDailyBars1d(sym, lb, fr);
    }

    const bySymbol = new Map<string, readonly Bar[]>();
    const errors: string[] = [];
    if (effectiveFn === null) {
      return { bySymbol, errors };
    }

    const results = await Promise.all(
      unique.map(async (sym) => {
        const res = await effectiveFn(sym, lookbackBars, forceRefresh);
        return res;
      }),
    );

    for (const res of results) {
      bySymbol.set(res.symbol, res.bars);
      if (res.error !== null) {
        errors.push(`Massive 1D ${res.symbol}: ${res.error}`);
      }
    }
    return { bySymbol, errors };
  }

  public async getRelations(forceRefresh = false): Promise<ArRelationsResponse> {
    const cached = await this.computedCache.getOrCompute(
      'ar:relations',
      async () => {
        const nowSec = Math.floor(this.nowMsFn() / 1_000);
        const panelLiderTickers = AR_STOCK_META.filter((m) => m.panel === 'Líder').map((m) => m.ticker);
        const bondTickers = ['GD30D', 'AL30D', 'GD35D', 'GD30', 'AL30', 'GD30C', 'AL30C'] as const;

        const [overview, stockHistEntries, bondHistEntries, vistaH, spyH, qqqH, usDailyRes] = await Promise.all([
          this.getOverviewCore(forceRefresh),
          Promise.all(
            panelLiderTickers.map(async (ticker) => [
              ticker,
              await this.getData912History('stocks', ticker, forceRefresh),
            ] as const),
          ),
          Promise.all(
            bondTickers.map(async (ticker) => [
              ticker,
              await this.getData912History('bonds', ticker, forceRefresh),
            ] as const),
          ),
          this.getCedearHistoryWithAlias('VISTA', forceRefresh),
          this.getData912History('cedears', 'SPY', forceRefresh),
          this.getData912History('cedears', 'QQQ', forceRefresh),
          this.getUsDailyBars1dMap(DEFAULT_RELATIONS_US_TICKERS, 90, forceRefresh),
        ]);

        const arStockMap = new Map<
          string,
          { readonly bars: readonly Bar[]; readonly error: string | null }
        >(stockHistEntries);
        const arBondMap = new Map<
          string,
          { readonly bars: readonly Bar[]; readonly error: string | null }
        >(bondHistEntries);
        const stockBars = (ticker: string): readonly Bar[] => arStockMap.get(ticker)?.bars ?? [];
        const bondBars = (ticker: string): readonly Bar[] => arBondMap.get(ticker)?.bars ?? [];
        const usBars = (ticker: string): readonly Bar[] => usDailyRes.bySymbol.get(ticker) ?? [];

        const buildDtoFromSeries = (meta: {
          readonly id: string;
          readonly name: string;
          readonly legA: string;
          readonly legB: string;
          readonly unit: string;
          readonly category: string;
          readonly categoryGroup: RelationCategoryGroup;
          readonly source: 'MASSIVE_1D' | 'DATA912' | 'MIXED_USD_CCL';
          readonly series: readonly RelationSeriesPoint[];
        }): ArRelationPairDto => {
          const stats = computeRelationPairStats(meta.series, null, 20);
          const signal =
            stats.zScore === null
              ? stats.observationCount > 0 && stats.observationCount < 20
                ? 'Sin historial suficiente (mín. 20 ruedas)'
                : 'Sin historial suficiente'
              : stats.zScore >= 2.0
                ? `${meta.legA} muy caro relativo a ${meta.legB} (+${stats.zScore.toFixed(1)}σ)`
                : stats.zScore <= -2.0
                  ? `${meta.legA} barato relativo a ${meta.legB} (${stats.zScore.toFixed(1)}σ)`
                  : 'Dentro de rango histórico 60 ruedas';

          return {
            id: meta.id,
            name: meta.name,
            legA: meta.legA,
            legB: meta.legB,
            unit: meta.unit,
            category: meta.category,
            categoryGroup: meta.categoryGroup,
            source: meta.source,
            currentValue: stats.currentValue,
            mean60d: stats.mean60d,
            std60d: stats.std60d,
            zScore: stats.zScore,
            percentile60d: stats.percentile60d,
            halfLifeDays: stats.halfLifeDays,
            capitalFlowDeltaPct: stats.capitalFlowDeltaPct,
            opportunityBadge: stats.opportunityBadge,
            observationCount: stats.observationCount,
            sparkline: stats.sparkline,
            signal,
            history: stats.history,
          };
        };

        const buildPair = (
          id: string,
          name: string,
          legA: string,
          legB: string,
          unit: string,
          barsA: readonly Bar[],
          barsB: readonly Bar[],
          mode: 'DIFF' | 'RATIO',
          opts?: {
            readonly category?: string;
            readonly categoryGroup?: RelationCategoryGroup;
            readonly source?: 'MASSIVE_1D' | 'DATA912' | 'MIXED_USD_CCL';
            readonly includeVolumeShare?: boolean;
          },
        ): ArRelationPairDto =>
          buildDtoFromSeries({
            id,
            name,
            legA,
            legB,
            unit,
            category: opts?.category ?? 'RELACIÓN LOCAL',
            categoryGroup: opts?.categoryGroup ?? (mode === 'DIFF' ? 'LIQUIDEZ_CREDITO' : 'ROTACION_SECTORIAL'),
            source: opts?.source ?? 'DATA912',
            series: alignDailyPairSeries(barsA, barsB, mode, opts?.includeVolumeShare ?? mode === 'RATIO', false),
          });

        const livePairRatio = (numTicker: string, denTicker: string): number | null => {
          const num =
            overview.mervalStocks.find((s) => s.ticker === numTicker)?.last ??
            overview.generalPanelStocks.find((s) => s.ticker === numTicker)?.last ??
            null;
          const den =
            overview.cedears.find(
              (s) => s.ticker === denTicker || (denTicker === 'VIST' && s.ticker === 'VISTA'),
            )?.last ?? null;
          return num !== null && num > 0 && den !== null && den > 0 ? num / den : null;
        };

        const gd30dBars = bondBars('GD30D');
        const al30dBars = bondBars('AL30D');
        const gd35dBars = bondBars('GD35D');
        const gd30Bars = bondBars('GD30');
        const al30Bars = bondBars('AL30');
        const gd30cBars = bondBars('GD30C');
        const al30cBars = bondBars('AL30C');

        const ggalAr = stockBars('GGAL');
        const bmaAr = stockBars('BMA');
        const ypfdAr = stockBars('YPFD');
        const pampAr = stockBars('PAMP');

        const gd30Al30Pair = buildPair(
          'gd30-al30',
          'Spread Legislación GD30D - AL30D',
          'GD30D',
          'AL30D',
          'USD',
          gd30dBars,
          al30dBars,
          'DIFF',
          { category: 'LEGISLACIÓN & SOBERANOS', categoryGroup: 'LIQUIDEZ_CREDITO', includeVolumeShare: false },
        );
        const ggalBmaPair = buildPair(
          'ggal-bma',
          'Ratio Bancos GGAL / BMA',
          'GGAL',
          'BMA',
          'x',
          ggalAr,
          bmaAr,
          'RATIO',
          { category: 'BANCOS LOCAL · BYMA', categoryGroup: 'ROTACION_SECTORIAL', includeVolumeShare: true },
        );

        const vistaPair = buildPair('ypfd-vista', 'Ratio Energía YPFD / VIST', 'YPFD', 'VIST', 'x', ypfdAr, vistaH.bars, 'RATIO', {
          category: 'ENERGÍA LOCAL · BYMA',
          categoryGroup: 'ROTACION_SECTORIAL',
          includeVolumeShare: false,
        });
        // Data912 no publica /historical para VIST/VISTA: valor actual real desde cotizaciones vivas, sin estadísticas inventadas.
        const vistaLive = vistaPair.currentValue === null ? livePairRatio('YPFD', 'VIST') : null;
        const vistaPairFinal: ArRelationPairDto =
          vistaLive !== null
            ? {
                ...vistaPair,
                currentValue: sanitizeFinite(vistaLive),
                signal: 'Sin historial: Data912 no publica /historical para VIST (valor actual en vivo)',
              }
            : vistaPair;

        const pairs: ArRelationPairDto[] = [gd30Al30Pair, ggalBmaPair, vistaPairFinal];

        const ypfdPampPair = buildPair(
          'ypfd-pamp',
          'Ratio Energía Local YPFD / PAMP',
          'YPFD',
          'PAMP',
          'x',
          ypfdAr,
          pampAr,
          'RATIO',
          { category: 'ENERGÍA LOCAL · BYMA', categoryGroup: 'ROTACION_SECTORIAL', includeVolumeShare: true },
        );

        const extendedPairs: ArRelationPairDto[] = [
          ...pairs,
          ypfdPampPair,
          buildPair('spy-qqq', 'Ratio Índices CEDEAR SPY / QQQ', 'SPY', 'QQQ', 'x', spyH.bars, qqqH.bars, 'RATIO', {
            category: 'ROTACIÓN US · TECH',
            categoryGroup: 'ROTACION_SECTORIAL',
            includeVolumeShare: true,
          }),
        ];

        // Pares globales & ADR USD vía Massive 1D (90 ruedas cerradas ajustadas)
        const usSpecs: readonly {
          readonly id: string;
          readonly name: string;
          readonly legA: string;
          readonly legB: string;
          readonly category: string;
          readonly categoryGroup: RelationCategoryGroup;
        }[] = [
          {
            id: 'ypf-vist',
            name: 'Vaca Muerta YPF / VIST (NYSE USD)',
            legA: 'YPF',
            legB: 'VIST',
            category: 'ROTACIÓN AR · VACA MUERTA',
            categoryGroup: 'ROTACION_SECTORIAL',
          },
          {
            id: 'ggal-ewz',
            name: 'Bancos AR vs. Brasil GGAL ADR / EWZ',
            legA: 'GGAL',
            legB: 'EWZ',
            category: 'ROTACIÓN LATAM · AR VS BR',
            categoryGroup: 'ROTACION_SECTORIAL',
          },
          {
            id: 'qqq-spy',
            name: 'Rotación US Tech QQQ / SPY',
            legA: 'QQQ',
            legB: 'SPY',
            category: 'ROTACIÓN US · TECH',
            categoryGroup: 'ROTACION_SECTORIAL',
          },
          {
            id: 'iwm-spy',
            name: 'Apetito Small Caps IWM / SPY',
            legA: 'IWM',
            legB: 'SPY',
            category: 'ROTACIÓN US · RISK-ON',
            categoryGroup: 'ROTACION_SECTORIAL',
          },
          {
            id: 'xlf-xle',
            name: 'Financieras vs. Energía Global XLF / XLE',
            legA: 'XLF',
            legB: 'XLE',
            category: 'ROTACIÓN US · SECTORES',
            categoryGroup: 'ROTACION_SECTORIAL',
          },
          {
            id: 'hyg-lqd',
            name: 'Liquidez & Crédito High Yield HYG / LQD',
            legA: 'HYG',
            legB: 'LQD',
            category: 'LIQUIDEZ & CRÉDITO US',
            categoryGroup: 'LIQUIDEZ_CREDITO',
          },
          {
            id: 'gld-spy',
            name: 'Refugio Oro vs. S&P 500 GLD / SPY',
            legA: 'GLD',
            legB: 'SPY',
            category: 'REFUGIO & LIQUIDEZ MACRO',
            categoryGroup: 'LIQUIDEZ_CREDITO',
          },
        ];

        const usRelationPairs = usSpecs.map((spec) =>
          buildPair(spec.id, spec.name, spec.legA, spec.legB, 'x', usBars(spec.legA), usBars(spec.legB), 'RATIO', {
            category: spec.category,
            categoryGroup: spec.categoryGroup,
            source: 'MASSIVE_1D',
            includeVolumeShare: true,
          }),
        );

        // CCL histórico mediano (bonos cable + ADRs NYSE vs. BYMA)
        const cclSources = {
          gd30Bars,
          gd30cBars,
          al30Bars,
          al30cBars,
          equityPairs: [
            { arBars: ggalAr, usBars: usBars('GGAL'), adrRatio: 10 },
            { arBars: bmaAr, usBars: usBars('BMA'), adrRatio: 10 },
            { arBars: ypfdAr, usBars: usBars('YPF'), adrRatio: 1 },
            { arBars: pampAr, usBars: usBars('PAM'), adrRatio: 25 },
          ],
        } as const;
        const cclHistorical = buildHistoricalCclByDate(cclSources);

        // Canasta Bancos vs. Energía AR en USD-CCL
        const bancosEnergySeries = computeBasketRelativeSeries({
          numBarsList: ['GGAL', 'BMA', 'SUPV', 'BBAR'].map(stockBars),
          denBarsList: ['YPFD', 'PAMP', 'TGSU2', 'CEPU'].map(stockBars),
          deflatorByDate: cclHistorical.byDate,
          denominatorAggregator: 'EQUAL_RETURN_INDEX',
          denominatorIsSuperset: false,
        });
        const bancosEnergiaArPair = buildDtoFromSeries({
          id: 'bancos-energia-ar',
          name: 'Canasta Bancos vs. Energía AR (USD-CCL)',
          legA: 'BANCOS AR',
          legB: 'ENERGÍA AR',
          unit: 'x',
          category: 'ROTACIÓN SECTORIAL AR · USD CCL',
          categoryGroup: 'ROTACION_SECTORIAL',
          source: 'MIXED_USD_CCL',
          series: bancosEnergySeries,
        });

        // Reguladas / Utilities vs. Mediana del Panel Líder AR
        const reguladasSeries = computeBasketRelativeSeries({
          numBarsList: ['TRAN', 'EDN', 'METR', 'TGNO4'].map(stockBars),
          denBarsList: panelLiderTickers.map(stockBars),
          deflatorByDate: null,
          denominatorAggregator: 'MEDIAN_RETURN_INDEX',
          denominatorIsSuperset: true,
        });
        const reguladasLiderPair = buildDtoFromSeries({
          id: 'reguladas-lider',
          name: 'Reguladas / Utilities vs. Panel Líder AR',
          legA: 'REGULADAS AR',
          legB: 'PANEL LÍDER',
          unit: 'x',
          category: 'ROTACIÓN AR · REGULADAS',
          categoryGroup: 'ROTACION_SECTORIAL',
          source: 'DATA912',
          series: reguladasSeries,
        });

        const gd35Gd30Pair = buildPair(
          'gd35-gd30',
          'Curva Soberana GD35D / GD30D',
          'GD35D',
          'GD30D',
          'x',
          gd35dBars,
          gd30dBars,
          'RATIO',
          { category: 'CURVA SOBERANA USD', categoryGroup: 'LIQUIDEZ_CREDITO', includeVolumeShare: false },
        );

        const ggalSupvPair = buildPair(
          'ggal-supv',
          'Ratio Bancos GGAL / SUPV',
          'GGAL',
          'SUPV',
          'x',
          ggalAr,
          stockBars('SUPV'),
          'RATIO',
          { category: 'BANCOS LOCAL · BYMA', categoryGroup: 'ROTACION_SECTORIAL', includeVolumeShare: true },
        );

        const canjeSeries = computeHistoricalCanjeSeries({
          ...cclSources,
          gd30dBars,
          al30dBars,
        });
        let cclMepPair = buildDtoFromSeries({
          id: 'ccl-mep',
          name: 'Canje Implícito CCL / MEP (%)',
          legA: 'CCL',
          legB: 'MEP',
          unit: '%',
          category: 'CANJE & LIQUIDEZ FX',
          categoryGroup: 'LIQUIDEZ_CREDITO',
          source: 'MIXED_USD_CCL',
          series: canjeSeries,
        });
        if (
          cclMepPair.currentValue === null &&
          overview.cclMedian !== null &&
          overview.mepMedian !== null &&
          overview.mepMedian > 0
        ) {
          cclMepPair = {
            ...cclMepPair,
            currentValue: sanitizeFinite(((overview.cclMedian / overview.mepMedian) - 1) * 100),
            signal: 'Sin historial suficiente (solo canje spot en vivo)',
          };
        }

        const relationPairs: ArRelationPairDto[] = [
          ...usRelationPairs,
          bancosEnergiaArPair,
          reguladasLiderPair,
          gd30Al30Pair,
          gd35Gd30Pair,
          ypfdPampPair,
          ggalBmaPair,
          ggalSupvPair,
          cclMepPair,
        ];

        const extremeTwoSigmaCount = relationPairs.filter(
          (p) => p.zScore !== null && Math.abs(p.zScore) >= 2.0,
        ).length;
        const moderateDeviationCount = relationPairs.filter(
          (p) => p.zScore !== null && Math.abs(p.zScore) >= 1.5 && Math.abs(p.zScore) < 2.0,
        ).length;

        let topFlowPair: ArRelationPairDto | null = null;
        for (const p of relationPairs) {
          const flow = p.capitalFlowDeltaPct ?? null;
          if (flow === null || !Number.isFinite(flow)) {
            continue;
          }
          const prevFlow = topFlowPair?.capitalFlowDeltaPct ?? null;
          if (prevFlow === null || Math.abs(flow) > Math.abs(prevFlow)) {
            topFlowPair = p;
          }
        }
        const topCapitalFlowDeltaPct =
          topFlowPair !== null ? sanitizeFinite(topFlowPair.capitalFlowDeltaPct) : null;
        const topCapitalFlowSector =
          topFlowPair !== null && topCapitalFlowDeltaPct !== null
            ? topCapitalFlowDeltaPct >= 0
              ? `${topFlowPair.legA} · ${topFlowPair.category ?? topFlowPair.name}`
              : `${topFlowPair.legB} · ${topFlowPair.category ?? topFlowPair.name}`
            : null;

        const relationSummary: ArRelationsSummaryDto = {
          extremeTwoSigmaCount,
          moderateDeviationCount,
          topCapitalFlowPairId: topFlowPair?.id ?? null,
          topCapitalFlowSector,
          topCapitalFlowDeltaPct,
        };

        const rawErrors = [
          ...overview.providerErrors,
          ...['GD30D', 'AL30D', 'GD35D', 'GGAL', 'BMA', 'YPFD', 'PAMP'].flatMap((tk) => {
            const err = arBondMap.get(tk)?.error ?? arStockMap.get(tk)?.error ?? null;
            return err !== null ? [err] : [];
          }),
          ...[vistaH.error].filter((e): e is string => e !== null),
          ...usDailyRes.errors,
        ];
        const providerErrors = [...new Set(rawErrors)];

        return {
          asOfUtcSec: nowSec,
          feedStatus:
            pairs.some((p) => p.currentValue !== null) || relationPairs.some((p) => p.currentValue !== null)
              ? overview.feedStatus
              : 'PARTIAL',
          providerErrors,
          pairs,
          extendedPairs,
          relationPairs,
          relationSummary,
          mepCclArbitrage: overview.mepCclMatrix,
        };
      },
      { forceRefresh },
    );

    return cached.value as ArRelationsResponse;
  }

  public async getPositionsAndAccount(forceRefresh = false): Promise<ArBrokerPositionsResponse> {
    const nowSec = Math.floor(this.nowMsFn() / 1_000);
    const [primaryRes, bmbSnap] = await Promise.all([
      this.primaryClient.getAccountPositionsAndReport(),
      this.bmbClient.getSnapshot(undefined, null, forceRefresh),
    ]);

    const rawErrors: string[] = [];
    if (primaryRes.summary.error !== null) {
      rawErrors.push(primaryRes.summary.error);
    }
    if (bmbSnap.health.error !== null && bmbSnap.health.status !== 'DISABLED_NO_PASSWORD') {
      rawErrors.push(bmbSnap.health.error);
    }
    const allSecrets = this.getSecrets();
    const providerErrors = rawErrors.map((msg) => redactSecrets(msg, allSecrets));

    return {
      asOfUtcSec: nowSec,
      primaryStatus: primaryRes.summary.status,
      bmbStatus: bmbSnap.health.status,
      primaryAccount: primaryRes.summary,
      bmbAccountLabel: bmbSnap.health.accountLabel,
      positions: primaryRes.positions,
      providerErrors,
    };
  }

  /** Helper puro exportado para pruebas de pricing americano BYMA en T+0 con derechos e IVA. */
  public static evaluateBymaOptionCostAndFair(params: {
    readonly spot: number;
    readonly strike: number;
    readonly daysToExpiry: number;
    readonly rateContinuous: number;
    readonly dividendYield: number;
    readonly volatility: number;
    readonly contractType: 'call' | 'put';
  }): {
    readonly fairPrice: number;
    readonly commissionWithVatArsPerLot: number;
  } {
    const tExp = Math.max(1 / 365, params.daysToExpiry / 365);
    const fairPrice = priceAmericanBjerksund2002({
      spot: params.spot,
      strike: params.strike,
      timeToExpiry: tExp,
      rate: params.rateContinuous,
      dividendYield: params.dividendYield,
      volatility: params.volatility,
      contractType: params.contractType,
    });
    const notional = Number.isFinite(fairPrice) ? fairPrice * OPTION_LOT_SIZE : 0;
    const commissionWithVatArsPerLot = notional * BYMA_OPTION_FEE * (1 + BYMA_VAT_RATE);
    return {
      fairPrice,
      commissionWithVatArsPerLot,
    };
  }
}
