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

export const DEFAULT_MIN_SPREAD_DEBIT = 0.10;
export const DEFAULT_MAX_BID_ASK_PCT_OF_MID = 35.0;
export const US_CONTRACT_MULTIPLIER = 100;
export const US_BUDGET_PRESETS_USD = [500, 1_000, 2_500, 5_000, 10_000] as const;
export const AR_BUDGET_PRESETS_ARS = [50_000, 100_000, 250_000, 500_000] as const;

export type LiquiditySemaphore = 'GREEN' | 'YELLOW' | 'RED' | 'NO_DATA';

export interface VerticalSpreadLegQuote {
  readonly strike: number;
  readonly bid: number;
  readonly ask: number;
  readonly last: number;
}

export type VerticalSpreadSide = 'CALL' | 'PUT';

/**
 * Pieza 50.1: modo de valoración de puntas.
 *  - `LIVE_CROSS` (default): compra al ask / vende al bid con puntas cruzadas estrictas.
 *  - `EOD_MID`: mercado cerrado / `EOD_CIERRE`; valora con mid de cierre degradando a
 *    `last`/cierre si falta alguna punta, sin descartar por ensanchamiento de puntas
 *    (el semáforo bid-ask queda informativo).
 */
export type VerticalSpreadPricingMode = 'LIVE_CROSS' | 'EOD_MID';

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
  readonly minDebit?: number;
  readonly maxBidAskPctOfMid?: number;
  readonly requirePositiveBids?: boolean;
  readonly pricingMode?: VerticalSpreadPricingMode;
}

export interface VerticalSpreadMetric {
  readonly valid: boolean;
  readonly eligibleForAutoRanking: boolean;
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
  readonly longBidAskPctOfMid: number;
  readonly shortBidAskPctOfMid: number;
  readonly bidAskPctOfMid: number;
  readonly liquiditySemaphore: LiquiditySemaphore;
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * Calcula el slippage relativo Bid-Ask % del Mid = ((ask - bid) / mid) * 100.
 * Si bid <= 0 o ask < bid devuelve NaN (Zero Silent Fallbacks).
 */
export function computeLegBidAskPctOfMid(bid: number, ask: number): number {
  if (!finitePositive(bid) || !finitePositive(ask) || ask < bid) {
    return Number.NaN;
  }
  const mid = 0.5 * (bid + ask);
  if (!finitePositive(mid)) {
    return Number.NaN;
  }
  return ((ask - bid) / mid) * 100;
}

/**
 * Clasifica el semáforo de liquidez según Bid-Ask % del Mid:
 *  - GREEN:  < 5%
 *  - YELLOW: 5% – 15%
 *  - RED:    > 15%
 *  - NO_DATA: NaN / inválido
 */
export function classifyLiquiditySemaphore(bidAskPctOfMid: number): LiquiditySemaphore {
  if (!Number.isFinite(bidAskPctOfMid) || bidAskPctOfMid < 0) {
    return 'NO_DATA';
  }
  if (bidAskPctOfMid < 5) {
    return 'GREEN';
  }
  if (bidAskPctOfMid <= 15) {
    return 'YELLOW';
  }
  return 'RED';
}

export function computeMultiLegBidAskPctOfMid(
  legs: readonly { readonly bid: number; readonly ask: number }[],
): {
  readonly bidAskPctOfMid: number;
  readonly maxLegBidAskPctOfMid: number;
  readonly liquiditySemaphore: LiquiditySemaphore;
  readonly allLegsHavePositiveBid: boolean;
} {
  if (legs.length === 0) {
    return {
      bidAskPctOfMid: Number.NaN,
      maxLegBidAskPctOfMid: Number.NaN,
      liquiditySemaphore: 'NO_DATA',
      allLegsHavePositiveBid: false,
    };
  }
  let sumPct = 0;
  let maxPct = 0;
  for (const leg of legs) {
    const legPct = computeLegBidAskPctOfMid(leg.bid, leg.ask);
    if (!Number.isFinite(legPct)) {
      return {
        bidAskPctOfMid: Number.NaN,
        maxLegBidAskPctOfMid: Number.NaN,
        liquiditySemaphore: 'NO_DATA',
        allLegsHavePositiveBid: false,
      };
    }
    sumPct += legPct;
    if (legPct > maxPct) {
      maxPct = legPct;
    }
  }
  const avgPct = sumPct / legs.length;
  return {
    bidAskPctOfMid: avgPct,
    maxLegBidAskPctOfMid: maxPct,
    liquiditySemaphore: classifyLiquiditySemaphore(avgPct),
    allLegsHavePositiveBid: true,
  };
}

/**
 * Valida estrictamente que una Mariposa tenga strikes ordenados K1 < K2 < K3
 * (sin strikes repetidos como 142/148/148) y alas simétricas cuando requireSymmetry=true.
 */
export function isValidButterflyStrikes(
  k1: number,
  k2: number,
  k3: number,
  requireSymmetry = true,
): boolean {
  if (!finitePositive(k1) || !finitePositive(k2) || !finitePositive(k3)) {
    return false;
  }
  if (!(k1 < k2 - 1e-9 && k2 < k3 - 1e-9)) {
    return false;
  }
  if (requireSymmetry) {
    const leftWing = k2 - k1;
    const rightWing = k3 - k2;
    if (Math.abs(leftWing - rightWing) > 1e-6) {
      return false;
    }
  }
  return true;
}

/**
 * Valida estrictamente que un Calendar / Diagonal Spread opere sobre dos vencimientos
 * distintos (nearExpiry !== farExpiry y farDays > nearDays) con bid > 0 en ambas patas.
 */
export function isValidCalendarSpread(params: {
  readonly nearExpiryCode: string;
  readonly farExpiryCode: string;
  readonly nearDays: number;
  readonly farDays: number;
  readonly nearStrike: number;
  readonly farStrike: number;
  readonly nearBid: number;
  readonly nearAsk: number;
  readonly farBid: number;
  readonly farAsk: number;
  readonly minNetDebit?: number;
}): boolean {
  const minDebit = params.minNetDebit ?? DEFAULT_MIN_SPREAD_DEBIT;
  if (
    typeof params.nearExpiryCode !== 'string' ||
    typeof params.farExpiryCode !== 'string' ||
    params.nearExpiryCode.trim() === '' ||
    params.farExpiryCode.trim() === '' ||
    params.nearExpiryCode.trim() === params.farExpiryCode.trim()
  ) {
    return false;
  }
  if (
    !finitePositive(params.nearDays) ||
    !finitePositive(params.farDays) ||
    !(params.farDays > params.nearDays) ||
    !finitePositive(params.nearStrike) ||
    !finitePositive(params.farStrike)
  ) {
    return false;
  }
  if (
    !finitePositive(params.nearBid) ||
    !finitePositive(params.nearAsk) ||
    params.nearAsk < params.nearBid ||
    !finitePositive(params.farBid) ||
    !finitePositive(params.farAsk) ||
    params.farAsk < params.farBid
  ) {
    return false;
  }
  const netDebit = params.farAsk - params.nearBid;
  return Number.isFinite(netDebit) && netDebit >= minDebit - 1e-12;
}

export interface OptionsMarketCurrencyConfig {
  readonly market: 'US' | 'AR';
  readonly currencyCode: 'USD' | 'ARS';
  readonly currencyPrefix: 'US$' | '$';
  readonly contractMultiplier: number;
  readonly budgetPresets: readonly number[];
  readonly defaultBudget: number;
  readonly costPerContract: number;
  readonly maxContractsForBudget: number;
}

/**
 * Resuelve la configuración monetaria USD vs. ARS para dimensionamiento de contratos
 * (costoPorContrato = prima * 100) y presupuestos de Mapa / Estrategias.
 */
export function resolveOptionsMarketCurrencyConfig(params: {
  readonly market: 'US' | 'AR' | 'BYMA';
  readonly premiumPerShare?: number | null;
  readonly budget?: number | null;
}): OptionsMarketCurrencyConfig {
  const isUs = params.market === 'US';
  const contractMultiplier = US_CONTRACT_MULTIPLIER;
  const budgetPresets = isUs ? US_BUDGET_PRESETS_USD : AR_BUDGET_PRESETS_ARS;
  const defaultBudget = isUs ? 2_500 : 250_000;
  const effBudget =
    params.budget !== null &&
    params.budget !== undefined &&
    Number.isFinite(params.budget) &&
    params.budget > 0
      ? params.budget
      : defaultBudget;
  const prem = params.premiumPerShare ?? Number.NaN;
  const costPerContract =
    Number.isFinite(prem) && prem > 0 ? prem * contractMultiplier : Number.NaN;
  const maxContractsForBudget =
    Number.isFinite(costPerContract) && costPerContract > 0
      ? Math.floor(effBudget / costPerContract)
      : 0;

  return {
    market: isUs ? 'US' : 'AR',
    currencyCode: isUs ? 'USD' : 'ARS',
    currencyPrefix: isUs ? 'US$' : '$',
    contractMultiplier,
    budgetPresets,
    defaultBudget,
    costPerContract,
    maxContractsForBudget,
  };
}

function resolveBuyPrice(
  leg: VerticalSpreadLegQuote,
  requirePositiveBids: boolean,
): {
  readonly price: number;
  readonly usesEodRef: boolean;
} {
  if (requirePositiveBids) {
    if (finitePositive(leg.bid) && finitePositive(leg.ask) && leg.ask >= leg.bid) {
      return { price: leg.ask, usesEodRef: false };
    }
    return { price: Number.NaN, usesEodRef: false };
  }
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

function resolveSellPrice(
  leg: VerticalSpreadLegQuote,
  requirePositiveBids: boolean,
): {
  readonly price: number;
  readonly usesEodRef: boolean;
} {
  if (requirePositiveBids) {
    if (finitePositive(leg.bid) && finitePositive(leg.ask) && leg.ask >= leg.bid) {
      return { price: leg.bid, usesEodRef: false };
    }
    return { price: Number.NaN, usesEodRef: false };
  }
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

/**
 * Pieza 50.1 (`EOD_MID`): valor de cierre de una pata con `mid = (bid + ask) / 2`
 * cuando hay puntas positivas coherentes; degrada explícitamente a `last`/cierre
 * (marcando `usesEodRef = true`) solo si falta alguna punta. Sin precio válido → NaN.
 */
function resolveEodMidPrice(leg: VerticalSpreadLegQuote): {
  readonly price: number;
  readonly usesEodRef: boolean;
} {
  if (finitePositive(leg.bid) && finitePositive(leg.ask) && leg.ask >= leg.bid) {
    const mid = 0.5 * (leg.bid + leg.ask);
    if (finitePositive(mid)) {
      return { price: mid, usesEodRef: false };
    }
  }
  if (finitePositive(leg.last)) {
    return { price: leg.last, usesEodRef: true };
  }
  if (finitePositive(leg.bid)) {
    return { price: leg.bid, usesEodRef: true };
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
  longBidAskPctOfMid = Number.NaN,
  shortBidAskPctOfMid = Number.NaN,
  bidAskPctOfMid = Number.NaN,
  liquiditySemaphore: LiquiditySemaphore = 'NO_DATA',
): VerticalSpreadMetric {
  return {
    valid: false,
    eligibleForAutoRanking: false,
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
    longBidAskPctOfMid,
    shortBidAskPctOfMid,
    bidAskPctOfMid,
    liquiditySemaphore,
  };
}

/**
 * Calcula un vertical debit con puntas reales:
 *  - CALL: long strike abajo y short strike arriba.
 *  - PUT: long strike arriba y short strike abajo.
 * Excluye del ranking automático spreads con debit < 0.10, patas sin bid > 0
 * o bid-ask excesivo, y calcula el semáforo de liquidez Bid-Ask % del Mid.
 */
export function computeVerticalSpreadMetrics(
  input: VerticalSpreadInput,
): VerticalSpreadMetric {
  const pricingMode = input.pricingMode ?? 'LIVE_CROSS';
  const requirePositiveBids = input.requirePositiveBids ?? true;
  const minDebit = input.minDebit ?? DEFAULT_MIN_SPREAD_DEBIT;
  const maxBidAskPctOfMid = input.maxBidAskPctOfMid ?? DEFAULT_MAX_BID_ASK_PCT_OF_MID;

  const width = Math.abs(input.shortLeg.strike - input.longLeg.strike);
  const long =
    pricingMode === 'EOD_MID'
      ? resolveEodMidPrice(input.longLeg)
      : resolveBuyPrice(input.longLeg, requirePositiveBids);
  const short =
    pricingMode === 'EOD_MID'
      ? resolveEodMidPrice(input.shortLeg)
      : resolveSellPrice(input.shortLeg, requirePositiveBids);

  const longBidAskPctOfMid = computeLegBidAskPctOfMid(input.longLeg.bid, input.longLeg.ask);
  const shortBidAskPctOfMid = computeLegBidAskPctOfMid(input.shortLeg.bid, input.shortLeg.ask);
  const bidAskPctOfMid =
    Number.isFinite(longBidAskPctOfMid) && Number.isFinite(shortBidAskPctOfMid)
      ? 0.5 * (longBidAskPctOfMid + shortBidAskPctOfMid)
      : Number.NaN;
  const liquiditySemaphore = classifyLiquiditySemaphore(bidAskPctOfMid);

  if (!Number.isFinite(width) || width <= 0) {
    return invalidMetric(
      width,
      long,
      short,
      'WIDTH_NOT_POSITIVE',
      longBidAskPctOfMid,
      shortBidAskPctOfMid,
      bidAskPctOfMid,
      liquiditySemaphore,
    );
  }
  if (pricingMode === 'LIVE_CROSS') {
    if (
      requirePositiveBids &&
      (!finitePositive(input.longLeg.bid) ||
        !finitePositive(input.longLeg.ask) ||
        input.longLeg.ask < input.longLeg.bid)
    ) {
      return invalidMetric(
        width,
        long,
        short,
        'LONG_LEG_NO_POSITIVE_BID',
        longBidAskPctOfMid,
        shortBidAskPctOfMid,
        bidAskPctOfMid,
        liquiditySemaphore,
      );
    }
    if (
      requirePositiveBids &&
      (!finitePositive(input.shortLeg.bid) ||
        !finitePositive(input.shortLeg.ask) ||
        input.shortLeg.ask < input.shortLeg.bid)
    ) {
      return invalidMetric(
        width,
        long,
        short,
        'SHORT_LEG_NO_POSITIVE_BID',
        longBidAskPctOfMid,
        shortBidAskPctOfMid,
        bidAskPctOfMid,
        liquiditySemaphore,
      );
    }
  }
  if (!Number.isFinite(long.price)) {
    return invalidMetric(
      width,
      long,
      short,
      'LONG_PRICE_NOT_CALCULABLE',
      longBidAskPctOfMid,
      shortBidAskPctOfMid,
      bidAskPctOfMid,
      liquiditySemaphore,
    );
  }
  if (!Number.isFinite(short.price)) {
    return invalidMetric(
      width,
      long,
      short,
      'SHORT_PRICE_NOT_CALCULABLE',
      longBidAskPctOfMid,
      shortBidAskPctOfMid,
      bidAskPctOfMid,
      liquiditySemaphore,
    );
  }
  if (input.side === 'CALL' && input.shortLeg.strike <= input.longLeg.strike) {
    return invalidMetric(
      width,
      long,
      short,
      'CALL_STRIKES_NOT_ASCENDING',
      longBidAskPctOfMid,
      shortBidAskPctOfMid,
      bidAskPctOfMid,
      liquiditySemaphore,
    );
  }
  if (input.side === 'PUT' && input.shortLeg.strike >= input.longLeg.strike) {
    return invalidMetric(
      width,
      long,
      short,
      'PUT_STRIKES_NOT_DESCENDING',
      longBidAskPctOfMid,
      shortBidAskPctOfMid,
      bidAskPctOfMid,
      liquiditySemaphore,
    );
  }

  const debit = long.price - short.price;
  if (!(debit > 0)) {
    return invalidMetric(
      width,
      long,
      short,
      'DEBIT_NOT_POSITIVE',
      longBidAskPctOfMid,
      shortBidAskPctOfMid,
      bidAskPctOfMid,
      liquiditySemaphore,
    );
  }
  if (debit < minDebit - 1e-12) {
    return invalidMetric(
      width,
      long,
      short,
      'DEBIT_BELOW_MIN_FLOOR',
      longBidAskPctOfMid,
      shortBidAskPctOfMid,
      bidAskPctOfMid,
      liquiditySemaphore,
    );
  }
  if (debit >= width) {
    return invalidMetric(
      width,
      long,
      short,
      'DEBIT_NOT_LESS_THAN_WIDTH',
      longBidAskPctOfMid,
      shortBidAskPctOfMid,
      bidAskPctOfMid,
      liquiditySemaphore,
    );
  }

  if (
    pricingMode === 'LIVE_CROSS' &&
    requirePositiveBids &&
    (!Number.isFinite(bidAskPctOfMid) || bidAskPctOfMid > maxBidAskPctOfMid + 1e-9)
  ) {
    return invalidMetric(
      width,
      long,
      short,
      'EXCESSIVE_BID_ASK_SPREAD',
      longBidAskPctOfMid,
      shortBidAskPctOfMid,
      bidAskPctOfMid,
      liquiditySemaphore,
    );
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

  const eligibleForAutoRanking =
    pricingMode === 'EOD_MID'
      ? debit >= minDebit - 1e-12
      : debit >= minDebit - 1e-12 &&
        Number.isFinite(bidAskPctOfMid) &&
        bidAskPctOfMid <= maxBidAskPctOfMid + 1e-9 &&
        Math.max(longBidAskPctOfMid, shortBidAskPctOfMid) <= maxBidAskPctOfMid + 1e-9;

  return {
    valid: true,
    eligibleForAutoRanking,
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
    longBidAskPctOfMid,
    shortBidAskPctOfMid,
    bidAskPctOfMid,
    liquiditySemaphore,
  };
}
