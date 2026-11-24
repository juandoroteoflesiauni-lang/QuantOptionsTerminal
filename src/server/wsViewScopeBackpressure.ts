/**
 * Pieza 48: Reglas puras de scope por vista, diff real de quotes,
 * contrapresión (`bufferedAmount`) y heartbeat de WebSocket.
 *
 * Sin red, sin estado global mutable, sin side-effects.
 */

export const WS_HIGH_WATER_MARK = 256 * 1024;
export const WS_LOW_WATER_MARK = 64 * 1024;
export const WS_KILL_WATER_MARK = 4 * 1024 * 1024;
export const WS_MAX_MISSED_HEARTBEATS = 2;
export const WS_BACKPRESSURE_CLOSE_CODE = 1013;

export interface ClientViewScope {
  readonly view: string | null;
  readonly focusSymbol: string | null;
  readonly focusMarket: 'AR' | 'US' | null;
  readonly ggalMode?: 'ADR' | 'ARS' | 'CCL' | null;
  readonly ggalTimeframe?: string | null;
}

import type { LiveOptionQuoteSnapshot } from '../core/opraOptionIntegrity.js';
export type { LiveOptionQuoteSnapshot } from '../core/opraOptionIntegrity.js';

export interface BackpressureDecision {
  readonly action: 'SEND' | 'COALESCE' | 'KILL';
  readonly nextConflating: boolean;
}

export interface HeartbeatDecision {
  readonly action: 'PING' | 'TERMINATE';
  readonly nextMissed: number;
}

export interface MarketTickQuoteLike {
  readonly market: string;
  readonly symbol: string;
  readonly kind?: string | undefined;
  readonly currency?: string | null | undefined;
  readonly price: number;
  readonly previousClose: number | null;
  readonly changePct: number | null;
  readonly dayLow: number | null;
  readonly dayHigh: number | null;
  readonly volume: number | null;
  readonly turnover: number | null;
  readonly asOfUtcSec: number | null;
  readonly source: string;
  readonly settlement?: string | null | undefined;
  readonly sessionPhase?: string | null | undefined;
  readonly extendedPrice?: number | null | undefined;
  readonly extendedChangePct?: number | null | undefined;
  readonly regularClose?: number | null | undefined;
}

const OCC_CONTRACT_PATTERN = /^([A-Z][A-Z0-9.-]{0,6}?)(\d{6})([CP])(\d{8})$/;

function normalizeGgalMode(raw: unknown): 'ADR' | 'ARS' | 'CCL' | null {
  if (typeof raw !== 'string') return null;
  const clean = raw.trim().toUpperCase();
  return clean === 'ADR' || clean === 'ARS' || clean === 'CCL' ? clean : null;
}

function normalizeGgalTimeframe(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const clean = raw.trim();
  if (clean === '') return null;
  if (clean === '1H' || clean === '1h') return '1h';
  if (clean === '4H' || clean === '4h') return '4h';
  if (clean === '1d' || clean === '1D') return '1D';
  return clean;
}

export function normalizeViewScope(raw: {
  readonly view?: unknown;
  readonly focusSymbol?: unknown;
  readonly focusMarket?: unknown;
  readonly ggalMode?: unknown;
  readonly ggalTimeframe?: unknown;
}): ClientViewScope {
  const view =
    typeof raw.view === 'string' && raw.view.trim() !== ''
      ? raw.view.trim().toLowerCase()
      : null;

  let deducedMarket: 'AR' | 'US' | null = null;
  let focusSymbol: string | null = null;
  if (typeof raw.focusSymbol === 'string' && raw.focusSymbol.trim() !== '') {
    const clean = raw.focusSymbol.trim().toUpperCase();
    if (clean.startsWith('AR:')) {
      deducedMarket = 'AR';
      const stripped = clean.slice(3).trim();
      focusSymbol = stripped === '' ? null : stripped;
    } else if (clean.startsWith('US:')) {
      deducedMarket = 'US';
      const stripped = clean.slice(3).trim();
      focusSymbol = stripped === '' ? null : stripped;
    } else {
      focusSymbol = clean;
    }
  }

  let focusMarket: 'AR' | 'US' | null = deducedMarket;
  if (typeof raw.focusMarket === 'string') {
    const upperMarket = raw.focusMarket.trim().toUpperCase();
    if (upperMarket === 'AR' || upperMarket === 'US') {
      focusMarket = upperMarket;
    }
  }

  const ggalMode = normalizeGgalMode(raw.ggalMode);
  const ggalTimeframe = normalizeGgalTimeframe(raw.ggalTimeframe);

  return {
    view,
    focusSymbol,
    focusMarket,
    ...(ggalMode !== null ? { ggalMode } : {}),
    ...(ggalTimeframe !== null ? { ggalTimeframe } : {}),
  };
}

export function extractOptionUnderlying(contractSymbol: string): string | null {
  const clean = contractSymbol.trim().toUpperCase();
  const normalized = clean.startsWith('O:') ? clean.slice(2) : clean;
  const match = OCC_CONTRACT_PATTERN.exec(normalized);
  const underlying = match?.[1];
  return underlying !== undefined && underlying !== '' ? underlying : null;
}

export function shouldEmitOptionQuoteToClient(
  scope: ClientViewScope,
  underlying: string | null,
): boolean {
  if (scope.view !== 'options' || scope.focusSymbol === null || underlying === null) {
    return false;
  }
  const cleanUnderlying = underlying.trim().toUpperCase();
  return cleanUnderlying !== '' && cleanUnderlying === scope.focusSymbol;
}

export function resolveScopedL2Symbol(scope: ClientViewScope): string | null {
  if (scope.view === 'ggal_specialist') {
    return 'GGAL';
  }
  if (scope.view === 'stock_detail' && scope.focusSymbol !== null) {
    return scope.focusSymbol;
  }
  return null;
}

export function shouldEmitGgalBarTickToClient(
  scope: ClientViewScope,
  event?: { readonly mode: 'ADR' | 'ARS' | 'CCL'; readonly timeframe: string },
): boolean {
  const allowedByView =
    scope.view === null ||
    scope.view === 'ggal_specialist' ||
    (scope.view === 'stock_detail' && scope.focusSymbol === 'GGAL');
  if (!allowedByView) {
    return false;
  }
  if (event !== undefined) {
    if (scope.ggalMode !== undefined && scope.ggalMode !== null && event.mode !== scope.ggalMode) {
      return false;
    }
    if (scope.ggalTimeframe !== undefined && scope.ggalTimeframe !== null) {
      const normalizedScopeTf = normalizeGgalTimeframe(scope.ggalTimeframe);
      const normalizedEventTf = normalizeGgalTimeframe(event.timeframe);
      if (normalizedScopeTf !== null && normalizedEventTf !== normalizedScopeTf) {
        return false;
      }
    }
  }
  return true;
}

export function evaluateWsBackpressure(
  bufferedAmount: number,
  currentlyConflating: boolean,
): BackpressureDecision {
  const buf = Number.isFinite(bufferedAmount) && bufferedAmount > 0 ? bufferedAmount : 0;
  if (buf > WS_KILL_WATER_MARK) {
    return { action: 'KILL', nextConflating: true };
  }
  if (buf > WS_HIGH_WATER_MARK) {
    return { action: 'COALESCE', nextConflating: true };
  }
  if (currentlyConflating && buf > WS_LOW_WATER_MARK) {
    return { action: 'COALESCE', nextConflating: true };
  }
  return { action: 'SEND', nextConflating: false };
}

export function evaluateHeartbeatSweep(
  pongReceivedSinceLastSweep: boolean,
  consecutiveMissed: number,
): HeartbeatDecision {
  if (pongReceivedSinceLastSweep) {
    return { action: 'PING', nextMissed: 0 };
  }
  const nextMissed = Math.max(0, Math.floor(consecutiveMissed)) + 1;
  if (nextMissed >= WS_MAX_MISSED_HEARTBEATS) {
    return { action: 'TERMINATE', nextMissed };
  }
  return { action: 'PING', nextMissed };
}

function sameNullableNumber(a: number | null | undefined, b: number | null | undefined): boolean {
  const na = a ?? null;
  const nb = b ?? null;
  if (na === null && nb === null) return true;
  if (na === null || nb === null) return false;
  if (Number.isNaN(na) && Number.isNaN(nb)) return true;
  return na === nb;
}

function sameNullableString(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? null) === (b ?? null);
}

export function hasMarketQuoteChanged(
  prev: MarketTickQuoteLike | undefined,
  next: MarketTickQuoteLike,
): boolean {
  if (prev === undefined) return true;
  return !(
    sameNullableNumber(prev.price, next.price) &&
    sameNullableNumber(prev.previousClose, next.previousClose) &&
    sameNullableNumber(prev.changePct, next.changePct) &&
    sameNullableNumber(prev.dayLow, next.dayLow) &&
    sameNullableNumber(prev.dayHigh, next.dayHigh) &&
    sameNullableNumber(prev.volume, next.volume) &&
    sameNullableNumber(prev.turnover, next.turnover) &&
    sameNullableNumber(prev.asOfUtcSec, next.asOfUtcSec) &&
    sameNullableString(prev.source, next.source) &&
    sameNullableString(prev.settlement, next.settlement) &&
    sameNullableString(prev.sessionPhase, next.sessionPhase) &&
    sameNullableNumber(prev.extendedPrice, next.extendedPrice) &&
    sameNullableNumber(prev.extendedChangePct, next.extendedChangePct) &&
    sameNullableNumber(prev.regularClose, next.regularClose)
  );
}

export function hasOptionQuoteChanged(
  prev: LiveOptionQuoteSnapshot | undefined,
  next: LiveOptionQuoteSnapshot,
): boolean {
  if (prev === undefined) return true;
  return !(
    sameNullableNumber(prev.bid, next.bid) &&
    sameNullableNumber(prev.ask, next.ask) &&
    sameNullableNumber(prev.mid, next.mid) &&
    sameNullableNumber(prev.last, next.last) &&
    sameNullableNumber(prev.size, next.size) &&
    prev.bidSize === next.bidSize &&
    prev.askSize === next.askSize &&
    prev.lastSize === next.lastSize &&
    prev.quoteTimestampMs === next.quoteTimestampMs &&
    prev.tradeTimestampMs === next.tradeTimestampMs &&
    prev.quoteTimestamp === next.quoteTimestamp &&
    prev.tradeTimestamp === next.tradeTimestamp &&
    prev.quoteSeq === next.quoteSeq &&
    prev.tradeSeq === next.tradeSeq &&
    prev.tradeId === next.tradeId &&
    prev.tradeVolume === next.tradeVolume &&
    prev.quoteSource === next.quoteSource &&
    prev.tradeSource === next.tradeSource
  );
}

export function computeOrderBookSignature(
  book: {
    readonly symbol: string;
    readonly asOfUtcSec: number | null;
    readonly bids: readonly { readonly price: number; readonly size: number }[];
    readonly asks: readonly { readonly price: number; readonly size: number }[];
  } | null,
): string | null {
  if (book === null) return null;
  const bidsPart = book.bids.map((l) => `${String(l.price)}:${String(l.size)}`).join(',');
  const asksPart = book.asks.map((l) => `${String(l.price)}:${String(l.size)}`).join(',');
  return `${book.symbol}|${String(book.asOfUtcSec ?? '')}|${bidsPart}|${asksPart}`;
}
