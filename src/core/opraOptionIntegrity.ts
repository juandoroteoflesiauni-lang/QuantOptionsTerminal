import type { WsQuoteEvent, WsTradeEvent } from '../data/wsTypes.js';

export type OpraChannel = 'Q' | 'T';
export interface LiveOptionQuoteSnapshot {
  readonly symbol: string;
  readonly underlying: string;
  readonly time: number;
  readonly bid: number | null;
  readonly ask: number | null;
  readonly mid: number | null;
  readonly last: number | null;
  readonly size: number | null;
  readonly iv?: number;
  readonly delta?: number;
  readonly gamma?: number;
  readonly bidSize?: number | null;
  readonly askSize?: number | null;
  readonly lastSize?: number | null;
  readonly quoteTimestamp?: number | null;
  readonly tradeTimestamp?: number | null;
  readonly quoteTimestampMs?: number | null;
  readonly tradeTimestampMs?: number | null;
  readonly quoteSeq?: number | null;
  readonly tradeSeq?: number | null;
  readonly tradeId?: string | null;
  readonly quoteSource?: string;
  readonly tradeSource?: string;
  readonly quoteQuality?: 'VALID_TWO_SIDED' | 'NO_QUOTE';
  readonly tradeVolume?: number;
  readonly tradeCount?: number;
  readonly updatedChannels?: readonly OpraChannel[];
}

const etCalendar = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});

function validMs(ms: number): boolean {
  return Number.isSafeInteger(ms) && ms > 0 && ms <= 4_102_444_800_000;
}

function positive(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function validSize(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

function rejection(channel: OpraChannel, ms: number, seq: number | null, prevMs: number | null | undefined,
  prevSeq: number | null | undefined, identical: boolean): string | null {
  const kind = channel === 'Q' ? 'QUOTE' : 'TRADE';
  if (prevMs == null || ms > prevMs) return null;
  if (ms < prevMs) return `STALE_${kind}`;
  if (prevSeq != null) {
    if (seq === null) return 'UNSEQUENCED_TIE';
    if (seq < prevSeq) return `STALE_${kind}_SEQ`;
    if (seq === prevSeq) return `DUPLICATE_${kind}`;
  }
  return seq === null && identical ? `DUPLICATE_${kind}` : null;
}

function emptySnapshot(symbol: string, underlying: string): LiveOptionQuoteSnapshot {
  return { symbol, underlying, time: 0, bid: null, ask: null, mid: null, size: null, last: null, quoteQuality: 'NO_QUOTE' };
}

/** Merge complete channel observations. A v1 row has no clock for the other channel. */
export function coalesceOptionQuoteUpdate(previous: LiveOptionQuoteSnapshot | undefined, incoming: LiveOptionQuoteSnapshot): LiveOptionQuoteSnapshot {
  const old = previous ?? emptySnapshot(incoming.symbol, incoming.underlying);
  let next = old;
  let acceptedQuote = false;
  let acceptedTrade = false;
  const channels = incoming.updatedChannels;
  const quoteMs = incoming.quoteTimestampMs ?? (incoming.quoteTimestamp ?? (channels === undefined && incoming.last === null ? incoming.time : Number.NaN)) * 1000;
  const tradeMs = incoming.tradeTimestampMs ?? (incoming.tradeTimestamp ?? (channels === undefined && incoming.bid === null && incoming.ask === null ? incoming.time : Number.NaN)) * 1000;
  const q = channels === undefined || channels.includes('Q');
  const t = channels === undefined || channels.includes('T');
  if (q && positive(incoming.bid) && positive(incoming.ask) && incoming.ask >= incoming.bid && validMs(quoteMs)
    && (incoming.bidSize == null || validSize(incoming.bidSize)) && (incoming.askSize == null || validSize(incoming.askSize))
    && !rejection('Q', quoteMs, incoming.quoteSeq ?? null, old.quoteTimestampMs, old.quoteSeq,
      old.bid === incoming.bid && old.ask === incoming.ask && old.bidSize === incoming.bidSize && old.askSize === incoming.askSize)) {
    acceptedQuote = true;
    next = { ...next,
      ...(incoming.iv === undefined ? {} : { iv: incoming.iv }),
      ...(incoming.delta === undefined ? {} : { delta: incoming.delta }),
      ...(incoming.gamma === undefined ? {} : { gamma: incoming.gamma }),
      bid: incoming.bid, ask: incoming.ask, mid: (incoming.bid + incoming.ask) / 2,
      bidSize: incoming.bidSize ?? null, askSize: incoming.askSize ?? null, quoteSeq: incoming.quoteSeq ?? null,
      quoteTimestampMs: quoteMs, quoteTimestamp: Math.floor(quoteMs / 1000), quoteQuality: 'VALID_TWO_SIDED',
      ...(incoming.quoteSource === undefined ? {} : { quoteSource: incoming.quoteSource }) };
  }
  const size = incoming.lastSize ?? incoming.size;
  if (t && positive(incoming.last) && (size == null || validSize(size)) && validMs(tradeMs)
    && !(incoming.tradeId != null && incoming.tradeId === old.tradeId && old.tradeTimestampMs != null && etCalendar.format(old.tradeTimestampMs) === etCalendar.format(tradeMs))
    && !rejection('T', tradeMs, incoming.tradeSeq ?? null, old.tradeTimestampMs, old.tradeSeq,
      incoming.last === old.last && size === old.lastSize)) {
    acceptedTrade = true;
    next = { ...next, last: incoming.last, lastSize: size, size, tradeTimestampMs: tradeMs, tradeTimestamp: Math.floor(tradeMs / 1000),
      tradeSeq: incoming.tradeSeq ?? null, tradeId: incoming.tradeId ?? null,
      ...(incoming.tradeVolume === undefined ? {} : { tradeVolume: incoming.tradeVolume }),
      ...(incoming.tradeCount === undefined ? {} : { tradeCount: incoming.tradeCount }),
      ...(incoming.tradeSource === undefined ? {} : { tradeSource: incoming.tradeSource }) };
  }
  if (next === old) return old;
  const updatedChannels: OpraChannel[] = [];
  if (acceptedQuote || old.updatedChannels?.includes('Q')) updatedChannels.push('Q');
  if (acceptedTrade || old.updatedChannels?.includes('T')) updatedChannels.push('T');
  return { ...next, time: Math.max(next.quoteTimestamp ?? 0, next.tradeTimestamp ?? 0), updatedChannels };
}

export interface OpraContractLiveState {
  readonly snapshot: LiveOptionQuoteSnapshot;
  readonly sessionDateEt: string;
  readonly seenTradeIds: readonly string[];
  readonly quoteArrivalSeq: number;
  readonly tradeArrivalSeq: number;
}

interface OpraIngestionPolicy {
  readonly arrivalSeq?: number;
  readonly tiePolicy?: 'MONOTONIC_ARRIVAL' | 'REJECT_WITHOUT_SEQ';
  readonly lateTradeVolumePolicy?: 'REJECT_STALE_VOLUME' | 'ACCUMULATE_IF_UNIQUE_ID';
}

export function applyOpraEvent(previous: OpraContractLiveState | undefined, underlying: string,
  ev: WsQuoteEvent | WsTradeEvent, policy: OpraIngestionPolicy = {}) {
  const ms = ev.eventTimeMs;
  const q = ev.ev === 'Q';
  if (!validMs(ms) || (q ? !positive(ev.askPrice) || !positive(ev.bidPrice) || !validSize(ev.bidSize) || !validSize(ev.askSize)
    : !positive(ev.price) || !validSize(ev.size))) return { state: previous, reason: q ? 'INVALID_QUOTE' : 'INVALID_TRADE' };
  if (q && ev.askPrice < ev.bidPrice) return { state: previous, reason: 'CROSSED_BOOK' };
  const sessionDateEt = etCalendar.format(ms);
  const sameDay = previous?.sessionDateEt === sessionDateEt;
  if (previous && previous.sessionDateEt > sessionDateEt) return { state: previous, reason: q ? 'STALE_QUOTE' : 'STALE_TRADE' };
  const old = previous?.snapshot ?? emptySnapshot(ev.sym.trim().toUpperCase(), underlying);
  const base = sameDay ? old : { ...old, tradeSeq: null, quoteSeq: null, tradeId: null, tradeVolume: 0, tradeCount: 0 };
  const ids = sameDay ? previous.seenTradeIds : [];
  const seq = ev.sequence ?? null;
  const reason = q
    ? rejection('Q', ms, seq, base.quoteTimestampMs, base.quoteSeq, ev.bidPrice === base.bid && ev.askPrice === base.ask && ev.bidSize === base.bidSize && ev.askSize === base.askSize)
    : ev.tradeId !== undefined && ids.includes(ev.tradeId) ? 'DUPLICATE_TRADE'
    : rejection('T', ms, seq, base.tradeTimestampMs, base.tradeSeq, ev.price === base.last && ev.size === base.lastSize);
  const priorArrival = q ? previous?.quoteArrivalSeq : previous?.tradeArrivalSeq;
  const arrival = policy.arrivalSeq ?? (priorArrival ?? 0) + 1;
  if (reason === 'STALE_TRADE' && !q && previous && ev.tradeId !== undefined && policy.lateTradeVolumePolicy === 'ACCUMULATE_IF_UNIQUE_ID') {
    return { state: { ...previous, seenTradeIds: [...ids.slice(-63), ev.tradeId],
      snapshot: { ...base, tradeVolume: (base.tradeVolume ?? 0) + ev.size, tradeCount: (base.tradeCount ?? 0) + 1 } }, reason };
  }
  if (reason !== null) return { state: previous, reason };
  if (seq === null && ms === (q ? base.quoteTimestampMs : base.tradeTimestampMs)) {
    if (policy.tiePolicy === 'REJECT_WITHOUT_SEQ') return { state: previous, reason: 'UNSEQUENCED_TIE' };
    if (priorArrival !== undefined && arrival <= priorArrival) return { state: previous, reason: 'STALE_ARRIVAL_TIE' };
  }
  const sec = Math.floor(ms / 1000);
  const snapshot: LiveOptionQuoteSnapshot = q
    ? { ...base, bid: ev.bidPrice, ask: ev.askPrice, mid: (ev.bidPrice + ev.askPrice) / 2, bidSize: ev.bidSize, askSize: ev.askSize,
      quoteTimestamp: sec, quoteTimestampMs: ms, quoteSeq: seq, quoteQuality: 'VALID_TWO_SIDED',
      quoteSource: ev.bidExchange === undefined && ev.askExchange === undefined ? 'OPRA_MASSIVE_WS' : `OPRA_MASSIVE_WS:${String(ev.bidExchange ?? '-')}/${String(ev.askExchange ?? '-')}`,
      updatedChannels: ['Q'], time: Math.max(sec, base.tradeTimestamp ?? 0) }
    : { ...base, last: ev.price, lastSize: ev.size, size: ev.size, tradeTimestamp: sec, tradeTimestampMs: ms,
      tradeSeq: seq, tradeId: ev.tradeId ?? null, tradeVolume: (base.tradeVolume ?? 0) + ev.size, tradeCount: (base.tradeCount ?? 0) + 1,
      tradeSource: ev.exchange === undefined ? 'OPRA_MASSIVE_WS' : `OPRA_MASSIVE_WS:${String(ev.exchange)}`,
      updatedChannels: ['T'], time: Math.max(sec, base.quoteTimestamp ?? 0) };
  return { state: { sessionDateEt, snapshot, quoteArrivalSeq: q ? arrival : previous?.quoteArrivalSeq ?? 0,
    tradeArrivalSeq: q ? previous?.tradeArrivalSeq ?? 0 : arrival, seenTradeIds: !q && ev.tradeId !== undefined ? [...ids.slice(-63), ev.tradeId] : ids }, reason: null };
}

/** Decode the untrusted JSON row before either browser transport consumes it. */
export function parseOpraWireRow(raw: Record<string, unknown>, symbol: string): LiveOptionQuoteSnapshot {
  const num = (key: string) => typeof raw[key] === 'number' && Number.isFinite(raw[key]) ? raw[key] : null;
  const channels = raw['updatedChannels'];
  return {
    symbol, underlying: typeof raw['underlying'] === 'string' ? raw['underlying'] : '',
    time: num('time') ?? Number.NaN, bid: num('bid'), ask: num('ask'), mid: null, last: num('last'), size: num('size'),
    bidSize: num('bidSize'), askSize: num('askSize'), lastSize: num('lastSize'), quoteTimestamp: num('quoteTimestamp'),
    tradeTimestamp: num('tradeTimestamp'), quoteTimestampMs: num('quoteTimestampMs'), tradeTimestampMs: num('tradeTimestampMs'),
    quoteSeq: num('quoteSeq'), tradeSeq: num('tradeSeq'), tradeId: typeof raw['tradeId'] === 'string' ? raw['tradeId'] : null,
    ...(typeof raw['iv'] === 'number' && Number.isFinite(raw['iv']) ? { iv: raw['iv'] } : {}),
    ...(typeof raw['delta'] === 'number' && Number.isFinite(raw['delta']) ? { delta: raw['delta'] } : {}),
    ...(typeof raw['gamma'] === 'number' && Number.isFinite(raw['gamma']) ? { gamma: raw['gamma'] } : {}),
    ...(typeof raw['quoteSource'] === 'string' ? { quoteSource: raw['quoteSource'] } : {}),
    ...(typeof raw['tradeSource'] === 'string' ? { tradeSource: raw['tradeSource'] } : {}),
    ...(validSize(raw['tradeVolume']) ? { tradeVolume: raw['tradeVolume'] } : {}),
    ...(validSize(raw['tradeCount']) ? { tradeCount: raw['tradeCount'] } : {}),
    ...(Array.isArray(channels) ? { updatedChannels: channels.filter((c): c is OpraChannel => c === 'Q' || c === 'T') } : {}),
  };
}
