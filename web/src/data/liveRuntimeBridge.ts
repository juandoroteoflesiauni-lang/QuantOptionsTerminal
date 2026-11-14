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
  usSnapshotsBySymbol: {},
  tickFlashes: {},
  isBackendConnected: false,
  warmupStatus: 'IDLE',
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
  if (a === 'EOD_CIERRE' || b === 'EOD_CIERRE') return 'EOD_CIERRE';
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

const US_OPTION_UNDERLYINGS = new Set(['SPY', 'QQQ', 'I:SPX', 'NVDA', 'AAPL', 'MSFT']);

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

function mapUsSnapshotToArOptions(clean: string, snap: UsSnapshotResponseDto): ArOptionsResponse {
  const quote = snap.marketContext?.unifiedQuotes?.find((q) => q.ticker.toUpperCase() === clean);
  const snapMetrics = snap.envelope?.snapshot?.metrics;
  const spot = snapMetrics?.spot ?? snap.envelope?.metrics?.spot?.value ?? quote?.price ?? null;
  const frontSlice = snap.volSurfaceSummary?.frontSlice ?? snap.volSurfaceSummary?.slices?.[0] ?? null;
  const rateDec = frontSlice?.rate ?? snap.marketContext?.treasury?.rate30d ?? null;
  const rateTna = rateDec !== null && Number.isFinite(rateDec) ? (Math.exp(rateDec) - 1) * 100 : null;
  const rv20 = snapMetrics?.realizedVolAnnualized ?? snap.envelope?.metrics?.realizedVol20d?.value ?? null;
  const rv60 = snapMetrics?.rvCenteredAnnualized ?? snap.envelope?.metrics?.realizedVol60d?.value ?? null;
  const iv30 = snap.volSurfaceSummary?.iv30d ?? snapMetrics?.iv30d ?? frontSlice?.ivAtm ?? null;

  type UsContractList = NonNullable<NonNullable<UsSnapshotResponseDto['volSurfaceSummary']>['contracts']>[number];
  const contractsByExp = new Map<string, UsContractList[]>();
  const sliceMap = new Map((snap.volSurfaceSummary?.slices ?? []).map((s) => [s.expirationDate, s]));
  for (const row of snap.volSurfaceSummary?.contracts ?? []) {
    const arr = contractsByExp.get(row.expirationDate) ?? [];
    arr.push(row);
    contractsByExp.set(row.expirationDate, arr);
  }

  const expiries = Array.from(contractsByExp.entries())
    .map(([expDate, rows]) => {
      const slice = sliceMap.get(expDate);
      const firstRow = rows[0];
      const expSec = slice?.expirySec ?? firstRow?.expiryUtcSec ?? snap.asOfUtcSec;
      const days = slice?.timeToExpiryDays ?? Math.max(1, Math.round((expSec - snap.asOfUtcSec) / 86_400));
      const strikeSet = new Set<number>();
      const calls: ArOptionsResponse['expiries'][number]['calls'][number][] = [];
      const puts: ArOptionsResponse['expiries'][number]['puts'][number][] = [];
      for (const r of rows) {
        strikeSet.add(r.strike);
        const iv = r.ownIv ?? r.providerIv ?? null;
        const intrinsic =
          spot !== null && spot > 0
            ? r.contractType === 'call'
              ? Math.max(0, spot - r.strike)
              : Math.max(0, r.strike - spot)
            : 0;
        const mark = r.mid ?? r.lastPrice ?? null;
        const mapped = {
          symbol: r.ticker,
          underlying: clean,
          contractType: r.contractType,
          strike: r.strike,
          expiryCode: expDate,
          expirationDate: expDate,
          expiryUtcSec: r.expiryUtcSec,
          daysToExpiry: Math.max(1, Math.round(days)),
          bid: r.bid,
          ask: r.ask,
          last: r.lastPrice,
          mark,
          volume: r.volume,
          openInterest: r.openInterest,
          iv,
          delta: r.delta,
          gamma: r.gamma,
          thetaDaily: r.thetaDaily,
          vegaPer1Pct: r.vegaPer1Pct,
          rho: null,
          vanna: r.vanna,
          charm: r.charm,
          intrinsic,
          extrinsic: mark !== null ? Math.max(0, mark - intrinsic) : null,
          source: 'DATA912' as const,
        };
        if (r.contractType === 'call') calls.push(mapped);
        else puts.push(mapped);
      }
      calls.sort((a, b) => a.strike - b.strike);
      puts.sort((a, b) => a.strike - b.strike);
      const strikes = Array.from(strikeSet).sort((a, b) => a - b);
      return {
        expiryCode: expDate,
        expiryLabel: `${expDate} (${Math.max(1, Math.round(days))}d)`,
        expirationDate: expDate,
        expiryUtcSec: expSec,
        days: Math.max(1, Math.round(days)),
        ivAtm: slice?.ivAtm ?? null,
        riskReversal25: slice?.riskReversal25 ?? null,
        butterfly25: slice?.butterfly25 ?? null,
        butterflyArbitrageFree: slice?.isButterflyArbitrageFree ?? true,
        strikes,
        calls,
        puts,
      };
    })
    .sort((a, b) => a.days - b.days);

  const termStructure = (snap.volSurfaceSummary?.slices ?? [])
    .filter((s) => s.ivAtm !== null && s.ivAtm > 0)
    .map((s) => ({
      days: Math.max(1, Math.round(s.timeToExpiryDays)),
      label: s.expirationDate,
      expiryCode: s.expirationDate,
      atm: s.ivAtm as number,
    }));

  const te = snap.terminalEngines ?? null;
  const quantEngines: ArOptionsResponse['quantEngines'] = te
    ? {
        orderFlowArs: te.orderFlow,
        netDirectionalPremiumUsdCcl: te.orderFlow?.netDirectionalPremiumUsd ?? null,
        callNetPremiumCvdUsdCcl: te.orderFlow?.callNetPremiumCvdUsd ?? null,
        putNetPremiumCvdUsdCcl: te.orderFlow?.putNetPremiumCvdUsd ?? null,
        volOiAnomalies: te.volOiAnomalies,
        flowAdjustedGex: te.flowAdjustedGex,
        gexCharmPin: te.gexCharmPin,
        qDistribution: te.qDistribution,
        pDistribution: te.pDistribution,
        pqDivergence: te.pqDivergence,
        volCone: te.volCone,
        syntheticRates: te.syntheticRates,
        conversionReversal: te.conversionReversal,
        buyWrite: te.buyWrite,
        calendarRoll: te.calendarRoll,
        structureOptimizerBullish: te.structureOptimizerBullish,
        structureOptimizerBearish: te.structureOptimizerBearish,
        structureCostPercentile: te.structureCostPercentile,
        confluenceClusters: te.confluenceClusters,
      }
    : null;

  const feedStatus: FeedStatus =
    snap.feedMode ?? (snap.status === 'OK' ? 'LIVE' : 'PARTIAL');

  return {
    asOfUtcSec: snap.asOfUtcSec,
    feedStatus,
    underlying: clean,
    spot,
    rateTna,
    continuousRate: rateDec,
    dividendYield: frontSlice?.dividendYield ?? snap.marketContext?.treasury?.dividendYieldFront ?? 0,
    lotSize: 100,
    settlement: 'T+0',
    exerciseCutoffArt: '15:30 ART',
    realizedVol20d: rv20,
    realizedVol60d: rv60,
    histMedianIv: iv30,
    vrpSpread: iv30 !== null && rv20 !== null ? iv30 - rv20 : null,
    historicalCloses: [],
    termStructure,
    expiries,
    exposureSummary: snap.exposureSummary
      ? {
          netGex: snap.exposureSummary.netGex,
          netDex: snap.exposureSummary.netDex,
          callWallStrike: snap.exposureSummary.callWallStrike,
          putWallStrike: snap.exposureSummary.putWallStrike,
          gammaFlipSpot: snap.exposureSummary.gammaFlipSpot,
          gammaFlipStatus: snap.exposureSummary.gammaFlipStatus,
          expectedMoveAbs:
            snap.exposureSummary.expectedMove?.straddleMove ??
            snap.exposureSummary.expectedMove?.formulaMove ??
            null,
          expectedMovePct:
            snap.exposureSummary.expectedMove?.straddleMovePct ??
            snap.exposureSummary.expectedMove?.formulaMovePct ??
            null,
        }
      : null,
    costSchedule: {
      rvMarketFeeRate: 0.002,
      optionsFeeRate: 0.002,
      shortLoanFeeRate: 0,
      vatRate: 0,
      bondsVatExempt: true,
    },
    quantEngines,
    providerErrors: [],
  };
}

export async function requestOptionsChain(underlying: string, force = false): Promise<void> {
  const clean = underlying.trim().toUpperCase();
  if (!clean) return;
  if (US_OPTION_UNDERLYINGS.has(clean)) {
    const snap = await fetchJsonGuarded<UsSnapshotResponseDto>(
      `us:opt:${clean}`,
      `/api/snapshot?symbol=${encodeURIComponent(clean)}`
    );
    if (!snap) return;
    hydrateFromUsSnapshot(snap);
    const mapped = mapUsSnapshotToArOptions(clean, snap);
    hydrateFromArOptions(mapped);
    syncOptionEngineMarket(mapped);
    state = {
      ...state,
      isBackendConnected: true,
      usSnapshotsBySymbol: { ...state.usSnapshotsBySymbol, [clean]: snap },
      optionsByUnderlying: { ...state.optionsByUnderlying, [clean]: mapped },
      feedStatus: combineFeedStatus(state.feedStatus, mapped.feedStatus),
      lastSyncUtcSec: snap.asOfUtcSec,
    };
    notify();
    return;
  }
  const res = await fetchJsonGuarded<ArOptionsResponse>(
    `options:${clean}`,
    `/api/ar/options?underlying=${encodeURIComponent(clean)}${force ? '&force=1' : ''}`
  );
  if (!res) return;
  hydrateFromArOptions(res);
  syncOptionEngineMarket(res);
  state = {
    ...state,
    isBackendConnected: true,
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
    isBackendConnected: true,
    usSnapshotsBySymbol: { ...state.usSnapshotsBySymbol, [clean]: res },
    ...(res.feedMode ? { feedStatus: combineFeedStatus(state.feedStatus, res.feedMode) } : {}),
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
    await refreshBackendHealth();
    await Promise.all([
      refreshOverview(),
      refreshMacro(),
      requestMonitoringPanel('bonos'),
      requestOptionsChain('GGAL'),
      requestRelations(),
      requestUsSnapshot('SPY'),
      requestUsSnapshot('QQQ'),
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
        if (
          ok &&
          (!prevConnected ||
            (prevWarmupStatus === 'WARMING_UP' && state.warmupStatus === 'READY') ||
            state.overview === null ||
            state.macro === null ||
            state.feedStatus === 'NO_DATA')
        ) {
          await runInitialAndCycle();
        }
        prevConnected = state.isBackendConnected;
        prevWarmupStatus = state.warmupStatus;
      })();
    }
  }, 5_000);

  const intervalId = setInterval(() => {
    if (disposed) return;
    if (state.overview === null || state.macro === null || state.feedStatus === 'NO_DATA') {
      void runInitialAndCycle();
      return;
    }
    void refreshBackendHealth();
    void refreshOverview();
  }, 20_000);

  if (typeof window !== 'undefined' && typeof WebSocket !== 'undefined') {
    try {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${window.location.host}/ws`);
      ws.addEventListener('open', () => {
        ws?.send(
          JSON.stringify({
            action: 'subscribe',
            symbols: ['SPY', 'QQQ', 'NVDA', 'AAPL', 'MSFT'],
          })
        );
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
    clearInterval(fastRetryId);
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
