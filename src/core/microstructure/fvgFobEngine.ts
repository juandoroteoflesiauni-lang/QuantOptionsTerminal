/**
 * Motor puro de Microestructura Institucional: Fair Value Gaps (FVG) cuantitativos
 * y Fresh Order Blocks (FOB) con huella de absorción y Dark Pool / FINRA TRF (Pieza 15).
 *
 * Garantías de diseño:
 *  - Funciones puras, cero red, cero E/S, cero mutación de argumentos.
 *  - Timestamps en segundos UTC enteros.
 *  - Cero Look-Ahead Bias: solo entran barras cerradas (`bar.time + barSeconds <= asOfUtcSec`);
 *    un FVG `(i-2, i-1, i)` solo existe al cerrar `i`, un FOB solo al cerrar el desplazamiento `d`,
 *    y toda mitigación evalúa exclusivamente barras posteriores cerradas `<= asOfUtcSec`.
 *  - Zero Silent Fallbacks: entradas insuficientes o parámetros inválidos devuelven
 *    `Number.NaN` y `status: 'NO_DATA'`.
 */

import type { Bar } from '../types.js';
import {
  assertValidUtcSeconds,
  computeEmpiricalPercentile,
  filterClosedBars,
  validateOhlcvBars,
} from './mtfStructure.js';
import { computeGapVolumePercentile } from './volumeProfileAmt.js';

export const DEFAULT_FVG_ZSCORE_WINDOW = 20;
export const DEFAULT_MIN_RANGE_ZSCORE = 1.5;
export const DEFAULT_MAX_FVG_LVN_PERCENTILE = 15;
export const DEFAULT_MIN_DELTA_IMBALANCE_RATIO = 0.35;

export const DEFAULT_FOB_SWING_LOOKBACK = 5;
export const DEFAULT_FOB_MAX_BASE_SEARCH_BARS = 5;
export const DEFAULT_FOB_ABSORPTION_VOLUME_PERCENTILE = 85;
export const DEFAULT_FOB_MIN_DARK_POOL_SHARE = 0.35;

export const FINRA_TRF_EXCHANGE_ID = 4;

export type MicrostructureEngineStatus = 'OK' | 'NO_DATA';
export type FvgDirection = 'BULLISH_FVG' | 'BEARISH_FVG';
export type FvgMitigationMode = 'FULL_FILL' | 'CONSEQUENT_ENCROACHMENT';
export type FobDirection = 'BULLISH_FOB' | 'BEARISH_FOB';
export type FobAnchorMode = 'INTERNAL_POC_OR_VWAP' | 'HLC3';
export type FobAnchorSource = 'INTERNAL_POC' | 'VWAP' | 'HLC3' | 'NONE';

export interface InstitutionalFlowBar extends Bar {
  readonly delta?: number;
  readonly buyVolume?: number;
  readonly sellVolume?: number;
  readonly darkPoolVolume?: number;
  readonly exchange?: number;
  readonly internalPoc?: number;
}

export interface QuantitativeFvgOptions {
  readonly asOfUtcSec: number;
  readonly barSeconds: number;
  readonly tickSize: number;
  readonly zScoreWindow?: number;
  readonly minRangeZScore?: number;
  readonly maxLvnPercentile?: number;
  readonly minDeltaImbalanceRatio?: number;
  readonly mitigationMode?: FvgMitigationMode;
}

export interface QuantitativeFvgRecord {
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

export interface QuantitativeFvgResult {
  readonly status: MicrostructureEngineStatus;
  readonly asOfUtcSec: number;
  readonly barSeconds: number;
  readonly tickSize: number;
  readonly closedBarCount: number;
  readonly excludedFutureCount: number;
  readonly fvgs: readonly QuantitativeFvgRecord[];
  readonly activeFvgs: readonly QuantitativeFvgRecord[];
}

export interface FreshOrderBlockOptions {
  readonly asOfUtcSec: number;
  readonly barSeconds: number;
  readonly zScoreWindow?: number;
  readonly minDisplacementZScore?: number;
  readonly swingLookback?: number;
  readonly maxBaseSearchBars?: number;
  readonly minAbsorptionVolumePercentile?: number;
  readonly minDarkPoolShare?: number;
  readonly anchorMode?: FobAnchorMode;
}

export interface FreshOrderBlockRecord {
  readonly id: string;
  readonly type: FobDirection;
  readonly baseTime: number;
  readonly formedAtTime: number;
  readonly zoneLow: number;
  readonly zoneHigh: number;
  readonly anchorPrice: number;
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

export interface FreshOrderBlockResult {
  readonly status: MicrostructureEngineStatus;
  readonly asOfUtcSec: number;
  readonly barSeconds: number;
  readonly closedBarCount: number;
  readonly excludedFutureCount: number;
  readonly orderBlocks: readonly FreshOrderBlockRecord[];
  readonly freshOrderBlocks: readonly FreshOrderBlockRecord[];
}

function validateInstitutionalBars(bars: readonly InstitutionalFlowBar[]): void {
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (bar === undefined) {
      continue;
    }
    if (bar.buyVolume !== undefined && Number.isFinite(bar.buyVolume) && bar.buyVolume < 0) {
      throw new Error(`bars[${String(i)}].buyVolume must be >= 0 (got ${String(bar.buyVolume)})`);
    }
    if (bar.sellVolume !== undefined && Number.isFinite(bar.sellVolume) && bar.sellVolume < 0) {
      throw new Error(`bars[${String(i)}].sellVolume must be >= 0 (got ${String(bar.sellVolume)})`);
    }
    if (
      bar.darkPoolVolume !== undefined &&
      Number.isFinite(bar.darkPoolVolume) &&
      bar.darkPoolVolume < 0
    ) {
      throw new Error(
        `bars[${String(i)}].darkPoolVolume must be >= 0 (got ${String(bar.darkPoolVolume)})`,
      );
    }
  }
}

function isFiniteOhlcv(bar: Bar): boolean {
  return (
    Number.isFinite(bar.open) &&
    Number.isFinite(bar.high) &&
    Number.isFinite(bar.low) &&
    Number.isFinite(bar.close) &&
    Number.isFinite(bar.volume) &&
    bar.high >= bar.low &&
    bar.volume >= 0
  );
}

function resolveBarDelta(bar: InstitutionalFlowBar): number {
  if (bar.delta !== undefined && Number.isFinite(bar.delta)) {
    return bar.delta;
  }
  if (
    bar.buyVolume !== undefined &&
    bar.sellVolume !== undefined &&
    Number.isFinite(bar.buyVolume) &&
    Number.isFinite(bar.sellVolume)
  ) {
    return bar.buyVolume - bar.sellVolume;
  }
  if (!isFiniteOhlcv(bar)) {
    return Number.NaN;
  }
  const range = bar.high - bar.low;
  if (range <= 0) {
    return 0;
  }
  const clv = (bar.close - bar.low - (bar.high - bar.close)) / range;
  return bar.volume * clv;
}

function resolveDarkPoolVolume(bar: InstitutionalFlowBar): number {
  if (
    bar.darkPoolVolume !== undefined &&
    Number.isFinite(bar.darkPoolVolume) &&
    bar.darkPoolVolume >= 0
  ) {
    return bar.darkPoolVolume;
  }
  if (
    bar.exchange === FINRA_TRF_EXCHANGE_ID &&
    Number.isFinite(bar.volume) &&
    bar.volume >= 0
  ) {
    return bar.volume;
  }
  return 0;
}

function computeCausalRangeZScore(
  bars: readonly InstitutionalFlowBar[],
  targetIndex: number,
  windowSize: number,
): number {
  if (targetIndex < windowSize || windowSize < 2) {
    return Number.NaN;
  }
  const target = bars[targetIndex];
  if (target === undefined || !isFiniteOhlcv(target)) {
    return Number.NaN;
  }

  const windowRanges: number[] = [];
  let sum = 0;
  for (let k = targetIndex - windowSize; k < targetIndex; k += 1) {
    const b = bars[k];
    if (b === undefined || !isFiniteOhlcv(b)) {
      return Number.NaN;
    }
    const r = b.high - b.low;
    windowRanges.push(r);
    sum += r;
  }

  const mean = sum / windowSize;
  let sqDiffSum = 0;
  for (const r of windowRanges) {
    const d = r - mean;
    sqDiffSum += d * d;
  }
  const stdDev = Math.sqrt(sqDiffSum / windowSize);
  if (stdDev <= 0) {
    return Number.NaN;
  }

  return (target.high - target.low - mean) / stdDev;
}

function resolveFobAnchor(
  bar: InstitutionalFlowBar,
  anchorMode: FobAnchorMode,
): { readonly price: number; readonly source: FobAnchorSource } {
  if (bar.internalPoc !== undefined && Number.isFinite(bar.internalPoc) && bar.internalPoc > 0) {
    return { price: bar.internalPoc, source: 'INTERNAL_POC' };
  }
  if (bar.vw !== undefined && Number.isFinite(bar.vw) && bar.vw > 0) {
    return { price: bar.vw, source: 'VWAP' };
  }
  if (anchorMode === 'HLC3' && isFiniteOhlcv(bar)) {
    return { price: (bar.high + bar.low + bar.close) / 3, source: 'HLC3' };
  }
  return { price: Number.NaN, source: 'NONE' };
}

/**
 * Detecta y rastrea causalmente Fair Value Gaps (FVG) de 3 velas `(i-2, i-1, i)`
 * validados por expansión de rango ($Z > 1.5$), vacío LVN (`<= 15 %`) y delta agresivo.
 */
export function detectQuantitativeFvgs(
  bars: readonly InstitutionalFlowBar[],
  options: QuantitativeFvgOptions,
): QuantitativeFvgResult {
  assertValidUtcSeconds(options.asOfUtcSec, 'asOfUtcSec');
  if (!Number.isInteger(options.barSeconds) || options.barSeconds <= 0) {
    throw new Error(`barSeconds must be a positive integer (got ${String(options.barSeconds)})`);
  }
  validateOhlcvBars(bars, 'bars');
  validateInstitutionalBars(bars);

  const { closed, excludedFutureCount } = filterClosedBars(
    bars,
    options.barSeconds,
    options.asOfUtcSec,
  );

  const tickSize = options.tickSize;
  const zScoreWindow =
    options.zScoreWindow === undefined ? DEFAULT_FVG_ZSCORE_WINDOW : options.zScoreWindow;
  const minRangeZScore =
    options.minRangeZScore === undefined ? DEFAULT_MIN_RANGE_ZSCORE : options.minRangeZScore;
  const maxLvnPercentile =
    options.maxLvnPercentile === undefined
      ? DEFAULT_MAX_FVG_LVN_PERCENTILE
      : options.maxLvnPercentile;
  const minDeltaImbalanceRatio =
    options.minDeltaImbalanceRatio === undefined
      ? DEFAULT_MIN_DELTA_IMBALANCE_RATIO
      : options.minDeltaImbalanceRatio;
  const mitigationMode: FvgMitigationMode =
    options.mitigationMode === undefined ? 'FULL_FILL' : options.mitigationMode;

  if (
    !Number.isFinite(tickSize) ||
    tickSize <= 0 ||
    !Number.isInteger(zScoreWindow) ||
    zScoreWindow < 2 ||
    !Number.isFinite(minRangeZScore) ||
    minRangeZScore <= 0 ||
    !Number.isFinite(maxLvnPercentile) ||
    maxLvnPercentile < 0 ||
    maxLvnPercentile > 100 ||
    !Number.isFinite(minDeltaImbalanceRatio) ||
    minDeltaImbalanceRatio < 0 ||
    minDeltaImbalanceRatio > 1 ||
    closed.length < Math.max(3, zScoreWindow + 2)
  ) {
    return {
      status: 'NO_DATA',
      asOfUtcSec: options.asOfUtcSec,
      barSeconds: options.barSeconds,
      tickSize: Number.isFinite(tickSize) && tickSize > 0 ? tickSize : Number.NaN,
      closedBarCount: closed.length,
      excludedFutureCount,
      fvgs: [],
      activeFvgs: [],
    };
  }

  const fvgs: QuantitativeFvgRecord[] = [];
  const startIndex = Math.max(2, zScoreWindow + 1);

  for (let i = startIndex; i < closed.length; i += 1) {
    const barLeft = closed[i - 2];
    const barMid = closed[i - 1];
    const barRight = closed[i];
    if (
      barLeft === undefined ||
      barMid === undefined ||
      barRight === undefined ||
      !isFiniteOhlcv(barLeft) ||
      !isFiniteOhlcv(barMid) ||
      !isFiniteOhlcv(barRight)
    ) {
      continue;
    }

    let type: FvgDirection | null = null;
    let gapLow = Number.NaN;
    let gapHigh = Number.NaN;

    if (barRight.low > barLeft.high) {
      type = 'BULLISH_FVG';
      gapLow = barLeft.high;
      gapHigh = barRight.low;
    } else if (barRight.high < barLeft.low) {
      type = 'BEARISH_FVG';
      gapLow = barRight.high;
      gapHigh = barLeft.low;
    }

    if (type === null) {
      continue;
    }

    const gapWidth = gapHigh - gapLow;
    if (!Number.isFinite(gapWidth) || gapWidth <= 0) {
      continue;
    }

    // 1) Filtro Z-Score causal sobre el rango de la vela central de desplazamiento (i - 1)
    const rangeZScore = computeCausalRangeZScore(closed, i - 1, zScoreWindow);
    if (!Number.isFinite(rangeZScore) || rangeZScore <= minRangeZScore) {
      continue;
    }

    // 2) Filtro de vacío de liquidez (LVN <= maxLvnPercentile) hasta la vela i cerrada
    const gapVolStats = computeGapVolumePercentile(
      closed.slice(0, i + 1),
      tickSize,
      gapLow,
      gapHigh,
    );
    if (!Number.isFinite(gapVolStats.percentile) || gapVolStats.percentile > maxLvnPercentile) {
      continue;
    }

    // 3) Filtro de desequilibrio agresivo de delta en la vela central
    if (barMid.volume <= 0) {
      continue;
    }
    const barDelta = resolveBarDelta(barMid);
    if (!Number.isFinite(barDelta)) {
      continue;
    }
    const deltaRatio = Math.abs(barDelta) / barMid.volume;
    const deltaAligned = type === 'BULLISH_FVG' ? barDelta > 0 : barDelta < 0;
    if (!deltaAligned || deltaRatio < minDeltaImbalanceRatio) {
      continue;
    }

    const consequentEncroachment = 0.5 * (gapLow + gapHigh);
    let fillPct = 0;
    let ceTouchTime: number | null = null;
    let fullFillTime: number | null = null;

    // Rastreo estrictamente causal de mitigación en velas j > i ya cerradas
    for (let j = i + 1; j < closed.length; j += 1) {
      const barJ = closed[j];
      if (barJ === undefined || !isFiniteOhlcv(barJ)) {
        continue;
      }

      if (type === 'BULLISH_FVG') {
        if (barJ.low < gapHigh) {
          const depth = Math.min(gapWidth, gapHigh - Math.max(gapLow, barJ.low));
          const ratio = Math.min(1, Math.max(0, depth / gapWidth));
          if (ratio > fillPct) {
            fillPct = ratio;
          }
          if (ceTouchTime === null && barJ.low <= consequentEncroachment) {
            ceTouchTime = barJ.time;
          }
          if (barJ.low <= gapLow) {
            fullFillTime = barJ.time;
            fillPct = 1;
            break;
          }
        }
      } else if (barJ.high > gapLow) {
        const depth = Math.min(gapWidth, Math.min(gapHigh, barJ.high) - gapLow);
        const ratio = Math.min(1, Math.max(0, depth / gapWidth));
        if (ratio > fillPct) {
          fillPct = ratio;
        }
        if (ceTouchTime === null && barJ.high >= consequentEncroachment) {
          ceTouchTime = barJ.time;
        }
        if (barJ.high >= gapHigh) {
          fullFillTime = barJ.time;
          fillPct = 1;
          break;
        }
      }
    }

    const mitigatedAtTime =
      mitigationMode === 'CONSEQUENT_ENCROACHMENT' ? ceTouchTime : fullFillTime;
    const isMitigated = mitigatedAtTime !== null;

    fvgs.push({
      id: `${type}:${String(barRight.time)}`,
      type,
      formedAtTime: barRight.time,
      displacementTime: barMid.time,
      gapLow,
      gapHigh,
      gapWidth,
      consequentEncroachment,
      rangeZScore,
      lvnPercentile: gapVolStats.percentile,
      averageGapBinVolume: gapVolStats.averageBinVolume,
      barDelta,
      deltaImbalanceRatio: deltaRatio,
      fillPct,
      ceTouched: ceTouchTime !== null,
      ceTouchTime,
      fullFillTime,
      isMitigated,
      mitigatedAtTime,
    });
  }

  return {
    status: 'OK',
    asOfUtcSec: options.asOfUtcSec,
    barSeconds: options.barSeconds,
    tickSize,
    closedBarCount: closed.length,
    excludedFutureCount,
    fvgs,
    activeFvgs: fvgs.filter((g) => !g.isMitigated),
  };
}

/**
 * Detecta causalmente Fresh Order Blocks (FOB) anclados a velas base con huella de
 * absorción o Dark Pool FINRA TRF (`exchange === 4`), previas a un desplazamiento que
 * quiebra el último Swing High/Low causal, rastreando su estado `isFresh` y mitigación.
 */
export function detectFreshOrderBlocks(
  bars: readonly InstitutionalFlowBar[],
  options: FreshOrderBlockOptions,
): FreshOrderBlockResult {
  assertValidUtcSeconds(options.asOfUtcSec, 'asOfUtcSec');
  if (!Number.isInteger(options.barSeconds) || options.barSeconds <= 0) {
    throw new Error(`barSeconds must be a positive integer (got ${String(options.barSeconds)})`);
  }
  validateOhlcvBars(bars, 'bars');
  validateInstitutionalBars(bars);

  const { closed, excludedFutureCount } = filterClosedBars(
    bars,
    options.barSeconds,
    options.asOfUtcSec,
  );

  const zScoreWindow =
    options.zScoreWindow === undefined ? DEFAULT_FVG_ZSCORE_WINDOW : options.zScoreWindow;
  const minDisplacementZScore =
    options.minDisplacementZScore === undefined
      ? DEFAULT_MIN_RANGE_ZSCORE
      : options.minDisplacementZScore;
  const swingLookback =
    options.swingLookback === undefined ? DEFAULT_FOB_SWING_LOOKBACK : options.swingLookback;
  const maxBaseSearchBars =
    options.maxBaseSearchBars === undefined
      ? DEFAULT_FOB_MAX_BASE_SEARCH_BARS
      : options.maxBaseSearchBars;
  const minAbsorptionVolumePercentile =
    options.minAbsorptionVolumePercentile === undefined
      ? DEFAULT_FOB_ABSORPTION_VOLUME_PERCENTILE
      : options.minAbsorptionVolumePercentile;
  const minDarkPoolShare =
    options.minDarkPoolShare === undefined
      ? DEFAULT_FOB_MIN_DARK_POOL_SHARE
      : options.minDarkPoolShare;
  const anchorMode: FobAnchorMode =
    options.anchorMode === undefined ? 'INTERNAL_POC_OR_VWAP' : options.anchorMode;

  if (
    !Number.isInteger(zScoreWindow) ||
    zScoreWindow < 2 ||
    !Number.isFinite(minDisplacementZScore) ||
    minDisplacementZScore <= 0 ||
    !Number.isInteger(swingLookback) ||
    swingLookback < 1 ||
    !Number.isInteger(maxBaseSearchBars) ||
    maxBaseSearchBars < 1 ||
    !Number.isFinite(minAbsorptionVolumePercentile) ||
    minAbsorptionVolumePercentile < 0 ||
    minAbsorptionVolumePercentile > 100 ||
    !Number.isFinite(minDarkPoolShare) ||
    minDarkPoolShare <= 0 ||
    minDarkPoolShare > 1 ||
    closed.length <= zScoreWindow
  ) {
    return {
      status: 'NO_DATA',
      asOfUtcSec: options.asOfUtcSec,
      barSeconds: options.barSeconds,
      closedBarCount: closed.length,
      excludedFutureCount,
      orderBlocks: [],
      freshOrderBlocks: [],
    };
  }

  const orderBlocks: FreshOrderBlockRecord[] = [];

  for (let d = zScoreWindow; d < closed.length; d += 1) {
    const barDisp = closed[d];
    if (barDisp === undefined || !isFiniteOhlcv(barDisp)) {
      continue;
    }

    const dispZ = computeCausalRangeZScore(closed, d, zScoreWindow);
    if (!Number.isFinite(dispZ) || dispZ <= minDisplacementZScore) {
      continue;
    }

    const swingStart = Math.max(0, d - swingLookback);
    let priorSwingHigh = Number.NEGATIVE_INFINITY;
    let priorSwingLow = Number.POSITIVE_INFINITY;
    let swingValid = true;
    for (let k = swingStart; k < d; k += 1) {
      const b = closed[k];
      if (b === undefined || !isFiniteOhlcv(b)) {
        swingValid = false;
        break;
      }
      if (b.high > priorSwingHigh) {
        priorSwingHigh = b.high;
      }
      if (b.low < priorSwingLow) {
        priorSwingLow = b.low;
      }
    }
    if (!swingValid) {
      continue;
    }

    let type: FobDirection | null = null;
    let brokenSwingLevel = Number.NaN;
    if (barDisp.close > priorSwingHigh && barDisp.close > barDisp.open) {
      type = 'BULLISH_FOB';
      brokenSwingLevel = priorSwingHigh;
    } else if (barDisp.close < priorSwingLow && barDisp.close < barDisp.open) {
      type = 'BEARISH_FOB';
      brokenSwingLevel = priorSwingLow;
    }

    if (type === null) {
      continue;
    }

    const baseSearchMinIdx = Math.max(0, d - maxBaseSearchBars);
    let chosenBaseIndex = -1;
    let chosenBaseBar: InstitutionalFlowBar | null = null;
    let chosenBaseDelta = Number.NaN;
    let chosenVolPercentile = Number.NaN;
    let chosenDpVolume = 0;
    let chosenDpShare = Number.NaN;
    let chosenAbsorptionDiv = false;
    let chosenHighVolAbs = false;
    let chosenDpFootprint = false;

    for (let b = d - 1; b >= baseSearchMinIdx; b -= 1) {
      const candidate = closed[b];
      if (candidate === undefined || !isFiniteOhlcv(candidate) || candidate.volume <= 0) {
        continue;
      }

      const baseDelta = resolveBarDelta(candidate);
      const body = candidate.close - candidate.open;
      const absorptionDivergence =
        Number.isFinite(baseDelta) &&
        ((body < 0 && baseDelta > 0) || (body > 0 && baseDelta < 0));

      const volWinStart = Math.max(0, b - zScoreWindow + 1);
      const volWindow: number[] = [];
      for (let w = volWinStart; w <= b; w += 1) {
        const wb = closed[w];
        if (wb !== undefined && Number.isFinite(wb.volume)) {
          volWindow.push(wb.volume);
        }
      }
      const volPct =
        volWindow.length === b - volWinStart + 1
          ? computeEmpiricalPercentile(volWindow, candidate.volume)
          : Number.NaN;
      const highVolumeAbsorption =
        Number.isFinite(volPct) && volPct >= minAbsorptionVolumePercentile;

      const dpVol = resolveDarkPoolVolume(candidate);
      const dpShare = dpVol / candidate.volume;
      const darkPoolFootprint = Number.isFinite(dpShare) && dpShare >= minDarkPoolShare;

      if (absorptionDivergence || highVolumeAbsorption || darkPoolFootprint) {
        chosenBaseIndex = b;
        chosenBaseBar = candidate;
        chosenBaseDelta = baseDelta;
        chosenVolPercentile = volPct;
        chosenDpVolume = dpVol;
        chosenDpShare = dpShare;
        chosenAbsorptionDiv = absorptionDivergence;
        chosenHighVolAbs = highVolumeAbsorption;
        chosenDpFootprint = darkPoolFootprint;
        break;
      }
    }

    if (chosenBaseIndex < 0 || chosenBaseBar === null) {
      continue;
    }

    const zoneLow = chosenBaseBar.low;
    const zoneHigh = chosenBaseBar.high;
    const anchor = resolveFobAnchor(chosenBaseBar, anchorMode);

    let touchCount = 0;
    let isFresh = true;
    let isMitigated = false;
    let perforated = false;
    let firstTouchTime: number | null = null;
    let mitigatedAtTime: number | null = null;

    for (let j = d + 1; j < closed.length && !isMitigated; j += 1) {
      const barJ = closed[j];
      if (barJ === undefined || !isFiniteOhlcv(barJ)) {
        continue;
      }
      if (barJ.low <= zoneHigh && barJ.high >= zoneLow) {
        touchCount += 1;
        if (touchCount === 1) {
          firstTouchTime = barJ.time;
        }
        const isPerforated =
          type === 'BULLISH_FOB' ? barJ.low < zoneLow : barJ.high > zoneHigh;
        isFresh = false;
        if (isPerforated || touchCount >= 2) {
          perforated = isPerforated;
          isMitigated = true;
          mitigatedAtTime = barJ.time;
        }
      }
    }

    orderBlocks.push({
      id: `${type}:${String(chosenBaseBar.time)}->${String(barDisp.time)}`,
      type,
      baseTime: chosenBaseBar.time,
      formedAtTime: barDisp.time,
      zoneLow,
      zoneHigh,
      anchorPrice: anchor.price,
      anchorSource: anchor.source,
      displacementZScore: dispZ,
      brokenSwingLevel,
      baseDelta: chosenBaseDelta,
      baseVolumePercentile: chosenVolPercentile,
      darkPoolVolume: chosenDpVolume,
      darkPoolShare: chosenDpShare,
      absorptionDivergence: chosenAbsorptionDiv,
      highVolumeAbsorption: chosenHighVolAbs,
      darkPoolFootprint: chosenDpFootprint,
      isFresh,
      touchCount,
      firstTouchTime,
      perforated,
      isMitigated,
      mitigatedAtTime,
    });
  }

  return {
    status: 'OK',
    asOfUtcSec: options.asOfUtcSec,
    barSeconds: options.barSeconds,
    closedBarCount: closed.length,
    excludedFutureCount,
    orderBlocks,
    freshOrderBlocks: orderBlocks.filter((ob) => ob.isFresh && !ob.isMitigated),
  };
}
