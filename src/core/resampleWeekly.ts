/**
 * Pieza 50.4: resampleo semanal nativo de barras diarias OHLCV (segundos UTC).
 *
 * Funciones puras, sin red, sin UI y sin mutar argumentos. Cada vela semanal agrupa
 * lunes–viernes por semana calendario en la zona horaria del mercado (`timeZone`), de
 * modo que un lunes feriado no rompe el cubo: la primera rueda hábil de la semana
 * (p. ej. martes tras MLK Day) aporta `time` y `open` reales, nunca un timestamp sintético.
 *
 * Zero Silent Fallbacks: el `vw` semanal se emite solo si TODAS las barras con volumen > 0
 * tienen `vw` válido; en caso contrario se omite (jamás se inventa ni se mezcla HLC3).
 */

import { MAX_TIME_SECONDS } from './sessions.js';
import type { Bar } from './types.js';

export const US_MARKET_TIMEZONE = 'America/New_York';
export const AR_MARKET_TIMEZONE = 'America/Argentina/Buenos_Aires';

const WEEKDAY_BY_NAME: Readonly<Record<string, number>> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

const MILLISECONDS_PER_DAY = 86_400_000;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getCalendarPartsFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached !== undefined) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

function readPart(parts: readonly Intl.DateTimeFormatPart[], type: string): string {
  for (const part of parts) {
    if (part.type === type) {
      return part.value;
    }
  }
  return '';
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Clave de cubo semanal: lunes civil de la semana calendario de `timeSec` en `timeZone`
 * (`YYYY-MM-DD`). Aritmética civil pura sobre `Date.UTC` (soporta fin de año y bisiestos).
 * Devuelve `null` si las partes de fecha no se pueden resolver (sin claves inventadas).
 */
export function getCalendarWeekMondayKey(timeSec: number, timeZone: string): string | null {
  const parts = getCalendarPartsFormatter(timeZone).formatToParts(new Date(timeSec * 1_000));
  const year = Number(readPart(parts, 'year'));
  const month = Number(readPart(parts, 'month'));
  const day = Number(readPart(parts, 'day'));
  const weekday = WEEKDAY_BY_NAME[readPart(parts, 'weekday')];
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    weekday === undefined
  ) {
    return null;
  }
  const mondayMs = Date.UTC(year, month - 1, day) - (weekday - 1) * MILLISECONDS_PER_DAY;
  const monday = new Date(mondayMs);
  return `${String(monday.getUTCFullYear())}-${pad2(monday.getUTCMonth() + 1)}-${pad2(monday.getUTCDate())}`;
}

function isValidDailyBar(bar: Bar): boolean {
  return (
    Number.isFinite(bar.time) &&
    Number.isInteger(bar.time) &&
    Math.abs(bar.time) <= MAX_TIME_SECONDS &&
    Number.isFinite(bar.open) &&
    Number.isFinite(bar.high) &&
    Number.isFinite(bar.low) &&
    Number.isFinite(bar.close) &&
    bar.high >= bar.low &&
    Number.isFinite(bar.volume) &&
    bar.volume >= 0
  );
}

function aggregateWeeklyBar(bars: readonly Bar[]): Bar | null {
  const first = bars[0];
  const last = bars[bars.length - 1];
  if (first === undefined || last === undefined) {
    return null;
  }
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  let volume = 0;
  let vwPvSum = 0;
  let vwVolSum = 0;
  let allPositiveVolBarsHaveVw = true;
  for (const bar of bars) {
    if (bar.high > high) {
      high = bar.high;
    }
    if (bar.low < low) {
      low = bar.low;
    }
    volume += bar.volume;
    if (bar.volume > 0) {
      const vwValue = bar.vw;
      if (vwValue !== undefined && Number.isFinite(vwValue) && vwValue > 0) {
        vwPvSum += vwValue * bar.volume;
        vwVolSum += bar.volume;
      } else {
        allPositiveVolBarsHaveVw = false;
      }
    }
  }
  const weightedVw = allPositiveVolBarsHaveVw && vwVolSum > 0 ? vwPvSum / vwVolSum : null;
  return {
    time: first.time,
    open: first.open,
    high,
    low,
    close: last.close,
    volume,
    ...(weightedVw !== null ? { vw: weightedVw } : {}),
  };
}

/**
 * Resamplea barras diarias OHLCV (segundos UTC) a velas semanales (lunes–viernes)
 * agrupadas por semana calendario en `timeZone` sin mutar el array de entrada.
 *
 * - Descarta barras con `time` no entero / fuera de rango (p. ej. milisegundos), OHLC no
 *   finitos, `high < low` o `volume` no finito / negativo; ante timestamps duplicados
 *   conserva la última ocurrencia (alineado con `dedupAndSortBars`).
 * - `time` de la vela semanal = apertura real de la primera rueda hábil del cubo.
 */
export function resampleDailyToWeekly(
  dailyBars: readonly Bar[],
  timeZone: string = US_MARKET_TIMEZONE,
): Bar[] {
  const byTime = new Map<number, Bar>();
  for (const bar of dailyBars) {
    if (!isValidDailyBar(bar)) {
      continue;
    }
    byTime.set(bar.time, bar);
  }
  const sorted = [...byTime.values()].sort((a, b) => a.time - b.time);

  const buckets = new Map<string, Bar[]>();
  for (const bar of sorted) {
    const key = getCalendarWeekMondayKey(bar.time, timeZone);
    if (key === null) {
      continue;
    }
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, [bar]);
    } else {
      bucket.push(bar);
    }
  }

  const out: Bar[] = [];
  for (const bucket of buckets.values()) {
    const weekly = aggregateWeeklyBar(bucket);
    if (weekly !== null) {
      out.push(weekly);
    }
  }
  return out;
}
