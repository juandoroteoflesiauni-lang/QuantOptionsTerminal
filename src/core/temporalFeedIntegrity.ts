import { getBuenosAiresParts, GGAL_ADR_RATIO } from './ggal/types.js';
import { getMarketParts } from './sessions.js';

export const MIN_PLAUSIBLE_EPOCH_SEC = 946_684_800;
export const MAX_PLAUSIBLE_EPOCH_SEC = 4_102_444_800;
export const MIN_PLAUSIBLE_EPOCH_MS = MIN_PLAUSIBLE_EPOCH_SEC * 1_000;
export const MAX_PLAUSIBLE_EPOCH_MS = MAX_PLAUSIBLE_EPOCH_SEC * 1_000;

export type TradierTimestampFieldHint =
  | 'BID_DATE' | 'ASK_DATE' | 'TRADE_DATE' | 'QUOTE_DATE'
  | 'GREEKS_UPDATED_AT' | 'STREAM_EVENT_DATE' | 'GENERIC';
export type ParsedTimestampUnit =
  | 'EPOCH_SEC' | 'EPOCH_MS' | 'ISO_8601_TZ' | 'TRADIER_GREEKS_UTC_SPACE' | 'NONE';
export type TimestampRejectReason =
  | 'MISSING' | 'INVALID_TYPE' | 'NON_INTEGER_EPOCH' | 'OUT_OF_RANGE'
  | 'AMBIGUOUS_UNIT' | 'INVALID_ISO_FORMAT' | 'MISSING_TIMEZONE' | 'INVALID_CALENDAR_DATE';

export interface ParsedProviderTimestamp {
  readonly ok: boolean;
  readonly utcSec: number;
  readonly nativeMs: number;
  readonly unit: ParsedTimestampUnit;
  readonly rejectReason: TimestampRejectReason | null;
}

function rejectTimestamp(rejectReason: TimestampRejectReason): ParsedProviderTimestamp {
  return { ok: false, utcSec: Number.NaN, nativeMs: Number.NaN, unit: 'NONE', rejectReason };
}

function parsedTimestamp(nativeMs: number, unit: ParsedTimestampUnit): ParsedProviderTimestamp {
  return { ok: true, utcSec: Math.floor(nativeMs / 1_000), nativeMs, unit, rejectReason: null };
}

function parseEpoch(value: bigint): ParsedProviderTimestamp {
  if (value < BigInt(MIN_PLAUSIBLE_EPOCH_SEC) || value > BigInt(MAX_PLAUSIBLE_EPOCH_MS)) {
    return rejectTimestamp('OUT_OF_RANGE');
  }
  if (value <= BigInt(MAX_PLAUSIBLE_EPOCH_SEC)) return parsedTimestamp(Number(value) * 1_000, 'EPOCH_SEC');
  if (value < BigInt(MIN_PLAUSIBLE_EPOCH_MS)) return rejectTimestamp('AMBIGUOUS_UNIT');
  return parsedTimestamp(Number(value), 'EPOCH_MS');
}

const WALL_TIME = /^(\d{4})-(\d{2})-(\d{2})([T ])(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?$/i;

export function parseTradierTimestamp(
  value: unknown,
  fieldHint: TradierTimestampFieldHint = 'GENERIC',
): ParsedProviderTimestamp {
  if (value === undefined || value === null) return rejectTimestamp('MISSING');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return rejectTimestamp('INVALID_TYPE');
    if (!Number.isInteger(value)) return rejectTimestamp('NON_INTEGER_EPOCH');
    return parseEpoch(BigInt(value));
  }
  if (typeof value !== 'string') return rejectTimestamp('INVALID_TYPE');
  const trimmed = value.trim();
  if (trimmed === '') return rejectTimestamp('MISSING');
  if (/^\d+$/.test(trimmed)) return parseEpoch(BigInt(trimmed));
  if (/^-\d+(?:\.\d+)?$/.test(trimmed)) return rejectTimestamp('OUT_OF_RANGE');
  if (/^\+?\d+\.\d+$/.test(trimmed)) return rejectTimestamp('NON_INTEGER_EPOCH');
  const match = WALL_TIME.exec(trimmed);
  if (match === null) return rejectTimestamp('INVALID_ISO_FORMAT');
  const [, year, month, day, separator, hour, minute, second, fraction, zone] = match;
  if (zone === undefined && (fieldHint !== 'GREEKS_UPDATED_AT' || separator !== ' ' || fraction !== undefined)) {
    return rejectTimestamp('MISSING_TIMEZONE');
  }
  const wall = new Date(0);
  wall.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  wall.setUTCHours(Number(hour), Number(minute), Number(second), Number((fraction ?? '').padEnd(3, '0').slice(0, 3)));
  if (wall.getUTCFullYear() !== Number(year) || wall.getUTCMonth() + 1 !== Number(month) ||
    wall.getUTCDate() !== Number(day) || wall.getUTCHours() !== Number(hour) ||
    wall.getUTCMinutes() !== Number(minute) || wall.getUTCSeconds() !== Number(second)) {
    return rejectTimestamp('INVALID_CALENDAR_DATE');
  }
  let offsetMinutes = 0;
  if (zone !== undefined && zone.toUpperCase() !== 'Z') {
    offsetMinutes = (zone[0] === '-' ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(-2)));
  }
  const nativeMs = wall.getTime() - offsetMinutes * 60_000;
  if (nativeMs < MIN_PLAUSIBLE_EPOCH_MS || nativeMs > MAX_PLAUSIBLE_EPOCH_MS) {
    return rejectTimestamp('OUT_OF_RANGE');
  }
  return parsedTimestamp(nativeMs, zone === undefined ? 'TRADIER_GREEKS_UTC_SPACE' : 'ISO_8601_TZ');
}

export const CCL_OVERLAP_MAX_SKEW_SEC = 60;
export const CCL_OVERLAP_MAX_LEG_AGE_SEC = 120;
const CCL_EOD_MAX_SKEW_SEC = 28_800;

export type CclQualityState = 'CONTEMPORANEOUS' | 'SKEW_DEGRADED' | 'STALE_LEG' | 'MISSING_LEG' | 'EOD_CLOSE_REF';
export type CclMarketRegime =
  | 'OVERLAP' | 'BYMA_ONLY' | 'NASDAQ_SOLO_17_18' | 'PREMARKET_REPRICE' | 'EXTENDED_US' | 'CLOSED';

export interface CclTemporalValuation {
  readonly value: number;
  readonly livePublishable: boolean;
  readonly bymaTimestamp: number | null;
  readonly adrTimestamp: number | null;
  readonly bymaReceivedAt: number | null;
  readonly adrReceivedAt: number | null;
  readonly legSkewSec: number | null;
  readonly bymaAgeSec: number | null;
  readonly adrAgeSec: number | null;
  readonly valuationTimestamp: number | null;
  readonly cclQuality: CclQualityState;
  readonly marketRegime: CclMarketRegime;
  readonly sameTradingDay: boolean | null;
  readonly maxAllowedSkewSec: number | null;
  readonly rejectReason: null | 'MISSING_BYMA_LEG' | 'MISSING_ADR_LEG' | 'INVALID_TIMESTAMP'
    | 'FUTURE_CLOCK_SKEW' | 'CROSS_SESSION_DAY_MISMATCH' | 'LEG_SKEW_EXCEEDED'
    | 'BYMA_LEG_STALE' | 'ADR_LEG_STALE' | 'NON_OVERLAP_REGIME';
}

interface CclLeg {
  readonly price: number;
  readonly timeSec: number | null;
  readonly receivedAtSec?: number | null;
}

export function resolveGgalMarketSessionDateKey(timeSec: number, mode: 'ADR' | 'ARS' | 'CCL'): string {
  return mode === 'ADR' ? getMarketParts(timeSec, 'EQUITY').dateKey : getBuenosAiresParts(timeSec).dateKey;
}

function validUtcSec(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_PLAUSIBLE_EPOCH_SEC
    ? value : null;
}

export function evaluateCclContemporaneity(input: {
  readonly byma: CclLeg;
  readonly adr: CclLeg;
  readonly evaluationNowSec: number;
  readonly marketRegime: CclMarketRegime;
  readonly isEodMode?: boolean;
  readonly ratio?: number;
  readonly maxAllowedSkewSec?: number;
  readonly maxLegAgeSec?: number;
}): CclTemporalValuation {
  const { byma, adr, evaluationNowSec, marketRegime, ratio = GGAL_ADR_RATIO } = input;
  const bymaTimestamp = validUtcSec(byma.timeSec);
  const adrTimestamp = validUtcSec(adr.timeSec);
  const bymaAgeSec = bymaTimestamp === null ? null : evaluationNowSec - bymaTimestamp;
  const adrAgeSec = adrTimestamp === null ? null : evaluationNowSec - adrTimestamp;
  const eod = input.isEodMode === true || marketRegime === 'CLOSED';
  const maxAllowedSkewSec = eod ? CCL_EOD_MAX_SKEW_SEC
    : marketRegime === 'OVERLAP' ? input.maxAllowedSkewSec ?? CCL_OVERLAP_MAX_SKEW_SEC : null;
  const maxLegAgeSec = input.maxLegAgeSec ?? CCL_OVERLAP_MAX_LEG_AGE_SEC;
  const legSkewSec = bymaTimestamp === null || adrTimestamp === null ? null : Math.abs(bymaTimestamp - adrTimestamp);
  const sameTradingDay = bymaTimestamp === null || adrTimestamp === null ? null
    : resolveGgalMarketSessionDateKey(bymaTimestamp, 'ARS') === resolveGgalMarketSessionDateKey(adrTimestamp, 'ADR');
  const base = {
    bymaTimestamp, adrTimestamp, bymaAgeSec, adrAgeSec, legSkewSec, sameTradingDay, maxAllowedSkewSec, marketRegime,
    bymaReceivedAt: validUtcSec(byma.receivedAtSec), adrReceivedAt: validUtcSec(adr.receivedAtSec),
  };
  const missingByma = !Number.isFinite(byma.price) || byma.price <= 0;
  const missingAdr = !Number.isFinite(adr.price) || adr.price <= 0;
  const value = missingByma || missingAdr || !Number.isFinite(ratio) || ratio <= 0
    ? Number.NaN : (byma.price * ratio) / adr.price;
  const result = (
    cclQuality: CclQualityState,
    rejectReason: CclTemporalValuation['rejectReason'],
    valuationTimestamp: number | null = null,
  ): CclTemporalValuation => ({
    ...base, value: cclQuality === 'MISSING_LEG' ? Number.NaN : value,
    cclQuality, rejectReason, valuationTimestamp, livePublishable: cclQuality === 'CONTEMPORANEOUS',
  });
  if (missingByma) return result('MISSING_LEG', 'MISSING_BYMA_LEG');
  if (missingAdr) return result('MISSING_LEG', 'MISSING_ADR_LEG');
  if (bymaTimestamp === null || adrTimestamp === null || legSkewSec === null ||
    bymaAgeSec === null || adrAgeSec === null || validUtcSec(evaluationNowSec) === null || !Number.isFinite(value)) {
    return result('MISSING_LEG', 'INVALID_TIMESTAMP');
  }
  if (bymaAgeSec < -5 || adrAgeSec < -5) return result('STALE_LEG', 'FUTURE_CLOCK_SKEW');
  const valuationTimestamp = Math.min(bymaTimestamp, adrTimestamp);
  if (!sameTradingDay || (eod && legSkewSec > CCL_EOD_MAX_SKEW_SEC)) {
    return result('SKEW_DEGRADED', 'CROSS_SESSION_DAY_MISMATCH');
  }
  if (eod) return result('EOD_CLOSE_REF', null, valuationTimestamp);
  if (maxAllowedSkewSec === null) return result('SKEW_DEGRADED', 'NON_OVERLAP_REGIME');
  if (legSkewSec > maxAllowedSkewSec) return result('SKEW_DEGRADED', 'LEG_SKEW_EXCEEDED');
  if (bymaAgeSec > maxLegAgeSec) return result('STALE_LEG', 'BYMA_LEG_STALE');
  if (adrAgeSec > maxLegAgeSec) return result('STALE_LEG', 'ADR_LEG_STALE');
  return result('CONTEMPORANEOUS', null, valuationTimestamp);
}

interface BucketTradeOrder {
  readonly eventTimeMs: number;
  readonly sequence?: number;
  readonly tradeId?: string;
  readonly arrivalOrder: number;
}

export function compareBucketTrades(a: BucketTradeOrder, b: BucketTradeOrder): number {
  if (a.eventTimeMs !== b.eventTimeMs) return a.eventTimeMs - b.eventTimeMs;
  if (a.sequence !== undefined && b.sequence !== undefined && a.sequence !== b.sequence) return a.sequence - b.sequence;
  if (a.tradeId && b.tradeId && a.tradeId !== b.tradeId) return a.tradeId < b.tradeId ? -1 : 1;
  return a.arrivalOrder - b.arrivalOrder;
}
