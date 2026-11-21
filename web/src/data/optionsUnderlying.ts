import type { OptionsUnderlyingMetaDto } from './liveTypes';

/**
 * Claves estables del selector de Opciones (Pieza 36 / Pieza 50.3).
 *  - `GGAL` es siempre BYMA/ARS y su clave canónica es `AR:GGAL`.
 *  - `US:GGAL` es el ADR OPRA/USD (canónica `US:GGAL`).
 *  - Todos los demás tickers US usan su símbolo plano y canónica `US:<SYM>`.
 * `key` preserva retrocompatibilidad con `OPTIONS_FAVORITE_KEYS` y
 * `OptionsSymbolSelector.tsx`; `canonicalKey` (`market:symbol`) es la clave de almacenamiento
 * aislada por mercado del bridge en vivo.
 */
export interface OptionsUnderlyingSelection {
  readonly key: string;
  readonly canonicalKey: string;
  readonly symbol: string;
  readonly market: 'AR' | 'US';
  readonly venue: 'BYMA' | 'OPRA';
  readonly currency: 'ARS' | 'USD';
}

export function parseOptionsUnderlyingKey(rawKey: string): OptionsUnderlyingSelection {
  const key = rawKey.trim().toUpperCase();
  if (key === '') {
    return {
      key: 'GGAL',
      canonicalKey: 'AR:GGAL',
      symbol: 'GGAL',
      market: 'AR',
      venue: 'BYMA',
      currency: 'ARS',
    };
  }
  if (key === 'US:GGAL') {
    return {
      key,
      canonicalKey: 'US:GGAL',
      symbol: 'GGAL',
      market: 'US',
      venue: 'OPRA',
      currency: 'USD',
    };
  }
  if (key === 'GGAL') {
    return {
      key,
      canonicalKey: 'AR:GGAL',
      symbol: 'GGAL',
      market: 'AR',
      venue: 'BYMA',
      currency: 'ARS',
    };
  }
  if (key.startsWith('AR:')) {
    const symbol = key.slice(3);
    return {
      key: symbol,
      canonicalKey: `AR:${symbol}`,
      symbol,
      market: 'AR',
      venue: 'BYMA',
      currency: 'ARS',
    };
  }
  if (key.startsWith('US:')) {
    const symbol = key.slice(3);
    return {
      key: symbol === 'GGAL' ? 'US:GGAL' : symbol,
      canonicalKey: `US:${symbol}`,
      symbol,
      market: 'US',
      venue: 'OPRA',
      currency: 'USD',
    };
  }
  return {
    key,
    canonicalKey: `US:${key}`,
    symbol: key,
    market: 'US',
    venue: 'OPRA',
    currency: 'USD',
  };
}

/** Clave canónica `market:symbol` de un subyacente de opciones (p. ej. `AR:GGAL`, `US:SPY`). */
export function toCanonicalOptionsKey(rawKey: string): string {
  return parseOptionsUnderlyingKey(rawKey).canonicalKey;
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
