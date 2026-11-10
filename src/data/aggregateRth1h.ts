/**
 * Agregación rthOnly + 1h para acciones (Massive).
 *
 * En este modo NO se usa la 1h nativa: la barra de 09:00 mezcla premarket
 * con la apertura y con rthOnly se descartaría, perdiendo media hora de
 * RTH. En su lugar el cargador pide barras de 30m y agrega las 7 ventanas
 * de la sesión regular ancladas a 09:30 ET: 09:30-10:30, ..., 15:30-16:00
 * (la última dura 30 minutos).
 *
 * Funciones puras: no mutan los argumentos y no tocan la red. No se inventan
 * barras: una ventana sin mitades no se emite (los huecos de 30m la
 * reportan) y el vw de una mitad no utilizable se sustituye por el precio
 * típico de ESA mitad, (high+low+close)/3, dentro del promedio ponderado
 * (cada sustitución cuenta en `vwFallbackHalves`); la ventana solo sale sin
 * vw si la suma de volumen es 0.
 */

import { getMarketParts } from '../core/sessions.js';
import type { Bar } from '../core/types.js';
import { etWallTimeToUtc } from './alignment.js';
import type { FormingBarInfo } from './types.js';

/** Segundos de las barras de 30m que se piden en este modo. */
export const RTH_1H_FETCH_BAR_SECONDS = 1_800;

/** Apertura de la sesión regular en minutos ET (09:30). */
const RTH_1H_START_MINUTES = 9 * 60 + 30;

/** Cierre de la sesión regular en minutos ET (16:00). */
const RTH_1H_END_MINUTES = 16 * 60;

/**
 * Mitades de 30m esperadas por ventana: 6 ventanas de 2 mitades y la última
 * (15:30-16:00) de 1. Una ventana cerrada con menos mitades que las esperadas
 * es una agregación parcial: Massive omite las barras sin operaciones.
 */
const EXPECTED_HALVES: readonly number[] = [2, 2, 2, 2, 2, 2, 1];

export interface Rth1hAggregate {
  /** Ventanas cerradas, en orden ascendente. */
  readonly bars: readonly Bar[];
  /** Ventana en formación (su tramo aún no cerró); no está en `bars`. */
  readonly formingWindow: FormingBarInfo | null;
  /** Ventanas cerradas agregadas con menos mitades que las esperadas. */
  readonly partialBars: number;
  /**
   * Mitades cuyo vw no utilizable (ausente, 0 o no finito) se sustituyó por
   * (high + low + close) / 3 en el promedio ponderado, tengan volumen o no.
   */
  readonly vwFallbackHalves: number;
}

interface WindowGroup {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly halves: Bar[];
}

/** vw utilizable: finito y > 0 (ausente, 0 o no finito cuenta como ausente). */
function isUsableVw(vw: number | undefined): vw is number {
  return vw !== undefined && Number.isFinite(vw) && vw > 0;
}

/** Apertura nominal de la ventana `index` (0..6) del día del grupo, en UTC. */
function windowOpenSeconds(group: WindowGroup, index: number): number {
  return etWallTimeToUtc(
    group.year,
    group.month,
    group.day,
    RTH_1H_START_MINUTES + 60 * index,
  );
}

/** Cierre nominal de la ventana `index` (0..6); la última acaba a las 16:00. */
function windowEndSeconds(group: WindowGroup, index: number): number {
  return etWallTimeToUtc(
    group.year,
    group.month,
    group.day,
    Math.min(RTH_1H_START_MINUTES + 60 * (index + 1), RTH_1H_END_MINUTES),
  );
}

/**
 * Agrega barras de 30m RTH cerradas en ventanas de 1h ancladas a 09:30 ET.
 *
 * Entrada: barras de 30m SIN la barra en formación y en orden ascendente.
 * Filtrar RTH es precondición del cargador; por defensa, una apertura fuera
 * de 09:30-16:00 ET se ignora en vez de producir ventanas desalineadas.
 *
 * Reglas:
 *  - Las ventanas se agrupan por reloj civil ET (dateKey + minuto), así que
 *    un cambio de horario dentro de la ventana de petición no desalinea.
 *  - `time` es la apertura nominal de la ventana en ET, aunque falte la
 *    primera mitad: la ventana representa su tramo de rejilla.
 *  - open de la primera mitad, close de la última, high = máx, low = mín,
 *    volume = suma (acumulando en orden ascendente de tiempo).
 *  - vw = sum(price * volume) / sum(volume) con price = vw de la mitad si es
 *    utilizable (finito y > 0) o el precio típico (high+low+close)/3 de esa
 *    mitad si no; cada mitad que usa el fallback cuenta en
 *    `vwFallbackHalves`. La ventana sale sin vw solo si la suma de volumen
 *    es 0.
 *  - Una ventana está cerrada solo si el final de su ventana ya pasó respecto
 *    a `now`; la que está en formación no se emite y se reporta en
 *    `formingWindow`.
 *  - Ventana cerrada con menos mitades que las esperadas cuenta en
 *    `partialBars`.
 */
export function aggregateRth1hFrom30m(
  bars30m: readonly Bar[],
  now: number,
): Rth1hAggregate {
  const groups = new Map<string, Map<number, WindowGroup>>();
  for (const bar of bars30m) {
    const parts = getMarketParts(bar.time, 'EQUITY');
    if (
      parts.minutesOfDay < RTH_1H_START_MINUTES ||
      parts.minutesOfDay >= RTH_1H_END_MINUTES
    ) {
      continue;
    }
    const index = Math.floor(
      (parts.minutesOfDay - RTH_1H_START_MINUTES) / 60,
    );
    let session = groups.get(parts.dateKey);
    if (session === undefined) {
      session = new Map<number, WindowGroup>();
      groups.set(parts.dateKey, session);
    }
    let group = session.get(index);
    if (group === undefined) {
      group = { year: parts.year, month: parts.month, day: parts.day, halves: [] };
      session.set(index, group);
    }
    group.halves.push(bar);
  }

  const bars: Bar[] = [];
  let formingWindow: FormingBarInfo | null = null;
  let partialBars = 0;
  let vwFallbackHalves = 0;

  const dateKeys = [...groups.keys()].sort();
  for (const dateKey of dateKeys) {
    const session = groups.get(dateKey);
    if (session === undefined) {
      continue;
    }
    const indices = [...session.keys()].sort((left, right) => left - right);
    for (const index of indices) {
      const group = session.get(index);
      if (group === undefined) {
        continue;
      }
      const halves = [...group.halves].sort(
        (left, right) => left.time - right.time,
      );
      const firstHalf = halves[0];
      const lastHalf = halves[halves.length - 1];
      if (firstHalf === undefined || lastHalf === undefined) {
        continue;
      }
      const openSeconds = windowOpenSeconds(group, index);
      const endSeconds = windowEndSeconds(group, index);
      if (now < endSeconds) {
        formingWindow = { time: openSeconds, reason: 'intervalContainsNow' };
        continue;
      }

      let volume = 0;
      let high = -Infinity;
      let low = Infinity;
      let vwNumerator = 0;
      for (const half of halves) {
        volume += half.volume;
        if (half.high > high) {
          high = half.high;
        }
        if (half.low < low) {
          low = half.low;
        }
        if (isUsableVw(half.vw)) {
          vwNumerator += half.vw * half.volume;
        } else {
          // Mitad sin vw utilizable: su contribución al promedio usa el
          // precio típico de esa mitad (high + low + close) / 3.
          const typicalPrice = (half.high + half.low + half.close) / 3;
          vwNumerator += typicalPrice * half.volume;
          vwFallbackHalves += 1;
        }
      }

      const expectedHalves = EXPECTED_HALVES[index];
      if (expectedHalves === undefined) {
        throw new Error(`Unexpected rth 1h window index: ${String(index)}`);
      }
      const window: Bar = {
        time: openSeconds,
        open: firstHalf.open,
        high,
        low,
        close: lastHalf.close,
        volume,
        ...(volume > 0 ? { vw: vwNumerator / volume } : {}),
      };
      bars.push(window);
      if (halves.length < expectedHalves) {
        partialBars += 1;
      }
    }
  }

  return { bars, formingWindow, partialBars, vwFallbackHalves };
}
