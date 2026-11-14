/**
 * Motor 3 — Densidad Probabilística Dual: Distribución Física P_USD/CER mediante
 * descomposición ADR USD + CCL real deflactado por CER y cópula t-Student bivariada
 * por pseudo-verosimilitud (con integración cuasi-determinista Halton), frente a
 * densidades neutrales al riesgo Q_BYMA y Q_OPRA vía SVI + Breeden-Litzenberger,
 * divergencia Kullback-Leibler y señales de dislocación de colas al 10 % (Sección 5.3).
 *
 * Funciones 100 % puras: cero red, cero E/S, cero UI y cero mutación de argumentos.
 */

import { priceBsm, SECONDS_PER_YEAR_365 } from '../options/blackScholes.js';
import { normCdf, normPdf } from '../options/math.js';
import {
  brentRoot,
  clamp,
  DAYS_PER_YEAR,
  formatIsoUtcFromSec,
  isPositiveFinite,
  isValidUtcSec,
  TRADING_DAYS_PER_YEAR,
} from './types.js';

export type TailDislocationSignal =
  | 'SELL_LEFT_TAIL_BYMA'
  | 'BUY_RIGHT_TAIL_BYMA'
  | 'OPRA_TAIL_RICH'
  | 'ALIGNED'
  | 'NO_DATA';

export interface HistoricalDualObservation {
  readonly time: number;
  readonly adrCloseUsd: number;
  readonly cclGgal: number;
  readonly cerIndex: number;
}

export interface SviParams {
  readonly a: number;
  readonly b: number;
  readonly rho: number;
  readonly m: number;
  readonly sigma: number;
}

export interface OptionSliceIvNode {
  readonly strike: number;
  readonly ivDecimal: number;
}

export interface SviMarketSetup {
  readonly forwardPrice: number;
  readonly timeToExpiryYears: number;
  readonly riskFreeContinuous: number;
  readonly timeToSettleYears: number;
  readonly nodes?: readonly OptionSliceIvNode[];
  readonly sviOverride?: SviParams;
}

export interface DualProbabilityInput {
  readonly asOfUtcSec: number;
  readonly expiryDate: string;
  readonly dteCalendar: number;
  readonly spotByma24hArs: number;
  readonly spotAdrUsd: number;
  /** Factor de crecimiento acumulado esperado del CER al vencimiento (p. ej. 0.03 = +3 % hasta T). */
  readonly expectedCerGrowthOverHorizon: number;
  readonly historicalSeries: readonly HistoricalDualObservation[];
  readonly bymaMarket: SviMarketSetup;
  readonly opraMarket: SviMarketSetup;
  readonly copulaSampleCount?: number;
  readonly gridSize?: number;
  readonly minHistoricalObs?: number;
  readonly tailDislocationThreshold?: number;
}

export interface PhysicalTerminalNode {
  readonly spotUsd: number;
  readonly spotArs: number;
  readonly probability: number;
}

export interface RiskNeutralDistributionMetrics {
  readonly status: 'OK' | 'NO_DATA';
  readonly svi: SviParams | null;
  readonly minButterflyG: number;
  readonly impliedMean: number;
  readonly impliedVolPct: number;
  readonly impliedSkewness: number;
  readonly impliedExcessKurtosis: number;
  readonly leftTail10PctProbDiff: number;
  readonly rightTail10PctProbDiff: number;
  readonly klDivergencePvsQ: number;
}

export interface DualProbabilityOutput {
  readonly timestampUtc: string;
  readonly asOfUtcSec: number;
  readonly expiryDate: string;
  readonly dteCalendar: number;
  readonly physicalMetricsUsd: {
    readonly status: 'OK' | 'NO_DATA';
    readonly expectedReturnPct: number;
    readonly volatilityPct: number;
    readonly cvar95UsdPct: number;
    readonly studentTCopulaDof: number;
    readonly studentTCopulaRho: number;
  };
  readonly riskNeutralBymaArs: {
    readonly impliedMeanArs: number;
    readonly impliedVolPct: number;
    readonly impliedSkewness: number;
    readonly impliedExcessKurtosis: number;
    readonly leftTail10PctProbDiff: number;
    readonly rightTail10PctProbDiff: number;
    readonly klDivergencePvsQ: number;
    readonly svi: SviParams | null;
  };
  readonly riskNeutralOpraUsd: {
    readonly impliedMeanUsd: number;
    readonly impliedVolPct: number;
    readonly impliedSkewness: number;
    readonly impliedExcessKurtosis: number;
    readonly leftTail10PctProbDiff: number;
    readonly rightTail10PctProbDiff: number;
    readonly klDivergencePvsQ: number;
    readonly svi: SviParams | null;
  };
  readonly tailDislocationSignal: TailDislocationSignal;
  /** Nodos de densidad física simulada (equi-ponderados) disponibles para el Motor 5. */
  readonly simulatedNodes: readonly PhysicalTerminalNode[];
}

const DEFAULT_COPULA_SAMPLES = 512;
const DEFAULT_GRID_SIZE = 123;
const DEFAULT_MIN_HIST_OBS = 30;
const DEFAULT_TAIL_THRESHOLD = 0.06;

const LANCZOS_G = 7;
const LANCZOS_COEFFS: readonly number[] = [
  0.99999999999980993,
  676.5203681218851,
  -1259.1392167224028,
  771.32342877765313,
  -176.61502916214059,
  12.507343278686905,
  -0.13857109526572012,
  9.9843695780195716e-6,
  1.5056327351493116e-7,
];

export function logGamma(z: number): number {
  if (!isPositiveFinite(z)) {
    return Number.NaN;
  }
  if (z < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  const zm1 = z - 1;
  let x = LANCZOS_COEFFS[0] ?? 1;
  for (let i = 1; i < LANCZOS_COEFFS.length; i += 1) {
    const c = LANCZOS_COEFFS[i];
    if (c !== undefined) {
      x += c / (zm1 + i);
    }
  }
  const t = zm1 + LANCZOS_G + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (zm1 + 0.5) * Math.log(t) - t + Math.log(x);
}

function betaContinuedFraction(x: number, a: number, b: number): number {
  const maxIter = 200;
  const eps = 3e-15;
  const fpMin = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < fpMin) {
    d = fpMin;
  }
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIter; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpMin) {
      d = fpMin;
    }
    c = 1 + aa / c;
    if (Math.abs(c) < fpMin) {
      c = fpMin;
    }
    d = 1 / d;
    h *= d * c;

    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpMin) {
      d = fpMin;
    }
    c = 1 + aa / c;
    if (Math.abs(c) < fpMin) {
      c = fpMin;
    }
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) <= eps) {
      return h;
    }
  }
  return h;
}

export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (!Number.isFinite(x) || x < 0 || x > 1 || !isPositiveFinite(a) || !isPositiveFinite(b)) {
    return Number.NaN;
  }
  if (x === 0) {
    return 0;
  }
  if (x === 1) {
    return 1;
  }
  const bt = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betaContinuedFraction(x, a, b)) / a;
  }
  return 1 - (bt * betaContinuedFraction(1 - x, b, a)) / b;
}

export function studentTCdf(x: number, dof: number): number {
  if (!Number.isFinite(x) || !isPositiveFinite(dof)) {
    return Number.NaN;
  }
  const t2 = x * x;
  const ib = regularizedIncompleteBeta(dof / (dof + t2), 0.5 * dof, 0.5);
  return x >= 0 ? 1 - 0.5 * ib : 0.5 * ib;
}

/** Inversa normal estándar (Acklam + 2 pasos Newton -> precisión ~1e-15). */
export function invNormCdf(p: number): number {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) {
    return Number.NaN;
  }
  const a1 = -3.969683028665376e1;
  const a2 = 2.209460984245205e2;
  const a3 = -2.759285104469687e2;
  const a4 = 1.38357751867269e2;
  const a5 = -3.066479806614716e1;
  const a6 = 2.506628277459239;

  const b1 = -5.447609879822406e1;
  const b2 = 1.615858368580409e2;
  const b3 = -1.556989798598866e2;
  const b4 = 6.680131188771972e1;
  const b5 = -1.328068155288572e1;

  const c1 = -7.784894002430293e-3;
  const c2 = -3.223964580411365e-1;
  const c3 = -2.400758277161838;
  const c4 = -2.549732539343734;
  const c5 = 4.374664141464968;
  const c6 = 2.938163982698783;

  const d1 = 7.784695709041462e-3;
  const d2 = 3.224671290700398e-1;
  const d3 = 2.445134137142996;
  const d4 = 3.754408661907416;

  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let z: number;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    z =
      (((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
      ((((d1 * q + d2) * q + d3) * q + d4) * q + 1);
  } else if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    z =
      ((((((a1 * r + a2) * r + a3) * r + a4) * r + a5) * r + a6) * q) /
      (((((b1 * r + b2) * r + b3) * r + b4) * r + b5) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    z =
      -(((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
      ((((d1 * q + d2) * q + d3) * q + d4) * q + 1);
  }

  for (let i = 0; i < 2; i += 1) {
    const pdf = normPdf(z);
    if (isPositiveFinite(pdf)) {
      z -= (normCdf(z) - p) / pdf;
    }
  }
  return z;
}

export function studentTInvCdf(u: number, dof: number): number {
  if (!Number.isFinite(u) || u <= 0 || u >= 1 || !isPositiveFinite(dof)) {
    return Number.NaN;
  }
  if (Math.abs(u - 0.5) <= 1e-15) {
    return 0;
  }
  const zGuess = invNormCdf(u);
  let lo = Math.min(zGuess - 1, -2);
  let hi = Math.max(zGuess + 1, 2);
  while (studentTCdf(lo, dof) > u && lo > -1e6) {
    lo *= 2;
  }
  while (studentTCdf(hi, dof) < u && hi < 1e6) {
    hi *= 2;
  }
  return brentRoot((x) => studentTCdf(x, dof) - u, lo, hi, 1e-12, 120);
}

export function regularizedGammaP(a: number, x: number): number {
  if (!isPositiveFinite(a) || !Number.isFinite(x) || x < 0) {
    return Number.NaN;
  }
  if (x === 0) {
    return 0;
  }
  const gln = logGamma(a);
  if (x < a + 1) {
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let n = 1; n <= 200; n += 1) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 3e-15) {
        return sum * Math.exp(-x + a * Math.log(x) - gln);
      }
    }
    return sum * Math.exp(-x + a * Math.log(x) - gln);
  }

  const fpMin = 1e-30;
  let b = x + 1 - a;
  let c = 1 / fpMin;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 200; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < fpMin) {
      d = fpMin;
    }
    c = b + an / c;
    if (Math.abs(c) < fpMin) {
      c = fpMin;
    }
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) <= 3e-15) {
      break;
    }
  }
  const q = Math.exp(-x + a * Math.log(x) - gln) * h;
  return clamp(1 - q, 0, 1);
}

export function chiSquareInvCdf(u: number, dof: number): number {
  if (!Number.isFinite(u) || u <= 0 || u >= 1 || !isPositiveFinite(dof)) {
    return Number.NaN;
  }
  const shape = 0.5 * dof;
  let hi = Math.max(dof * 2, 10);
  while (regularizedGammaP(shape, 0.5 * hi) < u && hi < 1e7) {
    hi *= 2;
  }
  return brentRoot((w) => regularizedGammaP(shape, 0.5 * w) - u, 1e-12, hi, 1e-12, 120);
}

function haltonValue(index: number, base: number): number {
  let result = 0;
  let f = 1 / base;
  let i = index;
  while (i > 0) {
    result += f * (i % base);
    i = Math.floor(i / base);
    f /= base;
  }
  return result;
}

function empiricalPseudoObservations(values: readonly number[]): number[] {
  const n = values.length;
  const indexed = values.map((val, idx) => ({ val, idx })).sort((a, b) => a.val - b.val);
  const ranks = new Array<number>(n).fill(0);
  let i = 0;
  while (i < n) {
    let j = i + 1;
    while (j < n && indexed[j]?.val === indexed[i]?.val) {
      j += 1;
    }
    const avgRank = 0.5 * (i + 1 + j);
    for (let k = i; k < j; k += 1) {
      const entry = indexed[k];
      if (entry !== undefined) {
        ranks[entry.idx] = avgRank / (n + 1);
      }
    }
    i = j;
  }
  return ranks;
}

function bivariateStudentTCopulaLogLik(
  z1: readonly number[],
  z2: readonly number[],
  rho: number,
  dof: number,
): number {
  const n = z1.length;
  if (n === 0 || Math.abs(rho) >= 0.9999) {
    return Number.NEGATIVE_INFINITY;
  }
  const oneMinusRho2 = 1 - rho * rho;
  const normConst =
    logGamma(0.5 * (dof + 2)) +
    logGamma(0.5 * dof) -
    2 * logGamma(0.5 * (dof + 1)) -
    0.5 * Math.log(oneMinusRho2);

  let sum = n * normConst;
  const coefJoint = -0.5 * (dof + 2);
  const coefMarg = 0.5 * (dof + 1);
  for (let i = 0; i < n; i += 1) {
    const a = z1[i] ?? 0;
    const b = z2[i] ?? 0;
    const q = (a * a + b * b - 2 * rho * a * b) / (dof * oneMinusRho2);
    sum +=
      coefJoint * Math.log(1 + q) +
      coefMarg * (Math.log(1 + (a * a) / dof) + Math.log(1 + (b * b) / dof));
  }
  return sum;
}

function fitBivariateStudentTCopulaPseudoMle(
  u1: readonly number[],
  u2: readonly number[],
): { readonly rhoHat: number; readonly dofHat: number } {
  const candidateDofs = [2.5, 3, 4, 5, 6, 8, 10, 14, 20, 30];
  const goldenRatio = (Math.sqrt(5) - 1) / 2;

  const evalForDof = (dof: number): { rho: number; ll: number; dof: number } => {
    const z1 = u1.map((u) => studentTInvCdf(u, dof));
    const z2 = u2.map((u) => studentTInvCdf(u, dof));

    let lo = -0.98;
    let hi = 0.98;
    let x1 = hi - goldenRatio * (hi - lo);
    let x2 = lo + goldenRatio * (hi - lo);
    let f1 = bivariateStudentTCopulaLogLik(z1, z2, x1, dof);
    let f2 = bivariateStudentTCopulaLogLik(z1, z2, x2, dof);
    for (let iter = 0; iter < 28; iter += 1) {
      if (f1 < f2) {
        lo = x1;
        x1 = x2;
        f1 = f2;
        x2 = lo + goldenRatio * (hi - lo);
        f2 = bivariateStudentTCopulaLogLik(z1, z2, x2, dof);
      } else {
        hi = x2;
        x2 = x1;
        f2 = f1;
        x1 = hi - goldenRatio * (hi - lo);
        f1 = bivariateStudentTCopulaLogLik(z1, z2, x1, dof);
      }
    }
    const rhoBest = 0.5 * (lo + hi);
    return { rho: rhoBest, ll: bivariateStudentTCopulaLogLik(z1, z2, rhoBest, dof), dof };
  };

  let bestIdx = 0;
  const evals = candidateDofs.map((d) => evalForDof(d));
  for (let i = 1; i < evals.length; i += 1) {
    const cur = evals[i];
    const best = evals[bestIdx];
    if (cur !== undefined && best !== undefined && cur.ll > best.ll) {
      bestIdx = i;
    }
  }

  let loDof = candidateDofs[Math.max(0, bestIdx - 1)] ?? 2.5;
  let hiDof = candidateDofs[Math.min(candidateDofs.length - 1, bestIdx + 1)] ?? 30;
  let d1 = hiDof - goldenRatio * (hiDof - loDof);
  let d2 = loDof + goldenRatio * (hiDof - loDof);
  let r1 = evalForDof(d1);
  let r2 = evalForDof(d2);
  for (let iter = 0; iter < 14; iter += 1) {
    if (r1.ll < r2.ll) {
      loDof = d1;
      d1 = d2;
      r1 = r2;
      d2 = loDof + goldenRatio * (hiDof - loDof);
      r2 = evalForDof(d2);
    } else {
      hiDof = d2;
      d2 = d1;
      r2 = r1;
      d1 = hiDof - goldenRatio * (hiDof - loDof);
      r1 = evalForDof(d1);
    }
  }
  const finalBest = r1.ll >= r2.ll ? r1 : r2;
  return { rhoHat: finalBest.rho, dofHat: finalBest.dof };
}

function empiricalQuantileLinear(sortedAsc: readonly number[], u: number): number {
  const n = sortedAsc.length;
  if (n === 0 || !Number.isFinite(u)) {
    return Number.NaN;
  }
  const clampedU = clamp(u, 0, 1);
  const pos = clampedU * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  const alpha = pos - lo;
  const vLo = sortedAsc[lo] ?? Number.NaN;
  const vHi = sortedAsc[hi] ?? Number.NaN;
  return vLo * (1 - alpha) + vHi * alpha;
}

export function evaluateSviTotalVariance(k: number, svi: SviParams): number {
  const dy = k - svi.m;
  return svi.a + svi.b * (svi.rho * dy + Math.sqrt(dy * dy + svi.sigma * svi.sigma));
}

export function evaluateSviButterflyG(k: number, svi: SviParams): number {
  const dy = k - svi.m;
  const r = Math.sqrt(dy * dy + svi.sigma * svi.sigma);
  const w = svi.a + svi.b * (svi.rho * dy + r);
  if (!isPositiveFinite(w) || !isPositiveFinite(r)) {
    return Number.NEGATIVE_INFINITY;
  }
  const wp = svi.b * (svi.rho + dy / r);
  const wpp = (svi.b * svi.sigma * svi.sigma) / (r * r * r);
  const term1 = 1 - (k * wp) / (2 * w);
  return term1 * term1 - 0.25 * wp * wp * (1 / w + 0.25) + 0.5 * wpp;
}

function solveLinear3x3(aIn: readonly (readonly number[])[], bIn: readonly number[]): number[] | null {
  const a = aIn.map((r) => r.slice());
  const b = bIn.slice();
  for (let col = 0; col < 3; col += 1) {
    let piv = col;
    let best = Math.abs(a[col]?.[col] ?? 0);
    for (let r = col + 1; r < 3; r += 1) {
      const cand = Math.abs(a[r]?.[col] ?? 0);
      if (cand > best) {
        best = cand;
        piv = r;
      }
    }
    if (best <= 1e-18) {
      return null;
    }
    if (piv !== col) {
      const tr = a[col];
      const pr = a[piv];
      if (tr === undefined || pr === undefined) {
        return null;
      }
      a[col] = pr;
      a[piv] = tr;
      const tb = b[col] ?? 0;
      b[col] = b[piv] ?? 0;
      b[piv] = tb;
    }
    const rowC = a[col];
    if (rowC === undefined) {
      return null;
    }
    const diag = rowC[col] ?? 0;
    for (let r = col + 1; r < 3; r += 1) {
      const target = a[r];
      if (target === undefined) {
        return null;
      }
      const f = (target[col] ?? 0) / diag;
      for (let c = col; c < 3; c += 1) {
        target[c] = (target[c] ?? 0) - f * (rowC[c] ?? 0);
      }
      b[r] = (b[r] ?? 0) - f * (b[col] ?? 0);
    }
  }
  const x = [0, 0, 0];
  for (let i = 2; i >= 0; i -= 1) {
    const rowI = a[i];
    if (rowI === undefined) {
      return null;
    }
    let rhs = b[i] ?? 0;
    for (let c = i + 1; c < 3; c += 1) {
      rhs -= (rowI[c] ?? 0) * (x[c] ?? 0);
    }
    const d = rowI[i] ?? 0;
    if (Math.abs(d) <= 1e-18) {
      return null;
    }
    x[i] = rhs / d;
  }
  return x;
}

function minSviButterflyOverRange(svi: SviParams, kMin: number, kMax: number): number {
  const steps = 65;
  let minG = Number.POSITIVE_INFINITY;
  for (let i = 0; i < steps; i += 1) {
    const k = kMin + (i / (steps - 1)) * (kMax - kMin);
    const g = evaluateSviButterflyG(k, svi);
    if (g < minG) {
      minG = g;
    }
  }
  return minG;
}

/**
 * Calibración cuasi-explícita (Zeliade) de SVI libre de arbitraje de mariposa (g(k) >= 0).
 */
export function calibrateSviQuasiExplicit(
  forwardPrice: number,
  timeToExpiryYears: number,
  nodes: readonly OptionSliceIvNode[],
): { readonly svi: SviParams | null; readonly rmse: number; readonly minButterflyG: number } {
  const clean = nodes
    .filter((n) => isPositiveFinite(n.strike) && isPositiveFinite(n.ivDecimal))
    .map((n) => ({ k: Math.log(n.strike / forwardPrice), w: n.ivDecimal * n.ivDecimal * timeToExpiryYears }))
    .sort((a, b) => a.k - b.k);

  if (clean.length < 5 || !isPositiveFinite(forwardPrice) || !isPositiveFinite(timeToExpiryYears)) {
    return { svi: null, rmse: Number.NaN, minButterflyG: Number.NaN };
  }

  const kFirst = clean[0]?.k ?? -0.2;
  const kLast = clean[clean.length - 1]?.k ?? 0.2;
  const kCheckMin = Math.min(-0.8, kFirst - 0.3);
  const kCheckMax = Math.max(0.8, kLast + 0.3);

  const tryFitAt = (
    m: number,
    sigma: number,
  ): { readonly svi: SviParams; readonly rmse: number; readonly minG: number } | null => {
    const mat = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const rhs = [0, 0, 0];
    for (const pt of clean) {
      const dy = pt.k - m;
      const root = Math.sqrt(dy * dy + sigma * sigma);
      const x = [1, dy, root];
      for (let i = 0; i < 3; i += 1) {
        rhs[i] = (rhs[i] ?? 0) + (x[i] ?? 0) * pt.w;
        const rowI = mat[i];
        if (rowI === undefined) {
          return null;
        }
        for (let j = 0; j < 3; j += 1) {
          rowI[j] = (rowI[j] ?? 0) + (x[i] ?? 0) * (x[j] ?? 0);
        }
      }
    }
    const sol = solveLinear3x3(mat, rhs);
    if (sol === null) {
      return null;
    }
    const a = sol[0] ?? 0;
    const d = sol[1] ?? 0;
    const b = sol[2] ?? 0;
    if (!Number.isFinite(a) || !isPositiveFinite(b) || Math.abs(d) >= b * 0.995) {
      return null;
    }
    const rho = d / b;
    if (b * (1 + Math.abs(rho)) >= 2) {
      return null;
    }
    const minW = a + b * sigma * Math.sqrt(Math.max(0, 1 - rho * rho));
    if (minW <= 1e-6) {
      return null;
    }
    const candidate: SviParams = { a, b, rho, m, sigma };
    const minG = minSviButterflyOverRange(candidate, kCheckMin, kCheckMax);
    if (minG < -1e-7) {
      return null;
    }

    let sse = 0;
    for (const pt of clean) {
      const err = evaluateSviTotalVariance(pt.k, candidate) - pt.w;
      sse += err * err;
    }
    return { svi: candidate, rmse: Math.sqrt(sse / clean.length), minG };
  };

  let best: { readonly svi: SviParams; readonly rmse: number; readonly minG: number } | null = null;
  const mCandidates = 13;
  const mMin = kFirst - 0.1;
  const mMax = kLast + 0.1;
  const sigmas = [0.04, 0.08, 0.12, 0.18, 0.28, 0.42, 0.65];

  for (let mi = 0; mi < mCandidates; mi += 1) {
    const m = mMin + (mi / (mCandidates - 1)) * (mMax - mMin);
    for (const s of sigmas) {
      const res = tryFitAt(m, s);
      if (res !== null && (best === null || res.rmse < best.rmse)) {
        best = res;
      }
    }
  }

  if (best === null) {
    return { svi: null, rmse: Number.NaN, minButterflyG: Number.NaN };
  }

  let stepM = 0.04;
  let stepS = 0.04;
  for (let pass = 0; pass < 3; pass += 1) {
    const centerM = best.svi.m;
    const centerS = best.svi.sigma;
    for (let dm = -2; dm <= 2; dm += 1) {
      for (let ds = -2; ds <= 2; ds += 1) {
        const s = Math.max(0.01, centerS + ds * stepS);
        const res = tryFitAt(centerM + dm * stepM, s);
        if (res !== null && res.rmse < best.rmse) {
          best = res;
        }
      }
    }
    stepM *= 0.35;
    stepS *= 0.35;
  }

  return { svi: best.svi, rmse: best.rmse, minButterflyG: best.minG };
}

function buildSviRiskNeutralCompare(
  setup: SviMarketSetup,
  simulatedSpots: readonly number[],
  gridSize: number,
  expectedSpotFallback: number,
): RiskNeutralDistributionMetrics {
  const empty: RiskNeutralDistributionMetrics = {
    status: 'NO_DATA',
    svi: null,
    minButterflyG: Number.NaN,
    impliedMean: Number.NaN,
    impliedVolPct: Number.NaN,
    impliedSkewness: Number.NaN,
    impliedExcessKurtosis: Number.NaN,
    leftTail10PctProbDiff: Number.NaN,
    rightTail10PctProbDiff: Number.NaN,
    klDivergencePvsQ: Number.NaN,
  };

  if (
    !isPositiveFinite(setup.forwardPrice) ||
    !isPositiveFinite(setup.timeToExpiryYears) ||
    !Number.isFinite(setup.riskFreeContinuous) ||
    !isPositiveFinite(setup.timeToSettleYears)
  ) {
    return empty;
  }

  let svi: SviParams | null = null;
  let minButterflyG = Number.NaN;
  if (setup.sviOverride !== undefined) {
    svi = setup.sviOverride;
    minButterflyG = minSviButterflyOverRange(svi, -1.0, 1.0);
  } else if (setup.nodes !== undefined && setup.nodes.length >= 5) {
    const fit = calibrateSviQuasiExplicit(
      setup.forwardPrice,
      setup.timeToExpiryYears,
      setup.nodes,
    );
    svi = fit.svi;
    minButterflyG = fit.minButterflyG;
  }

  if (svi === null || !Number.isFinite(minButterflyG) || minButterflyG < -1e-6) {
    return empty;
  }

  const wAtm = evaluateSviTotalVariance(0, svi);
  if (!isPositiveFinite(wAtm)) {
    return empty;
  }
  const atmSigmaSqrtT = Math.sqrt(wAtm);
  const kLow = Math.max(0.1 * setup.forwardPrice, setup.forwardPrice * Math.exp(-3.5 * atmSigmaSqrtT));
  const kHigh = setup.forwardPrice * Math.exp(3.5 * atmSigmaSqrtT);
  const nGrid = Math.max(25, gridSize);
  const dK = (kHigh - kLow) / (nGrid - 1);

  const rEff = setup.riskFreeContinuous * (setup.timeToSettleYears / setup.timeToExpiryYears);
  const spotEur = setup.forwardPrice * Math.exp(-rEff * setup.timeToExpiryYears);

  const callPrices: number[] = [];
  const strikes: number[] = [];
  for (let i = 0; i < nGrid; i += 1) {
    const K = kLow + i * dK;
    const logM = Math.log(K / setup.forwardPrice);
    const w = evaluateSviTotalVariance(logM, svi);
    if (!isPositiveFinite(w)) {
      return empty;
    }
    const sigma = Math.sqrt(w / setup.timeToExpiryYears);
    const cPrice = priceBsm({
      spot: spotEur,
      strike: K,
      timeToExpiry: setup.timeToExpiryYears,
      rate: rEff,
      dividendYield: 0,
      volatility: sigma,
      contractType: 'call',
    });
    if (!Number.isFinite(cPrice)) {
      return empty;
    }
    strikes.push(K);
    callPrices.push(cPrice);
  }

  const growth = Math.exp(setup.riskFreeContinuous * setup.timeToSettleYears);
  const interiorStrikes: number[] = [];
  const rawQMass: number[] = [];

  for (let j = 1; j < nGrid - 1; j += 1) {
    const cPrev = callPrices[j - 1] ?? 0;
    const cCur = callPrices[j] ?? 0;
    const cNext = callPrices[j + 1] ?? 0;
    const fQ = growth * ((cNext - 2 * cCur + cPrev) / (dK * dK));
    const clampedFQ = fQ > 0 ? fQ : 0;
    interiorStrikes.push(strikes[j] ?? 0);
    rawQMass.push(clampedFQ * dK);
  }

  const qSum = rawQMass.reduce((acc, v) => acc + v, 0);
  if (!isPositiveFinite(qSum)) {
    return empty;
  }
  const qProbs = rawQMass.map((v) => v / qSum);

  let impliedMean = 0;
  for (let i = 0; i < interiorStrikes.length; i += 1) {
    impliedMean += (interiorStrikes[i] ?? 0) * (qProbs[i] ?? 0);
  }

  // Varianza / momentos de retorno logarítmico implícito bajo Q (en torno a refSpot = expectedSpotFallback)
  const refSpot = isPositiveFinite(expectedSpotFallback) ? expectedSpotFallback : setup.forwardPrice;
  const logRetQ = interiorStrikes.map((k) => Math.log(k / refSpot));
  let meanLogQ = 0;
  for (let i = 0; i < logRetQ.length; i += 1) {
    meanLogQ += (logRetQ[i] ?? 0) * (qProbs[i] ?? 0);
  }
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (let i = 0; i < logRetQ.length; i += 1) {
    const p = qProbs[i] ?? 0;
    const d = (logRetQ[i] ?? 0) - meanLogQ;
    const d2 = d * d;
    m2 += p * d2;
    m3 += p * d2 * d;
    m4 += p * d2 * d2;
  }
  const stdLogQ = m2 > 0 ? Math.sqrt(m2) : Number.NaN;
  const impliedVolPct =
    isPositiveFinite(stdLogQ) ? (stdLogQ / Math.sqrt(setup.timeToExpiryYears)) * 100 : Number.NaN;
  const impliedSkewness = isPositiveFinite(stdLogQ) ? m3 / (stdLogQ * stdLogQ * stdLogQ) : Number.NaN;
  const impliedExcessKurtosis = isPositiveFinite(m2) ? m4 / (m2 * m2) - 3 : Number.NaN;

  // Empírica P sobre los mismos bins / KDE Gaussiano suave para KL(P || Q) y colas 10%
  if (simulatedSpots.length === 0) {
    return {
      ...empty,
      status: 'OK',
      svi,
      minButterflyG,
      impliedMean,
      impliedVolPct,
      impliedSkewness,
      impliedExcessKurtosis,
    };
  }

  const sortedP = simulatedSpots.slice().sort((a, b) => a - b);
  const k10P = empiricalQuantileLinear(sortedP, 0.1);
  const k90P = empiricalQuantileLinear(sortedP, 0.9);

  // CDF discreta acumulada de Q evaluada por interpolación lineal en [k_i]
  const qCdfValues: number[] = [];
  let accQ = 0;
  for (let i = 0; i < qProbs.length; i += 1) {
    accQ += qProbs[i] ?? 0;
    qCdfValues.push(accQ);
  }

  const evalCdfQ = (kVal: number): number => {
    const firstK = interiorStrikes[0] ?? kVal;
    const lastK = interiorStrikes[interiorStrikes.length - 1] ?? kVal;
    if (kVal <= firstK) {
      return 0;
    }
    if (kVal >= lastK) {
      return 1;
    }
    for (let i = 1; i < interiorStrikes.length; i += 1) {
      const kL = interiorStrikes[i - 1] ?? 0;
      const kR = interiorStrikes[i] ?? 0;
      if (kVal <= kR) {
        const cL = qCdfValues[i - 1] ?? 0;
        const cR = qCdfValues[i] ?? 0;
        const alpha = kR > kL ? (kVal - kL) / (kR - kL) : 0;
        return cL * (1 - alpha) + cR * alpha;
      }
    }
    return 1;
  };

  const fQAt10 = evalCdfQ(k10P);
  const fQAt90 = evalCdfQ(k90P);
  const leftTail10PctProbDiff = 0.1 - fQAt10; // < -0.06 => cola izquierda Q inflada vs P
  const rightTail10PctProbDiff = 0.1 - (1 - fQAt90); // = fQAt90 - 0.90; > +0.06 => P espera más cola derecha que Q

  // Densidad KDE Silverman de P proyectada sobre la misma grilla para D_KL(P || Q)
  const nP = sortedP.length;
  const meanP = sortedP.reduce((acc, v) => acc + v, 0) / nP;
  let varP = 0;
  for (const s of sortedP) {
    varP += (s - meanP) * (s - meanP);
  }
  const sdP = nP > 1 ? Math.sqrt(varP / (nP - 1)) : Number.NaN;
  const iqrP = empiricalQuantileLinear(sortedP, 0.75) - empiricalQuantileLinear(sortedP, 0.25);
  const scaleP = Math.min(
    isPositiveFinite(sdP) ? sdP : dK,
    isPositiveFinite(iqrP) ? iqrP / 1.34 : dK,
  );
  const bandwidth = Math.max(dK, 0.9 * scaleP * Math.pow(nP, -0.2));

  const rawPMass = interiorStrikes.map((kNode) => {
    let kde = 0;
    for (const s of sortedP) {
      kde += normPdf((kNode - s) / bandwidth);
    }
    return (kde / (nP * bandwidth)) * dK;
  });
  const pSum = rawPMass.reduce((acc, v) => acc + v, 0);

  let klDivergencePvsQ = Number.NaN;
  if (isPositiveFinite(pSum)) {
    const pProbs = rawPMass.map((v) => v / pSum);
    let kl = 0;
    for (let i = 0; i < pProbs.length; i += 1) {
      const p = pProbs[i] ?? 0;
      const q = qProbs[i] ?? 0;
      if (p > 1e-12 && q > 1e-12) {
        kl += p * Math.log(p / q);
      }
    }
    klDivergencePvsQ = kl;
  }

  return {
    status: 'OK',
    svi,
    minButterflyG,
    impliedMean,
    impliedVolPct,
    impliedSkewness,
    impliedExcessKurtosis,
    leftTail10PctProbDiff,
    rightTail10PctProbDiff,
    klDivergencePvsQ,
  };
}

/**
 * Evaluador principal del Motor 3: cópula física USD/CER vs. densidades SVI + Breeden-Litzenberger Q.
 */
export function evaluateDualProbabilityDensity(
  input: DualProbabilityInput,
): DualProbabilityOutput {
  if (!isValidUtcSec(input.asOfUtcSec)) {
    throw new Error(`asOfUtcSec must be valid integer UTC seconds (got ${String(input.asOfUtcSec)})`);
  }

  const invalidOut: DualProbabilityOutput = {
    timestampUtc: formatIsoUtcFromSec(input.asOfUtcSec),
    asOfUtcSec: input.asOfUtcSec,
    expiryDate: input.expiryDate,
    dteCalendar: input.dteCalendar,
    physicalMetricsUsd: {
      status: 'NO_DATA',
      expectedReturnPct: Number.NaN,
      volatilityPct: Number.NaN,
      cvar95UsdPct: Number.NaN,
      studentTCopulaDof: Number.NaN,
      studentTCopulaRho: Number.NaN,
    },
    riskNeutralBymaArs: {
      impliedMeanArs: Number.NaN,
      impliedVolPct: Number.NaN,
      impliedSkewness: Number.NaN,
      impliedExcessKurtosis: Number.NaN,
      leftTail10PctProbDiff: Number.NaN,
      rightTail10PctProbDiff: Number.NaN,
      klDivergencePvsQ: Number.NaN,
      svi: null,
    },
    riskNeutralOpraUsd: {
      impliedMeanUsd: Number.NaN,
      impliedVolPct: Number.NaN,
      impliedSkewness: Number.NaN,
      impliedExcessKurtosis: Number.NaN,
      leftTail10PctProbDiff: Number.NaN,
      rightTail10PctProbDiff: Number.NaN,
      klDivergencePvsQ: Number.NaN,
      svi: null,
    },
    tailDislocationSignal: 'NO_DATA',
    simulatedNodes: [],
  };

  if (
    !isPositiveFinite(input.dteCalendar) ||
    !isPositiveFinite(input.spotByma24hArs) ||
    !isPositiveFinite(input.spotAdrUsd) ||
    !Number.isFinite(input.expectedCerGrowthOverHorizon) ||
    1 + input.expectedCerGrowthOverHorizon <= 0
  ) {
    return invalidOut;
  }

  const causalHist = input.historicalSeries
    .filter(
      (r) =>
        isValidUtcSec(r.time) &&
        r.time <= input.asOfUtcSec &&
        isPositiveFinite(r.adrCloseUsd) &&
        isPositiveFinite(r.cclGgal) &&
        isPositiveFinite(r.cerIndex),
    )
    .slice()
    .sort((a, b) => a.time - b.time);

  const minObs = input.minHistoricalObs ?? DEFAULT_MIN_HIST_OBS;
  const rAdr1d: number[] = [];
  const rCclReal1d: number[] = [];
  for (let i = 1; i < causalHist.length; i += 1) {
    const prev = causalHist[i - 1];
    const cur = causalHist[i];
    if (prev === undefined || cur === undefined) {
      continue;
    }
    rAdr1d.push(Math.log(cur.adrCloseUsd / prev.adrCloseUsd));
    rCclReal1d.push(Math.log(cur.cclGgal / prev.cclGgal) - Math.log(cur.cerIndex / prev.cerIndex));
  }

  if (rAdr1d.length < minObs) {
    return invalidOut;
  }

  const uAdr = empiricalPseudoObservations(rAdr1d);
  const uCclReal = empiricalPseudoObservations(rCclReal1d);
  const { rhoHat, dofHat } = fitBivariateStudentTCopulaPseudoMle(uAdr, uCclReal);

  const sortedAdr = rAdr1d.slice().sort((a, b) => a - b);
  const sortedCclReal = rCclReal1d.slice().sort((a, b) => a - b);
  const meanAdr1d = rAdr1d.reduce((acc, v) => acc + v, 0) / rAdr1d.length;
  const meanCclReal1d = rCclReal1d.reduce((acc, v) => acc + v, 0) / rCclReal1d.length;

  const horizonTradingDays = Math.max(
    1,
    Math.round((input.dteCalendar * TRADING_DAYS_PER_YEAR) / DAYS_PER_YEAR),
  );
  const sqrtH = Math.sqrt(horizonTradingDays);
  const cerLogHorizon = Math.log(1 + input.expectedCerGrowthOverHorizon);
  const nSim = Math.max(64, input.copulaSampleCount ?? DEFAULT_COPULA_SAMPLES);

  const simulatedNodes: PhysicalTerminalNode[] = [];
  const spotsUsd: number[] = [];
  const spotsArs: number[] = [];
  const horizonAdrLogs: number[] = [];
  const simpleReturnsUsd: number[] = [];

  for (let idx = 1; idx <= nSim; idx += 1) {
    const h2 = haltonValue(idx, 2);
    const h3 = haltonValue(idx, 3);
    const h5 = haltonValue(idx, 5);
    const z1 = invNormCdf(h2);
    const z2 = invNormCdf(h3);
    const wChi = chiSquareInvCdf(h5, dofHat);
    const scaleT = Math.sqrt(dofHat / wChi);
    const y1 = z1 * scaleT;
    const y2 = (rhoHat * z1 + Math.sqrt(Math.max(0, 1 - rhoHat * rhoHat)) * z2) * scaleT;

    const u1 = clamp(studentTCdf(y1, dofHat), 1e-6, 1 - 1e-6);
    const u2 = clamp(studentTCdf(y2, dofHat), 1e-6, 1 - 1e-6);

    const drawAdr1d = empiricalQuantileLinear(sortedAdr, u1);
    const drawCclReal1d = empiricalQuantileLinear(sortedCclReal, u2);

    const hAdrLog = horizonTradingDays * meanAdr1d + sqrtH * (drawAdr1d - meanAdr1d);
    const hCclRealLog =
      horizonTradingDays * meanCclReal1d + sqrtH * (drawCclReal1d - meanCclReal1d);

    const spotUsdT = input.spotAdrUsd * Math.exp(hAdrLog);
    const spotArsT = input.spotByma24hArs * Math.exp(hAdrLog + hCclRealLog + cerLogHorizon);

    spotsUsd.push(spotUsdT);
    spotsArs.push(spotArsT);
    horizonAdrLogs.push(hAdrLog);
    simpleReturnsUsd.push(spotUsdT / input.spotAdrUsd - 1);
    simulatedNodes.push({
      spotUsd: spotUsdT,
      spotArs: spotArsT,
      probability: 1 / nSim,
    });
  }

  const expectedReturnPct =
    (simpleReturnsUsd.reduce((acc, v) => acc + v, 0) / nSim) * 100;
  const meanHAdr = horizonAdrLogs.reduce((acc, v) => acc + v, 0) / nSim;
  let varHAdr = 0;
  for (const r of horizonAdrLogs) {
    varHAdr += (r - meanHAdr) * (r - meanHAdr);
  }
  const tYears = input.dteCalendar / DAYS_PER_YEAR;
  const volatilityPct = Math.sqrt((varHAdr / Math.max(1, nSim - 1)) / tYears) * 100;

  const sortedSimpleUsd = simpleReturnsUsd.slice().sort((a, b) => a - b);
  const tailCount = Math.max(1, Math.floor(0.05 * nSim));
  let tailSum = 0;
  for (let i = 0; i < tailCount; i += 1) {
    tailSum += sortedSimpleUsd[i] ?? 0;
  }
  const cvar95UsdPct = (tailSum / tailCount) * 100;

  const gridSize = input.gridSize ?? DEFAULT_GRID_SIZE;
  const qByma = buildSviRiskNeutralCompare(
    input.bymaMarket,
    spotsArs,
    gridSize,
    input.spotByma24hArs,
  );
  const qOpra = buildSviRiskNeutralCompare(
    input.opraMarket,
    spotsUsd,
    gridSize,
    input.spotAdrUsd,
  );

  const threshold = input.tailDislocationThreshold ?? DEFAULT_TAIL_THRESHOLD;
  let tailDislocationSignal: TailDislocationSignal = 'ALIGNED';
  if (qByma.status === 'NO_DATA' && qOpra.status === 'NO_DATA') {
    tailDislocationSignal = 'NO_DATA';
  } else if (
    qByma.status === 'OK' &&
    Number.isFinite(qByma.leftTail10PctProbDiff) &&
    qByma.leftTail10PctProbDiff <= -threshold
  ) {
    tailDislocationSignal = 'SELL_LEFT_TAIL_BYMA';
  } else if (
    qByma.status === 'OK' &&
    Number.isFinite(qByma.rightTail10PctProbDiff) &&
    qByma.rightTail10PctProbDiff >= threshold
  ) {
    tailDislocationSignal = 'BUY_RIGHT_TAIL_BYMA';
  } else if (
    qOpra.status === 'OK' &&
    Number.isFinite(qOpra.leftTail10PctProbDiff) &&
    qOpra.leftTail10PctProbDiff <= -threshold
  ) {
    tailDislocationSignal = 'OPRA_TAIL_RICH';
  }

  return {
    timestampUtc: formatIsoUtcFromSec(input.asOfUtcSec),
    asOfUtcSec: input.asOfUtcSec,
    expiryDate: input.expiryDate,
    dteCalendar: input.dteCalendar,
    physicalMetricsUsd: {
      status: 'OK',
      expectedReturnPct,
      volatilityPct,
      cvar95UsdPct,
      studentTCopulaDof: dofHat,
      studentTCopulaRho: rhoHat,
    },
    riskNeutralBymaArs: {
      impliedMeanArs: qByma.impliedMean,
      impliedVolPct: qByma.impliedVolPct,
      impliedSkewness: qByma.impliedSkewness,
      impliedExcessKurtosis: qByma.impliedExcessKurtosis,
      leftTail10PctProbDiff: qByma.leftTail10PctProbDiff,
      rightTail10PctProbDiff: qByma.rightTail10PctProbDiff,
      klDivergencePvsQ: qByma.klDivergencePvsQ,
      svi: qByma.svi,
    },
    riskNeutralOpraUsd: {
      impliedMeanUsd: qOpra.impliedMean,
      impliedVolPct: qOpra.impliedVolPct,
      impliedSkewness: qOpra.impliedSkewness,
      impliedExcessKurtosis: qOpra.impliedExcessKurtosis,
      leftTail10PctProbDiff: qOpra.leftTail10PctProbDiff,
      rightTail10PctProbDiff: qOpra.rightTail10PctProbDiff,
      klDivergencePvsQ: qOpra.klDivergencePvsQ,
      svi: qOpra.svi,
    },
    tailDislocationSignal,
    simulatedNodes,
  };
}

export const DUAL_DENSITY_SECONDS_YEAR = SECONDS_PER_YEAR_365;
