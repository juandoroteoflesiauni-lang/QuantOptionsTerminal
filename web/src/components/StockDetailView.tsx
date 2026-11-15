import React, { useEffect, useState } from 'react';
import { ArrowLeft, Layers } from 'lucide-react';
import { AR_STOCKS, fmtNum, fmtMoneyCompact, fmtPct } from '../data/marketData';
import { requestStockDetail, useLiveMarketState } from '../data/liveRuntimeBridge';
import { HelpTooltip, DeltaPill, TickerChip } from './DesignSystem';

type HistoryWindow = '15R' | '30R' | '60R';

interface OrderBookLevelExt {
  readonly price: number;
  readonly size: number;
}

interface OrderBook5LevelsExt {
  readonly symbol: string;
  readonly marketSymbol: string;
  readonly settlement: string;
  readonly marketState: 'LIVE' | 'WEEKEND_CLOSED' | 'UNAVAILABLE';
  readonly source: 'PRIMARY_MERV' | 'BMB_HOMEBROKER' | 'BYMA_L1_ONLY';
  readonly bids: readonly OrderBookLevelExt[];
  readonly asks: readonly OrderBookLevelExt[];
  readonly spreadArs: number | null;
  readonly spreadPct: number | null;
  readonly vwapBook5: number | null;
  readonly obi5: number | null;
}

interface RofexFrontContractExt {
  readonly contract: string;
  readonly price: number | null;
  readonly priceBasis: 'LAST' | 'MID' | 'SETTLEMENT_EOD' | 'NONE';
  readonly tnaImplicitaPct: number | null;
  readonly devalDirectaPct: number | null;
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
}> = ({ ticker, onSelectTicker, onGoToOptions, onBackToMonitor, onOpenOrderTicket }) => {
  const [windowBars, setWindowBars] = useState<HistoryWindow>('15R');
  const [chartType, setChartType] = useState<'Línea' | 'Velas'>('Línea');
  const liveMarket = useLiveMarketState();

  const upperTicker = ticker.toUpperCase();

  useEffect(() => {
    void requestStockDetail(upperTicker);
  }, [upperTicker]);

  const stockDetail = liveMarket.stockDetailsBySymbol[upperTicker] as
    | (NonNullable<(typeof liveMarket.stockDetailsBySymbol)[string]> & {
        readonly orderBook5Levels?: OrderBook5LevelsExt | null;
        readonly rofexFrontContract?: RofexFrontContractExt | null;
      })
    | undefined;
  const orderBook5Levels = stockDetail?.orderBook5Levels ?? null;
  const rofexFrontContract = stockDetail?.rofexFrontContract ?? null;
  const catalogStock = AR_STOCKS.find((s) => s.ticker === upperTicker) ?? AR_STOCKS[0];
  const overviewStock =
    liveMarket.overview?.mervalStocks.find((s) => s.ticker === upperTicker) ??
    liveMarket.overview?.generalPanelStocks.find((s) => s.ticker === upperTicker) ??
    liveMarket.overview?.cedears.find((s) => s.ticker === upperTicker);
  const liveStockDto = stockDetail?.stock ?? overviewStock ?? null;

  if (!liveStockDto && !catalogStock) {
    return (
      <div className="rounded-[12px] bg-[#131722] border border-[#232733] p-6 text-[13px] text-[#9CA3AF]">
        Sin datos cargados para {upperTicker}.
      </div>
    );
  }

  const stockTicker = liveStockDto?.ticker ?? catalogStock?.ticker ?? upperTicker;
  const stockName = liveStockDto?.name ?? catalogStock?.name ?? upperTicker;
  const stockColor = liveStockDto?.color ?? catalogStock?.color ?? '#38BDF8';
  const liveLast = liveStockDto?.last ?? catalogStock?.last ?? Number.NaN;
  const liveBid = liveStockDto?.bid ?? catalogStock?.bid ?? Number.NaN;
  const liveAsk = liveStockDto?.ask ?? catalogStock?.ask ?? Number.NaN;
  const liveDeltaPct = liveStockDto?.deltaPct ?? catalogStock?.deltaPct ?? Number.NaN;
  const livePrevClose = liveStockDto?.prevClose ?? catalogStock?.prevClose ?? Number.NaN;
  const liveLow = liveStockDto?.low ?? catalogStock?.low ?? Number.NaN;
  const liveHigh = liveStockDto?.high ?? catalogStock?.high ?? Number.NaN;
  const liveVwap = liveStockDto?.vwap ?? catalogStock?.vwap ?? Number.NaN;
  const liveVolumeM = liveStockDto?.volumeM ?? catalogStock?.volumeM ?? Number.NaN;
  const liveVolMultiple = liveStockDto?.volMultiple ?? catalogStock?.volMultiple ?? Number.NaN;

  const spreadArs =
    Number.isFinite(liveBid) && Number.isFinite(liveAsk) ? liveAsk - liveBid : Number.NaN;

  const rv20Dec = stockDetail?.realizedVol20d ?? null;
  const rv60Dec = stockDetail?.realizedVol60d ?? null;
  const rvUsd20Dec = stockDetail?.realizedVolUsd20d ?? null;
  const rv20Pct = rv20Dec !== null && Number.isFinite(rv20Dec) ? rv20Dec * 100 : Number.NaN;
  const rv60Pct = rv60Dec !== null && Number.isFinite(rv60Dec) ? rv60Dec * 100 : Number.NaN;
  const rvUsd20Pct =
    rvUsd20Dec !== null && Number.isFinite(rvUsd20Dec) ? rvUsd20Dec * 100 : Number.NaN;
  const rsi14Val = stockDetail?.rsi14 ?? Number.NaN;
  const ema21Val = stockDetail?.ema21 ?? Number.NaN;
  const sma50Val = stockDetail?.sma50 ?? Number.NaN;

  const expected1dMovePct =
    rv20Dec !== null && Number.isFinite(rv20Dec) && rv20Dec > 0
      ? (rv20Dec / Math.sqrt(252)) * 100
      : Number.NaN;
  const moveSigmaRatio =
    Number.isFinite(expected1dMovePct) &&
    expected1dMovePct > 0 &&
    Number.isFinite(liveDeltaPct)
      ? Math.abs(liveDeltaPct) / expected1dMovePct
      : Number.NaN;

  // Serie histórica real (ruedas BYMA provistas por Data912)
  const rawBars = stockDetail?.historicalBars ?? [];
  const barLimit = windowBars === '15R' ? 15 : windowBars === '30R' ? 30 : 60;
  const startIndex = Math.max(0, rawBars.length - barLimit);
  const chartBars = rawBars.slice(startIndex).map((b, localIdx) => {
    const absIdx = startIndex + localIdx;
    const winStart = Math.max(0, absIdx - 9);
    let sumClose = 0;
    let countClose = 0;
    for (let k = winStart; k <= absIdx; k += 1) {
      const bar = rawBars[k];
      if (bar && Number.isFinite(bar.close)) {
        sumClose += bar.close;
        countClose += 1;
      }
    }
    const sma10 = countClose > 0 ? sumClose / countClose : Number.NaN;
    return {
      dateLabel: b.date.slice(5),
      fullDate: b.date,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      sma10,
      volume: b.volume,
      side: b.close >= b.open ? ('buy' as const) : ('sell' as const),
    };
  });

  const finitePrices = chartBars.flatMap((b) =>
    [b.high, b.low, b.close, b.open, b.sma10].filter((v) => Number.isFinite(v)),
  );
  const rawMinP = finitePrices.length > 0 ? Math.min(...finitePrices) : Number.NaN;
  const rawMaxP = finitePrices.length > 0 ? Math.max(...finitePrices) : Number.NaN;
  const padP =
    Number.isFinite(rawMinP) && Number.isFinite(rawMaxP)
      ? Math.max((rawMaxP - rawMinP) * 0.08, rawMaxP * 0.005, 1)
      : 1;
  const minP = Number.isFinite(rawMinP) ? rawMinP - padP : 0;
  const maxP = Number.isFinite(rawMaxP) ? rawMaxP + padP : 1;
  const spanP = Math.max(maxP - minP, 1e-6);

  const maxVol = Math.max(
    ...chartBars.map((b) => (Number.isFinite(b.volume) ? b.volume : 0)),
    1,
  );

  const plotLeft = 58;
  const plotRight = 655;
  const plotWidth = plotRight - plotLeft;
  const priceTop = 24;
  const priceBottom = 160;
  const priceHeight = priceBottom - priceTop;
  const pToY = (p: number): number =>
    priceBottom - ((p - minP) / spanP) * priceHeight;
  const idxToX = (i: number, total: number): number =>
    total <= 1
      ? plotLeft + plotWidth / 2
      : plotLeft + 12 + (i / (total - 1)) * (plotWidth - 24);
  const candleWidth = Math.max(
    3,
    Math.min(16, Math.floor((plotWidth - 24) / Math.max(chartBars.length, 1) * 0.62)),
  );
  const labelStride = Math.max(1, Math.ceil(chartBars.length / 8));

  const linePoints = chartBars
    .map((b, i) => `${idxToX(i, chartBars.length).toFixed(1)},${pToY(b.close).toFixed(1)}`)
    .join(' ');
  const firstBarX = chartBars.length > 0 ? idxToX(0, chartBars.length) : plotLeft;
  const lastBarX =
    chartBars.length > 0 ? idxToX(chartBars.length - 1, chartBars.length) : plotRight;
  const areaPoints =
    chartBars.length > 1
      ? `${firstBarX.toFixed(1)},${priceBottom} ${linePoints} ${lastBarX.toFixed(1)},${priceBottom}`
      : '';
  const smaPoints = chartBars
    .map((b, i) =>
      Number.isFinite(b.sma10)
        ? `${idxToX(i, chartBars.length).toFixed(1)},${pToY(b.sma10).toFixed(1)}`
        : null,
    )
    .filter((pt): pt is string => pt !== null)
    .join(' ');

  const prevCloseY =
    Number.isFinite(livePrevClose) &&
    chartBars.length > 0 &&
    livePrevClose >= minP &&
    livePrevClose <= maxP
      ? pToY(livePrevClose)
      : Number.NaN;

  // Arbitraje ADR & FX reales
  const adrRatio =
    liveStockDto?.adrRatio ??
    (stockTicker === 'YPFD'
      ? 1
      : stockTicker === 'PAMP'
        ? 25
        : liveStockDto?.adrTicker
          ? 10
          : Number.NaN);
  const adrUsd = liveStockDto?.adrPrice ?? catalogStock?.adrPrice ?? Number.NaN;
  const adrDeltaPct = liveStockDto?.adrDeltaPct ?? catalogStock?.adrDeltaPct ?? Number.NaN;
  const cclGeneral =
    liveMarket.overview?.cclMedian ?? liveMarket.macro?.variables.ccl ?? Number.NaN;
  const mepGeneral =
    liveMarket.overview?.mepMedian ?? liveMarket.macro?.variables.mep ?? Number.NaN;
  const oficialA3500 =
    liveMarket.macro?.variables.a3500 ?? liveMarket.macro?.variables.oficial ?? Number.NaN;
  const cclSpecific = liveStockDto?.cclImplicit ?? catalogStock?.cclImplicit ?? Number.NaN;
  const adrTheoreticalArs =
    Number.isFinite(adrUsd) &&
    Number.isFinite(cclGeneral) &&
    Number.isFinite(adrRatio) &&
    adrRatio > 0
      ? (adrUsd * cclGeneral) / adrRatio
      : Number.NaN;
  const adrDiffLocalPct =
    Number.isFinite(liveLast) &&
    Number.isFinite(adrTheoreticalArs) &&
    adrTheoreticalArs > 0
      ? ((liveLast - adrTheoreticalArs) / adrTheoreticalArs) * 100
      : Number.NaN;
  const canjeCclMepPct =
    Number.isFinite(cclGeneral) && Number.isFinite(mepGeneral) && mepGeneral > 0
      ? ((cclGeneral - mepGeneral) / mepGeneral) * 100
      : Number.NaN;
  const brechaCclPct =
    Number.isFinite(cclGeneral) && Number.isFinite(oficialA3500) && oficialA3500 > 0
      ? ((cclGeneral - oficialA3500) / oficialA3500) * 100
      : Number.NaN;

  const marketBadge = liveMarket.marketState ?? 'CERRADO';
  const lastSyncStr = liveMarket.lastSyncUtcSec
    ? `${new Date(liveMarket.lastSyncUtcSec * 1000).toLocaleTimeString('es-AR')} AR`
    : '—';

  const quantStripTiles = [
    {
      label: 'Vol. Realizada 20R',
      val: Number.isFinite(rv20Pct) ? `${fmtNum(rv20Pct, 1)} %` : '—',
      subLeft: 'Anualizada 252R',
      subRight: Number.isFinite(expected1dMovePct) ? `1σ ≈ ${fmtNum(expected1dMovePct, 2)}%` : '—',
      barPct: Number.isFinite(rv20Pct) ? Math.min(100, Math.max(8, rv20Pct)) : 0,
      barColor: 'bg-[#38BDF8]',
    },
    {
      label: 'Vol. Realizada 60R',
      val: Number.isFinite(rv60Pct) ? `${fmtNum(rv60Pct, 1)} %` : '—',
      subLeft: 'Ventana trimestral',
      subRight:
        Number.isFinite(rv20Pct) && Number.isFinite(rv60Pct)
          ? `Δ ${fmtNum(rv20Pct - rv60Pct, 1)}pp`
          : '—',
      barPct: Number.isFinite(rv60Pct) ? Math.min(100, Math.max(8, rv60Pct)) : 0,
      barColor: 'bg-[#6366F1]',
    },
    {
      label: 'Vol. USD 20R (CCL)',
      val: Number.isFinite(rvUsd20Pct) ? `${fmtNum(rvUsd20Pct, 1)} %` : '—',
      subLeft: 'Deflactada CCL',
      subRight: stockDetail?.assetType ?? 'BYMA',
      barPct: Number.isFinite(rvUsd20Pct) ? Math.min(100, Math.max(8, rvUsd20Pct)) : 0,
      barColor: 'bg-[#22C55E]',
    },
    {
      label: 'RSI (14 ruedas)',
      val: Number.isFinite(rsi14Val) ? fmtNum(rsi14Val, 1) : '—',
      subLeft: rsi14Val >= 70 ? 'Sobrecompra' : rsi14Val <= 30 ? 'Sobreventa' : 'Neutral',
      subRight: 'Escala 0-100',
      barPct: Number.isFinite(rsi14Val) ? Math.min(100, Math.max(0, rsi14Val)) : 0,
      barColor: rsi14Val >= 70 ? 'bg-[#F23645]' : rsi14Val <= 30 ? 'bg-[#22C55E]' : 'bg-[#EAB308]',
    },
    {
      label: 'EMA 21 / SMA 50',
      val: Number.isFinite(ema21Val) ? `$ ${fmtNum(ema21Val, 1)}` : '—',
      subLeft: stockDetail?.mtfRegime ?? 'NO_DATA',
      subRight: Number.isFinite(sma50Val) ? `SMA50 $${fmtNum(sma50Val, 0)}` : '—',
      barPct:
        Number.isFinite(liveLast) && Number.isFinite(ema21Val) && ema21Val > 0
          ? liveLast >= ema21Val
            ? 75
            : 30
          : 0,
      barColor:
        Number.isFinite(liveLast) && Number.isFinite(ema21Val) && liveLast >= ema21Val
          ? 'bg-[#22C55E]'
          : 'bg-[#F23645]',
    },
  ];

  return (
    <div className="space-y-4 animate-module">
      {/* =====================================================================
          1. ENCABEZADO DE PLAZA / FICHA TÉCNICA INTRADIARIA
          ===================================================================== */}
      <div className="rounded-[12px] bg-[#131722] border border-[#232733] p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          {/* Izquierda: Selector rápido + Título + Estado real de plaza */}
          <div className="flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={onBackToMonitor}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] text-[12px] font-semibold bg-[#1A1F2C] hover:bg-[#23293A] text-[#D1D4DC] border border-[#2A2E3D] cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Panel Acciones
            </button>

            <div className="flex items-center gap-3">
              <span
                className="w-9 h-9 rounded-full inline-flex items-center justify-center text-[12px] font-extrabold text-white shadow"
                style={{ backgroundColor: stockColor }}
              >
                {stockTicker.slice(0, 2)}
              </span>
              <div>
                <div className="flex items-center gap-2.5">
                  <h2 className="text-[19px] font-extrabold text-[#FFFFFF] tracking-tight">
                    {stockTicker} - {stockName}
                  </h2>
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-mono-num font-bold uppercase ${
                      marketBadge === 'ABIERTO'
                        ? 'bg-[#0D281E] text-[#22C55E] border border-[#164E3F]'
                        : marketBadge === 'SUBASTA'
                          ? 'bg-[#2A2008] text-[#EAB308] border border-[#523E10]'
                          : 'bg-[#1F2433] text-[#9CA3AF] border border-[#2E3446]'
                    }`}
                  >
                    {marketBadge}
                  </span>
                </div>
                <div className="text-[11.5px] font-mono-num text-[#787B86] mt-0.5">
                  Plaza BYMA Contado Normal (T+1) · {liveMarket.marketStateLabel} · {lastSyncStr}
                </div>
              </div>
            </div>
          </div>

          {/* Derecha: Precio actual + Variación limpia + Link a Opciones */}
          <div className="flex flex-wrap items-center gap-5">
            <div className="text-right">
              <div className="text-[10px] font-mono-num uppercase tracking-wider text-[#787B86]">
                PRECIO PLAZA ARS
              </div>
              <div className="flex items-baseline gap-2.5">
                <span className="font-mono-num text-[24px] font-extrabold text-[#FFFFFF]">
                  {Number.isFinite(liveLast) ? `$ ${fmtNum(liveLast, 2)}` : '—'}
                </span>
                <DeltaPill value={liveDeltaPct} size="md" />
              </div>
            </div>

            <button
              type="button"
              onClick={() => onGoToOptions(stockTicker)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-[8px] text-[12px] font-bold bg-[#1A1F2C] hover:bg-[#252C3F] text-[#38BDF8] border border-[#2A364F] cursor-pointer transition-colors"
            >
              <Layers className="w-3.5 h-3.5" /> Cadena de Opciones ({stockTicker})
            </button>
          </div>
        </div>

        {/* Tira de cambio rápido de papel */}
        <div className="pt-3 border-t border-[#232733] flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-1.5 flex-wrap">
            {AR_STOCKS.slice(0, 8).map((s) => (
              <TickerChip
                key={s.ticker}
                ticker={s.ticker}
                color={s.color}
                selected={s.ticker === stockTicker}
                onClick={() => onSelectTicker(s.ticker)}
              />
            ))}
          </div>

          {/* Métrica cuantitativa de desviación diaria respecto de vol. realizada 20R */}
          <div className="text-[12.5px] text-[#D1D4DC] bg-[#0B0E14] px-3.5 py-1.5 rounded-[8px] border border-[#232733]">
            {Number.isFinite(moveSigmaRatio) ? (
              <>
                Hoy se movió{' '}
                <strong className="text-[#FFFFFF] font-mono-num">
                  {fmtNum(moveSigmaRatio, 2)}σ
                </strong>{' '}
                vs. vol. 20R ·{' '}
                <span className="text-[#9CA3AF]">
                  1σ diario ≈ {fmtNum(expected1dMovePct, 2)} %
                </span>
              </>
            ) : (
              <span className="text-[#9CA3AF]">
                Desviación σ diaria vs. vol. realizada 20R: —
              </span>
            )}
          </div>
        </div>
      </div>

      {/* =====================================================================
          2. GRÁFICO HISTÓRICO REAL + CAJA DE PUNTAS LEVEL 1 BYMA
          ===================================================================== */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* GRÁFICO DUAL (8 columnas) */}
        <div className="lg:col-span-8 rounded-[12px] bg-[#131722] border border-[#232733] p-5 flex flex-col justify-between gap-4">
          {/* Controles del gráfico: 15R, 30R, 60R + Línea / Velas */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3 flex-wrap">
              <h3 className="text-[14.5px] font-bold text-[#FFFFFF]">
                Evolución por Ruedas &amp; Volumen Diario (BYMA)
              </h3>
              <span className="text-[11px] font-mono-num text-[#EAB308]">
                ── Media 10R (EMA21 {Number.isFinite(ema21Val) ? `$ ${fmtNum(ema21Val, 1)}` : '—'})
              </span>
              <span className="text-[11px] font-mono-num text-[#787B86]">
                - - Cierre ant. ({Number.isFinite(livePrevClose) ? `$ ${fmtNum(livePrevClose, 1)}` : '—'})
              </span>
            </div>

            <div className="flex items-center gap-2">
              {/* Ventana histórica real en ruedas */}
              <div className="flex items-center gap-1 bg-[#0B0E14] p-1 rounded-[8px] border border-[#232733]">
                {(['15R', '30R', '60R'] as const).map((tf) => (
                  <button
                    key={tf}
                    type="button"
                    onClick={() => setWindowBars(tf)}
                    className={`px-2.5 py-1 rounded-[6px] text-[11.5px] font-mono-num font-bold cursor-pointer ${
                      windowBars === tf
                        ? 'bg-[#EAECEF] text-[#0B0E14]'
                        : 'text-[#787B86] hover:text-white'
                    }`}
                  >
                    {tf}
                  </button>
                ))}
              </div>

              {/* Tipo de gráfico: Línea vs Velas */}
              <div className="flex items-center gap-1 bg-[#0B0E14] p-1 rounded-[8px] border border-[#232733]">
                {(['Línea', 'Velas'] as const).map((ct) => (
                  <button
                    key={ct}
                    type="button"
                    onClick={() => setChartType(ct)}
                    className={`px-2.5 py-1 rounded-[6px] text-[11.5px] font-bold cursor-pointer ${
                      chartType === ct
                        ? 'bg-[#1F2637] text-[#FFFFFF]'
                        : 'text-[#787B86] hover:text-white'
                    }`}
                  >
                    {ct}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Lienzo SVG Dual con escala dinámica real */}
          <div className="h-72 w-full">
            {chartBars.length === 0 ? (
              <div className="w-full h-full flex items-center justify-center rounded-[10px] bg-[#0B0E14] border border-[#1E222D] text-[12.5px] text-[#787B86] font-mono-num">
                Sin barras históricas disponibles para {stockTicker} (feed {liveMarket.feedStatus}).
              </div>
            ) : (
              <svg viewBox="0 0 680 265" className="w-full h-full overflow-visible">
                {/* Grilla horizontal superior (Precios reales) */}
                {[0, 1, 2, 3].map((idx) => {
                  const frac = idx / 3;
                  const y = priceBottom - frac * priceHeight;
                  const val = minP + frac * (maxP - minP);
                  return (
                    <g key={idx}>
                      <line x1={plotLeft} y1={y} x2={plotRight} y2={y} stroke="#1E222D" strokeWidth="1" />
                      <text
                        x={plotLeft - 8}
                        y={y + 3}
                        textAnchor="end"
                        fill="#787B86"
                        fontSize="10"
                        className="font-mono-num"
                      >
                        ${fmtNum(val, val >= 1000 ? 0 : 1)}
                      </text>
                    </g>
                  );
                })}

                {/* Línea punteada de Cierre Anterior */}
                {Number.isFinite(prevCloseY) && (
                  <line
                    x1={plotLeft}
                    y1={prevCloseY}
                    x2={plotRight}
                    y2={prevCloseY}
                    stroke="#6D7282"
                    strokeWidth="1.2"
                    strokeDasharray="4 4"
                  />
                )}

                {/* Modo LÍNEA */}
                {chartType === 'Línea' && (
                  <>
                    {areaPoints && (
                      <polygon points={areaPoints} fill="#22C55E" fillOpacity="0.12" />
                    )}
                    <polyline fill="none" stroke="#22C55E" strokeWidth="2.4" points={linePoints} />
                  </>
                )}

                {/* Modo VELAS */}
                {chartType === 'Velas' &&
                  chartBars.map((b, i) => {
                    const x = idxToX(i, chartBars.length);
                    const isBull = b.close >= b.open;
                    const color = isBull ? '#22C55E' : '#F23645';
                    const yH = pToY(b.high);
                    const yL = pToY(b.low);
                    const yO = pToY(b.open);
                    const yC = pToY(b.close);
                    return (
                      <g key={b.fullDate}>
                        <line x1={x} y1={yH} x2={x} y2={yL} stroke={color} strokeWidth="1.5" />
                        <rect
                          x={x - candleWidth / 2}
                          y={Math.min(yO, yC)}
                          width={candleWidth}
                          height={Math.max(3, Math.abs(yC - yO))}
                          fill={color}
                          rx="1.5"
                        />
                      </g>
                    );
                  })}

                {/* Media Móvil de 10 ruedas */}
                {smaPoints && (
                  <polyline
                    fill="none"
                    stroke="#EAB308"
                    strokeWidth="1.8"
                    strokeDasharray="4 3"
                    points={smaPoints}
                  />
                )}

                {/* Serie Inferior de Volumen Diario */}
                <line x1={plotLeft} y1="182" x2={plotRight} y2="182" stroke="#232733" strokeWidth="1" />
                {chartBars.map((b, i) => {
                  const x = idxToX(i, chartBars.length);
                  const volH = Number.isFinite(b.volume) ? (b.volume / maxVol) * 52 : 0;
                  const barColor = b.side === 'buy' ? '#22C55E' : '#F23645';
                  const showLabel = i % labelStride === 0 || i === chartBars.length - 1;
                  return (
                    <g key={`vol-${b.fullDate}`}>
                      <rect
                        x={x - candleWidth / 2}
                        y={240 - volH}
                        width={candleWidth}
                        height={volH}
                        fill={barColor}
                        fillOpacity="0.8"
                        rx="1.5"
                      />
                      {showLabel && (
                        <text
                          x={x}
                          y="256"
                          textAnchor="middle"
                          fill="#787B86"
                          fontSize="9.5"
                          className="font-mono-num"
                        >
                          {b.dateLabel}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
            )}
          </div>

          {/* Tira inferior con métricas cuantitativas reales de las ruedas */}
          <div className="pt-3 border-t border-[#232733] grid grid-cols-2 sm:grid-cols-5 gap-2.5">
            {quantStripTiles.map((tile) => (
              <div
                key={tile.label}
                className="p-2.5 rounded-[8px] bg-[#0B0E14] border border-[#1E222D] space-y-1.5"
              >
                <div className="flex items-center justify-between text-[11px] gap-1">
                  <span className="text-[#9CA3AF] font-medium truncate">{tile.label}</span>
                  <span className="font-mono-num font-bold text-[#FFFFFF] whitespace-nowrap">
                    {tile.val}
                  </span>
                </div>
                <div className="w-full h-1.5 rounded-full overflow-hidden flex bg-[#232733]">
                  <div style={{ width: `${tile.barPct}%` }} className={`${tile.barColor} h-full`} />
                </div>
                <div className="flex justify-between text-[10px] font-mono-num text-[#787B86] gap-1">
                  <span className="truncate">{tile.subLeft}</span>
                  <span className="truncate">{tile.subRight}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* CAJA DE PUNTAS NIVEL 2 (L2 5 PUNTAS / TOB L1) + RESUMEN ESTADÍSTICO (4 columnas) */}
        <div className="lg:col-span-4 rounded-[12px] bg-[#131722] border border-[#232733] p-5 flex flex-col justify-between gap-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <h3 className="text-[14.5px] font-bold text-[#FFFFFF]">
                  {orderBook5Levels && orderBook5Levels.source !== 'BYMA_L1_ONLY'
                    ? 'Caja de Puntas Nivel 2 (L2)'
                    : 'Caja de Puntas (L1 BYMA)'}
                </h3>
                <HelpTooltip
                  title="Profundidad de Mercado (L2 / TOB)"
                  text="Caja de 5 puntas en vivo vía Primary MERV / Bull Market HomeBroker, o Top of Book L1 cuando el mercado está cerrado. Click en precio para precargar orden."
                />
              </div>
              <div className="flex items-center gap-1.5">
                {orderBook5Levels && (
                  <span className="px-1.5 py-0.5 rounded bg-[#0B0E14] border border-[#232733] text-[10px] font-mono-num text-[#38BDF8]">
                    {orderBook5Levels.source === 'BMB_HOMEBROKER'
                      ? 'BMB L2'
                      : orderBook5Levels.source === 'PRIMARY_MERV'
                        ? `MERV ${orderBook5Levels.settlement}`
                        : 'BYMA L1'}
                  </span>
                )}
                <span className="text-[11px] font-mono-num text-[#22C55E]">
                  Spread{' '}
                  {orderBook5Levels?.spreadArs != null && Number.isFinite(orderBook5Levels.spreadArs)
                    ? `$ ${fmtNum(orderBook5Levels.spreadArs, 2)}`
                    : Number.isFinite(spreadArs)
                      ? `$ ${fmtNum(spreadArs, 2)}`
                      : '—'}
                </span>
              </div>
            </div>

            {orderBook5Levels &&
              (orderBook5Levels.vwapBook5 !== null || orderBook5Levels.obi5 !== null) && (
                <div className="grid grid-cols-3 gap-2 p-2 rounded-[8px] bg-[#0B0E14] border border-[#1E222D] text-[10.5px] font-mono-num">
                  <div>
                    <div className="text-[#787B86]">Spread %</div>
                    <div className="text-[#FFFFFF] font-semibold">
                      {orderBook5Levels.spreadPct !== null
                        ? `${fmtNum(orderBook5Levels.spreadPct, 2)}%`
                        : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[#787B86]">VWAP 5P</div>
                    <div className="text-[#38BDF8] font-semibold">
                      {orderBook5Levels.vwapBook5 !== null
                        ? `$ ${fmtNum(orderBook5Levels.vwapBook5, 2)}`
                        : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[#787B86]">Desbalance OBI</div>
                    <div
                      className={`font-semibold ${
                        (orderBook5Levels.obi5 ?? 0) >= 0 ? 'text-[#22C55E]' : 'text-[#F23645]'
                      }`}
                    >
                      {orderBook5Levels.obi5 !== null
                        ? `${fmtNum(orderBook5Levels.obi5 * 100, 1)}%`
                        : '—'}
                    </div>
                  </div>
                </div>
              )}

            {orderBook5Levels &&
            (orderBook5Levels.bids.length > 0 || orderBook5Levels.asks.length > 0) &&
            orderBook5Levels.source !== 'BYMA_L1_ONLY' ? (
              <table className="w-full font-mono-num text-[11.5px] border-collapse">
                <thead>
                  <tr className="text-[10px] uppercase text-[#787B86] border-b border-[#232733]">
                    <th className="py-1.5 text-left">Niv</th>
                    <th className="py-1.5 text-right pr-2">Vol Bid</th>
                    <th className="py-1.5 text-right pr-2.5 text-[#22C55E]">Compra</th>
                    <th className="py-1.5 text-left pl-2.5 text-[#F23645]">Venta</th>
                    <th className="py-1.5 text-right">Vol Ask</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1E222D]">
                  {Array.from(
                    {
                      length: Math.min(
                        5,
                        Math.max(orderBook5Levels.bids.length, orderBook5Levels.asks.length),
                      ),
                    },
                    (_, idx) => {
                      const bidLvl = orderBook5Levels.bids[idx];
                      const askLvl = orderBook5Levels.asks[idx];
                      return (
                        <tr key={idx} className="h-8 hover:bg-[#1A202E]">
                          <td className="text-left text-[#787B86]">N{idx + 1}</td>
                          <td className="text-right pr-2 text-[#9CA3AF]">
                            {bidLvl ? bidLvl.size.toLocaleString('es-AR') : '—'}
                          </td>
                          <td
                            onClick={() => {
                              if (bidLvl) {
                                onOpenOrderTicket({
                                  ticker: stockTicker,
                                  side: 'Venta',
                                  price: bidLvl.price,
                                  qty: Math.max(1, Math.round(bidLvl.size || 100)),
                                  instrumentLabel: `${stockName} L2 N${String(idx + 1)}`,
                                });
                              }
                            }}
                            className={`text-right pr-2.5 font-bold text-[#22C55E] ${
                              bidLvl ? 'cursor-pointer hover:brightness-125' : ''
                            }`}
                          >
                            {bidLvl ? `$ ${fmtNum(bidLvl.price, 2)}` : '—'}
                          </td>
                          <td
                            onClick={() => {
                              if (askLvl) {
                                onOpenOrderTicket({
                                  ticker: stockTicker,
                                  side: 'Compra',
                                  price: askLvl.price,
                                  qty: Math.max(1, Math.round(askLvl.size || 100)),
                                  instrumentLabel: `${stockName} L2 N${String(idx + 1)}`,
                                });
                              }
                            }}
                            className={`text-left pl-2.5 font-bold text-[#F23645] border-l border-[#232733] ${
                              askLvl ? 'cursor-pointer hover:brightness-125' : ''
                            }`}
                          >
                            {askLvl ? `$ ${fmtNum(askLvl.price, 2)}` : '—'}
                          </td>
                          <td className="text-right text-[#9CA3AF]">
                            {askLvl ? askLvl.size.toLocaleString('es-AR') : '—'}
                          </td>
                        </tr>
                      );
                    },
                  )}
                </tbody>
              </table>
            ) : (
              <>
                <table className="w-full font-mono-num text-[12px] border-collapse">
                  <thead>
                    <tr className="text-[10px] uppercase text-[#787B86] border-b border-[#232733]">
                      <th className="py-2 text-left">Nivel</th>
                      <th className="py-2 text-right pr-2.5 text-[#22C55E]">Precio Compra</th>
                      <th className="py-2 text-left pl-2.5 text-[#F23645]">Precio Venta</th>
                      <th className="py-2 text-right">Fuente</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1E222D]">
                    <tr className="h-10">
                      <td className="text-left text-[#9CA3AF]">TOB 1</td>
                      <td
                        onClick={() => {
                          if (Number.isFinite(liveBid)) {
                            onOpenOrderTicket({
                              ticker: stockTicker,
                              side: 'Venta',
                              price: liveBid,
                              qty: 100,
                              instrumentLabel: `${stockName} Contado`,
                            });
                          }
                        }}
                        className={`text-right pr-2.5 font-bold text-[#22C55E] ${
                          Number.isFinite(liveBid) ? 'cursor-pointer hover:brightness-125' : ''
                        }`}
                      >
                        {Number.isFinite(liveBid) ? `$ ${fmtNum(liveBid, 2)}` : '—'}
                      </td>
                      <td
                        onClick={() => {
                          if (Number.isFinite(liveAsk)) {
                            onOpenOrderTicket({
                              ticker: stockTicker,
                              side: 'Compra',
                              price: liveAsk,
                              qty: 100,
                              instrumentLabel: `${stockName} Contado`,
                            });
                          }
                        }}
                        className={`text-left pl-2.5 font-bold text-[#F23645] border-l border-[#232733] ${
                          Number.isFinite(liveAsk) ? 'cursor-pointer hover:brightness-125' : ''
                        }`}
                      >
                        {Number.isFinite(liveAsk) ? `$ ${fmtNum(liveAsk, 2)}` : '—'}
                      </td>
                      <td className="text-right text-[#9CA3AF]">
                        {liveStockDto?.source ?? 'BYMA'}
                      </td>
                    </tr>
                  </tbody>
                </table>

                <div className="p-2.5 rounded-[8px] bg-[#0B0E14] border border-[#1E222D] text-[11px] text-[#9CA3AF]">
                  {orderBook5Levels?.source === 'PRIMARY_MERV' &&
                  orderBook5Levels.marketState === 'WEEKEND_CLOSED'
                    ? `Mercado cerrado / sin puntas activas en Primary MERV (${orderBook5Levels.marketSymbol}). Mostrando Top of Book L1 de cierre.`
                    : `Sin libro L2 activo (mercado cerrado o conector BMB pendiente). Top of Book L1 provisto por ${liveStockDto?.source ?? 'BYMA'}.`}
                </div>
              </>
            )}
          </div>

          {/* Resumen estadístico de la rueda */}
          <div className="pt-3 border-t border-[#232733] space-y-2">
            <div className="text-[11px] font-bold uppercase tracking-wider text-[#787B86]">
              Resumen Estadístico de Rueda
            </div>
            <div className="grid grid-cols-2 gap-y-2 gap-x-4 text-[12px]">
              <div className="flex justify-between">
                <span className="text-[#9CA3AF]">Mínimo del día</span>
                <span className="font-mono-num font-bold text-[#FFFFFF]">
                  {Number.isFinite(liveLow) ? `$ ${fmtNum(liveLow, 2)}` : '—'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#9CA3AF]">Máximo del día</span>
                <span className="font-mono-num font-bold text-[#FFFFFF]">
                  {Number.isFinite(liveHigh) ? `$ ${fmtNum(liveHigh, 2)}` : '—'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#9CA3AF]">Volumen total</span>
                <span className="font-mono-num font-bold text-[#FFFFFF]">
                  {fmtMoneyCompact(liveVolumeM)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#9CA3AF]">Opciones listadas</span>
                <span className="font-mono-num font-bold text-[#FFFFFF]">
                  {stockDetail ? String(stockDetail.relatedOptionsCount) : '—'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#9CA3AF]">VWAP del día</span>
                <span className="font-mono-num font-bold text-[#EAB308]">
                  {Number.isFinite(liveVwap) ? `$ ${fmtNum(liveVwap, 2)}` : '—'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#9CA3AF]">vs. Habitual</span>
                <span className="font-mono-num font-bold text-[#22C55E]">
                  {Number.isFinite(liveVolMultiple) ? `${fmtNum(liveVolMultiple, 1)}x` : '—'}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* =====================================================================
          3. MONITOR DE ARBITRAJE ADR & FX
          ===================================================================== */}
      <div className="rounded-[12px] bg-[#131722] border border-[#232733] p-5 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="text-[14.5px] font-bold text-[#FFFFFF]">
            Monitor de Arbitraje ADR &amp; FX ({stockTicker})
          </h3>
          <span className="text-[11px] font-mono-num text-[#787B86]">
            Factor conversión ADR:{' '}
            {Number.isFinite(adrRatio) ? `${adrRatio} acc. locales = 1 ADR NYSE` : 'Sin ADR listado en NYSE'}
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <div className="p-3.5 rounded-[10px] bg-[#0B0E14] border border-[#1E222D] space-y-1">
            <div className="text-[11px] text-[#787B86]">ADR Wall Street (USD)</div>
            <div className="flex items-baseline gap-2">
              <span className="font-mono-num text-[17px] font-bold text-[#FFFFFF]">
                {Number.isFinite(adrUsd) ? `US$ ${fmtNum(adrUsd, 2)}` : '—'}
              </span>
              <DeltaPill value={adrDeltaPct} size="sm" />
            </div>
          </div>

          <div className="p-3.5 rounded-[10px] bg-[#0B0E14] border border-[#1E222D] space-y-1">
            <div className="text-[11px] text-[#787B86]">ADR Teórico en ARS</div>
            <div className="font-mono-num text-[17px] font-bold text-[#38BDF8]">
              {Number.isFinite(adrTheoreticalArs) ? `$ ${fmtNum(adrTheoreticalArs, 2)}` : '—'}
            </div>
            <div className="text-[10.5px] font-mono-num text-[#787B86]">
              Dif. local: {Number.isFinite(adrDiffLocalPct) ? `${fmtNum(adrDiffLocalPct, 2)} %` : '—'}
            </div>
          </div>

          <div className="p-3.5 rounded-[10px] bg-[#0B0E14] border border-[#1E222D] space-y-1">
            <div className="text-[11px] text-[#787B86]">CCL {stockTicker} vs. General</div>
            <div className="font-mono-num text-[17px] font-bold text-[#FFFFFF]">
              {Number.isFinite(cclSpecific) ? `$ ${fmtNum(cclSpecific, 2)}` : '—'}
            </div>
            <div className="text-[10.5px] font-mono-num text-[#22C55E]">
              Canasta CCL: {Number.isFinite(cclGeneral) ? `$ ${fmtNum(cclGeneral, 2)}` : '—'}
            </div>
          </div>

          <div className="p-3.5 rounded-[10px] bg-[#0B0E14] border border-[#1E222D] space-y-1">
            <div className="text-[11px] text-[#787B86]">Dólar MEP (AL30)</div>
            <div className="font-mono-num text-[17px] font-bold text-[#FFFFFF]">
              {Number.isFinite(mepGeneral) ? `$ ${fmtNum(mepGeneral, 2)}` : '—'}
            </div>
            <div className="text-[10.5px] font-mono-num text-[#787B86]">
              Canje CCL/MEP: {Number.isFinite(canjeCclMepPct) ? `${fmtPct(canjeCclMepPct, 2)}` : '—'}
            </div>
          </div>

          <div className="p-3.5 rounded-[10px] bg-[#0B0E14] border border-[#1E222D] space-y-1">
            <div className="text-[11px] text-[#787B86]">Dólar Oficial Mayorista</div>
            <div className="font-mono-num text-[17px] font-bold text-[#FFFFFF]">
              {Number.isFinite(oficialA3500) ? `$ ${fmtNum(oficialA3500, 2)}` : '—'}
            </div>
            <div className="text-[10.5px] font-mono-num text-[#22C55E]">
              Brecha CCL: {Number.isFinite(brechaCclPct) ? `${fmtNum(brechaCclPct, 1)} %` : '—'}
            </div>
          </div>

          <div className="p-3.5 rounded-[10px] bg-[#0B0E14] border border-[#1E222D] space-y-1">
            <div className="text-[11px] text-[#787B86]">DLR Futuro Rofex Prox.</div>
            <div className="font-mono-num text-[17px] font-bold text-[#EAB308]">
              {rofexFrontContract?.price != null && Number.isFinite(rofexFrontContract.price)
                ? `$ ${fmtNum(rofexFrontContract.price, 2)}`
                : '—'}
            </div>
            <div className="text-[10.5px] font-mono-num text-[#9CA3AF]">
              {rofexFrontContract && rofexFrontContract.price != null
                ? `${rofexFrontContract.contract} (${rofexFrontContract.priceBasis})${
                    rofexFrontContract.tnaImplicitaPct != null
                      ? ` · TNA ${fmtNum(rofexFrontContract.tnaImplicitaPct, 1)}%`
                      : ''
                  }`
                : 'Sin cotización ROFEX activa'}
            </div>
          </div>
        </div>
      </div>

      {/* =====================================================================
          4. MICROESTRUCTURA AMT, FVG/FOB, FUERZA RELATIVA Y CONFLUENCIA (< 0.15 ATR)
          ===================================================================== */}
      {(() => {
        const eng = stockDetail?.institutionalEngines ?? null;
        const vp = eng?.volumeProfile;
        const nakedList = eng?.nakedPocs?.activeNakedPocs ?? [];
        const fvgList = eng?.fvgs?.activeFvgs ?? [];
        const fobList = eng?.orderBlocks?.freshOrderBlocks ?? [];
        const clusters = eng?.confluenceClusters?.clusters ?? [];
        const rs = eng?.relativeStrength ?? null;
        const atr14 = eng?.atr14 ?? null;
        const cvdSign = eng?.cvdSlopeSign ?? null;
        return (
          <div className="rounded-[12px] bg-[#131722] border border-[#232733] p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <h3 className="text-[14.5px] font-bold text-[#FFFFFF]">
                  Motores Institucionales AMT · FVG/FOB · Confluencia (&lt; 0,15 ATR)
                </h3>
                <span className="px-2 py-0.5 rounded bg-[#0B0E14] border border-[#232733] font-mono-num text-[10.5px] text-[#38BDF8]">
                  ATR14: {atr14 != null && Number.isFinite(atr14) ? `$ ${fmtNum(atr14, 2)}` : '—'}
                </span>
                <span
                  className={`px-2 py-0.5 rounded font-mono-num text-[10.5px] font-semibold ${
                    cvdSign != null && cvdSign > 0
                      ? 'bg-[#0D221E] text-[#22C55E] border border-[#164E3F]'
                      : cvdSign != null && cvdSign < 0
                        ? 'bg-[#1A1318] text-[#F23645] border border-[#4A2229]'
                        : 'bg-[#0B0E14] text-[#9CA3AF] border border-[#232733]'
                  }`}
                >
                  CVD Flujo: {cvdSign != null && cvdSign > 0 ? 'Comprador (+1)' : cvdSign != null && cvdSign < 0 ? 'Vendedor (-1)' : 'Neutral'}
                </span>
              </div>

              {rs && (
                <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono-num">
                  <span className="text-[#9CA3AF]">
                    RS vs SPY:{' '}
                    <strong className="text-[#FFFFFF]">
                      {rs.rsSpread != null && Number.isFinite(rs.rsSpread) ? fmtPct(rs.rsSpread * 100, 2) : '—'}
                    </strong>{' '}
                    ({rs.rsClassification})
                  </span>
                  {rs.entryBlocked && (
                    <span className="px-2 py-0.5 rounded bg-[#2A151B] border border-[#5B2532] text-[#F23645] font-bold">
                      BLOQUEADO: {rs.blockReason}
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[12px]">
              {/* AMT Volume Profile & Naked POCs */}
              <div className="p-3.5 rounded-[10px] bg-[#0B0E14] border border-[#1E222D] space-y-2">
                <div className="text-[11px] font-bold uppercase tracking-wider text-[#38BDF8]">
                  Auction Market Theory (AMT)
                </div>
                {vp && vp.status === 'OK' ? (
                  <div className="space-y-1.5 font-mono-num">
                    <div className="flex justify-between">
                      <span className="text-[#9CA3AF]">POC Composite</span>
                      <span className="font-bold text-[#EAB308]">
                        {vp.poc != null && Number.isFinite(vp.poc) ? `$ ${fmtNum(vp.poc, 2)}` : '—'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[#9CA3AF]">Área de Valor (VAL – VAH)</span>
                      <span className="text-[#FFFFFF]">
                        {vp.val != null && vp.vah != null
                          ? `$ ${fmtNum(vp.val, 2)} – $ ${fmtNum(vp.vah, 2)}`
                          : '—'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[#9CA3AF]">AVWAP Perfil / HVNs</span>
                      <span className="text-[#D1D4DC]">
                        {vp.profileVwap != null ? `$ ${fmtNum(vp.profileVwap, 2)}` : '—'} · {vp.hvnBins.length} HVN
                      </span>
                    </div>
                    <div className="pt-1 border-t border-[#1E222D] text-[10.5px] text-[#9CA3AF]">
                      Naked POCs activos:{' '}
                      {nakedList.length > 0
                        ? nakedList
                            .slice(-2)
                            .map((np) => `${np.sessionDate} ($${np.sessionPoc != null ? fmtNum(np.sessionPoc, 2) : '—'})`)
                            .join(' · ')
                        : 'Ninguno'}
                    </div>
                  </div>
                ) : (
                  <div className="text-[11.5px] text-[#787B86]">Sin perfil de volumen suficiente (—).</div>
                )}
              </div>

              {/* Microestructura: FVG + Fresh Order Blocks */}
              <div className="p-3.5 rounded-[10px] bg-[#0B0E14] border border-[#1E222D] space-y-2">
                <div className="text-[11px] font-bold uppercase tracking-wider text-[#C084FC]">
                  Microestructura (FVG &amp; FOB)
                </div>
                <div className="space-y-1.5 font-mono-num text-[11.5px]">
                  <div className="text-[#9CA3AF] text-[10.5px]">FVGs Activos ({fvgList.length})</div>
                  {fvgList.slice(-2).map((f) => (
                    <div key={f.id} className="flex justify-between items-center">
                      <span className={f.type === 'BULLISH_FVG' ? 'text-[#22C55E]' : 'text-[#F23645]'}>
                        {f.type === 'BULLISH_FVG' ? '▲ FVG Alcista' : '▼ FVG Bajista'}
                      </span>
                      <span className="text-[#FFFFFF]">
                        {f.gapLow != null && f.gapHigh != null
                          ? `$${fmtNum(f.gapLow, 1)}–$${fmtNum(f.gapHigh, 1)} (CE $${fmtNum(f.consequentEncroachment, 1)})`
                          : '—'}
                      </span>
                    </div>
                  ))}
                  {fvgList.length === 0 && <div className="text-[#787B86]">Sin gaps cuantitativos activos (—)</div>}

                  <div className="pt-1 border-t border-[#1E222D] text-[#9CA3AF] text-[10.5px]">
                    Fresh Order Blocks ({fobList.length})
                  </div>
                  {fobList.slice(-2).map((ob) => (
                    <div key={ob.id} className="flex justify-between items-center">
                      <span className={ob.type === 'BULLISH_FOB' ? 'text-[#22C55E]' : 'text-[#F23645]'}>
                        {ob.type === 'BULLISH_FOB' ? '■ FOB Demanda' : '■ FOB Oferta'}
                      </span>
                      <span className="text-[#FFFFFF]">
                        {ob.anchorPrice != null ? `Ancla $${fmtNum(ob.anchorPrice, 2)}` : '—'}
                      </span>
                    </div>
                  ))}
                  {fobList.length === 0 && <div className="text-[#787B86]">Sin bloques institucionales frescos (—)</div>}
                </div>
              </div>

              {/* Clusters de Confluencia Espacial < 0.15 ATR */}
              <div className="p-3.5 rounded-[10px] bg-[#0B0E14] border border-[#1E222D] space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-[#22C55E]">
                    Confluencia Espacial ({clusters.length})
                  </span>
                  <span className="font-mono-num text-[10.5px] text-[#9CA3AF]">
                    Triples: {eng?.confluenceClusters?.tripleConfluenceCount ?? 0}
                  </span>
                </div>
                {clusters.length === 0 ? (
                  <div className="text-[11.5px] text-[#787B86]">
                    Sin clusters multicapa (&lt; 0,15 ATR) activos para {stockTicker}.
                  </div>
                ) : (
                  <div className="space-y-2 font-mono-num text-[11px]">
                    {clusters.slice(0, 3).map((cl, idx) => (
                      <div
                        key={`${cl.centroidPrice ?? idx}`}
                        className="p-2 rounded bg-[#131722] border border-[#232733] space-y-0.5"
                      >
                        <div className="flex justify-between items-center">
                          <span className="font-bold text-[#FFFFFF]">
                            {cl.centroidPrice != null ? `$ ${fmtNum(cl.centroidPrice, 2)}` : '—'}
                          </span>
                          <span className="text-[#22C55E] font-bold">
                            Fuerza {cl.clusterStrength != null ? fmtNum(cl.clusterStrength, 0) : '—'}/100
                          </span>
                        </div>
                        <div className="flex justify-between text-[10px] text-[#9CA3AF]">
                          <span>
                            {cl.isTripleConfluence ? 'TRIPLE CAPA' : `${cl.distinctCategoriesCount} capas`} ·{' '}
                            {cl.distanceToSpotAtr != null ? `${fmtNum(cl.distanceToSpotAtr, 2)} ATR` : '—'}
                          </span>
                          <span className={cl.triggerAligned ? 'text-[#38BDF8]' : 'text-[#787B86]'}>
                            {cl.triggerAligned ? 'Disparador alineado' : cl.expectedReaction}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
};
