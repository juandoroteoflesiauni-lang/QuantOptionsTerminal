/**
 * Full-universe US live quote orchestrator.
 *
 * One authenticated Massive `/stocks` socket supplies trade/minute updates while
 * an independent REST batch refreshes daily baselines and extended-hours trades.
 * The existing MassiveWsClient owns authentication, normalization, redaction,
 * bounded queues and reconnect backoff; this module owns quote state and cadence.
 */

import { getMarketParts } from '../core/sessions.js';
import type { FetchFn } from '../data/types.js';
import type {
  MassiveWsClientOptions,
  WsClientError,
  WsClientSnapshot,
  WsConnectionState,
  WsNormalizedEvent,
} from '../data/wsTypes.js';
import {
  RollingFeedTelemetry,
  type FeedTelemetrySnapshot,
} from './feedsHealthMonitor.js';
import { buildMassiveWsChannels } from './wsCoalescerAndStability.js';

export const MASSIVE_RTH_BATCH_INTERVAL_MS = 2_500;
export const MASSIVE_EXTENDED_BATCH_INTERVAL_MS = 5_000;
export const MASSIVE_CLOSED_BATCH_INTERVAL_MS = 30_000;
/** Pieza 35: los batches REST se particionan para rotar el pool y no exceder límites de URL. */
export const MASSIVE_SNAPSHOT_CHUNK_SIZE = 80;

export type UsLiveSession = 'RTH' | 'EXTENDED' | 'CLOSED';

/**
 * Pieza 41: modo explícito del socket/batch de acciones Massive.
 * `TRADIER_FMP_PRIMARY` significa que el feed de acciones US/ADR se apaga y
 * `MASSIVE_REST_POOL` queda dedicado a opciones. El override exige la variable
 * completa, no acepta valores parcialmente verdaderos.
 */
export type MassiveStocksMode = 'MASSIVE_STOCKS_ENABLED' | 'STANDBY_TRADIER_FMP_PRIMARY';

const MASSIVE_STOCKS_STANDBY_TRIGGER_ENV_NAMES = [
  'FMP_API_KEY',
  'FMP_KEY_QUOTES',
  'FMP_KEY_MARKET',
  'FMP_KEY_ETF',
  'FMP_KEY_MACRO',
  'TRADIER_API_TOKEN',
  'TRADIER_LIVE_TOKEN',
  'TRADIER_ACCESS_TOKEN',
  'TRADIER_TOKEN',
  'TRADIER_SANDBOX_TOKEN',
  'TRADIER_SANDBOX_API_TOKEN',
] as const;

export function resolveMassiveStocksMode(env: NodeJS.ProcessEnv = process.env): MassiveStocksMode {
  const overrideRaw = (env['MASSIVE_STOCKS_WS_ENABLED'] ?? '').trim().toLowerCase();
  if (overrideRaw === 'true') return 'MASSIVE_STOCKS_ENABLED';
  for (const name of MASSIVE_STOCKS_STANDBY_TRIGGER_ENV_NAMES) {
    if ((env[name] ?? '').trim() !== '') return 'STANDBY_TRADIER_FMP_PRIMARY';
  }
  return 'MASSIVE_STOCKS_ENABLED';
}

export interface MarketTickQuote {
  readonly market: 'AR' | 'US';
  readonly symbol: string;
  readonly kind: 'stock' | 'index' | 'bond' | 'note' | 'corp';
  readonly currency: 'ARS' | 'USD' | null;
  readonly price: number;
  readonly previousClose: number | null;
  readonly changePct: number | null;
  readonly dayLow: number | null;
  readonly dayHigh: number | null;
  readonly volume: number | null;
  readonly turnover: number | null;
  readonly asOfUtcSec: number | null;
  readonly source: string;
  /** Pieza 41: exchange US real (FMP batch). `null` cuando el proveedor no lo entrega. */
  readonly exchange?: string | null;
  /** Pieza 41: liquidación BYMA cuando el emisor la conoce (`24hs` | `CI`). */
  readonly settlement?: string | null;
}

export interface MassiveStreamWsClient {
  connect(): Promise<void>;
  subscribe(channels: string | readonly string[]): void;
  unsubscribe(channels: string | readonly string[]): void;
  close(code?: number, reason?: string): void;
  getSnapshot(): WsClientSnapshot;
}

export interface MassiveStocksStreamDeps {
  readonly apiKey: string;
  readonly symbols: readonly string[];
  readonly fetchFn: FetchFn;
  readonly createWsClientFn: (options: MassiveWsClientOptions) => MassiveStreamWsClient;
  readonly nowMsFn?: () => number;
  readonly baseUrl?: string;
  readonly onEvents?: (events: readonly WsNormalizedEvent[]) => void;
  readonly onStateChange?: (state: WsConnectionState) => void;
  readonly onError?: (message: string) => void;
  /**
   * Pieza 32: clave REST para los batches de snapshot (round-robin del pool).
   * Inyección explícita; si no se provee, los batches REST usan `apiKey`.
   */
  readonly restApiKeyFn?: () => string;
  /**
   * Pieza 40: núcleo líquido suscripto por WS. El universo completo sigue
   * alimentando los batches REST, pero el socket ya no usa wildcards.
   */
  readonly coreSymbols?: readonly string[];
  /** Pieza 40: inyectable para tests del cierre acotado en reconexión. */
  readonly sleepFn?: (ms: number) => Promise<void>;
}

interface MutableQuote {
  market: 'US';
  symbol: string;
  kind: 'stock' | 'index';
  currency: 'USD';
  price: number;
  previousClose: number | null;
  changePct: number | null;
  dayLow: number | null;
  dayHigh: number | null;
  volume: number | null;
  turnover: number | null;
  asOfUtcSec: number | null;
  source: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positive(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : Number.NaN;
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : Number.NaN;
}

function nullable(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function providerTimeSec(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return Number.NaN;
  if (value >= 1e17) return Math.floor(value / 1e9);
  if (value >= 1e11) return Math.floor(value / 1e3);
  return Math.floor(value);
}

function changePct(price: number, previousClose: number | null): number | null {
  return previousClose !== null && previousClose > 0 && Number.isFinite(price)
    ? ((price - previousClose) / previousClose) * 100
    : null;
}

function withAuth(rawUrl: string, apiKey: string): string {
  const url = new URL(rawUrl);
  const host = url.hostname.toLowerCase();
  url.searchParams.set(host === 'api.massive.com' || host.endsWith('.massive.com') ? 'apikey' : 'apiKey', apiKey);
  return url.toString();
}

export function getUsLiveSession(nowMs: number): UsLiveSession {
  const parts = getMarketParts(Math.floor(nowMs / 1_000), 'EQUITY');
  if (parts.weekday < 1 || parts.weekday > 5) return 'CLOSED';
  const minutes = parts.minutesOfDay;
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return 'RTH';
  if ((minutes >= 4 * 60 && minutes < 9 * 60 + 30) || (minutes >= 16 * 60 && minutes < 20 * 60)) {
    return 'EXTENDED';
  }
  return 'CLOSED';
}

export function getMassiveBatchIntervalMs(nowMs: number): number {
  const session = getUsLiveSession(nowMs);
  return session === 'RTH'
    ? MASSIVE_RTH_BATCH_INTERVAL_MS
    : session === 'EXTENDED'
      ? MASSIVE_EXTENDED_BATCH_INTERVAL_MS
      : MASSIVE_CLOSED_BATCH_INTERVAL_MS;
}

/**
 * Select a real snapshot price without hiding missing values. In RTH `day.c` is
 * authoritative for the REST baseline; in extended hours a genuinely timestamped
 * last trade wins. A trade newer than prevDay is also accepted when day.c is absent.
 */
export function extractSnapshotPrice(input: {
  readonly dayClose: number;
  readonly minuteClose: number;
  readonly lastTradePrice: number;
  readonly lastTradeTimeSec: number;
  readonly previousDayTimeSec: number;
  readonly session: UsLiveSession;
}): number {
  const validTrade = Number.isFinite(input.lastTradePrice) && input.lastTradePrice > 0;
  const tradeIsNewer =
    validTrade &&
    Number.isFinite(input.lastTradeTimeSec) &&
    (!Number.isFinite(input.previousDayTimeSec) || input.lastTradeTimeSec > input.previousDayTimeSec);
  if (input.session === 'EXTENDED' && tradeIsNewer) return input.lastTradePrice;
  if (input.session === 'RTH' && Number.isFinite(input.dayClose) && input.dayClose > 0) {
    return input.dayClose;
  }
  if (tradeIsNewer) return input.lastTradePrice;
  for (const candidate of [input.dayClose, input.minuteClose]) {
    if (Number.isFinite(candidate) && candidate > 0) return candidate;
  }
  return Number.NaN;
}

export class MassiveStocksStream {
  private readonly apiKey: string;
  private readonly restApiKeyFn: (() => string) | null;
  private readonly symbols: ReadonlySet<string>;
  private readonly stockSymbols: readonly string[];
  private readonly coreSymbols: ReadonlySet<string>;
  private readonly dynamicSymbols = new Set<string>();
  private readonly fetchFn: FetchFn;
  private readonly createWsClientFn: MassiveStocksStreamDeps['createWsClientFn'];
  private readonly nowMsFn: () => number;
  private readonly baseUrl: string;
  private readonly onEventsCb: MassiveStocksStreamDeps['onEvents'];
  private readonly telemetry = new RollingFeedTelemetry({
    latencyKind: 'PROVIDER_EVENT_AGE',
  });
  private readonly onStateChangeCb: MassiveStocksStreamDeps['onStateChange'];
  private readonly onErrorCb: MassiveStocksStreamDeps['onError'];
  private readonly quotes = new Map<string, MutableQuote>();
  private readonly wsTickAtMs = new Map<string, number>();
  private readonly sleepFn: (ms: number) => Promise<void>;
  private client: MassiveStreamWsClient | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private polling = false;
  private lastWsMessageMs: number | null = null;
  private lastBatchAtMs: number | null = null;
  private lastError: string | null = null;

  public constructor(deps: MassiveStocksStreamDeps) {
    this.apiKey = deps.apiKey;
    this.restApiKeyFn = deps.restApiKeyFn ?? null;
    this.symbols = new Set(deps.symbols.map((symbol) => symbol.trim().toUpperCase()).filter((s) => s !== ''));
    this.stockSymbols = [...this.symbols].filter((symbol) => !symbol.startsWith('I:')).sort();
    const requestedCore = deps.coreSymbols ?? this.stockSymbols;
    const coreCandidates = new Set([...requestedCore.map((symbol) => symbol.trim().toUpperCase()), 'GGAL']);
    this.coreSymbols = new Set(
      [...coreCandidates].filter(
        (symbol) => symbol !== '' && (this.symbols.has(symbol) || symbol === 'GGAL'),
      ),
    );
    this.fetchFn = deps.fetchFn;
    this.createWsClientFn = deps.createWsClientFn;
    this.nowMsFn = deps.nowMsFn ?? (() => Date.now());
    this.baseUrl = (deps.baseUrl ?? 'https://api.massive.com').replace(/\/+$/, '');
    this.onEventsCb = deps.onEvents;
    this.onStateChangeCb = deps.onStateChange;
    this.onErrorCb = deps.onError;
    this.sleepFn =
      deps.sleepFn ??
      ((ms: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  public start(): Promise<void> {
    if (this.started) return Promise.resolve();
    this.started = true;
    try {
      // Pieza 40: suscripción explícita del núcleo líquido. Se eliminan los
      // wildcards Q.*/AM.* porque traían el universo completo y anulaban el
      // ahorro del batching. Los símbolos dinámicos se agregan bajo demanda.
      const coreStocks = [...this.coreSymbols].filter((symbol) => !symbol.startsWith('I:')).sort();
      const channels = coreStocks.flatMap((symbol) => buildMassiveWsChannels(symbol));
      this.client = this.createWsClientFn({
        apiKey: this.apiKey,
        cluster: 'stocks',
        initialSubscriptions: [...new Set(channels)],
        autoReconnect: true,
        onEvents: (events) => {
          const configuredEvents = events.filter(
            (event) =>
              (event.ev === 'T' || event.ev === 'Q' || event.ev === 'A' || event.ev === 'AM') &&
              this.isWsSymbolAllowed(event.sym.toUpperCase()),
          );
          if (configuredEvents.length === 0) return;
          this.lastWsMessageMs = this.nowMsFn();
          for (const event of configuredEvents) {
            const providerAtMs =
              event.ev === 'T' || event.ev === 'Q'
                ? event.timeSec * 1_000
                : event.ev === 'A' || event.ev === 'AM'
                  ? event.endMs
                  : Number.NaN;
            this.telemetry.record({
              atMs: this.lastWsMessageMs,
              latencyMs:
                Number.isFinite(providerAtMs) && providerAtMs > 0
                  ? this.lastWsMessageMs - providerAtMs
                  : null,
              isValidTick: true,
            });
          }
          this.ingestWsEvents(configuredEvents);
          this.onEventsCb?.(configuredEvents);
        },
        onStateChange: (state) => {
          this.onStateChangeCb?.(state);
        },
        onError: (error: WsClientError) => {
          this.reportError(error.message);
        },
      });
    } catch (error: unknown) {
      this.reportError(error instanceof Error ? error.message : String(error));
    }
    void this.pollLoop();
    if (this.client !== null) {
      // REST fallback remains active even if authentication never completes.
      void this.client.connect().catch((error: unknown) => {
        this.reportError(error instanceof Error ? error.message : String(error));
      });
    }
    return Promise.resolve();
  }

  /** Pieza 40: suscripción dinámica bajo demanda (lease del cliente enfocado). */
  public subscribeSymbols(symbols: readonly string[]): void {
    const added: string[] = [];
    for (const raw of symbols) {
      const symbol = raw.trim().toUpperCase();
      if (
        symbol === '' ||
        symbol.startsWith('I:') ||
        !/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol) ||
        this.coreSymbols.has(symbol) ||
        this.dynamicSymbols.has(symbol)
      ) {
        continue;
      }
      this.dynamicSymbols.add(symbol);
      added.push(symbol);
    }
    if (added.length === 0 || this.client === null) return;
    this.client.subscribe(added.flatMap((symbol) => buildMassiveWsChannels(symbol)));
  }

  /** Pieza 40: libera un lease dinámico cuando ya no lo necesita ningún cliente. */
  public unsubscribeSymbols(symbols: readonly string[]): void {
    const removed: string[] = [];
    for (const raw of symbols) {
      const symbol = raw.trim().toUpperCase();
      if (!this.dynamicSymbols.has(symbol)) continue;
      this.dynamicSymbols.delete(symbol);
      removed.push(symbol);
    }
    if (removed.length === 0 || this.client === null) return;
    this.client.unsubscribe(removed.flatMap((symbol) => buildMassiveWsChannels(symbol)));
  }

  public getSubscribedSymbols(): readonly string[] {
    return [...new Set([...this.coreSymbols, ...this.dynamicSymbols])].sort();
  }

  public getDynamicSubscribedSymbols(): readonly string[] {
    return [...this.dynamicSymbols].sort();
  }

  public stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const current = this.client;
    this.client = null;
    current?.close(1000, 'stream_reconnect');
  }

  /** Pieza 40: cierre acotado para reconexión manual; nunca cuelga el caller. */
  public async stopAndWait(closeTimeoutMs = 4_000): Promise<void> {
    const current = this.client;
    this.stop();
    const attempts = Math.max(1, Math.ceil(closeTimeoutMs / 25));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (current === null || current.getSnapshot().state === 'closed') return;
      await this.sleepFn(25);
    }
  }

  public getQuotes(): readonly MarketTickQuote[] {
    return [...this.quotes.values()].map((quote) => ({ ...quote }));
  }

  public getQuote(symbol: string): MarketTickQuote | null {
    const quote = this.quotes.get(symbol.trim().toUpperCase());
    return quote === undefined ? null : { ...quote };
  }

  public getWsSnapshot(): WsClientSnapshot | null {
    return this.client?.getSnapshot() ?? null;
  }

  public getFeedTelemetrySnapshot(): FeedTelemetrySnapshot {
    return this.telemetry.snapshot(this.nowMsFn());
  }

  public getDiagnostics(): {
    readonly quoteCount: number;
    readonly lastWsMessageMs: number | null;
    readonly lastBatchAtMs: number | null;
    readonly lastError: string | null;
    readonly sourceMode: 'MASSIVE_WS' | 'MASSIVE_BATCH' | 'NO_DATA';
  } {
    const nowMs = this.nowMsFn();
    const wsFresh =
      this.lastWsMessageMs !== null &&
      nowMs >= this.lastWsMessageMs &&
      nowMs - this.lastWsMessageMs <= 15_000;
    const batchWindowMs = getMassiveBatchIntervalMs(nowMs) * 2 + 5_000;
    const batchFresh =
      this.lastBatchAtMs !== null &&
      nowMs >= this.lastBatchAtMs &&
      nowMs - this.lastBatchAtMs <= batchWindowMs &&
      this.quotes.size > 0;
    const sourceMode = wsFresh ? 'MASSIVE_WS' : batchFresh ? 'MASSIVE_BATCH' : 'NO_DATA';
    return {
      quoteCount: this.quotes.size,
      lastWsMessageMs: this.lastWsMessageMs,
      lastBatchAtMs: this.lastBatchAtMs,
      lastError: this.lastError,
      sourceMode,
    };
  }

  private isWsSymbolAllowed(symbol: string): boolean {
    return this.coreSymbols.has(symbol) || this.dynamicSymbols.has(symbol);
  }

  private reportError(message: string): void {
    this.lastError = message;
    this.onErrorCb?.(message);
  }

  private ingestWsEvents(events: readonly WsNormalizedEvent[]): void {
    for (const event of events) {
      if (event.ev !== 'T' && event.ev !== 'Q' && event.ev !== 'A' && event.ev !== 'AM') continue;
      const symbol = event.sym.toUpperCase();
      if (!this.isWsSymbolAllowed(symbol)) continue;
      const existing = this.quotes.get(symbol);
      const wsTickAt = this.wsTickAtMs.get(symbol);
      const hasRecentTrade =
        event.ev === 'Q' &&
        existing?.source === 'MASSIVE_WS' &&
        wsTickAt !== undefined &&
        this.nowMsFn() >= wsTickAt &&
        this.nowMsFn() - wsTickAt < 2_000;
      if (hasRecentTrade) continue;
      const quoteMid = event.ev === 'Q' && event.askPrice >= event.bidPrice && event.bidPrice > 0
        ? 0.5 * (event.bidPrice + event.askPrice)
        : Number.NaN;
      const price = event.ev === 'T' ? event.price : event.ev === 'Q' ? quoteMid : event.bar.close;
      const asOfUtcSec = event.ev === 'T' || event.ev === 'Q' ? event.timeSec : Math.floor(event.endMs / 1_000);
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(asOfUtcSec)) continue;
      if (existing !== undefined && existing.asOfUtcSec !== null && asOfUtcSec < existing.asOfUtcSec) continue;

      // Volumen de sesión: solo datos reales. Un trade incrementa el acumulado
      // únicamente cuando existe una baseline previa (REST o `accumulatedVolume`);
      // si no existe, permanece `null` (nunca se infiere desde un único trade).
      // En agregados `A`/`AM`, `accumulatedVolume` del proveedor es autoritativo.
      const tradeSize =
        event.ev === 'T' && Number.isFinite(event.size) && event.size >= 0 ? event.size : null;
      let volume: number | null;
      if (event.ev === 'A' || event.ev === 'AM') {
        const accumulated = event.accumulatedVolume;
        volume =
          typeof accumulated === 'number' && Number.isFinite(accumulated) && accumulated >= 0
            ? accumulated
            : existing?.volume ?? null;
      } else if (tradeSize !== null) {
        volume =
          existing?.volume !== null && existing?.volume !== undefined
            ? existing.volume + tradeSize
            : null;
      } else {
        volume = existing?.volume ?? null;
      }

      // Turnover (monto monetario "operado"): notional real del trade acumulado
      // sobre la baseline existente; nunca se estima desde precio sin baseline.
      const turnover =
        tradeSize !== null && existing?.turnover !== null && existing?.turnover !== undefined
          ? existing.turnover + price * tradeSize
          : existing?.turnover ?? null;

      // Extremos del día: los trades solo expanden una observación previa; los
      // agregados `A`/`AM` aportan low/high reales de la vela (semilla honesta).
      const nextLow = event.ev === 'A' || event.ev === 'AM' ? event.bar.low : price;
      const nextHigh = event.ev === 'A' || event.ev === 'AM' ? event.bar.high : price;
      const prevLow = existing?.dayLow ?? null;
      const prevHigh = existing?.dayHigh ?? null;
      const nextLowFinite = Number.isFinite(nextLow) && nextLow > 0 ? nextLow : null;
      const nextHighFinite = Number.isFinite(nextHigh) && nextHigh > 0 ? nextHigh : null;
      const dayLow =
        prevLow !== null
          ? nextLowFinite !== null
            ? Math.min(prevLow, nextLowFinite)
            : prevLow
          : event.ev === 'A' || event.ev === 'AM'
            ? nextLowFinite
            : null;
      const dayHigh =
        prevHigh !== null
          ? nextHighFinite !== null
            ? Math.max(prevHigh, nextHighFinite)
            : prevHigh
          : event.ev === 'A' || event.ev === 'AM'
            ? nextHighFinite
            : null;

      this.quotes.set(symbol, {
        market: 'US',
        symbol,
        kind: 'stock',
        currency: 'USD',
        price,
        previousClose: existing?.previousClose ?? null,
        changePct: changePct(price, existing?.previousClose ?? null),
        dayLow,
        dayHigh,
        volume: volume !== null && Number.isFinite(volume) ? volume : null,
        turnover: turnover !== null && Number.isFinite(turnover) ? turnover : null,
        asOfUtcSec,
        source: event.ev === 'Q' ? 'MASSIVE_WS_QUOTE' : 'MASSIVE_WS',
      });
      this.wsTickAtMs.set(symbol, this.nowMsFn());
    }
  }

  private isStarted(): boolean {
    return this.started;
  }

  private async pollLoop(): Promise<void> {
    if (!this.started || this.polling) return;
    this.polling = true;
    try {
      await this.pollBatch();
    } catch (error: unknown) {
      this.reportError(error instanceof Error ? error.message : String(error));
    } finally {
      this.polling = false;
      if (this.isStarted()) {
        this.timer = setTimeout(() => {
          void this.pollLoop();
        }, getMassiveBatchIntervalMs(this.nowMsFn()));
        this.timer.unref();
      }
    }
  }

  private async pollBatch(): Promise<void> {
    const stockRequested = this.stockSymbols.length > 0;
    const vixRequested = this.symbols.has('I:VIX');
    const [stockOk, vixOk] = await Promise.all([
      stockRequested ? this.fetchStockBatch() : Promise.resolve(false),
      vixRequested ? this.fetchVixBatch() : Promise.resolve(false),
    ]);
    if ((stockRequested && stockOk) || (vixRequested && vixOk)) {
      this.lastBatchAtMs = this.nowMsFn();
    }
  }

  private restBatchApiKey(): string {
    return this.restApiKeyFn !== null ? this.restApiKeyFn() : this.apiKey;
  }

  private async fetchStockBatch(): Promise<boolean> {
    const chunks: string[][] = [];
    for (let i = 0; i < this.stockSymbols.length; i += MASSIVE_SNAPSHOT_CHUNK_SIZE) {
      const chunk = this.stockSymbols.slice(i, i + MASSIVE_SNAPSHOT_CHUNK_SIZE);
      if (chunk.length > 0) {
        chunks.push(chunk);
      }
    }
    const chunkResults = await Promise.all(chunks.map((chunk) => this.fetchStockBatchChunk(chunk)));
    return chunkResults.some(Boolean);
  }

  private async fetchStockBatchChunk(chunk: readonly string[]): Promise<boolean> {
    const url = `${this.baseUrl}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${encodeURIComponent(chunk.join(','))}`;
    const response = await this.fetchFn(withAuth(url, this.restBatchApiKey()));
    if (!response.ok) {
      this.reportError(`Massive stock batch HTTP ${String(response.status)}`);
      return false;
    }
    const body: unknown = JSON.parse(response.text);
    if (!isRecord(body) || !Array.isArray(body['tickers'])) {
      this.reportError('Massive stock batch returned no tickers array');
      return false;
    }
    const session = getUsLiveSession(this.nowMsFn());
    const nowMs = this.nowMsFn();
    const currentEtDate = getMarketParts(Math.floor(nowMs / 1_000), 'EQUITY').dateKey;
    let updated = 0;
    for (const raw of body['tickers']) {
      if (!isRecord(raw) || typeof raw['ticker'] !== 'string') continue;
      const symbol = raw['ticker'].toUpperCase();
      if (!this.symbols.has(symbol)) continue;
      const day = isRecord(raw['day']) ? raw['day'] : {};
      const prevDay = isRecord(raw['prevDay']) ? raw['prevDay'] : {};
      const minute = isRecord(raw['min']) ? raw['min'] : {};
      const lastTrade = isRecord(raw['lastTrade']) ? raw['lastTrade'] : {};
      const lastTradeTimeSec = providerTimeSec(lastTrade['t']);
      const hasCurrentSessionTrade =
        Number.isFinite(lastTradeTimeSec) &&
        getMarketParts(lastTradeTimeSec, 'EQUITY').dateKey === currentEtDate;
      const price = extractSnapshotPrice({
        dayClose: positive(day['c']),
        minuteClose: positive(minute['c']),
        lastTradePrice: hasCurrentSessionTrade ? positive(lastTrade['p']) : Number.NaN,
        lastTradeTimeSec,
        previousDayTimeSec: providerTimeSec(prevDay['t']),
        session,
      });
      if (!Number.isFinite(price) || price <= 0) continue;
      const previousClose = nullable(positive(prevDay['c']));
      const dayTimeSec = providerTimeSec(day['t']);
      const minuteTimeSec = providerTimeSec(minute['t']);
      const observationTimeSec = hasCurrentSessionTrade
        ? lastTradeTimeSec
        : Number.isFinite(dayTimeSec)
          ? dayTimeSec
          : minuteTimeSec;
      const existing = this.quotes.get(symbol);
      const wsTickAt = this.wsTickAtMs.get(symbol);
      const wsFresh =
        existing?.source === 'MASSIVE_WS' &&
        wsTickAt !== undefined &&
        nowMs >= wsTickAt &&
        nowMs - wsTickAt < 10_000;
      const restVolume = nullable(nonNegative(day['v']));
      const vwap = positive(day['vw']);
      const restTurnover = restVolume !== null && Number.isFinite(vwap) ? restVolume * vwap : null;
      const restLow = nullable(positive(day['l']));
      const restHigh = nullable(positive(day['h']));
      const effectivePrice = wsFresh ? existing.price : price;
      const effectivePrevClose = previousClose ?? existing?.previousClose ?? null;
      // Volumen/turnover: el batch REST no puede pisar lo acumulado por WS en la
      // sesión. Con tick WS fresco manda el acumulado local (con baseline REST
      // solo si aún no existe); si no hay tick fresco, el mayor del día actual gana.
      const sameEtSession =
        existing !== undefined &&
        existing.asOfUtcSec !== null &&
        getMarketParts(existing.asOfUtcSec, 'EQUITY').dateKey === currentEtDate;
      const mergeCumulative = (wsValue: number | null, restValue: number | null): number | null => {
        if (wsFresh) return wsValue ?? restValue;
        if (wsValue !== null && restValue !== null) return sameEtSession ? Math.max(wsValue, restValue) : restValue;
        return restValue ?? wsValue;
      };
      const volume = mergeCumulative(existing?.volume ?? null, restVolume);
      const turnover = mergeCumulative(existing?.turnover ?? null, restTurnover);
      // Extremos del día: unión de observaciones reales (REST y WS) dentro de la
      // misma rueda ET; ante cambio de rueda manda el valor REST vigente y no se
      // arrastran extremos de la sesión anterior.
      const mergeExtreme = (
        restExtreme: number | null,
        wsExtreme: number | null,
        op: (a: number, b: number) => number,
      ): number | null => {
        if (restExtreme !== null && wsExtreme !== null) return op(restExtreme, wsExtreme);
        return restExtreme ?? wsExtreme;
      };
      const dayLow =
        sameEtSession || wsFresh ? mergeExtreme(restLow, existing.dayLow, Math.min) : restLow;
      const dayHigh =
        sameEtSession || wsFresh ? mergeExtreme(restHigh, existing.dayHigh, Math.max) : restHigh;
      this.quotes.set(symbol, {
        market: 'US',
        symbol,
        kind: 'stock',
        currency: 'USD',
        price: effectivePrice,
        previousClose: effectivePrevClose,
        changePct: changePct(effectivePrice, effectivePrevClose),
        dayLow,
        dayHigh,
        volume,
        turnover,
        asOfUtcSec: wsFresh
          ? existing.asOfUtcSec
          : Number.isFinite(observationTimeSec)
            ? observationTimeSec
            : existing !== undefined && existing.price === price
              ? existing.asOfUtcSec
              : null,
        source: wsFresh ? 'MASSIVE_WS' : 'MASSIVE_BATCH',
      });
      updated += 1;
    }
    return updated > 0;
  }

  private async fetchVixBatch(): Promise<boolean> {
    const url = `${this.baseUrl}/v3/snapshot?ticker=${encodeURIComponent('I:VIX')}`;
    const response = await this.fetchFn(withAuth(url, this.restBatchApiKey()));
    if (!response.ok) {
      this.reportError(`Massive VIX batch HTTP ${String(response.status)}`);
      return false;
    }
    const body: unknown = JSON.parse(response.text);
    if (!isRecord(body) || !Array.isArray(body['results'])) return false;
    let updated = 0;
    for (const raw of body['results']) {
      if (!isRecord(raw) || raw['ticker'] !== 'I:VIX') continue;
      const sessionRaw = isRecord(raw['session']) ? raw['session'] : {};
      const lastTrade = isRecord(raw['last_trade']) ? raw['last_trade'] : {};
      const price = [positive(raw['value']), positive(sessionRaw['price']), positive(lastTrade['price'])].find(
        (value) => Number.isFinite(value) && value > 0,
      );
      if (price === undefined) continue;
      const previousClose = nullable(positive(sessionRaw['previous_close']));
      const asOfUtcSec = providerTimeSec(raw['last_updated']);
      this.quotes.set('I:VIX', {
        market: 'US',
        symbol: 'I:VIX',
        kind: 'index',
        currency: 'USD',
        price,
        previousClose,
        changePct: changePct(price, previousClose),
        dayLow: nullable(positive(sessionRaw['low'])),
        dayHigh: nullable(positive(sessionRaw['high'])),
        volume: null,
        turnover: null,
        asOfUtcSec: Number.isFinite(asOfUtcSec) ? asOfUtcSec : null,
        source: 'MASSIVE_BATCH',
      });
      updated += 1;
    }
    return updated > 0;
  }
}
