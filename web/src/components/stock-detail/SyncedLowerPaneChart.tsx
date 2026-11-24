import React, { memo, useEffect, useMemo, useRef } from 'react';
import {
  BaselineSeries,
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
import { fmtNum, fmtPct } from '../../data/marketData';
import type { TerminalTimeframe } from '../../data/liveTypes';
import {
  resolveChartFitKey,
  resolveChartViewportTransition,
  shouldApplyExternalLogicalRange,
  shouldEmitLogicalRangeSync,
} from '../../../../src/core/stockDetailChartNavigation';
import {
  computeLeeReadyBarFlow,
  computeRelativeStrengthSeries,
  computeRollingRvSeries,
} from './stockDetailMath';
import type {
  LowerPaneMode,
  StockChartSeriesBundle,
} from './stockDetailTypes';

const EMPTY_FLOW_POINTS: ReturnType<typeof computeLeeReadyBarFlow> = [];
const EMPTY_RS_POINTS: ReturnType<typeof computeRelativeStrengthSeries> = [];
const EMPTY_RV_SERIES: readonly number[] = [];

export const SyncedLowerPaneChart: React.FC<{
  readonly ticker: string;
  readonly market: 'AR' | 'US';
  readonly timeframe: TerminalTimeframe;
  readonly mode: LowerPaneMode;
  readonly onChangeMode: (mode: LowerPaneMode) => void;
  readonly bundle: StockChartSeriesBundle;
  readonly onLogicalRangeSync: (range: LogicalRange | null) => void;
  readonly onCrosshairTimeSync: (timeSec: number | null) => void;
  readonly externalLogicalRangeRef: React.MutableRefObject<((range: LogicalRange) => void) | null>;
  readonly externalCrosshairTimeRef: React.MutableRefObject<((timeSec: number | null) => void) | null>;
  readonly getMainVisibleLogicalRange?: () => LogicalRange | null;
}> = memo(({
  ticker,
  market,
  timeframe,
  mode,
  onChangeMode,
  bundle,
  onLogicalRangeSync,
  onCrosshairTimeSync,
  externalLogicalRangeRef,
  externalCrosshairTimeRef,
  getMainVisibleLogicalRange,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const histSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const lineSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const baselineSeriesRef = useRef<ISeriesApi<'Baseline'> | null>(null);
  const ivPriceLineRef = useRef<IPriceLine | null>(null);
  const suppressingRangeEventRef = useRef(false);
  const pendingExternalRangeRef = useRef<LogicalRange | null>(null);
  const activeSeriesHasValuesRef = useRef(false);
  const applyExternalRangeRef = useRef<((range: LogicalRange) => void) | null>(null);
  const latestBarsRef = useRef(bundle.bars);
  const modeRef = useRef(mode);
  const prevModeRef = useRef<LowerPaneMode>(mode);
  const rangeCbRef = useRef(onLogicalRangeSync);
  const crosshairCbRef = useRef(onCrosshairTimeSync);
  const getMainRangeCbRef = useRef(getMainVisibleLogicalRange);
  const lastFitStateRef = useRef<{
    key: string | null;
    barCount: number;
    firstBarTime: number | null;
    lastBarTime: number | null;
  }>({ key: null, barCount: 0, firstBarTime: null, lastBarTime: null });

  latestBarsRef.current = bundle.bars;
  modeRef.current = mode;
  rangeCbRef.current = onLogicalRangeSync;
  crosshairCbRef.current = onCrosshairTimeSync;
  getMainRangeCbRef.current = getMainVisibleLogicalRange;

  const flowPoints = useMemo(
    () => (mode === 'CVD' ? computeLeeReadyBarFlow(bundle.bars) : EMPTY_FLOW_POINTS),
    [bundle.bars, mode],
  );
  const rsPoints = useMemo(
    () => (mode === 'RS' ? computeRelativeStrengthSeries(bundle.bars, bundle.benchmarkBars1d, true) : EMPTY_RS_POINTS),
    [bundle.bars, bundle.benchmarkBars1d, mode],
  );
  const rollingRvSeries = useMemo(
    () => (mode === 'VOLATILITY' && timeframe === '1D' ? computeRollingRvSeries(bundle.bars, 30, 252) : EMPTY_RV_SERIES),
    [bundle.bars, mode, timeframe],
  );

  const latestFlow = flowPoints[flowPoints.length - 1];
  const latestRs = [...rsPoints].reverse().find((p) => Number.isFinite(p.rsNormalizedPct));
  const latestRv30FromSeries = [...rollingRvSeries].reverse().find((v) => Number.isFinite(v)) ?? null;
  const effectiveRv30 = latestRv30FromSeries ?? bundle.rv30Pct;
  const effectiveVrp =
    bundle.ivAtmPct !== null && effectiveRv30 !== null && Number.isFinite(bundle.ivAtmPct) && Number.isFinite(effectiveRv30)
      ? bundle.ivAtmPct - effectiveRv30
      : bundle.vrpPct;

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
        scaleMargins: { top: 0.14, bottom: 0.12 },
      },
      timeScale: {
        borderColor: '#1E1E2B',
        timeVisible: true,
        secondsVisible: false,
        enableConflation: true,
        conflationThresholdFactor: 1.0,
        precomputeConflationOnInit: false,
      },
      autoSize: false,
      width: Math.max(1, Math.floor(el.clientWidth)),
      height: 190,
    });

    const hist = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    });
    chart.priceScale('').applyOptions({
      scaleMargins: { top: 0.55, bottom: 0 },
    });

    const line = chart.addSeries(LineSeries, {
      color: '#38BDF8',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });

    const baseline = chart.addSeries(BaselineSeries, {
      baseValue: { type: 'price', price: 0 },
      topLineColor: '#2EDC7E',
      topFillColor1: 'rgba(46, 220, 126, 0.25)',
      topFillColor2: 'rgba(46, 220, 126, 0.03)',
      bottomLineColor: '#FF5468',
      bottomFillColor1: 'rgba(255, 84, 104, 0.03)',
      bottomFillColor2: 'rgba(255, 84, 104, 0.25)',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });

    chartRef.current = chart;
    histSeriesRef.current = hist;
    lineSeriesRef.current = line;
    baselineSeriesRef.current = baseline;
    ivPriceLineRef.current = line.createPriceLine({
      price: 0,
      color: '#8B7CF6',
      lineWidth: 2,
      lineStyle: LineStyle.Dashed,
      lineVisible: false,
      axisLabelVisible: false,
      title: 'IV ATM',
    });

    const handleVisibleRangeChange = (range: LogicalRange | null) => {
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

    const handleCrosshairMove = (param: { readonly time?: Time }) => {
      if (param.time !== undefined && typeof param.time === 'number') {
        crosshairCbRef.current(param.time);
      } else {
        crosshairCbRef.current(null);
      }
    };

    chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleRangeChange);
    chart.subscribeCrosshairMove(handleCrosshairMove);

    let resizeRafId: number | null = null;
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      const inlineSize = entry?.contentBoxSize?.[0]?.inlineSize ?? containerRef.current?.clientWidth ?? 0;
      const w = Math.floor(inlineSize);
      if (w <= 0) return;
      if (resizeRafId !== null) window.cancelAnimationFrame(resizeRafId);
      resizeRafId = window.requestAnimationFrame(() => {
        resizeRafId = null;
        chart.resize(w, 190);
      });
    });
    resizeObserver.observe(el);

    const applyExternalRange = (range: LogicalRange) => {
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
    applyExternalRangeRef.current = applyExternalRange;
    externalLogicalRangeRef.current = applyExternalRange;

    externalCrosshairTimeRef.current = (timeSec: number | null) => {
      const m = modeRef.current;
      const targetSeries = m === 'RS' ? baseline : line;
      if (timeSec === null) {
        chart.clearCrosshairPosition();
        return;
      }
      if (!activeSeriesHasValuesRef.current) return;
      const match = latestBarsRef.current.find((b) => b.time === timeSec);
      if (!match || chart.timeScale().timeToIndex(timeSec as UTCTimestamp, false) === null) return;
      try {
        chart.setCrosshairPosition(0, timeSec as UTCTimestamp, targetSeries);
      } catch {
        // Ignorar si la serie activa aún no tiene escala inicializada
      }
    };

    return () => {
      if (resizeRafId !== null) window.cancelAnimationFrame(resizeRafId);
      resizeObserver.disconnect();
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleVisibleRangeChange);
      chart.remove();
      chartRef.current = null;
      histSeriesRef.current = null;
      lineSeriesRef.current = null;
      baselineSeriesRef.current = null;
      ivPriceLineRef.current = null;
      applyExternalRangeRef.current = null;
      externalLogicalRangeRef.current = null;
      externalCrosshairTimeRef.current = null;
      activeSeriesHasValuesRef.current = false;
      lastFitStateRef.current = { key: null, barCount: 0, firstBarTime: null, lastBarTime: null };
    };
  }, [externalLogicalRangeRef, externalCrosshairTimeRef]);

  useEffect(() => {
    chartRef.current?.applyOptions({
      timeScale: { timeVisible: timeframe !== '1D' && timeframe !== '1W', secondsVisible: false },
    });
  }, [timeframe]);

  // Alimentar datos manteniendo índice lógico 1:1 con Chart 1 mediante whitespace items
  useEffect(() => {
    const chart = chartRef.current;
    const hist = histSeriesRef.current;
    const line = lineSeriesRef.current;
    const baseline = baselineSeriesRef.current;
    if (!chart || !hist || !line || !baseline) return;

    const firstBarTime = bundle.bars[0]?.time ?? null;
    const lastBarTime = bundle.bars[bundle.bars.length - 1]?.time ?? null;
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

    if (!bundle.barsAvailable || bundle.bars.length === 0) {
      activeSeriesHasValuesRef.current = false;
      hist.setData([]);
      line.setData([]);
      baseline.setData([]);
      ivPriceLineRef.current?.applyOptions({
        price: 0,
        lineVisible: false,
        axisLabelVisible: false,
        title: 'IV ATM',
      });
      return;
    }

    // Poblar la serie activa antes de vaciar las inactivas para que el
    // timeScale nunca quede sin puntos y preserve el rango visible al cambiar de modo.
    let showIvLine = false;
    if (mode === 'CVD') {
      line.applyOptions({
        color: '#38BDF8',
        priceFormat: { type: 'volume' },
      });
      hist.setData(
        flowPoints.map((pt) =>
          Number.isFinite(pt.barDelta)
            ? {
                time: pt.time as UTCTimestamp,
                value: pt.barDelta,
                color:
                  pt.barDelta >= 0
                    ? 'rgba(46, 220, 126, 0.55)'
                    : 'rgba(255, 84, 104, 0.55)',
              }
            : { time: pt.time as UTCTimestamp },
        ),
      );
      line.setData(
        flowPoints.map((pt) =>
          Number.isFinite(pt.cvd)
            ? { time: pt.time as UTCTimestamp, value: pt.cvd }
            : { time: pt.time as UTCTimestamp },
        ),
      );
      baseline.setData([]);
      activeSeriesHasValuesRef.current = flowPoints.some((pt) => Number.isFinite(pt.cvd));
    } else if (mode === 'RS') {
      baseline.applyOptions({
        priceFormat: { type: 'percent', precision: 2, minMove: 0.01 },
      });
      const rsByTime = new Map(rsPoints.map((r) => [r.time, r.rsNormalizedPct]));
      baseline.setData(
        bundle.bars.map((b) => {
          const val = rsByTime.get(b.time);
          return val !== undefined && Number.isFinite(val)
            ? { time: b.time as UTCTimestamp, value: val }
            : { time: b.time as UTCTimestamp };
        }),
      );
      hist.setData([]);
      line.setData([]);
      activeSeriesHasValuesRef.current = rsPoints.some((r) => Number.isFinite(r.rsNormalizedPct));
    } else {
      // VOLATILITY: RV 30D (%) curva + línea horizontal IV ATM (%)
      line.applyOptions({
        color: '#F5B544',
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      });
      line.setData(
        bundle.bars.map((b, i) => {
          const rv = rollingRvSeries[i];
          return rv !== undefined && Number.isFinite(rv)
            ? { time: b.time as UTCTimestamp, value: rv }
            : { time: b.time as UTCTimestamp };
        }),
      );
      hist.setData([]);
      baseline.setData([]);
      activeSeriesHasValuesRef.current = rollingRvSeries.some(
        (rv) => rv !== undefined && Number.isFinite(rv),
      );
      if (bundle.ivAtmPct !== null && Number.isFinite(bundle.ivAtmPct) && bundle.ivAtmPct > 0) {
        showIvLine = true;
      }
    }

    if (showIvLine && bundle.ivAtmPct !== null) {
      ivPriceLineRef.current?.applyOptions({
        price: bundle.ivAtmPct,
        lineVisible: true,
        axisLabelVisible: true,
        title: `IV ATM ${fmtNum(bundle.ivAtmPct, 1)}%`,
      });
    } else {
      ivPriceLineRef.current?.applyOptions({
        price: 0,
        lineVisible: false,
        axisLabelVisible: false,
        title: 'IV ATM',
      });
    }

    const modeChanged = prevModeRef.current !== mode;
    prevModeRef.current = mode;
    const mainRange = getMainRangeCbRef.current?.() ?? null;
    if (modeChanged && !transition.shouldFitContent && mainRange !== null) {
      // Al cambiar de modo (CVD/RS/VOL), el ancho del eje derecho puede variar
      // en el RAF de dibujo; suprimimos ese micro-ajuste y re-alineamos con el principal.
      suppressingRangeEventRef.current = true;
      pendingExternalRangeRef.current = mainRange;
      window.requestAnimationFrame(() => {
        applyExternalRangeRef.current?.(mainRange);
        window.requestAnimationFrame(() => {
          suppressingRangeEventRef.current = false;
          pendingExternalRangeRef.current = null;
        });
      });
    } else if (!transition.shouldFitContent && mainRange !== null) {
      applyExternalRangeRef.current?.(mainRange);
    } else if (transition.shouldFitContent) {
      suppressingRangeEventRef.current = true;
      try {
        if (getMainRangeCbRef.current === undefined) {
          chart.timeScale().fitContent();
        }
      } finally {
        window.requestAnimationFrame(() => {
          suppressingRangeEventRef.current = false;
        });
      }
    }
  }, [bundle, ticker, timeframe, mode, flowPoints, rsPoints, rollingRvSeries]);

  const modes: readonly { readonly id: LowerPaneMode; readonly label: string }[] = [
    { id: 'CVD', label: 'CVD Lee-Ready (Flujo Agresor)' },
    {
      id: 'RS',
      label: market === 'AR' ? 'Fuerza Relativa (vs. SPY CEDEAR)' : 'Fuerza Relativa (RS vs. SPY)',
    },
    { id: 'VOLATILITY', label: 'Volatilidad (IV ATM vs. RV 30D · VRP)' },
  ];

  return (
    <section className="rounded-[12px] bg-[#11111A] border border-[#1E1E2B] overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b border-[#1E1E2B] bg-[#0D0D14]">
        <div className="flex flex-wrap items-center gap-1.5">
          {modes.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onChangeMode(m.id)}
              className={`px-2.5 py-1 rounded-[7px] text-[11px] font-semibold transition-colors ${
                mode === m.id
                  ? 'bg-[#8B7CF6] text-white'
                  : 'bg-[#161622] text-[#8E95B3] hover:text-white hover:bg-[#1E1E2E]'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* KPIs en vivo del modo activo */}
        <div className="flex flex-wrap items-center gap-4 font-mono-num text-[11px]">
          {mode === 'CVD' && (
            <>
              <span className="text-[#2EDC7E]">
                Comprador:{' '}
                {latestFlow && Number.isFinite(latestFlow.buyerPct)
                  ? `${fmtNum(latestFlow.buyerPct, 1)}%`
                  : '—'}
              </span>
              <span className="text-[#FF5468]">
                Vendedor:{' '}
                {latestFlow && Number.isFinite(latestFlow.sellerPct)
                  ? `${fmtNum(latestFlow.sellerPct, 1)}%`
                  : '—'}
              </span>
              <span className="text-[#38BDF8]">
                CVD Acum.:{' '}
                {latestFlow && Number.isFinite(latestFlow.cvd)
                  ? fmtNum(latestFlow.cvd, 0)
                  : '—'}
              </span>
            </>
          )}
          {mode === 'RS' && (
            <>
              <span className="text-[#CBD0E4]">
                Spread RS ({ticker}):{' '}
                <strong
                  className={
                    latestRs && latestRs.rsNormalizedPct >= 0
                      ? 'text-[#2EDC7E]'
                      : 'text-[#FF5468]'
                  }
                >
                  {latestRs ? fmtPct(latestRs.rsNormalizedPct, 2) : '—'}
                </strong>
              </span>
              <span className="text-[#7E85A3]">
                Ratio: {latestRs ? fmtNum(latestRs.rsRatio, 4) : '—'}
              </span>
            </>
          )}
          {mode === 'VOLATILITY' && (
            <>
              <span className="text-[#C8BCFF]">
                IV ATM:{' '}
                {bundle.ivAtmPct !== null && Number.isFinite(bundle.ivAtmPct)
                  ? `${fmtNum(bundle.ivAtmPct, 2)} %`
                  : '—'}
              </span>
              <span className="text-[#F5B544]">
                RV 30D:{' '}
                {effectiveRv30 !== null && Number.isFinite(effectiveRv30)
                  ? `${fmtNum(effectiveRv30, 2)} %`
                  : '—'}
              </span>
              <span
                className={
                  effectiveVrp === null
                    ? 'text-[#787B86]'
                    : effectiveVrp > 0
                    ? 'text-[#F5B544]'
                    : 'text-[#2EDC7E]'
                }
              >
                VRP (IV−RV):{' '}
                {effectiveVrp !== null && Number.isFinite(effectiveVrp)
                  ? fmtPct(effectiveVrp, 2)
                  : '—'}
              </span>
            </>
          )}
        </div>
      </div>

      <div className="relative h-[190px]">
        <div ref={containerRef} className="w-full h-[190px]" />
        {mode === 'VOLATILITY' && timeframe !== '1D' && (
          <div className="pointer-events-none absolute top-2 left-3 px-2 py-1 rounded bg-[#141422]/85 border border-[#252536] text-[10px] font-mono-num text-[#9DA4C2]">
            La serie móvil RV 30D se grafica sobre ruedas diarias (cambiar a 1D para histórico completo).
          </div>
        )}
        {mode === 'RS' && bundle.benchmarkBars1d.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[#08080D]/80 text-[12px] text-[#8B92AD]">
            Sin serie benchmark disponible para calcular Fuerza Relativa.
          </div>
        )}
      </div>
    </section>
  );
});
