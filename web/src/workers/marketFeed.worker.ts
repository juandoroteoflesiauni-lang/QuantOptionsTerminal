import { parseOpraWireRow, coalesceOptionQuoteUpdate, type LiveOptionQuoteSnapshot } from '../../../src/core/opraOptionIntegrity.js';
/**
 * Pieza 49 (Fase 2): Dedicated Web Worker de ingesta WebSocket de mercado.
 *
 * Responsabilidades:
 * - Terminar la conexión WebSocket fuera del Main Thread y ejecutar `JSON.parse`.
 * - Mantener un `MarketStoreSoA` de staging y un `BitmaskConflationEngine`
 *   (`dirtyMask & visibleMask`) para conflación *last-value-wins*.
 * - Protocolo pull bajo demanda con doble buffer `ArrayBuffer` transferible
 *   ping-pong (9600 B < 10 KiB por frame) reciclado mediante `RETURN_BUFFER`.
 * - Reenviar comandos de control (`set_view_scope`, `focus`, `SET_VISIBLE_IDS`)
 *   y eventos estructurales (`bar_update`, `ggal_bar_tick`, L2, FX, etc.).
 */

import {
  BitmaskConflationEngine,
  DEFAULT_SOA_CAPACITY,
  DELTA_FRAME_BUFFER_BYTES,
  MAX_DELTA_ITEMS_PER_FRAME_V2,
  MarketStoreSoA,
  SOA_DELTA_STRIDE_V2,
  normalizeSoaSymbol,
} from '../store/marketStoreSoa';

export type WorkerInboundMessage =
  | { readonly type: 'CONNECT'; readonly url: string }
  | { readonly type: 'CLEAR_OPTION_SLOTS' }
  | { readonly type: 'DISCONNECT' }
  | { readonly type: 'RESYNC_WS'; readonly reason?: string }
  | {
      readonly type: 'SET_VIEW_SCOPE';
      readonly optionScopeEpoch: number;
      readonly view: string;
      readonly focusSymbol: string | null;
      readonly focusMarket: 'AR' | 'US' | null;
    }
  | { readonly type: 'SET_FOCUS_SYMBOL'; readonly symbol: string | null }
  | {
      readonly type: 'SET_VISIBLE_IDS';
      readonly ids: readonly number[];
      readonly symbols?: readonly string[];
      readonly allVisible?: boolean;
    }
  | { readonly type: 'PULL_DELTAS' }
  | { readonly type: 'RETURN_BUFFER'; readonly buffer: ArrayBuffer };

export type WorkerSymbolBinding = readonly [number, string];

export type WorkerOutboundMessage =
  | {
      readonly type: 'WS_STATUS';
      readonly status: 'CONNECTING' | 'LIVE' | 'RECONNECTING';
      readonly transport: 'WS';
      readonly isLive: boolean;
    }
  | { readonly type: 'WS_FALLBACK_POLL' }
  | { readonly type: 'WS_STOP_POLL' }
  | { readonly type: 'DELTAS_READY' }
  | {
      readonly type: 'DELTA_BATCH';
      readonly optionScopeEpoch: number;
      readonly count: number;
      readonly stride: number;
      readonly buffer: ArrayBuffer;
      readonly bindings: readonly WorkerSymbolBinding[];
      readonly hasMore: boolean;
    }
  | {
      readonly type: 'SYMBOL_BINDINGS';
      readonly optionScopeEpoch: number;
      readonly bindings: readonly WorkerSymbolBinding[];
    }
  | {
      readonly type: 'PARSED_WS_MESSAGE';
      readonly optionScopeEpoch: number;
      readonly payload: Record<string, unknown>;
    };

interface WorkerGlobalLike {
  onmessage: ((event: MessageEvent<WorkerInboundMessage>) => void) | null;
  postMessage(message: WorkerOutboundMessage, transfer?: Transferable[]): void;
}

const workerSelf = globalThis as unknown as WorkerGlobalLike;

const WS_OPEN_TIMEOUT_MS = 2_000;
const RECONNECT_INTERVAL_MS = 1_500;

const workerStore = new MarketStoreSoA(DEFAULT_SOA_CAPACITY);
const conflation = new BitmaskConflationEngine(DEFAULT_SOA_CAPACITY);
conflation.setAllVisible(true);

const availableBuffers: ArrayBuffer[] = [
  new ArrayBuffer(DELTA_FRAME_BUFFER_BYTES),
  new ArrayBuffer(DELTA_FRAME_BUFFER_BYTES),
];
const announcedIds = new Uint8Array(DEFAULT_SOA_CAPACITY);
const pendingBindingIds: number[] = [];

let socket: WebSocket | null = null;
let socketUrl = '';
let shouldStayConnected = false;
let socketGeneration = 0;
let openTimeout: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let hasReceivedAnyBatch = false;
let readySignalPending = false;

let optionScopeEpoch = 0;
let focusSymbol: string | null = null;
let viewScope: {
  readonly view: string;
  readonly focusSymbol: string | null;
  readonly focusMarket: 'AR' | 'US' | null;
} | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function finitePositive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function normalizeLiveQuoteKey(
  market: 'AR' | 'US',
  symbol: string,
  settlement?: string | null,
): string {
  const cleanSettlement = settlement?.trim().toUpperCase();
  return cleanSettlement === undefined ||
    cleanSettlement === null ||
    cleanSettlement === '' ||
    cleanSettlement === '24HS' ||
    cleanSettlement === 'T1'
    ? `${market}:${symbol.trim().toUpperCase()}`
    : `${market}:${symbol.trim().toUpperCase()}:${cleanSettlement}`;
}

function normalizeOptionKey(raw: string): string {
  const clean = raw.trim().toUpperCase();
  return clean.startsWith('O:') ? clean.slice(2) : clean;
}

function registerAndTrack(symbol: string): number {
  const id = workerStore.registerSymbol(symbol);
  if (id >= 0 && announcedIds[id] === 0) {
    announcedIds[id] = 1;
    pendingBindingIds.push(id);
  }
  return id;
}

function drainPendingBindings(): WorkerSymbolBinding[] {
  if (pendingBindingIds.length === 0) return [];
  const out: WorkerSymbolBinding[] = [];
  for (let i = 0; i < pendingBindingIds.length; i += 1) {
    const id = pendingBindingIds[i];
    if (id === undefined) continue;
    const sym = workerStore.getSymbol(id);
    if (sym !== undefined) {
      out.push([id, sym]);
    }
  }
  pendingBindingIds.length = 0;
  return out;
}

function notifyDeltasReady(): void {
  if (readySignalPending || !conflation.hasVisibleDirty()) return;
  readySignalPending = true;
  workerSelf.postMessage({ type: 'DELTAS_READY' });
}

function dispatchDeltaBatch(): boolean {
  if (!conflation.hasVisibleDirty()) {
    readySignalPending = false;
    return false;
  }
  const buffer = availableBuffers.pop();
  if (buffer === undefined) {
    return false;
  }
  const view = new Float64Array(buffer);
  const count = conflation.packVisibleDirtyDelta(
    workerStore,
    view,
    MAX_DELTA_ITEMS_PER_FRAME_V2,
    SOA_DELTA_STRIDE_V2,
  );
  if (count <= 0) {
    availableBuffers.push(buffer);
    readySignalPending = false;
    return false;
  }
  const bindings = drainPendingBindings();
  const hasMore = conflation.hasVisibleDirty();
  readySignalPending = false;
  workerSelf.postMessage(
    {
      type: 'DELTA_BATCH', optionScopeEpoch,
      count,
      stride: SOA_DELTA_STRIDE_V2,
      buffer,
      bindings,
      hasMore,
    },
    [buffer],
  );
  return true;
}

function ingestMarketQuoteArray(rawQuotes: unknown, fallbackTs: number): void {
  if (!Array.isArray(rawQuotes)) return;
  for (let i = 0; i < rawQuotes.length; i += 1) {
    const raw = rawQuotes[i];
    if (!isRecord(raw)) continue;
    const market = raw['market'];
    const symbolRaw = raw['symbol'];
    const price = finitePositive(raw['price']);
    if ((market !== 'AR' && market !== 'US') || typeof symbolRaw !== 'string' || price === null) {
      continue;
    }
    const settlement = typeof raw['settlement'] === 'string' ? raw['settlement'] : null;
    const key = normalizeLiveQuoteKey(market, symbolRaw, settlement);
    const id = registerAndTrack(key);
    if (id < 0) continue;
    const ts = finitePositive(raw['asOfUtcSec']) ?? fallbackTs;
    const bidVal = finitePositive(raw['bid']) ?? Number.NaN;
    const askVal = finitePositive(raw['ask']) ?? Number.NaN;
    const bidSz = finiteNumber(raw['bidSize']) ?? Number.NaN;
    const askSz = finiteNumber(raw['askSize']) ?? Number.NaN;
    workerStore.writeQuoteInPlace(id, bidVal, askVal, price, bidSz, askSz, ts);
    conflation.markDirty(id);
  }
}

const optionRows = new Map<string, LiveOptionQuoteSnapshot>();

function clearOptionSlots(): void {
  optionRows.clear();
  workerStore.resetOptionSlots((id) => {
    conflation.clearDirty(id);
    announcedIds[id] = 0;
  });
}

function ingestOptionQuoteArray(rawQuotes: unknown): void {
  if (!Array.isArray(rawQuotes)) return;
  for (const raw of rawQuotes) {
    if (!isRecord(raw) || typeof raw['symbol'] !== 'string') continue;
    const key = normalizeOptionKey(raw['symbol']);
    const previous = optionRows.get(key);
    const next = coalesceOptionQuoteUpdate(previous, parseOpraWireRow(raw, key));
    if (next === previous || !next.updatedChannels?.length) continue;
    const id = registerAndTrack(key);
    if (id < 0) continue;
    optionRows.set(key, next);
    workerStore.writeOptionSnapshot(id, next);
    conflation.markDirty(id);
  }
}

function ingestLegacyEventToSoa(raw: Record<string, unknown>, fallbackTs: number): void {
  if (raw['cluster'] !== 'stocks' || typeof raw['symbol'] !== 'string') return;
  const sym = normalizeSoaSymbol(raw['symbol']);
  if (sym === '') return;
  const key = normalizeLiveQuoteKey('US', sym);
  const type = raw['type'];
  let price = Number.NaN;
  let bidVal = Number.NaN;
  let askVal = Number.NaN;
  const ts = finitePositive(raw['time']) ?? fallbackTs;

  if (type === 'trade') {
    price = finitePositive(raw['price']) ?? Number.NaN;
  } else if (type === 'quote') {
    price = finitePositive(raw['mid']) ?? Number.NaN;
    bidVal = finitePositive(raw['bid']) ?? Number.NaN;
    askVal = finitePositive(raw['ask']) ?? Number.NaN;
  } else if (type === 'bar_update') {
    const forming = isRecord(raw['formingBar']) ? raw['formingBar'] : null;
    const closed = isRecord(raw['lastClosedBar']) ? raw['lastClosedBar'] : null;
    const bar = forming ?? closed;
    price = finitePositive(bar?.['close']) ?? Number.NaN;
  }
  if (!Number.isFinite(price) && !Number.isFinite(bidVal) && !Number.isFinite(askVal)) {
    return;
  }
  const id = registerAndTrack(key);
  if (id < 0) return;
  workerStore.writeQuoteInPlace(id, bidVal, askVal, price, Number.NaN, Number.NaN, ts);
  conflation.markDirty(id);
}

function ingestOrderBookToSoa(rawBook: unknown, fallbackTs: number): void {
  if (!isRecord(rawBook) || typeof rawBook['symbol'] !== 'string') return;
  const sym = normalizeSoaSymbol(rawBook['symbol']);
  if (sym === '') return;
  const bids = Array.isArray(rawBook['bids']) ? rawBook['bids'] : [];
  const asks = Array.isArray(rawBook['asks']) ? rawBook['asks'] : [];
  const bestBidRow = isRecord(bids[0]) ? bids[0] : null;
  const bestAskRow = isRecord(asks[0]) ? asks[0] : null;
  const bestBid = bestBidRow !== null ? (finitePositive(bestBidRow['price']) ?? Number.NaN) : Number.NaN;
  const bestAsk = bestAskRow !== null ? (finitePositive(bestAskRow['price']) ?? Number.NaN) : Number.NaN;
  const bestBidSz = bestBidRow !== null ? (finiteNumber(bestBidRow['size']) ?? Number.NaN) : Number.NaN;
  const bestAskSz = bestAskRow !== null ? (finiteNumber(bestAskRow['size']) ?? Number.NaN) : Number.NaN;
  if (!Number.isFinite(bestBid) && !Number.isFinite(bestAsk)) return;
  const id = registerAndTrack(`AR:${sym}`);
  if (id < 0) return;
  const ts = finitePositive(rawBook['asOfUtcSec']) ?? fallbackTs;
  workerStore.writeQuoteInPlace(id, bestBid, bestAsk, Number.NaN, bestBidSz, bestAskSz, ts);
  conflation.markDirty(id);
}

function handleParsedFrame(parsed: Record<string, unknown>): void {
  const nowSec = finitePositive(parsed['serverTimeSec']) ?? Math.floor(Date.now() / 1_000);
  const type = parsed['type'];

  if (type === 'MARKET_TICK_BATCH' || type === 'TICK_DELTA') {
    hasReceivedAnyBatch = true;
    ingestMarketQuoteArray(parsed['quotes'], nowSec);
    ingestOrderBookToSoa(parsed['liveOrderBook'], nowSec);
    workerSelf.postMessage({ type: 'WS_STOP_POLL' });
    workerSelf.postMessage({ type: 'PARSED_WS_MESSAGE', optionScopeEpoch, payload: parsed });
    notifyDeltasReady();
    return;
  }

  if (type === 'market_batch') {
    hasReceivedAnyBatch = true;
    const delta = isRecord(parsed['delta']) ? parsed['delta'] : null;
    if (delta !== null) {
      ingestMarketQuoteArray(delta['quotes'], nowSec);
      ingestOrderBookToSoa(delta['liveOrderBook'], nowSec);
    }
    const events = Array.isArray(parsed['events']) ? parsed['events'] : [];
    for (let i = 0; i < events.length; i += 1) {
      const ev = events[i];
      if (isRecord(ev)) {
        ingestLegacyEventToSoa(ev, nowSec);
      }
    }
    workerSelf.postMessage({ type: 'WS_STOP_POLL' });
    workerSelf.postMessage({ type: 'PARSED_WS_MESSAGE', optionScopeEpoch, payload: parsed });
    notifyDeltasReady();
    return;
  }

  if (type === 'option_quotes_batch') {
    if (viewScope && (viewScope.view !== 'options' || viewScope.focusSymbol !== parsed['underlying'])) return;
    ingestOptionQuoteArray(parsed['quotes']);
    workerSelf.postMessage({ type: 'WS_STOP_POLL' });
    workerSelf.postMessage({ type: 'PARSED_WS_MESSAGE', optionScopeEpoch, payload: parsed });
    notifyDeltasReady();
    return;
  }

  if (type === 'ggal_bar_tick') {
    workerSelf.postMessage({ type: 'PARSED_WS_MESSAGE', optionScopeEpoch, payload: parsed });
    return;
  }

  ingestLegacyEventToSoa(parsed, nowSec);
  workerSelf.postMessage({ type: 'PARSED_WS_MESSAGE', optionScopeEpoch, payload: parsed });
  notifyDeltasReady();
}

function sendFocusToSocket(): void {
  if (socket === null || socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify({ action: 'focus', symbol: focusSymbol ?? '' }));
  } catch {
    // Un fallo de envío no tumba el socket compartido.
  }
}

function sendViewScopeToSocket(): void {
  if (socket === null || socket.readyState !== WebSocket.OPEN || viewScope === null) return;
  try {
    socket.send(
      JSON.stringify({
        type: 'set_view_scope',
        view: viewScope.view,
        focusSymbol: viewScope.focusSymbol,
        focusMarket: viewScope.focusMarket,
      }),
    );
  } catch {
    // Un fallo de envío no tumba el socket compartido.
  }
}

function clearTimers(): void {
  if (openTimeout !== null) {
    clearTimeout(openTimeout);
    openTimeout = null;
  }
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function closeSocket(code = 1_000, reason = 'worker_disconnect'): void {
  const current = socket;
  socket = null;
  if (current !== null) {
    try {
      current.close(code, reason);
    } catch {
      // Cierre controlado.
    }
  }
}

function connectSocket(): void {
  if (!shouldStayConnected || socketUrl === '' || typeof WebSocket === 'undefined') return;
  clearTimers();
  const generation = ++socketGeneration;

  workerSelf.postMessage({
    type: 'WS_STATUS',
    status: hasReceivedAnyBatch ? 'RECONNECTING' : 'CONNECTING',
    transport: 'WS',
    isLive: false,
  });

  let next: WebSocket;
  try {
    next = new WebSocket(socketUrl);
  } catch {
    workerSelf.postMessage({ type: 'WS_FALLBACK_POLL' });
    reconnectTimer = setTimeout(connectSocket, RECONNECT_INTERVAL_MS);
    return;
  }
  socket = next;

  openTimeout = setTimeout(() => {
    if (generation === socketGeneration && next.readyState !== WebSocket.OPEN) {
      workerSelf.postMessage({ type: 'WS_FALLBACK_POLL' });
    }
  }, WS_OPEN_TIMEOUT_MS);

  next.addEventListener('open', () => {
    if (generation !== socketGeneration) return;
    if (openTimeout !== null) {
      clearTimeout(openTimeout);
      openTimeout = null;
    }
    try {
      next.send(JSON.stringify({ action: 'subscribe', symbols: ['*'] }));
    } catch {
      // Ignora error transitorio de envío inicial.
    }
    sendFocusToSocket();
    sendViewScopeToSocket();
    workerSelf.postMessage({
      type: 'WS_STATUS',
      status: 'LIVE',
      transport: 'WS',
      isLive: true,
    });
  });

  next.addEventListener('message', (event) => {
    if (generation !== socketGeneration || typeof event.data !== 'string') return;
    try {
      const parsed: unknown = JSON.parse(event.data);
      if (isRecord(parsed)) {
        handleParsedFrame(parsed);
      }
    } catch {
      // Frames malformados no corrompen el store SoA.
    }
  });

  const handleDisconnect = (): void => {
    if (generation !== socketGeneration) return;
    if (openTimeout !== null) {
      clearTimeout(openTimeout);
      openTimeout = null;
    }
    socket = null;
    workerSelf.postMessage({
      type: 'WS_STATUS',
      status: 'RECONNECTING',
      transport: 'WS',
      isLive: false,
    });
    workerSelf.postMessage({ type: 'WS_FALLBACK_POLL' });
    if (shouldStayConnected && reconnectTimer === null) {
      reconnectTimer = setTimeout(connectSocket, RECONNECT_INTERVAL_MS);
    }
  };

  next.addEventListener('close', handleDisconnect);
  next.addEventListener('error', () => {
    try {
      next.close();
    } catch {
      // El evento close gestiona el reconnect.
    }
  });
}

function handleSetVisibleIds(
  ids: readonly number[],
  symbols?: readonly string[],
  allVisible?: boolean,
): void {
  if (allVisible === true) {
    conflation.setAllVisible(true);
    notifyDeltasReady();
    return;
  }

  const resolvedIds: number[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    if (id !== undefined && Number.isInteger(id) && id >= 0 && id < workerStore.capacity) {
      resolvedIds.push(id);
    }
  }
  if (symbols !== undefined) {
    for (let i = 0; i < symbols.length; i += 1) {
      const rawSym = symbols[i];
      if (rawSym === undefined || rawSym.trim() === '') continue;
      const id = registerAndTrack(rawSym);
      if (id >= 0) {
        resolvedIds.push(id);
      }
    }
  }
  conflation.setVisibleIds(resolvedIds);
  const newBindings = drainPendingBindings();
  if (newBindings.length > 0) {
    workerSelf.postMessage({ type: 'SYMBOL_BINDINGS', optionScopeEpoch, bindings: newBindings });
  }
  notifyDeltasReady();
}

workerSelf.onmessage = (event: MessageEvent<WorkerInboundMessage>): void => {
  const msg = event.data;
  if (msg.type === 'CONNECT') {
    socketUrl = msg.url;
    shouldStayConnected = true;
    if (
      socket !== null &&
      (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)
    ) {
      return;
    }
    connectSocket();
    return;
  }
  if (msg.type === 'DISCONNECT') {
    shouldStayConnected = false;
    socketGeneration += 1;
    clearTimers();
    closeSocket(1_000, 'ui_unmounted');
    return;
  }
  if (msg.type === 'RESYNC_WS') {
    socketGeneration += 1;
    clearTimers();
    closeSocket(4_000, msg.reason ?? 'delta_resync_required');
    if (shouldStayConnected) {
      connectSocket();
    }
    return;
  }
  if (msg.type === 'CLEAR_OPTION_SLOTS') { clearOptionSlots(); return; }
  if (msg.type === 'SET_VIEW_SCOPE') {
    optionScopeEpoch = msg.optionScopeEpoch;
    if (viewScope?.view === 'options' && (viewScope.focusSymbol !== msg.focusSymbol || msg.view !== 'options')) clearOptionSlots();
    viewScope = {
      view: msg.view,
      focusSymbol: msg.focusSymbol,
      focusMarket: msg.focusMarket,
    };
    sendViewScopeToSocket();
    return;
  }
  if (msg.type === 'SET_FOCUS_SYMBOL') {
    focusSymbol = msg.symbol;
    sendFocusToSocket();
    return;
  }
  if (msg.type === 'SET_VISIBLE_IDS') {
    handleSetVisibleIds(msg.ids, msg.symbols, msg.allVisible);
    return;
  }
  if (msg.type === 'PULL_DELTAS') {
    dispatchDeltaBatch();
    return;
  }
  if (msg.type === 'RETURN_BUFFER') {
    if (msg.buffer.byteLength === DELTA_FRAME_BUFFER_BYTES && availableBuffers.length < 2) {
      availableBuffers.push(msg.buffer);
    }
    if (conflation.hasVisibleDirty()) {
      notifyDeltasReady();
    }
  }
};
