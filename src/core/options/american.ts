import { greeksBsm, priceBsm } from './blackScholes.js';
import { normCdf } from './math.js';
import type { BsmInput, ImpliedVolSolverOptions, OptionGreeksResult } from './types.js';

/**
 * Default number of steps in the CRR binomial lattice when omitted by caller.
 */
export const DEFAULT_CRR_STEPS = 200;

/**
 * Hard upper bound on CRR binomial lattice steps to guarantee pure deterministic O(N^2) runtime.
 */
export const MAX_CRR_STEPS = 5000;

const GOLDEN_RATIO_CONJUGATE = 0.5 * (Math.sqrt(5) - 1);
const LOG_SQRT_2PI = 0.5 * Math.log(2 * Math.PI);
const MIN_GAMMA_EXP = -745;
const EXP_ZERO_THRESHOLD = -746;
const MAX_SAFE_EXP = 700;
const BVN_HIGH_RHO_THRESHOLD = 0.925;
const BVN_HIGH_RHO_SUBINTERVALS = 4;

const DEFAULT_IV_MIN_VOL = 1e-9;
const DEFAULT_IV_MAX_VOL = 100.0;
const DEFAULT_IV_TOLERANCE = 1e-11;
const DEFAULT_IV_MAX_ITERATIONS = 120;

const DEFAULT_FD_SPOT_REL_STEP = 1e-4;
const DEFAULT_FD_VOL_REL_STEP = 1e-4;
const DEFAULT_FD_TIME_STEP = 1e-4;
const DEFAULT_FD_RATE_STEP = 1e-4;

/**
 * 20-point Gauss-Legendre abscissas and weights on [-1, 1] (Genz 2004 TVPACK).
 */
const GL20_QUADRATURE: readonly (readonly [number, number])[] = [
  [-0.9931285991850949, 0.017614007139152118],
  [-0.9639719272779138, 0.04060142980038694],
  [-0.912234428251326, 0.06267204833410907],
  [-0.8391169718222188, 0.08327674157670475],
  [-0.7463319064601508, 0.10193011981724044],
  [-0.636053680726515, 0.11819453196151841],
  [-0.5108670019508271, 0.13168863844917664],
  [-0.37370608871541955, 0.14209610931838204],
  [-0.22778585114164507, 0.14917298647260374],
  [-0.07652652113349734, 0.15275338713072584],
  [0.07652652113349734, 0.15275338713072584],
  [0.22778585114164507, 0.14917298647260374],
  [0.37370608871541955, 0.14209610931838204],
  [0.5108670019508271, 0.13168863844917664],
  [0.636053680726515, 0.11819453196151841],
  [0.7463319064601508, 0.10193011981724044],
  [0.8391169718222188, 0.08327674157670475],
  [0.912234428251326, 0.06267204833410907],
  [0.9639719272779138, 0.04060142980038694],
  [0.9931285991850949, 0.017614007139152118],
];

const GL20_COUNT = GL20_QUADRATURE.length;
const GL20_XI = new Float64Array(GL20_QUADRATURE.map(([xi]) => xi));
const GL20_WI = new Float64Array(GL20_QUADRATURE.map(([, wi]) => wi));
const BS2002_RHO = Math.sqrt(GOLDEN_RATIO_CONJUGATE);
const BS2002_ASIN_RHO = Math.asin(BS2002_RHO);
const BS2002_SN = new Float64Array(
  GL20_QUADRATURE.map(([xi]) => Math.sin(0.5 * BS2002_ASIN_RHO * (xi + 1))),
);
const BS2002_DENOM = new Float64Array(
  Array.from(BS2002_SN, (sn) => 1 - sn * sn),
);

const NAN_GREEKS_RESULT: OptionGreeksResult = {
  price: Number.NaN,
  delta: Number.NaN,
  gamma: Number.NaN,
  theta: Number.NaN,
  thetaDaily: Number.NaN,
  vega: Number.NaN,
  vegaPer1Pct: Number.NaN,
  rho: Number.NaN,
  vanna: Number.NaN,
  charm: Number.NaN,
};

/**
 * Single discrete cash dividend scheduled before option expiration.
 */
export interface DiscreteCashDividend {
  /** Time from valuation to ex-dividend date in years (`0 < time <= timeToExpiry`). */
  readonly time: number;
  /** Cash dividend amount per share (`amount >= 0`). */
  readonly amount: number;
}

/**
 * Inputs for Cox-Ross-Rubinstein binomial valuation with continuous yield and discrete cash dividends.
 */
export interface CrrDiscreteAmericanInput extends BsmInput {
  /** Optional schedule of discrete cash dividends paid prior to or at expiration. */
  readonly discreteDividends?: readonly DiscreteCashDividend[];
  /** Number of tree time steps (`1 <= steps <= maxSteps`, defaults to `200`). */
  readonly steps?: number;
  /** Explicit upper cap for `steps` (`1 <= maxSteps <= 5000`, defaults to `5000`). */
  readonly maxSteps?: number;
}

/**
 * Options for finite-difference/analytical American option Greeks.
 */
export interface AmericanGreeksOptions {
  /** Relative spot step for Delta/Gamma/Vanna/Charm finite differences (default `1e-4`). */
  readonly spotRelStep?: number;
  /** Relative volatility step for Vega/Vanna finite differences (default `1e-4`). */
  readonly volRelStep?: number;
  /** Absolute time step in years for Theta/Charm finite differences (default `1e-4`, capped at `0.25 * T`). */
  readonly timeStep?: number;
  /** Absolute rate step for Rho finite differences (default `1e-4`). */
  readonly rateStep?: number;
}

/**
 * Inputs for implied volatility inversion under Bjerksund-Stensland (2002) or discrete CRR.
 */
export interface SolveImpliedVolAmericanInput
  extends Omit<BsmInput, 'volatility'>, ImpliedVolSolverOptions {
  /** Observed American option market price. */
  readonly marketPrice: number;
  /** Optional discrete cash dividends (switches pricing kernel to `priceAmericanCrrDiscrete`). */
  readonly discreteDividends?: readonly DiscreteCashDividend[];
  /** Optional CRR step count when discrete dividends or lattice pricing are requested. */
  readonly steps?: number;
  /** Optional CRR step ceiling when lattice pricing is requested. */
  readonly maxSteps?: number;
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isValidContractType(contractType: string): boolean {
  return contractType === 'call' || contractType === 'put';
}

function isValidBsmInput(input: BsmInput): boolean {
  return (
    isPositiveFinite(input.spot) &&
    isPositiveFinite(input.strike) &&
    isPositiveFinite(input.timeToExpiry) &&
    isPositiveFinite(input.volatility) &&
    Number.isFinite(input.rate) &&
    Number.isFinite(input.dividendYield) &&
    isValidContractType(input.contractType)
  );
}

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) {
    return Number.NaN;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

function logNormCdf(z: number): number {
  if (!Number.isFinite(z)) {
    return Number.NaN;
  }
  if (z > -30) {
    const cdf = normCdf(z);
    return cdf > 0 ? Math.log(cdf) : Number.NEGATIVE_INFINITY;
  }
  const invZ2 = 1 / (z * z);
  const series =
    1 - invZ2 * (1 - invZ2 * (3 - invZ2 * (15 - invZ2 * (105 - 945 * invZ2))));
  return -0.5 * z * z - LOG_SQRT_2PI - Math.log(-z) + Math.log(series);
}

function mulExpNormCdf(logCoeff: number, z: number): number {
  if (logCoeff === Number.NEGATIVE_INFINITY) {
    return 0;
  }
  if (z > -30 && logCoeff < MAX_SAFE_EXP) {
    const cdf = normCdf(z);
    return cdf === 0 ? 0 : Math.exp(logCoeff) * cdf;
  }
  const logCdf = logNormCdf(z);
  const total = logCoeff + logCdf;
  if (!Number.isFinite(total)) {
    return total < 0 ? 0 : Number.NaN;
  }
  if (total <= MIN_GAMMA_EXP) {
    return 0;
  }
  return Math.exp(total);
}

function mulExpBvn(logCoeff: number, a: number, b: number, rho: number): number {
  if (logCoeff === Number.NEGATIVE_INFINITY) {
    return 0;
  }
  if (
    logCoeff <= EXP_ZERO_THRESHOLD &&
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    Number.isFinite(rho) &&
    rho >= -1 &&
    rho <= 1
  ) {
    return 0;
  }
  const bvnVal = bivariateNormCdf(a, b, rho);
  if (!Number.isFinite(bvnVal)) {
    return Number.NaN;
  }
  if (logCoeff <= MAX_SAFE_EXP) {
    return bvnVal === 0 ? 0 : Math.exp(logCoeff) * bvnVal;
  }
  if (bvnVal > 0) {
    const total = logCoeff + Math.log(bvnVal);
    return total <= MIN_GAMMA_EXP ? 0 : Math.exp(total);
  }
  const upperBound = logCoeff + Math.min(logNormCdf(a), logNormCdf(b));
  if (upperBound < -50) {
    return 0;
  }
  return Math.exp(upperBound);
}

/**
 * Evaluates the standard bivariate normal cumulative distribution `P(X <= a, Y <= b)`
 * for correlation `rho in [-1, 1]` using 20-point Gauss-Legendre quadrature (Genz 2004).
 */
export function bivariateNormCdf(a: number, b: number, rho: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(rho)) {
    if (
      (a === Number.POSITIVE_INFINITY || a === Number.NEGATIVE_INFINITY) &&
      Number.isFinite(rho) &&
      rho >= -1 &&
      rho <= 1
    ) {
      if (a === Number.NEGATIVE_INFINITY || b === Number.NEGATIVE_INFINITY) {
        return 0;
      }
    } else {
      return Number.NaN;
    }
  }
  if (rho < -1 || rho > 1) {
    return Number.NaN;
  }
  if (a <= -39 || b <= -39) {
    return 0;
  }
  if (Math.abs(rho) < 1e-15) {
    return clampProbability(normCdf(a) * normCdf(b));
  }
  if (rho >= 1 - 1e-15) {
    return normCdf(Math.min(a, b));
  }
  if (rho <= -1 + 1e-15) {
    return clampProbability(normCdf(a) - normCdf(-b));
  }

  if (Math.abs(rho) < BVN_HIGH_RHO_THRESHOLD) {
    const h = -a;
    const k = -b;
    const hk = h * k;
    const hs = 0.5 * (h * h + k * k);
    let integral = 0;
    let asinRho: number;

    if (rho === BS2002_RHO || rho === -BS2002_RHO) {
      const signRho = rho > 0 ? 1 : -1;
      asinRho = signRho * BS2002_ASIN_RHO;
      const hkSigned = signRho * hk;
      for (let i = 0; i < GL20_COUNT; i += 1) {
        const sn = BS2002_SN[i];
        const denom = BS2002_DENOM[i];
        const wi = GL20_WI[i];
        if (sn === undefined || denom === undefined || wi === undefined) continue;
        const exponent = (sn * hkSigned - hs) / denom;
        if (exponent > MIN_GAMMA_EXP) {
          integral += wi * Math.exp(exponent);
        }
      }
    } else {
      asinRho = Math.asin(rho);
      const halfAsinRho = 0.5 * asinRho;
      for (let i = 0; i < GL20_COUNT; i += 1) {
        const xi = GL20_XI[i];
        const wi = GL20_WI[i];
        if (xi === undefined || wi === undefined) continue;
        const sn = Math.sin(halfAsinRho * (xi + 1));
        const denom = 1 - sn * sn;
        const exponent = (sn * hk - hs) / denom;
        if (exponent > MIN_GAMMA_EXP) {
          integral += wi * Math.exp(exponent);
        }
      }
    }

    return clampProbability((integral * asinRho) / (4 * Math.PI) + normCdf(a) * normCdf(b));
  }

  if (rho < 0) {
    return clampProbability(normCdf(a) - bivariateNormCdf(a, -b, -rho));
  }

  const thetaMax = Math.acos(rho);
  const subInterval = thetaMax / BVN_HIGH_RHO_SUBINTERVALS;
  const h = -a;
  const k = -b;
  const hk = h * k;
  const diffSq = (h - k) * (h - k);
  let integral = 0;

  for (let panel = 0; panel < BVN_HIGH_RHO_SUBINTERVALS; panel++) {
    const lo = panel * subInterval;
    const halfSub = 0.5 * subInterval;
    for (let i = 0; i < GL20_COUNT; i += 1) {
      const xi = GL20_XI[i];
      const wi = GL20_WI[i];
      if (xi === undefined || wi === undefined) continue;
      const theta = lo + halfSub * (xi + 1);
      const sn = Math.sin(theta);
      const snSq = sn * sn;
      if (snSq > 0) {
        const exponent = (-0.5 * (diffSq + 2 * hk * (1 - Math.cos(theta)))) / snSq;
        if (exponent > MIN_GAMMA_EXP) {
          integral += wi * Math.exp(exponent);
        }
      }
    }
  }

  return clampProbability(
    normCdf(Math.min(a, b)) - (integral * subInterval) / (4 * Math.PI),
  );
}

function isMertonZeroEarlyExercise(input: BsmInput): boolean {
  if (input.contractType === 'call') {
    return input.rate >= 0 && input.dividendYield <= 0;
  }
  return input.rate <= 0 && input.dividendYield >= 0;
}

function effectiveBoundarySpan(
  beta: number,
  strike: number,
  rate: number,
  dividendYield: number,
): number {
  if (rate <= dividendYield) {
    return strike / (beta - 1);
  }
  return (beta / (beta - 1) - rate / dividendYield) * strike;
}

function effectiveGrowthTerm(
  carry: number,
  sigma: number,
  sigmaSq: number,
  tau: number,
): number {
  const raw = carry * tau + 2 * sigma * Math.sqrt(tau);
  // Bjerksund-Stensland heuristic assumes monotonic boundary X(tau) >= B0;
  // when carry < 0 is steep relative to sigma^2, cap the quadratic at its vertex.
  if (carry < 0 && tau > sigmaSq / (carry * carry)) {
    return -sigmaSq / carry;
  }
  return raw;
}

function bjerksund2002CallCore(
  spot: number,
  strike: number,
  timeToExpiry: number,
  rate: number,
  dividendYield: number,
  sigma: number,
  europeanCall: number,
): number {
  if (rate < 0) {
    return Number.NaN;
  }
  const intrinsic = Math.max(0, spot - strike);
  if (dividendYield <= 0) {
    return Math.max(europeanCall, intrinsic);
  }

  const carry = rate - dividendYield;
  const sigmaSq = sigma * sigma;
  const x = carry / sigmaSq - 0.5;
  const discriminant = x * x + (2 * rate) / sigmaSq;
  if (!Number.isFinite(discriminant) || discriminant < 0) {
    return Number.NaN;
  }

  const sqrtDisc = Math.sqrt(discriminant);
  const beta =
    x <= 0 ? -x + sqrtDisc : (2 * rate) / sigmaSq / (x + sqrtDisc);
  if (!Number.isFinite(beta) || beta <= 1) {
    return Math.max(europeanCall, intrinsic);
  }

  const b0 = Math.max(strike, (rate / dividendYield) * strike);
  const span = effectiveBoundarySpan(beta, strike, rate, dividendYield);
  if (!Number.isFinite(span) || span <= 1e-12 * strike) {
    return Math.max(europeanCall, intrinsic);
  }

  const t1 = GOLDEN_RATIO_CONJUGATE * timeToExpiry;
  const remainingTau = timeToExpiry - t1;
  const denom = span * b0;
  const strikeSq = strike * strike;

  const h2 =
    (-effectiveGrowthTerm(carry, sigma, sigmaSq, timeToExpiry) * strikeSq) / denom;
  const h1 =
    (-effectiveGrowthTerm(carry, sigma, sigmaSq, remainingTau) * strikeSq) / denom;

  const x2 = b0 + span * -Math.expm1(h2);
  const x1 = b0 + span * -Math.expm1(h1);

  if (!Number.isFinite(x1) || !Number.isFinite(x2) || x1 <= 0 || x2 <= 0) {
    return Number.NaN;
  }
  if (spot >= x2) {
    return Math.max(europeanCall, spot - strike);
  }

  const sqrtT1 = sigma * Math.sqrt(t1);
  const sqrtT = sigma * Math.sqrt(timeToExpiry);
  const rho = Math.sqrt(t1 / timeToExpiry);

  const scaledPhi = (
    scale: number,
    logBase: number,
    gamma: number,
    boundaryH: number,
    barrierI: number,
  ): number => {
    const lambda =
      gamma === beta
        ? 0
        : -rate + gamma * carry + 0.5 * gamma * (gamma - 1) * sigmaSq;
    const kappa = (2 * carry) / sigmaSq + (2 * gamma - 1);
    const drift = carry + (gamma - 0.5) * sigmaSq;
    const d1 = -(Math.log(spot / boundaryH) + drift * t1) / sqrtT1;
    const d2 = d1 - (2 * Math.log(barrierI / spot)) / sqrtT1;
    const logPre = lambda * t1 + logBase;
    return (
      scale *
      (mulExpNormCdf(logPre, d1) -
        mulExpNormCdf(logPre + kappa * Math.log(barrierI / spot), d2))
    );
  };

  const logSpot = Math.log(spot);
  const logX2Spot = Math.log(x2 / spot);
  const logX1Spot = Math.log(x1 / spot);
  const logX1X2 = Math.log(x1 / x2);
  const logSpotX1 = Math.log(spot / x1);
  const logX2SqOverSpotX1 = Math.log((x2 * x2) / (spot * x1));
  const invSqrtT1 = 1 / sqrtT1;
  const invSqrtT = 1 / sqrtT;

  const preparePsi = (logBase: number, gamma: number) => {
    const lambda =
      gamma === beta
        ? 0
        : -rate + gamma * carry + 0.5 * gamma * (gamma - 1) * sigmaSq;
    const kappa = (2 * carry) / sigmaSq + (2 * gamma - 1);
    const drift = carry + (gamma - 0.5) * sigmaSq;

    const driftT1 = drift * t1;
    const driftT = drift * timeToExpiry;
    const e1 = (logSpotX1 + driftT1) * invSqrtT1;
    const e2 = (logX2SqOverSpotX1 + driftT1) * invSqrtT1;
    const e3 = (logSpotX1 - driftT1) * invSqrtT1;
    const e4 = (logX2SqOverSpotX1 - driftT1) * invSqrtT1;

    const logPre1 = lambda * timeToExpiry + logBase;
    const logPre2 = logPre1 + kappa * logX2Spot;
    const logPre3 = logPre1 + kappa * logX1Spot;
    const logPre4 = logPre1 + kappa * logX1X2;

    return (scale: number, boundaryH: number): number => {
      const f1 = (Math.log(spot / boundaryH) + driftT) * invSqrtT;
      const f2 = (Math.log((x2 * x2) / (spot * boundaryH)) + driftT) * invSqrtT;
      const f3 = (Math.log((x1 * x1) / (spot * boundaryH)) + driftT) * invSqrtT;
      const f4 = (Math.log((spot * x1 * x1) / (boundaryH * x2 * x2)) + driftT) * invSqrtT;

      const term1 = mulExpBvn(logPre1, -e1, -f1, rho);
      const term2 = mulExpBvn(logPre2, -e2, -f2, rho);
      const term3 = mulExpBvn(logPre3, -e3, -f3, -rho);
      const term4 = mulExpBvn(logPre4, -e4, -f4, -rho);
      return scale * (term1 - term2 - term3 + term4);
    };
  };

  const logSpotOverX2 = beta * Math.log(spot / x2);
  const logSpotOverX1 = beta * logSpotX1;
  const psiBeta = preparePsi(logSpotOverX1, beta);
  const psi1 = preparePsi(logSpot, 1);
  const psi0 = preparePsi(0, 0);

  const rawValue =
    (x2 - strike) * Math.exp(logSpotOverX2) -
    scaledPhi(x2 - strike, logSpotOverX2, beta, x2, x2) +
    scaledPhi(1, logSpot, 1, x2, x2) -
    scaledPhi(1, logSpot, 1, x1, x2) -
    scaledPhi(strike, 0, 0, x2, x2) +
    scaledPhi(strike, 0, 0, x1, x2) +
    scaledPhi(x1 - strike, logSpotOverX1, beta, x1, x2) -
    psiBeta(x1 - strike, x1) +
    psi1(1, x1) -
    psi1(1, strike) -
    psi0(strike, x1) +
    psi0(strike, strike);

  if (!Number.isFinite(rawValue)) {
    return Number.NaN;
  }
  return Math.max(rawValue, europeanCall, intrinsic);
}

/**
 * Pure Bjerksund-Stensland (2002) American option valuation with Put-Call transformation
 * `P(S, K, T, r, q) = C(K, S, T, q, r)` and exact European equivalence when early exercise
 * is suboptimal (`r >= 0, q <= 0` for calls; `r <= 0, q >= 0` for puts).
 *
 * Returns `Number.NaN` on invalid inputs or when the transformed domestic rate is negative
 * (`r < 0` for calls or `q < 0` for puts outside the Merton zero-early-exercise domain).
 */
export function priceAmericanBjerksund2002(input: BsmInput): number {
  if (!isValidBsmInput(input)) {
    return Number.NaN;
  }

  const europeanPrice = priceBsm(input);
  if (!Number.isFinite(europeanPrice)) {
    return Number.NaN;
  }
  if (isMertonZeroEarlyExercise(input)) {
    return europeanPrice;
  }

  if (input.contractType === 'call') {
    return bjerksund2002CallCore(
      input.spot,
      input.strike,
      input.timeToExpiry,
      input.rate,
      input.dividendYield,
      input.volatility,
      europeanPrice,
    );
  }

  // Dual Put-Call symmetry for American options: P(S, K, T, r, q) = C(K, S, T, q, r).
  return bjerksund2002CallCore(
    input.strike,
    input.spot,
    input.timeToExpiry,
    input.dividendYield,
    input.rate,
    input.volatility,
    europeanPrice,
  );
}

function computeSpotGammaFd(input: BsmInput, spotRelStep: number): {
  readonly price: number;
  readonly dS: number;
  readonly vUpS: number;
  readonly vDnS: number;
  readonly gamma: number;
} | null {
  const price = priceAmericanBjerksund2002(input);
  const dS = input.spot * spotRelStep;
  if (!Number.isFinite(price) || !isPositiveFinite(dS)) {
    return null;
  }
  const vUpS = priceAmericanBjerksund2002({ ...input, spot: input.spot + dS });
  const vDnS = priceAmericanBjerksund2002({ ...input, spot: input.spot - dS });
  return {
    price,
    dS,
    vUpS,
    vDnS,
    gamma: (vUpS - 2 * price + vDnS) / (dS * dS),
  };
}

/**
 * Computes American option spot Gamma using analytical BSM in the zero-early-exercise
 * Merton regime or central spot finite differences on `priceAmericanBjerksund2002`.
 */
export function gammaAmericanFiniteDiffOrAnalytical(
  input: BsmInput,
  options?: Pick<AmericanGreeksOptions, 'spotRelStep'>,
): number {
  if (!isValidBsmInput(input)) {
    return Number.NaN;
  }
  if (isMertonZeroEarlyExercise(input)) {
    return greeksBsm(input).gamma;
  }
  const spotRelStep = options?.spotRelStep ?? DEFAULT_FD_SPOT_REL_STEP;
  if (!isPositiveFinite(spotRelStep)) {
    return Number.NaN;
  }
  const res = computeSpotGammaFd(input, spotRelStep);
  return res !== null && Number.isFinite(res.gamma) ? res.gamma : Number.NaN;
}

/**
 * Computes price and 1st/2nd-order American option Greeks.
 *
 * Delegates to exact analytical `greeksBsm` when early exercise is strictly suboptimal
 * (`call` with `r >= 0 && q <= 0`, or `put` with `r <= 0 && q >= 0`), and uses central
 * finite differences on `priceAmericanBjerksund2002` otherwise.
 */
export function greeksAmericanFiniteDiffOrAnalytical(
  input: BsmInput,
  options?: AmericanGreeksOptions,
): OptionGreeksResult {
  if (!isValidBsmInput(input)) {
    return NAN_GREEKS_RESULT;
  }

  if (isMertonZeroEarlyExercise(input)) {
    return greeksBsm(input);
  }

  const spotRelStep = options?.spotRelStep ?? DEFAULT_FD_SPOT_REL_STEP;
  const volRelStep = options?.volRelStep ?? DEFAULT_FD_VOL_REL_STEP;
  const requestedTimeStep = options?.timeStep ?? DEFAULT_FD_TIME_STEP;
  const rateStep = options?.rateStep ?? DEFAULT_FD_RATE_STEP;

  if (
    !isPositiveFinite(spotRelStep) ||
    !isPositiveFinite(volRelStep) ||
    !isPositiveFinite(requestedTimeStep) ||
    !isPositiveFinite(rateStep)
  ) {
    return NAN_GREEKS_RESULT;
  }

  const dSig = Math.min(input.volatility * volRelStep, 0.25 * input.volatility);
  const dT = Math.min(requestedTimeStep, 0.25 * input.timeToExpiry);
  const dR = rateStep;

  const spotFd = computeSpotGammaFd(input, spotRelStep);
  if (spotFd === null || !isPositiveFinite(dSig) || !isPositiveFinite(dT)) {
    return NAN_GREEKS_RESULT;
  }
  const { price, dS, vUpS, vDnS, gamma } = spotFd;

  const evalAt = (
    spot: number,
    timeToExpiry: number,
    rate: number,
    volatility: number,
  ): number =>
    priceAmericanBjerksund2002({
      spot,
      strike: input.strike,
      timeToExpiry,
      rate,
      dividendYield: input.dividendYield,
      volatility,
      contractType: input.contractType,
    });

  const delta = (vUpS - vDnS) / (2 * dS);

  const vUpT = evalAt(input.spot, input.timeToExpiry + dT, input.rate, input.volatility);
  const vDnT = evalAt(input.spot, input.timeToExpiry - dT, input.rate, input.volatility);
  // Theta matches Black-Scholes convention: -dV/dT (+dV/dt_calendar).
  const theta = (vDnT - vUpT) / (2 * dT);
  const thetaDaily = theta / 365;

  const vUpV = evalAt(input.spot, input.timeToExpiry, input.rate, input.volatility + dSig);
  const vDnV = evalAt(input.spot, input.timeToExpiry, input.rate, input.volatility - dSig);
  const vega = (vUpV - vDnV) / (2 * dSig);
  const vegaPer1Pct = vega / 100;

  let rho: number;
  if (input.contractType === 'call' && input.rate - dR < 0) {
    // One-sided forward difference at r = 0 boundary where BS2002 requires r >= 0.
    const vUpR = evalAt(input.spot, input.timeToExpiry, input.rate + dR, input.volatility);
    const vUp2R = evalAt(
      input.spot,
      input.timeToExpiry,
      input.rate + 2 * dR,
      input.volatility,
    );
    rho = (-3 * price + 4 * vUpR - vUp2R) / (2 * dR);
  } else {
    const vUpR = evalAt(input.spot, input.timeToExpiry, input.rate + dR, input.volatility);
    const vDnR = evalAt(input.spot, input.timeToExpiry, input.rate - dR, input.volatility);
    rho = (vUpR - vDnR) / (2 * dR);
  }

  const vUpSUpV = evalAt(
    input.spot + dS,
    input.timeToExpiry,
    input.rate,
    input.volatility + dSig,
  );
  const vUpSDnV = evalAt(
    input.spot + dS,
    input.timeToExpiry,
    input.rate,
    input.volatility - dSig,
  );
  const vDnSUpV = evalAt(
    input.spot - dS,
    input.timeToExpiry,
    input.rate,
    input.volatility + dSig,
  );
  const vDnSDnV = evalAt(
    input.spot - dS,
    input.timeToExpiry,
    input.rate,
    input.volatility - dSig,
  );
  const vanna = (vUpSUpV - vUpSDnV - vDnSUpV + vDnSDnV) / (4 * dS * dSig);

  const deltaUpT =
    (evalAt(input.spot + dS, input.timeToExpiry + dT, input.rate, input.volatility) -
      evalAt(input.spot - dS, input.timeToExpiry + dT, input.rate, input.volatility)) /
    (2 * dS);
  const deltaDnT =
    (evalAt(input.spot + dS, input.timeToExpiry - dT, input.rate, input.volatility) -
      evalAt(input.spot - dS, input.timeToExpiry - dT, input.rate, input.volatility)) /
    (2 * dS);
  // Charm = -dDelta/dT (+dDelta/dt_calendar).
  const charm = (deltaDnT - deltaUpT) / (2 * dT);

  if (
    !Number.isFinite(delta) ||
    !Number.isFinite(gamma) ||
    !Number.isFinite(theta) ||
    !Number.isFinite(thetaDaily) ||
    !Number.isFinite(vega) ||
    !Number.isFinite(vegaPer1Pct) ||
    !Number.isFinite(rho) ||
    !Number.isFinite(vanna) ||
    !Number.isFinite(charm)
  ) {
    return NAN_GREEKS_RESULT;
  }

  return {
    price,
    delta,
    gamma,
    theta,
    thetaDaily,
    vega,
    vegaPer1Pct,
    rho,
    vanna,
    charm,
  };
}

function validateAndComputePvDividends0(
  dividends: readonly DiscreteCashDividend[] | undefined,
  rate: number,
  timeToExpiry: number,
): number {
  if (dividends === undefined || dividends.length === 0) {
    return 0;
  }
  let pv0 = 0;
  for (const div of dividends) {
    if (
      !Number.isFinite(div.time) ||
      !Number.isFinite(div.amount) ||
      div.time <= 0 ||
      div.time > timeToExpiry ||
      div.amount < 0
    ) {
      return Number.NaN;
    }
    pv0 += div.amount * Math.exp(-rate * div.time);
  }
  return pv0;
}

/**
 * Pure Cox-Ross-Rubinstein (CRR) binomial lattice for American options supporting
 * both continuous dividend yield `dividendYield` and discrete cash dividends via the
 * escrowed-dividend model.
 *
 * Enforces an explicit step ceiling (`1 <= steps <= maxSteps <= 5000`) for determinism
 * and returns `Number.NaN` on invalid parameters, negative/out-of-window dividends,
 * depleted escrowed spot (`S - PV(divs) <= 0`), or arbitrage probability outside `(0, 1)`.
 */
export function priceAmericanCrrDiscrete(input: CrrDiscreteAmericanInput): number {
  if (!isValidBsmInput(input)) {
    return Number.NaN;
  }

  const maxSteps = input.maxSteps ?? MAX_CRR_STEPS;
  const steps = input.steps ?? DEFAULT_CRR_STEPS;
  if (
    !Number.isInteger(maxSteps) ||
    maxSteps < 1 ||
    maxSteps > MAX_CRR_STEPS ||
    !Number.isInteger(steps) ||
    steps < 1 ||
    steps > maxSteps
  ) {
    return Number.NaN;
  }

  const pvDiv0 = validateAndComputePvDividends0(
    input.discreteDividends,
    input.rate,
    input.timeToExpiry,
  );
  if (!Number.isFinite(pvDiv0)) {
    return Number.NaN;
  }

  const escrowedSpot = input.spot - pvDiv0;
  if (!isPositiveFinite(escrowedSpot)) {
    return Number.NaN;
  }

  const dt = input.timeToExpiry / steps;
  const stepLogMove = input.volatility * Math.sqrt(dt);
  if (!Number.isFinite(stepLogMove) || stepLogMove * steps > MAX_SAFE_EXP) {
    return Number.NaN;
  }

  const up = Math.exp(stepLogMove);
  const down = 1 / up;
  const growth = Math.exp((input.rate - input.dividendYield) * dt);
  const discount = Math.exp(-input.rate * dt);
  const probUp = (growth - down) / (up - down);

  if (
    !Number.isFinite(probUp) ||
    !Number.isFinite(discount) ||
    probUp <= 0 ||
    probUp >= 1
  ) {
    return Number.NaN;
  }
  const probDown = 1 - probUp;

  const dividends = input.discreteDividends ?? [];
  const pvRemainingAtStep = new Float64Array(steps + 1);
  for (let i = 0; i < steps; i++) {
    const t = i * dt;
    let pvRemaining = 0;
    for (const div of dividends) {
      if (div.time > t) {
        pvRemaining += div.amount * Math.exp(-input.rate * (div.time - t));
      }
    }
    pvRemainingAtStep[i] = pvRemaining;
  }
  pvRemainingAtStep[steps] = 0;

  const isCall = input.contractType === 'call';
  const values = new Float64Array(steps + 1);

  for (let j = 0; j <= steps; j++) {
    const nodeSpot = escrowedSpot * Math.exp((steps - 2 * j) * stepLogMove);
    const payoff = isCall ? nodeSpot - input.strike : input.strike - nodeSpot;
    values[j] = payoff > 0 ? payoff : 0;
  }

  for (let i = steps - 1; i >= 0; i--) {
    const pvDiv = pvRemainingAtStep[i];
    if (pvDiv === undefined) {
      return Number.NaN;
    }
    for (let j = 0; j <= i; j++) {
      const valUp = values[j];
      const valDown = values[j + 1];
      if (valUp === undefined || valDown === undefined) {
        return Number.NaN;
      }
      const holdValue = discount * (probUp * valUp + probDown * valDown);
      const cumSpot = escrowedSpot * Math.exp((i - 2 * j) * stepLogMove) + pvDiv;
      const exerciseValue = isCall
        ? cumSpot - input.strike
        : input.strike - cumSpot;
      values[j] = exerciseValue > holdValue ? exerciseValue : holdValue;
    }
  }

  const root = values[0];
  return root !== undefined && Number.isFinite(root) ? root : Number.NaN;
}

function americanArbitrageBounds(
  input: SolveImpliedVolAmericanInput,
  pvDiv0: number,
): { readonly lower: number; readonly upper: number } {
  const escrowedSpot = input.spot - pvDiv0;
  const intrinsic =
    input.contractType === 'call'
      ? Math.max(0, input.spot - input.strike)
      : Math.max(0, input.strike - input.spot);

  const discStrike = input.strike * Math.exp(-input.rate * input.timeToExpiry);
  const discSpot = escrowedSpot * Math.exp(-input.dividendYield * input.timeToExpiry);
  const europeanFloor =
    input.contractType === 'call'
      ? Math.max(0, discSpot - discStrike)
      : Math.max(0, discStrike - discSpot);

  const lower = Math.max(intrinsic, europeanFloor);
  const upper = input.contractType === 'call' ? input.spot : input.strike;
  return { lower, upper };
}

/**
 * Pure Brent root-finder for American implied volatility.
 *
 * Uses `priceAmericanBjerksund2002` by default, or `priceAmericanCrrDiscrete` when
 * discrete cash dividends or explicit lattice `steps` are provided. Rejects prices at or
 * below American intrinsic/lower arbitrage bounds (`<= lower` -> `NaN`) or above/at the
 * upper arbitrage bound (`>= upper` -> `NaN`).
 */
export function solveImpliedVolAmerican(input: SolveImpliedVolAmericanInput): number {
  const {
    spot,
    strike,
    timeToExpiry,
    rate,
    dividendYield,
    contractType,
    marketPrice,
    discreteDividends,
    steps,
    maxSteps,
    minVolatility = DEFAULT_IV_MIN_VOL,
    maxVolatility = DEFAULT_IV_MAX_VOL,
    tolerance = DEFAULT_IV_TOLERANCE,
    maxIterations = DEFAULT_IV_MAX_ITERATIONS,
  } = input;

  if (
    !isPositiveFinite(spot) ||
    !isPositiveFinite(strike) ||
    !isPositiveFinite(timeToExpiry) ||
    !isPositiveFinite(marketPrice) ||
    !Number.isFinite(rate) ||
    !Number.isFinite(dividendYield) ||
    !isValidContractType(contractType) ||
    !isPositiveFinite(minVolatility) ||
    !Number.isFinite(maxVolatility) ||
    maxVolatility <= minVolatility ||
    !isPositiveFinite(tolerance) ||
    !Number.isInteger(maxIterations) ||
    maxIterations <= 0
  ) {
    return Number.NaN;
  }

  const useLattice =
    (discreteDividends !== undefined && discreteDividends.length > 0) ||
    steps !== undefined ||
    maxSteps !== undefined;

  let pvDiv0 = 0;
  let effectiveSteps = steps;
  if (useLattice) {
    const resolvedMaxSteps = maxSteps ?? MAX_CRR_STEPS;
    const resolvedSteps = steps ?? DEFAULT_CRR_STEPS;
    if (
      !Number.isInteger(resolvedMaxSteps) ||
      resolvedMaxSteps < 1 ||
      resolvedMaxSteps > MAX_CRR_STEPS ||
      !Number.isInteger(resolvedSteps) ||
      resolvedSteps < 1 ||
      resolvedSteps > resolvedMaxSteps
    ) {
      return Number.NaN;
    }
    effectiveSteps = resolvedSteps;
    pvDiv0 = validateAndComputePvDividends0(discreteDividends, rate, timeToExpiry);
    if (!Number.isFinite(pvDiv0) || !isPositiveFinite(spot - pvDiv0)) {
      return Number.NaN;
    }
  }

  const bounds = americanArbitrageBounds(input, pvDiv0);
  // Require strict interior arbitrage bounds; at exact intrinsic value vega is 0 and IV is non-unique.
  if (marketPrice <= bounds.lower || marketPrice >= bounds.upper) {
    return Number.NaN;
  }

  const evalResidual = (sigma: number): number => {
    const modelPrice = useLattice
      ? priceAmericanCrrDiscrete({
          spot,
          strike,
          timeToExpiry,
          rate,
          dividendYield,
          volatility: sigma,
          contractType,
          ...(discreteDividends !== undefined ? { discreteDividends } : {}),
          ...(effectiveSteps !== undefined ? { steps: effectiveSteps } : {}),
          ...(maxSteps !== undefined ? { maxSteps } : {}),
        })
      : priceAmericanBjerksund2002({
          spot,
          strike,
          timeToExpiry,
          rate,
          dividendYield,
          volatility: sigma,
          contractType,
        });
    return modelPrice - marketPrice;
  };

  let volLow = minVolatility;
  let volHigh = maxVolatility;
  if (useLattice && effectiveSteps !== undefined) {
    // CRR risk-neutral probability probUp in (0, 1) strictly requires sigma > |r - q| * sqrt(dt).
    const dt = timeToExpiry / effectiveSteps;
    const minLatticeVol = Math.abs(rate - dividendYield) * Math.sqrt(dt) * (1 + 1e-6) + 1e-9;
    if (Number.isFinite(minLatticeVol) && minLatticeVol > volLow) {
      volLow = minLatticeVol;
    }
    const escrowedSpot = spot - pvDiv0;
    const logSpotAdj = Math.max(0, Math.log(escrowedSpot));
    const maxSafeVol =
      (680 - logSpotAdj) / Math.sqrt(effectiveSteps * timeToExpiry);
    if (Number.isFinite(maxSafeVol) && maxSafeVol > volLow && maxSafeVol < volHigh) {
      volHigh = maxSafeVol;
    }
    if (volLow >= volHigh) {
      return Number.NaN;
    }
  }

  let fa = evalResidual(volLow);
  let fb = evalResidual(volHigh);
  if (!Number.isFinite(fa) || !Number.isFinite(fb)) {
    return Number.NaN;
  }
  if (Math.abs(fa) <= tolerance) {
    return volLow;
  }
  if (Math.abs(fb) <= tolerance) {
    return volHigh;
  }
  if (fa > 0 || fb < 0) {
    return Number.NaN;
  }

  // Standard Brent's method (Numerical Recipes zbrent) on [volLow, volHigh].
  let a = volLow;
  let b = volHigh;
  let c = volHigh;
  let fc = fb;
  let d = b - a;
  let e = d;
  const eps = 2.220446049250313e-16;

  for (let iter = 0; iter < maxIterations; iter++) {
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

    const tol1 = 2 * eps * Math.abs(b) + 0.5 * tolerance;
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
        q = fa / fc;
        const r = fb / fc;
        p = s * (2 * xm * q * (q - r) - (b - a) * (r - 1));
        q = (q - 1) * (r - 1) * (s - 1);
      }
      if (p > 0) {
        q = -q;
      }
      p = Math.abs(p);
      const min1 = 3 * xm * q - Math.abs(tol1 * q);
      const min2 = Math.abs(e * q);
      if (2 * p < (min1 < min2 ? min1 : min2)) {
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
    fb = evalResidual(b);
    if (!Number.isFinite(fb)) {
      return Number.NaN;
    }
  }

  return Math.abs(fb) <= tolerance || Math.abs(c - b) <= tolerance ? b : Number.NaN;
}
