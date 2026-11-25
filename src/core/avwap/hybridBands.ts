import type { HybridBandSnapshot, HybridBandsInput } from './types.js';

const TRADING_DAYS_PER_YEAR = 252;
const PATH_BRIDGE_DENOM = 6;

function nanHybridBands(
  avwapMu: number,
  welfordSd: number,
  bandSource: HybridBandSnapshot['bandSource'] = 'WELFORD_ONLY_FALLBACK',
): HybridBandSnapshot {
  return {
    avwapMu,
    welfordSd,
    sigmaOratsPath: Number.NaN,
    expectedMove1d: Number.NaN,
    alpha: Number.NaN,
    sigmaHybrid: Number.NaN,
    bandSource,
    upper1: Number.NaN,
    lower1: Number.NaN,
    upper2: Number.NaN,
    lower2: Number.NaN,
    upper2_5: Number.NaN,
    lower2_5: Number.NaN,
  };
}

/**
 * Computes ORATS-blended dispersion bands with exact clean fallback to `welfordSd`.
 *
 * Formula:
 * - `expectedMove1d = avwapMu * (orIvXern20dDec / sqrt(252))`
 * - `sigmaOratsPath = expectedMove1d * sqrt(elapsedTradingDays / 6)`
 * - `alpha = exp(-elapsedTradingDays / tau0)` (`tau0 = 2.0`)
 * - `sigmaHybrid = sqrt(alpha * sigmaOratsPath^2 + (1 - alpha) * welfordSd^2)`
 */
export function computeHybridBands(params: HybridBandsInput): HybridBandSnapshot {
  const tau0 = params.tau0 ?? 2.0;
  const { avwapMu, welfordSd, orIvXern20dDec, elapsedTradingDays } = params;

  if (
    !Number.isFinite(avwapMu) ||
    avwapMu <= 0 ||
    !Number.isFinite(welfordSd) ||
    welfordSd < 0 ||
    !Number.isFinite(elapsedTradingDays) ||
    elapsedTradingDays < 0 ||
    !Number.isFinite(tau0) ||
    tau0 <= 0
  ) {
    return nanHybridBands(Number.NaN, Number.NaN);
  }

  let sigmaOratsPath: number;
  let expectedMove1d: number;
  let alpha: number;
  let sigmaHybrid: number;
  let bandSource: HybridBandSnapshot['bandSource'];

  if (orIvXern20dDec === null || !Number.isFinite(orIvXern20dDec)) {
    expectedMove1d = Number.NaN;
    sigmaOratsPath = Number.NaN;
    alpha = 0;
    sigmaHybrid = welfordSd;
    bandSource = 'WELFORD_ONLY_FALLBACK';
  } else {
    if (orIvXern20dDec < 0) {
      throw new RangeError(`orIvXern20dDec must be >= 0, got ${String(orIvXern20dDec)}`);
    }
    expectedMove1d = avwapMu * (orIvXern20dDec / Math.sqrt(TRADING_DAYS_PER_YEAR));
    sigmaOratsPath = expectedMove1d * Math.sqrt(elapsedTradingDays / PATH_BRIDGE_DENOM);
    alpha = Math.exp(-elapsedTradingDays / tau0);
    sigmaHybrid = Math.sqrt(
      alpha * sigmaOratsPath * sigmaOratsPath + (1 - alpha) * welfordSd * welfordSd,
    );
    bandSource = 'HYBRID_ORATS_WELFORD';
  }

  return {
    avwapMu,
    welfordSd,
    sigmaOratsPath,
    expectedMove1d,
    alpha,
    sigmaHybrid,
    bandSource,
    upper1: avwapMu + sigmaHybrid,
    lower1: avwapMu - sigmaHybrid,
    upper2: avwapMu + 2 * sigmaHybrid,
    lower2: avwapMu - 2 * sigmaHybrid,
    upper2_5: avwapMu + 2.5 * sigmaHybrid,
    lower2_5: avwapMu - 2.5 * sigmaHybrid,
  };
}
