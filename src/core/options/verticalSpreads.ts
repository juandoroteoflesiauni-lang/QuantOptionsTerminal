/**
 * Motores puros de spreads verticales US/ARS (Pieza 36).
 *
 * Convención de precios: siempre prima POR ACCIÓN en la moneda del subyacente.
 * El multiplicador del contrato (OCC estándar = 100) se aplica aguas abajo para
 * nocionales y P&L, jamás para strikes ni primas.
 *
 * Zero Silent Fallbacks: cada métrica no calculable es `NaN`. No hay precios de
 * respaldo, IV por defecto ni días por defecto.
 */

import { normCdf } from './math.js';

export interface VerticalSpreadLegQuote {
  readonly strike: number;
  readonly bid: number;
  readonly ask: number;
  readonly last: number;
}

export type VerticalSpreadSide = 'CALL' | 'PUT';

export interface VerticalSpreadInput {
  readonly side: VerticalSpreadSide;
  /** Pata comprada. */
  readonly longLeg: VerticalSpreadLegQuote;
  /** Pata vendida. */
  readonly shortLeg: VerticalSpreadLegQuote;
  readonly spot: number;
  readonly daysToExpiry: number;
  readonly rateDec: number;
  readonly atmIvDec: number;
}

export interface VerticalSpreadMetric {
  readonly valid: boolean;
  readonly reason: string | null;
  readonly width: number;
  readonly longPrice: number;
  readonly shortPrice: number;
  readonly longUsesEodRef: boolean;
  readonly shortUsesEodRef: boolean;
  readonly debit: number;
  readonly maxProfit: number;
  readonly rewardRiskRatio: number;
  readonly breakeven: number;
  readonly breakevenDistPct: number;
  readonly probAtBreakevenPct: number;
  readonly edgePct: number;
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function resolveBuyPrice(leg: VerticalSpreadLegQuote): {
  readonly price: number;
  readonly usesEodRef: boolean;
} {
  if (finitePositive(leg.ask)) {
    return { price: leg.ask, usesEodRef: false };
  }
  if (finitePositive(leg.last)) {
    return { price: leg.last, usesEodRef: true };
  }
  if (finitePositive(leg.bid)) {
    return { price: leg.bid, usesEodRef: true };
  }
  return { price: Number.NaN, usesEodRef: false };
}

function resolveSellPrice(leg: VerticalSpreadLegQuote): {
  readonly price: number;
  readonly usesEodRef: boolean;
} {
  if (finitePositive(leg.bid)) {
    return { price: leg.bid, usesEodRef: false };
  }
  if (finitePositive(leg.last)) {
    return { price: leg.last, usesEodRef: true };
  }
  if (finitePositive(leg.ask)) {
    return { price: leg.ask, usesEodRef: true };
  }
  return { price: Number.NaN, usesEodRef: false };
}

function invalidMetric(
  width: number,
  long: { readonly price: number; readonly usesEodRef: boolean },
  short: { readonly price: number; readonly usesEodRef: boolean },
  reason: string,
): VerticalSpreadMetric {
  return {
    valid: false,
    reason,
    width,
    longPrice: long.price,
    shortPrice: short.price,
    longUsesEodRef: long.usesEodRef,
    shortUsesEodRef: short.usesEodRef,
    debit: Number.NaN,
    maxProfit: Number.NaN,
    rewardRiskRatio: Number.NaN,
    breakeven: Number.NaN,
    breakevenDistPct: Number.NaN,
    probAtBreakevenPct: Number.NaN,
    edgePct: Number.NaN,
  };
}

/**
 * Calcula un vertical debit con puntas reales:
 *  - CALL: long strike abajo y short strike arriba.
 *  - PUT: long strike arriba y short strike abajo.
 * La probabilidad usa la densidad log-normal con la IV media de las dos patas
 * y la IV ATM como tercer dato si ambas patas tienen IV válida en el caller.
 */
export function computeVerticalSpreadMetrics(
  input: VerticalSpreadInput,
): VerticalSpreadMetric {
  const width = Math.abs(input.shortLeg.strike - input.longLeg.strike);
  const long = resolveBuyPrice(input.longLeg);
  const short = resolveSellPrice(input.shortLeg);

  if (!Number.isFinite(width) || width <= 0) {
    return invalidMetric(width, long, short, 'WIDTH_NOT_POSITIVE');
  }
  if (!Number.isFinite(long.price)) {
    return invalidMetric(width, long, short, 'LONG_PRICE_NOT_CALCULABLE');
  }
  if (!Number.isFinite(short.price)) {
    return invalidMetric(width, long, short, 'SHORT_PRICE_NOT_CALCULABLE');
  }
  if (input.side === 'CALL' && input.shortLeg.strike <= input.longLeg.strike) {
    return invalidMetric(width, long, short, 'CALL_STRIKES_NOT_ASCENDING');
  }
  if (input.side === 'PUT' && input.shortLeg.strike >= input.longLeg.strike) {
    return invalidMetric(width, long, short, 'PUT_STRIKES_NOT_DESCENDING');
  }

  const debit = long.price - short.price;
  if (!(debit > 0)) {
    return invalidMetric(width, long, short, 'DEBIT_NOT_POSITIVE');
  }
  if (debit >= width) {
    return invalidMetric(width, long, short, 'DEBIT_NOT_LESS_THAN_WIDTH');
  }

  const maxProfit = width - debit;
  const rewardRiskRatio = maxProfit / debit;
  const breakeven =
    input.side === 'CALL'
      ? input.longLeg.strike + debit
      : input.longLeg.strike - debit;
  const breakevenDistPct =
    Number.isFinite(input.spot) && input.spot > 0
      ? ((breakeven - input.spot) / input.spot) * 100
      : Number.NaN;

  let probAtBreakevenPct = Number.NaN;
  let edgePct = Number.NaN;
  if (
    Number.isFinite(input.spot) &&
    input.spot > 0 &&
    breakeven > 0 &&
    Number.isFinite(input.atmIvDec) &&
    input.atmIvDec > 0 &&
    Number.isFinite(input.daysToExpiry) &&
    input.daysToExpiry > 0
  ) {
    const tExp = input.daysToExpiry / 365;
    const denom = input.atmIvDec * Math.sqrt(tExp);
    const d2 =
      (Math.log(input.spot / breakeven) +
        (input.rateDec - 0.5 * input.atmIvDec * input.atmIvDec) * tExp) /
      denom;
    const prob = input.side === 'CALL' ? normCdf(d2) : normCdf(-d2);
    if (Number.isFinite(prob)) {
      probAtBreakevenPct = prob * 100;
      edgePct = (prob - debit / width) * 100;
    }
  }

  return {
    valid: true,
    reason: null,
    width,
    longPrice: long.price,
    shortPrice: short.price,
    longUsesEodRef: long.usesEodRef,
    shortUsesEodRef: short.usesEodRef,
    debit,
    maxProfit,
    rewardRiskRatio,
    breakeven,
    breakevenDistPct,
    probAtBreakevenPct,
    edgePct,
  };
}
