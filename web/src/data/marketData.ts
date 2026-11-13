export {
  NULL_DISPLAY,
  fmtCompactInt,
  fmtCompactUsd,
  fmtDecimalPct,
  fmtNum,
  fmtPct,
  fmtUsd,
  fmtUtcDateET,
  fmtUtcTimeET,
  isFiniteNum,
} from '../api/terminalClient';

export interface WatchlistSymbolMeta {
  readonly ticker: string;
  readonly name: string;
  readonly assetType: 'etf' | 'stock' | 'index';
  readonly venue: string;
  readonly accentColor: string;
  readonly defaultCorrelated: string;
}

export const DEFAULT_WATCHLIST_SYMBOLS: readonly WatchlistSymbolMeta[] = [
  {
    ticker: 'SPY',
    name: 'SPDR S&P 500 ETF Trust',
    assetType: 'etf',
    venue: 'NYSE Arca',
    accentColor: '#4BA3FF',
    defaultCorrelated: 'QQQ',
  },
  {
    ticker: 'QQQ',
    name: 'Invesco QQQ Trust (Nasdaq-100)',
    assetType: 'etf',
    venue: 'NASDAQ',
    accentColor: '#8B7CF6',
    defaultCorrelated: 'SPY',
  },
  {
    ticker: 'I:SPX',
    name: 'S&P 500 Index',
    assetType: 'index',
    venue: 'CBOE',
    accentColor: '#2EDC7E',
    defaultCorrelated: 'SPY',
  },
  {
    ticker: 'NVDA',
    name: 'NVIDIA Corporation',
    assetType: 'stock',
    venue: 'NASDAQ',
    accentColor: '#22C55E',
    defaultCorrelated: 'QQQ',
  },
  {
    ticker: 'AAPL',
    name: 'Apple Inc.',
    assetType: 'stock',
    venue: 'NASDAQ',
    accentColor: '#A4A4BA',
    defaultCorrelated: 'QQQ',
  },
  {
    ticker: 'MSFT',
    name: 'Microsoft Corporation',
    assetType: 'stock',
    venue: 'NASDAQ',
    accentColor: '#38BDF8',
    defaultCorrelated: 'QQQ',
  },
  {
    ticker: 'TSLA',
    name: 'Tesla, Inc.',
    assetType: 'stock',
    venue: 'NASDAQ',
    accentColor: '#FF5C63',
    defaultCorrelated: 'QQQ',
  },
  {
    ticker: 'AMZN',
    name: 'Amazon.com, Inc.',
    assetType: 'stock',
    venue: 'NASDAQ',
    accentColor: '#F5B544',
    defaultCorrelated: 'QQQ',
  },
  {
    ticker: 'META',
    name: 'Meta Platforms, Inc.',
    assetType: 'stock',
    venue: 'NASDAQ',
    accentColor: '#5B8CFF',
    defaultCorrelated: 'QQQ',
  },
  {
    ticker: 'AMD',
    name: 'Advanced Micro Devices, Inc.',
    assetType: 'stock',
    venue: 'NASDAQ',
    accentColor: '#34D3C7',
    defaultCorrelated: 'NVDA',
  },
];

export function resolveSymbolMeta(symbol: string): WatchlistSymbolMeta {
  const normalized = symbol.trim().toUpperCase();
  const found = DEFAULT_WATCHLIST_SYMBOLS.find((s) => s.ticker === normalized);
  if (found !== undefined) {
    return found;
  }
  const isIndex = normalized.startsWith('I:');
  return {
    ticker: normalized,
    name: isIndex ? `${normalized} Index` : `${normalized} US Equity`,
    assetType: isIndex ? 'index' : 'stock',
    venue: isIndex ? 'CBOE / Index' : 'US Consolidated SIP',
    accentColor: '#8B7CF6',
    defaultCorrelated: normalized === 'SPY' ? 'QQQ' : 'SPY',
  };
}
