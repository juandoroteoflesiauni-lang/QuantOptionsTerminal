/**
 * Utilidades puras para estabilidad de navegación del gráfico de Stock Detail
 * (pan/zoom libre, sincronización bidireccional sin bucles, anclaje AVWAP por
 * clic y decisión de actualización incremental vs `fitContent`).
 *
 * Sin red, sin UI y sin mutar argumentos; verificado contra referencia Python
 * independiente en `tools/gen_stock_detail_chart_navigation_reference.py` (< 1e-9).
 */

export interface ChartLogicalRange {
  readonly from: number;
  readonly to: number;
}

export type ChartSeriesUpdateMode = 'CLEAR' | 'SET_DATA' | 'UPDATE_LAST';

export interface ChartViewportTransitionInput {
  readonly previousKey: string | null;
  readonly nextKey: string | null;
  readonly previousBarCount: number;
  readonly nextBarCount: number;
  readonly previousFirstBarTime: number | null;
  readonly nextFirstBarTime: number | null;
  readonly previousLastBarTime: number | null;
  readonly nextLastBarTime: number | null;
}

export interface ChartViewportTransitionOutput {
  readonly shouldFitContent: boolean;
  readonly updateMode: ChartSeriesUpdateMode;
}

function isFiniteLogicalRange(range: ChartLogicalRange | null): range is ChartLogicalRange {
  return (
    range !== null &&
    Number.isFinite(range.from) &&
    Number.isFinite(range.to) &&
    range.from <= range.to
  );
}

/**
 * Construye la clave de identidad del dataset cargado en el gráfico.
 * No incluye ticks en vivo ni modos de overlay para evitar resetear el viewport.
 */
export function resolveChartFitKey(
  ticker: string,
  timeframe: string,
  barsAvailable: boolean,
  firstBarTime: number | null,
): string | null {
  if (!barsAvailable || firstBarTime === null || !Number.isFinite(firstBarTime)) {
    return null;
  }
  const cleanTicker = ticker.trim().toUpperCase();
  const cleanTimeframe = timeframe.trim();
  if (cleanTicker.length === 0 || cleanTimeframe.length === 0) {
    return null;
  }
  return `${cleanTicker}|${cleanTimeframe}|${String(firstBarTime)}`;
}

/**
 * Decide si la actualización de series debe ejecutar `fitContent()` o preservar
 * el zoom/pan del usuario, y si basta con `update()` sobre la última vela.
 */
export function resolveChartViewportTransition(
  input: ChartViewportTransitionInput,
): ChartViewportTransitionOutput {
  if (
    input.nextKey === null ||
    !Number.isInteger(input.nextBarCount) ||
    input.nextBarCount <= 0
  ) {
    return {
      shouldFitContent: false,
      updateMode: 'CLEAR',
    };
  }

  if (
    input.previousKey === null ||
    !Number.isInteger(input.previousBarCount) ||
    input.previousBarCount <= 0
  ) {
    return {
      shouldFitContent: true,
      updateMode: 'SET_DATA',
    };
  }

  const keyChanged = input.previousKey !== input.nextKey;
  const firstBarChanged = input.previousFirstBarTime !== input.nextFirstBarTime;
  const barCountDelta = Math.abs(input.nextBarCount - input.previousBarCount);
  const historyJumped = barCountDelta > 2;
  const shouldFitContent = keyChanged || firstBarChanged || historyJumped;

  const prevFirst = input.previousFirstBarTime;
  const nextFirst = input.nextFirstBarTime;
  const prevLast = input.previousLastBarTime;
  const nextLast = input.nextLastBarTime;

  const sameBaseSeries =
    !keyChanged &&
    !firstBarChanged &&
    prevFirst !== null &&
    nextFirst !== null &&
    Number.isFinite(prevFirst) &&
    Number.isFinite(nextFirst);
  const validLastTimes =
    prevLast !== null &&
    nextLast !== null &&
    Number.isFinite(prevLast) &&
    Number.isFinite(nextLast);

  const isSameTailTick =
    sameBaseSeries &&
    validLastTimes &&
    input.nextBarCount === input.previousBarCount &&
    nextLast === prevLast;
  const isSingleBarRollover =
    sameBaseSeries &&
    validLastTimes &&
    input.nextBarCount === input.previousBarCount + 1 &&
    nextLast > prevLast;

  return {
    shouldFitContent,
    updateMode: isSameTailTick || isSingleBarRollover ? 'UPDATE_LAST' : 'SET_DATA',
  };
}

/**
 * Compara dos rangos lógicos finitos dentro de una tolerancia dada.
 */
export function areLogicalRangesClose(
  a: ChartLogicalRange | null,
  b: ChartLogicalRange | null,
  tolerance = 1e-4,
): boolean {
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    return false;
  }
  if (!isFiniteLogicalRange(a) || !isFiniteLogicalRange(b)) {
    return false;
  }
  return Math.abs(a.from - b.from) <= tolerance && Math.abs(a.to - b.to) <= tolerance;
}

/**
 * Determina si un gráfico receptor debe aplicar un rango lógico entrante del
 * otro panel (evita re-aplicar rangos idénticos o inválidos).
 */
export function shouldApplyExternalLogicalRange(
  currentRange: ChartLogicalRange | null,
  incomingRange: ChartLogicalRange | null,
  tolerance = 1e-4,
): boolean {
  if (!isFiniteLogicalRange(incomingRange)) {
    return false;
  }
  if (currentRange !== null && areLogicalRangesClose(currentRange, incomingRange, tolerance)) {
    return false;
  }
  return true;
}

/**
 * Determina si un cambio de rango lógico emitido por Lightweight Charts debe
 * propagarse al otro panel o suprimirse por tratarse de un eco de sincronización.
 */
export function shouldEmitLogicalRangeSync(
  emittedRange: ChartLogicalRange | null,
  isSuppressed: boolean,
  pendingExternalRange: ChartLogicalRange | null,
  tolerance = 1e-3,
): boolean {
  if (isSuppressed || !isFiniteLogicalRange(emittedRange)) {
    return false;
  }
  if (
    pendingExternalRange !== null &&
    areLogicalRangesClose(emittedRange, pendingExternalRange, tolerance)
  ) {
    return false;
  }
  return true;
}

/**
 * Resuelve el timestamp ancla de AVWAP solo ante clic explícito cuando el modo
 * activo es `CLICKED_CANDLE`. En cualquier otro modo devuelve `null` para no
 * disparar recomputaciones del bundle durante hover o drag.
 */
export function resolveAvwapClickAnchor(
  avwapMode: string,
  clickedTimeSec: number | null,
  currentAnchorTimeSec: number | null,
): number | null {
  if (avwapMode !== 'CLICKED_CANDLE') {
    return null;
  }
  if (clickedTimeSec !== null && Number.isFinite(clickedTimeSec)) {
    return clickedTimeSec;
  }
  if (currentAnchorTimeSec !== null && Number.isFinite(currentAnchorTimeSec)) {
    return currentAnchorTimeSec;
  }
  return null;
}
