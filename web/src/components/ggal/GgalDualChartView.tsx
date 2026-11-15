import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type IPrimitivePaneRenderer,
  type IPrimitivePaneView,
  type ISeriesApi,
  type ISeriesPrimitive,
  type LogicalRange,
  type SeriesAttachedParameter,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import {
  AlertTriangle,
  Layers,
  RefreshCw,
} from 'lucide-react';
import type {
  GgalAvwapAnchorMode,
  GgalDualChartCoordMode,
  GgalDualChartPayloadDto,
  GgalDualChartTimeframe,
  GgalGreekProfileMode,
  GgalSubPaneIndicatorMode,
} from '../../api/ggalSpecialistClient';

export interface GgalDualChartViewProps {
  readonly payload: GgalDualChartPayloadDto | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly coordMode: GgalDualChartCoordMode;
  readonly timeframe: GgalDualChartTimeframe;
  readonly avwapAnchor: GgalAvwapAnchorMode;
  readonly onChangeCoordMode: (next: GgalDualChartCoordMode) => void;
  readonly onChangeTimeframe: (next: GgalDualChartTimeframe) => void;
  readonly onChangeAvwapAnchor: (next: GgalAvwapAnchorMode) => void;
  readonly onRefresh: () => void;
}

interface OverlayToggleState {
  readonly showEmas: boolean;
  readonly showAvwap: boolean;
  readonly showVolumeProfile: boolean;
  readonly showZones: boolean;
  readonly showCone: boolean;
}

interface OverlayDrawState {
  readonly payload: GgalDualChartPayloadDto | null;
  readonly toggles: OverlayToggleState;
}

class GgalChartOverlayPrimitive implements ISeriesPrimitive<Time> {
  private param: SeriesAttachedParameter<Time, SeriesType> | null = null;
  private state: OverlayDrawState;
  private readonly onHostRedraw: () => void;

  public constructor(initial: OverlayDrawState, onHostRedraw: () => void) {
    this.state = initial;
    this.onHostRedraw = onHostRedraw;
  }

  public setState(next: OverlayDrawState): void {
    this.state = next;
    this.param?.requestUpdate();
  }

  public attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
    this.param = param;
  }

  public detached(): void {
    this.param = null;
  }

  public updateAllViews(): void {
    // Synchronize the mirrored GEX / L2 canvas on every host frame update (pan, zoom, price scale drag).
    this.onHostRedraw();
  }

  public paneViews(): readonly IPrimitivePaneView[] {
    const param = this.param;
    const { payload, toggles } = this.state;
    if (param === null || payload === null || payload.status !== 'OPERATIONAL') {
      return [];
    }

    const renderer: IPrimitivePaneRenderer = {
      draw: (target) => {
        target.useMediaCoordinateSpace(({ context, mediaSize }) => {
          const { chart, series } = param;
          const timeScale = chart.timeScale();
          const width = mediaSize.width;
          const height = mediaSize.height;

          // 1) Volume Profile histogram along the left inner edge + POC/VAH/VAL + Naked POCs
          if (toggles.showVolumeProfile && payload.volumeProfile !== undefined) {
            const vp = payload.volumeProfile;
            let maxBinVol = 0;
            for (const bin of vp.bins) {
              if (bin.volume > maxBinVol) {
                maxBinVol = bin.volume;
              }
            }
            const maxBarWidth = Math.min(110, width * 0.16);
            if (maxBinVol > 0) {
              for (let i = 0; i < vp.bins.length; i++) {
                const bin = vp.bins[i];
                if (bin === undefined) continue;
                const y = series.priceToCoordinate(bin.priceMid);
                if (y === null || y < 0 || y > height) continue;
                const nextBin = vp.bins[i + 1];
                const prevBin = vp.bins[i - 1];
                const refNeighbor = nextBin ?? prevBin;
                const yNeighbor = refNeighbor !== undefined ? series.priceToCoordinate(refNeighbor.priceMid) : null;
                const barH = yNeighbor !== null ? Math.max(2, Math.abs(yNeighbor - y) * 0.82) : 6;
                const barW = (bin.volume / maxBinVol) * maxBarWidth;
                context.fillStyle = bin.isPoc
                  ? 'rgba(250, 204, 21, 0.55)'
                  : bin.isValToVah
                    ? 'rgba(56, 189, 248, 0.25)'
                    : 'rgba(148, 163, 184, 0.16)';
                context.fillRect(0, y - barH * 0.5, barW, barH);
              }
            }

            if (vp.poc !== null && Number.isFinite(vp.poc)) {
              const yPoc = series.priceToCoordinate(vp.poc);
              if (yPoc !== null) {
                context.save();
                context.strokeStyle = 'rgba(250, 204, 21, 0.78)';
                context.lineWidth = 1.25;
                context.setLineDash([4, 3]);
                context.beginPath();
                context.moveTo(0, yPoc);
                context.lineTo(width, yPoc);
                context.stroke();
                context.fillStyle = '#fde047';
                context.font = '10px ui-monospace, SFMono-Regular, monospace';
                context.fillText('POC', 6, Math.max(11, yPoc - 3));
                context.restore();
              }
            }

            if (vp.vah !== null && Number.isFinite(vp.vah) && vp.val !== null && Number.isFinite(vp.val)) {
              const yVah = series.priceToCoordinate(vp.vah);
              const yVal = series.priceToCoordinate(vp.val);
              context.save();
              context.strokeStyle = 'rgba(56, 189, 248, 0.45)';
              context.lineWidth = 1;
              context.setLineDash([2, 4]);
              if (yVah !== null) {
                context.beginPath();
                context.moveTo(0, yVah);
                context.lineTo(width, yVah);
                context.stroke();
              }
              if (yVal !== null) {
                context.beginPath();
                context.moveTo(0, yVal);
                context.lineTo(width, yVal);
                context.stroke();
              }
              context.restore();
            }

            for (const np of vp.nakedPocs) {
              const yNp = series.priceToCoordinate(np);
              if (yNp === null) continue;
              context.save();
              context.strokeStyle = 'rgba(232, 121, 249, 0.85)';
              context.lineWidth = 1.1;
              context.setLineDash([5, 3]);
              context.beginPath();
              context.moveTo(0, yNp);
              context.lineTo(width, yNp);
              context.stroke();
              context.fillStyle = '#f0abfc';
              context.font = '10px ui-monospace, SFMono-Regular, monospace';
              context.fillText('Naked POC', 6, Math.max(11, yNp - 3));
              context.restore();
            }
          }

          // 2) Unmitigated FVG & FOB Zones
          if (toggles.showZones && payload.zones !== undefined) {
            for (const z of payload.zones) {
              if (z.status !== 'UNMITIGATED') continue;
              const xStart = timeScale.timeToCoordinate(z.startTimeSec as UTCTimestamp);
              const yHigh = series.priceToCoordinate(z.high);
              const yLow = series.priceToCoordinate(z.low);
              if (yHigh === null || yLow === null) continue;
              const x0 = xStart !== null ? Math.max(0, xStart) : 0;
              const top = Math.min(yHigh, yLow);
              const boxH = Math.max(3, Math.abs(yLow - yHigh));
              if (top > height || top + boxH < 0) continue;

              const isBull = z.direction === 'BULLISH';
              const isFob = z.kind === 'FOB';
              context.fillStyle = isBull
                ? isFob
                  ? 'rgba(16, 185, 129, 0.16)'
                  : 'rgba(34, 197, 94, 0.11)'
                : isFob
                  ? 'rgba(244, 63, 94, 0.16)'
                  : 'rgba(239, 68, 68, 0.11)';
              context.fillRect(x0, top, Math.max(16, width - x0), boxH);
              context.strokeStyle = isBull ? 'rgba(52, 211, 153, 0.55)' : 'rgba(251, 113, 133, 0.55)';
              context.lineWidth = 0.8;
              context.strokeRect(x0, top, Math.max(16, width - x0), boxH);

              context.fillStyle = isBull ? '#6ee7b7' : '#fda4af';
              context.font = '9px ui-monospace, SFMono-Regular, monospace';
              context.fillText(`${z.kind} ${isBull ? '↑' : '↓'}`, x0 + 4, top + Math.min(11, boxH - 1));
            }
          }

          // 3) Expected Move Cone +/-1 sigma and +/-2 sigma projected toward right edge
          if (toggles.showCone && payload.expectedCone !== undefined && payload.expectedCone.length >= 2) {
            const firstPt = payload.expectedCone[0];
            const lastBar = payload.bars?.[payload.bars.length - 1];
            const anchorX =
              firstPt !== undefined
                ? timeScale.timeToCoordinate(firstPt.timeSec as UTCTimestamp) ??
                  (lastBar !== undefined ? timeScale.timeToCoordinate(lastBar.timeSec as UTCTimestamp) : null)
                : null;
            if (anchorX !== null && anchorX < width - 8) {
              const endX = Math.min(width - 6, anchorX + Math.max(48, (width - anchorX) * 0.78));
              const steps = payload.expectedCone.length - 1;
              context.save();
              context.setLineDash([4, 4]);

              const drawEnvelope = (
                extractor: (p: NonNullable<GgalDualChartPayloadDto['expectedCone']>[number]) => number,
                strokeStyle: string,
              ) => {
                context.strokeStyle = strokeStyle;
                context.lineWidth = 1.2;
                context.beginPath();
                let started = false;
                payload.expectedCone?.forEach((pt, idx) => {
                  const x = anchorX + ((endX - anchorX) * idx) / steps;
                  const y = series.priceToCoordinate(extractor(pt));
                  if (y === null) return;
                  if (!started) {
                    context.moveTo(x, y);
                    started = true;
                  } else {
                    context.lineTo(x, y);
                  }
                });
                context.stroke();
              };

              drawEnvelope((p) => p.upper1Sigma, 'rgba(56, 189, 248, 0.85)');
              drawEnvelope((p) => p.lower1Sigma, 'rgba(56, 189, 248, 0.85)');
              drawEnvelope((p) => p.upper2Sigma, 'rgba(251, 191, 36, 0.7)');
              drawEnvelope((p) => p.lower2Sigma, 'rgba(251, 191, 36, 0.7)');

              const tailPt = payload.expectedCone[steps];
              if (tailPt !== undefined) {
                const yU1 = series.priceToCoordinate(tailPt.upper1Sigma);
                const yL1 = series.priceToCoordinate(tailPt.lower1Sigma);
                context.font = '9px ui-monospace, SFMono-Regular, monospace';
                context.fillStyle = '#7dd3fc';
                if (yU1 !== null) context.fillText('+1σ', endX + 3, yU1 + 3);
                if (yL1 !== null) context.fillText('-1σ', endX + 3, yL1 + 3);
              }
              context.restore();
            }
          }
        });
      },
    };

    return [
      {
        zOrder: () => 'normal',
        renderer: () => renderer,
      },
    ];
  }
}

function formatCoordPrice(val: number | null | undefined, mode: GgalDualChartCoordMode): string {
  if (val === null || val === undefined || !Number.isFinite(val)) {
    return '—';
  }
  if (mode === 'USD_ADR_NASDAQ') {
    return `$${val.toFixed(2)}`;
  }
  return val.toFixed(2);
}

export function GgalDualChartView({
  payload,
  loading,
  error,
  coordMode,
  timeframe,
  avwapAnchor,
  onChangeCoordMode,
  onChangeTimeframe,
  onChangeAvwapAnchor,
  onRefresh,
}: GgalDualChartViewProps) {
  const [subPaneMode, setSubPaneMode] = useState<GgalSubPaneIndicatorMode>('CVD_LEE_READY');
  const [greekMode, setGreekMode] = useState<GgalGreekProfileMode>('SIGNED_GEX');
  const [toggles, setToggles] = useState<OverlayToggleState>({
    showEmas: true,
    showAvwap: true,
    showVolumeProfile: true,
    showZones: true,
    showCone: true,
  });

  const mainContainerRef = useRef<HTMLDivElement | null>(null);
  const subContainerRef = useRef<HTMLDivElement | null>(null);
  const mirrorCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const mainChartRef = useRef<IChartApi | null>(null);
  const subChartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const primitiveRef = useRef<GgalChartOverlayPrimitive | null>(null);
  const isSyncingRef = useRef(false);
  const drawRafRef = useRef<number | null>(null);

  const latestPayloadRef = useRef(payload);
  latestPayloadRef.current = payload;
  const latestGreekModeRef = useRef(greekMode);
  latestGreekModeRef.current = greekMode;
  const latestCoordModeRef = useRef(coordMode);
  latestCoordModeRef.current = coordMode;

  const drawMirroredChart2 = useCallback(() => {
    const canvas = mirrorCanvasRef.current;
    const candleSeries = candleSeriesRef.current;
    const p = latestPayloadRef.current;
    if (canvas === null || candleSeries === null) {
      return;
    }

    const parent = canvas.parentElement;
    if (parent === null) {
      return;
    }
    const cssW = parent.clientWidth;
    const cssH = parent.clientHeight;
    if (cssW <= 0 || cssH <= 0) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.floor(cssW * dpr);
    const targetH = Math.floor(cssH * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
      canvas.style.width = `${String(cssW)}px`;
      canvas.style.height = `${String(cssH)}px`;
    }

    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      return;
    }
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);

    // Split Chart 2: left 56% -> Greek Profile (Descubiertas vs Cubiertas); right 44% -> L2 Ladder
    const splitX = Math.floor(cssW * 0.56);
    const leftAxisX = Math.floor(splitX * 0.5);

    ctx.fillStyle = '#090d16';
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.strokeStyle = 'rgba(51, 65, 85, 0.8)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(splitX, 0);
    ctx.lineTo(splitX, cssH);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(71, 85, 105, 0.5)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(leftAxisX, 20);
    ctx.lineTo(leftAxisX, cssH);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 10px ui-sans-serif, system-ui, sans-serif';
    const gLabel =
      latestGreekModeRef.current === 'SIGNED_GEX'
        ? 'GEX Neto (Desc. vs Cub.)'
        : latestGreekModeRef.current === 'VANNA'
          ? 'Vanna (Desc. vs Cub.)'
          : 'Charm (Desc. vs Cub.)';
    ctx.fillText(gLabel, 8, 14);
    ctx.fillText('Escalera L2 (5 Puntas BI/OF)', splitX + 8, 14);

    if (p === null || p.status !== 'OPERATIONAL') {
      ctx.fillStyle = '#64748b';
      ctx.font = '11px ui-monospace, SFMono-Regular, monospace';
      ctx.fillText(p?.reason ?? 'Sin payload dual-chart', 12, cssH * 0.5);
      ctx.restore();
      return;
    }

    // Horizontal reference walls coupled to mainSeries.priceToCoordinate
    const drawLevelLine = (price: number | null | undefined, color: string, label: string) => {
      if (price === null || price === undefined || !Number.isFinite(price)) return;
      const y = candleSeries.priceToCoordinate(price);
      if (y === null || y < 18 || y > cssH - 4) return;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(cssW, y);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.font = '9px ui-monospace, SFMono-Regular, monospace';
      ctx.fillText(label, 6, y - 3);
      ctx.restore();
    };

    drawLevelLine(p.callWall, 'rgba(16, 185, 129, 0.65)', 'CW');
    drawLevelLine(p.putWall, 'rgba(239, 68, 68, 0.65)', 'PW');
    drawLevelLine(p.zeroGamma, 'rgba(245, 158, 11, 0.7)', 'ZG');
    drawLevelLine(p.maxPain, 'rgba(232, 121, 249, 0.65)', 'MP');

    // Left: Greek bars differentiating Uncovered (solid) vs Covered (amber/slate hatched)
    const rows = p.greekProfile ?? [];
    let maxMag = 0;
    const readRowVals = (row: (typeof rows)[number]): { readonly uncov: number; readonly cov: number } => {
      if (latestGreekModeRef.current === 'SIGNED_GEX') {
        return { uncov: row.signedGexUncovered, cov: row.signedGexCovered };
      }
      if (latestGreekModeRef.current === 'VANNA') {
        return { uncov: row.vannaUncovered, cov: row.vannaCovered };
      }
      return { uncov: row.charmUncovered, cov: row.charmCovered };
    };

    for (const r of rows) {
      const { uncov, cov } = readRowVals(r);
      const totalAbs = Math.abs(uncov) + Math.abs(cov);
      if (totalAbs > maxMag) maxMag = totalAbs;
    }

    const halfWidth = Math.max(16, splitX * 0.42);
    if (maxMag > 0) {
      for (const r of rows) {
        const y = candleSeries.priceToCoordinate(r.strike);
        if (y === null || y < 22 || y > cssH - 4) continue;
        const { uncov, cov } = readRowVals(r);
        const total = uncov + cov;
        const dirSign = total >= 0 ? 1 : -1;
        const uncovW = (Math.abs(uncov) / maxMag) * halfWidth;
        const covW = (Math.abs(cov) / maxMag) * halfWidth;

        // Solid Descubiertas bar
        ctx.fillStyle = dirSign >= 0 ? 'rgba(16, 185, 129, 0.85)' : 'rgba(244, 63, 94, 0.85)';
        const startX = dirSign >= 0 ? leftAxisX : leftAxisX - uncovW;
        ctx.fillRect(startX, y - 3.5, uncovW, 7);

        // Distinct Cubiertas bar appended outward
        if (covW > 0.5) {
          ctx.fillStyle = 'rgba(251, 191, 36, 0.55)';
          const covStart = dirSign >= 0 ? leftAxisX + uncovW : leftAxisX - uncovW - covW;
          ctx.fillRect(covStart, y - 3.5, covW, 7);
        }
      }
    }

    // Legend for Descubiertas vs Cubiertas
    ctx.font = '9px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = '#34d399';
    ctx.fillRect(8, cssH - 18, 8, 8);
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText('Desc.', 19, cssH - 11);
    ctx.fillStyle = 'rgba(251, 191, 36, 0.75)';
    ctx.fillRect(52, cssH - 18, 8, 8);
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText('Cub.', 63, cssH - 11);

    // Right: 5-Level L2 Order Book or explicit NON-L2 UNAVAILABLE message
    const ladder = p.l2Ladder;
    if (!ladder.available) {
      ctx.fillStyle = 'rgba(127, 29, 29, 0.25)';
      ctx.fillRect(splitX + 6, 26, Math.max(40, cssW - splitX - 12), 78);
      ctx.strokeStyle = 'rgba(248, 113, 113, 0.6)';
      ctx.strokeRect(splitX + 6, 26, Math.max(40, cssW - splitX - 12), 78);
      ctx.fillStyle = '#fca5a5';
      ctx.font = 'bold 10px ui-monospace, SFMono-Regular, monospace';
      ctx.fillText('L2 NO DISPONIBLE', splitX + 12, 44);
      ctx.fillStyle = '#fed7aa';
      ctx.font = '9px ui-monospace, SFMono-Regular, monospace';
      ctx.fillText(ladder.reason, splitX + 12, 60);
      ctx.fillText(`Feed: ${ladder.activeProvider ?? 'NINGUNO'}`, splitX + 12, 74);
      ctx.fillText(`Tier: ${ladder.qualityTier}`, splitX + 12, 88);
    } else {
      const rightAreaW = Math.max(30, cssW - splitX - 12);
      const maxL2Size = Math.max(
        1,
        ...ladder.bids.map((b) => b.size),
        ...ladder.asks.map((a) => a.size),
      );
      const confluenceSet = new Set(
        (p.confluenceAlerts ?? []).map((a) => `${a.side}:${a.l2Price.toFixed(4)}`),
      );

      const drawL2Level = (
        price: number,
        size: number,
        side: 'BID' | 'ASK',
      ) => {
        const yRaw = candleSeries.priceToCoordinate(price);
        if (yRaw === null) return;
        const y = Math.min(cssH - 12, Math.max(26, yRaw));
        const barW = Math.max(6, (size / maxL2Size) * (rightAreaW - 44));
        const isConfluent = confluenceSet.has(`${side}:${price.toFixed(4)}`);

        ctx.fillStyle =
          side === 'BID'
            ? isConfluent
              ? 'rgba(250, 204, 21, 0.72)'
              : 'rgba(16, 185, 129, 0.58)'
            : isConfluent
              ? 'rgba(250, 204, 21, 0.72)'
              : 'rgba(239, 68, 68, 0.58)';
        ctx.fillRect(cssW - 6 - barW, y - 5, barW, 10);

        if (isConfluent) {
          ctx.strokeStyle = '#fde047';
          ctx.lineWidth = 1.4;
          ctx.strokeRect(splitX + 4, y - 6, cssW - splitX - 8, 12);
        }

        ctx.fillStyle = isConfluent ? '#fef08a' : '#e2e8f0';
        ctx.font = '9px ui-monospace, SFMono-Regular, monospace';
        const tag = `${side === 'BID' ? 'BI' : 'OF'} ${formatCoordPrice(price, latestCoordModeRef.current)} (${Math.round(size)})`;
        ctx.fillText(tag, splitX + 8, y + 3);
      };

      for (const ask of ladder.asks) {
        drawL2Level(ask.price, ask.size, 'ASK');
      }
      for (const bid of ladder.bids) {
        drawL2Level(bid.price, bid.size, 'BID');
      }
    }

    ctx.restore();
  }, []);

  const scheduleMirrorDraw = useCallback(() => {
    if (drawRafRef.current !== null) {
      return;
    }
    drawRafRef.current = window.requestAnimationFrame(() => {
      drawRafRef.current = null;
      drawMirroredChart2();
    });
  }, [drawMirroredChart2]);

  // Initialize charts once
  useEffect(() => {
    const mainEl = mainContainerRef.current;
    const subEl = subContainerRef.current;
    if (mainEl === null || subEl === null) {
      return;
    }

    const commonLayout = {
      background: { type: ColorType.Solid, color: '#090d16' },
      textColor: '#94a3b8',
    };
    const commonGrid = {
      vertLines: { color: 'rgba(30, 41, 59, 0.55)' },
      horzLines: { color: 'rgba(30, 41, 59, 0.55)' },
    };

    const mainChart = createChart(mainEl, {
      layout: commonLayout,
      grid: commonGrid,
      height: 410,
      width: mainEl.clientWidth || 720,
      rightPriceScale: { borderColor: 'rgba(51, 65, 85, 0.8)' },
      timeScale: { borderColor: 'rgba(51, 65, 85, 0.8)', timeVisible: true, secondsVisible: false },
    });

    const subChart = createChart(subEl, {
      layout: commonLayout,
      grid: commonGrid,
      height: 150,
      width: subEl.clientWidth || 720,
      rightPriceScale: { borderColor: 'rgba(51, 65, 85, 0.8)' },
      timeScale: { borderColor: 'rgba(51, 65, 85, 0.8)', timeVisible: true, secondsVisible: false },
    });

    const candleSeries = mainChart.addSeries(CandlestickSeries, {
      upColor: '#10b981',
      downColor: '#ef4444',
      borderVisible: false,
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444',
    });

    const primitive = new GgalChartOverlayPrimitive(
      { payload: latestPayloadRef.current, toggles },
      scheduleMirrorDraw,
    );
    candleSeries.attachPrimitive(primitive);

    mainChartRef.current = mainChart;
    subChartRef.current = subChart;
    candleSeriesRef.current = candleSeries;
    primitiveRef.current = primitive;

    const handleMainRange = (range: LogicalRange | null) => {
      scheduleMirrorDraw();
      if (isSyncingRef.current || range === null) return;
      isSyncingRef.current = true;
      try {
        subChart.timeScale().setVisibleLogicalRange(range);
      } finally {
        isSyncingRef.current = false;
      }
    };

    const handleSubRange = (range: LogicalRange | null) => {
      if (isSyncingRef.current || range === null) return;
      isSyncingRef.current = true;
      try {
        mainChart.timeScale().setVisibleLogicalRange(range);
        scheduleMirrorDraw();
      } finally {
        isSyncingRef.current = false;
      }
    };

    mainChart.timeScale().subscribeVisibleLogicalRangeChange(handleMainRange);
    subChart.timeScale().subscribeVisibleLogicalRangeChange(handleSubRange);
    mainChart.subscribeCrosshairMove(scheduleMirrorDraw);

    const observer = new ResizeObserver(() => {
      if (mainContainerRef.current !== null) {
        mainChart.applyOptions({ width: Math.max(240, mainContainerRef.current.clientWidth) });
      }
      if (subContainerRef.current !== null) {
        subChart.applyOptions({ width: Math.max(240, subContainerRef.current.clientWidth) });
      }
      scheduleMirrorDraw();
    });
    observer.observe(mainEl);
    observer.observe(subEl);

    return () => {
      observer.disconnect();
      if (drawRafRef.current !== null) {
        window.cancelAnimationFrame(drawRafRef.current);
        drawRafRef.current = null;
      }
      mainChart.timeScale().unsubscribeVisibleLogicalRangeChange(handleMainRange);
      subChart.timeScale().unsubscribeVisibleLogicalRangeChange(handleSubRange);
      mainChart.unsubscribeCrosshairMove(scheduleMirrorDraw);
      candleSeries.detachPrimitive(primitive);
      mainChart.remove();
      subChart.remove();
      mainChartRef.current = null;
      subChartRef.current = null;
      candleSeriesRef.current = null;
      primitiveRef.current = null;
    };
  }, [scheduleMirrorDraw]);

  // Populate / update chart series when payload, toggles, or sub-pane mode changes
  const overlaySeriesRef = useRef<ISeriesApi<'Line'>[]>([]);
  const subSeriesRef = useRef<ISeriesApi<'Line'>[]>([]);
  const priceLinesRef = useRef<ReturnType<ISeriesApi<'Candlestick'>['createPriceLine']>[]>([]);

  useEffect(() => {
    const mainChart = mainChartRef.current;
    const subChart = subChartRef.current;
    const candleSeries = candleSeriesRef.current;
    const primitive = primitiveRef.current;
    if (mainChart === null || subChart === null || candleSeries === null || primitive === null) {
      return;
    }

    // Clear prior dynamic series & price lines
    for (const s of overlaySeriesRef.current) {
      mainChart.removeSeries(s);
    }
    overlaySeriesRef.current = [];

    for (const s of subSeriesRef.current) {
      subChart.removeSeries(s);
    }
    subSeriesRef.current = [];

    for (const pl of priceLinesRef.current) {
      candleSeries.removePriceLine(pl);
    }
    priceLinesRef.current = [];

    primitive.setState({ payload, toggles });

    if (payload === null || payload.status !== 'OPERATIONAL' || (payload.bars?.length ?? 0) === 0) {
      candleSeries.setData([]);
      scheduleMirrorDraw();
      return;
    }

    candleSeries.setData(
      (payload.bars ?? []).map((b) => ({
        time: b.timeSec as UTCTimestamp,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      })),
    );

    const addLineOverlay = (
      pts: readonly { readonly timeSec: number; readonly value: number }[] | undefined,
      color: string,
      lineWidth: 1 | 2 | 3 | 4 = 1,
      lineStyle: LineStyle = LineStyle.Solid,
    ) => {
      if (pts === undefined || pts.length === 0) return;
      const line = mainChart.addSeries(LineSeries, {
        color,
        lineWidth,
        lineStyle,
        lastValueVisible: false,
        priceLineVisible: false,
      });
      line.setData(pts.map((pt) => ({ time: pt.timeSec as UTCTimestamp, value: pt.value })));
      overlaySeriesRef.current.push(line);
    };

    if (toggles.showEmas) {
      addLineOverlay(payload.ema9, '#38bdf8', 1);
      addLineOverlay(payload.ema21, '#facc15', 1);
      addLineOverlay(payload.ema50, '#fb923c', 1);
      addLineOverlay(payload.ema200, '#c084fc', 2);
    }

    if (toggles.showAvwap && payload.avwapBands !== undefined && payload.avwapBands.length > 0) {
      addLineOverlay(
        payload.avwapBands.map((b) => ({ timeSec: b.timeSec, value: b.avwap })),
        '#f8fafc',
        2,
      );
      addLineOverlay(
        payload.avwapBands.map((b) => ({ timeSec: b.timeSec, value: b.plus1Sigma })),
        'rgba(56, 189, 248, 0.7)',
        1,
        LineStyle.Dashed,
      );
      addLineOverlay(
        payload.avwapBands.map((b) => ({ timeSec: b.timeSec, value: b.minus1Sigma })),
        'rgba(56, 189, 248, 0.7)',
        1,
        LineStyle.Dashed,
      );
      addLineOverlay(
        payload.avwapBands.map((b) => ({ timeSec: b.timeSec, value: b.plus2Sigma })),
        'rgba(244, 63, 94, 0.55)',
        1,
        LineStyle.Dotted,
      );
      addLineOverlay(
        payload.avwapBands.map((b) => ({ timeSec: b.timeSec, value: b.minus2Sigma })),
        'rgba(16, 185, 129, 0.55)',
        1,
        LineStyle.Dotted,
      );
    }

    const addWallLine = (price: number | null | undefined, color: string, title: string) => {
      if (price === null || price === undefined || !Number.isFinite(price)) return;
      const pl = candleSeries.createPriceLine({
        price,
        color,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title,
      });
      priceLinesRef.current.push(pl);
    };

    addWallLine(payload.callWall, '#10b981', 'Call Wall');
    addWallLine(payload.putWall, '#ef4444', 'Put Wall');
    addWallLine(payload.zeroGamma, '#f59e0b', 'Zero-Gamma');
    addWallLine(payload.maxPain, '#e879f9', 'Max Pain');

    // Lower synced sub-pane
    const sp = payload.subPaneSeries ?? [];
    if (subPaneMode === 'CVD_LEE_READY') {
      const s = subChart.addSeries(LineSeries, { color: '#22d3ee', lineWidth: 2 });
      s.setData(sp.map((pt) => ({ time: pt.timeSec as UTCTimestamp, value: pt.cvdLeeReady })));
      subSeriesRef.current.push(s);
    } else if (subPaneMode === 'CCL_BRECHA_PCT') {
      const s = subChart.addSeries(LineSeries, { color: '#fbbf24', lineWidth: 2 });
      s.setData(sp.map((pt) => ({ time: pt.timeSec as UTCTimestamp, value: pt.cclBrechaPct })));
      subSeriesRef.current.push(s);
    } else {
      const sBma = subChart.addSeries(LineSeries, { color: '#38bdf8', lineWidth: 2, title: 'vs BMA' });
      const sBbar = subChart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 1, title: 'vs BBAR' });
      const sSupv = subChart.addSeries(LineSeries, { color: '#fb7185', lineWidth: 1, title: 'vs SUPV' });
      sBma.setData(sp.map((pt) => ({ time: pt.timeSec as UTCTimestamp, value: pt.relStrengthBma })));
      sBbar.setData(sp.map((pt) => ({ time: pt.timeSec as UTCTimestamp, value: pt.relStrengthBbar })));
      sSupv.setData(sp.map((pt) => ({ time: pt.timeSec as UTCTimestamp, value: pt.relStrengthSupv })));
      subSeriesRef.current.push(sBma, sBbar, sSupv);
    }

    mainChart.timeScale().fitContent();
    scheduleMirrorDraw();
  }, [payload, toggles, subPaneMode, scheduleMirrorDraw]);

  useEffect(() => {
    scheduleMirrorDraw();
  }, [greekMode, coordMode, scheduleMirrorDraw]);

  const confluenceAlerts = useMemo(
    () => (payload?.status === 'OPERATIONAL' ? payload.confluenceAlerts ?? [] : []),
    [payload],
  );

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-950/95 p-3 shadow-lg">
      {/* Global Coordinate, Timeframe & Anchor Controls */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 inline-flex items-center gap-1 text-xs font-semibold text-slate-300">
            <Layers className="h-3.5 w-3.5 text-cyan-400" />
            Gráficos Sincronizados
          </span>
          {(
            [
              ['ARS_BYMA', 'Vista ARS BYMA'],
              ['USD_ADR_NASDAQ', 'Vista ADR NASDAQ USD'],
              ['RATIO_CCL', 'Vista Ratio CCL'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => onChangeCoordMode(id)}
              className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                coordMode === id
                  ? 'bg-cyan-500/20 text-cyan-300 ring-1 ring-cyan-400/60'
                  : 'bg-slate-900 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {(['1m', '5m', '15m', '1H', '4H', '1D'] as const).map((tf) => (
            <button
              key={tf}
              type="button"
              onClick={() => onChangeTimeframe(tf)}
              className={`rounded px-2 py-0.5 text-xs font-mono transition ${
                timeframe === tf
                  ? 'bg-indigo-500/25 text-indigo-300 ring-1 ring-indigo-400/60'
                  : 'bg-slate-900 text-slate-400 hover:bg-slate-800'
              }`}
            >
              {tf}
            </button>
          ))}

          <select
            aria-label="AVWAP Anchor"
            value={avwapAnchor}
            onChange={(e) => onChangeAvwapAnchor(e.target.value as GgalAvwapAnchorMode)}
            className="ml-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200"
          >
            <option value="MONTH_START">AVWAP: Inicio de Mes</option>
            <option value="LAST_BIMONTHLY_EXPIRY">AVWAP: Último Vto. Bimestral</option>
            <option value="LAST_EARNINGS">AVWAP: Último Balance</option>
            <option value="ELECTORAL_GAP">AVWAP: Gap Electoral</option>
          </select>

          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
            Sync
          </button>
        </div>
      </div>

      {/* Overlay Toggles & Confluence Alerts */}
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex flex-wrap items-center gap-3 text-slate-300">
          {(
            [
              ['showEmas', 'EMAs 9/21/50/200'],
              ['showAvwap', 'AVWAP ±1σ/±2σ'],
              ['showVolumeProfile', 'Vol Profile & Naked POC'],
              ['showZones', 'FVG / FOB'],
              ['showCone', 'Cono Esperado'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="inline-flex cursor-pointer items-center gap-1">
              <input
                type="checkbox"
                checked={toggles[key]}
                onChange={(e) =>
                  setToggles((prev) => ({
                    ...prev,
                    [key]: e.target.checked,
                  }))
                }
                className="accent-cyan-400"
              />
              <span>{label}</span>
            </label>
          ))}
        </div>

        <div className="flex items-center gap-2 font-mono text-[11px] text-slate-400">
          <span>Spot: {formatCoordPrice(payload?.spotPrice, coordMode)}</span>
          <span>CW: {formatCoordPrice(payload?.callWall, coordMode)}</span>
          <span>ZG: {formatCoordPrice(payload?.zeroGamma, coordMode)}</span>
          <span>PW: {formatCoordPrice(payload?.putWall, coordMode)}</span>
        </div>
      </div>

      {confluenceAlerts.length > 0 && (
        <div className="mb-2.5 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/50 bg-amber-950/35 px-3 py-1.5 text-xs text-amber-200">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
          <span className="font-semibold">Confluencia L2 &lt; ±0.5%:</span>
          {confluenceAlerts.slice(0, 4).map((a, idx) => (
            <span
              key={`${a.side}-${String(a.l2Price)}-${String(idx)}`}
              className="rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[11px]"
            >
              {a.side} {formatCoordPrice(a.l2Price, coordMode)} ({Math.round(a.l2Size)}) ≈ {a.targetLabel} (Δ {a.distancePct.toFixed(2)}%)
            </span>
          ))}
        </div>
      )}

      {error !== null && (
        <div className="mb-2 rounded border border-rose-500/40 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">
          {error}
        </div>
      )}

      {/* Dual Side-by-Side Synced Charts: Row 1 = Main Price Pane & 1:1 Y-Aligned Mirror Canvas, Row 2 = Sub-pane & Controls */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-2 lg:flex-row">
          {/* CHART 1 (~68%, h-[410px] aligned at y=0) */}
          <div className="w-full overflow-hidden rounded-lg border border-slate-800 bg-[#090d16] lg:w-[68%]">
            <div ref={mainContainerRef} className="h-[410px] w-full" />
          </div>

          {/* CHART 2 (~32%, h-[410px] aligned 1:1 at y=0 via mainSeries.priceToCoordinate) */}
          <div className="relative h-[410px] w-full overflow-hidden rounded-lg border border-slate-800 bg-[#090d16] lg:w-[32%]">
            <canvas ref={mirrorCanvasRef} className="block h-full w-full" />
          </div>
        </div>

        <div className="flex flex-col gap-2 lg:flex-row">
          {/* Sub-panel (~68%, synced on X time axis) */}
          <div className="w-full rounded-lg border border-slate-800 bg-[#090d16] p-1.5 lg:w-[68%]">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-1 px-1">
              <span className="text-[11px] font-medium text-slate-400">
                Sub-panel Sincronizado (Eje X acoplado)
              </span>
              <div className="flex flex-wrap gap-1">
                {(
                  [
                    ['CVD_LEE_READY', 'CVD (Lee-Ready)'],
                    ['CCL_BRECHA_PCT', 'Brecha CCL (%)'],
                    ['REL_STRENGTH_BANKS', 'Fuerza Rel. vs BMA/BBAR/SUPV'],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setSubPaneMode(mode)}
                    className={`rounded px-2 py-0.5 text-[11px] transition ${
                      subPaneMode === mode
                        ? 'bg-cyan-500/20 text-cyan-300 ring-1 ring-cyan-400/50'
                        : 'bg-slate-900 text-slate-400 hover:bg-slate-800'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div ref={subContainerRef} className="h-[150px] w-full" />
          </div>

          {/* Chart 2 Mirror Controls & Legend (~32%) */}
          <div className="flex w-full flex-col justify-between rounded-lg border border-slate-800 bg-slate-900/60 p-2.5 lg:w-[32%]">
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[11px] font-semibold text-slate-300">
                  Perfil Griego Anexo B &amp; L2
                </span>
                <span className="font-mono text-[10px] text-cyan-300">Y-Sync 1:1</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {(
                  [
                    ['SIGNED_GEX', 'Signed GEX'],
                    ['VANNA', 'Vanna'],
                    ['CHARM', 'Charm'],
                  ] as const
                ).map(([gm, label]) => (
                  <button
                    key={gm}
                    type="button"
                    onClick={() => setGreekMode(gm)}
                    className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                      greekMode === gm
                        ? 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-400/60'
                        : 'bg-slate-950 text-slate-400 hover:bg-slate-800'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-2 space-y-1 border-t border-slate-800 pt-2 text-[11px] text-slate-400">
              <div className="flex items-center gap-3">
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm bg-emerald-500" />
                  Descubiertas (Anexo B)
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm bg-amber-400/75" />
                  Cubiertas (Anexo B)
                </span>
              </div>
              <div className="font-mono text-[10px]">
                L2 Status:{' '}
                {payload === null
                  ? 'SIN PAYLOAD'
                  : payload.l2Ladder.available
                    ? `ACTIVO (${payload.l2Ladder.activeProvider})`
                    : `NO DISPONIBLE (${payload.l2Ladder.reason})`}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
