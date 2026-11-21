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
  OptionsUnderlyingsResponseDto,
  OptionsUnderlyingMetaDto,
  SymbolCatalystsResponseDto,
  TerminalTimeframe,
  UsOptionExpiryChainResponseDto,
  UsSnapshotResponseDto,
  UsTerminalBarsResponseDto,
  UsVolSurfaceResponseDto,
} from './liveTypes';
import {
  applyUsExpiryChainToSnapshot,
  mapUsSnapshotToArOptions,
  mergeUsExpiryChainIntoOptions,
} from './expiryChainMerge';
import {
  AR_STOCKS,
  GLOBAL_INDICATORS,
  US_MARKET_DATA,
  buildOptionExpiryGroupsFromArOptions,
  hydrateFromArMacro,
  hydrateFromArMonitoring,
  hydrateFromArOptions,
  hydrateFromArOverview,
  hydrateFromArRelations,
  hydrateFromUsSnapshot,
  type OptionExpiryGroup,
} from './marketData';
import { parseOptionsUnderlyingKey } from './optionsUnderlying';

export interface LiveTickerUpdate {
  readonly id: string;
  readonly symbol: string;
  readonly price: number;
  readonly changePct: number;
  readonly dir?: 'up' | 'down' | null;
  readonly sessionPhase?: 'PRE_MARKET' | 'RTH' | 'AFTER_HOURS' | 'CLOSED' | null;
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
  /** Pieza 50.3: indexado EXCLUSIVAMENTE por clave canónica `market:symbol` (`AR:GGAL`, `US:SPY`, …). */
  readonly optionsByUnderlying: Readonly<Record<string, ArOptionsResponse>>;
  /** Pieza 50.3: grupos de vencimiento aislados por clave canónica `market:symbol`. */
  readonly optionExpiriesByUnderlyingKey: Readonly<Record<string, readonly OptionExpiryGroup[]>>;
  readonly usSnapshotsBySymbol: Readonly<Record<string, UsSnapshotResponseDto>>;
  readonly optionsUnderlyings: readonly OptionsUnderlyingMetaDto[];
  readonly optionsUnderlyingsStatus: 'IDLE' | 'LOADING' | 'OK' | 'NO_DATA';
  readonly usVolSurfaceBySymbol: Readonly<Record<string, UsVolSurfaceResponseDto | null>>;
  readonly usVolSurfaceStatusBySymbol: Readonly<
    Record<string, 'IDLE' | 'LOADING' | 'OK' | 'NO_DATA'>
  >;
  readonly optionsCatalystsBySymbol: Readonly<Record<string, SymbolCatalystsResponseDto | null>>;
  readonly optionsCatalystsStatusBySymbol: Readonly<
    Record<string, 'IDLE' | 'LOADING' | 'OK' | 'NO_DATA'>
  >;
  /** Pieza 50.2: carga on-demand en curso por `${underlyingKey}:${expirationDate}`. */
  readonly loadingOptionExpiries: Readonly<Record<string, boolean>>;
  readonly tickFlashes: Readonly<Record<string, 'up' | 'down' | null>>;
  readonly isBackendConnected: boolean;
  readonly warmupStatus: 'IDLE' | 'WARMING_UP' | 'READY';
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
  optionExpiriesByUnderlyingKey: {},
  usSnapshotsBySymbol: {},
  optionsUnderlyings: [],
  optionsUnderlyingsStatus: 'IDLE',
  usVolSurfaceBySymbol: {},
  usVolSurfaceStatusBySymbol: {},
  optionsCatalystsBySymbol: {},
  optionsCatalystsStatusBySymbol: {},
  loadingOptionExpiries: {},
  tickFlashes: {},
  isBackendConnected: false,
  warmupStatus: 'IDLE',
};

export interface LiveMarketStatus {
  readonly isBackendConnected: boolean;
  readonly feedStatus: FeedStatus;
  readonly marketState: ArOverviewResponse['marketState'] | null;
  readonly marketStateLabel: string;
  readonly warmupStatus: 'IDLE' | 'WARMING_UP' | 'READY';
}

let statusSnapshot: LiveMarketStatus = {
  isBackendConnected: state.isBackendConnected,
  feedStatus: state.feedStatus,
  marketState: state.marketState,
  marketStateLabel: state.marketStateLabel,
  warmupStatus: state.warmupStatus,
};

const listeners = new Set<StoreListener>();
const statusListeners = new Set<StoreListener>();
const tickerListeners = new Set<TickerListener>();
const seqByKey = new Map<string, number>();
const abortByKey = new Map<string, AbortController>();
const inFlightByKey = new Map<
  string,
  { readonly url: string; readonly token: number; readonly promise: Promise<unknown> }
>();
const lastKnownPriceBySymbol = new Map<string, number>();
let flashClearTimer: ReturnType<typeof setTimeout> | null = null;

const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

function notify(): void {
  state = { ...state, version: state.version + 1 };
  if (
    statusSnapshot.isBackendConnected !== state.isBackendConnected ||
    statusSnapshot.feedStatus !== state.feedStatus ||
    statusSnapshot.marketState !== state.marketState ||
    statusSnapshot.marketStateLabel !== state.marketStateLabel ||
    statusSnapshot.warmupStatus !== state.warmupStatus
  ) {
    statusSnapshot = {
      isBackendConnected: state.isBackendConnected,
      feedStatus: state.feedStatus,
      marketState: state.marketState,
      marketStateLabel: state.marketStateLabel,
      warmupStatus: state.warmupStatus,
    };
    statusListeners.forEach((fn) => fn());
  }
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

async function fetchJsonGuarded<T>(
  key: string,
  url: string,
  options?: { readonly force?: boolean; readonly timeoutMs?: number; readonly signal?: AbortSignal },
): Promise<T | null> {
  if (options?.signal?.aborted) {
    return null;
  }
  const force = options?.force === true;
  if (!force) {
    const existing = inFlightByKey.get(key);
    if (existing !== undefined && existing.url === url) {
      return existing.promise as Promise<T | null>;
    }
  }

  const prevAbort = abortByKey.get(key);
  if (prevAbort) prevAbort.abort();
  const controller = new AbortController();
  abortByKey.set(key, controller);
  const nextSeq = (seqByKey.get(key) ?? 0) + 1;
  seqByKey.set(key, nextSeq);

  const onExternalAbort = () => controller.abort();
  options?.signal?.addEventListener('abort', onExternalAbort, { once: true });

  const timeoutMs = options?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const run = (async (): Promise<T | null> => {
    try {
      const resp = await fetch(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!resp.ok) {
        return null;
      }
      const parsed = (await resp.json()) as T;
      if (seqByKey.get(key) !== nextSeq || options?.signal?.aborted) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    } finally {
      clearTimeout(timeoutId);
      options?.signal?.removeEventListener('abort', onExternalAbort);
      if (abortByKey.get(key) === controller) {
        abortByKey.delete(key);
      }
      const cur = inFlightByKey.get(key);
      if (cur !== undefined && cur.token === nextSeq) {
        inFlightByKey.delete(key);
      }
    }
  })();

  inFlightByKey.set(key, { url, token: nextSeq, promise: run });
  return run;
}

function combineFeedStatus(a: FeedStatus, b: FeedStatus): FeedStatus {
  if (a === 'NO_DATA') return b;
  if (b === 'NO_DATA') return a;
  if (a === 'LIVE' || b === 'LIVE') return 'LIVE';
  if (a === 'DIFERIDO_20M' || b === 'DIFERIDO_20M') return 'DIFERIDO_20M';
  if (a === 'EOD_CIERRE' || b === 'EOD_CIERRE') return 'EOD_CIERRE';
  return 'PARTIAL';
}

export async function refreshOverview(force = false): Promise<void> {
  const res = await fetchJsonGuarded<ArOverviewResponse>(
    'overview',
    `/api/ar/overview${force ? '?refresh=1' : ''}`,
    { force }
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
    isBackendConnected: true,
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
    `/api/ar/macro${force ? '?refresh=1' : ''}`,
    { force }
  );
  if (!res) return;
  hydrateFromArMacro(res);
  state = {
    ...state,
    isBackendConnected: true,
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
    `/api/ar/monitoring?panel=${encodeURIComponent(panel)}${force ? '&refresh=1' : ''}`,
    { force }
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
    `/api/ar/relations${force ? '?refresh=1' : ''}`,
    { force }
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

export async function requestStockDetail(
  symbol: string,
  force = false,
  timeframe: TerminalTimeframe = '1D',
  signal?: AbortSignal,
): Promise<ArStockDetailResponse | null> {
  const clean = symbol.trim().toUpperCase();
  if (!clean) return null;
  const res = await fetchJsonGuarded<ArStockDetailResponse>(
    `stock:${clean}`,
    `/api/ar/stock?symbol=${encodeURIComponent(clean)}&timeframe=${encodeURIComponent(timeframe)}${force ? '&refresh=1' : ''}`,
    { force, signal }
  );
  if (!res) return null;
  state = {
    ...state,
    stockDetailsBySymbol: { ...state.stockDetailsBySymbol, [clean]: res },
    feedStatus: combineFeedStatus(state.feedStatus, res.feedStatus),
    lastSyncUtcSec: res.asOfUtcSec,
  };
  notify();
  return res;
}

export async function requestTerminalBars(
  symbol: string,
  timeframe: TerminalTimeframe,
  options?: { readonly force?: boolean; readonly visibleBars?: number; readonly signal?: AbortSignal; readonly market?: 'US' | 'AR' },
): Promise<UsTerminalBarsResponseDto | null> {
  const clean = symbol.trim().toUpperCase();
  if (!clean) return null;
  const vis = options?.visibleBars ?? 180;
  // Pieza 38: `market=AR` desambigua el ticker local ARS (p. ej. NVDA CEDEAR)
  // del subyacente US en USD (SPEC punto 10). La clave de caché incluye el
  // mercado para no pisar `NVDA:1D:US` con `NVDA:1D:AR`.
  const market = options?.market ?? 'US';
  return fetchJsonGuarded<UsTerminalBarsResponseDto>(
    `bars:${clean}:${timeframe}:${market}`,
    `/api/bars?symbol=${encodeURIComponent(clean)}&timeframe=${encodeURIComponent(timeframe)}&market=${market}&visibleBars=${String(vis)}${options?.force ? '&refresh=1' : ''}`,
    { force: options?.force === true, signal: options?.signal },
  );
}

interface HealthResponseDto {
  readonly ok?: boolean;
  readonly warmupStatus?: 'IDLE' | 'WARMING_UP' | 'READY';
}

export async function refreshBackendHealth(): Promise<boolean> {
  const health = await fetchJsonGuarded<HealthResponseDto>('health', '/api/health');
  if (!health || health.ok !== true) {
    if (state.isBackendConnected) {
      state = { ...state, isBackendConnected: false };
      notify();
    }
    return false;
  }
  const nextWarmup = health.warmupStatus ?? 'READY';
  if (!state.isBackendConnected || state.warmupStatus !== nextWarmup) {
    state = {
      ...state,
      isBackendConnected: true,
      warmupStatus: nextWarmup,
    };
    notify();
  }
  return true;
}

/**
 * Pieza 50.1: fusiona la cadena de un vencimiento recién cargado (snapshot con
 * `?expiration=`) sobre el AR options ya hidratado, sin perder los otros vencimientos.
 * Los stubs sin contratos adoptan los datos previos del mismo `expiryCode` cuando existan.
 */
function mergeArOptionsWithHydratedExpiry(
  previous: ArOptionsResponse | undefined,
  incoming: ArOptionsResponse,
): ArOptionsResponse {
  if (previous === undefined) return incoming;
  const byCode = new Map<string, ArOptionsResponse['expiries'][number]>();
  for (const expiry of previous.expiries) {
    byCode.set(expiry.expiryCode, expiry);
  }
  for (const expiry of incoming.expiries) {
    const prev = byCode.get(expiry.expiryCode);
    const isEmptyStub =
      expiry.calls.length === 0 && expiry.puts.length === 0 && expiry.strikes.length === 0;
    if (prev !== undefined && isEmptyStub) {
      byCode.set(expiry.expiryCode, {
        ...expiry,
        strikes: prev.strikes,
        calls: prev.calls,
        puts: prev.puts,
        ivAtm: prev.ivAtm ?? expiry.ivAtm,
        riskReversal25: prev.riskReversal25 ?? expiry.riskReversal25,
        butterfly25: prev.butterfly25 ?? expiry.butterfly25,
      });
    } else {
      byCode.set(expiry.expiryCode, expiry);
    }
  }
  const termByCode = new Map<string, ArOptionsResponse['termStructure'][number]>();
  for (const point of previous.termStructure) {
    termByCode.set(point.expiryCode, point);
  }
  for (const point of incoming.termStructure) {
    termByCode.set(point.expiryCode, point);
  }
  return {
    ...previous,
    ...incoming,
    spot: incoming.spot ?? previous.spot,
    expiries: [...byCode.values()].sort((a, b) => a.days - b.days),
    termStructure: [...termByCode.values()].sort((a, b) => a.days - b.days),
  };
}

/**
 * Pieza 50.3: subyacente activo de la vista Opciones. `syncOptionEngineMarket` solo se
 * aplica al store global `engine.ts` cuando llega una cadena del subyacente activo; el
 * polling de `AR:GGAL` jamás pisa `engine.ts` mientras el usuario opera `US:SPY`.
 */
let activeOptionsCanonicalKey: string | null = null;

export function setActiveOptionsUnderlyingKey(rawKey: string | null): void {
  if (rawKey === null) {
    activeOptionsCanonicalKey = null;
    return;
  }
  const canonicalKey = parseOptionsUnderlyingKey(rawKey).canonicalKey;
  activeOptionsCanonicalKey = canonicalKey;
  const cached = state.optionsByUnderlying[canonicalKey];
  if (cached !== undefined) {
    syncOptionEngineMarket(cached);
  }
}

/** Pieza 50.3: snapshot puro del estado en vivo para lecturas fuera de React (helpers/tests). */
export function getLiveMarketStateSnapshot(): LiveMarketState {
  return state;
}

/** Lectura pura de la cadena de opciones por clave cruda o canónica (`AR:GGAL`, `US:SPY`, …). */
export function getLiveOptionsForUnderlying(
  marketState: LiveMarketState,
  rawKey: string,
): ArOptionsResponse | undefined {
  return marketState.optionsByUnderlying[parseOptionsUnderlyingKey(rawKey).canonicalKey];
}

/** Lectura pura de los grupos de vencimiento aislados del subyacente (`[]` si no cargó). */
export function getOptionExpiriesForUnderlying(
  marketState: LiveMarketState,
  rawKey: string,
): readonly OptionExpiryGroup[] {
  return marketState.optionExpiriesByUnderlyingKey[parseOptionsUnderlyingKey(rawKey).canonicalKey] ?? [];
}

export async function requestOptionsChain(
  underlying: string,
  force = false,
  expiration?: string,
): Promise<void> {
  const selection = parseOptionsUnderlyingKey(underlying);
  // Pieza 50.3: el almacenamiento y el motor se aíslan por `market:symbol`.
  const canonicalKey = selection.canonicalKey;
  const clean = selection.symbol;
  if (!clean) return;
  if (selection.market === 'US') {
    const snap = await fetchJsonGuarded<UsSnapshotResponseDto>(
      `us:opt:${selection.key}${expiration ? `:${expiration}` : ''}`,
      `/api/snapshot?symbol=${encodeURIComponent(clean)}${expiration ? `&expiration=${encodeURIComponent(expiration)}` : ''}`
    );
    if (!snap) return;
    hydrateFromUsSnapshot(snap);
    const mapped = mapUsSnapshotToArOptions(clean, snap);
    // Pieza 50.1: fusionar el vencimiento recién cargado sin borrar los otros ya hidratados.
    const merged = mergeArOptionsWithHydratedExpiry(state.optionsByUnderlying[canonicalKey], mapped);
    const groups = buildOptionExpiryGroupsFromArOptions(merged);
    if (activeOptionsCanonicalKey === canonicalKey) {
      syncOptionEngineMarket(merged);
    }
    state = {
      ...state,
      isBackendConnected: true,
      usSnapshotsBySymbol: { ...state.usSnapshotsBySymbol, [clean]: snap },
      optionsByUnderlying: { ...state.optionsByUnderlying, [canonicalKey]: merged },
      optionExpiriesByUnderlyingKey: { ...state.optionExpiriesByUnderlyingKey, [canonicalKey]: groups },
      ...(snap.catalysts
        ? {
            optionsCatalystsBySymbol: { ...state.optionsCatalystsBySymbol, [clean]: snap.catalysts },
            optionsCatalystsStatusBySymbol: {
              ...state.optionsCatalystsStatusBySymbol,
              [clean]: snap.catalysts.available ? 'OK' : 'NO_DATA',
            },
          }
        : {}),
      feedStatus: combineFeedStatus(state.feedStatus, mapped.feedStatus),
      lastSyncUtcSec: snap.asOfUtcSec,
    };
    notify();
    return;
  }
  const res = await fetchJsonGuarded<ArOptionsResponse>(
    `options:${selection.key}`,
    `/api/ar/options?underlying=${encodeURIComponent(clean)}${force ? '&refresh=1' : ''}`,
    { force }
  );
  if (!res) return;
  const groups = buildOptionExpiryGroupsFromArOptions(res);
  // Espejo retrocompatible exclusivo de AR:GGAL (jamás toca claves US:*).
  if (canonicalKey === 'AR:GGAL') {
    hydrateFromArOptions(res);
  }
  if (activeOptionsCanonicalKey === canonicalKey) {
    syncOptionEngineMarket(res);
  }
  state = {
    ...state,
    isBackendConnected: true,
    optionsByUnderlying: { ...state.optionsByUnderlying, [canonicalKey]: res },
    optionExpiriesByUnderlyingKey: { ...state.optionExpiriesByUnderlyingKey, [canonicalKey]: groups },
    feedStatus: combineFeedStatus(state.feedStatus, res.feedStatus),
    lastSyncUtcSec: res.asOfUtcSec,
  };
  notify();
}

/**
 * Pieza 50.2: carga on-demand la cadena de UN vencimiento US (`GET /api/options/expiry`)
 * sin abortar ni re-fetchear `/api/snapshot`, `/api/bars`, `/api/ar/overview` ni
 * catalizadores; fusiona el resultado sin reiniciar el resto de la terminal y limpia
 * `loadingOptionExpiries` en `finally`.
 */
export async function requestUsOptionExpiry(
  underlying: string,
  expirationDate: string,
  force = false,
): Promise<void> {
  const selection = parseOptionsUnderlyingKey(underlying);
  if (selection.market !== 'US') return;
  const clean = selection.symbol;
  const expiration = expirationDate.trim();
  if (!clean || !/^\d{4}-\d{2}-\d{2}$/.test(expiration)) return;
  const loadKey = `${selection.key}:${expiration}`;
  state = {
    ...state,
    loadingOptionExpiries: { ...state.loadingOptionExpiries, [loadKey]: true },
  };
  notify();
  try {
    const resp = await fetchJsonGuarded<UsOptionExpiryChainResponseDto>(
      `us:opt-expiry:${loadKey}${force ? ':force' : ''}`,
      `/api/options/expiry?symbol=${encodeURIComponent(clean)}&expiration=${encodeURIComponent(expiration)}${force ? '&refresh=1' : ''}`,
      { force },
    );
    if (!resp) return;
    const canonicalKey = selection.canonicalKey;
    const previous = state.optionsByUnderlying[canonicalKey];
    const merged = mergeUsExpiryChainIntoOptions(previous, resp);
    const groups = buildOptionExpiryGroupsFromArOptions(merged);
    if (activeOptionsCanonicalKey === canonicalKey) {
      syncOptionEngineMarket(merged);
    }
    const previousSnap = state.usSnapshotsBySymbol[clean];
    state = {
      ...state,
      isBackendConnected: true,
      optionsByUnderlying: { ...state.optionsByUnderlying, [canonicalKey]: merged },
      optionExpiriesByUnderlyingKey: { ...state.optionExpiriesByUnderlyingKey, [canonicalKey]: groups },
      ...(previousSnap !== undefined
        ? {
            usSnapshotsBySymbol: {
              ...state.usSnapshotsBySymbol,
              [clean]: applyUsExpiryChainToSnapshot(previousSnap, resp),
            },
          }
        : {}),
      feedStatus: combineFeedStatus(state.feedStatus, resp.feedMode),
      lastSyncUtcSec: resp.asOfUtcSec,
    };
    notify();
  } finally {
    state = {
      ...state,
      loadingOptionExpiries: { ...state.loadingOptionExpiries, [loadKey]: false },
    };
    notify();
  }
}

export async function requestOptionsUniverse(force = false): Promise<void> {
  if (state.optionsUnderlyingsStatus === 'OK' && !force) return;
  state = { ...state, optionsUnderlyingsStatus: 'LOADING' };
  notify();
  const res = await fetchJsonGuarded<OptionsUnderlyingsResponseDto>(
    'options:underlyings',
    '/api/options/underlyings',
    { force },
  );
  if (!res || !Array.isArray(res.underlyings) || res.underlyings.length === 0) {
    state = { ...state, optionsUnderlyingsStatus: 'NO_DATA' };
    notify();
    return;
  }
  state = {
    ...state,
    optionsUnderlyings: res.underlyings,
    optionsUnderlyingsStatus: 'OK',
    isBackendConnected: true,
  };
  notify();
}

export async function requestUsVolSurface(
  underlying: string,
  force = false,
): Promise<void> {
  const selection = parseOptionsUnderlyingKey(underlying);
  if (selection.market !== 'US') return;
  const status = state.usVolSurfaceStatusBySymbol[selection.key] ?? 'IDLE';
  if (status === 'LOADING' || (status === 'OK' && !force)) return;
  state = {
    ...state,
    usVolSurfaceStatusBySymbol: { ...state.usVolSurfaceStatusBySymbol, [selection.key]: 'LOADING' },
  };
  notify();
  const res = await fetchJsonGuarded<UsVolSurfaceResponseDto>(
    `us:vol-surface:${selection.key}${force ? ':force' : ''}`,
    `/api/us/vol-surface?symbol=${encodeURIComponent(selection.symbol)}${force ? '&refresh=1' : ''}`,
    { force },
  );
  if (!res) {
    state = {
      ...state,
      usVolSurfaceBySymbol: { ...state.usVolSurfaceBySymbol, [selection.key]: null },
      usVolSurfaceStatusBySymbol: { ...state.usVolSurfaceStatusBySymbol, [selection.key]: 'NO_DATA' },
    };
    notify();
    return;
  }
  state = {
    ...state,
    usVolSurfaceBySymbol: { ...state.usVolSurfaceBySymbol, [selection.key]: res },
    usVolSurfaceStatusBySymbol: {
      ...state.usVolSurfaceStatusBySymbol,
      [selection.key]: res.status === 'NO_DATA' ? 'NO_DATA' : 'OK',
    },
  };
  notify();
}

export async function requestOptionsCatalysts(
  underlying: string,
  force = false,
): Promise<void> {
  const selection = parseOptionsUnderlyingKey(underlying);
  if (selection.market !== 'US') return;
  const symbolKey = selection.symbol;
  if (!symbolKey) return;
  const status = state.optionsCatalystsStatusBySymbol[symbolKey] ?? 'IDLE';
  if (status === 'LOADING' || (status === 'OK' && !force)) return;
  state = {
    ...state,
    optionsCatalystsStatusBySymbol: {
      ...state.optionsCatalystsStatusBySymbol,
      [symbolKey]: 'LOADING',
    },
  };
  notify();
  const res = await fetchJsonGuarded<SymbolCatalystsResponseDto>(
    `options:catalysts:${symbolKey}${force ? ':force' : ''}`,
    `/api/options/catalysts?symbol=${encodeURIComponent(symbolKey)}${force ? '&refresh=1' : ''}`,
    { force },
  );
  if (!res) {
    state = {
      ...state,
      optionsCatalystsBySymbol: { ...state.optionsCatalystsBySymbol, [symbolKey]: null },
      optionsCatalystsStatusBySymbol: {
        ...state.optionsCatalystsStatusBySymbol,
        [symbolKey]: 'NO_DATA',
      },
    };
    notify();
    return;
  }
  state = {
    ...state,
    optionsCatalystsBySymbol: { ...state.optionsCatalystsBySymbol, [symbolKey]: res },
    optionsCatalystsStatusBySymbol: {
      ...state.optionsCatalystsStatusBySymbol,
      [symbolKey]: res.available ? 'OK' : 'NO_DATA',
    },
  };
  notify();
}

export async function requestUsSnapshot(
  symbol: string,
  options?: { readonly force?: boolean; readonly signal?: AbortSignal },
): Promise<UsSnapshotResponseDto | null> {
  const clean = symbol.trim().toUpperCase();
  if (!clean) return null;
  const res = await fetchJsonGuarded<UsSnapshotResponseDto>(
    `us:${clean}`,
    `/api/snapshot?symbol=${encodeURIComponent(clean)}&timeframe=5m${options?.force ? '&refresh=1' : ''}`,
    { force: options?.force === true, signal: options?.signal },
  );
  if (!res || !res.marketContext) return null;
  hydrateFromUsSnapshot(res);
  state = {
    ...state,
    isBackendConnected: true,
    usSnapshotsBySymbol: { ...state.usSnapshotsBySymbol, [clean]: res },
    ...(res.feedMode ? { feedStatus: combineFeedStatus(state.feedStatus, res.feedMode) } : {}),
    lastSyncUtcSec: res.asOfUtcSec,
  };
  publishTickerUpdatesFromMemory();
  notify();
  return res;
}

export function startLiveRuntimePolling(enabled: boolean): () => void {
  let disposed = false;

  const runInitialAndCycle = async () => {
    if (disposed) return;
    // Fase 1: ruta crítica de Inicio + panel AR (<= 5 requests simultáneos para no saturar pool HTTP/1.1)
    await Promise.all([
      refreshBackendHealth(),
      refreshOverview(),
      refreshMacro(),
      requestMonitoringPanel('bonos'),
      requestOptionsChain('AR:GGAL'),
    ]);
    if (disposed) return;
    // Fase 2: pares relativos + mercado US prioritario, sin bloquear el render inicial AR
    await Promise.all([
      requestRelations(),
      requestUsSnapshot('SPY'),
      requestUsSnapshot('QQQ'),
      requestOptionsUniverse(),
    ]);
    if (disposed) return;
    await Promise.all([
      requestUsSnapshot('NVDA'),
      requestUsSnapshot('AAPL'),
      requestUsSnapshot('MSFT'),
    ]);
    await refreshBackendHealth();
  };

  void runInitialAndCycle();

  if (!enabled) {
    return () => {
      disposed = true;
    };
  }

  let prevWarmupStatus = state.warmupStatus;
  let prevConnected = state.isBackendConnected;

  const retryMissingSlices = async () => {
    const tasks: Promise<unknown>[] = [];
    if (state.overview === null || state.feedStatus === 'NO_DATA') tasks.push(refreshOverview());
    if (state.macro === null) tasks.push(refreshMacro());
    if (state.monitoring === null) tasks.push(requestMonitoringPanel('bonos'));
    if (state.optionsByUnderlying['AR:GGAL'] === undefined) tasks.push(requestOptionsChain('AR:GGAL'));
    if (state.relations === null) tasks.push(requestRelations());
    if (state.usSnapshotsBySymbol['SPY'] === undefined) tasks.push(requestUsSnapshot('SPY'));
    if (state.usSnapshotsBySymbol['QQQ'] === undefined) tasks.push(requestUsSnapshot('QQQ'));
    if (tasks.length > 0) {
      await Promise.all(tasks);
    }
  };

  const fastRetryId = setInterval(() => {
    if (disposed) return;
    const needReconnectOrWarmup =
      !state.isBackendConnected ||
      state.warmupStatus === 'WARMING_UP' ||
      state.overview === null ||
      state.macro === null ||
      state.feedStatus === 'NO_DATA';
    if (needReconnectOrWarmup) {
      void (async () => {
        const ok = await refreshBackendHealth();
        if (ok) {
          const justConnected = !prevConnected;
          const justWarmed = prevWarmupStatus === 'WARMING_UP' && state.warmupStatus === 'READY';
          if (justConnected || justWarmed) {
            await runInitialAndCycle();
          } else if (state.overview === null || state.macro === null || state.feedStatus === 'NO_DATA') {
            await retryMissingSlices();
          }
        }
        prevConnected = state.isBackendConnected;
        prevWarmupStatus = state.warmupStatus;
      })();
    }
  }, 3_000);

  const intervalId = setInterval(() => {
    if (disposed) return;
    if (state.overview === null || state.macro === null || state.feedStatus === 'NO_DATA') {
      void retryMissingSlices();
      return;
    }
    void refreshBackendHealth();
    void refreshOverview();
  }, 20_000);

  return () => {
    disposed = true;
    clearInterval(fastRetryId);
    clearInterval(intervalId);
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

export function useLiveMarketStatus(): LiveMarketStatus {
  return useSyncExternalStore(
    (listener) => {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
    () => statusSnapshot,
    () => statusSnapshot,
  );
}

export function subscribeLiveTickerUpdates(fn: TickerListener): () => void {
  tickerListeners.add(fn);
  return () => {
    tickerListeners.delete(fn);
  };
}
