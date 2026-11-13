/**
 * Clasificador causal Lee-Ready (Quote Rule + Tick Rule), segregación de flujo
 * Lit vs. Off-Exchange FINRA TRF (Dark Pool) y L1 Book Imbalance / Microprice (Pieza 15).
 *
 * Garantías de diseño:
 *  - Funciones puras, cero red, cero E/S, cero mutación de argumentos.
 *  - Causalidad estricta: cada trade en `t` consulta únicamente la última cotización
 *    NBBO válida con `quote.timestamp <= trade.timestamp` (cero look-ahead).
 *  - Zero Silent Fallbacks: entradas vacías o cotizaciones inválidas (`bid <= 0`,
 *    `ask < bid`, `bidSize + askSize <= 0`) devuelven `Number.NaN` y `status: 'NO_DATA'`.
 */

export const FINRA_TRF_EXCHANGE = 4;
const PRICE_EPS = 1e-12;

export type LeeReadyStatus = 'OK' | 'NO_DATA';
export type TradeAggressorSide = 'BUY_AGGRESSOR' | 'SELL_AGGRESSOR' | 'UNDETERMINED';
export type ClassificationRule = 'QUOTE_RULE' | 'TICK_RULE' | 'UNDETERMINED';
export type ExecutionVenueType = 'LIT' | 'DARK_POOL_TRF';

export interface LeeReadyTradeInput {
  /** Timestamp monótono del trade (segundos UTC o nanosegundos UTC, consistente con `quotes`). */
  readonly timestamp: number;
  readonly price: number;
  readonly size: number;
  readonly exchange?: number;
  readonly trfTimestamp?: number | null;
}

export interface LeeReadyQuoteInput {
  /** Timestamp del quote NBBO en la misma unidad temporal que `trades`. */
  readonly timestamp: number;
  readonly bid: number;
  readonly ask: number;
  readonly bidSize?: number;
  readonly askSize?: number;
}

export interface LeeReadyOptions {
  /**
   * Permite usar la Tick Rule cuando no hay quote NBBO previo al trade.
   * Por defecto `false` (devuelve `'UNDETERMINED'` sin quote causal válido).
   */
  readonly allowTickFallbackWithoutQuote?: boolean;
}

export interface ClassifiedTrade {
  readonly timestamp: number;
  readonly price: number;
  readonly size: number;
  readonly side: TradeAggressorSide;
  readonly sign: 1 | -1 | 0;
  readonly rule: ClassificationRule;
  readonly venue: ExecutionVenueType;
  readonly matchedBid: number;
  readonly matchedAsk: number;
  readonly matchedMidpoint: number;
}

export interface LeeReadyClassificationResult {
  readonly status: LeeReadyStatus;
  readonly tradeCount: number;
  readonly validQuoteCount: number;
  readonly litBuyVolume: number;
  readonly litSellVolume: number;
  readonly litUndeterminedVolume: number;
  readonly darkPoolBuyVolume: number;
  readonly darkPoolSellVolume: number;
  readonly darkPoolUndeterminedVolume: number;
  readonly totalBuyVolume: number;
  readonly totalSellVolume: number;
  readonly undeterminedVolume: number;
  readonly totalDarkPoolVolume: number;
  readonly totalLitVolume: number;
  readonly totalVolume: number;
  readonly darkPoolShare: number;
  readonly netCvd: number;
  readonly classifiedTrades: readonly ClassifiedTrade[];
}

export interface L1BookImbalanceResult {
  readonly status: LeeReadyStatus;
  readonly midpoint: number;
  readonly spread: number;
  readonly spreadBps: number;
  readonly imbalance: number;
  readonly microprice: number;
}

function emptyClassificationResult(validQuoteCount: number): LeeReadyClassificationResult {
  return {
    status: 'NO_DATA',
    tradeCount: 0,
    validQuoteCount,
    litBuyVolume: Number.NaN,
    litSellVolume: Number.NaN,
    litUndeterminedVolume: Number.NaN,
    darkPoolBuyVolume: Number.NaN,
    darkPoolSellVolume: Number.NaN,
    darkPoolUndeterminedVolume: Number.NaN,
    totalBuyVolume: Number.NaN,
    totalSellVolume: Number.NaN,
    undeterminedVolume: Number.NaN,
    totalDarkPoolVolume: Number.NaN,
    totalLitVolume: Number.NaN,
    totalVolume: Number.NaN,
    darkPoolShare: Number.NaN,
    netCvd: Number.NaN,
    classifiedTrades: [],
  };
}

function classifyByTickRule(price: number, refPrice: number): TradeAggressorSide {
  if (!Number.isFinite(refPrice)) {
    return 'UNDETERMINED';
  }
  if (price > refPrice + PRICE_EPS) {
    return 'BUY_AGGRESSOR';
  }
  if (price < refPrice - PRICE_EPS) {
    return 'SELL_AGGRESSOR';
  }
  return 'UNDETERMINED';
}

/**
 * Clasifica trades por el algoritmo Lee-Ready (Quote Rule + Tick Rule/Zero-Tick)
 * usando causalmente cotizaciones NBBO (`quote.timestamp <= trade.timestamp`) y
 * separando volumen Lit frente a Off-Exchange / Dark Pool FINRA TRF.
 */
export function classifyTradesLeeReady(
  trades: readonly LeeReadyTradeInput[],
  quotes: readonly LeeReadyQuoteInput[],
  options: LeeReadyOptions = {},
): LeeReadyClassificationResult {
  const validQuotes = quotes
    .filter(
      (q) =>
        Number.isFinite(q.timestamp) &&
        Number.isFinite(q.bid) &&
        Number.isFinite(q.ask) &&
        q.bid > 0 &&
        q.ask >= q.bid,
    )
    .sort((a, b) => a.timestamp - b.timestamp);

  if (trades.length === 0) {
    return emptyClassificationResult(validQuotes.length);
  }

  let prevTradeTs = Number.NEGATIVE_INFINITY;
  for (const t of trades) {
    if (
      !Number.isFinite(t.timestamp) ||
      !Number.isFinite(t.price) ||
      !Number.isFinite(t.size) ||
      t.price <= 0 ||
      t.size <= 0 ||
      t.timestamp < prevTradeTs
    ) {
      return emptyClassificationResult(validQuotes.length);
    }
    prevTradeTs = t.timestamp;
  }

  const allowTickFallback = options.allowTickFallbackWithoutQuote === true;

  let qIdx = -1;
  let lastTradePrice = Number.NaN;
  let prevDistinctPrice = Number.NaN;

  let litBuyVolume = 0;
  let litSellVolume = 0;
  let litUndeterminedVolume = 0;
  let darkPoolBuyVolume = 0;
  let darkPoolSellVolume = 0;
  let darkPoolUndeterminedVolume = 0;

  const classifiedTrades: ClassifiedTrade[] = [];

  for (const trade of trades) {
    while (qIdx + 1 < validQuotes.length) {
      const nextQ = validQuotes[qIdx + 1];
      if (nextQ === undefined || nextQ.timestamp > trade.timestamp) {
        break;
      }
      qIdx += 1;
    }

    const matchedQuote = qIdx >= 0 ? (validQuotes[qIdx] ?? null) : null;

    let refPrice = Number.NaN;
    if (Number.isFinite(lastTradePrice)) {
      if (Math.abs(trade.price - lastTradePrice) > PRICE_EPS) {
        refPrice = lastTradePrice;
      } else {
        refPrice = prevDistinctPrice;
      }
    }

    let side: TradeAggressorSide = 'UNDETERMINED';
    let rule: ClassificationRule = 'UNDETERMINED';

    if (matchedQuote !== null) {
      const midpoint = 0.5 * (matchedQuote.bid + matchedQuote.ask);
      if (trade.price > midpoint + PRICE_EPS) {
        side = 'BUY_AGGRESSOR';
        rule = 'QUOTE_RULE';
      } else if (trade.price < midpoint - PRICE_EPS) {
        side = 'SELL_AGGRESSOR';
        rule = 'QUOTE_RULE';
      } else {
        const tickSide = classifyByTickRule(trade.price, refPrice);
        if (tickSide !== 'UNDETERMINED') {
          side = tickSide;
          rule = 'TICK_RULE';
        }
      }
    } else if (allowTickFallback) {
      const tickSide = classifyByTickRule(trade.price, refPrice);
      if (tickSide !== 'UNDETERMINED') {
        side = tickSide;
        rule = 'TICK_RULE';
      }
    }

    if (!Number.isFinite(lastTradePrice)) {
      lastTradePrice = trade.price;
    } else if (Math.abs(trade.price - lastTradePrice) > PRICE_EPS) {
      prevDistinctPrice = lastTradePrice;
      lastTradePrice = trade.price;
    }

    const sign: 1 | -1 | 0 =
      side === 'BUY_AGGRESSOR' ? 1 : side === 'SELL_AGGRESSOR' ? -1 : 0;

    const hasTrfTimestamp =
      trade.trfTimestamp !== undefined &&
      trade.trfTimestamp !== null &&
      Number.isFinite(trade.trfTimestamp) &&
      trade.trfTimestamp > 0;
    const isDarkPool = trade.exchange === FINRA_TRF_EXCHANGE || hasTrfTimestamp;
    const venue: ExecutionVenueType = isDarkPool ? 'DARK_POOL_TRF' : 'LIT';

    if (isDarkPool) {
      if (sign === 1) {
        darkPoolBuyVolume += trade.size;
      } else if (sign === -1) {
        darkPoolSellVolume += trade.size;
      } else {
        darkPoolUndeterminedVolume += trade.size;
      }
    } else if (sign === 1) {
      litBuyVolume += trade.size;
    } else if (sign === -1) {
      litSellVolume += trade.size;
    } else {
      litUndeterminedVolume += trade.size;
    }

    classifiedTrades.push({
      timestamp: trade.timestamp,
      price: trade.price,
      size: trade.size,
      side,
      sign,
      rule,
      venue,
      matchedBid: matchedQuote !== null ? matchedQuote.bid : Number.NaN,
      matchedAsk: matchedQuote !== null ? matchedQuote.ask : Number.NaN,
      matchedMidpoint:
        matchedQuote !== null ? 0.5 * (matchedQuote.bid + matchedQuote.ask) : Number.NaN,
    });
  }

  const totalBuyVolume = litBuyVolume + darkPoolBuyVolume;
  const totalSellVolume = litSellVolume + darkPoolSellVolume;
  const undeterminedVolume = litUndeterminedVolume + darkPoolUndeterminedVolume;
  const totalDarkPoolVolume =
    darkPoolBuyVolume + darkPoolSellVolume + darkPoolUndeterminedVolume;
  const totalLitVolume = litBuyVolume + litSellVolume + litUndeterminedVolume;
  const totalVolume = totalDarkPoolVolume + totalLitVolume;
  const darkPoolShare = totalVolume > 0 ? totalDarkPoolVolume / totalVolume : Number.NaN;
  const netCvd = totalBuyVolume - totalSellVolume;

  return {
    status: 'OK',
    tradeCount: classifiedTrades.length,
    validQuoteCount: validQuotes.length,
    litBuyVolume,
    litSellVolume,
    litUndeterminedVolume,
    darkPoolBuyVolume,
    darkPoolSellVolume,
    darkPoolUndeterminedVolume,
    totalBuyVolume,
    totalSellVolume,
    undeterminedVolume,
    totalDarkPoolVolume,
    totalLitVolume,
    totalVolume,
    darkPoolShare,
    netCvd,
    classifiedTrades,
  };
}

/**
 * Calcula L1 Book Imbalance, Microprice ponderado por colas BBO y Spread en bps.
 * Ante entradas inválidas (`bid <= 0`, `ask < bid`, `bidSize < 0`, `askSize < 0`,
 * o `bidSize + askSize === 0`) devuelve `status: 'NO_DATA'` y `Number.NaN`.
 */
export function computeL1BookImbalance(
  bidPrice: number,
  askPrice: number,
  bidSize: number,
  askSize: number,
): L1BookImbalanceResult {
  if (
    !Number.isFinite(bidPrice) ||
    !Number.isFinite(askPrice) ||
    !Number.isFinite(bidSize) ||
    !Number.isFinite(askSize) ||
    bidPrice <= 0 ||
    askPrice < bidPrice ||
    bidSize < 0 ||
    askSize < 0
  ) {
    return {
      status: 'NO_DATA',
      midpoint: Number.NaN,
      spread: Number.NaN,
      spreadBps: Number.NaN,
      imbalance: Number.NaN,
      microprice: Number.NaN,
    };
  }

  const totalSize = bidSize + askSize;
  if (totalSize <= 0) {
    return {
      status: 'NO_DATA',
      midpoint: Number.NaN,
      spread: Number.NaN,
      spreadBps: Number.NaN,
      imbalance: Number.NaN,
      microprice: Number.NaN,
    };
  }

  const midpoint = 0.5 * (bidPrice + askPrice);
  const spread = askPrice - bidPrice;
  const spreadBps = (spread / midpoint) * 10_000;
  const imbalance = (bidSize - askSize) / totalSize;
  const microprice = (bidPrice * askSize + askPrice * bidSize) / totalSize;

  return {
    status: 'OK',
    midpoint,
    spread,
    spreadBps,
    imbalance,
    microprice,
  };
}
