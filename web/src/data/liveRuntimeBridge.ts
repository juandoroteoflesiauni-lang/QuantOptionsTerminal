import { useSyncExternalStore } from 'react';
import { syncOptionEngineMarket } from '../components/options/engine';
import type {
  ArMacroResponse,
  ArMonitoringResponse,
  ArOptionsResponse,
  ArOverviewResponse,
  ArRelationsResponse,
  ArStockDetailResponse,
  FeedStatus,
  UsSnapshotResponseDto,
} from './liveTypes';
import {
  AR_STOCKS,
  GLOBAL_INDICATORS,
  US_MARKET_DATA,
  hydrateFromArMacro,
  hydrateFromArMonitoring,
  hydrateFromArOptions,
  hydrateFromArOverview,
  hydrateFromArRelations,
  hydrateFromUsSnapshot,
} from './marketData';

export interface LiveTickerUpdate {
  readonly id: string;
  readonly symbol: string;
  readonly price: number;
  readonly changePct: number;
  readonly dir?: 'up' | 'down' | null;
}

export interface LiveMarketState {
  readonly version: number;
  readonly feedStatus: FeedStatus;
  readonly marketState: ArOverviewResponse['marketState'] | null;
  readonly marketStateLabel: string;
  readonly providerErrors: readonly string[];
  readonly lastSyncUtcSec: number | null;
  readonly overview: ArOverviewResponse | null;
  readonly macro: ArMacroResponse | null;
  readonly monitoring: ArMonitoringResponse | null;
  readonly relations: ArRelationsResponse | null;
  readonly stockDetailsBySymbol: Readonly<Record<string, ArStockDetailResponse>>;
  readonly optionsByUnderlying: Readonly<Record<string, ArOptionsResponse>>;
  readonly usSnapshotsBySymbol: Readonly<Record<string, UsSnapshotResponseDto>>;
  readonly tickFlashes: Readonly<Record<string, 'up' | 'down' | null>>;
}

type StoreListener = () => void;
type TickerListener = (updates: readonly LiveTickerUpdate[]) => void;

let state: LiveMarketState = {
  version: 0,
  feedStatus: 'NO_DATA',
  marketState: null,
  marketStateLabel: 'Cargando datos en vivo...',
  providerErrors: [],
  lastSyncUtcSec: null,
  overview: null,
  macro: null,
  monitoring: null,
  relations: null,
  stockDetailsBySymbol: {},
  optionsByUnderlying: {},
  usSnapshotsBySymbol: {},
  tickFlashes: {},
};

const listeners = new Set<StoreListener>();
const tickerListeners = new Set<TickerListener>();
const seqByKey = new Map<string, number>();
const abortByKey = new Map<string, AbortController>();
const lastKnownPriceBySymbol = new Map<string, number>();
let flashClearTimer: ReturnType<typeof setTimeout> | null = null;

function notify(): void {
  state = { ...state, version: state.version + 1 };
  listeners.forEach((fn) => fn());
}

function publishTickerUpdatesFromMemory(): void {
  const updates: LiveTickerUpdate[] = [];
  const pushUpdate = (id: string, symbol: string, price: number, changePct: number) => {
    if (!Number.isFinite(price)) return;
    const prev = lastKnownPriceBySymbol.get(id);
    const dir: 'up' | 'down' | null =
      prev !== undefined && Math.abs(price - prev) > 1e-6 ? (price > prev ? 'up' : 'down') : null;
    lastKnownPriceBySymbol.set(id, price);
    updates.push({ id, symbol, price, changePct, dir });
  };

  for (const ind of GLOBAL_INDICATORS) {
    if (ind.id === 'mep') pushUpdate('MEP', 'Dólar MEP', ind.value, ind.deltaPct);
    else if (ind.id === 'ccl') pushUpdate('CCL', 'Dólar CCL', ind.value, ind.deltaPct);
    else if (ind.id === 'embi') pushUpdate('EMBI', 'Riesgo País', ind.value, ind.deltaPct);
    else if (ind.id === 'sp500') pushUpdate('SPY', 'SPY', ind.value, ind.deltaPct);
    else if (ind.id === 'vix') pushUpdate('VIX', 'VIX', ind.value, ind.deltaPct);
  }
  for (const ar of AR_STOCKS) {
    if (['GGAL', 'SUPV', 'TXAR', 'YPFD', 'PAMP', 'BMA'].includes(ar.ticker)) {
      pushUpdate(ar.ticker, ar.ticker, ar.last, ar.deltaPct);
    }
  }
  for (const us of US_MARKET_DATA) {
    if (['SPY', 'QQQ', 'IWM', 'NVDA', 'AAPL', 'MSFT'].includes(us.ticker)) {
      pushUpdate(us.ticker, us.ticker, us.price, us.deltaPct);
    }
  }

  if (updates.length > 0) {
    tickerListeners.forEach((fn) => fn(updates));
  }
}

function recordPriceFlashes(nextPrices: ReadonlyMap<string, number>): void {
  const flashes: Record<string, 'up' | 'down' | null> = {};
  let hasAny = false;
  nextPrices.forEach((price, symbol) => {
    if (!Number.isFinite(price)) return;
    const prev = lastKnownPriceBySymbol.get(`ROW:${symbol}`);
    if (prev !== undefined && Math.abs(price - prev) > 1e-6) {
      flashes[symbol] = price > prev ? 'up' : 'down';
      hasAny = true;
    }
    lastKnownPriceBySymbol.set(`ROW:${symbol}`, price);
  });

  if (!hasAny) return;
  state = { ...state, tickFlashes: { ...state.tickFlashes, ...flashes } };
  if (flashClearTimer) clearTimeout(flashClearTimer);
  flashClearTimer = setTimeout(() => {
    state = { ...state, tickFlashes: {} };
    notify();
  }, 620);
}

async function fetchJsonGuarded<T>(key: string, url: string): Promise<T | null> {
  const prevAbort = abortByKey.get(key);
  if (prevAbort) prevAbort.abort();
  const controller = new AbortController();
  abortByKey.set(key, controller);
  const nextSeq = (seqByKey.get(key) ?? 0) + 1;
  seqByKey.set(key, nextSeq);

  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!resp.ok) {
      return null;
    }
    const parsed = (await resp.json()) as T;
    if (seqByKey.get(key) !== nextSeq) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function combineFeedStatus(a: FeedStatus, b: FeedStatus): FeedStatus {
  if (a === 'NO_DATA') return b;
  if (b === 'NO_DATA') return a;
  if (a === 'LIVE' || b === 'LIVE') return 'LIVE';
  if (a === 'DIFERIDO_20M' || b === 'DIFERIDO_20M') return 'DIFERIDO_20M';
  return 'PARTIAL';
}

export async function refreshOverview(force = false): Promise<void> {
  const res = await fetchJsonGuarded<ArOverviewResponse>(
    'overview',
    `/api/ar/overview${force ? '?force=1' : ''}`
  );
  if (!res) {
    if (!state.overview) {
      state = { ...state, feedStatus: 'NO_DATA' };
      notify();
    }
    return;
  }
  const priceMap = new Map<string, number>();
  for (const s of res.mervalStocks) {
    if (s.last !== null && Number.isFinite(s.last)) priceMap.set(s.ticker, s.last);
  }
  recordPriceFlashes(priceMap);
  hydrateFromArOverview(res);

  state = {
    ...state,
    overview: res,
    feedStatus: combineFeedStatus(state.feedStatus, res.feedStatus),
    marketState: res.marketState,
    marketStateLabel: res.marketStateLabel,
    providerErrors: [...res.providerErrors],
    lastSyncUtcSec: res.asOfUtcSec,
  };
  publishTickerUpdatesFromMemory();
  notify();
}

export async function refreshMacro(force = false): Promise<void> {
  const res = await fetchJsonGuarded<ArMacroResponse>(
    'macro',
    `/api/ar/macro${force ? '?force=1' : ''}`
  );
  if (!res) return;
  hydrateFromArMacro(res);
  state = {
    ...state,
    macro: res,
    feedStatus: combineFeedStatus(state.feedStatus, res.feedStatus),
    lastSyncUtcSec: res.asOfUtcSec,
  };
  publishTickerUpdatesFromMemory();
  notify();
}

export async function requestMonitoringPanel(
  panel: 'acciones' | 'bonos' | 'cedears' | 'cauciones',
  force = false
): Promise<void> {
  const res = await fetchJsonGuarded<ArMonitoringResponse>(
    'monitoring',
    `/api/ar/monitoring?panel=${encodeURIComponent(panel)}${force ? '&force=1' : ''}`
  );
  if (!res) return;
  hydrateFromArMonitoring(res);
  state = {
    ...state,
    monitoring: res,
    feedStatus: combineFeedStatus(state.feedStatus, res.feedStatus),
    lastSyncUtcSec: res.asOfUtcSec,
  };
  publishTickerUpdatesFromMemory();
  notify();
}

export async function requestRelations(force = false): Promise<void> {
  const res = await fetchJsonGuarded<ArRelationsResponse>(
    'relations',
    `/api/ar/relations${force ? '?force=1' : ''}`
  );
  if (!res) return;
  hydrateFromArRelations(res);
  state = {
    ...state,
    relations: res,
    feedStatus: combineFeedStatus(state.feedStatus, res.feedStatus),
    lastSyncUtcSec: res.asOfUtcSec,
  };
  notify();
}

export async function requestStockDetail(symbol: string, force = false): Promise<void> {
  const clean = symbol.trim().toUpperCase();
  if (!clean) return;
  const res = await fetchJsonGuarded<ArStockDetailResponse>(
    `stock:${clean}`,
    `/api/ar/stock?symbol=${encodeURIComponent(clean)}${force ? '&force=1' : ''}`
  );
  if (!res) return;
  state = {
    ...state,
    stockDetailsBySymbol: { ...state.stockDetailsBySymbol, [clean]: res },
    feedStatus: combineFeedStatus(state.feedStatus, res.feedStatus),
    lastSyncUtcSec: res.asOfUtcSec,
  };
  notify();
}

export async function requestOptionsChain(underlying: string, force = false): Promise<void> {
  const clean = underlying.trim().toUpperCase();
  if (!clean) return;
  const res = await fetchJsonGuarded<ArOptionsResponse>(
    `options:${clean}`,
    `/api/ar/options?underlying=${encodeURIComponent(clean)}${force ? '&force=1' : ''}`
  );
  if (!res) return;
  hydrateFromArOptions(res);
  syncOptionEngineMarket(res);
  state = {
    ...state,
    optionsByUnderlying: { ...state.optionsByUnderlying, [clean]: res },
    feedStatus: combineFeedStatus(state.feedStatus, res.feedStatus),
    lastSyncUtcSec: res.asOfUtcSec,
  };
  notify();
}

export async function requestUsSnapshot(symbol: string): Promise<void> {
  const clean = symbol.trim().toUpperCase();
  if (!clean) return;
  const res = await fetchJsonGuarded<UsSnapshotResponseDto>(
    `us:${clean}`,
    `/api/snapshot?symbol=${encodeURIComponent(clean)}&timeframe=5m`
  );
  if (!res || !res.marketContext) return;
  hydrateFromUsSnapshot(res);
  state = {
    ...state,
    usSnapshotsBySymbol: { ...state.usSnapshotsBySymbol, [clean]: res },
    lastSyncUtcSec: res.asOfUtcSec,
  };
  publishTickerUpdatesFromMemory();
  notify();
}

function handleWsMessage(raw: string): void {
  try {
    const msg = JSON.parse(raw) as {
      type?: string;
      symbol?: string;
      price?: number;
      bar?: { close?: number };
    };
    if (!msg.symbol) return;
    const sym = msg.symbol.toUpperCase();
    const price =
      typeof msg.price === 'number' && Number.isFinite(msg.price)
        ? msg.price
        : typeof msg.bar?.close === 'number' && Number.isFinite(msg.bar.close)
        ? msg.bar.close
        : null;
    if (price === null) return;

    const usRow = US_MARKET_DATA.find((u) => u.ticker === sym);
    if (usRow) {
      usRow.price = price;
      if (Number.isFinite(usRow.cedearArsPrice) && price > 0) {
        usRow.cclImplicit = (usRow.cedearArsPrice * usRow.cedearRatioNum) / price;
      }
    }
    if (sym === 'SPY') {
      const sp = GLOBAL_INDICATORS.find((g) => g.id === 'sp500');
      if (sp) sp.value = price;
    }
    publishTickerUpdatesFromMemory();
    notify();
  } catch {
    // Ignorar payloads malformados
  }
}

export function startLiveRuntimePolling(enabled: boolean): () => void {
  let disposed = false;
  let ws: WebSocket | null = null;

  const runInitialAndCycle = async () => {
    if (disposed) return;
    await Promise.all([
      refreshOverview(),
      refreshMacro(),
      requestMonitoringPanel('bonos'),
      requestRelations(),
      requestUsSnapshot('SPY'),
      requestUsSnapshot('NVDA'),
      requestUsSnapshot('AAPL'),
    ]);
  };

  void runInitialAndCycle();

  if (!enabled) {
    return () => {
      disposed = true;
    };
  }

  const intervalId = setInterval(() => {
    if (disposed) return;
    void refreshOverview();
  }, 20_000);

  if (typeof window !== 'undefined' && typeof WebSocket !== 'undefined') {
    try {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${window.location.host}/ws`);
      ws.addEventListener('open', () => {
        ws?.send(JSON.stringify({ type: 'subscribe', symbol: 'SPY' }));
      });
      ws.addEventListener('message', (ev) => {
        if (!disposed && typeof ev.data === 'string') {
          handleWsMessage(ev.data);
        }
      });
    } catch {
      ws = null;
    }
  }

  return () => {
    disposed = true;
    clearInterval(intervalId);
    if (ws) {
      try {
        ws.close();
      } catch {
        // noop
      }
    }
  };
}

export function useLiveMarketState(): LiveMarketState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => state,
    () => state
  );
}

export function subscribeLiveTickerUpdates(fn: TickerListener): () => void {
  tickerListeners.add(fn);
  return () => {
    tickerListeners.delete(fn);
  };
}
