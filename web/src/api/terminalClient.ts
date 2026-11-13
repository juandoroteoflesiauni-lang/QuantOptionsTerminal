import { useEffect, useRef, useState } from 'react';

export const NULL_DISPLAY = '—';

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1D';

export type NoDataReason =
  | 'INVALID_SYMBOL'
  | 'INVALID_PARAMETER'
  | 'MISSING_API_KEY'
  | 'NO_MARKET_DATA'
  | 'NO_BARS_DATA'
  | 'PROVIDER_ERROR';

export interface NoDataPayload {
  readonly status: 'NO_DATA';
  readonly reason: NoDataReason;
  readonly detail: string;
}

export type TerminalDataStatus = 'OK' | 'NO_DATA';
export type EnvelopeStatus = 'OK' | 'PARTIAL' | 'NO_DATA';
export type GammaFlipStatus = 'FOUND' | 'OUT_OF_RANGE' | 'INSUFFICIENT_DATA' | 'NO_SIGN_CHANGE';
export type VixRegime = 'LOW_VOL' | 'NORMAL' | 'ELEVATED' | 'STRESS' | 'PANIC' | 'NO_DATA';
export type MtfRegime1d = 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'NO_DATA';
export type MtfEffectiveRegime = 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'NO_DATA';
export type MtfSetupStatus =
  | 'READY_LONG'
  | 'READY_SHORT'
  | 'PULLBACK_LONG'
  | 'PULLBACK_SHORT'
  | 'WAIT_ALIGNED'
  | 'CONFLICT'
  | 'NEUTRAL'
  | 'NO_DATA';
export type BalanceType = 'BALANCED' | 'IMBALANCED_UP' | 'IMBALANCED_DOWN' | 'NO_DATA';
export type InventoryRiskType = 'LONG_TRAPPED' | 'SHORT_TRAPPED' | 'NEUTRAL' | 'NO_DATA';
export type OpeningType = 'OD_UP' | 'OD_DOWN' | 'OTD_UP' | 'OTD_DOWN' | 'ORR' | 'OAIR' | 'NO_DATA';
export type OpeningDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'NO_DATA';
export type InitialBalanceClassification = 'WIDE' | 'NORMAL' | 'NARROW' | 'PENDING' | 'NO_DATA';
export type GammaRegime = 'POSITIVE_GAMMA' | 'NEGATIVE_GAMMA' | 'TRANSITION_ZONE' | 'NO_DATA';
export type DirectionalBias =
  | 'STRONG_BULLISH'
  | 'BULLISH'
  | 'NEUTRAL'
  | 'BEARISH'
  | 'STRONG_BEARISH'
  | 'NO_DATA';

export type PillarId =
  | 'mtf'
  | 'optionsPositioning'
  | 'openingAuction'
  | 'cvdAbsorption'
  | 'divergences'
  | 'breadthMacro';

export type KeyLevelName =
  | 'CallWall'
  | 'PutWall'
  | 'GammaFlip'
  | 'PMH'
  | 'PML'
  | 'ON_POC'
  | 'ON_VAH'
  | 'ON_VAL'
  | 'IBH'
  | 'IBL'
  | 'PDH'
  | 'PDL'
  | 'PDC'
  | 'SMA200_1D'
  | 'SMA50_4H'
  | 'EMA21_15M'
  | 'HMA55_5M';

export type KeyLevelSource = 'OPTIONS' | 'OPENING_AUCTION' | 'MTF' | 'REFERENCE';

export interface SerializedPillarAssessment {
  readonly id: PillarId;
  readonly label: string;
  readonly status: TerminalDataStatus;
  readonly score: number | null;
  readonly weight: number | null;
  readonly weightedContribution: number | null;
  readonly summaryCode: string;
}

export interface SerializedKeyLevel {
  readonly name: KeyLevelName;
  readonly source: KeyLevelSource;
  readonly price: number | null;
}

export interface SerializedConfluenceMetrics {
  readonly spot: number | null;
  readonly netDollarGex: number | null;
  readonly netDex: number | null;
  readonly gammaFlipSpot: number | null;
  readonly callWallStrike: number | null;
  readonly putWallStrike: number | null;
  readonly expectedMove: number | null;
  readonly expectedMovePct: number | null;
  readonly iv30d: number | null;
  readonly riskReversal25: number | null;
  readonly butterfly25: number | null;
  readonly realizedVolAnnualized: number | null;
  readonly rvCenteredAnnualized: number | null;
  readonly vrpSpread: number | null;
  readonly vixLevel: number | null;
  readonly vixSlope: number | null;
  readonly cboeSkewLevel: number | null;
  readonly vixRegime: VixRegime;
  readonly tailRiskAlert: boolean | null;
  readonly positionSizeMultiplier: number | null;
  readonly adLineSlope: number | null;
  readonly latestAdLine: number | null;
  readonly currentSessionCvd: number | null;
  readonly latestRsi: number | null;
}

export interface TerminalSerializedEnvelope {
  readonly schemaVersion: '1.0.0';
  readonly envelopeStatus: EnvelopeStatus;
  readonly nonFiniteFieldCount: number;
  readonly nonFinitePaths: readonly string[];
  readonly metadata: {
    readonly symbol: string;
    readonly generatedAtUtcSec: number | null;
    readonly timeframe?: string;
    readonly sessionDate?: string;
    readonly asOfUtcSec?: number | null;
  };
  readonly snapshot: {
    readonly status: TerminalDataStatus;
    readonly asOfUtcSec: number | null;
    readonly activePillarsCount: number | null;
    readonly totalPillarsCount: number | null;
    readonly totalActiveWeight: number | null;
    readonly confluenceScore: number | null;
    readonly directionalBias: DirectionalBias;
    readonly gammaRegime: GammaRegime;
    readonly pillars: readonly SerializedPillarAssessment[];
    readonly pillarMap: Readonly<Record<PillarId, SerializedPillarAssessment>>;
    readonly keyLevels: readonly SerializedKeyLevel[];
    readonly metrics: SerializedConfluenceMetrics;
  };
}

export interface SerializedStrikeExposure {
  readonly strike: number;
  readonly callOi: number;
  readonly putOi: number;
  readonly callVolume: number;
  readonly putVolume: number;
  readonly callGex: number | null;
  readonly putGex: number | null;
  readonly netGex: number | null;
  readonly netSpotGamma: number | null;
  readonly netDex: number | null;
  readonly netVannaExposure: number | null;
  readonly netCharmExposure: number | null;
}

export interface SerializedExposureSummary {
  readonly netGex: number | null;
  readonly callGex: number | null;
  readonly putGex: number | null;
  readonly netSpotGamma: number | null;
  readonly netDex: number | null;
  readonly netVannaExposure: number | null;
  readonly netCharmExposure: number | null;
  readonly callWallStrike: number | null;
  readonly putWallStrike: number | null;
  readonly gammaFlipSpot: number | null;
  readonly gammaFlipStatus: GammaFlipStatus;
  readonly expectedMove: {
    readonly expiryUtcSec: number | null;
    readonly formulaMove: number | null;
    readonly formulaMovePct: number | null;
    readonly straddleStrike: number | null;
    readonly straddleMove: number | null;
    readonly straddleMovePct: number | null;
  };
  readonly quality: {
    readonly totalContracts: number;
    readonly activeContracts: number;
    readonly usableContracts: number;
    readonly skippedContracts: number;
    readonly skippedOiShare: number | null;
  };
  readonly byStrike: readonly SerializedStrikeExposure[];
}

export interface SerializedVolSliceNode {
  readonly strike: number;
  readonly k: number;
  readonly iv: number | null;
  readonly totalVariance: number | null;
  readonly slope: number | null;
  readonly spreadRatio: number | null;
  readonly openInterest: number;
}

export interface SerializedVolSliceSummary {
  readonly expirySec: number;
  readonly expirationDate: string;
  readonly timeToExpiryYears: number;
  readonly timeToExpiryDays: number;
  readonly forward: number | null;
  readonly rate: number | null;
  readonly dividendYield: number | null;
  readonly ivAtm: number | null;
  readonly delta25PutIv: number | null;
  readonly delta25CallIv: number | null;
  readonly riskReversal25: number | null;
  readonly butterfly25: number | null;
  readonly isButterflyArbitrageFree: boolean;
  readonly butterflyMinDensity: number | null;
  readonly nodes: readonly SerializedVolSliceNode[];
}

export interface SerializedOptionContractRow {
  readonly ticker: string;
  readonly contractType: 'call' | 'put';
  readonly strike: number;
  readonly expirationDate: string;
  readonly expiryUtcSec: number;
  readonly bid: number | null;
  readonly ask: number | null;
  readonly mid: number | null;
  readonly lastPrice: number | null;
  readonly openInterest: number | null;
  readonly volume: number | null;
  readonly ownIv: number | null;
  readonly providerIv: number | null;
  readonly ivSource: 'OWN' | 'PROVIDER' | 'NONE';
  readonly delta: number | null;
  readonly gamma: number | null;
  readonly thetaDaily: number | null;
  readonly vegaPer1Pct: number | null;
  readonly vanna: number | null;
  readonly charm: number | null;
}

export interface SerializedVolSurfaceSummary {
  readonly iv30d: number | null;
  readonly butterflyArbitrageFree: boolean;
  readonly calendarArbitrageFree: boolean;
  readonly isArbitrageFree: boolean;
  readonly frontSlice: SerializedVolSliceSummary | null;
  readonly slices: readonly SerializedVolSliceSummary[];
  readonly contracts: readonly SerializedOptionContractRow[];
}

export interface SerializedOpeningAuctionSummary {
  readonly balanceType: BalanceType;
  readonly inventoryRisk: InventoryRiskType;
  readonly openingType: OpeningType;
  readonly openingDirection: OpeningDirection;
  readonly ibClassification: InitialBalanceClassification;
  readonly pmh: number | null;
  readonly pml: number | null;
  readonly onPoc: number | null;
  readonly onVah: number | null;
  readonly onVal: number | null;
  readonly ibh: number | null;
  readonly ibl: number | null;
  readonly ibWidth: number | null;
  readonly atr14d: number | null;
  readonly gapPct: number | null;
  readonly macro0830SpikeDetected: boolean;
}

export interface SerializedAbsorptionMarker {
  readonly time: number;
  readonly direction: 'BUY_ABSORPTION' | 'SELL_ABSORPTION';
  readonly price: number | null;
  readonly levelName: string | null;
  readonly levelPrice: number | null;
  readonly barDelta: number | null;
  readonly sessionCvd: number | null;
}

export interface SerializedDivergenceMarker {
  readonly kind: 'RSI' | 'SMT';
  readonly type: string;
  readonly pivotTime: number;
  readonly confirmTime: number;
  readonly price: number | null;
}

export interface SerializedMicrostructureSummary {
  readonly mtf: {
    readonly regime1d: MtfRegime1d;
    readonly aligned4h: boolean;
    readonly effectiveMacroRegime: MtfEffectiveRegime;
    readonly pullback15mInZone: boolean;
    readonly absorption15m: boolean;
    readonly executionTriggerActive: boolean;
    readonly setupStatus: MtfSetupStatus;
    readonly sma200_1d: number | null;
    readonly sma50_4h: number | null;
    readonly ema21_15m: number | null;
    readonly hma55: number | null;
    readonly close5m: number | null;
  } | null;
  readonly cvd: {
    readonly deltaMode: string;
    readonly currentSessionDate: string | null;
    readonly currentSessionCvd: number | null;
    readonly absorptionEvents: readonly SerializedAbsorptionMarker[];
  } | null;
  readonly rsiDivergences: {
    readonly status: string;
    readonly latestRsi: number | null;
    readonly events: readonly SerializedDivergenceMarker[];
  } | null;
  readonly smtDivergences: {
    readonly status: string;
    readonly correlatedSymbol: string;
    readonly events: readonly SerializedDivergenceMarker[];
  } | null;
}

export interface SerializedUnifiedQuote {
  readonly ticker: string;
  readonly assetType: 'stock' | 'index';
  readonly price: number | null;
  readonly change: number | null;
  readonly changePct: number | null;
  readonly previousClose: number | null;
  readonly marketStatus: string | null;
  readonly volume: number | null;
}

export interface SerializedMarketContext {
  readonly unifiedQuotes: readonly SerializedUnifiedQuote[];
  readonly treasury: {
    readonly date: string | null;
    readonly yield1M: number | null;
    readonly yield3M: number | null;
    readonly yield1Y: number | null;
    readonly yield2Y: number | null;
    readonly yield10Y: number | null;
    readonly sofr: number | null;
    readonly rate30d: number | null;
    readonly dividendYieldFront: number | null;
  };
  readonly vixLevel: number | null;
  readonly vixSlope: number | null;
  readonly vixRegime: VixRegime;
  readonly skewLevel: number | null;
  readonly tailRiskAlert: boolean | null;
}

export interface SnapshotDataQuality {
  readonly ownSolvedIvContracts: number;
  readonly providerFallbackIvContracts: number;
  readonly parityExpiries: number;
  readonly chainContractsReceived: number;
  readonly chainContractsUsable: number;
  readonly warnings: readonly string[];
}

export interface TerminalSnapshotResponse {
  readonly status: 'OK' | 'PARTIAL';
  readonly symbol: string;
  readonly correlatedSymbol: string;
  readonly isIndex: boolean;
  readonly asOfUtcSec: number;
  readonly envelope: TerminalSerializedEnvelope;
  readonly exposureSummary: SerializedExposureSummary | null;
  readonly volSurfaceSummary: SerializedVolSurfaceSummary | null;
  readonly openingAuction: SerializedOpeningAuctionSummary | null;
  readonly microstructure: SerializedMicrostructureSummary;
  readonly marketContext: SerializedMarketContext;
  readonly dataQuality: SnapshotDataQuality;
}

export interface SerializedBar {
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly vw: number | null;
}

export interface TerminalBarsResponse {
  readonly status: 'OK' | 'PARTIAL';
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly barSeconds: number;
  readonly rthOnly: boolean;
  readonly asOfUtcSec: number;
  readonly visibleStartIndex: number;
  readonly bars: readonly SerializedBar[];
  readonly formingBar: SerializedBar | null;
  readonly overlays: {
    readonly ema21: readonly (number | null)[];
    readonly sma50: readonly (number | null)[];
    readonly sma200: readonly (number | null)[];
    readonly hma55: readonly (number | null)[];
    readonly sessionVwap: readonly (number | null)[];
    readonly sessionVwapSupported: boolean;
    readonly avwap: readonly (number | null)[];
    readonly avwapUpper1: readonly (number | null)[];
    readonly avwapLower1: readonly (number | null)[];
    readonly avwapUpper2: readonly (number | null)[];
    readonly avwapLower2: readonly (number | null)[];
  };
  readonly subPanes: {
    readonly rsi14: readonly (number | null)[];
    readonly sessionCvd: readonly (number | null)[];
    readonly deltaMode: string | null;
  };
  readonly zones: {
    readonly onVal: number | null;
    readonly onVah: number | null;
    readonly onPoc: number | null;
    readonly ibl: number | null;
    readonly ibh: number | null;
  } | null;
  readonly keyLevels: readonly SerializedKeyLevel[];
  readonly markers: readonly (SerializedAbsorptionMarker | SerializedDivergenceMarker)[];
}

export interface SerializedUnusualTradeRow {
  readonly ticker: string;
  readonly underlyingTicker: string | null;
  readonly root: string;
  readonly rootKind: string;
  readonly contractType: 'call' | 'put' | null;
  readonly strike: number | null;
  readonly expirationDate: string | null;
  readonly time: number;
  readonly timestampNs: string;
  readonly price: number | null;
  readonly size: number | null;
  readonly sharesPerContract: number | null;
  readonly notional: number | null;
  readonly flags: readonly string[];
  readonly exchange: number | null;
  readonly sequenceNumber: number;
}

export interface TerminalUnusualResponse {
  readonly status: 'OK' | 'NO_DATA';
  readonly asOfUtcSec: number;
  readonly symbol: string | null;
  readonly received: number;
  readonly accepted: number;
  readonly filteredOut: number;
  readonly trades: readonly SerializedUnusualTradeRow[];
}

export interface RuntimeHealthResponse {
  readonly ok: boolean;
  readonly nowUtcSec: number;
  readonly hasApiKey: boolean;
  readonly watchedSymbols: readonly string[];
  readonly ws: {
    readonly stocks: { readonly state: string } | null;
    readonly options: { readonly state: string } | null;
    readonly subscribedOptionQuotes: number;
  };
}

export type RuntimeWsBroadcast =
  | {
      readonly type: 'bar_update';
      readonly cluster: 'stocks' | 'options';
      readonly symbol: string;
      readonly time: number;
      readonly formingBar: SerializedBar | null;
      readonly lastClosedBar: SerializedBar | null;
      readonly projectedEma21: number | null;
      readonly projectedSessionVwap: number | null;
      readonly projectedAvwap: number | null;
      readonly serverTimeSec: number;
    }
  | {
      readonly type: 'trade';
      readonly cluster: 'stocks' | 'options';
      readonly symbol: string;
      readonly time: number;
      readonly price: number;
      readonly size: number;
    }
  | {
      readonly type: 'quote';
      readonly cluster: 'stocks' | 'options';
      readonly symbol: string;
      readonly time: number;
      readonly bid: number | null;
      readonly ask: number | null;
      readonly mid: number | null;
    }
  | {
      readonly type: 'status';
      readonly cluster: 'stocks' | 'options';
      readonly state: string;
      readonly message: string;
      readonly time: number;
    };

export class TerminalApiError extends Error {
  public readonly status: 'NO_DATA' = 'NO_DATA';
  public readonly reason: NoDataReason;
  public readonly detail: string;
  public readonly httpStatus: number;

  public constructor(reason: NoDataReason, detail: string, httpStatus: number) {
    super(`${reason}: ${detail}`);
    this.name = 'TerminalApiError';
    this.reason = reason;
    this.detail = detail;
    this.httpStatus = httpStatus;
  }
}

export function isFiniteNum(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function fmtNum(value: number | null | undefined, decimals = 2): string {
  if (!isFiniteNum(value)) {
    return NULL_DISPLAY;
  }
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function fmtUsd(value: number | null | undefined, decimals = 2): string {
  if (!isFiniteNum(value)) {
    return NULL_DISPLAY;
  }
  const abs = Math.abs(value);
  const formatted = abs.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return value < 0 ? `-$${formatted}` : `$${formatted}`;
}

export function fmtCompactUsd(value: number | null | undefined): string {
  if (!isFiniteNum(value)) {
    return NULL_DISPLAY;
  }
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) {
    return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  }
  if (abs >= 1_000_000) {
    return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  }
  if (abs >= 1_000) {
    return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  }
  return `${sign}$${abs.toFixed(0)}`;
}

export function fmtCompactInt(value: number | null | undefined): string {
  if (!isFiniteNum(value)) {
    return NULL_DISPLAY;
  }
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) {
    return `${sign}${(abs / 1_000_000_000).toFixed(2)}B`;
  }
  if (abs >= 1_000_000) {
    return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  }
  if (abs >= 1_000) {
    return `${sign}${(abs / 1_000).toFixed(1)}K`;
  }
  return `${sign}${Math.round(abs).toLocaleString('en-US')}`;
}

export function fmtPct(value: number | null | undefined, decimals = 2, signed = false): string {
  if (!isFiniteNum(value)) {
    return NULL_DISPLAY;
  }
  const prefix = signed && value > 0 ? '+' : '';
  return `${prefix}${value.toFixed(decimals)}%`;
}

export function fmtDecimalPct(
  value: number | null | undefined,
  decimals = 2,
  signed = false,
): string {
  if (!isFiniteNum(value)) {
    return NULL_DISPLAY;
  }
  return fmtPct(value * 100, decimals, signed);
}

export function fmtUtcTimeET(utcSec: number | null | undefined): string {
  if (!isFiniteNum(utcSec) || utcSec <= 0) {
    return NULL_DISPLAY;
  }
  const d = new Date(utcSec * 1_000);
  return `${d.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })} ET`;
}

export function fmtUtcDateET(utcSec: number | null | undefined): string {
  if (!isFiniteNum(utcSec) || utcSec <= 0) {
    return NULL_DISPLAY;
  }
  const d = new Date(utcSec * 1_000);
  return d.toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: '2-digit',
  });
}

async function fetchJsonStrict<T>(url: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    const detail = err instanceof Error && err.message ? err.message : 'Backend connection failed';
    throw new TerminalApiError('PROVIDER_ERROR', detail, 503);
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new TerminalApiError(
      'PROVIDER_ERROR',
      `Malformed JSON response (HTTP ${String(response.status)})`,
      response.status,
    );
  }

  if (!response.ok) {
    const errObj = parsed as Partial<NoDataPayload> | null;
    if (errObj && errObj.status === 'NO_DATA' && typeof errObj.reason === 'string') {
      throw new TerminalApiError(
        errObj.reason,
        typeof errObj.detail === 'string' && errObj.detail.trim() !== ''
          ? errObj.detail
          : `HTTP ${String(response.status)}`,
        response.status,
      );
    }
    throw new TerminalApiError(
      'PROVIDER_ERROR',
      `Backend HTTP ${String(response.status)}`,
      response.status,
    );
  }

  return parsed as T;
}

export function fetchHealth(signal?: AbortSignal): Promise<RuntimeHealthResponse> {
  return fetchJsonStrict<RuntimeHealthResponse>('/api/health', signal);
}

export function fetchSnapshot(
  symbol: string,
  options: { readonly refresh?: boolean; readonly signal?: AbortSignal } = {},
): Promise<TerminalSnapshotResponse> {
  const qs = new URLSearchParams({ symbol: symbol.trim().toUpperCase() });
  if (options.refresh === true) {
    qs.set('refresh', '1');
  }
  return fetchJsonStrict<TerminalSnapshotResponse>(
    `/api/snapshot?${qs.toString()}`,
    options.signal,
  );
}

export function fetchBars(
  params: {
    readonly symbol: string;
    readonly timeframe: Timeframe;
    readonly visibleBars?: number;
    readonly rthOnly?: boolean;
    readonly refresh?: boolean;
  },
  signal?: AbortSignal,
): Promise<TerminalBarsResponse> {
  const qs = new URLSearchParams({
    symbol: params.symbol.trim().toUpperCase(),
    timeframe: params.timeframe,
    visibleBars: String(params.visibleBars ?? 240),
    rthOnly: params.rthOnly ? '1' : '0',
  });
  if (params.refresh === true) {
    qs.set('refresh', '1');
  }
  return fetchJsonStrict<TerminalBarsResponse>(`/api/bars?${qs.toString()}`, signal);
}

export function fetchUnusual(
  params: {
    readonly symbol?: string;
    readonly root?: string;
    readonly minPremium?: number;
    readonly limit?: number;
    readonly refresh?: boolean;
  } = {},
  signal?: AbortSignal,
): Promise<TerminalUnusualResponse> {
  const qs = new URLSearchParams();
  if (params.symbol !== undefined && params.symbol.trim() !== '') {
    qs.set('symbol', params.symbol.trim().toUpperCase());
  }
  if (params.root !== undefined && params.root.trim() !== '') {
    qs.set('root', params.root.trim().toUpperCase());
  }
  if (params.minPremium !== undefined && Number.isFinite(params.minPremium) && params.minPremium > 0) {
    qs.set('minPremium', String(params.minPremium));
  }
  qs.set('limit', String(params.limit ?? 100));
  if (params.refresh === true) {
    qs.set('refresh', '1');
  }
  return fetchJsonStrict<TerminalUnusualResponse>(`/api/unusual?${qs.toString()}`, signal);
}

export type WsConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export interface RuntimeWsState {
  readonly connectionStatus: WsConnectionStatus;
  readonly lastStatusMessage: string | null;
  readonly lastServerTimeSec: number | null;
}

export function useRuntimeWebSocket(
  symbols: readonly string[],
  onMessage: (event: RuntimeWsBroadcast) => void,
): RuntimeWsState {
  const [connectionStatus, setConnectionStatus] = useState<WsConnectionStatus>('connecting');
  const [lastStatusMessage, setLastStatusMessage] = useState<string | null>(null);
  const [lastServerTimeSec, setLastServerTimeSec] = useState<number | null>(null);

  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const normalizedSymbolsKey = symbols
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s !== '')
    .join(',');

  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closedByEffect = false;
    let reconnectTimer: number | null = null;
    let attempt = 0;

    const connect = (): void => {
      if (closedByEffect) {
        return;
      }
      setConnectionStatus('connecting');
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = (): void => {
        attempt = 0;
        setConnectionStatus('connected');
        const list = normalizedSymbolsKey === '' ? [] : normalizedSymbolsKey.split(',');
        if (list.length > 0) {
          ws.send(JSON.stringify({ action: 'subscribe', symbols: list }));
        }
      };

      ws.onmessage = (evt: MessageEvent): void => {
        if (typeof evt.data !== 'string') {
          return;
        }
        try {
          const payload = JSON.parse(evt.data) as RuntimeWsBroadcast;
          if (payload.type === 'status') {
            setLastStatusMessage(payload.message);
            setLastServerTimeSec(payload.time);
          } else if (payload.type === 'bar_update') {
            setLastServerTimeSec(payload.serverTimeSec);
          }
          onMessageRef.current(payload);
        } catch {
          // Malformed WS frame ignored intentionally.
        }
      };

      ws.onclose = (): void => {
        wsRef.current = null;
        if (closedByEffect) {
          return;
        }
        setConnectionStatus('disconnected');
        const delayMs = Math.min(15_000, 1_000 * Math.pow(2, Math.min(attempt, 4)));
        attempt += 1;
        reconnectTimer = window.setTimeout(connect, delayMs);
      };

      ws.onerror = (): void => {
        // onclose handles reconnect transition.
      };
    };

    connect();

    return () => {
      closedByEffect = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      if (wsRef.current !== null) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [normalizedSymbolsKey]);

  return {
    connectionStatus,
    lastStatusMessage,
    lastServerTimeSec,
  };
}
