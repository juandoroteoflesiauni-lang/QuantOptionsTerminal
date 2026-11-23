/**
 * Motor 1 — Paridad Dual-Listing (GGAL BYMA 24hs/CI vs. ADR NASDAQ), Benchmark Soberano
 * (AL30/GD30), Calibración Causal Ornstein-Uhlenbeck AR(1), Detector EST/EDT y Predictor
 * Teórico de Apertura Pre-11:00 ART con Repricing de Opciones (Secciones 2 y 5.1).
 *
 * Funciones 100 % puras: cero red, cero E/S, cero UI y cero mutación de argumentos.
 */

import { evaluateCclContemporaneity, type CclTemporalValuation } from '../temporalFeedIntegrity.js';
import { normCdf } from '../options/math.js';
import { greeksBsm, priceBsm } from '../options/blackScholes.js';
import {
  BYMA_FEE_SCHEDULE,
  type BymaFeeSchedule,
  computeBymaFeeRate,
  computeSettlementCalendarDays,
  computeUsEquityFeeRate,
  DAYS_PER_YEAR,
  DEFAULT_US_FEE_SCHEDULE,
  type DstMode,
  formatIsoUtcFromSec,
  getBuenosAiresParts,
  getNewYorkPartsAndDst,
  GGAL_ADR_RATIO,
  isPositiveFinite,
  isTradingDayCivilIndex,
  isValidUtcSec,
  parseCivilDateKey,
  quoteMid,
  quoteRelativeSpread,
  type BidAskQuote,
  type UsFeeSchedule,
} from './types.js';

export type SessionRegime =
  | 'BYMA_ONLY'
  | 'OVERLAP'
  | 'NASDAQ_SOLO_17_18'
  | 'PREMARKET_REPRICE'
  | 'CLOSED';

export type ParityGapSignal =
  | 'LONG_BYMA_SHORT_ADR'
  | 'SHORT_BYMA_LONG_ADR'
  | 'NEUTRAL'
  | 'STALE_DATA_LOCK';

export type BondBenchmarkWeighting = 'INVERSE_SPREAD_SQ' | 'VOLUME';

export interface SovereignBondCclQuote {
  readonly ticker: string;
  readonly ars24h: BidAskQuote;
  readonly usdC24h: BidAskQuote;
  /** Base nominal (p. ej. 100 VN). Debe coincidir entre ARS y USD-C o se ajusta linealmente. */
  readonly arsNominalBase?: number;
  readonly usdCNominalBase?: number;
  readonly nominalVolumeArs?: number;
}

export interface CausalSpreadObservation {
  readonly time: number;
  readonly cclGgal24h: number;
  readonly cclSovereign: number;
}

export interface OuCalibrationResult {
  readonly status: 'OK' | 'NO_DATA';
  readonly observationsUsed: number;
  readonly excludedFutureCount: number;
  readonly phi: number;
  readonly intercept: number;
  readonly kappaPerDay: number;
  readonly muLog: number;
  readonly halfLifeDays: number;
  readonly residualSigma: number;
  readonly eqSigma: number;
}

export interface PreOpenMacroPredictorInput {
  readonly bymaPrevClose24hArs: number;
  readonly adrPrev1700ArtUsd: number;
  readonly adrPreMarketVolume?: number;
  readonly adrExDividendUsd?: number;
  readonly bymaExDividendArs?: number;
  readonly prevDaySpreadLog1700?: number;
  readonly overnightDays?: number;
  readonly spyOvernightLogReturn?: number;
  readonly qqqOvernightLogReturn?: number;
  readonly vixOvernightLogChange?: number;
  /** Coeficientes explícitos para ponderación pre-market w_PM y proyección macro. */
  readonly params?: {
    readonly alpha0?: number;
    readonly alpha1SpreadWeight?: number;
    readonly alpha2VolumeWeight?: number;
    readonly betaSpy?: number;
    readonly betaQqq?: number;
    readonly gammaSpyCcl?: number;
    readonly gammaVixCcl?: number;
    readonly ivSensitivityToAdrReturn?: number;
  };
}

export interface LocalOptionPreOpenInput {
  readonly tickerByma: string;
  readonly prevCloseArs: number;
  readonly delta: number;
  readonly gamma: number;
  /** Vega por +1.00 de volatilidad anualizada (`∂V/∂σ`). */
  readonly vega: number;
  /** Theta anualizada estándar (`∂V/∂t = -∂V/∂T`). */
  readonly theta: number;
  /** Cambio esperado explícito de IV decimal; si se omite, usa `ivSensitivity * r_ADR_adj`. */
  readonly deltaImpliedVol?: number;
  /** Pieza 44: parámetros BSM individuales opcionales para evitar repricing plano. */
  readonly strikeArs?: number;
  readonly contractType?: 'call' | 'put';
  readonly timeToExpiryYears?: number;
  readonly iv?: number;
  readonly rateCont?: number;
  readonly dividendYield?: number;
  readonly projectedSpotArs?: number;
}

export interface IndividualOptionBsmRepricingInput {
  readonly tickerByma: string;
  readonly prevSpotArs: number;
  readonly projectedSpotArs: number;
  readonly strikeArs: number;
  readonly contractType: 'call' | 'put';
  readonly timeToExpiryYears: number;
  readonly iv: number;
  readonly rateCont: number;
  readonly prevCloseArs: number;
  readonly dividendYield?: number;
  readonly deltaImpliedVol?: number;
  readonly dtYears?: number;
}

export interface PreOpenOptionRepricingItem {
  readonly tickerByma: string;
  readonly prevCloseArs: number;
  readonly fairOpenArs: number;
  readonly deltaRepricePct: number;
  readonly bsmFairPrevArs?: number;
  readonly bsmFairProjectedArs?: number;
  readonly strikeArs?: number;
  readonly deltaAtClose?: number;
  readonly gammaAtClose?: number;
}

export interface ParityGapInput {
  readonly asOfUtcSec: number;
  readonly data912TimestampSec: number;
  readonly massiveTimestampSec: number;
  readonly marketMode?: 'LIVE' | 'EOD_CIERRE';
  readonly maxData912StalenessSec?: number;
  readonly maxMassiveStalenessSec?: number;
  readonly maxSyncSkewSec?: number;
  readonly arHolidays?: readonly string[];
  readonly usHolidays?: readonly string[];
  /** Override opcional de días calendario a liquidación 24hs AR y T+1 US. */
  readonly deltaAr1Days?: number;
  readonly deltaUs1Days?: number;
  readonly byma24h: BidAskQuote;
  readonly bymaCi?: BidAskQuote;
  readonly adr: BidAskQuote;
  readonly sofrRateAnnual: number;
  readonly caucionArsRateTna: number;
  readonly sovereignBonds: readonly SovereignBondCclQuote[];
  readonly bondWeighting?: BondBenchmarkWeighting;
  readonly spreadHistory: readonly CausalSpreadObservation[];
  readonly ouStepDays?: number;
  readonly minOuObservations?: number;
  readonly exitBandHalfWidthLog?: number;
  readonly closeHorizonDays?: number;
  readonly slippageLogCost?: number;
  readonly bymaFeeSchedule?: BymaFeeSchedule;
  readonly usFeeSchedule?: UsFeeSchedule;
  readonly notionalArsForFees?: number;
  readonly zEntryThreshold?: number;
  readonly minNetEdgeBps?: number;
  readonly maxHalfLifeDays?: number;
  readonly bymaPrevClose24hArs?: number;
  readonly preOpen?: PreOpenMacroPredictorInput;
  readonly preOpenOptions?: readonly LocalOptionPreOpenInput[];
}

export interface ParityGapOutput {
  readonly cclTemporal: CclTemporalValuation;
  readonly timestampUtc: string;
  readonly asOfUtcSec: number;
  readonly sessionRegime: SessionRegime;
  readonly dstMode: DstMode;
  readonly deltaAr1Days: number;
  readonly deltaUs1Days: number;
  readonly feedStalenessSec: {
    readonly massive: number;
    readonly data912: number;
  };
  readonly spot: {
    readonly byma24hArs: number;
    readonly bymaCiArs: number;
    readonly adrMidUsd: number;
    readonly fairBymaOpenArs: number;
    readonly fairAdrUsd: number;
    readonly gapPctVsPrevClose: number;
  };
  readonly ccl: {
    readonly cclGgal24h: number;
    readonly cclGgalCiTo24h: number;
    readonly cclAl30_24h: number;
    readonly cclGd30_24h: number;
    readonly cclSovereignBenchmark: number;
    readonly spreadLogBps: number;
    readonly ouMeanBps: number;
    readonly ouHalfLifeDays: number;
    readonly ouEqSigmaBps: number;
    readonly zScore: number;
    readonly netEdgeAfterCostsBps: number;
    readonly closeProbability5d: number;
  };
  readonly ouCalibration: OuCalibrationResult;
  readonly signal: ParityGapSignal;
  readonly preOpenOptionRepricing: readonly PreOpenOptionRepricingItem[];
}

const DEFAULT_MAX_STALENESS_SEC = 20;
const DEFAULT_OU_STEP_DAYS = 1;
const DEFAULT_MIN_OU_OBS = 10;
const DEFAULT_CLOSE_HORIZON_DAYS = 5;
const DEFAULT_Z_THRESHOLD = 2.0;
const DEFAULT_MIN_EDGE_BPS = 30;
const DEFAULT_MAX_HALF_LIFE_DAYS = 5;
const DEFAULT_NOTIONAL_FOR_FEES = 1_000_000;

const PREMARKET_START_ART_MIN = 6 * 60; // 06:00 ART
const BYMA_OPEN_ART_MIN = 11 * 60; // 11:00 ART
const BYMA_CLOSE_ART_MIN = 17 * 60; // 17:00 ART
const NASDAQ_OPEN_NY_MIN = 9 * 60 + 30; // 09:30 NY
const NASDAQ_CLOSE_NY_MIN = 16 * 60; // 16:00 NY

export function classifySessionRegime(
  asOfUtcSec: number,
  arHolidays: readonly string[] = [],
  usHolidays: readonly string[] = [],
): {
  readonly sessionRegime: SessionRegime;
  readonly dstMode: DstMode;
  readonly arDateKey: string;
  readonly nyDateKey: string;
  readonly isArTradingDay: boolean;
  readonly isUsTradingDay: boolean;
} {
  if (!isValidUtcSec(asOfUtcSec)) {
    throw new Error(`asOfUtcSec must be valid integer UTC seconds (got ${String(asOfUtcSec)})`);
  }
  const art = getBuenosAiresParts(asOfUtcSec);
  const ny = getNewYorkPartsAndDst(asOfUtcSec);
  const arHolidaySet = new Set(arHolidays);
  const usHolidaySet = new Set(usHolidays);

  const arDayIdx = parseCivilDateKey(art.dateKey);
  const nyDayIdx = parseCivilDateKey(ny.dateKey);
  const isArTradingDay = Number.isFinite(arDayIdx) && isTradingDayCivilIndex(arDayIdx, arHolidaySet);
  const isUsTradingDay = Number.isFinite(nyDayIdx) && isTradingDayCivilIndex(nyDayIdx, usHolidaySet);

  const arOpen =
    isArTradingDay && art.minutesOfDay >= BYMA_OPEN_ART_MIN && art.minutesOfDay < BYMA_CLOSE_ART_MIN;
  const nyOpen =
    isUsTradingDay && ny.minutesOfDay >= NASDAQ_OPEN_NY_MIN && ny.minutesOfDay < NASDAQ_CLOSE_NY_MIN;
  const inArPreMarket =
    isArTradingDay &&
    art.minutesOfDay >= PREMARKET_START_ART_MIN &&
    art.minutesOfDay < BYMA_OPEN_ART_MIN;

  let sessionRegime: SessionRegime;
  if (arOpen && nyOpen) {
    sessionRegime = 'OVERLAP';
  } else if (arOpen && !nyOpen) {
    sessionRegime = 'BYMA_ONLY';
  } else if (inArPreMarket) {
    sessionRegime = 'PREMARKET_REPRICE';
  } else if (!arOpen && nyOpen) {
    sessionRegime = 'NASDAQ_SOLO_17_18';
  } else {
    sessionRegime = 'CLOSED';
  }

  return {
    sessionRegime,
    dstMode: ny.dstMode,
    arDateKey: art.dateKey,
    nyDateKey: ny.dateKey,
    isArTradingDay,
    isUsTradingDay,
  };
}

/**
 * Calibra el proceso Ornstein-Uhlenbeck discreto X_{t+dt} = phi * X_t + c + eps_t
 * sobre observaciones estrictamente causales (time <= asOfUtcSec).
 */
export function calibrateCausalOuAr1(
  observations: readonly CausalSpreadObservation[],
  asOfUtcSec: number,
  stepDays = DEFAULT_OU_STEP_DAYS,
  minObservations = DEFAULT_MIN_OU_OBS,
): OuCalibrationResult {
  const invalid: OuCalibrationResult = {
    status: 'NO_DATA',
    observationsUsed: 0,
    excludedFutureCount: 0,
    phi: Number.NaN,
    intercept: Number.NaN,
    kappaPerDay: Number.NaN,
    muLog: Number.NaN,
    halfLifeDays: Number.NaN,
    residualSigma: Number.NaN,
    eqSigma: Number.NaN,
  };

  if (!isValidUtcSec(asOfUtcSec) || !isPositiveFinite(stepDays) || observations.length === 0) {
    return invalid;
  }

  let excludedFutureCount = 0;
  const causal: { readonly time: number; readonly x: number }[] = [];
  for (const row of observations) {
    if (!isValidUtcSec(row.time)) {
      continue;
    }
    if (row.time > asOfUtcSec) {
      excludedFutureCount += 1;
      continue;
    }
    if (isPositiveFinite(row.cclGgal24h) && isPositiveFinite(row.cclSovereign)) {
      causal.push({ time: row.time, x: Math.log(row.cclGgal24h) - Math.log(row.cclSovereign) });
    }
  }

  causal.sort((a, b) => a.time - b.time);
  const nObs = causal.length;
  const nPairs = nObs - 1;
  if (nObs < minObservations || nPairs < 3) {
    return { ...invalid, observationsUsed: nObs, excludedFutureCount };
  }

  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < nPairs; i += 1) {
    const cur = causal[i];
    const next = causal[i + 1];
    if (cur === undefined || next === undefined) {
      return { ...invalid, observationsUsed: nObs, excludedFutureCount };
    }
    sumX += cur.x;
    sumY += next.x;
  }
  const meanX = sumX / nPairs;
  const meanY = sumY / nPairs;

  let covXY = 0;
  let varX = 0;
  for (let i = 0; i < nPairs; i += 1) {
    const cur = causal[i];
    const next = causal[i + 1];
    if (cur === undefined || next === undefined) {
      return { ...invalid, observationsUsed: nObs, excludedFutureCount };
    }
    const dx = cur.x - meanX;
    const dy = next.x - meanY;
    covXY += dx * dy;
    varX += dx * dx;
  }

  if (!isPositiveFinite(varX)) {
    return { ...invalid, observationsUsed: nObs, excludedFutureCount };
  }

  const phi = covXY / varX;
  const intercept = meanY - phi * meanX;
  if (!Number.isFinite(phi) || !Number.isFinite(intercept) || phi <= 0 || phi >= 1) {
    return {
      ...invalid,
      observationsUsed: nObs,
      excludedFutureCount,
      phi,
      intercept,
    };
  }

  let rss = 0;
  for (let i = 0; i < nPairs; i += 1) {
    const cur = causal[i];
    const next = causal[i + 1];
    if (cur === undefined || next === undefined) {
      return { ...invalid, observationsUsed: nObs, excludedFutureCount };
    }
    const resid = next.x - (phi * cur.x + intercept);
    rss += resid * resid;
  }
  const df = nPairs > 2 ? nPairs - 2 : nPairs;
  const residualSigma = Math.sqrt(rss / df);
  const kappaPerDay = -Math.log(phi) / stepDays;
  const muLog = intercept / (1 - phi);
  const halfLifeDays = Math.log(2) / kappaPerDay;
  const eqDenom = Math.sqrt(1 - phi * phi);
  const eqSigma = eqDenom > 0 ? residualSigma / eqDenom : Number.NaN;

  if (!Number.isFinite(kappaPerDay) || !isPositiveFinite(halfLifeDays) || !isPositiveFinite(eqSigma)) {
    return {
      ...invalid,
      observationsUsed: nObs,
      excludedFutureCount,
      phi,
      intercept,
    };
  }

  return {
    status: 'OK',
    observationsUsed: nObs,
    excludedFutureCount,
    phi,
    intercept,
    kappaPerDay,
    muLog,
    halfLifeDays,
    residualSigma,
    eqSigma,
  };
}

/**
 * Repricing teórico individual por base `GFGC*` / `GFGV*` combinando valuación BSM exacta
 * y sensibilidad Delta-Gamma-Vega-Theta al proyectar `prevSpotArs -> projectedSpotArs`
 * con tasa local, DTE e IV propia de cada strike.
 */
export function computeIndividualOptionRepricingBsm(
  input: IndividualOptionBsmRepricingInput,
): PreOpenOptionRepricingItem {
  if (
    !isPositiveFinite(input.prevSpotArs) ||
    !isPositiveFinite(input.projectedSpotArs) ||
    !isPositiveFinite(input.strikeArs) ||
    !isPositiveFinite(input.timeToExpiryYears) ||
    !isPositiveFinite(input.iv) ||
    !Number.isFinite(input.rateCont) ||
    !isPositiveFinite(input.prevCloseArs)
  ) {
    return {
      tickerByma: input.tickerByma,
      prevCloseArs: input.prevCloseArs,
      fairOpenArs: Number.NaN,
      deltaRepricePct: Number.NaN,
    };
  }

  const q = input.dividendYield !== undefined && Number.isFinite(input.dividendYield)
    ? input.dividendYield
    : 0;
  const dSigma = input.deltaImpliedVol !== undefined && Number.isFinite(input.deltaImpliedVol)
    ? input.deltaImpliedVol
    : 0;
  const dtYears = input.dtYears !== undefined && Number.isFinite(input.dtYears) && input.dtYears >= 0
    ? input.dtYears
    : 0;
  const nextT = Math.max(1e-6, input.timeToExpiryYears - dtYears);
  const nextIv = Math.max(0.01, input.iv + dSigma);

  const bs0 = priceBsm({
    spot: input.prevSpotArs,
    strike: input.strikeArs,
    timeToExpiry: input.timeToExpiryYears,
    rate: input.rateCont,
    dividendYield: q,
    volatility: input.iv,
    contractType: input.contractType,
  });
  const bs1 = priceBsm({
    spot: input.projectedSpotArs,
    strike: input.strikeArs,
    timeToExpiry: nextT,
    rate: input.rateCont,
    dividendYield: q,
    volatility: nextIv,
    contractType: input.contractType,
  });
  const g0 = greeksBsm({
    spot: input.prevSpotArs,
    strike: input.strikeArs,
    timeToExpiry: input.timeToExpiryYears,
    rate: input.rateCont,
    dividendYield: q,
    volatility: input.iv,
    contractType: input.contractType,
  });

  if (!Number.isFinite(bs0) || !Number.isFinite(bs1)) {
    return {
      tickerByma: input.tickerByma,
      prevCloseArs: input.prevCloseArs,
      fairOpenArs: Number.NaN,
      deltaRepricePct: Number.NaN,
    };
  }

  const fairOpenArs = Math.max(0, input.prevCloseArs + (bs1 - bs0));
  const deltaRepricePct = ((fairOpenArs - input.prevCloseArs) / input.prevCloseArs) * 100;

  return {
    tickerByma: input.tickerByma,
    prevCloseArs: input.prevCloseArs,
    fairOpenArs,
    deltaRepricePct,
    bsmFairPrevArs: bs0,
    bsmFairProjectedArs: bs1,
    strikeArs: input.strikeArs,
    deltaAtClose: g0.delta,
    gammaAtClose: g0.gamma,
  };
}

/**
 * Calcula precio teórico de apertura pre-11:00 ART y repricing individual por base (`BSM` o `Taylor`).
 */
export function computeBymaFairOpenAndReprice(
  preOpen: PreOpenMacroPredictorInput,
  ou: OuCalibrationResult,
  adrMidUsd: number,
  adrBidUsd: number,
  adrAskUsd: number,
  options: readonly LocalOptionPreOpenInput[] = [],
): {
  readonly fairBymaOpenArs: number;
  readonly repricing: readonly PreOpenOptionRepricingItem[];
} {
  if (
    !isPositiveFinite(preOpen.bymaPrevClose24hArs) ||
    !isPositiveFinite(preOpen.adrPrev1700ArtUsd) ||
    !isPositiveFinite(adrMidUsd)
  ) {
    return { fairBymaOpenArs: Number.NaN, repricing: [] };
  }

  const adrExDiv = preOpen.adrExDividendUsd ?? 0;
  const bymaExDiv = preOpen.bymaExDividendArs ?? 0;
  if (!Number.isFinite(adrExDiv) || adrExDiv < 0 || !Number.isFinite(bymaExDiv) || bymaExDiv < 0) {
    return { fairBymaOpenArs: Number.NaN, repricing: [] };
  }

  const numeratorAdr = adrMidUsd + adrExDiv;
  if (!isPositiveFinite(numeratorAdr)) {
    return { fairBymaOpenArs: Number.NaN, repricing: [] };
  }
  const rAdrOvnAdj = Math.log(numeratorAdr / preOpen.adrPrev1700ArtUsd);

  const p = preOpen.params;
  const alpha0 = p?.alpha0 ?? 0;
  const alpha1 = p?.alpha1SpreadWeight ?? 40;
  const alpha2 = p?.alpha2VolumeWeight ?? 0.35;
  const betaSpy = p?.betaSpy ?? 1.25;
  const betaQqq = p?.betaQqq ?? 0.25;
  const gammaSpyCcl = p?.gammaSpyCcl ?? 0;
  const gammaVixCcl = p?.gammaVixCcl ?? 0;
  const ivSens = p?.ivSensitivityToAdrReturn ?? 0;

  const spreadRel =
    Number.isFinite(adrAskUsd) && Number.isFinite(adrBidUsd) && adrAskUsd >= adrBidUsd
      ? (adrAskUsd - adrBidUsd) / adrMidUsd
      : Number.NaN;
  const pmVol = preOpen.adrPreMarketVolume ?? 0;
  if (!Number.isFinite(spreadRel) || !Number.isFinite(pmVol) || pmVol < 0) {
    return { fairBymaOpenArs: Number.NaN, repricing: [] };
  }

  const logit = alpha0 + alpha1 * spreadRel - alpha2 * Math.log(1 + pmVol);
  const wPm = 1 / (1 + Math.exp(logit));

  const rSpy = preOpen.spyOvernightLogReturn ?? 0;
  const rQqq = preOpen.qqqOvernightLogReturn ?? 0;
  const dVix = preOpen.vixOvernightLogChange ?? 0;
  if (!Number.isFinite(rSpy) || !Number.isFinite(rQqq) || !Number.isFinite(dVix)) {
    return { fairBymaOpenArs: Number.NaN, repricing: [] };
  }

  const rAdrEff = wPm * rAdrOvnAdj + (1 - wPm) * (betaSpy * rSpy + betaQqq * rQqq);

  const ovnDays = preOpen.overnightDays ?? 1;
  if (!Number.isFinite(ovnDays) || ovnDays < 0) {
    return { fairBymaOpenArs: Number.NaN, repricing: [] };
  }

  let ouCclDrift = 0;
  if (
    preOpen.prevDaySpreadLog1700 !== undefined &&
    Number.isFinite(preOpen.prevDaySpreadLog1700) &&
    ou.status === 'OK'
  ) {
    ouCclDrift =
      -(1 - Math.exp(-ou.kappaPerDay * ovnDays)) * (preOpen.prevDaySpreadLog1700 - ou.muLog);
  }
  const dCclOvn = ouCclDrift + gammaSpyCcl * rSpy + gammaVixCcl * dVix;
  const fairBymaOpenArs = preOpen.bymaPrevClose24hArs * Math.exp(rAdrEff + dCclOvn) - bymaExDiv;

  if (!isPositiveFinite(fairBymaOpenArs)) {
    return { fairBymaOpenArs: Number.NaN, repricing: [] };
  }

  const dS = fairBymaOpenArs - preOpen.bymaPrevClose24hArs;
  const dtYears = ovnDays / DAYS_PER_YEAR;
  const repricing: PreOpenOptionRepricingItem[] = [];

  for (const opt of options) {
    const strikeArs = opt.strikeArs;
    const contractType = opt.contractType;
    const timeToExpiryYears = opt.timeToExpiryYears;
    const iv = opt.iv;

    if (
      strikeArs !== undefined &&
      contractType !== undefined &&
      timeToExpiryYears !== undefined &&
      iv !== undefined &&
      isPositiveFinite(strikeArs) &&
      isPositiveFinite(timeToExpiryYears) &&
      isPositiveFinite(iv) &&
      isPositiveFinite(opt.prevCloseArs)
    ) {
      const targetSpot =
        opt.projectedSpotArs !== undefined && isPositiveFinite(opt.projectedSpotArs)
          ? opt.projectedSpotArs
          : fairBymaOpenArs;
      const dSigma = opt.deltaImpliedVol ?? ivSens * rAdrOvnAdj;
      const rateCont = opt.rateCont !== undefined && Number.isFinite(opt.rateCont) ? opt.rateCont : 0;
      repricing.push(
        computeIndividualOptionRepricingBsm({
          tickerByma: opt.tickerByma,
          prevSpotArs: preOpen.bymaPrevClose24hArs,
          projectedSpotArs: targetSpot,
          strikeArs,
          contractType,
          timeToExpiryYears,
          iv,
          rateCont,
          prevCloseArs: opt.prevCloseArs,
          ...(opt.dividendYield !== undefined ? { dividendYield: opt.dividendYield } : {}),
          deltaImpliedVol: dSigma,
          dtYears,
        }),
      );
      continue;
    }

    if (
      !isPositiveFinite(opt.prevCloseArs) ||
      !Number.isFinite(opt.delta) ||
      !Number.isFinite(opt.gamma) ||
      !Number.isFinite(opt.vega) ||
      !Number.isFinite(opt.theta)
    ) {
      repricing.push({
        tickerByma: opt.tickerByma,
        prevCloseArs: opt.prevCloseArs,
        fairOpenArs: Number.NaN,
        deltaRepricePct: Number.NaN,
      });
      continue;
    }
    const dSigma = opt.deltaImpliedVol ?? ivSens * rAdrOvnAdj;
    const dV =
      opt.delta * dS +
      0.5 * opt.gamma * dS * dS +
      opt.vega * dSigma +
      opt.theta * dtYears;
    const fairOpenArs = opt.prevCloseArs + dV;
    const deltaRepricePct = (dV / opt.prevCloseArs) * 100;
    repricing.push({
      tickerByma: opt.tickerByma,
      prevCloseArs: opt.prevCloseArs,
      fairOpenArs,
      deltaRepricePct,
    });
  }

  return { fairBymaOpenArs, repricing };
}

/**
 * Evaluador principal del Motor 1: Paridad Dual-Listing, Benchmark Soberano, OU causal y Gap Predictor.
 */
export function evaluateParityGap(input: ParityGapInput): ParityGapOutput {
  if (!isValidUtcSec(input.asOfUtcSec)) {
    throw new Error(`asOfUtcSec must be valid integer UTC seconds (got ${String(input.asOfUtcSec)})`);
  }

  const session = classifySessionRegime(
    input.asOfUtcSec,
    input.arHolidays ?? [],
    input.usHolidays ?? [],
  );
  const arHolidaySet = new Set(input.arHolidays ?? []);
  const usHolidaySet = new Set(input.usHolidays ?? []);

  const deltaAr1Days =
    input.deltaAr1Days ?? computeSettlementCalendarDays(session.arDateKey, 1, arHolidaySet);
  const deltaUs1Days =
    input.deltaUs1Days ?? computeSettlementCalendarDays(session.nyDateKey, 1, usHolidaySet);

  const massiveStaleness = isValidUtcSec(input.massiveTimestampSec)
    ? input.asOfUtcSec - input.massiveTimestampSec
    : Number.NaN;
  const data912Staleness = isValidUtcSec(input.data912TimestampSec)
    ? input.asOfUtcSec - input.data912TimestampSec
    : Number.NaN;
  const syncSkew =
    isValidUtcSec(input.massiveTimestampSec) && isValidUtcSec(input.data912TimestampSec)
      ? Math.abs(input.data912TimestampSec - input.massiveTimestampSec)
      : Number.NaN;

  const maxD912 = input.maxData912StalenessSec ?? DEFAULT_MAX_STALENESS_SEC;
  const maxMassive = input.maxMassiveStalenessSec ?? DEFAULT_MAX_STALENESS_SEC;
  const maxSkew = input.maxSyncSkewSec ?? DEFAULT_MAX_STALENESS_SEC;

  const isEodMode = input.marketMode === 'EOD_CIERRE';
  const staleLocked =
    !isEodMode &&
    (!Number.isFinite(data912Staleness) ||
      !Number.isFinite(massiveStaleness) ||
      !Number.isFinite(syncSkew) ||
      data912Staleness < 0 ||
      massiveStaleness < 0 ||
      data912Staleness > maxD912 ||
      massiveStaleness > maxMassive ||
      syncSkew > maxSkew);

  const byma24hMid = quoteMid(input.byma24h);
  const bymaCiMid = input.bymaCi !== undefined ? quoteMid(input.bymaCi) : Number.NaN;
  const adrMid = quoteMid(input.adr);
  const cclTemporal = evaluateCclContemporaneity({
    byma: { price: byma24hMid, timeSec: input.data912TimestampSec },
    adr: { price: adrMid, timeSec: input.massiveTimestampSec },
    evaluationNowSec: input.asOfUtcSec,
    marketRegime: session.sessionRegime,
    isEodMode,
    ...(input.maxSyncSkewSec === undefined ? {} : { maxAllowedSkewSec: input.maxSyncSkewSec }),
    ...(input.maxData912StalenessSec === undefined && input.maxMassiveStalenessSec === undefined
      ? {} : { maxLegAgeSec: Math.min(input.maxData912StalenessSec ?? Infinity, input.maxMassiveStalenessSec ?? Infinity) }),
  });

  let cclGgal24h = Number.NaN;
  let cclGgalCiTo24h = Number.NaN;
  if (
    isPositiveFinite(byma24hMid) &&
    isPositiveFinite(adrMid) &&
    Number.isFinite(input.sofrRateAnnual) &&
    Number.isFinite(deltaAr1Days) &&
    Number.isFinite(deltaUs1Days)
  ) {
    const deltaDiff = deltaAr1Days - deltaUs1Days;
    const sofrAdj = Math.exp(input.sofrRateAnnual * (deltaDiff / DAYS_PER_YEAR));
    cclGgal24h = (GGAL_ADR_RATIO * byma24hMid) / (adrMid * sofrAdj);

    if (isPositiveFinite(bymaCiMid) && Number.isFinite(input.caucionArsRateTna)) {
      const ciCarryFactor = 1 + input.caucionArsRateTna * (deltaAr1Days / DAYS_PER_YEAR);
      if (ciCarryFactor > 0) {
        cclGgalCiTo24h = (GGAL_ADR_RATIO * bymaCiMid * ciCarryFactor) / (adrMid * sofrAdj);
      }
    }
  }

  let cclAl30_24h = Number.NaN;
  let cclGd30_24h = Number.NaN;
  const bondEntries: {
    readonly ccl: number;
    readonly totalSpreadRel: number;
    readonly arsSpreadRel: number;
    readonly usdCSpreadRel: number;
    readonly volume: number;
  }[] = [];

  for (const bond of input.sovereignBonds) {
    const arsMid = quoteMid(bond.ars24h);
    const usdCMid = quoteMid(bond.usdC24h);
    const arsSpread = quoteRelativeSpread(bond.ars24h);
    const usdCSpread = quoteRelativeSpread(bond.usdC24h);
    const arsBase = bond.arsNominalBase ?? 100;
    const usdCBase = bond.usdCNominalBase ?? 100;
    if (
      !isPositiveFinite(arsMid) ||
      !isPositiveFinite(usdCMid) ||
      !Number.isFinite(arsSpread) ||
      !Number.isFinite(usdCSpread) ||
      !isPositiveFinite(arsBase) ||
      !isPositiveFinite(usdCBase)
    ) {
      continue;
    }
    const cclBond = (arsMid / arsBase) / (usdCMid / usdCBase);
    const upper = bond.ticker.trim().toUpperCase();
    if (upper === 'AL30') {
      cclAl30_24h = cclBond;
    } else if (upper === 'GD30') {
      cclGd30_24h = cclBond;
    }
    bondEntries.push({
      ccl: cclBond,
      totalSpreadRel: arsSpread + usdCSpread,
      arsSpreadRel: arsSpread,
      usdCSpreadRel: usdCSpread,
      volume: bond.nominalVolumeArs ?? Number.NaN,
    });
  }

  let cclSovereignBenchmark = Number.NaN;
  let avgBondArsSpread = Number.NaN;
  let avgBondUsdCSpread = Number.NaN;

  if (bondEntries.length > 0) {
    const useVol =
      input.bondWeighting === 'VOLUME' &&
      bondEntries.every((b) => isPositiveFinite(b.volume));
    let weightSum = 0;
    let weightedCcl = 0;
    let weightedArsSpread = 0;
    let weightedUsdCSpread = 0;

    for (const entry of bondEntries) {
      let w: number;
      if (useVol) {
        w = entry.volume;
      } else {
        const s = entry.totalSpreadRel;
        w = s > 0 ? 1 / (s * s) : 1;
      }
      weightSum += w;
      weightedCcl += w * entry.ccl;
      weightedArsSpread += w * entry.arsSpreadRel;
      weightedUsdCSpread += w * entry.usdCSpreadRel;
    }

    if (isPositiveFinite(weightSum)) {
      cclSovereignBenchmark = weightedCcl / weightSum;
      avgBondArsSpread = weightedArsSpread / weightSum;
      avgBondUsdCSpread = weightedUsdCSpread / weightSum;
    }
  }

  const ouCalibration = calibrateCausalOuAr1(
    input.spreadHistory,
    input.asOfUtcSec,
    input.ouStepDays ?? DEFAULT_OU_STEP_DAYS,
    input.minOuObservations ?? DEFAULT_MIN_OU_OBS,
  );

  let spreadLog = Number.NaN;
  let spreadLogBps = Number.NaN;
  let ouMeanBps = Number.NaN;
  let ouEqSigmaBps = Number.NaN;
  let zScore = Number.NaN;
  let netEdgeAfterCostsBps = Number.NaN;
  let closeProbability5d = Number.NaN;

  if (isPositiveFinite(cclGgal24h) && isPositiveFinite(cclSovereignBenchmark)) {
    spreadLog = Math.log(cclGgal24h) - Math.log(cclSovereignBenchmark);
    spreadLogBps = spreadLog * 10_000;
  }

  const bymaSpreadRel = quoteRelativeSpread(input.byma24h);
  const adrSpreadRel = quoteRelativeSpread(input.adr);
  const feeSchedule = input.bymaFeeSchedule ?? BYMA_FEE_SCHEDULE;
  const usSchedule = input.usFeeSchedule ?? DEFAULT_US_FEE_SCHEDULE;
  const notionalArs = input.notionalArsForFees ?? DEFAULT_NOTIONAL_FOR_FEES;
  const cBymaEq = computeBymaFeeRate(notionalArs, 'EQUITY', feeSchedule);
  const cBymaBond = computeBymaFeeRate(notionalArs, 'SOVEREIGN_BOND', feeSchedule);
  const cUsEqSell = isPositiveFinite(adrMid)
    ? computeUsEquityFeeRate(input.asOfUtcSec, adrMid, 'SELL', usSchedule)
    : Number.NaN;
  const slip = input.slippageLogCost ?? 0;

  if (ouCalibration.status === 'OK' && Number.isFinite(spreadLog)) {
    ouMeanBps = ouCalibration.muLog * 10_000;
    ouEqSigmaBps = ouCalibration.eqSigma * 10_000;
    zScore = (spreadLog - ouCalibration.muLog) / ouCalibration.eqSigma;

    if (
      Number.isFinite(bymaSpreadRel) &&
      Number.isFinite(adrSpreadRel) &&
      Number.isFinite(avgBondArsSpread) &&
      Number.isFinite(avgBondUsdCSpread) &&
      Number.isFinite(cBymaEq) &&
      Number.isFinite(cBymaBond) &&
      Number.isFinite(cUsEqSell) &&
      Number.isFinite(slip)
    ) {
      // Costo total de 4 patas: GGAL 24hs, ADR, Bono ARS, Bono USD-C (Sección 2.1)
      const totalFrictionLog =
        0.5 * bymaSpreadRel +
        0.5 * adrSpreadRel +
        0.5 * avgBondArsSpread +
        0.5 * avgBondUsdCSpread +
        cBymaEq +
        2 * cBymaBond +
        cUsEqSell +
        slip;
      netEdgeAfterCostsBps = (Math.abs(spreadLog - ouCalibration.muLog) - totalFrictionLog) * 10_000;
    }

    const horizonDays = input.closeHorizonDays ?? DEFAULT_CLOSE_HORIZON_DAYS;
    const thetaExit = input.exitBandHalfWidthLog ?? 0.5 * ouCalibration.eqSigma;
    if (isPositiveFinite(horizonDays) && isPositiveFinite(thetaExit)) {
      const expDecay = Math.exp(-ouCalibration.kappaPerDay * horizonDays);
      const mH = ouCalibration.muLog + (spreadLog - ouCalibration.muLog) * expDecay;
      const vH =
        ouCalibration.eqSigma * Math.sqrt(Math.max(0, 1 - Math.exp(-2 * ouCalibration.kappaPerDay * horizonDays)));
      if (isPositiveFinite(vH)) {
        const upperZ = (ouCalibration.muLog + thetaExit - mH) / vH;
        const lowerZ = (ouCalibration.muLog - thetaExit - mH) / vH;
        closeProbability5d = normCdf(upperZ) - normCdf(lowerZ);
      }
    }
  }

  let fairAdrUsd = Number.NaN;
  if (
    isPositiveFinite(byma24hMid) &&
    isPositiveFinite(cclSovereignBenchmark) &&
    Number.isFinite(input.sofrRateAnnual) &&
    Number.isFinite(deltaAr1Days) &&
    Number.isFinite(deltaUs1Days)
  ) {
    const sofrAdj = Math.exp(input.sofrRateAnnual * ((deltaAr1Days - deltaUs1Days) / DAYS_PER_YEAR));
    fairAdrUsd = (GGAL_ADR_RATIO * byma24hMid) / (cclSovereignBenchmark * sofrAdj);
  }

  let fairBymaOpenArs = Number.NaN;
  let preOpenOptionRepricing: readonly PreOpenOptionRepricingItem[] = [];
  if (input.preOpen !== undefined) {
    const openRes = computeBymaFairOpenAndReprice(
      input.preOpen,
      ouCalibration,
      adrMid,
      input.adr.bid,
      input.adr.ask,
      input.preOpenOptions ?? [],
    );
    fairBymaOpenArs = openRes.fairBymaOpenArs;
    preOpenOptionRepricing = openRes.repricing;
  } else if (
    isPositiveFinite(adrMid) &&
    isPositiveFinite(cclSovereignBenchmark) &&
    Number.isFinite(input.sofrRateAnnual) &&
    Number.isFinite(deltaAr1Days) &&
    Number.isFinite(deltaUs1Days)
  ) {
    const sofrAdj = Math.exp(input.sofrRateAnnual * ((deltaAr1Days - deltaUs1Days) / DAYS_PER_YEAR));
    fairBymaOpenArs = (adrMid * sofrAdj * cclSovereignBenchmark) / GGAL_ADR_RATIO;
  }

  const refPrevClose = input.bymaPrevClose24hArs ?? input.preOpen?.bymaPrevClose24hArs;
  const gapPctVsPrevClose =
    refPrevClose !== undefined && isPositiveFinite(refPrevClose) && isPositiveFinite(fairBymaOpenArs)
      ? ((fairBymaOpenArs - refPrevClose) / refPrevClose) * 100
      : Number.NaN;

  const zThreshold = input.zEntryThreshold ?? DEFAULT_Z_THRESHOLD;
  const minEdgeBps = input.minNetEdgeBps ?? DEFAULT_MIN_EDGE_BPS;
  const maxHalfLife = input.maxHalfLifeDays ?? DEFAULT_MAX_HALF_LIFE_DAYS;

  let signal: ParityGapSignal;
  if (staleLocked) {
    signal = 'STALE_DATA_LOCK';
  } else if (
    ouCalibration.status === 'OK' &&
    Number.isFinite(zScore) &&
    Number.isFinite(netEdgeAfterCostsBps) &&
    Math.abs(zScore) >= zThreshold &&
    netEdgeAfterCostsBps > minEdgeBps &&
    ouCalibration.halfLifeDays <= maxHalfLife
  ) {
    signal = zScore > 0 ? 'SHORT_BYMA_LONG_ADR' : 'LONG_BYMA_SHORT_ADR';
  } else {
    signal = 'NEUTRAL';
  }

  return {
    timestampUtc: formatIsoUtcFromSec(input.asOfUtcSec),
    asOfUtcSec: input.asOfUtcSec,
    sessionRegime: session.sessionRegime,
    dstMode: session.dstMode,
    deltaAr1Days,
    deltaUs1Days,
    feedStalenessSec: {
      massive: massiveStaleness,
      data912: data912Staleness,
    },
    spot: {
      byma24hArs: byma24hMid,
      bymaCiArs: bymaCiMid,
      adrMidUsd: adrMid,
      fairBymaOpenArs,
      fairAdrUsd,
      gapPctVsPrevClose,
    },
    ccl: {
      cclGgal24h,
      cclGgalCiTo24h,
      cclAl30_24h,
      cclGd30_24h,
      cclSovereignBenchmark,
      spreadLogBps,
      ouMeanBps,
      ouHalfLifeDays: ouCalibration.halfLifeDays,
      ouEqSigmaBps,
      zScore,
      netEdgeAfterCostsBps,
      closeProbability5d,
    },
    cclTemporal: { ...cclTemporal, value: cclTemporal.cclQuality === 'MISSING_LEG' ? Number.NaN : cclGgal24h },
    ouCalibration,
    signal,
    preOpenOptionRepricing,
  };
}
