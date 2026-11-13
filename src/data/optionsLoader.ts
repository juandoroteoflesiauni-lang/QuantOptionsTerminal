/**
 * Cargador REST asíncrono para Contratos de Referencia
 * (`/v3/reference/options/contracts`) y Cadenas de Opciones
 * (`/v3/snapshot/options/{underlyingAsset}`) de Massive (Pieza 1).
 *
 * Particularidades verificadas del proveedor (docs/massive_plan_reference.md):
 *  - Asimetría de índices (`I:`): `/v3/reference/options/contracts` exige
 *    `underlying_ticker=SPX` (sin `I:`), mientras que
 *    `/v3/snapshot/options/I:SPX` exige el prefijo `I:`.
 *  - Seguridad `next_url`: solo `https:`, sin credenciales embebidas y
 *    origen igual a `baseUrl` o en la lista fija de espejos Massive
 *    (`api.polygon.io`, `api.massive.com`). Las claves nunca se escriben en
 *    reportes ni errores.
 *  - `loadOptionChain` puede consultar primero `/v3/reference/options/contracts`
 *    para cruzar `type: 'binary'` y `additional_underlyings`, porque el snapshot
 *    de opciones omite esos metadatos en `details` (p. ej. `O:B1SPY...` y
 *    contratos ajustados `O:GME1...`).
 */

import { URL, URLSearchParams } from 'node:url';
import { getMarketParts, MAX_TIME_SECONDS } from '../core/sessions.js';
import {
  normalizeOptionChainSnapshot,
  normalizeOptionContracts,
  parseExpirationDate,
} from './normalizeOptions.js';
import {
  AUTH_PARAM_NAMES,
  isRecord,
  redact,
  toErrorMessage,
} from './normalizeShared.js';
import type {
  LoadOptionChainOptions,
  LoadOptionChainReport,
  LoadOptionChainResult,
  LoadOptionContractsOptions,
  LoadOptionContractsReport,
  LoadOptionContractsResult,
  OptionContract,
  OptionLoadStopReason,
  OptionSharedLoaderOptions,
} from './optionsTypes.js';
import { parseRetryAfterSeconds, retryDelayMs } from './retry.js';
import type { FetchFn, FetchResponse, ProviderError, SleepFn } from './types.js';

const DEFAULT_MASSIVE_BASE_URL = 'https://api.massive.com';
const DEFAULT_MAX_PAGES = 50;
const CONTRACTS_MAX_LIMIT = 1_000;
const SNAPSHOT_MAX_LIMIT = 250;
const INDEX_PREFIX_RE = /^i:(.*)$/i;

const MASSIVE_NEXT_URL_ORIGINS: ReadonlySet<string> = new Set([
  'https://api.polygon.io',
  'https://api.massive.com',
]);

interface RequestRhythm {
  requestsMade: number;
}

interface ResolvedTransportOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetchFn: FetchFn;
  readonly maxPages: number;
  readonly minRequestIntervalMs: number;
  readonly retry429MaxAttempts: number;
  readonly retry429BaseDelayMs: number;
  readonly retry429MaxDelayMs: number;
  readonly sleepFn: SleepFn;
  readonly secrets: readonly string[];
}

interface ParsedPage {
  readonly rows: readonly unknown[];
  readonly nextUrl: string | null;
  readonly providerError: ProviderError | null;
  readonly malformed: boolean;
}

interface PaginatedFetchResult {
  readonly rows: readonly unknown[];
  readonly pages: number;
  readonly stoppedReason: OptionLoadStopReason;
  readonly providerError: ProviderError | null;
  readonly malformedResponse: boolean;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function validateNonNegativeInt(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new Error(`${name} must be a non-negative integer (got ${String(resolved)})`);
  }
  return resolved;
}

function validatePositiveIntMax(
  value: number | undefined,
  fallback: number,
  max: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0 || resolved > max) {
    throw new Error(
      `${name} must be an integer between 1 and ${String(max)} (got ${String(resolved)})`,
    );
  }
  return resolved;
}

function validateOptionalDateString(value: string | undefined, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = parseExpirationDate(value);
  if (parsed === null) {
    throw new Error(`${name} must be a valid YYYY-MM-DD date (got ${value})`);
  }
  return parsed.date;
}

function validateTransportOptions(
  options: OptionSharedLoaderOptions,
): ResolvedTransportOptions {
  if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '') {
    throw new Error('apiKey is required for Massive');
  }
  if (typeof options.fetchFn !== 'function') {
    throw new Error('fetchFn is required');
  }

  const baseUrl = (options.baseUrl ?? DEFAULT_MASSIVE_BASE_URL).replace(/\/+$/, '');
  if (baseUrl === '') {
    throw new Error('baseUrl must be a non-empty URL');
  }
  let parsedBase: URL;
  try {
    parsedBase = new URL(baseUrl);
  } catch {
    throw new Error(`baseUrl must be an absolute https URL (got ${baseUrl})`);
  }
  if (parsedBase.protocol !== 'https:') {
    throw new Error(`baseUrl must be an absolute https URL (got ${baseUrl})`);
  }

  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  if (!Number.isInteger(maxPages) || maxPages <= 0) {
    throw new Error(`maxPages must be a positive integer (got ${String(maxPages)})`);
  }

  const minRequestIntervalMs = validateNonNegativeInt(
    options.minRequestIntervalMs,
    0,
    'minRequestIntervalMs',
  );
  const retry429MaxAttempts = validateNonNegativeInt(
    options.retry429MaxAttempts,
    0,
    'retry429MaxAttempts',
  );
  const retry429BaseDelayMs = validateNonNegativeInt(
    options.retry429BaseDelayMs,
    1_000,
    'retry429BaseDelayMs',
  );
  const retry429MaxDelayMs = validateNonNegativeInt(
    options.retry429MaxDelayMs,
    30_000,
    'retry429MaxDelayMs',
  );

  return {
    baseUrl,
    apiKey: options.apiKey,
    fetchFn: options.fetchFn,
    maxPages,
    minRequestIntervalMs,
    retry429MaxAttempts,
    retry429BaseDelayMs,
    retry429MaxDelayMs,
    sleepFn: options.sleepFn ?? defaultSleep,
    secrets: [options.apiKey, encodeURIComponent(options.apiKey)],
  };
}

function validateNonEmptyUnderlying(underlying: string): string {
  if (typeof underlying !== 'string' || underlying.trim() === '') {
    throw new Error('underlying must be a non-empty string');
  }
  const trimmed = underlying.trim();
  const match = INDEX_PREFIX_RE.exec(trimmed);
  if (match !== null && (match[1] ?? '').trim() === '') {
    throw new Error('underlying must not be empty after I: prefix');
  }
  return trimmed;
}

/**
 * Convierte el subyacente al formato exigido por `/v3/reference/options/contracts`
 * (sin prefijo `I:` en índices: `'I:SPX'` -> `'SPX'`).
 */
export function toReferenceUnderlyingTicker(
  underlying: string,
  isIndex?: boolean,
): string {
  const trimmed = validateNonEmptyUnderlying(underlying);
  const match = INDEX_PREFIX_RE.exec(trimmed);
  if (match !== null) {
    if (isIndex === false) {
      throw new Error(`Conflicting isIndex=false for prefixed underlying ${trimmed}`);
    }
    return (match[1] ?? '').trim();
  }
  return trimmed;
}

/**
 * Convierte el subyacente al formato exigido por `/v3/snapshot/options/{underlyingAsset}`
 * (requiere prefijo `I:` en índices: `('SPX', true)` o `'I:SPX'` -> `'I:SPX'`).
 */
export function toSnapshotUnderlyingAsset(
  underlying: string,
  isIndex?: boolean,
): string {
  const trimmed = validateNonEmptyUnderlying(underlying);
  const match = INDEX_PREFIX_RE.exec(trimmed);
  if (match !== null) {
    if (isIndex === false) {
      throw new Error(`Conflicting isIndex=false for prefixed underlying ${trimmed}`);
    }
    return `I:${(match[1] ?? '').trim()}`;
  }
  if (isIndex === true) {
    return `I:${trimmed}`;
  }
  return trimmed;
}

function resolveNowSeconds(now: number | undefined): number {
  if (now === undefined) {
    return Math.floor(Date.now() / 1_000);
  }
  if (!Number.isFinite(now) || !Number.isInteger(now) || now <= 0 || now > MAX_TIME_SECONDS) {
    throw new Error(
      `now must be finite integer seconds within supported range (got ${String(now)})`,
    );
  }
  return now;
}

function addDaysToEtDateKey(nowSeconds: number, days: number): string {
  const parts = getMarketParts(nowSeconds, 'EQUITY');
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return d.toISOString().slice(0, 10);
}

function maxDateString(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) {
    return b;
  }
  if (b === undefined) {
    return a;
  }
  return a >= b ? a : b;
}

function minDateString(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) {
    return b;
  }
  if (b === undefined) {
    return a;
  }
  return a <= b ? a : b;
}

function appendCommonQueryFilters(
  params: URLSearchParams,
  options: Readonly<{
    contractType?: 'call' | 'put';
    minStrike?: number;
    maxStrike?: number;
    expirationDate?: string;
    expirationDateGte?: string;
    expirationDateLte?: string;
    minDte?: number;
    maxDte?: number;
    now?: number;
  }>,
): void {
  if (options.contractType !== undefined) {
    params.set('contract_type', options.contractType);
  }
  if (options.minStrike !== undefined) {
    params.set('strike_price.gte', String(options.minStrike));
  }
  if (options.maxStrike !== undefined) {
    params.set('strike_price.lte', String(options.maxStrike));
  }

  const exactExp = validateOptionalDateString(options.expirationDate, 'expirationDate');
  const explicitGte = validateOptionalDateString(
    options.expirationDateGte,
    'expirationDateGte',
  );
  const explicitLte = validateOptionalDateString(
    options.expirationDateLte,
    'expirationDateLte',
  );

  if (exactExp !== undefined) {
    params.set('expiration_date', exactExp);
    return;
  }

  const nowForDte =
    options.minDte !== undefined || options.maxDte !== undefined
      ? resolveNowSeconds(options.now)
      : undefined;
  const dteGte =
    options.minDte !== undefined && nowForDte !== undefined
      ? addDaysToEtDateKey(nowForDte, options.minDte)
      : undefined;
  const dteLte =
    options.maxDte !== undefined && nowForDte !== undefined
      ? addDaysToEtDateKey(nowForDte, options.maxDte)
      : undefined;

  const finalGte = maxDateString(explicitGte, dteGte);
  const finalLte = minDateString(explicitLte, dteLte);
  if (finalGte !== undefined) {
    params.set('expiration_date.gte', finalGte);
  }
  if (finalLte !== undefined) {
    params.set('expiration_date.lte', finalLte);
  }
}

function buildContractsUrl(
  baseUrl: string,
  referenceUnderlying: string,
  limit: number,
  options: LoadOptionContractsOptions,
): string {
  const params = new URLSearchParams({
    underlying_ticker: referenceUnderlying,
    limit: String(limit),
  });
  if (options.expired !== undefined) {
    params.set('expired', options.expired ? 'true' : 'false');
  }
  const asOf = validateOptionalDateString(options.asOf, 'asOf');
  if (asOf !== undefined) {
    params.set('as_of', asOf);
  }
  appendCommonQueryFilters(params, options);
  return `${baseUrl}/v3/reference/options/contracts?${params.toString()}`;
}

function buildSnapshotUrl(
  baseUrl: string,
  snapshotUnderlying: string,
  limit: number,
  options: LoadOptionChainOptions,
): string {
  const encodedUnderlying = encodeURIComponent(snapshotUnderlying).replace(/%3A/gi, ':');
  const params = new URLSearchParams({
    limit: String(limit),
  });
  appendCommonQueryFilters(params, options);
  return `${baseUrl}/v3/snapshot/options/${encodedUnderlying}?${params.toString()}`;
}

function allowedNextUrl(nextUrl: string, baseUrl: string): string {
  const base = new URL(baseUrl);
  const next = new URL(nextUrl, base);
  if (next.protocol !== 'https:') {
    throw new Error(`Unsupported next_url protocol: ${next.protocol}`);
  }
  if (next.username !== '' || next.password !== '') {
    throw new Error('next_url must not include credentials');
  }
  if (next.origin !== base.origin) {
    if (!MASSIVE_NEXT_URL_ORIGINS.has(next.origin)) {
      throw new Error(`next_url origin not allowed: ${next.origin}`);
    }
    const rewritten = new URL(next.pathname + next.search, base);
    return rewritten.toString();
  }
  return next.toString();
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

function parseMassivePage(
  response: FetchResponse,
  secrets: readonly string[],
): ParsedPage {
  if (!response.ok || response.status < 200 || response.status >= 300) {
    return {
      rows: [],
      nextUrl: null,
      providerError: {
        code: response.status,
        message: redact(
          extractHttpMessage(response.text, `HTTP ${String(response.status)}`),
          secrets,
        ),
      },
      malformed: false,
    };
  }

  let body: unknown;
  try {
    body = JSON.parse(response.text) as unknown;
  } catch {
    return { rows: [], nextUrl: null, providerError: null, malformed: true };
  }

  if (!isRecord(body)) {
    return { rows: [], nextUrl: null, providerError: null, malformed: true };
  }

  const status = body['status'];
  if (typeof status === 'string' && status.toUpperCase() !== 'OK') {
    const message = body['error'] ?? body['message'] ?? status;
    return {
      rows: [],
      nextUrl: null,
      providerError: {
        code: 0,
        message: redact(toErrorMessage(message, status), secrets),
      },
      malformed: false,
    };
  }

  const results = body['results'];
  if (results === undefined || results === null) {
    const next = body['next_url'];
    return {
      rows: [],
      nextUrl: typeof next === 'string' && next !== '' ? next : null,
      providerError: null,
      malformed: false,
    };
  }
  if (!Array.isArray(results)) {
    return { rows: [], nextUrl: null, providerError: null, malformed: true };
  }

  const next = body['next_url'];
  if (next !== undefined && next !== null && typeof next !== 'string') {
    return { rows: [], nextUrl: null, providerError: null, malformed: true };
  }

  return {
    rows: results,
    nextUrl: typeof next === 'string' && next !== '' ? next : null,
    providerError: null,
    malformed: false,
  };
}

async function performRequest(
  transport: ResolvedTransportOptions,
  rhythm: RequestRhythm,
  url: string,
): Promise<
  | { readonly ok: true; readonly response: FetchResponse }
  | { readonly ok: false; readonly error: unknown }
> {
  let retriesUsed = 0;
  for (;;) {
    if (rhythm.requestsMade > 0 && transport.minRequestIntervalMs > 0) {
      await transport.sleepFn(transport.minRequestIntervalMs);
    }
    rhythm.requestsMade += 1;

    let response: FetchResponse;
    try {
      response = await transport.fetchFn(url);
    } catch (error) {
      return { ok: false, error };
    }

    if (response.status !== 429 || retriesUsed >= transport.retry429MaxAttempts) {
      return { ok: true, response };
    }

    const retryAfter =
      response.retryAfterSeconds ??
      parseRetryAfterSeconds(response.headers?.['retry-after'], Date.now());
    await transport.sleepFn(
      retryDelayMs({
        attempt: retriesUsed,
        retryAfterSeconds: retryAfter,
        baseDelayMs: transport.retry429BaseDelayMs,
        maxDelayMs: transport.retry429MaxDelayMs,
      }),
    );
    retriesUsed += 1;
  }
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

async function fetchPaginatedMassive(
  initialUrl: string,
  transport: ResolvedTransportOptions,
  rhythm: RequestRhythm,
): Promise<PaginatedFetchResult> {
  const rows: unknown[] = [];
  let url = withApiKey(initialUrl, transport.apiKey, transport.baseUrl);
  let pages = 0;
  let stoppedReason: OptionLoadStopReason = 'noMorePages';
  let providerError: ProviderError | null = null;
  let malformedResponse = false;

  while (pages < transport.maxPages) {
    pages += 1;

    const outcome = await performRequest(transport, rhythm, url);
    if (!outcome.ok) {
      providerError = {
        code: 0,
        message: redact(errorMessage(outcome.error), transport.secrets),
      };
      stoppedReason = 'providerError';
      break;
    }

    const page = parseMassivePage(outcome.response, transport.secrets);
    if (page.providerError !== null) {
      providerError = page.providerError;
      stoppedReason = 'providerError';
      break;
    }
    if (page.malformed) {
      malformedResponse = true;
      stoppedReason = 'malformedResponse';
      break;
    }

    rows.push(...page.rows);

    if (page.rows.length === 0 || page.nextUrl === null) {
      stoppedReason = 'noMorePages';
      break;
    }

    if (pages >= transport.maxPages) {
      stoppedReason = 'maxPages';
      break;
    }

    try {
      url = withApiKey(
        allowedNextUrl(page.nextUrl, transport.baseUrl),
        transport.apiKey,
        transport.baseUrl,
      );
    } catch {
      malformedResponse = true;
      stoppedReason = 'malformedResponse';
      break;
    }
  }

  return {
    rows,
    pages,
    stoppedReason,
    providerError,
    malformedResponse,
  };
}

function buildFilterForwardProps(
  options: Readonly<{
    excludeBinary?: boolean;
    excludeAdjusted?: boolean;
    standardSharesPerContract?: number;
    contractType?: 'call' | 'put';
    minDte?: number;
    maxDte?: number;
    minStrike?: number;
    maxStrike?: number;
  }>,
  nowForFilter: number | undefined,
): Readonly<{
  excludeBinary?: boolean;
  excludeAdjusted?: boolean;
  standardSharesPerContract?: number;
  contractType?: 'call' | 'put';
  minDte?: number;
  maxDte?: number;
  minStrike?: number;
  maxStrike?: number;
  now?: number;
}> {
  return {
    ...(options.excludeBinary === undefined
      ? {}
      : { excludeBinary: options.excludeBinary }),
    ...(options.excludeAdjusted === undefined
      ? {}
      : { excludeAdjusted: options.excludeAdjusted }),
    ...(options.standardSharesPerContract === undefined
      ? {}
      : { standardSharesPerContract: options.standardSharesPerContract }),
    ...(options.contractType === undefined
      ? {}
      : { contractType: options.contractType }),
    ...(options.minDte === undefined ? {} : { minDte: options.minDte }),
    ...(options.maxDte === undefined ? {} : { maxDte: options.maxDte }),
    ...(options.minStrike === undefined ? {} : { minStrike: options.minStrike }),
    ...(options.maxStrike === undefined ? {} : { maxStrike: options.maxStrike }),
    ...(nowForFilter === undefined ? {} : { now: nowForFilter }),
  };
}

async function loadOptionContractsInternal(
  options: LoadOptionContractsOptions,
  rhythm: RequestRhythm,
): Promise<LoadOptionContractsResult> {
  const transport = validateTransportOptions(options);
  const referenceUnderlying = toReferenceUnderlyingTicker(
    options.underlying,
    options.isIndex,
  );
  const limit = validatePositiveIntMax(
    options.limit,
    CONTRACTS_MAX_LIMIT,
    CONTRACTS_MAX_LIMIT,
    'limit',
  );
  const needsDteNow = options.minDte !== undefined || options.maxDte !== undefined;
  const resolvedNow = needsDteNow ? resolveNowSeconds(options.now) : options.now;
  if (resolvedNow !== undefined) {
    resolveNowSeconds(resolvedNow);
  }

  const filterProps = buildFilterForwardProps(
    options,
    resolvedNow,
  );
  // Prevalidamos las opciones de filtrado antes de disparar red.
  normalizeOptionContracts({ status: 'OK', results: [] }, filterProps);

  const initialUrl = buildContractsUrl(
    transport.baseUrl,
    referenceUnderlying,
    limit,
    options,
  );
  const fetched = await fetchPaginatedMassive(initialUrl, transport, rhythm);
  const normalized = normalizeOptionContracts(
    { status: 'OK', results: fetched.rows },
    filterProps,
  );

  const report: LoadOptionContractsReport = {
    ...normalized.report,
    malformedResponse: fetched.malformedResponse || normalized.report.malformedResponse,
    providerError: fetched.providerError ?? normalized.report.providerError,
    pages: fetched.pages,
    stoppedReason: fetched.stoppedReason,
    referenceUnderlyingTicker: referenceUnderlying,
  };

  return {
    contracts: normalized.contracts,
    report,
  };
}

/**
 * Carga y normaliza contratos de referencia paginando `/v3/reference/options/contracts`.
 */
export async function loadOptionContracts(
  options: LoadOptionContractsOptions,
): Promise<LoadOptionContractsResult> {
  return loadOptionContractsInternal(options, { requestsMade: 0 });
}

/**
 * Carga y normaliza la cadena completa desde `/v3/snapshot/options/{underlyingAsset}`.
 *
 * Si no se entrega `referenceContracts` y se filtran binarias o ajustadas
 * (por defecto ambos filtros activos), consulta primero `/v3/reference/options/contracts`
 * usando el símbolo sin prefijo `I:` para identificar contratos binarios
 * (`O:B1...`) o ajustados (`additional_underlyings` no vacío) cuyos metadatos
 * faltan en el endpoint de snapshot.
 */
export async function loadOptionChain(
  options: LoadOptionChainOptions,
): Promise<LoadOptionChainResult> {
  const transport = validateTransportOptions(options);
  const snapshotUnderlying = toSnapshotUnderlyingAsset(
    options.underlying,
    options.isIndex,
  );
  const referenceUnderlying = toReferenceUnderlyingTicker(
    options.underlying,
    options.isIndex,
  );
  const snapshotLimit = validatePositiveIntMax(
    options.snapshotLimit,
    SNAPSHOT_MAX_LIMIT,
    SNAPSHOT_MAX_LIMIT,
    'snapshotLimit',
  );
  const contractsLimit = validatePositiveIntMax(
    options.contractsLimit,
    CONTRACTS_MAX_LIMIT,
    CONTRACTS_MAX_LIMIT,
    'contractsLimit',
  );
  const needsDteNow = options.minDte !== undefined || options.maxDte !== undefined;
  const resolvedNow = needsDteNow ? resolveNowSeconds(options.now) : options.now;
  if (resolvedNow !== undefined) {
    resolveNowSeconds(resolvedNow);
  }

  const filterProps = buildFilterForwardProps(options, resolvedNow);
  const excludeBinary = options.excludeBinary ?? true;
  const excludeAdjusted = options.excludeAdjusted ?? true;
  const shouldFetchReference =
    options.referenceContracts === undefined &&
    (options.includeReferenceMetadata ?? (excludeBinary || excludeAdjusted));

  // Prevalidamos las opciones antes de ejecutar peticiones de red.
  normalizeOptionChainSnapshot(
    { status: 'OK', results: [] },
    {
      ...filterProps,
      ...(options.referenceContracts === undefined
        ? {}
        : { referenceContracts: options.referenceContracts }),
    },
  );

  const rhythm: RequestRhythm = { requestsMade: 0 };
  let contractsReport: LoadOptionContractsReport | null = null;
  let referenceContracts:
    | ReadonlyMap<string, OptionContract>
    | readonly OptionContract[]
    | undefined = options.referenceContracts;
  let referencePages = 0;

  if (shouldFetchReference) {
    const refOptions: LoadOptionContractsOptions = {
      underlying: options.underlying,
      ...(options.isIndex === undefined ? {} : { isIndex: options.isIndex }),
      fetchFn: options.fetchFn,
      apiKey: options.apiKey,
      baseUrl: transport.baseUrl,
      maxPages: transport.maxPages,
      minRequestIntervalMs: transport.minRequestIntervalMs,
      retry429MaxAttempts: transport.retry429MaxAttempts,
      retry429BaseDelayMs: transport.retry429BaseDelayMs,
      retry429MaxDelayMs: transport.retry429MaxDelayMs,
      sleepFn: transport.sleepFn,
      limit: contractsLimit,
      // Mantenemos binarias y ajustadas en la tabla de referencia para que el
      // normalizador del snapshot pueda etiquetarlas y reportar su exclusión.
      excludeBinary: false,
      excludeAdjusted: false,
      ...(options.standardSharesPerContract === undefined
        ? {}
        : { standardSharesPerContract: options.standardSharesPerContract }),
      ...(options.contractType === undefined
        ? {}
        : { contractType: options.contractType }),
      ...(options.minDte === undefined ? {} : { minDte: options.minDte }),
      ...(options.maxDte === undefined ? {} : { maxDte: options.maxDte }),
      ...(options.minStrike === undefined ? {} : { minStrike: options.minStrike }),
      ...(options.maxStrike === undefined ? {} : { maxStrike: options.maxStrike }),
      ...(resolvedNow === undefined ? {} : { now: resolvedNow }),
      ...(options.expirationDate === undefined
        ? {}
        : { expirationDate: options.expirationDate }),
      ...(options.expirationDateGte === undefined
        ? {}
        : { expirationDateGte: options.expirationDateGte }),
      ...(options.expirationDateLte === undefined
        ? {}
        : { expirationDateLte: options.expirationDateLte }),
      ...(options.expired === undefined ? {} : { expired: options.expired }),
      ...(options.asOf === undefined ? {} : { asOf: options.asOf }),
    };

    const refResult = await loadOptionContractsInternal(refOptions, rhythm);
    contractsReport = refResult.report;
    referencePages = refResult.report.pages;

    if (refResult.report.stoppedReason !== 'noMorePages') {
      const emptyNormalized = normalizeOptionChainSnapshot(
        { status: 'OK', results: [] },
        filterProps,
      );
      const report: LoadOptionChainReport = {
        ...emptyNormalized.report,
        malformedResponse: refResult.report.malformedResponse,
        providerError: refResult.report.providerError,
        pages: referencePages,
        referencePages,
        snapshotPages: 0,
        stoppedReason: refResult.report.stoppedReason,
        snapshotUnderlyingAsset: snapshotUnderlying,
        referenceUnderlyingTicker: referenceUnderlying,
        contractsReport,
      };
      return { contracts: [], underlying: null, report };
    }

    referenceContracts = refResult.contracts;
  }

  const initialUrl = buildSnapshotUrl(
    transport.baseUrl,
    snapshotUnderlying,
    snapshotLimit,
    options,
  );
  const fetched = await fetchPaginatedMassive(initialUrl, transport, rhythm);
  const normalized = normalizeOptionChainSnapshot(
    { status: 'OK', results: fetched.rows },
    {
      ...filterProps,
      ...(referenceContracts === undefined ? {} : { referenceContracts }),
    },
  );

  const report: LoadOptionChainReport = {
    ...normalized.report,
    malformedResponse: fetched.malformedResponse || normalized.report.malformedResponse,
    providerError: fetched.providerError ?? normalized.report.providerError,
    pages: referencePages + fetched.pages,
    referencePages,
    snapshotPages: fetched.pages,
    stoppedReason: fetched.stoppedReason,
    snapshotUnderlyingAsset: snapshotUnderlying,
    referenceUnderlyingTicker: referenceUnderlying,
    contractsReport,
  };

  return {
    contracts: normalized.contracts,
    underlying: normalized.underlying,
    report,
  };
}
