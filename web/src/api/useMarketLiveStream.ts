import { useCallback, useSyncExternalStore } from 'react';
import { refreshBackendHealth } from '../data/liveRuntimeBridge';

export type LiveStreamMarket = 'AR' | 'US';
export type LiveStreamTransport = 'WS' | 'POLL';
export type LiveQuoteKind = 'stock' | 'index' | 'bond' | 'note' | 'corp';

export interface MarketLiveQuote {
  readonly market: LiveStreamMarket;
  readonly symbol: string;
  readonly kind: LiveQuoteKind;
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
  readonly direction: 'up' | 'down' | null;
  readonly revision: number;
}

export interface MarketLiveCaucion {
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
  readonly referenceInstrument: string;
}

export interface MarketLiveStreamState {
  readonly version: number;
  readonly status: 'CONNECTING' | 'LIVE' | 'RECONNECTING';
  readonly transport: LiveStreamTransport | null;
  readonly isLive: boolean;
  readonly quotes: Readonly<Record<string, MarketLiveQuote>>;
  readonly cclMedian: number | null;
  readonly mepMedian: number | null;
  readonly arSourceMode: 'LIVE_BMB' | 'DATA912' | 'NO_DATA';
  readonly usSourceMode: 'MASSIVE_WS' | 'MASSIVE_BATCH' | 'NO_DATA';
  readonly cauciones: readonly MarketLiveCaucion[];
  readonly lastServerTimeSec: number | null;
  readonly lastReceivedAtMs: number | null;
  readonly ticksPerSecond: number;
  readonly totalBatches: number;
}

interface MarketTickBatchWire {
  readonly type?: unknown;
  readonly sequence?: unknown;
  readonly serverTimeSec?: unknown;
  readonly quotes?: unknown;
  readonly cclMedian?: unknown;
  readonly mepMedian?: unknown;
  readonly arSourceMode?: unknown;
  readonly usSourceMode?: unknown;
  readonly cauciones?: unknown;
}

const WS_OPEN_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 2_000;
const POLL_REQUEST_TIMEOUT_MS = 2_500;
const QUOTE_RECEIVE_FRESHNESS_MS = 40_000;
const LEGACY_FLUSH_INTERVAL_MS = 16;
const RECONNECT_INTERVAL_MS = 1_500;

let state: MarketLiveStreamState = {
  version: 0,
  status: 'CONNECTING',
  transport: null,
  isLive: false,
  quotes: {},
  cclMedian: null,
  mepMedian: null,
  arSourceMode: 'NO_DATA',
  usSourceMode: 'NO_DATA',
  cauciones: [],
  lastServerTimeSec: null,
  lastReceivedAtMs: null,
  ticksPerSecond: 0,
  totalBatches: 0,
};

const listeners = new Set<() => void>();
let managerCount = 0;
let socket: WebSocket | null = null;
let socketGeneration = 0;
let openTimeout: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollInFlight = false;
let pollGeneration = 0;
let lastBatchReceivedAtMs: number | null = null;
const pendingLegacyQuotes = new Map<string, MarketLiveQuote>();
let legacyFlushTimer: ReturnType<typeof setTimeout> | null = null;

function notify(next: MarketLiveStreamState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

function finitePositive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return value === null ? null : finiteNumber(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function liveQuoteKey(market: LiveStreamMarket, symbol: string): string {
  return `${market}:${symbol.trim().toUpperCase()}`;
}

export function isMarketLiveStreamFresh(snapshot: MarketLiveStreamState): boolean {
  return (
    snapshot.isLive &&
    snapshot.lastReceivedAtMs !== null &&
    Date.now() - snapshot.lastReceivedAtMs <= QUOTE_RECEIVE_FRESHNESS_MS
  );
}

export function getMarketLiveQuote(
  snapshot: MarketLiveStreamState,
  market: LiveStreamMarket,
  symbol: string,
): MarketLiveQuote | null {
  if (!isMarketLiveStreamFresh(snapshot)) return null;
  return snapshot.quotes[liveQuoteKey(market, symbol)] ?? null;
}

function parseQuote(raw: unknown, previous: MarketLiveQuote | null, partial = false): MarketLiveQuote | null {
  if (!isRecord(raw)) return null;
  const market = raw['market'];
  const symbolRaw = raw['symbol'];
  const kindRaw = raw['kind'];
  const price = finitePositive(raw['price']);
  const rawAsOf = raw['asOfUtcSec'];
  const asOfUtcSec = rawAsOf === null ? null : finitePositive(rawAsOf);
  if (
    (market !== 'AR' && market !== 'US') ||
    typeof symbolRaw !== 'string' ||
    symbolRaw.trim() === '' ||
    price === null ||
    (rawAsOf !== null && asOfUtcSec === null)
  ) {
    return null;
  }
  const kind: LiveQuoteKind =
    kindRaw === 'index' || kindRaw === 'bond' || kindRaw === 'note' || kindRaw === 'corp'
      ? kindRaw
      : 'stock';
  const symbol = symbolRaw.trim().toUpperCase();
  const currencyRaw = raw['currency'];
  const currency = currencyRaw === 'ARS' || currencyRaw === 'USD' ? currencyRaw : null;
  if (
    previous !== null &&
    previous.asOfUtcSec !== null &&
    asOfUtcSec !== null &&
    asOfUtcSec < previous.asOfUtcSec
  ) {
    return null;
  }

  const changed = previous !== null && Math.abs(previous.price - price) > 1e-9;
  const direction = changed ? (price > previous.price ? 'up' : 'down') : null;
  return {
    market,
    symbol,
    kind,
    currency,
    price,
    previousClose: partial ? finitePositive(raw['previousClose']) ?? previous?.previousClose ?? null : finitePositive(raw['previousClose']),
    changePct: partial ? nullableNumber(raw['changePct']) ?? previous?.changePct ?? null : nullableNumber(raw['changePct']),
    dayLow: partial ? finitePositive(raw['dayLow']) ?? previous?.dayLow ?? null : finitePositive(raw['dayLow']),
    dayHigh: partial ? finitePositive(raw['dayHigh']) ?? previous?.dayHigh ?? null : finitePositive(raw['dayHigh']),
    volume: partial ? finiteNumber(raw['volume']) ?? previous?.volume ?? null : finiteNumber(raw['volume']),
    turnover: partial ? finiteNumber(raw['turnover']) ?? previous?.turnover ?? null : finiteNumber(raw['turnover']),
    asOfUtcSec,
    source: typeof raw['source'] === 'string' && raw['source'] !== '' ? raw['source'] : 'UNKNOWN',
    direction,
    revision: changed || previous === null ? (previous?.revision ?? 0) + 1 : previous.revision,
  };
}

function parseCaucion(raw: unknown): MarketLiveCaucion | null {
  if (!isRecord(raw)) return null;
  const termDays = finitePositive(raw['termDays']);
  const currency = raw['currency'];
  if (termDays === null || (currency !== 'ARS' && currency !== 'USD')) return null;
  return {
    termDays: Math.round(termDays),
    currency,
    tnaWeighted: nullableNumber(raw['tnaWeighted']),
    teaEffective: nullableNumber(raw['teaEffective']),
    bidTna: nullableNumber(raw['bidTna']),
    askTna: nullableNumber(raw['askTna']),
    turnoverArs: nullableNumber(raw['turnoverArs']),
    spreadVsBadlarBps: nullableNumber(raw['spreadVsBadlarBps']),
    asOfUtcSec: finitePositive(raw['asOfUtcSec']),
    source: raw['source'] === 'BMB_HOMEBROKER' ? 'BMB_HOMEBROKER' : 'BCRA_LECAP_REF',
    referenceInstrument:
      typeof raw['referenceInstrument'] === 'string' && raw['referenceInstrument'] !== ''
        ? raw['referenceInstrument']
        : `Caución ${String(Math.round(termDays))}d`,
  };
}

function applyBatch(batch: MarketTickBatchWire, transport: LiveStreamTransport): boolean {
  if (batch.type !== 'MARKET_TICK_BATCH' || !Array.isArray(batch.quotes)) return false;
  clearPendingLegacy();
  const receivedAtMs = Date.now();
  const elapsedSec =
    lastBatchReceivedAtMs === null ? null : Math.max(0.001, (receivedAtMs - lastBatchReceivedAtMs) / 1_000);
  lastBatchReceivedAtMs = receivedAtMs;

  const arSourceMode =
    batch.arSourceMode === 'LIVE_BMB' || batch.arSourceMode === 'DATA912' || batch.arSourceMode === 'NO_DATA'
      ? batch.arSourceMode
      : state.arSourceMode;
  const usSourceMode =
    batch.usSourceMode === 'MASSIVE_WS' || batch.usSourceMode === 'MASSIVE_BATCH' || batch.usSourceMode === 'NO_DATA'
      ? batch.usSourceMode
      : state.usSourceMode;
  const previousQuotes = state.quotes;
  const nextQuotes: Record<string, MarketLiveQuote> = {};
  let changedTicks = 0;
  for (const raw of batch.quotes) {
    if (!isRecord(raw) || typeof raw['symbol'] !== 'string') continue;
    const market = raw['market'];
    if (market !== 'AR' && market !== 'US') continue;
    if ((market === 'AR' && arSourceMode === 'NO_DATA') || (market === 'US' && usSourceMode === 'NO_DATA')) continue;
    const key = liveQuoteKey(market, raw['symbol']);
    const parsed = parseQuote(raw, previousQuotes[key] ?? null);
    if (parsed === null) continue;
    if (parsed.direction !== null) changedTicks += 1;
    nextQuotes[key] = parsed;
  }

  const cauciones = arSourceMode === 'NO_DATA'
    ? []
    : Array.isArray(batch.cauciones)
      ? batch.cauciones.map(parseCaucion).filter((row): row is MarketLiveCaucion => row !== null)
      : state.cauciones;

  notify({
    ...state,
    version: state.version + 1,
    status: 'LIVE',
    transport,
    isLive: true,
    quotes: nextQuotes,
    cclMedian: arSourceMode === 'NO_DATA' ? null : batch.cclMedian === null ? null : finitePositive(batch.cclMedian) ?? state.cclMedian,
    mepMedian: arSourceMode === 'NO_DATA' ? null : batch.mepMedian === null ? null : finitePositive(batch.mepMedian) ?? state.mepMedian,
    arSourceMode,
    usSourceMode,
    cauciones,
    lastServerTimeSec: finitePositive(batch.serverTimeSec) ?? state.lastServerTimeSec,
    lastReceivedAtMs: receivedAtMs,
    ticksPerSecond: elapsedSec === null ? 0 : Math.round(changedTicks / elapsedSec),
    totalBatches: state.totalBatches + 1,
  });
  return true;
}

function clearPendingLegacy(): void {
  pendingLegacyQuotes.clear();
  if (legacyFlushTimer !== null) clearTimeout(legacyFlushTimer);
  legacyFlushTimer = null;
}

function flushLegacyQuotes(): void {
  legacyFlushTimer = null;
  if (pendingLegacyQuotes.size === 0 || managerCount === 0) return;
  const quotes = { ...state.quotes };
  pendingLegacyQuotes.forEach((quote, key) => {
    quotes[key] = quote;
  });
  pendingLegacyQuotes.clear();
  notify({
    ...state,
    version: state.version + 1,
    status: 'LIVE',
    transport: 'WS',
    isLive: true,
    usSourceMode: 'MASSIVE_WS',
    quotes,
    lastReceivedAtMs: Date.now(),
  });
}

function scheduleLegacyFlush(): void {
  if (legacyFlushTimer !== null) return;
  legacyFlushTimer = setTimeout(flushLegacyQuotes, LEGACY_FLUSH_INTERVAL_MS);
}

function applyLegacyStockEvent(raw: unknown): void {
  if (!isRecord(raw) || raw['cluster'] !== 'stocks' || typeof raw['symbol'] !== 'string') return;
  const symbol = raw['symbol'].trim().toUpperCase();
  const key = liveQuoteKey('US', symbol);
  const previous = pendingLegacyQuotes.get(key) ?? state.quotes[key] ?? null;
  const type = raw['type'];
  let price: number | null = null;
  let asOfUtcSec: number | null = null;
  let volume: number | null = null;
  let dayLow: number | null = null;
  let dayHigh: number | null = null;
  if (type === 'trade') {
    price = finitePositive(raw['price']);
    asOfUtcSec = finitePositive(raw['time']);
  } else if (type === 'bar_update') {
    const forming = isRecord(raw['formingBar']) ? raw['formingBar'] : null;
    const closed = isRecord(raw['lastClosedBar']) ? raw['lastClosedBar'] : null;
    const bar = forming ?? closed;
    price = finitePositive(bar?.['close']);
    asOfUtcSec = finitePositive(raw['time']);
    volume = finiteNumber(bar?.['volume']);
    dayLow = finitePositive(bar?.['low']);
    dayHigh = finitePositive(bar?.['high']);
  } else if (type === 'quote') {
    price = finitePositive(raw['mid']);
    asOfUtcSec = finitePositive(raw['time']);
  }
  if (price === null || asOfUtcSec === null) return;
  const parsed = parseQuote(
    {
      market: 'US',
      symbol,
      kind: previous?.kind ?? 'stock',
      currency: 'USD',
      price,
      previousClose: previous?.previousClose ?? null,
      changePct:
        previous?.previousClose !== null && previous?.previousClose !== undefined && previous.previousClose > 0
          ? ((price - previous.previousClose) / previous.previousClose) * 100
          : previous?.changePct ?? null,
      dayLow: dayLow ?? previous?.dayLow ?? null,
      dayHigh: dayHigh ?? previous?.dayHigh ?? null,
      volume: volume ?? previous?.volume ?? null,
      turnover: previous?.turnover ?? null,
      asOfUtcSec,
      source: 'MASSIVE_WS',
    },
    previous,
    true,
  );
  if (parsed === null) return;
  pendingLegacyQuotes.set(key, parsed);
  scheduleLegacyFlush();
}

function handleMessage(raw: unknown, transport: LiveStreamTransport): void {
  if (typeof raw !== 'string') return;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return;
    if (parsed['type'] === 'MARKET_TICK_BATCH') {
      const accepted = applyBatch(parsed as MarketTickBatchWire, transport);
      if (accepted && transport === 'WS') stopPolling();
    } else {
      applyLegacyStockEvent(parsed);
    }
  } catch {
    // Malformed frames never replace the last valid immutable quote snapshot.
  }
}

async function pollOnce(generation: number): Promise<void> {
  if (pollInFlight) return;
  pollInFlight = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), POLL_REQUEST_TIMEOUT_MS);
  try {
    void refreshBackendHealth();
    const response = await fetch('/api/market/ticks', {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (generation !== pollGeneration) return;
    if (!response.ok) throw new Error(`Market tick polling HTTP ${String(response.status)}`);
    const body = (await response.json()) as MarketTickBatchWire;
    if (generation !== pollGeneration) return;
    if (!applyBatch(body, 'POLL')) throw new Error('Invalid market tick batch');
  } catch {
    if (generation === pollGeneration) {
      notify({ ...state, version: state.version + 1, status: 'RECONNECTING', isLive: false });
    }
  } finally {
    clearTimeout(timeout);
    pollInFlight = false;
  }
}

function startPolling(): void {
  if (pollTimer !== null || managerCount === 0) return;
  const generation = ++pollGeneration;
  notify({ ...state, version: state.version + 1, transport: 'POLL', status: state.isLive ? 'LIVE' : 'RECONNECTING' });
  void pollOnce(generation);
  pollTimer = setInterval(() => {
    void pollOnce(generation);
  }, POLL_INTERVAL_MS);
}

function stopPolling(): void {
  pollGeneration += 1;
  if (pollTimer !== null) clearInterval(pollTimer);
  pollTimer = null;
  pollInFlight = false;
}

function socketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

function connectSocket(): void {
  if (managerCount === 0 || typeof window === 'undefined' || typeof WebSocket === 'undefined') return;
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const generation = ++socketGeneration;
  notify({
    ...state,
    version: state.version + 1,
    status: state.totalBatches > 0 ? 'RECONNECTING' : 'CONNECTING',
    isLive: false,
  });
  let next: WebSocket;
  try {
    next = new WebSocket(socketUrl());
  } catch {
    startPolling();
    reconnectTimer = setTimeout(connectSocket, RECONNECT_INTERVAL_MS);
    return;
  }
  socket = next;
  if (openTimeout !== null) clearTimeout(openTimeout);
  openTimeout = setTimeout(() => {
    if (generation === socketGeneration && next.readyState !== WebSocket.OPEN) startPolling();
  }, WS_OPEN_TIMEOUT_MS);

  next.addEventListener('open', () => {
    if (generation !== socketGeneration) return;
    if (openTimeout !== null) clearTimeout(openTimeout);
    openTimeout = null;
    next.send(JSON.stringify({ action: 'subscribe', symbols: ['*'] }));
    notify({ ...state, version: state.version + 1, status: 'LIVE', transport: 'WS', isLive: true });
    void refreshBackendHealth();
  });
  next.addEventListener('message', (event) => {
    if (generation === socketGeneration) handleMessage(event.data, 'WS');
  });
  const scheduleReconnect = () => {
    if (generation !== socketGeneration) return;
    if (openTimeout !== null) clearTimeout(openTimeout);
    openTimeout = null;
    socket = null;
    notify({ ...state, version: state.version + 1, status: 'RECONNECTING', isLive: false });
    startPolling();
    if (reconnectTimer === null && managerCount > 0) {
      reconnectTimer = setTimeout(connectSocket, RECONNECT_INTERVAL_MS);
    }
  };
  next.addEventListener('close', scheduleReconnect);
  next.addEventListener('error', () => {
    try {
      next.close();
    } catch {
      // The close handler owns fallback/reconnect state.
    }
  });
}

function acquireConnection(): void {
  managerCount += 1;
  if (managerCount > 1) return;
  void refreshBackendHealth();
  connectSocket();
}

function releaseConnection(): void {
  managerCount = Math.max(0, managerCount - 1);
  if (managerCount > 0) return;
  socketGeneration += 1;
  if (openTimeout !== null) clearTimeout(openTimeout);
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  openTimeout = null;
  reconnectTimer = null;
  stopPolling();
  clearPendingLegacy();
  const current = socket;
  socket = null;
  if (current !== null) {
    try {
      current.close(1000, 'ui_unmounted');
    } catch {
      // Deliberate shutdown.
    }
  }
  notify({ ...state, version: state.version + 1, status: 'CONNECTING', transport: null, isLive: false });
}

/**
 * Shared, validated market stream. Only consumers that own the live-feed switch
 * should pass `manageConnection: true`; panel components normally stay passive.
 */
export function useMarketLiveStream(options: { readonly manageConnection?: boolean } = {}): MarketLiveStreamState {
  const manage = options.manageConnection ?? false;
  const subscribe = useCallback(
    (listener: () => void) => {
      listeners.add(listener);
      if (manage) acquireConnection();
      return () => {
        listeners.delete(listener);
        if (manage) releaseConnection();
      };
    },
    [manage],
  );
  const getSnapshot = useCallback(() => state, []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
