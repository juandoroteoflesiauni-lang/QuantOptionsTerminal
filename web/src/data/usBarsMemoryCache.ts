/**
 * Pieza EXPORT-1: cache pasivo LRU en memoria de barras US (`/api/bars`).
 *
 * Invariantes Perf-2:
 * - Cero listeners, cero suscripciones, cero canales en `liveRuntimeBridge`.
 * - Cero timers, cero polling, cero `localStorage`.
 * - Permite que el exportador de snapshot reutilice barras ya cargadas por
 *   `StockDetailView` con 0 requests adicionales.
 */

import type { TerminalTimeframe, UsTerminalBarsResponseDto } from './liveTypes.js';

export const MAX_US_BARS_CACHE_ENTRIES = 6;

export interface UsBarsMemoryCacheEntry {
  readonly symbol: string;
  readonly timeframe: TerminalTimeframe;
  readonly response: UsTerminalBarsResponseDto;
  readonly cachedAtUtcSec: number;
}

const cache = new Map<string, UsBarsMemoryCacheEntry>();

function buildCacheKey(symbol: string, timeframe: TerminalTimeframe): string {
  return `${symbol.trim().toUpperCase()}:${timeframe}`;
}

export function setUsBarsMemoryEntry(
  symbol: string,
  timeframe: TerminalTimeframe,
  response: UsTerminalBarsResponseDto,
  cachedAtUtcSec = Math.floor(Date.now() / 1_000),
): void {
  const cleanSymbol = symbol.trim().toUpperCase();
  if (cleanSymbol === '') return;
  const key = buildCacheKey(cleanSymbol, timeframe);
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, {
    symbol: cleanSymbol,
    timeframe,
    response,
    cachedAtUtcSec: Math.floor(cachedAtUtcSec),
  });
  while (cache.size > MAX_US_BARS_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

export function getUsBarsMemoryEntry(
  symbol: string,
  timeframe: TerminalTimeframe,
): UsBarsMemoryCacheEntry | null {
  const cleanSymbol = symbol.trim().toUpperCase();
  if (cleanSymbol === '') return null;
  const key = buildCacheKey(cleanSymbol, timeframe);
  const hit = cache.get(key);
  if (hit === undefined) return null;
  // Refresh LRU recency without mutating entry object
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

export function clearUsBarsMemoryCache(): void {
  cache.clear();
}
