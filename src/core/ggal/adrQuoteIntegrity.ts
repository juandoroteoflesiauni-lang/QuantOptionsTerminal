/**
 * Integridad L1 y normalización contractual del ADR GGAL (Pieza P1 A6).
 *
 * Separa estrictamente tres observaciones financieras independientes:
 *   1. `trade`: último precio operado (`lastPrice`, `lastSize`, `tradeTimestamp`, `tradeSource`).
 *   2. `l1Book`: libro bilateral L1 (`bid`, `ask`, `bidSize`, `askSize`, `quoteTimestamp`, `quoteSource`).
 *   3. `reference`: cierre histórico oficial EOD (`close`, `referenceTimestamp`, `referenceSource`).
 *
 * Invariantes:
 * - Un `last` jamás fabrica puntas `bid`/`ask` ni un libro `50/50`.
 * - `tradeTimestamp` jamás acredita la frescura de `l1Book` (`quoteTimestamp`).
 * - Tamaños desconocidos permanecen como `NaN` (`null` en JSON).
 * - Libro cruzado, de una sola punta, obsoleto o sin timestamp L1 nunca es ejecutable bilateralmente.
 *
 * Funciones 100 % puras: cero red, cero E/S y cero mutación de argumentos.
 */

import { isPositiveFinite, isValidUtcSec } from './types.js';

export type AdrQuoteQualityMode =
  | 'LIVE_BID_ASK'
  | 'LAST_ONLY'
  | 'ONE_SIDED_QUOTE'
  | 'EOD_CLOSE_REF'
  | 'UNAVAILABLE';

export type AdrQuoteInvalidReason =
  | 'NONE'
  | 'NO_L1_PROVIDER_BBO'
  | 'CROSSED_BOOK'
  | 'ONE_SIDED_BID_ONLY'
  | 'ONE_SIDED_ASK_ONLY'
  | 'STALE_L1_QUOTE'
  | 'MISSING_L1_TIMESTAMP'
  | 'OUT_OF_SESSION_QUOTE'
  | 'INVALID_NON_POSITIVE_PRICE'
  | 'MISSING_ALL_DATA';

export interface AdrTradeObservation {
  readonly lastPrice: number;
  readonly lastSize: number;
  readonly tradeTimestamp: number;
  readonly tradeSource: string | null;
}

export interface AdrL1BookObservation {
  readonly bid: number;
  readonly ask: number;
  readonly bidSize: number;
  readonly askSize: number;
  readonly mid: number;
  readonly spreadUsd: number;
  readonly spreadRel: number;
  readonly quoteTimestamp: number;
  readonly quoteSource: string | null;
  readonly quoteQuality: AdrQuoteQualityMode;
  readonly invalidReason: AdrQuoteInvalidReason;
  readonly isBilateralExecutable: boolean;
}

export interface AdrReferenceObservation {
  readonly close: number;
  readonly referenceTimestamp: number;
  readonly referenceSource: string | null;
}

export interface NormalizedAdrMarketData {
  readonly symbol: string;
  readonly quoteMode: AdrQuoteQualityMode;
  readonly trade: AdrTradeObservation;
  readonly l1Book: AdrL1BookObservation;
  readonly reference: AdrReferenceObservation;
  readonly indicativePriceUsd: number;
  readonly indicativePriceBasis: 'L1_MID' | 'LAST_TRADE' | 'EOD_CLOSE' | 'NONE';
  readonly indicativeTimestampSec: number;
  readonly effectiveSource: string | null;
}

export interface AdrL1CandidateInput {
  readonly bid?: number | null | undefined;
  readonly ask?: number | null | undefined;
  readonly bidSize?: number | null | undefined;
  readonly askSize?: number | null | undefined;
  readonly quoteTimestamp?: number | null | undefined;
  readonly quoteSource?: string | null | undefined;
  readonly isOutOfSession?: boolean | undefined;
}

export interface AdrTradeCandidateInput {
  readonly lastPrice?: number | null | undefined;
  readonly lastSize?: number | null | undefined;
  readonly tradeTimestamp?: number | null | undefined;
  readonly tradeSource?: string | null | undefined;
}

export interface AdrReferenceCandidateInput {
  readonly close?: number | null | undefined;
  readonly referenceTimestamp?: number | null | undefined;
  readonly referenceSource?: string | null | undefined;
}

export interface NormalizeAdrMarketDataInput {
  readonly symbol: string;
  readonly asOfUtcSec: number;
  readonly isEodMode: boolean;
  readonly maxQuoteAgeSec?: number;
  readonly l1Candidate?: AdrL1CandidateInput | null | undefined;
  readonly tradeCandidate?: AdrTradeCandidateInput | null | undefined;
  readonly referenceCandidate?: AdrReferenceCandidateInput | null | undefined;
}

const ALLOWED_L1_SOURCES = new Set<string>([
  'TRADIER_LIVE_NBBO',
  'MASSIVE_NBBO',
  'FMP_EXTENDED_NBBO',
]);

function toPositiveFiniteOrNaN(value: number | null | undefined): number {
  return typeof value === 'number' && isPositiveFinite(value) ? value : Number.NaN;
}

function toValidUtcSecOrNaN(value: number | null | undefined): number {
  return typeof value === 'number' && isValidUtcSec(value) ? value : Number.NaN;
}

function normalizeSource(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed !== '' ? trimmed : null;
}

function isExplicitNonPositiveNumber(value: number | null | undefined): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value <= 0;
}

function buildEmptyL1Book(params: {
  readonly quoteTimestamp?: number;
  readonly quoteSource: string | null;
  readonly quoteQuality: AdrQuoteQualityMode;
  readonly invalidReason: AdrQuoteInvalidReason;
}): AdrL1BookObservation {
  return {
    bid: Number.NaN,
    ask: Number.NaN,
    bidSize: Number.NaN,
    askSize: Number.NaN,
    mid: Number.NaN,
    spreadUsd: Number.NaN,
    spreadRel: Number.NaN,
    quoteTimestamp: params.quoteTimestamp ?? Number.NaN,
    quoteSource: params.quoteSource,
    quoteQuality: params.quoteQuality,
    invalidReason: params.invalidReason,
    isBilateralExecutable: false,
  };
}

/**
 * Normaliza la cotización del ADR GGAL separando última operación, libro L1 y referencia EOD.
 */
export function normalizeAdrMarketData(input: NormalizeAdrMarketDataInput): NormalizedAdrMarketData {
  const symbol = input.symbol.trim().toUpperCase() || 'GGAL';
  const maxQuoteAgeSec =
    input.maxQuoteAgeSec !== undefined && Number.isFinite(input.maxQuoteAgeSec) && input.maxQuoteAgeSec >= 0
      ? input.maxQuoteAgeSec
      : 20;

  const trade: AdrTradeObservation = {
    lastPrice: toPositiveFiniteOrNaN(input.tradeCandidate?.lastPrice),
    lastSize: toPositiveFiniteOrNaN(input.tradeCandidate?.lastSize),
    tradeTimestamp: toValidUtcSecOrNaN(input.tradeCandidate?.tradeTimestamp),
    tradeSource: normalizeSource(input.tradeCandidate?.tradeSource),
  };

  const reference: AdrReferenceObservation = {
    close: toPositiveFiniteOrNaN(input.referenceCandidate?.close),
    referenceTimestamp: toValidUtcSecOrNaN(input.referenceCandidate?.referenceTimestamp),
    referenceSource: normalizeSource(input.referenceCandidate?.referenceSource),
  };

  // Fuera de rueda: referencia histórica EOD explícita sin fabricar puntas bilateralizadas
  if (input.isEodMode) {
    if (isPositiveFinite(reference.close) && isValidUtcSec(reference.referenceTimestamp)) {
      return {
        symbol,
        quoteMode: 'EOD_CLOSE_REF',
        trade,
        l1Book: buildEmptyL1Book({
          quoteSource: null,
          quoteQuality: 'EOD_CLOSE_REF',
          invalidReason: 'OUT_OF_SESSION_QUOTE',
        }),
        reference,
        indicativePriceUsd: reference.close,
        indicativePriceBasis: 'EOD_CLOSE',
        indicativeTimestampSec: reference.referenceTimestamp,
        effectiveSource: reference.referenceSource,
      };
    }

    const eodInvalidReason: AdrQuoteInvalidReason = isExplicitNonPositiveNumber(input.referenceCandidate?.close)
      ? 'INVALID_NON_POSITIVE_PRICE'
      : isPositiveFinite(reference.close)
        ? 'MISSING_L1_TIMESTAMP'
        : 'MISSING_ALL_DATA';

    return {
      symbol,
      quoteMode: 'UNAVAILABLE',
      trade,
      l1Book: buildEmptyL1Book({
        quoteSource: null,
        quoteQuality: 'UNAVAILABLE',
        invalidReason: eodInvalidReason,
      }),
      reference,
      indicativePriceUsd: Number.NaN,
      indicativePriceBasis: 'NONE',
      indicativeTimestampSec: Number.NaN,
      effectiveSource: null,
    };
  }

  // En rueda: evaluación estricta de fuentes L1 permitidas
  const l1Cand = input.l1Candidate ?? null;
  const candQuoteSource = normalizeSource(l1Cand?.quoteSource);
  const allowedSource = candQuoteSource !== null && ALLOWED_L1_SOURCES.has(candQuoteSource);
  const candBid = toPositiveFiniteOrNaN(l1Cand?.bid);
  const candAsk = toPositiveFiniteOrNaN(l1Cand?.ask);
  const candBidSize = toPositiveFiniteOrNaN(l1Cand?.bidSize);
  const candAskSize = toPositiveFiniteOrNaN(l1Cand?.askSize);
  const candQuoteTs = toValidUtcSecOrNaN(l1Cand?.quoteTimestamp);

  const hasBid = isPositiveFinite(candBid);
  const hasAsk = isPositiveFinite(candAsk);
  const hasAnyPositiveQuote = hasBid || hasAsk;
  const hasLastPrice = isPositiveFinite(trade.lastPrice);

  let l1InvalidReason: AdrQuoteInvalidReason | null = null;
  let preservedInvalidTs = Number.NaN;

  if (l1Cand === null || !allowedSource) {
    l1InvalidReason = hasLastPrice ? 'NO_L1_PROVIDER_BBO' : 'MISSING_ALL_DATA';
  } else if (!hasAnyPositiveQuote) {
    const nonPositiveInput =
      isExplicitNonPositiveNumber(l1Cand.bid) || isExplicitNonPositiveNumber(l1Cand.ask);
    l1InvalidReason = nonPositiveInput
      ? 'INVALID_NON_POSITIVE_PRICE'
      : hasLastPrice
        ? 'NO_L1_PROVIDER_BBO'
        : 'MISSING_ALL_DATA';
  } else if (l1Cand.isOutOfSession === true) {
    l1InvalidReason = 'OUT_OF_SESSION_QUOTE';
    preservedInvalidTs = candQuoteTs;
  } else if (hasBid && hasAsk && candBid > candAsk) {
    l1InvalidReason = 'CROSSED_BOOK';
    preservedInvalidTs = candQuoteTs;
  } else if (!isValidUtcSec(candQuoteTs)) {
    // Regla estricta: tradeTimestamp jamás acredita frescura del libro L1
    l1InvalidReason = 'MISSING_L1_TIMESTAMP';
  } else {
    const quoteAgeSec = isValidUtcSec(input.asOfUtcSec) ? input.asOfUtcSec - candQuoteTs : Number.NaN;
    if (!Number.isFinite(quoteAgeSec) || quoteAgeSec < 0 || quoteAgeSec > maxQuoteAgeSec) {
      l1InvalidReason = 'STALE_L1_QUOTE';
      preservedInvalidTs = candQuoteTs;
    }
  }

  if (l1InvalidReason === null) {
    if (hasBid && hasAsk) {
      const mid = 0.5 * (candBid + candAsk);
      const spreadUsd = candAsk - candBid;
      const spreadRel = mid > 0 ? spreadUsd / mid : Number.NaN;
      return {
        symbol,
        quoteMode: 'LIVE_BID_ASK',
        trade,
        l1Book: {
          bid: candBid,
          ask: candAsk,
          bidSize: candBidSize,
          askSize: candAskSize,
          mid,
          spreadUsd,
          spreadRel,
          quoteTimestamp: candQuoteTs,
          quoteSource: candQuoteSource,
          quoteQuality: 'LIVE_BID_ASK',
          invalidReason: 'NONE',
          isBilateralExecutable: true,
        },
        reference,
        indicativePriceUsd: mid,
        indicativePriceBasis: 'L1_MID',
        indicativeTimestampSec: candQuoteTs,
        effectiveSource: candQuoteSource,
      };
    }

    // Una sola punta válida y fresca: retener punta existente sin inventar la opuesta
    const oneSidedReason: AdrQuoteInvalidReason = hasBid ? 'ONE_SIDED_BID_ONLY' : 'ONE_SIDED_ASK_ONLY';
    return {
      symbol,
      quoteMode: 'ONE_SIDED_QUOTE',
      trade,
      l1Book: {
        bid: hasBid ? candBid : Number.NaN,
        ask: hasAsk ? candAsk : Number.NaN,
        bidSize: hasBid ? candBidSize : Number.NaN,
        askSize: hasAsk ? candAskSize : Number.NaN,
        mid: Number.NaN,
        spreadUsd: Number.NaN,
        spreadRel: Number.NaN,
        quoteTimestamp: candQuoteTs,
        quoteSource: candQuoteSource,
        quoteQuality: 'ONE_SIDED_QUOTE',
        invalidReason: oneSidedReason,
        isBilateralExecutable: false,
      },
      reference,
      indicativePriceUsd: hasLastPrice ? trade.lastPrice : Number.NaN,
      indicativePriceBasis: hasLastPrice ? 'LAST_TRADE' : 'NONE',
      indicativeTimestampSec: hasLastPrice ? trade.tradeTimestamp : candQuoteTs,
      effectiveSource: hasLastPrice ? (trade.tradeSource ?? candQuoteSource) : candQuoteSource,
    };
  }

  // Sin L1 válido: degradar limpiamente a LAST_ONLY o UNAVAILABLE
  if (hasLastPrice) {
    return {
      symbol,
      quoteMode: 'LAST_ONLY',
      trade,
      l1Book: buildEmptyL1Book({
        quoteTimestamp: preservedInvalidTs,
        quoteSource: allowedSource ? candQuoteSource : null,
        quoteQuality: 'LAST_ONLY',
        invalidReason: l1InvalidReason,
      }),
      reference,
      indicativePriceUsd: trade.lastPrice,
      indicativePriceBasis: 'LAST_TRADE',
      indicativeTimestampSec: trade.tradeTimestamp,
      effectiveSource: trade.tradeSource,
    };
  }

  const finalUnavailableReason: AdrQuoteInvalidReason =
    l1InvalidReason !== 'NO_L1_PROVIDER_BBO'
      ? l1InvalidReason
      : isExplicitNonPositiveNumber(input.tradeCandidate?.lastPrice)
        ? 'INVALID_NON_POSITIVE_PRICE'
        : 'MISSING_ALL_DATA';

  return {
    symbol,
    quoteMode: 'UNAVAILABLE',
    trade,
    l1Book: buildEmptyL1Book({
      quoteTimestamp: preservedInvalidTs,
      quoteSource: allowedSource ? candQuoteSource : null,
      quoteQuality: 'UNAVAILABLE',
      invalidReason: finalUnavailableReason,
    }),
    reference,
    indicativePriceUsd: Number.NaN,
    indicativePriceBasis: 'NONE',
    indicativeTimestampSec: Number.NaN,
    effectiveSource: null,
  };
}
