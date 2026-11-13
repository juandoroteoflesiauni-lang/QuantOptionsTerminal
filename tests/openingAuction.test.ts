import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  computeOvernightVolumeProfile,
  detectMacro0830Spike,
  evaluateOpeningAuction,
} from '../src/core/microstructure/openingAuction.js';
import type {
  BalanceType,
  InitialBalanceClassification,
  InventoryRiskType,
  MicrostructureBar,
  OpeningAuctionOptions,
  OpeningAuctionResult,
  OpeningDirection,
  OpeningType,
  OvernightVolumeBin,
} from '../src/core/microstructure/types.js';

type FixtureScalar = number | 'NaN';

interface RawBarFixture {
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly vw?: number;
  readonly delta?: FixtureScalar;
}

interface StandaloneProfileFixture {
  readonly bars: readonly RawBarFixture[];
  readonly tickSize: number;
  readonly valueAreaPct: number;
  readonly expected: {
    readonly pmh: FixtureScalar;
    readonly pml: FixtureScalar;
    readonly onPoc: FixtureScalar;
    readonly onVah: FixtureScalar;
    readonly onVal: FixtureScalar;
    readonly preMarketVwap: FixtureScalar;
    readonly totalVolume: FixtureScalar;
    readonly valueAreaVolume: FixtureScalar;
    readonly valueAreaCoverage: FixtureScalar;
    readonly bins: readonly { readonly price: number; readonly volume: number }[];
  };
}

interface RawOptionsFixture {
  readonly asOfUtcSec: number;
  readonly barSeconds: number;
  readonly sessionDate?: string;
  readonly prevRthClose?: FixtureScalar;
  readonly prevRthHigh?: FixtureScalar;
  readonly prevRthLow?: FixtureScalar;
  readonly atr14d?: FixtureScalar;
  readonly expectedWindowVolume?: FixtureScalar;
  readonly tickSize?: number;
  readonly valueAreaPct?: number;
}

interface ScenarioExpectedFixture {
  readonly sessionDate: string;
  readonly asOfUtcSec: number;
  readonly preMarketBarCount: number;
  readonly rthBarCount: number;
  readonly excludedFutureBarCount: number;
  readonly pmh: FixtureScalar;
  readonly pml: FixtureScalar;
  readonly onPoc: FixtureScalar;
  readonly onVah: FixtureScalar;
  readonly onVal: FixtureScalar;
  readonly preMarketVwap: FixtureScalar;
  readonly referencePrice: FixtureScalar;
  readonly open0930: FixtureScalar;
  readonly currentClose: FixtureScalar;
  readonly sessionVwap: FixtureScalar;
  readonly trueGap: FixtureScalar;
  readonly trueGapAtr: FixtureScalar;
  readonly macro0830Detected: boolean;
  readonly macro0830High: FixtureScalar;
  readonly macro0830Low: FixtureScalar;
  readonly medianPreMarketRange: FixtureScalar;
  readonly medianPreMarketVolume: FixtureScalar;
  readonly balanceType: BalanceType;
  readonly rthCumVolume: FixtureScalar;
  readonly openingRvol: FixtureScalar;
  readonly lowImmediateReversalProb: boolean;
  readonly pctVolumeAbovePrevClose: FixtureScalar;
  readonly pctVolumeBelowPrevClose: FixtureScalar;
  readonly cumulativeRthDelta: FixtureScalar;
  readonly inventoryRisk: InventoryRiskType;
  readonly statisticalTargets: readonly number[];
  readonly openingType: OpeningType;
  readonly openingDirection: OpeningDirection;
  readonly openCrossCount: number;
  readonly vwapCrossCount: number;
  readonly ibh: FixtureScalar;
  readonly ibl: FixtureScalar;
  readonly ibWidth: FixtureScalar;
  readonly ibWidthAtr: FixtureScalar;
  readonly ibClassification: InitialBalanceClassification;
}

interface ScenarioFixture {
  readonly id: string;
  readonly bars: readonly RawBarFixture[];
  readonly options: RawOptionsFixture;
  readonly expected: ScenarioExpectedFixture;
}

interface OpeningAuctionFixtureFile {
  readonly meta: {
    readonly generator: string;
    readonly command: string;
    readonly precisionTolerance: number;
  };
  readonly standaloneProfile: StandaloneProfileFixture;
  readonly scenarios: readonly ScenarioFixture[];
}

const FIXTURE_PATH = resolve(process.cwd(), 'fixtures/opening_auction_reference.json');
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as OpeningAuctionFixtureFile;
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
  expect(absDiff, `${label}: absDiff=${String(absDiff)} exceeded ${String(TOLERANCE * scale)}`).toBeLessThanOrEqual(
    TOLERANCE * scale,
  );
}

function hydrateBars(raws: readonly RawBarFixture[]): MicrostructureBar[] {
  return raws.map((b) => {
    const out: {
      time: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
      vw?: number;
      delta?: number;
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
    if (b.delta !== undefined) {
      out.delta = decodeScalar(b.delta);
    }
    return out;
  });
}

function hydrateOptions(raw: RawOptionsFixture): OpeningAuctionOptions {
  const out: {
    asOfUtcSec: number;
    barSeconds: number;
    sessionDate?: string;
    prevRthClose?: number;
    prevRthHigh?: number;
    prevRthLow?: number;
    atr14d?: number;
    expectedWindowVolume?: number;
    tickSize?: number;
    valueAreaPct?: number;
  } = {
    asOfUtcSec: raw.asOfUtcSec,
    barSeconds: raw.barSeconds,
  };
  if (raw.sessionDate !== undefined) {
    out.sessionDate = raw.sessionDate;
  }
  if (raw.prevRthClose !== undefined) {
    out.prevRthClose = decodeScalar(raw.prevRthClose);
  }
  if (raw.prevRthHigh !== undefined) {
    out.prevRthHigh = decodeScalar(raw.prevRthHigh);
  }
  if (raw.prevRthLow !== undefined) {
    out.prevRthLow = decodeScalar(raw.prevRthLow);
  }
  if (raw.atr14d !== undefined) {
    out.atr14d = decodeScalar(raw.atr14d);
  }
  if (raw.expectedWindowVolume !== undefined) {
    out.expectedWindowVolume = decodeScalar(raw.expectedWindowVolume);
  }
  if (raw.tickSize !== undefined) {
    out.tickSize = raw.tickSize;
  }
  if (raw.valueAreaPct !== undefined) {
    out.valueAreaPct = raw.valueAreaPct;
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

function assertAuctionResultIdentical(actual: OpeningAuctionResult, expected: OpeningAuctionResult): void {
  expect(actual.sessionDate).toBe(expected.sessionDate);
  expect(actual.asOfUtcSec).toBe(expected.asOfUtcSec);
  expect(actual.preMarketBarCount).toBe(expected.preMarketBarCount);
  expect(actual.rthBarCount).toBe(expected.rthBarCount);
  expect(actual.balanceType).toBe(expected.balanceType);
  expect(actual.macro0830Detected).toBe(expected.macro0830Detected);
  expect(actual.lowImmediateReversalProb).toBe(expected.lowImmediateReversalProb);
  expect(actual.inventoryRisk).toBe(expected.inventoryRisk);
  expect(actual.openingType).toBe(expected.openingType);
  expect(actual.openingDirection).toBe(expected.openingDirection);
  expect(actual.openCrossCount).toBe(expected.openCrossCount);
  expect(actual.vwapCrossCount).toBe(expected.vwapCrossCount);
  expect(actual.ibClassification).toBe(expected.ibClassification);
  expect(actual.statisticalTargets).toEqual(expected.statisticalTargets);

  const numericPairs: ReadonlyArray<readonly [number, number]> = [
    [actual.pmh, expected.pmh],
    [actual.pml, expected.pml],
    [actual.onPoc, expected.onPoc],
    [actual.onVah, expected.onVah],
    [actual.onVal, expected.onVal],
    [actual.preMarketVwap, expected.preMarketVwap],
    [actual.referencePrice, expected.referencePrice],
    [actual.open0930, expected.open0930],
    [actual.currentClose, expected.currentClose],
    [actual.sessionVwap, expected.sessionVwap],
    [actual.trueGap, expected.trueGap],
    [actual.trueGapAtr, expected.trueGapAtr],
    [actual.macro0830High, expected.macro0830High],
    [actual.macro0830Low, expected.macro0830Low],
    [actual.medianPreMarketRange, expected.medianPreMarketRange],
    [actual.medianPreMarketVolume, expected.medianPreMarketVolume],
    [actual.rthCumVolume, expected.rthCumVolume],
    [actual.openingRvol, expected.openingRvol],
    [actual.pctVolumeAbovePrevClose, expected.pctVolumeAbovePrevClose],
    [actual.pctVolumeBelowPrevClose, expected.pctVolumeBelowPrevClose],
    [actual.cumulativeRthDelta, expected.cumulativeRthDelta],
    [actual.ibh, expected.ibh],
    [actual.ibl, expected.ibl],
    [actual.ibWidth, expected.ibWidth],
    [actual.ibWidthAtr, expected.ibWidthAtr],
  ];
  for (const [a, e] of numericPairs) {
    expect(Object.is(a, e)).toBe(true);
  }
}

function assertBinClose(actual: OvernightVolumeBin | undefined, expected: { price: number; volume: number }, label: string): void {
  if (actual === undefined) {
    throw new Error(`${label}: missing bin`);
  }
  assertCloseOrNaN(actual.price, expected.price, `${label}.price`);
  assertCloseOrNaN(actual.volume, expected.volume, `${label}.volume`);
}

function assertAuctionMatchesFixture(actual: OpeningAuctionResult, exp: ScenarioExpectedFixture, id: string): void {
  expect(actual.sessionDate, `${id}.sessionDate`).toBe(exp.sessionDate);
  expect(actual.asOfUtcSec, `${id}.asOfUtcSec`).toBe(exp.asOfUtcSec);
  expect(actual.preMarketBarCount, `${id}.preMarketBarCount`).toBe(exp.preMarketBarCount);
  expect(actual.rthBarCount, `${id}.rthBarCount`).toBe(exp.rthBarCount);
  expect(actual.excludedFutureBarCount, `${id}.excludedFutureBarCount`).toBe(exp.excludedFutureBarCount);

  assertCloseOrNaN(actual.pmh, exp.pmh, `${id}.pmh`);
  assertCloseOrNaN(actual.pml, exp.pml, `${id}.pml`);
  assertCloseOrNaN(actual.onPoc, exp.onPoc, `${id}.onPoc`);
  assertCloseOrNaN(actual.onVah, exp.onVah, `${id}.onVah`);
  assertCloseOrNaN(actual.onVal, exp.onVal, `${id}.onVal`);
  assertCloseOrNaN(actual.preMarketVwap, exp.preMarketVwap, `${id}.preMarketVwap`);

  // Verify consistency between top-level summary fields and nested overnightVolumeProfile
  assertCloseOrNaN(actual.overnightVolumeProfile.pmh, exp.pmh, `${id}.profile.pmh`);
  assertCloseOrNaN(actual.overnightVolumeProfile.pml, exp.pml, `${id}.profile.pml`);
  assertCloseOrNaN(actual.overnightVolumeProfile.onPoc, exp.onPoc, `${id}.profile.onPoc`);
  assertCloseOrNaN(actual.overnightVolumeProfile.onVah, exp.onVah, `${id}.profile.onVah`);
  assertCloseOrNaN(actual.overnightVolumeProfile.onVal, exp.onVal, `${id}.profile.onVal`);
  assertCloseOrNaN(actual.overnightVolumeProfile.preMarketVwap, exp.preMarketVwap, `${id}.profile.preMarketVwap`);

  assertCloseOrNaN(actual.referencePrice, exp.referencePrice, `${id}.referencePrice`);
  assertCloseOrNaN(actual.open0930, exp.open0930, `${id}.open0930`);
  assertCloseOrNaN(actual.currentClose, exp.currentClose, `${id}.currentClose`);
  assertCloseOrNaN(actual.sessionVwap, exp.sessionVwap, `${id}.sessionVwap`);
  assertCloseOrNaN(actual.trueGap, exp.trueGap, `${id}.trueGap`);
  assertCloseOrNaN(actual.trueGapAtr, exp.trueGapAtr, `${id}.trueGapAtr`);

  expect(actual.macro0830Detected, `${id}.macro0830Detected`).toBe(exp.macro0830Detected);
  assertCloseOrNaN(actual.macro0830High, exp.macro0830High, `${id}.macro0830High`);
  assertCloseOrNaN(actual.macro0830Low, exp.macro0830Low, `${id}.macro0830Low`);
  assertCloseOrNaN(actual.medianPreMarketRange, exp.medianPreMarketRange, `${id}.medianPreMarketRange`);
  assertCloseOrNaN(actual.medianPreMarketVolume, exp.medianPreMarketVolume, `${id}.medianPreMarketVolume`);

  expect(actual.balanceType, `${id}.balanceType`).toBe(exp.balanceType);
  assertCloseOrNaN(actual.rthCumVolume, exp.rthCumVolume, `${id}.rthCumVolume`);
  assertCloseOrNaN(actual.openingRvol, exp.openingRvol, `${id}.openingRvol`);
  expect(actual.lowImmediateReversalProb, `${id}.lowImmediateReversalProb`).toBe(exp.lowImmediateReversalProb);
  assertCloseOrNaN(actual.pctVolumeAbovePrevClose, exp.pctVolumeAbovePrevClose, `${id}.pctVolumeAbovePrevClose`);
  assertCloseOrNaN(actual.pctVolumeBelowPrevClose, exp.pctVolumeBelowPrevClose, `${id}.pctVolumeBelowPrevClose`);
  assertCloseOrNaN(actual.cumulativeRthDelta, exp.cumulativeRthDelta, `${id}.cumulativeRthDelta`);
  expect(actual.inventoryRisk, `${id}.inventoryRisk`).toBe(exp.inventoryRisk);

  expect(actual.statisticalTargets, `${id}.statisticalTargets length`).toHaveLength(exp.statisticalTargets.length);
  for (let i = 0; i < exp.statisticalTargets.length; i += 1) {
    const aTarget = actual.statisticalTargets[i];
    const eTarget = exp.statisticalTargets[i];
    if (aTarget === undefined || eTarget === undefined) {
      throw new Error(`${id}.statisticalTargets[${String(i)}] undefined`);
    }
    assertCloseOrNaN(aTarget, eTarget, `${id}.statisticalTargets[${String(i)}]`);
  }

  expect(actual.openingType, `${id}.openingType`).toBe(exp.openingType);
  expect(actual.openingDirection, `${id}.openingDirection`).toBe(exp.openingDirection);
  expect(actual.openCrossCount, `${id}.openCrossCount`).toBe(exp.openCrossCount);
  expect(actual.vwapCrossCount, `${id}.vwapCrossCount`).toBe(exp.vwapCrossCount);

  assertCloseOrNaN(actual.ibh, exp.ibh, `${id}.ibh`);
  assertCloseOrNaN(actual.ibl, exp.ibl, `${id}.ibl`);
  assertCloseOrNaN(actual.ibWidth, exp.ibWidth, `${id}.ibWidth`);
  assertCloseOrNaN(actual.ibWidthAtr, exp.ibWidthAtr, `${id}.ibWidthAtr`);
  expect(actual.ibClassification, `${id}.ibClassification`).toBe(exp.ibClassification);
}

describe('Pieza 9 — Opening Auction & Pre-Market Microstructure (04:00 - 10:30 ET)', () => {
  afterAll(() => {
    console.info(
      `[openingAuction.test] Fixture precision summary: ${String(comparedScalars)} scalars checked, ` +
        `maxAbsDiff=${maxObservedAbsDiff.toExponential(3)}, maxRelDiff=${maxObservedRelDiff.toExponential(3)} ` +
        `(limit <= ${String(TOLERANCE)})`,
    );
  });

  it('matches standalone Python overnight volume profile within 1e-9 without mutating frozen inputs', () => {
    const sp = FIXTURE.standaloneProfile;
    const frozenBars = deepFreeze(hydrateBars(sp.bars));
    const frozenOpts = deepFreeze({ tickSize: sp.tickSize, valueAreaPct: sp.valueAreaPct });

    const actual = computeOvernightVolumeProfile(frozenBars, frozenOpts);

    assertCloseOrNaN(actual.pmh, sp.expected.pmh, 'standalone.pmh');
    assertCloseOrNaN(actual.pml, sp.expected.pml, 'standalone.pml');
    assertCloseOrNaN(actual.onPoc, sp.expected.onPoc, 'standalone.onPoc');
    assertCloseOrNaN(actual.onVah, sp.expected.onVah, 'standalone.onVah');
    assertCloseOrNaN(actual.onVal, sp.expected.onVal, 'standalone.onVal');
    assertCloseOrNaN(actual.preMarketVwap, sp.expected.preMarketVwap, 'standalone.preMarketVwap');
    assertCloseOrNaN(actual.totalVolume, sp.expected.totalVolume, 'standalone.totalVolume');
    assertCloseOrNaN(actual.valueAreaVolume, sp.expected.valueAreaVolume, 'standalone.valueAreaVolume');
    assertCloseOrNaN(actual.valueAreaCoverage, sp.expected.valueAreaCoverage, 'standalone.valueAreaCoverage');

    expect(actual.bins).toHaveLength(sp.expected.bins.length);
    for (let i = 0; i < sp.expected.bins.length; i += 1) {
      const expectedBin = sp.expected.bins[i];
      if (expectedBin === undefined) {
        throw new Error(`Missing expected bin ${String(i)}`);
      }
      assertBinClose(actual.bins[i], expectedBin, `standalone.bins[${String(i)}]`);
    }
  });

  it.each(FIXTURE.scenarios)('matches Python reference fixture for scenario $id (tol <= 1e-9)', (scenario) => {
    const frozenBars = deepFreeze(hydrateBars(scenario.bars));
    const frozenOpts = deepFreeze(hydrateOptions(scenario.options));

    const actual = evaluateOpeningAuction(frozenBars, frozenOpts);
    assertAuctionMatchesFixture(actual, scenario.expected, scenario.id);
  });

  it('enforces strict no-look-ahead bias: mutating or omitting bars with close > asOfUtcSec leaves metrics invariant', () => {
    const scenarioE = FIXTURE.scenarios.find((s) => s.id === 'scenario_e_no_lookahead_0945_pending_ib');
    if (scenarioE === undefined) {
      throw new Error('scenario_e_no_lookahead_0945_pending_ib missing from fixture');
    }

    const baseBars = hydrateBars(scenarioE.bars);
    const opts = deepFreeze(hydrateOptions(scenarioE.options));
    const baseline = evaluateOpeningAuction(deepFreeze(baseBars), opts);

    // Poison every future bar whose close > asOfUtcSec with extreme prices & volumes
    const poisonedBars = baseBars.map((b) =>
      b.time + opts.barSeconds > opts.asOfUtcSec
        ? {
            ...b,
            open: 999.0,
            high: 1500.0,
            low: 100.0,
            close: 1400.0,
            volume: 9_999_999,
            delta: -9_999_999,
          }
        : b,
    );
    const poisonedResult = evaluateOpeningAuction(deepFreeze(poisonedBars), opts);
    expect(poisonedResult.excludedFutureBarCount).toBe(baseline.excludedFutureBarCount);
    expect(poisonedResult.excludedFutureBarCount).toBeGreaterThan(0);
    assertAuctionResultIdentical(poisonedResult, baseline);

    // Strip all future bars completely
    const truncatedBars = baseBars.filter((b) => b.time + opts.barSeconds <= opts.asOfUtcSec);
    const truncatedResult = evaluateOpeningAuction(deepFreeze(truncatedBars), opts);
    expect(truncatedResult.excludedFutureBarCount).toBe(0);
    assertAuctionResultIdentical(truncatedResult, baseline);
  });

  it('keeps 08:30 ET macro spike baseline strictly free of post-08:30 look-ahead', () => {
    // 2026-01-15 EST: 08:00 ET = 13:00 UTC = 1768482000; 08:30 ET = 13:30 UTC = 1768483800
    const t0800 = 1768482000;
    const preBars: MicrostructureBar[] = [
      { time: t0800, open: 100.0, high: 100.2, low: 99.8, close: 100.1, volume: 100 },
      { time: t0800 + 300, open: 100.1, high: 100.3, low: 99.9, close: 100.2, volume: 120 },
      { time: t0800 + 600, open: 100.2, high: 100.4, low: 100.0, close: 100.1, volume: 110 },
      // 08:30 ET spike bar
      { time: t0800 + 1800, open: 100.1, high: 102.0, low: 99.5, close: 101.8, volume: 1200 },
    ];

    const baseline = detectMacro0830Spike(deepFreeze(preBars), 300);
    expect(baseline.detected).toBe(true);
    expect(baseline.high).toBe(102.0);
    expect(baseline.low).toBe(99.5);
    expect(baseline.medianPreMarketRange).toBeCloseTo(0.4, 12);
    expect(baseline.medianPreMarketVolume).toBeCloseTo(110, 12);

    // Adding massive 08:35+ / 09:00 bars must not inflate the baseline medians used at 08:30
    const withPost0830Bars: MicrostructureBar[] = [
      ...preBars,
      { time: t0800 + 2100, open: 101.8, high: 110.0, low: 90.0, close: 105.0, volume: 500_000 },
      { time: t0800 + 2400, open: 105.0, high: 112.0, low: 91.0, close: 106.0, volume: 600_000 },
    ];
    const withFuture = detectMacro0830Spike(deepFreeze(withPost0830Bars), 300);
    expect(withFuture).toEqual(baseline);

    // Without prior <08:30 bars, median cannot be inferred -> detected=false & NaN
    const spikeOnly = preBars[3];
    if (spikeOnly === undefined) {
      throw new Error('spikeOnly missing');
    }
    const noPrior = detectMacro0830Spike(deepFreeze([spikeOnly]), 300);
    expect(noPrior.detected).toBe(false);
    expect(Number.isNaN(noPrior.high)).toBe(true);
    expect(Number.isNaN(noPrior.low)).toBe(true);
    expect(Number.isNaN(noPrior.medianPreMarketRange)).toBe(true);
    expect(Number.isNaN(noPrior.medianPreMarketVolume)).toBe(true);
  });

  it('returns PENDING_OPEN and PENDING_IB before the first 09:30 ET bar has closed', () => {
    // 2026-01-15 EST: 09:30 ET = 1768487400. If barSeconds=300, first RTH bar closes at 1768487700.
    const t0800 = 1768482000;
    const t0930 = 1768487400;
    const bars: MicrostructureBar[] = [
      { time: t0800, open: 500.0, high: 500.5, low: 499.5, close: 500.2, volume: 1000 },
      { time: t0930, open: 500.2, high: 503.0, low: 500.0, close: 502.8, volume: 80_000 },
    ];

    const res = evaluateOpeningAuction(deepFreeze(bars), {
      asOfUtcSec: t0930 + 120, // 09:32:00 ET (first 5m bar not yet closed)
      barSeconds: 300,
      prevRthClose: 498.0,
      prevRthHigh: 499.0,
      prevRthLow: 496.0,
      atr14d: 4.0,
      expectedWindowVolume: 100_000,
    });

    expect(res.preMarketBarCount).toBe(1);
    expect(res.rthBarCount).toBe(0);
    expect(res.excludedFutureBarCount).toBe(1);
    expect(res.openingType).toBe('PENDING_OPEN');
    expect(res.openingDirection).toBe('NEUTRAL');
    expect(res.ibClassification).toBe('PENDING_IB');
    expect(res.balanceType).toBe('OUT_OF_BALANCE');
    expect(Number.isNaN(res.open0930)).toBe(true);
    expect(Number.isNaN(res.sessionVwap)).toBe(true);
    expect(Number.isNaN(res.openingRvol)).toBe(true);
    expect(Number.isNaN(res.cumulativeRthDelta)).toBe(true);
    expect(Number.isNaN(res.ibh)).toBe(true);
    expect(Number.isNaN(res.ibl)).toBe(true);
  });

  it('handles 1-minute (barSeconds=60) bars accurately across EST and EDT transitions and freezes IB after 10:30 ET', () => {
    // 2026-04-14 is EDT (UTC-4): 09:30 ET = 13:30 UTC = 1776173400; 10:30 ET = 14:30 UTC = 1776177000
    const pmStartEdt = 1776173400 - 300; // 09:25 ET
    const rthStartEdt = 1776173400; // 09:30 ET
    const bars: MicrostructureBar[] = [];

    // 5 pre-market 1m bars
    for (let i = 0; i < 5; i += 1) {
      bars.push({
        time: pmStartEdt + i * 60,
        open: 200.0,
        high: 200.5,
        low: 199.5,
        close: 200.1,
        volume: 500,
      });
    }
    // 60 IB 1m bars [09:30, 10:30)
    for (let i = 0; i < 60; i += 1) {
      bars.push({
        time: rthStartEdt + i * 60,
        open: 200.2,
        high: i === 15 ? 202.0 : 201.0,
        low: i === 45 ? 199.8 : 200.0,
        close: 200.8,
        volume: 2000,
      });
    }
    // Post-IB bar [10:30, 10:31) must NOT widen IBH/IBL when evaluating at 11:00 ET
    bars.push({
      time: rthStartEdt + 3600,
      open: 201.0,
      high: 210.0,
      low: 190.0,
      close: 205.0,
      volume: 10_000,
    });

    const at1100 = evaluateOpeningAuction(deepFreeze(bars), {
      asOfUtcSec: rthStartEdt + 5400, // 11:00 ET
      barSeconds: 60,
      prevRthClose: 200.0,
      prevRthHigh: 201.0,
      prevRthLow: 198.5,
      atr14d: 5.0,
      expectedWindowVolume: 100_000,
    });

    expect(at1100.sessionDate).toBe('2026-04-14');
    expect(at1100.preMarketBarCount).toBe(5);
    expect(at1100.rthBarCount).toBe(61);
    expect(at1100.ibh).toBe(202.0);
    expect(at1100.ibl).toBe(199.8);
    expect(at1100.ibWidth).toBeCloseTo(2.2, 12);
    expect(at1100.ibWidthAtr).toBeCloseTo(2.2 / 5.0, 12); // 0.44 -> NORMAL_IB
    expect(at1100.ibClassification).toBe('NORMAL_IB');
    expect(at1100.currentClose).toBe(205.0);
  });

  it('respects explicit bar.delta, uses CLV fallback cleanly, and degrades to NaN when explicit delta is NaN', () => {
    const t0930 = 1768487400; // 2026-01-15 09:30 EST
    const bars: MicrostructureBar[] = [
      // explicit delta overrides CLV
      { time: t0930, open: 100, high: 102, low: 100, close: 102, volume: 1000, delta: -400 },
      // CLV fallback: vol=500, close==low -> -500
      { time: t0930 + 300, open: 102, high: 102, low: 100, close: 100, volume: 500 },
      // high===low -> 0 contribution under CLV
      { time: t0930 + 600, open: 100, high: 100, low: 100, close: 100, volume: 200 },
    ];
    const ok = evaluateOpeningAuction(deepFreeze(bars), {
      asOfUtcSec: t0930 + 900,
      barSeconds: 300,
      atr14d: 3.0,
    });
    expect(ok.cumulativeRthDelta).toBeCloseTo(-900, 12);

    // Explicit NaN delta must propagate NaN without silent fallback
    const firstBar = bars[0];
    const secondBar = bars[1];
    if (firstBar === undefined || secondBar === undefined) {
      throw new Error('Missing bar');
    }
    const badDeltaBars: MicrostructureBar[] = [
      firstBar,
      { ...secondBar, delta: Number.NaN },
    ];
    const bad = evaluateOpeningAuction(deepFreeze(badDeltaBars), {
      asOfUtcSec: t0930 + 900,
      barSeconds: 300,
    });
    expect(Number.isNaN(bad.cumulativeRthDelta)).toBe(true);
  });

  it('handles Initial Balance boundary thresholds, single-bin zero-range profiles, and missing previous-session levels', () => {
    // Single-bin zero-range profile
    const single = computeOvernightVolumeProfile(
      deepFreeze([{ time: 1768482000, open: 150, high: 150, low: 150, close: 150, volume: 400 }]),
      { tickSize: 0.05 },
    );
    expect(single.onPoc).toBe(150);
    expect(single.onVah).toBe(150);
    expect(single.onVal).toBe(150);
    expect(single.valueAreaCoverage).toBe(1);
    expect(single.bins).toEqual([{ price: 150, volume: 400 }]);

    // Missing prevRthHigh / prevRthLow -> INSUFFICIENT_DATA, NaN gap without fallback
    const t0930 = 1768487400;
    const t1030 = t0930 + 3600;
    const rthAt0930 = (high: number, low: number): MicrostructureBar[] => [
      { time: t0930, open: 100, high, low, close: 100, volume: 1000 },
    ];

    const missingPrev = evaluateOpeningAuction(deepFreeze(rthAt0930(135, 100)), {
      asOfUtcSec: t1030,
      barSeconds: 300,
      atr14d: 100,
    });
    expect(missingPrev.balanceType).toBe('INSUFFICIENT_DATA');
    expect(Number.isNaN(missingPrev.trueGap)).toBe(true);
    expect(missingPrev.ibWidthAtr).toBe(0.35);
    expect(missingPrev.ibClassification).toBe('NORMAL_IB'); // inclusive at 0.35

    const narrow = evaluateOpeningAuction(deepFreeze(rthAt0930(134, 100)), {
      asOfUtcSec: t1030,
      barSeconds: 300,
      atr14d: 100,
    });
    expect(narrow.ibClassification).toBe('NARROW_IB_EXPANSION_ALERT');

    const at080 = evaluateOpeningAuction(deepFreeze(rthAt0930(180, 100)), {
      asOfUtcSec: t1030,
      barSeconds: 300,
      atr14d: 100,
    });
    expect(at080.ibWidthAtr).toBe(0.8);
    expect(at080.ibClassification).toBe('NORMAL_IB'); // inclusive at 0.80

    const wide = evaluateOpeningAuction(deepFreeze(rthAt0930(181, 100)), {
      asOfUtcSec: t1030,
      barSeconds: 300,
      atr14d: 100,
    });
    expect(wide.ibClassification).toBe('WIDE_IB_CONSOLIDATION_BIAS');
  });

  it('rejects millisecond timestamps, non-divisor barSeconds, negative volume, inverted OHLC, and invalid profile options', () => {
    const validTime = 1768482000;
    const validBar: MicrostructureBar = {
      time: validTime,
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      volume: 10,
    };

    // Milliseconds rejected in bar.time and asOfUtcSec
    expect(() =>
      evaluateOpeningAuction([{ ...validBar, time: validTime * 1000 }], {
        asOfUtcSec: validTime + 300,
        barSeconds: 300,
      }),
    ).toThrow(/segundos UTC|time/i);

    expect(() =>
      evaluateOpeningAuction([validBar], {
        asOfUtcSec: (validTime + 300) * 1000,
        barSeconds: 300,
      }),
    ).toThrow(/segundos UTC|asOfUtcSec/i);

    // Invalid barSeconds (must divide 1800)
    for (const badBarSec of [0, -60, 47, 700, 3600, 300.5]) {
      expect(() =>
        evaluateOpeningAuction([validBar], { asOfUtcSec: validTime + 600, barSeconds: badBarSec }),
      ).toThrow(/barSeconds/);
    }

    // Duplicate timestamp throws explicit error
    expect(() =>
      evaluateOpeningAuction([validBar, validBar], { asOfUtcSec: validTime + 600, barSeconds: 300 }),
    ).toThrow(/Duplicate/);

    // Out-of-order input bars are handled deterministically without mutating frozen input
    const bar2: MicrostructureBar = { ...validBar, time: validTime + 300, close: 100.8 };
    const orderedRes = evaluateOpeningAuction(deepFreeze([validBar, bar2]), {
      asOfUtcSec: validTime + 600,
      barSeconds: 300,
    });
    const reversedRes = evaluateOpeningAuction(deepFreeze([bar2, validBar]), {
      asOfUtcSec: validTime + 600,
      barSeconds: 300,
    });
    assertAuctionResultIdentical(reversedRes, orderedRes);

    // Mixed sessions rejected in detectMacro0830Spike
    expect(() =>
      detectMacro0830Spike([validBar, { ...validBar, time: validTime + 86400 }], 300),
    ).toThrow(/single-session/);

    expect(() =>
      evaluateOpeningAuction([{ ...validBar, volume: -1 }], { asOfUtcSec: validTime + 600, barSeconds: 300 }),
    ).toThrow(/volume/);

    expect(() =>
      evaluateOpeningAuction([{ ...validBar, high: 98, low: 99 }], { asOfUtcSec: validTime + 600, barSeconds: 300 }),
    ).toThrow(/OHLC|high/);

    // Invalid profile / spike parameters
    expect(() => computeOvernightVolumeProfile([validBar], { tickSize: 0 })).toThrow(/tickSize/);
    expect(() => computeOvernightVolumeProfile([validBar], { tickSize: 0.05, valueAreaPct: 1.5 })).toThrow(
      /valueAreaPct/,
    );
    expect(() => detectMacro0830Spike([validBar], 47)).toThrow(/barSeconds/);
  });
});
