/**
 * Pieza 44 — Planificador puro de ventanas históricas FMP Enterprise y merge UTC sin mutación.
 */

import type { Bar } from '../types.js';
import type { Timeframe } from '../../data/types.js';

export interface FmpDateWindow {
  readonly fromUtcSec: number;
  readonly toUtcSec: number;
}

export interface PlanFmpWindowsInput {
  readonly fromUtcSec: number;
  readonly toUtcSec: number;
  readonly timeframe: Timeframe;
  readonly windowDaysOverride?: number;
  readonly overlapDays?: number;
}

export interface MergeFmpBarsOptions {
  readonly fromUtcSec?: number;
  readonly toUtcSec?: number;
  readonly maxBars?: number;
}

const DEFAULT_FMP_WINDOW_DAYS: Readonly<Record<Timeframe, number>> = {
  '1m': 3,
  '5m': 7,
  '15m': 14,
  '1h': 30,
  '4h': 60,
  '1D': 1825,
};

const SECONDS_PER_DAY = 86_400;

/**
 * Devuelve la cantidad de días por ventana recomendada para cada timeframe en FMP Enterprise.
 */
export function defaultFmpWindowDaysForTimeframe(timeframe: Timeframe): number {
  return DEFAULT_FMP_WINDOW_DAYS[timeframe];
}

/**
 * Divide `[fromUtcSec, toUtcSec]` en ventanas regresivas ordenadas del más reciente al más antiguo
 * con solapamiento opcional de días para no perder bordes diarios en zona horaria ET.
 */
export function planFmpIntradayDateWindows(input: PlanFmpWindowsInput): readonly FmpDateWindow[] {
  const fromUtcSec = Math.trunc(input.fromUtcSec);
  const toUtcSec = Math.trunc(input.toUtcSec);
  if (!Number.isFinite(fromUtcSec) || !Number.isFinite(toUtcSec) || toUtcSec < fromUtcSec) {
    return [];
  }

  const windowDays = Math.max(
    2,
    Math.trunc(input.windowDaysOverride ?? defaultFmpWindowDaysForTimeframe(input.timeframe)),
  );
  const overlapDays = Math.max(0, Math.min(windowDays - 1, Math.trunc(input.overlapDays ?? 1)));

  const spanSec = windowDays * SECONDS_PER_DAY;
  const overlapSec = overlapDays * SECONDS_PER_DAY;
  const windows: FmpDateWindow[] = [];

  let cursorTo = toUtcSec;
  for (let guard = 0; guard < 2_000; guard += 1) {
    const windowStart = Math.max(fromUtcSec, cursorTo - spanSec);
    windows.push({
      fromUtcSec: windowStart,
      toUtcSec: cursorTo,
    });
    if (windowStart <= fromUtcSec) {
      break;
    }
    const nextTo = Math.min(cursorTo - 1, windowStart + overlapSec);
    if (nextTo >= cursorTo) {
      break;
    }
    cursorTo = nextTo;
  }

  return windows;
}

/**
 * Deduplica por timestamp UTC exacto en segundos, ordena ascendentemente y filtra el rango.
 * En caso de barras duplicadas con igual `time`, prevalece la última recibida.
 */
export function mergeFmpPaginatedBars(
  pages: readonly (readonly Bar[])[],
  options: MergeFmpBarsOptions = {},
): readonly Bar[] {
  const fromFilter =
    options.fromUtcSec !== undefined && Number.isFinite(options.fromUtcSec)
      ? Math.trunc(options.fromUtcSec)
      : null;
  const toFilter =
    options.toUtcSec !== undefined && Number.isFinite(options.toUtcSec)
      ? Math.trunc(options.toUtcSec)
      : null;

  const byTime = new Map<number, Bar>();
  for (const page of pages) {
    for (const b of page) {
      if (
        !Number.isFinite(b.time) ||
        b.time <= 0 ||
        !Number.isFinite(b.open) ||
        !Number.isFinite(b.high) ||
        !Number.isFinite(b.low) ||
        !Number.isFinite(b.close) ||
        b.open <= 0 ||
        b.high <= 0 ||
        b.low <= 0 ||
        b.close <= 0 ||
        !Number.isFinite(b.volume) ||
        b.volume < 0
      ) {
        continue;
      }
      const timeSec = Math.trunc(b.time);
      if (fromFilter !== null && timeSec < fromFilter) continue;
      if (toFilter !== null && timeSec > toFilter) continue;
      const vwValid = b.vw !== undefined && Number.isFinite(b.vw) && b.vw > 0 ? b.vw : undefined;
      byTime.set(timeSec, {
        time: timeSec,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        ...(vwValid !== undefined ? { vw: vwValid } : {}),
      });
    }
  }

  const sorted = [...byTime.values()].sort((a, b) => a.time - b.time);
  if (
    options.maxBars !== undefined &&
    Number.isFinite(options.maxBars) &&
    options.maxBars > 0 &&
    sorted.length > options.maxBars
  ) {
    return sorted.slice(sorted.length - Math.trunc(options.maxBars));
  }
  return sorted;
}
