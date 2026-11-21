/**
 * Motor puro de Auction Market Theory (AMT): Composite Volume Profile,
 * nodos HVN/LVN y seguimiento causal de Naked POCs multi-sesión (Pieza 15).
 *
 * Garantías de diseño:
 *  - Funciones puras, cero red, cero E/S, cero mutación de argumentos.
 *  - Timestamps en segundos UTC enteros, agrupados en sesiones `America/New_York` (ET)
 *    mediante `getMarketParts` de `src/core/sessions.ts`.
 *  - Cero Look-Ahead Bias: filtra estrictamente `bar.time + barSeconds <= asOfUtcSec`
 *    y solo evalúa mitigaciones con barras cerradas posteriores.
 *  - Zero Silent Fallbacks: entradas vacías o parámetros inválidos (`tickSize <= 0`, etc.)
 *    devuelven `Number.NaN` y `status: 'NO_DATA'`.
 */

import { getMarketParts, MAX_TIME_SECONDS } from '../sessions.js';
import type { Bar } from '../types.js';
import {
  assertValidUtcSeconds,
  computeEmpiricalPercentile,
  filterClosedBars,
  validateOhlcvBars,
} from './mtfStructure.js';

export const DEFAULT_VALUE_AREA_PCT = 0.70;
export const DEFAULT_HVN_PERCENTILE = 85;
export const DEFAULT_LVN_PERCENTILE = 15;
/** Pieza 50.4: ventana operativa por defecto del Volume Profile (1 año operativo). */
export const DEFAULT_VOLUME_PROFILE_LOOKBACK_BARS = 252;

const BIN_EPS = 1e-12;

export type AmtStatus = 'OK' | 'NO_DATA';
export type VolumeNodeClassification = 'HVN' | 'LVN' | 'NORMAL';

export interface VolumeProfileAmtOptions {
  /** Instante de evaluación sin look-ahead en segundos UTC enteros (`bar.time + barSeconds <= asOfUtcSec`). */
  readonly asOfUtcSec: number;
  /** Duración de cada barra en segundos UTC enteros (`> 0`). */
  readonly barSeconds: number;
  /** Tamaño discreto de bin de precio (`> 0`). */
  readonly tickSize: number;
  /** Fracción de área de valor objetivo en `(0, 1]` (por defecto `0.70`). */
  readonly valueAreaPct?: number;
  /** Percentil mínimo `[0, 100]` para clasificar un bin activo como `HVN` (por defecto `85`). */
  readonly hvnPercentile?: number;
  /** Percentil máximo `[0, 100]` para clasificar un bin como `LVN` (por defecto `15`). */
  readonly lvnPercentile?: number;
  /** Ventana máxima opcional de barras cerradas recientes (`>= 1`). Si se omite, usa todas las cerradas. */
  readonly lookbackBars?: number;
}

export interface VolumeProfileBin {
  readonly price: number;
  readonly volume: number;
  readonly volumeShare: number;
  readonly volumePercentile: number;
  readonly classification: VolumeNodeClassification;
}

export interface VolumeProfileAmtResult {
  readonly status: AmtStatus;
  readonly asOfUtcSec: number;
  readonly barSeconds: number;
  readonly tickSize: number;
  readonly closedBarCount: number;
  readonly excludedFutureCount: number;
  /**
   * Pieza 50.4: cantidad efectiva de barras cerradas usadas en la ventana del perfil
   * (`Math.min(closed.length, lookbackBars)`); `0` en payloads `NO_DATA`.
   */
  readonly windowBars: number;
  readonly minPrice: number;
  readonly maxPrice: number;
  readonly poc: number;
  readonly vah: number;
  readonly val: number;
  readonly profileVwap: number;
  readonly totalVolume: number;
  readonly valueAreaVolume: number;
  readonly valueAreaCoverage: number;
  readonly bins: readonly VolumeProfileBin[];
  readonly hvnBins: readonly VolumeProfileBin[];
  readonly lvnBins: readonly VolumeProfileBin[];
}

export interface TrackNakedPocsOptions {
  /** Instante de evaluación sin look-ahead en segundos UTC enteros. */
  readonly asOfUtcSec: number;
  /** Duración de cada barra en segundos UTC enteros (`> 0`). */
  readonly barSeconds: number;
  /** Tamaño discreto de bin de precio (`> 0`). */
  readonly tickSize: number;
  /** Tolerancia de toque sobre `sessionPoc` (`>= 0`; por defecto `tickSize * 0.5`). */
  readonly touchTolerance?: number;
  /** Fracción de área de valor objetivo en `(0, 1]` (por defecto `0.70`). */
  readonly valueAreaPct?: number;
}

export interface NakedPocRecord {
  readonly sessionDate: string;
  readonly sessionPoc: number;
  readonly sessionVah: number;
  readonly sessionVal: number;
  readonly sessionVolume: number;
  readonly isNaked: boolean;
  readonly isMitigated: boolean;
  readonly testedAtTime: number | null;
  readonly mitigatedAtTime: number | null;
  readonly testedSessionDate: string | null;
}

export interface TrackNakedPocsResult {
  readonly status: AmtStatus;
  readonly asOfUtcSec: number;
  readonly barSeconds: number;
  readonly tickSize: number;
  readonly touchTolerance: number;
  readonly closedBarCount: number;
  readonly excludedFutureCount: number;
  readonly sessions: readonly NakedPocRecord[];
  readonly activeNakedPocs: readonly NakedPocRecord[];
}

interface RawHistogram {
  readonly minBinIndex: number;
  readonly maxBinIndex: number;
  readonly binVolumes: readonly number[];
  readonly activeBinVolumes: readonly number[];
  readonly minPrice: number;
  readonly maxPrice: number;
  readonly poc: number;
  readonly vah: number;
  readonly val: number;
  readonly profileVwap: number;
  readonly totalVolume: number;
  readonly valueAreaVolume: number;
  readonly valueAreaCoverage: number;
}

function isUsableBar(bar: Bar): boolean {
  return (
    Number.isFinite(bar.open) &&
    Number.isFinite(bar.high) &&
    Number.isFinite(bar.low) &&
    Number.isFinite(bar.close) &&
    Number.isFinite(bar.volume) &&
    bar.high >= bar.low &&
    bar.volume > 0
  );
}

/** Mapea un precio continuo al índice entero de bin más cercano usando `BIN_EPS`. */
export function priceToBinIndex(price: number, tickSize: number): number {
  return Math.floor(price / tickSize + 0.5 + BIN_EPS);
}

function computeProfileVwap(bars: readonly Bar[]): number {
  let pvSum = 0;
  let volSum = 0;
  for (const bar of bars) {
    if (!isUsableBar(bar)) {
      continue;
    }
    const typical =
      bar.vw !== undefined && Number.isFinite(bar.vw) && bar.vw > 0
        ? bar.vw
        : (bar.high + bar.low + bar.close) / 3;
    pvSum += typical * bar.volume;
    volSum += bar.volume;
  }
  return volSum > 0 ? pvSum / volSum : Number.NaN;
}

function selectPocIndex(
  binVolumes: readonly number[],
  minBinIndex: number,
  tickSize: number,
  profileVwap: number,
): number {
  let maxVol = -1;
  for (const vol of binVolumes) {
    if (vol > maxVol) {
      maxVol = vol;
    }
  }
  const tieEps = BIN_EPS * Math.max(1, maxVol);

  let bestArrayIdx = 0;
  let bestDistToVwap = Number.POSITIVE_INFINITY;
  let bestPrice = Number.POSITIVE_INFINITY;

  for (let i = 0; i < binVolumes.length; i += 1) {
    const vol = binVolumes[i] ?? 0;
    if (vol < maxVol - tieEps) {
      continue;
    }
    const price = (minBinIndex + i) * tickSize;
    const dist = Number.isFinite(profileVwap)
      ? Math.abs(price - profileVwap)
      : Number.POSITIVE_INFINITY;

    if (bestPrice === Number.POSITIVE_INFINITY) {
      bestArrayIdx = i;
      bestDistToVwap = dist;
      bestPrice = price;
      continue;
    }

    if (Number.isFinite(profileVwap)) {
      if (dist < bestDistToVwap - tieEps) {
        bestArrayIdx = i;
        bestDistToVwap = dist;
        bestPrice = price;
        continue;
      }
      if (Math.abs(dist - bestDistToVwap) <= tieEps && price < bestPrice) {
        bestArrayIdx = i;
        bestDistToVwap = dist;
        bestPrice = price;
      }
    } else if (price < bestPrice) {
      bestArrayIdx = i;
      bestPrice = price;
    }
  }

  return bestArrayIdx;
}

function expandValueAreaIndices(
  binVolumes: readonly number[],
  pocArrayIdx: number,
  totalVolume: number,
  valueAreaPct: number,
): { readonly lowIdx: number; readonly highIdx: number; readonly coveredVolume: number } {
  let lowIdx = pocArrayIdx;
  let highIdx = pocArrayIdx;
  let coveredVolume = binVolumes[pocArrayIdx] ?? 0;
  const targetVolume = valueAreaPct * totalVolume;
  const eps = BIN_EPS * Math.max(1, totalVolume);

  while (
    coveredVolume < targetVolume - eps &&
    (lowIdx > 0 || highIdx < binVolumes.length - 1)
  ) {
    const leftVol = lowIdx > 0 ? (binVolumes[lowIdx - 1] ?? 0) : -1;
    const rightVol = highIdx < binVolumes.length - 1 ? (binVolumes[highIdx + 1] ?? 0) : -1;

    if (leftVol < 0) {
      highIdx += 1;
      coveredVolume += rightVol;
    } else if (rightVol < 0) {
      lowIdx -= 1;
      coveredVolume += leftVol;
    } else if (leftVol > rightVol + eps) {
      lowIdx -= 1;
      coveredVolume += leftVol;
    } else if (rightVol > leftVol + eps) {
      highIdx += 1;
      coveredVolume += rightVol;
    } else {
      lowIdx -= 1;
      highIdx += 1;
      coveredVolume += leftVol + rightVol;
    }
  }

  return { lowIdx, highIdx, coveredVolume };
}

function buildRawHistogram(
  bars: readonly Bar[],
  tickSize: number,
  valueAreaPct: number,
): RawHistogram | null {
  let minPrice = Number.POSITIVE_INFINITY;
  let maxPrice = Number.NEGATIVE_INFINITY;
  let minBinIndex = Number.POSITIVE_INFINITY;
  let maxBinIndex = Number.NEGATIVE_INFINITY;
  let positiveBars = 0;

  for (const bar of bars) {
    if (!isUsableBar(bar)) {
      continue;
    }
    positiveBars += 1;
    if (bar.low < minPrice) {
      minPrice = bar.low;
    }
    if (bar.high > maxPrice) {
      maxPrice = bar.high;
    }
    const lowIdx =
      bar.high === bar.low
        ? priceToBinIndex(bar.close, tickSize)
        : priceToBinIndex(bar.low, tickSize);
    const highIdx = bar.high === bar.low ? lowIdx : priceToBinIndex(bar.high, tickSize);
    if (lowIdx < minBinIndex) {
      minBinIndex = lowIdx;
    }
    if (highIdx > maxBinIndex) {
      maxBinIndex = highIdx;
    }
  }

  if (positiveBars === 0) {
    return null;
  }

  const binCount = maxBinIndex - minBinIndex + 1;
  const binVolumes = new Array<number>(binCount).fill(0);
  let totalVolume = 0;

  for (const bar of bars) {
    if (!isUsableBar(bar)) {
      continue;
    }
    const lowIdx =
      bar.high === bar.low
        ? priceToBinIndex(bar.close, tickSize)
        : priceToBinIndex(bar.low, tickSize);
    const highIdx = bar.high === bar.low ? lowIdx : priceToBinIndex(bar.high, tickSize);
    const coveredBins = highIdx - lowIdx + 1;
    const volumePerBin = bar.volume / coveredBins;
    for (let idx = lowIdx; idx <= highIdx; idx += 1) {
      const arrayIdx = idx - minBinIndex;
      binVolumes[arrayIdx] = (binVolumes[arrayIdx] ?? 0) + volumePerBin;
    }
    totalVolume += bar.volume;
  }

  if (totalVolume <= 0) {
    return null;
  }

  const activeBinVolumes: number[] = [];
  for (const vol of binVolumes) {
    if (vol > 0) {
      activeBinVolumes.push(vol);
    }
  }

  if (activeBinVolumes.length === 0) {
    return null;
  }

  const profileVwap = computeProfileVwap(bars);
  const pocArrayIdx = selectPocIndex(binVolumes, minBinIndex, tickSize, profileVwap);
  const va = expandValueAreaIndices(binVolumes, pocArrayIdx, totalVolume, valueAreaPct);

  return {
    minBinIndex,
    maxBinIndex,
    binVolumes,
    activeBinVolumes,
    minPrice,
    maxPrice,
    poc: (minBinIndex + pocArrayIdx) * tickSize,
    val: (minBinIndex + va.lowIdx) * tickSize,
    vah: (minBinIndex + va.highIdx) * tickSize,
    profileVwap,
    totalVolume,
    valueAreaVolume: va.coveredVolume,
    valueAreaCoverage: va.coveredVolume / totalVolume,
  };
}

function emptyVolumeProfileResult(
  asOfUtcSec: number,
  barSeconds: number,
  tickSize: number,
  closedBarCount: number,
  excludedFutureCount: number,
  windowBars = 0,
): VolumeProfileAmtResult {
  return {
    status: 'NO_DATA',
    asOfUtcSec,
    barSeconds,
    tickSize,
    closedBarCount,
    excludedFutureCount,
    windowBars,
    minPrice: Number.NaN,
    maxPrice: Number.NaN,
    poc: Number.NaN,
    vah: Number.NaN,
    val: Number.NaN,
    profileVwap: Number.NaN,
    totalVolume: 0,
    valueAreaVolume: 0,
    valueAreaCoverage: Number.NaN,
    bins: [],
    hvnBins: [],
    lvnBins: [],
  };
}

/**
 * Construye el Composite Volume Profile AMT sobre barras cerradas (`<= asOfUtcSec`),
 * obteniendo `poc`, `vah`, `val`, percentiles empíricos por bin y nodos `HVN` / `LVN`.
 */
export function computeVolumeProfileAmt(
  bars: readonly Bar[],
  options: VolumeProfileAmtOptions,
): VolumeProfileAmtResult {
  assertValidUtcSeconds(options.asOfUtcSec, 'asOfUtcSec');
  if (!Number.isInteger(options.barSeconds) || options.barSeconds <= 0) {
    throw new Error(`barSeconds must be a positive integer (got ${String(options.barSeconds)})`);
  }
  validateOhlcvBars(bars, 'bars');

  const { closed, excludedFutureCount } = filterClosedBars(
    bars,
    options.barSeconds,
    options.asOfUtcSec,
  );

  const tickSize = options.tickSize;
  const lookbackBars = options.lookbackBars;
  if (
    lookbackBars !== undefined &&
    (!Number.isInteger(lookbackBars) || lookbackBars <= 0)
  ) {
    return emptyVolumeProfileResult(
      options.asOfUtcSec,
      options.barSeconds,
      Number.isFinite(tickSize) && tickSize > 0 ? tickSize : Number.NaN,
      0,
      excludedFutureCount,
      0,
    );
  }
  const windowedClosed =
    lookbackBars !== undefined && closed.length > lookbackBars
      ? closed.slice(-lookbackBars)
      : closed;

  const valueAreaPct =
    options.valueAreaPct === undefined ? DEFAULT_VALUE_AREA_PCT : options.valueAreaPct;
  const hvnPctThreshold =
    options.hvnPercentile === undefined ? DEFAULT_HVN_PERCENTILE : options.hvnPercentile;
  const lvnPctThreshold =
    options.lvnPercentile === undefined ? DEFAULT_LVN_PERCENTILE : options.lvnPercentile;

  if (
    !Number.isFinite(tickSize) ||
    tickSize <= 0 ||
    !Number.isFinite(valueAreaPct) ||
    valueAreaPct <= 0 ||
    valueAreaPct > 1 ||
    !Number.isFinite(hvnPctThreshold) ||
    hvnPctThreshold < 0 ||
    hvnPctThreshold > 100 ||
    !Number.isFinite(lvnPctThreshold) ||
    lvnPctThreshold < 0 ||
    lvnPctThreshold > 100 ||
    lvnPctThreshold > hvnPctThreshold
  ) {
    return emptyVolumeProfileResult(
      options.asOfUtcSec,
      options.barSeconds,
      Number.isFinite(tickSize) && tickSize > 0 ? tickSize : Number.NaN,
      windowedClosed.length,
      excludedFutureCount,
      windowedClosed.length,
    );
  }

  const histogram = buildRawHistogram(windowedClosed, tickSize, valueAreaPct);
  if (histogram === null) {
    return emptyVolumeProfileResult(
      options.asOfUtcSec,
      options.barSeconds,
      tickSize,
      windowedClosed.length,
      excludedFutureCount,
      windowedClosed.length,
    );
  }

  const bins: VolumeProfileBin[] = [];
  const hvnBins: VolumeProfileBin[] = [];
  const lvnBins: VolumeProfileBin[] = [];

  for (let i = 0; i < histogram.binVolumes.length; i += 1) {
    const vol = histogram.binVolumes[i] ?? 0;
    const price = (histogram.minBinIndex + i) * tickSize;
    const volumeShare = vol / histogram.totalVolume;
    const volumePercentile = computeEmpiricalPercentile(histogram.activeBinVolumes, vol);

    let classification: VolumeNodeClassification = 'NORMAL';
    if (vol > 0 && volumePercentile >= hvnPctThreshold) {
      classification = 'HVN';
    } else if (volumePercentile <= lvnPctThreshold) {
      classification = 'LVN';
    }

    const binRecord: VolumeProfileBin = {
      price,
      volume: vol,
      volumeShare,
      volumePercentile,
      classification,
    };
    bins.push(binRecord);
    if (classification === 'HVN') {
      hvnBins.push(binRecord);
    } else if (classification === 'LVN') {
      lvnBins.push(binRecord);
    }
  }

  return {
    status: 'OK',
    asOfUtcSec: options.asOfUtcSec,
    barSeconds: options.barSeconds,
    tickSize,
    closedBarCount: windowedClosed.length,
    excludedFutureCount,
    windowBars: windowedClosed.length,
    minPrice: histogram.minPrice,
    maxPrice: histogram.maxPrice,
    poc: histogram.poc,
    vah: histogram.vah,
    val: histogram.val,
    profileVwap: histogram.profileVwap,
    totalVolume: histogram.totalVolume,
    valueAreaVolume: histogram.valueAreaVolume,
    valueAreaCoverage: histogram.valueAreaCoverage,
    bins,
    hvnBins,
    lvnBins,
  };
}

/**
 * Calcula causalmente el volumen medio y percentil empírico `[0, 100]` de los bins cubiertos
 * por el intervalo `[gapLow, gapHigh]` dentro del perfil acumulado sobre `bars`.
 */
export function computeGapVolumePercentile(
  bars: readonly Bar[],
  tickSize: number,
  gapLow: number,
  gapHigh: number,
): { readonly averageBinVolume: number; readonly percentile: number } {
  if (
    !Number.isFinite(tickSize) ||
    tickSize <= 0 ||
    !Number.isFinite(gapLow) ||
    !Number.isFinite(gapHigh) ||
    gapHigh < gapLow
  ) {
    return { averageBinVolume: Number.NaN, percentile: Number.NaN };
  }

  const histogram = buildRawHistogram(bars, tickSize, DEFAULT_VALUE_AREA_PCT);
  if (histogram === null) {
    return { averageBinVolume: Number.NaN, percentile: Number.NaN };
  }

  const lowIdx = priceToBinIndex(gapLow, tickSize);
  const highIdx = priceToBinIndex(gapHigh, tickSize);
  const count = highIdx - lowIdx + 1;
  if (count <= 0) {
    return { averageBinVolume: Number.NaN, percentile: Number.NaN };
  }

  let sumVol = 0;
  for (let idx = lowIdx; idx <= highIdx; idx += 1) {
    if (idx >= histogram.minBinIndex && idx <= histogram.maxBinIndex) {
      sumVol += histogram.binVolumes[idx - histogram.minBinIndex] ?? 0;
    }
  }

  const averageBinVolume = sumVol / count;
  const percentile = computeEmpiricalPercentile(histogram.activeBinVolumes, averageBinVolume);
  return { averageBinVolume, percentile };
}

/**
 * Agrupa las barras cerradas (`<= asOfUtcSec`) por sesión `America/New_York` (`YYYY-MM-DD`),
 * calcula el POC de cada sesión previa completada y rastrea si alguna sesión posterior lo tocó.
 */
export function trackNakedPocs(
  bars: readonly Bar[],
  options: TrackNakedPocsOptions,
): TrackNakedPocsResult {
  assertValidUtcSeconds(options.asOfUtcSec, 'asOfUtcSec');
  if (Math.abs(options.asOfUtcSec) > MAX_TIME_SECONDS) {
    throw new Error(`asOfUtcSec out of bounds: ${String(options.asOfUtcSec)}`);
  }
  if (!Number.isInteger(options.barSeconds) || options.barSeconds <= 0) {
    throw new Error(`barSeconds must be a positive integer (got ${String(options.barSeconds)})`);
  }
  validateOhlcvBars(bars, 'bars');

  const { closed, excludedFutureCount } = filterClosedBars(
    bars,
    options.barSeconds,
    options.asOfUtcSec,
  );

  const tickSize = options.tickSize;
  const touchTolerance =
    options.touchTolerance === undefined ? tickSize * 0.5 : options.touchTolerance;
  const valueAreaPct =
    options.valueAreaPct === undefined ? DEFAULT_VALUE_AREA_PCT : options.valueAreaPct;

  if (
    !Number.isFinite(tickSize) ||
    tickSize <= 0 ||
    !Number.isFinite(touchTolerance) ||
    touchTolerance < 0 ||
    !Number.isFinite(valueAreaPct) ||
    valueAreaPct <= 0 ||
    valueAreaPct > 1
  ) {
    return {
      status: 'NO_DATA',
      asOfUtcSec: options.asOfUtcSec,
      barSeconds: options.barSeconds,
      tickSize: Number.isFinite(tickSize) && tickSize > 0 ? tickSize : Number.NaN,
      touchTolerance: Number.isFinite(touchTolerance) && touchTolerance >= 0 ? touchTolerance : Number.NaN,
      closedBarCount: closed.length,
      excludedFutureCount,
      sessions: [],
      activeNakedPocs: [],
    };
  }

  const asOfSessionDate = getMarketParts(options.asOfUtcSec, 'EQUITY').dateKey;

  const barsWithSession: Array<{ readonly bar: Bar; readonly sessionDate: string }> = [];
  const orderedSessionDates: string[] = [];
  const barsBySession = new Map<string, Bar[]>();

  for (const bar of closed) {
    const sessionDate = getMarketParts(bar.time, 'EQUITY').dateKey;
    barsWithSession.push({ bar, sessionDate });
    const existing = barsBySession.get(sessionDate);
    if (existing === undefined) {
      barsBySession.set(sessionDate, [bar]);
      orderedSessionDates.push(sessionDate);
    } else {
      existing.push(bar);
    }
  }

  const completedPriorDates = orderedSessionDates.filter((d) => d < asOfSessionDate);
  if (completedPriorDates.length === 0) {
    return {
      status: 'NO_DATA',
      asOfUtcSec: options.asOfUtcSec,
      barSeconds: options.barSeconds,
      tickSize,
      touchTolerance,
      closedBarCount: closed.length,
      excludedFutureCount,
      sessions: [],
      activeNakedPocs: [],
    };
  }

  const sessions: NakedPocRecord[] = [];
  const activeNakedPocs: NakedPocRecord[] = [];

  for (const sessionDate of completedPriorDates) {
    const sessionBars = barsBySession.get(sessionDate);
    if (sessionBars === undefined) {
      continue;
    }
    const histogram = buildRawHistogram(sessionBars, tickSize, valueAreaPct);
    if (histogram === null) {
      continue;
    }

    const pocPrice = histogram.poc;
    let testedAtTime: number | null = null;
    let testedSessionDate: string | null = null;

    for (const entry of barsWithSession) {
      if (entry.sessionDate <= sessionDate) {
        continue;
      }
      if (!Number.isFinite(entry.bar.low) || !Number.isFinite(entry.bar.high)) {
        continue;
      }
      if (
        entry.bar.low <= pocPrice + touchTolerance &&
        entry.bar.high >= pocPrice - touchTolerance
      ) {
        testedAtTime = entry.bar.time;
        testedSessionDate = entry.sessionDate;
        break;
      }
    }

    const isNaked = testedAtTime === null;
    const record: NakedPocRecord = {
      sessionDate,
      sessionPoc: pocPrice,
      sessionVah: histogram.vah,
      sessionVal: histogram.val,
      sessionVolume: histogram.totalVolume,
      isNaked,
      isMitigated: !isNaked,
      testedAtTime,
      mitigatedAtTime: testedAtTime,
      testedSessionDate,
    };
    sessions.push(record);
    if (isNaked) {
      activeNakedPocs.push(record);
    }
  }

  if (sessions.length === 0) {
    return {
      status: 'NO_DATA',
      asOfUtcSec: options.asOfUtcSec,
      barSeconds: options.barSeconds,
      tickSize,
      touchTolerance,
      closedBarCount: closed.length,
      excludedFutureCount,
      sessions: [],
      activeNakedPocs: [],
    };
  }

  return {
    status: 'OK',
    asOfUtcSec: options.asOfUtcSec,
    barSeconds: options.barSeconds,
    tickSize,
    touchTolerance,
    closedBarCount: closed.length,
    excludedFutureCount,
    sessions,
    activeNakedPocs,
  };
}
