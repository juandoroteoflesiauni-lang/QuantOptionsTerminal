/**
 * Simulador puro de Payoff "What-If" (`ΔIV` y `T+n`) para estructuras multipata (Pieza 46).
 *
 * Garantías de diseño (`AGENTS.md` / `SPEC.md`):
 *  - Funciones 100 % puras: cero red, cero E/S, cero UI y cero mutación de argumentos.
 *  - Reutiliza exclusivamente el núcleo BSM (`greeksBsm`, `evaluateOptionAtExpiry`,
 *    `SECONDS_PER_YEAR_365`) sin duplicar fórmulas.
 *  - Degradación honesta: ante inputs inválidos o no finitos devuelve `NaN` sin
 *    fabricar valores de respaldo; si un desplazamiento negativo de IV lleva una pata
 *    por debajo de `minVolatility` físico (`> 0`), aplica ese piso explícito y reporta
 *    `ivClampedLegs > 0` para transparencia en UI.
 */

import {
  evaluateOptionAtExpiry,
  greeksBsm,
  SECONDS_PER_YEAR_365,
} from './blackScholes.js';
import type { OptionContractType } from './types.js';

const SECONDS_PER_DAY = 86_400;
export const DEFAULT_WHAT_IF_MIN_IV = 0.005;
export const DEFAULT_US_OPTION_MULTIPLIER = 100;

export interface WhatIfOptionLeg {
  readonly id?: string;
  readonly label?: string;
  readonly contractType: OptionContractType;
  readonly strike: number;
  /** Posición firmada en unidades de estructura (+1 compra, -1 venta, -2 cuerpo, etc.). */
  readonly quantity: number;
  /** Volatilidad implícita base decimal (p. ej. `0.25` para 25 %). */
  readonly iv: number;
  /** Tiempo inicial al vencimiento en años (ACT/365) en `T+0`. */
  readonly timeToExpiry: number;
  /** Prima por acción de entrada en `T+0` (+ compra / mark de entrada). */
  readonly entryPrice: number;
}

export interface WhatIfGreeksSummary {
  /** Por 1 unidad de estructura (por acción). */
  readonly deltaPerUnit: number;
  readonly gammaPerUnit: number;
  readonly thetaDailyPerUnit: number;
  readonly vegaPer1PctPerUnit: number;
  /** Escalado por `contracts * contractMultiplier` (p. ej. `100` acciones US). */
  readonly deltaShares: number;
  readonly gammaShares: number;
  readonly thetaDailyUsd: number;
  readonly vegaPer1PctUsd: number;
}

export interface WhatIfEvaluationInput {
  readonly spot: number;
  readonly legs: readonly WhatIfOptionLeg[];
  readonly rate: number;
  readonly dividendYield: number;
  /** Desplazamiento paralelo de IV en puntos porcentuales (`-30` a `+30`). */
  readonly ivShiftPts: number;
  /** Días calendario transcurridos desde `T+0` (`0` a `horizonDte`). */
  readonly elapsedDays: number;
  /** Días al horizonte de vencimiento de la estructura (p. ej. DTE de la pata corta). */
  readonly horizonDte: number;
  readonly contracts?: number;
  readonly contractMultiplier?: number;
  readonly minVolatility?: number;
  readonly secondsPerYear?: number;
}

export interface WhatIfPointResult {
  readonly spot: number;
  readonly pnlT0: number;
  readonly pnlTn: number;
  readonly pnlExpiry: number;
  readonly pnlTnZeroIvShift: number;
  /** Atribución exacta de P&L por cambio de IV en `(spot, T+n)`: `pnlTn - pnlTnZeroIvShift`. */
  readonly ivShockPnlAttribution: number;
  /** Atribución por paso de tiempo a spot e IV base fijos: `pnlTnZeroIvShift - pnlT0ZeroIvShift`. */
  readonly timeDecayPnlAttribution: number;
  readonly valuePerUnitT0: number;
  readonly valuePerUnitTn: number;
  readonly valuePerUnitExpiry: number;
  readonly netEntryDebitPerUnit: number;
  readonly greeksTn: WhatIfGreeksSummary;
  readonly greeksT0: WhatIfGreeksSummary;
  readonly ivClampedLegs: number;
}

export interface WhatIfSurfaceInput {
  readonly referenceSpot: number;
  readonly legs: readonly WhatIfOptionLeg[];
  readonly rate: number;
  readonly dividendYield: number;
  readonly ivShiftPts: number;
  readonly elapsedDays: number;
  readonly horizonDte: number;
  readonly contracts?: number;
  readonly contractMultiplier?: number;
  readonly minVolatility?: number;
  readonly secondsPerYear?: number;
  /** Factor porcentual inferior/superior respecto a strikes/spot (por defecto 0.22 = +-22 %). */
  readonly spotRangePct?: number;
  readonly gridSteps?: number;
  /** Niveles opcionales extra de spot para incluir exactamente (breakevens, strikes, walls). */
  readonly extraSpots?: readonly number[];
}

export interface WhatIfCurvePoint {
  readonly spot: number;
  readonly pnlT0: number;
  readonly pnlTn: number;
  readonly pnlExpiry: number;
}

export interface WhatIfSurfaceResult {
  readonly minSpot: number;
  readonly maxSpot: number;
  readonly horizonDte: number;
  readonly elapsedDays: number;
  readonly ivShiftPts: number;
  readonly positionScale: number;
  readonly netEntryDebitPerUnit: number;
  readonly netEntryDebitUsd: number;
  readonly maxGainExpiry: number;
  readonly maxLossExpiry: number;
  readonly maxGainTn: number;
  readonly maxLossTn: number;
  readonly atSpot: WhatIfPointResult;
  readonly curve: readonly WhatIfCurvePoint[];
}

interface LegEvalOutput {
  readonly price: number;
  readonly delta: number;
  readonly gamma: number;
  readonly thetaDaily: number;
  readonly vegaPer1Pct: number;
  readonly ivClamped: boolean;
}

interface PortfolioSnapshot {
  readonly valuePerUnit: number;
  readonly pnlUsd: number;
  readonly deltaPerUnit: number;
  readonly gammaPerUnit: number;
  readonly thetaDailyPerUnit: number;
  readonly vegaPer1PctPerUnit: number;
  readonly ivClampedLegs: number;
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function buildNanGreeksSummary(): WhatIfGreeksSummary {
  return {
    deltaPerUnit: Number.NaN,
    gammaPerUnit: Number.NaN,
    thetaDailyPerUnit: Number.NaN,
    vegaPer1PctPerUnit: Number.NaN,
    deltaShares: Number.NaN,
    gammaShares: Number.NaN,
    thetaDailyUsd: Number.NaN,
    vegaPer1PctUsd: Number.NaN,
  };
}

function evaluateSingleLeg(
  spot: number,
  leg: WhatIfOptionLeg,
  rate: number,
  dividendYield: number,
  remainingTimeYears: number,
  ivShiftDecimal: number,
  minVolatility: number,
): LegEvalOutput | null {
  if (
    !isPositiveFinite(spot)
    || !isPositiveFinite(leg.strike)
    || !Number.isFinite(leg.quantity)
    || leg.quantity === 0
    || !isPositiveFinite(leg.iv)
    || !Number.isFinite(leg.timeToExpiry)
    || leg.timeToExpiry < 0
    || !Number.isFinite(leg.entryPrice)
    || !Number.isFinite(rate)
    || !Number.isFinite(dividendYield)
    || !Number.isFinite(remainingTimeYears)
  ) {
    return null;
  }

  // En vencimiento de la pata (`T <= 0`): valor intrinseco exacto y griegas terminales.
  if (remainingTimeYears <= 1e-12) {
    const intrinsic = evaluateOptionAtExpiry(spot, leg.strike, leg.contractType);
    if (!Number.isFinite(intrinsic)) {
      return null;
    }
    let terminalDelta = 0;
    if (leg.contractType === 'call') {
      terminalDelta = spot > leg.strike ? 1 : spot < leg.strike ? 0 : 0.5;
    } else {
      terminalDelta = spot < leg.strike ? -1 : spot > leg.strike ? 0 : -0.5;
    }
    return {
      price: intrinsic,
      delta: terminalDelta,
      gamma: 0,
      thetaDaily: 0,
      vegaPer1Pct: 0,
      ivClamped: false,
    };
  }

  const shifted = leg.iv + ivShiftDecimal;
  const ivClamped = shifted < minVolatility;
  const effectiveIv = ivClamped ? minVolatility : shifted;
  const res = greeksBsm({
    spot,
    strike: leg.strike,
    timeToExpiry: remainingTimeYears,
    rate,
    dividendYield,
    volatility: effectiveIv,
    contractType: leg.contractType,
  });

  if (
    !Number.isFinite(res.price)
    || !Number.isFinite(res.delta)
    || !Number.isFinite(res.gamma)
    || !Number.isFinite(res.thetaDaily)
    || !Number.isFinite(res.vegaPer1Pct)
  ) {
    return null;
  }

  return {
    price: res.price,
    delta: res.delta,
    gamma: res.gamma,
    thetaDaily: res.thetaDaily,
    vegaPer1Pct: res.vegaPer1Pct,
    ivClamped,
  };
}

function evaluatePortfolioAtState(
  spot: number,
  legs: readonly WhatIfOptionLeg[],
  rate: number,
  dividendYield: number,
  elapsedYears: number,
  ivShiftDecimal: number,
  netEntryDebitPerUnit: number,
  positionScale: number,
  minVolatility: number,
): PortfolioSnapshot | null {
  if (legs.length === 0 || !Number.isFinite(netEntryDebitPerUnit)) {
    return null;
  }

  let valuePerUnit = 0;
  let deltaPerUnit = 0;
  let gammaPerUnit = 0;
  let thetaDailyPerUnit = 0;
  let vegaPer1PctPerUnit = 0;
  let ivClampedLegs = 0;

  for (const leg of legs) {
    const remainingTime = Math.max(0, leg.timeToExpiry - elapsedYears);
    const out = evaluateSingleLeg(
      spot,
      leg,
      rate,
      dividendYield,
      remainingTime,
      ivShiftDecimal,
      minVolatility,
    );
    if (out === null) {
      return null;
    }
    valuePerUnit += leg.quantity * out.price;
    deltaPerUnit += leg.quantity * out.delta;
    gammaPerUnit += leg.quantity * out.gamma;
    thetaDailyPerUnit += leg.quantity * out.thetaDaily;
    vegaPer1PctPerUnit += leg.quantity * out.vegaPer1Pct;
    if (out.ivClamped) {
      ivClampedLegs += 1;
    }
  }

  const pnlUsd = (valuePerUnit - netEntryDebitPerUnit) * positionScale;
  return {
    valuePerUnit,
    pnlUsd,
    deltaPerUnit,
    gammaPerUnit,
    thetaDailyPerUnit,
    vegaPer1PctPerUnit,
    ivClampedLegs,
  };
}

function toGreeksSummary(
  snapshot: PortfolioSnapshot | null,
  positionScale: number,
): WhatIfGreeksSummary {
  if (snapshot === null) {
    return buildNanGreeksSummary();
  }
  return {
    deltaPerUnit: snapshot.deltaPerUnit,
    gammaPerUnit: snapshot.gammaPerUnit,
    thetaDailyPerUnit: snapshot.thetaDailyPerUnit,
    vegaPer1PctPerUnit: snapshot.vegaPer1PctPerUnit,
    deltaShares: snapshot.deltaPerUnit * positionScale,
    gammaShares: snapshot.gammaPerUnit * positionScale,
    thetaDailyUsd: snapshot.thetaDailyPerUnit * positionScale,
    vegaPer1PctUsd: snapshot.vegaPer1PctPerUnit * positionScale,
  };
}

function computeNetEntryDebitPerUnit(legs: readonly WhatIfOptionLeg[]): number {
  if (legs.length === 0) return Number.NaN;
  let total = 0;
  for (const leg of legs) {
    if (!Number.isFinite(leg.quantity) || leg.quantity === 0 || !Number.isFinite(leg.entryPrice)) {
      return Number.NaN;
    }
    total += leg.quantity * leg.entryPrice;
  }
  return total;
}

/**
 * Evalúa un punto de spot concreto devolviendo las 3 curvas simultáneas
 * (`T+0`, `T+n` con `ΔIV`, `Vencimiento`), griegas proyectadas y atribución
 * exacta de ganancia/pérdida por shock de volatilidad (`ivShockPnlAttribution`).
 */
export function evaluateWhatIfPoint(input: WhatIfEvaluationInput): WhatIfPointResult {
  const contracts = input.contracts ?? 1;
  const contractMultiplier = input.contractMultiplier ?? DEFAULT_US_OPTION_MULTIPLIER;
  const minVolatility = input.minVolatility ?? DEFAULT_WHAT_IF_MIN_IV;
  const secondsPerYear = input.secondsPerYear ?? SECONDS_PER_YEAR_365;
  const positionScale = contracts * contractMultiplier;
  const netEntryDebitPerUnit = computeNetEntryDebitPerUnit(input.legs);

  const invalid =
    !isPositiveFinite(input.spot)
    || !isPositiveFinite(contracts)
    || !isPositiveFinite(contractMultiplier)
    || !isPositiveFinite(minVolatility)
    || !isPositiveFinite(secondsPerYear)
    || !Number.isFinite(input.ivShiftPts)
    || !Number.isFinite(input.elapsedDays)
    || !Number.isFinite(input.horizonDte)
    || input.horizonDte < 0
    || !Number.isFinite(netEntryDebitPerUnit);

  if (invalid) {
    return {
      spot: input.spot,
      pnlT0: Number.NaN,
      pnlTn: Number.NaN,
      pnlExpiry: Number.NaN,
      pnlTnZeroIvShift: Number.NaN,
      ivShockPnlAttribution: Number.NaN,
      timeDecayPnlAttribution: Number.NaN,
      valuePerUnitT0: Number.NaN,
      valuePerUnitTn: Number.NaN,
      valuePerUnitExpiry: Number.NaN,
      netEntryDebitPerUnit,
      greeksTn: buildNanGreeksSummary(),
      greeksT0: buildNanGreeksSummary(),
      ivClampedLegs: 0,
    };
  }

  const clampedElapsedDays = Math.min(Math.max(input.elapsedDays, 0), input.horizonDte);
  const elapsedYearsTn = (clampedElapsedDays * SECONDS_PER_DAY) / secondsPerYear;
  const horizonYears = (input.horizonDte * SECONDS_PER_DAY) / secondsPerYear;
  const ivShiftDecimal = input.ivShiftPts / 100;

  const snapT0Zero = evaluatePortfolioAtState(
    input.spot,
    input.legs,
    input.rate,
    input.dividendYield,
    0,
    0,
    netEntryDebitPerUnit,
    positionScale,
    minVolatility,
  );
  const snapTnZero = evaluatePortfolioAtState(
    input.spot,
    input.legs,
    input.rate,
    input.dividendYield,
    elapsedYearsTn,
    0,
    netEntryDebitPerUnit,
    positionScale,
    minVolatility,
  );
  const snapTnShifted = evaluatePortfolioAtState(
    input.spot,
    input.legs,
    input.rate,
    input.dividendYield,
    elapsedYearsTn,
    ivShiftDecimal,
    netEntryDebitPerUnit,
    positionScale,
    minVolatility,
  );
  const snapExpiry = evaluatePortfolioAtState(
    input.spot,
    input.legs,
    input.rate,
    input.dividendYield,
    horizonYears,
    ivShiftDecimal,
    netEntryDebitPerUnit,
    positionScale,
    minVolatility,
  );

  if (snapT0Zero === null || snapTnZero === null || snapTnShifted === null || snapExpiry === null) {
    return {
      spot: input.spot,
      pnlT0: Number.NaN,
      pnlTn: Number.NaN,
      pnlExpiry: Number.NaN,
      pnlTnZeroIvShift: Number.NaN,
      ivShockPnlAttribution: Number.NaN,
      timeDecayPnlAttribution: Number.NaN,
      valuePerUnitT0: Number.NaN,
      valuePerUnitTn: Number.NaN,
      valuePerUnitExpiry: Number.NaN,
      netEntryDebitPerUnit,
      greeksTn: buildNanGreeksSummary(),
      greeksT0: buildNanGreeksSummary(),
      ivClampedLegs: 0,
    };
  }

  return {
    spot: input.spot,
    pnlT0: snapT0Zero.pnlUsd,
    pnlTn: snapTnShifted.pnlUsd,
    pnlExpiry: snapExpiry.pnlUsd,
    pnlTnZeroIvShift: snapTnZero.pnlUsd,
    ivShockPnlAttribution: snapTnShifted.pnlUsd - snapTnZero.pnlUsd,
    timeDecayPnlAttribution: snapTnZero.pnlUsd - snapT0Zero.pnlUsd,
    valuePerUnitT0: snapT0Zero.valuePerUnit,
    valuePerUnitTn: snapTnShifted.valuePerUnit,
    valuePerUnitExpiry: snapExpiry.valuePerUnit,
    netEntryDebitPerUnit,
    greeksTn: toGreeksSummary(snapTnShifted, positionScale),
    greeksT0: toGreeksSummary(snapT0Zero, positionScale),
    ivClampedLegs: snapTnShifted.ivClampedLegs,
  };
}

/**
 * Genera la malla completa de spot con las 3 curvas simultáneas (`T+0`, `T+n` ΔIV y
 * `Vencimiento`) para el Simulador Payoff What-If en el Inspector Activo.
 */
export function simulateWhatIfPayoffSurface(input: WhatIfSurfaceInput): WhatIfSurfaceResult {
  const contracts = input.contracts ?? 1;
  const contractMultiplier = input.contractMultiplier ?? DEFAULT_US_OPTION_MULTIPLIER;
  const minVolatility = input.minVolatility ?? DEFAULT_WHAT_IF_MIN_IV;
  const secondsPerYear = input.secondsPerYear ?? SECONDS_PER_YEAR_365;
  const spotRangePct = input.spotRangePct ?? 0.22;
  const gridSteps = Math.max(21, Math.min(241, Math.round(input.gridSteps ?? 81)));
  const positionScale = contracts * contractMultiplier;

  const atSpot = evaluateWhatIfPoint({
    spot: input.referenceSpot,
    legs: input.legs,
    rate: input.rate,
    dividendYield: input.dividendYield,
    ivShiftPts: input.ivShiftPts,
    elapsedDays: input.elapsedDays,
    horizonDte: input.horizonDte,
    contracts,
    contractMultiplier,
    minVolatility,
    secondsPerYear,
  });

  if (
    !isPositiveFinite(input.referenceSpot)
    || !isPositiveFinite(spotRangePct)
    || !Number.isFinite(atSpot.pnlT0)
    || input.legs.length === 0
  ) {
    return {
      minSpot: Number.NaN,
      maxSpot: Number.NaN,
      horizonDte: input.horizonDte,
      elapsedDays: input.elapsedDays,
      ivShiftPts: input.ivShiftPts,
      positionScale,
      netEntryDebitPerUnit: atSpot.netEntryDebitPerUnit,
      netEntryDebitUsd: Number.NaN,
      maxGainExpiry: Number.NaN,
      maxLossExpiry: Number.NaN,
      maxGainTn: Number.NaN,
      maxLossTn: Number.NaN,
      atSpot,
      curve: [],
    };
  }

  const validStrikes = input.legs
    .map((leg) => leg.strike)
    .filter((k) => isPositiveFinite(k));
  const minStrike = validStrikes.length > 0 ? Math.min(...validStrikes) : input.referenceSpot;
  const maxStrike = validStrikes.length > 0 ? Math.max(...validStrikes) : input.referenceSpot;
  const lowAnchor = Math.min(input.referenceSpot, minStrike);
  const highAnchor = Math.max(input.referenceSpot, maxStrike);
  const minSpot = Math.max(0.01, lowAnchor * (1 - spotRangePct));
  const maxSpot = highAnchor * (1 + spotRangePct);

  const spotValues = new Set<number>();
  for (let i = 0; i < gridSteps; i += 1) {
    const s = minSpot + ((maxSpot - minSpot) * i) / (gridSteps - 1);
    spotValues.add(Number(s.toFixed(6)));
  }
  spotValues.add(input.referenceSpot);
  for (const k of validStrikes) {
    if (k >= minSpot && k <= maxSpot) {
      spotValues.add(k);
    }
  }
  for (const s of input.extraSpots ?? []) {
    if (isPositiveFinite(s) && s >= minSpot && s <= maxSpot) {
      spotValues.add(s);
    }
  }

  const sortedSpots = [...spotValues].sort((a, b) => a - b);
  const curve: WhatIfCurvePoint[] = [];
  let maxGainExpiry = -Infinity;
  let maxLossExpiry = Infinity;
  let maxGainTn = -Infinity;
  let maxLossTn = Infinity;

  for (const spot of sortedSpots) {
    const pt = evaluateWhatIfPoint({
      spot,
      legs: input.legs,
      rate: input.rate,
      dividendYield: input.dividendYield,
      ivShiftPts: input.ivShiftPts,
      elapsedDays: input.elapsedDays,
      horizonDte: input.horizonDte,
      contracts,
      contractMultiplier,
      minVolatility,
      secondsPerYear,
    });
    if (!Number.isFinite(pt.pnlT0) || !Number.isFinite(pt.pnlTn) || !Number.isFinite(pt.pnlExpiry)) {
      continue;
    }
    curve.push({
      spot,
      pnlT0: pt.pnlT0,
      pnlTn: pt.pnlTn,
      pnlExpiry: pt.pnlExpiry,
    });
    if (pt.pnlExpiry > maxGainExpiry) maxGainExpiry = pt.pnlExpiry;
    if (pt.pnlExpiry < maxLossExpiry) maxLossExpiry = pt.pnlExpiry;
    if (pt.pnlTn > maxGainTn) maxGainTn = pt.pnlTn;
    if (pt.pnlTn < maxLossTn) maxLossTn = pt.pnlTn;
  }

  return {
    minSpot,
    maxSpot,
    horizonDte: input.horizonDte,
    elapsedDays: Math.min(Math.max(input.elapsedDays, 0), input.horizonDte),
    ivShiftPts: input.ivShiftPts,
    positionScale,
    netEntryDebitPerUnit: atSpot.netEntryDebitPerUnit,
    netEntryDebitUsd: atSpot.netEntryDebitPerUnit * positionScale,
    maxGainExpiry: Number.isFinite(maxGainExpiry) ? maxGainExpiry : Number.NaN,
    maxLossExpiry: Number.isFinite(maxLossExpiry) ? maxLossExpiry : Number.NaN,
    maxGainTn: Number.isFinite(maxGainTn) ? maxGainTn : Number.NaN,
    maxLossTn: Number.isFinite(maxLossTn) ? maxLossTn : Number.NaN,
    atSpot,
    curve,
  };
}
