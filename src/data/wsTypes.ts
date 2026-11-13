import type { AvwapPoint, AvwapState } from '../core/avwap.js';
import type {
  SessionVwapOptions,
  SessionVwapPoint,
  SessionVwapState,
} from '../core/sessionVwap.js';
import type { Bar } from '../core/types.js';
import type {
  DiscardCounts,
  DiscardRecord,
  SleepFn,
} from './types.js';

/** Safe, secret-redacted WebSocket client error surface. */
export interface WsClientError {
  readonly provider: 'massive';
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

/** Massive WebSocket cluster identifiers. */
export type WsCluster = 'stocks' | 'options' | 'indices';

/** Canonical Massive real-time WebSocket endpoints by cluster. */
export const WS_CLUSTER_URLS: Readonly<Record<WsCluster, string>> = {
  stocks: 'wss://socket.massive.com/stocks',
  options: 'wss://socket.massive.com/options',
  indices: 'wss://socket.massive.com/indices',
};

/** Hard server-enforced limit of `Q` (quote) contract subscriptions on `/options`. */
export const OPTIONS_MAX_QUOTE_SUBSCRIPTIONS = 1000;

/** Minimum reconnect backoff (ms) to survive Massive's 10–30 s server release and avoid loops. */
export const MIN_RECONNECT_BACKOFF_MS = 15_000;

/** Default maximum reconnect backoff (ms). */
export const DEFAULT_MAX_RECONNECT_BACKOFF_MS = 120_000;

/** Massive 15-minute late-trade (FINRA TRF) rebroadcast window in seconds. */
export const REBROADCAST_WINDOW_SECONDS = 900;

/** Default inbound message buffer capacity for slow-consumer decoupling. */
export const DEFAULT_WS_MAX_QUEUE_SIZE = 50_000;

/** Normalized server status event (`ev: "status"`). */
export interface WsStatusEvent {
  readonly ev: 'status';
  readonly status: string;
  readonly message: string;
}

/** Normalized 1-second (`A`) or 1-minute (`AM`) aggregate bar event. */
export interface WsAggBarEvent {
  readonly ev: 'A' | 'AM';
  readonly sym: string;
  readonly bar: Bar;
  readonly startMs: number;
  readonly endMs: number;
  readonly accumulatedVolume?: number;
  readonly dayOpen?: number;
  readonly tickCount?: number;
}

/** Normalized trade event (`ev: "T"`). */
export interface WsTradeEvent {
  readonly ev: 'T';
  readonly sym: string;
  readonly price: number;
  readonly size: number;
  /** Floor of `eventTimeMs / 1000` in integer UTC seconds. */
  readonly timeSec: number;
  /** Raw provider timestamp in Unix milliseconds. */
  readonly eventTimeMs: number;
  readonly conditions?: readonly number[];
  readonly exchange?: number;
}

/** Normalized top-of-book quote event (`ev: "Q"`). */
export interface WsQuoteEvent {
  readonly ev: 'Q';
  readonly sym: string;
  readonly bidPrice: number;
  readonly askPrice: number;
  readonly bidSize: number;
  readonly askSize: number;
  /** Floor of `eventTimeMs / 1000` in integer UTC seconds. */
  readonly timeSec: number;
  /** Raw provider timestamp in Unix milliseconds. */
  readonly eventTimeMs: number;
}

/** Normalized administrative / regulatory event (`AD` on options, `LULD` on stocks). */
export interface WsAdminEvent {
  readonly ev: 'AD' | 'LULD';
  readonly sym?: string;
  readonly timeSec?: number;
  readonly raw: Readonly<Record<string, unknown>>;
}

/** Union of validated and normalized Massive WebSocket events. */
export type WsNormalizedEvent =
  | WsStatusEvent
  | WsAggBarEvent
  | WsTradeEvent
  | WsQuoteEvent
  | WsAdminEvent;

/** Result of parsing and validating one raw WebSocket payload (array batch or single object). */
export interface WsParseResult {
  readonly events: readonly WsNormalizedEvent[];
  readonly discarded: number;
  readonly discardCounts: DiscardCounts;
  readonly discardRecords: readonly DiscardRecord[];
}

/** Authoritative origin of a 1-second slot inside a forming bucket. */
export type FormingSlotSource = 'T' | 'A';

/** Per-second sub-bar maintained inside a forming bucket to deduplicate `T` + `A` and `A` rebroadcasts. */
export interface FormingSecondSlot {
  readonly time: number;
  readonly source: FormingSlotSource;
  readonly bar: Bar;
  readonly notional: number;
  readonly hasValidVw: boolean;
}

/** Counters tracking live consolidator behavior and data hygiene. */
export interface LiveBarMetrics {
  readonly closedCount: number;
  readonly rebroadcastOverwrites: number;
  readonly secondRebroadcastOverwrites: number;
  readonly tradesFolded: number;
  readonly staleEventsIgnored: number;
  readonly discardedEvents: number;
  readonly discardCounts: DiscardCounts;
}

/** Immutable state of the pure forming-bar / rebroadcast consolidator. */
export interface LiveBarState {
  /** Target bar duration in integer seconds (default `60`). */
  readonly barSeconds: number;
  /** Sealed historical + closed bars, strictly ascending by `time` (integer UTC seconds). */
  readonly closedBars: readonly Bar[];
  /** Currently forming bucket start time (`null` when no active forming bucket). */
  readonly formingBucketTime: number | null;
  /** Current forming OHLCV bar (`null` when no active forming bucket). */
  readonly formingBar: Bar | null;
  /** Open per-bucket second slots indexed by `bucketTime -> secondTime`. */
  readonly openBuckets: Readonly<Record<string, Readonly<Record<string, FormingSecondSlot>>>>;
  /** Sealed 1-minute `AM` bars indexed by `minuteTime` (used for multi-minute aggregation/rebroadcasts). */
  readonly closedMinuteBars: Readonly<Record<string, Bar>>;
  /** Running diagnostic counters. */
  readonly metrics: LiveBarMetrics;
  /** Discard samples capped for diagnostics. */
  readonly discardRecords: readonly DiscardRecord[];
}

/** Options controlling `ingestWsEvents` behavior. */
export interface LiveBarIngestOptions {
  /** Optional symbol filter; events with another `sym` are ignored cleanly. */
  readonly symbol?: string;
  /** Maximum closed bars to keep in `closedBars` (default unlimited when omitted). */
  readonly maxClosedBars?: number;
  /** Maximum discard records retained for diagnostics (default `50`). */
  readonly maxDiscardRecords?: number;
}

/** Inputs to compute pure live indicator projections on top of closed indicator states. */
export interface LiveProjectionInputs {
  readonly ema?: {
    readonly lastClosedEma: number;
    readonly period: number;
  };
  readonly sessionVwap?: {
    readonly closedState: SessionVwapState;
    readonly options: SessionVwapOptions;
  };
  readonly avwap?: {
    readonly closedState: AvwapState;
  };
}

/** Live indicator values projected onto the current forming bar (`NaN` / `null` when unavailable). */
export interface LiveProjectionResult {
  readonly formingTime: number | null;
  readonly ema: number;
  readonly sessionVwap: SessionVwapPoint | null;
  readonly avwap: AvwapPoint | null;
}

/** Connection lifecycle states for `MassiveWsClient`. */
export type WsConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'authenticating'
  | 'ready'
  | 'reconnecting'
  | 'closed'
  | 'error';

/** Minimal transport-agnostic WebSocket abstraction for dependency injection and deterministic tests. */
export interface WsSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onOpen: (() => void) | null;
  onMessage: ((data: string) => void) | null;
  onClose: ((info: { readonly code: number; readonly reason: string; readonly wasClean: boolean }) => void) | null;
  onError: ((error: unknown) => void) | null;
}

/** Factory creating a new socket instance for a target WebSocket URL. */
export type WsSocketFactory = (url: string) => WsSocketLike;

/** Configuration options for `MassiveWsClient`. */
export interface MassiveWsClientOptions {
  readonly apiKey: string;
  readonly cluster: WsCluster;
  /** Optional explicit URL override (must remain `wss://` unless allowInsecureLocalWs is set for local harnesses). */
  readonly url?: string;
  /** Allow `ws://` URLs exclusively for local test harnesses (default `false`). */
  readonly allowInsecureWs?: boolean;
  /** Initial channel list (e.g. `['AM.SPY', 'A.SPY']` or `'AM.SPY,A.SPY'`). */
  readonly initialSubscriptions?: string | readonly string[];
  /** Custom socket transport factory; defaults to runtime global `WebSocket`. */
  readonly socketFactory?: WsSocketFactory;
  /** Async sleep function for backoff delays (default `setTimeout` promise). */
  readonly sleep?: SleepFn;
  /** Maximum inbound buffered batches for slow-consumer decoupling (default `50_000`). */
  readonly maxQueueSize?: number;
  /** Auto-reconnect when disconnected unexpectedly, on midnight ET reset, or `max_connections` (default `true`). */
  readonly autoReconnect?: boolean;
  /** Minimum reconnect delay in ms (enforced `>= 15_000`, default `15_000`). */
  readonly minReconnectDelayMs?: number;
  /** Base reconnect delay in ms before exponential backoff (default `15_000`). */
  readonly baseReconnectDelayMs?: number;
  /** Maximum reconnect delay in ms (default `120_000`). */
  readonly maxReconnectDelayMs?: number;
  /** Maximum reconnect retries before stopping (`Infinity` by default, or finite in bounded tests). */
  readonly maxReconnectAttempts?: number;
  /** Optional callback invoked when queue batches are drained via `drainInboundQueue`. */
  readonly onEvents?: (events: readonly WsNormalizedEvent[]) => void;
  /** Optional callback invoked on non-fatal / fatal redacted status or protocol errors. */
  readonly onError?: (error: WsClientError) => void;
  /** Optional callback invoked on lifecycle transitions. */
  readonly onStateChange?: (state: WsConnectionState) => void;
}

/** Diagnostic snapshot of `MassiveWsClient` (never contains `apiKey`). */
export interface WsClientSnapshot {
  readonly cluster: WsCluster;
  readonly url: string;
  readonly state: WsConnectionState;
  readonly subscriptions: readonly string[];
  readonly activeQuoteSubscriptionCount: number;
  readonly queueDepth: number;
  readonly droppedQueueMessages: number;
  readonly reconnectAttempts: number;
  readonly totalMessagesReceived: number;
  readonly discardedPayloads: number;
  readonly lastError: WsClientError | null;
}
