/**
 * Motor puro de Amplitud de Mercado (A/D Line + Divergencias) y Régimen de
 * Volatilidad Macro (`VIX` + `CBOE SKEW`, Bloque C — Parte 2 / Pieza 11).
 *
 * Garantías de diseño:
 *  - Funciones puras, cero red, cero E/S, cero mutación de argumentos.
 *  - Todos los timestamps en segundos UTC enteros (rechaza milisegundos).
 *  - Cero Look-Ahead Bias: solo consume datos cerrados (`time + barSeconds <= asOfUtcSec`)
 *    y pivotes confirmados tras cerrar `rightBars` velas derechas.
 *  - Cero fallbacks silenciosos: valores insuficientes o inválidos (`<= 0`, `NaN`)
 *    devuelven `Number.NaN` y estado `'INSUFFICIENT_DATA'`.
 */

import type { Bar } from '../types.js';
import {
  assertIntegerAtLeast,
  assertUtcSeconds,
  detectConfirmedPivotsFromSeries,
  filterClosedRecords,
  validateIncreasingTimes,
  type ConfirmedPivot,
  type TimedRecord,
} from './divergences.js';

export const DEFAULT_BREADTH_LEFT_BARS = 3;
export const DEFAULT_BREADTH_RIGHT_BARS = 3;
export const DEFAULT_MACRO_BAR_SECONDS = 86_400;
export const DEFAULT_VIX_SLOPE_WINDOW = 5;
export const DEFAULT_SKEW_ALERT_THRESHOLD = 145.0;
export const DEFAULT_SKEW_ELEVATED_THRESHOLD = 135.0;

export interface BreadthBarInput extends TimedRecord {
  readonly indexClose: number;
  readonly indexHigh?: number;
  readonly indexLow?: number;
  readonly advances: number;
  readonly declines: number;
}

export interface MarketBreadthOptions {
  readonly asOfUtcSec: number;
  readonly barSeconds: number;
  readonly initialAdLine?: number;
  readonly leftBars?: number;
  readonly rightBars?: number;
  readonly maxPivotSeparationBars?: number;
}

export type BreadthDivergenceType =
  | 'BEARISH_BREADTH_DIVERGENCE'
  | 'BULLISH_BREADTH_DIVERGENCE';

export type BreadthDivergenceStatus =
  | BreadthDivergenceType
  | 'NONE'
  | 'INSUFFICIENT_DATA';

export interface BreadthPoint {
  readonly time: number;
  readonly indexClose: number;
  readonly advances: number;
  readonly declines: number;
  readonly adNet: number;
  readonly adLine: number;
  readonly adRatio: number;
}

export interface BreadthDivergenceEvent {
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

export interface MarketBreadthResult {
  readonly asOfUtcSec: number;
  readonly barSeconds: number;
  readonly closedBarCount: number;
  readonly excludedFutureCount: number;
  readonly series: readonly BreadthPoint[];
  readonly latestAdNet: number;
  readonly latestAdLine: number;
  readonly latestAdRatio: number;
  readonly indexSwingHighs: readonly ConfirmedPivot[];
  readonly indexSwingLows: readonly ConfirmedPivot[];
  readonly divergences: readonly BreadthDivergenceEvent[];
  readonly latestDivergence: BreadthDivergenceEvent | null;
  readonly divergenceStatus: BreadthDivergenceStatus;
}

export interface MacroSeriesPoint extends TimedRecord {
  readonly value: number;
}

export type MacroValueInput = MacroSeriesPoint | Bar;

export interface MacroVolatilityInputs {
  readonly vix: readonly MacroValueInput[];
  readonly cboeSkew: number | readonly MacroValueInput[];
}

export interface MacroVolatilityOptions {
  readonly asOfUtcSec: number;
  /** Duración en segundos para series de VIX (por defecto `86400`; `0` si son ticks puntuales). */
  readonly vixBarSeconds?: number;
  /** Duración en segundos para serie SKEW cuando se pasa como array (por defecto `vixBarSeconds`). */
  readonly skewBarSeconds?: number;
  /** Ventana OLS para pendiente de VIX en puntos cerrados (por defecto `5`, entero `>= 2`). */
  readonly vixSlopeWindow?: number;
  /** Umbral de alerta institucional de cola izquierda CBOE SKEW (por defecto `145.0`). */
  readonly skewAlertThreshold?: number;
}

export type VixRegime =
  | 'LOW_VOL_COMPLACENCY'
  | 'NORMAL_VOL_REGIME'
  | 'ELEVATED_VOL_EXPANSION'
  | 'CRISIS_HIGH_VOL'
  | 'INSUFFICIENT_DATA';

export interface MacroVolatilityRegimeResult {
  readonly asOfUtcSec: number;
  readonly closedVixCount: number;
  readonly excludedFutureVixCount: number;
  readonly closedSkewCount: number;
  readonly excludedFutureSkewCount: number;
  readonly vixLevel: number;
  readonly vixSlope: number;
  readonly cboeSkewLevel: number;
  readonly vixRegime: VixRegime;
  readonly tailRiskAlert: boolean;
  readonly baseVixFactor: number;
  readonly vixSlopePenaltyFactor: number;
  readonly skewPenaltyFactor: number;
  readonly positionSizeMultiplier: number;
}

function validateBreadthInputs(series: readonly BreadthBarInput[]): void {
  validateIncreasingTimes(series, 'breadthSeries');
  for (let i = 0; i < series.length; i += 1) {
    const item = series[i];
    if (item === undefined) {
      continue;
    }
    if (Number.isFinite(item.advances) && item.advances < 0) {
      throw new Error(`breadthSeries[${String(i)}].advances must be >= 0 (got ${String(item.advances)})`);
    }
    if (Number.isFinite(item.declines) && item.declines < 0) {
      throw new Error(`breadthSeries[${String(i)}].declines must be >= 0 (got ${String(item.declines)})`);
    }
    if (
      item.indexHigh !== undefined &&
      item.indexLow !== undefined &&
      Number.isFinite(item.indexHigh) &&
      Number.isFinite(item.indexLow) &&
      item.indexHigh < item.indexLow
    ) {
      throw new Error(
        `breadthSeries[${String(i)}].indexHigh (${String(item.indexHigh)}) cannot be lower than indexLow (${String(item.indexLow)})`,
      );
    }
  }
}

function evaluateBreadthPivotPair(
  p1: ConfirmedPivot,
  p2: ConfirmedPivot,
  adLineSeries: readonly number[],
  type: BreadthDivergenceType,
  maxSep: number | undefined,
): BreadthDivergenceEvent | null {
  if (maxSep !== undefined && p2.pivotIndex - p1.pivotIndex > maxSep) {
    return null;
  }
  const ad1 = adLineSeries[p1.pivotIndex];
  const ad2 = adLineSeries[p2.pivotIndex];
  if (ad1 === undefined || ad2 === undefined || !Number.isFinite(ad1) || !Number.isFinite(ad2)) {
    return null;
  }
  const triggered =
    type === 'BEARISH_BREADTH_DIVERGENCE'
      ? p2.price > p1.price && ad2 < ad1
      : p2.price < p1.price && ad2 > ad1;
  if (!triggered) {
    return null;
  }
  return {
    type,
    pivot1Index: p1.pivotIndex,
    pivot2Index: p2.pivotIndex,
    pivot1Time: p1.time,
    pivot2Time: p2.time,
    indexPrice1: p1.price,
    indexPrice2: p2.price,
    adLine1: ad1,
    adLine2: ad2,
    confirmedAtIndex: p2.confirmedAtIndex,
    confirmedAtTime: p2.confirmedAtTime,
    confirmedAtCloseUtcSec: p2.confirmedAtCloseUtcSec,
  };
}

/**
 * Calcula `adNet`, `adLine` acumulada y `adRatio` junto con detección causal de
 * divergencias estructurales índice vs `A/D Line` sobre pivotes confirmados.
 */
export function evaluateMarketBreadth(
  series: readonly BreadthBarInput[],
  options: MarketBreadthOptions,
): MarketBreadthResult {
  assertUtcSeconds(options.asOfUtcSec, 'asOfUtcSec');
  const barSeconds = assertIntegerAtLeast(options.barSeconds, 'barSeconds', 1);
  const initialAdLine = options.initialAdLine ?? 0;
  const leftBars = assertIntegerAtLeast(
    options.leftBars ?? DEFAULT_BREADTH_LEFT_BARS,
    'leftBars',
    1,
  );
  const rightBars = assertIntegerAtLeast(
    options.rightBars ?? DEFAULT_BREADTH_RIGHT_BARS,
    'rightBars',
    1,
  );
  const maxSep =
    options.maxPivotSeparationBars !== undefined
      ? assertIntegerAtLeast(options.maxPivotSeparationBars, 'maxPivotSeparationBars', 1)
      : undefined;

  validateBreadthInputs(series);
  const { closed, excludedFutureCount } = filterClosedRecords(series, barSeconds, options.asOfUtcSec);

  const points: BreadthPoint[] = [];
  const adLineSeries: number[] = [];
  let runningAdLine = initialAdLine;
  let adLinePoisoned = !Number.isFinite(initialAdLine);

  for (const item of closed) {
    const validCounts = Number.isFinite(item.advances) && Number.isFinite(item.declines);
    const adNet = validCounts ? item.advances - item.declines : Number.NaN;
    if (!Number.isFinite(adNet)) {
      adLinePoisoned = true;
    } else if (!adLinePoisoned) {
      runningAdLine += adNet;
    }
    const adLine = adLinePoisoned ? Number.NaN : runningAdLine;
    const total = validCounts ? item.advances + item.declines : Number.NaN;
    const adRatio = Number.isFinite(total) && total > 0 ? item.advances / total : Number.NaN;

    adLineSeries.push(adLine);
    points.push({
      time: item.time,
      indexClose: item.indexClose,
      advances: item.advances,
      declines: item.declines,
      adNet,
      adLine,
      adRatio,
    });
  }

  const times = closed.map((b) => b.time);
  const highs = closed.map((b) => (b.indexHigh !== undefined ? b.indexHigh : b.indexClose));
  const lows = closed.map((b) => (b.indexLow !== undefined ? b.indexLow : b.indexClose));
  const { swingHighs, swingLows } = detectConfirmedPivotsFromSeries(
    times,
    highs,
    lows,
    barSeconds,
    leftBars,
    rightBars,
  );

  const divergences: BreadthDivergenceEvent[] = [];
  let lastHighPairDiv: BreadthDivergenceEvent | null = null;
  let lastLowPairDiv: BreadthDivergenceEvent | null = null;

  for (let i = 1; i < swingHighs.length; i += 1) {
    const p1 = swingHighs[i - 1];
    const p2 = swingHighs[i];
    if (p1 === undefined || p2 === undefined) {
      continue;
    }
    const evt = evaluateBreadthPivotPair(p1, p2, adLineSeries, 'BEARISH_BREADTH_DIVERGENCE', maxSep);
    if (evt !== null) {
      divergences.push(evt);
      if (i === swingHighs.length - 1) {
        lastHighPairDiv = evt;
      }
    }
  }

  for (let i = 1; i < swingLows.length; i += 1) {
    const p1 = swingLows[i - 1];
    const p2 = swingLows[i];
    if (p1 === undefined || p2 === undefined) {
      continue;
    }
    const evt = evaluateBreadthPivotPair(p1, p2, adLineSeries, 'BULLISH_BREADTH_DIVERGENCE', maxSep);
    if (evt !== null) {
      divergences.push(evt);
      if (i === swingLows.length - 1) {
        lastLowPairDiv = evt;
      }
    }
  }

  divergences.sort(
    (a, b) =>
      a.confirmedAtIndex - b.confirmedAtIndex ||
      a.pivot2Index - b.pivot2Index ||
      a.type.localeCompare(b.type),
  );

  let divergenceStatus: BreadthDivergenceStatus;
  if (swingHighs.length < 2 && swingLows.length < 2) {
    divergenceStatus = 'INSUFFICIENT_DATA';
  } else if (lastHighPairDiv !== null && lastLowPairDiv !== null) {
    divergenceStatus =
      lastHighPairDiv.confirmedAtCloseUtcSec >= lastLowPairDiv.confirmedAtCloseUtcSec
        ? lastHighPairDiv.type
        : lastLowPairDiv.type;
  } else if (lastHighPairDiv !== null) {
    divergenceStatus = lastHighPairDiv.type;
  } else if (lastLowPairDiv !== null) {
    divergenceStatus = lastLowPairDiv.type;
  } else {
    divergenceStatus = 'NONE';
  }

  const lastPt = points.length > 0 ? points[points.length - 1] : undefined;
  const latestDivergence =
    divergences.length > 0 ? (divergences[divergences.length - 1] ?? null) : null;

  return {
    asOfUtcSec: options.asOfUtcSec,
    barSeconds,
    closedBarCount: points.length,
    excludedFutureCount,
    series: points,
    latestAdNet: lastPt !== undefined ? lastPt.adNet : Number.NaN,
    latestAdLine: lastPt !== undefined ? lastPt.adLine : Number.NaN,
    latestAdRatio: lastPt !== undefined ? lastPt.adRatio : Number.NaN,
    indexSwingHighs: swingHighs,
    indexSwingLows: swingLows,
    divergences,
    latestDivergence,
    divergenceStatus,
  };
}

function extractMacroValue(point: MacroValueInput): number {
  return 'value' in point ? point.value : point.close;
}

function computeOlsSlope(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) {
    return Number.NaN;
  }
  const meanX = (n - 1) / 2;
  let sumY = 0;
  for (const y of values) {
    if (!Number.isFinite(y) || y <= 0) {
      return Number.NaN;
    }
    sumY += y;
  }
  const meanY = sumY / n;

  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    const y = values[i];
    if (y === undefined) {
      return Number.NaN;
    }
    const dx = i - meanX;
    sxx += dx * dx;
    sxy += dx * (y - meanY);
  }
  return sxx > 0 ? sxy / sxx : Number.NaN;
}

function classifyVixRegimeAndFactor(vixLevel: number): {
  readonly regime: Exclude<VixRegime, 'INSUFFICIENT_DATA'>;
  readonly factor: number;
} {
  if (vixLevel < 15) {
    return { regime: 'LOW_VOL_COMPLACENCY', factor: 1.0 };
  }
  if (vixLevel < 22) {
    return { regime: 'NORMAL_VOL_REGIME', factor: 0.9 };
  }
  if (vixLevel < 30) {
    return { regime: 'ELEVATED_VOL_EXPANSION', factor: 0.65 };
  }
  return { regime: 'CRISIS_HIGH_VOL', factor: 0.35 };
}

/**
 * Evalúa el régimen de volatilidad macro (`VIX` + `CBOE SKEW`), pendiente OLS reciente
 * de VIX, alerta de riesgo de cola izquierda y multiplicador determinista en `(0, 1]`.
 */
export function evaluateMacroVolatilityRegime(
  inputs: MacroVolatilityInputs,
  options: MacroVolatilityOptions,
): MacroVolatilityRegimeResult {
  assertUtcSeconds(options.asOfUtcSec, 'asOfUtcSec');
  const vixBarSeconds = assertIntegerAtLeast(
    options.vixBarSeconds ?? DEFAULT_MACRO_BAR_SECONDS,
    'vixBarSeconds',
    0,
  );
  const skewBarSeconds = assertIntegerAtLeast(
    options.skewBarSeconds ?? vixBarSeconds,
    'skewBarSeconds',
    0,
  );
  const vixSlopeWindow = assertIntegerAtLeast(
    options.vixSlopeWindow ?? DEFAULT_VIX_SLOPE_WINDOW,
    'vixSlopeWindow',
    2,
  );
  const skewAlertThreshold = options.skewAlertThreshold ?? DEFAULT_SKEW_ALERT_THRESHOLD;
  if (!Number.isFinite(skewAlertThreshold) || skewAlertThreshold <= 0) {
    throw new Error(`skewAlertThreshold must be finite > 0 (got ${String(skewAlertThreshold)})`);
  }

  validateIncreasingTimes(inputs.vix, 'vix');
  const vixFiltered = filterClosedRecords(inputs.vix, vixBarSeconds, options.asOfUtcSec);
  const closedVixValues = vixFiltered.closed.map(extractMacroValue);

  const lastVixRaw =
    closedVixValues.length > 0 ? closedVixValues[closedVixValues.length - 1] : undefined;
  const vixLevel =
    lastVixRaw !== undefined && Number.isFinite(lastVixRaw) && lastVixRaw > 0
      ? lastVixRaw
      : Number.NaN;

  const vixSlope =
    closedVixValues.length >= vixSlopeWindow
      ? computeOlsSlope(closedVixValues.slice(closedVixValues.length - vixSlopeWindow))
      : Number.NaN;

  let closedSkewCount = 0;
  let excludedFutureSkewCount = 0;
  let cboeSkewLevel = Number.NaN;

  if (typeof inputs.cboeSkew === 'number') {
    if (Number.isFinite(inputs.cboeSkew) && inputs.cboeSkew > 0) {
      cboeSkewLevel = inputs.cboeSkew;
      closedSkewCount = 1;
    }
  } else {
    validateIncreasingTimes(inputs.cboeSkew, 'cboeSkew');
    const skewFiltered = filterClosedRecords(inputs.cboeSkew, skewBarSeconds, options.asOfUtcSec);
    closedSkewCount = skewFiltered.closed.length;
    excludedFutureSkewCount = skewFiltered.excludedFutureCount;
    const lastSkewPt =
      skewFiltered.closed.length > 0
        ? skewFiltered.closed[skewFiltered.closed.length - 1]
        : undefined;
    if (lastSkewPt !== undefined) {
      const rawSkew = extractMacroValue(lastSkewPt);
      if (Number.isFinite(rawSkew) && rawSkew > 0) {
        cboeSkewLevel = rawSkew;
      }
    }
  }

  if (!Number.isFinite(vixLevel) || !Number.isFinite(cboeSkewLevel)) {
    return {
      asOfUtcSec: options.asOfUtcSec,
      closedVixCount: closedVixValues.length,
      excludedFutureVixCount: vixFiltered.excludedFutureCount,
      closedSkewCount,
      excludedFutureSkewCount,
      vixLevel,
      vixSlope,
      cboeSkewLevel,
      vixRegime: 'INSUFFICIENT_DATA',
      tailRiskAlert: false,
      baseVixFactor: Number.NaN,
      vixSlopePenaltyFactor: Number.NaN,
      skewPenaltyFactor: Number.NaN,
      positionSizeMultiplier: Number.NaN,
    };
  }

  const { regime, factor: baseVixFactor } = classifyVixRegimeAndFactor(vixLevel);
  const vixSlopePenaltyFactor = Number.isFinite(vixSlope) && vixSlope > 0 ? 0.85 : 1.0;

  let skewPenaltyFactor = 1.0;
  if (cboeSkewLevel >= skewAlertThreshold) {
    skewPenaltyFactor = 0.8;
  } else if (cboeSkewLevel >= DEFAULT_SKEW_ELEVATED_THRESHOLD) {
    skewPenaltyFactor = 0.9;
  }

  const tailRiskAlert =
    cboeSkewLevel >= skewAlertThreshold ||
    (vixLevel >= 22.0 && Number.isFinite(vixSlope) && vixSlope > 0);
  const positionSizeMultiplier = baseVixFactor * vixSlopePenaltyFactor * skewPenaltyFactor;

  return {
    asOfUtcSec: options.asOfUtcSec,
    closedVixCount: closedVixValues.length,
    excludedFutureVixCount: vixFiltered.excludedFutureCount,
    closedSkewCount,
    excludedFutureSkewCount,
    vixLevel,
    vixSlope,
    cboeSkewLevel,
    vixRegime: regime,
    tailRiskAlert,
    baseVixFactor,
    vixSlopePenaltyFactor,
    skewPenaltyFactor,
    positionSizeMultiplier,
  };
}
