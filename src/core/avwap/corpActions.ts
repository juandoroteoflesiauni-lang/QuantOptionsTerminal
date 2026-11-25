import { canonicalBarPrice } from '../avwapCanonicalMonth.js';
import type { Bar } from '../types.js';
import {
  combineWelfordStates,
  createInitialWelfordState,
  updateWelford,
  type WelfordState,
} from '../welford.js';

export interface SpecialDividendO1Result {
  readonly state: WelfordState;
  readonly applied: boolean;
  readonly factor: number;
}

/**
 * Applies an exact O(1) split / reverse-split transformation to `WelfordState`.
 *
 * `k = splitFrom / splitTo` (e.g. 10:1 forward split -> `k = 0.1`):
 * `cumWeight' = cumWeight / k`, `mean' = mean * k`, `m2' = m2 * k` (`stdDev' = stdDev * k`).
 */
export function applySplitO1(
  state: WelfordState,
  splitFrom: number,
  splitTo: number,
): WelfordState {
  if (!Number.isFinite(splitFrom) || splitFrom <= 0) {
    throw new RangeError(`splitFrom must be finite > 0, got ${String(splitFrom)}`);
  }
  if (!Number.isFinite(splitTo) || splitTo <= 0) {
    throw new RangeError(`splitTo must be finite > 0, got ${String(splitTo)}`);
  }
  if (state.cumWeight === 0) {
    return { ...state };
  }

  const k = splitFrom / splitTo;
  return {
    count: state.count,
    cumWeight: state.cumWeight / k,
    mean: state.mean * k,
    m2: state.m2 * k,
  };
}

/**
 * Applies an exact O(1) special-dividend adjustment when `cashAmount / prevClose >= minPct`.
 *
 * Factor `d = (prevClose - cashAmount) / prevClose`:
 * `cumWeight' = cumWeight`, `mean' = mean * d`, `m2' = m2 * d * d`.
 */
export function applySpecialDividendO1(
  state: WelfordState,
  cashAmount: number,
  prevClose: number,
  minPct = 0.015,
): SpecialDividendO1Result {
  if (!Number.isFinite(cashAmount) || cashAmount < 0) {
    throw new RangeError(`cashAmount must be finite >= 0, got ${String(cashAmount)}`);
  }
  if (!Number.isFinite(prevClose) || prevClose <= 0) {
    throw new RangeError(`prevClose must be finite > 0, got ${String(prevClose)}`);
  }
  if (!Number.isFinite(minPct) || minPct < 0) {
    throw new RangeError(`minPct must be finite >= 0, got ${String(minPct)}`);
  }
  if (cashAmount >= prevClose) {
    throw new RangeError(
      `Impossible dividend factor: cashAmount (${String(cashAmount)}) >= prevClose (${String(prevClose)})`,
    );
  }

  if (state.cumWeight === 0 || cashAmount === 0 || cashAmount / prevClose < minPct) {
    return {
      state: { ...state },
      applied: false,
      factor: 1,
    };
  }

  const factor = (prevClose - cashAmount) / prevClose;
  if (!(factor > 0 && factor < 1)) {
    throw new RangeError(`Dividend factor out of (0, 1): ${String(factor)}`);
  }

  return {
    state: {
      count: state.count,
      cumWeight: state.cumWeight,
      mean: state.mean * factor,
      m2: state.m2 * factor * factor,
    },
    applied: true,
    factor,
  };
}

/**
 * Closed-form Parkinson intrabar second central moment estimate:
 * `W * mu^2 * ln(high / low)^2 / (24 * ln(2))`.
 *
 * Returns `NaN` when inputs are non-calculable (zero silent fallbacks).
 */
export function estimateParkinsonM2Within(
  totalVolume: number,
  vwap: number,
  high: number,
  low: number,
): number {
  if (
    !Number.isFinite(totalVolume) ||
    totalVolume < 0 ||
    !Number.isFinite(vwap) ||
    vwap <= 0 ||
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    low <= 0 ||
    high < low
  ) {
    return Number.NaN;
  }
  if (totalVolume === 0 || high === low) {
    return 0;
  }
  const logHl = Math.log(high / low);
  return (totalVolume * vwap * vwap * logHl * logHl) / (24 * Math.LN2);
}

/**
 * Resolves the canonical bar price, accepting finite `bar.vw > 0` even when outside `[low, high]`
 * (preserving legitimate out-of-range block/auction VWAP prints) and delegating fallback to
 * `canonicalBarPrice` `(H+L+C)/3` when `vw` is absent or non-positive.
 */
export function resolveInstitutionalBarPrice(bar: Bar): number {
  if (bar.vw !== undefined && Number.isFinite(bar.vw) && bar.vw > 0) {
    return bar.vw;
  }
  if (
    !Number.isFinite(bar.high) ||
    !Number.isFinite(bar.low) ||
    !Number.isFinite(bar.close) ||
    bar.high <= 0 ||
    bar.low <= 0 ||
    bar.close <= 0
  ) {
    return Number.NaN;
  }
  return canonicalBarPrice(bar);
}

/**
 * Consolidates 1m canonical bars into an immutable `(count, cumWeight, mean, m2)` WelfordState
 * using `updateWelford` without mutating inputs.
 */
export function rollupBarsToMoments(bars: readonly Bar[]): WelfordState {
  let acc = createInitialWelfordState();
  for (const bar of bars) {
    if (!Number.isFinite(bar.volume) || bar.volume <= 0) {
      continue;
    }
    const price = resolveInstitutionalBarPrice(bar);
    if (!Number.isFinite(price) || price <= 0) {
      continue;
    }
    acc = updateWelford(acc, price, bar.volume).state;
  }
  return acc;
}

/**
 * Combines a sequence of `WelfordState` moments via associative 7-FLOP Chan/Pebay parallel merge.
 */
export function combineMomentStates(states: readonly WelfordState[]): WelfordState {
  let acc = createInitialWelfordState();
  for (const st of states) {
    acc = combineWelfordStates(acc, st);
  }
  return acc;
}
