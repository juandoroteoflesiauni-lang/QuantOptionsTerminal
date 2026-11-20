import { impliedDividendYieldFromForward } from './forward.js';
import { greeksBsm } from './blackScholes.js';
import { normCdf } from './math.js';
import type { OptionContractType } from './types.js';
import {
  evaluateSliceIv,
  validateSliceButterflyArbitrage,
  type VolSlice,
  type VolSurface,
} from './volSurface.js';

const DEFAULT_DELTA_TOLERANCE = 1e-12;
const DEFAULT_MAX_ITERATIONS = 100;
const SCAN_SUBSTEPS_PER_SEGMENT = 4;
const TIME_MATCH_TOLERANCE = 1e-12;

export type DeltaConvention = 'spotBsm' | 'forward' | 'discountedForward';

export interface VolMetricsOptions {
  readonly deltaConvention?: DeltaConvention;
  readonly spot?: number;
  readonly rate?: number;
  readonly dividendYield?: number;
  readonly tolerance?: number;
  readonly maxIterations?: number;
}

export interface DeltaStrikeSolution {
  readonly strike: number;
  readonly logMoneyness: number;
  readonly iv: number;
}

export interface VolSliceMetrics {
  readonly timeToExpiry: number;
  readonly expirySec: number;
  readonly forward: number;
  readonly ivAtm: number;
  readonly expectedMovePct: number;
  readonly delta25PutIv: number;
  readonly delta25CallIv: number;
  readonly delta25PutStrike: number;
  readonly delta25CallStrike: number;
  readonly riskReversal25: number;
  readonly butterfly25: number;
  readonly isButterflyArbitrageFree: boolean;
}

export interface VolTermPoint {
  readonly timeToExpiry: number;
  readonly expirySec: number;
  readonly ivAtm: number;
  readonly expectedMovePct: number;
}

export interface VolTermBuildOptions {
  readonly omitInvalid?: boolean;
}

export interface VolTermInterpolationOptions {
  readonly interpolateVariance?: boolean;
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isVolSurface(
  input: VolSurface | readonly VolSlice[] | readonly VolTermPoint[],
): input is VolSurface {
  return !Array.isArray(input) && 'slices' in input;
}

function isTermPointArray(
  input: readonly VolSlice[] | readonly VolTermPoint[],
): input is readonly VolTermPoint[] {
  if (input.length === 0) {
    return false;
  }
  const first = input[0];
  return first !== undefined && 'ivAtm' in first && !('nodes' in first);
}

function resolveOptionRate(slice: VolSlice, options?: VolMetricsOptions): number {
  if (options?.rate !== undefined) {
    return Number.isFinite(options.rate) ? options.rate : Number.NaN;
  }
  return Number.isFinite(slice.rate) ? slice.rate : Number.NaN;
}

function resolveOptionDividendYield(slice: VolSlice, options?: VolMetricsOptions): number {
  if (options?.dividendYield !== undefined) {
    return Number.isFinite(options.dividendYield) ? options.dividendYield : Number.NaN;
  }
  if (Number.isFinite(slice.dividendYield)) {
    return slice.dividendYield;
  }
  const spot =
    options?.spot !== undefined && isFinitePositive(options.spot)
      ? options.spot
      : slice.spot;
  const rate = resolveOptionRate(slice, options);
  if (isFinitePositive(spot) && Number.isFinite(rate)) {
    return impliedDividendYieldFromForward(
      spot,
      slice.forward,
      slice.timeToExpiry,
      rate,
    );
  }
  return Number.NaN;
}

function computeDeltaMultiplier(
  slice: VolSlice,
  convention: DeltaConvention,
  options?: VolMetricsOptions,
): number {
  if (convention === 'forward') {
    return 1;
  }
  if (convention === 'discountedForward') {
    const rate = resolveOptionRate(slice, options);
    return Number.isFinite(rate) ? Math.exp(-rate * slice.timeToExpiry) : Number.NaN;
  }
  const q = resolveOptionDividendYield(slice, options);
  return Number.isFinite(q) ? Math.exp(-q * slice.timeToExpiry) : Number.NaN;
}

function computeSliceDeltaAtK(
  slice: VolSlice,
  k: number,
  contractType: OptionContractType,
  multiplier: number,
): number {
  const iv = evaluateSliceIv(slice, k);
  if (!isFinitePositive(iv) || !isFinitePositive(slice.timeToExpiry)) {
    return Number.NaN;
  }
  const totalVol = iv * Math.sqrt(slice.timeToExpiry);
  if (!isFinitePositive(totalVol)) {
    return Number.NaN;
  }
  const d1 = (-k + 0.5 * totalVol * totalVol) / totalVol;
  if (!Number.isFinite(d1)) {
    return Number.NaN;
  }
  return contractType === 'call'
    ? multiplier * normCdf(d1)
    : -multiplier * normCdf(-d1);
}

function invalidDeltaSolution(): DeltaStrikeSolution {
  return {
    strike: Number.NaN,
    logMoneyness: Number.NaN,
    iv: Number.NaN,
  };
}

function brentRoot(
  fn: (x: number) => number,
  x1: number,
  x2: number,
  faInput: number,
  fbInput: number,
  tolerance: number,
  maxIterations: number,
): number {
  let a = x1;
  let b = x2;
  let c = x2;
  let fa = faInput;
  let fb = fbInput;
  let fc = fbInput;
  let d = b - a;
  let e = d;

  for (let iter = 0; iter < maxIterations; iter += 1) {
    if ((fb > 0 && fc > 0) || (fb < 0 && fc < 0)) {
      c = a;
      fc = fa;
      d = b - a;
      e = d;
    }

    if (Math.abs(fc) < Math.abs(fb)) {
      a = b;
      b = c;
      c = a;
      fa = fb;
      fb = fc;
      fc = fa;
    }

    const tol1 = 2 * Number.EPSILON * Math.abs(b) + 0.5 * tolerance;
    const xm = 0.5 * (c - b);

    if (Math.abs(xm) <= tol1 || Math.abs(fb) <= tolerance) {
      return b;
    }

    if (Math.abs(e) >= tol1 && Math.abs(fa) > Math.abs(fb)) {
      const s = fb / fa;
      let p: number;
      let q: number;
      if (a === c) {
        p = 2 * xm * s;
        q = 1 - s;
      } else {
        const qVal = fa / fc;
        const rVal = fb / fc;
        p = s * (2 * xm * qVal * (qVal - rVal) - (b - a) * (rVal - 1));
        q = (qVal - 1) * (rVal - 1) * (s - 1);
      }

      if (p > 0) {
        q = -q;
      }
      const absP = Math.abs(p);
      const minTerm = Math.min(3 * xm * q - Math.abs(tol1 * q), Math.abs(e * q));
      if (2 * absP < minTerm) {
        e = d;
        d = p / q;
      } else {
        d = xm;
        e = d;
      }
    } else {
      d = xm;
      e = d;
    }

    a = b;
    fa = fb;
    if (Math.abs(d) > tol1) {
      b += d;
    } else {
      b += xm >= 0 ? tol1 : -tol1;
    }
    fb = fn(b);
    if (!Number.isFinite(fb)) {
      return Number.NaN;
    }
  }

  return b;
}

/**
 * Computes at-the-money forward implied volatility IV(k = 0), corresponding to K = F.
 * Returns NaN if k = 0 lies outside [kMin, kMax] or the slice is invalid.
 */
export function computeIvAtm(slice: VolSlice): number {
  return evaluateSliceIv(slice, 0);
}

/**
 * Solves for strike K = F * exp(k) and smile implied volatility matching the
 * target BSM/forward delta on the fitted slice. Signed delta is required
 * (`0 < delta < 1` for calls, `-1 < delta < 0` for puts). Returns NaN fields
 * if the target delta falls outside the slice's support [kMin, kMax] or under
 * missing dividend/spot parameters in `spotBsm` convention.
 */
export function solveDeltaStrikeAndIv(
  slice: VolSlice,
  targetDelta: number,
  contractType: OptionContractType,
  options?: VolMetricsOptions,
): DeltaStrikeSolution {
  if (!slice.isValid || slice.nodes.length < 2 || !Number.isFinite(targetDelta)) {
    return invalidDeltaSolution();
  }

  const rawType: string = contractType;
  if (rawType !== 'call' && rawType !== 'put') {
    return invalidDeltaSolution();
  }

  if (contractType === 'call' && (targetDelta <= 0 || targetDelta >= 1)) {
    return invalidDeltaSolution();
  }
  if (contractType === 'put' && (targetDelta >= 0 || targetDelta <= -1)) {
    return invalidDeltaSolution();
  }

  const convention: DeltaConvention = options?.deltaConvention ?? 'spotBsm';
  const rawConv: string = convention;
  if (
    rawConv !== 'spotBsm' &&
    rawConv !== 'forward' &&
    rawConv !== 'discountedForward'
  ) {
    return invalidDeltaSolution();
  }

  const tolerance = options?.tolerance ?? DEFAULT_DELTA_TOLERANCE;
  const maxIterations = options?.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  if (
    !isFinitePositive(tolerance) ||
    !Number.isInteger(maxIterations) ||
    maxIterations < 1
  ) {
    return invalidDeltaSolution();
  }

  const multiplier = computeDeltaMultiplier(slice, convention, options);
  if (!isFinitePositive(multiplier)) {
    return invalidDeltaSolution();
  }

  const evalFn = (k: number): number =>
    computeSliceDeltaAtK(slice, k, contractType, multiplier) - targetDelta;

  const scanKs: number[] = [];
  for (let i = 0; i < slice.nodes.length - 1; i += 1) {
    const left = slice.nodes[i];
    const right = slice.nodes[i + 1];
    if (left === undefined || right === undefined) {
      continue;
    }
    const step = (right.k - left.k) / SCAN_SUBSTEPS_PER_SEGMENT;
    for (let s = 0; s < SCAN_SUBSTEPS_PER_SEGMENT; s += 1) {
      scanKs.push(left.k + s * step);
    }
  }
  const lastNode = slice.nodes[slice.nodes.length - 1];
  if (lastNode !== undefined) {
    scanKs.push(lastNode.k);
  }

  const candidateRoots: number[] = [];
  let prevK: number | undefined;
  let prevF = Number.NaN;

  for (const k of scanKs) {
    const f = evalFn(k);
    if (!Number.isFinite(f)) {
      prevK = undefined;
      prevF = Number.NaN;
      continue;
    }

    if (Math.abs(f) <= tolerance) {
      candidateRoots.push(k);
    } else if (prevK !== undefined && Number.isFinite(prevF) && prevF * f < 0) {
      const root = brentRoot(evalFn, prevK, k, prevF, f, tolerance, maxIterations);
      if (Number.isFinite(root)) {
        candidateRoots.push(root);
      }
    }

    prevK = k;
    prevF = f;
  }

  if (candidateRoots.length === 0) {
    return invalidDeltaSolution();
  }

  let bestK = Number.NaN;
  let bestAbs = Number.POSITIVE_INFINITY;
  for (const root of candidateRoots) {
    const absK = Math.abs(root);
    if (absK < bestAbs) {
      bestAbs = absK;
      bestK = root;
    }
  }

  if (!Number.isFinite(bestK)) {
    return invalidDeltaSolution();
  }

  const iv = evaluateSliceIv(slice, bestK);
  const strike = slice.forward * Math.exp(bestK);
  if (!isFinitePositive(iv) || !isFinitePositive(strike)) {
    return invalidDeltaSolution();
  }

  return {
    strike,
    logMoneyness: bestK,
    iv,
  };
}

/**
 * Computes headline single-expiry smile metrics: IV_ATM, expected 1-sigma move
 * fraction `IV_ATM * sqrt(T)`, 25-delta put/call IV and strikes,
 * `riskReversal25 = iv25Put - iv25Call`, and
 * `butterfly25 = 0.5 * (iv25Put + iv25Call) - ivAtm`.
 */
export function computeSliceVolMetrics(
  slice: VolSlice,
  options?: VolMetricsOptions,
): VolSliceMetrics {
  const ivAtm = computeIvAtm(slice);
  const expectedMovePct =
    isFinitePositive(ivAtm) && isFinitePositive(slice.timeToExpiry)
      ? ivAtm * Math.sqrt(slice.timeToExpiry)
      : Number.NaN;

  const put25 = solveDeltaStrikeAndIv(slice, -0.25, 'put', options);
  const call25 = solveDeltaStrikeAndIv(slice, 0.25, 'call', options);

  const riskReversal25 =
    isFinitePositive(put25.iv) && isFinitePositive(call25.iv)
      ? put25.iv - call25.iv
      : Number.NaN;

  const butterfly25 =
    isFinitePositive(put25.iv) &&
    isFinitePositive(call25.iv) &&
    isFinitePositive(ivAtm)
      ? 0.5 * (put25.iv + call25.iv) - ivAtm
      : Number.NaN;

  const isButterflyArbitrageFree = slice.isValid
    ? validateSliceButterflyArbitrage(slice).isArbitrageFree
    : false;

  return {
    timeToExpiry: slice.timeToExpiry,
    expirySec: slice.expirySec,
    forward: slice.forward,
    ivAtm,
    expectedMovePct,
    delta25PutIv: put25.iv,
    delta25CallIv: call25.iv,
    delta25PutStrike: put25.strike,
    delta25CallStrike: call25.strike,
    riskReversal25,
    butterfly25,
    isButterflyArbitrageFree,
  };
}

/**
 * Extracts and sorts the ATM volatility term structure across expiries.
 * By default retains invalid/illiquid expiries with NaN metrics so term queries
 * do not silently bridge across missing dates unless `omitInvalid: true` is set.
 */
export function buildVolTermStructure(
  surfaceOrSlices: VolSurface | readonly VolSlice[],
  options?: VolTermBuildOptions,
): readonly VolTermPoint[] {
  const rawSlices = isVolSurface(surfaceOrSlices)
    ? surfaceOrSlices.slices
    : surfaceOrSlices;
  const omitInvalid = options?.omitInvalid ?? false;

  const points: VolTermPoint[] = [];
  for (const slice of rawSlices) {
    if (!isFinitePositive(slice.timeToExpiry)) {
      continue;
    }
    const ivAtm = slice.isValid ? evaluateSliceIv(slice, 0) : Number.NaN;
    const expectedMovePct = isFinitePositive(ivAtm)
      ? ivAtm * Math.sqrt(slice.timeToExpiry)
      : Number.NaN;
    if (omitInvalid && !isFinitePositive(ivAtm)) {
      continue;
    }
    points.push({
      timeToExpiry: slice.timeToExpiry,
      expirySec: slice.expirySec,
      ivAtm,
      expectedMovePct,
    });
  }

  return points.sort((a, b) => a.timeToExpiry - b.timeToExpiry);
}

function toOrderedTermPoints(
  termOrSurface: readonly VolTermPoint[] | readonly VolSlice[] | VolSurface,
): readonly VolTermPoint[] {
  if (isVolSurface(termOrSurface)) {
    return buildVolTermStructure(termOrSurface);
  }
  if (isTermPointArray(termOrSurface)) {
    return termOrSurface
      .filter((p) => isFinitePositive(p.timeToExpiry))
      .slice()
      .sort((a, b) => a.timeToExpiry - b.timeToExpiry);
  }
  return buildVolTermStructure(termOrSurface);
}

/**
 * Interpolates ATM implied volatility at target time `T` using either linear
 * total variance `w_atm(T) = sigma_atm^2 * T` (default) or linear IV.
 * Returns NaN outside [minT, maxT] or when bracketing expiries are NaN.
 */
export function interpolateTermIvAtm(
  termOrSurface: readonly VolTermPoint[] | readonly VolSlice[] | VolSurface,
  timeToExpiry: number,
  options?: VolTermInterpolationOptions,
): number {
  if (!isFinitePositive(timeToExpiry)) {
    return Number.NaN;
  }

  const points = toOrderedTermPoints(termOrSurface);
  if (points.length === 0) {
    return Number.NaN;
  }

  for (const pt of points) {
    if (Math.abs(pt.timeToExpiry - timeToExpiry) <= TIME_MATCH_TOLERANCE) {
      return isFinitePositive(pt.ivAtm) ? pt.ivAtm : Number.NaN;
    }
  }

  const interpolateVariance = options?.interpolateVariance ?? true;
  for (let i = 0; i < points.length - 1; i += 1) {
    const near = points[i];
    const far = points[i + 1];
    if (near === undefined || far === undefined) {
      continue;
    }
    if (near.timeToExpiry < timeToExpiry && timeToExpiry < far.timeToExpiry) {
      if (!isFinitePositive(near.ivAtm) || !isFinitePositive(far.ivAtm)) {
        return Number.NaN;
      }
      const alpha =
        (timeToExpiry - near.timeToExpiry) / (far.timeToExpiry - near.timeToExpiry);
      if (!interpolateVariance) {
        return (1 - alpha) * near.ivAtm + alpha * far.ivAtm;
      }
      const wNear = near.ivAtm * near.ivAtm * near.timeToExpiry;
      const wFar = far.ivAtm * far.ivAtm * far.timeToExpiry;
      const w = (1 - alpha) * wNear + alpha * wFar;
      return isFinitePositive(w) ? Math.sqrt(w / timeToExpiry) : Number.NaN;
    }
  }

  return Number.NaN;
}

/**
 * Computes raw ATM IV term spread `ivAtm(t2) - ivAtm(t1)` for `t2 > t1`.
 * Returns NaN when `t2 <= t1` or either maturity lacks valid IV_ATM.
 */
export function termSpread(
  termOrSurface: readonly VolTermPoint[] | readonly VolSlice[] | VolSurface,
  t1: number,
  t2: number,
  options?: VolTermInterpolationOptions,
): number {
  if (!isFinitePositive(t1) || !isFinitePositive(t2) || t2 <= t1) {
    return Number.NaN;
  }
  const iv1 = interpolateTermIvAtm(termOrSurface, t1, options);
  const iv2 = interpolateTermIvAtm(termOrSurface, t2, options);
  if (!isFinitePositive(iv1) || !isFinitePositive(iv2)) {
    return Number.NaN;
  }
  return iv2 - iv1;
}

/**
 * Computes annualized ATM volatility term slope `(ivAtm(t2) - ivAtm(t1)) / (t2 - t1)`
 * for `t2 > t1`. Returns NaN when `t2 <= t1` or either maturity lacks valid IV_ATM.
 */
export function termSlope(
  termOrSurface: readonly VolTermPoint[] | readonly VolSlice[] | VolSurface,
  t1: number,
  t2: number,
  options?: VolTermInterpolationOptions,
): number {
  if (!isFinitePositive(t1) || !isFinitePositive(t2) || t2 <= t1) {
    return Number.NaN;
  }
  const spread = termSpread(termOrSurface, t1, t2, options);
  return Number.isFinite(spread) ? spread / (t2 - t1) : Number.NaN;
}

export interface SkewContractPointInput {
  readonly strike: number;
  readonly contractType: OptionContractType;
  /** IV en decimal (ej. 0.28 = 28%). Contratos con null/NaN/<=0 se excluyen. */
  readonly iv: number | null;
  /** Delta BSM firmada opcional (+0..+1 para calls, -1..0 para puts). Si falta, se calcula con greeksBsm. */
  readonly delta?: number | null;
}

export interface ActiveExpirySkewAndIvRegimeInput {
  readonly spot: number;
  readonly timeToExpiryYears: number;
  readonly rate: number;
  readonly dividendYield: number;
  readonly contracts: readonly SkewContractPointInput[];
  /** Serie histórica 1Y de IV (o proxy explícito) en decimal (ej. 0.25 = 25%). */
  readonly historicalIv1y?: readonly (number | null)[] | null;
  /** IV actual de referencia en decimal para IVR/IVP; si se omite usa ivAtm interpolada. */
  readonly currentIvOverride?: number | null;
  /** Mínimo de sesiones históricas válidas requeridas (default: 20). */
  readonly minHistorySessions?: number;
}

export interface ActiveExpirySkewAndIvRegimeResult {
  /** Volatilidades en puntos porcentuales (0–100+, ej. 24.5 = 24.5%), o null si no interpolable. */
  readonly iv25CallPct: number | null;
  readonly iv25PutPct: number | null;
  readonly ivAtmPct: number | null;
  /** RR_25 = IV_25P - IV_25C en puntos de volatilidad (ej. +3.2 pts). */
  readonly rr25Pts: number | null;
  /** BF_25 = 0.5 * (IV_25P + IV_25C) - IV_ATM en puntos de volatilidad. */
  readonly bf25Pts: number | null;
  /** IVR = ((IV - IV_min) / (IV_max - IV_min)) * 100; null si historial insuficiente o IV_max === IV_min. */
  readonly ivr: number | null;
  /** IVP = (% de sesiones con IV_t < IV_actual) * 100, null si historial insuficiente. */
  readonly ivp: number | null;
  readonly validHistorySessions: number;
}

interface SkewCurveNode {
  /** Delta firmada para la sonrisa 25Δ, o strike para la curva OTM/ATM. */
  readonly x: number;
  /** IV en puntos de volatilidad (iv decimal * 100). */
  readonly y: number;
}

function dedupeAverageDuplicateDeltas(nodes: readonly SkewCurveNode[]): readonly SkewCurveNode[] {
  const out: SkewCurveNode[] = [];
  let i = 0;
  while (i < nodes.length) {
    const current = nodes[i];
    if (current === undefined) {
      i += 1;
      continue;
    }
    let j = i + 1;
    let sumY = current.y;
    let count = 1;
    while (j < nodes.length) {
      const candidate = nodes[j];
      if (candidate === undefined || candidate.x !== current.x) {
        break;
      }
      sumY += candidate.y;
      count += 1;
      j += 1;
    }
    out.push({ x: current.x, y: sumY / count });
    i = j;
  }
  return out;
}

/**
 * Interpolación lineal con bracketing estricto (sin extrapolación) sobre nodos
 * ordenados por `x`: nodo exacto (`|x_i - x*| <= 1e-12`) o null fuera de rango.
 */
function interpolateBracketed(nodes: readonly SkewCurveNode[], target: number): number | null {
  if (nodes.length === 0 || !Number.isFinite(target)) {
    return null;
  }
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (first === undefined || last === undefined) {
    return null;
  }
  for (const node of nodes) {
    if (Math.abs(node.x - target) <= 1e-12) {
      return node.y;
    }
  }
  if (target < first.x || target > last.x) {
    return null;
  }
  for (let i = 0; i < nodes.length - 1; i += 1) {
    const lo = nodes[i];
    const hi = nodes[i + 1];
    if (lo === undefined || hi === undefined) {
      continue;
    }
    if (lo.x < target && target < hi.x) {
      return lo.y + ((hi.y - lo.y) * (target - lo.x)) / (hi.x - lo.x);
    }
  }
  return null;
}

function resolveSkewContractDelta(
  contract: SkewContractPointInput,
  iv: number,
  spot: number,
  timeToExpiryYears: number,
  rate: number,
  dividendYield: number,
): number {
  const provided = contract.delta;
  if (provided !== undefined && provided !== null && Number.isFinite(provided)) {
    const validCall = contract.contractType === 'call' && provided > 0 && provided < 1;
    const validPut = contract.contractType === 'put' && provided > -1 && provided < 0;
    if (validCall || validPut) {
      return provided;
    }
  }
  return greeksBsm({
    spot,
    strike: contract.strike,
    timeToExpiry: timeToExpiryYears,
    rate,
    dividendYield,
    volatility: iv,
    contractType: contract.contractType,
  }).delta;
}

/**
 * Métricas de régimen de skew del vencimiento activo:
 * - `IV_25C`, `IV_25P`, `IV_ATM` interpoladas linealmente por delta firmada / strike OTM,
 * - `RR_25 = IV_25P - IV_25C` (convención institucional put − call),
 * - `BF_25 = 0.5 * (IV_25P + IV_25C) - IV_ATM`,
 * - `IVR` e `IVP` sobre la serie histórica 1Y provista (o proxy explícito),
 * con degradación honesta a null sin extrapolar y sin inventar datos.
 */
export function computeActiveExpirySkewAndIvRegime(
  input: ActiveExpirySkewAndIvRegimeInput,
): ActiveExpirySkewAndIvRegimeResult {
  const validHistory = (input.historicalIv1y ?? []).filter(
    (v): v is number => v !== null && Number.isFinite(v) && v > 0,
  );
  const validHistorySessions = validHistory.length;

  const nullResult = (): ActiveExpirySkewAndIvRegimeResult => ({
    iv25CallPct: null,
    iv25PutPct: null,
    ivAtmPct: null,
    rr25Pts: null,
    bf25Pts: null,
    ivr: null,
    ivp: null,
    validHistorySessions,
  });

  if (!isFinitePositive(input.spot) || !isFinitePositive(input.timeToExpiryYears)) {
    return nullResult();
  }

  const callNodes: SkewCurveNode[] = [];
  const putNodes: SkewCurveNode[] = [];
  const perStrike = new Map<number, { call?: number; put?: number }>();

  for (const contract of input.contracts) {
    const rawType: string = contract.contractType;
    if (rawType !== 'call' && rawType !== 'put') {
      continue;
    }
    const iv = contract.iv;
    if (iv === null || !Number.isFinite(iv) || iv <= 0) {
      continue;
    }
    if (!Number.isFinite(contract.strike) || contract.strike <= 0) {
      continue;
    }
    const delta = resolveSkewContractDelta(
      contract,
      iv,
      input.spot,
      input.timeToExpiryYears,
      input.rate,
      input.dividendYield,
    );
    if (!Number.isFinite(delta)) {
      continue;
    }
    const ivPct = iv * 100;
    if (rawType === 'call') {
      callNodes.push({ x: delta, y: ivPct });
    } else {
      putNodes.push({ x: delta, y: ivPct });
    }
    const slot = perStrike.get(contract.strike) ?? {};
    if (rawType === 'call') {
      if (slot.call === undefined) {
        slot.call = ivPct;
      }
    } else if (slot.put === undefined) {
      slot.put = ivPct;
    }
    perStrike.set(contract.strike, slot);
  }

  callNodes.sort((a, b) => a.x - b.x);
  putNodes.sort((a, b) => a.x - b.x);
  const callByDelta = dedupeAverageDuplicateDeltas(callNodes);
  const putByDelta = dedupeAverageDuplicateDeltas(putNodes);

  const otmByStrike: SkewCurveNode[] = [];
  const atmTolerance = 1e-9 * input.spot;
  const sortedStrikes = Array.from(perStrike.keys()).sort((a, b) => a - b);
  for (const strike of sortedStrikes) {
    const slot = perStrike.get(strike);
    if (slot === undefined) {
      continue;
    }
    let chosen: number | undefined;
    if (Math.abs(strike - input.spot) <= atmTolerance) {
      chosen =
        slot.call !== undefined && slot.put !== undefined
          ? 0.5 * (slot.call + slot.put)
          : (slot.call ?? slot.put);
    } else if (strike < input.spot) {
      chosen = slot.put;
    } else {
      chosen = slot.call;
    }
    if (chosen !== undefined) {
      otmByStrike.push({ x: strike, y: chosen });
    }
  }

  const iv25CallPct = interpolateBracketed(callByDelta, 0.25);
  const iv25PutPct = interpolateBracketed(putByDelta, -0.25);
  const ivAtmPct = interpolateBracketed(otmByStrike, input.spot);

  const rr25Pts =
    iv25PutPct !== null && iv25CallPct !== null ? iv25PutPct - iv25CallPct : null;
  const bf25Pts =
    iv25PutPct !== null && iv25CallPct !== null && ivAtmPct !== null
      ? 0.5 * (iv25PutPct + iv25CallPct) - ivAtmPct
      : null;

  const currentIvDec =
    input.currentIvOverride !== null &&
    input.currentIvOverride !== undefined &&
    Number.isFinite(input.currentIvOverride) &&
    input.currentIvOverride > 0
      ? input.currentIvOverride
      : ivAtmPct !== null
        ? ivAtmPct / 100
        : null;

  const minSessions = input.minHistorySessions ?? 20;

  let ivr: number | null = null;
  let ivp: number | null = null;
  if (currentIvDec !== null && validHistorySessions > 0 && validHistorySessions >= minSessions) {
    let ivMin = Number.POSITIVE_INFINITY;
    let ivMax = Number.NEGATIVE_INFINITY;
    let below = 0;
    for (const v of validHistory) {
      if (v < ivMin) {
        ivMin = v;
      }
      if (v > ivMax) {
        ivMax = v;
      }
      if (v < currentIvDec) {
        below += 1;
      }
    }
    ivr = ivMax > ivMin ? ((currentIvDec - ivMin) / (ivMax - ivMin)) * 100 : null;
    ivp = (below / validHistorySessions) * 100;
  }

  return {
    iv25CallPct,
    iv25PutPct,
    ivAtmPct,
    rr25Pts,
    bf25Pts,
    ivr,
    ivp,
    validHistorySessions,
  };
}
