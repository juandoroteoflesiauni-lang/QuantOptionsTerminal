import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { calendarDteEt } from '../../../src/core/options/zeroDteFixes';
import type { LogicalRange } from 'lightweight-charts';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LogicalRange as LogicalRangeAlias,
  type Time,
  type UTCTimestamp,
  createChart,
} from 'lightweight-charts';
import { ArrowLeft, Keyboard, Zap } from 'lucide-react';
import {
  getLiveOptionsForUnderlying,
  refreshOverview,
  requestOptionsChain,
  requestOptionsUniverse,
  requestStockDetail,
  requestTerminalBars,
  requestUsSnapshot,
  useLiveMarketState,
} from '../data/liveRuntimeBridge';
import type {
  ArStockDetailResponse,
  OrderBook5LevelsDto,
  TerminalTimeframe,
  UsTerminalBarsResponseDto,
} from '../data/liveTypes';
import {
  AR_GENERAL_PANEL_STOCKS,
  AR_STOCKS,
  US_MARKET_DATA,
  fmtNum,
  fmtPct,
} from '../data/marketData';
import { ExecutionBottomDeck } from './stock-detail/ExecutionBottomDeck';
import { GexStrikeProfileChart } from './stock-detail/GexStrikeProfileChart';
import { SyncedLowerPaneChart } from './stock-detail/SyncedLowerPaneChart';
import { CompanyLogo } from './common/CompanyLogo';
import { projectLiveEma } from '../../../src/core/ema';
import { projectLiveCandle } from '../../../src/core/realtimePropagation';
import {
  formatHeaderSideQuote,
  normalizeStockDetailHeaderQuotes,
  normalizeStockDetailOrderBook,
} from '../../../src/core/stockDetailStability';
import {
  resolveAvwapClickAnchor,
  resolveChartFitKey,
  resolveChartViewportTransition,
  shouldApplyExternalLogicalRange,
  shouldEmitLogicalRangeSync,
} from '../../../src/core/stockDetailChartNavigation';
import {
  computeAnchoredVwapSeries,
} from '../../../src/core/ggal/technicalIndicators';
import type { GgalChartBarPoint } from '../../../src/core/ggal/institutionalContracts';
import {
  type AvwapAnchorMode,
  type MinimalOhlcvBar,
  computeAnchoredVwapPure,
  computeEmaSeriesPure,
  computeExpectedMoveBounds,
  computeSessionVwapPure,
  computeWilderAtrPure,
  resolveAvwapAnchorIndex,
} from './stock-detail/stockDetailMath';
import type {
  ChartKeyLevels,
  ExpectedMoveOverlayInfo,
  GexStrikeProfileItem,
  HighlightLevelId,
  LowerPaneMode,
  OverlayVisibilityState,
  StockChartSeriesBundle,
  StockContextBannerInfo,
  StockExecutionDeckData,
} from './stock-detail/stockDetailTypes';
import {
  formatExtendedSessionBadge,
  getAtomicMarketQuote,
  getMarketStreamMetaClock,
  type LiveBarUpdateEvent,
  type MarketLiveOrderBook,
  subscribeAtomicQuoteValue,
  subscribeLiveBarUpdate,
  useAtomicMarketQuote,
  useAtomicOrderBook,
  useLivePriceFlash,
  useMarketStreamMeta,
} from '../api/useMarketLiveStream';
import {
  StockDetailSymbolSelector,
  type StockDetailCategory,
  type StockDetailSelectorItem,
} from './StockDetailSymbolSelector';
import {
  dualAdrSymbol,
  resolveStockDetailRoute,
  type StockDetailExchange,
} from './stock-detail/stockDetailRouting';

const CHART_TIMEFRAMES: readonly { readonly id: TerminalTimeframe; readonly label: string }[] = [
  { id: '1m', label: '1m' },
  { id: '5m', label: '5m' },
  { id: '15m', label: '15m' },
  { id: '1h', label: '1H' },
  { id: '4h', label: '4H' },
  { id: '1D', label: '1D' },
];

type PanoramicAvwapAnchorMode =
  | 'SESSION_START'
  | 'MONTH_START'
  | 'YEAR_START'
  | 'RANGE_LOW'
  | 'RANGE_HIGH'
  | 'CLICKED_CANDLE';

const PANORAMIC_AVWAP_MODES: readonly {
  readonly id: PanoramicAvwapAnchorMode;
  readonly label: string;
}[] = [
  { id: 'SESSION_START', label: 'Inicio Sesión' },
  { id: 'MONTH_START', label: 'Inicio Mes' },
  { id: 'YEAR_START', label: 'Inicio Año' },
  { id: 'RANGE_LOW', label: 'Mínimo Rango' },
  { id: 'RANGE_HIGH', label: 'Máximo Rango' },
  { id: 'CLICKED_CANDLE', label: 'Clic en Vela' },
];

const AR_BYMA_OPTIONS_ELIGIBLE = new Set(['GGAL']);

interface ArIndicatorOverlays {
  readonly ema9: readonly (number | null)[];
  readonly ema21: readonly (number | null)[];
  readonly ema50: readonly (number | null)[];
  readonly ema200: readonly (number | null)[];
  readonly sessionVwap: readonly (number | null)[];
  readonly sessionVwapSupported: boolean;
  readonly avwap: readonly (number | null)[];
  readonly avwapUpper1: readonly (number | null)[];
  readonly avwapLower1: readonly (number | null)[];
  readonly avwapUpper2: readonly (number | null)[];
  readonly avwapLower2: readonly (number | null)[];
  readonly avwapAnchorAvailable: boolean;
  readonly avwapAnchorMode: 'MONTH_START';
  readonly avwapAnchorUtcSec: number | null;
}

type ArStockDetailWithOverlays = ArStockDetailResponse & {
  readonly overlays?: ArIndicatorOverlays | null;
};

interface PanoramicChartBundle extends StockChartSeriesBundle {
  readonly avwapUpper1: readonly (number | null)[];
  readonly avwapLower1: readonly (number | null)[];
  readonly avwapUpper2: readonly (number | null)[];
  readonly avwapLower2: readonly (number | null)[];
  readonly avwapAnchorModeLabel: string;
}

function normalizeFiniteOrNull(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value) ? value : null;
}

function dedupAndSortBars(rawBars: readonly MinimalOhlcvBar[]): readonly MinimalOhlcvBar[] {
  const byTime = new Map<number, MinimalOhlcvBar>();
  for (const bar of rawBars) {
    if (
      !Number.isFinite(bar.time) ||
      !Number.isFinite(bar.open) ||
      !Number.isFinite(bar.high) ||
      !Number.isFinite(bar.low) ||
      !Number.isFinite(bar.close)
    ) {
      continue;
    }
    byTime.set(bar.time, bar);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function barsToGgalChartPoints(bars: readonly MinimalOhlcvBar[]): readonly GgalChartBarPoint[] {
  return bars.map((bar) => ({
    timeSec: bar.time,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  }));
}

function alignVwapPointsToBars(
  bars: readonly MinimalOhlcvBar[],
  points: readonly { readonly timeSec: number; readonly avwap: number; readonly plus1Sigma: number; readonly minus1Sigma: number; readonly plus2Sigma: number; readonly minus2Sigma: number }[],
): {
  readonly avwap: readonly (number | null)[];
  readonly upper1: readonly (number | null)[];
  readonly lower1: readonly (number | null)[];
  readonly upper2: readonly (number | null)[];
  readonly lower2: readonly (number | null)[];
} {
  const byTime = new Map(points.map((point) => [point.timeSec, point] as const));
  return {
    avwap: bars.map((bar) => normalizeFiniteOrNull(byTime.get(bar.time)?.avwap)),
    upper1: bars.map((bar) => normalizeFiniteOrNull(byTime.get(bar.time)?.plus1Sigma)),
    lower1: bars.map((bar) => normalizeFiniteOrNull(byTime.get(bar.time)?.minus1Sigma)),
    upper2: bars.map((bar) => normalizeFiniteOrNull(byTime.get(bar.time)?.plus2Sigma)),
    lower2: bars.map((bar) => normalizeFiniteOrNull(byTime.get(bar.time)?.minus2Sigma)),
  };
}

function resolvePanoramicAnchorTime(
  bars: readonly MinimalOhlcvBar[],
  mode: PanoramicAvwapAnchorMode,
  market: 'AR' | 'US',
  clickedTimeSec: number | null,
): number | null {
  if (bars.length === 0) return null;
  const lastBar = bars[bars.length - 1];
  if (lastBar === undefined || !Number.isFinite(lastBar.time)) return null;
  const lastTime = lastBar.time;

  if (mode === 'SESSION_START') {
    const offsetSec = market === 'AR' ? -10_800 : -14_400;
    const sessionKey = Math.floor((lastTime + offsetSec) / 86_400);
    const idx = bars.findIndex((bar) => Math.floor((bar.time + offsetSec) / 86_400) === sessionKey);
    const bar = idx >= 0 ? bars[idx] : undefined;
    return bar?.time ?? null;
  }
  if (mode === 'MONTH_START') {
    const date = new Date(lastTime * 1_000);
    const monthStartSec = Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1_000);
    const idx = bars.findIndex((bar) => bar.time >= monthStartSec);
    const bar = idx >= 0 ? bars[idx] : undefined;
    return bar?.time ?? null;
  }
  if (mode === 'YEAR_START') {
    const yearStartSec = Math.floor(Date.UTC(new Date(lastTime * 1_000).getUTCFullYear(), 0, 1) / 1_000);
    const idx = bars.findIndex((bar) => bar.time >= yearStartSec);
    const bar = idx >= 0 ? bars[idx] : undefined;
    return bar?.time ?? null;
  }
  if (mode === 'RANGE_LOW' || mode === 'RANGE_HIGH') {
    const startIdx = Math.max(0, bars.length - 60);
    let bestTime: number | null = null;
    let bestValue = mode === 'RANGE_LOW' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    for (let i = startIdx; i < bars.length; i += 1) {
      const bar = bars[i];
      if (bar === undefined) continue;
      const value = mode === 'RANGE_LOW' ? bar.low : bar.high;
      if (!Number.isFinite(value)) continue;
      if ((mode === 'RANGE_LOW' && value < bestValue) || (mode === 'RANGE_HIGH' && value > bestValue)) {
        bestValue = value;
        bestTime = bar.time;
      }
    }
    return bestTime;
  }
  if (mode === 'CLICKED_CANDLE') {
    if (clickedTimeSec === null || !Number.isFinite(clickedTimeSec)) return null;
    const exact = bars.find((bar) => bar.time === clickedTimeSec);
    if (exact !== undefined) return exact.time;
    const idx = bars.findIndex((bar) => bar.time >= clickedTimeSec);
    const bar = idx >= 0 ? bars[idx] : undefined;
    return bar?.time ?? null;
  }
  return null;
}

function mergeArLiveOrderBookDto(
  baseBook: OrderBook5LevelsDto | null,
  liveBook: MarketLiveOrderBook | null,
  symbol: string,
  spot: number | null,
  dayHigh: number | null,
  dayLow: number | null,
  prevClose: number | null,
): OrderBook5LevelsDto | null {
  if (liveBook === null || liveBook.symbol !== symbol || (liveBook.bids.length === 0 && liveBook.asks.length === 0)) {
    return baseBook;
  }
  const bids = liveBook.bids.map((lvl) => ({
    price: lvl.price,
    size: lvl.size,
    ...(lvl.orderCount !== null ? { orderCount: lvl.orderCount } : {}),
  }));
  const asks = liveBook.asks.map((lvl) => ({
    price: lvl.price,
    size: lvl.size,
    ...(lvl.orderCount !== null ? { orderCount: lvl.orderCount } : {}),
  }));
  const norm = normalizeStockDetailOrderBook(bids, asks, 5);
  return {
    symbol,
    marketSymbol: baseBook?.marketSymbol ?? `${symbol} · 24hs`,
    settlement: baseBook?.settlement ?? '24hs',
    marketState: baseBook?.marketState ?? 'LIVE',
    source: liveBook.source,
    asOfUtcSec: liveBook.asOfUtcSec ?? baseBook?.asOfUtcSec ?? 0,
    bids: norm.bids,
    asks: norm.asks,
    bestBid: norm.bestBid,
    bestAsk: norm.bestAsk,
    mid: Number.isFinite(norm.mid) ? norm.mid : null,
    spreadArs: Number.isFinite(norm.spreadAbs) ? norm.spreadAbs : null,
    spreadPct: Number.isFinite(norm.spreadPct) ? norm.spreadPct : null,
    bidDepthSize: norm.bids.reduce((acc, row) => acc + row.size, 0),
    askDepthSize: norm.asks.reduce((acc, row) => acc + row.size, 0),
    vwapBid5: baseBook?.vwapBid5 ?? null,
    vwapAsk5: baseBook?.vwapAsk5 ?? null,
    vwapBook5: baseBook?.vwapBook5 ?? null,
    obi5: Number.isFinite(norm.obi5) ? norm.obi5 : null,
    last: spot ?? baseBook?.last ?? null,
    open: baseBook?.open ?? null,
    high: dayHigh ?? baseBook?.high ?? null,
    low: dayLow ?? baseBook?.low ?? null,
    close: prevClose ?? baseBook?.close ?? null,
    settlementPrice: baseBook?.settlementPrice ?? null,
    nominalVolume: baseBook?.nominalVolume ?? null,
  };
}

function rangePositionPct(
  spot: number | null,
  low: number | null,
  high: number | null,
): number | null {
  if (spot === null || low === null || high === null || !(high > low)) return null;
  return Math.max(0, Math.min(100, ((spot - low) / (high - low)) * 100));
}

export const StockDetailView: React.FC<{
  ticker: string;
  onSelectTicker: (t: string) => void;
  onGoToOptions: (t: string) => void;
  onBackToMonitor: () => void;
  onOpenOrderTicket: (preset: {
    ticker: string;
    side: 'Compra' | 'Venta';
    price: number;
    qty: number;
    instrumentLabel: string;
  }) => void;
}> = ({
  ticker,
  onSelectTicker,
  onGoToOptions,
  onBackToMonitor,
  onOpenOrderTicket,
}) => {
  const runtime = useLiveMarketState();
  const tickerRaw = ticker.trim().toUpperCase() || 'GGAL';

  const [selectorOpen, setSelectorOpen] = useState(false);
  const [timeframe, setTimeframe] = useState<TerminalTimeframe>('1D');
  const [avwapMode, setAvwapMode] = useState<PanoramicAvwapAnchorMode>('MONTH_START');
  const avwapModeRef = useRef(avwapMode);
  avwapModeRef.current = avwapMode;
  const [clickedAnchorTimeSec, setClickedAnchorTimeSec] = useState<number | null>(null);
  const [showAvwapBands, setShowAvwapBands] = useState(true);
  const [lowerMode, setLowerMode] = useState<LowerPaneMode>('CVD');
  const [highlightedLevel, setHighlightedLevel] = useState<HighlightLevelId>(null);
  const [overlays, setOverlays] = useState<OverlayVisibilityState>({
    emas: true,
    sessionVwap: true,
    avwap: true,
    volumeProfile: true,
    nakedPocs: false,
    fvgFob: true,
    optionWalls: true,
  });

  const [usBarsByKey, setUsBarsByKey] = useState<Readonly<Record<string, UsTerminalBarsResponseDto>>>({});
  // Pieza 38: velas reales ARS de /api/bars?market=AR para tickers argentinos.
  const [arBarsByKey, setArBarsByKey] = useState<Readonly<Record<string, UsTerminalBarsResponseDto>>>({});
  const [arFallbackNotice, setArFallbackNotice] = useState<{
    readonly requested: TerminalTimeframe;
    readonly effective: '1D';
    readonly reason: string | null;
  } | null>(null);
  const loadingRequestIdRef = useRef(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const mainLogicalRef = useRef<((range: LogicalRangeAlias) => void) | null>(null);
  const lowerLogicalRef = useRef<((range: LogicalRangeAlias) => void) | null>(null);
  const getMainLogicalRangeRef = useRef<(() => LogicalRangeAlias | null) | null>(null);
  const mainCrosshairRef = useRef<((time: number | null) => void) | null>(null);
  const lowerCrosshairRef = useRef<((time: number | null) => void) | null>(null);
  const hasOverviewRef = useRef(Boolean(runtime.overview));
  hasOverviewRef.current = Boolean(runtime.overview);

  const stockRoute = useMemo(() => {
    return resolveStockDetailRoute({
      rawTicker: tickerRaw,
      isArLocalSymbol:
        AR_STOCKS.some((stock) => stock.ticker === tickerRaw) ||
        AR_GENERAL_PANEL_STOCKS.some((stock) => stock.ticker === tickerRaw),
    });
  }, [tickerRaw]);
  const cleanTicker = stockRoute?.providerSymbol ?? tickerRaw;
  const isArMarket = stockRoute?.market === 'AR';
  const stockMode = stockRoute?.mode ?? 'BYMA_ARS';
  const stockExchange: StockDetailExchange = stockRoute?.exchange ?? 'US';
  const currentStockKey = stockRoute?.key ?? cleanTicker;

  const liveQuote = useAtomicMarketQuote(isArMarket ? 'AR' : 'US', cleanTicker, 250);
  const liveStreamMeta = useMarketStreamMeta(1_000);
  const liveOrderBook = useAtomicOrderBook(isArMarket ? cleanTicker : null, 100);
  const liveClock = liveStreamMeta.isFresh ? getMarketStreamMetaClock(liveStreamMeta) : null;
  const liveHeaderFlash = useLivePriceFlash(liveQuote?.price ?? null);

  useEffect(() => {
    if (runtime.optionsUnderlyingsStatus === 'IDLE') {
      void requestOptionsUniverse();
    }
  }, [runtime.optionsUnderlyingsStatus]);

  useEffect(() => {
    const controller = new AbortController();
    const requestId = loadingRequestIdRef.current + 1;
    loadingRequestIdRef.current = requestId;
    setLoading(true);
    setLoadError(null);
    setHighlightedLevel(null);
    setClickedAnchorTimeSec(null);
    setArFallbackNotice(null);
    if (!hasOverviewRef.current) void refreshOverview();

    const isCurrent = (): boolean => requestId === loadingRequestIdRef.current && !controller.signal.aborted;

    const load = async (): Promise<void> => {
      try {
        if (isArMarket) {
          // Pieza 41 + 43: BYMA usa /api/bars?market=AR con fallback no destructivo a 1D
          // para todos los timeframes intradiarios (`1m`, `5m`, `15m`, `1h`, `4h`).
          const detailPromise = requestStockDetail(cleanTicker, false, timeframe, controller.signal);
          void detailPromise.catch(() => undefined);
          let arBarsRes = await requestTerminalBars(cleanTicker, timeframe, {
            visibleBars: 1_250,
            market: 'AR',
            signal: controller.signal,
          }).catch(() => null);
          if (!isCurrent()) return;

          if ((arBarsRes === null || arBarsRes.bars.length === 0) && timeframe !== '1D') {
            arBarsRes = await requestTerminalBars(cleanTicker, '1D', {
              visibleBars: 1_250,
              market: 'AR',
              signal: controller.signal,
            }).catch(() => null);
            if (!isCurrent()) return;
            if (arBarsRes !== null && arBarsRes.bars.length > 0) {
              setArFallbackNotice({
                requested: timeframe,
                effective: '1D',
                reason: arBarsRes.fallbackReason ?? `NO_${timeframe.toUpperCase()}_BARS_AR`,
              });
            }
          } else if (
            arBarsRes !== null &&
            timeframe !== '1D' &&
            arBarsRes.effectiveTimeframe === '1D'
          ) {
            setArFallbackNotice({
              requested: timeframe,
              effective: '1D',
              reason: arBarsRes.fallbackReason ?? null,
            });
          }

          if (arBarsRes !== null && arBarsRes.bars.length > 0) {
            const finalArBars = arBarsRes;
            setArBarsByKey((prev) => ({
              ...prev,
              [`${currentStockKey}:${timeframe}`]: finalArBars,
              ...(finalArBars.effectiveTimeframe === '1D' || timeframe === '1D'
                ? { [`${currentStockKey}:1D`]: finalArBars }
                : {}),
            }));
            setLoadError(null);
          } else {
            const detailRes = await detailPromise.catch(() => null);
            if (!isCurrent()) return;
            if (detailRes !== null && detailRes.historicalBars.length > 0) {
              if (timeframe !== '1D') {
                setArFallbackNotice({
                  requested: timeframe,
                  effective: '1D',
                  reason: `NO_${timeframe.toUpperCase()}_BARS_AR`,
                });
              }
              setLoadError(null);
            } else {
              setLoadError(`No se pudieron cargar velas para ${cleanTicker} (${timeframe}).`);
            }
          }
          setLoading(false);
          void requestOptionsChain(cleanTicker).catch(() => undefined);
        } else {
          const barsPromise = requestTerminalBars(cleanTicker, timeframe, {
            visibleBars: timeframe === '1D' ? 1_250 : 1_000,
            signal: controller.signal,
          });
          void requestUsSnapshot(cleanTicker, { signal: controller.signal }).catch(() => undefined);
          const barsRes = await barsPromise;
          if (!isCurrent()) return;
          if (barsRes) {
            setUsBarsByKey((prev) => ({
              ...prev,
              [`${currentStockKey}:${timeframe}`]: barsRes,
            }));
          } else {
            setLoadError(`No se pudieron cargar velas para ${cleanTicker} (${timeframe}).`);
          }
          setLoading(false);
        }
      } catch {
        if (isCurrent()) {
          setLoadError(`Sincronización interrumpida para ${cleanTicker} (${timeframe}).`);
          setLoading(false);
        }
      } finally {
        if (isCurrent()) setLoading(false);
      }
    };

    void load();
    return () => controller.abort();
  }, [cleanTicker, currentStockKey, timeframe, isArMarket]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        event.stopPropagation();
        setSelectorOpen((open) => !open);
        return;
      }
      if (
        event.key === '/' &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        (event.target as HTMLElement | null)?.tagName !== 'INPUT' &&
        (event.target as HTMLElement | null)?.tagName !== 'TEXTAREA' &&
        (event.target as HTMLElement | null)?.tagName !== 'SELECT'
      ) {
        event.preventDefault();
        event.stopPropagation();
        setSelectorOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const selectorItems: readonly StockDetailSelectorItem[] = useMemo(() => {
    const items: StockDetailSelectorItem[] = [];
    const seen = new Set<string>();

    const usSymbols = [...new Set(
      runtime.optionsUnderlyings
        .filter((meta) => meta.market === 'US' && meta.symbol !== 'GGAL')
        .map((meta) => meta.symbol),
    )];
    if (usSymbols.length === 0) {
      for (const usMeta of US_MARKET_DATA) {
        const selectionKey = `US:${usMeta.ticker}`;
        if (seen.has(selectionKey)) continue;
        seen.add(selectionKey);
        items.push({
          key: usMeta.ticker,
          selectionKey,
          ticker: usMeta.ticker,
          name: usMeta.name,
          category: 'US_STOCKS',
          categoryLabel: 'US Stocks',
          venue: 'OPRA',
          currency: 'USD',
          sector: usMeta.sector,
          price: Number.NaN,
          changePct: Number.NaN,
          ratio: null,
          cclImplicit: null,
        });
      }
    } else {
      for (const symbol of usSymbols) {
        const selectionKey = `US:${symbol}`;
        if (seen.has(selectionKey)) continue;
        seen.add(selectionKey);
        const meta = runtime.optionsUnderlyings.find((u) => u.symbol === symbol && u.market === 'US');
        const staticMeta = US_MARKET_DATA.find((u) => u.ticker === symbol);
        items.push({
          key: symbol,
          selectionKey,
          ticker: symbol,
          name: meta?.name ?? staticMeta?.name ?? symbol,
          category: 'US_STOCKS',
          categoryLabel: 'US Stocks',
          venue: 'OPRA',
          currency: 'USD',
          sector: meta?.sector ?? staticMeta?.sector ?? 'US Equity',
          price: Number.NaN,
          changePct: Number.NaN,
          ratio: null,
          cclImplicit: null,
        });
      }
    }

    const arLeader =
      runtime.overview?.mervalStocks.length && runtime.overview.mervalStocks.length > 0
        ? runtime.overview.mervalStocks
        : AR_STOCKS;
    for (const stock of arLeader) {
      const selectionKey = `AR:${stock.ticker}`;
      if (seen.has(selectionKey)) continue;
      seen.add(selectionKey);
      items.push({
        key: stock.ticker,
        selectionKey,
        ticker: stock.ticker,
        name: stock.name,
        category: 'PANEL_LIDER',
        categoryLabel: 'Panel Líder',
        venue: 'BYMA',
        currency: 'ARS',
        sector: stock.sector,
        price: Number.NaN,
        changePct: Number.NaN,
        ratio: normalizeFiniteOrNull(stock.adrRatio),
        cclImplicit: normalizeFiniteOrNull(stock.cclImplicit),
      });
    }

    const arGeneral =
      runtime.overview?.generalPanelStocks.length && runtime.overview.generalPanelStocks.length > 0
        ? runtime.overview.generalPanelStocks
        : AR_GENERAL_PANEL_STOCKS;
    for (const stock of arGeneral) {
      const selectionKey = `AR:${stock.ticker}`;
      if (seen.has(selectionKey)) continue;
      seen.add(selectionKey);
      items.push({
        key: stock.ticker,
        selectionKey,
        ticker: stock.ticker,
        name: stock.name,
        category: 'PANEL_GENERAL',
        categoryLabel: 'Panel General',
        venue: 'BYMA',
        currency: 'ARS',
        sector: stock.sector,
        price: Number.NaN,
        changePct: Number.NaN,
        ratio: normalizeFiniteOrNull(stock.adrRatio),
        cclImplicit: normalizeFiniteOrNull(stock.cclImplicit),
      });
    }

    for (const cedear of runtime.overview?.cedears ?? []) {
      const selectionKey = `AR:${cedear.ticker}`;
      if (seen.has(selectionKey)) continue;
      seen.add(selectionKey);
      items.push({
        key: cedear.ticker,
        selectionKey,
        ticker: cedear.ticker,
        name: cedear.name,
        category: 'CEDEARS',
        categoryLabel: 'CEDEARs',
        venue: 'BYMA',
        currency: 'ARS',
        sector: cedear.sector,
        price: Number.NaN,
        changePct: Number.NaN,
        ratio: normalizeFiniteOrNull(cedear.adrRatio),
        cclImplicit: normalizeFiniteOrNull(cedear.cclImplicit),
      });
    }

    return items.map((item) => {
      const quote = selectorOpen
        ? getAtomicMarketQuote(item.currency === 'ARS' ? 'AR' : 'US', item.ticker)
        : null;
      const staticPrice =
        item.currency === 'ARS'
          ? [...AR_STOCKS, ...AR_GENERAL_PANEL_STOCKS].find((stock) => stock.ticker === item.ticker)?.last
          : US_MARKET_DATA.find((stock) => stock.ticker === item.ticker)?.price;
      const cedearPrice = runtime.overview?.cedears.find((stock) => stock.ticker === item.ticker)?.last;
      const overviewPrice =
        runtime.overview?.mervalStocks.find((stock) => stock.ticker === item.ticker)?.last ??
        runtime.overview?.generalPanelStocks.find((stock) => stock.ticker === item.ticker)?.last;
      const staticChange =
        item.currency === 'ARS'
          ? [...AR_STOCKS, ...AR_GENERAL_PANEL_STOCKS].find((stock) => stock.ticker === item.ticker)?.deltaPct
          : US_MARKET_DATA.find((stock) => stock.ticker === item.ticker)?.deltaPct;
      return {
        ...item,
        price: quote?.price ?? normalizeFiniteOrNull(cedearPrice ?? overviewPrice ?? staticPrice) ?? Number.NaN,
        changePct: quote?.changePct ?? normalizeFiniteOrNull(staticChange) ?? Number.NaN,
      };
    });
  }, [selectorOpen, runtime.optionsUnderlyings, runtime.overview]);

  const stockDetail = isArMarket
    ? (runtime.stockDetailsBySymbol[cleanTicker] as ArStockDetailWithOverlays | undefined)
    : undefined;
  // Pieza 50.3: lectura aislada por mercado (`AR:<ticker>` vs `US:<ticker>`).
  const arOptions = isArMarket
    ? getLiveOptionsForUnderlying(runtime, `AR:${cleanTicker}`)
    : undefined;
  const usSnap = !isArMarket ? runtime.usSnapshotsBySymbol[cleanTicker] : undefined;
  const usBarsResp = !isArMarket ? usBarsByKey[`${currentStockKey}:${timeframe}`] : undefined;
  // Pieza 38 / 43: velas reales ARS servidas por /api/bars?market=AR (fallback automático a 1D).
  const arBarsResp = isArMarket ? arBarsByKey[`${currentStockKey}:${timeframe}`] : undefined;
  const arBars1dResp = isArMarket ? arBarsByKey[`${currentStockKey}:1D`] : undefined;

  const contextInfo: StockContextBannerInfo = useMemo(() => {
    const cclMed = normalizeFiniteOrNull(runtime.overview?.cclMedian);
    if (isArMarket) {
      const ovStock =
        stockDetail?.stock ??
        runtime.overview?.mervalStocks.find((stock) => stock.ticker === cleanTicker) ??
        runtime.overview?.generalPanelStocks.find((stock) => stock.ticker === cleanTicker) ??
        null;
      const cedearStock = runtime.overview?.cedears.find((stock) => stock.ticker === cleanTicker) ?? null;
      const arMeta =
        AR_STOCKS.find((stock) => stock.ticker === cleanTicker) ??
        AR_GENERAL_PANEL_STOCKS.find((stock) => stock.ticker === cleanTicker);
      const lastDailyClose = stockDetail?.historicalBars.at(-1)?.close ?? null;
      const spot =
        normalizeFiniteOrNull(liveQuote?.price) ??
        normalizeFiniteOrNull(ovStock?.last ?? cedearStock?.last ?? lastDailyClose);
      const adrTickerRaw = ovStock?.adrTicker?.replace(/ US$/i, '').trim().toUpperCase() ?? null;
      const adrUsd = normalizeFiniteOrNull(ovStock?.adrPrice);
      const adrRatio = normalizeFiniteOrNull(ovStock?.adrRatio);
      const hasAdr = adrTickerRaw !== null && adrRatio !== null && adrRatio > 0;
      const impliedCcl =
        hasAdr && spot !== null && adrUsd !== null && adrRatio !== null
          ? (spot * adrRatio) / adrUsd
          : normalizeFiniteOrNull(ovStock?.cclImplicit ?? cedearStock?.cclImplicit);
      const theoreticalArs =
        hasAdr && adrUsd !== null && cclMed !== null && adrRatio !== null
          ? (adrUsd * cclMed) / adrRatio
          : null;
      const arbitrageGapPct =
        spot !== null && theoreticalArs !== null && theoreticalArs > 0
          ? ((spot / theoreticalArs) - 1) * 100
          : null;
      return {
        market: 'AR',
        ticker: cleanTicker,
        name: ovStock?.name ?? cedearStock?.name ?? arMeta?.name ?? cleanTicker,
        marketLabel: stockMode === 'ADR_USD' ? 'ADR · USD' : cedearStock !== null ? 'CEDEAR · BYMA' : 'BYMA 24hs',
        currencySymbol: 'ARS',
        spot,
        prevClose: normalizeFiniteOrNull(ovStock?.prevClose),
        changePct: normalizeFiniteOrNull(ovStock?.deltaPct ?? cedearStock?.deltaPct),
        dayLow: normalizeFiniteOrNull(ovStock?.low ?? cedearStock?.low),
        dayHigh: normalizeFiniteOrNull(ovStock?.high ?? cedearStock?.high),
        volumeCompact: normalizeFiniteOrNull(ovStock?.volumeM ?? cedearStock?.volumeM) !== null
          ? `$ ${fmtNum(ovStock?.volumeM ?? cedearStock?.volumeM, 1)} M`
          : '—',
        volRelative: normalizeFiniteOrNull(ovStock?.volMultiple ?? cedearStock?.volMultiple),
        feedStatus: stockDetail?.feedStatus ?? runtime.feedStatus ?? 'NO_DATA',
        intradayProvenanceNote: null,
        arHasAdr: hasAdr,
        adrUsTicker: adrTickerRaw,
        adrUsdPrice: adrUsd,
        adrRatio,
        impliedCcl,
        theoreticalArsPrice: theoreticalArs,
        arbitrageGapPct,
        arAssetType: stockDetail?.assetType ?? (cedearStock !== null ? 'CEDEAR' : 'STOCK'),
        bondTirPct: null,
        bondParityPct: null,
        marketCclMedian: cclMed,
        nbboBid: null,
        nbboAsk: null,
        nbboBidSize: null,
        nbboAskSize: null,
        nbboSpreadPct: null,
        cedearTicker: null,
        cedearRatio: null,
        cedearArsPrice: null,
        cedearCclMismatchPct: null,
      };
    }

    const usMeta = US_MARKET_DATA.find((stock) => stock.ticker === cleanTicker);
    const selectorMeta = runtime.optionsUnderlyings.find((meta) => meta.symbol === cleanTicker && meta.market === 'US');
    const snapQuote = usSnap?.marketContext?.unifiedQuotes?.find((q) => q.ticker.toUpperCase() === cleanTicker);
    const snapExtBadge = formatExtendedSessionBadge(liveQuote?.sessionPhase ?? snapQuote?.sessionPhase ?? null);
    const snapSpot =
      (snapExtBadge !== null ? (liveQuote?.extendedPrice ?? snapQuote?.extendedPrice) : null) ??
      snapQuote?.price ??
      usSnap?.envelope?.snapshot?.metrics?.spot ??
      usSnap?.envelope?.metrics?.spot?.value ??
      usBarsResp?.bars.at(-1)?.close ??
      null;
    const liveUsPrice =
      snapExtBadge !== null
        ? (liveQuote?.extendedPrice ?? liveQuote?.price)
        : liveQuote?.price;
    const spot =
      normalizeFiniteOrNull(liveUsPrice) ??
      normalizeFiniteOrNull(snapSpot);
    const matchedCedear = runtime.overview?.cedears.find((cedear) => {
      const targetUs = cedear.adrTicker?.replace(/ US$/i, '').trim().toUpperCase();
      return targetUs === cleanTicker || cedear.ticker === cleanTicker;
    });
    const cedPrice = normalizeFiniteOrNull(matchedCedear?.last);
    const cedRatio = normalizeFiniteOrNull(matchedCedear?.adrRatio);
    const impliedCcl =
      cedPrice !== null && spot !== null && cedRatio !== null
        ? (cedPrice * cedRatio) / spot
        : normalizeFiniteOrNull(matchedCedear?.cclImplicit);
    const cclMismatchPct =
      impliedCcl !== null && cclMed !== null && cclMed > 0 ? ((impliedCcl / cclMed) - 1) * 100 : null;
    const volM = normalizeFiniteOrNull(snapQuote?.volumeM);
    const volumeCompact =
      volM !== null
        ? `US$ ${fmtNum(volM, 1)} M`
        : normalizeFiniteOrNull(snapQuote?.volume) !== null
          ? `${fmtNum((snapQuote?.volume ?? Number.NaN) / 1_000_000, 2)} M acc.`
          : '—';
    const rawChangePct =
      snapExtBadge !== null
        ? (liveQuote?.extendedChangePct ?? snapQuote?.extendedChangePct ?? liveQuote?.changePct ?? snapQuote?.changePct)
        : (liveQuote?.changePct ?? snapQuote?.changePct);
    return {
      market: 'US',
      ticker: cleanTicker,
      name: selectorMeta?.name ?? usMeta?.name ?? cleanTicker,
      marketLabel: `US · ${stockExchange}${stockRoute?.isAdr === true ? ' · ADR' : ''}`,
      currencySymbol: 'USD',
      spot,
      prevClose: normalizeFiniteOrNull(liveQuote?.previousClose ?? snapQuote?.previousClose),
      changePct: normalizeFiniteOrNull(rawChangePct),
      dayLow: normalizeFiniteOrNull(liveQuote?.dayLow ?? snapQuote?.dayLow),
      dayHigh: normalizeFiniteOrNull(liveQuote?.dayHigh ?? snapQuote?.dayHigh),
      volumeCompact,
      volRelative: normalizeFiniteOrNull(usMeta?.volMultiple),
      feedStatus: usSnap?.feedMode ?? (usBarsResp ? 'LIVE' : 'NO_DATA'),
      intradayProvenanceNote: null,
      arHasAdr: false,
      adrUsTicker: cleanTicker,
      adrUsdPrice: spot,
      adrRatio: null,
      impliedCcl,
      theoreticalArsPrice: null,
      arbitrageGapPct: null,
      arAssetType: 'US_STOCK',
      bondTirPct: null,
      bondParityPct: null,
      marketCclMedian: cclMed,
      nbboBid: normalizeFiniteOrNull(snapQuote?.bid),
      nbboAsk: normalizeFiniteOrNull(snapQuote?.ask),
      nbboBidSize: normalizeFiniteOrNull(snapQuote?.bidSize),
      nbboAskSize: normalizeFiniteOrNull(snapQuote?.askSize),
      nbboSpreadPct: normalizeFiniteOrNull(snapQuote?.spreadPct),
      cedearTicker: matchedCedear?.ticker ?? null,
      cedearRatio: cedRatio,
      cedearArsPrice: cedPrice,
      cedearCclMismatchPct: cclMismatchPct,
    };
  }, [cleanTicker, isArMarket, liveQuote, stockExchange, stockMode, stockRoute?.isAdr, runtime.feedStatus, runtime.optionsUnderlyings, runtime.overview, stockDetail, usBarsResp, usSnap]);

  const isArIntradayFallbackActive =
    isArMarket &&
    timeframe !== '1D' &&
    (arBarsResp?.effectiveTimeframe === '1D' ||
      arFallbackNotice !== null ||
      ((arBarsResp?.bars.length ?? 0) === 0 &&
        ((arBars1dResp?.bars.length ?? 0) > 0 || (stockDetail?.historicalBars.length ?? 0) > 0)));
  const effectiveChartTimeframe: TerminalTimeframe = isArIntradayFallbackActive ? '1D' : timeframe;
  const arFallbackInfoText = isArIntradayFallbackActive
    ? `BYMA sin histórico ${timeframe.toUpperCase()} · mostrando 1D real`
    : null;

  const mergedArOrderBook = useMemo(() => {
    if (!isArMarket) return null;
    return mergeArLiveOrderBookDto(
      stockDetail?.orderBook5Levels ?? null,
      liveOrderBook,
      cleanTicker,
      contextInfo.spot,
      contextInfo.dayHigh,
      contextInfo.dayLow,
      contextInfo.prevClose,
    );
  }, [
    cleanTicker,
    contextInfo.dayHigh,
    contextInfo.dayLow,
    contextInfo.prevClose,
    contextInfo.spot,
    isArMarket,
    liveOrderBook,
    stockDetail?.orderBook5Levels,
  ]);

  const headerBook = useMemo(() => {
    const rawBook = isArMarket ? mergedArOrderBook : null;
    if (rawBook === null) return null;
    return normalizeStockDetailOrderBook(rawBook.bids, rawBook.asks, 5);
  }, [isArMarket, mergedArOrderBook]);

  const headerQuotes = useMemo(() => {
    return normalizeStockDetailHeaderQuotes({
      quoteBid: isArMarket ? (stockDetail?.stock?.bid ?? null) : contextInfo.nbboBid,
      quoteBidSize: isArMarket ? null : contextInfo.nbboBidSize,
      quoteAsk: isArMarket ? (stockDetail?.stock?.ask ?? null) : contextInfo.nbboAsk,
      quoteAskSize: isArMarket ? null : contextInfo.nbboAskSize,
      book: isArMarket ? headerBook : null,
    });
  }, [
    contextInfo.nbboAsk,
    contextInfo.nbboAskSize,
    contextInfo.nbboBid,
    contextInfo.nbboBidSize,
    headerBook,
    isArMarket,
    stockDetail?.stock?.ask,
    stockDetail?.stock?.bid,
  ]);

  const effectiveClickedAnchorTimeSec =
    avwapMode === 'CLICKED_CANDLE' ? clickedAnchorTimeSec : null;

  const chartBundle: PanoramicChartBundle = useMemo(() => {
    let rawBars: readonly MinimalOhlcvBar[] = [];
    let intradayUnavailableReason: string | null = null;
    let benchBars1d: readonly MinimalOhlcvBar[] = [];
    let ivAtmPct: number | null = null;

    if (isArMarket) {
      // Pieza 38 / 43: 1D prioriza /api/bars?market=AR; cualquier timeframe
      // intradiario BYMA sin velas locales cae automáticamente a 1D real sin
      // dejar el canvas en negro ni disparar un error rojo destructivo.
      if (timeframe === '1D') {
        rawBars =
          arBarsResp !== undefined && arBarsResp.bars.length > 0
            ? arBarsResp.bars
            : (stockDetail?.historicalBars ?? []);
      } else if (arBarsResp !== undefined && arBarsResp.bars.length > 0) {
        rawBars = arBarsResp.bars;
      } else if (arBars1dResp !== undefined && arBars1dResp.bars.length > 0) {
        rawBars = arBars1dResp.bars;
      } else if ((stockDetail?.historicalBars.length ?? 0) > 0) {
        rawBars = stockDetail?.historicalBars ?? [];
      } else {
        intradayUnavailableReason = `Sin histórico disponible para ${cleanTicker} (${timeframe})`;
      }
      benchBars1d = dedupAndSortBars(stockDetail?.benchmarkBars1d ?? []);
      const frontExpiry = arOptions?.expiries.find((expiry) => expiry.ivAtm !== null && expiry.ivAtm > 0) ?? arOptions?.expiries[0];
      if (frontExpiry?.ivAtm != null && Number.isFinite(frontExpiry.ivAtm)) ivAtmPct = frontExpiry.ivAtm * 100;
    } else {
      rawBars = usBarsResp?.bars ?? [];
      benchBars1d = dedupAndSortBars(usSnap?.benchmarkBars1d ?? []);
      const ivDecimal =
        usSnap?.volSurfaceSummary?.frontSlice?.ivAtm ??
        usSnap?.volSurfaceSummary?.iv30d ??
        usSnap?.envelope?.snapshot?.metrics?.iv30d ??
        null;
      if (ivDecimal !== null && Number.isFinite(ivDecimal) && ivDecimal > 0) ivAtmPct = ivDecimal * 100;
    }

    const bars = dedupAndSortBars(rawBars);
    const closes = bars.map((bar) => bar.close);
    const isIntraday = effectiveChartTimeframe !== '1D';
    const ema9 = computeEmaSeriesPure(closes, 9).map(normalizeFiniteOrNull);
    const ema21 = computeEmaSeriesPure(closes, 21).map(normalizeFiniteOrNull);
    const ema50 = computeEmaSeriesPure(closes, 50).map(normalizeFiniteOrNull);
    const ema200 = computeEmaSeriesPure(closes, 200).map(normalizeFiniteOrNull);
    const sessionVwap = computeSessionVwapPure(bars, isIntraday, isArMarket ? -10_800 : -14_400).map(normalizeFiniteOrNull);
    const lastClosedEma =
      bars.length >= 2
        ? {
            9: ema9[bars.length - 2] ?? null,
            21: ema21[bars.length - 2] ?? null,
            50: ema50[bars.length - 2] ?? null,
            200: ema200[bars.length - 2] ?? null,
          }
        : { 9: null, 21: null, 50: null, 200: null };

    const anchorTimeSec = resolvePanoramicAnchorTime(
      bars,
      avwapMode,
      isArMarket ? 'AR' : 'US',
      effectiveClickedAnchorTimeSec,
    );
    const anchorIndex =
      avwapMode === 'CLICKED_CANDLE'
        ? bars.findIndex((bar) => bar.time === anchorTimeSec)
        : bars.findIndex((bar) => bar.time === anchorTimeSec);
    const avwapSeries = computeAnchoredVwapPure(bars, anchorIndex).map(normalizeFiniteOrNull);
    const avwapBands = alignVwapPointsToBars(bars, computeAnchoredVwapSeries(barsToGgalChartPoints(bars), anchorTimeSec ?? Number.NaN));

    const rv30Decimal = isArMarket
      ? stockDetail?.realizedVol20d ?? null
      : usSnap?.envelope?.snapshot?.metrics?.realizedVolAnnualized ?? usSnap?.envelope?.metrics?.realizedVol20d?.value ?? null;
    const rv30Pct = rv30Decimal !== null && Number.isFinite(rv30Decimal) && rv30Decimal > 0 ? rv30Decimal * 100 : null;
    const vrpPct = ivAtmPct !== null && rv30Pct !== null ? ivAtmPct - rv30Pct : null;
    const modeLabel = PANORAMIC_AVWAP_MODES.find((mode) => mode.id === avwapMode)?.label ?? '—';

    return {
      bars,
      ema9,
      ema21,
      ema50,
      ema200,
      lastClosedEma,
      sessionVwap,
      avwapMode: 'MONTH_START',
      avwapSeries,
      avwapUpper1: avwapBands.upper1,
      avwapLower1: avwapBands.lower1,
      avwapUpper2: avwapBands.upper2,
      avwapLower2: avwapBands.lower2,
      avwapAnchorAvailable: anchorIndex >= 0,
      avwapAnchorModeLabel: modeLabel,
      benchmarkBars1d: benchBars1d,
      ivAtmPct,
      rv30Pct,
      vrpPct,
      barsAvailable: bars.length > 0 && intradayUnavailableReason === null,
      intradayUnavailableReason,
    };
  }, [arBars1dResp, arBarsResp, arOptions, avwapMode, cleanTicker, effectiveChartTimeframe, effectiveClickedAnchorTimeSec, isArMarket, stockDetail, timeframe, usBarsResp, usSnap]);

  const keyLevels: ChartKeyLevels = useMemo(() => {
    const atrSeries = chartBundle.bars.length > 14 ? computeWilderAtrPure(chartBundle.bars, 14) : [];
    const fallbackAtr = normalizeFiniteOrNull(atrSeries.at(-1));
    if (isArMarket) {
      const engines = stockDetail?.institutionalEngines;
      const exposure = arOptions?.exposureSummary;
      return {
        poc: normalizeFiniteOrNull(engines?.volumeProfile?.poc),
        vah: normalizeFiniteOrNull(engines?.volumeProfile?.vah),
        val: normalizeFiniteOrNull(engines?.volumeProfile?.val),
        callWall: normalizeFiniteOrNull(exposure?.callWallStrike),
        putWall: normalizeFiniteOrNull(exposure?.putWallStrike),
        zeroGamma: normalizeFiniteOrNull(exposure?.gammaFlipSpot),
        atr14: normalizeFiniteOrNull(engines?.atr14) ?? fallbackAtr,
        nakedPocs: (engines?.nakedPocs?.activeNakedPocs ?? [])
          .filter((poc): poc is { readonly sessionDate: string; readonly sessionPoc: number } => poc.sessionPoc !== null)
          .map((poc) => ({ sessionDate: poc.sessionDate, price: poc.sessionPoc })),
        fvgs: engines?.fvgs?.activeFvgs ?? [],
        orderBlocks: engines?.orderBlocks?.freshOrderBlocks ?? [],
      };
    }
    const engines = usSnap?.terminalEngines;
    const exposure = usSnap?.exposureSummary;
    return {
      poc: normalizeFiniteOrNull(engines?.volumeProfile?.poc),
      vah: normalizeFiniteOrNull(engines?.volumeProfile?.vah),
      val: normalizeFiniteOrNull(engines?.volumeProfile?.val),
      callWall: normalizeFiniteOrNull(exposure?.callWallStrike),
      putWall: normalizeFiniteOrNull(exposure?.putWallStrike),
      zeroGamma: normalizeFiniteOrNull(exposure?.gammaFlipSpot),
      atr14: normalizeFiniteOrNull(engines?.atr14d) ?? fallbackAtr,
      nakedPocs: (engines?.nakedPocs?.activeNakedPocs ?? [])
        .filter((poc): poc is { readonly sessionDate: string; readonly sessionPoc: number } => poc.sessionPoc !== null)
        .map((poc) => ({ sessionDate: poc.sessionDate, price: poc.sessionPoc })),
      fvgs: engines?.fvgs?.activeFvgs ?? [],
      orderBlocks: engines?.orderBlocks?.freshOrderBlocks ?? [],
    };
  }, [arOptions, chartBundle.bars, isArMarket, stockDetail, usSnap]);

  const { gexProfileStrikes, expectedMoveInfo } = useMemo(() => {
    const spot = contextInfo.spot;
    if (isArMarket) {
      const exposure = arOptions?.exposureSummary;
      const byStrike: readonly GexStrikeProfileItem[] = (exposure?.byStrike ?? []).map((strike) => ({
        strike: strike.strike,
        callOi: normalizeFiniteOrNull(strike.callOi),
        putOi: normalizeFiniteOrNull(strike.putOi),
        callGex: normalizeFiniteOrNull(strike.callGex),
        putGex: normalizeFiniteOrNull(strike.putGex),
        netGex: normalizeFiniteOrNull(strike.netGex),
      }));
      const days = exposure?.expectedMoveDays ?? stockDetail?.nextExpiry?.daysToExpiry ?? null;
      const ivDecimal = chartBundle.ivAtmPct !== null ? chartBundle.ivAtmPct / 100 : null;
      let moveInfo: ExpectedMoveOverlayInfo | null = null;
      if (spot !== null && spot > 0 && exposure?.expectedMoveAbs != null && exposure.expectedMoveAbs > 0) {
        moveInfo = {
          expiryCode: exposure.expectedMoveExpiryCode ?? stockDetail?.nextExpiry?.expiryCode ?? null,
          daysToExpiry: days,
          ivAtmDecimal: ivDecimal,
          oneSigmaAbs: exposure.expectedMoveAbs,
          oneSigmaPct: exposure.expectedMovePct !== null ? exposure.expectedMovePct * 100 : (exposure.expectedMoveAbs / spot) * 100,
          upper1Sigma: spot + exposure.expectedMoveAbs,
          lower1Sigma: Math.max(0, spot - exposure.expectedMoveAbs),
        };
      } else if (spot !== null && ivDecimal !== null && days !== null && days > 0) {
        const bounds = computeExpectedMoveBounds(spot, ivDecimal, days);
        if (Number.isFinite(bounds.oneSigmaAbs)) {
          moveInfo = {
            expiryCode: stockDetail?.nextExpiry?.expiryCode ?? null,
            daysToExpiry: days,
            ivAtmDecimal: ivDecimal,
            oneSigmaAbs: bounds.oneSigmaAbs,
            oneSigmaPct: bounds.oneSigmaPct,
            upper1Sigma: bounds.upper1Sigma,
            lower1Sigma: bounds.lower1Sigma,
          };
        }
      }
      return { gexProfileStrikes: byStrike, expectedMoveInfo: moveInfo };
    }

    const exposure = usSnap?.exposureSummary;
    const byStrike: readonly GexStrikeProfileItem[] = (exposure?.byStrike ?? []).map((strike) => ({
      strike: strike.strike,
      callOi: normalizeFiniteOrNull(strike.callOi),
      putOi: normalizeFiniteOrNull(strike.putOi),
      callGex: normalizeFiniteOrNull(strike.callGex),
      putGex: normalizeFiniteOrNull(strike.putGex),
      netGex: normalizeFiniteOrNull(strike.netGex),
    }));
    const frontSlice = usSnap?.volSurfaceSummary?.frontSlice;
    const moveAbs = exposure?.expectedMove?.straddleMove ?? exposure?.expectedMove?.formulaMove ?? null;
    const movePct = exposure?.expectedMove?.straddleMovePct ?? exposure?.expectedMove?.formulaMovePct ?? null;
    const moveInfo: ExpectedMoveOverlayInfo | null =
      spot !== null && spot > 0 && moveAbs !== null && moveAbs > 0
        ? {
            expiryCode: frontSlice?.expirationDate ?? null,
            daysToExpiry: frontSlice?.timeToExpiryDays ?? null,
            ivAtmDecimal: frontSlice?.ivAtm ?? null,
            oneSigmaAbs: moveAbs,
            oneSigmaPct: movePct !== null ? movePct * 100 : (moveAbs / spot) * 100,
            upper1Sigma: spot + moveAbs,
            lower1Sigma: Math.max(0, spot - moveAbs),
          }
        : null;
    return { gexProfileStrikes: byStrike, expectedMoveInfo: moveInfo };
  }, [arOptions, chartBundle.ivAtmPct, contextInfo.spot, isArMarket, stockDetail, usSnap]);

  const executionDeck: StockExecutionDeckData = useMemo(() => {
    if (isArMarket) {
      return {
        market: 'AR',
        ticker: cleanTicker,
        spot: contextInfo.spot,
        atr14: keyLevels.atr14,
        orderBook24h: mergedArOrderBook,
        orderBookCi: stockDetail?.orderBookCi ?? null,
        rofexFrontContract: stockDetail?.rofexFrontContract ?? null,
        confluenceClusters: stockDetail?.institutionalEngines?.confluenceClusters ?? null,
        relativeStrength: stockDetail?.institutionalEngines?.relativeStrength ?? null,
        mtfSummary: null,
        nextExpiry: stockDetail?.nextExpiry
          ? {
              expiryCode: stockDetail.nextExpiry.expiryCode,
              expirationDate: stockDetail.nextExpiry.expirationDate,
              daysToExpiry: stockDetail.nextExpiry.daysToExpiry,
            }
          : null,
        marketCclMedian: contextInfo.marketCclMedian,
        currencySymbol: 'ARS',
      };
    }

    const usNbboBook =
      contextInfo.nbboBid !== null || contextInfo.nbboAsk !== null
        ? {
            symbol: cleanTicker,
            marketSymbol: `${cleanTicker} · NBBO`,
            settlement: 'T+1 US',
            marketState: contextInfo.feedStatus,
            source: contextInfo.nbboBid !== null || contextInfo.nbboAsk !== null ? 'TRADIER_WS_NBBO' : 'NO_DATA',
            asOfUtcSec: usSnap?.asOfUtcSec ?? 0,
            bids: contextInfo.nbboBid !== null ? [{ price: contextInfo.nbboBid, size: contextInfo.nbboBidSize ?? 0 }] : [],
            asks: contextInfo.nbboAsk !== null ? [{ price: contextInfo.nbboAsk, size: contextInfo.nbboAskSize ?? 0 }] : [],
            bestBid: contextInfo.nbboBid,
            bestAsk: contextInfo.nbboAsk,
            mid: contextInfo.nbboBid !== null && contextInfo.nbboAsk !== null ? 0.5 * (contextInfo.nbboBid + contextInfo.nbboAsk) : null,
            spreadArs: contextInfo.nbboBid !== null && contextInfo.nbboAsk !== null ? contextInfo.nbboAsk - contextInfo.nbboBid : null,
            spreadPct: contextInfo.nbboSpreadPct,
            bidDepthSize: contextInfo.nbboBidSize,
            askDepthSize: contextInfo.nbboAskSize,
            vwapBid5: null,
            vwapAsk5: null,
            vwapBook5: null,
            obi5: contextInfo.nbboBidSize !== null && contextInfo.nbboAskSize !== null && contextInfo.nbboBidSize + contextInfo.nbboAskSize > 0
              ? (contextInfo.nbboBidSize - contextInfo.nbboAskSize) / (contextInfo.nbboBidSize + contextInfo.nbboAskSize)
              : null,
            last: contextInfo.spot,
            open: null,
            high: contextInfo.dayHigh,
            low: contextInfo.dayLow,
            close: contextInfo.prevClose,
            settlementPrice: null,
            nominalVolume: null,
          }
        : null;
    const frontSlice = usSnap?.volSurfaceSummary?.frontSlice;
    const engines = usSnap?.terminalEngines;
    const mtf = usSnap?.microstructure?.mtf;
    return {
      market: 'US',
      ticker: cleanTicker,
      spot: contextInfo.spot,
      atr14: keyLevels.atr14,
      orderBook24h: usNbboBook,
      orderBookCi: null,
      rofexFrontContract: null,
      confluenceClusters: engines?.confluenceClusters ?? null,
      relativeStrength: engines?.relativeStrength ?? null,
      mtfSummary: mtf
        ? {
            regime: mtf.effectiveMacroRegime ?? '—',
            setupStatus: mtf.setupStatus ?? '—',
            close5m: mtf.close5m ?? null,
            ema21_15m: mtf.ema21_15m ?? null,
            sma50_4h: mtf.sma50_4h ?? null,
            sma200_1d: mtf.sma200_1d ?? null,
          }
        : null,
      nextExpiry: frontSlice
        ? (() => {
            const dteEt = calendarDteEt(
              frontSlice.expirationDate,
              (usSnap?.asOfUtcSec ?? Math.floor(Date.now() / 1000)) * 1_000,
            );
            return {
              expiryCode: frontSlice.expirationDate,
              expirationDate: frontSlice.expirationDate,
              daysToExpiry: Number.isFinite(dteEt)
                ? dteEt
                : Math.max(0, Math.round(frontSlice.timeToExpiryDays)),
            };
          })()
        : null,
      marketCclMedian: contextInfo.marketCclMedian,
      currencySymbol: 'USD',
    };
  }, [cleanTicker, contextInfo, isArMarket, keyLevels.atr14, mergedArOrderBook, stockDetail, usSnap]);

  const handleToggleOverlay = useCallback((key: keyof OverlayVisibilityState) => {
    setOverlays((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const handleToggleHighlight = useCallback((id: Exclude<HighlightLevelId, null>) => {
    setHighlightedLevel((prev) => (prev === id ? null : id));
  }, []);

  const handleAnchorCandleClick = useCallback((timeSec: number) => {
    setClickedAnchorTimeSec((prev) =>
      resolveAvwapClickAnchor(avwapModeRef.current, timeSec, prev),
    );
  }, []);

  const handleGetMainLogicalRange = useCallback(() => {
    return getMainLogicalRangeRef.current?.() ?? null;
  }, []);

  const handleMainRangeSync = useCallback((range: LogicalRangeAlias | null) => {
    if (range) lowerLogicalRef.current?.(range);
  }, []);
  const handleLowerRangeSync = useCallback((range: LogicalRangeAlias | null) => {
    if (range) mainLogicalRef.current?.(range);
  }, []);
  const handleMainCrosshairSync = useCallback((time: number | null) => {
    lowerCrosshairRef.current?.(time);
  }, []);
  const handleLowerCrosshairSync = useCallback((time: number | null) => {
    mainCrosshairRef.current?.(time);
  }, []);

  const currentCategory: StockDetailCategory = useMemo(() => {
    if (selectorItems.some((item) => item.selectionKey === currentStockKey && item.category === 'PANEL_LIDER')) return 'PANEL_LIDER';
    if (selectorItems.some((item) => item.selectionKey === currentStockKey && item.category === 'PANEL_GENERAL')) return 'PANEL_GENERAL';
    if (selectorItems.some((item) => item.selectionKey === currentStockKey && item.category === 'CEDEARS')) return 'CEDEARS';
    return 'US_STOCKS';
  }, [currentStockKey, selectorItems]);

  const currentBadge = isArMarket
    ? stockMode === 'ADR_USD'
      ? 'ADR · USD'
      : currentCategory === 'CEDEARS'
        ? 'CEDEAR · BYMA'
        : currentCategory === 'PANEL_LIDER'
          ? 'LÍDER · BYMA'
          : 'GENERAL · BYMA'
    : stockExchange === 'NASDAQ'
      ? 'NASDAQ'
      : stockExchange === 'NYSE'
        ? 'NYSE'
        : stockExchange === 'AMEX'
          ? 'AMEX'
          : stockRoute?.isAdr === true
            ? 'ADR'
            : 'US';

  const usExtendedBadge = !isArMarket
    ? formatExtendedSessionBadge(
        liveQuote?.sessionPhase ??
          usSnap?.marketContext?.unifiedQuotes?.find((q) => q.ticker.toUpperCase() === cleanTicker)?.sessionPhase ??
          null,
      )
    : null;
  const rangePct = rangePositionPct(contextInfo.spot, contextInfo.dayLow, contextInfo.dayHigh);
  const optionsEnabled = contextInfo.market === 'US' || cleanTicker === 'GGAL';
  const rawLocalSymbol = tickerRaw.replace(/^(?:AR|US):/, '');
  const dualAdr = dualAdrSymbol(rawLocalSymbol);
  const canToggleAdrMode = dualAdr !== null;

  return (
    <div className="flex flex-col gap-3 pb-6 text-[#F0F2FA]">
      {/* Header ejecutivo unificado */}
      <section className="rounded-[12px] border border-[#1C1C24] bg-[#111116] px-3 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={onBackToMonitor}
              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[#252532] bg-[#0A0A0D] px-2.5 py-1.5 text-[11px] font-semibold text-[#9CA3AF] transition-colors hover:border-[#2E3446] hover:text-white cursor-pointer"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Monitor
            </button>
            <button
              type="button"
              onClick={() => setSelectorOpen(true)}
              title="Selector unificado · Ctrl+K o /"
              className="group flex min-w-0 items-center gap-2 rounded-[10px] border border-transparent px-2 py-1 transition-colors hover:border-[#2E3446] hover:bg-[#161A25] cursor-pointer"
            >
              <CompanyLogo ticker={cleanTicker} name={contextInfo.name} size="lg" />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5">
                  <span className="font-mono-num text-[17px] font-extrabold text-white">{cleanTicker}</span>
                  <span className="rounded-full border border-[#252532] bg-[#0A0A0D] px-1.5 py-0.5 font-mono-num text-[9.5px] text-[#9CA3AF]">
                    {currentBadge}
                  </span>
                  {canToggleAdrMode && (
                    <button
                      type="button"
                      onClick={() =>
                        onSelectTicker(
                          stockMode === 'ADR_USD'
                            ? `AR:${rawLocalSymbol}`
                            : `US:${dualAdr}`,
                        )
                      }
                      title={stockMode === 'ADR_USD' ? 'Ver BYMA (ARS)' : 'Ver ADR (USD)'}
                      className="rounded-full border border-[#8B7CF6]/45 bg-[#8B7CF6]/10 px-1.5 py-0.5 font-mono-num text-[9.5px] font-semibold text-[#C4B5FD] transition-colors hover:bg-[#8B7CF6]/20 cursor-pointer"
                    >
                      {stockMode === 'ADR_USD' ? 'BYMA' : 'ADR'}
                    </button>
                  )}
                </span>
                <span className="block max-w-[280px] truncate text-[11.5px] text-[#9CA3AF]">{contextInfo.name}</span>
              </span>
              <Keyboard className="h-3.5 w-3.5 text-[#6D7282] transition-colors group-hover:text-[#8B7CF6]" />
            </button>
          </div>

          <div className="flex min-w-[280px] flex-1 flex-wrap items-center gap-4">
            <div>
              <div className="font-mono-num text-[24px] font-extrabold leading-none tracking-tight text-white">
                <span
                  className="rounded px-1 tabular-nums"
                  style={{
                    backgroundColor:
                      liveHeaderFlash === null
                        ? 'transparent'
                        : liveHeaderFlash === 'up'
                          ? 'rgba(34,197,94,0.15)'
                          : 'rgba(239,68,68,0.15)',
                  }}
                >
                  {Number.isFinite(contextInfo.spot) ? fmtNum(contextInfo.spot, 2) : '—'}
                </span>
              </div>
              <div className={`mt-0.5 flex items-center gap-1.5 font-mono-num text-[12px] font-semibold ${contextInfo.changePct != null && contextInfo.changePct >= 0 ? 'text-[#22C55E]' : 'text-[#F23645]'}`}>
                {usExtendedBadge !== null && (
                  <span className="rounded px-1 py-0.2 font-mono-num text-[9px] font-bold tracking-wider bg-[#F5B544]/15 text-[#F5B544] border border-[#F5B544]/35">
                    {usExtendedBadge}
                  </span>
                )}
                <span>
                  {contextInfo.changePct != null
                    ? `${contextInfo.changePct >= 0 ? '+' : ''}${fmtNum(contextInfo.changePct, 2)} %`
                    : '—'}
                </span>
              </div>
            </div>

            <div className="min-w-[180px]">
              <div className="flex items-center justify-between font-mono-num text-[10px] text-[#787B86]">
                <span>Mín {contextInfo.dayLow !== null ? fmtNum(contextInfo.dayLow, 2) : '—'}</span>
                <span>Máx {contextInfo.dayHigh !== null ? fmtNum(contextInfo.dayHigh, 2) : '—'}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[#1C1C24]">
                {rangePct !== null && (
                  <div
                    className="h-full rounded-full bg-[#8B7CF6]"
                    style={{ width: `${String(rangePct)}%` }}
                  />
                )}
              </div>
              <div className="mt-0.5 text-center font-mono-num text-[9.5px] text-[#6D7282]">
                {rangePct !== null ? `${fmtNum(rangePct, 0)} % del rango` : 'Rango —'}
              </div>
            </div>

            <div className="font-mono-num text-[11px]">
              <div className="text-[#787B86]">Operado</div>
              <div className="text-[#F3F4F6]">{contextInfo.volumeCompact}</div>
            </div>
            <div className="font-mono-num text-[11px]">
              <div className="text-[#787B86]">Vol. Relativo</div>
              <div className="text-[#F3F4F6]">
                {contextInfo.volRelative !== null ? `${fmtNum(contextInfo.volRelative, 2)}x` : '—'}
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {liveQuote !== null && liveClock !== null ? (
              <span
                className={`rounded-full border px-2 py-1 font-mono-num text-[10px] font-semibold ${
                  usExtendedBadge !== null
                    ? 'border-[#F5B544]/40 bg-[#F5B544]/10 text-[#F5B544]'
                    : 'border-[#22C55E]/35 bg-[#22C55E]/10 text-[#22C55E]'
                }`}
              >
                {usExtendedBadge !== null ? `● ${usExtendedBadge} ${liveClock}` : `● Tiempo real ${liveClock}`}
              </span>
            ) : (
              <span className="rounded-full border border-[#F5B544]/35 bg-[#F5B544]/10 px-2 py-1 font-mono-num text-[10px] font-semibold text-[#F5B544]">
                ● CIERRE EOD
              </span>
            )}
            <button
              type="button"
              disabled={!optionsEnabled}
              onClick={() => onGoToOptions(cleanTicker)}
              title={optionsEnabled ? 'Ir a Opciones' : 'Opciones habilitadas solo para US Stocks y GGAL'}
              className={`inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[11.5px] font-bold transition-colors ${
                optionsEnabled
                  ? 'bg-[#8B7CF6] text-white hover:bg-[#7A6AE8] cursor-pointer'
                  : 'cursor-not-allowed bg-[#16161D] text-[#525870]'
              }`}
            >
              <Zap className="h-3.5 w-3.5" />
              Opciones
            </button>
          </div>
        </div>

        <div className="mt-2.5 grid grid-cols-2 gap-2 border-t border-[#1C1C24] pt-2.5 lg:grid-cols-4">
          <ContextCard
            label={isArMarket ? 'L2 / L1 BYMA' : 'NBBO'}
            value={`BID ${formatHeaderSideQuote(
              headerQuotes.bid,
              headerQuotes.bidSize,
              (n) => fmtNum(n, 2),
              (n) => fmtNum(n, 0),
            )} · ASK ${formatHeaderSideQuote(
              headerQuotes.ask,
              headerQuotes.askSize,
              (n) => fmtNum(n, 2),
              (n) => fmtNum(n, 0),
            )}`}
            hint={
              isArMarket
                ? mergedArOrderBook?.source ?? stockDetail?.orderBook5Levels?.source ?? '—'
                : headerQuotes.bidSize !== null || headerQuotes.askSize !== null
                  ? `x${headerQuotes.bidSize !== null ? fmtNum(headerQuotes.bidSize, 0) : '—'} / x${headerQuotes.askSize !== null ? fmtNum(headerQuotes.askSize, 0) : '—'}`
                  : 'NBBO'
            }
          />
          <ContextCard
            label="Spread"
            value={
              Number.isFinite(headerQuotes.spreadPct)
                ? `${fmtPct(headerQuotes.spreadPct, 3)}${
                    Number.isFinite(headerQuotes.spreadAbs)
                      ? ` (${isArMarket ? '$' : 'US$'} ${fmtNum(headerQuotes.spreadAbs, 2)})`
                      : ''
                  }`
                : contextInfo.nbboSpreadPct !== null
                  ? fmtPct(contextInfo.nbboSpreadPct, 3)
                  : '—'
            }
            hint={isArMarket ? stockDetail?.orderBook5Levels?.settlement ?? '—' : 'NBBO'}
          />
          <ContextCard
            label={isArMarket ? 'Equivalencia ADR' : 'Equivalencia CEDEAR'}
            value={
              isArMarket
                ? contextInfo.arHasAdr
                  ? `${contextInfo.adrUsTicker ?? '—'} · ${contextInfo.adrRatio !== null ? `${fmtNum(contextInfo.adrRatio, 0)}:1` : '—'}`
                  : '—'
                : contextInfo.cedearTicker !== null
                  ? `${contextInfo.cedearTicker} · ${contextInfo.cedearRatio !== null ? `${fmtNum(contextInfo.cedearRatio, 0)}:1` : '—'}`
                  : '—'
            }
            hint={
              isArMarket
                ? contextInfo.impliedCcl !== null ? `CCL ${fmtNum(contextInfo.impliedCcl, 2)}` : '—'
                : contextInfo.cedearArsPrice !== null ? `ARS ${fmtNum(contextInfo.cedearArsPrice, 2)}` : '—'
            }
          />
          <ContextCard
            label="Desfase CCL"
            value={
              isArMarket
                ? contextInfo.arbitrageGapPct !== null ? fmtPct(contextInfo.arbitrageGapPct, 2) : '—'
                : contextInfo.cedearCclMismatchPct !== null ? fmtPct(contextInfo.cedearCclMismatchPct, 2) : '—'
            }
            hint={`CCL ${contextInfo.marketCclMedian !== null ? fmtNum(contextInfo.marketCclMedian, 2) : '—'}`}
          />
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-[#1C1C24] pt-2.5">
          {(
            [
              { id: 'POC', label: 'POC', value: keyLevels.poc },
              { id: 'VAH', label: 'VAH', value: keyLevels.vah },
              { id: 'VAL', label: 'VAL', value: keyLevels.val },
              { id: 'CALL_WALL', label: 'Call Wall', value: keyLevels.callWall },
              { id: 'PUT_WALL', label: 'Put Wall', value: keyLevels.putWall },
              { id: 'ZERO_GAMMA', label: 'Zero-Gamma', value: keyLevels.zeroGamma },
              { id: 'ATR14', label: 'ATR(14)', value: keyLevels.atr14 },
            ] as const
          ).map((level) => (
            <button
              key={level.id}
              type="button"
              onClick={() => setHighlightedLevel((prev) => (prev === level.id ? null : level.id))}
              className={`rounded-full border px-2 py-1 font-mono-num text-[10px] transition-colors cursor-pointer ${
                highlightedLevel === level.id
                  ? 'border-[#8B7CF6] bg-[#8B7CF6]/15 text-white'
                  : 'border-[#232733] bg-[#0A0A0D] text-[#9CA3AF] hover:border-[#2E3446] hover:text-white'
              }`}
            >
              {level.label}: {level.value !== null ? fmtNum(level.value, 2) : '—'}
            </button>
          ))}
        </div>
      </section>

      {/* Gráfico panorámico + toolbar externa */}
      <section className="overflow-hidden rounded-[12px] border border-[#1C1C24] bg-[#0A0A0D]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1C1C24] bg-[#111116] px-3 py-2">
          <div className="flex flex-wrap items-center gap-1">
            {CHART_TIMEFRAMES.map((tf) => (
              <button
                key={tf.id}
                type="button"
                onClick={() => setTimeframe(tf.id)}
                className={`rounded-[6px] px-2 py-1 font-mono-num text-[11px] font-semibold transition-colors cursor-pointer ${
                  timeframe === tf.id
                    ? 'bg-[#8B7CF6] text-white'
                    : 'bg-[#161622] text-[#8E95B3] hover:bg-[#1E1E2E] hover:text-white'
                }`}
              >
                {tf.label}
              </button>
            ))}
            {loading && <span className="ml-1 font-mono-num text-[10px] text-[#8B7CF6]">Sincronizando…</span>}
            {arFallbackInfoText !== null && (
              <span className="ml-1 inline-flex items-center rounded-full border border-[#F5B544]/35 bg-[#F5B544]/10 px-2 py-0.5 font-mono-num text-[10px] font-semibold text-[#F5B544]">
                {arFallbackInfoText}
              </span>
            )}
            {!chartBundle.barsAvailable && loadError !== null && (
              <span className="ml-1 font-mono-num text-[10px] text-[#F23645]">{loadError}</span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <select
              aria-label="Anclaje AVWAP"
              value={avwapMode}
              onChange={(event) => {
                setAvwapMode(event.target.value as PanoramicAvwapAnchorMode);
                if (event.target.value !== 'CLICKED_CANDLE') setClickedAnchorTimeSec(null);
              }}
              className="rounded border border-[#252536] bg-[#11111A] px-2 py-1 font-mono-num text-[10px] text-[#CBD0E4] outline-none"
            >
              {PANORAMIC_AVWAP_MODES.map((mode) => (
                <option key={mode.id} value={mode.id}>{mode.label}</option>
              ))}
            </select>
            <ToolbarChip active={overlays.emas} label="EMA 9/21/50/200" onClick={() => handleToggleOverlay('emas')} />
            <ToolbarChip
              active={overlays.sessionVwap && effectiveChartTimeframe !== '1D'}
              disabled={effectiveChartTimeframe === '1D'}
              label={effectiveChartTimeframe === '1D' ? 'VWAP (solo intradiario)' : 'VWAP'}
              onClick={() => handleToggleOverlay('sessionVwap')}
            />
            <ToolbarChip active={overlays.avwap} label={`AVWAP · ${chartBundle.avwapAnchorModeLabel}`} onClick={() => handleToggleOverlay('avwap')} />
            <ToolbarChip active={showAvwapBands} label="AVWAP ±1σ/±2σ" onClick={() => setShowAvwapBands((visible) => !visible)} />
            <ToolbarChip active={overlays.volumeProfile} label="POC/VAH/VAL" onClick={() => handleToggleOverlay('volumeProfile')} />
            <ToolbarChip active={overlays.optionWalls} label="Walls" onClick={() => handleToggleOverlay('optionWalls')} />
          </div>
        </div>

        <PanoramicPriceChart
          ticker={currentStockKey}
          market={contextInfo.market}
          providerSymbol={cleanTicker}
          bundle={chartBundle}
          timeframe={effectiveChartTimeframe}
          overlays={overlays}
          showAvwapBands={showAvwapBands}
          currencySymbol={contextInfo.currencySymbol}
          keyLevels={keyLevels}
          highlightedLevel={highlightedLevel}
          onAnchorCandleClick={handleAnchorCandleClick}
          onLogicalRangeSync={handleMainRangeSync}
          onCrosshairTimeSync={handleMainCrosshairSync}
          externalLogicalRangeRef={mainLogicalRef}
          externalCrosshairTimeRef={mainCrosshairRef}
          getLogicalRangeRef={getMainLogicalRangeRef}
        />
      </section>

      <SyncedLowerPaneChart
        ticker={cleanTicker}
        market={contextInfo.market}
        timeframe={effectiveChartTimeframe}
        mode={lowerMode}
        onChangeMode={setLowerMode}
        bundle={chartBundle}
        onLogicalRangeSync={handleLowerRangeSync}
        onCrosshairTimeSync={handleLowerCrosshairSync}
        externalLogicalRangeRef={lowerLogicalRef}
        externalCrosshairTimeRef={lowerCrosshairRef}
        getMainVisibleLogicalRange={handleGetMainLogicalRange}
      />

      <section className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
        <ExecutionBottomDeck
          deck={executionDeck}
          keyLevels={keyLevels}
          onHighlightLevel={handleToggleHighlight}
          onOpenOrderTicket={onOpenOrderTicket}
          onGoToOptions={onGoToOptions}
        />
        <div className="rounded-[12px] border border-[#1C1C24] bg-[#111116] p-1">
          <GexStrikeProfileChart
            ticker={cleanTicker}
            spot={contextInfo.spot}
            currencySymbol={contextInfo.currencySymbol}
            strikes={gexProfileStrikes}
            expectedMove={expectedMoveInfo}
            keyLevels={keyLevels}
            mapper={null}
            hideHeader
          />
        </div>
      </section>

      <StockDetailSymbolSelector
        open={selectorOpen}
        onClose={() => setSelectorOpen(false)}
        onSelect={onSelectTicker}
        selectedTicker={currentStockKey}
        items={selectorItems}
        status={runtime.optionsUnderlyingsStatus}
        selectedName={contextInfo.name}
        selectedPrice={contextInfo.spot ?? Number.NaN}
        selectedChangePct={contextInfo.changePct ?? Number.NaN}
        selectedFlash={liveHeaderFlash}
      />
    </div>
  );
};

const ContextCard: React.FC<{
  readonly label: string;
  readonly value: string;
  readonly hint: string;
}> = ({ label, value, hint }) => (
  <div className="rounded-[10px] border border-[#1C1C24] bg-[#0A0A0D] px-3 py-2">
    <div className="text-[10px] uppercase tracking-wider text-[#6B7280]">{label}</div>
    <div className="mt-0.5 font-mono-num text-[13px] font-bold text-[#F3F4F6]">{value}</div>
    <div className="truncate font-mono-num text-[10px] text-[#787B86]">{hint}</div>
  </div>
);

const ToolbarChip: React.FC<{
  readonly active: boolean;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onClick: () => void;
}> = ({ active, disabled = false, label, onClick }) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    className={`rounded-[6px] border px-2 py-1 text-[11px] font-medium transition-colors ${
      disabled
        ? 'cursor-not-allowed border-[#1D1D29] bg-[#111118] text-[#525870]'
        : active
          ? 'border-[#8B7CF6]/60 bg-[#8B7CF6]/20 text-white cursor-pointer'
          : 'border-[#252536] bg-[#14141F] text-[#848BA8] hover:border-[#3A3A54] hover:text-white cursor-pointer'
    }`}
  >
    {label}
  </button>
);

function resolvePanoramicTimeframeSec(timeframe: TerminalTimeframe): number {
  if (timeframe === '1D') return 86_400;
  if (timeframe === '4h') return 14_400;
  if (timeframe === '1h') return 3_600;
  if (timeframe === '15m') return 900;
  if (timeframe === '5m') return 300;
  return 60;
}

const PanoramicPriceChart: React.FC<{
  readonly ticker: string;
  readonly market: 'AR' | 'US';
  readonly providerSymbol: string;
  readonly bundle: PanoramicChartBundle;
  readonly timeframe: TerminalTimeframe;
  readonly overlays: OverlayVisibilityState;
  readonly showAvwapBands: boolean;
  readonly currencySymbol: 'ARS' | 'USD';
  readonly keyLevels: ChartKeyLevels;
  readonly highlightedLevel: HighlightLevelId;
  readonly onAnchorCandleClick: (timeSec: number) => void;
  readonly onLogicalRangeSync: (range: LogicalRangeAlias | null) => void;
  readonly onCrosshairTimeSync: (timeSec: number | null) => void;
  readonly externalLogicalRangeRef: React.MutableRefObject<((range: LogicalRangeAlias) => void) | null>;
  readonly externalCrosshairTimeRef: React.MutableRefObject<((timeSec: number | null) => void) | null>;
  readonly getLogicalRangeRef: React.MutableRefObject<(() => LogicalRangeAlias | null) | null>;
}> = ({
  ticker,
  market,
  providerSymbol,
  bundle,
  timeframe,
  overlays,
  showAvwapBands,
  currencySymbol,
  keyLevels,
  highlightedLevel,
  onAnchorCandleClick,
  onLogicalRangeSync,
  onCrosshairTimeSync,
  externalLogicalRangeRef,
  externalCrosshairTimeRef,
  getLogicalRangeRef,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const crosshairLegendRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const emaRefs = useRef<readonly ISeriesApi<'Line'>[]>([]);
  const vwapRef = useRef<ISeriesApi<'Line'> | null>(null);
  const avwapRefs = useRef<readonly ISeriesApi<'Line'>[]>([]);
  const priceLineSlotsRef = useRef<{
    readonly poc: IPriceLine;
    readonly vah: IPriceLine;
    readonly val: IPriceLine;
    readonly callWall: IPriceLine;
    readonly putWall: IPriceLine;
    readonly zeroGamma: IPriceLine;
  } | null>(null);
  const suppressingRangeEventRef = useRef(false);
  const pendingExternalRangeRef = useRef<LogicalRangeAlias | null>(null);
  const latestBarsRef = useRef(bundle.bars);
  const anchorClickCbRef = useRef(onAnchorCandleClick);
  const crosshairCbRef = useRef(onCrosshairTimeSync);
  const rangeCbRef = useRef(onLogicalRangeSync);
  const lastFitStateRef = useRef<{
    key: string | null;
    barCount: number;
    firstBarTime: number | null;
    lastBarTime: number | null;
  }>({ key: null, barCount: 0, firstBarTime: null, lastBarTime: null });
  const lastRenderedBarsRef = useRef<readonly MinimalOhlcvBar[]>([]);
  const formingBarRef = useRef<{
    timeSec: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  } | null>(null);
  const emaBaseBeforeFormingRef = useRef<{
    9: number | null;
    21: number | null;
    50: number | null;
    200: number | null;
  }>({ 9: null, 21: null, 50: null, 200: null });
  const emaEndOfFormingRef = useRef<{
    9: number | null;
    21: number | null;
    50: number | null;
    200: number | null;
  }>({ 9: null, 21: null, 50: null, 200: null });
  const pendingLiveTickRef = useRef<{
    readonly price: number;
    readonly timeSec: number;
    readonly volumeDelta: number | null;
    readonly exactBar: LiveBarUpdateEvent['formingBar'];
  } | null>(null);
  const tickRafIdRef = useRef<number | null>(null);
  const lastLiveQuoteVolumeRef = useRef<number | null>(null);

  latestBarsRef.current = bundle.bars;
  anchorClickCbRef.current = onAnchorCandleClick;
  crosshairCbRef.current = onCrosshairTimeSync;
  rangeCbRef.current = onLogicalRangeSync;

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const chart = createChart(element, {
      layout: {
        background: { type: ColorType.Solid, color: '#08080D' },
        textColor: '#8B92AD',
        fontFamily: '"Geist Mono", ui-monospace, monospace',
        fontSize: 11,
      },
      grid: { vertLines: { color: '#14141F' }, horzLines: { color: '#14141F' } },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#535A7A', style: LineStyle.Dashed, width: 1, labelBackgroundColor: '#1E1E2E' },
        horzLine: { color: '#535A7A', style: LineStyle.Dashed, width: 1, labelBackgroundColor: '#1E1E2E' },
      },
      rightPriceScale: { borderColor: '#1C1C24', scaleMargins: { top: 0.07, bottom: 0.08 } },
      timeScale: {
        borderColor: '#1C1C24',
        timeVisible: true,
        secondsVisible: false,
        enableConflation: true,
        conflationThresholdFactor: 1.0,
        precomputeConflationOnInit: true,
        precomputeConflationPriority: 'background',
      },
      autoSize: false,
      width: Math.max(1, Math.floor(element.clientWidth)),
      height: Math.max(1, Math.floor(element.clientHeight)),
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: '#2EDC7E',
      downColor: '#FF5468',
      borderUpColor: '#2EDC7E',
      borderDownColor: '#FF5468',
      wickUpColor: '#2EDC7E',
      wickDownColor: '#FF5468',
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
    const emaSeries = [
      chart.addSeries(LineSeries, { color: '#38BDF8', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
      chart.addSeries(LineSeries, { color: '#8B7CF6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
      chart.addSeries(LineSeries, { color: '#F5B544', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
      chart.addSeries(LineSeries, { color: '#FF5468', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
    ];
    const vwap = chart.addSeries(LineSeries, { color: '#FACC15', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
    const avwapSeries = [
      chart.addSeries(LineSeries, { color: '#C084FC', lineWidth: 2, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false }),
      chart.addSeries(LineSeries, { color: 'rgba(192,132,252,0.45)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
      chart.addSeries(LineSeries, { color: 'rgba(192,132,252,0.45)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
      chart.addSeries(LineSeries, { color: 'rgba(192,132,252,0.22)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
      chart.addSeries(LineSeries, { color: 'rgba(192,132,252,0.22)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
    ];

    priceLineSlotsRef.current = {
      poc: candles.createPriceLine({
        price: 0,
        color: '#FACC15',
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        lineVisible: false,
        axisLabelVisible: false,
        title: 'POC',
      }),
      vah: candles.createPriceLine({
        price: 0,
        color: '#60A5FA',
        lineWidth: 2,
        lineStyle: LineStyle.SparseDotted,
        lineVisible: false,
        axisLabelVisible: false,
        title: 'VAH',
      }),
      val: candles.createPriceLine({
        price: 0,
        color: '#60A5FA',
        lineWidth: 2,
        lineStyle: LineStyle.SparseDotted,
        lineVisible: false,
        axisLabelVisible: false,
        title: 'VAL',
      }),
      callWall: candles.createPriceLine({
        price: 0,
        color: '#2EDC7E',
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        lineVisible: false,
        axisLabelVisible: false,
        title: 'CALL WALL',
      }),
      putWall: candles.createPriceLine({
        price: 0,
        color: '#FF5468',
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        lineVisible: false,
        axisLabelVisible: false,
        title: 'PUT WALL',
      }),
      zeroGamma: candles.createPriceLine({
        price: 0,
        color: '#A78BFA',
        lineWidth: 2,
        lineStyle: LineStyle.Dotted,
        lineVisible: false,
        axisLabelVisible: false,
        title: 'ZERO-GAMMA',
      }),
    };

    chartRef.current = chart;
    candleRef.current = candles;
    emaRefs.current = emaSeries;
    vwapRef.current = vwap;
    avwapRefs.current = avwapSeries;

    const handleRangeChange = (range: LogicalRangeAlias | null): void => {
      if (
        !shouldEmitLogicalRangeSync(
          range,
          suppressingRangeEventRef.current,
          pendingExternalRangeRef.current,
        )
      ) {
        return;
      }
      rangeCbRef.current(range);
    };
    const handleCrosshairMove = (param: {
      readonly time?: Time;
      readonly seriesData: ReadonlyMap<unknown, unknown>;
    }): void => {
      const legendEl = crosshairLegendRef.current;
      if (legendEl) {
        const pt = param.seriesData.get(candles) as
          | { readonly open?: number; readonly high?: number; readonly low?: number; readonly close?: number }
          | undefined;
        if (
          param.time !== undefined &&
          pt !== undefined &&
          typeof pt.close === 'number' &&
          Number.isFinite(pt.close)
        ) {
          legendEl.textContent = `O ${fmtNum(pt.open ?? Number.NaN, 2)}  H ${fmtNum(pt.high ?? Number.NaN, 2)}  L ${fmtNum(pt.low ?? Number.NaN, 2)}  C ${fmtNum(pt.close, 2)}`;
        } else {
          legendEl.textContent = '';
        }
      }
      if (param.time !== undefined && typeof param.time === 'number') {
        crosshairCbRef.current(param.time);
      } else {
        crosshairCbRef.current(null);
      }
    };
    const handleChartClick = (param: { readonly time?: Time }): void => {
      if (param.time !== undefined && typeof param.time === 'number' && Number.isFinite(param.time)) {
        anchorClickCbRef.current(param.time);
      }
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleRangeChange);
    chart.subscribeCrosshairMove(handleCrosshairMove);
    chart.subscribeClick(handleChartClick);

    let resizeRafId: number | null = null;
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      const boxSize = entry?.contentBoxSize?.[0];
      const inlineSize = boxSize?.inlineSize ?? containerRef.current?.clientWidth ?? 0;
      const blockSize = boxSize?.blockSize ?? containerRef.current?.clientHeight ?? 0;
      const w = Math.floor(inlineSize);
      const h = Math.floor(blockSize);
      if (w <= 0 || h <= 0) return;
      if (resizeRafId !== null) window.cancelAnimationFrame(resizeRafId);
      resizeRafId = window.requestAnimationFrame(() => {
        resizeRafId = null;
        chart.resize(w, h);
      });
    });
    resizeObserver.observe(element);

    externalLogicalRangeRef.current = (range) => {
      const current = chart.timeScale().getVisibleLogicalRange();
      if (!shouldApplyExternalLogicalRange(current, range)) return;
      suppressingRangeEventRef.current = true;
      pendingExternalRangeRef.current = range;
      try {
        chart.timeScale().setVisibleLogicalRange(range);
      } finally {
        window.requestAnimationFrame(() => {
          suppressingRangeEventRef.current = false;
          pendingExternalRangeRef.current = null;
        });
      }
    };
    getLogicalRangeRef.current = () => chart.timeScale().getVisibleLogicalRange();
    externalCrosshairTimeRef.current = (timeSec) => {
      if (timeSec === null) {
        chart.clearCrosshairPosition();
        return;
      }
      const match = latestBarsRef.current.find((bar) => bar.time === timeSec);
      if (!match || chart.timeScale().timeToIndex(timeSec as UTCTimestamp, false) === null) return;
      try {
        chart.setCrosshairPosition(match.close, timeSec as UTCTimestamp, candles);
      } catch {
        // Ignorar si el rango de escala aún no está inicializado
      }
    };

    return () => {
      if (resizeRafId !== null) window.cancelAnimationFrame(resizeRafId);
      if (tickRafIdRef.current !== null) {
        window.cancelAnimationFrame(tickRafIdRef.current);
        tickRafIdRef.current = null;
      }
      resizeObserver.disconnect();
      chart.unsubscribeClick(handleChartClick);
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleRangeChange);
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      emaRefs.current = [];
      vwapRef.current = null;
      avwapRefs.current = [];
      priceLineSlotsRef.current = null;
      externalLogicalRangeRef.current = null;
      externalCrosshairTimeRef.current = null;
      getLogicalRangeRef.current = null;
      lastFitStateRef.current = { key: null, barCount: 0, firstBarTime: null, lastBarTime: null };
      lastRenderedBarsRef.current = [];
    };
  }, [externalCrosshairTimeRef, externalLogicalRangeRef, getLogicalRangeRef]);

  useEffect(() => {
    chartRef.current?.applyOptions({
      timeScale: { timeVisible: timeframe !== '1D', secondsVisible: false },
    });
  }, [timeframe]);

  // Carga histórica: setData únicamente cuando cambian símbolo, moneda, timeframe o dataset histórico.
  useEffect(() => {
    const chart = chartRef.current;
    const candles = candleRef.current;
    if (!chart || !candles) return;

    const firstBarTime = bundle.bars[0]?.time ?? null;
    const lastBar = bundle.bars[bundle.bars.length - 1];
    const lastBarTime = lastBar?.time ?? null;
    const nextKey = resolveChartFitKey(ticker, timeframe, bundle.barsAvailable, firstBarTime);
    const transition = resolveChartViewportTransition({
      previousKey: lastFitStateRef.current.key,
      nextKey,
      previousBarCount: lastFitStateRef.current.barCount,
      nextBarCount: bundle.bars.length,
      previousFirstBarTime: lastFitStateRef.current.firstBarTime,
      nextFirstBarTime: firstBarTime,
      previousLastBarTime: lastFitStateRef.current.lastBarTime,
      nextLastBarTime: lastBarTime,
    });
    lastFitStateRef.current = {
      key: nextKey,
      barCount: bundle.bars.length,
      firstBarTime,
      lastBarTime,
    };

    if (transition.updateMode === 'CLEAR' || !bundle.barsAvailable || bundle.bars.length === 0) {
      candles.setData([]);
      emaRefs.current.forEach((series) => series.setData([]));
      vwapRef.current?.setData([]);
      avwapRefs.current.forEach((series) => series.setData([]));
      lastRenderedBarsRef.current = [];
      formingBarRef.current = null;
      emaBaseBeforeFormingRef.current = { 9: null, 21: null, 50: null, 200: null };
      emaEndOfFormingRef.current = { 9: null, 21: null, 50: null, 200: null };
      return;
    }

    candles.setData(
      bundle.bars.map((bar) => ({
        time: bar.time as UTCTimestamp,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      })),
    );

    const toLineData = (values: readonly (number | null)[]) =>
      bundle.bars
        .map((bar, index) => {
          const value = values[index];
          return value != null && Number.isFinite(value) ? { time: bar.time as UTCTimestamp, value } : null;
        })
        .filter((point): point is { time: UTCTimestamp; value: number } => point !== null);

    emaRefs.current[0]?.setData(toLineData(bundle.ema9));
    emaRefs.current[1]?.setData(toLineData(bundle.ema21));
    emaRefs.current[2]?.setData(toLineData(bundle.ema50));
    emaRefs.current[3]?.setData(toLineData(bundle.ema200));
    vwapRef.current?.setData(toLineData(bundle.sessionVwap));
    avwapRefs.current[0]?.setData(toLineData(bundle.avwapSeries));
    avwapRefs.current[1]?.setData(toLineData(bundle.avwapUpper1));
    avwapRefs.current[2]?.setData(toLineData(bundle.avwapLower1));
    avwapRefs.current[3]?.setData(toLineData(bundle.avwapUpper2));
    avwapRefs.current[4]?.setData(toLineData(bundle.avwapLower2));

    lastRenderedBarsRef.current = bundle.bars;
    formingBarRef.current = lastBar
      ? {
          timeSec: lastBar.time,
          open: lastBar.open,
          high: lastBar.high,
          low: lastBar.low,
          close: lastBar.close,
          volume: lastBar.volume,
        }
      : null;
    emaBaseBeforeFormingRef.current = {
      9: bundle.lastClosedEma?.[9] ?? null,
      21: bundle.lastClosedEma?.[21] ?? null,
      50: bundle.lastClosedEma?.[50] ?? null,
      200: bundle.lastClosedEma?.[200] ?? null,
    };
    const lastIdx = bundle.bars.length - 1;
    emaEndOfFormingRef.current = {
      9: lastIdx >= 0 ? (bundle.ema9[lastIdx] ?? null) : null,
      21: lastIdx >= 0 ? (bundle.ema21[lastIdx] ?? null) : null,
      50: lastIdx >= 0 ? (bundle.ema50[lastIdx] ?? null) : null,
      200: lastIdx >= 0 ? (bundle.ema200[lastIdx] ?? null) : null,
    };

    if (transition.shouldFitContent) {
      chart.timeScale().fitContent();
    }
  }, [bundle, ticker, timeframe]);

  // Visibilidad de overlays sin ejecutar setData().
  useEffect(() => {
    emaRefs.current.forEach((series) => series.applyOptions({ visible: overlays.emas }));
    vwapRef.current?.applyOptions({ visible: overlays.sessionVwap });
    avwapRefs.current[0]?.applyOptions({ visible: overlays.avwap });
    avwapRefs.current[1]?.applyOptions({ visible: overlays.avwap && showAvwapBands });
    avwapRefs.current[2]?.applyOptions({ visible: overlays.avwap && showAvwapBands });
    avwapRefs.current[3]?.applyOptions({ visible: overlays.avwap && showAvwapBands });
    avwapRefs.current[4]?.applyOptions({ visible: overlays.avwap && showAvwapBands });
  }, [overlays.emas, overlays.sessionVwap, overlays.avwap, showAvwapBands]);

  // IPriceLine persistentes actualizadas in-place con applyOptions.
  useEffect(() => {
    const slots = priceLineSlotsRef.current;
    if (!slots) return;
    const updateSlot = (
      pl: IPriceLine,
      enabled: boolean,
      price: number | null,
      title: string,
      highlighted: boolean,
    ): void => {
      if (!enabled || price === null || !Number.isFinite(price) || price <= 0) {
        pl.applyOptions({ price: 0, lineVisible: false, axisLabelVisible: false, title: '' });
        return;
      }
      pl.applyOptions({
        price,
        lineWidth: highlighted ? 3 : 2,
        lineVisible: true,
        axisLabelVisible: true,
        title,
      });
    };
    const prefix = currencySymbol === 'USD' ? 'US$' : '$';
    const hasBars = bundle.barsAvailable;
    updateSlot(slots.poc, hasBars && overlays.volumeProfile, keyLevels.poc, `POC ${prefix}${fmtNum(keyLevels.poc, 2)}`, highlightedLevel === 'POC');
    updateSlot(slots.vah, hasBars && overlays.volumeProfile, keyLevels.vah, 'VAH', highlightedLevel === 'VAH');
    updateSlot(slots.val, hasBars && overlays.volumeProfile, keyLevels.val, 'VAL', highlightedLevel === 'VAL');
    updateSlot(slots.callWall, hasBars && overlays.optionWalls, keyLevels.callWall, `CALL WALL ${prefix}${fmtNum(keyLevels.callWall, 2)}`, highlightedLevel === 'CALL_WALL');
    updateSlot(slots.putWall, hasBars && overlays.optionWalls, keyLevels.putWall, `PUT WALL ${prefix}${fmtNum(keyLevels.putWall, 2)}`, highlightedLevel === 'PUT_WALL');
    updateSlot(slots.zeroGamma, hasBars && overlays.optionWalls, keyLevels.zeroGamma, `ZERO-GAMMA ${prefix}${fmtNum(keyLevels.zeroGamma, 2)}`, highlightedLevel === 'ZERO_GAMMA');
  }, [bundle.barsAvailable, currencySymbol, highlightedLevel, keyLevels, overlays.optionWalls, overlays.volumeProfile]);

  // Bus imperativo 60 FPS en rAF: coalescing de ticks en ref y series.update() sin setState ni setData().
  useEffect(() => {
    pendingLiveTickRef.current = null;
    lastLiveQuoteVolumeRef.current = null;
    if (!bundle.barsAvailable) return;

    const tfSec = resolvePanoramicTimeframeSec(timeframe);
    const flushLiveTick = (): void => {
      tickRafIdRef.current = null;
      const pending = pendingLiveTickRef.current;
      pendingLiveTickRef.current = null;
      const currentForming = formingBarRef.current;
      const candles = candleRef.current;
      if (pending === null || currentForming === null || candles === null) return;

      let nextBar = currentForming;
      if (timeframe === '1m' && pending.exactBar !== null && pending.exactBar.time >= currentForming.timeSec) {
        if (pending.exactBar.time > currentForming.timeSec) {
          emaBaseBeforeFormingRef.current = { ...emaEndOfFormingRef.current };
        }
        nextBar = {
          timeSec: pending.exactBar.time,
          open: pending.exactBar.open,
          high: pending.exactBar.high,
          low: pending.exactBar.low,
          close: pending.exactBar.close,
          volume: pending.exactBar.volume,
        };
      } else {
        const projected = projectLiveCandle(
          currentForming,
          { price: pending.price, timeSec: pending.timeSec, volumeDelta: pending.volumeDelta },
          tfSec,
        );
        if (projected === null || projected.timeSec < currentForming.timeSec) return;
        if (projected.timeSec > currentForming.timeSec) {
          emaBaseBeforeFormingRef.current = { ...emaEndOfFormingRef.current };
        }
        nextBar = projected;
      }

      formingBarRef.current = nextBar;
      candles.update({
        time: nextBar.timeSec as UTCTimestamp,
        open: nextBar.open,
        high: nextBar.high,
        low: nextBar.low,
        close: nextBar.close,
      });

      const base = emaBaseBeforeFormingRef.current;
      const periods = [9, 21, 50, 200] as const;
      const nextEnd = { ...emaEndOfFormingRef.current };
      for (let i = 0; i < periods.length; i += 1) {
        const p = periods[i]!;
        const prevClosed = base[p];
        if (prevClosed === null || !Number.isFinite(prevClosed)) continue;
        const proj = projectLiveEma(prevClosed, nextBar.close, p);
        if (Number.isFinite(proj)) {
          nextEnd[p] = proj;
          emaRefs.current[i]?.update({ time: nextBar.timeSec as UTCTimestamp, value: proj });
        }
      }
      emaEndOfFormingRef.current = nextEnd;
    };

    const scheduleFlush = (): void => {
      if (tickRafIdRef.current !== null) return;
      tickRafIdRef.current = window.requestAnimationFrame(flushLiveTick);
    };

    const unsubQuote = subscribeAtomicQuoteValue(market, providerSymbol, (quote) => {
      if (!Number.isFinite(quote.price) || quote.price <= 0) return;
      const prevVol = lastLiveQuoteVolumeRef.current;
      const volumeDelta =
        quote.volume !== null && prevVol !== null ? Math.max(0, quote.volume - prevVol) : null;
      if (quote.volume !== null) lastLiveQuoteVolumeRef.current = quote.volume;
      const timeSec =
        quote.asOfUtcSec !== null && Number.isInteger(quote.asOfUtcSec)
          ? quote.asOfUtcSec
          : Math.floor(Date.now() / 1_000);
      pendingLiveTickRef.current = {
        price: quote.price,
        timeSec,
        volumeDelta,
        exactBar: pendingLiveTickRef.current?.exactBar ?? null,
      };
      scheduleFlush();
    });

    const unsubBar = subscribeLiveBarUpdate(providerSymbol, (ev) => {
      const fb = ev.formingBar;
      if (fb === null || !Number.isFinite(fb.close) || fb.close <= 0) return;
      pendingLiveTickRef.current = {
        price: fb.close,
        timeSec: fb.time,
        volumeDelta: null,
        exactBar: timeframe === '1m' ? fb : null,
      };
      scheduleFlush();
    });

    return () => {
      unsubQuote();
      unsubBar();
      if (tickRafIdRef.current !== null) {
        window.cancelAnimationFrame(tickRafIdRef.current);
        tickRafIdRef.current = null;
      }
    };
  }, [bundle.barsAvailable, market, providerSymbol, timeframe]);

  return (
    <div className="relative h-[72vh] min-h-[560px] w-full">
      <div ref={containerRef} className="h-full w-full" />
      <div
        ref={crosshairLegendRef}
        className="pointer-events-none absolute left-3 top-2 z-20 rounded bg-[#08080D]/85 px-2 py-0.5 font-mono-num tabular-nums text-[11px] text-[#CBD5E1]"
      />
      {!bundle.barsAvailable && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#08080D]/90 px-6 text-center">
          <div>
            <div className="text-[13px] font-semibold text-[#E5E8F5]">{bundle.intradayUnavailableReason ?? 'Sin velas disponibles.'}</div>
            <div className="mt-1 text-[11px] text-[#7E85A3]">No se sintetizan velas sin fuente real.</div>
          </div>
        </div>
      )}
    </div>
  );
};
