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
  UsSnapshotResponseDto,
  UsTerminalBarsResponseDto,
  UsVolSurfaceResponseDto,
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
import { parseOptionsUnderlyingKey } from './optionsUnderlying';
import { calendarDteEt, formatDteLabel } from '../../../src/core/options/zeroDteFixes';

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
  readonly optionsByUnderlying: Readonly<Record<string, ArOptionsResponse>>;
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
  optionsUnderlyings: [],
  optionsUnderlyingsStatus: 'IDLE',
  usVolSurfaceBySymbol: {},
  usVolSurfaceStatusBySymbol: {},
  optionsCatalystsBySymbol: {},
  optionsCatalystsStatusBySymbol: {},
  tickFlashes: {},
  isBackendConnected: false,
  warmupStatus: 'IDLE',
};

const listeners = new Set<StoreListener>();
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
      // Pieza 46.1: DTE calendario real en America/New_York (expiry == hoy ET -> 0, etiqueta 0DTE).
      const dteEt = calendarDteEt(expDate, snap.asOfUtcSec * 1000);
      const days = Number.isFinite(dteEt)
        ? dteEt
        : (slice?.timeToExpiryDays ?? Math.max(1, Math.round((expSec - snap.asOfUtcSec) / 86_400)));
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
          daysToExpiry: Number.isFinite(dteEt) ? dteEt : Math.max(1, Math.round(days)),
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

      let resolvedIvAtmDec =
        slice?.ivAtm !== null && slice?.ivAtm !== undefined && Number.isFinite(slice.ivAtm) && slice.ivAtm > 0
          ? slice.ivAtm
          : null;
      if (resolvedIvAtmDec === null && spot !== null && Number.isFinite(spot) && spot > 0) {
        const nearOtmIvs = [...calls, ...puts]
          .filter(
            (c) =>
              c.iv !== null &&
              Number.isFinite(c.iv) &&
              c.iv > 0 &&
              c.iv < 9.99 &&
              (c.contractType === 'call' ? c.strike >= spot - 1e-6 : c.strike <= spot + 1e-6),
          )
          .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
          .slice(0, 2)
          .map((c) => c.iv as number);
        if (nearOtmIvs.length > 0) {
          resolvedIvAtmDec = nearOtmIvs.reduce((acc, v) => acc + v, 0) / nearOtmIvs.length;
        }
      }

      const resolvedDays = Number.isFinite(dteEt) ? dteEt : Math.max(0, Math.round(days));
      return {
        expiryCode: expDate,
        expiryLabel: `${expDate} (${formatDteLabel(resolvedDays)})`,
        expirationDate: expDate,
        expiryUtcSec: expSec,
        days: resolvedDays,
        ivAtm: resolvedIvAtmDec,
        riskReversal25: slice?.riskReversal25 ?? null,
        butterfly25: slice?.butterfly25 ?? null,
        butterflyArbitrageFree: slice?.isButterflyArbitrageFree ?? true,
        strikes,
        calls,
        puts,
      };
    })
    .sort((a, b) => a.days - b.days);

  const termStructure = (
    (snap.volSurfaceSummary?.slices ?? []).some((s) => s.ivAtm !== null && s.ivAtm > 0)
      ? (snap.volSurfaceSummary?.slices ?? [])
          .filter((s) => s.ivAtm !== null && s.ivAtm > 0)
          .map((s) => {
            const sDteEt = calendarDteEt(s.expirationDate, snap.asOfUtcSec * 1_000);
            return {
              days: Number.isFinite(sDteEt) ? sDteEt : Math.max(0, Math.round(s.timeToExpiryDays)),
              label: s.expirationDate,
              expiryCode: s.expirationDate,
              atm: s.ivAtm as number,
            };
          })
      : expiries
          .filter((e) => e.ivAtm !== null && Number.isFinite(e.ivAtm) && e.ivAtm > 0)
          .map((e) => ({
            days: e.days,
            label: e.expirationDate,
            expiryCode: e.expiryCode,
            atm: e.ivAtm as number,
          }))
  );

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
    market: 'US',
    spot,
    rateTna,
    continuousRate: rateDec,
    dividendYield:
      frontSlice !== null &&
      frontSlice.timeToExpiryDays >= 3 &&
      frontSlice.dividendYield !== null &&
      Number.isFinite(frontSlice.dividendYield) &&
      frontSlice.dividendYield >= 0 &&
      frontSlice.dividendYield <= 0.25
        ? frontSlice.dividendYield
        : snap.marketContext?.treasury?.dividendYieldFront !== null &&
            snap.marketContext?.treasury?.dividendYieldFront !== undefined &&
            Number.isFinite(snap.marketContext.treasury.dividendYieldFront) &&
            snap.marketContext.treasury.dividendYieldFront >= 0 &&
            snap.marketContext.treasury.dividendYieldFront <= 0.25
          ? snap.marketContext.treasury.dividendYieldFront
          : 0,
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
          ...(snap.exposureSummary.quality
            ? {
                quality: {
                  usableContracts: snap.exposureSummary.quality.usableContracts,
                  usableOpenInterest: snap.exposureSummary.quality.usableOpenInterest,
                },
              }
            : {}),
          ...(snap.exposureSummary.byStrike
            ? {
                byStrike: snap.exposureSummary.byStrike.map((s) => ({
                  strike: s.strike,
                  callOi: s.callOi,
                  putOi: s.putOi,
                  callVolume: s.callVolume ?? null,
                  putVolume: s.putVolume ?? null,
                  callGex: s.callGex,
                  putGex: s.putGex,
                  netGex: s.netGex,
                })),
              }
            : {}),
        }
      : null,
    costSchedule: {
      rvMarketFeeRate: 0.002,
      optionsFeeRate: 0.002,
      shortLoanFeeRate: 0,
      vatRate: 0,
      bondsVatExempt: true,
    },
    primaryLiquidExpiryCode: snap.optionsChain?.selectedExpirationDate ?? null,
    ...(snap.volSurfaceSummary?.forwardIvSegments
      ? { forwardIvSegments: snap.volSurfaceSummary.forwardIvSegments }
      : {}),
    quantEngines,
    providerErrors: [],
  };
}

export async function requestOptionsChain(
  underlying: string,
  force = false,
  expiration?: string,
): Promise<void> {
  const selection = parseOptionsUnderlyingKey(underlying);
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
    hydrateFromArOptions(mapped);
    syncOptionEngineMarket(mapped);
    state = {
      ...state,
      isBackendConnected: true,
      usSnapshotsBySymbol: { ...state.usSnapshotsBySymbol, [clean]: snap },
      optionsByUnderlying: { ...state.optionsByUnderlying, [selection.key]: mapped },
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
  hydrateFromArOptions(res);
  syncOptionEngineMarket(res);
  state = {
    ...state,
    isBackendConnected: true,
    optionsByUnderlying: { ...state.optionsByUnderlying, [selection.key]: res },
    feedStatus: combineFeedStatus(state.feedStatus, res.feedStatus),
    lastSyncUtcSec: res.asOfUtcSec,
  };
  notify();
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
      requestOptionsChain('GGAL'),
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
    if (state.optionsByUnderlying['GGAL'] === undefined) tasks.push(requestOptionsChain('GGAL'));
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

export function subscribeLiveTickerUpdates(fn: TickerListener): () => void {
  tickerListeners.add(fn);
  return () => {
    tickerListeners.delete(fn);
  };
}
