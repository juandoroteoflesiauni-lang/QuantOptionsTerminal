/**
 * Cliente FMP Enterprise (Pieza 41).
 *
 * Contratos:
 * - Barra canónica: `time` es la APERTURA en segundos UTC enteros; FMP entrega
 *   fecha/hora civil de America/New_York y el adaptador convierte con DST.
 * - `vw` solo viaja si FMP lo entrega realmente; nunca se reconstruye desde
 *   high/low/close. Un campo no calculable es `null`/`NaN`, no un respaldo.
 * - La API key viaja como query, pero jamás se loguea ni se serializa: los
 *   errores exponen endpoint, status y conteo, y pasan por `redactSecrets`.
 * - El fallback legacy es explícito por provenance y no reintenta respuestas
 *   válidas vacías como si fueran errores.
 */

import './envBootstrap.js';

import type { Bar } from '../core/types.js';
import type { FetchFn, FetchResponse, Timeframe } from '../data/types.js';
import { etWallTimeToUtc } from '../data/alignment.js';
import { getMarketParts, isRth, MAX_TIME_SECONDS } from '../core/sessions.js';
import type {
  EarningsCatalystEvent,
  MacroCatalystEvent,
  MacroCatalystKind,
} from '../core/options/catalysts.js';
import { redactSecrets } from './runtimeCache.js';

export const FMP_API_KEY_ENV_NAME = 'FMP_API_KEY';
/** Pieza 41.1: aliases por rol. `FMP_API_KEY` es el principal. */
export const FMP_KEY_QUOTES_ENV_NAME = 'FMP_KEY_QUOTES';
export const FMP_KEY_MARKET_ENV_NAME = 'FMP_KEY_MARKET';
export const FMP_KEY_ETF_ENV_NAME = 'FMP_KEY_ETF';
export const FMP_KEY_MACRO_ENV_NAME = 'FMP_KEY_MACRO';
export const FMP_KEY_CALENDARS_ENV_NAME = 'FMP_KEY_CALENDARS';
export const FMP_KEY_ENV_NAMES = [
  FMP_API_KEY_ENV_NAME,
  FMP_KEY_QUOTES_ENV_NAME,
  FMP_KEY_MARKET_ENV_NAME,
  FMP_KEY_ETF_ENV_NAME,
  FMP_KEY_MACRO_ENV_NAME,
  FMP_KEY_CALENDARS_ENV_NAME,
] as const;
export const FMP_STABLE_BASE_URL = 'https://financialmodelingprep.com';
export const FMP_LEGACY_BASE_URL = 'https://financialmodelingprep.com';

export type FmpIntradayTimeframe = Exclude<Timeframe, '1D'>;
export type FmpSource = 'FMP_STABLE' | 'FMP_LEGACY';
export type FmpEndpoint =
  | 'HISTORICAL_CHART'
  | 'HISTORICAL_PRICE_EOD'
  | 'BATCH_QUOTE'
  | 'EXTENDED_BATCH_QUOTE'
  | 'EARNINGS_CALENDAR'
  | 'ECONOMIC_CALENDAR';
export type FmpBatchMode = 'stable-batch' | 'v3-batch' | 'stable-single-pool';
export type FmpExtendedQuotesSource =
  | 'FMP_STABLE_AFTERMARKET_BATCH'
  | 'FMP_V4_PRE_POST_BATCH'
  | 'FMP_STABLE_AFTERMARKET_SINGLE_POOL';

export const FMP_BATCH_QUOTE_CHUNK_SIZE = 50;

export interface FmpConfig {
  readonly apiKey: string | null;
  readonly quotesApiKey: string | null;
  readonly marketApiKey: string | null;
  readonly etfApiKey: string | null;
  readonly macroApiKey: string | null;
  readonly calendarsApiKey?: string | null;
  readonly configured: boolean;
  readonly baseUrl: string;
}

export type FmpKeyRole = 'PRIMARY' | 'QUOTES' | 'MARKET' | 'ETF' | 'MACRO' | 'CALENDARS';

export interface FmpKeySelection {
  readonly key: string;
  readonly envName: FmpKeyRole;
}

export interface FmpHistoricalRequest {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly fromUtcSec?: number;
  readonly toUtcSec?: number;
  readonly includeExtended?: boolean;
}

export interface FmpHistoricalResult {
  readonly bars: readonly Bar[];
  readonly source: FmpSource;
  readonly endpoint: FmpEndpoint;
  readonly requestedAtUtcSec: number;
  readonly httpStatus: number | null;
  readonly rows: number;
  readonly discarded: number;
  readonly legacyFallbackUsed: boolean;
  readonly keyEnvName: FmpKeyRole;
  readonly fromUtcSec: number | null;
  readonly toUtcSec: number | null;
}

export interface FmpBatchQuote {
  readonly symbol: string;
  readonly name: string | null;
  readonly exchange: string | null;
  readonly price: number;
  readonly previousClose: number | null;
  readonly change: number | null;
  readonly changePct: number | null;
  readonly volume: number | null;
  readonly turnover: number | null;
  readonly open: number | null;
  readonly dayLow: number | null;
  readonly dayHigh: number | null;
  readonly asOfUtcSec: number | null;
}

export interface FmpBatchQuotesResult {
  readonly quotes: readonly FmpBatchQuote[];
  readonly source: FmpSource;
  readonly endpoint: FmpEndpoint;
  readonly requestedAtUtcSec: number;
  readonly httpStatus: number | null;
  readonly rows: number;
  readonly discarded: number;
  readonly keyEnvName: FmpKeyRole;
  readonly batchMode: FmpBatchMode;
}

export interface FmpBatchChunkEvent {
  readonly quotes: readonly FmpBatchQuote[];
  readonly chunkIndex: number;
  readonly totalChunks: number;
  readonly batchMode: FmpBatchMode;
  readonly httpStatus: number;
  readonly atMs: number;
  readonly latencyMs: number | null;
}

export interface FmpBatchQuotesOptions {
  readonly chunkSize?: number;
  readonly onChunk?: (event: FmpBatchChunkEvent) => void;
}

export interface FmpExtendedQuote {
  readonly symbol: string;
  readonly price: number;
  readonly tradeSize: number | null;
  readonly bid: number | null;
  readonly bidSize: number | null;
  readonly ask: number | null;
  readonly askSize: number | null;
  readonly asOfUtcSec: number | null;
  readonly source: FmpExtendedQuotesSource;
}

export interface FmpExtendedBatchChunkEvent {
  readonly quotes: readonly FmpExtendedQuote[];
  readonly chunkIndex: number;
  readonly totalChunks: number;
  readonly source: FmpExtendedQuotesSource;
  readonly httpStatus: number;
  readonly atMs: number;
  readonly latencyMs: number | null;
}

export interface FmpExtendedBatchQuotesOptions {
  readonly chunkSize?: number;
  readonly maxSinglePoolSymbols?: number;
  readonly onChunk?: (event: FmpExtendedBatchChunkEvent) => void;
}

export interface FmpExtendedBatchQuotesResult {
  readonly quotes: readonly FmpExtendedQuote[];
  readonly source: FmpExtendedQuotesSource;
  readonly endpoint: 'EXTENDED_BATCH_QUOTE';
  readonly requestedAtUtcSec: number;
  readonly httpStatus: number | null;
  readonly rows: number;
  readonly discarded: number;
  readonly keyEnvName: FmpKeyRole;
}

export interface FmpHttpResult {
  readonly ok: boolean;
  readonly status: number;
  readonly text: string;
}

export type FmpHttpFn = (url: string) => Promise<FmpHttpResult>;

export interface FmpClientDeps {
  /** Configuración estática (tests/harness). Si falta, se resuelve `process.env`. */
  readonly config?: FmpConfig;
  /** Resolución dinámica por request; gana sobre `config`. */
  readonly resolveConfigFn?: () => FmpConfig;
  readonly fetchFn?: FmpHttpFn;
  readonly nowMsFn?: () => number;
  readonly secrets?: readonly string[];
  readonly batchChunkSize?: number;
  readonly onChunk?: (event: FmpBatchChunkEvent) => void;
  /** Telemetría local opcional: status/rows/latencia; nunca URL ni key. */
  readonly onResponse?: (input: {
    readonly httpStatus: number | null;
    readonly rows: number;
    readonly latencyMs: number | null;
    readonly chunkIndex?: number;
    readonly totalChunks?: number;
    readonly batchMode?: FmpBatchMode;
  }) => void;
}

export function resolveFmpConfig(env: NodeJS.ProcessEnv = process.env): FmpConfig {
  const readKey = (name: string): string | null => {
    const value = (env[name] ?? '').trim();
    return value === '' ? null : value;
  };
  const apiKey = readKey(FMP_API_KEY_ENV_NAME);
  const quotesApiKey = readKey(FMP_KEY_QUOTES_ENV_NAME);
  const marketApiKey = readKey(FMP_KEY_MARKET_ENV_NAME);
  const etfApiKey = readKey(FMP_KEY_ETF_ENV_NAME);
  const macroApiKey = readKey(FMP_KEY_MACRO_ENV_NAME);
  const calendarsApiKey = readKey(FMP_KEY_CALENDARS_ENV_NAME);
  return {
    apiKey,
    quotesApiKey,
    marketApiKey,
    etfApiKey,
    macroApiKey,
    calendarsApiKey,
    configured:
      apiKey !== null
      || quotesApiKey !== null
      || marketApiKey !== null
      || etfApiKey !== null
      || macroApiKey !== null
      || calendarsApiKey !== null,
    baseUrl: FMP_STABLE_BASE_URL,
  };
}

/** Alias histórico de la Pieza 41; siempre lee `process.env` en el call-site. */
export function loadFmpConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FmpConfig {
  return resolveFmpConfig(env);
}

const FMP_INTRADAY_PATH_BY_TIMEFRAME: Readonly<Record<FmpIntradayTimeframe, string>> = {
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
  '1h': '1hour',
  '4h': '4hour',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
}

function positive(value: unknown): number | null {
  const parsed = num(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function nonNegative(value: unknown): number | null {
  const parsed = num(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function nullable(value: unknown): number | null {
  const parsed = num(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanSymbol(value: string): string {
  return value.trim().toUpperCase();
}

export function fmpIntradayPath(timeframe: Timeframe): string {
  if (timeframe === '1D') return '';
  return FMP_INTRADAY_PATH_BY_TIMEFRAME[timeframe];
}

/**
 * Convierte un instante UTC a fecha civil ET para `from`/`to`. No redondea por
 * sí solo: el caller puede extender la ventana para cubrir borde de sesión.
 */
export function fmpEtDateKey(utcSec: number): string {
  if (!Number.isFinite(utcSec) || utcSec < 0) return '';
  const parts = getMarketParts(Math.floor(utcSec), 'EQUITY');
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return `${String(parts.year).padStart(4, '0')}-${month}-${day}`;
}

/**
 * FMP entrega `"YYYY-MM-DD HH:mm[:ss]"` en hora civil ET (incluyendo DST).
 * El resultado es la apertura exacta en segundos UTC. Fecha sin hora es 00:00
 * ET (contrato EOD). Invalid rows devuelven `NaN`.
 */
export function parseFmpEtDateTimeToUtcSec(value: unknown): number {
  if (typeof value !== 'string') return Number.NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim());
  if (match === null) return Number.NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return Number.NaN;
  const minutesOfDay = hour * 60 + minute + (second === 0 ? 0 : 0);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    return Number.NaN;
  }
  const utcSec = etWallTimeToUtc(year, month, day, minutesOfDay);
  const expectedDateKey = fmpEtDateKey(utcSec);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` === expectedDateKey
    ? utcSec + second
    : Number.NaN;
}

export function parseFmpHistoricalBars(
  raw: unknown,
  options?: { readonly rthOnly?: boolean },
): { readonly bars: readonly Bar[]; readonly discarded: number } {
  const rows = Array.isArray(raw) ? raw : [];
  const byTime = new Map<number, Bar>();
  let discarded = 0;
  for (const row of rows) {
    if (!isRecord(row)) {
      discarded += 1;
      continue;
    }
    const time = parseFmpEtDateTimeToUtcSec(row['date']);
    const open = num(row['open']);
    const high = num(row['high']);
    const low = num(row['low']);
    const close = num(row['close']);
    const volume = num(row['volume']);
    const rawVw = row['vw'];
    const vw =
      rawVw === undefined
        ? undefined
        : typeof rawVw === 'number' && Number.isFinite(rawVw)
          ? rawVw
          : Number.NaN;
    const validOhlc =
      Number.isFinite(time) && time > 0 &&
      Number.isFinite(open) && open > 0 &&
      Number.isFinite(high) && high >= open &&
      Number.isFinite(low) && low > 0 && high >= low &&
      Number.isFinite(close) && close > 0 &&
      Number.isFinite(volume) && volume >= 0;
    if (!validOhlc || (vw !== undefined && !Number.isFinite(vw))) {
      discarded += 1;
      continue;
    }
    const floorTime = Math.floor(time);
    if (options?.rthOnly === true && !isRth(floorTime)) {
      continue;
    }
    const bar: Bar = {
      time: floorTime,
      open,
      high,
      low,
      close,
      volume,
      ...(vw === undefined ? {} : { vw }),
    };
    byTime.set(bar.time, bar);
  }
  const bars = [...byTime.values()].sort((a, b) => a.time - b.time);
  // No se imponen rejillas UTC: FMP puede anclar 4H a hora civil ET y el
  // filtrado de sesión/RTH pertenece a la capa de datos o se pide vía rthOnly.
  return { bars, discarded };
}

export function parseFmpExtendedTimestampUtcSec(raw: unknown): number | null {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    if (/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.test(trimmed)) {
      const etSec = parseFmpEtDateTimeToUtcSec(trimmed);
      return Number.isFinite(etSec) && etSec > 0 ? Math.floor(etSec) : null;
    }
    if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
      const ms = Date.parse(trimmed);
      return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1_000) : null;
    }
    const asNum = Number(trimmed);
    if (!Number.isFinite(asNum)) return null;
    if (asNum >= 1_000_000_000_000 && asNum <= 9_999_999_999_999) {
      return Math.floor(asNum / 1_000);
    }
    if (asNum >= 1_000_000_000 && asNum <= 2_147_483_647) {
      return Math.floor(asNum);
    }
    return null;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw >= 1_000_000_000_000 && raw <= 9_999_999_999_999) {
      return Math.floor(raw / 1_000);
    }
    if (raw >= 1_000_000_000 && raw <= 2_147_483_647) {
      return Math.floor(raw);
    }
  }
  return null;
}

export interface ParsedAftermarketTrade {
  readonly symbol: string;
  readonly price: number;
  readonly tradeSize: number | null;
  readonly asOfUtcSec: number | null;
}

export interface ParsedAftermarketQuote {
  readonly symbol: string;
  readonly bid: number | null;
  readonly bidSize: number | null;
  readonly ask: number | null;
  readonly askSize: number | null;
  readonly asOfUtcSec: number | null;
}

export function parseFmpAftermarketTrades(
  raw: unknown,
): { readonly bySymbol: ReadonlyMap<string, ParsedAftermarketTrade>; readonly discarded: number } {
  const rows = Array.isArray(raw) ? raw : [];
  const bySymbol = new Map<string, ParsedAftermarketTrade>();
  let discarded = 0;
  for (const row of rows) {
    if (!isRecord(row) || typeof row['symbol'] !== 'string') {
      discarded += 1;
      continue;
    }
    const symbol = cleanSymbol(row['symbol']);
    const price = positive(row['price']);
    if (symbol === '' || price === null) {
      discarded += 1;
      continue;
    }
    const tradeSize = nonNegative(row['tradeSize'] ?? row['size'] ?? row['volume']);
    const asOfUtcSec = parseFmpExtendedTimestampUtcSec(row['timestamp']);
    const prev = bySymbol.get(symbol);
    if (
      prev !== undefined &&
      prev.asOfUtcSec !== null &&
      asOfUtcSec !== null &&
      asOfUtcSec < prev.asOfUtcSec
    ) {
      continue;
    }
    bySymbol.set(symbol, {
      symbol,
      price,
      tradeSize,
      asOfUtcSec,
    });
  }
  return { bySymbol, discarded };
}

export function parseFmpAftermarketQuotes(
  raw: unknown,
): { readonly bySymbol: ReadonlyMap<string, ParsedAftermarketQuote>; readonly discarded: number } {
  const rows = Array.isArray(raw) ? raw : [];
  const bySymbol = new Map<string, ParsedAftermarketQuote>();
  let discarded = 0;
  for (const row of rows) {
    if (!isRecord(row) || typeof row['symbol'] !== 'string') {
      discarded += 1;
      continue;
    }
    const symbol = cleanSymbol(row['symbol']);
    const bid = positive(row['bidPrice'] ?? row['bid']);
    const ask = positive(row['askPrice'] ?? row['ask']);
    if (symbol === '' || (bid === null && ask === null)) {
      discarded += 1;
      continue;
    }
    const bidSize = nonNegative(row['bidSize']);
    const askSize = nonNegative(row['askSize']);
    const asOfUtcSec = parseFmpExtendedTimestampUtcSec(row['timestamp']);
    const prev = bySymbol.get(symbol);
    if (
      prev !== undefined &&
      prev.asOfUtcSec !== null &&
      asOfUtcSec !== null &&
      asOfUtcSec < prev.asOfUtcSec
    ) {
      continue;
    }
    bySymbol.set(symbol, {
      symbol,
      bid,
      bidSize,
      ask,
      askSize,
      asOfUtcSec,
    });
  }
  return { bySymbol, discarded };
}

export function mergeFmpExtendedTradesAndQuotes(
  tradesBySymbol: ReadonlyMap<string, ParsedAftermarketTrade>,
  quotesBySymbol: ReadonlyMap<string, ParsedAftermarketQuote>,
  source: FmpExtendedQuotesSource,
): readonly FmpExtendedQuote[] {
  const symbols = new Set<string>([...tradesBySymbol.keys(), ...quotesBySymbol.keys()]);
  const out: FmpExtendedQuote[] = [];
  for (const symbol of symbols) {
    const trade = tradesBySymbol.get(symbol);
    const quote = quotesBySymbol.get(symbol);
    let price: number | null = trade?.price ?? null;
    if (price === null && quote !== undefined) {
      if (quote.bid !== null && quote.ask !== null && quote.ask >= quote.bid) {
        price = 0.5 * (quote.bid + quote.ask);
      }
    }
    if (price === null || !Number.isFinite(price) || price <= 0) continue;
    const tradeTs = trade?.asOfUtcSec ?? null;
    const quoteTs = quote?.asOfUtcSec ?? null;
    const asOfUtcSec =
      tradeTs !== null && quoteTs !== null
        ? Math.max(tradeTs, quoteTs)
        : (tradeTs ?? quoteTs);
    out.push({
      symbol,
      price,
      tradeSize: trade?.tradeSize ?? null,
      bid: quote?.bid ?? null,
      bidSize: quote?.bidSize ?? null,
      ask: quote?.ask ?? null,
      askSize: quote?.askSize ?? null,
      asOfUtcSec,
      source,
    });
  }
  return out;
}

export function parseFmpBatchQuotes(raw: unknown): { readonly quotes: readonly FmpBatchQuote[]; readonly discarded: number } {
  const rows = Array.isArray(raw) ? raw : [];
  const quotes: FmpBatchQuote[] = [];
  let discarded = 0;
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row) || typeof row['symbol'] !== 'string') {
      discarded += 1;
      continue;
    }
    const symbol = cleanSymbol(row['symbol']);
    const price = positive(row['price']);
    if (symbol === '' || price === null || seen.has(symbol)) {
      discarded += 1;
      continue;
    }
    seen.add(symbol);
    const previousClose = positive(row['previousClose']);
    const change = nullable(row['change']);
    const changePctRaw = nullable(row['changePercentage']);
    const volume = nonNegative(row['volume']);
    const open = positive(row['open']);
    const dayLow = positive(row['dayLow']);
    const dayHigh = positive(row['dayHigh']);
    quotes.push({
      symbol,
      name: typeof row['name'] === 'string' && row['name'].trim() !== '' ? row['name'] : null,
      exchange: typeof row['exchange'] === 'string' && row['exchange'].trim() !== '' ? row['exchange'].trim().toUpperCase() : null,
      price,
      previousClose,
      change,
      changePct:
        changePctRaw !== null
          ? changePctRaw
          : previousClose !== null && previousClose > 0
            ? ((price - previousClose) / previousClose) * 100
            : null,
      volume,
      turnover: null,
      open,
      dayLow,
      dayHigh,
      asOfUtcSec: (() => {
        const ts = num(row['timestamp']);
        // FMP batch usa segundos; un valor enorme se descarta en lugar de
        // adivinar la unidad.
        return Number.isFinite(ts) && ts > 0 && ts <= 2_147_483_647 ? Math.floor(ts) : null;
      })(),
    });
  }
  return { quotes, discarded };
}

function buildAuthUrl(pathWithQuery: string, apiKey: string): string {
  const url = new URL(`${FMP_STABLE_BASE_URL}${pathWithQuery}`);
  url.searchParams.set('apikey', apiKey);
  return url.toString();
}

function buildLegacyChartUrl(
  symbol: string,
  path: string,
  apiKey: string,
  includeExtended = false,
): string {
  const url = new URL(`${FMP_LEGACY_BASE_URL}/api/v3/historical-chart/${path}/${encodeURIComponent(symbol)}`);
  if (includeExtended) {
    url.searchParams.set('extended', 'true');
  }
  url.searchParams.set('apikey', apiKey);
  return url.toString();
}

function buildLegacyBatchQuoteUrl(symbols: readonly string[], apiKey: string): string {
  const url = new URL(`${FMP_LEGACY_BASE_URL}/api/v3/quote/${encodeURIComponent(symbols.join(','))}`);
  url.searchParams.set('apikey', apiKey);
  return url.toString();
}

function buildStableAftermarketTradeBatchUrl(symbols: readonly string[], apiKey: string): string {
  const query = new URLSearchParams({ symbols: symbols.join(',') });
  return buildAuthUrl(`/stable/batch-aftermarket-trade?${query.toString()}`, apiKey);
}

function buildStableAftermarketQuoteBatchUrl(symbols: readonly string[], apiKey: string): string {
  const query = new URLSearchParams({ symbols: symbols.join(',') });
  return buildAuthUrl(`/stable/batch-aftermarket-quote?${query.toString()}`, apiKey);
}

function buildV4PrePostBatchTradeUrl(symbols: readonly string[], apiKey: string): string {
  const url = new URL(
    `${FMP_LEGACY_BASE_URL}/api/v4/batch-pre-post-market-trade/${encodeURIComponent(symbols.join(','))}`,
  );
  url.searchParams.set('apikey', apiKey);
  return url.toString();
}

function buildStableAftermarketSingleTradeUrl(symbol: string, apiKey: string): string {
  const query = new URLSearchParams({ symbol });
  return buildAuthUrl(`/stable/aftermarket-trade?${query.toString()}`, apiKey);
}

export function buildFmpHistoricalPath(request: FmpHistoricalRequest): string {
  const symbol = cleanSymbol(request.symbol);
  if (symbol === '') throw new Error('FMP historical request requires a symbol');
  if (request.timeframe === '1D') {
    const query = new URLSearchParams({ symbol });
    if (request.fromUtcSec !== undefined && Number.isFinite(request.fromUtcSec)) {
      query.set('from', fmpEtDateKey(request.fromUtcSec));
    }
    if (request.toUtcSec !== undefined && Number.isFinite(request.toUtcSec)) {
      query.set('to', fmpEtDateKey(request.toUtcSec));
    }
    return `/stable/historical-price-eod/full?${query.toString()}`;
  }
  const path = fmpIntradayPath(request.timeframe);
  const query = new URLSearchParams({ symbol });
  if (request.includeExtended === true) {
    query.set('extended', 'true');
  }
  if (request.fromUtcSec !== undefined && Number.isFinite(request.fromUtcSec)) {
    query.set('from', fmpEtDateKey(request.fromUtcSec));
  }
  if (request.toUtcSec !== undefined && Number.isFinite(request.toUtcSec)) {
    query.set('to', fmpEtDateKey(request.toUtcSec));
  }
  return `/stable/historical-chart/${path}?${query.toString()}`;
}

export function createDefaultFmpHttpFn(timeoutMs = 12_000): FmpHttpFn {
  return async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: response.ok, status: response.status, text: await response.text() };
  };
}

export class FmpEnterpriseClient {
  private readonly configOverride: FmpConfig | null;
  private readonly resolveConfigFn: (() => FmpConfig) | null;
  private readonly fetchFn: FmpHttpFn;
  private readonly nowMsFn: () => number;
  private readonly baseSecrets: readonly string[];
  private lastError: string | null = null;
  private lastSuccessAtMs: number | null = null;
  private lastBatchMode: FmpBatchMode = 'stable-single-pool';
  private requests = 0;
  private readonly batchChunkSize: number;
  private readonly onChunk: FmpClientDeps['onChunk'];
  private readonly onResponse: FmpClientDeps['onResponse'];

  public constructor(deps: FmpClientDeps) {
    this.configOverride = deps.config ?? null;
    this.resolveConfigFn = deps.resolveConfigFn ?? null;
    this.fetchFn = deps.fetchFn ?? createDefaultFmpHttpFn();
    this.nowMsFn = deps.nowMsFn ?? (() => Date.now());
    this.baseSecrets = [...(deps.secrets ?? [])];
    const requestedChunkSize = deps.batchChunkSize ?? FMP_BATCH_QUOTE_CHUNK_SIZE;
    this.batchChunkSize = Number.isFinite(requestedChunkSize)
      ? Math.max(1, Math.floor(requestedChunkSize))
      : FMP_BATCH_QUOTE_CHUNK_SIZE;
    this.onChunk = deps.onChunk;
    this.onResponse = deps.onResponse;
  }

  private effectiveConfig(): FmpConfig {
    if (this.resolveConfigFn !== null) return this.resolveConfigFn();
    if (this.configOverride !== null) return this.configOverride;
    return resolveFmpConfig();
  }

  private apiKeyFor(
    endpoint: 'MARKET' | 'QUOTES' | 'EXTENDED_QUOTES' | 'CALENDARS' | 'MACRO',
  ): FmpKeySelection | null {
    const config = this.effectiveConfig();
    if (endpoint === 'CALENDARS') {
      const calKey = config.calendarsApiKey ?? null;
      if (calKey !== null) return { key: calKey, envName: 'CALENDARS' };
      if (config.macroApiKey !== null) return { key: config.macroApiKey, envName: 'MACRO' };
      if (config.apiKey !== null) return { key: config.apiKey, envName: 'PRIMARY' };
      return null;
    }
    if (endpoint === 'MACRO') {
      if (config.macroApiKey !== null) return { key: config.macroApiKey, envName: 'MACRO' };
      const calKey = config.calendarsApiKey ?? null;
      if (calKey !== null) return { key: calKey, envName: 'CALENDARS' };
      if (config.apiKey !== null) return { key: config.apiKey, envName: 'PRIMARY' };
      return null;
    }
    if (endpoint === 'QUOTES') {
      if (config.quotesApiKey !== null) return { key: config.quotesApiKey, envName: 'QUOTES' };
      if (config.apiKey !== null) return { key: config.apiKey, envName: 'PRIMARY' };
      return null;
    }
    if (endpoint === 'EXTENDED_QUOTES') {
      if (config.quotesApiKey !== null) return { key: config.quotesApiKey, envName: 'QUOTES' };
      if (config.marketApiKey !== null) return { key: config.marketApiKey, envName: 'MARKET' };
      if (config.apiKey !== null) return { key: config.apiKey, envName: 'PRIMARY' };
      return null;
    }
    if (config.marketApiKey !== null) return { key: config.marketApiKey, envName: 'MARKET' };
    if (config.apiKey !== null) return { key: config.apiKey, envName: 'PRIMARY' };
    return null;
  }

  private currentSecrets(): readonly string[] {
    const config = this.effectiveConfig();
    return [
      ...this.baseSecrets,
      ...[
        config.apiKey,
        config.quotesApiKey,
        config.marketApiKey,
        config.etfApiKey,
        config.macroApiKey,
        config.calendarsApiKey ?? null,
      ].filter((key): key is string => key !== null),
    ];
  }

  public getDiagnostics(): {
    readonly configured: boolean;
    readonly requests: number;
    readonly lastSuccessAtMs: number | null;
    readonly lastError: string | null;
    readonly batchMode: FmpBatchMode;
  } {
    return {
      configured: this.effectiveConfig().configured,
      requests: this.requests,
      lastSuccessAtMs: this.lastSuccessAtMs,
      lastError: this.lastError === null ? null : redactSecrets(this.lastError, this.currentSecrets()),
      batchMode: this.lastBatchMode,
    };
  }

  private async fetchRawWithTiming(url: string): Promise<{
    readonly response: FmpHttpResult;
    readonly latencyMs: number | null;
  }> {
    this.requests += 1;
    const startedAtMs = this.nowMsFn();
    try {
      const response = await this.fetchFn(url);
      const finishedAtMs = this.nowMsFn();
      const latencyMs = finishedAtMs >= startedAtMs ? finishedAtMs - startedAtMs : null;
      return { response, latencyMs };
    } catch (err: unknown) {
      const finishedAtMs = this.nowMsFn();
      const latencyMs = finishedAtMs >= startedAtMs ? finishedAtMs - startedAtMs : null;
      this.onResponse?.({ httpStatus: null, rows: 0, latencyMs });
      const raw = err instanceof Error ? err.message : String(err);
      const redacted = redactSecrets(`FMP request failed: ${raw}`, this.currentSecrets());
      this.lastError = redacted;
      throw new Error(redacted);
    }
  }

  private async fetchRedacted(url: string): Promise<FmpHttpResult> {
    const { response, latencyMs } = await this.fetchRawWithTiming(url);
    this.onResponse?.({ httpStatus: response.status, rows: 0, latencyMs });
    return response;
  }

  public async fetchHistorical(request: FmpHistoricalRequest): Promise<FmpHistoricalResult> {
    const config = this.effectiveConfig();
    const keySelection = this.apiKeyFor('MARKET');
    if (!config.configured || keySelection === null) {
      throw new Error('FMP market data is not configured: FMP_KEY_MARKET / FMP_API_KEY missing');
    }
    const requestedAtUtcSec = Math.floor(this.nowMsFn() / 1_000);
    const path = buildFmpHistoricalPath(request);
    let response = await this.fetchRedacted(buildAuthUrl(path, keySelection.key));
    let source: FmpSource = 'FMP_STABLE';
    let legacyFallbackUsed = false;
    const includeExtended = request.timeframe !== '1D' && request.includeExtended === true;
    if (!response.ok) {
      if (request.timeframe === '1D') {
        throw new Error(`FMP EOD HTTP ${String(response.status)}`);
      }
      const symbol = cleanSymbol(request.symbol);
      const pathName = fmpIntradayPath(request.timeframe);
      if (pathName === '') throw new Error(`FMP chart HTTP ${String(response.status)}`);
      response = await this.fetchRedacted(
        buildLegacyChartUrl(symbol, pathName, keySelection.key, includeExtended),
      );
      source = 'FMP_LEGACY';
      legacyFallbackUsed = true;
      if (!response.ok) {
        throw new Error(`FMP legacy chart HTTP ${String(response.status)}`);
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text) as unknown;
    } catch {
      throw new Error(`FMP ${source.toLowerCase()} returned invalid JSON`);
    }
    const normalized = parseFmpHistoricalBars(parsed, {
      rthOnly: request.timeframe !== '1D' && request.includeExtended === false,
    });
    this.recordResponse(response.ok, normalized.bars.length);
    return {
      bars: normalized.bars,
      source,
      endpoint: request.timeframe === '1D' ? 'HISTORICAL_PRICE_EOD' : 'HISTORICAL_CHART',
      requestedAtUtcSec,
      httpStatus: response.status,
      rows: normalized.bars.length,
      discarded: normalized.discarded,
      legacyFallbackUsed,
      keyEnvName: keySelection.envName,
      fromUtcSec: request.fromUtcSec ?? null,
      toUtcSec: request.toUtcSec ?? null,
    };
  }

  public async fetchBatchQuotes(
    symbols: readonly string[],
    options?: FmpBatchQuotesOptions,
  ): Promise<FmpBatchQuotesResult> {
    const config = this.effectiveConfig();
    const keySelection = this.apiKeyFor('QUOTES');
    if (!config.configured || keySelection === null) {
      throw new Error('FMP quotes are not configured: FMP_KEY_QUOTES / FMP_API_KEY missing');
    }
    const clean = [...new Set(symbols.map(cleanSymbol).filter((symbol) => symbol !== ''))];
    if (clean.length === 0) throw new Error('FMP batch quote requires symbols');
    const requestedAtUtcSec = Math.floor(this.nowMsFn() / 1_000);
    const requestedChunkSize = options?.chunkSize ?? this.batchChunkSize;
    const effectiveChunkSize = Number.isFinite(requestedChunkSize)
      ? Math.max(1, Math.floor(requestedChunkSize))
      : this.batchChunkSize;

    const chunks: string[][] = [];
    for (let i = 0; i < clean.length; i += effectiveChunkSize) {
      const slice = clean.slice(i, i + effectiveChunkSize);
      if (slice.length > 0) chunks.push(slice);
    }

    let batchMode: FmpBatchMode = chunks.length > 1 ? 'stable-single-pool' : 'stable-batch';
    let source: FmpSource = 'FMP_STABLE';
    const allQuotes: FmpBatchQuote[] = [];
    const seenSymbols = new Set<string>();
    let totalDiscarded = 0;
    let lastHttpStatus: number | null = null;

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const chunk = chunks[chunkIndex];
      if (chunk === undefined || chunk.length === 0) continue;

      const buildUrl = (useLegacy: boolean): string => {
        if (useLegacy) return buildLegacyBatchQuoteUrl(chunk, keySelection.key);
        const query = new URLSearchParams({ symbols: chunk.join(',') });
        return buildAuthUrl(`/stable/batch-quote?${query.toString()}`, keySelection.key);
      };

      let { response, latencyMs } = await this.fetchRawWithTiming(buildUrl(source === 'FMP_LEGACY'));
      if (
        source === 'FMP_STABLE' &&
        !response.ok &&
        (response.status === 402 || response.status === 403 || response.status === 404)
      ) {
        this.onResponse?.({
          httpStatus: response.status,
          rows: 0,
          latencyMs,
          chunkIndex,
          totalChunks: chunks.length,
          batchMode,
        });
        const legacyResult = await this.fetchRawWithTiming(buildUrl(true));
        response = legacyResult.response;
        latencyMs = legacyResult.latencyMs;
        if (response.ok) {
          source = 'FMP_LEGACY';
          batchMode = 'v3-batch';
        }
      }

      lastHttpStatus = response.status;
      if (!response.ok) {
        this.onResponse?.({
          httpStatus: response.status,
          rows: 0,
          latencyMs,
          chunkIndex,
          totalChunks: chunks.length,
          batchMode,
        });
        const errorMsg = `FMP batch quote HTTP ${String(response.status)}`;
        this.lastError = errorMsg;
        throw new Error(errorMsg);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(response.text) as unknown;
      } catch {
        const errorMsg = 'FMP batch quote returned invalid JSON';
        this.lastError = errorMsg;
        throw new Error(errorMsg);
      }

      const normalized = parseFmpBatchQuotes(parsed);
      totalDiscarded += normalized.discarded;
      const chunkQuotes: FmpBatchQuote[] = [];
      for (const quote of normalized.quotes) {
        if (seenSymbols.has(quote.symbol)) {
          totalDiscarded += 1;
          continue;
        }
        seenSymbols.add(quote.symbol);
        allQuotes.push(quote);
        chunkQuotes.push(quote);
      }

      this.lastBatchMode = batchMode;
      this.recordResponse(true, normalized.quotes.length);
      this.onResponse?.({
        httpStatus: response.status,
        rows: normalized.quotes.length,
        latencyMs,
        chunkIndex,
        totalChunks: chunks.length,
        batchMode,
      });

      const chunkEvent: FmpBatchChunkEvent = {
        quotes: chunkQuotes,
        chunkIndex,
        totalChunks: chunks.length,
        batchMode,
        httpStatus: response.status,
        atMs: this.nowMsFn(),
        latencyMs,
      };
      options?.onChunk?.(chunkEvent);
      this.onChunk?.(chunkEvent);
    }

    return {
      quotes: allQuotes,
      source,
      endpoint: 'BATCH_QUOTE',
      requestedAtUtcSec,
      httpStatus: lastHttpStatus,
      rows: allQuotes.length,
      discarded: totalDiscarded,
      keyEnvName: keySelection.envName,
      batchMode,
    };
  }

  public async fetchExtendedBatchQuotes(
    symbols: readonly string[],
    options?: FmpExtendedBatchQuotesOptions,
  ): Promise<FmpExtendedBatchQuotesResult> {
    const config = this.effectiveConfig();
    const keySelection = this.apiKeyFor('EXTENDED_QUOTES');
    if (!config.configured || keySelection === null) {
      throw new Error('FMP extended quotes are not configured: FMP_KEY_QUOTES / FMP_KEY_MARKET / FMP_API_KEY missing');
    }
    const clean = [...new Set(symbols.map(cleanSymbol).filter((symbol) => symbol !== ''))];
    if (clean.length === 0) throw new Error('FMP extended batch quote requires symbols');

    const requestedAtUtcSec = Math.floor(this.nowMsFn() / 1_000);
    const requestedChunkSize = options?.chunkSize ?? this.batchChunkSize;
    const effectiveChunkSize = Number.isFinite(requestedChunkSize)
      ? Math.max(1, Math.floor(requestedChunkSize))
      : this.batchChunkSize;

    const chunks: string[][] = [];
    for (let i = 0; i < clean.length; i += effectiveChunkSize) {
      const slice = clean.slice(i, i + effectiveChunkSize);
      if (slice.length > 0) chunks.push(slice);
    }

    const parseJsonSafe = (
      text: string,
    ): { readonly ok: true; readonly value: unknown } | { readonly ok: false } => {
      try {
        return { ok: true, value: JSON.parse(text) as unknown };
      } catch {
        return { ok: false };
      }
    };

    const allQuotesBySymbol = new Map<string, FmpExtendedQuote>();
    let source: FmpExtendedQuotesSource = 'FMP_STABLE_AFTERMARKET_BATCH';
    let totalDiscarded = 0;
    let lastHttpStatus: number | null = null;
    let cascadeFromChunk = 0;

    // Tier 1: /stable/batch-aftermarket-trade + /stable/batch-aftermarket-quote
    let tier1BlockedStatus: number | null = null;
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const chunk = chunks[chunkIndex];
      if (chunk === undefined || chunk.length === 0) continue;
      const [tradeRes, quoteRes] = await Promise.all([
        this.fetchRawWithTiming(buildStableAftermarketTradeBatchUrl(chunk, keySelection.key)),
        this.fetchRawWithTiming(buildStableAftermarketQuoteBatchUrl(chunk, keySelection.key)).catch(() => null),
      ]);
      lastHttpStatus = tradeRes.response.status;
      if (!tradeRes.response.ok) {
        this.onResponse?.({
          httpStatus: tradeRes.response.status,
          rows: 0,
          latencyMs: tradeRes.latencyMs,
          chunkIndex,
          totalChunks: chunks.length,
        });
        if (tradeRes.response.status === 402 || tradeRes.response.status === 403 || tradeRes.response.status === 404) {
          tier1BlockedStatus = tradeRes.response.status;
          cascadeFromChunk = chunkIndex;
          break;
        }
        const errorMsg = `FMP extended batch quote HTTP ${String(tradeRes.response.status)}`;
        this.lastError = errorMsg;
        throw new Error(errorMsg);
      }

      const parsedTrades = parseJsonSafe(tradeRes.response.text);
      if (!parsedTrades.ok) {
        const errorMsg = 'FMP extended batch trade returned invalid JSON';
        this.lastError = errorMsg;
        throw new Error(errorMsg);
      }
      const tradesNorm = parseFmpAftermarketTrades(parsedTrades.value);
      totalDiscarded += tradesNorm.discarded;

      let quotesNorm: { readonly bySymbol: ReadonlyMap<string, ParsedAftermarketQuote>; readonly discarded: number } = {
        bySymbol: new Map(),
        discarded: 0,
      };
      if (quoteRes !== null && quoteRes.response.ok) {
        const parsedQuotes = parseJsonSafe(quoteRes.response.text);
        if (parsedQuotes.ok) {
          quotesNorm = parseFmpAftermarketQuotes(parsedQuotes.value);
          totalDiscarded += quotesNorm.discarded;
        }
      }

      const chunkQuotes = mergeFmpExtendedTradesAndQuotes(
        tradesNorm.bySymbol,
        quotesNorm.bySymbol,
        'FMP_STABLE_AFTERMARKET_BATCH',
      );
      for (const q of chunkQuotes) {
        allQuotesBySymbol.set(q.symbol, q);
      }
      this.recordResponse(true, chunkQuotes.length);
      this.onResponse?.({
        httpStatus: tradeRes.response.status,
        rows: chunkQuotes.length,
        latencyMs: tradeRes.latencyMs,
        chunkIndex,
        totalChunks: chunks.length,
      });
      options?.onChunk?.({
        quotes: chunkQuotes,
        chunkIndex,
        totalChunks: chunks.length,
        source: 'FMP_STABLE_AFTERMARKET_BATCH',
        httpStatus: tradeRes.response.status,
        atMs: this.nowMsFn(),
        latencyMs: tradeRes.latencyMs,
      });
    }

    // Tier 2: /api/v4/batch-pre-post-market-trade/<symbols> ante 402/403/404 en /stable
    let tier2BlockedStatus: number | null = null;
    if (tier1BlockedStatus !== null) {
      for (let chunkIndex = cascadeFromChunk; chunkIndex < chunks.length; chunkIndex += 1) {
        const chunk = chunks[chunkIndex];
        if (chunk === undefined || chunk.length === 0) continue;
        const v4Res = await this.fetchRawWithTiming(buildV4PrePostBatchTradeUrl(chunk, keySelection.key));
        lastHttpStatus = v4Res.response.status;
        if (!v4Res.response.ok) {
          this.onResponse?.({
            httpStatus: v4Res.response.status,
            rows: 0,
            latencyMs: v4Res.latencyMs,
            chunkIndex,
            totalChunks: chunks.length,
          });
          if (v4Res.response.status === 402 || v4Res.response.status === 403 || v4Res.response.status === 404) {
            tier2BlockedStatus = v4Res.response.status;
            break;
          }
          const errorMsg = `FMP extended v4 batch HTTP ${String(v4Res.response.status)}`;
          this.lastError = errorMsg;
          throw new Error(errorMsg);
        }
        const parsedV4 = parseJsonSafe(v4Res.response.text);
        if (!parsedV4.ok) {
          const errorMsg = 'FMP extended v4 batch returned invalid JSON';
          this.lastError = errorMsg;
          throw new Error(errorMsg);
        }
        source = 'FMP_V4_PRE_POST_BATCH';
        const tradesNorm = parseFmpAftermarketTrades(parsedV4.value);
        totalDiscarded += tradesNorm.discarded;
        const chunkQuotes = mergeFmpExtendedTradesAndQuotes(
          tradesNorm.bySymbol,
          new Map(),
          'FMP_V4_PRE_POST_BATCH',
        );
        for (const q of chunkQuotes) {
          allQuotesBySymbol.set(q.symbol, q);
        }
        this.recordResponse(true, chunkQuotes.length);
        this.onResponse?.({
          httpStatus: v4Res.response.status,
          rows: chunkQuotes.length,
          latencyMs: v4Res.latencyMs,
          chunkIndex,
          totalChunks: chunks.length,
        });
        options?.onChunk?.({
          quotes: chunkQuotes,
          chunkIndex,
          totalChunks: chunks.length,
          source: 'FMP_V4_PRE_POST_BATCH',
          httpStatus: v4Res.response.status,
          atMs: this.nowMsFn(),
          latencyMs: v4Res.latencyMs,
        });
      }
    }

    // Tier 3: pool acotado /stable/aftermarket-trade?symbol=<SYM> (fallback si v4 también está bloqueado)
    if (tier2BlockedStatus !== null) {
      const maxSingle = Math.max(1, Math.floor(options?.maxSinglePoolSymbols ?? 20));
      const subset = clean.slice(0, maxSingle);
      const poolResults: FmpExtendedQuote[] = [];
      let lastPoolStatus = tier2BlockedStatus;
      let anyPoolSuccess = false;
      const concurrency = 4;
      for (let i = 0; i < subset.length; i += concurrency) {
        const batch = subset.slice(i, i + concurrency);
        const settled = await Promise.all(
          batch.map((sym) =>
            this.fetchRawWithTiming(buildStableAftermarketSingleTradeUrl(sym, keySelection.key)).catch(() => null),
          ),
        );
        for (const res of settled) {
          if (res === null) continue;
          lastPoolStatus = res.response.status;
          if (!res.response.ok) continue;
          const parsedSingle = parseJsonSafe(res.response.text);
          if (!parsedSingle.ok) continue;
          anyPoolSuccess = true;
          const tradesNorm = parseFmpAftermarketTrades(parsedSingle.value);
          totalDiscarded += tradesNorm.discarded;
          const singleQuotes = mergeFmpExtendedTradesAndQuotes(
            tradesNorm.bySymbol,
            new Map(),
            'FMP_STABLE_AFTERMARKET_SINGLE_POOL',
          );
          for (const q of singleQuotes) {
            allQuotesBySymbol.set(q.symbol, q);
            poolResults.push(q);
          }
        }
      }
      lastHttpStatus = lastPoolStatus;
      if (!anyPoolSuccess) {
        const errorMsg = `FMP extended batch quote HTTP ${String(lastPoolStatus)}`;
        this.lastError = errorMsg;
        throw new Error(errorMsg);
      }
      source = 'FMP_STABLE_AFTERMARKET_SINGLE_POOL';
      this.recordResponse(true, poolResults.length);
      this.onResponse?.({
        httpStatus: 200,
        rows: poolResults.length,
        latencyMs: null,
        chunkIndex: 0,
        totalChunks: 1,
      });
      options?.onChunk?.({
        quotes: poolResults,
        chunkIndex: 0,
        totalChunks: 1,
        source: 'FMP_STABLE_AFTERMARKET_SINGLE_POOL',
        httpStatus: 200,
        atMs: this.nowMsFn(),
        latencyMs: null,
      });
    }

    const quotes = [...allQuotesBySymbol.values()];
    return {
      quotes,
      source,
      endpoint: 'EXTENDED_BATCH_QUOTE',
      requestedAtUtcSec,
      httpStatus: lastHttpStatus,
      rows: quotes.length,
      discarded: totalDiscarded,
      keyEnvName: keySelection.envName,
    };
  }

  /**
   * Consulta en FMP Enterprise las fechas de Earnings del subyacente US.
   * Degrada honestamente a `nextEarnings: null, lastEarnings: null, available: false`
   * cuando no hay clave configurada o FMP no devuelve datos.
   */
  public async fetchSymbolEarnings(
    symbol: string,
    nowUtcSec?: number,
  ): Promise<FmpSymbolEarningsResult> {
    const cleanSym = cleanSymbol(symbol);
    const asOfUtcSec =
      nowUtcSec !== undefined && Number.isFinite(nowUtcSec)
        ? Math.floor(nowUtcSec)
        : Math.floor(this.nowMsFn() / 1_000);
    const keySelection = this.apiKeyFor('CALENDARS');
    if (cleanSym === '') {
      return {
        symbol: '',
        asOfUtcSec,
        nextEarnings: null,
        lastEarnings: null,
        events: [],
        source: null,
        available: false,
        reason: 'Símbolo requerido para Earnings',
      };
    }
    if (!this.effectiveConfig().configured || keySelection === null) {
      return {
        symbol: cleanSym,
        asOfUtcSec,
        nextEarnings: null,
        lastEarnings: null,
        events: [],
        source: null,
        available: false,
        reason: 'FMP_KEY_CALENDARS / FMP_API_KEY no configurada',
      };
    }

    const fromKey = fmpEtDateKey(asOfUtcSec - 15 * 86_400);
    const toKey = fmpEtDateKey(asOfUtcSec + 120 * 86_400);
    const endpointsToTry: readonly { readonly path: string; readonly tag: string }[] = [
      { path: buildFmpEarningsPath(cleanSym, 20), tag: 'FMP_STABLE_EARNINGS' },
      { path: buildFmpEarningsCalendarWindowPath(fromKey, toKey), tag: 'FMP_STABLE_EARNINGS_CALENDAR' },
    ];

    let lastFailureReason: string | null = null;
    for (const candidate of endpointsToTry) {
      let response: FmpHttpResult;
      try {
        response = await this.fetchRedacted(buildAuthUrl(candidate.path, keySelection.key));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        lastFailureReason = redactSecrets(msg, this.currentSecrets());
        continue;
      }

      if (!response.ok) {
        lastFailureReason = `FMP earnings HTTP ${String(response.status)}`;
        // Reintenta fallback si el plan restringe /stable/earnings o no existe.
        if (response.status === 402 || response.status === 403 || response.status === 404) {
          continue;
        }
        return {
          symbol: cleanSym,
          asOfUtcSec,
          nextEarnings: null,
          lastEarnings: null,
          events: [],
          source: null,
          available: false,
          reason: redactSecrets(lastFailureReason, this.currentSecrets()),
        };
      }

      let raw: unknown;
      try {
        raw = JSON.parse(response.text) as unknown;
      } catch {
        lastFailureReason = 'FMP earnings JSON inválido';
        continue;
      }

      const parsed = parseFmpEarningsCalendar(raw, cleanSym, asOfUtcSec);
      this.recordResponse(true, parsed.events.length);
      if (parsed.events.length === 0 && candidate.tag === 'FMP_STABLE_EARNINGS') {
        continue;
      }
      return {
        symbol: cleanSym,
        asOfUtcSec,
        nextEarnings: parsed.nextEarnings,
        lastEarnings: parsed.lastEarnings,
        events: parsed.events,
        source: candidate.tag,
        available: true,
        reason: null,
      };
    }

    return {
      symbol: cleanSym,
      asOfUtcSec,
      nextEarnings: null,
      lastEarnings: null,
      events: [],
      source: null,
      available: lastFailureReason === null,
      reason:
        lastFailureReason === null
          ? null
          : redactSecrets(lastFailureReason, this.currentSecrets()),
    };
  }

  /**
   * Consulta el calendario económico US en FMP (`/stable/economic-calendar`) filtrando
   * eventos de alto impacto `FOMC` y `CPI`.
   */
  public async fetchUsMacroCalendar(nowUtcSec?: number): Promise<FmpMacroCalendarResult> {
    const asOfUtcSec =
      nowUtcSec !== undefined && Number.isFinite(nowUtcSec)
        ? Math.floor(nowUtcSec)
        : Math.floor(this.nowMsFn() / 1_000);
    const keySelection = this.apiKeyFor('MACRO');
    if (!this.effectiveConfig().configured || keySelection === null) {
      return {
        asOfUtcSec,
        events: [],
        source: null,
        available: false,
        reason: 'FMP_KEY_MACRO / FMP_KEY_CALENDARS no configurada',
      };
    }

    const fromKey = fmpEtDateKey(asOfUtcSec - 7 * 86_400);
    const toKey = fmpEtDateKey(asOfUtcSec + 120 * 86_400);
    const path = buildFmpEconomicCalendarPath(fromKey, toKey);

    let response: FmpHttpResult;
    try {
      response = await this.fetchRedacted(buildAuthUrl(path, keySelection.key));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        asOfUtcSec,
        events: [],
        source: null,
        available: false,
        reason: redactSecrets(msg, this.currentSecrets()),
      };
    }

    if (!response.ok) {
      return {
        asOfUtcSec,
        events: [],
        source: null,
        available: false,
        reason: `FMP economic calendar HTTP ${String(response.status)}`,
      };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(response.text) as unknown;
    } catch {
      return {
        asOfUtcSec,
        events: [],
        source: null,
        available: false,
        reason: 'FMP economic calendar JSON inválido',
      };
    }

    const events = parseFmpEconomicCalendarMacroEvents(raw);
    this.recordResponse(true, events.length);
    return {
      asOfUtcSec,
      events,
      source: 'FMP_STABLE_ECONOMIC_CALENDAR',
      available: true,
      reason: null,
    };
  }

  private recordResponse(ok: boolean, rows: number): void {
    if (ok && rows > 0) {
      this.lastSuccessAtMs = this.nowMsFn();
      this.lastError = null;
    } else if (ok && rows === 0) {
      this.lastError = 'FMP response contained no valid rows';
    }
  }
}

export interface FmpSymbolEarningsResult {
  readonly symbol: string;
  readonly asOfUtcSec: number;
  readonly nextEarnings: EarningsCatalystEvent | null;
  readonly lastEarnings: EarningsCatalystEvent | null;
  readonly events: readonly EarningsCatalystEvent[];
  readonly source: string | null;
  readonly available: boolean;
  readonly reason: string | null;
}

export interface FmpMacroCalendarResult {
  readonly asOfUtcSec: number;
  readonly events: readonly MacroCatalystEvent[];
  readonly source: string | null;
  readonly available: boolean;
  readonly reason: string | null;
}

export function buildFmpEarningsPath(symbol: string, limit = 20): string {
  const query = new URLSearchParams({ symbol: cleanSymbol(symbol), limit: String(limit) });
  return `/stable/earnings?${query.toString()}`;
}

export function buildFmpEarningsCalendarWindowPath(fromDate: string, toDate: string): string {
  const query = new URLSearchParams({ from: fromDate, to: toDate });
  return `/stable/earnings-calendar?${query.toString()}`;
}

export function buildFmpEconomicCalendarPath(fromDate: string, toDate: string): string {
  const query = new URLSearchParams({ from: fromDate, to: toDate });
  return `/stable/economic-calendar?${query.toString()}`;
}

function normalizeEarningsTimeOfDay(raw: unknown): 'bmo' | 'amc' | 'unknown' {
  if (typeof raw !== 'string') return 'unknown';
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'bmo' || normalized.includes('before')) return 'bmo';
  if (normalized === 'amc' || normalized.includes('after')) return 'amc';
  return 'unknown';
}

function parseCalendarDateTimeUtcSec(
  rawDate: unknown,
  defaultEtClock: string,
): { readonly dateKey: string; readonly utcSec: number } | null {
  if (typeof rawDate !== 'string') return null;
  const trimmed = rawDate.trim();
  if (trimmed === '') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const utcSec = parseFmpEtDateTimeToUtcSec(`${trimmed} ${defaultEtClock}`);
    return Number.isFinite(utcSec) ? { dateKey: trimmed, utcSec: Math.floor(utcSec) } : null;
  }
  if (/Z$|[+-]\d{2}:?\d{2}$/i.test(trimmed)) {
    const ms = Date.parse(trimmed);
    const utcSec = Math.floor(ms / 1_000);
    if (!Number.isFinite(utcSec) || Math.abs(utcSec) > MAX_TIME_SECONDS) return null;
    const key = fmpEtDateKey(utcSec);
    return key === '' ? null : { dateKey: key, utcSec };
  }
  const etSec = parseFmpEtDateTimeToUtcSec(trimmed);
  if (!Number.isFinite(etSec)) return null;
  const dateMatch = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
  const dateKey = dateMatch?.[1] ?? fmpEtDateKey(etSec);
  return dateKey === '' ? null : { dateKey, utcSec: Math.floor(etSec) };
}

/**
 * Parser puro de payloads `/stable/earnings` o `/stable/earnings-calendar` de FMP.
 */
export function parseFmpEarningsCalendar(
  raw: unknown,
  symbol: string,
  asOfUtcSec: number,
): {
  readonly nextEarnings: EarningsCatalystEvent | null;
  readonly lastEarnings: EarningsCatalystEvent | null;
  readonly events: readonly EarningsCatalystEvent[];
} {
  const rows = Array.isArray(raw) ? raw : [];
  const targetSymbol = cleanSymbol(symbol);
  const dedupedByDate = new Map<string, EarningsCatalystEvent>();

  for (const row of rows) {
    if (!isRecord(row)) continue;
    const rowSymbolRaw = row['symbol'];
    if (typeof rowSymbolRaw === 'string' && rowSymbolRaw.trim() !== '') {
      if (cleanSymbol(rowSymbolRaw) !== targetSymbol) continue;
    }
    const timeOfDay = normalizeEarningsTimeOfDay(row['time'] ?? row['when']);
    const defaultClock = timeOfDay === 'bmo' ? '08:30:00' : timeOfDay === 'amc' ? '16:05:00' : '12:00:00';
    const dt = parseCalendarDateTimeUtcSec(row['date'], defaultClock);
    if (dt === null) continue;
    const epsEstimate = nullable(row['epsEstimated'] ?? row['epsEstimate']);
    const epsActual = nullable(row['epsActual'] ?? row['eps']);
    const candidate: EarningsCatalystEvent = {
      date: dt.dateKey,
      utcSec: dt.utcSec,
      timeOfDay,
      epsEstimate,
      epsActual,
    };
    const prev = dedupedByDate.get(dt.dateKey);
    if (prev === undefined || (prev.epsEstimate === null && candidate.epsEstimate !== null)) {
      dedupedByDate.set(dt.dateKey, candidate);
    }
  }

  const events = [...dedupedByDate.values()].sort((a, b) => a.utcSec - b.utcSec);
  const upcoming = events.filter((e) => e.utcSec >= asOfUtcSec);
  const past = events.filter((e) => e.utcSec < asOfUtcSec);

  return {
    nextEarnings: upcoming[0] ?? null,
    lastEarnings: past.length > 0 ? (past[past.length - 1] ?? null) : null,
    events,
  };
}

function classifyMacroEventKind(name: string): MacroCatalystKind | null {
  const upper = name.toUpperCase();
  if (/\b(FOMC|FED INTEREST RATE|FEDERAL RESERVE.*RATE|FED FUNDS|FEDERAL OPEN MARKET)\b/.test(upper)) {
    return 'FOMC';
  }
  if (/\b(CPI|CONSUMER PRICE INDEX)\b/.test(upper)) {
    return 'CPI';
  }
  return null;
}

function parseMacroImpact(raw: unknown): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (typeof raw !== 'string') return 'HIGH';
  const upper = raw.trim().toUpperCase();
  if (upper === 'LOW') return 'LOW';
  if (upper === 'MEDIUM') return 'MEDIUM';
  return 'HIGH';
}

/**
 * Parser puro de `/stable/economic-calendar` filtrando US + `FOMC` / `CPI`.
 */
export function parseFmpEconomicCalendarMacroEvents(raw: unknown): readonly MacroCatalystEvent[] {
  const rows = Array.isArray(raw) ? raw : [];
  const byKindAndDate = new Map<string, MacroCatalystEvent>();

  for (const row of rows) {
    if (!isRecord(row)) continue;
    const countryRaw = row['country'];
    if (typeof countryRaw === 'string' && countryRaw.trim() !== '') {
      const upperCountry = countryRaw.trim().toUpperCase();
      if (upperCountry !== 'US' && upperCountry !== 'USA' && upperCountry !== 'UNITED STATES') {
        continue;
      }
    }
    const labelRaw = row['event'] ?? row['name'] ?? row['title'];
    if (typeof labelRaw !== 'string' || labelRaw.trim() === '') continue;
    const label = labelRaw.trim();
    const kind = classifyMacroEventKind(label);
    if (kind === null) continue;

    const dt = parseCalendarDateTimeUtcSec(row['date'], kind === 'FOMC' ? '14:00:00' : '08:30:00');
    if (dt === null) continue;

    const impact = parseMacroImpact(row['impact']);
    const event: MacroCatalystEvent = {
      kind,
      label,
      date: dt.dateKey,
      utcSec: dt.utcSec,
      impact,
    };
    const key = `${kind}:${dt.dateKey}`;
    const prev = byKindAndDate.get(key);
    if (prev === undefined) {
      byKindAndDate.set(key, event);
    } else if (prev.impact !== 'HIGH' && event.impact === 'HIGH') {
      byKindAndDate.set(key, event);
    }
  }

  return [...byKindAndDate.values()].sort((a, b) => a.utcSec - b.utcSec);
}

/** Adaptador FetchFn estándar (sin headers) al transporte FMP. */
export function fetchAsFmpHttpFn(fetchFn: FetchFn): FmpHttpFn {
  return async (url) => {
    const response: FetchResponse = await fetchFn(url);
    return { ok: response.ok, status: response.status, text: response.text };
  };
}
