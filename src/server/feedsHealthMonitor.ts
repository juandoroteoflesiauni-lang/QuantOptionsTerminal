/**
 * Unified real-time feeds health monitor (Pieza 33).
 *
 * Security / Zero Silent Fallbacks:
 * - provider credentials, tokens and URLs containing credentials are never
 *   serialized; only safe slot names, counters and redacted errors are exposed;
 * - metrics that cannot be measured are `null` (rendered as "—" by the UI),
 *   never substituted by a demo value;
 * - the rolling window is explicit: 60 consecutive one-second buckets ending at
 *   the current whole second.
 */

import { getBuenosAiresParts } from '../core/ggal/types.js';
import { getMarketParts } from '../core/sessions.js';
import { redactSecrets } from './runtimeCache.js';

export type FeedProviderId =
  | 'MASSIVE_WS_STOCKS'
  | 'MASSIVE_REST_POOL'
  | 'TRADIER_LIVE_WS'
  | 'ORATS_API'
  | 'PRIMARY_REMARKETS_DLR'
  | 'BMB_HOMEBROKER_L2'
  | 'IOL_REST_V2';

export type FeedProviderState =
  | 'CONNECTED'
  | 'ARMED_OUT_OF_SESSION'
  | 'DEGRADED'
  | 'NOT_CONFIGURED';

export type FeedSessionMode = 'IN_SESSION' | 'OUT_OF_SESSION';

export type FeedLatencyKind = 'PROVIDER_EVENT_AGE' | 'HTTP_ROUND_TRIP';

export type FeedReconnectAction = 'RECONNECT' | 'RESYNC';

export interface FeedTelemetryEventInput {
  /** Local receipt/completion time in unix milliseconds. */
  readonly atMs: number;
  /** Valid latency sample, or null when the provider timestamp is unusable. */
  readonly latencyMs?: number | null;
  /** HTTP status for REST telemetry; omitted/null for stream telemetry. */
  readonly httpStatus?: number | null;
  /** Explicit stream data marker. HTTP 2xx responses are also data ticks. */
  readonly isValidTick?: boolean;
}

export interface FeedTelemetrySnapshot {
  readonly startedAtMs: number | null;
  readonly totalMessages: number;
  readonly messagesPerMinute: number | null;
  readonly averageLatencyMs: number | null;
  readonly latencySamples: number;
  readonly lastMessageAtMs: number | null;
  readonly lastTickAtMs: number | null;
  readonly lastHttpSuccessAtMs: number | null;
  readonly lastHttpFailureAtMs: number | null;
  readonly lastHttp429AtMs: number | null;
  readonly http429PerMinute: number | null;
}

export interface RollingFeedTelemetryOptions {
  readonly latencyKind: FeedLatencyKind;
}

interface MutableTelemetryBucket {
  count: number;
  tickCount: number;
  latencySumMs: number;
  latencySamples: number;
  http429Count: number;
  lastAtMs: number | null;
  lastTickAtMs: number | null;
  lastHttpSuccessAtMs: number | null;
  lastHttpFailureAtMs: number | null;
  lastHttp429AtMs: number | null;
}

const TELEMETRY_WINDOW_BUCKETS = 60;

function newBucket(): MutableTelemetryBucket {
  return {
    count: 0,
    tickCount: 0,
    latencySumMs: 0,
    latencySamples: 0,
    http429Count: 0,
    lastAtMs: null,
    lastTickAtMs: null,
    lastHttpSuccessAtMs: null,
    lastHttpFailureAtMs: null,
    lastHttp429AtMs: null,
  };
}

export function emptyFeedTelemetrySnapshot(): FeedTelemetrySnapshot {
  return {
    startedAtMs: null,
    totalMessages: 0,
    messagesPerMinute: null,
    averageLatencyMs: null,
    latencySamples: 0,
    lastMessageAtMs: null,
    lastTickAtMs: null,
    lastHttpSuccessAtMs: null,
    lastHttpFailureAtMs: null,
    lastHttp429AtMs: null,
    http429PerMinute: null,
  };
}

/**
 * Bounded telemetry accumulator. Its state is private; callers never mutate
 * arguments. One-second buckets keep memory bounded while retaining explicit
 * "no sample" semantics for latency and ticks.
 */
export class RollingFeedTelemetry {
  private readonly latencyKind: FeedLatencyKind;
  private readonly buckets = new Map<number, MutableTelemetryBucket>();
  private startedAtMs: number | null = null;
  private totalMessages = 0;

  public constructor(options: RollingFeedTelemetryOptions) {
    this.latencyKind = options.latencyKind;
  }

  public get kind(): FeedLatencyKind {
    return this.latencyKind;
  }

  public record(input: FeedTelemetryEventInput): void {
    if (!Number.isFinite(input.atMs) || input.atMs < 0) {
      return;
    }
    const bucketIndex = Math.floor(input.atMs / 1_000);
    const bucket = this.buckets.get(bucketIndex) ?? newBucket();
    const latencyRaw = input.latencyMs ?? null;
    const hasLatency = latencyRaw !== null && Number.isFinite(latencyRaw) && latencyRaw >= 0;
    const latencyMs = hasLatency ? latencyRaw : null;
    const httpStatus =
      input.httpStatus !== null && input.httpStatus !== undefined && Number.isFinite(input.httpStatus)
        ? Math.floor(input.httpStatus)
        : null;
    const isSuccessHttp = httpStatus !== null && httpStatus >= 200 && httpStatus < 300;
    const isValidTick =
      httpStatus === null
        ? input.isValidTick === true
        : isSuccessHttp;

    bucket.count += 1;
    bucket.tickCount += isValidTick ? 1 : 0;
    if (latencyMs !== null) {
      bucket.latencySumMs += latencyMs;
      bucket.latencySamples += 1;
    }
    if (httpStatus === 429) {
      bucket.http429Count += 1;
      bucket.lastHttp429AtMs = input.atMs;
    }
    if (httpStatus !== null) {
      if (isSuccessHttp) {
        bucket.lastHttpSuccessAtMs = input.atMs;
      } else {
        bucket.lastHttpFailureAtMs = input.atMs;
      }
    }
    bucket.lastAtMs = bucket.lastAtMs === null ? input.atMs : Math.max(bucket.lastAtMs, input.atMs);
    if (isValidTick) {
      bucket.lastTickAtMs =
        bucket.lastTickAtMs === null ? input.atMs : Math.max(bucket.lastTickAtMs, input.atMs);
    }

    this.buckets.set(bucketIndex, bucket);
    this.startedAtMs = this.startedAtMs === null ? input.atMs : Math.min(this.startedAtMs, input.atMs);
    this.totalMessages += 1;
  }

  public snapshot(nowMs: number): FeedTelemetrySnapshot {
    if (!Number.isFinite(nowMs) || nowMs < 0) {
      return emptyFeedTelemetrySnapshot();
    }
    const currentBucket = Math.floor(nowMs / 1_000);
    const oldestBucket = currentBucket - (TELEMETRY_WINDOW_BUCKETS - 1);
    for (const key of this.buckets.keys()) {
      if (key < oldestBucket) {
        this.buckets.delete(key);
      }
    }

    let count = 0;
    let latencySumMs = 0;
    let latencySamples = 0;
    let http429Count = 0;
    let lastAtMs: number | null = null;
    let lastTickAtMs: number | null = null;
    let lastHttpSuccessAtMs: number | null = null;
    let lastHttpFailureAtMs: number | null = null;
    let lastHttp429AtMs: number | null = null;

    for (let index = oldestBucket; index <= currentBucket; index += 1) {
      const bucket = this.buckets.get(index);
      if (bucket === undefined) continue;
      count += bucket.count;
      latencySumMs += bucket.latencySumMs;
      latencySamples += bucket.latencySamples;
      http429Count += bucket.http429Count;
      lastAtMs = lastAtMs === null ? bucket.lastAtMs : maxNullable(lastAtMs, bucket.lastAtMs);
      lastTickAtMs = lastTickAtMs === null ? bucket.lastTickAtMs : maxNullable(lastTickAtMs, bucket.lastTickAtMs);
      lastHttpSuccessAtMs =
        lastHttpSuccessAtMs === null
          ? bucket.lastHttpSuccessAtMs
          : maxNullable(lastHttpSuccessAtMs, bucket.lastHttpSuccessAtMs);
      lastHttpFailureAtMs =
        lastHttpFailureAtMs === null
          ? bucket.lastHttpFailureAtMs
          : maxNullable(lastHttpFailureAtMs, bucket.lastHttpFailureAtMs);
      lastHttp429AtMs =
        lastHttp429AtMs === null
          ? bucket.lastHttp429AtMs
          : maxNullable(lastHttp429AtMs, bucket.lastHttp429AtMs);
    }

    return {
      startedAtMs: this.startedAtMs,
      totalMessages: this.totalMessages,
      messagesPerMinute: this.startedAtMs === null ? null : count,
      averageLatencyMs: latencySamples > 0 ? latencySumMs / latencySamples : null,
      latencySamples,
      lastMessageAtMs: lastAtMs,
      lastTickAtMs: lastTickAtMs,
      lastHttpSuccessAtMs,
      lastHttpFailureAtMs,
      lastHttp429AtMs,
      http429PerMinute: this.startedAtMs === null ? null : http429Count,
    };
  }
}

function maxNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function ageMsFrom(atMs: number | null, nowMs: number): number | null {
  if (atMs === null || !Number.isFinite(atMs) || atMs < 0 || !Number.isFinite(nowMs) || nowMs < atMs) {
    return null;
  }
  return nowMs - atMs;
}

export function getUsFeedSessionMode(nowMs: number): FeedSessionMode {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    return 'OUT_OF_SESSION';
  }
  const session = getMarketParts(Math.floor(nowMs / 1_000), 'EQUITY');
  const minutes = session.minutesOfDay;
  const isWeekday = session.weekday >= 1 && session.weekday <= 5;
  const isOpen =
    isWeekday &&
    ((minutes >= 9 * 60 + 30 && minutes < 16 * 60) ||
      (minutes >= 4 * 60 && minutes < 20 * 60));
  return isOpen ? 'IN_SESSION' : 'OUT_OF_SESSION';
}

/** Same explicit BYMA L2 window as the production BMB/IOL adapters: Mon-Fri 11:00-17:00 ART. */
export function getArFeedSessionMode(utcSec: number): FeedSessionMode {
  if (!Number.isInteger(utcSec) || utcSec < 0) {
    return 'OUT_OF_SESSION';
  }
  const parts = getBuenosAiresParts(utcSec);
  return parts.weekday >= 1 && parts.weekday <= 5 && parts.minutesOfDay >= 11 * 60 && parts.minutesOfDay < 17 * 60
    ? 'IN_SESSION'
    : 'OUT_OF_SESSION';
}

export interface MassiveKeySlotSafeStatus {
  readonly envName: string;
  readonly slotIndex: number;
  readonly poolSize: number;
}

export interface MassiveWsFeedDetails {
  readonly keySlot: MassiveKeySlotSafeStatus | null;
  readonly subscribedOptionQuotes: number;
  readonly lastWsMessageAgeMs: number | null;
}

export interface MassiveRestFeedDetails {
  readonly poolSize: number;
  readonly slots: readonly { readonly envName: string; readonly slotIndex: number }[];
  readonly lastSlotIndex: number | null;
  readonly roundRobinRequests: number;
  readonly http429PerMinute: number | null;
  readonly lastHttp429AgeMs: number | null;
}

export interface TradierFeedDetails {
  readonly sessionCreated: boolean;
  readonly reconnectAttempts: number;
}

export interface OratsCircuitBreakerDetails {
  readonly state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  readonly consecutiveFailures: number;
  readonly openedAtMs: number | null;
}

export interface OratsFeedDetails {
  readonly planTier: string | null;
  readonly quotaRemaining: number | null;
  readonly quotaLimit: number | null;
  readonly quotaResetAtUtcSec: number | null;
  readonly circuitBreaker: OratsCircuitBreakerDetails;
  readonly lastFetchAgeMs: number | null;
  readonly lastStatus: string | null;
}

export interface PrimaryFeedDetails {
  readonly authenticated: boolean;
  readonly tokenValidUntilUtcSec: number | null;
  readonly tokenRenewCount: number;
  readonly wsEnvironment: 'PRIMARY_MATRIZ_WS' | 'PRIMARY_ECO_XOMS_WS' | 'PRIMARY_REMARKETS_SANDBOX';
  /** Host REST conectado (p. ej. `api.eco.xoms.com.ar`); sin credenciales. */
  readonly apiUrl: string;
  readonly dlrSubscribedCount: number;
  readonly mervSubscribedCount: number;
  readonly liveDlrCount: number;
  readonly liveMervBookCount: number;
  readonly liveDlrLastUpdateAgeMs: number | null;
}

export interface BmbFeedDetails {
  readonly status: string;
  readonly orderBookCount: number;
  readonly caucionCount: number;
  readonly optionCount: number;
  readonly lastUpdateAgeMs: number | null;
}

export interface IolFeedDetails {
  readonly authMethod: 'PASSWORD' | 'REFRESH_TOKEN' | null;
  readonly passwordAuthCount: number;
  readonly refreshAuthCount: number;
  readonly tokenExpiresAtUtcSec: number | null;
  readonly lastAuthAtUtcSec: number | null;
  readonly quoteCount: number;
}

export interface FeedProviderHealth {
  readonly id: FeedProviderId;
  readonly region: 'US' | 'AR';
  readonly role: string;
  readonly state: FeedProviderState;
  readonly sessionMode: FeedSessionMode;
  readonly configured: boolean;
  readonly connected: boolean | null;
  readonly latencyMs: number | null;
  readonly latencyKind: FeedLatencyKind | null;
  readonly lastTickAgeMs: number | null;
  readonly messagesPerMinute: number | null;
  readonly lastError: string | null;
  readonly activeSymbolCount: number | null;
  readonly subscribedSymbols: readonly string[];
  readonly reconnectAction: FeedReconnectAction;
  readonly reconnectable: boolean;
  readonly massiveWs?: MassiveWsFeedDetails;
  readonly massiveRest?: MassiveRestFeedDetails;
  readonly tradier?: TradierFeedDetails;
  readonly orats?: OratsFeedDetails;
  readonly primary?: PrimaryFeedDetails;
  readonly bmb?: BmbFeedDetails;
  readonly iol?: IolFeedDetails;
}

export interface FeedsHealthSummary {
  readonly totalProviders: 7;
  readonly configuredCount: number;
  readonly activeCount: number;
  readonly degradedCount: number;
  readonly notConfiguredCount: number;
  readonly armedOutOfSessionCount: number;
}

export interface FeedsHealthSnapshot {
  readonly status: 'OK';
  readonly asOfUtcSec: number;
  readonly summary: FeedsHealthSummary;
  readonly providers: readonly FeedProviderHealth[];
}

export interface FeedsHealthPulseProvider {
  readonly id: FeedProviderId;
  readonly state: FeedProviderState;
  readonly sessionMode: FeedSessionMode;
  readonly latencyMs: number | null;
  readonly lastTickAgeMs: number | null;
  readonly messagesPerMinute: number | null;
}

export interface FeedsHealthPulse {
  readonly type: 'FEEDS_HEALTH_PULSE';
  readonly asOfUtcSec: number;
  readonly summary: FeedsHealthSummary;
  readonly providers: readonly FeedsHealthPulseProvider[];
}

export interface FeedReconnectResult {
  readonly provider: FeedProviderId;
  readonly action: FeedReconnectAction;
  readonly ok: boolean;
  readonly detail: string;
  readonly providerAfter: FeedProviderHealth | null;
}

const FEED_RECONNECT_ACTIONS: Readonly<Record<FeedProviderId, FeedReconnectAction>> = {
  MASSIVE_WS_STOCKS: 'RECONNECT',
  MASSIVE_REST_POOL: 'RESYNC',
  TRADIER_LIVE_WS: 'RECONNECT',
  ORATS_API: 'RESYNC',
  PRIMARY_REMARKETS_DLR: 'RECONNECT',
  BMB_HOMEBROKER_L2: 'RECONNECT',
  IOL_REST_V2: 'RECONNECT',
};

const ALL_FEED_PROVIDER_IDS: readonly FeedProviderId[] = [
  'MASSIVE_WS_STOCKS',
  'MASSIVE_REST_POOL',
  'TRADIER_LIVE_WS',
  'ORATS_API',
  'PRIMARY_REMARKETS_DLR',
  'BMB_HOMEBROKER_L2',
  'IOL_REST_V2',
];

function resolveState(input: {
  readonly configured: boolean;
  readonly connected: boolean | null;
  readonly sessionMode: FeedSessionMode;
}): FeedProviderState {
  if (!input.configured) return 'NOT_CONFIGURED';
  if (input.connected === true) return 'CONNECTED';
  if (input.sessionMode === 'OUT_OF_SESSION') return 'ARMED_OUT_OF_SESSION';
  return 'DEGRADED';
}

/**
 * Estado explícito del bridge Python BMB cuando el login requiere verificación
 * en dos pasos interactiva (SMS/App). Es informativo: no hay reintento automático
 * (evita bloquear la cuenta por intentos fallidos) y IOL_REST_V2 + Primary DLR
 * quedan como fuentes activas.
 */
export const BMB_STANDBY_2FA_STATUS = 'STANDBY_2FA' as const;

export function isBmbStandby2faStatus(status: string): boolean {
  return status === BMB_STANDBY_2FA_STATUS;
}

/**
 * Máquina de estados del proveedor BMB_HOMEBROKER_L2. `STANDBY_2FA` se
 * reconoce como estado informativo suave: DEGRADED en cualquier modo de sesión
 * (el feed no puede conectarse hasta que el usuario complete el 2FA
 * interactivo), sin degradar a ERROR ni saturar logs con reintentos.
 */
export function resolveBmbProviderState(input: {
  readonly configured: boolean;
  readonly connected: boolean | null;
  readonly sessionMode: FeedSessionMode;
  readonly healthStatus: string;
}): FeedProviderState {
  if (!input.configured) return 'NOT_CONFIGURED';
  if (input.connected === true) return 'CONNECTED';
  if (isBmbStandby2faStatus(input.healthStatus)) return 'DEGRADED';
  if (input.sessionMode === 'OUT_OF_SESSION') return 'ARMED_OUT_OF_SESSION';
  return 'DEGRADED';
}

/**
 * El 2FA interactivo en modo legacy no se reconecta automáticamente: evitar
 * bucles de login que podrían bloquear la cuenta. En modo SignalR Core
 * (BMB_HUB_TOKEN/BMB_SESSION_COOKIE) el bridge local soporta `POST /reconnect`
 * (202) con reinicio limpio del conector Python, por lo que SIEMPRE es
 * reconectable (incluidos CONNECTING, ERROR y STANDBY_2FA).
 */
export function isBmbProviderReconnectable(healthStatus: string, signalRMode: boolean): boolean {
  if (signalRMode) {
    return true;
  }
  return !isBmbStandby2faStatus(healthStatus);
}

/** Edad máxima del último mensaje recibido para considerar vivo el socket Massive (ms). */
export const MASSIVE_WS_LIVE_MESSAGE_MAX_AGE_MS = 5_000;

/**
 * Liveness del socket Massive de acciones (hotfix producción).
 *
 * El socket está vivo si el cliente reporta `ready`, o si el flujo demuestra
 * recepción: mensajes en la ventana móvil y último mensaje con edad menor a
 * `MASSIVE_WS_LIVE_MESSAGE_MAX_AGE_MS` (p. ej. 42 ms con 33.883 msg/min).
 * Así, una transición momentánea del estado del cliente (reconnecting) nunca
 * degrada al proveedor mientras el flujo esté vivo, y el timestamp de un tick
 * histórico individual no participa: la edad mide la recepción local del
 * último mensaje WebSocket, no la fecha del tick del proveedor.
 */
export function isMassiveWsSocketLive(input: {
  readonly connected: boolean;
  readonly messagesPerMinute: number | null;
  readonly lastMessageAgeMs: number | null;
}): boolean {
  if (input.connected) return true;
  return (
    input.messagesPerMinute !== null &&
    input.messagesPerMinute > 0 &&
    input.lastMessageAgeMs !== null &&
    input.lastMessageAgeMs < MASSIVE_WS_LIVE_MESSAGE_MAX_AGE_MS
  );
}

function countStates(providers: readonly FeedProviderHealth[]): FeedsHealthSummary {
  let configuredCount = 0;
  let activeCount = 0;
  let degradedCount = 0;
  let notConfiguredCount = 0;
  let armedOutOfSessionCount = 0;
  for (const provider of providers) {
    if (provider.state === 'CONNECTED') activeCount += 1;
    else if (provider.state === 'DEGRADED') degradedCount += 1;
    else if (provider.state === 'NOT_CONFIGURED') notConfiguredCount += 1;
    else armedOutOfSessionCount += 1;
    if (provider.configured) configuredCount += 1;
  }
  return {
    totalProviders: 7,
    configuredCount,
    activeCount,
    degradedCount,
    notConfiguredCount,
    armedOutOfSessionCount,
  };
}

function commonProvider(input: {
  readonly id: FeedProviderId;
  readonly region: 'US' | 'AR';
  readonly role: string;
  readonly configured: boolean;
  readonly connected: boolean | null;
  readonly sessionMode: FeedSessionMode;
  readonly telemetry: FeedTelemetrySnapshot;
  readonly latencyKind: FeedLatencyKind | null;
  readonly lastError: string | null;
  readonly activeSymbolCount: number | null;
  readonly subscribedSymbols: readonly string[];
  readonly reconnectable: boolean;
  readonly nowMs: number;
  readonly secrets: readonly string[];
}): FeedProviderHealth {
  return {
    id: input.id,
    region: input.region,
    role: input.role,
    state: resolveState({
      configured: input.configured,
      connected: input.connected,
      sessionMode: input.sessionMode,
    }),
    sessionMode: input.sessionMode,
    configured: input.configured,
    connected: input.connected,
    latencyMs: input.telemetry.averageLatencyMs,
    latencyKind: input.latencyKind,
    lastTickAgeMs: ageMsFrom(input.telemetry.lastTickAtMs, input.nowMs),
    messagesPerMinute: input.telemetry.messagesPerMinute,
    lastError: input.lastError === null ? null : redactSecrets(input.lastError, input.secrets),
    activeSymbolCount: input.activeSymbolCount,
    subscribedSymbols: [...input.subscribedSymbols],
    reconnectAction: FEED_RECONNECT_ACTIONS[input.id],
    reconnectable: input.reconnectable,
  };
}

export interface MassiveWsFeedHealthSource {
  readonly configured: boolean;
  readonly connected: boolean;
  readonly keySlot: MassiveKeySlotSafeStatus | null;
  readonly lastError: string | null;
  readonly telemetry: FeedTelemetrySnapshot;
  readonly subscribedSymbols: readonly string[];
  readonly activeSymbolCount: number;
  readonly subscribedOptionQuotes: number;
  readonly lastWsMessageAgeMs: number | null;
}

export interface MassiveRestFeedHealthSource {
  readonly configured: boolean;
  readonly poolSize: number;
  readonly slots: readonly { readonly envName: string; readonly slotIndex: number }[];
  readonly lastSlotIndex: number | null;
  readonly roundRobinRequests: number;
  readonly telemetry: FeedTelemetrySnapshot;
}

export interface TradierFeedHealthSource {
  readonly configured: boolean;
  readonly connected: boolean;
  readonly sessionCreated: boolean;
  readonly reconnectAttempts: number;
  readonly subscribedSymbols: readonly string[];
  readonly lastError: string | null;
  readonly telemetry: FeedTelemetrySnapshot;
}

export interface OratsFeedHealthSource {
  readonly configured: boolean;
  readonly connected: boolean | null;
  readonly lastFetchAtUtcSec: number | null;
  readonly lastStatus: string | null;
  readonly planTier: string | null;
  readonly quotaRemaining: number | null;
  readonly quotaLimit: number | null;
  readonly quotaResetAtUtcSec: number | null;
  readonly circuitBreaker: OratsCircuitBreakerDetails;
  readonly telemetry: FeedTelemetrySnapshot;
}

export interface PrimaryFeedHealthSource {
  readonly configured: boolean;
  readonly authenticated: boolean;
  readonly wsConnected: boolean;
  readonly tokenValidUntilUtcSec: number | null;
  readonly tokenRenewCount: number;
  readonly wsEnvironment: 'PRIMARY_MATRIZ_WS' | 'PRIMARY_ECO_XOMS_WS' | 'PRIMARY_REMARKETS_SANDBOX';
  readonly dlrSubscribedCount: number;
  /** Instrumentos BYMA (MERV) suscriptos al stream L2 de 5 puntas. */
  readonly mervSubscribedCount?: number;
  /** Libros MERV con puntas vivas en los snapshots WS. */
  readonly liveMervBookCount?: number;
  /** Host REST conectado (p. ej. `api.eco.xoms.com.ar`); sin credenciales. */
  readonly apiUrl?: string;
  readonly liveDlrCount: number;
  readonly liveDlrLastUpdateUtcSec: number | null;
  readonly lastError: string | null;
  readonly telemetry: FeedTelemetrySnapshot;
}

export interface BmbFeedHealthSource {
  readonly configured: boolean;
  readonly healthStatus: string;
  readonly connected: boolean;
  readonly lastUpdateUtcSec: number | null;
  readonly orderBookCount: number;
  readonly caucionCount: number;
  readonly optionCount: number;
  readonly lastError: string | null;
  /** Modo conector SignalR Core (`BMB_HUB_TOKEN`/`BMB_SESSION_COOKIE`): el
   * bridge local soporta `POST /reconnect` (202), nunca 501. */
  readonly signalRMode: boolean;
  readonly telemetry: FeedTelemetrySnapshot;
}

export interface IolFeedHealthSource {
  readonly configured: boolean;
  readonly connected: boolean;
  readonly authMethod: 'PASSWORD' | 'REFRESH_TOKEN' | null;
  readonly passwordAuthCount: number;
  readonly refreshAuthCount: number;
  readonly tokenExpiresAtUtcSec: number | null;
  readonly lastAuthAtUtcSec: number | null;
  readonly quoteCount: number;
  readonly lastError: string | null;
  readonly telemetry: FeedTelemetrySnapshot;
}

export interface FeedsHealthMonitorDeps {
  readonly getMassiveWs: () => MassiveWsFeedHealthSource;
  readonly getMassiveRest: () => MassiveRestFeedHealthSource;
  readonly getTradier: () => TradierFeedHealthSource;
  readonly getOrats: () => OratsFeedHealthSource;
  readonly getPrimary: () => PrimaryFeedHealthSource;
  readonly getBmb: () => BmbFeedHealthSource;
  readonly getIol: () => IolFeedHealthSource;
  readonly reconnectMassiveWs: () => Promise<string>;
  readonly resyncMassiveRest: () => Promise<string>;
  readonly reconnectTradier: () => Promise<string>;
  readonly resyncOrats: () => Promise<string>;
  readonly reconnectPrimary: () => Promise<string>;
  readonly reconnectBmb: () => Promise<string>;
  readonly reconnectIol: () => Promise<string>;
  readonly nowMsFn?: () => number;
  readonly secrets?: readonly string[];
}

export class FeedsHealthMonitor {
  private readonly deps: FeedsHealthMonitorDeps;
  private readonly nowMsFn: () => number;
  private readonly secrets: readonly string[];

  public constructor(deps: FeedsHealthMonitorDeps) {
    this.deps = deps;
    this.nowMsFn = deps.nowMsFn ?? (() => Date.now());
    this.secrets = deps.secrets ?? [];
  }

  public getSnapshot(): FeedsHealthSnapshot {
    const nowMs = this.nowMsFn();
    const usSession = getUsFeedSessionMode(nowMs);
    const arSession = getArFeedSessionMode(Math.floor(nowMs / 1_000));

    const massiveWs = this.deps.getMassiveWs();
    const massiveRest = this.deps.getMassiveRest();
    const tradier = this.deps.getTradier();
    const orats = this.deps.getOrats();
    const primary = this.deps.getPrimary();
    const bmb = this.deps.getBmb();
    const iol = this.deps.getIol();

    const massiveWsSocketLive = isMassiveWsSocketLive({
      connected: massiveWs.connected,
      messagesPerMinute: massiveWs.telemetry.messagesPerMinute,
      lastMessageAgeMs: massiveWs.lastWsMessageAgeMs,
    });

    const massiveWsProvider: FeedProviderHealth = {
      ...commonProvider({
        id: 'MASSIVE_WS_STOCKS',
        region: 'US',
        role: 'Spot NBBO / Trades US',
        configured: massiveWs.configured,
        connected: massiveWsSocketLive,
        sessionMode: usSession,
        telemetry: massiveWs.telemetry,
        latencyKind: 'PROVIDER_EVENT_AGE',
        lastError: massiveWs.lastError,
        activeSymbolCount: massiveWs.activeSymbolCount,
        subscribedSymbols: massiveWs.subscribedSymbols,
        reconnectable: true,
        nowMs,
        secrets: this.secrets,
      }),
      massiveWs: {
        keySlot: massiveWs.keySlot,
        subscribedOptionQuotes: massiveWs.subscribedOptionQuotes,
        lastWsMessageAgeMs: massiveWs.lastWsMessageAgeMs,
      },
    };

    const massiveRestProvider: FeedProviderHealth = {
      ...commonProvider({
        id: 'MASSIVE_REST_POOL',
        region: 'US',
        role: 'REST Loaders US / Batch',
        configured: massiveRest.configured,
        connected: massiveRest.telemetry.lastHttpSuccessAtMs !== null,
        sessionMode: usSession,
        telemetry: massiveRest.telemetry,
        latencyKind: 'HTTP_ROUND_TRIP',
        lastError: null,
        activeSymbolCount: null,
        subscribedSymbols: [],
        reconnectable: true,
        nowMs,
        secrets: this.secrets,
      }),
      massiveRest: {
        poolSize: massiveRest.poolSize,
        slots: [...massiveRest.slots],
        lastSlotIndex: massiveRest.lastSlotIndex,
        roundRobinRequests: massiveRest.roundRobinRequests,
        http429PerMinute: massiveRest.telemetry.http429PerMinute,
        lastHttp429AgeMs: ageMsFrom(massiveRest.telemetry.lastHttp429AtMs, nowMs),
      },
    };

    const tradierProvider: FeedProviderHealth = {
      ...commonProvider({
        id: 'TRADIER_LIVE_WS',
        region: 'US',
        role: 'Opciones Live + Griegas',
        configured: tradier.configured,
        connected: tradier.connected,
        sessionMode: usSession,
        telemetry: tradier.telemetry,
        latencyKind: 'PROVIDER_EVENT_AGE',
        lastError: tradier.lastError,
        activeSymbolCount: tradier.subscribedSymbols.length,
        subscribedSymbols: tradier.subscribedSymbols,
        reconnectable: true,
        nowMs,
        secrets: this.secrets,
      }),
      tradier: {
        sessionCreated: tradier.sessionCreated,
        reconnectAttempts: tradier.reconnectAttempts,
      },
    };

    const oratsProvider: FeedProviderHealth = {
      ...commonProvider({
        id: 'ORATS_API',
        region: 'US',
        role: 'Superficie de Volatilidad',
        configured: orats.configured,
        connected: orats.connected,
        sessionMode: usSession,
        telemetry: orats.telemetry,
        latencyKind: 'HTTP_ROUND_TRIP',
        lastError: orats.lastStatus === null ? null : `ORATS_STATUS_${orats.lastStatus}`,
        activeSymbolCount: null,
        subscribedSymbols: [],
        reconnectable: true,
        nowMs,
        secrets: this.secrets,
      }),
      orats: {
        planTier: orats.planTier,
        quotaRemaining: orats.quotaRemaining,
        quotaLimit: orats.quotaLimit,
        quotaResetAtUtcSec: orats.quotaResetAtUtcSec,
        circuitBreaker: orats.circuitBreaker,
        lastFetchAgeMs: ageMsFrom(
          orats.lastFetchAtUtcSec === null ? null : orats.lastFetchAtUtcSec * 1_000,
          nowMs,
        ),
        lastStatus: orats.lastStatus,
      },
    };

    const primaryProvider: FeedProviderHealth = {
      ...commonProvider({
        id: 'PRIMARY_REMARKETS_DLR',
        region: 'AR',
        role: 'Futuros DLR/* outright + BYMA L2 5 Puntas',
        configured: primary.configured,
        connected: primary.authenticated && primary.wsConnected,
        sessionMode: arSession,
        telemetry: primary.telemetry,
        latencyKind: 'PROVIDER_EVENT_AGE',
        lastError: primary.lastError,
        activeSymbolCount: primary.dlrSubscribedCount + (primary.mervSubscribedCount ?? 0),
        subscribedSymbols: [],
        reconnectable: true,
        nowMs,
        secrets: this.secrets,
      }),
      primary: {
        authenticated: primary.authenticated,
        tokenValidUntilUtcSec: primary.tokenValidUntilUtcSec,
        tokenRenewCount: primary.tokenRenewCount,
        wsEnvironment: primary.wsEnvironment,
        apiUrl: primary.apiUrl ?? '',
        dlrSubscribedCount: primary.dlrSubscribedCount,
        mervSubscribedCount: primary.mervSubscribedCount ?? 0,
        liveDlrCount: primary.liveDlrCount,
        liveMervBookCount: primary.liveMervBookCount ?? 0,
        liveDlrLastUpdateAgeMs: ageMsFrom(
          primary.liveDlrLastUpdateUtcSec === null ? null : primary.liveDlrLastUpdateUtcSec * 1_000,
          nowMs,
        ),
      },
    };

    const bmbProvider: FeedProviderHealth = {
      ...commonProvider({
        id: 'BMB_HOMEBROKER_L2',
        region: 'AR',
        role: 'L2 5 Puntas BYMA',
        configured: bmb.configured,
        connected: bmb.connected,
        sessionMode: arSession,
        telemetry: bmb.telemetry,
        latencyKind: 'HTTP_ROUND_TRIP',
        lastError: bmb.lastError,
        activeSymbolCount: bmb.orderBookCount,
        subscribedSymbols: [],
        reconnectable: isBmbProviderReconnectable(bmb.healthStatus, bmb.signalRMode),
        nowMs,
        secrets: this.secrets,
      }),
      state: resolveBmbProviderState({
        configured: bmb.configured,
        connected: bmb.connected,
        sessionMode: arSession,
        healthStatus: bmb.healthStatus,
      }),
      bmb: {
        status: bmb.healthStatus,
        orderBookCount: bmb.orderBookCount,
        caucionCount: bmb.caucionCount,
        optionCount: bmb.optionCount,
        lastUpdateAgeMs: ageMsFrom(
          bmb.lastUpdateUtcSec === null ? null : bmb.lastUpdateUtcSec * 1_000,
          nowMs,
        ),
      },
    };

    const iolProvider: FeedProviderHealth = {
      ...commonProvider({
        id: 'IOL_REST_V2',
        region: 'AR',
        role: 'L1 REST / Failover',
        configured: iol.configured,
        connected: iol.connected,
        sessionMode: arSession,
        telemetry: iol.telemetry,
        latencyKind: 'HTTP_ROUND_TRIP',
        lastError: iol.lastError,
        activeSymbolCount: iol.quoteCount,
        subscribedSymbols: [],
        reconnectable: true,
        nowMs,
        secrets: this.secrets,
      }),
      iol: {
        authMethod: iol.authMethod,
        passwordAuthCount: iol.passwordAuthCount,
        refreshAuthCount: iol.refreshAuthCount,
        tokenExpiresAtUtcSec: iol.tokenExpiresAtUtcSec,
        lastAuthAtUtcSec: iol.lastAuthAtUtcSec,
        quoteCount: iol.quoteCount,
      },
    };

    const providers: readonly FeedProviderHealth[] = [
      massiveWsProvider,
      massiveRestProvider,
      tradierProvider,
      oratsProvider,
      primaryProvider,
      bmbProvider,
      iolProvider,
    ];
    return {
      status: 'OK',
      asOfUtcSec: Math.floor(nowMs / 1_000),
      summary: countStates(providers),
      providers,
    };
  }

  public getPulse(): FeedsHealthPulse {
    const snapshot = this.getSnapshot();
    return {
      type: 'FEEDS_HEALTH_PULSE',
      asOfUtcSec: snapshot.asOfUtcSec,
      summary: snapshot.summary,
      providers: snapshot.providers.map((provider) => ({
        id: provider.id,
        state: provider.state,
        sessionMode: provider.sessionMode,
        latencyMs: provider.latencyMs,
        lastTickAgeMs: provider.lastTickAgeMs,
        messagesPerMinute: provider.messagesPerMinute,
      })),
    };
  }

  public isKnownProvider(provider: string): provider is FeedProviderId {
    return (ALL_FEED_PROVIDER_IDS as readonly string[]).includes(provider);
  }

  public async reconnect(provider: FeedProviderId): Promise<FeedReconnectResult> {
    let detail: string;
    try {
      switch (provider) {
        case 'MASSIVE_WS_STOCKS':
          detail = await this.deps.reconnectMassiveWs();
          break;
        case 'MASSIVE_REST_POOL':
          detail = await this.deps.resyncMassiveRest();
          break;
        case 'TRADIER_LIVE_WS':
          detail = await this.deps.reconnectTradier();
          break;
        case 'ORATS_API':
          detail = await this.deps.resyncOrats();
          break;
        case 'PRIMARY_REMARKETS_DLR':
          detail = await this.deps.reconnectPrimary();
          break;
        case 'BMB_HOMEBROKER_L2':
          detail = await this.deps.reconnectBmb();
          break;
        case 'IOL_REST_V2':
          detail = await this.deps.reconnectIol();
          break;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        provider,
        action: FEED_RECONNECT_ACTIONS[provider],
        ok: false,
        detail: redactSecrets(message, this.secrets),
        providerAfter: null,
      };
    }
    const safeDetail = redactSecrets(detail, this.secrets);
    return {
      provider,
      action: FEED_RECONNECT_ACTIONS[provider],
      ok: true,
      detail: safeDetail,
      providerAfter: this.getSnapshot().providers.find((item) => item.id === provider) ?? null,
    };
  }
}
