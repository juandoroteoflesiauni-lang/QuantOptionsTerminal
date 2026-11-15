/**
 * Pure deterministic quantitative engines for GGAL Specialist (Pieza 28):
 * - Motor 8: L2 Order Book Microstructure (`obiMultiLevel`, `micropriceL1`,
 *   `micropriceMultiLevel`, Iceberg Reload Detection, rolling 50-bucket VPIN)
 * - Motor 9: Electoral Regime 2027 3-State Hamilton Markov-Switching filter,
 *   DLR/* Forward Kink, Cross-Bank Hayashi-Yoshida Lead-Lag (GGAL/BMA/BBAR/SUPV),
 *   and Yang-Zhang Realized Volatility
 * - Motor 2 & Motor 4 enhancements: OTM Wings Implied CCL Vol extraction &
 *   L2-weighted PinScore (15:30 ART) + BYMA/ADR/CCL coordinate conversion.
 *
 * Strictly pure TypeScript: zero I/O, zero mutation of inputs, zero silent fallbacks.
 */

import type {
  GgalChartBarPoint,
  GgalCrossBankLeadLagResult,
  GgalCrossBankTicker,
  GgalDlrForwardKinkResult,
  GgalDualChartCoordMode,
  GgalElectoralObservables,
  GgalElectoralRegimeId,
  GgalElectoralRegimeState,
  GgalHayashiYoshidaPairScore,
  GgalHedgeWeightRecommendation,
  GgalIcebergReloadSignal,
  GgalL2LadderState,
  GgalL2MicrostructureMetrics,
  GgalL2OrderLevel,
  GgalVpinBucketSummary,
  L2WeightedPinScoreResult,
  OtmWingCclIvExtractionResult,
  OtmWingPointDiagnostic,
} from './institutionalContracts.js';
import {
  GGAL_ADR_RATIO,
  clamp,
  getBuenosAiresParts,
  isPositiveFinite,
  isValidUtcSec,
} from './types.js';

export const DEFAULT_L2_DECAY_ALPHA = 0.55;
export const DEFAULT_VPIN_WINDOW_BUCKETS = 50;
export const DEFAULT_VPIN_BUCKET_ADV_FRACTION = 0.02;

export interface BestQuoteSnapshot {
  readonly bidPrice: number;
  readonly bidSize: number;
  readonly askPrice: number;
  readonly askSize: number;
}

export interface IcebergDetectionInput {
  readonly previousBest: BestQuoteSnapshot;
  readonly currentBest: BestQuoteSnapshot;
  readonly executedVolumeAtBid: number;
  readonly executedVolumeAtAsk: number;
}

export interface VpinSignedTradeInput {
  readonly timeSec: number;
  readonly price: number;
  readonly buyVolume: number;
  readonly sellVolume: number;
}

export interface VpinComputationInput {
  readonly trades: readonly VpinSignedTradeInput[];
  readonly adv20Shares: number;
  readonly windowBuckets: number;
  readonly bucketAdvFraction: number;
  readonly historicalVpinDistribution: readonly number[] | null;
}

export interface L2MicrostructureEngineInput {
  readonly ladder: GgalL2LadderState;
  readonly decayAlpha: number;
  readonly icebergInput: IcebergDetectionInput | null;
  readonly vpinInput: VpinComputationInput | null;
}

export interface YangZhangOhlcBar {
  readonly timeSec: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

export interface DlrCurvePointInput {
  readonly maturityLabel: string;
  readonly daysToMaturity: number;
  readonly priceArs: number;
  readonly isElectoralWindow: boolean;
}

export interface AsyncPriceTick {
  readonly timeSec: number;
  readonly price: number;
}

export type CrossBankTickSeriesMap = Readonly<Record<GgalCrossBankTicker, readonly AsyncPriceTick[]>>;

export interface ElectoralMarkovInput {
  readonly asOfUtcSec: number;
  readonly priorProbabilities: readonly [number, number, number];
  readonly observables: GgalElectoralObservables | null;
  readonly dlrKinkDetail: GgalDlrForwardKinkResult;
  readonly leadLagDetail: GgalCrossBankLeadLagResult;
  readonly yangZhangVol20d: number;
  readonly customTransitionMatrix: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
  ] | null;
}

export interface OtmWingStrikeInput {
  readonly strikeArs: number;
  readonly side: 'CALL' | 'PUT';
  readonly absDelta: number;
  readonly bymaIv: number;
  readonly usWingIv: number;
  readonly isJul26DividendNoStrikeAdj: boolean;
}

export interface OtmWingCclIvInput {
  readonly bymaAtmIv: number;
  readonly usAtmIv: number;
  readonly corrAdrCcl: number;
  readonly jul26DividendYieldDragAnn: number;
  readonly strikes: readonly OtmWingStrikeInput[];
}

export interface L2WeightedPinScoreInput {
  readonly asOfUtcSec: number;
  readonly pinStrikeArs: number;
  readonly spotArs: number;
  readonly baseAnexoBPinScore: number;
  readonly l2Metrics: GgalL2MicrostructureMetrics;
}

const REGIME_IDS: readonly [GgalElectoralRegimeId, GgalElectoralRegimeId, GgalElectoralRegimeId] = [
  'CALM_COMPRESSION',
  'FX_BRECHA_TENSION',
  'ELECTORAL_TAIL_JUMP',
];

const DEFAULT_TRANSITION_MATRIX: readonly [
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
] = [
  [0.93, 0.06, 0.01],
  [0.08, 0.84, 0.08],
  [0.03, 0.12, 0.85],
];

// Observable vector order:
// [bankBasketIv30ExErn, ggal25DeltaSkew, sovereignLegislationSpreadPct, dlrElectoralForwardKink, crossBankLeadLagIntensity]
const EMISSION_MEANS: readonly [
  readonly [number, number, number, number, number],
  readonly [number, number, number, number, number],
  readonly [number, number, number, number, number],
] = [
  [0.38, 0.025, 0.90, 1.50, 0.18],
  [0.62, 0.085, 2.80, 7.00, 0.45],
  [0.98, 0.180, 6.00, 18.50, 0.78],
];

const EMISSION_STDS: readonly [
  readonly [number, number, number, number, number],
  readonly [number, number, number, number, number],
  readonly [number, number, number, number, number],
] = [
  [0.10, 0.025, 0.60, 1.80, 0.14],
  [0.14, 0.035, 1.10, 3.50, 0.18],
  [0.22, 0.055, 2.00, 7.50, 0.20],
];

const STATE_JUMP_INTENSITY: readonly [number, number, number] = [0.35, 1.65, 4.20];
const STATE_KELLY_MULTIPLIER: readonly [number, number, number] = [1.00, 0.55, 0.20];
const STATE_BASE_CVAR99_PCT: readonly [number, number, number] = [4.80, 11.50, 24.00];
const STATE_HEDGE_WEIGHTS: readonly [
  GgalHedgeWeightRecommendation,
  GgalHedgeWeightRecommendation,
  GgalHedgeWeightRecommendation,
] = [
  { dlrFuturesWeight: 0.15, otmPutWingWeight: 0.20, cashArsCollarWeight: 0.35, adrDeltaHedgeWeight: 0.30 },
  { dlrFuturesWeight: 0.42, otmPutWingWeight: 0.28, cashArsCollarWeight: 0.15, adrDeltaHedgeWeight: 0.15 },
  { dlrFuturesWeight: 0.38, otmPutWingWeight: 0.44, cashArsCollarWeight: 0.08, adrDeltaHedgeWeight: 0.10 },
];

const CROSS_BANK_TICKERS: readonly GgalCrossBankTicker[] = ['GGAL', 'BMA', 'BBAR', 'SUPV'];

function neutralIcebergSignal(): GgalIcebergReloadSignal {
  return {
    detected: false,
    side: 'NONE',
    priceLevel: null,
    executedVolumeAtBest: 0,
    visibleDropAtBest: 0,
    reloadedVolumeEstimate: 0,
    reloadRatio: 0,
  };
}

function emptyVpinSummary(windowBuckets: number): GgalVpinBucketSummary {
  return {
    bucketSizeShares: Number.NaN,
    windowBuckets,
    populatedBuckets: 0,
    vpin: Number.NaN,
    percentileRank: Number.NaN,
    toxicAlert: false,
    bucketSeries: [],
  };
}

/**
 * Detects iceberg order reloading at the L1 bid or ask:
 * $P_1^{\text{side}}$ remains pinned while executed volume exceeds the visible drop $\Delta Q_{\text{disp}}$.
 */
export function detectIcebergReload(input: IcebergDetectionInput): GgalIcebergReloadSignal {
  const { previousBest, currentBest, executedVolumeAtBid, executedVolumeAtAsk } = input;
  const bidPriceValid =
    isPositiveFinite(previousBest.bidPrice) &&
    isPositiveFinite(currentBest.bidPrice) &&
    Number.isFinite(previousBest.bidSize) &&
    Number.isFinite(currentBest.bidSize) &&
    previousBest.bidSize >= 0 &&
    currentBest.bidSize >= 0 &&
    Number.isFinite(executedVolumeAtBid) &&
    executedVolumeAtBid >= 0;

  const askPriceValid =
    isPositiveFinite(previousBest.askPrice) &&
    isPositiveFinite(currentBest.askPrice) &&
    Number.isFinite(previousBest.askSize) &&
    Number.isFinite(currentBest.askSize) &&
    previousBest.askSize >= 0 &&
    currentBest.askSize >= 0 &&
    Number.isFinite(executedVolumeAtAsk) &&
    executedVolumeAtAsk >= 0;

  let bidSignal: GgalIcebergReloadSignal | null = null;
  if (bidPriceValid) {
    const tolBid = 1e-8 * Math.max(1, previousBest.bidPrice);
    const sameBidPrice = Math.abs(currentBest.bidPrice - previousBest.bidPrice) <= tolBid;
    const visibleDropBid = Math.max(0, previousBest.bidSize - currentBest.bidSize);
    if (sameBidPrice && executedVolumeAtBid > visibleDropBid + 1e-9) {
      const reloaded = executedVolumeAtBid - visibleDropBid;
      bidSignal = {
        detected: true,
        side: 'BID',
        priceLevel: currentBest.bidPrice,
        executedVolumeAtBest: executedVolumeAtBid,
        visibleDropAtBest: visibleDropBid,
        reloadedVolumeEstimate: reloaded,
        reloadRatio: visibleDropBid > 0 ? executedVolumeAtBid / visibleDropBid : executedVolumeAtBid,
      };
    }
  }

  let askSignal: GgalIcebergReloadSignal | null = null;
  if (askPriceValid) {
    const tolAsk = 1e-8 * Math.max(1, previousBest.askPrice);
    const sameAskPrice = Math.abs(currentBest.askPrice - previousBest.askPrice) <= tolAsk;
    const visibleDropAsk = Math.max(0, previousBest.askSize - currentBest.askSize);
    if (sameAskPrice && executedVolumeAtAsk > visibleDropAsk + 1e-9) {
      const reloaded = executedVolumeAtAsk - visibleDropAsk;
      askSignal = {
        detected: true,
        side: 'ASK',
        priceLevel: currentBest.askPrice,
        executedVolumeAtBest: executedVolumeAtAsk,
        visibleDropAtBest: visibleDropAsk,
        reloadedVolumeEstimate: reloaded,
        reloadRatio: visibleDropAsk > 0 ? executedVolumeAtAsk / visibleDropAsk : executedVolumeAtAsk,
      };
    }
  }

  if (bidSignal !== null && askSignal !== null) {
    return bidSignal.reloadedVolumeEstimate >= askSignal.reloadedVolumeEstimate ? bidSignal : askSignal;
  }
  if (bidSignal !== null) {
    return bidSignal;
  }
  if (askSignal !== null) {
    return askSignal;
  }
  return neutralIcebergSignal();
}

/**
 * Computes rolling volume-clock VPIN over volume buckets of size
 * $V_{\text{bucket}} = \text{bucketAdvFraction} \times \text{ADV}_{20}$
 * across a rolling window of $N$ completed buckets (default $N = 50$, fraction $= 0.02$).
 */
export function computeVpinBuckets(input: VpinComputationInput): GgalVpinBucketSummary {
  const windowBuckets =
    Number.isInteger(input.windowBuckets) && input.windowBuckets >= 1
      ? input.windowBuckets
      : DEFAULT_VPIN_WINDOW_BUCKETS;
  const fraction = isPositiveFinite(input.bucketAdvFraction)
    ? input.bucketAdvFraction
    : DEFAULT_VPIN_BUCKET_ADV_FRACTION;

  if (!isPositiveFinite(input.adv20Shares)) {
    return emptyVpinSummary(windowBuckets);
  }

  const bucketSizeShares = fraction * input.adv20Shares;
  if (!isPositiveFinite(bucketSizeShares)) {
    return emptyVpinSummary(windowBuckets);
  }

  const bucketImbalances: number[] = [];
  let accBuy = 0;
  let accSell = 0;
  let accTotal = 0;

  for (const trade of input.trades) {
    if (
      !isValidUtcSec(trade.timeSec) ||
      !isPositiveFinite(trade.price) ||
      !Number.isFinite(trade.buyVolume) ||
      !Number.isFinite(trade.sellVolume) ||
      trade.buyVolume < 0 ||
      trade.sellVolume < 0
    ) {
      continue;
    }

    let remBuy = trade.buyVolume;
    let remSell = trade.sellVolume;
    let remTotal = remBuy + remSell;

    while (remTotal > 1e-12) {
      const space = bucketSizeShares - accTotal;
      if (remTotal >= space - 1e-12) {
        const takeRatio = space / remTotal;
        const sliceBuy = remBuy * takeRatio;
        const sliceSell = remSell * takeRatio;
        const bucketBuy = accBuy + sliceBuy;
        const bucketSell = accSell + sliceSell;
        bucketImbalances.push(Math.abs(bucketBuy - bucketSell) / bucketSizeShares);
        remBuy -= sliceBuy;
        remSell -= sliceSell;
        remTotal = Math.max(0, remBuy + remSell);
        accBuy = 0;
        accSell = 0;
        accTotal = 0;
      } else {
        accBuy += remBuy;
        accSell += remSell;
        accTotal += remTotal;
        remTotal = 0;
      }
    }
  }

  const completedCount = bucketImbalances.length;
  if (completedCount === 0) {
    return {
      bucketSizeShares,
      windowBuckets,
      populatedBuckets: 0,
      vpin: Number.NaN,
      percentileRank: Number.NaN,
      toxicAlert: false,
      bucketSeries: [],
    };
  }

  const startIdx = Math.max(0, completedCount - windowBuckets);
  const windowSlice = bucketImbalances.slice(startIdx);
  let sumImbalance = 0;
  for (const imb of windowSlice) {
    sumImbalance += imb;
  }
  const vpin = sumImbalance / windowSlice.length;

  // Build rolling VPIN history if more than 1 full or partial window exists,
  // or compare against supplied historical distribution.
  const rollingSeries: number[] = [];
  if (completedCount >= windowBuckets) {
    let runningSum = 0;
    for (let i = 0; i < completedCount; i++) {
      const val = bucketImbalances[i] ?? 0;
      runningSum += val;
      if (i >= windowBuckets) {
        runningSum -= bucketImbalances[i - windowBuckets] ?? 0;
      }
      if (i >= windowBuckets - 1) {
        rollingSeries.push(runningSum / windowBuckets);
      }
    }
  } else {
    for (const imb of bucketImbalances) {
      rollingSeries.push(imb);
    }
  }

  const referenceDistribution =
    input.historicalVpinDistribution !== null && input.historicalVpinDistribution.length > 0
      ? input.historicalVpinDistribution.filter((x) => Number.isFinite(x))
      : rollingSeries;

  let percentileRank = Number.NaN;
  if (referenceDistribution.length > 0) {
    let countLe = 0;
    for (const val of referenceDistribution) {
      if (val <= vpin + 1e-12) {
        countLe += 1;
      }
    }
    percentileRank = (countLe / referenceDistribution.length) * 100;
  }

  return {
    bucketSizeShares,
    windowBuckets,
    populatedBuckets: windowSlice.length,
    vpin,
    percentileRank,
    toxicAlert: Number.isFinite(percentileRank) && percentileRank >= 90,
    bucketSeries: rollingSeries,
  };
}

function validateAndSortLevels(levels: readonly GgalL2OrderLevel[]): readonly GgalL2OrderLevel[] | null {
  const valid: GgalL2OrderLevel[] = [];
  for (const lvl of levels) {
    if (
      isPositiveFinite(lvl.price) &&
      Number.isFinite(lvl.size) &&
      lvl.size >= 0 &&
      lvl.level >= 1 &&
      lvl.level <= 5
    ) {
      valid.push(lvl);
    }
  }
  if (valid.length === 0) {
    return null;
  }
  valid.sort((a, b) => a.level - b.level);
  const first = valid[0];
  if (first === undefined || first.level !== 1 || first.size < 0) {
    return null;
  }
  return valid;
}

/**
 * Motor 8: Computes L2 microstructure metrics over 5 book levels (`obiMultiLevel`
 * with exponential decay $e^{-\alpha(l-1)}$, `micropriceL1`, `micropriceMultiLevel`,
 * iceberg reload signal, and VPIN summary).
 *
 * Strictly returns `{ status: 'UNAVAILABLE', reason: 'DEGRADED_TO_NON_L2_FEED', ... }`
 * whenever the active AR feed router is not `REALTIME_L2_TICK` or `ladder.available === false`.
 */
export function computeL2Microstructure(input: L2MicrostructureEngineInput): GgalL2MicrostructureMetrics {
  const { ladder } = input;
  if (!ladder.available) {
    return {
      status: 'UNAVAILABLE',
      reason: 'DEGRADED_TO_NON_L2_FEED',
      activeProvider: ladder.activeProvider,
      qualityTier: ladder.qualityTier,
      asOfUtcSec: ladder.asOfUtcSec,
      detail: `L2 unavailable (${ladder.reason}) on tier ${ladder.qualityTier}`,
    };
  }

  const decayAlpha = Number.isFinite(input.decayAlpha) && input.decayAlpha >= 0
    ? input.decayAlpha
    : DEFAULT_L2_DECAY_ALPHA;

  const sortedBids = validateAndSortLevels(ladder.bids);
  const sortedAsks = validateAndSortLevels(ladder.asks);
  if (sortedBids === null || sortedAsks === null) {
    return {
      status: 'UNAVAILABLE',
      reason: 'INVALID_L2_INPUT',
      activeProvider: ladder.activeProvider,
      qualityTier: ladder.qualityTier,
      asOfUtcSec: ladder.asOfUtcSec,
      detail: 'Missing or invalid L1-L5 order book levels',
    };
  }

  const bestBidLevel = sortedBids[0];
  const bestAskLevel = sortedAsks[0];
  if (bestBidLevel === undefined || bestAskLevel === undefined) {
    return {
      status: 'UNAVAILABLE',
      reason: 'INSUFFICIENT_DEPTH',
      activeProvider: ladder.activeProvider,
      qualityTier: ladder.qualityTier,
      asOfUtcSec: ladder.asOfUtcSec,
      detail: 'Missing L1 bid/ask quote',
    };
  }

  if (bestAskLevel.price < bestBidLevel.price) {
    return {
      status: 'UNAVAILABLE',
      reason: 'INVALID_L2_INPUT',
      activeProvider: ladder.activeProvider,
      qualityTier: ladder.qualityTier,
      asOfUtcSec: ladder.asOfUtcSec,
      detail: 'Crossed best bid > best ask detected',
    };
  }

  const l1Total = bestBidLevel.size + bestAskLevel.size;
  if (!isPositiveFinite(l1Total)) {
    return {
      status: 'UNAVAILABLE',
      reason: 'INSUFFICIENT_DEPTH',
      activeProvider: ladder.activeProvider,
      qualityTier: ladder.qualityTier,
      asOfUtcSec: ladder.asOfUtcSec,
      detail: 'Zero L1 bid and ask depth',
    };
  }

  const obiL1 = (bestBidLevel.size - bestAskLevel.size) / l1Total;
  const micropriceL1 =
    (bestBidLevel.price * bestAskLevel.size + bestAskLevel.price * bestBidLevel.size) / l1Total;

  let weightedBidQty = 0;
  let weightedBidPxQty = 0;
  let totalBidDepth5 = 0;
  for (const bid of sortedBids) {
    const w = Math.exp(-decayAlpha * (bid.level - 1));
    weightedBidQty += w * bid.size;
    weightedBidPxQty += w * bid.size * bid.price;
    totalBidDepth5 += bid.size;
  }

  let weightedAskQty = 0;
  let weightedAskPxQty = 0;
  let totalAskDepth5 = 0;
  for (const ask of sortedAsks) {
    const w = Math.exp(-decayAlpha * (ask.level - 1));
    weightedAskQty += w * ask.size;
    weightedAskPxQty += w * ask.size * ask.price;
    totalAskDepth5 += ask.size;
  }

  const weightedTotal = weightedBidQty + weightedAskQty;
  if (!isPositiveFinite(weightedTotal) || weightedBidQty <= 0 || weightedAskQty <= 0) {
    return {
      status: 'UNAVAILABLE',
      reason: 'INSUFFICIENT_DEPTH',
      activeProvider: ladder.activeProvider,
      qualityTier: ladder.qualityTier,
      asOfUtcSec: ladder.asOfUtcSec,
      detail: 'Zero decay-weighted depth on bid or ask side',
    };
  }

  const obiMultiLevel = (weightedBidQty - weightedAskQty) / weightedTotal;
  const weightedBidPrice = weightedBidPxQty / weightedBidQty;
  const weightedAskPrice = weightedAskPxQty / weightedAskQty;
  const micropriceMultiLevel =
    (weightedBidPrice * weightedAskQty + weightedAskPrice * weightedBidQty) / weightedTotal;

  const midPrice = 0.5 * (bestBidLevel.price + bestAskLevel.price);
  const spreadAbs = bestAskLevel.price - bestBidLevel.price;
  const spreadBps = midPrice > 0 ? (spreadAbs / midPrice) * 10000 : Number.NaN;

  const iceberg = input.icebergInput !== null
    ? detectIcebergReload(input.icebergInput)
    : neutralIcebergSignal();
  const vpin = input.vpinInput !== null
    ? computeVpinBuckets(input.vpinInput)
    : emptyVpinSummary(DEFAULT_VPIN_WINDOW_BUCKETS);

  return {
    status: 'OPERATIONAL',
    activeProvider: ladder.activeProvider,
    qualityTier: 'REALTIME_L2_TICK',
    asOfUtcSec: ladder.asOfUtcSec,
    decayAlpha,
    bestBid: bestBidLevel.price,
    bestAsk: bestAskLevel.price,
    midPrice,
    spreadAbs,
    spreadBps,
    obiL1,
    obiMultiLevel,
    micropriceL1,
    micropriceMultiLevel,
    totalBidDepth5,
    totalAskDepth5,
    iceberg,
    vpin,
    reason: null,
  };
}

/**
 * Computes annualized Yang-Zhang (2000) OHLC realized volatility estimator
 * capturing overnight jumps, open-to-close drift-independent variance, and Rogers-Satchell range.
 */
export function computeYangZhangVol(
  bars: readonly YangZhangOhlcBar[],
  annualizationDays = 252,
): number {
  if (!isPositiveFinite(annualizationDays) || bars.length < 3) {
    return Number.NaN;
  }

  const n = bars.length - 1;
  const overnightReturns: number[] = [];
  const openCloseReturns: number[] = [];
  let rsSum = 0;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (
      bar === undefined ||
      !isValidUtcSec(bar.timeSec) ||
      !isPositiveFinite(bar.open) ||
      !isPositiveFinite(bar.high) ||
      !isPositiveFinite(bar.low) ||
      !isPositiveFinite(bar.close) ||
      bar.high < Math.max(bar.open, bar.close) ||
      bar.low > Math.min(bar.open, bar.close)
    ) {
      return Number.NaN;
    }

    if (i === 0) {
      continue;
    }

    const prev = bars[i - 1];
    if (prev === undefined || bar.timeSec <= prev.timeSec) {
      return Number.NaN;
    }

    const o = Math.log(bar.open / prev.close);
    const c = Math.log(bar.close / bar.open);
    const u = Math.log(bar.high / bar.open);
    const d = Math.log(bar.low / bar.open);

    overnightReturns.push(o);
    openCloseReturns.push(c);
    rsSum += u * (u - c) + d * (d - c);
  }

  let meanO = 0;
  let meanC = 0;
  for (let i = 0; i < n; i++) {
    meanO += overnightReturns[i] ?? 0;
    meanC += openCloseReturns[i] ?? 0;
  }
  meanO /= n;
  meanC /= n;

  let sumSqO = 0;
  let sumSqC = 0;
  for (let i = 0; i < n; i++) {
    const dO = (overnightReturns[i] ?? 0) - meanO;
    const dC = (openCloseReturns[i] ?? 0) - meanC;
    sumSqO += dO * dO;
    sumSqC += dC * dC;
  }

  const varO = sumSqO / (n - 1);
  const varC = sumSqC / (n - 1);
  const varRs = rsSum / n;
  const k = 0.34 / (1.34 + (n + 1) / (n - 1));
  const yzDailyVariance = Math.max(0, varO + k * varC + (1 - k) * varRs);

  return Math.sqrt(annualizationDays * yzDailyVariance);
}

/**
 * Computes maximum discrete second difference (forward kink) across A3/ROFEX DLR/*
 * implied annualized forward interest rates, highlighting electoral event windows.
 */
export function computeDlrForwardKink(
  curvePoints: readonly DlrCurvePointInput[],
): GgalDlrForwardKinkResult {
  const valid = curvePoints
    .filter((p) => isPositiveFinite(p.daysToMaturity) && isPositiveFinite(p.priceArs))
    .slice()
    .sort((a, b) => a.daysToMaturity - b.daysToMaturity);

  if (valid.length < 4) {
    return {
      available: false,
      reason: 'INSUFFICIENT_DLR_CURVE_POINTS',
      maxSecondDifferencePct: Number.NaN,
      peakMaturityLabel: null,
      peakForwardRate: Number.NaN,
      annualizedTermSlopePct: Number.NaN,
      curvePointsCount: valid.length,
    };
  }

  interface ForwardSegment {
    readonly maturityLabel: string;
    readonly forwardRate: number;
    readonly isElectoralWindow: boolean;
  }

  const segments: ForwardSegment[] = [];
  for (let i = 1; i < valid.length; i++) {
    const prev = valid[i - 1];
    const curr = valid[i];
    if (prev === undefined || curr === undefined || curr.daysToMaturity <= prev.daysToMaturity) {
      return {
        available: false,
        reason: 'INVALID_DLR_MATURITY_ORDER',
        maxSecondDifferencePct: Number.NaN,
        peakMaturityLabel: null,
        peakForwardRate: Number.NaN,
        annualizedTermSlopePct: Number.NaN,
        curvePointsCount: valid.length,
      };
    }
    const dtYears = (curr.daysToMaturity - prev.daysToMaturity) / 365;
    const forwardRate = Math.log(curr.priceArs / prev.priceArs) / dtYears;
    segments.push({
      maturityLabel: curr.maturityLabel,
      forwardRate,
      isElectoralWindow: curr.isElectoralWindow,
    });
  }

  if (segments.length < 3) {
    return {
      available: false,
      reason: 'INSUFFICIENT_DLR_FORWARD_SEGMENTS',
      maxSecondDifferencePct: Number.NaN,
      peakMaturityLabel: null,
      peakForwardRate: Number.NaN,
      annualizedTermSlopePct: Number.NaN,
      curvePointsCount: valid.length,
    };
  }

  const hasElectoralFlag = segments.some((s) => s.isElectoralWindow);
  let maxSecondDiffPct = -1;
  let peakLabel = '';
  let peakFwdRate = Number.NaN;

  for (let j = 1; j < segments.length - 1; j++) {
    const left = segments[j - 1];
    const mid = segments[j];
    const right = segments[j + 1];
    if (left === undefined || mid === undefined || right === undefined) {
      continue;
    }
    if (hasElectoralFlag && !mid.isElectoralWindow && !left.isElectoralWindow && !right.isElectoralWindow) {
      continue;
    }
    const secondDiffPct = Math.abs((right.forwardRate - mid.forwardRate) - (mid.forwardRate - left.forwardRate)) * 100;
    if (secondDiffPct > maxSecondDiffPct) {
      maxSecondDiffPct = secondDiffPct;
      peakLabel = mid.maturityLabel;
      peakFwdRate = mid.forwardRate;
    }
  }

  if (maxSecondDiffPct < 0) {
    return {
      available: false,
      reason: 'NO_VALID_FORWARD_KINK_WINDOW',
      maxSecondDifferencePct: Number.NaN,
      peakMaturityLabel: null,
      peakForwardRate: Number.NaN,
      annualizedTermSlopePct: Number.NaN,
      curvePointsCount: valid.length,
    };
  }

  const firstSeg = segments[0];
  const lastSeg = segments[segments.length - 1];
  const annualizedTermSlopePct =
    firstSeg !== undefined && lastSeg !== undefined
      ? (lastSeg.forwardRate - firstSeg.forwardRate) * 100
      : 0;

  return {
    available: true,
    maxSecondDifferencePct: maxSecondDiffPct,
    peakMaturityLabel: peakLabel,
    peakForwardRate: peakFwdRate,
    annualizedTermSlopePct,
    curvePointsCount: valid.length,
    reason: null,
  };
}

interface ReturnInterval {
  readonly startSec: number;
  readonly endSec: number;
  readonly logReturn: number;
}

function buildReturnIntervals(ticks: readonly AsyncPriceTick[]): readonly ReturnInterval[] | null {
  if (ticks.length < 3) {
    return null;
  }
  const sorted = ticks
    .filter((t) => isValidUtcSec(t.timeSec) && isPositiveFinite(t.price))
    .slice()
    .sort((a, b) => a.timeSec - b.timeSec);
  if (sorted.length < 3) {
    return null;
  }

  const intervals: ReturnInterval[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (prev === undefined || curr === undefined || curr.timeSec <= prev.timeSec) {
      continue;
    }
    intervals.push({
      startSec: prev.timeSec,
      endSec: curr.timeSec,
      logReturn: Math.log(curr.price / prev.price),
    });
  }
  return intervals.length >= 2 ? intervals : null;
}

function realizedVariance(intervals: readonly ReturnInterval[]): number {
  let sum = 0;
  for (const item of intervals) {
    sum += item.logReturn * item.logReturn;
  }
  return sum;
}

function hayashiYoshidaCorrelationAtLag(
  intervalsA: readonly ReturnInterval[],
  intervalsB: readonly ReturnInterval[],
  rvA: number,
  rvB: number,
  lagSecondsAForward: number,
): number {
  if (rvA <= 0 || rvB <= 0) {
    return 0;
  }
  let cov = 0;
  for (const a of intervalsA) {
    const aStart = a.startSec + lagSecondsAForward;
    const aEnd = a.endSec + lagSecondsAForward;
    for (const b of intervalsB) {
      if (Math.max(aStart, b.startSec) < Math.min(aEnd, b.endSec)) {
        cov += a.logReturn * b.logReturn;
      }
    }
  }
  return clamp(cov / Math.sqrt(rvA * rvB), -1, 1);
}

/**
 * Asynchronous Hayashi-Yoshida cross-correlation lead-lag analyzer across
 * Argentine banking ADRs/locals: GGAL, BMA, BBAR, SUPV.
 */
export function computeHayashiYoshidaLeadLag(
  seriesByBank: CrossBankTickSeriesMap,
  lagGridSeconds: readonly number[] = [-300, -180, -120, -60, -30, -15, -5, 0, 5, 15, 30, 60, 120, 180, 300],
): GgalCrossBankLeadLagResult {
  const intervalMap = new Map<GgalCrossBankTicker, { intervals: readonly ReturnInterval[]; rv: number }>();

  for (const ticker of CROSS_BANK_TICKERS) {
    const intervals = buildReturnIntervals(seriesByBank[ticker]);
    if (intervals === null) {
      return {
        available: false,
        reason: `INSUFFICIENT_ASYNC_TICKS_${ticker}`,
        leader: null,
        leaderAverageLeadScore: Number.NaN,
        byBankScore: null,
        pairs: [],
      };
    }
    const rv = realizedVariance(intervals);
    if (!isPositiveFinite(rv)) {
      return {
        available: false,
        reason: `ZERO_REALIZED_VARIANCE_${ticker}`,
        leader: null,
        leaderAverageLeadScore: Number.NaN,
        byBankScore: null,
        pairs: [],
      };
    }
    intervalMap.set(ticker, { intervals, rv });
  }

  const lags = lagGridSeconds.length > 0 ? lagGridSeconds : [-60, -30, 0, 30, 60];
  const pairs: GgalHayashiYoshidaPairScore[] = [];
  const scoreAccum: Record<GgalCrossBankTicker, number> = {
    GGAL: 0,
    BMA: 0,
    BBAR: 0,
    SUPV: 0,
  };

  for (let i = 0; i < CROSS_BANK_TICKERS.length; i++) {
    for (let j = i + 1; j < CROSS_BANK_TICKERS.length; j++) {
      const tickerA = CROSS_BANK_TICKERS[i];
      const tickerB = CROSS_BANK_TICKERS[j];
      if (tickerA === undefined || tickerB === undefined) {
        continue;
      }
      const dataA = intervalMap.get(tickerA);
      const dataB = intervalMap.get(tickerB);
      if (dataA === undefined || dataB === undefined) {
        continue;
      }

      let bestLag = 0;
      let bestCorr = 0;
      let bestAbs = -1;
      let posAbsSum = 0;
      let posCount = 0;
      let negAbsSum = 0;
      let negCount = 0;

      for (const lag of lags) {
        const corr = hayashiYoshidaCorrelationAtLag(dataA.intervals, dataB.intervals, dataA.rv, dataB.rv, lag);
        const absCorr = Math.abs(corr);
        if (lag > 0) {
          posAbsSum += absCorr;
          posCount += 1;
        } else if (lag < 0) {
          negAbsSum += absCorr;
          negCount += 1;
        }
        if (
          absCorr > bestAbs + 1e-12 ||
          (Math.abs(absCorr - bestAbs) <= 1e-12 && Math.abs(lag) < Math.abs(bestLag))
        ) {
          bestAbs = absCorr;
          bestCorr = corr;
          bestLag = lag;
        }
      }

      let leadScoreAOverB = 0;
      if (bestLag > 0) {
        leadScoreAOverB = bestAbs;
      } else if (bestLag < 0) {
        leadScoreAOverB = -bestAbs;
      } else {
        const posMean = posCount > 0 ? posAbsSum / posCount : 0;
        const negMean = negCount > 0 ? negAbsSum / negCount : 0;
        leadScoreAOverB = posMean - negMean;
      }

      scoreAccum[tickerA] += leadScoreAOverB;
      scoreAccum[tickerB] -= leadScoreAOverB;

      pairs.push({
        tickerA,
        tickerB,
        correlation: bestCorr,
        bestLagSeconds: bestLag,
        leadScoreAOverB,
      });
    }
  }

  const byBankScore: Record<GgalCrossBankTicker, number> = {
    GGAL: scoreAccum.GGAL / 3,
    BMA: scoreAccum.BMA / 3,
    BBAR: scoreAccum.BBAR / 3,
    SUPV: scoreAccum.SUPV / 3,
  };

  let leader: GgalCrossBankTicker = 'GGAL';
  let bestScore = -Infinity;
  for (const ticker of CROSS_BANK_TICKERS) {
    const score = byBankScore[ticker];
    if (score > bestScore + 1e-12) {
      bestScore = score;
      leader = ticker;
    }
  }

  return {
    available: true,
    leader,
    leaderAverageLeadScore: bestScore,
    byBankScore,
    pairs,
    reason: null,
  };
}

/**
 * Motor 9: Recursive 3-state Hamilton (1989) Markov-Switching filter across:
 * 0: `CALM_COMPRESSION`, 1: `FX_BRECHA_TENSION`, 2: `ELECTORAL_TAIL_JUMP`.
 */
export function updateElectoralMarkovRegime(input: ElectoralMarkovInput): GgalElectoralRegimeState {
  const [p0, p1, p2] = input.priorProbabilities;
  const priorSum = p0 + p1 + p2;
  const normalizedPrior: readonly [number, number, number] =
    Number.isFinite(p0) && Number.isFinite(p1) && Number.isFinite(p2) && priorSum > 0
      ? [p0 / priorSum, p1 / priorSum, p2 / priorSum]
      : [0.6, 0.3, 0.1];

  if (!isValidUtcSec(input.asOfUtcSec)) {
    return {
      status: 'UNAVAILABLE',
      asOfUtcSec: input.asOfUtcSec,
      reason: 'INVALID_TIMESTAMP',
      priorProbabilities: normalizedPrior,
      posteriorProbabilities: normalizedPrior,
      currentRegime: null,
    };
  }

  if (input.observables === null) {
    return {
      status: 'UNAVAILABLE',
      asOfUtcSec: input.asOfUtcSec,
      reason: 'MISSING_ELECTORAL_OBSERVABLES',
      priorProbabilities: normalizedPrior,
      posteriorProbabilities: normalizedPrior,
      currentRegime: null,
    };
  }

  if (!input.dlrKinkDetail.available) {
    return {
      status: 'UNAVAILABLE',
      asOfUtcSec: input.asOfUtcSec,
      reason: input.dlrKinkDetail.reason,
      priorProbabilities: normalizedPrior,
      posteriorProbabilities: normalizedPrior,
      currentRegime: null,
    };
  }

  if (!input.leadLagDetail.available) {
    return {
      status: 'UNAVAILABLE',
      asOfUtcSec: input.asOfUtcSec,
      reason: input.leadLagDetail.reason,
      priorProbabilities: normalizedPrior,
      posteriorProbabilities: normalizedPrior,
      currentRegime: null,
    };
  }

  const obs = input.observables;
  const featureVec: readonly [number, number, number, number, number] = [
    obs.bankBasketIv30ExErn,
    obs.ggal25DeltaSkew,
    obs.sovereignLegislationSpreadPct,
    obs.dlrElectoralForwardKink,
    obs.crossBankLeadLagIntensity,
  ];

  for (const val of featureVec) {
    if (!Number.isFinite(val)) {
      return {
        status: 'UNAVAILABLE',
        asOfUtcSec: input.asOfUtcSec,
        reason: 'NON_FINITE_OBSERVABLE',
        priorProbabilities: normalizedPrior,
        posteriorProbabilities: normalizedPrior,
        currentRegime: null,
      };
    }
  }

  if (!isPositiveFinite(input.yangZhangVol20d)) {
    return {
      status: 'UNAVAILABLE',
      asOfUtcSec: input.asOfUtcSec,
      reason: 'INVALID_YANG_ZHANG_VOL',
      priorProbabilities: normalizedPrior,
      posteriorProbabilities: normalizedPrior,
      currentRegime: null,
    };
  }

  const transition = input.customTransitionMatrix ?? DEFAULT_TRANSITION_MATRIX;

  // Step 1: Hamilton prediction step xi_{t|t-1} = P^T * xi_{t-1|t-1}
  const predicted: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const row = transition[i];
    const priorI = normalizedPrior[i] ?? 0;
    if (row === undefined) {
      continue;
    }
    predicted[0] += priorI * row[0];
    predicted[1] += priorI * row[1];
    predicted[2] += priorI * row[2];
  }

  // Step 2: Log-likelihoods for each regime state under calibrated diagonal Gaussian emissions
  const logLikelihoods: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const means = EMISSION_MEANS[k];
    const stds = EMISSION_STDS[k];
    if (means === undefined || stds === undefined) {
      continue;
    }
    let logLik = 0;
    for (let d = 0; d < 5; d++) {
      const y = featureVec[d] ?? 0;
      const mu = means[d] ?? 0;
      const sigma = stds[d] ?? 1;
      const z = (y - mu) / sigma;
      logLik += -0.5 * (Math.log(2 * Math.PI * sigma * sigma) + z * z);
    }
    logLikelihoods[k] = logLik;
  }

  const maxLogLik = Math.max(logLikelihoods[0], logLikelihoods[1], logLikelihoods[2]);
  const scaledLikelihoods: readonly [number, number, number] = [
    Math.exp(logLikelihoods[0] - maxLogLik),
    Math.exp(logLikelihoods[1] - maxLogLik),
    Math.exp(logLikelihoods[2] - maxLogLik),
  ];

  const unnormPost0 = predicted[0] * scaledLikelihoods[0];
  const unnormPost1 = predicted[1] * scaledLikelihoods[1];
  const unnormPost2 = predicted[2] * scaledLikelihoods[2];
  const denom = unnormPost0 + unnormPost1 + unnormPost2;

  if (!isPositiveFinite(denom)) {
    return {
      status: 'UNAVAILABLE',
      asOfUtcSec: input.asOfUtcSec,
      reason: 'HAMILTON_POSTERIOR_UNDERFLOW',
      priorProbabilities: normalizedPrior,
      posteriorProbabilities: normalizedPrior,
      currentRegime: null,
    };
  }

  const posterior: readonly [number, number, number] = [
    unnormPost0 / denom,
    unnormPost1 / denom,
    unnormPost2 / denom,
  ];

  let bestStateIdx: 0 | 1 | 2 = 0;
  if (posterior[1] > posterior[0] && posterior[1] >= posterior[2]) {
    bestStateIdx = 1;
  } else if (posterior[2] > posterior[0] && posterior[2] > posterior[1]) {
    bestStateIdx = 2;
  }

  const currentRegime = REGIME_IDS[bestStateIdx];
  const effectiveJumpIntensity =
    posterior[0] * STATE_JUMP_INTENSITY[0] +
    posterior[1] * STATE_JUMP_INTENSITY[1] +
    posterior[2] * STATE_JUMP_INTENSITY[2];
  const kellyFractionMultiplier =
    posterior[0] * STATE_KELLY_MULTIPLIER[0] +
    posterior[1] * STATE_KELLY_MULTIPLIER[1] +
    posterior[2] * STATE_KELLY_MULTIPLIER[2];

  // Expected shortfall normal multiplier at 99% ~ 2.6652 (phi(Phi^-1(0.99))/0.01)
  const dailyYzPct = (input.yangZhangVol20d / Math.sqrt(252)) * 100;
  const overnightCvar99Pct =
    posterior[0] * STATE_BASE_CVAR99_PCT[0] +
    posterior[1] * STATE_BASE_CVAR99_PCT[1] +
    posterior[2] * STATE_BASE_CVAR99_PCT[2] +
    0.35 * dailyYzPct * 2.6652;

  const w0 = STATE_HEDGE_WEIGHTS[0];
  const w1 = STATE_HEDGE_WEIGHTS[1];
  const w2 = STATE_HEDGE_WEIGHTS[2];
  const recommendedHedgeWeights: GgalHedgeWeightRecommendation = {
    dlrFuturesWeight:
      posterior[0] * w0.dlrFuturesWeight +
      posterior[1] * w1.dlrFuturesWeight +
      posterior[2] * w2.dlrFuturesWeight,
    otmPutWingWeight:
      posterior[0] * w0.otmPutWingWeight +
      posterior[1] * w1.otmPutWingWeight +
      posterior[2] * w2.otmPutWingWeight,
    cashArsCollarWeight:
      posterior[0] * w0.cashArsCollarWeight +
      posterior[1] * w1.cashArsCollarWeight +
      posterior[2] * w2.cashArsCollarWeight,
    adrDeltaHedgeWeight:
      posterior[0] * w0.adrDeltaHedgeWeight +
      posterior[1] * w1.adrDeltaHedgeWeight +
      posterior[2] * w2.adrDeltaHedgeWeight,
  };

  return {
    status: 'OPERATIONAL',
    asOfUtcSec: input.asOfUtcSec,
    currentRegime,
    priorProbabilities: normalizedPrior,
    posteriorProbabilities: posterior,
    likelihoods: scaledLikelihoods,
    effectiveJumpIntensity,
    kellyFractionMultiplier,
    overnightCvar99Pct,
    recommendedHedgeWeights,
    observables: obs,
    dlrKinkDetail: input.dlrKinkDetail,
    leadLagDetail: input.leadLagDetail,
    yangZhangVol20d: input.yangZhangVol20d,
    reason: null,
  };
}

/**
 * Motor 2 enhancement: extracts $\sigma_{\text{CCL}}^{\text{impl}}$ from OTM wings
 * ($|\Delta| \in [0.15, 0.25]$) where BYMA Call Overwriting compression is weaker than ATM,
 * accounting for unadjusted JUL-26 cash dividend strike asymmetry on BYMA.
 */
export function extractOtmWingCclImpliedVol(
  input: OtmWingCclIvInput,
): OtmWingCclIvExtractionResult {
  if (
    !isPositiveFinite(input.bymaAtmIv) ||
    !isPositiveFinite(input.usAtmIv) ||
    !Number.isFinite(input.corrAdrCcl) ||
    Math.abs(input.corrAdrCcl) >= 1
  ) {
    return {
      status: 'UNAVAILABLE',
      extractedCclImplVol: Number.NaN,
      atmBymaCompressedIv: Number.NaN,
      callOverwritingCompressionPct: Number.NaN,
      selectedWingsCount: 0,
      wingPoints: [],
      reason: 'INVALID_ATM_OR_CORR_INPUT',
    };
  }

  const callOverwritingCompressionPct =
    ((input.usAtmIv - input.bymaAtmIv) / input.usAtmIv) * 100;
  const divAdj = Number.isFinite(input.jul26DividendYieldDragAnn)
    ? Math.max(0, input.jul26DividendYieldDragAnn)
    : 0;

  const wingPoints: OtmWingPointDiagnostic[] = [];
  let weightSum = 0;
  let weightedCclSum = 0;

  for (const s of input.strikes) {
    if (
      !isPositiveFinite(s.strikeArs) ||
      !isPositiveFinite(s.absDelta) ||
      !isPositiveFinite(s.bymaIv) ||
      !isPositiveFinite(s.usWingIv)
    ) {
      continue;
    }
    if (s.absDelta < 0.15 || s.absDelta > 0.25) {
      continue;
    }

    // Without strike adjustment on JUL-26 ordinary cash dividends in BYMA,
    // puts absorb downside forward drop slightly inflating raw IV while calls understate slightly.
    const effectiveBymaIv = s.isJul26DividendNoStrikeAdj
      ? s.side === 'PUT'
        ? Math.max(0.01, s.bymaIv - 0.5 * divAdj)
        : s.bymaIv + 0.5 * divAdj
      : s.bymaIv;

    const rho = input.corrAdrCcl;
    const b = rho * s.usWingIv;
    const disc = b * b + effectiveBymaIv * effectiveBymaIv - s.usWingIv * s.usWingIv;
    if (disc < 0) {
      continue;
    }
    const impliedCclVol = -b + Math.sqrt(disc);
    if (!isPositiveFinite(impliedCclVol)) {
      continue;
    }

    const w = 1 / (0.02 + Math.abs(s.absDelta - 0.2));
    weightSum += w;
    weightedCclSum += w * impliedCclVol;

    wingPoints.push({
      strikeArs: s.strikeArs,
      side: s.side,
      absDelta: s.absDelta,
      bymaIv: effectiveBymaIv,
      usWingIv: s.usWingIv,
      impliedCclVol,
      jul26DividendAdjusted: s.isJul26DividendNoStrikeAdj,
    });
  }

  if (wingPoints.length === 0 || !isPositiveFinite(weightSum)) {
    return {
      status: 'UNAVAILABLE',
      extractedCclImplVol: Number.NaN,
      atmBymaCompressedIv: input.bymaAtmIv,
      callOverwritingCompressionPct,
      selectedWingsCount: 0,
      wingPoints: [],
      reason: 'NO_VALID_OTM_WINGS_FOR_CCL_EXTRACTION',
    };
  }

  return {
    status: 'OPERATIONAL',
    extractedCclImplVol: weightedCclSum / weightSum,
    atmBymaCompressedIv: input.bymaAtmIv,
    callOverwritingCompressionPct,
    selectedWingsCount: wingPoints.length,
    wingPoints,
    reason: null,
  };
}

/**
 * Motor 4 enhancement: computes 15:30 ART `PinScore` weighted by multi-level L2 `OBI`
 * and visible top-5 depth confirmation. Fails closed if L2 feed is unavailable.
 */
export function computeL2WeightedPinScore(
  input: L2WeightedPinScoreInput,
): L2WeightedPinScoreResult {
  if (!isValidUtcSec(input.asOfUtcSec)) {
    return {
      status: 'UNAVAILABLE',
      pinStrikeArs: Number.NaN,
      distancePct: Number.NaN,
      baseAnexoBPinScore: Number.NaN,
      obiMultiLevel: Number.NaN,
      l2DepthConfirmationRatio: Number.NaN,
      weightedPinScore: Number.NaN,
      asOfBuenosAiresTime: '—',
      isClosingWindow1530Art: false,
      reason: 'INVALID_TIMESTAMP',
    };
  }

  const baParts = getBuenosAiresParts(input.asOfUtcSec);
  const hh = String(baParts.hour).padStart(2, '0');
  const mm = String(baParts.minute).padStart(2, '0');
  const ss = String(baParts.second).padStart(2, '0');
  const baTimeLabel = `${hh}:${mm}:${ss} ART`;
  const minuteOfDay = baParts.hour * 60 + baParts.minute;
  const isClosingWindow1530Art = minuteOfDay >= 15 * 60 + 20 && minuteOfDay <= 17 * 60;

  if (input.l2Metrics.status !== 'OPERATIONAL') {
    return {
      status: 'UNAVAILABLE',
      pinStrikeArs: Number.NaN,
      distancePct: Number.NaN,
      baseAnexoBPinScore: Number.NaN,
      obiMultiLevel: Number.NaN,
      l2DepthConfirmationRatio: Number.NaN,
      weightedPinScore: Number.NaN,
      asOfBuenosAiresTime: baTimeLabel,
      isClosingWindow1530Art,
      reason: 'DEGRADED_TO_NON_L2_FEED',
    };
  }

  if (
    !isPositiveFinite(input.pinStrikeArs) ||
    !isPositiveFinite(input.spotArs) ||
    !Number.isFinite(input.baseAnexoBPinScore) ||
    input.baseAnexoBPinScore < 0 ||
    input.baseAnexoBPinScore > 1
  ) {
    return {
      status: 'UNAVAILABLE',
      pinStrikeArs: Number.NaN,
      distancePct: Number.NaN,
      baseAnexoBPinScore: Number.NaN,
      obiMultiLevel: input.l2Metrics.obiMultiLevel,
      l2DepthConfirmationRatio: Number.NaN,
      weightedPinScore: Number.NaN,
      asOfBuenosAiresTime: baTimeLabel,
      isClosingWindow1530Art,
      reason: 'INVALID_PIN_OR_SPOT_INPUT',
    };
  }

  const distancePct = ((input.spotArs - input.pinStrikeArs) / input.pinStrikeArs) * 100;
  const obi = input.l2Metrics.obiMultiLevel;

  let directionalAlignment: number;
  if (Math.abs(distancePct) < 0.15) {
    // At the pin strike, symmetric L2 order book supports pin retention.
    directionalAlignment = 1 - Math.abs(obi);
  } else if (distancePct > 0) {
    // Spot above pin: negative OBI (ask pressure) magnetizes spot down to pin.
    directionalAlignment = -obi;
  } else {
    // Spot below pin: positive OBI (bid pressure) magnetizes spot up to pin.
    directionalAlignment = obi;
  }

  const l2DepthConfirmationRatio = clamp(1 + 0.35 * directionalAlignment, 0.5, 1.5);
  const closingMultiplier = isClosingWindow1530Art ? 1.15 : 1.0;
  const weightedPinScore = clamp(
    input.baseAnexoBPinScore * l2DepthConfirmationRatio * closingMultiplier,
    0,
    1,
  );

  return {
    status: 'OPERATIONAL',
    pinStrikeArs: input.pinStrikeArs,
    distancePct,
    baseAnexoBPinScore: input.baseAnexoBPinScore,
    obiMultiLevel: obi,
    l2DepthConfirmationRatio,
    weightedPinScore,
    asOfBuenosAiresTime: baTimeLabel,
    isClosingWindow1530Art,
    reason: null,
  };
}

/**
 * Converts a scalar ARS price level (spot, strike, wall, POC) into the selected chart coordinate mode.
 * Ratio conversion uses BYMA lot-per-ADR equivalence (`GGAL_ADR_RATIO = 10`).
 */
export function convertArsPriceToCoord(
  arsPrice: number,
  coordMode: GgalDualChartCoordMode,
  cclRate: number,
  adrReferenceUsd: number,
): number {
  if (!isPositiveFinite(arsPrice)) {
    return Number.NaN;
  }
  if (coordMode === 'ARS_BYMA') {
    return arsPrice;
  }
  if (coordMode === 'USD_ADR_NASDAQ') {
    return isPositiveFinite(cclRate) ? (arsPrice * GGAL_ADR_RATIO) / cclRate : Number.NaN;
  }
  return isPositiveFinite(adrReferenceUsd)
    ? (arsPrice * GGAL_ADR_RATIO) / adrReferenceUsd
    : Number.NaN;
}

/**
 * Converts paired BYMA (ARS) + NASDAQ ADR (USD) OHLC bars into `ARS_BYMA`, `USD_ADR_NASDAQ`, or `RATIO_CCL`.
 */
export function convertOhlcBarToCoord(
  bymaBar: GgalChartBarPoint | null,
  adrBar: GgalChartBarPoint | null,
  coordMode: GgalDualChartCoordMode,
): GgalChartBarPoint | null {
  if (coordMode === 'ARS_BYMA') {
    if (
      bymaBar === null ||
      !isValidUtcSec(bymaBar.timeSec) ||
      !isPositiveFinite(bymaBar.open) ||
      !isPositiveFinite(bymaBar.high) ||
      !isPositiveFinite(bymaBar.low) ||
      !isPositiveFinite(bymaBar.close)
    ) {
      return null;
    }
    return { ...bymaBar };
  }

  if (coordMode === 'USD_ADR_NASDAQ') {
    if (
      adrBar === null ||
      !isValidUtcSec(adrBar.timeSec) ||
      !isPositiveFinite(adrBar.open) ||
      !isPositiveFinite(adrBar.high) ||
      !isPositiveFinite(adrBar.low) ||
      !isPositiveFinite(adrBar.close)
    ) {
      return null;
    }
    return { ...adrBar };
  }

  if (
    bymaBar === null ||
    adrBar === null ||
    !isValidUtcSec(bymaBar.timeSec) ||
    !isPositiveFinite(bymaBar.open) ||
    !isPositiveFinite(bymaBar.high) ||
    !isPositiveFinite(bymaBar.low) ||
    !isPositiveFinite(bymaBar.close) ||
    !isPositiveFinite(adrBar.open) ||
    !isPositiveFinite(adrBar.high) ||
    !isPositiveFinite(adrBar.low) ||
    !isPositiveFinite(adrBar.close)
  ) {
    return null;
  }

  const openRatio = (GGAL_ADR_RATIO * bymaBar.open) / adrBar.open;
  const closeRatio = (GGAL_ADR_RATIO * bymaBar.close) / adrBar.close;
  const highCandidate = (GGAL_ADR_RATIO * bymaBar.high) / adrBar.low;
  const lowCandidate = (GGAL_ADR_RATIO * bymaBar.low) / adrBar.high;

  return {
    timeSec: bymaBar.timeSec,
    open: openRatio,
    close: closeRatio,
    high: Math.max(openRatio, closeRatio, highCandidate),
    low: Math.min(openRatio, closeRatio, lowCandidate),
    volume: bymaBar.volume,
  };
}
