import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Vela,
  type DataProvider,
  type DrawingBox,
  type ExecutionHandlers,
  type ExecutionRequest,
  type ExecutionSession,
  type Fill,
  type IndicatorHandle,
  type IndicatorModel,
  type MarkerPoint,
  type OHLCV,
  type PreparedScript,
  type PriceLine,
  type ScriptingEngine,
  type SeriesPoint,
  type SeriesSpec,
  type SymbolDescriptor,
  type TimelineMark,
} from '@luxalgo/vela';
import { stableSeriesId } from '@luxalgo/vela/plugin';
import {
  NULL_DISPLAY,
  TerminalApiError,
  fmtCompactInt,
  fmtNum,
  fmtUtcTimeET,
  isFiniteNum,
  type RuntimeWsBroadcast,
  type SerializedAbsorptionMarker,
  type SerializedBar,
  type SerializedDivergenceMarker,
  type SerializedKeyLevel,
  type TerminalBarsResponse,
  type Timeframe,
} from '../../api/terminalClient';

export interface OverlayVisibility {
  readonly ema21: boolean;
  readonly sma50: boolean;
  readonly sma200: boolean;
  readonly hma55: boolean;
  readonly sessionVwap: boolean;
  readonly avwap: boolean;
  readonly keyLevels: boolean;
  readonly zones: boolean;
  readonly markers: boolean;
  readonly rsiPane: boolean;
  readonly cvdPane: boolean;
}

export const DEFAULT_OVERLAY_VISIBILITY: OverlayVisibility = {
  ema21: true,
  sma50: false,
  sma200: false,
  hma55: false,
  sessionVwap: true,
  avwap: true,
  keyLevels: true,
  zones: true,
  markers: true,
  rsiPane: true,
  cvdPane: true,
};

export interface LuxAlgoCandleChartProps {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly rthOnly: boolean;
  readonly barsData: TerminalBarsResponse | null;
  readonly extraKeyLevels?: readonly SerializedKeyLevel[];
  readonly loading: boolean;
  readonly error: TerminalApiError | Error | null;
  readonly liveWsEvent: RuntimeWsBroadcast | null;
  readonly onRetry?: () => void;
  readonly onTimeframeChange?: (tf: Timeframe) => void;
  readonly onRthToggle?: (next: boolean) => void;
}

interface ChartRuntimeState {
  symbol: string;
  timeframe: Timeframe;
  rthOnly: boolean;
  barsData: TerminalBarsResponse | null;
  extraKeyLevels: readonly SerializedKeyLevel[];
  liveFormingBar: SerializedBar | null;
  projectedEma21: number | null;
  projectedSessionVwap: number | null;
  projectedAvwap: number | null;
  visibility: OverlayVisibility;
}

const VELA_PROVIDER_NAME = 'quant';

function toVelaTimeframe(tf: Timeframe): string {
  switch (tf) {
    case '1m':
      return '1';
    case '5m':
      return '5';
    case '15m':
      return '15';
    case '1h':
      return '60';
    case '4h':
      return '240';
    case '1D':
      return '1D';
  }
}

function toVelaProviderSymbol(symbol: string): string {
  return `${VELA_PROVIDER_NAME}:${symbol}`;
}

function combineSortedBars(
  closedBars: readonly SerializedBar[],
  formingBar: SerializedBar | null,
): SerializedBar[] {
  const byTime = new Map<number, SerializedBar>();
  for (const bar of closedBars) {
    if (
      Number.isFinite(bar.time) &&
      Number.isFinite(bar.open) &&
      Number.isFinite(bar.high) &&
      Number.isFinite(bar.low) &&
      Number.isFinite(bar.close)
    ) {
      byTime.set(bar.time, bar);
    }
  }
  if (
    formingBar !== null &&
    Number.isFinite(formingBar.time) &&
    Number.isFinite(formingBar.open) &&
    Number.isFinite(formingBar.high) &&
    Number.isFinite(formingBar.low) &&
    Number.isFinite(formingBar.close)
  ) {
    byTime.set(formingBar.time, formingBar);
  }
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

/**
 * Unica frontera donde el timestamp en segundos UTC se convierte a milisegundos
 * requerido por @luxalgo/vela (`OHLCV.time: Millis`).
 */
function toVelaOhlcv(bar: SerializedBar): OHLCV {
  return {
    time: bar.time * 1_000,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    ...(Number.isFinite(bar.volume) ? { volume: bar.volume } : {}),
  };
}

function isAbsorptionMarker(
  m: SerializedAbsorptionMarker | SerializedDivergenceMarker,
): m is SerializedAbsorptionMarker {
  return 'direction' in m;
}

function buildAlignedSeriesPoints(
  bars: readonly OHLCV[],
  values: readonly (number | null)[] | undefined,
  tailOverride?: number | null,
): SeriesPoint[] {
  return bars.map((bar, idx) => {
    const raw =
      idx === bars.length - 1 && isFiniteNum(tailOverride)
        ? tailOverride
        : values?.[idx] ?? null;
    return {
      time: bar.time,
      value: isFiniteNum(raw) ? raw : null,
    };
  });
}

function keyLevelStyle(name: SerializedKeyLevel['name']): {
  readonly color: string;
  readonly lineStyle: 'solid' | 'dashed' | 'dotted';
  readonly width: number;
} {
  switch (name) {
    case 'CallWall':
      return { color: '#2EDC7E', lineStyle: 'dashed', width: 1.5 };
    case 'PutWall':
      return { color: '#FF5C63', lineStyle: 'dashed', width: 1.5 };
    case 'GammaFlip':
      return { color: '#F5B544', lineStyle: 'solid', width: 1.75 };
    case 'PMH':
    case 'PML':
      return { color: '#38BDF8', lineStyle: 'dotted', width: 1.25 };
    case 'ON_POC':
      return { color: '#E5558F', lineStyle: 'dashed', width: 1.25 };
    case 'ON_VAH':
    case 'ON_VAL':
      return { color: '#34D3C7', lineStyle: 'dotted', width: 1 };
    case 'IBH':
    case 'IBL':
      return { color: '#8B7CF6', lineStyle: 'dotted', width: 1 };
    case 'PDH':
    case 'PDL':
    case 'PDC':
      return { color: '#A4A4BA', lineStyle: 'dotted', width: 1 };
    default:
      return { color: '#6D6D84', lineStyle: 'dotted', width: 1 };
  }
}

function buildOverlayModel(
  instanceId: string,
  execBars: readonly OHLCV[],
  state: ChartRuntimeState,
): IndicatorModel {
  const data = state.barsData;
  const vis = state.visibility;
  const series: SeriesSpec[] = [];
  const fills: Fill[] = [];
  const priceLines: PriceLine[] = [];
  const boxes: DrawingBox[] = [];

  if (data !== null && execBars.length > 0) {
    const addLineSeries = (
      title: string,
      color: string,
      width: number,
      lineStyle: 'solid' | 'dashed' | 'dotted',
      rawValues: readonly (number | null)[],
      ordinal: number,
      tailOverride?: number | null,
      visible = true,
    ): string => {
      const id = stableSeriesId({ instanceId, kind: 'line', title, ordinal });
      series.push({
        id,
        title,
        kind: 'line',
        paneId: 'price',
        overlay: true,
        visible,
        points: buildAlignedSeriesPoints(execBars, rawValues, tailOverride),
        style: { color, width, lineStyle },
      });
      return id;
    };

    if (vis.ema21) {
      addLineSeries(
        'EMA 21',
        '#38BDF8',
        1.75,
        'solid',
        data.overlays.ema21,
        0,
        state.projectedEma21,
      );
    }
    if (vis.sma50) {
      addLineSeries('SMA 50', '#F5B544', 1.5, 'solid', data.overlays.sma50, 1);
    }
    if (vis.sma200) {
      addLineSeries('SMA 200', '#8B7CF6', 1.75, 'dashed', data.overlays.sma200, 2);
    }
    if (vis.hma55) {
      addLineSeries('HMA 55', '#34D3C7', 1.5, 'solid', data.overlays.hma55, 3);
    }
    if (vis.sessionVwap && data.overlays.sessionVwapSupported) {
      addLineSeries(
        'Session VWAP',
        '#E5558F',
        1.75,
        'solid',
        data.overlays.sessionVwap,
        4,
        state.projectedSessionVwap,
      );
    }
    if (vis.avwap) {
      const avwapId = addLineSeries(
        'AVWAP',
        '#A855F7',
        1.75,
        'solid',
        data.overlays.avwap,
        5,
        state.projectedAvwap,
      );
      const u1Id = addLineSeries(
        'AVWAP +1s',
        'rgba(168, 85, 247, 0.55)',
        1,
        'dashed',
        data.overlays.avwapUpper1,
        6,
      );
      const l1Id = addLineSeries(
        'AVWAP -1s',
        'rgba(168, 85, 247, 0.55)',
        1,
        'dashed',
        data.overlays.avwapLower1,
        7,
      );
      const u2Id = addLineSeries(
        'AVWAP +2s',
        'rgba(168, 85, 247, 0.35)',
        1,
        'dotted',
        data.overlays.avwapUpper2,
        8,
      );
      const l2Id = addLineSeries(
        'AVWAP -2s',
        'rgba(168, 85, 247, 0.35)',
        1,
        'dotted',
        data.overlays.avwapLower2,
        9,
      );
      void avwapId;
      fills.push(
        {
          id: `${instanceId}-avwap-fill-1`,
          paneId: 'price',
          fromSeriesId: u1Id,
          toSeriesId: l1Id,
          color: 'rgba(168, 85, 247, 0.08)',
          overlay: true,
        },
        {
          id: `${instanceId}-avwap-fill-2`,
          paneId: 'price',
          fromSeriesId: u2Id,
          toSeriesId: l2Id,
          color: 'rgba(168, 85, 247, 0.04)',
          overlay: true,
        },
      );
    }

    if (vis.keyLevels) {
      const dedupLevels = new Map<string, SerializedKeyLevel>();
      for (const lvl of data.keyLevels) {
        if (isFiniteNum(lvl.price)) {
          dedupLevels.set(lvl.name, lvl);
        }
      }
      for (const lvl of state.extraKeyLevels) {
        if (isFiniteNum(lvl.price)) {
          dedupLevels.set(lvl.name, lvl);
        }
      }
      for (const lvl of dedupLevels.values()) {
        if (!isFiniteNum(lvl.price)) {
          continue;
        }
        const style = keyLevelStyle(lvl.name);
        priceLines.push({
          id: `${instanceId}-lvl-${lvl.name}`,
          paneId: 'price',
          price: lvl.price,
          color: style.color,
          lineStyle: style.lineStyle,
          width: style.width,
          title: lvl.name,
        });
      }
    }

    if (vis.zones && data.zones !== null) {
      const firstBar = execBars[0];
      const lastBar = execBars[execBars.length - 1];
      if (firstBar && lastBar) {
        if (isFiniteNum(data.zones.onVah) && isFiniteNum(data.zones.onVal)) {
          boxes.push({
            id: `${instanceId}-zone-on-va`,
            paneId: 'price',
            xloc: 'bar_time',
            left: firstBar.time,
            top: Math.max(data.zones.onVah, data.zones.onVal),
            right: lastBar.time,
            bottom: Math.min(data.zones.onVah, data.zones.onVal),
            extend: 'right',
            bgColor: 'rgba(52, 211, 199, 0.06)',
            borderColor: 'rgba(52, 211, 199, 0.35)',
            borderWidth: 1,
            borderStyle: 'dotted',
            text: 'ON VA',
            textColor: '#34D3C7',
            textSize: 'tiny',
            hAlign: 'right',
            vAlign: 'top',
            wrap: false,
            fontFamily: 'monospace',
            bold: true,
            italic: false,
            overlay: true,
          });
        }
        if (isFiniteNum(data.zones.ibh) && isFiniteNum(data.zones.ibl)) {
          boxes.push({
            id: `${instanceId}-zone-ib`,
            paneId: 'price',
            xloc: 'bar_time',
            left: firstBar.time,
            top: Math.max(data.zones.ibh, data.zones.ibl),
            right: lastBar.time,
            bottom: Math.min(data.zones.ibh, data.zones.ibl),
            extend: 'right',
            bgColor: 'rgba(139, 124, 246, 0.05)',
            borderColor: 'rgba(139, 124, 246, 0.35)',
            borderWidth: 1,
            borderStyle: 'dashed',
            text: 'IB',
            textColor: '#8B7CF6',
            textSize: 'tiny',
            hAlign: 'right',
            vAlign: 'top',
            wrap: false,
            fontFamily: 'monospace',
            bold: true,
            italic: false,
            overlay: true,
          });
        }
      }
    }

    if (vis.markers && data.markers.length > 0) {
      const markerPoints: MarkerPoint[] = data.markers
        .map((m): MarkerPoint => {
          if (isAbsorptionMarker(m)) {
            const isBuy = m.direction === 'BUY_ABSORPTION';
            return {
              time: m.time * 1_000,
              position: isBuy ? 'belowBar' : 'aboveBar',
              shape: isBuy ? 'arrowUp' : 'arrowDown',
              color: isBuy ? '#2EDC7E' : '#FF5C63',
              text: isBuy ? 'BUY ABS' : 'SELL ABS',
              size: 'normal',
            };
          }
          const isBull = m.type.toUpperCase().includes('BULL');
          return {
            time: m.confirmTime * 1_000,
            position: isBull ? 'belowBar' : 'aboveBar',
            shape: m.kind === 'SMT' ? 'diamond' : 'circle',
            color: isBull ? '#38BDF8' : '#F5B544',
            text: `${m.kind} ${isBull ? 'BULL' : 'BEAR'}`,
            size: 'small',
          };
        })
        .sort((a, b) => a.time - b.time);

      series.push({
        id: stableSeriesId({ instanceId, kind: 'markers', title: 'Microstructure Markers', ordinal: 20 }),
        title: 'Microstructure Markers',
        kind: 'markers',
        paneId: 'price',
        overlay: true,
        markers: markerPoints,
      });
    }
  }

  return {
    id: instanceId,
    title: 'Quant Overlays',
    shorttitle: 'Overlays',
    overlay: true,
    paneHint: 'price',
    series,
    fills,
    backgrounds: [],
    priceLines,
    ...(boxes.length > 0 ? { boxes } : {}),
    inputs: [],
    inputValues: {},
  };
}

function buildRsiModel(
  instanceId: string,
  execBars: readonly OHLCV[],
  state: ChartRuntimeState,
): IndicatorModel {
  const rsiValues = state.barsData?.subPanes.rsi14;
  return {
    id: instanceId,
    title: 'RSI (14)',
    shorttitle: 'RSI',
    overlay: false,
    paneHint: 'new',
    series: [
      {
        id: stableSeriesId({ instanceId, kind: 'line', title: 'RSI 14', ordinal: 0 }),
        title: 'RSI (14)',
        kind: 'line',
        paneId: instanceId,
        overlay: false,
        visible: state.visibility.rsiPane,
        points: buildAlignedSeriesPoints(execBars, rsiValues),
        style: { color: '#8B7CF6', width: 1.75, lineStyle: 'solid' },
      },
    ],
    fills: [],
    backgrounds: [],
    priceLines: [
      {
        id: `${instanceId}-ob`,
        paneId: instanceId,
        price: 70,
        color: 'rgba(255, 92, 99, 0.45)',
        lineStyle: 'dashed',
        width: 1,
        title: '70',
      },
      {
        id: `${instanceId}-os`,
        paneId: instanceId,
        price: 30,
        color: 'rgba(46, 220, 126, 0.45)',
        lineStyle: 'dashed',
        width: 1,
        title: '30',
      },
    ],
    inputs: [],
    inputValues: {},
  };
}

function buildCvdModel(
  instanceId: string,
  execBars: readonly OHLCV[],
  state: ChartRuntimeState,
): IndicatorModel {
  const cvdValues = state.barsData?.subPanes.sessionCvd;
  const deltaMode = state.barsData?.subPanes.deltaMode ?? 'volume';
  return {
    id: instanceId,
    title: `Session CVD (${deltaMode})`,
    shorttitle: 'CVD',
    overlay: false,
    paneHint: 'new',
    series: [
      {
        id: stableSeriesId({ instanceId, kind: 'area', title: 'Session CVD', ordinal: 0 }),
        title: 'Session CVD',
        kind: 'area',
        paneId: instanceId,
        overlay: false,
        visible: state.visibility.cvdPane,
        points: buildAlignedSeriesPoints(execBars, cvdValues),
        style: { color: '#34D3C7', width: 1.75, lineStyle: 'solid', base: 0 },
      },
    ],
    fills: [],
    backgrounds: [],
    priceLines: [
      {
        id: `${instanceId}-zero`,
        paneId: instanceId,
        price: 0,
        color: 'rgba(164, 164, 186, 0.35)',
        lineStyle: 'dotted',
        width: 1,
        title: '0',
      },
    ],
    inputs: [],
    inputValues: {},
  };
}

function buildTimelineMarks(data: TerminalBarsResponse | null): TimelineMark[] {
  if (data === null) {
    return [];
  }
  return data.markers.map((m, idx): TimelineMark => {
    if (isAbsorptionMarker(m)) {
      const isBuy = m.direction === 'BUY_ABSORPTION';
      return {
        id: `abs-${String(m.time)}-${String(idx)}`,
        time: m.time * 1_000,
        group: 'absorption',
        title: isBuy ? 'Buy Absorption' : 'Sell Absorption',
        tooltip: `${isBuy ? 'Buy' : 'Sell'} Absorption @ ${m.levelName ?? 'Level'} ($${fmtNum(m.price, 2)})`,
        glyph: {
          shape: 'diamond',
          color: isBuy ? '#2EDC7E' : '#FF5C63',
          letter: isBuy ? 'B' : 'S',
        },
        content: {
          panel: {
            items: [
              { type: 'field', label: 'Time', value: fmtUtcTimeET(m.time) },
              { type: 'field', label: 'Level', value: m.levelName ?? NULL_DISPLAY },
              { type: 'field', label: 'Price', value: fmtNum(m.price, 2) },
              { type: 'field', label: 'Bar Delta', value: fmtCompactInt(m.barDelta) },
              { type: 'field', label: 'Session CVD', value: fmtCompactInt(m.sessionCvd) },
            ],
          },
        },
      };
    }
    const isBull = m.type.toUpperCase().includes('BULL');
    return {
      id: `div-${m.kind}-${String(m.confirmTime)}-${String(idx)}`,
      time: m.confirmTime * 1_000,
      group: 'divergences',
      title: `${m.kind} ${m.type}`,
      tooltip: `${m.kind} Divergence (${m.type})`,
      glyph: {
        shape: 'circle',
        color: isBull ? '#38BDF8' : '#F5B544',
        letter: m.kind === 'SMT' ? 'M' : 'R',
      },
      content: {
        panel: {
          items: [
            { type: 'field', label: 'Type', value: `${m.kind} ${m.type}` },
            { type: 'field', label: 'Pivot', value: fmtUtcTimeET(m.pivotTime) },
            { type: 'field', label: 'Confirm', value: fmtUtcTimeET(m.confirmTime) },
            { type: 'field', label: 'Price', value: fmtNum(m.price, 2) },
          ],
        },
      },
    };
  });
}

const TIMEFRAMES: readonly Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1D'];

export const LuxAlgoCandleChart: React.FC<LuxAlgoCandleChartProps> = ({
  symbol,
  timeframe,
  rthOnly,
  barsData,
  extraKeyLevels = [],
  loading,
  error,
  liveWsEvent,
  onRetry,
  onTimeframeChange,
  onRthToggle,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<Vela | null>(null);
  const barStreamListenersRef = useRef<Set<(bar: OHLCV) => void>>(new Set());
  const sessionEmitMapRef = useRef<Map<string, () => void>>(new Map());
  const overlayHandleRef = useRef<IndicatorHandle | null>(null);
  const rsiHandleRef = useRef<IndicatorHandle | null>(null);
  const cvdHandleRef = useRef<IndicatorHandle | null>(null);

  const [visibility, setVisibility] = useState<OverlayVisibility>(DEFAULT_OVERLAY_VISIBILITY);
  const [hoveredOhlc, setHoveredOhlc] = useState<{
    readonly timeSec: number | null;
    readonly open: number;
    readonly high: number;
    readonly low: number;
    readonly close: number;
    readonly volume: number | null;
  } | null>(null);

  const stateRef = useRef<ChartRuntimeState>({
    symbol,
    timeframe,
    rthOnly,
    barsData,
    extraKeyLevels,
    liveFormingBar: barsData?.formingBar ?? null,
    projectedEma21: null,
    projectedSessionVwap: null,
    projectedAvwap: null,
    visibility,
  });

  stateRef.current = {
    ...stateRef.current,
    symbol,
    timeframe,
    rthOnly,
    barsData,
    extraKeyLevels,
    visibility,
  };

  const hasRenderableBars = useMemo(() => {
    if (barsData === null) {
      return false;
    }
    return combineSortedBars(barsData.bars, barsData.formingBar).length > 0;
  }, [barsData]);

  // Crear instancia única de @luxalgo/vela al montar contenedor renderizable
  useEffect(() => {
    const el = containerRef.current;
    if (el === null || !hasRenderableBars || chartRef.current !== null) {
      return;
    }

    const customProvider: DataProvider = {
      async getBars(): Promise<OHLCV[]> {
        const s = stateRef.current;
        const closed = s.barsData?.bars ?? [];
        const forming = s.liveFormingBar ?? s.barsData?.formingBar ?? null;
        return combineSortedBars(closed, forming).map(toVelaOhlcv);
      },
      async listSymbols(): Promise<SymbolDescriptor[]> {
        const s = stateRef.current;
        return [
          {
            ticker: s.symbol,
            description: `${s.symbol} Quant Terminal Feed`,
            type: s.symbol.startsWith('I:') ? 'index' : 'stock',
          },
        ];
      },
      async getSymbolInfo(ticker: string) {
        return {
          ticker,
          timezone: 'America/New_York',
          session: '0930-1600',
          session_extended: '0400-2000',
          volume: !ticker.startsWith('I:'),
          ohlc: true,
        };
      },
      subscribe(_ticker, _tf, onBar) {
        barStreamListenersRef.current.add(onBar);
        return () => {
          barStreamListenersRef.current.delete(onBar);
        };
      },
    };

    const quantEngine: ScriptingEngine = {
      language: 'quant-terminal',
      capabilities: {
        streaming: false,
        visibleRange: false,
        inputs: false,
        props: false,
      },
      async prepare(source: string): Promise<PreparedScript> {
        const kind = source.trim();
        const isOverlay = kind === 'overlays';
        return {
          language: 'quant-terminal',
          inputs: [],
          meta: {
            title: isOverlay ? 'Quant Overlays' : kind === 'rsi' ? 'RSI (14)' : 'Session CVD',
            overlay: isOverlay,
            precision: 2,
          },
          reactsToViewport: false,
          token: kind,
        };
      },
      execute(req: ExecutionRequest, handlers: ExecutionHandlers): ExecutionSession {
        const kind = String(req.prepared.token);
        let activeBars = req.bars;
        const emit = (): void => {
          const s = stateRef.current;
          const instanceId = `quant-${kind}`;
          if (kind === 'overlays') {
            handlers.onModel(buildOverlayModel(instanceId, activeBars, s));
          } else if (kind === 'rsi') {
            handlers.onModel(buildRsiModel(instanceId, activeBars, s));
          } else {
            handlers.onModel(buildCvdModel(instanceId, activeBars, s));
          }
          handlers.onDone?.();
        };

        sessionEmitMapRef.current.set(kind, emit);
        queueMicrotask(emit);

        return {
          stop(): void {
            sessionEmitMapRef.current.delete(kind);
          },
          update(): void {
            emit();
          },
          setVisibleRange(): void {
            // Viewport-independent server calculations.
          },
          notifyBars(): void {
            const s = stateRef.current;
            const merged = combineSortedBars(
              s.barsData?.bars ?? [],
              s.liveFormingBar ?? s.barsData?.formingBar ?? null,
            );
            activeBars = merged.map(toVelaOhlcv);
            emit();
          },
        };
      },
    };

    const s = stateRef.current;
    const chart = new Vela(el, {
      symbol: toVelaProviderSymbol(s.symbol),
      timeframe: toVelaTimeframe(s.timeframe),
      session: s.rthOnly ? 'regular' : 'extended',
      live: true,
      theme: {
        background: '#0D1017',
        textColor: '#A4A4BA',
        gridColor: '#1E1E2B',
        borderColor: '#30303F',
        upColor: '#2EDC7E',
        downColor: '#FF5C63',
        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
      },
      volume: !s.symbol.startsWith('I:'),
      currentPriceLine: true,
      animations: {
        liveBar: false,
        intro: false,
      },
      drawings: {
        toolbar: false,
      },
      renderer: undefined,
    });

    chart.registerEngine('quant-terminal', quantEngine);
    chart.data.registerProvider(VELA_PROVIDER_NAME, customProvider);

    chart.marks
      .defineGroup({ id: 'absorption', label: 'Absorption Events' })
      .defineGroup({ id: 'divergences', label: 'RSI & SMT Divergences' })
      .set(buildTimelineMarks(s.barsData));

    overlayHandleRef.current = chart.addIndicator('overlays', {
      id: 'quant-overlays',
      language: 'quant-terminal',
      overlay: true,
      pane: 'price',
      title: 'Quant Overlays',
    });

    rsiHandleRef.current = chart.addIndicator('rsi', {
      id: 'quant-rsi',
      language: 'quant-terminal',
      overlay: false,
      pane: 'new',
      title: 'RSI (14)',
    });

    cvdHandleRef.current = chart.addIndicator('cvd', {
      id: 'quant-cvd',
      language: 'quant-terminal',
      overlay: false,
      pane: 'new',
      title: 'Session CVD',
    });

    const offCrosshair = chart.renderer.onCrosshairMove((evt) => {
      if (evt.ohlc === null) {
        setHoveredOhlc(null);
        return;
      }
      setHoveredOhlc({
        timeSec: evt.time !== null ? Math.floor(evt.time / 1_000) : null,
        open: evt.ohlc.open,
        high: evt.ohlc.high,
        low: evt.ohlc.low,
        close: evt.ohlc.close,
        volume: isFiniteNum(evt.ohlc.volume) ? evt.ohlc.volume : null,
      });
    });

    const resizeObserver = new ResizeObserver(() => {
      chart.resize();
    });
    resizeObserver.observe(el);

    chartRef.current = chart;

    return () => {
      offCrosshair();
      resizeObserver.disconnect();
      sessionEmitMapRef.current.clear();
      overlayHandleRef.current = null;
      rsiHandleRef.current = null;
      cvdHandleRef.current = null;
      chart.destroy();
      chartRef.current = null;
    };
  }, [hasRenderableBars]);

  // Actualizar mercado en Vela cuando llegan nuevos barsData de backend
  useEffect(() => {
    const chart = chartRef.current;
    if (chart === null || barsData === null) {
      return;
    }
    stateRef.current.liveFormingBar = barsData.formingBar;
    stateRef.current.projectedEma21 = null;
    stateRef.current.projectedSessionVwap = null;
    stateRef.current.projectedAvwap = null;

    void chart
      .setMarket({
        symbol: toVelaProviderSymbol(symbol),
        timeframe: toVelaTimeframe(timeframe),
        session: rthOnly ? 'regular' : 'extended',
      })
      .then(() => {
        chart.marks.set(buildTimelineMarks(barsData));
        for (const emit of sessionEmitMapRef.current.values()) {
          emit();
        }
      });
  }, [symbol, timeframe, rthOnly, barsData]);

  // Re-emitir indicadores al cambiar visibilidad de capas o niveles extra
  useEffect(() => {
    if (chartRef.current === null) {
      return;
    }
    for (const emit of sessionEmitMapRef.current.values()) {
      emit();
    }
  }, [visibility, extraKeyLevels]);

  // Aplicar actualizaciones live por WebSocket sin destruir el grafico
  useEffect(() => {
    if (
      liveWsEvent === null ||
      liveWsEvent.type !== 'bar_update' ||
      liveWsEvent.symbol !== symbol
    ) {
      return;
    }
    if (liveWsEvent.formingBar !== null) {
      stateRef.current.liveFormingBar = liveWsEvent.formingBar;
      stateRef.current.projectedEma21 = liveWsEvent.projectedEma21;
      stateRef.current.projectedSessionVwap = liveWsEvent.projectedSessionVwap;
      stateRef.current.projectedAvwap = liveWsEvent.projectedAvwap;

      const velaBar = toVelaOhlcv(liveWsEvent.formingBar);
      for (const listener of barStreamListenersRef.current) {
        listener(velaBar);
      }
      for (const emit of sessionEmitMapRef.current.values()) {
        emit();
      }
    }
  }, [liveWsEvent, symbol]);

  const latestBar = useMemo(() => {
    if (barsData === null) {
      return null;
    }
    if (stateRef.current.liveFormingBar !== null) {
      return stateRef.current.liveFormingBar;
    }
    if (barsData.formingBar !== null) {
      return barsData.formingBar;
    }
    return barsData.bars[barsData.bars.length - 1] ?? null;
  }, [barsData, liveWsEvent]);

  const displayedOhlc = hoveredOhlc ?? (latestBar !== null
    ? {
        timeSec: latestBar.time,
        open: latestBar.open,
        high: latestBar.high,
        low: latestBar.low,
        close: latestBar.close,
        volume: isFiniteNum(latestBar.volume) ? latestBar.volume : null,
      }
    : null);

  const toggleLayer = (key: keyof OverlayVisibility): void => {
    setVisibility((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const sessionVwapSupported = barsData?.overlays.sessionVwapSupported ?? false;
  const errorDetail =
    error instanceof TerminalApiError
      ? `${error.reason}: ${error.detail}`
      : error instanceof Error
        ? error.message
        : null;

  return (
    <div className="rounded-[12px] bg-[#11111A] border border-[#1E1E2B] overflow-hidden flex flex-col">
      {/* Barra superior de controles del grafico */}
      <div className="px-4 py-2.5 bg-[#121620] border-b border-[#1E1E2B] flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {TIMEFRAMES.map((tf) => {
            const active = tf === timeframe;
            return (
              <button
                key={tf}
                type="button"
                onClick={() => onTimeframeChange?.(tf)}
                className={`px-2.5 py-1 rounded-[6px] text-[11.5px] font-mono-num font-semibold transition-colors cursor-pointer ${
                  active
                    ? 'bg-[#8B7CF6]/20 text-[#F3F3F9] border border-[#8B7CF6]'
                    : 'bg-[#171722] text-[#A4A4BA] border border-[#1E1E2B] hover:text-[#F3F3F9]'
                }`}
              >
                {tf}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => onRthToggle?.(!rthOnly)}
            className={`ml-2 px-2.5 py-1 rounded-[6px] text-[11px] font-mono-num font-semibold border cursor-pointer ${
              rthOnly
                ? 'bg-[#14203D] text-[#5B8CFF] border-[#5B8CFF]/40'
                : 'bg-[#171722] text-[#A4A4BA] border-[#1E1E2B]'
            }`}
          >
            {rthOnly ? 'RTH' : 'ETH + RTH'}
          </button>

          {barsData?.status === 'PARTIAL' && (
            <span className="ml-1 px-2 py-0.5 rounded bg-[#35280F] text-[#F5B544] border border-[#F5B544]/30 text-[10.5px] font-mono-num font-semibold">
              PARTIAL
            </span>
          )}
        </div>

        {/* Lectura OHLCV en vivo (UTC sec -> ET solo en UI) */}
        <div className="flex flex-wrap items-center gap-3 text-[11.5px] font-mono-num">
          {displayedOhlc !== null ? (
            <>
              <span className="text-[#6D6D84]">
                {displayedOhlc.timeSec !== null ? fmtUtcTimeET(displayedOhlc.timeSec) : NULL_DISPLAY}
              </span>
              <span className="text-[#A4A4BA]">
                O <strong className="text-[#F3F3F9]">{fmtNum(displayedOhlc.open, 2)}</strong>
              </span>
              <span className="text-[#A4A4BA]">
                H <strong className="text-[#2EDC7E]">{fmtNum(displayedOhlc.high, 2)}</strong>
              </span>
              <span className="text-[#A4A4BA]">
                L <strong className="text-[#FF5C63]">{fmtNum(displayedOhlc.low, 2)}</strong>
              </span>
              <span className="text-[#A4A4BA]">
                C <strong className="text-[#F3F3F9]">{fmtNum(displayedOhlc.close, 2)}</strong>
              </span>
              <span className="text-[#A4A4BA]">
                V{' '}
                <strong className="text-[#F3F3F9]">
                  {displayedOhlc.volume !== null ? fmtCompactInt(displayedOhlc.volume) : NULL_DISPLAY}
                </strong>
              </span>
            </>
          ) : (
            <span className="text-[#6D6D84]">OHLCV: {NULL_DISPLAY}</span>
          )}
        </div>
      </div>

      {/* Selector rapido de capas / overlays */}
      <div className="px-4 py-1.5 bg-[#0D1017] border-b border-[#1E1E2B] flex flex-wrap items-center gap-1.5 text-[11px]">
        {(
          [
            ['ema21', 'EMA 21', '#38BDF8'],
            ['sma50', 'SMA 50', '#F5B544'],
            ['sma200', 'SMA 200', '#8B7CF6'],
            ['hma55', 'HMA 55', '#34D3C7'],
            ['avwap', 'AVWAP +-2s', '#A855F7'],
            ['keyLevels', 'Key Levels', '#2EDC7E'],
            ['zones', 'ON / IB Zones', '#34D3C7'],
            ['markers', 'Markers', '#F5B544'],
            ['rsiPane', 'RSI (14)', '#8B7CF6'],
            ['cvdPane', 'CVD', '#34D3C7'],
          ] as const
        ).map(([key, label, dotColor]) => {
          const active = visibility[key];
          return (
            <button
              key={key}
              type="button"
              onClick={() => toggleLayer(key)}
              className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border font-mono-num transition-colors cursor-pointer ${
                active
                  ? 'bg-[#171722] text-[#F3F3F9] border-[#30303F]'
                  : 'bg-transparent text-[#6D6D84] border-[#1E1E2B] hover:text-[#A4A4BA]'
              }`}
            >
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ backgroundColor: active ? dotColor : '#4A4A5C' }}
              />
              {label}
            </button>
          );
        })}
        <button
          type="button"
          disabled={!sessionVwapSupported}
          onClick={() => toggleLayer('sessionVwap')}
          title={
            sessionVwapSupported
              ? 'Session VWAP intradia'
              : 'Session VWAP no aplica en barras diarias (1D)'
          }
          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border font-mono-num transition-colors ${
            !sessionVwapSupported
              ? 'bg-transparent text-[#6D6D84] border-[#1E1E2B] opacity-50 cursor-not-allowed'
              : visibility.sessionVwap
                ? 'bg-[#171722] text-[#F3F3F9] border-[#30303F] cursor-pointer'
                : 'bg-transparent text-[#6D6D84] border-[#1E1E2B] cursor-pointer'
          }`}
        >
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{
              backgroundColor:
                sessionVwapSupported && visibility.sessionVwap ? '#E5558F' : '#4A4A5C',
            }}
          />
          VWAP {sessionVwapSupported ? '' : '(N/A)'}
        </button>
      </div>

      {/* Superficie Vela o Estados Explicitos Loading / NO_DATA */}
      <div className="relative w-full h-[540px] bg-[#0D1017]">
        {errorDetail !== null ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center gap-3">
            <span className="px-2.5 py-1 rounded bg-[#331519] text-[#FF5C63] border border-[#6C2931] text-[11px] font-mono-num font-bold uppercase tracking-wider">
              NO_DATA
            </span>
            <p className="text-[13px] text-[#A4A4BA] max-w-lg font-mono-num">{errorDetail}</p>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="px-3.5 py-1.5 rounded-[8px] bg-[#171722] border border-[#30303F] text-[12px] text-[#F3F3F9] hover:border-[#8B7CF6] cursor-pointer"
              >
                Reintentar carga
              </button>
            )}
          </div>
        ) : loading && !hasRenderableBars ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-[#A4A4BA] text-[13px] font-mono-num">
            <span>Cargando barras historicas y overlays para {symbol}...</span>
          </div>
        ) : !hasRenderableBars ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center gap-2">
            <span className="px-2.5 py-1 rounded bg-[#35280F] text-[#F5B544] border border-[#F5B544]/30 text-[11px] font-mono-num font-bold uppercase tracking-wider">
              NO_DATA
            </span>
            <p className="text-[13px] text-[#A4A4BA] font-mono-num">
              Sin barras disponibles para {symbol} ({timeframe}).
            </p>
          </div>
        ) : (
          <>
            <div ref={containerRef} className="w-full h-full" />
            {loading && (
              <div className="pointer-events-none absolute top-3 right-16 px-2.5 py-1 rounded bg-[#11111A]/90 border border-[#30303F] text-[11px] font-mono-num text-[#A4A4BA]">
                Actualizando {symbol}...
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
