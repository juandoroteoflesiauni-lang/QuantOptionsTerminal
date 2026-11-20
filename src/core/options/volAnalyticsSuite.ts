/**
 * Pieza 27 — Suite pura cuantitativa para Análisis de Volatilidad (/opciones/volatilidad).
 *
 * Implementa en funciones puras deterministas sin efectos secundarios:
 *  1) Sonrisa OTM separada para Calls y Puts (con filtro por defecto Solo OTM y descarte de bases ITM T<7d).
 *  2) Matriz normalizada por moneyness (-20%..+20%) por interpolación lineal OTM + estructura temporal.
 *  3) Tabla condicional histórica ("Qué pasó las otras veces") por quintiles de RV/IV proxy (252–750 ruedas),
 *     régimen operativo sugerido, estacionalidad mensual y ruedas extremas (>3σ).
 *  4) Cono de movimiento esperado + densidad Breeden-Litzenberger Q vs. Lognormal analítica.
 *  5) Paridad Call-Put strike por strike y Tasa Sintética Implícita Bid/Ask (TEA Tomadora y Colocadora vs Caución/SOFR).
 *  6) Relación de primas 1:N, costo relativo (% Beneficio Máximo) y percentil histórico Bjerksund-Stensland 2002
 *     de Bull Call Spread, Bear Put Spread y Mariposa Simétrica.
 *  7) Comparación Dual BYMA (ARS) vs. OPRA ADR (USD) y VI teórica ajustada por CCL.
 */

import { priceAmericanBjerksund2002 } from './american.js';
import { greeksBsm } from './blackScholes.js';
import { normPdf } from './math.js';
import { MIN_SYNTHETIC_RATE_DTE, type ImpliedRateStatus } from './syntheticRates.js';
import type { OptionContractType } from './types.js';
import { DEFAULT_MIN_SPREAD_DEBIT, isValidButterflyStrikes } from './verticalSpreads.js';
import {
  EXTRINSIC_EPS,
  MIN_EXPECTED_MOVE_T_YEARS,
  MIN_RATIO_PREMIUM,
  SHORT_PREMIUM_RISK_MESSAGE,
  evaluateShortPremiumBreaker,
  expectedMoveSigma,
  extrinsicValue,
  intrinsicValue,
  isIvUnreliable,
  isRatioCardValid,
} from './zeroDteFixes.js';

const TRADING_DAYS_PER_YEAR = 252;
const CALENDAR_DAYS_PER_YEAR = 365;
const DEFAULT_SHORT_DTE_DAYS = 7;
const DEFAULT_WING_MONEYNESS_LIMIT = 0.25;
const DEFAULT_MONEYNESS_OFFSETS_PCT = [-20, -15, -10, -5, 0, 5, 10, 15, 20] as const;
const DEFAULT_RV_WINDOW_DAYS = 23;
const DEFAULT_FORWARD_TRADING_DAYS = 21;
const DEFAULT_MAX_HISTORY_POINTS = 750;
const DEFAULT_TAIL_SIGMA = 3.0;
const MONTH_LABELS_ES = [
  'Ene',
  'Feb',
  'Mar',
  'Abr',
  'May',
  'Jun',
  'Jul',
  'Ago',
  'Sep',
  'Oct',
  'Nov',
  'Dic',
] as const;

function isPositiveFinite(x: number | null | undefined): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}

function isRuntimeArray(val: unknown): boolean {
  return Array.isArray(val);
}

function clampUnit(x: number): number {
  if (!Number.isFinite(x)) return Number.NaN;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x;
}

function clampPct(x: number): number {
  if (!Number.isFinite(x)) return Number.NaN;
  if (x <= 0) return 0;
  if (x >= 100) return 100;
  return x;
}

function linearPercentile(sortedValues: readonly number[], q: number): number {
  const n = sortedValues.length;
  if (n === 0 || !Number.isFinite(q) || q < 0 || q > 1) {
    return Number.NaN;
  }
  if (n === 1) {
    return sortedValues[0] ?? Number.NaN;
  }
  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  const vLo = sortedValues[lo];
  const vHi = sortedValues[hi];
  if (vLo === undefined || vHi === undefined) {
    return Number.NaN;
  }
  const w = pos - lo;
  return vLo + (vHi - vLo) * w;
}

function interpolateLinearPoints(
  sortedPoints: readonly { readonly x: number; readonly y: number }[],
  xTarget: number,
): number {
  if (sortedPoints.length === 0 || !Number.isFinite(xTarget)) {
    return Number.NaN;
  }
  const first = sortedPoints[0];
  const last = sortedPoints[sortedPoints.length - 1];
  if (first === undefined || last === undefined) {
    return Number.NaN;
  }
  if (Math.abs(xTarget - first.x) <= 1e-9) return first.y;
  if (Math.abs(xTarget - last.x) <= 1e-9) return last.y;
  if (xTarget < first.x || xTarget > last.x) {
    return Number.NaN;
  }
  for (let i = 0; i < sortedPoints.length - 1; i += 1) {
    const a = sortedPoints[i];
    const b = sortedPoints[i + 1];
    if (a === undefined || b === undefined) continue;
    if (Math.abs(xTarget - a.x) <= 1e-9) return a.y;
    if (Math.abs(xTarget - b.x) <= 1e-9) return b.y;
    if (xTarget > a.x && xTarget < b.x && b.x > a.x) {
      const t = (xTarget - a.x) / (b.x - a.x);
      return a.y + (b.y - a.y) * t;
    }
  }
  return Number.NaN;
}

function medianValues(values: readonly number[]): number {
  const valid = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return linearPercentile(valid, 0.5);
}

function meanValues(values: readonly number[]): number {
  let sum = 0;
  let count = 0;
  for (const v of values) {
    if (Number.isFinite(v)) {
      sum += v;
      count += 1;
    }
  }
  return count > 0 ? sum / count : Number.NaN;
}

function resolveOptionSidePrice(
  leg: {
    readonly bid?: number | null | undefined;
    readonly ask?: number | null | undefined;
    readonly mid?: number | null | undefined;
    readonly last?: number | null | undefined;
  },
  side: 'buy' | 'sell' | 'mid',
): { readonly price: number; readonly source: 'BBO' | 'MID' | 'NONE' } {
  const bid = leg.bid ?? null;
  const ask = leg.ask ?? null;
  const mid =
    isPositiveFinite(leg.mid)
      ? leg.mid
      : isPositiveFinite(bid) && isPositiveFinite(ask) && ask >= bid
        ? 0.5 * (bid + ask)
        : isPositiveFinite(leg.last)
          ? leg.last
          : null;

  if (side === 'buy') {
    if (isPositiveFinite(ask)) return { price: ask, source: 'BBO' };
    if (isPositiveFinite(mid)) return { price: mid, source: 'MID' };
    return { price: Number.NaN, source: 'NONE' };
  }
  if (side === 'sell') {
    if (isPositiveFinite(bid)) return { price: bid, source: 'BBO' };
    if (isPositiveFinite(mid)) return { price: mid, source: 'MID' };
    return { price: Number.NaN, source: 'NONE' };
  }
  if (isPositiveFinite(mid)) return { price: mid, source: 'MID' };
  return { price: Number.NaN, source: 'NONE' };
}

// ============================================================================
// 1. Sonrisa OTM separada Calls/Puts & Matriz Normalizada
// ============================================================================

export interface SmileContractInput {
  readonly strike: number;
  readonly contractType: OptionContractType;
  /** IV en decimal (ej. 0.45 = 45%). */
  readonly iv: number | null;
  readonly bid?: number | null;
  readonly ask?: number | null;
  readonly last?: number | null;
  readonly mid?: number | null;
  readonly volume?: number | null;
  readonly openInterest?: number | null;
  readonly delta?: number | null;
}

export interface SeparatedSmileOptions {
  readonly onlyOtm?: boolean;
  readonly shortDteDaysThreshold?: number;
  readonly wingMoneynessLimit?: number;
}

export interface SmileCurvePoint {
  readonly strike: number;
  readonly moneynessPct: number;
  readonly delta: number;
  readonly ivPct: number;
  readonly bid: number | null;
  readonly ask: number | null;
  readonly mid: number | null;
  readonly volume: number | null;
  readonly openInterest: number | null;
  readonly isOtm: boolean;
  readonly isShortDteItm: boolean;
}

export interface CompositeOtmSmilePoint {
  readonly strike: number;
  readonly moneynessPct: number;
  readonly ivPct: number;
  readonly sourceSide: 'PUT' | 'CALL' | 'ATM_AVG';
}

export interface SeparatedSmileResult {
  readonly status: 'OK' | 'NO_DATA';
  readonly onlyOtm: boolean;
  readonly isShortDteSlice: boolean;
  readonly excludedItmCount: number;
  readonly callPoints: readonly SmileCurvePoint[];
  readonly putPoints: readonly SmileCurvePoint[];
  readonly compositeOtmPoints: readonly CompositeOtmSmilePoint[];
  readonly atmIvPct: number;
  readonly callWingAvgIvPct: number;
  readonly putWingAvgIvPct: number;
  readonly callVsPutSkewPp: number;
  readonly iv25DeltaCallPct: number;
  readonly iv25DeltaPutPct: number;
  readonly riskReversal25DeltaPp: number;
}

export function buildSeparatedOtmSmile(
  input: {
    readonly spot: number;
    readonly timeToExpiryYears: number;
    readonly daysToExpiry: number;
    readonly rate: number;
    readonly dividendYield: number;
    readonly contracts: readonly SmileContractInput[];
  },
  options: SeparatedSmileOptions = {},
): SeparatedSmileResult {
  const onlyOtm = options.onlyOtm ?? true;
  const shortDteDaysThreshold = options.shortDteDaysThreshold ?? DEFAULT_SHORT_DTE_DAYS;
  const wingMoneynessLimit = options.wingMoneynessLimit ?? DEFAULT_WING_MONEYNESS_LIMIT;

  const emptyResult: SeparatedSmileResult = {
    status: 'NO_DATA',
    onlyOtm,
    isShortDteSlice: isPositiveFinite(input.daysToExpiry) && input.daysToExpiry < shortDteDaysThreshold,
    excludedItmCount: 0,
    callPoints: [],
    putPoints: [],
    compositeOtmPoints: [],
    atmIvPct: Number.NaN,
    callWingAvgIvPct: Number.NaN,
    putWingAvgIvPct: Number.NaN,
    callVsPutSkewPp: Number.NaN,
    iv25DeltaCallPct: Number.NaN,
    iv25DeltaPutPct: Number.NaN,
    riskReversal25DeltaPp: Number.NaN,
  };

  if (
    !isPositiveFinite(input.spot) ||
    !isPositiveFinite(input.timeToExpiryYears) ||
    !Number.isFinite(input.daysToExpiry) ||
    input.daysToExpiry < 0 ||
    !Number.isFinite(input.rate) ||
    !Number.isFinite(input.dividendYield) ||
    !isRuntimeArray(input.contracts)
  ) {
    return emptyResult;
  }

  const { spot, timeToExpiryYears, daysToExpiry, rate, dividendYield, contracts } = input;
  const isShortDteSlice = daysToExpiry < shortDteDaysThreshold;

  const callPoints: SmileCurvePoint[] = [];
  const putPoints: SmileCurvePoint[] = [];
  const otmPutByStrike = new Map<number, number>();
  const otmCallByStrike = new Map<number, number>();
  let excludedItmCount = 0;

  for (const c of contracts) {
    if (!isPositiveFinite(c.strike) || !isPositiveFinite(c.iv)) {
      continue;
    }

    const isCall = c.contractType === 'call';
    const isOtmOrAtm = isCall ? c.strike >= spot - 1e-9 : c.strike <= spot + 1e-9;
    const isStrictlyItm = !isOtmOrAtm;
    const isShortDteItm = isShortDteSlice && isStrictlyItm;

    // Registrar los IVs OTM puros para matriz/ATM incluso si onlyOtm === false
    if (c.strike <= spot + 1e-9 && !isCall) {
      otmPutByStrike.set(c.strike, c.iv * 100);
    }
    if (c.strike >= spot - 1e-9 && isCall) {
      otmCallByStrike.set(c.strike, c.iv * 100);
    }

    if (onlyOtm && isStrictlyItm) {
      excludedItmCount += 1;
      continue;
    }

    let delta = Number.NaN;
    if (
      typeof c.delta === 'number' &&
      Number.isFinite(c.delta) &&
      (isCall ? c.delta > 0 && c.delta <= 1 : c.delta < 0 && c.delta >= -1)
    ) {
      delta = c.delta;
    } else {
      const g = greeksBsm({
        spot,
        strike: c.strike,
        timeToExpiry: timeToExpiryYears,
        rate,
        dividendYield,
        volatility: c.iv,
        contractType: c.contractType,
      });
      delta = g.delta;
    }

    if (!Number.isFinite(delta)) {
      continue;
    }

    const moneynessPct = (c.strike / spot - 1) * 100;
    const point: SmileCurvePoint = {
      strike: c.strike,
      moneynessPct,
      delta,
      ivPct: c.iv * 100,
      bid: c.bid ?? null,
      ask: c.ask ?? null,
      mid: resolveOptionSidePrice(c, 'mid').price || null,
      volume: c.volume ?? null,
      openInterest: c.openInterest ?? null,
      isOtm: isOtmOrAtm,
      isShortDteItm,
    };

    if (isCall) {
      callPoints.push(point);
    } else {
      putPoints.push(point);
    }
  }

  callPoints.sort((a, b) => a.strike - b.strike);
  putPoints.sort((a, b) => a.strike - b.strike);

  const allOtmStrikes = [...new Set([...otmPutByStrike.keys(), ...otmCallByStrike.keys()])].sort(
    (a, b) => a - b,
  );
  const compositeOtmPoints: CompositeOtmSmilePoint[] = [];
  for (const strike of allOtmStrikes) {
    const pIv = otmPutByStrike.get(strike);
    const cIv = otmCallByStrike.get(strike);
    const moneynessPct = (strike / spot - 1) * 100;
    if (strike < spot - 1e-9 && pIv !== undefined) {
      compositeOtmPoints.push({ strike, moneynessPct, ivPct: pIv, sourceSide: 'PUT' });
    } else if (strike > spot + 1e-9 && cIv !== undefined) {
      compositeOtmPoints.push({ strike, moneynessPct, ivPct: cIv, sourceSide: 'CALL' });
    } else if (pIv !== undefined && cIv !== undefined) {
      compositeOtmPoints.push({
        strike,
        moneynessPct,
        ivPct: 0.5 * (pIv + cIv),
        sourceSide: 'ATM_AVG',
      });
    } else if (pIv !== undefined) {
      compositeOtmPoints.push({ strike, moneynessPct, ivPct: pIv, sourceSide: 'PUT' });
    } else if (cIv !== undefined) {
      compositeOtmPoints.push({ strike, moneynessPct, ivPct: cIv, sourceSide: 'CALL' });
    }
  }

  if (callPoints.length === 0 && putPoints.length === 0) {
    return {
      ...emptyResult,
      excludedItmCount,
    };
  }

  const atmIvPct = interpolateLinearPoints(
    compositeOtmPoints.map((p) => ({ x: p.moneynessPct, y: p.ivPct })),
    0,
  );

  const wingLimitPct = wingMoneynessLimit * 100;
  const otmCallWings = callPoints
    .filter((p) => p.moneynessPct > 1e-6 && p.moneynessPct <= wingLimitPct)
    .map((p) => p.ivPct);
  const otmPutWings = putPoints
    .filter((p) => p.moneynessPct < -1e-6 && p.moneynessPct >= -wingLimitPct)
    .map((p) => p.ivPct);

  const callWingAvgIvPct = meanValues(otmCallWings);
  const putWingAvgIvPct = meanValues(otmPutWings);
  const callVsPutSkewPp =
    Number.isFinite(callWingAvgIvPct) && Number.isFinite(putWingAvgIvPct)
      ? callWingAvgIvPct - putWingAvgIvPct
      : Number.NaN;

  const callByDelta = callPoints
    .filter((p) => p.delta > 0 && p.delta < 1)
    .map((p) => ({ x: p.delta, y: p.ivPct }))
    .sort((a, b) => a.x - b.x);
  const putByDelta = putPoints
    .filter((p) => p.delta < 0 && p.delta > -1)
    .map((p) => ({ x: p.delta, y: p.ivPct }))
    .sort((a, b) => a.x - b.x);

  const iv25DeltaCallPct = interpolateLinearPoints(callByDelta, 0.25);
  const iv25DeltaPutPct = interpolateLinearPoints(putByDelta, -0.25);
  const riskReversal25DeltaPp =
    Number.isFinite(iv25DeltaCallPct) && Number.isFinite(iv25DeltaPutPct)
      ? iv25DeltaCallPct - iv25DeltaPutPct
      : Number.NaN;

  return {
    status: 'OK',
    onlyOtm,
    isShortDteSlice,
    excludedItmCount,
    callPoints,
    putPoints,
    compositeOtmPoints,
    atmIvPct,
    callWingAvgIvPct,
    putWingAvgIvPct,
    callVsPutSkewPp,
    iv25DeltaCallPct,
    iv25DeltaPutPct,
    riskReversal25DeltaPp,
  };
}

export type TermStructureRegime = 'CONTANGO' | 'BACKWARDATION' | 'FLAT' | 'NO_DATA';

export interface MoneynessMatrixSliceInput {
  readonly expiryCode: string;
  readonly expiryLabel: string;
  readonly daysToExpiry: number;
  readonly compositeOtmPoints: readonly { readonly moneynessPct: number; readonly ivPct: number }[];
  /** IV ATM explícita del slice en % si se desea exponer cuando falta interpolación ATM directa. */
  readonly fallbackAtmIvPct?: number | null;
}

export interface NormalizedMoneynessMatrixRow {
  readonly expiryCode: string;
  readonly expiryLabel: string;
  readonly daysToExpiry: number;
  readonly atmIvPct: number;
  readonly cells: readonly { readonly offsetPct: number; readonly ivPct: number }[];
}

export interface NormalizedMoneynessMatrixResult {
  readonly status: 'OK' | 'NO_DATA';
  readonly offsetsPct: readonly number[];
  readonly rows: readonly NormalizedMoneynessMatrixRow[];
  readonly termRegime: TermStructureRegime;
  readonly termSpreadPp: number;
}

export function buildNormalizedMoneynessMatrix(
  slices: readonly MoneynessMatrixSliceInput[],
  offsetsPct: readonly number[] = DEFAULT_MONEYNESS_OFFSETS_PCT,
): NormalizedMoneynessMatrixResult {
  if (!isRuntimeArray(slices) || slices.length === 0 || offsetsPct.length === 0) {
    return {
      status: 'NO_DATA',
      offsetsPct: [...offsetsPct],
      rows: [],
      termRegime: 'NO_DATA',
      termSpreadPp: Number.NaN,
    };
  }

  const sortedSlices = slices
    .filter((s) => Number.isFinite(s.daysToExpiry) && s.daysToExpiry >= 0)
    .slice()
    .sort((a, b) => a.daysToExpiry - b.daysToExpiry);

  const rows: NormalizedMoneynessMatrixRow[] = sortedSlices.map((s) => {
    const rawPts: readonly { readonly moneynessPct: number; readonly ivPct: number }[] =
      s.compositeOtmPoints;
    const pts = rawPts
      .filter((p) => Number.isFinite(p.moneynessPct) && isPositiveFinite(p.ivPct))
      .map((p): { readonly x: number; readonly y: number } => ({
        x: p.moneynessPct,
        y: p.ivPct,
      }))
      .sort((a, b) => a.x - b.x);
    const cells = offsetsPct.map((offsetPct) => ({
      offsetPct,
      ivPct: interpolateLinearPoints(pts, offsetPct),
    }));
    const interpAtm = interpolateLinearPoints(pts, 0);
    const atmIvPct = Number.isFinite(interpAtm)
      ? interpAtm
      : isPositiveFinite(s.fallbackAtmIvPct)
        ? s.fallbackAtmIvPct
        : Number.NaN;
    return {
      expiryCode: s.expiryCode,
      expiryLabel: s.expiryLabel,
      daysToExpiry: s.daysToExpiry,
      atmIvPct,
      cells,
    };
  });

  const validAtmRows = rows.filter((r) => isPositiveFinite(r.atmIvPct));
  let termRegime: TermStructureRegime = 'NO_DATA';
  let termSpreadPp = Number.NaN;
  if (validAtmRows.length >= 2) {
    const first = validAtmRows[0];
    const last = validAtmRows[validAtmRows.length - 1];
    if (first !== undefined && last !== undefined) {
      termSpreadPp = last.atmIvPct - first.atmIvPct;
      if (termSpreadPp > 0.25) termRegime = 'CONTANGO';
      else if (termSpreadPp < -0.25) termRegime = 'BACKWARDATION';
      else termRegime = 'FLAT';
    }
  }

  return {
    status: rows.length > 0 ? 'OK' : 'NO_DATA',
    offsetsPct: [...offsetsPct],
    rows,
    termRegime,
    termSpreadPp,
  };
}

// ============================================================================
// 2. Tabla Condicional Histórica ("Qué pasó las otras veces") & Estacionalidad
// ============================================================================

export interface HistoricalDailyBarInput {
  readonly time: number;
  readonly close: number;
  readonly open?: number;
  readonly high?: number;
  readonly low?: number;
}

export interface VolConditionalOptions {
  readonly rvWindowDays?: number;
  readonly forwardTradingDays?: number;
  readonly maxHistoryPoints?: number;
  readonly tailSigmaThreshold?: number;
}

export interface HistoricalVolPoint {
  readonly time: number;
  readonly date: string;
  readonly close: number;
  readonly rvPct: number;
}

export interface ConditionalQuintileBucket {
  readonly id: 'VERY_LOW' | 'LOW' | 'NORMAL' | 'HIGH' | 'EXTREME';
  readonly label: string;
  readonly rangeLabel: string;
  readonly minBoundPct: number;
  readonly maxBoundPct: number;
  readonly occurrences: number;
  readonly avgVolChange30dPts: number;
  readonly avgUnderlyingReturn30dPct: number;
  readonly pctVolDecreased: number;
  readonly isCurrent: boolean;
}

export type OperativeRegimeCode =
  | 'VENTA_PRIMA_CUBIERTA'
  | 'COMPRA_CONVEXIDAD_CALENDAR'
  | 'NEUTRAL_SELECTIVO'
  | 'NO_SHORT_PREMIUM_RISK'
  | 'NO_DATA';

export interface OperativeRegimeSuggestion {
  readonly code: OperativeRegimeCode;
  readonly label: string;
  readonly rationale: string;
}

export interface MonthlySeasonalityRow {
  readonly monthIndex: number;
  readonly monthLabel: string;
  readonly tradingDays: number;
  readonly monthsSampled: number;
  readonly meanDailyReturnPct: number;
  readonly avgMonthlyReturnPct: number;
  readonly annualizedVolPct: number;
  readonly positiveMonthRatePct: number;
}

export interface ExtremeReturnSession {
  readonly time: number;
  readonly date: string;
  readonly logReturnPct: number;
  readonly simpleReturnPct: number;
  readonly zScore: number;
  readonly direction: 'UP' | 'DOWN';
}

export interface HistoricalVolConditionalResult {
  readonly status: 'OK' | 'NO_DATA';
  readonly barsUsed: number;
  readonly historyObservations: number;
  readonly pairedObservations: number;
  readonly currentEvalVolPct: number;
  readonly latestRv20Pct: number;
  readonly latestRv23Pct: number;
  readonly latestRv60Pct: number;
  readonly vrpVsRv23Pts: number;
  readonly ivRank: number;
  readonly ivPercentile: number;
  readonly quantiles: {
    readonly minPct: number;
    readonly p20Pct: number;
    readonly p40Pct: number;
    readonly p60Pct: number;
    readonly p80Pct: number;
    readonly maxPct: number;
    readonly medianPct: number;
  };
  readonly operativeRegime: OperativeRegimeSuggestion;
  readonly buckets: readonly ConditionalQuintileBucket[];
  readonly historySeries: readonly HistoricalVolPoint[];
  readonly seasonalityMonths: readonly MonthlySeasonalityRow[];
  readonly extremeSessions: readonly ExtremeReturnSession[];
}

export function computeOperativeRegimeSuggestion(params: {
  readonly ivRank: number;
  readonly vrpPts: number;
}): OperativeRegimeSuggestion {
  const { ivRank, vrpPts } = params;
  if (!Number.isFinite(ivRank)) {
    return {
      code: 'NO_DATA',
      label: '—',
      rationale: 'Historial insuficiente para evaluar régimen operativo.',
    };
  }
  if (ivRank > 70 && Number.isFinite(vrpPts) && vrpPts > 5) {
    return {
      code: 'VENTA_PRIMA_CUBIERTA',
      label: 'VENTA DE PRIMA CUBIERTA',
      rationale: 'IV Rank > 70% con prima implícita sobre realizada superior a +5 pts.',
    };
  }
  if (ivRank < 25) {
    return {
      code: 'COMPRA_CONVEXIDAD_CALENDAR',
      label: 'COMPRA DE CONVEXIDAD / CALENDAR',
      rationale: 'IV Rank comprimido (< 25%): prima implícita históricamente baja.',
    };
  }
  return {
    code: 'NEUTRAL_SELECTIVO',
    label: 'NEUTRAL / SELECTIVO',
    rationale: 'Percentil intermedio de volatilidad: priorizar asimetrías de skew y plazos.',
  };
}

export type ActiveExpiryIvSource = 'INTERPOLATED_ATM' | 'SAME_EXPIRY_FALLBACK' | 'NO_DATA';

export interface ActiveExpiryVrpInput {
  readonly expiryCode: string | null;
  readonly daysToExpiry: number | null;
  /** IV ATM interpolada del vencimiento actualmente seleccionado en % (ej. 21.5). */
  readonly ivAtmActiveExpiryPct: number | null;
  /** Fallback explícito del MISMO vencimiento activo (ej. IV OTM más cercana al spot en %) si falta interpolación exacta en 0% moneyness. Nunca de otro vencimiento. */
  readonly sameExpiryFallbackIvAtmPct?: number | null;
  /** Volatilidad realizada de referencia en % (ej. RV 23 ruedas). */
  readonly rvReferencePct: number | null;
  readonly rvReferenceLabel?: string;
  readonly historicalRvMinPct?: number | null;
  readonly historicalRvMaxPct?: number | null;
  readonly historicalRvSeriesPct?: readonly number[];
  readonly fallbackIvRank?: number | null;
  readonly fallbackIvPercentile?: number | null;
  readonly spot?: number | null;
  readonly putWallStrike?: number | null;
  readonly netGex?: number | null;
}

export interface ActiveExpiryVrpResult {
  readonly status: 'OK' | 'NO_DATA';
  readonly expiryCode: string | null;
  readonly daysToExpiry: number;
  readonly ivAtmActiveExpiryPct: number;
  readonly ivSource: ActiveExpiryIvSource;
  readonly rvReferencePct: number;
  readonly rvReferenceLabel: string;
  readonly vrpActiveExpiryPts: number;
  readonly ivRankActiveExpiry: number;
  readonly ivPercentileActiveExpiry: number;
  readonly operativeRegime: OperativeRegimeSuggestion;
}

/**
 * Pieza 45 — Calcula vrpActiveExpiry = ivAtmActiveExpiry - rvReference usando exclusivamente
 * la IV ATM del vencimiento activo seleccionado por el usuario (con fallback explícito al
 * mismo vencimiento, jamás mezclando silenciosamente otro vencimiento) y alimenta el
 * clasificador de régimen operativo.
 */
export function computeActiveExpiryVrpAndRegime(
  input: ActiveExpiryVrpInput,
): ActiveExpiryVrpResult {
  const rvReferenceLabel = input.rvReferenceLabel ?? 'RV23d';
  const daysToExpiry =
    Number.isFinite(input.daysToExpiry) && (input.daysToExpiry as number) >= 0
      ? (input.daysToExpiry as number)
      : Number.NaN;

  let ivAtmActiveExpiryPct = Number.NaN;
  let ivSource: ActiveExpiryIvSource = 'NO_DATA';
  if (isPositiveFinite(input.ivAtmActiveExpiryPct)) {
    ivAtmActiveExpiryPct = input.ivAtmActiveExpiryPct;
    ivSource = 'INTERPOLATED_ATM';
  } else if (isPositiveFinite(input.sameExpiryFallbackIvAtmPct)) {
    ivAtmActiveExpiryPct = input.sameExpiryFallbackIvAtmPct;
    ivSource = 'SAME_EXPIRY_FALLBACK';
  }

  const rvReferencePct = isPositiveFinite(input.rvReferencePct)
    ? input.rvReferencePct
    : Number.NaN;

  if (!Number.isFinite(ivAtmActiveExpiryPct) || !Number.isFinite(rvReferencePct)) {
    return {
      status: 'NO_DATA',
      expiryCode: input.expiryCode,
      daysToExpiry,
      ivAtmActiveExpiryPct,
      ivSource,
      rvReferencePct,
      rvReferenceLabel,
      vrpActiveExpiryPts: Number.NaN,
      ivRankActiveExpiry: Number.NaN,
      ivPercentileActiveExpiry: Number.NaN,
      operativeRegime: {
        code: 'NO_DATA',
        label: '—',
        rationale: !Number.isFinite(ivAtmActiveExpiryPct)
          ? 'Sin IV ATM válida en el vencimiento activo.'
          : 'Sin volatilidad realizada de referencia para calcular VRP.',
      },
    };
  }

  const vrpActiveExpiryPts = ivAtmActiveExpiryPct - rvReferencePct;

  let ivRankActiveExpiry = Number.NaN;
  let ivPercentileActiveExpiry = Number.NaN;

  const histSeries = input.historicalRvSeriesPct;
  if (histSeries && isRuntimeArray(histSeries)) {
    const validHist = histSeries.filter((v) => isPositiveFinite(v));
    if (validHist.length >= 2) {
      const sorted = validHist.slice().sort((a, b) => a - b);
      const minPct = sorted[0] ?? Number.NaN;
      const maxPct = sorted[sorted.length - 1] ?? Number.NaN;
      if (Number.isFinite(minPct) && Number.isFinite(maxPct) && maxPct > minPct) {
        ivRankActiveExpiry = clampPct(((ivAtmActiveExpiryPct - minPct) / (maxPct - minPct)) * 100);
      }
      const leCount = sorted.filter((v) => v <= ivAtmActiveExpiryPct).length;
      ivPercentileActiveExpiry = clampPct((leCount / sorted.length) * 100);
    }
  }

  if (
    !Number.isFinite(ivRankActiveExpiry) &&
    isPositiveFinite(input.historicalRvMinPct) &&
    isPositiveFinite(input.historicalRvMaxPct) &&
    input.historicalRvMaxPct > input.historicalRvMinPct
  ) {
    ivRankActiveExpiry = clampPct(
      ((ivAtmActiveExpiryPct - input.historicalRvMinPct) /
        (input.historicalRvMaxPct - input.historicalRvMinPct)) *
        100,
    );
  }

  if (
    !Number.isFinite(ivRankActiveExpiry) &&
    input.fallbackIvRank !== null &&
    input.fallbackIvRank !== undefined &&
    Number.isFinite(input.fallbackIvRank)
  ) {
    ivRankActiveExpiry = clampPct(input.fallbackIvRank);
  }

  if (
    !Number.isFinite(ivPercentileActiveExpiry) &&
    input.fallbackIvPercentile !== null &&
    input.fallbackIvPercentile !== undefined &&
    Number.isFinite(input.fallbackIvPercentile)
  ) {
    ivPercentileActiveExpiry = clampPct(input.fallbackIvPercentile);
  }

  const rawOperativeRegime: OperativeRegimeSuggestion = Number.isFinite(ivRankActiveExpiry)
    ? computeOperativeRegimeSuggestion({
        ivRank: ivRankActiveExpiry,
        vrpPts: vrpActiveExpiryPts,
      })
    : vrpActiveExpiryPts > 5
      ? {
          code: 'VENTA_PRIMA_CUBIERTA' as const,
          label: 'VENTA DE PRIMA CUBIERTA',
          rationale: `VRP activo +${vrpActiveExpiryPts.toFixed(1)} pts sobre ${rvReferenceLabel}.`,
        }
      : vrpActiveExpiryPts < -3
        ? {
            code: 'COMPRA_CONVEXIDAD_CALENDAR' as const,
            label: 'COMPRA DE CONVEXIDAD / CALENDAR',
            rationale: `VRP activo ${vrpActiveExpiryPts.toFixed(1)} pts debajo de ${rvReferenceLabel}.`,
          }
        : {
            code: 'NEUTRAL_SELECTIVO' as const,
            label: 'NEUTRAL / SELECTIVO',
            rationale: `VRP activo alineado con ${rvReferenceLabel}.`,
          };

  // Pieza 46.1: circuit breaker 0DTE (dte <= 1) o Short Gamma bajo Put Wall sobre VENTA DE PRIMA CUBIERTA.
  const breaker = evaluateShortPremiumBreaker({
    dte: daysToExpiry,
    spot: input.spot ?? Number.NaN,
    putWall: input.putWallStrike ?? null,
    netGex: input.netGex ?? Number.NaN,
  });
  const operativeRegime: OperativeRegimeSuggestion =
    rawOperativeRegime.code === 'VENTA_PRIMA_CUBIERTA' && breaker.blocked
      ? {
          code: 'NO_SHORT_PREMIUM_RISK',
          label: SHORT_PREMIUM_RISK_MESSAGE,
          rationale:
            daysToExpiry <= 1
              ? 'Vencimiento 0DTE/1DTE: riesgo de gamma y pin; se desactiva la venta de prima cubierta.'
              : 'Spot bajo Put Wall con GEX neto negativo (Short Gamma): se desactiva la venta de prima cubierta.',
        }
      : rawOperativeRegime;

  return {
    status: 'OK',
    expiryCode: input.expiryCode,
    daysToExpiry,
    ivAtmActiveExpiryPct,
    ivSource,
    rvReferencePct,
    rvReferenceLabel,
    vrpActiveExpiryPts,
    ivRankActiveExpiry,
    ivPercentileActiveExpiry,
    operativeRegime,
  };
}

export function computeRollingRvDistributionAtWindow(
  bars: readonly HistoricalDailyBarInput[],
  windowDays: number,
  maxPoints = DEFAULT_MAX_HISTORY_POINTS,
): {
  readonly minPct: number;
  readonly p25Pct: number;
  readonly medianPct: number;
  readonly p75Pct: number;
  readonly maxPct: number;
  readonly currentPct: number;
  readonly observations: number;
} {
  const nanOut = {
    minPct: Number.NaN,
    p25Pct: Number.NaN,
    medianPct: Number.NaN,
    p75Pct: Number.NaN,
    maxPct: Number.NaN,
    currentPct: Number.NaN,
    observations: 0,
  };
  if (!isRuntimeArray(bars) || !Number.isInteger(windowDays) || windowDays < 2) {
    return nanOut;
  }
  const clean = bars
    .filter((b) => Number.isFinite(b.time) && isPositiveFinite(b.close))
    .slice()
    .sort((a, b) => a.time - b.time);
  if (clean.length <= windowDays) {
    return nanOut;
  }
  const logRets: number[] = [];
  for (let i = 1; i < clean.length; i += 1) {
    const prev = clean[i - 1];
    const curr = clean[i];
    if (prev !== undefined && curr !== undefined) {
      logRets.push(Math.log(curr.close / prev.close));
    }
  }
  const rvs: number[] = [];
  for (let end = windowDays; end <= logRets.length; end += 1) {
    let sum = 0;
    for (let j = end - windowDays; j < end; j += 1) {
      sum += logRets[j] ?? 0;
    }
    const mean = sum / windowDays;
    let sq = 0;
    for (let j = end - windowDays; j < end; j += 1) {
      const d = (logRets[j] ?? 0) - mean;
      sq += d * d;
    }
    const annPct = 100 * Math.sqrt((TRADING_DAYS_PER_YEAR * sq) / (windowDays - 1));
    if (Number.isFinite(annPct) && annPct >= 0) {
      rvs.push(annPct);
    }
  }
  const bounded = rvs.slice(-maxPoints);
  if (bounded.length === 0) {
    return nanOut;
  }
  const sorted = bounded.slice().sort((a, b) => a - b);
  return {
    minPct: sorted[0] ?? Number.NaN,
    p25Pct: linearPercentile(sorted, 0.25),
    medianPct: linearPercentile(sorted, 0.5),
    p75Pct: linearPercentile(sorted, 0.75),
    maxPct: sorted[sorted.length - 1] ?? Number.NaN,
    currentPct: bounded[bounded.length - 1] ?? Number.NaN,
    observations: bounded.length,
  };
}

export function computeHistoricalVolConditionalTable(
  input: {
    readonly bars: readonly HistoricalDailyBarInput[];
    readonly currentIvAtmPct: number | null;
  },
  options: VolConditionalOptions = {},
): HistoricalVolConditionalResult {
  const rvWindowDays = options.rvWindowDays ?? DEFAULT_RV_WINDOW_DAYS;
  const forwardTradingDays = options.forwardTradingDays ?? DEFAULT_FORWARD_TRADING_DAYS;
  const maxHistoryPoints = options.maxHistoryPoints ?? DEFAULT_MAX_HISTORY_POINTS;
  const tailSigmaThreshold = options.tailSigmaThreshold ?? DEFAULT_TAIL_SIGMA;

  const emptyResult: HistoricalVolConditionalResult = {
    status: 'NO_DATA',
    barsUsed: 0,
    historyObservations: 0,
    pairedObservations: 0,
    currentEvalVolPct: Number.NaN,
    latestRv20Pct: Number.NaN,
    latestRv23Pct: Number.NaN,
    latestRv60Pct: Number.NaN,
    vrpVsRv23Pts: Number.NaN,
    ivRank: Number.NaN,
    ivPercentile: Number.NaN,
    quantiles: {
      minPct: Number.NaN,
      p20Pct: Number.NaN,
      p40Pct: Number.NaN,
      p60Pct: Number.NaN,
      p80Pct: Number.NaN,
      maxPct: Number.NaN,
      medianPct: Number.NaN,
    },
    operativeRegime: computeOperativeRegimeSuggestion({
      ivRank: Number.NaN,
      vrpPts: Number.NaN,
    }),
    buckets: [],
    historySeries: [],
    seasonalityMonths: [],
    extremeSessions: [],
  };

  if (
    !isRuntimeArray(input.bars) ||
    !Number.isInteger(rvWindowDays) ||
    rvWindowDays < 5 ||
    !Number.isInteger(forwardTradingDays) ||
    forwardTradingDays < 1 ||
    !Number.isInteger(maxHistoryPoints) ||
    maxHistoryPoints < 20
  ) {
    return emptyResult;
  }

  const cleanBars = input.bars
    .filter((b) => Number.isFinite(b.time) && isPositiveFinite(b.close))
    .slice()
    .sort((a, b) => a.time - b.time);

  if (cleanBars.length <= rvWindowDays) {
    return emptyResult;
  }

  const dailyReturns: {
    readonly time: number;
    readonly date: string;
    readonly close: number;
    readonly prevClose: number;
    readonly logRet: number;
  }[] = [];

  for (let i = 1; i < cleanBars.length; i += 1) {
    const prev = cleanBars[i - 1];
    const curr = cleanBars[i];
    if (prev === undefined || curr === undefined) continue;
    const logRet = Math.log(curr.close / prev.close);
    if (!Number.isFinite(logRet)) continue;
    dailyReturns.push({
      time: curr.time,
      date: new Date(curr.time * 1_000).toISOString().slice(0, 10),
      close: curr.close,
      prevClose: prev.close,
      logRet,
    });
  }

  const computeTrailingRvAt = (idx: number, win: number): number => {
    if (idx + 1 < win) return Number.NaN;
    let sum = 0;
    for (let j = idx - win + 1; j <= idx; j += 1) {
      sum += dailyReturns[j]?.logRet ?? 0;
    }
    const mean = sum / win;
    let sq = 0;
    for (let j = idx - win + 1; j <= idx; j += 1) {
      const diff = (dailyReturns[j]?.logRet ?? 0) - mean;
      sq += diff * diff;
    }
    return 100 * Math.sqrt((TRADING_DAYS_PER_YEAR * sq) / (win - 1));
  };

  const fullHistory: HistoricalVolPoint[] = [];
  for (let i = rvWindowDays - 1; i < dailyReturns.length; i += 1) {
    const row = dailyReturns[i];
    if (row === undefined) continue;
    const rvPct = computeTrailingRvAt(i, rvWindowDays);
    if (Number.isFinite(rvPct) && rvPct >= 0) {
      fullHistory.push({
        time: row.time,
        date: row.date,
        close: row.close,
        rvPct,
      });
    }
  }

  const historySeries = fullHistory.slice(-maxHistoryPoints);
  if (historySeries.length < 10) {
    return {
      ...emptyResult,
      barsUsed: cleanBars.length,
    };
  }

  const lastRetIdx = dailyReturns.length - 1;
  const latestRv20Pct = computeTrailingRvAt(lastRetIdx, 20);
  const latestRv23Pct = computeTrailingRvAt(lastRetIdx, 23);
  const latestRv60Pct = computeTrailingRvAt(lastRetIdx, 60);

  const currentIvValid = isPositiveFinite(input.currentIvAtmPct);
  const currentEvalVolPct = currentIvValid ? input.currentIvAtmPct : latestRv23Pct;
  const vrpVsRv23Pts =
    currentIvValid && Number.isFinite(latestRv23Pct) ? input.currentIvAtmPct - latestRv23Pct : Number.NaN;

  const sortedVols = historySeries.map((p) => p.rvPct).sort((a, b) => a - b);
  const minPct = sortedVols[0] ?? Number.NaN;
  const maxPct = sortedVols[sortedVols.length - 1] ?? Number.NaN;
  const p20Pct = linearPercentile(sortedVols, 0.2);
  const p40Pct = linearPercentile(sortedVols, 0.4);
  const p60Pct = linearPercentile(sortedVols, 0.6);
  const p80Pct = linearPercentile(sortedVols, 0.8);
  const medianPct = linearPercentile(sortedVols, 0.5);

  const ivRank =
    Number.isFinite(currentEvalVolPct) && Number.isFinite(minPct) && Number.isFinite(maxPct) && maxPct > minPct
      ? clampPct(((currentEvalVolPct - minPct) / (maxPct - minPct)) * 100)
      : Number.NaN;

  const ivPercentile =
    Number.isFinite(currentEvalVolPct) && sortedVols.length > 0
      ? clampPct(
          (sortedVols.filter((v) => v <= currentEvalVolPct).length / sortedVols.length) * 100,
        )
      : Number.NaN;

  const operativeRegime = computeOperativeRegimeSuggestion({
    ivRank,
    vrpPts: vrpVsRv23Pts,
  });

  type BucketId = ConditionalQuintileBucket['id'];
  const classifyBucket = (volPct: number): BucketId => {
    if (volPct < p20Pct) return 'VERY_LOW';
    if (volPct < p40Pct) return 'LOW';
    if (volPct < p60Pct) return 'NORMAL';
    if (volPct < p80Pct) return 'HIGH';
    return 'EXTREME';
  };

  const currentBucketId: BucketId | null = Number.isFinite(currentEvalVolPct)
    ? classifyBucket(currentEvalVolPct)
    : null;

  const bucketAcc = new Map<
    BucketId,
    { volChanges: number[]; ret30d: number[]; decreasedCount: number }
  >([
    ['VERY_LOW', { volChanges: [], ret30d: [], decreasedCount: 0 }],
    ['LOW', { volChanges: [], ret30d: [], decreasedCount: 0 }],
    ['NORMAL', { volChanges: [], ret30d: [], decreasedCount: 0 }],
    ['HIGH', { volChanges: [], ret30d: [], decreasedCount: 0 }],
    ['EXTREME', { volChanges: [], ret30d: [], decreasedCount: 0 }],
  ]);

  let pairedObservations = 0;
  for (let i = 0; i + forwardTradingDays < historySeries.length; i += 1) {
    const cur = historySeries[i];
    const fut = historySeries[i + forwardTradingDays];
    if (cur === undefined || fut === undefined || cur.close <= 0) continue;
    const bId = classifyBucket(cur.rvPct);
    const acc = bucketAcc.get(bId);
    if (acc === undefined) continue;
    const volDelta = fut.rvPct - cur.rvPct;
    const spotRetPct = (fut.close / cur.close - 1) * 100;
    acc.volChanges.push(volDelta);
    acc.ret30d.push(spotRetPct);
    if (volDelta < 0) acc.decreasedCount += 1;
    pairedObservations += 1;
  }

  const bucketMeta: readonly {
    readonly id: BucketId;
    readonly label: string;
    readonly rangeLabel: string;
    readonly minB: number;
    readonly maxB: number;
  }[] = [
    { id: 'VERY_LOW', label: 'Muy baja', rangeLabel: '< P20', minB: minPct, maxB: p20Pct },
    { id: 'LOW', label: 'Baja', rangeLabel: 'P20 – P40', minB: p20Pct, maxB: p40Pct },
    { id: 'NORMAL', label: 'Normal', rangeLabel: 'P40 – P60', minB: p40Pct, maxB: p60Pct },
    { id: 'HIGH', label: 'Alta', rangeLabel: 'P60 – P80', minB: p60Pct, maxB: p80Pct },
    { id: 'EXTREME', label: 'Extrema', rangeLabel: '> P80', minB: p80Pct, maxB: maxPct },
  ];

  const buckets: ConditionalQuintileBucket[] = bucketMeta.map((bm) => {
    const acc = bucketAcc.get(bm.id);
    const occ = acc?.volChanges.length ?? 0;
    return {
      id: bm.id,
      label: bm.label,
      rangeLabel: bm.rangeLabel,
      minBoundPct: bm.minB,
      maxBoundPct: bm.maxB,
      occurrences: occ,
      avgVolChange30dPts: occ > 0 && acc !== undefined ? meanValues(acc.volChanges) : Number.NaN,
      avgUnderlyingReturn30dPct: occ > 0 && acc !== undefined ? meanValues(acc.ret30d) : Number.NaN,
      pctVolDecreased:
        occ > 0 && acc !== undefined ? (acc.decreasedCount / occ) * 100 : Number.NaN,
      isCurrent: currentBucketId === bm.id,
    };
  });

  // Estacionalidad mensual y ruedas extremas (>3σ) sobre las últimas <= 750 ruedas
  const boundedReturns = dailyReturns.slice(-maxHistoryPoints);
  const logRetArr = boundedReturns.map((r) => r.logRet);
  const meanDailyRet = meanValues(logRetArr);
  let sumSqDaily = 0;
  for (const lr of logRetArr) {
    const d = lr - meanDailyRet;
    sumSqDaily += d * d;
  }
  const stdDailyRet =
    logRetArr.length > 1 ? Math.sqrt(sumSqDaily / (logRetArr.length - 1)) : Number.NaN;

  const extremeSessions: ExtremeReturnSession[] = [];
  if (Number.isFinite(stdDailyRet) && stdDailyRet > 0) {
    for (const r of boundedReturns) {
      const zScore = (r.logRet - meanDailyRet) / stdDailyRet;
      if (Math.abs(zScore) > tailSigmaThreshold) {
        extremeSessions.push({
          time: r.time,
          date: r.date,
          logReturnPct: r.logRet * 100,
          simpleReturnPct: (r.close / r.prevClose - 1) * 100,
          zScore,
          direction: r.logRet >= 0 ? 'UP' : 'DOWN',
        });
      }
    }
    extremeSessions.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));
  }

  const monthDailyRets: number[][] = Array.from({ length: 12 }, () => []);
  const monthYmSums: Map<string, number>[] = Array.from({ length: 12 }, () => new Map<string, number>());
  for (const r of boundedReturns) {
    const d = new Date(r.time * 1_000);
    const mIdx = d.getUTCMonth();
    const ym = r.date.slice(0, 7);
    monthDailyRets[mIdx]?.push(r.logRet);
    const ymMap = monthYmSums[mIdx];
    if (ymMap !== undefined) {
      ymMap.set(ym, (ymMap.get(ym) ?? 0) + r.logRet);
    }
  }

  const seasonalityMonths: MonthlySeasonalityRow[] = MONTH_LABELS_ES.map((monthLabel, mIdx) => {
    const rets = monthDailyRets[mIdx] ?? [];
    const ymMap = monthYmSums[mIdx] ?? new Map<string, number>();
    const monthLogReturns = [...ymMap.values()];
    const monthSimplePct = monthLogReturns.map((lr) => (Math.exp(lr) - 1) * 100);
    const meanLog = meanValues(rets);
    let sqM = 0;
    for (const lr of rets) {
      const diff = lr - meanLog;
      sqM += diff * diff;
    }
    const annVolPct =
      rets.length > 1 ? 100 * Math.sqrt((TRADING_DAYS_PER_YEAR * sqM) / (rets.length - 1)) : Number.NaN;
    const posMonths = monthSimplePct.filter((v) => v > 0).length;

    return {
      monthIndex: mIdx,
      monthLabel,
      tradingDays: rets.length,
      monthsSampled: monthSimplePct.length,
      meanDailyReturnPct: rets.length > 0 ? meanLog * 100 : Number.NaN,
      avgMonthlyReturnPct: monthSimplePct.length > 0 ? meanValues(monthSimplePct) : Number.NaN,
      annualizedVolPct: annVolPct,
      positiveMonthRatePct:
        monthSimplePct.length > 0 ? (posMonths / monthSimplePct.length) * 100 : Number.NaN,
    };
  });

  return {
    status: 'OK',
    barsUsed: cleanBars.length,
    historyObservations: historySeries.length,
    pairedObservations,
    currentEvalVolPct,
    latestRv20Pct,
    latestRv23Pct,
    latestRv60Pct,
    vrpVsRv23Pts,
    ivRank,
    ivPercentile,
    quantiles: {
      minPct,
      p20Pct,
      p40Pct,
      p60Pct,
      p80Pct,
      maxPct,
      medianPct,
    },
    operativeRegime,
    buckets,
    historySeries,
    seasonalityMonths,
    extremeSessions,
  };
}

// ============================================================================
// 3. Cono Esperado + Densidad Implícita Breeden-Litzenberger Q vs. Lognormal
// ============================================================================

export interface ExpectedConeDensityInput {
  readonly spot: number;
  readonly atmIvPct: number;
  readonly daysToExpiry: number;
  readonly rate: number;
  readonly dividendYield: number;
  readonly qNodes?: readonly {
    readonly strike: number;
    readonly densityQ: number;
    readonly probAboveQ: number;
  }[];
}

export interface ConeDensityComparisonNode {
  readonly strike: number;
  readonly densityQ: number;
  readonly lognormalDensity: number;
  readonly probAboveQ: number;
}

export interface ExpectedConeDensitySummary {
  readonly status: 'OK' | 'NO_DATA';
  readonly dailyMoveAbs: number;
  readonly dailyMovePct: number;
  readonly horizonMove1SigmaPct: number;
  readonly upper1Sigma: number;
  readonly lower1Sigma: number;
  readonly upper2Sigma: number;
  readonly lower2Sigma: number;
  readonly probQAboveSpotPct: number;
  readonly probQBelowMinus10Pct: number;
  readonly comparisonNodes: readonly ConeDensityComparisonNode[];
}

export function buildExpectedConeAndLognormalSummary(
  input: ExpectedConeDensityInput,
): ExpectedConeDensitySummary {
  const { spot, atmIvPct, daysToExpiry, rate, dividendYield, qNodes } = input;
  const nanSummary: ExpectedConeDensitySummary = {
    status: 'NO_DATA',
    dailyMoveAbs: Number.NaN,
    dailyMovePct: Number.NaN,
    horizonMove1SigmaPct: Number.NaN,
    upper1Sigma: Number.NaN,
    lower1Sigma: Number.NaN,
    upper2Sigma: Number.NaN,
    lower2Sigma: Number.NaN,
    probQAboveSpotPct: Number.NaN,
    probQBelowMinus10Pct: Number.NaN,
    comparisonNodes: [],
  };

  if (
    !isPositiveFinite(spot) ||
    !isPositiveFinite(atmIvPct) ||
    !Number.isFinite(daysToExpiry) ||
    daysToExpiry < 0 ||
    !Number.isFinite(rate) ||
    !Number.isFinite(dividendYield)
  ) {
    return nanSummary;
  }

  const sigma = atmIvPct / 100;
  const t = daysToExpiry > 0 ? daysToExpiry / CALENDAR_DAYS_PER_YEAR : MIN_EXPECTED_MOVE_T_YEARS;
  const sqrtT = Math.sqrt(t);
  const dailyMovePct = (sigma / Math.sqrt(TRADING_DAYS_PER_YEAR)) * 100;
  const dailyMoveAbs = (spot * sigma) / Math.sqrt(TRADING_DAYS_PER_YEAR);
  const sigmaTau = sigma * sqrtT;
  const horizonMove1SigmaPct = sigmaTau * 100;
  const upper1Sigma = spot * Math.exp(sigmaTau);
  const lower1Sigma = spot * Math.exp(-sigmaTau);
  const upper2Sigma = spot * Math.exp(2 * sigmaTau);
  const lower2Sigma = spot * Math.exp(-2 * sigmaTau);

  const muLog = Math.log(spot) + (rate - dividendYield - 0.5 * sigma * sigma) * t;
  const cleanQNodes = (qNodes ?? [])
    .filter(
      (n) =>
        isPositiveFinite(n.strike) &&
        Number.isFinite(n.densityQ) &&
        n.densityQ >= 0 &&
        Number.isFinite(n.probAboveQ),
    )
    .slice()
    .sort((a, b) => a.strike - b.strike);

  const comparisonNodes: ConeDensityComparisonNode[] = cleanQNodes.map((n) => {
    const z = (Math.log(n.strike) - muLog) / sigmaTau;
    const lnPdf = normPdf(z) / (n.strike * sigmaTau);
    return {
      strike: n.strike,
      densityQ: n.densityQ,
      lognormalDensity: Number.isFinite(lnPdf) && lnPdf >= 0 ? lnPdf : Number.NaN,
      probAboveQ: clampUnit(n.probAboveQ),
    };
  });

  const probQAboveRaw = interpolateLinearPoints(
    comparisonNodes.map((n) => ({ x: n.strike, y: n.probAboveQ })),
    spot,
  );
  const probQAboveSpotPct = Number.isFinite(probQAboveRaw) ? probQAboveRaw * 100 : Number.NaN;

  const probQAboveMinus10Raw = interpolateLinearPoints(
    comparisonNodes.map((n) => ({ x: n.strike, y: n.probAboveQ })),
    spot * 0.9,
  );
  const probQBelowMinus10Pct = Number.isFinite(probQAboveMinus10Raw)
    ? clampPct((1 - probQAboveMinus10Raw) * 100)
    : Number.NaN;

  return {
    status: 'OK',
    dailyMoveAbs,
    dailyMovePct,
    horizonMove1SigmaPct,
    upper1Sigma,
    lower1Sigma,
    upper2Sigma,
    lower2Sigma,
    probQAboveSpotPct,
    probQBelowMinus10Pct,
    comparisonNodes,
  };
}

// ============================================================================
// 4. Paridad Call-Put Strike por Strike & Tasa Sintética Bid/Ask (TEA)
// ============================================================================

export interface ParityStrikeQuoteInput {
  readonly strike: number;
  readonly callBid: number | null;
  readonly callAsk: number | null;
  readonly callMid: number | null;
  /** IV en % (ej. 48.2). */
  readonly callIvPct: number | null;
  readonly putBid: number | null;
  readonly putAsk: number | null;
  readonly putMid: number | null;
  /** IV en % (ej. 51.0). */
  readonly putIvPct: number | null;
  readonly callVolume?: number | null;
  readonly putVolume?: number | null;
}

export interface ParitySyntheticStrikeRow {
  readonly strike: number;
  readonly callIvPct: number;
  readonly putIvPct: number;
  readonly ivSpreadPp: number;
  readonly callBid: number | null;
  readonly callAsk: number | null;
  readonly callMid: number;
  readonly putBid: number | null;
  readonly putAsk: number | null;
  readonly putMid: number;
  readonly syntheticForwardMid: number;
  readonly midImpliedTeaPct: number;
  /** Comprás sintético (+Call Ask / -Put Bid / -Spot Bid): tasa que tomás en pesos/USD. */
  readonly teaTomadoraPct: number;
  /** Colocás sintético (-Call Bid / +Put Ask / +Spot Ask): tasa que cobrás colocando. */
  readonly teaColocadoraPct: number;
  readonly canLendAboveBenchmark: boolean;
  readonly canBorrowBelowBenchmark: boolean;
  readonly edgeColocadoraBps: number;
  readonly edgeTomadoraBps: number;
}

export interface ParityAndSyntheticSuiteResult {
  readonly status: 'OK' | 'NO_DATA';
  readonly impliedRateStatus: ImpliedRateStatus;
  readonly daysToExpiry: number;
  readonly benchmarkTeaPct: number | null;
  readonly benchmarkLabel: string;
  readonly medianMidTeaPct: number;
  readonly medianTeaTomadoraPct: number;
  readonly medianTeaColocadoraPct: number;
  readonly bestColocadoraStrike: number | null;
  readonly bestColocadoraTeaPct: number;
  readonly bestTomadoraStrike: number | null;
  readonly bestTomadoraTeaPct: number;
  readonly strikes: readonly ParitySyntheticStrikeRow[];
}

export function computeParityAndSyntheticRatesByStrike(input: {
  readonly spotMid: number;
  readonly spotBid?: number | null;
  readonly spotAsk?: number | null;
  readonly daysToExpiry: number;
  readonly dividendYield: number;
  readonly benchmarkTeaPct: number | null;
  readonly benchmarkLabel?: string;
  readonly pairs: readonly ParityStrikeQuoteInput[];
}): ParityAndSyntheticSuiteResult {
  const benchmarkLabel = input.benchmarkLabel ?? 'Caución / SOFR';
  const emptyOut: ParityAndSyntheticSuiteResult = {
    status: 'NO_DATA',
    impliedRateStatus: 'NO_DATA',
    daysToExpiry: input.daysToExpiry,
    benchmarkTeaPct: input.benchmarkTeaPct,
    benchmarkLabel,
    medianMidTeaPct: Number.NaN,
    medianTeaTomadoraPct: Number.NaN,
    medianTeaColocadoraPct: Number.NaN,
    bestColocadoraStrike: null,
    bestColocadoraTeaPct: Number.NaN,
    bestTomadoraStrike: null,
    bestTomadoraTeaPct: Number.NaN,
    strikes: [],
  };

  if (
    !isPositiveFinite(input.spotMid) ||
    !Number.isFinite(input.daysToExpiry) ||
    input.daysToExpiry < 0 ||
    !Number.isFinite(input.dividendYield) ||
    !isRuntimeArray(input.pairs)
  ) {
    return emptyOut;
  }

  const isShortDteBlocked = input.daysToExpiry < MIN_SYNTHETIC_RATE_DTE;
  const t =
    input.daysToExpiry > 0
      ? input.daysToExpiry / CALENDAR_DAYS_PER_YEAR
      : MIN_EXPECTED_MOVE_T_YEARS;
  const spotMid = input.spotMid;
  const spotBid = isPositiveFinite(input.spotBid) ? input.spotBid : spotMid;
  const spotAsk = isPositiveFinite(input.spotAsk) ? input.spotAsk : spotMid;
  const divFactor = Math.exp(-input.dividendYield * t);
  const discSpotMid = spotMid * divFactor;
  const discSpotBid = spotBid * divFactor;
  const discSpotAsk = spotAsk * divFactor;
  const benchmarkTeaPct =
    input.benchmarkTeaPct !== null && Number.isFinite(input.benchmarkTeaPct)
      ? input.benchmarkTeaPct
      : null;

  const sortedPairs = input.pairs
    .filter((p) => isPositiveFinite(p.strike))
    .slice()
    .sort((a, b) => a.strike - b.strike);

  const dfCandidates: number[] = [];
  for (const p of sortedPairs) {
    const cM = resolveOptionSidePrice({ bid: p.callBid, ask: p.callAsk, mid: p.callMid }, 'mid').price;
    const pM = resolveOptionSidePrice({ bid: p.putBid, ask: p.putAsk, mid: p.putMid }, 'mid').price;
    if (isPositiveFinite(cM) && isPositiveFinite(pM)) {
      const capM = discSpotMid - (cM - pM);
      if (isPositiveFinite(capM)) {
        const ratio = capM / p.strike;
        if (Number.isFinite(ratio) && ratio > 0.5 && ratio <= 1.05) {
          dfCandidates.push(ratio);
        }
      }
    }
  }
  const impliedDf = dfCandidates.length > 0 ? medianValues(dfCandidates) : 1.0;

  const effectiveExtrinsic = (
    side: 'call' | 'put',
    strike: number,
    midPrice: number,
  ): number => {
    if (!Number.isFinite(midPrice)) return Number.NaN;
    const spotInt = intrinsicValue(side, spotMid, strike);
    if (midPrice >= spotInt - EXTRINSIC_EPS) {
      return extrinsicValue(side, spotMid, strike, midPrice);
    }
    const discInt = Math.max(
      0,
      side === 'call' ? discSpotMid - strike * impliedDf : strike * impliedDf - discSpotMid,
    );
    return midPrice - discInt;
  };

  const rows: ParitySyntheticStrikeRow[] = [];

  for (const p of sortedPairs) {
    // Pieza 46.1: IV capada (>= 999 %) o extrínseco <= 0.01 -> no calculable (excluida de C-P).
    const rawCallMid = resolveOptionSidePrice({ bid: p.callBid, ask: p.callAsk, mid: p.callMid }, 'mid').price;
    const rawPutMid = resolveOptionSidePrice({ bid: p.putBid, ask: p.putAsk, mid: p.putMid }, 'mid').price;
    const callReliable = !isIvUnreliable(
      (p.callIvPct ?? Number.NaN) / 100,
      effectiveExtrinsic('call', p.strike, rawCallMid),
    );
    const putReliable = !isIvUnreliable(
      (p.putIvPct ?? Number.NaN) / 100,
      effectiveExtrinsic('put', p.strike, rawPutMid),
    );
    const callIvPct =
      callReliable && isPositiveFinite(p.callIvPct) ? p.callIvPct : Number.NaN;
    const putIvPct = putReliable && isPositiveFinite(p.putIvPct) ? p.putIvPct : Number.NaN;
    const ivSpreadPp =
      Number.isFinite(callIvPct) && Number.isFinite(putIvPct) ? callIvPct - putIvPct : Number.NaN;

    const callMid = resolveOptionSidePrice(
      { bid: p.callBid, ask: p.callAsk, mid: p.callMid },
      'mid',
    ).price;
    const putMid = resolveOptionSidePrice(
      { bid: p.putBid, ask: p.putAsk, mid: p.putMid },
      'mid',
    ).price;

    let syntheticForwardMid = Number.NaN;
    let midImpliedTeaPct = Number.NaN;
    if (isPositiveFinite(callMid) && isPositiveFinite(putMid)) {
      const capMid = discSpotMid - (callMid - putMid);
      if (isPositiveFinite(capMid)) {
        const growth = p.strike / capMid;
        const fwd = p.strike + (callMid - putMid) * growth;
        if (Number.isFinite(fwd)) {
          syntheticForwardMid = fwd;
        }
        if (!isShortDteBlocked) {
          const tea = (Math.pow(growth, 1 / t) - 1) * 100;
          if (Number.isFinite(tea)) {
            midImpliedTeaPct = tea;
          }
        }
      }
    }

    // TEA Tomadora: -Spot(Bid) + Call(Ask) - Put(Bid) -> recibo capTomadora hoy, pago K al vencimiento
    let teaTomadoraPct = Number.NaN;
    if (
      !isShortDteBlocked &&
      isPositiveFinite(p.callAsk) &&
      isPositiveFinite(p.putBid) &&
      p.callAsk >= (p.callBid ?? 0)
    ) {
      const capTom = discSpotBid - (p.callAsk - p.putBid);
      if (isPositiveFinite(capTom)) {
        const teaTom = (Math.pow(p.strike / capTom, 1 / t) - 1) * 100;
        if (Number.isFinite(teaTom)) {
          teaTomadoraPct = teaTom;
        }
      }
    }

    // TEA Colocadora: +Spot(Ask) - Call(Bid) + Put(Ask) -> invierto capColocadora hoy, cobro K al vencimiento
    let teaColocadoraPct = Number.NaN;
    if (
      !isShortDteBlocked &&
      isPositiveFinite(p.callBid) &&
      isPositiveFinite(p.putAsk) &&
      (p.callAsk ?? p.callBid) >= p.callBid
    ) {
      const capCol = discSpotAsk - (p.callBid - p.putAsk);
      if (isPositiveFinite(capCol)) {
        const teaCol = (Math.pow(p.strike / capCol, 1 / t) - 1) * 100;
        if (Number.isFinite(teaCol)) {
          teaColocadoraPct = teaCol;
        }
      }
    }

    const hasValidRow =
      Number.isFinite(callIvPct) ||
      Number.isFinite(putIvPct) ||
      Number.isFinite(syntheticForwardMid) ||
      Number.isFinite(midImpliedTeaPct) ||
      Number.isFinite(teaTomadoraPct) ||
      Number.isFinite(teaColocadoraPct);
    if (!hasValidRow) continue;

    const canLendAboveBenchmark =
      !isShortDteBlocked &&
      benchmarkTeaPct !== null &&
      Number.isFinite(teaColocadoraPct) &&
      teaColocadoraPct > benchmarkTeaPct;
    const canBorrowBelowBenchmark =
      !isShortDteBlocked &&
      benchmarkTeaPct !== null &&
      Number.isFinite(teaTomadoraPct) &&
      teaTomadoraPct < benchmarkTeaPct;
    const edgeColocadoraBps =
      !isShortDteBlocked && benchmarkTeaPct !== null && Number.isFinite(teaColocadoraPct)
        ? (teaColocadoraPct - benchmarkTeaPct) * 100
        : Number.NaN;
    const edgeTomadoraBps =
      !isShortDteBlocked && benchmarkTeaPct !== null && Number.isFinite(teaTomadoraPct)
        ? (benchmarkTeaPct - teaTomadoraPct) * 100
        : Number.NaN;

    rows.push({
      strike: p.strike,
      callIvPct,
      putIvPct,
      ivSpreadPp,
      callBid: p.callBid,
      callAsk: p.callAsk,
      callMid,
      putBid: p.putBid,
      putAsk: p.putAsk,
      putMid,
      syntheticForwardMid,
      midImpliedTeaPct,
      teaTomadoraPct,
      teaColocadoraPct,
      canLendAboveBenchmark,
      canBorrowBelowBenchmark,
      edgeColocadoraBps,
      edgeTomadoraBps,
    });
  }

  if (rows.length === 0) {
    return emptyOut;
  }

  if (isShortDteBlocked) {
    return {
      status: 'OK',
      impliedRateStatus: 'BLOCKED_SHORT_DTE',
      daysToExpiry: input.daysToExpiry,
      benchmarkTeaPct,
      benchmarkLabel,
      medianMidTeaPct: Number.NaN,
      medianTeaTomadoraPct: Number.NaN,
      medianTeaColocadoraPct: Number.NaN,
      bestColocadoraStrike: null,
      bestColocadoraTeaPct: Number.NaN,
      bestTomadoraStrike: null,
      bestTomadoraTeaPct: Number.NaN,
      strikes: rows,
    };
  }

  const nearAtm = rows
    .slice()
    .sort((a, b) => Math.abs(a.strike - spotMid) - Math.abs(b.strike - spotMid))
    .slice(0, 5);

  const medianMidTeaPct = medianValues(nearAtm.map((r) => r.midImpliedTeaPct));
  const medianTeaTomadoraPct = medianValues(nearAtm.map((r) => r.teaTomadoraPct));
  const medianTeaColocadoraPct = medianValues(nearAtm.map((r) => r.teaColocadoraPct));

  let bestColocadoraStrike: number | null = null;
  let bestColocadoraTeaPct = Number.NaN;
  let bestTomadoraStrike: number | null = null;
  let bestTomadoraTeaPct = Number.NaN;

  for (const r of rows) {
    if (
      Number.isFinite(r.teaColocadoraPct) &&
      (bestColocadoraStrike === null || r.teaColocadoraPct > bestColocadoraTeaPct)
    ) {
      bestColocadoraStrike = r.strike;
      bestColocadoraTeaPct = r.teaColocadoraPct;
    }
    if (
      Number.isFinite(r.teaTomadoraPct) &&
      (bestTomadoraStrike === null || r.teaTomadoraPct < bestTomadoraTeaPct)
    ) {
      bestTomadoraStrike = r.strike;
      bestTomadoraTeaPct = r.teaTomadoraPct;
    }
  }

  return {
    status: 'OK',
    impliedRateStatus: 'OK',
    daysToExpiry: input.daysToExpiry,
    benchmarkTeaPct,
    benchmarkLabel,
    medianMidTeaPct,
    medianTeaTomadoraPct,
    medianTeaColocadoraPct,
    bestColocadoraStrike,
    bestColocadoraTeaPct,
    bestTomadoraStrike,
    bestTomadoraTeaPct,
    strikes: rows,
  };
}

// ============================================================================
// 5. Relación de Primas (1:N) & Costo Relativo de Estructuras (BS2002)
// ============================================================================

export interface StructureChainStrikeInput {
  readonly strike: number;
  readonly callBid: number | null;
  readonly callAsk: number | null;
  readonly callMid: number | null;
  readonly putBid: number | null;
  readonly putAsk: number | null;
  readonly putMid: number | null;
}

export interface OptionRatioFinancingRow {
  readonly side: 'CALL' | 'PUT';
  readonly targetOffsetPct: number;
  readonly longStrike: number;
  readonly longPrice: number;
  readonly shortStrike: number;
  readonly shortMoneynessPct: number;
  readonly shortPrice: number;
  readonly priceSource: 'BBO' | 'MID';
  /** Lotes OTM financiados contra 1 lote comprado (`longPrice / shortPrice`). */
  readonly otmLotsPerBought: number;
  readonly netCash1x2: number;
  readonly outerBreakeven1x2: number;
}

export interface RelativeStructureCostItem {
  readonly id: 'BULL_CALL_5' | 'BEAR_PUT_5' | 'BUTTERFLY_SYM';
  readonly name: string;
  readonly legsLabel: string;
  readonly strikes: readonly number[];
  readonly priceSource: 'BBO' | 'MID';
  readonly width: number;
  readonly netDebit: number;
  readonly maxProfit: number;
  readonly maxRisk: number;
  /** `netDebit / maxProfit * 100`. */
  readonly costPctOfMaxProfit: number;
  /** `netDebit / width * 100`. */
  readonly costPctOfWidth: number;
  readonly rewardRiskRatio: number;
  readonly breakevenLow: number;
  readonly breakevenHigh: number | null;
  readonly bs2002HistoricalPercentile: number;
  readonly bs2002HistoricalMinPct: number;
  readonly bs2002HistoricalMedianPct: number;
  readonly bs2002HistoricalMaxPct: number;
  readonly bs2002HistoricalObs: number;
}

export interface RatiosAndStructureCostsResult {
  readonly status: 'OK' | 'NO_DATA';
  readonly callRatios: readonly OptionRatioFinancingRow[];
  readonly putRatios: readonly OptionRatioFinancingRow[];
  readonly structures: readonly RelativeStructureCostItem[];
}

export function computeRatiosAndStructureCosts(input: {
  readonly spot: number;
  readonly daysToExpiry: number;
  readonly rate: number;
  readonly dividendYield: number;
  readonly strikes: readonly StructureChainStrikeInput[];
  readonly historicalVolPctSeries?: readonly number[];
  /** Pieza 46.1: IV ATM del vencimiento activo (decimal). Si es válida, los strikes 1x2 se escalan a ±1σ/±2σ. */
  readonly ivAtmDec?: number;
}): RatiosAndStructureCostsResult {
  const emptyOut: RatiosAndStructureCostsResult = {
    status: 'NO_DATA',
    callRatios: [],
    putRatios: [],
    structures: [],
  };
  if (
    !isPositiveFinite(input.spot) ||
    !Number.isFinite(input.daysToExpiry) ||
    input.daysToExpiry < 0 ||
    !Number.isFinite(input.rate) ||
    !Number.isFinite(input.dividendYield) ||
    !isRuntimeArray(input.strikes) ||
    input.strikes.length < 2
  ) {
    return emptyOut;
  }

  const { spot, daysToExpiry, rate, dividendYield } = input;
  const tExp =
    daysToExpiry > 0 ? daysToExpiry / CALENDAR_DAYS_PER_YEAR : MIN_EXPECTED_MOVE_T_YEARS;
  const sigmaMove =
    input.ivAtmDec !== undefined && isPositiveFinite(input.ivAtmDec)
      ? expectedMoveSigma(spot, input.ivAtmDec, tExp)
      : Number.NaN;
  const useSigma = Number.isFinite(sigmaMove);
  const sorted = input.strikes
    .filter((s) => isPositiveFinite(s.strike))
    .slice()
    .sort((a, b) => a.strike - b.strike);

  if (sorted.length < 2) {
    return emptyOut;
  }

  const getLeg = (
    row: StructureChainStrikeInput,
    ct: OptionContractType,
    side: 'buy' | 'sell',
  ) =>
    ct === 'call'
      ? resolveOptionSidePrice({ bid: row.callBid, ask: row.callAsk, mid: row.callMid }, side)
      : resolveOptionSidePrice({ bid: row.putBid, ask: row.putAsk, mid: row.putMid }, side);

  const histVols = (input.historicalVolPctSeries ?? [])
    .filter((v) => isPositiveFinite(v))
    .slice(-252);

  // 1) Relación de primas 1:N en Calls (+5%, +10%, +15%) y Puts (-5%, -10%, -15%)
  const callRatios: OptionRatioFinancingRow[] = [];
  const callLongCandidates = sorted
    .filter((s) => isPositiveFinite(getLeg(s, 'call', 'buy').price))
    .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
  const anchorCallRow = callLongCandidates[0];
  if (anchorCallRow !== undefined) {
    const longLeg = getLeg(anchorCallRow, 'call', 'buy');
    const seenCallShortStrikes = new Set<number>();
    const callTargets: readonly number[] = useSigma ? [1, 2] : [5, 10, 15];
    for (const targetPct of callTargets) {
      const targetK = useSigma ? spot + targetPct * sigmaMove : spot * (1 + targetPct / 100);
      const shortRow = sorted
        .filter(
          (s) =>
            s.strike > anchorCallRow.strike &&
            !seenCallShortStrikes.has(s.strike) &&
            isPositiveFinite(getLeg(s, 'call', 'sell').price),
        )
        .sort((a, b) => Math.abs(a.strike - targetK) - Math.abs(b.strike - targetK))[0];
      if (shortRow === undefined) continue;
      seenCallShortStrikes.add(shortRow.strike);
      const shortLeg = getLeg(shortRow, 'call', 'sell');
      if (!isRatioCardValid(longLeg.price, shortLeg.price) || (useSigma && shortLeg.price <= MIN_RATIO_PREMIUM)) {
        continue;
      }
      const netCash1x2 = 2 * shortLeg.price - longLeg.price;
      callRatios.push({
        side: 'CALL',
        targetOffsetPct: useSigma ? (targetK / spot - 1) * 100 : targetPct,
        longStrike: anchorCallRow.strike,
        longPrice: longLeg.price,
        shortStrike: shortRow.strike,
        shortMoneynessPct: (shortRow.strike / spot - 1) * 100,
        shortPrice: shortLeg.price,
        priceSource: longLeg.source === 'BBO' && shortLeg.source === 'BBO' ? 'BBO' : 'MID',
        otmLotsPerBought: longLeg.price / shortLeg.price,
        netCash1x2,
        outerBreakeven1x2: 2 * shortRow.strike - anchorCallRow.strike + netCash1x2,
      });
    }
  }

  const putRatios: OptionRatioFinancingRow[] = [];
  const putLongCandidates = sorted
    .filter((s) => isPositiveFinite(getLeg(s, 'put', 'buy').price))
    .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
  const anchorPutRow = putLongCandidates[0];
  if (anchorPutRow !== undefined) {
    const longLeg = getLeg(anchorPutRow, 'put', 'buy');
    const seenPutShortStrikes = new Set<number>();
    const putTargets: readonly number[] = useSigma ? [-1, -2] : [-5, -10, -15];
    for (const targetPct of putTargets) {
      const targetK = useSigma ? spot + targetPct * sigmaMove : spot * (1 + targetPct / 100);
      const shortRow = sorted
        .filter(
          (s) =>
            s.strike < anchorPutRow.strike &&
            !seenPutShortStrikes.has(s.strike) &&
            isPositiveFinite(getLeg(s, 'put', 'sell').price),
        )
        .sort((a, b) => Math.abs(a.strike - targetK) - Math.abs(b.strike - targetK))[0];
      if (shortRow === undefined) continue;
      seenPutShortStrikes.add(shortRow.strike);
      const shortLeg = getLeg(shortRow, 'put', 'sell');
      if (!isRatioCardValid(longLeg.price, shortLeg.price) || (useSigma && shortLeg.price <= MIN_RATIO_PREMIUM)) {
        continue;
      }
      const netCash1x2 = 2 * shortLeg.price - longLeg.price;
      putRatios.push({
        side: 'PUT',
        targetOffsetPct: useSigma ? (targetK / spot - 1) * 100 : targetPct,
        longStrike: anchorPutRow.strike,
        longPrice: longLeg.price,
        shortStrike: shortRow.strike,
        shortMoneynessPct: (shortRow.strike / spot - 1) * 100,
        shortPrice: shortLeg.price,
        priceSource: longLeg.source === 'BBO' && shortLeg.source === 'BBO' ? 'BBO' : 'MID',
        otmLotsPerBought: longLeg.price / shortLeg.price,
        netCash1x2,
        outerBreakeven1x2: 2 * shortRow.strike - anchorPutRow.strike - netCash1x2,
      });
    }
  }

  // Helper de percentil histórico BS2002 sobre el costo relativo (% del Beneficio Máximo)
  const evaluateBs2002Percentile = (params: {
    readonly currentCostPctMaxProfit: number;
    readonly grossWidthAtMax: number;
    readonly priceFn: (volDec: number) => number;
  }): {
    readonly percentile: number;
    readonly minPct: number;
    readonly medianPct: number;
    readonly maxPct: number;
    readonly obs: number;
  } => {
    const { currentCostPctMaxProfit, grossWidthAtMax, priceFn } = params;
    if (
      histVols.length < 5 ||
      !Number.isFinite(currentCostPctMaxProfit) ||
      !isPositiveFinite(grossWidthAtMax)
    ) {
      return {
        percentile: Number.NaN,
        minPct: Number.NaN,
        medianPct: Number.NaN,
        maxPct: Number.NaN,
        obs: 0,
      };
    }
    const histRatios: number[] = [];
    for (const vPct of histVols) {
      const theoDebit = priceFn(vPct / 100);
      if (isPositiveFinite(theoDebit) && theoDebit < grossWidthAtMax) {
        const theoCostPct = (theoDebit / (grossWidthAtMax - theoDebit)) * 100;
        if (Number.isFinite(theoCostPct) && theoCostPct > 0) {
          histRatios.push(theoCostPct);
        }
      }
    }
    if (histRatios.length < 5) {
      return {
        percentile: Number.NaN,
        minPct: Number.NaN,
        medianPct: Number.NaN,
        maxPct: Number.NaN,
        obs: histRatios.length,
      };
    }
    const sortedHist = histRatios.slice().sort((a, b) => a - b);
    const leCount = sortedHist.filter((r) => r <= currentCostPctMaxProfit).length;
    return {
      percentile: (leCount / sortedHist.length) * 100,
      minPct: sortedHist[0] ?? Number.NaN,
      medianPct: linearPercentile(sortedHist, 0.5),
      maxPct: sortedHist[sortedHist.length - 1] ?? Number.NaN,
      obs: sortedHist.length,
    };
  };

  const structures: RelativeStructureCostItem[] = [];

  // A) Bull Call Spread (+5% ancho)
  const validCalls = sorted.filter((s) => isPositiveFinite(getLeg(s, 'call', 'buy').price));
  const bullLong = validCalls
    .slice()
    .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))[0];
  if (bullLong !== undefined) {
    const targetShort = bullLong.strike * 1.05;
    const bullShort = sorted
      .filter((s) => s.strike > bullLong.strike && isPositiveFinite(getLeg(s, 'call', 'sell').price))
      .sort((a, b) => Math.abs(a.strike - targetShort) - Math.abs(b.strike - targetShort))[0];
    if (bullShort !== undefined) {
      const lBuy = getLeg(bullLong, 'call', 'buy');
      const sSell = getLeg(bullShort, 'call', 'sell');
      const width = bullShort.strike - bullLong.strike;
      const netDebit = lBuy.price - sSell.price;
      if (
        width > 0 &&
        isPositiveFinite(netDebit) &&
        netDebit >= DEFAULT_MIN_SPREAD_DEBIT - 1e-12 &&
        netDebit < width
      ) {
        const maxProfit = width - netDebit;
        const costPctOfMaxProfit = (netDebit / maxProfit) * 100;
        const costPctOfWidth = (netDebit / width) * 100;
        const hist = evaluateBs2002Percentile({
          currentCostPctMaxProfit: costPctOfMaxProfit,
          grossWidthAtMax: width,
          priceFn: (volDec) =>
            priceAmericanBjerksund2002({
              spot,
              strike: bullLong.strike,
              timeToExpiry: tExp,
              rate,
              dividendYield,
              volatility: volDec,
              contractType: 'call',
            }) -
            priceAmericanBjerksund2002({
              spot,
              strike: bullShort.strike,
              timeToExpiry: tExp,
              rate,
              dividendYield,
              volatility: volDec,
              contractType: 'call',
            }),
        });
        structures.push({
          id: 'BULL_CALL_5',
          name: 'Bull Call Spread (5% ancho)',
          legsLabel: `+1 Call ${String(bullLong.strike)} / -1 Call ${String(bullShort.strike)}`,
          strikes: [bullLong.strike, bullShort.strike],
          priceSource: lBuy.source === 'BBO' && sSell.source === 'BBO' ? 'BBO' : 'MID',
          width,
          netDebit,
          maxProfit,
          maxRisk: netDebit,
          costPctOfMaxProfit,
          costPctOfWidth,
          rewardRiskRatio: maxProfit / netDebit,
          breakevenLow: bullLong.strike + netDebit,
          breakevenHigh: null,
          bs2002HistoricalPercentile: hist.percentile,
          bs2002HistoricalMinPct: hist.minPct,
          bs2002HistoricalMedianPct: hist.medianPct,
          bs2002HistoricalMaxPct: hist.maxPct,
          bs2002HistoricalObs: hist.obs,
        });
      }
    }
  }

  // B) Bear Put Spread (-5% ancho)
  const validPuts = sorted.filter((s) => isPositiveFinite(getLeg(s, 'put', 'buy').price));
  const bearLong = validPuts
    .slice()
    .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))[0];
  if (bearLong !== undefined) {
    const targetShort = bearLong.strike * 0.95;
    const bearShort = sorted
      .filter((s) => s.strike < bearLong.strike && isPositiveFinite(getLeg(s, 'put', 'sell').price))
      .sort((a, b) => Math.abs(a.strike - targetShort) - Math.abs(b.strike - targetShort))[0];
    if (bearShort !== undefined) {
      const lBuy = getLeg(bearLong, 'put', 'buy');
      const sSell = getLeg(bearShort, 'put', 'sell');
      const width = bearLong.strike - bearShort.strike;
      const netDebit = lBuy.price - sSell.price;
      if (
        width > 0 &&
        isPositiveFinite(netDebit) &&
        netDebit >= DEFAULT_MIN_SPREAD_DEBIT - 1e-12 &&
        netDebit < width
      ) {
        const maxProfit = width - netDebit;
        const costPctOfMaxProfit = (netDebit / maxProfit) * 100;
        const costPctOfWidth = (netDebit / width) * 100;
        const hist = evaluateBs2002Percentile({
          currentCostPctMaxProfit: costPctOfMaxProfit,
          grossWidthAtMax: width,
          priceFn: (volDec) =>
            priceAmericanBjerksund2002({
              spot,
              strike: bearLong.strike,
              timeToExpiry: tExp,
              rate,
              dividendYield,
              volatility: volDec,
              contractType: 'put',
            }) -
            priceAmericanBjerksund2002({
              spot,
              strike: bearShort.strike,
              timeToExpiry: tExp,
              rate,
              dividendYield,
              volatility: volDec,
              contractType: 'put',
            }),
        });
        structures.push({
          id: 'BEAR_PUT_5',
          name: 'Bear Put Spread (5% ancho)',
          legsLabel: `+1 Put ${String(bearLong.strike)} / -1 Put ${String(bearShort.strike)}`,
          strikes: [bearShort.strike, bearLong.strike],
          priceSource: lBuy.source === 'BBO' && sSell.source === 'BBO' ? 'BBO' : 'MID',
          width,
          netDebit,
          maxProfit,
          maxRisk: netDebit,
          costPctOfMaxProfit,
          costPctOfWidth,
          rewardRiskRatio: maxProfit / netDebit,
          breakevenLow: bearLong.strike - netDebit,
          breakevenHigh: null,
          bs2002HistoricalPercentile: hist.percentile,
          bs2002HistoricalMinPct: hist.minPct,
          bs2002HistoricalMedianPct: hist.medianPct,
          bs2002HistoricalMaxPct: hist.maxPct,
          bs2002HistoricalObs: hist.obs,
        });
      }
    }
  }

  // C) Mariposa Simétrica (Call Butterfly centrada en ATM)
  const callAtmList = sorted.filter(
    (s) =>
      isPositiveFinite(getLeg(s, 'call', 'buy').price) &&
      isPositiveFinite(getLeg(s, 'call', 'sell').price),
  );
  if (callAtmList.length >= 3) {
    const centerCandidates = callAtmList
      .slice(1, callAtmList.length - 1)
      .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
    const center = centerCandidates[0];
    if (center !== undefined) {
      const lowers = callAtmList.filter((s) => s.strike < center.strike);
      const uppers = callAtmList.filter((s) => s.strike > center.strike);
      let bestPair:
        | {
            readonly k1: StructureChainStrikeInput;
            readonly k3: StructureChainStrikeInput;
            readonly asym: number;
            readonly targetDiff: number;
          }
        | null = null;
      const targetHalfWidth = spot * 0.05;
      for (const l of lowers) {
        const wL = center.strike - l.strike;
        for (const u of uppers) {
          const wR = u.strike - center.strike;
          const asym = Math.abs(wL - wR);
          const targetDiff = Math.abs(0.5 * (wL + wR) - targetHalfWidth);
          if (
            bestPair === null ||
            asym < bestPair.asym - 1e-6 ||
            (Math.abs(asym - bestPair.asym) <= 1e-6 && targetDiff < bestPair.targetDiff)
          ) {
            bestPair = { k1: l, k3: u, asym, targetDiff };
          }
        }
      }
      if (bestPair !== null) {
        const l1 = getLeg(bestPair.k1, 'call', 'buy');
        const c2 = getLeg(center, 'call', 'sell');
        const l3 = getLeg(bestPair.k3, 'call', 'buy');
        const netDebit = l1.price - 2 * c2.price + l3.price;
        const leftWidth = center.strike - bestPair.k1.strike;
        const rightWidth = bestPair.k3.strike - center.strike;
        const extraWingRisk = Math.max(0, rightWidth - leftWidth);
        const maxRisk = netDebit + extraWingRisk;
        const maxProfit = leftWidth - netDebit;
        if (
          isValidButterflyStrikes(bestPair.k1.strike, center.strike, bestPair.k3.strike, false) &&
          leftWidth > 0 &&
          isPositiveFinite(netDebit) &&
          netDebit >= DEFAULT_MIN_SPREAD_DEBIT - 1e-12 &&
          maxProfit > 0 &&
          maxRisk > 0
        ) {
          const costPctOfMaxProfit = (netDebit / maxProfit) * 100;
          const costPctOfWidth = (netDebit / leftWidth) * 100;
          const hist = evaluateBs2002Percentile({
            currentCostPctMaxProfit: costPctOfMaxProfit,
            grossWidthAtMax: leftWidth,
            priceFn: (volDec) =>
              priceAmericanBjerksund2002({
                spot,
                strike: bestPair.k1.strike,
                timeToExpiry: tExp,
                rate,
                dividendYield,
                volatility: volDec,
                contractType: 'call',
              }) -
              2 *
                priceAmericanBjerksund2002({
                  spot,
                  strike: center.strike,
                  timeToExpiry: tExp,
                  rate,
                  dividendYield,
                  volatility: volDec,
                  contractType: 'call',
                }) +
              priceAmericanBjerksund2002({
                spot,
                strike: bestPair.k3.strike,
                timeToExpiry: tExp,
                rate,
                dividendYield,
                volatility: volDec,
                contractType: 'call',
              }),
          });
          structures.push({
            id: 'BUTTERFLY_SYM',
            name: 'Mariposa Simétrica (Call)',
            legsLabel: `+1 C${String(bestPair.k1.strike)} / -2 C${String(center.strike)} / +1 C${String(bestPair.k3.strike)}`,
            strikes: [bestPair.k1.strike, center.strike, bestPair.k3.strike],
            priceSource:
              l1.source === 'BBO' && c2.source === 'BBO' && l3.source === 'BBO' ? 'BBO' : 'MID',
            width: leftWidth,
            netDebit,
            maxProfit,
            maxRisk,
            costPctOfMaxProfit,
            costPctOfWidth,
            rewardRiskRatio: maxProfit / maxRisk,
            breakevenLow: bestPair.k1.strike + netDebit,
            breakevenHigh: 2 * center.strike - bestPair.k1.strike - netDebit,
            bs2002HistoricalPercentile: hist.percentile,
            bs2002HistoricalMinPct: hist.minPct,
            bs2002HistoricalMedianPct: hist.medianPct,
            bs2002HistoricalMaxPct: hist.maxPct,
            bs2002HistoricalObs: hist.obs,
          });
        }
      }
    }
  }

  return {
    status:
      callRatios.length > 0 || putRatios.length > 0 || structures.length > 0 ? 'OK' : 'NO_DATA',
    callRatios,
    putRatios,
    structures,
  };
}

// ============================================================================
// 6. Comparación Dual BYMA (ARS) vs. OPRA ADR (USD)
// ============================================================================

export interface DualSurfaceNode {
  readonly offsetPct: number;
  readonly bymaIvPct: number;
  readonly opraAdrIvPct: number;
  readonly theoreticalBymaIvPct: number;
  readonly spreadBymaMinusOpraPp: number;
  readonly spreadBymaMinusTheoreticalPp: number;
}

export interface DualBymaOpraSurfaceResult {
  readonly status: 'OK' | 'NO_DATA';
  readonly arUnderlying: string;
  readonly adrTicker: string;
  readonly adrRatio: number;
  readonly bymaSpotArs: number;
  readonly adrSpotUsd: number;
  readonly cclImplicit: number;
  readonly bymaExpiryCode: string;
  readonly bymaDays: number;
  readonly opraExpiryDate: string;
  readonly opraDays: number;
  readonly cclAnnualVolPct: number;
  readonly corrAdrCcl: number;
  readonly bymaAtmIvPct: number;
  readonly opraAtmIvPct: number;
  readonly theoreticalAtmIvPct: number;
  readonly atmSpreadBymaVsOpraPp: number;
  readonly atmSpreadBymaVsTheoreticalPp: number;
  readonly nodes: readonly DualSurfaceNode[];
}

export function computeDualBymaVsOpraSurface(input: {
  readonly arUnderlying: string;
  readonly adrTicker: string;
  readonly adrRatio: number;
  readonly bymaSpotArs: number;
  readonly adrSpotUsd: number;
  readonly cclImplicit: number;
  readonly bymaExpiryCode: string;
  readonly bymaDays: number;
  readonly opraExpiryDate: string;
  readonly opraDays: number;
  readonly bymaCompositeOtmPoints: readonly { readonly moneynessPct: number; readonly ivPct: number }[];
  readonly opraCompositeOtmPoints: readonly { readonly moneynessPct: number; readonly ivPct: number }[];
  readonly cclAnnualVolPct: number;
  readonly corrAdrCcl: number;
  readonly offsetsPct?: readonly number[];
}): DualBymaOpraSurfaceResult {
  const offsetsPct = input.offsetsPct ?? DEFAULT_MONEYNESS_OFFSETS_PCT;
  const nanOut: DualBymaOpraSurfaceResult = {
    status: 'NO_DATA',
    arUnderlying: input.arUnderlying,
    adrTicker: input.adrTicker,
    adrRatio: input.adrRatio,
    bymaSpotArs: input.bymaSpotArs,
    adrSpotUsd: input.adrSpotUsd,
    cclImplicit: input.cclImplicit,
    bymaExpiryCode: input.bymaExpiryCode,
    bymaDays: input.bymaDays,
    opraExpiryDate: input.opraExpiryDate,
    opraDays: input.opraDays,
    cclAnnualVolPct: input.cclAnnualVolPct,
    corrAdrCcl: input.corrAdrCcl,
    bymaAtmIvPct: Number.NaN,
    opraAtmIvPct: Number.NaN,
    theoreticalAtmIvPct: Number.NaN,
    atmSpreadBymaVsOpraPp: Number.NaN,
    atmSpreadBymaVsTheoreticalPp: Number.NaN,
    nodes: [],
  };

  if (
    !isPositiveFinite(input.bymaSpotArs) ||
    !isPositiveFinite(input.adrSpotUsd) ||
    !isPositiveFinite(input.adrRatio) ||
    !isPositiveFinite(input.cclImplicit) ||
    (input.bymaCompositeOtmPoints.length === 0 && input.opraCompositeOtmPoints.length === 0)
  ) {
    return nanOut;
  }

  const bymaSorted = input.bymaCompositeOtmPoints
    .filter((p) => Number.isFinite(p.moneynessPct) && isPositiveFinite(p.ivPct))
    .map((p) => ({ x: p.moneynessPct, y: p.ivPct }))
    .sort((a, b) => a.x - b.x);
  const opraSorted = input.opraCompositeOtmPoints
    .filter((p) => Number.isFinite(p.moneynessPct) && isPositiveFinite(p.ivPct))
    .map((p) => ({ x: p.moneynessPct, y: p.ivPct }))
    .sort((a, b) => a.x - b.x);

  const hasCclTriangle =
    isPositiveFinite(input.cclAnnualVolPct) &&
    Number.isFinite(input.corrAdrCcl) &&
    Math.abs(input.corrAdrCcl) <= 1;
  const sigmaCcl = hasCclTriangle ? input.cclAnnualVolPct / 100 : Number.NaN;
  const rho = hasCclTriangle ? input.corrAdrCcl : Number.NaN;

  const evalTheoretical = (opraIvPct: number): number => {
    if (!isPositiveFinite(opraIvPct) || !Number.isFinite(sigmaCcl) || !Number.isFinite(rho)) {
      return Number.NaN;
    }
    const sigmaAdr = opraIvPct / 100;
    const varTheor = Math.max(
      0,
      sigmaAdr * sigmaAdr + sigmaCcl * sigmaCcl + 2 * rho * sigmaAdr * sigmaCcl,
    );
    return Math.sqrt(varTheor) * 100;
  };

  const nodes: DualSurfaceNode[] = offsetsPct.map((offsetPct) => {
    const bymaIvPct = interpolateLinearPoints(bymaSorted, offsetPct);
    const opraAdrIvPct = interpolateLinearPoints(opraSorted, offsetPct);
    const theoreticalBymaIvPct = evalTheoretical(opraAdrIvPct);
    return {
      offsetPct,
      bymaIvPct,
      opraAdrIvPct,
      theoreticalBymaIvPct,
      spreadBymaMinusOpraPp:
        Number.isFinite(bymaIvPct) && Number.isFinite(opraAdrIvPct)
          ? bymaIvPct - opraAdrIvPct
          : Number.NaN,
      spreadBymaMinusTheoreticalPp:
        Number.isFinite(bymaIvPct) && Number.isFinite(theoreticalBymaIvPct)
          ? bymaIvPct - theoreticalBymaIvPct
          : Number.NaN,
    };
  });

  const bymaAtmIvPct = interpolateLinearPoints(bymaSorted, 0);
  const opraAtmIvPct = interpolateLinearPoints(opraSorted, 0);
  const theoreticalAtmIvPct = evalTheoretical(opraAtmIvPct);

  return {
    status: 'OK',
    arUnderlying: input.arUnderlying,
    adrTicker: input.adrTicker,
    adrRatio: input.adrRatio,
    bymaSpotArs: input.bymaSpotArs,
    adrSpotUsd: input.adrSpotUsd,
    cclImplicit: input.cclImplicit,
    bymaExpiryCode: input.bymaExpiryCode,
    bymaDays: input.bymaDays,
    opraExpiryDate: input.opraExpiryDate,
    opraDays: input.opraDays,
    cclAnnualVolPct: input.cclAnnualVolPct,
    corrAdrCcl: input.corrAdrCcl,
    bymaAtmIvPct,
    opraAtmIvPct,
    theoreticalAtmIvPct,
    atmSpreadBymaVsOpraPp:
      Number.isFinite(bymaAtmIvPct) && Number.isFinite(opraAtmIvPct)
        ? bymaAtmIvPct - opraAtmIvPct
        : Number.NaN,
    atmSpreadBymaVsTheoreticalPp:
      Number.isFinite(bymaAtmIvPct) && Number.isFinite(theoreticalAtmIvPct)
        ? bymaAtmIvPct - theoreticalAtmIvPct
        : Number.NaN,
    nodes,
  };
}

export interface CclAdrCorrelationResult {
  readonly status: 'OK' | 'NO_DATA';
  readonly observations: number;
  readonly cclAnnualVolPct: number;
  readonly corrAdrCcl: number;
}

/**
 * Estima la volatilidad anualizada del CCL implícito (ARS*ratio/ADR_USD) y la correlación
 * diaria de retornos logarítmicos entre el ADR (USD) y el CCL implícito sobre fechas comunes UTC.
 */
export function computeCclVolAndAdrCorrelation(input: {
  readonly arBars: readonly HistoricalDailyBarInput[];
  readonly adrBars: readonly HistoricalDailyBarInput[];
  readonly adrRatio: number;
  readonly maxPairs?: number;
  readonly minObservations?: number;
}): CclAdrCorrelationResult {
  const maxPairs = input.maxPairs ?? 252;
  const minObs = input.minObservations ?? 20;
  const nanOut: CclAdrCorrelationResult = {
    status: 'NO_DATA',
    observations: 0,
    cclAnnualVolPct: Number.NaN,
    corrAdrCcl: Number.NaN,
  };

  if (
    !isRuntimeArray(input.arBars) ||
    !isRuntimeArray(input.adrBars) ||
    !isPositiveFinite(input.adrRatio)
  ) {
    return nanOut;
  }

  const arByDate = new Map<string, number>();
  for (const b of input.arBars) {
    if (Number.isFinite(b.time) && isPositiveFinite(b.close)) {
      const dk = new Date(b.time * 1_000).toISOString().slice(0, 10);
      arByDate.set(dk, b.close);
    }
  }

  const aligned: { readonly date: string; readonly adrClose: number; readonly ccl: number }[] = [];
  const adrSeen = new Set<string>();
  const adrSorted = input.adrBars
    .filter((b) => Number.isFinite(b.time) && isPositiveFinite(b.close))
    .slice()
    .sort((a, b) => a.time - b.time);

  for (const b of adrSorted) {
    const dk = new Date(b.time * 1_000).toISOString().slice(0, 10);
    if (adrSeen.has(dk)) continue;
    adrSeen.add(dk);
    const arClose = arByDate.get(dk);
    if (arClose === undefined || !isPositiveFinite(arClose)) continue;
    const ccl = (arClose * input.adrRatio) / b.close;
    if (isPositiveFinite(ccl)) {
      aligned.push({ date: dk, adrClose: b.close, ccl });
    }
  }

  if (aligned.length <= minObs) {
    return { ...nanOut, observations: Math.max(0, aligned.length - 1) };
  }

  const rAdr: number[] = [];
  const rCcl: number[] = [];
  for (let i = 1; i < aligned.length; i += 1) {
    const prev = aligned[i - 1];
    const curr = aligned[i];
    if (prev === undefined || curr === undefined) continue;
    const lrAdr = Math.log(curr.adrClose / prev.adrClose);
    const lrCcl = Math.log(curr.ccl / prev.ccl);
    if (Number.isFinite(lrAdr) && Number.isFinite(lrCcl)) {
      rAdr.push(lrAdr);
      rCcl.push(lrCcl);
    }
  }

  const n = Math.min(rAdr.length, maxPairs);
  if (n < minObs) {
    return { ...nanOut, observations: n };
  }

  const sliceAdr = rAdr.slice(-n);
  const sliceCcl = rCcl.slice(-n);
  const meanAdr = meanValues(sliceAdr);
  const meanCcl = meanValues(sliceCcl);

  let varAdr = 0;
  let varCcl = 0;
  let cov = 0;
  for (let i = 0; i < n; i += 1) {
    const da = (sliceAdr[i] ?? 0) - meanAdr;
    const dc = (sliceCcl[i] ?? 0) - meanCcl;
    varAdr += da * da;
    varCcl += dc * dc;
    cov += da * dc;
  }

  if (varAdr <= 0 || varCcl <= 0) {
    return { ...nanOut, observations: n };
  }

  const cclAnnualVolPct = 100 * Math.sqrt((TRADING_DAYS_PER_YEAR * varCcl) / (n - 1));
  const rawCorr = cov / Math.sqrt(varAdr * varCcl);
  const corrAdrCcl = Math.max(-1, Math.min(1, rawCorr));

  return {
    status: Number.isFinite(cclAnnualVolPct) && Number.isFinite(corrAdrCcl) ? 'OK' : 'NO_DATA',
    observations: n,
    cclAnnualVolPct,
    corrAdrCcl,
  };
}

export interface VolAnalyticsPriorSmileSnapshot {
  readonly dateKey: string;
  readonly tradingDaysAgo: number;
  readonly atmIvPct: number;
  readonly compositeOtmPoints: readonly CompositeOtmSmilePoint[];
}

export interface VolAnalyticsExpirySuiteResult {
  readonly expiryCode: string;
  readonly expirationDate: string;
  readonly daysToExpiry: number;
  readonly smileOtmOnly: SeparatedSmileResult;
  readonly smileAll: SeparatedSmileResult;
  readonly priorSmile: VolAnalyticsPriorSmileSnapshot | null;
  readonly expectedCone: ExpectedConeDensitySummary;
  readonly parity: ParityAndSyntheticSuiteResult;
  readonly ratiosAndStructures: RatiosAndStructureCostsResult;
  readonly activeExpiryVrp?: ActiveExpiryVrpResult;
}

export interface VolAnalyticsSuiteResult {
  readonly status: 'OK' | 'NO_DATA';
  readonly market: 'BYMA' | 'US';
  readonly underlying: string;
  readonly spot: number;
  readonly rateContinuous: number;
  readonly rateTeaPct: number;
  readonly benchmarkLabel: string;
  readonly dividendYield: number;
  readonly activeExpiryCode: string | null;
  readonly hasDualAdr: boolean;
  readonly nonDualMessage: string | null;
  readonly moneynessMatrixOtm: NormalizedMoneynessMatrixResult;
  readonly moneynessMatrixAll: NormalizedMoneynessMatrixResult;
  readonly historicalConditional: HistoricalVolConditionalResult;
  readonly rvWindows: {
    readonly rv20: ReturnType<typeof computeRollingRvDistributionAtWindow>;
    readonly rv60: ReturnType<typeof computeRollingRvDistributionAtWindow>;
    readonly rv120: ReturnType<typeof computeRollingRvDistributionAtWindow>;
  };
  readonly dualSurface: DualBymaOpraSurfaceResult | null;
  readonly expiriesByCode: Readonly<Record<string, VolAnalyticsExpirySuiteResult>>;
}
