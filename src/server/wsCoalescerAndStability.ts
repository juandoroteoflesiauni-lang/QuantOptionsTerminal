/**
 * Pieza 40: helpers puros de desahogo del event loop y estabilización de vistas.
 *
 * Estas funciones son la referencia ejecutable usada por
 * `tests/wsCoalescerAndStability.test.ts` contra el fixture Python de
 * `tools/gen_ws_coalescer_reference.py`. No hacen red ni I/O.
 */
import type { Bar } from '../core/types.js';

export interface KeyedPayload {
  readonly key: string;
}

/** Latest-write-wins por clave; preserva el orden de primera aparición. */
export function coalesceLatestByKey<T extends KeyedPayload>(items: readonly T[]): ReadonlyMap<string, T> {
  const out = new Map<string, T>();
  for (const item of items) {
    out.set(item.key, item);
  }
  return out;
}

export type MassiveWsChannelPrefix = 'T' | 'Q' | 'A' | 'AM';

export function isValidMassiveStockSymbol(symbol: string): boolean {
  return /^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol);
}

export function buildMassiveWsChannels(
  rawSymbol: string,
  prefixes: readonly MassiveWsChannelPrefix[] = ['T', 'Q', 'A', 'AM'],
): readonly string[] {
  const symbol = rawSymbol.trim().toUpperCase();
  if (symbol === '' || symbol.startsWith('I:') || !isValidMassiveStockSymbol(symbol)) return [];
  return prefixes.map((prefix) => `${prefix}.${symbol}`);
}

export interface MassiveLeaseOperation {
  readonly action: 'acquire' | 'release';
  readonly symbol: string;
  readonly owner: string;
}

/** Resuelve leases dinámicos; los símbolos del núcleo nunca se desuscriben. */
export function computeMassiveDynamicLeases(
  operations: readonly MassiveLeaseOperation[],
  coreSymbols: readonly string[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const core = new Set(coreSymbols.map((symbol) => symbol.trim().toUpperCase()));
  const leases = new Map<string, Set<string>>();
  for (const op of operations) {
    const symbol = op.symbol.trim().toUpperCase();
    const owner = op.owner.trim();
    if (symbol === '' || owner === '' || core.has(symbol) || !isValidMassiveStockSymbol(symbol)) continue;
    if (op.action === 'acquire') {
      const owners = leases.get(symbol) ?? new Set<string>();
      owners.add(owner);
      leases.set(symbol, owners);
      continue;
    }
    const owners = leases.get(symbol);
    if (owners === undefined) continue;
    owners.delete(owner);
    if (owners.size === 0) leases.delete(symbol);
  }
  return leases;
}

export interface ArIntradayFallback {
  readonly requestedTimeframe: '1m' | '5m' | '15m' | '1h' | '4h' | '1D';
  readonly effectiveTimeframe: '1m' | '5m' | '15m' | '1h' | '4h' | '1D';
  readonly fallbackReason: string | null;
}

export function resolveArIntradayFallback(rawTimeframe: string): ArIntradayFallback {
  const timeframe = rawTimeframe.trim();
  if (
    timeframe === '1m' ||
    timeframe === '5m' ||
    timeframe === '15m' ||
    timeframe === '1h' ||
    timeframe === '4h'
  ) {
    return {
      requestedTimeframe: timeframe,
      effectiveTimeframe: '1D',
      fallbackReason: `NO_${timeframe.toUpperCase()}_BARS_AR`,
    };
  }
  if (timeframe === '1D') {
    return { requestedTimeframe: '1D', effectiveTimeframe: '1D', fallbackReason: null };
  }
  throw new TypeError(`Unsupported AR timeframe "${rawTimeframe}"`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function positive(value: unknown): number | null {
  const parsed = finite(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

export function parseIolUtcSec(value: unknown): number | null {
  const numeric = finite(value);
  if (numeric !== null && numeric > 0) {
    return Math.floor(numeric > 10_000_000_000 ? numeric / 1_000 : numeric);
  }
  if (typeof value !== 'string' || value.trim() === '') return null;
  const raw = value.trim();
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const normalized = hasZone ? raw : `${raw}-03:00`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : null;
}

/** Normaliza la serie histórica IOL a OHLC real; el volumen puede ser 0. */
export function normalizeIolHistoricalBars(rows: readonly unknown[]): readonly Bar[] {
  const bars: Bar[] = [];
  const seenTimes = new Set<number>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const time = parseIolUtcSec(row['fechaHora'] ?? row['fecha']);
    const open = positive(row['apertura']);
    const high = positive(row['maximo']);
    const low = positive(row['minimo']);
    const close = positive(row['ultimoPrecio']);
    if (time === null || open === null || high === null || low === null || close === null || seenTimes.has(time)) {
      continue;
    }
    const volume = finite(row['volumenNominal']);
    const vw = positive(row['precioPromedio']);
    seenTimes.add(time);
    bars.push({
      time,
      open,
      high,
      low,
      close,
      volume: volume !== null ? volume : 0,
      ...(vw !== null ? { vw } : {}),
    });
  }
  return bars.sort((a, b) => a.time - b.time);
}
