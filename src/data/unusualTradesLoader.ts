/**
 * Cargador REST paginado e inyectable (`FetchFn`) para `GET /options/v1/unusual-trades`
 * de Massive (Pieza 8).
 *
 * Seguridad y resiliencia:
 *  - Lista espejo estricta para `next_url` (`api.polygon.io` / `api.massive.com` + `baseUrl`).
 *  - Cero secretos en errores ni reportes: toda salida pasa por `redact(..., secrets)`.
 *  - Convierte filtros temporales de entrada en segundos UTC a nanosegundos de API
 *    de manera exacta (vía `BigInt`) y normaliza todo resultado a segundos UTC +
 *    subestructura de nanosegundos.
 *  - Reintento HTTP 429 opt-in (`retry429MaxAttempts = 0` por defecto).
 */

import { MAX_TIME_SECONDS } from '../core/sessions.js';
import { AUTH_PARAM_NAMES, isRecord, redact, toErrorMessage } from './normalizeShared.js';
import {
  normalizeUnusualTrades,
  UNUSUAL_TRADE_FLAGS,
  type NormalizeUnusualTradesOptions,
  type UnusualTradeFlag,
  type UnusualTradeRecord,
  type UnusualTradesNormalizeReport,
} from './normalizeUnusualTrades.js';
import { parseRetryAfterSeconds, retryDelayMs } from './retry.js';
import type { FetchFn, ProviderError, SleepFn } from './types.js';

export type {
  NormalizeUnusualTradesOptions,
  UnusualTradeDiscardCause,
  UnusualTradeDiscardCounts,
  UnusualTradeDiscardRecord,
  UnusualTradeFlag,
  UnusualTradeFlagMatchMode,
  UnusualTradeFlagsSummary,
  UnusualTradeRecord,
  UnusualTradeRootKind,
  UnusualTradesFlagCounts,
  UnusualTradesNormalizeReport,
  UnusualTradesNormalizeResult,
  UnusualTradeSubsecondTimestamp,
} from './normalizeUnusualTrades.js';
export {
  normalizeUnusualTrades,
  parseSipNanosecondTimestamp,
  UNUSUAL_TRADE_FLAGS,
} from './normalizeUnusualTrades.js';

const DEFAULT_MASSIVE_BASE_URL = 'https://api.massive.com';
const DEFAULT_MAX_PAGES = 50;
const DEFAULT_LIMIT_UNUSUAL_TRADES = 1_000;
const MAX_LIMIT_UNUSUAL_TRADES = 50_000;
const DEFAULT_RETRY_429_MAX_ATTEMPTS = 0;
const DEFAULT_RETRY_429_BASE_DELAY_MS = 1_000;
const DEFAULT_RETRY_429_MAX_DELAY_MS = 30_000;

const MASSIVE_NEXT_URL_ORIGINS = new Set<string>([
  'https://api.polygon.io',
  'https://api.massive.com',
]);

const AUTH_PARAM_LOWER = new Set([...AUTH_PARAM_NAMES].map((name) => name.toLowerCase()));
const ALLOWED_FLAGS_SET = new Set<string>(UNUSUAL_TRADE_FLAGS);
const ALLOWED_ORDERS = new Set<string>(['asc', 'desc']);

export type UnusualTradesStopReason =
  | 'noMorePages'
  | 'maxPagesReached'
  | 'providerError'
  | 'malformedResponse';

export interface LoadUnusualTradesOptions extends NormalizeUnusualTradesOptions {
  readonly apiKey: string;
  readonly fetchFn: FetchFn;
  readonly baseUrl?: string;
  readonly maxPages?: number;
  readonly minRequestIntervalMs?: number;
  readonly retry429MaxAttempts?: number;
  readonly retry429BaseDelayMs?: number;
  readonly retry429MaxDelayMs?: number;
  readonly sleepFn?: SleepFn;
  /** Contrato OPRA específico (`O:...`). */
  readonly ticker?: string;
  /** Raíz específica para filtro en servidor (`SPXW` vs `SPX`, `GME1` vs `GME`). */
  readonly root?: string;
  /** Flag o lista de flags enviados como query `flags` al servidor. */
  readonly flags?: UnusualTradeFlag | readonly UnusualTradeFlag[];
  /** Prima nocional mínima (`min_premium`) en el servidor (`> 0`). */
  readonly minPremium?: number;
  /** Marca temporal SIP exacta en **segundos UTC enteros** (convertida a ns para Massive). */
  readonly sipTimestampSec?: number;
  /** Límite inferior exclusivo `sip_timestamp.gt` en segundos UTC enteros. */
  readonly sipTimestampGtSec?: number;
  /** Límite inferior inclusivo `sip_timestamp.gte` en segundos UTC enteros. */
  readonly sipTimestampGteSec?: number;
  /** Límite superior exclusivo `sip_timestamp.lt` en segundos UTC enteros. */
  readonly sipTimestampLtSec?: number;
  /** Límite superior inclusivo `sip_timestamp.lte` en segundos UTC enteros. */
  readonly sipTimestampLteSec?: number;
  readonly sort?: string;
  readonly order?: 'asc' | 'desc';
  /** Máximo por página (por defecto `1000`, máximo de Massive `50_000`). */
  readonly limit?: number;
}

export interface UnusualTradesLoadReport extends UnusualTradesNormalizeReport {
  readonly pages: number;
  readonly stoppedReason: UnusualTradesStopReason;
}

export interface LoadUnusualTradesResult {
  readonly trades: readonly UnusualTradeRecord[];
  readonly report: UnusualTradesLoadReport;
}

interface ValidatedTransport {
  readonly baseUrl: string;
  readonly baseUrlObj: URL;
  readonly baseOrigin: string;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly apiKey: string;
  readonly secrets: readonly string[];
  readonly fetchFn: FetchFn;
  readonly maxPages: number;
  readonly minRequestIntervalMs: number;
  readonly retry429MaxAttempts: number;
  readonly retry429BaseDelayMs: number;
  readonly retry429MaxDelayMs: number;
  readonly sleepFn: SleepFn;
}

interface PaginatedFetchResult {
  readonly rows: readonly unknown[];
  readonly pages: number;
  readonly stoppedReason: UnusualTradesStopReason;
  readonly malformedResponse: boolean;
  readonly providerError: ProviderError | null;
}

function defaultSleepFn(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildSecretList(apiKey: string): readonly string[] {
  const unique = new Set<string>();
  const trimmed = apiKey.trim();
  for (const candidate of [
    apiKey,
    trimmed,
    encodeURIComponent(apiKey),
    encodeURIComponent(trimmed),
  ]) {
    if (candidate.length > 0) {
      unique.add(candidate);
    }
  }
  return [...unique];
}

function validateTransport(options: LoadUnusualTradesOptions): ValidatedTransport {
  const apiKey = options.apiKey;
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error('apiKey must be a non-empty string');
  }
  if (typeof options.fetchFn !== 'function') {
    throw new Error('fetchFn must be a function');
  }

  const rawBaseUrl = options.baseUrl ?? DEFAULT_MASSIVE_BASE_URL;
  let baseUrlObj: URL;
  try {
    baseUrlObj = new URL(rawBaseUrl);
  } catch {
    throw new Error(`Invalid baseUrl: ${rawBaseUrl}`);
  }
  if (baseUrlObj.protocol !== 'https:') {
    throw new Error('baseUrl must use https:');
  }
  if (baseUrlObj.username !== '' || baseUrlObj.password !== '') {
    throw new Error('baseUrl must not embed credentials');
  }

  const normalizedPath = baseUrlObj.pathname.replace(/\/+$/, '');
  const baseUrl = `${baseUrlObj.origin}${normalizedPath}`;

  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error(`maxPages must be a positive integer, received ${String(maxPages)}`);
  }

  const minRequestIntervalMs = options.minRequestIntervalMs ?? 0;
  if (!Number.isFinite(minRequestIntervalMs) || minRequestIntervalMs < 0) {
    throw new Error(
      `minRequestIntervalMs must be >= 0, received ${String(minRequestIntervalMs)}`,
    );
  }

  const retry429MaxAttempts = options.retry429MaxAttempts ?? DEFAULT_RETRY_429_MAX_ATTEMPTS;
  if (!Number.isInteger(retry429MaxAttempts) || retry429MaxAttempts < 0) {
    throw new Error(
      `retry429MaxAttempts must be a non-negative integer, received ${String(retry429MaxAttempts)}`,
    );
  }

  const retry429BaseDelayMs = options.retry429BaseDelayMs ?? DEFAULT_RETRY_429_BASE_DELAY_MS;
  if (!Number.isFinite(retry429BaseDelayMs) || retry429BaseDelayMs <= 0) {
    throw new Error(
      `retry429BaseDelayMs must be > 0, received ${String(retry429BaseDelayMs)}`,
    );
  }

  const retry429MaxDelayMs = options.retry429MaxDelayMs ?? DEFAULT_RETRY_429_MAX_DELAY_MS;
  if (!Number.isFinite(retry429MaxDelayMs) || retry429MaxDelayMs < retry429BaseDelayMs) {
    throw new Error(
      `retry429MaxDelayMs (${String(retry429MaxDelayMs)}) must be >= retry429BaseDelayMs (${String(retry429BaseDelayMs)})`,
    );
  }

  return {
    baseUrl,
    baseUrlObj,
    baseOrigin: baseUrlObj.origin,
    allowedOrigins: new Set<string>([baseUrlObj.origin, ...MASSIVE_NEXT_URL_ORIGINS]),
    apiKey,
    secrets: buildSecretList(apiKey),
    fetchFn: options.fetchFn,
    maxPages,
    minRequestIntervalMs,
    retry429MaxAttempts,
    retry429BaseDelayMs,
    retry429MaxDelayMs,
    sleepFn: options.sleepFn ?? defaultSleepFn,
  };
}

function apiKeyParamName(urlObj: URL): 'apikey' | 'apiKey' {
  const host = urlObj.hostname.toLowerCase();
  return host === 'api.massive.com' || host.endsWith('.massive.com') ? 'apikey' : 'apiKey';
}

function withApiKey(urlString: string, apiKey: string): string {
  const parsed = new URL(urlString);
  for (const key of [...parsed.searchParams.keys()]) {
    if (AUTH_PARAM_LOWER.has(key.toLowerCase())) {
      parsed.searchParams.delete(key);
    }
  }
  parsed.searchParams.set(apiKeyParamName(parsed), apiKey);
  return parsed.toString();
}

function allowedNextUrl(nextUrlRaw: string, transport: ValidatedTransport): string | null {
  const trimmed = nextUrlRaw.trim();
  if (trimmed === '') {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed, `${transport.baseUrl}/`);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:') {
    return null;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return null;
  }
  if (!transport.allowedOrigins.has(parsed.origin)) {
    return null;
  }

  if (parsed.origin !== transport.baseOrigin && MASSIVE_NEXT_URL_ORIGINS.has(parsed.origin)) {
    parsed.protocol = transport.baseUrlObj.protocol;
    parsed.hostname = transport.baseUrlObj.hostname;
    parsed.port = transport.baseUrlObj.port;
  }

  return parsed.toString();
}

function readHeaderIgnoreCase(
  headers: Readonly<Record<string, string>> | undefined,
  headerName: string,
): string | null {
  if (headers === undefined) {
    return null;
  }
  const target = headerName.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) {
      return v;
    }
  }
  return null;
}

function extractHttpErrorMessage(
  status: number,
  bodyText: string,
  secrets: readonly string[],
): string {
  const trimmed = bodyText.trim();
  if (trimmed === '') {
    return `HTTP ${String(status)}`;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      const candidate = parsed['error'] ?? parsed['message'] ?? parsed['status'];
      if (typeof candidate === 'string' && candidate.trim() !== '') {
        return redact(candidate, secrets);
      }
    }
  } catch {
    // Cuerpo no JSON; se redacta completo abajo.
  }

  return redact(trimmed, secrets);
}

async function fetchPageWithRetry(
  urlWithKey: string,
  transport: ValidatedTransport,
): Promise<
  | { readonly status: number; readonly ok: boolean; readonly bodyText: string }
  | { readonly error: ProviderError }
> {
  for (let attempt = 0; attempt <= transport.retry429MaxAttempts; attempt += 1) {
    let response: Awaited<ReturnType<FetchFn>>;
    try {
      response = await transport.fetchFn(urlWithKey);
    } catch (err) {
      return {
        error: {
          code: 0,
          message: redact(toErrorMessage(err, 'Fetch failed'), transport.secrets),
        },
      };
    }

    if (response.status === 429 && attempt < transport.retry429MaxAttempts) {
      const retryAfterSeconds =
        response.retryAfterSeconds !== undefined
          ? response.retryAfterSeconds
          : parseRetryAfterSeconds(
              readHeaderIgnoreCase(response.headers, 'Retry-After'),
              Date.now(),
            );
      const delayMs = retryDelayMs({
        attempt,
        retryAfterSeconds,
        baseDelayMs: transport.retry429BaseDelayMs,
        maxDelayMs: transport.retry429MaxDelayMs,
      });
      await transport.sleepFn(delayMs);
      continue;
    }

    return {
      status: response.status,
      ok: response.ok,
      bodyText: response.text,
    };
  }

  return {
    error: {
      code: 429,
      message: 'HTTP 429 rate limit exceeded',
    },
  };
}

async function fetchPaginatedUnusualTrades(
  transport: ValidatedTransport,
  initialUrl: string,
): Promise<PaginatedFetchResult> {
  const accumulatedRows: unknown[] = [];
  let pages = 0;
  let currentUrl = initialUrl;

  for (;;) {
    if (pages > 0 && transport.minRequestIntervalMs > 0) {
      await transport.sleepFn(transport.minRequestIntervalMs);
    }

    pages += 1;
    const authedUrl = withApiKey(currentUrl, transport.apiKey);
    const fetched = await fetchPageWithRetry(authedUrl, transport);

    if ('error' in fetched) {
      return {
        rows: accumulatedRows,
        pages,
        stoppedReason: 'providerError',
        malformedResponse: false,
        providerError: fetched.error,
      };
    }

    if (!fetched.ok) {
      return {
        rows: accumulatedRows,
        pages,
        stoppedReason: 'providerError',
        malformedResponse: false,
        providerError: {
          code: fetched.status,
          message: extractHttpErrorMessage(fetched.status, fetched.bodyText, transport.secrets),
        },
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(fetched.bodyText);
    } catch {
      return {
        rows: accumulatedRows,
        pages,
        stoppedReason: 'malformedResponse',
        malformedResponse: true,
        providerError: null,
      };
    }

    if (!isRecord(parsed)) {
      return {
        rows: accumulatedRows,
        pages,
        stoppedReason: 'malformedResponse',
        malformedResponse: true,
        providerError: null,
      };
    }

    const statusField = parsed['status'];
    if (typeof statusField === 'string' && statusField.toUpperCase() !== 'OK') {
      const rawMsg = parsed['error'] ?? parsed['message'] ?? statusField;
      return {
        rows: accumulatedRows,
        pages,
        stoppedReason: 'providerError',
        malformedResponse: false,
        providerError: {
          code: 0,
          message: redact(toErrorMessage(rawMsg, statusField), transport.secrets),
        },
      };
    }

    const results = parsed['results'];
    if (results !== undefined && results !== null) {
      if (!Array.isArray(results)) {
        return {
          rows: accumulatedRows,
          pages,
          stoppedReason: 'malformedResponse',
          malformedResponse: true,
          providerError: null,
        };
      }
      for (const row of results) {
        accumulatedRows.push(row);
      }
    }

    const rawNextUrl = parsed['next_url'];
    if (rawNextUrl === undefined || rawNextUrl === null) {
      return {
        rows: accumulatedRows,
        pages,
        stoppedReason: 'noMorePages',
        malformedResponse: false,
        providerError: null,
      };
    }

    if (typeof rawNextUrl !== 'string') {
      return {
        rows: accumulatedRows,
        pages,
        stoppedReason: 'malformedResponse',
        malformedResponse: true,
        providerError: null,
      };
    }

    if (rawNextUrl.trim() === '') {
      return {
        rows: accumulatedRows,
        pages,
        stoppedReason: 'noMorePages',
        malformedResponse: false,
        providerError: null,
      };
    }

    const nextSafeUrl = allowedNextUrl(rawNextUrl, transport);
    if (nextSafeUrl === null) {
      return {
        rows: accumulatedRows,
        pages,
        stoppedReason: 'malformedResponse',
        malformedResponse: true,
        providerError: null,
      };
    }

    if (pages >= transport.maxPages) {
      return {
        rows: accumulatedRows,
        pages,
        stoppedReason: 'maxPagesReached',
        malformedResponse: false,
        providerError: null,
      };
    }

    currentUrl = nextSafeUrl;
  }
}

function validateNonEmptyParam(value: string | undefined, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new Error(`${name} must not be empty when specified`);
  }
  return trimmed;
}

function secondsToNanosecondsQuery(seconds: number | undefined, name: string): string | undefined {
  if (seconds === undefined) {
    return undefined;
  }
  if (!Number.isFinite(seconds) || !Number.isInteger(seconds) || seconds <= 0 || seconds > MAX_TIME_SECONDS) {
    throw new Error(
      `${name} must be integer UTC seconds in (0, ${String(MAX_TIME_SECONDS)}] (got ${String(seconds)})`,
    );
  }
  return `${String(seconds)}000000000`;
}

function validateQueryFlags(
  flags: UnusualTradeFlag | readonly UnusualTradeFlag[] | undefined,
): string | undefined {
  if (flags === undefined) {
    return undefined;
  }
  const arr: readonly UnusualTradeFlag[] =
    typeof flags === 'string' ? [flags] : flags;
  if (arr.length === 0) {
    return undefined;
  }
  const unique: UnusualTradeFlag[] = [];
  const seen = new Set<UnusualTradeFlag>();
  for (const flag of arr) {
    if (!ALLOWED_FLAGS_SET.has(flag)) {
      throw new Error(`Unsupported unusual-trades query flag: ${flag}`);
    }
    if (!seen.has(flag)) {
      seen.add(flag);
      unique.push(flag);
    }
  }
  return unique.join(',');
}

function buildQueryParams(options: LoadUnusualTradesOptions): URLSearchParams {
  const limit = options.limit ?? DEFAULT_LIMIT_UNUSUAL_TRADES;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT_UNUSUAL_TRADES) {
    throw new Error(
      `limit must be an integer between 1 and ${String(MAX_LIMIT_UNUSUAL_TRADES)}, received ${String(limit)}`,
    );
  }

  const params = new URLSearchParams();
  const ticker = validateNonEmptyParam(options.ticker, 'ticker');
  const underlyingTicker = validateNonEmptyParam(options.underlyingTicker, 'underlyingTicker');
  const root = validateNonEmptyParam(options.root, 'root');
  const sort = validateNonEmptyParam(options.sort, 'sort');

  if (ticker !== undefined) {
    params.set('ticker', ticker);
  }
  if (underlyingTicker !== undefined) {
    params.set('underlying_ticker', underlyingTicker);
  }
  if (root !== undefined) {
    params.set('root', root);
  }

  const queryFlags = validateQueryFlags(options.flags);
  if (queryFlags !== undefined) {
    params.set('flags', queryFlags);
  }

  if (options.minPremium !== undefined) {
    if (!Number.isFinite(options.minPremium) || options.minPremium <= 0) {
      throw new Error(`minPremium must be finite > 0 (got ${String(options.minPremium)})`);
    }
    params.set('min_premium', String(options.minPremium));
  }

  const tsExact = secondsToNanosecondsQuery(options.sipTimestampSec, 'sipTimestampSec');
  const tsGt = secondsToNanosecondsQuery(options.sipTimestampGtSec, 'sipTimestampGtSec');
  const tsGte = secondsToNanosecondsQuery(options.sipTimestampGteSec, 'sipTimestampGteSec');
  const tsLt = secondsToNanosecondsQuery(options.sipTimestampLtSec, 'sipTimestampLtSec');
  const tsLte = secondsToNanosecondsQuery(options.sipTimestampLteSec, 'sipTimestampLteSec');

  if (tsExact !== undefined) {
    params.set('sip_timestamp', tsExact);
  }
  if (tsGt !== undefined) {
    params.set('sip_timestamp.gt', tsGt);
  }
  if (tsGte !== undefined) {
    params.set('sip_timestamp.gte', tsGte);
  }
  if (tsLt !== undefined) {
    params.set('sip_timestamp.lt', tsLt);
  }
  if (tsLte !== undefined) {
    params.set('sip_timestamp.lte', tsLte);
  }

  if (sort !== undefined) {
    params.set('sort', sort);
  }
  if (options.order !== undefined) {
    if (!ALLOWED_ORDERS.has(options.order)) {
      throw new Error(`order must be 'asc' or 'desc'`);
    }
    params.set('order', options.order);
  }

  params.set('limit', String(limit));
  return params;
}

function finalizeProviderError(
  fetchedError: ProviderError | null,
  normalizedError: ProviderError | null,
  secrets: readonly string[],
): ProviderError | null {
  const err = fetchedError ?? normalizedError;
  if (err === null) {
    return null;
  }
  return {
    code: err.code,
    message: redact(err.message, secrets),
  };
}

/**
 * Descarga de forma paginada (`next_url`) y normaliza operaciones inusuales de opciones
 * desde `GET /options/v1/unusual-trades`.
 */
export async function loadUnusualTrades(
  options: LoadUnusualTradesOptions,
): Promise<LoadUnusualTradesResult> {
  const transport = validateTransport(options);
  const params = buildQueryParams(options);
  const query = params.toString();
  const initialUrl =
    query === ''
      ? `${transport.baseUrl}/options/v1/unusual-trades`
      : `${transport.baseUrl}/options/v1/unusual-trades?${query}`;

  const fetched = await fetchPaginatedUnusualTrades(transport, initialUrl);
  const normalized = normalizeUnusualTrades(
    { status: 'OK', results: fetched.rows },
    options,
  );

  return {
    trades: normalized.trades,
    report: {
      ...normalized.report,
      pages: fetched.pages,
      stoppedReason: fetched.stoppedReason,
      malformedResponse: normalized.report.malformedResponse || fetched.malformedResponse,
      providerError: finalizeProviderError(
        fetched.providerError,
        normalized.report.providerError,
        transport.secrets,
      ),
    },
  };
}
