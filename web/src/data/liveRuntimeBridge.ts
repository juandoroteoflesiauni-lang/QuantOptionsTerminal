import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
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
  mergeLoadedExpiriesIntoBaseSnapshot,
  resolveExpiryFactDecision,
  resolvePublicationDecision,
  type ExpiryFactState,
  type PublicationStamp,
} from './snapshotPublication';
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
import { createVisibilityAwareInterval } from './visibilityLifecycle';

interface UsProviderNodeDto {
  readonly configured?: boolean;
  readonly connected?: boolean | null;
  readonly state?: string;
  readonly keySlot?: {
    readonly envName?: string;
    readonly slotIndex?: number;
    readonly poolSize?: number;
  } | null;
  readonly activeRole?: string;
  readonly lastError?: string | null;
  readonly poolSize?: number;
  readonly lastSlotIndex?: number | null;
  readonly roundRobinRequests?: number;
  readonly slots?: readonly { readonly envName?: string; readonly slotIndex?: number }[];
}

export interface UsProvidersStatusDto {
  readonly status?: string;
  readonly asOfUtcSec?: number;
  readonly usOptionsFeedBadge?: 'TRADIER LIVE + ORATS' | 'MASSIVE + ORATS';
  readonly providers?: {
    readonly MASSIVE_WS?: UsProviderNodeDto;
    readonly MASSIVE_REST_POOL?: UsProviderNodeDto;
    readonly TRADIER_LIVE?: UsProviderNodeDto;
    readonly ORATS?: UsProviderNodeDto;
  };
}

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
  readonly usProvidersStatus: UsProvidersStatusDto | null;
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
export type BridgeStaticChannel =
  | 'status' | 'overview' | 'macro' | 'monitoring' | 'relations'
  | 'optionsUnderlyings' | 'usProvidersStatus' | 'lastSync' | '__legacy_all__';
export type BridgeKeyedChannel =
  | `usSnapshot:${string}` | `stockDetail:${string}` | `options:${string}`
  | `optionLoading:${string}` | `volSurface:${string}` | `catalysts:${string}`;
export type BridgeChannelKey = BridgeStaticChannel | BridgeKeyedChannel;

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
  usProvidersStatus: null,
  usVolSurfaceBySymbol: {},
  usVolSurfaceStatusBySymbol: {},
  optionsCatalystsBySymbol: {},
  optionsCatalystsStatusBySymbol: {},
  loadingOptionExpiries: {},
  tickFlashes: Object.freeze({}),
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

const channelListeners = new Map<BridgeChannelKey, Map<StoreListener, number>>();
const tickerListeners = new Set<TickerListener>();
const seqByKey = new Map<string, number>();
interface InFlightEntry {
  readonly url: string;
  readonly token: number;
  readonly controller: AbortController;
  readonly waiters: Set<symbol>;
  readonly promise: Promise<unknown>;
}
const inFlightByKey = new Map<string, InFlightEntry>();
const lastKnownPriceBySymbol = new Map<string, number>();

// Pieza 50.9 (Bloque B): publicación ordenada por símbolo canónico y alcance.
// `base:US:SYM` para el snapshot base; `point:US:SYM:FECHA` para cargas puntuales.
const publicationRevisions = new Map<string, number>();
const basePublicationStamps = new Map<string, PublicationStamp>();
const pointPublicationStamps = new Map<string, PublicationStamp>();
// Hechos de vencimiento puntuales aceptados, por símbolo y fecha: el más
// reciente aceptado manda. Se aplican al publicar cada base (también cuando el
// símbolo ya tenía base, para conservarlos ante una base nueva).
type PendingPointFact =
  | { readonly kind: 'snapshot'; readonly snapshot: UsSnapshotResponseDto }
  | { readonly kind: 'chain'; readonly chain: UsOptionExpiryChainResponseDto };
const pendingPointFactsBySymbol = new Map<string, Map<string, PendingPointFact>>();
const publishedSnapshotResponses = new WeakMap<UsSnapshotResponseDto, UsSnapshotResponseDto>();
const publishedOptionResponses = new WeakSet<UsSnapshotResponseDto>();
// Evaluación (asOfUtcSec) de los datos cargados vigentes, por símbolo y fecha.
const loadedDateEvaluationsBySymbol = new Map<string, Map<string, number>>();

function beginPublication(scopeKey: string): number {
  const next = (publicationRevisions.get(scopeKey) ?? 0) + 1;
  publicationRevisions.set(scopeKey, next);
  return next;
}

function acceptPublication(
  stamps: Map<string, PublicationStamp>,
  scopeKey: string,
  revision: number,
  evaluationSec: number,
): boolean {
  const decision = resolvePublicationDecision(stamps.get(scopeKey) ?? null, {
    revision,
    evaluationSec,
  });
  if (decision === 'stale') return false;
  stamps.set(scopeKey, { revision, evaluationSec });
  return true;
}

function loadedDatesOf(snap: UsSnapshotResponseDto): ReadonlySet<string> {
  const dates = new Set<string>();
  for (const candidate of snap.optionsChain?.availableExpirations ?? []) {
    if (candidate.loaded === true) dates.add(candidate.expirationDate);
  }
  return dates;
}

function loadedEntryOf(
  snap: UsSnapshotResponseDto,
  date: string,
): { readonly loaded: boolean } | null {
  const entry = (snap.optionsChain?.availableExpirations ?? []).find(
    (candidate) => candidate.expirationDate === date,
  );
  return entry === undefined ? null : { loaded: entry.loaded === true };
}

/** Estado vigente de una fecha: entrada del snapshot visible + su evaluación. */
function currentFactState(
  clean: string,
  previous: UsSnapshotResponseDto | undefined,
  date: string,
): ExpiryFactState | null {
  if (previous !== undefined) {
    const entry = loadedEntryOf(previous, date);
    if (entry !== null) {
      return {
        loaded: entry.loaded,
        evaluationSec: loadedDateEvaluationsBySymbol.get(clean)?.get(date) ?? null,
      };
    }
  }
  const pending = pendingPointFactsBySymbol.get(clean)?.get(date);
  if (pending !== undefined) {
    return pending.kind === 'snapshot'
      ? snapshotFactState(pending.snapshot, date)
      : chainFactState(pending.chain);
  }
  return null;
}

function snapshotFactState(snap: UsSnapshotResponseDto, date: string): ExpiryFactState {
  const entry = loadedEntryOf(snap, date);
  return {
    loaded: entry !== null && entry.loaded,
    evaluationSec: Number.isFinite(snap.asOfUtcSec) ? snap.asOfUtcSec : null,
  };
}

function chainFactState(chain: UsOptionExpiryChainResponseDto): ExpiryFactState {
  return {
    loaded: chain.expiryMeta.loaded === true,
    evaluationSec: Number.isFinite(chain.asOfUtcSec) ? chain.asOfUtcSec : null,
  };
}

function pendingFactState(fact: PendingPointFact, date: string): ExpiryFactState {
  return fact.kind === 'snapshot'
    ? snapshotFactState(fact.snapshot, date)
    : chainFactState(fact.chain);
}

function setLoadedDateEvaluation(clean: string, date: string, evaluationSec: number | null): void {
  if (evaluationSec === null || !Number.isFinite(evaluationSec)) return;
  const evaluations = loadedDateEvaluationsBySymbol.get(clean) ?? new Map<string, number>();
  evaluations.set(date, evaluationSec);
  loadedDateEvaluationsBySymbol.set(clean, evaluations);
}

function stashPointSnapshot(clean: string, expirationDate: string, snapshot: UsSnapshotResponseDto): void {
  const facts = pendingPointFactsBySymbol.get(clean) ?? new Map<string, PendingPointFact>();
  facts.set(expirationDate, { kind: 'snapshot', snapshot });
  pendingPointFactsBySymbol.set(clean, facts);
}

function stashExpiryChain(clean: string, expirationDate: string, response: UsOptionExpiryChainResponseDto): void {
  const facts = pendingPointFactsBySymbol.get(clean) ?? new Map<string, PendingPointFact>();
  facts.set(expirationDate, { kind: 'chain', chain: response });
  pendingPointFactsBySymbol.set(clean, facts);
}

/**
 * Publica la base: el agregado (exposición, traza, spot de valuación, asOf) es
 * SIEMPRE de la base; por vencimiento gana el dato más nuevo. La base no pisa
 * hechos puntuales más nuevos, los hechos retenidos no resucitan versiones
 * superadas y una fecha cargada que la base omita conserva su información.
 */
function publishBaseSnapshot(
  clean: string,
  base: UsSnapshotResponseDto,
  previous: UsSnapshotResponseDto | undefined,
): UsSnapshotResponseDto {
  const previousEvaluations = loadedDateEvaluationsBySymbol.get(clean);
  const nextEvaluations = new Map<string, number>();
  for (const date of loadedDatesOf(base)) {
    if (Number.isFinite(base.asOfUtcSec)) nextEvaluations.set(date, base.asOfUtcSec);
  }

  let merged = base;
  if (previous !== undefined) {
    for (const date of [...loadedDatesOf(previous)].sort((a, b) => a.localeCompare(b))) {
      const previousEvaluation = previousEvaluations?.get(date) ?? previous.asOfUtcSec;
      const baseEntry = loadedEntryOf(base, date);
      const decision = resolveExpiryFactDecision(
        {
          loaded: true,
          evaluationSec: Number.isFinite(previousEvaluation) ? previousEvaluation : null,
        },
        {
          loaded: baseEntry !== null && baseEntry.loaded,
          evaluationSec: Number.isFinite(base.asOfUtcSec) ? base.asOfUtcSec : null,
        },
      );
      if (decision !== 'publish') continue;
      merged = mergeLoadedExpiriesIntoBaseSnapshot(merged, previous, date);
      if (Number.isFinite(previousEvaluation)) nextEvaluations.set(date, previousEvaluation);
    }
  }

  const pending = pendingPointFactsBySymbol.get(clean);
  if (pending !== undefined) {
    for (const date of [...pending.keys()].sort((a, b) => a.localeCompare(b))) {
      const fact = pending.get(date);
      if (fact === undefined) continue;
      const factState = pendingFactState(fact, date);
      const mergedEntry = loadedEntryOf(merged, date);
      const decision = resolveExpiryFactDecision(factState, {
        loaded: mergedEntry !== null && mergedEntry.loaded,
        evaluationSec: nextEvaluations.get(date) ?? null,
      });
      if (decision !== 'publish') {
        pending.delete(date);
        continue;
      }
      merged =
        fact.kind === 'snapshot'
          ? mergeLoadedExpiriesIntoBaseSnapshot(merged, fact.snapshot, date)
          : applyUsExpiryChainToSnapshot(merged, fact.chain);
      if (factState.evaluationSec !== null) nextEvaluations.set(date, factState.evaluationSec);
    }
    if (pending.size === 0) pendingPointFactsBySymbol.delete(clean);
  }

  loadedDateEvaluationsBySymbol.set(clean, nextEvaluations);
  return merged;
}

const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

export function subscribeBridgeChannel(channel: BridgeChannelKey, listener: StoreListener): () => void {
  return subscribeBridgeChannels([channel], listener);
}

export function subscribeBridgeChannels(
  channels: readonly BridgeChannelKey[],
  listener: StoreListener,
): () => void {
  const uniqueChannels = new Set(channels);
  for (const channel of uniqueChannels) {
    const registered = channelListeners.get(channel) ?? new Map<StoreListener, number>();
    registered.set(listener, (registered.get(listener) ?? 0) + 1);
    channelListeners.set(channel, registered);
  }
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    for (const channel of uniqueChannels) {
      const registered = channelListeners.get(channel);
      const references = registered?.get(listener);
      if (registered === undefined || references === undefined) continue;
      if (references === 1) registered.delete(listener);
      else registered.set(listener, references - 1);
      if (registered.size === 0) channelListeners.delete(channel);
    }
  };
}

export function getBridgeListenerStats() {
  const byChannel = {
    __legacy_all__: 0,
    ...Object.fromEntries([...channelListeners].map(([channel, registered]) => [channel, registered.size])),
  };
  return {
    totalChannels: channelListeners.size,
    totalListeners: new Set([...channelListeners.values()].flatMap((registered) => [...registered.keys()])).size,
    byChannel,
  };
}

function commitBridgeState(next: LiveMarketState, dirtyChannels: readonly BridgeChannelKey[]): void {
  const dirty = new Set(dirtyChannels);
  if (
    statusSnapshot.isBackendConnected !== next.isBackendConnected ||
    statusSnapshot.feedStatus !== next.feedStatus ||
    statusSnapshot.marketState !== next.marketState ||
    statusSnapshot.marketStateLabel !== next.marketStateLabel ||
    statusSnapshot.warmupStatus !== next.warmupStatus
  ) {
    statusSnapshot = {
      isBackendConnected: next.isBackendConnected,
      feedStatus: next.feedStatus,
      marketState: next.marketState,
      marketStateLabel: next.marketStateLabel,
      warmupStatus: next.warmupStatus,
    };
    dirty.add('status');
  }
  if (state.lastSyncUtcSec !== next.lastSyncUtcSec || state.providerErrors !== next.providerErrors) {
    dirty.add('lastSync');
  }
  if (dirty.size === 0) return;

  state = { ...next, version: state.version + 1 };
  dirty.add('__legacy_all__');
  const pending = new Set<StoreListener>();
  for (const channel of dirty) {
    channelListeners.get(channel)?.forEach((_references, listener) => pending.add(listener));
  }
  for (const listener of pending) listener();
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

function fetchJsonGuarded<T>(
  key: string,
  url: string,
  options?: { readonly force?: boolean; readonly timeoutMs?: number; readonly signal?: AbortSignal },
): Promise<T | null> {
  const signal = options?.signal;
  if (signal?.aborted) return Promise.resolve(null);

  let entry = inFlightByKey.get(key);
  if (entry === undefined || entry.url !== url || entry.controller.signal.aborted || options?.force) {
    entry?.controller.abort();
    const controller = new AbortController();
    const token = (seqByKey.get(key) ?? 0) + 1;
    seqByKey.set(key, token);
    const timeout = setTimeout(() => controller.abort(), options?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
    const promise = Promise.resolve().then(async () => {
      if (controller.signal.aborted) return null;
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) return null;
      const body: unknown = await response.json();
      return controller.signal.aborted || seqByKey.get(key) !== token ? null : body;
    }).catch(() => null).finally(() => {
      clearTimeout(timeout);
      if (inFlightByKey.get(key)?.token === token) inFlightByKey.delete(key);
    });
    entry = { url, token, controller, promise, waiters: new Set() };
    inFlightByKey.set(key, entry);
  }

  const shared = entry;
  const waiter = Symbol();
  shared.waiters.add(waiter);
  return new Promise((resolve) => {
    const finish = (body: T | null) => {
      if (!shared.waiters.delete(waiter)) return;
      signal?.removeEventListener('abort', cancel);
      shared.controller.signal.removeEventListener('abort', cancel);
      resolve(body);
    };
    const cancel = () => {
      finish(null);
      if (shared.waiters.size === 0) shared.controller.abort();
    };
    signal?.addEventListener('abort', cancel, { once: true });
    shared.controller.signal.addEventListener('abort', cancel, { once: true });
    void shared.promise.then((body) => {
      finish(signal?.aborted || shared.controller.signal.aborted ? null : body as T | null);
    });
  });
}

function combineFeedStatus(a: FeedStatus, b: FeedStatus): FeedStatus {
  if (a === 'NO_DATA') return b;
  if (b === 'NO_DATA') return a;
  if (a === 'LIVE' || b === 'LIVE') return 'LIVE';
  if (a === 'DIFERIDO_20M' || b === 'DIFERIDO_20M') return 'DIFERIDO_20M';
  if (a === 'EOD_CIERRE' || b === 'EOD_CIERRE') return 'EOD_CIERRE';
  return 'PARTIAL';
}

export async function refreshOverview(force = false, signal?: AbortSignal): Promise<void> {
  const res = await fetchJsonGuarded<ArOverviewResponse>(
    'overview',
    `/api/ar/overview${force ? '?refresh=1' : ''}`,
    { force, signal }
  );
  if (signal?.aborted) return;
  if (!res) {
    if (!state.overview) {
      commitBridgeState({ ...state, feedStatus: 'NO_DATA' }, []);
    }
    return;
  }
  if (state.overview === res) return;
  hydrateFromArOverview(res);

  commitBridgeState({
    ...state,
    isBackendConnected: true,
    overview: res,
    feedStatus: combineFeedStatus(state.feedStatus, res.feedStatus),
    marketState: res.marketState,
    marketStateLabel: res.marketStateLabel,
    providerErrors: [...res.providerErrors],
    lastSyncUtcSec: res.asOfUtcSec,
  }, ['overview']);
  publishTickerUpdatesFromMemory();
}

export async function refreshMacro(force = false, signal?: AbortSignal): Promise<void> {
  const res = await fetchJsonGuarded<ArMacroResponse>(
    'macro',
    `/api/ar/macro${force ? '?refresh=1' : ''}`,
    { force, signal }
  );
  if (!res || signal?.aborted || state.macro === res) return;
  hydrateFromArMacro(res);
  commitBridgeState({
    ...state,
    isBackendConnected: true,
    macro: res,
    feedStatus: combineFeedStatus(state.feedStatus, res.feedStatus),
    lastSyncUtcSec: res.asOfUtcSec,
  }, ['macro']);
  publishTickerUpdatesFromMemory();
}

export async function requestMonitoringPanel(
  panel: 'acciones' | 'bonos' | 'cedears' | 'cauciones',
  force = false,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetchJsonGuarded<ArMonitoringResponse>(
    'monitoring',
    `/api/ar/monitoring?panel=${encodeURIComponent(panel)}${force ? '&refresh=1' : ''}`,
    { force, signal }
  );
  if (!res || signal?.aborted || state.monitoring === res) return;
  hydrateFromArMonitoring(res);
  commitBridgeState({
    ...state,
    monitoring: res,
    feedStatus: combineFeedStatus(state.feedStatus, res.feedStatus),
    lastSyncUtcSec: res.asOfUtcSec,
  }, ['monitoring']);
  publishTickerUpdatesFromMemory();
}

export async function requestRelations(force = false, signal?: AbortSignal): Promise<void> {
  const res = await fetchJsonGuarded<ArRelationsResponse>(
    'relations',
    `/api/ar/relations${force ? '?refresh=1' : ''}`,
    { force, signal }
  );
  if (!res || signal?.aborted || state.relations === res) return;
  hydrateFromArRelations(res);
  commitBridgeState({
    ...state,
    relations: res,
    feedStatus: combineFeedStatus(state.feedStatus, res.feedStatus),
    lastSyncUtcSec: res.asOfUtcSec,
  }, ['relations']);
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
  if (!res || signal?.aborted) return null;
  if (state.stockDetailsBySymbol[clean] === res) return res;
  commitBridgeState({
    ...state,
    stockDetailsBySymbol: { ...state.stockDetailsBySymbol, [clean]: res },
    feedStatus: combineFeedStatus(state.feedStatus, res.feedStatus),
    lastSyncUtcSec: res.asOfUtcSec,
  }, [keyed('stockDetail', clean)]);
  return res;
}

export async function requestTerminalBars(
  symbol: string,
  timeframe: TerminalTimeframe,
  options?: {
    readonly force?: boolean;
    readonly visibleBars?: number;
    /** Let the backend resolve the exchange-session default when no override is supplied. */
    readonly adaptiveWindow?: boolean;
    readonly signal?: AbortSignal;
    readonly market?: 'US' | 'AR';
    readonly includeOverlays?: boolean;
    readonly includeMtfEma?: boolean;
    readonly includeVpHorizons?: boolean;
  },
): Promise<UsTerminalBarsResponseDto | null> {
  const clean = symbol.trim().toUpperCase();
  if (!clean) return null;
  const vis = options?.visibleBars ?? 180;
  const adaptiveWindow = options?.adaptiveWindow === true && options.visibleBars === undefined;
  const visibleParam = adaptiveWindow ? '' : `&visibleBars=${String(vis)}`;
  // Pieza 38: `market=AR` desambigua el ticker local ARS (p. ej. NVDA CEDEAR)
  // del subyacente US en USD (SPEC punto 10). La clave de caché incluye el
  // mercado para no pisar `NVDA:1D:US` con `NVDA:1D:AR`.
  const market = options?.market ?? 'US';
  const overlaysParam = (options?.includeOverlays === false ? '&overlays=0' : '') + (options?.includeMtfEma===true?'&ema20_5m=1':'') + (options?.includeVpHorizons === true ? '&vpHorizons=1' : '');
  return fetchJsonGuarded<UsTerminalBarsResponseDto>(
    `bars:${clean}:${timeframe}:${market}:${adaptiveWindow ? 'adaptive' : String(vis)}${overlaysParam}`,
    `/api/bars?symbol=${encodeURIComponent(clean)}&timeframe=${encodeURIComponent(timeframe)}&market=${market}${visibleParam}${options?.force ? '&refresh=1' : ''}${overlaysParam}`,
    { force: options?.force === true, signal: options?.signal },
  );
}

interface HealthResponseDto {
  readonly ok?: boolean;
  readonly warmupStatus?: 'IDLE' | 'WARMING_UP' | 'READY';
}

export async function refreshBackendHealth(signal?: AbortSignal): Promise<boolean> {
  const health = await fetchJsonGuarded<HealthResponseDto>('health', '/api/health', { signal });
  if (signal?.aborted) return false;
  if (!health || health.ok !== true) {
    if (state.isBackendConnected) {
      commitBridgeState({ ...state, isBackendConnected: false }, []);
    }
    return false;
  }
  const nextWarmup = health.warmupStatus ?? 'READY';
  if (!state.isBackendConnected || state.warmupStatus !== nextWarmup) {
    commitBridgeState({
      ...state,
      isBackendConnected: true,
      warmupStatus: nextWarmup,
    }, []);
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
  return marketState.optionExpiriesByUnderlyingKey[parseOptionsUnderlyingKey(rawKey).canonicalKey] ?? EMPTY_EXPIRIES;
}

export async function requestOptionsChain(
  underlying: string,
  force = false,
  expiration?: string,
  signal?: AbortSignal,
): Promise<void> {
  const selection = parseOptionsUnderlyingKey(underlying);
  // Pieza 50.3: el almacenamiento y el motor se aíslan por `market:symbol`.
  const canonicalKey = selection.canonicalKey;
  const clean = selection.symbol;
  if (!clean) return;
  if (selection.market === 'US') {
    const isPointScope = expiration !== undefined && expiration !== '';
    const scopeKey = isPointScope ? `point:US:${clean}:${expiration}` : `base:US:${clean}`;
    const revision = beginPublication(scopeKey);
    const snap = await fetchJsonGuarded<UsSnapshotResponseDto>(
      `us:opt:${selection.key}${expiration ? `:${expiration}` : ''}`,
      `/api/snapshot?symbol=${encodeURIComponent(clean)}${expiration ? `&expiration=${encodeURIComponent(expiration)}` : ''}`,
      { force, signal },
    );
    if (!snap || signal?.aborted) return;
    if (publishedOptionResponses.has(snap)) return;
    const stamps = isPointScope ? pointPublicationStamps : basePublicationStamps;
    // Comprobación antes de mutar estado o hidratar consumidores.
    if (!acceptPublication(stamps, scopeKey, revision, snap.asOfUtcSec)) return;
    const previousSnap = state.usSnapshotsBySymbol[clean];
    let publishedSnap: UsSnapshotResponseDto | null = null;
    if (isPointScope) {
      // Alcance puntual: SOLO se publica si aporta datos más nuevos para SU
      // vencimiento; rechazado -> cero mutaciones de motor, estado ni notify.
      const fact = snapshotFactState(snap, expiration);
      const decision = resolveExpiryFactDecision(
        fact,
        currentFactState(clean, previousSnap, expiration),
      );
      if (decision !== 'publish') return;
      publishedOptionResponses.add(snap);
      stashPointSnapshot(clean, expiration, snap);
      if (previousSnap !== undefined) {
        publishedSnap = mergeLoadedExpiriesIntoBaseSnapshot(previousSnap, snap, expiration);
        setLoadedDateEvaluation(clean, expiration, fact.evaluationSec);
        hydrateFromUsSnapshot(publishedSnap);
      }
      const mapped = mapUsSnapshotToArOptions(clean, snap);
      const merged = mergeArOptionsWithHydratedExpiry(state.optionsByUnderlying[canonicalKey], mapped);
      const groups = buildOptionExpiryGroupsFromArOptions(merged);
      if (activeOptionsCanonicalKey === canonicalKey) {
        syncOptionEngineMarket(merged);
      }
      commitBridgeState({
        ...state,
        isBackendConnected: true,
        ...(publishedSnap !== null
          ? { usSnapshotsBySymbol: { ...state.usSnapshotsBySymbol, [clean]: publishedSnap } }
          : {}),
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
      }, [keyed('options', canonicalKey), ...(publishedSnap !== null ? [keyed('usSnapshot', clean)] : []), ...(snap.catalysts ? [keyed('catalysts', clean)] : [])]);
      return;
    }

    publishedSnap = publishBaseSnapshot(clean, snap, previousSnap);
    publishedOptionResponses.add(snap);
    hydrateFromUsSnapshot(publishedSnap);
    const mapped = mapUsSnapshotToArOptions(clean, publishedSnap);
    // Pieza 50.1: fusionar el vencimiento recién cargado sin borrar los otros ya hidratados.
    const merged = mergeArOptionsWithHydratedExpiry(state.optionsByUnderlying[canonicalKey], mapped);
    const groups = buildOptionExpiryGroupsFromArOptions(merged);
    if (activeOptionsCanonicalKey === canonicalKey) {
      syncOptionEngineMarket(merged);
    }
    commitBridgeState({
      ...state,
      isBackendConnected: true,
      usSnapshotsBySymbol: { ...state.usSnapshotsBySymbol, [clean]: publishedSnap },
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
    }, [keyed('options', canonicalKey), keyed('usSnapshot', clean), ...(snap.catalysts ? [keyed('catalysts', clean)] : [])]);
    return;
  }
  const res = await fetchJsonGuarded<ArOptionsResponse>(
    `options:${selection.key}`,
    `/api/ar/options?underlying=${encodeURIComponent(clean)}${force ? '&refresh=1' : ''}`,
    { force, signal }
  );
  if (!res || signal?.aborted || state.optionsByUnderlying[canonicalKey] === res) return;
  const groups = buildOptionExpiryGroupsFromArOptions(res);
  // Espejo retrocompatible exclusivo de AR:GGAL (jamás toca claves US:*).
  if (canonicalKey === 'AR:GGAL') {
    hydrateFromArOptions(res);
  }
  if (activeOptionsCanonicalKey === canonicalKey) {
    syncOptionEngineMarket(res);
  }
  commitBridgeState({
    ...state,
    isBackendConnected: true,
    optionsByUnderlying: { ...state.optionsByUnderlying, [canonicalKey]: res },
    optionExpiriesByUnderlyingKey: { ...state.optionExpiriesByUnderlyingKey, [canonicalKey]: groups },
    feedStatus: combineFeedStatus(state.feedStatus, res.feedStatus),
    lastSyncUtcSec: res.asOfUtcSec,
  }, [keyed('options', canonicalKey)]);
}

const expiryLoadWaiters = new Map<string, Set<symbol>>();

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
  signal?: AbortSignal,
): Promise<void> {
  const selection = parseOptionsUnderlyingKey(underlying);
  if (selection.market !== 'US') return;
  const clean = selection.symbol;
  const expiration = expirationDate.trim();
  if (!clean || !/^\d{4}-\d{2}-\d{2}$/.test(expiration)) return;
  const loadKey = `${selection.key}:${expiration}`;
  const requestKey = `us:opt-expiry:${loadKey}`;
  if (signal?.aborted) return;
  const canonicalKey = selection.canonicalKey;
  const loadingChannel = keyed('optionLoading', canonicalKey);
  const waiters = expiryLoadWaiters.get(loadKey) ?? new Set<symbol>();
  const waiter = Symbol();
  waiters.add(waiter);
  expiryLoadWaiters.set(loadKey, waiters);
  if (state.loadingOptionExpiries[loadKey] !== true) {
    commitBridgeState({
      ...state,
      loadingOptionExpiries: { ...state.loadingOptionExpiries, [loadKey]: true },
    }, [loadingChannel]);
  }
  const releaseLoading = (published = false) => {
    waiters.delete(waiter);
    if (published && !inFlightByKey.has(requestKey)) waiters.clear();
    if (waiters.size !== 0 || expiryLoadWaiters.get(loadKey) !== waiters) return false;
    expiryLoadWaiters.delete(loadKey);
    return true;
  };
  let clearedLoadingInCommit = false;
  try {
    const scopeKey = `point:US:${clean}:${expiration}`;
    const revision = beginPublication(scopeKey);
    const resp = await fetchJsonGuarded<UsOptionExpiryChainResponseDto>(
      requestKey,
      `/api/options/expiry?symbol=${encodeURIComponent(clean)}&expiration=${encodeURIComponent(expiration)}${force ? '&refresh=1' : ''}`,
      { force, signal },
    );
    if (!resp || signal?.aborted) return;
    // Comprobación antes de mutar estado o hidratar consumidores.
    if (!acceptPublication(pointPublicationStamps, scopeKey, revision, resp.asOfUtcSec)) return;
    const previousSnap = state.usSnapshotsBySymbol[clean];
    const fact = chainFactState(resp);
    const decision = resolveExpiryFactDecision(
      fact,
      currentFactState(clean, previousSnap, expiration),
    );
    // Hecho no más nuevo que el vigente: no se muta estado, cadena ni motor.
    if (decision !== 'publish') return;
    const previous = state.optionsByUnderlying[canonicalKey];
    const merged = mergeUsExpiryChainIntoOptions(previous, resp);
    const groups = buildOptionExpiryGroupsFromArOptions(merged);
    if (activeOptionsCanonicalKey === canonicalKey) {
      syncOptionEngineMarket(merged);
    }
    let nextSnap = previousSnap;
    stashExpiryChain(clean, expiration, resp);
    if (previousSnap !== undefined) {
      nextSnap = applyUsExpiryChainToSnapshot(previousSnap, resp);
      setLoadedDateEvaluation(clean, expiration, fact.evaluationSec);
    }
    clearedLoadingInCommit = releaseLoading(true);
    commitBridgeState({
      ...state,
      isBackendConnected: true,
      loadingOptionExpiries: clearedLoadingInCommit
        ? { ...state.loadingOptionExpiries, [loadKey]: false }
        : state.loadingOptionExpiries,
      optionsByUnderlying: { ...state.optionsByUnderlying, [canonicalKey]: merged },
      optionExpiriesByUnderlyingKey: { ...state.optionExpiriesByUnderlyingKey, [canonicalKey]: groups },
      // Alcance puntual: actualiza los hechos de SU vencimiento sobre la base
      // vigente solo si son más nuevos; exposición agregada, traza, spot de
      // valuación y asOf de la base no se tocan. Sin base, el hecho queda
      // pendiente hasta que llegue.
      ...(nextSnap !== undefined
        ? {
            usSnapshotsBySymbol: {
              ...state.usSnapshotsBySymbol,
              [clean]: nextSnap,
            },
          }
        : {}),
      feedStatus: combineFeedStatus(state.feedStatus, resp.feedMode),
      lastSyncUtcSec: resp.asOfUtcSec,
    }, [
      keyed('options', canonicalKey),
      ...(clearedLoadingInCommit ? [loadingChannel] : []),
      ...(nextSnap !== undefined ? [keyed('usSnapshot', clean)] : []),
    ]);
  } finally {
    if (!clearedLoadingInCommit && releaseLoading()) {
      commitBridgeState({
        ...state,
        loadingOptionExpiries: { ...state.loadingOptionExpiries, [loadKey]: false },
      }, [loadingChannel]);
    }
  }
}

export async function requestOptionsUniverse(force = false, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  if (state.optionsUnderlyingsStatus === 'OK' && !force) return;
  if (state.optionsUnderlyingsStatus !== 'LOADING') {
    commitBridgeState({ ...state, optionsUnderlyingsStatus: 'LOADING' }, ['optionsUnderlyings']);
  }
  const res = await fetchJsonGuarded<OptionsUnderlyingsResponseDto>(
    'options:underlyings',
    '/api/options/underlyings',
    { force, signal },
  );
  if (signal?.aborted) {
    if (!inFlightByKey.has('options:underlyings') && state.optionsUnderlyingsStatus === 'LOADING') {
      const status = state.optionsUnderlyings.length > 0 ? 'OK' : 'IDLE';
      commitBridgeState({ ...state, optionsUnderlyingsStatus: status }, ['optionsUnderlyings']);
    }
    return;
  }
  if (!res || !Array.isArray(res.underlyings) || res.underlyings.length === 0) {
    if (state.optionsUnderlyingsStatus === 'LOADING') {
      commitBridgeState({ ...state, optionsUnderlyingsStatus: 'NO_DATA' }, ['optionsUnderlyings']);
    }
    return;
  }
  if (state.optionsUnderlyings === res.underlyings && state.optionsUnderlyingsStatus === 'OK') return;
  commitBridgeState({
    ...state,
    optionsUnderlyings: res.underlyings,
    optionsUnderlyingsStatus: 'OK',
    isBackendConnected: true,
  }, ['optionsUnderlyings']);
}

export async function requestUsVolSurface(
  underlying: string,
  force = false,
  signal?: AbortSignal,
): Promise<void> {
  const selection = parseOptionsUnderlyingKey(underlying);
  if (selection.market !== 'US') return;
  if (signal?.aborted) return;
  const channel = keyed('volSurface', selection.canonicalKey);
  const requestKey = 'us:vol-surface:' + selection.key;
  const status = state.usVolSurfaceStatusBySymbol[selection.key] ?? 'IDLE';
  if (status === 'OK' && !force) return;
  if (status !== 'LOADING') {
    commitBridgeState({
      ...state,
      usVolSurfaceStatusBySymbol: { ...state.usVolSurfaceStatusBySymbol, [selection.key]: 'LOADING' },
    }, [channel]);
  }
  const res = await fetchJsonGuarded<UsVolSurfaceResponseDto>(
    requestKey,
    `/api/us/vol-surface?symbol=${encodeURIComponent(selection.symbol)}${force ? '&refresh=1' : ''}`,
    { force, signal },
  );
  if (signal?.aborted) {
    if (inFlightByKey.has(requestKey) || state.usVolSurfaceStatusBySymbol[selection.key] !== 'LOADING') return;
    const cached = state.usVolSurfaceBySymbol[selection.key];
    commitBridgeState({
      ...state,
      usVolSurfaceStatusBySymbol: { ...state.usVolSurfaceStatusBySymbol, [selection.key]: cached === undefined ? 'IDLE' : cached === null ? 'NO_DATA' : 'OK' },
    }, [channel]);
    return;
  }
  const nextStatus = res === null ? 'NO_DATA' : res.status === 'NO_DATA' ? 'NO_DATA' : 'OK';
  if (state.usVolSurfaceBySymbol[selection.key] === res && state.usVolSurfaceStatusBySymbol[selection.key] === nextStatus) return;
  commitBridgeState({
    ...state,
    usVolSurfaceBySymbol: { ...state.usVolSurfaceBySymbol, [selection.key]: res },
    usVolSurfaceStatusBySymbol: { ...state.usVolSurfaceStatusBySymbol, [selection.key]: nextStatus },
  }, [channel]);
}

export async function requestOptionsCatalysts(
  underlying: string,
  force = false,
  signal?: AbortSignal,
): Promise<void> {
  const selection = parseOptionsUnderlyingKey(underlying);
  if (selection.market !== 'US') return;
  const symbolKey = selection.symbol;
  if (!symbolKey) return;
  if (signal?.aborted) return;
  const channel = keyed('catalysts', symbolKey);
  const requestKey = 'options:catalysts:' + symbolKey;
  const status = state.optionsCatalystsStatusBySymbol[symbolKey] ?? 'IDLE';
  if (status === 'OK' && !force) return;
  if (status !== 'LOADING') {
    commitBridgeState({
      ...state,
      optionsCatalystsStatusBySymbol: { ...state.optionsCatalystsStatusBySymbol, [symbolKey]: 'LOADING' },
    }, [channel]);
  }
  const res = await fetchJsonGuarded<SymbolCatalystsResponseDto>(
    requestKey,
    `/api/options/catalysts?symbol=${encodeURIComponent(symbolKey)}${force ? '&refresh=1' : ''}`,
    { force, signal },
  );
  if (signal?.aborted) {
    if (inFlightByKey.has(requestKey) || state.optionsCatalystsStatusBySymbol[symbolKey] !== 'LOADING') return;
    const cached = state.optionsCatalystsBySymbol[symbolKey];
    commitBridgeState({
      ...state,
      optionsCatalystsStatusBySymbol: { ...state.optionsCatalystsStatusBySymbol, [symbolKey]: cached === undefined ? 'IDLE' : cached === null ? 'NO_DATA' : 'OK' },
    }, [channel]);
    return;
  }
  const nextStatus = res === null ? 'NO_DATA' : res.available ? 'OK' : 'NO_DATA';
  if (state.optionsCatalystsBySymbol[symbolKey] === res && state.optionsCatalystsStatusBySymbol[symbolKey] === nextStatus) return;
  commitBridgeState({
    ...state,
    optionsCatalystsBySymbol: { ...state.optionsCatalystsBySymbol, [symbolKey]: res },
    optionsCatalystsStatusBySymbol: { ...state.optionsCatalystsStatusBySymbol, [symbolKey]: nextStatus },
  }, [channel]);
}

export async function requestUsSnapshot(
  symbol: string,
  options?: {
    readonly force?: boolean;
    readonly signal?: AbortSignal;
    /** Pieza 50.9 B: explícito `false` añade `prefetch=0`; por defecto no cambia la URL. */
    readonly prefetch?: boolean;
  },
): Promise<UsSnapshotResponseDto | null> {
  const clean = symbol.trim().toUpperCase();
  if (!clean) return null;
  const scopeKey = `base:US:${clean}`;
  const revision = beginPublication(scopeKey);
  const res = await fetchJsonGuarded<UsSnapshotResponseDto>(
    `us:${clean}`,
    `/api/snapshot?symbol=${encodeURIComponent(clean)}&timeframe=5m${options?.force ? '&refresh=1' : ''}${options?.prefetch === false ? '&prefetch=0' : ''}`,
    { force: options?.force === true, signal: options?.signal },
  );
  if (!res || !res.marketContext || options?.signal?.aborted) return null;
  const alreadyPublished = publishedSnapshotResponses.get(res);
  if (alreadyPublished !== undefined) return alreadyPublished;
  // Comprobación antes de mutar estado o hidratar consumidores.
  if (!acceptPublication(basePublicationStamps, scopeKey, revision, res.asOfUtcSec)) return null;
  const published = publishBaseSnapshot(clean, res, state.usSnapshotsBySymbol[clean]);
  publishedSnapshotResponses.set(res, published);
  hydrateFromUsSnapshot(published);
  commitBridgeState({
    ...state,
    isBackendConnected: true,
    usSnapshotsBySymbol: { ...state.usSnapshotsBySymbol, [clean]: published },
    ...(res.feedMode ? { feedStatus: combineFeedStatus(state.feedStatus, res.feedMode) } : {}),
    lastSyncUtcSec: published.asOfUtcSec,
  }, [keyed('usSnapshot', clean)]);
  publishTickerUpdatesFromMemory();
  return published;
}

export function startLiveRuntimePolling(enabled: boolean): () => void {
  const retryMissingSlices = async (signal: AbortSignal) => {
    const tasks: Promise<unknown>[] = [];
    if (state.macro === null) tasks.push(refreshMacro(false, signal));
    if (state.optionsByUnderlying['AR:GGAL'] === undefined) tasks.push(requestOptionsChain('AR:GGAL', false, undefined, signal));
    if (state.usSnapshotsBySymbol['SPY'] === undefined) tasks.push(requestUsSnapshot('SPY', { signal }));
    if (state.usSnapshotsBySymbol['QQQ'] === undefined) tasks.push(requestUsSnapshot('QQQ', { signal }));
    await Promise.all(tasks);
  };

  const cycle = createVisibilityAwareInterval(async (signal) => {
    await Promise.all([refreshBackendHealth(signal), refreshOverview(false, signal), retryMissingSlices(signal)]);
  }, 20_000, { runImmediately: true, reconcileAfterMs: 15_000, repeat: enabled });
  const retry = enabled ? createVisibilityAwareInterval(async (signal) => {
    if (state.isBackendConnected && state.warmupStatus !== 'WARMING_UP' &&
        state.overview !== null && state.macro !== null && state.feedStatus !== 'NO_DATA') return;
    if (await refreshBackendHealth(signal)) {
      await Promise.all([refreshOverview(false, signal), retryMissingSlices(signal)]);
    }
  }, 3_000, { reconcileAfterMs: Infinity }) : undefined;

  return () => {
    retry?.();
    cycle();
  };
}

const EMPTY_EXPIRIES: readonly OptionExpiryGroup[] = Object.freeze([]);
const EMPTY_LOADING: Readonly<Record<string, boolean>> = Object.freeze({});

function keyed(
  domain: 'options' | 'optionLoading' | 'usSnapshot' | 'stockDetail' | 'volSurface' | 'catalysts',
  key: string,
): BridgeKeyedChannel {
  return `${domain}:${key}`;
}

export function useLiveBridgeSelector<T>(
  channels: readonly BridgeChannelKey[],
  selector: (snapshot: LiveMarketState) => T,
  isEqual: (previous: T, next: T) => boolean = Object.is,
): T {
  const signature = channels.join('|');
  const subscribe = useCallback(
    (listener: StoreListener) => subscribeBridgeChannels(signature ? signature.split('|') as BridgeChannelKey[] : [], listener),
    [signature],
  );
  const committed = useRef<{ value: T } | null>(null);
  const getSnapshot = useMemo(() => {
    let previous: LiveMarketState | undefined;
    let selected: T;
    return () => {
      if (previous === state) return selected;
      const candidate = selector(state);
      const comparable = previous === undefined ? committed.current : { value: selected };
      selected = comparable !== null && isEqual(comparable.value, candidate) ? comparable.value : candidate;
      previous = state;
      return selected;
    };
  }, [selector, isEqual]);
  const selected = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => { committed.current = { value: selected }; }, [selected]);
  return selected;
}

export function useLiveMarketState(): LiveMarketState {
  return useLiveBridgeSelector(['__legacy_all__'], (snapshot) => snapshot);
}

const subscribeStatus = (listener: StoreListener) => subscribeBridgeChannel('status', listener);
const getStatus = () => statusSnapshot;

export function useLiveMarketStatus(): LiveMarketStatus {
  return useSyncExternalStore(subscribeStatus, getStatus, getStatus);
}

export function useLiveOverview(): ArOverviewResponse | null {
  return useLiveBridgeSelector(['overview'], (snapshot) => snapshot.overview);
}

export function useLiveMacro(): ArMacroResponse | null {
  return useLiveBridgeSelector(['macro'], (snapshot) => snapshot.macro);
}

export function useLiveMonitoring(): ArMonitoringResponse | null {
  return useLiveBridgeSelector(['monitoring'], (snapshot) => snapshot.monitoring);
}

export function useLiveRelations(): ArRelationsResponse | null {
  return useLiveBridgeSelector(['relations'], (snapshot) => snapshot.relations);
}

export function useLiveUsSnapshot(symbol: string | null | undefined): UsSnapshotResponseDto | undefined {
  const clean = symbol?.trim().toUpperCase();
  return useLiveBridgeSelector(clean ? [keyed('usSnapshot', clean)] : [], (snapshot) =>
    clean ? snapshot.usSnapshotsBySymbol[clean] : undefined,
  );
}

export function useLiveStockDetail(symbol: string | null | undefined): ArStockDetailResponse | undefined {
  const clean = symbol?.trim().toUpperCase();
  return useLiveBridgeSelector(clean ? [keyed('stockDetail', clean)] : [], (snapshot) =>
    clean ? snapshot.stockDetailsBySymbol[clean] : undefined,
  );
}

export interface LiveOptionsSlice {
  readonly options: ArOptionsResponse | undefined;
  readonly expiries: readonly OptionExpiryGroup[];
  readonly loading: Readonly<Record<string, boolean>>;
}

const EMPTY_OPTIONS: LiveOptionsSlice = Object.freeze({ options: undefined, expiries: EMPTY_EXPIRIES, loading: EMPTY_LOADING });
const optionsSliceCache = new Map<string, { source: LiveMarketState['loadingOptionExpiries']; slice: LiveOptionsSlice }>();
const MAX_SLICE_CACHE_ENTRIES = 64;

export function getLiveOptionsSlice(rawKey: string | null | undefined): LiveOptionsSlice {
  if (!rawKey) return EMPTY_OPTIONS;
  const { canonicalKey, key, market } = parseOptionsUnderlyingKey(rawKey);
  const previous = optionsSliceCache.get(canonicalKey);
  const options = state.optionsByUnderlying[canonicalKey];
  const expiries = state.optionExpiriesByUnderlyingKey[canonicalKey] ?? EMPTY_EXPIRIES;
  let loading = previous?.slice.loading ?? EMPTY_LOADING;
  if (market === 'US' && previous?.source !== state.loadingOptionExpiries) {
    const prefix = `${key}:`;
    const entries = Object.entries(state.loadingOptionExpiries).filter(([loadKey, active]) => active && loadKey.startsWith(prefix));
    if (entries.length !== Object.keys(loading).length || entries.some(([loadKey]) => loading[loadKey] !== true)) {
      loading = entries.length === 0 ? EMPTY_LOADING : Object.fromEntries(entries);
    }
  }
  const slice = previous?.slice.options === options && previous?.slice.expiries === expiries && previous.slice.loading === loading
    ? previous.slice
    : options === undefined && expiries === EMPTY_EXPIRIES && loading === EMPTY_LOADING
      ? EMPTY_OPTIONS
      : { options, expiries, loading };
  optionsSliceCache.delete(canonicalKey);
  optionsSliceCache.set(canonicalKey, { source: state.loadingOptionExpiries, slice });
  if (optionsSliceCache.size > MAX_SLICE_CACHE_ENTRIES) {
    const oldest = optionsSliceCache.keys().next().value;
    if (oldest !== undefined) optionsSliceCache.delete(oldest);
  }
  return slice;
}

export function useLiveOptionsSlice(rawKey: string | null | undefined): LiveOptionsSlice {
  const canonicalKey = rawKey ? parseOptionsUnderlyingKey(rawKey).canonicalKey : null;
  return useLiveBridgeSelector(
    canonicalKey ? [keyed('options', canonicalKey), keyed('optionLoading', canonicalKey)] : [],
    () => getLiveOptionsSlice(canonicalKey),
    (a, b) => a.options === b.options && a.expiries === b.expiries &&
      Object.keys(a.loading).length === Object.keys(b.loading).length &&
      Object.keys(a.loading).every((key) => a.loading[key] === b.loading[key]),
  );
}

export interface LiveOptionsUniverseSlice {
  readonly underlyings: readonly OptionsUnderlyingMetaDto[];
  readonly status: LiveMarketState['optionsUnderlyingsStatus'];
}

export function useLiveOptionsUniverse(): LiveOptionsUniverseSlice {
  return useLiveBridgeSelector(
    ['optionsUnderlyings'],
    (snapshot) => ({ underlyings: snapshot.optionsUnderlyings, status: snapshot.optionsUnderlyingsStatus }),
    (a, b) => a.underlyings === b.underlyings && a.status === b.status,
  );
}

export interface LiveUsVolSurfaceSlice {
  readonly surface: UsVolSurfaceResponseDto | null;
  readonly status: LiveMarketState['usVolSurfaceStatusBySymbol'][string];
}

export function useLiveUsVolSurface(rawKey: string | null | undefined): LiveUsVolSurfaceSlice {
  const selection = rawKey ? parseOptionsUnderlyingKey(rawKey) : null;
  const key = selection?.market === 'US' ? selection.key : null;
  return useLiveBridgeSelector(
    selection?.market === 'US' ? [keyed('volSurface', selection.canonicalKey)] : [],
    (snapshot) => ({
      surface: key ? snapshot.usVolSurfaceBySymbol[key] ?? null : null,
      status: key ? snapshot.usVolSurfaceStatusBySymbol[key] ?? 'IDLE' : 'IDLE',
    }),
    (a, b) => a.surface === b.surface && a.status === b.status,
  );
}

export interface LiveOptionsCatalystsSlice {
  readonly catalysts: SymbolCatalystsResponseDto | null;
  readonly status: LiveMarketState['optionsCatalystsStatusBySymbol'][string];
}

export function useLiveOptionsCatalysts(symbol: string | null | undefined): LiveOptionsCatalystsSlice {
  const clean = symbol?.trim().toUpperCase();
  return useLiveBridgeSelector(
    clean ? [keyed('catalysts', clean)] : [],
    (snapshot) => ({
      catalysts: clean ? snapshot.optionsCatalystsBySymbol[clean] ?? null : null,
      status: clean ? snapshot.optionsCatalystsStatusBySymbol[clean] ?? 'IDLE' : 'IDLE',
    }),
    (a, b) => a.catalysts === b.catalysts && a.status === b.status,
  );
}

const US_PROVIDERS_TTL_MS = 30_000;
let providerSubscribers = 0;
let stopProviders: (() => void) | undefined;
let providersLoadedAtMs = -Infinity;

export function subscribeUsProvidersStatus(listener: StoreListener): () => void {
  const unsubscribe = subscribeBridgeChannel('usProvidersStatus', listener);
  providerSubscribers += 1;
  if (providerSubscribers === 1) {
    stopProviders = createVisibilityAwareInterval(async (signal, reason) => {
      if (reason === 'reconcile' && Date.now() - providersLoadedAtMs < US_PROVIDERS_TTL_MS) return;
      const next = await fetchJsonGuarded<UsProvidersStatusDto>(
        'us:providers', '/api/us/providers-status', { signal, timeoutMs: 5_000 },
      );
      if (signal.aborted) return;
      providersLoadedAtMs = Date.now();
      if (state.usProvidersStatus !== next) {
        commitBridgeState({ ...state, usProvidersStatus: next }, ['usProvidersStatus']);
      }
    }, US_PROVIDERS_TTL_MS, { runImmediately: true, reconcileAfterMs: 0 });
  }
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    unsubscribe();
    providerSubscribers -= 1;
    if (providerSubscribers === 0) {
      stopProviders?.();
      stopProviders = undefined;
    }
  };
}

const getProvidersStatus = () => state.usProvidersStatus;
const getDisabledProvidersStatus = () => null;
const subscribeDisabled = () => () => undefined;

export function useLiveUsProvidersStatus(enabled = true): UsProvidersStatusDto | null {
  const read = enabled ? getProvidersStatus : getDisabledProvidersStatus;
  return useSyncExternalStore(enabled ? subscribeUsProvidersStatus : subscribeDisabled, read, read);
}
export interface LiveStockDetailRuntimeSlice {
  readonly feedStatus: FeedStatus;
  readonly optionsUnderlyingsStatus: LiveMarketState['optionsUnderlyingsStatus'];
  readonly hasOverview: boolean;
  readonly overviewCclMedian: number | null;
  readonly overviewArStock: ArOverviewResponse['mervalStocks'][number] | null;
  readonly overviewCedear: ArOverviewResponse['cedears'][number] | null;
  readonly stockDetail: ArStockDetailResponse | undefined;
  readonly arOptions: ArOptionsResponse | undefined;
  readonly usSnap: UsSnapshotResponseDto | undefined;
  readonly overview: ArOverviewResponse | null;
  readonly optionsUnderlyings: readonly OptionsUnderlyingMetaDto[];
}

export function useLiveStockDetailRuntimeSlice(
  cleanTicker: string,
  isArMarket: boolean,
  selectorOpen: boolean,
): LiveStockDetailRuntimeSlice {
  const clean = cleanTicker.trim().toUpperCase();
  const cachedRef = useRef<LiveStockDetailRuntimeSlice | null>(null);

  const subscribe = useCallback((listener: StoreListener) => subscribeBridgeChannels([
    'overview',
    'status',
    'optionsUnderlyings',
    ...(isArMarket ? [keyed('stockDetail', clean), keyed('options', 'AR:' + clean)] : [keyed('usSnapshot', clean)]),
  ], listener), [clean, isArMarket]);

  const getSnapshot = useCallback((): LiveStockDetailRuntimeSlice => {
    const ov = state.overview;
    const overviewCclMedian =
      ov?.cclMedian !== undefined && Number.isFinite(ov.cclMedian) ? ov.cclMedian : null;
    const overviewArStock = isArMarket
      ? (ov?.mervalStocks.find((s) => s.ticker === clean) ??
        ov?.generalPanelStocks.find((s) => s.ticker === clean) ??
        null)
      : null;
    const overviewCedear = isArMarket
      ? (ov?.cedears.find((s) => s.ticker === clean) ?? null)
      : (ov?.cedears.find((s) => {
          const targetUs = s.adrTicker?.replace(/ US$/i, '').trim().toUpperCase();
          return targetUs === clean || s.ticker === clean;
        }) ?? null);
    const stockDetail = isArMarket ? state.stockDetailsBySymbol[clean] : undefined;
    const arOptions = isArMarket ? getLiveOptionsForUnderlying(state, `AR:${clean}`) : undefined;
    const usSnap = !isArMarket ? state.usSnapshotsBySymbol[clean] : undefined;
    const hasOverview = ov !== null;
    const prev = cachedRef.current;
    const effectiveOverview =
      selectorOpen || prev === null || prev.overview === null ? ov : prev.overview;

    if (
      prev !== null &&
      prev.feedStatus === state.feedStatus &&
      prev.optionsUnderlyingsStatus === state.optionsUnderlyingsStatus &&
      prev.hasOverview === hasOverview &&
      prev.overviewCclMedian === overviewCclMedian &&
      prev.overviewArStock === overviewArStock &&
      prev.overviewCedear === overviewCedear &&
      prev.stockDetail === stockDetail &&
      prev.arOptions === arOptions &&
      prev.usSnap === usSnap &&
      prev.overview === effectiveOverview &&
      prev.optionsUnderlyings === state.optionsUnderlyings
    ) {
      return prev;
    }

    const next: LiveStockDetailRuntimeSlice = {
      feedStatus: state.feedStatus,
      optionsUnderlyingsStatus: state.optionsUnderlyingsStatus,
      hasOverview,
      overviewCclMedian,
      overviewArStock,
      overviewCedear,
      stockDetail,
      arOptions,
      usSnap,
      overview: effectiveOverview,
      optionsUnderlyings: state.optionsUnderlyings,
    };
    cachedRef.current = next;
    return next;
  }, [clean, isArMarket, selectorOpen]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function subscribeLiveTickerUpdates(fn: TickerListener): () => void {
  tickerListeners.add(fn);
  return () => {
    tickerListeners.delete(fn);
  };
}
