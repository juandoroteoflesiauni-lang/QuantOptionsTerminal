/**
 * Tipos de la capa de datos macroeconómicos, corporativos y de snapshot
 * unificado de Massive (Pieza 4):
 *  1) Curva US Treasury (`/fed/v1/treasury-yields`)
 *  2) Condiciones de fondeo Fed / SOFR (`/fed/v1/funding-conditions`)
 *  3) Dividendos corporativos (`/stocks/v1/dividends`)
 *  4) Open Interest histórico diario (`/options/v1/open-interest`)
 *  5) Unified Snapshot multi-activo (`/v3/snapshot`)
 *
 * Convenciones del proyecto (AGENTS.md / SPEC.md):
 *  - Timestamps numéricos siempre en segundos UTC enteros (conversión desde ns/ms en la entrada).
 *  - Cero valores de respaldo que oculten un NaN: campos ausentes o no finitos
 *    entran explícitamente como `Number.NaN`.
 *  - Tasas de interés (`/fed/v1/*`) convertidas explícitamente de porcentaje
 *    anualizado del proveedor (`4.31` = 4.31 %) a decimal (`0.0431`).
 */

import type {
  OptionContractType,
  OptionExerciseStyle,
  OptionGreeks,
  OptionUnderlyingSnapshot,
} from './optionsTypes.js';
import type { FetchFn, ProviderError, SleepFn } from './types.js';

export type MacroLoadStopReason =
  | 'noMorePages'
  | 'maxPages'
  | 'providerError'
  | 'malformedResponse';

export interface MacroSharedLoaderOptions {
  readonly baseUrl?: string;
  readonly apiKey: string;
  readonly fetchFn: FetchFn;
  readonly maxPages?: number;
  readonly minRequestIntervalMs?: number;
  readonly retry429MaxAttempts?: number;
  readonly retry429BaseDelayMs?: number;
  readonly retry429MaxDelayMs?: number;
  readonly sleepFn?: SleepFn;
}

export interface MacroGenericDiscardRecord {
  readonly cause: string;
  readonly identifier: string | null;
}

// ---------------------------------------------------------------------------
// 1) Curva US Treasury (`/fed/v1/treasury-yields`)
// ---------------------------------------------------------------------------

export type TreasuryTenorField =
  | 'yield_1_month'
  | 'yield_3_month'
  | 'yield_6_month'
  | 'yield_1_year'
  | 'yield_2_year'
  | 'yield_3_year'
  | 'yield_5_year'
  | 'yield_7_year'
  | 'yield_10_year'
  | 'yield_20_year'
  | 'yield_30_year';

export type TreasuryYieldKey =
  | 'yield1Month'
  | 'yield3Month'
  | 'yield6Month'
  | 'yield1Year'
  | 'yield2Year'
  | 'yield3Year'
  | 'yield5Year'
  | 'yield7Year'
  | 'yield10Year'
  | 'yield20Year'
  | 'yield30Year';

export interface TreasuryTenorSpec {
  readonly field: TreasuryTenorField;
  readonly key: TreasuryYieldKey;
  readonly label: string;
  readonly years: number;
}

/** Observación diaria normalizada de US Treasury (tasas en decimal, p. ej. 4.31 % -> 0.0431). */
export interface TreasuryYieldObservation {
  readonly date: string;
  /** 00:00:00 UTC de `date` en segundos enteros. */
  readonly dateTime: number;
  readonly yield1Month: number;
  readonly yield3Month: number;
  readonly yield6Month: number;
  readonly yield1Year: number;
  readonly yield2Year: number;
  readonly yield3Year: number;
  readonly yield5Year: number;
  readonly yield7Year: number;
  readonly yield10Year: number;
  readonly yield20Year: number;
  readonly yield30Year: number;
  readonly finiteTenors: number;
}

export interface TreasuryCurvePoint {
  readonly tenorYears: number;
  readonly tenorLabel: string;
  /** Tasa anualizada en decimal (`0.0431` = 4.31 %). */
  readonly rate: number;
  readonly sourceField?: string;
}

export type TreasuryCurveInterpolationMethod = 'linear' | 'logLinear';
export type TreasuryCurveExtrapolationMode = 'clamp' | 'nan';

export interface ExtractTreasuryCurveOptions {
  /**
   * Si es `false` (por defecto), cualquier tenor faltante/`NaN` en la observación
   * queda reflejado en la curva (haciendo que `interpolateTreasuryYield` devuelva `NaN`
   * en lugar de interpolar en silencio). Si es `true`, se filtran solo los tenores finitos.
   */
  readonly allowMissingTenors?: boolean;
  /** Tasa overnight opcional en decimal (p. ej. SOFR) anclada en `1 / 365` año. */
  readonly overnightRate?: number;
}

export interface InterpolateTreasuryCurveOptions extends ExtractTreasuryCurveOptions {
  /** `'linear'` sobre `r(T)` o `'logLinear'` sobre factores de descuento `exp(-r(T) * T)`. */
  readonly method?: TreasuryCurveInterpolationMethod;
  /** `'clamp'` (plano fuera de `[T_min, T_max]`) o `'nan'` fuera de rango. */
  readonly extrapolation?: TreasuryCurveExtrapolationMode;
}

export type TreasuryYieldDiscardCause =
  | 'malformedRow'
  | 'invalidDate'
  | 'missingRates'
  | 'duplicate';

export type TreasuryYieldDiscardCounts = Readonly<Record<TreasuryYieldDiscardCause, number>>;

export interface TreasuryYieldDiscardRecord {
  readonly cause: TreasuryYieldDiscardCause;
  readonly date: string | null;
}

export interface TreasuryYieldsNormalizeReport {
  readonly provider: 'massive';
  readonly received: number;
  readonly accepted: number;
  readonly discarded: number;
  readonly discardCounts: TreasuryYieldDiscardCounts;
  readonly discards: readonly TreasuryYieldDiscardRecord[];
  readonly reordered: boolean;
  readonly malformedResponse: boolean;
  readonly providerError: ProviderError | null;
}

export interface TreasuryYieldsNormalizeResult {
  readonly observations: readonly TreasuryYieldObservation[];
  readonly report: TreasuryYieldsNormalizeReport;
}

// ---------------------------------------------------------------------------
// 2) Condiciones de Fondeo / SOFR (`/fed/v1/funding-conditions`)
// ---------------------------------------------------------------------------

/** Observación diaria de tasas de fondeo (tasas en decimal, volúmenes en unidades del proveedor). */
export interface FundingConditionsObservation {
  readonly date: string;
  /** 00:00:00 UTC de `date` en segundos enteros. */
  readonly dateTime: number;
  readonly effectiveFedFundsRate: number;
  readonly effectiveFedFundsVolume: number;
  readonly interestOnReserveBalances: number;
  readonly targetRangeLower: number;
  readonly targetRangeUpper: number;
  readonly sofr: number;
  readonly sofrVolume: number;
  readonly sofrPercentile1: number;
  readonly sofrPercentile25: number;
  readonly sofrPercentile75: number;
  readonly sofrPercentile99: number;
  readonly overnightBankFundingRate: number;
  readonly obfrVolume: number;
  readonly overnightRepoOperationAmount: number;
  readonly overnightReverseRepoOperationAmount: number;
}

export type FundingConditionsDiscardCause =
  | 'malformedRow'
  | 'invalidDate'
  | 'missingRates'
  | 'duplicate';

export type FundingConditionsDiscardCounts = Readonly<
  Record<FundingConditionsDiscardCause, number>
>;

export interface FundingConditionsDiscardRecord {
  readonly cause: FundingConditionsDiscardCause;
  readonly date: string | null;
}

export interface FundingConditionsNormalizeReport {
  readonly provider: 'massive';
  readonly received: number;
  readonly accepted: number;
  readonly discarded: number;
  readonly discardCounts: FundingConditionsDiscardCounts;
  readonly discards: readonly FundingConditionsDiscardRecord[];
  readonly reordered: boolean;
  readonly malformedResponse: boolean;
  readonly providerError: ProviderError | null;
}

export interface FundingConditionsNormalizeResult {
  readonly observations: readonly FundingConditionsObservation[];
  readonly report: FundingConditionsNormalizeReport;
}

// ---------------------------------------------------------------------------
// 3) Dividendos corporativos (`/stocks/v1/dividends`)
// ---------------------------------------------------------------------------

export interface DividendRecord {
  readonly id: string | null;
  readonly ticker: string;
  readonly declarationDate: string | null;
  readonly exDividendDate: string;
  /** Apertura regular 09:30 ET de `exDividendDate` en segundos UTC enteros. */
  readonly exDividendTime: number;
  readonly recordDate: string | null;
  readonly payDate: string | null;
  readonly cashAmount: number;
  readonly splitAdjustedCashAmount: number;
  readonly historicalAdjustmentFactor: number;
  readonly frequency: number;
  readonly currency: string | null;
  readonly distributionType: string | null;
}

export type DividendDiscardCause =
  | 'malformedRow'
  | 'invalidTicker'
  | 'invalidExDividendDate'
  | 'invalidCashAmount'
  | 'duplicate';

export type DividendDiscardCounts = Readonly<Record<DividendDiscardCause, number>>;

export interface DividendDiscardRecord {
  readonly cause: DividendDiscardCause;
  readonly ticker: string | null;
  readonly exDividendDate: string | null;
}

export interface DividendsNormalizeReport {
  readonly provider: 'massive';
  readonly received: number;
  readonly accepted: number;
  readonly discarded: number;
  readonly discardCounts: DividendDiscardCounts;
  readonly discards: readonly DividendDiscardRecord[];
  readonly reordered: boolean;
  readonly malformedResponse: boolean;
  readonly providerError: ProviderError | null;
}

export interface DividendsNormalizeResult {
  readonly dividends: readonly DividendRecord[];
  readonly report: DividendsNormalizeReport;
}

// ---------------------------------------------------------------------------
// 4) Open Interest histórico (`/options/v1/open-interest`)
// ---------------------------------------------------------------------------

export interface OptionOpenInterestRecord {
  readonly ticker: string;
  readonly root: string | null;
  readonly underlyingTicker: string | null;
  readonly date: string;
  /** 00:00:00 UTC de `date` en segundos enteros. */
  readonly dateTime: number;
  readonly expirationDate: string;
  /** Cierre nominal 16:00 ET de `expirationDate` en segundos UTC enteros. */
  readonly expirationTime: number;
  readonly strikePrice: number;
  readonly contractType: OptionContractType;
  readonly openInterest: number;
}

export type OpenInterestDiscardCause =
  | 'malformedRow'
  | 'invalidTicker'
  | 'invalidDate'
  | 'invalidExpiration'
  | 'invalidStrike'
  | 'invalidContractType'
  | 'invalidOpenInterest'
  | 'duplicate';

export type OpenInterestDiscardCounts = Readonly<Record<OpenInterestDiscardCause, number>>;

export interface OpenInterestDiscardRecord {
  readonly cause: OpenInterestDiscardCause;
  readonly ticker: string | null;
  readonly date: string | null;
}

export interface OpenInterestNormalizeReport {
  readonly provider: 'massive';
  readonly received: number;
  readonly accepted: number;
  readonly discarded: number;
  readonly discardCounts: OpenInterestDiscardCounts;
  readonly discards: readonly OpenInterestDiscardRecord[];
  readonly reordered: boolean;
  readonly malformedResponse: boolean;
  readonly providerError: ProviderError | null;
}

export interface OpenInterestNormalizeResult {
  readonly records: readonly OptionOpenInterestRecord[];
  readonly report: OpenInterestNormalizeReport;
}

// ---------------------------------------------------------------------------
// 5) Unified Multi-Asset Snapshot (`/v3/snapshot`)
// ---------------------------------------------------------------------------

export type UnifiedMarketStatus =
  | 'open'
  | 'closed'
  | 'early_trading'
  | 'late_trading'
  | 'overnight_trading'
  | (string & {});

export type UnifiedAssetClass = 'stocks' | 'indices' | 'options' | 'fx' | 'crypto' | 'other';

export interface UnifiedSessionSummary {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly vwap: number;
  readonly price: number;
  readonly previousClose: number;
  readonly change: number;
  readonly changePercent: number;
  readonly earlyTradingChange: number;
  readonly earlyTradingChangePercent: number;
  readonly lateTradingChange: number;
  readonly lateTradingChangePercent: number;
  readonly lastUpdated: number;
  /** `true` si los cuatro precios OHLC de la sesión son finitos (`false` típico en `early_trading`). */
  readonly hasOhlc: boolean;
}

export interface UnifiedLastQuote {
  readonly bid: number;
  readonly ask: number;
  readonly midpoint: number;
  readonly bidSize: number;
  readonly askSize: number;
  readonly updatedAt: number;
  readonly timeframe: string | null;
}

export interface UnifiedLastTrade {
  readonly price: number;
  readonly size: number;
  readonly exchange: number | null;
  readonly conditions: readonly number[];
  readonly timestamp: number;
  readonly timeframe: string | null;
}

export interface UnifiedLastMinute {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly vwap: number;
  readonly transactions: number;
  readonly lastUpdated: number;
}

export interface UnifiedStockSnapshot {
  readonly assetClass: 'stocks';
  readonly ticker: string;
  readonly name: string | null;
  readonly marketStatus: UnifiedMarketStatus | null;
  readonly timeframe: string | null;
  readonly session: UnifiedSessionSummary;
  readonly lastQuote: UnifiedLastQuote | null;
  readonly lastTrade: UnifiedLastTrade | null;
  readonly lastMinute: UnifiedLastMinute | null;
}

export interface UnifiedIndexSnapshot {
  readonly assetClass: 'indices';
  readonly ticker: string;
  readonly name: string | null;
  readonly marketStatus: UnifiedMarketStatus | null;
  readonly timeframe: string | null;
  /** Nivel actual del índice (`value` de Massive o `NaN` si falta). */
  readonly value: number;
  readonly session: UnifiedSessionSummary;
  readonly lastUpdated: number;
}

export interface UnifiedOptionDetails {
  readonly contractType: OptionContractType;
  readonly exerciseStyle: OptionExerciseStyle | null;
  readonly expirationDate: string | null;
  readonly expirationTime: number;
  readonly sharesPerContract: number;
  readonly strikePrice: number;
}

export interface UnifiedOptionSnapshot {
  readonly assetClass: 'options';
  readonly ticker: string;
  readonly name: string | null;
  readonly marketStatus: UnifiedMarketStatus | null;
  readonly timeframe: string | null;
  readonly breakEvenPrice: number;
  readonly impliedVolatility: number;
  readonly openInterest: number;
  readonly greeks: OptionGreeks;
  readonly greeksMissing: boolean;
  readonly details: UnifiedOptionDetails;
  readonly session: UnifiedSessionSummary;
  readonly lastQuote: UnifiedLastQuote | null;
  readonly lastTrade: UnifiedLastTrade | null;
  readonly lastMinute: UnifiedLastMinute | null;
  readonly underlyingAsset: OptionUnderlyingSnapshot | null;
}

export interface UnifiedOtherAssetSnapshot {
  readonly assetClass: 'fx' | 'crypto' | 'other';
  readonly rawType: string | null;
  readonly ticker: string;
  readonly name: string | null;
  readonly marketStatus: UnifiedMarketStatus | null;
  readonly timeframe: string | null;
  readonly session: UnifiedSessionSummary;
  readonly lastQuote: UnifiedLastQuote | null;
  readonly lastTrade: UnifiedLastTrade | null;
  readonly lastMinute: UnifiedLastMinute | null;
}

export interface UnifiedSnapshotTickerError {
  readonly ticker: string;
  readonly type: string | null;
  readonly error: string;
  readonly message: string;
}

export type UnifiedSnapshotDiscardCause =
  | 'malformedRow'
  | 'missingTicker'
  | 'unknownAssetType'
  | 'duplicate';

export type UnifiedSnapshotDiscardCounts = Readonly<
  Record<UnifiedSnapshotDiscardCause, number>
>;

export interface UnifiedSnapshotDiscardRecord {
  readonly cause: UnifiedSnapshotDiscardCause;
  readonly ticker: string | null;
}

export interface UnifiedSnapshotNormalizeReport {
  readonly provider: 'massive';
  readonly received: number;
  readonly accepted: number;
  readonly errorCount: number;
  readonly discarded: number;
  readonly discardCounts: UnifiedSnapshotDiscardCounts;
  readonly discards: readonly UnifiedSnapshotDiscardRecord[];
  readonly stocksCount: number;
  readonly indicesCount: number;
  readonly optionsCount: number;
  readonly otherCount: number;
  readonly earlyTradingWithoutOhlc: number;
  readonly overnightTradingCount: number;
  readonly invalidTimestamps: number;
  readonly reordered: boolean;
  readonly malformedResponse: boolean;
  readonly providerError: ProviderError | null;
}

export interface UnifiedSnapshotNormalizeResult {
  readonly stocks: readonly UnifiedStockSnapshot[];
  readonly indices: readonly UnifiedIndexSnapshot[];
  readonly options: readonly UnifiedOptionSnapshot[];
  readonly other: readonly UnifiedOtherAssetSnapshot[];
  readonly tickerErrors: readonly UnifiedSnapshotTickerError[];
  readonly report: UnifiedSnapshotNormalizeReport;
}

// ---------------------------------------------------------------------------
// Opciones, reportes y resultados de los Loaders REST
// ---------------------------------------------------------------------------

export interface DateRangeFilterOptions {
  readonly date?: string;
  readonly dateGt?: string;
  readonly dateGte?: string;
  readonly dateLt?: string;
  readonly dateLte?: string;
  readonly sort?: string;
  readonly order?: 'asc' | 'desc';
  readonly limit?: number;
}

export interface LoadTreasuryYieldsOptions
  extends MacroSharedLoaderOptions,
    DateRangeFilterOptions {}

export interface LoadTreasuryYieldsReport extends TreasuryYieldsNormalizeReport {
  readonly pages: number;
  readonly stoppedReason: MacroLoadStopReason;
}

export interface LoadTreasuryYieldsResult {
  readonly observations: readonly TreasuryYieldObservation[];
  readonly report: LoadTreasuryYieldsReport;
}

export interface LoadFundingConditionsOptions
  extends MacroSharedLoaderOptions,
    DateRangeFilterOptions {}

export interface LoadFundingConditionsReport extends FundingConditionsNormalizeReport {
  readonly pages: number;
  readonly stoppedReason: MacroLoadStopReason;
}

export interface LoadFundingConditionsResult {
  readonly observations: readonly FundingConditionsObservation[];
  readonly report: LoadFundingConditionsReport;
}

export interface LoadDividendsOptions extends MacroSharedLoaderOptions {
  readonly ticker?: string;
  readonly exDividendDate?: string;
  readonly exDividendDateGt?: string;
  readonly exDividendDateGte?: string;
  readonly exDividendDateLt?: string;
  readonly exDividendDateLte?: string;
  readonly distributionType?: string;
  readonly frequency?: number;
  readonly sort?: string;
  readonly order?: 'asc' | 'desc';
  readonly limit?: number;
}

export interface LoadDividendsReport extends DividendsNormalizeReport {
  readonly pages: number;
  readonly stoppedReason: MacroLoadStopReason;
}

export interface LoadDividendsResult {
  readonly dividends: readonly DividendRecord[];
  readonly report: LoadDividendsReport;
}

export interface LoadOptionOpenInterestOptions
  extends MacroSharedLoaderOptions,
    DateRangeFilterOptions {
  readonly ticker?: string;
  readonly root?: string;
  readonly underlyingTicker?: string;
  readonly expirationDate?: string;
  readonly expirationDateGte?: string;
  readonly expirationDateLte?: string;
  readonly contractType?: 'call' | 'put';
  readonly strikePrice?: number;
  readonly strikePriceGte?: number;
  readonly strikePriceLte?: number;
}

export interface LoadOptionOpenInterestReport extends OpenInterestNormalizeReport {
  readonly pages: number;
  readonly stoppedReason: MacroLoadStopReason;
}

export interface LoadOptionOpenInterestResult {
  readonly records: readonly OptionOpenInterestRecord[];
  readonly report: LoadOptionOpenInterestReport;
}

export interface LoadUnifiedSnapshotOptions extends MacroSharedLoaderOptions {
  /** Lista de hasta 250 tickers (`['SPY', 'I:SPX', 'I:VIX', ...]`) mapeada a `ticker.any_of`. */
  readonly tickers?: readonly string[];
  /** Ticker único opcional si no se pasa `tickers`. */
  readonly ticker?: string;
  readonly type?: 'stocks' | 'options' | 'fx' | 'crypto' | 'indices';
  readonly limit?: number;
}

export interface LoadUnifiedSnapshotReport extends UnifiedSnapshotNormalizeReport {
  readonly pages: number;
  readonly stoppedReason: MacroLoadStopReason;
  readonly requestedTickers: readonly string[];
}

export interface LoadUnifiedSnapshotResult {
  readonly stocks: readonly UnifiedStockSnapshot[];
  readonly indices: readonly UnifiedIndexSnapshot[];
  readonly options: readonly UnifiedOptionSnapshot[];
  readonly other: readonly UnifiedOtherAssetSnapshot[];
  readonly tickerErrors: readonly UnifiedSnapshotTickerError[];
  readonly report: LoadUnifiedSnapshotReport;
}
