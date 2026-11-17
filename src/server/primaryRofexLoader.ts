/**
 * Conectores reales para Primary API v1.21 (reMarkets / MATBA ROFEX + MERV,
 * y entorno productivo Eco Valores XOMS `api.eco.xoms.com.ar`) y cliente
 * consumidor del puente local Bull Market Brokers (HomeBroker SignalR, broker 153).
 *
 * Soporte multi-mercado (Pieza XOMS L2):
 *  - `PRIMARY_BASE_URL` (default `https://api.remarkets.primary.com.ar`, soporta
 *    `https://api.eco.xoms.com.ar`); `PRIMARY_WS_URL` se deriva automáticamente
 *    (`wss://...`) si no está definida.
 *  - Credenciales `PRIMARY_USERNAME`/`PRIMARY_PASSWORD` con fallback opcional
 *    `ECO_MATRIZ_USERNAME`/`ECO_MATRIZ_PASSWORD`.
 *  - Descubrimiento dinámico por `GET /rest/instruments/all`: universo BYMA
 *    (MERV) — GGAL 24hs/T1 + CI, líderes Merval, CEDEARs y opciones `GFGC`/`GFGV` —
 *    más la curva `DLR/*` outright (ROFX), suscriptos con `level: 2` y puntas
 *    BI/OF hasta 5 niveles.
 *
 * Seguridad y Zero Silent Fallbacks:
 *  - Lee credenciales exclusivamente desde `process.env` (o `env` inyectado en tests).
 *  - Nunca hardcodea ni expone `PRIMARY_PASSWORD`, `PRIMARY_USERNAME`,
 *    `ECO_MATRIZ_USERNAME`, `ECO_MATRIZ_PASSWORD`, `BMB_PASSWORD`,
 *    `BMB_DNI`, `BMB_USERNAME` ni `X-Auth-Token` en respuestas HTTP, WebSocket o logs.
 *  - Toda cadena matemática pura (devaluación directa, TNA/TEA base 365, métricas L2 5 puntas,
 *    TEA de cauciones, decisión de tick ARS de GGAL) vive en funciones puras sin red que
 *    devuelven `NaN` si faltan datos.
 *  - Si un mercado está cerrado (fin de semana) o falta `pyhomebroker`/`BMB_PASSWORD`,
 *    degrada explícitamente con badges y estados reales sin inventar puntas ni precios.
 */

import { WebSocket } from 'ws';
import type { FetchResponse } from '../data/types.js';
import {
  RollingFeedTelemetry,
  type FeedTelemetrySnapshot,
} from './feedsHealthMonitor.js';
import { redactSecrets, SingleFlightRuntimeCache } from './runtimeCache.js';

export type PrimaryHttpFn = (
  url: string,
  init?: {
    readonly method?: 'GET' | 'POST';
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly timeoutMs?: number;
  },
) => Promise<FetchResponse>;

export interface PrimaryWsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'open' | 'close', listener: () => void): unknown;
  on(event: 'message', listener: (data: unknown) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export type PrimaryWsFactory = (
  url: string,
  headers: Readonly<Record<string, string>>,
) => PrimaryWsLike;

/** Opciones de suscripción WS `smd` (level/entries por grupo de stream). */
export interface PrimaryWsSubscribeOptions {
  readonly level?: number;
  readonly entries?: readonly string[];
}

interface WsSubscriptionGroup {
  readonly level: number;
  readonly entries: readonly string[];
  readonly depth: number;
  products: readonly { readonly marketId: string; readonly symbol: string }[];
}

export interface PrimaryConfig {
  readonly apiUrl: string;
  readonly wsUrl: string;
  readonly username: string;
  readonly password: string;
  readonly account: string;
  readonly configured: boolean;
}

export interface BmbConfig {
  readonly bridgeUrl: string;
  readonly brokerId: number;
  readonly dni: string;
  readonly username: string;
  readonly password: string;
  readonly account: string;
  /** Cookie de sesión / dispositivo de confianza (opcional, `BMB_SESSION_COOKIE`). */
  readonly sessionCookie: string;
  /** Token del hub ASP.NET Core SignalR (opcional, `BMB_HUB_TOKEN`). */
  readonly hubToken: string;
  readonly passwordConfigured: boolean;
}

export interface OrderBookLevel {
  readonly price: number;
  readonly size: number;
  readonly orderCount?: number | null;
}

export interface OrderBookL2Metrics {
  readonly bestBid: number;
  readonly bestAsk: number;
  readonly mid: number;
  readonly spread: number;
  readonly spreadPct: number;
  readonly bidDepthSize: number;
  readonly askDepthSize: number;
  readonly bidDepthNotional: number;
  readonly askDepthNotional: number;
  readonly vwapBid5: number;
  readonly vwapAsk5: number;
  readonly vwapBook5: number;
  readonly obi5: number;
}

export interface DlrContractMetricsInput {
  readonly asOfUtcSec: number;
  readonly maturityDate: string | null | undefined;
  readonly last: number | null | undefined;
  readonly bestBid: number | null | undefined;
  readonly bestAsk: number | null | undefined;
  readonly settlement: number | null | undefined;
  readonly close: number | null | undefined;
  readonly a3500: number | null | undefined;
  readonly dlrSpot: number | null | undefined;
}

export type DlrPriceBasis = 'LAST' | 'MID' | 'SETTLEMENT_EOD' | 'NONE';

export interface DlrContractMetricsResult {
  readonly priceBasis: DlrPriceBasis;
  readonly referencePrice: number;
  readonly spotUsed: number;
  readonly spotSource: 'A3500_BCRA' | 'DLR_SPOT' | 'NONE';
  readonly maturityUtcSec: number;
  readonly days: number;
  readonly devalDirectaPct: number;
  readonly tnaImplicitaPct: number;
  readonly teaImplicitaPct: number;
  readonly temImplicitaPct: number;
}

export type DlrContractCategory = 'OUTRIGHT' | 'MINI' | 'SPREAD' | 'OPTION' | 'SPOT' | 'OTHER';

export interface PrimaryDlrContractDto {
  readonly contract: string;
  readonly category: DlrContractCategory;
  readonly marketId: string;
  readonly maturity: string | null;
  readonly expiryUtcSec: number | null;
  readonly days: number | null;
  readonly price: number | null;
  readonly priceBasis: DlrPriceBasis;
  readonly last: number | null;
  readonly settlement: number | null;
  readonly close: number | null;
  readonly bid: number | null;
  readonly bidPrice?: number | null;
  readonly bidSize: number | null;
  readonly ask: number | null;
  readonly askPrice?: number | null;
  readonly askSize: number | null;
  readonly bids: readonly OrderBookLevel[];
  readonly asks: readonly OrderBookLevel[];
  readonly openInterest: number | null;
  readonly nominalVolume: number | null;
  readonly open: number | null;
  readonly high: number | null;
  readonly low: number | null;
  readonly spotUsed: number | null;
  readonly spotSource: 'A3500_BCRA' | 'DLR_SPOT' | 'NONE';
  readonly devalDirectaPct: number | null;
  readonly tnaImplicitaPct: number | null;
  readonly teaImplicitaPct: number | null;
  readonly temImplicitaPct: number | null;
  readonly forwardToForwardPct: number | null;
  readonly contractMultiplier: number | null;
  readonly minPriceIncrement: number | null;
  readonly updatedAtUtcSec: number | null;
  readonly source: 'PRIMARY_ROFEX';
}

export interface OrderBook5LevelsDto {
  readonly symbol: string;
  readonly marketSymbol: string;
  readonly settlement: string;
  readonly marketState: 'LIVE' | 'WEEKEND_CLOSED' | 'UNAVAILABLE';
  readonly source: 'PRIMARY_MERV' | 'BMB_HOMEBROKER' | 'BYMA_L1_ONLY';
  readonly asOfUtcSec: number | null;
  readonly bids: readonly OrderBookLevel[];
  readonly asks: readonly OrderBookLevel[];
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly mid: number | null;
  readonly spreadArs: number | null;
  readonly spreadPct: number | null;
  readonly bidDepthSize: number | null;
  readonly askDepthSize: number | null;
  readonly vwapBid5: number | null;
  readonly vwapAsk5: number | null;
  readonly vwapBook5: number | null;
  readonly obi5: number | null;
  readonly last: number | null;
  readonly open: number | null;
  readonly high: number | null;
  readonly low: number | null;
  readonly close: number | null;
  readonly settlementPrice: number | null;
  readonly nominalVolume: number | null;
}

export interface BrokerPositionDto {
  readonly symbol: string;
  readonly marketId: string | null;
  readonly buySize: number;
  readonly sellSize: number;
  readonly netSize: number;
  readonly buyPrice: number | null;
  readonly sellPrice: number | null;
  readonly totalDailyDiffArs: number | null;
  readonly totalDiffArs: number | null;
  readonly source: 'PRIMARY_ROFEX' | 'BMB_HOMEBROKER';
}

export interface BrokerCurrencyBalanceDto {
  readonly currency: string;
  readonly consumed: number | null;
  readonly available: number | null;
}

export interface BrokerAccountSummaryDto {
  readonly broker: 'PRIMARY_REMARKETS' | 'BMB_HOMEBROKER';
  readonly accountLabel: string | null;
  readonly status: 'OK' | 'DISABLED' | 'UNAVAILABLE' | 'ERROR';
  readonly collateral: number | null;
  readonly margin: number | null;
  readonly availableToCollateral: number | null;
  readonly cashTotalArs: number | null;
  readonly pendingMovementsArs: number | null;
  readonly lastCalculationMs: number | null;
  readonly marketMember: string | null;
  readonly currencyBalances: readonly BrokerCurrencyBalanceDto[];
  readonly error: string | null;
}

export interface ArBrokerPositionsResponse {
  readonly asOfUtcSec: number;
  readonly primaryStatus: 'OK' | 'DISABLED' | 'UNAVAILABLE' | 'ERROR';
  readonly bmbStatus: BmbConnectorHealthDto['status'];
  readonly primaryAccount: BrokerAccountSummaryDto;
  readonly bmbAccountLabel: string | null;
  readonly positions: readonly BrokerPositionDto[];
  readonly providerErrors: readonly string[];
}

export interface BmbCaucionRowDto {
  readonly symbol: string;
  readonly termDays: number;
  readonly currency: 'ARS' | 'USD';
  readonly tnaWeighted: number | null;
  readonly teaEffective: number | null;
  readonly bidTna: number | null;
  readonly askTna: number | null;
  readonly turnoverArs: number | null;
  readonly spreadVsBadlarBps: number | null;
  readonly asOfUtcSec: number | null;
  readonly source: 'BMB_HOMEBROKER' | 'BCRA_LECAP_REF';
}

export interface BmbBridgeBookEntry {
  readonly symbol: string;
  readonly settlement: string;
  readonly bids: readonly OrderBookLevel[];
  readonly asks: readonly OrderBookLevel[];
  readonly asOfUtcSec: number | null;
  readonly source: 'BMB_HOMEBROKER';
}

export interface BmbOptionRowDto {
  readonly symbol: string;
  readonly underlying: string | null;
  readonly bid: number | null;
  readonly bidSize: number | null;
  readonly ask: number | null;
  readonly askSize: number | null;
  readonly last: number | null;
  readonly volume: number | null;
  readonly turnover: number | null;
  readonly varPct: number | null;
  readonly asOfUtcSec: number | null;
}

export interface BmbTradeRowDto {
  readonly sequence: number;
  readonly symbol: string;
  readonly timeSec: number;
  readonly price: number;
  readonly size: number;
  readonly side: 'BUY' | 'SELL' | 'UNKNOWN';
  readonly buyVolume: number | null;
  readonly sellVolume: number | null;
  readonly attributableToLast?: boolean;
}

export interface BmbConnectorHealthDto {
  readonly status:
    | 'READY'
    | 'CONNECTED_L2'
    | 'OUT_OF_SESSION'
    | 'STANDBY_2FA'
    | 'MISSING_DEPENDENCY'
    | 'DISABLED_NO_PASSWORD'
    | 'CONNECTING'
    | 'DISCONNECTED'
    | 'OFFLINE'
    | 'ERROR';
  readonly brokerId: number;
  readonly accountLabel: string | null;
  readonly pyhomebrokerInstalled: boolean | null;
  readonly passwordConfigured: boolean;
  readonly connected: boolean;
  readonly lastUpdateUtcSec: number | null;
  readonly counts: {
    readonly cauciones: number;
    readonly orderBooks: number;
    readonly options: number;
  };
  readonly error: string | null;
}

export interface BmbBridgeSnapshotDto {
  readonly health: BmbConnectorHealthDto;
  readonly cauciones: readonly BmbCaucionRowDto[];
  readonly orderBooksBySymbol: Readonly<Record<string, BmbBridgeBookEntry>>;
  readonly options: readonly BmbOptionRowDto[];
  readonly tradesBySymbol?: Readonly<Record<string, readonly BmbTradeRowDto[]>>;
  readonly telemetry?: BmbBridgeTelemetryDto;
}

export interface BmbBridgeTelemetryDto {
  readonly totalMessagesReceived: number;
  readonly lastMessageAtMs: number | null;
}

export interface PrimaryConnectorHealthDto {
  readonly configured: boolean;
  readonly apiUrl: string;
  readonly accountLabel: string | null;
  readonly authenticated: boolean;
  readonly tokenValidUntilUtcSec: number | null;
  readonly tokenRenewCount: number;
  readonly wsConnected: boolean;
  readonly wsEnvironment: 'PRIMARY_MATRIZ_WS' | 'PRIMARY_ECO_XOMS_WS' | 'PRIMARY_REMARKETS_SANDBOX';
  readonly wsLastMessageUtcSec: number | null;
  readonly dlrCount: number;
  readonly liveDlrCount: number;
  readonly liveDlrLastUpdateUtcSec: number | null;
  readonly dlrSubscribedCount: number;
  readonly mervSubscribedCount: number;
  readonly liveMervBookCount: number;
  readonly ddfCount: number;
  readonly mervCount: number;
  readonly lastError: string | null;
}

interface ParsedPrimaryMarketData {
  readonly symbol: string;
  readonly marketId: string;
  readonly bids: readonly OrderBookLevel[];
  readonly asks: readonly OrderBookLevel[];
  readonly last: number | null;
  readonly settlement: number | null;
  readonly close: number | null;
  readonly open: number | null;
  readonly high: number | null;
  readonly low: number | null;
  readonly openInterest: number | null;
  readonly nominalVolume: number | null;
  readonly impliedVol: number | null;
  readonly updatedAtUtcSec: number | null;
  /** Pieza 41: timestamp del trade LA, distinto del freshness del libro. */
  readonly lastTradeAtUtcSec?: number | null;
  /** Pieza 41: monto negociado real si el proveedor entrega `TV`. */
  readonly turnover?: number | null;
  /** Pieza 41: timestamp del frame; se usa para stale, no como fecha del trade. */
  readonly frameAtUtcSec?: number | null;
}

export interface PrimaryMervMarketDataFrame {
  readonly symbol: string;
  readonly marketId: string;
  readonly ticker: string | null;
  readonly settlement: string | null;
  readonly snapshot: ParsedPrimaryMarketData;
  readonly receivedAtUtcSec: number;
}

interface InstrumentDetailMetadata {
  readonly symbol: string;
  readonly marketId: string;
  readonly segmentId: string | null;
  readonly cficode: string | null;
  readonly maturityDate: string | null;
  readonly contractMultiplier: number | null;
  readonly minPriceIncrement: number | null;
}

const DEFAULT_PRIMARY_API_URL = 'https://api.remarkets.primary.com.ar';
const DEFAULT_PRIMARY_WS_URL = 'wss://api.remarkets.primary.com.ar/';
const DEFAULT_BMB_BRIDGE_URL = 'http://127.0.0.1:8788';
const DEFAULT_PRIMARY_TIMEOUT_MS = 8_000;
const DEFAULT_BMB_TIMEOUT_MS = 1_200;
const PRIMARY_TOKEN_MAX_AGE_MS = 23 * 60 * 60 * 1_000; // Renovar < 24h por especificación Primary v1.21
const PRIMARY_TOKEN_PROACTIVE_RENEW_MS = 12 * 60 * 60 * 1_000; // Renovación proactiva cada 12 h
const PRIMARY_WS_HEARTBEAT_MS = 20_000;
const PRIMARY_WS_RECONNECT_BASE_MS = 1_000;
const PRIMARY_WS_RECONNECT_MAX_MS = 30_000;
const DETAIL_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
const MD_CACHE_TTL_MS = 10_000;
const BMB_CACHE_TTL_MS = 8_000;
// Pacing anti-429: intervalo mínimo entre requests REST de descubrimiento y backoff
// mínimo ante HTTP 429 (se respeta `Retry-After` cuando es mayor, con tope de 60 s).
const DEFAULT_PRIMARY_MIN_REQUEST_INTERVAL_MS = 350;
const DEFAULT_PRIMARY_RETRY_429_DELAY_MS = 15_000;
const PRIMARY_429_BACKOFF_MAX_MS = 60_000;

// Suscripción WS por defecto (stream DLR/*, level 5 con OI/IV/SE).
const DEFAULT_DLR_SMD_ENTRIES: readonly string[] = ['BI', 'OF', 'LA', 'OI', 'IV', 'SE'];
// Stream productivo Eco Valores XOMS — L2 BYMA 5 puntas: mensaje `smd` level 2 con
// entradas BI/OF/LA/OP/CL/SE/HI/LO/NV/OI y puntas hasta `depth` 5 niveles por lado
// (la profundidad del book es el parámetro `depth` según Primary API v1.21).
const BYMA_L2_SMD_LEVEL = 2;
const BYMA_L2_SMD_ENTRIES: readonly string[] = ['BI', 'OF', 'LA', 'OP', 'CL', 'SE', 'HI', 'LO', 'NV', 'OI'];
const BYMA_L2_SMD_DEPTH = 5;
// Edad máxima del snapshot WS de MERV para servir el libro L2 en vivo sin REST.
const LIVE_MERV_WS_MAX_AGE_SEC = 30;

const ROFEX_MONTH_TO_NUM: Readonly<Record<string, number>> = {
  ENE: 1,
  JAN: 1,
  FEB: 2,
  MAR: 3,
  ABR: 4,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AGO: 8,
  AUG: 8,
  SEP: 9,
  SET: 9,
  OCT: 10,
  NOV: 11,
  DIC: 12,
  DEC: 12,
};

function sanitizeNum(v: number): number | null {
  return Number.isFinite(v) ? v : null;
}

function posFiniteOrNaN(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : Number.NaN;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNum(obj: Readonly<Record<string, unknown>>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const raw = obj[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return raw;
    }
    if (typeof raw === 'string' && raw.trim() !== '') {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function readStr(obj: Readonly<Record<string, unknown>>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const raw = obj[key];
    if (typeof raw === 'string' && raw.trim() !== '') {
      return raw.trim();
    }
  }
  return null;
}

function toUtcSecFromMixed(raw: number | null): number | null {
  if (raw === null || !Number.isFinite(raw) || raw <= 0) {
    return null;
  }
  return raw > 10_000_000_000 ? Math.floor(raw / 1_000) : Math.floor(raw);
}

async function defaultPrimaryHttpFn(
  url: string,
  init?: {
    readonly method?: 'GET' | 'POST';
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly timeoutMs?: number;
  },
): Promise<FetchResponse> {
  const timeoutMs = init?.timeoutMs ?? DEFAULT_PRIMARY_TIMEOUT_MS;
  const response = await fetch(url, {
    method: init?.method ?? 'GET',
    headers: init?.headers ?? { Accept: 'application/json' },
    ...(init?.body !== undefined ? { body: init.body } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return {
    ok: response.ok,
    status: response.status,
    text: await response.text(),
    headers,
  };
}

/**
 * Deriva la URL WebSocket de Primary a partir de la URL REST: `https://host` ->
 * `wss://host/` (y `http://` -> `ws://`). Devuelve `null` si la URL no es http(s).
 */
export function derivePrimaryWsUrlFromApiUrl(apiUrl: string): string | null {
  const clean = apiUrl.trim().replace(/\/+$/, '');
  if (clean === '') {
    return null;
  }
  if (/^https:\/\//i.test(clean)) {
    return `wss://${clean.slice('https://'.length)}/`;
  }
  if (/^http:\/\//i.test(clean)) {
    return `ws://${clean.slice('http://'.length)}/`;
  }
  return null;
}

function pickEnvValue(env: NodeJS.ProcessEnv, ...keys: readonly string[]): string {
  for (const key of keys) {
    const value = (env[key] ?? '').trim();
    if (value !== '') {
      return value;
    }
  }
  return '';
}

/**
 * Lee la configuración Primary exclusivamente desde `env` (`process.env` por defecto).
 *
 * Multi-mercado Eco Valores XOMS: `PRIMARY_BASE_URL` tiene prioridad sobre el legacy
 * `PRIMARY_API_URL` (default `https://api.remarkets.primary.com.ar`, soporta
 * `https://api.eco.xoms.com.ar`); `PRIMARY_WS_URL` se deriva automáticamente como
 * `wss://host/` si no está definida. Credenciales `PRIMARY_USERNAME`/`PRIMARY_PASSWORD`
 * con fallback opcional `ECO_MATRIZ_USERNAME`/`ECO_MATRIZ_PASSWORD`.
 */
export function loadPrimaryConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PrimaryConfig {
  const apiRaw = pickEnvValue(env, 'PRIMARY_BASE_URL', 'PRIMARY_API_URL');
  const apiUrl = (apiRaw !== '' ? apiRaw : DEFAULT_PRIMARY_API_URL).replace(/\/+$/, '');
  const wsExplicit = pickEnvValue(env, 'PRIMARY_WS_URL');
  const wsDerived = derivePrimaryWsUrlFromApiUrl(apiUrl);
  const wsUrl = wsExplicit !== '' ? wsExplicit : (wsDerived ?? DEFAULT_PRIMARY_WS_URL);
  const username = pickEnvValue(env, 'PRIMARY_USERNAME', 'ECO_MATRIZ_USERNAME');
  const password = pickEnvValue(env, 'PRIMARY_PASSWORD', 'ECO_MATRIZ_PASSWORD');
  const account = (env['PRIMARY_ACCOUNT'] ?? '').trim();

  return {
    apiUrl,
    wsUrl,
    username,
    password,
    account,
    configured: username !== '' && password !== '',
  };
}

/**
 * Lee configuración de Bull Market Bridge exclusivamente desde `env` (`process.env` por defecto).
 */
export function loadBmbConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BmbConfig {
  const bridgeUrl = (env['BMB_BRIDGE_URL'] ?? DEFAULT_BMB_BRIDGE_URL).trim().replace(/\/+$/, '');
  const rawBroker = (env['BMB_BROKER_ID'] ?? '153').trim();
  const parsedBroker = Number(rawBroker);
  const brokerId = Number.isInteger(parsedBroker) && parsedBroker > 0 ? parsedBroker : 153;
  const dni = (env['BMB_DNI'] ?? '').trim();
  const username = (env['BMB_USERNAME'] ?? env['BMB_USER'] ?? '').trim();
  const password = (env['BMB_PASSWORD'] ?? env['BMB_PASS'] ?? '').trim();
  const account = (env['BMB_ACCOUNT'] ?? env['BMB_COMITENTE'] ?? '').trim();
  const sessionCookie = (env['BMB_SESSION_COOKIE'] ?? '').trim();
  const hubToken = (env['BMB_HUB_TOKEN'] ?? '').trim();

  return {
    bridgeUrl: bridgeUrl || DEFAULT_BMB_BRIDGE_URL,
    brokerId,
    dni,
    username,
    password,
    account,
    sessionCookie,
    hubToken,
    passwordConfigured: password !== '',
  };
}

/**
 * Modo conector SignalR Core (Pieza 38): con `BMB_HUB_TOKEN` o
 * `BMB_SESSION_COOKIE` presente, `bmbFeedAdapter.ts` inicia
 * `tools/bmb_inversiones_signalr.py` en lugar del flujo legacy `pyhomebroker`.
 */
export function isBmbInversionesSignalRConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const hubToken = (env['BMB_HUB_TOKEN'] ?? '').trim();
  const sessionCookie = (env['BMB_SESSION_COOKIE'] ?? '').trim();
  return hubToken !== '' || sessionCookie !== '';
}

/**
 * Sanea query strings con credenciales (`?token=...`, `&id=...`) antes de
 * exponer cualquier texto diagnóstico en logs o `lastError`. Complementa (no
 * reemplaza) `redactSecrets` con los secretos de env.
 */
export function redactHubQueryCredentials(text: string): string {
  return text.replace(/([?&])(token|id)=[^&\s"']+/g, '$1$2=[REDACTED]');
}

/**
 * Recolecta credenciales sensibles (sin incluir etiquetas no secretas como REM22710) para `redactSecrets`.
 * Incluye las credenciales del entorno productivo Eco Valores XOMS (`ECO_MATRIZ_*`).
 */
export function collectBrokerSecretsFromEnv(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const names = [
    'PRIMARY_PASSWORD',
    'PRIMARY_USERNAME',
    'ECO_MATRIZ_PASSWORD',
    'ECO_MATRIZ_USERNAME',
    'BMB_PASSWORD',
    'BMB_PASS',
    'BMB_DNI',
    'BMB_USERNAME',
    'BMB_USER',
    'BMB_ACCOUNT',
    'BMB_COMITENTE',
    'BMB_SESSION_COOKIE',
    'BMB_HUB_TOKEN',
    // Pieza 41.1: proveedores US y aliases canónicos/compatibles.
    'FMP_API_KEY',
    'FMP_KEY_QUOTES',
    'FMP_KEY_MARKET',
    'FMP_KEY_ETF',
    'FMP_KEY_MACRO',
    'MASSIVE_API_KEY',
    'MASSIVE_WS_STOCKS_KEY',
    'MASSIVE_REST_KEY',
    'MASSIVE_REST_KEYS',
    'TRADIER_ACCESS_TOKEN',
    'TRADIER_TOKEN',
    'TRADIER_API_TOKEN',
    'TRADIER_LIVE_TOKEN',
    'TRADIER_SANDBOX_TOKEN',
    'TRADIER_SANDBOX_API_TOKEN',
    'ORATS_API_TOKEN',
    'ORATS_API_KEY',
    'IOL_USERNAME',
    'IOL_PASSWORD',
    'IOL_REFRESH_TOKEN',
  ] as const;
  const out = new Set<string>();
  for (const key of names) {
    const val = (env[key] ?? '').trim();
    if (val !== '') {
      out.add(val);
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Funciones matemáticas puras (verificadas contra fixtures Python < 1e-9)
// ---------------------------------------------------------------------------

/**
 * Parsea fecha `YYYYMMDD` de Primary (`maturityDate`) a segundos UTC (18:00:00Z).
 * Devuelve `NaN` si la fecha es ausente o inválida.
 */
export function parsePrimaryMaturityUtcSec(maturityDate: string | null | undefined): number {
  if (typeof maturityDate !== 'string') {
    return Number.NaN;
  }
  const clean = maturityDate.trim();
  if (!/^\d{8}$/.test(clean)) {
    return Number.NaN;
  }
  const year = Number(clean.slice(0, 4));
  const month = Number(clean.slice(4, 6));
  const day = Number(clean.slice(6, 8));
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return Number.NaN;
  }
  const ms = Date.UTC(year, month - 1, day, 18, 0, 0);
  const check = new Date(ms);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day
  ) {
    return Number.NaN;
  }
  return Math.floor(ms / 1_000);
}

/**
 * Inferencia estructural auxiliar de último día hábil de mes para tickers `DLR/MMMYY[M]`
 * cuando `/rest/instruments/detail` no provea `maturityDate`.
 */
export function inferDlrMaturityDateStr(symbol: string): string | null {
  const match = /^DLR\/([A-Z]{3})(\d{2})M?$/i.exec(symbol.trim());
  if (match === null) {
    return null;
  }
  const monthAbbr = match[1]?.toUpperCase() ?? '';
  const yy = Number(match[2]);
  const month = ROFEX_MONTH_TO_NUM[monthAbbr];
  if (month === undefined || !Number.isInteger(yy)) {
    return null;
  }
  const year = 2_000 + yy;
  const cursor = new Date(Date.UTC(year, month, 0, 18, 0, 0));
  while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  const mStr = String(cursor.getUTCMonth() + 1).padStart(2, '0');
  const dStr = String(cursor.getUTCDate()).padStart(2, '0');
  return `${String(cursor.getUTCFullYear())}${mStr}${dStr}`;
}

/**
 * Calcula métricas puras de un contrato futuro DLR/ROFEX contra Spot (A3500 BCRA / DLR/SPOT) en base 365.
 * Prioridad de precio de referencia: `LA -> mid(BI, OF) -> SE -> CL`.
 */
export function computeDlrContractMetrics(input: DlrContractMetricsInput): DlrContractMetricsResult {
  const la = posFiniteOrNaN(input.last);
  const bi = posFiniteOrNaN(input.bestBid);
  const of = posFiniteOrNaN(input.bestAsk);
  const se = posFiniteOrNaN(input.settlement);
  const cl = posFiniteOrNaN(input.close);

  let priceBasis: DlrPriceBasis = 'NONE';
  let referencePrice = Number.NaN;

  if (Number.isFinite(la)) {
    referencePrice = la;
    priceBasis = 'LAST';
  } else if (Number.isFinite(bi) && Number.isFinite(of)) {
    referencePrice = 0.5 * (bi + of);
    priceBasis = 'MID';
  } else if (Number.isFinite(se)) {
    referencePrice = se;
    priceBasis = 'SETTLEMENT_EOD';
  } else if (Number.isFinite(cl)) {
    referencePrice = cl;
    priceBasis = 'SETTLEMENT_EOD';
  }

  const a3500 = posFiniteOrNaN(input.a3500);
  const dlrSpot = posFiniteOrNaN(input.dlrSpot);
  let spotUsed = Number.NaN;
  let spotSource: 'A3500_BCRA' | 'DLR_SPOT' | 'NONE' = 'NONE';
  if (Number.isFinite(a3500)) {
    spotUsed = a3500;
    spotSource = 'A3500_BCRA';
  } else if (Number.isFinite(dlrSpot)) {
    spotUsed = dlrSpot;
    spotSource = 'DLR_SPOT';
  }

  const maturityUtcSec = parsePrimaryMaturityUtcSec(input.maturityDate);
  const days =
    Number.isFinite(maturityUtcSec) &&
    Number.isFinite(input.asOfUtcSec) &&
    maturityUtcSec > input.asOfUtcSec
      ? Math.max(1, Math.round((maturityUtcSec - input.asOfUtcSec) / 86_400))
      : Number.NaN;

  if (
    !Number.isFinite(referencePrice) ||
    !Number.isFinite(spotUsed) ||
    !Number.isFinite(days) ||
    days <= 0
  ) {
    return {
      priceBasis,
      referencePrice,
      spotUsed,
      spotSource,
      maturityUtcSec,
      days,
      devalDirectaPct: Number.NaN,
      tnaImplicitaPct: Number.NaN,
      teaImplicitaPct: Number.NaN,
      temImplicitaPct: Number.NaN,
    };
  }

  const ratio = referencePrice / spotUsed;
  const devalDirectaPct = (ratio - 1) * 100;
  const tnaImplicitaPct = (ratio - 1) * (365 / days) * 100;
  const teaImplicitaPct = (Math.pow(ratio, 365 / days) - 1) * 100;
  const temImplicitaPct = (Math.pow(ratio, 30 / days) - 1) * 100;

  return {
    priceBasis,
    referencePrice,
    spotUsed,
    spotSource,
    maturityUtcSec,
    days,
    devalDirectaPct,
    tnaImplicitaPct,
    teaImplicitaPct,
    temImplicitaPct,
  };
}

/**
 * Forward-to-forward continuo anualizado entre dos vencimientos consecutivos de la curva DLR:
 * `f = ln(P_far / P_near) / (Δdías / 365)`, expresado en porcentaje.
 * Devuelve `NaN` si falta un precio positivo o el tramo no avanza en el tiempo.
 */
export function computeForwardToForwardPct(input: {
  readonly nearDays: number;
  readonly nearPrice: number;
  readonly farDays: number;
  readonly farPrice: number;
}): number {
  const dtDays = input.farDays - input.nearDays;
  if (
    !Number.isFinite(input.nearDays) ||
    !Number.isFinite(input.farDays) ||
    !Number.isFinite(input.nearPrice) ||
    !Number.isFinite(input.farPrice) ||
    input.nearPrice <= 0 ||
    input.farPrice <= 0 ||
    dtDays <= 0
  ) {
    return Number.NaN;
  }
  return (Math.log(input.farPrice / input.nearPrice) / (dtDays / 365)) * 100;
}

/**
 * Encadena `f_{i,i+1}` por categoría (OUTRIGHT y MINI por separado) sobre una
 * curva ya ordenada por vencimiento. No mezcla mini-contratos con outrigths del
 * mismo mes, que producirían un tramo de ancho cero.
 */
function withForwardToForward(
  contracts: readonly PrimaryDlrContractDto[],
): readonly PrimaryDlrContractDto[] {
  const forwards = new Map<string, number | null>();
  for (const category of ['OUTRIGHT', 'MINI'] as const) {
    const series = contracts.filter((contract) => contract.category === category);
    for (let i = 0; i < series.length - 1; i += 1) {
      const near = series[i];
      const far = series[i + 1];
      if (near === undefined || far === undefined) continue;
      forwards.set(
        near.contract,
        sanitizeNum(
          computeForwardToForwardPct({
            nearDays: near.days ?? Number.NaN,
            nearPrice: near.price ?? Number.NaN,
            farDays: far.days ?? Number.NaN,
            farPrice: far.price ?? Number.NaN,
          }),
        ),
      );
    }
  }
  return contracts.map((contract) => ({
    ...contract,
    forwardToForwardPct: forwards.get(contract.contract) ?? null,
  }));
}

/**
 * Normaliza hasta 5 puntas L2 (Bid desc, Ask asc) y calcula métricas puras de microestructura.
 */
export function computeOrderBookL2Metrics(
  bidsRaw: readonly OrderBookLevel[],
  asksRaw: readonly OrderBookLevel[],
): OrderBookL2Metrics {
  const bids = bidsRaw
    .filter((l) => Number.isFinite(l.price) && l.price > 0 && Number.isFinite(l.size) && l.size >= 0)
    .map((l) => ({ price: l.price, size: l.size }))
    .sort((a, b) => b.price - a.price)
    .slice(0, 5);
  const asks = asksRaw
    .filter((l) => Number.isFinite(l.price) && l.price > 0 && Number.isFinite(l.size) && l.size >= 0)
    .map((l) => ({ price: l.price, size: l.size }))
    .sort((a, b) => a.price - b.price)
    .slice(0, 5);

  const bestBid = bids[0]?.price ?? Number.NaN;
  const bestAsk = asks[0]?.price ?? Number.NaN;

  const hasTop = Number.isFinite(bestBid) && Number.isFinite(bestAsk);
  const mid = hasTop ? 0.5 * (bestBid + bestAsk) : Number.NaN;
  const spread = hasTop ? bestAsk - bestBid : Number.NaN;
  const spreadPct = hasTop && mid > 0 ? (spread / mid) * 100 : Number.NaN;

  const bidDepthSize = bids.length > 0 ? bids.reduce((acc, l) => acc + l.size, 0) : Number.NaN;
  const askDepthSize = asks.length > 0 ? asks.reduce((acc, l) => acc + l.size, 0) : Number.NaN;
  const bidDepthNotional =
    bids.length > 0 ? bids.reduce((acc, l) => acc + l.price * l.size, 0) : Number.NaN;
  const askDepthNotional =
    asks.length > 0 ? asks.reduce((acc, l) => acc + l.price * l.size, 0) : Number.NaN;

  const vwapBid5 =
    Number.isFinite(bidDepthSize) && bidDepthSize > 0
      ? bidDepthNotional / bidDepthSize
      : Number.NaN;
  const vwapAsk5 =
    Number.isFinite(askDepthSize) && askDepthSize > 0
      ? askDepthNotional / askDepthSize
      : Number.NaN;

  const safeBidSize = Number.isFinite(bidDepthSize) ? bidDepthSize : 0;
  const safeAskSize = Number.isFinite(askDepthSize) ? askDepthSize : 0;
  const safeBidNotional = Number.isFinite(bidDepthNotional) ? bidDepthNotional : 0;
  const safeAskNotional = Number.isFinite(askDepthNotional) ? askDepthNotional : 0;
  const totalSize = safeBidSize + safeAskSize;

  const vwapBook5 = totalSize > 0 ? (safeBidNotional + safeAskNotional) / totalSize : Number.NaN;
  const obi5 = totalSize > 0 ? (safeBidSize - safeAskSize) / totalSize : Number.NaN;

  return {
    bestBid,
    bestAsk,
    mid,
    spread,
    spreadPct,
    bidDepthSize,
    askDepthSize,
    bidDepthNotional,
    askDepthNotional,
    vwapBid5,
    vwapAsk5,
    vwapBook5,
    obi5,
  };
}

/**
 * Calcula TEA efectiva (%) en base 365 a partir de TNA (%) y plazo en días.
 */
export function computeCaucionTeaEffectivePct(tnaPct: number, termDays: number): number {
  if (!Number.isFinite(tnaPct) || !Number.isFinite(termDays) || termDays <= 0) {
    return Number.NaN;
  }
  const gross = 1 + (tnaPct / 100) * (termDays / 365);
  if (gross <= 0) {
    return Number.NaN;
  }
  return (Math.pow(gross, 365 / termDays) - 1) * 100;
}

/**
 * Calcula diferencial (bps) entre una TNA y la tasa BADLAR de referencia.
 */
export function computeSpreadVsBadlarBps(tnaPct: number, badlarTnaPct: number): number {
  if (!Number.isFinite(tnaPct) || !Number.isFinite(badlarTnaPct)) {
    return Number.NaN;
  }
  return (tnaPct - badlarTnaPct) * 100;
}

export function classifyDlrSymbol(symbol: string): DlrContractCategory {
  const clean = symbol.trim().toUpperCase();
  if (clean === 'DLR/SPOT') {
    return 'SPOT';
  }
  if (/^DLR\/[A-Z]{3}\d{2}$/.test(clean)) {
    return 'OUTRIGHT';
  }
  if (/^DLR\/[A-Z]{3}\d{2}M$/.test(clean)) {
    return 'MINI';
  }
  if (clean.includes(' ') && (clean.endsWith(' C') || clean.endsWith(' P'))) {
    return 'OPTION';
  }
  if (clean.startsWith('DLR/') && clean.indexOf('/') !== clean.lastIndexOf('/')) {
    return 'SPREAD';
  }
  return 'OTHER';
}

export interface DlrInstrumentRef {
  readonly marketId: string;
  readonly symbol: string;
}

/**
 * Filtra exclusivamente futuros outright de dólar `DLR/MMMYY` (p. ej. `DLR/NOV26`,
 * `DLR/ABR27`): descarta `DLR/SPOT`, minis `DLR/MMMYYM`, opciones, spreads/pases
 * (`DLR/.../... M`) y cualquier símbolo con espacios o segundo `/`. Los contratos
 * con vencimiento conocido y anterior a `todayUtc` (`YYYYMMDD`) se excluyen.
 */
export function filterDlrOutrightProducts(
  instruments: readonly DlrInstrumentRef[],
  todayUtc: string,
  maturityDateBySymbol?: (symbol: string) => string | null,
): readonly DlrInstrumentRef[] {
  const out: DlrInstrumentRef[] = [];
  const seen = new Set<string>();
  for (const item of instruments) {
    if (classifyDlrSymbol(item.symbol) !== 'OUTRIGHT') {
      continue;
    }
    if (seen.has(item.symbol)) {
      continue;
    }
    const maturity =
      maturityDateBySymbol?.(item.symbol) ?? inferDlrMaturityDateStr(item.symbol);
    if (maturity !== null && maturity < todayUtc) {
      continue;
    }
    seen.add(item.symbol);
    out.push(item);
  }
  return out;
}

export function parseMervInstrumentSymbol(rawSymbol: string): {
  readonly ticker: string;
  readonly settlement: string;
  readonly rawSymbol: string;
} | null {
  const m = /^MERV\s*-\s*XMEV\s*-\s*(.+?)\s*-\s*(24HS|CI|48HS|SPOT|T1)$/i.exec(rawSymbol.trim());
  if (m === null) {
    return null;
  }
  const ticker = (m[1] ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  const settlementRaw = m[2] ?? '';
  if (ticker === '' || settlementRaw === '') {
    return null;
  }
  // `T1` es el alias del plazo normal `24hs` (liquidación T+1) en Eco Valores XOMS.
  const settlementUpper = settlementRaw.toUpperCase();
  const settlement = settlementUpper === '24HS' || settlementUpper === 'T1' ? '24hs' : settlementRaw;
  return {
    ticker,
    settlement,
    rawSymbol,
  };
}

// ---------------------------------------------------------------------------
// Universo BYMA L2 (Eco Valores XOMS) — selección pura de productos MERV
// ---------------------------------------------------------------------------

/** Líderes del Merval suscriptos en L2 (GGAL incluido; plazo normal 24hs/T1 + CI). */
export const BYMA_L2_MERVAL_TICKERS: readonly string[] = [
  'GGAL',
  'YPFD',
  'BMA',
  'PAMP',
  'BBAR',
  'SUPV',
  'TGSU2',
  'TXAR',
  'ALUA',
  'BYMA',
  'CEPU',
  'CRES',
  'EDN',
  'LOMA',
  'METR',
  'MIRG',
  'TGNO4',
  'TRAN',
  'VALO',
];

/** Principales CEDEARs suscriptos en L2. */
export const BYMA_L2_CEDEAR_TICKERS: readonly string[] = [
  'SPY',
  'QQQ',
  'NVDA',
  'AAPL',
  'MSFT',
  'AMZN',
  'META',
  'TSLA',
  'MELI',
  'KO',
  'EWZ',
  'IBIT',
];

export const BYMA_L2_UNIVERSE_TICKERS: readonly string[] = [
  ...BYMA_L2_MERVAL_TICKERS,
  ...BYMA_L2_CEDEAR_TICKERS,
];

/** Raíces de opciones activas de Galicia (GGAL): calls `GFGC*` y puts `GFGV*`. */
export const BYMA_L2_OPTION_PREFIXES: readonly string[] = ['GFGC', 'GFGV'];

/**
 * Pieza 41: renta fija explícita. `AL30D/GD30D/...` son instrumentos separados,
 * no aliases; el CER activo se complementa por el caller con el catálogo.
 */
export const BYMA_L2_FIXED_INCOME_TICKERS: readonly string[] = Object.freeze([
  'AL29', 'AL29D', 'AL30', 'AL30D',
  'GD29', 'GD29D', 'GD30', 'GD30D',
  'AL35', 'AL35D', 'GD35', 'GD35D',
  'AE38', 'AE38D', 'GD38', 'GD38D',
  'AL41', 'AL41D', 'GD41', 'GD41D',
  'BPY26', 'BPOA7', 'BPOB7', 'BPOC7', 'BPOD7',
  'BA37D', 'TO26',
]);

/** Pieza 41: cauciones en pesos identificadas en el catálogo MERV. */
export const BYMA_L2_CAUCION_TICKER_RE = /^PESOS\s*-\s*(\d+)D$/i;

export const BYMA_L2_GGAL_TICKER = 'GGAL';

/**
 * Selecciona los productos BYMA (MERV) a suscribir en el stream L2 de 5 puntas a
 * partir del catálogo descubierto (`/rest/instruments/all`):
 *  - Tickers del universo: plazo normal `24hs`/`T1`; para `GGAL` se incluye
 *    además `CI`. Si un ticker no tiene `24hs`/`T1`, se usa `CI` como fallback
 *    explícito. Nunca se suscriben `48HS` ni `SPOT`.
 *  - Opciones activas de Galicia con raíz `GFGC*`/`GFGV*` (mismo orden de
 *    liquidación preferido).
 * El `marketId` descubierto se respeta (MERV en producción Eco Valores, ROFX en
 * reMarkets). La salida es determinista: orden ascendente por símbolo.
 */
export function selectBymaL2Products(
  instruments: readonly DlrInstrumentRef[],
  options: {
    readonly universeTickers?: readonly string[];
    readonly optionPrefixes?: readonly string[];
    readonly fixedIncomeTickers?: readonly string[];
  } = {},
): readonly DlrInstrumentRef[] {
  const universe = new Set(
    (options.universeTickers ?? BYMA_L2_UNIVERSE_TICKERS).map((ticker) => ticker.trim().toUpperCase()),
  );
  const fixedIncome = new Set(
    (options.fixedIncomeTickers ?? BYMA_L2_FIXED_INCOME_TICKERS).map((ticker) => ticker.trim().toUpperCase()),
  );
  const prefixes = (options.optionPrefixes ?? BYMA_L2_OPTION_PREFIXES).map((prefix) => prefix.trim().toUpperCase());

  const settlementsByTicker = new Map<string, Map<string, string>>();
  const marketIdBySymbol = new Map<string, string>();
  for (const instrument of instruments) {
    const parsed = parseMervInstrumentSymbol(instrument.symbol);
    if (parsed === null) {
      continue;
    }
    if (parsed.settlement !== '24hs' && parsed.settlement.toUpperCase() !== 'CI') {
      continue;
    }
    let bucket = settlementsByTicker.get(parsed.ticker);
    if (bucket === undefined) {
      bucket = new Map<string, string>();
      settlementsByTicker.set(parsed.ticker, bucket);
    }
    if (!bucket.has(parsed.rawSymbol)) {
      bucket.set(parsed.rawSymbol, parsed.settlement);
      marketIdBySymbol.set(parsed.rawSymbol, instrument.marketId);
    }
  }

  const out: DlrInstrumentRef[] = [];
  const isOptionTicker = (ticker: string): boolean =>
    prefixes.some((prefix) => prefix !== '' && ticker.startsWith(prefix));
  const isCaucionTicker = (ticker: string): boolean => BYMA_L2_CAUCION_TICKER_RE.test(ticker);
  for (const [ticker, settlements] of settlementsByTicker) {
    const inUniverse = universe.has(ticker);
    const isFixedIncome = fixedIncome.has(ticker);
    const isOption = isOptionTicker(ticker);
    const isCaucion = isCaucionTicker(ticker);
    if (!inUniverse && !isOption && !isFixedIncome && !isCaucion) {
      continue;
    }
    let has24hs = false;
    for (const settlement of settlements.values()) {
      if (settlement === '24hs') {
        has24hs = true;
        break;
      }
    }
    // Una identidad canónica (ticker, 24hs) puede llegar como `24HS` y `T1`;
    // elegimos exactamente un raw para no publicar dos observaciones distintas.
    const selected24Raw = [...settlements.entries()]
      .filter(([, settlement]) => settlement === '24hs')
      .sort((a, b) => {
        const aPreferred = a[0].toUpperCase().includes('24HS') ? 0 : 1;
        const bPreferred = b[0].toUpperCase().includes('24HS') ? 0 : 1;
        return aPreferred - bPreferred || a[0].localeCompare(b[0]);
      })
      .at(0)?.[0];
    for (const [rawSymbol, settlement] of settlements) {
      const isCi = settlement.toUpperCase() === 'CI';
      if (settlement === '24hs' && selected24Raw !== undefined && rawSymbol !== selected24Raw) {
        continue;
      }
      const include =
        isOption
          ? settlement === '24hs' || (isCi && !has24hs)
          : isCaucion
            ? settlement === '24hs' || isCi
            : settlement === '24hs' || (isCi && (isFixedIncome || ticker === BYMA_L2_GGAL_TICKER || !has24hs));
      if (!include) {
        continue;
      }
      out.push({ marketId: marketIdBySymbol.get(rawSymbol) ?? 'MERV', symbol: rawSymbol });
    }
  }
  out.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// Tick ARS de GGAL (vela ARS + CCL implícito `ARS * 10 / ADR`)
// ---------------------------------------------------------------------------

export interface GgalArsTickFrameInput {
  /** `marketData.LA.price` del frame `Md` (null si la entry no vino). */
  readonly laPrice: number | null;
  /** `marketData.LA.size` del frame `Md` (null si la entry no vino). */
  readonly laSize: number | null;
  /** `marketData.LA.date` convertido a segundos UTC (null si no vino). */
  readonly laTimeSec: number | null;
  /** true si el frame trajo alguna entry `BI`/`OF` (actualización de puntas). */
  readonly hasBookUpdate: boolean;
  /** `timestamp` del frame `Md` convertido a segundos UTC (null si no vino). */
  readonly frameTimeSec: number | null;
}

export interface GgalArsTickCache {
  readonly price: number | null;
  readonly size: number | null;
  readonly timeSec: number | null;
}

export interface GgalArsTickDecision {
  readonly emit: boolean;
  readonly tick: { readonly price: number; readonly size: number; readonly timeSec: number } | null;
  readonly cache: GgalArsTickCache | null;
}

function isValidPositive(value: number | null): boolean {
  return value !== null && Number.isFinite(value) && value > 0;
}

function isValidTickTimeSec(value: number | null): boolean {
  return value !== null && Number.isInteger(value) && value > 0;
}

/**
 * Decisión pura de emisión del tick ARS de GGAL ante cada frame `Md`:
 *  1. `LA` con precio positivo y tiempo ubicable (fecha del trade o timestamp del
 *     frame): emite el trade con su tamaño real (0 si es inválido) y actualiza la
 *     caché. Un frame `LA` duplicado (mismo precio y mismo tiempo) se suprime para
 *     no doble-contar volumen en la vela ARS.
 *  2. Solo puntas (`BI`/`OF`) con trade previo en caché: re-emite el último precio
 *     con tamaño 0 (no infla volumen) sellado al tiempo del frame (o al tiempo en
 *     caché si el frame no trae timestamp).
 *  3. Sin trade previo ni `LA`: no emite nunca (Zero Silent Fallbacks).
 */
export function decideGgalArsTick(
  frame: GgalArsTickFrameInput,
  cache: GgalArsTickCache | null,
): GgalArsTickDecision {
  const tradeTimeSec = isValidTickTimeSec(frame.laTimeSec)
    ? frame.laTimeSec
    : isValidTickTimeSec(frame.frameTimeSec)
      ? frame.frameTimeSec
      : null;

  if (isValidPositive(frame.laPrice) && tradeTimeSec !== null) {
    const laPrice = frame.laPrice as number;
    const laTimeSec = tradeTimeSec;
    const size =
      frame.laSize !== null && Number.isFinite(frame.laSize) && frame.laSize >= 0 ? frame.laSize : 0;
    if (
      cache !== null &&
      cache.price === laPrice &&
      cache.timeSec === laTimeSec
    ) {
      return { emit: false, tick: null, cache };
    }
    const nextCache: GgalArsTickCache = { price: laPrice, size, timeSec: laTimeSec };
    return { emit: true, tick: { price: laPrice, size, timeSec: laTimeSec }, cache: nextCache };
  }

  if (
    frame.hasBookUpdate &&
    cache !== null &&
    isValidPositive(cache.price) &&
    isValidTickTimeSec(cache.timeSec)
  ) {
    const cachedPrice = cache.price as number;
    const cachedTimeSec = cache.timeSec as number;
    const timeSec = isValidTickTimeSec(frame.frameTimeSec) ? (frame.frameTimeSec as number) : cachedTimeSec;
    return { emit: true, tick: { price: cachedPrice, size: 0, timeSec }, cache };
  }

  return { emit: false, tick: null, cache };
}

function parseDepthLevels(raw: unknown): readonly OrderBookLevel[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: OrderBookLevel[] = [];
  for (const item of raw) {
    if (!isPlainRecord(item)) {
      continue;
    }
    const price = readNum(item, ['price']);
    const size = readNum(item, ['size']);
    const orderCount = readNum(item, ['orderCount', 'orders', 'order_count']);
    if (price !== null && price > 0 && size !== null && size >= 0) {
      out.push({
        price,
        size,
        ...(orderCount !== null && Number.isInteger(orderCount) && orderCount >= 0
          ? { orderCount }
          : {}),
      });
    }
  }
  return out;
}

function parseEntryPriceAndTime(raw: unknown): {
  readonly price: number | null;
  readonly size: number | null;
  readonly utcSec: number | null;
} {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return { price: raw, size: null, utcSec: null };
  }
  if (!isPlainRecord(raw)) {
    return { price: null, size: null, utcSec: null };
  }
  return {
    price: readNum(raw, ['price']),
    size: readNum(raw, ['size']),
    utcSec: toUtcSecFromMixed(readNum(raw, ['date', 'timestamp'])),
  };
}

function parsePrimaryVolumeNode(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    return raw;
  }
  if (!isPlainRecord(raw)) {
    return null;
  }
  const v = readNum(raw, ['size', 'nominalVolume', 'volume', 'price']);
  return v !== null && Number.isFinite(v) && v >= 0 ? v : null;
}

function parsePrimaryMarketDataNode(
  symbol: string,
  marketId: string,
  md: Readonly<Record<string, unknown>>,
): ParsedPrimaryMarketData {
  const bids = [...parseDepthLevels(md['BI'])].sort((a, b) => b.price - a.price).slice(0, 5);
  const asks = [...parseDepthLevels(md['OF'])].sort((a, b) => a.price - b.price).slice(0, 5);
  const la = parseEntryPriceAndTime(md['LA']);
  const se = parseEntryPriceAndTime(md['SE']);
  const cl = parseEntryPriceAndTime(md['CL']);
  const op = parseEntryPriceAndTime(md['OP']);
  const hi = parseEntryPriceAndTime(md['HI']);
  const lo = parseEntryPriceAndTime(md['LO']);
  const oi = parseEntryPriceAndTime(md['OI']);
  const iv = parseEntryPriceAndTime(md['IV']);
  const tvNode = parseEntryPriceAndTime(md['TV']);
  const tv = parsePrimaryVolumeNode(md['TV']);
  const nv = parsePrimaryVolumeNode(md['NV']);
  const nominalVolume = tv ?? nv;

  const times = [la.utcSec, se.utcSec, cl.utcSec, oi.utcSec, tvNode.utcSec].filter(
    (t): t is number => t !== null && Number.isFinite(t) && t > 0,
  );
  const updatedAtUtcSec = times.length > 0 ? Math.max(...times) : null;

  return {
    symbol,
    marketId,
    bids,
    asks,
    last: la.price,
    settlement: se.price,
    close: cl.price,
    open: op.price,
    high: hi.price,
    low: lo.price,
    openInterest: oi.size ?? oi.price,
    nominalVolume,
    impliedVol: iv.price,
    updatedAtUtcSec,
    lastTradeAtUtcSec: la.utcSec,
    turnover: tv,
  };
}

/**
 * Pieza 41: frames `Md` son incrementales. `present` es el conjunto de entries
 * reales del frame; una entry ausente conserva el valor anterior, mientras una
 * entry presente inválida queda null (nunca se inventa un respaldo).
 */
export function mergePrimaryMarketData(
  previous: ParsedPrimaryMarketData | null,
  next: ParsedPrimaryMarketData,
  present: ReadonlySet<string>,
): ParsedPrimaryMarketData {
  if (previous === null) return next;
  const ENTRY_BY_FIELD: Readonly<Partial<Record<keyof ParsedPrimaryMarketData, readonly string[]>>> = {
    last: ['LA'],
    settlement: ['SE'],
    close: ['CL'],
    open: ['OP'],
    high: ['HI'],
    low: ['LO'],
    openInterest: ['OI'],
    nominalVolume: ['TV', 'NV'],
    impliedVol: ['IV'],
    lastTradeAtUtcSec: ['LA'],
    turnover: ['TV'],
  };
  const keep = (field: keyof ParsedPrimaryMarketData): boolean => {
    const entries = ENTRY_BY_FIELD[field];
    return entries === undefined ? false : !entries.some((entry) => present.has(entry));
  };
  return {
    symbol: next.symbol,
    marketId: next.marketId,
    bids: next.bids.length > 0 ? next.bids : previous.bids,
    asks: next.asks.length > 0 ? next.asks : previous.asks,
    last: keep('last') ? previous.last : next.last,
    settlement: keep('settlement') ? previous.settlement : next.settlement,
    close: keep('close') ? previous.close : next.close,
    open: keep('open') ? previous.open : next.open,
    high: keep('high') ? previous.high : next.high,
    low: keep('low') ? previous.low : next.low,
    openInterest: keep('openInterest') ? previous.openInterest : next.openInterest,
    nominalVolume: keep('nominalVolume') ? previous.nominalVolume : next.nominalVolume,
    impliedVol: keep('impliedVol') ? previous.impliedVol : next.impliedVol,
    updatedAtUtcSec: (() => {
      const nextUpdated = next.updatedAtUtcSec ?? null;
      const previousUpdated = previous.updatedAtUtcSec ?? null;
      const nextFrame = next.frameAtUtcSec ?? null;
      if (nextUpdated !== null) {
        return previousUpdated === null ? nextUpdated : Math.max(nextUpdated, previousUpdated);
      }
      if (nextFrame !== null && previousUpdated !== null && nextFrame > previousUpdated) return nextFrame;
      return previousUpdated;
    })(),
    lastTradeAtUtcSec: keep('lastTradeAtUtcSec') ? previous.lastTradeAtUtcSec ?? null : next.lastTradeAtUtcSec ?? null,
    turnover: keep('turnover') ? previous.turnover ?? null : next.turnover ?? null,
    frameAtUtcSec: next.frameAtUtcSec ?? previous.frameAtUtcSec ?? null,
  };
}

export interface PrimaryRofexClientDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchFn?: PrimaryHttpFn;
  readonly wsFactory?: PrimaryWsFactory;
  readonly nowMsFn?: () => number;
  readonly secrets?: readonly string[];
  readonly timeoutMs?: number;
  readonly minRequestIntervalMs?: number;
  readonly retry429DelayMs?: number;
  /** Inyectable para tests: espera usada en pacing REST y backoff ante 429. */
  readonly sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Cliente REST + WebSocket nativo para Primary API v1.21 (reMarkets / MATBA ROFEX + MERV).
 */
export class PrimaryRofexClient {
  private readonly config: PrimaryConfig;
  private readonly fetchFn: PrimaryHttpFn;
  private readonly wsFactory: PrimaryWsFactory;
  private readonly nowMsFn: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly baseSecrets: readonly string[];
  private readonly timeoutMs: number;
  private readonly minRequestIntervalMs: number;
  private readonly retry429DelayMs: number;
  private readonly wsTelemetry = new RollingFeedTelemetry({
    latencyKind: 'PROVIDER_EVENT_AGE',
  });

  private authToken: string | null = null;
  private tokenIssuedAtMs = 0;
  private tokenRenewCount = 0;
  private authInFlight: Promise<string> | null = null;
  private paceChain: Promise<void> = Promise.resolve();
  private lastRequestAtMs = 0;

  private ws: PrimaryWsLike | null = null;
  private wsConnected = false;
  private readonly wsSnapshots = new Map<string, ParsedPrimaryMarketData>();
  private lastError: string | null = null;

  private readonly wsEnvironment: 'PRIMARY_MATRIZ_WS' | 'PRIMARY_ECO_XOMS_WS' | 'PRIMARY_REMARKETS_SANDBOX';
  /**
   * Grupos de suscripción WS `smd`. Cada grupo tiene su propio `level`,
   * `entries` y `depth` (stream DLR level 5 vs stream BYMA L2 level 2) y
   * se re-envía completo tras cada reconexión.
   */
  private readonly wsGroups = new Map<string, WsSubscriptionGroup>();
  private wsLastMessageAtMs = 0;
  private wsReconnectAttempts = 0;
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wsHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private tokenRenewTimer: ReturnType<typeof setInterval> | null = null;
  private wsIntentionalClose = false;
  private dlrStreamInFlight: Promise<void> | null = null;
  private bymaStreamInFlight: Promise<void> | null = null;
  private liveDlrContracts: readonly PrimaryDlrContractDto[] = [];
  private liveDlrLastUpdateUtcSec: number | null = null;
  private referenceSpotA3500: number | null = null;
  private readonly dlrDetailBySymbol = new Map<
    string,
    { readonly maturityDate: string | null; readonly contractMultiplier: number | null; readonly minPriceIncrement: number | null }
  >();
  /** Listener del tick ARS de GGAL (vela ARS + CCL implícito hacia ggalSpecialistRuntime). */
  private ggalArsTickListener:
    | ((tick: { readonly price: number; readonly size: number; readonly timeSec: number }) => void)
    | null = null;
  private ggalArsTickCache: GgalArsTickCache | null = null;
  /** Pieza 41: frames MERV normalizados para quotes/cauciones generales. */
  private mervMarketDataListener:
    | ((frame: PrimaryMervMarketDataFrame) => void)
    | null = null;

  private readonly instrumentListCache: SingleFlightRuntimeCache<readonly { readonly marketId: string; readonly symbol: string }[]>;
  private readonly detailCache: SingleFlightRuntimeCache<InstrumentDetailMetadata | null>;
  private readonly marketDataCache: SingleFlightRuntimeCache<ParsedPrimaryMarketData | null>;

  private cachedCounts = { dlr: 0, ddf: 0, merv: 0 };

  public constructor(deps: PrimaryRofexClientDeps = {}) {
    const env = deps.env ?? process.env;
    this.config = loadPrimaryConfigFromEnv(env);
    this.fetchFn = deps.fetchFn ?? defaultPrimaryHttpFn;
    this.wsFactory =
      deps.wsFactory ??
      ((url, headers) =>
        new WebSocket(url, {
          headers,
        }));
    this.nowMsFn = deps.nowMsFn ?? (() => Date.now());
    this.sleepFn =
      deps.sleepFn ??
      ((ms: number) =>
        new Promise<void>((resolveSleep) => {
          setTimeout(resolveSleep, ms);
        }));
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_PRIMARY_TIMEOUT_MS;
    this.minRequestIntervalMs =
      deps.minRequestIntervalMs ?? (deps.fetchFn !== undefined ? 0 : DEFAULT_PRIMARY_MIN_REQUEST_INTERVAL_MS);
    this.retry429DelayMs =
      deps.retry429DelayMs ?? (deps.fetchFn !== undefined ? 0 : DEFAULT_PRIMARY_RETRY_429_DELAY_MS);
    this.wsEnvironment = /eco\.xoms/i.test(this.config.wsUrl) || /eco\.xoms/i.test(this.config.apiUrl)
      ? 'PRIMARY_ECO_XOMS_WS'
      : /sandbox/i.test(this.config.wsUrl) || /sandbox/i.test(this.config.apiUrl)
        ? 'PRIMARY_REMARKETS_SANDBOX'
        : 'PRIMARY_MATRIZ_WS';

    const secretSet = new Set<string>(deps.secrets ?? []);
    for (const s of collectBrokerSecretsFromEnv(env)) {
      secretSet.add(s);
    }
    this.baseSecrets = [...secretSet];

    this.instrumentListCache = new SingleFlightRuntimeCache({
      ttlResolver: () => DETAIL_CACHE_TTL_MS,
      nowFn: this.nowMsFn,
    });
    this.detailCache = new SingleFlightRuntimeCache({
      ttlResolver: () => DETAIL_CACHE_TTL_MS,
      nowFn: this.nowMsFn,
    });
    this.marketDataCache = new SingleFlightRuntimeCache({
      ttlResolver: () => MD_CACHE_TTL_MS,
      nowFn: this.nowMsFn,
    });
  }

  public isConfigured(): boolean {
    return this.config.configured;
  }

  public getSecrets(): readonly string[] {
    if (this.authToken !== null && this.authToken.trim() !== '') {
      return [...this.baseSecrets, this.authToken];
    }
    return this.baseSecrets;
  }

  private redact(text: string): string {
    return redactSecrets(text, this.getSecrets());
  }

  /**
   * Obtiene o renueva el `X-Auth-Token` (< 24h) mediante `POST /auth/getToken`.
   */
  public async getAuthToken(forceRefresh = false): Promise<string> {
    if (!this.config.configured) {
      throw new Error('PRIMARY_USERNAME y PRIMARY_PASSWORD no configurados en process.env');
    }

    const nowMs = this.nowMsFn();
    const ageMs = nowMs - this.tokenIssuedAtMs;
    if (
      !forceRefresh &&
      this.authToken !== null &&
      this.authToken !== '' &&
      ageMs >= 0 &&
      ageMs < PRIMARY_TOKEN_MAX_AGE_MS
    ) {
      return this.authToken;
    }

    if (this.authInFlight !== null) {
      return this.authInFlight;
    }

    const run = async (): Promise<string> => {
      try {
        const res = await this.fetchFn(`${this.config.apiUrl}/auth/getToken`, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'X-Username': this.config.username,
            'X-Password': this.config.password,
          },
          timeoutMs: this.timeoutMs,
        });
        if (!res.ok) {
          throw new Error(`Primary auth HTTP ${String(res.status)}`);
        }
        const token = (res.headers?.['x-auth-token'] ?? '').trim();
        if (token === '') {
          throw new Error('Primary auth no devolvió cabecera X-Auth-Token');
        }
        this.authToken = token;
        this.tokenIssuedAtMs = this.nowMsFn();
        this.tokenRenewCount += 1;
        this.lastError = null;
        this.ensureTokenRenewalTimer();
        return token;
      } catch (err: unknown) {
        const msg = this.redact(err instanceof Error ? err.message : String(err));
        this.lastError = msg;
        throw new Error(msg);
      } finally {
        this.authInFlight = null;
      }
    };

    this.authInFlight = run();
    return this.authInFlight;
  }

  private async acquireRequestSlot(): Promise<void> {
    if (this.minRequestIntervalMs <= 0) {
      return;
    }
    const prev = this.paceChain;
    let release!: () => void;
    this.paceChain = new Promise<void>((res) => {
      release = res;
    });
    await prev;
    try {
      const elapsed = Date.now() - this.lastRequestAtMs;
      const waitMs = this.minRequestIntervalMs - elapsed;
      if (waitMs > 0) {
        await this.sleepFn(waitMs);
      }
      this.lastRequestAtMs = Date.now();
    } finally {
      release();
    }
  }

  private async requestJson(
    path: string,
    allowRetryAuth = true,
    retry429Left = 2,
  ): Promise<unknown> {
    await this.acquireRequestSlot();
    const token = await this.getAuthToken(false);
    const url = `${this.config.apiUrl}${path}`;
    const res = await this.fetchFn(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Auth-Token': token,
      },
      timeoutMs: this.timeoutMs,
    });

    if (res.status === 401 && allowRetryAuth) {
      this.authToken = null;
      await this.getAuthToken(true);
      return this.requestJson(path, false, retry429Left);
    }
    if (res.status === 429 && retry429Left > 0) {
      const retryAfterRaw = Number(res.headers?.['retry-after'] ?? '');
      // Backoff mínimo de 15 s ante 429; `Retry-After` del servidor se respeta cuando
      // es mayor, con tope de 60 s para no colgar el ciclo de descubrimiento.
      const waitMs =
        Number.isFinite(retryAfterRaw) && retryAfterRaw > 0
          ? Math.max(this.retry429DelayMs, Math.min(PRIMARY_429_BACKOFF_MAX_MS, retryAfterRaw * 1_000))
          : this.retry429DelayMs;
      if (waitMs > 0) {
        await this.sleepFn(waitMs);
      }
      return this.requestJson(path, allowRetryAuth, retry429Left - 1);
    }
    if (!res.ok) {
      const msg = this.redact(`Primary REST HTTP ${String(res.status)} en ${path}`);
      this.lastError = msg;
      throw new Error(msg);
    }
    const parsed: unknown = JSON.parse(res.text);
    if (isPlainRecord(parsed) && parsed['status'] === 'ERROR') {
      const desc = readStr(parsed, ['description', 'message']) ?? 'Primary API status ERROR';
      const safeDesc = this.redact(desc);
      this.lastError = safeDesc;
      throw new Error(safeDesc);
    }
    this.lastError = null;
    return parsed;
  }

  private parseInstrumentList(raw: unknown): readonly { readonly marketId: string; readonly symbol: string }[] {
    const listRaw = Array.isArray(raw)
      ? raw
      : isPlainRecord(raw) && Array.isArray(raw['instruments'])
        ? raw['instruments']
        : null;
    if (listRaw === null) {
      return [];
    }
    const out: { readonly marketId: string; readonly symbol: string }[] = [];
    for (const item of listRaw) {
      if (!isPlainRecord(item)) {
        continue;
      }
      const nested = isPlainRecord(item['instrumentId']) ? item['instrumentId'] : null;
      const symbol = readStr(nested ?? item, ['symbol']);
      const marketId = readStr(nested ?? item, ['marketId']) ?? 'ROFX';
      if (symbol !== null) {
        out.push({ marketId, symbol });
      }
    }
    return out;
  }

  public async getInstrumentsByCFICode(
    cficode = 'FXXXSX',
    forceRefresh = false,
  ): Promise<readonly { readonly marketId: string; readonly symbol: string }[]> {
    const cleanCfi = encodeURIComponent(cficode);
    const res = await this.instrumentListCache.getOrCompute(
      `cfi:${cficode}`,
      async () => {
        const raw = await this.requestJson(`/rest/instruments/byCFICode?CFICode=${cleanCfi}`);
        const list = this.parseInstrumentList(raw);
        if (cficode === 'FXXXSX') {
          this.cachedCounts = {
            ...this.cachedCounts,
            dlr: list.filter((i) => i.symbol.startsWith('DLR/')).length,
          };
        }
        return list;
      },
      { forceRefresh },
    );
    return res.value;
  }

  public async getInstrumentsBySegment(
    segmentId: 'DDF' | 'MERV',
    marketId = 'ROFX',
    forceRefresh = false,
  ): Promise<readonly { readonly marketId: string; readonly symbol: string }[]> {
    const res = await this.instrumentListCache.getOrCompute(
      `seg:${marketId}:${segmentId}`,
      async () => {
        const raw = await this.requestJson(
          `/rest/instruments/bySegment?MarketSegmentID=${encodeURIComponent(segmentId)}&MarketID=${encodeURIComponent(marketId)}`,
        );
        const list = this.parseInstrumentList(raw);
        if (segmentId === 'DDF') {
          this.cachedCounts = { ...this.cachedCounts, ddf: list.length };
        } else {
          this.cachedCounts = { ...this.cachedCounts, merv: list.length };
        }
        return list;
      },
      { forceRefresh },
    );
    return res.value;
  }

  /**
   * Catálogo completo de instrumentos vigentes (`GET /rest/instruments/all`).
   * Se usa para descubrir contratos `DLR/*` que no aparecen en los segmentos CFI/DDF.
   */
  public async getAllInstruments(
    forceRefresh = false,
  ): Promise<readonly { readonly marketId: string; readonly symbol: string }[]> {
    const res = await this.instrumentListCache.getOrCompute(
      'all',
      async () => {
        const raw = await this.requestJson('/rest/instruments/all');
        return this.parseInstrumentList(raw);
      },
      { forceRefresh },
    );
    return res.value;
  }

  private async discoverDlrInstruments(
    forceRefresh: boolean,
  ): Promise<{
    readonly instruments: readonly { readonly marketId: string; readonly symbol: string }[];
    readonly firstError: string | null;
  }> {
    const results = await Promise.allSettled([
      this.getInstrumentsByCFICode('FXXXSX', forceRefresh),
      this.getInstrumentsBySegment('DDF', 'ROFX', forceRefresh),
      this.getAllInstruments(forceRefresh),
    ]);
    const lists = results.map((result) => (result.status === 'fulfilled' ? result.value : []));
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (rejected.length === results.length && rejected[0] !== undefined) {
      const reason: unknown = rejected[0].reason;
      return {
        instruments: [],
        firstError: this.redact(reason instanceof Error ? reason.message : String(reason)),
      };
    }
    const merged = new Map<string, { readonly marketId: string; readonly symbol: string }>();
    for (const item of lists.flat()) {
      if (item.symbol.startsWith('DLR/') && !merged.has(item.symbol)) {
        merged.set(item.symbol, item);
      }
    }
    return { instruments: [...merged.values()], firstError: null };
  }

  public async getInstrumentDetail(
    symbol: string,
    marketId = 'ROFX',
    forceRefresh = false,
  ): Promise<InstrumentDetailMetadata | null> {
    const res = await this.detailCache.getOrCompute(
      `det:${marketId}:${symbol}`,
      async () => {
        const raw = await this.requestJson(
          `/rest/instruments/detail?marketId=${encodeURIComponent(marketId)}&symbol=${encodeURIComponent(symbol)}`,
        );
        if (!isPlainRecord(raw) || !isPlainRecord(raw['instrument'])) {
          return null;
        }
        const inst = raw['instrument'];
        const seg = isPlainRecord(inst['segment']) ? inst['segment'] : null;
        return {
          symbol,
          marketId,
          segmentId: seg ? readStr(seg, ['marketSegmentId']) : null,
          cficode: readStr(inst, ['cficode']),
          maturityDate: readStr(inst, ['maturityDate']),
          contractMultiplier: readNum(inst, ['contractMultiplier']),
          minPriceIncrement: readNum(inst, ['minPriceIncrement']),
        };
      },
      { forceRefresh },
    );
    return res.value;
  }

  public async getMarketData(
    symbol: string,
    marketId = 'ROFX',
    depth = 5,
    forceRefresh = false,
  ): Promise<ParsedPrimaryMarketData | null> {
    const wsKey = `${marketId}:${symbol}`;
    const wsSnap = this.wsSnapshots.get(wsKey);
    const res = await this.marketDataCache.getOrCompute(
      `md:${marketId}:${symbol}:${String(depth)}`,
      async () => {
        const entries = 'BI,OF,LA,OP,CL,SE,OI,HI,LO,TV,EV,NV,IV';
        const path =
          `/rest/marketdata/get?marketId=${encodeURIComponent(marketId)}` +
          `&symbol=${encodeURIComponent(symbol)}` +
          `&entries=${entries}&depth=${String(depth)}`;
        const raw = await this.requestJson(path);
        if (!isPlainRecord(raw) || !isPlainRecord(raw['marketData'])) {
          return null;
        }
        return parsePrimaryMarketDataNode(symbol, marketId, raw['marketData']);
      },
      { forceRefresh },
    );
    const restSnap = res.value;
    if (wsSnap !== undefined && restSnap !== null) {
      const wsTime = wsSnap.updatedAtUtcSec ?? 0;
      const restTime = restSnap.updatedAtUtcSec ?? 0;
      if (wsTime >= restTime && (wsSnap.bids.length > 0 || wsSnap.asks.length > 0 || wsSnap.last !== null)) {
        return wsSnap;
      }
    }
    return restSnap ?? wsSnap ?? null;
  }

  private clearWsSessionTimers(): void {
    if (this.wsHeartbeatTimer !== null) clearInterval(this.wsHeartbeatTimer);
    this.wsHeartbeatTimer = null;
  }

  private ensureTokenRenewalTimer(): void {
    if (this.tokenRenewTimer !== null) return;
    this.tokenRenewTimer = setInterval(() => {
      // Force a fresh X-Auth-Token on the next REST call and re-handshake the WS.
      this.authToken = null;
      if (this.ws !== null) {
        this.forceWsReconnect('token_renewal');
      }
    }, PRIMARY_TOKEN_PROACTIVE_RENEW_MS);
    this.tokenRenewTimer.unref();
  }

  private forceWsReconnect(reason: string): void {
    const sock = this.ws;
    this.wsIntentionalClose = true;
    this.ws = null;
    this.wsConnected = false;
    this.clearWsSessionTimers();
    if (sock !== null) {
      try {
        sock.close(1000, reason);
      } catch {
        // The reconnect path below owns recovery.
      }
    }
    if (this.wsGroups.size > 0) {
      void this.openWsAndSubscribeAll().catch(() => undefined);
    }
  }

  private scheduleWsReconnect(): void {
    if (this.wsIntentionalClose || this.wsReconnectTimer !== null || this.wsGroups.size === 0) {
      return;
    }
    const delayMs = Math.min(
      PRIMARY_WS_RECONNECT_MAX_MS,
      PRIMARY_WS_RECONNECT_BASE_MS * Math.pow(2, this.wsReconnectAttempts),
    );
    this.wsReconnectAttempts += 1;
    this.wsReconnectTimer = setTimeout(() => {
      this.wsReconnectTimer = null;
      if (this.wsIntentionalClose || this.wsGroups.size === 0) return;
      void this.openWsAndSubscribeAll().catch(() => undefined);
    }, delayMs);
    this.wsReconnectTimer.unref();
  }

  private startWsHeartbeat(sock: PrimaryWsLike): void {
    if (this.wsHeartbeatTimer !== null) clearInterval(this.wsHeartbeatTimer);
    this.wsHeartbeatTimer = setInterval(() => {
      if (this.ws !== sock || !this.wsConnected || sock.readyState !== 1) return;
      try {
        sock.send(JSON.stringify({ type: 'ping' }));
      } catch {
        // The close handler owns reconnection; heartbeat failures are transport-level.
      }
    }, PRIMARY_WS_HEARTBEAT_MS);
    this.wsHeartbeatTimer.unref();
  }

  private groupKey(level: number, entries: readonly string[], depth: number): string {
    return `${String(level)}|${entries.join(',')}|${String(depth)}`;
  }

  private buildSmdPayload(group: WsSubscriptionGroup): string {
    return JSON.stringify({
      type: 'smd',
      level: group.level,
      entries: [...group.entries],
      products: group.products,
      depth: group.depth,
    });
  }

  /** Unión de productos suscriptos en todos los grupos `smd` activos. */
  private get wsSubscriptions(): readonly { readonly marketId: string; readonly symbol: string }[] {
    const out: { readonly marketId: string; readonly symbol: string }[] = [];
    for (const group of this.wsGroups.values()) {
      out.push(...group.products);
    }
    return out;
  }

  private areAllSymbolsSubscribed(
    products: readonly { readonly marketId: string; readonly symbol: string }[],
  ): boolean {
    if (products.length === 0) {
      return false;
    }
    const subscribed = new Set(this.wsSubscriptions.map((product) => product.symbol));
    return products.every((product) => subscribed.has(product.symbol));
  }

  /**
   * Abre el socket autenticado (`X-Auth-Token` en header) y envía el payload `smd`
   * de CADA grupo de suscripción (stream DLR level 5 y stream BYMA L2 level 2).
   */
  private async openWsAndSubscribeAll(): Promise<void> {
    if (this.wsGroups.size === 0) {
      return;
    }
    this.wsIntentionalClose = false;
    let token: string;
    try {
      token = await this.getAuthToken(false);
    } catch (err: unknown) {
      this.lastError = this.redact(err instanceof Error ? err.message : String(err));
      this.scheduleWsReconnect();
      throw err;
    }
    const payloads = [...this.wsGroups.values()].map((group) => this.buildSmdPayload(group));

    await new Promise<void>((resolveConn) => {
      let settled = false;
      const done = (): void => {
        if (!settled) {
          settled = true;
          resolveConn();
        }
      };

      try {
        const sock = this.wsFactory(this.config.wsUrl, {
          'X-Auth-Token': token,
        });
        this.ws = sock;

        sock.on('open', () => {
          if (this.ws !== sock) {
            done();
            return;
          }
          this.wsConnected = true;
          this.wsReconnectAttempts = 0;
          this.lastError = null;
          this.startWsHeartbeat(sock);
          for (const payload of payloads) {
            try {
              sock.send(payload);
            } catch (err: unknown) {
              this.lastError = this.redact(err instanceof Error ? err.message : String(err));
            }
          }
          done();
        });

        sock.on('message', (raw) => {
          if (this.ws !== sock) return;
          const receivedAtMs = this.nowMsFn();
          this.wsLastMessageAtMs = receivedAtMs;
          try {
            const text =
              typeof raw === 'string'
                ? raw
                : Buffer.isBuffer(raw)
                  ? raw.toString('utf8')
                  : raw instanceof ArrayBuffer
                    ? Buffer.from(raw).toString('utf8')
                    : String(raw);
            const parsed: unknown = JSON.parse(text);
            if (
              !isPlainRecord(parsed) ||
              parsed['type'] !== 'Md' ||
              !isPlainRecord(parsed['marketData'])
            ) {
              return;
            }
            const md = parsed['marketData'] as Readonly<Record<string, unknown>>;
            const inst = isPlainRecord(parsed['instrumentId']) ? parsed['instrumentId'] : null;
            const sym = inst ? readStr(inst, ['symbol']) : readStr(parsed, ['symbol']);
            const mkt = (inst ? readStr(inst, ['marketId']) : readStr(parsed, ['marketId'])) ?? 'ROFX';
            if (sym !== null) {
              const frameTimeSec = toUtcSecFromMixed(
                typeof parsed['timestamp'] === 'number' && Number.isFinite(parsed['timestamp'])
                  ? parsed['timestamp']
                  : null,
              );
              const receivedSec = Math.floor(receivedAtMs / 1_000);
              const present = new Set<string>();
              for (const entry of ['BI', 'OF', 'LA', 'SE', 'CL', 'OP', 'HI', 'LO', 'OI', 'IV', 'TV', 'NV']) {
                if (md[entry] !== undefined) present.add(entry);
              }
              const parsedSnapshot = parsePrimaryMarketDataNode(sym, mkt, md);
              const nextSnapshot: ParsedPrimaryMarketData = {
                ...parsedSnapshot,
                ...(frameTimeSec === null ? {} : { frameAtUtcSec: frameTimeSec }),
              };
              const key = `${mkt}:${sym}`;
              const previous = this.wsSnapshots.get(key) ?? null;
              const previousFrameSec = previous?.frameAtUtcSec ?? null;
              if (
                frameTimeSec !== null &&
                previousFrameSec !== null &&
                frameTimeSec < previousFrameSec
              ) {
                return;
              }
              const snapshot = mergePrimaryMarketData(previous, nextSnapshot, present);
              this.wsSnapshots.set(key, snapshot);
              if (sym.startsWith('DLR/')) {
                this.wsTelemetry.record({
                  atMs: receivedAtMs,
                  latencyMs:
                    snapshot.updatedAtUtcSec !== null && snapshot.updatedAtUtcSec > 0
                      ? receivedAtMs - snapshot.updatedAtUtcSec * 1_000
                      : null,
                  isValidTick: true,
                });
                this.recomputeLiveDlrDerived();
              }
              const mervParsed = parseMervInstrumentSymbol(sym);
              if (mervParsed !== null && this.mervMarketDataListener !== null) {
                this.mervMarketDataListener({
                  symbol: sym,
                  marketId: mkt,
                  ticker: mervParsed.ticker,
                  settlement: mervParsed.settlement,
                  snapshot,
                  receivedAtUtcSec: receivedSec,
                });
              }
              if (
                mervParsed !== null &&
                mervParsed.ticker === BYMA_L2_GGAL_TICKER &&
                mervParsed.settlement === '24hs'
              ) {
                this.maybeEmitGgalArsTick(md, parsed['timestamp']);
              }
            }
          } catch {
            // Mensajes heartbeat o no JSON se ignoran de forma segura.
          }
        });

        sock.on('error', (err) => {
          if (this.ws !== sock) {
            done();
            return;
          }
          this.wsConnected = false;
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'ECONNRESET' && code !== 'ECONNABORTED') {
            this.lastError = this.redact(err.message);
          }
          done();
          this.scheduleWsReconnect();
        });

        sock.on('close', () => {
          if (this.ws !== sock) {
            done();
            return;
          }
          this.ws = null;
          this.wsConnected = false;
          this.clearWsSessionTimers();
          done();
          this.scheduleWsReconnect();
        });
      } catch (err: unknown) {
        this.wsConnected = false;
        this.lastError = this.redact(err instanceof Error ? err.message : String(err));
        done();
        this.scheduleWsReconnect();
      }
    });
  }

  /**
   * Suscripción WebSocket `type: "smd"` con heartbeat cada 20 s y reconexión
   * exponencial con el mismo token renovado. Por defecto suscribe el stream
   * DLR (level 5, entries BI/OF/LA/OI/IV/SE); con `options` se registran otros
   * grupos (p. ej. el stream BYMA L2 level 2 de Eco Valores XOMS) sobre el
   * mismo socket, y cada grupo se re-envía íntegro tras cada reconexión.
   */
  public async connectAndSubscribeWs(
    products: readonly { readonly marketId: string; readonly symbol: string }[],
    depth = 5,
    options?: PrimaryWsSubscribeOptions,
  ): Promise<void> {
    if (!this.config.configured || products.length === 0) {
      return;
    }
    const level = options?.level ?? 5;
    const entries = options?.entries ?? DEFAULT_DLR_SMD_ENTRIES;
    const key = this.groupKey(level, entries, depth);
    const existing = this.wsGroups.get(key);
    const group: WsSubscriptionGroup = existing ?? { level, entries: [...entries], depth, products: [] };
    group.products = [...products];
    this.wsGroups.set(key, group);
    this.wsIntentionalClose = false;

    if (this.ws !== null && this.wsConnected && this.ws.readyState === 1) {
      this.ws.send(this.buildSmdPayload(group));
      return;
    }

    await this.openWsAndSubscribeAll();
  }

  /**
   * Stream L2 BYMA 5 puntas (Eco Valores XOMS): mensaje `smd` con `level: 2`,
   * entries `BI,OF,LA,OP,CL,SE,HI,LO,NV,OI` y puntas hasta 5 niveles por lado.
   */
  public async connectAndSubscribeBymaL2(
    products: readonly { readonly marketId: string; readonly symbol: string }[],
  ): Promise<void> {
    await this.connectAndSubscribeWs(products, BYMA_L2_SMD_DEPTH, {
      level: BYMA_L2_SMD_LEVEL,
      entries: BYMA_L2_SMD_ENTRIES,
    });
  }

  /** Listener del tick ARS de GGAL (LA/BI/OF) para el motor tick del GGAL Specialist. */
  public setGgalArsTickListener(
    listener: ((tick: { readonly price: number; readonly size: number; readonly timeSec: number }) => void) | null,
  ): void {
    this.ggalArsTickListener = listener;
  }

  /** Pieza 41: frames MERV incrementales para bus general (sin I/O). */
  public setMervMarketDataListener(
    listener: ((frame: PrimaryMervMarketDataFrame) => void) | null,
  ): void {
    this.mervMarketDataListener = listener;
  }

  private maybeEmitGgalArsTick(md: Readonly<Record<string, unknown>>, timestampRaw: unknown): void {
    const la = parseEntryPriceAndTime(md['LA']);
    const frameTimeSec = toUtcSecFromMixed(
      typeof timestampRaw === 'number' && Number.isFinite(timestampRaw) ? timestampRaw : null,
    );
    const decision = decideGgalArsTick(
      {
        laPrice: la.price,
        laSize: la.size,
        laTimeSec: la.utcSec,
        hasBookUpdate: md['BI'] !== undefined || md['OF'] !== undefined,
        frameTimeSec,
      },
      this.ggalArsTickCache,
    );
    this.ggalArsTickCache = decision.cache;
    if (decision.emit && decision.tick !== null && this.ggalArsTickListener !== null) {
      try {
        this.ggalArsTickListener(decision.tick);
      } catch {
        // Consumidor aislado: un error del motor tick no rompe el stream L2.
      }
    }
  }

  public closeWebSocket(): void {
    this.wsIntentionalClose = true;
    this.wsGroups.clear();
    this.ggalArsTickCache = null;
    this.clearWsSessionTimers();
    if (this.tokenRenewTimer !== null) clearInterval(this.tokenRenewTimer);
    this.tokenRenewTimer = null;
    if (this.wsReconnectTimer !== null) clearTimeout(this.wsReconnectTimer);
    this.wsReconnectTimer = null;
    const sock = this.ws;
    this.ws = null;
    this.wsConnected = false;
    this.wsSnapshots.clear();
    this.liveDlrContracts = [];
    this.liveDlrLastUpdateUtcSec = null;
    if (sock !== null) {
      try {
        sock.close(1000, 'Client shutdown');
      } catch {
        // Ignore close errors during shutdown
      }
    }
  }

  private recomputeLiveDlrDerived(): void {
    const nowSec = Math.floor(this.nowMsFn() / 1_000);
    const spotSnap = this.wsSnapshots.get('ROFX:DLR/SPOT') ?? null;
    const dlrSpot =
      spotSnap?.last ??
      (spotSnap !== null && spotSnap.bids[0] !== undefined && spotSnap.asks[0] !== undefined
        ? 0.5 * (spotSnap.bids[0].price + spotSnap.asks[0].price)
        : null) ??
      spotSnap?.settlement ??
      spotSnap?.close ??
      null;

    const contracts: PrimaryDlrContractDto[] = [];
    for (const [key, snap] of this.wsSnapshots) {
      const separator = key.indexOf(':');
      if (separator < 0) continue;
      const marketId = key.slice(0, separator);
      const symbol = key.slice(separator + 1);
      const category = classifyDlrSymbol(symbol);
      if (category !== 'OUTRIGHT' && category !== 'MINI' && category !== 'SPOT') continue;
      const detail = this.dlrDetailBySymbol.get(symbol) ?? null;
      const metrics = computeDlrContractMetrics({
        asOfUtcSec: nowSec,
        maturityDate: detail?.maturityDate ?? inferDlrMaturityDateStr(symbol),
        last: snap.last,
        bestBid: snap.bids[0]?.price,
        bestAsk: snap.asks[0]?.price,
        settlement: snap.settlement,
        close: snap.close,
        a3500: this.referenceSpotA3500,
        dlrSpot,
      });
      const expiryUtcSec = sanitizeNum(metrics.maturityUtcSec);
      contracts.push({
        contract: symbol,
        category,
        marketId,
        maturity:
          expiryUtcSec !== null ? new Date(expiryUtcSec * 1_000).toISOString().slice(0, 10) : null,
        expiryUtcSec,
        days: sanitizeNum(metrics.days),
        price: sanitizeNum(metrics.referencePrice),
        priceBasis: metrics.priceBasis,
        last: snap.last,
        settlement: snap.settlement,
        close: snap.close,
        bid: snap.bids[0]?.price ?? null,
        bidPrice: snap.bids[0]?.price ?? null,
        bidSize: snap.bids[0]?.size ?? null,
        ask: snap.asks[0]?.price ?? null,
        askPrice: snap.asks[0]?.price ?? null,
        askSize: snap.asks[0]?.size ?? null,
        bids: snap.bids,
        asks: snap.asks,
        openInterest: snap.openInterest,
        nominalVolume: snap.nominalVolume,
        open: snap.open,
        high: snap.high,
        low: snap.low,
        spotUsed: sanitizeNum(metrics.spotUsed),
        spotSource: metrics.spotSource,
        devalDirectaPct: sanitizeNum(metrics.devalDirectaPct),
        tnaImplicitaPct: sanitizeNum(metrics.tnaImplicitaPct),
        teaImplicitaPct: sanitizeNum(metrics.teaImplicitaPct),
        temImplicitaPct: sanitizeNum(metrics.temImplicitaPct),
        forwardToForwardPct: null,
        contractMultiplier: detail?.contractMultiplier ?? null,
        minPriceIncrement: detail?.minPriceIncrement ?? null,
        updatedAtUtcSec: snap.updatedAtUtcSec,
        source: 'PRIMARY_ROFEX',
      });
    }

    contracts.sort((a, b) => {
      const ta = a.expiryUtcSec ?? Number.MAX_SAFE_INTEGER;
      const tb = b.expiryUtcSec ?? Number.MAX_SAFE_INTEGER;
      if (ta !== tb) return ta - tb;
      return a.contract.localeCompare(b.contract);
    });

    this.liveDlrContracts = withForwardToForward(contracts);
    this.liveDlrLastUpdateUtcSec = nowSec;
  }

  /** Snapshot DLR/* derivado de los últimos ticks `Md` (sin red; actualizado en el handler WS). */
  public getLiveDlrFutures(): readonly PrimaryDlrContractDto[] {
    return this.liveDlrContracts;
  }

  /** Spot A3500 BCRA vigente; permite calcular TNA/TEA en vivo sin depender de `DLR/SPOT`. */
  public setReferenceSpotA3500(value: number | null): void {
    this.referenceSpotA3500 =
      value !== null && Number.isFinite(value) && value > 0 ? value : null;
    if (this.wsSnapshots.size > 0) {
      this.recomputeLiveDlrDerived();
    }
  }

  public getLiveDlrLastUpdateUtcSec(): number | null {
    return this.liveDlrLastUpdateUtcSec;
  }

  public getWsEnvironment(): 'PRIMARY_MATRIZ_WS' | 'PRIMARY_ECO_XOMS_WS' | 'PRIMARY_REMARKETS_SANDBOX' {
    return this.wsEnvironment;
  }

  /**
   * Descubre contratos DLR/* vigentes y abre el stream `smd` autenticado.
   * Solo futuros outright `DLR/MMMYY` (sin SPOT, minis, opciones ni pases).
   * Idempotente: no duplica sockets ni suscripciones; si el stream BYMA L2 de
   * Eco Valores ya cubre toda la curva descubierta, no agrega un segundo grupo.
   */
  public async startDlrLiveStream(): Promise<void> {
    if (!this.config.configured) return;
    if (this.dlrStreamInFlight !== null) return this.dlrStreamInFlight;
    const run = async (): Promise<void> => {
      const discovered = await this.discoverDlrInstruments(false);
      if (discovered.firstError !== null) {
        this.lastError = discovered.firstError;
      }
      const todayUtc = new Date(this.nowMsFn()).toISOString().slice(0, 10).replace(/-/g, '');
      const products = filterDlrOutrightProducts(
        discovered.instruments,
        todayUtc,
        (symbol) => this.dlrDetailBySymbol.get(symbol)?.maturityDate ?? null,
      );
      if (products.length === 0) return;
      if (this.areAllSymbolsSubscribed(products)) return;
      await this.connectAndSubscribeWs(products, 5);
    };
    this.dlrStreamInFlight = run().finally(() => {
      this.dlrStreamInFlight = null;
    });
    return this.dlrStreamInFlight;
  }

  /**
   * Stream productivo Eco Valores XOMS — L2 BYMA 5 puntas + curva ROFEX.
   *
   * Descubre dinámicamente por `GET /rest/instruments/all`:
   *  - BYMA (MERV): GGAL plazo normal `24hs`/`T1` + `CI`, líderes del Merval,
   *    principales CEDEARs y opciones activas `GFGC*`/`GFGV*`.
   *  - ROFX: toda la curva outright `DLR/MMMYY` vigente.
   * y los suscribe en un único mensaje `smd` level 2 con puntas BI/OF hasta 5
   * niveles por lado. Idempotente (single-flight + cobertura por símbolo).
   */
  public async startBymaL2LiveStream(
    options: { readonly fixedIncomeTickers?: readonly string[] } = {},
  ): Promise<void> {
    if (!this.config.configured) return;
    if (this.bymaStreamInFlight !== null) return this.bymaStreamInFlight;
    const run = async (): Promise<void> => {
      const catalog = await this.getAllInstruments(false);
      const mervProducts = selectBymaL2Products(catalog, {
        ...(options.fixedIncomeTickers === undefined
          ? {}
          : { fixedIncomeTickers: [...BYMA_L2_FIXED_INCOME_TICKERS, ...options.fixedIncomeTickers] }),
      });
      const todayUtc = new Date(this.nowMsFn()).toISOString().slice(0, 10).replace(/-/g, '');
      const dlrProducts = filterDlrOutrightProducts(
        catalog,
        todayUtc,
        (symbol) => this.dlrDetailBySymbol.get(symbol)?.maturityDate ?? null,
      );
      const merged = new Map<string, { readonly marketId: string; readonly symbol: string }>();
      for (const product of [...mervProducts, ...dlrProducts]) {
        const key = `${product.marketId}:${product.symbol}`;
        if (!merged.has(key)) {
          merged.set(key, product);
        }
      }
      const products = [...merged.values()].sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
      if (products.length === 0) return;
      if (this.areAllSymbolsSubscribed(products)) return;
      await this.connectAndSubscribeBymaL2(products);
    };
    this.bymaStreamInFlight = run().finally(() => {
      this.bymaStreamInFlight = null;
    });
    return this.bymaStreamInFlight;
  }

  /**
   * Descarga contratos reales `DLR/*` outright y sus métricas puras consumiendo
   * exclusivamente los snapshots del WebSocket `smd` (nunca loops REST de
   * `/rest/marketdata/get` por contrato, que disparan HTTP 429). Antes del primer
   * tick los campos de precio quedan en `null` (la interfaz muestra `—`): se
   * prohíbe inventar valores de respaldo. El spot proviene de A3500 (BCRA).
   */
  public async getDlrFuturesAndDerivatives(params: {
    readonly asOfUtcSec: number;
    readonly a3500: number | null;
    readonly forceRefresh?: boolean;
  }): Promise<{
    readonly spotUsed: number | null;
    readonly spotSource: 'A3500_BCRA' | 'DLR_SPOT' | 'NONE';
    readonly contracts: readonly PrimaryDlrContractDto[];
    readonly error: string | null;
  }> {
    if (!this.config.configured) {
      return { spotUsed: null, spotSource: 'NONE', contracts: [], error: null };
    }
    try {
      const discovered = await this.discoverDlrInstruments(Boolean(params.forceRefresh));
      if (discovered.instruments.length === 0) {
        return {
          spotUsed: null,
          spotSource: 'NONE',
          contracts: [],
          error: discovered.firstError,
        };
      }

      // Garantiza el socket autenticado con el único mensaje `smd` de outrights
      // (el descubrimiento ya está cacheado por la llamada anterior).
      try {
        await this.startDlrLiveStream();
      } catch (err: unknown) {
        this.lastError = this.redact(err instanceof Error ? err.message : String(err));
      }

      const todayUtc = new Date(params.asOfUtcSec * 1_000).toISOString().slice(0, 10).replace(/-/g, '');
      const products = filterDlrOutrightProducts(
        discovered.instruments,
        todayUtc,
        (symbol) => this.dlrDetailBySymbol.get(symbol)?.maturityDate ?? null,
      );

      const resolvedSpotUsed =
        params.a3500 !== null && Number.isFinite(params.a3500) && params.a3500 > 0 ? params.a3500 : null;
      const resolvedSpotSource: 'A3500_BCRA' | 'DLR_SPOT' | 'NONE' =
        resolvedSpotUsed !== null ? 'A3500_BCRA' : 'NONE';

      const contracts: PrimaryDlrContractDto[] = products.map((inst) => {
        const snap = this.wsSnapshots.get(`${inst.marketId}:${inst.symbol}`) ?? null;
        const maturityDateRaw =
          this.dlrDetailBySymbol.get(inst.symbol)?.maturityDate ?? inferDlrMaturityDateStr(inst.symbol);
        // Sin snapshot WS todavía: todas las lecturas de precio quedan ausentes (NaN),
        // de modo que la UI muestra "—" en lugar de un precio de respaldo.
        const metrics = computeDlrContractMetrics({
          asOfUtcSec: params.asOfUtcSec,
          maturityDate: maturityDateRaw,
          last: snap?.last,
          bestBid: snap?.bids[0]?.price,
          bestAsk: snap?.asks[0]?.price,
          settlement: snap?.settlement,
          close: snap?.close,
          a3500: params.a3500,
          dlrSpot: null,
        });
        const expiryUtcSec = sanitizeNum(metrics.maturityUtcSec);
        const maturityIso =
          expiryUtcSec !== null ? new Date(expiryUtcSec * 1_000).toISOString().slice(0, 10) : null;
        const detail = this.dlrDetailBySymbol.get(inst.symbol) ?? null;

        return {
          contract: inst.symbol,
          category: 'OUTRIGHT',
          marketId: inst.marketId,
          maturity: maturityIso,
          expiryUtcSec,
          days: sanitizeNum(metrics.days),
          price: sanitizeNum(metrics.referencePrice),
          priceBasis: metrics.priceBasis,
          last: snap?.last ?? null,
          settlement: snap?.settlement ?? null,
          close: snap?.close ?? null,
          bid: snap?.bids[0]?.price ?? null,
          bidPrice: snap?.bids[0]?.price ?? null,
          bidSize: snap?.bids[0]?.size ?? null,
          ask: snap?.asks[0]?.price ?? null,
          askPrice: snap?.asks[0]?.price ?? null,
          askSize: snap?.asks[0]?.size ?? null,
          bids: snap?.bids ?? [],
          asks: snap?.asks ?? [],
          openInterest: snap?.openInterest ?? null,
          nominalVolume: snap?.nominalVolume ?? null,
          open: snap?.open ?? null,
          high: snap?.high ?? null,
          low: snap?.low ?? null,
          spotUsed: sanitizeNum(metrics.spotUsed),
          spotSource: metrics.spotSource,
          devalDirectaPct: sanitizeNum(metrics.devalDirectaPct),
          tnaImplicitaPct: sanitizeNum(metrics.tnaImplicitaPct),
          teaImplicitaPct: sanitizeNum(metrics.teaImplicitaPct),
          temImplicitaPct: sanitizeNum(metrics.temImplicitaPct),
          forwardToForwardPct: null,
          contractMultiplier: detail?.contractMultiplier ?? null,
          minPriceIncrement: detail?.minPriceIncrement ?? null,
          updatedAtUtcSec: snap?.updatedAtUtcSec ?? null,
          source: 'PRIMARY_ROFEX',
        };
      });

      contracts.sort((a, b) => {
        const ta = a.expiryUtcSec ?? Number.MAX_SAFE_INTEGER;
        const tb = b.expiryUtcSec ?? Number.MAX_SAFE_INTEGER;
        if (ta !== tb) {
          return ta - tb;
        }
        return a.contract.localeCompare(b.contract);
      });

      return {
        spotUsed: resolvedSpotUsed,
        spotSource: resolvedSpotSource,
        contracts: withForwardToForward(contracts),
        error: null,
      };
    } catch (err: unknown) {
      const msg = this.redact(err instanceof Error ? err.message : String(err));
      this.lastError = msg;
      return { spotUsed: null, spotSource: 'NONE', contracts: [], error: msg };
    }
  }

  /**
   * Obtiene caja de 5 puntas L2 desde segmento MERV de Primary para un ticker BYMA.
   */
  public async getMervOrderBook5Levels(
    rawTicker: string,
    forceRefresh = false,
    preferredSettlement?: '24HS' | 'CI',
  ): Promise<OrderBook5LevelsDto | null> {
    if (!this.config.configured) {
      return null;
    }
    const cleanTicker = rawTicker.trim().toUpperCase();
    try {
      const mervList = await this.getInstrumentsBySegment('MERV', 'ROFX', false);
      const candidates = mervList
        .map((item) => ({ item, parsed: parseMervInstrumentSymbol(item.symbol) }))
        .filter(
          (entry): entry is {
            readonly item: { readonly marketId: string; readonly symbol: string };
            readonly parsed: NonNullable<ReturnType<typeof parseMervInstrumentSymbol>>;
          } => entry.parsed !== null && entry.parsed.ticker === cleanTicker,
        );
      if (candidates.length === 0) {
        return null;
      }

      const preferred =
        preferredSettlement === 'CI'
          ? candidates.find((c) => c.parsed.settlement.toUpperCase() === 'CI')
          : preferredSettlement === '24HS'
            ? candidates.find((c) => c.parsed.settlement.toUpperCase() === '24HS')
            : (candidates.find((c) => c.parsed.settlement.toUpperCase() === '24HS') ??
              candidates.find((c) => c.parsed.settlement.toUpperCase() === 'CI') ??
              candidates[0]);
      if (preferred === undefined) {
        return null;
      }

      // Fast path en vivo: con el stream L2 BYMA conectado, el snapshot WS `Md`
      // más reciente alimenta la 5 puntas sin REST (ggalSpecialistRuntime y
      // StockDetailView la consumen con prioridad cuando BMB L2 está deshabilitado).
      const nowSecForWs = Math.floor(this.nowMsFn() / 1_000);
      const liveSnap =
        this.wsSnapshots.get(`${preferred.item.marketId}:${preferred.item.symbol}`) ?? null;
      const liveSnapFresh =
        liveSnap !== null &&
        liveSnap.updatedAtUtcSec !== null &&
        liveSnap.updatedAtUtcSec > 0 &&
        nowSecForWs >= liveSnap.updatedAtUtcSec &&
        nowSecForWs - liveSnap.updatedAtUtcSec <= LIVE_MERV_WS_MAX_AGE_SEC &&
        (liveSnap.bids.length > 0 || liveSnap.asks.length > 0 || liveSnap.last !== null);

      let md: ParsedPrimaryMarketData | null = null;
      if (liveSnapFresh) {
        // `liveSnapFresh` (alias const de la condición) ya angosta liveSnap a no-null (TS 4.4+).
        md = liveSnap;
      } else {
        md = await this.getMarketData(
          preferred.item.symbol,
          preferred.item.marketId,
          5,
          forceRefresh,
        );
      }
      if (md === null) {
        return null;
      }
      const metrics = computeOrderBookL2Metrics(md.bids, md.asks);
      const hasLiveDepth = md.bids.length > 0 || md.asks.length > 0;

      return {
        symbol: cleanTicker,
        marketSymbol: preferred.item.symbol,
        settlement: preferred.parsed.settlement,
        marketState: hasLiveDepth ? 'LIVE' : 'WEEKEND_CLOSED',
        source: 'PRIMARY_MERV',
        asOfUtcSec: md.updatedAtUtcSec,
        bids: md.bids,
        asks: md.asks,
        bestBid: sanitizeNum(metrics.bestBid),
        bestAsk: sanitizeNum(metrics.bestAsk),
        mid: sanitizeNum(metrics.mid),
        spreadArs: sanitizeNum(metrics.spread),
        spreadPct: sanitizeNum(metrics.spreadPct),
        bidDepthSize: sanitizeNum(metrics.bidDepthSize),
        askDepthSize: sanitizeNum(metrics.askDepthSize),
        vwapBid5: sanitizeNum(metrics.vwapBid5),
        vwapAsk5: sanitizeNum(metrics.vwapAsk5),
        vwapBook5: sanitizeNum(metrics.vwapBook5),
        obi5: sanitizeNum(metrics.obi5),
        last: md.last,
        open: md.open,
        high: md.high,
        low: md.low,
        close: md.close,
        settlementPrice: md.settlement,
        nominalVolume: md.nominalVolume,
      };
    } catch (err: unknown) {
      this.lastError = this.redact(err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /**
   * Consulta read-only de posiciones y reporte de cuenta (`PRIMARY_ACCOUNT`).
   */
  public async getAccountPositionsAndReport(): Promise<{
    readonly summary: BrokerAccountSummaryDto;
    readonly positions: readonly BrokerPositionDto[];
  }> {
    const accountName = this.config.account;
    if (!this.config.configured || accountName === '') {
      return {
        summary: {
          broker: 'PRIMARY_REMARKETS',
          accountLabel: accountName !== '' ? accountName : null,
          status: 'DISABLED',
          collateral: null,
          margin: null,
          availableToCollateral: null,
          cashTotalArs: null,
          pendingMovementsArs: null,
          lastCalculationMs: null,
          marketMember: null,
          currencyBalances: [],
          error: null,
        },
        positions: [],
      };
    }

    try {
      const encodedAcct = encodeURIComponent(accountName);
      const [posRaw, reportRaw] = await Promise.all([
        this.requestJson(`/rest/risk/position/getPositions/${encodedAcct}`),
        this.requestJson(`/rest/risk/accountReport/${encodedAcct}`),
      ]);

      const positions: BrokerPositionDto[] = [];
      if (isPlainRecord(posRaw) && Array.isArray(posRaw['positions'])) {
        for (const item of posRaw['positions']) {
          if (!isPlainRecord(item)) {
            continue;
          }
          const inst = isPlainRecord(item['instrument']) ? item['instrument'] : null;
          const symbol =
            readStr(item, ['tradingSymbol', 'symbol']) ??
            (inst ? readStr(inst, ['symbol']) : null) ??
            'UNKNOWN';
          const marketId = inst ? readStr(inst, ['marketId']) : readStr(item, ['marketId']);
          const buySize = readNum(item, ['buySize']) ?? 0;
          const sellSize = readNum(item, ['sellSize']) ?? 0;
          positions.push({
            symbol,
            marketId,
            buySize,
            sellSize,
            netSize: buySize - sellSize,
            buyPrice: readNum(item, ['originalBuyPrice', 'buyPrice']),
            sellPrice: readNum(item, ['originalSellPrice', 'sellPrice']),
            totalDailyDiffArs: readNum(item, ['totalDailyDiff']),
            totalDiffArs: readNum(item, ['totalDiff']),
            source: 'PRIMARY_ROFEX',
          });
        }
      }

      let collateral: number | null = null;
      let margin: number | null = null;
      let availableToCollateral: number | null = null;
      let cashTotalArs: number | null = null;
      let pendingMovementsArs: number | null = null;
      let lastCalculationMs: number | null = null;
      let marketMember: string | null = null;
      let resolvedAccountLabel: string | null = accountName;
      const currencyBalances: BrokerCurrencyBalanceDto[] = [];

      if (isPlainRecord(reportRaw) && isPlainRecord(reportRaw['accountData'])) {
        const acct = reportRaw['accountData'];
        resolvedAccountLabel = readStr(acct, ['accountName']) ?? accountName;
        marketMember = readStr(acct, ['marketMember']);
        collateral = readNum(acct, ['collateral']);
        margin = readNum(acct, ['margin']);
        availableToCollateral = readNum(acct, ['availableToCollateral']);
        lastCalculationMs = readNum(acct, ['lastCalculation']);

        const detailed = isPlainRecord(acct['detailedAccountReports'])
          ? acct['detailedAccountReports']
          : null;
        const firstBucket = detailed ? Object.values(detailed).find(isPlainRecord) ?? null : null;
        if (firstBucket !== null) {
          const availOp = isPlainRecord(firstBucket['availableToOperate'])
            ? firstBucket['availableToOperate']
            : null;
          if (availOp !== null) {
            pendingMovementsArs = readNum(availOp, ['pendingMovements']);
            const cash = isPlainRecord(availOp['cash']) ? availOp['cash'] : null;
            if (cash !== null) {
              const detailedCash = isPlainRecord(cash['detailedCash']) ? cash['detailedCash'] : null;
              cashTotalArs =
                (detailedCash ? readNum(detailedCash, ['ARS']) : null) ?? readNum(cash, ['totalCash']);
            }
          }
          const curBal = isPlainRecord(firstBucket['currencyBalance'])
            ? firstBucket['currencyBalance']
            : null;
          const detCur = curBal && isPlainRecord(curBal['detailedCurrencyBalance'])
            ? curBal['detailedCurrencyBalance']
            : null;
          if (detCur !== null) {
            for (const [currency, val] of Object.entries(detCur)) {
              if (!isPlainRecord(val)) {
                continue;
              }
              const consumed = readNum(val, ['consumed']);
              const available = readNum(val, ['available']);
              if ((consumed ?? 0) !== 0 || (available ?? 0) !== 0 || currency === 'ARS' || currency === 'USD D') {
                currencyBalances.push({ currency, consumed, available });
              }
            }
          }
        }
      }

      return {
        summary: {
          broker: 'PRIMARY_REMARKETS',
          accountLabel: resolvedAccountLabel,
          status: 'OK',
          collateral,
          margin,
          availableToCollateral,
          cashTotalArs,
          pendingMovementsArs,
          lastCalculationMs,
          marketMember,
          currencyBalances,
          error: null,
        },
        positions,
      };
    } catch (err: unknown) {
      const msg = this.redact(err instanceof Error ? err.message : String(err));
      this.lastError = msg;
      return {
        summary: {
          broker: 'PRIMARY_REMARKETS',
          accountLabel: accountName,
          status: 'ERROR',
          collateral: null,
          margin: null,
          availableToCollateral: null,
          cashTotalArs: null,
          pendingMovementsArs: null,
          lastCalculationMs: null,
          marketMember: null,
          currencyBalances: [],
          error: msg,
        },
        positions: [],
      };
    }
  }

  public getSafeHealthStatus(): PrimaryConnectorHealthDto {
    const tokenValidUntilUtcSec =
      this.authToken !== null && this.tokenIssuedAtMs > 0
        ? Math.floor((this.tokenIssuedAtMs + PRIMARY_TOKEN_MAX_AGE_MS) / 1_000)
        : null;
    return {
      configured: this.config.configured,
      apiUrl: this.config.apiUrl,
      accountLabel: this.config.account !== '' ? this.config.account : null,
      authenticated: this.authToken !== null && this.authToken !== '',
      tokenValidUntilUtcSec,
      tokenRenewCount: this.tokenRenewCount,
      wsConnected: this.wsConnected,
      wsEnvironment: this.wsEnvironment,
      wsLastMessageUtcSec:
        this.wsLastMessageAtMs > 0 ? Math.floor(this.wsLastMessageAtMs / 1_000) : null,
      dlrCount: this.cachedCounts.dlr,
      liveDlrCount: this.liveDlrContracts.filter((contract) => contract.category !== 'SPOT').length,
      liveDlrLastUpdateUtcSec: this.liveDlrLastUpdateUtcSec,
      dlrSubscribedCount: this.wsSubscriptions.filter((item) => item.symbol.startsWith('DLR/')).length,
      mervSubscribedCount: this.wsSubscriptions.filter(
        (item) => parseMervInstrumentSymbol(item.symbol) !== null,
      ).length,
      liveMervBookCount: this.countLiveMervBooks(),
      ddfCount: this.cachedCounts.ddf,
      mervCount: this.cachedCounts.merv,
      lastError: this.lastError !== null ? this.redact(this.lastError) : null,
    };
  }

  /** Libros MERV con puntas vivas en los snapshots WS (`Md`). */
  private countLiveMervBooks(): number {
    let count = 0;
    for (const [key, snap] of this.wsSnapshots) {
      const separator = key.indexOf(':');
      const symbol = separator >= 0 ? key.slice(separator + 1) : key;
      if (parseMervInstrumentSymbol(symbol) === null) {
        continue;
      }
      if (snap.bids.length > 0 || snap.asks.length > 0) {
        count += 1;
      }
    }
    return count;
  }

  public getDlrSubscribedSymbols(): readonly string[] {
    return this.wsSubscriptions
      .filter((item) => item.symbol.startsWith('DLR/'))
      .map((item) => item.symbol);
  }

  public getBymaL2SubscribedSymbols(): readonly string[] {
    return this.wsSubscriptions
      .filter((item) => parseMervInstrumentSymbol(item.symbol) !== null)
      .map((item) => item.symbol);
  }

  public getFeedTelemetrySnapshot(nowMs: number): FeedTelemetrySnapshot {
    return this.wsTelemetry.snapshot(nowMs);
  }

  /** Pieza 33: fuerza token nuevo + reapertura de todos los streams `smd` activos. */
  public async reconnectDlrLiveStream(): Promise<void> {
    if (!this.config.configured) {
      throw new Error('PRIMARY_USERNAME / PRIMARY_PASSWORD not configured');
    }
    const hasGroups = this.wsGroups.size > 0;
    this.wsIntentionalClose = true;
    this.clearWsSessionTimers();
    if (this.wsReconnectTimer !== null) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    const sock = this.ws;
    this.ws = null;
    this.wsConnected = false;
    if (sock !== null) {
      try {
        sock.close(1000, 'feeds_health_reconnect');
      } catch {
        // The explicit reconnect below owns recovery.
      }
    }
    await this.getAuthToken(true);
    if (hasGroups) {
      // Reabre el socket y re-envía cada grupo con su propio payload (DLR level 5 + BYMA L2 level 2).
      await this.openWsAndSubscribeAll();
      return;
    }
    this.wsIntentionalClose = false;
    await this.startDlrLiveStream();
  }
}

export interface BmbBridgeClientDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchFn?: PrimaryHttpFn;
  readonly nowMsFn?: () => number;
  readonly secrets?: readonly string[];
  readonly timeoutMs?: number;
}

/**
 * Cliente HTTP local para consumir `tools/bmb_homebroker_bridge.py` en `127.0.0.1:8788`.
 */
export class BmbBridgeClient {
  private readonly config: BmbConfig;
  private readonly fetchFn: PrimaryHttpFn;
  private readonly nowMsFn: () => number;
  private readonly secrets: readonly string[];
  private readonly timeoutMs: number;
  private readonly snapshotCache: SingleFlightRuntimeCache<BmbBridgeSnapshotDto>;
  private readonly signalRConfigured: boolean;
  private lastHealth: BmbConnectorHealthDto;

  public constructor(deps: BmbBridgeClientDeps = {}) {
    const env = deps.env ?? process.env;
    this.config = loadBmbConfigFromEnv(env);
    this.fetchFn = deps.fetchFn ?? defaultPrimaryHttpFn;
    this.nowMsFn = deps.nowMsFn ?? (() => Date.now());
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_BMB_TIMEOUT_MS;
    this.signalRConfigured = isBmbInversionesSignalRConfigured(env);

    const secretSet = new Set<string>(deps.secrets ?? []);
    for (const s of collectBrokerSecretsFromEnv(env)) {
      secretSet.add(s);
    }
    this.secrets = [...secretSet];

    this.lastHealth = {
      status: this.config.passwordConfigured ? 'OFFLINE' : 'DISABLED_NO_PASSWORD',
      brokerId: this.config.brokerId,
      accountLabel: this.config.account !== '' ? `BMB ${this.config.account}` : null,
      pyhomebrokerInstalled: null,
      passwordConfigured: this.config.passwordConfigured,
      connected: false,
      lastUpdateUtcSec: null,
      counts: { cauciones: 0, orderBooks: 0, options: 0 },
      error: null,
    };

    this.snapshotCache = new SingleFlightRuntimeCache({
      ttlResolver: () => BMB_CACHE_TTL_MS,
      nowFn: this.nowMsFn,
    });
  }

  public getSafeHealthStatus(): BmbConnectorHealthDto {
    return this.lastHealth;
  }

  public async getSnapshot(
    symbol?: string,
    badlarTna: number | null = null,
    forceRefresh = false,
  ): Promise<BmbBridgeSnapshotDto> {
    const symKey = symbol !== undefined && symbol.trim() !== '' ? symbol.trim().toUpperCase() : 'ALL';
    if (!this.config.passwordConfigured && !this.signalRConfigured) {
      this.lastHealth = {
        ...this.lastHealth,
        status: 'DISABLED_NO_PASSWORD',
        passwordConfigured: false,
        connected: false,
      };
      return {
        health: this.lastHealth,
        cauciones: [],
        orderBooksBySymbol: {},
        options: [],
      };
    }

    const res = await this.snapshotCache.getOrCompute(
      `bmb:${symKey}`,
      async () => {
        try {
          const qs = symKey !== 'ALL' ? `?symbol=${encodeURIComponent(symKey)}` : '';
          const response = await this.fetchFn(`${this.config.bridgeUrl}/snapshot${qs}`, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            timeoutMs: this.timeoutMs,
          });
          if (!response.ok) {
            throw new Error(`HTTP ${String(response.status)}`);
          }
          const raw: unknown = JSON.parse(response.text);
          if (!isPlainRecord(raw)) {
            throw new Error('Malformed JSON from BMB bridge');
          }

          const statusRaw = readStr(raw, ['status']) ?? 'ERROR';
          const status = (
            [
              'READY',
              'CONNECTED_L2',
              'OUT_OF_SESSION',
              'STANDBY_2FA',
              'MISSING_DEPENDENCY',
              'DISABLED_NO_PASSWORD',
              'CONNECTING',
              'DISCONNECTED',
              'OFFLINE',
              'ERROR',
            ].includes(statusRaw)
              ? statusRaw
              : 'ERROR'
          ) as BmbConnectorHealthDto['status'];

          const rawCauciones = Array.isArray(raw['cauciones']) ? raw['cauciones'] : [];
          const cauciones: BmbCaucionRowDto[] = [];
          for (const item of rawCauciones) {
            if (!isPlainRecord(item)) {
              continue;
            }
            const termDays = readNum(item, ['termDays', 'days', 'plazo']);
            if (termDays === null || termDays <= 0) {
              continue;
            }
            const curRaw = (readStr(item, ['currency']) ?? 'ARS').toUpperCase();
            const currency: 'ARS' | 'USD' = curRaw === 'USD' ? 'USD' : 'ARS';
            const tnaWeighted = readNum(item, ['tnaWeighted', 'tna', 'last']);
            const teaComputed =
              tnaWeighted !== null
                ? sanitizeNum(computeCaucionTeaEffectivePct(tnaWeighted, termDays))
                : readNum(item, ['teaEffective']);
            const spreadBps =
              tnaWeighted !== null && badlarTna !== null
                ? sanitizeNum(computeSpreadVsBadlarBps(tnaWeighted, badlarTna))
                : null;
            cauciones.push({
              symbol: readStr(item, ['symbol']) ?? `CAUCION_${String(termDays)}D_${currency}`,
              termDays: Math.round(termDays),
              currency,
              tnaWeighted,
              teaEffective: teaComputed,
              bidTna: readNum(item, ['bidTna', 'bid']),
              askTna: readNum(item, ['askTna', 'ask']),
              turnoverArs: readNum(item, ['turnoverArs', 'turnover', 'volume']),
              spreadVsBadlarBps: spreadBps,
              asOfUtcSec: toUtcSecFromMixed(readNum(item, ['asOfUtcSec'])),
              source: 'BMB_HOMEBROKER',
            });
          }

          const booksOut: Record<string, BmbBridgeBookEntry> = {};
          if (isPlainRecord(raw['orderBooksBySymbol'])) {
            for (const [k, v] of Object.entries(raw['orderBooksBySymbol'])) {
              if (!isPlainRecord(v)) {
                continue;
              }
              booksOut[k.toUpperCase()] = {
                symbol: readStr(v, ['symbol']) ?? k.toUpperCase(),
                settlement: readStr(v, ['settlement']) ?? '24hs',
                bids: [...parseDepthLevels(v['bids'])].sort((a, b) => b.price - a.price).slice(0, 5),
                asks: [...parseDepthLevels(v['asks'])].sort((a, b) => a.price - b.price).slice(0, 5),
                asOfUtcSec: toUtcSecFromMixed(readNum(v, ['asOfUtcSec'])),
                source: 'BMB_HOMEBROKER',
              };
            }
          }

          const rawOptions = Array.isArray(raw['options']) ? raw['options'] : [];
          const options: BmbOptionRowDto[] = [];
          for (const item of rawOptions) {
            if (!isPlainRecord(item)) {
              continue;
            }
            const optSym = readStr(item, ['symbol']);
            if (optSym === null) {
              continue;
            }
            options.push({
              symbol: optSym.toUpperCase(),
              underlying: readStr(item, ['underlying'])?.toUpperCase() ?? null,
              bid: readNum(item, ['bid']),
              bidSize: readNum(item, ['bidSize', 'bid_size', 'bidsize', 'q_bid']),
              ask: readNum(item, ['ask']),
              askSize: readNum(item, ['askSize', 'ask_size', 'asksize', 'q_ask']),
              last: readNum(item, ['last']),
              volume: readNum(item, ['volume']),
              turnover: readNum(item, ['turnover']),
              varPct: readNum(item, ['varPct', 'changePct', 'pct_change', 'variation']),
              asOfUtcSec: toUtcSecFromMixed(readNum(item, ['asOfUtcSec'])),
            });
          }

          const tradesBySymbol: Record<string, readonly BmbTradeRowDto[]> = {};
          if (isPlainRecord(raw['tradesBySymbol'])) {
            for (const [tradeSymbol, rawTrades] of Object.entries(raw['tradesBySymbol'])) {
              if (!Array.isArray(rawTrades)) {
                continue;
              }
              const parsedTrades: BmbTradeRowDto[] = [];
              for (const item of rawTrades) {
                if (!isPlainRecord(item)) {
                  continue;
                }
                const sequence = readNum(item, ['sequence']);
                const timeSec = toUtcSecFromMixed(readNum(item, ['timeSec']));
                const price = readNum(item, ['price']);
                const size = readNum(item, ['size']);
                const sideRaw = (readStr(item, ['side']) ?? 'UNKNOWN').toUpperCase();
                const side = sideRaw === 'BUY' || sideRaw === 'SELL' ? sideRaw : 'UNKNOWN';
                if (
                  sequence === null ||
                  !Number.isInteger(sequence) ||
                  sequence < 0 ||
                  timeSec === null ||
                  price === null ||
                  price <= 0 ||
                  size === null ||
                  size < 0
                ) {
                  continue;
                }
                parsedTrades.push({
                  sequence,
                  symbol: readStr(item, ['symbol'])?.toUpperCase() ?? tradeSymbol.toUpperCase(),
                  timeSec,
                  price,
                  size,
                  side,
                  buyVolume: readNum(item, ['buyVolume']),
                  sellVolume: readNum(item, ['sellVolume']),
                  ...(typeof item['attributableToLast'] === 'boolean'
                    ? { attributableToLast: item['attributableToLast'] }
                    : {}),
                });
              }
              tradesBySymbol[tradeSymbol.toUpperCase()] = parsedTrades;
            }
          }

          const errRaw = readStr(raw, ['error']);
          const safeErr = errRaw !== null ? redactSecrets(errRaw, this.secrets) : null;
          const asOfUtcSec = toUtcSecFromMixed(readNum(raw, ['asOfUtcSec']));
          const pyInstalled =
            typeof raw['pyhomebrokerInstalled'] === 'boolean' ? raw['pyhomebrokerInstalled'] : null;

          this.lastHealth = {
            status,
            brokerId: this.config.brokerId,
            accountLabel:
              readStr(raw, ['accountLabel']) ??
              (this.config.account !== '' ? `BMB ${this.config.account}` : null),
            pyhomebrokerInstalled: pyInstalled,
            passwordConfigured: this.config.passwordConfigured,
            connected: status === 'READY' || status === 'CONNECTED_L2',
            lastUpdateUtcSec: asOfUtcSec,
            counts: {
              cauciones: cauciones.length,
              orderBooks: Object.keys(booksOut).length,
              options: options.length,
            },
            error: safeErr,
          };

          return {
            health: this.lastHealth,
            cauciones,
            orderBooksBySymbol: booksOut,
            options,
            tradesBySymbol,
            ...(isPlainRecord(raw['telemetry'])
              ? {
                  telemetry: {
                    totalMessagesReceived:
                      typeof raw['telemetry']['totalMessagesReceived'] === 'number' &&
                      Number.isFinite(raw['telemetry']['totalMessagesReceived']) &&
                      raw['telemetry']['totalMessagesReceived'] >= 0
                        ? Math.floor(raw['telemetry']['totalMessagesReceived'])
                        : 0,
                    lastMessageAtMs:
                      typeof raw['telemetry']['lastMessageAtMs'] === 'number' &&
                      Number.isFinite(raw['telemetry']['lastMessageAtMs']) &&
                      raw['telemetry']['lastMessageAtMs'] > 0
                        ? raw['telemetry']['lastMessageAtMs']
                        : null,
                  },
                }
              : {}),
          };
        } catch (err: unknown) {
          const safeMsg = redactSecrets(
            `BMB Bridge no disponible: ${err instanceof Error ? err.message : String(err)}`,
            this.secrets,
          );
          this.lastHealth = {
            ...this.lastHealth,
            status: 'OFFLINE',
            connected: false,
            error: safeMsg,
          };
          return {
            health: this.lastHealth,
            cauciones: [],
            orderBooksBySymbol: {},
            options: [],
          };
        }
      },
      { forceRefresh },
    );

    return res.value;
  }

  /** Pieza 33: pide reconexión al bridge local (loopback), sin exponer credenciales.
   * Pieza 38.1: el modo SignalR Core (BMB_HUB_TOKEN/BMB_SESSION_COOKIE) no
   * requiere BMB_PASSWORD y el bridge local responde 202 en `POST /reconnect`. */
  public async requestReconnect(): Promise<void> {
    if (!this.config.passwordConfigured && !this.signalRConfigured) {
      throw new Error('BMB password not configured');
    }
    const response = await this.fetchFn(`${this.config.bridgeUrl}/reconnect`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      timeoutMs: this.timeoutMs,
    });
    if (response.status !== 202) {
      throw new Error(`BMB bridge reconnect HTTP ${String(response.status)}`);
    }
  }
}
