import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { getMarketLiveClock, getMarketLiveQuote, useLivePriceFlash, useMarketFocusSymbol, useMarketLiveStream, useThrottledLiveValue } from '../api/useMarketLiveStream';
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

function projectEmaSeries(
  series: readonly (number | null)[],
  period: number,
  livePrice: number | null,
): readonly (number | null)[] {
  if (livePrice === null || !Number.isFinite(livePrice) || series.length < 2) return series;
  const lastClosedIdx = series.length - 2;
  const lastClosed = series[lastClosedIdx];
  if (lastClosed === null || lastClosed === undefined || !Number.isFinite(lastClosed)) return series;
  const projected = projectLiveEma(lastClosed, livePrice, period);
  if (!Number.isFinite(projected)) return series;
  return [...series.slice(0, -1), projected];
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
  const liveStream = useMarketLiveStream();
  const tickerRaw = ticker.trim().toUpperCase() || 'GGAL';

  const [selectorOpen, setSelectorOpen] = useState(false);
  const [timeframe, setTimeframe] = useState<TerminalTimeframe>('1D');  const [avwapMode, setAvwapMode] = useState<PanoramicAvwapAnchorMode>('MONTH_START');
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
  const [ar1mFallbackActive, setAr1mFallbackActive] = useState(false);
  const loadingRequestIdRef = useRef(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const mainLogicalRef = useRef<((range: LogicalRangeAlias) => void) | null>(null);
  const lowerLogicalRef = useRef<((range: LogicalRangeAlias) => void) | null>(null);
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

  const liveQuote = getMarketLiveQuote(liveStream, isArMarket ? 'AR' : 'US', cleanTicker);
  useMarketFocusSymbol(isArMarket ? null : cleanTicker);
  const liveClock = getMarketLiveClock(liveStream);
  const liveHeaderFlash = useLivePriceFlash(liveQuote?.price ?? null);
  const throttledLivePrice = useThrottledLiveValue(liveQuote?.price ?? Number.NaN, 1_000, currentStockKey);

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
    setAr1mFallbackActive(false);
    if (!hasOverviewRef.current) void refreshOverview();

    const isCurrent = (): boolean => requestId === loadingRequestIdRef.current && !controller.signal.aborted;

    const load = async (): Promise<void> => {
      try {
        if (isArMarket) {
          // Pieza 41: BYMA usa /api/bars?market=AR. En 1m la API resuelve 1D
          // sin intentar convertir velas ADR; el detalle no bloquea el gráfico.
          const requestTimeframe: TerminalTimeframe =
            timeframe === '1m' && !ar1mFallbackActive ? '1m' : timeframe;
          const barsPromise = requestTerminalBars(cleanTicker, requestTimeframe, {
            visibleBars: requestTimeframe === '1D' ? 1_250 : 1_000,
            market: 'AR',
            signal: controller.signal,
          });
          const detailPromise = requestStockDetail(cleanTicker, false, timeframe, controller.signal);
          let arBarsRes = await Promise.race([
            barsPromise,
            new Promise<UsTerminalBarsResponseDto | null>((resolve) => {
              setTimeout(() => resolve(null), 250);
            }),
          ]);
          if (!isCurrent()) return;
          if (arBarsRes === null && requestTimeframe === '1m') {
            // Fallback inmediato del camino 1m a 1D si el primer request no pintó.
            arBarsRes = await requestTerminalBars(cleanTicker, '1D', {
              visibleBars: 1_250,
              market: 'AR',
              signal: controller.signal,
            });
            if (!isCurrent()) return;
            if (arBarsRes !== null) setAr1mFallbackActive(true);
          }
          if (arBarsRes !== null) {
            setArBarsByKey((prev) => ({
              ...prev,
              [`${currentStockKey}:${timeframe}`]: arBarsRes,
            }));
          }
          setLoading(false);
          void requestOptionsChain(cleanTicker).catch(() => undefined);
          if (arBarsRes === null) {
            setLoadError(`No se pudieron cargar velas para ${cleanTicker} (${timeframe}).`);
          }
          void detailPromise.catch(() => undefined);
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
  }, [ar1mFallbackActive, cleanTicker, currentStockKey, timeframe, isArMarket]);

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
      const quote = getMarketLiveQuote(liveStream, item.currency === 'ARS' ? 'AR' : 'US', item.ticker);
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
  }, [liveStream, runtime.optionsUnderlyings, runtime.overview]);

  const stockDetail = isArMarket
    ? (runtime.stockDetailsBySymbol[cleanTicker] as ArStockDetailWithOverlays | undefined)
    : undefined;
  const arOptions = isArMarket ? runtime.optionsByUnderlying[cleanTicker] : undefined;
  const usSnap = !isArMarket ? runtime.usSnapshotsBySymbol[cleanTicker] : undefined;
  const usBarsResp = !isArMarket ? usBarsByKey[`${currentStockKey}:${timeframe}`] : undefined;
  // Pieza 38: velas reales ARS servidas por /api/bars?market=AR (primario en 1D).
  const arBarsResp = isArMarket ? arBarsByKey[`${currentStockKey}:${timeframe}`] : undefined;

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
      const spot = Number.isFinite(throttledLivePrice)
        ? throttledLivePrice
        : normalizeFiniteOrNull(ovStock?.last ?? cedearStock?.last ?? lastDailyClose);
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
    const quote = usSnap?.marketContext?.unifiedQuotes?.find((q) => q.ticker.toUpperCase() === cleanTicker);
    const snapSpot =
      quote?.price ??
      usSnap?.envelope?.snapshot?.metrics?.spot ??
      usSnap?.envelope?.metrics?.spot?.value ??
      usBarsResp?.bars.at(-1)?.close ??
      null;
    const spot = Number.isFinite(throttledLivePrice) ? throttledLivePrice : normalizeFiniteOrNull(snapSpot);
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
    const volM = normalizeFiniteOrNull(quote?.volumeM);
    const volumeCompact =
      volM !== null
        ? `US$ ${fmtNum(volM, 1)} M`
        : normalizeFiniteOrNull(quote?.volume) !== null
          ? `${fmtNum((quote?.volume ?? Number.NaN) / 1_000_000, 2)} M acc.`
          : '—';
    return {
      market: 'US',
      ticker: cleanTicker,
      name: selectorMeta?.name ?? usMeta?.name ?? cleanTicker,
      marketLabel: `US · ${stockExchange}${stockRoute?.isAdr === true ? ' · ADR' : ''}`,
      currencySymbol: 'USD',
      spot,
      prevClose: normalizeFiniteOrNull(quote?.previousClose),
      changePct: normalizeFiniteOrNull(quote?.changePct),
      dayLow: normalizeFiniteOrNull(quote?.dayLow),
      dayHigh: normalizeFiniteOrNull(quote?.dayHigh),
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
      nbboBid: normalizeFiniteOrNull(quote?.bid),
      nbboAsk: normalizeFiniteOrNull(quote?.ask),
      nbboBidSize: normalizeFiniteOrNull(quote?.bidSize),
      nbboAskSize: normalizeFiniteOrNull(quote?.askSize),
      nbboSpreadPct: normalizeFiniteOrNull(quote?.spreadPct),
      cedearTicker: matchedCedear?.ticker ?? null,
      cedearRatio: cedRatio,
      cedearArsPrice: cedPrice,
      cedearCclMismatchPct: cclMismatchPct,
    };
  }, [cleanTicker, isArMarket, stockExchange, stockMode, stockRoute?.isAdr, runtime.feedStatus, runtime.optionsUnderlyings, runtime.overview, stockDetail, throttledLivePrice, usBarsResp, usSnap]);

  const chartBundle: PanoramicChartBundle = useMemo(() => {
    let rawBars: readonly MinimalOhlcvBar[] = [];
    let intradayUnavailableReason: string | null = null;
    let benchBars1d: readonly MinimalOhlcvBar[] = [];
    let ivAtmPct: number | null = null;

    if (isArMarket) {
      // Pieza 38: 1D prioriza el histórico real ARS de /api/bars?market=AR
      // (hasta 1.250 ruedas); `historicalBars` del detalle AR queda como
      // respaldo si la petición de velas no respondió aún. El intradiario AR
      // sigue viniendo convertido desde el ADR US (MASSIVE_ADR_CONVERTED).
      if (timeframe === '1D') {
        rawBars =
          arBarsResp !== undefined && arBarsResp.bars.length > 0
            ? arBarsResp.bars
            : (stockDetail?.historicalBars ?? []);
      } else if (arBarsResp !== undefined && arBarsResp.bars.length > 0) {
        rawBars = arBarsResp.bars;
      } else intradayUnavailableReason = `Sin feed intradiario BYMA para ${cleanTicker} (${timeframe}) — disponible en 1D`;
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

    const bars0 = dedupAndSortBars(rawBars);
    // Pieza 41: proyecta solo OHLC del último trade real (sin volumen estimado)
    // sobre la vela abierta del timeframe visible; no reemplaza histórico.
    const lastHistoricalBar = bars0.at(-1) ?? null;
    const liveTickPrice = liveQuote?.price ?? null;
    const liveTickTimeSec = liveQuote?.asOfUtcSec ?? liveStream.lastServerTimeSec;
    const projectedLiveBar =
      lastHistoricalBar !== null &&
      liveTickPrice !== null &&
      Number.isFinite(liveTickPrice) &&
      liveTickTimeSec !== null &&
      Number.isInteger(liveTickTimeSec)
        ? projectLiveCandle(
            {
              timeSec: lastHistoricalBar.time,
              open: lastHistoricalBar.open,
              high: lastHistoricalBar.high,
              low: lastHistoricalBar.low,
              close: lastHistoricalBar.close,
              volume: lastHistoricalBar.volume,
            },
            {
              price: liveTickPrice,
              timeSec: liveTickTimeSec,
              volumeDelta: null,
            },
            timeframe === '1D' ? 86_400 : timeframe === '4h' ? 14_400 : timeframe === '1h' ? 3_600 : timeframe === '15m' ? 900 : timeframe === '5m' ? 300 : 60,
          )
        : null;
    const bars = projectedLiveBar === null
      ? bars0
      : [
          ...bars0.slice(0, -1),
          {
            time: projectedLiveBar.timeSec,
            open: projectedLiveBar.open,
            high: projectedLiveBar.high,
            low: projectedLiveBar.low,
            close: projectedLiveBar.close,
            volume: projectedLiveBar.volume,
          },
        ];
    const closes = bars.map((bar) => bar.close);
    const isIntraday = timeframe !== '1D';
    const spot = contextInfo.spot;
    const ema9 = projectEmaSeries(computeEmaSeriesPure(closes, 9).map(normalizeFiniteOrNull), 9, spot);
    const ema21 = projectEmaSeries(computeEmaSeriesPure(closes, 21).map(normalizeFiniteOrNull), 21, spot);
    const ema50 = projectEmaSeries(computeEmaSeriesPure(closes, 50).map(normalizeFiniteOrNull), 50, spot);
    const ema200 = projectEmaSeries(computeEmaSeriesPure(closes, 200).map(normalizeFiniteOrNull), 200, spot);
    const sessionVwap = computeSessionVwapPure(bars, isIntraday, isArMarket ? -10_800 : -14_400).map(normalizeFiniteOrNull);

    const anchorTimeSec = resolvePanoramicAnchorTime(bars, avwapMode, contextInfo.market, clickedAnchorTimeSec);
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
  }, [arBarsResp, arOptions, avwapMode, clickedAnchorTimeSec, cleanTicker, contextInfo.market, contextInfo.spot, isArMarket, liveQuote, liveStream.lastServerTimeSec, stockDetail, timeframe, usBarsResp, usSnap]);

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
        orderBook24h: stockDetail?.orderBook5Levels ?? null,
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
        ? {
            expiryCode: frontSlice.expirationDate,
            expirationDate: frontSlice.expirationDate,
            daysToExpiry: Math.round(frontSlice.timeToExpiryDays),
          }
        : null,
      marketCclMedian: contextInfo.marketCclMedian,
      currencySymbol: 'USD',
    };
  }, [cleanTicker, contextInfo, isArMarket, keyLevels.atr14, stockDetail, usSnap]);

  const handleToggleOverlay = useCallback((key: keyof OverlayVisibilityState) => {
    setOverlays((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const handleToggleHighlight = useCallback((id: Exclude<HighlightLevelId, null>) => {
    setHighlightedLevel((prev) => (prev === id ? null : id));
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
                  className="rounded px-1 transition-colors duration-[400ms]"
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
              <div className={`mt-0.5 font-mono-num text-[12px] font-semibold ${contextInfo.changePct != null && contextInfo.changePct >= 0 ? 'text-[#22C55E]' : 'text-[#F23645]'}`}>
                {contextInfo.changePct != null
                  ? `${contextInfo.changePct >= 0 ? '+' : ''}${fmtNum(contextInfo.changePct, 2)} %`
                  : '—'}
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
              <span className="rounded-full border border-[#22C55E]/35 bg-[#22C55E]/10 px-2 py-1 font-mono-num text-[10px] font-semibold text-[#22C55E]">
                ● Tiempo real {liveClock}
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
            value={
              isArMarket
                ? `${fmtNum(stockDetail?.orderBook5Levels?.bestBid ?? Number.NaN, 2)} / ${fmtNum(stockDetail?.orderBook5Levels?.bestAsk ?? Number.NaN, 2)}`
                : `${fmtNum(contextInfo.nbboBid ?? Number.NaN, 2)} / ${fmtNum(contextInfo.nbboAsk ?? Number.NaN, 2)}`
            }
            hint={isArMarket ? stockDetail?.orderBook5Levels?.source ?? '—' : `x${fmtNum(contextInfo.nbboBidSize ?? Number.NaN, 0)} / x${fmtNum(contextInfo.nbboAskSize ?? Number.NaN, 0)}`}
          />
          <ContextCard
            label="Spread %"
            value={
              contextInfo.nbboSpreadPct !== null
                ? fmtPct(contextInfo.nbboSpreadPct, 3)
                : stockDetail?.orderBook5Levels?.spreadPct != null
                  ? fmtPct(stockDetail.orderBook5Levels.spreadPct, 3)
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
            {loadError !== null && (
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
              active={overlays.sessionVwap && timeframe !== '1D'}
              disabled={timeframe === '1D'}
              label={timeframe === '1D' ? 'VWAP (solo intradiario)' : 'VWAP'}
              onClick={() => handleToggleOverlay('sessionVwap')}
            />
            <ToolbarChip active={overlays.avwap} label={`AVWAP · ${chartBundle.avwapAnchorModeLabel}`} onClick={() => handleToggleOverlay('avwap')} />
            <ToolbarChip active={showAvwapBands} label="AVWAP ±1σ/±2σ" onClick={() => setShowAvwapBands((visible) => !visible)} />
            <ToolbarChip active={overlays.volumeProfile} label="POC/VAH/VAL" onClick={() => handleToggleOverlay('volumeProfile')} />
            <ToolbarChip active={overlays.optionWalls} label="Walls" onClick={() => handleToggleOverlay('optionWalls')} />
          </div>
        </div>

        <PanoramicPriceChart
          bundle={chartBundle}
          timeframe={timeframe}
          overlays={overlays}
          showAvwapBands={showAvwapBands}
          currencySymbol={contextInfo.currencySymbol}
          keyLevels={keyLevels}
          highlightedLevel={highlightedLevel}
          onCrosshairTime={setClickedAnchorTimeSec}
          onLogicalRangeSync={handleMainRangeSync}
          onCrosshairTimeSync={handleMainCrosshairSync}
          externalLogicalRangeRef={mainLogicalRef}
          externalCrosshairTimeRef={mainCrosshairRef}
        />
      </section>

      <SyncedLowerPaneChart
        ticker={cleanTicker}
        market={contextInfo.market}
        timeframe={timeframe}
        mode={lowerMode}
        onChangeMode={setLowerMode}
        bundle={chartBundle}
        onLogicalRangeSync={handleLowerRangeSync}
        onCrosshairTimeSync={handleLowerCrosshairSync}
        externalLogicalRangeRef={lowerLogicalRef}
        externalCrosshairTimeRef={lowerCrosshairRef}
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

const PanoramicPriceChart: React.FC<{
  readonly bundle: PanoramicChartBundle;
  readonly timeframe: TerminalTimeframe;
  readonly overlays: OverlayVisibilityState;
  readonly showAvwapBands: boolean;
  readonly currencySymbol: 'ARS' | 'USD';
  readonly keyLevels: ChartKeyLevels;
  readonly highlightedLevel: HighlightLevelId;
  readonly onCrosshairTime: (timeSec: number | null) => void;
  readonly onLogicalRangeSync: (range: LogicalRangeAlias | null) => void;
  readonly onCrosshairTimeSync: (timeSec: number | null) => void;
  readonly externalLogicalRangeRef: React.MutableRefObject<((range: LogicalRangeAlias) => void) | null>;
  readonly externalCrosshairTimeRef: React.MutableRefObject<((timeSec: number | null) => void) | null>;
}> = ({
  bundle,
  timeframe,
  overlays,
  showAvwapBands,
  currencySymbol,
  keyLevels,
  highlightedLevel,
  onCrosshairTime,
  onLogicalRangeSync,
  onCrosshairTimeSync,
  externalLogicalRangeRef,
  externalCrosshairTimeRef,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const emaRefs = useRef<readonly ISeriesApi<'Line'>[]>([]);
  const vwapRef = useRef<ISeriesApi<'Line'> | null>(null);
  const avwapRefs = useRef<readonly ISeriesApi<'Line'>[]>([]);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const latestBarsRef = useRef(bundle.bars);
  const crosshairCbRef = useRef(onCrosshairTimeSync);
  const rangeCbRef = useRef(onLogicalRangeSync);
  latestBarsRef.current = bundle.bars;
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
      timeScale: { borderColor: '#1C1C24', timeVisible: true, secondsVisible: false },
      width: element.clientWidth,
      height: element.clientHeight,
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
    chartRef.current = chart;
    candleRef.current = candles;
    emaRefs.current = emaSeries;
    vwapRef.current = vwap;
    avwapRefs.current = avwapSeries;

    const handleRangeChange = (range: LogicalRangeAlias | null): void => {
      rangeCbRef.current(range);
    };
    const handleCrosshairMove = (param: { readonly time?: Time }): void => {
      if (param.time !== undefined && typeof param.time === 'number') {
        onCrosshairTime(param.time);
        crosshairCbRef.current(param.time);
      } else {
        crosshairCbRef.current(null);
      }
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleRangeChange);
    chart.subscribeCrosshairMove(handleCrosshairMove);
    const resizeObserver = new ResizeObserver(() => {
      if (!containerRef.current) return;
      chart.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
      });
    });
    resizeObserver.observe(element);
    externalLogicalRangeRef.current = (range) => chart.timeScale().setVisibleLogicalRange(range);
    externalCrosshairTimeRef.current = (timeSec) => {
      if (timeSec === null) {
        chart.clearCrosshairPosition();
        return;
      }
      const match = latestBarsRef.current.find((bar) => bar.time === timeSec);
      if (match) chart.setCrosshairPosition(match.close, timeSec as UTCTimestamp, candles);
    };

    return () => {
      resizeObserver.disconnect();
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleRangeChange);
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      emaRefs.current = [];
      vwapRef.current = null;
      avwapRefs.current = [];
      externalLogicalRangeRef.current = null;
      externalCrosshairTimeRef.current = null;
    };
  }, [externalCrosshairTimeRef, externalLogicalRangeRef, onCrosshairTime, bundle.barsAvailable]);

  useEffect(() => {
    const chart = chartRef.current;
    const candles = candleRef.current;
    if (!chart || !candles) return;
    chart.applyOptions({ timeScale: { timeVisible: timeframe !== '1D', secondsVisible: false } });
    if (!bundle.barsAvailable || bundle.bars.length === 0) {
      candles.setData([]);
      emaRefs.current.forEach((series) => series.setData([]));
      vwapRef.current?.setData([]);
      avwapRefs.current.forEach((series) => series.setData([]));
      return;
    }
    candles.setData(bundle.bars.map((bar) => ({
      time: bar.time as UTCTimestamp,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    })));
    const toLineData = (values: readonly (number | null)[]) =>
      bundle.bars
        .map((bar, index) => {
          const value = values[index];
          return value != null && Number.isFinite(value) ? { time: bar.time as UTCTimestamp, value } : null;
        })
        .filter((point): point is { time: UTCTimestamp; value: number } => point !== null);
    emaRefs.current[0]?.setData(overlays.emas ? toLineData(bundle.ema9) : []);
    emaRefs.current[1]?.setData(overlays.emas ? toLineData(bundle.ema21) : []);
    emaRefs.current[2]?.setData(overlays.emas ? toLineData(bundle.ema50) : []);
    emaRefs.current[3]?.setData(overlays.emas ? toLineData(bundle.ema200) : []);
    vwapRef.current?.setData(overlays.sessionVwap ? toLineData(bundle.sessionVwap) : []);
    avwapRefs.current[0]?.setData(overlays.avwap ? toLineData(bundle.avwapSeries) : []);
    avwapRefs.current[1]?.setData(overlays.avwap && showAvwapBands ? toLineData(bundle.avwapUpper1) : []);
    avwapRefs.current[2]?.setData(overlays.avwap && showAvwapBands ? toLineData(bundle.avwapLower1) : []);
    avwapRefs.current[3]?.setData(overlays.avwap && showAvwapBands ? toLineData(bundle.avwapUpper2) : []);
    avwapRefs.current[4]?.setData(overlays.avwap && showAvwapBands ? toLineData(bundle.avwapLower2) : []);
    chart.timeScale().fitContent();
  }, [bundle, overlays.emas, overlays.sessionVwap, overlays.avwap, showAvwapBands, timeframe]);

  useEffect(() => {
    const candles = candleRef.current;
    if (!candles) return;
    for (const line of priceLinesRef.current) candles.removePriceLine(line);
    priceLinesRef.current = [];
    if (!bundle.barsAvailable) return;
    const addLine = (
      price: number | null,
      title: string,
      color: string,
      style: LineStyle,
      highlighted: boolean,
    ): void => {
      if (price === null || !Number.isFinite(price) || price <= 0) return;
      priceLinesRef.current.push(candles.createPriceLine({
        price,
        color,
        lineWidth: highlighted ? 3 : 2,
        lineStyle: style,
        axisLabelVisible: true,
        title,
      }));
    };
    const prefix = currencySymbol === 'USD' ? 'US$' : '$';
    if (overlays.volumeProfile) {
      addLine(keyLevels.poc, `POC ${prefix}${fmtNum(keyLevels.poc, 2)}`, '#FACC15', LineStyle.Solid, highlightedLevel === 'POC');
      addLine(keyLevels.vah, 'VAH', '#60A5FA', LineStyle.SparseDotted, highlightedLevel === 'VAH');
      addLine(keyLevels.val, 'VAL', '#60A5FA', LineStyle.SparseDotted, highlightedLevel === 'VAL');
    }
    if (overlays.optionWalls) {
      addLine(keyLevels.callWall, `CALL WALL ${prefix}${fmtNum(keyLevels.callWall, 2)}`, '#2EDC7E', LineStyle.Dashed, highlightedLevel === 'CALL_WALL');
      addLine(keyLevels.putWall, `PUT WALL ${prefix}${fmtNum(keyLevels.putWall, 2)}`, '#FF5468', LineStyle.Dashed, highlightedLevel === 'PUT_WALL');
      addLine(keyLevels.zeroGamma, `ZERO-GAMMA ${prefix}${fmtNum(keyLevels.zeroGamma, 2)}`, '#A78BFA', LineStyle.Dotted, highlightedLevel === 'ZERO_GAMMA');
    }
  }, [bundle.barsAvailable, currencySymbol, highlightedLevel, keyLevels, overlays.optionWalls, overlays.volumeProfile]);

  if (!bundle.barsAvailable) {
    return (
      <div className="relative flex h-[72vh] min-h-[560px] w-full items-center justify-center px-6 text-center">
        <div>
          <div className="text-[13px] font-semibold text-[#E5E8F5]">{bundle.intradayUnavailableReason ?? 'Sin velas disponibles.'}</div>
          <div className="mt-1 text-[11px] text-[#7E85A3]">No se sintetizan velas sin fuente real.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-[72vh] min-h-[560px] w-full">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
};
