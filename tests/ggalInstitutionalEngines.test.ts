import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  computeDlrForwardKink,
  computeHayashiYoshidaLeadLag,
  computeL2Microstructure,
  computeL2WeightedPinScore,
  computeVpinBuckets,
  computeYangZhangVol,
  convertArsPriceToCoord,
  convertOhlcBarToCoord,
  detectIcebergReload,
  extractOtmWingCclImpliedVol,
  updateElectoralMarkovRegime,
  type CrossBankTickSeriesMap,
  type DlrCurvePointInput,
  type IcebergDetectionInput,
  type OtmWingCclIvInput,
  type VpinComputationInput,
  type YangZhangOhlcBar,
} from '../src/core/ggal/l2AndRegimeEngines.js';
import type {
  GgalChartBarPoint,
  GgalElectoralObservables,
  GgalL2LadderState,
  GgalL2OrderLevel,
} from '../src/core/ggal/types.js';
import { ArFeedRouter } from '../src/server/arFeedRouter.js';
import { OratsHybridClient } from '../src/server/oratsHybridClient.js';

const TOLERANCE = 1e-11;
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(TEST_DIR, '../fixtures/ggal_institutional_reference.json');

interface InstitutionalReferenceFixture {
  readonly schemaVersion: string;
  readonly motor8: {
    readonly bids: readonly GgalL2OrderLevel[];
    readonly asks: readonly GgalL2OrderLevel[];
    readonly decayAlpha: number;
    readonly expectedL2Metrics: {
      readonly bestBid: number;
      readonly bestAsk: number;
      readonly midPrice: number;
      readonly spreadAbs: number;
      readonly spreadBps: number;
      readonly obiL1: number;
      readonly obiMultiLevel: number;
      readonly micropriceL1: number;
      readonly micropriceMultiLevel: number;
      readonly totalBidDepth5: number;
      readonly totalAskDepth5: number;
    };
    readonly icebergInput: IcebergDetectionInput;
    readonly expectedIceberg: {
      readonly detected: boolean;
      readonly side: 'BID' | 'ASK' | 'NONE';
      readonly priceLevel: number | null;
      readonly executedVolumeAtBest: number;
      readonly visibleDropAtBest: number;
      readonly reloadedVolumeEstimate: number;
      readonly reloadRatio: number;
    };
    readonly vpinInput: {
      readonly trades: VpinComputationInput['trades'];
      readonly adv20Shares: number;
      readonly windowBuckets: number;
      readonly bucketAdvFraction: number;
    };
    readonly expectedVpin: {
      readonly bucketSizeShares: number;
      readonly windowBuckets: number;
      readonly populatedBuckets: number;
      readonly vpin: number;
      readonly percentileRank: number;
      readonly toxicAlert: boolean;
      readonly bucketSeries: readonly number[];
    };
  };
  readonly motor9: {
    readonly yzBars: readonly YangZhangOhlcBar[];
    readonly expectedYangZhangVol: number;
    readonly dlrCurve: readonly DlrCurvePointInput[];
    readonly expectedDlrKink: {
      readonly available: true;
      readonly maxSecondDifferencePct: number;
      readonly peakMaturityLabel: string;
      readonly peakForwardRate: number;
      readonly annualizedTermSlopePct: number;
      readonly curvePointsCount: number;
    };
    readonly lagGrid: readonly number[];
    readonly seriesByBank: CrossBankTickSeriesMap;
    readonly expectedHayashiYoshida: {
      readonly available: true;
      readonly leader: 'GGAL' | 'BMA' | 'BBAR' | 'SUPV';
      readonly leaderAverageLeadScore: number;
      readonly byBankScore: Readonly<Record<'GGAL' | 'BMA' | 'BBAR' | 'SUPV', number>>;
    };
    readonly hamiltonTailInput: {
      readonly priorProbabilities: readonly [number, number, number];
      readonly observables: GgalElectoralObservables;
      readonly yangZhangVol20d: number;
    };
    readonly expectedHamiltonTail: {
      readonly currentRegime: 'CALM_COMPRESSION' | 'FX_BRECHA_TENSION' | 'ELECTORAL_TAIL_JUMP';
      readonly posteriorProbabilities: readonly [number, number, number];
      readonly likelihoods: readonly [number, number, number];
      readonly effectiveJumpIntensity: number;
      readonly kellyFractionMultiplier: number;
      readonly overnightCvar99Pct: number;
      readonly recommendedHedgeWeights: {
        readonly dlrFuturesWeight: number;
        readonly otmPutWingWeight: number;
        readonly cashArsCollarWeight: number;
        readonly adrDeltaHedgeWeight: number;
      };
    };
    readonly hamiltonCalmInput: {
      readonly priorProbabilities: readonly [number, number, number];
      readonly observables: GgalElectoralObservables;
      readonly yangZhangVol20d: number;
    };
    readonly expectedHamiltonCalm: {
      readonly currentRegime: 'CALM_COMPRESSION' | 'FX_BRECHA_TENSION' | 'ELECTORAL_TAIL_JUMP';
      readonly posteriorProbabilities: readonly [number, number, number];
      readonly effectiveJumpIntensity: number;
      readonly kellyFractionMultiplier: number;
      readonly overnightCvar99Pct: number;
    };
  };
  readonly enhancements: {
    readonly otmWingInput: OtmWingCclIvInput;
    readonly expectedOtmWingCcl: {
      readonly status: 'OPERATIONAL' | 'UNAVAILABLE';
      readonly extractedCclImplVol: number;
      readonly callOverwritingCompressionPct: number;
      readonly selectedWingsCount: number;
    };
    readonly l2PinInput: {
      readonly asOfUtcSec: number;
      readonly pinStrikeArs: number;
      readonly spotArs: number;
      readonly baseAnexoBPinScore: number;
    };
    readonly expectedL2Pin: {
      readonly distancePct: number;
      readonly l2DepthConfirmationRatio: number;
      readonly isClosingWindow1530Art: boolean;
      readonly weightedPinScore: number;
    };
  };
  readonly coordinates: {
    readonly arsPrice: number;
    readonly cclRate: number;
    readonly adrReferenceUsd: number;
    readonly expectedUsdAdr: number;
    readonly expectedRatioCcl: number;
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const prop of Object.values(value as Record<string, unknown>)) {
      if (prop !== null && typeof prop === 'object' && !Object.isFrozen(prop)) {
        deepFreeze(prop);
      }
    }
  }
  return value;
}

const FIXTURE = deepFreeze(
  JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as InstitutionalReferenceFixture,
);

function expectClose(actual: number, expected: number, tol = TOLERANCE): void {
  expect(Number.isFinite(actual)).toBe(true);
  expect(Math.abs(actual - expected)).toBeLessThan(tol);
}

describe('GGAL Specialist Institutional Engines (Pieza 28)', () => {
  it('Motor 8: matches Python L1-L5 microprice, OBI decay, iceberg reload & 50-bucket VPIN within 1e-11', () => {
    const ladder: GgalL2LadderState = deepFreeze({
      available: true,
      activeProvider: 'PRIMARY_MATRIZ_WS',
      qualityTier: 'REALTIME_L2_TICK',
      asOfUtcSec: 1760000100,
      symbol: 'GGAL',
      bids: FIXTURE.motor8.bids,
      asks: FIXTURE.motor8.asks,
    });

    const vpinInput: VpinComputationInput = deepFreeze({
      trades: FIXTURE.motor8.vpinInput.trades,
      adv20Shares: FIXTURE.motor8.vpinInput.adv20Shares,
      windowBuckets: FIXTURE.motor8.vpinInput.windowBuckets,
      bucketAdvFraction: FIXTURE.motor8.vpinInput.bucketAdvFraction,
      historicalVpinDistribution: null,
    });

    const metrics = computeL2Microstructure({
      ladder,
      decayAlpha: FIXTURE.motor8.decayAlpha,
      icebergInput: FIXTURE.motor8.icebergInput,
      vpinInput,
    });

    expect(metrics.status).toBe('OPERATIONAL');
    if (metrics.status !== 'OPERATIONAL') {
      throw new Error('Expected operational L2 metrics');
    }

    const exp = FIXTURE.motor8.expectedL2Metrics;
    expectClose(metrics.bestBid, exp.bestBid);
    expectClose(metrics.bestAsk, exp.bestAsk);
    expectClose(metrics.midPrice, exp.midPrice);
    expectClose(metrics.spreadAbs, exp.spreadAbs);
    expectClose(metrics.spreadBps, exp.spreadBps);
    expectClose(metrics.obiL1, exp.obiL1);
    expectClose(metrics.obiMultiLevel, exp.obiMultiLevel);
    expectClose(metrics.micropriceL1, exp.micropriceL1);
    expectClose(metrics.micropriceMultiLevel, exp.micropriceMultiLevel);
    expectClose(metrics.totalBidDepth5, exp.totalBidDepth5);
    expectClose(metrics.totalAskDepth5, exp.totalAskDepth5);

    const icebergDirect = detectIcebergReload(FIXTURE.motor8.icebergInput);
    expect(icebergDirect.detected).toBe(true);
    expect(icebergDirect.side).toBe(FIXTURE.motor8.expectedIceberg.side);
    expect(metrics.iceberg.detected).toBe(true);
    expectClose(
      metrics.iceberg.reloadedVolumeEstimate,
      FIXTURE.motor8.expectedIceberg.reloadedVolumeEstimate,
    );
    expectClose(metrics.iceberg.reloadRatio, FIXTURE.motor8.expectedIceberg.reloadRatio);

    const vpinDirect = computeVpinBuckets(vpinInput);
    expect(vpinDirect.populatedBuckets).toBe(FIXTURE.motor8.expectedVpin.populatedBuckets);
    expect(vpinDirect.toxicAlert).toBe(FIXTURE.motor8.expectedVpin.toxicAlert);
    expectClose(vpinDirect.bucketSizeShares, FIXTURE.motor8.expectedVpin.bucketSizeShares);
    expectClose(vpinDirect.vpin, FIXTURE.motor8.expectedVpin.vpin);
    expectClose(vpinDirect.percentileRank, FIXTURE.motor8.expectedVpin.percentileRank);
    expect(vpinDirect.bucketSeries.length).toBe(FIXTURE.motor8.expectedVpin.bucketSeries.length);
  });

  it('Motor 8 & Motor 4: explicitly degrade to UNAVAILABLE when router drops from REALTIME_L2_TICK', () => {
    const degradedLadder: GgalL2LadderState = deepFreeze({
      available: false,
      reason: 'NON_L2_FEED_ACTIVE',
      activeProvider: 'PPI_REST',
      qualityTier: 'POLLING_L1_REST',
      asOfUtcSec: 1760000100,
      symbol: 'GGAL',
    });

    const degradedMetrics = computeL2Microstructure({
      ladder: degradedLadder,
      decayAlpha: 0.55,
      icebergInput: null,
      vpinInput: null,
    });

    expect(degradedMetrics.status).toBe('UNAVAILABLE');
    if (degradedMetrics.status === 'UNAVAILABLE') {
      expect(degradedMetrics.reason).toBe('DEGRADED_TO_NON_L2_FEED');
      expect(degradedMetrics.activeProvider).toBe('PPI_REST');
      expect(degradedMetrics.qualityTier).toBe('POLLING_L1_REST');
    }

    const degradedPin = computeL2WeightedPinScore({
      asOfUtcSec: FIXTURE.enhancements.l2PinInput.asOfUtcSec,
      pinStrikeArs: FIXTURE.enhancements.l2PinInput.pinStrikeArs,
      spotArs: FIXTURE.enhancements.l2PinInput.spotArs,
      baseAnexoBPinScore: FIXTURE.enhancements.l2PinInput.baseAnexoBPinScore,
      l2Metrics: degradedMetrics,
    });

    expect(degradedPin.status).toBe('UNAVAILABLE');
    expect(degradedPin.reason).toBe('DEGRADED_TO_NON_L2_FEED');
    expect(Number.isNaN(degradedPin.weightedPinScore)).toBe(true);
  });

  it('Motor 9: matches Python Yang-Zhang, DLR forward kink, Hayashi-Yoshida & Hamilton 3-state filter within 1e-11', () => {
    const yzVol = computeYangZhangVol(FIXTURE.motor9.yzBars, 252);
    expectClose(yzVol, FIXTURE.motor9.expectedYangZhangVol);

    const dlrKink = computeDlrForwardKink(FIXTURE.motor9.dlrCurve);
    expect(dlrKink.available).toBe(true);
    if (!dlrKink.available) {
      throw new Error('Expected operational DLR forward kink');
    }
    expect(dlrKink.peakMaturityLabel).toBe(FIXTURE.motor9.expectedDlrKink.peakMaturityLabel);
    expectClose(dlrKink.maxSecondDifferencePct, FIXTURE.motor9.expectedDlrKink.maxSecondDifferencePct);
    expectClose(dlrKink.peakForwardRate, FIXTURE.motor9.expectedDlrKink.peakForwardRate);
    expectClose(dlrKink.annualizedTermSlopePct, FIXTURE.motor9.expectedDlrKink.annualizedTermSlopePct);

    const hyLeadLag = computeHayashiYoshidaLeadLag(
      FIXTURE.motor9.seriesByBank,
      FIXTURE.motor9.lagGrid,
    );
    expect(hyLeadLag.available).toBe(true);
    if (!hyLeadLag.available) {
      throw new Error('Expected operational Hayashi-Yoshida lead-lag');
    }
    expect(hyLeadLag.leader).toBe(FIXTURE.motor9.expectedHayashiYoshida.leader);
    expectClose(
      hyLeadLag.leaderAverageLeadScore,
      FIXTURE.motor9.expectedHayashiYoshida.leaderAverageLeadScore,
    );
    expectClose(hyLeadLag.byBankScore.GGAL, FIXTURE.motor9.expectedHayashiYoshida.byBankScore.GGAL);
    expectClose(hyLeadLag.byBankScore.BMA, FIXTURE.motor9.expectedHayashiYoshida.byBankScore.BMA);
    expectClose(hyLeadLag.byBankScore.BBAR, FIXTURE.motor9.expectedHayashiYoshida.byBankScore.BBAR);
    expectClose(hyLeadLag.byBankScore.SUPV, FIXTURE.motor9.expectedHayashiYoshida.byBankScore.SUPV);

    const tailRegime = updateElectoralMarkovRegime({
      asOfUtcSec: 1760000200,
      priorProbabilities: FIXTURE.motor9.hamiltonTailInput.priorProbabilities,
      observables: FIXTURE.motor9.hamiltonTailInput.observables,
      dlrKinkDetail: dlrKink,
      leadLagDetail: hyLeadLag,
      yangZhangVol20d: yzVol,
      customTransitionMatrix: null,
    });
    expect(tailRegime.status).toBe('OPERATIONAL');
    if (tailRegime.status !== 'OPERATIONAL') {
      throw new Error('Expected operational Hamilton regime state');
    }
    expect(tailRegime.currentRegime).toBe(FIXTURE.motor9.expectedHamiltonTail.currentRegime);
    for (let i = 0; i < 3; i++) {
      expectClose(
        tailRegime.posteriorProbabilities[i] ?? Number.NaN,
        FIXTURE.motor9.expectedHamiltonTail.posteriorProbabilities[i] ?? Number.NaN,
      );
    }
    expectClose(
      tailRegime.effectiveJumpIntensity,
      FIXTURE.motor9.expectedHamiltonTail.effectiveJumpIntensity,
    );
    expectClose(
      tailRegime.kellyFractionMultiplier,
      FIXTURE.motor9.expectedHamiltonTail.kellyFractionMultiplier,
    );
    expectClose(
      tailRegime.overnightCvar99Pct,
      FIXTURE.motor9.expectedHamiltonTail.overnightCvar99Pct,
    );
    expectClose(
      tailRegime.recommendedHedgeWeights.otmPutWingWeight,
      FIXTURE.motor9.expectedHamiltonTail.recommendedHedgeWeights.otmPutWingWeight,
    );

    const calmRegime = updateElectoralMarkovRegime({
      asOfUtcSec: 1760000200,
      priorProbabilities: FIXTURE.motor9.hamiltonCalmInput.priorProbabilities,
      observables: FIXTURE.motor9.hamiltonCalmInput.observables,
      dlrKinkDetail: dlrKink,
      leadLagDetail: hyLeadLag,
      yangZhangVol20d: yzVol,
      customTransitionMatrix: null,
    });
    expect(calmRegime.status).toBe('OPERATIONAL');
    if (calmRegime.status !== 'OPERATIONAL') {
      throw new Error('Expected operational calm Hamilton regime state');
    }
    expect(calmRegime.currentRegime).toBe(FIXTURE.motor9.expectedHamiltonCalm.currentRegime);
    expectClose(
      calmRegime.kellyFractionMultiplier,
      FIXTURE.motor9.expectedHamiltonCalm.kellyFractionMultiplier,
    );
    expectClose(
      calmRegime.overnightCvar99Pct,
      FIXTURE.motor9.expectedHamiltonCalm.overnightCvar99Pct,
    );
  });

  it('Motor 2 & Motor 4 enhancements: extracts OTM wing CCL IV under Call Overwriting & computes 15:30 ART L2 PinScore within 1e-11', () => {
    const otmCcl = extractOtmWingCclImpliedVol(FIXTURE.enhancements.otmWingInput);
    expect(otmCcl.status).toBe(FIXTURE.enhancements.expectedOtmWingCcl.status);
    expect(otmCcl.selectedWingsCount).toBe(FIXTURE.enhancements.expectedOtmWingCcl.selectedWingsCount);
    expectClose(
      otmCcl.extractedCclImplVol,
      FIXTURE.enhancements.expectedOtmWingCcl.extractedCclImplVol,
    );
    expectClose(
      otmCcl.callOverwritingCompressionPct,
      FIXTURE.enhancements.expectedOtmWingCcl.callOverwritingCompressionPct,
    );

    const ladder: GgalL2LadderState = deepFreeze({
      available: true,
      activeProvider: 'PRIMARY_MATRIZ_WS',
      qualityTier: 'REALTIME_L2_TICK',
      asOfUtcSec: FIXTURE.enhancements.l2PinInput.asOfUtcSec,
      symbol: 'GGAL',
      bids: FIXTURE.motor8.bids,
      asks: FIXTURE.motor8.asks,
    });
    const l2Metrics = computeL2Microstructure({
      ladder,
      decayAlpha: FIXTURE.motor8.decayAlpha,
      icebergInput: null,
      vpinInput: null,
    });
    const pin = computeL2WeightedPinScore({
      asOfUtcSec: FIXTURE.enhancements.l2PinInput.asOfUtcSec,
      pinStrikeArs: FIXTURE.enhancements.l2PinInput.pinStrikeArs,
      spotArs: FIXTURE.enhancements.l2PinInput.spotArs,
      baseAnexoBPinScore: FIXTURE.enhancements.l2PinInput.baseAnexoBPinScore,
      l2Metrics,
    });
    expect(pin.status).toBe('OPERATIONAL');
    expect(pin.isClosingWindow1530Art).toBe(FIXTURE.enhancements.expectedL2Pin.isClosingWindow1530Art);
    expectClose(pin.distancePct, FIXTURE.enhancements.expectedL2Pin.distancePct);
    expectClose(
      pin.l2DepthConfirmationRatio,
      FIXTURE.enhancements.expectedL2Pin.l2DepthConfirmationRatio,
    );
    expectClose(pin.weightedPinScore, FIXTURE.enhancements.expectedL2Pin.weightedPinScore);
  });

  it('Coordinates: accurately maps ARS_BYMA / USD_ADR_NASDAQ / RATIO_CCL across scalars and OHLC bars', () => {
    const { arsPrice, cclRate, adrReferenceUsd, expectedUsdAdr, expectedRatioCcl } =
      FIXTURE.coordinates;

    expectClose(convertArsPriceToCoord(arsPrice, 'ARS_BYMA', cclRate, adrReferenceUsd), arsPrice);
    expectClose(
      convertArsPriceToCoord(arsPrice, 'USD_ADR_NASDAQ', cclRate, adrReferenceUsd),
      expectedUsdAdr,
    );
    expectClose(
      convertArsPriceToCoord(arsPrice, 'RATIO_CCL', cclRate, adrReferenceUsd),
      expectedRatioCcl,
    );

    const bymaBar: GgalChartBarPoint = deepFreeze({
      timeSec: 1760000000,
      open: 7100,
      high: 7320,
      low: 7050,
      close: 7200,
      volume: 420000,
    });
    const adrBar: GgalChartBarPoint = deepFreeze({
      timeSec: 1760000000,
      open: 56.8,
      high: 58.1,
      low: 56.4,
      close: 57.6,
      volume: 950000,
    });

    const convertedRatio = convertOhlcBarToCoord(bymaBar, adrBar, 'RATIO_CCL');
    expect(convertedRatio).not.toBeNull();
    if (convertedRatio === null) {
      throw new Error('Expected non-null RATIO_CCL converted bar');
    }
    expectClose(convertedRatio.open, (10 * 7100) / 56.8);
    expectClose(convertedRatio.close, (10 * 7200) / 57.6);
    expectClose(convertedRatio.high, (10 * 7320) / 56.4);
    expectClose(convertedRatio.low, (10 * 7050) / 58.1);
  });

  it('ArFeedRouter: degrades L2 ladder explicitly with NON_L2_FEED_ACTIVE when Matriz WS disconnects', () => {
    const asOf = 1760001000;
    const router = new ArFeedRouter({
      env: {
        MATRIZ_WS_URL: 'wss://matriz.example.test',
        MATRIZ_TOKEN: 'super_secret_matriz_tok',
        PPI_BASE_URL: 'https://ppi.example.test',
        PPI_API_KEY: 'ppi_key_secret',
        PPI_API_SECRET: 'ppi_sec_secret',
      },
      nowMsFn: () => asOf * 1000,
    });

    router.updateFromRuntimeTelemetry({
      asOfUtcSec: asOf,
      primaryConfigured: true,
      primaryConnected: false,
      primaryLastMsgUtcSec: asOf - 30,
      primaryError: 'WS disconnect token=super_secret_matriz_tok',
      ppiConfigured: true,
      ppiHealthy: true,
      ppiLastMsgUtcSec: asOf - 5,
      ppiError: null,
      iolConfigured: false,
      iolHealthy: false,
      iolLastMsgUtcSec: null,
      iolError: null,
      maeConfigured: false,
      maeHealthy: false,
      maeLastMsgUtcSec: null,
      maeError: null,
      bymaClearingConfigured: false,
      bymaClearingHealthy: false,
      bymaClearingLastMsgUtcSec: null,
      bymaClearingError: null,
      anexoBLoaded: false,
      anexoBLastMsgUtcSec: null,
      anexoBError: null,
      data912Reachable: true,
      data912LastMsgUtcSec: asOf - 10,
      data912Error: null,
    });

    const snap = router.getStatusSnapshot(asOf);
    expect(snap.activePrimaryEquityProvider).toBe('PPI_REST');
    expect(snap.activeQualityTier).toBe('POLLING_L1_REST');
    expect(snap.l2Available).toBe(false);
    expect(JSON.stringify(snap)).not.toContain('super_secret_matriz_tok');

    const ladder = router.resolveL2LadderState('GGAL', null, asOf);
    expect(ladder.available).toBe(false);
    if (!ladder.available) {
      expect(ladder.reason).toBe('NON_L2_FEED_ACTIVE');
      expect(ladder.activeProvider).toBe('PPI_REST');
    }
  });

  it('OratsHybridClient: parses official ORATS surface fields decoupled from Massive and redacts API key on error', async () => {
    const client = new OratsHybridClient({
      env: { ORATS_API_KEY: 'orats_secret_key_123' },
      nowMsFn: () => 1760002000_000,
      fetchFn: (url: string) => {
        if (url.includes('/cores')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                data: [
                  {
                    ticker: 'GGAL',
                    tradeDate: '2026-06-18',
                    stockPrice: 57.4,
                    smvVol: 0.442,
                    iv10d: 0.41,
                    iv20d: 0.42,
                    iv30d: 0.435,
                    iv60d: 0.45,
                    iv90d: 0.46,
                    iv6m: 0.47,
                    iv1y: 0.48,
                    exErnIv10d: 0.39,
                    exErnIv20d: 0.4,
                    exErnIv30d: 0.415,
                    exErnIv60d: 0.43,
                    exErnIv90d: 0.445,
                    fwd30_20: 0.452,
                    fwd60_30: 0.465,
                    fwd90_60: 0.471,
                    impliedMove: 0.048,
                    annIdiv: 1.35,
                    impliedNextDiv: 0.34,
                    borrow30: 0.012,
                    yieldRate: 0.023,
                  },
                ],
              }),
            text: () => Promise.resolve('{}'),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              data: [
                {
                  strike: 60,
                  expirDate: '2026-07-17',
                  dte: 29,
                  smvVol: 0.44,
                  callValue: 2.15,
                  putValue: 4.55,
                  callMidIv: 0.43,
                  putMidIv: 0.46,
                  delta: 0.38,
                  gamma: 0.042,
                  theta: -0.05,
                  vega: 0.08,
                },
              ],
            }),
          text: () => Promise.resolve('{}'),
        });
      },
    });

    const res = await client.fetchHybridSurface({
      ticker: 'GGAL',
      massiveSpotPrice: 57.6,
      massiveSpotSourceMode: 'MASSIVE_NBBO',
      yangZhangAdrVol: 0.462,
      forceRefresh: true,
    });

    expect(res.status).toBe('OPERATIONAL');
    if (res.status !== 'OPERATIONAL') {
      throw new Error('Expected OPERATIONAL ORATS hybrid surface');
    }
    expect(res.massiveSpotPrice).toBe(57.6);
    expect(res.massiveSpotSourceMode).toBe('MASSIVE_NBBO');
    expectClose(res.yangZhangAdrVol, 0.462);
    expectClose(res.smvVol, 0.442);
    expectClose(res.exErnIv30d, 0.415);
    expectClose(res.impliedMove, 0.048);
    expectClose(res.annIdiv, 1.35);
    expectClose(res.borrow30, 0.012);
    expect(res.strikes.length).toBe(1);
    expectClose(res.strikes[0]?.callValue ?? Number.NaN, 2.15);

    const unconfigured = new OratsHybridClient({ env: {}, nowMsFn: () => 1760002000_000 });
    const degraded = await unconfigured.fetchHybridSurface({
      ticker: 'GGAL',
      massiveSpotPrice: 57.6,
      massiveSpotSourceMode: 'MASSIVE_NBBO',
      yangZhangAdrVol: 0.462,
      forceRefresh: true,
    });
    expect(degraded.status).toBe('UNAVAILABLE');
    if (degraded.status === 'UNAVAILABLE') {
      expect(degraded.reason).toBe('ORATS_API_KEY_NOT_CONFIGURED');
    }
  });
});
