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

import { getBuenosAiresParts, GGAL_ADR_RATIO } from '../core/ggal/types.js';
import { getMarketParts } from '../core/sessions.js';
import { classifySessionRegime } from '../core/ggal/parityGap.js';
import {
  compareBucketTrades,
  evaluateCclContemporaneity,
  MAX_PLAUSIBLE_EPOCH_SEC,
  resolveGgalMarketSessionDateKey,
  type CclTemporalValuation,
} from '../core/temporalFeedIntegrity.js';

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
  readonly updateKind?: 'ACTIVE' | 'HISTORICAL_REVISION';
  readonly isRevision?: boolean;
  readonly bucketRevision?: number;
  readonly streamSeq?: number;
  readonly resolutionSec?: number;
  readonly cclMeta?: CclTemporalValuation;
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
  if (bar !== null && bucketStartSec < bar.timeSec) return bar;
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

function typicalPriceOf(bar: GgalTickBar): number {
  return (bar.high + bar.low + bar.close) / 3;
}

const LATE_REVISION_WINDOW_SEC: Readonly<Record<GgalTickTimeframe, number>> = {
  '1m': 900, '5m': 1_800, '15m': 3_600, '1h': 14_400, '4h': 43_200, '1D': 86_400,
};
const MAX_RETAINED_BUCKETS = 64;
const EMA_PERIODS = [9, 21, 50, 200] as const;
type EmaPeriod = typeof EMA_PERIODS[number];

export interface GgalTradeTick {
  readonly price: number;
  readonly size: number;
  readonly timeSec: number;
  readonly eventTimeMs?: number;
  readonly sequence?: number;
  readonly tradeId?: string;
  readonly volumeMode?: 'INCREMENTAL' | 'CUMULATIVE_SESSION';
}

interface TradeRecord {
  readonly price: number;
  readonly volume: number;
  readonly eventTimeMs: number;
  readonly arrivalOrder: number;
  readonly sequence?: number;
  readonly tradeId?: string;
}

interface BucketEntry {
  readonly timeSec: number;
  readonly session: string;
  readonly seed: GgalTickMinuteBar | null;
  readonly trades: TradeRecord[];
  readonly minutes: Map<number, GgalTickMinuteBar>;
  readonly seen: Set<string>;
  bar: GgalTickBar | null;
  pv: number;
  revision: number;
  lastEmitAtMs: number | null;
}

interface IndicatorCheckpoint {
  readonly ema: Record<EmaPeriod, number | null>;
  readonly count: number;
  readonly warmupSum: number;
  readonly session: string | null;
  readonly sessionPv: number;
  readonly sessionVolume: number;
  readonly avwap: AvwapAccState | null;
}

interface TfSideState {
  readonly buckets: Map<number, BucketEntry>;
  checkpoint: IndicatorCheckpoint;
  activeTime: number | null;
  activeSession: string | null;
  streamSeq: number;
}

interface ModeSideState {
  lastPrice: number;
  lastTickTimeSec: number | null;
  lastReceivedAtSec: number | null;
  lastTradeOrder: TradeRecord | null;
  readonly perTimeframe: Map<GgalTickTimeframe, TfSideState>;
  cumulative: { session: string; lastCumVol: number; watermarkSec: number } | null;
}

export interface GgalTickStreamEngineDeps {
  readonly nowMsFn?: () => number;
  readonly emit?: GgalBarTickEmit;
  readonly ratio?: number;
  readonly minEmitIntervalMs?: number;
  readonly dedupeWithoutId?: 'CANONICAL_EXACT' | 'OFF';
  readonly arHolidays?: readonly string[];
  readonly usHolidays?: readonly string[];
}

function newSideState(): ModeSideState {
  return {
    lastPrice: Number.NaN, lastTickTimeSec: null, lastReceivedAtSec: null, lastTradeOrder: null,
    perTimeframe: new Map(), cumulative: null,
  };
}

function emptyCheckpoint(anchorSec: number | null): IndicatorCheckpoint {
  return {
    ema: { 9: null, 21: null, 50: null, 200: null }, count: 0, warmupSum: 0,
    session: null, sessionPv: 0, sessionVolume: 0,
    avwap: anchorSec === null ? null : { anchorSec, cumPv: 0, cumVol: 0, mean: 0, m2: 0 },
  };
}

function newBucket(timeSec: number, session: string, seed: GgalTickMinuteBar | null = null): BucketEntry {
  return {
    timeSec, session, seed, trades: [], minutes: new Map(), seen: new Set(),
    bar: null, pv: 0, revision: 0, lastEmitAtMs: null,
  };
}

function minutePv(minute: GgalTickMinuteBar): number {
  const price = minute.vw !== undefined && finitePositive(minute.vw) ? minute.vw : typicalPriceOf(minute);
  return price * minute.volume;
}

function normalizeMinute(minute: GgalTickMinuteBar): GgalTickMinuteBar | null {
  if (!Number.isInteger(minute.timeSec) || minute.timeSec <= 0 || minute.timeSec > MAX_PLAUSIBLE_EPOCH_SEC ||
      !finitePositive(minute.open) || !finitePositive(minute.high) ||
      !finitePositive(minute.low) || !finitePositive(minute.close)) return null;
  return { ...minute, volume: Number.isFinite(minute.volume) && minute.volume >= 0 ? minute.volume : 0 };
}

function aggregateBucket(entry: BucketEntry): { bar: GgalTickBar | null; pv: number } {
  // Un minuto consolidado reemplaza a la semilla del mismo minuto. Los
  // minutos de un timeframe superior se agregan por orden de evento.
  const minutes = [...entry.minutes.values()].sort((a, b) => a.timeSec - b.timeSec);
  const seed = entry.seed !== null && !entry.minutes.has(entry.seed.timeSec) ? entry.seed : null;
  const trades = [...entry.trades].sort(compareBucketTrades);
  const observations = [
    ...minutes.map((minute) => ({ ...minute, pv: minutePv(minute), eventTimeMs: minute.timeSec * 1_000 })),
    ...trades.map((trade) => ({
      eventTimeMs: trade.eventTimeMs, open: trade.price, high: trade.price, low: trade.price, close: trade.price,
      volume: trade.volume, pv: trade.price * trade.volume,
    })),
  ].sort((a, b) => a.eventTimeMs - b.eventTimeMs);
  let bar: GgalTickBar | null = seed === null ? null : { ...seed, timeSec: entry.timeSec };
  let pv = seed === null ? 0 : minutePv(seed);
  for (const item of observations) {
    bar = {
      timeSec: entry.timeSec,
      open: bar?.open ?? item.open,
      high: bar === null ? item.high : Math.max(bar.high, item.high),
      low: bar === null ? item.low : Math.min(bar.low, item.low),
      close: item.close,
      volume: (bar?.volume ?? 0) + item.volume,
    };
    pv += item.pv;
  }
  return { bar, pv };
}

function sameBar(a: GgalTickBar | null, b: GgalTickBar): boolean {
  return a !== null && a.open === b.open && a.high === b.high && a.low === b.low &&
    a.close === b.close && a.volume === b.volume;
}

function foldBucket(before: IndicatorCheckpoint, bar: GgalTickBar, pv: number, session: string, mode: GgalTickMode): IndicatorCheckpoint {
  const count = before.count + 1;
  const warmupSum = count <= 200 ? before.warmupSum + bar.close : before.warmupSum;
  const ema = { ...before.ema };
  for (const period of EMA_PERIODS) {
    const previous = before.ema[period];
    const alpha = 2 / (period + 1);
    ema[period] = previous !== null ? alpha * bar.close + (1 - alpha) * previous
      : count === period ? warmupSum / period : null;
  }
  const inSession = isGgalTickInSession(bar.timeSec, mode);
  const sameSession = before.session === session;
  return {
    count, warmupSum, ema, session,
    sessionPv: (sameSession ? before.sessionPv : 0) + (inSession ? pv : 0),
    sessionVolume: (sameSession ? before.sessionVolume : 0) + (inSession ? bar.volume : 0),
    avwap: before.avwap !== null && bar.timeSec >= before.avwap.anchorSec
      ? applyAvwapAccumulation(before.avwap, typicalPriceOf(bar), bar.volume) : before.avwap,
  };
}

export class GgalTickStreamEngine {
  private readonly nowMsFn: () => number;
  private readonly emitFn: GgalBarTickEmit | null;
  private readonly ratio: number;
  private readonly minEmitIntervalMs: number;
  private readonly dedupeWithoutId: 'CANONICAL_EXACT' | 'OFF';
  private readonly arHolidays: readonly string[];
  private readonly usHolidays: readonly string[];
  private readonly sides = { ADR: newSideState(), ARS: newSideState(), CCL: newSideState() };
  private readonly avwapAnchors = new Map<string, number>();
  private readonly metrics = { duplicatesIgnored: 0, fallbackFingerprintDedupes: 0, lateEventsOutOfWindow: 0 };
  private lastCclValuation: CclTemporalValuation | null = null;
  private arrivalOrder = 0;

  public constructor(deps: GgalTickStreamEngineDeps = {}) {
    this.nowMsFn = deps.nowMsFn ?? Date.now;
    this.emitFn = deps.emit ?? null;
    this.ratio = deps.ratio ?? GGAL_ADR_RATIO;
    this.minEmitIntervalMs = deps.minEmitIntervalMs ?? GGAL_TICK_MIN_EMIT_INTERVAL_MS;
    this.dedupeWithoutId = deps.dedupeWithoutId ?? 'CANONICAL_EXACT';
    this.arHolidays = deps.arHolidays ?? [];
    this.usHolidays = deps.usHolidays ?? [];
  }

  public getLastCclValuation(): CclTemporalValuation | null {
    return this.lastCclValuation;
  }

  public getMetrics() {
    return { ...this.metrics };
  }

  public setAvwapAnchor(mode: GgalTickMode, timeframe: GgalTickTimeframe, anchorSec: number | null): void {
    const key = mode + ':' + timeframe;
    const valid = anchorSec !== null && Number.isInteger(anchorSec) && anchorSec > 0;
    if (valid) this.avwapAnchors.set(key, anchorSec);
    else this.avwapAnchors.delete(key);
    const state = this.sides[mode].perTimeframe.get(timeframe);
    if (state !== undefined) {
      state.checkpoint = { ...state.checkpoint, avwap: emptyCheckpoint(valid ? anchorSec : null).avwap };
    }
  }

  private tfState(mode: GgalTickMode, timeframe: GgalTickTimeframe): TfSideState {
    const side = this.sides[mode];
    const existing = side.perTimeframe.get(timeframe);
    if (existing !== undefined) return existing;
    const state: TfSideState = {
      buckets: new Map(), checkpoint: emptyCheckpoint(this.avwapAnchors.get(mode + ':' + timeframe) ?? null),
      activeTime: null, activeSession: null, streamSeq: 0,
    };
    side.perTimeframe.set(timeframe, state);
    return state;
  }

  public seedHistory(
    mode: GgalTickMode,
    timeframe: GgalTickTimeframe,
    bars: readonly GgalTickMinuteBar[],
    avwapAnchorUtcSec?: number | null,
  ): void {
    if (avwapAnchorUtcSec !== undefined) this.setAvwapAnchor(mode, timeframe, avwapAnchorUtcSec);
    const state = this.tfState(mode, timeframe);
    const nowSec = Math.floor(this.nowMsFn() / 1_000);
    const nowBucket = ggalTickBucketStartSec(nowSec, timeframe);
    const previousRevisions = new Map([...state.buckets].map(([time, entry]) => [time, entry.revision]));
    state.buckets.clear();
    state.checkpoint = emptyCheckpoint(this.avwapAnchors.get(mode + ':' + timeframe) ?? null);
    state.activeTime = null;
    state.activeSession = null;
    const sorted = bars.map(normalizeMinute).filter((bar) => bar !== null).sort((a, b) => a.timeSec - b.timeSec);
    const seeds = new Map(sorted.map((bar) => [ggalTickBucketStartSec(bar.timeSec, timeframe), bar]));
    for (const [timeSec, bar] of seeds) {
      const session = resolveGgalMarketSessionDateKey(bar.timeSec, mode);
      state.activeTime = timeSec;
      state.activeSession = session;
      if (nowBucket - timeSec > LATE_REVISION_WINDOW_SEC[timeframe]) {
        state.checkpoint = foldBucket(state.checkpoint, bar, minutePv(bar), session, mode);
        continue;
      }
      const entry = newBucket(timeSec, session, bar);
      Object.assign(entry, aggregateBucket(entry));
      entry.revision = previousRevisions.get(timeSec) ?? 0;
      state.buckets.set(timeSec, entry);
    }
    this.evictBuckets(mode, timeframe, state);
  }

  public applyAdrMinute(input: GgalTickMinuteBar): void {
    const minute = normalizeMinute(input);
    if (minute === null) return;
    const nowMs = this.nowMsFn();
    let accepted = false;
    let outOfWindow = false;
    const session = resolveGgalMarketSessionDateKey(minute.timeSec, 'ADR');
    for (const timeframe of GGAL_TICK_TIMEFRAMES) {
      const state = this.tfState('ADR', timeframe);
      const entry = this.bucketForEvent(timeframe, state, minute.timeSec, session);
      if (entry === null) {
        outOfWindow = true;
        continue;
      }
      const old = entry.minutes.get(minute.timeSec);
      if (old !== undefined && sameBar(old, minute) && Object.is(old.vw, minute.vw)) continue;
      accepted = true;
      entry.minutes.set(minute.timeSec, minute);
      this.applyBucket('ADR', timeframe, state, entry, nowMs);
    }
    if (outOfWindow) this.metrics.lateEventsOutOfWindow += 1;
    if (accepted && this.updateLatest('ADR', minute.close, minute.timeSec, nowMs, null)) this.deriveCclTick(nowMs);
  }

  public applyAdrTick(input: GgalTradeTick): void {
    const nowMs = this.nowMsFn();
    if (this.applySideTick('ADR', input, nowMs)) this.deriveCclTick(nowMs);
  }

  public applyArsTick(input: GgalTradeTick): void {
    const nowMs = this.nowMsFn();
    if (this.applySideTick('ARS', input, nowMs)) this.deriveCclTick(nowMs);
  }

  private updateLatest(mode: GgalTickMode, price: number, timeSec: number, nowMs: number, order: TradeRecord | null): boolean {
    const side = this.sides[mode];
    if (side.lastTickTimeSec !== null && timeSec < side.lastTickTimeSec) return false;
    if (timeSec === side.lastTickTimeSec && side.lastTradeOrder !== null && order !== null &&
        compareBucketTrades(order, side.lastTradeOrder) < 0) return false;
    side.lastPrice = price;
    side.lastTickTimeSec = timeSec;
    side.lastReceivedAtSec = Math.floor(nowMs / 1_000);
    side.lastTradeOrder = order;
    return true;
  }

  private applySideTick(mode: GgalTickMode, input: GgalTradeTick, nowMs: number): boolean {
    const { price, timeSec, size } = input;
    if (!finitePositive(price) || !Number.isInteger(timeSec) || timeSec <= 0 || timeSec > MAX_PLAUSIBLE_EPOCH_SEC) return false;
    const side = this.sides[mode];
    const eventTimeMs = input.eventTimeMs !== undefined && Number.isInteger(input.eventTimeMs) &&
      Math.floor(input.eventTimeMs / 1_000) === timeSec ? input.eventTimeMs : timeSec * 1_000;
    const sequence = input.sequence !== undefined && Number.isInteger(input.sequence) && input.sequence > 0
      ? input.sequence : undefined;
    const tradeId = input.tradeId?.trim();
    const rawVolume = Number.isFinite(size) && size >= 0 ? size : 0;
    const session = resolveGgalMarketSessionDateKey(timeSec, mode);
    const key = tradeId ? 'id:' + tradeId : sequence !== undefined ? 'seq:' + String(sequence)
      : this.dedupeWithoutId === 'CANONICAL_EXACT' ? ['fp', eventTimeMs, price, rawVolume].join('|') : null;
    let accepted = false;
    let duplicate = false;
    let outOfWindow = false;
    let record: TradeRecord | null = null;
    for (const timeframe of GGAL_TICK_TIMEFRAMES) {
      const state = this.tfState(mode, timeframe);
      const entry = this.bucketForEvent(timeframe, state, timeSec, session);
      if (entry === null) {
        outOfWindow = true;
        continue;
      }
      if (key !== null && entry.seen.has(key)) {
        duplicate = true;
        continue;
      }
      if (record === null) {
        let volume = rawVolume;
        if (input.volumeMode === 'CUMULATIVE_SESSION') {
          volume = 0;
          const saved = side.cumulative;
          if (saved === null || session > saved.session) {
            side.cumulative = { session, lastCumVol: rawVolume, watermarkSec: timeSec };
          } else if (session === saved.session && timeSec >= saved.watermarkSec) {
            volume = Math.max(0, rawVolume - saved.lastCumVol);
            side.cumulative = { session, lastCumVol: Math.max(rawVolume, saved.lastCumVol), watermarkSec: timeSec };
          }
        }
        record = {
          price, volume, eventTimeMs, arrivalOrder: ++this.arrivalOrder,
          ...(sequence === undefined ? {} : { sequence }), ...(tradeId ? { tradeId } : {}),
        };
      }
      if (key !== null) entry.seen.add(key);
      entry.trades.push(record);
      this.applyBucket(mode, timeframe, state, entry, nowMs);
      accepted = true;
    }
    if (duplicate) {
      this.metrics.duplicatesIgnored += 1;
      if (key?.startsWith('fp|') === true) this.metrics.fallbackFingerprintDedupes += 1;
    }
    if (outOfWindow) this.metrics.lateEventsOutOfWindow += 1;
    return accepted && this.updateLatest(mode, price, timeSec, nowMs, record);
  }

  private bucketForEvent(timeframe: GgalTickTimeframe, state: TfSideState, timeSec: number, session: string): BucketEntry | null {
    const time = ggalTickBucketStartSec(timeSec, timeframe);
    const active = state.activeTime;
    const existing = state.buckets.get(time);
    if (state.activeSession !== null && session < state.activeSession) return null;
    if (active !== null && time < active &&
        (active - time > LATE_REVISION_WINDOW_SEC[timeframe] || session !== state.activeSession)) return null;
    if (existing !== undefined && existing.session !== session) {
      const next = newBucket(time, session);
      next.revision = existing.revision;
      return next;
    }
    return existing ?? newBucket(time, session);
  }

  private deriveCclTick(nowMs: number): void {
    const { ARS, ADR } = this.sides;
    const evaluationNowSec = Math.floor(nowMs / 1_000);
    const { sessionRegime } = classifySessionRegime(evaluationNowSec, this.arHolidays, this.usHolidays);
    const valuation = evaluateCclContemporaneity({
      byma: { price: ARS.lastPrice, timeSec: ARS.lastTickTimeSec, receivedAtSec: ARS.lastReceivedAtSec },
      adr: { price: ADR.lastPrice, timeSec: ADR.lastTickTimeSec, receivedAtSec: ADR.lastReceivedAtSec },
      evaluationNowSec, marketRegime: sessionRegime, ratio: this.ratio,
    });
    this.lastCclValuation = valuation;
    if (valuation.livePublishable && valuation.valuationTimestamp !== null) {
      this.applySideTick('CCL', { price: valuation.value, size: 0, timeSec: valuation.valuationTimestamp }, nowMs);
    }
  }

  private evictBuckets(mode: GgalTickMode, timeframe: GgalTickTimeframe, state: TfSideState): void {
    const active = state.activeTime;
    if (active === null) return;
    for (const entry of this.sortedBuckets(state)) {
      if (state.buckets.size <= MAX_RETAINED_BUCKETS && active - entry.timeSec <= LATE_REVISION_WINDOW_SEC[timeframe]) break;
      if (entry.bar !== null) state.checkpoint = foldBucket(state.checkpoint, entry.bar, entry.pv, entry.session, mode);
      state.buckets.delete(entry.timeSec);
    }
  }

  private sortedBuckets(state: TfSideState): BucketEntry[] {
    return [...state.buckets.values()].sort((a, b) => a.timeSec - b.timeSec);
  }

  private applyBucket(mode: GgalTickMode, timeframe: GgalTickTimeframe, state: TfSideState, entry: BucketEntry, nowMs: number): void {
    const { bar, pv } = aggregateBucket(entry);
    if (bar === null) return;
    const historical = state.activeTime !== null && entry.timeSec < state.activeTime;
    const changed = !sameBar(entry.bar, bar);
    entry.bar = bar;
    entry.pv = pv;
    if (changed) entry.revision += 1;
    state.buckets.set(entry.timeSec, entry);
    if (!historical) {
      state.activeTime = entry.timeSec;
      state.activeSession = entry.session;
    }
    this.evictBuckets(mode, timeframe, state);
    if (!changed || this.emitFn === null) return;
    if (!historical && entry.lastEmitAtMs !== null && nowMs - entry.lastEmitAtMs < this.minEmitIntervalMs) return;
    entry.lastEmitAtMs = nowMs;

    let before = state.checkpoint;
    for (const closed of this.sortedBuckets(state)) {
      if (closed.timeSec >= entry.timeSec) break;
      if (closed.bar !== null) before = foldBucket(before, closed.bar, closed.pv, closed.session, mode);
    }
    const projected = foldBucket(before, bar, pv, entry.session, mode);
    const avwap = avwapPointFromState(projected.avwap);
    this.emitFn({
      type: 'ggal_bar_tick', symbol: 'GGAL', mode, timeframe, bar,
      serverTimeSec: Math.floor(nowMs / 1_000),
      isRevision: historical, updateKind: historical ? 'HISTORICAL_REVISION' : 'ACTIVE',
      bucketRevision: entry.revision, streamSeq: ++state.streamSeq,
      resolutionSec: GGAL_TICK_TIMEFRAME_SECONDS[timeframe],
      ...(mode === 'CCL' && this.lastCclValuation !== null ? { cclMeta: this.lastCclValuation } : {}),
      indicatorsPoint: {
        timeSec: bar.timeSec,
        ema9: before.ema[9] === null ? null : projected.ema[9],
        ema21: before.ema[21] === null ? null : projected.ema[21],
        ema50: before.ema[50] === null ? null : projected.ema[50],
        ema200: before.ema[200] === null ? null : projected.ema[200],
        sessionVwap: projected.sessionVolume > 0 ? projected.sessionPv / projected.sessionVolume : null,
        avwap: avwap.avwap, avwapPlus1Sigma: avwap.plus1Sigma, avwapMinus1Sigma: avwap.minus1Sigma,
      },
    });
  }
}
