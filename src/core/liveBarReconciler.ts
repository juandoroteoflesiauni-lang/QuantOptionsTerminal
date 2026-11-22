/**
 * Pieza 50.8 (Bloque B1) — reductor determinista de eventos live para las velas
 * 1D/1W del gráfico panorámico.
 *
 * Evidencia de origen (Paso 0):
 *  - `bar_update` (cluster `stocks`, canal US) transporta `formingBar` = snapshot
 *    completo del minuto 1m en curso (OHLC + volumen = suma de trades del minuto,
 *    reemplazado en cada trade) y `lastClosedBar` = último 1m cerrado.
 *  - El minuto se identifica por `formingBar.time`, no por el `time` del evento.
 *  - La historia diaria US es la barra oficial RTH (FMP EOD/Tradier daily con
 *    etiqueta 00:00 ET); por eso 1D/1W solo aceptan minutos RTH.
 *  - El volumen de un minuto no puede decrecer; high/low solo se expanden: una
 *    revisión del mismo minuto exige progreso demostrable (`volume` mayor).
 *  - AR usa identidad BYMA calificada (`AR:ticker:settlement`): nunca consume el
 *    canal US ni suma volumen histórico con solapamiento desconocido.
 *
 * Reglas: snapshots de minutos nuevos suman volumen una sola vez; el primer
 * minuto observado (re)conexión establece la línea base y no suma; mismo minuto
 * con volumen mayor reemplaza; duplicado/atrasado/retroceso se descarta. El
 * volumen histórico se conserva (solapamiento desconocido). Funciones puras.
 */

import { isRth } from './sessions.js';
import {
  resolveLivePeriodIdentity,
  type LiveCalendarProjection,
  type LiveChartBar,
} from './realtimePropagation.js';

export interface LiveMinuteSnapshot {
  readonly timeSec: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface LiveFrameState {
  /** OHLC vigente de la vela del marco; `timeSec`/`open` se preservan. */
  readonly bar: LiveChartBar;
  /** Volumen histórico conservado (solapamiento con lo live desconocido). */
  readonly baseVolume: number;
  readonly lastMinuteTimeSec: number | null;
  readonly lastMinuteVolume: number;
  /** Primer minuto observado tras (re)conexión: nunca suma volumen. */
  readonly baselineMinuteTimeSec: number | null;
  readonly closedMinutesVolume: number;
  readonly currentMinuteVolume: number;
  readonly lastSnapshot: LiveMinuteSnapshot | null;
}

export type LiveReduceOutcome =
  | 'accepted'
  | 'revision'
  | 'duplicate'
  | 'stale'
  | 'out-of-session'
  | 'deferred';

export interface LiveReduceResult {
  readonly state: LiveFrameState;
  readonly outcome: LiveReduceOutcome;
}

export function createLiveFrameState(bar: LiveChartBar): LiveFrameState {
  return {
    bar,
    baseVolume: bar.volume,
    lastMinuteTimeSec: null,
    lastMinuteVolume: 0,
    baselineMinuteTimeSec: null,
    closedMinutesVolume: 0,
    currentMinuteVolume: 0,
    lastSnapshot: null,
  };
}

export function liveFrameVolume(state: LiveFrameState): number {
  return state.baseVolume + state.closedMinutesVolume + state.currentMinuteVolume;
}

function isValidSnapshot(snapshot: LiveMinuteSnapshot): boolean {
  return (
    Number.isInteger(snapshot.timeSec) &&
    snapshot.timeSec >= 0 &&
    Number.isFinite(snapshot.open) &&
    snapshot.open > 0 &&
    Number.isFinite(snapshot.high) &&
    snapshot.high >= snapshot.low &&
    Number.isFinite(snapshot.low) &&
    snapshot.low > 0 &&
    Number.isFinite(snapshot.close) &&
    snapshot.close > 0 &&
    Number.isFinite(snapshot.volume) &&
    snapshot.volume >= 0
  );
}

function withBar(
  state: LiveFrameState,
  bar: LiveChartBar,
  patch: Partial<Pick<LiveFrameState, 'lastMinuteTimeSec' | 'lastMinuteVolume' | 'baselineMinuteTimeSec' | 'closedMinutesVolume' | 'currentMinuteVolume' | 'lastSnapshot'>>,
): LiveFrameState {
  return { ...state, bar, ...patch };
}

function sameSnapshot(a: LiveMinuteSnapshot, b: LiveMinuteSnapshot): boolean {
  return (
    a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close && a.volume === b.volume
  );
}

/**
 * Reduce un snapshot de minuto (US) sobre el estado del marco. Devuelve el nuevo
 * estado y el desenlace; nunca muta la entrada.
 */
export function reduceMinuteSnapshot(
  state: LiveFrameState,
  snapshot: LiveMinuteSnapshot,
  calendar: LiveCalendarProjection,
): LiveReduceResult {
  if (calendar.market !== 'US') {
    // AR jamás consume el canal US por coincidencia de símbolo.
    return { state, outcome: 'deferred' };
  }
  if (!isValidSnapshot(snapshot)) {
    return { state, outcome: 'stale' };
  }
  if (!isRth(snapshot.timeSec)) {
    // La historia diaria US es la barra oficial RTH: pre/after no la contaminan.
    return { state, outcome: 'out-of-session' };
  }
  const eventIdentity = resolveLivePeriodIdentity(snapshot.timeSec, calendar);
  const barIdentity = resolveLivePeriodIdentity(state.bar.timeSec, calendar);
  if (eventIdentity === null || barIdentity === null) {
    return { state, outcome: 'stale' };
  }
  if (eventIdentity.key < barIdentity.key) {
    return { state, outcome: 'stale' };
  }

  const lastMinute = state.lastMinuteTimeSec;
  if (lastMinute !== null && snapshot.timeSec < lastMinute) {
    // Evento atrasado: no revierte cierre ni extremos vigentes.
    return { state, outcome: 'stale' };
  }
  if (lastMinute !== null && snapshot.timeSec === lastMinute) {
    if (snapshot.volume < state.lastMinuteVolume) {
      return { state, outcome: 'stale' };
    }
    const previous = state.lastSnapshot;
    if (
      snapshot.volume === state.lastMinuteVolume &&
      (previous === null || sameSnapshot(previous, snapshot))
    ) {
      return { state, outcome: 'duplicate' };
    }
    if (snapshot.volume === state.lastMinuteVolume) {
      // Mismo volumen y OHLC distinto: sin progreso demostrable no se acepta.
      return { state, outcome: 'duplicate' };
    }
    const currentMinuteVolume =
      snapshot.timeSec === state.baselineMinuteTimeSec ? 0 : snapshot.volume;
    const shaped = samePeriodBar(state.bar, snapshot);
    const bar: LiveChartBar = {
      ...shaped,
      volume: state.baseVolume + state.closedMinutesVolume + currentMinuteVolume,
    };
    return {
      state: withBar(state, bar, {
        lastMinuteVolume: snapshot.volume,
        currentMinuteVolume,
        lastSnapshot: snapshot,
      }),
      outcome: 'revision',
    };
  }

  // Minuto nuevo (timeSec > lastMinute o primera observación).
  const isFirstObservation = lastMinute === null;
  const closesBaselineMinute =
    isFirstObservation
      ? false
      : lastMinute !== state.baselineMinuteTimeSec;
  const closedMinutesVolume =
    state.closedMinutesVolume + (closesBaselineMinute ? state.lastMinuteVolume : 0);
  const baselineMinuteTimeSec = isFirstObservation
    ? snapshot.timeSec
    : state.baselineMinuteTimeSec;
  const currentMinuteVolume =
    isFirstObservation || snapshot.timeSec === baselineMinuteTimeSec ? 0 : snapshot.volume;

  if (eventIdentity.key > barIdentity.key) {
    const openingTimeSec = resolveNextPeriodOpening(snapshot.timeSec, calendar, eventIdentity.key);
    if (openingTimeSec === null) {
      // Sin etiqueta acreditable se espera una barra válida de la fuente.
      return { state, outcome: 'deferred' };
    }
    const bar: LiveChartBar = {
      timeSec: openingTimeSec,
      open: snapshot.open,
      high: snapshot.high,
      low: snapshot.low,
      close: snapshot.close,
      volume: currentMinuteVolume,
    };
    return {
      state: {
        bar,
        baseVolume: 0,
        lastMinuteTimeSec: snapshot.timeSec,
        lastMinuteVolume: snapshot.volume,
        baselineMinuteTimeSec: snapshot.timeSec,
        closedMinutesVolume: 0,
        currentMinuteVolume: 0,
        lastSnapshot: snapshot,
      },
      outcome: 'accepted',
    };
  }

  const shaped = samePeriodBar(state.bar, snapshot);
  const bar: LiveChartBar = {
    ...shaped,
    volume: state.baseVolume + closedMinutesVolume + currentMinuteVolume,
  };
  return {
    state: withBar(state, bar, {
      lastMinuteTimeSec: snapshot.timeSec,
      lastMinuteVolume: snapshot.volume,
      baselineMinuteTimeSec,
      closedMinutesVolume,
      currentMinuteVolume,
      lastSnapshot: snapshot,
    }),
    outcome: 'accepted',
  };
}

function samePeriodBar(bar: LiveChartBar, snapshot: LiveMinuteSnapshot): LiveChartBar {
  return {
    timeSec: bar.timeSec,
    open: bar.open,
    high: Math.max(bar.high, snapshot.high),
    low: Math.min(bar.low, snapshot.low),
    close: snapshot.close,
    volume: bar.volume,
  };
}

function resolveNextPeriodOpening(
  snapshotTimeSec: number,
  calendar: LiveCalendarProjection,
  eventKey: string,
): number | null {
  const provided = calendar.nextPeriodOpeningTimeSec;
  if (provided !== null && provided !== undefined) {
    const providedIdentity = resolveLivePeriodIdentity(provided, calendar);
    return providedIdentity !== null && providedIdentity.key === eventKey ? provided : null;
  }
  if (calendar.market === 'US' && calendar.timeframe === '1D') {
    const identity = resolveLivePeriodIdentity(snapshotTimeSec, calendar);
    return identity?.openingTimeSec ?? null;
  }
  return null;
}

/**
 * Reduce un tick de cotización acumulada sobre la vela del marco:
 *  - US 1D/1W: el contador de quote se excluye de esta ruta (snapshots
 *    autoritativos por minuto); devuelve `deferred`.
 *  - AR: identidad BYMA calificada; actualiza precio sin sumar volumen
 *    (solapamiento desconocido) y espera barra fuente para abrir rueda.
 */
export function reduceQuoteTick(
  state: LiveFrameState,
  tick: { readonly price: number; readonly timeSec: number },
  calendar: LiveCalendarProjection,
): LiveReduceResult {
  if (!Number.isFinite(tick.price) || tick.price <= 0 || !Number.isFinite(tick.timeSec)) {
    return { state, outcome: 'stale' };
  }
  if (calendar.market === 'US') {
    return { state, outcome: 'deferred' };
  }
  const tickIdentity = resolveLivePeriodIdentity(Math.floor(tick.timeSec), calendar);
  const barIdentity = resolveLivePeriodIdentity(state.bar.timeSec, calendar);
  if (tickIdentity === null || barIdentity === null) {
    return { state, outcome: 'stale' };
  }
  if (tickIdentity.key < barIdentity.key) {
    return { state, outcome: 'stale' };
  }
  if (tickIdentity.key > barIdentity.key) {
    // Rueda nueva sin OHLCV acreditado: se espera una barra válida.
    return { state, outcome: 'deferred' };
  }
  const bar: LiveChartBar = {
    timeSec: state.bar.timeSec,
    open: state.bar.open,
    high: Math.max(state.bar.high, tick.price),
    low: Math.min(state.bar.low, tick.price),
    close: tick.price,
    volume: liveFrameVolume(state),
  };
  return { state: withBar(state, bar, {}), outcome: 'accepted' };
}
