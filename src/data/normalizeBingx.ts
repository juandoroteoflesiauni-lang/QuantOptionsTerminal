/**
 * Normalizador puro de klines de BingX (SPEC punto 6).
 *
 * Formato crudo: [openTimeMs, open, high, low, close, volume, closeTimeMs?, quoteVolume?].
 *
 * Sobre `vw`:
 *  - BingX no entrega VWAP. El SPEC permite usar quoteVolume/volume SOLO si se
 *    verifica con datos reales que cae dentro de [low, high].
 *  - La muestra real falló: en 1m, 185 de 3.445 barras quedaron fuera de rango.
 *    Por eso este normalizador NUNCA expone `vw`; solo reporta las estadísticas
 *    del candidato para que la decisión quede auditable.
 *
 * El resto de reglas es idéntico a Massive: ms -> segundos, descartes
 * reportados, orden ascendente, huecos sin rellenar y barra en formación
 * reportada pero no eliminada.
 *
 * Sobre `code`: un número (o string numérico decimal) distinto de 0 es un
 * error del proveedor; un `code` presente que no es numérico hace la
 * respuesta malformada. Un `code` ausente o null se tolera.
 */

import type { Bar } from '../core/types.js';
import {
  assertNormalizeOptions,
  createDiscardCounts,
  detectGaps,
  isFiniteNumber,
  isRecord,
  parseBingxCode,
  parseMilliseconds,
  redact,
  toErrorMessage,
} from './normalizeShared.js';
import type {
  BingxNormalizeReport,
  BingxNormalizeResult,
  DiscardCause,
  DiscardRecord,
  FormingBarInfo,
  NormalizeOptions,
  ProviderError,
} from './types.js';

/**
 * Un `closeTime` válido es un entero en milisegundos estrictamente posterior
 * a la apertura y anterior al cierre de la propia barra (apertura + duración).
 * Cualquier otro valor se ignora y la barra usa el fallback por intervalo.
 */
function isValidCloseTime(
  value: unknown,
  openTimeSeconds: number,
  barSeconds: number,
): value is number {
  return (
    isFiniteNumber(value) &&
    Number.isInteger(value) &&
    value > openTimeSeconds * 1_000 &&
    value < (openTimeSeconds + barSeconds) * 1_000
  );
}

function detectFormingBar(
  bars: readonly Bar[],
  closeTimes: ReadonlyMap<number, number>,
  options: NormalizeOptions,
): FormingBarInfo | null {
  const now = options.now;
  if (now === undefined) {
    return null;
  }
  const nowMilliseconds = now * 1_000;

  for (const bar of bars) {
    const closeTime = closeTimes.get(bar.time);
    if (closeTime !== undefined) {
      if (
        bar.time * 1_000 <= nowMilliseconds &&
        nowMilliseconds <= closeTime
      ) {
        return { time: bar.time, reason: 'closeTimeContainsServerTime' };
      }
      continue;
    }

    if (bar.time <= now && now < bar.time + options.barSeconds) {
      return { time: bar.time, reason: 'intervalContainsNow' };
    }
  }

  return null;
}

/**
 * Normaliza una respuesta cruda de `/openApi/spot/v2/market/kline`.
 *
 * `raw` se acepta como `unknown` para que una respuesta de error también
 * produzca un reporte en lugar de una excepción.
 */
export function normalizeBingxKlines(
  raw: unknown,
  options: NormalizeOptions,
): BingxNormalizeResult {
  assertNormalizeOptions(options);

  const discardCounts = createDiscardCounts();
  const discards: DiscardRecord[] = [];
  const bars: Bar[] = [];
  const seenTimes = new Set<number>();
  const inputTimes: number[] = [];
  const closeTimes = new Map<number, number>();

  let received = 0;
  let vwCandidateBars = 0;
  let vwCandidateMissing = 0;
  let vwCandidateZeroVolume = 0;
  let vwCandidateOutsideRange = 0;
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
    const parsedCode = parseBingxCode(raw['code']);
    if (parsedCode.kind === 'malformed') {
      // Un `code` presente que no es un número decimal finito no cumple el
      // contrato del proveedor: respuesta malformada, sin filas.
      malformedResponse = true;
    } else {
      if (parsedCode.kind === 'number' && parsedCode.code !== 0) {
        const message = raw['msg'] ?? raw['message'];
        providerError = {
          code: parsedCode.code,
          // El mensaje del proveedor puede repetir la URL de la petición (con
          // la clave): se redacta el parámetro de autenticación por si el
          // normalizador se usa sin pasar por el cargador.
          message: redact(toErrorMessage(message, ''), []),
        };
      }

      const data = raw['data'];
      if (data === undefined || data === null) {
        rows = [];
      } else if (Array.isArray(data)) {
        rows = data;
      } else {
        malformedResponse = true;
        rows = [];
      }
    }
  }

  received = rows.length;

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) {
      recordDiscard('malformedRow', null);
      continue;
    }

    const values: readonly unknown[] = row;
    const time = parseMilliseconds(values[0]);
    if (time === null) {
      recordDiscard('invalidTime', null);
      continue;
    }

    const open = values[1];
    const high = values[2];
    const low = values[3];
    const close = values[4];
    const volume = values[5];

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

    const closeTime = values[6];
    // Solo un closeTime en ms, entero y dentro de la duración de la barra
    // participa en la detección de formación. Un closeTime inválido se
    // ignora y la barra cae al fallback por intervalo.
    if (isValidCloseTime(closeTime, time, options.barSeconds)) {
      closeTimes.set(time, closeTime);
    }

    const quoteVolume = values[7];
    if (volume === 0) {
      vwCandidateZeroVolume += 1;
    } else if (!isFiniteNumber(quoteVolume)) {
      vwCandidateMissing += 1;
    } else {
      const candidate = quoteVolume / volume;
      if (!Number.isFinite(candidate)) {
        vwCandidateMissing += 1;
      } else {
        vwCandidateBars += 1;
        if (candidate < low || candidate > high) {
          vwCandidateOutsideRange += 1;
        }
      }
    }

    // Nunca se añade vw: la verificación real del SPEC punto 6 falló.
    bars.push({ time, open, high, low, close, volume });
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
    'bingx',
  );
  const formingBar = detectFormingBar(sortedBars, closeTimes, options);

  const report: BingxNormalizeReport = {
    provider: 'bingx',
    received,
    accepted: sortedBars.length,
    discarded: received - sortedBars.length,
    discardCounts,
    discards,
    reordered,
    gaps,
    gapDetection,
    vwCandidateBars,
    vwCandidateMissing,
    vwCandidateZeroVolume,
    vwCandidateOutsideRange,
    vwExposed: false,
    formingBar,
    malformedResponse,
    providerError,
  };

  return { bars: sortedBars, report };
}
