/**
 * Productive Bull Market Brokers HomeBroker bridge client.
 *
 * Security / Zero Silent Fallbacks:
 * - credentials are read only from process.env and forwarded only to the local child
 *   (including the optional trusted-device `BMB_SESSION_COOKIE` and hub token
 *   `BMB_HUB_TOKEN` for the ASP.NET Core SignalR connector, Pieza 38);
 * - no credential (password, DNI, user, account, session cookie or hub token),
 *   child stdout/stderr, or request payload is logged; every credential alias is
 *   part of the redaction secret list and `?token=`/`?id=` query values are
 *   sanitized out of any diagnostic text before it reaches logs or `lastError`;
 * - with `BMB_HUB_TOKEN` or `BMB_SESSION_COOKIE` present, the adapter starts
 *   `tools/bmb_inversiones_signalr.py` (SignalR Core 5-puntas L2) instead of the
 *   legacy pyhomebroker flow, consuming its stdout JSONL `L2_UPDATE` events live;
 * - polls are globally single-flight and separated by at least 1.5 seconds;
 * - outside 11:00–17:00 ART (Mon–Fri), no cached book is exposed as live;
 * - authentication/dependency/network failures remain explicit for Data912 EOD routing.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { getBuenosAiresParts } from '../core/ggal/types.js';
import type {
  BestQuoteSnapshot,
  IcebergDetectionInput,
  VpinSignedTradeInput,
} from '../core/ggal/l2AndRegimeEngines.js';
import {
  BmbBridgeClient,
  isBmbInversionesSignalRConfigured,
  loadBmbConfigFromEnv,
  redactHubQueryCredentials,
  type BmbBridgeBookEntry,
  type BmbBridgeClientDeps,
  type BmbBridgeSnapshotDto,
  type BmbConnectorHealthDto,
  type BmbTradeRowDto,
  type OrderBookLevel,
} from './primaryRofexLoader.js';
import { redactSecrets } from './runtimeCache.js';
import {
  RollingFeedTelemetry,
  type FeedTelemetrySnapshot,
} from './feedsHealthMonitor.js';

export const BMB_MIN_POLL_INTERVAL_MS = 1_500;
export const BMB_LIVE_LOOP_INTERVAL_MS = 2_500;
export const BMB_L2_STALE_THRESHOLD_SEC = 20;
export const BMB_OUT_OF_SESSION_REASON = 'ARMED_OUT_OF_SESSION' as const;

const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8788';
const PROCESS_READY_TIMEOUT_MS = 5_000;

export interface BmbBestQuoteObservation extends BestQuoteSnapshot {
  readonly lastTradeSequence: number;
}

export interface BmbIcebergTrackingResult {
  readonly input: IcebergDetectionInput | null;
  readonly lastTradeSequence: number;
}

export interface BmbFeedAdapterDeps extends BmbBridgeClientDeps {
  readonly manageProcess?: boolean;
  readonly minPollIntervalMs?: number;
  readonly spawnFn?: typeof spawn;
  readonly pythonBinary?: string;
  readonly bridgeScriptPath?: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Monday–Friday, 11:00 <= ART < 17:00. ART has no DST. */
export function isBymaL2SessionUtcSec(utcSec: number): boolean {
  if (!Number.isInteger(utcSec) || utcSec < 0) {
    return false;
  }
  const parts = getBuenosAiresParts(utcSec);
  return parts.weekday >= 1 && parts.weekday <= 5 && parts.minutesOfDay >= 11 * 60 && parts.minutesOfDay < 17 * 60;
}

/** Conector SignalR Core (Pieza 38) vs flujo legacy `pyhomebroker`. */
export const BMB_SIGNALR_SCRIPT = 'tools/bmb_inversiones_signalr.py';
export const BMB_LEGACY_SCRIPT = 'tools/bmb_bridge.py';

/**
 * Con `BMB_HUB_TOKEN` o `BMB_SESSION_COOKIE` presentes se inicia el conector
 * SignalR Core (`tools/bmb_inversiones_signalr.py`) en lugar del flujo legacy.
 */
export function resolveBmbBridgeScriptPath(env: NodeJS.ProcessEnv): string {
  return isBmbInversionesSignalRConfigured(env) ? BMB_SIGNALR_SCRIPT : BMB_LEGACY_SCRIPT;
}

function parseLiveL2Level(value: unknown): OrderBookLevel | null {
  if (!isPlainRecord(value)) return null;
  const price = value['price'];
  const size = value['size'];
  const rawOrderCount = value['orderCount'];
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null;
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return null;
  const orderCount =
    typeof rawOrderCount === 'number' && Number.isFinite(rawOrderCount) && rawOrderCount >= 0
      ? rawOrderCount
      : null;
  return { price, size, orderCount };
}

function parseLiveL2Levels(value: unknown): readonly OrderBookLevel[] {
  if (!Array.isArray(value)) return [];
  const levels: OrderBookLevel[] = [];
  for (const item of value) {
    const level = parseLiveL2Level(item);
    if (level !== null) {
      levels.push(level);
    }
  }
  return levels;
}

/**
 * Ingiere un evento JSONL `{"event":"L2_UPDATE","record":{...}}` emitido por el
 * conector SignalR Core. Puro: devuelve los libros originales ante cualquier
 * registro inválido (JSON malformado, evento desconocido, CI, libro vacío);
 * ordena por precio y trunca a 5 puntas antes de almacenar.
 */
export function ingestLiveL2Record(
  parsed: unknown,
  books: Readonly<Record<string, BmbBridgeBookEntry>>,
): Readonly<Record<string, BmbBridgeBookEntry>> {
  if (!isPlainRecord(parsed) || parsed['event'] !== 'L2_UPDATE' || !isPlainRecord(parsed['record'])) {
    return books;
  }
  const record = parsed['record'];
  const symbol = typeof record['symbol'] === 'string' ? record['symbol'].trim().toUpperCase() : '';
  if (symbol === '' || record['settlement'] !== '24hs') {
    return books;
  }
  const bids = parseLiveL2Levels(record['bids']);
  const asks = parseLiveL2Levels(record['asks']);
  if (bids.length === 0 && asks.length === 0) {
    return books;
  }
  const rawAsOf = record['asOfUtcSec'];
  const asOfUtcSec =
    typeof rawAsOf === 'number' && Number.isInteger(rawAsOf) && rawAsOf > 0 ? rawAsOf : null;
  const entry: BmbBridgeBookEntry = {
    symbol,
    settlement: '24hs',
    bids: [...bids].sort((a, b) => b.price - a.price).slice(0, 5),
    asks: [...asks].sort((a, b) => a.price - b.price).slice(0, 5),
    asOfUtcSec,
    source: 'BMB_HOMEBROKER',
  };
  return { ...books, [symbol]: entry };
}

/** Variante por línea de stdout JSONL (ignora líneas no-JSON). */
export function ingestLiveL2Line(
  line: string,
  books: Readonly<Record<string, BmbBridgeBookEntry>>,
): Readonly<Record<string, BmbBridgeBookEntry>> {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(line);
  } catch {
    return books;
  }
  return ingestLiveL2Record(parsed, books);
}

/**
 * Fusiona los libros L2 vivos (stdout JSONL) en el snapshot polled por HTTP:
 * cada símbolo toma la entrada más reciente por `asOfUtcSec` (empate -> live).
 */
export function mergeLiveL2IntoSnapshot(
  snapshot: BmbBridgeSnapshotDto,
  liveBooks: Readonly<Record<string, BmbBridgeBookEntry>>,
): BmbBridgeSnapshotDto {
  const liveKeys = Object.keys(liveBooks);
  if (liveKeys.length === 0) {
    return snapshot;
  }
  let changed = false;
  const merged: Record<string, BmbBridgeBookEntry> = { ...snapshot.orderBooksBySymbol };
  for (const key of liveKeys) {
    const live = liveBooks[key];
    const existing = merged[key];
    if (live === undefined) continue;
    if (existing === undefined || (live.asOfUtcSec ?? 0) >= (existing.asOfUtcSec ?? 0)) {
      merged[key] = live;
      changed = true;
    }
  }
  return changed ? { ...snapshot, orderBooksBySymbol: merged } : snapshot;
}

export function isBmbFeedConfigured(env: NodeJS.ProcessEnv): boolean {
  // Modo conector SignalR Core: BMB_HUB_TOKEN o BMB_SESSION_COOKIE bastan.
  if (isBmbInversionesSignalRConfigured(env)) {
    return true;
  }
  const cfg = loadBmbConfigFromEnv(env);
  const rawBroker = env['BMB_BROKER_ID']?.trim() ?? '';
  const brokerId = Number(rawBroker);
  return rawBroker !== '' && Number.isInteger(brokerId) && brokerId > 0 && cfg.dni !== '' && cfg.username !== '' && cfg.password !== '';
}

function emptySnapshot(health: BmbConnectorHealthDto): BmbBridgeSnapshotDto {
  return {
    health,
    cauciones: [],
    orderBooksBySymbol: {},
    options: [],
    tradesBySymbol: {},
  };
}

function validSequence(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

/** Convert only genuinely classified BMB trades; unknown aggressor side remains unusable. */
export function bmbTradesToVpinInput(
  rows: readonly BmbTradeRowDto[],
): readonly VpinSignedTradeInput[] {
  const accepted: { readonly sequence: number; readonly trade: VpinSignedTradeInput }[] = [];
  const seenSequences = new Set<number>();
  for (const row of rows) {
    if (
      !validSequence(row.sequence) ||
      seenSequences.has(row.sequence) ||
      !Number.isInteger(row.timeSec) ||
      row.timeSec <= 0 ||
      !Number.isFinite(row.price) ||
      row.price <= 0 ||
      !Number.isFinite(row.size) ||
      row.size < 0 ||
      row.buyVolume === null ||
      row.sellVolume === null ||
      !Number.isFinite(row.buyVolume) ||
      !Number.isFinite(row.sellVolume) ||
      row.buyVolume < 0 ||
      row.sellVolume < 0 ||
      row.buyVolume + row.sellVolume <= 0
    ) {
      continue;
    }
    seenSequences.add(row.sequence);
    accepted.push({
      sequence: row.sequence,
      trade: {
        timeSec: row.timeSec,
        price: row.price,
        buyVolume: row.buyVolume,
        sellVolume: row.sellVolume,
      },
    });
  }
  accepted.sort((a, b) => a.trade.timeSec - b.trade.timeSec || a.sequence - b.sequence);
  return accepted.map((item) => item.trade);
}

/**
 * Build Motor-8 iceberg input from consecutive BMB BBO snapshots and real trades.
 * Trades at the prior bid are executed at bid; trades at the prior ask at ask.
 */
export function buildBmbIcebergTrackingResult(
  previous: BmbBestQuoteObservation | null,
  current: BestQuoteSnapshot,
  rows: readonly BmbTradeRowDto[],
): BmbIcebergTrackingResult {
  let maxSequence = previous?.lastTradeSequence ?? 0;
  for (const row of rows) {
    if (validSequence(row.sequence) && row.sequence > maxSequence) {
      maxSequence = row.sequence;
    }
  }

  const currentValid =
    Number.isFinite(current.bidPrice) &&
    current.bidPrice > 0 &&
    Number.isFinite(current.bidSize) &&
    current.bidSize >= 0 &&
    Number.isFinite(current.askPrice) &&
    current.askPrice > 0 &&
    Number.isFinite(current.askSize) &&
    current.askSize >= 0;
  if (previous === null || !currentValid) {
    return { input: null, lastTradeSequence: maxSequence };
  }

  let executedVolumeAtBid = 0;
  let executedVolumeAtAsk = 0;
  const bidTolerance = 1e-8 * Math.max(1, previous.bidPrice);
  const askTolerance = 1e-8 * Math.max(1, previous.askPrice);
  for (const row of rows) {
    if (
      !validSequence(row.sequence) ||
      row.attributableToLast !== true ||
      row.sequence <= previous.lastTradeSequence ||
      !Number.isFinite(row.price) ||
      row.price <= 0 ||
      !Number.isFinite(row.size) ||
      row.size < 0
    ) {
      continue;
    }
    if (Math.abs(row.price - previous.bidPrice) <= bidTolerance) {
      executedVolumeAtBid += row.size;
    }
    if (Math.abs(row.price - previous.askPrice) <= askTolerance) {
      executedVolumeAtAsk += row.size;
    }
  }

  return {
    input: {
      previousBest: {
        bidPrice: previous.bidPrice,
        bidSize: previous.bidSize,
        askPrice: previous.askPrice,
        askSize: previous.askSize,
      },
      currentBest: {
        bidPrice: current.bidPrice,
        bidSize: current.bidSize,
        askPrice: current.askPrice,
        askSize: current.askSize,
      },
      executedVolumeAtBid,
      executedVolumeAtAsk,
    },
    lastTradeSequence: maxSequence,
  };
}

export class BmbFeedAdapter {
  private readonly env: NodeJS.ProcessEnv;
  private readonly delegate: BmbBridgeClient;
  private readonly nowMsFn: () => number;
  private readonly secrets: readonly string[];
  private readonly minPollIntervalMs: number;
  private readonly manageProcess: boolean;
  private readonly spawnFn: typeof spawn;
  private readonly pythonBinary: string;
  private readonly bridgeScriptPath: string;
  private readonly configured: boolean;
  private child: ChildProcess | null = null;
  private processReady: Promise<void> | null = null;
  private inFlight: Promise<BmbBridgeSnapshotDto> | null = null;
  private lastSnapshot: BmbBridgeSnapshotDto | null = null;
  private lastPollStartedMs: number | null = null;
  private lastHealth: BmbConnectorHealthDto;
  private processError: string | null = null;
  private liveLoopTimer: ReturnType<typeof setTimeout> | null = null;
  private liveLoopRunning = false;
  private liveLoopSymbols: readonly string[] = [];
  private nextPrimeIndex = 0;
  private readonly signalRMode: boolean;
  private liveL2Books: Readonly<Record<string, BmbBridgeBookEntry>> = {};
  /** Pieza 39: fuente de ticks ARS para el GGAL Specialist (trades GGAL). */
  private ggalArsTickListener: ((tick: { readonly price: number; readonly size: number; readonly timeSec: number }) => void) | null = null;
  private lastArsTickSequence = 0;
  private readonly httpTelemetry = new RollingFeedTelemetry({
    latencyKind: 'HTTP_ROUND_TRIP',
  });

  public constructor(deps: BmbFeedAdapterDeps = {}) {
    this.env = deps.env ?? process.env;
    this.nowMsFn = deps.nowMsFn ?? (() => Date.now());
    this.delegate = new BmbBridgeClient({ ...deps });
    this.minPollIntervalMs = Number.isFinite(deps.minPollIntervalMs)
      ? Math.max(BMB_MIN_POLL_INTERVAL_MS, deps.minPollIntervalMs ?? BMB_MIN_POLL_INTERVAL_MS)
      : BMB_MIN_POLL_INTERVAL_MS;
    this.manageProcess = deps.manageProcess ?? this.env['BMB_BRIDGE_URL'] === undefined;
    this.spawnFn = deps.spawnFn ?? spawn;
    this.pythonBinary = deps.pythonBinary ?? this.env['BMB_PYTHON_BIN']?.trim() ?? 'python';
    this.bridgeScriptPath =
      deps.bridgeScriptPath ?? resolve(process.cwd(), resolveBmbBridgeScriptPath(this.env));
    const cfg = loadBmbConfigFromEnv(this.env);
    this.signalRMode = isBmbInversionesSignalRConfigured(this.env);
    this.configured = isBmbFeedConfigured(this.env);
    this.secrets = [
      cfg.password,
      cfg.dni,
      cfg.username,
      cfg.account,
      cfg.sessionCookie,
      cfg.hubToken,
    ].filter((s) => s !== '');
    this.lastHealth = {
      ...this.delegate.getSafeHealthStatus(),
      status: this.signalRMode
        ? 'OFFLINE'
        : cfg.password === ''
          ? 'DISABLED_NO_PASSWORD'
          : this.configured
            ? 'OFFLINE'
            : 'ERROR',
      connected: false,
      error:
        this.signalRMode || cfg.password === ''
          ? null
          : this.configured
            ? null
            : 'INVALID_BMB_CONFIGURATION',
    };
  }

  /** Redacción completa: secretos de env + valores `?token=`/`?id=` de query. */
  private sanitizeError(message: string): string {
    return redactHubQueryCredentials(redactSecrets(message, this.secrets));
  }

  private outOfSessionHealth(): BmbConnectorHealthDto {
    return {
      ...this.lastHealth,
      status: 'OUT_OF_SESSION',
      connected: false,
      lastUpdateUtcSec: null,
      error: BMB_OUT_OF_SESSION_REASON,
    };
  }

  public getSafeHealthStatus(): BmbConnectorHealthDto {
    return this.lastHealth;
  }

  private bridgeHostAndPort(): { readonly host: string; readonly port: number } {
    const rawUrl = this.env['BMB_BRIDGE_URL']?.trim() || DEFAULT_BRIDGE_URL;
    const parsed = new URL(rawUrl);
    const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1';
    if (parsed.protocol !== 'http:' || !loopback) {
      throw new Error('BMB_BRIDGE_URL must use local HTTP loopback');
    }
    const port = Number(parsed.port || '80');
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new Error('Invalid BMB bridge port');
    }
    return { host: parsed.hostname === '::1' ? '::1' : '127.0.0.1', port };
  }

  private async ensureProcess(): Promise<void> {
    if (!this.manageProcess) {
      return;
    }
    if (this.processReady !== null) {
      const pending = this.processReady;
      try {
        await pending;
      } catch (err: unknown) {
        this.processError = this.sanitizeError(err instanceof Error ? err.message : String(err));
        if (this.processReady === pending) {
          this.processReady = null;
        }
        this.stopProcess();
      }
      return;
    }

    let endpoint: { readonly host: string; readonly port: number };
    try {
      endpoint = this.bridgeHostAndPort();
    } catch (err: unknown) {
      this.processError = this.sanitizeError(err instanceof Error ? err.message : String(err));
      return;
    }

    const cfg = loadBmbConfigFromEnv(this.env);
    const childEnv: NodeJS.ProcessEnv = {
      PATH: this.env['PATH'],
      SystemRoot: this.env['SystemRoot'],
      COMSPEC: this.env['COMSPEC'],
      PYTHONHOME: this.env['PYTHONHOME'],
      PYTHONPATH: this.env['PYTHONPATH'],
      BMB_BROKER_ID: String(cfg.brokerId),
      BMB_DNI: cfg.dni,
      BMB_USERNAME: cfg.username,
      BMB_PASSWORD: cfg.password,
      BMB_ACCOUNT: cfg.account,
      ...(cfg.sessionCookie !== '' ? { BMB_SESSION_COOKIE: cfg.sessionCookie } : {}),
      ...(cfg.hubToken !== '' ? { BMB_HUB_TOKEN: cfg.hubToken } : {}),
      ...(this.env['BMB_LEADERS'] !== undefined ? { BMB_LEADERS: this.env['BMB_LEADERS'] } : {}),
      BMB_BRIDGE_HOST: endpoint.host,
      BMB_BRIDGE_PORT: String(endpoint.port),
    };

    let child: ChildProcess;
    try {
      child = this.spawnFn(
        this.pythonBinary,
        [this.bridgeScriptPath, '--host', endpoint.host, '--port', String(endpoint.port)],
        {
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
    } catch (err: unknown) {
      this.processError = this.sanitizeError(err instanceof Error ? err.message : String(err));
      return;
    }

    this.child = child;
    this.processError = null;
    this.processReady = new Promise<void>((resolveReady, rejectReady) => {
      let settled = false;
      let stdoutBuffer = '';
      const finish = (error: Error | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (error === null) {
          resolveReady();
        } else {
          rejectReady(error);
        }
      };
      const timer = setTimeout(() => {
        finish(new Error('BMB bridge readiness timeout'));
      }, PROCESS_READY_TIMEOUT_MS);

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: unknown) => {
        stdoutBuffer += String(chunk);
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          try {
            const parsed: unknown = JSON.parse(line);
            if (isPlainRecord(parsed) && parsed['event'] === 'LISTENING') {
              finish(null);
              continue;
            }
            // JSONL L2_UPDATE del conector SignalR Core: ingesta en vivo de las
            // 5 puntas sin esperar el poll HTTP (líneas inválidas se ignoran).
            const updated = ingestLiveL2Record(parsed, this.liveL2Books);
            if (updated !== this.liveL2Books) {
              this.liveL2Books = updated;
            }
          } catch {
            // Never forward child output to logs; malformed/non-JSON output is ignored.
          }
        }
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: unknown) => {
        const safe = this.sanitizeError(String(chunk)).trim().slice(0, 1_000);
        if (safe !== '') {
          this.processError = safe;
        }
      });
      child.once('error', (err) => {
        finish(new Error(this.sanitizeError(err.message)));
      });
      child.once('exit', (code) => {
        if (this.child === child) {
          this.child = null;
          this.processReady = null;
        }
        finish(new Error(`BMB bridge exited before readiness (code ${String(code)})`));
      });
    });

    try {
      await this.processReady;
    } catch (err: unknown) {
      this.processError = this.sanitizeError(err instanceof Error ? err.message : String(err));
      this.processReady = null;
      this.stopProcess();
    }
  }

  /** Pieza 39: registra la fuente de ticks ARS (GGAL Specialist runtime). */
  public setGgalArsTickListener(
    listener: ((tick: { readonly price: number; readonly size: number; readonly timeSec: number }) => void) | null,
  ): void {
    this.ggalArsTickListener = listener;
    if (listener === null) {
      this.lastArsTickSequence = 0;
    }
  }

  private emitGgalArsTicks(snapshot: BmbBridgeSnapshotDto): void {
    const listener = this.ggalArsTickListener;
    if (listener === null) {
      return;
    }
    const trades = snapshot.tradesBySymbol?.['GGAL'];
    if (trades === undefined || trades.length === 0) {
      return;
    }
    for (const trade of trades) {
      if (
        !Number.isInteger(trade.sequence) ||
        trade.sequence <= this.lastArsTickSequence ||
        !Number.isFinite(trade.price) ||
        trade.price <= 0 ||
        !Number.isInteger(trade.timeSec) ||
        trade.timeSec <= 0
      ) {
        continue;
      }
      if (trade.sequence > this.lastArsTickSequence) {
        this.lastArsTickSequence = trade.sequence;
      }
      listener({
        price: trade.price,
        size: Number.isFinite(trade.size) && trade.size > 0 ? trade.size : 0,
        timeSec: trade.timeSec,
      });
    }
  }

  private normalizeSnapshot(snapshot: BmbBridgeSnapshotDto): BmbBridgeSnapshotDto {
    const ggal = snapshot.orderBooksBySymbol['GGAL'];
    const liveGgal = this.liveL2Books['GGAL'];
    const ggalBook = liveGgal ?? ggal;
    const hasConnectedL2 =
      snapshot.health.connected &&
      ggalBook !== undefined &&
      ggalBook.bids.length > 0 &&
      ggalBook.asks.length > 0;
    const status: BmbConnectorHealthDto['status'] = hasConnectedL2
      ? 'CONNECTED_L2'
      : this.processError !== null && !snapshot.health.connected
        ? 'ERROR'
        : snapshot.health.status;
    const health: BmbConnectorHealthDto = {
      ...snapshot.health,
      status,
      connected: status === 'READY' || status === 'CONNECTED_L2',
      error:
        this.processError !== null && !snapshot.health.connected
          ? this.sanitizeError(this.processError)
          : snapshot.health.error,
    };
    this.lastHealth = health;
    const normalized: BmbBridgeSnapshotDto = {
      ...snapshot,
      health,
      tradesBySymbol: snapshot.tradesBySymbol ?? {},
    };
    // Los libros L2 vivos (stdout JSONL del conector SignalR) se fusionan por
    // asOfUtcSec antes de exponerlos a ggalSpecialistRuntime y StockDetailView.
    const merged = mergeLiveL2IntoSnapshot(normalized, this.liveL2Books);
    this.emitGgalArsTicks(merged);
    this.lastSnapshot = merged;
    return merged;
  }

  private filterSymbol(snapshot: BmbBridgeSnapshotDto, symbol?: string): BmbBridgeSnapshotDto {
    const clean = symbol?.trim().toUpperCase();
    if (clean === undefined || clean === '') {
      return snapshot;
    }
    const book = snapshot.orderBooksBySymbol[clean];
    const trades = snapshot.tradesBySymbol?.[clean];
    return {
      ...snapshot,
      orderBooksBySymbol: book !== undefined ? { [clean]: book } : {},
      tradesBySymbol: trades !== undefined ? { [clean]: trades } : {},
    };
  }

  public async getSnapshot(
    symbol?: string,
    badlarTna: number | null = null,
    forceRefresh = false,
  ): Promise<BmbBridgeSnapshotDto> {
    const cfg = loadBmbConfigFromEnv(this.env);
    // El conector SignalR Core (BMB_HUB_TOKEN/BMB_SESSION_COOKIE) no requiere
    // BMB_PASSWORD: su material de autenticación es propio.
    if (!this.signalRMode && cfg.password === '') {
      this.lastHealth = {
        ...this.lastHealth,
        status: 'DISABLED_NO_PASSWORD',
        connected: false,
        passwordConfigured: false,
        error: null,
      };
      return emptySnapshot(this.lastHealth);
    }
    if (!this.configured) {
      this.lastHealth = {
        ...this.lastHealth,
        status: 'ERROR',
        connected: false,
        error: 'INVALID_BMB_CONFIGURATION',
      };
      return emptySnapshot(this.lastHealth);
    }

    const nowSec = Math.floor(this.nowMsFn() / 1_000);
    if (!isBymaL2SessionUtcSec(nowSec)) {
      this.stopProcess();
      this.lastSnapshot = null;
      this.lastPollStartedMs = null;
      return emptySnapshot(this.outOfSessionHealth());
    }
    if (forceRefresh && this.processError !== null) {
      // Explicit retry after the rate-limit window; stale process errors are not sticky.
      this.processError = null;
    }
    await this.ensureProcess();
    const nowMs = this.nowMsFn();
    if (
      this.lastSnapshot !== null &&
      this.lastPollStartedMs !== null &&
      nowMs - this.lastPollStartedMs >= 0 &&
      nowMs - this.lastPollStartedMs < this.minPollIntervalMs
    ) {
      return this.filterSymbol(this.lastSnapshot, symbol);
    }
    if (this.inFlight !== null) {
      return this.filterSymbol(await this.inFlight, symbol);
    }

    const work = (async (): Promise<BmbBridgeSnapshotDto> => {
      this.lastPollStartedMs = this.nowMsFn();
      const requestStartedAtMs = this.nowMsFn();
      let raw: BmbBridgeSnapshotDto;
      try {
        raw = await this.delegate.getSnapshot(undefined, badlarTna, true);
        const completedAtMs = this.nowMsFn();
        this.httpTelemetry.record({
          atMs: completedAtMs,
          latencyMs: completedAtMs - requestStartedAtMs,
          httpStatus: 200,
        });
      } catch (err: unknown) {
        const completedAtMs = this.nowMsFn();
        this.httpTelemetry.record({
          atMs: completedAtMs,
          latencyMs: completedAtMs - requestStartedAtMs,
        });
        throw err;
      }
      const normalized = this.normalizeSnapshot(raw);
      this.lastSnapshot = normalized;
      return normalized;
    })();
    this.inFlight = work;
    try {
      return this.filterSymbol(await work, symbol);
    } finally {
      if (this.inFlight === work) {
        this.inFlight = null;
      }
    }
  }

  private isLiveLoopActive(): boolean {
    return this.liveLoopRunning;
  }

  /**
   * Starts the productive BYMA loop explicitly from the server lifecycle.
   * Dynamic symbol priming asks the local bridge to subscribe additional books;
   * ordinary polls always retain the complete, unfiltered snapshot in memory.
   */
  public startLiveLoop(symbols: readonly string[] = []): void {
    if (this.liveLoopRunning) return;
    this.liveLoopRunning = true;
    this.liveLoopSymbols = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter((s) => s !== ''))];
    this.nextPrimeIndex = 0;
    const run = async (): Promise<void> => {
      if (!this.liveLoopRunning) return;
      const inSession = isBymaL2SessionUtcSec(Math.floor(this.nowMsFn() / 1_000));
      try {
        if (inSession) {
          const symbol = this.liveLoopSymbols[this.nextPrimeIndex];
          if (symbol !== undefined) {
            this.nextPrimeIndex += 1;
            await this.delegate.getSnapshot(symbol, null, true);
          }
          await this.getSnapshot(undefined, null, true);
        } else if (this.lastSnapshot !== null || this.child !== null) {
          await this.getSnapshot(undefined, null, false);
        }
      } catch (err: unknown) {
        this.processError = this.sanitizeError(err instanceof Error ? err.message : String(err));
      } finally {
        if (this.isLiveLoopActive()) {
          this.liveLoopTimer = setTimeout(() => {
            void run();
          }, inSession ? BMB_LIVE_LOOP_INTERVAL_MS : 5_000);
          this.liveLoopTimer.unref();
        }
      }
    };
    void run();
  }

  public getCachedSnapshot(): BmbBridgeSnapshotDto | null {
    if (!isBymaL2SessionUtcSec(Math.floor(this.nowMsFn() / 1_000))) return null;
    return this.lastSnapshot;
  }

  public getFeedTelemetrySnapshot(nowMs: number): FeedTelemetrySnapshot {
    return this.httpTelemetry.snapshot(nowMs);
  }

  public getFeedHealth() {
    const health = this.getSafeHealthStatus();
    const telemetry = this.getFeedTelemetrySnapshot(this.nowMsFn());
    return {
      configured: this.configured,
      healthStatus: health.status,
      connected: health.connected,
      lastUpdateUtcSec: health.lastUpdateUtcSec,
      orderBookCount: health.counts.orderBooks,
      caucionCount: health.counts.cauciones,
      optionCount: health.counts.options,
      lastError: health.error,
      signalRMode: this.signalRMode,
      telemetry,
    };
  }

  /** Pieza 33/38.1: reconexión real del bridge local por señal loopback.
   * En modo SignalR Core el bridge local soporta `POST /reconnect` (202) y
   * reinicia limpiamente el conector Python; nunca responde 501. */
  public async reconnect(): Promise<string> {
    if (!this.configured) {
      throw new Error('BMB bridge configuration incomplete');
    }
    await this.ensureProcess();
    await this.delegate.requestReconnect();
    const snapshot = await this.getSnapshot(undefined, null, true);
    return `BMB_HOMEBROKER_L2_RECONNECT_${snapshot.health.status}`;
  }

  public getCachedOrderBook(symbol = 'GGAL'): BmbBridgeBookEntry | null {
    if (!isBymaL2SessionUtcSec(Math.floor(this.nowMsFn() / 1_000))) {
      return null;
    }
    return this.lastSnapshot?.orderBooksBySymbol[symbol.trim().toUpperCase()] ?? null;
  }

  private stopProcess(): void {
    const child = this.child;
    this.child = null;
    this.processReady = null;
    this.liveL2Books = {};
    if (child !== null) {
      try {
        child.kill();
      } catch {
        // Shutdown remains best-effort; no process output or secrets are logged.
      }
    }
  }

  public stop(): void {
    this.liveLoopRunning = false;
    if (this.liveLoopTimer !== null) clearTimeout(this.liveLoopTimer);
    this.liveLoopTimer = null;
    this.liveLoopSymbols = [];
    this.nextPrimeIndex = 0;
    this.stopProcess();
    this.inFlight = null;
    this.lastSnapshot = null;
    this.lastPollStartedMs = null;
  }
}
