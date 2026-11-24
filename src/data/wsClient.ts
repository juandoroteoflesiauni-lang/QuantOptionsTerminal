import { parseWsJsonPayload } from './liveBarConsolidator.js';
import { redact, toErrorMessage } from './normalizeShared.js';
import type { SleepFn } from './types.js';
import {
  DEFAULT_CONNECTION_LIMIT_COOLDOWN_MS,
  DEFAULT_MAX_RECONNECT_BACKOFF_MS,
  DEFAULT_WS_MAX_QUEUE_SIZE,
  MIN_RECONNECT_BACKOFF_MS,
  OPTIONS_MAX_QUOTE_SUBSCRIPTIONS,
  WS_CLUSTER_URLS,
  type MassiveWsClientOptions,
  type WsCircuitBreakerReason,
  type WsClientError,
  type WsClientSnapshot,
  type WsCluster,
  type WsConnectionState,
  type WsNormalizedEvent,
  type WsSocketFactory,
  type WsSocketLike,
} from './wsTypes.js';

const DEFAULT_BASE_RECONNECT_BACKOFF_MS = 15_000;
const SUBSCRIBE_CHUNK_SIZE = 50;

const CONNECTION_LIMIT_PATTERN =
  /\b(?:max[_\s-]*connections?|connection[_\s-]*limit|maximum\s+(?:number\s+of\s+)?(?:concurrent\s+)?connections?|too\s+many\s+(?:concurrent\s+)?connections?|connections?\s+(?:limit\s+)?exceeded|concurrent\s+connections?)\b/i;

export function isConnectionLimitMessage(text: string): boolean {
  return CONNECTION_LIMIT_PATTERN.test(text);
}

interface NativeWebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data?: unknown }) => void) | null;
  onclose: ((event: { readonly code?: number; readonly reason?: string; readonly wasClean?: boolean }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

function createRuntimeSocketFactory(): WsSocketFactory {
  return (url: string): WsSocketLike => {
    const ctor = Reflect.get(globalThis, 'WebSocket') as
      | (new (targetUrl: string) => NativeWebSocketLike)
      | undefined;

    if (typeof ctor !== 'function') {
      throw new Error(
        'No global WebSocket implementation available in this runtime; inject socketFactory explicitly.',
      );
    }

    const ws = new ctor(url);
    const wrapper: WsSocketLike = {
      send: (data: string) => {
        ws.send(data);
      },
      close: (code?: number, reason?: string) => {
        ws.close(code, reason);
      },
      onOpen: null,
      onMessage: null,
      onClose: null,
      onError: null,
    };

    ws.onopen = () => {
      wrapper.onOpen?.();
    };
    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        wrapper.onMessage?.(event.data);
      }
    };
    ws.onclose = (event) => {
      wrapper.onClose?.({
        code: typeof event.code === 'number' ? event.code : 1006,
        reason: typeof event.reason === 'string' ? event.reason : '',
        wasClean: Boolean(event.wasClean),
      });
    };
    ws.onerror = (event) => {
      wrapper.onError?.(event);
    };

    return wrapper;
  };
}

/** Parses string or string-array subscriptions into trimmed, unique channel tokens preserving order. */
export function parseChannelSubscriptions(
  input: string | readonly string[] | undefined,
): string[] {
  if (input === undefined) {
    return [];
  }

  const rawList = Array.isArray(input) ? input : [input];
  const seen = new Set<string>();
  const channels: string[] = [];

  for (const entry of rawList) {
    if (typeof entry !== 'string') {
      throw new TypeError('Subscription entries must be strings');
    }
    for (const part of entry.split(',')) {
      const token = part.trim();
      if (token.length === 0) {
        continue;
      }
      if (/\s/.test(token)) {
        throw new Error(`Invalid subscription channel containing whitespace: "${token}"`);
      }
      if (!seen.has(token)) {
        seen.add(token);
        channels.push(token);
      }
    }
  }

  return channels;
}

/** Splits a Massive WS channel like `Q.O:SPY261218C00600000` into `{ prefix, target }`. */
function splitChannel(channel: string): { readonly prefix: string; readonly target: string } {
  const dotIdx = channel.indexOf('.');
  if (dotIdx === -1) {
    return { prefix: channel, target: '' };
  }
  return {
    prefix: channel.slice(0, dotIdx),
    target: channel.slice(dotIdx + 1),
  };
}

/** Counts unique `Q.<contract>` subscriptions inside a channel list. */
export function countQuoteSubscriptions(channels: readonly string[]): number {
  let count = 0;
  for (const ch of channels) {
    const { prefix, target } = splitChannel(ch);
    if (prefix === 'Q' && target.length > 0 && target !== '*') {
      count += 1;
    }
  }
  return count;
}

/**
 * Validates all Massive cluster subscription rules before transmitting a frame:
 * - On `/options`, rejects `Q` / `Q.*` wildcards explicitly.
 * - On `/options`, rejects cumulative `Q` contract subscriptions exceeding `1000`.
 */
export function validateSubscriptionsForCluster(
  cluster: WsCluster,
  channels: readonly string[],
): void {
  if (cluster !== 'options') {
    return;
  }

  let quoteCount = 0;
  for (const ch of channels) {
    const { prefix, target } = splitChannel(ch);
    if (prefix === 'Q') {
      if (target === '' || target === '*') {
        throw new Error(
          'Prohibited wildcard quote subscription (Q / Q.*) on /options cluster: maximum 1000 individual contracts allowed.',
        );
      }
      quoteCount += 1;
    }
  }

  if (quoteCount > OPTIONS_MAX_QUOTE_SUBSCRIPTIONS) {
    throw new Error(
      `Options cluster Q subscription limit exceeded (${String(quoteCount)} > ${String(OPTIONS_MAX_QUOTE_SUBSCRIPTIONS)} contracts).`,
    );
  }
}

/**
 * Computes exponential reconnect backoff enforced at `>= MIN_RECONNECT_BACKOFF_MS` (15,000 ms)
 * so midnight ET resets or `max_connections` responses never cause rapid reconnect loops.
 */
export function computeReconnectBackoffMs(options: {
  readonly attempt: number;
  readonly minDelayMs?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}): number {
  const attempt = Math.max(0, Math.floor(options.attempt));
  const floorMs = Math.max(
    MIN_RECONNECT_BACKOFF_MS,
    options.minDelayMs ?? MIN_RECONNECT_BACKOFF_MS,
  );
  const baseMs = Math.max(floorMs, options.baseDelayMs ?? DEFAULT_BASE_RECONNECT_BACKOFF_MS);
  const maxMs = Math.max(floorMs, options.maxDelayMs ?? DEFAULT_MAX_RECONNECT_BACKOFF_MS);
  const exponent = Math.min(attempt, 20);
  const raw = baseMs * 2 ** exponent;
  return Math.min(maxMs, Math.max(floorMs, raw));
}

function validateUrl(url: string, allowInsecureWs: boolean): string {
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    throw new Error('WebSocket URL must be non-empty');
  }
  if (trimmed.startsWith('wss://')) {
    return trimmed;
  }
  if (allowInsecureWs && trimmed.startsWith('ws://')) {
    return trimmed;
  }
  throw new Error('WebSocket URL must use wss:// transport');
}

function makeProviderError(
  code: string,
  rawMessage: string,
  retryable: boolean,
  secrets: readonly string[],
): WsClientError {
  return {
    provider: 'massive',
    code,
    message: redact(rawMessage, secrets),
    retryable,
  };
}

/**
 * Decoupled, injectable Massive WebSocket client handling:
 * - `connected` -> `auth` -> `auth_success` -> `subscribe` state machine
 * - `/options` `Q.*` prohibition and 1,000-contract hard cap
 * - Midnight ET reset / `max_connections` safe reconnect with `>= 15 s` backoff
 * - Slow-consumer non-blocking inbound queue buffering
 * - Complete `apiKey` redaction across errors and diagnostics
 */
export class MassiveWsClient {
  private readonly apiKey: string;
  private readonly cluster: WsCluster;
  private readonly url: string;
  private readonly socketFactory: WsSocketFactory;
  private readonly injectedSleep: SleepFn | undefined;
  private readonly nowMsFn: () => number;
  private readonly connectionLimitCooldownMs: number;
  private readonly maxQueueSize: number;
  private readonly autoReconnect: boolean;
  private readonly minReconnectDelayMs: number;
  private readonly baseReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly onEventsCb: ((events: readonly WsNormalizedEvent[]) => void) | undefined;
  private readonly onErrorCb: ((error: WsClientError) => void) | undefined;
  private readonly onStateChangeCb: ((state: WsConnectionState) => void) | undefined;

  private readonly desiredSubscriptions = new Set<string>();
  private readonly inboundQueue: (readonly WsNormalizedEvent[])[] = [];

  private state: WsConnectionState = 'disconnected';
  private socket: WsSocketLike | null = null;
  private closed = false;
  private reconnectAttempts = 0;
  private reconnectLoopActive = false;
  private reconnectGeneration = 0;
  private reconnectTimerId: ReturnType<typeof setTimeout> | null = null;
  private activeSleepCancel: (() => void) | null = null;
  private pendingTimerCount = 0;
  private circuitBreakerOpen = false;
  private circuitBreakerReason: WsCircuitBreakerReason | null = null;
  private circuitBreakerOpenedAtMs: number | null = null;
  private circuitBreakerCooldownUntilMs: number | null = null;
  private droppedQueueMessages = 0;
  private totalMessagesReceived = 0;
  private discardedPayloads = 0;
  private lastError: WsClientError | null = null;

  private pendingConnectResolve: (() => void) | null = null;
  private pendingConnectReject: ((reason: Error) => void) | null = null;
  private flushScheduled = false;

  constructor(options: MassiveWsClientOptions) {
    if (typeof options.apiKey !== 'string' || options.apiKey.trim().length === 0) {
      throw new Error('MassiveWsClient requires a non-empty apiKey');
    }

    this.apiKey = options.apiKey;
    this.cluster = options.cluster;
    const rawCluster = options.cluster as string;
    const candidateUrl = options.url ?? WS_CLUSTER_URLS[options.cluster];
    if (rawCluster === 'futures' || (typeof candidateUrl === 'string' && /\/futures(?:[/?#]|$)/i.test(candidateUrl))) {
      throw new Error('Massive /futures WebSocket stream is disabled by policy');
    }
    this.url = validateUrl(
      candidateUrl,
      options.allowInsecureWs ?? false,
    );
    this.socketFactory = options.socketFactory ?? createRuntimeSocketFactory();
    this.injectedSleep = options.sleep;
    this.nowMsFn = options.nowMsFn ?? ((): number => Date.now());
    this.connectionLimitCooldownMs = Math.max(
      1_000,
      options.connectionLimitCooldownMs ?? DEFAULT_CONNECTION_LIMIT_COOLDOWN_MS,
    );

    const queueCap = options.maxQueueSize ?? DEFAULT_WS_MAX_QUEUE_SIZE;
    if (!Number.isInteger(queueCap) || queueCap < 1) {
      throw new RangeError(`maxQueueSize must be a positive integer (received ${String(queueCap)})`);
    }
    this.maxQueueSize = queueCap;

    this.autoReconnect = options.autoReconnect ?? true;
    this.minReconnectDelayMs = Math.max(
      MIN_RECONNECT_BACKOFF_MS,
      options.minReconnectDelayMs ?? MIN_RECONNECT_BACKOFF_MS,
    );
    this.baseReconnectDelayMs = Math.max(
      this.minReconnectDelayMs,
      options.baseReconnectDelayMs ?? DEFAULT_BASE_RECONNECT_BACKOFF_MS,
    );
    this.maxReconnectDelayMs = Math.max(
      this.minReconnectDelayMs,
      options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_BACKOFF_MS,
    );
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? Number.POSITIVE_INFINITY;

    this.onEventsCb = options.onEvents;
    this.onErrorCb = options.onError;
    this.onStateChangeCb = options.onStateChange;

    const initial = parseChannelSubscriptions(options.initialSubscriptions);
    validateSubscriptionsForCluster(this.cluster, initial);
    for (const ch of initial) {
      this.desiredSubscriptions.add(ch);
    }
  }

  /** Connects the socket and resolves once `auth_success` is received from Massive. */
  connect(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('Cannot connect a closed MassiveWsClient'));
    }
    if (this.circuitBreakerOpen) {
      return Promise.reject(
        new Error(
          redact(
            `MassiveWsClient circuit breaker open (${this.circuitBreakerReason ?? 'max_connections'})`,
            [this.apiKey],
          ),
        ),
      );
    }
    if (this.state === 'ready') {
      return Promise.resolve();
    }
    if (this.socket !== null && this.pendingConnectResolve !== null) {
      return new Promise<void>((resolve, reject) => {
        const prevResolve = this.pendingConnectResolve;
        const prevReject = this.pendingConnectReject;
        this.pendingConnectResolve = () => {
          prevResolve?.();
          resolve();
        };
        this.pendingConnectReject = (err) => {
          prevReject?.(err);
          reject(err);
        };
      });
    }

    return new Promise<void>((resolve, reject) => {
      this.pendingConnectResolve = resolve;
      this.pendingConnectReject = reject;
      this.openSocket();
    });
  }

  /**
   * Re-habilita explícitamente un circuit breaker abierto tras cumplir su cooldown largo.
   * `/stocks` permanece cerrado incluso al expirar cooldowns (requiere autorización independiente).
   */
  authorizeCircuitRecovery(options?: { readonly force?: boolean }): void {
    if (this.closed) {
      throw new Error('Cannot recover a closed MassiveWsClient');
    }
    if (this.cluster === 'stocks') {
      throw new Error(
        'Massive /stocks WebSocket remains closed under STANDBY_TRADIER_FMP_PRIMARY policy',
      );
    }
    if (!this.circuitBreakerOpen) {
      return;
    }
    const nowMs = this.nowMsFn();
    if (
      options?.force !== true &&
      this.circuitBreakerCooldownUntilMs !== null &&
      nowMs < this.circuitBreakerCooldownUntilMs
    ) {
      throw new Error('Connection-limit circuit breaker cooldown still active');
    }
    this.circuitBreakerOpen = false;
    this.circuitBreakerReason = null;
    this.circuitBreakerOpenedAtMs = null;
    this.circuitBreakerCooldownUntilMs = null;
    this.reconnectAttempts = 0;
    this.transitionState('disconnected');
  }

  /**
   * Adds channel subscriptions.
   * Validates `/options` `Q.*` restriction and 1,000-contract cap synchronously BEFORE altering state.
   * Queues automatically if called prior to `auth_success`.
   */
  subscribe(channels: string | readonly string[]): void {
    if (this.closed) {
      throw new Error('Cannot subscribe on a closed MassiveWsClient');
    }
    const requested = parseChannelSubscriptions(channels);
    if (requested.length === 0) {
      return;
    }

    const candidateSet = new Set<string>(this.desiredSubscriptions);
    const newlyAdded: string[] = [];
    for (const ch of requested) {
      if (!candidateSet.has(ch)) {
        candidateSet.add(ch);
        newlyAdded.push(ch);
      }
    }

    validateSubscriptionsForCluster(this.cluster, Array.from(candidateSet));

    for (const ch of newlyAdded) {
      this.desiredSubscriptions.add(ch);
    }

    if (this.state === 'ready' && this.socket !== null && newlyAdded.length > 0) {
      this.sendSubscriptionAction('subscribe', newlyAdded);
    }
  }

  /** Removes channel subscriptions and transmits `unsubscribe` immediately when ready. */
  unsubscribe(channels: string | readonly string[]): void {
    const requested = parseChannelSubscriptions(channels);
    if (requested.length === 0) {
      return;
    }

    const removed: string[] = [];
    for (const ch of requested) {
      if (this.desiredSubscriptions.delete(ch)) {
        removed.push(ch);
      }
    }

    if (this.state === 'ready' && this.socket !== null && removed.length > 0) {
      this.sendSubscriptionAction('unsubscribe', removed);
    }
  }

  /** Drains up to `maxBatches` buffered event batches without dropping unconsumed batches. */
  drainInboundQueue(maxBatches = Number.POSITIVE_INFINITY): readonly WsNormalizedEvent[] {
    if (this.inboundQueue.length === 0) {
      return [];
    }

    const limit =
      maxBatches === Number.POSITIVE_INFINITY
        ? this.inboundQueue.length
        : Math.max(0, Math.floor(maxBatches));
    const drainedBatches = this.inboundQueue.splice(0, limit);
    const flat: WsNormalizedEvent[] = [];
    for (const batch of drainedBatches) {
      for (const ev of batch) {
        flat.push(ev);
      }
    }

    if (this.onEventsCb !== undefined && flat.length > 0) {
      this.onEventsCb(flat);
    }

    return flat;
  }

  /** Returns a safe, secret-free diagnostic snapshot of the client. */
  getSnapshot(): WsClientSnapshot {
    const subscriptions = Array.from(this.desiredSubscriptions);
    return {
      cluster: this.cluster,
      url: redact(this.url, [this.apiKey]),
      state: this.state,
      subscriptions,
      activeQuoteSubscriptionCount: countQuoteSubscriptions(subscriptions),
      queueDepth: this.inboundQueue.length,
      droppedQueueMessages: this.droppedQueueMessages,
      reconnectAttempts: this.reconnectAttempts,
      totalMessagesReceived: this.totalMessagesReceived,
      discardedPayloads: this.discardedPayloads,
      lastError: this.lastError,
      circuitBreakerOpen: this.circuitBreakerOpen,
      circuitBreakerReason: this.circuitBreakerReason,
      circuitBreakerOpenedAtMs: this.circuitBreakerOpenedAtMs,
      circuitBreakerCooldownUntilMs: this.circuitBreakerCooldownUntilMs,
      pendingReconnectTimers: this.pendingTimerCount,
    };
  }

  /** Cleanly shuts down the client and suppresses all further reconnect attempts. */
  close(code = 1000, reason = 'client_closed'): void {
    this.closed = true;
    this.cancelPendingReconnect();
    const sock = this.socket;
    this.detachSocket(sock);
    if (sock !== null) {
      try {
        sock.close(code, redact(reason, [this.apiKey]));
      } catch {
        // Ignore transport close exceptions during deliberate shutdown
      }
    }
    this.transitionState('closed');
    this.rejectPendingConnect(new Error('WebSocket client closed before authentication completed'));
  }

  private cancelPendingReconnect(): void {
    this.reconnectGeneration += 1;
    if (this.reconnectTimerId !== null) {
      clearTimeout(this.reconnectTimerId);
      this.reconnectTimerId = null;
    }
    const cancel = this.activeSleepCancel;
    this.activeSleepCancel = null;
    cancel?.();
    this.pendingTimerCount = 0;
    this.reconnectLoopActive = false;
  }

  private tripCircuitBreaker(kind: WsCircuitBreakerReason, rawMessage: string): void {
    if (this.closed || this.circuitBreakerOpen) {
      return;
    }
    this.circuitBreakerOpen = true;
    this.circuitBreakerReason = kind;
    const nowMs = this.nowMsFn();
    this.circuitBreakerOpenedAtMs = nowMs;
    this.circuitBreakerCooldownUntilMs = nowMs + this.connectionLimitCooldownMs;

    this.cancelPendingReconnect();

    const sock = this.socket;
    this.detachSocket(sock);
    if (sock !== null) {
      try {
        sock.close(kind === 'max_connections' ? 4000 : 1008, kind);
      } catch {
        // Ignore transport close errors
      }
    }

    const msg = redact(rawMessage, [this.apiKey]);
    const code = kind === 'max_connections' ? 'max_connections' : 'ws_policy_violation_1008';
    const err = makeProviderError(code, msg, false, [this.apiKey]);
    this.emitError(err);
    this.transitionState('error');
    this.rejectPendingConnect(new Error(err.message));
  }

  private transitionState(next: WsConnectionState): void {
    if (this.state === next) {
      return;
    }
    this.state = next;
    this.onStateChangeCb?.(next);
  }

  private emitError(error: WsClientError): void {
    this.lastError = error;
    this.onErrorCb?.(error);
  }

  private resolvePendingConnect(): void {
    const resolve = this.pendingConnectResolve;
    this.pendingConnectResolve = null;
    this.pendingConnectReject = null;
    resolve?.();
  }

  private rejectPendingConnect(err: Error): void {
    const reject = this.pendingConnectReject;
    this.pendingConnectResolve = null;
    this.pendingConnectReject = null;
    reject?.(new Error(redact(err.message, [this.apiKey])));
  }

  private detachSocket(sock: WsSocketLike | null): void {
    if (sock !== null) {
      sock.onOpen = null;
      sock.onMessage = null;
      sock.onClose = null;
      sock.onError = null;
    }
    if (this.socket === sock) {
      this.socket = null;
    }
  }

  private openSocket(): void {
    if (this.closed || this.circuitBreakerOpen) {
      return;
    }
    this.transitionState(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    let sock: WsSocketLike;
    try {
      sock = this.socketFactory(this.url);
    } catch (err) {
      const msg = redact(toErrorMessage(err, 'Failed to construct WebSocket'), [this.apiKey]);
      const pErr = makeProviderError('socket_init_error', msg, true, [this.apiKey]);
      this.emitError(pErr);
      this.handleTransportFailure(pErr.message);
      return;
    }

    this.socket = sock;

    sock.onOpen = () => {
      // Wait for Massive's `{ ev: "status", status: "connected" }` before sending auth
    };

    sock.onMessage = (rawData: string) => {
      if (this.closed || this.circuitBreakerOpen || this.socket !== sock) {
        return;
      }
      this.handleRawInboundMessage(rawData);
    };

    sock.onError = (rawErr: unknown) => {
      if (this.closed || this.circuitBreakerOpen || this.socket !== sock) {
        return;
      }
      const msg = redact(toErrorMessage(rawErr, 'WebSocket transport error'), [this.apiKey]);
      if (isConnectionLimitMessage(msg)) {
        this.tripCircuitBreaker('max_connections', msg);
        return;
      }
      const pErr = makeProviderError('ws_transport_error', msg, true, [this.apiKey]);
      this.emitError(pErr);
    };

    sock.onClose = (info) => {
      if (this.closed || this.circuitBreakerOpen || this.socket !== sock) {
        return;
      }
      this.detachSocket(sock);
      const reasonText = redact(info.reason || `Socket closed (${String(info.code)})`, [this.apiKey]);
      if (isConnectionLimitMessage(reasonText)) {
        this.tripCircuitBreaker('max_connections', reasonText);
        return;
      }
      if (info.code === 1008) {
        this.tripCircuitBreaker('policy_violation_1008', reasonText);
        return;
      }
      this.handleTransportFailure(reasonText);
    };
  }

  private handleRawInboundMessage(rawData: string): void {
    this.totalMessagesReceived += 1;
    const parsed = parseWsJsonPayload(rawData);
    this.discardedPayloads += parsed.discarded;

    if (parsed.events.length === 0) {
      return;
    }

    let abortedOnFatalStatus = false;

    for (const event of parsed.events) {
      if (event.ev !== 'status') {
        continue;
      }

      if (event.status === 'connected') {
        this.transitionState('authenticating');
        this.sendControlFrame('auth', this.apiKey);
      } else if (event.status === 'auth_success') {
        this.reconnectAttempts = 0;
        this.reconnectLoopActive = false;
        this.transitionState('ready');
        const allDesired = Array.from(this.desiredSubscriptions);
        if (allDesired.length > 0) {
          this.sendSubscriptionAction('subscribe', allDesired);
        }
        this.resolvePendingConnect();
      } else if (event.status === 'auth_failed') {
        const msg = redact(
          event.message.length > 0 ? event.message : 'Massive WebSocket authentication failed',
          [this.apiKey],
        );
        const err = makeProviderError('auth_failed', msg, false, [this.apiKey]);
        this.emitError(err);
        const sock = this.socket;
        this.detachSocket(sock);
        if (sock !== null) {
          try {
            sock.close(1008, 'auth_failed');
          } catch {
            // Ignore close errors
          }
        }
        this.transitionState('error');
        this.rejectPendingConnect(new Error(err.message));
        abortedOnFatalStatus = true;
        break;
      } else if (
        event.status === 'max_connections' ||
        isConnectionLimitMessage(event.message)
      ) {
        const rawMsg =
          event.message.length > 0 ? event.message : 'Maximum concurrent WebSocket connections reached';
        this.tripCircuitBreaker('max_connections', rawMsg);
        abortedOnFatalStatus = true;
        break;
      }
    }

    this.enqueueEvents(parsed.events);

    if (!abortedOnFatalStatus && this.onEventsCb !== undefined && !this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => {
        this.flushScheduled = false;
        if (!this.closed && !this.circuitBreakerOpen && this.inboundQueue.length > 0) {
          this.drainInboundQueue();
        }
      });
    }
  }

  private enqueueEvents(events: readonly WsNormalizedEvent[]): void {
    if (this.inboundQueue.length >= this.maxQueueSize) {
      this.inboundQueue.shift();
      this.droppedQueueMessages += 1;
    }
    this.inboundQueue.push(events);
  }

  private sendControlFrame(action: 'auth' | 'subscribe' | 'unsubscribe', params: string): void {
    const sock = this.socket;
    if (sock === null) {
      return;
    }
    try {
      sock.send(JSON.stringify({ action, params }));
    } catch (err) {
      const msg = redact(toErrorMessage(err, `Failed sending ${action} frame`), [this.apiKey]);
      const pErr = makeProviderError('ws_send_error', msg, true, [this.apiKey]);
      this.emitError(pErr);
      this.detachSocket(sock);
      this.handleTransportFailure(pErr.message);
    }
  }

  private sendSubscriptionAction(action: 'subscribe' | 'unsubscribe', channels: readonly string[]): void {
    for (let i = 0; i < channels.length; i += SUBSCRIBE_CHUNK_SIZE) {
      const chunk = channels.slice(i, i + SUBSCRIBE_CHUNK_SIZE);
      if (chunk.length > 0) {
        this.sendControlFrame(action, chunk.join(','));
      }
    }
  }

  private handleTransportFailure(reason: string): void {
    if (this.closed || this.circuitBreakerOpen || this.state === 'error' || this.state === 'closed') {
      return;
    }

    if (!this.autoReconnect || this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.transitionState('error');
      const finalReason = redact(reason, [this.apiKey]);
      if (this.lastError === null) {
        this.emitError(makeProviderError('ws_disconnected', finalReason, false, [this.apiKey]));
      }
      this.rejectPendingConnect(new Error(finalReason));
      return;
    }

    if (this.reconnectLoopActive) {
      return;
    }

    this.reconnectLoopActive = true;
    this.transitionState('reconnecting');

    void this.runReconnectAttempt();
  }

  private sleepCancelable(delayMs: number, generation: number): Promise<boolean> {
    if (this.injectedSleep !== undefined) {
      const customSleep = this.injectedSleep;
      return new Promise<boolean>((resolve, reject) => {
        let settled = false;
        this.activeSleepCancel = () => {
          if (!settled) {
            settled = true;
            resolve(false);
          }
        };
        customSleep(delayMs).then(
          () => {
            if (!settled) {
              settled = true;
              this.activeSleepCancel = null;
              resolve(this.reconnectGeneration === generation && !this.closed && !this.circuitBreakerOpen);
            }
          },
          (err: unknown) => {
            if (!settled) {
              settled = true;
              this.activeSleepCancel = null;
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          },
        );
      });
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;
      this.activeSleepCancel = () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      };
      this.reconnectTimerId = setTimeout(() => {
        this.reconnectTimerId = null;
        if (!settled) {
          settled = true;
          this.activeSleepCancel = null;
          resolve(this.reconnectGeneration === generation && !this.closed && !this.circuitBreakerOpen);
        }
      }, delayMs);
    });
  }

  private async runReconnectAttempt(): Promise<void> {
    const gen = this.reconnectGeneration;
    this.pendingTimerCount = 1;
    let sleepErrorMessage: string | null = null;
    try {
      const delayMs = computeReconnectBackoffMs({
        attempt: this.reconnectAttempts,
        minDelayMs: this.minReconnectDelayMs,
        baseDelayMs: this.baseReconnectDelayMs,
        maxDelayMs: this.maxReconnectDelayMs,
      });
      this.reconnectAttempts += 1;
      const shouldContinue = await this.sleepCancelable(delayMs, gen);

      if (
        !shouldContinue ||
        this.closed ||
        this.circuitBreakerOpen ||
        this.state === 'error' ||
        this.state === 'closed' ||
        this.reconnectGeneration !== gen
      ) {
        return;
      }

      this.pendingTimerCount = 0;
      this.reconnectLoopActive = false;
      this.openSocket();
    } catch (err) {
      sleepErrorMessage = redact(toErrorMessage(err, 'Reconnect sleep failed'), [this.apiKey]);
      const pErr = makeProviderError('reconnect_sleep_error', sleepErrorMessage, false, [this.apiKey]);
      this.emitError(pErr);
      this.transitionState('error');
      this.rejectPendingConnect(new Error(pErr.message));
    } finally {
      if (this.reconnectGeneration === gen) {
        this.pendingTimerCount = 0;
        this.reconnectLoopActive = false;
        this.activeSleepCancel = null;
      }
    }
  }
}
