import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { performance } from "node:perf_hooks";
import ts from "typescript";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Bar } from "../src/core/types.js";
import {
  buildCanonicalMonthAccumulator,
  canonicalBarPrice,
  canonicalLastWins,
  canonicalMonthSeed,
  projectCanonicalMonthAvwapToBars,
  computeSeededAnchoredVwap,
  serializeCanonicalMonth,
  createCanonicalMonthLiveState,
  updateCanonicalMonthLive,
  projectCanonicalMonthLive,
  quoteCanonicalMonthLive,
  canonicalMonthLiveBucket,
  type CanonicalMonthPoint,
} from "../src/core/avwapCanonicalMonth.js";
import {
  combineWelfordStates,
  welfordFromSeed,
  createInitialWelfordState,
  updateWelford,
} from "../src/core/welford.js";
import { canonicalMonthOverlayPure } from "../web/src/components/stock-detail/stockDetailMath.js";
import { projectLiveCandle } from "../src/core/realtimePropagation.js";
import { MarketRuntime } from "../src/server/marketRuntime.js";
import { resolveFmpConfig } from "../src/server/fmpClient.js";
import { ArgentinaMarketRuntime } from "../src/server/argentinaMarketLoader.js";
import { UsHistoricalService } from "../src/server/usHistoricalService.js";
import { MassiveKeyRouter } from "../src/server/massiveKeyPool.js";

type Expected = [
  number,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number,
  number,
  number,
];
interface Mode {
  mode: "RTH" | "EXTENDED";
  anchor: number;
  coverage: string;
  source: string;
  expected: Expected[];
  targets: Record<string, [number, number, number][]>;
  final: { count: number; V: number; PV: number; P2V: number; mean: number | null; m2: number };
}
interface Scenario {
  name: string;
  now: number;
  bars: Bar[];
  modes: Mode[];
}
const fixture = JSON.parse(readFileSync("fixtures/avwap_canonical_multitemporal.json", "utf8")) as {
  scenarios: Scenario[];
  live: {
    seedBars: Bar[];
    events: { forming: Bar; closed: Bar | null; expected: number[]; V: number }[];
  };
};
const curves = ["vwap", "upper1", "lower1", "upper2", "lower2"] as const;
for (const scenario of fixture.scenarios) {
  scenario.bars.forEach(Object.freeze);
  Object.freeze(scenario.bars);
}
const maxima = {
  pythonAbs: [0, 0, 0, 0, 0],
  multiAbs: [0, 0, 0, 0, 0],
  multiRel: [0, 0, 0, 0, 0],
  compared: 0,
};
const integration: Record<string, unknown> = {};
afterAll(() => {
  mkdirSync(".cache", { recursive: true });
  writeFileSync(
    ".cache/pieza2-canonical-metrics.json",
    JSON.stringify({ curves, maxima, integration }, null, 2),
  );
});

describe("S1-4 — Decimal oracle, stable states and every equivalent close", () => {
  it.each(fixture.scenarios)(
    "$name: all 1m/5m/15m/1H central/band closes match independently",
    (c) => {
      for (const mode of c.modes) {
        const acc = buildCanonicalMonthAccumulator({
          bars: c.bars,
          now: c.now,
          sessionMode: mode.mode,
          symbol: "SYN",
          adjSig: "SPLIT_A",
        });
        expect(acc.anchorTimestamp).toBe(mode.anchor);
        expect(acc.coverageQuality).toBe(mode.coverage);
        const seed = canonicalMonthSeed(acc, acc.confirmedThrough);
        expect(seed.seedV).toBe(mode.final.V);
        expect(seed.seedCount).toBe(mode.final.count);
        expect(seed.priceSource).toBe(mode.source);
        const byTime = new Map<number, CanonicalMonthPoint>();
        for (const minutes of [1, 5, 15, 60]) {
          const targets = mode.targets[String(minutes)] ?? [];
          const points = projectCanonicalMonthAvwapToBars(
            acc,
            targets.map(([time, endExclusive]) => ({ time, endExclusive })),
          );
          expect(points).toHaveLength(targets.length);
          points.forEach((point, i) => {
            const target = targets[i];
            if (target === undefined) throw new Error("Target missing");
            const expected = mode.expected[target[2]];
            if (expected === undefined) throw new Error("Independent close missing");
            curves.forEach((key, k) => {
              const actual = point[key];
              const value = expected[k + 1];
              if (value === null) {
                if (!Number.isNaN(actual)) throw new Error("Expected undefined zero-volume AVWAP");
                return;
              }
              if (value === undefined) throw new Error("Expected number missing");
              maxima.pythonAbs[k] = Math.max(maxima.pythonAbs[k] ?? 0, Math.abs(actual - value));
              if (Math.abs(actual - value) > 1e-9)
                throw new Error(
                  `${c.name} ${mode.mode} ${key} ${String(point.time)}: ${String(actual)} vs ${String(value)}`,
                );
              if (minutes === 1) byTime.set(point.cutoff, point);
              else {
                const same = byTime.get(point.cutoff);
                if (same === undefined) throw new Error("Equivalent canonical close missing");
                const abs = Math.abs(actual - same[key]);
                const rel = abs / Math.max(1, Math.abs(same[key]));
                maxima.multiAbs[k] = Math.max(maxima.multiAbs[k] ?? 0, abs);
                maxima.multiRel[k] = Math.max(maxima.multiRel[k] ?? 0, rel);
                if (abs >= 1e-12 || rel >= 1e-12 || abs > 0.02)
                  throw new Error("Strict multitemporal invariant failed");
              }
              maxima.compared += 1;
            });
            if (point.cutoff > acc.confirmedThrough) throw new Error("Future contamination");
            expect(point.provisional).toBe(point.cutoff < target[1]);
          });
        }
        // Every calculation-buffer partition continues the very same source stream.
        const ordered = canonicalLastWins(c.bars);
        for (const at of [
          0,
          Math.floor(mode.expected.length / 3),
          Math.floor(mode.expected.length / 2),
        ]) {
          const boundary = mode.expected[at]?.[0] ?? mode.anchor;
          const prefix = canonicalMonthSeed(acc, boundary);
          const continued = computeSeededAnchoredVwap(prefix, ordered, acc.confirmedThrough);
          expect(continued.length).toBe(mode.expected.length - at);
          continued.forEach((point, i) => {
            const expected = mode.expected[at + i];
            if (expected === undefined) throw new Error("Continuation missing");
            curves.forEach((key, k) => {
              const value = expected[k + 1];
              if (value !== null && value !== undefined && Math.abs(point[key] - value) > 1e-9)
                throw new Error("Seed partition error");
            });
          });
        }
      }
    },
  );

  it("combines weighted states, neutral identities and seeds without raw-moment cancellation", () => {
    const c = fixture.scenarios.find((s) => s.name.includes("tiny")) as Scenario;
    const rows = canonicalLastWins(c.bars);
    const fold = (bars: readonly Bar[]) =>
      bars.reduce(
        (s, b) => updateWelford(s, canonicalBarPrice(b), b.volume).state,
        createInitialWelfordState(),
      );
    const sequential = fold(rows);
    for (const chunks of [1, 2, 7, 31]) {
      let combined = createInitialWelfordState();
      const width = Math.ceil(rows.length / chunks);
      for (let i = 0; i < rows.length; i += width)
        combined = combineWelfordStates(
          Object.freeze(combined),
          Object.freeze(fold(rows.slice(i, i + width))),
        );
      expect(combined.count).toBe(sequential.count);
      expect(combined.cumWeight).toBe(sequential.cumWeight);
      expect(Math.abs(combined.mean - sequential.mean)).toBeLessThan(1e-9);
      expect(
        Math.abs(
          Math.sqrt(combined.m2 / combined.cumWeight) -
            Math.sqrt(sequential.m2 / sequential.cumWeight),
        ),
      ).toBeLessThan(1e-9);
    }
    expect(combineWelfordStates(createInitialWelfordState(), sequential)).toEqual(sequential);
    expect(combineWelfordStates(sequential, createInitialWelfordState())).toEqual(sequential);
    const acc = buildCanonicalMonthAccumulator({
      bars: rows,
      now: c.now,
      sessionMode: "EXTENDED",
      symbol: "SYN",
      adjSig: "A",
    });
    const seed = canonicalMonthSeed(acc, acc.confirmedThrough);
    expect(welfordFromSeed({ ...seed, seedP2V: 1 } as typeof seed)).toEqual(welfordFromSeed(seed));
    expect(
      welfordFromSeed({ ...seed, seedV: 0, seedMean: Number.NaN, seedM2: 0, seedCount: 0 }),
    ).toEqual(createInitialWelfordState());
    expect(() => welfordFromSeed({ ...seed, seedM2: Number.NaN })).toThrow();
    const naive = seed.seedP2V / seed.seedV - seed.seedMean ** 2;
    expect(Math.abs(naive - seed.seedM2 / seed.seedV)).toBeGreaterThan(1e-12);
  });

  it("proves coverage instead of guessing from endpoints, keeps zero volume NaN/null, and isolates sessions/revisions", () => {
    const c = fixture.scenarios[0] as Scenario;
    const rows = canonicalLastWins(c.bars);
    const input = {
      bars: rows,
      now: c.now,
      sessionMode: "EXTENDED" as const,
      symbol: "SYN",
      adjSig: "A",
    };
    const acc = buildCanonicalMonthAccumulator(input);
    const neutral = canonicalMonthSeed(acc, acc.anchorTimestamp);
    expect(neutral.coverageQuality).toBe("COMPLETE_CANONICAL_1M");
    expect(neutral.seedV).toBe(0);
    expect(neutral.seedMean).toBeNaN();
    expect(
      buildCanonicalMonthAccumulator({ ...input, bars: rows.filter((_, i) => i !== 50) })
        .coverageQuality,
    ).toBe("PARTIAL_MISSING_PREFIX");
    expect(buildCanonicalMonthAccumulator({ ...input, bars: rows.slice(50) }).coverageQuality).toBe(
      "PARTIAL_MISSING_PREFIX",
    );
    expect(buildCanonicalMonthAccumulator({ ...input, bars: [] }).coverageQuality).toBe(
      "UNAVAILABLE",
    );
    const approximate = buildCanonicalMonthAccumulator({ ...input, sourceResolution: "15m" });
    expect(approximate.coverageQuality).toBe("APPROX_AGGREGATED");
    expect(
      buildCanonicalMonthAccumulator({ ...input, market: "AR", sourceResolution: "1D" })
        .coverageQuality,
    ).not.toBe("COMPLETE_CANONICAL_1M");
    expect(
      buildCanonicalMonthAccumulator({ ...input, now: Date.parse("2029-01-03T18:00:00Z") / 1000 })
        .coverageQuality,
    ).toBe("UNAVAILABLE");
    const rth = buildCanonicalMonthAccumulator({ ...input, sessionMode: "RTH" });
    expect(rth.checkpoints.at(-1)?.state.cumWeight).toBeLessThan(
      acc.checkpoints.at(-1)?.state.cumWeight ?? 0,
    );
    const future = { ...(rows.at(-1) as Bar), time: c.now + 3600, volume: 1e9 };
    expect(buildCanonicalMonthAccumulator({ ...input, bars: [...rows, future] })).toEqual(acc);
    expect(
      projectCanonicalMonthAvwapToBars(acc, [
        { time: future.time, endExclusive: future.time + 60 },
      ])[0]?.vwap,
    ).toBeNaN();
    const holiday = {
      ...(rows[0] as Bar),
      time: Date.parse("2025-09-01T14:00:00Z") / 1000,
      volume: 1e9,
    };
    expect(buildCanonicalMonthAccumulator({ ...input, bars: [holiday, ...rows] })).toEqual(acc);
    const revised = buildCanonicalMonthAccumulator({
      ...input,
      bars: [...rows, { ...(rows[10] as Bar), volume: 1e6 }],
      adjSig: "SPLIT_B",
    });
    expect(revised.adjSig).toBe("SPLIT_B");
    expect(revised.checkpoints.at(-1)?.state).not.toEqual(acc.checkpoints.at(-1)?.state);
    const zero = fixture.scenarios.find((s) => s.name === "all_zero_volume") as Scenario;
    const zeroAcc = buildCanonicalMonthAccumulator({ ...input, bars: zero.bars, now: zero.now });
    const dto = serializeCanonicalMonth(
      zeroAcc,
      [{ time: zeroAcc.anchorTimestamp, endExclusive: zero.now }],
      zeroAcc.anchorTimestamp,
    );
    expect(dto.points[0]?.vwap).toBeNull();
    expect(dto.points[0]?.upper2).toBeNull();
    expect(dto.seed.seedMean).toBeNull();
    expect(JSON.stringify(dto)).not.toMatch(/NaN|Infinity/);
    const aligned = canonicalMonthOverlayPure(dto, [{ time: zeroAcc.anchorTimestamp }]);
    expect(aligned.vwap[0]).toBeNaN();
    const VW = { ...(rows[1] as Bar), vw: 1000 };
    expect(canonicalBarPrice(VW)).toBe(1000);
  });
});

describe("S1-4 — authoritative cumulative live snapshots (constant history cost)", () => {
  it("replaces previews, confirms once, preserves quote volume, and invalidates historical revisions", () => {
    const rows = fixture.live.seedBars;
    const through = (rows.at(-1)?.time ?? 0) + 60;
    const acc = buildCanonicalMonthAccumulator({
      bars: rows,
      now: through,
      sessionMode: "EXTENDED",
      symbol: "SYN",
      adjSig: "A",
    });
    let live = createCanonicalMonthLiveState(serializeCanonicalMonth(acc, [], acc.anchorTimestamp));
    for (const event of fixture.live.events) {
      if (event.closed !== null) live = updateCanonicalMonthLive(live, event.closed, true);
      live = updateCanonicalMonthLive(live, event.forming, false, event.forming.time + 20);
      const point = projectCanonicalMonthLive(live, event.forming.time);
      curves.forEach((key, k) => {
        expect(Math.abs(point[key] - (event.expected[k] ?? Number.NaN))).toBeLessThanOrEqual(1e-9);
      });
      expect(point.provisional).toBe(true);
      expect(point.cutoff).toBe(event.forming.time + 20);
      const preview = quoteCanonicalMonthLive(
        live,
        event.forming.close + 1,
        event.forming.time + 21,
      );
      expect(preview.provisional?.volume).toBe(event.forming.volume);
      expect(live.confirmed.cumWeight).toBeLessThan(event.V);
    }
    const closed = fixture.live.events.at(-1)?.closed as Bar;
    const duplicate = updateCanonicalMonthLive(live, closed, true);
    expect(duplicate).toEqual(live);
    const invalid = updateCanonicalMonthLive(live, { ...closed, volume: closed.volume + 1 }, true);
    expect(invalid.needsRefresh).toBe(true);
    expect(projectCanonicalMonthLive(invalid, closed.time).vwap).toBeNaN();
    const dec = Date.parse("2025-12-01T09:00:00Z") / 1000;
    const fresh = updateCanonicalMonthLive(
      live,
      { ...closed, time: dec, volume: 5 },
      false,
      dec + 20,
    );
    expect(fresh.monthKey).toBe("2025-12");
    expect(fresh.confirmed.count).toBe(0);
    expect(fresh.coverageQuality).toBe("COMPLETE_CANONICAL_1M");
    expect(canonicalMonthLiveBucket(fresh, 3600)).toBe(dec);
    integration["liveRepeatedSnapshots"] = "REPLACED_NOT_ACCUMULATED";
  });

  it("executes the real flush and paint callbacks: five incremental updates, zero setData and no historical buffer", () => {
    const source = readFileSync("web/src/components/StockDetailView.tsx", "utf8");
    const ast = ts.createSourceFile(
      "view.tsx",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const parts: Record<string, string> = {};
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ["paintFormingBar", "flushLiveTick"].includes(node.name.getText(ast)) &&
        node.initializer !== undefined
      )
        parts[node.name.getText(ast)] = node.initializer.getText(ast);
      ts.forEachChild(node, visit);
    };
    visit(ast);
    const paint = parts["paintFormingBar"];
    const flushCode = parts["flushLiveTick"];
    if (paint === undefined || flushCode === undefined)
      throw new Error("Real chart callbacks missing");
    const code = ts.transpileModule(
      `(()=>{const paintFormingBar=${paint};return ${flushCode};})()`,
      { compilerOptions: { target: ts.ScriptTarget.ES2023 } },
    ).outputText;
    const rows = fixture.live.seedBars;
    const through = (rows.at(-1)?.time ?? 0) + 60;
    const acc = buildCanonicalMonthAccumulator({
      bars: rows,
      now: through,
      sessionMode: "EXTENDED",
      symbol: "SYN",
      adjSig: "A",
    });
    const setData = vi.fn(() => {
      throw new Error("setData forbidden in live flush");
    });
    const update = vi.fn();
    const slots = Object.fromEntries(
      ["single_main", "single_u1", "single_l1", "single_u2", "single_l2"].map((k) => [
        k,
        { update, setData },
      ]),
    );
    const ctx = {
      tickRafIdRef: { current: 1 },
      pendingLiveEventsRef: { current: [] as unknown[] },
      formingBarRef: {
        current: { timeSec: through - 60, open: 500, high: 501, low: 499, close: 500, volume: 1 },
      },
      candleRef: { current: { update: vi.fn(), setData } },
      canonicalMonthLiveRef: {
        current: createCanonicalMonthLiveState(
          serializeCanonicalMonth(acc, [], acc.anchorTimestamp),
        ),
      },
      canonicalCoverageRef: { current: { hidden: true } },
      avwapRefs: { current: slots },
      emaBaseBeforeFormingRef: { current: { 9: null, 21: null, 50: null, 200: null } },
      emaEndOfFormingRef: { current: { 9: null, 21: null, 50: null, 200: null } },
      emaRefs: { current: [] },
      timeframe: "1m",
      tfSec: 60,
      updateCanonicalMonthLive,
      quoteCanonicalMonthLive,
      projectCanonicalMonthLive,
      canonicalMonthLiveBucket,
      projectLiveCandle,
    };
    const flush = runInNewContext(code, ctx) as () => void;
    for (const event of fixture.live.events) {
      ctx.pendingLiveEventsRef.current = [
        {
          kind: "minute",
          canonicalForming: event.forming,
          canonicalClosed: event.closed,
          canonicalAsOf: event.forming.time + 20,
          snapshot: {
            timeSec: event.forming.time,
            open: event.forming.open,
            high: event.forming.high,
            low: event.forming.low,
            close: event.forming.close,
            volume: event.forming.volume,
          },
        },
      ];
      flush();
    }
    expect(setData).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(5 * fixture.live.events.length);
    integration["liveSetDataCalls"] = setData.mock.calls.length;
    integration["liveSlotUpdatesPerEvent"] = 5;
  });
});

describe("S1-4 — backend DTO, existing prefix cache and honest AR degradation", () => {
  it("bounds symbol generations and expires the closed prefix independently of tail refreshes", async () => {
    const owner = new UsHistoricalService({
      router: new MassiveKeyRouter({ env: {}, fileValues: new Map() }),
      nowMs: () => 0,
      fetchFn: () => Promise.resolve({ ok: false, status: 404, text: "{}" }),
      fmp: { fetchHistoricalPaginated: () => Promise.reject(new Error("Unused transport")) },
    });
    const a = owner.adjustmentRevision("A");
    const b = owner.adjustmentRevision("B");
    owner.invalidate("A");
    expect(owner.adjustmentRevision("A")).toBeGreaterThan(a);
    expect(owner.adjustmentRevision("B")).toBe(b);
    for (let i = 0; i < 40; i += 1) owner.adjustmentRevision(String(i));
    expect(owner.adjustmentRevision("A")).toBeGreaterThan(a + 40);
    const c = fixture.scenarios.find((s) => s.name.includes("early_close")) as Scenario;
    const source = canonicalLastWins(c.bars);
    let clock = c.now * 1000;
    const starts: number[] = [];
    const runtime = new MarketRuntime({
      apiKey: "",
      massiveEnv: { MASSIVE_KEY_2: "SYNTH_S14_TTL" },
      fmpConfig: resolveFmpConfig({}),
      enableWs: false,
      nowMsFn: () => clock,
      fetchFn: (url) => {
        const parts = new URL(url).pathname.split("/");
        const from = Number(parts[8]) / 1000;
        const to = (Number(parts[9]) + 1) / 1000;
        const rows = url.includes("/range/1/minute/")
          ? source.filter((bar) => bar.time >= from && bar.time + 60 <= to)
          : [];
        if (url.includes("/range/1/minute/")) starts.push(from);
        return Promise.resolve({
          ok: true,
          status: 200,
          text: JSON.stringify({
            status: "OK",
            queryCount: rows.length,
            results: rows.map((bar) => ({
              t: bar.time * 1000,
              o: bar.open,
              h: bar.high,
              l: bar.low,
              c: bar.close,
              v: bar.volume,
              vw: bar.vw,
            })),
          }),
        });
      },
    });
    try {
      await runtime.getBars("TTL", "1m", { includeOverlays: false });
      const initial = starts[0] as number;
      clock += 14 * 60000;
      await runtime.getBars("TTL", "1m", { includeOverlays: false, forceRefresh: true });
      expect(starts.at(-1)).toBeGreaterThan(initial);
      clock += 2 * 60000;
      await runtime.getBars("TTL", "1m", { includeOverlays: false, forceRefresh: true });
      expect(starts.at(-1)).toBe(initial);
      integration["closedPrefixExpiresAfter15Minutes"] = true;
    } finally {
      runtime.stopWs();
    }
  });
  it("shares the canonical prefix across 1m/5m/15m/1H and rebuilds after an observed OHLC split revision", async () => {
    const c = fixture.scenarios.find((s) => s.name.includes("tiny")) as Scenario;
    const source = canonicalLastWins(c.bars);
    const requests: string[] = [];
    let clock = c.now * 1000;
    let split = false;
    const runtime = new MarketRuntime({
      apiKey: "",
      massiveEnv: { MASSIVE_KEY_2: "SYNTH_S14" },
      enableWs: false,
      fmpConfig: resolveFmpConfig({}),
      nowMsFn: () => clock,
      fetchFn: (url) => {
        requests.push(url);
        const p = new URL(url).pathname.split("/");
        const from = Number(p[8]) / 1000;
        const to = (Number(p[9]) + 1) / 1000;
        const rows = url.includes("/range/1/minute/")
          ? source.filter((b) => b.time >= from && b.time + 60 <= to)
          : [];
        const scale = split ? 0.5 : 1;
        return Promise.resolve({
          ok: true,
          status: 200,
          text: JSON.stringify({
            status: "OK",
            adjusted: true,
            queryCount: rows.length,
            results: rows.map((b) => ({
              t: b.time * 1000,
              o: b.open * scale,
              h: b.high * scale,
              l: b.low * scale,
              c: b.close * scale,
              v: b.volume,
              ...(b.vw === undefined ? {} : { vw: b.vw * scale }),
            })),
          }),
        });
      },
    });
    try {
      let referenceByCutoff: Map<number, number | null> | undefined;
      for (const tf of ["1m", "5m", "15m", "1h"] as const) {
        const result = await runtime.getBars("SYN", tf, { includeOverlays: false });
        const dto = result.monthStartCanonicalAvwap;
        expect(dto).toBeDefined();
        if (dto === undefined) throw new Error("Canonical DTO absent");
        expect(dto.seed.coverageQuality).toBe("COMPLETE_CANONICAL_1M");
        expect(JSON.stringify(dto)).not.toMatch(/NaN|Infinity|SYNTH_/);
        const aligned = canonicalMonthOverlayPure(dto, result.bars);
        expect(aligned.vwap).toHaveLength(result.bars.length);
        if (tf === "1m") referenceByCutoff = new Map(dto.points.map((p) => [p.cutoff, p.vwap]));
        else
          for (const point of dto.points)
            expect(point.vwap).toBe(referenceByCutoff?.get(point.cutoff));
      }
      const anchor = c.modes.find((m) => m.mode === "EXTENDED")?.anchor ?? 0;
      const prefixDownloads = () =>
        requests.filter((url) => {
          if (!url.includes("/range/1/minute/")) return false;
          const p = new URL(url).pathname.split("/");
          return Number(p[9]) / 1000 >= anchor;
        }).length;
      expect(prefixDownloads()).toBe(1);
      integration["redundantPrefixDownloads"] = prefixDownloads() - 1;
      const cold = await runtime.getBars("SYN", "1m", { includeOverlays: false });
      const count = requests.length;
      const hot = await runtime.getBars("SYN", "1m", { includeOverlays: false });
      expect(hot).toBe(cold);
      expect(requests).toHaveLength(count);
      split = true;
      clock += 9000;
      const revised = await runtime.getBars("SYN", "1m", {
        includeOverlays: false,
        forceRefresh: true,
      });
      expect(revised.monthStartCanonicalAvwap?.confirmedSeed.seedMean).toBeCloseTo(
        (cold.monthStartCanonicalAvwap?.confirmedSeed.seedMean ?? Number.NaN) * 0.5,
        8,
      );
      expect(revised.monthStartCanonicalAvwap?.confirmedSeed.seedM2).toBeCloseTo(
        (cold.monthStartCanonicalAvwap?.confirmedSeed.seedM2 ?? Number.NaN) * 0.25,
        8,
      );
      expect(prefixDownloads()).toBeGreaterThan(1);
      expect(revised.monthStartCanonicalAvwap?.adjSig).not.toBe(
        cold.monthStartCanonicalAvwap?.adjSig,
      );
      // A cached 5m response from the old adjustment generation must not survive.
      const otherTf = await runtime.getBars("SYN", "5m", { includeOverlays: false });
      expect(otherTf.monthStartCanonicalAvwap?.confirmedSeed.seedMean).toBe(
        revised.monthStartCanonicalAvwap?.confirmedSeed.seedMean,
      );
      const refreshed = createCanonicalMonthLiveState(
        revised.monthStartCanonicalAvwap as NonNullable<typeof revised.monthStartCanonicalAvwap>,
      );
      expect(refreshed.provisional).toBeNull();
      expect(refreshed.needsRefresh).toBe(false);
      integration["observedSplitRevision"] = "PREFIX_RELOADED_AND_STATS_REBUILT";
    } finally {
      runtime.stopWs();
    }
  });

  it("live state size and work remain independent of historical buffer length", () => {
    const c = fixture.scenarios.find((s) => s.name.includes("early_close")) as Scenario;
    const rows = canonicalLastWins(c.bars);
    const measured: unknown[] = [];
    for (const count of [500, 5000]) {
      const subset = rows.slice(0, count);
      const last = subset.at(-1) as Bar;
      const acc = buildCanonicalMonthAccumulator({
        bars: subset,
        now: last.time + 60,
        sessionMode: "EXTENDED",
        symbol: "SYN",
        adjSig: "A",
      });
      let state = createCanonicalMonthLiveState(
        serializeCanonicalMonth(acc, [], acc.anchorTimestamp),
      );
      const next = rows[count] as Bar;
      const start = performance.now();
      for (let i = 0; i < 1000; i += 1) {
        state = updateCanonicalMonthLive(state, next, false, next.time + 20);
        projectCanonicalMonthLive(state, next.time);
      }
      expect(Object.values(state).some(Array.isArray)).toBe(false);
      measured.push({
        historyBars: count,
        events: 1000,
        elapsedMs: performance.now() - start,
        stateFields: Object.keys(state).length,
      });
    }
    integration["liveCpuMeasurements"] = measured;
  });

  it("AR/BYMA native daily response is explicitly approximate and JSON-safe", async () => {
    const runtime = new ArgentinaMarketRuntime({
      minData912IntervalMs: 0,
      nowMsFn: () => Date.parse("2025-11-28T23:00:00Z"),
      fetchFn: (url) =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: {},
          text: url.includes("/historical/stocks/GGAL")
            ? JSON.stringify(
                Array.from({ length: 20 }, (_, i) => ({
                  date: `2025-11-${String(i + 1).padStart(2, "0")}`,
                  o: 80000,
                  h: 80010,
                  l: 79990,
                  c: 80005,
                  v: 100 + i,
                })),
              )
            : "[]",
        }),
    });
    const result = await runtime.getArTerminalBars("GGAL", "1D");
    expect(result.monthStartCanonicalAvwap?.seed.coverageQuality).toBe("APPROX_AGGREGATED");
    expect(result.monthStartCanonicalAvwap?.priceSource).toBe("HLC3_PROXY");
    expect(JSON.stringify(result.monthStartCanonicalAvwap)).not.toMatch(/NaN|Infinity/);
  });

  it("FMP fallback reuses its 1m prefix and preserves complete temporal coverage with HLC3 prices", async () => {
    const c = fixture.scenarios.find((s) => s.name === "complete_HLC3_proxy") as Scenario;
    const source = canonicalLastWins(c.bars);
    const first = source[0] as Bar;
    let prefixCalls = 0;
    const runtime = new MarketRuntime({
      apiKey: "",
      massiveEnv: {},
      fmpConfig: resolveFmpConfig({ FMP_API_KEY: "SYNTH_S14_FMP" }),
      enableWs: false,
      nowMsFn: () => c.now * 1000,
      fetchFn: (url) => {
        const parsed = new URL(url);
        if (!parsed.pathname.includes("historical-chart/"))
          return Promise.resolve({ ok: true, status: 200, text: "[]" });
        const minutes = parsed.pathname.includes("1hour")
          ? 60
          : parsed.pathname.includes("15min")
            ? 15
            : parsed.pathname.includes("5min")
              ? 5
              : 1;
        if (minutes === 1) prefixCalls += 1;
        const from = parsed.searchParams.get("from") ?? "";
        const to = parsed.searchParams.get("to") ?? "";
        const rows: Record<string, unknown>[] = [];
        if (from <= "2025-09-02" && to >= "2025-09-02")
          for (let i = 0; i < source.length; i += minutes) {
            const group = source.slice(i, i + minutes);
            const open = group[0] as Bar;
            const last = group.at(-1) as Bar;
            const minute = 240 + (open.time - first.time) / 60;
            rows.push({
              date: `2025-09-02 ${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00`,
              open: open.open,
              high: Math.max(...group.map((b) => b.high)),
              low: Math.min(...group.map((b) => b.low)),
              close: last.close,
              volume: group.reduce((v, b) => v + b.volume, 0),
            });
          }
        return Promise.resolve({ ok: true, status: 200, text: JSON.stringify(rows) });
      },
    });
    try {
      let prefixAfterCold = 0;
      let referenceByCutoff = new Map<number, number | null>();
      for (const tf of ["1m", "5m", "15m", "1h"] as const) {
        const result = await runtime.getBars("SYN", tf, { includeOverlays: false });
        const dto = result.monthStartCanonicalAvwap;
        if (dto === undefined) throw new Error("FMP canonical DTO missing");
        expect(dto.seed.coverageQuality).toBe("COMPLETE_CANONICAL_1M");
        expect(dto.priceSource).toBe("HLC3_PROXY");
        if (tf === "1m") {
          prefixAfterCold = prefixCalls;
          referenceByCutoff = new Map(dto.points.map((p) => [p.cutoff, p.vwap]));
        } else {
          expect(prefixCalls).toBe(prefixAfterCold);
          for (const point of dto.points)
            expect(point.vwap).toBe(referenceByCutoff.get(point.cutoff));
        }
      }
      integration["fmpRedundantPrefixDownloads"] = prefixCalls - prefixAfterCold;
    } finally {
      runtime.stopWs();
    }
  });
});
