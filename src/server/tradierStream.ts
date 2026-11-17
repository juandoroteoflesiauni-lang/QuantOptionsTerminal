/**
 * Orquestador Tradier para acciones/ADRs US (Pieza 41).
 *
 * `tradierAdapter.ts` conserva el cliente REST/cadenas y el manager crudo.
 * Este módulo define el rol explícito de Tradier como stream US/ADR principal,
 * maneja el núcleo líquido + leases dinámicos y expone REST histórico.
 *
 * Zero Silent Fallbacks:
 * - `0` de Tradier significa "sin punta" y se representa como `NaN`/null.
 * - No hay unidades ni precios inferidos desde mid sin puntas válidas.
 * - Todos los errores se redactan con el token del caller.
 */

import { etWallTimeToUtc } from '../data/alignment.js';
import type { Bar } from '../core/types.js';
import type { Timeframe } from '../data/types.js';
import { getMarketParts } from '../core/sessions.js';
import { redactSecrets } from './runtimeCache.js';
import {
  createDefaultTradierHttpFn,
  resolveTradierConfig,
  TradierLiveManager,
  type TradierConfig,
  type TradierHttpFn,
  type TradierStreamState,
  type TradierStreamStatus,
  type TradierStreamTick,
} from './tradierAdapter.js';

export const TRADIER_CORE_US_SYMBOLS: readonly string[] = Object.freeze([
  'SPY',
  'QQQ',
  'IWM',
  'DIA',
  'VIXY',
  'GGAL',
  'YPF',
  'BMA',
  'PAM',
  'BBAR',
  'SUPV',
  'TGS',
  'CEPU',
  'CRESY',
  'EDN',
  'LOMA',
  'MELI',
  'NVDA',
  'AAPL',
  'MSFT',
  'AMZN',
  'META',
  'TSLA',
  'GOOGL',
  'KO',
  'EWZ',
  'IBIT',
]);

export interface TradierHistoricalRequest {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly fromUtcSec: number;
  readonly toUtcSec: number;
}

export interface TradierHistoricalResult {
  readonly bars: readonly Bar[];
  readonly endpoint: 'TIMESALES' | 'HISTORY_DAILY';
  readonly requestedAtUtcSec: number;
  readonly httpStatus: number | null;
  readonly rows: number;
  readonly discarded: number;
}

export interface TradierStocksStreamDeps {
  readonly config: TradierConfig;
  readonly createSocketFn?: ConstructorParameters<typeof TradierLiveManager>[0]['createSocketFn'];
  readonly httpFn?: TradierHttpFn;
  readonly nowMsFn?: () => number;
  readonly secrets?: readonly string[];
  readonly onTick?: (tick: TradierStreamTick) => void;
  readonly onStateChange?: (state: TradierStreamState) => void;
  readonly onError?: (message: string) => void;
  readonly reconnectBaseDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
}

function isoToUtcSec(value: unknown): number {
  if (typeof value !== 'string' || value.trim() === '') return Number.NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1_000) : Number.NaN;
}

function etDateKey(utcSec: number): string {
  const parts = getMarketParts(Math.floor(utcSec), 'EQUITY');
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function tradierInterval(timeframe: Timeframe): '1min' | '5min' | '15min' | 'daily' {
  if (timeframe === '1m') return '1min';
  if (timeframe === '5m') return '5min';
  if (timeframe === '15m') return '15min';
  if (timeframe === '1h' || timeframe === '4h') return '15min';
  return 'daily';
}

function pushBar(byTime: Map<number, Bar>, raw: unknown, timeSec: number): boolean {
  if (!isRecord(raw)) return false;
  const open = num(raw['open']);
  const high = num(raw['high']);
  const low = num(raw['low']);
  const close = num(raw['close']);
  const volume = num(raw['volume']);
  if (
    !Number.isFinite(timeSec) || timeSec <= 0 ||
    !Number.isFinite(open) || open <= 0 ||
    !Number.isFinite(high) || high < open ||
    !Number.isFinite(low) || low <= 0 || high < low ||
    !Number.isFinite(close) || close <= 0 ||
    !Number.isFinite(volume) || volume < 0
  ) {
    return false;
  }
  byTime.set(timeSec, {
    time: Math.floor(timeSec),
    open,
    high,
    low,
    close,
    volume,
  });
  return true;
}

/** Agrega 15m a 1h/4h según el muro ET de cada barra, sin inventar volume/vw. */
export function aggregateTradierBars(
  bars: readonly Bar[],
  timeframe: Timeframe,
): readonly Bar[] {
  if (timeframe !== '1h' && timeframe !== '4h') return bars;
  const bucketMinutes = timeframe === '1h' ? 60 : 240;
  const groups = new Map<number, Bar>();
  for (const bar of bars) {
    const parts = getMarketParts(bar.time, 'EQUITY');
    const alignedMinutes = Math.floor(parts.minutesOfDay / bucketMinutes) * bucketMinutes;
    const bucketSec = etWallTimeToUtc(parts.year, parts.month, parts.day, alignedMinutes);
    const existing = groups.get(bucketSec);
    if (existing === undefined) {
      groups.set(bucketSec, { ...bar, time: bucketSec });
      continue;
    }
    groups.set(bucketSec, {
      time: bucketSec,
      open: existing.open,
      high: Math.max(existing.high, bar.high),
      low: Math.min(existing.low, bar.low),
      close: bar.close,
      volume: existing.volume + bar.volume,
    });
  }
  return [...groups.values()].sort((a, b) => a.time - b.time);
}

export function parseTradierTimesales(raw: unknown): { readonly bars: readonly Bar[]; readonly discarded: number } {
  const body = isRecord(raw) ? raw : {};
  const series = isRecord(body['series']) ? body['series'] : {};
  const rows = Array.isArray(series['data']) ? series['data'] : [];
  const byTime = new Map<number, Bar>();
  let discarded = 0;
  for (const row of rows) {
    if (!isRecord(row)) {
      discarded += 1;
      continue;
    }
    const time = isoToUtcSec(row['time']);
    if (!pushBar(byTime, row, time)) discarded += 1;
  }
  return { bars: [...byTime.values()].sort((a, b) => a.time - b.time), discarded };
}

export function parseTradierDailyHistory(raw: unknown): { readonly bars: readonly Bar[]; readonly discarded: number } {
  const body = isRecord(raw) ? raw : {};
  const history = isRecord(body['history']) ? body['history'] : {};
  const rows = Array.isArray(history['day']) ? history['day'] : isRecord(history['day']) ? [history['day']] : [];
  const byTime = new Map<number, Bar>();
  let discarded = 0;
  for (const row of rows) {
    if (!isRecord(row) || typeof row['date'] !== 'string') {
      discarded += 1;
      continue;
    }
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(row['date'].trim());
    if (dateMatch === null) {
      discarded += 1;
      continue;
    }
    const year = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      discarded += 1;
      continue;
    }
    const timeSec = etWallTimeToUtc(year, month, day, 0);
    if (!pushBar(byTime, row, timeSec)) discarded += 1;
  }
  return { bars: [...byTime.values()].sort((a, b) => a.time - b.time), discarded };
}

export class TradierHistoricalClient {
  private readonly configOverride: TradierConfig | null;
  private readonly resolveConfigFn: (() => TradierConfig) | null;
  private readonly httpFn: TradierHttpFn;
  private readonly nowMsFn: () => number;
  private readonly secrets: readonly string[];

  public constructor(deps: {
    readonly config?: TradierConfig;
    readonly resolveConfigFn?: () => TradierConfig;
    readonly httpFn?: TradierHttpFn;
    readonly nowMsFn?: () => number;
    readonly secrets?: readonly string[];
  }) {
    this.configOverride = deps.config ?? null;
    this.resolveConfigFn = deps.resolveConfigFn ?? null;
    this.httpFn = deps.httpFn ?? createDefaultTradierHttpFn();
    this.nowMsFn = deps.nowMsFn ?? (() => Date.now());
    const secrets = [...(deps.secrets ?? [])];
    this.secrets = secrets;
  }

  private effectiveConfig(): TradierConfig {
    if (this.resolveConfigFn !== null) return this.resolveConfigFn();
    if (this.configOverride !== null) return this.configOverride;
    return resolveTradierConfig();
  }

  public async fetchHistoricalBars(request: TradierHistoricalRequest): Promise<TradierHistoricalResult> {
    const config = this.effectiveConfig();
    if (!config.configured || config.accessToken === null) {
      throw new Error('Tradier is not configured');
    }
    const currentSecrets = [...this.secrets, config.accessToken];
    const symbol = request.symbol.trim().toUpperCase();
    const interval = tradierInterval(request.timeframe);
    if (symbol === '' || !Number.isFinite(request.fromUtcSec) || !Number.isFinite(request.toUtcSec)) {
      throw new Error('Tradier historical request is invalid');
    }
    const requestedAtUtcSec = Math.floor(this.nowMsFn() / 1_000);
    const headers = {
      Authorization: `Bearer ${config.accessToken}`,
      Accept: 'application/json',
    };
    const start = etDateKey(request.fromUtcSec);
    const end = etDateKey(request.toUtcSec);
    if (interval === 'daily') {
      const url = `${config.restBaseUrl}/markets/history?symbol=${encodeURIComponent(symbol)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&granularity=daily`;
      const response = await this.httpFn(url, { method: 'GET', headers });
      if (!response.ok) throw new Error(redactSecrets(`Tradier history HTTP ${String(response.status)}`, currentSecrets));
      const normalized = parseTradierDailyHistory(JSON.parse(response.text) as unknown);
      return {
        bars: normalized.bars,
        endpoint: 'HISTORY_DAILY',
        requestedAtUtcSec,
        httpStatus: response.status,
        rows: normalized.bars.length,
        discarded: normalized.discarded,
      };
    }
    const url = `${config.restBaseUrl}/markets/timesales?symbol=${encodeURIComponent(symbol)}&interval=${interval}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&session_filter=all`;
    const response = await this.httpFn(url, { method: 'GET', headers });
    if (!response.ok) throw new Error(redactSecrets(`Tradier timesales HTTP ${String(response.status)}`, currentSecrets));
    const normalized = parseTradierTimesales(JSON.parse(response.text) as unknown);
    return {
      bars: aggregateTradierBars(normalized.bars, request.timeframe),
      endpoint: 'TIMESALES',
      requestedAtUtcSec,
      httpStatus: response.status,
      rows: normalized.bars.length,
      discarded: normalized.discarded,
    };
  }
}

/**
 * Administrador del socket de acciones. La lista deseada es core + leases.
 * Tradier Live crea una nueva sesión al cambiar la lista; no se envía un
 * payload inventado a un socket ya abierto.
 */
export class TradierStocksStream {
  private readonly manager: TradierLiveManager;
  private readonly dynamicSymbols = new Set<string>();
  private started = false;

  public constructor(deps: TradierStocksStreamDeps) {
    const secrets = [...(deps.secrets ?? [])];
    this.manager = new TradierLiveManager({
      config: deps.config,
      ...(deps.createSocketFn === undefined ? {} : { createSocketFn: deps.createSocketFn }),
      ...(deps.httpFn === undefined ? {} : { httpFn: deps.httpFn }),
      ...(deps.nowMsFn === undefined ? {} : { nowMsFn: deps.nowMsFn }),
      secrets,
      ...(deps.onTick === undefined ? {} : { onTick: deps.onTick }),
      ...(deps.onStateChange === undefined ? {} : { onStateChange: deps.onStateChange }),
      ...(deps.onError === undefined ? {} : { onError: deps.onError }),
      ...(deps.reconnectBaseDelayMs === undefined ? {} : { reconnectBaseDelayMs: deps.reconnectBaseDelayMs }),
      ...(deps.reconnectMaxDelayMs === undefined ? {} : { reconnectMaxDelayMs: deps.reconnectMaxDelayMs }),
    });
  }

  public getCoreSymbols(): readonly string[] {
    return [...TRADIER_CORE_US_SYMBOLS];
  }

  public isCoreSymbol(symbol: string): boolean {
    return TRADIER_CORE_US_SYMBOLS.includes(symbol.trim().toUpperCase());
  }

  public isSymbolAllowed(symbol: string): boolean {
    return this.isCoreSymbol(symbol) || this.dynamicSymbols.has(symbol.trim().toUpperCase());
  }

  public getStatus(): TradierStreamStatus {
    return this.manager.getStatus();
  }

  public getFeedTelemetrySnapshot(nowMs: number): ReturnType<TradierLiveManager['getFeedTelemetrySnapshot']> {
    return this.manager.getFeedTelemetrySnapshot(nowMs);
  }

  public getLatestQuotes(): ReturnType<TradierLiveManager['getLatestQuotes']> {
    return this.manager.getLatestQuotes();
  }

  public async start(): Promise<void> {
    this.started = true;
    await this.manager.start(this.desiredSymbols());
  }

  public stop(): void {
    this.started = false;
    this.manager.stop();
  }

  public async setDynamicSymbols(symbols: readonly string[]): Promise<void> {
    const next = new Set(
      symbols
        .map((raw) => raw.trim().toUpperCase())
        .filter((symbol) => symbol !== '' && !this.isCoreSymbol(symbol)),
    );
    const changed =
      next.size !== this.dynamicSymbols.size ||
      [...next].some((symbol) => !this.dynamicSymbols.has(symbol));
    this.dynamicSymbols.clear();
    for (const symbol of next) this.dynamicSymbols.add(symbol);
    if (!changed || !this.started) return;
    await this.manager.start(this.desiredSymbols());
  }

  private desiredSymbols(): readonly string[] {
    return [...new Set([...TRADIER_CORE_US_SYMBOLS, ...this.dynamicSymbols])].sort();
  }
}
