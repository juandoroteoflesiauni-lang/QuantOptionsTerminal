/**
 * Motor puro de Flujo Intradía de Opciones OPRA y Detector de Anomalías Vol/OI por MAD.
 *
 * Implementa:
 * 1. Clasificador de agresor Lee-Ready / Quote-Rule sobre prints OPRA (`classifyOpraTradePrint`).
 * 2. Agregación "La Plata Neta de la Rueda": Prima neta direccional, Flujo Delta Neto (en
 *    acciones equivalentes) y Flujo Vega Neto (`computeSignedOptionsOrderFlow`).
 * 3. Detector estratificado de anomalías Vol/OI mediante Log-Ratio MAD por
 *    (DTE bucket x Moneyness bucket x Call/Put) (`detectVolOiAnomaliesMad`).
 *
 * Funciones 100 % puras: cero red, cero E/S, cero UI y cero mutación de argumentos.
 */

import { MAX_TIME_SECONDS } from '../sessions.js';
import { greeksAmericanFiniteDiffOrAnalytical } from './american.js';
import { greeksBsm, SECONDS_PER_YEAR_365 } from './blackScholes.js';
import type { OptionContractType, OptionGreeksResult } from './types.js';

const DEFAULT_SHARES_PER_CONTRACT = 100;
const DEFAULT_MIN_VOLUME = 100;
const DEFAULT_MIN_OPEN_INTEREST = 100;
const DEFAULT_MIN_BUCKET_SIZE = 3;
const DEFAULT_ANOMALY_THRESHOLD_SCORE = 2.5;
const MAD_NORMAL_CONSISTENCY_CONSTANT = 1.4826;
const QUOTE_EPSILON = 1e-12;
const ATM_LOG_MONEYNESS_THRESHOLD = 0.015;
const OTM_LOG_MONEYNESS_THRESHOLD = 0.06;
const SECONDS_PER_DAY = 86_400;

export type OpraTradeSideClassification =
  | 'ASK_SIDE_BUY'
  | 'BID_SIDE_SELL'
  | 'MID_NEUTRAL'
  | 'INVALID_QUOTE';

export interface OpraPrintClassificationResult {
  readonly side: OpraTradeSideClassification;
  readonly aggressorSign: -1 | 0 | 1;
  readonly midpoint: number;
}

export interface OpraTradePrintInput {
  readonly timestampUtcSec: number;
  readonly sipTimestampNs?: number;
  readonly contractTicker?: string;
  readonly underlyingTicker?: string;
  readonly strike: number;
  readonly expiryUtcSec: number;
  readonly contractType: OptionContractType;
  readonly model?: 'bsm' | 'american';
  readonly price: number;
  readonly size: number;
  readonly bid: number;
  readonly ask: number;
  readonly prevPrice?: number;
  readonly sharesPerContract?: number;
  readonly impliedVolatility?: number;
  readonly delta?: number;
  readonly vegaPer1Pct?: number;
}

export interface OpraOrderFlowMarketContext {
  readonly asOfUtcSec: number;
  readonly spot: number;
  readonly rate: number;
  readonly dividendYield: number;
  readonly model?: 'bsm' | 'american';
  readonly secondsPerYear?: number;
}

export interface StrikeOrderFlowBucket {
  readonly strike: number;
  readonly callBuyVolume: number;
  readonly callSellVolume: number;
  readonly putBuyVolume: number;
  readonly putSellVolume: number;
  readonly netCallAggressiveContracts: number;
  readonly netPutAggressiveContracts: number;
  readonly callBuyPremiumUsd: number;
  readonly callSellPremiumUsd: number;
  readonly putBuyPremiumUsd: number;
  readonly putSellPremiumUsd: number;
  readonly netDeltaShares: number;
  readonly netVegaUsd: number;
}

export interface SignedOptionsOrderFlowResult {
  readonly asOfUtcSec: number;
  readonly evaluatedPrints: number;
  readonly skippedPrints: number;
  readonly callBuyPremiumUsd: number;
  readonly callSellPremiumUsd: number;
  readonly callNetPremiumCvdUsd: number;
  readonly putBuyPremiumUsd: number;
  readonly putSellPremiumUsd: number;
  readonly putNetPremiumCvdUsd: number;
  readonly netDirectionalPremiumUsd: number;
  readonly netDeltaShares: number;
  readonly netVegaUsd: number;
  readonly byStrikeFlow: readonly StrikeOrderFlowBucket[];
}

export type DteBucket = '0DTE' | '1_7DTE' | '8_30DTE' | '31_PLUS_DTE';
export type MoneynessBucket = 'ATM' | 'OTM' | 'DEEP_OTM' | 'ITM';

export interface VolOiAnomalyContractInput {
  readonly contractTicker: string;
  readonly strike: number;
  readonly expiryUtcSec: number;
  readonly contractType: OptionContractType;
  readonly model?: 'bsm' | 'american';
  readonly dayVolume: number;
  readonly openInterest: number;
  readonly impliedVolatility: number;
  readonly sharesPerContract?: number;
}

export interface VolOiAnomalyDetectorOptions {
  readonly minVolume?: number;
  readonly minOpenInterest?: number;
  readonly minBucketSize?: number;
  readonly anomalyThresholdScore?: number;
  readonly secondsPerYear?: number;
}

export interface VolOiAnomalyContractResult {
  readonly contractTicker: string;
  readonly strike: number;
  readonly expiryUtcSec: number;
  readonly contractType: OptionContractType;
  readonly dteDays: number;
  readonly dteBucket: DteBucket;
  readonly logMoneynessAbs: number;
  readonly moneynessBucket: MoneynessBucket;
  readonly dayVolume: number;
  readonly openInterest: number;
  readonly volOiRatio: number;
  readonly logVolOiRatio: number;
  readonly bucketMedianLogRatio: number;
  readonly bucketMadLogRatio: number;
  readonly madLogScore: number;
  readonly isAnomaly: boolean;
  readonly delta: number;
  readonly vegaPer1Pct: number;
}

export interface VolOiAnomalyDetectionResult {
  readonly asOfUtcSec: number;
  readonly evaluatedContracts: number;
  readonly skippedContracts: number;
  readonly contracts: readonly VolOiAnomalyContractResult[];
  readonly anomalies: readonly VolOiAnomalyContractResult[];
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

function evaluateGreeks(
  model: 'bsm' | 'american',
  spot: number,
  strike: number,
  timeToExpiry: number,
  rate: number,
  dividendYield: number,
  volatility: number,
  contractType: OptionContractType,
): OptionGreeksResult {
  if (model === 'american') {
    return greeksAmericanFiniteDiffOrAnalytical({
      spot,
      strike,
      timeToExpiry,
      rate,
      dividendYield,
      volatility,
      contractType,
    });
  }
  return greeksBsm({
    spot,
    strike,
    timeToExpiry,
    rate,
    dividendYield,
    volatility,
    contractType,
  });
}

function buildContractKey(print: OpraTradePrintInput): string {
  if (print.contractTicker !== undefined && print.contractTicker.length > 0) {
    return print.contractTicker;
  }
  return `${print.underlyingTicker ?? ''}|${String(print.expiryUtcSec)}|${String(print.strike)}|${print.contractType}`;
}

/**
 * Clasifica un print OPRA comparando el precio ejecutado contra el NBBO vigente.
 * En el midpoint exacto desempata opcionalmente por regla tick respecto a `prevPrice`.
 */
export function classifyOpraTradePrint(
  price: number,
  bid: number,
  ask: number,
  prevPrice?: number,
): OpraPrintClassificationResult {
  if (
    !isPositiveFinite(price) ||
    !isPositiveFinite(bid) ||
    !Number.isFinite(ask) ||
    ask < bid
  ) {
    return {
      side: 'INVALID_QUOTE',
      aggressorSign: 0,
      midpoint: Number.NaN,
    };
  }

  const midpoint = 0.5 * (bid + ask);

  if (ask - bid <= QUOTE_EPSILON) {
    if (price > midpoint + QUOTE_EPSILON) {
      return {
        side: 'ASK_SIDE_BUY',
        aggressorSign: 1,
        midpoint,
      };
    }
    if (price < midpoint - QUOTE_EPSILON) {
      return {
        side: 'BID_SIDE_SELL',
        aggressorSign: -1,
        midpoint,
      };
    }
  } else {
    if (price >= ask - QUOTE_EPSILON || price > midpoint + QUOTE_EPSILON) {
      return {
        side: 'ASK_SIDE_BUY',
        aggressorSign: 1,
        midpoint,
      };
    }

    if (price <= bid + QUOTE_EPSILON || price < midpoint - QUOTE_EPSILON) {
      return {
        side: 'BID_SIDE_SELL',
        aggressorSign: -1,
        midpoint,
      };
    }
  }

  if (prevPrice !== undefined && isPositiveFinite(prevPrice)) {
    if (price > prevPrice + QUOTE_EPSILON) {
      return {
        side: 'ASK_SIDE_BUY',
        aggressorSign: 1,
        midpoint,
      };
    }
    if (price < prevPrice - QUOTE_EPSILON) {
      return {
        side: 'BID_SIDE_SELL',
        aggressorSign: -1,
        midpoint,
      };
    }
  }

  return {
    side: 'MID_NEUTRAL',
    aggressorSign: 0,
    midpoint,
  };
}

interface MutableStrikeBucket {
  readonly strike: number;
  callBuyVolume: number;
  callSellVolume: number;
  putBuyVolume: number;
  putSellVolume: number;
  callBuyPremiumUsd: number;
  callSellPremiumUsd: number;
  putBuyPremiumUsd: number;
  putSellPremiumUsd: number;
  netDeltaShares: number;
  netVegaUsd: number;
}

/**
 * Calcula "La Plata Neta de la Rueda" y el flujo neto de Delta y Vega sobre prints OPRA
 * respetando causalidad estricta (`timestampUtcSec <= context.asOfUtcSec`).
 */
export function computeSignedOptionsOrderFlow(
  prints: readonly OpraTradePrintInput[],
  context: OpraOrderFlowMarketContext,
): SignedOptionsOrderFlowResult {
  assertValidUtcSec(context.asOfUtcSec, 'context.asOfUtcSec');

  const model = context.model ?? 'bsm';
  const secondsPerYear = context.secondsPerYear ?? SECONDS_PER_YEAR_365;
  if (!isPositiveFinite(secondsPerYear)) {
    throw new Error(`secondsPerYear must be positive finite (got ${String(secondsPerYear)})`);
  }

  const causalEntries: { readonly print: OpraTradePrintInput; readonly index: number }[] = [];
  for (let i = 0; i < prints.length; i += 1) {
    const print = prints[i];
    if (print === undefined) {
      continue;
    }
    assertValidUtcSec(print.timestampUtcSec, `prints[${String(i)}].timestampUtcSec`);
    assertValidUtcSec(print.expiryUtcSec, `prints[${String(i)}].expiryUtcSec`);
    if (print.timestampUtcSec <= context.asOfUtcSec) {
      causalEntries.push({ print, index: i });
    }
  }

  causalEntries.sort((a, b) => {
    if (a.print.timestampUtcSec !== b.print.timestampUtcSec) {
      return a.print.timestampUtcSec - b.print.timestampUtcSec;
    }
    const aNs = a.print.sipTimestampNs ?? 0;
    const bNs = b.print.sipTimestampNs ?? 0;
    if (aNs !== bNs) {
      return aNs - bNs;
    }
    return a.index - b.index;
  });

  const lastPriceByContract = new Map<string, number>();
  const strikeMap = new Map<number, MutableStrikeBucket>();

  let evaluatedPrints = 0;
  let skippedPrints = 0;
  let callBuyPremiumUsd = 0;
  let callSellPremiumUsd = 0;
  let putBuyPremiumUsd = 0;
  let putSellPremiumUsd = 0;
  let netDeltaShares = 0;
  let netVegaUsd = 0;

  for (const entry of causalEntries) {
    const print = entry.print;
    const rawType: string = print.contractType;
    if (rawType !== 'call' && rawType !== 'put') {
      skippedPrints += 1;
      continue;
    }
    const contractType: OptionContractType = rawType;

    const contractKey = buildContractKey(print);
    const trackedPrevPrice = print.prevPrice ?? lastPriceByContract.get(contractKey);
    const classification = classifyOpraTradePrint(
      print.price,
      print.bid,
      print.ask,
      trackedPrevPrice,
    );

    if (
      classification.side === 'INVALID_QUOTE' ||
      !isPositiveFinite(print.size) ||
      !isPositiveFinite(print.strike)
    ) {
      skippedPrints += 1;
      continue;
    }

    const sharesPerContract = print.sharesPerContract ?? DEFAULT_SHARES_PER_CONTRACT;
    if (!isPositiveFinite(sharesPerContract)) {
      skippedPrints += 1;
      continue;
    }

    let delta = Number.NaN;
    let vegaPer1Pct = Number.NaN;

    if (
      print.delta !== undefined &&
      Number.isFinite(print.delta) &&
      print.vegaPer1Pct !== undefined &&
      Number.isFinite(print.vegaPer1Pct)
    ) {
      delta = print.delta;
      vegaPer1Pct = print.vegaPer1Pct;
    } else if (
      print.impliedVolatility !== undefined &&
      isPositiveFinite(print.impliedVolatility) &&
      isPositiveFinite(context.spot) &&
      Number.isFinite(context.rate) &&
      Number.isFinite(context.dividendYield)
    ) {
      const tauYears = (print.expiryUtcSec - print.timestampUtcSec) / secondsPerYear;
      if (isPositiveFinite(tauYears)) {
        const greeks = evaluateGreeks(
          print.model ?? model,
          context.spot,
          print.strike,
          tauYears,
          context.rate,
          context.dividendYield,
          print.impliedVolatility,
          contractType,
        );
        delta = greeks.delta;
        vegaPer1Pct = greeks.vegaPer1Pct;
      }
    }

    if (!Number.isFinite(delta) || !Number.isFinite(vegaPer1Pct)) {
      skippedPrints += 1;
      continue;
    }

    lastPriceByContract.set(contractKey, print.price);
    evaluatedPrints += 1;

    const aggressorSign = classification.aggressorSign;
    const premiumUsd = print.price * print.size * sharesPerContract;
    const printDeltaShares = print.size * sharesPerContract * delta * aggressorSign;
    const printVegaUsd = print.size * sharesPerContract * vegaPer1Pct * aggressorSign;

    let bucket = strikeMap.get(print.strike);
    if (bucket === undefined) {
      bucket = {
        strike: print.strike,
        callBuyVolume: 0,
        callSellVolume: 0,
        putBuyVolume: 0,
        putSellVolume: 0,
        callBuyPremiumUsd: 0,
        callSellPremiumUsd: 0,
        putBuyPremiumUsd: 0,
        putSellPremiumUsd: 0,
        netDeltaShares: 0,
        netVegaUsd: 0,
      };
      strikeMap.set(print.strike, bucket);
    }

    if (contractType === 'call') {
      if (aggressorSign === 1) {
        callBuyPremiumUsd += premiumUsd;
        bucket.callBuyVolume += print.size;
        bucket.callBuyPremiumUsd += premiumUsd;
      } else if (aggressorSign === -1) {
        callSellPremiumUsd += premiumUsd;
        bucket.callSellVolume += print.size;
        bucket.callSellPremiumUsd += premiumUsd;
      }
    } else if (aggressorSign === 1) {
      putBuyPremiumUsd += premiumUsd;
      bucket.putBuyVolume += print.size;
      bucket.putBuyPremiumUsd += premiumUsd;
    } else if (aggressorSign === -1) {
      putSellPremiumUsd += premiumUsd;
      bucket.putSellVolume += print.size;
      bucket.putSellPremiumUsd += premiumUsd;
    }

    netDeltaShares += printDeltaShares;
    netVegaUsd += printVegaUsd;
    bucket.netDeltaShares += printDeltaShares;
    bucket.netVegaUsd += printVegaUsd;
  }

  if (evaluatedPrints === 0) {
    return {
      asOfUtcSec: context.asOfUtcSec,
      evaluatedPrints: 0,
      skippedPrints,
      callBuyPremiumUsd: Number.NaN,
      callSellPremiumUsd: Number.NaN,
      callNetPremiumCvdUsd: Number.NaN,
      putBuyPremiumUsd: Number.NaN,
      putSellPremiumUsd: Number.NaN,
      putNetPremiumCvdUsd: Number.NaN,
      netDirectionalPremiumUsd: Number.NaN,
      netDeltaShares: Number.NaN,
      netVegaUsd: Number.NaN,
      byStrikeFlow: [],
    };
  }

  const byStrikeFlow: StrikeOrderFlowBucket[] = Array.from(strikeMap.values())
    .sort((a, b) => a.strike - b.strike)
    .map((bucket) => ({
      strike: bucket.strike,
      callBuyVolume: bucket.callBuyVolume,
      callSellVolume: bucket.callSellVolume,
      putBuyVolume: bucket.putBuyVolume,
      putSellVolume: bucket.putSellVolume,
      netCallAggressiveContracts: bucket.callBuyVolume - bucket.callSellVolume,
      netPutAggressiveContracts: bucket.putBuyVolume - bucket.putSellVolume,
      callBuyPremiumUsd: bucket.callBuyPremiumUsd,
      callSellPremiumUsd: bucket.callSellPremiumUsd,
      putBuyPremiumUsd: bucket.putBuyPremiumUsd,
      putSellPremiumUsd: bucket.putSellPremiumUsd,
      netDeltaShares: bucket.netDeltaShares,
      netVegaUsd: bucket.netVegaUsd,
    }));

  const callNetPremiumCvdUsd = callBuyPremiumUsd - callSellPremiumUsd;
  const putNetPremiumCvdUsd = putBuyPremiumUsd - putSellPremiumUsd;
  const netDirectionalPremiumUsd = callNetPremiumCvdUsd - putNetPremiumCvdUsd;

  return {
    asOfUtcSec: context.asOfUtcSec,
    evaluatedPrints,
    skippedPrints,
    callBuyPremiumUsd,
    callSellPremiumUsd,
    callNetPremiumCvdUsd,
    putBuyPremiumUsd,
    putSellPremiumUsd,
    putNetPremiumCvdUsd,
    netDirectionalPremiumUsd,
    netDeltaShares,
    netVegaUsd,
    byStrikeFlow,
  };
}

function classifyDteBucket(dteDays: number): DteBucket {
  if (dteDays <= 0) {
    return '0DTE';
  }
  if (dteDays <= 7) {
    return '1_7DTE';
  }
  if (dteDays <= 30) {
    return '8_30DTE';
  }
  return '31_PLUS_DTE';
}

function classifyMoneynessBucket(
  strike: number,
  spot: number,
  contractType: OptionContractType,
  logMoneynessAbs: number,
): MoneynessBucket {
  if (logMoneynessAbs <= ATM_LOG_MONEYNESS_THRESHOLD) {
    return 'ATM';
  }
  const isItm =
    (contractType === 'call' && strike < spot) ||
    (contractType === 'put' && strike > spot);
  if (isItm) {
    return 'ITM';
  }
  if (logMoneynessAbs <= OTM_LOG_MONEYNESS_THRESHOLD) {
    return 'OTM';
  }
  return 'DEEP_OTM';
}

function computeMedian(values: readonly number[]): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    const val = sorted[mid];
    return val ?? Number.NaN;
  }
  const left = sorted[mid - 1];
  const right = sorted[mid];
  if (left === undefined || right === undefined) {
    return Number.NaN;
  }
  return 0.5 * (left + right);
}

interface PreparedAnomalyContract {
  readonly index: number;
  readonly contractTicker: string;
  readonly strike: number;
  readonly expiryUtcSec: number;
  readonly contractType: OptionContractType;
  readonly dteDays: number;
  readonly dteBucket: DteBucket;
  readonly logMoneynessAbs: number;
  readonly moneynessBucket: MoneynessBucket;
  readonly dayVolume: number;
  readonly openInterest: number;
  readonly volOiRatio: number;
  readonly logVolOiRatio: number;
  readonly delta: number;
  readonly vegaPer1Pct: number;
  readonly bucketKey: string;
}

/**
 * Detecta actividad inusual de volumen vs. open interest estratificando por
 * `(dteBucket, moneynessBucket, contractType)` y calculando Z-score robusto mediante MAD.
 */
export function detectVolOiAnomaliesMad(
  contracts: readonly VolOiAnomalyContractInput[],
  context: OpraOrderFlowMarketContext,
  options?: VolOiAnomalyDetectorOptions,
): VolOiAnomalyDetectionResult {
  assertValidUtcSec(context.asOfUtcSec, 'context.asOfUtcSec');

  const model = context.model ?? 'bsm';
  const minVolume = options?.minVolume ?? DEFAULT_MIN_VOLUME;
  const minOpenInterest = options?.minOpenInterest ?? DEFAULT_MIN_OPEN_INTEREST;
  const minBucketSize = options?.minBucketSize ?? DEFAULT_MIN_BUCKET_SIZE;
  const anomalyThresholdScore =
    options?.anomalyThresholdScore ?? DEFAULT_ANOMALY_THRESHOLD_SCORE;
  const secondsPerYear = options?.secondsPerYear ?? SECONDS_PER_YEAR_365;

  if (!isPositiveFinite(secondsPerYear)) {
    throw new Error(`secondsPerYear must be positive finite (got ${String(secondsPerYear)})`);
  }

  const canEvaluateMarket =
    isPositiveFinite(context.spot) &&
    Number.isFinite(context.rate) &&
    Number.isFinite(context.dividendYield);

  const preparedList: PreparedAnomalyContract[] = [];
  const groups = new Map<string, PreparedAnomalyContract[]>();
  let skippedContracts = 0;

  for (let i = 0; i < contracts.length; i += 1) {
    const contract = contracts[i];
    if (contract === undefined) {
      continue;
    }

    assertValidUtcSec(contract.expiryUtcSec, `contracts[${String(i)}].expiryUtcSec`);

    const rawType: string = contract.contractType;
    if (
      !canEvaluateMarket ||
      (rawType !== 'call' && rawType !== 'put') ||
      !isPositiveFinite(contract.strike) ||
      !Number.isFinite(contract.dayVolume) ||
      contract.dayVolume < minVolume ||
      contract.dayVolume <= 0 ||
      !Number.isFinite(contract.openInterest) ||
      contract.openInterest < minOpenInterest ||
      contract.openInterest <= 0 ||
      !isPositiveFinite(contract.impliedVolatility) ||
      contract.expiryUtcSec <= context.asOfUtcSec
    ) {
      skippedContracts += 1;
      continue;
    }

    const contractType: OptionContractType = rawType;
    const sharesPerContract = contract.sharesPerContract ?? DEFAULT_SHARES_PER_CONTRACT;
    if (!isPositiveFinite(sharesPerContract)) {
      skippedContracts += 1;
      continue;
    }

    const remainingSec = contract.expiryUtcSec - context.asOfUtcSec;
    const tauYears = remainingSec / secondsPerYear;
    const greeks = evaluateGreeks(
      contract.model ?? model,
      context.spot,
      contract.strike,
      tauYears,
      context.rate,
      context.dividendYield,
      contract.impliedVolatility,
      contractType,
    );

    if (!Number.isFinite(greeks.delta) || !Number.isFinite(greeks.vegaPer1Pct)) {
      skippedContracts += 1;
      continue;
    }

    const dteDays = Math.max(0, Math.floor(remainingSec / SECONDS_PER_DAY));
    const dteBucket = classifyDteBucket(dteDays);
    const logMoneynessAbs = Math.abs(Math.log(contract.strike / context.spot));
    const moneynessBucket = classifyMoneynessBucket(
      contract.strike,
      context.spot,
      contractType,
      logMoneynessAbs,
    );
    const volOiRatio = contract.dayVolume / contract.openInterest;
    const logVolOiRatio = Math.log(volOiRatio);
    const bucketKey = `${dteBucket}|${moneynessBucket}|${contractType}`;

    const item: PreparedAnomalyContract = {
      index: i,
      contractTicker: contract.contractTicker,
      strike: contract.strike,
      expiryUtcSec: contract.expiryUtcSec,
      contractType,
      dteDays,
      dteBucket,
      logMoneynessAbs,
      moneynessBucket,
      dayVolume: contract.dayVolume,
      openInterest: contract.openInterest,
      volOiRatio,
      logVolOiRatio,
      delta: greeks.delta,
      vegaPer1Pct: greeks.vegaPer1Pct,
      bucketKey,
    };

    preparedList.push(item);
    let group = groups.get(bucketKey);
    if (group === undefined) {
      group = [];
      groups.set(bucketKey, group);
    }
    group.push(item);
  }

  const bucketStats = new Map<
    string,
    { readonly medianLogRatio: number; readonly madLogRatio: number; readonly validCount: number }
  >();

  for (const [key, group] of groups.entries()) {
    if (group.length < minBucketSize) {
      bucketStats.set(key, {
        medianLogRatio: Number.NaN,
        madLogRatio: Number.NaN,
        validCount: group.length,
      });
      continue;
    }

    const logRatios = group.map((g) => g.logVolOiRatio);
    const medianLogRatio = computeMedian(logRatios);
    const absDevs = logRatios.map((x) => Math.abs(x - medianLogRatio));
    const madLogRatio = computeMedian(absDevs);
    bucketStats.set(key, {
      medianLogRatio,
      madLogRatio,
      validCount: group.length,
    });
  }

  const results: VolOiAnomalyContractResult[] = preparedList.map((item) => {
    const stats = bucketStats.get(item.bucketKey);
    const medianLogRatio = stats?.medianLogRatio ?? Number.NaN;
    const madLogRatio = stats?.madLogRatio ?? Number.NaN;

    let madLogScore = Number.NaN;
    let isAnomaly = false;
    if (
      stats !== undefined &&
      stats.validCount >= minBucketSize &&
      Number.isFinite(madLogRatio) &&
      madLogRatio > 0
    ) {
      madLogScore =
        (item.logVolOiRatio - medianLogRatio) /
        (MAD_NORMAL_CONSISTENCY_CONSTANT * madLogRatio);
      isAnomaly = madLogScore >= anomalyThresholdScore;
    }

    return {
      contractTicker: item.contractTicker,
      strike: item.strike,
      expiryUtcSec: item.expiryUtcSec,
      contractType: item.contractType,
      dteDays: item.dteDays,
      dteBucket: item.dteBucket,
      logMoneynessAbs: item.logMoneynessAbs,
      moneynessBucket: item.moneynessBucket,
      dayVolume: item.dayVolume,
      openInterest: item.openInterest,
      volOiRatio: item.volOiRatio,
      logVolOiRatio: item.logVolOiRatio,
      bucketMedianLogRatio: medianLogRatio,
      bucketMadLogRatio: madLogRatio,
      madLogScore,
      isAnomaly,
      delta: item.delta,
      vegaPer1Pct: item.vegaPer1Pct,
    };
  });

  const anomalies = results
    .filter((r) => r.isAnomaly)
    .sort((a, b) => {
      if (b.madLogScore !== a.madLogScore) {
        return b.madLogScore - a.madLogScore;
      }
      return a.contractTicker.localeCompare(b.contractTicker);
    });

  return {
    asOfUtcSec: context.asOfUtcSec,
    evaluatedContracts: results.length,
    skippedContracts,
    contracts: results,
    anomalies,
  };
}
