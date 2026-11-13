import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  analyzeCvdAndAbsorption,
  type AbsorbingSide,
  type CvdAbsorptionOptions,
  type CvdAbsorptionResult,
  type CvdBar,
  type CvdSessionScope,
  type DeltaMode,
  type EffectiveDeltaMode,
  type KeyPriceLevel,
  type MatchedKeyLevel,
} from '../src/core/microstructure/cvdAbsorption.js';
import {
  computeEmpiricalPercentile,
  computeHmaSeries,
  computeSmaSeries,
  computeWilderAtrSeries,
  computeWmaSeries,
  evaluateMtfStructure,
  type MtfEffectiveRegime,
  type MtfRegime1d,
  type MtfSetupStatus,
  type MtfStructureInputs,
  type MtfStructureOptions,
  type MtfStructureResult,
} from '../src/core/microstructure/mtfStructure.js';
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
  readonly buyVolume?: FixtureScalar;
  readonly sellVolume?: FixtureScalar;
}

interface RawMtfOptions {
  readonly asOfUtcSec: number;
  readonly atr14_1d?: FixtureScalar;
  readonly atr14_15m?: FixtureScalar;
}

interface MtfExpectedFixture {
  readonly asOfUtcSec: number;
  readonly closed1dCount: number;
  readonly closed4hCount: number;
  readonly closed15mCount: number;
  readonly closed5mCount: number;
  readonly excludedFuture1dCount: number;
  readonly excludedFuture4hCount: number;
  readonly excludedFuture15mCount: number;
  readonly excludedFuture5mCount: number;
  readonly close1d: FixtureScalar;
  readonly sma200_1d: FixtureScalar;
  readonly atr14_1d: FixtureScalar;
  readonly distSma200Pct: FixtureScalar;
  readonly distSma200Atr: FixtureScalar;
  readonly regime1d: MtfRegime1d;
  readonly close4h: FixtureScalar;
  readonly sma50_4h: FixtureScalar;
  readonly aligned4h: boolean;
  readonly effectiveMacroRegime: MtfEffectiveRegime;
  readonly close15m: FixtureScalar;
  readonly ema21_15m: FixtureScalar;
  readonly atr14_15m: FixtureScalar;
  readonly pullback15mDistance: FixtureScalar;
  readonly pullback15mInZone: boolean;
  readonly wickToBodyRatio15m: FixtureScalar;
  readonly volume15mPercentile: FixtureScalar;
  readonly absorption15m: boolean;
  readonly close5m: FixtureScalar;
  readonly hma55: FixtureScalar;
  readonly hma55Prev: FixtureScalar;
  readonly hma55Prev2: FixtureScalar;
  readonly hma55Slope: FixtureScalar;
  readonly hma55SlopePrev: FixtureScalar;
  readonly executionTriggerActive: boolean;
  readonly setupStatus: MtfSetupStatus;
}

interface MtfScenarioFixture {
  readonly id: string;
  readonly inputs: {
    readonly bars1d: readonly RawBarFixture[];
    readonly bars4h: readonly RawBarFixture[];
    readonly bars15m: readonly RawBarFixture[];
    readonly bars5m: readonly RawBarFixture[];
  };
  readonly options: RawMtfOptions;
  readonly expected: MtfExpectedFixture;
}

interface RawCvdOptions {
  readonly asOfUtcSec: number;
  readonly barSeconds: number;
  readonly sessionScope?: CvdSessionScope;
  readonly atr?: FixtureScalar;
  readonly levelProximityAtr?: number;
  readonly levelProximityPct?: number;
  readonly levels: readonly { readonly name: string; readonly price: FixtureScalar }[];
}

interface CvdExpectedFixture {
  readonly asOfUtcSec: number;
  readonly barSeconds: number;
  readonly sessionScope: CvdSessionScope;
  readonly closedInSessionCount: number;
  readonly excludedFutureCount: number;
  readonly excludedOutOfSessionCount: number;
  readonly skippedInvalidLevelCount: number;
  readonly toleranceValid: boolean;
  readonly atrProximityTolerance: FixtureScalar;
  readonly deltaMode: EffectiveDeltaMode;
  readonly sessionDeltaModes: readonly {
    readonly sessionDate: string;
    readonly deltaMode: DeltaMode;
    readonly barCount: number;
    readonly finalSessionCvd: FixtureScalar;
  }[];
  readonly currentSessionDate: string | null;
  readonly currentSessionCvd: FixtureScalar;
  readonly bars: readonly {
    readonly time: number;
    readonly sessionDate: string;
    readonly deltaMode: DeltaMode;
    readonly open: number;
    readonly high: number;
    readonly low: number;
    readonly close: number;
    readonly volume: number;
    readonly barDelta: FixtureScalar;
    readonly sessionCvd: FixtureScalar;
    readonly volumePercentile: FixtureScalar;
    readonly deltaPercentile: FixtureScalar;
    readonly bodyDisplacementPercentile: FixtureScalar;
    readonly absorptionTriggered: boolean;
    readonly absorbingSide: AbsorbingSide;
    readonly matchedLevels: readonly MatchedKeyLevel[];
  }[];
  readonly absorptionEvents: readonly {
    readonly time: number;
    readonly sessionDate: string;
    readonly deltaMode: DeltaMode;
    readonly close: number;
    readonly high: number;
    readonly low: number;
    readonly volume: number;
    readonly barDelta: number;
    readonly sessionCvd: FixtureScalar;
    readonly absorbingSide: 'BUY_ABSORPTION' | 'SELL_ABSORPTION';
    readonly volumePercentile: number;
    readonly deltaPercentile: number;
    readonly bodyDisplacementPercentile: number;
    readonly primaryLevel: MatchedKeyLevel;
    readonly matchedLevels: readonly MatchedKeyLevel[];
  }[];
}

interface CvdScenarioFixture {
  readonly id: string;
  readonly bars: readonly RawBarFixture[];
  readonly options: RawCvdOptions;
  readonly expected: CvdExpectedFixture;
}

interface MtfCvdFixtureFile {
  readonly meta: {
    readonly generator: string;
    readonly command: string;
    readonly precisionTolerance: number;
  };
  readonly primitives: {
    readonly bars: readonly RawBarFixture[];
    readonly sma10: readonly FixtureScalar[];
    readonly wma10: readonly FixtureScalar[];
    readonly hma55: readonly FixtureScalar[];
    readonly wilderAtr14: readonly FixtureScalar[];
  };
  readonly mtfScenarios: readonly MtfScenarioFixture[];
  readonly cvdScenarios: readonly CvdScenarioFixture[];
}

const FIXTURE_PATH = resolve(process.cwd(), 'fixtures/mtf_cvd_reference.json');
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as MtfCvdFixtureFile;
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

function hydrateCvdBars(raws: readonly RawBarFixture[]): CvdBar[] {
  return raws.map((b) => {
    const out: {
      time: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
      vw?: number;
      buyVolume?: number;
      sellVolume?: number;
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
    if (b.buyVolume !== undefined) {
      out.buyVolume = decodeScalar(b.buyVolume);
    }
    if (b.sellVolume !== undefined) {
      out.sellVolume = decodeScalar(b.sellVolume);
    }
    return out;
  });
}

function hydrateMtfOptions(raw: RawMtfOptions): MtfStructureOptions {
  const out: {
    asOfUtcSec: number;
    atr14_1d?: number;
    atr14_15m?: number;
  } = {
    asOfUtcSec: raw.asOfUtcSec,
  };
  if (raw.atr14_1d !== undefined) {
    out.atr14_1d = decodeScalar(raw.atr14_1d);
  }
  if (raw.atr14_15m !== undefined) {
    out.atr14_15m = decodeScalar(raw.atr14_15m);
  }
  return out;
}

function hydrateCvdOptions(raw: RawCvdOptions): CvdAbsorptionOptions {
  const levels: KeyPriceLevel[] = raw.levels.map((lvl) => ({
    name: lvl.name,
    price: decodeScalar(lvl.price),
  }));
  const out: {
    asOfUtcSec: number;
    barSeconds: number;
    sessionScope?: CvdSessionScope;
    levels: KeyPriceLevel[];
    atr?: number;
    levelProximityAtr?: number;
    levelProximityPct?: number;
  } = {
    asOfUtcSec: raw.asOfUtcSec,
    barSeconds: raw.barSeconds,
    levels,
  };
  if (raw.sessionScope !== undefined) {
    out.sessionScope = raw.sessionScope;
  }
  if (raw.atr !== undefined) {
    out.atr = decodeScalar(raw.atr);
  }
  if (raw.levelProximityAtr !== undefined) {
    out.levelProximityAtr = raw.levelProximityAtr;
  }
  if (raw.levelProximityPct !== undefined) {
    out.levelProximityPct = raw.levelProximityPct;
  }
  return out;
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

function assertSeriesClose(actual: readonly number[], expected: readonly FixtureScalar[], label: string): void {
  expect(actual, `${label} length`).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    const a = actual[i];
    const e = expected[i];
    if (a === undefined || e === undefined) {
      throw new Error(`${label}[${String(i)}] undefined`);
    }
    assertCloseOrNaN(a, e, `${label}[${String(i)}]`);
  }
}

function assertMtfMatchesFixture(actual: MtfStructureResult, exp: MtfExpectedFixture, id: string): void {
  expect(actual.asOfUtcSec, `${id}.asOfUtcSec`).toBe(exp.asOfUtcSec);
  expect(actual.closed1dCount, `${id}.closed1dCount`).toBe(exp.closed1dCount);
  expect(actual.closed4hCount, `${id}.closed4hCount`).toBe(exp.closed4hCount);
  expect(actual.closed15mCount, `${id}.closed15mCount`).toBe(exp.closed15mCount);
  expect(actual.closed5mCount, `${id}.closed5mCount`).toBe(exp.closed5mCount);
  expect(actual.excludedFuture1dCount, `${id}.excludedFuture1dCount`).toBe(exp.excludedFuture1dCount);
  expect(actual.excludedFuture4hCount, `${id}.excludedFuture4hCount`).toBe(exp.excludedFuture4hCount);
  expect(actual.excludedFuture15mCount, `${id}.excludedFuture15mCount`).toBe(exp.excludedFuture15mCount);
  expect(actual.excludedFuture5mCount, `${id}.excludedFuture5mCount`).toBe(exp.excludedFuture5mCount);

  assertCloseOrNaN(actual.close1d, exp.close1d, `${id}.close1d`);
  assertCloseOrNaN(actual.sma200_1d, exp.sma200_1d, `${id}.sma200_1d`);
  assertCloseOrNaN(actual.atr14_1d, exp.atr14_1d, `${id}.atr14_1d`);
  assertCloseOrNaN(actual.distSma200Pct, exp.distSma200Pct, `${id}.distSma200Pct`);
  assertCloseOrNaN(actual.distSma200Atr, exp.distSma200Atr, `${id}.distSma200Atr`);
  expect(actual.regime1d, `${id}.regime1d`).toBe(exp.regime1d);

  assertCloseOrNaN(actual.close4h, exp.close4h, `${id}.close4h`);
  assertCloseOrNaN(actual.sma50_4h, exp.sma50_4h, `${id}.sma50_4h`);
  expect(actual.aligned4h, `${id}.aligned4h`).toBe(exp.aligned4h);
  expect(actual.effectiveMacroRegime, `${id}.effectiveMacroRegime`).toBe(exp.effectiveMacroRegime);

  assertCloseOrNaN(actual.close15m, exp.close15m, `${id}.close15m`);
  assertCloseOrNaN(actual.ema21_15m, exp.ema21_15m, `${id}.ema21_15m`);
  assertCloseOrNaN(actual.atr14_15m, exp.atr14_15m, `${id}.atr14_15m`);
  assertCloseOrNaN(actual.pullback15mDistance, exp.pullback15mDistance, `${id}.pullback15mDistance`);
  expect(actual.pullback15mInZone, `${id}.pullback15mInZone`).toBe(exp.pullback15mInZone);
  assertCloseOrNaN(actual.wickToBodyRatio15m, exp.wickToBodyRatio15m, `${id}.wickToBodyRatio15m`);
  assertCloseOrNaN(actual.volume15mPercentile, exp.volume15mPercentile, `${id}.volume15mPercentile`);
  expect(actual.absorption15m, `${id}.absorption15m`).toBe(exp.absorption15m);

  assertCloseOrNaN(actual.close5m, exp.close5m, `${id}.close5m`);
  assertCloseOrNaN(actual.hma55, exp.hma55, `${id}.hma55`);
  assertCloseOrNaN(actual.hma55Prev, exp.hma55Prev, `${id}.hma55Prev`);
  assertCloseOrNaN(actual.hma55Prev2, exp.hma55Prev2, `${id}.hma55Prev2`);
  assertCloseOrNaN(actual.hma55Slope, exp.hma55Slope, `${id}.hma55Slope`);
  assertCloseOrNaN(actual.hma55SlopePrev, exp.hma55SlopePrev, `${id}.hma55SlopePrev`);
  expect(actual.executionTriggerActive, `${id}.executionTriggerActive`).toBe(exp.executionTriggerActive);
  expect(actual.setupStatus, `${id}.setupStatus`).toBe(exp.setupStatus);
}

function assertMatchedLevelsClose(
  actual: readonly MatchedKeyLevel[],
  expected: readonly MatchedKeyLevel[],
  label: string,
): void {
  expect(actual, `${label} length`).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    const a = actual[i];
    const e = expected[i];
    if (a === undefined || e === undefined) {
      throw new Error(`${label}[${String(i)}] undefined`);
    }
    expect(a.name).toBe(e.name);
    assertCloseOrNaN(a.price, e.price, `${label}[${String(i)}].price`);
    assertCloseOrNaN(a.tolerance, e.tolerance, `${label}[${String(i)}].tolerance`);
    assertCloseOrNaN(a.distance, e.distance, `${label}[${String(i)}].distance`);
  }
}

function assertCvdMatchesFixture(actual: CvdAbsorptionResult, exp: CvdExpectedFixture, id: string): void {
  expect(actual.asOfUtcSec, `${id}.asOfUtcSec`).toBe(exp.asOfUtcSec);
  expect(actual.barSeconds, `${id}.barSeconds`).toBe(exp.barSeconds);
  expect(actual.sessionScope, `${id}.sessionScope`).toBe(exp.sessionScope);
  expect(actual.closedInSessionCount, `${id}.closedInSessionCount`).toBe(exp.closedInSessionCount);
  expect(actual.excludedFutureCount, `${id}.excludedFutureCount`).toBe(exp.excludedFutureCount);
  expect(actual.excludedOutOfSessionCount, `${id}.excludedOutOfSessionCount`).toBe(exp.excludedOutOfSessionCount);
  expect(actual.skippedInvalidLevelCount, `${id}.skippedInvalidLevelCount`).toBe(exp.skippedInvalidLevelCount);
  expect(actual.toleranceValid, `${id}.toleranceValid`).toBe(exp.toleranceValid);
  assertCloseOrNaN(actual.atrProximityTolerance, exp.atrProximityTolerance, `${id}.atrProximityTolerance`);
  expect(actual.deltaMode, `${id}.deltaMode`).toBe(exp.deltaMode);
  expect(actual.currentSessionDate, `${id}.currentSessionDate`).toBe(exp.currentSessionDate);
  assertCloseOrNaN(actual.currentSessionCvd, exp.currentSessionCvd, `${id}.currentSessionCvd`);

  expect(actual.sessionDeltaModes).toHaveLength(exp.sessionDeltaModes.length);
  for (let i = 0; i < exp.sessionDeltaModes.length; i += 1) {
    const aSess = actual.sessionDeltaModes[i];
    const eSess = exp.sessionDeltaModes[i];
    if (aSess === undefined || eSess === undefined) {
      throw new Error(`${id}.sessionDeltaModes[${String(i)}] undefined`);
    }
    expect(aSess.sessionDate).toBe(eSess.sessionDate);
    expect(aSess.deltaMode).toBe(eSess.deltaMode);
    expect(aSess.barCount).toBe(eSess.barCount);
    assertCloseOrNaN(aSess.finalSessionCvd, eSess.finalSessionCvd, `${id}.sessionDeltaModes[${String(i)}].finalSessionCvd`);
  }

  expect(actual.bars).toHaveLength(exp.bars.length);
  for (let i = 0; i < exp.bars.length; i += 1) {
    const aBar = actual.bars[i];
    const eBar = exp.bars[i];
    if (aBar === undefined || eBar === undefined) {
      throw new Error(`${id}.bars[${String(i)}] undefined`);
    }
    expect(aBar.time).toBe(eBar.time);
    expect(aBar.sessionDate).toBe(eBar.sessionDate);
    expect(aBar.deltaMode).toBe(eBar.deltaMode);
    assertCloseOrNaN(aBar.barDelta, eBar.barDelta, `${id}.bars[${String(i)}].barDelta`);
    assertCloseOrNaN(aBar.sessionCvd, eBar.sessionCvd, `${id}.bars[${String(i)}].sessionCvd`);
    assertCloseOrNaN(aBar.volumePercentile, eBar.volumePercentile, `${id}.bars[${String(i)}].volumePercentile`);
    assertCloseOrNaN(aBar.deltaPercentile, eBar.deltaPercentile, `${id}.bars[${String(i)}].deltaPercentile`);
    assertCloseOrNaN(
      aBar.bodyDisplacementPercentile,
      eBar.bodyDisplacementPercentile,
      `${id}.bars[${String(i)}].bodyDisplacementPercentile`,
    );
    expect(aBar.absorptionTriggered).toBe(eBar.absorptionTriggered);
    expect(aBar.absorbingSide).toBe(eBar.absorbingSide);
    assertMatchedLevelsClose(aBar.matchedLevels, eBar.matchedLevels, `${id}.bars[${String(i)}].matchedLevels`);
  }

  expect(actual.absorptionEvents).toHaveLength(exp.absorptionEvents.length);
  for (let i = 0; i < exp.absorptionEvents.length; i += 1) {
    const aEvt = actual.absorptionEvents[i];
    const eEvt = exp.absorptionEvents[i];
    if (aEvt === undefined || eEvt === undefined) {
      throw new Error(`${id}.absorptionEvents[${String(i)}] undefined`);
    }
    expect(aEvt.time).toBe(eEvt.time);
    expect(aEvt.sessionDate).toBe(eEvt.sessionDate);
    expect(aEvt.deltaMode).toBe(eEvt.deltaMode);
    expect(aEvt.absorbingSide).toBe(eEvt.absorbingSide);
    assertCloseOrNaN(aEvt.barDelta, eEvt.barDelta, `${id}.events[${String(i)}].barDelta`);
    assertCloseOrNaN(aEvt.sessionCvd, eEvt.sessionCvd, `${id}.events[${String(i)}].sessionCvd`);
    assertCloseOrNaN(aEvt.volumePercentile, eEvt.volumePercentile, `${id}.events[${String(i)}].volumePercentile`);
    assertCloseOrNaN(aEvt.deltaPercentile, eEvt.deltaPercentile, `${id}.events[${String(i)}].deltaPercentile`);
    assertCloseOrNaN(
      aEvt.bodyDisplacementPercentile,
      eEvt.bodyDisplacementPercentile,
      `${id}.events[${String(i)}].bodyDisplacementPercentile`,
    );
    expect(aEvt.primaryLevel.name).toBe(eEvt.primaryLevel.name);
    assertCloseOrNaN(aEvt.primaryLevel.distance, eEvt.primaryLevel.distance, `${id}.events[${String(i)}].primaryLevel.distance`);
    assertMatchedLevelsClose(aEvt.matchedLevels, eEvt.matchedLevels, `${id}.events[${String(i)}].matchedLevels`);
  }
}

function assertMtfResultsIdentical(a: MtfStructureResult, b: MtfStructureResult): void {
  expect(a.asOfUtcSec).toBe(b.asOfUtcSec);
  expect(a.closed1dCount).toBe(b.closed1dCount);
  expect(a.closed4hCount).toBe(b.closed4hCount);
  expect(a.closed15mCount).toBe(b.closed15mCount);
  expect(a.closed5mCount).toBe(b.closed5mCount);
  expect(a.regime1d).toBe(b.regime1d);
  expect(a.aligned4h).toBe(b.aligned4h);
  expect(a.effectiveMacroRegime).toBe(b.effectiveMacroRegime);
  expect(a.pullback15mInZone).toBe(b.pullback15mInZone);
  expect(a.absorption15m).toBe(b.absorption15m);
  expect(a.executionTriggerActive).toBe(b.executionTriggerActive);
  expect(a.setupStatus).toBe(b.setupStatus);

  const nums: ReadonlyArray<readonly [number, number]> = [
    [a.close1d, b.close1d],
    [a.sma200_1d, b.sma200_1d],
    [a.atr14_1d, b.atr14_1d],
    [a.distSma200Pct, b.distSma200Pct],
    [a.distSma200Atr, b.distSma200Atr],
    [a.close4h, b.close4h],
    [a.sma50_4h, b.sma50_4h],
    [a.close15m, b.close15m],
    [a.ema21_15m, b.ema21_15m],
    [a.atr14_15m, b.atr14_15m],
    [a.pullback15mDistance, b.pullback15mDistance],
    [a.wickToBodyRatio15m, b.wickToBodyRatio15m],
    [a.volume15mPercentile, b.volume15mPercentile],
    [a.close5m, b.close5m],
    [a.hma55, b.hma55],
    [a.hma55Prev, b.hma55Prev],
    [a.hma55Prev2, b.hma55Prev2],
    [a.hma55Slope, b.hma55Slope],
    [a.hma55SlopePrev, b.hma55SlopePrev],
  ];
  for (const [x, y] of nums) {
    expect(Object.is(x, y)).toBe(true);
  }
}

describe('Pieza 10 — Multi-Timeframe Cascade Structure & CVD Passive Absorption', () => {
  afterAll(() => {
    console.info(
      `[mtfCvd.test] Fixture precision summary: ${String(comparedScalars)} scalars checked, ` +
        `maxAbsDiff=${maxObservedAbsDiff.toExponential(3)}, maxRelDiff=${maxObservedRelDiff.toExponential(3)} ` +
        `(limit < ${String(TOLERANCE)})`,
    );
  });

  it('matches Python primitive series (SMA, WMA, HMA 55, Wilder ATR 14) strictly < 1e-11', () => {
    const prim = FIXTURE.primitives;
    const frozenBars = deepFreeze(hydrateBars(prim.bars));
    const closes = deepFreeze(frozenBars.map((b) => b.close));

    assertSeriesClose(computeSmaSeries(closes, 10), prim.sma10, 'primitives.sma10');
    assertSeriesClose(computeWmaSeries(closes, 10), prim.wma10, 'primitives.wma10');
    const hma55 = computeHmaSeries(closes, 55);
    assertSeriesClose(hma55, prim.hma55, 'primitives.hma55');
    // Verify exact 61-bar warmup (indices 0..59 NaN, index 60 finite)
    expect(hma55.slice(0, 60).every((v) => Number.isNaN(v))).toBe(true);
    expect(Number.isFinite(hma55[60])).toBe(true);

    assertSeriesClose(computeWilderAtrSeries(frozenBars, 14), prim.wilderAtr14, 'primitives.wilderAtr14');
  });

  it.each(FIXTURE.mtfScenarios)(
    'matches Python MTF cascade reference for $id (< 1e-11) without mutating frozen inputs',
    (scenario) => {
      const frozenInputs: MtfStructureInputs = deepFreeze({
        bars1d: hydrateBars(scenario.inputs.bars1d),
        bars4h: hydrateBars(scenario.inputs.bars4h),
        bars15m: hydrateBars(scenario.inputs.bars15m),
        bars5m: hydrateBars(scenario.inputs.bars5m),
      });
      const frozenOpts = deepFreeze(hydrateMtfOptions(scenario.options));

      const actual = evaluateMtfStructure(frozenInputs, frozenOpts);
      assertMtfMatchesFixture(actual, scenario.expected, scenario.id);
    },
  );

  it.each(FIXTURE.cvdScenarios)(
    'matches Python CVD & Absorption reference for $id (< 1e-11) without mutating frozen inputs',
    (scenario) => {
      const frozenBars = deepFreeze(hydrateCvdBars(scenario.bars));
      const frozenOpts = deepFreeze(hydrateCvdOptions(scenario.options));

      const actual = analyzeCvdAndAbsorption(frozenBars, frozenOpts);
      assertCvdMatchesFixture(actual, scenario.expected, scenario.id);
    },
  );

  it('enforces zero look-ahead bias across both evaluateMtfStructure and analyzeCvdAndAbsorption', () => {
    const mtfBull = FIXTURE.mtfScenarios[0];
    const cvdWall = FIXTURE.cvdScenarios[0];
    if (mtfBull === undefined || cvdWall === undefined) {
      throw new Error('Missing expected base scenarios in fixture');
    }

    const baseMtfInputs = {
      bars1d: hydrateBars(mtfBull.inputs.bars1d),
      bars4h: hydrateBars(mtfBull.inputs.bars4h),
      bars15m: hydrateBars(mtfBull.inputs.bars15m),
      bars5m: hydrateBars(mtfBull.inputs.bars5m),
    };
    const mtfOpts = deepFreeze(hydrateMtfOptions(mtfBull.options));
    const mtfBaseline = evaluateMtfStructure(deepFreeze(baseMtfInputs), mtfOpts);

    const poisonFuture = (bars: readonly Bar[], sec: number): Bar[] =>
      bars.map((b) =>
        b.time + sec > mtfOpts.asOfUtcSec
          ? { ...b, open: 100, high: 9999, low: 1, close: 10, volume: 99_999_999 }
          : b,
      );

    const poisonedMtf = evaluateMtfStructure(
      deepFreeze({
        bars1d: poisonFuture(baseMtfInputs.bars1d, 86400),
        bars4h: poisonFuture(baseMtfInputs.bars4h, 14400),
        bars15m: poisonFuture(baseMtfInputs.bars15m, 900),
        bars5m: poisonFuture(baseMtfInputs.bars5m, 300),
      }),
      mtfOpts,
    );
    expect(poisonedMtf.excludedFuture5mCount).toBeGreaterThan(0);
    assertMtfResultsIdentical(poisonedMtf, mtfBaseline);

    // CVD zero look-ahead check
    const baseCvdBars = hydrateCvdBars(cvdWall.bars);
    const cvdOpts = deepFreeze(hydrateCvdOptions(cvdWall.options));
    const cvdBaseline = analyzeCvdAndAbsorption(deepFreeze(baseCvdBars), cvdOpts);
    const strippedCvd = analyzeCvdAndAbsorption(
      deepFreeze(baseCvdBars.filter((b) => b.time + cvdOpts.barSeconds <= cvdOpts.asOfUtcSec)),
      cvdOpts,
    );
    expect(cvdBaseline.excludedFutureCount).toBe(2);
    expect(strippedCvd.excludedFutureCount).toBe(0);
    expect(strippedCvd.currentSessionCvd).toBe(cvdBaseline.currentSessionCvd);
    expect(strippedCvd.bars).toEqual(cvdBaseline.bars);
    expect(strippedCvd.absorptionEvents).toEqual(cvdBaseline.absorptionEvents);
  });

  it('detects strict HMA(55) reversal turn after 15m EMA(21) pullback while blocking deceleration and ties', () => {
    const mtfBull = FIXTURE.mtfScenarios[0];
    if (mtfBull === undefined) {
      throw new Error('Missing mtf_bullish_active_trigger_est scenario');
    }

    const asOf = mtfBull.options.asOfUtcSec;
    const baseInputs = {
      bars1d: hydrateBars(mtfBull.inputs.bars1d),
      bars4h: hydrateBars(mtfBull.inputs.bars4h),
      bars15m: hydrateBars(mtfBull.inputs.bars15m),
    };

    // Build 5m curve shaped cleanly to cross HMA(55) slope from negative (<= 0) to positive (> 0)
    const turn5m: Bar[] = [];
    const totalBars = 70;
    const t0 = asOf - totalBars * 300;
    for (let i = 0; i < totalBars; i += 1) {
      let c: number;
      if (i < 60) {
        c = 595.0 - 0.12 * i;
      } else if (i < 67) {
        c = 587.8 - 0.1 * (i - 60);
      } else if (i === 67) {
        c = 587.15;
      } else if (i === 68) {
        c = 587.15;
      } else {
        c = 591.5; // inflection pushing hma55Slope > 0 while hma55SlopePrev < 0
      }
      turn5m.push({
        time: t0 + i * 300,
        open: c - 0.1,
        high: c + 0.2,
        low: c - 0.2,
        close: c,
        volume: 50_000,
      });
    }

    const hmaTurnSeries = computeHmaSeries(
      turn5m.map((b) => b.close),
      55,
    );
    const n = hmaTurnSeries.length;
    const sCurr = (hmaTurnSeries[n - 1] ?? Number.NaN) - (hmaTurnSeries[n - 2] ?? Number.NaN);
    const sPrev = (hmaTurnSeries[n - 2] ?? Number.NaN) - (hmaTurnSeries[n - 3] ?? Number.NaN);
    expect(sPrev).toBeLessThan(0);
    expect(sCurr).toBeGreaterThan(0);

    const turnResult = evaluateMtfStructure(
      deepFreeze({ ...baseInputs, bars5m: turn5m }),
      { asOfUtcSec: asOf },
    );
    expect(turnResult.hma55SlopePrev).toBeLessThan(0);
    expect(turnResult.hma55Slope).toBeGreaterThan(0);
    expect(turnResult.executionTriggerActive).toBe(true);
    expect(turnResult.setupStatus).toBe('ACTIVE_BULLISH');

    // Now test deceleration (positive slope smaller than previous positive slope -> STANDBY)
    const decel5m: Bar[] = [];
    for (let i = 0; i < totalBars; i += 1) {
      const c = i < 68 ? 580.0 + 0.35 * i : 603.8 + 0.02 * (i - 68);
      decel5m.push({
        time: t0 + i * 300,
        open: c - 0.05,
        high: c + 0.2,
        low: c - 0.2,
        close: c,
        volume: 50_000,
      });
    }
    const decelResult = evaluateMtfStructure(
      deepFreeze({ ...baseInputs, bars5m: decel5m }),
      { asOfUtcSec: asOf },
    );
    expect(decelResult.hma55Slope).toBeGreaterThan(0);
    expect(decelResult.hma55Slope).toBeLessThan(decelResult.hma55SlopePrev);
    expect(decelResult.executionTriggerActive).toBe(false);
    expect(decelResult.setupStatus).toBe('STANDBY');

    // Exact 1D tie close1d === sma200_1d -> CONFLICTED_NO_SETUP
    const flat1d: Bar[] = Array.from({ length: 200 }, (_, i) => ({
      time: asOf - (201 - i) * 86400,
      open: 500,
      high: 502,
      low: 498,
      close: 500,
      volume: 1_000_000,
    }));
    const tieResult = evaluateMtfStructure(
      deepFreeze({
        bars1d: flat1d,
        bars4h: baseInputs.bars4h,
        bars15m: baseInputs.bars15m,
        bars5m: turn5m,
      }),
      { asOfUtcSec: asOf },
    );
    expect(tieResult.regime1d).toBe('CONFLICTED_NO_SETUP');
    expect(tieResult.aligned4h).toBe(false);
    expect(tieResult.effectiveMacroRegime).toBe('CONFLICTED_NO_SETUP');
    expect(tieResult.setupStatus).toBe('CONFLICTED_NO_SETUP');
  });

  it('propagates explicit NaN tick volume in CVD until next session reset without falling back to CLV', () => {
    const tDay1 = 1768487400; // 2026-01-15 09:30 EST
    const tDay2 = 1768573800; // 2026-01-16 09:30 EST
    const bars: CvdBar[] = [
      { time: tDay1, open: 100, high: 102, low: 99, close: 101.5, volume: 1000, buyVolume: 700, sellVolume: 300 },
      { time: tDay1 + 300, open: 101.5, high: 103, low: 101, close: 102.5, volume: 800, buyVolume: Number.NaN, sellVolume: 200 },
      { time: tDay1 + 600, open: 102.5, high: 103, low: 102, close: 102.8, volume: 500, buyVolume: 400, sellVolume: 100 },
      { time: tDay2, open: 103, high: 104, low: 102.5, close: 103.8, volume: 900, buyVolume: 650, sellVolume: 250 },
    ];

    const res = analyzeCvdAndAbsorption(deepFreeze(bars), {
      asOfUtcSec: tDay2 + 600,
      barSeconds: 300,
      sessionScope: 'RTH',
      atr: 1.0,
      levels: [{ name: 'PMH', price: 103.0 }],
    });

    expect(res.sessionDeltaModes).toHaveLength(2);
    expect(res.sessionDeltaModes[0]?.deltaMode).toBe('TICK_EXACT');
    expect(Number.isNaN(res.sessionDeltaModes[0]?.finalSessionCvd)).toBe(true);
    expect(res.bars[0]?.sessionCvd).toBe(400);
    expect(Number.isNaN(res.bars[1]?.barDelta)).toBe(true);
    expect(Number.isNaN(res.bars[1]?.sessionCvd)).toBe(true);
    expect(Number.isNaN(res.bars[2]?.sessionCvd)).toBe(true);

    // Next session resets cleanly and resumes TICK_EXACT accumulation
    expect(res.sessionDeltaModes[1]?.deltaMode).toBe('TICK_EXACT');
    expect(res.bars[3]?.sessionCvd).toBe(400);
    expect(res.currentSessionCvd).toBe(400);
  });

  it('rejects millisecond timestamps, out-of-order bars, negative volumes, inverted OHLC, and invalid options', () => {
    const t0 = 1768487400;
    const validBar: CvdBar = {
      time: t0,
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      volume: 100,
      buyVolume: 60,
      sellVolume: 40,
    };

    expect(() =>
      evaluateMtfStructure(
        {
          bars1d: [{ ...validBar, time: t0 * 1000 }],
          bars4h: [],
          bars15m: [],
          bars5m: [],
        },
        { asOfUtcSec: t0 + 900 },
      ),
    ).toThrow(/UTC seconds/);

    expect(() =>
      evaluateMtfStructure(
        { bars1d: [validBar], bars4h: [], bars15m: [], bars5m: [] },
        { asOfUtcSec: t0 * 1000 },
      ),
    ).toThrow(/UTC seconds/);

    expect(() =>
      evaluateMtfStructure(
        { bars1d: [validBar, validBar], bars4h: [], bars15m: [], bars5m: [] },
        { asOfUtcSec: t0 + 90000 },
      ),
    ).toThrow(/strictly increasing/);

    expect(() =>
      analyzeCvdAndAbsorption([validBar], {
        asOfUtcSec: t0 + 300,
        barSeconds: 300,
        levels: [{ name: 'PMH', price: 100 }],
      }),
    ).toThrow(/atr.*levelProximityPct/);

    expect(() =>
      analyzeCvdAndAbsorption([validBar], {
        asOfUtcSec: t0 + 300,
        barSeconds: 300,
        atr: 1.0,
        levelProximityAtr: 0.15,
        levelProximityPct: 0.001,
        levels: [{ name: 'PMH', price: 100 }],
      }),
    ).toThrow(/both/);

    expect(() =>
      analyzeCvdAndAbsorption([{ ...validBar, buyVolume: -5 }], {
        asOfUtcSec: t0 + 300,
        barSeconds: 300,
        atr: 1.0,
        levels: [],
      }),
    ).toThrow(/buyVolume/);

    expect(() =>
      analyzeCvdAndAbsorption([{ ...validBar, high: 98, low: 99 }], {
        asOfUtcSec: t0 + 300,
        barSeconds: 300,
        atr: 1.0,
        levels: [],
      }),
    ).toThrow(/lower than low/);

    expect(() => computeEmpiricalPercentile([], 10)).not.toThrow();
    expect(Number.isNaN(computeEmpiricalPercentile([], 10))).toBe(true);
    expect(computeEmpiricalPercentile([5, 5, 5], 5)).toBe(50);
  });
});
