import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { appendLiveTapeTick, type LiveFxSnapshot, type LiveTapeTick } from '../../../src/core/realtimePropagation';
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
  readonly source: 'BMB_HOMEBROKER' | 'IOL_REST' | 'BCRA_LECAP_REF';
  readonly referenceInstrument: string;
}

export interface MarketLiveOrderBookLevel {
  readonly price: number;
  readonly size: number;
  readonly orderCount: number | null;
}

export interface MarketLiveOrderBook {
  readonly symbol: string;
  readonly bids: readonly MarketLiveOrderBookLevel[];
  readonly asks: readonly MarketLiveOrderBookLevel[];
  readonly microprice: number | null;
  readonly micropriceL1: number | null;
  readonly vpin: number | null;
  readonly asOfUtcSec: number | null;
  readonly source: string;
}

export interface MarketLiveFuture {
  readonly contract: string;
  readonly category: 'OUTRIGHT' | 'MINI' | 'SPREAD' | 'OPTION' | 'SPOT' | 'OTHER';
  readonly maturity: string | null;
  readonly days: number | null;
  readonly price: number | null;
  readonly priceBasis: 'LAST' | 'MID' | 'SETTLEMENT_EOD' | 'NONE';
  readonly last: number | null;
  readonly settlement: number | null;
  readonly close: number | null;
  readonly bid: number | null;
  readonly bidPrice: number | null;
  readonly bidSize: number | null;
  readonly ask: number | null;
  readonly askPrice: number | null;
  readonly askSize: number | null;
  readonly openInterest: number | null;
  readonly nominalVolume: number | null;
  readonly spotUsed: number | null;
  readonly spotSource: 'A3500_BCRA' | 'DLR_SPOT' | 'NONE';
  readonly devalDirectaPct: number | null;
  readonly tnaImplicitaPct: number | null;
  readonly teaImplicitaPct: number | null;
  readonly temImplicitaPct: number | null;
  readonly forwardToForwardPct: number | null;
  readonly updatedAtUtcSec: number | null;
  readonly source: 'PRIMARY_ROFEX';
}

export interface MarketLiveStreamState {
  readonly version: number;
  readonly status: 'CONNECTING' | 'LIVE' | 'RECONNECTING';
  readonly transport: LiveStreamTransport | null;
  readonly isLive: boolean;
  readonly quotesBySymbol: Readonly<Record<string, MarketLiveQuote>>;
  readonly liveFx: LiveFxSnapshot | null;
  readonly liveOrderBook: MarketLiveOrderBook | null;
  readonly liveTape: readonly LiveTapeTick[];
  readonly cclMedian: number | null;
  readonly mepMedian: number | null;
  readonly arSourceMode: 'LIVE_BMB' | 'LIVE_IOL' | 'DATA912' | 'NO_DATA';
  readonly usSourceMode: 'MASSIVE_WS' | 'MASSIVE_BATCH' | 'NO_DATA';
  readonly cauciones: readonly MarketLiveCaucion[];
  readonly futures: readonly MarketLiveFuture[];
  readonly futuresSource: 'PRIMARY_WS' | 'PRIMARY_REST' | 'NONE';
  readonly lastServerTimeSec: number | null;
  readonly lastReceivedAtMs: number | null;
  readonly ticksPerSecond: number;
  readonly totalBatches: number;
}

interface MarketTickBatchWire {
  readonly type?: unknown;
  readonly sequence?: unknown;
  readonly deltaRevision?: unknown;
  readonly serverTimeSec?: unknown;
  readonly quotes?: unknown;
  readonly removed?: unknown;
  readonly liveFx?: unknown;
  readonly liveOrderBook?: unknown;
  readonly tape?: unknown;
  readonly cclMedian?: unknown;
  readonly mepMedian?: unknown;
  readonly arSourceMode?: unknown;
  readonly usSourceMode?: unknown;
  readonly cauciones?: unknown;
  readonly futures?: unknown;
  readonly futuresSource?: unknown;
}

interface MarketBatchWire {
  readonly type?: unknown;
  readonly serverTimeSec?: unknown;
  readonly focusSymbol?: unknown;
  readonly events?: unknown;
  readonly delta?: unknown;
}

const WS_OPEN_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 2_000;
const POLL_REQUEST_TIMEOUT_MS = 2_500;
const QUOTE_RECEIVE_FRESHNESS_MS = 40_000;
const LEGACY_FLUSH_INTERVAL_MS = 16;
const RECONNECT_INTERVAL_MS = 1_500;
const RELEASE_DEBOUNCE_MS = 150;

let state: MarketLiveStreamState = {
  version: 0,
  status: 'CONNECTING',
  transport: null,
  isLive: false,
  quotesBySymbol: {},
  liveFx: null,
  liveOrderBook: null,
  liveTape: [],
  cclMedian: null,
  mepMedian: null,
  arSourceMode: 'NO_DATA',
  usSourceMode: 'NO_DATA',
  cauciones: [],
  futures: [],
  futuresSource: 'NONE',
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
let releaseTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollInFlight = false;
let pollGeneration = 0;
let lastBatchReceivedAtMs: number | null = null;
let lastDeltaRevision = 0;
let marketFocusSymbol: string | null = null;
const pendingLegacyQuotes = new Map<string, MarketLiveQuote>();
let legacyFlushTimer: ReturnType<typeof setTimeout> | null = null;
const pendingMarketBatches: MarketBatchWire[] = [];
let marketBatchFlushHandle: number | null = null;
let pendingMarketBatchTransport: LiveStreamTransport = 'WS';

function sendFocusMessage(): void {
  if (socket === null || socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify({ action: 'focus', symbol: marketFocusSymbol ?? '' }));
  } catch {
    // Un fallo de envío no tumba el socket compartido.
  }
}

export function setMarketFocusSymbol(symbol: string | null | undefined): void {
  const next = symbol === null || symbol === undefined || symbol.trim() === '' ? null : symbol.trim().toUpperCase();
  if (marketFocusSymbol === next) return;
  marketFocusSymbol = next;
  sendFocusMessage();
}

/** Pieza 40: enfoca un símbolo mientras el componente está montado. */
export function useMarketFocusSymbol(symbol: string | null | undefined): void {
  const normalized = symbol === null || symbol === undefined || symbol.trim() === '' ? null : symbol.trim().toUpperCase();
  useEffect(() => {
    setMarketFocusSymbol(normalized);
    return () => {
      setMarketFocusSymbol(null);
    };
  }, [normalized]);
}

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

export function getMarketLiveClock(snapshot: MarketLiveStreamState): string | null {
  if (!isMarketLiveStreamFresh(snapshot) || snapshot.lastReceivedAtMs === null) return null;
  return new Date(snapshot.lastReceivedAtMs).toLocaleTimeString('es-AR', { hour12: false });
}

export function tickFlashClass(direction: 'up' | 'down' | null): string {
  if (direction === 'up') {
    return 'border-b-2 border-[#22C55E] bg-[#22C55E]/15 text-[#4ADE80]';
  }
  if (direction === 'down') {
    return 'border-b-2 border-[#EF4444] bg-[#EF4444]/15 text-[#F87171]';
  }
  return 'border-b-2 border-transparent';
}

export function useTickFlash(value: number | null): 'up' | 'down' | null {
  const previousRef = useRef<number | null>(value);
  const [flash, setFlash] = useState<{ readonly direction: 'up' | 'down'; readonly id: number } | null>(null);
  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = value;
    if (
      previous === null || value === null || !Number.isFinite(previous) || !Number.isFinite(value) ||
      Math.abs(previous - value) <= 1e-9
    ) {
      setFlash(null);
      return;
    }
    setFlash({ direction: value > previous ? 'up' : 'down', id: Date.now() });
    const timer = setTimeout(() => setFlash(null), 650);
    return () => clearTimeout(timer);
  }, [value]);
  return flash?.direction ?? null;
}

export function useLivePriceFlash(value: number | null): 'up' | 'down' | null {
  return useTickFlash(value);
}

export function useThrottledLiveValue<T>(value: T, intervalMs = 1_000): T {
  const [throttled, setThrottled] = useState<T>(value);
  const lastUpdateAtMsRef = useRef<number>(0);
  useEffect(() => {
    const now = Date.now();
    const elapsedMs = now - lastUpdateAtMsRef.current;
    if (elapsedMs >= intervalMs) {
      lastUpdateAtMsRef.current = now;
      setThrottled(value);
      return;
    }
    const timer = setTimeout(() => {
      lastUpdateAtMsRef.current = Date.now();
      setThrottled(value);
    }, intervalMs - elapsedMs);
    return () => clearTimeout(timer);
  }, [value, intervalMs]);
  return throttled;
}

export function getMarketLiveQuote(
  snapshot: MarketLiveStreamState,
  market: LiveStreamMarket,
  symbol: string,
): MarketLiveQuote | null {
  if (!isMarketLiveStreamFresh(snapshot)) return null;
  return snapshot.quotesBySymbol[liveQuoteKey(market, symbol)] ?? null;
}

export function pushLiveOrderBook(snapshot: MarketLiveOrderBook): void {
  notify({ ...state, version: state.version + 1, liveOrderBook: snapshot });
}

export function getMarketLiveFx(snapshot: MarketLiveStreamState): LiveFxSnapshot | null {
  if (!isMarketLiveStreamFresh(snapshot)) return null;
  return snapshot.liveFx;
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

function parseLiveFx(raw: unknown): LiveFxSnapshot | null {
  if (!isRecord(raw)) return null;
  const mepMedian = finitePositive(raw['mepMedian']);
  const cclMedian = finitePositive(raw['cclMedian']);
  const cclImplicitGgal = finitePositive(raw['cclImplicitGgal']);
  const canjePctRaw = raw['canjePct'];
  const canjePct = typeof canjePctRaw === 'number' && Number.isFinite(canjePctRaw) ? canjePctRaw : null;
  if (mepMedian === null && cclMedian === null && cclImplicitGgal === null && canjePct === null) {
    return null;
  }
  return { mepMedian, cclMedian, cclImplicitGgal, canjePct };
}

function parseOrderBook(raw: unknown): MarketLiveOrderBook | null {
  if (!isRecord(raw) || typeof raw['symbol'] !== 'string' || raw['symbol'].trim() === '') return null;
  const parseLevels = (value: unknown): MarketLiveOrderBookLevel[] => {
    if (!Array.isArray(value)) return [];
    const levels: MarketLiveOrderBookLevel[] = [];
    for (const levelRaw of value) {
      if (!isRecord(levelRaw)) continue;
      const price = finitePositive(levelRaw['price']);
      const sizeRaw = levelRaw['size'];
      const size = typeof sizeRaw === 'number' && Number.isFinite(sizeRaw) && sizeRaw >= 0 ? sizeRaw : null;
      if (price === null || size === null) continue;
      const orderCountRaw = levelRaw['orderCount'];
      const orderCount =
        typeof orderCountRaw === 'number' && Number.isInteger(orderCountRaw) && orderCountRaw >= 0
          ? orderCountRaw
          : null;
      levels.push({ price, size, orderCount });
    }
    return levels;
  };
  const micropriceRaw = raw['microprice'];
  const micropriceL1Raw = raw['micropriceL1'];
  const vpinRaw = raw['vpin'];
  return {
    symbol: raw['symbol'].trim().toUpperCase(),
    bids: parseLevels(raw['bids']),
    asks: parseLevels(raw['asks']),
    microprice: typeof micropriceRaw === 'number' && Number.isFinite(micropriceRaw) ? micropriceRaw : null,
    micropriceL1: typeof micropriceL1Raw === 'number' && Number.isFinite(micropriceL1Raw) ? micropriceL1Raw : null,
    vpin: typeof vpinRaw === 'number' && Number.isFinite(vpinRaw) ? vpinRaw : null,
    asOfUtcSec: finitePositive(raw['asOfUtcSec']),
    source: typeof raw['source'] === 'string' && raw['source'].trim() !== '' ? raw['source'].trim() : 'UNKNOWN',
  };
}

function parseTape(raw: unknown): readonly LiveTapeTick[] {
  if (!Array.isArray(raw)) return [];
  const tape: LiveTapeTick[] = [];
  for (const tickRaw of raw) {
    if (!isRecord(tickRaw)) continue;
    const market = tickRaw['market'];
    const symbolRaw = tickRaw['symbol'];
    const price = finitePositive(tickRaw['price']);
    const timeSec = finitePositive(tickRaw['timeSec']);
    if ((market !== 'AR' && market !== 'US') || typeof symbolRaw !== 'string' || symbolRaw.trim() === '' || price === null || timeSec === null) continue;
    const sizeRaw = tickRaw['size'];
    const size = typeof sizeRaw === 'number' && Number.isFinite(sizeRaw) && sizeRaw >= 0 ? sizeRaw : null;
    const sideRaw = tickRaw['side'];
    const side = sideRaw === 'BUY' || sideRaw === 'SELL' ? sideRaw : null;
    tape.push({ market, symbol: symbolRaw.trim().toUpperCase(), price, size, side, timeSec });
  }
  return tape;
}

function deriveTapeTickFromQuote(
  quote: MarketLiveQuote,
  previous: MarketLiveQuote | null,
): LiveTapeTick | null {
  if (quote.direction === null || quote.asOfUtcSec === null) return null;
  const size =
    previous !== null && quote.volume !== null && previous.volume !== null
      ? Math.max(0, quote.volume - previous.volume)
      : null;
  return {
    market: quote.market,
    symbol: quote.symbol,
    price: quote.price,
    size,
    side: quote.direction === 'up' ? 'BUY' : 'SELL',
    timeSec: quote.asOfUtcSec,
  };
}

function pushTapeTick(tape: readonly LiveTapeTick[], tick: LiveTapeTick): readonly LiveTapeTick[] {
  return appendLiveTapeTick(tape, tick);
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
    source: raw['source'] === 'BMB_HOMEBROKER' ? 'BMB_HOMEBROKER' : raw['source'] === 'IOL_REST' ? 'IOL_REST' : 'BCRA_LECAP_REF',
    referenceInstrument:
      typeof raw['referenceInstrument'] === 'string' && raw['referenceInstrument'] !== ''
        ? raw['referenceInstrument']
        : `Caución ${String(Math.round(termDays))}d`,
  };
}

function parseFuture(raw: unknown): MarketLiveFuture | null {
  if (!isRecord(raw) || typeof raw['contract'] !== 'string' || raw['contract'].trim() === '') {
    return null;
  }
  const categoryRaw = raw['category'];
  const category =
    categoryRaw === 'OUTRIGHT' ||
    categoryRaw === 'MINI' ||
    categoryRaw === 'SPREAD' ||
    categoryRaw === 'OPTION' ||
    categoryRaw === 'SPOT' ||
    categoryRaw === 'OTHER'
      ? categoryRaw
      : 'OTHER';
  const priceBasisRaw = raw['priceBasis'];
  const priceBasis =
    priceBasisRaw === 'LAST' ||
    priceBasisRaw === 'MID' ||
    priceBasisRaw === 'SETTLEMENT_EOD' ||
    priceBasisRaw === 'NONE'
      ? priceBasisRaw
      : 'NONE';
  const spotSourceRaw = raw['spotSource'];
  const spotSource =
    spotSourceRaw === 'A3500_BCRA' || spotSourceRaw === 'DLR_SPOT' || spotSourceRaw === 'NONE'
      ? spotSourceRaw
      : 'NONE';
  return {
    contract: raw['contract'].trim().toUpperCase(),
    category,
    maturity: typeof raw['maturity'] === 'string' && raw['maturity'] !== '' ? raw['maturity'] : null,
    days: nullableNumber(raw['days']),
    price: nullableNumber(raw['price']),
    priceBasis,
    last: nullableNumber(raw['last']),
    settlement: nullableNumber(raw['settlement']),
    close: nullableNumber(raw['close']),
    bid: nullableNumber(raw['bid']),
    bidPrice: nullableNumber(raw['bidPrice']),
    bidSize: nullableNumber(raw['bidSize']),
    ask: nullableNumber(raw['ask']),
    askPrice: nullableNumber(raw['askPrice']),
    askSize: nullableNumber(raw['askSize']),
    openInterest: nullableNumber(raw['openInterest']),
    nominalVolume: nullableNumber(raw['nominalVolume']),
    spotUsed: nullableNumber(raw['spotUsed']),
    spotSource,
    devalDirectaPct: nullableNumber(raw['devalDirectaPct']),
    tnaImplicitaPct: nullableNumber(raw['tnaImplicitaPct']),
    teaImplicitaPct: nullableNumber(raw['teaImplicitaPct']),
    temImplicitaPct: nullableNumber(raw['temImplicitaPct']),
    forwardToForwardPct: nullableNumber(raw['forwardToForwardPct']),
    updatedAtUtcSec: finitePositive(raw['updatedAtUtcSec']),
    source: 'PRIMARY_ROFEX',
  };
}

function parseFutures(raw: unknown): readonly MarketLiveFuture[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.map(parseFuture).filter((row): row is MarketLiveFuture => row !== null);
}

function applyBatch(batch: MarketTickBatchWire, transport: LiveStreamTransport): boolean {
  if (batch.type !== 'MARKET_TICK_BATCH' || !Array.isArray(batch.quotes)) return false;
  clearPendingLegacy();
  const snapshotRevision = finiteNumber(batch.deltaRevision);
  if (snapshotRevision !== null && Number.isInteger(snapshotRevision) && snapshotRevision >= 0) {
    lastDeltaRevision = snapshotRevision;
  }
  const receivedAtMs = Date.now();
  const elapsedSec =
    lastBatchReceivedAtMs === null ? null : Math.max(0.001, (receivedAtMs - lastBatchReceivedAtMs) / 1_000);
  lastBatchReceivedAtMs = receivedAtMs;

  const arSourceMode =
    batch.arSourceMode === 'LIVE_BMB' || batch.arSourceMode === 'LIVE_IOL' || batch.arSourceMode === 'DATA912' || batch.arSourceMode === 'NO_DATA'
      ? batch.arSourceMode
      : state.arSourceMode;
  const usSourceMode =
    batch.usSourceMode === 'MASSIVE_WS' || batch.usSourceMode === 'MASSIVE_BATCH' || batch.usSourceMode === 'NO_DATA'
      ? batch.usSourceMode
      : state.usSourceMode;
  const previousQuotes = state.quotesBySymbol;
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
  const parsedFutures = parseFutures(batch.futures);
  const futures = arSourceMode === 'NO_DATA' ? [] : (parsedFutures ?? state.futures);
  const futuresSource =
    arSourceMode === 'NO_DATA'
      ? 'NONE'
      : batch.futuresSource === 'PRIMARY_WS' || batch.futuresSource === 'PRIMARY_REST'
        ? batch.futuresSource
        : state.futuresSource;
  const parsedLiveFx = parseLiveFx(batch.liveFx);
  const liveFx = parsedLiveFx ?? state.liveFx;
  const parsedOrderBook = parseOrderBook(batch.liveOrderBook);
  const liveOrderBook = parsedOrderBook ?? state.liveOrderBook;
  let liveTape = Array.isArray(batch.tape) ? parseTape(batch.tape) : state.liveTape;
  for (const [key, parsedQuote] of Object.entries(nextQuotes)) {
    const previousQuote = previousQuotes[key] ?? null;
    const tapeTick = deriveTapeTickFromQuote(parsedQuote, previousQuote);
    if (tapeTick !== null) {
      liveTape = pushTapeTick(liveTape, tapeTick);
    }
  }

  notify({
    ...state,
    version: state.version + 1,
    status: 'LIVE',
    transport,
    isLive: true,
    quotesBySymbol: nextQuotes,
    liveFx,
    liveOrderBook,
    liveTape,
    cclMedian: arSourceMode === 'NO_DATA' ? null : batch.cclMedian === null ? null : finitePositive(batch.cclMedian) ?? state.cclMedian,
    mepMedian: arSourceMode === 'NO_DATA' ? null : batch.mepMedian === null ? null : finitePositive(batch.mepMedian) ?? state.mepMedian,
    arSourceMode,
    usSourceMode,
    cauciones,
    futures,
    futuresSource,
    lastServerTimeSec: finitePositive(batch.serverTimeSec) ?? state.lastServerTimeSec,
    lastReceivedAtMs: receivedAtMs,
    ticksPerSecond: elapsedSec === null ? 0 : Math.round(changedTicks / elapsedSec),
    totalBatches: state.totalBatches + 1,
  });
  return true;
}

function applyTickDelta(batch: MarketTickBatchWire, transport: LiveStreamTransport): boolean {
  if (batch.type !== 'TICK_DELTA' || !Array.isArray(batch.quotes)) return false;
  const revision = finiteNumber(batch.deltaRevision);
  if (revision === null || !Number.isInteger(revision) || revision < 0) return false;
  if (revision <= lastDeltaRevision) return true;
  if (revision > lastDeltaRevision + 1) return false;
  clearPendingLegacy();
  const receivedAtMs = Date.now();
  const elapsedSec = lastBatchReceivedAtMs === null ? null : Math.max(0.001, (receivedAtMs - lastBatchReceivedAtMs) / 1_000);
  lastBatchReceivedAtMs = receivedAtMs;
  const arSourceMode =
    batch.arSourceMode === 'LIVE_BMB' || batch.arSourceMode === 'LIVE_IOL' || batch.arSourceMode === 'DATA912' || batch.arSourceMode === 'NO_DATA'
      ? batch.arSourceMode
      : state.arSourceMode;
  const usSourceMode =
    batch.usSourceMode === 'MASSIVE_WS' || batch.usSourceMode === 'MASSIVE_BATCH' || batch.usSourceMode === 'NO_DATA'
      ? batch.usSourceMode
      : state.usSourceMode;
  const nextQuotes: Record<string, MarketLiveQuote> = { ...state.quotesBySymbol };
  if (arSourceMode === 'NO_DATA' || usSourceMode === 'NO_DATA') {
    for (const [key, quote] of Object.entries(nextQuotes)) {
      if ((quote.market === 'AR' && arSourceMode === 'NO_DATA') || (quote.market === 'US' && usSourceMode === 'NO_DATA')) {
        delete nextQuotes[key];
      }
    }
  }
  if (Array.isArray(batch.removed)) {
    for (const key of batch.removed) {
      if (typeof key === 'string') delete nextQuotes[key];
    }
  }
  let changedTicks = 0;
  for (const raw of batch.quotes) {
    if (!isRecord(raw) || typeof raw['symbol'] !== 'string') continue;
    const market = raw['market'];
    if (market !== 'AR' && market !== 'US') continue;
    if ((market === 'AR' && arSourceMode === 'NO_DATA') || (market === 'US' && usSourceMode === 'NO_DATA')) continue;
    const key = liveQuoteKey(market, raw['symbol']);
    const parsed = parseQuote(raw, nextQuotes[key] ?? null);
    if (parsed === null) continue;
    if (parsed.direction !== null) changedTicks += 1;
    nextQuotes[key] = parsed;
  }
  const cauciones = arSourceMode === 'NO_DATA'
    ? []
    : Array.isArray(batch.cauciones)
      ? batch.cauciones.map(parseCaucion).filter((row): row is MarketLiveCaucion => row !== null)
      : state.cauciones;
  const parsedFutures = parseFutures(batch.futures);
  const futures = arSourceMode === 'NO_DATA' ? [] : (parsedFutures ?? state.futures);
  const futuresSource =
    arSourceMode === 'NO_DATA'
      ? 'NONE'
      : batch.futuresSource === 'PRIMARY_WS' || batch.futuresSource === 'PRIMARY_REST'
        ? batch.futuresSource
        : state.futuresSource;
  const parsedLiveFx = parseLiveFx(batch.liveFx);
  const liveFx = parsedLiveFx ?? state.liveFx;
  const parsedOrderBook = parseOrderBook(batch.liveOrderBook);
  const liveOrderBook = parsedOrderBook ?? state.liveOrderBook;
  let liveTape = Array.isArray(batch.tape) ? parseTape(batch.tape) : state.liveTape;
  for (const [key, parsedQuote] of Object.entries(nextQuotes)) {
    const previousQuote = state.quotesBySymbol[key] ?? null;
    const tapeTick = deriveTapeTickFromQuote(parsedQuote, previousQuote);
    if (tapeTick !== null) {
      liveTape = pushTapeTick(liveTape, tapeTick);
    }
  }
  lastDeltaRevision = revision;
  notify({
    ...state,
    version: state.version + 1,
    status: 'LIVE',
    transport,
    isLive: true,
    quotesBySymbol: nextQuotes,
    liveFx,
    liveOrderBook,
    liveTape,
    cclMedian: arSourceMode === 'NO_DATA' ? null : batch.cclMedian === null ? null : finitePositive(batch.cclMedian) ?? state.cclMedian,
    mepMedian: arSourceMode === 'NO_DATA' ? null : batch.mepMedian === null ? null : finitePositive(batch.mepMedian) ?? state.mepMedian,
    arSourceMode,
    usSourceMode,
    cauciones,
    futures,
    futuresSource,
    lastServerTimeSec: finitePositive(batch.serverTimeSec) ?? state.lastServerTimeSec,
    lastReceivedAtMs: receivedAtMs,
    ticksPerSecond: elapsedSec === null ? 0 : Math.round(changedTicks / elapsedSec),
    totalBatches: state.totalBatches + 1,
  });
  return true;
}

function applyTickDeltaSequence(
  batches: readonly MarketTickBatchWire[],
  transport: LiveStreamTransport,
): boolean {
  const valid = batches.filter(
    (batch) => batch.type === 'TICK_DELTA' && Array.isArray(batch.quotes),
  );
  if (valid.length === 0) return false;
  const first = valid[0];
  if (first === undefined) return false;
  const firstRevision = finiteNumber(first.deltaRevision);
  if (firstRevision === null || !Number.isInteger(firstRevision) || firstRevision < 0) return false;
  if (firstRevision <= lastDeltaRevision) return true;
  if (firstRevision > lastDeltaRevision + 1) return false;
  for (let idx = 1; idx < valid.length; idx += 1) {
    const previous = valid[idx - 1];
    const current = valid[idx];
    const previousRevision = finiteNumber(previous?.deltaRevision);
    const currentRevision = finiteNumber(current?.deltaRevision);
    if (
      previousRevision === null ||
      currentRevision === null ||
      currentRevision !== previousRevision + 1
    ) {
      return false;
    }
  }

  const last = valid[valid.length - 1];
  if (last === undefined) return false;
  const latestRevision = finiteNumber(last.deltaRevision);
  if (latestRevision === null) return false;
  clearPendingLegacy();
  const receivedAtMs = Date.now();
  const elapsedSec =
    lastBatchReceivedAtMs === null
      ? null
      : Math.max(0.001, (receivedAtMs - lastBatchReceivedAtMs) / 1_000);
  lastBatchReceivedAtMs = receivedAtMs;

  const nextQuotes: Record<string, MarketLiveQuote> = { ...state.quotesBySymbol };
  const latestArSourceMode =
    last.arSourceMode === 'LIVE_BMB' || last.arSourceMode === 'LIVE_IOL' || last.arSourceMode === 'DATA912' || last.arSourceMode === 'NO_DATA'
      ? last.arSourceMode
      : state.arSourceMode;
  const latestUsSourceMode =
    last.usSourceMode === 'MASSIVE_WS' || last.usSourceMode === 'MASSIVE_BATCH' || last.usSourceMode === 'NO_DATA'
      ? last.usSourceMode
      : state.usSourceMode;
  if (latestArSourceMode === 'NO_DATA' || latestUsSourceMode === 'NO_DATA') {
    for (const [key, quote] of Object.entries(nextQuotes)) {
      if (
        (quote.market === 'AR' && latestArSourceMode === 'NO_DATA') ||
        (quote.market === 'US' && latestUsSourceMode === 'NO_DATA')
      ) {
        delete nextQuotes[key];
      }
    }
  }

  let changedTicks = 0;
  for (const batch of valid) {
    if (Array.isArray(batch.removed)) {
      for (const key of batch.removed) {
        if (typeof key === 'string') delete nextQuotes[key];
      }
    }
    const batchQuotes = Array.isArray(batch.quotes) ? batch.quotes : [];
    for (const raw of batchQuotes) {
      if (!isRecord(raw) || typeof raw['symbol'] !== 'string') continue;
      const market = raw['market'];
      if (market !== 'AR' && market !== 'US') continue;
      if (
        (market === 'AR' && latestArSourceMode === 'NO_DATA') ||
        (market === 'US' && latestUsSourceMode === 'NO_DATA')
      ) {
        continue;
      }
      const key = liveQuoteKey(market, raw['symbol']);
      const parsed = parseQuote(raw, nextQuotes[key] ?? null);
      if (parsed === null) continue;
      if (parsed.direction !== null) changedTicks += 1;
      nextQuotes[key] = parsed;
    }
  }

  let cauciones = state.cauciones;
  let futures = state.futures;
  let futuresSource = state.futuresSource;
  let liveFx = state.liveFx;
  let liveOrderBook = state.liveOrderBook;
  let liveTape = state.liveTape;
  for (const batch of valid) {
    if (Array.isArray(batch.cauciones)) {
      cauciones = latestArSourceMode === 'NO_DATA'
        ? []
        : batch.cauciones.map(parseCaucion).filter((row): row is MarketLiveCaucion => row !== null);
    }
    if (Array.isArray(batch.futures)) {
      const parsedFutures = parseFutures(batch.futures);
      futures = latestArSourceMode === 'NO_DATA' ? [] : (parsedFutures ?? state.futures);
    }
    if (batch.futuresSource === 'PRIMARY_WS' || batch.futuresSource === 'PRIMARY_REST') {
      futuresSource = latestArSourceMode === 'NO_DATA' ? 'NONE' : batch.futuresSource;
    }
    const parsedLiveFx = parseLiveFx(batch.liveFx);
    if (parsedLiveFx !== null) liveFx = parsedLiveFx;
    const parsedOrderBook = parseOrderBook(batch.liveOrderBook);
    if (parsedOrderBook !== null) liveOrderBook = parsedOrderBook;
    if (Array.isArray(batch.tape)) liveTape = parseTape(batch.tape);
  }

  for (const [key, parsedQuote] of Object.entries(nextQuotes)) {
    const previousQuote = state.quotesBySymbol[key] ?? null;
    const tapeTick = deriveTapeTickFromQuote(parsedQuote, previousQuote);
    if (tapeTick !== null) {
      liveTape = pushTapeTick(liveTape, tapeTick);
    }
  }

  lastDeltaRevision = latestRevision;
  notify({
    ...state,
    version: state.version + 1,
    status: 'LIVE',
    transport,
    isLive: true,
    quotesBySymbol: nextQuotes,
    liveFx,
    liveOrderBook,
    liveTape,
    cclMedian:
      latestArSourceMode === 'NO_DATA'
        ? null
        : last.cclMedian === null
          ? state.cclMedian
          : finitePositive(last.cclMedian) ?? state.cclMedian,
    mepMedian:
      latestArSourceMode === 'NO_DATA'
        ? null
        : last.mepMedian === null
          ? state.mepMedian
          : finitePositive(last.mepMedian) ?? state.mepMedian,
    arSourceMode: latestArSourceMode,
    usSourceMode: latestUsSourceMode,
    cauciones,
    futures,
    futuresSource,
    lastServerTimeSec: finitePositive(last.serverTimeSec) ?? state.lastServerTimeSec,
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
  const nextQuotes = { ...state.quotesBySymbol };
  pendingLegacyQuotes.forEach((quote, key) => {
    nextQuotes[key] = quote;
  });
  pendingLegacyQuotes.clear();
  notify({
    ...state,
    version: state.version + 1,
    status: 'LIVE',
    transport: 'WS',
    isLive: true,
    usSourceMode: 'MASSIVE_WS',
    quotesBySymbol: nextQuotes,
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
  const previous = pendingLegacyQuotes.get(key) ?? state.quotesBySymbol[key] ?? null;
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

export interface GgalBarTickEventDto {
  readonly type: 'ggal_bar_tick';
  readonly symbol: 'GGAL';
  readonly mode: 'ADR' | 'ARS' | 'CCL';
  readonly timeframe: '1m' | '5m' | '15m' | '1h' | '4h' | '1D';
  readonly bar: {
    readonly timeSec: number;
    readonly open: number;
    readonly high: number;
    readonly low: number;
    readonly close: number;
    readonly volume: number;
  };
  readonly indicatorsPoint: {
    readonly timeSec: number;
    readonly ema9: number | null;
    readonly ema21: number | null;
    readonly ema50: number | null;
    readonly ema200: number | null;
    readonly sessionVwap: number | null;
    readonly avwap: number | null;
    readonly avwapPlus1Sigma: number | null;
    readonly avwapMinus1Sigma: number | null;
  };
  readonly serverTimeSec: number;
}

type GgalBarTickListener = (event: GgalBarTickEventDto) => void;

/**
 * Registro singleton de ticks GGAL (Pieza 39). Los eventos `ggal_bar_tick` NO
 * tocan el store de quotes: el gráfico se suscribe directo y llama a
 * `series.update()` vía refs (cero re-renders de React por tick).
 */
const ggalBarTickListeners = new Set<GgalBarTickListener>();

export function subscribeGgalBarTick(listener: GgalBarTickListener): () => void {
  ggalBarTickListeners.add(listener);
  return () => {
    ggalBarTickListeners.delete(listener);
  };
}

function dispatchGgalBarTick(parsed: Record<string, unknown>): void {
  if (parsed['type'] !== 'ggal_bar_tick' || ggalBarTickListeners.size === 0) return;
  const bar = isRecord(parsed['bar']) ? parsed['bar'] : null;
  const indicators = isRecord(parsed['indicatorsPoint']) ? parsed['indicatorsPoint'] : null;
  const mode = parsed['mode'];
  const timeframe = parsed['timeframe'];
  if (bar === null || indicators === null) return;
  if (mode !== 'ADR' && mode !== 'ARS' && mode !== 'CCL') return;
  if (
    typeof timeframe !== 'string' ||
    !['1m', '5m', '15m', '1h', '4h', '1D'].includes(timeframe)
  ) {
    return;
  }
  const event: GgalBarTickEventDto = {
    type: 'ggal_bar_tick',
    symbol: 'GGAL',
    mode,
    timeframe: timeframe as GgalBarTickEventDto['timeframe'],
    bar: {
      timeSec: typeof bar['timeSec'] === 'number' ? bar['timeSec'] : Number.NaN,
      open: typeof bar['open'] === 'number' ? bar['open'] : Number.NaN,
      high: typeof bar['high'] === 'number' ? bar['high'] : Number.NaN,
      low: typeof bar['low'] === 'number' ? bar['low'] : Number.NaN,
      close: typeof bar['close'] === 'number' ? bar['close'] : Number.NaN,
      volume: typeof bar['volume'] === 'number' ? bar['volume'] : Number.NaN,
    },
    indicatorsPoint: {
      timeSec: typeof indicators['timeSec'] === 'number' ? indicators['timeSec'] : Number.NaN,
      ema9: typeof indicators['ema9'] === 'number' ? indicators['ema9'] : null,
      ema21: typeof indicators['ema21'] === 'number' ? indicators['ema21'] : null,
      ema50: typeof indicators['ema50'] === 'number' ? indicators['ema50'] : null,
      ema200: typeof indicators['ema200'] === 'number' ? indicators['ema200'] : null,
      sessionVwap: typeof indicators['sessionVwap'] === 'number' ? indicators['sessionVwap'] : null,
      avwap: typeof indicators['avwap'] === 'number' ? indicators['avwap'] : null,
      avwapPlus1Sigma:
        typeof indicators['avwapPlus1Sigma'] === 'number' ? indicators['avwapPlus1Sigma'] : null,
      avwapMinus1Sigma:
        typeof indicators['avwapMinus1Sigma'] === 'number' ? indicators['avwapMinus1Sigma'] : null,
    },
    serverTimeSec: typeof parsed['serverTimeSec'] === 'number' ? parsed['serverTimeSec'] : 0,
  };
  if (!Number.isFinite(event.bar.close) || !Number.isFinite(event.bar.timeSec)) return;
  for (const listener of ggalBarTickListeners) {
    try {
      listener(event);
    } catch {
      // Un listener con error nunca tumba el socket compartido.
    }
  }
}

function scheduleMarketBatchFlush(): void {
  if (marketBatchFlushHandle !== null) return;
  const schedule =
    typeof requestAnimationFrame === 'function'
      ? (callback: () => void): number => requestAnimationFrame(callback)
      : (callback: () => void): number =>
          setTimeout(callback, 16) as unknown as number;
  marketBatchFlushHandle = schedule(() => {
    marketBatchFlushHandle = null;
    flushMarketBatches();
  });
}

function cancelMarketBatchFlush(): void {
  if (marketBatchFlushHandle === null) return;
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(marketBatchFlushHandle);
  } else {
    clearTimeout(marketBatchFlushHandle);
  }
  marketBatchFlushHandle = null;
}

function queueMarketBatch(batch: MarketBatchWire, transport: LiveStreamTransport): void {
  pendingMarketBatchTransport = transport;
  pendingMarketBatches.push(batch);
  scheduleMarketBatchFlush();
}

function flushMarketBatches(): void {
  const batches = pendingMarketBatches.splice(0, pendingMarketBatches.length);
  const transport = pendingMarketBatchTransport;
  const deltas = batches
    .map((batch) => batch.delta)
    .filter((delta): delta is MarketTickBatchWire => isRecord(delta));
  if (deltas.length > 0) {
    const accepted = applyTickDeltaSequence(deltas, transport);
    if (!accepted && transport === 'WS') {
      pendingMarketBatches.length = 0;
      socket?.close(4000, 'delta_resync_required');
      return;
    }
  }
  for (const batch of batches) {
    if (!Array.isArray(batch.events)) continue;
    for (const raw of batch.events) {
      if (!isRecord(raw)) continue;
      if (raw['type'] === 'ggal_bar_tick') {
        dispatchGgalBarTick(raw);
      }
    }
  }
}

function handleMessage(raw: unknown, transport: LiveStreamTransport): void {
  if (typeof raw !== 'string') return;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return;
    if (parsed['type'] === 'MARKET_TICK_BATCH' || parsed['type'] === 'TICK_DELTA') {
      const accepted = parsed['type'] === 'TICK_DELTA'
        ? applyTickDelta(parsed as MarketTickBatchWire, transport)
        : applyBatch(parsed as MarketTickBatchWire, transport);
      if (accepted && transport === 'WS') stopPolling();
      if (!accepted && transport === 'WS' && parsed['type'] === 'TICK_DELTA') {
        socket?.close(4000, 'delta_resync_required');
      }
    } else if (parsed['type'] === 'market_batch') {
      queueMarketBatch(parsed as MarketBatchWire, transport);
      if (transport === 'WS') stopPolling();
    } else if (parsed['type'] === 'ggal_bar_tick') {
      dispatchGgalBarTick(parsed);
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
  return import.meta.env.DEV
    ? 'ws://127.0.0.1:8787/ws'
    : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;
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
    sendFocusMessage();
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
  if (releaseTimer !== null) {
    clearTimeout(releaseTimer);
    releaseTimer = null;
  }
  if (managerCount > 1) return;
  void refreshBackendHealth();
  if (
    typeof WebSocket !== 'undefined' &&
    socket !== null &&
    (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)
  ) {
    return;
  }
  connectSocket();
}

function teardownConnection(): void {
  socketGeneration += 1;
  if (openTimeout !== null) clearTimeout(openTimeout);
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  openTimeout = null;
  reconnectTimer = null;
  stopPolling();
  clearPendingLegacy();
  cancelMarketBatchFlush();
  pendingMarketBatches.length = 0;
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

function releaseConnection(): void {
  managerCount = Math.max(0, managerCount - 1);
  if (managerCount > 0) return;
  if (releaseTimer !== null) return;
  // React StrictMode mounts, unmounts and remounts in the same tick. Debouncing
  // the teardown keeps the same socket alive across that artificial cycle.
  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    if (managerCount > 0) return;
    teardownConnection();
  }, RELEASE_DEBOUNCE_MS);
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
