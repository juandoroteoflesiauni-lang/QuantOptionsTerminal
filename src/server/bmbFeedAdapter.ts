/**
 * Productive Bull Market Brokers HomeBroker bridge client.
 *
 * Security / Zero Silent Fallbacks:
 * - credentials are read only from process.env and forwarded only to the local child;
 * - no credential, child stdout/stderr, or request payload is logged;
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
  loadBmbConfigFromEnv,
  type BmbBridgeBookEntry,
  type BmbBridgeClientDeps,
  type BmbBridgeSnapshotDto,
  type BmbConnectorHealthDto,
  type BmbTradeRowDto,
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

export function isBmbFeedConfigured(env: NodeJS.ProcessEnv): boolean {
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
    this.bridgeScriptPath = deps.bridgeScriptPath ?? resolve(process.cwd(), 'tools/bmb_bridge.py');
    const cfg = loadBmbConfigFromEnv(this.env);
    this.configured = isBmbFeedConfigured(this.env);
    this.secrets = [cfg.password, cfg.dni, cfg.username, cfg.account].filter((s) => s !== '');
    this.lastHealth = {
      ...this.delegate.getSafeHealthStatus(),
      status: cfg.password === '' ? 'DISABLED_NO_PASSWORD' : this.configured ? 'OFFLINE' : 'ERROR',
      connected: false,
      error: cfg.password !== '' && !this.configured ? 'INVALID_BMB_CONFIGURATION' : null,
    };
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
        this.processError = redactSecrets(err instanceof Error ? err.message : String(err), this.secrets);
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
      this.processError = redactSecrets(err instanceof Error ? err.message : String(err), this.secrets);
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
      this.processError = redactSecrets(err instanceof Error ? err.message : String(err), this.secrets);
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
            }
          } catch {
            // Never forward child output to logs; malformed/non-JSON output is ignored.
          }
        }
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: unknown) => {
        const safe = redactSecrets(String(chunk), this.secrets).trim().slice(0, 1_000);
        if (safe !== '') {
          this.processError = safe;
        }
      });
      child.once('error', (err) => {
        finish(new Error(redactSecrets(err.message, this.secrets)));
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
      this.processError = redactSecrets(err instanceof Error ? err.message : String(err), this.secrets);
      this.processReady = null;
      this.stopProcess();
    }
  }

  private normalizeSnapshot(snapshot: BmbBridgeSnapshotDto): BmbBridgeSnapshotDto {
    const ggal = snapshot.orderBooksBySymbol['GGAL'];
    const hasConnectedL2 =
      snapshot.health.connected &&
      ggal !== undefined &&
      ggal.bids.length > 0 &&
      ggal.asks.length > 0;
    const status: BmbConnectorHealthDto['status'] = hasConnectedL2
      ? 'CONNECTED_L2'
      : this.processError !== null && !snapshot.health.connected
        ? 'ERROR'
        : snapshot.health.status;
    const health: BmbConnectorHealthDto = {
      ...snapshot.health,
      status,
      connected: status === 'READY' || status === 'CONNECTED_L2',
      error: this.processError !== null && !snapshot.health.connected
        ? redactSecrets(this.processError, this.secrets)
        : snapshot.health.error,
    };
    this.lastHealth = health;
    return {
      ...snapshot,
      health,
      tradesBySymbol: snapshot.tradesBySymbol ?? {},
    };
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
    if (cfg.password === '') {
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
        this.processError = redactSecrets(err instanceof Error ? err.message : String(err), this.secrets);
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
      telemetry,
    };
  }

  /** Pieza 33: reconexión real del bridge local por señal loopback. */
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
