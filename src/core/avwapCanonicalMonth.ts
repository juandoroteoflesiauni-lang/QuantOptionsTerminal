import type { Bar } from "./types.js";
import { getMarketParts } from "./sessions.js";
import { etWallTimeToUtc } from "../data/alignment.js";
import { usHistoricalSession } from "./usHistorical.js";
import {
  createInitialWelfordState,
  getWelfordOutput,
  updateWelford,
  welfordFromSeed,
  type WelfordState,
} from "./welford.js";

export type CanonicalCoverageQuality =
  | "COMPLETE_CANONICAL_1M"
  | "PARTIAL_MISSING_PREFIX"
  | "APPROX_AGGREGATED"
  | "UNAVAILABLE";
export type CanonicalPriceSource = "REAL_VW" | "HLC3_PROXY" | "MIXED_VW_HLC3";
export interface AvwapSeedContract {
  readonly anchorTimestamp: number;
  readonly seedEndExclusive: number;
  readonly sourceResolution: "1m" | "5m" | "15m" | "1h" | "4h" | "1D";
  readonly sessionMode: "RTH" | "EXTENDED";
  readonly seedPV: number;
  readonly seedV: number;
  readonly seedP2V: number;
  readonly seedCount: number;
  readonly seedMean: number;
  readonly seedM2: number;
  readonly coverageQuality: CanonicalCoverageQuality;
  readonly priceSource: CanonicalPriceSource;
}
export interface CanonicalMonthPoint {
  readonly time: number;
  readonly cutoff: number;
  readonly provisional: boolean;
  readonly vwap: number;
  readonly upper1: number;
  readonly lower1: number;
  readonly upper2: number;
  readonly lower2: number;
}
export interface CanonicalCheckpoint {
  readonly endExclusive: number;
  readonly state: WelfordState;
  readonly PV: number;
  readonly P2V: number;
  readonly real: number;
  readonly proxy: number;
}
export interface CanonicalMonthAccumulator {
  readonly symbol: string;
  readonly adjSig: string;
  readonly monthKey: string;
  readonly anchorTimestamp: number;
  readonly sessionMode: "RTH" | "EXTENDED";
  readonly sourceResolution: AvwapSeedContract["sourceResolution"];
  readonly coverageQuality: CanonicalCoverageQuality;
  readonly confirmedThrough: number;
  readonly checkpoints: readonly CanonicalCheckpoint[];
  readonly confirmedBar: Bar | null;
}
export interface CanonicalMonthInput {
  readonly bars: readonly Bar[];
  readonly now: number;
  readonly sessionMode: "RTH" | "EXTENDED";
  readonly symbol: string;
  readonly adjSig: string;
  readonly sourceResolution?: AvwapSeedContract["sourceResolution"];
  readonly market?: "US" | "AR";
}

/** Same per-bar VW rule as 0B, including legitimate VW outside OHLC. */
export function canonicalBarPrice(bar: Bar): number {
  return typeof bar.vw === "number" && Number.isFinite(bar.vw) && bar.vw > 0
    ? bar.vw
    : (bar.high + bar.low + bar.close) / 3;
}

/** Fresh sorted array, deterministic last-wins even for corrections. */
export function canonicalLastWins(bars: readonly Bar[]): readonly Bar[] {
  const unique = new Map<number, Bar>();
  for (const bar of bars)
    if (Number.isSafeInteger(bar.time) && bar.time > 0) unique.set(bar.time, { ...bar });
  return [...unique.values()].sort((a, b) => a.time - b.time);
}

function priceSource(real: number, proxy: number): CanonicalPriceSource {
  return real > 0 && proxy > 0 ? "MIXED_VW_HLC3" : real > 0 ? "REAL_VW" : "HLC3_PROXY";
}

/** Center prices before the unchanged Welford recurrence. This keeps tiny
 * dispersion near zero even when the quoted asset is around ARS 80000. */
function restoreOrigin(state: WelfordState, origin: number): WelfordState {
  return state.cumWeight > 0 ? { ...state, mean: origin + state.mean } : state;
}

/** Shared calendar bounds; AR is deliberately unverified and never canonical-complete. */
function monthBounds(now: number, mode: "RTH" | "EXTENDED", market: "US" | "AR") {
  if (market === "AR") {
    const d = new Date((now - 3 * 3600) * 1000);
    const anchor = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 3) / 1000;
    return {
      anchor,
      monthKey: `${String(d.getUTCFullYear())}-${String(d.getUTCMonth() + 1)}`,
      intervals: [] as { open: number; close: number }[],
    };
  }
  const p = getMarketParts(now, "EQUITY");
  const intervals: { open: number; close: number }[] = [];
  let anchor = etWallTimeToUtc(p.year, p.month, 1, 0);
  const days = new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
  for (let day = 1; day <= days; day += 1) {
    const session = usHistoricalSession(etWallTimeToUtc(p.year, p.month, day, 720));
    if (session === null) continue;
    const open = mode === "RTH" ? session.open : session.extendedOpen;
    const close = mode === "RTH" ? session.close : session.extendedClose;
    if (intervals.length === 0) anchor = open;
    intervals.push({ open, close });
  }
  return { anchor, monthKey: `${String(p.year)}-${String(p.month)}`, intervals };
}

/** Canonical 1m is the only statistical truth. Full eligible-minute grid is the
 * conservative evidence of completeness; provider gaps are never assumed empty.
 * A legitimate neutral seed inherits this independently established coverage.
 */
export function buildCanonicalMonthAccumulator(
  input: CanonicalMonthInput,
): CanonicalMonthAccumulator {
  const market = input.market ?? "US";
  const sourceResolution = input.sourceResolution ?? "1m";
  const local = getMarketParts(input.now, "EQUITY");
  if (market === "US" && (local.year < 2020 || local.year > 2028))
    return {
      symbol: input.symbol,
      adjSig: input.adjSig,
      monthKey: `${String(local.year)}-${String(local.month)}`,
      anchorTimestamp: etWallTimeToUtc(local.year, local.month, 1, 0),
      sessionMode: input.sessionMode,
      sourceResolution,
      coverageQuality: "UNAVAILABLE",
      confirmedThrough: Math.floor(input.now / 60) * 60,
      checkpoints: [],
      confirmedBar: null,
    };
  const bounds = monthBounds(input.now, input.sessionMode, market);
  const sourceSeconds = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1D": 86400 }[
    sourceResolution
  ];
  const eligible = canonicalLastWins(input.bars).filter(
    (bar) =>
      bar.time >= bounds.anchor &&
      bar.time + sourceSeconds <= input.now &&
      Number.isFinite(canonicalBarPrice(bar)) &&
      [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) &&
      Number.isFinite(bar.volume) &&
      bar.volume >= 0 &&
      (market === "AR" ||
        bounds.intervals.some((s) => bar.time >= s.open && bar.time + sourceSeconds <= s.close)),
  );
  let centered = createInitialWelfordState();
  const first = eligible[0];
  const origin = first === undefined ? 0 : canonicalBarPrice(first);
  let state = createInitialWelfordState();
  let PV = 0;
  let P2V = 0;
  let real = 0;
  let proxy = 0;
  const checkpoints: CanonicalCheckpoint[] = [];
  for (const bar of eligible) {
    const price = canonicalBarPrice(bar);
    centered = updateWelford(centered, price - origin, bar.volume).state;
    state = restoreOrigin(centered, origin);
    if (bar.volume > 0) {
      PV += price * bar.volume;
      P2V += price * price * bar.volume;
      if (typeof bar.vw === "number" && Number.isFinite(bar.vw) && bar.vw > 0) real += 1;
      else proxy += 1;
    }
    checkpoints.push({ endExclusive: bar.time + sourceSeconds, state, PV, P2V, real, proxy });
  }
  const observed = new Set(eligible.map((b) => b.time));
  let complete = market === "US" && sourceResolution === "1m" && input.now >= bounds.anchor;
  if (complete)
    for (const s of bounds.intervals)
      for (let t = s.open; t + 60 <= Math.min(s.close, input.now); t += 60)
        if (!observed.has(t)) complete = false;
  const invalidStats =
    state.cumWeight > 0 && ![state.cumWeight, state.mean, state.m2].every(Number.isFinite);
  const coverageQuality: CanonicalCoverageQuality = invalidStats
    ? "UNAVAILABLE"
    : sourceResolution !== "1m" && state.cumWeight > 0
      ? "APPROX_AGGREGATED"
      : complete
        ? "COMPLETE_CANONICAL_1M"
        : state.cumWeight > 0
          ? "PARTIAL_MISSING_PREFIX"
          : "UNAVAILABLE";
  return {
    symbol: input.symbol,
    adjSig: input.adjSig,
    monthKey: bounds.monthKey,
    anchorTimestamp: bounds.anchor,
    sessionMode: input.sessionMode,
    sourceResolution,
    coverageQuality,
    confirmedThrough:
      checkpoints.at(-1)?.endExclusive ?? Math.min(bounds.anchor, Math.floor(input.now / 60) * 60),
    checkpoints,
    confirmedBar: eligible.at(-1) ?? null,
  };
}

/** State before a calculation-buffer boundary, independent of chart zoom. */
export function canonicalMonthSeed(
  acc: CanonicalMonthAccumulator,
  seedEndExclusive: number,
): AvwapSeedContract {
  seedEndExclusive = Math.max(acc.anchorTimestamp, seedEndExclusive);
  let last: CanonicalCheckpoint | undefined;
  for (const point of acc.checkpoints) {
    if (point.endExclusive > seedEndExclusive) break;
    last = point;
  }
  const state = last?.state ?? createInitialWelfordState();
  return {
    anchorTimestamp: acc.anchorTimestamp,
    seedEndExclusive,
    sourceResolution: acc.sourceResolution,
    sessionMode: acc.sessionMode,
    seedPV: last?.PV ?? 0,
    seedV: state.cumWeight,
    seedP2V: last?.P2V ?? 0,
    seedCount: state.count,
    seedMean: state.cumWeight > 0 ? state.mean : Number.NaN,
    seedM2: state.m2,
    coverageQuality: acc.coverageQuality,
    priceSource: priceSource(last?.real ?? 0, last?.proxy ?? 0),
  };
}

export function canonicalPoint(
  state: WelfordState,
  time: number,
  cutoff: number,
  provisional = false,
): CanonicalMonthPoint {
  const out = getWelfordOutput(state);
  const p = out.vwap;
  const s = out.stdDev;
  return {
    time,
    cutoff,
    provisional,
    vwap: p,
    upper1: p + s,
    lower1: p - s,
    upper2: p + 2 * s,
    lower2: p - 2 * s,
  };
}

/** Linear merge of canonical checkpoints and requested bar closures, no look-ahead. */
export function projectCanonicalMonthAvwapToBars(
  acc: CanonicalMonthAccumulator,
  bars: readonly { readonly time: number; readonly endExclusive: number }[],
): readonly CanonicalMonthPoint[] {
  let cursor = 0;
  let state = createInitialWelfordState();
  return [...bars]
    .sort((a, b) => a.time - b.time)
    .map((bar) => {
      const cutoff = Math.min(bar.endExclusive, acc.confirmedThrough);
      while (cursor < acc.checkpoints.length) {
        const point = acc.checkpoints[cursor];
        if (point === undefined || point.endExclusive > cutoff) break;
        state = point.state;
        cursor += 1;
      }
      return canonicalPoint(
        cutoff > acc.anchorTimestamp && cutoff > bar.time ? state : createInitialWelfordState(),
        bar.time,
        cutoff,
        cutoff < bar.endExclusive,
      );
    });
}

/** Exact non-overlapping [anchor,seedEnd) + [seedEnd,...] continuation. */
export function computeSeededAnchoredVwap(
  seed: AvwapSeedContract,
  bars: readonly Bar[],
  confirmedThrough: number,
): readonly CanonicalMonthPoint[] {
  if (seed.sourceResolution !== "1m") throw new Error("Canonical continuation requires a 1m seed");
  const seeded = welfordFromSeed(seed);
  let centered = { ...seeded, mean: 0 };
  let origin = seeded.cumWeight > 0 ? seeded.mean : 0;
  const p = getMarketParts(seed.anchorTimestamp, "EQUITY");
  const nextMonth = new Date(Date.UTC(p.year, p.month, 1));
  const endMonth = etWallTimeToUtc(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth() + 1, 1, 0);
  let active: ReturnType<typeof usHistoricalSession> = null;
  return canonicalLastWins(bars)
    .filter((b) => {
      if (
        b.time < seed.seedEndExclusive ||
        b.time < seed.anchorTimestamp ||
        b.time >= endMonth ||
        b.time + 60 > confirmedThrough
      )
        return false;
      if (active === null || b.time < active.extendedOpen || b.time >= active.extendedClose)
        active = usHistoricalSession(b.time);
      if (active === null) return false;
      return (
        b.time >= (seed.sessionMode === "RTH" ? active.open : active.extendedOpen) &&
        b.time + 60 <= (seed.sessionMode === "RTH" ? active.close : active.extendedClose)
      );
    })
    .map((bar) => {
      const price = canonicalBarPrice(bar);
      if (centered.cumWeight === 0) origin = price;
      centered = updateWelford(centered, price - origin, bar.volume).state;
      return canonicalPoint(restoreOrigin(centered, origin), bar.time, bar.time + 60);
    });
}

export type CanonicalSeedDto = Omit<
  AvwapSeedContract,
  "seedMean" | "seedPV" | "seedV" | "seedP2V" | "seedM2"
> & {
  readonly seedMean: number | null;
  readonly seedPV: number | null;
  readonly seedV: number | null;
  readonly seedP2V: number | null;
  readonly seedM2: number | null;
};
export interface CanonicalMonthDto {
  readonly priceSource: CanonicalPriceSource;
  readonly seed: CanonicalSeedDto;
  readonly symbol: string;
  readonly adjSig: string;
  readonly confirmedThrough: number;
  readonly confirmedBar: Bar | null;
  readonly points: readonly (Omit<
    CanonicalMonthPoint,
    "vwap" | "upper1" | "lower1" | "upper2" | "lower2"
  > & {
    readonly vwap: number | null;
    readonly upper1: number | null;
    readonly lower1: number | null;
    readonly upper2: number | null;
    readonly lower2: number | null;
  })[];
  readonly confirmedSeed: CanonicalSeedDto;
}

export interface CanonicalMonthLiveState {
  readonly priceSource: CanonicalPriceSource;
  readonly symbol: string;
  readonly adjSig: string;
  readonly sessionMode: "RTH" | "EXTENDED";
  readonly monthKey: string;
  readonly anchorTimestamp: number;
  readonly confirmedThrough: number;
  readonly confirmed: WelfordState;
  readonly coverageQuality: CanonicalCoverageQuality;
  readonly centered: WelfordState;
  readonly origin: number;
  readonly provisional: Bar | null;
  readonly provisionalAsOf: number;
  readonly confirmedBar: Bar | null;
  readonly needsRefresh: boolean;
}

/** O(1) checkpoint hydration; no historical arrays enter the live reducer. */
export function createCanonicalMonthLiveState(dto: CanonicalMonthDto): CanonicalMonthLiveState {
  const seed = dto.confirmedSeed;
  const state = welfordFromSeed({
    ...seed,
    seedV: seed.seedV === null ? Number.NaN : seed.seedV,
    seedMean: seed.seedMean === null ? Number.NaN : seed.seedMean,
    seedM2: seed.seedM2 === null ? Number.NaN : seed.seedM2,
  });
  const p = getMarketParts(seed.anchorTimestamp, "EQUITY");
  return {
    symbol: dto.symbol,
    adjSig: dto.adjSig,
    sessionMode: seed.sessionMode,
    monthKey: `${String(p.year)}-${String(p.month)}`,
    anchorTimestamp: seed.anchorTimestamp,
    confirmedThrough: dto.confirmedThrough,
    confirmed: state,
    coverageQuality: seed.coverageQuality,
    provisional: null,
    confirmedBar: dto.confirmedBar,
    needsRefresh: false,
    provisionalAsOf: dto.confirmedThrough,
    origin: state.cumWeight > 0 ? state.mean : 0,
    centered: { ...state, mean: 0 },
    priceSource: dto.priceSource,
  };
}

/** Bounded exchange-calendar lookup, independent of historical bar count. */
function nextCanonicalMinute(time: number, mode: "RTH" | "EXTENDED"): number | null {
  for (let day = 0; day < 8; day += 1) {
    const session = usHistoricalSession(time + day * 86400);
    if (session === null) continue;
    const open = mode === "RTH" ? session.open : session.extendedOpen;
    const close = mode === "RTH" ? session.close : session.extendedClose;
    if (time < open) return open;
    if (time < close) return Math.max(time, open);
  }
  return null;
}

/** Authoritative minute snapshots replace, never add, provisional contribution.
 * Confirmation is explicit (lastClosedBar), not inferred from a quote rollover.
 * Old confirmed revisions fail closed until a fresh backend checkpoint arrives.
 */
export function updateCanonicalMonthLive(
  state: CanonicalMonthLiveState,
  bar: Bar,
  confirmed: boolean,
  asOf = bar.time,
): CanonicalMonthLiveState {
  if (
    !Number.isSafeInteger(bar.time) ||
    bar.time <= 0 ||
    bar.time % 60 !== 0 ||
    !Number.isFinite(asOf)
  )
    return state;
  if (state.needsRefresh) return state;
  const p = getMarketParts(bar.time, "EQUITY");
  const monthKey = `${String(p.year)}-${String(p.month)}`;
  let base = state;
  if (monthKey !== state.monthKey) {
    if (bar.time < state.anchorTimestamp) return state;
    const bounds = monthBounds(bar.time, state.sessionMode, "US");
    base = {
      ...state,
      monthKey,
      anchorTimestamp: bounds.anchor,
      confirmedThrough: bounds.anchor,
      confirmed: createInitialWelfordState(),
      centered: createInitialWelfordState(),
      origin: 0,
      provisional: null,
      confirmedBar: null,
      priceSource: "HLC3_PROXY",
      coverageQuality:
        bar.time === bounds.anchor ? "COMPLETE_CANONICAL_1M" : "PARTIAL_MISSING_PREFIX",
    };
  }
  const session = usHistoricalSession(bar.time);
  if (session === null) return base;
  const open = base.sessionMode === "RTH" ? session.open : session.extendedOpen;
  const close = base.sessionMode === "RTH" ? session.close : session.extendedClose;
  if (
    bar.time < open ||
    bar.time + 60 > close ||
    !Number.isFinite(canonicalBarPrice(bar)) ||
    !Number.isFinite(bar.volume) ||
    bar.volume < 0
  )
    return base;
  if (bar.time < base.confirmedThrough) {
    const old = base.confirmedBar;
    if (
      confirmed &&
      old !== null &&
      old.time === bar.time &&
      (old.open !== bar.open ||
        old.high !== bar.high ||
        old.low !== bar.low ||
        old.close !== bar.close ||
        old.volume !== bar.volume ||
        !Object.is(old.vw, bar.vw))
    ) {
      return {
        ...base,
        needsRefresh: true,
        coverageQuality: "PARTIAL_MISSING_PREFIX",
        provisional: null,
      };
    }
    return base;
  }
  // Overnight/holiday closures are not gaps; an unobserved eligible minute is.
  const expected = nextCanonicalMinute(base.confirmedThrough, base.sessionMode);
  const quality = expected !== bar.time ? "PARTIAL_MISSING_PREFIX" : base.coverageQuality;
  if (!confirmed)
    return {
      ...base,
      coverageQuality: quality,
      provisional: { ...bar },
      provisionalAsOf: Math.min(bar.time + 60, Math.max(bar.time, asOf)),
    };
  const origin = base.centered.cumWeight > 0 ? base.origin : canonicalBarPrice(bar);
  const centered = updateWelford(base.centered, canonicalBarPrice(bar) - origin, bar.volume).state;
  const source: CanonicalPriceSource =
    typeof bar.vw === "number" && Number.isFinite(bar.vw) && bar.vw > 0 ? "REAL_VW" : "HLC3_PROXY";
  const effectiveSource =
    bar.volume <= 0
      ? base.priceSource
      : base.confirmed.count === 0
        ? source
        : base.priceSource === source
          ? source
          : "MIXED_VW_HLC3";
  return {
    ...base,
    confirmed: restoreOrigin(centered, origin),
    centered,
    origin,
    priceSource: effectiveSource,
    confirmedBar: { ...bar },
    confirmedThrough: bar.time + 60,
    coverageQuality: quality,
    provisional:
      base.provisional !== null && base.provisional.time > bar.time ? base.provisional : null,
  };
}

/** Preview from the last confirmed state, never from a previous preview. */
export function projectCanonicalMonthLive(
  state: CanonicalMonthLiveState,
  time: number,
): CanonicalMonthPoint & { readonly priceSource: CanonicalPriceSource } {
  const bar = state.provisional;
  if (state.needsRefresh)
    return {
      ...canonicalPoint(createInitialWelfordState(), time, state.confirmedThrough),
      priceSource: state.priceSource,
    };
  const origin =
    bar !== null && state.centered.cumWeight === 0 ? canonicalBarPrice(bar) : state.origin;
  const source: CanonicalPriceSource =
    bar !== null && typeof bar.vw === "number" && Number.isFinite(bar.vw) && bar.vw > 0
      ? "REAL_VW"
      : "HLC3_PROXY";
  const effectiveSource =
    bar === null || bar.volume <= 0
      ? state.priceSource
      : state.confirmed.count === 0
        ? source
        : state.priceSource === source
          ? source
          : "MIXED_VW_HLC3";
  return {
    ...canonicalPoint(
      bar === null
        ? state.confirmed
        : restoreOrigin(
            updateWelford(state.centered, canonicalBarPrice(bar) - origin, bar.volume).state,
            origin,
          ),
      time,
      bar === null ? state.confirmedThrough : state.provisionalAsOf,
      bar !== null,
    ),
    priceSource: effectiveSource,
  };
}

/** Quotes carry no authoritative eligible-minute volume. Preserve the snapshot
 * volume/VW, update only a matching provisional minute's OHLC, and await an
 * authoritative bar_update for rollover/confirmation. */
export function quoteCanonicalMonthLive(
  state: CanonicalMonthLiveState,
  price: number,
  time: number,
): CanonicalMonthLiveState {
  const bar = state.provisional;
  if (
    bar === null ||
    !Number.isFinite(price) ||
    price <= 0 ||
    Math.floor(time / 60) * 60 !== bar.time
  )
    return state;
  return {
    ...state,
    provisional: {
      ...bar,
      high: Math.max(bar.high, price),
      low: Math.min(bar.low, price),
      close: price,
    },
    provisionalAsOf: Math.max(state.provisionalAsOf, Math.min(time, bar.time + 60)),
  };
}

/** Chart coordinates follow the same session-aligned buckets as 0B rollups. */
export function canonicalMonthLiveBucket(
  state: CanonicalMonthLiveState,
  seconds: number,
): number | null {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
  const time = state.provisional?.time ?? state.confirmedThrough - 1;
  const session = usHistoricalSession(time);
  if (session === null) return null;
  const open = state.sessionMode === "RTH" ? session.open : session.extendedOpen;
  return open + Math.floor((time - open) / seconds) * seconds;
}

/** Explicit NaN -> null at the transport boundary. */
export function serializeCanonicalMonth(
  acc: CanonicalMonthAccumulator,
  bars: readonly { readonly time: number; readonly endExclusive: number }[],
  calculationFrom: number,
): CanonicalMonthDto {
  const finite = (v: number): number | null => (Number.isFinite(v) ? v : null);
  const encode = (seed: AvwapSeedContract) => ({
    ...seed,
    seedMean: finite(seed.seedMean),
    seedPV: finite(seed.seedPV),
    seedV: finite(seed.seedV),
    seedP2V: finite(seed.seedP2V),
    seedM2: finite(seed.seedM2),
  });
  const bar = acc.confirmedBar;
  const confirmedBar =
    bar === null
      ? null
      : {
          time: bar.time,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
          ...(typeof bar.vw === "number" && Number.isFinite(bar.vw) ? { vw: bar.vw } : {}),
        };
  const finalSeed = canonicalMonthSeed(acc, acc.confirmedThrough);
  return {
    symbol: acc.symbol,
    adjSig: acc.adjSig,
    confirmedThrough: acc.confirmedThrough,
    confirmedBar,
    priceSource: finalSeed.priceSource,
    seed: encode(canonicalMonthSeed(acc, calculationFrom)),
    confirmedSeed: encode(canonicalMonthSeed(acc, acc.confirmedThrough)),
    points: projectCanonicalMonthAvwapToBars(acc, bars).map((p) => ({
      ...p,
      vwap: finite(p.vwap),
      upper1: finite(p.upper1),
      lower1: finite(p.lower1),
      upper2: finite(p.upper2),
      lower2: finite(p.lower2),
    })),
  };
}
