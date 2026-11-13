import {
  isFiniteNum,
  type SerializedOptionContractRow,
} from '../../api/terminalClient';

export const CONTRACT_MULTIPLIER = 100;

export interface StrategyLegInput {
  readonly id: string;
  readonly contract: SerializedOptionContractRow;
  readonly side: 1 | -1; // +1 long, -1 short
  readonly qty: number;
}

export interface PayoffCurvePoint {
  readonly spot: number;
  readonly expiryPnl: number | null;
  readonly t0TheoreticalPnl: number | null;
}

export interface StrategySummary {
  readonly legsCount: number;
  readonly pricedLegsCount: number;
  readonly netDebitOrCredit: number | null; // positive = net credit, negative = net debit (total $)
  readonly netDelta: number | null;
  readonly netGamma: number | null;
  readonly netThetaDaily: number | null;
  readonly netVegaPer1Pct: number | null;
  readonly minSpot: number;
  readonly maxSpot: number;
  readonly points: readonly PayoffCurvePoint[];
  readonly maxProfit: number | null;
  readonly maxLoss: number | null;
  readonly breakevens: readonly number[];
}

export function resolveContractIv(row: SerializedOptionContractRow): number | null {
  if (isFiniteNum(row.ownIv) && row.ownIv > 0) {
    return row.ownIv;
  }
  if (isFiniteNum(row.providerIv) && row.providerIv > 0) {
    return row.providerIv;
  }
  return null;
}

export function resolveContractPremium(row: SerializedOptionContractRow): number | null {
  if (isFiniteNum(row.mid) && row.mid >= 0) {
    return row.mid;
  }
  if (isFiniteNum(row.lastPrice) && row.lastPrice >= 0) {
    return row.lastPrice;
  }
  return null;
}

function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const poly =
    t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  const p = d * poly;
  return x >= 0 ? 1 - p : p;
}

function bsmEuropeanPrice(
  contractType: 'call' | 'put',
  spot: number,
  strike: number,
  tYears: number,
  sigma: number,
  rate: number,
  dividendYield: number,
): number | null {
  if (
    !Number.isFinite(spot) ||
    spot <= 0 ||
    !Number.isFinite(strike) ||
    strike <= 0 ||
    !Number.isFinite(sigma) ||
    sigma <= 0
  ) {
    return null;
  }
  if (tYears <= 1e-6) {
    return contractType === 'call' ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  }
  const sqrtT = Math.sqrt(tYears);
  const d1 =
    (Math.log(spot / strike) + (rate - dividendYield + 0.5 * sigma * sigma) * tYears) /
    (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const dfQ = Math.exp(-dividendYield * tYears);
  const dfR = Math.exp(-rate * tYears);
  return contractType === 'call'
    ? spot * dfQ * normalCdf(d1) - strike * dfR * normalCdf(d2)
    : strike * dfR * normalCdf(-d2) - spot * dfQ * normalCdf(-d1);
}

export function evaluateRealStrategy(
  legs: readonly StrategyLegInput[],
  spot: number | null,
  asOfUtcSec: number | null,
  rate: number | null,
  dividendYield: number | null,
): StrategySummary | null {
  if (legs.length === 0 || !isFiniteNum(spot) || spot <= 0) {
    return null;
  }

  let pricedLegsCount = 0;
  let netDebitOrCredit: number | null = 0;
  let netDelta: number | null = 0;
  let netGamma: number | null = 0;
  let netThetaDaily: number | null = 0;
  let netVegaPer1Pct: number | null = 0;

  for (const leg of legs) {
    const prem = resolveContractPremium(leg.contract);
    if (prem === null) {
      netDebitOrCredit = null;
    } else if (netDebitOrCredit !== null) {
      pricedLegsCount += 1;
      netDebitOrCredit += -leg.side * prem * leg.qty * CONTRACT_MULTIPLIER;
    }

    if (isFiniteNum(leg.contract.delta) && netDelta !== null) {
      netDelta += leg.side * leg.contract.delta * leg.qty * CONTRACT_MULTIPLIER;
    } else {
      netDelta = null;
    }

    if (isFiniteNum(leg.contract.gamma) && netGamma !== null) {
      netGamma += leg.side * leg.contract.gamma * leg.qty * CONTRACT_MULTIPLIER;
    } else {
      netGamma = null;
    }

    if (isFiniteNum(leg.contract.thetaDaily) && netThetaDaily !== null) {
      netThetaDaily += leg.side * leg.contract.thetaDaily * leg.qty * CONTRACT_MULTIPLIER;
    } else {
      netThetaDaily = null;
    }

    if (isFiniteNum(leg.contract.vegaPer1Pct) && netVegaPer1Pct !== null) {
      netVegaPer1Pct += leg.side * leg.contract.vegaPer1Pct * leg.qty * CONTRACT_MULTIPLIER;
    } else {
      netVegaPer1Pct = null;
    }
  }

  const strikes = legs.map((l) => l.contract.strike);
  const minStrike = Math.min(...strikes, spot);
  const maxStrike = Math.max(...strikes, spot);
  const span = Math.max(maxStrike - minStrike, spot * 0.08);
  const minSpot = Math.max(0.01, minStrike - span * 0.6);
  const maxSpot = maxStrike + span * 0.6;
  const steps = 80;
  const hasRates = isFiniteNum(rate) && isFiniteNum(dividendYield);
  const nowSec = isFiniteNum(asOfUtcSec) ? asOfUtcSec : null;

  const points: PayoffCurvePoint[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const s = minSpot + ((maxSpot - minSpot) * i) / steps;
    let expiryPnl: number | null = 0;
    let t0Pnl: number | null = hasRates && nowSec !== null ? 0 : null;

    for (const leg of legs) {
      const prem = resolveContractPremium(leg.contract);
      if (prem === null) {
        expiryPnl = null;
        t0Pnl = null;
        continue;
      }

      if (expiryPnl !== null) {
        const intrinsic =
          leg.contract.contractType === 'call'
            ? Math.max(0, s - leg.contract.strike)
            : Math.max(0, leg.contract.strike - s);
        expiryPnl += leg.side * (intrinsic - prem) * leg.qty * CONTRACT_MULTIPLIER;
      }

      if (t0Pnl !== null && hasRates && nowSec !== null) {
        const iv = resolveContractIv(leg.contract);
        const tYears = Math.max(0, (leg.contract.expiryUtcSec - nowSec) / (365 * 86_400));
        const theo =
          iv !== null
            ? bsmEuropeanPrice(
                leg.contract.contractType,
                s,
                leg.contract.strike,
                tYears,
                iv,
                rate,
                dividendYield,
              )
            : null;
        if (theo === null) {
          t0Pnl = null;
        } else {
          t0Pnl += leg.side * (theo - prem) * leg.qty * CONTRACT_MULTIPLIER;
        }
      }
    }

    points.push({ spot: s, expiryPnl, t0TheoreticalPnl: t0Pnl });
  }

  const validExpiry = points
    .map((p) => p.expiryPnl)
    .filter((v): v is number => v !== null && Number.isFinite(v));
  const maxProfit = validExpiry.length > 0 ? Math.max(...validExpiry) : null;
  const maxLoss = validExpiry.length > 0 ? Math.min(...validExpiry) : null;

  const breakevens: number[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];
    if (
      prev !== undefined &&
      curr !== undefined &&
      prev.expiryPnl !== null &&
      curr.expiryPnl !== null
    ) {
      if (
        (prev.expiryPnl < 0 && curr.expiryPnl >= 0) ||
        (prev.expiryPnl > 0 && curr.expiryPnl <= 0)
      ) {
        const denom = curr.expiryPnl - prev.expiryPnl;
        const t = Math.abs(denom) > 1e-9 ? -prev.expiryPnl / denom : 0.5;
        breakevens.push(prev.spot + t * (curr.spot - prev.spot));
      }
    }
  }

  return {
    legsCount: legs.length,
    pricedLegsCount,
    netDebitOrCredit,
    netDelta,
    netGamma,
    netThetaDaily,
    netVegaPer1Pct,
    minSpot,
    maxSpot,
    points,
    maxProfit,
    maxLoss,
    breakevens,
  };
}
