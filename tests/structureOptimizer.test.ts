import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  computeStructureCostPercentile,
  detectSpatialConfluenceClusters,
  evaluateRelativeStrengthAndCatalysts,
  optimizeOptionStructures,
  type CatalystBlockReason,
  type DetectSpatialConfluenceInputs,
  type EvaluatedOptionStructure,
  type ExpectedLevelReaction,
  type HistoricalCostRegime,
  type OptimizeOptionStructuresInputs,
  type OptionStructureKind,
  type RelativeStrengthAndCatalystsInputs,
  type RelativeStrengthClassification,
  type SpatialConfluenceCategory,
  type SpatialLevelInput,
  type StructureCostPercentileInputs,
  type StructureDirection,
  type StructureLegSide,
} from '../src/core/terminal/structureOptimizer.js';
import type { TerminalDataStatus } from '../src/core/terminal/types.js';

const TOLERANCE = 1e-11;

type NumOrMarker = number | 'INF' | '-INF' | null;

interface ExpectedSpatialCluster {
  readonly centroidPrice: number;
  readonly bandLow: number;
  readonly bandHigh: number;
  readonly bandWidthAtr: number;
  readonly maxMemberDistanceAtr: number;
  readonly distanceToSpotAtr: number;
  readonly levels: readonly SpatialLevelInput[];
  readonly distinctCategories: readonly SpatialConfluenceCategory[];
  readonly distinctCategoriesCount: number;
  readonly isTripleConfluence: boolean;
  readonly expectedReaction: ExpectedLevelReaction;
  readonly triggerAligned: boolean;
  readonly clusterStrength: number;
}

interface ExpectedSpatialResult {
  readonly status: TerminalDataStatus;
  readonly spot: number;
  readonly atr: number;
  readonly clusterRadiusAtr: number;
  readonly tolerancePrice: NumOrMarker;
  readonly validLevelsCount: number;
  readonly skippedLevelsCount: number;
  readonly clusters: readonly ExpectedSpatialCluster[];
  readonly tripleConfluenceCount: number;
  readonly strongestClusterCentroid: NumOrMarker;
  readonly strongestClusterStrength: NumOrMarker;
}

interface ExpectedRsResult {
  readonly status: TerminalDataStatus;
  readonly asOfUtcSec: number;
  readonly lookbackBars: number;
  readonly embargoHours: number;
  readonly causalAssetBarCount: number;
  readonly causalBenchmarkBarCount: number;
  readonly excludedFutureAssetBars: number;
  readonly excludedFutureBenchmarkBars: number;
  readonly assetReturn: NumOrMarker;
  readonly benchmarkReturn: NumOrMarker;
  readonly rsSpread: NumOrMarker;
  readonly rsRatioBase: NumOrMarker;
  readonly rsRatioCurrent: NumOrMarker;
  readonly rsRatioChange: NumOrMarker;
  readonly rsClassification: RelativeStrengthClassification;
  readonly hoursToEarnings: NumOrMarker;
  readonly entryBlocked: boolean;
  readonly blockReason: CatalystBlockReason;
}

interface ExpectedStructureLeg {
  readonly strike: number;
  readonly contractType: 'call' | 'put';
  readonly side: StructureLegSide;
  readonly quantity: number;
  readonly bid: number;
  readonly ask: number;
  readonly executionPrice: number;
  readonly grossPremium: number;
  readonly feeAmount: number;
  readonly vatAmount: number;
}

interface ExpectedEvaluatedStructure {
  readonly id: string;
  readonly kind: OptionStructureKind;
  readonly label: string;
  readonly direction: StructureDirection;
  readonly legs: readonly ExpectedStructureLeg[];
  readonly isDefinedRisk: boolean;
  readonly grossDebitOrCredit: number;
  readonly totalFees: number;
  readonly totalVat: number;
  readonly totalFriction: number;
  readonly netDebitOrCredit: number;
  readonly spreadWidth: NumOrMarker;
  readonly costPctOfWidth: NumOrMarker;
  readonly maxLoss: NumOrMarker;
  readonly capitalAtRisk: number;
  readonly maxProfit: NumOrMarker;
  readonly breakevenPrices: readonly number[];
  readonly pop: number;
  readonly expectedValue: number;
  readonly positiveExpectedPayoff: number;
  readonly expectedReturnOnRisk: NumOrMarker;
  readonly convexityScore: NumOrMarker;
}

interface ExpectedOptimizerResult {
  readonly status: TerminalDataStatus;
  readonly direction: StructureDirection;
  readonly spot: number;
  readonly targetPrice: number;
  readonly dte: number;
  readonly lotSize: number;
  readonly liquidContractsCount: number;
  readonly skippedContractsCount: number;
  readonly candidates: readonly ExpectedEvaluatedStructure[];
  readonly bestByPop: ExpectedEvaluatedStructure | null;
  readonly bestByExpectedValue: ExpectedEvaluatedStructure | null;
  readonly bestByConvexity: ExpectedEvaluatedStructure | null;
}

interface ExpectedCostPercentileResult {
  readonly status: TerminalDataStatus;
  readonly currentCostPctOfWidth: NumOrMarker;
  readonly percentile: NumOrMarker;
  readonly regime: HistoricalCostRegime;
  readonly observationsUsed: number;
  readonly minCostPct: NumOrMarker;
  readonly maxCostPct: NumOrMarker;
  readonly meanCostPct: NumOrMarker;
}

interface StructureOptimizerFixture {
  readonly inputs: {
    readonly spatialBullTrigger: DetectSpatialConfluenceInputs;
    readonly spatialBearTrigger: DetectSpatialConfluenceInputs;
    readonly spatialMagnet: DetectSpatialConfluenceInputs;
    readonly rsOutperforming: RelativeStrengthAndCatalystsInputs;
    readonly rsUnderperformingBlocked: RelativeStrengthAndCatalystsInputs;
    readonly rsInlineCausalCalendar: RelativeStrengthAndCatalystsInputs;
    readonly optimizerBullishByma: OptimizeOptionStructuresInputs;
    readonly optimizerBearishUs: OptimizeOptionStructuresInputs;
    readonly optimizerRatioCreditPop: OptimizeOptionStructuresInputs;
    readonly costPercentileCheap: StructureCostPercentileInputs;
    readonly costPercentileFair: StructureCostPercentileInputs;
    readonly costPercentileRich: StructureCostPercentileInputs;
  };
  readonly expected: {
    readonly spatialBullTrigger: ExpectedSpatialResult;
    readonly spatialBearTrigger: ExpectedSpatialResult;
    readonly spatialMagnet: ExpectedSpatialResult;
    readonly rsOutperforming: ExpectedRsResult;
    readonly rsUnderperformingBlocked: ExpectedRsResult;
    readonly rsInlineCausalCalendar: ExpectedRsResult;
    readonly optimizerBullishByma: ExpectedOptimizerResult;
    readonly optimizerBearishUs: ExpectedOptimizerResult;
    readonly optimizerRatioCreditPop: ExpectedOptimizerResult;
    readonly costPercentileCheap: ExpectedCostPercentileResult;
    readonly costPercentileFair: ExpectedCostPercentileResult;
    readonly costPercentileRich: ExpectedCostPercentileResult;
  };
}

function loadFixture(): StructureOptimizerFixture {
  const path = resolve(process.cwd(), 'fixtures', 'structure_optimizer_reference.json');
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as StructureOptimizerFixture;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      const prop = (value as Record<string, unknown>)[key];
      if (prop !== undefined) {
        deepFreeze(prop);
      }
    }
  }
  return value;
}

const precisionStats = {
  scalarsChecked: 0,
  maxAbsDiff: 0,
  maxRelDiff: 0,
  maxNearZeroAbsDiff: 0,
};

function expectCloseOrSpecial(actual: number, expected: NumOrMarker): void {
  precisionStats.scalarsChecked += 1;
  if (expected === null) {
    expect(Number.isNaN(actual)).toBe(true);
    return;
  }
  if (expected === 'INF') {
    expect(actual).toBe(Number.POSITIVE_INFINITY);
    return;
  }
  if (expected === '-INF') {
    expect(actual).toBe(Number.NEGATIVE_INFINITY);
    return;
  }
  expect(Number.isFinite(actual)).toBe(true);
  const absDiff = Math.abs(actual - expected);
  const scale = Math.max(1, Math.abs(expected));
  const scaledDiff = absDiff / scale;
  if (absDiff > precisionStats.maxAbsDiff) {
    precisionStats.maxAbsDiff = absDiff;
  }
  if (Math.abs(expected) >= 1e-6) {
    const relDiff = absDiff / Math.abs(expected);
    if (relDiff > precisionStats.maxRelDiff) {
      precisionStats.maxRelDiff = relDiff;
    }
  } else if (absDiff > precisionStats.maxNearZeroAbsDiff) {
    precisionStats.maxNearZeroAbsDiff = absDiff;
  }
  expect(scaledDiff).toBeLessThan(TOLERANCE);
}

function assertEvaluatedStructureParity(
  actual: EvaluatedOptionStructure | null,
  expected: ExpectedEvaluatedStructure | null,
): void {
  if (expected === null) {
    expect(actual).toBeNull();
    return;
  }
  expect(actual).not.toBeNull();
  if (actual === null) {
    return;
  }
  expect(actual.id).toBe(expected.id);
  expect(actual.kind).toBe(expected.kind);
  expect(actual.label).toBe(expected.label);
  expect(actual.direction).toBe(expected.direction);
  expect(actual.isDefinedRisk).toBe(expected.isDefinedRisk);
  expect(actual.legs).toHaveLength(expected.legs.length);
  for (let i = 0; i < expected.legs.length; i += 1) {
    const aLeg = actual.legs[i];
    const eLeg = expected.legs[i];
    expect(aLeg).toBeDefined();
    expect(eLeg).toBeDefined();
    if (aLeg === undefined || eLeg === undefined) {
      continue;
    }
    expect(aLeg.strike).toBe(eLeg.strike);
    expect(aLeg.contractType).toBe(eLeg.contractType);
    expect(aLeg.side).toBe(eLeg.side);
    expect(aLeg.quantity).toBe(eLeg.quantity);
    expectCloseOrSpecial(aLeg.bid, eLeg.bid);
    expectCloseOrSpecial(aLeg.ask, eLeg.ask);
    expectCloseOrSpecial(aLeg.executionPrice, eLeg.executionPrice);
    expectCloseOrSpecial(aLeg.grossPremium, eLeg.grossPremium);
    expectCloseOrSpecial(aLeg.feeAmount, eLeg.feeAmount);
    expectCloseOrSpecial(aLeg.vatAmount, eLeg.vatAmount);
  }
  expectCloseOrSpecial(actual.grossDebitOrCredit, expected.grossDebitOrCredit);
  expectCloseOrSpecial(actual.totalFees, expected.totalFees);
  expectCloseOrSpecial(actual.totalVat, expected.totalVat);
  expectCloseOrSpecial(actual.totalFriction, expected.totalFriction);
  expectCloseOrSpecial(actual.netDebitOrCredit, expected.netDebitOrCredit);
  expectCloseOrSpecial(actual.spreadWidth, expected.spreadWidth);
  expectCloseOrSpecial(actual.costPctOfWidth, expected.costPctOfWidth);
  expectCloseOrSpecial(actual.maxLoss, expected.maxLoss);
  expectCloseOrSpecial(actual.capitalAtRisk, expected.capitalAtRisk);
  expectCloseOrSpecial(actual.maxProfit, expected.maxProfit);

  expect(actual.breakevenPrices).toHaveLength(expected.breakevenPrices.length);
  for (let i = 0; i < expected.breakevenPrices.length; i += 1) {
    const aBe = actual.breakevenPrices[i];
    const eBe = expected.breakevenPrices[i];
    expect(aBe).toBeDefined();
    expect(eBe).toBeDefined();
    if (aBe !== undefined && eBe !== undefined) {
      expectCloseOrSpecial(aBe, eBe);
    }
  }
  expectCloseOrSpecial(actual.pop, expected.pop);
  expectCloseOrSpecial(actual.expectedValue, expected.expectedValue);
  expectCloseOrSpecial(actual.positiveExpectedPayoff, expected.positiveExpectedPayoff);
  expectCloseOrSpecial(actual.expectedReturnOnRisk, expected.expectedReturnOnRisk);
  expectCloseOrSpecial(actual.convexityScore, expected.convexityScore);
}

describe('Pieza 18 (Motores 4 y 10): Spatial Confluence, RS/Catalysts & Option Structure Optimizer', () => {
  const fixture = deepFreeze(loadFixture());

  afterAll(() => {
    console.log(
      `[structureOptimizer.test] Fixture precision summary: ${String(precisionStats.scalarsChecked)} scalars checked, maxRelDiff(|x|>=1e-6)=${precisionStats.maxRelDiff.toExponential(3)}, maxNearZeroAbsDiff=${precisionStats.maxNearZeroAbsDiff.toExponential(3)}, maxAbsDiff=${precisionStats.maxAbsDiff.toExponential(3)} (limit < 1e-11)`,
    );
  });

  describe('Parity vs Python Reference (< 1e-11)', () => {
    it('matches detectSpatialConfluenceClusters across triple, double, magnet and trigger-aligned cases', () => {
      const cases = [
        [fixture.inputs.spatialBullTrigger, fixture.expected.spatialBullTrigger],
        [fixture.inputs.spatialBearTrigger, fixture.expected.spatialBearTrigger],
        [fixture.inputs.spatialMagnet, fixture.expected.spatialMagnet],
      ] as const;

      for (const [inp, exp] of cases) {
        const actual = detectSpatialConfluenceClusters(inp);
        expect(actual.status).toBe(exp.status);
        expect(actual.spot).toBe(exp.spot);
        expect(actual.atr).toBe(exp.atr);
        expectCloseOrSpecial(actual.clusterRadiusAtr, exp.clusterRadiusAtr);
        expectCloseOrSpecial(actual.tolerancePrice, exp.tolerancePrice);
        expect(actual.validLevelsCount).toBe(exp.validLevelsCount);
        expect(actual.skippedLevelsCount).toBe(exp.skippedLevelsCount);
        expect(actual.tripleConfluenceCount).toBe(exp.tripleConfluenceCount);
        expectCloseOrSpecial(actual.strongestClusterCentroid, exp.strongestClusterCentroid);
        expectCloseOrSpecial(actual.strongestClusterStrength, exp.strongestClusterStrength);
        expect(actual.clusters).toHaveLength(exp.clusters.length);

        for (let i = 0; i < exp.clusters.length; i += 1) {
          const aC = actual.clusters[i];
          const eC = exp.clusters[i];
          expect(aC).toBeDefined();
          expect(eC).toBeDefined();
          if (aC === undefined || eC === undefined) {
            continue;
          }
          expectCloseOrSpecial(aC.centroidPrice, eC.centroidPrice);
          expectCloseOrSpecial(aC.bandLow, eC.bandLow);
          expectCloseOrSpecial(aC.bandHigh, eC.bandHigh);
          expectCloseOrSpecial(aC.bandWidthAtr, eC.bandWidthAtr);
          expectCloseOrSpecial(aC.maxMemberDistanceAtr, eC.maxMemberDistanceAtr);
          expectCloseOrSpecial(aC.distanceToSpotAtr, eC.distanceToSpotAtr);
          expect(aC.distinctCategories).toEqual(eC.distinctCategories);
          expect(aC.distinctCategoriesCount).toBe(eC.distinctCategoriesCount);
          expect(aC.isTripleConfluence).toBe(eC.isTripleConfluence);
          expect(aC.expectedReaction).toBe(eC.expectedReaction);
          expect(aC.triggerAligned).toBe(eC.triggerAligned);
          expectCloseOrSpecial(aC.clusterStrength, eC.clusterStrength);
          expect(aC.levels.map((l) => l.name)).toEqual(eC.levels.map((l) => l.name));
        }
      }
    });

    it('matches evaluateRelativeStrengthAndCatalysts across outperforming, blocked 48h and causal calendar cases', () => {
      const cases = [
        [fixture.inputs.rsOutperforming, fixture.expected.rsOutperforming],
        [fixture.inputs.rsUnderperformingBlocked, fixture.expected.rsUnderperformingBlocked],
        [fixture.inputs.rsInlineCausalCalendar, fixture.expected.rsInlineCausalCalendar],
      ] as const;

      for (const [inp, exp] of cases) {
        const actual = evaluateRelativeStrengthAndCatalysts(inp);
        expect(actual.status).toBe(exp.status);
        expect(actual.asOfUtcSec).toBe(exp.asOfUtcSec);
        expect(actual.lookbackBars).toBe(exp.lookbackBars);
        expectCloseOrSpecial(actual.embargoHours, exp.embargoHours);
        expect(actual.causalAssetBarCount).toBe(exp.causalAssetBarCount);
        expect(actual.causalBenchmarkBarCount).toBe(exp.causalBenchmarkBarCount);
        expect(actual.excludedFutureAssetBars).toBe(exp.excludedFutureAssetBars);
        expect(actual.excludedFutureBenchmarkBars).toBe(exp.excludedFutureBenchmarkBars);
        expectCloseOrSpecial(actual.assetReturn, exp.assetReturn);
        expectCloseOrSpecial(actual.benchmarkReturn, exp.benchmarkReturn);
        expectCloseOrSpecial(actual.rsSpread, exp.rsSpread);
        expectCloseOrSpecial(actual.rsRatioBase, exp.rsRatioBase);
        expectCloseOrSpecial(actual.rsRatioCurrent, exp.rsRatioCurrent);
        expectCloseOrSpecial(actual.rsRatioChange, exp.rsRatioChange);
        expect(actual.rsClassification).toBe(exp.rsClassification);
        expectCloseOrSpecial(actual.hoursToEarnings, exp.hoursToEarnings);
        expect(actual.entryBlocked).toBe(exp.entryBlocked);
        expect(actual.blockReason).toBe(exp.blockReason);
      }
    });

    it('matches optimizeOptionStructures across BYMA bullish, US bearish and ratio-credit cases', () => {
      const cases = [
        [fixture.inputs.optimizerBullishByma, fixture.expected.optimizerBullishByma],
        [fixture.inputs.optimizerBearishUs, fixture.expected.optimizerBearishUs],
        [fixture.inputs.optimizerRatioCreditPop, fixture.expected.optimizerRatioCreditPop],
      ] as const;

      for (const [inp, exp] of cases) {
        const actual = optimizeOptionStructures(inp);
        expect(actual.status).toBe(exp.status);
        expect(actual.direction).toBe(exp.direction);
        expect(actual.spot).toBe(exp.spot);
        expect(actual.targetPrice).toBe(exp.targetPrice);
        expect(actual.dte).toBe(exp.dte);
        expect(actual.lotSize).toBe(exp.lotSize);
        expect(actual.liquidContractsCount).toBe(exp.liquidContractsCount);
        expect(actual.skippedContractsCount).toBe(exp.skippedContractsCount);
        expect(actual.candidates).toHaveLength(exp.candidates.length);

        for (let i = 0; i < exp.candidates.length; i += 1) {
          const aCand = actual.candidates[i];
          const eCand = exp.candidates[i];
          expect(aCand).toBeDefined();
          expect(eCand).toBeDefined();
          if (aCand !== undefined && eCand !== undefined) {
            assertEvaluatedStructureParity(aCand, eCand);
          }
        }

        assertEvaluatedStructureParity(actual.bestByPop, exp.bestByPop);
        assertEvaluatedStructureParity(actual.bestByExpectedValue, exp.bestByExpectedValue);
        assertEvaluatedStructureParity(actual.bestByConvexity, exp.bestByConvexity);
      }
    });

    it('matches computeStructureCostPercentile across 300-day CHEAP, FAIR and RICH regimes', () => {
      const cases = [
        [fixture.inputs.costPercentileCheap, fixture.expected.costPercentileCheap],
        [fixture.inputs.costPercentileFair, fixture.expected.costPercentileFair],
        [fixture.inputs.costPercentileRich, fixture.expected.costPercentileRich],
      ] as const;

      for (const [inp, exp] of cases) {
        const actual = computeStructureCostPercentile(inp);
        expect(actual.status).toBe(exp.status);
        expectCloseOrSpecial(actual.currentCostPctOfWidth, exp.currentCostPctOfWidth);
        expectCloseOrSpecial(actual.percentile, exp.percentile);
        expect(actual.regime).toBe(exp.regime);
        expect(actual.observationsUsed).toBe(exp.observationsUsed);
        expectCloseOrSpecial(actual.minCostPct, exp.minCostPct);
        expectCloseOrSpecial(actual.maxCostPct, exp.maxCostPct);
        expectCloseOrSpecial(actual.meanCostPct, exp.meanCostPct);
      }
    });
  });

  describe('Zero Silent Fallbacks, Boundary Conditions & Purity', () => {
    it('returns NO_DATA and NaN when atr <= 0, spot <= 0, or no multi-layer cluster exists', () => {
      const zeroAtr = detectSpatialConfluenceClusters({
        spot: 100,
        atr: 0,
        levels: fixture.inputs.spatialBullTrigger.levels,
      });
      expect(zeroAtr.status).toBe('NO_DATA');
      expect(Number.isNaN(zeroAtr.tolerancePrice)).toBe(true);
      expect(Number.isNaN(zeroAtr.strongestClusterCentroid)).toBe(true);
      expect(Number.isNaN(zeroAtr.strongestClusterStrength)).toBe(true);
      expect(zeroAtr.clusters).toEqual([]);

      const negSpot = detectSpatialConfluenceClusters({
        spot: -50,
        atr: 2,
        levels: fixture.inputs.spatialBullTrigger.levels,
      });
      expect(negSpot.status).toBe('NO_DATA');
      expect(Number.isNaN(negSpot.strongestClusterCentroid)).toBe(true);

      const singleLayerOnly = detectSpatialConfluenceClusters(
        deepFreeze({
          spot: 100,
          atr: 2,
          levels: [
            { name: 'POC', category: 'AMT_VOLUME_PROFILE', price: 99.0 },
            { name: 'VAL', category: 'AMT_VOLUME_PROFILE', price: 99.05 },
          ],
        }),
      );
      expect(singleLayerOnly.status).toBe('NO_DATA');
      expect(singleLayerOnly.clusters).toEqual([]);
      expect(Number.isNaN(singleLayerOnly.strongestClusterCentroid)).toBe(true);
    });

    it('rejects invalid cluster parameters and enforces exact 0.15 ATR boundary', () => {
      expect(() =>
        detectSpatialConfluenceClusters({
          spot: 100,
          atr: 2,
          levels: [],
          clusterRadiusAtr: 0,
        }),
      ).toThrow();
      expect(() =>
        detectSpatialConfluenceClusters({
          spot: 100,
          atr: 2,
          levels: [],
          minDistinctCategories: 4,
        }),
      ).toThrow();

      // ATR = 2 -> tolerance = 0.30. Half-span 0.299 (0.598 total) fits; 0.305 (0.61 total) splits.
      const within = detectSpatialConfluenceClusters({
        spot: 100,
        atr: 2,
        levels: [
          { name: 'VAL', category: 'AMT_VOLUME_PROFILE', price: 99.0 },
          { name: 'PutWall', category: 'OPTIONS_DEALER', price: 99.598 },
        ],
      });
      expect(within.status).toBe('OK');
      expect(within.clusters).toHaveLength(1);

      const outside = detectSpatialConfluenceClusters({
        spot: 100,
        atr: 2,
        levels: [
          { name: 'VAL', category: 'AMT_VOLUME_PROFILE', price: 99.0 },
          { name: 'PutWall', category: 'OPTIONS_DEALER', price: 99.61 },
        ],
      });
      expect(outside.status).toBe('NO_DATA');
      expect(outside.clusters).toEqual([]);
    });

    it('enforces strict causality and 48h embargo boundaries in evaluateRelativeStrengthAndCatalysts', () => {
      const asOf = 1_794_672_000;
      const bars = deepFreeze(
        Array.from({ length: 21 }, (_, idx) => ({
          time: asOf - (20 - idx) * 86_400,
          close: 100 + idx,
        })),
      );
      const futureOnlyExtra = deepFreeze([
        ...bars,
        { time: asOf + 86_400, close: 150 },
      ]);

      // Exactly 48h ahead -> blocked
      const exact48 = evaluateRelativeStrengthAndCatalysts({
        asOfUtcSec: asOf,
        assetBars: futureOnlyExtra,
        benchmarkBars: bars,
        nextEarningsUtcSec: asOf + 48 * 3600,
      });
      expect(exact48.status).toBe('OK');
      expect(exact48.hoursToEarnings).toBe(48);
      expect(exact48.entryBlocked).toBe(true);
      expect(exact48.blockReason).toBe('EARNINGS_JUMP_RISK_48H');
      expect(exact48.excludedFutureAssetBars).toBe(1);

      // 48.01h ahead -> allowed
      const justOutside = evaluateRelativeStrengthAndCatalysts({
        asOfUtcSec: asOf,
        assetBars: bars,
        benchmarkBars: bars,
        nextEarningsUtcSec: asOf + 48 * 3600 + 36,
      });
      expect(justOutside.entryBlocked).toBe(false);
      expect(justOutside.blockReason).toBe('NONE');

      // Insufficient causal bars (20 causal + 5 future with lookback=20 requires 21 causal) -> NO_DATA
      const insufficient = evaluateRelativeStrengthAndCatalysts({
        asOfUtcSec: asOf,
        assetBars: deepFreeze(
          Array.from({ length: 25 }, (_, idx) => ({
            time: asOf - (19 - idx) * 86_400,
            close: 100 + idx,
          })),
        ),
        benchmarkBars: bars,
        lookbackBars: 20,
      });
      expect(insufficient.status).toBe('NO_DATA');
      expect(insufficient.rsClassification).toBe('NO_DATA');
      expect(Number.isNaN(insufficient.assetReturn)).toBe(true);
      expect(Number.isNaN(insufficient.rsSpread)).toBe(true);
      expect(insufficient.excludedFutureAssetBars).toBe(5);

      // Millisecond timestamp must throw
      expect(() =>
        evaluateRelativeStrengthAndCatalysts({
          asOfUtcSec: asOf * 1000,
          assetBars: bars,
          benchmarkBars: bars,
        }),
      ).toThrow();
    });

    it('returns NO_DATA on unexecutable quotes, zero prob mass, and excludes infinite-risk ratios from bestByConvexity', () => {
      const base = fixture.inputs.optimizerBullishByma;

      const zeroProbMass = optimizeOptionStructures({
        ...base,
        empiricalProbs: deepFreeze(base.empiricalProbs.map(() => 0)),
      });
      expect(zeroProbMass.status).toBe('NO_DATA');
      expect(zeroProbMass.candidates).toEqual([]);
      expect(zeroProbMass.bestByPop).toBeNull();

      const wrongDirection = optimizeOptionStructures({
        ...base,
        targetPrice: base.spot - 100,
      });
      expect(wrongDirection.status).toBe('NO_DATA');
      expect(wrongDirection.candidates).toEqual([]);

      const noExecutableQuotes = optimizeOptionStructures({
        ...base,
        contracts: deepFreeze([
          { strike: 5000, contractType: 'call', bid: 0, ask: 315, delta: 0.58, iv: 0.49 },
          { strike: 5200, contractType: 'call', bid: 205, ask: 0, delta: 0.45, iv: 0.48 },
        ]),
      });
      expect(noExecutableQuotes.status).toBe('NO_DATA');
      expect(noExecutableQuotes.liquidContractsCount).toBe(0);
      expect(noExecutableQuotes.skippedContractsCount).toBe(2);

      // In Ratio case, CALL_RATIO_1X2_100_110 wins bestByPop with isDefinedRisk=false & maxLoss=Infinity,
      // and bestByConvexity MUST be defined-risk with finite maxLoss.
      const ratioRes = optimizeOptionStructures(fixture.inputs.optimizerRatioCreditPop);
      expect(ratioRes.bestByPop?.kind).toBe('CALL_RATIO_1X2');
      expect(ratioRes.bestByPop?.isDefinedRisk).toBe(false);
      expect(ratioRes.bestByPop?.maxLoss).toBe(Number.POSITIVE_INFINITY);
      expect(ratioRes.bestByPop?.netDebitOrCredit).toBeLessThan(0);
      expect(ratioRes.bestByConvexity).not.toBeNull();
      expect(ratioRes.bestByConvexity?.isDefinedRisk).toBe(true);
      expect(Number.isFinite(ratioRes.bestByConvexity?.maxLoss)).toBe(true);
    });

    it('returns NO_DATA for invalid current cost or empty historical cost series', () => {
      const emptyHist = computeStructureCostPercentile({
        currentCostPctOfWidth: 0.35,
        historicalCostPctSeries: deepFreeze([]),
      });
      expect(emptyHist.status).toBe('NO_DATA');
      expect(emptyHist.regime).toBe('NO_DATA');
      expect(Number.isNaN(emptyHist.percentile)).toBe(true);
      expect(emptyHist.currentCostPctOfWidth).toBe(0.35);

      const nanCurrent = computeStructureCostPercentile({
        currentCostPctOfWidth: Number.NaN,
        historicalCostPctSeries: deepFreeze([0.2, 0.3, 0.4]),
      });
      expect(nanCurrent.status).toBe('NO_DATA');
      expect(Number.isNaN(nanCurrent.currentCostPctOfWidth)).toBe(true);
      expect(Number.isNaN(nanCurrent.percentile)).toBe(true);

      const boundary25 = computeStructureCostPercentile({
        currentCostPctOfWidth: 0.2,
        historicalCostPctSeries: deepFreeze([0.2, 0.3, 0.4, 0.5]),
      });
      expect(boundary25.percentile).toBe(25);
      expect(boundary25.regime).toBe('CHEAP_HISTORICAL_DEBIT');

      const boundary75 = computeStructureCostPercentile({
        currentCostPctOfWidth: 0.4,
        historicalCostPctSeries: deepFreeze([0.2, 0.3, 0.4, 0.5]),
      });
      expect(boundary75.percentile).toBe(75);
      expect(boundary75.regime).toBe('RICH_HISTORICAL_DEBIT');
    });
  });
});
