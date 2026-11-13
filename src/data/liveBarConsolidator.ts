import { projectLiveAvwap } from '../core/avwap.js';
import { projectLiveEma } from '../core/ema.js';
import { MAX_TIME_SECONDS } from '../core/sessions.js';
import { projectLiveSessionVwap } from '../core/sessionVwap.js';
import type { Bar } from '../core/types.js';
import {
  createDiscardCounts,
  isFiniteNumber,
  isRecord,
} from './normalizeShared.js';
import type { DiscardCause, DiscardCounts, DiscardRecord } from './types.js';
import type {
  FormingSecondSlot,
  LiveBarIngestOptions,
  LiveBarMetrics,
  LiveBarState,
  LiveProjectionInputs,
  LiveProjectionResult,
  WsAdminEvent,
  WsAggBarEvent,
  WsNormalizedEvent,
  WsParseResult,
  WsQuoteEvent,
  WsStatusEvent,
  WsTradeEvent,
} from './wsTypes.js';

const MIN_MS_TIMESTAMP = 1e11;
const MAX_MS_TIMESTAMP = MAX_TIME_SECONDS * 1000;
const DEFAULT_MAX_DISCARD_RECORDS = 50;

function parseWsMsTimestamp(value: unknown): number | null {
  if (!isFiniteNumber(value) || !Number.isInteger(value)) {
    return null;
  }
  if (value < MIN_MS_TIMESTAMP || value > MAX_MS_TIMESTAMP) {
    return null;
  }
  return value;
}

function makeBar(
  time: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
  vw?: number,
): Bar {
  if (vw !== undefined && isFiniteNumber(vw) && vw > 0) {
    return { time, open, high, low, close, volume, vw };
  }
  return { time, open, high, low, close, volume };
}

function extractRawTimeSec(raw: unknown): number | null {
  if (!isRecord(raw)) {
    return null;
  }
  const ms = parseWsMsTimestamp(raw['s'] ?? raw['t']);
  return ms !== null ? Math.floor(ms / 1000) : null;
}

function recordDiscard(
  counts: Record<DiscardCause, number>,
  records: DiscardRecord[],
  cause: DiscardCause,
  raw: unknown,
  maxRecords: number,
): void {
  counts[cause] += 1;
  if (records.length < maxRecords) {
    records.push({ cause, time: extractRawTimeSec(raw) });
  }
}

function normalizeStatusEvent(
  item: Readonly<Record<string, unknown>>,
): WsStatusEvent | { readonly cause: DiscardCause; readonly reason: string } {
  const statusRaw = item['status'];
  const messageRaw = item['message'];
  if (typeof statusRaw !== 'string' || statusRaw.trim().length === 0) {
    return { cause: 'malformedRow', reason: 'status event missing non-empty status string' };
  }
  if (messageRaw !== undefined && typeof messageRaw !== 'string') {
    return { cause: 'malformedRow', reason: 'status event has non-string message' };
  }
  return {
    ev: 'status',
    status: statusRaw,
    message: messageRaw ?? '',
  };
}

function normalizeAggEvent(
  ev: 'A' | 'AM',
  item: Readonly<Record<string, unknown>>,
): WsAggBarEvent | { readonly cause: DiscardCause; readonly reason: string } {
  const symRaw = item['sym'];
  if (typeof symRaw !== 'string' || symRaw.trim().length === 0) {
    return { cause: 'malformedRow', reason: `${ev} event missing non-empty sym` };
  }

  const startMs = parseWsMsTimestamp(item['s']);
  if (startMs === null) {
    return { cause: 'invalidTime', reason: `${ev} event has invalid millisecond timestamp s` };
  }

  const rawEnd = item['e'];
  let endMs: number;
  if (rawEnd === undefined) {
    endMs = ev === 'AM' ? startMs + 60_000 : startMs + 1_000;
  } else {
    const parsedEnd = parseWsMsTimestamp(rawEnd);
    if (parsedEnd === null || parsedEnd < startMs) {
      return { cause: 'invalidTime', reason: `${ev} event has invalid end timestamp e` };
    }
    endMs = parsedEnd;
  }

  const timeSec = Math.floor(startMs / 1000);
  if (timeSec < 0 || timeSec > MAX_TIME_SECONDS) {
    return { cause: 'invalidTime', reason: `${ev} event timeSec out of valid range` };
  }

  const o = item['o'];
  const h = item['h'];
  const l = item['l'];
  const c = item['c'];
  const v = item['v'];
  if (
    !isFiniteNumber(o) ||
    !isFiniteNumber(h) ||
    !isFiniteNumber(l) ||
    !isFiniteNumber(c) ||
    !isFiniteNumber(v)
  ) {
    return { cause: 'nonFinite', reason: `${ev} event has non-finite OHLCV field` };
  }

  if (o <= 0 || h <= 0 || l <= 0 || c <= 0) {
    return { cause: 'invalidPrice', reason: `${ev} event has non-positive OHLC price` };
  }
  if (h < l) {
    return { cause: 'highBelowLow', reason: `${ev} event has high < low` };
  }
  if (o < l || o > h || c < l || c > h) {
    return { cause: 'invalidOhlc', reason: `${ev} event has open or close outside [low, high]` };
  }
  if (v < 0) {
    return { cause: 'invalidVolume', reason: `${ev} event has negative volume` };
  }

  let vw: number | undefined;
  const rawVw = item['vw'];
  if (rawVw !== undefined && rawVw !== null) {
    if (!isFiniteNumber(rawVw)) {
      return { cause: 'nonFinite', reason: `${ev} event has non-finite vw` };
    }
    if (rawVw > 0) {
      vw = rawVw;
    } else if (v > 0 && rawVw <= 0) {
      return { cause: 'invalidPrice', reason: `${ev} event has non-positive vw with positive volume` };
    }
  }

  const bar = makeBar(timeSec, o, h, l, c, v, vw);
  const rawAv = item['av'];
  const rawOp = item['op'];
  const rawZ = item['z'];

  return {
    ev,
    sym: symRaw,
    bar,
    startMs,
    endMs,
    ...(isFiniteNumber(rawAv) && rawAv >= 0 ? { accumulatedVolume: rawAv } : {}),
    ...(isFiniteNumber(rawOp) && rawOp > 0 ? { dayOpen: rawOp } : {}),
    ...(isFiniteNumber(rawZ) && Number.isInteger(rawZ) && rawZ >= 0 ? { tickCount: rawZ } : {}),
  };
}

function normalizeTradeEvent(
  item: Readonly<Record<string, unknown>>,
): WsTradeEvent | { readonly cause: DiscardCause; readonly reason: string } {
  const symRaw = item['sym'];
  if (typeof symRaw !== 'string' || symRaw.trim().length === 0) {
    return { cause: 'malformedRow', reason: 'T event missing non-empty sym' };
  }

  const eventTimeMs = parseWsMsTimestamp(item['t']);
  if (eventTimeMs === null) {
    return { cause: 'invalidTime', reason: 'T event has invalid millisecond timestamp t' };
  }

  const price = item['p'];
  const size = item['s'];
  if (!isFiniteNumber(price) || !isFiniteNumber(size)) {
    return { cause: 'nonFinite', reason: 'T event has non-finite price or size' };
  }
  if (price <= 0) {
    return { cause: 'invalidPrice', reason: 'T event has non-positive price' };
  }
  if (size < 0) {
    return { cause: 'invalidVolume', reason: 'T event has negative size' };
  }

  const timeSec = Math.floor(eventTimeMs / 1000);
  if (timeSec < 0 || timeSec > MAX_TIME_SECONDS) {
    return { cause: 'invalidTime', reason: 'T event timeSec out of valid range' };
  }

  const rawCond = item['c'];
  const conditions = Array.isArray(rawCond)
    ? rawCond.filter((entry): entry is number => isFiniteNumber(entry) && Number.isInteger(entry))
    : undefined;
  const rawExch = item['x'];

  return {
    ev: 'T',
    sym: symRaw,
    price,
    size,
    timeSec,
    eventTimeMs,
    ...(conditions !== undefined ? { conditions } : {}),
    ...(isFiniteNumber(rawExch) && Number.isInteger(rawExch) ? { exchange: rawExch } : {}),
  };
}

function normalizeQuoteEvent(
  item: Readonly<Record<string, unknown>>,
): WsQuoteEvent | { readonly cause: DiscardCause; readonly reason: string } {
  const symRaw = item['sym'];
  if (typeof symRaw !== 'string' || symRaw.trim().length === 0) {
    return { cause: 'malformedRow', reason: 'Q event missing non-empty sym' };
  }

  const eventTimeMs = parseWsMsTimestamp(item['t']);
  if (eventTimeMs === null) {
    return { cause: 'invalidTime', reason: 'Q event has invalid millisecond timestamp t' };
  }

  const bp = item['bp'];
  const ap = item['ap'];
  const bs = item['bs'];
  const as = item['as'];
  if (!isFiniteNumber(bp) || !isFiniteNumber(ap) || !isFiniteNumber(bs) || !isFiniteNumber(as)) {
    return { cause: 'nonFinite', reason: 'Q event has non-finite bid/ask price or size' };
  }
  if (bp <= 0 || ap <= 0) {
    return { cause: 'invalidPrice', reason: 'Q event has non-positive bid or ask price' };
  }
  if (bs < 0 || as < 0) {
    return { cause: 'invalidVolume', reason: 'Q event has negative bid or ask size' };
  }

  const timeSec = Math.floor(eventTimeMs / 1000);
  if (timeSec < 0 || timeSec > MAX_TIME_SECONDS) {
    return { cause: 'invalidTime', reason: 'Q event timeSec out of valid range' };
  }

  return {
    ev: 'Q',
    sym: symRaw,
    bidPrice: bp,
    askPrice: ap,
    bidSize: bs,
    askSize: as,
    timeSec,
    eventTimeMs,
  };
}

function normalizeAdminEvent(
  ev: 'AD' | 'LULD',
  item: Readonly<Record<string, unknown>>,
): WsAdminEvent {
  const symRaw = item['sym'] ?? item['T'];
  const tRaw = item['t'];
  const tMs = parseWsMsTimestamp(tRaw);
  const rawCopy: Record<string, unknown> = { ...item };

  return {
    ev,
    ...(typeof symRaw === 'string' && symRaw.length > 0 ? { sym: symRaw } : {}),
    ...(tMs !== null ? { timeSec: Math.floor(tMs / 1000) } : {}),
    raw: rawCopy,
  };
}

function normalizeSingleItem(
  item: unknown,
): WsNormalizedEvent | { readonly cause: DiscardCause; readonly reason: string } {
  if (!isRecord(item)) {
    return { cause: 'malformedRow', reason: 'event entry is not a JSON object' };
  }
  const ev = item['ev'];
  if (typeof ev !== 'string' || ev.trim().length === 0) {
    return { cause: 'malformedRow', reason: 'event missing ev discriminator' };
  }

  if (ev === 'status') {
    return normalizeStatusEvent(item);
  }
  if (ev === 'A' || ev === 'AM') {
    return normalizeAggEvent(ev, item);
  }
  if (ev === 'T') {
    return normalizeTradeEvent(item);
  }
  if (ev === 'Q') {
    return normalizeQuoteEvent(item);
  }
  if (ev === 'AD' || ev === 'LULD') {
    return normalizeAdminEvent(ev, item);
  }

  return { cause: 'malformedRow', reason: `unsupported WebSocket event type: ${ev}` };
}

/**
 * Validates and normalizes an already-parsed Massive WebSocket payload (array batch or single object).
 * Pure, side-effect-free, never mutates input arguments.
 */
export function normalizeWsPayload(
  payload: unknown,
  maxDiscardRecords = DEFAULT_MAX_DISCARD_RECORDS,
): WsParseResult {
  const counts = createDiscardCounts();
  const records: DiscardRecord[] = [];
  const events: WsNormalizedEvent[] = [];

  const items: readonly unknown[] = Array.isArray(payload) ? payload : [payload];
  if (!Array.isArray(payload) && !isRecord(payload)) {
    recordDiscard(counts, records, 'malformedRow', payload, maxDiscardRecords);
    return {
      events,
      discarded: 1,
      discardCounts: counts,
      discardRecords: records,
    };
  }

  for (let i = 0; i < items.length; i += 1) {
    const res = normalizeSingleItem(items[i]);
    if ('ev' in res) {
      events.push(res);
    } else {
      recordDiscard(counts, records, res.cause, items[i], maxDiscardRecords);
    }
  }

  const discarded = counts.malformedRow
    + counts.invalidTime
    + counts.nonFinite
    + counts.invalidPrice
    + counts.highBelowLow
    + counts.invalidOhlc
    + counts.invalidVolume
    + counts.duplicate;

  return {
    events,
    discarded,
    discardCounts: counts,
    discardRecords: records,
  };
}

/**
 * Safely parses a JSON WebSocket frame string and normalizes all valid events without throwing.
 */
export function parseWsJsonPayload(
  rawText: string,
  maxDiscardRecords = DEFAULT_MAX_DISCARD_RECORDS,
): WsParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    const counts = createDiscardCounts();
    counts.malformedRow = 1;
    return {
      events: [],
      discarded: 1,
      discardCounts: counts,
      discardRecords: [{ cause: 'malformedRow', time: null }],
    };
  }
  return normalizeWsPayload(parsed, maxDiscardRecords);
}

function copyBar(bar: Bar): Bar {
  return bar.vw !== undefined
    ? {
        time: bar.time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        vw: bar.vw,
      }
    : {
        time: bar.time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      };
}

function validateInitialClosedBars(closedBars: readonly Bar[]): readonly Bar[] {
  const copied: Bar[] = [];
  let prevTime = -Infinity;

  for (let i = 0; i < closedBars.length; i += 1) {
    const bar = closedBars[i];
    if (bar === undefined) {
      continue;
    }
    if (
      !isFiniteNumber(bar.time) ||
      !Number.isInteger(bar.time) ||
      bar.time < 0 ||
      bar.time > MAX_TIME_SECONDS
    ) {
      throw new RangeError(`closedBars[${String(i)}].time must be an integer UTC timestamp in seconds`);
    }
    if (bar.time <= prevTime) {
      throw new RangeError(`closedBars must be strictly ascending in time at index ${String(i)}`);
    }
    if (
      !isFiniteNumber(bar.open) ||
      !isFiniteNumber(bar.high) ||
      !isFiniteNumber(bar.low) ||
      !isFiniteNumber(bar.close) ||
      !isFiniteNumber(bar.volume) ||
      bar.open <= 0 ||
      bar.high <= 0 ||
      bar.low <= 0 ||
      bar.close <= 0 ||
      bar.high < bar.low ||
      bar.open < bar.low ||
      bar.open > bar.high ||
      bar.close < bar.low ||
      bar.close > bar.high ||
      bar.volume < 0
    ) {
      throw new RangeError(`closedBars[${String(i)}] contains invalid OHLCV values`);
    }
    if (bar.vw !== undefined && (!isFiniteNumber(bar.vw) || bar.vw <= 0)) {
      throw new RangeError(`closedBars[${String(i)}].vw must be a finite positive number when present`);
    }
    prevTime = bar.time;
    copied.push(copyBar(bar));
  }

  return copied;
}

/**
 * Creates an immutable initial state for the live forming-bar and rebroadcast consolidator.
 */
export function createLiveBarState(
  initialClosedBars: readonly Bar[] = [],
  barSeconds = 60,
): LiveBarState {
  if (!Number.isInteger(barSeconds) || barSeconds < 1) {
    throw new RangeError(`barSeconds must be a positive integer (received ${String(barSeconds)})`);
  }
  if (barSeconds > 1 && barSeconds < 60 && 60 % barSeconds !== 0) {
    throw new RangeError(
      `Sub-minute barSeconds must divide 60 evenly (received ${String(barSeconds)})`,
    );
  }
  if (barSeconds > 60 && barSeconds % 60 !== 0) {
    throw new RangeError(
      `Multi-minute barSeconds must be a multiple of 60 (received ${String(barSeconds)})`,
    );
  }

  const closedBars = validateInitialClosedBars(initialClosedBars);
  const closedMinuteBars: Record<string, Bar> = {};
  if (barSeconds === 60) {
    for (const bar of closedBars) {
      closedMinuteBars[String(bar.time)] = copyBar(bar);
    }
  }

  return {
    barSeconds,
    closedBars,
    formingBucketTime: null,
    formingBar: null,
    openBuckets: {},
    closedMinuteBars,
    metrics: {
      closedCount: closedBars.length,
      rebroadcastOverwrites: 0,
      secondRebroadcastOverwrites: 0,
      tradesFolded: 0,
      staleEventsIgnored: 0,
      discardedEvents: 0,
      discardCounts: createDiscardCounts(),
    },
    discardRecords: [],
  };
}

function getBucketStart(timeSec: number, barSeconds: number): number {
  return Math.floor(timeSec / barSeconds) * barSeconds;
}

function upsertSortedBar(
  bars: readonly Bar[],
  newBar: Bar,
): { readonly bars: Bar[]; readonly replaced: boolean } {
  const target = newBar.time;
  let lo = 0;
  let hi = bars.length;

  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const midBar = bars[mid];
    if (midBar !== undefined && midBar.time < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  const next = bars.map(copyBar);
  const existing = next[lo];
  if (existing !== undefined && existing.time === target) {
    next[lo] = copyBar(newBar);
    return { bars: next, replaced: true };
  }

  next.splice(lo, 0, copyBar(newBar));
  return { bars: next, replaced: false };
}

function aggregateBarsCollection(
  bucketTime: number,
  parts: readonly { readonly bar: Bar; readonly notional?: number; readonly hasValidVw?: boolean }[],
): Bar | null {
  if (parts.length === 0) {
    return null;
  }

  const first = parts[0];
  const last = parts[parts.length - 1];
  if (first === undefined || last === undefined) {
    return null;
  }

  const open = first.bar.open;
  const close = last.bar.close;
  let high = first.bar.high;
  let low = first.bar.low;
  let volume = 0;
  let totalNotional = 0;
  let allPositiveVolumeHaveVw = true;

  for (const part of parts) {
    if (part.bar.high > high) {
      high = part.bar.high;
    }
    if (part.bar.low < low) {
      low = part.bar.low;
    }
    volume += part.bar.volume;
    if (part.bar.volume > 0) {
      if (part.hasValidVw === false) {
        allPositiveVolumeHaveVw = false;
      } else if (part.notional !== undefined && isFiniteNumber(part.notional)) {
        totalNotional += part.notional;
      } else if (part.bar.vw !== undefined && isFiniteNumber(part.bar.vw)) {
        totalNotional += part.bar.vw * part.bar.volume;
      } else {
        allPositiveVolumeHaveVw = false;
      }
    }
  }

  const vw =
    volume > 0 && allPositiveVolumeHaveVw ? totalNotional / volume : undefined;
  return makeBar(bucketTime, open, high, low, close, volume, vw);
}

function buildSecondSlotFromAgg(bar: Bar): FormingSecondSlot {
  const hasValidVw = bar.volume === 0 || (bar.vw !== undefined && isFiniteNumber(bar.vw));
  const notional =
    bar.volume > 0 && bar.vw !== undefined && isFiniteNumber(bar.vw)
      ? bar.vw * bar.volume
      : 0;
  return {
    time: bar.time,
    source: 'A',
    bar: copyBar(bar),
    notional,
    hasValidVw,
  };
}

function buildSecondSlotFromTrade(
  prev: FormingSecondSlot | undefined,
  trade: WsTradeEvent,
): FormingSecondSlot {
  const tradeNotional = trade.price * trade.size;
  if (prev === undefined) {
    const bar = makeBar(
      trade.timeSec,
      trade.price,
      trade.price,
      trade.price,
      trade.price,
      trade.size,
      trade.size > 0 ? trade.price : undefined,
    );
    return {
      time: trade.timeSec,
      source: 'T',
      bar,
      notional: tradeNotional,
      hasValidVw: true,
    };
  }

  const volume = prev.bar.volume + trade.size;
  const notional = prev.notional + tradeNotional;
  const vw = volume > 0 ? notional / volume : undefined;
  const bar = makeBar(
    trade.timeSec,
    prev.bar.open,
    Math.max(prev.bar.high, trade.price),
    Math.min(prev.bar.low, trade.price),
    trade.price,
    volume,
    vw,
  );
  return {
    time: trade.timeSec,
    source: 'T',
    bar,
    notional,
    hasValidVw: true,
  };
}

function getBucketMinuteSlotsForBucket(
  bucketTime: number,
  barSeconds: number,
  closedMinuteBars: Readonly<Record<string, Bar>>,
  openSecondSlots: Readonly<Record<string, FormingSecondSlot>> | undefined,
): readonly { readonly time: number; readonly bar: Bar; readonly notional?: number; readonly hasValidVw?: boolean }[] {
  if (barSeconds <= 60) {
    if (openSecondSlots === undefined) {
      return [];
    }
    const keys = Object.keys(openSecondSlots)
      .map((k) => Number(k))
      .sort((a, b) => a - b);
    const out: { readonly time: number; readonly bar: Bar; readonly notional: number; readonly hasValidVw: boolean }[] = [];
    for (const sec of keys) {
      const slot = openSecondSlots[String(sec)];
      if (slot !== undefined) {
        out.push({
          time: sec,
          bar: slot.bar,
          notional: slot.notional,
          hasValidVw: slot.hasValidVw,
        });
      }
    }
    return out;
  }

  const minutesPerBucket = barSeconds / 60;
  const slots: { readonly time: number; readonly bar: Bar; readonly notional?: number; readonly hasValidVw?: boolean }[] = [];

  for (let i = 0; i < minutesPerBucket; i += 1) {
    const minTime = bucketTime + i * 60;
    const closedMin = closedMinuteBars[String(minTime)];
    if (closedMin !== undefined) {
      slots.push({ time: minTime, bar: closedMin });
      continue;
    }
    if (openSecondSlots !== undefined) {
      const minSeconds = Object.keys(openSecondSlots)
        .map((k) => Number(k))
        .filter((sec) => sec >= minTime && sec < minTime + 60)
        .sort((a, b) => a - b);
      for (const sec of minSeconds) {
        const slot = openSecondSlots[String(sec)];
        if (slot !== undefined) {
          slots.push({
            time: sec,
            bar: slot.bar,
            notional: slot.notional,
            hasValidVw: slot.hasValidVw,
          });
        }
      }
    }
  }

  return slots.sort((a, b) => a.time - b.time);
}

function deriveActiveFormingBar(
  barSeconds: number,
  closedBars: readonly Bar[],
  openBuckets: Readonly<Record<string, Readonly<Record<string, FormingSecondSlot>>>>,
  closedMinuteBars: Readonly<Record<string, Bar>>,
): { readonly formingBucketTime: number | null; readonly formingBar: Bar | null } {
  const closedSet = new Set<number>(closedBars.map((b) => b.time));
  const lastClosed = closedBars.length > 0 ? closedBars[closedBars.length - 1] : undefined;
  const latestClosedTime = lastClosed !== undefined ? lastClosed.time : -1;

  const candidateBuckets = new Set<number>();
  for (const key of Object.keys(openBuckets)) {
    const bucket = Number(key);
    if (!closedSet.has(bucket) && bucket > latestClosedTime) {
      candidateBuckets.add(bucket);
    }
  }
  if (barSeconds > 60) {
    for (const minKey of Object.keys(closedMinuteBars)) {
      const minTime = Number(minKey);
      const bucket = getBucketStart(minTime, barSeconds);
      if (!closedSet.has(bucket) && bucket > latestClosedTime) {
        candidateBuckets.add(bucket);
      }
    }
  }

  if (candidateBuckets.size === 0) {
    return { formingBucketTime: null, formingBar: null };
  }

  const formingBucketTime = Math.max(...candidateBuckets);
  const parts = getBucketMinuteSlotsForBucket(
    formingBucketTime,
    barSeconds,
    closedMinuteBars,
    openBuckets[String(formingBucketTime)],
  );
  const formingBar = aggregateBarsCollection(formingBucketTime, parts);
  if (formingBar === null) {
    return { formingBucketTime: null, formingBar: null };
  }
  return { formingBucketTime, formingBar };
}

function pruneToMaxClosedBars(
  closedBars: readonly Bar[],
  openBuckets: Readonly<Record<string, Readonly<Record<string, FormingSecondSlot>>>>,
  closedMinuteBars: Readonly<Record<string, Bar>>,
  maxClosedBars: number | undefined,
): {
  readonly closedBars: readonly Bar[];
  readonly openBuckets: Readonly<Record<string, Readonly<Record<string, FormingSecondSlot>>>>;
  readonly closedMinuteBars: Readonly<Record<string, Bar>>;
} {
  if (maxClosedBars === undefined || !Number.isInteger(maxClosedBars) || maxClosedBars <= 0) {
    return { closedBars, openBuckets, closedMinuteBars };
  }
  if (closedBars.length <= maxClosedBars) {
    return { closedBars, openBuckets, closedMinuteBars };
  }

  const trimmedClosed = closedBars.slice(-maxClosedBars);
  const minKeptTime = trimmedClosed[0]?.time ?? 0;

  const nextOpenBuckets: Record<string, Readonly<Record<string, FormingSecondSlot>>> = {};
  for (const [k, v] of Object.entries(openBuckets)) {
    if (Number(k) >= minKeptTime) {
      nextOpenBuckets[k] = v;
    }
  }

  const nextMinuteBars: Record<string, Bar> = {};
  for (const [k, v] of Object.entries(closedMinuteBars)) {
    if (Number(k) >= minKeptTime) {
      nextMinuteBars[k] = v;
    }
  }

  return {
    closedBars: trimmedClosed,
    openBuckets: nextOpenBuckets,
    closedMinuteBars: nextMinuteBars,
  };
}

interface MutableConsolidationWork {
  closedBars: readonly Bar[];
  openBuckets: Record<string, Record<string, FormingSecondSlot>>;
  closedMinuteBars: Record<string, Bar>;
  closedCount: number;
  rebroadcastOverwrites: number;
  secondRebroadcastOverwrites: number;
  tradesFolded: number;
  staleEventsIgnored: number;
}

function omitKey<T>(
  record: Readonly<Record<string, T>>,
  keyToDelete: string,
): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k !== keyToDelete) {
      next[k] = v;
    }
  }
  return next;
}

function applyOneMinuteClose(
  work: MutableConsolidationWork,
  barSeconds: number,
  amEvent: WsAggBarEvent,
): void {
  const amBar = copyBar(amEvent.bar);
  const amTime = amBar.time;
  const bucketKey = String(amTime);

  if (barSeconds === 60) {
    const upserted = upsertSortedBar(work.closedBars, amBar);
    work.closedBars = upserted.bars;
    if (upserted.replaced) {
      work.rebroadcastOverwrites += 1;
    } else {
      work.closedCount += 1;
    }
    work.closedMinuteBars[bucketKey] = amBar;
    work.openBuckets = omitKey(work.openBuckets, bucketKey);
    return;
  }

  if (barSeconds < 60) {
    work.staleEventsIgnored += 1;
    return;
  }

  const minuteExisted = work.closedMinuteBars[bucketKey] !== undefined;
  work.closedMinuteBars[bucketKey] = amBar;

  const parentBucket = getBucketStart(amTime, barSeconds);
  const parentKey = String(parentBucket);
  const existingSecondMap = work.openBuckets[parentKey];
  if (existingSecondMap !== undefined) {
    const remainingSeconds: Record<string, FormingSecondSlot> = {};
    for (const [secKey, slot] of Object.entries(existingSecondMap)) {
      const sec = Number(secKey);
      if (sec < amTime || sec >= amTime + 60) {
        remainingSeconds[secKey] = slot;
      }
    }
    if (Object.keys(remainingSeconds).length === 0) {
      work.openBuckets = omitKey(work.openBuckets, parentKey);
    } else {
      work.openBuckets[parentKey] = remainingSeconds;
    }
  }

  const expectedMinutes = barSeconds / 60;
  const closedMinutesInBucket: Bar[] = [];
  for (let i = 0; i < expectedMinutes; i += 1) {
    const minBar = work.closedMinuteBars[String(parentBucket + i * 60)];
    if (minBar !== undefined) {
      closedMinutesInBucket.push(minBar);
    }
  }

  const alreadyClosedBucket = work.closedBars.some((b) => b.time === parentBucket);
  const laterClosedMinuteExists = Object.keys(work.closedMinuteBars).some(
    (k) => Number(k) >= parentBucket + barSeconds,
  );

  // Also check if an AM for a strictly later bucket just arrived, which closes any earlier open multi-minute bucket
  if (
    closedMinutesInBucket.length === expectedMinutes ||
    alreadyClosedBucket ||
    laterClosedMinuteExists
  ) {
    const agg = aggregateBarsCollection(
      parentBucket,
      closedMinutesInBucket.map((bar) => ({ bar })),
    );
    if (agg !== null) {
      const upserted = upsertSortedBar(work.closedBars, agg);
      work.closedBars = upserted.bars;
      if (upserted.replaced && minuteExisted) {
        work.rebroadcastOverwrites += 1;
      } else if (!upserted.replaced) {
        work.closedCount += 1;
      }
      work.openBuckets = omitKey(work.openBuckets, parentKey);
    }
  }

  // Seal any earlier partial multi-minute buckets whose window is now strictly behind parentBucket
  const earlierBucketsToCheck = new Set<number>();
  for (const minKey of Object.keys(work.closedMinuteBars)) {
    const b = getBucketStart(Number(minKey), barSeconds);
    if (b < parentBucket) {
      earlierBucketsToCheck.add(b);
    }
  }
  const closedBucketTimes = new Set<number>(work.closedBars.map((b) => b.time));
  for (const earlierBucket of earlierBucketsToCheck) {
    if (closedBucketTimes.has(earlierBucket)) {
      continue;
    }
    const mins: Bar[] = [];
    for (let i = 0; i < expectedMinutes; i += 1) {
      const mb = work.closedMinuteBars[String(earlierBucket + i * 60)];
      if (mb !== undefined) {
        mins.push(mb);
      }
    }
    const agg = aggregateBarsCollection(
      earlierBucket,
      mins.map((bar) => ({ bar })),
    );
    if (agg !== null) {
      const upserted = upsertSortedBar(work.closedBars, agg);
      work.closedBars = upserted.bars;
      if (!upserted.replaced) {
        work.closedCount += 1;
      }
      work.openBuckets = omitKey(work.openBuckets, String(earlierBucket));
    }
  }
}

function applyOneSecondAgg(
  work: MutableConsolidationWork,
  barSeconds: number,
  aEvent: WsAggBarEvent,
): void {
  const aBar = copyBar(aEvent.bar);
  const secTime = aBar.time;

  if (barSeconds === 1) {
    const upserted = upsertSortedBar(work.closedBars, aBar);
    work.closedBars = upserted.bars;
    if (upserted.replaced) {
      work.rebroadcastOverwrites += 1;
    } else {
      work.closedCount += 1;
    }
    work.openBuckets = omitKey(work.openBuckets, String(secTime));
    return;
  }

  const bucketTime = getBucketStart(secTime, barSeconds);
  const minuteTime = getBucketStart(secTime, 60);
  const lastClosed = work.closedBars[work.closedBars.length - 1];
  const latestClosedTime = lastClosed !== undefined ? lastClosed.time : -1;

  if (
    bucketTime <= latestClosedTime ||
    work.closedBars.some((b) => b.time === bucketTime) ||
    (barSeconds >= 60 && work.closedMinuteBars[String(minuteTime)] !== undefined)
  ) {
    // Sub-minute bucket is already closed by AM (wait for AM rebroadcast rather than mixing A into closed bar)
    if (barSeconds < 60 && work.closedBars.some((b) => b.time === bucketTime)) {
      const existingBucket = work.openBuckets[String(bucketTime)] ?? {};
      const nextBucket: Record<string, FormingSecondSlot> = { ...existingBucket };
      if (nextBucket[String(secTime)]?.source === 'A') {
        work.secondRebroadcastOverwrites += 1;
      }
      nextBucket[String(secTime)] = buildSecondSlotFromAgg(aBar);
      work.openBuckets[String(bucketTime)] = nextBucket;
      const parts = getBucketMinuteSlotsForBucket(bucketTime, barSeconds, work.closedMinuteBars, nextBucket);
      const updated = aggregateBarsCollection(bucketTime, parts);
      if (updated !== null) {
        const upserted = upsertSortedBar(work.closedBars, updated);
        work.closedBars = upserted.bars;
        if (upserted.replaced) {
          work.rebroadcastOverwrites += 1;
        }
      }
      return;
    }
    work.staleEventsIgnored += 1;
    return;
  }

  const bucketKey = String(bucketTime);
  const existingSlots = work.openBuckets[bucketKey] ?? {};
  const nextSlots: Record<string, FormingSecondSlot> = { ...existingSlots };
  const prevSlot = nextSlots[String(secTime)];
  if (prevSlot !== undefined && prevSlot.source === 'A') {
    work.secondRebroadcastOverwrites += 1;
  }
  nextSlots[String(secTime)] = buildSecondSlotFromAgg(aBar);
  work.openBuckets[bucketKey] = nextSlots;

  // For sub-minute buckets (< 60), arriving into a newer bucket seals earlier unclosed buckets
  if (barSeconds < 60) {
    for (const key of Object.keys(work.openBuckets)) {
      const bTime = Number(key);
      if (bTime < bucketTime) {
        const parts = getBucketMinuteSlotsForBucket(
          bTime,
          barSeconds,
          work.closedMinuteBars,
          work.openBuckets[key],
        );
        const sealed = aggregateBarsCollection(bTime, parts);
        if (sealed !== null) {
          const upserted = upsertSortedBar(work.closedBars, sealed);
          work.closedBars = upserted.bars;
          if (!upserted.replaced) {
            work.closedCount += 1;
          }
        }
      }
    }
  }
}

function applyTradeTick(
  work: MutableConsolidationWork,
  barSeconds: number,
  trade: WsTradeEvent,
): void {
  const secTime = trade.timeSec;
  const bucketTime = getBucketStart(secTime, barSeconds);
  const minuteTime = getBucketStart(secTime, 60);
  const lastClosed = work.closedBars[work.closedBars.length - 1];
  const latestClosedTime = lastClosed !== undefined ? lastClosed.time : -1;

  if (
    bucketTime <= latestClosedTime ||
    work.closedBars.some((b) => b.time === bucketTime) ||
    (barSeconds >= 60 && work.closedMinuteBars[String(minuteTime)] !== undefined)
  ) {
    work.staleEventsIgnored += 1;
    return;
  }

  const bucketKey = String(bucketTime);
  const existingSlots = work.openBuckets[bucketKey] ?? {};
  const prevSlot = existingSlots[String(secTime)];

  if (prevSlot !== undefined && prevSlot.source === 'A') {
    // 1-second authoritative aggregate bar A already closed this second
    work.staleEventsIgnored += 1;
    return;
  }

  const nextSlots: Record<string, FormingSecondSlot> = { ...existingSlots };
  nextSlots[String(secTime)] = buildSecondSlotFromTrade(prevSlot, trade);
  work.openBuckets[bucketKey] = nextSlots;
  work.tradesFolded += 1;
}

/**
 * Pure, immutable state transition consuming raw WebSocket JSON text, raw parsed payloads,
 * or pre-normalized `WsNormalizedEvent[]`.
 *
 * - Overwrites existing bars cleanly on `A` and `AM` FINRA TRF rebroadcasts (never double-counts volume).
 * - Deduplicates overlapping `T` ticks and authoritative 1-second `A` bars within the same second.
 * - Preserves input `state` and `events` completely unmutated.
 */
export function ingestWsEvents(
  state: LiveBarState,
  input: unknown,
  options: LiveBarIngestOptions = {},
): LiveBarState {
  const maxDiscardRecords = options.maxDiscardRecords ?? DEFAULT_MAX_DISCARD_RECORDS;

  let events: readonly WsNormalizedEvent[];
  let addedDiscards = 0;
  let addedCounts = createDiscardCounts();
  let addedRecords: readonly DiscardRecord[] = [];

  if (typeof input === 'string') {
    const parsed = parseWsJsonPayload(input, maxDiscardRecords);
    events = parsed.events;
    addedDiscards = parsed.discarded;
    addedCounts = parsed.discardCounts;
    addedRecords = parsed.discardRecords;
  } else if (Array.isArray(input)) {
    const looksNormalized = input.every(
      (item) =>
        isRecord(item) &&
        ((item['ev'] === 'status' && typeof item['status'] === 'string') ||
          ((item['ev'] === 'A' || item['ev'] === 'AM') && isRecord(item['bar'])) ||
          (item['ev'] === 'T' && isFiniteNumber(item['price'])) ||
          (item['ev'] === 'Q' && isFiniteNumber(item['bidPrice'])) ||
          item['ev'] === 'AD' ||
          item['ev'] === 'LULD'),
    );
    if (looksNormalized) {
      events = input as readonly WsNormalizedEvent[];
    } else {
      const parsed = normalizeWsPayload(input, maxDiscardRecords);
      events = parsed.events;
      addedDiscards = parsed.discarded;
      addedCounts = parsed.discardCounts;
      addedRecords = parsed.discardRecords;
    }
  } else {
    const parsed = normalizeWsPayload(input, maxDiscardRecords);
    events = parsed.events;
    addedDiscards = parsed.discarded;
    addedCounts = parsed.discardCounts;
    addedRecords = parsed.discardRecords;
  }

  const clonedOpenBuckets: Record<string, Record<string, FormingSecondSlot>> = {};
  for (const [bk, secMap] of Object.entries(state.openBuckets)) {
    const clonedSecMap: Record<string, FormingSecondSlot> = {};
    for (const [sk, slot] of Object.entries(secMap)) {
      clonedSecMap[sk] = {
        time: slot.time,
        source: slot.source,
        bar: copyBar(slot.bar),
        notional: slot.notional,
        hasValidVw: slot.hasValidVw,
      };
    }
    clonedOpenBuckets[bk] = clonedSecMap;
  }

  const clonedClosedMinuteBars: Record<string, Bar> = {};
  for (const [mk, mb] of Object.entries(state.closedMinuteBars)) {
    clonedClosedMinuteBars[mk] = copyBar(mb);
  }

  const work: MutableConsolidationWork = {
    closedBars: state.closedBars.map(copyBar),
    openBuckets: clonedOpenBuckets,
    closedMinuteBars: clonedClosedMinuteBars,
    closedCount: state.metrics.closedCount,
    rebroadcastOverwrites: state.metrics.rebroadcastOverwrites,
    secondRebroadcastOverwrites: state.metrics.secondRebroadcastOverwrites,
    tradesFolded: state.metrics.tradesFolded,
    staleEventsIgnored: state.metrics.staleEventsIgnored,
  };

  for (const event of events) {
    if (event.ev === 'status' || event.ev === 'Q' || event.ev === 'AD' || event.ev === 'LULD') {
      continue;
    }
    if (options.symbol !== undefined && event.sym !== options.symbol) {
      continue;
    }
    switch (event.ev) {
      case 'AM':
        applyOneMinuteClose(work, state.barSeconds, event);
        break;
      case 'A':
        applyOneSecondAgg(work, state.barSeconds, event);
        break;
      case 'T':
        applyTradeTick(work, state.barSeconds, event);
        break;
    }
  }

  const pruned = pruneToMaxClosedBars(
    work.closedBars,
    work.openBuckets,
    work.closedMinuteBars,
    options.maxClosedBars,
  );
  const derived = deriveActiveFormingBar(
    state.barSeconds,
    pruned.closedBars,
    pruned.openBuckets,
    pruned.closedMinuteBars,
  );

  const nextDiscardCounts: DiscardCounts = {
    malformedRow: state.metrics.discardCounts.malformedRow + addedCounts.malformedRow,
    invalidTime: state.metrics.discardCounts.invalidTime + addedCounts.invalidTime,
    nonFinite: state.metrics.discardCounts.nonFinite + addedCounts.nonFinite,
    invalidPrice: state.metrics.discardCounts.invalidPrice + addedCounts.invalidPrice,
    highBelowLow: state.metrics.discardCounts.highBelowLow + addedCounts.highBelowLow,
    invalidOhlc: state.metrics.discardCounts.invalidOhlc + addedCounts.invalidOhlc,
    invalidVolume: state.metrics.discardCounts.invalidVolume + addedCounts.invalidVolume,
    duplicate: state.metrics.discardCounts.duplicate + addedCounts.duplicate,
  };

  const nextMetrics: LiveBarMetrics = {
    closedCount: work.closedCount,
    rebroadcastOverwrites: work.rebroadcastOverwrites,
    secondRebroadcastOverwrites: work.secondRebroadcastOverwrites,
    tradesFolded: work.tradesFolded,
    staleEventsIgnored: work.staleEventsIgnored,
    discardedEvents: state.metrics.discardedEvents + addedDiscards,
    discardCounts: nextDiscardCounts,
  };

  const mergedDiscardRecords = [...state.discardRecords, ...addedRecords].slice(
    0,
    maxDiscardRecords,
  );

  return {
    barSeconds: state.barSeconds,
    closedBars: pruned.closedBars,
    formingBucketTime: derived.formingBucketTime,
    formingBar: derived.formingBar,
    openBuckets: pruned.openBuckets,
    closedMinuteBars: pruned.closedMinuteBars,
    metrics: nextMetrics,
    discardRecords: mergedDiscardRecords,
  };
}

/**
 * Pure live indicator projection computing EMA, Session VWAP, and AVWAP over
 * `state.formingBar` without modifying closed indicator states.
 * Returns `NaN` / `null` explicitly when `formingBar === null` or inputs are invalid.
 */
export function projectLiveIndicators(
  state: LiveBarState,
  inputs: LiveProjectionInputs,
): LiveProjectionResult {
  const forming = state.formingBar;
  if (forming === null) {
    return {
      formingTime: null,
      ema: Number.NaN,
      sessionVwap: null,
      avwap: null,
    };
  }

  const ema =
    inputs.ema !== undefined
      ? projectLiveEma(inputs.ema.lastClosedEma, forming.close, inputs.ema.period)
      : Number.NaN;

  const sessionVwap =
    inputs.sessionVwap !== undefined
      ? projectLiveSessionVwap(
          inputs.sessionVwap.closedState,
          forming,
          inputs.sessionVwap.options,
        )
      : null;

  const avwap =
    inputs.avwap !== undefined
      ? projectLiveAvwap(inputs.avwap.closedState, forming)
      : null;

  return {
    formingTime: forming.time,
    ema,
    sessionVwap,
    avwap,
  };
}
