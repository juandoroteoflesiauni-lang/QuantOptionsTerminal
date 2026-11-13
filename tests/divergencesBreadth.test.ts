import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  evaluateMacroVolatilityRegime,
  evaluateMarketBreadth,
  type BreadthBarInput,
  type BreadthDivergenceEvent,
  type BreadthDivergenceStatus,
  type BreadthDivergenceType,
  type MacroSeriesPoint,
  type MacroVolatilityOptions,
  type MacroVolatilityRegimeResult,
  type MarketBreadthOptions,
  type MarketBreadthResult,
  type VixRegime,
} from '../src/core/microstructure/breadthMacro.js';
import {
  computeWilderRsiSeries,
  detectConfirmedPivots,
  detectRsiDivergences,
  detectSmtDivergences,
  type ConfirmedPivot,
  type DetectRsiDivergencesOptions,
  type DetectSmtDivergencesOptions,
  type DivergenceStatus,
  type PivotKind,
  type RsiDivergenceEvent,
  type RsiDivergenceResult,
  type RsiDivergenceType,
  type SmtDivergenceEvent,
  type SmtDivergenceResult,
  type SmtDivergenceType,
  type SmtSweepingAsset,
} from '../src/core/microstructure/divergences.js';
import type { Bar } from '../src/core/types.js';

type FixtureScalar = number | 'NaN';

interface RawBarFixture {
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly vw?: number;
}

interface PivotFixture {
  readonly kind: PivotKind;
  readonly pivotIndex: number;
  readonly time: number;
  readonly price: number;
  readonly confirmedAtIndex: number;
  readonly confirmedAtTime: number;
  readonly confirmedAtCloseUtcSec: number;
}

interface RsiDivFixture {
  readonly type: RsiDivergenceType;
  readonly pivot1Index: number;
  readonly pivot2Index: number;
  readonly pivot1Time: number;
  readonly pivot2Time: number;
  readonly price1: number;
  readonly price2: number;
  readonly rsi1: number;
  readonly rsi2: number;
  readonly confirmedAtIndex: number;
  readonly confirmedAtTime: number;
  readonly confirmedAtCloseUtcSec: number;
}

interface RsiScenarioFixture {
  readonly id: string;
  readonly bars: readonly RawBarFixture[];
  readonly options: {
    readonly asOfUtcSec: number;
    readonly barSeconds: number;
    readonly rsiPeriod?: number;
    readonly leftBars?: number;
    readonly rightBars?: number;
  };
  readonly expected: {
    readonly asOfUtcSec: number;
    readonly barSeconds: number;
    readonly closedBarCount: number;
    readonly excludedFutureCount: number;
    readonly status: DivergenceStatus;
    readonly rsiPeriod: number;
    readonly rsiSeries: readonly FixtureScalar[];
    readonly latestRsi: FixtureScalar;
    readonly swingHighs: readonly PivotFixture[];
    readonly swingLows: readonly PivotFixture[];
    readonly divergences: readonly RsiDivFixture[];
    readonly latestDivergence: RsiDivFixture | null;
  };
}

interface SmtDivFixture {
  readonly type: SmtDivergenceType;
  readonly sweepingAsset: SmtSweepingAsset;
  readonly primaryPivot1Index: number;
  readonly primaryPivot2Index: number;
  readonly correlatedPivot1Index: number;
  readonly correlatedPivot2Index: number;
  readonly primaryPivot1Time: number;
  readonly primaryPivot2Time: number;
  readonly correlatedPivot1Time: number;
  readonly correlatedPivot2Time: number;
  readonly primaryPrice1: number;
  readonly primaryPrice2: number;
  readonly correlatedPrice1: number;
  readonly correlatedPrice2: number;
  readonly confirmedAtTime: number;
  readonly confirmedAtCloseUtcSec: number;
}

interface SmtScenarioFixture {
  readonly id: string;
  readonly primaryBars: readonly RawBarFixture[];
  readonly correlatedBars: readonly RawBarFixture[];
  readonly options: {
    readonly asOfUtcSec: number;
    readonly barSeconds: number;
    readonly leftBars?: number;
    readonly rightBars?: number;
    readonly maxPivotSkewBars?: number;
  };
  readonly expected: {
    readonly asOfUtcSec: number;
    readonly barSeconds: number;
    readonly synchronizedBarCount: number;
    readonly excludedFuturePrimaryCount: number;
    readonly excludedFutureCorrelatedCount: number;
    readonly status: DivergenceStatus;
    readonly primarySwingHighs: readonly PivotFixture[];
    readonly primarySwingLows: readonly PivotFixture[];
    readonly correlatedSwingHighs: readonly PivotFixture[];
    readonly correlatedSwingLows: readonly PivotFixture[];
    readonly divergences: readonly SmtDivFixture[];
    readonly latestDivergence: SmtDivFixture | null;
  };
}

interface BreadthBarRaw {
  readonly time: number;
  readonly indexClose: number;
  readonly indexHigh?: number;
  readonly indexLow?: number;
  readonly advances: number;
  readonly declines: number;
}

interface BreadthDivFixture {
  readonly type: BreadthDivergenceType;
  readonly pivot1Index: number;
  readonly pivot2Index: number;
  readonly pivot1Time: number;
  readonly pivot2Time: number;
  readonly indexPrice1: number;
  readonly indexPrice2: number;
  readonly adLine1: number;
  readonly adLine2: number;
  readonly confirmedAtIndex: number;
  readonly confirmedAtTime: number;
  readonly confirmedAtCloseUtcSec: number;
}

interface BreadthScenarioFixture {
  readonly id: string;
  readonly series: readonly BreadthBarRaw[];
  readonly options: {
    readonly asOfUtcSec: number;
    readonly barSeconds: number;
    readonly initialAdLine?: number;
    readonly leftBars?: number;
    readonly rightBars?: number;
  };
  readonly expected: {
    readonly asOfUtcSec: number;
    readonly barSeconds: number;
    readonly closedBarCount: number;
    readonly excludedFutureCount: number;
    readonly series: readonly {
      readonly time: number;
      readonly indexClose: number;
      readonly advances: number;
      readonly declines: number;
      readonly adNet: FixtureScalar;
      readonly adLine: FixtureScalar;
      readonly adRatio: FixtureScalar;
    }[];
    readonly latestAdNet: FixtureScalar;
    readonly latestAdLine: FixtureScalar;
    readonly latestAdRatio: FixtureScalar;
    readonly indexSwingHighs: readonly PivotFixture[];
    readonly indexSwingLows: readonly PivotFixture[];
    readonly divergences: readonly BreadthDivFixture[];
    readonly latestDivergence: BreadthDivFixture | null;
    readonly divergenceStatus: BreadthDivergenceStatus;
  };
}

type RawMacroPoint =
  | { readonly time: number; readonly value: FixtureScalar }
  | RawBarFixture;

interface MacroVolScenarioFixture {
  readonly id: string;
  readonly inputs: {
    readonly vix: readonly RawMacroPoint[];
    readonly cboeSkew: FixtureScalar | readonly RawMacroPoint[];
  };
  readonly options: {
    readonly asOfUtcSec: number;
    readonly vixBarSeconds?: number;
    readonly skewBarSeconds?: number;
    readonly vixSlopeWindow?: number;
    readonly skewAlertThreshold?: number;
  };
  readonly expected: {
    readonly asOfUtcSec: number;
    readonly closedVixCount: number;
    readonly excludedFutureVixCount: number;
    readonly closedSkewCount: number;
    readonly excludedFutureSkewCount: number;
    readonly vixLevel: FixtureScalar;
    readonly vixSlope: FixtureScalar;
    readonly cboeSkewLevel: FixtureScalar;
    readonly vixRegime: VixRegime;
    readonly tailRiskAlert: boolean;
    readonly baseVixFactor: FixtureScalar;
    readonly vixSlopePenaltyFactor: FixtureScalar;
    readonly skewPenaltyFactor: FixtureScalar;
    readonly positionSizeMultiplier: FixtureScalar;
  };
}

interface DivergencesBreadthFixtureFile {
  readonly meta: {
    readonly generator: string;
    readonly command: string;
    readonly precisionTolerance: number;
  };
  readonly rsiPrimitives: {
    readonly fluctuating: { readonly closes: readonly number[]; readonly rsi14: readonly FixtureScalar[] };
    readonly pureUp: { readonly closes: readonly number[]; readonly rsi14: readonly FixtureScalar[] };
    readonly flat: { readonly closes: readonly number[]; readonly rsi14: readonly FixtureScalar[] };
    readonly short14: { readonly closes: readonly number[]; readonly rsi14: readonly FixtureScalar[] };
  };
  readonly rsiScenarios: readonly RsiScenarioFixture[];
  readonly smtScenarios: readonly SmtScenarioFixture[];
  readonly breadthScenarios: readonly BreadthScenarioFixture[];
  readonly macroVolScenarios: readonly MacroVolScenarioFixture[];
}

const FIXTURE_PATH = resolve(process.cwd(), 'fixtures/divergences_breadth_reference.json');
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as DivergencesBreadthFixtureFile;
const TOLERANCE = FIXTURE.meta.precisionTolerance;

let maxObservedAbsDiff = 0;
let maxObservedRelDiff = 0;
let comparedScalars = 0;

function decodeScalar(v: FixtureScalar): number {
  return v === 'NaN' ? Number.NaN : v;
}

function assertCloseOrNaN(actual: number, expectedRaw: FixtureScalar, label: string): void {
  const expected = decodeScalar(expectedRaw);
  comparedScalars += 1;
  if (Number.isNaN(expected)) {
    expect(Number.isNaN(actual), `${label}: expected NaN, got ${String(actual)}`).toBe(true);
    return;
  }
  expect(Number.isFinite(actual), `${label}: expected finite ${String(expected)}, got ${String(actual)}`).toBe(true);
  const absDiff = Math.abs(actual - expected);
  const scale = Math.max(1, Math.abs(expected));
  const relDiff = absDiff / scale;
  if (absDiff > maxObservedAbsDiff) {
    maxObservedAbsDiff = absDiff;
  }
  if (relDiff > maxObservedRelDiff) {
    maxObservedRelDiff = relDiff;
  }
  expect(absDiff, `${label}: absDiff=${String(absDiff)} not < ${String(TOLERANCE * scale)}`).toBeLessThan(
    TOLERANCE * scale,
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      const prop = (value as Record<string, unknown>)[key];
      if (prop !== null && typeof prop === 'object' && !Object.isFrozen(prop)) {
        deepFreeze(prop);
      }
    }
  }
  return value;
}

function hydrateBars(raws: readonly RawBarFixture[]): Bar[] {
  return raws.map((b) => {
    const out: {
      time: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
      vw?: number;
    } = {
      time: b.time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    };
    if (b.vw !== undefined) {
      out.vw = b.vw;
    }
    return out;
  });
}

function hydrateBreadthBars(raws: readonly BreadthBarRaw[]): BreadthBarInput[] {
  return raws.map((b) => {
    const out: {
      time: number;
      indexClose: number;
      indexHigh?: number;
      indexLow?: number;
      advances: number;
      declines: number;
    } = {
      time: b.time,
      indexClose: b.indexClose,
      advances: b.advances,
      declines: b.declines,
    };
    if (b.indexHigh !== undefined) {
      out.indexHigh = b.indexHigh;
    }
    if (b.indexLow !== undefined) {
      out.indexLow = b.indexLow;
    }
    return out;
  });
}

function hydrateMacroSeries(raws: readonly RawMacroPoint[]): Array<MacroSeriesPoint | Bar> {
  return raws.map((pt) => {
    if ('value' in pt) {
      return { time: pt.time, value: decodeScalar(pt.value) };
    }
    return {
      time: pt.time,
      open: pt.open,
      high: pt.high,
      low: pt.low,
      close: pt.close,
      volume: pt.volume,
    };
  });
}

function hydrateRsiOptions(raw: RsiScenarioFixture['options']): DetectRsiDivergencesOptions {
  const out: {
    asOfUtcSec: number;
    barSeconds: number;
    rsiPeriod?: number;
    leftBars?: number;
    rightBars?: number;
  } = {
    asOfUtcSec: raw.asOfUtcSec,
    barSeconds: raw.barSeconds,
  };
  if (raw.rsiPeriod !== undefined) {
    out.rsiPeriod = raw.rsiPeriod;
  }
  if (raw.leftBars !== undefined) {
    out.leftBars = raw.leftBars;
  }
  if (raw.rightBars !== undefined) {
    out.rightBars = raw.rightBars;
  }
  return out;
}

function hydrateSmtOptions(raw: SmtScenarioFixture['options']): DetectSmtDivergencesOptions {
  const out: {
    asOfUtcSec: number;
    barSeconds: number;
    leftBars?: number;
    rightBars?: number;
    maxPivotSkewBars?: number;
  } = {
    asOfUtcSec: raw.asOfUtcSec,
    barSeconds: raw.barSeconds,
  };
  if (raw.leftBars !== undefined) {
    out.leftBars = raw.leftBars;
  }
  if (raw.rightBars !== undefined) {
    out.rightBars = raw.rightBars;
  }
  if (raw.maxPivotSkewBars !== undefined) {
    out.maxPivotSkewBars = raw.maxPivotSkewBars;
  }
  return out;
}

function hydrateBreadthOptions(raw: BreadthScenarioFixture['options']): MarketBreadthOptions {
  const out: {
    asOfUtcSec: number;
    barSeconds: number;
    initialAdLine?: number;
    leftBars?: number;
    rightBars?: number;
  } = {
    asOfUtcSec: raw.asOfUtcSec,
    barSeconds: raw.barSeconds,
  };
  if (raw.initialAdLine !== undefined) {
    out.initialAdLine = raw.initialAdLine;
  }
  if (raw.leftBars !== undefined) {
    out.leftBars = raw.leftBars;
  }
  if (raw.rightBars !== undefined) {
    out.rightBars = raw.rightBars;
  }
  return out;
}

function hydrateMacroOptions(raw: MacroVolScenarioFixture['options']): MacroVolatilityOptions {
  const out: {
    asOfUtcSec: number;
    vixBarSeconds?: number;
    skewBarSeconds?: number;
    vixSlopeWindow?: number;
    skewAlertThreshold?: number;
  } = {
    asOfUtcSec: raw.asOfUtcSec,
  };
  if (raw.vixBarSeconds !== undefined) {
    out.vixBarSeconds = raw.vixBarSeconds;
  }
  if (raw.skewBarSeconds !== undefined) {
    out.skewBarSeconds = raw.skewBarSeconds;
  }
  if (raw.vixSlopeWindow !== undefined) {
    out.vixSlopeWindow = raw.vixSlopeWindow;
  }
  if (raw.skewAlertThreshold !== undefined) {
    out.skewAlertThreshold = raw.skewAlertThreshold;
  }
  return out;
}

function assertPivotsMatch(
  actual: readonly ConfirmedPivot[],
  expected: readonly PivotFixture[],
  label: string,
): void {
  expect(actual, `${label} length`).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    const a = actual[i];
    const e = expected[i];
    if (a === undefined || e === undefined) {
      throw new Error(`${label}[${String(i)}] undefined`);
    }
    expect(a.kind).toBe(e.kind);
    expect(a.pivotIndex).toBe(e.pivotIndex);
    expect(a.time).toBe(e.time);
    expect(a.confirmedAtIndex).toBe(e.confirmedAtIndex);
    expect(a.confirmedAtTime).toBe(e.confirmedAtTime);
    expect(a.confirmedAtCloseUtcSec).toBe(e.confirmedAtCloseUtcSec);
    assertCloseOrNaN(a.price, e.price, `${label}[${String(i)}].price`);
  }
}

function assertRsiDivMatch(
  actual: RsiDivergenceEvent,
  expected: RsiDivFixture,
  label: string,
): void {
  expect(actual.type).toBe(expected.type);
  expect(actual.pivot1Index).toBe(expected.pivot1Index);
  expect(actual.pivot2Index).toBe(expected.pivot2Index);
  expect(actual.pivot1Time).toBe(expected.pivot1Time);
  expect(actual.pivot2Time).toBe(expected.pivot2Time);
  expect(actual.confirmedAtIndex).toBe(expected.confirmedAtIndex);
  expect(actual.confirmedAtTime).toBe(expected.confirmedAtTime);
  expect(actual.confirmedAtCloseUtcSec).toBe(expected.confirmedAtCloseUtcSec);
  assertCloseOrNaN(actual.price1, expected.price1, `${label}.price1`);
  assertCloseOrNaN(actual.price2, expected.price2, `${label}.price2`);
  assertCloseOrNaN(actual.rsi1, expected.rsi1, `${label}.rsi1`);
  assertCloseOrNaN(actual.rsi2, expected.rsi2, `${label}.rsi2`);
}

function assertSmtDivMatch(
  actual: SmtDivergenceEvent,
  expected: SmtDivFixture,
  label: string,
): void {
  expect(actual.type).toBe(expected.type);
  expect(actual.sweepingAsset).toBe(expected.sweepingAsset);
  expect(actual.primaryPivot1Index).toBe(expected.primaryPivot1Index);
  expect(actual.primaryPivot2Index).toBe(expected.primaryPivot2Index);
  expect(actual.correlatedPivot1Index).toBe(expected.correlatedPivot1Index);
  expect(actual.correlatedPivot2Index).toBe(expected.correlatedPivot2Index);
  expect(actual.primaryPivot1Time).toBe(expected.primaryPivot1Time);
  expect(actual.primaryPivot2Time).toBe(expected.primaryPivot2Time);
  expect(actual.correlatedPivot1Time).toBe(expected.correlatedPivot1Time);
  expect(actual.correlatedPivot2Time).toBe(expected.correlatedPivot2Time);
  expect(actual.confirmedAtTime).toBe(expected.confirmedAtTime);
  expect(actual.confirmedAtCloseUtcSec).toBe(expected.confirmedAtCloseUtcSec);
  assertCloseOrNaN(actual.primaryPrice1, expected.primaryPrice1, `${label}.primaryPrice1`);
  assertCloseOrNaN(actual.primaryPrice2, expected.primaryPrice2, `${label}.primaryPrice2`);
  assertCloseOrNaN(actual.correlatedPrice1, expected.correlatedPrice1, `${label}.correlatedPrice1`);
  assertCloseOrNaN(actual.correlatedPrice2, expected.correlatedPrice2, `${label}.correlatedPrice2`);
}

function assertBreadthDivMatch(
  actual: BreadthDivergenceEvent,
  expected: BreadthDivFixture,
  label: string,
): void {
  expect(actual.type).toBe(expected.type);
  expect(actual.pivot1Index).toBe(expected.pivot1Index);
  expect(actual.pivot2Index).toBe(expected.pivot2Index);
  expect(actual.pivot1Time).toBe(expected.pivot1Time);
  expect(actual.pivot2Time).toBe(expected.pivot2Time);
  expect(actual.confirmedAtIndex).toBe(expected.confirmedAtIndex);
  expect(actual.confirmedAtTime).toBe(expected.confirmedAtTime);
  expect(actual.confirmedAtCloseUtcSec).toBe(expected.confirmedAtCloseUtcSec);
  assertCloseOrNaN(actual.indexPrice1, expected.indexPrice1, `${label}.indexPrice1`);
  assertCloseOrNaN(actual.indexPrice2, expected.indexPrice2, `${label}.indexPrice2`);
  assertCloseOrNaN(actual.adLine1, expected.adLine1, `${label}.adLine1`);
  assertCloseOrNaN(actual.adLine2, expected.adLine2, `${label}.adLine2`);
}

describe('Pieza 11 — RSI/SMT Divergences & Market Breadth / VIX-SKEW Regime', () => {
  afterAll(() => {
    console.info(
      `[divergencesBreadth.test] Fixture precision summary: ${String(comparedScalars)} scalars checked, ` +
        `maxAbsDiff=${maxObservedAbsDiff.toExponential(3)}, maxRelDiff=${maxObservedRelDiff.toExponential(3)} ` +
        `(limit < ${String(TOLERANCE)})`,
    );
  });

  it('matches Python Wilder RSI(14) primitives strictly < 1e-11 including avgLoss=0 and flat=50', () => {
    const prim = FIXTURE.rsiPrimitives;

    const r1 = computeWilderRsiSeries(deepFreeze(prim.fluctuating.closes), 14);
    expect(r1).toHaveLength(prim.fluctuating.rsi14.length);
    for (let i = 0; i < r1.length; i += 1) {
      assertCloseOrNaN(r1[i] ?? Number.NaN, prim.fluctuating.rsi14[i] ?? 'NaN', `fluct[${String(i)}]`);
    }

    const rUp = computeWilderRsiSeries(deepFreeze(prim.pureUp.closes), 14);
    expect(rUp[14]).toBe(100);
    for (let i = 0; i < rUp.length; i += 1) {
      assertCloseOrNaN(rUp[i] ?? Number.NaN, prim.pureUp.rsi14[i] ?? 'NaN', `pureUp[${String(i)}]`);
    }

    const rFlat = computeWilderRsiSeries(deepFreeze(prim.flat.closes), 14);
    expect(rFlat[14]).toBe(50);
    for (let i = 0; i < rFlat.length; i += 1) {
      assertCloseOrNaN(rFlat[i] ?? Number.NaN, prim.flat.rsi14[i] ?? 'NaN', `flat[${String(i)}]`);
    }

    const rShort = computeWilderRsiSeries(deepFreeze(prim.short14.closes), 14);
    expect(rShort.every((x) => Number.isNaN(x))).toBe(true);
  });

  it.each(FIXTURE.rsiScenarios)(
    'matches Python RSI divergence reference for $id (< 1e-11) with deepFreeze',
    (scenario) => {
      const frozenBars = deepFreeze(hydrateBars(scenario.bars));
      const frozenOpts = deepFreeze(hydrateRsiOptions(scenario.options));

      const actual: RsiDivergenceResult = detectRsiDivergences(frozenBars, frozenOpts);
      const exp = scenario.expected;

      expect(actual.asOfUtcSec).toBe(exp.asOfUtcSec);
      expect(actual.barSeconds).toBe(exp.barSeconds);
      expect(actual.closedBarCount).toBe(exp.closedBarCount);
      expect(actual.excludedFutureCount).toBe(exp.excludedFutureCount);
      expect(actual.status).toBe(exp.status);
      expect(actual.rsiPeriod).toBe(exp.rsiPeriod);
      assertCloseOrNaN(actual.latestRsi, exp.latestRsi, `${scenario.id}.latestRsi`);

      expect(actual.rsiSeries).toHaveLength(exp.rsiSeries.length);
      for (let i = 0; i < exp.rsiSeries.length; i += 1) {
        assertCloseOrNaN(
          actual.rsiSeries[i] ?? Number.NaN,
          exp.rsiSeries[i] ?? 'NaN',
          `${scenario.id}.rsiSeries[${String(i)}]`,
        );
      }

      assertPivotsMatch(actual.swingHighs, exp.swingHighs, `${scenario.id}.swingHighs`);
      assertPivotsMatch(actual.swingLows, exp.swingLows, `${scenario.id}.swingLows`);

      expect(actual.divergences).toHaveLength(exp.divergences.length);
      for (let i = 0; i < exp.divergences.length; i += 1) {
        const aDiv = actual.divergences[i];
        const eDiv = exp.divergences[i];
        if (aDiv === undefined || eDiv === undefined) {
          throw new Error(`${scenario.id}.divergences[${String(i)}] undefined`);
        }
        assertRsiDivMatch(aDiv, eDiv, `${scenario.id}.div[${String(i)}]`);
      }

      if (exp.latestDivergence === null) {
        expect(actual.latestDivergence).toBeNull();
      } else {
        if (actual.latestDivergence === null) {
          throw new Error(`${scenario.id}: expected non-null latestDivergence`);
        }
        assertRsiDivMatch(actual.latestDivergence, exp.latestDivergence, `${scenario.id}.latestDiv`);
      }
    },
  );

  it('detects all 4 distinct RSI divergence types across fixture scenarios', () => {
    const allTypes = new Set<RsiDivergenceType>();
    for (const sc of FIXTURE.rsiScenarios) {
      const res = detectRsiDivergences(deepFreeze(hydrateBars(sc.bars)), hydrateRsiOptions(sc.options));
      for (const div of res.divergences) {
        allTypes.add(div.type);
      }
    }
    expect(allTypes).toEqual(
      new Set<RsiDivergenceType>([
        'RSI_REGULAR_BULLISH',
        'RSI_REGULAR_BEARISH',
        'RSI_HIDDEN_BULLISH',
        'RSI_HIDDEN_BEARISH',
      ]),
    );
  });

  it('enforces exact causal pivot invariant: pivot p is hidden at p + rightBars - 1 and confirmed only at p + rightBars close', () => {
    const bullScenario = FIXTURE.rsiScenarios[0];
    if (bullScenario === undefined) {
      throw new Error('Missing rsi_bullish_regular_and_hidden');
    }
    const bars = hydrateBars(bullScenario.bars);
    const barSeconds = bullScenario.options.barSeconds;
    const rightBars = 3;
    // In bull scenario, L4 is Swing Low at pivotIndex = 50, so confirmIdx = 53
    const pivotIndex = 50;
    const barAtRightMinus1 = bars[pivotIndex + rightBars - 1];
    const barAtConfirm = bars[pivotIndex + rightBars];
    if (barAtRightMinus1 === undefined || barAtConfirm === undefined) {
      throw new Error('Missing confirmation bar');
    }

    const asOfBeforeConfirm = barAtRightMinus1.time + barSeconds;
    const beforePivots = detectConfirmedPivots(deepFreeze(bars), {
      asOfUtcSec: asOfBeforeConfirm,
      barSeconds,
      leftBars: 3,
      rightBars,
    });
    expect(beforePivots.swingLows.some((p) => p.pivotIndex === pivotIndex)).toBe(false);

    const beforeRsi = detectRsiDivergences(deepFreeze(bars), {
      asOfUtcSec: asOfBeforeConfirm,
      barSeconds,
      leftBars: 3,
      rightBars,
    });
    expect(beforeRsi.divergences.some((d) => d.type === 'RSI_HIDDEN_BULLISH')).toBe(false);

    // Poison confirmation bar 53 & all future bars; state at p + rightBars - 1 must remain 100% invariant
    const poisonedFuture = bars.map((b, idx) =>
      idx >= pivotIndex + rightBars ? { ...b, open: 999, high: 1500, low: 10, close: 1400 } : b,
    );
    const beforePoisoned = detectRsiDivergences(deepFreeze(poisonedFuture), {
      asOfUtcSec: asOfBeforeConfirm,
      barSeconds,
      leftBars: 3,
      rightBars,
    });
    expect(beforePoisoned.divergences).toEqual(beforeRsi.divergences);
    expect(beforePoisoned.swingLows).toEqual(beforeRsi.swingLows);
    expect(beforePoisoned.latestRsi).toBe(beforeRsi.latestRsi);

    // Exact close of p + rightBars (= 53): pivot 50 + RSI_HIDDEN_BULLISH become confirmed!
    const asOfExactConfirm = barAtConfirm.time + barSeconds;
    const atConfirmPivots = detectConfirmedPivots(deepFreeze(bars), {
      asOfUtcSec: asOfExactConfirm,
      barSeconds,
      leftBars: 3,
      rightBars,
    });
    const confirmedPivot = atConfirmPivots.swingLows.find((p) => p.pivotIndex === pivotIndex);
    expect(confirmedPivot).toBeDefined();
    expect(confirmedPivot?.confirmedAtIndex).toBe(pivotIndex + rightBars);
    expect(confirmedPivot?.confirmedAtTime).toBe(barAtConfirm.time);
    expect(confirmedPivot?.confirmedAtCloseUtcSec).toBe(asOfExactConfirm);

    const atConfirmRsi = detectRsiDivergences(deepFreeze(bars), {
      asOfUtcSec: asOfExactConfirm,
      barSeconds,
      leftBars: 3,
      rightBars,
    });
    const hiddenBull = atConfirmRsi.divergences.find((d) => d.type === 'RSI_HIDDEN_BULLISH');
    expect(hiddenBull).toBeDefined();
    expect(hiddenBull?.pivot2Index).toBe(pivotIndex);
    expect(hiddenBull?.confirmedAtCloseUtcSec).toBe(asOfExactConfirm);
  });

  it.each(FIXTURE.smtScenarios)(
    'matches Python SMT divergence reference for $id (< 1e-11) with deepFreeze',
    (scenario) => {
      const frozenPrimary = deepFreeze(hydrateBars(scenario.primaryBars));
      const frozenCorrelated = deepFreeze(hydrateBars(scenario.correlatedBars));
      const frozenOpts = deepFreeze(hydrateSmtOptions(scenario.options));

      const actual: SmtDivergenceResult = detectSmtDivergences(
        frozenPrimary,
        frozenCorrelated,
        frozenOpts,
      );
      const exp = scenario.expected;

      expect(actual.asOfUtcSec).toBe(exp.asOfUtcSec);
      expect(actual.barSeconds).toBe(exp.barSeconds);
      expect(actual.synchronizedBarCount).toBe(exp.synchronizedBarCount);
      expect(actual.excludedFuturePrimaryCount).toBe(exp.excludedFuturePrimaryCount);
      expect(actual.excludedFutureCorrelatedCount).toBe(exp.excludedFutureCorrelatedCount);
      expect(actual.status).toBe(exp.status);

      assertPivotsMatch(actual.primarySwingHighs, exp.primarySwingHighs, `${scenario.id}.pSH`);
      assertPivotsMatch(actual.primarySwingLows, exp.primarySwingLows, `${scenario.id}.pSL`);
      assertPivotsMatch(actual.correlatedSwingHighs, exp.correlatedSwingHighs, `${scenario.id}.cSH`);
      assertPivotsMatch(actual.correlatedSwingLows, exp.correlatedSwingLows, `${scenario.id}.cSL`);

      expect(actual.divergences).toHaveLength(exp.divergences.length);
      for (let i = 0; i < exp.divergences.length; i += 1) {
        const aDiv = actual.divergences[i];
        const eDiv = exp.divergences[i];
        if (aDiv === undefined || eDiv === undefined) {
          throw new Error(`${scenario.id}.divergences[${String(i)}] undefined`);
        }
        assertSmtDivMatch(aDiv, eDiv, `${scenario.id}.smt[${String(i)}]`);
      }

      if (exp.latestDivergence === null) {
        expect(actual.latestDivergence).toBeNull();
      } else {
        if (actual.latestDivergence === null) {
          throw new Error(`${scenario.id}: expected non-null latestDivergence`);
        }
        assertSmtDivMatch(actual.latestDivergence, exp.latestDivergence, `${scenario.id}.latestSmt`);
      }
    },
  );

  it('requires maxPivotSkewBars >= 1 to match 1-bar offset SMT swings and respects maxPivotSeparationBars', () => {
    const skewScenario = FIXTURE.smtScenarios[1];
    if (skewScenario === undefined) {
      throw new Error('Missing smt_skew_1bar_match scenario');
    }
    const pBars = deepFreeze(hydrateBars(skewScenario.primaryBars));
    const cBars = deepFreeze(hydrateBars(skewScenario.correlatedBars));

    const strictZeroSkew = detectSmtDivergences(pBars, cBars, {
      asOfUtcSec: skewScenario.options.asOfUtcSec,
      barSeconds: skewScenario.options.barSeconds,
      maxPivotSkewBars: 0,
    });
    expect(strictZeroSkew.divergences.some((d) => d.type === 'SMT_BULLISH')).toBe(false);

    const allowedSkew1 = detectSmtDivergences(pBars, cBars, {
      asOfUtcSec: skewScenario.options.asOfUtcSec,
      barSeconds: skewScenario.options.barSeconds,
      maxPivotSkewBars: 1,
    });
    const bull = allowedSkew1.divergences.find((d) => d.type === 'SMT_BULLISH');
    if (bull === undefined || cBars[18] === undefined) {
      throw new Error('Expected skewed SMT_BULLISH divergence and confirmation bar 18');
    }
    expect(bull.primaryPivot2Index).toBe(14);
    expect(bull.correlatedPivot2Index).toBe(15);
    expect(bull.confirmedAtTime).toBe(cBars[18].time);
  });

  it.each(FIXTURE.breadthScenarios)(
    'matches Python Breadth A/D Line reference for $id (< 1e-11) with deepFreeze',
    (scenario) => {
      const frozenSeries = deepFreeze(hydrateBreadthBars(scenario.series));
      const frozenOpts = deepFreeze(hydrateBreadthOptions(scenario.options));

      const actual: MarketBreadthResult = evaluateMarketBreadth(frozenSeries, frozenOpts);
      const exp = scenario.expected;

      expect(actual.asOfUtcSec).toBe(exp.asOfUtcSec);
      expect(actual.barSeconds).toBe(exp.barSeconds);
      expect(actual.closedBarCount).toBe(exp.closedBarCount);
      expect(actual.excludedFutureCount).toBe(exp.excludedFutureCount);
      expect(actual.divergenceStatus).toBe(exp.divergenceStatus);
      assertCloseOrNaN(actual.latestAdNet, exp.latestAdNet, `${scenario.id}.latestAdNet`);
      assertCloseOrNaN(actual.latestAdLine, exp.latestAdLine, `${scenario.id}.latestAdLine`);
      assertCloseOrNaN(actual.latestAdRatio, exp.latestAdRatio, `${scenario.id}.latestAdRatio`);

      expect(actual.series).toHaveLength(exp.series.length);
      for (let i = 0; i < exp.series.length; i += 1) {
        const aPt = actual.series[i];
        const ePt = exp.series[i];
        if (aPt === undefined || ePt === undefined) {
          throw new Error(`${scenario.id}.series[${String(i)}] undefined`);
        }
        expect(aPt.time).toBe(ePt.time);
        assertCloseOrNaN(aPt.adNet, ePt.adNet, `${scenario.id}.series[${String(i)}].adNet`);
        assertCloseOrNaN(aPt.adLine, ePt.adLine, `${scenario.id}.series[${String(i)}].adLine`);
        assertCloseOrNaN(aPt.adRatio, ePt.adRatio, `${scenario.id}.series[${String(i)}].adRatio`);
      }

      assertPivotsMatch(actual.indexSwingHighs, exp.indexSwingHighs, `${scenario.id}.idxSH`);
      assertPivotsMatch(actual.indexSwingLows, exp.indexSwingLows, `${scenario.id}.idxSL`);

      expect(actual.divergences).toHaveLength(exp.divergences.length);
      for (let i = 0; i < exp.divergences.length; i += 1) {
        const aDiv = actual.divergences[i];
        const eDiv = exp.divergences[i];
        if (aDiv === undefined || eDiv === undefined) {
          throw new Error(`${scenario.id}.divergences[${String(i)}] undefined`);
        }
        assertBreadthDivMatch(aDiv, eDiv, `${scenario.id}.bDiv[${String(i)}]`);
      }
    },
  );

  it('uses indexClose for breadth pivots when indexHigh/indexLow are omitted and propagates NaN adNet cleanly', () => {
    const t0 = 1768435200;
    const step = 86400;
    const closes = [100, 102, 104, 108, 105, 102, 100, 104, 107, 112, 109, 106, 104];
    const series: BreadthBarInput[] = closes.map((c, i) => ({
      time: t0 + i * step,
      indexClose: c,
      advances: i < 5 ? 1800 : 800,
      declines: i < 5 ? 1000 : 1900,
    }));

    const res = evaluateMarketBreadth(deepFreeze(series), {
      asOfUtcSec: t0 + closes.length * step,
      barSeconds: step,
      leftBars: 2,
      rightBars: 2,
    });
    expect(res.divergenceStatus).toBe('BEARISH_BREADTH_DIVERGENCE');
    expect(res.divergences).toHaveLength(1);
    expect(res.divergences[0]?.pivot1Index).toBe(3);
    expect(res.divergences[0]?.pivot2Index).toBe(9);

    // Explicit NaN in advances must poison adLine onward without fallback
    const badSeries = series.map((item, idx) =>
      idx === 4 ? { ...item, advances: Number.NaN } : item,
    );
    const badRes = evaluateMarketBreadth(deepFreeze(badSeries), {
      asOfUtcSec: t0 + closes.length * step,
      barSeconds: step,
    });
    expect(Number.isNaN(badRes.series[4]?.adNet)).toBe(true);
    expect(Number.isNaN(badRes.latestAdLine)).toBe(true);
  });

  it.each(FIXTURE.macroVolScenarios)(
    'matches Python Macro Volatility Regime reference for $id (< 1e-11) with deepFreeze',
    (scenario) => {
      const frozenVix = deepFreeze(hydrateMacroSeries(scenario.inputs.vix));
      const frozenSkew =
        typeof scenario.inputs.cboeSkew === 'object'
          ? deepFreeze(hydrateMacroSeries(scenario.inputs.cboeSkew))
          : decodeScalar(scenario.inputs.cboeSkew);
      const frozenOpts = deepFreeze(hydrateMacroOptions(scenario.options));

      const actual: MacroVolatilityRegimeResult = evaluateMacroVolatilityRegime(
        deepFreeze({ vix: frozenVix, cboeSkew: frozenSkew }),
        frozenOpts,
      );
      const exp = scenario.expected;

      expect(actual.asOfUtcSec).toBe(exp.asOfUtcSec);
      expect(actual.closedVixCount).toBe(exp.closedVixCount);
      expect(actual.excludedFutureVixCount).toBe(exp.excludedFutureVixCount);
      expect(actual.closedSkewCount).toBe(exp.closedSkewCount);
      expect(actual.excludedFutureSkewCount).toBe(exp.excludedFutureSkewCount);
      expect(actual.vixRegime).toBe(exp.vixRegime);
      expect(actual.tailRiskAlert).toBe(exp.tailRiskAlert);

      assertCloseOrNaN(actual.vixLevel, exp.vixLevel, `${scenario.id}.vixLevel`);
      assertCloseOrNaN(actual.vixSlope, exp.vixSlope, `${scenario.id}.vixSlope`);
      assertCloseOrNaN(actual.cboeSkewLevel, exp.cboeSkewLevel, `${scenario.id}.cboeSkewLevel`);
      assertCloseOrNaN(actual.baseVixFactor, exp.baseVixFactor, `${scenario.id}.baseVixFactor`);
      assertCloseOrNaN(
        actual.vixSlopePenaltyFactor,
        exp.vixSlopePenaltyFactor,
        `${scenario.id}.vixSlopePenaltyFactor`,
      );
      assertCloseOrNaN(actual.skewPenaltyFactor, exp.skewPenaltyFactor, `${scenario.id}.skewPenaltyFactor`);
      assertCloseOrNaN(
        actual.positionSizeMultiplier,
        exp.positionSizeMultiplier,
        `${scenario.id}.positionSizeMultiplier`,
      );

      if (exp.vixRegime !== 'INSUFFICIENT_DATA') {
        expect(actual.positionSizeMultiplier).toBeGreaterThan(0);
        expect(actual.positionSizeMultiplier).toBeLessThanOrEqual(1);
      }
    },
  );

  it('returns INSUFFICIENT_DATA / NaN for zero/negative VIX and rejects invalid timestamps/counts/options', () => {
    const t0 = 1768435200;
    const validBar: Bar = { time: t0, open: 100, high: 101, low: 99, close: 100.5, volume: 500 };

    // VIX <= 0 yields INSUFFICIENT_DATA without fallback
    const zeroVix = evaluateMacroVolatilityRegime(
      { vix: [{ time: t0, value: 0 }], cboeSkew: 130 },
      { asOfUtcSec: t0 + 86400 },
    );
    expect(zeroVix.vixRegime).toBe('INSUFFICIENT_DATA');
    expect(Number.isNaN(zeroVix.positionSizeMultiplier)).toBe(true);

    // Millisecond timestamps rejected
    expect(() =>
      detectConfirmedPivots([{ ...validBar, time: t0 * 1000 }], {
        asOfUtcSec: t0 + 300,
        barSeconds: 300,
      }),
    ).toThrow(/UTC seconds/);

    expect(() =>
      detectRsiDivergences([validBar], { asOfUtcSec: t0 * 1000, barSeconds: 300 }),
    ).toThrow(/UTC seconds/);

    expect(() =>
      evaluateMarketBreadth(
        [{ time: t0 * 1000, indexClose: 500, advances: 100, declines: 50 }],
        { asOfUtcSec: t0 + 86400, barSeconds: 86400 },
      ),
    ).toThrow(/UTC seconds/);

    expect(() =>
      evaluateMacroVolatilityRegime(
        { vix: [{ time: t0 * 1000, value: 18 }], cboeSkew: 130 },
        { asOfUtcSec: t0 + 86400 },
      ),
    ).toThrow(/UTC seconds/);

    // Duplicate timestamps, negative advances, invalid options rejected
    expect(() =>
      detectConfirmedPivots([validBar, validBar], { asOfUtcSec: t0 + 900, barSeconds: 300 }),
    ).toThrow(/strictly increasing/);

    expect(() =>
      evaluateMarketBreadth(
        [{ time: t0, indexClose: 500, advances: -1, declines: 10 }],
        { asOfUtcSec: t0 + 86400, barSeconds: 86400 },
      ),
    ).toThrow(/advances/);

    expect(() =>
      evaluateMarketBreadth(
        [{ time: t0, indexClose: 500, indexHigh: 499, indexLow: 501, advances: 10, declines: 10 }],
        { asOfUtcSec: t0 + 86400, barSeconds: 86400 },
      ),
    ).toThrow(/indexHigh/);

    expect(() =>
      evaluateMacroVolatilityRegime(
        { vix: [{ time: t0, value: 18 }], cboeSkew: 130 },
        { asOfUtcSec: t0 + 86400, vixSlopeWindow: 1 },
      ),
    ).toThrow(/vixSlopeWindow/);

    expect(() =>
      evaluateMacroVolatilityRegime(
        { vix: [{ time: t0, value: 18 }], cboeSkew: 130 },
        { asOfUtcSec: t0 + 86400, skewAlertThreshold: 0 },
      ),
    ).toThrow(/skewAlertThreshold/);
  });
});
