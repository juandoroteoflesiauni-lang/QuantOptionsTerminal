/**
 * Motor determinístico de anclas institucionales Auto-AVWAP (Pieza 50.5).
 *
 * Garantías de diseño (`AGENTS.md` / SPEC):
 *  - Funciones 100 % puras: cero red, cero E/S, cero UI y cero mutación de argumentos.
 *  - Timestamps siempre en segundos UTC enteros (`|t| <= MAX_TIME_SECONDS`);
 *    barras en milisegundos o con campos no finitos se descartan.
 *  - Zero Silent Fallbacks: lo no calculable queda en `NaN` (ATR/RVOL/zVol) y los
 *    candidatos sin AVWAP válido jamás se emiten.
 *  - Paridad `<= 1e-9` contra referencia independiente en Python
 *    (`tools/gen_auto_avwap_pieza50_5_reference.py`).
 */

import { calculateAnchoredVwap } from './avwap.js';
import { MAX_TIME_SECONDS } from './sessions.js';
import type { Bar } from './types.js';

export type AutoAnchorRole = 'SUPPORT' | 'RESISTANCE' | 'EVENT';
export type AutoAnchorSource =
  | 'EVENT'
  | 'PIVOT_MAJOR'
  | 'PIVOT_INTERMEDIATE'
  | 'RVOL';

export interface AutoAvwapEventInput {
  /** Timestamp UTC en segundos enteros del evento. */
  readonly utcSec: number;
  /** Etiqueta legible (ej. 'Earnings', 'FOMC', 'CPI'). */
  readonly label: string;
  /** 'bmo' | 'amc' | 'unknown' — si es 'amc' (after-hours), mapea a la rueda hábil estrictamente posterior. */
  readonly timeOfDay?: 'bmo' | 'amc' | 'unknown' | null;
  /** Fecha civil ISO opcional 'YYYY-MM-DD'. Si se omite se deriva de `utcSec` en UTC. */
  readonly date?: string;
}

export interface AutoAvwapOptions {
  readonly windowBars?: number; // default: 380
  readonly atrPeriod?: number; // default: 14
  readonly rvolPeriod?: number; // default: 20
  readonly pivotWindow?: number; // default: 10 (±10 velas)
  readonly pivotReversalAtrMult?: number; // default: 2.5
  readonly majorLookbackBars?: number; // default: 126 (6M)
  readonly intermediateMinBars?: number; // default: 21 (1M)
  readonly rvolThreshold?: number; // default: 2.0
  readonly rvolGapAtrMult?: number; // default: 1.2
  readonly rvolRangeAtrMult?: number; // default: 1.5
  readonly clusterMaxDistanceBars?: number; // default: 3 (<= 3 velas)
  readonly maxDistancePct?: number; // default: 0.25 (±25%)
  readonly farPenalty?: number; // default: 20 (-20 pts)
  readonly maxAnchors?: number; // default: 3
}

export interface AutoAvwapAnchor {
  readonly role: AutoAnchorRole;
  readonly anchorTimeSec: number;
  readonly windowIndex: number;
  readonly anchorPrice: number;
  readonly currentAvwap: number;
  readonly distancePct: number;
  readonly score: number;
  readonly sources: readonly AutoAnchorSource[];
  readonly eventLabel: string | null;
}

const DEFAULT_WINDOW_BARS = 380;
const DEFAULT_ATR_PERIOD = 14;
const DEFAULT_RVOL_PERIOD = 20;
const DEFAULT_PIVOT_WINDOW = 10;
const DEFAULT_PIVOT_REVERSAL_ATR_MULT = 2.5;
const DEFAULT_MAJOR_LOOKBACK_BARS = 126;
const DEFAULT_INTERMEDIATE_MIN_BARS = 21;
const DEFAULT_RVOL_THRESHOLD = 2.0;
const DEFAULT_RVOL_GAP_ATR_MULT = 1.2;
const DEFAULT_RVOL_RANGE_ATR_MULT = 1.5;
const DEFAULT_CLUSTER_MAX_DISTANCE_BARS = 3;
const DEFAULT_MAX_DISTANCE_PCT = 0.25;
const DEFAULT_FAR_PENALTY = 20;
const DEFAULT_MAX_ANCHORS = 3;

interface ResolvedAutoAvwapOptions {
  readonly windowBars: number;
  readonly atrPeriod: number;
  readonly rvolPeriod: number;
  readonly pivotWindow: number;
  readonly pivotReversalAtrMult: number;
  readonly majorLookbackBars: number;
  readonly intermediateMinBars: number;
  readonly rvolThreshold: number;
  readonly rvolGapAtrMult: number;
  readonly rvolRangeAtrMult: number;
  readonly clusterMaxDistanceBars: number;
  readonly maxDistancePct: number;
  readonly farPenalty: number;
  readonly maxAnchors: number;
}

function resolveOptions(options: AutoAvwapOptions): ResolvedAutoAvwapOptions {
  return {
    windowBars: positiveIntOr(options.windowBars, DEFAULT_WINDOW_BARS),
    atrPeriod: positiveIntOr(options.atrPeriod, DEFAULT_ATR_PERIOD),
    rvolPeriod: positiveIntOr(options.rvolPeriod, DEFAULT_RVOL_PERIOD),
    pivotWindow: positiveIntOr(options.pivotWindow, DEFAULT_PIVOT_WINDOW),
    pivotReversalAtrMult: finiteOr(options.pivotReversalAtrMult, DEFAULT_PIVOT_REVERSAL_ATR_MULT),
    majorLookbackBars: positiveIntOr(options.majorLookbackBars, DEFAULT_MAJOR_LOOKBACK_BARS),
    intermediateMinBars: positiveIntOr(options.intermediateMinBars, DEFAULT_INTERMEDIATE_MIN_BARS),
    rvolThreshold: finiteOr(options.rvolThreshold, DEFAULT_RVOL_THRESHOLD),
    rvolGapAtrMult: finiteOr(options.rvolGapAtrMult, DEFAULT_RVOL_GAP_ATR_MULT),
    rvolRangeAtrMult: finiteOr(options.rvolRangeAtrMult, DEFAULT_RVOL_RANGE_ATR_MULT),
    clusterMaxDistanceBars: positiveIntOr(
      options.clusterMaxDistanceBars,
      DEFAULT_CLUSTER_MAX_DISTANCE_BARS,
    ),
    maxDistancePct: finiteOr(options.maxDistancePct, DEFAULT_MAX_DISTANCE_PCT),
    farPenalty: finiteOr(options.farPenalty, DEFAULT_FAR_PENALTY),
    maxAnchors: positiveIntOr(options.maxAnchors, DEFAULT_MAX_ANCHORS),
  };
}

function positiveIntOr(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const int = Math.trunc(value);
  return int >= 1 ? int : fallback;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function isValidBar(bar: Bar): boolean {
  return (
    Number.isFinite(bar.time) &&
    Number.isInteger(bar.time) &&
    Math.abs(bar.time) <= MAX_TIME_SECONDS &&
    Number.isFinite(bar.open) &&
    Number.isFinite(bar.high) &&
    Number.isFinite(bar.low) &&
    Number.isFinite(bar.close) &&
    bar.high >= bar.low &&
    Number.isFinite(bar.volume) &&
    bar.volume >= 0
  );
}

/**
 * Sanitiza el histórico: descarta barras inválidas, ordena ascendente por `time`
 * y ante timestamps duplicados conserva la última ocurrencia (misma semántica
 * que `resampleDailyToWeekly`). Nunca muta la entrada.
 */
function sanitizeDailyBars(dailyBars: readonly Bar[]): readonly Bar[] {
  const byTime = new Map<number, Bar>();
  for (const bar of dailyBars) {
    if (!isValidBar(bar)) continue;
    byTime.set(bar.time, bar);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function isValidEvent(event: AutoAvwapEventInput): boolean {
  return Number.isFinite(event.utcSec) && Math.abs(event.utcSec) <= MAX_TIME_SECONDS;
}

/** Clave civil UTC `YYYY-MM-DD` de un timestamp en segundos. */
export function autoAvwapBarDateKey(timeSec: number): string {
  return new Date(timeSec * 1_000).toISOString().slice(0, 10);
}

/**
 * ATR de Wilder (`period = 14` por defecto) con paridad de fórmula:
 *  - `TR[0] = H0 - L0`; para `i >= 1`, `TR[i] = max(H-L, |H-Cprev|, |L-Cprev|)`.
 *  - Primeras `period - 1` barras: `NaN` (Zero Silent Fallbacks).
 *  - Semilla en `period - 1`: media aritmética de los `period` primeros TR.
 *  - Recursión: `ATR[i] = (ATR[i-1] * (period - 1) + TR[i]) / period`.
 * Función pura: recibe la ventana de análisis ya sanitizada.
 */
export function computeAutoAvwapAtrSeries(
  bars: readonly Bar[],
  period = DEFAULT_ATR_PERIOD,
): number[] {
  const n = bars.length;
  const atr = new Array<number>(n).fill(Number.NaN);
  if (n === 0 || !Number.isInteger(period) || period < 1) return atr;

  const trueRange = new Array<number>(n).fill(Number.NaN);
  const first = bars[0];
  if (first === undefined) return atr;
  trueRange[0] = first.high - first.low;
  for (let i = 1; i < n; i += 1) {
    const bar = bars[i];
    const previous = bars[i - 1];
    if (bar === undefined || previous === undefined) return atr;
    trueRange[i] = Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previous.close),
      Math.abs(bar.low - previous.close),
    );
  }

  if (n < period) return atr;

  let seedSum = 0;
  for (let i = 0; i < period; i += 1) {
    seedSum += trueRange[i] ?? Number.NaN;
  }
  atr[period - 1] = seedSum / period;
  for (let i = period; i < n; i += 1) {
    const prevAtr = atr[i - 1];
    const tr = trueRange[i];
    if (prevAtr === undefined || tr === undefined) return atr;
    atr[i] = (prevAtr * (period - 1) + tr) / period;
  }
  return atr;
}

export interface AutoAvwapVolumeStats {
  readonly smaVol: readonly number[];
  readonly stdVol: readonly number[];
  readonly rvol: readonly number[];
  readonly zVol: readonly number[];
}

/**
 * RVOL(`period = 20` por defecto) y `zVol` sobre la ventana estrictamente causal
 * `[i - period .. i - 1]` con desvío poblacional (`ddof = 0`):
 *  - `rvol[i] = (mu > 0) ? V_i / mu : NaN`.
 *  - `zVol[i] = (sigma > 0) ? (V_i - mu) / sigma : NaN` (sin Infinity por sigma = 0).
 * Función pura: recibe la ventana de análisis ya sanitizada.
 */
export function computeAutoAvwapVolumeStats(
  bars: readonly Bar[],
  period = DEFAULT_RVOL_PERIOD,
): AutoAvwapVolumeStats {
  const n = bars.length;
  const smaVol = new Array<number>(n).fill(Number.NaN);
  const stdVol = new Array<number>(n).fill(Number.NaN);
  const rvol = new Array<number>(n).fill(Number.NaN);
  const zVol = new Array<number>(n).fill(Number.NaN);
  if (!Number.isInteger(period) || period < 1) {
    return { smaVol, stdVol, rvol, zVol };
  }

  for (let i = period; i < n; i += 1) {
    let sum = 0;
    for (let k = i - period; k < i; k += 1) {
      sum += bars[k]?.volume ?? Number.NaN;
    }
    const mean = sum / period;
    let squaredSum = 0;
    for (let k = i - period; k < i; k += 1) {
      const diff = (bars[k]?.volume ?? Number.NaN) - mean;
      squaredSum += diff * diff;
    }
    const sigma = Math.sqrt(squaredSum / period);
    smaVol[i] = mean;
    stdVol[i] = sigma;
    const currentVolume = bars[i]?.volume ?? Number.NaN;
    rvol[i] = mean > 0 ? currentVolume / mean : Number.NaN;
    zVol[i] = sigma > 0 ? (currentVolume - mean) / sigma : Number.NaN;
  }

  return { smaVol, stdVol, rvol, zVol };
}

type RawPivotKind = 'LOW' | 'HIGH';

interface RawCandidate {
  readonly index: number;
  readonly source: AutoAnchorSource;
  readonly score: number;
  readonly pivotKind: RawPivotKind | null;
  readonly eventLabel: string | null;
}

function sourcePriority(source: AutoAnchorSource): number {
  switch (source) {
    case 'EVENT':
      return 0;
    case 'PIVOT_MAJOR':
      return 1;
    case 'PIVOT_INTERMEDIATE':
      return 2;
    case 'RVOL':
      return 3;
  }
}

function buildEventCandidates(
  windowBars: readonly Bar[],
  events: readonly AutoAvwapEventInput[],
): RawCandidate[] {
  const n = windowBars.length;
  if (n === 0) return [];
  const first = windowBars[0];
  const last = windowBars[n - 1];
  if (first === undefined || last === undefined) return [];
  const firstKey = autoAvwapBarDateKey(first.time);
  const lastKey = autoAvwapBarDateKey(last.time);

  const labelsByIndex = new Map<number, string[]>();
  for (const event of events) {
    if (!isValidEvent(event)) continue;
    const rawUtcSec = Math.floor(event.utcSec);
    const eventKey =
      typeof event.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(event.date)
        ? event.date
        : autoAvwapBarDateKey(rawUtcSec);
    if (eventKey < firstKey || eventKey > lastKey) continue;

    let targetIndex = -1;
    if (event.timeOfDay === 'amc') {
      for (let i = 0; i < n; i += 1) {
        const bar = windowBars[i];
        if (bar !== undefined && autoAvwapBarDateKey(bar.time) > eventKey) {
          targetIndex = i;
          break;
        }
      }
    } else {
      for (let i = 0; i < n; i += 1) {
        const bar = windowBars[i];
        if (bar !== undefined && autoAvwapBarDateKey(bar.time) >= eventKey) {
          targetIndex = i;
          break;
        }
      }
    }
    if (targetIndex < 0) continue;

    const labels = labelsByIndex.get(targetIndex);
    const label = typeof event.label === 'string' ? event.label : '';
    if (labels === undefined) {
      labelsByIndex.set(targetIndex, [label]);
    } else if (!labels.includes(label)) {
      labels.push(label);
    }
  }

  const candidates: RawCandidate[] = [];
  for (const [index, labels] of labelsByIndex) {
    const uniqueSorted = [...new Set(labels)].sort();
    candidates.push({
      index,
      source: 'EVENT',
      score: 35,
      pivotKind: null,
      eventLabel: uniqueSorted.join('/'),
    });
  }
  return candidates;
}

function buildPivotCandidates(
  windowBars: readonly Bar[],
  atr: readonly number[],
  options: ResolvedAutoAvwapOptions,
): RawCandidate[] {
  const n = windowBars.length;
  const candidates: RawCandidate[] = [];
  const { pivotWindow, pivotReversalAtrMult, majorLookbackBars, intermediateMinBars } = options;
  if (n < 2 * pivotWindow + 1) return candidates;

  for (let i = pivotWindow; i <= n - pivotWindow - 1; i += 1) {
    const atrI = atr[i];
    if (atrI === undefined || !Number.isFinite(atrI) || atrI <= 0) continue;
    const bar = windowBars[i];
    if (bar === undefined) continue;

    // Pivot Low: mínimo local ±pivotWindow (izquierda estricta, derecha no estricta).
    let isPivotLow = true;
    for (let k = i - pivotWindow; k <= i + pivotWindow && isPivotLow; k += 1) {
      if (k === i) continue;
      const other = windowBars[k];
      if (other === undefined) continue;
      if (k < i ? !(bar.low < other.low) : !(bar.low <= other.low)) {
        isPivotLow = false;
      }
    }
    if (isPivotLow) {
      let maxHighAfter = Number.NEGATIVE_INFINITY;
      for (let k = i + 1; k < n; k += 1) {
        const other = windowBars[k];
        if (other === undefined) continue;
        if (other.high > maxHighAfter) maxHighAfter = other.high;
      }
      if (maxHighAfter - bar.low >= pivotReversalAtrMult * atrI) {
        let leftSpan = 0;
        for (let k = i - 1; k >= 0; k -= 1) {
          const other = windowBars[k];
          if (other === undefined || other.low < bar.low) break;
          leftSpan += 1;
        }
        let rightSpan = 0;
        for (let k = i + 1; k < n; k += 1) {
          const other = windowBars[k];
          if (other === undefined || other.low < bar.low) break;
          rightSpan += 1;
        }
        const dominanceSpan = leftSpan + 1 + rightSpan;
        if (dominanceSpan >= majorLookbackBars) {
          candidates.push({
            index: i,
            source: 'PIVOT_MAJOR',
            score: 30,
            pivotKind: 'LOW',
            eventLabel: null,
          });
        } else if (dominanceSpan >= intermediateMinBars) {
          candidates.push({
            index: i,
            source: 'PIVOT_INTERMEDIATE',
            score: 15,
            pivotKind: 'LOW',
            eventLabel: null,
          });
        }
      }
    }

    // Pivot High: espejo exacto del pivot low.
    let isPivotHigh = true;
    for (let k = i - pivotWindow; k <= i + pivotWindow && isPivotHigh; k += 1) {
      if (k === i) continue;
      const other = windowBars[k];
      if (other === undefined) continue;
      if (k < i ? !(bar.high > other.high) : !(bar.high >= other.high)) {
        isPivotHigh = false;
      }
    }
    if (isPivotHigh) {
      let minLowAfter = Number.POSITIVE_INFINITY;
      for (let k = i + 1; k < n; k += 1) {
        const other = windowBars[k];
        if (other === undefined) continue;
        if (other.low < minLowAfter) minLowAfter = other.low;
      }
      if (bar.high - minLowAfter >= pivotReversalAtrMult * atrI) {
        let leftSpan = 0;
        for (let k = i - 1; k >= 0; k -= 1) {
          const other = windowBars[k];
          if (other === undefined || other.high > bar.high) break;
          leftSpan += 1;
        }
        let rightSpan = 0;
        for (let k = i + 1; k < n; k += 1) {
          const other = windowBars[k];
          if (other === undefined || other.high > bar.high) break;
          rightSpan += 1;
        }
        const dominanceSpan = leftSpan + 1 + rightSpan;
        if (dominanceSpan >= majorLookbackBars) {
          candidates.push({
            index: i,
            source: 'PIVOT_MAJOR',
            score: 30,
            pivotKind: 'HIGH',
            eventLabel: null,
          });
        } else if (dominanceSpan >= intermediateMinBars) {
          candidates.push({
            index: i,
            source: 'PIVOT_INTERMEDIATE',
            score: 15,
            pivotKind: 'HIGH',
            eventLabel: null,
          });
        }
      }
    }
  }
  return candidates;
}

function buildRvolCandidates(
  windowBars: readonly Bar[],
  atr: readonly number[],
  stats: AutoAvwapVolumeStats,
  options: ResolvedAutoAvwapOptions,
): RawCandidate[] {
  const n = windowBars.length;
  const candidates: RawCandidate[] = [];
  const { rvolPeriod, rvolThreshold, rvolGapAtrMult, rvolRangeAtrMult } = options;

  for (let i = rvolPeriod; i < n; i += 1) {
    const atrI = atr[i];
    const rvolI = stats.rvol[i];
    if (atrI === undefined || !Number.isFinite(atrI) || atrI <= 0) continue;
    if (rvolI === undefined || !Number.isFinite(rvolI)) continue;
    const bar = windowBars[i];
    const previous = windowBars[i - 1];
    if (bar === undefined || previous === undefined) continue;
    if (rvolI < rvolThreshold) continue;
    const gapTriggered = Math.abs(bar.open - previous.close) >= rvolGapAtrMult * atrI;
    const rangeTriggered = bar.high - bar.low >= rvolRangeAtrMult * atrI;
    if (!gapTriggered && !rangeTriggered) continue;

    const zVolI = stats.zVol[i];
    const score =
      zVolI !== undefined && Number.isFinite(zVolI)
        ? Math.min(30, Math.max(0, 10 * zVolI))
        : 0;
    candidates.push({
      index: i,
      source: 'RVOL',
      score,
      pivotKind: null,
      eventLabel: null,
    });
  }
  return candidates;
}

interface MergedCluster {
  readonly anchorIndex: number;
  readonly anchorPrice: number;
  readonly pivotKind: RawPivotKind | null;
  readonly sources: readonly AutoAnchorSource[];
  readonly eventLabel: string | null;
  readonly score: number;
  readonly isGlobalExtreme: boolean;
  currentAvwap: number;
  distancePct: number;
  finalScore: number;
}

function mergeClusters(
  windowBars: readonly Bar[],
  candidates: readonly RawCandidate[],
  options: ResolvedAutoAvwapOptions,
): MergedCluster[] {
  const n = windowBars.length;
  if (n === 0) return [];

  let globalLowIdx = -1;
  let globalHighIdx = -1;
  let minLow = Number.POSITIVE_INFINITY;
  let maxHigh = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i += 1) {
    const bar = windowBars[i];
    if (bar === undefined) continue;
    if (bar.low < minLow) {
      minLow = bar.low;
      globalLowIdx = i;
    }
    if (bar.high > maxHigh) {
      maxHigh = bar.high;
      globalHighIdx = i;
    }
  }

  const sorted = [...candidates].sort((a, b) => {
    if (a.index !== b.index) return a.index - b.index;
    return sourcePriority(a.source) - sourcePriority(b.source);
  });

  const clusters: RawCandidate[][] = [];
  let current: RawCandidate[] = [];
  for (const candidate of sorted) {
    const previous = current[current.length - 1];
    if (
      previous !== undefined &&
      candidate.index - previous.index > options.clusterMaxDistanceBars
    ) {
      clusters.push(current);
      current = [];
    }
    current.push(candidate);
  }
  if (current.length > 0) clusters.push(current);

  const merged: MergedCluster[] = [];
  for (const cluster of clusters) {
    let eventScore = 0;
    let pivotScore = 0;
    let rvolScore = 0;
    let hasEvent = false;
    let hasPivotMajor = false;
    let hasPivotIntermediate = false;
    let hasPivot = false;
    let hasRvol = false;
    const eventLabels: string[] = [];

    for (const candidate of cluster) {
      switch (candidate.source) {
        case 'EVENT':
          hasEvent = true;
          eventScore = Math.max(eventScore, candidate.score);
          if (candidate.eventLabel !== null) eventLabels.push(candidate.eventLabel);
          break;
        case 'PIVOT_MAJOR':
          hasPivot = true;
          hasPivotMajor = true;
          pivotScore = Math.max(pivotScore, candidate.score);
          break;
        case 'PIVOT_INTERMEDIATE':
          hasPivot = true;
          hasPivotIntermediate = true;
          pivotScore = Math.max(pivotScore, candidate.score);
          break;
        case 'RVOL':
          hasRvol = true;
          rvolScore = Math.max(rvolScore, candidate.score);
          break;
      }
    }

    const score = eventScore + pivotScore + rvolScore;
    const sources: AutoAnchorSource[] = [];
    if (hasEvent) sources.push('EVENT');
    if (hasPivotMajor) sources.push('PIVOT_MAJOR');
    else if (hasPivotIntermediate) sources.push('PIVOT_INTERMEDIATE');
    if (hasRvol) sources.push('RVOL');

    let winner: RawCandidate | undefined;
    if (hasPivot) {
      for (const candidate of cluster) {
        if (candidate.source !== 'PIVOT_MAJOR' && candidate.source !== 'PIVOT_INTERMEDIATE') {
          continue;
        }
        if (winner === undefined) {
          winner = candidate;
          continue;
        }
        const candidateVolume = windowBars[candidate.index]?.volume ?? Number.NaN;
        const winnerVolume = windowBars[winner.index]?.volume ?? Number.NaN;
        if (
          candidate.score > winner.score ||
          (candidate.score === winner.score &&
            (candidateVolume > winnerVolume ||
              (candidateVolume === winnerVolume && candidate.index < winner.index)))
        ) {
          winner = candidate;
        }
      }
    } else {
      for (const candidate of cluster) {
        if (winner === undefined) {
          winner = candidate;
          continue;
        }
        const candidateVolume = windowBars[candidate.index]?.volume ?? Number.NaN;
        const winnerVolume = windowBars[winner.index]?.volume ?? Number.NaN;
        if (
          candidateVolume > winnerVolume ||
          (candidateVolume === winnerVolume && candidate.index < winner.index)
        ) {
          winner = candidate;
        }
      }
    }
    if (winner === undefined) continue;

    const winnerBar = windowBars[winner.index];
    if (winnerBar === undefined) continue;
    const anchorPrice =
      winner.pivotKind === 'LOW'
        ? winnerBar.low
        : winner.pivotKind === 'HIGH'
          ? winnerBar.high
          : winnerBar.close;

    const uniqueEventLabels =
      eventLabels.length > 0 ? [...new Set(eventLabels)].sort().join('/') : null;

    merged.push({
      anchorIndex: winner.index,
      anchorPrice,
      pivotKind: winner.pivotKind,
      sources,
      eventLabel: uniqueEventLabels,
      score,
      isGlobalExtreme: winner.index === globalLowIdx || winner.index === globalHighIdx,
      currentAvwap: Number.NaN,
      distancePct: Number.NaN,
      finalScore: Number.NaN,
    });
  }
  return merged;
}

/**
 * Detecta anclas institucionales Auto-AVWAP sobre barras diarias.
 *
 * Determinismo total: orden y desempates documentados en la Pieza 50.5, sin
 * aleatoriedad ni dependencia del reloj. Devuelve entre 0 y `maxAnchors` anclas
 * en orden fijo de rol `[SUPPORT?, RESISTANCE?, EVENT?]`.
 */
export function detectAutoAvwapAnchors(
  dailyBars: readonly Bar[],
  events: readonly AutoAvwapEventInput[] = [],
  options: AutoAvwapOptions = {},
): AutoAvwapAnchor[] {
  const resolved = resolveOptions(options);
  const sanitized = sanitizeDailyBars(dailyBars);
  const windowBars = sanitized.slice(-resolved.windowBars);
  const n = windowBars.length;
  if (n === 0) return [];
  const lastBar = windowBars[n - 1];
  if (lastBar === undefined || !(lastBar.close > 0)) return [];

  const atr = computeAutoAvwapAtrSeries(windowBars, resolved.atrPeriod);
  const stats = computeAutoAvwapVolumeStats(windowBars, resolved.rvolPeriod);

  const candidates: RawCandidate[] = [
    ...buildEventCandidates(windowBars, events),
    ...buildPivotCandidates(windowBars, atr, resolved),
    ...buildRvolCandidates(windowBars, atr, stats, resolved),
  ];

  const merged = mergeClusters(windowBars, candidates, resolved);
  const lastClose = lastBar.close;

  const scored: MergedCluster[] = [];
  for (const cluster of merged) {
    const points = calculateAnchoredVwap(windowBars, cluster.anchorIndex);
    if (points.length === 0) continue;
    const lastPoint = points[points.length - 1];
    if (lastPoint === undefined || !Number.isFinite(lastPoint.vwap)) continue;
    cluster.currentAvwap = lastPoint.vwap;
    cluster.distancePct = (lastPoint.vwap - lastClose) / lastClose;
    cluster.finalScore =
      Math.abs(cluster.distancePct) > resolved.maxDistancePct && !cluster.isGlobalExtreme
        ? cluster.score - resolved.farPenalty
        : cluster.score;
    scored.push(cluster);
  }

  scored.sort((a, b) => {
    if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
    const distanceDiff = Math.abs(a.distancePct) - Math.abs(b.distancePct);
    if (distanceDiff !== 0) return distanceDiff;
    return b.anchorIndex - a.anchorIndex;
  });

  let support: MergedCluster | undefined;
  for (const cluster of scored) {
    if (cluster.currentAvwap <= lastClose) {
      support = cluster;
      break;
    }
  }
  let resistance: MergedCluster | undefined;
  for (const cluster of scored) {
    if (cluster.currentAvwap > lastClose) {
      resistance = cluster;
      break;
    }
  }
  let event: MergedCluster | undefined;
  for (const cluster of scored) {
    if (!cluster.sources.includes('EVENT')) continue;
    if (support !== undefined && cluster.anchorIndex === support.anchorIndex) continue;
    if (resistance !== undefined && cluster.anchorIndex === resistance.anchorIndex) continue;
    event = cluster;
    break;
  }

  const selection: (readonly [AutoAnchorRole, MergedCluster])[] = [];
  const ordered: (readonly [AutoAnchorRole, MergedCluster | undefined])[] = [
    ['SUPPORT', support],
    ['RESISTANCE', resistance],
    ['EVENT', event],
  ];
  for (const [role, cluster] of ordered) {
    if (cluster === undefined) continue;
    selection.push([role, cluster]);
  }

  const anchors: AutoAvwapAnchor[] = [];
  for (const [role, cluster] of selection.slice(0, resolved.maxAnchors)) {
    const bar = windowBars[cluster.anchorIndex];
    if (bar === undefined) continue;
    anchors.push({
      role,
      anchorTimeSec: bar.time,
      windowIndex: cluster.anchorIndex,
      anchorPrice: cluster.anchorPrice,
      currentAvwap: cluster.currentAvwap,
      distancePct: cluster.distancePct,
      score: cluster.finalScore,
      sources: cluster.sources,
      eventLabel: cluster.eventLabel,
    });
  }
  return anchors;
}
