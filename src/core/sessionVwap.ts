/**
 * VWAP de sesión (SPEC punto 4).
 *
 * Reglas principales:
 *  - La barra representa su instante de apertura; `bar.time` son segundos UTC.
 *  - EQUITY acumula solo dentro de RTH (09:30 <= t < 16:00 ET, lunes a viernes).
 *    Fuera de RTH no acumula: emite el último valor de la sesión con frozen=true.
 *  - CRYPTO acumula todas las barras y reinicia a las 00:00 UTC; nunca congela.
 *  - La fuente de precio por defecto es TRADE_VWAP para EQUITY y HLC3 para CRYPTO.
 *  - TRADE_VWAP usa `bar.vw` si es finito y > 0. Si falta, es 0 o no es finito,
 *    usa (H+L+C)/3 SOLO para esa barra y marca source='HLC3'. Este respaldo es
 *    el único permitido por el SPEC (punto 4); no es un valor de relleno que
 *    oculte un dato no calculable.
 *
 * Todas las funciones son puras: no mutan el estado ni las barras de entrada.
 */

import {
  createInitialWelfordState,
  updateWelford,
  type WelfordState,
} from './welford.js';
import {
  getMarketParts,
  isRthFromParts,
  type Market,
  type MarketParts,
} from './sessions.js';
import type { Bar } from './types.js';

export type SessionVwapPriceSource = 'TRADE_VWAP' | 'HLC3';

/** Fuente realmente usada para el precio de una barra. */
export type SessionVwapSource = 'VW' | 'HLC3' | 'NONE';

export interface SessionVwapOptions {
  readonly market: Market;
  readonly barSeconds: number;
  readonly priceSource?: SessionVwapPriceSource;
}

export interface SessionVwapLast {
  readonly vwap: number;
  readonly cumVolume: number;
}

export interface SessionVwapState {
  readonly welford: WelfordState;
  readonly sessionKey: string | null;
  readonly lastTime: number | null;
  readonly last: SessionVwapLast | null;
}

export interface SessionVwapPoint {
  readonly time: number;
  readonly vwap: number;
  readonly cumVolume: number;
  readonly frozen: boolean;
  readonly source: SessionVwapSource;
}

export interface SessionVwapStep {
  readonly state: SessionVwapState;
  readonly point: SessionVwapPoint;
}

export interface SessionVwapSeries {
  readonly points: readonly SessionVwapPoint[];
  readonly state: SessionVwapState;
}

export const INITIAL_SESSION_VWAP_STATE: SessionVwapState = Object.freeze({
  welford: createInitialWelfordState(),
  sessionKey: null,
  lastTime: null,
  last: null,
});

export function createInitialSessionVwapState(): SessionVwapState {
  return INITIAL_SESSION_VWAP_STATE;
}

/**
 * Valida las opciones comunes. En EQUITY, `barSeconds` debe dividir 1800 para
 * que 09:30 y 16:00 coincidan con límites de barra (SPEC punto 8).
 */
function validateOptions(options: SessionVwapOptions): void {
  const market: string = options.market;
  if (market !== 'EQUITY' && market !== 'CRYPTO') {
    throw new Error(`Unsupported market: ${market}`);
  }

  if (!Number.isInteger(options.barSeconds) || options.barSeconds <= 0) {
    throw new Error(
      `barSeconds must be a positive integer (got ${String(options.barSeconds)})`,
    );
  }

  if (options.market === 'EQUITY' && 1800 % options.barSeconds !== 0) {
    throw new Error(
      `EQUITY session VWAP requires barSeconds to divide 1800 (got ${String(options.barSeconds)})`,
    );
  }

  const priceSource: string | undefined = options.priceSource;
  if (
    priceSource !== undefined &&
    priceSource !== 'TRADE_VWAP' &&
    priceSource !== 'HLC3'
  ) {
    throw new Error(`Unsupported priceSource: ${priceSource}`);
  }
}

function resolvePriceSource(
  options: SessionVwapOptions,
): SessionVwapPriceSource {
  if (options.priceSource !== undefined) {
    return options.priceSource;
  }
  return options.market === 'EQUITY' ? 'TRADE_VWAP' : 'HLC3';
}

function assertIncreasingTime(lastTime: number | null, time: number): void {
  if (lastTime !== null && time <= lastTime) {
    throw new Error(
      `bar.time must increase strictly (previous ${String(lastTime)}, got ${String(time)})`,
    );
  }
}

interface BarPrice {
  readonly price: number;
  readonly source: 'VW' | 'HLC3';
}

/**
 * Calcula el precio de una barra según la fuente configurada.
 *
 * El respaldo a HLC3 cuando el vw no sirve está prescrito por el SPEC punto 4.
 */
function getBarPrice(
  bar: Bar,
  priceSource: SessionVwapPriceSource,
): BarPrice {
  if (priceSource === 'TRADE_VWAP') {
    const vw = bar.vw;
    if (vw !== undefined && Number.isFinite(vw) && vw > 0) {
      return { price: vw, source: 'VW' };
    }
  }

  return {
    price: (bar.high + bar.low + bar.close) / 3,
    source: 'HLC3',
  };
}

function makeLast(cumVolume: number, vwap: number): SessionVwapLast | null {
  if (cumVolume > 0) {
    return { vwap, cumVolume };
  }
  return null;
}

function updateEquity(
  state: SessionVwapState,
  bar: Bar,
  priceSource: SessionVwapPriceSource,
  parts: MarketParts,
): SessionVwapStep {
  assertIncreasingTime(state.lastTime, bar.time);

  if (!isRthFromParts(parts)) {
    const last = state.last;
    return {
      state: {
        welford: state.welford,
        sessionKey: state.sessionKey,
        lastTime: bar.time,
        last,
      },
      point: {
        time: bar.time,
        vwap: last === null ? Number.NaN : last.vwap,
        cumVolume: last === null ? 0 : last.cumVolume,
        frozen: true,
        source: 'NONE',
      },
    };
  }

  const isNewSession = parts.dateKey !== state.sessionKey;
  const welford = isNewSession
    ? createInitialWelfordState()
    : state.welford;

  const barPrice = getBarPrice(bar, priceSource);
  const welfordStep = updateWelford(welford, barPrice.price, bar.volume);
  const cumVolume = welfordStep.output.cumVolume;
  const vwap =
    cumVolume > 0 ? welfordStep.output.vwap : Number.NaN;
  const last = makeLast(cumVolume, vwap);

  return {
    state: {
      welford: welfordStep.state,
      sessionKey: parts.dateKey,
      lastTime: bar.time,
      last,
    },
    point: {
      time: bar.time,
      vwap,
      cumVolume,
      frozen: false,
      source: barPrice.source,
    },
  };
}

function updateCrypto(
  state: SessionVwapState,
  bar: Bar,
  priceSource: SessionVwapPriceSource,
  parts: MarketParts,
): SessionVwapStep {
  assertIncreasingTime(state.lastTime, bar.time);

  const isNewSession = parts.dateKey !== state.sessionKey;
  const welford = isNewSession
    ? createInitialWelfordState()
    : state.welford;

  const barPrice = getBarPrice(bar, priceSource);
  const welfordStep = updateWelford(welford, barPrice.price, bar.volume);
  const cumVolume = welfordStep.output.cumVolume;
  const vwap =
    cumVolume > 0 ? welfordStep.output.vwap : Number.NaN;
  const last = makeLast(cumVolume, vwap);

  return {
    state: {
      welford: welfordStep.state,
      sessionKey: parts.dateKey,
      lastTime: bar.time,
      last,
    },
    point: {
      time: bar.time,
      vwap,
      cumVolume,
      frozen: false,
      source: barPrice.source,
    },
  };
}

/**
 * Actualiza el VWAP de sesión con una barra cerrada.
 *
 * La barra debe llegar en orden estricto de tiempo; un tiempo repetido o
 * anterior lanza error porque el reinicio de sesión depende de ese orden.
 * `getMarketParts` valida además que el tiempo sea un entero de segundos
 * (un instante en milisegundos lanza error).
 */
export function updateSessionVwap(
  state: SessionVwapState,
  bar: Bar,
  options: SessionVwapOptions,
): SessionVwapStep {
  validateOptions(options);
  const priceSource = resolvePriceSource(options);

  if (options.market === 'EQUITY') {
    const parts = getMarketParts(bar.time, 'EQUITY');
    return updateEquity(state, bar, priceSource, parts);
  }

  const parts = getMarketParts(bar.time, 'CRYPTO');
  return updateCrypto(state, bar, priceSource, parts);
}

/**
 * Procesa una serie completa de barras cerradas.
 *
 * Devuelve todos los puntos y el estado final. `barSeconds` se valida siempre,
 * aunque la serie esté vacía.
 */
export function computeSessionVwap(
  bars: readonly Bar[],
  options: SessionVwapOptions,
): SessionVwapSeries {
  validateOptions(options);

  const points: SessionVwapPoint[] = [];
  let state = createInitialSessionVwapState();

  for (const bar of bars) {
    const step = updateSessionVwap(state, bar, options);
    state = step.state;
    points.push(step.point);
  }

  return { points, state };
}

/**
 * Proyecta el VWAP de una vela en formación sobre el estado de barras cerradas.
 *
 * IMPORTANTE: cada tick debe proyectarse SIEMPRE desde el mismo `closedState`
 * (las barras cerradas hasta t-1). No se debe encadenar el estado devuelto por
 * una proyección como entrada de la siguiente: eso acumularía la misma vela en
 * formación tantas veces como ticks. `formingBar` trae el volumen y el vw
 * acumulados de la vela en formación; el estado nuevo se descarta.
 */
export function projectLiveSessionVwap(
  closedState: SessionVwapState,
  formingBar: Bar,
  options: SessionVwapOptions,
): SessionVwapPoint {
  return updateSessionVwap(closedState, formingBar, options).point;
}
