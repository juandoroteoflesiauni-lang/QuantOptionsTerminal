/**
 * Alineación de peticiones a los límites reales de barra de cada proveedor.
 *
 * Massive (acciones):
 *  - 1m/5m/15m/1h: el desfase ET es un número entero de horas, así que alinear
 *    contra la época UTC coincide con alinear contra la hora ET.
 *  - 4h: el proveedor ANCLA la rejilla al `from` de la petición y avanza en
 *    UTC (evidencia del Paso C, `docs/step_c_report.md`). `alignDown` fija
 *    ese ancla en un límite de pared ET del instante dado (00:00, 04:00,
 *    ..., 20:00 ET), así que las barras empiezan en hora ET correcta EN EL
 *    ANCLA. En una ventana que cruza un cambio de horario la rejilla sigue
 *    avanzando en UTC y las horas ET de las barras se desplazan ±1h: una
 *    sola petición no puede mantener una rejilla ET fija.
 *  - 1D: las barras abren a 00:00 ET, no a medianoche UTC.
 *
 * BingX (cripto):
 *  - 1m/5m/15m/1h/4h: múltiplos de la temporalidad desde la época UTC.
 *  - 1D: las barras abren a las 16:00 UTC (00:00 UTC+8), según la muestra real.
 *
 * `alignDown` nunca sube: si `time` ya es un límite devuelve el mismo
 * instante, y aplicarla de nuevo sobre su resultado es idempotente.
 */

import { getMarketParts } from '../core/sessions.js';
import type { DataProvider, Timeframe } from './types.js';
import { TIMEFRAME_SECONDS } from './timeframes.js';

const SECONDS_PER_DAY = 86_400;
const BINGX_DAILY_OPEN_OFFSET_SECONDS = 16 * 3_600;

function assertIntegerSeconds(time: number): void {
  if (!Number.isFinite(time) || !Number.isInteger(time)) {
    throw new Error(
      `time must be finite integer seconds (got ${String(time)})`,
    );
  }
}

/**
 * Convierte una hora civil ET (year, month, day, minutesOfDay) a segundos UTC.
 *
 * Se prueban los dos desfases posibles (EDT -4h y EST -5h) y se acepta el que
 * reproduce exactamente la hora civil pedida. Las horas inexistentes del salto
 * de primavera caen fuera de los límites usados aquí (00:00 y múltiplos de 4h),
 * así que el fallback EST solo cubre un caso defensivo.
 *
 * Exportada para la agregación rthOnly+1h: la apertura nominal de cada
 * ventana 09:30-anclada se construye con esta conversión.
 */
export function etWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  minutesOfDay: number,
): number {
  const hour = Math.floor(minutesOfDay / 60);
  const minute = minutesOfDay % 60;
  const guess = Date.UTC(year, month - 1, day, hour, minute) / 1000;

  for (const offsetSeconds of [4 * 3_600, 5 * 3_600]) {
    const candidate = guess + offsetSeconds;
    const parts = getMarketParts(candidate, 'EQUITY');
    if (
      parts.year === year &&
      parts.month === month &&
      parts.day === day &&
      parts.minutesOfDay === minutesOfDay
    ) {
      return candidate;
    }
  }

  return guess + 5 * 3_600;
}

/**
 * Baja `time` al inicio de la barra que lo contiene.
 *
 * No sube nunca: si `time` ya es un límite, devuelve el mismo instante.
 */
export function alignDown(
  time: number,
  timeframe: Timeframe,
  provider: DataProvider,
): number {
  assertIntegerSeconds(time);
  const barSeconds = TIMEFRAME_SECONDS[timeframe];

  if (provider === 'bingx') {
    if (timeframe === '1D') {
      return (
        Math.floor(
          (time - BINGX_DAILY_OPEN_OFFSET_SECONDS) / SECONDS_PER_DAY,
        ) *
          SECONDS_PER_DAY +
        BINGX_DAILY_OPEN_OFFSET_SECONDS
      );
    }
    return Math.floor(time / barSeconds) * barSeconds;
  }

  if (timeframe === '1D') {
    const parts = getMarketParts(time, 'EQUITY');
    return etWallTimeToUtc(parts.year, parts.month, parts.day, 0);
  }

  if (timeframe === '4h') {
    const parts = getMarketParts(time, 'EQUITY');
    const alignedMinutes = Math.floor(parts.minutesOfDay / 240) * 240;
    return etWallTimeToUtc(
      parts.year,
      parts.month,
      parts.day,
      alignedMinutes,
    );
  }

  return Math.floor(time / barSeconds) * barSeconds;
}
