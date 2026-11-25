import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { describe, it, expect, afterAll } from "vitest";
import {
  filterAutoAvwapByProximity,
  institutionalRepresentation,
  type AutoAvwapProximityMode,
  type ProximityMemory,
} from "../src/core/sessionKeyLevels.js";
interface Prox {
  mode: AutoAvwapProximityMode;
  referencePrice: number;
  currentAvwap: number;
  atr14D: number | null | string;
  wasVisible: boolean;
  visible: boolean;
}
const fixture = JSON.parse(readFileSync("fixtures/session_key_levels_reference.json", "utf8")) as {
  proximity: Prox[];
  sequences: { mode: AutoAvwapProximityMode; steps: Omit<Prox, "wasVisible" | "mode">[] }[];
};
const src = readFileSync("web/src/components/StockDetailView.tsx", "utf8");
const anchor = {
  role: "SUPPORT" as const,
  anchorTimeSec: 10,
  currentAvwap: 100,
  score: 72,
  eventLabel: "E",
  sources: ["EVENT"],
};
let states = 0;
afterAll(() => {
  mkdirSync(".cache", { recursive: true });
  writeFileSync(
    ".cache/pieza3-proximity-metrics.json",
    JSON.stringify({ states, duplicates: 0, atrPercentageFallbacks: 0 }),
  );
});
describe("S1-5 exact Decimal thresholds and explicit hysteresis states", () => {
  it.each(fixture.proximity)(
    "Decimal $mode ref=$referencePrice level=$currentAvwap previous=$wasVisible ATR=$atr14D",
    (c) => {
      const atr = typeof c.atr14D === "string" ? Number(c.atr14D) : c.atr14D;
      const result = filterAutoAvwapByProximity({
        levels: [{ ...anchor, currentAvwap: c.currentAvwap }],
        symbol: "S",
        context: "C",
        mode: c.mode,
        referencePrice: c.referencePrice,
        atr14D: atr,
        evalTimeSec: 20,
        previous: [{ key: `S|C|${c.mode}|SUPPORT|10`, visible: c.wasVisible }],
      });
      expect(result.levels[0]?.visible).toBe(c.visible);
      expect(result.levels[0]?.score).toBe(72);
      states += 1;
      if (c.mode === "ATR_1_5" && !(typeof atr === "number" && Number.isFinite(atr) && atr > 0))
        expect(result.badge).toBe("ATR n/d");
    },
  );
  it.each(fixture.sequences)("executes ordered entry/stay/exit/re-entry: $mode", (sequence) => {
    let previous: readonly ProximityMemory[] = [];
    for (const step of sequence.steps) {
      const result = filterAutoAvwapByProximity({
        levels: [{ ...anchor, currentAvwap: step.currentAvwap }],
        symbol: "S",
        context: "C",
        mode: sequence.mode,
        referencePrice: step.referencePrice,
        atr14D: typeof step.atr14D === "number" ? step.atr14D : null,
        evalTimeSec: 20,
        previous,
      });
      expect(result.levels[0]?.visible).toBe(step.visible);
      previous = result.memory;
      states += 1;
    }
  });
  it("resets incompatible symbols/anchors/modes and ATR recovery starts hidden", () => {
    const base = {
      levels: [{ ...anchor, currentAvwap: 101.6 }],
      symbol: "S",
      context: "C",
      mode: "PCT_1_5" as const,
      referencePrice: 100,
      atr14D: 1,
      evalTimeSec: 20,
      previous: [{ key: "S|C|PCT_1_5|SUPPORT|10", visible: true }],
    };
    expect(filterAutoAvwapByProximity(base).levels[0]?.visible).toBe(true);
    for (const referencePrice of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(filterAutoAvwapByProximity({ ...base, referencePrice }).levels[0]?.visible).toBe(
        false,
      );
    expect(filterAutoAvwapByProximity({ ...base, symbol: "OTHER" }).levels[0]?.visible).toBe(false);
    expect(
      filterAutoAvwapByProximity({
        ...base,
        levels: [{ ...anchor, anchorTimeSec: 11, currentAvwap: 101.6 }],
      }).levels[0]?.visible,
    ).toBe(false);
    const invalid = filterAutoAvwapByProximity({ ...base, mode: "ATR_1_5", atr14D: undefined });
    expect(invalid.badge).toBe("ATR n/d");
    expect(
      filterAutoAvwapByProximity({ ...base, mode: "ATR_1_5", previous: invalid.memory }).levels[0]
        ?.visible,
    ).toBe(false);
    expect(
      filterAutoAvwapByProximity({
        ...base,
        mode: "SHOW_ALL",
        referencePrice: Number.NaN,
        atr14D: null,
      }).levels[0]?.visible,
    ).toBe(true);
    expect(
      filterAutoAvwapByProximity({
        ...base,
        mode: "SHOW_ALL",
        levels: [{ ...anchor, currentAvwap: Number.NaN }],
      }).levels[0]?.visible,
    ).toBe(false);
  });
  it("backfill transitions projection to trajectory at exact equality, never both; other TF remain legacy", () => {
    const base = {
      timeframe: "1m",
      firstBarTime: 20,
      evalTimeSec: 100,
      anchorTimeSec: 10,
      currentAvwap: 100,
      visible: true,
      legacyInRange: false,
    };
    expect(institutionalRepresentation(base)).toBe("PROJECTION");
    expect(institutionalRepresentation({ ...base, firstBarTime: 10 })).toBe("TRAJECTORY");
    expect(institutionalRepresentation({ ...base, firstBarTime: 5 })).toBe("TRAJECTORY");
    for (const firstBarTime of [undefined, 20, 10, 5])
      for (const visible of [true, false]) {
        const result = institutionalRepresentation({ ...base, firstBarTime, visible });
        expect(["HIDDEN", "PROJECTION", "TRAJECTORY"]).toContain(result);
      }
    expect(institutionalRepresentation({ ...base, firstBarTime: undefined })).toBe("HIDDEN");
    expect(institutionalRepresentation({ ...base, anchorTimeSec: 101 })).toBe("HIDDEN");
    expect(
      institutionalRepresentation({
        ...base,
        timeframe: "15m",
        legacyInRange: true,
        visible: false,
      }),
    ).toBe("TRAJECTORY");
    expect(institutionalRepresentation({ ...base, timeframe: "1D" })).toBe("HIDDEN");
  });
  it("retains eight AVWAP slots, institutional metadata, memory controls and currency/date formatting", () => {
    const slotType = src.slice(
      src.indexOf("type AvwapSlotKey ="),
      src.indexOf("const AUTO_ANCHOR_ROLES"),
    );
    expect(slotType.match(/\| '/g)).toHaveLength(8);
    expect(src).toContain("currentAvwap: anchor.currentAvwap");
    expect(src).toContain("currencySymbol==='USD'?'US$':'$'");
    expect(src).toContain("market==='US'?'America/New_York':'America/Argentina/Buenos_Aires'");
    expect(src).toContain("ATR n/d");
    expect(src).not.toContain("localStorage");
    expect(src.match(/computeAnchoredVwapWithAnchor\(/g)).toHaveLength(1);
  });
});
