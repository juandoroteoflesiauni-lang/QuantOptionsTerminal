import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  ExposureContractInput,
  ExposureMarketInputs,
} from '../src/core/options/exposure.js';
import {
  classifyOpraTradePrint,
  computeSignedOptionsOrderFlow,
  detectVolOiAnomaliesMad,
  type DteBucket,
  type MoneynessBucket,
  type OpraOrderFlowMarketContext,
  type OpraTradePrintInput,
  type OpraTradeSideClassification,
  type StrikeOrderFlowBucket,
  type VolOiAnomalyContractInput,
} from '../src/core/options/optionsOrderFlow.js';
import {
  computeFlowAdjustedSignedGex,
  computeGexCharmPin,
  evaluateWheelByWheelTracker,
  type WheelRegimeClassification,
  type WheelSnapshotInput,
} from '../src/core/options/pinTracker.js';

const TOLERANCE = 1e-11;

interface ClassificationCaseFixture {
  readonly name: string;
  readonly price: number;
  readonly bid: number;
  readonly ask: number;
  readonly prevPrice: number | null;
}

interface ExpectedClassification {
  readonly side: OpraTradeSideClassification;
  readonly aggressorSign: -1 | 0 | 1;
  readonly midpoint: number | null;
}

interface ExpectedOrderFlow {
  readonly asOfUtcSec: number;
  readonly evaluatedPrints: number;
  readonly skippedPrints: number;
  readonly callBuyPremiumUsd: number | null;
  readonly callSellPremiumUsd: number | null;
  readonly callNetPremiumCvdUsd: number | null;
  readonly putBuyPremiumUsd: number | null;
  readonly putSellPremiumUsd: number | null;
  readonly putNetPremiumCvdUsd: number | null;
  readonly netDirectionalPremiumUsd: number | null;
  readonly netDeltaShares: number | null;
  readonly netVegaUsd: number | null;
  readonly byStrikeFlow: readonly StrikeOrderFlowBucket[];
}

interface ExpectedMadContract {
  readonly contractTicker: string;
  readonly strike: number;
  readonly expiryUtcSec: number;
  readonly contractType: 'call' | 'put';
  readonly dteDays: number;
  readonly dteBucket: DteBucket;
  readonly logMoneynessAbs: number;
  readonly moneynessBucket: MoneynessBucket;
  readonly dayVolume: number;
  readonly openInterest: number;
  readonly volOiRatio: number;
  readonly logVolOiRatio: number;
  readonly bucketMedianLogRatio: number | null;
  readonly bucketMadLogRatio: number | null;
  readonly madLogScore: number | null;
  readonly isAnomaly: boolean;
  readonly delta: number;
  readonly vegaPer1Pct: number;
}

interface ExpectedMadResult {
  readonly asOfUtcSec: number;
  readonly evaluatedContracts: number;
  readonly skippedContracts: number;
  readonly contracts: readonly ExpectedMadContract[];
  readonly anomalies: readonly ExpectedMadContract[];
}

interface ExpectedFlowAdjustedStrike {
  readonly strike: number;
  readonly callStructuralSign: number;
  readonly putStructuralSign: number;
  readonly callDealerFlowSign: number | null;
  readonly putDealerFlowSign: number | null;
  readonly callEffectiveSign: number;
  readonly putEffectiveSign: number;
  readonly callSignedDollarGex: number;
  readonly putSignedDollarGex: number;
  readonly netSignedDollarGex: number;
  readonly netCharmExposure: number;
}

interface ExpectedFlowAdjustedGex {
  readonly spot: number;
  readonly priorWeight: number;
  readonly evaluatedContractsCount: number;
  readonly skippedContractsCount: number;
  readonly totalSignedDollarGex: number | null;
  readonly totalCharmExposure: number | null;
  readonly callWallStrike: number | null;
  readonly putWallStrike: number | null;
  readonly byStrike: readonly ExpectedFlowAdjustedStrike[];
}

interface ExpectedStrikePinWeight {
  readonly strike: number;
  readonly absDollarGex: number;
  readonly absCharmExposure: number;
  readonly normalizedGexShare: number;
  readonly normalizedCharmShare: number;
  readonly combinedWeight: number;
}

interface ExpectedGexCharmPin {
  readonly gexCharmPinStrike: number | null;
  readonly peakPinStrike: number | null;
  readonly pinMagnetStrength: number | null;
  readonly eligibleContractsCount: number;
  readonly strikeWeights: readonly ExpectedStrikePinWeight[];
}

interface ExpectedWheelResult {
  readonly asOfUtcSec: number;
  readonly regime: WheelRegimeClassification;
  readonly spotChange: number | null;
  readonly spotReturnPct: number | null;
  readonly gammaFlipChange: number | null;
  readonly gexCharmPinChange: number | null;
  readonly netDeltaSharesChange: number | null;
  readonly distanceToPinPct: number | null;
  readonly isLateSessionEt: boolean;
  readonly snapshotsCount: number;
}

interface OptionsFlowPinFixture {
  readonly inputs: {
    readonly tBase: number;
    readonly t0dteExp: number;
    readonly t3dteExp: number;
    readonly t15dteExp: number;
    readonly t45dteExp: number;
    readonly tOpen1000: number;
    readonly tMid1130: number;
    readonly tLate1510: number;
    readonly classificationCases: readonly ClassificationCaseFixture[];
    readonly flowContext: OpraOrderFlowMarketContext;
    readonly flowPrints: readonly OpraTradePrintInput[];
    readonly madContracts: readonly VolOiAnomalyContractInput[];
    readonly gexMarket: ExposureMarketInputs;
    readonly gexContracts: readonly ExposureContractInput[];
  };
  readonly expected: {
    readonly classifications: Record<string, ExpectedClassification>;
    readonly orderFlow: ExpectedOrderFlow;
    readonly madAnomalies: ExpectedMadResult;
    readonly flowAdjustedGexStructural: ExpectedFlowAdjustedGex;
    readonly flowAdjustedGexFlipped: ExpectedFlowAdjustedGex;
    readonly gexCharmPin: ExpectedGexCharmPin;
    readonly wheelTrackerCases: Record<string, ExpectedWheelResult>;
  };
}

function loadFixture(): OptionsFlowPinFixture {
  const path = resolve(process.cwd(), 'fixtures', 'options_flow_pin_reference.json');
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as OptionsFlowPinFixture;
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

function expectCloseOrNaN(actual: number, expected: number | null): void {
  precisionStats.scalarsChecked += 1;
  if (expected === null) {
    expect(Number.isNaN(actual)).toBe(true);
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

describe('Pieza 16: OPRA Options Order Flow, MAD Anomalies & GEX/Charm Pin Tracker', () => {
  const fixture = deepFreeze(loadFixture());

  afterAll(() => {
    console.log(
      `[optionsFlowPin.test] Fixture precision summary: ${String(precisionStats.scalarsChecked)} scalars checked, maxRelDiff(|x|>=1e-6)=${precisionStats.maxRelDiff.toExponential(3)}, maxNearZeroAbsDiff=${precisionStats.maxNearZeroAbsDiff.toExponential(3)}, maxAbsDiff=${precisionStats.maxAbsDiff.toExponential(3)} (limit < 1e-11)`,
    );
  });

  describe('Parity vs Python Reference (< 1e-11)', () => {
    it('matches OPRA trade side classification across Ask, Bid, Mid tick rule and invalid quotes', () => {
      for (const tc of fixture.inputs.classificationCases) {
        const expected = fixture.expected.classifications[tc.name];
        expect(expected).toBeDefined();
        if (expected === undefined) {
          continue;
        }
        const actual =
          tc.prevPrice === null
            ? classifyOpraTradePrint(tc.price, tc.bid, tc.ask)
            : classifyOpraTradePrint(tc.price, tc.bid, tc.ask, tc.prevPrice);
        expect(actual.side).toBe(expected.side);
        expect(actual.aggressorSign).toBe(expected.aggressorSign);
        expectCloseOrNaN(actual.midpoint, expected.midpoint);
      }
    });

    it('matches computeSignedOptionsOrderFlow ("La Plata Neta de la Rueda") and strike buckets', () => {
      const actual = computeSignedOptionsOrderFlow(
        fixture.inputs.flowPrints,
        fixture.inputs.flowContext,
      );
      const exp = fixture.expected.orderFlow;

      expect(actual.asOfUtcSec).toBe(exp.asOfUtcSec);
      expect(actual.evaluatedPrints).toBe(exp.evaluatedPrints);
      expect(actual.skippedPrints).toBe(exp.skippedPrints);
      expectCloseOrNaN(actual.callBuyPremiumUsd, exp.callBuyPremiumUsd);
      expectCloseOrNaN(actual.callSellPremiumUsd, exp.callSellPremiumUsd);
      expectCloseOrNaN(actual.callNetPremiumCvdUsd, exp.callNetPremiumCvdUsd);
      expectCloseOrNaN(actual.putBuyPremiumUsd, exp.putBuyPremiumUsd);
      expectCloseOrNaN(actual.putSellPremiumUsd, exp.putSellPremiumUsd);
      expectCloseOrNaN(actual.putNetPremiumCvdUsd, exp.putNetPremiumCvdUsd);
      expectCloseOrNaN(actual.netDirectionalPremiumUsd, exp.netDirectionalPremiumUsd);
      expectCloseOrNaN(actual.netDeltaShares, exp.netDeltaShares);
      expectCloseOrNaN(actual.netVegaUsd, exp.netVegaUsd);

      expect(actual.byStrikeFlow).toHaveLength(exp.byStrikeFlow.length);
      for (let i = 0; i < exp.byStrikeFlow.length; i += 1) {
        const aRow = actual.byStrikeFlow[i];
        const eRow = exp.byStrikeFlow[i];
        expect(aRow).toBeDefined();
        expect(eRow).toBeDefined();
        if (aRow === undefined || eRow === undefined) {
          continue;
        }
        expect(aRow.strike).toBe(eRow.strike);
        expect(aRow.callBuyVolume).toBe(eRow.callBuyVolume);
        expect(aRow.callSellVolume).toBe(eRow.callSellVolume);
        expect(aRow.putBuyVolume).toBe(eRow.putBuyVolume);
        expect(aRow.putSellVolume).toBe(eRow.putSellVolume);
        expect(aRow.netCallAggressiveContracts).toBe(eRow.netCallAggressiveContracts);
        expect(aRow.netPutAggressiveContracts).toBe(eRow.netPutAggressiveContracts);
        expectCloseOrNaN(aRow.callBuyPremiumUsd, eRow.callBuyPremiumUsd);
        expectCloseOrNaN(aRow.callSellPremiumUsd, eRow.callSellPremiumUsd);
        expectCloseOrNaN(aRow.putBuyPremiumUsd, eRow.putBuyPremiumUsd);
        expectCloseOrNaN(aRow.putSellPremiumUsd, eRow.putSellPremiumUsd);
        expectCloseOrNaN(aRow.netDeltaShares, eRow.netDeltaShares);
        expectCloseOrNaN(aRow.netVegaUsd, eRow.netVegaUsd);
      }
    });

    it('matches stratified Vol/OI MAD anomaly detector and NaN propagation on zero-MAD / small buckets', () => {
      const actual = detectVolOiAnomaliesMad(
        fixture.inputs.madContracts,
        fixture.inputs.flowContext,
      );
      const exp = fixture.expected.madAnomalies;

      expect(actual.asOfUtcSec).toBe(exp.asOfUtcSec);
      expect(actual.evaluatedContracts).toBe(exp.evaluatedContracts);
      expect(actual.skippedContracts).toBe(exp.skippedContracts);
      expect(actual.contracts).toHaveLength(exp.contracts.length);

      for (let i = 0; i < exp.contracts.length; i += 1) {
        const aItem = actual.contracts[i];
        const eItem = exp.contracts[i];
        expect(aItem).toBeDefined();
        expect(eItem).toBeDefined();
        if (aItem === undefined || eItem === undefined) {
          continue;
        }
        expect(aItem.contractTicker).toBe(eItem.contractTicker);
        expect(aItem.dteDays).toBe(eItem.dteDays);
        expect(aItem.dteBucket).toBe(eItem.dteBucket);
        expect(aItem.moneynessBucket).toBe(eItem.moneynessBucket);
        expectCloseOrNaN(aItem.logMoneynessAbs, eItem.logMoneynessAbs);
        expectCloseOrNaN(aItem.volOiRatio, eItem.volOiRatio);
        expectCloseOrNaN(aItem.logVolOiRatio, eItem.logVolOiRatio);
        expectCloseOrNaN(aItem.bucketMedianLogRatio, eItem.bucketMedianLogRatio);
        expectCloseOrNaN(aItem.bucketMadLogRatio, eItem.bucketMadLogRatio);
        expectCloseOrNaN(aItem.madLogScore, eItem.madLogScore);
        expect(aItem.isAnomaly).toBe(eItem.isAnomaly);
        expectCloseOrNaN(aItem.delta, eItem.delta);
        expectCloseOrNaN(aItem.vegaPer1Pct, eItem.vegaPer1Pct);
      }

      expect(actual.anomalies.map((a) => a.contractTicker)).toEqual(['C0_525_ANOM']);
      expectCloseOrNaN(
        actual.anomalies[0]?.madLogScore ?? Number.NaN,
        exp.anomalies[0]?.madLogScore ?? null,
      );
    });

    it('matches flow-adjusted Signed GEX under structural (prior=1.0) and flow-flipped (prior=0.2) regimes', () => {
      const flow = computeSignedOptionsOrderFlow(
        fixture.inputs.flowPrints,
        fixture.inputs.flowContext,
      );

      const cases: readonly {
        readonly priorWeight: number;
        readonly expected: ExpectedFlowAdjustedGex;
      }[] = [
        { priorWeight: 1.0, expected: fixture.expected.flowAdjustedGexStructural },
        { priorWeight: 0.2, expected: fixture.expected.flowAdjustedGexFlipped },
      ];

      for (const tc of cases) {
        const actual = computeFlowAdjustedSignedGex(
          fixture.inputs.gexContracts,
          fixture.inputs.gexMarket,
          flow.byStrikeFlow,
          { priorWeight: tc.priorWeight },
        );
        const exp = tc.expected;
        expect(actual.evaluatedContractsCount).toBe(exp.evaluatedContractsCount);
        expect(actual.skippedContractsCount).toBe(exp.skippedContractsCount);
        expectCloseOrNaN(actual.totalSignedDollarGex, exp.totalSignedDollarGex);
        expectCloseOrNaN(actual.totalCharmExposure, exp.totalCharmExposure);
        expectCloseOrNaN(actual.callWallStrike, exp.callWallStrike);
        expectCloseOrNaN(actual.putWallStrike, exp.putWallStrike);
        expect(actual.byStrike).toHaveLength(exp.byStrike.length);

        for (let i = 0; i < exp.byStrike.length; i += 1) {
          const aRow = actual.byStrike[i];
          const eRow = exp.byStrike[i];
          expect(aRow).toBeDefined();
          expect(eRow).toBeDefined();
          if (aRow === undefined || eRow === undefined) {
            continue;
          }
          expect(aRow.strike).toBe(eRow.strike);
          expectCloseOrNaN(aRow.callDealerFlowSign, eRow.callDealerFlowSign);
          expectCloseOrNaN(aRow.putDealerFlowSign, eRow.putDealerFlowSign);
          expectCloseOrNaN(aRow.callEffectiveSign, eRow.callEffectiveSign);
          expectCloseOrNaN(aRow.putEffectiveSign, eRow.putEffectiveSign);
          expectCloseOrNaN(aRow.callSignedDollarGex, eRow.callSignedDollarGex);
          expectCloseOrNaN(aRow.putSignedDollarGex, eRow.putSignedDollarGex);
          expectCloseOrNaN(aRow.netSignedDollarGex, eRow.netSignedDollarGex);
          expectCloseOrNaN(aRow.netCharmExposure, eRow.netCharmExposure);
        }
      }

      // Verify dealer sign inversion actually shifted both Call Wall and Put Wall
      expect(fixture.expected.flowAdjustedGexStructural.callWallStrike).toBe(500);
      expect(fixture.expected.flowAdjustedGexFlipped.callWallStrike).toBe(505);
      expect(fixture.expected.flowAdjustedGexStructural.putWallStrike).toBe(490);
      expect(fixture.expected.flowAdjustedGexFlipped.putWallStrike).toBe(500);
    });

    it('matches computeGexCharmPin filtering short DTE and weighting GEX + Charm magnet', () => {
      const actual = computeGexCharmPin(
        fixture.inputs.gexContracts,
        fixture.inputs.gexMarket,
        { maxPinDte: 7, gexWeight: 0.6, charmWeight: 0.4 },
      );
      const exp = fixture.expected.gexCharmPin;

      expect(actual.eligibleContractsCount).toBe(exp.eligibleContractsCount);
      expectCloseOrNaN(actual.gexCharmPinStrike, exp.gexCharmPinStrike);
      expectCloseOrNaN(actual.peakPinStrike, exp.peakPinStrike);
      expectCloseOrNaN(actual.pinMagnetStrength, exp.pinMagnetStrength);
      expect(actual.strikeWeights).toHaveLength(exp.strikeWeights.length);

      for (let i = 0; i < exp.strikeWeights.length; i += 1) {
        const aW = actual.strikeWeights[i];
        const eW = exp.strikeWeights[i];
        expect(aW).toBeDefined();
        expect(eW).toBeDefined();
        if (aW === undefined || eW === undefined) {
          continue;
        }
        expect(aW.strike).toBe(eW.strike);
        expectCloseOrNaN(aW.absDollarGex, eW.absDollarGex);
        expectCloseOrNaN(aW.absCharmExposure, eW.absCharmExposure);
        expectCloseOrNaN(aW.normalizedGexShare, eW.normalizedGexShare);
        expectCloseOrNaN(aW.normalizedCharmShare, eW.normalizedCharmShare);
        expectCloseOrNaN(aW.combinedWeight, eW.combinedWeight);
      }
    });

    it('matches Wheel-by-Wheel Tracker across all 6 regimes + causal NO_DATA', () => {
      const { tOpen1000, tMid1130, tLate1510 } = fixture.inputs;

      const scenarioInputs: Record<
        string,
        { readonly snapshots: readonly WheelSnapshotInput[]; readonly asOf: number }
      > = {
        PINNING_REGIME: {
          asOf: tLate1510,
          snapshots: [
            { timestampUtcSec: tOpen1000, spot: 499.0, gammaFlip: 498.0, gexCharmPin: 500.2, netDeltaShares: 10000 },
            { timestampUtcSec: tLate1510, spot: 500.1, gammaFlip: 498.5, gexCharmPin: 500.2, netDeltaShares: 12000 },
          ],
        },
        DERIVATIVES_CONFIRMED_UPTREND: {
          asOf: tMid1130,
          snapshots: [
            { timestampUtcSec: tOpen1000, spot: 500.0, gammaFlip: 498.0, gexCharmPin: 505.0, netDeltaShares: 10000 },
            { timestampUtcSec: tMid1130, spot: 503.0, gammaFlip: 499.5, gexCharmPin: 506.0, netDeltaShares: 55000 },
          ],
        },
        UNSUPPORTED_SPOT_RALLY: {
          asOf: tMid1130,
          snapshots: [
            { timestampUtcSec: tOpen1000, spot: 500.0, gammaFlip: 498.0, gexCharmPin: 505.0, netDeltaShares: 10000 },
            { timestampUtcSec: tMid1130, spot: 503.0, gammaFlip: 496.5, gexCharmPin: 504.0, netDeltaShares: -25000 },
          ],
        },
        DERIVATIVES_CONFIRMED_DOWNTREND: {
          asOf: tMid1130,
          snapshots: [
            { timestampUtcSec: tOpen1000, spot: 500.0, gammaFlip: 498.0, gexCharmPin: 495.0, netDeltaShares: -5000 },
            { timestampUtcSec: tMid1130, spot: 496.5, gammaFlip: 495.5, gexCharmPin: 494.0, netDeltaShares: -65000 },
          ],
        },
        UNSUPPORTED_SPOT_SELLOFF: {
          asOf: tMid1130,
          snapshots: [
            { timestampUtcSec: tOpen1000, spot: 500.0, gammaFlip: 498.0, gexCharmPin: 495.0, netDeltaShares: -5000 },
            { timestampUtcSec: tMid1130, spot: 496.5, gammaFlip: 499.0, gexCharmPin: 496.0, netDeltaShares: 40000 },
          ],
        },
        NEUTRAL: {
          asOf: tMid1130,
          snapshots: [
            { timestampUtcSec: tOpen1000, spot: 500.0, gammaFlip: 498.0, gexCharmPin: 502.0, netDeltaShares: 1000 },
            { timestampUtcSec: tMid1130, spot: 500.1, gammaFlip: 498.0, gexCharmPin: 502.0, netDeltaShares: 1500 },
          ],
        },
        NO_DATA_CAUSAL: {
          asOf: tMid1130,
          snapshots: [
            { timestampUtcSec: tOpen1000, spot: 500.0, gammaFlip: 498.0, gexCharmPin: 502.0, netDeltaShares: 1000 },
            { timestampUtcSec: tLate1510, spot: 504.0, gammaFlip: 500.0, gexCharmPin: 504.0, netDeltaShares: 50000 },
          ],
        },
      };

      for (const [name, cfg] of Object.entries(scenarioInputs)) {
        deepFreeze(cfg.snapshots);
        const actual = evaluateWheelByWheelTracker(cfg.snapshots, cfg.asOf);
        const exp = fixture.expected.wheelTrackerCases[name];
        expect(exp).toBeDefined();
        if (exp === undefined) {
          continue;
        }
        expect(actual.regime).toBe(exp.regime);
        expect(actual.isLateSessionEt).toBe(exp.isLateSessionEt);
        expect(actual.snapshotsCount).toBe(exp.snapshotsCount);
        expectCloseOrNaN(actual.spotChange, exp.spotChange);
        expectCloseOrNaN(actual.spotReturnPct, exp.spotReturnPct);
        expectCloseOrNaN(actual.gammaFlipChange, exp.gammaFlipChange);
        expectCloseOrNaN(actual.gexCharmPinChange, exp.gexCharmPinChange);
        expectCloseOrNaN(actual.netDeltaSharesChange, exp.netDeltaSharesChange);
        expectCloseOrNaN(actual.distanceToPinPct, exp.distanceToPinPct);
      }
    });
  });

  describe('Financial Signs, Causality, Zero Silent Fallbacks & Edge Cases', () => {
    it('enforces exact delta/vega signs across all 4 OPRA trade quadrants', () => {
      const ctx = fixture.inputs.flowContext;
      const t0 = fixture.inputs.tBase + 10;
      const exp3d = fixture.inputs.t3dteExp;

      // 1. Call Ask Buy (+delta * +1 > 0)
      const callAsk = computeSignedOptionsOrderFlow(
        [
          {
            timestampUtcSec: t0,
            strike: 500,
            expiryUtcSec: exp3d,
            contractType: 'call',
            price: 4.2,
            size: 10,
            bid: 4.1,
            ask: 4.2,
            impliedVolatility: 0.21,
          },
        ],
        ctx,
      );
      expect(callAsk.netDeltaShares).toBeGreaterThan(0);
      expect(callAsk.netVegaUsd).toBeGreaterThan(0);
      expect(callAsk.netDirectionalPremiumUsd).toBe(4200);

      // 2. Call Bid Sell (+delta * -1 < 0)
      const callBid = computeSignedOptionsOrderFlow(
        [
          {
            timestampUtcSec: t0,
            strike: 500,
            expiryUtcSec: exp3d,
            contractType: 'call',
            price: 4.1,
            size: 10,
            bid: 4.1,
            ask: 4.2,
            impliedVolatility: 0.21,
          },
        ],
        ctx,
      );
      expect(callBid.netDeltaShares).toBeLessThan(0);
      expect(callBid.netVegaUsd).toBeLessThan(0);
      expect(callBid.netDirectionalPremiumUsd).toBe(-4100);

      // 3. Put Ask Buy (-|delta| * +1 < 0, vega * +1 > 0)
      const putAsk = computeSignedOptionsOrderFlow(
        [
          {
            timestampUtcSec: t0,
            strike: 500,
            expiryUtcSec: exp3d,
            contractType: 'put',
            price: 3.9,
            size: 10,
            bid: 3.8,
            ask: 3.9,
            impliedVolatility: 0.21,
          },
        ],
        ctx,
      );
      expect(putAsk.netDeltaShares).toBeLessThan(0);
      expect(putAsk.netVegaUsd).toBeGreaterThan(0);
      expect(putAsk.netDirectionalPremiumUsd).toBe(-3900);

      // 4. Put Bid Sell (-|delta| * -1 > 0 bullish!, vega * -1 < 0)
      const putBid = computeSignedOptionsOrderFlow(
        [
          {
            timestampUtcSec: t0,
            strike: 500,
            expiryUtcSec: exp3d,
            contractType: 'put',
            price: 3.8,
            size: 10,
            bid: 3.8,
            ask: 3.9,
            impliedVolatility: 0.21,
          },
        ],
        ctx,
      );
      expect(putBid.netDeltaShares).toBeGreaterThan(0);
      expect(putBid.netVegaUsd).toBeLessThan(0);
      expect(putBid.netDirectionalPremiumUsd).toBe(3800);
    });

    it('supports American model Greeks calculation and rejects NaN without fallbacks', () => {
      const ctxAmerican: OpraOrderFlowMarketContext = {
        ...fixture.inputs.flowContext,
        model: 'american',
      };
      const res = computeSignedOptionsOrderFlow(
        fixture.inputs.flowPrints.slice(0, 2),
        ctxAmerican,
      );
      expect(res.evaluatedPrints).toBe(2);
      expect(Number.isFinite(res.netDeltaShares)).toBe(true);
      expect(Number.isFinite(res.netVegaUsd)).toBe(true);

      // All prints uncomputable (NaN IV + invalid quote) -> NaN aggregates, zero fallbacks
      const emptyRes = computeSignedOptionsOrderFlow(
        [
          {
            timestampUtcSec: fixture.inputs.tBase,
            strike: 500,
            expiryUtcSec: fixture.inputs.t3dteExp,
            contractType: 'call',
            price: 4.2,
            size: 10,
            bid: 0,
            ask: 4.2,
          },
        ],
        ctxAmerican,
      );
      expect(emptyRes.evaluatedPrints).toBe(0);
      expect(emptyRes.skippedPrints).toBe(1);
      expect(Number.isNaN(emptyRes.netDeltaShares)).toBe(true);
      expect(Number.isNaN(emptyRes.netDirectionalPremiumUsd)).toBe(true);
      expect(emptyRes.byStrikeFlow).toEqual([]);
    });

    it('isolates strictly 0DTE contracts when maxPinDte is 0 and returns NaN on invalid market inputs', () => {
      const pin0dte = computeGexCharmPin(
        fixture.inputs.gexContracts,
        fixture.inputs.gexMarket,
        { maxPinDte: 0 },
      );
      expect(pin0dte.eligibleContractsCount).toBe(1);
      expect(pin0dte.gexCharmPinStrike).toBeCloseTo(505, 11);
      expect(pin0dte.peakPinStrike).toBe(505);
      expect(pin0dte.pinMagnetStrength).toBeCloseTo(1, 11);

      const invalidMarket: ExposureMarketInputs = {
        spot: Number.NaN,
        nowUtcSec: fixture.inputs.tBase,
        rate: 0.045,
        dividendYield: 0.013,
      };
      const badGex = computeFlowAdjustedSignedGex(
        fixture.inputs.gexContracts,
        invalidMarket,
        [],
      );
      expect(Number.isNaN(badGex.totalSignedDollarGex)).toBe(true);
      expect(Number.isNaN(badGex.callWallStrike)).toBe(true);

      const badPin = computeGexCharmPin(fixture.inputs.gexContracts, invalidMarket);
      expect(Number.isNaN(badPin.gexCharmPinStrike)).toBe(true);
    });
  });
});
