import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { describe, it, expect, afterAll } from "vitest";
import {
  computeSessionKeyLevels,
  projectSessionKeyLevels,
  serializeSessionKeyLevels,
  hydrateSessionKeyLevels,
  updateSessionKeyLevels,
  advanceSessionKeyLevels,
  quoteSessionKeyLevels,
  type SessionLevelsInput,
  type SessionObservation,
  type SessionLevel,
  type SessionSnapshot,
} from "../src/core/sessionKeyLevels.js";
import { MarketRuntime } from "../src/server/marketRuntime.js";
import { resolveFmpConfig } from "../src/server/fmpClient.js";
interface Case {
  name: string;
  dataset: string;
  market: "US" | "AR";
  evalTimeSec: number;
  arSessions: SessionLevelsInput["arSessions"];
  expected: Record<string, (Omit<SessionLevel, "value"> & { value: number | null })[]>;
}
const fixture = JSON.parse(readFileSync("fixtures/session_key_levels_reference.json", "utf8")) as {
  confirmedRevision: SessionSnapshot & { expectedHigh: number; expectedLow: number };
  datasets: Record<string, SessionObservation[]>;
  cases: Case[];
  live: (SessionSnapshot & {
    confirmed: boolean;
    expectedHigh: number;
    expectedLow: number;
    quote?: { price: number; time: number; expectedHigh: number; expectedLow: number };
  })[];
};
let maxError = 0;
let comparisons = 0;
let extraRequests = -1;
afterAll(() => {
  mkdirSync(".cache", { recursive: true });
  writeFileSync(
    ".cache/pieza3-session-metrics.json",
    JSON.stringify({ maxError, comparisons, extraRequests }, null, 2),
  );
});
describe("S1-6 independent zoneinfo/calendar/set-coverage oracle", () => {
  it.each(fixture.cases)("$name", (c) => {
    const observations = fixture.datasets[c.dataset] as SessionObservation[];
    const state = computeSessionKeyLevels({
      symbol: "SYN",
      market: c.market,
      evalTimeSec: c.evalTimeSec,
      observations,
      ...(c.arSessions === undefined ? {} : { arSessions: c.arSessions }),
    });
    for (const minutes of [5, 15, 30] as const) {
      const actual = projectSessionKeyLevels(state, minutes);
      const expected = c.expected[String(minutes)];
      for (let i = 0; i < actual.length; i += 1) {
        const a = actual[i] as SessionLevel,
          e = expected?.[i];
        if (e === undefined) throw new Error("Missing oracle level");
        expect({
          ...a,
          value: undefined,
          start: Number.isFinite(a.start) ? a.start : null,
          endExclusive: Number.isFinite(a.endExclusive) ? a.endExclusive : null,
        }).toEqual({ ...e, value: undefined });
        if (e.value === null) expect(Number.isNaN(a.value)).toBe(true);
        else {
          const error = Math.abs(a.value - e.value);
          maxError = Math.max(maxError, error);
          comparisons += 1;
          expect(error).toBeLessThanOrEqual(1e-9);
        }
      }
    }
  });
  it("is invariant to extreme future rows and unavailable final OHLC of a currently open aggregate", () => {
    for (const c of fixture.cases) {
      const observations = fixture.datasets[c.dataset] as SessionObservation[];
      const future = {
        bar: {
          time: c.evalTimeSec + 3600,
          open: 1e8,
          high: 1e9,
          low: 0.001,
          close: 1e8,
          volume: 1,
        },
        endExclusive: c.evalTimeSec + 3660,
      };
      const open = {
        bar: { ...future.bar, time: c.evalTimeSec - 60 },
        endExclusive: c.evalTimeSec + 60,
      };
      const options = {
        symbol: "SYN",
        market: c.market,
        evalTimeSec: c.evalTimeSec,
        ...(c.arSessions === undefined ? {} : { arSessions: c.arSessions }),
      };
      expect(
        projectSessionKeyLevels(
          computeSessionKeyLevels({ ...options, observations: [...observations, future, open] }),
        ),
      ).toEqual(projectSessionKeyLevels(computeSessionKeyLevels({ ...options, observations })));
    }
  });
  it("replaces live snapshots, contracts obsolete provisional extremes and confirms exactly once", () => {
    const rows = fixture.datasets["live"] as SessionObservation[];
    const last = rows.at(-1) as SessionObservation;
    let state = computeSessionKeyLevels({
      symbol: "SYN",
      market: "US",
      evalTimeSec: last.endExclusive,
      observations: rows,
    });
    for (const event of fixture.live) {
      state = updateSessionKeyLevels(state, event, event.confirmed);
      const levels = projectSessionKeyLevels(state);
      expect(levels.find((l) => l.id === "ORH")?.value).toBeCloseTo(event.expectedHigh, 10);
      expect(levels.find((l) => l.id === "ORL")?.value).toBeCloseTo(event.expectedLow, 10);
      if (event.quote !== undefined) {
        state = quoteSessionKeyLevels(state, event.quote.price, event.quote.time);
        expect(projectSessionKeyLevels(state).find((l) => l.id === "ORH")?.value).toBe(
          event.quote.expectedHigh,
        );
        expect(projectSessionKeyLevels(state).find((l) => l.id === "ORL")?.value).toBe(
          event.quote.expectedLow,
        );
        expect(state.provisional?.bar.volume).toBe(event.bar.volume);
      }
    }
    const stale = { ...fixture.live[1], observedAt: 0 };
    expect(quoteSessionKeyLevels(state, 1, state.evalTimeSec - 60)).toEqual(state);
    expect(updateSessionKeyLevels(state, stale as SessionSnapshot, false)).toEqual(state);
    const confirmed = fixture.live.at(-1) as (typeof fixture.live)[number];
    expect(updateSessionKeyLevels(state, confirmed, true)).toEqual(state);
    state = updateSessionKeyLevels(state, fixture.confirmedRevision, true);
    expect(projectSessionKeyLevels(state).find((l) => l.id === "ORH")?.value).toBe(
      fixture.confirmedRevision.expectedHigh,
    );
    expect(projectSessionKeyLevels(state).find((l) => l.id === "ORL")?.value).toBe(
      fixture.confirmedRevision.expectedLow,
    );
    expect(JSON.stringify(serializeSessionKeyLevels(state))).not.toMatch(/NaN|Infinity/);
    const next = advanceSessionKeyLevels(state, state.evalTimeSec + 86400);
    expect(next.needsRefresh).toBe(false);
    expect(projectSessionKeyLevels(next).every((l) => Number.isNaN(l.value))).toBe(true);
  });
  it("does not fabricate BYMA calendar evidence and serializes unavailable statistics as null", () => {
    const state = computeSessionKeyLevels({
      symbol: "AR",
      market: "AR",
      evalTimeSec: 1741615200,
      observations: fixture.datasets["AR"] as SessionObservation[],
    });
    expect(projectSessionKeyLevels(state).every((l) => l.status === "UNAVAILABLE")).toBe(true);
    const dto = serializeSessionKeyLevels(state);
    expect(hydrateSessionKeyLevels(dto)).toEqual(state);
    expect(JSON.stringify(dto)).not.toMatch(/NaN|Infinity/);
  });
  it("backend uses only the ordinary historical requests; changing OR and viewport adds zero requests", async () => {
    const c = fixture.cases.find((c) => c.name === "after_DST_10:00:00") as Case;
    const observations = fixture.datasets[c.dataset] as SessionObservation[];
    const calls: string[] = [];
    const runtime = new MarketRuntime({
      apiKey: "",
      massiveEnv: { MASSIVE_KEY_2: "SYNTH_S16" },
      fmpConfig: resolveFmpConfig({}),
      enableWs: false,
      nowMsFn: () => c.evalTimeSec * 1000,
      fetchFn: (url) => {
        calls.push(url);
        const p = new URL(url).pathname.split("/");
        const from = Number(p[8]) / 1000,
          to = (Number(p[9]) + 1) / 1000;
        const rows = url.includes("/range/1/minute/")
          ? observations.filter((r) => r.bar.time >= from && r.endExclusive <= to)
          : [];
        return Promise.resolve({
          ok: true,
          status: 200,
          text: JSON.stringify({
            status: "OK",
            queryCount: rows.length,
            results: rows.map(({ bar: b }) => ({
              t: b.time * 1000,
              o: b.open,
              h: b.high,
              l: b.low,
              c: b.close,
              v: b.volume,
            })),
          }),
        });
      },
    });
    try {
      const response = await runtime.getBars("SYN", "1m", { includeOverlays: false });
      const dto = response.sessionKeyLevels;
      expect(dto).toBeDefined();
      if (dto === undefined) throw new Error("Missing session DTO");
      const before = calls.length;
      const state = hydrateSessionKeyLevels(dto);
      for (const width of [5, 15, 30] as const) {
        const view = { ...response, bars: response.bars.slice(-3) };
        expect(view.sessionKeyLevels).toBe(dto);
        projectSessionKeyLevels(state, width);
      }
      await runtime.getBars("SYN", "1m", { includeOverlays: false });
      extraRequests = calls.length - before;
      expect(extraRequests).toBe(0);
      expect(JSON.stringify(dto)).not.toMatch(/NaN|Infinity/);
    } finally {
      runtime.stopWs();
    }
  });
  it("does not certify missing canonical minutes through a 5m rollup covering that hole", async () => {
    const c = fixture.cases.find((c) => c.name === "missing_OR") as Case;
    const observations = fixture.datasets[c.dataset] as SessionObservation[];
    const runtime = new MarketRuntime({
      apiKey: "",
      massiveEnv: { MASSIVE_KEY_2: "SYNTH_S16_GAP" },
      fmpConfig: resolveFmpConfig({}),
      enableWs: false,
      nowMsFn: () => c.evalTimeSec * 1000,
      fetchFn: (url) => {
        const p = new URL(url).pathname.split("/");
        const from = Number(p[8]) / 1000,
          to = (Number(p[9]) + 1) / 1000;
        const rows = url.includes("/range/1/minute/")
          ? observations.filter((r) => r.bar.time >= from && r.endExclusive <= to)
          : [];
        return Promise.resolve({
          ok: true,
          status: 200,
          text: JSON.stringify({
            status: "OK",
            queryCount: rows.length,
            results: rows.map(({ bar: b }) => ({
              t: b.time * 1000,
              o: b.open,
              h: b.high,
              l: b.low,
              c: b.close,
              v: b.volume,
            })),
          }),
        });
      },
    });
    try {
      const response = await runtime.getBars("SYN", "5m", { includeOverlays: false });
      if (response.sessionKeyLevels === undefined) throw new Error("Missing session DTO");
      expect(
        projectSessionKeyLevels(hydrateSessionKeyLevels(response.sessionKeyLevels), 5).find(
          (l) => l.id === "ORH",
        )?.status,
      ).toBe("UNAVAILABLE");
    } finally {
      runtime.stopWs();
    }
  });
  it("does not mutate frozen source bars or confirmed state", () => {
    const rows = Object.freeze(
      (fixture.datasets["live"] as SessionObservation[]).map((row) =>
        Object.freeze({ ...row, bar: Object.freeze({ ...row.bar }) }),
      ),
    );
    const state = computeSessionKeyLevels({
      symbol: "S",
      market: "US",
      evalTimeSec: (rows.at(-1) as SessionObservation).endExclusive,
      observations: rows,
    });
    const immutable = Object.freeze({
      ...state,
      windows: Object.freeze(state.windows.map((w) => Object.freeze({ ...w }))),
    });
    const before = serializeSessionKeyLevels(immutable);
    for (const snapshot of fixture.live)
      updateSessionKeyLevels(immutable, snapshot, snapshot.confirmed);
    expect(serializeSessionKeyLevels(immutable)).toEqual(before);
  });
  it("rolls US sessions locally and preserves only the calendar-correct previous RTH across weekends and DST", () => {
    const cases = [
      ["before_DST_16:00:00", "after_DST_03:59:59"],
      ["early_close_previous_03:59:59", "early_close_previous_03:59:59"],
    ] as const;
    for (const [startName, endName] of cases) {
      const end = fixture.cases.find((c) => c.name === endName) as Case;
      const observations = fixture.datasets[end.dataset] as SessionObservation[];
      const previousRows = observations.filter((r) => r.endExclusive < end.evalTimeSec);
      const closing = previousRows.at(-1)?.endExclusive;
      if (closing === undefined) throw new Error("Missing closing session");
      const start =
        startName === "before_DST_16:00:00"
          ? fixture.cases.find((c) => c.name === startName)?.evalTimeSec
          : closing;
      if (start === undefined) throw new Error("Missing start");
      let state = computeSessionKeyLevels({
        symbol: "S",
        market: "US",
        evalTimeSec: start,
        observations,
      });
      for (let time = start + 86400; time < end.evalTimeSec; time += 86400)
        state = advanceSessionKeyLevels(state, time);
      state = advanceSessionKeyLevels(state, end.evalTimeSec);
      expect(
        projectSessionKeyLevels(state).map((l) => (Number.isFinite(l.value) ? l.value : null)),
      ).toEqual(end.expected["15"]?.map((l) => l.value));
    }
    const c = fixture.cases.find((c) => c.name === "next_session") as Case;
    const rows = fixture.datasets[c.dataset] as SessionObservation[];
    const next = rows.find(
      (r) => r.bar.time > c.evalTimeSec - 300 - 86400 && r.bar.time >= c.evalTimeSec - 300,
    ) as SessionObservation;
    const prior = rows.filter((r) => r.endExclusive <= next.bar.time - 3600);
    let state = computeSessionKeyLevels({
      symbol: "S",
      market: "US",
      evalTimeSec: (prior.at(-1) as SessionObservation).endExclusive,
      observations: prior,
    });
    for (const row of rows.filter((r) => r.bar.time >= next.bar.time))
      state = updateSessionKeyLevels(state, { ...row, observedAt: row.endExclusive }, true);
    expect(
      projectSessionKeyLevels(state, 5).map((l) => (Number.isFinite(l.value) ? l.value : null)),
    ).toEqual(c.expected["5"]?.map((l) => l.value));
    expect(projectSessionKeyLevels(state, 5).find((l) => l.id === "ORH")?.status).toBe(
      "DEFINITIVE",
    );
  });
});
