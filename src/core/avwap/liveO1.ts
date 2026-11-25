import {
  combineWelfordStates,
  createInitialWelfordState,
  getWelfordOutput,
  updateWelford,
  type WelfordState,
} from '../welford.js';
import type { LiveAnchorProjection, LiveBarAccumulator } from './types.js';

const MAX_TIME_SECONDS = 1e11;

export interface CreateLiveBarAccumulatorOptions {
  readonly symbol?: string;
  readonly adjSig?: string;
  readonly source?: 'TRADIER_WS' | 'GENERIC_LIVE';
}

/**
 * Allocates an immutable intraminute live accumulator keyed by integer UTC seconds.
 */
export function createLiveBarAccumulator(
  minuteBucketUtcSec: number,
  options?: CreateLiveBarAccumulatorOptions,
): LiveBarAccumulator {
  if (
    !Number.isFinite(minuteBucketUtcSec) ||
    !Number.isInteger(minuteBucketUtcSec) ||
    Math.abs(minuteBucketUtcSec) > MAX_TIME_SECONDS
  ) {
    throw new RangeError(
      `minuteBucketUtcSec must be finite integer UTC seconds (got ${String(minuteBucketUtcSec)})`,
    );
  }

  return {
    minuteBucketUtcSec,
    open: Number.NaN,
    high: Number.NaN,
    low: Number.NaN,
    close: Number.NaN,
    welford: createInitialWelfordState(),
    lastTickUtcSec: null,
    tickCount: 0,
    symbol: options?.symbol ?? null,
    adjSig: options?.adjSig ?? null,
    source: options?.source ?? 'GENERIC_LIVE',
  };
}

/**
 * Pure O(1) tick ingestion into the single per-symbol intraminute `WelfordState` accumulator.
 * Discards non-finite prices, non-positive sizes, or non-finite timestamps without mutating input.
 */
export function ingestLiveTickO1(
  acc: LiveBarAccumulator,
  price: number,
  size: number,
  tsUtcSec: number,
): LiveBarAccumulator {
  if (
    !Number.isFinite(price) ||
    price <= 0 ||
    !Number.isFinite(size) ||
    size <= 0 ||
    !Number.isFinite(tsUtcSec) ||
    Math.abs(tsUtcSec) > MAX_TIME_SECONDS
  ) {
    return acc;
  }

  const nextWelford = updateWelford(acc.welford, price, size).state;
  const firstTick = acc.tickCount === 0 || !Number.isFinite(acc.open);

  return {
    minuteBucketUtcSec: acc.minuteBucketUtcSec,
    open: firstTick ? price : acc.open,
    high: firstTick ? price : Math.max(acc.high, price),
    low: firstTick ? price : Math.min(acc.low, price),
    close: price,
    welford: nextWelford,
    lastTickUtcSec: tsUtcSec,
    tickCount: acc.tickCount + 1,
    symbol: acc.symbol,
    adjSig: acc.adjSig,
    source: acc.source,
  };
}

/**
 * Pure O(1) 7-FLOP parallel Chan/Pebay live projection across any committed anchor.
 * Never mutates `committedState` or `liveAcc`.
 */
export function projectAnchorLiveO1(
  committedState: WelfordState,
  liveAcc: LiveBarAccumulator,
): LiveAnchorProjection {
  const merged = combineWelfordStates(committedState, liveAcc.welford);
  const output = getWelfordOutput(merged);
  return {
    state: merged,
    avwap: output.vwap,
    stdDev: output.stdDev,
    cumWeight: merged.cumWeight,
    m2: merged.m2,
    count: merged.count,
    minuteBucketUtcSec: liveAcc.minuteBucketUtcSec,
    lastTickUtcSec: liveAcc.lastTickUtcSec,
  };
}

/**
 * Pure O(1) reconciliation when an authoritative canonical bar closes.
 * Returns the updated `committedState` without mutating inputs.
 */
export function commitClosedMinuteO1(
  committedState: WelfordState,
  closedBar: WelfordState,
): WelfordState {
  return combineWelfordStates(committedState, closedBar);
}

/**
 * Fixed-size ring buffer storing `horizonH + 1` values for O(1) normalized AVWAP slope.
 */
export interface SlopeRingBuffer {
  readonly horizonH: number;
  readonly capacity: number;
  readonly values: readonly number[];
  /** Next write slot `[0, capacity)`. */
  readonly nextIndex: number;
  readonly length: number;
}

export function createSlopeRingBuffer(horizonH: number): SlopeRingBuffer {
  if (!Number.isInteger(horizonH) || horizonH < 1) {
    throw new RangeError(`horizonH must be an integer >= 1, got ${String(horizonH)}`);
  }
  const capacity = horizonH + 1;
  return {
    horizonH,
    capacity,
    values: new Array<number>(capacity).fill(Number.NaN),
    nextIndex: 0,
    length: 0,
  };
}

/** Appends an AVWAP observation in O(1) fixed storage (immutable copy-on-write of small ring). */
export function pushSlopeRingBufferO1(
  buffer: SlopeRingBuffer,
  avwap: number,
): SlopeRingBuffer {
  const nextValues = buffer.values.slice();
  nextValues[buffer.nextIndex] = Number.isFinite(avwap) ? avwap : Number.NaN;
  const nextIndex = (buffer.nextIndex + 1) % buffer.capacity;
  const length = Math.min(buffer.capacity, buffer.length + 1);
  return {
    horizonH: buffer.horizonH,
    capacity: buffer.capacity,
    values: nextValues,
    nextIndex,
    length,
  };
}

/**
 * Returns `s_norm = (avwap[t] - avwap[t - h]) / (h * atr14)` in O(1), or `NaN` when warmup
 * is incomplete or any endpoint / `atr14` is non-calculable.
 */
export function getNormalizedSlopeO1(
  buffer: SlopeRingBuffer,
  atr14: number,
): number {
  if (buffer.length < buffer.capacity || !Number.isFinite(atr14) || atr14 <= 0) {
    return Number.NaN;
  }
  const oldestIdx = buffer.nextIndex;
  const latestIdx = (buffer.nextIndex - 1 + buffer.capacity) % buffer.capacity;
  const oldest = buffer.values[oldestIdx] ?? Number.NaN;
  const latest = buffer.values[latestIdx] ?? Number.NaN;
  if (!Number.isFinite(latest) || !Number.isFinite(oldest)) {
    return Number.NaN;
  }
  return (latest - oldest) / (buffer.horizonH * atr14);
}

export interface PendingChopCross {
  readonly detectedAt: number;
  readonly originSide: -1 | 1;
  readonly targetSide: -1 | 1;
}

export interface RollingChopConfig {
  readonly neutralBandAtr?: number;
  readonly rollingWindow?: number;
  readonly excursionAtr?: number;
  readonly confirmationWindow?: number;
}

/**
 * Strictly causal O(1)-amortized rolling 12-bar chop cross tracker matching Eje 4.2.
 */
export interface RollingChopTracker {
  readonly barIndex: number;
  readonly lastOutsideSide: -1 | 1 | null;
  readonly pending: readonly PendingChopCross[];
  /** Sorted queue of confirmed bar indices; pruned causally against `[barIndex - (window - 1), barIndex]`. */
  readonly confirmedAt: readonly number[];
  readonly neutralBandAtr: number;
  readonly rollingWindow: number;
  readonly excursionAtr: number;
  readonly confirmationWindow: number;
}

export function createRollingChopTracker(config?: RollingChopConfig): RollingChopTracker {
  return {
    barIndex: -1,
    lastOutsideSide: null,
    pending: [],
    confirmedAt: [],
    neutralBandAtr: config?.neutralBandAtr ?? 0.2,
    rollingWindow: config?.rollingWindow ?? 12,
    excursionAtr: config?.excursionAtr ?? 1.0,
    confirmationWindow: config?.confirmationWindow ?? 3,
  };
}

export interface RollingChopBarInput {
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly avwap: number;
  readonly atr14: number;
}

export interface RollingChopStepResult {
  readonly tracker: RollingChopTracker;
  readonly chopCrossCount12: number;
}

export function stepRollingChopO1(
  tracker: RollingChopTracker,
  bar: RollingChopBarInput,
): RollingChopStepResult {
  const t = tracker.barIndex + 1;
  if (
    !Number.isFinite(bar.high) ||
    !Number.isFinite(bar.low) ||
    !Number.isFinite(bar.close) ||
    !Number.isFinite(bar.avwap) ||
    !Number.isFinite(bar.atr14) ||
    bar.atr14 <= 0
  ) {
    const winLo = t - (tracker.rollingWindow - 1);
    const pruned = tracker.confirmedAt.filter((idx) => idx >= winLo);
    return {
      tracker: {
        ...tracker,
        barIndex: t,
        confirmedAt: pruned,
      },
      chopCrossCount12: pruned.length,
    };
  }

  const maxExc = Math.max(Math.abs(bar.high - bar.avwap), Math.abs(bar.low - bar.avwap)) / bar.atr14;
  const nextPending: PendingChopCross[] = [];
  const newlyConfirmed: number[] = [];

  for (const p of tracker.pending) {
    if (maxExc >= tracker.excursionAtr) {
      continue;
    }
    if (t - p.detectedAt >= tracker.confirmationWindow) {
      newlyConfirmed.push(t);
      continue;
    }
    nextPending.push(p);
  }

  const upper = bar.avwap + tracker.neutralBandAtr * bar.atr14;
  const lower = bar.avwap - tracker.neutralBandAtr * bar.atr14;
  const curSide: -1 | 1 | null = bar.close > upper ? 1 : bar.close < lower ? -1 : null;

  let nextOutsideSide = tracker.lastOutsideSide;
  if (curSide !== null) {
    if (nextOutsideSide !== null && curSide !== nextOutsideSide) {
      nextPending.push({
        detectedAt: t,
        originSide: nextOutsideSide,
        targetSide: curSide,
      });
    }
    nextOutsideSide = curSide;
  }

  const winLo = t - (tracker.rollingWindow - 1);
  const nextConfirmed = tracker.confirmedAt
    .filter((idx) => idx >= winLo)
    .concat(newlyConfirmed.filter((idx) => idx >= winLo));

  return {
    tracker: {
      ...tracker,
      barIndex: t,
      lastOutsideSide: nextOutsideSide,
      pending: nextPending,
      confirmedAt: nextConfirmed,
    },
    chopCrossCount12: nextConfirmed.length,
  };
}

/**
 * Detects corporate-action split/dividend revision invalidations from `UsHistoricalService.adjustmentRevision`.
 */
export function hasAdjustmentRevisionChanged(
  previousRevision: string | null | undefined,
  currentRevision: string | null | undefined,
): boolean {
  if (previousRevision === undefined || previousRevision === null || currentRevision === undefined || currentRevision === null) {
    return false;
  }
  return previousRevision !== currentRevision;
}
