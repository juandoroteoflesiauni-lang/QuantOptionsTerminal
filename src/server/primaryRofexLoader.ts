/**
 * Conectores reales para Primary API v1.21 (reMarkets / MATBA ROFEX + MERV)
 * y cliente consumidor del puente local Bull Market Brokers (HomeBroker SignalR, broker 153).
 *
 * Seguridad y Zero Silent Fallbacks:
 *  - Lee credenciales exclusivamente desde `process.env` (o `env` inyectado en tests).
 *  - Nunca hardcodea ni expone `PRIMARY_PASSWORD`, `PRIMARY_USERNAME`, `BMB_PASSWORD`,
 *    `BMB_DNI`, `BMB_USERNAME` ni `X-Auth-Token` en respuestas HTTP, WebSocket o logs.
 *  - Toda cadena matemática pura (devaluación directa, TNA/TEA base 365, métricas L2 5 puntas,
 *    TEA de cauciones) vive en funciones puras sin red que devuelven `NaN` si faltan datos.
 *  - Si un mercado está cerrado (fin de semana) o falta `pyhomebroker`/`BMB_PASSWORD`,
 *    degrada explícitamente con badges y estados reales sin inventar puntas ni precios.
 */

import { WebSocket } from 'ws';
import type { FetchResponse } from '../data/types.js';
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
}

export interface PrimaryConnectorHealthDto {
  readonly configured: boolean;
  readonly apiUrl: string;
  readonly accountLabel: string | null;
  readonly authenticated: boolean;
  readonly tokenValidUntilUtcSec: number | null;
  readonly tokenRenewCount: number;
  readonly wsConnected: boolean;
  readonly dlrCount: number;
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
const DETAIL_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
const MD_CACHE_TTL_MS = 10_000;
const BMB_CACHE_TTL_MS = 8_000;

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
 * Lee credenciales Primary exclusivamente desde `env` (`process.env` por defecto).
 */
export function loadPrimaryConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PrimaryConfig {
  const apiUrl = (env['PRIMARY_API_URL'] ?? DEFAULT_PRIMARY_API_URL).trim().replace(/\/+$/, '');
  const wsUrl = (env['PRIMARY_WS_URL'] ?? DEFAULT_PRIMARY_WS_URL).trim();
  const username = (env['PRIMARY_USERNAME'] ?? '').trim();
  const password = (env['PRIMARY_PASSWORD'] ?? '').trim();
  const account = (env['PRIMARY_ACCOUNT'] ?? '').trim();

  return {
    apiUrl: apiUrl || DEFAULT_PRIMARY_API_URL,
    wsUrl: wsUrl || DEFAULT_PRIMARY_WS_URL,
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

  return {
    bridgeUrl: bridgeUrl || DEFAULT_BMB_BRIDGE_URL,
    brokerId,
    dni,
    username,
    password,
    account,
    passwordConfigured: password !== '',
  };
}

/**
 * Recolecta credenciales sensibles (sin incluir etiquetas no secretas como REM22710) para `redactSecrets`.
 */
export function collectBrokerSecretsFromEnv(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const names = [
    'PRIMARY_PASSWORD',
    'PRIMARY_USERNAME',
    'BMB_PASSWORD',
    'BMB_PASS',
    'BMB_DNI',
    'BMB_USERNAME',
    'BMB_USER',
    'BMB_ACCOUNT',
    'BMB_COMITENTE',
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

export function parseMervInstrumentSymbol(rawSymbol: string): {
  readonly ticker: string;
  readonly settlement: string;
  readonly rawSymbol: string;
} | null {
  const m = /^MERV\s*-\s*XMEV\s*-\s*([A-Z0-9.]+)\s*-\s*(24HS|CI|48HS|SPOT)$/i.exec(rawSymbol.trim());
  if (m === null) {
    return null;
  }
  const ticker = m[1]?.toUpperCase() ?? '';
  const settlement = m[2] ?? '';
  if (ticker === '' || settlement === '') {
    return null;
  }
  return {
    ticker,
    settlement: settlement.toUpperCase() === '24HS' ? '24hs' : settlement,
    rawSymbol,
  };
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
  };
}

async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<readonly R[]> {
  if (items.length === 0) {
    return [];
  }
  const results = new Array<R>(items.length);
  let nextIdx = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIdx < items.length) {
        const current = nextIdx;
        nextIdx += 1;
        results[current] = await worker(items[current] as T);
      }
    }),
  );
  return results;
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
}

/**
 * Cliente REST + WebSocket nativo para Primary API v1.21 (reMarkets / MATBA ROFEX + MERV).
 */
export class PrimaryRofexClient {
  private readonly config: PrimaryConfig;
  private readonly fetchFn: PrimaryHttpFn;
  private readonly wsFactory: PrimaryWsFactory;
  private readonly nowMsFn: () => number;
  private readonly baseSecrets: readonly string[];
  private readonly timeoutMs: number;
  private readonly minRequestIntervalMs: number;
  private readonly retry429DelayMs: number;

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
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_PRIMARY_TIMEOUT_MS;
    this.minRequestIntervalMs = deps.minRequestIntervalMs ?? (deps.fetchFn !== undefined ? 0 : 180);
    this.retry429DelayMs = deps.retry429DelayMs ?? (deps.fetchFn !== undefined ? 0 : 1_500);

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
        await new Promise<void>((res) => setTimeout(res, waitMs));
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
      const waitMs =
        Number.isFinite(retryAfterRaw) && retryAfterRaw > 0
          ? Math.min(10_000, retryAfterRaw * 1_000)
          : this.retry429DelayMs * (3 - retry429Left);
      if (waitMs > 0) {
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, waitMs));
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
    if (!isPlainRecord(raw) || !Array.isArray(raw['instruments'])) {
      return [];
    }
    const out: { readonly marketId: string; readonly symbol: string }[] = [];
    for (const item of raw['instruments']) {
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

  /**
   * Suscripción WebSocket `type: "smd"` con `depth: 5` hacia Primary.
   */
  public async connectAndSubscribeWs(
    products: readonly { readonly marketId: string; readonly symbol: string }[],
    depth = 5,
  ): Promise<void> {
    if (!this.config.configured || products.length === 0) {
      return;
    }
    const token = await this.getAuthToken(false);
    const subscribePayload = JSON.stringify({
      type: 'smd',
      level: 1,
      entries: ['BI', 'OF', 'LA', 'OP', 'CL', 'SE', 'OI', 'HI', 'LO', 'TV', 'EV', 'NV', 'IV'],
      products,
      depth,
    });

    if (this.ws !== null && this.wsConnected && this.ws.readyState === 1) {
      this.ws.send(subscribePayload);
      return;
    }

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
          this.wsConnected = true;
          this.lastError = null;
          try {
            sock.send(subscribePayload);
          } catch (err: unknown) {
            this.lastError = this.redact(err instanceof Error ? err.message : String(err));
          }
          done();
        });

        sock.on('message', (raw) => {
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
            if (!isPlainRecord(parsed) || !isPlainRecord(parsed['marketData'])) {
              return;
            }
            const inst = isPlainRecord(parsed['instrumentId']) ? parsed['instrumentId'] : null;
            const sym = inst ? readStr(inst, ['symbol']) : readStr(parsed, ['symbol']);
            const mkt = (inst ? readStr(inst, ['marketId']) : readStr(parsed, ['marketId'])) ?? 'ROFX';
            if (sym !== null) {
              const snap = parsePrimaryMarketDataNode(sym, mkt, parsed['marketData']);
              this.wsSnapshots.set(`${mkt}:${sym}`, snap);
            }
          } catch {
            // Mensajes heartbeat o no JSON se ignoran de forma segura.
          }
        });

        sock.on('error', (err) => {
          this.wsConnected = false;
          this.lastError = this.redact(err.message);
          done();
        });

        sock.on('close', () => {
          this.wsConnected = false;
          done();
        });
      } catch (err: unknown) {
        this.wsConnected = false;
        this.lastError = this.redact(err instanceof Error ? err.message : String(err));
        done();
      }
    });
  }

  public closeWebSocket(): void {
    if (this.ws !== null) {
      try {
        this.ws.close(1000, 'Client shutdown');
      } catch {
        // Ignore close errors during shutdown
      }
      this.ws = null;
    }
    this.wsConnected = false;
  }

  /**
   * Descarga contratos reales `DLR/*` y derivados `DDF` (`depth=5`), calculando métricas puras.
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
      const [cfiList, ddfList] = await Promise.all([
        this.getInstrumentsByCFICode('FXXXSX', false),
        this.getInstrumentsBySegment('DDF', 'ROFX', false),
      ]);

      const mergedMap = new Map<string, { readonly marketId: string; readonly symbol: string }>();
      for (const item of [...cfiList, ...ddfList]) {
        if (!item.symbol.startsWith('DLR/')) {
          continue;
        }
        if (!mergedMap.has(item.symbol)) {
          mergedMap.set(item.symbol, item);
        }
      }
      const dlrInstruments = [...mergedMap.values()];
      if (dlrInstruments.length === 0) {
        return { spotUsed: null, spotSource: 'NONE', contracts: [], error: null };
      }

      const mdResults = await runWithConcurrency(dlrInstruments, 2, async (inst) => {
        const category = classifyDlrSymbol(inst.symbol);
        let md: ParsedPrimaryMarketData | null = null;
        let itemErr: string | null = null;
        try {
          md = await this.getMarketData(inst.symbol, inst.marketId, 5, Boolean(params.forceRefresh));
        } catch (err: unknown) {
          itemErr = this.redact(err instanceof Error ? err.message : String(err));
        }
        const det =
          category === 'OUTRIGHT' || category === 'MINI'
            ? await this.getInstrumentDetail(inst.symbol, inst.marketId, false).catch(() => null)
            : null;
        return { inst, category, md, det, itemErr };
      });
      const firstErrMsg = mdResults.find((r) => r.itemErr !== null)?.itemErr ?? null;
      if (mdResults.every((r) => r.itemErr !== null) && firstErrMsg !== null) {
        return { spotUsed: null, spotSource: 'NONE', contracts: [], error: firstErrMsg };
      }

      const spotEntry = mdResults.find((r) => r.inst.symbol === 'DLR/SPOT')?.md ?? null;
      const dlrSpotPrice =
        spotEntry?.last ??
        (spotEntry?.bids[0] && spotEntry.asks[0]
          ? 0.5 * (spotEntry.bids[0].price + spotEntry.asks[0].price)
          : null) ??
        spotEntry?.settlement ??
        spotEntry?.close ??
        null;

      const resolvedSpotUsed =
        params.a3500 !== null && Number.isFinite(params.a3500) && params.a3500 > 0
          ? params.a3500
          : dlrSpotPrice !== null && Number.isFinite(dlrSpotPrice) && dlrSpotPrice > 0
            ? dlrSpotPrice
            : null;
      const resolvedSpotSource: 'A3500_BCRA' | 'DLR_SPOT' | 'NONE' =
        params.a3500 !== null && Number.isFinite(params.a3500) && params.a3500 > 0
          ? 'A3500_BCRA'
          : dlrSpotPrice !== null && Number.isFinite(dlrSpotPrice) && dlrSpotPrice > 0
            ? 'DLR_SPOT'
            : 'NONE';

      const contracts: PrimaryDlrContractDto[] = mdResults.map(({ inst, category, md, det }) => {
        const maturityDateRaw = det?.maturityDate ?? inferDlrMaturityDateStr(inst.symbol);
        const metrics = computeDlrContractMetrics({
          asOfUtcSec: params.asOfUtcSec,
          maturityDate: maturityDateRaw,
          last: md?.last,
          bestBid: md?.bids[0]?.price,
          bestAsk: md?.asks[0]?.price,
          settlement: md?.settlement,
          close: md?.close,
          a3500: params.a3500,
          dlrSpot: dlrSpotPrice,
        });
        const expiryUtcSec = sanitizeNum(metrics.maturityUtcSec);
        const maturityIso =
          expiryUtcSec !== null ? new Date(expiryUtcSec * 1_000).toISOString().slice(0, 10) : null;

        return {
          contract: inst.symbol,
          category,
          marketId: inst.marketId,
          maturity: maturityIso,
          expiryUtcSec,
          days: sanitizeNum(metrics.days),
          price: sanitizeNum(metrics.referencePrice),
          priceBasis: metrics.priceBasis,
          last: md?.last ?? null,
          settlement: md?.settlement ?? null,
          close: md?.close ?? null,
          bid: md?.bids[0]?.price ?? null,
          bidPrice: md?.bids[0]?.price ?? null,
          bidSize: md?.bids[0]?.size ?? null,
          ask: md?.asks[0]?.price ?? null,
          askPrice: md?.asks[0]?.price ?? null,
          askSize: md?.asks[0]?.size ?? null,
          bids: md?.bids ?? [],
          asks: md?.asks ?? [],
          openInterest: md?.openInterest ?? null,
          nominalVolume: md?.nominalVolume ?? null,
          open: md?.open ?? null,
          high: md?.high ?? null,
          low: md?.low ?? null,
          spotUsed: sanitizeNum(metrics.spotUsed),
          spotSource: metrics.spotSource,
          devalDirectaPct: sanitizeNum(metrics.devalDirectaPct),
          tnaImplicitaPct: sanitizeNum(metrics.tnaImplicitaPct),
          teaImplicitaPct: sanitizeNum(metrics.teaImplicitaPct),
          temImplicitaPct: sanitizeNum(metrics.temImplicitaPct),
          contractMultiplier: det?.contractMultiplier ?? null,
          minPriceIncrement: det?.minPriceIncrement ?? null,
          updatedAtUtcSec: md?.updatedAtUtcSec ?? null,
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
        contracts,
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

      const md = await this.getMarketData(
        preferred.item.symbol,
        preferred.item.marketId,
        5,
        forceRefresh,
      );
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
      dlrCount: this.cachedCounts.dlr,
      ddfCount: this.cachedCounts.ddf,
      mervCount: this.cachedCounts.merv,
      lastError: this.lastError !== null ? this.redact(this.lastError) : null,
    };
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
  private lastHealth: BmbConnectorHealthDto;

  public constructor(deps: BmbBridgeClientDeps = {}) {
    const env = deps.env ?? process.env;
    this.config = loadBmbConfigFromEnv(env);
    this.fetchFn = deps.fetchFn ?? defaultPrimaryHttpFn;
    this.nowMsFn = deps.nowMsFn ?? (() => Date.now());
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_BMB_TIMEOUT_MS;

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
    if (!this.config.passwordConfigured) {
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
}
