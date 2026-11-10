/** Helpers internos compartidos por los normalizadores de Massive y BingX. */

import { MAX_TIME_SECONDS, sessionKey } from '../core/sessions.js';
import type { Bar } from '../core/types.js';
import type {
  BarGap,
  DiscardCause,
  DataProvider,
  GapDetection,
  NormalizeOptions,
} from './types.js';

/**
 * Nombres de parámetro de autenticación que viajan en la URL. Se normalizan a
 * minúsculas para comparar (los proveedores aceptan cualquier capitalización).
 */
export const AUTH_PARAM_NAMES: ReadonlySet<string> = new Set([
  'apikey',
  'api_key',
  'api-key',
]);

export const AUTH_PARAM_PATTERN = new RegExp(
  `([?&](?:${[...AUTH_PARAM_NAMES].join('|')})=)[^&\\s]+`,
  'gi',
);

/**
 * Redacción de secretos en texto que puede acabar en un reporte o error.
 *
 * Sustituye cada secreto conocido (el valor real de la clave cuando se
 * conoce) por `<redacted>` y, siempre, el valor de cualquier parámetro de
 * autenticación en una URL (`?apiKey=...` -> `?apiKey=<redacted>`).
 *
 * Los normalizadores no reciben la clave, así que la invocan con lista de
 * secretos vacía: solo aplican el patrón de la URL.
 */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret !== '') {
      out = out.split(secret).join('<redacted>');
    }
  }
  return out.replace(AUTH_PARAM_PATTERN, '$1<redacted>');
}

export const DISCARD_CAUSES: readonly DiscardCause[] = Object.freeze([
  'malformedRow',
  'invalidTime',
  'nonFinite',
  'invalidPrice',
  'highBelowLow',
  'invalidOhlc',
  'invalidVolume',
  'duplicate',
]);

export function createDiscardCounts(): Record<DiscardCause, number> {
  return {
    malformedRow: 0,
    invalidTime: 0,
    nonFinite: 0,
    invalidPrice: 0,
    highBelowLow: 0,
    invalidOhlc: 0,
    invalidVolume: 0,
    duplicate: 0,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Convierte un mensaje de error crudo a texto sin stringificar objetos. */
export function toErrorMessage(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return fallback;
}

/**
 * Campo `code` de una respuesta de BingX.
 *
 * - `absent`: el campo no viene (se tolera, igual que hoy).
 * - `number`: código numérico; 0 significa éxito y cualquier otro valor es
 *   un error del proveedor.
 * - `malformed`: el campo está presente pero no es un número decimal finito
 *   (por ejemplo "oops", "", "0x10" o "inf"); la respuesta no cumple el
 *   contrato del proveedor.
 */
export type BingxCodeField =
  | { readonly kind: 'absent' }
  | { readonly kind: 'number'; readonly code: number }
  | { readonly kind: 'malformed' };

/** Gramática decimal aceptada para un `code` en string. */
const DECIMAL_NUMBER_PATTERN =
  /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export function parseBingxCode(value: unknown): BingxCodeField {
  if (value === undefined || value === null) {
    return { kind: 'absent' };
  }
  if (typeof value === 'number') {
    return isFiniteNumber(value)
      ? { kind: 'number', code: value }
      : { kind: 'malformed' };
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!DECIMAL_NUMBER_PATTERN.test(trimmed)) {
      return { kind: 'malformed' };
    }
    const parsed = Number(trimmed);
    return isFiniteNumber(parsed)
      ? { kind: 'number', code: parsed }
      : { kind: 'malformed' };
  }
  return { kind: 'malformed' };
}

/**
 * Convierte milisegundos crudos a segundos UTC enteros.
 *
 * Devuelve null si el valor no es un entero positivo en milisegundos exactos.
 * Un valor en segundos (por ejemplo 1793955600) NO se acepta: no es múltiplo
 * de 1000, y normalizarlo silenciosamente mezclaría unidades.
 *
 * También devuelve null si el resultado en segundos excede MAX_TIME_SECONDS
 * (el umbral que admiten las sesiones): una fila con un timestamp imposible
 * se reporta como invalidTime en lugar de llegar a sessionKey y lanzar.
 */
export function parseMilliseconds(value: unknown): number | null {
  if (
    !isFiniteNumber(value) ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value % 1_000 !== 0
  ) {
    return null;
  }

  const seconds = value / 1_000;
  if (
    !Number.isSafeInteger(seconds) ||
    seconds <= 0 ||
    seconds > MAX_TIME_SECONDS
  ) {
    return null;
  }
  return seconds;
}

export function assertNormalizeOptions(options: NormalizeOptions): void {
  if (!Number.isInteger(options.barSeconds) || options.barSeconds <= 0) {
    throw new Error(
      `barSeconds must be a positive integer (got ${String(options.barSeconds)})`,
    );
  }
  if (
    options.now !== undefined &&
    (!Number.isFinite(options.now) || !Number.isInteger(options.now))
  ) {
    throw new Error(
      `now must be finite integer seconds (got ${String(options.now)})`,
    );
  }
  if (
    options.now !== undefined &&
    (options.now <= 0 || options.now > MAX_TIME_SECONDS)
  ) {
    throw new Error(
      `now must be within the supported seconds range (got ${String(options.now)})`,
    );
  }
}

/**
 * Detecta huecos sin rellenarlos.
 *
 * En acciones se ignoran los saltos entre sesiones ET distintas (de 19:59 a
 * 04:00 del día siguiente no es un hueco de datos). En cripto no se ignora
 * ningún salto: el mercado es continuo y un hueco que cruza medianoche UTC
 * sigue siendo un hueco.
 *
 * Las barras diarias se marcan como `skippedDaily`: su rejilla incluye fines de
 * semana y feriados, y no existe un calendario de mercado en esta capa.
 */
export function detectGaps(
  bars: readonly Bar[],
  barSeconds: number,
  provider: DataProvider,
): { gaps: readonly BarGap[]; gapDetection: GapDetection } {
  if (barSeconds >= 86_400) {
    return { gaps: [], gapDetection: 'skippedDaily' };
  }

  const gaps: BarGap[] = [];
  for (let index = 1; index < bars.length; index++) {
    const previous = bars[index - 1];
    const current = bars[index];
    if (previous === undefined || current === undefined) {
      continue;
    }

    const diffSeconds = current.time - previous.time;
    if (diffSeconds <= barSeconds) {
      continue;
    }

    if (
      provider === 'massive' &&
      sessionKey(previous.time, 'EQUITY') !==
        sessionKey(current.time, 'EQUITY')
    ) {
      continue;
    }

    const missingBars = Math.floor((diffSeconds - 1) / barSeconds);
    if (missingBars <= 0) {
      continue;
    }

    gaps.push({
      previousTime: previous.time,
      nextTime: current.time,
      diffSeconds,
      missingBars,
      sessionKey: sessionKey(
        previous.time,
        provider === 'massive' ? 'EQUITY' : 'CRYPTO',
      ),
    });
  }

  return { gaps, gapDetection: 'performed' };
}
