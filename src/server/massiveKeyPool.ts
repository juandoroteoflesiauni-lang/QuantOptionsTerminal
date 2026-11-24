/**
 * Segregación por dominio, failover HTTP efectivo y protección de secretos para Massive
 * (Pieza 32 + endurecimiento Camino A / Pieza 0A).
 *
 * Asignación estricta por dominio REST:
 *  - `STOCKS_REST` (`massiveStocksRestPool`):
 *      Primarios (round-robin): `MASSIVE_KEY_2` (`STOCKS_SLOT_2`), `MASSIVE_KEY_3` (`STOCKS_SLOT_3`).
 *      Respaldo ordenado: `MASSIVE_KEY_1` (`STOCKS_SLOT_1`) -> `MASSIVE_API_KEY` (`STOCKS_SHARED_OPTIONS_FALLBACK`).
 *  - `OPTIONS_REST` (`massiveOptionsRestPool`):
 *      Primario único: `MASSIVE_API_KEY` (`OPTIONS_SLOT_1`), sin respaldos.
 *      `MASSIVE_KEY_2`, `MASSIVE_KEY_3`, `MASSIVE_KEY_1` y `MASSIVE_KEY_FUTURES` JAMÁS se usan para opciones.
 *  - `FUTURES_REST` (`massiveFuturesRestKey`):
 *      Primario único: `MASSIVE_KEY_FUTURES` (`FUTURES_SLOT_1`), sin respaldos y acotado a `/futures`.
 *
 * Variables legacy (`MASSIVE_REST_KEY`, `MASSIVE_REST_KEYS`) se recolectan para redacción
 * integral pero NO reintroducen un pool compartido ni alimentan REST/WS.
 *
 * Nota sobre cuota compartida: `MASSIVE_API_KEY` es el único slot activo de opciones y respaldo
 * de emergencia para stocks. `SharedOptionsQuotaGuard` protege la prioridad operativa de opciones
 * limitando y bloqueando el uso de respaldo desde stocks cuando opciones registra presión/429.
 *
 * Seguridad: jamás se loguean, serializan ni exponen valores, prefijos ni sufijos de claves;
 * todo diagnóstico identifica únicamente `slotId` / `envName` lógicos.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AUTH_PARAM_NAMES } from '../data/normalizeShared.js';
import { parseRetryAfterSeconds } from '../data/retry.js';
import type { FetchFn, FetchResponse } from '../data/types.js';
import { formatRedactedError, redactHeaders, redactSecrets } from './runtimeCache.js';

export type MassiveKeyRole = 'WS_STOCKS' | 'WS_OPTIONS' | 'REST';
export type MassiveRestDomain = 'STOCKS_REST' | 'OPTIONS_REST' | 'FUTURES_REST';
export type MassiveSlotTier = 'PRIMARY' | 'FALLBACK';
export type MassiveSlotHealthState =
  | 'AVAILABLE'
  | 'COOLDOWN_429'
  | 'COOLDOWN_5XX'
  | 'COOLDOWN_NETWORK'
  | 'PENALIZED_AUTH'
  | 'DISABLED';

export type MassivePoolExhaustedReason =
  | 'POOL_UNCONFIGURED'
  | 'ALL_SLOTS_UNAVAILABLE'
  | 'SHARED_FALLBACK_RESERVED_FOR_OPTIONS'
  | 'OPERATION_DEADLINE_EXCEEDED'
  | 'DOMAIN_ENDPOINT_MISMATCH';

export type MassiveAttemptOutcome =
  | 'SUCCESS_2XX'
  | 'CLIENT_ERROR_NON_RETRYABLE'
  | 'HTTP_429'
  | 'HTTP_403_AUTH'
  | 'HTTP_5XX'
  | 'TIMEOUT_OR_NETWORK'
  | 'SKIPPED_OPTIONS_QUOTA_GUARD'
  | 'ABORTED';

/** Listado completo de variables de entorno de credenciales Massive (para redacción integral). */
export const MASSIVE_SECRET_ENV_NAMES = [
  'MASSIVE_API_KEY',
  'MASSIVE_KEY',
  'MASSIVE_KEY_OPTIONS',
  'MASSIVE_OPTIONS',
  'MASSIVE_WS_STOCKS_KEY',
  'MASSIVE_REST_KEY',
  'MASSIVE_REST_KEYS',
  'MASSIVE_KEY_1',
  'MASSIVE_KEY_2',
  'MASSIVE_KEY_3',
  'MASSIVE_KEY_FUTURES',
] as const;

/**
 * Política futura WS de stocks (documentación explícita, deshabilitada por defecto):
 * `MASSIVE_KEY_2` es la única candidata futura para `/stocks` WS bajo autorización expresa.
 * `MASSIVE_KEY_1` y `MASSIVE_KEY_3` quedan excluidas permanentemente de cualquier uso WS.
 */
export const MASSIVE_WS_STOCKS_FUTURE_CANDIDATE_ENV = 'MASSIVE_KEY_2' as const;
export const MASSIVE_WS_EXCLUDED_KEY_ENVS = [
  'MASSIVE_KEY_1',
  'MASSIVE_KEY_3',
  'MASSIVE_REST_KEY',
  'MASSIVE_REST_KEYS',
  'MASSIVE_KEY_FUTURES',
] as const;

/** Cadena legacy de resolución WS stocks (`MASSIVE_WS_STOCKS_KEY` -> `MASSIVE_API_KEY`). */
const WS_STOCKS_ENV_CHAIN = ['MASSIVE_WS_STOCKS_KEY', 'MASSIVE_API_KEY'] as const;

/** Slot resuelto del pool. `key` es material secreto: nunca loguear ni serializar. */
export interface MassiveKeySlot {
  readonly key: string;
  readonly envName: string;
  readonly slotIndex: number;
  readonly poolSize: number;
  readonly role: MassiveKeyRole;
  readonly slotId?: string;
  readonly domain?: MassiveRestDomain;
  readonly tier?: MassiveSlotTier;
  readonly sharedWithOptions?: boolean;
}

/** Descripción segura de un slot para observabilidad HTTP (sin material secreto). */
export interface MassiveKeySlotStatus {
  readonly envName: string;
  readonly slotIndex: number;
  readonly role: MassiveKeyRole;
  readonly slotId?: string;
  readonly domain?: MassiveRestDomain;
  readonly tier?: MassiveSlotTier;
  readonly state?: MassiveSlotHealthState;
  readonly sharedWithOptions?: boolean;
  readonly cooldownUntilMs?: number | null;
  readonly successCount?: number;
  readonly failureCount?: number;
  readonly lastHttpStatus?: number | null;
}

export interface MassiveDomainPoolStatus {
  readonly domain: MassiveRestDomain;
  readonly configured: boolean;
  readonly poolSize: number;
  readonly activeSlotCount: number;
  readonly primarySlotCount: number;
  readonly fallbackSlotCount: number;
  readonly slots: readonly MassiveKeySlotStatus[];
  readonly lastSlotIndex: number | null;
  readonly roundRobinRequests: number;
  readonly inFlightCount: number;
}

export interface MassiveKeyPoolStatus {
  readonly configured: boolean;
  readonly wsStocks: {
    readonly configured: boolean;
    readonly envName: string | null;
    readonly policyState: 'STANDBY_TRADIER_FMP_PRIMARY';
    readonly futureCandidateEnv: typeof MASSIVE_WS_STOCKS_FUTURE_CANDIDATE_ENV;
    readonly excludedEnvs: readonly string[];
  };
  readonly wsOptions: {
    readonly configured: boolean;
    readonly envName: 'MASSIVE_API_KEY' | null;
  };
  readonly wsFutures: {
    readonly policyState: 'CLOSED_DISABLED';
  };
  readonly rest: {
    readonly configured: boolean;
    readonly poolSize: number;
    readonly slots: readonly MassiveKeySlotStatus[];
    readonly lastSlotIndex: number | null;
    readonly roundRobinRequests: number;
  };
  readonly domains: Readonly<Record<MassiveRestDomain, MassiveDomainPoolStatus>>;
  readonly legacySharedEnvIgnored: {
    readonly massiveRestKeyPresent: boolean;
    readonly massiveRestKeysPresent: boolean;
  };
  readonly sharedOptionsQuotaGuard: {
    readonly lastOptionsRateLimitAtMs: number | null;
    readonly sharedFallbackInFlight: number;
    readonly sharedFallbackRecentCalls: number;
  };
}

export interface MassiveEnvSource {
  readonly env: NodeJS.ProcessEnv;
  readonly fileValues: ReadonlyMap<string, string>;
}

export interface MassiveKeyRouterOptions {
  readonly nowMsFn?: () => number;
  readonly secrets?: readonly string[];
  readonly disabledSlots?: readonly string[];
  readonly maxAttempts?: number;
  readonly totalDeadlineMs?: number;
  readonly perAttemptTimeoutMs?: number;
  readonly baseRateLimitCooldownMs?: number;
  readonly maxRateLimitCooldownMs?: number;
  readonly baseTransientCooldownMs?: number;
  readonly maxTransientCooldownMs?: number;
  readonly networkCooldownMs?: number;
  readonly authPenaltyMs?: number;
  readonly optionsPriorityWindowMs?: number;
  readonly maxSharedFallbackCallsPerMinute?: number;
  readonly maxSharedFallbackConcurrency?: number;
}

export interface MassiveAttemptDiagnostic {
  readonly slotId: string;
  readonly envName: string;
  readonly tier: MassiveSlotTier;
  readonly outcome: MassiveAttemptOutcome;
  readonly httpStatus: number | null;
  readonly durationMs: number;
}

export class MassivePoolExhaustedError extends Error {
  public readonly domain: MassiveRestDomain;
  public readonly reason: MassivePoolExhaustedReason;
  public readonly lastHttpStatus: number | null;
  public readonly attempts: readonly MassiveAttemptDiagnostic[];

  public constructor(params: {
    readonly domain: MassiveRestDomain;
    readonly reason: MassivePoolExhaustedReason;
    readonly lastHttpStatus: number | null;
    readonly attempts: readonly MassiveAttemptDiagnostic[];
    readonly message: string;
  }) {
    super(params.message);
    this.name = 'MassivePoolExhaustedError';
    this.domain = params.domain;
    this.reason = params.reason;
    this.lastHttpStatus = params.lastHttpStatus;
    this.attempts = params.attempts;
  }
}

export function isMassivePoolExhaustedError(err: unknown): err is MassivePoolExhaustedError {
  return err instanceof MassivePoolExhaustedError;
}

export interface MassiveRestExecutionOptions {
  readonly domain: MassiveRestDomain;
  readonly url: string;
  readonly fetchFn: FetchFn;
  readonly maxAttempts?: number;
  readonly totalDeadlineMs?: number;
  readonly perAttemptTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

interface PoolSlot {
  readonly key: string;
  readonly envName: string;
  readonly slotId: string;
  readonly tier: MassiveSlotTier;
  readonly sharedWithOptions: boolean;
}

interface MutableDomainSlotState extends PoolSlot {
  readonly slotIndex: number;
  state: MassiveSlotHealthState;
  cooldownUntilMs: number | null;
  rateLimitHits: number;
  transientFailures: number;
  authFailures: number;
  successCount: number;
  failureCount: number;
  lastHttpStatus: number | null;
  lastRateLimitAtMs: number | null;
}

interface DomainPoolState {
  readonly domain: MassiveRestDomain;
  readonly slots: MutableDomainSlotState[];
  primaryCursor: number;
  requests: number;
  inFlightCount: number;
}

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_TOTAL_DEADLINE_MS = 20_000;
const DEFAULT_PER_ATTEMPT_TIMEOUT_MS = 10_000;
const DEFAULT_BASE_RATE_LIMIT_COOLDOWN_MS = 5_000;
const DEFAULT_MAX_RATE_LIMIT_COOLDOWN_MS = 300_000;
const DEFAULT_BASE_TRANSIENT_COOLDOWN_MS = 2_000;
const DEFAULT_MAX_TRANSIENT_COOLDOWN_MS = 30_000;
const DEFAULT_NETWORK_COOLDOWN_MS = 1_500;
const DEFAULT_AUTH_PENALTY_MS = 15 * 60 * 1_000;
const DEFAULT_OPTIONS_PRIORITY_WINDOW_MS = 60_000;
const DEFAULT_SHARED_FALLBACK_MAX_PER_MIN = 10;
const DEFAULT_SHARED_FALLBACK_MAX_CONCURRENCY = 2;

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

/** Fuente de variables combinada: `process.env` primero, luego `.env`. */
export function readMassiveEnvSource(
  env: NodeJS.ProcessEnv = process.env,
  envFilePath: string = resolve(process.cwd(), '.env'),
): MassiveEnvSource {
  return { env, fileValues: parseEnvFile(envFilePath) };
}

/** Resuelve `name` desde `process.env` o `.env`; devuelve '' si no existe. */
export function resolveMassiveEnvValue(source: MassiveEnvSource, name: string): string {
  const fromEnv = source.env[name];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return fromEnv.trim();
  }
  const fromFile = source.fileValues.get(name);
  return typeof fromFile === 'string' ? fromFile.trim() : '';
}

/**
 * Recolecta TODAS las credenciales Massive configuradas (individuales y listas separadas por
 * comas) para uso exclusivo en redacción de URLs, cabeceras, errores y logs.
 */
export function collectMassiveSecretsFromSource(source: MassiveEnvSource): readonly string[] {
  const secretSet = new Set<string>();
  for (const envName of MASSIVE_SECRET_ENV_NAMES) {
    for (const rawCandidate of [source.env[envName], source.fileValues.get(envName)]) {
      if (typeof rawCandidate !== 'string') {
        continue;
      }
      const trimmed = rawCandidate.trim();
      if (trimmed === '') {
        continue;
      }
      secretSet.add(rawCandidate);
      secretSet.add(trimmed);
      if (envName === 'MASSIVE_REST_KEYS' || trimmed.includes(',')) {
        for (const piece of trimmed.split(',')) {
          const clean = piece.trim();
          if (clean !== '') {
            secretSet.add(clean);
          }
        }
      }
    }
  }
  return [...secretSet];
}

export function collectMassiveSecrets(
  env: NodeJS.ProcessEnv = process.env,
  envFilePath: string = resolve(process.cwd(), '.env'),
): readonly string[] {
  return collectMassiveSecretsFromSource(readMassiveEnvSource(env, envFilePath));
}

function readHeaderIgnoreCase(
  headers: Readonly<Record<string, string>> | undefined,
  targetName: string,
): string | null {
  if (headers === undefined) {
    return null;
  }
  const lower = targetName.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      return v;
    }
  }
  return null;
}

function withMassiveAuthUrl(rawUrl: string, apiKey: string): string {
  const parsed = new URL(rawUrl, 'https://api.massive.com');
  for (const paramKey of [...parsed.searchParams.keys()]) {
    if (AUTH_PARAM_NAMES.has(paramKey.toLowerCase())) {
      parsed.searchParams.delete(paramKey);
    }
  }
  const host = parsed.hostname.toLowerCase();
  const paramName = host === 'api.massive.com' || host.endsWith('.massive.com') ? 'apikey' : 'apiKey';
  parsed.searchParams.set(paramName, apiKey);
  return parsed.toString();
}

/**
 * Validación explícita y verificable de routing por dominio sobre rutas REST de Massive.
 * Jamás usa heurísticas ambiguas por nombre de ticker.
 */
export function verifyMassiveEndpointForDomain(url: string, domain: MassiveRestDomain): boolean {
  let pathname: string;
  try {
    const parsed = new URL(url, 'https://api.massive.com');
    pathname = parsed.pathname;
  } catch {
    return false;
  }

  const normalized = pathname.toLowerCase();

  if (domain === 'FUTURES_REST') {
    return (
      normalized.startsWith('/futures/') ||
      normalized === '/futures' ||
      normalized.startsWith('/v1/futures/') ||
      normalized.startsWith('/v2/futures/') ||
      normalized.startsWith('/v3/reference/futures') ||
      normalized.startsWith('/v3/snapshot/futures')
    );
  }

  if (domain === 'OPTIONS_REST') {
    if (normalized.includes('/futures')) {
      return false;
    }
    return (
      normalized.startsWith('/v3/reference/options') ||
      normalized.startsWith('/v3/snapshot/options') ||
      normalized.startsWith('/options/') ||
      normalized.startsWith('/v3/trades/o:') ||
      normalized.startsWith('/v3/quotes/o:') ||
      normalized.startsWith('/v2/aggs/ticker/o:')
    );
  }

  // STOCKS_REST
  if (
    normalized.includes('/futures') ||
    normalized.startsWith('/options/') ||
    normalized.startsWith('/v3/reference/options') ||
    normalized.startsWith('/v3/snapshot/options') ||
    normalized.startsWith('/v3/trades/o:') ||
    normalized.startsWith('/v3/quotes/o:') ||
    normalized.startsWith('/v2/aggs/ticker/o:')
  ) {
    return false;
  }

  return (
    normalized.startsWith('/v2/aggs/') ||
    normalized.startsWith('/v2/snapshot/locale/us/markets/stocks') ||
    normalized.startsWith('/stocks/') ||
    normalized.startsWith('/fed/') ||
    normalized.startsWith('/v3/snapshot') ||
    normalized.startsWith('/v3/reference/dividends') ||
    normalized.startsWith('/v3/reference/tickers') ||
    normalized.startsWith('/v2/reference/news')
  );
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function createAbortError(message = 'Operation aborted'): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function isAbortLikeError(err: unknown, signal?: AbortSignal): boolean {
  if (isSignalAborted(signal)) {
    return true;
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return true;
  }
  return false;
}

/**
 * Router multi-key segregado por dominio con failover HTTP completo, estado de disponibilidad por
 * slot y protección de la cuota de opciones sobre el respaldo compartido `MASSIVE_API_KEY`.
 */
export class MassiveKeyRouter {
  private readonly nowMsFn: () => number;
  private readonly secrets: readonly string[];
  private readonly disabledSet: ReadonlySet<string>;
  private readonly optionsApiKey: string;
  private readonly wsStocksSlot: { readonly key: string; readonly envName: string } | null;
  private readonly wsOptionsSlot: { readonly key: string; readonly envName: 'MASSIVE_API_KEY' } | null;
  private readonly domainPools: Readonly<Record<MassiveRestDomain, DomainPoolState>>;
  private readonly legacySharedEnvIgnored: {
    readonly massiveRestKeyPresent: boolean;
    readonly massiveRestKeysPresent: boolean;
  };
  private readonly hasDedicatedStocksConfigured: boolean;

  private readonly maxAttemptsDefault: number;
  private readonly totalDeadlineMsDefault: number;
  private readonly perAttemptTimeoutMsDefault: number;
  private readonly baseRateLimitCooldownMs: number;
  private readonly maxRateLimitCooldownMs: number;
  private readonly baseTransientCooldownMs: number;
  private readonly maxTransientCooldownMs: number;
  private readonly networkCooldownMs: number;
  private readonly authPenaltyMs: number;
  private readonly optionsPriorityWindowMs: number;
  private readonly maxSharedFallbackCallsPerMinute: number;
  private readonly maxSharedFallbackConcurrency: number;

  private lastOptionsRateLimitAtMs: number | null = null;
  private sharedFallbackInFlight = 0;
  private readonly sharedFallbackCallTimestampsMs: number[] = [];

  public constructor(source: MassiveEnvSource, options: MassiveKeyRouterOptions = {}) {
    this.nowMsFn = options.nowMsFn ?? ((): number => Date.now());
    this.maxAttemptsDefault = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.totalDeadlineMsDefault = Math.max(100, options.totalDeadlineMs ?? DEFAULT_TOTAL_DEADLINE_MS);
    this.perAttemptTimeoutMsDefault = Math.max(50, options.perAttemptTimeoutMs ?? DEFAULT_PER_ATTEMPT_TIMEOUT_MS);
    this.baseRateLimitCooldownMs = Math.max(500, options.baseRateLimitCooldownMs ?? DEFAULT_BASE_RATE_LIMIT_COOLDOWN_MS);
    this.maxRateLimitCooldownMs = Math.max(this.baseRateLimitCooldownMs, options.maxRateLimitCooldownMs ?? DEFAULT_MAX_RATE_LIMIT_COOLDOWN_MS);
    this.baseTransientCooldownMs = Math.max(250, options.baseTransientCooldownMs ?? DEFAULT_BASE_TRANSIENT_COOLDOWN_MS);
    this.maxTransientCooldownMs = Math.max(this.baseTransientCooldownMs, options.maxTransientCooldownMs ?? DEFAULT_MAX_TRANSIENT_COOLDOWN_MS);
    this.networkCooldownMs = Math.max(250, options.networkCooldownMs ?? DEFAULT_NETWORK_COOLDOWN_MS);
    this.authPenaltyMs = Math.max(1_000, options.authPenaltyMs ?? DEFAULT_AUTH_PENALTY_MS);
    this.optionsPriorityWindowMs = Math.max(1_000, options.optionsPriorityWindowMs ?? DEFAULT_OPTIONS_PRIORITY_WINDOW_MS);
    this.maxSharedFallbackCallsPerMinute = Math.max(0, options.maxSharedFallbackCallsPerMinute ?? DEFAULT_SHARED_FALLBACK_MAX_PER_MIN);
    this.maxSharedFallbackConcurrency = Math.max(0, options.maxSharedFallbackConcurrency ?? DEFAULT_SHARED_FALLBACK_MAX_CONCURRENCY);

    const disabledRaw = resolveMassiveEnvValue(source, 'MASSIVE_DISABLED_SLOTS');
    const disabledSet = new Set<string>();
    for (const token of [...(options.disabledSlots ?? []), ...disabledRaw.split(',')]) {
      const clean = token.trim();
      if (clean !== '') {
        disabledSet.add(clean);
      }
    }
    this.disabledSet = disabledSet;

    const secretSet = new Set<string>([
      ...collectMassiveSecretsFromSource(source),
      ...(options.secrets ?? []),
    ]);

    this.optionsApiKey = resolveMassiveEnvValue(source, 'MASSIVE_API_KEY');

    // WS stocks: legacy resolution only; NEVER consumes KEY_1/KEY_3/REST_KEY/REST_KEYS/FUTURES.
    let wsStocksSlot: { readonly key: string; readonly envName: string } | null = null;
    for (const name of WS_STOCKS_ENV_CHAIN) {
      const val = resolveMassiveEnvValue(source, name);
      if (val !== '') {
        wsStocksSlot = { key: val, envName: name };
        break;
      }
    }
    this.wsStocksSlot = wsStocksSlot;
    this.wsOptionsSlot =
      this.optionsApiKey !== '' ? { key: this.optionsApiKey, envName: 'MASSIVE_API_KEY' } : null;

    this.legacySharedEnvIgnored = {
      massiveRestKeyPresent: resolveMassiveEnvValue(source, 'MASSIVE_REST_KEY') !== '',
      massiveRestKeysPresent: resolveMassiveEnvValue(source, 'MASSIVE_REST_KEYS') !== '',
    };

    const isSlotDisabled = (slotId: string, envName: string): boolean =>
      this.disabledSet.has(slotId) || this.disabledSet.has(envName);

    const buildDomainPool = (
      domain: MassiveRestDomain,
      definitions: readonly {
        readonly envName: string;
        readonly slotId: string;
        readonly tier: MassiveSlotTier;
      }[],
    ): DomainPoolState => {
      const seenKeys = new Set<string>();
      const slots: MutableDomainSlotState[] = [];
      for (const def of definitions) {
        const key = resolveMassiveEnvValue(source, def.envName);
        if (key === '') {
          continue;
        }
        secretSet.add(key);
        if (seenKeys.has(key)) {
          // Misma credencial efectiva bajo otro nombre lógico: evitar solicitudes duplicadas.
          continue;
        }
        seenKeys.add(key);
        const disabled = isSlotDisabled(def.slotId, def.envName);
        const sharedWithOptions =
          domain === 'STOCKS_REST' &&
          this.optionsApiKey !== '' &&
          key === this.optionsApiKey;
        slots.push({
          key,
          envName: def.envName,
          slotId: def.slotId,
          tier: def.tier,
          sharedWithOptions,
          slotIndex: slots.length,
          state: disabled ? 'DISABLED' : 'AVAILABLE',
          cooldownUntilMs: null,
          rateLimitHits: 0,
          transientFailures: 0,
          authFailures: 0,
          successCount: 0,
          failureCount: 0,
          lastHttpStatus: null,
          lastRateLimitAtMs: null,
        });
      }
      return {
        domain,
        slots,
        primaryCursor: 0,
        requests: 0,
        inFlightCount: 0,
      };
    };

    const stocksPool = buildDomainPool('STOCKS_REST', [
      { envName: 'MASSIVE_KEY_2', slotId: 'STOCKS_SLOT_2', tier: 'PRIMARY' },
      { envName: 'MASSIVE_KEY_3', slotId: 'STOCKS_SLOT_3', tier: 'PRIMARY' },
      { envName: 'MASSIVE_KEY_1', slotId: 'STOCKS_SLOT_1', tier: 'FALLBACK' },
      { envName: 'MASSIVE_API_KEY', slotId: 'STOCKS_SHARED_OPTIONS_FALLBACK', tier: 'FALLBACK' },
    ]);

    const optionsPool = buildDomainPool('OPTIONS_REST', [
      { envName: 'MASSIVE_API_KEY', slotId: 'OPTIONS_SLOT_1', tier: 'PRIMARY' },
    ]);

    const futuresPool = buildDomainPool('FUTURES_REST', [
      { envName: 'MASSIVE_KEY_FUTURES', slotId: 'FUTURES_SLOT_1', tier: 'PRIMARY' },
    ]);

    this.hasDedicatedStocksConfigured = stocksPool.slots.some(
      (slot) => !slot.sharedWithOptions && slot.state !== 'DISABLED',
    );

    this.domainPools = {
      STOCKS_REST: stocksPool,
      OPTIONS_REST: optionsPool,
      FUTURES_REST: futuresPool,
    };

    this.secrets = [...secretSet];
  }

  public getSecrets(): readonly string[] {
    return this.secrets;
  }

  /** Clave legacy WS de stocks (`MASSIVE_WS_STOCKS_KEY` -> `MASSIVE_API_KEY`). */
  public getStocksWsKey(): MassiveKeySlot {
    const slot = this.wsStocksSlot;
    if (slot === null) {
      return { key: '', envName: '', slotIndex: 0, poolSize: 0, role: 'WS_STOCKS' };
    }
    return {
      key: slot.key,
      envName: slot.envName,
      slotIndex: 0,
      poolSize: 1,
      role: 'WS_STOCKS',
    };
  }

  /** Clave WS de opciones: exclusivamente `MASSIVE_API_KEY`. */
  public getOptionsWsKey(): MassiveKeySlot {
    const slot = this.wsOptionsSlot;
    if (slot === null) {
      return { key: '', envName: '', slotIndex: 0, poolSize: 0, role: 'WS_OPTIONS' };
    }
    return {
      key: slot.key,
      envName: slot.envName,
      slotIndex: 0,
      poolSize: 1,
      role: 'WS_OPTIONS',
    };
  }

  public isDomainConfigured(domain: MassiveRestDomain): boolean {
    return this.domainPools[domain].slots.some((slot) => slot.state !== 'DISABLED');
  }

  /**
   * Siguiente credencial elegible del dominio (`STOCKS_REST` por defecto para compatibilidad).
   * Nota: en ejecución HTTP preferir `executeRest` / `createDomainFetchFn` para failover automático.
   */
  public getRestKey(domain: MassiveRestDomain = 'STOCKS_REST'): MassiveKeySlot {
    const selection = this.selectNextSlot(domain, new Set<string>());
    if (selection.slot === null) {
      return { key: '', envName: '', slotIndex: 0, poolSize: 0, role: 'REST', domain };
    }
    const pool = this.domainPools[domain];
    return {
      key: selection.slot.key,
      envName: selection.slot.envName,
      slotIndex: selection.slot.slotIndex,
      poolSize: pool.slots.length,
      role: 'REST',
      slotId: selection.slot.slotId,
      domain,
      tier: selection.slot.tier,
      sharedWithOptions: selection.slot.sharedWithOptions,
    };
  }

  public getStocksRestKey(): MassiveKeySlot {
    return this.getRestKey('STOCKS_REST');
  }

  public getOptionsRestKey(): MassiveKeySlot {
    return this.getRestKey('OPTIONS_REST');
  }

  public getFuturesRestKey(): MassiveKeySlot {
    return this.getRestKey('FUTURES_REST');
  }

  /** Ejecuta una petición REST Massive con routing por dominio, failover, deadline y `AbortSignal`. */
  public async executeRest(options: MassiveRestExecutionOptions): Promise<FetchResponse> {
    const { domain, url, fetchFn, signal } = options;

    if (isSignalAborted(signal)) {
      throw createAbortError('Request aborted before dispatch');
    }

    if (!verifyMassiveEndpointForDomain(url, domain)) {
      throw new MassivePoolExhaustedError({
        domain,
        reason: 'DOMAIN_ENDPOINT_MISMATCH',
        lastHttpStatus: null,
        attempts: [],
        message: redactSecrets(
          `Endpoint path is outside authorized domain ${domain}`,
          this.secrets,
        ),
      });
    }

    const pool = this.domainPools[domain];
    const enabledSlots = pool.slots.filter((s) => s.state !== 'DISABLED');
    if (enabledSlots.length === 0) {
      throw new MassivePoolExhaustedError({
        domain,
        reason: 'POOL_UNCONFIGURED',
        lastHttpStatus: null,
        attempts: [],
        message: `${domain} pool is unconfigured (0 active slots)`,
      });
    }

    const startedAtMs = this.nowMsFn();
    const totalDeadlineMs = Math.max(50, options.totalDeadlineMs ?? this.totalDeadlineMsDefault);
    const deadlineAtMs = startedAtMs + totalDeadlineMs;
    const perAttemptTimeoutMs = Math.max(
      25,
      options.perAttemptTimeoutMs ?? this.perAttemptTimeoutMsDefault,
    );
    const maxAttempts = Math.min(
      Math.max(1, options.maxAttempts ?? this.maxAttemptsDefault),
      enabledSlots.length,
    );

    const attemptedKeys = new Set<string>();
    const attempts: MassiveAttemptDiagnostic[] = [];
    let lastHttpStatus: number | null = null;
    let sawSharedGuardBlock = false;
    let sawDeadlineExceeded = false;

    while (attempts.length < maxAttempts) {
      if (isSignalAborted(signal)) {
        throw createAbortError('Request aborted');
      }

      const nowMs = this.nowMsFn();
      const remainingDeadlineMs = deadlineAtMs - nowMs;
      if (remainingDeadlineMs <= 0) {
        sawDeadlineExceeded = true;
        break;
      }

      const selection = this.selectNextSlot(domain, attemptedKeys);
      if (selection.blockedBySharedOptionsGuard) {
        sawSharedGuardBlock = true;
      }
      const slot = selection.slot;
      if (slot === null) {
        break;
      }

      attemptedKeys.add(slot.key);
      const attemptStartMs = this.nowMsFn();
      const authedUrl = withMassiveAuthUrl(url, slot.key);
      const attemptBudgetMs = Math.min(perAttemptTimeoutMs, Math.max(1, deadlineAtMs - attemptStartMs));

      pool.inFlightCount += 1;
      const countedShared = domain === 'STOCKS_REST' && slot.sharedWithOptions;
      if (countedShared) {
        this.sharedFallbackInFlight += 1;
        this.sharedFallbackCallTimestampsMs.push(attemptStartMs);
      }

      try {
        const outcome = await this.invokeAttemptWithGuards(
          authedUrl,
          fetchFn,
          attemptBudgetMs,
          signal,
        );

        const durationMs = Math.max(0, this.nowMsFn() - attemptStartMs);

        if (outcome.kind === 'aborted') {
          attempts.push({
            slotId: slot.slotId,
            envName: slot.envName,
            tier: slot.tier,
            outcome: 'ABORTED',
            httpStatus: null,
            durationMs,
          });
          throw createAbortError('Request aborted');
        }

        if (outcome.kind === 'timeout_or_error') {
          this.markSlotNetworkFailure(slot);
          attempts.push({
            slotId: slot.slotId,
            envName: slot.envName,
            tier: slot.tier,
            outcome: 'TIMEOUT_OR_NETWORK',
            httpStatus: null,
            durationMs,
          });
          if (outcome.reason === 'deadline_or_timeout' && this.nowMsFn() >= deadlineAtMs) {
            sawDeadlineExceeded = true;
            break;
          }
          continue;
        }

        const resp = outcome.response;
        lastHttpStatus = resp.status;
        const safeText = resp.ok ? resp.text : redactSecrets(resp.text, this.secrets);
        const safeHeaders =
          resp.headers !== undefined
            ? redactHeaders(resp.headers, this.secrets)
            : undefined;
        const safeResponse: FetchResponse = {
          ...resp,
          text: safeText,
          ...(safeHeaders !== undefined ? { headers: safeHeaders } : {}),
        };

        if (resp.ok) {
          this.markSlotSuccess(slot, resp.status);
          attempts.push({
            slotId: slot.slotId,
            envName: slot.envName,
            tier: slot.tier,
            outcome: 'SUCCESS_2XX',
            httpStatus: resp.status,
            durationMs,
          });
          return safeResponse;
        }

        if (resp.status === 429) {
          const evalNowMs = this.nowMsFn();
          const headerRetryAfter = readHeaderIgnoreCase(resp.headers, 'retry-after');
          const parsedRetryAfterSec =
            resp.retryAfterSeconds !== undefined &&
            resp.retryAfterSeconds !== null &&
            Number.isFinite(resp.retryAfterSeconds) &&
            resp.retryAfterSeconds > 0
              ? resp.retryAfterSeconds
              : parseRetryAfterSeconds(headerRetryAfter, evalNowMs);
          this.markSlotRateLimited(domain, slot, parsedRetryAfterSec);
          attempts.push({
            slotId: slot.slotId,
            envName: slot.envName,
            tier: slot.tier,
            outcome: 'HTTP_429',
            httpStatus: 429,
            durationMs,
          });
          continue;
        }

        if (resp.status === 401 || resp.status === 403) {
          this.markSlotAuthPenalized(slot, resp.status);
          attempts.push({
            slotId: slot.slotId,
            envName: slot.envName,
            tier: slot.tier,
            outcome: 'HTTP_403_AUTH',
            httpStatus: resp.status,
            durationMs,
          });
          continue;
        }

        if (resp.status === 408 || resp.status >= 500) {
          this.markSlotTransientFailure(slot, resp.status);
          attempts.push({
            slotId: slot.slotId,
            envName: slot.envName,
            tier: slot.tier,
            outcome: 'HTTP_5XX',
            httpStatus: resp.status,
            durationMs,
          });
          continue;
        }

        // Otros 4xx (ej. 400, 404, 422): request inválido/no encontrado -> no penalizar ni rotar.
        attempts.push({
          slotId: slot.slotId,
          envName: slot.envName,
          tier: slot.tier,
          outcome: 'CLIENT_ERROR_NON_RETRYABLE',
          httpStatus: resp.status,
          durationMs,
        });
        return safeResponse;
      } finally {
        pool.inFlightCount = Math.max(0, pool.inFlightCount - 1);
        if (countedShared) {
          this.sharedFallbackInFlight = Math.max(0, this.sharedFallbackInFlight - 1);
        }
      }
    }

    const reason: MassivePoolExhaustedReason = sawDeadlineExceeded
      ? 'OPERATION_DEADLINE_EXCEEDED'
      : sawSharedGuardBlock
        ? 'SHARED_FALLBACK_RESERVED_FOR_OPTIONS'
        : 'ALL_SLOTS_UNAVAILABLE';

    const traceSummary =
      attempts.length > 0
        ? attempts.map((a) => `${a.slotId}:${a.outcome}(${String(a.httpStatus ?? 'err')})`).join(', ')
        : reason;

    throw new MassivePoolExhaustedError({
      domain,
      reason,
      lastHttpStatus,
      attempts,
      message: redactSecrets(
        `${domain} pool exhausted [${reason}] (${traceSummary})`,
        this.secrets,
      ),
    });
  }

  /** Adaptador compatible con `FetchFn` fijado a un dominio REST específico. */
  public createDomainFetchFn(
    domain: MassiveRestDomain,
    baseFetchFn: FetchFn,
    defaults: Omit<MassiveRestExecutionOptions, 'domain' | 'url' | 'fetchFn'> = {},
  ): FetchFn {
    return (url: string): Promise<FetchResponse> =>
      this.executeRest({
        domain,
        url,
        fetchFn: baseFetchFn,
        ...defaults,
      });
  }

  /** Estado seguro para HTTP/telemetría (cero valores, prefijos ni sufijos de claves). */
  public status(): MassiveKeyPoolStatus {
    const nowMs = this.nowMsFn();
    this.expireCooldowns(nowMs);
    this.pruneSharedFallbackWindow(nowMs);

    const buildDomainStatus = (domain: MassiveRestDomain): MassiveDomainPoolStatus => {
      const pool = this.domainPools[domain];
      const slotStatuses: MassiveKeySlotStatus[] = pool.slots.map((slot) => ({
        envName: slot.envName,
        slotIndex: slot.slotIndex,
        role: 'REST' as const,
        slotId: slot.slotId,
        domain,
        tier: slot.tier,
        state: slot.state,
        sharedWithOptions: slot.sharedWithOptions,
        cooldownUntilMs: slot.cooldownUntilMs,
        successCount: slot.successCount,
        failureCount: slot.failureCount,
        lastHttpStatus: slot.lastHttpStatus,
      }));
      const activeCount = pool.slots.filter((s) => s.state !== 'DISABLED').length;
      const primaryCount = pool.slots.filter((s) => s.tier === 'PRIMARY' && s.state !== 'DISABLED').length;
      const fallbackCount = pool.slots.filter((s) => s.tier === 'FALLBACK' && s.state !== 'DISABLED').length;
      const lastIdx =
        pool.requests > 0 && pool.slots.length > 0
          ? (pool.requests - 1) % pool.slots.length
          : null;
      return {
        domain,
        configured: activeCount > 0,
        poolSize: pool.slots.length,
        activeSlotCount: activeCount,
        primarySlotCount: primaryCount,
        fallbackSlotCount: fallbackCount,
        slots: slotStatuses,
        lastSlotIndex: lastIdx,
        roundRobinRequests: pool.requests,
        inFlightCount: pool.inFlightCount,
      };
    };

    const stocksStatus = buildDomainStatus('STOCKS_REST');
    const optionsStatus = buildDomainStatus('OPTIONS_REST');
    const futuresStatus = buildDomainStatus('FUTURES_REST');

    const anyConfigured =
      this.wsStocksSlot !== null ||
      this.wsOptionsSlot !== null ||
      stocksStatus.configured ||
      optionsStatus.configured ||
      futuresStatus.configured;

    return {
      configured: anyConfigured,
      wsStocks: {
        configured: this.wsStocksSlot !== null,
        envName: this.wsStocksSlot?.envName ?? null,
        policyState: 'STANDBY_TRADIER_FMP_PRIMARY',
        futureCandidateEnv: MASSIVE_WS_STOCKS_FUTURE_CANDIDATE_ENV,
        excludedEnvs: [...MASSIVE_WS_EXCLUDED_KEY_ENVS],
      },
      wsOptions: {
        configured: this.wsOptionsSlot !== null,
        envName: this.wsOptionsSlot?.envName ?? null,
      },
      wsFutures: {
        policyState: 'CLOSED_DISABLED',
      },
      rest: {
        configured: stocksStatus.configured,
        poolSize: stocksStatus.poolSize,
        slots: stocksStatus.slots,
        lastSlotIndex: stocksStatus.lastSlotIndex,
        roundRobinRequests: stocksStatus.roundRobinRequests,
      },
      domains: {
        STOCKS_REST: stocksStatus,
        OPTIONS_REST: optionsStatus,
        FUTURES_REST: futuresStatus,
      },
      legacySharedEnvIgnored: { ...this.legacySharedEnvIgnored },
      sharedOptionsQuotaGuard: {
        lastOptionsRateLimitAtMs: this.lastOptionsRateLimitAtMs,
        sharedFallbackInFlight: this.sharedFallbackInFlight,
        sharedFallbackRecentCalls: this.sharedFallbackCallTimestampsMs.length,
      },
    };
  }

  private expireCooldowns(nowMs: number): void {
    for (const pool of Object.values(this.domainPools)) {
      for (const slot of pool.slots) {
        if (slot.state === 'DISABLED' || slot.state === 'AVAILABLE') {
          continue;
        }
        if (slot.cooldownUntilMs !== null && nowMs >= slot.cooldownUntilMs) {
          slot.state = 'AVAILABLE';
          slot.cooldownUntilMs = null;
          slot.rateLimitHits = Math.max(0, Math.floor(slot.rateLimitHits / 2));
          slot.transientFailures = Math.max(0, Math.floor(slot.transientFailures / 2));
          slot.authFailures = Math.max(0, Math.floor(slot.authFailures / 2));
        }
      }
    }
  }

  private pruneSharedFallbackWindow(nowMs: number): void {
    const cutoff = nowMs - 60_000;
    while (
      this.sharedFallbackCallTimestampsMs.length > 0 &&
      (this.sharedFallbackCallTimestampsMs[0] ?? 0) <= cutoff
    ) {
      this.sharedFallbackCallTimestampsMs.shift();
    }
  }

  private canStocksUseSharedOptionsFallback(nowMs: number): boolean {
    const optionsPool = this.domainPools.OPTIONS_REST;
    const optionsSlot = optionsPool.slots[0];
    if (optionsSlot !== undefined) {
      if (
        optionsSlot.state === 'COOLDOWN_429' ||
        optionsSlot.state === 'COOLDOWN_5XX' ||
        optionsSlot.state === 'COOLDOWN_NETWORK'
      ) {
        return false;
      }
      if (
        this.lastOptionsRateLimitAtMs !== null &&
        nowMs - this.lastOptionsRateLimitAtMs < this.optionsPriorityWindowMs
      ) {
        return false;
      }
    }

    if (!this.hasDedicatedStocksConfigured) {
      return true;
    }

    this.pruneSharedFallbackWindow(nowMs);
    if (optionsPool.inFlightCount > 0 && this.sharedFallbackInFlight > 0) {
      return false;
    }
    if (this.sharedFallbackInFlight >= this.maxSharedFallbackConcurrency) {
      return false;
    }
    if (this.sharedFallbackCallTimestampsMs.length >= this.maxSharedFallbackCallsPerMinute) {
      return false;
    }
    return true;
  }

  private selectNextSlot(
    domain: MassiveRestDomain,
    attemptedKeys: ReadonlySet<string>,
  ): {
    readonly slot: MutableDomainSlotState | null;
    readonly blockedBySharedOptionsGuard: boolean;
  } {
    const nowMs = this.nowMsFn();
    this.expireCooldowns(nowMs);

    const pool = this.domainPools[domain];
    let blockedBySharedOptionsGuard = false;

    const isEligible = (slot: MutableDomainSlotState): boolean => {
      if (slot.state !== 'AVAILABLE') {
        return false;
      }
      if (attemptedKeys.has(slot.key)) {
        return false;
      }
      if (domain === 'STOCKS_REST' && slot.sharedWithOptions) {
        if (!this.canStocksUseSharedOptionsFallback(nowMs)) {
          blockedBySharedOptionsGuard = true;
          return false;
        }
      }
      return true;
    };

    const primaries = pool.slots.filter((s) => s.tier === 'PRIMARY');
    if (primaries.length > 0) {
      const start = pool.primaryCursor % primaries.length;
      for (let offset = 0; offset < primaries.length; offset += 1) {
        const candidate = primaries[(start + offset) % primaries.length];
        if (candidate !== undefined && isEligible(candidate)) {
          pool.primaryCursor = (start + offset + 1) % primaries.length;
          pool.requests += 1;
          return { slot: candidate, blockedBySharedOptionsGuard };
        }
      }
    }

    // Respaldos en orden estricto (solo si no hubo primarios elegibles).
    const fallbacks = pool.slots.filter((s) => s.tier === 'FALLBACK');
    for (const candidate of fallbacks) {
      if (isEligible(candidate)) {
        pool.requests += 1;
        return { slot: candidate, blockedBySharedOptionsGuard };
      }
    }

    return { slot: null, blockedBySharedOptionsGuard };
  }

  private markSlotSuccess(slot: MutableDomainSlotState, httpStatus: number): void {
    slot.state = 'AVAILABLE';
    slot.cooldownUntilMs = null;
    slot.rateLimitHits = 0;
    slot.transientFailures = 0;
    slot.authFailures = 0;
    slot.successCount += 1;
    slot.lastHttpStatus = httpStatus;
  }

  private markSlotRateLimited(
    domain: MassiveRestDomain,
    slot: MutableDomainSlotState,
    retryAfterSeconds: number | null,
  ): void {
    const nowMs = this.nowMsFn();
    slot.rateLimitHits += 1;
    slot.failureCount += 1;
    slot.lastHttpStatus = 429;
    slot.lastRateLimitAtMs = nowMs;
    if (domain === 'OPTIONS_REST') {
      this.lastOptionsRateLimitAtMs = nowMs;
    }

    const backoffMs = Math.min(
      this.maxRateLimitCooldownMs,
      this.baseRateLimitCooldownMs * 2 ** Math.min(slot.rateLimitHits - 1, 10),
    );
    const retryAfterMs =
      retryAfterSeconds !== null && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? Math.min(this.maxRateLimitCooldownMs, Math.max(1_000, Math.round(retryAfterSeconds * 1_000)))
        : 0;
    const waitMs = retryAfterMs > 0 ? retryAfterMs : backoffMs;

    slot.state = 'COOLDOWN_429';
    slot.cooldownUntilMs = nowMs + waitMs;
  }

  private markSlotTransientFailure(slot: MutableDomainSlotState, httpStatus: number): void {
    const nowMs = this.nowMsFn();
    slot.transientFailures += 1;
    slot.failureCount += 1;
    slot.lastHttpStatus = httpStatus;
    const waitMs = Math.min(
      this.maxTransientCooldownMs,
      this.baseTransientCooldownMs * 2 ** Math.min(slot.transientFailures - 1, 10),
    );
    slot.state = httpStatus === 408 ? 'COOLDOWN_NETWORK' : 'COOLDOWN_5XX';
    slot.cooldownUntilMs = nowMs + waitMs;
  }

  private markSlotNetworkFailure(slot: MutableDomainSlotState): void {
    const nowMs = this.nowMsFn();
    slot.transientFailures += 1;
    slot.failureCount += 1;
    const waitMs = Math.min(
      this.maxTransientCooldownMs,
      this.networkCooldownMs * 2 ** Math.min(slot.transientFailures - 1, 10),
    );
    slot.state = 'COOLDOWN_NETWORK';
    slot.cooldownUntilMs = nowMs + waitMs;
  }

  private markSlotAuthPenalized(slot: MutableDomainSlotState, httpStatus: number): void {
    const nowMs = this.nowMsFn();
    slot.authFailures += 1;
    slot.failureCount += 1;
    slot.lastHttpStatus = httpStatus;
    slot.state = 'PENALIZED_AUTH';
    slot.cooldownUntilMs = nowMs + this.authPenaltyMs;
  }

  private async invokeAttemptWithGuards(
    authedUrl: string,
    fetchFn: FetchFn,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<
    | { readonly kind: 'response'; readonly response: FetchResponse }
    | { readonly kind: 'timeout_or_error'; readonly reason: 'deadline_or_timeout' | 'network'; readonly message: string }
    | { readonly kind: 'aborted' }
  > {
    if (isSignalAborted(signal)) {
      return { kind: 'aborted' };
    }

    const cleanupFns: (() => void)[] = [];

    const racePromises: Promise<
      | { readonly kind: 'response'; readonly response: FetchResponse }
      | { readonly kind: 'timeout_or_error'; readonly reason: 'deadline_or_timeout' | 'network'; readonly message: string }
      | { readonly kind: 'aborted' }
    >[] = [];

    const fetchPromise = (async () => {
      try {
        const response = await fetchFn(authedUrl);
        return { kind: 'response' as const, response };
      } catch (err: unknown) {
        if (isAbortLikeError(err, signal)) {
          return { kind: 'aborted' as const };
        }
        return {
          kind: 'timeout_or_error' as const,
          reason: 'network' as const,
          message: formatRedactedError(err, this.secrets, 'network_error'),
        };
      }
    })();
    racePromises.push(fetchPromise);

    const timeoutPromise = new Promise<{
      readonly kind: 'timeout_or_error';
      readonly reason: 'deadline_or_timeout';
      readonly message: string;
    }>((resolveTimeout) => {
      const handle = setTimeout(() => {
        resolveTimeout({
          kind: 'timeout_or_error',
          reason: 'deadline_or_timeout',
          message: 'attempt_timeout',
        });
      }, timeoutMs);
      if (typeof handle.unref === 'function') {
        handle.unref();
      }
      cleanupFns.push(() => {
        clearTimeout(handle);
      });
    });
    racePromises.push(timeoutPromise);

    if (signal !== undefined) {
      const abortPromise = new Promise<{ readonly kind: 'aborted' }>((resolveAbort) => {
        const handleAbort = (): void => {
          resolveAbort({ kind: 'aborted' });
        };
        signal.addEventListener('abort', handleAbort, { once: true });
        cleanupFns.push(() => {
          signal.removeEventListener('abort', handleAbort);
        });
      });
      racePromises.push(abortPromise);
    }

    try {
      return await Promise.race(racePromises);
    } finally {
      for (const cleanup of cleanupFns) {
        cleanup();
      }
    }
  }
}

let defaultRouter: MassiveKeyRouter | null = null;

/** Router memoizado con el entorno del proceso (o el provisto explícitamente). */
export function getMassiveKeyRouter(
  env?: NodeJS.ProcessEnv,
  envFilePath?: string,
  options?: MassiveKeyRouterOptions,
): MassiveKeyRouter {
  if (env !== undefined || envFilePath !== undefined || options !== undefined) {
    return new MassiveKeyRouter(readMassiveEnvSource(env, envFilePath), options);
  }
  if (defaultRouter === null) {
    defaultRouter = new MassiveKeyRouter(readMassiveEnvSource());
  }
  return defaultRouter;
}

/** Fuerza la re-resolución del router por defecto (harness/tests explícitos). */
export function resetMassiveKeyRouter(): void {
  defaultRouter = null;
}

/** Clave del socket de stocks (cadena legacy documentada). */
export function getMassiveStocksWsKey(
  env?: NodeJS.ProcessEnv,
  envFilePath?: string,
): MassiveKeySlot {
  return getMassiveKeyRouter(env, envFilePath).getStocksWsKey();
}

/** Clave REST siguiente del dominio pedido (`STOCKS_REST` por defecto). */
export function getMassiveRestKey(
  env?: NodeJS.ProcessEnv,
  envFilePath?: string,
  domain: MassiveRestDomain = 'STOCKS_REST',
): MassiveKeySlot {
  return getMassiveKeyRouter(env, envFilePath).getRestKey(domain);
}

/** Estado del pool seguro para exponer (sin claves). */
export function getMassiveKeyPoolStatus(
  env?: NodeJS.ProcessEnv,
  envFilePath?: string,
): MassiveKeyPoolStatus {
  return getMassiveKeyRouter(env, envFilePath).status();
}
