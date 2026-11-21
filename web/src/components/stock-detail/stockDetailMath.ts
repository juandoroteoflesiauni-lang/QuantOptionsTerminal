/**
 * Motor matemático puro para la vista Detalle de Acción (`/acciones/:ticker`).
 *
 * Política AGENTS.md / SPEC.md:
 * - Funciones puras en TypeScript, sin efectos secundarios, red, DOM ni mutación de argumentos.
 * - Formato único de barra: `{ time: segundos UTC, open, high, low, close, volume, vw? }`.
 * - Política Zero Silent Fallbacks: valores no calculables devuelven `NaN`.
 */

import { resolveEffectiveAvwapAnchorIndex } from '../../../../src/core/stockDetailChartNavigation.js';

export type AvwapAnchorMode =
  | 'MONTH_START'
  | 'LAST_EXPIRY'
  | 'LAST_EARNINGS'
  | 'SWING_HIGH_60D'
  | 'SWING_LOW_60D';

export interface MinimalOhlcvBar {
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly vw?: number | null | undefined;
}

export interface LeeReadyBarFlowPoint {
  readonly time: number;
  readonly barDelta: number;
  readonly cvd: number;
  readonly cumulativeBuyVol: number;
  readonly cumulativeSellVol: number;
  readonly buyerPct: number;
  readonly sellerPct: number;
}

export interface RelativeStrengthPoint {
  readonly time: number;
  readonly assetClose: number;
  readonly benchmarkClose: number;
  readonly rsRatio: number;
  readonly rsNormalizedPct: number;
}

export interface SpatialLevelInputPoint {
  readonly name: string;
  readonly category: string;
  readonly price: number;
}

export interface SpatialProximityItem {
  readonly name: string;
  readonly category: string;
  readonly price: number;
  readonly signedDistAbs: number;
  readonly distanceAbs: number;
  readonly distancePct: number;
  readonly distanceAtr: number;
  readonly withinBand: boolean;
}

export interface ExpectedMoveBoundsResult {
  readonly oneSigmaAbs: number;
  readonly oneSigmaPct: number;
  readonly upper1Sigma: number;
  readonly lower1Sigma: number;
}

export interface Ci24hCarryResult {
  readonly spreadPct: number;
  readonly impliedTnaPct: number;
}

export interface AtrPositionSizingResult {
  readonly stopLossPrice: number;
  readonly stopDistanceAbs: number;
  readonly riskBudget: number;
  readonly suggestedQty: number;
}

/** Calcula serie EMA estándar con semilla SMA en `closes[0..period-1]`. */
export function computeEmaSeriesPure(closes: readonly number[], period: number): readonly number[] {
  const n = closes.length;
  if (n === 0 || !Number.isInteger(period) || period <= 0) {
    return closes.map(() => Number.NaN);
  }
  const out = new Array<number>(n).fill(Number.NaN);
  if (n < period) {
    return out;
  }

  let seedSum = 0;
  for (let i = 0; i < period; i += 1) {
    const val = closes[i] ?? Number.NaN;
    if (!Number.isFinite(val)) {
      return out;
    }
    seedSum += val;
  }

  let prev = seedSum / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);

  for (let i = period; i < n; i += 1) {
    const val = closes[i] ?? Number.NaN;
    if (!Number.isFinite(val)) {
      prev = Number.NaN;
      out[i] = Number.NaN;
      continue;
    }
    prev = Number.isFinite(prev) ? val * k + prev * (1 - k) : Number.NaN;
    out[i] = prev;
  }
  return out;
}

/** Calcula ATR(period) de Wilder sobre barras OHLC. */
export function computeWilderAtrPure(bars: readonly MinimalOhlcvBar[], period = 14): readonly number[] {
  const n = bars.length;
  const out = new Array<number>(n).fill(Number.NaN);
  if (n === 0 || !Number.isInteger(period) || period <= 0 || n < period + 1) {
    return out;
  }

  const tr = new Array<number>(n).fill(Number.NaN);
  for (let i = 1; i < n; i += 1) {
    const curr = bars[i];
    const prev = bars[i - 1];
    if (
      curr === undefined ||
      prev === undefined ||
      !Number.isFinite(curr.high) ||
      !Number.isFinite(curr.low) ||
      !Number.isFinite(prev.close)
    ) {
      continue;
    }
    tr[i] = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close),
    );
  }

  let sumTr = 0;
  for (let i = 1; i <= period; i += 1) {
    const t = tr[i] ?? Number.NaN;
    if (!Number.isFinite(t)) {
      return out;
    }
    sumTr += t;
  }

  let prevAtr = sumTr / period;
  out[period] = prevAtr;
  for (let i = period + 1; i < n; i += 1) {
    const t = tr[i] ?? Number.NaN;
    if (!Number.isFinite(t) || !Number.isFinite(prevAtr)) {
      prevAtr = Number.NaN;
      out[i] = Number.NaN;
      continue;
    }
    prevAtr = (prevAtr * (period - 1) + t) / period;
    out[i] = prevAtr;
  }
  return out;
}

function getTypicalPrice(bar: MinimalOhlcvBar): number {
  if (bar.vw !== undefined && bar.vw !== null && Number.isFinite(bar.vw) && bar.vw > 0) {
    return bar.vw;
  }
  if (Number.isFinite(bar.high) && Number.isFinite(bar.low) && Number.isFinite(bar.close)) {
    return (bar.high + bar.low + bar.close) / 3;
  }
  return Number.NaN;
}

/**
 * VWAP de sesión intradiario agrupando sesiones por `Math.floor((time + tzOffsetSec) / 86400)`.
 * En temporalidad `1D` devuelve `NaN` para evitar resets diarios triviales.
 */
export function computeSessionVwapPure(
  bars: readonly MinimalOhlcvBar[],
  isIntraday: boolean,
  tzOffsetSec = 0,
): readonly number[] {
  if (!isIntraday) {
    return bars.map(() => Number.NaN);
  }
  const out = new Array<number>(bars.length).fill(Number.NaN);
  let currentDayKey: number | null = null;
  let cumPv = 0;
  let cumVol = 0;

  for (let i = 0; i < bars.length; i += 1) {
    const b = bars[i];
    if (b === undefined || !Number.isFinite(b.time) || !Number.isFinite(b.volume)) {
      continue;
    }
    const dayKey = Math.floor((b.time + tzOffsetSec) / 86_400);
    if (currentDayKey === null || dayKey !== currentDayKey) {
      currentDayKey = dayKey;
      cumPv = 0;
      cumVol = 0;
    }
    const tp = getTypicalPrice(b);
    if (Number.isFinite(tp) && b.volume > 0) {
      cumPv += tp * b.volume;
      cumVol += b.volume;
    }
    out[i] = cumVol > 0 ? cumPv / cumVol : Number.NaN;
  }
  return out;
}

/**
 * Pieza 50.6: alinea `overlays.sessionVwap` del backend US con las barras
 * renderizadas. La asociación `time → valor` se construye desde las parejas
 * ORIGINALES (`response.bars[i]` / `sessionVwap[i]`) antes de ordenar,
 * deduplicar o descartar barras; ante `time` duplicado gana la última
 * ocurrencia (misma política que `dedupAndSortBars`) y un valor no finito se
 * preserva como `null`. Devuelve `null` si el overlay falta o su longitud no
 * corresponde a las barras de origen: la vista deja la serie vacía sin
 * recalcular un VWAP local.
 */
export function alignSessionVwapOverlayByTime(
  sourceBars: readonly MinimalOhlcvBar[],
  sessionVwap: readonly (number | null)[] | null | undefined,
  renderedBars: readonly MinimalOhlcvBar[],
): readonly (number | null)[] | null {
  if (sessionVwap === null || sessionVwap === undefined) {
    return null;
  }
  if (sessionVwap.length !== sourceBars.length) {
    return null;
  }
  const byTime = new Map<number, number | null>();
  for (let index = 0; index < sourceBars.length; index += 1) {
    const bar = sourceBars[index];
    if (bar === undefined || !Number.isFinite(bar.time)) {
      continue;
    }
    const value = sessionVwap[index] ?? null;
    byTime.set(bar.time, value !== null && Number.isFinite(value) ? value : null);
  }
  return renderedBars.map((bar) => byTime.get(bar.time) ?? null);
}

/** Calcula el timestamp UTC (00:00 UTC) del 3er viernes del mes dado `(year, month0)`. */
export function thirdFridayUtcSec(year: number, monthZeroBased: number): number {
  const firstDay = new Date(Date.UTC(year, monthZeroBased, 1, 0, 0, 0));
  const dow = firstDay.getUTCDay(); // 0 = Sun ... 5 = Fri
  const offsetToFirstFriday = (5 - dow + 7) % 7;
  const thirdFridayDay = 1 + offsetToFirstFriday + 14;
  return Math.floor(Date.UTC(year, monthZeroBased, thirdFridayDay, 0, 0, 0) / 1_000);
}

/**
 * Resuelve el índice de barra ancla para AVWAP según el modo elegido.
 * Devuelve `-1` si no existe ancla válida sin inventar fechas.
 */
export function resolveAvwapAnchorIndex(
  bars: readonly MinimalOhlcvBar[],
  mode: AvwapAnchorMode,
  customAnchorSec?: number | null,
): number {
  if (bars.length === 0) {
    return -1;
  }
  const lastBar = bars[bars.length - 1];
  if (lastBar === undefined || !Number.isFinite(lastBar.time)) {
    return -1;
  }

  if (mode === 'MONTH_START') {
    const dLast = new Date(lastBar.time * 1_000);
    const monthStartSec = Math.floor(Date.UTC(dLast.getUTCFullYear(), dLast.getUTCMonth(), 1, 0, 0, 0) / 1_000);
    return bars.findIndex((b) => Number.isFinite(b.time) && b.time >= monthStartSec);
  }

  if (mode === 'SWING_HIGH_60D') {
    const startIdx = Math.max(0, bars.length - 60);
    let bestIdx = -1;
    let bestHigh = Number.NEGATIVE_INFINITY;
    for (let i = startIdx; i < bars.length; i += 1) {
      const b = bars[i];
      if (b !== undefined && Number.isFinite(b.high) && b.high > bestHigh) {
        bestHigh = b.high;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  if (mode === 'SWING_LOW_60D') {
    const startIdx = Math.max(0, bars.length - 60);
    let bestIdx = -1;
    let bestLow = Number.POSITIVE_INFINITY;
    for (let i = startIdx; i < bars.length; i += 1) {
      const b = bars[i];
      if (b !== undefined && Number.isFinite(b.low) && b.low < bestLow) {
        bestLow = b.low;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  if (mode === 'LAST_EARNINGS') {
    if (customAnchorSec === undefined || customAnchorSec === null || !Number.isFinite(customAnchorSec)) {
      return -1;
    }
    return bars.findIndex((b) => Number.isFinite(b.time) && b.time >= customAnchorSec);
  }

  // LAST_EXPIRY: usar vencimiento provisto si es pasado/presente; sino 3er viernes del mes (o mes previo).
  let targetSec: number;
  if (customAnchorSec !== undefined && customAnchorSec !== null && Number.isFinite(customAnchorSec) && customAnchorSec <= lastBar.time) {
    targetSec = customAnchorSec;
  } else {
    const dLast = new Date(lastBar.time * 1_000);
    const currMonthOpex = thirdFridayUtcSec(dLast.getUTCFullYear(), dLast.getUTCMonth());
    if (currMonthOpex <= lastBar.time) {
      targetSec = currMonthOpex;
    } else {
      const prevDate = new Date(Date.UTC(dLast.getUTCFullYear(), dLast.getUTCMonth() - 1, 1));
      targetSec = thirdFridayUtcSec(prevDate.getUTCFullYear(), prevDate.getUTCMonth());
    }
  }
  const idx = bars.findIndex((b) => Number.isFinite(b.time) && b.time >= targetSec);
  return idx >= 0 ? idx : bars.findIndex((b) => Number.isFinite(b.time) && b.time >= (bars[0]?.time ?? 0));
}

/** Calcula AVWAP anclado desde `anchorIndex` ( inclusive). Devuelves `NaN` antes del ancla. */
export function computeAnchoredVwapPure(
  bars: readonly MinimalOhlcvBar[],
  anchorIndex: number,
): readonly number[] {
  const out = new Array<number>(bars.length).fill(Number.NaN);
  if (anchorIndex < 0 || anchorIndex >= bars.length) {
    return out;
  }
  let cumPv = 0;
  let cumVol = 0;
  for (let i = anchorIndex; i < bars.length; i += 1) {
    const b = bars[i];
    if (b === undefined || !Number.isFinite(b.volume)) {
      continue;
    }
    const tp = getTypicalPrice(b);
    if (Number.isFinite(tp) && b.volume > 0) {
      cumPv += tp * b.volume;
      cumVol += b.volume;
    }
    out[i] = cumVol > 0 ? cumPv / cumVol : Number.NaN;
  }
  return out;
}

/** Resultado de AVWAP con ancla efectiva resuelta (Pieza 50.4). */
export interface AnchoredVwapWithAnchorResult {
  readonly series: readonly number[];
  readonly requestedAnchorIndex: number;
  readonly effectiveAnchorIndex: number;
  readonly effectiveAnchorTime: number | null;
}

/**
 * Pieza 50.4: AVWAP con ancla efectiva — si la vela pedida tiene `volume <= 0` (o precio
 * típico no finito), avanza a la primera vela válida para que la curva visual, la fecha
 * declarada y el marcador coincidan exactamente. `series` es `computeAnchoredVwapPure`
 * desde el ancla efectiva (`NaN` antes del ancla).
 */
export function computeAnchoredVwapWithAnchor(
  bars: readonly MinimalOhlcvBar[],
  requestedAnchorIndex: number,
): AnchoredVwapWithAnchorResult {
  const effectiveAnchorIndex = resolveEffectiveAvwapAnchorIndex(bars, requestedAnchorIndex);
  const effectiveAnchorTime =
    effectiveAnchorIndex >= 0 ? (bars[effectiveAnchorIndex]?.time ?? null) : null;
  const series = computeAnchoredVwapPure(bars, effectiveAnchorIndex);
  return { series, requestedAnchorIndex, effectiveAnchorIndex, effectiveAnchorTime };
}

/**
 * Estima flujo agresor por barra usando CLV (Close Location Value) + regla tick cuando `H === L`,
 * acumulando CVD y participación `% Comprador / % Vendedor` sin valores inventados.
 */
export function computeLeeReadyBarFlow(bars: readonly MinimalOhlcvBar[]): readonly LeeReadyBarFlowPoint[] {
  const out: LeeReadyBarFlowPoint[] = [];
  let cvd = 0;
  let cumBuyVol = 0;
  let cumSellVol = 0;
  let totalVol = 0;

  for (let i = 0; i < bars.length; i += 1) {
    const b = bars[i];
    if (b === undefined) continue;
    const prev = bars[i - 1];
    const validBar =
      Number.isFinite(b.high) &&
      Number.isFinite(b.low) &&
      Number.isFinite(b.close) &&
      Number.isFinite(b.volume) &&
      b.volume >= 0;
    if (!validBar) {
      out.push({
        time: b.time,
        barDelta: Number.NaN,
        cvd: Number.NaN,
        cumulativeBuyVol: cumBuyVol,
        cumulativeSellVol: cumSellVol,
        buyerPct: totalVol > 0 ? (cumBuyVol / totalVol) * 100 : Number.NaN,
        sellerPct: totalVol > 0 ? (cumSellVol / totalVol) * 100 : Number.NaN,
      });
      continue;
    }

    const range = b.high - b.low;
    let clv = 0;
    if (range > 0) {
      clv = Math.max(-1, Math.min(1, (2 * b.close - b.high - b.low) / range));
    } else if (prev !== undefined && Number.isFinite(prev.close)) {
      clv = b.close > prev.close ? 1 : b.close < prev.close ? -1 : 0;
    }

    const buyFrac = 0.5 * (clv + 1);
    const sellFrac = 1 - buyFrac;
    const buyVol = b.volume * buyFrac;
    const sellVol = b.volume * sellFrac;
    const barDelta = b.volume * clv;

    cvd += barDelta;
    cumBuyVol += buyVol;
    cumSellVol += sellVol;
    totalVol += b.volume;

    out.push({
      time: b.time,
      barDelta,
      cvd,
      cumulativeBuyVol: cumBuyVol,
      cumulativeSellVol: cumSellVol,
      buyerPct: totalVol > 0 ? (cumBuyVol / totalVol) * 100 : Number.NaN,
      sellerPct: totalVol > 0 ? (cumSellVol / totalVol) * 100 : Number.NaN,
    });
  }
  return out;
}

/**
 * Fuerza Relativa (RS) alineando barras del activo contra benchmark por día UTC (`floor(time / 86400)`)
 * o timestamp sin lookahead (two-pointer causal). Devuelve ratio y spread porcentual normalizado a base 0%.
 */
export function computeRelativeStrengthSeries(
  assetBars: readonly MinimalOhlcvBar[],
  benchmarkBars: readonly MinimalOhlcvBar[],
  alignByUtcDay = true,
): readonly RelativeStrengthPoint[] {
  if (assetBars.length === 0 || benchmarkBars.length === 0) {
    return [];
  }
  const keyFn = (t: number) => (alignByUtcDay ? Math.floor(t / 86_400) : t);
  let j = 0;
  let lastBenchClose = Number.NaN;
  let baseRatio = Number.NaN;
  const out: RelativeStrengthPoint[] = [];

  for (let i = 0; i < assetBars.length; i += 1) {
    const a = assetBars[i];
    if (a === undefined || !Number.isFinite(a.time) || !Number.isFinite(a.close) || a.close <= 0) {
      continue;
    }
    const aKey = keyFn(a.time);
    while (j < benchmarkBars.length) {
      const bm = benchmarkBars[j];
      if (bm === undefined || !Number.isFinite(bm.time) || keyFn(bm.time) > aKey) {
        break;
      }
      if (Number.isFinite(bm.close) && bm.close > 0) {
        lastBenchClose = bm.close;
      }
      j += 1;
    }
    if (!Number.isFinite(lastBenchClose) || lastBenchClose <= 0) {
      out.push({
        time: a.time,
        assetClose: a.close,
        benchmarkClose: Number.NaN,
        rsRatio: Number.NaN,
        rsNormalizedPct: Number.NaN,
      });
      continue;
    }
    const rsRatio = a.close / lastBenchClose;
    if (!Number.isFinite(baseRatio)) {
      baseRatio = rsRatio;
    }
    const rsNormalizedPct = ((rsRatio / baseRatio) - 1) * 100;
    out.push({
      time: a.time,
      assetClose: a.close,
      benchmarkClose: lastBenchClose,
      rsRatio,
      rsNormalizedPct,
    });
  }
  return out;
}

/** Volatilidad Realizada móvil (RV) sobre retornos logarítmicos diarios (ddof = 1, % anualizada). */
export function computeRollingRvSeries(
  bars: readonly MinimalOhlcvBar[],
  window = 30,
  annualizationDays = 252,
): readonly number[] {
  const n = bars.length;
  const out = new Array<number>(n).fill(Number.NaN);
  if (n <= window || !Number.isInteger(window) || window < 2 || annualizationDays <= 0) {
    return out;
  }
  const logReturns = new Array<number>(n).fill(Number.NaN);
  for (let i = 1; i < n; i += 1) {
    const curr = bars[i]?.close ?? Number.NaN;
    const prev = bars[i - 1]?.close ?? Number.NaN;
    if (Number.isFinite(curr) && Number.isFinite(prev) && curr > 0 && prev > 0) {
      logReturns[i] = Math.log(curr / prev);
    }
  }

  const annFactor = Math.sqrt(annualizationDays) * 100;
  for (let i = window; i < n; i += 1) {
    let valid = true;
    let sum = 0;
    for (let k = i - window + 1; k <= i; k += 1) {
      const r = logReturns[k] ?? Number.NaN;
      if (!Number.isFinite(r)) {
        valid = false;
        break;
      }
      sum += r;
    }
    if (!valid) continue;
    const mean = sum / window;
    let sqDiffSum = 0;
    for (let k = i - window + 1; k <= i; k += 1) {
      const d = (logReturns[k] ?? 0) - mean;
      sqDiffSum += d * d;
    }
    const variance = sqDiffSum / (window - 1);
    out[i] = Math.sqrt(variance) * annFactor;
  }
  return out;
}

/** Tasa de pase / carry anualizado implícita entre Contado Inmediato (CI) y 24hs. */
export function computeCi24hImpliedCarry(
  priceCi: number,
  price24h: number,
  settlementDays = 1,
): Ci24hCarryResult {
  if (
    !Number.isFinite(priceCi) ||
    !Number.isFinite(price24h) ||
    !Number.isFinite(settlementDays) ||
    priceCi <= 0 ||
    price24h <= 0 ||
    settlementDays <= 0
  ) {
    return { spreadPct: Number.NaN, impliedTnaPct: Number.NaN };
  }
  const spread = price24h / priceCi - 1;
  return {
    spreadPct: spread * 100,
    impliedTnaPct: spread * (365 / settlementDays) * 100,
  };
}

/** Banda ±1σ Expected Move (spot * IV_dec * sqrt(DTE/365)). */
export function computeExpectedMoveBounds(
  spot: number,
  ivDecimal: number,
  daysToExpiry: number,
): ExpectedMoveBoundsResult {
  if (
    !Number.isFinite(spot) ||
    !Number.isFinite(ivDecimal) ||
    !Number.isFinite(daysToExpiry) ||
    spot <= 0 ||
    ivDecimal <= 0 ||
    daysToExpiry <= 0
  ) {
    return {
      oneSigmaAbs: Number.NaN,
      oneSigmaPct: Number.NaN,
      upper1Sigma: Number.NaN,
      lower1Sigma: Number.NaN,
    };
  }
  const sigmaMoveDec = ivDecimal * Math.sqrt(daysToExpiry / 365);
  const oneSigmaAbs = spot * sigmaMoveDec;
  return {
    oneSigmaAbs,
    oneSigmaPct: sigmaMoveDec * 100,
    upper1Sigma: spot + oneSigmaAbs,
    lower1Sigma: Math.max(0, spot - oneSigmaAbs),
  };
}

/** Dimensionamiento de posición por riesgo máximo porcentual y stop basado en ATR(14). */
export function computeAtrPositionSize(params: {
  readonly equity: number;
  readonly riskPct: number;
  readonly entryPrice: number;
  readonly atr14: number;
  readonly atrMultiple: number;
}): AtrPositionSizingResult {
  const { equity, riskPct, entryPrice, atr14, atrMultiple } = params;
  if (
    !Number.isFinite(equity) ||
    !Number.isFinite(riskPct) ||
    !Number.isFinite(entryPrice) ||
    !Number.isFinite(atr14) ||
    !Number.isFinite(atrMultiple) ||
    equity <= 0 ||
    riskPct <= 0 ||
    entryPrice <= 0 ||
    atr14 <= 0 ||
    atrMultiple <= 0
  ) {
    return {
      stopLossPrice: Number.NaN,
      stopDistanceAbs: Number.NaN,
      riskBudget: Number.NaN,
      suggestedQty: Number.NaN,
    };
  }
  const stopDistanceAbs = atr14 * atrMultiple;
  const riskBudget = equity * (riskPct / 100);
  const stopLossPrice = Math.max(0, entryPrice - stopDistanceAbs);
  const suggestedQty = Math.floor(riskBudget / stopDistanceAbs);
  return {
    stopLossPrice,
    stopDistanceAbs,
    riskBudget,
    suggestedQty,
  };
}

/** Clasifica niveles institucionales por proximidad al spot en múltiplos de ATR(14). */
export function computeSpatialProximityList(
  spot: number,
  atr14: number,
  levels: readonly SpatialLevelInputPoint[],
  bandAtr = 0.15,
): readonly SpatialProximityItem[] {
  if (!Number.isFinite(spot) || spot <= 0 || !Number.isFinite(atr14) || atr14 <= 0) {
    return [];
  }
  const validBand = Number.isFinite(bandAtr) && bandAtr > 0 ? bandAtr : 0.15;
  const items: SpatialProximityItem[] = [];
  for (const lv of levels) {
    if (!Number.isFinite(lv.price) || lv.price <= 0) continue;
    const signedDistAbs = lv.price - spot;
    const distanceAbs = Math.abs(signedDistAbs);
    const distanceAtr = distanceAbs / atr14;
    const distancePct = (signedDistAbs / spot) * 100;
    items.push({
      name: lv.name,
      category: lv.category,
      price: lv.price,
      signedDistAbs,
      distanceAbs,
      distancePct,
      distanceAtr,
      withinBand: distanceAtr <= validBand,
    });
  }
  items.sort((a, b) => a.distanceAtr - b.distanceAtr);
  return items;
}
