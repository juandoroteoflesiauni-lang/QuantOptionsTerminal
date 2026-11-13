/**
 * Motor puro de Volatilidad Realizada Intradía (`5m` RTH con factor `sqrt(78 * 252)`)
 * y Variance Risk Premium (`VRP Spread`, Pieza 12).
 *
 * Garantías de diseño:
 *  - Funciones puras, cero red, cero E/S, cero mutación de argumentos.
 *  - Timestamps en segundos UTC enteros (`|time| <= MAX_TIME_SECONDS`), convertidos a
 *    `America/New_York` (ET) vía `getMarketParts` (maneja EST/EDT automáticamente).
 *  - Cero Look-Ahead Bias: solo consume barras cerradas (`bar.time + 300 <= asOfUtcSec`)
 *    dentro de la sesión regular RTH (`09:30 <= minuteOfDayET < 16:00`).
 *  - Aislamiento estricto intra-sesión: jamás calcula retornos logarítmicos cruzando
 *    el cierre de una sesión ET con la apertura de la siguiente (sin saltos overnight).
 *  - Cero fallbacks silenciosos: sin retornos suficientes o ante cierres `<= 0`/`NaN`,
 *    devuelve `Number.NaN` y `status: 'NO_DATA'`.
 */

import { RTH_END_MINUTES } from '../microstructure/cvdAbsorption.js';
import { getMarketParts, MAX_TIME_SECONDS, RTH_START_MINUTES } from '../sessions.js';
import type { Bar } from '../types.js';
import type {
  IntradayRealizedVolOptions,
  IntradayRealizedVolResult,
  SessionReturnStats,
} from './types.js';

export const INTRADAY_5M_BAR_SECONDS = 300;
export const RTH_5M_BARS_PER_DAY = 78;
export const TRADING_DAYS_PER_YEAR = 252;
export const INTRADAY_5M_ANNUALIZATION_FACTOR = Math.sqrt(
  RTH_5M_BARS_PER_DAY * TRADING_DAYS_PER_YEAR,
);
export const DEFAULT_MIN_INTRADAY_RETURNS = 77;

function assertValidUtcSeconds(time: number, label: string): void {
  if (!Number.isFinite(time) || !Number.isInteger(time) || Math.abs(time) > MAX_TIME_SECONDS) {
    throw new Error(`${label} must be finite integer UTC seconds (got ${String(time)})`);
  }
}

function assertPositiveInteger(value: number, label: string, minValue = 1): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minValue) {
    throw new Error(
      `${label} must be a finite integer >= ${String(minValue)} (got ${String(value)})`,
    );
  }
  return value;
}

function validateBarsSequence(bars: readonly Bar[]): void {
  let prevTime = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (bar === undefined) {
      continue;
    }
    assertValidUtcSeconds(bar.time, `bars5m[${String(i)}].time`);
    if (bar.time <= prevTime) {
      throw new Error(
        `bars5m must have strictly increasing bar.time (bar[${String(i)}]=${String(bar.time)} <= prev=${String(prevTime)})`,
      );
    }
    prevTime = bar.time;
  }
}

interface SessionAccumulator {
  readonly sessionDate: string;
  rthBarCount: number;
  returnsCount: number;
  prevClose: number | null;
}

/**
 * Calcula la volatilidad realizada intradía anualizada sobre barras `5m` RTH cerradas
 * usando el estimador sin media (`sqrt(mean(r^2)) * sqrt(78 * 252)`) y el estimador
 * centrado muestral (`sqrt(varSample(r)) * sqrt(78 * 252)`), sin cruzar cierres overnight.
 */
export function computeIntradayRealizedVol(
  bars5m: readonly Bar[],
  options: IntradayRealizedVolOptions,
): IntradayRealizedVolResult {
  assertValidUtcSeconds(options.asOfUtcSec, 'options.asOfUtcSec');

  const barSeconds =
    options.barSeconds === undefined
      ? INTRADAY_5M_BAR_SECONDS
      : assertPositiveInteger(options.barSeconds, 'options.barSeconds');
  if (barSeconds !== INTRADAY_5M_BAR_SECONDS) {
    throw new Error(
      `options.barSeconds must equal ${String(INTRADAY_5M_BAR_SECONDS)} for 5m intraday RV (got ${String(barSeconds)})`,
    );
  }

  const minReturns =
    options.minReturns === undefined
      ? DEFAULT_MIN_INTRADAY_RETURNS
      : assertPositiveInteger(options.minReturns, 'options.minReturns', 1);

  const maxReturns =
    options.maxReturns === undefined
      ? undefined
      : assertPositiveInteger(options.maxReturns, 'options.maxReturns', 1);

  if (maxReturns !== undefined && maxReturns < minReturns) {
    throw new Error(
      `options.maxReturns (${String(maxReturns)}) cannot be less than options.minReturns (${String(minReturns)})`,
    );
  }

  validateBarsSequence(bars5m);

  let excludedFutureCount = 0;
  let excludedNonRthCount = 0;
  let closedRthBarCount = 0;
  let invalidCloseDetected = false;

  const sessionOrder: string[] = [];
  const sessionMap = new Map<string, SessionAccumulator>();
  const allIntraSessionReturns: number[] = [];

  for (const bar of bars5m) {
    if (bar.time + barSeconds > options.asOfUtcSec) {
      excludedFutureCount += 1;
      continue;
    }

    const parts = getMarketParts(bar.time, 'EQUITY');
    if (parts.minutesOfDay < RTH_START_MINUTES || parts.minutesOfDay >= RTH_END_MINUTES) {
      excludedNonRthCount += 1;
      continue;
    }

    closedRthBarCount += 1;

    let acc = sessionMap.get(parts.dateKey);
    if (acc === undefined) {
      acc = {
        sessionDate: parts.dateKey,
        rthBarCount: 0,
        returnsCount: 0,
        prevClose: null,
      };
      sessionMap.set(parts.dateKey, acc);
      sessionOrder.push(parts.dateKey);
    }

    acc.rthBarCount += 1;

    if (!Number.isFinite(bar.close) || bar.close <= 0) {
      invalidCloseDetected = true;
      acc.prevClose = null;
      continue;
    }

    if (acc.prevClose !== null && !invalidCloseDetected) {
      const logRet = Math.log(bar.close / acc.prevClose);
      if (!Number.isFinite(logRet)) {
        invalidCloseDetected = true;
      } else {
        allIntraSessionReturns.push(logRet);
        acc.returnsCount += 1;
      }
    }

    acc.prevClose = bar.close;
  }

  const sessions: SessionReturnStats[] = sessionOrder.map((sessionDate) => {
    const acc = sessionMap.get(sessionDate);
    if (acc === undefined) {
      return { sessionDate, rthBarCount: 0, returnsCount: 0 };
    }
    return {
      sessionDate: acc.sessionDate,
      rthBarCount: acc.rthBarCount,
      returnsCount: invalidCloseDetected ? 0 : acc.returnsCount,
    };
  });

  if (invalidCloseDetected) {
    return {
      status: 'NO_DATA',
      asOfUtcSec: options.asOfUtcSec,
      barSeconds,
      annualizationFactor: INTRADAY_5M_ANNUALIZATION_FACTOR,
      closedRthBarCount,
      excludedFutureCount,
      excludedNonRthCount,
      sessionCount: sessions.length,
      totalAvailableReturns: 0,
      returnsCount: 0,
      meanLogReturn: Number.NaN,
      realizedVolAnnualized: Number.NaN,
      rvCenteredAnnualized: Number.NaN,
      sessions,
    };
  }

  const totalAvailableReturns = allIntraSessionReturns.length;
  const usedReturns =
    maxReturns !== undefined && totalAvailableReturns > maxReturns
      ? allIntraSessionReturns.slice(totalAvailableReturns - maxReturns)
      : allIntraSessionReturns;

  const n = usedReturns.length;
  if (n < minReturns || n === 0) {
    return {
      status: 'NO_DATA',
      asOfUtcSec: options.asOfUtcSec,
      barSeconds,
      annualizationFactor: INTRADAY_5M_ANNUALIZATION_FACTOR,
      closedRthBarCount,
      excludedFutureCount,
      excludedNonRthCount,
      sessionCount: sessions.length,
      totalAvailableReturns,
      returnsCount: n,
      meanLogReturn: Number.NaN,
      realizedVolAnnualized: Number.NaN,
      rvCenteredAnnualized: Number.NaN,
      sessions,
    };
  }

  let sumRet = 0;
  let sumSq = 0;
  for (const r of usedReturns) {
    sumRet += r;
    sumSq += r * r;
  }

  const meanLogReturn = sumRet / n;
  const realizedVolAnnualized =
    Math.sqrt(Math.max(0, sumSq / n)) * INTRADAY_5M_ANNUALIZATION_FACTOR;

  let rvCenteredAnnualized = Number.NaN;
  if (n >= 2) {
    let centeredSumSq = 0;
    for (const r of usedReturns) {
      const diff = r - meanLogReturn;
      centeredSumSq += diff * diff;
    }
    rvCenteredAnnualized =
      Math.sqrt(Math.max(0, centeredSumSq / (n - 1))) * INTRADAY_5M_ANNUALIZATION_FACTOR;
  }

  return {
    status: 'OK',
    asOfUtcSec: options.asOfUtcSec,
    barSeconds,
    annualizationFactor: INTRADAY_5M_ANNUALIZATION_FACTOR,
    closedRthBarCount,
    excludedFutureCount,
    excludedNonRthCount,
    sessionCount: sessions.length,
    totalAvailableReturns,
    returnsCount: n,
    meanLogReturn,
    realizedVolAnnualized,
    rvCenteredAnnualized,
    sessions,
  };
}

/**
 * Calcula el spread Variance Risk Premium (`iv30d - realizedVolAnnualized`).
 * Devuelve `Number.NaN` ante cualquier entrada no finita o `<= 0`.
 */
export function computeVrpSpread(iv30d: number, realizedVolAnnualized: number): number {
  if (
    !Number.isFinite(iv30d) ||
    iv30d <= 0 ||
    !Number.isFinite(realizedVolAnnualized) ||
    realizedVolAnnualized <= 0
  ) {
    return Number.NaN;
  }
  return iv30d - realizedVolAnnualized;
}
