import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  detectFreshOrderBlocks,
  detectQuantitativeFvgs,
  type FobAnchorSource,
  type FobDirection,
  type FreshOrderBlockResult,
  type FvgDirection,
  type InstitutionalFlowBar,
  type QuantitativeFvgResult,
} from '../src/core/microstructure/fvgFobEngine.js';
import {
  classifyTradesLeeReady,
  computeL1BookImbalance,
  type ClassificationRule,
  type ExecutionVenueType,
  type L1BookImbalanceResult,
  type LeeReadyClassificationResult,
  type LeeReadyQuoteInput,
  type LeeReadyTradeInput,
  type TradeAggressorSide,
} from '../src/core/microstructure/leeReadyBook.js';
import {
  computeVolumeProfileAmt,
  trackNakedPocs,
  type NakedPocRecord,
  type TrackNakedPocsResult,
  type VolumeNodeClassification,
  type VolumeProfileAmtResult,
} from '../src/core/microstructure/volumeProfileAmt.js';
import type { Bar } from '../src/core/types.js';

type FixtureScalar = number | 'NaN';

interface RawBarFixture extends Bar {
  readonly delta?: number;
  readonly buyVolume?: number;
  readonly sellVolume?: number;
  readonly darkPoolVolume?: number;
  readonly exchange?: number;
  readonly internalPoc?: number;
}

interface RawVolumeProfileBinExpected {
  readonly price: number;
  readonly volume: number;
  readonly volumeShare: number;
  readonly volumePercentile: number;
  readonly classification: VolumeNodeClassification;
}

interface RawVolumeProfileExpected {
  readonly status: 'OK' | 'NO_DATA';
  readonly asOfUtcSec: number;
  readonly barSeconds: number;
  readonly tickSize: number;
  readonly closedBarCount: number;
  readonly excludedFutureCount: number;
  readonly minPrice: number;
  readonly maxPrice: number;
  readonly poc: number;
  readonly vah: number;
  readonly val: number;
  readonly profileVwap: number;
  readonly totalVolume: number;
  readonly valueAreaVolume: number;
  readonly valueAreaCoverage: number;
  readonly bins: readonly RawVolumeProfileBinExpected[];
  readonly hvnBins: readonly RawVolumeProfileBinExpected[];
  readonly lvnBins: readonly RawVolumeProfileBinExpected[];
}

interface RawNakedPocsExpected {
  readonly status: 'OK' | 'NO_DATA';
  readonly asOfUtcSec: number;
  readonly barSeconds: number;
  readonly tickSize: number;
  readonly touchTolerance: number;
  readonly closedBarCount: number;
  readonly excludedFutureCount: number;
  readonly sessions: readonly NakedPocRecord[];
  readonly activeNakedPocs: readonly NakedPocRecord[];
}

interface RawFvgRecordExpected {
  readonly id: string;
  readonly type: FvgDirection;
  readonly formedAtTime: number;
  readonly displacementTime: number;
  readonly gapLow: number;
  readonly gapHigh: number;
  readonly gapWidth: number;
  readonly consequentEncroachment: number;
  readonly rangeZScore: number;
  readonly lvnPercentile: number;
  readonly averageGapBinVolume: number;
  readonly barDelta: number;
  readonly deltaImbalanceRatio: number;
  readonly fillPct: number;
  readonly ceTouched: boolean;
  readonly ceTouchTime: number | null;
  readonly fullFillTime: number | null;
  readonly isMitigated: boolean;
  readonly mitigatedAtTime: number | null;
}

interface RawFvgExpected {
  readonly status: 'OK' | 'NO_DATA';
  readonly asOfUtcSec: number;
  readonly barSeconds: number;
  readonly tickSize: number;
  readonly closedBarCount: number;
  readonly excludedFutureCount: number;
  readonly fvgs: readonly RawFvgRecordExpected[];
  readonly activeFvgs: readonly RawFvgRecordExpected[];
}

interface RawFobRecordExpected {
  readonly id: string;
  readonly type: FobDirection;
  readonly baseTime: number;
  readonly formedAtTime: number;
  readonly zoneLow: number;
  readonly zoneHigh: number;
  readonly anchorPrice: FixtureScalar;
  readonly anchorSource: FobAnchorSource;
  readonly displacementZScore: number;
  readonly brokenSwingLevel: number;
  readonly baseDelta: number;
  readonly baseVolumePercentile: number;
  readonly darkPoolVolume: number;
  readonly darkPoolShare: number;
  readonly absorptionDivergence: boolean;
  readonly highVolumeAbsorption: boolean;
  readonly darkPoolFootprint: boolean;
  readonly isFresh: boolean;
  readonly touchCount: number;
  readonly firstTouchTime: number | null;
  readonly perforated: boolean;
  readonly isMitigated: boolean;
  readonly mitigatedAtTime: number | null;
}

interface RawFobExpected {
  readonly status: 'OK' | 'NO_DATA';
  readonly asOfUtcSec: number;
  readonly barSeconds: number;
  readonly closedBarCount: number;
  readonly excludedFutureCount: number;
  readonly orderBlocks: readonly RawFobRecordExpected[];
  readonly freshOrderBlocks: readonly RawFobRecordExpected[];
}

interface RawClassifiedTradeExpected {
  readonly timestamp: number;
  readonly price: number;
  readonly size: number;
  readonly side: TradeAggressorSide;
  readonly sign: 1 | -1 | 0;
  readonly rule: ClassificationRule;
  readonly venue: ExecutionVenueType;
  readonly matchedBid: FixtureScalar;
  readonly matchedAsk: FixtureScalar;
  readonly matchedMidpoint: FixtureScalar;
}

interface RawLeeReadyExpected {
  readonly status: 'OK' | 'NO_DATA';
  readonly tradeCount: number;
  readonly validQuoteCount: number;
  readonly litBuyVolume: number;
  readonly litSellVolume: number;
  readonly litUndeterminedVolume: number;
  readonly darkPoolBuyVolume: number;
  readonly darkPoolSellVolume: number;
  readonly darkPoolUndeterminedVolume: number;
  readonly totalBuyVolume: number;
  readonly totalSellVolume: number;
  readonly undeterminedVolume: number;
  readonly totalDarkPoolVolume: number;
  readonly totalLitVolume: number;
  readonly totalVolume: number;
  readonly darkPoolShare: number;
  readonly netCvd: number;
  readonly classifiedTrades: readonly RawClassifiedTradeExpected[];
}

interface RawL1Expected {
  readonly status: 'OK' | 'NO_DATA';
  readonly midpoint: number;
  readonly spread: number;
  readonly spreadBps: number;
  readonly imbalance: number;
  readonly microprice: number;
}

interface Piece15Fixture {
  readonly volumeProfileAmtScenario: {
    readonly bars: readonly RawBarFixture[];
    readonly options: {
      readonly asOfUtcSec: number;
      readonly barSeconds: number;
      readonly tickSize: number;
    };
    readonly expected: RawVolumeProfileExpected;
  };
  readonly nakedPocsScenario: {
    readonly bars: readonly RawBarFixture[];
    readonly earlyOptions: {
      readonly asOfUtcSec: number;
      readonly barSeconds: number;
      readonly tickSize: number;
      readonly touchTolerance: number;
    };
    readonly lateOptions: {
      readonly asOfUtcSec: number;
      readonly barSeconds: number;
      readonly tickSize: number;
      readonly touchTolerance: number;
    };
    readonly earlyExpected: RawNakedPocsExpected;
    readonly lateExpected: RawNakedPocsExpected;
  };
  readonly quantitativeFvgsScenario: {
    readonly bars: readonly RawBarFixture[];
    readonly tickSize: number;
    readonly barSeconds: number;
    readonly beforeFormationAsOf: number;
    readonly partialAsOf: number;
    readonly fullAsOf: number;
    readonly beforeFormationFullFillExpected: RawFvgExpected;
    readonly partialFullFillExpected: RawFvgExpected;
    readonly partialCeModeExpected: RawFvgExpected;
    readonly fullFillExpected: RawFvgExpected;
    readonly ceModeExpected: RawFvgExpected;
  };
  readonly freshOrderBlocksScenario: {
    readonly bars: readonly RawBarFixture[];
    readonly barSeconds: number;
    readonly freshAsOf: number;
    readonly firstTouchAsOf: number;
    readonly finalAsOf: number;
    readonly freshExpected: RawFobExpected;
    readonly firstTouchExpected: RawFobExpected;
    readonly finalExpected: RawFobExpected;
  };
  readonly leeReadyAndBookScenario: {
    readonly trades: readonly LeeReadyTradeInput[];
    readonly quotes: readonly LeeReadyQuoteInput[];
    readonly strictExpected: RawLeeReadyExpected;
    readonly tickFallbackExpected: RawLeeReadyExpected;
    readonly l1BookCases: readonly {
      readonly input: {
        readonly bidPrice: number;
        readonly askPrice: number;
        readonly bidSize: number;
        readonly askSize: number;
      };
      readonly expected: RawL1Expected;
    }[];
  };
}

const TOLERANCE = 1e-11;

function loadFixture(): Piece15Fixture {
  const path = resolve(process.cwd(), 'fixtures', 'amt_fvg_leeready_reference.json');
  return JSON.parse(readFileSync(path, 'utf8')) as Piece15Fixture;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
  } else {
    for (const prop of Object.values(value as Record<string, unknown>)) {
      deepFreeze(prop);
    }
  }
  return value;
}

const tracker = {
  checked: 0,
  maxAbsDiff: 0,
  maxRelDiff: 0,
};

function assertScalarMatch(actual: number, expected: FixtureScalar, label: string): void {
  if (expected === 'NaN') {
    expect(Number.isNaN(actual), `${label} should be NaN`).toBe(true);
    tracker.checked += 1;
    return;
  }
  expect(Number.isFinite(actual), `${label} expected ${String(expected)}`).toBe(true);
  const absDiff = Math.abs(actual - expected);
  const relDiff = Math.abs(expected) > 1e-12 ? absDiff / Math.abs(expected) : absDiff;
  tracker.checked += 1;
  if (absDiff > tracker.maxAbsDiff) {
    tracker.maxAbsDiff = absDiff;
  }
  if (relDiff > tracker.maxRelDiff) {
    tracker.maxRelDiff = relDiff;
  }
  expect(absDiff, `${label} absDiff=${String(absDiff)}`).toBeLessThan(TOLERANCE);
}

function assertNakedPocsMatch(
  actual: TrackNakedPocsResult,
  expected: RawNakedPocsExpected,
  tag: string,
): void {
  expect(actual.status).toBe(expected.status);
  expect(actual.closedBarCount).toBe(expected.closedBarCount);
  expect(actual.excludedFutureCount).toBe(expected.excludedFutureCount);
  expect(actual.sessions.length).toBe(expected.sessions.length);
  expect(actual.activeNakedPocs.length).toBe(expected.activeNakedPocs.length);

  for (let i = 0; i < expected.sessions.length; i += 1) {
    const a = actual.sessions[i];
    const e = expected.sessions[i];
    expect(a).toBeDefined();
    expect(e).toBeDefined();
    if (!a || !e) continue;
    expect(a.sessionDate).toBe(e.sessionDate);
    expect(a.isNaked).toBe(e.isNaked);
    expect(a.isMitigated).toBe(e.isMitigated);
    expect(a.testedAtTime).toBe(e.testedAtTime);
    expect(a.mitigatedAtTime).toBe(e.mitigatedAtTime);
    expect(a.testedSessionDate).toBe(e.testedSessionDate);
    assertScalarMatch(a.sessionPoc, e.sessionPoc, `${tag}.sessions[${String(i)}].poc`);
    assertScalarMatch(a.sessionVah, e.sessionVah, `${tag}.sessions[${String(i)}].vah`);
    assertScalarMatch(a.sessionVal, e.sessionVal, `${tag}.sessions[${String(i)}].val`);
    assertScalarMatch(a.sessionVolume, e.sessionVolume, `${tag}.sessions[${String(i)}].vol`);
  }
}

function assertFvgsMatch(
  actual: QuantitativeFvgResult,
  expected: RawFvgExpected,
  tag: string,
): void {
  expect(actual.status).toBe(expected.status);
  expect(actual.closedBarCount).toBe(expected.closedBarCount);
  expect(actual.excludedFutureCount).toBe(expected.excludedFutureCount);
  expect(actual.fvgs.length).toBe(expected.fvgs.length);
  expect(actual.activeFvgs.length).toBe(expected.activeFvgs.length);

  for (let i = 0; i < expected.fvgs.length; i += 1) {
    const a = actual.fvgs[i];
    const e = expected.fvgs[i];
    expect(a).toBeDefined();
    expect(e).toBeDefined();
    if (!a || !e) continue;
    expect(a.id).toBe(e.id);
    expect(a.type).toBe(e.type);
    expect(a.formedAtTime).toBe(e.formedAtTime);
    expect(a.displacementTime).toBe(e.displacementTime);
    expect(a.ceTouched).toBe(e.ceTouched);
    expect(a.ceTouchTime).toBe(e.ceTouchTime);
    expect(a.fullFillTime).toBe(e.fullFillTime);
    expect(a.isMitigated).toBe(e.isMitigated);
    expect(a.mitigatedAtTime).toBe(e.mitigatedAtTime);
    assertScalarMatch(a.gapLow, e.gapLow, `${tag}.fvgs[${String(i)}].gapLow`);
    assertScalarMatch(a.gapHigh, e.gapHigh, `${tag}.fvgs[${String(i)}].gapHigh`);
    assertScalarMatch(
      a.consequentEncroachment,
      e.consequentEncroachment,
      `${tag}.fvgs[${String(i)}].ce`,
    );
    assertScalarMatch(a.rangeZScore, e.rangeZScore, `${tag}.fvgs[${String(i)}].z`);
    assertScalarMatch(a.lvnPercentile, e.lvnPercentile, `${tag}.fvgs[${String(i)}].lvnPct`);
    assertScalarMatch(
      a.averageGapBinVolume,
      e.averageGapBinVolume,
      `${tag}.fvgs[${String(i)}].avgGapBinVol`,
    );
    assertScalarMatch(a.barDelta, e.barDelta, `${tag}.fvgs[${String(i)}].barDelta`);
    assertScalarMatch(
      a.deltaImbalanceRatio,
      e.deltaImbalanceRatio,
      `${tag}.fvgs[${String(i)}].deltaRatio`,
    );
    assertScalarMatch(a.fillPct, e.fillPct, `${tag}.fvgs[${String(i)}].fillPct`);
  }
}

function assertFobsMatch(
  actual: FreshOrderBlockResult,
  expected: RawFobExpected,
  tag: string,
): void {
  expect(actual.status).toBe(expected.status);
  expect(actual.closedBarCount).toBe(expected.closedBarCount);
  expect(actual.excludedFutureCount).toBe(expected.excludedFutureCount);
  expect(actual.orderBlocks.length).toBe(expected.orderBlocks.length);
  expect(actual.freshOrderBlocks.length).toBe(expected.freshOrderBlocks.length);

  for (let i = 0; i < expected.orderBlocks.length; i += 1) {
    const a = actual.orderBlocks[i];
    const e = expected.orderBlocks[i];
    expect(a).toBeDefined();
    expect(e).toBeDefined();
    if (!a || !e) continue;
    expect(a.id).toBe(e.id);
    expect(a.type).toBe(e.type);
    expect(a.baseTime).toBe(e.baseTime);
    expect(a.formedAtTime).toBe(e.formedAtTime);
    expect(a.anchorSource).toBe(e.anchorSource);
    expect(a.absorptionDivergence).toBe(e.absorptionDivergence);
    expect(a.highVolumeAbsorption).toBe(e.highVolumeAbsorption);
    expect(a.darkPoolFootprint).toBe(e.darkPoolFootprint);
    expect(a.isFresh).toBe(e.isFresh);
    expect(a.touchCount).toBe(e.touchCount);
    expect(a.firstTouchTime).toBe(e.firstTouchTime);
    expect(a.perforated).toBe(e.perforated);
    expect(a.isMitigated).toBe(e.isMitigated);
    expect(a.mitigatedAtTime).toBe(e.mitigatedAtTime);
    assertScalarMatch(a.zoneLow, e.zoneLow, `${tag}.ob[${String(i)}].zoneLow`);
    assertScalarMatch(a.zoneHigh, e.zoneHigh, `${tag}.ob[${String(i)}].zoneHigh`);
    assertScalarMatch(a.anchorPrice, e.anchorPrice, `${tag}.ob[${String(i)}].anchorPrice`);
    assertScalarMatch(
      a.displacementZScore,
      e.displacementZScore,
      `${tag}.ob[${String(i)}].dispZ`,
    );
    assertScalarMatch(
      a.brokenSwingLevel,
      e.brokenSwingLevel,
      `${tag}.ob[${String(i)}].swing`,
    );
    assertScalarMatch(a.baseDelta, e.baseDelta, `${tag}.ob[${String(i)}].delta`);
    assertScalarMatch(
      a.baseVolumePercentile,
      e.baseVolumePercentile,
      `${tag}.ob[${String(i)}].volPct`,
    );
    assertScalarMatch(a.darkPoolVolume, e.darkPoolVolume, `${tag}.ob[${String(i)}].dpVol`);
    assertScalarMatch(a.darkPoolShare, e.darkPoolShare, `${tag}.ob[${String(i)}].dpShare`);
  }
}

function assertLeeReadyMatches(
  actual: LeeReadyClassificationResult,
  expected: RawLeeReadyExpected,
  tag: string,
): void {
  expect(actual.status).toBe(expected.status);
  expect(actual.tradeCount).toBe(expected.tradeCount);
  expect(actual.validQuoteCount).toBe(expected.validQuoteCount);
  assertScalarMatch(actual.litBuyVolume, expected.litBuyVolume, `${tag}.litBuy`);
  assertScalarMatch(actual.litSellVolume, expected.litSellVolume, `${tag}.litSell`);
  assertScalarMatch(
    actual.litUndeterminedVolume,
    expected.litUndeterminedVolume,
    `${tag}.litUndet`,
  );
  assertScalarMatch(actual.darkPoolBuyVolume, expected.darkPoolBuyVolume, `${tag}.dpBuy`);
  assertScalarMatch(actual.darkPoolSellVolume, expected.darkPoolSellVolume, `${tag}.dpSell`);
  assertScalarMatch(
    actual.darkPoolUndeterminedVolume,
    expected.darkPoolUndeterminedVolume,
    `${tag}.dpUndet`,
  );
  assertScalarMatch(actual.totalBuyVolume, expected.totalBuyVolume, `${tag}.totalBuy`);
  assertScalarMatch(actual.totalSellVolume, expected.totalSellVolume, `${tag}.totalSell`);
  assertScalarMatch(actual.undeterminedVolume, expected.undeterminedVolume, `${tag}.undet`);
  assertScalarMatch(actual.totalDarkPoolVolume, expected.totalDarkPoolVolume, `${tag}.totalDp`);
  assertScalarMatch(actual.totalLitVolume, expected.totalLitVolume, `${tag}.totalLit`);
  assertScalarMatch(actual.totalVolume, expected.totalVolume, `${tag}.totalVol`);
  assertScalarMatch(actual.darkPoolShare, expected.darkPoolShare, `${tag}.dpShare`);
  assertScalarMatch(actual.netCvd, expected.netCvd, `${tag}.netCvd`);

  expect(actual.classifiedTrades.length).toBe(expected.classifiedTrades.length);
  for (let i = 0; i < expected.classifiedTrades.length; i += 1) {
    const a = actual.classifiedTrades[i];
    const e = expected.classifiedTrades[i];
    expect(a).toBeDefined();
    expect(e).toBeDefined();
    if (!a || !e) continue;
    expect(a.timestamp).toBe(e.timestamp);
    expect(a.side).toBe(e.side);
    expect(a.sign).toBe(e.sign);
    expect(a.rule).toBe(e.rule);
    expect(a.venue).toBe(e.venue);
    assertScalarMatch(a.matchedBid, e.matchedBid, `${tag}.trades[${String(i)}].bid`);
    assertScalarMatch(a.matchedAsk, e.matchedAsk, `${tag}.trades[${String(i)}].ask`);
    assertScalarMatch(a.matchedMidpoint, e.matchedMidpoint, `${tag}.trades[${String(i)}].mid`);
  }
}

describe('Pieza 15 — AMT Volume Profile / Naked POCs, Quantitative FVG / FOB & Lee-Ready / L1 Book', () => {
  const fixture = deepFreeze(loadFixture());

  afterAll(() => {
    console.log(
      `[amtFvgLeeReady.test] Fixture precision summary: ${String(tracker.checked)} scalars checked, maxAbsDiff=${tracker.maxAbsDiff.toExponential(3)}, maxRelDiff=${tracker.maxRelDiff.toExponential(3)} (limit < ${TOLERANCE.toExponential(0)})`,
    );
  });

  it('Scenario 1: computeVolumeProfileAmt matches Python reference (< 1e-11), classifies HVN/LVN & excludes future bar', () => {
    const { bars, options, expected } = fixture.volumeProfileAmtScenario;
    const actual: VolumeProfileAmtResult = computeVolumeProfileAmt(bars, options);

    expect(actual.status).toBe(expected.status);
    expect(actual.closedBarCount).toBe(expected.closedBarCount);
    expect(actual.excludedFutureCount).toBe(expected.excludedFutureCount);
    assertScalarMatch(actual.minPrice, expected.minPrice, 'vp.minPrice');
    assertScalarMatch(actual.maxPrice, expected.maxPrice, 'vp.maxPrice');
    assertScalarMatch(actual.poc, expected.poc, 'vp.poc');
    assertScalarMatch(actual.vah, expected.vah, 'vp.vah');
    assertScalarMatch(actual.val, expected.val, 'vp.val');
    assertScalarMatch(actual.profileVwap, expected.profileVwap, 'vp.profileVwap');
    assertScalarMatch(actual.totalVolume, expected.totalVolume, 'vp.totalVolume');
    assertScalarMatch(actual.valueAreaVolume, expected.valueAreaVolume, 'vp.vaVol');
    assertScalarMatch(actual.valueAreaCoverage, expected.valueAreaCoverage, 'vp.vaCov');

    expect(actual.bins.length).toBe(expected.bins.length);
    for (let i = 0; i < expected.bins.length; i += 1) {
      const ab = actual.bins[i];
      const eb = expected.bins[i];
      expect(ab).toBeDefined();
      expect(eb).toBeDefined();
      if (!ab || !eb) continue;
      expect(ab.classification).toBe(eb.classification);
      assertScalarMatch(ab.price, eb.price, `vp.bins[${String(i)}].price`);
      assertScalarMatch(ab.volume, eb.volume, `vp.bins[${String(i)}].volume`);
      assertScalarMatch(ab.volumeShare, eb.volumeShare, `vp.bins[${String(i)}].share`);
      assertScalarMatch(ab.volumePercentile, eb.volumePercentile, `vp.bins[${String(i)}].pct`);
    }

    expect(actual.hvnBins.length).toBe(expected.hvnBins.length);
    expect(actual.lvnBins.length).toBe(expected.lvnBins.length);
    expect(actual.hvnBins.every((b) => b.classification === 'HVN')).toBe(true);
    expect(actual.lvnBins.every((b) => b.classification === 'LVN')).toBe(true);
  });

  it('Scenario 2: trackNakedPocs matches multi-session ET fixture without look-ahead bias on early vs late asOf', () => {
    const { bars, earlyOptions, lateOptions, earlyExpected, lateExpected } =
      fixture.nakedPocsScenario;

    const earlyActual = trackNakedPocs(bars, earlyOptions);
    assertNakedPocsMatch(earlyActual, earlyExpected, 'npoc.early');

    const lateActual = trackNakedPocs(bars, lateOptions);
    assertNakedPocsMatch(lateActual, lateExpected, 'npoc.late');

    // Session 2 (index 1) was naked at earlyAsOf and mitigated at lateAsOf
    expect(earlyActual.sessions[1]?.isNaked).toBe(true);
    expect(earlyActual.sessions[1]?.testedAtTime).toBeNull();
    expect(lateActual.sessions[1]?.isNaked).toBe(false);
    expect(lateActual.sessions[1]?.testedSessionDate).toBe('2026-03-05');

    // Session 1 (index 0) remains naked at lateAsOf because future unclosed bar is excluded
    expect(lateActual.sessions[0]?.isNaked).toBe(true);
  });

  it('Scenario 3: detectQuantitativeFvgs enforces Z-score + LVN + delta imbalance, zero look-ahead before bar i closes, and CE vs FULL_FILL modes', () => {
    const sc = fixture.quantitativeFvgsScenario;

    const beforeActual = detectQuantitativeFvgs(sc.bars, {
      asOfUtcSec: sc.beforeFormationAsOf,
      barSeconds: sc.barSeconds,
      tickSize: sc.tickSize,
      mitigationMode: 'FULL_FILL',
    });
    assertFvgsMatch(beforeActual, sc.beforeFormationFullFillExpected, 'fvg.before');
    expect(beforeActual.fvgs.length).toBe(0);

    const partialFullActual = detectQuantitativeFvgs(sc.bars, {
      asOfUtcSec: sc.partialAsOf,
      barSeconds: sc.barSeconds,
      tickSize: sc.tickSize,
      mitigationMode: 'FULL_FILL',
    });
    assertFvgsMatch(partialFullActual, sc.partialFullFillExpected, 'fvg.partialFull');
    expect(partialFullActual.fvgs[0]?.isMitigated).toBe(false);
    expect(partialFullActual.fvgs[0]?.ceTouched).toBe(true);

    const partialCeActual = detectQuantitativeFvgs(sc.bars, {
      asOfUtcSec: sc.partialAsOf,
      barSeconds: sc.barSeconds,
      tickSize: sc.tickSize,
      mitigationMode: 'CONSEQUENT_ENCROACHMENT',
    });
    assertFvgsMatch(partialCeActual, sc.partialCeModeExpected, 'fvg.partialCe');
    expect(partialCeActual.fvgs[0]?.isMitigated).toBe(true);

    const fullActual = detectQuantitativeFvgs(sc.bars, {
      asOfUtcSec: sc.fullAsOf,
      barSeconds: sc.barSeconds,
      tickSize: sc.tickSize,
      mitigationMode: 'FULL_FILL',
    });
    assertFvgsMatch(fullActual, sc.fullFillExpected, 'fvg.full');
    expect(fullActual.fvgs.length).toBe(2);
    expect(fullActual.fvgs[0]?.type).toBe('BULLISH_FVG');
    expect(fullActual.fvgs[0]?.isMitigated).toBe(true);
    expect(fullActual.fvgs[1]?.type).toBe('BEARISH_FVG');
    expect(fullActual.fvgs[1]?.isMitigated).toBe(false);

    const ceActual = detectQuantitativeFvgs(sc.bars, {
      asOfUtcSec: sc.fullAsOf,
      barSeconds: sc.barSeconds,
      tickSize: sc.tickSize,
      mitigationMode: 'CONSEQUENT_ENCROACHMENT',
    });
    assertFvgsMatch(ceActual, sc.ceModeExpected, 'fvg.ce');
  });

  it('Scenario 4: detectFreshOrderBlocks tracks absorption + FINRA TRF footprint, exact anchor, and isFresh -> 1st touch -> mitigated lifecycle', () => {
    const sc = fixture.freshOrderBlocksScenario;
    const baseBarTime = sc.bars[20]?.time ?? 0;
    const dispBarTime = sc.bars[21]?.time ?? 0;

    // Look-ahead check: before displacement bar 21 closes, no FOB may exist yet!
    const preDisp = detectFreshOrderBlocks(sc.bars, {
      asOfUtcSec: dispBarTime,
      barSeconds: sc.barSeconds,
    });
    expect(preDisp.orderBlocks.length).toBe(0);
    expect(baseBarTime).toBeLessThan(dispBarTime);

    const freshActual = detectFreshOrderBlocks(sc.bars, {
      asOfUtcSec: sc.freshAsOf,
      barSeconds: sc.barSeconds,
    });
    assertFobsMatch(freshActual, sc.freshExpected, 'fob.fresh');
    expect(freshActual.freshOrderBlocks.length).toBe(1);
    expect(freshActual.freshOrderBlocks[0]?.anchorSource).toBe('INTERNAL_POC');

    const touch1Actual = detectFreshOrderBlocks(sc.bars, {
      asOfUtcSec: sc.firstTouchAsOf,
      barSeconds: sc.barSeconds,
    });
    assertFobsMatch(touch1Actual, sc.firstTouchExpected, 'fob.touch1');
    expect(touch1Actual.orderBlocks[0]?.isFresh).toBe(false);
    expect(touch1Actual.orderBlocks[0]?.touchCount).toBe(1);
    expect(touch1Actual.orderBlocks[0]?.isMitigated).toBe(false);

    const finalActual = detectFreshOrderBlocks(sc.bars, {
      asOfUtcSec: sc.finalAsOf,
      barSeconds: sc.barSeconds,
    });
    assertFobsMatch(finalActual, sc.finalExpected, 'fob.final');
    expect(finalActual.orderBlocks[0]?.isMitigated).toBe(true);
    expect(finalActual.orderBlocks[1]?.type).toBe('BEARISH_FOB');
    expect(finalActual.orderBlocks[1]?.darkPoolFootprint).toBe(true);
    expect(finalActual.orderBlocks[1]?.isFresh).toBe(true);
    expect(finalActual.orderBlocks[1]?.anchorSource).toBe('VWAP');
  });

  it('Scenario 5: classifyTradesLeeReady & computeL1BookImbalance match Python reference (< 1e-11) with TRF/Lit split & Zero-Tick rule', () => {
    const { trades, quotes, strictExpected, tickFallbackExpected, l1BookCases } =
      fixture.leeReadyAndBookScenario;

    const strictActual = classifyTradesLeeReady(trades, quotes, {
      allowTickFallbackWithoutQuote: false,
    });
    assertLeeReadyMatches(strictActual, strictExpected, 'lr.strict');

    const fallbackActual = classifyTradesLeeReady(trades, quotes, {
      allowTickFallbackWithoutQuote: true,
    });
    assertLeeReadyMatches(fallbackActual, tickFallbackExpected, 'lr.fallback');

    for (let i = 0; i < l1BookCases.length; i += 1) {
      const c = l1BookCases[i];
      expect(c).toBeDefined();
      if (!c) continue;
      const res: L1BookImbalanceResult = computeL1BookImbalance(
        c.input.bidPrice,
        c.input.askPrice,
        c.input.bidSize,
        c.input.askSize,
      );
      expect(res.status).toBe(c.expected.status);
      assertScalarMatch(res.midpoint, c.expected.midpoint, `l1[${String(i)}].mid`);
      assertScalarMatch(res.spread, c.expected.spread, `l1[${String(i)}].spread`);
      assertScalarMatch(res.spreadBps, c.expected.spreadBps, `l1[${String(i)}].spreadBps`);
      assertScalarMatch(res.imbalance, c.expected.imbalance, `l1[${String(i)}].imbalance`);
      assertScalarMatch(res.microprice, c.expected.microprice, `l1[${String(i)}].microprice`);
    }
  });

  it('Zero Silent Fallbacks & Guardrails: empty/invalid inputs return NaN + NO_DATA, and ms timestamps throw', () => {
    const asOf = 1_772_467_200;

    // 1) Volume Profile AMT: empty & tickSize <= 0
    const emptyVp = computeVolumeProfileAmt([], { asOfUtcSec: asOf, barSeconds: 300, tickSize: 0.25 });
    expect(emptyVp.status).toBe('NO_DATA');
    expect(Number.isNaN(emptyVp.poc)).toBe(true);
    expect(Number.isNaN(emptyVp.vah)).toBe(true);
    expect(Number.isNaN(emptyVp.val)).toBe(true);
    expect(emptyVp.bins.length).toBe(0);

    const badTickVp = computeVolumeProfileAmt(fixture.volumeProfileAmtScenario.bars, {
      asOfUtcSec: asOf,
      barSeconds: 300,
      tickSize: 0,
    });
    expect(badTickVp.status).toBe('NO_DATA');
    expect(Number.isNaN(badTickVp.poc)).toBe(true);

    // 2) Naked POCs: empty & bad tickSize
    const emptyNpoc = trackNakedPocs([], { asOfUtcSec: asOf, barSeconds: 300, tickSize: 0.25 });
    expect(emptyNpoc.status).toBe('NO_DATA');
    expect(emptyNpoc.sessions.length).toBe(0);

    const badTickNpoc = trackNakedPocs(fixture.nakedPocsScenario.bars, {
      asOfUtcSec: asOf,
      barSeconds: 300,
      tickSize: -0.1,
    });
    expect(badTickNpoc.status).toBe('NO_DATA');

    // 3) FVG & FOB: empty / insufficient bars / bad tickSize
    const emptyFvg = detectQuantitativeFvgs([], { asOfUtcSec: asOf, barSeconds: 300, tickSize: 0.25 });
    expect(emptyFvg.status).toBe('NO_DATA');
    expect(emptyFvg.fvgs.length).toBe(0);

    const badTickFvg = detectQuantitativeFvgs(fixture.quantitativeFvgsScenario.bars, {
      asOfUtcSec: asOf,
      barSeconds: 300,
      tickSize: Number.NaN,
    });
    expect(badTickFvg.status).toBe('NO_DATA');

    const emptyFob = detectFreshOrderBlocks([], { asOfUtcSec: asOf, barSeconds: 300 });
    expect(emptyFob.status).toBe('NO_DATA');
    expect(emptyFob.orderBlocks.length).toBe(0);

    // Zero-variance bars -> Z-score is NaN -> no false FVG/FOB triggers
    const flatBars: InstitutionalFlowBar[] = Array.from({ length: 25 }, (_, i) => ({
      time: asOf - (30 - i) * 300,
      open: 100,
      high: 101,
      low: 100,
      close: 100.5,
      volume: 1000,
      delta: 500,
    }));
    const frozenFlat = deepFreeze(flatBars);
    const flatFvg = detectQuantitativeFvgs(frozenFlat, {
      asOfUtcSec: asOf,
      barSeconds: 300,
      tickSize: 0.25,
    });
    expect(flatFvg.status).toBe('OK');
    expect(flatFvg.fvgs.length).toBe(0);

    // 4) Lee-Ready: empty or invalid trades -> NO_DATA + NaN
    const emptyLr = classifyTradesLeeReady([], []);
    expect(emptyLr.status).toBe('NO_DATA');
    expect(Number.isNaN(emptyLr.netCvd)).toBe(true);
    expect(Number.isNaN(emptyLr.darkPoolShare)).toBe(true);

    const badLr = classifyTradesLeeReady(
      [{ timestamp: 100, price: 0, size: 10 }],
      [{ timestamp: 90, bid: 10, ask: 10.1 }],
    );
    expect(badLr.status).toBe('NO_DATA');
    expect(Number.isNaN(badLr.totalVolume)).toBe(true);

    // 5) L1 Book Imbalance invalid cases -> NO_DATA + NaN
    const badL1Cases = [
      computeL1BookImbalance(0, 100.1, 10, 10),
      computeL1BookImbalance(100.2, 100.1, 10, 10),
      computeL1BookImbalance(100.0, 100.1, 0, 0),
      computeL1BookImbalance(100.0, 100.1, -1, 10),
      computeL1BookImbalance(Number.NaN, 100.1, 10, 10),
    ];
    for (const c of badL1Cases) {
      expect(c.status).toBe('NO_DATA');
      expect(Number.isNaN(c.imbalance)).toBe(true);
      expect(Number.isNaN(c.microprice)).toBe(true);
      expect(Number.isNaN(c.spreadBps)).toBe(true);
    }

    // 6) Millisecond timestamp guardrails (> MAX_TIME_SECONDS)
    expect(() =>
      computeVolumeProfileAmt([], {
        asOfUtcSec: asOf * 1000,
        barSeconds: 300,
        tickSize: 0.25,
      }),
    ).toThrow();
    expect(() =>
      detectFreshOrderBlocks([], {
        asOfUtcSec: asOf * 1000,
        barSeconds: 300,
      }),
    ).toThrow();
  });
});
