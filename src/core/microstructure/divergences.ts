/**
 * Motor puro de Wilder RSI(14), Pivotes Causales y Divergencias RSI / SMT
 * (Bloque C — Parte 2 / Pieza 11).
 *
 * Garantías de diseño:
 *  - Funciones puras, cero red, cero E/S, cero mutación de argumentos.
 *  - Timestamps en segundos UTC enteros (`|time| <= MAX_TIME_SECONDS`).
 *  - Invariante crítico sin Look-Ahead Bias: todo pivote en `p` con ventana
 *    `(leftBars, rightBars)` solo existe una vez cerrada la barra `p + rightBars`
 *    (`bars[p + rightBars].time + barSeconds <= asOfUtcSec`).
 *  - Cero fallbacks silenciosos: sin warmup suficiente devuelve `Number.NaN` y
 *    estado `'INSUFFICIENT_DATA'`.
 */

import { MAX_TIME_SECONDS } from '../sessions.js';
import type { Bar } from '../types.js';

export const DEFAULT_RSI_PERIOD = 14;
export const DEFAULT_PIVOT_LEFT_BARS = 3;
export const DEFAULT_PIVOT_RIGHT_BARS = 3;
export const DEFAULT_MIN_PIVOT_SEPARATION_BARS = 1;
export const DEFAULT_MAX_SMT_PIVOT_SKEW_BARS = 0;

export type PivotKind = 'SWING_HIGH' | 'SWING_LOW';

export type RsiDivergenceType =
  | 'RSI_REGULAR_BULLISH'
  | 'RSI_REGULAR_BEARISH'
  | 'RSI_HIDDEN_BULLISH'
  | 'RSI_HIDDEN_BEARISH';

export type SmtDivergenceType = 'SMT_BULLISH' | 'SMT_BEARISH';
export type SmtSweepingAsset = 'PRIMARY' | 'CORRELATED';
export type DivergenceStatus = 'OK' | 'INSUFFICIENT_DATA';

export interface TimedRecord {
  readonly time: number;
}

export interface ConfirmedPivot {
  readonly kind: PivotKind;
  readonly pivotIndex: number;
  readonly time: number;
  readonly price: number;
  readonly confirmedAtIndex: number;
  readonly confirmedAtTime: number;
  readonly confirmedAtCloseUtcSec: number;
}

export interface DetectPivotsOptions {
  /** Instante de evaluación sin look-ahead en segundos UTC enteros (`bar.time + barSeconds <= asOfUtcSec`). */
  readonly asOfUtcSec: number;
  /** Duración de cada barra en segundos UTC enteros (`>= 1`). */
  readonly barSeconds: number;
  readonly leftBars?: number;
  readonly rightBars?: number;
}

export interface PivotDetectionResult {
  readonly asOfUtcSec: number;
  readonly closedBarCount: number;
  readonly excludedFutureCount: number;
  readonly pivots: readonly ConfirmedPivot[];
  readonly swingHighs: readonly ConfirmedPivot[];
  readonly swingLows: readonly ConfirmedPivot[];
}

export interface DetectRsiDivergencesOptions {
  readonly asOfUtcSec: number;
  readonly barSeconds: number;
  readonly rsiPeriod?: number;
  readonly leftBars?: number;
  readonly rightBars?: number;
  readonly minPivotSeparationBars?: number;
  readonly maxPivotSeparationBars?: number;
}

export interface RsiDivergenceEvent {
  readonly type: RsiDivergenceType;
  readonly pivot1Index: number;
  readonly pivot2Index: number;
  readonly pivot1Time: number;
  readonly pivot2Time: number;
  readonly price1: number;
  readonly price2: number;
  readonly rsi1: number;
  readonly rsi2: number;
  readonly confirmedAtIndex: number;
  readonly confirmedAtTime: number;
  readonly confirmedAtCloseUtcSec: number;
}

export interface RsiDivergenceResult {
  readonly asOfUtcSec: number;
  readonly barSeconds: number;
  readonly closedBarCount: number;
  readonly excludedFutureCount: number;
  readonly status: DivergenceStatus;
  readonly rsiPeriod: number;
  readonly rsiSeries: readonly number[];
  readonly latestRsi: number;
  readonly swingHighs: readonly ConfirmedPivot[];
  readonly swingLows: readonly ConfirmedPivot[];
  readonly divergences: readonly RsiDivergenceEvent[];
  readonly latestDivergence: RsiDivergenceEvent | null;
}

export interface DetectSmtDivergencesOptions {
  readonly asOfUtcSec: number;
  readonly barSeconds: number;
  readonly leftBars?: number;
  readonly rightBars?: number;
  readonly minPivotSeparationBars?: number;
  readonly maxPivotSeparationBars?: number;
  /** Desfase máximo permitido entre pivotes sincronizados de ambos activos (por defecto `0`). */
  readonly maxPivotSkewBars?: number;
}

export interface SmtDivergenceEvent {
  readonly type: SmtDivergenceType;
  readonly sweepingAsset: SmtSweepingAsset;
  readonly primaryPivot1Index: number;
  readonly primaryPivot2Index: number;
  readonly correlatedPivot1Index: number;
  readonly correlatedPivot2Index: number;
  readonly primaryPivot1Time: number;
  readonly primaryPivot2Time: number;
  readonly correlatedPivot1Time: number;
  readonly correlatedPivot2Time: number;
  readonly primaryPrice1: number;
  readonly primaryPrice2: number;
  readonly correlatedPrice1: number;
  readonly correlatedPrice2: number;
  readonly confirmedAtTime: number;
  readonly confirmedAtCloseUtcSec: number;
}

export interface SmtDivergenceResult {
  readonly asOfUtcSec: number;
  readonly barSeconds: number;
  readonly synchronizedBarCount: number;
  readonly excludedFuturePrimaryCount: number;
  readonly excludedFutureCorrelatedCount: number;
  readonly status: DivergenceStatus;
  readonly primarySwingHighs: readonly ConfirmedPivot[];
  readonly primarySwingLows: readonly ConfirmedPivot[];
  readonly correlatedSwingHighs: readonly ConfirmedPivot[];
  readonly correlatedSwingLows: readonly ConfirmedPivot[];
  readonly divergences: readonly SmtDivergenceEvent[];
  readonly latestDivergence: SmtDivergenceEvent | null;
}

interface PairedPivot {
  readonly primary: ConfirmedPivot;
  readonly correlated: ConfirmedPivot;
}

/** Valida que `time` sea un entero finito en segundos UTC (`|time| <= MAX_TIME_SECONDS`). */
export function assertUtcSeconds(time: number, label: string): void {
  if (!Number.isFinite(time) || !Number.isInteger(time) || Math.abs(time) > MAX_TIME_SECONDS) {
    throw new Error(`${label} must be finite integer UTC seconds (got ${String(time)})`);
  }
}

/** Valida que una opción numérica sea entero `>= minValue`. */
export function assertIntegerAtLeast(value: number, label: string, minValue: number): number {
  if (!Number.isInteger(value) || value < minValue) {
    throw new Error(`${label} must be an integer >= ${String(minValue)} (got ${String(value)})`);
  }
  return value;
}

/** Valida timestamps estrictamente crecientes en segundos UTC enteros. */
export function validateIncreasingTimes(items: readonly TimedRecord[], label: string): void {
  let prevTime = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item === undefined) {
      continue;
    }
    assertUtcSeconds(item.time, `${label}[${String(i)}].time`);
    if (item.time <= prevTime) {
      throw new Error(
        `${label} timestamps must be strictly increasing (${String(item.time)} <= ${String(prevTime)})`,
      );
    }
    prevTime = item.time;
  }
}

/** Valida integridad estructural de barras OHLCV (`time` en segundos UTC crecientes, `high >= low`, `volume >= 0`). */
export function validateOhlcvBarsSequence(bars: readonly Bar[], label: string): void {
  validateIncreasingTimes(bars, label);
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (bar === undefined) {
      continue;
    }
    if (Number.isFinite(bar.high) && Number.isFinite(bar.low) && bar.high < bar.low) {
      throw new Error(
        `${label}[${String(i)}] high (${String(bar.high)}) cannot be lower than low (${String(bar.low)})`,
      );
    }
    if (Number.isFinite(bar.volume) && bar.volume < 0) {
      throw new Error(`${label}[${String(i)}] volume must be >= 0 (got ${String(bar.volume)})`);
    }
  }
}

/** Filtra elementos cerrados respecto a `asOfUtcSec` (`item.time + barSeconds <= asOfUtcSec`). */
export function filterClosedRecords<T extends TimedRecord>(
  items: readonly T[],
  barSeconds: number,
  asOfUtcSec: number,
): { readonly closed: T[]; readonly excludedFutureCount: number } {
  const closed: T[] = [];
  let excludedFutureCount = 0;
  for (const item of items) {
    if (item.time + barSeconds <= asOfUtcSec) {
      closed.push(item);
    } else {
      excludedFutureCount += 1;
    }
  }
  return { closed, excludedFutureCount };
}

function toWilderRsi(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) {
    return avgGain === 0 ? 50 : 100;
  }
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Calcula Wilder RSI(`period`, por defecto `14`) sobre una serie de cierres cerrados.
 *
 * - Índices `0 .. period - 1`: `Number.NaN` (requiere al menos `period + 1` cierres).
 * - Índice `period`: semilla SMA de ganancias/pérdidas de los primeros `period` cambios.
 * - Índices `> period`: suavizado recursivo de Wilder `(P - 1)/P`.
 * - Si algún cierre requerido no es finito, ese punto y los siguientes permanecen `NaN`.
 */
export function computeWilderRsiSeries(
  closes: readonly number[],
  period = DEFAULT_RSI_PERIOD,
): number[] {
  const p = assertIntegerAtLeast(period, 'RSI period', 1);
  const result = new Array<number>(closes.length).fill(Number.NaN);
  if (closes.length < p + 1) {
    return result;
  }

  const c0 = closes[0];
  if (c0 === undefined || !Number.isFinite(c0)) {
    return result;
  }

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= p; i += 1) {
    const curr = closes[i];
    const prev = closes[i - 1];
    if (curr === undefined || prev === undefined || !Number.isFinite(curr) || !Number.isFinite(prev)) {
      return result;
    }
    const change = curr - prev;
    if (change > 0) {
      gainSum += change;
    } else if (change < 0) {
      lossSum += -change;
    }
  }

  let avgGain = gainSum / p;
  let avgLoss = lossSum / p;
  result[p] = toWilderRsi(avgGain, avgLoss);

  for (let i = p + 1; i < closes.length; i += 1) {
    const curr = closes[i];
    const prev = closes[i - 1];
    if (curr === undefined || prev === undefined || !Number.isFinite(curr) || !Number.isFinite(prev)) {
      break;
    }
    const change = curr - prev;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (p - 1) + gain) / p;
    avgLoss = (avgLoss * (p - 1) + loss) / p;
    result[i] = toWilderRsi(avgGain, avgLoss);
  }

  return result;
}

/**
 * Detecta pivotes locales estrictamente causales sobre series paralelas `(times, highs, lows)`
 * ya filtradas hasta `asOfUtcSec`. Un pivote `p` requiere cerrar hasta `p + rightBars`.
 */
export function detectConfirmedPivotsFromSeries(
  times: readonly number[],
  highs: readonly number[],
  lows: readonly number[],
  barSeconds: number,
  leftBars: number,
  rightBars: number,
): {
  readonly pivots: readonly ConfirmedPivot[];
  readonly swingHighs: readonly ConfirmedPivot[];
  readonly swingLows: readonly ConfirmedPivot[];
} {
  const n = times.length;
  if (highs.length !== n || lows.length !== n) {
    throw new Error('times, highs, and lows must have identical length');
  }
  const minBars = leftBars + rightBars + 1;
  if (n < minBars) {
    return { pivots: [], swingHighs: [], swingLows: [] };
  }

  const pivots: ConfirmedPivot[] = [];
  const swingHighs: ConfirmedPivot[] = [];
  const swingLows: ConfirmedPivot[] = [];

  for (let p = leftBars; p <= n - 1 - rightBars; p += 1) {
    const pivotTime = times[p];
    const confirmIdx = p + rightBars;
    const confirmTime = times[confirmIdx];
    const pHigh = highs[p];
    const pLow = lows[p];
    if (pivotTime === undefined || confirmTime === undefined) {
      continue;
    }
    const confirmCloseSec = confirmTime + barSeconds;

    // Swing High: strictly higher than leftBars, higher-or-equal than rightBars
    if (pHigh !== undefined && Number.isFinite(pHigh)) {
      let isHighPivot = true;
      for (let j = p - leftBars; j < p; j += 1) {
        const val = highs[j];
        if (val === undefined || !Number.isFinite(val) || pHigh <= val) {
          isHighPivot = false;
          break;
        }
      }
      if (isHighPivot) {
        for (let j = p + 1; j <= p + rightBars; j += 1) {
          const val = highs[j];
          if (val === undefined || !Number.isFinite(val) || pHigh < val) {
            isHighPivot = false;
            break;
          }
        }
      }
      if (isHighPivot) {
        const pivot: ConfirmedPivot = {
          kind: 'SWING_HIGH',
          pivotIndex: p,
          time: pivotTime,
          price: pHigh,
          confirmedAtIndex: confirmIdx,
          confirmedAtTime: confirmTime,
          confirmedAtCloseUtcSec: confirmCloseSec,
        };
        swingHighs.push(pivot);
        pivots.push(pivot);
      }
    }

    // Swing Low: strictly lower than leftBars, lower-or-equal than rightBars
    if (pLow !== undefined && Number.isFinite(pLow)) {
      let isLowPivot = true;
      for (let j = p - leftBars; j < p; j += 1) {
        const val = lows[j];
        if (val === undefined || !Number.isFinite(val) || pLow >= val) {
          isLowPivot = false;
          break;
        }
      }
      if (isLowPivot) {
        for (let j = p + 1; j <= p + rightBars; j += 1) {
          const val = lows[j];
          if (val === undefined || !Number.isFinite(val) || pLow > val) {
            isLowPivot = false;
            break;
          }
        }
      }
      if (isLowPivot) {
        const pivot: ConfirmedPivot = {
          kind: 'SWING_LOW',
          pivotIndex: p,
          time: pivotTime,
          price: pLow,
          confirmedAtIndex: confirmIdx,
          confirmedAtTime: confirmTime,
          confirmedAtCloseUtcSec: confirmCloseSec,
        };
        swingLows.push(pivot);
        pivots.push(pivot);
      }
    }
  }

  return { pivots, swingHighs, swingLows };
}

/** Detecta pivotes Swing High / Swing Low confirmados sin look-ahead hasta `asOfUtcSec`. */
export function detectConfirmedPivots(
  bars: readonly Bar[],
  options: DetectPivotsOptions,
): PivotDetectionResult {
  assertUtcSeconds(options.asOfUtcSec, 'asOfUtcSec');
  const barSeconds = assertIntegerAtLeast(options.barSeconds, 'barSeconds', 1);
  const leftBars = assertIntegerAtLeast(
    options.leftBars ?? DEFAULT_PIVOT_LEFT_BARS,
    'leftBars',
    1,
  );
  const rightBars = assertIntegerAtLeast(
    options.rightBars ?? DEFAULT_PIVOT_RIGHT_BARS,
    'rightBars',
    1,
  );

  validateOhlcvBarsSequence(bars, 'bars');
  const { closed, excludedFutureCount } = filterClosedRecords(bars, barSeconds, options.asOfUtcSec);

  const times = closed.map((b) => b.time);
  const highs = closed.map((b) => b.high);
  const lows = closed.map((b) => b.low);
  const detected = detectConfirmedPivotsFromSeries(
    times,
    highs,
    lows,
    barSeconds,
    leftBars,
    rightBars,
  );

  return {
    asOfUtcSec: options.asOfUtcSec,
    closedBarCount: closed.length,
    excludedFutureCount,
    pivots: detected.pivots,
    swingHighs: detected.swingHighs,
    swingLows: detected.swingLows,
  };
}

function validateSeparationOptions(
  minSep: number,
  maxSep: number | undefined,
): { readonly minSep: number; readonly maxSep: number | undefined } {
  const validMin = assertIntegerAtLeast(minSep, 'minPivotSeparationBars', 1);
  if (maxSep !== undefined) {
    const validMax = assertIntegerAtLeast(maxSep, 'maxPivotSeparationBars', validMin);
    return { minSep: validMin, maxSep: validMax };
  }
  return { minSep: validMin, maxSep: undefined };
}

function isSeparationAllowed(
  distanceBars: number,
  minSep: number,
  maxSep: number | undefined,
): boolean {
  return distanceBars >= minSep && (maxSep === undefined || distanceBars <= maxSep);
}

/**
 * Detecta divergencias RSI regulares y ocultas sobre pivotes confirmados sin look-ahead.
 */
export function detectRsiDivergences(
  bars: readonly Bar[],
  options: DetectRsiDivergencesOptions,
): RsiDivergenceResult {
  assertUtcSeconds(options.asOfUtcSec, 'asOfUtcSec');
  const barSeconds = assertIntegerAtLeast(options.barSeconds, 'barSeconds', 1);
  const rsiPeriod = assertIntegerAtLeast(options.rsiPeriod ?? DEFAULT_RSI_PERIOD, 'rsiPeriod', 1);
  const leftBars = assertIntegerAtLeast(
    options.leftBars ?? DEFAULT_PIVOT_LEFT_BARS,
    'leftBars',
    1,
  );
  const rightBars = assertIntegerAtLeast(
    options.rightBars ?? DEFAULT_PIVOT_RIGHT_BARS,
    'rightBars',
    1,
  );
  const { minSep, maxSep } = validateSeparationOptions(
    options.minPivotSeparationBars ?? DEFAULT_MIN_PIVOT_SEPARATION_BARS,
    options.maxPivotSeparationBars,
  );

  validateOhlcvBarsSequence(bars, 'bars');
  const { closed, excludedFutureCount } = filterClosedRecords(bars, barSeconds, options.asOfUtcSec);

  const closes = closed.map((b) => b.close);
  const rsiSeries = computeWilderRsiSeries(closes, rsiPeriod);
  const lastRsiRaw = rsiSeries.length > 0 ? rsiSeries[rsiSeries.length - 1] : undefined;
  const latestRsi = lastRsiRaw !== undefined && Number.isFinite(lastRsiRaw) ? lastRsiRaw : Number.NaN;

  const times = closed.map((b) => b.time);
  const highs = closed.map((b) => b.high);
  const lows = closed.map((b) => b.low);
  const { swingHighs, swingLows } = detectConfirmedPivotsFromSeries(
    times,
    highs,
    lows,
    barSeconds,
    leftBars,
    rightBars,
  );

  const divergences: RsiDivergenceEvent[] = [];

  for (let i = 1; i < swingLows.length; i += 1) {
    const p1 = swingLows[i - 1];
    const p2 = swingLows[i];
    if (p1 === undefined || p2 === undefined) {
      continue;
    }
    if (!isSeparationAllowed(p2.pivotIndex - p1.pivotIndex, minSep, maxSep)) {
      continue;
    }
    const rsi1 = rsiSeries[p1.pivotIndex];
    const rsi2 = rsiSeries[p2.pivotIndex];
    if (rsi1 === undefined || rsi2 === undefined || !Number.isFinite(rsi1) || !Number.isFinite(rsi2)) {
      continue;
    }
    let type: RsiDivergenceType | null = null;
    if (p2.price < p1.price && rsi2 > rsi1) {
      type = 'RSI_REGULAR_BULLISH';
    } else if (p2.price > p1.price && rsi2 < rsi1) {
      type = 'RSI_HIDDEN_BULLISH';
    }
    if (type !== null) {
      divergences.push({
        type,
        pivot1Index: p1.pivotIndex,
        pivot2Index: p2.pivotIndex,
        pivot1Time: p1.time,
        pivot2Time: p2.time,
        price1: p1.price,
        price2: p2.price,
        rsi1,
        rsi2,
        confirmedAtIndex: p2.confirmedAtIndex,
        confirmedAtTime: p2.confirmedAtTime,
        confirmedAtCloseUtcSec: p2.confirmedAtCloseUtcSec,
      });
    }
  }

  for (let i = 1; i < swingHighs.length; i += 1) {
    const p1 = swingHighs[i - 1];
    const p2 = swingHighs[i];
    if (p1 === undefined || p2 === undefined) {
      continue;
    }
    if (!isSeparationAllowed(p2.pivotIndex - p1.pivotIndex, minSep, maxSep)) {
      continue;
    }
    const rsi1 = rsiSeries[p1.pivotIndex];
    const rsi2 = rsiSeries[p2.pivotIndex];
    if (rsi1 === undefined || rsi2 === undefined || !Number.isFinite(rsi1) || !Number.isFinite(rsi2)) {
      continue;
    }
    let type: RsiDivergenceType | null = null;
    if (p2.price > p1.price && rsi2 < rsi1) {
      type = 'RSI_REGULAR_BEARISH';
    } else if (p2.price < p1.price && rsi2 > rsi1) {
      type = 'RSI_HIDDEN_BEARISH';
    }
    if (type !== null) {
      divergences.push({
        type,
        pivot1Index: p1.pivotIndex,
        pivot2Index: p2.pivotIndex,
        pivot1Time: p1.time,
        pivot2Time: p2.time,
        price1: p1.price,
        price2: p2.price,
        rsi1,
        rsi2,
        confirmedAtIndex: p2.confirmedAtIndex,
        confirmedAtTime: p2.confirmedAtTime,
        confirmedAtCloseUtcSec: p2.confirmedAtCloseUtcSec,
      });
    }
  }

  divergences.sort(
    (a, b) =>
      a.confirmedAtIndex - b.confirmedAtIndex ||
      a.pivot2Index - b.pivot2Index ||
      a.type.localeCompare(b.type),
  );

  const minBarsRequired = Math.max(rsiPeriod + 1, leftBars + rightBars + 1);
  const status: DivergenceStatus =
    closed.length < minBarsRequired || !Number.isFinite(latestRsi) ? 'INSUFFICIENT_DATA' : 'OK';

  const latestDivergence =
    divergences.length > 0 ? (divergences[divergences.length - 1] ?? null) : null;

  return {
    asOfUtcSec: options.asOfUtcSec,
    barSeconds,
    closedBarCount: closed.length,
    excludedFutureCount,
    status,
    rsiPeriod,
    rsiSeries,
    latestRsi,
    swingHighs,
    swingLows,
    divergences,
    latestDivergence,
  };
}

function synchronizeBarsByTime(
  primaryClosed: readonly Bar[],
  correlatedClosed: readonly Bar[],
): { readonly syncPrimary: Bar[]; readonly syncCorrelated: Bar[] } {
  const syncPrimary: Bar[] = [];
  const syncCorrelated: Bar[] = [];
  let i = 0;
  let j = 0;
  while (i < primaryClosed.length && j < correlatedClosed.length) {
    const a = primaryClosed[i];
    const b = correlatedClosed[j];
    if (a === undefined || b === undefined) {
      break;
    }
    if (a.time === b.time) {
      syncPrimary.push(a);
      syncCorrelated.push(b);
      i += 1;
      j += 1;
    } else if (a.time < b.time) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return { syncPrimary, syncCorrelated };
}

function matchPivotsAcrossAssets(
  primaryPivots: readonly ConfirmedPivot[],
  correlatedPivots: readonly ConfirmedPivot[],
  maxSkewBars: number,
): PairedPivot[] {
  const paired: PairedPivot[] = [];
  let nextCorrIdx = 0;

  for (const pivA of primaryPivots) {
    while (nextCorrIdx < correlatedPivots.length) {
      const candidate = correlatedPivots[nextCorrIdx];
      if (candidate === undefined || candidate.pivotIndex >= pivA.pivotIndex - maxSkewBars) {
        break;
      }
      nextCorrIdx += 1;
    }

    let bestPos = -1;
    let bestAbsDist = Number.POSITIVE_INFINITY;
    for (let k = nextCorrIdx; k < correlatedPivots.length; k += 1) {
      const candidate = correlatedPivots[k];
      if (candidate === undefined) {
        break;
      }
      if (candidate.pivotIndex > pivA.pivotIndex + maxSkewBars) {
        break;
      }
      const dist = Math.abs(candidate.pivotIndex - pivA.pivotIndex);
      if (dist < bestAbsDist) {
        bestAbsDist = dist;
        bestPos = k;
      }
    }

    if (bestPos >= 0) {
      const pivB = correlatedPivots[bestPos];
      if (pivB !== undefined) {
        paired.push({ primary: pivA, correlated: pivB });
        nextCorrIdx = bestPos + 1;
      }
    }
  }

  return paired;
}

/**
 * Detecta divergencias SMT (`SMT_BULLISH` / `SMT_BEARISH`) sincronizando exactamente por
 * timestamp UTC las barras cerradas de dos activos correlacionados sin look-ahead bias.
 */
export function detectSmtDivergences(
  primaryBars: readonly Bar[],
  correlatedBars: readonly Bar[],
  options: DetectSmtDivergencesOptions,
): SmtDivergenceResult {
  assertUtcSeconds(options.asOfUtcSec, 'asOfUtcSec');
  const barSeconds = assertIntegerAtLeast(options.barSeconds, 'barSeconds', 1);
  const leftBars = assertIntegerAtLeast(
    options.leftBars ?? DEFAULT_PIVOT_LEFT_BARS,
    'leftBars',
    1,
  );
  const rightBars = assertIntegerAtLeast(
    options.rightBars ?? DEFAULT_PIVOT_RIGHT_BARS,
    'rightBars',
    1,
  );
  const { minSep, maxSep } = validateSeparationOptions(
    options.minPivotSeparationBars ?? DEFAULT_MIN_PIVOT_SEPARATION_BARS,
    options.maxPivotSeparationBars,
  );
  const maxPivotSkewBars = assertIntegerAtLeast(
    options.maxPivotSkewBars ?? DEFAULT_MAX_SMT_PIVOT_SKEW_BARS,
    'maxPivotSkewBars',
    0,
  );

  validateOhlcvBarsSequence(primaryBars, 'primaryBars');
  validateOhlcvBarsSequence(correlatedBars, 'correlatedBars');

  const primaryFiltered = filterClosedRecords(primaryBars, barSeconds, options.asOfUtcSec);
  const correlatedFiltered = filterClosedRecords(correlatedBars, barSeconds, options.asOfUtcSec);

  const { syncPrimary, syncCorrelated } = synchronizeBarsByTime(
    primaryFiltered.closed,
    correlatedFiltered.closed,
  );

  const primaryPivots = detectConfirmedPivotsFromSeries(
    syncPrimary.map((b) => b.time),
    syncPrimary.map((b) => b.high),
    syncPrimary.map((b) => b.low),
    barSeconds,
    leftBars,
    rightBars,
  );
  const correlatedPivots = detectConfirmedPivotsFromSeries(
    syncCorrelated.map((b) => b.time),
    syncCorrelated.map((b) => b.high),
    syncCorrelated.map((b) => b.low),
    barSeconds,
    leftBars,
    rightBars,
  );

  const pairedLows = matchPivotsAcrossAssets(
    primaryPivots.swingLows,
    correlatedPivots.swingLows,
    maxPivotSkewBars,
  );
  const pairedHighs = matchPivotsAcrossAssets(
    primaryPivots.swingHighs,
    correlatedPivots.swingHighs,
    maxPivotSkewBars,
  );

  const divergences: SmtDivergenceEvent[] = [];

  for (let i = 1; i < pairedLows.length; i += 1) {
    const p1 = pairedLows[i - 1];
    const p2 = pairedLows[i];
    if (p1 === undefined || p2 === undefined) {
      continue;
    }
    const sepA = p2.primary.pivotIndex - p1.primary.pivotIndex;
    const sepB = p2.correlated.pivotIndex - p1.correlated.pivotIndex;
    if (!isSeparationAllowed(sepA, minSep, maxSep) || !isSeparationAllowed(sepB, minSep, maxSep)) {
      continue;
    }

    let sweepingAsset: SmtSweepingAsset | null = null;
    if (p2.primary.price < p1.primary.price && p2.correlated.price > p1.correlated.price) {
      sweepingAsset = 'PRIMARY';
    } else if (p2.primary.price > p1.primary.price && p2.correlated.price < p1.correlated.price) {
      sweepingAsset = 'CORRELATED';
    }

    if (sweepingAsset !== null) {
      const confirmedAtCloseUtcSec = Math.max(
        p2.primary.confirmedAtCloseUtcSec,
        p2.correlated.confirmedAtCloseUtcSec,
      );
      divergences.push({
        type: 'SMT_BULLISH',
        sweepingAsset,
        primaryPivot1Index: p1.primary.pivotIndex,
        primaryPivot2Index: p2.primary.pivotIndex,
        correlatedPivot1Index: p1.correlated.pivotIndex,
        correlatedPivot2Index: p2.correlated.pivotIndex,
        primaryPivot1Time: p1.primary.time,
        primaryPivot2Time: p2.primary.time,
        correlatedPivot1Time: p1.correlated.time,
        correlatedPivot2Time: p2.correlated.time,
        primaryPrice1: p1.primary.price,
        primaryPrice2: p2.primary.price,
        correlatedPrice1: p1.correlated.price,
        correlatedPrice2: p2.correlated.price,
        confirmedAtTime: confirmedAtCloseUtcSec - barSeconds,
        confirmedAtCloseUtcSec,
      });
    }
  }

  for (let i = 1; i < pairedHighs.length; i += 1) {
    const p1 = pairedHighs[i - 1];
    const p2 = pairedHighs[i];
    if (p1 === undefined || p2 === undefined) {
      continue;
    }
    const sepA = p2.primary.pivotIndex - p1.primary.pivotIndex;
    const sepB = p2.correlated.pivotIndex - p1.correlated.pivotIndex;
    if (!isSeparationAllowed(sepA, minSep, maxSep) || !isSeparationAllowed(sepB, minSep, maxSep)) {
      continue;
    }

    let sweepingAsset: SmtSweepingAsset | null = null;
    if (p2.primary.price > p1.primary.price && p2.correlated.price < p1.correlated.price) {
      sweepingAsset = 'PRIMARY';
    } else if (p2.primary.price < p1.primary.price && p2.correlated.price > p1.correlated.price) {
      sweepingAsset = 'CORRELATED';
    }

    if (sweepingAsset !== null) {
      const confirmedAtCloseUtcSec = Math.max(
        p2.primary.confirmedAtCloseUtcSec,
        p2.correlated.confirmedAtCloseUtcSec,
      );
      divergences.push({
        type: 'SMT_BEARISH',
        sweepingAsset,
        primaryPivot1Index: p1.primary.pivotIndex,
        primaryPivot2Index: p2.primary.pivotIndex,
        correlatedPivot1Index: p1.correlated.pivotIndex,
        correlatedPivot2Index: p2.correlated.pivotIndex,
        primaryPivot1Time: p1.primary.time,
        primaryPivot2Time: p2.primary.time,
        correlatedPivot1Time: p1.correlated.time,
        correlatedPivot2Time: p2.correlated.time,
        primaryPrice1: p1.primary.price,
        primaryPrice2: p2.primary.price,
        correlatedPrice1: p1.correlated.price,
        correlatedPrice2: p2.correlated.price,
        confirmedAtTime: confirmedAtCloseUtcSec - barSeconds,
        confirmedAtCloseUtcSec,
      });
    }
  }

  divergences.sort(
    (a, b) =>
      a.confirmedAtCloseUtcSec - b.confirmedAtCloseUtcSec ||
      a.primaryPivot2Index - b.primaryPivot2Index ||
      a.type.localeCompare(b.type),
  );

  const minBars = leftBars + rightBars + 1;
  const status: DivergenceStatus = syncPrimary.length < minBars ? 'INSUFFICIENT_DATA' : 'OK';
  const latestDivergence =
    divergences.length > 0 ? (divergences[divergences.length - 1] ?? null) : null;

  return {
    asOfUtcSec: options.asOfUtcSec,
    barSeconds,
    synchronizedBarCount: syncPrimary.length,
    excludedFuturePrimaryCount: primaryFiltered.excludedFutureCount,
    excludedFutureCorrelatedCount: correlatedFiltered.excludedFutureCount,
    status,
    primarySwingHighs: primaryPivots.swingHighs,
    primarySwingLows: primaryPivots.swingLows,
    correlatedSwingHighs: correlatedPivots.swingHighs,
    correlatedSwingLows: correlatedPivots.swingLows,
    divergences,
    latestDivergence,
  };
}
