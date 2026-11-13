/**
 * Cargadores REST paginados e inyectables (`FetchFn`) para los endpoints
 * auxiliares de contexto macroeconómico, corporativo y snapshot unificado
 * de Massive (Pieza 4):
 *  1) `loadTreasuryYields` (`GET /fed/v1/treasury-yields`)
 *  2) `loadFundingConditions` (`GET /fed/v1/funding-conditions`)
 *  3) `loadDividends` (`GET /stocks/v1/dividends`)
 *  4) `loadOptionOpenInterest` (`GET /options/v1/open-interest`)
 *  5) `loadUnifiedSnapshot` (`GET /v3/snapshot`)
 *
 * Seguridad y resiliencia:
 *  - Lista espejo estricta para `next_url` (`api.polygon.io` / `api.massive.com`).
 *  - Redacción de credenciales (`apiKey` y parámetros auth) en todo `providerError`
 *    y en los errores parciales por ticker de `/v3/snapshot`.
 *  - HTTP 401/403 (u otros códigos de error) devuelven `providerError` limpio
 *    sin lanzar excepción no capturada ni filtrar secretos.
 *  - Reintento 429 opt-in (`retry429MaxAttempts = 0` por defecto).
 */

import type {
  DateRangeFilterOptions,
  LoadDividendsOptions,
  LoadDividendsResult,
  LoadFundingConditionsOptions,
  LoadFundingConditionsResult,
  LoadOptionOpenInterestOptions,
  LoadOptionOpenInterestResult,
  LoadTreasuryYieldsOptions,
  LoadTreasuryYieldsResult,
  LoadUnifiedSnapshotOptions,
  LoadUnifiedSnapshotResult,
  MacroLoadStopReason,
  MacroSharedLoaderOptions,
  UnifiedSnapshotTickerError,
} from './macroTypes.js';
import {
  normalizeDividends,
  normalizeFundingConditions,
  normalizeOptionOpenInterest,
  normalizeTreasuryYields,
  normalizeUnifiedSnapshot,
  parseCalendarDate,
} from './normalizeMacro.js';
import { AUTH_PARAM_NAMES, isRecord, redact, toErrorMessage } from './normalizeShared.js';
import { parseRetryAfterSeconds, retryDelayMs } from './retry.js';
import type { FetchFn, ProviderError, SleepFn } from './types.js';

const DEFAULT_MASSIVE_BASE_URL = 'https://api.massive.com';
const DEFAULT_MAX_PAGES = 50;
const DEFAULT_LIMIT_FED = 1_000;
const MAX_LIMIT_FED = 50_000;
const DEFAULT_LIMIT_DIVIDENDS = 1_000;
const MAX_LIMIT_DIVIDENDS = 5_000;
const DEFAULT_LIMIT_OPEN_INTEREST = 50_000;
const MAX_LIMIT_OPEN_INTEREST = 50_000;
const DEFAULT_LIMIT_UNIFIED_SNAPSHOT = 250;
const MAX_LIMIT_UNIFIED_SNAPSHOT = 250;
const MAX_UNIFIED_SNAPSHOT_TICKERS = 250;

const DEFAULT_RETRY_429_MAX_ATTEMPTS = 0;
const DEFAULT_RETRY_429_BASE_DELAY_MS = 1_000;
const DEFAULT_RETRY_429_MAX_DELAY_MS = 30_000;

const MASSIVE_NEXT_URL_ORIGINS = new Set([
  'https://api.polygon.io',
  'https://api.massive.com',
]);

const AUTH_PARAM_LOWER = new Set([...AUTH_PARAM_NAMES].map((name) => name.toLowerCase()));

const ALLOWED_SNAPSHOT_ASSET_TYPES = new Set([
  'stocks',
  'options',
  'fx',
  'crypto',
  'indices',
]);

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
  readonly stoppedReason: MacroLoadStopReason;
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
  for (const candidate of [apiKey, trimmed, encodeURIComponent(apiKey), encodeURIComponent(trimmed)]) {
    if (candidate.length > 0) {
      unique.add(candidate);
    }
  }
  return [...unique];
}

function validateTransport(options: MacroSharedLoaderOptions): ValidatedTransport {
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

  const sleepFn = options.sleepFn ?? defaultSleepFn;
  const allowedOrigins = new Set<string>([baseUrlObj.origin, ...MASSIVE_NEXT_URL_ORIGINS]);

  return {
    baseUrl,
    baseUrlObj,
    baseOrigin: baseUrlObj.origin,
    allowedOrigins,
    apiKey,
    secrets: buildSecretList(apiKey),
    fetchFn: options.fetchFn,
    maxPages,
    minRequestIntervalMs,
    retry429MaxAttempts,
    retry429BaseDelayMs,
    retry429MaxDelayMs,
    sleepFn,
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
    // Non-JSON error body falls through to raw redacted text.
  }

  return redact(trimmed, secrets);
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

async function fetchPageWithRetry(
  urlWithKey: string,
  transport: ValidatedTransport,
): Promise<{
  readonly status: number;
  readonly ok: boolean;
  readonly bodyText: string;
} | { readonly error: ProviderError }> {
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

async function fetchPaginatedMassive(
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
        stoppedReason: 'maxPages',
        malformedResponse: false,
        providerError: null,
      };
    }

    currentUrl = nextSafeUrl;
  }
}

function validateLimit(
  limit: number | undefined,
  defaultLimit: number,
  maxLimit: number,
): number {
  if (limit === undefined) {
    return defaultLimit;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    throw new Error(`limit must be an integer between 1 and ${String(maxLimit)}, received ${String(limit)}`);
  }
  return limit;
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

function validateCalendarDateParam(value: string | undefined, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = parseCalendarDate(value);
  if (parsed === null) {
    throw new Error(`${name} must be a valid YYYY-MM-DD date, received ${value}`);
  }
  return parsed.date;
}

const ALLOWED_ORDERS = new Set<string>(['asc', 'desc']);
const ALLOWED_OI_CONTRACT_TYPES = new Set<string>(['call', 'put']);

function validateOrderParam(order: 'asc' | 'desc' | undefined): 'asc' | 'desc' | undefined {
  if (order === undefined) {
    return undefined;
  }
  if (!ALLOWED_ORDERS.has(order)) {
    throw new Error(`order must be 'asc' or 'desc'`);
  }
  return order;
}

function validatePositiveFiniteParam(value: number | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a finite number > 0`);
  }
  return value;
}

function appendDateRangeParams(
  params: URLSearchParams,
  options: DateRangeFilterOptions,
  apiDateField: string,
  optionLabelPrefix = 'date',
): void {
  const exact = validateCalendarDateParam(options.date, optionLabelPrefix);
  const gt = validateCalendarDateParam(options.dateGt, `${optionLabelPrefix}Gt`);
  const gte = validateCalendarDateParam(options.dateGte, `${optionLabelPrefix}Gte`);
  const lt = validateCalendarDateParam(options.dateLt, `${optionLabelPrefix}Lt`);
  const lte = validateCalendarDateParam(options.dateLte, `${optionLabelPrefix}Lte`);

  if (exact !== undefined) {
    params.set(apiDateField, exact);
  }
  if (gt !== undefined) {
    params.set(`${apiDateField}.gt`, gt);
  }
  if (gte !== undefined) {
    params.set(`${apiDateField}.gte`, gte);
  }
  if (lt !== undefined) {
    params.set(`${apiDateField}.lt`, lt);
  }
  if (lte !== undefined) {
    params.set(`${apiDateField}.lte`, lte);
  }

  const sort = validateNonEmptyParam(options.sort, 'sort');
  if (sort !== undefined) {
    params.set('sort', sort);
  }

  const order = validateOrderParam(options.order);
  if (order !== undefined) {
    params.set('order', order);
  }
}

function buildUrl(transport: ValidatedTransport, path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query === '' ? `${transport.baseUrl}${path}` : `${transport.baseUrl}${path}?${query}`;
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
 * Carga y normaliza observaciones diarias de la curva US Treasury
 * desde `GET /fed/v1/treasury-yields`.
 */
export async function loadTreasuryYields(
  options: LoadTreasuryYieldsOptions,
): Promise<LoadTreasuryYieldsResult> {
  const transport = validateTransport(options);
  const limit = validateLimit(options.limit, DEFAULT_LIMIT_FED, MAX_LIMIT_FED);

  const params = new URLSearchParams();
  appendDateRangeParams(params, options, 'date', 'date');
  params.set('limit', String(limit));

  const fetched = await fetchPaginatedMassive(
    transport,
    buildUrl(transport, '/fed/v1/treasury-yields', params),
  );
  const normalized = normalizeTreasuryYields({ status: 'OK', results: fetched.rows });

  return {
    observations: normalized.observations,
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

/**
 * Carga y normaliza condiciones diarias de fondeo Fed / SOFR
 * desde `GET /fed/v1/funding-conditions`.
 */
export async function loadFundingConditions(
  options: LoadFundingConditionsOptions,
): Promise<LoadFundingConditionsResult> {
  const transport = validateTransport(options);
  const limit = validateLimit(options.limit, DEFAULT_LIMIT_FED, MAX_LIMIT_FED);

  const params = new URLSearchParams();
  appendDateRangeParams(params, options, 'date', 'date');
  params.set('limit', String(limit));

  const fetched = await fetchPaginatedMassive(
    transport,
    buildUrl(transport, '/fed/v1/funding-conditions', params),
  );
  const normalized = normalizeFundingConditions({ status: 'OK', results: fetched.rows });

  return {
    observations: normalized.observations,
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

/**
 * Carga y normaliza dividendos corporativos desde `GET /stocks/v1/dividends`.
 */
export async function loadDividends(
  options: LoadDividendsOptions,
): Promise<LoadDividendsResult> {
  const transport = validateTransport(options);
  const limit = validateLimit(options.limit, DEFAULT_LIMIT_DIVIDENDS, MAX_LIMIT_DIVIDENDS);

  const params = new URLSearchParams();
  const ticker = validateNonEmptyParam(options.ticker, 'ticker');
  if (ticker !== undefined) {
    params.set('ticker', ticker);
  }

  const distributionType = validateNonEmptyParam(options.distributionType, 'distributionType');
  if (distributionType !== undefined) {
    params.set('distribution_type', distributionType);
  }

  if (options.frequency !== undefined) {
    if (!Number.isInteger(options.frequency) || options.frequency < 0) {
      throw new Error(`frequency must be a non-negative integer, received ${String(options.frequency)}`);
    }
    params.set('frequency', String(options.frequency));
  }

  appendDateRangeParams(
    params,
    {
      ...(options.exDividendDate === undefined ? {} : { date: options.exDividendDate }),
      ...(options.exDividendDateGt === undefined ? {} : { dateGt: options.exDividendDateGt }),
      ...(options.exDividendDateGte === undefined ? {} : { dateGte: options.exDividendDateGte }),
      ...(options.exDividendDateLt === undefined ? {} : { dateLt: options.exDividendDateLt }),
      ...(options.exDividendDateLte === undefined ? {} : { dateLte: options.exDividendDateLte }),
      ...(options.sort === undefined ? {} : { sort: options.sort }),
      ...(options.order === undefined ? {} : { order: options.order }),
    },
    'ex_dividend_date',
    'exDividendDate',
  );
  params.set('limit', String(limit));

  const fetched = await fetchPaginatedMassive(
    transport,
    buildUrl(transport, '/stocks/v1/dividends', params),
  );
  const normalized = normalizeDividends({ status: 'OK', results: fetched.rows });

  return {
    dividends: normalized.dividends,
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

/**
 * Carga y normaliza Open Interest histórico diario de contratos de opciones
 * desde `GET /options/v1/open-interest`.
 */
export async function loadOptionOpenInterest(
  options: LoadOptionOpenInterestOptions,
): Promise<LoadOptionOpenInterestResult> {
  const transport = validateTransport(options);
  const limit = validateLimit(
    options.limit,
    DEFAULT_LIMIT_OPEN_INTEREST,
    MAX_LIMIT_OPEN_INTEREST,
  );

  const params = new URLSearchParams();
  const ticker = validateNonEmptyParam(options.ticker, 'ticker');
  const root = validateNonEmptyParam(options.root, 'root');
  const underlyingTicker = validateNonEmptyParam(options.underlyingTicker, 'underlyingTicker');

  if (ticker !== undefined) {
    params.set('ticker', ticker);
  }
  if (root !== undefined) {
    params.set('root', root);
  }
  if (underlyingTicker !== undefined) {
    params.set('underlying_ticker', underlyingTicker);
  }

  appendDateRangeParams(params, options, 'date', 'date');

  const expirationDate = validateCalendarDateParam(options.expirationDate, 'expirationDate');
  const expirationDateGte = validateCalendarDateParam(
    options.expirationDateGte,
    'expirationDateGte',
  );
  const expirationDateLte = validateCalendarDateParam(
    options.expirationDateLte,
    'expirationDateLte',
  );
  if (expirationDate !== undefined) {
    params.set('expiration_date', expirationDate);
  }
  if (expirationDateGte !== undefined) {
    params.set('expiration_date.gte', expirationDateGte);
  }
  if (expirationDateLte !== undefined) {
    params.set('expiration_date.lte', expirationDateLte);
  }

  if (options.contractType !== undefined) {
    if (!ALLOWED_OI_CONTRACT_TYPES.has(options.contractType)) {
      throw new Error("contractType must be 'call' or 'put'");
    }
    params.set('contract_type', options.contractType);
  }

  const strike = validatePositiveFiniteParam(options.strikePrice, 'strikePrice');
  const strikeGte = validatePositiveFiniteParam(options.strikePriceGte, 'strikePriceGte');
  const strikeLte = validatePositiveFiniteParam(options.strikePriceLte, 'strikePriceLte');
  if (strike !== undefined) {
    params.set('strike_price', String(strike));
  }
  if (strikeGte !== undefined) {
    params.set('strike_price.gte', String(strikeGte));
  }
  if (strikeLte !== undefined) {
    params.set('strike_price.lte', String(strikeLte));
  }

  params.set('limit', String(limit));

  const fetched = await fetchPaginatedMassive(
    transport,
    buildUrl(transport, '/options/v1/open-interest', params),
  );
  const normalized = normalizeOptionOpenInterest({ status: 'OK', results: fetched.rows });

  return {
    records: normalized.records,
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

/**
 * Carga y normaliza el Unified Multi-Asset Snapshot desde `GET /v3/snapshot`
 * para hasta 250 tickers mixtos (`SPY`, `I:SPX`, `I:VIX`, `I:SKEW`, `I:NDX`,
 * contratos `O:...`, etc.), aislando errores parciales (`NOT_ENTITLED`, `NOT_FOUND`).
 */
export async function loadUnifiedSnapshot(
  options: LoadUnifiedSnapshotOptions,
): Promise<LoadUnifiedSnapshotResult> {
  const transport = validateTransport(options);
  const limit = validateLimit(
    options.limit,
    DEFAULT_LIMIT_UNIFIED_SNAPSHOT,
    MAX_LIMIT_UNIFIED_SNAPSHOT,
  );

  if (options.tickers !== undefined && options.ticker !== undefined) {
    throw new Error('Specify either tickers or ticker, not both');
  }

  const params = new URLSearchParams();
  let requestedTickers: string[] = [];

  if (options.tickers !== undefined) {
    if (options.tickers.length === 0) {
      throw new Error('tickers must contain at least one ticker');
    }
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const raw of options.tickers) {
      const trimmed = raw.trim();
      if (trimmed === '') {
        throw new Error('tickers must not contain empty strings');
      }
      if (!seen.has(trimmed)) {
        seen.add(trimmed);
        deduped.push(trimmed);
      }
    }
    if (deduped.length > MAX_UNIFIED_SNAPSHOT_TICKERS) {
      throw new Error(
        `tickers length (${String(deduped.length)}) exceeds Massive max of ${String(MAX_UNIFIED_SNAPSHOT_TICKERS)}`,
      );
    }
    requestedTickers = deduped;
    params.set('ticker.any_of', deduped.join(','));
  } else if (options.ticker !== undefined) {
    const trimmed = validateNonEmptyParam(options.ticker, 'ticker');
    if (trimmed !== undefined) {
      requestedTickers = [trimmed];
      params.set('ticker', trimmed);
    }
  }

  if (options.type !== undefined) {
    if (!ALLOWED_SNAPSHOT_ASSET_TYPES.has(options.type)) {
      throw new Error(`Unsupported unified snapshot type: ${options.type}`);
    }
    params.set('type', options.type);
  }

  params.set('limit', String(limit));

  const fetched = await fetchPaginatedMassive(
    transport,
    buildUrl(transport, '/v3/snapshot', params),
  );
  const normalized = normalizeUnifiedSnapshot({ status: 'OK', results: fetched.rows });

  const redactedTickerErrors: readonly UnifiedSnapshotTickerError[] =
    normalized.tickerErrors.map((item) => ({
      ...item,
      message: redact(item.message, transport.secrets),
    }));

  return {
    stocks: normalized.stocks,
    indices: normalized.indices,
    options: normalized.options,
    other: normalized.other,
    tickerErrors: redactedTickerErrors,
    report: {
      ...normalized.report,
      pages: fetched.pages,
      stoppedReason: fetched.stoppedReason,
      requestedTickers,
      malformedResponse: normalized.report.malformedResponse || fetched.malformedResponse,
      providerError: finalizeProviderError(
        fetched.providerError,
        normalized.report.providerError,
        transport.secrets,
      ),
    },
  };
}
