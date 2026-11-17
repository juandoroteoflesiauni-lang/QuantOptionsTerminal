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
import { getMarketParts } from '../core/sessions.js';
import { redactSecrets } from './runtimeCache.js';

export const FMP_API_KEY_ENV_NAME = 'FMP_API_KEY';
/** Pieza 41.1: aliases por rol. `FMP_API_KEY` es el principal. */
export const FMP_KEY_QUOTES_ENV_NAME = 'FMP_KEY_QUOTES';
export const FMP_KEY_MARKET_ENV_NAME = 'FMP_KEY_MARKET';
export const FMP_KEY_ETF_ENV_NAME = 'FMP_KEY_ETF';
export const FMP_KEY_MACRO_ENV_NAME = 'FMP_KEY_MACRO';
export const FMP_KEY_ENV_NAMES = [
  FMP_API_KEY_ENV_NAME,
  FMP_KEY_QUOTES_ENV_NAME,
  FMP_KEY_MARKET_ENV_NAME,
  FMP_KEY_ETF_ENV_NAME,
  FMP_KEY_MACRO_ENV_NAME,
] as const;
export const FMP_STABLE_BASE_URL = 'https://financialmodelingprep.com';
export const FMP_LEGACY_BASE_URL = 'https://financialmodelingprep.com';

export type FmpIntradayTimeframe = Exclude<Timeframe, '1D'>;
export type FmpSource = 'FMP_STABLE' | 'FMP_LEGACY';
export type FmpEndpoint = 'HISTORICAL_CHART' | 'HISTORICAL_PRICE_EOD' | 'BATCH_QUOTE';

export interface FmpConfig {
  readonly apiKey: string | null;
  readonly quotesApiKey: string | null;
  readonly marketApiKey: string | null;
  readonly etfApiKey: string | null;
  readonly macroApiKey: string | null;
  readonly configured: boolean;
  readonly baseUrl: string;
}

export type FmpKeyRole = 'PRIMARY' | 'QUOTES' | 'MARKET' | 'ETF' | 'MACRO';

export interface FmpKeySelection {
  readonly key: string;
  readonly envName: FmpKeyRole;
}

export interface FmpHistoricalRequest {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly fromUtcSec?: number;
  readonly toUtcSec?: number;
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
  /** Telemetría local opcional: status/rows/latencia; nunca URL ni key. */
  readonly onResponse?: (input: {
    readonly httpStatus: number | null;
    readonly rows: number;
    readonly latencyMs: number | null;
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
  return {
    apiKey,
    quotesApiKey,
    marketApiKey,
    etfApiKey,
    macroApiKey,
    configured: apiKey !== null || quotesApiKey !== null || marketApiKey !== null || etfApiKey !== null || macroApiKey !== null,
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
    const bar: Bar = {
      time: Math.floor(time),
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
  // filtrado de sesión/RTH pertenece a la capa de datos.
  return { bars, discarded };
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

function buildLegacyChartUrl(symbol: string, path: string, apiKey: string): string {
  const url = new URL(`${FMP_LEGACY_BASE_URL}/api/v3/historical-chart/${path}/${encodeURIComponent(symbol)}`);
  url.searchParams.set('apikey', apiKey);
  return url.toString();
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
  private requests = 0;
  private readonly onResponse: FmpClientDeps['onResponse'];

  public constructor(deps: FmpClientDeps) {
    this.configOverride = deps.config ?? null;
    this.resolveConfigFn = deps.resolveConfigFn ?? null;
    this.fetchFn = deps.fetchFn ?? createDefaultFmpHttpFn();
    this.nowMsFn = deps.nowMsFn ?? (() => Date.now());
    this.baseSecrets = [...(deps.secrets ?? [])];
    this.onResponse = deps.onResponse;
  }

  private effectiveConfig(): FmpConfig {
    if (this.resolveConfigFn !== null) return this.resolveConfigFn();
    if (this.configOverride !== null) return this.configOverride;
    return resolveFmpConfig();
  }

  private apiKeyFor(endpoint: 'MARKET' | 'QUOTES'): FmpKeySelection | null {
    const config = this.effectiveConfig();
    if (endpoint === 'QUOTES') {
      if (config.quotesApiKey !== null) return { key: config.quotesApiKey, envName: 'QUOTES' };
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
      ...[config.apiKey, config.quotesApiKey, config.marketApiKey, config.etfApiKey, config.macroApiKey].filter(
        (key): key is string => key !== null,
      ),
    ];
  }

  public getDiagnostics(): {
    readonly configured: boolean;
    readonly requests: number;
    readonly lastSuccessAtMs: number | null;
    readonly lastError: string | null;
  } {
    return {
      configured: this.effectiveConfig().configured,
      requests: this.requests,
      lastSuccessAtMs: this.lastSuccessAtMs,
      lastError: this.lastError === null ? null : redactSecrets(this.lastError, this.currentSecrets()),
    };
  }

  private async fetchRedacted(url: string): Promise<FmpHttpResult> {
    this.requests += 1;
    const startedAtMs = this.nowMsFn();
    try {
      const response = await this.fetchFn(url);
      const latencyMs = this.nowMsFn() >= startedAtMs ? this.nowMsFn() - startedAtMs : null;
      this.onResponse?.({ httpStatus: response.status, rows: 0, latencyMs });
      return response;
    } catch (err: unknown) {
      this.onResponse?.({ httpStatus: null, rows: 0, latencyMs: this.nowMsFn() - startedAtMs });
      const raw = err instanceof Error ? err.message : String(err);
      throw new Error(redactSecrets(`FMP request failed: ${raw}`, this.currentSecrets()));
    }
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
    if (!response.ok) {
      if (request.timeframe === '1D') {
        throw new Error(`FMP EOD HTTP ${String(response.status)}`);
      }
      const symbol = cleanSymbol(request.symbol);
      const pathName = fmpIntradayPath(request.timeframe);
      if (pathName === '') throw new Error(`FMP chart HTTP ${String(response.status)}`);
      response = await this.fetchRedacted(buildLegacyChartUrl(symbol, pathName, keySelection.key));
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
    const normalized = parseFmpHistoricalBars(parsed);
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

  public async fetchBatchQuotes(symbols: readonly string[]): Promise<FmpBatchQuotesResult> {
    const config = this.effectiveConfig();
    const keySelection = this.apiKeyFor('QUOTES');
    if (!config.configured || keySelection === null) {
      throw new Error('FMP quotes are not configured: FMP_KEY_QUOTES / FMP_API_KEY missing');
    }
    const clean = [...new Set(symbols.map(cleanSymbol).filter((symbol) => symbol !== ''))];
    if (clean.length === 0) throw new Error('FMP batch quote requires symbols');
    const requestedAtUtcSec = Math.floor(this.nowMsFn() / 1_000);
    const query = new URLSearchParams({ symbols: clean.join(',') });
    const url = buildAuthUrl(`/stable/batch-quote?${query.toString()}`, keySelection.key);
    const response = await this.fetchRedacted(url);
    if (!response.ok) throw new Error(`FMP batch quote HTTP ${String(response.status)}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text) as unknown;
    } catch {
      throw new Error('FMP batch quote returned invalid JSON');
    }
    const normalized = parseFmpBatchQuotes(parsed);
    this.recordResponse(true, normalized.quotes.length);
    return {
      quotes: normalized.quotes,
      source: 'FMP_STABLE',
      endpoint: 'BATCH_QUOTE',
      requestedAtUtcSec,
      httpStatus: response.status,
      rows: normalized.quotes.length,
      discarded: normalized.discarded,
      keyEnvName: keySelection.envName,
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

/** Adaptador FetchFn estándar (sin headers) al transporte FMP. */
export function fetchAsFmpHttpFn(fetchFn: FetchFn): FmpHttpFn {
  return async (url) => {
    const response: FetchResponse = await fetchFn(url);
    return { ok: response.ok, status: response.status, text: response.text };
  };
}
