import type { OratsMetadata } from '../../../src/core/oratsIntegrity.js';
import { useEffect, useSyncExternalStore } from 'react';
import { isDocumentVisible, subscribeDocumentVisibility } from './visibilityLifecycle';

/* ============================================================================
   1. CONTRATO WIRE (ESPEJO DEL ENDPOINT SIN SECRETOS)
   ============================================================================ */
export type FeedProviderId =
  | 'MASSIVE_WS_STOCKS'
  | 'MASSIVE_REST_POOL'
  | 'TRADIER_LIVE_WS'
  | 'FMP_ENTERPRISE_REST'
  | 'ORATS_API'
  | 'PRIMARY_REMARKETS_DLR'
  | 'BMB_HOMEBROKER_L2'
  | 'IOL_REST_V2';

export type FeedProviderState =
  | 'CONNECTED'
  | 'ARMED_OUT_OF_SESSION'
  | 'STANDBY_TRADIER_FMP_PRIMARY'
  | 'AUTH_INVALID'
  | 'DEGRADED'
  | 'NOT_CONFIGURED';

export type FeedSessionMode = 'IN_SESSION' | 'OUT_OF_SESSION';

export type FeedLatencyKind = 'PROVIDER_EVENT_AGE' | 'HTTP_ROUND_TRIP';

interface MassiveKeySlotSafeStatus {
  readonly envName: string;
  readonly slotIndex: number;
  readonly poolSize: number;
}

interface MassiveWsFeedDetails {
  readonly keySlot: MassiveKeySlotSafeStatus | null;
  readonly subscribedOptionQuotes: number;
  readonly lastWsMessageAgeMs: number | null;
}

interface MassiveRestFeedDetails {
  readonly poolSize: number;
  readonly slots: readonly { readonly envName: string; readonly slotIndex: number }[];
  readonly lastSlotIndex: number | null;
  readonly roundRobinRequests: number;
  readonly http429PerMinute: number | null;
  readonly lastHttp429AgeMs: number | null;
}

interface TradierFeedDetails {
  readonly sessionCreated: boolean;
  readonly reconnectAttempts: number;
  readonly environment: 'LIVE' | 'SANDBOX';
  readonly restBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly authInvalid?: boolean;
}

interface OratsCircuitBreakerDetails {
  readonly state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  readonly consecutiveFailures: number;
  readonly openedAtMs: number | null;
}

interface OratsFeedDetails extends Pick<OratsMetadata, 'endpoints' | 'healthStatus' | 'providerTradeDate'> {
  readonly planTier: string | null;
  readonly quotaRemaining: number | null;
  readonly quotaLimit: number | null;
  readonly quotaResetAtUtcSec: number | null;
  readonly circuitBreaker: OratsCircuitBreakerDetails;
  readonly lastFetchAgeMs: number | null;
  readonly lastStatus: string | null;
}

interface PrimaryFeedDetails {
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

interface BmbFeedDetails {
  readonly status: string;
  readonly orderBookCount: number;
  readonly caucionCount: number;
  readonly optionCount: number;
  readonly lastUpdateAgeMs: number | null;
}

interface IolFeedDetails {
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
  readonly reconnectAction: 'RECONNECT' | 'RESYNC';
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
  readonly totalProviders: number;
  readonly configuredCount: number;
  readonly activeCount: number;
  readonly degradedCount: number;
  readonly notConfiguredCount: number;
  readonly armedOutOfSessionCount: number;
  readonly standbyCount?: number;
  readonly authInvalidCount?: number;
}

export interface FeedsHealthSnapshot {
  readonly status: 'OK';
  readonly asOfUtcSec: number;
  readonly summary: FeedsHealthSummary;
  readonly providers: readonly FeedProviderHealth[];
}

interface FeedsHealthPulseProvider {
  readonly id: FeedProviderId;
  readonly state: FeedProviderState;
  readonly sessionMode: FeedSessionMode;
  readonly latencyMs: number | null;
  readonly lastTickAgeMs: number | null;
  readonly messagesPerMinute: number | null;
}

interface FeedsHealthPulse {
  readonly type: 'FEEDS_HEALTH_PULSE';
  readonly asOfUtcSec: number;
  readonly summary: FeedsHealthSummary;
  readonly providers: readonly FeedsHealthPulseProvider[];
}

interface FeedReconnectResult {
  readonly provider: FeedProviderId;
  readonly action: 'RECONNECT' | 'RESYNC';
  readonly ok: boolean;
  readonly detail: string;
  readonly providerAfter: FeedProviderHealth | null;
}

export type FeedsHealthSocketStatus = 'CONNECTING' | 'LIVE' | 'RECONNECTING' | 'ERROR';

/* ============================================================================
   2. NORMALIZACIÓN ESTRICTA DE PULSOS
   ============================================================================ */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFeedProviderId(value: unknown): value is FeedProviderId {
  return (
    value === 'MASSIVE_WS_STOCKS' ||
    value === 'MASSIVE_REST_POOL' ||
    value === 'TRADIER_LIVE_WS' ||
    value === 'FMP_ENTERPRISE_REST' ||
    value === 'ORATS_API' ||
    value === 'PRIMARY_REMARKETS_DLR' ||
    value === 'BMB_HOMEBROKER_L2' ||
    value === 'IOL_REST_V2'
  );
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegativeInt(value: unknown): number | null {
  const parsed = nullableNumber(value);
  return parsed !== null && Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parsePulse(raw: unknown): FeedsHealthPulse | null {
  if (!isRecord(raw) || raw['type'] !== 'FEEDS_HEALTH_PULSE' || !Array.isArray(raw['providers'])) {
    return null;
  }
  const summaryRaw = isRecord(raw['summary']) ? raw['summary'] : null;
  if (summaryRaw === null) return null;
  const providers: FeedsHealthPulseProvider[] = [];
  for (const rawProvider of raw['providers']) {
    if (!isRecord(rawProvider) || !isFeedProviderId(rawProvider['id'])) continue;
    providers.push({
      id: rawProvider['id'],
      state: rawProvider['state'] === 'CONNECTED'
        ? 'CONNECTED'
        : rawProvider['state'] === 'ARMED_OUT_OF_SESSION'
          ? 'ARMED_OUT_OF_SESSION'
          : rawProvider['state'] === 'STANDBY_TRADIER_FMP_PRIMARY'
            ? 'STANDBY_TRADIER_FMP_PRIMARY'
            : rawProvider['state'] === 'AUTH_INVALID'
              ? 'AUTH_INVALID'
              : rawProvider['state'] === 'NOT_CONFIGURED'
                ? 'NOT_CONFIGURED'
                : 'DEGRADED',
      sessionMode: rawProvider['sessionMode'] === 'IN_SESSION' ? 'IN_SESSION' : 'OUT_OF_SESSION',
      latencyMs: nullableNumber(rawProvider['latencyMs']),
      lastTickAgeMs: nullableNumber(rawProvider['lastTickAgeMs']),
      messagesPerMinute: nullableNumber(rawProvider['messagesPerMinute']),
    });
  }
  const asOfUtcSec = nonNegativeInt(raw['asOfUtcSec']);
  if (asOfUtcSec === null) return null;
  return {
    type: 'FEEDS_HEALTH_PULSE',
    asOfUtcSec,
    summary: {
      totalProviders: nonNegativeInt(summaryRaw['totalProviders']) ?? 8,
      configuredCount: nonNegativeInt(summaryRaw['configuredCount']) ?? 0,
      activeCount: nonNegativeInt(summaryRaw['activeCount']) ?? 0,
      degradedCount: nonNegativeInt(summaryRaw['degradedCount']) ?? 0,
      notConfiguredCount: nonNegativeInt(summaryRaw['notConfiguredCount']) ?? 0,
      armedOutOfSessionCount: nonNegativeInt(summaryRaw['armedOutOfSessionCount']) ?? 0,
      standbyCount: nonNegativeInt(summaryRaw['standbyCount']) ?? 0,
      authInvalidCount: nonNegativeInt(summaryRaw['authInvalidCount']) ?? 0,
    },
    providers,
  };
}

function mergePulse(previous: FeedsHealthSnapshot, pulse: FeedsHealthPulse): FeedsHealthSnapshot {
  const byId = new Map(pulse.providers.map((provider) => [provider.id, provider]));
  return {
    status: 'OK',
    asOfUtcSec: pulse.asOfUtcSec,
    summary: pulse.summary,
    providers: previous.providers.map((provider) => {
      const next = byId.get(provider.id);
      if (next === undefined) return provider;
      return {
        ...provider,
        state: next.state,
        sessionMode: next.sessionMode,
        latencyMs: next.latencyMs,
        lastTickAgeMs: next.lastTickAgeMs,
        messagesPerMinute: next.messagesPerMinute,
      };
    }),
  };
}

/* ============================================================================
   3. STORE / HOOK: GET INICIAL + CANAL WS DEDICADO (SIN POLLING HTTP)
   ============================================================================ */
export interface FeedsHealthState {
  readonly snapshot: FeedsHealthSnapshot | null;
  readonly socketStatus: FeedsHealthSocketStatus;
  readonly lastPulseAtMs: number | null;
  readonly reconnectingProvider: FeedProviderId | null;
  readonly lastReconnectDetail: string | null;
  readonly lastReconnectOk: boolean | null;
}

function feedsHealthSocketUrl(): string {
  if (import.meta.env.DEV) return 'ws://127.0.0.1:8787/ws?channel=feeds-health';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws?channel=feeds-health`;
}

const emptyFeedsHealth: FeedsHealthState = Object.freeze({
  snapshot: null, socketStatus: 'CONNECTING', lastPulseAtMs: null,
  reconnectingProvider: null, lastReconnectDetail: null, lastReconnectOk: null,
});
type ConnectivityProvider = Pick<FeedProviderHealth, 'id' | 'state' | 'configured'>;

export interface FeedsBadgeSummary {
  readonly socketStatus: FeedsHealthSocketStatus;
  readonly pulseFresh: boolean;
  readonly activeCount: number | null;
  readonly configuredCount: number | null;
  readonly totalProviders: number | null;
}

const feedsHealthStore = {
  state: emptyFeedsHealth,
  full: new Set<() => void>(),
  connectivity: new Set<() => void>(),
  badge: new Set<() => void>(),
};
let connectivityProviders: readonly ConnectivityProvider[] = Object.freeze([]);
let connectivitySignature = '';
let badgeSummary: FeedsBadgeSummary = {
  socketStatus: 'CONNECTING', pulseFresh: false, activeCount: null, configuredCount: null, totalProviders: null,
};
const PULSE_FRESH_MS = 15_000;
let pulseTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;
let stopVisibility: (() => void) | undefined;
let connectionScope: AbortController | undefined;
let socket: WebSocket | undefined;
let connectionUsers = 0;
let reconnectGeneration = 0;

function publishFeedsHealth(patch: Partial<FeedsHealthState>): void {
  const previous = feedsHealthStore.state;
  const fullChanged = Object.entries(patch).some(([key, value]) => Reflect.get(previous, key) !== value);
  const next = fullChanged ? { ...previous, ...patch } : previous;
  feedsHealthStore.state = next;

  const providers = next.snapshot?.providers ?? [];
  const signature = providers.map(({ id, state, configured }) => `${id}:${state}:${configured}`).sort().join('|');
  const connectivityChanged = connectivitySignature !== signature;
  if (connectivityChanged) {
    connectivitySignature = signature;
    connectivityProviders = providers.map(({ id, state, configured }) => ({ id, state, configured }));
  }
  const pulseFresh = next.lastPulseAtMs !== null && Date.now() - next.lastPulseAtMs < PULSE_FRESH_MS;
  const summary = pulseFresh ? next.snapshot?.summary : undefined;
  const activeCount = summary?.activeCount ?? null;
  const configuredCount = summary?.configuredCount ?? null;
  const totalProviders = summary?.totalProviders ?? null;
  const badgeChanged = badgeSummary.socketStatus !== next.socketStatus || badgeSummary.pulseFresh !== pulseFresh ||
    badgeSummary.activeCount !== activeCount || badgeSummary.configuredCount !== configuredCount ||
    badgeSummary.totalProviders !== totalProviders;
  if (badgeChanged) badgeSummary = { socketStatus: next.socketStatus, pulseFresh, activeCount, configuredCount, totalProviders };
  if (!isDocumentVisible()) return;
  if (connectivityChanged) feedsHealthStore.connectivity.forEach((listener) => listener());
  if (badgeChanged) feedsHealthStore.badge.forEach((listener) => listener());
  if (fullChanged) feedsHealthStore.full.forEach((listener) => listener());
}

async function refreshFeedsHealth(): Promise<void> {
  const signal = connectionScope?.signal;
  if (signal === undefined || signal.aborted) return;
  const response = await fetch('/api/system/feeds-health', {
    headers: { accept: 'application/json' },
    cache: 'no-store',
    signal,
  });
  if (!response.ok) throw new Error(`feeds-health HTTP ${String(response.status)}`);
  const raw: unknown = await response.json();
  if (signal.aborted) return;
  if (!isRecord(raw) || !Array.isArray(raw['providers'])) throw new Error('Invalid feeds-health payload');
  const snapshot = raw as unknown as FeedsHealthSnapshot;
  const previous = feedsHealthStore.state.snapshot;
  if (previous === null || previous.asOfUtcSec <= snapshot.asOfUtcSec) publishFeedsHealth({ snapshot });
}

function connectFeedsSocket(signal: AbortSignal): void {
  if (signal.aborted) return;
  let next: WebSocket;
  try {
    next = new WebSocket(feedsHealthSocketUrl());
  } catch {
    publishFeedsHealth({ socketStatus: 'ERROR' });
    return;
  }
  socket = next;
  const isCurrent = () => !signal.aborted && socket === next;
  next.addEventListener('open', () => {
    if (isCurrent()) publishFeedsHealth({ socketStatus: 'LIVE' });
  });
  next.addEventListener('message', (event: MessageEvent) => {
    if (!isCurrent() || typeof event.data !== 'string') return;
    try {
      const pulse = parsePulse(JSON.parse(event.data) as unknown);
      if (pulse === null) return;
      const previous = feedsHealthStore.state.snapshot;
      publishFeedsHealth({
        lastPulseAtMs: Date.now(),
        snapshot: previous === null ? null : mergePulse(previous, pulse),
      });
      if (pulseTimer !== undefined) clearTimeout(pulseTimer);
      pulseTimer = setTimeout(() => {
        pulseTimer = undefined;
        publishFeedsHealth({});
      }, PULSE_FRESH_MS);
    } catch {
      // Ignora mensajes ajenos al contrato del pulso.
    }
  });
  next.addEventListener('close', () => {
    if (!isCurrent()) return;
    socket = undefined;
    publishFeedsHealth({ socketStatus: 'RECONNECTING' });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connectFeedsSocket(signal);
    }, 2_000);
  });
  next.addEventListener('error', () => next.close());
}

function stopFeedsConnection(): void {
  connectionScope?.abort();
  connectionScope = undefined;
  if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
  if (pulseTimer !== undefined) clearTimeout(pulseTimer);
  reconnectTimer = undefined;
  pulseTimer = undefined;
  socket?.close();
  socket = undefined;
}

function startFeedsConnection(): void {
  if (connectionScope !== undefined) return;
  const controller = new AbortController();
  connectionScope = controller;
  publishFeedsHealth({ socketStatus: 'CONNECTING', lastPulseAtMs: null });
  void refreshFeedsHealth().catch(() => {
    if (!controller.signal.aborted && feedsHealthStore.state.socketStatus !== 'LIVE') {
      publishFeedsHealth({ socketStatus: 'ERROR' });
    }
  });
  connectFeedsSocket(controller.signal);
}

export function acquireFeedsHealthConnection(): () => void {
  connectionUsers += 1;
  if (releaseTimer !== undefined) clearTimeout(releaseTimer);
  releaseTimer = undefined;
  if (stopVisibility === undefined) {
    stopVisibility = subscribeDocumentVisibility((visible) => {
      if (visible) {
        startFeedsConnection();
        feedsHealthStore.connectivity.forEach((listener) => listener());
        feedsHealthStore.badge.forEach((listener) => listener());
        feedsHealthStore.full.forEach((listener) => listener());
      } else stopFeedsConnection();
    });
    if (isDocumentVisible()) startFeedsConnection();
  }
  let acquired = true;
  return () => {
    if (!acquired) return;
    acquired = false;
    connectionUsers -= 1;
    if (connectionUsers !== 0) return;
    releaseTimer = setTimeout(() => {
      releaseTimer = undefined;
      stopVisibility?.();
      stopVisibility = undefined;
      stopFeedsConnection();
    }, 150);
  };
}

export function useFeedsHealthConnection(): void {
  useEffect(acquireFeedsHealthConnection, []);
}

export async function reconnectProvider(provider: FeedProviderId): Promise<void> {
  const generation = ++reconnectGeneration;
  publishFeedsHealth({ reconnectingProvider: provider });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_500);
  try {
    const response = await fetch('/api/system/feeds-reconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ provider }),
      signal: controller.signal,
    });
    const raw: unknown = await response.json().catch(() => null);
    if (generation !== reconnectGeneration) return;
    if (!response.ok) {
      const detail = isRecord(raw) && typeof raw['detail'] === 'string' ? raw['detail'] : `HTTP ${String(response.status)}`;
      publishFeedsHealth({ lastReconnectOk: false, lastReconnectDetail: detail });
      return;
    }
    const result = raw as FeedReconnectResult;
    publishFeedsHealth({ lastReconnectOk: Boolean(result.ok), lastReconnectDetail: result.detail });
    void refreshFeedsHealth().catch(() => undefined);
  } catch (error) {
    if (generation === reconnectGeneration) {
      publishFeedsHealth({ lastReconnectOk: false, lastReconnectDetail: error instanceof Error ? error.message : String(error) });
    }
  } finally {
    clearTimeout(timeout);
    if (generation === reconnectGeneration) publishFeedsHealth({ reconnectingProvider: null });
  }
}

export function subscribeFeedsHealth(
  channel: 'full' | 'connectivity' | 'badge',
  listener: () => void,
): () => void {
  const registered = feedsHealthStore[channel];
  registered.add(listener);
  return () => { registered.delete(listener); };
}

const subscribeConnectivity = (listener: () => void) => subscribeFeedsHealth('connectivity', listener);
const subscribeBadge = (listener: () => void) => subscribeFeedsHealth('badge', listener);
const subscribeFull = (listener: () => void) => subscribeFeedsHealth('full', listener);
const subscribeClosed = () => () => undefined;
const readConnectivity = () => connectivityProviders;
const readBadge = () => badgeSummary;
const readFull = () => feedsHealthStore.state;
const readClosed = () => emptyFeedsHealth;

export function useGlobalConnectivityProviders(): readonly ConnectivityProvider[] {
  return useSyncExternalStore(subscribeConnectivity, readConnectivity, readConnectivity);
}

export function useFeedsBadgeSummary(): FeedsBadgeSummary {
  return useSyncExternalStore(subscribeBadge, readBadge, readBadge);
}

export function useFeedsHealthDrawerState(open: boolean): FeedsHealthState {
  const read = open ? readFull : readClosed;
  return useSyncExternalStore(open ? subscribeFull : subscribeClosed, read, read);
}
