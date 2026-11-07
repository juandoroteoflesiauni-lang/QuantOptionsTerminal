/**
 * AVWAP anclado (SPEC puntos 5 y 9).
 *
 * Reglas principales:
 *  - El precio de cada barra es HLC3 = (high + low + close) / 3.
 *  - El peso es el volumen de la barra.
 *  - La acumulación usa Welford ponderado. Las barras con precio no finito o
 *    volumen no finito / <= 0 no cambian el estado.
 *  - La función NO filtra horario: acumula todas las barras recibidas desde el
 *    ancla. Si se quiere solo RTH, la capa de datos filtra antes.
 *  - Una barra ignorada, una vez que hay volumen acumulado, repite el último
 *    valor. Mientras cumVolume sea 0 no se emite ningún punto.
 *  - Las bandas ±1, ±2 y ±2.5 usan el MISMO stdDev del punto; no se recalcula
 *    sigma ni se hace clamp.
 *
 * Los anclajes SESSION/WEEK/MONTH/YTD se resuelven respecto de la ÚLTIMA
 * barra del array: se retrocede mientras la clave del periodo coincida. Si el
 * buffer empieza a mitad de periodo, el ancla es la primera barra del buffer
 * (AVWAP parcial, límite documentado en SPEC punto 9). HIGH_VOLUME_BAR y
 * FULL_HISTORY se evalúan solo sobre bars[visibleStart..].
 *
 * Todas las funciones son puras: no mutan las barras ni el estado de entrada.
 */

import {
  createInitialWelfordState,
  updateWelford,
  type WelfordOutput,
  type WelfordState,
} from './welford.js';
import {
  getMarketParts,
  isRthFromParts,
  monthKey,
  weekKey,
  yearKey,
  type Market,
} from './sessions.js';
import type { Bar } from './types.js';

export type AvwapAnchor =
  | 'SESSION'
  | 'WEEK'
  | 'MONTH'
  | 'YTD'
  | 'HIGH_VOLUME_BAR'
  | 'FULL_HISTORY';

export interface AvwapOptions {
  readonly market: Market;
  /**
   * Primer índice del tramo visible. Solo afecta a HIGH_VOLUME_BAR y
   * FULL_HISTORY; los anclajes de periodo se resuelven sobre todo el buffer.
   */
  readonly visibleStart?: number;
}

export interface AvwapPoint {
  readonly time: number;
  readonly vwap: number;
  readonly stdDev: number;
  readonly cumVolume: number;
  readonly upper1: number;
  readonly lower1: number;
  readonly upper2: number;
  readonly lower2: number;
  readonly upper2_5: number;
  readonly lower2_5: number;
}

export interface AvwapState {
  readonly welford: WelfordState;
}

export interface AvwapStep {
  readonly state: AvwapState;
  readonly point: AvwapPoint | null;
}

export interface AnchoredVwapResult {
  readonly anchorIndex: number;
  readonly points: AvwapPoint[];
  readonly state: AvwapState;
}

export const INITIAL_AVWAP_STATE: AvwapState = Object.freeze({
  welford: createInitialWelfordState(),
});

export function createInitialAvwapState(): AvwapState {
  return INITIAL_AVWAP_STATE;
}

function assertMarket(market: Market): void {
  switch (market) {
    case 'EQUITY':
    case 'CRYPTO':
      return;
    default:
      throw new Error(`Unsupported market: ${String(market)}`);
  }
}

/**
 * Comprueba que los tiempos crezcan estrictamente.
 * La validación de que sean segundos enteros (y no milisegundos) la hacen
 * las funciones de sessions.ts al calcular las claves o al validar el tramo.
 */
function assertStrictlyIncreasingTimes(bars: readonly Bar[]): void {
  let previous: number | null = null;
  for (const bar of bars) {
    if (previous !== null && bar.time <= previous) {
      throw new Error(
        `bar.time must increase strictly (previous ${String(previous)}, got ${String(bar.time)})`,
      );
    }
    previous = bar.time;
  }
}

/**
 * Valida los tiempos de todas las barras a través de sessions.ts. Se usa en
 * los anclajes que no necesitan claves de periodo, para que un timestamp en
 * milisegundos también lance error.
 */
function validateTimesThroughSessions(
  bars: readonly Bar[],
  market: Market,
): void {
  let previous: number | null = null;
  for (const bar of bars) {
    getMarketParts(bar.time, market);
    if (previous !== null && bar.time <= previous) {
      throw new Error(
        `bar.time must increase strictly (previous ${String(previous)}, got ${String(bar.time)})`,
      );
    }
    previous = bar.time;
  }
}

/**
 * Resuelve SESSION. En EQUITY el ancla es la primera barra RTH de la última
 * fecha; si esa fecha todavía no tiene ninguna barra RTH, devuelve -1. En
 * CRYPTO es la primera barra de la fecha UTC.
 */
function resolveSessionAnchorIndex(
  bars: readonly Bar[],
  market: Market,
): number {
  const keys = new Array<string>(bars.length);
  const rthFlags =
    market === 'EQUITY' ? new Array<boolean>(bars.length) : null;
  let lastKey: string | undefined;

  for (let index = 0; index < bars.length; index++) {
    const bar = bars[index];
    if (bar === undefined) {
      throw new Error(`Bar at index ${index.toString()} is undefined`);
    }
    const parts = getMarketParts(bar.time, market);
    keys[index] = parts.dateKey;
    if (rthFlags !== null) {
      rthFlags[index] = isRthFromParts(parts);
    }
    lastKey = parts.dateKey;
  }

  assertStrictlyIncreasingTimes(bars);

  if (lastKey === undefined) {
    return -1;
  }

  let start = bars.length - 1;
  while (start > 0 && keys[start - 1] === lastKey) {
    start--;
  }

  if (rthFlags === null) {
    return start;
  }

  for (let index = start; index < bars.length; index++) {
    if (rthFlags[index] === true) {
      return index;
    }
  }
  return -1;
}

/**
 * Resuelve WEEK, MONTH o YTD. La clave se calcula una sola vez por barra.
 */
function resolvePeriodAnchorIndex(
  bars: readonly Bar[],
  anchor: 'WEEK' | 'MONTH' | 'YTD',
  market: Market,
): number {
  const keys = new Array<string | number>(bars.length);
  let lastKey: string | number | undefined;

  for (let index = 0; index < bars.length; index++) {
    const bar = bars[index];
    if (bar === undefined) {
      throw new Error(`Bar at index ${index.toString()} is undefined`);
    }

    let key: string | number;
    switch (anchor) {
      case 'WEEK':
        key = weekKey(bar.time, market);
        break;
      case 'MONTH':
        key = monthKey(bar.time, market);
        break;
      case 'YTD':
        key = yearKey(bar.time, market);
        break;
    }

    keys[index] = key;
    lastKey = key;
  }

  assertStrictlyIncreasingTimes(bars);

  if (lastKey === undefined) {
    return -1;
  }

  let start = bars.length - 1;
  while (start > 0 && keys[start - 1] === lastKey) {
    start--;
  }
  return start;
}

/**
 * Primera barra con el mayor volumen finito > 0 en bars[visibleStart..].
 * Un empate gana la primera barra.
 */
function findHighVolumeBarIndex(
  bars: readonly Bar[],
  visibleStart: number,
): number {
  let bestIndex = -1;
  let bestVolume = Number.NEGATIVE_INFINITY;

  for (let index = visibleStart; index < bars.length; index++) {
    const bar = bars[index];
    if (bar === undefined) {
      throw new Error(`Bar at index ${index.toString()} is undefined`);
    }
    const volume = bar.volume;
    if (
      Number.isFinite(volume) &&
      volume > 0 &&
      volume > bestVolume
    ) {
      bestIndex = index;
      bestVolume = volume;
    }
  }

  return bestIndex;
}

/**
 * Resuelve el índice de ancla.
 *
 * Devuelve -1 cuando no hay ancla válida: array vacío, visibleStart inválido,
 * ninguna barra con volumen finito > 0 para HIGH_VOLUME_BAR, o una sesión de
 * acciones cuya última fecha todavía no tiene barra RTH.
 *
 * Lanza error si bar.time no es estrictamente creciente. Un tiempo en
 * milisegundos también lanza error a través de sessions.ts.
 */
export function resolveAnchorIndex(
  bars: readonly Bar[],
  anchor: AvwapAnchor,
  options: AvwapOptions,
): number {
  assertMarket(options.market);

  if (bars.length === 0) {
    return -1;
  }

  const visibleStart = options.visibleStart ?? 0;
  if (
    !Number.isInteger(visibleStart) ||
    visibleStart < 0 ||
    visibleStart >= bars.length
  ) {
    return -1;
  }

  switch (anchor) {
    case 'SESSION':
      return resolveSessionAnchorIndex(bars, options.market);
    case 'WEEK':
    case 'MONTH':
    case 'YTD':
      return resolvePeriodAnchorIndex(bars, anchor, options.market);
    case 'HIGH_VOLUME_BAR': {
      validateTimesThroughSessions(bars, options.market);
      return findHighVolumeBarIndex(bars, visibleStart);
    }
    case 'FULL_HISTORY': {
      validateTimesThroughSessions(bars, options.market);
      return visibleStart;
    }
    default:
      throw new Error(`Unsupported AVWAP anchor: ${String(anchor)}`);
  }
}

function getHlc3(bar: Bar): number {
  return (bar.high + bar.low + bar.close) / 3;
}

function makePoint(time: number, output: WelfordOutput): AvwapPoint {
  const { vwap, stdDev, cumVolume } = output;
  const twiceStdDev = 2 * stdDev;
  const twicePointFiveStdDev = 2.5 * stdDev;

  return {
    time,
    vwap,
    stdDev,
    cumVolume,
    upper1: vwap + stdDev,
    lower1: vwap - stdDev,
    upper2: vwap + twiceStdDev,
    lower2: vwap - twiceStdDev,
    upper2_5: vwap + twicePointFiveStdDev,
    lower2_5: vwap - twicePointFiveStdDev,
  };
}

/**
 * Acumula una barra cerrada.
 *
 * Si todavía no hay volumen acumulado devuelve point = null. Una vez que
 * cumVolume > 0, toda barra produce un punto; si la barra es ignorada por
 * Welford, el punto repite el último valor.
 */
export function updateAvwap(state: AvwapState, bar: Bar): AvwapStep {
  const step = updateWelford(state.welford, getHlc3(bar), bar.volume);
  const nextState: AvwapState = { welford: step.state };

  if (step.output.cumVolume <= 0) {
    return { state: nextState, point: null };
  }

  return {
    state: nextState,
    point: makePoint(bar.time, step.output),
  };
}

function isValidAnchorIndex(
  bars: readonly Bar[],
  anchorIndex: number,
): boolean {
  return (
    Number.isInteger(anchorIndex) &&
    anchorIndex >= 0 &&
    anchorIndex < bars.length
  );
}

interface Calculation {
  readonly points: AvwapPoint[];
  readonly state: AvwapState;
}

function calculateFromAnchor(
  bars: readonly Bar[],
  anchorIndex: number,
): Calculation {
  const points: AvwapPoint[] = [];
  let state = createInitialAvwapState();

  for (let index = anchorIndex; index < bars.length; index++) {
    const bar = bars[index];
    if (bar === undefined) {
      throw new Error(`Bar at index ${index.toString()} is undefined`);
    }
    const step = updateAvwap(state, bar);
    state = step.state;
    if (step.point !== null) {
      points.push(step.point);
    }
  }

  return { points, state };
}

/**
 * Calcula el AVWAP desde anchorIndex hasta el final del array.
 * Un ancla inválida (no entera, < 0 o >= largo) devuelve [].
 */
export function calculateAnchoredVwap(
  bars: readonly Bar[],
  anchorIndex: number,
): AvwapPoint[] {
  if (!isValidAnchorIndex(bars, anchorIndex)) {
    return [];
  }
  return calculateFromAnchor(bars, anchorIndex).points;
}

/**
 * Resuelve el ancla y calcula el AVWAP anclado en una sola llamada.
 */
export function computeAnchoredVwap(
  bars: readonly Bar[],
  anchor: AvwapAnchor,
  options: AvwapOptions,
): AnchoredVwapResult {
  const anchorIndex = resolveAnchorIndex(bars, anchor, options);

  if (!isValidAnchorIndex(bars, anchorIndex)) {
    return {
      anchorIndex,
      points: [],
      state: createInitialAvwapState(),
    };
  }

  const calculation = calculateFromAnchor(bars, anchorIndex);
  return {
    anchorIndex,
    points: calculation.points,
    state: calculation.state,
  };
}

/**
 * Proyecta el AVWAP de una vela en formación sobre el estado de barras
 * cerradas. El estado nuevo se descarta.
 *
 * IMPORTANTE: cada tick debe proyectarse SIEMPRE desde el mismo `closedState`
 * (las barras cerradas hasta t-1). No se debe encadenar el estado devuelto por
 * una proyección como entrada de la siguiente: eso acumularía la misma vela en
 * formación tantas veces como ticks. `formingBar` trae el volumen y el HLC3
 * acumulados de la vela en formación.
 *
 * Los reinicios de periodo en vivo (cambio de sesión, semana, mes o año) no se
 * resuelven aquí; quedan fuera de esta pieza y los decide el motor.
 */
export function projectLiveAvwap(
  closedState: AvwapState,
  formingBar: Bar,
): AvwapPoint | null {
  return updateAvwap(closedState, formingBar).point;
}
