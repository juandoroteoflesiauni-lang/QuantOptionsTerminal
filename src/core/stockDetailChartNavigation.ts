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

/** Barra mínima con tiempo y campos usados por el anclaje AVWAP (Pieza 50.4). */
export interface MinimalTimedBar {
  readonly time: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly vw?: number | null | undefined;
}

/**
 * Pieza 50.4: índice de la barra con mínima distancia absoluta `|bar.time - targetTimeSec|`.
 * Desempate determinista: ante igualdad exacta de distancia conserva la barra anterior
 * (menor `time`) porque solo actualiza con `<` estricto sobre barras ordenadas.
 * Devuelve `-1` si `bars` está vacío o `targetTimeSec` no es finito.
 */
export function findNearestBarIndex(
  bars: readonly { readonly time: number }[],
  targetTimeSec: number,
): number {
  if (!Number.isFinite(targetTimeSec)) {
    return -1;
  }
  let bestIdx = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (bar === undefined || !Number.isFinite(bar.time)) {
      continue;
    }
    const dist = Math.abs(bar.time - targetTimeSec);
    if (dist < bestDist) {
      bestIdx = i;
      bestDist = dist;
    }
  }
  return bestIdx;
}

/**
 * Pieza 50.4: avanza desde `requestedAnchorIndex` hasta el primer índice `i >= requested`
 * con volumen > 0 y precio típico finito (`vw > 0` o `high/low/close` finitos). Garantiza
 * que fecha efectiva, marcador y primer punto visible de la curva AVWAP coincidan en la
 * misma vela. Devuelve `-1` si el índice es inválido o no existe barra válida posterior.
 */
export function resolveEffectiveAvwapAnchorIndex(
  bars: readonly MinimalTimedBar[],
  requestedAnchorIndex: number,
): number {
  if (
    !Number.isInteger(requestedAnchorIndex) ||
    requestedAnchorIndex < 0 ||
    requestedAnchorIndex >= bars.length
  ) {
    return -1;
  }
  for (let i = requestedAnchorIndex; i < bars.length; i += 1) {
    const bar = bars[i];
    if (bar === undefined) {
      continue;
    }
    const vwValue = bar.vw;
    const hasValidVw = vwValue !== undefined && vwValue !== null && Number.isFinite(vwValue) && vwValue > 0;
    const hasFiniteHlc =
      Number.isFinite(bar.high) && Number.isFinite(bar.low) && Number.isFinite(bar.close);
    if (Number.isFinite(bar.volume) && bar.volume > 0 && (hasValidVw || hasFiniteHlc)) {
      return i;
    }
  }
  return -1;
}

const AUTO_AVWAP_SECONDS_PER_DAY = 86_400;

/**
 * Pieza 50.5: proyecta el timestamp diario `anchorTimeSec` de un ancla Auto-AVWAP
 * sobre el array de barras del timeframe activo (`1D`, `1W` o intradiario `1m..4h`).
 * Devuelve `-1` si el ancla cae fuera de la ventana cargada (omisión limpia).
 *
 * Reglas deterministas:
 *  - `1D`: barra más cercana (`findNearestBarIndex`), válida solo si `|Δ| <= 4 días`.
 *  - `1W`: semana contenedora `bars[i].time <= anchor < bars[i+1].time`; última semana
 *    si el ancla cae hasta 6 días después del último bar; fallback por cercanía <= 7 días.
 *  - Intradiario: fuera de `[first - 1d, last + 1d]` => `-1`; en rango, primer índice con
 *    `bars[i].time >= anchorTimeSec` (un ancla a las 00:00 UTC cae en la primera vela RTH
 *    de esa misma fecha UTC, 13:30/14:30 UTC).
 */
export function resolveAutoAvwapBarIndex(
  bars: readonly { readonly time: number }[],
  anchorTimeSec: number,
  timeframe: string,
): number {
  if (bars.length === 0 || !Number.isFinite(anchorTimeSec)) {
    return -1;
  }

  if (timeframe === '1D') {
    const idx = findNearestBarIndex(bars, anchorTimeSec);
    if (idx < 0) {
      return -1;
    }
    const bar = bars[idx];
    if (bar === undefined || !Number.isFinite(bar.time)) {
      return -1;
    }
    return Math.abs(bar.time - anchorTimeSec) <= 4 * AUTO_AVWAP_SECONDS_PER_DAY ? idx : -1;
  }

  if (timeframe === '1W') {
    for (let i = 0; i < bars.length - 1; i += 1) {
      const current = bars[i];
      const next = bars[i + 1];
      if (current === undefined || next === undefined) {
        continue;
      }
      if (current.time <= anchorTimeSec && anchorTimeSec < next.time) {
        return i;
      }
    }
    const last = bars[bars.length - 1];
    if (
      last !== undefined &&
      anchorTimeSec >= last.time &&
      anchorTimeSec - last.time <= 6 * AUTO_AVWAP_SECONDS_PER_DAY
    ) {
      return bars.length - 1;
    }
    const fallback = findNearestBarIndex(bars, anchorTimeSec);
    if (fallback >= 0) {
      const bar = bars[fallback];
      if (bar !== undefined && Math.abs(bar.time - anchorTimeSec) <= 7 * AUTO_AVWAP_SECONDS_PER_DAY) {
        return fallback;
      }
    }
    return -1;
  }

  const first = bars[0];
  const last = bars[bars.length - 1];
  if (first === undefined || last === undefined) {
    return -1;
  }
  if (
    anchorTimeSec < first.time - AUTO_AVWAP_SECONDS_PER_DAY ||
    anchorTimeSec > last.time + AUTO_AVWAP_SECONDS_PER_DAY
  ) {
    return -1;
  }
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (bar !== undefined && bar.time >= anchorTimeSec) {
      return i;
    }
  }
  return -1;
}
