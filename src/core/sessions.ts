/**
 * Gestor de sesiones de mercado (SPEC punto 3).
 *
 * Todas las funciones son puras. `time` siempre son segundos UTC enteros.
 * Para acciones, las partes de fecha/hora se obtienen en America/New_York
 * (con horario de verano); para cripto, en UTC. Nunca se derivan las partes
 * de una acción con getUTC*.
 */

export type Market = 'EQUITY' | 'CRYPTO';

export interface MarketParts {
  /** Año en la zona del mercado. */
  readonly year: number;
  /** Mes 1..12 en la zona del mercado. */
  readonly month: number;
  /** Día 1..31 en la zona del mercado. */
  readonly day: number;
  /** Hora 0..23 en la zona del mercado. */
  readonly hour: number;
  /** Minuto 0..59 en la zona del mercado. */
  readonly minute: number;
  /** Día ISO: lunes = 1 ... domingo = 7. */
  readonly weekday: number;
  /** Fecha local en formato YYYY-MM-DD. */
  readonly dateKey: string;
  /** Minutos transcurridos desde la medianoche local: hour * 60 + minute. */
  readonly minutesOfDay: number;
}

/** Umbral máximo admitido para un timestamp en segundos. */
const MAX_TIME_SECONDS = 1e11;

const RTH_START_MINUTES = 9 * 60 + 30;
const RTH_END_MINUTES = 16 * 60;

const FORMATTER_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
  hourCycle: 'h23',
};

/**
 * Un único Intl.DateTimeFormat por zona horaria.
 * Se cachea porque construir formateadores es caro y los ticks llegan en ráfaga.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * Solo para tests: número de formateadores actualmente cacheados.
 * Debe permanecer en 2 (America/New_York y UTC) tras cualquier número de llamadas.
 */
export function getFormatterCacheSizeForTests(): number {
  return formatterCache.size;
}

function getTimeZone(market: Market): string {
  switch (market) {
    case 'EQUITY':
      return 'America/New_York';
    case 'CRYPTO':
      return 'UTC';
    default:
      throw new Error(`Unsupported market: ${String(market)}`);
  }
}

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached !== undefined) {
    return cached;
  }

  const formatter = new Intl.DateTimeFormat('en-US', {
    ...FORMATTER_OPTIONS,
    timeZone,
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/**
 * Valida que `time` sea un entero finito de segundos.
 *
 * No se normaliza nada aquí: un valor en milisegundos (por ejemplo, > 1e11)
 * es un error de entrada, no algo que debamos dividir silenciosamente.
 */
function assertValidTime(time: number): void {
  if (
    !Number.isFinite(time) ||
    !Number.isInteger(time) ||
    Math.abs(time) > MAX_TIME_SECONDS
  ) {
    throw new Error(
      `time must be finite integer seconds (got ${String(time)})`,
    );
  }
}

function getPart(
  parts: readonly Intl.DateTimeFormatPart[],
  type: string,
): string {
  for (const part of parts) {
    if (part.type === type) {
      return part.value;
    }
  }
  throw new Error(`Missing ${type} in Intl.DateTimeFormat result`);
}

function getNumericPart(
  parts: readonly Intl.DateTimeFormatPart[],
  type: string,
): number {
  const value = Number(getPart(parts, type));
  if (!Number.isInteger(value)) {
    throw new Error(`Invalid numeric ${type} part: ${String(value)}`);
  }
  return value;
}

function weekdayFromShortName(name: string): number {
  switch (name) {
    case 'Mon':
      return 1;
    case 'Tue':
      return 2;
    case 'Wed':
      return 3;
    case 'Thu':
      return 4;
    case 'Fri':
      return 5;
    case 'Sat':
      return 6;
    case 'Sun':
      return 7;
    default:
      throw new Error(`Unexpected weekday name: ${name}`);
  }
}

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

function formatDateKey(year: number, month: number, day: number): string {
  return `${year.toString().padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/**
 * Desplaza una fecha civil (year, month, day) un número de días.
 * Se opera solo con la fecha local, sin volver a interpretar el instante UTC.
 */
function shiftDateByDays(date: CalendarDate, deltaDays: number): CalendarDate {
  let year = date.year;
  let month = date.month;
  let day = date.day + deltaDays;

  while (day < 1) {
    month -= 1;
    if (month < 1) {
      month = 12;
      year -= 1;
    }
    day += daysInMonth(year, month);
  }

  while (day > daysInMonth(year, month)) {
    day -= daysInMonth(year, month);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return { year, month, day };
}

/**
 * Obtiene las partes de fecha/hora en la zona del mercado.
 *
 * `weekday` es ISO: lunes = 1 ... domingo = 7.
 */
export function getMarketParts(time: number, market: Market): MarketParts {
  assertValidTime(time);

  const formatter = getFormatter(getTimeZone(market));
  const parts = formatter.formatToParts(new Date(time * 1000));

  const year = getNumericPart(parts, 'year');
  const month = getNumericPart(parts, 'month');
  const day = getNumericPart(parts, 'day');
  const hour = getNumericPart(parts, 'hour');
  const minute = getNumericPart(parts, 'minute');
  const weekday = weekdayFromShortName(getPart(parts, 'weekday'));

  return {
    year,
    month,
    day,
    hour,
    minute,
    weekday,
    dateKey: formatDateKey(year, month, day),
    minutesOfDay: hour * 60 + minute,
  };
}

/**
 * RTH de acciones: 09:30 <= hora ET < 16:00 y lunes a viernes.
 *
 * No modela feriados ni cierres anticipados. Por tanto, un lunes feriado a las
 * 12:00 ET devuelve true: la ausencia de sesión es un dato del calendario de
 * mercado que esta función deliberadamente no conoce.
 */
export function isRth(time: number): boolean {
  const parts = getMarketParts(time, 'EQUITY');
  return (
    parts.weekday >= 1 &&
    parts.weekday <= 5 &&
    parts.minutesOfDay >= RTH_START_MINUTES &&
    parts.minutesOfDay < RTH_END_MINUTES
  );
}

/**
 * Clave de sesión: fecha local en la zona del mercado.
 * EQUITY -> fecha ET; CRYPTO -> fecha UTC.
 */
export function sessionKey(time: number, market: Market): string {
  return getMarketParts(time, market).dateKey;
}

/**
 * Clave de semana: fecha del lunes de esa semana en la zona del mercado,
 * en formato YYYY-MM-DD. Un lunes feriado conserva su propia clave semanal.
 */
export function weekKey(time: number, market: Market): string {
  const parts = getMarketParts(time, market);
  const monday = shiftDateByDays(
    { year: parts.year, month: parts.month, day: parts.day },
    -(parts.weekday - 1),
  );
  return formatDateKey(monday.year, monday.month, monday.day);
}

/** Clave de mes: year * 12 + month, con month 1..12 en la zona del mercado. */
export function monthKey(time: number, market: Market): number {
  const parts = getMarketParts(time, market);
  return parts.year * 12 + parts.month;
}

/** Clave de año en la zona del mercado. */
export function yearKey(time: number, market: Market): number {
  return getMarketParts(time, market).year;
}

export function isNewSession(
  prevTime: number,
  time: number,
  market: Market,
): boolean {
  return sessionKey(prevTime, market) !== sessionKey(time, market);
}

export function isNewWeek(
  prevTime: number,
  time: number,
  market: Market,
): boolean {
  return weekKey(prevTime, market) !== weekKey(time, market);
}

export function isNewMonth(
  prevTime: number,
  time: number,
  market: Market,
): boolean {
  return monthKey(prevTime, market) !== monthKey(time, market);
}

export function isNewYear(
  prevTime: number,
  time: number,
  market: Market,
): boolean {
  return yearKey(prevTime, market) !== yearKey(time, market);
}
