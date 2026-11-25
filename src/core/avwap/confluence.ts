import { greeksBsm } from '../options/blackScholes.js';
import type {
  AvwapAlignedLevel,
  AvwapAlignedLevelType,
  AvwapConfluenceContext,
  AvwapConfluenceInput,
  AvwapDegradationFlag,
  AvwapGammaRegime,
  AvwapPolarity,
  AvwapSpatialKernels,
  AvwapVolRegime,
  InstitutionalVannaCharmInput,
  InstitutionalVannaCharmResult,
} from './types.js';

function clamp(val: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, val));
}

function isPositiveFinite(x: number | null | undefined): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}

/**
 * Spatial ATR Gaussian kernel: `K(delta) = exp(-delta^2 / (2 * sigmaAtr^2))` with default `sigmaAtr = 0.35`.
 * Returns `NaN` when `avwapPrice` or `atr14` is invalid, and `0` when the structural level is absent.
 */
export function atrGaussianKernel(
  avwapPrice: number,
  levelPrice: number | null | undefined,
  atr14: number,
  sigmaAtr = 0.35,
): number {
  if (!isPositiveFinite(avwapPrice) || !isPositiveFinite(atr14)) {
    return Number.NaN;
  }
  if (!Number.isFinite(sigmaAtr) || sigmaAtr <= 0) {
    throw new RangeError(`sigmaAtr must be > 0, got ${String(sigmaAtr)}`);
  }
  if (!isPositiveFinite(levelPrice)) {
    return 0;
  }
  const delta = Math.abs(avwapPrice - levelPrice) / atr14;
  return Math.exp(-(delta * delta) / (2 * sigmaAtr * sigmaAtr));
}

/**
 * Continuous Net GEX normalization: `g = tanh(NetGEX / G_0)` with `G_0 = 0.01 * DollarVol_20d`.
 */
export function normalizeNetGex(
  netGex: number | null | undefined,
  dollarVol20d: number,
): Readonly<{ g: number; g0: number }> {
  if (!isPositiveFinite(dollarVol20d)) {
    return { g: Number.NaN, g0: Number.NaN };
  }
  const g0 = 0.01 * dollarVol20d;
  if (netGex === null || netGex === undefined || !Number.isFinite(netGex)) {
    return { g: Number.NaN, g0 };
  }
  return { g: Math.tanh(netGex / g0), g0 };
}

export function classifyVolatilityRegime(
  spyIv30dDec: number | null | undefined,
): AvwapVolRegime {
  if (!isPositiveFinite(spyIv30dDec)) {
    return 'UNKNOWN';
  }
  if (spyIv30dDec < 0.15) {
    return 'LOW_VOL_CHOP';
  }
  if (spyIv30dDec <= 0.25) {
    return 'MID_VOL';
  }
  return 'HIGH_VOL_TREND';
}

export function classifyGammaRegime(g: number): AvwapGammaRegime {
  if (!Number.isFinite(g)) {
    return 'UNKNOWN';
  }
  if (g > 1e-9) {
    return 'POSITIVE_GAMMA';
  }
  if (g < -1e-9) {
    return 'NEGATIVE_GAMMA';
  }
  return 'NEUTRAL';
}

function emptySpatialKernels(): AvwapSpatialKernels {
  return {
    callWall: Number.NaN,
    putWall: Number.NaN,
    zeroGamma: Number.NaN,
    vpPoc: Number.NaN,
    vpVah: Number.NaN,
    vpVal: Number.NaN,
    vpHvnMax: Number.NaN,
    vpLvnMax: Number.NaN,
  };
}

/**
 * Evaluates BounceConfluence and BreakoutConfluence `[0..100]` with empirical Prompt #6 regime modifiers.
 * Pure 1:1 port of `research/avwap_oracle/src/avwap_oracle/scoring/confluence.py`.
 */
export function computeConfluenceContext(
  input: AvwapConfluenceInput,
): AvwapConfluenceContext {
  const polarity: AvwapPolarity = input.polarity ?? 'LONG';
  const extraFlags = input.extraDegradationFlags ?? [];
  const baseFlags = [...new Set(extraFlags)].sort();

  if (!isPositiveFinite(input.avwapPrice) || !isPositiveFinite(input.atr14)) {
    return {
      role: 'INSTITUTIONAL_CONTEXT_ONLY',
      bounceConfluenceScore: Number.NaN,
      breakoutConfluenceScore: Number.NaN,
      netGexNormalizedG: Number.NaN,
      g0DollarVolScale: Number.NaN,
      gammaRegime: 'UNKNOWN',
      volRegime: classifyVolatilityRegime(input.spyIv30dDec),
      meanReversionContextActive: false,
      alignedLevels: [],
      spatialKernels: emptySpatialKernels(),
      hazardFlags: [],
      flags: baseFlags,
      bounceMultiplier: Number.NaN,
      breakoutMultiplier: Number.NaN,
    };
  }

  const kCw = atrGaussianKernel(input.avwapPrice, input.callWall, input.atr14);
  const kPw = atrGaussianKernel(input.avwapPrice, input.putWall, input.atr14);
  let kWall: number;
  if (polarity === 'LONG' && kPw > 0) {
    kWall = Math.max(kPw, 0.85 * kCw);
  } else if (polarity === 'SHORT' && kCw > 0) {
    kWall = Math.max(kCw, 0.85 * kPw);
  } else {
    kWall = Math.max(kCw, kPw);
  }

  const kPoc = atrGaussianKernel(input.avwapPrice, input.vpPoc, input.atr14);
  const kVah = atrGaussianKernel(input.avwapPrice, input.vpVah, input.atr14);
  const kVal = atrGaussianKernel(input.avwapPrice, input.vpVal, input.atr14);
  let kHvn = 0;
  for (const lv of input.vpHvns ?? []) {
    kHvn = Math.max(kHvn, atrGaussianKernel(input.avwapPrice, lv, input.atr14));
  }
  const kVpBounce = Math.max(kPoc, kVah, kVal, kHvn);

  const cvdAbs =
    input.cvdAbsorptionScore !== undefined &&
    input.cvdAbsorptionScore !== null &&
    Number.isFinite(input.cvdAbsorptionScore)
      ? clamp(input.cvdAbsorptionScore, 0, 1)
      : Number.NaN;

  const bounceParts: [number, number][] = [
    [0.4, kWall],
    [0.35, kVpBounce],
  ];
  if (Number.isFinite(cvdAbs)) {
    bounceParts.push([0.25, cvdAbs]);
  }
  let wSumB = 0;
  let bNum = 0;
  for (const [w, v] of bounceParts) {
    wSumB += w;
    bNum += w * v;
  }
  const baseBounce = wSumB > 0 ? 100 * (bNum / wSumB) : 0;

  const kZg = atrGaussianKernel(input.avwapPrice, input.zeroGamma, input.atr14);
  let kLvn = 0;
  for (const lv of input.vpLvns ?? []) {
    kLvn = Math.max(kLvn, atrGaussianKernel(input.avwapPrice, lv, input.atr14));
  }
  const rvolNorm =
    input.bucketRvolZ !== undefined &&
    input.bucketRvolZ !== null &&
    Number.isFinite(input.bucketRvolZ)
      ? clamp(Math.max(0, input.bucketRvolZ) / 3, 0, 1)
      : Number.NaN;
  const cvdDir =
    input.cvdDirectionalAlignment !== undefined &&
    input.cvdDirectionalAlignment !== null &&
    Number.isFinite(input.cvdDirectionalAlignment)
      ? clamp(input.cvdDirectionalAlignment, 0, 1)
      : Number.NaN;

  const boParts: [number, number][] = [
    [0.35, kZg],
    [0.25, kLvn],
  ];
  if (Number.isFinite(rvolNorm)) {
    boParts.push([0.25, rvolNorm]);
  }
  if (Number.isFinite(cvdDir)) {
    boParts.push([0.15, cvdDir]);
  }
  let wSumBo = 0;
  let boNum = 0;
  for (const [w, v] of boParts) {
    wSumBo += w;
    boNum += w * v;
  }
  const baseBreakout = wSumBo > 0 ? 100 * (boNum / wSumBo) : 0;

  const { g, g0 } = normalizeNetGex(input.netGex, input.dollarVol20d);
  const gammaRegime = classifyGammaRegime(g);
  const volRegime = classifyVolatilityRegime(input.spyIv30dDec);
  const contangoPos =
    input.contango !== undefined &&
    input.contango !== null &&
    Number.isFinite(input.contango) &&
    input.contango > 0;

  const hazardFlags: AvwapDegradationFlag[] = [];
  let bounceMultiplier = 1;
  let breakoutMultiplier = 1;
  if (Number.isFinite(g)) {
    if (g >= 0) {
      bounceMultiplier = 1 + 0.25 * g + (g > 0 && contangoPos ? 0.05 : 0);
      breakoutMultiplier = Math.max(0.5, 1 - 0.25 * g);
    } else {
      bounceMultiplier = Math.max(0.35, 1 - 0.45 * -g);
      breakoutMultiplier = 1 + 0.3 * -g;
      if (g < -0.3) {
        hazardFlags.push('SHORT_GAMMA_BOUNCE_HAZARD');
      }
    }
  }

  const bounceConfluenceScore = clamp(baseBounce * bounceMultiplier, 0, 100);
  const breakoutConfluenceScore = clamp(baseBreakout * breakoutMultiplier, 0, 100);

  const refPrices = [input.avwapPrice];
  if (
    input.sigmaHybrid !== undefined &&
    input.sigmaHybrid !== null &&
    Number.isFinite(input.sigmaHybrid) &&
    input.sigmaHybrid >= 0
  ) {
    const sh = input.sigmaHybrid;
    refPrices.push(
      input.avwapPrice + 2 * sh,
      input.avwapPrice - 2 * sh,
      input.avwapPrice + 2.5 * sh,
      input.avwapPrice - 2.5 * sh,
    );
  }

  const targetLevels = [input.callWall, input.putWall, input.vpVah, input.vpVal].filter(
    (p): p is number => typeof p === 'number' && Number.isFinite(p),
  );
  let minDistAtr = Number.POSITIVE_INFINITY;
  for (const rp of refPrices) {
    for (const lv of targetLevels) {
      const dAtr = Math.abs(rp - lv) / input.atr14;
      if (dAtr < minDistAtr) {
        minDistAtr = dAtr;
      }
    }
  }
  const meanReversionContextActive =
    gammaRegime === 'POSITIVE_GAMMA' && contangoPos && minDistAtr <= 0.25;

  const alignedLevels: AvwapAlignedLevel[] = [];
  const pushAligned = (levelType: AvwapAlignedLevelType, price: number | null | undefined): void => {
    if (!isPositiveFinite(price)) {
      return;
    }
    const distanceAtr = Math.abs(input.avwapPrice - price) / input.atr14;
    const kernelWeight = atrGaussianKernel(input.avwapPrice, price, input.atr14);
    alignedLevels.push({ levelType, price, distanceAtr, kernelWeight });
  };

  pushAligned('CALL_WALL', input.callWall);
  pushAligned('PUT_WALL', input.putWall);
  pushAligned('ZERO_GAMMA', input.zeroGamma);
  pushAligned('VP_POC', input.vpPoc);
  pushAligned('VP_VAH', input.vpVah);
  pushAligned('VP_VAL', input.vpVal);
  for (const hvn of input.vpHvns ?? []) {
    pushAligned('VP_HVN', hvn);
  }
  for (const lvn of input.vpLvns ?? []) {
    pushAligned('VP_LVN', lvn);
  }
  alignedLevels.sort((a, b) => b.kernelWeight - a.kernelWeight);

  const flags = [...new Set<AvwapDegradationFlag>([...extraFlags, ...hazardFlags])].sort();
  return {
    role: 'INSTITUTIONAL_CONTEXT_ONLY',
    bounceConfluenceScore,
    breakoutConfluenceScore,
    netGexNormalizedG: g,
    g0DollarVolScale: g0,
    gammaRegime,
    volRegime,
    meanReversionContextActive,
    alignedLevels,
    spatialKernels: {
      callWall: kCw,
      putWall: kPw,
      zeroGamma: kZg,
      vpPoc: kPoc,
      vpVah: kVah,
      vpVal: kVal,
      vpHvnMax: kHvn,
      vpLvnMax: kLvn,
    },
    hazardFlags,
    flags,
    bounceMultiplier,
    breakoutMultiplier,
  };
}

/**
 * Wrapper around `greeksBsm` from `src/core/options/blackScholes.ts` (note: `src/core/blackScholes.ts`
 * does not exist in this repository; BSM lives in `src/core/options/blackScholes.ts`).
 *
 * Sign & Unit Parity Audit vs. `research/avwap_oracle` (`avwap_phase2_golden_fixtures.json`):
 * - `timeToExpiry = dteDays / 365` (ACT/365)
 * - `dividendYield = riskFree - residualRate` (`residualRate` represents continuous carry `b = r - q`)
 * - `vanna`: `greeksBsm.vanna` equals `-exp(-qT) * phi(d1) * (d2 / sigma)` (`dDelta/dSigma`),
 *   matching the research oracle in both **sign** and **unit (+1.00 vol)** verbatim.
 * - `charm`: `greeksBsm.charm` equals `-dDelta/dT` (`+dDelta/dt_cal`), annualized per calendar year
 *   (`yr^-1`), matching `bsm_second_order_greeks.charm` in both **sign** and **annualized unit**.
 *   `charmDaily = greeksBsm.charm / 365` exposes calendar daily decay directly (`charm_daily`).
 */
export function computeInstitutionalVannaCharm(
  input: InstitutionalVannaCharmInput,
): InstitutionalVannaCharmResult {
  const residualRate = input.residualRate ?? 0;
  const contractType = input.contractType ?? 'call';

  if (
    !isPositiveFinite(input.spot) ||
    !isPositiveFinite(input.strike) ||
    !isPositiveFinite(input.dteDays) ||
    !isPositiveFinite(input.smvVol) ||
    !Number.isFinite(input.riskFree) ||
    !Number.isFinite(residualRate)
  ) {
    return {
      contractType,
      spot: input.spot,
      strike: input.strike,
      dteDays: input.dteDays,
      timeToExpiryYears: Number.NaN,
      smvVol: input.smvVol,
      riskFree: input.riskFree,
      residualRate,
      dividendYieldQ: Number.NaN,
      d1: Number.NaN,
      d2: Number.NaN,
      price: Number.NaN,
      delta: Number.NaN,
      gamma: Number.NaN,
      vega: Number.NaN,
      vanna: Number.NaN,
      charm: Number.NaN,
      charmDaily: Number.NaN,
    };
  }

  const timeToExpiry = input.dteDays / 365;
  const dividendYield = input.riskFree - residualRate;
  const greeks = greeksBsm({
    spot: input.spot,
    strike: input.strike,
    timeToExpiry,
    rate: input.riskFree,
    dividendYield,
    volatility: input.smvVol,
    contractType,
  });

  const volSqrtT = input.smvVol * Math.sqrt(timeToExpiry);
  const d1 =
    (Math.log(input.spot / input.strike) +
      (residualRate + 0.5 * input.smvVol * input.smvVol) * timeToExpiry) /
    volSqrtT;
  const d2 = d1 - volSqrtT;

  return {
    contractType,
    spot: input.spot,
    strike: input.strike,
    dteDays: input.dteDays,
    timeToExpiryYears: timeToExpiry,
    smvVol: input.smvVol,
    riskFree: input.riskFree,
    residualRate,
    dividendYieldQ: dividendYield,
    d1,
    d2,
    price: greeks.price,
    delta: greeks.delta,
    gamma: greeks.gamma,
    vega: greeks.vega,
    vanna: greeks.vanna,
    charm: greeks.charm,
    charmDaily: greeks.charm / 365,
  };
}
