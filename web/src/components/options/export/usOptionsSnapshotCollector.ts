/**
 * Pieza EXPORT-1: colector híbrido, congelación atómica y orquestador de exportación US.
 *
 * Reglas de rendimiento e integridad:
 * - Cero requests adicionales cuando snapshot, vencimientos y barras están en memoria.
 * - Recuperación puntual single-flight + AbortSignal solo para faltantes.
 * - Deduplicación concurrente de solicitudes idénticas y cancelación limpia.
 * - Cero conexiones WS nuevas, cero polling, cero notificaciones cross-slice Perf-2.
 * - Cero lectura de `.env`, tokens, cuentas o `localStorage` (`quant_core_positions_v1`).
 */

import {
  buildUsOptionsIntelligenceSnapshot,
  filterSnapshotByMode,
  validateSnapshotIntegrity,
} from '../../../../../src/core/options/usOptionsIntelligenceExport.js';
import { renderUsOptionsSnapshotMarkdown } from '../../../../../src/core/options/usOptionsSnapshotMarkdown.js';
import type {
  ExportUsOptionContractRowDto,
  ExportUsOptionsSnapshotRequest,
  RawExpiryInputBundle,
  RawUsOptionsSnapshotInput,
  SnapshotExportResult,
  UsVolAnalyticsExpiryRef,
} from '../../../../../src/core/options/usOptionsIntelligenceExportTypes.js';
import { toInstitutionalAvwapMarkdownInput } from '../../../../../src/core/avwap/index.js';
import { calendarDteEt, etExpiryUtcSecFromDate } from '../../../../../src/core/options/zeroDteFixes.js';
import { getAtomicMarketQuote } from '../../../api/useMarketLiveStream.js';
import {
  getLiveMarketStateSnapshot,
  getLiveOptionsSlice,
  requestOptionsCatalysts,
  requestTerminalBars,
  requestUsOptionExpiry,
  requestUsSnapshot,
} from '../../../data/liveRuntimeBridge.js';
import type {
  ArOptionContractDto,
  ArOptionExpiryDto,
  TerminalTimeframe,
  UsOptionContractRowDto,
  UsSnapshotResponseDto,
  UsTerminalBarsResponseDto,
} from '../../../data/liveTypes.js';
import {
  getUsBarsMemoryEntry,
  setUsBarsMemoryEntry,
} from '../../../data/usBarsMemoryCache.js';

export interface SnapshotCollectorDependencies {
  readonly getMarketSnapshot: typeof getLiveMarketStateSnapshot;
  readonly getOptionsSlice: typeof getLiveOptionsSlice;
  readonly getAtomicQuote: typeof getAtomicMarketQuote;
  readonly getBarsEntry: typeof getUsBarsMemoryEntry;
  readonly setBarsEntry: typeof setUsBarsMemoryEntry;
  readonly fetchUsSnapshot: typeof requestUsSnapshot;
  readonly fetchUsOptionExpiry: typeof requestUsOptionExpiry;
  readonly fetchTerminalBars: typeof requestTerminalBars;
  readonly fetchOptionsCatalysts: typeof requestOptionsCatalysts;
  readonly nowMs: () => number;
}

const DEFAULT_COLLECTOR_DEPS: SnapshotCollectorDependencies = {
  getMarketSnapshot: getLiveMarketStateSnapshot,
  getOptionsSlice: getLiveOptionsSlice,
  getAtomicQuote: getAtomicMarketQuote,
  getBarsEntry: getUsBarsMemoryEntry,
  setBarsEntry: setUsBarsMemoryEntry,
  fetchUsSnapshot: requestUsSnapshot,
  fetchUsOptionExpiry: requestUsOptionExpiry,
  fetchTerminalBars: requestTerminalBars,
  fetchOptionsCatalysts: requestOptionsCatalysts,
  nowMs: () => Date.now(),
};

interface ActiveExportJob {
  readonly controller: AbortController;
  readonly promise: Promise<SnapshotExportResult>;
}

const inFlightExports = new Map<string, ActiveExportJob>();

function buildCanonicalExportKey(request: ExportUsOptionsSnapshotRequest): string {
  const ticker = request.ticker.trim().toUpperCase();
  const exps = request.expirations.map((e) => e.trim()).join(',');
  const tfs = (request.chartTimeframes ?? []).join(',');
  return `${ticker}|${request.mode}|${exps}|${request.format}|${String(request.includeCharts)}|${request.swingChainFilter ?? 'DELTA_005_055'}|${tfs}`;
}

export function getActiveExportJobsCount(): number {
  return inFlightExports.size;
}

export function cancelActiveSnapshotExport(request?: ExportUsOptionsSnapshotRequest): void {
  if (request === undefined) {
    for (const job of inFlightExports.values()) {
      job.controller.abort();
    }
    inFlightExports.clear();
    return;
  }
  const key = buildCanonicalExportKey(request);
  const job = inFlightExports.get(key);
  if (job !== undefined) {
    job.controller.abort();
    inFlightExports.delete(key);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Snapshot export aborted', 'AbortError');
  }
}

type ArOptionContractWithMeta = ArOptionContractDto & {
  readonly ivSource?: UsOptionContractRowDto['ivSource'];
  readonly contractRoot?: string;
  readonly exerciseStyle?: UsOptionContractRowDto['exerciseStyle'];
  readonly settlementType?: UsOptionContractRowDto['settlementType'];
  readonly valuationModel?: UsOptionContractRowDto['valuationModel'];
  readonly ivQualityStatus?: UsOptionContractRowDto['ivQualityStatus'];
  readonly quoteQuality?: UsOptionContractRowDto['quoteQuality'];
  readonly usQuoteSource?: string | null;
  readonly quoteSource?: string | null;
  readonly sharesPerContract?: number | null;
};

function arContractToUsRow(c: ArOptionContractDto): ExportUsOptionContractRowDto {
  const meta = c as ArOptionContractWithMeta;
  const bid = c.bid;
  const ask = c.ask;
  const mid =
    c.mark !== null && Number.isFinite(c.mark)
      ? c.mark
      : bid !== null && ask !== null && Number.isFinite(bid) && Number.isFinite(ask) && ask >= bid
        ? 0.5 * (bid + ask)
        : null;
  return {
    ticker: c.symbol,
    contractType: c.contractType,
    strike: c.strike,
    expirationDate: c.expirationDate,
    expiryUtcSec: c.expiryUtcSec,
    bid,
    ask,
    mid,
    lastPrice: c.last,
    openInterest: c.openInterest,
    volume: c.volume,
    previousClose: c.previousClose ?? null,
    changePct: c.changePct ?? null,
    ownIv: c.iv,
    providerIv: null,
    ivSource: meta.ivSource ?? (c.iv !== null ? 'OWN' : 'NONE'),
    delta: c.delta,
    gamma: c.gamma,
    thetaDaily: c.thetaDaily,
    vegaPer1Pct: c.vegaPer1Pct,
    vanna: c.vanna,
    charm: c.charm,
    ...(meta.contractRoot !== undefined ? { contractRoot: meta.contractRoot } : {}),
    ...(meta.exerciseStyle !== undefined ? { exerciseStyle: meta.exerciseStyle } : {}),
    ...(meta.settlementType !== undefined ? { settlementType: meta.settlementType } : {}),
    ...(meta.valuationModel !== undefined ? { valuationModel: meta.valuationModel } : {}),
    ...(meta.ivQualityStatus !== undefined ? { ivQualityStatus: meta.ivQualityStatus } : {}),
    ...(meta.quoteQuality !== undefined ? { quoteQuality: meta.quoteQuality } : {}),
    quoteSource: meta.usQuoteSource ?? meta.quoteSource ?? null,
    quoteTimestampUtcSec: c.quoteAsOfUtcSec ?? null,
    sharesPerContract: meta.sharesPerContract ?? c.contractMultiplier ?? null,
  };
}

function arExposureToUsSummary(
  exp: NonNullable<ReturnType<typeof getLiveOptionsSlice>['options']>['exposureSummary'] | null | undefined,
): UsSnapshotResponseDto['exposureSummary'] {
  if (!exp) return null;
  return {
    netGex: exp.netGex,
    netDex: exp.netDex,
    netVex: exp.netVex ?? null,
    netCex: exp.netCex ?? null,
    vannaRegime: exp.vannaRegime,
    charmPinStrike: exp.charmPinStrike ?? null,
    callWallStrike: exp.callWallStrike,
    putWallStrike: exp.putWallStrike,
    gammaFlipSpot: exp.gammaFlipSpot,
    gammaFlipStatus: exp.gammaFlipStatus,
    ...(exp.expectedMoveAbs !== undefined || exp.expectedMovePct !== undefined
      ? {
          expectedMove: {
            expiryUtcSec: null,
            formulaMove: exp.expectedMoveAbs ?? null,
            formulaMovePct: exp.expectedMovePct ?? null,
            straddleMove: exp.expectedMoveAbs ?? null,
            straddleMovePct: exp.expectedMovePct ?? null,
          },
        }
      : {}),
    ...(exp.quality
      ? {
          quality: {
            usableContracts: exp.quality.usableContracts,
            usableOpenInterest: exp.quality.usableOpenInterest,
          },
        }
      : {}),
    ...(exp.byStrike
      ? {
          byStrike: exp.byStrike.map((s) => ({
            strike: s.strike,
            callOi: s.callOi,
            putOi: s.putOi,
            callVolume: s.callVolume ?? null,
            putVolume: s.putVolume ?? null,
            callGex: s.callGex,
            putGex: s.putGex,
            netGex: s.netGex,
            vex: s.vex ?? s.netVannaExposure ?? null,
            cex: s.cex ?? s.netCharmExposure ?? null,
          })),
        }
      : {}),
  };
}

function isExpiryHydratedInMemory(
  expDate: string,
  usSnapshot: UsSnapshotResponseDto,
  arExpiry: ArOptionExpiryDto | undefined,
): boolean {
  if (arExpiry?.loaded === true) return true;
  const meta = usSnapshot.optionsChain?.availableExpirations?.find(
    (e) => e.expirationDate === expDate,
  );
  if (meta?.loaded === true) return true;
  const snapContractsCount = (usSnapshot.volSurfaceSummary?.contracts ?? []).filter(
    (c) => c.expirationDate === expDate,
  ).length;
  return snapContractsCount > 0 && meta === undefined;
}

/**
 * Recopila los datos congelados del subyacente y vencimientos solicitados.
 * Hace 0 requests si snapshot, vencimientos y barras ya existen en memoria.
 */
export async function collectSnapshotData(
  request: ExportUsOptionsSnapshotRequest,
  signal: AbortSignal,
  deps: SnapshotCollectorDependencies = DEFAULT_COLLECTOR_DEPS,
): Promise<RawUsOptionsSnapshotInput> {
  throwIfAborted(signal);
  const ticker = request.ticker.trim().toUpperCase();
  if (!ticker || ticker.startsWith('AR:')) {
    throw new Error(`Ticker US inválido para exportación: ${request.ticker}`);
  }
  const capturedAtUtcSec = Math.floor(deps.nowMs() / 1_000);
  let additionalRequestsCount = 0;

  let mktState = deps.getMarketSnapshot();
  let usSnapshot = mktState.usSnapshotsBySymbol[ticker];
  if (usSnapshot === undefined) {
    additionalRequestsCount += 1;
    const loadedSnap = await deps.fetchUsSnapshot(ticker, { prefetch: false, signal });
    throwIfAborted(signal);
    mktState = deps.getMarketSnapshot();
    usSnapshot = loadedSnap ?? mktState.usSnapshotsBySymbol[ticker];
    if (usSnapshot === undefined) {
      throw new Error(`No se pudo obtener el snapshot US de ${ticker}`);
    }
  }

  // Hydrate missing catalysts ONLY if never attempted
  const catStatus = mktState.optionsCatalystsStatusBySymbol[ticker] ?? 'IDLE';
  if (mktState.optionsCatalystsBySymbol[ticker] === undefined && catStatus === 'IDLE') {
    additionalRequestsCount += 1;
    await deps.fetchOptionsCatalysts(ticker, false, signal);
    throwIfAborted(signal);
  }

  // Hydrate missing expirations strictly on demand
  let optionsSlice = deps.getOptionsSlice(`US:${ticker}`);
  for (const expDate of request.expirations.slice(0, 2)) {
    throwIfAborted(signal);
    const arExp = optionsSlice.options?.expiries.find(
      (e) => e.expirationDate === expDate || e.expiryCode === expDate,
    );
    const hydrated = isExpiryHydratedInMemory(expDate, usSnapshot, arExp);
    if (!hydrated) {
      additionalRequestsCount += 1;
      await deps.fetchUsOptionExpiry(ticker, expDate, false, signal);
      throwIfAborted(signal);
      mktState = deps.getMarketSnapshot();
      usSnapshot = mktState.usSnapshotsBySymbol[ticker] ?? usSnapshot;
      optionsSlice = deps.getOptionsSlice(`US:${ticker}`);
    }
  }

  // Technical bars: default 15m (Intraday) or 1h (Swing) from passive cache or single fetch
  const targetTf: '15m' | '1h' =
    request.chartTimeframes?.[0] ?? (request.mode === 'intraday' ? '15m' : '1h');
  let barsEntry = deps.getBarsEntry(ticker, targetTf);
  let barsResponse: UsTerminalBarsResponseDto | null = barsEntry?.response ?? null;
  let barsTimeframe: '15m' | '1h' | null = barsResponse !== null ? targetTf : null;
  let barsAsOfUtcSec: number | null = barsEntry?.response.asOfUtcSec ?? barsEntry?.cachedAtUtcSec ?? null;

  if (barsResponse === null) {
    const apiTf: TerminalTimeframe = targetTf;
    additionalRequestsCount += 1;
    const fetchedBars = await deps.fetchTerminalBars(ticker, apiTf, {
      adaptiveWindow: true,
      includeOverlays: false,
      signal,
    });
    throwIfAborted(signal);
    if (fetchedBars !== null) {
      deps.setBarsEntry(ticker, apiTf, fetchedBars, capturedAtUtcSec);
      barsResponse = fetchedBars;
      barsTimeframe = targetTf;
      barsAsOfUtcSec = fetchedBars.asOfUtcSec;
    }
  }

  // Freeze state snapshot synchronously after targeted fetches complete
  const frozenMkt = deps.getMarketSnapshot();
  const frozenSnap = frozenMkt.usSnapshotsBySymbol[ticker] ?? usSnapshot;
  const frozenOpts = deps.getOptionsSlice(`US:${ticker}`).options;
  const frozenVolSurface = frozenMkt.usVolSurfaceBySymbol[ticker] ?? null;
  const frozenAtomicSpot = deps.getAtomicQuote('US', ticker);

  const expiries: RawExpiryInputBundle[] = [];
  for (const expDate of request.expirations.slice(0, 2)) {
    const snapRows = (frozenSnap.volSurfaceSummary?.contracts ?? []).filter(
      (c) => c.expirationDate === expDate,
    );
    const arExp = frozenOpts?.expiries.find(
      (e) => e.expirationDate === expDate || e.expiryCode === expDate,
    );
    const arRows =
      arExp !== undefined ? [...arExp.calls, ...arExp.puts].map(arContractToUsRow) : [];
    const useArRows =
      arExp?.loaded === true && (arRows.length >= snapRows.length || snapRows.length === 0);
    const contracts = useArRows ? arRows : snapRows.length > 0 ? snapRows : arRows;
    const dteEt = calendarDteEt(expDate, capturedAtUtcSec * 1_000);
    const daysToExpiry = Number.isFinite(dteEt) ? dteEt : (arExp?.days ?? 0);
    const expiryUtcSec =
      contracts[0]?.expiryUtcSec ?? arExp?.expiryUtcSec ?? etExpiryUtcSecFromDate(expDate);

    const expExposureFromOpts = frozenOpts?.exposureSummaryByExpiry?.[expDate];
    const exposureSummary =
      expExposureFromOpts !== undefined
        ? arExposureToUsSummary(expExposureFromOpts)
        : frozenSnap.exposureSummary ?? null;
    const rawVolExp = frozenSnap.terminalEngines?.volAnalyticsSuite?.expiriesByCode?.[expDate];
    const volAnalyticsExpiry =
      rawVolExp !== null && rawVolExp !== undefined && typeof rawVolExp === 'object'
        ? (rawVolExp as UsVolAnalyticsExpiryRef)
        : null;
    const volSlice =
      frozenSnap.volSurfaceSummary?.slices?.find((s) => s.expirationDate === expDate) ?? null;

    expiries.push({
      expirationDate: expDate,
      daysToExpiry,
      expiryUtcSec,
      contracts,
      exposureSummary,
      volAnalyticsExpiry,
      volSlice,
      sourceKind: arExp?.loaded === true ? 'EXPIRY_ENDPOINT' : 'SNAPSHOT_PRELOADED',
    });
  }

  const institutionalAvwapContext = toInstitutionalAvwapMarkdownInput(
    frozenSnap.institutionalAvwapContext,
    barsTimeframe,
  );

  return {
    request,
    capturedAtUtcSec,
    usSnapshot: frozenSnap,
    expiries,
    barsResponse,
    barsTimeframe,
    barsAsOfUtcSec,
    usVolSurface: frozenVolSurface,
    liveSpotQuote: frozenAtomicSpot
      ? {
          price: frozenAtomicSpot.price,
          previousClose: frozenAtomicSpot.previousClose,
          dayLow: frozenAtomicSpot.dayLow,
          dayHigh: frozenAtomicSpot.dayHigh,
          asOfUtcSec: frozenAtomicSpot.asOfUtcSec,
          sessionPhase: frozenAtomicSpot.sessionPhase ?? null,
        }
      : null,
    additionalRequestsCount,
    ...(institutionalAvwapContext !== undefined ? { institutionalAvwapContext } : {}),
  };
}

/**
 * Orquestador principal EXPORT-1 con deduplicación concurrente, cancelación y timings.
 */
export async function exportUsOptionsSnapshot(
  request: ExportUsOptionsSnapshotRequest,
  externalSignal?: AbortSignal,
  deps: SnapshotCollectorDependencies = DEFAULT_COLLECTOR_DEPS,
): Promise<SnapshotExportResult> {
  if (request.format === 'pdf') {
    throw new Error('El formato PDF diferido se habilita en la Pieza EXPORT-2.');
  }
  const key = buildCanonicalExportKey(request);
  const existing = inFlightExports.get(key);
  if (existing !== undefined && !existing.controller.signal.aborted) {
    if (!externalSignal) {
      return existing.promise;
    }
    if (externalSignal.aborted) {
      throw new DOMException('Snapshot export aborted', 'AbortError');
    }
    return new Promise<SnapshotExportResult>((resolve, reject) => {
      const onAbort = () => {
        existing.controller.abort();
        reject(new DOMException('Snapshot export aborted', 'AbortError'));
      };
      externalSignal.addEventListener('abort', onAbort, { once: true });
      existing.promise.then(
        (res) => {
          externalSignal.removeEventListener('abort', onAbort);
          resolve(res);
        },
        (err: unknown) => {
          externalSignal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  }

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (externalSignal !== undefined) {
    if (externalSignal.aborted) {
      throw new DOMException('Snapshot export aborted', 'AbortError');
    }
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const promise = (async (): Promise<SnapshotExportResult> => {
    const t0 = performance.now();
    const raw = await collectSnapshotData(request, controller.signal, deps);
    const tCollect = performance.now();
    throwIfAborted(controller.signal);

    const snapshot = buildUsOptionsIntelligenceSnapshot(raw);
    const integrity = validateSnapshotIntegrity(snapshot);
    const filtered = filterSnapshotByMode(snapshot, {
      ...(request.swingChainFilter !== undefined
        ? { swingChainFilter: request.swingChainFilter }
        : {}),
    });
    const tFilter = performance.now();
    throwIfAborted(controller.signal);

    const md = renderUsOptionsSnapshotMarkdown(filtered, integrity);
    const tMd = performance.now();
    throwIfAborted(controller.signal);

    return {
      snapshotId: snapshot.snapshotId,
      schemaVersion: snapshot.schemaVersion,
      dto: filtered,
      integrity,
      markdown: md.markdown,
      markdownByteLength: md.byteLengthUtf8,
      exceedsTargetBudget: md.exceedsTargetBudget,
      charts: [],
      pdfBlob: null,
      timingsMs: {
        collectMs: +(tCollect - t0).toFixed(2),
        validateAndFilterMs: +(tFilter - tCollect).toFixed(2),
        serializeMarkdownMs: +(tMd - tFilter).toFixed(2),
        captureChartsMs: 0,
        renderPdfMs: 0,
        totalMs: +(tMd - t0).toFixed(2),
      },
      additionalRequestsCount: raw.additionalRequestsCount,
    };
  })().finally(() => {
    externalSignal?.removeEventListener('abort', onExternalAbort);
    const current = inFlightExports.get(key);
    if (current?.controller === controller) {
      inFlightExports.delete(key);
    }
  });

  inFlightExports.set(key, { controller, promise });
  return promise;
}
