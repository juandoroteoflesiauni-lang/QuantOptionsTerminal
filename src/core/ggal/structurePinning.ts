/**
 * Motor 4 — Estructura Anexo B IAMC (en acciones nominales), Signed GEX/Vanna/Charm,
 * Nivel Zero-Gamma (Brent), Call/Put Wall, Flujo Intradiario Lee-Ready (cinta ADR +
 * proxy discreto BYMA 20s) y Monitor Pinning 15:30 ART (Secciones 4.2 y 5.4).
 *
 * Funciones 100 % puras: cero red, cero E/S, cero UI y cero mutación de argumentos.
 */

import {
  classifyTradesLeeReady,
  type LeeReadyQuoteInput,
  type LeeReadyTradeInput,
} from '../microstructure/leeReadyBook.js';
import {
  brentRoot,
  clamp,
  computeExpiration1530ArtUtcSec,
  countTradingDaysBetween,
  formatIsoUtcFromSec,
  getBuenosAiresParts,
  isPositiveFinite,
  isValidUtcSec,
  quoteMid,
  type BidAskQuote,
} from './types.js';
import {
  computeBymaOptionEvalParams,
  greeksBymaAmericanBs02,
  type BymaOptionEvalParams,
  type BymaOptionEvalParamsInput,
} from './volTriangle.js';

export type StructurePinningRegime =
  | 'POSITIVE_GAMMA_MEAN_REVERTING'
  | 'NEGATIVE_GAMMA_TRENDING'
  | 'PIN_LOCKED'
  | 'NO_DATA';

export type LeeReadyConfidenceMode = 'TICK_TAPE' | 'SNAPSHOT_20S_APPROX';

export interface AnexoBWeights {
  /** Posiciones descubiertas (alto delta-hedge). */
  readonly wUncovered: number;
  /** Posiciones cruzadas / operaciones a plazo. */
  readonly wCrossed: number;
  /** Posiciones opuestas (spreads verticales). */
  readonly wOpposite: number;
  /** Posiciones cubiertas / Call Overwriting (bajo rebalanceo delta). */
  readonly wCovered: number;
}

export const DEFAULT_ANEXO_B_WEIGHTS: AnexoBWeights = {
  wUncovered: 1.0,
  wCrossed: 0.75,
  wOpposite: 0.35,
  wCovered: 0.025,
};

export interface AnexoBOiBuckets {
  readonly coveredNom: number;
  readonly uncoveredNom: number;
  readonly oppositeNom: number;
  readonly crossedNom: number;
}

export interface AnexoBStrikeChainInput {
  readonly strikeArs: number;
  readonly callOi: AnexoBOiBuckets;
  readonly putOi: AnexoBOiBuckets;
  readonly callIvDecimal: number;
  readonly putIvDecimal: number;
  /** Desequilibrio firmado Lee-Ready en [-1, +1] (+ compras agresoras, - ventas agresoras). */
  readonly callFlowImbalance?: number;
  readonly putFlowImbalance?: number;
}

export interface BymaSnapshotFlowPoint {
  readonly time: number;
  readonly bid: number;
  readonly ask: number;
  readonly last: number;
  readonly cumVolumeShares: number;
}

export interface StructurePinningInput {
  readonly asOfUtcSec: number;
  readonly anexoBAsOfDate: string;
  readonly bymaEval: BymaOptionEvalParamsInput;
  readonly atmIvDecimal: number;
  readonly strikes: readonly AnexoBStrikeChainInput[];
  readonly weights?: AnexoBWeights;
  readonly callStructuralSign?: number;
  readonly putStructuralSign?: number;
  readonly flowSignWeight?: number;
  readonly etaCharm?: number;
  readonly pinScoreThreshold?: number;
  readonly pinWindowMinutesBeforeCutoff?: number;
  readonly arHolidays?: readonly string[];
  /** Flujo ADR en cinta EE. UU. para Lee-Ready exacto. */
  readonly adrTrades?: readonly LeeReadyTradeInput[];
  readonly adrQuotes?: readonly LeeReadyQuoteInput[];
  /** Flujo discreto BYMA mediante snapshots sucesivos (~20s). */
  readonly bymaSnapshots?: readonly BymaSnapshotFlowPoint[];
  /** Alternativa directa para BYMA si no se pasa serie de snapshots. */
  readonly bymaNetSignedArsOverride?: number;
}

export interface StrikeStructureProfileItem {
  readonly strikeArs: number;
  readonly oiCoveredNom: number;
  readonly oiUncoveredNom: number;
  readonly oiOppositeNom: number;
  readonly oiCrossedNom: number;
  readonly callEffectiveOiNom: number;
  readonly putEffectiveOiNom: number;
  readonly callSignedGexArs: number;
  readonly putSignedGexArs: number;
  readonly effectiveSignedGex: number;
  readonly vannaExpArs: number;
  readonly charmExpArs: number;
  readonly pinScore: number;
}

export interface StructurePinningOutput {
  readonly timestampUtc: string;
  readonly asOfUtcSec: number;
  readonly anexoBAsOfDate: string;
  readonly anexoBLagTradingDays: number;
  readonly isExpiryDay: boolean;
  readonly minutesTo1530Cutoff: number | null;
  readonly regime: StructurePinningRegime;
  readonly zeroGammaLevelArs: number;
  readonly callWallArs: number;
  readonly putWallArs: number;
  readonly peakPinStrikeArs: number;
  readonly maxPinScore: number;
  readonly maxUncoveredCrossedConcentrationPct: number;
  readonly netEffectiveGexArsPer1Pct: number;
  readonly netVannaArsPerVolPt: number;
  readonly netCharmArsPerDay: number;
  readonly intradayFlow: {
    readonly bymaNetSignedArs: number;
    readonly adrNetSignedUsd: number;
    readonly leeReadyConfidence: LeeReadyConfidenceMode;
  };
  readonly strikeProfile: readonly StrikeStructureProfileItem[];
}

const ONE_PCT = 0.01;
const DAYS_IN_YEAR = 365;
const MINUTES_PER_YEAR = 365 * 1440;
const PIN_CUTOFF_WINDOW_MIN = 240; // Últimas 4 horas antes de 15:30 ART
const DEFAULT_PIN_THRESHOLD = 0.35;
const DEFAULT_ETA_CHARM = 0.25;
const DEFAULT_FLOW_WEIGHT = 0.5;

/**
 * OI efectivo IAMC en acciones nominales (SIN multiplicar por 100).
 */
export function computeEffectiveAnexoBOi(
  oi: AnexoBOiBuckets,
  weights: AnexoBWeights = DEFAULT_ANEXO_B_WEIGHTS,
): number {
  const vals = [
    oi.uncoveredNom,
    oi.crossedNom,
    oi.oppositeNom,
    oi.coveredNom,
    weights.wUncovered,
    weights.wCrossed,
    weights.wOpposite,
    weights.wCovered,
  ];
  if (vals.some((v) => !Number.isFinite(v) || v < 0)) {
    return Number.NaN;
  }
  return (
    weights.wUncovered * oi.uncoveredNom +
    weights.wCrossed * oi.crossedNom +
    weights.wOpposite * oi.oppositeNom +
    weights.wCovered * oi.coveredNom
  );
}

/**
 * Proxy discreto Lee-Ready para BYMA usando incrementos de volumen entre instantáneas sucesivas.
 */
export function computeBymaSnapshotApproxSignedFlow(
  snapshots: readonly BymaSnapshotFlowPoint[],
  asOfUtcSec: number,
): number {
  if (!isValidUtcSec(asOfUtcSec)) {
    return Number.NaN;
  }
  const causal = snapshots
    .filter(
      (s) =>
        isValidUtcSec(s.time) &&
        s.time <= asOfUtcSec &&
        Number.isFinite(s.bid) &&
        Number.isFinite(s.ask) &&
        s.bid > 0 &&
        s.ask >= s.bid &&
        isPositiveFinite(s.last) &&
        Number.isFinite(s.cumVolumeShares) &&
        s.cumVolumeShares >= 0,
    )
    .slice()
    .sort((a, b) => a.time - b.time);

  if (causal.length < 2) {
    return 0;
  }

  let netSignedArs = 0;
  let lastSign = 0;
  for (let i = 1; i < causal.length; i += 1) {
    const prev = causal[i - 1];
    const cur = causal[i];
    if (prev === undefined || cur === undefined) {
      continue;
    }
    const dVol = cur.cumVolumeShares - prev.cumVolumeShares;
    if (dVol <= 0) {
      continue;
    }
    const prevQuote: BidAskQuote = { bid: prev.bid, ask: prev.ask };
    const prevMid = quoteMid(prevQuote);
    let sign = 0;
    if (Number.isFinite(prevMid)) {
      if (cur.last > prevMid) {
        sign = 1;
      } else if (cur.last < prevMid) {
        sign = -1;
      } else if (cur.last > prev.last) {
        sign = 1;
      } else if (cur.last < prev.last) {
        sign = -1;
      } else {
        sign = lastSign;
      }
    }
    if (sign !== 0) {
      lastSign = sign;
    }
    netSignedArs += sign * cur.last * dVol;
  }
  return netSignedArs;
}

function dealerSign(
  structuralSign: number,
  flowImbalance: number | undefined,
  flowWeight: number,
): number {
  if (flowImbalance === undefined || !Number.isFinite(flowImbalance)) {
    return structuralSign;
  }
  // Si el cliente compra agresivamente (+psi), el MM toma el lado contrario (-psi).
  const clampedPsi = clamp(flowImbalance, -1, 1);
  return clamp((1 - flowWeight) * structuralSign + flowWeight * -clampedPsi, -1, 1);
}

/**
 * Evaluador principal del Motor 4: Anexo B ponderado, Signed GEX/Vanna/Charm, Zero-Gamma y Pinning 15:30 ART.
 */
export function evaluateStructureAndPinning(
  input: StructurePinningInput,
): StructurePinningOutput {
  if (!isValidUtcSec(input.asOfUtcSec)) {
    throw new Error(`asOfUtcSec must be valid integer UTC seconds (got ${String(input.asOfUtcSec)})`);
  }

  const art = getBuenosAiresParts(input.asOfUtcSec);
  const arHolidaySet = new Set(input.arHolidays ?? []);
  const anexoBLagTradingDays = countTradingDaysBetween(
    input.anexoBAsOfDate,
    art.dateKey,
    arHolidaySet,
  );

  const isExpiryDay = art.dateKey === input.bymaEval.expiryDateKey;
  const expiry1530UtcSec =
    input.bymaEval.expiry1530UtcSec ?? computeExpiration1530ArtUtcSec(input.bymaEval.expiryDateKey);
  const minutesTo1530Cutoff =
    isExpiryDay && isValidUtcSec(expiry1530UtcSec) && input.asOfUtcSec <= expiry1530UtcSec
      ? (expiry1530UtcSec - input.asOfUtcSec) / 60
      : null;

  const evalParams = computeBymaOptionEvalParams(input.bymaEval);
  const weights = input.weights ?? DEFAULT_ANEXO_B_WEIGHTS;
  const callStruct = input.callStructuralSign ?? 1;
  const putStruct = input.putStructuralSign ?? -1;
  const flowWeight = clamp(input.flowSignWeight ?? DEFAULT_FLOW_WEIGHT, 0, 1);
  const etaCharm = input.etaCharm ?? DEFAULT_ETA_CHARM;

  // Flujo intradiario ADR (Lee-Ready exacto) y BYMA (snapshot 20s)
  let adrNetSignedUsd = 0;
  let hasAdrTickTape = false;
  if (input.adrTrades !== undefined && input.adrTrades.length > 0 && input.adrQuotes !== undefined) {
    const lr = classifyTradesLeeReady(input.adrTrades, input.adrQuotes, {
      allowTickFallbackWithoutQuote: true,
    });
    if (lr.status === 'OK') {
      hasAdrTickTape = true;
      for (const ct of lr.classifiedTrades) {
        adrNetSignedUsd += ct.sign * ct.price * ct.size;
      }
    }
  }
  const bymaNetSignedArs =
    input.bymaNetSignedArsOverride ??
    (input.bymaSnapshots !== undefined
      ? computeBymaSnapshotApproxSignedFlow(input.bymaSnapshots, input.asOfUtcSec)
      : 0);

  const leeReadyConfidence: LeeReadyConfidenceMode =
    hasAdrTickTape && input.bymaSnapshots === undefined ? 'TICK_TAPE' : 'SNAPSHOT_20S_APPROX';

  const emptyOutput: StructurePinningOutput = {
    timestampUtc: formatIsoUtcFromSec(input.asOfUtcSec),
    asOfUtcSec: input.asOfUtcSec,
    anexoBAsOfDate: input.anexoBAsOfDate,
    anexoBLagTradingDays,
    isExpiryDay,
    minutesTo1530Cutoff,
    regime: 'NO_DATA',
    zeroGammaLevelArs: Number.NaN,
    callWallArs: Number.NaN,
    putWallArs: Number.NaN,
    peakPinStrikeArs: Number.NaN,
    maxPinScore: Number.NaN,
    maxUncoveredCrossedConcentrationPct: Number.NaN,
    netEffectiveGexArsPer1Pct: Number.NaN,
    netVannaArsPerVolPt: Number.NaN,
    netCharmArsPerDay: Number.NaN,
    intradayFlow: {
      bymaNetSignedArs,
      adrNetSignedUsd,
      leeReadyConfidence,
    },
    strikeProfile: [],
  };

  if (evalParams === null || input.strikes.length === 0 || !isPositiveFinite(input.atmIvDecimal)) {
    return emptyOutput;
  }

  const spotArs = evalParams.spot24hArs;
  const spotSq = spotArs * spotArs;
  const sortedRows = input.strikes
    .filter((r) => isPositiveFinite(r.strikeArs))
    .slice()
    .sort((a, b) => a.strikeArs - b.strikeArs);

  if (sortedRows.length === 0) {
    return emptyOutput;
  }

  let totalNetGex = 0;
  let totalNetVanna = 0;
  let totalNetCharm = 0;
  let callWallArs = Number.NaN;
  let bestCallWallMag = -1;
  let putWallArs = Number.NaN;
  let bestPutWallMag = -1;
  let totalUncovCrossAll = 0;
  let maxUncovCrossStrike = 0;

  const tauPinYears =
    minutesTo1530Cutoff !== null
      ? Math.max(1 / MINUTES_PER_YEAR, minutesTo1530Cutoff / MINUTES_PER_YEAR)
      : Math.max(1 / MINUTES_PER_YEAR, evalParams.tExpYears);

  const interim: {
    readonly strikeArs: number;
    readonly oiCoveredNom: number;
    readonly oiUncoveredNom: number;
    readonly oiOppositeNom: number;
    readonly oiCrossedNom: number;
    readonly callEffectiveOiNom: number;
    readonly putEffectiveOiNom: number;
    readonly callSignedGexArs: number;
    readonly putSignedGexArs: number;
    readonly effectiveSignedGex: number;
    readonly vannaExpArs: number;
    readonly charmExpArs: number;
    readonly sgnCall: number;
    readonly sgnPut: number;
    readonly callIvDecimal: number;
    readonly putIvDecimal: number;
    readonly rawAttraction: number;
  }[] = [];

  let positiveOiLegs = 0;
  let evaluatedPositiveOiLegs = 0;
  let failedPositiveOiLegs = 0;

  for (const row of sortedRows) {
    const callEffOi = computeEffectiveAnexoBOi(row.callOi, weights);
    const putEffOi = computeEffectiveAnexoBOi(row.putOi, weights);
    if (!Number.isFinite(callEffOi) || !Number.isFinite(putEffOi)) {
      return emptyOutput;
    }

    const sgnCall = dealerSign(callStruct, row.callFlowImbalance, flowWeight);
    const sgnPut = dealerSign(putStruct, row.putFlowImbalance, flowWeight);

    let callSignedGex = 0;
    let callVanna = 0;
    let callCharm = 0;
    let callWallMetric = 0;
    if (callEffOi > 0) {
      positiveOiLegs += 1;
      if (isPositiveFinite(row.callIvDecimal)) {
        const g = greeksBymaAmericanBs02(evalParams, row.strikeArs, row.callIvDecimal, 'call');
        if (Number.isFinite(g.gamma)) {
          evaluatedPositiveOiLegs += 1;
          callWallMetric = callEffOi * g.gamma * spotSq * ONE_PCT;
          callSignedGex = sgnCall * callWallMetric;
          callVanna = sgnCall * callEffOi * g.vanna * spotArs * ONE_PCT;
          callCharm = sgnCall * callEffOi * g.charm * (spotArs / DAYS_IN_YEAR);
        } else {
          failedPositiveOiLegs += 1;
        }
      } else {
        failedPositiveOiLegs += 1;
      }
    }

    let putSignedGex = 0;
    let putVanna = 0;
    let putCharm = 0;
    let putWallMetric = 0;
    if (putEffOi > 0) {
      positiveOiLegs += 1;
      if (isPositiveFinite(row.putIvDecimal)) {
        const g = greeksBymaAmericanBs02(evalParams, row.strikeArs, row.putIvDecimal, 'put');
        if (Number.isFinite(g.gamma)) {
          evaluatedPositiveOiLegs += 1;
          putWallMetric = putEffOi * g.gamma * spotSq * ONE_PCT;
          putSignedGex = sgnPut * putWallMetric;
          putVanna = sgnPut * putEffOi * g.vanna * spotArs * ONE_PCT;
          putCharm = sgnPut * putEffOi * g.charm * (spotArs / DAYS_IN_YEAR);
        } else {
          failedPositiveOiLegs += 1;
        }
      } else {
        failedPositiveOiLegs += 1;
      }
    }

    if (callWallMetric > bestCallWallMag && callWallMetric > 0) {
      bestCallWallMag = callWallMetric;
      callWallArs = row.strikeArs;
    }
    if (putWallMetric > bestPutWallMag && putWallMetric > 0) {
      bestPutWallMag = putWallMetric;
      putWallArs = row.strikeArs;
    }

    const effectiveSignedGex = callSignedGex + putSignedGex;
    const vannaExpArs = callVanna + putVanna;
    const charmExpArs = callCharm + putCharm;
    totalNetGex += effectiveSignedGex;
    totalNetVanna += vannaExpArs;
    totalNetCharm += charmExpArs;

    const oiCoveredNom = row.callOi.coveredNom + row.putOi.coveredNom;
    const oiUncoveredNom = row.callOi.uncoveredNom + row.putOi.uncoveredNom;
    const oiOppositeNom = row.callOi.oppositeNom + row.putOi.oppositeNom;
    const oiCrossedNom = row.callOi.crossedNom + row.putOi.crossedNom;

    const uncovCrossStrike = oiUncoveredNom + oiCrossedNom;
    totalUncovCrossAll += uncovCrossStrike;
    if (uncovCrossStrike > maxUncovCrossStrike) {
      maxUncovCrossStrike = uncovCrossStrike;
    }

    const dist = spotArs - row.strikeArs;
    const gauss = Math.exp(
      -(dist * dist) / (2 * input.atmIvDecimal * input.atmIvDecimal * tauPinYears * spotSq),
    );
    const rawAttraction = Math.abs(effectiveSignedGex) * gauss + etaCharm * Math.abs(charmExpArs);

    interim.push({
      strikeArs: row.strikeArs,
      oiCoveredNom,
      oiUncoveredNom,
      oiOppositeNom,
      oiCrossedNom,
      callEffectiveOiNom: callEffOi,
      putEffectiveOiNom: putEffOi,
      callSignedGexArs: callSignedGex,
      putSignedGexArs: putSignedGex,
      effectiveSignedGex,
      vannaExpArs,
      charmExpArs,
      sgnCall,
      sgnPut,
      callIvDecimal: row.callIvDecimal,
      putIvDecimal: row.putIvDecimal,
      rawAttraction,
    });
  }

  if (failedPositiveOiLegs > 0 && evaluatedPositiveOiLegs === 0) {
    return emptyOutput;
  }

  const totalAttraction = interim.reduce((acc, r) => acc + r.rawAttraction, 0);
  let maxPinScore = 0;
  let peakPinStrikeArs = Number.NaN;
  const strikeProfile: StrikeStructureProfileItem[] = interim.map((r) => {
    const pinScore = isPositiveFinite(totalAttraction) ? r.rawAttraction / totalAttraction : 0;
    if (pinScore > maxPinScore) {
      maxPinScore = pinScore;
      peakPinStrikeArs = r.strikeArs;
    }
    return {
      strikeArs: r.strikeArs,
      oiCoveredNom: r.oiCoveredNom,
      oiUncoveredNom: r.oiUncoveredNom,
      oiOppositeNom: r.oiOppositeNom,
      oiCrossedNom: r.oiCrossedNom,
      callEffectiveOiNom: r.callEffectiveOiNom,
      putEffectiveOiNom: r.putEffectiveOiNom,
      callSignedGexArs: r.callSignedGexArs,
      putSignedGexArs: r.putSignedGexArs,
      effectiveSignedGex: r.effectiveSignedGex,
      vannaExpArs: r.vannaExpArs,
      charmExpArs: r.charmExpArs,
      pinScore,
    };
  });

  // Zero-Gamma Level por Brent buscando el cambio de signo de NetGex(S') más cercano al spot
  const evalNetGexAtSpot = (candSpot24h: number): number => {
    const shiftedAdj =
      candSpot24h * Math.exp(-evalParams.r1Continuous * evalParams.t1Years) -
      evalParams.pvDividendsArs;
    if (!isPositiveFinite(shiftedAdj)) {
      return Number.NaN;
    }
    const shiftedParams: BymaOptionEvalParams = {
      ...evalParams,
      spot24hArs: candSpot24h,
      adjustedSpotArs: shiftedAdj,
      forwardArs: shiftedAdj * Math.exp(evalParams.rEff * evalParams.tExpYears),
    };
    const candSq = candSpot24h * candSpot24h;
    let sumGex = 0;
    for (const r of interim) {
      if (r.callEffectiveOiNom > 0 && isPositiveFinite(r.callIvDecimal)) {
        const g = greeksBymaAmericanBs02(shiftedParams, r.strikeArs, r.callIvDecimal, 'call');
        if (Number.isFinite(g.gamma)) {
          sumGex += r.sgnCall * r.callEffectiveOiNom * g.gamma * candSq * ONE_PCT;
        }
      }
      if (r.putEffectiveOiNom > 0 && isPositiveFinite(r.putIvDecimal)) {
        const g = greeksBymaAmericanBs02(shiftedParams, r.strikeArs, r.putIvDecimal, 'put');
        if (Number.isFinite(g.gamma)) {
          sumGex += r.sgnPut * r.putEffectiveOiNom * g.gamma * candSq * ONE_PCT;
        }
      }
    }
    return sumGex;
  };

  const minStrike = sortedRows[0]?.strikeArs ?? spotArs;
  const maxStrike = sortedRows[sortedRows.length - 1]?.strikeArs ?? spotArs;
  const minSafeSpot =
    (evalParams.pvDividendsArs + 1e-3) * Math.exp(evalParams.r1Continuous * evalParams.t1Years);
  const gridLo = Math.max(minSafeSpot, Math.min(spotArs, minStrike) * 0.55);
  const gridHi = Math.max(spotArs, maxStrike) * 1.45;
  const gridSet = new Set<number>([spotArs]);
  const nProbe = 36;
  for (let i = 0; i <= nProbe; i += 1) {
    gridSet.add(gridLo + (i / nProbe) * (gridHi - gridLo));
  }
  for (const r of sortedRows) {
    if (r.strikeArs > gridLo && r.strikeArs < gridHi) {
      gridSet.add(r.strikeArs);
    }
  }
  const probeSpots = Array.from(gridSet).sort((a, b) => a - b);

  let zeroGammaLevelArs = Number.NaN;
  if (positiveOiLegs > 0) {
    let bestMidDist = Number.POSITIVE_INFINITY;
    let prevS = probeSpots[0];
    let prevVal = prevS !== undefined ? evalNetGexAtSpot(prevS) : Number.NaN;
    for (let i = 1; i < probeSpots.length; i += 1) {
      const curS = probeSpots[i];
      if (curS === undefined || prevS === undefined) {
        continue;
      }
      const curVal = evalNetGexAtSpot(curS);
      if (
        Number.isFinite(prevVal) &&
        Number.isFinite(curVal) &&
        ((prevVal <= 0 && curVal >= 0) || (prevVal >= 0 && curVal <= 0))
      ) {
        const root = brentRoot(evalNetGexAtSpot, prevS, curS, 1e-6, 80);
        if (isPositiveFinite(root)) {
          const dist = Math.abs(root - spotArs);
          if (dist < bestMidDist) {
            bestMidDist = dist;
            zeroGammaLevelArs = root;
          }
        }
      }
      prevS = curS;
      prevVal = curVal;
    }
  }

  const maxUncoveredCrossedConcentrationPct = isPositiveFinite(totalUncovCrossAll)
    ? (maxUncovCrossStrike / totalUncovCrossAll) * 100
    : Number.NaN;

  const pinThreshold = input.pinScoreThreshold ?? DEFAULT_PIN_THRESHOLD;
  const pinWindowMin = input.pinWindowMinutesBeforeCutoff ?? PIN_CUTOFF_WINDOW_MIN;
  let regime: StructurePinningRegime;
  if (positiveOiLegs === 0) {
    regime = 'NO_DATA';
  } else if (
    isExpiryDay &&
    minutesTo1530Cutoff !== null &&
    minutesTo1530Cutoff >= 0 &&
    minutesTo1530Cutoff <= pinWindowMin &&
    Number.isFinite(maxPinScore) &&
    maxPinScore >= pinThreshold &&
    totalNetGex > 0
  ) {
    regime = 'PIN_LOCKED';
  } else if (totalNetGex >= 0) {
    regime = 'POSITIVE_GAMMA_MEAN_REVERTING';
  } else {
    regime = 'NEGATIVE_GAMMA_TRENDING';
  }

  return {
    timestampUtc: formatIsoUtcFromSec(input.asOfUtcSec),
    asOfUtcSec: input.asOfUtcSec,
    anexoBAsOfDate: input.anexoBAsOfDate,
    anexoBLagTradingDays,
    isExpiryDay,
    minutesTo1530Cutoff,
    regime,
    zeroGammaLevelArs,
    callWallArs,
    putWallArs,
    peakPinStrikeArs,
    maxPinScore,
    maxUncoveredCrossedConcentrationPct,
    netEffectiveGexArsPer1Pct: totalNetGex,
    netVannaArsPerVolPt: totalNetVanna,
    netCharmArsPerDay: totalNetCharm,
    intradayFlow: {
      bymaNetSignedArs,
      adrNetSignedUsd,
      leeReadyConfidence,
    },
    strikeProfile,
  };
}
