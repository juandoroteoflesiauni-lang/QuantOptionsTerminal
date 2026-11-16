import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LogicalRange } from 'lightweight-charts';
import {
  refreshOverview,
  requestOptionsChain,
  requestStockDetail,
  requestTerminalBars,
  requestUsSnapshot,
  useLiveMarketState,
} from '../data/liveRuntimeBridge';
import type {
  TerminalTimeframe,
  UsTerminalBarsResponseDto,
} from '../data/liveTypes';
import {
  AR_GENERAL_PANEL_STOCKS,
  AR_STOCKS,
  BONDS_DATA,
  US_MARKET_DATA,
  fmtMoneyCompact,
  fmtNum,
} from '../data/marketData';
import { ExecutionBottomDeck } from './stock-detail/ExecutionBottomDeck';
import { GexStrikeProfileChart } from './stock-detail/GexStrikeProfileChart';
import { MainPriceAmtChart } from './stock-detail/MainPriceAmtChart';
import { CompanyLogo } from './common/CompanyLogo';
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
  ChartCoordinateMapper,
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
  StockDetailHeader,
  type TickerQuickOption,
} from './stock-detail/StockDetailHeader';
import { SyncedLowerPaneChart } from './stock-detail/SyncedLowerPaneChart';
import {
  getMarketLiveClock,
  getMarketLiveQuote,
  useLivePriceFlash,
  useMarketLiveStream,
} from '../api/useMarketLiveStream';

const TIMEFRAMES: readonly { readonly id: TerminalTimeframe; readonly label: string }[] = [
  { id: '1m', label: '1m' },
  { id: '5m', label: '5m' },
  { id: '15m', label: '15m' },
  { id: '1h', label: '1H' },
  { id: '4h', label: '4H' },
  { id: '1D', label: '1D' },
];

const AVWAP_MODES: readonly { readonly id: AvwapAnchorMode; readonly label: string }[] = [
  { id: 'MONTH_START', label: 'Inicio de Mes' },
  { id: 'LAST_EXPIRY', label: 'Último Vencimiento' },
  { id: 'LAST_EARNINGS', label: 'Último Balance' },
  { id: 'SWING_HIGH_60D', label: 'Swing High 60d' },
  { id: 'SWING_LOW_60D', label: 'Swing Low 60d' },
];

const AR_BYMA_OPTIONS_ELIGIBLE = new Set([
  'GGAL',
  'YPFD',
  'PAMP',
  'BMA',
  'SUPV',
  'BBAR',
  'CEPU',
  'EDN',
  'TGSU2',
  'ALUA',
  'COME',
  'TXAR',
  'LOMA',
  'BYMA',
  'VALO',
]);

function dedupAndSortBars(rawBars: readonly MinimalOhlcvBar[]): readonly MinimalOhlcvBar[] {
  const byTime = new Map<number, MinimalOhlcvBar>();
  for (const b of rawBars) {
    if (
      !Number.isFinite(b.time) ||
      !Number.isFinite(b.open) ||
      !Number.isFinite(b.high) ||
      !Number.isFinite(b.low) ||
      !Number.isFinite(b.close)
    ) {
      continue;
    }
    byTime.set(b.time, b);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function normalizeFiniteOrNull(v: number | null | undefined): number | null {
  return v !== null && v !== undefined && Number.isFinite(v) ? v : null;
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
  const cleanTicker = ticker.trim().toUpperCase() || 'GGAL';

  const [timeframe, setTimeframe] = useState<TerminalTimeframe>('1D');
  const [avwapMode, setAvwapMode] = useState<AvwapAnchorMode>('MONTH_START');
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
  const [loading, setLoading] = useState(false);
  const [mapper, setMapper] = useState<ChartCoordinateMapper | null>(null);
  const hasOverviewRef = useRef(Boolean(runtime.overview));
  hasOverviewRef.current = Boolean(runtime.overview);

  const mainLogicalRef = useRef<((range: LogicalRange) => void) | null>(null);
  const lowerLogicalRef = useRef<((range: LogicalRange) => void) | null>(null);
  const mainCrosshairRef = useRef<((t: number | null) => void) | null>(null);
  const lowerCrosshairRef = useRef<((t: number | null) => void) | null>(null);

  // Clasificar si el símbolo pertenece a BYMA (acciones locales / bonos soberanos) o EE.UU.
  const isArMarket = useMemo(() => {
    const arStock =
      AR_STOCKS.some((s) => s.ticker === cleanTicker) ||
      AR_GENERAL_PANEL_STOCKS.some((s) => s.ticker === cleanTicker) ||
      BONDS_DATA.some(
        (b) =>
          b.ticker === cleanTicker ||
          `${b.ticker}D` === cleanTicker ||
          `${b.ticker}C` === cleanTicker,
      ) ||
      runtime.overview?.mervalStocks.some((s) => s.ticker === cleanTicker) ||
      runtime.overview?.generalPanelStocks.some((s) => s.ticker === cleanTicker);
    return Boolean(arStock);
  }, [cleanTicker, runtime.overview]);

  const liveQuote = getMarketLiveQuote(liveStream, isArMarket ? 'AR' : 'US', cleanTicker);
  const liveClock = getMarketLiveClock(liveStream);
  const liveHeaderFlash = useLivePriceFlash(liveQuote?.price ?? null);

  // Carga de datos con cancelación AbortController al cambiar ticker o temporalidad
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setHighlightedLevel(null);

    if (!hasOverviewRef.current) {
      void refreshOverview();
    }

    const load = async () => {
      try {
        if (isArMarket) {
          const detail = await requestStockDetail(cleanTicker, false, timeframe, controller.signal);
          if (controller.signal.aborted) return;
          if (
            AR_BYMA_OPTIONS_ELIGIBLE.has(cleanTicker) ||
            (detail?.relatedOptionsCount ?? 0) > 0
          ) {
            await requestOptionsChain(cleanTicker);
          }
        } else {
          const [barsRes] = await Promise.all([
            requestTerminalBars(cleanTicker, timeframe, {
              visibleBars: 220,
              signal: controller.signal,
            }),
            requestUsSnapshot(cleanTicker, { signal: controller.signal }),
          ]);
          if (controller.signal.aborted) return;
          if (barsRes) {
            setUsBarsByKey((prev) => ({
              ...prev,
              [`${cleanTicker}:${timeframe}`]: barsRes,
            }));
          }
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };

    void load();
    return () => {
      controller.abort();
    };
  }, [cleanTicker, timeframe, isArMarket]);

  const quickTickers: readonly TickerQuickOption[] = useMemo(() => {
    const out: TickerQuickOption[] = [];
    const seen = new Set<string>();
    for (const s of [...AR_STOCKS, ...AR_GENERAL_PANEL_STOCKS]) {
      if (!seen.has(s.ticker)) {
        seen.add(s.ticker);
        out.push({ ticker: s.ticker, name: s.name, group: 'AR' });
      }
    }
    for (const u of US_MARKET_DATA) {
      if (!seen.has(u.ticker)) {
        seen.add(u.ticker);
        out.push({ ticker: u.ticker, name: u.name, group: 'US' });
      }
    }
    for (const c of runtime.overview?.cedears ?? []) {
      if (!seen.has(c.ticker)) {
        seen.add(c.ticker);
        out.push({ ticker: c.ticker, name: c.name, group: 'CEDEAR' });
      }
    }
    return out;
  }, [runtime.overview]);

  const stockDetail = isArMarket ? runtime.stockDetailsBySymbol[cleanTicker] : undefined;
  const arOptions = isArMarket ? runtime.optionsByUnderlying[cleanTicker] : undefined;
  const usSnap = !isArMarket ? runtime.usSnapshotsBySymbol[cleanTicker] : undefined;
  const usBarsResp = !isArMarket ? usBarsByKey[`${cleanTicker}:${timeframe}`] : undefined;

  // 1) Armado del Banner Ejecutivo y Bloque Contextual Dual
  const contextInfo: StockContextBannerInfo = useMemo(() => {
    const cclMed = runtime.overview?.cclMedian ?? null;

    if (isArMarket) {
      const ovStock =
        stockDetail?.stock ??
        runtime.overview?.mervalStocks.find((s) => s.ticker === cleanTicker) ??
        runtime.overview?.generalPanelStocks.find((s) => s.ticker === cleanTicker) ??
        null;
      const monStock =
        runtime.monitoring?.stocks.find((s) => s.ticker === cleanTicker) ??
        runtime.monitoring?.generalPanel.find((s) => s.ticker === cleanTicker) ??
        runtime.monitoring?.cedears.find((s) => s.ticker === cleanTicker) ??
        null;
      const arMeta =
        AR_STOCKS.find((s) => s.ticker === cleanTicker) ??
        AR_GENERAL_PANEL_STOCKS.find((s) => s.ticker === cleanTicker);
      const bond = stockDetail?.bond ?? null;
      const lastDailyClose =
        stockDetail?.historicalBars && stockDetail.historicalBars.length > 0
          ? stockDetail.historicalBars[stockDetail.historicalBars.length - 1]?.close ?? null
          : null;
      const spot = normalizeFiniteOrNull(ovStock?.last ?? bond?.priceArs ?? lastDailyClose);
      const prevClose = normalizeFiniteOrNull(ovStock?.prevClose);
      const changePct = normalizeFiniteOrNull(ovStock?.deltaPct ?? bond?.deltaPct);

      const adrUsTickerRaw = ovStock?.adrTicker
        ? ovStock.adrTicker.replace(/ US$/i, '').trim().toUpperCase()
        : null;
      const adrUsd = normalizeFiniteOrNull(ovStock?.adrPrice);
      const adrRatio = normalizeFiniteOrNull(ovStock?.adrRatio);
      const arHasAdr = Boolean(adrUsTickerRaw && adrRatio && adrRatio > 0);
      const impliedCcl =
        arHasAdr && spot !== null && adrUsd !== null && adrUsd > 0 && adrRatio !== null
          ? (spot * adrRatio) / adrUsd
          : normalizeFiniteOrNull(ovStock?.cclImplicit);
      const theoArs =
        arHasAdr && adrUsd !== null && cclMed !== null && adrRatio !== null && adrRatio > 0
          ? (adrUsd * cclMed) / adrRatio
          : null;
      const arbGapPct =
        spot !== null && theoArs !== null && theoArs > 0
          ? ((spot / theoArs) - 1) * 100
          : null;

      const volCompact =
        ovStock?.volumeM !== null && ovStock?.volumeM !== undefined && Number.isFinite(ovStock.volumeM)
          ? fmtMoneyCompact(ovStock.volumeM)
          : bond?.volumeM !== null && bond?.volumeM !== undefined && Number.isFinite(bond.volumeM)
          ? fmtMoneyCompact(bond.volumeM)
          : '—';

      const intradayProvenanceNote =
        timeframe !== '1D' && stockDetail?.adrBars
          ? `ADR ${stockDetail.adrBars.usTicker} (NYSE) → ARS · CCL $${fmtNum(stockDetail.adrBars.cclUsed, 2)}`
          : null;

      return {
        market: 'AR',
        ticker: cleanTicker,
        name: ovStock?.name ?? bond?.name ?? arMeta?.name ?? cleanTicker,
        marketLabel: 'BYMA 24hs',
        currencySymbol: 'ARS',
        spot,
        prevClose,
        changePct,
        dayLow: normalizeFiniteOrNull(ovStock?.low),
        dayHigh: normalizeFiniteOrNull(ovStock?.high),
        volumeCompact: volCompact,
        volRelative: normalizeFiniteOrNull(ovStock?.volMultiple ?? monStock?.volMultiple),
        feedStatus: stockDetail?.feedStatus ?? runtime.feedStatus ?? 'NO_DATA',
        intradayProvenanceNote,
        arHasAdr,
        adrUsTicker: adrUsTickerRaw,
        adrUsdPrice: adrUsd,
        adrRatio,
        impliedCcl,
        theoreticalArsPrice: theoArs,
        arbitrageGapPct: arbGapPct,
        arAssetType: stockDetail?.assetType ?? (bond ? 'BOND' : 'STOCK'),
        bondTirPct: normalizeFiniteOrNull(bond?.tirPct),
        bondParityPct: normalizeFiniteOrNull(bond?.parityPct),
        marketCclMedian: normalizeFiniteOrNull(cclMed),
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

    // Mercado EE.UU. (NASDAQ/NYSE) + cruce CEDEAR BYMA
    const usMeta = US_MARKET_DATA.find((u) => u.ticker === cleanTicker);
    const uq = usSnap?.marketContext?.unifiedQuotes?.find(
      (q) => q.ticker.toUpperCase() === cleanTicker,
    );
    const snapSpot =
      uq?.price ??
      usSnap?.envelope?.snapshot?.metrics?.spot ??
      usSnap?.envelope?.metrics?.spot?.value ??
      (usBarsResp?.bars?.length
        ? usBarsResp.bars[usBarsResp.bars.length - 1]?.close ?? null
        : null);
    const spot = normalizeFiniteOrNull(snapSpot);

    const matchedCedear = runtime.overview?.cedears.find((c) => {
      const targetUs = c.adrTicker?.replace(/ US$/i, '').trim().toUpperCase();
      return targetUs === cleanTicker || c.ticker === cleanTicker;
    });

    const cedPrice = normalizeFiniteOrNull(matchedCedear?.last);
    const cedRatio = normalizeFiniteOrNull(matchedCedear?.adrRatio);
    const impliedCcl =
      cedPrice !== null && spot !== null && spot > 0 && cedRatio !== null && cedRatio > 0
        ? (cedPrice * cedRatio) / spot
        : normalizeFiniteOrNull(matchedCedear?.cclImplicit);
    const cclMismatchPct =
      impliedCcl !== null && cclMed !== null && cclMed > 0
        ? ((impliedCcl / cclMed) - 1) * 100
        : null;

    const volM = normalizeFiniteOrNull(uq?.volumeM);
    const volSh = normalizeFiniteOrNull(uq?.volume);
    const volumeCompact =
      volM !== null
        ? `US$ ${fmtNum(volM, 1)} M`
        : volSh !== null
        ? `${fmtNum(volSh / 1_000_000, 2)} M acc.`
        : '—';

    return {
      market: 'US',
      ticker: cleanTicker,
      name: usMeta?.name ?? cleanTicker,
      marketLabel: 'NASDAQ / NYSE',
      currencySymbol: 'USD',
      spot,
      prevClose: normalizeFiniteOrNull(uq?.previousClose),
      changePct: normalizeFiniteOrNull(uq?.changePct),
      dayLow: normalizeFiniteOrNull(uq?.dayLow),
      dayHigh: normalizeFiniteOrNull(uq?.dayHigh),
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
      marketCclMedian: normalizeFiniteOrNull(cclMed),
      nbboBid: normalizeFiniteOrNull(uq?.bid),
      nbboAsk: normalizeFiniteOrNull(uq?.ask),
      nbboBidSize: normalizeFiniteOrNull(uq?.bidSize),
      nbboAskSize: normalizeFiniteOrNull(uq?.askSize),
      nbboSpreadPct: normalizeFiniteOrNull(uq?.spreadPct),
      cedearTicker: matchedCedear?.ticker ?? null,
      cedearRatio: cedRatio,
      cedearArsPrice: cedPrice,
      cedearCclMismatchPct: cclMismatchPct,
    };
  }, [isArMarket, cleanTicker, stockDetail, runtime.overview, runtime.monitoring, runtime.feedStatus, usSnap, usBarsResp, timeframe]);

  // 2) Construcción de series OHLCV, EMAs, VWAP, AVWAP, Benchmark RS y IV/RV
  const chartBundle: StockChartSeriesBundle = useMemo(() => {
    let rawBars: readonly MinimalOhlcvBar[] = [];
    let intradayUnavailableReason: string | null = null;
    let benchBars1d: readonly MinimalOhlcvBar[] = [];
    let ivAtmPct: number | null = null;

    if (isArMarket) {
      if (timeframe === '1D') {
        rawBars = stockDetail?.historicalBars ?? [];
      } else if (stockDetail?.adrBars && stockDetail.adrBars.bars.length > 0) {
        rawBars = stockDetail.adrBars.bars;
      } else {
        intradayUnavailableReason = `Sin feed intradiario BYMA para ${cleanTicker} (${timeframe}) — Disponible en 1D`;
      }
      benchBars1d = dedupAndSortBars(stockDetail?.benchmarkBars1d ?? []);
      const frontExp =
        arOptions?.expiries.find((e) => e.ivAtm !== null && e.ivAtm > 0) ??
        arOptions?.expiries[0];
      if (frontExp?.ivAtm !== null && frontExp?.ivAtm !== undefined && Number.isFinite(frontExp.ivAtm)) {
        ivAtmPct = frontExp.ivAtm * 100;
      }
    } else {
      rawBars = usBarsResp?.bars ?? [];
      benchBars1d = dedupAndSortBars(usSnap?.benchmarkBars1d ?? []);
      const ivDec =
        usSnap?.volSurfaceSummary?.frontSlice?.ivAtm ??
        usSnap?.volSurfaceSummary?.iv30d ??
        usSnap?.envelope?.snapshot?.metrics?.iv30d ??
        null;
      if (ivDec !== null && Number.isFinite(ivDec) && ivDec > 0) {
        ivAtmPct = ivDec * 100;
      }
    }

    const bars = dedupAndSortBars(rawBars);
    const closes = bars.map((b) => b.close);
    const isIntraday = timeframe !== '1D';

    // EMAs (9 / 21 / 50 / 200) sobre serie visible ordenada
    const ema9 = computeEmaSeriesPure(closes, 9).map(normalizeFiniteOrNull);
    const ema21 = computeEmaSeriesPure(closes, 21).map(normalizeFiniteOrNull);
    const ema50 = computeEmaSeriesPure(closes, 50).map(normalizeFiniteOrNull);
    const ema200 = computeEmaSeriesPure(closes, 200).map(normalizeFiniteOrNull);

    // Session VWAP (ART -3h para AR, EDT -4h para US) solo en intradiario
    const sessionVwap = computeSessionVwapPure(
      bars,
      isIntraday,
      isArMarket ? -10_800 : -14_400,
    ).map(normalizeFiniteOrNull);

    // AVWAP con ancla seleccionada
    const customExpirySec = isArMarket
      ? arOptions?.exposureSummary?.expectedMoveExpirySec ??
        stockDetail?.nextExpiry?.expiryUtcSec ??
        null
      : usSnap?.exposureSummary?.expectedMove?.expiryUtcSec ?? null;

    const hoursToEarn = isArMarket
      ? stockDetail?.institutionalEngines?.relativeStrength?.hoursToEarnings ?? null
      : usSnap?.terminalEngines?.relativeStrength?.hoursToEarnings ?? null;

    const lastBarTime = bars[bars.length - 1]?.time ?? null;
    const customEarningsSec =
      hoursToEarn !== null &&
      Number.isFinite(hoursToEarn) &&
      hoursToEarn <= 0 &&
      lastBarTime !== null
        ? lastBarTime + Math.round(hoursToEarn * 3_600)
        : null;

    const anchorParam =
      avwapMode === 'LAST_EXPIRY'
        ? customExpirySec
        : avwapMode === 'LAST_EARNINGS'
        ? customEarningsSec
        : null;
    const anchorIdx = resolveAvwapAnchorIndex(bars, avwapMode, anchorParam);
    const avwapSeries = computeAnchoredVwapPure(bars, anchorIdx).map(normalizeFiniteOrNull);

    const rv30Dec = isArMarket
      ? stockDetail?.realizedVol20d ?? null
      : usSnap?.envelope?.snapshot?.metrics?.realizedVolAnnualized ??
        usSnap?.envelope?.metrics?.realizedVol20d?.value ??
        null;
    const rv30Pct =
      rv30Dec !== null && Number.isFinite(rv30Dec) && rv30Dec > 0 ? rv30Dec * 100 : null;
    const vrpPct = ivAtmPct !== null && rv30Pct !== null ? ivAtmPct - rv30Pct : null;

    return {
      bars,
      ema9,
      ema21,
      ema50,
      ema200,
      sessionVwap,
      avwapMode,
      avwapSeries,
      avwapAnchorAvailable: anchorIdx >= 0,
      benchmarkBars1d: benchBars1d,
      ivAtmPct,
      rv30Pct,
      vrpPct,
      barsAvailable: bars.length > 0 && intradayUnavailableReason === null,
      intradayUnavailableReason,
    };
  }, [isArMarket, cleanTicker, timeframe, stockDetail, arOptions, usBarsResp, usSnap, avwapMode]);

  // 3) Niveles Estructurales AMT + Walls + ATR(14)
  const keyLevels: ChartKeyLevels = useMemo(() => {
    const fallbackAtrArr =
      chartBundle.bars.length > 14 ? computeWilderAtrPure(chartBundle.bars, 14) : [];
    const fallbackAtr = normalizeFiniteOrNull(fallbackAtrArr[fallbackAtrArr.length - 1]);

    if (isArMarket) {
      const eng = stockDetail?.institutionalEngines;
      const expSum = arOptions?.exposureSummary;
      return {
        poc: normalizeFiniteOrNull(eng?.volumeProfile?.poc),
        vah: normalizeFiniteOrNull(eng?.volumeProfile?.vah),
        val: normalizeFiniteOrNull(eng?.volumeProfile?.val),
        callWall: normalizeFiniteOrNull(expSum?.callWallStrike),
        putWall: normalizeFiniteOrNull(expSum?.putWallStrike),
        zeroGamma: normalizeFiniteOrNull(expSum?.gammaFlipSpot),
        atr14: normalizeFiniteOrNull(eng?.atr14) ?? fallbackAtr,
        nakedPocs: (eng?.nakedPocs?.activeNakedPocs ?? [])
          .filter((p): p is { readonly sessionDate: string; readonly sessionPoc: number } =>
            p.sessionPoc !== null && Number.isFinite(p.sessionPoc),
          )
          .map((p) => ({ sessionDate: p.sessionDate, price: p.sessionPoc })),
        fvgs: eng?.fvgs?.activeFvgs ?? [],
        orderBlocks: eng?.orderBlocks?.freshOrderBlocks ?? [],
      };
    }

    const te = usSnap?.terminalEngines;
    const expSum = usSnap?.exposureSummary;
    return {
      poc: normalizeFiniteOrNull(te?.volumeProfile?.poc),
      vah: normalizeFiniteOrNull(te?.volumeProfile?.vah),
      val: normalizeFiniteOrNull(te?.volumeProfile?.val),
      callWall: normalizeFiniteOrNull(expSum?.callWallStrike),
      putWall: normalizeFiniteOrNull(expSum?.putWallStrike),
      zeroGamma: normalizeFiniteOrNull(expSum?.gammaFlipSpot),
      atr14: normalizeFiniteOrNull(te?.atr14d) ?? fallbackAtr,
      nakedPocs: (te?.nakedPocs?.activeNakedPocs ?? [])
        .filter((p): p is { readonly sessionDate: string; readonly sessionPoc: number } =>
          p.sessionPoc !== null && Number.isFinite(p.sessionPoc),
        )
        .map((p) => ({ sessionDate: p.sessionDate, price: p.sessionPoc })),
      fvgs: te?.fvgs?.activeFvgs ?? [],
      orderBlocks: te?.orderBlocks?.freshOrderBlocks ?? [],
    };
  }, [isArMarket, stockDetail, arOptions, usSnap, chartBundle.bars]);

  // 4) Perfil Vertical GEX / OI y Banda ±1σ Expected Move (Gráfico 2)
  const { gexProfileStrikes, expectedMoveInfo } = useMemo(() => {
    const spot = contextInfo.spot;
    if (isArMarket) {
      const expSum = arOptions?.exposureSummary;
      const byStrike: readonly GexStrikeProfileItem[] = (expSum?.byStrike ?? []).map((s) => ({
        strike: s.strike,
        callOi: normalizeFiniteOrNull(s.callOi),
        putOi: normalizeFiniteOrNull(s.putOi),
        callGex: normalizeFiniteOrNull(s.callGex),
        putGex: normalizeFiniteOrNull(s.putGex),
        netGex: normalizeFiniteOrNull(s.netGex),
      }));

      const days = expSum?.expectedMoveDays ?? stockDetail?.nextExpiry?.daysToExpiry ?? null;
      const ivDec =
        chartBundle.ivAtmPct !== null && Number.isFinite(chartBundle.ivAtmPct)
          ? chartBundle.ivAtmPct / 100
          : null;

      let emInfo: ExpectedMoveOverlayInfo | null = null;
      if (spot !== null && spot > 0 && expSum?.expectedMoveAbs && expSum.expectedMoveAbs > 0) {
        emInfo = {
          expiryCode: expSum.expectedMoveExpiryCode ?? stockDetail?.nextExpiry?.expiryCode ?? null,
          daysToExpiry: days,
          ivAtmDecimal: ivDec,
          oneSigmaAbs: expSum.expectedMoveAbs,
          oneSigmaPct:
            expSum.expectedMovePct !== null && Number.isFinite(expSum.expectedMovePct)
              ? expSum.expectedMovePct * 100
              : (expSum.expectedMoveAbs / spot) * 100,
          upper1Sigma: spot + expSum.expectedMoveAbs,
          lower1Sigma: Math.max(0, spot - expSum.expectedMoveAbs),
        };
      } else if (spot !== null && ivDec !== null && days !== null && days > 0) {
        const bounds = computeExpectedMoveBounds(spot, ivDec, days);
        emInfo = Number.isFinite(bounds.oneSigmaAbs)
          ? {
              expiryCode: stockDetail?.nextExpiry?.expiryCode ?? null,
              daysToExpiry: days,
              ivAtmDecimal: ivDec,
              oneSigmaAbs: bounds.oneSigmaAbs,
              oneSigmaPct: bounds.oneSigmaPct,
              upper1Sigma: bounds.upper1Sigma,
              lower1Sigma: bounds.lower1Sigma,
            }
          : null;
      }
      return { gexProfileStrikes: byStrike, expectedMoveInfo: emInfo };
    }

    // US Options Profile
    const expSum = usSnap?.exposureSummary;
    const byStrike: readonly GexStrikeProfileItem[] = (expSum?.byStrike ?? []).map((s) => ({
      strike: s.strike,
      callOi: normalizeFiniteOrNull(s.callOi),
      putOi: normalizeFiniteOrNull(s.putOi),
      callGex: normalizeFiniteOrNull(s.callGex),
      putGex: normalizeFiniteOrNull(s.putGex),
      netGex: normalizeFiniteOrNull(s.netGex),
    }));
    const frontSlice = usSnap?.volSurfaceSummary?.frontSlice;
    const moveAbs = expSum?.expectedMove?.straddleMove ?? expSum?.expectedMove?.formulaMove ?? null;
    const movePct =
      expSum?.expectedMove?.straddleMovePct ?? expSum?.expectedMove?.formulaMovePct ?? null;
    let emInfo: ExpectedMoveOverlayInfo | null = null;
    if (spot !== null && spot > 0 && moveAbs !== null && Number.isFinite(moveAbs) && moveAbs > 0) {
      emInfo = {
        expiryCode: frontSlice?.expirationDate ?? null,
        daysToExpiry: frontSlice?.timeToExpiryDays ?? null,
        ivAtmDecimal: frontSlice?.ivAtm ?? null,
        oneSigmaAbs: moveAbs,
        oneSigmaPct: movePct !== null ? movePct * 100 : (moveAbs / spot) * 100,
        upper1Sigma: spot + moveAbs,
        lower1Sigma: Math.max(0, spot - moveAbs),
      };
    }
    return { gexProfileStrikes: byStrike, expectedMoveInfo: emInfo };
  }, [isArMarket, arOptions, usSnap, stockDetail, contextInfo.spot, chartBundle.ivAtmPct]);

  // 5) Bloque Inferior de Ejecución (L2/L1, Confluencia Espacial < 0.15 ATR, Arbitraje & Ticket)
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

    // Construir L1 NBBO virtual en formato OrderBook5LevelsDto para reutilizar la UI de puntas sin fallbacks inventados
    const usNbboBook =
      contextInfo.nbboBid !== null || contextInfo.nbboAsk !== null
        ? {
            symbol: cleanTicker,
            marketSymbol: `${cleanTicker} · NBBO`,
            settlement: 'T+1 US',
            marketState: contextInfo.feedStatus,
            source: 'MASSIVE_NBBO_L1',
            asOfUtcSec: usSnap?.asOfUtcSec ?? Math.floor(Date.now() / 1_000),
            bids:
              contextInfo.nbboBid !== null
                ? [{ price: contextInfo.nbboBid, size: contextInfo.nbboBidSize ?? 0 }]
                : [],
            asks:
              contextInfo.nbboAsk !== null
                ? [{ price: contextInfo.nbboAsk, size: contextInfo.nbboAskSize ?? 0 }]
                : [],
            bestBid: contextInfo.nbboBid,
            bestAsk: contextInfo.nbboAsk,
            mid:
              contextInfo.nbboBid !== null && contextInfo.nbboAsk !== null
                ? 0.5 * (contextInfo.nbboBid + contextInfo.nbboAsk)
                : null,
            spreadArs:
              contextInfo.nbboBid !== null && contextInfo.nbboAsk !== null
                ? contextInfo.nbboAsk - contextInfo.nbboBid
                : null,
            spreadPct: contextInfo.nbboSpreadPct,
            bidDepthSize: contextInfo.nbboBidSize,
            askDepthSize: contextInfo.nbboAskSize,
            vwapBid5: null,
            vwapAsk5: null,
            vwapBook5: null,
            obi5:
              contextInfo.nbboBidSize !== null &&
              contextInfo.nbboAskSize !== null &&
              contextInfo.nbboBidSize + contextInfo.nbboAskSize > 0
                ? (contextInfo.nbboBidSize - contextInfo.nbboAskSize) /
                  (contextInfo.nbboBidSize + contextInfo.nbboAskSize)
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
    const te = usSnap?.terminalEngines;
    const mtf = usSnap?.microstructure?.mtf;

    return {
      market: 'US',
      ticker: cleanTicker,
      spot: contextInfo.spot,
      atr14: keyLevels.atr14,
      orderBook24h: usNbboBook,
      orderBookCi: null,
      rofexFrontContract: null,
      confluenceClusters: te?.confluenceClusters ?? null,
      relativeStrength: te?.relativeStrength ?? null,
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
  }, [isArMarket, cleanTicker, contextInfo, keyLevels.atr14, stockDetail, usSnap]);

  const handleToggleHighlight = useCallback((id: Exclude<HighlightLevelId, null>) => {
    setHighlightedLevel((prev) => (prev === id ? null : id));
  }, []);

  const handleToggleOverlay = useCallback((key: keyof OverlayVisibilityState) => {
    setOverlays((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const handleMainRangeSync = useCallback((range: LogicalRange | null) => {
    if (range) lowerLogicalRef.current?.(range);
  }, []);

  const handleLowerRangeSync = useCallback((range: LogicalRange | null) => {
    if (range) mainLogicalRef.current?.(range);
  }, []);

  const handleMainCrosshairSync = useCallback((timeSec: number | null) => {
    lowerCrosshairRef.current?.(timeSec);
  }, []);

  const handleLowerCrosshairSync = useCallback((timeSec: number | null) => {
    mainCrosshairRef.current?.(timeSec);
  }, []);

  return (
    <div className="flex flex-col gap-4 pb-6 text-[#F0F2FA]">
      {/* 0. Cabecera Visual de Identidad Corporativa & Selector Rápido */}
      <div className="rounded-[12px] bg-[#11111A] border border-[#1E1E2B] px-4 py-2.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <CompanyLogo ticker={cleanTicker} name={contextInfo.name} size="lg" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono-num text-[15px] font-extrabold text-[#FFFFFF] tracking-tight">
                {cleanTicker}
              </span>
              <span className="px-1.5 py-0.5 rounded bg-[#171722] border border-[#262636] text-[10px] font-mono-num text-[#9CA3AF]">
                {contextInfo.marketLabel}
              </span>
            </div>
            <div className="text-[12px] text-[#9CA3AF] truncate max-w-[320px]">
              {contextInfo.name}
            </div>
          </div>
        </div>

        {liveQuote !== null && liveClock !== null && (
          <span className="rounded-full border border-[#22C55E]/35 bg-[#22C55E]/10 px-2 py-0.5 font-mono-num text-[10px] font-semibold text-[#22C55E]">
            ● Tiempo real {liveClock}
          </span>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          {quickTickers.slice(0, 6).map((qt) => {
            const isActive = qt.ticker === cleanTicker;
            return (
              <button
                key={`sd-quick-${qt.ticker}`}
                type="button"
                onClick={() => onSelectTicker(qt.ticker)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-mono-num font-semibold transition-colors cursor-pointer ${
                  isActive
                    ? 'bg-[#211B3A] border-[#8B7CF6]/70 text-[#FFFFFF]'
                    : 'bg-[#0B0B11] border-[#1E1E2B] text-[#9CA3AF] hover:text-[#FFFFFF] hover:border-[#2E3245]'
                }`}
              >
                <CompanyLogo ticker={qt.ticker} name={qt.name} size="xs" />
                <span>{qt.ticker}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 1. Cabecera Ejecutiva + Bloque Contextual Dual + Tira de Niveles */}
      <div
        className="rounded-[12px] transition-colors duration-[400ms]"
        style={{
          backgroundColor: liveHeaderFlash === null ? 'transparent' : liveHeaderFlash === 'up' ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
        }}
      >
        <StockDetailHeader
          info={liveQuote !== null ? { ...contextInfo, spot: liveQuote.price } : contextInfo}
          keyLevels={keyLevels}
          highlightedLevel={highlightedLevel}
          onToggleHighlight={handleToggleHighlight}
          quickTickers={quickTickers}
          onSelectTicker={onSelectTicker}
          onBackToMonitor={onBackToMonitor}
          onGoToOptions={onGoToOptions}
        />
      </div>

      {/* 2. Bloque Superior Dual Sincronizado: Chart 1 (~65%) + Chart 2 (~35%) */}
      <section className="rounded-[12px] bg-[#11111A] border border-[#1E1E2B] overflow-hidden">
        {/* Toolbar Unificada (evita desalineación vertical entre Chart 1 y Chart 2) */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b border-[#1E1E2B] bg-[#0D0D14]">
          <div className="flex items-center gap-1">
            {TIMEFRAMES.map((tf) => {
              const active = timeframe === tf.id;
              return (
                <button
                  key={tf.id}
                  type="button"
                  onClick={() => setTimeframe(tf.id)}
                  className={`px-2 py-1 rounded-[6px] font-mono-num text-[11px] font-semibold transition-colors ${
                    active
                      ? 'bg-[#8B7CF6] text-white'
                      : 'bg-[#161622] text-[#8E95B3] hover:text-white hover:bg-[#1E1E2E]'
                  }`}
                >
                  {tf.label}
                </button>
              );
            })}
            {loading && (
              <span className="ml-2 text-[10px] font-mono-num text-[#8B7CF6] animate-pulse">
                Sincronizando...
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <ToolbarChip
              active={overlays.emas}
              label="EMAs 9/21/50/200"
              onClick={() => handleToggleOverlay('emas')}
            />
            <ToolbarChip
              active={overlays.sessionVwap && timeframe !== '1D'}
              disabled={timeframe === '1D'}
              label={timeframe === '1D' ? 'VWAP (solo intradiario)' : 'VWAP Sesión'}
              onClick={() => handleToggleOverlay('sessionVwap')}
            />
            <div className="inline-flex items-center rounded-[6px] border border-[#252536] bg-[#14141F] overflow-hidden">
              <button
                type="button"
                onClick={() => handleToggleOverlay('avwap')}
                className={`px-2 py-1 text-[11px] font-medium transition-colors ${
                  overlays.avwap
                    ? 'bg-[#C084FC]/25 text-[#E5C9FF]'
                    : 'text-[#848BA8] hover:text-white'
                }`}
              >
                AVWAP
              </button>
              <select
                aria-label="Anclaje AVWAP"
                value={avwapMode}
                onChange={(e) => setAvwapMode(e.target.value as AvwapAnchorMode)}
                className="bg-[#11111A] border-l border-[#252536] px-1.5 py-1 text-[10px] font-mono-num text-[#CBD0E4] focus:outline-none"
              >
                {AVWAP_MODES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <ToolbarChip
              active={overlays.volumeProfile}
              label="VP (POC/VAH/VAL)"
              onClick={() => handleToggleOverlay('volumeProfile')}
            />
            <ToolbarChip
              active={overlays.nakedPocs}
              label="Naked POCs"
              onClick={() => handleToggleOverlay('nakedPocs')}
            />
            <ToolbarChip
              active={overlays.fvgFob}
              label="FVG & FOB"
              onClick={() => handleToggleOverlay('fvgFob')}
            />
            <ToolbarChip
              active={overlays.optionWalls}
              label="Walls GEX"
              onClick={() => handleToggleOverlay('optionWalls')}
            />
          </div>
        </div>

        {/* Split 65% / 35% exactamente alineado en Y */}
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.86fr)_minmax(0,1fr)] items-stretch">
          <MainPriceAmtChart
            ticker={cleanTicker}
            timeframe={timeframe}
            onChangeTimeframe={setTimeframe}
            bundle={chartBundle}
            keyLevels={keyLevels}
            overlays={overlays}
            onToggleOverlay={handleToggleOverlay}
            onChangeAvwapMode={setAvwapMode}
            highlightedLevel={highlightedLevel}
            currencySymbol={contextInfo.currencySymbol}
            loading={loading}
            hideToolbar
            onCoordinateMapperChange={setMapper}
            onLogicalRangeSync={handleMainRangeSync}
            onCrosshairTimeSync={handleMainCrosshairSync}
            externalLogicalRangeRef={mainLogicalRef}
            externalCrosshairTimeRef={mainCrosshairRef}
          />
          <GexStrikeProfileChart
            ticker={cleanTicker}
            spot={contextInfo.spot}
            currencySymbol={contextInfo.currencySymbol}
            strikes={gexProfileStrikes}
            expectedMove={expectedMoveInfo}
            keyLevels={keyLevels}
            mapper={mapper}
            hideHeader
          />
        </div>
      </section>

      {/* 3. Gráfico Inferior 100% Sincronizado en Tiempo (CVD / RS / IV vs RV) */}
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

      {/* 4. Bloque Inferior de Ejecución en 3 Columnas */}
      <ExecutionBottomDeck
        deck={executionDeck}
        keyLevels={keyLevels}
        onHighlightLevel={handleToggleHighlight}
        onOpenOrderTicket={onOpenOrderTicket}
        onGoToOptions={onGoToOptions}
      />
    </div>
  );
};

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
    className={`px-2 py-1 rounded-[6px] border text-[11px] font-medium transition-colors ${
      disabled
        ? 'bg-[#111118] border-[#1D1D29] text-[#525870] cursor-not-allowed'
        : active
        ? 'bg-[#8B7CF6]/20 border-[#8B7CF6]/60 text-white'
        : 'bg-[#14141F] border-[#252536] text-[#848BA8] hover:text-white hover:border-[#3A3A54]'
    }`}
  >
    {label}
  </button>
);
