import type { OptionsUnderlyingMetaDto } from './liveTypes';

/**
 * Claves estables del selector de Opciones (Pieza 36).
 *  - `GGAL` es siempre BYMA/ARS.
 *  - `US:GGAL` es el ADR OPRA/USD.
 *  - Todos los demás tickers US usan su símbolo plano.
 */
export interface OptionsUnderlyingSelection {
  readonly key: string;
  readonly symbol: string;
  readonly market: 'AR' | 'US';
  readonly venue: 'BYMA' | 'OPRA';
  readonly currency: 'ARS' | 'USD';
}

export function parseOptionsUnderlyingKey(rawKey: string): OptionsUnderlyingSelection {
  const key = rawKey.trim().toUpperCase();
  if (key === '') {
    return { key: 'GGAL', symbol: 'GGAL', market: 'AR', venue: 'BYMA', currency: 'ARS' };
  }
  if (key === 'US:GGAL') {
    return { key, symbol: 'GGAL', market: 'US', venue: 'OPRA', currency: 'USD' };
  }
  if (key === 'GGAL') {
    return { key, symbol: 'GGAL', market: 'AR', venue: 'BYMA', currency: 'ARS' };
  }
  return { key, symbol: key, market: 'US', venue: 'OPRA', currency: 'USD' };
}

export function toOptionsUnderlyingKey(meta: OptionsUnderlyingMetaDto): string {
  return meta.key;
}

export const OPTIONS_FAVORITE_KEYS: readonly string[] = [
  'GGAL',
  'US:GGAL',
  'SPY',
  'QQQ',
  'IWM',
  'NVDA',
  'TSLA',
  'AAPL',
  'MSFT',
  'AMZN',
  'META',
  'AMD',
  'PLTR',
  'MSTR',
  'COIN',
  'IBIT',
  'IREN',
  'ASTS',
  'CRWV',
] as const;
