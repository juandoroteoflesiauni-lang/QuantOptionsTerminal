/**
 * Motor puro de Estructura Multi-Timeframe en Cascada (`1D -> 4H -> 15m -> 5m`, Pieza 10).
 *
 * Garantías de diseño:
 *  - Funciones puras, cero red, cero E/S, cero mutación de argumentos.
 *  - Todos los timestamps en segundos UTC enteros (rechaza milisegundos > `MAX_TIME_SECONDS`).
 *  - Cero Look-Ahead Bias: solo entran barras cerradas (`bar.time + barSeconds <= asOfUtcSec`).
 *  - Cero fallbacks silenciosos: sin warmup suficiente devuelve `Number.NaN` y
 *    estado explícito `'INSUFFICIENT_DATA'` / `'CONFLICTED_NO_SETUP'`.
 */

import { calculateEma } from '../ema.js';
import { MAX_TIME_SECONDS } from '../sessions.js';
import type { Bar } from '../types.js';

export const DEFAULT_SMA_1D_PERIOD = 200;
export const DEFAULT_SMA_4H_PERIOD = 50;
export const DEFAULT_EMA_15M_PERIOD = 21;
export const DEFAULT_HMA_5M_PERIOD = 55;
export const DEFAULT_ATR_PERIOD = 14;

export const DEFAULT_BAR_SECONDS_1D = 86_400;
export const DEFAULT_BAR_SECONDS_4H = 14_400;
export const DEFAULT_BAR_SECONDS_15M = 900;
export const DEFAULT_BAR_SECONDS_5M = 300;

export const DEFAULT_PULLBACK_ATR_THRESHOLD = 0.5;
export const DEFAULT_MIN_WICK_TO_BODY_RATIO = 1.5;
export const DEFAULT_MIN_VOLUME_PERCENTILE_15M = 75;
export const DEFAULT_LOOKBACK_BARS_15M = 20;
export const DEFAULT_MIN_BODY_EPSILON = 0.01;

export type MtfRegime1d =
  | 'BULLISH_REGIME'
  | 'BEARISH_REGIME'
  | 'CONFLICTED_NO_SETUP'
  | 'INSUFFICIENT_DATA';

export type MtfEffectiveRegime =
  | 'BULLISH_REGIME'
  | 'BEARISH_REGIME'
  | 'CONFLICTED_NO_SETUP'
  | 'INSUFFICIENT_DATA';

export type MtfSetupStatus =
  | 'ACTIVE_BULLISH'
  | 'ACTIVE_BEARISH'
  | 'STANDBY'
  | 'CONFLICTED_NO_SETUP'
  | 'INSUFFICIENT_DATA';

export interface MtfStructureInputs {
  readonly bars1d: readonly Bar[];
  readonly bars4h: readonly Bar[];
  readonly bars15m: readonly Bar[];
  readonly bars5m: readonly Bar[];
}

export interface MtfStructureOptions {
  /** Instante de evaluación sin look-ahead en segundos UTC enteros (`bar.time + barSeconds <= asOfUtcSec`). */
  readonly asOfUtcSec: number;
  readonly barSeconds1d?: number;
  readonly barSeconds4h?: number;
  readonly barSeconds15m?: number;
  readonly barSeconds5m?: number;
  /** Override opcional de ATR(14) diario; si se omite se calcula Wilder ATR(14) sobre `1D` cerradas. */
  readonly atr14_1d?: number;
  /** Override opcional de ATR(14) `15m`; si se omite se calcula Wilder ATR(14) sobre `15m` cerradas. */
  readonly atr14_15m?: number;
  readonly sma1dPeriod?: number;
  readonly sma4hPeriod?: number;
  readonly ema15mPeriod?: number;
  readonly hma5mPeriod?: number;
  readonly atrPeriod?: number;
  readonly pullbackAtrThreshold?: number;
  readonly minWickToBodyRatio?: number;
  readonly minVolumePercentile15m?: number;
  readonly lookbackBars15m?: number;
  readonly minBodyEpsilon?: number;
}

export interface MtfStructureResult {
  readonly asOfUtcSec: number;
  readonly closed1dCount: number;
  readonly closed4hCount: number;
  readonly closed15mCount: number;
  readonly closed5mCount: number;
  readonly excludedFuture1dCount: number;
  readonly excludedFuture4hCount: number;
  readonly excludedFuture15mCount: number;
  readonly excludedFuture5mCount: number;

  // Capa 1 — Macro & Estructural (1D -> 4H)
  readonly close1d: number;
  readonly sma200_1d: number;
  readonly atr14_1d: number;
  readonly distSma200Pct: number;
  readonly distSma200Atr: number;
  readonly regime1d: MtfRegime1d;
  readonly close4h: number;
  readonly sma50_4h: number;
  readonly aligned4h: boolean;
  readonly effectiveMacroRegime: MtfEffectiveRegime;

  // Capa 2 — Localización / Atractor de Liquidez (15m)
  readonly close15m: number;
  readonly ema21_15m: number;
  readonly atr14_15m: number;
  readonly pullback15mDistance: number;
  readonly pullback15mInZone: boolean;
  readonly wickToBodyRatio15m: number;
  readonly volume15mPercentile: number;
  readonly absorption15m: boolean;

  // Capa 3 — Ejecución y Timing (5m HMA 55)
  readonly close5m: number;
  readonly hma55: number;
  readonly hma55Prev: number;
  readonly hma55Prev2: number;
  readonly hma55Slope: number;
  readonly hma55SlopePrev: number;
  readonly executionTriggerActive: boolean;

  readonly setupStatus: MtfSetupStatus;
}

/** Valida que `time` sea un entero finito en segundos UTC (`|time| <= MAX_TIME_SECONDS`). */
export function assertValidUtcSeconds(time: number, label: string): void {
  if (!Number.isFinite(time) || !Number.isInteger(time) || Math.abs(time) > MAX_TIME_SECONDS) {
    throw new Error(`${label} must be finite integer UTC seconds (got ${String(time)})`);
  }
}

/** Valida que una opción sea un entero finito >= `minValue`. */
export function assertPositiveIntegerOption(value: number, label: string, minValue = 1): number {
  if (!Number.isInteger(value) || value < minValue) {
    throw new Error(`${label} must be an integer >= ${String(minValue)} (got ${String(value)})`);
  }
  return value;
}

/** Valida que una opción sea finita > 0. */
export function assertPositiveFiniteOption(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be finite > 0 (got ${String(value)})`);
  }
  return value;
}

/** Valida que una opción sea finita >= 0. */
export function assertNonNegativeFiniteOption(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be finite >= 0 (got ${String(value)})`);
  }
  return value;
}

/**
 * Valida la integridad estructural de una serie OHLCV ordenada en segundos UTC:
 * timestamps enteros en segundos, orden estrictamente creciente, `high >= low` y `volume >= 0`.
 */
export function validateOhlcvBars(bars: readonly Bar[], label: string): void {
  let prevTime = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (bar === undefined) {
      continue;
    }
    assertValidUtcSeconds(bar.time, `${label}[${String(i)}].time`);
    if (bar.time <= prevTime) {
      throw new Error(
        `${label} timestamps must be strictly increasing (${String(bar.time)} <= ${String(prevTime)})`,
      );
    }
    prevTime = bar.time;
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

/** Filtra barras cerradas respecto a `asOfUtcSec` (`bar.time + barSeconds <= asOfUtcSec`). */
export function filterClosedBars<T extends Bar>(
  bars: readonly T[],
  barSeconds: number,
  asOfUtcSec: number,
): { readonly closed: T[]; readonly excludedFutureCount: number } {
  const closed: T[] = [];
  let excludedFutureCount = 0;
  for (const bar of bars) {
    if (bar.time + barSeconds <= asOfUtcSec) {
      closed.push(bar);
    } else {
      excludedFutureCount += 1;
    }
  }
  return { closed, excludedFutureCount };
}

/**
 * Calcula el percentil empírico mid-rank en `[0, 100]` de `targetValue` dentro de `windowValues`:
 * `100 * (count(x < target) + 0.5 * count(x === target)) / n`.
 *
 * Propiedades:
 *  - Una ventana constante devuelve exactamente `50` (evita falsos positivos en `>= 90` o `<= 25`).
 *  - Devuelve `Number.NaN` si la ventana está vacía o algún valor no es finito.
 */
export function computeEmpiricalPercentile(
  windowValues: readonly number[],
  targetValue: number,
): number {
  if (windowValues.length === 0 || !Number.isFinite(targetValue)) {
    return Number.NaN;
  }
  let lessCount = 0;
  let equalCount = 0;
  for (const v of windowValues) {
    if (!Number.isFinite(v)) {
      return Number.NaN;
    }
    if (v < targetValue) {
      lessCount += 1;
    } else if (v === targetValue) {
      equalCount += 1;
    }
  }
  return (100 * (lessCount + 0.5 * equalCount)) / windowValues.length;
}

/** Calcula Media Móvil Simple exacta (`NaN` antes del índice `period - 1` o ante valores no finitos). */
export function computeSmaSeries(values: readonly number[], period: number): number[] {
  const p = assertPositiveIntegerOption(period, 'SMA period', 1);
  const out = new Array<number>(values.length).fill(Number.NaN);
  if (values.length < p) {
    return out;
  }

  for (let i = p - 1; i < values.length; i += 1) {
    let sum = 0;
    let valid = true;
    for (let j = i - p + 1; j <= i; j += 1) {
      const v = values[j];
      if (v === undefined || !Number.isFinite(v)) {
        valid = false;
        break;
      }
      sum += v;
    }
    if (valid) {
      out[i] = sum / p;
    }
  }
  return out;
}

/** Calcula Media Móvil Ponderada lineal (`1, 2, ..., period`) sin mutar argumentos. */
export function computeWmaSeries(values: readonly number[], period: number): number[] {
  const p = assertPositiveIntegerOption(period, 'WMA period', 1);
  const out = new Array<number>(values.length).fill(Number.NaN);
  if (values.length < p) {
    return out;
  }

  const denominator = (p * (p + 1)) / 2;
  for (let i = p - 1; i < values.length; i += 1) {
    let weightedSum = 0;
    let valid = true;
    const startIdx = i - p + 1;
    for (let k = 0; k < p; k += 1) {
      const v = values[startIdx + k];
      if (v === undefined || !Number.isFinite(v)) {
        valid = false;
        break;
      }
      weightedSum += (k + 1) * v;
    }
    if (valid) {
      out[i] = weightedSum / denominator;
    }
  }
  return out;
}

/**
 * Calcula Hull Moving Average pura:
 * `HMA(n) = WMA(2 * WMA(floor(n / 2)) - WMA(n), floor(sqrt(n)))`.
 * Warmup requerido para `n = 55`: `55 + 7 - 1 = 61` barras cerradas (`NaN` si hay `< 61`).
 */
export function computeHmaSeries(closes: readonly number[], period: number): number[] {
  const p = assertPositiveIntegerOption(period, 'HMA period', 2);
  const halfPeriod = Math.floor(p / 2);
  const sqrtPeriod = Math.floor(Math.sqrt(p));

  const wmaHalf = computeWmaSeries(closes, halfPeriod);
  const wmaFull = computeWmaSeries(closes, p);
  const rawHull = new Array<number>(closes.length).fill(Number.NaN);

  for (let i = 0; i < closes.length; i += 1) {
    const fast = wmaHalf[i];
    const slow = wmaFull[i];
    if (fast !== undefined && slow !== undefined && Number.isFinite(fast) && Number.isFinite(slow)) {
      rawHull[i] = 2 * fast - slow;
    }
  }

  return computeWmaSeries(rawHull, sqrtPeriod);
}

/**
 * Calcula Wilder ATR(`period`):
 * requiere `period + 1` barras cerradas (`TR` definido desde `i = 1`),
 * semilla = promedio simple de los primeros `period` `TR`, luego suavizado `(period - 1)/period`.
 * Ante cualquier OHLC no finito en el historial, el índice afectado y los siguientes permanecen `NaN`.
 */
export function computeWilderAtrSeries(bars: readonly Bar[], period: number): number[] {
  const p = assertPositiveIntegerOption(period, 'ATR period', 1);
  const out = new Array<number>(bars.length).fill(Number.NaN);
  if (bars.length < p + 1) {
    return out;
  }

  const bar0 = bars[0];
  if (
    bar0 === undefined ||
    !Number.isFinite(bar0.high) ||
    !Number.isFinite(bar0.low) ||
    !Number.isFinite(bar0.close)
  ) {
    return out;
  }

  const trueRanges = new Array<number>(bars.length).fill(Number.NaN);
  for (let i = 1; i < bars.length; i += 1) {
    const curr = bars[i];
    const prev = bars[i - 1];
    if (
      curr === undefined ||
      prev === undefined ||
      !Number.isFinite(curr.high) ||
      !Number.isFinite(curr.low) ||
      !Number.isFinite(curr.close) ||
      !Number.isFinite(prev.close)
    ) {
      break;
    }
    const trHighLow = curr.high - curr.low;
    const trHighPrevClose = Math.abs(curr.high - prev.close);
    const trLowPrevClose = Math.abs(curr.low - prev.close);
    trueRanges[i] = Math.max(trHighLow, trHighPrevClose, trLowPrevClose);
  }

  let seedSum = 0;
  for (let i = 1; i <= p; i += 1) {
    const tr = trueRanges[i];
    if (tr === undefined || !Number.isFinite(tr)) {
      return out;
    }
    seedSum += tr;
  }

  let atr = seedSum / p;
  out[p] = atr;

  for (let i = p + 1; i < bars.length; i += 1) {
    const tr = trueRanges[i];
    if (tr === undefined || !Number.isFinite(tr)) {
      break;
    }
    atr = ((p - 1) * atr + tr) / p;
    out[i] = atr;
  }

  return out;
}

function getLastFiniteOrNaN(series: readonly number[], offsetFromEnd = 0): number {
  const idx = series.length - 1 - offsetFromEnd;
  if (idx < 0 || idx >= series.length) {
    return Number.NaN;
  }
  const value = series[idx];
  return value !== undefined && Number.isFinite(value) ? value : Number.NaN;
}

function resolveAtrValue(
  overrideAtr: number | undefined,
  closedBars: readonly Bar[],
  atrPeriod: number,
): number {
  if (overrideAtr !== undefined) {
    return Number.isFinite(overrideAtr) && overrideAtr > 0 ? overrideAtr : Number.NaN;
  }
  return getLastFiniteOrNaN(computeWilderAtrSeries(closedBars, atrPeriod));
}

function resolveClosedClose(closedBars: readonly Bar[]): number {
  if (closedBars.length === 0) {
    return Number.NaN;
  }
  const last = closedBars[closedBars.length - 1];
  return last !== undefined && Number.isFinite(last.close) ? last.close : Number.NaN;
}

/**
 * Evalúa de forma pura y sin look-ahead la cascada Multi-Timeframe (`1D -> 4H -> 15m -> 5m`).
 */
export function evaluateMtfStructure(
  inputs: MtfStructureInputs,
  options: MtfStructureOptions,
): MtfStructureResult {
  assertValidUtcSeconds(options.asOfUtcSec, 'asOfUtcSec');

  const barSeconds1d = assertPositiveIntegerOption(
    options.barSeconds1d ?? DEFAULT_BAR_SECONDS_1D,
    'barSeconds1d',
  );
  const barSeconds4h = assertPositiveIntegerOption(
    options.barSeconds4h ?? DEFAULT_BAR_SECONDS_4H,
    'barSeconds4h',
  );
  const barSeconds15m = assertPositiveIntegerOption(
    options.barSeconds15m ?? DEFAULT_BAR_SECONDS_15M,
    'barSeconds15m',
  );
  const barSeconds5m = assertPositiveIntegerOption(
    options.barSeconds5m ?? DEFAULT_BAR_SECONDS_5M,
    'barSeconds5m',
  );

  const sma1dPeriod = assertPositiveIntegerOption(
    options.sma1dPeriod ?? DEFAULT_SMA_1D_PERIOD,
    'sma1dPeriod',
  );
  const sma4hPeriod = assertPositiveIntegerOption(
    options.sma4hPeriod ?? DEFAULT_SMA_4H_PERIOD,
    'sma4hPeriod',
  );
  const ema15mPeriod = assertPositiveIntegerOption(
    options.ema15mPeriod ?? DEFAULT_EMA_15M_PERIOD,
    'ema15mPeriod',
  );
  const hma5mPeriod = assertPositiveIntegerOption(
    options.hma5mPeriod ?? DEFAULT_HMA_5M_PERIOD,
    'hma5mPeriod',
    2,
  );
  const atrPeriod = assertPositiveIntegerOption(
    options.atrPeriod ?? DEFAULT_ATR_PERIOD,
    'atrPeriod',
  );

  const pullbackAtrThreshold = assertNonNegativeFiniteOption(
    options.pullbackAtrThreshold ?? DEFAULT_PULLBACK_ATR_THRESHOLD,
    'pullbackAtrThreshold',
  );
  const minWickToBodyRatio = assertNonNegativeFiniteOption(
    options.minWickToBodyRatio ?? DEFAULT_MIN_WICK_TO_BODY_RATIO,
    'minWickToBodyRatio',
  );
  const minVolumePercentile15m = options.minVolumePercentile15m ?? DEFAULT_MIN_VOLUME_PERCENTILE_15M;
  if (!Number.isFinite(minVolumePercentile15m) || minVolumePercentile15m < 0 || minVolumePercentile15m > 100) {
    throw new Error(`minVolumePercentile15m must be in [0, 100] (got ${String(minVolumePercentile15m)})`);
  }
  const lookbackBars15m = assertPositiveIntegerOption(
    options.lookbackBars15m ?? DEFAULT_LOOKBACK_BARS_15M,
    'lookbackBars15m',
  );
  const minBodyEpsilon = assertPositiveFiniteOption(
    options.minBodyEpsilon ?? DEFAULT_MIN_BODY_EPSILON,
    'minBodyEpsilon',
  );

  validateOhlcvBars(inputs.bars1d, 'bars1d');
  validateOhlcvBars(inputs.bars4h, 'bars4h');
  validateOhlcvBars(inputs.bars15m, 'bars15m');
  validateOhlcvBars(inputs.bars5m, 'bars5m');

  const closed1dRes = filterClosedBars(inputs.bars1d, barSeconds1d, options.asOfUtcSec);
  const closed4hRes = filterClosedBars(inputs.bars4h, barSeconds4h, options.asOfUtcSec);
  const closed15mRes = filterClosedBars(inputs.bars15m, barSeconds15m, options.asOfUtcSec);
  const closed5mRes = filterClosedBars(inputs.bars5m, barSeconds5m, options.asOfUtcSec);

  const bars1d = closed1dRes.closed;
  const bars4h = closed4hRes.closed;
  const bars15m = closed15mRes.closed;
  const bars5m = closed5mRes.closed;

  // --- Capa 1: 1D SMA(200) + 4H SMA(50) ---
  const closes1d = bars1d.map((b) => b.close);
  const close1d = resolveClosedClose(bars1d);
  const sma200_1d = getLastFiniteOrNaN(computeSmaSeries(closes1d, sma1dPeriod));
  const atr14_1d = resolveAtrValue(options.atr14_1d, bars1d, atrPeriod);

  const distSma200Pct =
    Number.isFinite(close1d) && Number.isFinite(sma200_1d) && sma200_1d !== 0
      ? (close1d - sma200_1d) / sma200_1d
      : Number.NaN;
  const distSma200Atr =
    Number.isFinite(close1d) && Number.isFinite(sma200_1d) && Number.isFinite(atr14_1d) && atr14_1d > 0
      ? (close1d - sma200_1d) / atr14_1d
      : Number.NaN;

  let regime1d: MtfRegime1d;
  if (!Number.isFinite(close1d) || !Number.isFinite(sma200_1d)) {
    regime1d = 'INSUFFICIENT_DATA';
  } else if (close1d > sma200_1d) {
    regime1d = 'BULLISH_REGIME';
  } else if (close1d < sma200_1d) {
    regime1d = 'BEARISH_REGIME';
  } else {
    regime1d = 'CONFLICTED_NO_SETUP';
  }

  const closes4h = bars4h.map((b) => b.close);
  const close4h = resolveClosedClose(bars4h);
  const sma50_4h = getLastFiniteOrNaN(computeSmaSeries(closes4h, sma4hPeriod));

  let aligned4h = false;
  let effectiveMacroRegime: MtfEffectiveRegime;
  if (regime1d === 'INSUFFICIENT_DATA' || !Number.isFinite(close4h) || !Number.isFinite(sma50_4h)) {
    effectiveMacroRegime = 'INSUFFICIENT_DATA';
  } else if (regime1d === 'CONFLICTED_NO_SETUP') {
    effectiveMacroRegime = 'CONFLICTED_NO_SETUP';
  } else if (regime1d === 'BULLISH_REGIME' && close4h > sma50_4h) {
    aligned4h = true;
    effectiveMacroRegime = 'BULLISH_REGIME';
  } else if (regime1d === 'BEARISH_REGIME' && close4h < sma50_4h) {
    aligned4h = true;
    effectiveMacroRegime = 'BEARISH_REGIME';
  } else {
    aligned4h = false;
    effectiveMacroRegime = 'CONFLICTED_NO_SETUP';
  }

  // --- Capa 2: 15m EMA(21) + Pullback ATR + Absorción mecha/volumen ---
  const closes15m = bars15m.map((b) => b.close);
  const last15mBar = bars15m.length > 0 ? bars15m[bars15m.length - 1] : undefined;
  const close15m = resolveClosedClose(bars15m);
  const ema21_15m = getLastFiniteOrNaN(calculateEma(closes15m, ema15mPeriod));
  const atr14_15m = resolveAtrValue(options.atr14_15m, bars15m, atrPeriod);

  const pullback15mDistance =
    Number.isFinite(close15m) && Number.isFinite(ema21_15m)
      ? Math.abs(close15m - ema21_15m)
      : Number.NaN;
  const pullback15mInZone =
    Number.isFinite(pullback15mDistance) &&
    Number.isFinite(atr14_15m) &&
    atr14_15m > 0 &&
    pullback15mDistance <= pullbackAtrThreshold * atr14_15m;

  let wickToBodyRatio15m = Number.NaN;
  if (
    last15mBar !== undefined &&
    (effectiveMacroRegime === 'BULLISH_REGIME' || effectiveMacroRegime === 'BEARISH_REGIME') &&
    Number.isFinite(last15mBar.open) &&
    Number.isFinite(last15mBar.high) &&
    Number.isFinite(last15mBar.low) &&
    Number.isFinite(last15mBar.close)
  ) {
    const bodyDenominator = Math.max(Math.abs(last15mBar.close - last15mBar.open), minBodyEpsilon);
    if (effectiveMacroRegime === 'BULLISH_REGIME') {
      const lowerWick = Math.min(last15mBar.open, last15mBar.close) - last15mBar.low;
      wickToBodyRatio15m = lowerWick / bodyDenominator;
    } else {
      const upperWick = last15mBar.high - Math.max(last15mBar.open, last15mBar.close);
      wickToBodyRatio15m = upperWick / bodyDenominator;
    }
  }

  let volume15mPercentile = Number.NaN;
  if (last15mBar !== undefined && bars15m.length >= lookbackBars15m) {
    const startIdx = bars15m.length - lookbackBars15m;
    const windowVolumes = bars15m.slice(startIdx).map((b) => b.volume);
    volume15mPercentile = computeEmpiricalPercentile(windowVolumes, last15mBar.volume);
  }

  const absorption15m =
    Number.isFinite(wickToBodyRatio15m) &&
    wickToBodyRatio15m >= minWickToBodyRatio &&
    Number.isFinite(volume15mPercentile) &&
    volume15mPercentile >= minVolumePercentile15m;

  // --- Capa 3: 5m HMA(55) + pendiente + giro/aceleración ---
  const closes5m = bars5m.map((b) => b.close);
  const close5m = resolveClosedClose(bars5m);
  const hmaSeries = computeHmaSeries(closes5m, hma5mPeriod);
  const hma55 = getLastFiniteOrNaN(hmaSeries, 0);
  const hma55Prev = getLastFiniteOrNaN(hmaSeries, 1);
  const hma55Prev2 = getLastFiniteOrNaN(hmaSeries, 2);

  const hma55Slope =
    Number.isFinite(hma55) && Number.isFinite(hma55Prev) ? hma55 - hma55Prev : Number.NaN;
  const hma55SlopePrev =
    Number.isFinite(hma55Prev) && Number.isFinite(hma55Prev2)
      ? hma55Prev - hma55Prev2
      : Number.NaN;

  const executionSlopeFavorable =
    Number.isFinite(hma55Slope) &&
    Number.isFinite(hma55SlopePrev) &&
    ((effectiveMacroRegime === 'BULLISH_REGIME' &&
      hma55Slope > 0 &&
      hma55Slope > hma55SlopePrev) ||
      (effectiveMacroRegime === 'BEARISH_REGIME' &&
        hma55Slope < 0 &&
        hma55Slope < hma55SlopePrev));

  const executionTriggerActive = aligned4h && pullback15mInZone && executionSlopeFavorable;

  // --- Estado holístico ---
  const layer1Warm = effectiveMacroRegime !== 'INSUFFICIENT_DATA';
  const layer2Warm =
    Number.isFinite(ema21_15m) &&
    Number.isFinite(atr14_15m) &&
    bars15m.length >= lookbackBars15m;
  const layer3Warm = Number.isFinite(hma55Slope) && Number.isFinite(hma55SlopePrev);

  let setupStatus: MtfSetupStatus;
  if (!layer1Warm || !layer2Warm || !layer3Warm) {
    setupStatus = effectiveMacroRegime === 'CONFLICTED_NO_SETUP' ? 'CONFLICTED_NO_SETUP' : 'INSUFFICIENT_DATA';
  } else if (!aligned4h || effectiveMacroRegime === 'CONFLICTED_NO_SETUP') {
    setupStatus = 'CONFLICTED_NO_SETUP';
  } else if (executionTriggerActive) {
    setupStatus =
      effectiveMacroRegime === 'BULLISH_REGIME' ? 'ACTIVE_BULLISH' : 'ACTIVE_BEARISH';
  } else {
    setupStatus = 'STANDBY';
  }

  return {
    asOfUtcSec: options.asOfUtcSec,
    closed1dCount: bars1d.length,
    closed4hCount: bars4h.length,
    closed15mCount: bars15m.length,
    closed5mCount: bars5m.length,
    excludedFuture1dCount: closed1dRes.excludedFutureCount,
    excludedFuture4hCount: closed4hRes.excludedFutureCount,
    excludedFuture15mCount: closed15mRes.excludedFutureCount,
    excludedFuture5mCount: closed5mRes.excludedFutureCount,
    close1d,
    sma200_1d,
    atr14_1d,
    distSma200Pct,
    distSma200Atr,
    regime1d,
    close4h,
    sma50_4h,
    aligned4h,
    effectiveMacroRegime,
    close15m,
    ema21_15m,
    atr14_15m,
    pullback15mDistance,
    pullback15mInZone,
    wickToBodyRatio15m,
    volume15mPercentile,
    absorption15m,
    close5m,
    hma55,
    hma55Prev,
    hma55Prev2,
    hma55Slope,
    hma55SlopePrev,
    executionTriggerActive,
    setupStatus,
  };
}
