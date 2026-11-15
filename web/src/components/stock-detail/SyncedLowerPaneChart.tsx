import React, { useEffect, useMemo, useRef } from 'react';
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
  computeLeeReadyBarFlow,
  computeRelativeStrengthSeries,
  computeRollingRvSeries,
} from './stockDetailMath';
import type { LowerPaneMode, StockChartSeriesBundle } from './stockDetailTypes';

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
}> = ({
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
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const histSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const lineSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const baselineSeriesRef = useRef<ISeriesApi<'Baseline'> | null>(null);
  const ivPriceLineRef = useRef<IPriceLine | null>(null);
  const suppressingRangeEventRef = useRef(false);
  const latestBarsRef = useRef(bundle.bars);
  const modeRef = useRef(mode);
  const rangeCbRef = useRef(onLogicalRangeSync);
  const crosshairCbRef = useRef(onCrosshairTimeSync);

  latestBarsRef.current = bundle.bars;
  modeRef.current = mode;
  rangeCbRef.current = onLogicalRangeSync;
  crosshairCbRef.current = onCrosshairTimeSync;

  const flowPoints = useMemo(() => computeLeeReadyBarFlow(bundle.bars), [bundle.bars]);
  const rsPoints = useMemo(
    () => computeRelativeStrengthSeries(bundle.bars, bundle.benchmarkBars1d, true),
    [bundle.bars, bundle.benchmarkBars1d],
  );
  const rollingRvSeries = useMemo(
    () => (timeframe === '1D' ? computeRollingRvSeries(bundle.bars, 30, 252) : []),
    [bundle.bars, timeframe],
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
      },
      width: el.clientWidth,
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

    const handleVisibleRangeChange = (range: LogicalRange | null) => {
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
      chart.applyOptions({ width: containerRef.current.clientWidth, height: 190 });
    });
    resizeObserver.observe(el);

    externalLogicalRangeRef.current = (range: LogicalRange) => {
      suppressingRangeEventRef.current = true;
      try {
        chart.timeScale().setVisibleLogicalRange(range);
      } finally {
        window.requestAnimationFrame(() => {
          suppressingRangeEventRef.current = false;
        });
      }
    };

    externalCrosshairTimeRef.current = (timeSec: number | null) => {
      const m = modeRef.current;
      const targetSeries = m === 'RS' ? baseline : line;
      if (timeSec === null) {
        chart.clearCrosshairPosition();
        return;
      }
      const match = latestBarsRef.current.find((b) => b.time === timeSec);
      if (match) {
        chart.setCrosshairPosition(0, timeSec as UTCTimestamp, targetSeries);
      }
    };

    return () => {
      resizeObserver.disconnect();
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleVisibleRangeChange);
      chart.remove();
      chartRef.current = null;
      histSeriesRef.current = null;
      lineSeriesRef.current = null;
      baselineSeriesRef.current = null;
      externalLogicalRangeRef.current = null;
      externalCrosshairTimeRef.current = null;
    };
  }, [externalLogicalRangeRef, externalCrosshairTimeRef]);

  // Alimentar datos manteniendo índice lógico 1:1 con Chart 1 mediante whitespace items
  useEffect(() => {
    const chart = chartRef.current;
    const hist = histSeriesRef.current;
    const line = lineSeriesRef.current;
    const baseline = baselineSeriesRef.current;
    if (!chart || !hist || !line || !baseline) return;

    if (ivPriceLineRef.current) {
      line.removePriceLine(ivPriceLineRef.current);
      ivPriceLineRef.current = null;
    }

    chart.applyOptions({
      timeScale: { timeVisible: timeframe !== '1D', secondsVisible: false },
    });

    if (!bundle.barsAvailable || bundle.bars.length === 0) {
      hist.setData([]);
      line.setData([]);
      baseline.setData([]);
      return;
    }

    if (mode === 'CVD') {
      baseline.setData([]);
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
    } else if (mode === 'RS') {
      hist.setData([]);
      line.setData([]);
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
    } else {
      // VOLATILITY: RV 30D (%) curva + línea horizontal IV ATM (%)
      hist.setData([]);
      baseline.setData([]);
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
      if (bundle.ivAtmPct !== null && Number.isFinite(bundle.ivAtmPct) && bundle.ivAtmPct > 0) {
        ivPriceLineRef.current = line.createPriceLine({
          price: bundle.ivAtmPct,
          color: '#8B7CF6',
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `IV ATM ${fmtNum(bundle.ivAtmPct, 1)}%`,
        });
      }
    }

    chart.timeScale().fitContent();
  }, [bundle, timeframe, mode, flowPoints, rsPoints, rollingRvSeries]);

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
};
