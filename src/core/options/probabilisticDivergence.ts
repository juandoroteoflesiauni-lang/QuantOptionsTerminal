/**
 * Motor puro de Divergencia Probabilística (ℙ vs. ℚ), Colas Gruesas (> 3σ) y Cono Esperado
 * (Pieza 17 — Bloque III Parte 1, Motor 8).
 *
 * Implementa:
 *  1. `extractRiskNeutralDistributionQ`: identidad de Breeden-Litzenberger (1978) sobre una
 *     grilla ordenada de strikes y volatilidades implícitas suavizadas.
 *  2. `analyzeEmpiricalDistributionP`: distribución empírica histórica (ℙ) a horizonte H días
 *     con descomposición Gap Overnight vs. RTH y detección de eventos de cola (> 3σ).
 *  3. `evaluatePqLevelDivergence`: comparación directa de probabilidades terminales P vs. Q
 *     sobre niveles técnicos objetivo para cuantificar convexidad o sobreprecio de prima.
 *  4. `computeVolConeAndRank`: cono de movimiento lognormal (1σ, 2σ) e IV Rank / IV Percentile.
 *
 * Funciones 100 % puras: cero red, cero E/S, cero UI y cero mutación de argumentos.
 */

import { MAX_TIME_SECONDS } from '../sessions.js';
import { priceBsm } from './blackScholes.js';

const STRIKE_DEDUP_TOLERANCE = 1e-9;
const MIN_Q_STRIKES = 5;
const DEFAULT_UNIFORM_Q_GRID_STEPS = 41;
const MIN_TOTAL_VARIANCE_FLOOR = 1e-8;
const DEFAULT_MIN_HISTORY_BARS = 30;
const DEFAULT_TAIL_SIGMA_THRESHOLD = 3.0;
const DEFAULT_MIN_EDGE_SPREAD = 0.05;
const DEFAULT_MIN_IV_HISTORY_COUNT = 10;
const DAYS_PER_YEAR = 365;
const PROB_DIVISOR_EPS = 1e-9;

export type ProbabilisticEngineStatus = 'OK' | 'NO_DATA';

export interface RiskNeutralInputNode {
  readonly strike: number;
  readonly iv: number;
  readonly bid?: number | null;
}

export interface RiskNeutralDistributionInput {
  readonly spot: number;
  readonly rate: number;
  readonly dividendYield: number;
  readonly timeToExpiry: number;
  readonly nodes: readonly RiskNeutralInputNode[];
  /**
   * Pieza 45: Suavizado de sonrisa en varianza total w(k) = iv(k)^2 * T mediante
   * spline cúbico monótono PCHIP (Fritsch-Carlson) en log-moneyness k = ln(K / F)
   * sobre strikes con bid > 0 y evaluación BSM sobre grilla uniforme de strikes.
   */
  readonly smoothTotalVariancePchip?: boolean;
  readonly uniformGridSteps?: number;
  readonly requirePositiveBid?: boolean;
}

export interface RiskNeutralNode {
  readonly strike: number;
  readonly iv: number;
  readonly callPrice: number;
  readonly dCdK: number;
  readonly d2CdK2: number;
  readonly probAboveQ: number;
  readonly rawDensityQ: number;
  readonly densityQ: number;
}

export interface RiskNeutralDistributionResult {
  readonly status: ProbabilisticEngineStatus;
  readonly rawArea: number;
  readonly normalizedArea: number;
  readonly meanQ: number;
  readonly varianceQ: number;
  readonly stdDevQ: number;
  readonly skewnessQ: number;
  readonly excessKurtosisQ: number;
  readonly nodes: readonly RiskNeutralNode[];
}

export interface DailyBarInput {
  readonly time: number;
  readonly open: number;
  readonly high?: number;
  readonly low?: number;
  readonly close: number;
  readonly volume?: number;
}

export interface EmpiricalDistributionOptions {
  readonly asOfUtcSec: number;
  readonly spot: number;
  readonly horizonDays: number;
  readonly dailyRiskFreeRate?: number;
  readonly minHistoryBars?: number;
  readonly tailSigmaThreshold?: number;
}

export interface EmpiricalTailEvent {
  readonly time: number;
  readonly totalReturn: number;
  readonly zScore: number;
  readonly overnightReturn: number;
  readonly rthReturn: number;
  readonly overnightShare: number;
}

export interface EmpiricalDistributionResult {
  readonly status: ProbabilisticEngineStatus;
  readonly usedBarsCount: number;
  readonly horizonSamplesCount: number;
  readonly meanLogReturn: number;
  readonly stdDevLogReturn: number;
  readonly skewness: number;
  readonly excessKurtosis: number;
  readonly overnightVariance: number;
  readonly rthVariance: number;
  readonly overnightVarianceShare: number;
  readonly rthVarianceShare: number;
  readonly tailEventsCount: number;
  readonly tailFrequencyPct: number;
  readonly overnightTailContributionShare: number;
  readonly horizonLogReturns: readonly number[];
  readonly projectedTerminalPrices: readonly number[];
  readonly tailEvents: readonly EmpiricalTailEvent[];
}

export type PqDivergenceClassification =
  | 'POSITIVE_EV_LONG_CONVEXITY'
  | 'OVERPRICED_PREMIUM_SHORT_EDGE'
  | 'FAIRLY_PRICED'
  | 'NO_DATA';

export interface TargetLevelInput {
  readonly label: string;
  readonly price: number;
  readonly direction?: 'ABOVE' | 'BELOW';
}

export interface PqLevelDivergenceInput {
  readonly spot: number;
  readonly qDistribution: RiskNeutralDistributionResult;
  readonly pDistribution: EmpiricalDistributionResult;
  readonly targetLevels: readonly TargetLevelInput[];
  readonly minEdgeSpread?: number;
}

export interface PqLevelEvaluation {
  readonly label: string;
  readonly price: number;
  readonly direction: 'ABOVE' | 'BELOW';
  readonly probP: number;
  readonly probQ: number;
  readonly pqSpread: number;
  readonly pqRatio: number;
  readonly classification: PqDivergenceClassification;
}

export interface PqLevelDivergenceResult {
  readonly status: ProbabilisticEngineStatus;
  readonly levels: readonly PqLevelEvaluation[];
}

export interface VolConeAndRankInput {
  readonly spot: number;
  readonly ivAtm: number;
  readonly horizonsDays: readonly number[];
  readonly ivHistory: readonly number[];
  readonly minIvHistoryCount?: number;
}

export interface VolConePoint {
  readonly horizonDays: number;
  readonly sigmaMovePct: number;
  readonly upper1Sigma: number;
  readonly lower1Sigma: number;
  readonly upper2Sigma: number;
  readonly lower2Sigma: number;
}

export interface VolConeAndRankResult {
  readonly status: ProbabilisticEngineStatus;
  readonly ivAtm: number;
  readonly ivMin: number;
  readonly ivMax: number;
  readonly ivRank: number;
  readonly ivPercentile: number;
  readonly cones: readonly VolConePoint[];
}

const NO_DATA_Q_RESULT: RiskNeutralDistributionResult = Object.freeze({
  status: 'NO_DATA',
  rawArea: Number.NaN,
  normalizedArea: Number.NaN,
  meanQ: Number.NaN,
  varianceQ: Number.NaN,
  stdDevQ: Number.NaN,
  skewnessQ: Number.NaN,
  excessKurtosisQ: Number.NaN,
  nodes: [],
});

const NO_DATA_P_RESULT: EmpiricalDistributionResult = Object.freeze({
  status: 'NO_DATA',
  usedBarsCount: 0,
  horizonSamplesCount: 0,
  meanLogReturn: Number.NaN,
  stdDevLogReturn: Number.NaN,
  skewness: Number.NaN,
  excessKurtosis: Number.NaN,
  overnightVariance: Number.NaN,
  rthVariance: Number.NaN,
  overnightVarianceShare: Number.NaN,
  rthVarianceShare: Number.NaN,
  tailEventsCount: 0,
  tailFrequencyPct: Number.NaN,
  overnightTailContributionShare: Number.NaN,
  horizonLogReturns: [],
  projectedTerminalPrices: [],
  tailEvents: [],
});

const NO_DATA_PQ_RESULT: PqLevelDivergenceResult = Object.freeze({
  status: 'NO_DATA',
  levels: [],
});

const NO_DATA_CONE_RESULT: VolConeAndRankResult = Object.freeze({
  status: 'NO_DATA',
  ivAtm: Number.NaN,
  ivMin: Number.NaN,
  ivMax: Number.NaN,
  ivRank: Number.NaN,
  ivPercentile: Number.NaN,
  cones: [],
});

function isRuntimeArray(value: unknown): boolean {
  return Array.isArray(value);
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return Number.NaN;
  }
  return Math.min(1, Math.max(0, value));
}

function secondDividedDiff(
  nodes: readonly { readonly strike: number; readonly callPrice: number }[],
  a: number,
  b: number,
  c: number,
): number {
  const na = nodes[a];
  const nb = nodes[b];
  const nc = nodes[c];
  if (na === undefined || nb === undefined || nc === undefined) {
    return Number.NaN;
  }
  const hLeft = nb.strike - na.strike;
  const hRight = nc.strike - nb.strike;
  const span = nc.strike - na.strike;
  if (hLeft <= 0 || hRight <= 0 || span <= 0) {
    return Number.NaN;
  }
  const slopeRight = (nc.callPrice - nb.callPrice) / hRight;
  const slopeLeft = (nb.callPrice - na.callPrice) / hLeft;
  return (2 * (slopeRight - slopeLeft)) / span;
}

function integrateTrapezoid(
  xs: readonly number[],
  ys: readonly number[],
): number {
  let area = 0;
  for (let i = 0; i < xs.length - 1; i += 1) {
    const x0 = xs[i];
    const x1 = xs[i + 1];
    const y0 = ys[i];
    const y1 = ys[i + 1];
    if (x0 === undefined || x1 === undefined || y0 === undefined || y1 === undefined) {
      return Number.NaN;
    }
    area += 0.5 * (y0 + y1) * (x1 - x0);
  }
  return area;
}

function computeMeanAndSampleVariance(values: readonly number[]): {
  readonly mean: number;
  readonly sampleVariance: number;
  readonly m2: number;
  readonly m3: number;
  readonly m4: number;
} {
  const n = values.length;
  if (n < 2) {
    return {
      mean: Number.NaN,
      sampleVariance: Number.NaN,
      m2: Number.NaN,
      m3: Number.NaN,
      m4: Number.NaN,
    };
  }
  let sum = 0;
  for (const v of values) {
    sum += v;
  }
  const mean = sum / n;
  let sumSq = 0;
  let sumCube = 0;
  let sumQuad = 0;
  for (const v of values) {
    const d = v - mean;
    const d2 = d * d;
    sumSq += d2;
    sumCube += d2 * d;
    sumQuad += d2 * d2;
  }
  return {
    mean,
    sampleVariance: sumSq / (n - 1),
    m2: sumSq / n,
    m3: sumCube / n,
    m4: sumQuad / n,
  };
}

function computePchipSlopes(
  xs: readonly number[],
  ys: readonly number[],
): readonly number[] {
  const m = xs.length;
  if (m < 2 || ys.length !== m) {
    return [];
  }
  const h: number[] = [];
  const delta: number[] = [];
  for (let i = 0; i < m - 1; i += 1) {
    const x0 = xs[i];
    const x1 = xs[i + 1];
    const y0 = ys[i];
    const y1 = ys[i + 1];
    if (x0 === undefined || x1 === undefined || y0 === undefined || y1 === undefined) {
      return [];
    }
    const hi = x1 - x0;
    if (!isPositiveFinite(hi)) {
      return [];
    }
    h.push(hi);
    delta.push((y1 - y0) / hi);
  }

  if (m === 2) {
    const d0 = delta[0] ?? 0;
    return [d0, d0];
  }

  const d: number[] = new Array<number>(m).fill(0);

  // Endpoint d[0] — PCHIP one-sided three-point formula with monotonicity limiter
  const h0 = h[0] ?? 1;
  const h1 = h[1] ?? 1;
  const del0 = delta[0] ?? 0;
  const del1 = delta[1] ?? 0;
  let d0 = ((2 * h0 + h1) * del0 - h0 * del1) / (h0 + h1);
  if (d0 * del0 <= 0) {
    d0 = 0;
  } else if (del0 * del1 < 0 && Math.abs(d0) > 3 * Math.abs(del0)) {
    d0 = 3 * del0;
  }
  d[0] = d0;

  // Interior slopes d[1..m-2] — Fritsch-Carlson / Brodlie weighted harmonic mean
  for (let i = 1; i < m - 1; i += 1) {
    const delPrev = delta[i - 1] ?? 0;
    const delCurr = delta[i] ?? 0;
    if (delPrev * delCurr <= 0) {
      d[i] = 0;
    } else {
      const hPrev = h[i - 1] ?? 1;
      const hCurr = h[i] ?? 1;
      const w1 = 2 * hCurr + hPrev;
      const w2 = hCurr + 2 * hPrev;
      d[i] = (w1 + w2) / (w1 / delPrev + w2 / delCurr);
    }
  }

  // Endpoint d[m-1]
  const hm2 = h[m - 2] ?? 1;
  const hm3 = h[m - 3] ?? 1;
  const delm2 = delta[m - 2] ?? 0;
  const delm3 = delta[m - 3] ?? 0;
  let dm1 = ((2 * hm2 + hm3) * delm2 - hm2 * delm3) / (hm2 + hm3);
  if (dm1 * delm2 <= 0) {
    dm1 = 0;
  } else if (delm2 * delm3 < 0 && Math.abs(dm1) > 3 * Math.abs(delm2)) {
    dm1 = 3 * delm2;
  }
  d[m - 1] = dm1;

  return d;
}

function evaluatePchipAt(
  xs: readonly number[],
  ys: readonly number[],
  slopes: readonly number[],
  xTarget: number,
): number {
  const m = xs.length;
  if (m === 0 || ys.length !== m || slopes.length !== m || !Number.isFinite(xTarget)) {
    return Number.NaN;
  }
  const firstX = xs[0];
  const lastX = xs[m - 1];
  if (firstX === undefined || lastX === undefined) {
    return Number.NaN;
  }
  if (xTarget <= firstX) {
    return ys[0] ?? Number.NaN;
  }
  if (xTarget >= lastX) {
    return ys[m - 1] ?? Number.NaN;
  }

  let idx = 0;
  for (let i = 0; i < m - 1; i += 1) {
    const xi = xs[i];
    const xi1 = xs[i + 1];
    if (xi !== undefined && xi1 !== undefined && xTarget >= xi && xTarget <= xi1) {
      idx = i;
      break;
    }
  }

  const x0 = xs[idx];
  const x1 = xs[idx + 1];
  const y0 = ys[idx];
  const y1 = ys[idx + 1];
  const d0 = slopes[idx];
  const d1 = slopes[idx + 1];
  if (
    x0 === undefined ||
    x1 === undefined ||
    y0 === undefined ||
    y1 === undefined ||
    d0 === undefined ||
    d1 === undefined
  ) {
    return Number.NaN;
  }
  const h = x1 - x0;
  if (!isPositiveFinite(h)) {
    return y0;
  }
  const t = (xTarget - x0) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * y0 + h10 * h * d0 + h01 * y1 + h11 * h * d1;
}

/**
 * Construye una grilla uniforme de strikes con volatilidad implícita interpolada y
 * suavizada en varianza total w(k) = iv(k)^2 * T mediante spline cúbico monótono PCHIP
 * en log-moneyness k = ln(K / F).
 */
export function buildTotalVariancePchipGrid(params: {
  readonly uniqueNodes: readonly RiskNeutralInputNode[];
  readonly spot: number;
  readonly rate: number;
  readonly dividendYield: number;
  readonly timeToExpiry: number;
  readonly uniformGridSteps?: number;
}): readonly RiskNeutralInputNode[] {
  const { uniqueNodes, spot, rate, dividendYield, timeToExpiry } = params;
  const gridSteps = Math.max(
    MIN_Q_STRIKES,
    Math.floor(params.uniformGridSteps ?? DEFAULT_UNIFORM_Q_GRID_STEPS),
  );
  const m = uniqueNodes.length;
  if (
    m < MIN_Q_STRIKES ||
    !isPositiveFinite(spot) ||
    !Number.isFinite(rate) ||
    !Number.isFinite(dividendYield) ||
    !isPositiveFinite(timeToExpiry)
  ) {
    return [];
  }

  const forward = spot * Math.exp((rate - dividendYield) * timeToExpiry);
  if (!isPositiveFinite(forward)) {
    return [];
  }

  const ksLog: number[] = [];
  const rawTotalVar: number[] = [];
  for (const node of uniqueNodes) {
    const kLog = Math.log(node.strike / forward);
    const w = node.iv * node.iv * timeToExpiry;
    if (!Number.isFinite(kLog) || !isPositiveFinite(w)) {
      return [];
    }
    ksLog.push(kLog);
    rawTotalVar.push(w);
  }

  // Suavizado binomial de 3 puntos en varianza total interior para eliminar micro-serrucho
  const smoothedTotalVar: number[] = rawTotalVar.map((w, i) => {
    if (i === 0 || i === m - 1) {
      return w;
    }
    const wPrev = rawTotalVar[i - 1] ?? w;
    const wNext = rawTotalVar[i + 1] ?? w;
    return 0.25 * wPrev + 0.5 * w + 0.25 * wNext;
  });

  const slopes = computePchipSlopes(ksLog, smoothedTotalVar);
  if (slopes.length !== m) {
    return [];
  }

  const kMin = uniqueNodes[0]?.strike;
  const kMax = uniqueNodes[m - 1]?.strike;
  if (kMin === undefined || kMax === undefined || !(kMax > kMin)) {
    return [];
  }

  const stepK = (kMax - kMin) / (gridSteps - 1);
  const uniformGrid: RiskNeutralInputNode[] = [];
  for (let j = 0; j < gridSteps; j += 1) {
    const strike = j === gridSteps - 1 ? kMax : kMin + j * stepK;
    const kTarget = Math.log(strike / forward);
    const wInterp = evaluatePchipAt(ksLog, smoothedTotalVar, slopes, kTarget);
    const wClamped = Math.max(MIN_TOTAL_VARIANCE_FLOOR, wInterp);
    const iv = Math.sqrt(wClamped / timeToExpiry);
    if (!isPositiveFinite(strike) || !isPositiveFinite(iv)) {
      return [];
    }
    uniformGrid.push({ strike, iv });
  }

  return uniformGrid;
}

/**
 * Extrae la distribución neutral al riesgo (ℚ) usando la identidad de Breeden-Litzenberger (1978)
 * evaluada por diferencias finitas sobre una grilla ordenada de strikes e IVs suavizadas.
 */
export function extractRiskNeutralDistributionQ(
  input: RiskNeutralDistributionInput,
): RiskNeutralDistributionResult {
  const { spot, rate, dividendYield, timeToExpiry, nodes } = input;
  if (
    !isPositiveFinite(spot) ||
    !Number.isFinite(rate) ||
    !Number.isFinite(dividendYield) ||
    !isPositiveFinite(timeToExpiry) ||
    !isRuntimeArray(nodes)
  ) {
    return NO_DATA_Q_RESULT;
  }

  const usePchip = input.smoothTotalVariancePchip === true;
  const requireBid = input.requirePositiveBid ?? usePchip;

  const cleanSorted = nodes
    .filter((n) => {
      if (!isPositiveFinite(n.strike) || !isPositiveFinite(n.iv)) {
        return false;
      }
      if (requireBid && n.bid !== undefined) {
        return n.bid !== null && isPositiveFinite(n.bid);
      }
      return true;
    })
    .slice()
    .sort((a, b) => a.strike - b.strike);

  const uniqueRawNodes: RiskNeutralInputNode[] = [];
  for (const node of cleanSorted) {
    const prev = uniqueRawNodes[uniqueRawNodes.length - 1];
    if (prev === undefined || node.strike - prev.strike > STRIKE_DEDUP_TOLERANCE) {
      uniqueRawNodes.push(node);
    }
  }

  if (uniqueRawNodes.length < MIN_Q_STRIKES) {
    return NO_DATA_Q_RESULT;
  }

  const uniqueNodes: readonly RiskNeutralInputNode[] = usePchip
    ? buildTotalVariancePchipGrid({
        uniqueNodes: uniqueRawNodes,
        spot,
        rate,
        dividendYield,
        timeToExpiry,
        ...(input.uniformGridSteps !== undefined
          ? { uniformGridSteps: input.uniformGridSteps }
          : {}),
      })
    : uniqueRawNodes;

  const m = uniqueNodes.length;
  if (m < MIN_Q_STRIKES) {
    return NO_DATA_Q_RESULT;
  }

  const pricedNodes: { readonly strike: number; readonly iv: number; readonly callPrice: number }[] = [];
  for (const node of uniqueNodes) {
    const callPrice = priceBsm({
      spot,
      strike: node.strike,
      timeToExpiry,
      rate,
      dividendYield,
      volatility: node.iv,
      contractType: 'call',
    });
    if (!Number.isFinite(callPrice)) {
      return NO_DATA_Q_RESULT;
    }
    pricedNodes.push({ strike: node.strike, iv: node.iv, callPrice });
  }

  const growthFactor = Math.exp(rate * timeToExpiry);
  if (!Number.isFinite(growthFactor) || growthFactor <= 0) {
    return NO_DATA_Q_RESULT;
  }

  const strikes: number[] = [];
  const rawDensities: number[] = [];
  const intermediate: {
    readonly strike: number;
    readonly iv: number;
    readonly callPrice: number;
    readonly dCdK: number;
    readonly d2CdK2: number;
    readonly probAboveQ: number;
    readonly rawDensityQ: number;
  }[] = [];

  for (let j = 0; j < m; j += 1) {
    const curr = pricedNodes[j];
    if (curr === undefined) {
      return NO_DATA_Q_RESULT;
    }

    let dCdK: number;
    if (j === 0) {
      const next = pricedNodes[1];
      if (next === undefined) {
        return NO_DATA_Q_RESULT;
      }
      dCdK = (next.callPrice - curr.callPrice) / (next.strike - curr.strike);
    } else if (j === m - 1) {
      const prev = pricedNodes[m - 2];
      if (prev === undefined) {
        return NO_DATA_Q_RESULT;
      }
      dCdK = (curr.callPrice - prev.callPrice) / (curr.strike - prev.strike);
    } else {
      const prev = pricedNodes[j - 1];
      const next = pricedNodes[j + 1];
      if (prev === undefined || next === undefined) {
        return NO_DATA_Q_RESULT;
      }
      dCdK = (next.callPrice - prev.callPrice) / (next.strike - prev.strike);
    }

    const d2CdK2 =
      j === 0
        ? secondDividedDiff(pricedNodes, 0, 1, 2)
        : j === m - 1
          ? secondDividedDiff(pricedNodes, m - 3, m - 2, m - 1)
          : secondDividedDiff(pricedNodes, j - 1, j, j + 1);

    if (!Number.isFinite(dCdK) || !Number.isFinite(d2CdK2)) {
      return NO_DATA_Q_RESULT;
    }

    const probAboveQ = clampUnit(-growthFactor * dCdK);
    const rawDensityQ = Math.max(0, growthFactor * d2CdK2);
    if (!Number.isFinite(probAboveQ) || !Number.isFinite(rawDensityQ)) {
      return NO_DATA_Q_RESULT;
    }

    strikes.push(curr.strike);
    rawDensities.push(rawDensityQ);
    intermediate.push({
      strike: curr.strike,
      iv: curr.iv,
      callPrice: curr.callPrice,
      dCdK,
      d2CdK2,
      probAboveQ,
      rawDensityQ,
    });
  }

  const rawArea = integrateTrapezoid(strikes, rawDensities);
  if (!Number.isFinite(rawArea) || rawArea <= 0) {
    return NO_DATA_Q_RESULT;
  }

  const normalizedDensities = rawDensities.map((d) => d / rawArea);
  const resultNodes: RiskNeutralNode[] = intermediate.map((node, idx) => ({
    ...node,
    densityQ: normalizedDensities[idx] ?? Number.NaN,
  }));

  const kF = strikes.map((k, idx) => k * (normalizedDensities[idx] ?? 0));
  const meanQ = integrateTrapezoid(strikes, kF);
  if (!Number.isFinite(meanQ)) {
    return NO_DATA_Q_RESULT;
  }

  const mom2Integrand = strikes.map(
    (k, idx) => Math.pow(k - meanQ, 2) * (normalizedDensities[idx] ?? 0),
  );
  const varianceQ = integrateTrapezoid(strikes, mom2Integrand);
  const stdDevQ = varianceQ >= 0 ? Math.sqrt(varianceQ) : Number.NaN;

  let skewnessQ = Number.NaN;
  let excessKurtosisQ = Number.NaN;
  if (Number.isFinite(stdDevQ) && stdDevQ > 0) {
    const mom3Integrand = strikes.map(
      (k, idx) => Math.pow(k - meanQ, 3) * (normalizedDensities[idx] ?? 0),
    );
    const mom4Integrand = strikes.map(
      (k, idx) => Math.pow(k - meanQ, 4) * (normalizedDensities[idx] ?? 0),
    );
    const mu3 = integrateTrapezoid(strikes, mom3Integrand);
    const mu4 = integrateTrapezoid(strikes, mom4Integrand);
    skewnessQ = mu3 / Math.pow(stdDevQ, 3);
    excessKurtosisQ = mu4 / Math.pow(stdDevQ, 4) - 3;
  }

  return {
    status: 'OK',
    rawArea,
    normalizedArea: 1.0,
    meanQ,
    varianceQ,
    stdDevQ,
    skewnessQ,
    excessKurtosisQ,
    nodes: resultNodes,
  };
}

/**
 * Extrae la distribución neutral al riesgo (ℚ) de Breeden-Litzenberger suavizando previamente
 * la sonrisa de IV en varianza total w(k) = iv(k)^2 * T con spline cúbico monótono PCHIP
 * sobre strikes líquidos (bid > 0) y evaluando precios Call BSM sobre una grilla uniforme.
 */
export function extractSmoothedRiskNeutralDistributionQ(
  input: RiskNeutralDistributionInput,
): RiskNeutralDistributionResult {
  return extractRiskNeutralDistributionQ({
    ...input,
    smoothTotalVariancePchip: true,
    requirePositiveBid: input.requirePositiveBid ?? true,
  });
}

/**
 * Estima la distribución empírica histórica (ℙ) para retornos logarítmicos a horizonte H,
 * descompone la varianza diaria en Gap Overnight vs. Intradía RTH e identifica eventos de cola (> 3σ).
 */
export function analyzeEmpiricalDistributionP(
  bars: readonly DailyBarInput[],
  options: EmpiricalDistributionOptions,
): EmpiricalDistributionResult {
  const { asOfUtcSec, spot, horizonDays } = options;
  const dailyRf = options.dailyRiskFreeRate ?? 0;
  const minHistoryBars = options.minHistoryBars ?? DEFAULT_MIN_HISTORY_BARS;
  const tailSigmaThreshold = options.tailSigmaThreshold ?? DEFAULT_TAIL_SIGMA_THRESHOLD;

  if (
    !isRuntimeArray(bars) ||
    !Number.isInteger(asOfUtcSec) ||
    asOfUtcSec <= 0 ||
    asOfUtcSec > MAX_TIME_SECONDS ||
    !isPositiveFinite(spot) ||
    !Number.isInteger(horizonDays) ||
    horizonDays < 1 ||
    !Number.isFinite(dailyRf) ||
    !Number.isInteger(minHistoryBars) ||
    minHistoryBars < MIN_Q_STRIKES ||
    !isPositiveFinite(tailSigmaThreshold)
  ) {
    return NO_DATA_P_RESULT;
  }

  const validSorted = bars
    .filter(
      (b) =>
        Number.isInteger(b.time) &&
        b.time > 0 &&
        b.time <= asOfUtcSec &&
        b.time <= MAX_TIME_SECONDS &&
        isPositiveFinite(b.open) &&
        isPositiveFinite(b.close),
    )
    .slice()
    .sort((a, b) => a.time - b.time);

  const uniqueBars: DailyBarInput[] = [];
  for (const bar of validSorted) {
    const prev = uniqueBars[uniqueBars.length - 1];
    if (prev === undefined || bar.time !== prev.time) {
      uniqueBars.push(bar);
    }
  }

  const n = uniqueBars.length;
  if (n < minHistoryBars || n < 3 || n - horizonDays < 2) {
    return NO_DATA_P_RESULT;
  }

  const horizonLogReturns: number[] = [];
  const projectedTerminalPrices: number[] = [];
  const horizonCarry = horizonDays * dailyRf;
  for (let i = 0; i < n - horizonDays; i += 1) {
    const startBar = uniqueBars[i];
    const endBar = uniqueBars[i + horizonDays];
    if (startBar === undefined || endBar === undefined) {
      return NO_DATA_P_RESULT;
    }
    const rH = Math.log(endBar.close / startBar.close) - horizonCarry;
    if (!Number.isFinite(rH)) {
      return NO_DATA_P_RESULT;
    }
    horizonLogReturns.push(rH);
    projectedTerminalPrices.push(spot * Math.exp(rH));
  }

  const horizonStats = computeMeanAndSampleVariance(horizonLogReturns);
  const stdDevLogReturn =
    horizonStats.sampleVariance >= 0 ? Math.sqrt(horizonStats.sampleVariance) : Number.NaN;
  const skewness =
    Number.isFinite(horizonStats.m2) && horizonStats.m2 > 0
      ? horizonStats.m3 / Math.pow(horizonStats.m2, 1.5)
      : Number.NaN;
  const excessKurtosis =
    Number.isFinite(horizonStats.m2) && horizonStats.m2 > 0
      ? horizonStats.m4 / (horizonStats.m2 * horizonStats.m2) - 3
      : Number.NaN;

  const overnightReturns: number[] = [];
  const rthReturns: number[] = [];
  const totalDailyReturns: number[] = [];
  const sessionTimes: number[] = [];

  for (let t = 1; t < n; t += 1) {
    const prevBar = uniqueBars[t - 1];
    const currBar = uniqueBars[t];
    if (prevBar === undefined || currBar === undefined) {
      return NO_DATA_P_RESULT;
    }
    const rOn = Math.log(currBar.open / prevBar.close) - dailyRf;
    const rRth = Math.log(currBar.close / currBar.open);
    const rTot = rOn + rRth;
    if (!Number.isFinite(rOn) || !Number.isFinite(rRth) || !Number.isFinite(rTot)) {
      return NO_DATA_P_RESULT;
    }
    overnightReturns.push(rOn);
    rthReturns.push(rRth);
    totalDailyReturns.push(rTot);
    sessionTimes.push(currBar.time);
  }

  const onStats = computeMeanAndSampleVariance(overnightReturns);
  const rthStats = computeMeanAndSampleVariance(rthReturns);
  const totStats = computeMeanAndSampleVariance(totalDailyReturns);

  const varianceSum = onStats.sampleVariance + rthStats.sampleVariance;
  const overnightVarianceShare =
    Number.isFinite(varianceSum) && varianceSum > 0
      ? onStats.sampleVariance / varianceSum
      : Number.NaN;
  const rthVarianceShare =
    Number.isFinite(varianceSum) && varianceSum > 0
      ? rthStats.sampleVariance / varianceSum
      : Number.NaN;

  const totStdDev =
    totStats.sampleVariance >= 0 ? Math.sqrt(totStats.sampleVariance) : Number.NaN;
  const tailEvents: EmpiricalTailEvent[] = [];
  const kSessions = totalDailyReturns.length;

  if (Number.isFinite(totStdDev) && totStdDev > 0) {
    for (let idx = 0; idx < kSessions; idx += 1) {
      const rTot = totalDailyReturns[idx];
      const rOn = overnightReturns[idx];
      const rRth = rthReturns[idx];
      const time = sessionTimes[idx];
      if (
        rTot === undefined ||
        rOn === undefined ||
        rRth === undefined ||
        time === undefined
      ) {
        continue;
      }
      const zScore = (rTot - totStats.mean) / totStdDev;
      if (Math.abs(zScore) > tailSigmaThreshold) {
        const absDenom = Math.abs(rOn) + Math.abs(rRth);
        const overnightShare = absDenom > 0 ? Math.abs(rOn) / absDenom : 0;
        tailEvents.push({
          time,
          totalReturn: rTot,
          zScore,
          overnightReturn: rOn,
          rthReturn: rRth,
          overnightShare,
        });
      }
    }
  }

  const tailEventsCount = tailEvents.length;
  const tailFrequencyPct = kSessions > 0 ? (tailEventsCount / kSessions) * 100 : Number.NaN;
  let overnightTailContributionShare = Number.NaN;
  if (tailEventsCount > 0) {
    let sumShare = 0;
    for (const ev of tailEvents) {
      sumShare += ev.overnightShare;
    }
    overnightTailContributionShare = sumShare / tailEventsCount;
  }

  return {
    status: 'OK',
    usedBarsCount: n,
    horizonSamplesCount: horizonLogReturns.length,
    meanLogReturn: horizonStats.mean,
    stdDevLogReturn,
    skewness,
    excessKurtosis,
    overnightVariance: onStats.sampleVariance,
    rthVariance: rthStats.sampleVariance,
    overnightVarianceShare,
    rthVarianceShare,
    tailEventsCount,
    tailFrequencyPct,
    overnightTailContributionShare,
    horizonLogReturns,
    projectedTerminalPrices,
    tailEvents,
  };
}

function interpolateProbAboveQ(
  nodes: readonly RiskNeutralNode[],
  targetPrice: number,
): number {
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (first === undefined || last === undefined) {
    return Number.NaN;
  }
  if (targetPrice < first.strike || targetPrice > last.strike) {
    return Number.NaN;
  }
  if (targetPrice === first.strike) {
    return first.probAboveQ;
  }
  if (targetPrice === last.strike) {
    return last.probAboveQ;
  }
  for (let i = 0; i < nodes.length - 1; i += 1) {
    const left = nodes[i];
    const right = nodes[i + 1];
    if (left === undefined || right === undefined) {
      return Number.NaN;
    }
    if (targetPrice >= left.strike && targetPrice <= right.strike) {
      const span = right.strike - left.strike;
      if (span <= 0) {
        return Number.NaN;
      }
      const w = (targetPrice - left.strike) / span;
      return (1 - w) * left.probAboveQ + w * right.probAboveQ;
    }
  }
  return Number.NaN;
}

/**
 * Compara la probabilidad histórica empírica (ℙ) frente a la probabilidad implícita neutral
 * al riesgo (ℚ) de alcanzar/superar cada nivel técnico objetivo.
 */
export function evaluatePqLevelDivergence(
  input: PqLevelDivergenceInput,
): PqLevelDivergenceResult {
  const { spot, qDistribution, pDistribution, targetLevels } = input;
  const minEdgeSpread = input.minEdgeSpread ?? DEFAULT_MIN_EDGE_SPREAD;

  if (
    !isPositiveFinite(spot) ||
    qDistribution.status !== 'OK' ||
    pDistribution.status !== 'OK' ||
    qDistribution.nodes.length < MIN_Q_STRIKES ||
    pDistribution.projectedTerminalPrices.length === 0 ||
    !isRuntimeArray(targetLevels) ||
    !isPositiveFinite(minEdgeSpread)
  ) {
    return NO_DATA_PQ_RESULT;
  }

  const terminalPrices = pDistribution.projectedTerminalPrices;
  const sampleCount = terminalPrices.length;

  const levels: PqLevelEvaluation[] = targetLevels.map((target) => {
    const direction: 'ABOVE' | 'BELOW' =
      target.direction ?? (target.price >= spot ? 'ABOVE' : 'BELOW');
    if (!isPositiveFinite(target.price)) {
      return {
        label: target.label,
        price: target.price,
        direction,
        probP: Number.NaN,
        probQ: Number.NaN,
        pqSpread: Number.NaN,
        pqRatio: Number.NaN,
        classification: 'NO_DATA',
      };
    }

    const probAboveQ = interpolateProbAboveQ(qDistribution.nodes, target.price);
    if (!Number.isFinite(probAboveQ)) {
      return {
        label: target.label,
        price: target.price,
        direction,
        probP: Number.NaN,
        probQ: Number.NaN,
        pqSpread: Number.NaN,
        pqRatio: Number.NaN,
        classification: 'NO_DATA',
      };
    }

    const probQ = direction === 'ABOVE' ? probAboveQ : clampUnit(1 - probAboveQ);
    let hits = 0;
    for (const sT of terminalPrices) {
      if (direction === 'ABOVE' ? sT >= target.price : sT <= target.price) {
        hits += 1;
      }
    }
    const probP = hits / sampleCount;
    const pqSpread = probP - probQ;
    const pqRatio = probQ > PROB_DIVISOR_EPS ? probP / probQ : Number.NaN;

    let classification: PqDivergenceClassification;
    if (pqSpread >= minEdgeSpread) {
      classification = 'POSITIVE_EV_LONG_CONVEXITY';
    } else if (pqSpread <= -minEdgeSpread) {
      classification = 'OVERPRICED_PREMIUM_SHORT_EDGE';
    } else {
      classification = 'FAIRLY_PRICED';
    }

    return {
      label: target.label,
      price: target.price,
      direction,
      probP,
      probQ,
      pqSpread,
      pqRatio,
      classification,
    };
  });

  return {
    status: 'OK',
    levels,
  };
}

/**
 * Calcula el cono de movimiento esperado lognormal (1σ y 2σ) para múltiples horizontes
 * en días junto con el IV Rank y el IV Percentile sobre el historial de volatilidad implícita.
 */
export function computeVolConeAndRank(
  input: VolConeAndRankInput,
): VolConeAndRankResult {
  const { spot, ivAtm, horizonsDays, ivHistory } = input;
  const minIvHistoryCount = input.minIvHistoryCount ?? DEFAULT_MIN_IV_HISTORY_COUNT;

  if (
    !isPositiveFinite(spot) ||
    !isPositiveFinite(ivAtm) ||
    !isRuntimeArray(horizonsDays) ||
    !isRuntimeArray(ivHistory) ||
    !Number.isInteger(minIvHistoryCount) ||
    minIvHistoryCount < 1
  ) {
    return NO_DATA_CONE_RESULT;
  }

  const validHorizons = horizonsDays.filter((d) => isPositiveFinite(d));
  if (validHorizons.length === 0) {
    return NO_DATA_CONE_RESULT;
  }

  const cones: VolConePoint[] = validHorizons.map((horizonDays) => {
    const sigmaTau = ivAtm * Math.sqrt(horizonDays / DAYS_PER_YEAR);
    return {
      horizonDays,
      sigmaMovePct: sigmaTau * 100,
      upper1Sigma: spot * Math.exp(sigmaTau),
      lower1Sigma: spot * Math.exp(-sigmaTau),
      upper2Sigma: spot * Math.exp(2 * sigmaTau),
      lower2Sigma: spot * Math.exp(-2 * sigmaTau),
    };
  });

  const validIvHistory = ivHistory.filter((v) => isPositiveFinite(v));
  let ivMin = Number.NaN;
  let ivMax = Number.NaN;
  let ivRank = Number.NaN;
  let ivPercentile = Number.NaN;

  if (validIvHistory.length >= minIvHistoryCount) {
    ivMin = Math.min(...validIvHistory);
    ivMax = Math.max(...validIvHistory);
    ivRank = ivMax > ivMin ? ((ivAtm - ivMin) / (ivMax - ivMin)) * 100 : Number.NaN;
    let leCount = 0;
    for (const v of validIvHistory) {
      if (v <= ivAtm) {
        leCount += 1;
      }
    }
    ivPercentile = (leCount / validIvHistory.length) * 100;
  }

  return {
    status: 'OK',
    ivAtm,
    ivMin,
    ivMax,
    ivRank,
    ivPercentile,
    cones,
  };
}
