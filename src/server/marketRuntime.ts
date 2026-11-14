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
  computeDealerExposure,
  type DealerExposureResult,
  type ExposureContractInput,
  type GammaFlipStatus,
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
  type VolQuoteInput,
  type VolSlice,
} from '../core/options/volSurface.js';
import { getMarketParts } from '../core/sessions.js';
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
import type { FetchFn, Timeframe } from '../data/types.js';
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
} from '../data/wsTypes.js';
import {
  SingleFlightRuntimeCache,
  computeDynamicTtlMs,
  redactSecrets,
} from './runtimeCache.js';

export const DEFAULT_TERMINAL_SYMBOLS = ['SPY', 'QQQ', 'I:SPX'] as const;

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
] as const;

const TIMEFRAME_SECONDS: Readonly<Record<Timeframe, number>> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3_600,
  '4h': 14_400,
  '1D': 86_400,
};

const KNOWN_INDEX_ROOTS = new Set<string>(['SPX', 'NDX', 'VIX', 'SKEW', 'RUT', 'DJX', 'OEX']);
const MAX_SERIALIZED_CONTRACTS = 360;
const MAX_WS_OPTION_CONTRACTS = 40;
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

export interface SerializedStrikeExposure {
  readonly strike: number;
  readonly callOi: number;
  readonly putOi: number;
  readonly callVolume: number;
  readonly putVolume: number;
  readonly callGex: number | null;
  readonly putGex: number | null;
  readonly netGex: number | null;
  readonly netSpotGamma: number | null;
  readonly netDex: number | null;
  readonly netVannaExposure: number | null;
  readonly netCharmExposure: number | null;
}

export interface SerializedExposureSummary {
  readonly netGex: number | null;
  readonly callGex: number | null;
  readonly putGex: number | null;
  readonly netSpotGamma: number | null;
  readonly netDex: number | null;
  readonly netVannaExposure: number | null;
  readonly netCharmExposure: number | null;
  readonly callWallStrike: number | null;
  readonly putWallStrike: number | null;
  readonly gammaFlipSpot: number | null;
  readonly gammaFlipStatus: GammaFlipStatus;
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
    readonly skippedContracts: number;
    readonly skippedOiShare: number | null;
  };
  readonly byStrike: readonly SerializedStrikeExposure[];
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

export interface SerializedVolSurfaceSummary {
  readonly iv30d: number | null;
  readonly butterflyArbitrageFree: boolean;
  readonly calendarArbitrageFree: boolean;
  readonly isArbitrageFree: boolean;
  readonly frontSlice: SerializedVolSliceSummary | null;
  readonly slices: readonly SerializedVolSliceSummary[];
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
  readonly marketStatus: string | null;
  readonly volume: number | null;
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

export interface SerializedTerminalEngines {
  readonly atr14d: number | null;
  readonly cvdSlopeSign: number | null;
  readonly volumeProfile: JsonSafeValue<VolumeProfileAmtResult> | null;
  readonly nakedPocs: JsonSafeValue<TrackNakedPocsResult> | null;
  readonly fvgs: JsonSafeValue<QuantitativeFvgResult> | null;
  readonly orderBlocks: JsonSafeValue<FreshOrderBlockResult> | null;
  readonly orderFlow: JsonSafeValue<SignedOptionsOrderFlowResult> | null;
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
  readonly structureOptimizerBullish: JsonSafeValue<OptimizeOptionStructuresResult> | null;
  readonly structureOptimizerBearish: JsonSafeValue<OptimizeOptionStructuresResult> | null;
  readonly structureCostPercentile: JsonSafeValue<StructureCostPercentileResult> | null;
}

export interface TerminalSnapshotResponse {
  readonly status: 'OK' | 'PARTIAL';
  readonly feedMode?: 'LIVE' | 'EOD_CIERRE' | 'PARTIAL' | 'NO_DATA';
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
    readonly ema21: readonly (number | null)[];
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

export function createRedactingFetch(secrets: readonly string[]): FetchFn {
  return async (url: string) => {
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
  const dividendYield = impliedDividendYieldFromForward({
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

  return isIndex
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

function serializeExposure(exposure: DealerExposureResult): SerializedExposureSummary {
  return {
    netGex: sanitizeFinite(exposure.netGex),
    callGex: sanitizeFinite(exposure.callGex),
    putGex: sanitizeFinite(exposure.putGex),
    netSpotGamma: sanitizeFinite(exposure.netSpotGamma),
    netDex: sanitizeFinite(exposure.netDex),
    netVannaExposure: sanitizeFinite(exposure.netVannaExposure),
    netCharmExposure: sanitizeFinite(exposure.netCharmExposure),
    callWallStrike: sanitizeFinite(exposure.callWallStrike),
    putWallStrike: sanitizeFinite(exposure.putWallStrike),
    gammaFlipSpot: sanitizeFinite(exposure.gammaFlipSpot),
    gammaFlipStatus: exposure.gammaFlipStatus,
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
      skippedContracts: exposure.quality.skippedContracts,
      skippedOiShare: sanitizeFinite(exposure.quality.skippedOiShare),
    },
    byStrike: exposure.byStrike.map((s) => ({
      strike: s.strike,
      callOi: s.callOpenInterest,
      putOi: s.putOpenInterest,
      callVolume: s.callVolume,
      putVolume: s.putVolume,
      callGex: sanitizeFinite(s.callGex),
      putGex: sanitizeFinite(s.putGex),
      netGex: sanitizeFinite(s.netGex),
      netSpotGamma: sanitizeFinite(s.netSpotGamma),
      netDex: sanitizeFinite(s.netDex),
      netVannaExposure: sanitizeFinite(s.netVannaExposure),
      netCharmExposure: sanitizeFinite(s.netCharmExposure),
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

/**
 * Runtime central en servidor para datos de mercado, cálculos cuantitativos y WebSocket live.
 */
export class MarketRuntime {
  private readonly apiKey: string;
  private readonly secrets: readonly string[];
  private readonly baseUrl: string | undefined;
  private readonly fetchFn: FetchFn;
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

  private readonly snapshotCache: SingleFlightRuntimeCache<TerminalSnapshotResponse>;
  private readonly barsCache: SingleFlightRuntimeCache<TerminalBarsResponse>;
  private readonly unusualCache: SingleFlightRuntimeCache<TerminalUnusualResponse>;

  private stockWsClient: MassiveWsClientLike | null = null;
  private optionsWsClient: MassiveWsClientLike | null = null;
  private readonly liveStates1m = new Map<string, LiveBarState>();
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
  private readonly wsListeners = new Set<(event: RuntimeWsBroadcast) => void>();
  private readonly wheelHistoryBySymbol = new Map<string, WheelSnapshotInput[]>();

  public constructor(deps: MarketRuntimeDeps = {}) {
    const auth = loadRuntimeAuth();
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
    this.secrets = [...secretSet];
    this.baseUrl = deps.baseUrl;
    this.fetchFn = deps.fetchFn ?? createRedactingFetch(this.secrets);
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
    this.snapshotCache = new SingleFlightRuntimeCache({
      nowFn: this.nowMsFn,
      ttlResolver,
    });
    this.barsCache = new SingleFlightRuntimeCache({
      nowFn: this.nowMsFn,
      ttlResolver,
    });
    this.unusualCache = new SingleFlightRuntimeCache({
      nowFn: this.nowMsFn,
      ttlResolver,
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
        stocks: this.stockWsClient?.getSnapshot() ?? null,
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
    symbols: readonly string[] = ['SPY', 'QQQ', 'I:SPX', 'NVDA', 'AAPL', 'MSFT'],
  ): Promise<void> {
    if (this.apiKey.trim() === '') {
      return;
    }
    await Promise.allSettled([
      ...symbols.map((sym) => this.getSnapshot(sym)),
      this.getUnusualTrades({ symbol: 'SPY', limit: 60 }),
    ]);
  }

  public async startWs(): Promise<void> {
    if (!this.enableWs || this.apiKey.trim() === '') {
      return;
    }

    const stockChannels: string[] = [];
    for (const sym of this.watchedSymbols) {
      const parsed = parseTerminalSymbol(sym, this.secrets);
      if (!parsed.isIndex) {
        stockChannels.push(
          `T.${parsed.canonicalSymbol}`,
          `A.${parsed.canonicalSymbol}`,
          `AM.${parsed.canonicalSymbol}`,
        );
      }
    }

    if (this.stockWsClient === null && stockChannels.length > 0) {
      const client = this.createWsClientFn({
        apiKey: this.apiKey,
        cluster: 'stocks',
        initialSubscriptions: stockChannels,
        autoReconnect: true,
        onEvents: (events: readonly WsNormalizedEvent[]) => {
          this.handleStockWsEvents(events);
        },
        onStateChange: (state: WsConnectionState) => {
          this.emitBroadcast({
            type: 'status',
            cluster: 'stocks',
            state,
            message: `stocks ws state: ${state}`,
            time: Math.floor(this.nowMsFn() / 1_000),
          });
        },
        onError: (err: WsClientError) => {
          this.emitBroadcast({
            type: 'status',
            cluster: 'stocks',
            state: 'error',
            message: redactSecrets(err.message, this.secrets),
            time: Math.floor(this.nowMsFn() / 1_000),
          });
        },
      });
      this.stockWsClient = client;
      try {
        await client.connect();
      } catch (err: unknown) {
        this.emitBroadcast({
          type: 'status',
          cluster: 'stocks',
          state: 'error',
          message: redactSecrets(extractErrorMessage(err, 'stocks ws connect error'), this.secrets),
          time: Math.floor(this.nowMsFn() / 1_000),
        });
      }
    }
  }

  public stopWs(): void {
    if (this.stockWsClient !== null) {
      this.stockWsClient.close(1000, 'server_shutdown');
      this.stockWsClient = null;
    }
    if (this.optionsWsClient !== null) {
      this.optionsWsClient.close(1000, 'server_shutdown');
      this.optionsWsClient = null;
    }
    this.subscribedOptionContracts.clear();
  }

  private async ensureOptionQuoteSubscriptions(contractTickers: readonly string[]): Promise<void> {
    if (!this.enableWs || this.apiKey.trim() === '' || contractTickers.length === 0) {
      return;
    }

    const candidates: string[] = [];
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

    const totalQuotesAfterAdd = this.subscribedOptionContracts.size + candidates.length;
    if (totalQuotesAfterAdd > 950) {
      return;
    }

    const channels: string[] = [];
    for (const c of candidates) {
      channels.push(`T.${c}`, `Q.${c}`);
    }
    if (countQuoteSubscriptions(channels) + this.subscribedOptionContracts.size > 1_000) {
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
        this.emitBroadcast({
          type: 'trade',
          cluster: 'options',
          symbol: ev.sym,
          time: ev.timeSec,
          price: ev.price,
          size: ev.size,
        });
      } else if (ev.ev === 'Q') {
        const bid = sanitizeFinite(ev.bidPrice);
        const ask = sanitizeFinite(ev.askPrice);
        const mid = bid !== null && ask !== null && ask >= bid ? 0.5 * (bid + ask) : null;
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

  public async getSnapshot(
    rawSymbol: string,
    options: { readonly forceRefresh?: boolean } = {},
  ): Promise<TerminalSnapshotResponse> {
    const parsed = parseTerminalSymbol(rawSymbol, this.secrets);
    const cacheKey = `snapshot:${parsed.canonicalSymbol}`;
    const result = await this.snapshotCache.getOrCompute(
      cacheKey,
      () => this.computeSnapshot(parsed),
      options.forceRefresh === undefined ? {} : { forceRefresh: options.forceRefresh },
    );
    return result.value;
  }

  private async computeSnapshot(parsed: ParsedSymbol): Promise<TerminalSnapshotResponse> {
    const apiKey = this.assertApiKey();
    const nowSec = Math.floor(this.nowMsFn() / 1_000);
    const { canonicalSymbol, correlatedSymbol, isIndex } = parsed;
    const warnings: string[] = [];

    const macroDateGte = addCalendarDaysEt(nowSec, -35);
    const unifiedTickers = [
      ...new Set([canonicalSymbol, correlatedSymbol, 'SPY', 'QQQ', 'I:SPX', 'I:VIX', 'I:SKEW']),
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
      bars1dRes,
      bars4hRes,
      bars15mRes,
      bars5mRes,
      corrBars5mRes,
      vixBars1dRes,
      spyBars1dRes,
    ] = await Promise.all([
      this.loadTreasuryYieldsFn({ ...baseTransport, dateGte: macroDateGte, limit: 100, maxPages: 1 }),
      this.loadFundingConditionsFn({ ...baseTransport, dateGte: macroDateGte, limit: 100, maxPages: 1 }),
      this.loadUnifiedSnapshotFn({ ...baseTransport, tickers: unifiedTickers, limit: 250, maxPages: 1 }),
      this.loadBarsFn({
        provider: 'massive',
        symbol: canonicalSymbol,
        timeframe: '1D',
        visibleBars: 60,
        warmupBars: 210,
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

    const latestTreasury =
      [...treasuryRes.observations]
        .reverse()
        .find((obs) => obs.finiteTenors === TREASURY_TENORS.length) ??
      treasuryRes.observations[treasuryRes.observations.length - 1];
    const latestFunding = [...fundingRes.observations]
      .reverse()
      .find((obs) => Number.isFinite(obs.sofr));
    const sofrRate = latestFunding?.sofr ?? Number.NaN;

    let contracts: readonly OptionSnapshotContract[] = [];
    let chainUnderlying: OptionUnderlyingSnapshot | null = null;
    let referenceContracts: readonly OptionContract[] = [];

    if (Number.isFinite(spot) && spot > 0) {
      const minStrike = Math.max(0.01, Math.floor(spot * 0.75 * 100) / 100);
      const maxStrike = Math.ceil(spot * 1.25 * 100) / 100;
      try {
        const refRes = await this.loadOptionContractsFn({
          underlying: canonicalSymbol,
          isIndex,
          minDte: 0,
          maxDte: 45,
          now: nowSec,
          minStrike,
          maxStrike,
          excludeBinary: false,
          excludeAdjusted: false,
          limit: 1_000,
          maxPages: 15,
          ...baseTransport,
        });
        referenceContracts = refRes.contracts;

        const chainRes = await this.loadOptionChainFn({
          underlying: canonicalSymbol,
          isIndex,
          minDte: 0,
          maxDte: 45,
          now: nowSec,
          minStrike,
          maxStrike,
          excludeBinary: true,
          excludeAdjusted: true,
          referenceContracts,
          snapshotLimit: 250,
          maxPages: 25,
          ...baseTransport,
        });
        contracts = chainRes.contracts;
        chainUnderlying = chainRes.underlying;
        if (chainRes.report.providerError !== null) {
          warnings.push(
            `options chain error: ${redactSecrets(chainRes.report.providerError.message, this.secrets)}`,
          );
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
      const parity = evaluateParityForExpiry(
        expirySec,
        expiryContracts,
        nowSec,
        spot,
        latestTreasury,
        sofrRate,
      );
      if (parity === null) {
        continue;
      }
      expiryParityMap.set(expirySec, parity);

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

      const slice = buildVolSlice(
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
      if (!slice.isValid) {
        continue;
      }
      const metrics = computeSliceVolMetrics(slice, {
        spot,
        rate: parity.rate,
        dividendYield: parity.dividendYield,
        deltaConvention: 'spotBsm',
      });
      if (Number.isFinite(metrics.ivAtm)) {
        validSlices.push({
          parity,
          slice,
          metrics,
          isButterflyArbitrageFree: metrics.isButterflyArbitrageFree,
          butterflyMinDensity: Number.NaN,
        });
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

      const exposureInputs: ExposureContractInput[] = [];
      for (const c of contracts) {
        const expParity = expiryParityMap.get(c.expirationTime) ?? activeFrontParity;
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
        exposureInputs.push({
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
      terminalExposureInputs = exposureInputs;

      exposureResult = computeDealerExposure(
        exposureInputs,
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

      const serializedContracts: SerializedOptionContractRow[] = [...contracts]
        .filter((c) => c.expirationTime > nowSec + 60)
        .sort((a, b) => {
          const da = Math.abs(a.strikePrice - spot);
          const db = Math.abs(b.strikePrice - spot);
          if (a.expirationTime !== b.expirationTime) {
            return a.expirationTime - b.expirationTime;
          }
          return da - db;
        })
        .slice(0, MAX_SERIALIZED_CONTRACTS)
        .map((c) => {
          const parity = expiryParityMap.get(c.expirationTime) ?? activeFrontParity;
          const tExp = timeToExpiryYears(nowSec, c.expirationTime);
          const ownIv = contractOwnIvMap.get(c.ticker) ?? Number.NaN;
          const provIv = c.impliedVolatility;
          const usedIv =
            Number.isFinite(ownIv) && ownIv > 0
              ? ownIv
              : Number.isFinite(provIv) && provIv > 0
                ? provIv
                : Number.NaN;
          const ivSource: 'OWN' | 'PROVIDER' | 'NONE' =
            Number.isFinite(ownIv) && ownIv > 0
              ? 'OWN'
              : Number.isFinite(provIv) && provIv > 0
                ? 'PROVIDER'
                : 'NONE';

          const greeks =
            Number.isFinite(usedIv) && usedIv > 0 && tExp > 0
              ? isIndex
                ? greeksBsm({
                    spot,
                    strike: c.strikePrice,
                    timeToExpiry: tExp,
                    rate: parity.rate,
                    dividendYield: parity.dividendYield,
                    volatility: usedIv,
                    contractType: c.contractType,
                  })
                : greeksAmericanFiniteDiffOrAnalytical({
                    spot,
                    strike: c.strikePrice,
                    timeToExpiry: tExp,
                    rate: parity.rate,
                    dividendYield: parity.dividendYield,
                    volatility: usedIv,
                    contractType: c.contractType,
                  })
              : null;

          return {
            ticker: c.ticker,
            contractType: c.contractType,
            strike: c.strikePrice,
            expirationDate: c.expirationDate,
            expiryUtcSec: c.expirationTime,
            bid: sanitizeFinite(c.lastQuote.bid),
            ask: sanitizeFinite(c.lastQuote.ask),
            mid: sanitizeFinite(resolveQuoteMid(c)),
            lastPrice: sanitizeFinite(c.lastTrade.price),
            openInterest: sanitizeFinite(c.openInterest),
            volume: sanitizeFinite(c.day.volume),
            ownIv: sanitizeFinite(ownIv),
            providerIv: sanitizeFinite(provIv),
            ivSource,
            delta: sanitizeFinite(greeks?.delta),
            gamma: sanitizeFinite(greeks?.gamma),
            thetaDaily: sanitizeFinite(greeks?.thetaDaily),
            vegaPer1Pct: sanitizeFinite(greeks?.vegaPer1Pct),
            vanna: sanitizeFinite(greeks?.vanna),
            charm: sanitizeFinite(greeks?.charm),
          };
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

      volSurfaceSummary = {
        iv30d: sanitizeFinite(iv30d),
        butterflyArbitrageFree: surface?.butterflyArbitrageFree ?? true,
        calendarArbitrageFree: surface?.calendarArbitrageFree ?? true,
        isArbitrageFree: surface?.isArbitrageFree ?? true,
        frontSlice: serializedSlices[0] ?? null,
        slices: serializedSlices,
        contracts: serializedContracts,
      };

      const liquidWsTickers = serializedContracts
        .slice(0, MAX_WS_OPTION_CONTRACTS)
        .map((c) => c.ticker);
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
    const skewLevel = resolveUnifiedIndexLevel(skewSnap);
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

    const unifiedQuotes: SerializedUnifiedQuote[] = [
      ...unifiedRes.stocks.map((s) => ({
        ticker: s.ticker,
        assetType: 'stock' as const,
        price: sanitizeFinite(resolveUnifiedStockPrice(s)),
        change: sanitizeFinite(s.session.change),
        changePct: sanitizeFinite(s.session.changePercent),
        previousClose: sanitizeFinite(s.session.previousClose),
        marketStatus: s.marketStatus,
        volume: sanitizeFinite(s.session.volume),
      })),
      ...unifiedRes.indices.map((idx) => ({
        ticker: idx.ticker,
        assetType: 'index' as const,
        price: sanitizeFinite(resolveUnifiedIndexLevel(idx)),
        change: sanitizeFinite(idx.session.change),
        changePct: sanitizeFinite(idx.session.changePercent),
        previousClose: sanitizeFinite(idx.session.previousClose),
        marketStatus: idx.marketStatus,
        volume: null,
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

    const volumeProfileUs =
      closedDailyUs.length >= 2
        ? computeVolumeProfileAmt(closedDailyUs, {
            asOfUtcSec: evalSecUs,
            barSeconds: 86_400,
            tickSize: tickSizeUs,
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
    let structureOptimizerBullishUs: OptimizeOptionStructuresResult | null = null;
    let structureOptimizerBearishUs: OptimizeOptionStructuresResult | null = null;
    let structureCostPercentileUs: StructureCostPercentileResult | null = null;

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
        if (
          Number.isFinite(c.day.volume) &&
          c.day.volume > 0 &&
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
            size: c.day.volume,
            bid: c.lastQuote.bid,
            ask: c.lastQuote.ask,
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
        if (Number.isFinite(ivVal) && ivVal > 0) {
          if (!qNodeMap.has(c.strikePrice) || (c.strikePrice >= spot && c.contractType === 'call') || (c.strikePrice < spot && c.contractType === 'put')) {
            qNodeMap.set(c.strikePrice, { strike: c.strikePrice, iv: ivVal });
          }
        }
      }
      const qNodesUs = [...qNodeMap.values()].sort((a, b) => a.strike - b.strike);
      if (frontSlice !== undefined && qNodesUs.length >= 5) {
        qDistributionUs = extractRiskNeutralDistributionQ({
          spot,
          rate: evalRateUs,
          dividendYield: evalDivUs,
          timeToExpiry: Math.max(1 / 365, frontSlice.parity.timeToExpiry),
          nodes: qNodesUs,
        });
      }

      const frontDteUs =
        frontSlice !== undefined
          ? Math.max(1, Math.round((frontSlice.parity.expirySec - evalSecUs) / 86_400))
          : 21;
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
        confluenceClustersUs = detectSpatialConfluenceClusters({
          spot,
          atr: atrDaily14,
          levels: confLevels,
          trigger: {
            cvdSlopeSign,
            optionsDeltaFlowSign: flowSignUs,
          },
        });
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
                dte: frontDteUs,
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
                dte: frontDteUs,
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

    const terminalEngines: SerializedTerminalEngines = sanitizeJsonValue({
      atr14d: sanitizeFinite(atrDaily14),
      cvdSlopeSign,
      volumeProfile: volumeProfileUs,
      nakedPocs: nakedPocsUs,
      fvgs: fvgsUs,
      orderBlocks: orderBlocksUs,
      orderFlow: orderFlowUs,
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
      structureOptimizerBullish: structureOptimizerBullishUs,
      structureOptimizerBearish: structureOptimizerBearishUs,
      structureCostPercentile: structureCostPercentileUs,
    });

    const anyClosedMarket =
      unifiedRes.stocks.some((s) => s.marketStatus?.toLowerCase() === 'closed') ||
      unifiedRes.indices.some((idx) => idx.marketStatus?.toLowerCase() === 'closed');
    const feedMode: 'LIVE' | 'EOD_CIERRE' | 'PARTIAL' | 'NO_DATA' =
      anyClosedMarket ||
      (bars1dRes.bars.length > 0 && unifiedRes.stocks.length === 0 && unifiedRes.indices.length === 0)
        ? 'EOD_CIERRE'
        : envelope.envelopeStatus === 'OK' && warnings.length === 0
          ? 'LIVE'
          : 'PARTIAL';

    const response: TerminalSnapshotResponse = {
      status: envelope.envelopeStatus === 'OK' && warnings.length === 0 ? 'OK' : 'PARTIAL',
      feedMode,
      symbol: canonicalSymbol,
      correlatedSymbol,
      isIndex,
      asOfUtcSec: nowSec,
      envelope,
      exposureSummary: exposureResult === undefined ? null : serializeExposure(exposureResult),
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
          yield1M: sanitizeFinite(latestTreasury?.yield1Month),
          yield3M: sanitizeFinite(latestTreasury?.yield3Month),
          yield1Y: sanitizeFinite(latestTreasury?.yield1Year),
          yield2Y: sanitizeFinite(latestTreasury?.yield2Year),
          yield10Y: sanitizeFinite(latestTreasury?.yield10Year),
          sofr: sanitizeFinite(sofrRate),
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
    const defaultVisible = timeframe === '1D' ? 2_016 : 240;
    const visibleBars = Math.min(Math.max(options.visibleBars ?? defaultVisible, 20), 2_200);
    const requestedRthOnly = options.rthOnly ?? false;
    const effectiveRthOnly = requestedRthOnly && timeframe !== '1D' && timeframe !== '4h';
    const cacheKey = `bars:${parsed.canonicalSymbol}:${timeframe}:${effectiveRthOnly ? 'rth' : 'ext'}:${String(visibleBars)}`;

    const result = await this.barsCache.getOrCompute(
      cacheKey,
      () => this.computeBars(parsed, timeframe, visibleBars, effectiveRthOnly),
      options.forceRefresh === undefined ? {} : { forceRefresh: options.forceRefresh },
    );
    return result.value;
  }

  private async computeBars(
    parsed: ParsedSymbol,
    timeframe: Timeframe,
    visibleBars: number,
    rthOnly: boolean,
  ): Promise<TerminalBarsResponse> {
    const apiKey = this.assertApiKey();
    const nowSec = Math.floor(this.nowMsFn() / 1_000);
    const barSeconds = TIMEFRAME_SECONDS[timeframe];

    const res = await this.loadBarsFn({
      provider: 'massive',
      symbol: parsed.canonicalSymbol,
      timeframe,
      visibleBars,
      warmupBars: 220,
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

    const bars = res.bars;
    const closes = bars.map((b) => b.close);
    const ema21 = calculateEma(closes, 21);
    const sma50 = computeSmaSeries(closes, 50);
    const sma200 = computeSmaSeries(closes, 200);
    const hma55 = computeHmaSeries(closes, 55);

    const sessionVwapSupported = 1_800 % barSeconds === 0;
    const sessionVwap = sessionVwapSupported
      ? computeSessionVwap(bars, { market: 'EQUITY', barSeconds })
      : null;
    const avwap = computeAnchoredVwap(bars, 'SESSION', { market: 'EQUITY' });
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

    const startSlice = Math.max(0, res.visibleStart - 40);
    const slicedBars = bars.slice(startSlice);
    const formingState = timeframe === '1m' ? this.liveStates1m.get(parsed.canonicalSymbol) : undefined;

    const payload: TerminalBarsResponse = {
      status: res.report.providerError === null ? 'OK' : 'PARTIAL',
      symbol: parsed.canonicalSymbol,
      timeframe,
      barSeconds,
      rthOnly,
      asOfUtcSec: nowSec,
      visibleStartIndex: res.visibleStart - startSlice,
      bars: slicedBars.map(serializeBar),
      formingBar:
        formingState?.formingBar !== undefined && formingState.formingBar !== null
          ? serializeBar(formingState.formingBar)
          : null,
      overlays: {
        ema21: ema21.slice(startSlice).map((v) => sanitizeFinite(v)),
        sma50: sma50.slice(startSlice).map((v) => sanitizeFinite(v)),
        sma200: sma200.slice(startSlice).map((v) => sanitizeFinite(v)),
        hma55: hma55.slice(startSlice).map((v) => sanitizeFinite(v)),
        sessionVwap: sessionVwapSupported && sessionVwap !== null
          ? sessionVwap.points.slice(startSlice).map((p) => sanitizeFinite(p.vwap))
          : slicedBars.map(() => null),
        sessionVwapSupported,
        avwap: avwap.points.slice(startSlice).map((p) => sanitizeFinite(p.vwap)),
        avwapUpper1: avwap.points.slice(startSlice).map((p) => sanitizeFinite(p.upper1)),
        avwapLower1: avwap.points.slice(startSlice).map((p) => sanitizeFinite(p.lower1)),
        avwapUpper2: avwap.points.slice(startSlice).map((p) => sanitizeFinite(p.upper2)),
        avwapLower2: avwap.points.slice(startSlice).map((p) => sanitizeFinite(p.lower2)),
      },
      subPanes: {
        rsi14: rsi14.slice(startSlice).map((v) => sanitizeFinite(v)),
        sessionCvd: slicedBars.map((b) => sanitizeFinite(cvdByTime.get(b.time))),
        deltaMode: cvdResult.deltaMode,
      },
      zones,
      keyLevels,
      markers,
    };

    assertJsonSafeSerialized(payload);
    return payload;
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
    const apiKey = this.assertApiKey();
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
}
