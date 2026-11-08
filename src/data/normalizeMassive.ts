/**
 * Normalizador puro de aggs de Massive (SPEC punto 6).
 *
 * Responsabilidades:
 *  - Convertir `t` de milisegundos a segundos UTC (única conversión del proyecto).
 *  - Descartar filas malformadas, tiempos inválidos, campos no finitos, precios
 *    <= 0, high < low, volumen negativo y duplicados.
 *  - Ordenar por tiempo ascendente sin mutar la respuesta cruda.
 *  - Reportar cada descarte con su causa y su tiempo (cuando existe).
 *  - Detectar huecos dentro de la sesión ET sin rellenarlos.
 *  - Reportar la barra en formación sin eliminarla (la capa de carga decide).
 *
 * No se inventan valores: si un campo no es calculable, se descarta la fila o
 * se omite el campo opcional `vw`. Nunca se usa un valor de respaldo.
 */

import type { Bar } from '../core/types.js';
import { sessionKey } from '../core/sessions.js';
import {
  assertNormalizeOptions,
  createDiscardCounts,
  detectGaps,
  isFiniteNumber,
  isRecord,
  parseMilliseconds,
  toErrorMessage,
} from './normalizeShared.js';
import type {
  DiscardCause,
  DiscardRecord,
  FormingBarInfo,
  MassiveNormalizeReport,
  MassiveNormalizeResult,
  NormalizeOptions,
  ProviderError,
} from './types.js';

function detectFormingBar(
  bars: readonly Bar[],
  options: NormalizeOptions,
): FormingBarInfo | null {
  const now = options.now;
  if (now === undefined) {
    return null;
  }

  // Las barras diarias de Massive abren a 00:00 ET. La barra en formación es la
  // de la fecha ET actual; usar barSeconds=86400 fallaría en días de cambio de
  // horario (23h/25h), así que se compara la clave de sesión.
  if (options.barSeconds >= 86_400) {
    const nowSession = sessionKey(now, 'EQUITY');
    for (const bar of bars) {
      if (sessionKey(bar.time, 'EQUITY') === nowSession) {
        return { time: bar.time, reason: 'intervalContainsNow' };
      }
    }
    return null;
  }

  for (const bar of bars) {
    if (bar.time <= now && now < bar.time + options.barSeconds) {
      return { time: bar.time, reason: 'intervalContainsNow' };
    }
  }
  return null;
}

/**
 * Normaliza una respuesta cruda de `/v2/aggs/ticker/...`.
 *
 * `raw` se acepta como `unknown` porque una respuesta de error o un JSON
 * inesperado también debe producir un reporte, no una excepción.
 */
export function normalizeMassiveAggs(
  raw: unknown,
  options: NormalizeOptions,
): MassiveNormalizeResult {
  assertNormalizeOptions(options);

  const discardCounts = createDiscardCounts();
  const discards: DiscardRecord[] = [];
  const bars: Bar[] = [];
  const seenTimes = new Set<number>();
  const inputTimes: number[] = [];

  let received = 0;
  let vwMissing = 0;
  let vwZero = 0;
  let vwNonFinite = 0;
  let vwOutsideRange = 0;
  let malformedResponse = false;
  let providerError: ProviderError | null = null;

  const recordDiscard = (cause: DiscardCause, time: number | null): void => {
    discardCounts[cause] += 1;
    discards.push({ cause, time });
  };

  let rows: readonly unknown[] = [];
  if (!isRecord(raw)) {
    malformedResponse = true;
  } else {
    const status = raw['status'];
    if (typeof status === 'string' && status.toUpperCase() !== 'OK') {
      const message = raw['error'] ?? raw['message'];
      providerError = {
        code: 0,
        message: toErrorMessage(message, status),
      };
    }

    const results = raw['results'];
    if (results === undefined || results === null) {
      rows = [];
    } else if (Array.isArray(results)) {
      rows = results;
    } else {
      malformedResponse = true;
      rows = [];
    }
  }

  received = rows.length;

  for (const row of rows) {
    if (!isRecord(row)) {
      recordDiscard('malformedRow', null);
      continue;
    }

    const time = parseMilliseconds(row['t']);
    if (time === null) {
      recordDiscard('invalidTime', null);
      continue;
    }

    const open = row['o'];
    const high = row['h'];
    const low = row['l'];
    const close = row['c'];
    const volume = row['v'];

    if (
      !isFiniteNumber(open) ||
      !isFiniteNumber(high) ||
      !isFiniteNumber(low) ||
      !isFiniteNumber(close) ||
      !isFiniteNumber(volume)
    ) {
      recordDiscard('nonFinite', time);
      continue;
    }

    if (open <= 0 || high <= 0 || low <= 0 || close <= 0) {
      recordDiscard('invalidPrice', time);
      continue;
    }

    if (high < low) {
      recordDiscard('highBelowLow', time);
      continue;
    }

    if (volume < 0) {
      recordDiscard('invalidVolume', time);
      continue;
    }

    if (seenTimes.has(time)) {
      recordDiscard('duplicate', time);
      continue;
    }
    seenTimes.add(time);
    inputTimes.push(time);

    const bar: {
      time: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
      vw?: number;
    } = { time, open, high, low, close, volume };

    const vw = row['vw'];
    if (vw === undefined || vw === null) {
      vwMissing += 1;
    } else if (!isFiniteNumber(vw)) {
      // El campo opcional no es calculable: se omite, pero la barra OHLCV sigue
      // siendo válida. El VWAP de sesión aplicará la regla HLC3 del SPEC.
      vwNonFinite += 1;
    } else {
      bar.vw = vw;
      if (vw === 0) {
        vwZero += 1;
      }
      if (vw < low || vw > high) {
        vwOutsideRange += 1;
      }
    }

    bars.push(bar);
  }

  const sortedBars = [...bars].sort((left, right) => left.time - right.time);
  let reordered = false;
  for (let index = 0; index < sortedBars.length; index++) {
    const bar = sortedBars[index];
    if (bar === undefined || bar.time !== inputTimes[index]) {
      reordered = true;
      break;
    }
  }

  const { gaps, gapDetection } = detectGaps(
    sortedBars,
    options.barSeconds,
    'massive',
  );
  const formingBar = detectFormingBar(sortedBars, options);

  const report: MassiveNormalizeReport = {
    provider: 'massive',
    received,
    accepted: sortedBars.length,
    discarded: received - sortedBars.length,
    discardCounts,
    discards,
    reordered,
    gaps,
    gapDetection,
    vwMissing,
    vwZero,
    vwNonFinite,
    vwOutsideRange,
    formingBar,
    malformedResponse,
    providerError,
  };

  return { bars: sortedBars, report };
}
