/**
 * Cache single-flight con TTL dinámico en hora ET (`America/New_York`) y
 * sanitización estricta de secretos para el runtime local de QuantOptionsTerminal.
 */

import { getMarketParts, MAX_TIME_SECONDS } from '../core/sessions.js';
import { redact } from '../data/normalizeShared.js';

/** 8 s durante power hour (14:30 – 16:00 ET, días hábiles). */
export const POWER_HOUR_TTL_MS = 8_000;
/** 10 s durante horario regular principal (09:30 – 14:30 ET, días hábiles). */
export const RTH_TTL_MS = 10_000;
/** 30 s fuera de RTH (pre-market, after-hours, noche y fines de semana). */
export const OFF_HOURS_TTL_MS = 30_000;

const RTH_START_MIN = 9 * 60 + 30;
const POWER_HOUR_START_MIN = 14 * 60 + 30;
const RTH_END_MIN = 16 * 60;

/**
 * Calcula el TTL dinámico en milisegundos según la sesión ET actual:
 *  - Lun–Vie `14:30 <= ET < 16:00`: `8_000 ms`
 *  - Lun–Vie `09:30 <= ET < 14:30`: `10_000 ms`
 *  - Resto de horas / fines de semana: `30_000 ms`
 */
export function computeDynamicTtlMs(nowMs: number = Date.now()): number {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new Error(`Invalid nowMs timestamp: ${String(nowMs)}`);
  }
  const nowSec = Math.floor(nowMs / 1_000);
  if (nowSec > MAX_TIME_SECONDS) {
    throw new Error(`nowMs exceeds MAX_TIME_SECONDS: ${String(nowMs)}`);
  }

  const parts = getMarketParts(nowSec, 'EQUITY');
  const isWeekday = parts.weekday >= 1 && parts.weekday <= 5;
  if (!isWeekday) {
    return OFF_HOURS_TTL_MS;
  }

  if (parts.minutesOfDay >= POWER_HOUR_START_MIN && parts.minutesOfDay < RTH_END_MIN) {
    return POWER_HOUR_TTL_MS;
  }
  if (parts.minutesOfDay >= RTH_START_MIN && parts.minutesOfDay < POWER_HOUR_START_MIN) {
    return RTH_TTL_MS;
  }
  return OFF_HOURS_TTL_MS;
}

function expandSecretVariants(secrets: readonly string[]): readonly string[] {
  const unique = new Set<string>();
  for (const raw of secrets) {
    if (typeof raw !== 'string') {
      continue;
    }
    const trimmed = raw.trim();
    for (const candidate of [raw, trimmed, encodeURIComponent(raw), encodeURIComponent(trimmed)]) {
      if (candidate.length > 0) {
        unique.add(candidate);
      }
    }
  }
  return [...unique];
}

/**
 * Redacta cualquier secreto conocido (`apiKey` y su versión URL-encoded) y parámetros
 * de consulta sensibles (`?apiKey=...`, `&token=...`, `secret=...`) en textos y errores.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  const expanded = expandSecretVariants(secrets);
  return redact(text, expanded)
    .replace(/([?&](?:api_?key|token|secret)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]');
}

export interface CacheEntry<T> {
  readonly value: T;
  readonly fetchedAtMs: number;
  readonly expiresAtMs: number;
  readonly ttlMs: number;
}

export interface CacheLookupResult<T> {
  readonly value: T;
  readonly cacheHit: boolean;
  readonly sharedInFlight: boolean;
  readonly fetchedAtMs: number;
  readonly expiresAtMs: number;
  readonly ttlMs: number;
}

export interface SingleFlightRuntimeCacheOptions {
  readonly nowFn?: () => number;
  readonly ttlResolver?: (nowMs: number) => number;
  /**
   * Máximo de entradas residentes (LRU de inserción). Por defecto `Infinity`
   * (comportamiento histórico sin límite). Al superarlo se desalojan las
   * entradas más antiguas en orden de inserción.
   */
  readonly maxEntries?: number;
}

export interface CacheLookupOptions {
  readonly forceRefresh?: boolean;
  readonly ttlMs?: number;
}

export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly coalesced: number;
  readonly inFlightCount: number;
  readonly entryCount: number;
}

interface InternalFlight<T> {
  readonly promise: Promise<CacheEntry<T>>;
}

/**
 * Caché en memoria por clave con deduplicación single-flight de promesas concurrentes.
 * Los errores nunca se cachean: si un loader falla, se elimina el flight activo para
 * que la siguiente petición pueda reintentar limpiamente.
 */
export class SingleFlightRuntimeCache<T> {
  private readonly nowFn: () => number;
  private readonly ttlResolver: (nowMs: number) => number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly inFlight = new Map<string, InternalFlight<T>>();
  private hitsCount = 0;
  private missesCount = 0;
  private coalescedCount = 0;

  public constructor(options: SingleFlightRuntimeCacheOptions = {}) {
    this.nowFn = options.nowFn ?? ((): number => Date.now());
    this.ttlResolver = options.ttlResolver ?? computeDynamicTtlMs;
    this.maxEntries =
      options.maxEntries !== undefined &&
      Number.isFinite(options.maxEntries) &&
      options.maxEntries >= 1
        ? Math.trunc(options.maxEntries)
        : Number.POSITIVE_INFINITY;
  }

  private storeEntry(key: string, entry: CacheEntry<T>): void {
    this.entries.set(key, entry);
    if (Number.isFinite(this.maxEntries)) {
      while (this.entries.size > this.maxEntries) {
        const oldestKey = this.entries.keys().next().value;
        if (oldestKey === undefined) break;
        this.entries.delete(oldestKey);
      }
    }
  }

  public async getOrCompute(
    key: string,
    loader: () => Promise<T>,
    options: CacheLookupOptions = {},
  ): Promise<CacheLookupResult<T>> {
    const forceRefresh = options.forceRefresh ?? false;
    const nowMs = this.nowFn();

    if (!forceRefresh) {
      const cached = this.entries.get(key);
      if (cached !== undefined && nowMs < cached.expiresAtMs) {
        this.hitsCount += 1;
        return {
          value: cached.value,
          cacheHit: true,
          sharedInFlight: false,
          fetchedAtMs: cached.fetchedAtMs,
          expiresAtMs: cached.expiresAtMs,
          ttlMs: cached.ttlMs,
        };
      }
    }

    const activeFlight = this.inFlight.get(key);
    if (activeFlight !== undefined) {
      this.coalescedCount += 1;
      const entry = await activeFlight.promise;
      return {
        value: entry.value,
        cacheHit: false,
        sharedInFlight: true,
        fetchedAtMs: entry.fetchedAtMs,
        expiresAtMs: entry.expiresAtMs,
        ttlMs: entry.ttlMs,
      };
    }

    this.missesCount += 1;

    const flightPromise: Promise<CacheEntry<T>> = (async (): Promise<CacheEntry<T>> => {
      const value = await loader();
      const completedAtMs = this.nowFn();
      const rawTtl = options.ttlMs ?? this.ttlResolver(completedAtMs);
      const ttlMs = Number.isFinite(rawTtl) && rawTtl >= 0 ? rawTtl : OFF_HOURS_TTL_MS;
      const entry: CacheEntry<T> = {
        value,
        fetchedAtMs: completedAtMs,
        expiresAtMs: completedAtMs + ttlMs,
        ttlMs,
      };
      this.storeEntry(key, entry);
      return entry;
    })();

    const flight: InternalFlight<T> = { promise: flightPromise };
    this.inFlight.set(key, flight);

    try {
      const entry = await flightPromise;
      return {
        value: entry.value,
        cacheHit: false,
        sharedInFlight: false,
        fetchedAtMs: entry.fetchedAtMs,
        expiresAtMs: entry.expiresAtMs,
        ttlMs: entry.ttlMs,
      };
    } finally {
      if (this.inFlight.get(key) === flight) {
        this.inFlight.delete(key);
      }
    }
  }

  public peek(key: string): CacheEntry<T> | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (this.nowFn() >= entry.expiresAtMs) {
      return undefined;
    }
    return entry;
  }

  public invalidate(key: string): boolean {
    return this.entries.delete(key);
  }

  public clear(): void {
    this.entries.clear();
  }

  public stats(): CacheStats {
    return {
      hits: this.hitsCount,
      misses: this.missesCount,
      coalesced: this.coalescedCount,
      inFlightCount: this.inFlight.size,
      entryCount: this.entries.size,
    };
  }
}
