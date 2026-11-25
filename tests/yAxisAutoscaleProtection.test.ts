import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, it, expect, vi, afterAll } from "vitest";
import ts from "typescript";
import {
  filterAutoAvwapByProximity,
  institutionalRepresentation,
  projectSessionKeyLevels,
  computeSessionKeyLevels,
  updateSessionKeyLevels,
  type ProximityMemory,
  type SessionSnapshot,
  type SessionObservation,
} from "../src/core/sessionKeyLevels.js";
import { PanoramicBandsPrimitive } from "../web/src/components/stock-detail/PanoramicBandsPrimitive.js";
import { fmtNum } from "../web/src/data/marketData.js";
const src = readFileSync("web/src/components/StockDetailView.tsx", "utf8");
const ast = ts.createSourceFile("view.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const initializers = new Map<string, string>();
const functions = new Map<string, string>();
const calls: { type: string; options: string }[] = [];
let registryCode = "";
function visit(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.initializer !== undefined)
    initializers.set(node.name.getText(ast), node.initializer.getText(ast));
  if (ts.isFunctionDeclaration(node) && node.name !== undefined)
    functions.set(node.name.getText(ast), node.getText(ast));
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "chart.addSeries")
    calls.push({
      type: node.arguments[0]?.getText(ast) ?? "",
      options: node.arguments[1]?.getText(ast) ?? "",
    });
  if (
    ts.isBinaryExpression(node) &&
    node.left.getText(ast) === "priceLineSlotsRef.current" &&
    ts.isObjectLiteralExpression(node.right)
  )
    registryCode = node.right.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
const transpile = (code: string): string =>
  ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None },
  }).outputText;
interface Info {
  priceRange: { minValue: number; maxValue: number };
}
interface EffectiveOptions {
  autoscaleInfoProvider?: (base: () => Info | null) => Info | null;
}
const options = calls.map((c) => ({
  type: c.type,
  options: runInNewContext(transpile(`(${c.options})`), {
    LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
    LineType: { Simple:0,WithSteps:1,Curved:2 },
  }) as EffectiveOptions,
}));
// Execute the installed 5.3.0 Series implementation, not a mock autoscale function.
const library = readFileSync(
  "web/node_modules/lightweight-charts/dist/lightweight-charts.development.mjs",
  "utf8",
);
const libAst = ts.createSourceFile(
  "library.mjs",
  library,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const classNames = ["PriceRangeImpl", "AutoscaleInfoImpl", "PrimitiveWrapper", "SeriesPrimitiveWrapper", "Series"];
const classes = libAst.statements
  .filter(
    (n): n is ts.ClassDeclaration =>
      ts.isClassDeclaration(n) && n.name !== undefined && classNames.includes(n.name.text),
  )
  .map((n) => n.getText(libAst))
  .join("\n");
const installed = runInNewContext(`(()=>{class PriceDataSource {}
class PrimitivePaneViewWrapper {}
const isInteger=v=>typeof v==='number'&&v%1===0;
${classes}
return (options,type,min,max,lines,primitives=[])=>{const series=Object.create(Series.prototype);series._private__options=options;series._private__seriesType=type;series._private__data={_internal_isEmpty:()=>false,_internal_minMaxOnRangeCached:()=>({_internal_min:min,_internal_max:max})};series._private__primitives=primitives.map(p=>new SeriesPrimitiveWrapper(p,series));series._private__customPriceLines=lines;const result=series._internal_autoscaleInfo(0,10);return result===null?null:result._internal_toRaw();};})()`) as (
  options: EffectiveOptions,
  type: string,
  min: number,
  max: number,
  lines: readonly unknown[],
  primitives?: readonly unknown[],
) => Info | null;
interface PriceLineOptions {
  price: number;
  lineVisible: boolean;
  axisLabelVisible: boolean;
  title: string;
  lineStyle: number;
}
let creates = 0;
let recreations = 0;
let duplicates = 0;
let liveSetDataCalls = 0;
const create = (): Record<
  string,
  { options: PriceLineOptions; applyOptions: (o: Partial<PriceLineOptions>) => void }
> =>
  runInNewContext(transpile(`(${registryCode})`), {
    LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
    candles: {
      createPriceLine: (opts: PriceLineOptions) => {
        creates += 1;
        const line = {
          options: { ...opts },
          applyOptions: (o: Partial<PriceLineOptions>) => {
            Object.assign(line.options, o);
          },
        };
        return line;
      },
    },
  }) as Record<
    string,
    { options: PriceLineOptions; applyOptions: (o: Partial<PriceLineOptions>) => void }
  >;
afterAll(() => {
  mkdirSync(".cache", { recursive: true });
  writeFileSync(
    ".cache/pieza3-axis-metrics.json",
    JSON.stringify({
      secondarySeries: options.filter(
        (o) => o.type === "LineSeries" && o.options.autoscaleInfoProvider?.(() => null) === null,
      ).length,
      rightAxisContributors: options.filter((o) => o.options.autoscaleInfoProvider === undefined)
        .length,
      persistentSlots: Object.keys(create()).length,
      recreations,
      duplicates,
      liveSetDataCalls,
      installedVersion: (
        JSON.parse(readFileSync("web/node_modules/lightweight-charts/package.json", "utf8")) as {
          version: string;
        }
      ).version,
      validation:
        "effective chart options + actual installed Series autoscale implementation; not browser E2E",
    }),
  );
});
describe("S1-7 effective configuration and installed LWC autoscale behavior", () => {
  it("passes autoscaleInfoProvider null to exactly 14 secondary series and leaves candles alone", () => {
    expect(options).toHaveLength(15);
    // Preserve the original thirteen slots and their original order/options.
    expect(options.slice(0,14).filter(o=>o.type==='LineSeries')).toHaveLength(13);
    expect(options[14]?.type).toBe('LineSeries');
    expect((options[14]?.options as EffectiveOptions & {lineType?:number}).lineType).toBe(1);
    expect(options.filter((o) => o.type === "LineSeries")).toHaveLength(14);
    for (const entry of options)
      if (entry.type === "LineSeries")
        expect(
          entry.options.autoscaleInfoProvider?.(() => ({
            priceRange: { minValue: 1, maxValue: 1e8 },
          })),
        ).toBeNull();
    const candles = options.find((o) => o.type === "CandlestickSeries");
    expect(candles?.options.autoscaleInfoProvider).toBeUndefined();
    const providers = src.match(/autoscaleInfoProvider:/g);
    expect(providers).toHaveLength(14);
  });
  it.each([
    { min: 499, max: 501, far: 530 },
    { min: 79000, max: 81000, far: 200000 },
  ])(
    "actual installed autoscale ignores secondary outliers and every custom price line at $far",
    (test) => {
      const lines = [
        "POC 1Y",
        "VAH",
        "VAL",
        "CALL WALL",
        "PUT WALL",
        "ZERO-GAMMA",
        "MAX PAIN",
        "SUP",
        "RES",
        "EVT",
        "PDH",
        "PDL",
        "PMH",
        "PML",
        "ORH",
        "ORL",
      ].map((title) => ({ price: test.far, title }));
      const candleOptions = options.find((o) => o.type === "CandlestickSeries")?.options;
      if (candleOptions === undefined) throw new Error("Missing real candlestick options");
      const baseline = installed(candleOptions, "Candlestick", test.min, test.max, []);
      expect(installed(candleOptions, "Candlestick", test.min, test.max, lines)).toEqual(baseline);
      for (const entry of options.filter((o) => o.type === "LineSeries"))
        expect(installed(entry.options, "Line", test.far, test.far * 100, lines)).toBeNull();
      expect(baseline?.priceRange).toEqual({ minValue: test.min, maxValue: test.max });
    },
  );
  it("reuses all sixteen price-line instances and diffs visibility, provisional style and Max Pain in place", () => {
    const slots = create();
    expect(Object.keys(slots)).toHaveLength(16);
    const initialCreates = creates;
    const lastPriceLineOptsRef = { current: {} };
    const update = runInNewContext(
      transpile(`(${initializers.get("updateSlot") ?? "undefined"})`),
      { lastPriceLineOptsRef, LineStyle: { Dashed: 2 } },
    ) as (
      key: string,
      line: (typeof slots)[string],
      enabled: boolean,
      price: number | null,
      title: string,
      highlighted: boolean,
      style?: number,
    ) => void;
    const line = slots["maxPain"];
    if (line === undefined) throw new Error("Missing Max Pain");
    for (const price of [530, null, Number.NaN, 80000, null]) {
      update("maxPain", line, true, price, "MAX PAIN", false);
      expect(line.options.lineVisible).toBe(price !== null && Number.isFinite(price));
    }
    const pmh = slots["pmh"];
    if (pmh === undefined) throw new Error("Missing PMH");
    update("pmh", pmh, true, 510, "PMH (prov)", false, 1);
    expect(pmh.options.lineStyle).toBe(1);
    update("pmh", pmh, true, 510, "PMH", false, 2);
    expect(pmh.options.lineStyle).toBe(2);
    const spy = vi.spyOn(pmh, "applyOptions");
    update("pmh", pmh, true, 510, "PMH", false, 2);
    expect(spy).not.toHaveBeenCalled();
    expect(creates).toBe(initialCreates);
    recreations += creates - initialCreates;
  });
  it("executes the real fixed-size overlay flush, preserves line identity, labels both currencies, and has no setData/recreation path", () => {
    const slots = create(),
      initialCreates = creates;
    const lastPriceLineOptsRef = { current: {} };
    const update = runInNewContext(
      transpile(`(${initializers.get("updateSlot") ?? "undefined"})`),
      { lastPriceLineOptsRef, LineStyle: { Dashed: 2 } },
    ) as (
      key: string,
      line: (typeof slots)[string],
      enabled: boolean,
      price: number | null,
      title: string,
      highlighted: boolean,
      style?: number,
    ) => void;
    const fixture = JSON.parse(
      readFileSync("fixtures/session_key_levels_reference.json", "utf8"),
    ) as {
      labelDates: { time: number; zone: string; expected: string }[];
      datasets: Record<string, SessionObservation[]>;
      live: (SessionSnapshot & { confirmed: boolean })[];
    };
    const rows = fixture.datasets["live"] as SessionObservation[];
    let session = computeSessionKeyLevels({
      symbol: "S",
      market: "US",
      evalTimeSec: (rows.at(-1) as SessionObservation).endExclusive,
      observations: rows,
    });
    const shortLabel = runInNewContext(
      transpile(`(${functions.get("autoAnchorShortLabel") ?? "undefined"})`),
    ) as (role: string) => string;
    const dateLabel = runInNewContext(
      transpile(`(${functions.get("formatAvwapAnchorLabel") ?? "undefined"})`),
      { AVWAP_DATE_FORMATTERS: new Map() },
    ) as (t: number, tz: string, include: boolean) => string | null;
    for (const row of fixture.labelDates)
      expect(dateLabel(row.time, row.zone, false)).toBe(row.expected);
    const visibility = new Map<string, boolean>();
    const setData = vi.fn(() => {
      throw new Error("setData forbidden");
    });
    const avwapRefs = {
      current: Object.fromEntries(
        ["auto_SUPPORT", "auto_RESISTANCE", "auto_EVENT"].map((k) => [
          k,
          {
            applyOptions: vi.fn((opts: { visible: boolean }) => {
              visibility.set(k, opts.visible);
            }),
            setData,
          },
        ]),
      ),
    };
    const context = {
      markerKey: null,
      candleMarkersRef: { current: { setMarkers: vi.fn() } },
      AUTO_ANCHOR_COLORS: { SUPPORT: "green", RESISTANCE: "red", EVENT: "orange" },
      frame: 1,
      session,
      price: 500,
      evalTime: session.evalTimeSec,
      timeframe: "1m",
      openingRange: 15,
      sessionLevelsEnabled: true,
      updatePriceLineSlotRef: {
        current: (
          key: string,
          enabled: boolean,
          price: number | null,
          title: string,
          provisional: boolean,
        ) => {
          const line = slots[key];
          if (line !== undefined) {
            update(key, line, enabled, price, title, false, provisional ? 1 : 2);
            const trajectory =
              key === "autoSupProj"
                ? "auto_SUPPORT"
                : key === "autoResProj"
                  ? "auto_RESISTANCE"
                  : key === "autoEvtProj"
                    ? "auto_EVENT"
                    : null;
            if (
              trajectory !== null &&
              line.options.lineVisible &&
              visibility.get(trajectory) === true
            )
              duplicates += 1;
          }
        },
      },
      bundle: {
        bars: [{ time: session.evalTimeSec }],
        barsAvailable: true,
        sessionKeyLevels: { sessionDate: session.sessionDate },
        autoAvwapLines: [
          {
            role: "SUPPORT",
            anchorTimeSec: session.evalTimeSec - 3600,
            currentAvwap: 500,
            inRange: false,
            effectiveAnchorTimeSec: null as number | null,
          },
        ],
        isAutoAvwapMode: true,
      },
      ticker: "S",
      proximityMode: "SHOW_ALL",
      dailyAtrAsOf: session.evalTimeSec,
      dailyAtr14: 1,
      proximityMemoryRef: { current: [] as readonly ProximityMemory[] },
      proximityBadgeRef: { current: { hidden: true } },
      overlays: { avwap: true },
      autoAnchorEnabled: { SUPPORT: true, RESISTANCE: true, EVENT: true },
      AUTO_ANCHOR_ROLES: ["SUPPORT", "RESISTANCE", "EVENT"],
      AUTO_ANCHOR_SLOT_BY_ROLE: {
        SUPPORT: "auto_SUPPORT",
        RESISTANCE: "auto_RESISTANCE",
        EVENT: "auto_EVENT",
      },
      market: "US",
      currencySymbol: "USD",
      trajectoryVisibility: new Map(),
      avwapRefs,
      projectSessionKeyLevels,
      filterAutoAvwapByProximity,
      institutionalRepresentation,
      autoAnchorShortLabel: shortLabel,
      formatAvwapAnchorLabel: dateLabel,
      fmtNum,
    };
    const code = initializers.get("flushSessionOverlays");
    if (code === undefined) throw new Error("Missing actual overlay controller");
    const flush = runInNewContext(transpile(`(${code})`), context) as () => void;
    for (const event of fixture.live) {
      session = updateSessionKeyLevels(session, event, event.confirmed);
      context.session = session;
      context.evalTime = session.evalTimeSec;
      flush();
    }
    expect(slots["autoSupProj"]?.options.title).toContain("SUP US$500,00");
    context.currencySymbol = "ARS";
    const first = context.bundle.autoAvwapLines[0];
    if (first !== undefined) first.currentAvwap = 80000;
    context.market = "AR";
    flush();
    expect(slots["autoSupProj"]?.options.title).toContain("SUP $80.000,00");
    for (let tick = 0; tick < 100; tick += 1) flush();
    context.proximityMode = "ATR_1_5";
    context.dailyAtr14 = Number.NaN;
    flush();
    expect(context.proximityBadgeRef.current.hidden).toBe(false);
    expect(slots["autoSupProj"]?.options.lineVisible).toBe(false);
    context.proximityMode = "SHOW_ALL";
    context.bundle.bars = [{ time: context.bundle.autoAvwapLines[0]?.anchorTimeSec ?? 0 }];
    const level = context.bundle.autoAvwapLines[0];
    if (level === undefined) throw new Error("Missing test anchor");
    level.inRange = true;
    level.effectiveAnchorTimeSec = level.anchorTimeSec;
    flush();
    expect(slots["autoSupProj"]?.options.lineVisible).toBe(false);
    expect(avwapRefs.current["auto_SUPPORT"]?.applyOptions).toHaveBeenLastCalledWith({
      visible: true,
    });
    expect(context.candleMarkersRef.current.setMarkers).toHaveBeenLastCalledWith(
      expect.arrayContaining([expect.objectContaining({ text: "SUP" })]),
    );
    context.bundle.autoAvwapLines = [];
    flush();
    expect(slots["autoSupProj"]?.options.lineVisible).toBe(false);
    expect(avwapRefs.current["auto_SUPPORT"]?.applyOptions).toHaveBeenLastCalledWith({
      visible: false,
    });
    expect(context.candleMarkersRef.current.setMarkers).toHaveBeenLastCalledWith([]);
    expect(creates).toBe(initialCreates);
    liveSetDataCalls += setData.mock.calls.length;
    expect(duplicates).toBe(0);
    expect(setData).not.toHaveBeenCalled();
    recreations += creates - initialCreates;
    for (const name of ["flushSessionOverlays", "flushLiveTick"]) {
      const body = initializers.get(name);
      expect(body).toBeDefined();
      expect(body).not.toMatch(/setData\(|createPriceLine\(|addSeries\(/);
    }
  });
  it.each([
    { min: 499, max: 501, farLow: 100, farHigh: 2500 },
    { min: 79000, max: 81000, farLow: 10000, farHigh: 350000 },
  ])(
    "PanoramicBandsPrimitive.autoscaleInfo() returns null and leaves candlestick Y-axis range unchanged at [$farLow, $farHigh]",
    ({ min, max, farLow, farHigh }) => {
      const primitive = new PanoramicBandsPrimitive({
        enabled: true,
        tickSize: 1,
        hvnZones: [
          {
            kind: "HVN",
            startBinIndex: 1,
            endBinIndex: 2,
            lowPrice: farLow,
            highPrice: farLow + 10,
            centerPrice: farLow + 5,
            volume: 1000,
            volumeSharePct: 50,
            prominence: 500,
            prominenceRatio: 0.9,
            isPriceGap: false,
          },
        ],
        lvnZones: [
          {
            kind: "LVN",
            startBinIndex: 3,
            endBinIndex: 4,
            lowPrice: farHigh - 10,
            highPrice: farHigh,
            centerPrice: farHigh - 5,
            volume: 0,
            volumeSharePct: 0,
            prominence: 400,
            prominenceRatio: 0.7,
            isPriceGap: true,
          },
        ],
      });
      expect(primitive.autoscaleInfo()).toBeNull();
      expect(src).toContain("candles.attachPrimitive(bandsPrimitive)");
      const candleOptions = options.find((o) => o.type === "CandlestickSeries")?.options;
      if (candleOptions === undefined) throw new Error("Missing real candlestick options");
      const baseline = installed(candleOptions, "Candlestick", min, max, []);
      expect(installed(candleOptions, "Candlestick", min, max, [], [primitive])).toEqual(baseline);
      expect(baseline?.priceRange).toEqual({ minValue: min, maxValue: max });
    },
  );
  it.each([
    { min: 499, max: 501, farLow: 50, farHigh: 3200 },
    { min: 79000, max: 81000, farLow: 5000, farHigh: 450000 },
  ])(
    "PanoramicBandsPrimitive with S2-3 triggers/sweeps returns autoscaleInfo() null and leaves candlestick Y-axis range unchanged at [$farLow, $farHigh]",
    ({ min, max, farLow, farHigh }) => {
      const primitive = new PanoramicBandsPrimitive({
        enabled: false,
        tickSize: null,
        hvnZones: [],
        lvnZones: [],
        triggersEnabled: true,
        triggerZones: [
          {
            id: "fvg:1m:1781098320:BULLISH",
            timeframe: "1m",
            methodology: "OHLCV",
            state: "ACTIVE_UNMITIGATED",
            initialDirection: "BULLISH",
            activeDirection: "BULLISH",
            isInverted: false,
            anchorStartTime: 1781098200,
            formedAtTime: 1781098320,
            formedAtBarIndex: 2,
            gapLow: farLow,
            gapHigh: farLow + 10,
            gapWidth: 10,
            midpoint: farLow + 5,
            mitigationRatio: 0,
            ifvgMitigationRatio: 0,
            mitigatedAtTime: null,
            invertedAtTime: null,
            invertedAtBarIndex: null,
            ifvgMitigatedAtTime: null,
            expiredAtTime: null,
            distanceToPrice: 100,
          },
          {
            id: "fvg:1m:1781098500:BEARISH",
            timeframe: "1m",
            methodology: "OHLCV",
            state: "INVERTED_IFVG_ACTIVE",
            initialDirection: "BEARISH",
            activeDirection: "BULLISH",
            isInverted: true,
            anchorStartTime: 1781098380,
            formedAtTime: 1781098500,
            formedAtBarIndex: 5,
            gapLow: farHigh - 10,
            gapHigh: farHigh,
            gapWidth: 10,
            midpoint: farHigh - 5,
            mitigationRatio: 1,
            ifvgMitigationRatio: 0.25,
            mitigatedAtTime: 1781098560,
            invertedAtTime: 1781098560,
            invertedAtBarIndex: 6,
            ifvgMitigatedAtTime: null,
            expiredAtTime: null,
            distanceToPrice: 200,
          },
        ],
        sweepMarkers: [
          {
            id: "sweep:1m:1781098620:PDH",
            timeframe: "1m",
            methodology: "OHLCV",
            provenanceLabel: "OHLCV_WICK_CLOSE_RECOVERY",
            levelId: "PDH",
            levelSide: "HIGH",
            direction: "BEARISH",
            levelPrice: farHigh - 2,
            barTime: 1781098620,
            barIndex: 7,
            wickExtreme: farHigh,
            closePrice: farHigh - 5,
            wickExcursion: 2,
            closeRecovery: 3,
          },
        ],
      });
      expect(primitive.autoscaleInfo()).toBeNull();
      const candleOptions = options.find((o) => o.type === "CandlestickSeries")?.options;
      if (candleOptions === undefined) throw new Error("Missing real candlestick options");
      const baseline = installed(candleOptions, "Candlestick", min, max, []);
      expect(installed(candleOptions, "Candlestick", min, max, [], [primitive])).toEqual(baseline);
      expect(baseline?.priceRange).toEqual({ minValue: min, maxValue: max });
    },
  );
});
