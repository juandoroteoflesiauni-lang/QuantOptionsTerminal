/**
 * Decoupled ORATS hybrid options surface client (Pieza 28).
 *
 * Strictly decouples US ADR spot/OHLC bars (sourced from Massive NBBO/bars +
 * Yang-Zhang realized vol estimator) from ORATS options surface analytics
 * using exact ORATS field names:
 * `smvVol`, `callValue`, `putValue`, `annIdiv`, `impliedNextDiv`, `borrow30`,
 * `yieldRate`, `impliedMove`, `iv10d`..`iv1y`, `exErnIv*`, `fwd30_20`, `fwd60_30`, `fwd90_60`.
 *
 * Zero Silent Fallbacks: when `ORATS_API_KEY` is absent or requests fail, returns
 * explicit `UNAVAILABLE` payload with secret redaction.
 */

import './envBootstrap.js';

import type {
  OratsHybridSurfaceOperational,
  OratsHybridSurfacePayload,
  OratsSurfaceStrikeRow,
} from '../core/ggal/institutionalContracts.js';

export type { OratsHybridSurfacePayload };
import {
  RollingFeedTelemetry,
  type FeedTelemetrySnapshot,
} from './feedsHealthMonitor.js';
import {
  aggregateOratsGlobalHealth, createEndpointHealth, evaluateEndpointCircuitBeforeCall, extractStrictOratsRows,
  parseOratsTradeDate, parseOratsUpdatedAtUtcSec, recordEndpointOutcome, type EndpointOutcome, type OratsEndpoint,
  type OratsEndpointHealth, type OratsEndpoints, type OratsError, type OratsMetadata,
} from '../core/oratsIntegrity.js';
import {
  normalizeOratsSignedRateToDecimal,
  normalizeOratsVolToDecimal,
} from '../core/options/zeroDteFixes.js';

export { normalizeOratsSignedRateToDecimal, normalizeOratsVolToDecimal };

export type OratsHttpFn = (
  url: string,
  init?: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
  readonly text: () => Promise<string>;
}>;

export interface OratsHybridClientDeps {
  readonly apiKey: string | null;
  readonly baseUrl: string;
  readonly fetchFn: OratsHttpFn;
  readonly nowMsFn: () => number;
  readonly cacheTtlMs: number;
  readonly secrets: readonly string[];
}

export interface FetchOratsHybridInput {
  readonly ticker: string;
  readonly massiveSpotPrice: number | null;
  readonly massiveSpotSourceMode: 'MASSIVE_NBBO' | 'MASSIVE_BARS' | 'UNAVAILABLE';
  readonly yangZhangAdrVol: number;
  readonly forceRefresh: boolean;
}

const DEFAULT_ORATS_BASE_URL = 'https://api.orats.io/datav2';
const DEFAULT_ORATS_CACHE_TTL_MS = 30_000;
async function defaultOratsFetch(
  url: string,
  init?: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
  },
): Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
  readonly text: () => Promise<string>;
}> {
  const controller = new AbortController();
  const timeoutMs = init?.timeoutMs ?? 10_000;
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const reqInit: RequestInit = {
      method: init?.method ?? 'GET',
      signal: controller.signal,
    };
    if (init?.headers !== undefined) {
      reqInit.headers = init.headers;
    }
    const resp = await fetch(url, reqInit);
    const body = resp.ok ? await resp.text() : null;
    return {
      ok: resp.ok,
      status: resp.status,
      json: () => Promise.resolve(JSON.parse(body ?? '') as unknown),
      text: () => Promise.resolve(body ?? ''),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Pieza 46.1/50.3: volatilidades ORATS siempre en decimal (0.3582 = 35.82 %), nunca en % (evita 3.582 %). */
function readVol(row: Record<string, unknown>, key: string): number {
  return normalizeOratsVolToDecimal(readNum(row, key));
}

function readNum(row: Record<string, unknown>, key: string): number {
  const v = row[key];
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === 'string' && v.trim().length > 0) {
    const parsed = Number(v);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Number.NaN;
}

function readStr(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === 'string' ? v.trim() : '';
}

export function loadOratsClientConfigFromEnv(env: NodeJS.ProcessEnv): {
  readonly apiKey: string | null;
  readonly baseUrl: string;
} {
  const key = env['ORATS_API_KEY']?.trim() ?? null;
  const baseUrlRaw = env['ORATS_BASE_URL']?.trim();
  const baseUrl =
    baseUrlRaw !== undefined && baseUrlRaw.length > 0
      ? baseUrlRaw.replace(/\/+$/, '')
      : DEFAULT_ORATS_BASE_URL;
  return {
    apiKey: key !== null && key.length > 0 ? key : null,
    baseUrl,
  };
}

export function parseOratsStrikeRow(row: Record<string, unknown>): OratsSurfaceStrikeRow | null {
  const strike = readNum(row, 'strike');
  const expirDate = readStr(row, 'expirDate');
  const dte = readNum(row, 'dte');
  if (!Number.isFinite(strike) || strike <= 0 || expirDate.length === 0 || !Number.isFinite(dte)) {
    return null;
  }
  return {
    strike,
    expirDate,
    dte,
    smvVol: readVol(row, 'smvVol'),
    callValue: readNum(row, 'callValue'),
    putValue: readNum(row, 'putValue'),
    callMidIv: readVol(row, 'callMidIv'),
    putMidIv: readVol(row, 'putMidIv'),
    delta: readNum(row, 'delta'),
    gamma: readNum(row, 'gamma'),
    theta: readNum(row, 'theta'),
    vega: readNum(row, 'vega'),
  };
}

export interface OratsIvRankRow {
  readonly ticker: string;
  readonly tradeDate: string | null;
  readonly iv: number;
  readonly ivRank1m: number;
  readonly ivPct1m: number;
  readonly ivRank1y: number;
  readonly ivPct1y: number;
  readonly updatedAtUtcSec: number;
}

export type OratsIvRankPayload = OratsMetadata & (
  | ({
      readonly status: 'OPERATIONAL';
      readonly reason?: null;
      readonly source: 'ORATS_IV_RANK';
      readonly row: OratsIvRankRow;
    })
  | { readonly status: 'STALE_CACHE' | 'PARTIAL_FAILURE'; readonly source: 'ORATS_IV_RANK'; readonly row: OratsIvRankRow; readonly reason: string }
  | {
      readonly status: 'UNAVAILABLE';
      readonly source: 'ORATS_IV_RANK';
      readonly ticker: string;
      readonly reason: string;
    });

export function parseOratsIvRankRow(row: Record<string, unknown>): OratsIvRankRow | null {
  const ticker = readStr(row, 'ticker').toUpperCase();
  const tradeDate = parseOratsTradeDate(row['tradeDate']);
  const iv = readVol(row, 'iv');
  const ivRank1y = readNum(row, 'ivRank1y');
  const ivPct1y = readNum(row, 'ivPct1y');
  if (
    ticker === '' ||
    !Number.isFinite(iv) ||
    !Number.isFinite(ivRank1y) ||
    !Number.isFinite(ivPct1y)
  ) {
    return null;
  }
  return {
    ticker,
    tradeDate,
    iv,
    ivRank1m: readNum(row, 'ivRank1m'),
    ivPct1m: readNum(row, 'ivPct1m'),
    ivRank1y,
    ivPct1y,
    updatedAtUtcSec: parseOratsUpdatedAtUtcSec(row['updatedAt']) ?? Number.NaN,
  };
}

export class OratsHybridClient {
  private readonly deps: OratsHybridClientDeps;
  private readonly surfaceCache = new Map<
    string,
    { readonly fetchedAtMs: number; readonly payload: OratsHybridSurfaceOperational }
  >();
  private readonly ivRankCache = new Map<
    string,
    { readonly fetchedAtMs: number; readonly row: OratsIvRankRow }
  >();
  private readonly ivRankInFlight = new Map<string, Promise<OratsIvRankPayload>>();
  private readonly telemetry = new RollingFeedTelemetry({
    latencyKind: 'HTTP_ROUND_TRIP',
  });
  private readonly endpoints: Record<OratsEndpoint, OratsEndpointHealth> = {
    cores: createEndpointHealth('cores'), strikes: createEndpointHealth('strikes'), ivrank: createEndpointHealth('ivrank'),
  };
  private readonly servingStale = new Set<OratsEndpoint>();
  private readonly jitterUnit: number;

  public constructor(opts?: {
    readonly jitterUnit?: number;
    readonly env?: NodeJS.ProcessEnv;
    readonly fetchFn?: OratsHttpFn;
    readonly nowMsFn?: () => number;
    readonly cacheTtlMs?: number;
    readonly secrets?: readonly string[];
  }) {
    this.jitterUnit = opts?.jitterUnit ?? 0;
    const env = opts?.env ?? {};
    const cfg = loadOratsClientConfigFromEnv(env);
    const secrets = [...(opts?.secrets ?? [])];
    if (cfg.apiKey !== null && !secrets.includes(cfg.apiKey)) {
      secrets.push(cfg.apiKey);
    }
    this.deps = {
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      fetchFn: opts?.fetchFn ?? defaultOratsFetch,
      nowMsFn: opts?.nowMsFn ?? (() => Date.now()),
      cacheTtlMs: opts?.cacheTtlMs ?? DEFAULT_ORATS_CACHE_TTL_MS,
      secrets,
    };
  }

  public isConfigured(): boolean {
    return this.deps.apiKey !== null;
  }

  public getFeedTelemetrySnapshot(nowMs: number): FeedTelemetrySnapshot {
    return this.telemetry.snapshot(nowMs);
  }

  public getCircuitBreaker(nowMs: number) {
    const endpoints: OratsEndpoints = { ...this.endpoints };
    const all = Object.values(endpoints);
    const open = all.filter(e => e.circuitState === 'OPEN');
    const state = open.some(e => e.nextRetryAtMs !== null && nowMs < e.nextRetryAtMs) ? 'OPEN' as const
      : open.length || all.some(e => e.halfOpenProbeInFlight) ? 'HALF_OPEN' as const : 'CLOSED' as const;
    const started = all.flatMap(e => e.circuitOpenedAtMs === null ? [] : [e.circuitOpenedAtMs]);
    return { state, consecutiveFailures: Math.max(...all.map(e => e.consecutiveFailures)), openedAtMs: started.length ? Math.min(...started) : null, endpoints };
  }

  public getHealthSnapshot(now = this.deps.nowMsFn()) {
    const circuitBreaker = this.getCircuitBreaker(now);
    const endpoints = circuitBreaker.endpoints;
    const healthStatus = aggregateOratsGlobalHealth(endpoints, this.servingStale.size > 0);
    const all = Object.values(endpoints).sort((a, b) => (b.receivedAtMs ?? 0) - (a.receivedAtMs ?? 0));
    const received = all[0]?.receivedAtMs;
    const configured = this.isConfigured();
    return { configured, healthStatus, connected: configured && received == null ? null : healthStatus === 'OPERATIONAL',
      providerTradeDate: endpoints.cores.providerTradeDate ?? endpoints.ivrank.providerTradeDate,
      endpoints, circuitBreaker, lastError: all.find(e => e.ok === false)?.errorMessage ?? null,
      lastFetchAtUtcSec: received == null ? null : Math.floor(received / 1000), lastStatus: received == null ? null : healthStatus,
      planTier: null, quotaRemaining: null, quotaLimit: null, quotaResetAtUtcSec: null, telemetry: this.telemetry.snapshot(now) };
  }

  private async fetchEndpoint(endpoint: OratsEndpoint, ticker: string) {
    const start = this.deps.nowMsFn();
    const gate = evaluateEndpointCircuitBeforeCall(this.endpoints[endpoint], start);
    let rows: Record<string, unknown>[] = [];
    if (gate.blocked) {
      const health = { ...gate.state, ok: false, errorKind: gate.blocked, errorMessage: `ORATS_${endpoint.toUpperCase()}_${gate.blocked}` };
      return { rows, health };
    }
    this.endpoints[endpoint] = gate.state;
    let httpStatus: number | null = null;
    let errorKind: OratsError | null = null;
    try {
      const url = new URL(this.deps.baseUrl + '/' + endpoint);
      url.searchParams.set('token', this.deps.apiKey ?? '');
      url.searchParams.set('ticker', ticker);
      const resp = await this.timedFetch(url.href, 10_000);
      httpStatus = resp.status;
      if (!resp.ok) errorKind = resp.status === 429 ? 'HTTP_429' : resp.status >= 500 ? 'HTTP_5XX' : 'HTTP_4XX';
      else {
        const json = await resp.json();
        const parsed = extractStrictOratsRows(json, row => {
          if (row['ticker'] !== undefined && readStr(row, 'ticker').toUpperCase() !== ticker) return false;
          if (endpoint === 'ivrank') return parseOratsIvRankRow(row) !== null;
          if (endpoint === 'strikes') return parseOratsStrikeRow(row) !== null;
          return ['stockPrice', 'smvVol', 'iv10d', 'iv20d', 'iv30d', 'iv60d', 'iv90d', 'iv6m', 'iv1y', 'exErnIv30d'].some(key => Number.isFinite(readNum(row, key)));
        });
        if (parsed === null) errorKind = 'INVALID_SCHEMA';
        else if (!parsed.length && endpoint !== 'strikes') errorKind = 'UNEXPECTED_EMPTY';
        else rows = parsed;
      }
    } catch (err) {
      errorKind = err instanceof Error && err.name === 'AbortError' ? 'TIMEOUT'
        : httpStatus !== null ? 'INVALID_JSON' : 'NETWORK_ERROR';
    }
    const providerTradeDate = parseOratsTradeDate(rows[0]?.['tradeDate']);
    if (!errorKind && endpoint !== 'strikes' && !providerTradeDate) errorKind = 'INVALID_SCHEMA';
    const outcome: EndpointOutcome = { httpStatus, errorKind, providerTradeDate, asOf: parseOratsUpdatedAtUtcSec(rows[0]?.['updatedAt']),
      payloadState: errorKind ? 'ERROR' : rows.length ? 'VALID_DATA' : 'EMPTY_VALID' };
    const health = recordEndpointOutcome(this.endpoints[endpoint], outcome, start, this.deps.nowMsFn(), this.jitterUnit);
    // Requests already in flight when the circuit opened cannot act as recovery probes.
    if (gate.state.halfOpenProbeInFlight || this.endpoints[endpoint].circuitState === 'CLOSED') {
      this.endpoints[endpoint] = health;
      if (health.ok) this.servingStale.delete(endpoint);
    }
    return { rows, health };
  }

  private async timedFetch(
    url: string,
    timeoutMs: number,
  ): Promise<{
    readonly ok: boolean;
    readonly status: number;
    readonly json: () => Promise<unknown>;
    readonly text: () => Promise<string>;
  }> {
    const startedAtMs = this.deps.nowMsFn();
    try {
      const response = await this.deps.fetchFn(url, { timeoutMs });
      this.telemetry.record({
        atMs: this.deps.nowMsFn(),
        latencyMs: this.deps.nowMsFn() - startedAtMs,
        httpStatus: response.status,
      });
      return response;
    } catch (err: unknown) {
      this.telemetry.record({
        atMs: this.deps.nowMsFn(),
        latencyMs: this.deps.nowMsFn() - startedAtMs,
      });
      throw err;
    }
  }

  /**
   * Pieza 36: IV Rank/Percentile oficial de ORATS (`GET /datav2/ivrank`).
   * Solo se invoca desde la carga on-demand de Volatilidad; los errores son
   * `UNAVAILABLE` explícitos y no se cachean.
   */
  public async fetchIvRank(rawTicker: string, forceRefresh = false): Promise<OratsIvRankPayload> {
    const ticker = rawTicker.trim().toUpperCase();
    const nowMs = this.deps.nowMsFn();
    if (this.deps.apiKey === null) {
      return {
        status: 'UNAVAILABLE',
        source: 'ORATS_IV_RANK',
        ticker,
        reason: 'ORATS_API_KEY_NOT_CONFIGURED',
      };
    }
    if (ticker === '') {
      return {
        status: 'UNAVAILABLE',
        source: 'ORATS_IV_RANK',
        ticker,
        reason: 'ORATS_IV_RANK_EMPTY_TICKER',
      };
    }

    if (!forceRefresh) {
      const cached = this.ivRankCache.get(ticker);
      if (this.endpoints.ivrank.ok && cached !== undefined && nowMs - cached.fetchedAtMs < this.deps.cacheTtlMs) {
        return { status: 'OPERATIONAL', source: 'ORATS_IV_RANK', row: cached.row, providerTradeDate: cached.row.tradeDate,
          tradeDateVerified: true, cachedAtUtcSec: Math.floor(cached.fetchedAtMs / 1000), cacheAgeMs: nowMs - cached.fetchedAtMs };
      }
      const inflight = this.ivRankInFlight.get(ticker);
      if (inflight !== undefined) {
        return inflight;
      }
    }

    const request = (async (): Promise<OratsIvRankPayload> => {
      const { rows, health } = await this.fetchEndpoint('ivrank', ticker);
      const row = rows[0] && parseOratsIvRankRow(rows[0]);
      const source = 'ORATS_IV_RANK' as const;
      const receivedMs = this.deps.nowMsFn();
      const meta = { receivedAtUtcSec: Math.floor(receivedMs / 1000), endpoints: { ...this.endpoints, ivrank: health } };
      if (health.ok && row) {
        this.ivRankCache.set(ticker, { fetchedAtMs: receivedMs, row });
        return { ...meta, source, row, status: 'OPERATIONAL', providerTradeDate: row.tradeDate, tradeDateVerified: true };
      }
      const reason = health.errorMessage ?? 'ORATS_IVRANK_INVALID_SCHEMA';
      const cached = this.ivRankCache.get(ticker);
      if (cached) {
        this.servingStale.add('ivrank');
        return { ...meta, source, status: 'STALE_CACHE', dataProvenance: 'STALE_CACHE', stale: true, row: cached.row,
          providerTradeDate: cached.row.tradeDate, cacheAgeMs: receivedMs - cached.fetchedAtMs, reason };
      }
      return row ? { ...meta, source, status: 'PARTIAL_FAILURE', row, tradeDateVerified: false, reason }
        : { ...meta, source, status: 'UNAVAILABLE', ticker, reason };
    })();

    if (!forceRefresh) {
      this.ivRankInFlight.set(ticker, request);
    }
    try { return await request; }
    finally { if (this.ivRankInFlight.get(ticker) === request) this.ivRankInFlight.delete(ticker); }
  }

  public async fetchHybridSurface(
    input: FetchOratsHybridInput,
  ): Promise<OratsHybridSurfacePayload> {
    const ticker = input.ticker.trim().toUpperCase();
    const nowMs = this.deps.nowMsFn();
    const receivedAtUtcSecOnEntry = Math.floor(nowMs / 1000);

    if (this.deps.apiKey === null) {
      return {
        status: 'UNAVAILABLE',
        source: 'ORATS_DELAYED_CORE',
        ticker,
        asOfUtcSec: Number.NaN, receivedAtUtcSec: receivedAtUtcSecOnEntry, providerTradeDate: null, healthStatus: 'UNAVAILABLE',
        reason: 'ORATS_API_KEY_NOT_CONFIGURED',
        massiveSpotPrice: input.massiveSpotPrice,
        massiveSpotSourceMode: input.massiveSpotSourceMode,
        yangZhangAdrVol: input.yangZhangAdrVol,
      };
    }

    const cached = this.surfaceCache.get(ticker);
    if (!input.forceRefresh && this.endpoints.cores.ok && this.endpoints.strikes.ok && cached !== undefined && nowMs - cached.fetchedAtMs < this.deps.cacheTtlMs) {
      return {
        ...cached.payload,
        massiveSpotPrice: input.massiveSpotPrice,
        massiveSpotSourceMode: input.massiveSpotSourceMode,
        yangZhangAdrVol: input.yangZhangAdrVol,
      };
    }

    // Each request classifies its own transport, JSON and schema failures.
    const results = await Promise.allSettled([this.fetchEndpoint('cores', ticker), this.fetchEndpoint('strikes', ticker)]);
    const resultFor = (result: (typeof results)[number], endpoint: OratsEndpoint) => {
      if (result.status === 'fulfilled') return result.value;
      const now = this.deps.nowMsFn();
      const health = recordEndpointOutcome(this.endpoints[endpoint], {
        httpStatus: null, errorKind: 'NETWORK_ERROR', asOf: null, providerTradeDate: null, payloadState: 'ERROR',
      }, nowMs, now, this.jitterUnit);
      this.endpoints[endpoint] = health;
      return { rows: [], health };
    };
    const cores = resultFor(results[0], 'cores');
    const strikes = resultFor(results[1], 'strikes');
    const endpoints = { ...this.endpoints, cores: cores.health, strikes: strikes.health };
    const receivedMs = this.deps.nowMsFn();
    const receivedAtUtcSec = Math.floor(receivedMs / 1000);
    const coreRow = cores.rows[0];
    const failure = !cores.health.ok ? cores.health : !strikes.health.ok ? strikes.health : null;
    const reason = failure?.errorMessage ?? 'ORATS_INVALID_SCHEMA';
    const lastHealthy = this.surfaceCache.get(ticker);
    if (failure && lastHealthy) {
      this.servingStale.add(failure.endpoint);
      return { ...lastHealthy.payload, status: 'STALE_CACHE', healthStatus: 'STALE_CACHE', dataProvenance: 'STALE_CACHE',
        surfaceCompleteness: 'STALE_CACHE_SERVED', stale: true, endpoints, reason, receivedAtUtcSec,
        cacheAgeMs: receivedMs - lastHealthy.fetchedAtMs };
    }
    if (coreRow === undefined) return {
      status: 'UNAVAILABLE', healthStatus: 'UNAVAILABLE', source: 'ORATS_DELAYED_CORE', dataProvenance: 'UNAVAILABLE', ticker,
      asOfUtcSec: Number.NaN, receivedAtUtcSec, providerTradeDate: null, tradeDateVerified: false, endpoints, reason,
      massiveSpotPrice: input.massiveSpotPrice, massiveSpotSourceMode: input.massiveSpotSourceMode, yangZhangAdrVol: input.yangZhangAdrVol,
    };
    const tradeDate = cores.health.providerTradeDate;
    const operational: OratsHybridSurfaceOperational = {
      status: 'OPERATIONAL', healthStatus: 'OPERATIONAL', source: 'ORATS_DELAYED_CORE', ticker,
      tradeDate, providerTradeDate: tradeDate, tradeDateVerified: tradeDate !== null, providerUpdatedAtUtcSec: cores.health.asOf,
      asOfUtcSec: cores.health.asOf ?? Number.NaN, receivedAtUtcSec, endpoints, stale: false, dataProvenance: 'LIVE',
      surfaceCompleteness: strikes.rows.length ? 'COMPLETE' : 'EMPTY_STRIKES_VALID',
      stockPrice: readNum(coreRow, 'stockPrice'),
      massiveSpotPrice: input.massiveSpotPrice,
      massiveSpotSourceMode: input.massiveSpotSourceMode,
      smvVol: readVol(coreRow, 'smvVol'),
      iv10d: readVol(coreRow, 'iv10d'),
      iv20d: readVol(coreRow, 'iv20d'),
      iv30d: readVol(coreRow, 'iv30d'),
      iv60d: readVol(coreRow, 'iv60d'),
      iv90d: readVol(coreRow, 'iv90d'),
      iv6m: readVol(coreRow, 'iv6m'),
      iv1y: readVol(coreRow, 'iv1y'),
      exErnIv10d: readVol(coreRow, 'exErnIv10d'),
      exErnIv20d: readVol(coreRow, 'exErnIv20d'),
      exErnIv30d: readVol(coreRow, 'exErnIv30d'),
      exErnIv60d: readVol(coreRow, 'exErnIv60d'),
      exErnIv90d: readVol(coreRow, 'exErnIv90d'),
      fwd30_20: readVol(coreRow, 'fwd30_20'),
      fwd60_30: readVol(coreRow, 'fwd60_30'),
      fwd90_60: readVol(coreRow, 'fwd90_60'),
      impliedMove: readVol(coreRow, 'impliedMove'),
      annIdiv: readNum(coreRow, 'annIdiv'),
      impliedNextDiv: readNum(coreRow, 'impliedNextDiv'),
      borrow30: normalizeOratsSignedRateToDecimal(readNum(coreRow, 'borrow30')),
      yieldRate: readVol(coreRow, 'yieldRate'),
      yangZhangAdrVol: input.yangZhangAdrVol,
      strikes: strikes.rows.map(parseOratsStrikeRow).filter((row): row is OratsSurfaceStrikeRow => row !== null),
      reason: null,
    };

    if (failure) return { ...operational, status: 'PARTIAL_FAILURE', healthStatus: 'PARTIAL_FAILURE', reason,
      dataProvenance: 'LIVE_PARTIAL', surfaceCompleteness: !strikes.health.ok ? 'INCOMPLETE_STRIKES_ERROR' : 'UNVERIFIED_DATE' };
    const healthy = { ...operational, cachedAtUtcSec: receivedAtUtcSec };
    this.surfaceCache.set(ticker, { fetchedAtMs: receivedMs, payload: healthy });
    return healthy;
  }
}
