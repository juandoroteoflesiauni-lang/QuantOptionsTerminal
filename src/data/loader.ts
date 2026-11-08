/**
 * Cargador REST de barras (Paso D).
 *
 * Orquesta las peticiones a Massive (acciones) y BingX spot (cripto), delega
 * la validación en los normalizadores y aplica las reglas del buffer:
 *  - `requestedBars = visibleBars + warmupBars`.
 *  - Se excluye la barra en formación cuando el normalizador puede distinguirla.
 *  - Se conservan las últimas `requestedBars` barras cerradas.
 *  - `visibleStart = max(0, bars.length - visibleBars)`.
 *
 * No se inventan barras ni se rellenan huecos. La clave de Massive solo se
 * añade a la URL de la petición; nunca se incluye en el reporte.
 */

import { URL, URLSearchParams } from 'node:url';
import type { Bar } from '../core/types.js';
import { getMarketParts } from '../core/sessions.js';
import { alignDown } from './alignment.js';
import { normalizeBingxKlines } from './normalizeBingx.js';
import { normalizeMassiveAggs } from './normalizeMassive.js';
import {
  detectGaps,
  isFiniteNumber,
  isRecord,
  toErrorMessage,
} from './normalizeShared.js';
import { isTimeframe, timeframeSeconds } from './timeframes.js';
import type {
  BingxLoadBarsReport,
  BingxNormalizeResult,
  DataProvider,
  FetchResponse,
  FormingBarInfo,
  LoadBarsOptions,
  LoadBarsResult,
  MassiveLoadBarsReport,
  MassiveNormalizeResult,
  ProviderError,
  StopReason,
  Timeframe,
} from './types.js';

const MASSIVE_BASE_URL = 'https://api.polygon.io';
const BINGX_BASE_URL = 'https://open-api.bingx.com';
const MASSIVE_PAGE_LIMIT = 50_000;
const BINGX_PAGE_LIMIT = 1_000;
const DEFAULT_MAX_PAGES = 10;
const SECONDS_PER_DAY = 86_400;

const MASSIVE_TIMEFRAME_PATH: Readonly<
  Record<Timeframe, { readonly multiplier: number; readonly timespan: string }>
> = Object.freeze({
  '1m': { multiplier: 1, timespan: 'minute' },
  '5m': { multiplier: 5, timespan: 'minute' },
  '15m': { multiplier: 15, timespan: 'minute' },
  '1h': { multiplier: 1, timespan: 'hour' },
  '4h': { multiplier: 4, timespan: 'hour' },
  '1D': { multiplier: 1, timespan: 'day' },
});

/** Barras aproximadas por día de sesión extendida (04:00-20:00 ET). */
const MASSIVE_BARS_PER_DAY: Readonly<Record<Timeframe, number>> = Object.freeze({
  '1m': 960,
  '5m': 192,
  '15m': 64,
  '1h': 16,
  '4h': 4,
  '1D': 1,
});

const BINGX_INTERVAL: Readonly<Record<Timeframe, string>> = Object.freeze({
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1D': '1d',
});

/**
 * Rangos máximos conservadores observados en la muestra real. El proveedor
 * devuelve `code 100204` si se pide más historia en una sola consulta.
 */
const BINGX_MAX_RANGE_DAYS: Readonly<Record<Timeframe, number>> = Object.freeze({
  '1m': 2,
  '5m': 8,
  '15m': 22,
  '1h': 90,
  '4h': 350,
  '1D': 380,
});

const AUTH_PARAM_NAMES = new Set(['apikey', 'api_key', 'api-key']);
const AUTH_PARAM_PATTERN = new RegExp(
  `([?&](?:${[...AUTH_PARAM_NAMES].join('|')})=)[^&\\s]+`,
  'gi',
);

interface ResolvedLoadOptions {
  readonly provider: DataProvider;
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly visibleBars: number;
  readonly warmupBars: number;
  readonly requestedBars: number;
  readonly fetchFn: LoadBarsOptions['fetchFn'];
  readonly explicitNow: number | undefined;
  readonly requestNow: number;
  readonly maxPages: number;
  readonly apiKey: string;
  readonly baseUrl: string;
}

interface MassiveRequestWindow {
  readonly from: string | number;
  readonly to: string | number;
}

interface ParsedPage {
  readonly rows: readonly unknown[];
  readonly nextUrl: string | null;
  readonly serverTimestampMs: number | null;
  readonly providerError: ProviderError | null;
  readonly malformed: boolean;
}

/**
 * Carga barras cerradas y devuelve el buffer con su tramo visible.
 *
 * La función es asíncrona porque `fetchFn` puede ser red real; en tests se
 * inyecta una función determinista que devuelve páginas grabadas.
 */
export async function loadBars(
  options: LoadBarsOptions,
): Promise<LoadBarsResult> {
  const resolved = resolveOptions(options);
  if (resolved.provider === 'massive') {
    return loadMassive(resolved);
  }
  return loadBingx(resolved);
}

function resolveOptions(options: LoadBarsOptions): ResolvedLoadOptions {
  const provider = options.provider as string;
  if (provider !== 'massive' && provider !== 'bingx') {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  const timeframe = options.timeframe as string;
  if (!isTimeframe(timeframe)) {
    throw new Error(`Unsupported timeframe: ${timeframe}`);
  }

  if (typeof options.symbol !== 'string' || options.symbol.trim() === '') {
    throw new Error('symbol must be a non-empty string');
  }

  if (!Number.isInteger(options.visibleBars) || options.visibleBars < 0) {
    throw new Error(
      `visibleBars must be a non-negative integer (got ${String(options.visibleBars)})`,
    );
  }

  const warmupBars = options.warmupBars ?? 1_000;
  if (!Number.isInteger(warmupBars) || warmupBars < 0) {
    throw new Error(
      `warmupBars must be a non-negative integer (got ${String(warmupBars)})`,
    );
  }

  const requestedBars = options.visibleBars + warmupBars;
  if (requestedBars <= 0) {
    throw new Error('visibleBars + warmupBars must be greater than 0');
  }

  if (
    options.now !== undefined &&
    (!Number.isFinite(options.now) || !Number.isInteger(options.now))
  ) {
    throw new Error(
      `now must be finite integer seconds (got ${String(options.now)})`,
    );
  }

  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error(
      `maxPages must be a positive integer (got ${String(maxPages)})`,
    );
  }

  if (
    provider === 'massive' &&
    (typeof options.apiKey !== 'string' || options.apiKey === '')
  ) {
    throw new Error('apiKey is required for Massive');
  }

  const defaultBaseUrl =
    provider === 'massive' ? MASSIVE_BASE_URL : BINGX_BASE_URL;
  const baseUrl = (options.baseUrl ?? defaultBaseUrl).replace(/\/+$/, '');
  if (baseUrl === '') {
    throw new Error('baseUrl must be a non-empty URL');
  }

  return {
    provider,
    symbol: options.symbol,
    timeframe,
    visibleBars: options.visibleBars,
    warmupBars,
    requestedBars,
    fetchFn: options.fetchFn,
    explicitNow: options.now,
    requestNow: options.now ?? Math.floor(Date.now() / 1_000),
    maxPages,
    apiKey: options.apiKey ?? '',
    baseUrl,
  };
}

async function loadMassive(
  options: ResolvedLoadOptions,
): Promise<LoadBarsResult> {
  const barSeconds = timeframeSeconds(options.timeframe);
  const now = options.explicitNow ?? options.requestNow;
  const window = massiveWindow(now, options.timeframe, options.requestedBars);
  let url = withApiKey(
    massiveUrl(options.baseUrl, options.symbol, options.timeframe, window),
    options.apiKey,
    options.baseUrl,
  );

  const rows: unknown[] = [];
  const secrets = [options.apiKey, encodeURIComponent(options.apiKey)];
  let pages = 0;
  let stoppedReason: StopReason = 'noMorePages';
  let pageError: ProviderError | null = null;
  let malformed = false;
  let probe: MassiveNormalizeResult | null = null;

  while (pages < options.maxPages) {
    pages += 1;

    let response: FetchResponse;
    try {
      response = await options.fetchFn(url);
    } catch (error) {
      pageError = {
        code: 0,
        message: redact(errorMessage(error), secrets),
      };
      stoppedReason = 'providerError';
      break;
    }

    const page = parseMassivePage(response, secrets);
    if (page.providerError !== null) {
      pageError = page.providerError;
      stoppedReason = 'providerError';
      break;
    }
    if (page.malformed) {
      malformed = true;
      stoppedReason = 'malformedResponse';
      break;
    }

    rows.push(...page.rows);
    const result = normalizeMassiveAggs(
      { status: 'OK', results: rows },
      { barSeconds, now },
    );
    probe = result;

    if (
      countClosedBars(result.bars, result.report.formingBar) >=
      options.requestedBars
    ) {
      stoppedReason = 'targetReached';
      break;
    }

    if (page.rows.length === 0 || page.nextUrl === null) {
      stoppedReason = 'noMorePages';
      break;
    }

    if (pages >= options.maxPages) {
      stoppedReason = 'maxPages';
      break;
    }

    try {
      url = withApiKey(page.nextUrl, options.apiKey, options.baseUrl);
    } catch {
      malformed = true;
      stoppedReason = 'malformedResponse';
      break;
    }
  }

  const result =
    probe ??
    normalizeMassiveAggs(
      { status: 'OK', results: rows },
      { barSeconds, now },
    );

  return finalizeMassive(
    result,
    options,
    barSeconds,
    pages,
    stoppedReason,
    pageError,
    malformed,
  );
}

async function loadBingx(
  options: ResolvedLoadOptions,
): Promise<LoadBarsResult> {
  const barSeconds = timeframeSeconds(options.timeframe);
  const { startTime, endTime: initialEndTime } = bingxWindow(
    options.requestNow,
    options.timeframe,
  );
  let endTime = initialEndTime;
  let url = bingxUrl(
    options.baseUrl,
    options.symbol,
    options.timeframe,
    startTime,
    endTime,
  );

  const rows: unknown[] = [];
  const secrets =
    options.apiKey === ''
      ? []
      : [options.apiKey, encodeURIComponent(options.apiKey)];
  let pages = 0;
  let stoppedReason: StopReason = 'noMorePages';
  let pageError: ProviderError | null = null;
  let malformed = false;
  let probe: BingxNormalizeResult | null = null;
  let serverTimestampMs: number | null = null;

  while (pages < options.maxPages) {
    pages += 1;

    let response: FetchResponse;
    try {
      response = await options.fetchFn(url);
    } catch (error) {
      pageError = {
        code: 0,
        message: redact(errorMessage(error), secrets),
      };
      stoppedReason = 'providerError';
      break;
    }

    const page = parseBingxPage(response, secrets);
    if (page.providerError !== null) {
      pageError = page.providerError;
      stoppedReason = 'providerError';
      break;
    }
    if (page.malformed) {
      malformed = true;
      stoppedReason = 'malformedResponse';
      break;
    }

    rows.push(...page.rows);
    if (page.serverTimestampMs !== null) {
      serverTimestampMs =
        serverTimestampMs === null
          ? page.serverTimestampMs
          : Math.max(serverTimestampMs, page.serverTimestampMs);
    }

    const now = resolveBingxNow(options, serverTimestampMs);
    const result = normalizeBingxKlines(
      { code: 0, data: rows },
      { barSeconds, now },
    );
    probe = result;

    if (
      countClosedBars(result.bars, result.report.formingBar) >=
      options.requestedBars
    ) {
      stoppedReason = 'targetReached';
      break;
    }

    if (page.rows.length === 0) {
      stoppedReason = 'noMorePages';
      break;
    }

    const oldest = oldestOpenTime(page.rows);
    if (oldest === null || oldest <= startTime) {
      stoppedReason = 'noMorePages';
      break;
    }

    if (pages >= options.maxPages) {
      stoppedReason = 'maxPages';
      break;
    }

    endTime = oldest - 1;
    url = bingxUrl(
      options.baseUrl,
      options.symbol,
      options.timeframe,
      startTime,
      endTime,
    );
  }

  const now = resolveBingxNow(options, serverTimestampMs);
  const result =
    probe ??
    normalizeBingxKlines({ code: 0, data: rows }, { barSeconds, now });

  return finalizeBingx(
    result,
    options,
    barSeconds,
    pages,
    stoppedReason,
    pageError,
    malformed,
  );
}

function resolveBingxNow(
  options: ResolvedLoadOptions,
  serverTimestampMs: number | null,
): number {
  if (options.explicitNow !== undefined) {
    return options.explicitNow;
  }
  if (serverTimestampMs !== null) {
    return Math.floor(serverTimestampMs / 1_000);
  }
  return options.requestNow;
}

function finalizeMassive(
  result: MassiveNormalizeResult,
  options: ResolvedLoadOptions,
  barSeconds: number,
  pages: number,
  stoppedReason: StopReason,
  pageError: ProviderError | null,
  malformed: boolean,
): LoadBarsResult {
  const closedBars = excludeFormingBar(result.bars, result.report.formingBar);
  const normalizedBars = closedBars.length;
  const bars = trimToBuffer(closedBars, options.requestedBars);
  const trimmedBars = normalizedBars - bars.length;
  const visibleStart = Math.max(0, bars.length - options.visibleBars);
  const { gaps, gapDetection } = detectGaps(closedBars, barSeconds, 'massive');

  const report: MassiveLoadBarsReport = {
    ...result.report,
    gaps,
    gapDetection,
    malformedResponse: malformed || result.report.malformedResponse,
    providerError: pageError ?? result.report.providerError,
    requestedBars: options.requestedBars,
    visibleBars: options.visibleBars,
    warmupBars: options.warmupBars,
    normalizedBars,
    trimmedBars,
    formingExcluded:
      result.report.formingBar !== null &&
      closedBars.length < result.bars.length,
    pages,
    firstTime: bars[0]?.time ?? null,
    lastTime: bars[bars.length - 1]?.time ?? null,
    stoppedReason,
  };

  return { bars, visibleStart, report };
}

function finalizeBingx(
  result: BingxNormalizeResult,
  options: ResolvedLoadOptions,
  barSeconds: number,
  pages: number,
  stoppedReason: StopReason,
  pageError: ProviderError | null,
  malformed: boolean,
): LoadBarsResult {
  const closedBars = excludeFormingBar(result.bars, result.report.formingBar);
  const normalizedBars = closedBars.length;
  const bars = trimToBuffer(closedBars, options.requestedBars);
  const trimmedBars = normalizedBars - bars.length;
  const visibleStart = Math.max(0, bars.length - options.visibleBars);
  const { gaps, gapDetection } = detectGaps(closedBars, barSeconds, 'bingx');

  const report: BingxLoadBarsReport = {
    ...result.report,
    gaps,
    gapDetection,
    malformedResponse: malformed || result.report.malformedResponse,
    providerError: pageError ?? result.report.providerError,
    requestedBars: options.requestedBars,
    visibleBars: options.visibleBars,
    warmupBars: options.warmupBars,
    normalizedBars,
    trimmedBars,
    formingExcluded:
      result.report.formingBar !== null &&
      closedBars.length < result.bars.length,
    pages,
    firstTime: bars[0]?.time ?? null,
    lastTime: bars[bars.length - 1]?.time ?? null,
    stoppedReason,
  };

  return { bars, visibleStart, report };
}

function excludeFormingBar(
  bars: readonly Bar[],
  formingBar: FormingBarInfo | null,
): readonly Bar[] {
  if (formingBar === null) {
    return bars;
  }
  return bars.filter((bar) => bar.time !== formingBar.time);
}

function trimToBuffer(
  bars: readonly Bar[],
  requestedBars: number,
): readonly Bar[] {
  if (bars.length <= requestedBars) {
    return bars;
  }
  return bars.slice(bars.length - requestedBars);
}

function countClosedBars(
  bars: readonly Bar[],
  formingBar: FormingBarInfo | null,
): number {
  if (formingBar === null) {
    return bars.length;
  }
  return bars.some((bar) => bar.time === formingBar.time)
    ? bars.length - 1
    : bars.length;
}

function parseMassivePage(
  response: FetchResponse,
  secrets: readonly string[],
): ParsedPage {
  if (!response.ok || response.status < 200 || response.status >= 300) {
    return providerErrorPage(
      response.status,
      extractHttpMessage(
        response.text,
        `HTTP ${String(response.status)}`,
      ),
      secrets,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(response.text) as unknown;
  } catch {
    return malformedPage();
  }

  if (!isRecord(body)) {
    return malformedPage();
  }

  const status = body['status'];
  if (typeof status === 'string' && status.toUpperCase() !== 'OK') {
    const message = body['error'] ?? body['message'] ?? status;
    return providerErrorPage(0, toErrorMessage(message, status), secrets);
  }

  const results = body['results'];
  if (results === undefined || results === null) {
    return emptyPage();
  }
  if (!Array.isArray(results)) {
    return malformedPage();
  }

  const next = body['next_url'];
  const nextUrl = typeof next === 'string' && next !== '' ? next : null;

  return {
    rows: results,
    nextUrl,
    serverTimestampMs: null,
    providerError: null,
    malformed: false,
  };
}

function parseBingxPage(
  response: FetchResponse,
  secrets: readonly string[],
): ParsedPage {
  if (!response.ok || response.status < 200 || response.status >= 300) {
    return providerErrorPage(
      response.status,
      extractHttpMessage(
        response.text,
        `HTTP ${String(response.status)}`,
      ),
      secrets,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(response.text) as unknown;
  } catch {
    return malformedPage();
  }

  if (!isRecord(body)) {
    return malformedPage();
  }

  const code = body['code'];
  if (isFiniteNumber(code) && code !== 0) {
    const message = body['msg'] ?? body['message'];
    return providerErrorPage(code, toErrorMessage(message, ''), secrets);
  }

  const data = body['data'];
  let rows: readonly unknown[];
  if (data === undefined || data === null) {
    rows = [];
  } else if (Array.isArray(data)) {
    rows = data;
  } else {
    return malformedPage();
  }

  const timestamp = body['timestamp'];
  const serverTimestampMs = isFiniteNumber(timestamp) ? timestamp : null;

  return {
    rows,
    nextUrl: null,
    serverTimestampMs,
    providerError: null,
    malformed: false,
  };
}

function emptyPage(): ParsedPage {
  return {
    rows: [],
    nextUrl: null,
    serverTimestampMs: null,
    providerError: null,
    malformed: false,
  };
}

function malformedPage(): ParsedPage {
  return {
    rows: [],
    nextUrl: null,
    serverTimestampMs: null,
    providerError: null,
    malformed: true,
  };
}

function providerErrorPage(
  code: number,
  message: string,
  secrets: readonly string[],
): ParsedPage {
  return {
    rows: [],
    nextUrl: null,
    serverTimestampMs: null,
    providerError: { code, message: redact(message, secrets) },
    malformed: false,
  };
}

function extractHttpMessage(text: string, fallback: string): string {
  try {
    const body: unknown = JSON.parse(text) as unknown;
    if (isRecord(body)) {
      const message = body['error'] ?? body['message'] ?? body['msg'];
      if (typeof message === 'string' && message !== '') {
        return message;
      }
    }
  } catch {
    return fallback;
  }
  return fallback;
}

function oldestOpenTime(rows: readonly unknown[]): number | null {
  let oldest: number | null = null;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length === 0) {
      continue;
    }
    const value: unknown = row[0];
    if (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      Number.isInteger(value) &&
      value > 0 &&
      (oldest === null || value < oldest)
    ) {
      oldest = value;
    }
  }
  return oldest;
}

function massiveWindow(
  now: number,
  timeframe: Timeframe,
  requestedBars: number,
): MassiveRequestWindow {
  const lookbackDays = massiveLookbackDays(requestedBars, timeframe);

  if (timeframe === '1D') {
    const to = getMarketParts(now, 'EQUITY').dateKey;
    return { from: shiftDateKey(to, -lookbackDays), to };
  }

  const from = alignDown(
    now - lookbackDays * SECONDS_PER_DAY,
    timeframe,
    'massive',
  );
  return { from: from * 1_000, to: now * 1_000 };
}

function massiveLookbackDays(
  requestedBars: number,
  timeframe: Timeframe,
): number {
  return (
    Math.ceil(
      (requestedBars / MASSIVE_BARS_PER_DAY[timeframe]) * (7 / 5),
    ) + 10
  );
}

function shiftDateKey(dateKey: string, deltaDays: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (match === null) {
    throw new Error(`Invalid date key: ${dateKey}`);
  }
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}

function massiveUrl(
  baseUrl: string,
  symbol: string,
  timeframe: Timeframe,
  window: MassiveRequestWindow,
): string {
  const path = MASSIVE_TIMEFRAME_PATH[timeframe];
  const urlPath =
    `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/` +
    `${String(path.multiplier)}/${path.timespan}/` +
    `${String(window.from)}/${String(window.to)}`;
  const params = new URLSearchParams({
    adjusted: 'true',
    sort: 'desc',
    limit: String(MASSIVE_PAGE_LIMIT),
  });
  return `${baseUrl}${urlPath}?${params.toString()}`;
}

function bingxWindow(
  now: number,
  timeframe: Timeframe,
): { readonly startTime: number; readonly endTime: number } {
  const endTime = now * 1_000;
  return {
    startTime:
      endTime - BINGX_MAX_RANGE_DAYS[timeframe] * SECONDS_PER_DAY * 1_000,
    endTime,
  };
}

function bingxUrl(
  baseUrl: string,
  symbol: string,
  timeframe: Timeframe,
  startTime: number,
  endTime: number,
): string {
  const params = new URLSearchParams({
    symbol,
    interval: BINGX_INTERVAL[timeframe],
    limit: String(BINGX_PAGE_LIMIT),
    startTime: String(startTime),
    endTime: String(endTime),
  });
  return `${baseUrl}/openApi/spot/v2/market/kline?${params.toString()}`;
}

function authParamForUrl(url: string): 'apiKey' | 'apikey' {
  try {
    return new URL(url).hostname.toLowerCase() === 'api.massive.com'
      ? 'apikey'
      : 'apiKey';
  } catch {
    return 'apiKey';
  }
}

function withApiKey(url: string, apiKey: string, baseUrl: string): string {
  const parsed = new URL(url, baseUrl);
  for (const key of [...parsed.searchParams.keys()]) {
    if (AUTH_PARAM_NAMES.has(key.toLowerCase())) {
      parsed.searchParams.delete(key);
    }
  }
  parsed.searchParams.set(authParamForUrl(parsed.toString()), apiKey);
  return parsed.toString();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'fetch failed';
}

function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret !== '') {
      out = out.split(secret).join('<redacted>');
    }
  }
  return out.replace(AUTH_PARAM_PATTERN, '$1<redacted>');
}
