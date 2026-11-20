/**
 * Motor puro de GEX/Charm Pin, Signed GEX ajustado por flujo OPRA y
 * Rastreador Rueda por Rueda (Spot vs. Gamma Flip vs. GEX/Charm Pin).
 *
 * Funciones 100 % puras: cero red, cero E/S, cero UI y cero mutación de argumentos.
 */

import { getMarketParts, MAX_TIME_SECONDS } from '../sessions.js';
import {
  greeksBsm,
  SECONDS_PER_YEAR_365,
  timeToExpiryYears,
} from './blackScholes.js';
import { solveImpliedVolBsm } from './impliedVol.js';
import type { ExposureContractInput, ExposureMarketInputs } from './exposure.js';
import type { StrikeOrderFlowBucket } from './optionsOrderFlow.js';
import type { OptionContractType } from './types.js';

const DEFAULT_PRIOR_WEIGHT = 0.5;
const DEFAULT_CALL_STRUCTURAL_SIGN = 1;
const DEFAULT_PUT_STRUCTURAL_SIGN = -1;
const DEFAULT_DAYS_PER_YEAR = 365;
const DEFAULT_MAX_PIN_DTE = 7;
const DEFAULT_GEX_WEIGHT = 0.6;
const DEFAULT_CHARM_WEIGHT = 0.4;
const DEFAULT_PIN_PROXIMITY_PCT = 0.0025;
const DEFAULT_LATE_SESSION_START_MINUTES_ET = 14 * 60;
const DEFAULT_MIN_SPOT_RETURN_PCT = 0.0005;
const RTH_CLOSE_MINUTES_ET = 16 * 60;
const SECONDS_PER_DAY = 86_400;
const ONE_PERCENT = 0.01;

export interface FlowAdjustedStrikeGex {
  readonly strike: number;
  readonly callStructuralSign: number;
  readonly putStructuralSign: number;
  readonly callDealerFlowSign: number;
  readonly putDealerFlowSign: number;
  readonly callEffectiveSign: number;
  readonly putEffectiveSign: number;
  readonly callSignedDollarGex: number;
  readonly putSignedDollarGex: number;
  readonly netSignedDollarGex: number;
  readonly netCharmExposure: number;
}

export interface FlowAdjustedGexOptions {
  readonly priorWeight?: number;
  readonly callStructuralSign?: number;
  readonly putStructuralSign?: number;
  readonly daysPerYear?: number;
  readonly secondsPerYear?: number;
}

export interface FlowAdjustedGexResult {
  readonly spot: number;
  readonly priorWeight: number;
  readonly evaluatedContractsCount: number;
  readonly skippedContractsCount: number;
  readonly totalSignedDollarGex: number;
  readonly totalCharmExposure: number;
  readonly callWallStrike: number;
  readonly putWallStrike: number;
  readonly byStrike: readonly FlowAdjustedStrikeGex[];
}

export interface GexCharmPinOptions {
  readonly maxPinDte?: number;
  readonly gexWeight?: number;
  readonly charmWeight?: number;
  readonly callStructuralSign?: number;
  readonly putStructuralSign?: number;
  readonly daysPerYear?: number;
  readonly secondsPerYear?: number;
}

export interface StrikePinWeight {
  readonly strike: number;
  readonly absDollarGex: number;
  readonly absCharmExposure: number;
  readonly normalizedGexShare: number;
  readonly normalizedCharmShare: number;
  readonly combinedWeight: number;
}

export interface GexCharmPinResult {
  readonly gexCharmPinStrike: number;
  readonly peakPinStrike: number;
  readonly pinMagnetStrength: number;
  readonly eligibleContractsCount: number;
  readonly strikeWeights: readonly StrikePinWeight[];
}

export interface WheelSnapshotInput {
  readonly timestampUtcSec: number;
  readonly spot: number;
  readonly gammaFlip: number;
  readonly gexCharmPin: number;
  readonly netDeltaShares: number;
}

export type WheelRegimeClassification =
  | 'PINNING_REGIME'
  | 'DERIVATIVES_CONFIRMED_UPTREND'
  | 'DERIVATIVES_CONFIRMED_DOWNTREND'
  | 'UNSUPPORTED_SPOT_RALLY'
  | 'UNSUPPORTED_SPOT_SELLOFF'
  | 'NEUTRAL'
  | 'NO_DATA';

export interface WheelTrackerOptions {
  readonly pinProximityPct?: number;
  readonly lateSessionStartMinutesEt?: number;
  readonly minSpotReturnPct?: number;
}

export interface WheelByWheelTrackerResult {
  readonly asOfUtcSec: number;
  readonly regime: WheelRegimeClassification;
  readonly spotChange: number;
  readonly spotReturnPct: number;
  readonly gammaFlipChange: number;
  readonly gexCharmPinChange: number;
  readonly netDeltaSharesChange: number;
  readonly distanceToPinPct: number;
  readonly isLateSessionEt: boolean;
  readonly snapshotsCount: number;
}

function assertValidUtcSec(time: number, label: string): void {
  if (
    !Number.isFinite(time) ||
    !Number.isInteger(time) ||
    Math.abs(time) > MAX_TIME_SECONDS
  ) {
    throw new Error(`${label} must be finite integer UTC seconds (got ${String(time)})`);
  }
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function resolveDividendYield(
  contract: ExposureContractInput,
  market: ExposureMarketInputs,
  spot: number,
  rate: number,
  timeToExpiry: number,
): number {
  if (contract.dividendYield !== undefined) {
    return Number.isFinite(contract.dividendYield)
      ? contract.dividendYield
      : Number.NaN;
  }
  if (market.dividendYield !== undefined) {
    return Number.isFinite(market.dividendYield) ? market.dividendYield : Number.NaN;
  }
  const fwd = contract.forward ?? market.forward;
  if (fwd !== undefined && isPositiveFinite(fwd) && isPositiveFinite(spot) && isPositiveFinite(timeToExpiry)) {
    return rate - Math.log(fwd / spot) / timeToExpiry;
  }
  return Number.NaN;
}

function resolveContractIvBsm(
  contract: ExposureContractInput,
  spot: number,
  timeToExpiry: number,
  rate: number,
  dividendYield: number,
  contractType: OptionContractType,
): number {
  if (contract.iv !== undefined && contract.iv !== null) {
    return isPositiveFinite(contract.iv) ? contract.iv : Number.NaN;
  }

  let marketPrice = Number.NaN;
  if (contract.midPrice !== undefined && isPositiveFinite(contract.midPrice)) {
    marketPrice = contract.midPrice;
  } else if (
    contract.bid !== undefined &&
    contract.ask !== undefined &&
    isPositiveFinite(contract.bid) &&
    Number.isFinite(contract.ask) &&
    contract.ask >= contract.bid
  ) {
    marketPrice = 0.5 * (contract.bid + contract.ask);
  }

  if (!isPositiveFinite(marketPrice)) {
    return Number.NaN;
  }

  const solved = solveImpliedVolBsm({
    spot,
    strike: contract.strike,
    timeToExpiry,
    rate,
    dividendYield,
    contractType,
    price: marketPrice,
  });

  return isPositiveFinite(solved) ? solved : Number.NaN;
}

interface AggregatedStrikeFlowVol {
  callBuyVolume: number;
  callSellVolume: number;
  putBuyVolume: number;
  putSellVolume: number;
}

/**
 * Combina la convención estructural del dealer (`call: +1, put: -1`) con la evidencia
 * de flujo OPRA observado por strike, recalibrando Signed Dollar GEX, Charm y Walls.
 */
export function computeFlowAdjustedSignedGex(
  contracts: readonly ExposureContractInput[],
  market: ExposureMarketInputs,
  byStrikeFlow: readonly StrikeOrderFlowBucket[],
  options?: FlowAdjustedGexOptions,
): FlowAdjustedGexResult {
  assertValidUtcSec(market.nowUtcSec, 'market.nowUtcSec');

  const priorWeight = options?.priorWeight ?? DEFAULT_PRIOR_WEIGHT;
  const callStructuralSign =
    options?.callStructuralSign ?? DEFAULT_CALL_STRUCTURAL_SIGN;
  const putStructuralSign = options?.putStructuralSign ?? DEFAULT_PUT_STRUCTURAL_SIGN;
  const daysPerYear = options?.daysPerYear ?? DEFAULT_DAYS_PER_YEAR;
  const secondsPerYear = options?.secondsPerYear ?? SECONDS_PER_YEAR_365;

  if (!Number.isFinite(priorWeight) || priorWeight < 0 || priorWeight > 1) {
    throw new Error(`priorWeight must be in [0, 1] (got ${String(priorWeight)})`);
  }
  if (!isPositiveFinite(daysPerYear) || !isPositiveFinite(secondsPerYear)) {
    throw new Error('daysPerYear and secondsPerYear must be positive finite numbers');
  }
  if (!Number.isFinite(callStructuralSign) || !Number.isFinite(putStructuralSign)) {
    throw new Error('Structural signs must be finite numbers');
  }

  if (!isPositiveFinite(market.spot) || !Number.isFinite(market.rate)) {
    return {
      spot: market.spot,
      priorWeight,
      evaluatedContractsCount: 0,
      skippedContractsCount: contracts.length,
      totalSignedDollarGex: Number.NaN,
      totalCharmExposure: Number.NaN,
      callWallStrike: Number.NaN,
      putWallStrike: Number.NaN,
      byStrike: [],
    };
  }

  const flowByStrike = new Map<number, AggregatedStrikeFlowVol>();
  for (const bucket of byStrikeFlow) {
    if (!isPositiveFinite(bucket.strike)) {
      continue;
    }
    let agg = flowByStrike.get(bucket.strike);
    if (agg === undefined) {
      agg = {
        callBuyVolume: 0,
        callSellVolume: 0,
        putBuyVolume: 0,
        putSellVolume: 0,
      };
      flowByStrike.set(bucket.strike, agg);
    }
    if (Number.isFinite(bucket.callBuyVolume) && bucket.callBuyVolume > 0) {
      agg.callBuyVolume += bucket.callBuyVolume;
    }
    if (Number.isFinite(bucket.callSellVolume) && bucket.callSellVolume > 0) {
      agg.callSellVolume += bucket.callSellVolume;
    }
    if (Number.isFinite(bucket.putBuyVolume) && bucket.putBuyVolume > 0) {
      agg.putBuyVolume += bucket.putBuyVolume;
    }
    if (Number.isFinite(bucket.putSellVolume) && bucket.putSellVolume > 0) {
      agg.putSellVolume += bucket.putSellVolume;
    }
  }

  interface MutableStrikeGexAcc {
    readonly strike: number;
    readonly callDealerFlowSign: number;
    readonly putDealerFlowSign: number;
    readonly callEffectiveSign: number;
    readonly putEffectiveSign: number;
    callSignedDollarGex: number;
    putSignedDollarGex: number;
    netCharmExposure: number;
  }

  const strikeAccMap = new Map<number, MutableStrikeGexAcc>();
  let evaluatedContractsCount = 0;
  let skippedContractsCount = 0;

  for (const contract of contracts) {
    const rawType: string = contract.contractType;
    if (
      (rawType !== 'call' && rawType !== 'put') ||
      !isPositiveFinite(contract.openInterest) ||
      !isPositiveFinite(contract.strike) ||
      !isPositiveFinite(contract.sharesPerContract) ||
      !Number.isFinite(contract.expiryUtcSec) ||
      Math.abs(contract.expiryUtcSec) > MAX_TIME_SECONDS
    ) {
      skippedContractsCount += 1;
      continue;
    }

    const contractType: OptionContractType = rawType;
    const contractSpot = contract.spot ?? market.spot;
    const contractRate = contract.rate ?? market.rate;
    if (!isPositiveFinite(contractSpot) || !Number.isFinite(contractRate)) {
      skippedContractsCount += 1;
      continue;
    }

    const timeToExpiry = timeToExpiryYears(
      market.nowUtcSec,
      contract.expiryUtcSec,
      secondsPerYear,
    );
    if (!isPositiveFinite(timeToExpiry)) {
      skippedContractsCount += 1;
      continue;
    }

    const dividendYield = resolveDividendYield(
      contract,
      market,
      contractSpot,
      contractRate,
      timeToExpiry,
    );
    if (!Number.isFinite(dividendYield)) {
      skippedContractsCount += 1;
      continue;
    }

    const iv = resolveContractIvBsm(
      contract,
      contractSpot,
      timeToExpiry,
      contractRate,
      dividendYield,
      contractType,
    );
    if (!isPositiveFinite(iv)) {
      skippedContractsCount += 1;
      continue;
    }

    const greeks = greeksBsm({
      spot: contractSpot,
      strike: contract.strike,
      timeToExpiry,
      rate: contractRate,
      dividendYield,
      volatility: iv,
      contractType,
    });

    if (!Number.isFinite(greeks.gamma) || !Number.isFinite(greeks.charm)) {
      skippedContractsCount += 1;
      continue;
    }

    let acc = strikeAccMap.get(contract.strike);
    if (acc === undefined) {
      const flow = flowByStrike.get(contract.strike);
      const callTotalVol =
        flow !== undefined ? flow.callBuyVolume + flow.callSellVolume : 0;
      const putTotalVol =
        flow !== undefined ? flow.putBuyVolume + flow.putSellVolume : 0;

      const callDealerFlowSign =
        callTotalVol > 0 && flow !== undefined
          ? -(flow.callBuyVolume - flow.callSellVolume) / callTotalVol
          : Number.NaN;
      const putDealerFlowSign =
        putTotalVol > 0 && flow !== undefined
          ? -(flow.putBuyVolume - flow.putSellVolume) / putTotalVol
          : Number.NaN;

      const callEffectiveSign = Number.isFinite(callDealerFlowSign)
        ? priorWeight * callStructuralSign + (1 - priorWeight) * callDealerFlowSign
        : callStructuralSign;
      const putEffectiveSign = Number.isFinite(putDealerFlowSign)
        ? priorWeight * putStructuralSign + (1 - priorWeight) * putDealerFlowSign
        : putStructuralSign;

      acc = {
        strike: contract.strike,
        callDealerFlowSign,
        putDealerFlowSign,
        callEffectiveSign,
        putEffectiveSign,
        callSignedDollarGex: 0,
        putSignedDollarGex: 0,
        netCharmExposure: 0,
      };
      strikeAccMap.set(contract.strike, acc);
    }

    evaluatedContractsCount += 1;
    const baseCount = contract.openInterest * contract.sharesPerContract;
    const unsignedGex =
      baseCount * greeks.gamma * contractSpot * contractSpot * ONE_PERCENT;
    const unsignedCharm = baseCount * (greeks.charm / daysPerYear) * contractSpot;

    if (contractType === 'call') {
      acc.callSignedDollarGex += acc.callEffectiveSign * unsignedGex;
      acc.netCharmExposure += acc.callEffectiveSign * unsignedCharm;
    } else {
      acc.putSignedDollarGex += acc.putEffectiveSign * unsignedGex;
      acc.netCharmExposure += acc.putEffectiveSign * unsignedCharm;
    }
  }

  if (evaluatedContractsCount === 0) {
    return {
      spot: market.spot,
      priorWeight,
      evaluatedContractsCount: 0,
      skippedContractsCount,
      totalSignedDollarGex: Number.NaN,
      totalCharmExposure: Number.NaN,
      callWallStrike: Number.NaN,
      putWallStrike: Number.NaN,
      byStrike: [],
    };
  }

  const byStrike: FlowAdjustedStrikeGex[] = Array.from(strikeAccMap.values())
    .sort((a, b) => a.strike - b.strike)
    .map((acc) => ({
      strike: acc.strike,
      callStructuralSign,
      putStructuralSign,
      callDealerFlowSign: acc.callDealerFlowSign,
      putDealerFlowSign: acc.putDealerFlowSign,
      callEffectiveSign: acc.callEffectiveSign,
      putEffectiveSign: acc.putEffectiveSign,
      callSignedDollarGex: acc.callSignedDollarGex,
      putSignedDollarGex: acc.putSignedDollarGex,
      netSignedDollarGex: acc.callSignedDollarGex + acc.putSignedDollarGex,
      netCharmExposure: acc.netCharmExposure,
    }));

  let totalSignedDollarGex = 0;
  let totalCharmExposure = 0;
  let callWallStrike = Number.NaN;
  let callWallMaxGex = 0;
  let putWallStrike = Number.NaN;
  let putWallMinGex = 0;

  for (const row of byStrike) {
    totalSignedDollarGex += row.netSignedDollarGex;
    totalCharmExposure += row.netCharmExposure;

    if (row.callSignedDollarGex > callWallMaxGex) {
      callWallMaxGex = row.callSignedDollarGex;
      callWallStrike = row.strike;
    }
    if (row.putSignedDollarGex < putWallMinGex) {
      putWallMinGex = row.putSignedDollarGex;
      putWallStrike = row.strike;
    }
  }

  return {
    spot: market.spot,
    priorWeight,
    evaluatedContractsCount,
    skippedContractsCount,
    totalSignedDollarGex,
    totalCharmExposure,
    callWallStrike,
    putWallStrike,
    byStrike,
  };
}

/**
 * Calcula el imán combinado GEX/Charm Pin para vencimientos cortos (`dte <= maxPinDte`).
 * Pondera la tracción absoluta normalizada de Gamma Exposure y Charm Exposure por strike.
 */
export function computeGexCharmPin(
  contracts: readonly ExposureContractInput[],
  market: ExposureMarketInputs,
  options?: GexCharmPinOptions,
): GexCharmPinResult {
  assertValidUtcSec(market.nowUtcSec, 'market.nowUtcSec');

  const maxPinDte = options?.maxPinDte ?? DEFAULT_MAX_PIN_DTE;
  const gexWeight = options?.gexWeight ?? DEFAULT_GEX_WEIGHT;
  const charmWeight = options?.charmWeight ?? DEFAULT_CHARM_WEIGHT;
  const callStructuralSign =
    options?.callStructuralSign ?? DEFAULT_CALL_STRUCTURAL_SIGN;
  const putStructuralSign = options?.putStructuralSign ?? DEFAULT_PUT_STRUCTURAL_SIGN;
  const daysPerYear = options?.daysPerYear ?? DEFAULT_DAYS_PER_YEAR;
  const secondsPerYear = options?.secondsPerYear ?? SECONDS_PER_YEAR_365;

  if (!Number.isFinite(maxPinDte) || maxPinDte < 0) {
    throw new Error(`maxPinDte must be non-negative finite (got ${String(maxPinDte)})`);
  }
  if (
    !Number.isFinite(gexWeight) ||
    gexWeight < 0 ||
    !Number.isFinite(charmWeight) ||
    charmWeight < 0 ||
    gexWeight + charmWeight <= 0
  ) {
    throw new Error('gexWeight and charmWeight must be non-negative with positive sum');
  }
  if (!isPositiveFinite(daysPerYear) || !isPositiveFinite(secondsPerYear)) {
    throw new Error('daysPerYear and secondsPerYear must be positive finite numbers');
  }

  if (!isPositiveFinite(market.spot) || !Number.isFinite(market.rate)) {
    return {
      gexCharmPinStrike: Number.NaN,
      peakPinStrike: Number.NaN,
      pinMagnetStrength: Number.NaN,
      eligibleContractsCount: 0,
      strikeWeights: [],
    };
  }

  const maxRemainingSec =
    maxPinDte === 0 ? SECONDS_PER_DAY : maxPinDte * SECONDS_PER_DAY;

  const strikeExposures = new Map<
    number,
    { readonly strike: number; netGex: number; netCharm: number }
  >();
  let eligibleContractsCount = 0;

  for (const contract of contracts) {
    const rawType: string = contract.contractType;
    if (
      (rawType !== 'call' && rawType !== 'put') ||
      !isPositiveFinite(contract.openInterest) ||
      !isPositiveFinite(contract.strike) ||
      !isPositiveFinite(contract.sharesPerContract) ||
      !Number.isFinite(contract.expiryUtcSec) ||
      Math.abs(contract.expiryUtcSec) > MAX_TIME_SECONDS
    ) {
      continue;
    }

    const remainingSec = contract.expiryUtcSec - market.nowUtcSec;
    if (remainingSec <= 0 || remainingSec > maxRemainingSec) {
      continue;
    }

    const contractType: OptionContractType = rawType;
    const contractSpot = contract.spot ?? market.spot;
    const contractRate = contract.rate ?? market.rate;
    if (!isPositiveFinite(contractSpot) || !Number.isFinite(contractRate)) {
      continue;
    }

    const timeToExpiry = remainingSec / secondsPerYear;
    const dividendYield = resolveDividendYield(
      contract,
      market,
      contractSpot,
      contractRate,
      timeToExpiry,
    );
    if (!Number.isFinite(dividendYield)) {
      continue;
    }

    const iv = resolveContractIvBsm(
      contract,
      contractSpot,
      timeToExpiry,
      contractRate,
      dividendYield,
      contractType,
    );
    if (!isPositiveFinite(iv)) {
      continue;
    }

    const greeks = greeksBsm({
      spot: contractSpot,
      strike: contract.strike,
      timeToExpiry,
      rate: contractRate,
      dividendYield,
      volatility: iv,
      contractType,
    });

    if (!Number.isFinite(greeks.gamma) || !Number.isFinite(greeks.charm)) {
      continue;
    }

    eligibleContractsCount += 1;
    const sign = contractType === 'call' ? callStructuralSign : putStructuralSign;
    const notionalCount = sign * contract.openInterest * contract.sharesPerContract;
    const dollarGex =
      notionalCount * greeks.gamma * contractSpot * contractSpot * ONE_PERCENT;
    const charmExposure =
      notionalCount * (greeks.charm / daysPerYear) * contractSpot;

    let acc = strikeExposures.get(contract.strike);
    if (acc === undefined) {
      acc = { strike: contract.strike, netGex: 0, netCharm: 0 };
      strikeExposures.set(contract.strike, acc);
    }
    acc.netGex += dollarGex;
    acc.netCharm += charmExposure;
  }

  if (eligibleContractsCount === 0 || strikeExposures.size === 0) {
    return {
      gexCharmPinStrike: Number.NaN,
      peakPinStrike: Number.NaN,
      pinMagnetStrength: Number.NaN,
      eligibleContractsCount: 0,
      strikeWeights: [],
    };
  }

  const sortedRows = Array.from(strikeExposures.values()).sort(
    (a, b) => a.strike - b.strike,
  );

  let totalAbsGex = 0;
  let totalAbsCharm = 0;
  for (const row of sortedRows) {
    totalAbsGex += Math.abs(row.netGex);
    totalAbsCharm += Math.abs(row.netCharm);
  }

  if (totalAbsGex === 0 && totalAbsCharm === 0) {
    return {
      gexCharmPinStrike: Number.NaN,
      peakPinStrike: Number.NaN,
      pinMagnetStrength: Number.NaN,
      eligibleContractsCount,
      strikeWeights: [],
    };
  }

  const strikeWeights: StrikePinWeight[] = [];
  let weightedStrikeSum = 0;
  let totalCombinedWeight = 0;
  let peakPinStrike = Number.NaN;
  let maxCombinedWeight = -1;

  for (const row of sortedRows) {
    const absDollarGex = Math.abs(row.netGex);
    const absCharmExposure = Math.abs(row.netCharm);
    const normalizedGexShare = totalAbsGex > 0 ? absDollarGex / totalAbsGex : 0;
    const normalizedCharmShare =
      totalAbsCharm > 0 ? absCharmExposure / totalAbsCharm : 0;

    let combinedWeight: number;
    if (totalAbsGex > 0 && totalAbsCharm > 0) {
      combinedWeight =
        (gexWeight * normalizedGexShare + charmWeight * normalizedCharmShare) /
        (gexWeight + charmWeight);
    } else if (totalAbsGex > 0) {
      combinedWeight = normalizedGexShare;
    } else {
      combinedWeight = normalizedCharmShare;
    }

    weightedStrikeSum += combinedWeight * row.strike;
    totalCombinedWeight += combinedWeight;

    if (combinedWeight > maxCombinedWeight) {
      maxCombinedWeight = combinedWeight;
      peakPinStrike = row.strike;
    }

    strikeWeights.push({
      strike: row.strike,
      absDollarGex,
      absCharmExposure,
      normalizedGexShare,
      normalizedCharmShare,
      combinedWeight,
    });
  }

  if (totalCombinedWeight <= 0) {
    return {
      gexCharmPinStrike: Number.NaN,
      peakPinStrike: Number.NaN,
      pinMagnetStrength: Number.NaN,
      eligibleContractsCount,
      strikeWeights: [],
    };
  }

  const gexCharmPinStrike = weightedStrikeSum / totalCombinedWeight;
  const pinMagnetStrength = Math.min(1, Math.max(0, maxCombinedWeight));

  return {
    gexCharmPinStrike,
    peakPinStrike,
    pinMagnetStrength,
    eligibleContractsCount,
    strikeWeights,
  };
}

/**
 * Rastreador Rueda por Rueda: evalúa entre snapshots causales (`<= asOfUtcSec`)
 * la divergencia o confirmación entre el movimiento del Spot, el desplazamiento
 * del Gamma Flip, la proximidad al GEX/Charm Pin y el flujo Delta neto.
 */
export function evaluateWheelByWheelTracker(
  snapshots: readonly WheelSnapshotInput[],
  asOfUtcSec: number,
  options?: WheelTrackerOptions,
): WheelByWheelTrackerResult {
  assertValidUtcSec(asOfUtcSec, 'asOfUtcSec');

  const pinProximityPct = options?.pinProximityPct ?? DEFAULT_PIN_PROXIMITY_PCT;
  const lateSessionStartMinutesEt =
    options?.lateSessionStartMinutesEt ?? DEFAULT_LATE_SESSION_START_MINUTES_ET;
  const minSpotReturnPct = options?.minSpotReturnPct ?? DEFAULT_MIN_SPOT_RETURN_PCT;

  if (
    !Number.isFinite(pinProximityPct) ||
    pinProximityPct < 0 ||
    !Number.isFinite(lateSessionStartMinutesEt) ||
    !Number.isFinite(minSpotReturnPct) ||
    minSpotReturnPct < 0
  ) {
    throw new Error('Invalid WheelTrackerOptions');
  }

  const causalEntries: { readonly snapshot: WheelSnapshotInput; readonly index: number }[] =
    [];

  for (let i = 0; i < snapshots.length; i += 1) {
    const snap = snapshots[i];
    if (snap === undefined) {
      continue;
    }
    assertValidUtcSec(snap.timestampUtcSec, `snapshots[${String(i)}].timestampUtcSec`);
    if (snap.timestampUtcSec <= asOfUtcSec && isPositiveFinite(snap.spot)) {
      causalEntries.push({ snapshot: snap, index: i });
    }
  }

  causalEntries.sort((a, b) => {
    if (a.snapshot.timestampUtcSec !== b.snapshot.timestampUtcSec) {
      return a.snapshot.timestampUtcSec - b.snapshot.timestampUtcSec;
    }
    return a.index - b.index;
  });

  if (causalEntries.length < 2) {
    return {
      asOfUtcSec,
      regime: 'NO_DATA',
      spotChange: Number.NaN,
      spotReturnPct: Number.NaN,
      gammaFlipChange: Number.NaN,
      gexCharmPinChange: Number.NaN,
      netDeltaSharesChange: Number.NaN,
      distanceToPinPct: Number.NaN,
      isLateSessionEt: false,
      snapshotsCount: causalEntries.length,
    };
  }

  const firstEntry = causalEntries[0];
  const lastEntry = causalEntries[causalEntries.length - 1];
  if (firstEntry === undefined || lastEntry === undefined) {
    return {
      asOfUtcSec,
      regime: 'NO_DATA',
      spotChange: Number.NaN,
      spotReturnPct: Number.NaN,
      gammaFlipChange: Number.NaN,
      gexCharmPinChange: Number.NaN,
      netDeltaSharesChange: Number.NaN,
      distanceToPinPct: Number.NaN,
      isLateSessionEt: false,
      snapshotsCount: 0,
    };
  }

  const first = firstEntry.snapshot;
  const last = lastEntry.snapshot;

  const spotChange = last.spot - first.spot;
  const spotReturnPct = spotChange / first.spot;
  const gammaFlipChange = last.gammaFlip - first.gammaFlip;
  const gexCharmPinChange = last.gexCharmPin - first.gexCharmPin;
  const netDeltaSharesChange = last.netDeltaShares - first.netDeltaShares;

  const distanceToPinPct = Number.isFinite(last.gexCharmPin)
    ? Math.abs(last.spot - last.gexCharmPin) / last.spot
    : Number.NaN;

  const marketParts = getMarketParts(last.timestampUtcSec, 'EQUITY');
  const isLateSessionEt =
    marketParts.weekday >= 1 &&
    marketParts.weekday <= 5 &&
    marketParts.minutesOfDay >= lateSessionStartMinutesEt &&
    marketParts.minutesOfDay < RTH_CLOSE_MINUTES_ET;

  let regime: WheelRegimeClassification = 'NEUTRAL';

  if (
    isLateSessionEt &&
    Number.isFinite(distanceToPinPct) &&
    distanceToPinPct <= pinProximityPct
  ) {
    regime = 'PINNING_REGIME';
  } else if (spotReturnPct >= minSpotReturnPct) {
    if (
      Number.isFinite(netDeltaSharesChange) &&
      netDeltaSharesChange > 0 &&
      (!Number.isFinite(gammaFlipChange) || gammaFlipChange >= 0)
    ) {
      regime = 'DERIVATIVES_CONFIRMED_UPTREND';
    } else if (
      Number.isFinite(netDeltaSharesChange) &&
      netDeltaSharesChange < 0 &&
      (!Number.isFinite(gammaFlipChange) || gammaFlipChange <= 0)
    ) {
      regime = 'UNSUPPORTED_SPOT_RALLY';
    }
  } else if (spotReturnPct <= -minSpotReturnPct) {
    if (
      Number.isFinite(netDeltaSharesChange) &&
      netDeltaSharesChange < 0 &&
      (!Number.isFinite(gammaFlipChange) || gammaFlipChange <= 0)
    ) {
      regime = 'DERIVATIVES_CONFIRMED_DOWNTREND';
    } else if (
      Number.isFinite(netDeltaSharesChange) &&
      netDeltaSharesChange > 0 &&
      (!Number.isFinite(gammaFlipChange) || gammaFlipChange >= 0)
    ) {
      regime = 'UNSUPPORTED_SPOT_SELLOFF';
    }
  }

  return {
    asOfUtcSec,
    regime,
    spotChange,
    spotReturnPct,
    gammaFlipChange,
    gexCharmPinChange,
    netDeltaSharesChange,
    distanceToPinPct,
    isLateSessionEt,
    snapshotsCount: causalEntries.length,
  };
}
