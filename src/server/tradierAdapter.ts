/**
 * Adaptador Tradier Live & Options (Pieza 32).
 *
 * Integra `api.tradier.com` (REST) + `ws.tradier.com` (streaming) como motor de
 * cotizaciones en vivo y cadenas de opciones US/ADRs dentro de la capa canónica:
 *
 *  - `fetchTradierQuotes(symbols)`: `GET /markets/quotes?symbols=...&greeks=true`
 *    (NBBO `bid`/`bidsize`/`ask`/`asksize`, `last`, `volume`, `change_percentage`,
 *    griegas para contratos OCC puntuales).
 *  - `fetchTradierOptionChain(symbol, expiration)`: `GET /markets/options/chains`
 *    normalizando griegas (`delta`, `gamma`, `theta`, `vega`, `rho`, `phi`,
 *    `mid_iv`, `smv_vol`), puntas, `volume` y `open_interest`.
 *  - `startTradierMarketStream(symbols, onTick)` vía `TradierLiveManager`:
 *    sesión `POST /markets/events/session` + WebSocket
 *    `wss://ws.tradier.com/v1/markets/events` con payload
 *    `{"symbols":[...],"sessionid":"...","filter":["trade","quote"],"linebreak":true}`.
 *
 * Zero Silent Fallbacks: cada campo no calculable es `Number.NaN` (o `null` en
 * timestamps), `Tradier 0` en `bid`/`ask`/`last` significa "sin punta" y se
 * representa como `NaN`; la provenance (`provider: 'TRADIER'`) viaja siempre con
 * `asOfUtcSec`, y los resúmenes de overlay exponen contadores explícitos.
 *
 * Seguridad: el access token JAMÁS se loguea ni serializa; los errores se
 * redactan con el conjunto de secretos del caller.
 */

import './envBootstrap.js';

import { WebSocket } from 'ws';
import type {
  OptionDaySummary,
  OptionGreeks,
  OptionLastQuote,
  OptionSnapshotContract,
} from '../data/optionsTypes.js';
import type { WsSocketLike } from '../data/wsTypes.js';
import { getUsEquitySessionPhase, type UsEquitySessionPhase } from '../core/sessions.js';
import { parseExpirationDate } from '../data/normalizeOptions.js';
import {
  RollingFeedTelemetry,
  type FeedTelemetrySnapshot,
} from './feedsHealthMonitor.js';
import {
  readMassiveEnvSource,
  resolveMassiveEnvValue,
  type MassiveEnvSource,
} from './massiveKeyPool.js';
import { redactSecrets } from './runtimeCache.js';

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

export type TradierApiEnv = 'prod' | 'sandbox';

export const TRADIER_PROD_REST_BASE = 'https://api.tradier.com/v1';
export const TRADIER_SANDBOX_REST_BASE = 'https://sandbox.tradier.com/v1';
export const TRADIER_WS_BASE = 'wss://ws.tradier.com/v1/markets/events';
export const TRADIER_SANDBOX_WS_BASE = 'wss://sandbox.tradier.com/v1/markets/events';

/**
 * Pieza 41.1: aliases dinámicos. Los alias Sandbox seleccionan el entorno
 * Sandbox aunque `TRADIER_ENV` no esté presente; un `TRADIER_ENV=sandbox`
 * explícito sigue siendo válido con un token Live.
 */
export const TRADIER_LIVE_TOKEN_ENV_NAMES = [
  'TRADIER_API_TOKEN',
  'TRADIER_LIVE_TOKEN',
  'TRADIER_ACCESS_TOKEN',
  'TRADIER_TOKEN',
] as const;
export const TRADIER_SANDBOX_TOKEN_ENV_NAMES = [
  'TRADIER_SANDBOX_TOKEN',
  'TRADIER_SANDBOX_API_TOKEN',
  'TRADIER_SANDBOX_KEY',
] as const;
export const TRADIER_TOKEN_ENV_NAMES = [
  ...TRADIER_LIVE_TOKEN_ENV_NAMES,
  ...TRADIER_SANDBOX_TOKEN_ENV_NAMES,
] as const;
export const TRADIER_ENV_ENV_NAME = 'TRADIER_ENV';
export const TRADIER_USE_SANDBOX_ENV_NAME = 'TRADIER_USE_SANDBOX';

export interface TradierConfig {
  /** Secreto. Jamás loguear. */
  readonly accessToken: string | null;
  /** Nombre de variable de entorno que proveyó el token (o `null`). */
  readonly tokenEnvName: string | null;
  readonly apiEnv: TradierApiEnv;
  readonly restBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly configured: boolean;
  /** Pieza 41.2: true solo para aliases genéricos (`TRADIER_TOKEN`/`TRADIER_API_TOKEN`). */
  readonly tokenIsGeneric: boolean;
  /** Pieza 41.2: se puede pasar de Live a Sandbox ante 401/403. */
  readonly sandboxFallbackAllowed: boolean;
  /** Pieza 41.2: true después de la conmutación explícita. */
  readonly sandboxFallbackUsed?: boolean;
}

export function resolveTradierConfig(
  env?: NodeJS.ProcessEnv,
  envFilePath?: string,
): TradierConfig {
  const source: MassiveEnvSource = readMassiveEnvSource(env, envFilePath);
  let accessToken: string | null = null;
  let tokenEnvName: string | null = null;
  let tokenIsSandbox = false;
  for (const name of TRADIER_LIVE_TOKEN_ENV_NAMES) {
    const value = resolveMassiveEnvValue(source, name);
    if (value !== '') {
      accessToken = value;
      tokenEnvName = name;
      tokenIsSandbox = false;
      break;
    }
  }
  if (accessToken === null) {
    for (const name of TRADIER_SANDBOX_TOKEN_ENV_NAMES) {
      const value = resolveMassiveEnvValue(source, name);
      if (value !== '') {
        accessToken = value;
        tokenEnvName = name;
        tokenIsSandbox = true;
        break;
      }
    }
  }
  const envRaw = resolveMassiveEnvValue(source, TRADIER_ENV_ENV_NAME).toLowerCase();
  const useSandboxRaw = resolveMassiveEnvValue(source, TRADIER_USE_SANDBOX_ENV_NAME).toLowerCase();
  const tokenIsGeneric =
    tokenEnvName === 'TRADIER_TOKEN' || tokenEnvName === 'TRADIER_API_TOKEN';
  const sandboxFallbackAllowed = useSandboxRaw !== 'false';
  const apiEnv: TradierApiEnv =
    tokenIsSandbox || envRaw === 'sandbox' || useSandboxRaw === 'true' ? 'sandbox' : 'prod';
  return {
    accessToken,
    tokenEnvName,
    apiEnv,
    restBaseUrl: apiEnv === 'sandbox' ? TRADIER_SANDBOX_REST_BASE : TRADIER_PROD_REST_BASE,
    wsBaseUrl: apiEnv === 'sandbox' ? TRADIER_SANDBOX_WS_BASE : TRADIER_WS_BASE,
    configured: accessToken !== null,
    tokenIsGeneric,
    sandboxFallbackAllowed,
  };
}

/** Alias histórico de la Pieza 32; lee el entorno dinámicamente en el call-site. */
export function loadTradierConfigFromEnv(
  env?: NodeJS.ProcessEnv,
  envFilePath?: string,
): TradierConfig {
  return resolveTradierConfig(env, envFilePath);
}

/**
 * Pieza 41.2: conmuta un token genérico Live a Sandbox tras un 401/403 real.
 * No cambia el token ni el alias; solo endpoints y provenance de entorno.
 */
export function switchTradierConfigToSandbox(config: TradierConfig): TradierConfig {
  return {
    ...config,
    apiEnv: 'sandbox',
    restBaseUrl: TRADIER_SANDBOX_REST_BASE,
    wsBaseUrl: TRADIER_SANDBOX_WS_BASE,
    sandboxFallbackUsed: true,
  };
}

/**
 * Pieza 41.4: conmuta de Sandbox a Live tras un HTTP 401 en
 * `sandbox.tradier.com/v1` (p. ej. token Live con `TRADIER_USE_SANDBOX=true`).
 */
export function switchTradierConfigToLive(config: TradierConfig): TradierConfig {
  return {
    ...config,
    apiEnv: 'prod',
    restBaseUrl: TRADIER_PROD_REST_BASE,
    wsBaseUrl: TRADIER_WS_BASE,
    sandboxFallbackUsed: false,
  };
}

/**
 * Pieza 41.4: resuelve la única conmutación de reintento permitida ante un
 * rechazo de sesión (`HTTP 401` bidireccional Live <-> Sandbox; `403` solo en
 * fallback genérico Live -> Sandbox cuando `sandboxFallbackAllowed` está activo).
 */
export function resolveTradierSessionRetryConfig(
  config: TradierConfig,
  httpStatus: number,
): TradierConfig | null {
  if (config.apiEnv === 'sandbox') {
    return httpStatus === 401 ? switchTradierConfigToLive(config) : null;
  }
  if (
    config.sandboxFallbackAllowed &&
    (httpStatus === 401 || (config.tokenIsGeneric && httpStatus === 403))
  ) {
    return switchTradierConfigToSandbox(config);
  }
  return null;
}

export function formatTradierEnvironmentTelemetry(
  environment: 'LIVE' | 'SANDBOX',
  restBaseUrl: string,
): string {
  const host = restBaseUrl.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return `${environment} · ${host}`;
}

// ---------------------------------------------------------------------------
// Transporte HTTP
// ---------------------------------------------------------------------------

export interface TradierHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly text: string;
}

export interface TradierHttpRequestInit {
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export type TradierHttpFn = (
  url: string,
  init: TradierHttpRequestInit,
) => Promise<TradierHttpResponse>;

export function createDefaultTradierHttpFn(timeoutMs = 10_000): TradierHttpFn {
  return async (url, init) => {
    const effectiveTimeoutMs = init.timeoutMs ?? timeoutMs;
    const response = await fetch(url, {
      method: init.method,
      headers: { ...init.headers },
      signal: AbortSignal.timeout(effectiveTimeoutMs),
    });
    return {
      ok: response.ok,
      status: response.status,
      text: await response.text(),
    };
  };
}

export interface TradierClientDeps {
  readonly config: TradierConfig;
  readonly httpFn?: TradierHttpFn;
  readonly nowMsFn?: () => number;
  /** Secretos para redactar errores (incluye el token del caller). */
  readonly secrets?: readonly string[];
  readonly timeoutMs?: number;
  readonly authBreaker?: TradierAuthCircuitBreaker;
  readonly onEnvironmentNegotiated?: (config: TradierConfig) => void;
}

export class TradierNotConfiguredError extends Error {
  public constructor() {
    super('Tradier is not configured: TRADIER_API_TOKEN / TRADIER_SANDBOX_TOKEN (or legacy aliases) missing');
    this.name = 'TradierNotConfiguredError';
  }
}

export class TradierAuthInvalidError extends Error {
  public readonly code = 'AUTH_INVALID' as const;
  public readonly httpStatus = 401 as const;

  public constructor(message = 'Tradier authentication invalid (HTTP 401)') {
    super(message);
    this.name = 'TradierAuthInvalidError';
  }
}

export interface TradierAuthCircuitBreakerStatus {
  readonly authInvalid: boolean;
  readonly openUntilMs: number | null;
  readonly lastReason: string | null;
  readonly trippedCount: number;
}

/**
 * Circuit-breaker compartido para autenticación Tradier REST + WS.
 * Tras recibir 401 tanto en Sandbox como en Live (o sin fallback permitido),
 * detiene reintentos repetitivos durante `cooldownMs` (5 min por defecto).
 */
export class TradierAuthCircuitBreaker {
  private readonly cooldownMs: number;
  private openUntilMs: number | null = null;
  private lastReason: string | null = null;
  private negotiatedConfig: TradierConfig | null = null;
  private trippedCount = 0;

  public constructor(options?: { readonly cooldownMs?: number }) {
    const raw = options?.cooldownMs;
    this.cooldownMs =
      raw !== undefined && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 300_000;
  }

  public isOpen(nowMs: number): boolean {
    if (this.openUntilMs === null) return false;
    if (!Number.isFinite(nowMs)) return true;
    if (nowMs >= this.openUntilMs) {
      this.openUntilMs = null;
      return false;
    }
    return true;
  }

  public getNegotiatedConfig(): TradierConfig | null {
    return this.negotiatedConfig;
  }

  public getStatus(nowMs: number): TradierAuthCircuitBreakerStatus {
    return {
      authInvalid: this.isOpen(nowMs),
      openUntilMs: this.openUntilMs,
      lastReason: this.lastReason,
      trippedCount: this.trippedCount,
    };
  }

  public recordSuccess(config: TradierConfig): void {
    this.openUntilMs = null;
    this.lastReason = null;
    this.negotiatedConfig = config;
  }

  public recordAuthInvalid(reason: string, nowMs: number): void {
    const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now();
    this.openUntilMs = safeNow + this.cooldownMs;
    this.lastReason = reason;
    this.trippedCount += 1;
  }

  public reset(): void {
    this.openUntilMs = null;
    this.lastReason = null;
    this.negotiatedConfig = null;
    this.trippedCount = 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerce numérico tolerante: finito -> valor; cualquier otra cosa -> NaN. */
function num(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
}

/** Precio de punta/último: `0` en Tradier significa "sin dato" -> NaN. */
function priceNum(value: unknown): number {
  const n = num(value);
  return n > 0 ? n : Number.NaN;
}

/** Cantidades acumulables donde `0` es un valor legítimo. */
function countNum(value: unknown): number {
  const n = num(value);
  return n >= 0 ? n : Number.NaN;
}

/** ISO o epoch ms/seg de Tradier -> segundos UTC enteros. */
function tradierEventTimeToUtcSec(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 1e11) return Math.floor(value / 1_000);
    if (value >= 1e9) return Math.floor(value);
    return Number.NaN;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return Number.NaN;
    if (/^\d{10,13}(?:\.\d+)?$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) {
        return parsed >= 1e11 ? Math.floor(parsed / 1_000) : Math.floor(parsed);
      }
    }
    return isoToUtcSec(trimmed);
  }
  return Number.NaN;
}

/** ISO de Tradier (`2026-11-13T16:00:00.000Z`) -> segundos UTC enteros. */
function isoToUtcSec(value: unknown): number {
  if (typeof value !== 'string' || value.trim() === '') return Number.NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1_000) : Number.NaN;
}

function buildAuthHeaders(config: TradierConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${String(config.accessToken)}`,
    Accept: 'application/json',
  };
}

export async function tradierGetWithNegotiation(
  deps: TradierClientDeps,
  path: string,
  query: string,
  label: string,
): Promise<{ readonly response: TradierHttpResponse; readonly configUsed: TradierConfig }> {
  if (!deps.config.configured || deps.config.accessToken === null) {
    throw new TradierNotConfiguredError();
  }
  const nowMs = (deps.nowMsFn ?? (() => Date.now()))();
  if (deps.authBreaker?.isOpen(nowMs) === true) {
    throw new TradierAuthInvalidError(`Tradier ${label} HTTP 401 (AUTH_INVALID)`);
  }
  const activeConfig = deps.authBreaker?.getNegotiatedConfig() ?? deps.config;
  const httpFn = deps.httpFn ?? createDefaultTradierHttpFn(deps.timeoutMs);
  const requestOnce = async (cfg: TradierConfig): Promise<TradierHttpResponse> =>
    httpFn(`${cfg.restBaseUrl}${path}${query}`, {
      method: 'GET',
      headers: buildAuthHeaders(cfg),
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    });

  const response = await requestOnce(activeConfig);
  if (response.ok) {
    deps.authBreaker?.recordSuccess(activeConfig);
    return { response, configUsed: activeConfig };
  }

  if (response.status === 401 || response.status === 403) {
    const alternateConfig = resolveTradierSessionRetryConfig(activeConfig, response.status);
    if (alternateConfig !== null) {
      const retryResponse = await requestOnce(alternateConfig);
      if (retryResponse.ok) {
        deps.authBreaker?.recordSuccess(alternateConfig);
        deps.onEnvironmentNegotiated?.(alternateConfig);
        return { response: retryResponse, configUsed: alternateConfig };
      }
      if (retryResponse.status === 401) {
        const reason = `Tradier ${label} HTTP 401`;
        deps.authBreaker?.recordAuthInvalid(reason, nowMs);
        throw new TradierAuthInvalidError(reason);
      }
      return { response: retryResponse, configUsed: alternateConfig };
    }
    if (response.status === 401) {
      const reason = `Tradier ${label} HTTP 401`;
      deps.authBreaker?.recordAuthInvalid(reason, nowMs);
      throw new TradierAuthInvalidError(reason);
    }
  }

  return { response, configUsed: activeConfig };
}

function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Griegas y cotizaciones REST
// ---------------------------------------------------------------------------

export interface TradierGreeks {
  readonly delta: number;
  readonly gamma: number;
  readonly theta: number;
  readonly vega: number;
  readonly rho: number;
  readonly phi: number;
  readonly bidIv: number;
  readonly midIv: number;
  readonly askIv: number;
  readonly smvVol: number;
  readonly updatedAtUtcSec: number;
}

const NAN_GREEKS: TradierGreeks = {
  delta: Number.NaN,
  gamma: Number.NaN,
  theta: Number.NaN,
  vega: Number.NaN,
  rho: Number.NaN,
  phi: Number.NaN,
  bidIv: Number.NaN,
  midIv: Number.NaN,
  askIv: Number.NaN,
  smvVol: Number.NaN,
  updatedAtUtcSec: Number.NaN,
};

function parseGreeks(raw: unknown): TradierGreeks {
  if (!isRecord(raw)) return NAN_GREEKS;
  return {
    delta: num(raw['delta']),
    gamma: num(raw['gamma']),
    theta: num(raw['theta']),
    vega: num(raw['vega']),
    rho: num(raw['rho']),
    phi: num(raw['phi']),
    bidIv: num(raw['bid_iv']),
    midIv: num(raw['mid_iv']),
    askIv: num(raw['ask_iv']),
    smvVol: num(raw['smv_vol']),
    updatedAtUtcSec: isoToUtcSec(raw['updated_at']),
  };
}

function hasAnyFiniteGreeks(g: TradierGreeks): boolean {
  return (
    Number.isFinite(g.delta) ||
    Number.isFinite(g.gamma) ||
    Number.isFinite(g.theta) ||
    Number.isFinite(g.vega) ||
    Number.isFinite(g.midIv) ||
    Number.isFinite(g.smvVol)
  );
}

export interface TradierQuoteNormalized {
  readonly symbol: string;
  readonly description: string | null;
  readonly type: string | null;
  readonly bid: number;
  readonly bidSize: number;
  readonly ask: number;
  readonly askSize: number;
  readonly last: number;
  readonly volume: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly previousClose: number;
  readonly change: number;
  readonly changePercentage: number;
  readonly asOfUtcSec: number;
  readonly provider: 'TRADIER';
  /** Griegas solo presentes en contratos OCC con `greeks=true`. */
  readonly greeks: TradierGreeks | null;
}

export interface TradierProvenance {
  readonly provider: 'TRADIER';
  readonly endpoint: 'REST_QUOTES' | 'REST_OPTION_CHAIN' | 'WS_MARKET_EVENTS';
  readonly requestedAtUtcSec: number;
  readonly httpStatus: number | null;
  readonly rows: number;
  readonly parseDiscarded: number;
  readonly lastError: string | null;
}

export interface TradierQuotesResult {
  readonly quotes: readonly TradierQuoteNormalized[];
  readonly provenance: TradierProvenance;
}

function parseQuoteRow(raw: unknown): TradierQuoteNormalized | null {
  if (!isRecord(raw)) return null;
  const symbol = typeof raw['symbol'] === 'string' ? raw['symbol'].trim().toUpperCase() : '';
  if (symbol === '') return null;
  const tradeDateSec = isoToUtcSec(raw['trade_date']);
  const quoteDateSec = isoToUtcSec(raw['quote_date']);
  const asOfUtcSec = Math.max(
    Number.isFinite(tradeDateSec) ? tradeDateSec : Number.NEGATIVE_INFINITY,
    Number.isFinite(quoteDateSec) ? quoteDateSec : Number.NEGATIVE_INFINITY,
  );
  const greeks = parseGreeks(raw['greeks']);
  return {
    symbol,
    description: typeof raw['description'] === 'string' ? raw['description'] : null,
    type: typeof raw['type'] === 'string' ? raw['type'] : null,
    bid: priceNum(raw['bid']),
    bidSize: countNum(raw['bidsize']),
    ask: priceNum(raw['ask']),
    askSize: countNum(raw['asksize']),
    last: priceNum(raw['last']),
    volume: countNum(raw['volume']),
    open: priceNum(raw['open']),
    high: priceNum(raw['high']),
    low: priceNum(raw['low']),
    previousClose: priceNum(raw['prevclose']),
    change: num(raw['change']),
    changePercentage: num(raw['change_percentage']),
    asOfUtcSec,
    provider: 'TRADIER',
    greeks: hasAnyFiniteGreeks(greeks) ? greeks : null,
  };
}

/**
 * `GET /markets/quotes?symbols=...&greeks=true`. Lanza `TradierNotConfiguredError`
 * sin token; ante HTTP != 2xx lanza error redactado (el caller decide cómo
 * reportarlo, nunca hay reintentos silenciosos).
 */
export async function fetchTradierQuotes(
  symbols: readonly string[],
  deps: TradierClientDeps,
): Promise<TradierQuotesResult> {
  const clean = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter((s) => s !== ''))];
  if (clean.length === 0) {
    throw new Error('fetchTradierQuotes: empty symbol list');
  }
  const nowSec = Math.floor((deps.nowMsFn ?? (() => Date.now()))() / 1_000);
  const secrets = [...(deps.secrets ?? [])];
  if (deps.config.accessToken !== null) secrets.push(deps.config.accessToken);
  try {
    const { response } = await tradierGetWithNegotiation(
      deps,
      '/markets/quotes',
      `?symbols=${encodeURIComponent(clean.join(','))}&greeks=true`,
      'quotes',
    );
    if (!response.ok) {
      throw new Error(`Tradier quotes HTTP ${String(response.status)}`);
    }
    const body = parseJsonBody(response.text);
    const quotesRaw =
      isRecord(body) && isRecord(body['quotes']) ? body['quotes']['quote'] : undefined;
    const rows: TradierQuoteNormalized[] = [];
    let parseDiscarded = 0;
    if (Array.isArray(quotesRaw)) {
      for (const row of quotesRaw) {
        const parsed = parseQuoteRow(row);
        if (parsed === null) {
          parseDiscarded += 1;
          continue;
        }
        rows.push(parsed);
      }
    } else if (isRecord(quotesRaw)) {
      const parsed = parseQuoteRow(quotesRaw);
      if (parsed === null) {
        parseDiscarded += 1;
      } else {
        rows.push(parsed);
      }
    } else if (quotesRaw !== undefined) {
      parseDiscarded += 1;
    }
    return {
      quotes: rows,
      provenance: {
        provider: 'TRADIER',
        endpoint: 'REST_QUOTES',
        requestedAtUtcSec: nowSec,
        httpStatus: response.status,
        rows: rows.length,
        parseDiscarded,
        lastError: null,
      },
    };
  } catch (err: unknown) {
    const message = redactSecrets(err instanceof Error ? err.message : String(err), secrets);
    if (err instanceof TradierAuthInvalidError) {
      throw new TradierAuthInvalidError(message);
    }
    throw new Error(message);
  }
}

// ---------------------------------------------------------------------------
// Cadena de opciones REST
// ---------------------------------------------------------------------------

export interface TradierOptionContractNormalized {
  /** Símbolo OCC tal como lo entrega Tradier (`GGAL250620C00025000`). */
  readonly occSymbol: string;
  readonly underlying: string;
  readonly contractType: 'call' | 'put';
  readonly strike: number;
  readonly expirationDate: string;
  /** Cierre nominal 16:00 ET en segundos UTC enteros (modelo canónico). */
  readonly expirationTime: number;
  readonly bid: number;
  readonly bidSize: number;
  readonly ask: number;
  readonly askSize: number;
  readonly volume: number;
  readonly openInterest: number;
  readonly last: number;
  readonly close: number;
  readonly greeks: TradierGreeks;
  readonly asOfUtcSec: number;
  readonly provider: 'TRADIER';
  /** OCC estándar. Los contratos ajustados/binarios quedan fuera de la cadena. */
  readonly sharesPerContract: 100;
}

/** Extrae strike codificado OCC (8 dígitos, milésimas) o `NaN` si no matchea. */
export function parseOccEncodedStrike(occSymbol: string): number {
  const normalized = occSymbol.trim().toUpperCase().replace(/^O:/, '');
  const match = normalized.match(/^([A-Z0-9./-]{1,6})(\d{6})([CP])(\d{8})$/);
  const encoded = match?.[4];
  if (encoded === undefined) return Number.NaN;
  const value = Number(encoded) / 1_000;
  return Number.isFinite(value) ? value : Number.NaN;
}

export interface TradierOptionChainResult {
  readonly contracts: readonly TradierOptionContractNormalized[];
  readonly provenance: TradierProvenance;
}

function parseChainRow(raw: unknown, parseDiscarded: { count: number }): TradierOptionContractNormalized | null {
  if (!isRecord(raw)) {
    parseDiscarded.count += 1;
    return null;
  }
  const occSymbol = typeof raw['symbol'] === 'string' ? raw['symbol'].trim().toUpperCase() : '';
  const optionType = typeof raw['option_type'] === 'string' ? raw['option_type'].trim().toLowerCase() : '';
  const strike = num(raw['strike']);
  const expirationDate =
    typeof raw['expiration_date'] === 'string' ? raw['expiration_date'].trim() : '';
  const parsedExpiration = parseExpirationDate(expirationDate);
  const occEncodedStrike = parseOccEncodedStrike(occSymbol);
  if (
    occSymbol === '' ||
    (optionType !== 'call' && optionType !== 'put') ||
    !Number.isFinite(strike) ||
    strike <= 0 ||
    !Number.isFinite(occEncodedStrike) ||
    Math.abs(occEncodedStrike - strike) > 1e-6 ||
    parsedExpiration === null
  ) {
    parseDiscarded.count += 1;
    return null;
  }
  const tradeDateSec = isoToUtcSec(raw['trade_date']);
  const greeks = parseGreeks(raw['greeks']);
  const quoteAsOf = Number.isFinite(greeks.updatedAtUtcSec)
    ? Math.max(greeks.updatedAtUtcSec, Number.isFinite(tradeDateSec) ? tradeDateSec : Number.NaN)
    : tradeDateSec;
  return {
    occSymbol,
    underlying:
      typeof raw['root_symbols'] === 'string' && raw['root_symbols'].trim() !== ''
        ? raw['root_symbols'].trim().toUpperCase()
        : occSymbol.replace(/[CP](\d{8})$/, ''),
    contractType: optionType,
    strike,
    expirationDate: parsedExpiration.date,
    expirationTime: parsedExpiration.time,
    bid: priceNum(raw['bid']),
    bidSize: countNum(raw['bid_size']),
    ask: priceNum(raw['ask']),
    askSize: countNum(raw['ask_size']),
    volume: countNum(raw['volume']),
    openInterest: countNum(raw['open_interest']),
    last: priceNum(raw['last']),
    close: priceNum(raw['close_price'] ?? raw['close']),
    greeks,
    asOfUtcSec: quoteAsOf,
    provider: 'TRADIER',
    sharesPerContract: 100,
  };
}

/**
 * `GET /markets/options/chains?symbol=...&expiration=YYYY-MM-DD&greeks=true`.
 * Normaliza hacia el modelo canónico con `provider: 'TRADIER'` y provenance.
 */
export async function fetchTradierOptionChain(
  symbol: string,
  expiration: string,
  deps: TradierClientDeps,
): Promise<TradierOptionChainResult> {
  const cleanSymbol = symbol.trim().toUpperCase();
  const cleanExpiration = expiration.trim();
  if (cleanSymbol === '' || !/^\d{4}-\d{2}-\d{2}$/.test(cleanExpiration)) {
    throw new Error(`fetchTradierOptionChain: invalid symbol/expiration (${cleanSymbol}/${cleanExpiration})`);
  }
  const nowSec = Math.floor((deps.nowMsFn ?? (() => Date.now()))() / 1_000);
  const secrets = [...(deps.secrets ?? [])];
  if (deps.config.accessToken !== null) secrets.push(deps.config.accessToken);
  try {
    const { response } = await tradierGetWithNegotiation(
      deps,
      '/markets/options/chains',
      `?symbol=${encodeURIComponent(cleanSymbol)}&expiration=${encodeURIComponent(cleanExpiration)}&greeks=true`,
      'option chain',
    );
    if (!response.ok) {
      throw new Error(`Tradier option chain HTTP ${String(response.status)}`);
    }
    const body = parseJsonBody(response.text);
    const optionsRaw =
      isRecord(body) && isRecord(body['options']) ? body['options']['option'] : undefined;
    const contracts: TradierOptionContractNormalized[] = [];
    const parseDiscarded = { count: 0 };
    if (Array.isArray(optionsRaw)) {
      for (const row of optionsRaw) {
        const parsed = parseChainRow(row, parseDiscarded);
        if (parsed !== null) contracts.push(parsed);
      }
    } else if (isRecord(optionsRaw)) {
      const parsed = parseChainRow(optionsRaw, parseDiscarded);
      if (parsed !== null) contracts.push(parsed);
    } else if (optionsRaw !== undefined) {
      parseDiscarded.count += 1;
    }
    return {
      contracts,
      provenance: {
        provider: 'TRADIER',
        endpoint: 'REST_OPTION_CHAIN',
        requestedAtUtcSec: nowSec,
        httpStatus: response.status,
        rows: contracts.length,
        parseDiscarded: parseDiscarded.count,
        lastError: null,
      },
    };
  } catch (err: unknown) {
    const message = redactSecrets(err instanceof Error ? err.message : String(err), secrets);
    if (err instanceof TradierAuthInvalidError) {
      throw new TradierAuthInvalidError(message);
    }
    throw new Error(message);
  }
}

// ---------------------------------------------------------------------------
// Overlay sobre contratos canónicos (Massive -> Tradier live)
// ---------------------------------------------------------------------------

export const TRADIER_MAX_QUOTE_AGE_SEC = 20;
/** Tolerancia para considerar que Tradier refresca a Massive (2s). */
const MASSIVE_FRESHER_TOLERANCE_SEC = 2;

export interface TradierChainOverlaySummary {
  readonly provider: 'TRADIER';
  readonly requestedExpirations: readonly string[];
  readonly tradierContracts: number;
  readonly matchedByOcc: number;
  readonly matchedByStrikeType: number;
  readonly unmatchedTradierContracts: number;
  readonly overlaidContracts: number;
  readonly overlaidBidAsk: number;
  readonly overlaidSizes: number;
  readonly overlaidVolume: number;
  readonly overlaidOpenInterest: number;
  readonly overlaidGreeks: number;
  readonly overlaidMidIv: number;
  readonly skippedStaleQuotes: number;
  readonly httpStatus: number | null;
  readonly lastError: string | null;
}

/** Normaliza `O:GGAL250620C00025000` (Massive) y `GGAL250620C00025000` (Tradier). */
export function normalizeOccTicker(ticker: string): string {
  return ticker.trim().toUpperCase().replace(/^O:/, '');
}

function overlayFlowFields(
  contract: OptionSnapshotContract,
  tradier: TradierOptionContractNormalized,
  summary: MutableOverlaySummary,
): OptionSnapshotContract {
  let changed = false;
  let nextDay: OptionDaySummary = contract.day;
  let nextOpenInterest = contract.openInterest;

  // Volumen del día: máximo acumulado válido entre Massive y Tradier.
  if (Number.isFinite(tradier.volume) && tradier.volume >= 0 && tradier.volume > contract.day.volume) {
    nextDay = { ...contract.day, volume: tradier.volume };
    summary.overlaidVolume += 1;
    changed = true;
  }

  // Open interest: solo valores finitos y no negativos; nunca 0/NaN pisan un dato válido.
  if (
    Number.isFinite(tradier.openInterest) &&
    tradier.openInterest >= 0 &&
    tradier.openInterest > contract.openInterest
  ) {
    nextOpenInterest = tradier.openInterest;
    summary.overlaidOpenInterest += 1;
    changed = true;
  }

  if (!changed) return contract;
  return {
    ...contract,
    day: nextDay,
    openInterest: nextOpenInterest,
  };
}

function overlayQuote(
  contract: OptionSnapshotContract,
  tradier: TradierOptionContractNormalized,
  summary: MutableOverlaySummary,
): OptionSnapshotContract {
  let changed = false;
  let nextLastQuote: OptionLastQuote = contract.lastQuote;
  let nextDay: OptionDaySummary = contract.day;
  let nextGreeks: OptionGreeks = contract.greeks;
  let nextOpenInterest = contract.openInterest;
  let nextIv = contract.impliedVolatility;
  // Puntas y tamaños (Tradier 0 = sin punta -> se mantiene el valor canónico).
  const bidValid = Number.isFinite(tradier.bid) && tradier.bid > 0;
  const askValid = Number.isFinite(tradier.ask) && tradier.ask > 0 && tradier.ask >= tradier.bid;
  if (bidValid || askValid) {
    const bid = bidValid ? tradier.bid : contract.lastQuote.bid;
    const ask = askValid ? tradier.ask : contract.lastQuote.ask;
    const bidSize = Number.isFinite(tradier.bidSize) ? tradier.bidSize : contract.lastQuote.bidSize;
    const askSize = Number.isFinite(tradier.askSize) ? tradier.askSize : contract.lastQuote.askSize;
    if (bid !== contract.lastQuote.bid || ask !== contract.lastQuote.ask) summary.overlaidBidAsk += 1;
    if (bidSize !== contract.lastQuote.bidSize || askSize !== contract.lastQuote.askSize) summary.overlaidSizes += 1;
    const updatedAt = Number.isFinite(tradier.asOfUtcSec)
      ? Math.max(contract.lastQuote.updatedAt, tradier.asOfUtcSec)
      : contract.lastQuote.updatedAt;
    nextLastQuote = { ...contract.lastQuote, bid, ask, bidSize, askSize, updatedAt };
    changed = true;
  }

  // Volumen del día (0 legítimo; solo avanza si Tradier observa más).
  if (Number.isFinite(tradier.volume) && tradier.volume > contract.day.volume) {
    nextDay = { ...contract.day, volume: tradier.volume };
    summary.overlaidVolume += 1;
    changed = true;
  }

  // Open interest (solo avanza si Tradier observa más).
  if (Number.isFinite(tradier.openInterest) && tradier.openInterest > contract.openInterest) {
    nextOpenInterest = tradier.openInterest;
    summary.overlaidOpenInterest += 1;
    changed = true;
  }

  // Griegas campo a campo (solo valores finitos).
  const delta = Number.isFinite(tradier.greeks.delta) ? tradier.greeks.delta : contract.greeks.delta;
  const gamma = Number.isFinite(tradier.greeks.gamma) ? tradier.greeks.gamma : contract.greeks.gamma;
  const theta = Number.isFinite(tradier.greeks.theta) ? tradier.greeks.theta : contract.greeks.theta;
  const vega = Number.isFinite(tradier.greeks.vega) ? tradier.greeks.vega : contract.greeks.vega;
  if (
    delta !== contract.greeks.delta ||
    gamma !== contract.greeks.gamma ||
    theta !== contract.greeks.theta ||
    vega !== contract.greeks.vega
  ) {
    nextGreeks = { delta, gamma, theta, vega };
    summary.overlaidGreeks += 1;
    changed = true;
  }

  // IV de proveedor: solo completa cuando Massive no trajo IV explícita.
  if (!Number.isFinite(contract.impliedVolatility) && Number.isFinite(tradier.greeks.midIv) && tradier.greeks.midIv > 0) {
    nextIv = tradier.greeks.midIv;
    summary.overlaidMidIv += 1;
    changed = true;
  }

  if (!changed) return contract;
  return {
    ...contract,
    lastQuote: nextLastQuote,
    day: nextDay,
    greeks: nextGreeks,
    openInterest: nextOpenInterest,
    impliedVolatility: nextIv,
  };
}

interface MutableOverlaySummary {
  overlaidBidAsk: number;
  overlaidSizes: number;
  overlaidVolume: number;
  overlaidOpenInterest: number;
  overlaidGreeks: number;
  overlaidMidIv: number;
  matchedByOcc: number;
  matchedByStrikeType: number;
  unmatchedTradierContracts: number;
  overlaidContracts: number;
  skippedStaleQuotes: number;
}

/**
 * Aplica puntas/griegas Tradier sobre la cadena canónica de Massive.
 *
 * Reglas explícitas (cero fallbacks silenciosos):
 *  - Matching por OCC normalizado; si difiere, por `expirationDate|tipo|strike`.
 *  - Un contrato Tradier más viejo que `maxQuoteAgeSec` o más viejo que el
 *    `updatedAt` de Massive (+2s de tolerancia) NO sobreescribe nada y se
 *    contabiliza en `skippedStaleQuotes`.
 *  - Campos no calculables en Tradier mantienen el valor canónico previo; el
 *    overlay solo avanza datos con valor finito y válido.
 */
export function overlayTradierChainOnCanonicalContracts(
  contracts: readonly OptionSnapshotContract[],
  tradierChain: readonly TradierOptionContractNormalized[],
  options: {
    readonly nowSec: number;
    readonly maxQuoteAgeSec?: number;
  },
): { readonly contracts: readonly OptionSnapshotContract[]; readonly summary: TradierChainOverlaySummary } {
  const maxQuoteAgeSec = options.maxQuoteAgeSec ?? TRADIER_MAX_QUOTE_AGE_SEC;
  const summary: MutableOverlaySummary = {
    overlaidBidAsk: 0,
    overlaidSizes: 0,
    overlaidVolume: 0,
    overlaidOpenInterest: 0,
    overlaidGreeks: 0,
    overlaidMidIv: 0,
    matchedByOcc: 0,
    matchedByStrikeType: 0,
    unmatchedTradierContracts: 0,
    overlaidContracts: 0,
    skippedStaleQuotes: 0,
  };

  const byOcc = new Map<string, TradierOptionContractNormalized>();
  const byKey = new Map<string, TradierOptionContractNormalized>();
  for (const t of tradierChain) {
    byOcc.set(normalizeOccTicker(t.occSymbol), t);
    byKey.set(`${t.expirationDate}|${t.contractType}|${String(t.strike)}`, t);
  }

  const out: OptionSnapshotContract[] = [];
  const consumed = new Set<TradierOptionContractNormalized>();
  for (const contract of contracts) {
    let matched: TradierOptionContractNormalized | undefined = byOcc.get(normalizeOccTicker(contract.ticker));
    if (matched !== undefined) {
      summary.matchedByOcc += 1;
    } else {
      matched = byKey.get(`${contract.expirationDate}|${contract.contractType}|${String(contract.strikePrice)}`);
      if (matched !== undefined) summary.matchedByStrikeType += 1;
    }
    if (matched === undefined) {
      out.push(contract);
      continue;
    }
    consumed.add(matched);
    const tradierAsOf = matched.asOfUtcSec;
    const massiveUpdatedAt = contract.lastQuote.updatedAt;
    const tradierTooOld =
      Number.isFinite(tradierAsOf) && options.nowSec - tradierAsOf > maxQuoteAgeSec;
    const massiveFresher =
      Number.isFinite(tradierAsOf) &&
      Number.isFinite(massiveUpdatedAt) &&
      tradierAsOf + MASSIVE_FRESHER_TOLERANCE_SEC < massiveUpdatedAt;
    if (tradierTooOld || massiveFresher) {
      // Una punta stale no descarta el flujo del día ni el OI: se fusionan campo
      // por campo, mientras que puntas/griegas/IV quedan explícitamente sin tocar.
      const flowOnly = overlayFlowFields(contract, matched, summary);
      if (flowOnly !== contract) summary.overlaidContracts += 1;
      summary.skippedStaleQuotes += 1;
      out.push(flowOnly);
      continue;
    }
    const next = overlayQuote(contract, matched, summary);
    if (next !== contract) summary.overlaidContracts += 1;
    out.push(next);
  }
  summary.unmatchedTradierContracts = tradierChain.length - consumed.size;

  return {
    contracts: out,
    summary: {
      provider: 'TRADIER',
      requestedExpirations: [],
      tradierContracts: tradierChain.length,
      matchedByOcc: summary.matchedByOcc,
      matchedByStrikeType: summary.matchedByStrikeType,
      unmatchedTradierContracts: summary.unmatchedTradierContracts,
      overlaidContracts: summary.overlaidContracts,
      overlaidBidAsk: summary.overlaidBidAsk,
      overlaidSizes: summary.overlaidSizes,
      overlaidVolume: summary.overlaidVolume,
      overlaidOpenInterest: summary.overlaidOpenInterest,
      overlaidGreeks: summary.overlaidGreeks,
      overlaidMidIv: summary.overlaidMidIv,
      skippedStaleQuotes: summary.skippedStaleQuotes,
      httpStatus: null,
      lastError: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Streaming en vivo (ws.tradier.com)
// ---------------------------------------------------------------------------

export type TradierSocketFactory = (url: string) => WsSocketLike;

export function createDefaultTradierSocketFactory(): TradierSocketFactory {
  return (url) => {
    const ws = new WebSocket(url);
    const socket: WsSocketLike = {
      onOpen: null,
      onMessage: null,
      onClose: null,
      onError: null,
      send: (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      },
      close: (code, reason) => {
        ws.close(code ?? 1000, reason ?? 'client_close');
      },
    };
    ws.on('open', () => {
      socket.onOpen?.();
    });
    ws.on('message', (data) => {
      let text: string;
      if (typeof data === 'string') {
        text = data;
      } else if (Array.isArray(data)) {
        text = Buffer.concat(data).toString('utf-8');
      } else if (data instanceof Buffer) {
        text = data.toString('utf-8');
      } else {
        text = Buffer.from(new Uint8Array(data as ArrayBuffer)).toString('utf-8');
      }
      socket.onMessage?.(text);
    });
    ws.on('close', (code, reason) => {
      socket.onClose?.({
        code: typeof code === 'number' ? code : 1006,
        reason: typeof reason === 'string' ? reason : String(reason),
        wasClean: true,
      });
    });
    ws.on('error', (err) => {
      socket.onError?.(err);
    });
    return socket;
  };
}

export const TRADIER_WS_STREAM_FILTERS = ['trade', 'quote', 'timesale', 'summary'] as const;

export type TradierStreamEventKind = 'trade' | 'quote' | 'timesale' | 'summary';

export interface TradierStreamTick {
  readonly symbol: string;
  readonly event: TradierStreamEventKind;
  readonly price: number;
  readonly size: number;
  readonly bid: number;
  readonly bidSize: number;
  readonly ask: number;
  readonly askSize: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly cumulativeVolume: number;
  readonly previousClose: number;
  readonly regularClose?: number;
  readonly sessionPhase?: UsEquitySessionPhase;
  readonly asOfUtcSec: number;
  readonly provider: 'TRADIER';
}

export type TradierStreamState =
  | 'IDLE'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'RECONNECTING'
  | 'AUTH_INVALID'
  | 'CLOSED'
  | 'ERROR';

export interface TradierStreamStatus {
  readonly configured: boolean;
  readonly connected: boolean;
  readonly state: TradierStreamState;
  readonly authInvalid?: boolean;
  readonly sessionCreated: boolean;
  readonly subscribedSymbols: readonly string[];
  readonly lastTickAtUtcSec: number | null;
  readonly lastError: string | null;
  readonly reconnectAttempts: number;
  readonly activeRole: 'LIVE_STREAM' | 'STANDBY';
  readonly apiEnv: TradierApiEnv;
  readonly environment: 'LIVE' | 'SANDBOX';
  readonly restBaseUrl: string;
  readonly wsBaseUrl: string;
}

export interface TradierLiveQuoteState {
  readonly symbol: string;
  readonly price: number;
  readonly bid: number;
  readonly bidSize: number;
  readonly ask: number;
  readonly askSize: number;
  readonly cumulativeVolume: number;
  readonly previousClose: number;
  readonly asOfUtcSec: number;
  readonly source: 'TRADIER_WS';
}

export interface TradierLiveManagerDeps {
  readonly config: TradierConfig;
  readonly httpFn?: TradierHttpFn;
  readonly createSocketFn?: TradierSocketFactory;
  readonly nowMsFn?: () => number;
  readonly secrets?: readonly string[];
  readonly authBreaker?: TradierAuthCircuitBreaker;
  readonly onTick?: (tick: TradierStreamTick) => void;
  readonly onError?: (message: string) => void;
  readonly onStateChange?: (state: TradierStreamState) => void;
  readonly onEnvironmentNegotiated?: (config: TradierConfig) => void;
  readonly reconnectBaseDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
}

interface MutableLiveQuoteState {
  symbol: string;
  price: number;
  bid: number;
  bidSize: number;
  ask: number;
  askSize: number;
  cumulativeVolume: number;
  previousClose: number;
  asOfUtcSec: number;
}

function parseStreamFrame(text: string): readonly Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (isRecord(item)) events.push(item);
      }
    } else if (isRecord(parsed)) {
      events.push(parsed);
    }
  }
  return events;
}

/**
 * Manager del stream Tradier: crea sesión REST, abre WebSocket, suscribe
 * `{"symbols":[...],"sessionid":"...","filter":["trade","quote"],"linebreak":true}`
 * y emite ticks normalizados. Reconexión con backoff explícito.
 */
const INVALID_TRADIER_SYMBOL_RE =
  /(?:^|[\s:("'])([A-Za-z0-9./^-]+)\s+is\s+not\s+a\s+valid\s+symbol\b/i;

/**
 * Extrae el ticker inválido cuando Tradier rechaza la suscripción WS con
 * `<SYMBOL> is not a valid symbol` (en frame de mensaje o razón de cierre 1007).
 */
export function extractInvalidTradierSymbol(rawMessage: string): string | null {
  const match = INVALID_TRADIER_SYMBOL_RE.exec(rawMessage);
  if (match === null || match[1] === undefined) {
    return null;
  }
  const symbol = match[1].trim().toUpperCase();
  return symbol !== '' ? symbol : null;
}

export class TradierLiveManager {
  private config: TradierConfig;
  private readonly httpFn: TradierHttpFn;
  private readonly createSocketFn: TradierSocketFactory;
  private readonly nowMsFn: () => number;
  private readonly secrets: readonly string[];
  private readonly onTickCb: TradierLiveManagerDeps['onTick'];
  private readonly onErrorCb: TradierLiveManagerDeps['onError'];
  private readonly onStateChangeCb: TradierLiveManagerDeps['onStateChange'];
  private readonly onEnvironmentNegotiatedCb: TradierLiveManagerDeps['onEnvironmentNegotiated'];
  private readonly authBreaker: TradierAuthCircuitBreaker | null;
  private readonly telemetry = new RollingFeedTelemetry({
    latencyKind: 'PROVIDER_EVENT_AGE',
  });
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;

  private negotiatedEnv: TradierApiEnv | null = null;
  private authInvalidTripped = false;

  private readonly latest = new Map<string, MutableLiveQuoteState>();
  private readonly rejectedSymbols = new Set<string>();

  private socket: WsSocketLike | null = null;
  private subscribedSymbols: readonly string[] = [];
  private state: TradierStreamState = 'IDLE';
  private sessionCreated = false;
  private lastTickAtUtcSec: number | null = null;
  private lastError: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  public constructor(deps: TradierLiveManagerDeps) {
    this.config = deps.config;
    this.httpFn = deps.httpFn ?? createDefaultTradierHttpFn();
    this.createSocketFn = deps.createSocketFn ?? createDefaultTradierSocketFactory();
    this.nowMsFn = deps.nowMsFn ?? (() => Date.now());
    const secrets = [...(deps.secrets ?? [])];
    if (deps.config.accessToken !== null) secrets.push(deps.config.accessToken);
    this.secrets = secrets;
    this.authBreaker = deps.authBreaker ?? null;
    this.onTickCb = deps.onTick;
    this.onErrorCb = deps.onError;
    this.onStateChangeCb = deps.onStateChange;
    this.onEnvironmentNegotiatedCb = deps.onEnvironmentNegotiated;
    this.reconnectBaseDelayMs = deps.reconnectBaseDelayMs ?? 5_000;
    this.reconnectMaxDelayMs = deps.reconnectMaxDelayMs ?? 60_000;
  }

  public getEffectiveConfig(): TradierConfig {
    return this.config;
  }

  public getStatus(): TradierStreamStatus {
    const authInvalid =
      this.authInvalidTripped ||
      this.state === 'AUTH_INVALID' ||
      (this.authBreaker?.isOpen(this.nowMsFn()) === true);
    return {
      configured: this.config.configured,
      connected: this.state === 'CONNECTED',
      state: this.state,
      authInvalid,
      sessionCreated: this.sessionCreated,
      subscribedSymbols: [...this.subscribedSymbols],
      lastTickAtUtcSec: this.lastTickAtUtcSec,
      lastError: this.lastError,
      reconnectAttempts: this.reconnectAttempts,
      activeRole:
        this.config.configured && this.state === 'CONNECTED' ? 'LIVE_STREAM' : 'STANDBY',
      apiEnv: this.config.apiEnv,
      environment: this.config.apiEnv === 'sandbox' ? 'SANDBOX' : 'LIVE',
      restBaseUrl: this.config.restBaseUrl,
      wsBaseUrl: this.config.wsBaseUrl,
    };
  }

  public getFeedTelemetrySnapshot(nowMs: number): FeedTelemetrySnapshot {
    return this.telemetry.snapshot(nowMs);
  }

  /** Pieza 33: recrea sesión + socket con la lista real de símbolos actual. */
  public async reconnect(): Promise<void> {
    if (!this.config.configured || this.config.accessToken === null) {
      throw new TradierNotConfiguredError();
    }
    const symbols = [...this.subscribedSymbols];
    if (symbols.length === 0) {
      throw new Error('TradierLiveManager.reconnect: no active symbol subscriptions');
    }
    this.authInvalidTripped = false;
    this.authBreaker?.reset();
    this.stop();
    this.stopped = false;
    await this.start(symbols);
  }

  public getLatestQuotes(): readonly TradierLiveQuoteState[] {
    return [...this.latest.values()].map((q) => ({
      symbol: q.symbol,
      price: q.price,
      bid: q.bid,
      bidSize: q.bidSize,
      ask: q.ask,
      askSize: q.askSize,
      cumulativeVolume: q.cumulativeVolume,
      previousClose: q.previousClose,
      asOfUtcSec: q.asOfUtcSec,
      source: 'TRADIER_WS' as const,
    }));
  }

  /** Crea sesión + socket y suscribe los símbolos dados (solo equities). */
  public async start(symbols: readonly string[]): Promise<void> {
    if (!this.config.configured || this.config.accessToken === null) {
      throw new TradierNotConfiguredError();
    }
    this.stopped = false;
    this.authInvalidTripped = false;
    const clean = [
      ...new Set(
        symbols
          .map((s) => s.trim().toUpperCase())
          .filter((s) => s !== '' && !this.rejectedSymbols.has(s)),
      ),
    ];
    if (clean.length === 0) {
      throw new Error('TradierLiveManager.start: empty symbol list');
    }
    this.subscribedSymbols = clean;
    await this.connectCycle();
  }

  public stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const current = this.socket;
    this.socket = null;
    current?.close(1000, 'server_shutdown');
    this.setState('CLOSED');
  }

  private hasBeenStopped(): boolean {
    return this.stopped;
  }

  private setState(next: TradierStreamState): void {
    if (this.state === next) return;
    this.state = next;
    this.onStateChangeCb?.(next);
  }

  private reportError(message: string): void {
    this.lastError = redactSecrets(message, this.secrets);
    this.onErrorCb?.(this.lastError);
  }

  private async postSessionRequest(config: TradierConfig): Promise<TradierHttpResponse> {
    return this.httpFn(`${config.restBaseUrl}/markets/events/session`, {
      method: 'POST',
      headers: {
        ...buildAuthHeaders(config),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeoutMs: 10_000,
    });
  }

  private parseSessionPayload(
    config: TradierConfig,
    responseText: string,
    switched: boolean,
  ): { readonly sessionId: string; readonly wsUrl: string } {
    const body = parseJsonBody(responseText);
    const stream = isRecord(body) && isRecord(body['stream']) ? body['stream'] : null;
    const sessionId = stream !== null && typeof stream['sessionid'] === 'string' ? stream['sessionid'].trim() : '';
    if (sessionId === '') {
      throw new Error('Tradier session response missing stream.sessionid');
    }
    const urlFromResponse =
      stream !== null && typeof stream['url'] === 'string' && stream['url'].trim() !== ''
        ? stream['url'].trim()
        : config.wsBaseUrl;
    const wrongHostForEnv =
      (config.apiEnv === 'prod' && urlFromResponse.includes('sandbox.tradier.com')) ||
      (config.apiEnv === 'sandbox' && urlFromResponse.includes('ws.tradier.com'));
    const effectiveWsUrl = switched || wrongHostForEnv ? config.wsBaseUrl : urlFromResponse;
    return { sessionId, wsUrl: effectiveWsUrl };
  }

  /** `POST /markets/events/session` -> `{ stream: { sessionid, url } }`. */
  private async createSession(): Promise<{ readonly sessionId: string; readonly wsUrl: string }> {
    const nowMs = this.nowMsFn();
    if (this.authBreaker?.isOpen(nowMs) === true) {
      throw new TradierAuthInvalidError('Tradier session HTTP 401');
    }
    const breakerNegotiated = this.authBreaker?.getNegotiatedConfig() ?? null;
    if (breakerNegotiated !== null && this.negotiatedEnv === null) {
      this.config = breakerNegotiated;
      this.negotiatedEnv = breakerNegotiated.apiEnv;
    }

    const response = await this.postSessionRequest(this.config);
    if (response.ok) {
      const payload = this.parseSessionPayload(this.config, response.text, false);
      this.negotiatedEnv = this.config.apiEnv;
      this.authInvalidTripped = false;
      this.authBreaker?.recordSuccess(this.config);
      return payload;
    }

    if (this.negotiatedEnv === null) {
      const alternateConfig = resolveTradierSessionRetryConfig(this.config, response.status);
      if (alternateConfig !== null) {
        const retryResponse = await this.postSessionRequest(alternateConfig);
        if (retryResponse.ok) {
          const payload = this.parseSessionPayload(alternateConfig, retryResponse.text, true);
          this.config = alternateConfig;
          this.negotiatedEnv = alternateConfig.apiEnv;
          this.authInvalidTripped = false;
          this.authBreaker?.recordSuccess(this.config);
          this.onEnvironmentNegotiatedCb?.(this.config);
          return payload;
        }
        if (retryResponse.status === 401) {
          this.authInvalidTripped = true;
          this.authBreaker?.recordAuthInvalid('Tradier session HTTP 401', nowMs);
          throw new TradierAuthInvalidError('Tradier session HTTP 401');
        }
        throw new Error(`Tradier session HTTP ${String(retryResponse.status)}`);
      }
    }

    if (response.status === 401) {
      this.authInvalidTripped = true;
      this.authBreaker?.recordAuthInvalid('Tradier session HTTP 401', nowMs);
      throw new TradierAuthInvalidError('Tradier session HTTP 401');
    }
    throw new Error(`Tradier session HTTP ${String(response.status)}`);
  }

  private async connectCycle(preserveConnectedState = false): Promise<void> {
    if (this.stopped) return;
    if (!preserveConnectedState || this.state !== 'CONNECTED') {
      this.setState(this.reconnectAttempts === 0 ? 'CONNECTING' : 'RECONNECTING');
    }
    try {
      const { sessionId, wsUrl } = await this.createSession();
      if (this.hasBeenStopped()) return;
      this.sessionCreated = true;
      const socket = this.createSocketFn(wsUrl);
      this.socket = socket;
      socket.onOpen = () => {
        if (this.stopped || this.socket !== socket) return;
        const payload = JSON.stringify({
          symbols: this.subscribedSymbols,
          sessionid: sessionId,
          filter: [...TRADIER_WS_STREAM_FILTERS],
          linebreak: true,
        });
        socket.send(payload);
        this.reconnectAttempts = 0;
        this.lastError = null;
        this.authInvalidTripped = false;
        this.setState('CONNECTED');
      };
      socket.onMessage = (data) => {
        if (this.stopped || this.socket !== socket) return;
        if (this.pruneInvalidSymbolAndReconnect(data)) return;
        this.ingestFrames(data);
      };
      socket.onClose = (info) => {
        if (this.stopped || this.socket !== socket) return;
        if (this.pruneInvalidSymbolAndReconnect(info.reason)) return;
        this.scheduleReconnect(`socket closed (${String(info.code)} ${info.reason})`);
      };
      socket.onError = (error) => {
        if (this.stopped || this.socket !== socket) return;
        const message = error instanceof Error ? error.message : String(error);
        if (this.pruneInvalidSymbolAndReconnect(message)) return;
        this.scheduleReconnect(`socket error: ${message}`);
      };
    } catch (err: unknown) {
      if (err instanceof TradierAuthInvalidError) {
        this.authInvalidTripped = true;
        this.reportError(err.message);
        const current = this.socket;
        this.socket = null;
        current?.close(1000, 'auth_invalid');
        this.setState('AUTH_INVALID');
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.scheduleReconnect(message);
    }
  }

  private pruneInvalidSymbolAndReconnect(rawReason: string): boolean {
    const invalidSymbol = extractInvalidTradierSymbol(rawReason);
    if (invalidSymbol === null) {
      return false;
    }
    this.rejectedSymbols.add(invalidSymbol);
    const nextSymbols = this.subscribedSymbols.filter((s) => s !== invalidSymbol);
    if (nextSymbols.length === this.subscribedSymbols.length) {
      return false;
    }
    this.subscribedSymbols = nextSymbols;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const current = this.socket;
    this.socket = null;
    if (current !== null) {
      current.onOpen = null;
      current.onMessage = null;
      current.onClose = null;
      current.onError = null;
      current.close(1000, 'prune_invalid_symbol');
    }
    if (this.subscribedSymbols.length === 0) {
      this.scheduleReconnect(`all symbols rejected (last: ${invalidSymbol})`);
      return true;
    }
    this.lastError = null;
    this.reconnectAttempts = 0;
    void this.connectCycle(true);
    return true;
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return;
    this.reportError(reason);
    const current = this.socket;
    this.socket = null;
    current?.close(1000, 'reconnect');
    this.reconnectAttempts += 1;
    this.setState('RECONNECTING');
    const backoff = Math.min(
      this.reconnectMaxDelayMs,
      this.reconnectBaseDelayMs * Math.pow(2, Math.min(this.reconnectAttempts, 6)),
    );
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectCycle();
    }, backoff);
    this.reconnectTimer.unref();
  }

  private ingestFrames(text: string): void {
    const events = parseStreamFrame(text);
    for (const event of events) {
      const type = typeof event['type'] === 'string' ? event['type'].trim().toUpperCase() : '';
      if (type === 'OK') {
        this.setState('CONNECTED');
        continue;
      }
      if (type === 'ERROR') {
        const message = typeof event['message'] === 'string' ? event['message'] : 'stream ERROR';
        if (this.pruneInvalidSymbolAndReconnect(message)) {
          return;
        }
        this.scheduleReconnect(`stream ERROR: ${message}`);
        continue;
      }
      const rawType = typeof event['type'] === 'string' ? event['type'].trim().toLowerCase() : '';
      const eventName =
        typeof event['event'] === 'string' && event['event'].trim() !== ''
          ? event['event'].trim().toLowerCase()
          : rawType;
      if (
        eventName !== 'trade' &&
        eventName !== 'quote' &&
        eventName !== 'timesale' &&
        eventName !== 'summary'
      ) {
        continue;
      }
      if (eventName === 'timesale' && (event['cancel'] === true || event['correction'] === true)) {
        continue;
      }
      const symbol = typeof event['symbol'] === 'string' ? event['symbol'].trim().toUpperCase() : '';
      if (symbol === '' || !this.subscribedSymbols.includes(symbol)) continue;
      this.ingestStreamEvent(symbol, eventName, event);
    }
  }

  private ingestStreamEvent(
    symbol: string,
    eventName: TradierStreamEventKind,
    event: Record<string, unknown>,
  ): void {
    const nowSec = Math.floor(this.nowMsFn() / 1_000);
    const eventAsOfSec = tradierEventTimeToUtcSec(
      event['date'] ?? event['biddate'] ?? event['askdate'],
    );
    const existing = this.latest.get(symbol);
    const next: MutableLiveQuoteState = existing ?? {
      symbol,
      price: Number.NaN,
      bid: Number.NaN,
      bidSize: Number.NaN,
      ask: Number.NaN,
      askSize: Number.NaN,
      cumulativeVolume: Number.NaN,
      previousClose: Number.NaN,
      asOfUtcSec: Number.NaN,
    };

    if (eventName === 'trade' || eventName === 'timesale') {
      const price = priceNum(event['last'] ?? event['price']);
      if (Number.isFinite(price)) next.price = price;
      const bid = priceNum(event['bid']);
      const ask = priceNum(event['ask']);
      if (Number.isFinite(bid)) next.bid = bid;
      if (Number.isFinite(ask)) next.ask = ask;
      const size = countNum(event['size']);
      const cumVol = countNum(event['cumvol'] ?? event['cumsize']);
      if (Number.isFinite(cumVol) && (!Number.isFinite(next.cumulativeVolume) || cumVol >= next.cumulativeVolume)) {
        next.cumulativeVolume = cumVol;
      } else if (Number.isFinite(size) && !Number.isFinite(next.cumulativeVolume)) {
        next.cumulativeVolume = size;
      }
    } else if (eventName === 'quote') {
      const bid = priceNum(event['bid']);
      const ask = priceNum(event['ask']);
      if (Number.isFinite(bid)) next.bid = bid;
      if (Number.isFinite(ask)) next.ask = ask;
      const bidSize = countNum(event['bidsz']);
      const askSize = countNum(event['asksz']);
      if (Number.isFinite(bidSize)) next.bidSize = bidSize;
      if (Number.isFinite(askSize)) next.askSize = askSize;
      const mid = Number.isFinite(next.bid) && Number.isFinite(next.ask) && next.ask >= next.bid && next.bid > 0
        ? 0.5 * (next.bid + next.ask)
        : Number.NaN;
      if (Number.isFinite(mid)) next.price = mid;
    } else {
      const last = priceNum(event['last']);
      if (Number.isFinite(last)) next.price = last;
      const prevClose = priceNum(event['prevclose']);
      if (Number.isFinite(prevClose)) next.previousClose = prevClose;
      const volume = countNum(event['volume']);
      if (Number.isFinite(volume) && !Number.isFinite(next.cumulativeVolume)) next.cumulativeVolume = volume;
    }

    next.asOfUtcSec =
      Number.isFinite(eventAsOfSec) && eventAsOfSec > 0
        ? eventAsOfSec
        : Number.isFinite(next.asOfUtcSec) && next.asOfUtcSec > 0
          ? next.asOfUtcSec
          : nowSec;
    this.latest.set(symbol, next);
    this.lastTickAtUtcSec = nowSec;
    const receivedAtMs = this.nowMsFn();
    this.telemetry.record({
      atMs: receivedAtMs,
      latencyMs:
        Number.isFinite(eventAsOfSec) && eventAsOfSec > 0
          ? receivedAtMs - eventAsOfSec * 1_000
          : null,
      isValidTick: true,
    });

    const tick: TradierStreamTick = {
      symbol,
      event: eventName,
      price: next.price,
      size: countNum(event['size']),
      bid: next.bid,
      bidSize: next.bidSize,
      ask: next.ask,
      askSize: next.askSize,
      open: eventName === 'summary' ? priceNum(event['open']) : Number.NaN,
      high: eventName === 'summary' ? priceNum(event['high']) : Number.NaN,
      low: eventName === 'summary' ? priceNum(event['low']) : Number.NaN,
      cumulativeVolume: next.cumulativeVolume,
      previousClose: next.previousClose,
      sessionPhase: getUsEquitySessionPhase(next.asOfUtcSec),
      asOfUtcSec: next.asOfUtcSec,
      provider: 'TRADIER',
    };
    this.onTickCb?.(tick);
  }
}

/**
 * Helper de alto nivel equivalente a `startTradierMarketStream(symbols, onTick)`:
 * crea el manager, inicia el stream y devuelve el handle para consultarlo/detenerlo.
 */
export async function startTradierMarketStream(
  symbols: readonly string[],
  onTick: (tick: TradierStreamTick) => void,
  deps: TradierLiveManagerDeps,
): Promise<TradierLiveManager> {
  const manager = new TradierLiveManager({ ...deps, onTick });
  await manager.start(symbols);
  return manager;
}
