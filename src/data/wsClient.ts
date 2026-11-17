import { parseWsJsonPayload } from './liveBarConsolidator.js';
import { redact, toErrorMessage } from './normalizeShared.js';
import type { SleepFn } from './types.js';
import {
  DEFAULT_MAX_RECONNECT_BACKOFF_MS,
  DEFAULT_WS_MAX_QUEUE_SIZE,
  MIN_RECONNECT_BACKOFF_MS,
  OPTIONS_MAX_QUOTE_SUBSCRIPTIONS,
  WS_CLUSTER_URLS,
  type MassiveWsClientOptions,
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

const defaultSleep: SleepFn = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

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
  private readonly sleep: SleepFn;
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
    this.url = validateUrl(
      options.url ?? WS_CLUSTER_URLS[options.cluster],
      options.allowInsecureWs ?? false,
    );
    this.socketFactory = options.socketFactory ?? createRuntimeSocketFactory();
    this.sleep = options.sleep ?? defaultSleep;

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
    };
  }

  /** Cleanly shuts down the client and suppresses all further reconnect attempts. */
  close(code = 1000, reason = 'client_closed'): void {
    this.closed = true;
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
    if (this.closed) {
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
      if (this.closed || this.socket !== sock) {
        return;
      }
      this.handleRawInboundMessage(rawData);
    };

    sock.onError = (rawErr: unknown) => {
      if (this.closed || this.socket !== sock) {
        return;
      }
      const msg = redact(toErrorMessage(rawErr, 'WebSocket transport error'), [this.apiKey]);
      const pErr = makeProviderError('ws_transport_error', msg, true, [this.apiKey]);
      this.emitError(pErr);
    };

    sock.onClose = (info) => {
      if (this.closed || this.socket !== sock) {
        return;
      }
      this.detachSocket(sock);
      const reasonText = redact(info.reason || `Socket closed (${String(info.code)})`, [this.apiKey]);
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
      } else if (event.status === 'max_connections') {
        const msg = redact(
          event.message.length > 0 ? event.message : 'Maximum concurrent WebSocket connections reached',
          [this.apiKey],
        );
        const err = makeProviderError('max_connections', msg, true, [this.apiKey]);
        this.emitError(err);
        const sock = this.socket;
        this.detachSocket(sock);
        if (sock !== null) {
          try {
            sock.close(4000, 'max_connections');
          } catch {
            // Ignore close errors
          }
        }
        abortedOnFatalStatus = true;
        this.handleTransportFailure(err.message);
        break;
      }
    }

    this.enqueueEvents(parsed.events);

    if (!abortedOnFatalStatus && this.onEventsCb !== undefined && !this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => {
        this.flushScheduled = false;
        if (!this.closed && this.inboundQueue.length > 0) {
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
    if (this.closed || this.state === 'error' || this.state === 'closed') {
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

  private async runReconnectAttempt(): Promise<void> {
    let sleepErrorMessage: string | null = null;
    try {
      const delayMs = computeReconnectBackoffMs({
        attempt: this.reconnectAttempts,
        minDelayMs: this.minReconnectDelayMs,
        baseDelayMs: this.baseReconnectDelayMs,
        maxDelayMs: this.maxReconnectDelayMs,
      });
      this.reconnectAttempts += 1;
      await this.sleep(delayMs);

      if (this.closed || this.state === 'error' || this.state === 'closed') {
        return;
      }

      this.openSocket();
    } catch (err) {
      sleepErrorMessage = redact(toErrorMessage(err, 'Reconnect sleep failed'), [this.apiKey]);
      const pErr = makeProviderError('reconnect_sleep_error', sleepErrorMessage, false, [this.apiKey]);
      this.emitError(pErr);
      this.transitionState('error');
      this.rejectPendingConnect(new Error(pErr.message));
    } finally {
      this.reconnectLoopActive = false;
    }
  }
}
