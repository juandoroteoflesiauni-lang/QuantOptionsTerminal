import React, { useEffect, useMemo, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LogicalRange,
  type Time,
  type UTCTimestamp,
  createChart,
} from 'lightweight-charts';
import { fmtNum } from '../../data/marketData';
import type { TerminalTimeframe } from '../../data/liveTypes';
import type { AvwapAnchorMode } from './stockDetailMath';
import type {
  ChartCoordinateMapper,
  ChartKeyLevels,
  HighlightLevelId,
  OverlayVisibilityState,
  StockChartSeriesBundle,
} from './stockDetailTypes';

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

export const MainPriceAmtChart: React.FC<{
  readonly ticker: string;
  readonly timeframe: TerminalTimeframe;
  readonly onChangeTimeframe: (tf: TerminalTimeframe) => void;
  readonly bundle: StockChartSeriesBundle;
  readonly keyLevels: ChartKeyLevels;
  readonly overlays: OverlayVisibilityState;
  readonly onToggleOverlay: (key: keyof OverlayVisibilityState) => void;
  readonly onChangeAvwapMode: (mode: AvwapAnchorMode) => void;
  readonly highlightedLevel: HighlightLevelId;
  readonly currencySymbol: 'ARS' | 'USD';
  readonly loading: boolean;
  readonly hideToolbar?: boolean;
  readonly onCoordinateMapperChange: (mapper: ChartCoordinateMapper | null) => void;
  readonly onLogicalRangeSync: (range: LogicalRange | null) => void;
  readonly onCrosshairTimeSync: (timeSec: number | null) => void;
  readonly externalLogicalRangeRef: React.MutableRefObject<((range: LogicalRange) => void) | null>;
  readonly externalCrosshairTimeRef: React.MutableRefObject<((timeSec: number | null) => void) | null>;
}> = ({
  ticker,
  timeframe,
  onChangeTimeframe,
  bundle,
  keyLevels,
  overlays,
  onToggleOverlay,
  onChangeAvwapMode,
  highlightedLevel,
  currencySymbol,
  loading,
  hideToolbar = false,
  onCoordinateMapperChange,
  onLogicalRangeSync,
  onCrosshairTimeSync,
  externalLogicalRangeRef,
  externalCrosshairTimeRef,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const ema9Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const ema21Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const ema50Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const ema200Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const vwapRef = useRef<ISeriesApi<'Line'> | null>(null);
  const avwapRef = useRef<ISeriesApi<'Line'> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const suppressingRangeEventRef = useRef(false);
  const latestBarsRef = useRef(bundle.bars);
  const keyLevelsRef = useRef(keyLevels);
  const overlaysRef = useRef(overlays);
  const highlightedRef = useRef(highlightedLevel);
  const mapperCbRef = useRef(onCoordinateMapperChange);
  const rangeCbRef = useRef(onLogicalRangeSync);
  const crosshairCbRef = useRef(onCrosshairTimeSync);

  latestBarsRef.current = bundle.bars;
  keyLevelsRef.current = keyLevels;
  overlaysRef.current = overlays;
  highlightedRef.current = highlightedLevel;
  mapperCbRef.current = onCoordinateMapperChange;
  rangeCbRef.current = onLogicalRangeSync;
  crosshairCbRef.current = onCrosshairTimeSync;

  const paintZoneOverlay = useMemo(() => {
    return () => {
      const canvas = overlayCanvasRef.current;
      const chart = chartRef.current;
      const series = candleSeriesRef.current;
      const container = containerRef.current;
      if (!canvas || !chart || !series || !container) {
        mapperCbRef.current(null);
        return;
      }

      const dpr = window.devicePixelRatio || 1;
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width <= 0 || height <= 0) return;

      if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const paneSize = chart.paneSize();
      const plotWidth = paneSize.width || Math.max(0, width - 64);
      const plotHeight = paneSize.height || Math.max(0, height - 28);

      const mapper: ChartCoordinateMapper = {
        containerHeight: height,
        plotHeight,
        priceToY: (p) => {
          const coord = series.priceToCoordinate(p);
          return coord === null ? null : Number(coord);
        },
        yToPrice: (y) => {
          const p = series.coordinateToPrice(y);
          return p === null ? null : Number(p);
        },
        timeToX: (t) => {
          const coord = chart.timeScale().timeToCoordinate(t as UTCTimestamp);
          return coord === null ? null : Number(coord);
        },
      };
      mapperCbRef.current(mapper);

      const ov = overlaysRef.current;
      const kl = keyLevelsRef.current;
      const hl = highlightedRef.current;

      // 1) Sombreado sutil de Value Area (VAL..VAH) si AMT está activo
      if (ov.volumeProfile && kl.vah !== null && kl.val !== null) {
        const yVah = series.priceToCoordinate(kl.vah);
        const yVal = series.priceToCoordinate(kl.val);
        if (yVah !== null && yVal !== null) {
          const topY = Math.min(Number(yVah), Number(yVal));
          const boxH = Math.abs(Number(yVal) - Number(yVah));
          ctx.fillStyle = hl === 'VAH' || hl === 'VAL' || hl === 'POC'
            ? 'rgba(96, 165, 250, 0.11)'
            : 'rgba(96, 165, 250, 0.05)';
          ctx.fillRect(0, topY, plotWidth, boxH);
        }
      }

      // 2) Zonas FVG y Fresh Order Blocks (FOB) vigentes
      if (ov.fvgFob) {
        for (const fvg of kl.fvgs) {
          if (fvg.gapLow === null || fvg.gapHigh === null) continue;
          const yHi = series.priceToCoordinate(fvg.gapHigh);
          const yLo = series.priceToCoordinate(fvg.gapLow);
          if (yHi === null || yLo === null) continue;
          const topY = Math.min(Number(yHi), Number(yLo));
          const h = Math.max(2, Math.abs(Number(yLo) - Number(yHi)));
          const xStartRaw = chart.timeScale().timeToCoordinate(fvg.formedAtTime as UTCTimestamp);
          const xStart = xStartRaw !== null ? Math.max(0, Number(xStartRaw)) : 0;
          const isBull = fvg.type === 'BULLISH_FVG';
          ctx.fillStyle = isBull ? 'rgba(46, 220, 126, 0.12)' : 'rgba(255, 84, 104, 0.12)';
          ctx.fillRect(xStart, topY, Math.max(12, plotWidth - xStart), h);
          ctx.strokeStyle = isBull ? 'rgba(46, 220, 126, 0.45)' : 'rgba(255, 84, 104, 0.45)';
          ctx.lineWidth = 1;
          ctx.strokeRect(xStart + 0.5, topY + 0.5, Math.max(11, plotWidth - xStart - 1), Math.max(1, h - 1));
          ctx.font = '600 9px "Geist Mono", monospace';
          ctx.fillStyle = isBull ? 'rgba(46, 220, 126, 0.9)' : 'rgba(255, 84, 104, 0.9)';
          ctx.fillText(isBull ? 'FVG+' : 'FVG-', xStart + 4, topY + Math.min(11, h - 2));
        }

        for (const ob of kl.orderBlocks) {
          if (ob.zoneLow === null || ob.zoneHigh === null) continue;
          const yHi = series.priceToCoordinate(ob.zoneHigh);
          const yLo = series.priceToCoordinate(ob.zoneLow);
          if (yHi === null || yLo === null) continue;
          const topY = Math.min(Number(yHi), Number(yLo));
          const h = Math.max(3, Math.abs(Number(yLo) - Number(yHi)));
          const xStartRaw = chart.timeScale().timeToCoordinate(ob.formedAtTime as UTCTimestamp);
          const xStart = xStartRaw !== null ? Math.max(0, Number(xStartRaw)) : 0;
          const isBull = ob.type === 'BULLISH_FOB';
          ctx.fillStyle = isBull ? 'rgba(139, 124, 246, 0.16)' : 'rgba(245, 181, 68, 0.15)';
          ctx.fillRect(xStart, topY, Math.max(16, plotWidth - xStart), h);
          ctx.strokeStyle = isBull ? 'rgba(139, 124, 246, 0.6)' : 'rgba(245, 181, 68, 0.6)';
          ctx.lineWidth = 1;
          ctx.strokeRect(xStart + 0.5, topY + 0.5, Math.max(15, plotWidth - xStart - 1), Math.max(2, h - 1));
          ctx.font = '600 9px "Geist Mono", monospace';
          ctx.fillStyle = isBull ? 'rgba(196, 184, 255, 0.95)' : 'rgba(245, 181, 68, 0.95)';
          ctx.fillText(isBull ? 'FOB DEMAND' : 'FOB SUPPLY', xStart + 4, topY + Math.min(11, Math.max(9, h - 2)));
        }
      }
    };
  }, []);

  // Montaje único del Chart 1 Lightweight Charts v5
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: '#08080D' },
        textColor: '#8B92AD',
        fontFamily: '"Geist Mono", ui-monospace, monospace',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#14141F' },
        horzLines: { color: '#14141F' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#535A7A', style: LineStyle.Dashed, width: 1, labelBackgroundColor: '#1E1E2E' },
        horzLine: { color: '#535A7A', style: LineStyle.Dashed, width: 1, labelBackgroundColor: '#1E1E2E' },
      },
      rightPriceScale: {
        borderColor: '#1E1E2B',
        scaleMargins: { top: 0.08, bottom: 0.22 },
      },
      timeScale: {
        borderColor: '#1E1E2B',
        timeVisible: true,
        secondsVisible: false,
      },
      width: el.clientWidth,
      height: 390,
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

    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    });
    chart.priceScale('').applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    const ema9 = chart.addSeries(LineSeries, { color: '#38BDF8', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const ema21 = chart.addSeries(LineSeries, { color: '#8B7CF6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const ema50 = chart.addSeries(LineSeries, { color: '#F5B544', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const ema200 = chart.addSeries(LineSeries, { color: '#FF5468', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const vwap = chart.addSeries(LineSeries, { color: '#FACC15', lineWidth: 2, lineStyle: LineStyle.Solid, priceLineVisible: false, lastValueVisible: false });
    const avwap = chart.addSeries(LineSeries, { color: '#C084FC', lineWidth: 2, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false });

    chartRef.current = chart;
    candleSeriesRef.current = candles;
    volumeSeriesRef.current = volume;
    ema9Ref.current = ema9;
    ema21Ref.current = ema21;
    ema50Ref.current = ema50;
    ema200Ref.current = ema200;
    vwapRef.current = vwap;
    avwapRef.current = avwap;

    const scheduleOverlayPaint = () => {
      window.requestAnimationFrame(paintZoneOverlay);
    };

    const handleVisibleRangeChange = (range: LogicalRange | null) => {
      scheduleOverlayPaint();
      if (suppressingRangeEventRef.current) return;
      rangeCbRef.current(range);
    };

    const handleCrosshairMove = (param: { readonly time?: Time }) => {
      if (param.time !== undefined && typeof param.time === 'number') {
        crosshairCbRef.current(param.time);
      } else {
        crosshairCbRef.current(null);
      }
    };

    chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleRangeChange);
    chart.subscribeCrosshairMove(handleCrosshairMove);

    const resizeObserver = new ResizeObserver(() => {
      if (!containerRef.current) return;
      chart.applyOptions({ width: containerRef.current.clientWidth, height: 390 });
      scheduleOverlayPaint();
    });
    resizeObserver.observe(el);

    const onPointerInteraction = () => scheduleOverlayPaint();
    el.addEventListener('pointerup', onPointerInteraction);
    el.addEventListener('wheel', onPointerInteraction, { passive: true });

    externalLogicalRangeRef.current = (range: LogicalRange) => {
      suppressingRangeEventRef.current = true;
      try {
        chart.timeScale().setVisibleLogicalRange(range);
        scheduleOverlayPaint();
      } finally {
        window.requestAnimationFrame(() => {
          suppressingRangeEventRef.current = false;
        });
      }
    };

    externalCrosshairTimeRef.current = (timeSec: number | null) => {
      if (timeSec === null) {
        chart.clearCrosshairPosition();
        return;
      }
      const match = latestBarsRef.current.find((b) => b.time === timeSec);
      if (match) {
        chart.setCrosshairPosition(match.close, timeSec as UTCTimestamp, candles);
      }
    };

    return () => {
      el.removeEventListener('pointerup', onPointerInteraction);
      el.removeEventListener('wheel', onPointerInteraction);
      resizeObserver.disconnect();
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleVisibleRangeChange);
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      externalLogicalRangeRef.current = null;
      externalCrosshairTimeRef.current = null;
    };
  }, [paintZoneOverlay, externalLogicalRangeRef, externalCrosshairTimeRef]);

  // Actualización de velas, volumen y curvas superpuestas
  useEffect(() => {
    const chart = chartRef.current;
    const candles = candleSeriesRef.current;
    const volume = volumeSeriesRef.current;
    if (!chart || !candles || !volume) return;

    chart.applyOptions({
      timeScale: {
        timeVisible: timeframe !== '1D',
        secondsVisible: false,
      },
    });

    if (!bundle.barsAvailable || bundle.bars.length === 0) {
      candles.setData([]);
      volume.setData([]);
      ema9Ref.current?.setData([]);
      ema21Ref.current?.setData([]);
      ema50Ref.current?.setData([]);
      ema200Ref.current?.setData([]);
      vwapRef.current?.setData([]);
      avwapRef.current?.setData([]);
      mapperCbRef.current(null);
      return;
    }

    candles.setData(
      bundle.bars.map((b) => ({
        time: b.time as UTCTimestamp,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      })),
    );

    volume.setData(
      bundle.bars.map((b) => ({
        time: b.time as UTCTimestamp,
        value: b.volume,
        color: b.close >= b.open ? 'rgba(46, 220, 126, 0.28)' : 'rgba(255, 84, 104, 0.28)',
      })),
    );

    const toLineData = (vals: readonly (number | null)[]) =>
      bundle.bars
        .map((b, i) => {
          const v = vals[i];
          return v !== undefined && v !== null && Number.isFinite(v)
            ? { time: b.time as UTCTimestamp, value: v }
            : null;
        })
        .filter((d): d is { readonly time: UTCTimestamp; readonly value: number } => d !== null);

    ema9Ref.current?.setData(overlays.emas ? toLineData(bundle.ema9) : []);
    ema21Ref.current?.setData(overlays.emas ? toLineData(bundle.ema21) : []);
    ema50Ref.current?.setData(overlays.emas ? toLineData(bundle.ema50) : []);
    ema200Ref.current?.setData(overlays.emas ? toLineData(bundle.ema200) : []);
    vwapRef.current?.setData(
      overlays.sessionVwap && timeframe !== '1D' ? toLineData(bundle.sessionVwap) : [],
    );
    avwapRef.current?.setData(overlays.avwap ? toLineData(bundle.avwapSeries) : []);

    chart.timeScale().fitContent();
    window.requestAnimationFrame(paintZoneOverlay);
  }, [bundle, overlays, timeframe, paintZoneOverlay]);

  // Muros de opciones (Call Wall, Put Wall, Zero-Gamma) + Niveles AMT (POC/VAH/VAL/NPOCs) vía createPriceLine nativas
  useEffect(() => {
    const candles = candleSeriesRef.current;
    if (!candles) return;

    for (const pl of priceLinesRef.current) {
      candles.removePriceLine(pl);
    }
    priceLinesRef.current = [];

    if (!bundle.barsAvailable || bundle.bars.length === 0) return;

    const addLine = (
      price: number | null,
      title: string,
      color: string,
      style: LineStyle,
      isHighlighted: boolean,
    ) => {
      if (price === null || !Number.isFinite(price) || price <= 0) return;
      const pl = candles.createPriceLine({
        price,
        color,
        lineWidth: isHighlighted ? 3 : 2,
        lineStyle: style,
        axisLabelVisible: true,
        title,
      });
      priceLinesRef.current.push(pl);
    };

    const pxPrefix = currencySymbol === 'USD' ? 'US$' : '$';
    if (overlays.optionWalls) {
      addLine(
        keyLevels.callWall,
        `CALL WALL · ${pxPrefix}${fmtNum(keyLevels.callWall, 0)}`,
        '#2EDC7E',
        LineStyle.Dashed,
        highlightedLevel === 'CALL_WALL',
      );
      addLine(
        keyLevels.putWall,
        `PUT WALL · ${pxPrefix}${fmtNum(keyLevels.putWall, 0)}`,
        '#FF5468',
        LineStyle.Dashed,
        highlightedLevel === 'PUT_WALL',
      );
      addLine(
        keyLevels.zeroGamma,
        `ZERO-GAMMA · ${pxPrefix}${fmtNum(keyLevels.zeroGamma, 2)}`,
        highlightedLevel === 'ZERO_GAMMA' ? '#C4B5FD' : '#A78BFA',
        LineStyle.Dotted,
        highlightedLevel === 'ZERO_GAMMA',
      );
    }

    if (overlays.volumeProfile) {
      addLine(
        keyLevels.poc,
        `POC · ${pxPrefix}${fmtNum(keyLevels.poc, 2)}`,
        '#FACC15',
        LineStyle.Solid,
        highlightedLevel === 'POC',
      );
      addLine(
        keyLevels.vah,
        `VAH`,
        '#60A5FA',
        LineStyle.SparseDotted,
        highlightedLevel === 'VAH',
      );
      addLine(
        keyLevels.val,
        `VAL`,
        '#60A5FA',
        LineStyle.SparseDotted,
        highlightedLevel === 'VAL',
      );
    }

    if (overlays.nakedPocs) {
      for (const np of keyLevels.nakedPocs.slice(0, 6)) {
        addLine(np.price, `nPOC ${np.sessionDate.slice(5)}`, '#FB923C', LineStyle.Dotted, false);
      }
    }

    window.requestAnimationFrame(paintZoneOverlay);
  }, [
    bundle.barsAvailable,
    bundle.bars.length,
    overlays.optionWalls,
    overlays.volumeProfile,
    overlays.nakedPocs,
    overlays.fvgFob,
    keyLevels,
    highlightedLevel,
    currencySymbol,
    paintZoneOverlay,
  ]);

  return (
    <div className="flex flex-col h-full">
      {!hideToolbar && (
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b border-[#1E1E2B] bg-[#0D0D14]">
        <div className="flex items-center gap-1">
          {TIMEFRAMES.map((tf) => {
            const active = timeframe === tf.id;
            return (
              <button
                key={tf.id}
                type="button"
                onClick={() => onChangeTimeframe(tf.id)}
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
              Cargando...
            </span>
          )}
        </div>

        {/* Toggles de Overlays */}
        <div className="flex flex-wrap items-center gap-1.5">
          <OverlayToggleChip
            active={overlays.emas}
            label="EMAs 9/21/50/200"
            onClick={() => onToggleOverlay('emas')}
          />
          <OverlayToggleChip
            active={overlays.sessionVwap && timeframe !== '1D'}
            disabled={timeframe === '1D'}
            label={timeframe === '1D' ? 'VWAP (solo intradiario)' : 'VWAP Sesión'}
            onClick={() => onToggleOverlay('sessionVwap')}
          />
          <div className="inline-flex items-center rounded-[6px] border border-[#252536] bg-[#14141F] overflow-hidden">
            <button
              type="button"
              onClick={() => onToggleOverlay('avwap')}
              className={`px-2 py-1 text-[11px] font-medium transition-colors ${
                overlays.avwap ? 'bg-[#C084FC]/25 text-[#E5C9FF]' : 'text-[#848BA8] hover:text-white'
              }`}
            >
              AVWAP
            </button>
            <select
              aria-label="Anclaje AVWAP"
              value={bundle.avwapMode}
              onChange={(e) => onChangeAvwapMode(e.target.value as AvwapAnchorMode)}
              className="bg-[#11111A] border-l border-[#252536] px-1.5 py-1 text-[10px] font-mono-num text-[#CBD0E4] focus:outline-none"
            >
              {AVWAP_MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <OverlayToggleChip
            active={overlays.volumeProfile}
            label="VP (POC/VAH/VAL)"
            onClick={() => onToggleOverlay('volumeProfile')}
          />
          <OverlayToggleChip
            active={overlays.nakedPocs}
            label="Naked POCs"
            onClick={() => onToggleOverlay('nakedPocs')}
          />
          <OverlayToggleChip
            active={overlays.fvgFob}
            label="FVG & FOB"
            onClick={() => onToggleOverlay('fvgFob')}
          />
          <OverlayToggleChip
            active={overlays.optionWalls}
            label="Walls GEX"
            onClick={() => onToggleOverlay('optionWalls')}
          />
        </div>
      </div>
      )}

      {/* Leyenda Compacta de Overlays (altura fija sincronizada con Chart 2) */}
      <div className="flex flex-wrap items-center gap-3 px-3 h-[28px] overflow-hidden bg-[#0A0A10] border-b border-[#171722] text-[10px] font-mono-num text-[#8B92AD]">
        {overlays.emas ? (
          <>
            <span className="inline-flex items-center gap-1">
              <span className="w-2.5 h-0.5 bg-[#38BDF8]" /> EMA 9
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="w-2.5 h-0.5 bg-[#8B7CF6]" /> EMA 21
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="w-2.5 h-0.5 bg-[#F5B544]" /> EMA 50
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="w-2.5 h-0.5 bg-[#FF5468]" /> EMA 200
            </span>
          </>
        ) : (
          <span className="text-[#5E6580]">EMAs ocultas</span>
        )}
        {overlays.avwap && (
          <span className="inline-flex items-center gap-1 text-[#D8B4FE]">
            <span className="w-2.5 h-0.5 border-t border-dashed border-[#C084FC]" /> AVWAP (
            {AVWAP_MODES.find((m) => m.id === bundle.avwapMode)?.label})
            {!bundle.avwapAnchorAvailable && ' · Sin fecha reportada'}
          </span>
        )}
      </div>

      {/* Área Canvas TradingView Lightweight Charts + Overlay SVG/Canvas */}
      <div className="relative flex-1 min-h-[390px]">
        <div ref={containerRef} className="w-full h-[390px]" />
        <canvas
          ref={overlayCanvasRef}
          className="pointer-events-none absolute inset-0"
        />
        {bundle.intradayUnavailableReason && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#08080D]/92 px-6 text-center z-10">
            <span className="text-[13px] font-semibold text-[#E5E8F5] mb-1">
              {bundle.intradayUnavailableReason}
            </span>
            <span className="text-[11px] text-[#7E85A3] mb-3">
              Política Zero Silent Fallbacks: no se sintetizan velas intradiarias sin fuente real.
            </span>
            <button
              type="button"
              onClick={() => onChangeTimeframe('1D')}
              className="px-3 py-1.5 rounded-[7px] bg-[#8B7CF6] text-white text-[12px] font-semibold hover:bg-[#7A6AE8] transition-colors"
            >
              Volver a Temporalidad 1D ({ticker})
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

const OverlayToggleChip: React.FC<{
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
