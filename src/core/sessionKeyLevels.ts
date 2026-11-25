import type { Bar } from "./types.js";
import { getMarketParts, MAX_TIME_SECONDS } from "./sessions.js";
import { usHistoricalSession, type UsSession } from "./usHistorical.js";
import { getSessionDateKey } from "./ggal/technicalIndicators.js";

export type SessionLevelStatus = "UNAVAILABLE" | "PROVISIONAL" | "DEFINITIVE";
export type OpeningRangeMinutes = 5 | 15 | 30;
export type SessionLevelId = "PDH" | "PDL" | "PMH" | "PML" | "ORH" | "ORL";
export interface SessionLevel {
  readonly id: SessionLevelId;
  readonly value: number;
  readonly status: SessionLevelStatus;
  readonly sessionDate: string;
  readonly start: number;
  readonly endExclusive: number;
}
export interface SessionWindow {
  readonly key: "pd" | "pm" | "or5" | "or15" | "or30" | "rth";
  readonly sessionDate: string;
  readonly start: number;
  readonly endExclusive: number;
  readonly high: number;
  readonly low: number;
  readonly coveredThrough: number;
  readonly contiguous: boolean;
  readonly observations: number;
}
export interface SessionObservation {
  readonly bar: Bar;
  readonly endExclusive: number;
}
export interface SessionSnapshot extends SessionObservation {
  readonly observedAt: number;
}
export interface SessionLevelsState {
  readonly liveRevision?: {
    readonly last: SessionSnapshot;
    readonly before: readonly SessionWindow[];
  };
  readonly symbol: string;
  readonly market: "US" | "AR";
  readonly sessionDate: string;
  readonly evalTimeSec: number;
  readonly confirmedThrough: number;
  readonly windows: readonly SessionWindow[];
  readonly provisional: SessionSnapshot | null;
  readonly needsRefresh: boolean;
}
export interface SessionLevelsInput {
  readonly symbol: string;
  readonly market: "US" | "AR";
  readonly evalTimeSec: number;
  readonly observations: readonly SessionObservation[];
  /** Exchange-evidenced AR sessions only; no guessed weekday/holiday calendar. */
  readonly arSessions?: readonly UsSession[];
}
function dateKey(time: number, market: "US" | "AR"): string {
  return market === "US"
    ? getMarketParts(time, "EQUITY").dateKey
    : getSessionDateKey(time, "America/Argentina/Buenos_Aires");
}
function sessionAt(
  time: number,
  input: Pick<SessionLevelsInput, "market" | "arSessions">,
): UsSession | null {
  if (input.market === "AR")
    return input.arSessions?.find((s) => s.dateKey === dateKey(time, "AR")) ?? null;
  const year = getMarketParts(time, "EQUITY").year;
  return year >= 2020 && year <= 2028 ? usHistoricalSession(time) : null;
}
function previousSession(
  time: number,
  input: Pick<SessionLevelsInput, "market" | "arSessions">,
): UsSession | null {
  for (let day = 1; day <= 15; day += 1) {
    const s = sessionAt(time - day * 86400, input);
    if (s !== null) return s;
  }
  return null;
}
function addObservation(w: SessionWindow, row: SessionObservation): SessionWindow {
  const b = row.bar;
  if (
    b.time < w.start ||
    row.endExclusive > w.endExclusive ||
    row.endExclusive <= b.time ||
    ![b.high, b.low, b.open, b.close, b.volume].every(Number.isFinite) ||
    b.volume < 0 ||
    b.low > b.high
  )
    return w;
  return {
    ...w,
    high: w.observations === 0 ? b.high : Math.max(w.high, b.high),
    low: w.observations === 0 ? b.low : Math.min(w.low, b.low),
    observations: w.observations + 1,
    contiguous: w.contiguous && b.time <= w.coveredThrough,
    coveredThrough: Math.max(w.coveredThrough, row.endExclusive),
  };
}
/** One historical pass over existing source intervals. No visual clipping and no final OHLC from open bars. */
export function computeSessionKeyLevels(input: SessionLevelsInput): SessionLevelsState {
  const s = sessionAt(input.evalTimeSec, input);
  const prev = s === null ? null : previousSession(s.open, input);
  const windows: SessionWindow[] = [];
  const add = (
    key: SessionWindow["key"],
    ref: UsSession,
    start: number,
    endExclusive: number,
  ): void => {
    windows.push({
      key,
      sessionDate: ref.dateKey,
      start,
      endExclusive,
      high: Number.NaN,
      low: Number.NaN,
      coveredThrough: start,
      contiguous: true,
      observations: 0,
    });
  };
  if (s !== null) {
    if (prev !== null) add("pd", prev, prev.open, prev.close);
    if (input.market === "US") add("pm", s, s.extendedOpen, s.open);
    for (const minutes of [5, 15, 30] as const)
      add(
        ({ 5: "or5", 15: "or15", 30: "or30" } as const)[minutes],
        s,
        s.open,
        Math.min(s.close, s.open + minutes * 60),
      );
  }
  const tracker = s ?? previousSession(input.evalTimeSec, input);
  if (tracker !== null) add("rth", tracker, tracker.open, tracker.close);
  const unique = new Map<string, SessionObservation>();
  for (const row of input.observations)
    if (
      Number.isSafeInteger(row.bar.time) &&
      row.bar.time > 0 &&
      Number.isSafeInteger(row.endExclusive) &&
      row.endExclusive <= input.evalTimeSec
    )
      unique.set(`${String(row.bar.time)}:${String(row.endExclusive)}`, row);
  let result: readonly SessionWindow[] = windows;
  let confirmedThrough = 0;
  for (const row of [...unique.values()].sort(
    (a, b) => a.bar.time - b.bar.time || a.endExclusive - b.endExclusive,
  )) {
    result = result.map((w) => addObservation(w, row));
    confirmedThrough = Math.max(confirmedThrough, row.endExclusive);
  }
  return {
    symbol: input.symbol,
    market: input.market,
    sessionDate: dateKey(input.evalTimeSec, input.market),
    evalTimeSec: input.evalTimeSec,
    confirmedThrough,
    windows: result,
    provisional: null,
    needsRefresh: false,
  };
}
/** Fixed six-window reducer. Provisional snapshots replace, including downward revisions of highs. */
export function updateSessionKeyLevels(
  initial: SessionLevelsState,
  snapshot: SessionSnapshot,
  confirmed: boolean,
): SessionLevelsState {
  const { bar, endExclusive, observedAt } = snapshot;
  if (
    !Number.isSafeInteger(bar.time) ||
    bar.time <= 0 ||
    bar.time > MAX_TIME_SECONDS ||
    bar.time % 60 !== 0 ||
    !Number.isSafeInteger(observedAt) ||
    ![bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) ||
    bar.volume < 0 ||
    bar.low > bar.high ||
    endExclusive !== bar.time + 60 ||
    observedAt < bar.time ||
    (!confirmed && observedAt > endExclusive) ||
    (confirmed && endExclusive > observedAt)
  )
    return initial;
  const state = advanceSessionKeyLevels(initial, observedAt);
  if (
    dateKey(bar.time, state.market) !== state.sessionDate &&
    !(
      confirmed &&
      state.windows.some(
        (w) => w.key === "pd" && bar.time >= w.start && endExclusive <= w.endExclusive,
      )
    )
  )
    return state;
  if (state.needsRefresh) return state;
  if (bar.time < state.confirmedThrough) {
    const revision = state.liveRevision;
    if (
      confirmed &&
      revision !== undefined &&
      revision.last.bar.time === bar.time &&
      (["open", "high", "low", "close", "volume"] as const).some(
        (key) => revision.last.bar[key] !== bar[key],
      )
    ) {
      return {
        ...state,
        evalTimeSec: Math.max(state.evalTimeSec, observedAt),
        windows: revision.before.map((w) => addObservation(w, snapshot)),
        liveRevision: { before: revision.before, last: { ...snapshot, bar: { ...bar } } },
      };
    }
    return state;
  }
  if (
    !confirmed &&
    state.provisional !== null &&
    (bar.time < state.provisional.bar.time ||
      (bar.time === state.provisional.bar.time && observedAt < state.provisional.observedAt))
  )
    return state;
  if (!confirmed)
    return {
      ...state,
      evalTimeSec: Math.max(state.evalTimeSec, observedAt),
      provisional: { ...snapshot, bar: { ...bar } },
    };
  return {
    ...state,
    evalTimeSec: Math.max(state.evalTimeSec, observedAt),
    confirmedThrough: endExclusive,
    liveRevision: { before: state.windows, last: { ...snapshot, bar: { ...bar } } },
    windows: state.windows.map((w) => addObservation(w, snapshot)),
    provisional:
      state.provisional !== null && state.provisional.bar.time > bar.time
        ? state.provisional
        : null,
  };
}
/** Clock advancement rolls verified sessions using only the prior RTH checkpoint, without fabricating OHLC or volume. */
export function advanceSessionKeyLevels(
  state: SessionLevelsState,
  evalTimeSec: number,
): SessionLevelsState {
  if (!Number.isSafeInteger(evalTimeSec) || evalTimeSec < state.evalTimeSec) return state;
  if (dateKey(evalTimeSec, state.market) === state.sessionDate) return { ...state, evalTimeSec };
  const fresh = computeSessionKeyLevels({
    symbol: state.symbol,
    market: state.market,
    evalTimeSec,
    observations: [],
  });
  const prior = state.windows.find((w) => w.key === "rth");
  const windows = fresh.windows.map((w) =>
    prior !== undefined &&
    (w.key === "pd" || w.key === "rth") &&
    w.sessionDate === prior.sessionDate
      ? { ...prior, key: w.key }
      : w,
  );
  return {
    ...fresh,
    confirmedThrough: state.confirmedThrough,
    windows,
    needsRefresh: state.market === "AR" || windows.length === 0,
  };
}
/** Quotes can refine an existing causal minute; they never fabricate a minute or its volume. */
export function quoteSessionKeyLevels(
  state: SessionLevelsState,
  price: number,
  time: number,
): SessionLevelsState {
  const next = advanceSessionKeyLevels(state, time);
  const snapshot = next.provisional;
  if (
    snapshot === null ||
    !Number.isFinite(price) ||
    price <= 0 ||
    Math.floor(time / 60) * 60 !== snapshot.bar.time ||
    time < snapshot.observedAt
  )
    return next;
  return {
    ...next,
    provisional: {
      ...snapshot,
      observedAt: time,
      bar: {
        ...snapshot.bar,
        high: Math.max(snapshot.bar.high, price),
        low: Math.min(snapshot.bar.low, price),
        close: price,
      },
    },
  };
}
export function projectSessionKeyLevels(
  state: SessionLevelsState,
  openingRange: OpeningRangeMinutes = 15,
): readonly SessionLevel[] {
  const pairs = [
    ["pd", "PDH", "PDL"],
    ["pm", "PMH", "PML"],
    [`or${String(openingRange)}`, "ORH", "ORL"],
  ] as const;
  return pairs.flatMap(([key, highId, lowId]) => {
    const confirmed = state.windows.find((w) => w.key === key);
    const w =
      confirmed === undefined
        ? undefined
        : state.provisional === null
          ? confirmed
          : addObservation(confirmed, state.provisional);
    const closed = w !== undefined && state.evalTimeSec >= w.endExclusive;
    const complete =
      confirmed !== undefined &&
      confirmed.observations > 0 &&
      confirmed.contiguous &&
      confirmed.coveredThrough >= confirmed.endExclusive;
    const status: SessionLevelStatus =
      state.needsRefresh ||
      w === undefined ||
      w.observations === 0 ||
      state.evalTimeSec < w.start ||
      (closed && !complete)
        ? "UNAVAILABLE"
        : closed
          ? "DEFINITIVE"
          : "PROVISIONAL";
    return ([highId, lowId] as const).map((id, i) => ({
      id,
      status,
      value:
        status === "UNAVAILABLE"
          ? Number.NaN
          : i === 0
            ? (w?.high ?? Number.NaN)
            : (w?.low ?? Number.NaN),
      sessionDate: w?.sessionDate ?? state.sessionDate,
      start: w?.start ?? Number.NaN,
      endExclusive: w?.endExclusive ?? Number.NaN,
    }));
  });
}
export type SessionLevelsDto = Omit<SessionLevelsState, "windows" | "liveRevision"> & {
  readonly windows: readonly (Omit<SessionWindow, "high" | "low"> & {
    readonly high: number | null;
    readonly low: number | null;
  })[];
};
export function serializeSessionKeyLevels(state: SessionLevelsState): SessionLevelsDto {
  return {
    symbol: state.symbol,
    market: state.market,
    sessionDate: state.sessionDate,
    evalTimeSec: state.evalTimeSec,
    confirmedThrough: state.confirmedThrough,
    needsRefresh: state.needsRefresh,
    provisional:
      state.provisional === null
        ? null
        : {
            ...state.provisional,
            bar: {
              time: state.provisional.bar.time,
              open: state.provisional.bar.open,
              high: state.provisional.bar.high,
              low: state.provisional.bar.low,
              close: state.provisional.bar.close,
              volume: state.provisional.bar.volume,
              ...(typeof state.provisional.bar.vw === "number" &&
              Number.isFinite(state.provisional.bar.vw)
                ? { vw: state.provisional.bar.vw }
                : {}),
            },
          },
    windows: state.windows.map((w) => ({
      ...w,
      high: Number.isFinite(w.high) ? w.high : null,
      low: Number.isFinite(w.low) ? w.low : null,
    })),
  };
}
export function hydrateSessionKeyLevels(dto: SessionLevelsDto): SessionLevelsState {
  return {
    ...dto,
    windows: dto.windows.map((w) => ({
      ...w,
      high: w.high === null ? Number.NaN : w.high,
      low: w.low === null ? Number.NaN : w.low,
    })),
  };
}

export type AutoAvwapProximityMode = "PCT_1_5" | "ATR_1_5" | "SHOW_ALL";
export interface InstitutionalLevel {
  readonly role: "SUPPORT" | "RESISTANCE" | "EVENT";
  readonly anchorTimeSec: number;
  readonly currentAvwap: number;
}
export interface ProximityMemory {
  readonly key: string;
  readonly visible: boolean;
}
/** Exact decimal comparison of public numeric prices at inclusive financial thresholds (no epsilon band). */
function decimal(value: number): readonly [bigint, bigint] {
  const [mantissa, exponent = "0"] = String(value).toLowerCase().split("e");
  if (mantissa === undefined) throw new Error("Invalid decimal");
  const places = mantissa.includes(".") ? mantissa.length - mantissa.indexOf(".") - 1 : 0;
  const scale = places - Number(exponent);
  const coefficient = BigInt(mantissa.replace(".", ""));
  return scale >= 0
    ? [coefficient, 10n ** BigInt(scale)]
    : [coefficient * 10n ** BigInt(-scale), 1n];
}
function within(
  a: number,
  b: number,
  denominator: number,
  numerator: number,
  divisor: number,
): boolean {
  const [an, ad] = decimal(a),
    [bn, bd] = decimal(b),
    [dn, dd] = decimal(denominator);
  const delta = an * bd - bn * ad;
  return (delta < 0n ? -delta : delta) * dd * BigInt(divisor) <= dn * ad * bd * BigInt(numerator);
}
export function filterAutoAvwapByProximity<T extends InstitutionalLevel>(input: {
  readonly levels: readonly T[];
  readonly symbol: string;
  readonly context: string;
  readonly mode: AutoAvwapProximityMode;
  readonly referencePrice: number;
  readonly atr14D: number | null | undefined;
  readonly evalTimeSec: number;
  readonly previous: readonly ProximityMemory[];
}): {
  readonly levels: readonly (T & {
    readonly visible: boolean;
    readonly representationKey: string;
  })[];
  readonly memory: readonly ProximityMemory[];
  readonly badge: "ATR n/d" | null;
} {
  const validAtr =
    typeof input.atr14D === "number" && Number.isFinite(input.atr14D) && input.atr14D > 0;
  const badge = input.mode === "ATR_1_5" && !validAtr ? "ATR n/d" : null;
  const seen = new Set<string>();
  const levels = input.levels
    .filter((l) => {
      if (seen.has(l.role)) return false;
      seen.add(l.role);
      return true;
    })
    .map((l) => {
      const key = `${input.symbol}|${input.context}|${input.mode}|${l.role}|${String(l.anchorTimeSec)}`;
      const previous = input.previous.find((p) => p.key === key)?.visible === true;
      let visible =
        Number.isFinite(l.currentAvwap) &&
        l.currentAvwap > 0 &&
        Number.isFinite(l.anchorTimeSec) &&
        l.anchorTimeSec <= input.evalTimeSec;
      if (visible && input.mode !== "SHOW_ALL") {
        visible =
          Number.isFinite(input.referencePrice) && input.referencePrice > 0 && badge === null;
        if (visible)
          visible =
            input.mode === "PCT_1_5"
              ? within(
                  l.currentAvwap,
                  input.referencePrice,
                  input.referencePrice,
                  previous ? 165 : 150,
                  10000,
                )
              : within(
                  l.currentAvwap,
                  input.referencePrice,
                  input.atr14D as number,
                  previous ? 33 : 30,
                  20,
                );
      }
      return { ...l, visible, representationKey: key };
    });
  return {
    levels,
    memory: levels.map((l) => ({ key: l.representationKey, visible: l.visible })),
    badge,
  };
}
export function institutionalRepresentation(input: {
  readonly timeframe: string;
  readonly firstBarTime: number | undefined;
  readonly evalTimeSec: number;
  readonly anchorTimeSec: number;
  readonly currentAvwap: number;
  readonly visible: boolean;
  readonly legacyInRange: boolean;
}): "HIDDEN" | "TRAJECTORY" | "PROJECTION" {
  if (
    input.timeframe !== "1m" &&
    input.timeframe !== "5m" &&
    input.timeframe !== "15m" &&
    input.timeframe !== "1h"
  )
    return input.legacyInRange ? "TRAJECTORY" : "HIDDEN";
  if (
    input.firstBarTime === undefined ||
    !Number.isFinite(input.anchorTimeSec) ||
    !Number.isFinite(input.evalTimeSec) ||
    !input.visible ||
    !Number.isFinite(input.currentAvwap) ||
    input.currentAvwap <= 0 ||
    input.anchorTimeSec > input.evalTimeSec
  )
    return "HIDDEN";
  return input.anchorTimeSec < input.firstBarTime ? "PROJECTION" : "TRAJECTORY";
}
