import { MAX_TIME_SECONDS } from '../sessions.js';
import {
  gammaAmericanFiniteDiffOrAnalytical,
  greeksAmericanFiniteDiffOrAnalytical,
  solveImpliedVolAmerican,
} from './american.js';
import {
  greeksBlack76,
  greeksBsm,
  SECONDS_PER_YEAR_365,
  timeToExpiryYears,
} from './blackScholes.js';
import { impliedDividendYieldFromForward } from './forward.js';
import { solveImpliedVolBlack76, solveImpliedVolBsm } from './impliedVol.js';
import type {
  ImpliedVolSolverOptions,
  OptionContractType,
  OptionGreeksResult,
} from './types.js';

const DEFAULT_GAMMA_FLIP_HALF_WIDTH = 0.25;
const DEFAULT_GAMMA_FLIP_GRID_STEPS = 200;
const DEFAULT_GAMMA_FLIP_TOLERANCE_REL = 1e-12;
const DEFAULT_GAMMA_FLIP_MAX_ITERATIONS = 100;
const DEFAULT_ATM_STRADDLE_MAX_REL_DIST = 0.05;
const ONE_PERCENT = 0.01;
const ATM_REL_TOLERANCE = 1e-9;
const SECONDS_PER_DAY = 86_400;

export type ExposureModel = 'bsm' | 'black76' | 'american';
export type WallCriterion = 'gex' | 'oi';
export type WallScope = 'all' | 'otm';
export type GammaFlipMultiRootPolicy = 'nan' | 'nearestSpot';
export type GammaFlipStatus =
  | 'unique'
  | 'no_crossing'
  | 'multiple_crossings'
  | 'indeterminate';
export type IvResolutionMode = 'ivThenMidPrice' | 'ivOnly' | 'midPriceOnly';
export type StraddlePriceSource = 'marketOrModel' | 'marketOnly';
export type VannaRegime =
  | 'SUPPORTIVE_ON_IV_DROP'
  | 'PRESSURE_ON_IV_DROP'
  | 'NEUTRAL';

export type ContractSkipReason =
  | 'invalidContractType'
  | 'invalidStrike'
  | 'invalidSharesPerContract'
  | 'invalidExpiry'
  | 'expired'
  | 'invalidUnderlier'
  | 'invalidRates'
  | 'invalidIv'
  | 'ivSolveFailed'
  | 'nonFiniteGreeks';

export interface DealerSignConfig {
  readonly call: number;
  readonly put: number;
}

export interface ExposureContractInput {
  readonly contractType: OptionContractType;
  readonly strike: number;
  readonly expiryUtcSec: number;
  readonly openInterest: number;
  readonly volume?: number;
  readonly sharesPerContract: number;
  readonly spot?: number;
  readonly forward?: number;
  readonly rate?: number;
  readonly dividendYield?: number;
  readonly iv?: number | null;
  readonly midPrice?: number;
  readonly bid?: number;
  readonly ask?: number;
}

export interface ExposureMarketInputs {
  readonly spot: number;
  readonly nowUtcSec: number;
  readonly rate: number;
  readonly dividendYield?: number;
  readonly forward?: number;
}

export interface ExposureOptions {
  readonly model?: ExposureModel;
  readonly dealerPositionSign?: DealerSignConfig;
  readonly wallCriterion?: WallCriterion;
  readonly wallScope?: WallScope;
  readonly gammaFlipHalfWidth?: number;
  readonly gammaFlipGridSteps?: number;
  readonly gammaFlipToleranceRel?: number;
  readonly gammaFlipMaxIterations?: number;
  readonly gammaFlipMultiRootPolicy?: GammaFlipMultiRootPolicy;
  readonly secondsPerYear?: number;
  readonly ivResolutionMode?: IvResolutionMode;
  readonly ivSolverOptions?: ImpliedVolSolverOptions;
  readonly expectedMoveExpirySec?: number;
  readonly expectedMoveIvAtmOverride?: number;
  readonly atmStraddleMaxRelDist?: number;
  readonly straddlePriceSource?: StraddlePriceSource;
}

export interface ContractExposureResult {
  readonly isActive: boolean;
  readonly isUsable: boolean;
  readonly skipReason: ContractSkipReason | null;
  readonly contractType: OptionContractType | null;
  readonly strike: number;
  readonly expiryUtcSec: number;
  readonly timeToExpiry: number;
  readonly openInterest: number;
  readonly volume: number;
  readonly sharesPerContract: number;
  readonly sign: number;
  readonly underlier: number;
  readonly rate: number;
  readonly dividendYield: number;
  readonly iv: number;
  readonly greeks: OptionGreeksResult;
  readonly dollarGex: number;
  readonly spotShareGamma: number;
  readonly dex: number;
  readonly vannaExposure: number;
  readonly charmExposure: number;
}

export interface StrikeExposure {
  readonly strike: number;
  readonly callOpenInterest: number;
  readonly putOpenInterest: number;
  readonly totalOpenInterest: number;
  readonly callVolume: number;
  readonly putVolume: number;
  readonly totalVolume: number;
  readonly callGex: number;
  readonly putGex: number;
  readonly netGex: number;
  readonly absGex: number;
  readonly callSpotGamma: number;
  readonly putSpotGamma: number;
  readonly netSpotGamma: number;
  readonly callDex: number;
  readonly putDex: number;
  readonly netDex: number;
  readonly callVannaExposure: number;
  readonly putVannaExposure: number;
  readonly netVannaExposure: number;
  readonly callCharmExposure: number;
  readonly putCharmExposure: number;
  readonly netCharmExposure: number;
}

export interface ExpectedMoveResult {
  readonly expiryUtcSec: number;
  readonly timeToExpiry: number;
  readonly ivAtm: number;
  readonly formulaMove: number;
  readonly formulaMovePct: number;
  readonly straddleStrike: number;
  readonly straddleCallPrice: number;
  readonly straddlePutPrice: number;
  readonly straddleMove: number;
  readonly straddleMovePct: number;
}

export interface SkippedExposureContract {
  readonly index: number;
  readonly strike: number;
  readonly expiryUtcSec: number;
  readonly contractType: string;
  readonly openInterest: number;
  readonly reason: ContractSkipReason;
}

export interface ExposureDataQuality {
  readonly inputContracts: number;
  readonly activeContracts: number;
  readonly usableContracts: number;
  readonly zeroOiContracts: number;
  readonly invalidOiContracts: number;
  readonly skippedContracts: number;
  readonly totalActiveOpenInterest: number;
  readonly usableOpenInterest: number;
  readonly skippedOpenInterest: number;
  readonly skippedOiShare: number;
  readonly countsByReason: Readonly<Record<ContractSkipReason, number>>;
  readonly skippedDetails: readonly SkippedExposureContract[];
}

export interface GammaFlipReport {
  readonly gammaFlipSpot: number;
  readonly status: GammaFlipStatus;
  readonly candidates: readonly number[];
}

export interface WallLevelsResult {
  readonly callWallStrike: number;
  readonly putWallStrike: number;
}

export interface DealerExposureUnits {
  readonly dollarGex: 'USD_PER_1PCT_SPOT_MOVE';
  readonly spotShareGamma: 'USD_DELTA_PER_1_DOLLAR_SPOT_MOVE';
  readonly dex: 'USD_NOTIONAL';
  readonly vannaExposure: 'USD_DELTA_PER_1PCT_IV_MOVE';
  readonly charmExposure: 'USD_DELTA_PER_DAY';
}

export interface DealerExposureResult {
  readonly spot: number;
  readonly nowUtcSec: number;
  readonly model: ExposureModel;
  readonly dealerPositionSign: DealerSignConfig;
  readonly units: DealerExposureUnits;
  readonly callGex: number;
  readonly putGex: number;
  readonly netGex: number;
  readonly absGex: number;
  readonly netSpotGamma: number;
  readonly callDex: number;
  readonly putDex: number;
  readonly netDex: number;
  readonly callVannaExposure: number;
  readonly putVannaExposure: number;
  readonly netVannaExposure: number;
  readonly callCharmExposure: number;
  readonly putCharmExposure: number;
  readonly netCharmExposure: number;
  /** Régimen de flujo de re-hedging de dealers ante una compresión de IV (`Δσ < 0`). */
  readonly vannaRegime: VannaRegime;
  /** Strike con máximo |Net Charm Exposure| (degradación honesta a `NaN` sin datos). */
  readonly charmPinStrike: number;
  readonly callWallStrike: number;
  readonly putWallStrike: number;
  readonly gammaFlipSpot: number;
  readonly gammaFlipStatus: GammaFlipStatus;
  readonly gammaFlipCandidates: readonly number[];
  readonly expectedMove: ExpectedMoveResult;
  readonly expectedMoveByExpiry: readonly ExpectedMoveResult[];
  readonly byStrike: readonly StrikeExposure[];
  readonly quality: ExposureDataQuality;
}

interface NormalizedExposureOptions {
  readonly model: ExposureModel;
  readonly dealerPositionSign: DealerSignConfig;
  readonly wallCriterion: WallCriterion;
  readonly wallScope: WallScope;
  readonly gammaFlipHalfWidth: number;
  readonly gammaFlipGridSteps: number;
  readonly gammaFlipToleranceRel: number;
  readonly gammaFlipMaxIterations: number;
  readonly gammaFlipMultiRootPolicy: GammaFlipMultiRootPolicy;
  readonly secondsPerYear: number;
  readonly daysPerYear: number;
  readonly ivResolutionMode: IvResolutionMode;
  readonly ivSolverOptions: ImpliedVolSolverOptions | undefined;
  readonly expectedMoveExpirySec: number;
  readonly expectedMoveIvAtmOverride: number;
  readonly atmStraddleMaxRelDist: number;
  readonly straddlePriceSource: StraddlePriceSource;
}

interface PreparedContract {
  readonly index: number;
  readonly contractType: OptionContractType;
  readonly strike: number;
  readonly expiryUtcSec: number;
  readonly timeToExpiry: number;
  readonly openInterest: number;
  readonly volume: number;
  readonly sharesPerContract: number;
  readonly sign: number;
  readonly underlier: number;
  readonly rate: number;
  readonly dividendYield: number;
  readonly iv: number;
  readonly greeks: OptionGreeksResult;
  readonly marketMidPrice: number;
}

const EXPOSURE_UNITS: DealerExposureUnits = Object.freeze({
  dollarGex: 'USD_PER_1PCT_SPOT_MOVE',
  spotShareGamma: 'USD_DELTA_PER_1_DOLLAR_SPOT_MOVE',
  dex: 'USD_NOTIONAL',
  vannaExposure: 'USD_DELTA_PER_1PCT_IV_MOVE',
  charmExposure: 'USD_DELTA_PER_DAY',
});

const NAN_GREEKS: OptionGreeksResult = Object.freeze({
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
});

function isRuntimeArray(value: unknown): boolean {
  return Array.isArray(value);
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function createEmptySkipCounts(): Record<ContractSkipReason, number> {
  return {
    invalidContractType: 0,
    invalidStrike: 0,
    invalidSharesPerContract: 0,
    invalidExpiry: 0,
    expired: 0,
    invalidUnderlier: 0,
    invalidRates: 0,
    invalidIv: 0,
    ivSolveFailed: 0,
    nonFiniteGreeks: 0,
  };
}

function nanExpectedMove(expiryUtcSec = Number.NaN, timeToExpiry = Number.NaN): ExpectedMoveResult {
  return {
    expiryUtcSec,
    timeToExpiry,
    ivAtm: Number.NaN,
    formulaMove: Number.NaN,
    formulaMovePct: Number.NaN,
    straddleStrike: Number.NaN,
    straddleCallPrice: Number.NaN,
    straddlePutPrice: Number.NaN,
    straddleMove: Number.NaN,
    straddleMovePct: Number.NaN,
  };
}

function normalizeOptions(options?: ExposureOptions): NormalizedExposureOptions | null {
  const model = options?.model ?? 'bsm';
  const rawModel: string = model;
  if (rawModel !== 'bsm' && rawModel !== 'black76' && rawModel !== 'american') {
    return null;
  }

  const callSign = options?.dealerPositionSign?.call ?? 1;
  const putSign = options?.dealerPositionSign?.put ?? -1;
  if (!Number.isFinite(callSign) || !Number.isFinite(putSign)) {
    return null;
  }

  const wallCriterion = options?.wallCriterion ?? 'gex';
  const rawCriterion: string = wallCriterion;
  if (rawCriterion !== 'gex' && rawCriterion !== 'oi') {
    return null;
  }

  const wallScope = options?.wallScope ?? 'all';
  const rawScope: string = wallScope;
  if (rawScope !== 'all' && rawScope !== 'otm') {
    return null;
  }

  const gammaFlipHalfWidth =
    options?.gammaFlipHalfWidth ?? DEFAULT_GAMMA_FLIP_HALF_WIDTH;
  const gammaFlipGridSteps =
    options?.gammaFlipGridSteps ?? DEFAULT_GAMMA_FLIP_GRID_STEPS;
  const gammaFlipToleranceRel =
    options?.gammaFlipToleranceRel ?? DEFAULT_GAMMA_FLIP_TOLERANCE_REL;
  const gammaFlipMaxIterations =
    options?.gammaFlipMaxIterations ?? DEFAULT_GAMMA_FLIP_MAX_ITERATIONS;

  if (
    !isPositiveFinite(gammaFlipHalfWidth) ||
    gammaFlipHalfWidth >= 1 ||
    !Number.isInteger(gammaFlipGridSteps) ||
    gammaFlipGridSteps < 2 ||
    !isPositiveFinite(gammaFlipToleranceRel) ||
    !Number.isInteger(gammaFlipMaxIterations) ||
    gammaFlipMaxIterations < 1
  ) {
    return null;
  }

  const gammaFlipMultiRootPolicy = options?.gammaFlipMultiRootPolicy ?? 'nan';
  const rawPolicy: string = gammaFlipMultiRootPolicy;
  if (rawPolicy !== 'nan' && rawPolicy !== 'nearestSpot') {
    return null;
  }

  const secondsPerYear = options?.secondsPerYear ?? SECONDS_PER_YEAR_365;
  if (!isPositiveFinite(secondsPerYear)) {
    return null;
  }
  const daysPerYear = secondsPerYear / SECONDS_PER_DAY;
  if (!isPositiveFinite(daysPerYear)) {
    return null;
  }

  const ivResolutionMode = options?.ivResolutionMode ?? 'ivThenMidPrice';
  const rawIvMode: string = ivResolutionMode;
  if (
    rawIvMode !== 'ivThenMidPrice' &&
    rawIvMode !== 'ivOnly' &&
    rawIvMode !== 'midPriceOnly'
  ) {
    return null;
  }

  const expectedMoveExpirySec = options?.expectedMoveExpirySec ?? Number.NaN;
  if (
    options?.expectedMoveExpirySec !== undefined &&
    !Number.isFinite(expectedMoveExpirySec)
  ) {
    return null;
  }

  const expectedMoveIvAtmOverride = options?.expectedMoveIvAtmOverride ?? Number.NaN;
  if (
    options?.expectedMoveIvAtmOverride !== undefined &&
    !isPositiveFinite(expectedMoveIvAtmOverride)
  ) {
    return null;
  }

  const atmStraddleMaxRelDist =
    options?.atmStraddleMaxRelDist ?? DEFAULT_ATM_STRADDLE_MAX_REL_DIST;
  if (!isPositiveFinite(atmStraddleMaxRelDist)) {
    return null;
  }

  const straddlePriceSource = options?.straddlePriceSource ?? 'marketOrModel';
  const rawPriceSrc: string = straddlePriceSource;
  if (rawPriceSrc !== 'marketOrModel' && rawPriceSrc !== 'marketOnly') {
    return null;
  }

  return {
    model,
    dealerPositionSign: { call: callSign, put: putSign },
    wallCriterion,
    wallScope,
    gammaFlipHalfWidth,
    gammaFlipGridSteps,
    gammaFlipToleranceRel,
    gammaFlipMaxIterations,
    gammaFlipMultiRootPolicy,
    secondsPerYear,
    daysPerYear,
    ivResolutionMode,
    ivSolverOptions: options?.ivSolverOptions,
    expectedMoveExpirySec,
    expectedMoveIvAtmOverride,
    atmStraddleMaxRelDist,
    straddlePriceSource,
  };
}

function isValidMarketInputs(market: ExposureMarketInputs): boolean {
  return (
    isPositiveFinite(market.spot) &&
    Number.isFinite(market.nowUtcSec) &&
    Math.abs(market.nowUtcSec) <= MAX_TIME_SECONDS &&
    Number.isFinite(market.rate) &&
    (market.dividendYield === undefined || Number.isFinite(market.dividendYield)) &&
    (market.forward === undefined || isPositiveFinite(market.forward))
  );
}

function resolveContractMarketMid(contract: ExposureContractInput): {
  readonly provided: boolean;
  readonly price: number;
} {
  if (contract.midPrice !== undefined) {
    return {
      provided: true,
      price: isPositiveFinite(contract.midPrice) ? contract.midPrice : Number.NaN,
    };
  }
  if (contract.bid !== undefined || contract.ask !== undefined) {
    const bid = contract.bid ?? Number.NaN;
    const ask = contract.ask ?? Number.NaN;
    if (isNonNegativeFinite(bid) && isPositiveFinite(ask) && ask >= bid) {
      const mid = 0.5 * (bid + ask);
      return {
        provided: true,
        price: isPositiveFinite(mid) ? mid : Number.NaN,
      };
    }
    return { provided: true, price: Number.NaN };
  }
  return { provided: false, price: Number.NaN };
}

function resolveContractIv(
  contract: ExposureContractInput,
  model: ExposureModel,
  underlier: number,
  timeToExpiry: number,
  rate: number,
  dividendYield: number,
  contractType: OptionContractType,
  marketMid: { readonly provided: boolean; readonly price: number },
  ivResolutionMode: IvResolutionMode,
  ivSolverOptions: ImpliedVolSolverOptions | undefined,
): { readonly iv: number; readonly errorReason: ContractSkipReason | null } {
  if (ivResolutionMode !== 'midPriceOnly') {
    if (
      contract.iv !== undefined &&
      contract.iv !== null &&
      Number.isFinite(contract.iv)
    ) {
      if (contract.iv > 0) {
        return { iv: contract.iv, errorReason: null };
      }
      return { iv: Number.NaN, errorReason: 'invalidIv' };
    }
    if (ivResolutionMode === 'ivOnly') {
      return { iv: Number.NaN, errorReason: 'invalidIv' };
    }
  }

  if (!marketMid.provided) {
    return { iv: Number.NaN, errorReason: 'invalidIv' };
  }
  if (!isPositiveFinite(marketMid.price)) {
    return { iv: Number.NaN, errorReason: 'ivSolveFailed' };
  }

  let solvedIv: number;
  if (model === 'black76') {
    solvedIv = solveImpliedVolBlack76({
      forward: underlier,
      strike: contract.strike,
      timeToExpiry,
      rate,
      contractType,
      price: marketMid.price,
      ...(ivSolverOptions !== undefined ? { options: ivSolverOptions } : {}),
    });
  } else if (model === 'american') {
    solvedIv = solveImpliedVolAmerican({
      spot: underlier,
      strike: contract.strike,
      timeToExpiry,
      rate,
      dividendYield,
      contractType,
      marketPrice: marketMid.price,
      ...(ivSolverOptions?.minVolatility !== undefined
        ? { minVolatility: ivSolverOptions.minVolatility }
        : {}),
      ...(ivSolverOptions?.maxVolatility !== undefined
        ? { maxVolatility: ivSolverOptions.maxVolatility }
        : {}),
      ...(ivSolverOptions?.tolerance !== undefined
        ? { tolerance: ivSolverOptions.tolerance }
        : {}),
      ...(ivSolverOptions?.maxIterations !== undefined
        ? { maxIterations: ivSolverOptions.maxIterations }
        : {}),
    });
  } else {
    solvedIv = solveImpliedVolBsm({
      spot: underlier,
      strike: contract.strike,
      timeToExpiry,
      rate,
      dividendYield,
      contractType,
      price: marketMid.price,
      ...(ivSolverOptions !== undefined ? { options: ivSolverOptions } : {}),
    });
  }

  if (!isPositiveFinite(solvedIv)) {
    return { iv: Number.NaN, errorReason: 'ivSolveFailed' };
  }
  return { iv: solvedIv, errorReason: null };
}

function evaluateModelGreeks(
  model: ExposureModel,
  underlier: number,
  strike: number,
  timeToExpiry: number,
  rate: number,
  dividendYield: number,
  iv: number,
  contractType: OptionContractType,
): OptionGreeksResult {
  if (model === 'black76') {
    return greeksBlack76({
      forward: underlier,
      strike,
      timeToExpiry,
      rate,
      volatility: iv,
      contractType,
    });
  }
  if (model === 'american') {
    return greeksAmericanFiniteDiffOrAnalytical({
      spot: underlier,
      strike,
      timeToExpiry,
      rate,
      dividendYield,
      volatility: iv,
      contractType,
    });
  }
  return greeksBsm({
    spot: underlier,
    strike,
    timeToExpiry,
    rate,
    dividendYield,
    volatility: iv,
    contractType,
  });
}

function evaluateModelGamma(
  model: ExposureModel,
  underlier: number,
  strike: number,
  timeToExpiry: number,
  rate: number,
  dividendYield: number,
  iv: number,
  contractType: OptionContractType,
): number {
  if (model === 'american') {
    return gammaAmericanFiniteDiffOrAnalytical({
      spot: underlier,
      strike,
      timeToExpiry,
      rate,
      dividendYield,
      volatility: iv,
      contractType,
    });
  }
  return evaluateModelGreeks(
    model,
    underlier,
    strike,
    timeToExpiry,
    rate,
    dividendYield,
    iv,
    contractType,
  ).gamma;
}

function evaluateContractForChain(
  contract: ExposureContractInput,
  index: number,
  market: ExposureMarketInputs,
  opts: NormalizedExposureOptions,
): { readonly active: boolean; readonly prepared: PreparedContract | null; readonly skipReason: ContractSkipReason | null } {
  if (!Number.isFinite(contract.openInterest) || contract.openInterest <= 0) {
    return { active: false, prepared: null, skipReason: null };
  }

  const rawType: string = contract.contractType;
  if (rawType !== 'call' && rawType !== 'put') {
    return { active: true, prepared: null, skipReason: 'invalidContractType' };
  }
  const contractType: OptionContractType = rawType;

  if (!isPositiveFinite(contract.strike)) {
    return { active: true, prepared: null, skipReason: 'invalidStrike' };
  }

  if (!isPositiveFinite(contract.sharesPerContract)) {
    return { active: true, prepared: null, skipReason: 'invalidSharesPerContract' };
  }

  if (
    !Number.isFinite(contract.expiryUtcSec) ||
    Math.abs(contract.expiryUtcSec) > MAX_TIME_SECONDS
  ) {
    return { active: true, prepared: null, skipReason: 'invalidExpiry' };
  }

  const timeToExpiry = timeToExpiryYears(
    market.nowUtcSec,
    contract.expiryUtcSec,
    opts.secondsPerYear,
  );
  if (!isPositiveFinite(timeToExpiry)) {
    return { active: true, prepared: null, skipReason: 'expired' };
  }

  const rate = contract.rate ?? market.rate;
  if (!Number.isFinite(rate)) {
    return { active: true, prepared: null, skipReason: 'invalidRates' };
  }

  let underlier: number;
  let dividendYield = Number.NaN;

  if (opts.model === 'black76') {
    const fwd = contract.forward ?? market.forward;
    if (fwd === undefined || !isPositiveFinite(fwd)) {
      return { active: true, prepared: null, skipReason: 'invalidUnderlier' };
    }
    underlier = fwd;
    dividendYield = rate;
  } else {
    const spotVal = contract.spot ?? market.spot;
    if (!isPositiveFinite(spotVal)) {
      return { active: true, prepared: null, skipReason: 'invalidUnderlier' };
    }
    underlier = spotVal;

    if (contract.dividendYield !== undefined) {
      dividendYield = contract.dividendYield;
    } else if (market.dividendYield !== undefined) {
      dividendYield = market.dividendYield;
    } else {
      const fwd = contract.forward ?? market.forward;
      if (fwd !== undefined && isPositiveFinite(fwd)) {
        dividendYield = impliedDividendYieldFromForward(
          underlier,
          fwd,
          timeToExpiry,
          rate,
        );
      }
    }

    if (!Number.isFinite(dividendYield)) {
      return { active: true, prepared: null, skipReason: 'invalidRates' };
    }
  }

  const marketMid = resolveContractMarketMid(contract);
  const ivRes = resolveContractIv(
    contract,
    opts.model,
    underlier,
    timeToExpiry,
    rate,
    dividendYield,
    contractType,
    marketMid,
    opts.ivResolutionMode,
    opts.ivSolverOptions,
  );

  if (ivRes.errorReason !== null || !isPositiveFinite(ivRes.iv)) {
    return {
      active: true,
      prepared: null,
      skipReason: ivRes.errorReason ?? 'invalidIv',
    };
  }

  const greeks = evaluateModelGreeks(
    opts.model,
    underlier,
    contract.strike,
    timeToExpiry,
    rate,
    dividendYield,
    ivRes.iv,
    contractType,
  );

  if (
    !Number.isFinite(greeks.delta) ||
    !Number.isFinite(greeks.gamma) ||
    !Number.isFinite(greeks.vanna) ||
    !Number.isFinite(greeks.charm) ||
    !Number.isFinite(greeks.price)
  ) {
    return { active: true, prepared: null, skipReason: 'nonFiniteGreeks' };
  }

  const sign =
    contractType === 'call'
      ? opts.dealerPositionSign.call
      : opts.dealerPositionSign.put;
  const volume =
    contract.volume !== undefined && isNonNegativeFinite(contract.volume)
      ? contract.volume
      : Number.NaN;

  return {
    active: true,
    prepared: {
      index,
      contractType,
      strike: contract.strike,
      expiryUtcSec: contract.expiryUtcSec,
      timeToExpiry,
      openInterest: contract.openInterest,
      volume,
      sharesPerContract: contract.sharesPerContract,
      sign,
      underlier,
      rate,
      dividendYield,
      iv: ivRes.iv,
      greeks,
      marketMidPrice: marketMid.price,
    },
    skipReason: null,
  };
}

function computeScaledExposuresFromGreeks(
  prepared: PreparedContract,
  spotAtEval: number,
  greeks: OptionGreeksResult,
  daysPerYear: number,
): {
  readonly dollarGex: number;
  readonly spotShareGamma: number;
  readonly dex: number;
  readonly vannaExposure: number;
  readonly charmExposure: number;
} {
  const notionalCount = prepared.sign * prepared.openInterest * prepared.sharesPerContract;
  const dollarGex = notionalCount * greeks.gamma * spotAtEval * spotAtEval * ONE_PERCENT;
  const spotShareGamma = notionalCount * greeks.gamma * spotAtEval;
  const dex = notionalCount * greeks.delta * spotAtEval;
  const vannaExposure = notionalCount * greeks.vanna * spotAtEval * ONE_PERCENT;
  const charmExposure = notionalCount * (greeks.charm / daysPerYear) * spotAtEval;

  return {
    dollarGex,
    spotShareGamma,
    dex,
    vannaExposure,
    charmExposure,
  };
}

/**
 * Computes single-contract Greeks and dealer exposures cleanly without mutating inputs.
 * Contracts with non-finite or non-positive openInterest contribute 0 exposure cleanly;
 * active contracts with invalid/NaN inputs return NaN exposures and a skipReason.
 */
export function computeContractExposure(
  contract: ExposureContractInput,
  market: ExposureMarketInputs,
  options?: ExposureOptions,
): ContractExposureResult {
  const opts = normalizeOptions(options);
  if (opts === null || !isValidMarketInputs(market)) {
    return {
      isActive: false,
      isUsable: false,
      skipReason: 'invalidRates',
      contractType: null,
      strike: Number.NaN,
      expiryUtcSec: Number.NaN,
      timeToExpiry: Number.NaN,
      openInterest: Number.NaN,
      volume: Number.NaN,
      sharesPerContract: Number.NaN,
      sign: Number.NaN,
      underlier: Number.NaN,
      rate: Number.NaN,
      dividendYield: Number.NaN,
      iv: Number.NaN,
      greeks: NAN_GREEKS,
      dollarGex: Number.NaN,
      spotShareGamma: Number.NaN,
      dex: Number.NaN,
      vannaExposure: Number.NaN,
      charmExposure: Number.NaN,
    };
  }

  const rawContractTypeStr: string = contract.contractType;
  const normalizedType: OptionContractType | null =
    rawContractTypeStr === 'call'
      ? 'call'
      : rawContractTypeStr === 'put'
        ? 'put'
        : null;
  const evalRes = evaluateContractForChain(contract, 0, market, opts);
  if (!evalRes.active) {
    return {
      isActive: false,
      isUsable: false,
      skipReason: null,
      contractType: normalizedType,
      strike: contract.strike,
      expiryUtcSec: contract.expiryUtcSec,
      timeToExpiry: Number.NaN,
      openInterest: Number.isFinite(contract.openInterest) ? contract.openInterest : Number.NaN,
      volume:
        contract.volume !== undefined && isNonNegativeFinite(contract.volume)
          ? contract.volume
          : Number.NaN,
      sharesPerContract: contract.sharesPerContract,
      sign: Number.NaN,
      underlier: Number.NaN,
      rate: Number.NaN,
      dividendYield: Number.NaN,
      iv: Number.NaN,
      greeks: NAN_GREEKS,
      dollarGex: 0,
      spotShareGamma: 0,
      dex: 0,
      vannaExposure: 0,
      charmExposure: 0,
    };
  }

  if (evalRes.prepared === null) {
    return {
      isActive: true,
      isUsable: false,
      skipReason: evalRes.skipReason,
      contractType: normalizedType,
      strike: contract.strike,
      expiryUtcSec: contract.expiryUtcSec,
      timeToExpiry: Number.NaN,
      openInterest: contract.openInterest,
      volume:
        contract.volume !== undefined && isNonNegativeFinite(contract.volume)
          ? contract.volume
          : Number.NaN,
      sharesPerContract: contract.sharesPerContract,
      sign: Number.NaN,
      underlier: Number.NaN,
      rate: Number.NaN,
      dividendYield: Number.NaN,
      iv: Number.NaN,
      greeks: NAN_GREEKS,
      dollarGex: Number.NaN,
      spotShareGamma: Number.NaN,
      dex: Number.NaN,
      vannaExposure: Number.NaN,
      charmExposure: Number.NaN,
    };
  }

  const p = evalRes.prepared;
  const scaled = computeScaledExposuresFromGreeks(
    p,
    p.underlier,
    p.greeks,
    opts.daysPerYear,
  );

  return {
    isActive: true,
    isUsable: true,
    skipReason: null,
    contractType: p.contractType,
    strike: p.strike,
    expiryUtcSec: p.expiryUtcSec,
    timeToExpiry: p.timeToExpiry,
    openInterest: p.openInterest,
    volume: p.volume,
    sharesPerContract: p.sharesPerContract,
    sign: p.sign,
    underlier: p.underlier,
    rate: p.rate,
    dividendYield: p.dividendYield,
    iv: p.iv,
    greeks: p.greeks,
    dollarGex: scaled.dollarGex,
    spotShareGamma: scaled.spotShareGamma,
    dex: scaled.dex,
    vannaExposure: scaled.vannaExposure,
    charmExposure: scaled.charmExposure,
  };
}

function evaluatePreparedNetGexAtSpot(
  preparedList: readonly PreparedContract[],
  baseSpot: number,
  candidateSpot: number,
  model: ExposureModel,
): number {
  if (!isPositiveFinite(candidateSpot) || !isPositiveFinite(baseSpot)) {
    return Number.NaN;
  }
  const scaleRatio = candidateSpot / baseSpot;
  let total = 0;
  for (const p of preparedList) {
    const evalUnderlier = p.underlier * scaleRatio;
    const gamma = evaluateModelGamma(
      model,
      evalUnderlier,
      p.strike,
      p.timeToExpiry,
      p.rate,
      p.dividendYield,
      p.iv,
      p.contractType,
    );
    if (!Number.isFinite(gamma)) {
      return Number.NaN;
    }
    total +=
      p.sign *
      p.openInterest *
      p.sharesPerContract *
      gamma *
      evalUnderlier *
      evalUnderlier *
      ONE_PERCENT;
  }
  return total;
}

function bisectZeroCrossing(
  fn: (s: number) => number,
  left: number,
  right: number,
  fLeft: number,
  toleranceAbs: number,
  maxIterations: number,
): number {
  let lo = left;
  let hi = right;
  let flo = fLeft;

  for (let iter = 0; iter < maxIterations; iter += 1) {
    const mid = 0.5 * (lo + hi);
    if (hi - lo <= toleranceAbs) {
      return mid;
    }
    const fmid = fn(mid);
    if (!Number.isFinite(fmid)) {
      return Number.NaN;
    }
    if (fmid === 0) {
      return mid;
    }
    if ((flo > 0 && fmid < 0) || (flo < 0 && fmid > 0)) {
      hi = mid;
    } else {
      lo = mid;
      flo = fmid;
    }
  }
  return 0.5 * (lo + hi);
}

function computeGammaFlipFromPrepared(
  preparedList: readonly PreparedContract[],
  spot: number,
  opts: NormalizedExposureOptions,
): GammaFlipReport {
  if (preparedList.length === 0 || !isPositiveFinite(spot)) {
    return {
      gammaFlipSpot: Number.NaN,
      status: 'indeterminate',
      candidates: [],
    };
  }

  const steps = opts.gammaFlipGridSteps;
  const sMin = spot * (1 - opts.gammaFlipHalfWidth);
  const sMax = spot * (1 + opts.gammaFlipHalfWidth);
  const gridS: number[] = [];
  const gridF: number[] = [];

  for (let i = 0; i <= steps; i += 1) {
    const s = sMin + ((sMax - sMin) * i) / steps;
    const val = evaluatePreparedNetGexAtSpot(preparedList, spot, s, opts.model);
    if (!Number.isFinite(val)) {
      return {
        gammaFlipSpot: Number.NaN,
        status: 'indeterminate',
        candidates: [],
      };
    }
    gridS.push(s);
    gridF.push(val);
  }

  const evalFn = (s: number): number =>
    evaluatePreparedNetGexAtSpot(preparedList, spot, s, opts.model);
  const tolAbs = opts.gammaFlipToleranceRel * spot;
  const candidates: number[] = [];

  for (let i = 0; i < steps; i += 1) {
    const sa = gridS[i];
    const sb = gridS[i + 1];
    const fa = gridF[i];
    const fb = gridF[i + 1];
    if (sa === undefined || sb === undefined || fa === undefined || fb === undefined) {
      continue;
    }

    if ((fa > 0 && fb < 0) || (fa < 0 && fb > 0)) {
      const root = bisectZeroCrossing(
        evalFn,
        sa,
        sb,
        fa,
        tolAbs,
        opts.gammaFlipMaxIterations,
      );
      if (Number.isFinite(root)) {
        candidates.push(root);
      }
    } else if (fa === 0 && i > 0) {
      const fPrev = gridF[i - 1];
      if (fPrev !== undefined && ((fPrev > 0 && fb < 0) || (fPrev < 0 && fb > 0))) {
        candidates.push(sa);
      }
    }
  }

  if (candidates.length === 0) {
    return {
      gammaFlipSpot: Number.NaN,
      status: 'no_crossing',
      candidates: [],
    };
  }

  if (candidates.length === 1) {
    const uniqueRoot = candidates[0] ?? Number.NaN;
    return {
      gammaFlipSpot: uniqueRoot,
      status: 'unique',
      candidates,
    };
  }

  if (opts.gammaFlipMultiRootPolicy === 'nearestSpot') {
    let best = Number.NaN;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const c of candidates) {
      const dist = Math.abs(c - spot);
      if (dist < bestDist) {
        bestDist = dist;
        best = c;
      }
    }
    return {
      gammaFlipSpot: best,
      status: 'multiple_crossings',
      candidates,
    };
  }

  return {
    gammaFlipSpot: Number.NaN,
    status: 'multiple_crossings',
    candidates,
  };
}

/**
 * Evaluates aggregate Net GEX (USD per 1% spot move) at candidate spot S,
 * repricing contract Gammas at fixed implied volatilities.
 */
export function evaluateNetGexAtSpot(
  contracts: readonly ExposureContractInput[],
  market: ExposureMarketInputs,
  candidateSpot: number,
  options?: ExposureOptions,
): number {
  const opts = normalizeOptions(options);
  if (
    opts === null ||
    !isValidMarketInputs(market) ||
    !isPositiveFinite(candidateSpot) ||
    !isRuntimeArray(contracts)
  ) {
    return Number.NaN;
  }

  const preparedList: PreparedContract[] = [];
  for (let i = 0; i < contracts.length; i += 1) {
    const contract = contracts[i];
    if (contract === undefined) {
      continue;
    }
    const res = evaluateContractForChain(contract, i, market, opts);
    if (res.prepared !== null) {
      preparedList.push(res.prepared);
    }
  }
  if (preparedList.length === 0) {
    return Number.NaN;
  }
  return evaluatePreparedNetGexAtSpot(preparedList, market.spot, candidateSpot, opts.model);
}

/**
 * Finds the Zero Gamma (Gamma Flip) spot level by evaluating Net GEX across
 * a centered grid `[S*(1-w), S*(1+w)]` and refining zero crossings by bisection.
 * Returns `NaN` when no crossing or multiple crossings occur (unless `nearestSpot` is opted in).
 */
export function findGammaFlipSpot(
  contracts: readonly ExposureContractInput[],
  market: ExposureMarketInputs,
  options?: ExposureOptions,
): GammaFlipReport {
  const opts = normalizeOptions(options);
  if (opts === null || !isValidMarketInputs(market) || !isRuntimeArray(contracts)) {
    return {
      gammaFlipSpot: Number.NaN,
      status: 'indeterminate',
      candidates: [],
    };
  }

  const preparedList: PreparedContract[] = [];
  for (let i = 0; i < contracts.length; i += 1) {
    const contract = contracts[i];
    if (contract === undefined) {
      continue;
    }
    const res = evaluateContractForChain(contract, i, market, opts);
    if (res.prepared !== null) {
      preparedList.push(res.prepared);
    }
  }
  return computeGammaFlipFromPrepared(preparedList, market.spot, opts);
}

/**
 * Computes Call Wall and Put Wall strikes from grouped strike exposures using
 * configurable `'gex' | 'oi'` criterion and `'all' | 'otm'` strike scope.
 * Ties resolve deterministically by proximity to spot, then lower strike.
 */
export function computeWallsFromStrikes(
  byStrike: readonly StrikeExposure[],
  spot: number,
  options?: Pick<ExposureOptions, 'wallCriterion' | 'wallScope'>,
): WallLevelsResult {
  if (!isPositiveFinite(spot) || !isRuntimeArray(byStrike) || byStrike.length === 0) {
    return { callWallStrike: Number.NaN, putWallStrike: Number.NaN };
  }

  const criterion: WallCriterion = options?.wallCriterion ?? 'gex';
  const scope: WallScope = options?.wallScope ?? 'all';

  let callWallStrike = Number.NaN;
  let bestCallVal = 0;
  let putWallStrike = Number.NaN;
  let bestPutVal = 0;

  for (const row of byStrike) {
    if (scope === 'all' || row.strike >= spot) {
      const callVal =
        criterion === 'oi' ? row.callOpenInterest : Math.abs(row.callGex);
      if (callVal > 0 && row.callOpenInterest > 0) {
        const isBetter =
          callVal > bestCallVal ||
          (callVal === bestCallVal &&
            (Number.isNaN(callWallStrike) ||
              Math.abs(row.strike - spot) < Math.abs(callWallStrike - spot) ||
              (Math.abs(row.strike - spot) === Math.abs(callWallStrike - spot) &&
                row.strike < callWallStrike)));
        if (isBetter) {
          bestCallVal = callVal;
          callWallStrike = row.strike;
        }
      }
    }

    if (scope === 'all' || row.strike <= spot) {
      const putVal =
        criterion === 'oi' ? row.putOpenInterest : Math.abs(row.putGex);
      if (putVal > 0 && row.putOpenInterest > 0) {
        const isBetter =
          putVal > bestPutVal ||
          (putVal === bestPutVal &&
            (Number.isNaN(putWallStrike) ||
              Math.abs(row.strike - spot) < Math.abs(putWallStrike - spot) ||
              (Math.abs(row.strike - spot) === Math.abs(putWallStrike - spot) &&
                row.strike < putWallStrike)));
        if (isBetter) {
          bestPutVal = putVal;
          putWallStrike = row.strike;
        }
      }
    }
  }

  return { callWallStrike, putWallStrike };
}

/**
 * Clasifica el régimen de Vanna de dealers ante una compresión de IV (`Δσ < 0`):
 * al caer la IV el cambio en delta USD de dealers es `-netVex`, por lo que el flujo
 * de re-hedging es `+netVex`. `netVex > 0` implica que dealers compran subyacente
 * al comprimirse la IV (`SUPPORTIVE_ON_IV_DROP`); `netVex < 0` implica que venden
 * (`PRESSURE_ON_IV_DROP`). Valores no finitos o dentro de la banda neutral degradan
 * honestamente a `NEUTRAL`.
 */
export function classifyVannaRegime(netVex: number, neutralEpsilon = 1e-6): VannaRegime {
  if (!Number.isFinite(netVex) || Math.abs(netVex) <= neutralEpsilon) {
    return 'NEUTRAL';
  }
  return netVex > 0 ? 'SUPPORTIVE_ON_IV_DROP' : 'PRESSURE_ON_IV_DROP';
}

/**
 * Devuelve el strike con máximo `|netCharmExposure|` finito estrictamente positivo.
 * Desempate determinístico: menor `|strike - spot|`, luego menor strike.
 * Retorna `NaN` si no hay filas o ningún charm finito distinto de cero.
 */
export function computeCharmPinStrike(
  byStrike: readonly StrikeExposure[],
  spot: number,
): number {
  if (!isRuntimeArray(byStrike) || byStrike.length === 0) {
    return Number.NaN;
  }

  let bestStrike = Number.NaN;
  let bestAbsCharm = 0;

  for (const row of byStrike) {
    const absCharm = Math.abs(row.netCharmExposure);
    if (!Number.isFinite(absCharm) || absCharm <= 0) {
      continue;
    }
    const isBetter =
      absCharm > bestAbsCharm ||
      (absCharm === bestAbsCharm &&
        (Number.isNaN(bestStrike) ||
          Math.abs(row.strike - spot) < Math.abs(bestStrike - spot) ||
          (Math.abs(row.strike - spot) === Math.abs(bestStrike - spot) &&
            row.strike < bestStrike)));
    if (isBetter) {
      bestAbsCharm = absCharm;
      bestStrike = row.strike;
    }
  }

  return bestStrike;
}

function resolveExpiryIvAtm(
  expiryItems: readonly PreparedContract[],
  spot: number,
  timeToExpiry: number,
  ivAtmOverride: number,
): number {
  if (isPositiveFinite(ivAtmOverride)) {
    return ivAtmOverride;
  }

  const byStrike = new Map<number, { call?: PreparedContract; put?: PreparedContract }>();
  for (const item of expiryItems) {
    const slot = byStrike.get(item.strike) ?? {};
    if (item.contractType === 'call') {
      slot.call = item;
    } else {
      slot.put = item;
    }
    byStrike.set(item.strike, slot);
  }

  const nodes: { readonly strike: number; readonly iv: number }[] = [];
  const sortedStrikes = Array.from(byStrike.keys()).sort((a, b) => a - b);

  for (const strike of sortedStrikes) {
    const slot = byStrike.get(strike);
    if (slot === undefined) {
      continue;
    }
    const relDiff = Math.abs(strike - spot) / spot;
    let chosenIv = Number.NaN;
    if (relDiff <= ATM_REL_TOLERANCE) {
      if (slot.call !== undefined && slot.put !== undefined) {
        chosenIv = Math.sqrt(
          0.5 * (slot.call.iv * slot.call.iv + slot.put.iv * slot.put.iv),
        );
      } else {
        chosenIv = slot.call?.iv ?? slot.put?.iv ?? Number.NaN;
      }
    } else if (strike < spot) {
      chosenIv = slot.put?.iv ?? slot.call?.iv ?? Number.NaN;
    } else {
      chosenIv = slot.call?.iv ?? slot.put?.iv ?? Number.NaN;
    }

    if (isPositiveFinite(chosenIv)) {
      nodes.push({ strike, iv: chosenIv });
    }
  }

  if (nodes.length === 0) {
    return Number.NaN;
  }

  for (const n of nodes) {
    if (Math.abs(n.strike - spot) / spot <= ATM_REL_TOLERANCE) {
      return n.iv;
    }
  }

  for (let i = 0; i < nodes.length - 1; i += 1) {
    const lo = nodes[i];
    const hi = nodes[i + 1];
    if (lo === undefined || hi === undefined) {
      continue;
    }
    if (lo.strike < spot && spot < hi.strike) {
      const kLo = Math.log(lo.strike / spot);
      const kHi = Math.log(hi.strike / spot);
      const wLo = lo.iv * lo.iv * timeToExpiry;
      const wHi = hi.iv * hi.iv * timeToExpiry;
      const alpha = -kLo / (kHi - kLo);
      const wAtm = (1 - alpha) * wLo + alpha * wHi;
      return isPositiveFinite(wAtm) ? Math.sqrt(wAtm / timeToExpiry) : Number.NaN;
    }
  }

  return Number.NaN;
}

function resolveContractStraddleLegPrice(
  contract: ExposureContractInput,
  modelPrice: number,
  source: StraddlePriceSource,
): number {
  const mid = resolveContractMarketMid(contract);
  if (mid.provided) {
    return mid.price;
  }
  if (source === 'marketOnly') {
    return Number.NaN;
  }
  return isPositiveFinite(modelPrice) ? modelPrice : Number.NaN;
}

function computeExpectedMoveFromPrepared(
  expirySec: number,
  preparedForExpiry: readonly PreparedContract[],
  allContracts: readonly ExposureContractInput[],
  market: ExposureMarketInputs,
  opts: NormalizedExposureOptions,
  ivAtmOverride: number,
): ExpectedMoveResult {
  const first = preparedForExpiry[0];
  if (first === undefined) {
    return nanExpectedMove(expirySec, Number.NaN);
  }

  const t = first.timeToExpiry;
  const ivAtm = resolveExpiryIvAtm(
    preparedForExpiry,
    market.spot,
    t,
    ivAtmOverride,
  );
  const formulaMovePct =
    isPositiveFinite(ivAtm) && isPositiveFinite(t)
      ? ivAtm * Math.sqrt(t)
      : Number.NaN;
  const formulaMove = isPositiveFinite(formulaMovePct)
    ? market.spot * formulaMovePct
    : Number.NaN;

  // Build strike pairs of active contracts at this expiry for ATM straddle lookup.
  const preparedByIndex = new Map<number, PreparedContract>();
  for (const p of preparedForExpiry) {
    preparedByIndex.set(p.index, p);
  }

  const pairMap = new Map<
    number,
    { callPrice: number; putPrice: number; hasCall: boolean; hasPut: boolean }
  >();

  for (let i = 0; i < allContracts.length; i += 1) {
    const raw = allContracts[i];
    if (raw === undefined || raw.expiryUtcSec !== expirySec) {
      continue;
    }
    const rawType: string = raw.contractType;
    if (rawType !== 'call' && rawType !== 'put') {
      continue;
    }
    if (!isPositiveFinite(raw.strike)) {
      continue;
    }
    const p = preparedByIndex.get(i);
    const modelPrice = p !== undefined ? p.greeks.price : Number.NaN;
    const legPrice = resolveContractStraddleLegPrice(
      raw,
      modelPrice,
      opts.straddlePriceSource,
    );
    const slot = pairMap.get(raw.strike) ?? {
      callPrice: Number.NaN,
      putPrice: Number.NaN,
      hasCall: false,
      hasPut: false,
    };
    if (rawType === 'call') {
      slot.hasCall = true;
      slot.callPrice = legPrice;
    } else {
      slot.hasPut = true;
      slot.putPrice = legPrice;
    }
    pairMap.set(raw.strike, slot);
  }

  let straddleStrike = Number.NaN;
  let straddleCallPrice = Number.NaN;
  let straddlePutPrice = Number.NaN;
  let bestRelDist = Number.POSITIVE_INFINITY;

  const sortedStrikes = Array.from(pairMap.keys()).sort((a, b) => a - b);
  for (const strike of sortedStrikes) {
    const slot = pairMap.get(strike);
    if (slot === undefined || !slot.hasCall || !slot.hasPut) {
      continue;
    }
    const relDist = Math.abs(strike - market.spot) / market.spot;
    if (relDist <= opts.atmStraddleMaxRelDist && relDist < bestRelDist) {
      bestRelDist = relDist;
      straddleStrike = strike;
      straddleCallPrice = slot.callPrice;
      straddlePutPrice = slot.putPrice;
    }
  }

  const straddleMove =
    isPositiveFinite(straddleCallPrice) && isPositiveFinite(straddlePutPrice)
      ? straddleCallPrice + straddlePutPrice
      : Number.NaN;
  const straddleMovePct = isPositiveFinite(straddleMove)
    ? straddleMove / market.spot
    : Number.NaN;

  return {
    expiryUtcSec: expirySec,
    timeToExpiry: t,
    ivAtm,
    formulaMove,
    formulaMovePct,
    straddleStrike,
    straddleCallPrice,
    straddlePutPrice,
    straddleMove,
    straddleMovePct,
  };
}

/**
 * Computes Expected Move for a single expiry using both `S * ivAtm * sqrt(T)`
 * and nearest-to-spot ATM straddle `C + P` when present in the chain.
 */
export function computeExpectedMoveForExpiry(
  contracts: readonly ExposureContractInput[],
  market: ExposureMarketInputs,
  expiryUtcSec: number,
  options?: ExposureOptions,
): ExpectedMoveResult {
  const opts = normalizeOptions(options);
  if (
    opts === null ||
    !isValidMarketInputs(market) ||
    !Number.isFinite(expiryUtcSec) ||
    !isRuntimeArray(contracts)
  ) {
    return nanExpectedMove();
  }

  const preparedForExpiry: PreparedContract[] = [];
  for (let i = 0; i < contracts.length; i += 1) {
    const contract = contracts[i];
    if (contract === undefined || contract.expiryUtcSec !== expiryUtcSec) {
      continue;
    }
    const evalRes = evaluateContractForChain(contract, i, market, opts);
    if (evalRes.prepared !== null) {
      preparedForExpiry.push(evalRes.prepared);
    }
  }

  return computeExpectedMoveFromPrepared(
    expiryUtcSec,
    preparedForExpiry,
    contracts,
    market,
    opts,
    opts.expectedMoveIvAtmOverride,
  );
}

interface MutableStrikeBucket {
  readonly strike: number;
  callOpenInterest: number;
  putOpenInterest: number;
  callVolumeSum: number;
  putVolumeSum: number;
  hasCall: boolean;
  hasPut: boolean;
  hasInvalidCallVolume: boolean;
  hasInvalidPutVolume: boolean;
  callGex: number;
  putGex: number;
  callSpotGamma: number;
  putSpotGamma: number;
  callDex: number;
  putDex: number;
  callVannaExposure: number;
  putVannaExposure: number;
  callCharmExposure: number;
  putCharmExposure: number;
}

function invalidDealerExposureResult(
  spot: number,
  nowUtcSec: number,
  model: ExposureModel,
  sign: DealerSignConfig,
  inputCount: number,
): DealerExposureResult {
  return {
    spot,
    nowUtcSec,
    model,
    dealerPositionSign: sign,
    units: EXPOSURE_UNITS,
    callGex: Number.NaN,
    putGex: Number.NaN,
    netGex: Number.NaN,
    absGex: Number.NaN,
    netSpotGamma: Number.NaN,
    callDex: Number.NaN,
    putDex: Number.NaN,
    netDex: Number.NaN,
    callVannaExposure: Number.NaN,
    putVannaExposure: Number.NaN,
    netVannaExposure: Number.NaN,
    callCharmExposure: Number.NaN,
    putCharmExposure: Number.NaN,
    netCharmExposure: Number.NaN,
    vannaRegime: 'NEUTRAL',
    charmPinStrike: Number.NaN,
    callWallStrike: Number.NaN,
    putWallStrike: Number.NaN,
    gammaFlipSpot: Number.NaN,
    gammaFlipStatus: 'indeterminate',
    gammaFlipCandidates: [],
    expectedMove: nanExpectedMove(),
    expectedMoveByExpiry: [],
    byStrike: [],
    quality: {
      inputContracts: inputCount,
      activeContracts: 0,
      usableContracts: 0,
      zeroOiContracts: 0,
      invalidOiContracts: 0,
      skippedContracts: 0,
      totalActiveOpenInterest: 0,
      usableOpenInterest: 0,
      skippedOpenInterest: 0,
      skippedOiShare: Number.NaN,
      countsByReason: createEmptySkipCounts(),
      skippedDetails: [],
    },
  };
}

/**
 * Pure TypeScript Dealer Exposure Engine across an option chain snapshot:
 * computes GEX (USD per 1% spot move), Spot-share Gamma (USD per $1 spot move),
 * DEX, Vanna Exposure (USD delta per +1% IV), Charm Exposure (USD delta per day),
 * Call/Put Walls, Zero Gamma (Gamma Flip), Expected Move (formula and ATM straddle),
 * and explicit data quality reporting without fallback values or argument mutation.
 *
 * Standard dealer positioning sign convention (configurable via `dealerPositionSign`):
 * `+1` for calls (dealers assumed net long calls), `-1` for puts (dealers assumed net short puts).
 */
export function computeDealerExposure(
  contracts: readonly ExposureContractInput[],
  market: ExposureMarketInputs,
  options?: ExposureOptions,
): DealerExposureResult {
  const opts = normalizeOptions(options);
  const inputCount = isRuntimeArray(contracts) ? contracts.length : 0;
  if (opts === null || !isValidMarketInputs(market) || !isRuntimeArray(contracts)) {
    return invalidDealerExposureResult(
      market.spot,
      market.nowUtcSec,
      opts?.model ?? 'bsm',
      opts?.dealerPositionSign ?? { call: 1, put: -1 },
      inputCount,
    );
  }

  const skipCounts = createEmptySkipCounts();
  const skippedDetails: SkippedExposureContract[] = [];
  const preparedList: PreparedContract[] = [];
  const strikeMap = new Map<number, MutableStrikeBucket>();
  const expiryPreparedMap = new Map<number, PreparedContract[]>();

  let activeContracts = 0;
  let zeroOiContracts = 0;
  let invalidOiContracts = 0;
  let skippedContracts = 0;
  let totalActiveOpenInterest = 0;
  let usableOpenInterest = 0;
  let skippedOpenInterest = 0;

  for (let i = 0; i < contracts.length; i += 1) {
    const raw = contracts[i];
    if (raw === undefined) {
      continue;
    }

    if (!Number.isFinite(raw.openInterest) || raw.openInterest < 0) {
      invalidOiContracts += 1;
      continue;
    }
    if (raw.openInterest === 0) {
      zeroOiContracts += 1;
      continue;
    }

    activeContracts += 1;
    totalActiveOpenInterest += raw.openInterest;

    const evalRes = evaluateContractForChain(raw, i, market, opts);
    if (evalRes.prepared === null) {
      const reason = evalRes.skipReason ?? 'nonFiniteGreeks';
      skipCounts[reason] += 1;
      skippedContracts += 1;
      skippedOpenInterest += raw.openInterest;
      skippedDetails.push({
        index: i,
        strike: raw.strike,
        expiryUtcSec: raw.expiryUtcSec,
        contractType: raw.contractType,
        openInterest: raw.openInterest,
        reason,
      });
      continue;
    }

    const p = evalRes.prepared;
    preparedList.push(p);
    usableOpenInterest += p.openInterest;

    const expBucket = expiryPreparedMap.get(p.expiryUtcSec);
    if (expBucket !== undefined) {
      expBucket.push(p);
    } else {
      expiryPreparedMap.set(p.expiryUtcSec, [p]);
    }

    const scaled = computeScaledExposuresFromGreeks(
      p,
      p.underlier,
      p.greeks,
      opts.daysPerYear,
    );

    let bucket = strikeMap.get(p.strike);
    if (bucket === undefined) {
      bucket = {
        strike: p.strike,
        callOpenInterest: 0,
        putOpenInterest: 0,
        callVolumeSum: 0,
        putVolumeSum: 0,
        hasCall: false,
        hasPut: false,
        hasInvalidCallVolume: false,
        hasInvalidPutVolume: false,
        callGex: 0,
        putGex: 0,
        callSpotGamma: 0,
        putSpotGamma: 0,
        callDex: 0,
        putDex: 0,
        callVannaExposure: 0,
        putVannaExposure: 0,
        callCharmExposure: 0,
        putCharmExposure: 0,
      };
      strikeMap.set(p.strike, bucket);
    }

    if (p.contractType === 'call') {
      bucket.callOpenInterest += p.openInterest;
      bucket.hasCall = true;
      if (isNonNegativeFinite(p.volume)) {
        bucket.callVolumeSum += p.volume;
      } else {
        bucket.hasInvalidCallVolume = true;
      }
      bucket.callGex += scaled.dollarGex;
      bucket.callSpotGamma += scaled.spotShareGamma;
      bucket.callDex += scaled.dex;
      bucket.callVannaExposure += scaled.vannaExposure;
      bucket.callCharmExposure += scaled.charmExposure;
    } else {
      bucket.putOpenInterest += p.openInterest;
      bucket.hasPut = true;
      if (isNonNegativeFinite(p.volume)) {
        bucket.putVolumeSum += p.volume;
      } else {
        bucket.hasInvalidPutVolume = true;
      }
      bucket.putGex += scaled.dollarGex;
      bucket.putSpotGamma += scaled.spotShareGamma;
      bucket.putDex += scaled.dex;
      bucket.putVannaExposure += scaled.vannaExposure;
      bucket.putCharmExposure += scaled.charmExposure;
    }
  }

  const skippedOiShare =
    totalActiveOpenInterest > 0 ? skippedOpenInterest / totalActiveOpenInterest : 0;

  const quality: ExposureDataQuality = {
    inputContracts: contracts.length,
    activeContracts,
    usableContracts: preparedList.length,
    zeroOiContracts,
    invalidOiContracts,
    skippedContracts,
    totalActiveOpenInterest,
    usableOpenInterest,
    skippedOpenInterest,
    skippedOiShare,
    countsByReason: skipCounts,
    skippedDetails,
  };

  if (
    contracts.length === 0 ||
    (activeContracts === 0 && zeroOiContracts === 0) ||
    (activeContracts > 0 && preparedList.length === 0)
  ) {
    const emptyRes = invalidDealerExposureResult(
      market.spot,
      market.nowUtcSec,
      opts.model,
      opts.dealerPositionSign,
      contracts.length,
    );
    return { ...emptyRes, quality };
  }

  const sortedStrikes = Array.from(strikeMap.keys()).sort((a, b) => a - b);
  const byStrike: StrikeExposure[] = [];

  let callGex = 0;
  let putGex = 0;
  let absGex = 0;
  let netSpotGamma = 0;
  let callDex = 0;
  let putDex = 0;
  let callVannaExposure = 0;
  let putVannaExposure = 0;
  let callCharmExposure = 0;
  let putCharmExposure = 0;

  for (const strike of sortedStrikes) {
    const b = strikeMap.get(strike);
    if (b === undefined) {
      continue;
    }
    const rowNetGex = b.callGex + b.putGex;
    const rowAbsGex = Math.abs(b.callGex) + Math.abs(b.putGex);
    const rowNetSpotGamma = b.callSpotGamma + b.putSpotGamma;
    const rowNetDex = b.callDex + b.putDex;
    const rowNetVanna = b.callVannaExposure + b.putVannaExposure;
    const rowNetCharm = b.callCharmExposure + b.putCharmExposure;
    const rowCallVol = b.hasCall
      ? b.hasInvalidCallVolume
        ? Number.NaN
        : b.callVolumeSum
      : 0;
    const rowPutVol = b.hasPut
      ? b.hasInvalidPutVolume
        ? Number.NaN
        : b.putVolumeSum
      : 0;

    byStrike.push({
      strike: b.strike,
      callOpenInterest: b.callOpenInterest,
      putOpenInterest: b.putOpenInterest,
      totalOpenInterest: b.callOpenInterest + b.putOpenInterest,
      callVolume: rowCallVol,
      putVolume: rowPutVol,
      totalVolume: rowCallVol + rowPutVol,
      callGex: b.callGex,
      putGex: b.putGex,
      netGex: rowNetGex,
      absGex: rowAbsGex,
      callSpotGamma: b.callSpotGamma,
      putSpotGamma: b.putSpotGamma,
      netSpotGamma: rowNetSpotGamma,
      callDex: b.callDex,
      putDex: b.putDex,
      netDex: rowNetDex,
      callVannaExposure: b.callVannaExposure,
      putVannaExposure: b.putVannaExposure,
      netVannaExposure: rowNetVanna,
      callCharmExposure: b.callCharmExposure,
      putCharmExposure: b.putCharmExposure,
      netCharmExposure: rowNetCharm,
    });

    callGex += b.callGex;
    putGex += b.putGex;
    absGex += rowAbsGex;
    netSpotGamma += rowNetSpotGamma;
    callDex += b.callDex;
    putDex += b.putDex;
    callVannaExposure += b.callVannaExposure;
    putVannaExposure += b.putVannaExposure;
    callCharmExposure += b.callCharmExposure;
    putCharmExposure += b.putCharmExposure;
  }

  const walls = computeWallsFromStrikes(byStrike, market.spot, {
    wallCriterion: opts.wallCriterion,
    wallScope: opts.wallScope,
  });

  const flip = computeGammaFlipFromPrepared(preparedList, market.spot, opts);

  const sortedExpiries = Array.from(expiryPreparedMap.keys()).sort((a, b) => a - b);
  const expectedMoveByExpiry: ExpectedMoveResult[] = [];
  for (const expSec of sortedExpiries) {
    const expContracts = expiryPreparedMap.get(expSec) ?? [];
    const overrideForTarget =
      Number.isFinite(opts.expectedMoveExpirySec) &&
      opts.expectedMoveExpirySec === expSec
        ? opts.expectedMoveIvAtmOverride
        : sortedExpiries[0] === expSec && !Number.isFinite(opts.expectedMoveExpirySec)
          ? opts.expectedMoveIvAtmOverride
          : Number.NaN;
    expectedMoveByExpiry.push(
      computeExpectedMoveFromPrepared(
        expSec,
        expContracts,
        contracts,
        market,
        opts,
        overrideForTarget,
      ),
    );
  }

  let headlineExpectedMove = nanExpectedMove();
  if (Number.isFinite(opts.expectedMoveExpirySec)) {
    const match = expectedMoveByExpiry.find(
      (e) => e.expiryUtcSec === opts.expectedMoveExpirySec,
    );
    headlineExpectedMove =
      match ?? nanExpectedMove(opts.expectedMoveExpirySec, Number.NaN);
  } else if (expectedMoveByExpiry.length > 0) {
    headlineExpectedMove = expectedMoveByExpiry[0] ?? nanExpectedMove();
  }

  return {
    spot: market.spot,
    nowUtcSec: market.nowUtcSec,
    model: opts.model,
    dealerPositionSign: opts.dealerPositionSign,
    units: EXPOSURE_UNITS,
    callGex,
    putGex,
    netGex: callGex + putGex,
    absGex,
    netSpotGamma,
    callDex,
    putDex,
    netDex: callDex + putDex,
    callVannaExposure,
    putVannaExposure,
    netVannaExposure: callVannaExposure + putVannaExposure,
    callCharmExposure,
    putCharmExposure,
    netCharmExposure: callCharmExposure + putCharmExposure,
    vannaRegime: classifyVannaRegime(callVannaExposure + putVannaExposure),
    charmPinStrike: computeCharmPinStrike(byStrike, market.spot),
    callWallStrike: walls.callWallStrike,
    putWallStrike: walls.putWallStrike,
    gammaFlipSpot: flip.gammaFlipSpot,
    gammaFlipStatus: flip.status,
    gammaFlipCandidates: flip.candidates,
    expectedMove: headlineExpectedMove,
    expectedMoveByExpiry,
    byStrike,
    quality,
  };
}

export type DealerGammaRegime = 'LONG_GAMMA' | 'SHORT_GAMMA' | 'NEUTRAL' | 'NO_DATA';
export type DealerCreditStrategySignal =
  | 'GREEN_LIGHT'
  | 'CAUTION_SHORT_WINGS'
  | 'NEUTRAL'
  | 'NO_DATA';
export type SpotVsZeroGammaPosition =
  | 'ABOVE_ZERO_GAMMA'
  | 'BELOW_ZERO_GAMMA'
  | 'AT_ZERO_GAMMA'
  | 'UNKNOWN';

export interface DealerGammaRegimeOptions {
  /** Umbral de banda neutral sobre |netGex| en USD por movimiento del 1 %. */
  readonly neutralEpsilon?: number;
  /** Contratos usables mínimos con OI > 0 para considerar válido el régimen / Zero Gamma. */
  readonly minUsableContracts?: number;
  /** Open interest usable total mínimo para considerar válido el cálculo de GEX / Zero Gamma. */
  readonly minUsableOpenInterest?: number;
}

export interface DealerGammaSummaryInput {
  readonly spot: number;
  readonly netGex: number;
  readonly callGex?: number;
  readonly putGex?: number;
  readonly callWallStrike: number;
  readonly putWallStrike: number;
  readonly gammaFlipSpot: number;
  readonly gammaFlipStatus?: GammaFlipStatus | null;
  readonly usableContracts?: number;
  readonly usableOpenInterest?: number;
}

export interface DealerGammaRegimeReport {
  readonly regime: DealerGammaRegime;
  readonly creditStrategySignal: DealerCreditStrategySignal;
  readonly headline: string;
  readonly behaviorLabel: string;
  readonly strategyGuidance: string;
  readonly hasSufficientOi: boolean;
  readonly netGex: number;
  readonly callWallStrike: number;
  readonly putWallStrike: number;
  readonly zeroGammaSpot: number;
  readonly spotVsZeroGamma: SpotVsZeroGammaPosition;
  readonly distanceToZeroGammaPct: number;
}

function isFinitePositiveStrike(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * Clasifica el régimen de gamma de los dealers (`LONG_GAMMA` vs `SHORT_GAMMA`) y valida
 * de forma honesta si existen suficientes contratos y Open Interest válidos para exponer
 * `Call Wall`, `Put Wall` y `Zero Gamma` (`Gamma Flip`).
 *
 * - `Net GEX > 0` (`LONG_GAMMA`): dealers largos gamma compran caídas y venden subas ->
 *   mercado amortiguado / reversión a la media (luz verde para estrategias de crédito / Iron Condors).
 * - `Net GEX < 0` (`SHORT_GAMMA`): dealers cortos gamma cubren en la dirección del movimiento ->
 *   mercado acelerado / expansión de rango (alerta de riesgo para venta de alas cortas).
 * - Si `usableContracts < minUsableContracts` o `usableOpenInterest < minUsableOpenInterest`
 *   o `Net GEX` no es finito, degrada honestamente a `NO_DATA` y `zeroGammaSpot: NaN`.
 */
export function classifyDealerGammaRegimeFromSummary(
  input: DealerGammaSummaryInput,
  options: DealerGammaRegimeOptions = {},
): DealerGammaRegimeReport {
  const neutralEpsilon =
    options.neutralEpsilon !== undefined && Number.isFinite(options.neutralEpsilon) && options.neutralEpsilon >= 0
      ? options.neutralEpsilon
      : 1e-9;
  const minUsableContracts =
    options.minUsableContracts !== undefined && Number.isFinite(options.minUsableContracts) && options.minUsableContracts >= 1
      ? Math.floor(options.minUsableContracts)
      : 2;
  const minUsableOpenInterest =
    options.minUsableOpenInterest !== undefined && Number.isFinite(options.minUsableOpenInterest) && options.minUsableOpenInterest >= 1
      ? options.minUsableOpenInterest
      : 10;

  const usableContractsValid =
    input.usableContracts === undefined
    || (Number.isFinite(input.usableContracts) && input.usableContracts >= minUsableContracts);
  const usableOiValid =
    input.usableOpenInterest === undefined
    || (Number.isFinite(input.usableOpenInterest) && input.usableOpenInterest >= minUsableOpenInterest);
  const hasSufficientOi = usableContractsValid && usableOiValid;

  if (!hasSufficientOi || !Number.isFinite(input.netGex) || !isFinitePositiveStrike(input.spot)) {
    return {
      regime: 'NO_DATA',
      creditStrategySignal: 'NO_DATA',
      headline: 'GEX INSUFICIENTE',
      behaviorLabel: 'Open Interest insuficiente para determinar régimen de dealers',
      strategyGuidance: 'Sin datos suficientes de OI para evaluar exposición gamma.',
      hasSufficientOi: false,
      netGex: Number.NaN,
      callWallStrike: Number.NaN,
      putWallStrike: Number.NaN,
      zeroGammaSpot: Number.NaN,
      spotVsZeroGamma: 'UNKNOWN',
      distanceToZeroGammaPct: Number.NaN,
    };
  }

  let regime: DealerGammaRegime = 'NEUTRAL';
  let creditStrategySignal: DealerCreditStrategySignal = 'NEUTRAL';
  let headline = 'GAMMA NEUTRAL';
  let behaviorLabel = 'Exposición gamma equilibrada alrededor del spot';
  let strategyGuidance = 'Flujo neutral; monitorear cercanía al Call/Put Wall.';

  if (input.netGex > neutralEpsilon) {
    regime = 'LONG_GAMMA';
    creditStrategySignal = 'GREEN_LIGHT';
    headline = 'LONG GAMMA';
    behaviorLabel = 'Mercado amortiguado / reversión a la media';
    strategyGuidance = 'Luz verde para estrategias de crédito / Iron Condors.';
  } else if (input.netGex < -neutralEpsilon) {
    regime = 'SHORT_GAMMA';
    creditStrategySignal = 'CAUTION_SHORT_WINGS';
    headline = 'SHORT GAMMA';
    behaviorLabel = 'Mercado acelerado / expansión de rango';
    strategyGuidance = 'Alerta de riesgo para venta de alas cortas.';
  }

  const callWallStrike = isFinitePositiveStrike(input.callWallStrike) ? input.callWallStrike : Number.NaN;
  const putWallStrike = isFinitePositiveStrike(input.putWallStrike) ? input.putWallStrike : Number.NaN;

  const flipAllowedByStatus =
    input.gammaFlipStatus === undefined
    || input.gammaFlipStatus === null
    || input.gammaFlipStatus === 'unique';
  const zeroGammaSpot =
    flipAllowedByStatus && isFinitePositiveStrike(input.gammaFlipSpot)
      ? input.gammaFlipSpot
      : Number.NaN;

  let spotVsZeroGamma: SpotVsZeroGammaPosition = 'UNKNOWN';
  let distanceToZeroGammaPct = Number.NaN;
  if (isFinitePositiveStrike(zeroGammaSpot)) {
    const diff = input.spot - zeroGammaSpot;
    distanceToZeroGammaPct = (diff / input.spot) * 100;
    if (Math.abs(diff) <= 1e-6 * input.spot) {
      spotVsZeroGamma = 'AT_ZERO_GAMMA';
    } else if (diff > 0) {
      spotVsZeroGamma = 'ABOVE_ZERO_GAMMA';
    } else {
      spotVsZeroGamma = 'BELOW_ZERO_GAMMA';
    }
  }

  return {
    regime,
    creditStrategySignal,
    headline,
    behaviorLabel,
    strategyGuidance,
    hasSufficientOi: true,
    netGex: input.netGex,
    callWallStrike,
    putWallStrike,
    zeroGammaSpot,
    spotVsZeroGamma,
    distanceToZeroGammaPct,
  };
}

export interface MaxPainContractInput {
  readonly strike: number;
  readonly contractType: 'call' | 'put';
  readonly openInterest: number;
}

/**
 * Calcula el Max Pain determinístico sobre una cadena de opciones con strikes y OI válidos.
 * Minimiza el valor intrínseco agregado al vencimiento asumiendo lote estándar uniforme;
 * ante empate exacto, escoge el menor strike candidato. Devuelve `NaN` si faltan strikes u OI > 0.
 */
export function computeMaxPainStrike(contracts: readonly MaxPainContractInput[]): number {
  const byStrike = new Map<number, { callOi: number; putOi: number }>();
  let totalOi = 0;

  for (const c of contracts) {
    if (
      !Number.isFinite(c.strike) ||
      c.strike <= 0 ||
      !Number.isFinite(c.openInterest) ||
      c.openInterest <= 0
    ) {
      continue;
    }
    const existing = byStrike.get(c.strike) ?? { callOi: 0, putOi: 0 };
    if (c.contractType === 'call') {
      existing.callOi += c.openInterest;
    } else {
      existing.putOi += c.openInterest;
    }
    byStrike.set(c.strike, existing);
    totalOi += c.openInterest;
  }

  if (byStrike.size === 0 || totalOi <= 0) {
    return Number.NaN;
  }

  const strikes = [...byStrike.keys()].sort((a, b) => a - b);
  let bestStrike = Number.NaN;
  let minPayout = Number.POSITIVE_INFINITY;

  for (const cand of strikes) {
    let payout = 0;
    for (const [k, oi] of byStrike) {
      if (cand > k && oi.callOi > 0) {
        payout += (cand - k) * oi.callOi;
      }
      if (cand < k && oi.putOi > 0) {
        payout += (k - cand) * oi.putOi;
      }
    }
    if (payout < minPayout - 1e-9) {
      minPayout = payout;
      bestStrike = cand;
    }
  }

  return bestStrike;
}

/**
 * Clasifica el régimen de gamma de dealers directamente desde un `DealerExposureResult`.
 */
export function classifyDealerGammaRegime(
  result: DealerExposureResult,
  options: DealerGammaRegimeOptions = {},
): DealerGammaRegimeReport {
  return classifyDealerGammaRegimeFromSummary(
    {
      spot: result.spot,
      netGex: result.netGex,
      callGex: result.callGex,
      putGex: result.putGex,
      callWallStrike: result.callWallStrike,
      putWallStrike: result.putWallStrike,
      gammaFlipSpot: result.gammaFlipSpot,
      gammaFlipStatus: result.gammaFlipStatus,
      usableContracts: result.quality.usableContracts,
      usableOpenInterest: result.quality.usableOpenInterest,
    },
    options,
  );
}
