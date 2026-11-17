/**
 * Pieza 41: enrutamiento explícito de Stock Detail.
 *
 * El ticker plano solo es compatibilidad. La identidad completa es la clave
 * calificada (`AR:YPFD`, `US:YPF`), porque los CEDEARs y ADRs pueden colisionar
 * con el subyacente US. Ninguna lista asincrónica puede cambiar la ruta de un
 * instrumento ya elegido.
 */

export type StockDetailMarket = 'AR' | 'US';
export type StockDetailMode = 'BYMA_ARS' | 'ADR_USD';
export type StockDetailExchange = 'BYMA' | 'NASDAQ' | 'NYSE' | 'AMEX' | 'ADR' | 'US';

export interface StockDetailRoute {
  /** Clave estable de navegación/caché. */
  readonly key: string;
  /** Símbolo enviado al runtime/proveedor. */
  readonly providerSymbol: string;
  readonly market: StockDetailMarket;
  readonly mode: StockDetailMode;
  readonly isAdr: boolean;
  readonly exchange: StockDetailExchange;
  readonly badge: string;
  readonly currencySymbol: 'ARS' | 'USD';
}

interface StockDetailRouteInput {
  readonly rawTicker: string;
  readonly isArLocalSymbol: boolean;
}

const AR_PREFIX = 'AR:';
const US_PREFIX = 'US:';

const DUAL_ADR_BY_LOCAL: Readonly<Record<string, string>> = Object.freeze({
  GGAL: 'GGAL',
  YPFD: 'YPF',
  BMA: 'BMA',
  PAMP: 'PAM',
  BBAR: 'BBAR',
  SUPV: 'SUPV',
  TGSU2: 'TGS',
  CEPU: 'CEPU',
  CRES: 'CRESY',
  EDN: 'EDN',
  LOMA: 'LOMA',
  TECO2: 'TEO',
  MELI: 'MELI',
  VIST: 'VIST',
  GLOB: 'GLOB',
  IRSA: 'IRS',
});

const US_EXCHANGE_BY_SYMBOL: Readonly<Record<string, string>> = Object.freeze({
  AAPL: 'NASDAQ',
  MSFT: 'NASDAQ',
  NVDA: 'NASDAQ',
  AMZN: 'NASDAQ',
  META: 'NASDAQ',
  GOOGL: 'NASDAQ',
  TSLA: 'NASDAQ',
  MELI: 'NASDAQ',
  VIST: 'NYSE',
  GLOB: 'NYSE',
  YPF: 'NYSE',
  PAM: 'NYSE',
  BMA: 'NYSE',
  SUPV: 'NYSE',
  BBAR: 'NYSE',
  TGS: 'NYSE',
  CEPU: 'NYSE',
  CRESY: 'NYSE',
  EDN: 'NYSE',
  LOMA: 'NYSE',
  TEO: 'NYSE',
  IRS: 'NYSE',
  GGAL: 'NASDAQ',
  SPY: 'NYSE ARCA',
  QQQ: 'NASDAQ',
  IWM: 'NYSE ARCA',
  DIA: 'NYSE ARCA',
  VIXY: 'NYSE ARCA',
  EWZ: 'NYSE ARCA',
  IBIT: 'NASDAQ',
  KO: 'NYSE',
});

export function parseStockDetailKey(rawTicker: string): {
  readonly key: string;
  readonly symbol: string;
  readonly market: StockDetailMarket | null;
} {
  const clean = rawTicker.trim().toUpperCase();
  if (clean.startsWith(AR_PREFIX)) {
    const symbol = clean.slice(AR_PREFIX.length).trim();
    return { key: clean, symbol, market: 'AR' };
  }
  if (clean.startsWith(US_PREFIX)) {
    const symbol = clean.slice(US_PREFIX.length).trim();
    return { key: clean, symbol, market: 'US' };
  }
  return { key: clean, symbol: clean, market: null };
}

export function resolveStockDetailRoute(input: StockDetailRouteInput): StockDetailRoute | null {
  const parsed = parseStockDetailKey(input.rawTicker);
  if (parsed.symbol === '') return null;
  if (parsed.market === 'AR') {
    return {
      key: parsed.key,
      providerSymbol: parsed.symbol,
      market: 'AR',
      mode: 'BYMA_ARS',
      isAdr: false,
      exchange: 'BYMA',
      badge: 'BYMA',
      currencySymbol: 'ARS',
    };
  }
  if (parsed.market === 'US') {
    const exchange = normalizeUsExchange(US_EXCHANGE_BY_SYMBOL[parsed.symbol] ?? null);
    const isAdr =
      DUAL_ADR_BY_LOCAL[parsed.symbol] !== undefined ||
      Object.values(DUAL_ADR_BY_LOCAL).includes(parsed.symbol);
    return {
      key: parsed.key,
      providerSymbol: parsed.symbol,
      market: 'US',
      mode: 'ADR_USD',
      isAdr,
      exchange,
      badge: exchange === 'ADR' ? 'ADR' : exchange,
      currencySymbol: 'USD',
    };
  }
  // Compatibilidad: los locales siguen AR; un ticker plano sin catálogo AR es US.
  if (input.isArLocalSymbol) {
    return {
      key: parsed.key,
      providerSymbol: parsed.symbol,
      market: 'AR',
      mode: 'BYMA_ARS',
      isAdr: false,
      exchange: 'BYMA',
      badge: 'BYMA',
      currencySymbol: 'ARS',
    };
  }
  const exchange = normalizeUsExchange(US_EXCHANGE_BY_SYMBOL[parsed.symbol] ?? null);
  const isAdr =
    DUAL_ADR_BY_LOCAL[parsed.symbol] !== undefined ||
    Object.values(DUAL_ADR_BY_LOCAL).includes(parsed.symbol);
  return {
    key: parsed.key,
    providerSymbol: parsed.symbol,
    market: 'US',
    mode: 'ADR_USD',
    isAdr,
    exchange,
    badge: exchange === 'ADR' ? 'ADR' : exchange,
    currencySymbol: 'USD',
  };
}

export function normalizeUsExchange(raw: string | null): StockDetailExchange {
  if (raw === null || raw.trim() === '') return 'ADR';
  const value = raw.trim().toUpperCase();
  if (value.includes('NASDAQ')) return 'NASDAQ';
  if (value.includes('NYSE')) return 'NYSE';
  if (value.includes('AMEX')) return 'AMEX';
  return 'US';
}

export function dualAdrSymbol(localSymbol: string): string | null {
  return DUAL_ADR_BY_LOCAL[localSymbol.trim().toUpperCase()] ?? null;
}

export function localSymbolForAdr(adrSymbol: string): string | null {
  const upper = adrSymbol.trim().toUpperCase();
  for (const [local, adr] of Object.entries(DUAL_ADR_BY_LOCAL)) {
    if (adr === upper) return local;
  }
  return upper;
}

/** La API AR ya resuelve 1m -> 1D; la vista marca el timeframe efectivo. */
export function resolveArTimeframeFallback(timeframe: '1m' | '5m' | '15m' | '1h' | '4h' | '1D'): {
  readonly requested: typeof timeframe;
  readonly effective: typeof timeframe;
  readonly fallback: boolean;
} {
  if (timeframe === '1m') {
    return { requested: '1m', effective: '1D', fallback: true };
  }
  return { requested: timeframe, effective: timeframe, fallback: false };
}

export function resetHeaderForInstrument<T extends { readonly price: number | null; readonly changePct: number | null; readonly bid: number | null; readonly ask: number | null }>(
  previous: T | null,
  currentKey: string,
  previousKey: string | null,
): T | null {
  if (previous === null || previousKey === null || currentKey === previousKey) return previous;
  return { ...previous, price: null, changePct: null, bid: null, ask: null };
}
