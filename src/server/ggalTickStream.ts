/**
 * Motor de streaming tick-by-tick para GGAL (Pieza 39): ADR (NASDAQ), Pesos
 * (BYMA) y CCL implícito (`ARS * GGAL_ADR_RATIO / ADR`).
 *
 * Contrato (Zero Silent Fallbacks):
 * - ADR: consume el consolidador 1m de Massive WS (`T`/`A`/`AM`, con dedupe
 *   T-vs-A ya resuelto en `ingestWsEvents`); cada minuto contribuyente se
 *   UPSERTEA en su bucket de timeframe y la vela abierta se reconstruye de
 *   forma idempotente (sin doble conteo de volumen).
 * - ARS/CCL: mutación directa por tick (trade BMB/IOL) sobre la vela abierta.
 * - Los estados persistentes de indicadores (EMA 9/21/50/200, VWAP de sesión
 *   y AVWAP anclado) acumulan SOLO barras cerradas: cada tick proyecta el
 *   último punto sin mutar el estado; la vela abierta se pliega al cerrar su
 *   bucket (EMA en vivo = alpha·precio + (1-alpha)·EMA_cerrada, SPEC punto 2).
 * - VWAP de sesión: TRADE_VWAP (`sum(p·v)/sum(v)`); al cerrar el bucket
 *   contribuye el vwap del bucket (o HLC3 si no hubo volumen). Ventana:
 *   RTH 09:30–16:00 ET para ADR; 11:00–17:00 ART para ARS/CCL; reinicio diario.
 * - AVWAP anclado: réplica exacta de `computeAnchoredVwapSeries`
 *   (`core/ggal/technicalIndicators.ts`): HLC3 con volumen Welford
 *   (m2/cumVol) desde el ancla; barras sin volumen no acumulan.
 * - Precio no finito o <= 0 no muta estado; NaN se propaga como null
 *   (la UI muestra "—"). Sin datos simulados.
 */

import { calculateEma } from '../core/ema.js';
import { getBuenosAiresParts, GGAL_ADR_RATIO } from '../core/ggal/types.js';
import { getMarketParts } from '../core/sessions.js';

export type GgalTickMode = 'ADR' | 'ARS' | 'CCL';
export type GgalTickTimeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1D';

export const GGAL_TICK_TIMEFRAMES: readonly GgalTickTimeframe[] = [
  '1m',
  '5m',
  '15m',
  '1h',
  '4h',
  '1D',
];

const GGAL_TICK_TIMEFRAME_SECONDS: Readonly<Record<GgalTickTimeframe, number>> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3_600,
  '4h': 14_400,
  '1D': 86_400,
};

/** Mínimo entre emisiones por (modo, timeframe) salvo cambio de bucket. */
export const GGAL_TICK_MIN_EMIT_INTERVAL_MS = 200;

export interface GgalTickBar {
  readonly timeSec: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface GgalTickMinuteBar {
  readonly timeSec: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly vw?: number;
}

export interface GgalTickIndicatorPoint {
  readonly timeSec: number;
  readonly ema9: number | null;
  readonly ema21: number | null;
  readonly ema50: number | null;
  readonly ema200: number | null;
  readonly sessionVwap: number | null;
  readonly avwap: number | null;
  readonly avwapPlus1Sigma: number | null;
  readonly avwapMinus1Sigma: number | null;
}

export interface GgalBarTickEvent {
  readonly type: 'ggal_bar_tick';
  readonly symbol: 'GGAL';
  readonly mode: GgalTickMode;
  readonly timeframe: GgalTickTimeframe;
  readonly bar: GgalTickBar;
  readonly indicatorsPoint: GgalTickIndicatorPoint;
  readonly serverTimeSec: number;
}

export type GgalBarTickEmit = (event: GgalBarTickEvent) => void;

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** Redondeo del timestamp al bucket de la vela (alineado a 00:00 UTC para 1D/4h). */
export function ggalTickBucketStartSec(timeSec: number, timeframe: GgalTickTimeframe): number {
  if (!Number.isInteger(timeSec) || timeSec <= 0) {
    return Number.NaN;
  }
  const seconds = GGAL_TICK_TIMEFRAME_SECONDS[timeframe];
  return Math.floor(timeSec / seconds) * seconds;
}

/** CCL implícito: `ARS * ratio / ADR` (ratio por defecto GGAL_ADR_RATIO = 10). */
export function deriveGgalCclPrice(
  arsPrice: number,
  adrPrice: number,
  ratio: number = GGAL_ADR_RATIO,
): number {
  if (!finitePositive(arsPrice) || !finitePositive(adrPrice) || !finitePositive(ratio)) {
    return Number.NaN;
  }
  return (arsPrice * ratio) / adrPrice;
}

/** Mutación pura de vela por tick directo: alta del bucket o actualización OHLCV. */
export function applyGgalTickToBar(
  bar: GgalTickBar | null,
  bucketStartSec: number,
  price: number,
  size: number,
): GgalTickBar {
  if (!Number.isInteger(bucketStartSec) || bucketStartSec <= 0 || !finitePositive(price)) {
    return (
      bar ?? {
        timeSec: Number.NaN,
        open: Number.NaN,
        high: Number.NaN,
        low: Number.NaN,
        close: Number.NaN,
        volume: 0,
      }
    );
  }
  const volume = Number.isFinite(size) && size > 0 ? size : 0;
  if (bar === null || bucketStartSec > bar.timeSec) {
    return { timeSec: bucketStartSec, open: price, high: price, low: price, close: price, volume };
  }
  return {
    timeSec: bar.timeSec,
    open: bar.open,
    high: Math.max(bar.high, price),
    low: Math.min(bar.low, price),
    close: price,
    volume: bar.volume + volume,
  };
}

interface AvwapAccState {
  readonly anchorSec: number;
  readonly cumPv: number;
  readonly cumVol: number;
  readonly mean: number;
  readonly m2: number;
}

/**
 * Acumulación AVWAP idéntica a `computeAnchoredVwapSeries`: Welford sobre HLC3
 * ponderado por volumen, sin mutar el estado de entrada.
 */
export function applyAvwapAccumulation(
  state: AvwapAccState | null,
  typicalPrice: number,
  volume: number,
): AvwapAccState | null {
  if (!Number.isFinite(typicalPrice) || !Number.isFinite(volume) || volume <= 0) {
    return state;
  }
  if (state === null || state.cumVol <= 0) {
    return {
      anchorSec: state?.anchorSec ?? 0,
      cumPv: typicalPrice * volume,
      cumVol: volume,
      mean: typicalPrice,
      m2: 0,
    };
  }
  const nextCumVol = state.cumVol + volume;
  const delta = typicalPrice - state.mean;
  const nextMean = state.mean + (volume / nextCumVol) * delta;
  const delta2 = typicalPrice - nextMean;
  return {
    anchorSec: state.anchorSec,
    cumPv: state.cumPv + typicalPrice * volume,
    cumVol: nextCumVol,
    mean: nextMean,
    m2: state.m2 + volume * delta * delta2,
  };
}

export function avwapPointFromState(
  state: AvwapAccState | null,
): {
  readonly avwap: number | null;
  readonly plus1Sigma: number | null;
  readonly minus1Sigma: number | null;
} {
  if (state === null || state.cumVol <= 0) {
    return { avwap: null, plus1Sigma: null, minus1Sigma: null };
  }
  const avwap = state.cumPv / state.cumVol;
  const variance = Math.max(0, state.m2 / state.cumVol);
  const sigma = Math.sqrt(variance);
  if (!Number.isFinite(avwap) || !Number.isFinite(sigma)) {
    return { avwap: null, plus1Sigma: null, minus1Sigma: null };
  }
  return { avwap, plus1Sigma: avwap + sigma, minus1Sigma: avwap - sigma };
}

/** Ventana de sesión por modo: RTH ET para ADR; 11:00–17:00 ART para ARS/CCL. */
export function isGgalTickInSession(timeSec: number, mode: GgalTickMode): boolean {
  if (!Number.isInteger(timeSec) || timeSec <= 0) {
    return false;
  }
  if (mode === 'ADR') {
    const parts = getMarketParts(timeSec, 'EQUITY');
    const minutes = parts.minutesOfDay;
    return parts.weekday >= 1 && parts.weekday <= 5 && 9 * 60 + 30 <= minutes && minutes < 16 * 60;
  }
  const parts = getBuenosAiresParts(timeSec);
  return (
    parts.weekday >= 1 &&
    parts.weekday <= 5 &&
    parts.minutesOfDay >= 11 * 60 &&
    parts.minutesOfDay < 17 * 60
  );
}

function utcDayKey(timeSec: number): string {
  return new Date(timeSec * 1_000).toISOString().slice(0, 10);
}

function typicalPriceOf(bar: GgalTickBar): number {
  return (bar.high + bar.low + bar.close) / 3;
}

interface EmaClosedState {
  readonly period: 9 | 21 | 50 | 200;
  value: number | null;
}

interface TfSideState {
  /** Minutos 1m contribuyentes del bucket abierto (upsert idempotente). */
  contributingMinutes: Map<number, GgalTickMinuteBar>;
  openBar: GgalTickBar | null;
  /** VWAP de sesión de buckets cerrados de la sesión actual (TRADE_VWAP). */
  closedSessionPv: number;
  closedSessionVolume: number;
  closedSessionDayKey: string | null;
  /** Sumas vivas del bucket abierto (derivadas de contributingMinutes). */
  formingPv: number;
  formingVolume: number;
  /** EMA de barras cerradas. */
  ema: Record<9 | 21 | 50 | 200, EmaClosedState>;
  avwap: AvwapAccState | null;
  lastEmitAtMs: number | null;
}

interface ModeSideState {
  lastPrice: number | null;
  lastTickTimeSec: number | null;
  perTimeframe: Map<GgalTickTimeframe, TfSideState>;
  /** Dedupe de minutos consolidados ADR: firma por `timeSec`. */
  minuteSignatures: Map<number, string>;
  lastFedMinuteSec: number | null;
}

function newTfSideState(): TfSideState {
  return {
    contributingMinutes: new Map(),
    openBar: null,
    closedSessionPv: 0,
    closedSessionVolume: 0,
    closedSessionDayKey: null,
    formingPv: 0,
    formingVolume: 0,
    ema: {
      9: { period: 9, value: null },
      21: { period: 21, value: null },
      50: { period: 50, value: null },
      200: { period: 200, value: null },
    },
    avwap: null,
    lastEmitAtMs: null,
  };
}

export interface GgalTickStreamEngineDeps {
  readonly nowMsFn?: () => number;
  readonly emit?: GgalBarTickEmit;
  readonly ratio?: number;
  readonly minEmitIntervalMs?: number;
}

const EMA_ALPHA: Readonly<Record<9 | 21 | 50 | 200, number>> = {
  9: 2 / 10,
  21: 2 / 22,
  50: 2 / 51,
  200: 2 / 201,
};

export class GgalTickStreamEngine {
  private readonly nowMsFn: () => number;
  private readonly emitFn: GgalBarTickEmit | null;
  private readonly ratio: number;
  private readonly minEmitIntervalMs: number;
  private readonly sides: Record<GgalTickMode, ModeSideState> = {
    ADR: { lastPrice: null, lastTickTimeSec: null, perTimeframe: new Map(), minuteSignatures: new Map(), lastFedMinuteSec: null },
    ARS: { lastPrice: null, lastTickTimeSec: null, perTimeframe: new Map(), minuteSignatures: new Map(), lastFedMinuteSec: null },
    CCL: { lastPrice: null, lastTickTimeSec: null, perTimeframe: new Map(), minuteSignatures: new Map(), lastFedMinuteSec: null },
  };
  private readonly avwapAnchors = new Map<string, number>();

  public constructor(deps: GgalTickStreamEngineDeps = {}) {
    this.nowMsFn = deps.nowMsFn ?? (() => Date.now());
    this.emitFn = deps.emit ?? null;
    this.ratio = deps.ratio ?? GGAL_ADR_RATIO;
    this.minEmitIntervalMs = deps.minEmitIntervalMs ?? GGAL_TICK_MIN_EMIT_INTERVAL_MS;
  }

  /** Ancla AVWAP resuelta por la carga de historial (por modo+timeframe). */
  public setAvwapAnchor(mode: GgalTickMode, timeframe: GgalTickTimeframe, anchorSec: number | null): void {
    const key = `${mode}:${timeframe}`;
    if (anchorSec === null || !Number.isInteger(anchorSec) || anchorSec <= 0) {
      this.avwapAnchors.delete(key);
      const state = this.sides[mode].perTimeframe.get(timeframe);
      if (state !== undefined) {
        state.avwap = null;
      }
      return;
    }
    this.avwapAnchors.set(key, anchorSec);
    const state = this.sides[mode].perTimeframe.get(timeframe);
    if (state !== undefined) {
      state.avwap = { anchorSec, cumPv: 0, cumVol: 0, mean: 0, m2: 0 };
    }
  }

  private tfState(mode: GgalTickMode, timeframe: GgalTickTimeframe): TfSideState {
    const side = this.sides[mode];
    const existing = side.perTimeframe.get(timeframe);
    if (existing !== undefined) {
      return existing;
    }
    const created = newTfSideState();
    const anchor = this.avwapAnchors.get(`${mode}:${timeframe}`);
    if (anchor !== undefined) {
      created.avwap = { anchorSec: anchor, cumPv: 0, cumVol: 0, mean: 0, m2: 0 };
    }
    side.perTimeframe.set(timeframe, created);
    return created;
  }

  /**
   * Siembra el estado desde el historial cerrado (paginación profunda de ADR o
   * agregados 1m). Barras ASC; la última barra se adopta como vela abierta si
   * su bucket es el actual. `avwapAnchorUtcSec` es el ancla resuelta por la
   * carga del gráfico (timestamp histórico arbitrario del rango extendido).
   */
  public seedHistory(
    mode: GgalTickMode,
    timeframe: GgalTickTimeframe,
    bars: readonly GgalTickMinuteBar[],
    avwapAnchorUtcSec?: number | null,
  ): void {
    const state = this.tfState(mode, timeframe);
    state.contributingMinutes = new Map();
    state.formingPv = 0;
    state.formingVolume = 0;
    if (avwapAnchorUtcSec !== undefined) {
      this.setAvwapAnchor(mode, timeframe, avwapAnchorUtcSec);
    }
    const closed = bars.filter(
      (bar) =>
        Number.isInteger(bar.timeSec) &&
        bar.timeSec > 0 &&
        finitePositive(bar.open) &&
        finitePositive(bar.high) &&
        finitePositive(bar.low) &&
        finitePositive(bar.close),
    );
    const closes = closed.map((bar) => bar.close);
    for (const period of [9, 21, 50, 200] as const) {
      const series = calculateEma(closes, period);
      const last = series[series.length - 1];
      state.ema[period].value = last !== undefined && Number.isFinite(last) ? last : null;
    }
    const nowSec = Math.floor(this.nowMsFn() / 1_000);
    const currentDayKey = utcDayKey(nowSec);
    state.closedSessionPv = 0;
    state.closedSessionVolume = 0;
    state.closedSessionDayKey = currentDayKey;
    for (const bar of closed) {
      if (!isGgalTickInSession(bar.timeSec, mode) || utcDayKey(bar.timeSec) !== currentDayKey) {
        continue;
      }
      if (bar.volume > 0) {
        const price = bar.vw !== undefined && finitePositive(bar.vw) ? bar.vw : typicalPriceOf(bar);
        state.closedSessionPv += price * bar.volume;
        state.closedSessionVolume += bar.volume;
      }
    }
    const anchor = state.avwap?.anchorSec ?? null;
    state.avwap = anchor !== null ? { anchorSec: anchor, cumPv: 0, cumVol: 0, mean: 0, m2: 0 } : null;
    for (const bar of closed) {
      if (anchor === null || bar.timeSec < anchor) {
        continue;
      }
      state.avwap = applyAvwapAccumulation(state.avwap, typicalPriceOf(bar), bar.volume);
    }
    const lastBar = closed[closed.length - 1];
    if (lastBar === undefined) {
      state.openBar = null;
      return;
    }
    const nowBucket = ggalTickBucketStartSec(nowSec, timeframe);
    const lastBucket = ggalTickBucketStartSec(lastBar.timeSec, timeframe);
    if (Number.isFinite(nowBucket) && lastBucket === nowBucket) {
      const openBar: GgalTickBar = {
        timeSec: lastBucket,
        open: lastBar.open,
        high: lastBar.high,
        low: lastBar.low,
        close: lastBar.close,
        volume: lastBar.volume,
      };
      state.openBar = openBar;
      state.contributingMinutes.set(lastBar.timeSec, lastBar);
      this.recomputeFormingSums(state);
    } else {
      state.openBar = null;
    }
  }

  /**
   * Lado ADR: consume el minuto consolidado de Massive WS (`liveStates1m` de
   * `GGAL`, con dedupe T/A/AM). Upsert idempotente por minuto; la vela abierta
   * del bucket se reconstruye desde los minutos contribuyentes.
   */
  public applyAdrMinute(minute: GgalTickMinuteBar): void {
    if (
      !Number.isInteger(minute.timeSec) ||
      minute.timeSec <= 0 ||
      !finitePositive(minute.open) ||
      !finitePositive(minute.high) ||
      !finitePositive(minute.low) ||
      !finitePositive(minute.close)
    ) {
      return;
    }
    const volume = Number.isFinite(minute.volume) && minute.volume > 0 ? minute.volume : 0;
    // Dedupe: el consolidador rebroadcastea el mismo minuto con datos idénticos.
    const signature = String(minute.close) + '|' + String(volume);
    const side = this.sides.ADR;
    if (side.minuteSignatures.get(minute.timeSec) === signature) {
      return;
    }
    if (side.minuteSignatures.size > 720) {
      side.minuteSignatures.clear();
    }
    side.minuteSignatures.set(minute.timeSec, signature);
    side.lastPrice = minute.close;
    side.lastTickTimeSec = minute.timeSec;
    const nowMs = this.nowMsFn();
    for (const timeframe of GGAL_TICK_TIMEFRAMES) {
      const state = this.tfState('ADR', timeframe);
      const bucket = ggalTickBucketStartSec(minute.timeSec, timeframe);
      if (!Number.isInteger(bucket)) {
        continue;
      }
      if (state.openBar !== null && bucket > state.openBar.timeSec) {
        this.rollOpenBar('ADR', state);
      }
      state.contributingMinutes.set(minute.timeSec, { ...minute, volume });
      this.rebuildOpenBar('ADR', timeframe, state, bucket);
      this.emitTick('ADR', timeframe, state, nowMs);
    }
    this.deriveCclTick();
  }

  /** Tick del lado ARS (BMB SignalR SendPrices / IOL REST). */
  public applyArsTick(input: { readonly price: number; readonly size: number; readonly timeSec: number }): void {
    this.applySideTick('ARS', input.price, input.size, input.timeSec);
    this.deriveCclTick();
  }

  private applySideTick(mode: GgalTickMode, price: number, size: number, timeSec: number): void {
    if (!finitePositive(price) || !Number.isInteger(timeSec) || timeSec <= 0) {
      return;
    }
    const side = this.sides[mode];
    side.lastPrice = price;
    side.lastTickTimeSec = timeSec;
    const volume = Number.isFinite(size) && size > 0 ? size : 0;
    const nowMs = this.nowMsFn();
    for (const timeframe of GGAL_TICK_TIMEFRAMES) {
      const state = this.tfState(mode, timeframe);
      const bucket = ggalTickBucketStartSec(timeSec, timeframe);
      if (!Number.isInteger(bucket)) {
        continue;
      }
      if (state.openBar !== null && bucket > state.openBar.timeSec) {
        this.rollOpenBar(mode, state);
      }
      const previousBarTime = state.openBar?.timeSec ?? null;
      const nextBar = applyGgalTickToBar(state.openBar, bucket, price, volume);
      state.openBar = nextBar;
      if (nextBar.timeSec !== previousBarTime) {
        state.formingPv = price * nextBar.volume;
        state.formingVolume = nextBar.volume;
      } else {
        state.formingPv += price * volume;
        state.formingVolume += volume;
      }
      this.emitTick(mode, timeframe, state, nowMs);
    }
  }

  private deriveCclTick(): void {
    const ars = this.sides.ARS.lastPrice;
    const adr = this.sides.ADR.lastPrice;
    const ccl = deriveGgalCclPrice(ars ?? Number.NaN, adr ?? Number.NaN, this.ratio);
    if (!finitePositive(ccl)) {
      return;
    }
    const timeSec = Math.max(this.sides.ARS.lastTickTimeSec ?? 0, this.sides.ADR.lastTickTimeSec ?? 0);
    if (timeSec <= 0) {
      return;
    }
    this.applySideTick('CCL', ccl, 0, timeSec);
  }

  /** Reconstrucción idempotente de la vela abierta desde los minutos. */
  private rebuildOpenBar(
    _mode: GgalTickMode,
    timeframe: GgalTickTimeframe,
    state: TfSideState,
    bucket: number,
  ): void {
    const minutes = [...state.contributingMinutes.values()]
      .filter((minute) => ggalTickBucketStartSec(minute.timeSec, timeframe) === bucket)
      .sort((a, b) => a.timeSec - b.timeSec);
    if (minutes.length === 0) {
      state.openBar = null;
      state.formingPv = 0;
      state.formingVolume = 0;
      return;
    }
    let open = Number.NaN;
    let high = Number.NaN;
    let low = Number.NaN;
    let close = Number.NaN;
    let volume = 0;
    for (const minute of minutes) {
      open = Number.isFinite(open) ? open : minute.open;
      high = Number.isFinite(high) ? Math.max(high, minute.high) : minute.high;
      low = Number.isFinite(low) ? Math.min(low, minute.low) : minute.low;
      close = minute.close;
      volume += minute.volume;
    }
    state.openBar = { timeSec: bucket, open, high, low, close, volume };
    this.recomputeFormingSums(state);
  }

  private recomputeFormingSums(state: TfSideState): void {
    let pv = 0;
    let volume = 0;
    for (const minute of state.contributingMinutes.values()) {
      if (minute.volume <= 0) {
        continue;
      }
      const price =
        minute.vw !== undefined && Number.isFinite(minute.vw) && minute.vw > 0
          ? minute.vw
          : typicalPriceOf(minute);
      pv += price * minute.volume;
      volume += minute.volume;
    }
    state.formingPv = pv;
    state.formingVolume = volume;
  }

  /** Pliegue de la vela abierta al cerrar su bucket (estados persistentes). */
  private rollOpenBar(mode: GgalTickMode, state: TfSideState): void {
    const bar = state.openBar;
    if (bar === null || !finitePositive(bar.close)) {
      state.openBar = null;
      state.contributingMinutes = new Map();
      state.formingPv = 0;
      state.formingVolume = 0;
      return;
    }
    const dayKey = utcDayKey(bar.timeSec);
    if (state.closedSessionDayKey !== dayKey) {
      state.closedSessionPv = 0;
      state.closedSessionVolume = 0;
      state.closedSessionDayKey = dayKey;
    }
    if (isGgalTickInSession(bar.timeSec, mode) && bar.volume > 0) {
      const price = state.formingVolume > 0 ? state.formingPv / state.formingVolume : typicalPriceOf(bar);
      state.closedSessionPv += price * bar.volume;
      state.closedSessionVolume += bar.volume;
    }
    for (const period of [9, 21, 50, 200] as const) {
      const alpha = EMA_ALPHA[period];
      const current = state.ema[period].value;
      state.ema[period].value =
        current === null || !Number.isFinite(current) ? bar.close : alpha * bar.close + (1 - alpha) * current;
    }
    if (state.avwap !== null) {
      state.avwap = applyAvwapAccumulation(state.avwap, typicalPriceOf(bar), bar.volume);
    }
    state.contributingMinutes = new Map();
    state.formingPv = 0;
    state.formingVolume = 0;
    state.openBar = null;
  }

  private buildIndicatorPoint(mode: GgalTickMode, state: TfSideState, bar: GgalTickBar): GgalTickIndicatorPoint {
    const price = bar.close;
    const liveEma = (period: 9 | 21 | 50 | 200): number | null => {
      const closed = state.ema[period].value;
      if (closed === null || !Number.isFinite(closed)) {
        return null;
      }
      const alpha = EMA_ALPHA[period];
      const projected = alpha * price + (1 - alpha) * closed;
      return Number.isFinite(projected) ? projected : null;
    };
    const dayKey = utcDayKey(bar.timeSec);
    let closedPv = state.closedSessionPv;
    let closedVolume = state.closedSessionVolume;
    if (state.closedSessionDayKey !== dayKey) {
      closedPv = 0;
      closedVolume = 0;
    }
    const totalVolume = closedVolume + state.formingVolume;
    const sessionVwap =
      isGgalTickInSession(bar.timeSec, mode) && totalVolume > 0
        ? (closedPv + state.formingPv) / totalVolume
        : null;
    const projectedAvwap =
      state.avwap !== null
        ? avwapPointFromState(
            applyAvwapAccumulation(state.avwap, typicalPriceOf(bar), state.formingVolume),
          )
        : { avwap: null, plus1Sigma: null, minus1Sigma: null };
    return {
      timeSec: bar.timeSec,
      ema9: liveEma(9),
      ema21: liveEma(21),
      ema50: liveEma(50),
      ema200: liveEma(200),
      sessionVwap: Number.isFinite(sessionVwap) ? sessionVwap : null,
      avwap: projectedAvwap.avwap,
      avwapPlus1Sigma: projectedAvwap.plus1Sigma,
      avwapMinus1Sigma: projectedAvwap.minus1Sigma,
    };
  }

  private emitTick(
    mode: GgalTickMode,
    timeframe: GgalTickTimeframe,
    state: TfSideState,
    nowMs: number,
  ): void {
    const bar = state.openBar;
    if (bar === null || this.emitFn === null || !finitePositive(bar.close)) {
      return;
    }
    if (state.lastEmitAtMs !== null && nowMs - state.lastEmitAtMs < this.minEmitIntervalMs) {
      return;
    }
    state.lastEmitAtMs = nowMs;
    this.emitFn({
      type: 'ggal_bar_tick',
      symbol: 'GGAL',
      mode,
      timeframe,
      bar: { ...bar },
      indicatorsPoint: this.buildIndicatorPoint(mode, state, bar),
      serverTimeSec: Math.floor(nowMs / 1_000),
    });
  }
}
