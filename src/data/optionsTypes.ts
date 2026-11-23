/**
 * Tipos de la capa de datos para Contratos de Referencia y Cadenas de Opciones
 * de Massive (Pieza 1).
 *
 * Convenciones del proyecto:
 *  - Los timestamps normalizados siempre se expresan en segundos UTC enteros
 *    (convertidos en la entrada desde nanosegundos o milisegundos).
 *  - Prohibidos los valores de respaldo que oculten un NaN: un dato faltante o
 *    no calculable (p. ej. `greeks: {}`, `implied_volatility` ausente o
 *    `last_trade: {}`) se representa explícitamente con `Number.NaN`.
 */

import type { FetchFn, ProviderError, SleepFn } from './types.js';

export type OptionContractType = 'call' | 'put' | 'other';
export type StandardOptionContractType = 'call' | 'put';
export type OptionExerciseStyle = 'american' | 'european' | 'bermudan';
export type OptionKind = 'standard' | 'binary';
export type OptionUnderlyingType = 'equity' | 'kpi';

export type OptionDiscardCause =
  | 'malformedRow'
  | 'invalidTicker'
  | 'invalidExpiration'
  | 'invalidStrike'
  | 'invalidContractType'
  | 'invalidSharesPerContract'
  | 'duplicate'
  | 'binaryExcluded'
  | 'adjustedExcluded'
  | 'outOfDteRange'
  | 'outOfStrikeRange'
  | 'filteredContractType';

export type OptionDiscardCounts = Readonly<Record<OptionDiscardCause, number>>;

export interface OptionDiscardRecord {
  readonly cause: OptionDiscardCause;
  readonly ticker: string | null;
}

export interface AdditionalUnderlying {
  readonly type: string;
  readonly underlying: string;
  readonly amount: number;
}

/** Contrato normalizado de `/v3/reference/options/contracts`. */
export interface OptionContract {
  readonly ticker: string;
  readonly underlyingTicker: string;
  readonly contractType: OptionContractType;
  readonly exerciseStyle: OptionExerciseStyle | null;
  readonly expirationDate: string;
  /** Cierre nominal 16:00 ET de `expirationDate`, en segundos UTC enteros. */
  readonly expirationTime: number;
  readonly strikePrice: number;
  readonly sharesPerContract: number;
  readonly primaryExchange: string | null;
  readonly cfi: string | null;
  readonly correction: number | null;
  /** Campo crudo `type` del contrato (`standard` | `binary` | null si falta). */
  readonly kind: OptionKind | null;
  readonly underlyingType: OptionUnderlyingType | null;
  readonly additionalUnderlyings: readonly AdditionalUnderlying[];
  readonly isBinary: boolean;
  readonly isAdjusted: boolean;
  readonly isNonStandard: boolean;
}

export interface OptionGreeks {
  readonly delta: number;
  readonly gamma: number;
  readonly theta: number;
  readonly vega: number;
}

export interface OptionDaySummary {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly vwap: number;
  readonly previousClose: number;
  readonly change: number;
  readonly changePercent: number;
  readonly updatedAt: number;
}

export interface OptionLastQuote {
  readonly source?: 'MASSIVE' | 'TRADIER' | 'EOD_CLOSE_REF';
  readonly bidTimeUtcSec?: number;
  readonly askTimeUtcSec?: number;
  readonly receivedAtUtcSec?: number;
  readonly quoteQuality?: 'LIVE_ATOMIC' | 'EOD_CLOSE_REF' | 'STALE' | 'INVALID';
  readonly bid: number;
  readonly ask: number;
  readonly midpoint: number;
  readonly bidSize: number;
  readonly askSize: number;
  readonly bidExchange: number | null;
  readonly askExchange: number | null;
  readonly updatedAt: number;
  readonly timeframe: string | null;
}

export interface OptionLastTrade {
  readonly price: number;
  readonly size: number;
  readonly exchange: number | null;
  readonly conditions: readonly number[];
  readonly sipTimestamp: number;
  readonly timeframe: string | null;
}

export interface OptionUnderlyingSnapshot {
  readonly ticker: string;
  /** `price` en acciones/ETFs o `value` en índices; `NaN` si falta. */
  readonly price: number;
  readonly sourceField: 'price' | 'value' | null;
  readonly changeToBreakEven: number;
  readonly updatedAt: number;
  readonly timeframe: string | null;
}

/** Contrato normalizado de `/v3/snapshot/options/{underlyingAsset}`. */
export interface OptionSnapshotContract {
  readonly ticker: string;
  readonly contractType: StandardOptionContractType;
  readonly exerciseStyle: OptionExerciseStyle | null;
  readonly expirationDate: string;
  /** Cierre nominal 16:00 ET de `expirationDate`, en segundos UTC enteros. */
  readonly expirationTime: number;
  readonly strikePrice: number;
  readonly sharesPerContract: number;
  readonly breakEvenPrice: number;
  readonly impliedVolatility: number;
  readonly openInterest: number;
  readonly greeks: OptionGreeks;
  /** `true` si `greeks` faltaba, venía vacío `{}` o sin ningún valor finito. */
  readonly greeksMissing: boolean;
  readonly greeksProvenance?: {
    readonly source: 'MASSIVE' | 'TRADIER_ORATS';
    readonly model: 'PROVIDER_MASSIVE' | 'ORATS_PROVIDER';
    readonly updatedAtUtcSec: number;
    readonly acceptedIndependentlyOfBbo: boolean;
  };
  readonly day: OptionDaySummary;
  readonly lastQuote: OptionLastQuote;
  readonly lastTrade: OptionLastTrade;
  readonly underlyingAsset: OptionUnderlyingSnapshot | null;
  readonly additionalUnderlyings: readonly AdditionalUnderlying[];
  readonly isBinary: boolean;
  readonly isAdjusted: boolean;
  readonly isNonStandard: boolean;
}

export interface OptionFilterOptions {
  /** Por defecto `true`: excluye contratos binarios (`type === 'binary'` o `underlying_type === 'kpi'`). */
  readonly excludeBinary?: boolean;
  /** Por defecto `true`: excluye contratos ajustados (`additional_underlyings` no vacío o multiplicador distinto de `standardSharesPerContract`). */
  readonly excludeAdjusted?: boolean;
  /** Multiplicador estándar esperado para detectar contratos ajustados. Por defecto `100`. */
  readonly standardSharesPerContract?: number;
  readonly contractType?: StandardOptionContractType;
  /** DTE calendario ET mínimo (requiere `now`). */
  readonly minDte?: number;
  /** DTE calendario ET máximo (requiere `now`). */
  readonly maxDte?: number;
  readonly minStrike?: number;
  readonly maxStrike?: number;
  /** Instante actual en segundos UTC enteros para evaluar `minDte`/`maxDte`. */
  readonly now?: number;
}

export type NormalizeOptionContractsOptions = OptionFilterOptions;

export interface NormalizeOptionChainOptions extends OptionFilterOptions {
  /** Contratos de referencia para detectar binarias (`O:B1...`) y ajustadas cuando el snapshot omite metadatos. */
  readonly referenceContracts?:
    | ReadonlyMap<string, OptionContract>
    | readonly OptionContract[];
}

export interface BaseOptionsNormalizeReport {
  readonly provider: 'massive';
  readonly received: number;
  readonly accepted: number;
  readonly discarded: number;
  readonly discardCounts: OptionDiscardCounts;
  readonly discards: readonly OptionDiscardRecord[];
  readonly binaryDetected: number;
  readonly adjustedDetected: number;
  readonly binaryExcluded: number;
  readonly adjustedExcluded: number;
  readonly malformedDiscarded: number;
  readonly duplicateDiscarded: number;
  readonly filterExcluded: number;
  readonly reordered: boolean;
  readonly malformedResponse: boolean;
  readonly providerError: ProviderError | null;
}

export type OptionContractsNormalizeReport = BaseOptionsNormalizeReport;

export interface OptionContractsNormalizeResult {
  readonly contracts: readonly OptionContract[];
  readonly report: OptionContractsNormalizeReport;
}

export type UnderlyingSourceSummary = 'price' | 'value' | 'mixed' | 'missing';

export interface OptionChainNormalizeReport extends BaseOptionsNormalizeReport {
  /** Contratos aceptados con `greeks` ausente, vacío `{}` o sin valores finitos. */
  readonly emptyGreeks: number;
  /** Contratos aceptados sin `implied_volatility` válida. */
  readonly ivMissing: number;
  /** Contratos aceptados con `day: {}` o sin datos válidos de sesión. */
  readonly emptyDay: number;
  /** Contratos aceptados sin `last_quote` válido. */
  readonly emptyLastQuote: number;
  /** Contratos aceptados sin `last_trade` válido. */
  readonly emptyLastTrade: number;
  /** Timestamps crudos inválidos o fuera de unidad encontrados en los contratos aceptados. */
  readonly invalidTimestamps: number;
  readonly underlyingSource: UnderlyingSourceSummary;
}

export interface OptionChainNormalizeResult {
  readonly contracts: readonly OptionSnapshotContract[];
  readonly underlying: OptionUnderlyingSnapshot | null;
  readonly report: OptionChainNormalizeReport;
}

export type OptionLoadStopReason =
  | 'noMorePages'
  | 'maxPages'
  | 'providerError'
  | 'malformedResponse';

export interface OptionSharedLoaderOptions {
  /** Subyacente (`'SPY'`, `'I:SPX'`, o `'SPX'` con `isIndex: true`). */
  readonly underlying: string;
  /** Indica explícitamente si es índice (`I:` requerido en snapshot y omitido en reference contracts). */
  readonly isIndex?: boolean;
  readonly fetchFn: FetchFn;
  readonly apiKey: string;
  /** Origen base alternativo. Por defecto `https://api.massive.com`. */
  readonly baseUrl?: string;
  /** Máximo de páginas por endpoint. Por defecto `50`. */
  readonly maxPages?: number;
  readonly minRequestIntervalMs?: number;
  /** Reintento opt-in ante HTTP 429. Por defecto `0`. */
  readonly retry429MaxAttempts?: number;
  readonly retry429BaseDelayMs?: number;
  readonly retry429MaxDelayMs?: number;
  readonly sleepFn?: SleepFn;
  readonly expirationDate?: string;
  readonly expirationDateGte?: string;
  readonly expirationDateLte?: string;
}

export interface LoadOptionContractsOptions
  extends OptionSharedLoaderOptions,
    OptionFilterOptions {
  /** Máximo por página de `/v3/reference/options/contracts` (1..1000). Por defecto `1000`. */
  readonly limit?: number;
  readonly expired?: boolean;
  readonly asOf?: string;
}

export interface LoadOptionContractsReport
  extends OptionContractsNormalizeReport {
  readonly pages: number;
  readonly stoppedReason: OptionLoadStopReason;
  readonly referenceUnderlyingTicker: string;
}

export interface LoadOptionContractsResult {
  readonly contracts: readonly OptionContract[];
  readonly report: LoadOptionContractsReport;
}

export interface LoadOptionChainOptions
  extends OptionSharedLoaderOptions,
    OptionFilterOptions {
  /** Contratos ya cargados para cruzar binarias/ajustadas sin pedir `/v3/reference/options/contracts`. */
  readonly referenceContracts?:
    | ReadonlyMap<string, OptionContract>
    | readonly OptionContract[];
  /**
   * Si es `true` (por defecto cuando `referenceContracts` no se pasa y se excluyen
   * binarias o ajustadas), consulta `/v3/reference/options/contracts` antes del snapshot.
   */
  readonly includeReferenceMetadata?: boolean;
  /** Máximo por página de `/v3/snapshot/options/{underlying}` (1..250). Por defecto `250`. */
  readonly snapshotLimit?: number;
  /** Máximo por página de `/v3/reference/options/contracts` (1..1000). Por defecto `1000`. */
  readonly contractsLimit?: number;
  readonly expired?: boolean;
  readonly asOf?: string;
}

export interface LoadOptionChainReport extends OptionChainNormalizeReport {
  readonly pages: number;
  readonly referencePages: number;
  readonly snapshotPages: number;
  readonly stoppedReason: OptionLoadStopReason;
  readonly snapshotUnderlyingAsset: string;
  readonly referenceUnderlyingTicker: string;
  readonly contractsReport: LoadOptionContractsReport | null;
}

export interface LoadOptionChainResult {
  readonly contracts: readonly OptionSnapshotContract[];
  readonly underlying: OptionUnderlyingSnapshot | null;
  readonly report: LoadOptionChainReport;
}
